import type { HerdrPane } from "../shared/protocol.ts";
import { lstatSync, readFileSync, readdirSync, readlinkSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { ConversationUnavailable } from "./conversation-shared.ts";

/** A live Devin executable, not a command line which happens to mention one. */
export function isDevinProcess(argv: readonly string[]): boolean {
  const executable = argv[0] ?? "";
  const exact = /(?:^|[\\/])devin(?:\.exe)?$/;
  return process.platform === "win32" ? exact.test(executable.toLowerCase()) : exact.test(executable);
}

// Devin's native CLI holds an exclusive flock on session_locks/<session-id>.lock in
// its ACP child. Read the kernel's lock record, not merely the open descriptor.
// All of these operations are injectable so races and PID reuse can be exercised.
export interface DevinProc {
  read(path: string): string;
  list(path: string): string[];
  link(path: string): string;
  real(path: string): string;
  stat(path: string, follow?: boolean): { dev: number; ino: number; uid: number; isFile(): boolean; isDirectory(): boolean };
  uid: number;
}
const localProc: DevinProc = {
  read: (path) => readFileSync(path, "utf8"),
  list: (path) => readdirSync(path),
  link: (path) => readlinkSync(path),
  real: (path) => realpathSync(path),
  stat: (path, follow = true) => follow ? statSync(path) : lstatSync(path),
  uid: typeof process.getuid === "function" ? process.getuid() : -1,
};

export interface DevinLockProof { session: string; binding: string }
const LOCK_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * No lock to read: no session_locks (an older Devin), a store reached through a symlink, no ACP
 * child, or no lock held yet. A caller may then read a session the pane names explicitly; any
 * other failure (two locks, a foreign owner, a replaced file) contradicts one and refuses.
 */
export class DevinLockMissing extends ConversationUnavailable {
  constructor() { super("no_session_id"); }
}

/** A stable proof from one pane's outer process and its direct ACP children only. */
export function devinLockProof(pid: number, dbPath: string, proc: DevinProc = localProc): DevinLockProof {
  const unavailable = () => new ConversationUnavailable("no_session_id");
  const missing = () => new DevinLockMissing();
  try {
    if (!Number.isSafeInteger(pid) || pid <= 0) throw unavailable();
    const root = resolve(dirname(dbPath));
    const locks = join(root, "session_locks");
    for (const dir of [root, locks]) {
      let stat: ReturnType<DevinProc["stat"]>;
      try { stat = proc.stat(dir, false); } catch { throw missing(); }
      if (!stat.isDirectory() || proc.real(dir) !== dir) throw missing();
      if (stat.uid !== proc.uid) throw unavailable();
    }
    let db: ReturnType<DevinProc["stat"]>;
    try { db = proc.stat(dbPath, false); } catch { throw missing(); }
    if (!db.isFile() || proc.real(dbPath) !== resolve(dbPath)) throw missing();
    if (db.uid !== proc.uid) throw unavailable();
    const processInfo = (id: number) => {
      const base = `/proc/${id}`;
      if (proc.stat(base).uid !== proc.uid) throw unavailable();
      const raw = proc.read(`${base}/stat`);
      const end = raw.lastIndexOf(") ");
      if (end < 0) throw unavailable();
      const fields = raw.slice(end + 2).trim().split(/\s+/);
      if (!/^\d+$/.test(fields[1] ?? "") || !/^\d+$/.test(fields[19] ?? "")) throw unavailable();
      const argv = proc.read(`${base}/cmdline`).split("\0").filter(Boolean);
      const exe = proc.stat(`${base}/exe`);
      return { parent: Number(fields[1]), start: fields[19]!, argv, exe: `${exe.dev}:${exe.ino}` };
    };
    const outer = processInfo(pid);
    if (!isDevinProcess(outer.argv) || outer.argv[1] === "acp") throw unavailable();
    const children = new Set<number>();
    for (const tid of proc.list(`/proc/${pid}/task`)) {
      if (!/^\d+$/.test(tid)) throw unavailable();
      let listed: string;
      // a kernel without the children file cannot say which child holds the lock
      try { listed = proc.read(`/proc/${pid}/task/${tid}/children`); } catch { throw missing(); }
      for (const child of listed.trim().split(/\s+/).filter(Boolean)) {
        if (!/^\d+$/.test(child)) throw unavailable();
        children.add(Number(child));
      }
    }
    const proofs: DevinLockProof[] = [];
    // a child that could not be read may hold a lock of its own: the proof is then inconclusive
    let unread = false;
    for (const child of children) {
      let info: ReturnType<typeof processInfo>;
      try { info = processInfo(child); } catch { unread = true; continue; }
      if (info.parent !== pid) throw unavailable();
      if (!isDevinProcess(info.argv) || info.argv[1] !== "acp") continue;
      if (info.exe !== outer.exe) throw unavailable();
      for (const fd of proc.list(`/proc/${child}/fd`)) {
        if (!/^\d+$/.test(fd)) throw unavailable();
        const fdPath = `/proc/${child}/fd/${fd}`;
        const target = proc.link(fdPath);
        if (!target.startsWith(`${locks}/`)) continue;
        const name = basename(target);
        if (!name.endsWith(".lock")) throw unavailable();
        const session = name.slice(0, -5);
        if (!LOCK_ID.test(session) || target !== join(locks, `${session}.lock`)) throw unavailable();
        const file = proc.stat(target, false);
        const held = proc.stat(fdPath);
        if (!file.isFile() || file.uid !== proc.uid || file.dev !== held.dev || file.ino !== held.ino || proc.real(target) !== target) throw unavailable();
        const fdinfo = proc.read(`/proc/${child}/fdinfo/${fd}`);
        const lockLines = fdinfo.split("\n").filter((line) => line.startsWith("lock:"));
        const lock = new RegExp(`^lock:\\s+\\d+: FLOCK\\s+ADVISORY\\s+WRITE\\s+${child}\\s+[0-9a-fA-F]+:[0-9a-fA-F]+:${file.ino}\\s+0\\s+EOF\\s*$`);
        if (lockLines.length !== 1 || !lock.test(lockLines[0]!)) throw unavailable();
        // the store's own inode too: a database replaced between two proofs changes the binding
        proofs.push({ session, binding: JSON.stringify([pid, outer.start, outer.exe, child, info.start, file.dev, file.ino, fd, db.dev, db.ino]) });
      }
    }
    if (proofs.length > 1) throw unavailable();
    if (unread || proofs.length === 0) throw missing();
    const outerAfter = processInfo(pid);
    if (outerAfter.start !== outer.start || outerAfter.exe !== outer.exe || outerAfter.parent !== outer.parent || JSON.stringify(outerAfter.argv) !== JSON.stringify(outer.argv)) throw unavailable();
    const proof = proofs[0]!;
    return proof;
  } catch (error) {
    if (error instanceof DevinLockMissing) throw error;
    throw unavailable();
  }
}

/** Resolves the live lock or a non-conflicting explicit identity, never by directory recency. */
export function devinSessionForPane(pane: HerdrPane, panes: HerdrPane[], argv: string[], live?: string): string {
  if (pane.agent !== "devin") throw new ConversationUnavailable("no_session_id");
  const reported = pane.agent_session?.agent === "devin" && pane.agent_session.kind === "id"
    && typeof pane.agent_session.value === "string" && pane.agent_session.value.length > 0
    ? pane.agent_session.value : null;
  const resumed: string[] = [];
  for (let index = 1; index < argv.length; index++) {
    const arg = argv[index]!;
    if (arg === "--") break;
    if (arg.startsWith("--resume=")) {
      const id = arg.slice("--resume=".length);
      if (!id || id.startsWith("-")) throw new ConversationUnavailable("no_session_id");
      resumed.push(id);
    } else if (arg === "--resume" || arg === "-r") {
      const id = argv[index + 1];
      if (!id || id.startsWith("-")) throw new ConversationUnavailable("no_session_id");
      resumed.push(id);
      index++;
    }
  }
  const named = resumed[0] ?? null;
  if (resumed.some((id) => id !== named) || (reported !== null && named !== null && reported !== named)) {
    throw new ConversationUnavailable("no_session_id");
  }
  const explicit = reported ?? named;
  if (live !== undefined && explicit !== null && explicit !== live) throw new ConversationUnavailable("no_session_id");
  const selected = live ?? explicit;
  // no lock and no id the pane names: nothing proves which session the terminal shows, so none is guessed
  if (selected === null) throw new ConversationUnavailable("no_session_id", undefined, "devin_current_session_unverified");
  if (panes.some((other) => other.pane_id !== pane.pane_id && other.agent === "devin"
    && other.agent_session?.agent === "devin" && other.agent_session.kind === "id" && other.agent_session.value === selected)) {
    throw new ConversationUnavailable("no_session_id");
  }
  return selected;
}
