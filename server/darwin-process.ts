/**
 * What macOS's kernel keeps about a process, read in the server's own thread through libSystem:
 * `ps` asked the same kernel, but as a child the event loop had to wait for, and that wait stalled
 * every connection (#1404). Each read takes microseconds and never starts a process.
 */
import { dlopen, FFIType, ptr } from "bun:ffi";

let libSystem: ReturnType<typeof openLibSystem> | undefined;

function openLibSystem() {
  return dlopen("/usr/lib/libSystem.B.dylib", {
    sysctl: { args: [FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.u64], returns: FFIType.i32 },
    devname: { args: [FFIType.i32, FFIType.u16], returns: FFIType.cstring },
  }).symbols;
}

export function sysctlCall(): (name: Int32Array, out: Uint8Array) => number | null {
  const symbols = libSystem ??= openLibSystem();
  return (name, out) => {
    const size = new BigUint64Array([BigInt(out.byteLength)]);
    return symbols.sysctl(ptr(name), name.length, ptr(out), ptr(size), null, 0) === 0 ? Number(size[0]) : null;
  };
}

/** kern.proc.pid begins with extern_proc.p_starttime, a 64-bit Darwin timeval. */
export function procStartTime(answer: Uint8Array): bigint | null {
  if (answer.byteLength < 16) return null;
  const view = new DataView(answer.buffer, answer.byteOffset, answer.byteLength);
  const seconds = view.getBigInt64(0, true);
  const micros = view.getInt32(8, true);
  return seconds > 0n && micros >= 0 && micros < 1_000_000 ? seconds * 1_000_000n + BigInt(micros) : null;
}

/** Where kinfo_proc keeps kp_eproc.e_tdev, the controlling terminal's device (648-byte kinfo_proc, arm64 and x86_64). */
const E_TDEV_OFFSET = 572;
/** dev_t's NODEV: the process has no controlling terminal (`ps` prints `??`). */
const NODEV = -1;

export function procTerminalDevice(answer: Uint8Array): number | null {
  if (answer.byteLength < E_TDEV_OFFSET + 4) return null;
  const device = new DataView(answer.buffer, answer.byteOffset, answer.byteLength).getInt32(E_TDEV_OFFSET, true);
  return device === NODEV ? null : device;
}

/** kinfo_proc's size and where it keeps p_pid, p_comm (MAXCOMLEN + 1 bytes), e_ppid and e_pgid (arm64 and x86_64) */
const KINFO_PROC_SIZE = 648;
const P_PID_OFFSET = 40;
const P_COMM_OFFSET = 243;
const P_COMM_SIZE = 17;
const E_PPID_OFFSET = 560;
const E_PGID_OFFSET = 564;
const GROUP_MAX = 256;

function procEntry(answer: Uint8Array, at: number): { pid: number; parent: number; group: number; name: string } {
  const view = new DataView(answer.buffer, answer.byteOffset + at, KINFO_PROC_SIZE);
  const comm = answer.subarray(at + P_COMM_OFFSET, at + P_COMM_OFFSET + P_COMM_SIZE);
  const end = comm.indexOf(0);
  return {
    pid: view.getInt32(P_PID_OFFSET, true),
    parent: view.getInt32(E_PPID_OFFSET, true),
    group: view.getInt32(E_PGID_OFFSET, true),
    name: Buffer.from(comm.subarray(0, end < 0 ? comm.length : end)).toString("utf8"),
  };
}

/** sysctl CTL_KERN, KERN_PROC, KERN_PROC_PGRP */
export function darwinProcessGroup(pid: number): { pid: number; parent: number; name: string }[] | null {
  const own = kinfoProc(pid);
  if (own === null || own.byteLength < KINFO_PROC_SIZE) return null;
  const group = procEntry(own, 0).group;
  const answer = new Uint8Array(KINFO_PROC_SIZE * GROUP_MAX);
  const length = sysctlCall()(new Int32Array([1, 14, 2, group]), answer);
  if (length === null || length % KINFO_PROC_SIZE !== 0) return null;
  const found: { pid: number; parent: number; name: string }[] = [];
  for (let at = 0; at < length; at += KINFO_PROC_SIZE) {
    const { pid: member, parent, name } = procEntry(answer, at);
    found.push({ pid: member, parent, name });
  }
  return found;
}

/**
 * A process's arguments as the kernel keeps them (CTL_KERN, KERN_PROCARGS2): an int argc, the
 * executable's path, its NUL padding, then argc NUL-terminated arguments. Null when it cannot be read
 * (another user's process, one gone) or the answer is cut short.
 */
export function darwinArgv(pid: number): string[] | null {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  const call = sysctlCall();
  const argmax = new Uint8Array(4);
  if (call(new Int32Array([1, 8]), argmax) === null) return null; // CTL_KERN, KERN_ARGMAX
  const answer = new Uint8Array(new DataView(argmax.buffer).getInt32(0, true));
  const length = call(new Int32Array([1, 49, pid]), answer);
  if (length === null || length < 4) return null;
  const bytes = Buffer.from(answer.buffer, 0, length);
  const argc = bytes.readInt32LE(0);
  let at = bytes.indexOf(0, 4);
  if (argc <= 0 || at < 0) return null;
  while (at < bytes.length && bytes[at] === 0) at++;
  const words: string[] = [];
  while (words.length < argc) {
    const end = bytes.indexOf(0, at);
    if (end < 0) return null;
    words.push(bytes.toString("utf8", at, end));
    at = end + 1;
  }
  return words;
}

/** CTL_KERN, KERN_PROC, KERN_PROC_PID: the process's kinfo_proc, empty when no such process runs. */
function kinfoProc(pid: number): Uint8Array | null {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  const answer = new Uint8Array(4096);
  const length = sysctlCall()(new Int32Array([1, 14, 1, pid]), answer);
  return length === null ? null : answer.subarray(0, length);
}

/** The kernel's process birth time in microseconds, including those `ps -o lstart` drops. */
export function darwinStartTime(pid: number): bigint | null {
  const answer = kinfoProc(pid);
  return answer === null ? null : procStartTime(answer);
}

function deviceName(device: number): string | null {
  const symbols = libSystem ??= openLibSystem();
  const name = symbols.devname(device, 0o020000); // S_IFCHR
  return name === null ? null : String(name) || null;
}

/**
 * The process's controlling terminal under /dev (`ttys003`, as `ps -o tty=` prints it) and its start
 * in ms, both from one kinfo_proc: two reads could describe two processes when the PID is reused
 * between them.
 */
export function darwinTerminal(
  pid: number,
  read: (pid: number) => Uint8Array | null = kinfoProc,
  name: (device: number) => string | null = deviceName,
): { tty: string; startedAt: number } | null {
  const answer = read(pid);
  if (answer === null) return null;
  const started = procStartTime(answer);
  const device = procTerminalDevice(answer);
  const tty = started === null || device === null ? null : name(device);
  return tty === null ? null : { tty, startedAt: Number(started! / 1000n) };
}
