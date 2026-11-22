/**
 * The machine profile's mark in a state folder it took empty (`{"profile":"machine"}`, mode 0600,
 * server/machine-profile.ts), and what it means to every other server that comes up on a state folder:
 * the folder is the profile's own, and its list of paired devices is kept by one server only.
 */
import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { join } from "node:path";

export const MARKER = "machine-profile.json";
const MARKER_MAX_BYTES = 4096;
/**
 * How the marker is opened: never through a link (a link is not the profile's own file) and never waiting (opening
 * a FIFO for reading would wait for a writer), and never as this process's terminal. Windows has none of these
 * flags, and needs none: no profile runs there, and a FIFO is no file in its folders.
 */
const MARKER_OPEN = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0) | (constants.O_NOCTTY ?? 0);

/**
 * Whether `path` is the profile's marker. A file that cannot be read, or holds anything else, is not. It is opened
 * once, and everything after is asked of that descriptor: only a regular file of at most MARKER_MAX_BYTES is read,
 * and never more than one byte past that.
 */
export function markedByProfile(path: string): boolean {
  let fd: number | undefined;
  try {
    fd = openSync(path, MARKER_OPEN);
    const entry = fstatSync(fd);
    if (!entry.isFile() || entry.size > MARKER_MAX_BYTES) return false;
    const bytes = Buffer.alloc(MARKER_MAX_BYTES + 1);
    let length = 0;
    for (let read = 1; read > 0 && length < bytes.length; length += read) read = readSync(fd, bytes, length, bytes.length - length, length);
    if (length > MARKER_MAX_BYTES) return false;
    const marker: unknown = JSON.parse(bytes.toString("utf8", 0, length));
    return typeof marker === "object" && marker !== null && (marker as { profile?: unknown }).profile === "machine";
  } catch (error) {
    if (error instanceof SyntaxError || error instanceof Error && "code" in error) return false;
    throw error;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export class ProfileFolderError extends Error {}

/**
 * Why a server other than the profile does not start on `stateDir`, the folder as it will use it, or null: the
 * folder holds the profile's marker. One read of one file, before anything reads, moves or writes the folder.
 */
export function profileFolderRefusal(stateDir: string): string | null {
  const marker = join(stateDir, MARKER);
  return markedByProfile(marker) ? `The Ovis state folder ${stateDir} is a machine profile's (${marker}), so no server was started; give this one another OVIS_STATE_DIR.` : null;
}
