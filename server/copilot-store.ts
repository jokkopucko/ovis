import { constants, closeSync, fstatSync, lstatSync, openSync, opendirSync, readFileSync, readlinkSync, readSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import { createHash, randomUUID, type Hash } from "node:crypto";
import { readProcessBirth } from "./process-owner.ts";

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEADER_BYTES = 64 * 1024;
const MAX_DESCRIPTORS = 4096;
const LOG_WINDOW_BYTES = 16 * 1024 * 1024;
const LOG_HASH_BYTES = 64 * 1024 * 1024;
// Cover FAT's two-second granularity plus coarse wall-clock lag.
const LOG_TIMESTAMP_MARGIN_NS = 3_000_000_000n;
const LOG_NAME = /^process-\d+-(\d+)\.log$/;
const FOREGROUND_PREFIXES = ["Registering foreground session: ", "Unregistering foreground session: "] as const;
const FOREGROUND_EVENT = new RegExp(String.raw`^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d+Z \[INFO\] (${FOREGROUND_PREFIXES.join("|")})([\da-f-]{36})$`);
const VERIFIED_UNREGISTER = Symbol("verified unregister");
const LOG_READ_CHANGED = Symbol("log read changed");
interface ForegroundBinding { sessionId: string; generation: string }
interface ForegroundCheckpoint {
  dev: bigint; ino: bigint; path: string; size: number; observedSize: number; mtimeNs: bigint; ctimeNs: bigint; checkedAtNs: bigint; pendingSwitch: boolean;
  hash: Hash; epoch: string; binding: ForegroundBinding | null | undefined; unregistered: ForegroundBinding | null; readConflict?: true;
}
const foregroundCheckpoints = new Map<number, ForegroundCheckpoint>();
interface InitialLogRead { dev: bigint; ino: bigint; path: string; size: number; hash: string }
const foregroundLogProcesses = new Map<number, { started: string; observed: boolean; initialRead?: InitialLogRead }>();

/** Revalidate every consumed byte: unchanged boundary samples cannot prove an append. */
function logPrefix(fd: number, size: number): Hash | null {
  const bytes = Buffer.alloc(HEADER_BYTES);
  const hash = createHash("sha256");
  for (let position = 0; position < size; position += bytes.length) {
    const length = Math.min(bytes.length, size - position);
    if (readSync(fd, bytes, 0, length, position) !== length) return null;
    hash.update(bytes.subarray(0, length));
  }
  return hash;
}

/** The latest complete lifecycle event in the CLI's own open log, never the newest transcript. */
function loggedForeground(pid: number, logDirectories: readonly string[]): ForegroundBinding | null | undefined | typeof VERIFIED_UNREGISTER {
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = scanForegroundLog(pid, logDirectories);
    if (result !== LOG_READ_CHANGED) return result;
  }
  return undefined;
}

function scanForegroundLog(pid: number, logDirectories: readonly string[]): ForegroundBinding | null | undefined | typeof VERIFIED_UNREGISTER | typeof LOG_READ_CHANGED {
  if (process.platform !== "linux") return undefined;
  const birth = readProcessBirth(pid);
  if (birth.state !== "identified") return undefined;
  const started = birth.birth.value;
  let owner = foregroundLogProcesses.get(pid);
  if (owner?.started !== started) {
    foregroundLogProcesses.delete(pid);
    foregroundCheckpoints.delete(pid);
    owner = undefined;
  }
  if (owner === undefined) {
    if (foregroundLogProcesses.size >= 256) {
      for (const [previousPid, previous] of foregroundLogProcesses) {
        const current = readProcessBirth(previousPid);
        if (current.state === "absent" || (current.state === "identified" && current.birth.value !== previous.started)) {
          foregroundLogProcesses.delete(previousPid);
          foregroundCheckpoints.delete(previousPid);
        }
      }
    }
    // Dropping live denial state would make stale report/marker fallback eligible again.
    if (foregroundLogProcesses.size >= 256) return undefined;
    owner = { started, observed: false };
    foregroundLogProcesses.set(pid, owner);
  }
  const observedBefore = owner.observed;
  const observe = (): void => {
    owner.observed = true;
  };
  const unavailable = (): undefined => {
    delete owner.initialRead;
    const checkpoint = foregroundCheckpoints.get(pid);
    if (checkpoint) { checkpoint.binding = undefined; checkpoint.unregistered = null; }
    return undefined;
  };
  const directory = opendirSync(`/proc/${pid}/fd`);
  let found: ForegroundBinding | null | undefined | typeof VERIFIED_UNREGISTER = null;
  let logFound = false;
  let count = 0;
  try {
    for (let descriptor = directory.readSync(); descriptor; descriptor = directory.readSync()) {
      if (++count > MAX_DESCRIPTORS) return unavailable();
      let target: string;
      try { target = readlinkSync(`/proc/${pid}/fd/${descriptor.name}`); }
      catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ENOENT") continue;
        if (code === "EINTR" || code === "EAGAIN" || code === "EBUSY" || code === "EIO" || code === "ESTALE") {
          // Keep only the prefix to revalidate, never permission to serve a failed scan.
          const cached = foregroundCheckpoints.get(pid);
          if (cached) cached.readConflict = true;
          return LOG_READ_CHANGED;
        }
        return unavailable();
      }
      if (target.endsWith(" (deleted)") && LOG_NAME.test(basename(target.slice(0, -10)))) {
        observe();
        return unavailable();
      }
      if (!logDirectories.some((path) => dirname(target) === path) || LOG_NAME.exec(basename(target))?.[1] !== String(pid)) continue;
      observe();
      if (logFound) return unavailable();
      logFound = true;
      try {
        if (realpathSync(target) !== target) return unavailable();
        const fd = openSync(`/proc/${pid}/fd/${descriptor.name}`, constants.O_RDONLY | constants.O_NONBLOCK);
        try {
          const checkedAtNs = BigInt(Date.now()) * 1_000_000n;
          const stat = fstatSync(fd, { bigint: true });
          const named = statSync(target, { bigint: true });
          if (!stat.isFile() || stat.dev !== named.dev || stat.ino !== named.ino) return unavailable();
          if (stat.size > LOG_HASH_BYTES) return unavailable();
          const size = Number(stat.size);
          const cached = foregroundCheckpoints.get(pid);
          // A same-size rewrite can share both timestamps with this check.
          // Only a check already outside that tick can attest unchanged bytes.
          if (!cached?.readConflict && cached?.dev === stat.dev && cached.ino === stat.ino && cached.path === target
            && cached.observedSize === size && cached.mtimeNs === stat.mtimeNs && cached.ctimeNs === stat.ctimeNs
            && checkedAtNs >= cached.checkedAtNs
            && cached.checkedAtNs - stat.mtimeNs >= LOG_TIMESTAMP_MARGIN_NS
            && cached.checkedAtNs - stat.ctimeNs >= LOG_TIMESTAMP_MARGIN_NS) {
            found = cached.pendingSwitch ? undefined
              : cached.binding === undefined && cached.unregistered ? VERIFIED_UNREGISTER : cached.binding;
            continue;
          }
          const prefix = cached && size >= cached.size ? logPrefix(fd, cached.size) : null;
          const same = cached?.dev === stat.dev && cached.ino === stat.ino && cached.path === target
            && size >= cached.size && size - cached.size <= LOG_WINDOW_BYTES
            && (size !== cached.size || (stat.mtimeNs === cached.mtimeNs && stat.ctimeNs === cached.ctimeNs))
            && prefix?.copy().digest("hex") === cached.hash.copy().digest("hex");
          const epoch = same ? cached.epoch : randomUUID();
          const start = same ? cached.size : Math.max(0, size - LOG_WINDOW_BYTES);
          const bytes = Buffer.alloc(size - start);
          const read = readSync(fd, bytes, 0, bytes.length, start);
          const initial = owner.initialRead;
          // A raced bootstrap is still initial only while the bytes this read returned begin with
          // every byte already seen, in the same process-owned file. Judged from those bytes, not
          // a separate read, so a rewrite between two reads cannot pass. A lost/replaced log revokes it.
          const initialContinues = initial !== undefined && start === 0 && initial.dev === stat.dev && initial.ino === stat.ino
            && initial.path === target && read >= initial.size
            && createHash("sha256").update(bytes.subarray(0, initial.size)).digest("hex") === initial.hash;
          const hash = same ? prefix : logPrefix(fd, start);
          const after = fstatSync(fd, { bigint: true });
          if (read !== bytes.length || hash === null || after.size !== stat.size
            || after.mtimeNs !== stat.mtimeNs || after.ctimeNs !== stat.ctimeNs) {
            if (cached) cached.readConflict = true;
            // A later raced read extends the protected prefix while it still starts with the first one,
            // so a rewrite back to an earlier prefix cannot drop lifecycle lines read in between.
            else if ((!observedBefore || initialContinues) && start === 0 && read === bytes.length && hash !== null) {
              owner.initialRead = { dev: stat.dev, ino: stat.ino, path: target, size,
                hash: hash.copy().update(bytes).digest("hex") };
            } else delete owner.initialRead;
            return LOG_READ_CHANGED;
          }
          const text = bytes.subarray(0, read).toString("utf8");
          const skip = start === 0 || same ? 0 : text.indexOf("\n") + 1;
          const complete = text.slice(skip, text.lastIndexOf("\n") + 1);
          if (start > 0 && !complete && !same) return unavailable();
          // Only a complete initial log without lifecycle evidence permits marker/report fallback.
          let selected = same ? cached.binding : start === 0 && (!observedBefore || initialContinues) ? null : undefined;
          let unregistered = same ? cached.unregistered : null;
          let position = start + Buffer.byteLength(text.slice(0, skip));
          for (const line of complete.split("\n")) {
            const match = FOREGROUND_EVENT.exec(line);
            if (match) {
              if (!SESSION_ID.test(match[2]!)) return unavailable();
              if (match[1] === FOREGROUND_PREFIXES[0]) {
                selected = { sessionId: match[2]!, generation: `${pid}:${stat.dev}:${stat.ino}:${epoch}:${position}` };
                unregistered = null;
              } else {
                // A legacy parent's complete log may first name its session when releasing it to a child.
                unregistered = selected && selected.sessionId === match[2] ? selected : selected === null
                  ? { sessionId: match[2]!, generation: `${pid}:${stat.dev}:${stat.ino}:${epoch}:${position}` } : null;
                selected = undefined;
              }
            }
            position += Buffer.byteLength(line) + 1;
          }
          const completeBytes = bytes.lastIndexOf(0x0a) + 1;
          hash.update(bytes.subarray(0, completeBytes));
          const tail = text.slice(text.lastIndexOf("\n") + 1);
          // Cache the visible result separately from the last complete binding:
          // an unchanged partial timestamp or switch must remain unavailable.
          const message = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d+Z \[INFO\] (.*)$/.exec(tail)?.[1];
          const pendingSwitch = !!tail && (selected === undefined || (/^\d/.test(tail) && (message === undefined
            || FOREGROUND_PREFIXES.some((event) => event.startsWith(message) || message.startsWith(event)))));
          foregroundCheckpoints.set(pid, {
            dev: stat.dev, ino: stat.ino, path: target, size: start + completeBytes,
            observedSize: size, mtimeNs: stat.mtimeNs, ctimeNs: stat.ctimeNs, checkedAtNs, pendingSwitch, hash, epoch, binding: selected, unregistered,
          });
          delete owner.initialRead;
          found = pendingSwitch ? undefined : selected === undefined && unregistered ? VERIFIED_UNREGISTER : selected;
        } finally { closeSync(fd); }
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ENOENT" || code === "EINTR" || code === "EAGAIN" || code === "EBUSY" || code === "EIO" || code === "ESTALE") {
          // Retain revalidation context, not permission to serve the old binding.
          const cached = foregroundCheckpoints.get(pid);
          if (cached) cached.readConflict = true;
          return LOG_READ_CHANGED;
        }
        return unavailable();
      }
    }
  } finally { directory.closeSync(); }
  return !logFound && owner.observed ? unavailable() : found;
}

/** Pin one regular canonical file; callers must close the descriptor after reading. */
export function openCopilotFile(file: string): number {
  if (realpathSync(file) !== file) throw new Error("Copilot transcript path is not canonical");
  const fd = openSync(file, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0) | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = fstatSync(fd);
    const pathStat = statSync(file);
    if (!stat.isFile() || pathStat.dev !== stat.dev || pathStat.ino !== stat.ino) {
      throw new Error("Copilot transcript is not a regular canonical file");
    }
    const session = basename(dirname(file));
    if (SESSION_ID.test(session)) {
      const bytes = Buffer.alloc(Math.min(stat.size, HEADER_BYTES));
      const length = readSync(fd, bytes, 0, bytes.length, 0);
      const newline = bytes.indexOf(0x0a);
      if (newline < 0 || newline >= length) throw new Error("Copilot transcript header is incomplete");
      const header = JSON.parse(bytes.subarray(0, newline).toString("utf8")) as { type?: unknown; data?: { sessionId?: unknown } };
      if (header?.type !== "session.start" || header.data?.sessionId !== session) throw new Error("Copilot transcript header does not match its session");
    }
    return fd;
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}

/** Only an actual PID-owned, open and canonical marker proves this process still holds a session. */
function scanHeldSessions(pid: number, store: string): Set<string> | null | undefined {
  const sessions = new Set<string>();
  const directory = opendirSync(`/proc/${pid}/fd`);
  let count = 0;
  try {
    for (let fd = directory.readSync(); fd; fd = directory.readSync()) {
      if (++count > MAX_DESCRIPTORS) return null;
      let target: string;
      try { target = readlinkSync(`/proc/${pid}/fd/${fd.name}`); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        return null;
      }
      const path = relative(store, target);
      if (path === ".." || path.startsWith(`..${sep}`) || isAbsolute(path)) continue;
      const parts = path.split(sep);
      if (parts.length !== 2 || !SESSION_ID.test(parts[0]!) || parts[1] !== `inuse.${pid}.hold`) {
        if (target.includes("inuse.") || target.includes(".hold")) return null;
        continue;
      }
      if (realpathSync(join(store, parts[0]!)) !== join(store, parts[0]!)
        || realpathSync(target) !== target) return null;
      const marker = statSync(target);
      const open = statSync(`/proc/${pid}/fd/${fd.name}`);
      if (!marker.isFile() || !open.isFile() || marker.dev !== open.dev || marker.ino !== open.ino) return null;
      sessions.add(parts[0]!);
    }
  } finally { directory.closeSync(); }
  return sessions;
}

/** A disappearing descriptor invalidates that scan; retry once, then fall back. */
export function heldSessions(pid: number, store: string): Set<string> | null {
  for (let attempt = 0; attempt < 2; attempt++) {
    const sessions = scanHeldSessions(pid, store);
    if (sessions !== undefined) return sessions;
  }
  return null;
}

type ProcessSession = { sessionId: string; path: string } & (
  | { logged: true; generation: string }
  | { logged: false }
);

/** Resolve once per validation pass; never reuse this evidence across a transcript read. */
export function copilotProcessSession(environment: readonly string[] | null, argv: readonly string[], pid: number, mode: "current" | "unregistered" = "current"): ProcessSession | null {
  if (environment === null || !Number.isSafeInteger(pid) || pid < 1) return null;
  const values = (key: string) => environment.filter((item) => item.startsWith(`${key}=`)).map((item) => item.slice(key.length + 1));
  const home = values("HOME");
  const explicit = values("COPILOT_HOME");
  if (home.length > 1 || explicit.length > 1) return null;
  const config: string[] = [];
  for (let i = 1; i < argv.length; i++) {
    const option = argv[i]!;
    if (option === "--") break;
    if (option.startsWith("--config-dir=")) config.push(option.slice("--config-dir=".length));
    else if (option === "--config-dir") config.push(argv[++i] ?? "");
  }
  if (config.length > 1) return null;
  const chosen = config[0] ?? explicit[0] ?? (home[0] ? join(home[0], ".copilot") : "");
  if (!isAbsolute(chosen)) return null;
  try {
    const canonicalHome = realpathSync(chosen);
    if (!statSync(canonicalHome).isDirectory()) return null;
    const store = join(canonicalHome, "session-state");
    if (realpathSync(store) !== store) return null;
    const logOptions: string[] = [];
    for (let i = 1; i < argv.length; i++) {
      if (argv[i] === "--") break;
      if (argv[i] === "--log-dir") logOptions.push(argv[++i] ?? "");
      else if (argv[i]?.startsWith("--log-dir=")) logOptions.push(argv[i]!.slice("--log-dir=".length));
    }
    if (logOptions.length > 1 || (logOptions.length && !isAbsolute(logOptions[0]!))) return null;
    const logs = logOptions.length ? logOptions : [join(canonicalHome, "logs"), ...(home[0] ? [join(home[0], ".copilot", "logs")] : [])];
    const foreground = loggedForeground(pid, logs);
    if (mode === "unregistered") {
      const checkpoint = foregroundCheckpoints.get(pid);
      const ended = foreground === VERIFIED_UNREGISTER && checkpoint ? checkpoint.unregistered : null;
      if (!ended) return null;
      const directory = join(store, ended.sessionId);
      if (realpathSync(directory) !== directory) return null;
      return { ...ended, path: join(directory, "events.jsonl"), logged: true };
    }
    if (foreground === undefined || foreground === VERIFIED_UNREGISTER) return null;
    if (foreground !== null) {
      const directory = join(store, foreground.sessionId);
      if (realpathSync(directory) !== directory) return null;
      return { ...foreground, path: join(directory, "events.jsonl"), logged: true };
    }
    const held = heldSessions(pid, store);
    if (held === null || held.size !== 1) return null;
    const session = [...held][0]!;
    const directory = join(store, session);
    if (realpathSync(directory) !== directory) return null;
    return { sessionId: session, path: join(directory, "events.jsonl"), logged: false };
  } catch { return null; }
}

interface HandoffProcess { pid: number; argv: readonly string[] }
interface LinuxGroup { parent: number; group: number; session: number; terminal: number; foreground: number; birth: number }

function linuxGroup(pid: number): LinuxGroup | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(") ") + 2).split(" ");
    const [parent, group, session, terminal, foreground, birth] = [1, 2, 3, 4, 5, 19].map((index) => Number(fields[index]));
    if (![parent, group, session, terminal, foreground, birth].every(Number.isSafeInteger)) return null;
    return { parent: parent!, group: group!, session: session!, terminal: terminal!, foreground: foreground!, birth: birth! };
  } catch { return null; }
}

function onlyOption(argv: readonly string[], name: string, expected: string): boolean {
  const values: string[] = [];
  for (let i = 1; i < argv.length; i++) {
    if (argv[i] === "--") break;
    if (argv[i] === name) values.push(argv[++i] ?? "");
    else if (argv[i]?.startsWith(`${name}=`)) values.push(argv[i]!.slice(name.length + 1));
  }
  return values.length === 1 && values[0] === expected;
}

/** An unregistered parent may hand its reported session to its direct, foreground child. */
export function copilotHandoffSession(
  parent: HandoffProcess, child: HandoffProcess, report: string, groupId: number | null | undefined, tty: string | null | undefined,
  environment: (pid: number) => readonly string[] | null,
): ProcessSession | null {
  if (process.platform !== "linux" || !SESSION_ID.test(report) || !Number.isSafeInteger(parent.pid)
    || !Number.isSafeInteger(child.pid) || !groupId || parent.pid === child.pid
    || !onlyOption(parent.argv, "--resume", report) || !onlyOption(child.argv, "--session-id", report)) return null;
  const beforeParent = linuxGroup(parent.pid);
  const beforeChild = linuxGroup(child.pid);
  if (!beforeParent || !beforeChild || beforeChild.parent !== parent.pid
    || beforeParent.birth > beforeChild.birth || beforeParent.terminal <= 0
    || beforeParent.terminal !== beforeChild.terminal || beforeParent.session !== beforeChild.session
    || beforeParent.group !== beforeChild.group || beforeParent.group !== groupId
    || beforeParent.foreground !== groupId || beforeChild.foreground !== groupId) return null;
  if (tty) {
    try {
      const terminal = realpathSync(tty);
      if (realpathSync(`/proc/${parent.pid}/fd/0`) !== terminal || realpathSync(`/proc/${child.pid}/fd/0`) !== terminal) return null;
    } catch { return null; }
  }
  const ended = copilotProcessSession(environment(parent.pid), parent.argv, parent.pid, "unregistered");
  const held = copilotProcessSession(environment(child.pid), child.argv, child.pid);
  const childLog = foregroundCheckpoints.get(child.pid);
  if (!ended?.logged || !held || held.logged || !foregroundLogProcesses.get(child.pid)?.observed
    || !childLog || childLog.binding !== null || childLog.pendingSwitch
    || ended.sessionId !== report || held.sessionId !== report || ended.path !== held.path) return null;
  const afterParent = linuxGroup(parent.pid);
  const afterChild = linuxGroup(child.pid);
  if (!afterParent || !afterChild || afterParent.birth !== beforeParent.birth || afterChild.birth !== beforeChild.birth
    || afterChild.parent !== parent.pid || afterParent.group !== groupId || afterChild.group !== groupId
    || afterParent.terminal !== beforeParent.terminal || afterChild.terminal !== beforeChild.terminal
    || afterParent.foreground !== groupId || afterChild.foreground !== groupId) return null;
  return { ...held, logged: true, generation: `handoff:${parent.pid}:${ended.generation}:${child.pid}:${afterChild.birth}` };
}

/** Only the reported session, or the process-owned lifecycle selection. */
export function copilotTranscriptFile(session: unknown, held: ProcessSession | null): string | null {
  if (held === null || (session === null ? !held.logged : typeof session !== "string" || !SESSION_ID.test(session) || held.sessionId !== session)) return null;
  try {
    const fd = openCopilotFile(held.path);
    try {
      return held.path;
    } finally { closeSync(fd); }
  } catch { return null; }
}

/** A process-held session with no transcript yet, never permission to read unreported history. */
export function copilotUnwrittenSession(held: ProcessSession | null, argv: readonly string[]): { sessionId: string; path: string } | null {
  if (held === null) return null;
  if (!held.logged && copilotExplicitResume(argv)) return null;
  try {
    lstatSync(held.path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { sessionId: held.sessionId, path: held.path };
  }
  return null;
}

export function copilotExplicitResume(argv: readonly string[]): boolean {
  return argv.some((word) => word === "--continue" || word === "-r" || word === "--resume" || word.startsWith("--resume="));
}
