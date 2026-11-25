/**
 * Which hc pane a process that called the agent tool socket runs in, from what the kernel and hc know, never from
 * what the caller says (docs/harness-tool.md, "From a pane hc started"). The kernel names the connected process
 * (SO_PEERCRED) and pins it (SO_PEERPIDFD: a pid reused after it exits is not that process); /proc gives its chain of
 * parents and their births; hc gives each live pane's root process. A pane whose root is in the chain is the caller's
 * pane. Linux only: elsewhere no pane is proved.
 */
import { readFileSync } from "node:fs";
import type { Socket } from "node:net";
import { dlopen, FFIType, ptr } from "bun:ffi";
import { linuxStartTicks } from "../process-owner.ts";

const SOL_SOCKET = 1, SO_PEERCRED = 17, SO_PEERPIDFD = 77;
/** deeper than any real shell, agent and helper chain; a longer one is refused, not followed */
const MAX_HOPS = 128;

export interface Peer {
  readonly pid: number;
  /** still the process that connected: its pidfd names a live process with that pid */
  alive(): boolean;
  close(): void;
}

let libc: ReturnType<typeof openLibc> | null | undefined;
function openLibc() {
  return dlopen("libc.so.6", {
    getsockopt: { args: [FFIType.i32, FFIType.i32, FFIType.i32, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
    close: { args: [FFIType.i32], returns: FFIType.i32 },
  }).symbols;
}
function symbols() {
  if (libc === undefined) { try { libc = process.platform === "linux" ? openLibc() : null; } catch { libc = null; } }
  return libc;
}

/** The process at the other end of an accepted Unix socket, while its descriptor is open. Null when it cannot be told. */
export function socketPeer(socket: Socket): Peer | null {
  const c = symbols();
  const fd = (socket as unknown as { _handle?: { fd?: unknown } })._handle?.fd;
  if (!c || typeof fd !== "number" || fd < 0) return null;
  const cred = new Int32Array(3), credSize = new Uint32Array([12]);
  if (c.getsockopt(fd, SOL_SOCKET, SO_PEERCRED, ptr(cred), ptr(credSize)) !== 0 || credSize[0] !== 12) return null;
  const [pid = 0, uid = -1] = cred;
  if (pid <= 0 || uid !== process.getuid?.()) return null;
  const pin = new Int32Array(1), pinSize = new Uint32Array([4]);
  if (c.getsockopt(fd, SOL_SOCKET, SO_PEERPIDFD, ptr(pin), ptr(pinSize)) !== 0 || pinSize[0] !== 4) return null;
  const pidfd = pin[0] ?? -1;
  if (pidfd < 0) return null;
  let open = true;
  const peer: Peer = {
    pid,
    alive: () => open && pidfdPid(pidfd) === pid,
    close: () => { if (open) { open = false; c.close(pidfd); } },
  };
  if (!peer.alive()) { peer.close(); return null; }
  return peer;
}

function pidfdPid(pidfd: number): number | null {
  try { return Number(/^Pid:\s*(-?\d+)$/m.exec(readFileSync(`/proc/self/fdinfo/${pidfd}`, "utf8"))?.[1] ?? NaN); } catch { return null; }
}

export interface ProcLink { readonly pid: number; readonly parent: number; readonly birth: string }

let bootId: string | undefined;
/** One process's parent and birth, read together from one /proc/<pid>/stat. Null once it is gone or a zombie. */
export function procLink(pid: number): ProcLink | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(") ") + 2).split(" ");
    const ticks = linuxStartTicks(stat), parent = Number(fields[1]);
    if (fields[0] === "Z" || fields[0] === "X" || ticks === null || !Number.isInteger(parent) || parent < 0) return null;
    bootId ??= readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
    return { pid, parent, birth: `${bootId}:${ticks}` };
  } catch { return null; }
}

/** The process and its parents up to the first (pid 1 or a parentless one). Null when a hop cannot be read. */
export function ancestry(pid: number, read: (pid: number) => ProcLink | null = procLink): ProcLink[] | null {
  const chain: ProcLink[] = [];
  for (let at = pid; at > 0; ) {
    if (chain.length >= MAX_HOPS || chain.some(link => link.pid === at)) return null;
    const link = read(at);
    if (!link) return null;
    chain.push(link);
    at = link.parent;
  }
  return chain;
}

/** A pane by the facts that change when it is closed and its address or root pid is used again. */
export interface PaneKey { readonly pane: string; readonly created_ms: number; readonly root: number; readonly birth: string }
export const sameKey = (a: PaneKey, b: PaneKey): boolean => a.pane === b.pane && a.created_ms === b.created_ms && a.root === b.root && a.birth === b.birth;

export interface PaneTerminal {
  readonly address: string; readonly state: string; readonly pid?: number | null; readonly created_ms: number;
  readonly labels: Record<string, string>; readonly name?: string | null; readonly title?: string;
}
export interface PaneReader {
  list(): Promise<readonly PaneTerminal[]>;
  get(address: string): Promise<PaneTerminal | null>;
}
/** A live pane on this PC's own herdr-core: `t7`, never another machine's `lab/t7`. */
export const localPane = (t: PaneTerminal): t is PaneTerminal & { pid: number } => t.state === "live" && /^[A-Za-z0-9_-]+$/.test(t.address) && typeof t.pid === "number" && t.pid > 0;

/**
 * The pane the peer runs in: exactly one live local pane whose root process is the peer or one of its parents, the
 * same in hc's answer for that pane alone, with no hop of the chain changed meanwhile and the peer still the process
 * that connected. A hint (the caller's HC_TERMINAL_ID) must agree; it never chooses. Anything else proves nothing.
 */
export async function provePane(peer: Peer, hint: string | undefined, hc: PaneReader): Promise<{ key: PaneKey; terminal: PaneTerminal; live: readonly PaneTerminal[] } | null> {
  const chain = ancestry(peer.pid);
  if (!chain || !peer.alive()) return null;
  const live = await hc.list();
  const roots = live.filter(localPane);
  // every live local pane counts, so a pane nested in another's tree is ambiguous rather than the outer one
  const matches = roots.filter(t => chain.some(link => link.pid === t.pid));
  if (matches.length !== 1) return null;
  const pane = matches[0]!;
  if (hint !== undefined && hint !== pane.address) return null;
  const root = chain.find(link => link.pid === pane.pid)!;
  const again = await hc.get(pane.address);
  if (!again || !localPane(again) || again.pid !== pane.pid || again.created_ms !== pane.created_ms) return null;
  const now = ancestry(peer.pid);
  if (!now || now.length !== chain.length || now.some((link, i) => link.pid !== chain[i]!.pid || link.birth !== chain[i]!.birth || link.parent !== chain[i]!.parent)) return null;
  if (!peer.alive()) return null;
  return { key: { pane: pane.address, created_ms: pane.created_ms, root: root.pid, birth: root.birth }, terminal: again, live };
}

/** Whether the peer is still a process of the pane: its root, with the same birth, is still among its parents. */
export function stillIn(peer: Peer, key: PaneKey): boolean {
  return peer.alive() && !!ancestry(peer.pid)?.some(link => link.pid === key.root && link.birth === key.birth);
}
