import { lstatSync, readFileSync, realpathSync, type Stats } from "node:fs";
import { lstat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { PI_ASK_BRIDGE_DIRECTORY, type PiAskBridgeState, type PiBridgeCommands } from "../shared/pi-ask-bridge.ts";
import type { SlashCommand } from "../shared/protocol.ts";
import { labelledAgent } from "../shared/supported-agents.ts";
import { registerCatalogSource } from "./catalog-sources.ts";
import { agentGet, paneProcessInfo } from "./herdr/client.ts";
import { runsAgent } from "./gjc-runtime.ts";
import { processEnviron } from "./omo.ts";
import { piAgentDir } from "./pi-models.ts";
import { authorizedTranscript, unwrittenSession } from "./transcript-store.ts";
import { source as piCatalog } from "./skills/pi.ts";
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
 * The session id in the name pi gives a session file (`<time>_<uuid>.jsonl`), or null for any
 * other name. pi writes the file only once the first answer is in (its SessionManager waits for
 * an assistant message), so until then the name is the only place to read the id from.
 */
export function piUnwrittenHeaderId(path: string): string | null {
  return /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/iu.exec(basename(path))?.[1] ?? null;
}

const PI_EXECUTABLE = /(^|[\\/])pi(?:\.exe|\.[cm]?js)?$/i;
export const PI_NPM_ENTRY = /(^|[\\/])node_modules[\\/]@earendil-works[\\/]pi-coding-agent[\\/]dist[\\/]bundle[\\/]cli\.js$/i;

type PiProcess = { pid?: number; name?: string; argv?: readonly string[] | null; cwd?: string | null };
type PiTranscriptOptions = {
  agent?: Awaited<ReturnType<typeof agentGet>> | null;
  processes?: readonly PiProcess[];
  environOf?: (pid: number) => readonly string[] | null;
  argvOf?: (pid: number) => readonly string[] | null;
  processesAfter?: () => Promise<readonly PiProcess[] | null>;
  confirmExtensionSession?: boolean;
  home?: string;
};

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

const UNREAD = "\0unread";

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
 * Only a socket this user owns, in a directory only this user can enter, speaks for a pi: a
 * PI_CODING_AGENT_DIR another user can write to must not let them show a card, read its answer
 * or name a session.
 */
export function ownSocket(socket: string): boolean {
  try { return ownedSocket(lstatSync(dirname(socket)), lstatSync(socket)); } catch { return false; }
}

/** ownSocket off the event loop: a pi profile on a stalled mount must not hold every other request. */
async function ownSocketAsync(socket: string): Promise<boolean> {
  try { return ownedSocket(await lstat(dirname(socket)), await lstat(socket)); } catch { return false; }
}

function ownedSocket(directory: Stats, file: Stats): boolean {
  const uid = process.getuid?.();
  return uid !== undefined && directory.isDirectory() && directory.uid === uid && (directory.mode & 0o077) === 0 && file.isSocket() && file.uid === uid;
}

const STATE_READ_MS = 1_000;

export async function bridgeState(socket: string, signal?: AbortSignal): Promise<PiAskBridgeState | null> {
  try {
    const timeout = AbortSignal.timeout(STATE_READ_MS);
    const response = await fetch("http://localhost/v1/state", { unix: socket, signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
    if (!response.ok) return null;
    const state = await response.json() as PiAskBridgeState;
    return typeof state === "object" && state !== null && state.version === 1 && Array.isArray(state.flows) ? state : null;
  } catch {
    return null; // no extension listening (a socket a crashed pi left), or too slow: the terminal
  }
}

/**
 * The session file the pane's one pi process names through the web UI's extension, or null: herdr-core
 * runs no herdr pi integration, so its agent.get names no session (#2935). Only that process's own
 * socket, in its own agent directory, answering for its pid, counts; the store checks still follow.
 */
async function extensionSessionFile(pi: VerifiedPiProcess, environ: readonly string[] | null, home: string): Promise<string | null> {
  const socket = await extensionSocket(pi, environ, home);
  if (socket === null) return null;
  const state = await bridgeState(socket);
  return state?.pid === pi.pid && typeof state.sessionFile === "string" && state.sessionFile.length > 0 ? state.sessionFile : null;
}

/** The web UI extension's socket of this pi process, in that process's own agent directory, when it is the user's own. */
async function extensionSocket(pi: { pid: number; cwd?: string | null }, environ: readonly string[] | null, home: string): Promise<string | null> {
  if (process.platform === "win32") return null;
  const agentDir = environ === null ? piAgentDir() : piProcessPaths(environ, home, pi.cwd ?? "").agentDir;
  if (agentDir === null) return null;
  const socket = join(agentDir, PI_ASK_BRIDGE_DIRECTORY, `${pi.pid}.sock`);
  return await ownSocketAsync(socket) ? socket : null;
}

const COMMANDS_MAX = 1_000;
const PI_BUILTIN_NAMES: ReadonlySet<string> = new Set(piCatalog.builtins);

/**
 * The commands pi's extensions and packages registered, which no file scan can know (#1448), as the
 * pane's one foreground pi lists them through the web UI's extension (`pi.getCommands()`), or null:
 * no such pi, no extension (or one from before this route), pi could not say, or that pi left the
 * front while it answered. As pi's own menu does, a command named after a builtin is left out:
 * typed, pi runs its own.
 */
export async function piExtensionCommands(
  paneId: string,
  signal?: AbortSignal,
  options: Omit<PiTranscriptOptions, "agent"> = {},
): Promise<SlashCommand[] | null> {
  const info = options.processes === undefined
    ? await paneProcessInfo(paneId).catch(() => null)
    : { foreground_processes: [...options.processes] };
  const argvOf = options.argvOf ?? processArgv;
  const pisOf = (processes: readonly PiProcess[]) => processes.filter((entry): entry is PiProcess & { pid: number } => {
    if (typeof entry.pid !== "number") return false;
    const argv = entry.argv?.length ? entry.argv : argvOf(entry.pid);
    return !!argv?.length && isPiProcess(argv);
  });
  const pis = pisOf(info?.foreground_processes ?? []);
  if (pis.length !== 1 || signal?.aborted) return null;
  const pi = pis[0]!;
  const socket = await extensionSocket(pi, (options.environOf ?? processEnviron)(pi.pid), options.home ?? userHome());
  if (socket === null) return null;
  let rows: SlashCommand[];
  try {
    const timeout = AbortSignal.timeout(STATE_READ_MS);
    const response = await fetch("http://localhost/v1/commands", { unix: socket, signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
    if (!response.ok) return null;
    const reply = await response.json() as Partial<PiBridgeCommands> | null;
    if (reply?.version !== 1 || reply.pid !== pi.pid || !Array.isArray(reply.commands)) return null;
    rows = reply.commands.slice(0, COMMANDS_MAX).flatMap((command): SlashCommand[] => {
      const name: unknown = command?.name;
      if (typeof name !== "string" || !/^\S{1,200}$/u.test(name) || PI_BUILTIN_NAMES.has(name)) return [];
      const source = command.scope === "project" ? "project" : command.origin === "package" ? "plugin" : "user";
      return [{ name, description: typeof command.description === "string" ? command.description : "", source }];
    });
  } catch {
    return null;
  }
  // the answer is that pi's: one that left the front while it was asked, or now shares it with
  // another pi, no longer speaks for the pane
  const after = options.processesAfter
    ? await options.processesAfter()
    : (await paneProcessInfo(paneId).catch(() => null))?.foreground_processes ?? null;
  const still = after === null ? [] : pisOf(after);
  return still.length === 1 && still[0]!.pid === pi.pid ? rows : null;
}

// pi runs an extension command before it expands a prompt template of the same name
registerCatalogSource({ agent: "pi", owns: [], shadows: true, rows: (pane, _cwd, signal) => piExtensionCommands(pane.pane_id, signal) });

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
 * the active session, else (no report at all, as on herdr-core) the pane's one pi process through
 * the web UI's extension; Linux process metadata ties a custom store to the Pi process in this pane.
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
): Promise<{ path: string; agentDir: string | null; identity: string } | { unwritten: { id: string; path: string } } | null> {
  const agent = options.agent === undefined ? await agentGet(paneId).catch(() => null) : options.agent;
  if (!agent || labelledAgent(agent.agent) !== "pi") return null;
  const session = agent.agent_session;
  const absent = session === undefined || session === null;
  if (!absent && (session.agent !== "pi" || session.source !== "herdr:pi" || session.kind !== "path" || typeof session.value !== "string")) return null;

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
  let reported: string | null = absent ? null : session.value;
  if (absent && piProcesses.length === 1) {
    const pi = piProcesses[0]!;
    reported = await extensionSessionFile(pi, environOf(pi.pid), home);
    // the answer is that pi's: one that left the front while it was asked is not the pane's any more
    if (reported !== null) {
      const after = options.processesAfter
        ? await options.processesAfter()
        : (await paneProcessInfo(paneId).catch(() => null))?.foreground_processes ?? null;
      if (!after?.some((entry) => entry.pid === pi.pid)) reported = null;
      else if (options.confirmExtensionSession && await extensionSessionFile(pi, environOf(pi.pid), home) !== reported) reported = null;
    }
  }
  if (reported === null) return null;

  const processStores = new Set<string>();
  const agentDirs = new Map<string | null, string | null>();
  for (const process of piProcesses) {
    const resolved = piSessionDirForProcess(process.argv ?? [], environOf(process.pid!), home, process.cwd ?? "");
    if (resolved.kind === "reject") return null;
    processStores.add(resolved.kind === "store" ? resolved.path : sessionDir);
    const agentDir = resolved.kind === "store" ? resolved.agentDir : UNREAD;
    let canonical = agentDir;
    if (agentDir !== null) try { canonical = realpathSync(agentDir); } catch { }
    if (!agentDirs.has(canonical)) agentDirs.set(canonical, agentDir);
  }
  const canonicalProcessStores = new Set<string>();
  for (const store of processStores) {
    try { canonicalProcessStores.add(realpathSync(store)); } catch { }
  }
  if (canonicalProcessStores.size > 1) return null;
  const canonicalStores = new Set<string>();
  // A process-owned custom profile replaces the bridge default. Including both would let a
  // stale report from the bridge's unrelated profile appear valid for this pane.
  const candidateStores = piProcesses.length === 0 ? [sessionDir] : [...canonicalProcessStores];
  for (const store of candidateStores) {
    try { canonicalStores.add(realpathSync(store)); } catch { }
  }
  // Preserve default-store behavior on platforms where process_info names only the shell or
  // process environments cannot be read. A custom store is never guessed in those cases.
  // each store's proof is taken once: the file it opened is the one returned, with its exact dev:ino (`identity`)
  const proofs = new Map([...canonicalStores].map((store) => [store, authorizedTranscript(reported, store)]));
  const matches = [...canonicalStores].filter((store) => proofs.get(store) !== null || unwrittenSession(reported, store) !== null);
  if (matches.length !== 1) return null;
  const authorized = proofs.get(matches[0]!) ?? null;
  const named = piProcesses.length === 0 ? UNREAD : agentDirs.size === 1 ? [...agentDirs.values()][0] ?? null : null;
  const agentDir = named === UNREAD ? bridgeAgentDirOwning(matches[0]!) : named;
  if (authorized !== null) return { path: authorized.path, agentDir, identity: authorized.identity };
  const unwritten = unwrittenSession(reported, matches[0]!);
  return unwritten === null ? null : { unwritten };
}
