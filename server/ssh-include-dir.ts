/**
 * glibc's descriptor calls for server/ssh-include.ts: getdents64's records read and checked, a bounded read of 32 KiB
 * at a time (so at most one more such read once the folder-entry budget runs out), and openat, which opens what a
 * listing matched relative to the folder still held. Every call is synchronous through bun:ffi and cannot be cut short,
 * so a folder on a stalled network mount (an NFS or SMB home) blocks the server's event loop, every request with it,
 * until the mount answers, while the SSH list is built.
 */
import { dlopen, FFIType, toArrayBuffer } from "bun:ffi";

/** openat(2) of a path relative to an open folder, close-on-exec: the descriptor, or minus errno */
export type OpenAt = (dir: number, path: string, flags: number) => number;
/** O_CLOEXEC on Linux, which node:fs does not name */
const CLOEXEC = 0x80000;

/** glibc's getdents64(2), which reads a folder's entries from its descriptor a buffer at a time; null without glibc */
export function glibcGetdents(): Getdents | null {
  if (process.platform !== "linux") return null;
  try { return dlopen("libc.so.6", { getdents64: { args: [FFIType.i32, FFIType.ptr, FFIType.u64], returns: FFIType.i64 } }).symbols.getdents64; } catch { return null; }
}

/** glibc's openat; null without glibc (macOS, Windows, a Linux with musl) */
export function glibcOpenAt(): OpenAt | null {
  if (process.platform !== "linux") return null;
  let calls;
  try {
    calls = dlopen("libc.so.6", {
      // variadic only in a mode it reads with O_CREAT, so called with the fixed arguments alone
      openat: { args: [FFIType.i32, FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
      __errno_location: { args: [], returns: FFIType.ptr },
    }).symbols;
  } catch { return null; }
  const errnoPointer = calls.__errno_location();
  if (typeof errnoPointer !== "number") return null;
  // the calling thread's errno, zeroed before each call so a failure is read from it alone
  const errno = new Int32Array(toArrayBuffer(errnoPointer, 0, 4));
  const { openat } = calls;
  return (dir, relative, flags) => {
    // a NUL would end the path early, naming another file
    if (relative.includes("\0")) return -22;
    errno[0] = 0;
    const fd = openat(dir, Buffer.from(`${relative}\0`), flags | CLOEXEC);
    return fd >= 0 ? fd : -(errno[0] || 22);
  };
}

/** getdents64(2): fills `buffer` with a folder's entries from its descriptor and answers the bytes written, or -1 */
export type Getdents = (fd: number, buffer: Buffer, length: number) => number | bigint;

/**
 * The names in a folder open at `fd`, each one charged to `budget.entries`; "unread" once it runs out, when getdents64
 * fails, or when what it answers is not well formed (a byte count past the buffer, a record that is empty, runs past
 * the bytes answered, or holds no terminated name)
 */
export function entriesOf(fd: number, read: Getdents, budget: { entries: number }): string[] | "unread" {
  const buffer = Buffer.alloc(32 * 1024);
  const names: string[] = [];
  for (;;) {
    const got = Number(read(fd, buffer, buffer.byteLength));
    if (!Number.isInteger(got) || got < 0 || got > buffer.byteLength) return "unread";
    if (got === 0) return names;
    // struct linux_dirent64: d_ino (8), d_off (8), d_reclen (2), d_type (1), then the name and its NUL
    for (let at = 0; at < got;) {
      if (at + 20 > got) return "unread";
      const length = buffer.readUInt16LE(at + 16);
      const end = buffer.indexOf(0, at + 19);
      if (length < 20 || at + length > got || end <= at + 19 || end >= at + length) return "unread";
      const name = buffer.toString("utf8", at + 19, end);
      // a name whose bytes are not UTF-8 cannot be opened by the name decoded: what that file sets is unknown
      if (!Buffer.from(name).equals(buffer.subarray(at + 19, end))) return "unread";
      at += length;
      if (budget.entries-- <= 0) return "unread";
      if (name === "." || name === "..") continue;
      names.push(name);
    }
  }
}
