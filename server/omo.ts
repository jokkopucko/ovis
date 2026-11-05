import { constants, fstatSync, closeSync, openSync, readdirSync, readFileSync, readlinkSync, readSync, realpathSync } from "node:fs";
import { uptime } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { HerdrPane } from "../shared/protocol.ts";
import { herdrRpc } from "./herdr/client.ts";
import { recentProcessTable } from "./gjc-runtime.ts";
import { processStartedAt, processStartedAtAsync } from "./process-start.ts";
import { descendantProcesses, type ProcessRow } from "./windows-processes.ts";
import { userHome } from "./user-home.ts";

const OMO_PROCESS = /(^|\/)omo(\.js)?$|\/omo-ai\//;
/** node and bun run a script: the program is then the script, the first word that is not a flag */
const JS_RUNTIME = /(^|\/)(node|nodejs|bun)$/;
/** omo's engine, run by its launcher; it is omo only with omo-ai's plugin as an extension */
const SENPI_ENTRY = /\/@code-yeongyu\/senpi\/dist\/(bundle\/)?cli\.js$/;
const OMO_EXTENSION = /\/omo-ai\/plugin\/?$/;
/**
 * Only the program counts: argv[0] (omo's native binary, its SDK's claude), or the script a
 * JS runtime runs (`bun …/omo-ai/…/cli.js`, `node …/bin/omo`). An omo-ai path handed to another
 * program (`grep -q …/omo-ai/x`, `cat …/bin/omo`) is that program's argument, not omo. The word
 * is one path: a PATH list that names omo-ai's bin directory (`printf %s\n $PATH` in an rc
 * file) made a fresh shell pass for omo for a moment.
 *
 * A global bun install hoists omo's engine next to omo-ai instead of inside it
 * (`bun …/node_modules/@code-yeongyu/senpi/dist/bundle/cli.js --extension …/node_modules/omo-ai/plugin`):
 * the script is then senpi's own entry, and omo-ai shows only as the extension it loads.
 * Words after a `--` are the prompt, not options: senpi loads no extension from them.
 */
export function isOmoProcess(argv: readonly string[]): boolean {
  const words = argv.map(windowsPath);
  const runtime = JS_RUNTIME.test(words[0] ?? "");
  const at = runtime ? words.slice(1).findIndex((word) => !word.startsWith("-")) + 1 : 0;
  const program = at > 0 || !runtime ? words[at] : undefined;
  if (program === undefined || isPathList(program)) return false;
  if (OMO_PROCESS.test(program)) return true;
  if (!runtime || !SENPI_ENTRY.test(program)) return false;
  const prompt = words.indexOf("--", at);
  const options = prompt === -1 ? words : words.slice(0, prompt);
  return options.some((word, index) => options[index - 1] === "--extension" && !isPathList(word) && OMO_EXTENSION.test(word));
}

/**
 * A Windows PC's process words read as the same paths: backslashes as slashes, and a program's
 * .exe/.cmd dropped (`C:\Users\me\.bun\bin\bun.exe` is bun, `omo.cmd` is omo).
 */
function windowsPath(word: string): string {
  if (!/\\|^[A-Za-z]:[\\/]|\.(exe|cmd|bat)$/i.test(word)) return word;
  return word.replace(/\\/g, "/").replace(/\.(exe|cmd|bat)$/i, "");
}

/** A PATH-like list (`a:b`), not one path: a drive's colon (`C:/…`) does not make one. */
function isPathList(word: string): boolean {
  return word.replace(/^[A-Za-z]:\//, "").includes(":");
}

export interface OmoCandidate { path: string; id: string; createdAt: number | null; store?: string }
export interface OmoRuntime {
  paneId: string;
  startedAt: number | null;
  /** Exact native session evidence, before considering a cwd/time inference. */
  paths: string[];
  ids: string[];
  /**
   * The canonical sessions roots this pane's own processes write to. A path or id
   * evidence matches only inside them: the same session id in another pane's store is
   * another session. Unset means unscoped (older callers and pure-selection tests).
   */
  stores?: string[];
  /**
   * The sessions the pane's processes hold now, each bound to the canonical store that
   * holds it (undefined: an unscoped caller claim matching by id alone; null: the store
   * could not be resolved, so the claim matches no file). A claim whose file is missing
   * or unreadable still binds, so it never resolves to another store's same-id session.
   */
  claims?: { id: string; store?: string | null }[];
  /** Recognized only by verified native holders: hints and cwd/time inference never apply. */
  custom?: boolean;
  ambiguous?: boolean;
}

/** A session is never selected by mtime: tool activity is not evidence of pane ownership. */
export function selectOmoTranscript(paneId: string, candidates: OmoCandidate[], runtimes: OmoRuntime[], now = Date.now()): string | null {
  // A structured held claim matches only inside the store that holds it (an unresolved
  // store matches nothing); a legacy unscoped claim still matches by id alone.
  const held = (runtime: OmoRuntime, file: OmoCandidate): boolean => (runtime.claims ?? []).some((claim) =>
    claim.id === file.id && (claim.store === undefined || claim.store === file.store));
  const direct = (runtime: OmoRuntime): OmoCandidate[] => candidates.filter((file) =>
    (runtime.stores === undefined || (file.store !== undefined && runtime.stores.includes(file.store)))
    && (runtime.paths.includes(file.path) || runtime.ids.includes(file.id) || held(runtime, file)));
  const target = runtimes.find((runtime) => runtime.paneId === paneId);
  if (!target || target.ambiguous) return null;
  const owned = (file: OmoCandidate) => target.stores === undefined || (file.store !== undefined && target.stores.includes(file.store));
  const exact = direct(target);
  const claimed = new Set(runtimes.filter((runtime) => runtime !== target).flatMap((runtime) => direct(runtime).map((file) => file.path)));
  if (target.paths.length > 0 || target.ids.length > 0) {
    if (exact.length !== 1 || claimed.has(exact[0]!.path)) return null;
    // A launch ID can outlive /new. Without a current descriptor, a later unclaimed
    // session makes that hint ambiguous rather than pinning the old conversation.
    if (!target.paths.includes(exact[0]!.path) && target.startedAt !== null && candidates.some((file) =>
      owned(file) && file.path !== exact[0]!.path && !claimed.has(file.path) && file.createdAt !== null && file.createdAt > target.startedAt! + 1000 && file.createdAt <= now + 1000)) return null;
    return exact[0]!.path;
  }
  // A held claim whose file is missing or unreadable still binds its id to its own
  // store: it names that session alone — never another store's same-id file, and no
  // cwd/time inference.
  if (target.claims !== undefined && target.claims.length > 0) return null;
  // A custom runtime is only ever its holders: no cwd/time inference, no launch hints.
  if (target.custom) return null;
  // A second process (or an unreadable peer) sharing cwd blocks inference entirely.
  if (runtimes.length !== 1 || target.startedAt === null) return null;
  const fresh = candidates.filter((file) => owned(file) && file.createdAt !== null && file.createdAt >= target.startedAt! - 1000 && file.createdAt <= now + 1000);
  return fresh.length === 1 ? fresh[0]!.path : null;
}

/** `root` is already canonical: one realpath per store, not one per candidate and store */
function inStore(path: string, root: string): boolean {
  const inside = relative(root, path);
  return !!inside && inside !== ".." && !inside.startsWith(`..${sep}`) && !isAbsolute(inside);
}
function canonicalRoots(roots: readonly string[]): string[] {
  return roots.flatMap((root) => { try { return [realpathSync(root)]; } catch { return []; } });
}

function candidate(path: string, roots: readonly string[], cwd: string): OmoCandidate | null {
  let fd: number | undefined;
  try {
    const canonical = realpathSync(path);
    const root = roots.find((root) => inStore(canonical, root));
    if (!canonical.endsWith(".jsonl") || root === undefined) return null;
    fd = openSync(canonical, constants.O_RDONLY | constants.O_NONBLOCK);
    if (!fstatSync(fd).isFile()) return null;
    const bytes = Buffer.alloc(4096);
    const length = readSync(fd, bytes, 0, bytes.length, 0);
    const header = JSON.parse(bytes.subarray(0, length).toString("utf8").split("\n")[0]!);
    if (header?.type !== "session" || header.cwd !== cwd || typeof header.id !== "string") return null;
    const timestamp = typeof header.timestamp === "string" ? Date.parse(header.timestamp) : NaN;
    return { path: canonical, id: header.id, createdAt: Number.isFinite(timestamp) ? timestamp : null, store: root };
  } catch { return null; }
  finally { if (fd !== undefined) closeSync(fd); }
}

/**
 * omo's engine (senpi) keeps its sessions under its agent directory, which the first of
 * these that is set moves, as pi's PI_CODING_AGENT_DIR moves pi's: a launcher that gives
 * each profile its own state (`OMO_CODING_AGENT_DIR=~/.local/state/<profile>/.omo/agent`)
 * writes no session under ~/.omo, so the chat found none there and showed nothing.
 */
const AGENT_DIR_ENV = ["OMO_CODING_AGENT_DIR", "SENPI_CODING_AGENT_DIR", "PI_CODING_AGENT_DIR"];
export const defaultOmoAgentDir = (home: string) => join(home, ".omo", "agent");

/** The agent directory of one omo process, from its environment (null when unreadable: the default). */
export function omoAgentDir(environ: readonly string[] | null, home: string, cwd: string): string {
  for (const name of AGENT_DIR_ENV) {
    const entry = environ?.find((word) => word.startsWith(`${name}=`));
    if (entry === undefined) continue;
    // senpi takes the first one set; an empty one leaves its default
    const value = entry.slice(name.length + 1);
    if (!value) break;
    const expanded = value === "~" ? home : value.startsWith("~/") ? join(home, value.slice(2)) : value;
    return resolve(cwd, expanded);
  }
  return defaultOmoAgentDir(home);
}

/** A process's environment as it started, where the system tells it (Linux). */
export function processEnviron(pid: number): string[] | null {
  try { return readFileSync(`/proc/${pid}/environ`, "utf8").split("\0"); } catch { return null; }
}

/**
 * Where a process actually runs: the cwd herdr reports for the process itself, then
 * the OS's own answer (Linux), then the caller's (the pane's). "" when no source can
 * say — a custom identity cannot be verified without it. A pane cwd goes stale the
 * moment a process moves, so it must never override either process-specific source.
 */
function processCwd(process: { pid: number; cwd?: string }, cwd: string): string {
  if (typeof process.cwd === "string" && process.cwd) return process.cwd;
  try { return readlinkSync(`/proc/${process.pid}/cwd`); } catch { return cwd; }
}

/**
 * Is this process omo, and which store does its session live in? Two proofs:
 * - legacy: the program it runs is omo's (isOmoProcess). Its environment still moves
 *   the store the same way, and its holders still name the session it owns now;
 * - custom: the argv says nothing (a launcher's own name is not evidence either way),
 *   so only verified native session ownership counts: an OMO-specific store — an
 *   explicit `OMO_CODING_AGENT_DIR` entry (an empty one means the default) or the
 *   resolved store being the default `~/.omo/agent`; a store moved only by SENPI's or
 *   pi's variable is not an omo identity — plus a live OS start time and at least one
 *   holder record for this exact pid that names a matching start and the process's
 *   own cwd. An env marker alone, an argv mention, a stale or reused pid, a wrong cwd
 *   or an unreadable start never identify a custom omo, and nothing here depends on
 *   the model it runs.
 */
export function omoProcessIdentity(
  process: { pid: number; argv?: string[]; cwd?: string },
  cwd: string,
  home: string,
  environOf: (pid: number) => readonly string[] | null = processEnviron,
  startOf: (pid: number) => number | null = processStartedAt,
): { agentDir: string; heldIds: string[]; custom: boolean; held: boolean } | null {
  const dir = processCwd(process, cwd);
  const environ = environOf(process.pid);
  const agentDir = omoAgentDir(environ, home, dir);
  const startedAt = startOf(process.pid);
  if (isOmoProcess(process.argv ?? [])) {
    const heldIds = heldSessionIds(sessionDir(dir, agentDir), process.pid, startedAt);
    // a holder counts only while this pid's start is readable: without it (Windows) a crashed omo's
    // record could name a pid another process reuses
    return { agentDir, heldIds, custom: false, held: heldIds.length > 0 && startedAt !== null };
  }
  if (!dir || startedAt === null) return null;
  const omoStore = environ?.some((word) => word.startsWith("OMO_CODING_AGENT_DIR=")) === true || agentDir === defaultOmoAgentDir(home);
  if (!omoStore) return null;
  const heldIds = heldSessionIds(sessionDir(dir, agentDir), process.pid, startedAt, dir);
  return heldIds.length === 0 ? null : { agentDir, heldIds, custom: true, held: true };
}

/**
 * omo's engine (senpi, core/session-manager.js) names a cwd's session folder exactly so: the
 * leading slash dropped, then every slash, backslash and colon a dash. A Windows cwd
 * (`C:\\Users\\me\\app`) is `--C--Users-me-app--`; the slash-only rule this used missed it.
 */
export function omoSessionFolder(cwd: string): string {
  return `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
}
const sessionDir = (cwd: string, agentDir: string) => join(agentDir, "sessions", omoSessionFolder(cwd));

// A holder's start is floored to the second (as `ps -o lstart`), ours is in clock ticks. omo
// derives it from its own clock (now minus its runtime's uptime), and a runtime that comes up
// late on a busy machine reads a start seconds after the kernel's (7 s seen, #2281). A reused
// pid's leftover always starts earlier, so a record may start up to a minute late, but only when
// it names this host's boot as its own (`bootAtMs`, which omo reads as we do here): a record from
// another host sharing the store, from before a clock step, or without a boot keeps the 3 s bound
// both ways.
const HOLDER_START_TOLERANCE_MS = 3000;
const HOLDER_START_LATE_MS = 60_000;

/** This host's boot instant as omo records it: the wall clock minus uptime, in whole seconds. null if unreadable. */
export function hostBootAt(now = Date.now()): number | null {
  try {
    return Math.round((now - uptime() * 1000) / 1000) * 1000;
  } catch {
    return null;
  }
}

/**
 * omo keeps no descriptor on its session file, but every process with a session open
 * publishes <session dir>/session-holders/<encoded id>/<pid>.json and removes it on
 * release (/new, /resume, exit). A crashed process leaves its record behind, so one
 * counts only for the live pid it names and, where our start time is readable, only
 * if it started when that pid did: a reused pid starts later than the crashed holder,
 * so a record from before this pid's start is refused, and one up to a minute after it
 * is this process's own, read late, when it was written on this host since its boot.
 */
export function heldSessionIds(dir: string, pid: number, startedAt: number | null, cwd?: string, bootAt: number | null = hostBootAt()): string[] {
  const holders = join(dir, "session-holders");
  let names: string[] = [];
  try { names = readdirSync(holders); } catch { return []; }
  const ids: string[] = [];
  for (const name of names.slice(0, 4096)) {
    try {
      const record = JSON.parse(readFileSync(join(holders, name, `${pid}.json`), "utf8"));
      if (record?.pid !== pid) continue;
      if (cwd !== undefined && record.cwd !== cwd) continue;
      if (startedAt !== null) {
        if (typeof record.processStartedAtMs !== "number") continue;
        const thisBoot = bootAt !== null && typeof record.bootAtMs === "number" && Math.abs(record.bootAtMs - bootAt) <= HOLDER_START_TOLERANCE_MS;
        const lag = record.processStartedAtMs - startedAt;
        if (lag < -HOLDER_START_TOLERANCE_MS || lag > (thisBoot ? HOLDER_START_LATE_MS : HOLDER_START_TOLERANCE_MS)) continue;
      }
      ids.push(decodeURIComponent(name));
    } catch { /* this pid holds nothing here, or the record is unreadable */ }
  }
  return ids;
}

/**
 * A runtime as the sessions its processes hold now (`held`, by id) tell it: the held one
 * outranks a launch --session-id and herdr's session path or id, which /new leaves behind.
 * omo writes a session's file with its first message, so one held with no file yet is a
 * conversation not begun (/new, nothing typed since): it names that id alone, never a file
 * from before.
 */
export function heldRuntime(runtime: OmoRuntime, held: readonly (string | { id: string; store: string | null })[], files: readonly OmoCandidate[]): OmoRuntime {
  if (held.length === 0) return runtime;
  const claims: { id: string; store?: string | null }[] = held.map((heldId) => typeof heldId === "string" ? { id: heldId, store: undefined } : heldId);
  const ambiguous = new Set(claims.map((claim) => JSON.stringify([claim.store, claim.id]))).size > 1 || runtime.ambiguous === true;
  // A held id counts only in the store that holds it: another store's file of the same
  // id is a different session that happens to share the name. The claims stay on the
  // runtime so a missing or unreadable header still binds; only an unscoped claim — a
  // caller that knows no store — joins the store-wide id evidence.
  const current = files.filter((file) => claims.some((claim) => claim.id === file.id && (claim.store === undefined || file.store === claim.store))).map((file) => file.path);
  const ids = current.length > 0 ? [] : [...new Set(claims.filter((claim) => claim.store === undefined).map((claim) => claim.id))];
  return { ...runtime, paths: current, ids, claims, ambiguous };
}

/** When the process that holds a session here started, by its own record: where the system does not tell (macOS). */
export function holderStartedAt(dir: string, pid: number): number | null {
  const holders = join(dir, "session-holders");
  let names: string[] = [];
  try { names = readdirSync(holders); } catch { return null; }
  for (const name of names.slice(0, 4096)) {
    try {
      const record = JSON.parse(readFileSync(join(holders, name, `${pid}.json`), "utf8"));
      if (record?.pid === pid && typeof record.processStartedAtMs === "number") return record.processStartedAtMs;
    } catch { /* this pid holds nothing here */ }
  }
  return null;
}

/** The earliest start known among a pane's OmO processes: a helper that keeps no record of its own (an MCP child) says nothing against the engine's. */
export function earliestStart(starts: readonly (number | null)[]): number | null {
  const known = starts.filter((start): start is number => start !== null);
  return known.length > 0 ? Math.min(...known) : null;
}

/** Bounded, canonical store reads; exact descriptor paths can live outside the cwd slug. */
export function omoCandidates(cwd: string, home: string, exactPaths: string[] = [], agentDirs: readonly string[] = [defaultOmoAgentDir(home)]): OmoCandidate[] {
  const roots = canonicalRoots(agentDirs.map((agentDir) => join(agentDir, "sessions")));
  const paths = new Set(exactPaths);
  for (const agentDir of new Set(agentDirs)) {
    const dir = sessionDir(cwd, agentDir);
    let names: string[] = [];
    try { names = readdirSync(dir); } catch { /* only explicit evidence may remain */ }
    // Never choose a subset when the directory is too large to inspect safely.
    if (names.length <= 4096) for (const name of names) if (name.endsWith(".jsonl")) paths.add(join(dir, name));
  }
  const found = new Map<string, OmoCandidate>();
  for (const path of paths) {
    const file = candidate(path, roots, cwd);
    if (file) found.set(file.path, file);
  }
  return [...found.values()];
}

function resumedIds(argv: string[]): string[] {
  const result: string[] = [];
  for (let at = 0; at < argv.length; at++) {
    const word = argv[at]!;
    const id = word.startsWith("--session-id=") ? word.slice(13) : word === "--session-id" ? argv[at + 1] : undefined;
    if (id && /^[A-Za-z0-9_-]{8,128}$/.test(id)) result.push(id);
  }
  return result;
}

export type ProcessInfo = { process_info?: { shell_pid?: number; foreground_processes?: { pid: number; argv?: string[]; cwd?: string }[] } } | null;

/**
 * herdr on Windows names only the pane's launcher in foreground_processes, not what the launcher
 * starts (windows-processes.ts). The OmO below the pane's shell joins the list, so the pane is
 * seen as OmO and its session arguments are read. Only processes below this pane's own shell
 * count, and one herdr already named is not added twice.
 */
export function withOmoDescendants(info: ProcessInfo, rows: readonly ProcessRow[]): ProcessInfo {
  const shell = info?.process_info?.shell_pid;
  if (shell === undefined) return info;
  const foreground = info?.process_info?.foreground_processes ?? [];
  const omo = descendantProcesses(rows, shell).filter((entry) =>
    isOmoProcess(entry.argv) && !foreground.some((existing) => existing.pid === entry.pid));
  return omo.length === 0 ? info : { ...info, process_info: { ...info?.process_info, foreground_processes: [...foreground, ...omo] } };
}

const processInfo = async (paneId: string): Promise<ProcessInfo> => {
  const [info, rows] = await Promise.all([
    herdrRpc<NonNullable<ProcessInfo>>("pane.process_info", { pane_id: paneId }).catch(() => null),
    process.platform === "win32" ? recentProcessTable() : Promise.resolve([]),
  ]);
  return withOmoDescendants(info, rows);
};

/**
 * When each foreground process of `infos` started, read before the checks that compare it, without holding the
 * event loop: on macOS each read is the kernel's process record (processStartedAtAsync), a few at a time. Every OmO status refresh, and
 * so every snapshot a pending message is checked against, reads these (#1545).
 */
async function processStarts(infos: Iterable<ProcessInfo>): Promise<(pid: number) => number | null> {
  const pids = [...new Set([...infos].flatMap((info) => (info?.process_info?.foreground_processes ?? []).map((entry) => entry.pid)))];
  const starts = new Map<number, number | null>();
  for (let at = 0; at < pids.length; at += 8) {
    await Promise.all(pids.slice(at, at + 8).map(async (pid) => { starts.set(pid, await processStartedAtAsync(pid)); }));
  }
  return (pid) => starts.get(pid) ?? null;
}

/**
 * The foreground OmO process that holds a session, as typing picks it (paneProcessRoots), or null: an argv-silent
 * custom OmO is known only by its holder, and its bundled Claude SDK child, listed after it, looks like omo by its path
 * but comes and goes with each turn. `prefer` (the process a send is already bound to) wins while it holds one, so two
 * holders that herdr lists in another order keep the one a send went to (#2190). A process herdr gives no cwd for is
 * placed in the pane's, as discovery places it (macOS has no /proc to ask). Starts are read without holding the event
 * loop; `started` is the start its holder record was checked against, so a pid reused after the check is not taken
 * for it.
 */
export async function heldOmoProcess(
  pane: HerdrPane,
  foreground: readonly { pid: number; argv?: readonly string[] | null; cwd?: string | null }[],
  home = userHome(),
  prefer: number | null = null,
): Promise<{ pid: number; started: number | null } | null> {
  const processes: OmoForeground[] = foreground.map(({ pid, argv, cwd }) => ({ pid, ...(argv ? { argv: [...argv] } : {}), ...(cwd ? { cwd } : {}) }));
  const startOf = await processStarts([{ process_info: { foreground_processes: processes } }]);
  const holds = (entry: OmoForeground): boolean => omoProcessIdentity(entry, paneFallbackCwd(pane), home, processEnviron, startOf)?.held === true;
  const preferred = processes.find((entry) => entry.pid === prefer);
  const held = preferred && holds(preferred) ? preferred : processes.find(holds);
  return held ? { pid: held.pid, started: startOf(held.pid) } : null;
}

type OmoForeground = { pid: number; argv?: string[]; cwd?: string };

/** The pane's own directory evidence: herdr's foreground cwd, then the cwd the pane started in. */
const paneFallbackCwd = (pane: HerdrPane): string =>
  (typeof pane.foreground_cwd === "string" && pane.foreground_cwd) || pane.cwd || "";

/**
 * One pane's recognized omo processes — each with the cwd it actually runs in — and the
 * one folder its runtime binds. The processes' own cwds decide, a pane directory being
 * able to go stale while a process runs elsewhere: the unique cwd among processes that
 * hold a session wins, else the unique cwd among the recognized ones, else the pane's
 * own. Two different holder-owning cwds is ambiguous and must not select a transcript.
 */
interface PaneResolution {
  pane: HerdrPane;
  /** herdr answered the pane's process list (an empty one is an answer) */
  informed: boolean;
  omos: { process: OmoForeground; identity: NonNullable<ReturnType<typeof omoProcessIdentity>>; cwd: string }[];
  cwd: string;
  ambiguous: boolean;
}

function resolvePaneRuntime(pane: HerdrPane, info: ProcessInfo, home: string, environOf: (pid: number) => readonly string[] | null, startOf: (pid: number) => number | null = processStartedAt): PaneResolution {
  const fallback = paneFallbackCwd(pane);
  const omos = (info?.process_info?.foreground_processes ?? []).flatMap((process) => {
    const identity = omoProcessIdentity(process, fallback, home, environOf, startOf);
    return identity === null ? [] : [{ process, identity, cwd: processCwd(process, fallback) }];
  });
  const holding = [...new Set(omos.filter((omo) => omo.identity.heldIds.length > 0).map((omo) => omo.cwd))];
  const running = [...new Set(omos.map((omo) => omo.cwd))];
  return {
    pane,
    informed: info?.process_info?.foreground_processes != null,
    omos,
    cwd: holding.length === 1 ? holding[0]! : running.length === 1 ? running[0]! : fallback,
    ambiguous: holding.length > 1,
  };
}

/** A pane answers for its resolved folder; an ambiguous one still claims in each folder a process of its runs in. */
const inCwdGroup = (resolved: PaneResolution, cwd: string): boolean =>
  resolved.cwd === cwd || (resolved.ambiguous && resolved.omos.some((omo) => omo.cwd === cwd));

/**
 * The session each OmO pane of one folder holds, from the processes herdr named for its panes.
 * Same-cwd peers are inspected even when herdr calls omo's SDK child `claude` and when a
 * custom launcher's argv says nothing (omoProcessIdentity). Every piece of evidence —
 * held ids, open descriptors, herdr's report, a launch hint — binds only inside the
 * canonical stores that pane's own processes resolved; another store's file of the same
 * id is a different session, and a pending holder never borrows it.
 */
function omoTranscriptsResolved(cwd: string, panes: readonly PaneResolution[], home: string, startOf: (pid: number) => number | null = processStartedAt): Map<string, { path: string | null; pending: string | null; startedAt: number | null }> {
  const runtimes: OmoRuntime[] = [];
  // Each process's own store: the default one, and wherever its environment moved it.
  const agentDirs = new Set([defaultOmoAgentDir(home)]);
  /** <pane> -> the sessions its processes hold: the id, the folder it is held in and its canonical store */
  const held = new Map<string, { id: string; dir: string; store: string | null }[]>();
  /** for the status only: the choice of session keeps to starts the system itself told */
  const since = new Map<string, number | null>();
  for (const resolved of panes.filter((entry) => inCwdGroup(entry, cwd))) {
    const { pane } = resolved;
    if (!resolved.informed) { runtimes.push({ paneId: pane.pane_id, startedAt: null, paths: [], ids: [] }); continue; }
    // an ambiguous pane claims only through the processes that run in this folder
    const omos = resolved.ambiguous ? resolved.omos.filter((omo) => omo.cwd === cwd) : resolved.omos;
    if (omos.length === 0) continue;
    // every identity came from verified holders alone: hints and inference never apply
    const custom = omos.every(({ identity }) => identity.custom);
    const starts = omos.map(({ process }) => startOf(process.pid));
    const owned = omos.map(({ identity }) => identity.agentDir);
    for (const agentDir of owned) agentDirs.add(agentDir);
    const dirs = omos.map((omo, index) => sessionDir(omo.cwd, owned[index]!));
    const stores = owned.map((agentDir) => { try { return realpathSync(join(agentDir, "sessions")); } catch { return null; } });
    const paths: string[] = [];
    const ids: string[] = [];
    const told = omos.map(({ process }, index) => starts[index] ?? holderStartedAt(dirs[index]!, process.pid));
    since.set(pane.pane_id, earliestStart(told));
    held.set(pane.pane_id, omos.flatMap(({ identity }, index) => identity.heldIds.map((id) => ({ id, dir: dirs[index]!, store: stores[index] ?? null }))));
    for (const [index, { process, identity }] of omos.entries()) {
      if (!identity.custom) ids.push(...resumedIds(process.argv ?? []));
      // Only an open file in the session store is evidence: omo also holds its background
      // tasks' logs (<cwd>/.omo/senpi-task/logs/*.jsonl) open, and one of those pinned the
      // pane to a path no candidate matches, so the chat lost the transcript mid-session.
      let store = join(owned[index]!, "sessions");
      try { store = realpathSync(store); } catch { /* no store yet: no descriptor can be in it */ }
      let descriptors: string[] = [];
      try { descriptors = readdirSync(`/proc/${process.pid}/fd`).slice(0, 1024); } catch { /* unavailable on macOS */ }
      for (const descriptor of descriptors) {
        try {
          const path = readlinkSync(`/proc/${process.pid}/fd/${descriptor}`);
          if (path.endsWith(".jsonl") && path.startsWith(store + sep)) paths.push(path);
        } catch { /* descriptor closed */ }
      }
    }
    const session = pane.agent_session;
    if (!custom && session?.agent === "omo" && session.value) {
      if (session.kind === "path") paths.push(session.value);
      if (session.kind === "id") ids.push(session.value);
    }
    runtimes.push({ paneId: pane.pane_id, startedAt: starts.every((start) => start !== null) ? Math.min(...(starts as number[])) : null, paths, ids, stores: stores.filter((store): store is string => store !== null), custom, ambiguous: resolved.ambiguous });
  }
  const files = omoCandidates(cwd, home, runtimes.flatMap((runtime) => runtime.paths), [...agentDirs]);
  // Match canonical candidates even when /proc names a symlink into the store, and drop a
  // path that no store of this pane contains: it is another pane's or a stale report.
  for (const runtime of runtimes) {
    runtime.paths = runtime.paths.flatMap((path) => { try { return [realpathSync(path)]; } catch { return []; } });
    if (runtime.stores !== undefined) runtime.paths = runtime.paths.filter((path) => runtime.stores!.some((root) => inStore(path, root)));
  }
  const current = runtimes.map((runtime) => heldRuntime(runtime, held.get(runtime.paneId) ?? [], files));
  // That held session's file comes with its first message: until then the pane is a conversation
  // with nothing in it, not an unreadable one. The folders' names decide too, beside the bounded
  // candidates; a folder that cannot be listed leaves it untold, as before.
  const unwritten = (paneId: string): string | null => {
    const entries = held.get(paneId) ?? [];
    if (new Set(entries.map((entry) => entry.id)).size !== 1) return null;
    const id = entries[0]!.id;
    if (files.some((file) => file.id === id && entries.some((entry) => entry.store !== null && entry.store === file.store))) return null;
    for (const dir of new Set(entries.map((entry) => entry.dir))) {
      let names: string[];
      try { names = readdirSync(dir); } catch { return null; }
      // omo names a session's file <start time>_<id>.jsonl
      if (names.some((name) => name === `${id}.jsonl` || name.endsWith(`_${id}.jsonl`))) return null;
    }
    return id;
  };
  return new Map(current.map((runtime) => {
    const pending = runtime.ambiguous ? null : unwritten(runtime.paneId);
    return [runtime.paneId, { path: pending === null ? selectOmoTranscript(runtime.paneId, files, current) : null, pending, startedAt: runtime.startedAt ?? since.get(runtime.paneId) ?? null }];
  }));
}

/** The sessions of `cwd`'s panes: each pane's runtime folder is resolved from its own processes first. */
export function omoTranscriptsOfCwd(cwd: string, panes: HerdrPane[], infos: ReadonlyMap<string, ProcessInfo>, home: string, environOf: (pid: number) => readonly string[] | null = processEnviron): Map<string, { path: string | null; pending: string | null; startedAt: number | null }> {
  return omoTranscriptsResolved(cwd, panes.map((pane) => resolvePaneRuntime(pane, infos.get(pane.pane_id) ?? null, home, environOf)), home);
}

/**
 * The session an OmO pane holds: its file, or `pending`, the id of a session the pane holds
 * but omo has not written yet (before its first message, or right after /new). The folder
 * is the pane's resolved runtime cwd, and its peers are the panes resolving to the same one.
 */
export async function omoSessionForPane(paneId: string, cwd: string, panes: HerdrPane[], home = userHome()): Promise<{ path: string | null; pending: string | null }> {
  // A child model can change herdr's agent label: inspect each pane's processes once.
  const candidates = panes;
  const infos = new Map(await Promise.all(candidates.map(async (pane) => [pane.pane_id, await processInfo(pane.pane_id)] as const)));
  const startOf = await processStarts(infos.values());
  const resolved = candidates.map((pane) => resolvePaneRuntime(pane, infos.get(pane.pane_id) ?? null, home, processEnviron, startOf));
  const target = resolved.find((entry) => entry.pane.pane_id === paneId);
  // two holder-owning cwds fail closed: the pane cannot be bound to either
  if (target?.ambiguous) return { path: null, pending: null };
  const session = omoTranscriptsResolved(target?.cwd ?? cwd, resolved, home, startOf).get(paneId);
  return { path: session?.path ?? null, pending: session?.pending ?? null };
}

export async function omoTranscriptForPane(paneId: string, cwd: string, panes: HerdrPane[], home = userHome()): Promise<string | null> {
  return (await omoSessionForPane(paneId, cwd, panes, home)).path;
}

/**
 * Every pane of a snapshot that runs OmO, whatever herdr calls it, with the session it holds
 * (null when that cannot be told) and when its OmO process started. One process lookup per
 * pane, regardless of its child agent label, shared by all panes of a folder; the folder each
 * pane counts toward is the one its own processes resolve.
 */
export async function omoPanes(panes: HerdrPane[], home = userHome()): Promise<Map<string, { path: string | null; startedAt: number | null }>> {
  const candidates = panes;
  const infos = new Map(await Promise.all(candidates.map(async (pane) => [pane.pane_id, await processInfo(pane.pane_id)] as const)));
  const startOf = await processStarts(infos.values());
  const resolved = candidates.map((pane) => resolvePaneRuntime(pane, infos.get(pane.pane_id) ?? null, home, processEnviron, startOf));
  const found = new Map<string, { path: string | null; startedAt: number | null }>();
  const cwds = new Set(resolved.flatMap((entry) => entry.omos.length === 0 ? [] : entry.ambiguous ? entry.omos.map((omo) => omo.cwd) : [entry.cwd]));
  for (const cwd of cwds) {
    const transcripts = cwd ? omoTranscriptsResolved(cwd, resolved, home, startOf) : new Map<string, { path: string | null; pending: string | null; startedAt: number | null }>();
    for (const entry of resolved) if (entry.omos.length > 0 && inCwdGroup(entry, cwd)) found.set(entry.pane.pane_id, transcripts.get(entry.pane.pane_id) ?? { path: null, startedAt: null });
  }
  return found;
}
