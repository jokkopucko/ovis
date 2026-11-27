import { CString, dlopen, FFIType, toArrayBuffer } from "bun:ffi";
import { join, toNamespacedPath } from "node:path";

const ptr = FFIType.ptr;
const int = FFIType.i32;

function openPosix() {
  const mac = process.platform === "darwin";
  const readName = mac && process.arch === "x64" ? "readdir$INODE64" : "readdir";
  const errnoName = mac ? "__error" : "__errno_location";
  const open = (library: string) => dlopen(library, {
    opendir: { args: [ptr], returns: ptr },
    closedir: { args: [ptr], returns: int },
    [readName]: { args: [ptr], returns: ptr },
    [errnoName]: { args: [], returns: ptr },
  }).symbols;
  let api: ReturnType<typeof open>;
  try {
    api = open(mac ? "/usr/lib/libSystem.B.dylib" : "libc.so.6");
  } catch (error) {
    if (mac) throw error;
    api = open("libc.so"); // musl
  }
  const read = api[readName];
  const errno = api[errnoName];
  if (!read || !errno) throw new Error("directory iteration is unavailable");
  // d_name follows the inode, offset, record length and type; Darwin also has d_namlen.
  return { ...api, read, errno, nameOffset: mac ? 21 : 19 };
}

function openWindows() {
  const i64 = FFIType.i64;
  return dlopen(join(process.env["SystemRoot"] || process.env["windir"] || "C:\\Windows", "System32", "kernel32.dll"), {
    FindFirstFileW: { args: [ptr, ptr], returns: i64 },
    FindNextFileW: { args: [i64, ptr], returns: int },
    FindClose: { args: [i64], returns: int },
    GetLastError: { args: [], returns: FFIType.u32 },
  }).symbols;
}

let posix: ReturnType<typeof openPosix> | undefined;
let windows: ReturnType<typeof openWindows> | undefined;

/** Unlike Bun's fs.Dir, the native iterator does not eagerly read the whole directory. */
export function* directoryEntries(path: string): Generator<string, void> {
  if (process.platform === "win32") {
    const api = windows ??= openWindows();
    const pattern = Buffer.from(`${join(toNamespacedPath(path), "*")}\0`, "utf16le");
    const data = Buffer.alloc(592); // WIN32_FIND_DATAW
    const handle = api.FindFirstFileW(pattern, data);
    if (handle === -1n) {
      if (api.GetLastError() === 2) return; // ERROR_FILE_NOT_FOUND: empty search
      throw new Error(`cannot open directory: ${path}`);
    }
    try {
      do {
        // cFileName begins at byte 44 and holds up to MAX_PATH UTF-16 code units.
        let end = 44;
        while (end < 564 && data.readUInt16LE(end) !== 0) end += 2;
        const name = data.toString("utf16le", 44, end);
        if (name !== "." && name !== "..") yield name;
      } while (api.FindNextFileW(handle, data));
      if (api.GetLastError() !== 18) throw new Error(`cannot read directory: ${path}`); // ERROR_NO_MORE_FILES
    } finally {
      api.FindClose(handle);
    }
    return;
  }

  const api = posix ??= openPosix();
  const errno = api.errno();
  if (errno === null) throw new Error("errno is unavailable");
  const error = new Int32Array(toArrayBuffer(errno, 0, 4));
  const dir = api.opendir(Buffer.from(`${path}\0`));
  if (dir === null) throw new Error(`cannot open directory: ${path}`);
  try {
    for (;;) {
      error[0] = 0;
      const entry = api.read(dir);
      if (entry === null) {
        if (error[0] !== 0) throw new Error(`cannot read directory: ${path}`);
        return;
      }
      const name = new CString(entry, api.nameOffset).toString();
      if (name !== "." && name !== "..") yield name;
    }
  } finally {
    api.closedir(dir);
  }
}
