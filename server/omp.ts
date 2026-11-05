/**
 * OMP sessions from the pane's own process when Herdr supplies no usable session path.
 * Herdr deliberately omits recognized agents' argv on WSL to avoid blocking procfs reads.
 * Recover process identity outside the bridge, then use the open transcript or breadcrumb.
 */
import { existsSync, realpathSync } from "node:fs";
import { userInfo } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

import { darwinProcess } from "./claude-store.ts";
import { paneProcessInfo, type ProcessInfo } from "./herdr/client.ts";
import { heldTranscript, runsAgent, storeRelative, type StoreRoots, transcriptHeader } from "./gjc-runtime.ts";
import { ompProcessMemory, ompRoutingEnviron, processStartTicks } from "./omp-process.ts";

const OMP_EXECUTABLE = /(^|[\\/])omp(?:\.exe|\.[cm]?js)?$/i;

export function isOmpProcess(argv: readonly string[]): boolean {
  return runsAgent(argv, OMP_EXECUTABLE);
}

/**
 * One of omp's own helpers, started in the foreground process group of the omp that started it
 * and holding no session: a worker (`omp __omp_worker_<name>`, such as the speech ones, which are
 * not detached), or the compiled binary running itself as bun to install packages
 * (`omp add --cwd <env> ...` for its eval tool, `omp install --cwd <runtime> ...` for its side
 * runtimes).
 */
export function isOmpHelper(argv: readonly string[]): boolean {
  if (!isOmpProcess(argv)) return false;
  const compiled = OMP_EXECUTABLE.test(argv[0] ?? "");
  // omp sends a first word naming a worker to that worker, never to a session
  if ((argv[compiled ? 1 : 2] ?? "").startsWith("__omp_worker_")) return true;
  return compiled && (argv[1] === "add" || argv[1] === "install") && argv[2] === "--cwd";
}

/**
 * omp's options that take the next word as their value, whatever it looks like. Its other options
 * take at most a word that does not look like an option, so they never hide `--cwd` or a store option.
 */
const VALUE_OPTIONS = new Set([
  "--cwd", "--session-dir", "--config", "--add-dir", "--mode", "--fork", "--provider", "--model", "--smol", "--slow",
  "--goal", "--plan", "--prewalk-into", "--plan-yolo-into", "--max-time", "--service-tier", "--api-key", "--system-prompt",
  "--system-prompt-template", "--append-system-prompt", "--provider-session-id", "--prompt-cache-key", "--models",
  "--tools", "--thinking", "--export", "--hook", "--extension", "-e", "--trusted-extension", "--plugin-dir", "--skills",
  "--approval-mode",
]);

/**
 * What an omp command line says about where it keeps its session: the last of each option wins.
 * `sessionDirValue` is the last `--session-dir`'s value ("" for an empty one, undefined when it
 * ends argv without one or none is given). `extensions` are the files `-e`, `--extension`, `--hook`
 * and `--trusted-extension` name, which omp loads even when it discovers none (`noExtensions`):
 * under `--no-extensions`, and under `--trusted-extension`, which loads only its own files (omp
 * refuses it together with the others).
 */
export interface OmpLaunch {
  profile: string | null; sessionDir: boolean; cwd: string | null; sessionDirValue?: string;
  extensions: string[]; noExtensions: boolean;
}

const EXTENSION_OPTIONS = new Set(["-e", "--extension", "--hook", "--trusted-extension"]);

/**
 * The store options of omp's own argv (as the process has it, never a shell string), read the way
 * omp 18.8.7 reads them. A first pass takes `--profile` and `--alias` out, up to `--`; a second
 * reads the rest, where an option's value is consumed with it and a free `--` ends the options.
 * `cwd` is null when no `--cwd` names a directory: omp ignores a trailing one without a value and
 * stays where it started on an empty one. null when omp would refuse to start: a profile or alias
 * option without its name.
 */
export function ompLaunch(argv: readonly string[]): OmpLaunch | null {
  let profile: string | null = null;
  const rest: string[] = [];
  // a bun or node interpreter comes first, then omp's script
  for (let at = OMP_EXECUTABLE.test(argv[0] ?? "") ? 1 : 2; at < argv.length; at++) {
    const word = argv[at]!;
    if (word === "--") { rest.push(...argv.slice(at)); break; }
    const option = /^--(?:profile|alias)(?==|$)/.exec(word)?.[0];
    if (option) {
      const value = word === option ? argv[++at] : word.slice(option.length + 1);
      if (!value || word === option && value.startsWith("-")) return null;
      if (option === "--profile") profile = value;
      continue;
    }
    rest.push(word);
    // this pass lets `--plan` take only a word that does not look like an option
    if (VALUE_OPTIONS.has(word) && word !== "--plan" && at + 1 < argv.length) rest.push(argv[++at]!);
  }
  let cwd = "", sessionDir = false, noExtensions = false;
  let sessionDirValue: string | undefined;
  const extensions: string[] = [];
  for (let at = 0; at < rest.length; at++) {
    let word = rest[at]!;
    let value: string | undefined;
    const equals = word.startsWith("--") ? word.indexOf("=") : -1;
    if (equals > 0) { value = word.slice(equals + 1); word = word.slice(0, equals); }
    if (word === "--") break;
    if (equals < 0 && VALUE_OPTIONS.has(word)) value = rest[++at];
    // a moved store counts even without its value: omp's environment can move it too
    if (word === "--session-dir") { sessionDir = true; sessionDirValue = value; }
    else if (word === "--cwd" && value !== undefined) cwd = value;
    else if (EXTENSION_OPTIONS.has(word) && value) {
      extensions.push(value);
      if (word === "--trusted-extension") noExtensions = true;
    }
    else if (word === "--no-extensions") noExtensions = true;
  }
  return { profile, sessionDir, cwd: cwd || null, sessionDirValue, extensions, noExtensions };
}

/**
 * The agent directory one omp process keeps its sessions and terminal breadcrumbs in:
 * ~/.omp/agent, or ~/.omp/profiles/<name>/agent under `--profile <name>` or OMP_PROFILE (the flag
 * wins). null when `--session-dir` moved its sessions anywhere at all, the profile name could
 * leave ~/.omp/profiles, or omp would not start with this argv.
 */
export function ompAgentDir(argv: readonly string[], environ: readonly string[] | null, home: string): string | null {
  if (ompLaunch(argv)?.sessionDir) return null;
  return ompConfigDir(argv, environ, home);
}

/**
 * The agent directory omp loads extensions from: moving sessions does not move its configuration.
 * Read the way ompStoreLayout reads it, from the environment when one was read (without one, the
 * default directory or the `--profile` one).
 */
export function ompConfigDir(argv: readonly string[], environ: readonly string[] | null, home: string): string | null {
  const launch = ompLaunch(argv);
  if (launch === null) return null;
  const variables = new Map<string, string>();
  for (const word of environ ?? []) {
    const equals = word.indexOf("=");
    if (equals > 0 && !variables.has(word.slice(0, equals))) variables.set(word.slice(0, equals), word.slice(equals + 1));
  }
  return ompAgentDirectory(launch, (key) => variables.get(key), home)?.agent ?? null;
}

/** herdr's omp integration (`herdr integration install omp`), the file it installs in an agent directory's `extensions`. */
export const OMP_INTEGRATION_FILE = "herdr-omp-agent-state.ts";

/**
 * Whether an omp process loads herdr's omp integration, found the way omp 18.8.7 finds extensions:
 * a file `-e`/`--extension`/`--hook`/`--trusted-extension` names (loaded even under
 * `--no-extensions`), and unless `--no-extensions`, the integration in the `extensions` of its agent
 * directory (ompConfigDir) or of `<cwd>/.omp`, the directory it runs in (omp skips that one in the
 * home directory). Extensions listed in a `settings.json` are not seen.
 */
export function ompLoadsIntegration(argv: readonly string[], environ: readonly string[] | null, home: string, cwd: string | null): boolean {
  const launch = ompLaunch(argv);
  if (launch === null) return false;
  if (launch.extensions.some((path) => basename(path) === OMP_INTEGRATION_FILE)) return true;
  if (launch.noExtensions) return false;
  const agentDir = ompConfigDir(argv, environ, home);
  if (agentDir !== null && existsSync(join(agentDir, "extensions", OMP_INTEGRATION_FILE))) return true;
  return cwd !== null && isAbsolute(cwd) && !sameDirectory(cwd, home) && existsSync(join(cwd, ".omp", "extensions", OMP_INTEGRATION_FILE));
}

/**
 * The directory an omp process's `--cwd` names by itself: an absolute value, resolved the way omp
 * resolves it before it changes into it and writes it in its session header. null without one, and
 * for a relative value: omp resolved that against the directory it started in, which nothing
 * records once it has moved, and the result is its live directory already.
 */
export function ompLaunchDir(argv: readonly string[]): string | null {
  const cwd = ompLaunch(argv)?.cwd ?? null;
  if (cwd === null) return null;
  // a Windows path without a drive would take the server's own
  const absolute = process.platform === "win32" ? /^(?:[a-z]:[\\/]|[\\/]{2}[^\\/])/i.test(cwd) : cwd.startsWith("/");
  return absolute ? resolve(cwd) : null;
}

const PROFILE_NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const WINDOWS_DEVICE = /^(?:CON|PRN|AUX|NUL|COM[0-9]|LPT[0-9])(?:\..*)?$/i;

/**
 * A profile name read the way omp reads it: trimmed, none for an empty one or `default`, and null
 * for one omp refuses to start with.
 */
function ompProfileName(value: string | undefined): string | undefined | null {
  const name = value?.trim();
  if (!name || name === "default") return undefined;
  return name === "." || name === ".." || name.endsWith(".") || !PROFILE_NAME.test(name) || WINDOWS_DEVICE.test(name) ? null : name;
}

/**
 * Where one omp process writes its sessions and terminal breadcrumbs (gjc-runtime.ts StoreRoots):
 * `sessions/<cwd>/<id>.jsonl` (depth 2), or a session directory of its own holding `<id>.jsonl`
 * (depth 1) while its breadcrumbs stay where the agent directory puts them.
 */
export type OmpLayout = StoreRoots;

/**
 * The stores of one omp process, from its own argv and routing environment (never the bridge's),
 * as omp 18.8.7 and 18.12 pick them (scripts/omp-store-layout-probe.ts,
 * server/fixtures/omp-18.8.7-store-layouts.json):
 * - the config root is `$HOME/<PI_CONFIG_DIR or .omp>`, and a profile's `<root>/profiles/<name>`;
 * - the profile is the last `--profile`, else OMP_PROFILE when set (even empty), else PI_PROFILE;
 *   empty and `default` name none;
 * - the agent directory is the profile's `agent`. Without a profile PI_CODING_AGENT_DIR overrides
 *   it, unless it names the agent directory of the profile the environment names (a parent omp's
 *   profile handed it down);
 * - an agent directory that is the default one keeps its sessions under
 *   `$XDG_DATA_HOME/omp[/profiles/<name>]/sessions` and its breadcrumbs under
 *   `$XDG_STATE_HOME/omp[/profiles/<name>]/terminal-sessions`, each only when that directory exists;
 * - the last `--session-dir`, else PI_CODING_AGENT_SESSION_DIR, is a session directory of its own.
 * Only the environment omp was started with counts: values omp loads later from its `.env` files
 * are not seen, so such a store is not found (the transcripts lie outside the store this names).
 * null when nothing proves the store: argv omp would refuse, an environment that could not be read
 * (Linux and macOS show a same-user process's own; Windows none), a variable given twice, a
 * profile name omp refuses, a relative directory (omp resolved it against a directory nothing
 * records), an empty or missing `--session-dir` value, or on macOS an XDG omp root (whether omp
 * reads those there depends on its version).
 */
export function ompStoreLayout(argv: readonly string[], environ: readonly string[] | null, platform: NodeJS.Platform = process.platform): OmpLayout | null {
  const launch = ompLaunch(argv);
  if (launch === null || environ === null) return null;
  const variables = new Map<string, string>();
  for (const word of environ) {
    const equals = word.indexOf("=");
    if (equals <= 0) continue;
    // which of two the process read is not proven
    if (variables.has(word.slice(0, equals))) return null;
    variables.set(word.slice(0, equals), word.slice(equals + 1));
  }
  const variable = (key: string) => variables.get(key);
  let user: string;
  // omp's home is $HOME, or the account's own when it is unset or empty
  try { user = variable("HOME") || userInfo().homedir; } catch { return null; }
  if (!isAbsolute(user)) return null;
  const directory = ompAgentDirectory(launch, variable, user);
  if (directory === null) return null;
  const { agent, defaultAgent, profile } = directory;
  let sessions = join(agent, "sessions"), terminalSessions = join(agent, "terminal-sessions");
  if (agent === defaultAgent) {
    const xdg = (key: string): string | null | undefined => {
      const base = variable(key);
      if (!base) return undefined;
      if (!isAbsolute(base)) return null;
      const app = profile === undefined ? join(base, "omp") : join(base, "omp", "profiles", profile);
      return existsSync(app) ? app : undefined;
    };
    const data = xdg("XDG_DATA_HOME"), state = xdg("XDG_STATE_HOME");
    if (data === null || state === null || platform !== "linux" && (data || state)) return null;
    if (data) sessions = join(data, "sessions");
    if (state) terminalSessions = join(state, "terminal-sessions");
  }
  if (launch.sessionDir && !launch.sessionDirValue) return null;
  const own = launch.sessionDir ? launch.sessionDirValue : variable("PI_CODING_AGENT_SESSION_DIR") || undefined;
  if (own === undefined) return { sessions, terminalSessions, depth: 2 };
  return isAbsolute(own) ? { sessions: resolve(own), terminalSessions, depth: 1 } : null;
}

/**
 * The agent directory of an omp with this launch and environment, as ompStoreLayout describes it,
 * the default one it would be without PI_CODING_AGENT_DIR, and its profile. null for a profile name
 * omp refuses or a relative PI_CODING_AGENT_DIR.
 */
function ompAgentDirectory(launch: OmpLaunch, variable: (key: string) => string | undefined, home: string): { agent: string; defaultAgent: string; profile: string | undefined } | null {
  const root = join(home, variable("PI_CONFIG_DIR") || ".omp");
  const fromEnv = ompProfileName(variable("OMP_PROFILE") !== undefined ? variable("OMP_PROFILE") : variable("PI_PROFILE"));
  const profile = launch.profile !== null ? ompProfileName(launch.profile) : fromEnv;
  if (profile === null) return null;
  const defaultAgent = join(profile === undefined ? root : join(root, "profiles", profile), "agent");
  let agent = defaultAgent;
  if (profile === undefined) {
    const override = variable("PI_CODING_AGENT_DIR");
    // a name omp refuses counts as none here: it read it only under a `--profile` that named none
    const named = (name: string | null | undefined) => name === null ? undefined : name;
    const handedDown = named(fromEnv) ?? named(ompProfileName(variable("PI_PROFILE")));
    if (override && !(handedDown !== undefined && override === join(root, "profiles", handedDown, "agent"))) {
      if (!isAbsolute(override)) return null;
      agent = resolve(override);
    }
  }
  return { agent, defaultAgent, profile };
}

/**
 * The routing words of a process's environment on macOS, from the kernel's argument area, or null
 * (Linux reads through the bounded helper in ompPaneRoute; Windows shows none).
 */
function routingEnviron(pid: number): readonly string[] | null {
  if (process.platform === "darwin") return ompRoutingEnviron(darwinProcess.environment(pid)?.split("\0") ?? null);
  return null;
}

/** The pane's omp processes and the one layout they share (ompPaneRoute). */
export interface OmpRoute {
  layout: OmpLayout;
  pids: number[];
  /** The routing environment read for each process, standing in for gjcTerminal's own read. */
  environOf: (pid: number) => readonly string[] | undefined;
  /** The absolute `--cwd` every omp process in the pane started with, or null (ompLaunchDir). */
  launchDir: string | null;
}

/**
 * Where the pane's omp processes keep their sessions: the one layout their own argv and routing
 * environment give (ompStoreLayout). null when herdr shows no live omp process in the pane;
 * "unproved" when one's store cannot be told, two keep different ones, or a live process whose
 * argv herdr left out could not be read, since nothing then says which store, or which session,
 * the pane shows. omp's helpers count for nothing.
 */
export async function ompPaneRoute(paneId: string, known?: ProcessInfo | null): Promise<OmpRoute | "unproved" | null> {
  // `known`: herdr's answer the caller's poll already read for this pane. One that named no processes is asked again:
  // with no omp seen herdr's reported session is trusted, and an omp started since may keep another store
  const info = known ?? await paneProcessInfo(paneId).catch(() => null);
  let layout: OmpLayout | null = null;
  const pids: number[] = [];
  const launchDirs = new Set<string | null>();
  const environs = new Map<number, readonly string[]>();
  let unread = false;
  for (const foreground of info?.foreground_processes ?? []) {
    if (typeof foreground.pid !== "number") continue;
    let argv = Array.isArray(foreground.argv) ? foreground.argv.map(String) : [];
    if (argv.length > 0 && (!isOmpProcess(argv) || isOmpHelper(argv))) continue;
    // Herdr omits a recognized agent's argv (on Linux, WSL included). A procfs memory read blocks
    // while the process holds its memory map locked (omp does while it pages in, and on WSL while
    // it exits), so on Linux every read goes through the bounded helper, never the bridge itself.
    const probe = process.platform === "linux";
    let environ: readonly string[] | null;
    if (probe) {
      const memory = await ompProcessMemory(foreground.pid, argv.length === 0);
      // an omp herdr named whose environment cannot be read may keep its sessions anywhere
      if (memory === null && argv.length > 0) return "unproved";
      // a live agent whose argv could not be read may be an omp keeping another store
      if (memory === null) { unread ||= processStartTicks(foreground.pid) !== null; continue; }
      if (argv.length === 0) argv = memory.argv;
      environ = memory.environ;
    } else environ = routingEnviron(foreground.pid);
    if (!isOmpProcess(argv) || isOmpHelper(argv)) continue;
    const next = ompStoreLayout(argv, environ);
    if (next === null || layout !== null && (next.sessions !== layout.sessions || next.terminalSessions !== layout.terminalSessions || next.depth !== layout.depth)) return "unproved";
    layout = next;
    pids.push(foreground.pid);
    launchDirs.add(ompLaunchDir(argv));
    if (environ !== null) environs.set(foreground.pid, environ);
  }
  if (unread) return "unproved";
  if (layout === null) return null;
  const [launchDir] = launchDirs;
  return { layout, pids, environOf: (pid) => environs.get(pid), launchDir: launchDirs.size === 1 ? launchDir ?? null : null };
}

/**
 * Whether omp reads a session of this header's version: 18.8.7 and 18.12 write version 3 and
 * migrate 1, 2 and a header naming none. A later version's records are unproved here.
 */
const ompSessionVersion = (version: unknown): boolean => version === undefined || version === 1 || version === 2 || version === 3;

const sameDirectory = (a: string, b: string): boolean => {
  if (a === b) return true;
  try { return realpathSync(a) === realpathSync(b); } catch { return false; }
};

/**
 * The transcript a route's processes hold open or last pointed their terminal breadcrumb at, or
 * null. `cwd` is the pane's live directory, herdr's foreground cwd where it reports one: omp changes
 * into its `--cwd` when it starts and into a resumed session's project later, and names that
 * directory in its session header, so the live one is matched first. The absolute `--cwd` every
 * process started with is tried only when that finds nothing (herdr reports a directory that is
 * not omp's own, or none).
 */
export function ompRouteTranscript(route: OmpRoute, cwd: string): string | null {
  const { layout, pids, environOf, launchDir } = route;
  const live = heldTranscript(layout, cwd, pids, environOf);
  const path = live.found > 0 ? live.path : launchDir && launchDir !== cwd ? heldTranscript(layout, launchDir, pids, environOf).path : null;
  return path !== null && ompSessionVersion(transcriptHeader(path)?.version) ? path : null;
}

/**
 * The store of a route that holds `path`, the transcript herdr names, as written: `<cwd>/<id>.jsonl`
 * in a managed store, `<id>.jsonl` in a session directory of its own, or a subagent's file beside
 * either. null when it is not there. The caller still follows links and checks the header
 * (ompRouteOwns).
 */
export function ompRouteStore({ layout }: OmpRoute, path: string): string | null {
  if (!path.endsWith(".jsonl") || !isAbsolute(path)) return null;
  const parts = storeRelative(layout.sessions, path);
  return parts !== null && (parts.length === layout.depth || parts.length === layout.depth + 1) ? layout.sessions : null;
}

/**
 * Whether a written transcript in a route's store, links followed, is this pane's: of the shape omp
 * writes there and of a version omp reads. A session directory of its own holds every directory's
 * sessions side by side, so there the header must also name the pane's live directory (one naming
 * only the launch directory is left to ompRouteTranscript, which tries that one after the live
 * one). A managed store keeps each directory's sessions in a folder of their own, and herdr's path
 * there is taken as before, also for a session of a directory that is gone.
 */
export function ompRouteOwns({ layout }: OmpRoute, file: string, cwd: string): boolean {
  let parts: string[] | null;
  try { parts = storeRelative(realpathSync(layout.sessions), realpathSync(file)); } catch { return false; }
  if (parts === null || parts.length !== layout.depth && parts.length !== layout.depth + 1) return false;
  const header = transcriptHeader(file);
  return header !== null && ompSessionVersion(header.version) && (layout.depth === 2 || sameDirectory(header.cwd, cwd));
}

/**
 * The blob store holding the pictures of an omp transcript, or null. omp 18.8.7 keeps its sessions in
 * `<data>/sessions` and their pictures in `<data>/blobs` (`<data>` is the agent directory, or omp's
 * XDG data directory), so a session of a managed store, `<data>/sessions/<cwd>/<id>.jsonl` or a
 * subagent's file a level below it, has its blobs beside the store. A session directory of its own
 * (`--session-dir`) names no data directory, and its pictures stay unnamed. The store is found from
 * the transcript's real path, by layout alone, whether it exists yet or not: the parser, a page read
 * live and the image endpoint all ask of the store when they read a blob, and a store that is missing,
 * or a link (to another omp's store, or anywhere), answers nothing then (ompBlobPicture). A blob is
 * served only when its bytes hash to the name the transcript gave them, so a wrong guess finds nothing.
 */
export function ompBlobStore(transcript: string): string | null {
  let real: string;
  try { real = realpathSync(transcript); } catch { return null; }
  for (let dir = dirname(dirname(real)), depth = 0; depth < 2; depth += 1, dir = dirname(dir)) {
    if (basename(dir) === "sessions") return join(dirname(dir), "blobs");
  }
  return null;
}

/** The transcript the pane's omp process holds open or last pointed its terminal breadcrumb at, or null (ompRouteTranscript). */
export async function ompHeldTranscript(paneId: string, cwd: string): Promise<string | null> {
  const route = await ompPaneRoute(paneId);
  return route === null || route === "unproved" ? null : ompRouteTranscript(route, cwd);
}
