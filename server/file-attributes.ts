import { dlopen, FFIType, read, type Pointer } from "bun:ffi";

/**
 * A file's extended attributes, and its access list, carried from one descriptor to another
 * (`file-edit.ts`: the file a save replaces, to the new file that takes its place). Node has no call
 * for them, so they are read and written through the C library. An access list decides who may read
 * the file: one that cannot be carried over refuses the save, since the new file would otherwise be
 * open to whoever its mode and folder let in. Any other attribute (a label, a download's quarantine
 * mark) is carried over when it can be and left behind when it cannot.
 */

/** Linux keeps an access list as this attribute; macOS keeps it apart (`acl_get_fd_np`). */
const LINUX_ACCESS_LIST = "system.posix_acl_access";
/** `ACL_TYPE_EXTENDED`: the only kind of access list macOS has. */
const MACOS_EXTENDED_ACL = 0x100;

/** What a failed listing says when the filesystem keeps no attributes at all (ENOTSUP, EOPNOTSUPP): none to carry. */
const UNSUPPORTED: Record<string, readonly number[]> = { linux: [95], darwin: [45, 102] };
/** What a failed macOS access list read says when the file has none (ENOENT). */
const NO_ACL = 2;

type Calls = {
  /** the calling thread's errno, read right after a call that failed */
  errno: () => number;
  list: (fd: number, buffer: Buffer | null, size: number) => number;
  remove: (fd: number, name: Buffer) => number;
  get: (fd: number, name: Buffer, buffer: Buffer | null, size: number) => number;
  set: (fd: number, name: Buffer, value: Buffer) => number;
  /** macOS only: the descriptor's access list copied to another; false when it could not be */
  copyAcl?: (from: number, to: number) => boolean;
};

let loaded: Calls | null | undefined;

function calls(platform: NodeJS.Platform): Calls | null {
  if (loaded !== undefined) return loaded;
  try {
    if (platform === "linux") {
      const { symbols } = dlopen("libc.so.6", {
        flistxattr: { args: [FFIType.i32, FFIType.ptr, FFIType.u64], returns: FFIType.i64 },
        fgetxattr: { args: [FFIType.i32, FFIType.ptr, FFIType.ptr, FFIType.u64], returns: FFIType.i64 },
        fsetxattr: { args: [FFIType.i32, FFIType.ptr, FFIType.ptr, FFIType.u64, FFIType.i32], returns: FFIType.i32 },
        fremovexattr: { args: [FFIType.i32, FFIType.ptr], returns: FFIType.i32 },
        __errno_location: { args: [], returns: FFIType.ptr },
      });
      loaded = {
        errno: () => read.i32(symbols.__errno_location() as Pointer, 0),
        list: (fd, buffer, size) => Number(symbols.flistxattr(fd, buffer, size)),
        remove: (fd, name) => symbols.fremovexattr(fd, name),
        get: (fd, name, buffer, size) => Number(symbols.fgetxattr(fd, name, buffer, size)),
        set: (fd, name, value) => symbols.fsetxattr(fd, name, value, value.length, 0),
      };
    } else if (platform === "darwin") {
      const { symbols } = dlopen("/usr/lib/libSystem.B.dylib", {
        flistxattr: { args: [FFIType.i32, FFIType.ptr, FFIType.u64, FFIType.i32], returns: FFIType.i64 },
        fgetxattr: { args: [FFIType.i32, FFIType.ptr, FFIType.ptr, FFIType.u64, FFIType.u32, FFIType.i32], returns: FFIType.i64 },
        fsetxattr: { args: [FFIType.i32, FFIType.ptr, FFIType.ptr, FFIType.u64, FFIType.u32, FFIType.i32], returns: FFIType.i32 },
        fremovexattr: { args: [FFIType.i32, FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
        __error: { args: [], returns: FFIType.ptr },
        acl_init: { args: [FFIType.i32], returns: FFIType.ptr },
        acl_get_fd_np: { args: [FFIType.i32, FFIType.i32], returns: FFIType.ptr },
        acl_set_fd_np: { args: [FFIType.i32, FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
        acl_free: { args: [FFIType.ptr], returns: FFIType.i32 },
      });
      loaded = {
        errno: () => read.i32(symbols.__error() as Pointer, 0),
        list: (fd, buffer, size) => Number(symbols.flistxattr(fd, buffer, size, 0)),
        remove: (fd, name) => symbols.fremovexattr(fd, name, 0),
        get: (fd, name, buffer, size) => Number(symbols.fgetxattr(fd, name, buffer, size, 0, 0)),
        set: (fd, name, value) => symbols.fsetxattr(fd, name, value, value.length, 0, 0),
        copyAcl: (from, to) => {
          let acl = symbols.acl_get_fd_np(from, MACOS_EXTENDED_ACL) as Pointer | null;
          // a read that failed for another reason than "none" may hide one: nothing is assumed
          if (acl === null && read.i32(symbols.__error() as Pointer, 0) !== NO_ACL) return false;
          // none on the file: the new file gets none either, not one its folder would pass on
          acl ??= symbols.acl_init(0) as Pointer | null;
          if (acl === null) return false;
          try { return symbols.acl_set_fd_np(to, acl, MACOS_EXTENDED_ACL) === 0; } finally { symbols.acl_free(acl); }
        },
      };
    } else loaded = null;
  } catch { loaded = null; }
  return loaded;
}

/** The names of the attributes of the file open at `fd`; none where the filesystem keeps none. A listing that failed otherwise throws. */
function names(call: Calls, fd: number, platform: NodeJS.Platform): string[] {
  const size = call.list(fd, null, 0);
  if (size < 0 && (UNSUPPORTED[platform] ?? []).includes(call.errno())) return [];
  if (size < 0) throw new Error("the file's attributes could not be listed");
  if (size === 0) return [];
  const buffer = Buffer.alloc(size);
  const got = call.list(fd, buffer, size);
  if (got < 0) throw new Error("the file's attributes changed while they were read");
  return buffer.subarray(0, got).toString("utf8").split("\0").filter(Boolean);
}

function value(call: Calls, fd: number, name: Buffer): Buffer | null {
  const size = call.get(fd, name, null, 0);
  if (size < 0) return null;
  const buffer = Buffer.alloc(size);
  const got = size === 0 ? 0 : call.get(fd, name, buffer, size);
  return got < 0 ? null : buffer.subarray(0, got);
}

/**
 * False when an access list (or the calls to read one) could not be carried over: the caller
 * refuses the save.
 */
export function copyFileAttributes(from: number, to: number, platform: NodeJS.Platform = process.platform): boolean {
  const call = calls(platform);
  if (call === null) return false;
  let found: string[];
  let inherited: string[];
  try { found = names(call, from, platform); inherited = names(call, to, platform); } catch { return false; }
  // what the new file took from its folder (a default access list) and the file did not have goes
  for (const name of inherited.filter((name) => !found.includes(name))) {
    if (call.remove(to, Buffer.from(`${name}\0`)) !== 0 && name === LINUX_ACCESS_LIST) return false;
  }
  for (const name of found) {
    const key = Buffer.from(`${name}\0`);
    const bytes = value(call, from, key);
    if (bytes === null && name === LINUX_ACCESS_LIST) return false;
    if (bytes === null) continue;
    if (call.set(to, key, bytes) !== 0 && name === LINUX_ACCESS_LIST) return false;
  }
  return call.copyAcl?.(from, to) ?? true;
}
