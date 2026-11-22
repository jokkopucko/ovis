/**
 * Durable replacement of private security records: the paired-device registry (its closed gate
 * and last-seen times included, since they share the file), the VAPID key pair and the push subscriptions. Losing one of these acknowledged writes
 * on a crash or power loss brings back a revoked device or orphans every phone's push
 * subscription, and none of them can be recomputed, so the new bytes are flushed before they
 * replace the old file.
 *
 * A unique temporary file is created exclusively in the same directory at 0600 (the directory
 * is created 0700), all bytes are written, the file is fsynced and closed, then renamed over the
 * destination. The destination ends up at most 0600: on POSIX a narrower existing mode (0400, say)
 * is kept, a wider one is never copied. A failure up to and including the rename throws and leaves
 * the destination as it was. Afterwards the parent
 * directory is fsynced on POSIX so the rename itself is recorded; that step is best effort (some
 * filesystems refuse it), so its failure is returned, not thrown: the new document is already in
 * place and readable, only the guarantee that the rename survives power loss is weaker.
 *
 * High-frequency writes in files of their own (retired push endpoints, preferences) do not come
 * here: they are cheap to lose and would pay an fsync each time.
 */
import { randomBytes } from "node:crypto";
import { chmodSync, closeSync, fsyncSync, lstatSync, mkdirSync, openSync, realpathSync, renameSync, statSync, unlinkSync, writeSync, type Stats } from "node:fs";
import { dirname } from "node:path";
import { harmlessGroups } from "./herdr-core/discovery.ts";

/**
 * Why the private record at `path` cannot be trusted, or null. It grants access (a devices.json row is
 * a device that drives) or signs for this server (vapid.json), so another account must not have put it
 * there or be able to change it. What another account writes it owns: its folder (the link's target's,
 * for a link) and the file are this user's (the folder may be root's), else refused. Write access left
 * open to others on what is this user's (an older version, a umask of 002, a restored backup) is taken
 * away here, before the read, so an install made that way keeps working; a root folder others can write
 * is refused. A folder further up is not checked: one another account can write could swap the whole
 * folder, as for any of the user's files. Windows has no POSIX owner or mode to read: null there.
 */
export function privateStateRefusal(path: string, platform: NodeJS.Platform = process.platform, uid: number | undefined = process.getuid?.()): string | null {
  if (platform === "win32" || uid === undefined) return null;
  const harmless = harmlessGroups(platform);
  const othersWrite = (stats: Stats, at: string) => (stats.mode & 0o002) !== 0 || ((stats.mode & 0o020) !== 0 && !harmless(stats.gid, at));
  const look = (at: string, read: (at: string) => Stats): Stats | null | string => {
    try { return read(at); }
    catch (error) { return (error as NodeJS.ErrnoException).code === "ENOENT" ? null : `${at} could not be checked (${(error as NodeJS.ErrnoException).code ?? String(error)})`; }
  };
  /** this user's entry, its write access for others taken away; null once it is safe */
  const own = (stats: Stats, at: string, rootMay: boolean): string | null => {
    if (stats.uid !== uid && !(rootMay && stats.uid === 0)) return `${at} is owned by uid ${stats.uid}, not you`;
    if (!othersWrite(stats, at)) return null;
    if (stats.uid !== uid) return `${at} can be written by another account`;
    try { chmodSync(at, stats.mode & 0o7755); } catch (error) { return `${at} can be written by another account and could not be made yours alone (${(error as NodeJS.ErrnoException).code ?? String(error)})`; }
    return null;
  };
  const folder = (at: string): string | null => {
    // no folder yet: the writer creates it 0700
    const stats = look(at, statSync);
    if (stats === null || typeof stats === "string") return stats;
    if (!stats.isDirectory()) return `${at} is not a folder`;
    return own(stats, at, true);
  };
  const parent = folder(dirname(path));
  if (parent !== null) return parent;
  const entry = look(path, lstatSync);
  if (entry === null || typeof entry === "string") return entry;
  if (entry.isSymbolicLink()) {
    if (entry.uid !== uid) return `${path} is a link owned by uid ${entry.uid}, not you`;
    let target: string;
    try { target = realpathSync(path); } catch (error) { return `${path} could not be followed (${(error as NodeJS.ErrnoException).code ?? String(error)})`; }
    const targetFolder = folder(dirname(target));
    if (targetFolder !== null) return targetFolder;
    const stats = look(target, lstatSync);
    if (stats === null || typeof stats === "string") return stats ?? `${path} points to nothing`;
    if (!stats.isFile()) return `${target} is not a regular file`;
    return own(stats, target, false);
  }
  if (!entry.isFile()) return `${path} is not a regular file`;
  return own(entry, path, false);
}

export const privateStateFs = { mkdirSync, openSync, writeSync, fsyncSync, closeSync, renameSync, unlinkSync };

export interface PrivateStateWrite {
  /** false when the parent-directory fsync after the rename failed or was not attempted (Windows) */
  directorySynced: boolean;
}

export function writePrivateState(path: string, value: unknown, platform: NodeJS.Platform = process.platform): PrivateStateWrite {
  const temporary = preparePrivateState(path, value, platform);
  try { privateStateFs.renameSync(temporary, path); }
  catch (error) {
    // Cleanup failures must not mask the write failure the caller has to see.
    try { privateStateFs.unlinkSync(temporary); } catch {}
    throw error;
  }
  return syncDirectory(dirname(path), platform);
}

export function publishPrivateState(temporary: string, path: string, platform: NodeJS.Platform = process.platform): PrivateStateWrite {
  privateStateFs.renameSync(temporary, path);
  return syncDirectory(dirname(path), platform);
}

/** The new bytes of `path`, flushed, in a private temporary file beside it; returns that file. */
export function preparePrivateState(path: string, value: unknown, platform: NodeJS.Platform = process.platform): string {
  const fs = privateStateFs;
  const directory = dirname(path);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
  const temporary = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  // Never wider than 0600, and never wider than the file it replaces. The descriptor stays
  // writable whatever the mode: O_CREAT applies it only to later opens. Windows modes carry no
  // owner privacy, and a read-only temporary file there could not be cleaned up.
  const existing = platform === "win32" ? undefined : statSync(path, { throwIfNoEntry: false });
  const mode = existing === undefined ? 0o600 : existing.mode & 0o600;
  // "wx": O_CREAT | O_EXCL, so this call never writes into a file it did not create
  let fd: number | null = fs.openSync(temporary, "wx", mode);
  try {
    for (let written = 0; written < bytes.length;) {
      const count = fs.writeSync(fd, bytes, written, bytes.length - written);
      if (count <= 0) throw new Error(`wrote no bytes to ${temporary}`);
      written += count;
    }
    fs.fsyncSync(fd);
    const closing = fd;
    fd = null; // a failed close must not be retried: the descriptor is released either way
    fs.closeSync(closing);
  } catch (error) {
    // Cleanup failures must not mask the write failure the caller has to see.
    if (fd !== null) try { fs.closeSync(fd); } catch {}
    try { fs.unlinkSync(temporary); } catch {}
    throw error;
  }
  return temporary;
}

export function syncDirectory(directory: string, platform: NodeJS.Platform): PrivateStateWrite {
  const fs = privateStateFs;
  if (platform === "win32") return { directorySynced: false };
  let directoryFd: number | null = null;
  try {
    directoryFd = fs.openSync(directory, "r");
    fs.fsyncSync(directoryFd);
    return { directorySynced: true };
  } catch {
    return { directorySynced: false };
  } finally {
    if (directoryFd !== null) try { fs.closeSync(directoryFd); } catch {}
  }
}
