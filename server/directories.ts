import { mkdirSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, type PlatformPath, resolve, sep } from "node:path";

import type { DirectoryListing } from "../shared/protocol.ts";
import { otherHostsShare } from "./windows-share.ts";

/** A folder with more subfolders than this lists the first ones and says it stopped. */
export const MAX_DIRECTORY_ENTRIES = 500;

/** A folder name past this many bytes is refused before the filesystem is asked (255 on every common filesystem). */
const MAX_NAME_BYTES = 255;

/**
 * `path` in the dialog's syntax (absolute, `~`, `~/…`, empty for home), resolved against `base` or the server's own
 * folder. null for a network share of another host on a Windows PC (windows-share.ts): the file viewer lists a
 * path it found no file at, which a link can name. `rules`: this system's; a test passes Windows' own.
 */
export function resolveFolder(path: string, home: string, base?: string, rules: Pick<PlatformPath, "resolve" | "sep"> = { resolve, sep }): string | null {
  const trimmed = path.trim();
  const folder = trimmed === "" || trimmed === "~" ? home : trimmed.startsWith("~/") ? rules.resolve(home, trimmed.slice(2)) : base !== undefined ? rules.resolve(base, trimmed) : rules.resolve(trimmed);
  return rules.sep === "\\" && otherHostsShare(folder, [base === undefined ? null : rules.resolve(base), rules.resolve(home), rules.resolve(".")]) ? null : folder;
}

/**
 * `value` as an absolute path (`~` expanded); null for a network share of another host on a Windows PC
 * (windows-share.ts). A folder a route reads can be an address's: the New workspace dialog asks for a folder's
 * skills by itself, with the folder `?new=workspace&cwd=…` named. `own`: the folder of the pane the request names,
 * whose share is the PC's own as the home folder's, the server's own folder's and every pane's is; "chosen" for a
 * folder the user typed or picked and sees before anything is read (a create request), which is how a share
 * becomes a pane's. `rules` and `home`: this system's; a test passes Windows' own.
 */
export function expandedPath(value: string, own: ReadonlyArray<string | null> | "chosen" = [], rules: Pick<PlatformPath, "resolve" | "sep"> = { resolve, sep }, home = homedir()): string | null {
  const expanded = value === "~" ? home : value.startsWith("~/") ? rules.resolve(home, value.slice(2)) : rules.resolve(value);
  return own !== "chosen" && rules.sep === "\\" && otherHostsShare(expanded, [...own, rules.resolve(home), rules.resolve(".")]) ? null : expanded;
}

/** `value` as expandedPath reads it, when it is a directory this user can read; null otherwise, with nothing read of a folder expandedPath refuses. */
export function expandedDirectory(value: string, own: ReadonlyArray<string | null> | "chosen" = [], rules?: Pick<PlatformPath, "resolve" | "sep">, home?: string): string | null {
  const expanded = expandedPath(value, own, rules, home);
  if (expanded === null) return null;
  try {
    return statSync(expanded).isDirectory() ? expanded : null;
  } catch {
    return null;
  }
}

export type CreateDirectoryResult =
  | { path: string }
  | { error: "invalid_cwd" | "invalid_name" | "folder_exists" | "permission_denied" };

/**
 * Makes one folder named `name` directly inside `parent` (the folder the browser shows) and
 * answers its absolute path. `name` is one path segment: no separator, not `.` or `..`, so
 * nothing is made anywhere but inside `parent`; nothing is made recursively or overwritten.
 */
export function createDirectory(parent: string, name: string): CreateDirectoryResult {
  const target = resolveFolder(parent, homedir());
  if (target === null) return { error: "invalid_cwd" };
  try {
    if (!statSync(target).isDirectory()) return { error: "invalid_cwd" };
  } catch {
    return { error: "invalid_cwd" };
  }
  const folder = name.trim();
  if (folder === "" || folder === "." || folder === ".." || /[/\\\0]/.test(folder) || Buffer.byteLength(folder) > MAX_NAME_BYTES) return { error: "invalid_name" };
  const path = join(target, folder);
  try {
    mkdirSync(path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EEXIST") return { error: "folder_exists" };
    if (code === "EACCES" || code === "EPERM" || code === "EROFS") return { error: "permission_denied" };
    // the parent went away meanwhile; a name Windows will not take (`a:b`, `con`) is EINVAL or ENOENT there
    if (code === "ENOENT" || code === "ENOTDIR") return { error: process.platform === "win32" ? "invalid_name" : "invalid_cwd" };
    if (code === "EINVAL" || code === "ENAMETOOLONG") return { error: "invalid_name" };
    throw error;
  }
  return { path };
}

/**
 * The folders inside one directory, for the new-session dialog's folder browser. One
 * directory at a time, names only, nothing kept between calls: the cost is one readdir.
 * `path` takes an absolute path, `~` or `~/…` (the dialog's own syntax); empty means home.
 * Hidden folders (a leading dot) are left out unless asked for. Null when `path` is not
 * a directory this user can read.
 */
/** `base`: the folder a relative path is read from (a pane's, for a link in its chat); else the server's own. */
export function listDirectories(path: string, hidden = false, withFiles = false, base?: string): DirectoryListing | null {
  const home = homedir();
  const target = resolveFolder(path, home, base);
  if (target === null) return null;
  let entries;
  try {
    if (!statSync(target).isDirectory()) return null;
    entries = readdirSync(target, { withFileTypes: true });
  } catch {
    return null;
  }
  const directories: string[] = [];
  const files: { name: string; size: number }[] = [];
  for (const entry of entries) {
    if (!hidden && entry.name.startsWith(".")) continue;
    let isDirectory = entry.isDirectory();
    let isFile = entry.isFile();
    // a link is what it points at (a dangling or looping one is neither)
    if (entry.isSymbolicLink()) {
      try { const target_ = statSync(join(target, entry.name)); isDirectory = target_.isDirectory(); isFile = target_.isFile(); } catch { isDirectory = false; isFile = false; }
    }
    if (isDirectory) directories.push(entry.name);
    else if (withFiles && isFile && files.length <= MAX_DIRECTORY_ENTRIES) {
      let size = 0;
      try { size = statSync(join(target, entry.name)).size; } catch { continue; }
      files.push({ name: entry.name, size });
    }
  }
  const byName = (left: string, right: string) => left.localeCompare(right, undefined, { sensitivity: "base", numeric: true });
  directories.sort(byName);
  files.sort((left, right) => byName(left.name, right.name));
  const parent = dirname(target);
  return {
    path: target,
    parent: parent === target ? null : parent,
    home,
    directories: directories.slice(0, MAX_DIRECTORY_ENTRIES),
    truncated: directories.length > MAX_DIRECTORY_ENTRIES || files.length > MAX_DIRECTORY_ENTRIES,
    ...(withFiles ? { files: files.slice(0, MAX_DIRECTORY_ENTRIES) } : {}),
  };
}
