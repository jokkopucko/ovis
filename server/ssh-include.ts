/**
 * The files an ssh config's Include lines name, read for the SSH tab's list (server/ssh-candidates.ts): only what
 * really is inside the home or ssh folder, within one budget of files, bytes, folder entries and matching work per
 * config. A file or folder is opened first and what was opened is checked, so nothing swapped in on the way after a
 * check stands in for it: Linux names the opened object itself (/proc/self/fd); elsewhere a file's path is resolved
 * again once open and must still name the same object. With glibc a folder is listed through its open descriptor
 * (getdents64), a bounded read at a time, and what it matched is opened relative to that folder, still held (openat:
 * server/ssh-include-dir.ts). Without them (macOS, Windows, a Linux without glibc) Bun has no descriptor-relative
 * listing, so a wildcard's folders are listed by path, which a swap after the check can redirect. Such a listing only
 * gives names: a name from a folder out of home can be listed (its file is still opened and checked), and a file can be
 * hidden. So every file reached that way comes back marked `unclaimed` (its hosts are listed but claim no Tailscale
 * PC), and the Include also leaves the unread marker after them, whatever the listing found, so no host whose options
 * were still unset there (any host after it) claims one either.
 */
import { close, constants, fstat, read } from "node:fs";
import { open, readdir, readlink, realpath, stat, type FileHandle } from "node:fs/promises";
import { constants as os } from "node:os";
import { promisify } from "node:util";
import { isAbsolute, relative, sep } from "node:path";

import type { Included } from "./ssh-config.ts";
import { entriesOf, glibcGetdents, glibcOpenAt, type Getdents, type OpenAt } from "./ssh-include-dir.ts";
import { matchComponent, parseComponent, type Token } from "./ssh-include-glob.ts";

/** an ssh config is a few kilobytes; past this it is not read on */
export const MAX_FILE_BYTES = 256 * 1024;
const MAX_INCLUDED_FILES = 64;
const MAX_INCLUDED_BYTES = 1024 * 1024;
const MAX_SCANNED_ENTRIES = 1024;
const MAX_MATCH_STEPS = 1_000_000;
const READ_FLAGS = constants.O_RDONLY | (constants.O_NONBLOCK ?? 0);

type Budget = { files: number; bytes: number; entries: number; steps: number };
type Listing = string[] | "unread" | null;
type Handle = { readonly fd: number; close: () => Promise<void> };
type Entry = { path: string; base?: { fd: number; rest: string }; listed?: true };
const [fstatOf, readOf, closeOf] = [promisify(fstat), promisify(read), promisify(close)];

async function readHandle(fd: number, cap: number): Promise<string | "folder" | null> {
  const found = await fstatOf(fd);
  if (found.isDirectory()) return "folder";
  if (!found.isFile() || found.size > cap) return null;
  const buffer = Buffer.alloc(found.size);
  const { bytesRead } = await readOf(fd, buffer, 0, found.size, 0);
  return buffer.subarray(0, bytesRead).toString("utf8");
}

/** A regular file's text when it is at most `cap` bytes; opened without blocking, so a FIFO never holds the list */
export async function readCapped(path: string, cap: number): Promise<string | null> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(path, READ_FLAGS);
    const text = await readHandle(handle.fd, cap);
    return text === "folder" ? null : text;
  } catch { return null; } finally { await handle?.close(); }
}

const inside = (path: string, roots: readonly string[]): boolean => roots.some((root) => {
  const rest = relative(root, path);
  return rest !== ".." && !rest.startsWith(`..${sep}`) && !isAbsolute(rest);
});

/** whether the object open at `fd`, opened as `path`, really is inside `roots` */
async function openedInside(fd: number, path: string, roots: readonly string[]): Promise<boolean> {
  const platform = includeTestOnly.platform ?? process.platform;
  if (platform === "linux") return inside(await readlink(`/proc/self/fd/${fd}`), roots);
  const real = await realpath(path);
  const [opened, named] = await Promise.all([fstatOf(fd, { bigint: true }), stat(real, { bigint: true })]);
  return inside(real, roots) && opened.dev === named.dev && opened.ino === named.ino;
}

/**
 * An entry opened, links followed as ssh does, relative to the folder a listing held when it has one, when what was
 * opened is inside `roots`; null when nothing is there, as for ssh, unless a listing named it: any open of a listed
 * entry that fails (gone, a link that loops or leads nowhere, refused) is unread, as it may have been swapped meanwhile
 */
async function openInside({ path, base, listed }: Entry, roots: readonly string[], flags: number): Promise<Handle | "refused" | null> {
  const openAt = openAtCall();
  let handle: Handle;
  if (base !== undefined && openAt !== null) {
    const fd = openAt(base.fd, base.rest, flags);
    if (fd < 0) return listed !== true && (-fd === os.errno.ENOENT || -fd === os.errno.ENOTDIR) ? null : "refused";
    handle = { fd, close: () => closeOf(fd) };
  } else {
    try { handle = await open(path, flags); } catch (error) {
      // only a path that is not there is nothing, as for ssh; one it could not open (EACCES, EMFILE, ELOOP) is unread
      return listed !== true && error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "ENOTDIR") ? null : "refused";
    }
  }
  if (await openedInside(handle.fd, path, roots).catch(() => false)) return handle;
  await handle.close();
  return "refused";
}

/** glibc's getdents64 (server/ssh-include-dir.ts); null without glibc */
const getdents: Getdents | null = glibcGetdents();

/** glibc's openat, which opens what a listing matched relative to the folder it holds; null without glibc */
const openAtGlibc: OpenAt | null = glibcOpenAt();

/** whether a wildcard Include's folders are listed through their descriptor (getdents64); without it, by path, unclaimed */
export const wildcardIncludesRead = getdents !== null;

export const includeTestOnly: { getdents?: Getdents | null; openAt?: OpenAt | null; platform?: NodeJS.Platform } = {};
const descriptorListing = (): Getdents | null => includeTestOnly.getdents === undefined ? getdents : includeTestOnly.getdents;
const openAtCall = (): OpenAt | null => includeTestOnly.openAt === undefined ? openAtGlibc : includeTestOnly.openAt;

/**
 * The names in folder `dir` when it really is inside `roots`: through its open descriptor where getdents64 is, the
 * folder then `held` open (the caller closes it) where openat is, else by the path its realpath
 * checked, read whole (Bun has no listing that stops early) and then charged to `budget.entries`
 */
async function listInside(dir: Entry, roots: readonly string[], budget: Budget): Promise<{ names: Listing; held?: Handle }> {
  const getdentsCall = descriptorListing();
  if (getdentsCall !== null) {
    // opened as any file: a match that is no folder is nothing, as for ssh, not a failed open
    const folder = await openInside(dir, roots, READ_FLAGS);
    if (folder === null) return { names: null };
    if (folder === "refused") return { names: "unread" };
    let names: Listing = null;
    try {
      if ((await fstatOf(folder.fd)).isDirectory()) names = entriesOf(folder.fd, getdentsCall, budget);
      // still inside the home or ssh folder once listed, or what the listing gave is not trusted
      if (Array.isArray(names) && !(await openedInside(folder.fd, dir.path, roots).catch(() => false))) names = "unread";
    } catch (error) { await folder.close(); throw error; }
    if (openAtCall() !== null && Array.isArray(names)) return { names, held: folder };
    await folder.close();
    return { names };
  }
  const real = await realpath(dir.path).catch(() => null);
  if (real === null) return { names: null };
  if (!inside(real, roots)) return { names: "unread" };
  // Bun has no listing that stops early: opendir's first read loads the whole folder too, and it ignores a buffer
  // encoding (so a name that is not UTF-8 could not be told apart); readdir is used, and a folder past the budget is unread
  let raw: Buffer[];
  try { raw = await readdir(real, { encoding: "buffer" }); } catch (error) {
    // a match that is a file (`conf.d/*/x`) or gone is nothing, as for ssh; a folder it could not list is unread
    return { names: error instanceof Error && "code" in error && (error.code === "ENOTDIR" || error.code === "ENOENT") ? null : "unread" };
  }
  const names = raw.map((bytes) => bytes.toString("utf8"));
  if (names.length > budget.entries || names.some((name, at) => !Buffer.from(name).equals(raw[at]!))) return { names: "unread" };
  budget.entries -= names.length;
  return { names };
}

const under = ({ path, base }: Entry, name: string): Entry => ({ path: `${path}${sep}${name}`, ...(base ? { base: { fd: base.fd, rest: `${base.rest}/${name}` } } : {}) });

/**
 * The files an Include pattern names: relative to `sshDir` as ssh reads the user config, `~` for the home folder. A
 * wildcard is walked one component at a time from the folder before it, each folder listed only when it is inside the
 * home or ssh folder; matches keep the spelling the pattern gives them and glob(3)'s order. A file ssh would read that is
 * left unread (out of those folders, past a budget, behind a pattern not matched exactly here, `~user`, a `%` token or
 * `${VAR}`, not a regular file of at most the size cap) comes back as null, so what it might set stays unknown; a file
 * that is not there is nothing, as for ssh. A file reached through a folder listed by path comes back `unclaimed`.
 */
export function includer(sshDir: string, home: string): (pattern: string) => Promise<Included[]> {
  const roots = Promise.all([sshDir, home].map((root) => realpath(root).catch(() => null)));
  const budget: Budget = { files: MAX_INCLUDED_FILES, bytes: MAX_INCLUDED_BYTES, entries: MAX_SCANNED_ENTRIES, steps: MAX_MATCH_STEPS };
  const escapes = sep === "/";
  return async (pattern) => {
    if (budget.files <= 0 || budget.bytes <= 0) return [null];
    // ssh expands `%` tokens, `${VAR}` and `~user` in an Include, which this offline reading does not
    if (/%|\$\{/.test(pattern) || (pattern.startsWith("~") && !pattern.startsWith("~/") && pattern !== "~")) return [null];
    const allowed = (await roots).filter((root): root is string => root !== null);
    // put together, never normalized: `*/..` and a trailing `/` are glob(3)'s to read, through the folders matched
    const expanded = pattern === "~" || pattern.startsWith("~/") ? `${home}${sep}${pattern.slice(2)}` : isAbsolute(pattern) ? pattern : `${sshDir}${sep}${pattern}`;
    const parts = expanded.split(escapes ? "/" : /[\\/]/).map((part) => part === "" ? { name: "" } : parseComponent(part, escapes));
    if (parts.includes(null)) return [null];
    const components = parts.filter((part): part is { name: string } | { tokens: Token[] } => part !== null);
    const first = components.findIndex((part) => "tokens" in part);
    const literal = (upTo: number) => components.slice(0, upTo).map((part) => "name" in part ? part.name : "").join(sep) || sep;
    // a scan cut short, or a folder left unlisted, may have missed a file sorted before the ones found
    let [scanCut, truncated] = [false, false];
    // the folders the last wildcard listed, held open until what they matched is opened
    let held: Handle[] = [];
    try {
      let paths: Entry[] = [];
      if (first < 0) paths = [{ path: literal(components.length) }];
      else {
        let level: Entry[] = [{ path: literal(first) }];
        for (const component of components.slice(first)) {
          const next: Entry[] = [];
          const opened: Handle[] = [];
          for (const dir of level) {
            if ("name" in component) { next.push(under(dir, component.name)); continue; }
            const { names, held: folder } = await listInside(dir, allowed, budget);
            if (folder !== undefined) opened.push(folder);
            if (names === "unread") { scanCut = true; continue; }
            for (const name of names ?? []) {
              const matched = matchComponent(component.tokens, name, budget);
              if (matched === null || (matched && next.length >= budget.files)) { scanCut = true; break; }
              if (matched) next.push({ path: `${dir.path}${sep}${name}`, listed: true, ...(folder ? { base: { fd: folder.fd, rest: name } } : {}) });
            }
          }
          if ("tokens" in component) {
            await Promise.all(held.map((folder) => folder.close()));
            held = opened;
          }
          level = next;
        }
        // ssh reads the files glob(3) returns, sorted by their spelling's bytes (strcmp)
        paths = level.sort((left, right) => Buffer.compare(Buffer.from(left.path), Buffer.from(right.path)));
      }
      // without openat, what a listing matched is opened by its path, which a swap can redirect: names only
      const byPath = first >= 0 && (descriptorListing() === null || openAtCall() === null);
      const texts: Included[] = [];
      for (const entry of paths) {
        if (budget.files <= 0 || budget.bytes <= 0) { truncated = true; break; }
        const handle = await openInside(entry, allowed, READ_FLAGS);
        if (handle === null) continue;
        if (handle === "refused") { texts.push(null); continue; }
        try {
          const found = await readHandle(handle.fd, Math.min(MAX_FILE_BYTES, budget.bytes)).catch(() => null);
          // a folder among a wildcard's matches is no config, as for ssh
          if (found === "folder" && first >= 0) continue;
          budget.files--;
          const text = found === "folder" ? null : found;
          if (text !== null) budget.bytes -= Buffer.byteLength(text);
          texts.push(text === null || !byPath ? text : { text, unclaimed: true });
        } finally { await handle.close(); }
      }
      return [...(scanCut ? [null] : []), ...texts, ...(truncated || byPath ? [null] : [])];
    } finally { await Promise.all(held.map((folder) => folder.close())); }
  };
}
