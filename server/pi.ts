import { readFileSync, realpathSync } from "node:fs";
import { basename, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { agentGet, paneProcessInfo } from "./herdr/client.ts";
import { runsAgent } from "./gjc-runtime.ts";
import { processEnviron } from "./omo.ts";
import { piAgentDir } from "./pi-models.ts";
import { transcriptInStore as piTranscriptInStore, unwrittenSession } from "./transcript-store.ts";
import { userHome } from "./user-home.ts";
export { transcriptInStore as piTranscriptInStore, unwrittenSession } from "./transcript-store.ts";

/**
 * pi's session store. `PI_CODING_AGENT_SESSION_DIR` moves it, exactly as CODEX_HOME
 * moves Codex's, and `PI_CODING_AGENT_DIR` moves the agent directory it sits in (seen on
 * pi 0.87.1: the store is `<agent dir>/sessions`); pi's `--session-dir` flag and its
 * `sessionDir` setting move it too, but this process cannot see either, so a pane started
 * that way keeps the terminal.
 */
export const defaultPiSessionDir = (): string =>
  process.env["PI_CODING_AGENT_SESSION_DIR"] || join(piAgentDir(), "sessions");

/**
 * The session an agent named but has not written, or null. pi and omp write their file only
 * once the first answer is in (pi's SessionManager waits for an assistant message), so until
 * then the reported path does not exist. Only an absent `.jsonl` file whose nearest existing
 * ancestor is a directory inside the store, both resolved, counts: nothing is read from it,
 * its display id and canonical prospective path keep equally named sessions distinct.
 */
export function piUnwrittenHeaderId(path: string): string | null {
  return /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/iu.exec(basename(path))?.[1] ?? null;
}

const PI_EXECUTABLE = /(^|[\\/])pi(?:\.exe|\.[cm]?js)?$/i;
const PI_NPM_ENTRY = /(^|[\\/])node_modules[\\/]@earendil-works[\\/]pi-coding-agent[\\/]dist[\\/]bundle[\\/]cli\.js$/i;

type PiProcess = { pid?: number; name?: string; argv?: readonly string[] | null; cwd?: string | null };
type PiTranscriptOptions = {
  agent?: Awaited<ReturnType<typeof agentGet>> | null;
  processes?: readonly PiProcess[];
  environOf?: (pid: number) => readonly string[] | null;
  argvOf?: (pid: number) => readonly string[] | null;
  home?: string;
};

/** True for Pi's binary/script launch forms and the official npm bundle entry. */
export function isPiProcess(argv: readonly string[]): boolean {
  return runsAgent(argv, PI_EXECUTABLE)
    || /(^|[\\/])(?:bun|node)(?:\.exe)?$/i.test(argv[0] ?? "") && PI_NPM_ENTRY.test(argv[1] ?? "");
}

/** Linux Herdr versions can omit argv; recover it from this foreground PID, never its name. */
function processArgv(pid: number): readonly string[] | null {
  if (process.platform !== "linux") return null;
  try { return readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter(Boolean); }
  catch { return null; }
}

/** A Pi process whose environment could not be read: its agent directory is not known from it. */
const UNREAD = "\0unread";

/** The bridge's agent directory when `store` (canonical) is the session store inside it, else null. */
function bridgeAgentDirOwning(store: string): string | null {
  const agentDir = piAgentDir();
  try { return realpathSync(join(agentDir, "sessions")) === store ? agentDir : null; } catch { return null; }
}

type PiStoreResolution = { kind: "default" } | { kind: "store"; path: string; agentDir: string | null } | { kind: "reject" };
type VerifiedPiProcess = Omit<PiProcess, "argv" | "pid"> & { pid: number; argv: readonly string[] };

/**
 * A pi process's agent directory as pi resolves it from its own environment, and pi's normalizer
 * for its other paths: `~` against the process's home, then a file: URL decoded to its path.
 */
function piProcessPaths(environ: readonly string[], home: string, cwd: string) {
  const value = (name: string) => environ.find((word) => word.startsWith(`${name}=`))?.slice(name.length + 1) || null;
  const processHome = value("HOME") ?? value("USERPROFILE") ?? home;
  const absolute = (raw: string): string | null => {
    let expanded = raw === "~" ? processHome : raw.startsWith("~/") ? join(processHome, raw.slice(2)) : raw;
    if (/^file:\/\//.test(expanded)) {
      try { expanded = fileURLToPath(expanded); } catch { return null; }
    }
    return isAbsolute(expanded) ? resolve(expanded) : cwd ? resolve(join(cwd, expanded)) : null;
  };
  return { value, absolute, agentDir: absolute(value("PI_CODING_AGENT_DIR") || join(processHome, ".pi", "agent")) };
}

/**
 * Resolve only stores the pane's Pi process identifies; an unseen CLI override is unsafe. The
 * agent directory comes with it: pi reads its model catalogs from there, not from the bridge's.
 */
function piSessionDirForProcess(
  argv: readonly string[],
  environ: readonly string[] | null,
  home: string,
  cwd: string,
): PiStoreResolution {
  if (!isPiProcess(argv)) return { kind: "reject" };
  if (argv.some((word) => word === "--session-dir" || word.startsWith("--session-dir="))) return { kind: "reject" };
  if (environ === null) return { kind: "default" };
  const { value, absolute, agentDir } = piProcessPaths(environ, home, cwd);
  const sessionEntry = value("PI_CODING_AGENT_SESSION_DIR");
  const path = sessionEntry ? absolute(sessionEntry) : agentDir === null ? null : join(agentDir, "sessions");
  if (path === null) return { kind: "reject" };
  return { kind: "store", path, agentDir };
}

/**
 * The pane's foreground pids and the agent directories its pi may use, whatever its session: the
 * directory each identified pi process names, and the bridge's own for processes whose environment
 * says nothing (or that are not identified as pi). Nothing here is a card's authority; it says only
 * where the pane's pi would answer if it runs the web UI's extension.
 */
export async function piPaneAgentDirs(
  paneId: string,
  options: Omit<PiTranscriptOptions, "agent"> = {},
): Promise<{ pids: number[] | null; agentDirs: string[] }> {
  const info = options.processes === undefined
    ? await paneProcessInfo(paneId).catch(() => null)
    : { foreground_processes: [...options.processes] };
  const home = options.home ?? userHome();
  const environOf = options.environOf ?? processEnviron;
  const argvOf = options.argvOf ?? processArgv;
  const pids: number[] = [];
  const agentDirs = new Set<string>([piAgentDir()]);
  // the pane's processes could not be read: who is in front is not known
  if (info === null) return { pids: null, agentDirs: [...agentDirs] };
  for (const entry of info?.foreground_processes ?? []) {
    if (typeof entry.pid !== "number") continue;
    pids.push(entry.pid);
    const argv = entry.argv?.length ? entry.argv : argvOf(entry.pid);
    if (!argv?.length || !isPiProcess(argv)) continue;
    // whatever its session store (a --session-dir the bridge cannot follow), the agent directory is pi's own
    const environ = environOf(entry.pid);
    const agentDir = environ === null ? null : piProcessPaths(environ, home, entry.cwd ?? "").agentDir;
    if (agentDir !== null) agentDirs.add(agentDir);
  }
  return { pids: [...new Set(pids)], agentDirs: [...agentDirs] };
}

/**
 * pi's transcript for a pane, or the session it has not written yet. The agent report names
 * the active session; Linux process metadata ties a custom store to the Pi process in this pane.
 * Where the OS cannot expose that process environment, only the bridge's default store is used.
 *
 * A written session comes with the agent directory of the same process, where pi keeps the
 * catalogs its context window is read from (`piContextWindow`), or null when that is not known:
 * the pane's Pi processes name different ones, or none of them could be read (no Pi process
 * identified, or its environment unreadable, as on macOS). In that last case the session was
 * found in the bridge's own store, so the bridge's agent directory stands only when that store
 * is the one inside it: a store shared through PI_CODING_AGENT_SESSION_DIR says nothing of the
 * profile a pane writes to it from.
 */
export async function piTranscriptPath(
  paneId: string,
  sessionDir = defaultPiSessionDir(),
  options: PiTranscriptOptions = {},
): Promise<{ path: string; agentDir: string | null } | { unwritten: { id: string; path: string } } | null> {
  const agent = options.agent === undefined ? await agentGet(paneId).catch(() => null) : options.agent;
  const session = agent?.agent_session;
  if (agent?.agent !== "pi" || session?.agent !== "pi" || session.source !== "herdr:pi" || session.kind !== "path" || typeof session.value !== "string") return null;

  const info = options.processes === undefined
    ? await paneProcessInfo(paneId).catch(() => undefined)
    : { foreground_processes: [...options.processes] };
  const home = options.home ?? userHome();
  const environOf = options.environOf ?? processEnviron;
  const argvOf = options.argvOf ?? processArgv;
  const piProcesses: VerifiedPiProcess[] = [];
  for (const entry of info?.foreground_processes ?? []) {
    if (typeof entry.pid !== "number") continue;
    const argv = entry.argv?.length ? entry.argv : argvOf(entry.pid);
    if (argv?.length) {
      if (isPiProcess(argv)) piProcesses.push({ ...entry, pid: entry.pid, argv });
    }
  }

  const processStores = new Set<string>();
  /** each process's agent directory, by its canonical path */
  const agentDirs = new Map<string | null, string | null>();
  for (const process of piProcesses) {
    const resolved = piSessionDirForProcess(process.argv ?? [], environOf(process.pid!), home, process.cwd ?? "");
    if (resolved.kind === "reject") return null;
    processStores.add(resolved.kind === "store" ? resolved.path : sessionDir);
    const agentDir = resolved.kind === "store" ? resolved.agentDir : UNREAD;
    // one directory named through a link is still one directory
    let canonical = agentDir;
    if (agentDir !== null) try { canonical = realpathSync(agentDir); } catch { /* absent: no catalog to read */ }
    if (!agentDirs.has(canonical)) agentDirs.set(canonical, agentDir);
  }
  const canonicalProcessStores = new Set<string>();
  for (const store of processStores) {
    try { canonicalProcessStores.add(realpathSync(store)); } catch { /* an absent store holds no session */ }
  }
  if (canonicalProcessStores.size > 1) return null;
  const canonicalStores = new Set<string>();
  // A process-owned custom profile replaces the bridge default. Including both would let a
  // stale report from the bridge's unrelated profile appear valid for this pane.
  const candidateStores = piProcesses.length === 0 ? [sessionDir] : [...canonicalProcessStores];
  for (const store of candidateStores) {
    try { canonicalStores.add(realpathSync(store)); } catch { /* an absent store holds no session */ }
  }
  // Preserve default-store behavior on platforms where process_info names only the shell or
  // process environments cannot be read. A custom store is never guessed in those cases.
  const matches = [...canonicalStores].filter((store) => piTranscriptInStore(session.value, store) !== null || unwrittenSession(session.value, store) !== null);
  if (matches.length !== 1) return null;
  const path = piTranscriptInStore(session.value, matches[0]!);
  const named = piProcesses.length === 0 ? UNREAD : agentDirs.size === 1 ? [...agentDirs.values()][0] ?? null : null;
  const agentDir = named === UNREAD ? bridgeAgentDirOwning(matches[0]!) : named;
  if (path !== null) return { path, agentDir };
  const unwritten = unwrittenSession(session.value, matches[0]!);
  return unwritten === null ? null : { unwritten };
}
