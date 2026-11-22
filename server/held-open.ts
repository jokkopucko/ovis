/**
 * A directory opened without following a link and held, and the entries inside it opened through the
 * very directory held, never by walking a path again: what the held object is (its identity) and where
 * it is now (its path) are asked of the open object itself. omp's blob reads stand on it (codex-images.ts
 * openBlob, conversation.ts ompBlobIdentity), so nothing swapped in a directory's place, or above it,
 * a link or another directory, can stand in for the one held.
 *
 * Linux reaches an entry through the held descriptor's /proc/self/fd link and names the descriptor by
 * reading that link (it needs /proc). Node has no descriptor-relative open elsewhere, so macOS calls
 * libSystem's openat(2) and fgetattrlist(2) (ATTR_CMN_FULLPATH) and Windows calls NtCreateFile with the
 * held handle as its root directory and GetFinalPathNameByHandleW, all through bun:ffi. fcntl(F_GETPATH)
 * is variadic, which arm64 passes on the stack where a fixed FFI signature does not put it, so it is not used.
 */
import { closeSync, constants, fstatSync, openSync, readlinkSync, readSync } from "node:fs";
import { join } from "node:path";
import { dlopen, FFIType, ptr } from "bun:ffi";

export interface Held {
  stat(): { identity: string; file: boolean; size: number };
  path(): string | null;
  /**
   * Whether the held object is the one `path` names now: no link or other directory stands between.
   * Windows names one path several ways (a short 8.3 name, another letter case), each the same entries.
   */
  isAt(path: string): boolean;
  /** The entry `name` of this held directory, opened through it, a link there not followed but refused. */
  open(name: string, as: "directory" | "file"): Held;
  read(buffer: Buffer, offset: number, length: number, position: number): number;
  close(): void;
}

export function heldOpenPlatform(platform: NodeJS.Platform): boolean {
  return platform === "linux" || platform === "darwin" || platform === "win32";
}

/** The directory `path`, opened as a directory and not through a link at its last component, and held. */
export function openHeldDirectory(path: string): Held {
  if (process.platform === "win32") return WindowsHeld.directory(path);
  const fd = openSync(path, DIRECTORY_FLAGS);
  return process.platform === "darwin" ? new DarwinHeld(fd) : new LinuxHeld(fd);
}

/** One entry's own name: never a path or a parent, and on Windows no stream of a file (`:`) either. */
function entryName(name: string): string {
  const separators = process.platform === "win32" ? /[/\\:\0]/ : /[/\0]/;
  if (name === "" || name === "." || name === ".." || separators.test(name)) throw new Error(`not an entry name: ${JSON.stringify(name)}`);
  return name;
}

/** O_NONBLOCK, so a FIFO put where a file was is not waited on; O_NOFOLLOW, so a link there is refused. */
const FILE_FLAGS = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);
const DIRECTORY_FLAGS = constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0);

abstract class DescriptorHeld implements Held {
  constructor(protected readonly fd: number) {}
  abstract path(): string | null;
  abstract open(name: string, as: "directory" | "file"): Held;
  isAt(path: string): boolean { return this.path() === path; }
  stat() {
    const stat = fstatSync(this.fd, { bigint: true });
    return { identity: `${stat.dev}:${stat.ino}`, file: stat.isFile(), size: Number(stat.size) };
  }
  read(buffer: Buffer, offset: number, length: number, position: number): number {
    return readSync(this.fd, buffer, offset, length, position);
  }
  close(): void { closeSync(this.fd); }
}

/** Linux: the held descriptor's /proc/self/fd link names it and leads into it. */
class LinuxHeld extends DescriptorHeld {
  path(): string | null {
    try { return readlinkSync(`/proc/self/fd/${this.fd}`); } catch { return null; }
  }
  open(name: string, as: "directory" | "file"): Held {
    return new LinuxHeld(openSync(`/proc/self/fd/${this.fd}/${entryName(name)}`, as === "directory" ? DIRECTORY_FLAGS : FILE_FLAGS));
  }
}

/** macOS's O_CLOEXEC (sys/fcntl.h), which node:fs does not export there: a descriptor opened by openat is not handed to a child. */
const DARWIN_O_CLOEXEC = 0x0100_0000;
/** getattrlist(2)'s ATTR_BIT_MAP_COUNT and ATTR_CMN_FULLPATH. */
const ATTR_BIT_MAP_COUNT = 5;
const ATTR_CMN_FULLPATH = 0x0800_0000;
/** Room for MAXPATHLEN (1024) bytes of path after the answer's length and its attrreference_t. */
const FULLPATH_ANSWER = 4 + 8 + 1024;

let libSystem: ReturnType<typeof openLibSystem> | undefined;

function openLibSystem() {
  // openat's mode is variadic and read only with O_CREAT, which is never passed: the fixed arguments
  // go in registers on arm64 and x86_64 alike
  return dlopen("/usr/lib/libSystem.B.dylib", {
    openat: { args: [FFIType.i32, FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
    fgetattrlist: { args: [FFIType.i32, FFIType.ptr, FFIType.ptr, FFIType.u64, FFIType.u64], returns: FFIType.i32 },
  }).symbols;
}

/** macOS: openat(2) opens through the held descriptor, and fgetattrlist(2) names it. */
class DarwinHeld extends DescriptorHeld {
  path(): string | null {
    const symbols = libSystem ??= openLibSystem();
    const request = Buffer.alloc(24);
    request.writeUInt16LE(ATTR_BIT_MAP_COUNT, 0);
    request.writeUInt32LE(ATTR_CMN_FULLPATH, 4);
    const answer = Buffer.alloc(FULLPATH_ANSWER);
    if (symbols.fgetattrlist(this.fd, request, answer, answer.byteLength, 0) !== 0) return null;
    // u32 length, then the attrreference_t: the path's offset from the reference, its length with the NUL
    const offset = 4 + answer.readInt32LE(4);
    const length = answer.readUInt32LE(8);
    if (length < 1 || offset < 12 || offset + length > answer.byteLength) return null;
    return answer.toString("utf8", offset, offset + length - 1);
  }
  open(name: string, as: "directory" | "file"): Held {
    const symbols = libSystem ??= openLibSystem();
    const fd = symbols.openat(this.fd, Buffer.from(`${entryName(name)}\0`), (as === "directory" ? DIRECTORY_FLAGS : FILE_FLAGS) | DARWIN_O_CLOEXEC);
    if (fd < 0) throw new Error(`openat refused ${name}`);
    return new DarwinHeld(fd);
  }
}

/** Win32 and NT values for the handles opened (winnt.h, winternl.h). */
const FILE_LIST_DIRECTORY = 0x1, FILE_READ_DATA = 0x1, FILE_TRAVERSE = 0x20, FILE_READ_ATTRIBUTES = 0x80, SYNCHRONIZE = 0x10_0000;
const FILE_SHARE_ALL = 0x7; // read, write, delete: omp goes on writing and removing its blobs while one is read
const OPEN_EXISTING = 3, FILE_FLAG_BACKUP_SEMANTICS = 0x0200_0000, FILE_FLAG_OPEN_REPARSE_POINT = 0x0020_0000;
const FILE_OPEN = 1, FILE_DIRECTORY_FILE = 0x1, FILE_SYNCHRONOUS_IO_NONALERT = 0x20, FILE_NON_DIRECTORY_FILE = 0x40, FILE_OPEN_REPARSE_POINT = 0x20_0000;
const OBJ_CASE_INSENSITIVE = 0x40;
/** x64 sizes of OBJECT_ATTRIBUTES and UNICODE_STRING. */
const OBJECT_ATTRIBUTES_SIZE = 48, UNICODE_STRING_SIZE = 16;
const FILE_ATTRIBUTE_DIRECTORY = 0x10, FILE_ATTRIBUTE_REPARSE_POINT = 0x400;
const FILE_TYPE_DISK = 1;
const INVALID_HANDLE_VALUE = -1n;
/** GetFinalPathNameByHandleW's room, in UTF-16 units: the longest path Windows has. */
const FINAL_PATH_UNITS = 32_768;

const system32 = () => join(process.env["SystemRoot"] || process.env["windir"] || "C:\\Windows", "System32");
const openKernel = () => dlopen(join(system32(), "kernel32.dll"), {
  CreateFileW: { args: [FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.ptr], returns: FFIType.i64 },
  GetFileInformationByHandle: { args: [FFIType.i64, FFIType.ptr], returns: FFIType.i32 },
  GetFileInformationByHandleEx: { args: [FFIType.i64, FFIType.u32, FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
  GetFileType: { args: [FFIType.i64], returns: FFIType.u32 },
  GetFinalPathNameByHandleW: { args: [FFIType.i64, FFIType.ptr, FFIType.u32, FFIType.u32], returns: FFIType.u32 },
  ReadFile: { args: [FFIType.i64, FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
  CloseHandle: { args: [FFIType.i64], returns: FFIType.i32 },
}).symbols;
const openNtdll = () => dlopen(join(system32(), "ntdll.dll"), {
  NtCreateFile: { args: [FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.u32, FFIType.u32, FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
}).symbols;
let windows: { kernel: ReturnType<typeof openKernel>; ntdll: ReturnType<typeof openNtdll> } | undefined;
const windowsApi = () => windows ??= { kernel: openKernel(), ntdll: openNtdll() };

/**
 * An absolute Windows path as its root (`C:\`, or a share's `\\server\share\`) and the names below it,
 * a `\\?\` prefix taken off; null for any other form: a relative path, a device path (`\\.\`), or one
 * with a `/` anywhere, which Windows reads as a separator, so a root could hide names below it.
 */
function windowsPathParts(path: string): { root: string; names: string[] } | null {
  if (/[/\0]/.test(path)) return null;
  const plain = path.startsWith("\\\\?\\UNC\\") ? `\\\\${path.slice(8)}` : path.startsWith("\\\\?\\") ? path.slice(4) : path;
  const drive = /^([A-Za-z]:)\\(.*)$/s.exec(plain);
  // a server and a share are names, never `.` or `?` (the device and the long-path namespaces)
  const share = drive === null ? /^\\\\([^\\:*?"<>|.][^\\:*?"<>|]*)\\([^\\:*?"<>|]+)(?:\\(.*))?$/s.exec(plain) : null;
  const [root, rest] = drive !== null ? [`${drive[1]}\\`, drive[2]!] : share !== null ? [`\\\\${share[1]}\\${share[2]}\\`, share[3] ?? ""] : [null, ""];
  return root === null ? null : { root, names: rest.split("\\").filter((name) => name !== "") };
}

/** A 64-bit file index that names no one file: 0 (none kept) and all ones (none unique), MS-FSCC 2.1.9. */
const NO_FILE_INDEX = new Set([0n, 0xffff_ffff_ffff_ffffn]);

/** BY_HANDLE_FILE_INFORMATION: attributes, volume serial, size and file index, of the handle itself. */
function handleInformation(handle: bigint): { attributes: number; identity: string | null; size: number } {
  const info = Buffer.alloc(52);
  if (windowsApi().kernel.GetFileInformationByHandle(handle, info) === 0) throw new Error("GetFileInformationByHandle failed");
  const index = (BigInt(info.readUInt32LE(44)) << 32n) | BigInt(info.readUInt32LE(48));
  const size = (info.readUInt32LE(32) * 2 ** 32) + info.readUInt32LE(36);
  // the volume's serial and the file index, as a bigint stat gives them (st_dev, st_ino); none when
  // the file system gives no index of its own
  return { attributes: info.readUInt32LE(0), identity: NO_FILE_INDEX.has(index) ? null : `${info.readUInt32LE(28)}:${index}`, size };
}

/** FileIdInfo, the class GetFileInformationByHandleEx answers FILE_ID_INFO for. */
const FILE_ID_INFO_CLASS = 0x12;

/**
 * The handle's full identity (FILE_ID_INFO: the volume's 64-bit serial and the 128-bit file id, which
 * ReFS keeps where the 64-bit index cannot say), or null when the file system names the file by none.
 * A file system that answers no FileIdInfo at all (FAT32) is named by its 64-bit index instead, an
 * index that names no one file refused (handleInformation); a full id it marks unavailable is not.
 */
function fullIdentity(handle: bigint): string | null {
  const info = Buffer.alloc(24);
  if (windowsApi().kernel.GetFileInformationByHandleEx(handle, FILE_ID_INFO_CLASS, info, info.byteLength) === 0) {
    const legacy = handleInformation(handle).identity;
    return legacy === null ? null : `index:${legacy}`;
  }
  const id = info.subarray(8);
  if (id.every((byte) => byte === 0) || id.every((byte) => byte === 0xff)) return null;
  return `${info.readBigUInt64LE(0)}:${id.toString("hex")}`;
}

/**
 * Windows: a handle opened on the link itself (FILE_FLAG_OPEN_REPARSE_POINT, FILE_OPEN_REPARSE_POINT),
 * refused when it is one (a junction, a symbolic link, any reparse point); an entry is opened by
 * NtCreateFile relative to the held directory's handle, and the handle is named by GetFinalPathNameByHandleW.
 */
class WindowsHeld implements Held {
  private constructor(private readonly handle: bigint) {}

  /** `handle`, held only when it is what was asked for and no reparse point; closed otherwise. */
  private static checked(handle: bigint, as: "directory" | "file"): WindowsHeld {
    const held = new WindowsHeld(handle);
    try {
      const { attributes } = handleInformation(handle);
      const directory = (attributes & FILE_ATTRIBUTE_DIRECTORY) !== 0;
      if ((attributes & FILE_ATTRIBUTE_REPARSE_POINT) !== 0 || directory !== (as === "directory")) throw new Error("not a plain entry");
      return held;
    } catch (error) { held.close(); throw error; }
  }

  static directory(path: string): WindowsHeld {
    const handle = windowsApi().kernel.CreateFileW(Buffer.from(`${path}\0`, "utf16le"), FILE_LIST_DIRECTORY | FILE_TRAVERSE | FILE_READ_ATTRIBUTES | SYNCHRONIZE,
      FILE_SHARE_ALL, null, OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, null);
    if (handle === INVALID_HANDLE_VALUE || handle === 0n) throw new Error(`CreateFileW refused ${path}`);
    return WindowsHeld.checked(handle, "directory");
  }

  stat() {
    const { attributes, identity, size } = handleInformation(this.handle);
    // an index that names no one file proves no identity: refused, as every caller compares it
    if (identity === null) throw new Error("no file index");
    const file = (attributes & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT)) === 0 && windowsApi().kernel.GetFileType(this.handle) === FILE_TYPE_DISK;
    return { identity, file, size };
  }

  path(): string | null {
    const answer = Buffer.alloc(FINAL_PATH_UNITS * 2);
    // FILE_NAME_NORMALIZED | VOLUME_NAME_DOS: \\?\C:\... or \\?\UNC\server\share\...
    const units = windowsApi().kernel.GetFinalPathNameByHandleW(this.handle, answer, FINAL_PATH_UNITS, 0);
    if (units === 0 || units >= FINAL_PATH_UNITS) return null;
    const named = answer.toString("utf16le", 0, units * 2);
    if (named.startsWith("\\\\?\\UNC\\")) return `\\\\${named.slice(8)}`;
    return named.startsWith("\\\\?\\") ? named.slice(4) : named;
  }

  /**
   * Windows names one directory several ways (a short 8.3 name, another letter case), so the path is
   * walked rather than compared: from its root, each name opened through the directory before it and
   * refused as a reparse point (a junction, a symbolic link, a mount point), down to the very object
   * held (its full identity, fullIdentity). The system resolves each name as any open would, in that
   * directory's own case rules, and no spelling can stand in for another directory. The root itself
   * must be one: a drive that names a folder elsewhere (subst, a mapped share) is refused.
   */
  isAt(path: string): boolean {
    const parts = windowsPathParts(path);
    if (parts === null) return false;
    const walked: WindowsHeld[] = [];
    try {
      let at = WindowsHeld.directory(parts.root);
      walked.push(at);
      // drive letters, servers and shares are named regardless of case
      if (at.path()?.toUpperCase() !== parts.root.toUpperCase()) return false;
      for (const name of parts.names) { at = at.open(name, "directory"); walked.push(at); }
      const [reached, held] = [fullIdentity(at.handle), fullIdentity(this.handle)];
      return reached !== null && reached === held;
    } catch { return false; } finally { for (const entry of walked) entry.close(); }
  }

  open(name: string, as: "directory" | "file"): WindowsHeld {
    const units = Buffer.from(entryName(name), "utf16le");
    // one allocation, passed to the call itself, holds the structures and the name they point into:
    // a pointer written into a buffer keeps nothing alive, so a separate name could be collected first
    const attributes = Buffer.alloc(OBJECT_ATTRIBUTES_SIZE + UNICODE_STRING_SIZE + units.byteLength);
    const base = BigInt(ptr(attributes));
    units.copy(attributes, OBJECT_ATTRIBUTES_SIZE + UNICODE_STRING_SIZE);
    // OBJECT_ATTRIBUTES { ULONG Length, HANDLE RootDirectory, PUNICODE_STRING ObjectName, ULONG Attributes, ... }
    attributes.writeUInt32LE(OBJECT_ATTRIBUTES_SIZE, 0);
    attributes.writeBigInt64LE(this.handle, 8);
    attributes.writeBigUInt64LE(base + BigInt(OBJECT_ATTRIBUTES_SIZE), 16);
    attributes.writeUInt32LE(OBJ_CASE_INSENSITIVE, 24);
    // then UNICODE_STRING { USHORT Length, USHORT MaximumLength, PWSTR Buffer }
    attributes.writeUInt16LE(units.byteLength, OBJECT_ATTRIBUTES_SIZE);
    attributes.writeUInt16LE(units.byteLength, OBJECT_ATTRIBUTES_SIZE + 2);
    attributes.writeBigUInt64LE(base + BigInt(OBJECT_ATTRIBUTES_SIZE + UNICODE_STRING_SIZE), OBJECT_ATTRIBUTES_SIZE + 8);
    const opened = Buffer.alloc(8), status = Buffer.alloc(16);
    const directory = as === "directory";
    const result = windowsApi().ntdll.NtCreateFile(opened, (directory ? FILE_LIST_DIRECTORY | FILE_TRAVERSE : FILE_READ_DATA) | FILE_READ_ATTRIBUTES | SYNCHRONIZE,
      attributes, status, null, 0, FILE_SHARE_ALL, FILE_OPEN,
      (directory ? FILE_DIRECTORY_FILE : FILE_NON_DIRECTORY_FILE) | FILE_SYNCHRONOUS_IO_NONALERT | FILE_OPEN_REPARSE_POINT, null, 0);
    const handle = opened.readBigInt64LE(0);
    if (result !== 0) {
      if (handle !== 0n) windowsApi().kernel.CloseHandle(handle);
      throw new Error(`NtCreateFile refused ${name}: 0x${(result >>> 0).toString(16)}`);
    }
    return WindowsHeld.checked(handle, as);
  }

  read(buffer: Buffer, offset: number, length: number, position: number): number {
    // OVERLAPPED { Internal, InternalHigh, Offset, OffsetHigh, hEvent }: a synchronous handle reads there and returns when done
    const overlapped = Buffer.alloc(32);
    overlapped.writeUInt32LE(position % 2 ** 32, 16);
    overlapped.writeUInt32LE(Math.floor(position / 2 ** 32), 20);
    const got = Buffer.alloc(4);
    if (windowsApi().kernel.ReadFile(this.handle, buffer.subarray(offset, offset + length), length, got, overlapped) === 0) throw new Error("ReadFile failed");
    return got.readUInt32LE(0);
  }

  close(): void { windowsApi().kernel.CloseHandle(this.handle); }
}
