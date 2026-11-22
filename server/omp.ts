import { existsSync, realpathSync, statSync } from "node:fs";
import { userInfo } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

import { darwinProcess } from "./claude-store.ts";
import { darwinStartTime } from "./darwin-process.ts";
import { paneProcessInfo, processInfoAskedAt, type ProcessInfo } from "./herdr/client.ts";
import { heldTranscript, runsAgent, storeRelative, type StoreRoots, transcriptHeader } from "./gjc-runtime.ts";
import { ompProcessMemory, ompRoutingEnviron, processStartTicks } from "./omp-process.ts";
import { processStartIdentity } from "./process-start.ts";

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
 * `extensions` are the files `-e`, `--extension`, `--hook` and `--trusted-extension` name, which omp
 * loads even when it discovers none (`noExtensions`): under `--no-extensions`, and under
 * `--trusted-extension`, which loads only its own files (omp refuses it together with the others).
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

/** The agent directory omp loads extensions from: moving sessions does not move its configuration. */
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
 *   `$XDG_STATE_HOME/omp[/profiles/<name>]/terminal-sessions`, each only when that directory exists,
 *   on Linux and macOS (omp reads them on macOS from 18.12, and its `init-xdg` migration that makes
 *   them runs there only from then, so an older omp never finds one there);
 * - the last `--session-dir`, else PI_CODING_AGENT_SESSION_DIR, is a session directory of its own.
 * Only the environment omp was started with counts: values omp loads later from its `.env` files
 * are not seen, so such a store is not found (the transcripts lie outside the store this names).
 * null when nothing proves the store: argv omp would refuse, an environment that could not be read
 * (Linux and macOS show a same-user process's own; Windows none), a variable given twice, a
 * profile name omp refuses, a relative directory (omp resolved it against a directory nothing
 * records), an empty or missing `--session-dir` value, or on Windows an XDG omp root (omp reads
 * none there).
 */
export function ompStoreLayout(argv: readonly string[], environ: readonly string[] | null, platform: NodeJS.Platform = process.platform): OmpLayout | null {
  const launch = ompLaunch(argv);
  if (launch === null || environ === null) return null;
  const variables = new Map<string, string>();
  for (const word of environ) {
    const equals = word.indexOf("=");
    if (equals <= 0) continue;
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
    if (data === null || state === null || platform !== "linux" && platform !== "darwin" && (data || state)) return null;
    if (data) sessions = join(data, "sessions");
    if (state) terminalSessions = join(state, "terminal-sessions");
  }
  if (launch.sessionDir && !launch.sessionDirValue) return null;
  const own = launch.sessionDir ? launch.sessionDirValue : variable("PI_CODING_AGENT_SESSION_DIR") || undefined;
  if (own === undefined) return { sessions, terminalSessions, depth: 2 };
  return isAbsolute(own) ? { sessions: resolve(own), terminalSessions, depth: 1 } : null;
}

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

export interface OmpRoute {
  layout: OmpLayout;
  pids: number[];
  environOf: (pid: number) => readonly string[] | undefined;
  launchDir: string | null;
  /**
   * On macOS herdr-core, the files each process holds open (ompHeldOpen), the only proof there; null for a
   * process whose listing held a name that could not be read, so nothing is proved for it. Elsewhere /proc is read.
   */
  openFilesOf?: (pid: number) => readonly string[] | null;
  /**
   * On macOS with ompHeldFiles on, each process's start identity, read as herdr's sample that names it is
   * taken: lsof lists a process only while its start stays this one, so a pid reused since is never read.
   */
  startsOf?: ReadonlyMap<number, number>;
}

/** An lsof listing longer than this is not read: nothing is proved from a part of one. */
const LSOF_MAX_BYTES = 1 << 20;
const LSOF_DEADLINE_MS = 3000;

const LSOF_FRESH_MS = 2000;
/**
 * A name lsof listed, with the `dev:ino` of the file it held (its `D` and `i` fields), or null when lsof
 * printed neither: such a `.jsonl` proves nothing, since the name may meanwhile name another file.
 */
interface HeldName { name: string; id: string | null }
const listed = new Map<number, { identity: number; files: HeldName[] | null; at: number }>();

/** The bytes lsof's `-F n` field writes as a backslash and one letter. */
const LSOF_ESCAPES = new Map([["b", 8], ["f", 12], ["n", 10], ["r", 13], ["t", 9], ["\\", 92]]);

/**
 * A name as lsof's `-F n` field prints it, decoded from the field's bytes (a latin1 string, one char per
 * byte): lsof writes \b \f \n \r \t and \\ for those bytes and \xNN for a byte it cannot print, so
 * every backslash it prints starts an escape. Its ^X for another control byte is left as printed: a
 * name's own `^` is printed as it is, so ^X cannot be told from it. null when the field is not one lsof
 * could print (a backslash starting no escape) or its bytes are not UTF-8.
 */
function lsofName(field: string): string | null {
  const bytes: number[] = [];
  for (let at = 0; at < field.length; at += 1) {
    const char = field[at]!, next = field[at + 1] ?? "";
    const hex = field.slice(at + 2, at + 4);
    if (char !== "\\") bytes.push(char.charCodeAt(0));
    else if (LSOF_ESCAPES.has(next)) { bytes.push(LSOF_ESCAPES.get(next)!); at += 1; }
    else if (next === "x" && /^[0-9a-f]{2}$/i.test(hex)) { bytes.push(Number.parseInt(hex, 16)); at += 3; }
    else return null;
  }
  try { return new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(bytes)); } catch { return null; }
}

/**
 * The files each process holds open on macOS (`-Fpn`: a `p` line per process, then an `n` line per
 * file). omp keeps its session file open from its first write, which is the only proof of the session
 * an `omp -c` continues: omp leaves an unchanged breadcrumb as it was (#3365). A process listed in the
 * last LSOF_FRESH_MS under the start it has now is not listed again; the others are, in one lsof run.
 * That run proves nothing when it fails, runs past its deadline (then it is SIGKILLed) or prints more
 * than LSOF_MAX_BYTES; an exit of 1 with the whole listing printed means only that some pid was gone,
 * and the others' listings stand. A process counts only when its start is the same before and after
 * the run as the one read with herdr's sample (`sampled`): a pid reused meanwhile lists another omp's
 * session (as #3324 checks); every one, a listing reused too, is checked again after the last wait, just
 * before the listing is returned. A name holding a control character once decoded is no held path.
 * Each held `.jsonl` must still name the file lsof saw (its `dev:ino`) when the listing is returned, a
 * reused one too: a path renamed or replaced since proves nothing, and that listing is forgotten. A
 * process absent from the result has no listing that proves anything (ompHeldOpen).
 */
async function darwinOpenFiles(pids: readonly number[], sampled: ReadonlyMap<number, number>): Promise<Map<number, string[] | null>> {
  const open = new Map<number, HeldName[] | null>();
  const now = performance.now();
  for (const [pid, entry] of listed) if (now - entry.at >= LSOF_FRESH_MS) listed.delete(pid);
  const unlisted: { pid: number; identity: number }[] = [];
  const identities = new Map<number, number>();
  for (const pid of pids) {
    const identity = processStartIdentity(pid);
    if (identity === null || identity !== sampled.get(pid)) continue;
    identities.set(pid, identity);
    const entry = listed.get(pid);
    if (entry?.identity === identity) open.set(pid, entry.files);
    else unlisted.push({ pid, identity });
  }
  if (unlisted.length === 0) return sameStarts(open, identities);
  let child: Bun.Subprocess<"ignore", "pipe", "ignore">;
  try { child = Bun.spawn(["/usr/sbin/lsof", "-nPbw", "-a", "-p", unlisted.map(({ pid }) => pid).join(","), "-FpDin"], { stdin: "ignore", stdout: "pipe", stderr: "ignore" }); }
  catch { return sameStarts(open, identities); }
  let whole = true;
  const deadline = setTimeout(() => { whole = false; child.kill("SIGKILL"); }, LSOF_DEADLINE_MS);
  const chunks: Uint8Array[] = [];
  try {
    let size = 0;
    for await (const chunk of child.stdout) {
      size += chunk.byteLength;
      if (size > LSOF_MAX_BYTES) { whole = false; child.kill("SIGKILL"); break; }
      chunks.push(chunk);
    }
    // a listing cut off by its size or its deadline proves nothing, whatever lsof exits with
    const code = whole ? await child.exited : null;
    if (code !== 0 && code !== 1 || !whole) return sameStarts(open, identities);
  } catch { return sameStarts(open, identities); } finally { clearTimeout(deadline); }
  const fresh = new Map<number, HeldName[] | null>();
  let current: number | undefined;
  // a file's fields come before its name, which ends it
  let device: string | null = null, inode: string | null = null;
  for (const line of Buffer.concat(chunks).toString("latin1").split("\n")) {
    if (line.startsWith("p")) { fresh.set(current = Number(line.slice(1)), []); device = inode = null; }
    else if (line.startsWith("f")) device = inode = null;
    else if (line.startsWith("D") && /^0x[0-9a-f]+$/i.test(line.slice(1))) device = BigInt(line.slice(1)).toString();
    else if (line.startsWith("i") && /^\d+$/.test(line.slice(1))) inode = line.slice(1);
    else if (line.startsWith("n") && current !== undefined) {
      // a name that cannot be read may be the very session: nothing is proved for this process then
      const name = lsofName(line.slice(1));
      const files = fresh.get(current);
      if (name === null || /[\x00-\x1f\x7f]/.test(name)) fresh.set(current, null);
      else files?.push({ name, id: device !== null && inode !== null ? `${device}:${inode}` : null });
      device = inode = null;
    }
  }
  for (const { pid, identity } of unlisted) {
    const held = fresh.get(pid);
    if (held === undefined) continue;
    open.set(pid, held);
    listed.set(pid, { identity, files: held, at: now });
  }
  return sameStarts(open, identities);
}

/** The `dev:ino` a path names now, or null; read as bigints, as lsof prints them, past 2^53 too. */
function fileId(path: string): string | null {
  try { const stat = statSync(path, { bigint: true }); return `${stat.dev}:${stat.ino}`; } catch { return null; }
}

/**
 * The listings of the processes whose start is still the one read before them, by name; a changed one is
 * forgotten. A listing one of whose `.jsonl` names no longer names the file lsof saw proves nothing (null),
 * and is forgotten too.
 */
function sameStarts(open: Map<number, HeldName[] | null>, identities: ReadonlyMap<number, number>): Map<number, string[] | null> {
  const names = new Map<number, string[] | null>();
  for (const [pid, files] of open) {
    const current = files === null || files.every(({ name, id }) => !name.endsWith(".jsonl") || id !== null && fileId(name) === id);
    if (!current) listed.delete(pid);
    names.set(pid, current ? files?.map(({ name }) => name) ?? null : null);
  }
  for (const pid of names.keys()) {
    if (processStartIdentity(pid) === identities.get(pid)) continue;
    names.delete(pid);
    listed.delete(pid);
  }
  return names;
}

/** The kernel's start of a process on macOS, in microseconds, or null. */
function sampledStart(pid: number): bigint | null {
  try { return darwinStartTime(pid); } catch { return null; }
}

let heldFilesOn: () => boolean = () => false;

export function readOmpHeldFilesSetting(read: () => boolean): void {
  heldFilesOn = read;
}

/**
 * On macOS herdr-core (`core`) there is no /proc and omp's breadcrumb proves nothing (#3365): only the files a
 * process holds open do, so lsof lists them, and when it proves nothing no file is held and heldTranscript
 * binds nothing. A process with no listing that proves anything (its start unread or changed, left out by lsof,
 * lsof failed) may hold another session than the others: it is unreadable, so nothing is bound then.
 */
export async function ompHeldOpen(route: OmpRoute, core: boolean): Promise<OmpRoute> {
  if (process.platform !== "darwin" || !core || !heldFilesOn()) return route;
  const open = await darwinOpenFiles(route.pids, route.startsOf ?? new Map());
  return { ...route, openFilesOf: (pid) => open.get(pid) ?? null };
}

/**
 * null when herdr shows no live omp process in the pane; "unproved" when one's store cannot be told, two keep
 * different ones, or a live process whose argv herdr left out could not be read, since nothing then says which
 * store, or which session, the pane shows.
 */
export async function ompPaneRoute(paneId: string, known?: ProcessInfo | null): Promise<OmpRoute | "unproved" | null> {
  // `known`: herdr's answer the caller's poll already read for this pane. One that named no processes is asked again:
  // with no omp seen herdr's reported session is trusted, and an omp started since may keep another store
  const sampleStarts = process.platform === "darwin" && heldFilesOn();
  // A process that started at or after herdr was asked is not the one its sample named, but a pid reused
  // since: its start is not taken, so lsof never lists it (ompHeldOpen). `askedAt` is never later than the
  // real ask: a caller's sample counts with its own ask time (paneProcessInfo keeps it), and one whose ask
  // time is unknown is asked again. The kernel's start is in microseconds and askedAt a floored millisecond,
  // so any start in the ask's millisecond is refused too. herdr's sample carries no start, so a pid reused
  // by a process started before the ask cannot be told, nor a start under a wall clock stepped back since.
  const askedTime = known ? processInfoAskedAt(known) : undefined;
  const reuse = known != null && (!sampleStarts || askedTime !== undefined);
  const askedAt = reuse ? askedTime ?? Date.now() : Date.now();
  const info = reuse ? known : await paneProcessInfo(paneId).catch(() => null);
  let layout: OmpLayout | null = null;
  const pids: number[] = [];
  const launchDirs = new Set<string | null>();
  const environs = new Map<number, readonly string[]>();
  const starts = new Map<number, number>();
  let unread = false;
  for (const foreground of info?.foreground_processes ?? []) {
    if (typeof foreground.pid !== "number") continue;
    let argv = Array.isArray(foreground.argv) ? foreground.argv.map(String) : [];
    if (argv.length > 0 && (!isOmpProcess(argv) || isOmpHelper(argv))) continue;
    const start = sampleStarts ? sampledStart(foreground.pid) : null;
    if (start !== null && start < BigInt(askedAt) * 1000n) starts.set(foreground.pid, Number(start / 1000n));
    // Herdr omits a recognized agent's argv (on Linux, WSL included). A procfs memory read blocks
    // while the process holds its memory map locked (omp does while it pages in, and on WSL while
    // it exits), so on Linux every read goes through the bounded helper, never the bridge itself.
    const probe = process.platform === "linux";
    let environ: readonly string[] | null;
    if (probe) {
      const memory = await ompProcessMemory(foreground.pid, argv.length === 0);
      if (memory === null && argv.length > 0) return "unproved";
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
  return { layout, pids, environOf: (pid) => environs.get(pid), launchDir: launchDirs.size === 1 ? launchDir ?? null : null, startsOf: starts };
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
 * omp changes into its `--cwd` when it starts and into a resumed session's project later, and names
 * that directory in its session header, so the live one is matched first. The absolute `--cwd` every
 * process started with is tried only when that finds nothing (herdr reports a directory that is
 * not omp's own, or none).
 */
export function ompRouteTranscript(route: OmpRoute, cwd: string): string | null {
  const { layout, pids, launchDir } = route;
  const live = heldTranscript(layout, cwd, pids, route);
  const path = live.found > 0 ? live.path : launchDir && launchDir !== cwd ? heldTranscript(layout, launchDir, pids, route).path : null;
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

export async function ompHeldTranscript(paneId: string, cwd: string, core = false): Promise<string | null> {
  const route = await ompPaneRoute(paneId);
  return route === null || route === "unproved" ? null : ompRouteTranscript(await ompHeldOpen(route, core), cwd);
}
