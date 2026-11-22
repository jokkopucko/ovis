import { createHash, randomBytes } from "node:crypto";
import { type BigIntStats, closeSync, constants, fchmodSync, fchownSync, fstatSync, fsyncSync, openSync, readlinkSync, readSync, realpathSync, renameSync, statSync, unlinkSync, writeSync } from "node:fs";
import { basename, dirname, isAbsolute, join, parse, relative, sep } from "node:path";

import { MAX_EDITABLE_TEXT_BYTES, type EditableText, type TextSaved } from "../shared/files.ts";
import type { Access } from "./access.ts";
import { copyFileAttributes } from "./file-attributes.ts";
import { openAuthorized, ownedFolders, release, resolveFilePath } from "./file-view.ts";

/**
 * Editing a text file from the file viewer (#771): a Markdown note or a JSON file an agent wrote,
 * changed from a phone with no terminal to open an editor in. Reading a file reaches whatever this
 * server's user can read (file-view.ts); writing reaches less: one existing text file under the
 * pane's folder, for a device that drives this PC (`textEditAllowed`).
 *
 * A save is written to a new file in the same folder, given the file's mode and group, and renamed
 * over it, so a reader sees the old text or the new, never half of it. What is replaced must be the
 * file that was read: its SHA-256 (`revision`) is checked once before the new file is written and
 * again right before the rename, and a file changed since it was read is not written (409). On
 * Linux every step after the file was proven to lie in the pane's folder goes through a descriptor
 * of its folder (`/proc/self/fd/N/<name>`), so a folder on the way swapped for a link meanwhile
 * cannot send the rename anywhere else; on macOS the folders from the pane's folder down must be
 * this user's own and writable by nobody else (`ownedFolders`), checked right before the rename.
 * Other platforms do not save yet. The file's extended attributes and access list are carried over
 * to the new file (file-attributes.ts); one whose access list cannot be is not saved. A read runs on a file thread (`file-pool.ts` `text-read`). A save
 * runs on the server's own thread, synchronously: two saves never interleave, and a save is over
 * when it is answered, never still running after a timeout. It is at most 1 MiB written to the
 * disk the file was just read from; a disk that stalls during it holds the server for that long.
 */

export class TextEditRefused extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly revision?: string) { super(message); }
}

/** Never set outside tests. */
export const textSaveHooks: { platform?: NodeJS.Platform; beforeRename?: () => void } = {};

const platform = (): NodeJS.Platform => textSaveHooks.platform ?? process.platform;

/**
 * Who may read a file to edit it and save it: a device that drives this PC, never a watching one, a
 * Portal visitor (even one given drive) or a window of an open LAN install, which signed in as
 * nobody. The connection server reaching this PC with its bridge token (an SSH PC) has checked its
 * own caller already; that token opens only this PC's own route, never a PC behind it.
 */
export function textEditAllowed(access: Access, bridgeAuthorized: boolean, proxied: boolean): boolean {
  if (access.level === "full") return access.role === "drive" && access.via !== "portal" && access.via !== "open";
  return bridgeAuthorized && !proxied;
}

/** The request body's limit: 1 MiB of text with every character escaped as JSON may grow about six times. */
export const MAX_TEXT_SAVE_BODY_BYTES = 8 * 1024 * 1024;

const isGit = (segment: string): boolean => (platform() === "linux" ? segment : segment.toLowerCase()) === ".git";

/** Whether `path` lies below `root` (not `root` itself), with no `.git` on the way. */
function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel) && !rel.split(sep).some(isGit);
}

/** A UTF-16 surrogate without its pair, which UTF-8 cannot hold (encoding would put U+FFFD in its place). */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

/** The pane's folder as it resolves: never a filesystem's root, and never inside `.git`. */
function sandbox(cwd: string): string {
  if (platform() !== "linux" && platform() !== "darwin") throw new TextEditRefused(501, "unsupported_platform", "Saving files from the app is not available on this PC yet");
  let root: string;
  try { root = realpathSync(cwd); } catch { throw new TextEditRefused(404, "not_found", "the pane's folder is not there"); }
  if (parse(root).root === root || root.split(sep).some(isGit)) throw new TextEditRefused(403, "outside_pane", "Only a file inside the pane's folder can be edited");
  return root;
}

/** The pane's folder and the path asked for, once its real path is shown to lie inside the folder. */
function locate(input: string, cwd: string): { root: string; requested: string } {
  const root = sandbox(cwd);
  const requested = resolveFilePath(input, cwd);
  if (requested === null) throw new TextEditRefused(400, "missing_path", "path is required");
  let real: string;
  try { real = realpathSync(requested); } catch { throw new TextEditRefused(404, "not_found", "no file at that path"); }
  if (!inside(root, real)) throw new TextEditRefused(403, "outside_pane", "Only a file inside the pane's folder can be edited");
  return { root, requested };
}

function readUpTo(fd: number, limit: number): Buffer {
  const buffer = Buffer.alloc(limit);
  let filled = 0;
  while (filled < limit) {
    const read = readSync(fd, buffer, filled, limit - filled, filled);
    if (read === 0) break;
    filled += read;
  }
  return buffer.subarray(0, filled);
}

/** The file `requested` names, opened as one inside `root` (`openAuthorized`): its real path, identity and bytes. */
function readCurrent(requested: string, root: string): { file: string; stat: BigIntStats; bytes: Buffer } {
  const opened = openAuthorized(requested, [root], true);
  if (opened === null) throw new TextEditRefused(404, "not_found", "no file at that path");
  try {
    if (!inside(root, opened.file)) throw new TextEditRefused(403, "outside_pane", "Only a file inside the pane's folder can be edited");
    const stat = fstatSync(opened.fd, { bigint: true });
    // read one byte past the limit: a file grown since its size was looked at is still too large
    const bytes = readUpTo(opened.fd, MAX_EDITABLE_TEXT_BYTES + 1);
    if (bytes.length > MAX_EDITABLE_TEXT_BYTES) throw new TextEditRefused(413, "too_large", "This file is too large to edit here");
    return { file: opened.file, stat, bytes };
  } finally { release(opened.fd); }
}

function decode(bytes: Uint8Array): { text: string; lineEndings: "lf" | "crlf" } {
  if (bytes.includes(0)) throw new TextEditRefused(415, "not_text", "Only a text file can be edited here");
  let text: string;
  // a BOM stays in the text, so it is written back
  try { text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); } catch { throw new TextEditRefused(415, "not_text", "Only a UTF-8 text file can be edited here"); }
  const crlf = text.split("\r\n").length - 1;
  const cr = text.split("\r").length - 1;
  const lf = text.split("\n").length - 1;
  // a text box turns every line ending into LF: one kind of ending is put back, a mix could not be
  if (cr !== crlf || (crlf > 0 && crlf !== lf)) throw new TextEditRefused(415, "mixed_line_endings", "This file mixes line endings; edit it in the terminal");
  return crlf > 0 ? { text: text.replaceAll("\r\n", "\n"), lineEndings: "crlf" } : { text, lineEndings: "lf" };
}

/** GET /api/fs/text: the file `input` names in the pane's folder `cwd`, to edit (shared/files.ts). */
export function readEditableText(input: string, cwd: string): EditableText {
  const { root, requested } = locate(input, cwd);
  const current = readCurrent(requested, root);
  const { text, lineEndings } = decode(current.bytes);
  return { path: current.file, text, revision: sha256(current.bytes), line_endings: lineEndings, size: current.bytes.length, modified: new Date(Number(current.stat.mtimeMs)).toISOString() };
}

/** The file at `path` opened with `flags`, refused unless it is still the file `stat` describes. */
function openSame(path: string, flags: number, stat: BigIntStats): number {
  const fd = openSync(path, flags | constants.O_NOFOLLOW | (constants.O_NONBLOCK ?? 0));
  const now = fstatSync(fd, { bigint: true });
  if (!now.isFile() || now.dev !== stat.dev || now.ino !== stat.ino) {
    closeSync(fd);
    throw new TextEditRefused(409, "stale_revision", "The file was replaced since it was opened");
  }
  return fd;
}

/** A permission the filesystem refused, as the 403 that says the file cannot be written here; a file gone meanwhile, as a conflict. */
function refusedWrite(error: unknown): unknown {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  if (code === "ENOENT") return new TextEditRefused(409, "stale_revision", "The file was moved or removed since it was opened");
  return code === "EACCES" || code === "EPERM" || code === "EROFS" ? new TextEditRefused(403, "not_writable", "This file can't be written here") : error;
}

/** PUT /api/fs/text: `text` in place of the file `input` names, when that file still has `revision` (shared/files.ts). */
export function saveEditableText(input: string, cwd: string, revision: string, text: string): TextSaved {
  if (!/^[0-9a-f]{64}$/.test(revision)) throw new TextEditRefused(400, "invalid_revision", "revision is the SHA-256 the file was read with");
  if (text.includes("\r") || text.includes("\0") || LONE_SURROGATE.test(text)) throw new TextEditRefused(400, "invalid_text", "text has LF line endings and no NUL or unpaired surrogate");
  let located: { root: string; requested: string; current: ReturnType<typeof readCurrent> };
  try {
    const { root, requested } = locate(input, cwd);
    located = { root, requested, current: readCurrent(requested, root) };
  } catch (error) {
    if (error instanceof TextEditRefused && error.code === "not_found") throw new TextEditRefused(409, "stale_revision", "The file was moved or removed since it was opened");
    throw error;
  }
  const { root, current } = located;
  const stale = (now: Uint8Array) => new TextEditRefused(409, "stale_revision", "The file changed since it was opened", sha256(now));
  if (sha256(current.bytes) !== revision) throw stale(current.bytes);
  const { lineEndings } = decode(current.bytes);
  const bytes = Buffer.from(lineEndings === "crlf" ? text.replaceAll("\n", "\r\n") : text, "utf8");
  if (bytes.length > MAX_EDITABLE_TEXT_BYTES) throw new TextEditRefused(413, "too_large", "The text is too large to save here");
  // a rename gives the path a new file: one with other links, or another owner, would not be that file afterwards
  if (current.stat.nlink > 1n) throw new TextEditRefused(403, "linked_file", "This file has other links; edit it in the terminal");
  const uid = process.getuid?.();
  if (uid === undefined || current.stat.uid !== BigInt(uid)) throw new TextEditRefused(403, "not_owner", "This file belongs to another user");

  const folder = dirname(current.file);
  const name = basename(current.file);
  let folderFd: number | null = null;
  let original = -1;
  let temp: string | null = null;
  let anchor = folder;
  try {
    if (platform() === "linux") {
      folderFd = openSync(folder, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      anchor = `/proc/self/fd/${folderFd}`;
      // the folder opened is the one the proven file lies in
      if (readlinkSync(anchor) !== folder) throw new TextEditRefused(409, "stale_revision", "The file was moved since it was opened");
    }
    // the file itself must be writable: opening it to write (without truncating) changes nothing
    closeSync(openSame(join(anchor, name), constants.O_WRONLY, current.stat));
    // and its attributes and access list are read from it, for the new file
    original = openSame(join(anchor, name), constants.O_RDONLY, current.stat);
    temp = `.ovis-edit-${randomBytes(6).toString("hex")}.tmp`;
    const fd = openSync(join(anchor, temp), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try {
      if (BigInt(fstatSync(fd).gid) !== current.stat.gid) fchownSync(fd, uid, Number(current.stat.gid));
      for (let written = 0; written < bytes.length;) written += writeSync(fd, bytes, written, bytes.length - written);
      if (!copyFileAttributes(original, fd, platform())) throw new TextEditRefused(403, "access_list", "This file's access list could not be kept; edit it in the terminal");
      // the mode last: a write (and a change of group) clears set-id bits given before it, and with an
      // access list its group bits are the list's mask, which the file's own mode already agrees with
      fchmodSync(fd, Number(current.stat.mode & 0o7777n));
      fsyncSync(fd);
    } finally { closeSync(fd); }
    textSaveHooks.beforeRename?.();
    // the last look: the folder still inside the pane's folder, and the same file, unchanged
    const proven = platform() === "linux" ? inside(root, join(readlinkSync(anchor), name)) && !readlinkSync(anchor).endsWith(" (deleted)") : ownedFolders(root, current.file, uid) && realpathSync(folder) === folder;
    if (!proven) throw new TextEditRefused(409, "stale_revision", "The file was moved since it was opened");
    const check = openSame(join(anchor, name), constants.O_RDONLY, current.stat);
    let now: Buffer;
    try { now = readUpTo(check, MAX_EDITABLE_TEXT_BYTES + 1); } finally { closeSync(check); }
    if (sha256(now) !== revision) throw stale(now);
    renameSync(join(anchor, temp), join(anchor, name));
    temp = null;
    if (folderFd !== null) fsyncSync(folderFd);
    const saved = statSync(join(anchor, name));
    return { path: current.file, revision: sha256(bytes), size: saved.size, modified: saved.mtime.toISOString() };
  } catch (error) {
    throw refusedWrite(error);
  } finally {
    if (temp !== null) try { unlinkSync(join(anchor, temp)); } catch { }
    if (original !== -1) closeSync(original);
    if (folderFd !== null) closeSync(folderFd);
  }
}

/** A request body as text, refused past `limit` bytes whether or not it said its length. */
export async function readCappedText(request: Request, limit: number): Promise<string> {
  const tooLarge = () => new TextEditRefused(413, "too_large", "The text is too large to save here");
  if (Number(request.headers.get("content-length") ?? 0) > limit) throw tooLarge();
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = request.body?.getReader();
  if (reader === undefined) return "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) { await reader.cancel(); throw tooLarge(); }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}
