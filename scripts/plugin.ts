/**
 * herdr plugin lifecycle for the web UI.
 *
 * herdr's startup hooks are one-shot initialization commands, not supervised
 * daemons (https://herdr.dev/docs/plugins/), so this script owns the process:
 * `start` detaches the server and records its pid under HERDR_PLUGIN_STATE_DIR,
 * `stop` takes it down, `status` reports, `pair` prints a pairing code for another device, `phone`
 * publishes the app to the user's tailnet and prints its address as a QR code. Start is idempotent — a server that is
 * already answering on the port is left alone, which is what makes it safe as
 * both a startup hook and a hand-invoked action.
 *
 * The port is settled here, before the server is spawned: with no PORT set, a default that cannot
 * be opened gives way to the next one that can (scripts/plugin-port.ts), and that choice is kept
 * for later starts and for `status`, `pair` and `phone`.
 *
 * Two pieces of herdr's runtime environment have to be translated:
 * - herdr injects HERDR_SOCKET_PATH; the server reads HERDR_SOCKET. Without the
 *   mapping a named session's plugin would talk to the default socket.
 * - plugin commands inherit herdr's environment, not the user's shell, so the
 *   token and any overrides are read from `env` and `.env` in HERDR_PLUGIN_CONFIG_DIR.
 */

import { mergeEnvLayers } from "../server/legacy-env.ts";
import { acquireOwnerDirectory, guardPath, type OwnerLease } from "../server/owner-guard.ts";
import { parseBirth, readProcessBirth } from "../server/process-owner.ts";
import { defaultStateDir } from "../server/update-state.ts";
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, chmodSync, closeSync, copyFileSync, existsSync, fstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, platform, uptime } from "node:os";
import { basename, delimiter, dirname, join, resolve } from "node:path";

import qrcode from "qrcode-generator";

import { DEFAULT_PORT } from "../shared/protocol.ts";
import { decodeOffer } from "../shared/relay-offer.ts";
import type { RemoteAccess } from "../shared/protocol.ts";
import { canServe, FALLBACK_PORTS, freePort, savedPort } from "./plugin-port.ts";
import { approvalPrompt, approves, COMMAND_ALIASES, declinedNote, link as linkPc, plainLabel } from "./plugin-link.ts";
import { activePluginScript } from "./plugin-runtime.ts";
import { accountServiceOrigin, DEFAULT_ACCOUNT_SERVICE } from "../server/static.ts";
import { herdrStateDir } from "./plugin-state.ts";
import { HTTPS_PORT_VARIABLE, HTTPS_PORTS, httpsPorts, parseTailscale, parseTailscaleIp, parseTailscaleOwner, readTailscale, tailscaleBinary } from "../server/tailscale.ts";
import { descendantProcesses, windowsArgv, windowsProcessTable } from "../server/windows-processes.ts";

/**
 * Read in this order, so `.env` wins: `env` is what this plugin read first, `.env` is what herdr's
 * plugin docs suggest, and a user who edits `.env` from those docs must not be overridden by an old `env`.
 * Declared before CONFIG_DIR, whose lookup uses it.
 */
const ENV_FILES = ["env", ".env"];
const ROOT = resolve(process.env["HERDR_PLUGIN_ROOT"] ?? join(import.meta.dir, ".."));
/** the dir under its Ovis name, or under the name before the rename while only that one exists */
function ownDir(parent: string): string {
  const legacy = join(parent, "herdr-web-ui");
  const next = join(parent, "ovis");
  return existsSync(next) || !existsSync(legacy) ? next : legacy;
}
const DEFAULT_STATE_DIR = ownDir(join(homedir(), ".local", "state"));
const PLUGIN_ID = "devswha.ovis";
/** the id before the rename: an install from then keeps it until the installer moves it to PLUGIN_ID */
const LEGACY_PLUGIN_ID = "devswha.herdr-web-ui";
const HERDR_PLUGIN_STATE = join(herdrStateDir(process.env, platform(), homedir()), "plugins");
const MANAGED_STATE_DIR = [PLUGIN_ID, LEGACY_PLUGIN_ID].map((id) => join(HERDR_PLUGIN_STATE, id)).find((dir) => existsSync(dir)) ?? join(HERDR_PLUGIN_STATE, PLUGIN_ID);
// run by hand, without herdr's HERDR_PLUGIN_STATE_DIR: a server started from a checkout keeps its
// own dir while it runs; otherwise the dir herdr gives the plugin, where its startup hook wrote
const REQUESTED_STATE_DIR = process.env["HERDR_PLUGIN_STATE_DIR"]
  ?? (pidIn(join(DEFAULT_STATE_DIR, "server.pid")) !== null || !existsSync(MANAGED_STATE_DIR) ? DEFAULT_STATE_DIR : MANAGED_STATE_DIR);
/** where the record is: the old id's dir while a server started under it runs (runningStateDir) */
let STATE_DIR = runningStateDir(REQUESTED_STATE_DIR);
const CONFIG_DIR = process.env["HERDR_PLUGIN_CONFIG_DIR"] ?? herdrConfigDir() ?? ownDir(join(homedir(), ".config"));
adoptLegacyConfig(CONFIG_DIR);
let PID_FILE = join(STATE_DIR, "server.pid");
let LOG_FILE = join(STATE_DIR, "server.log");
/** the recorded server's pid and birth, so a pid handed on to another process is not taken for it */
let OWNER_FILE = join(STATE_DIR, "server.owner");
/**
 * Finds the record again once this process has its turn: the server a start or stop before it
 * waited on may have stopped meanwhile, and the old id's dir with it.
 */
function settleStateDir(): void {
  STATE_DIR = runningStateDir(REQUESTED_STATE_DIR);
  PID_FILE = join(STATE_DIR, "server.pid");
  LOG_FILE = join(STATE_DIR, "server.log");
  OWNER_FILE = join(STATE_DIR, "server.owner");
}
/**
 * Starts and stops take turns through this lock: a start holds it from deciding whether a server
 * runs until its own answers (or fails), a stop until the server is gone. Without it a second start
 * found the first one's server spawned but not on its port yet, spawned another and overwrote its
 * record, and `stop` then missed the server that kept running (#1611). It is kept in the dir herdr
 * hands the plugin, not the one the record is in, which can change while a start waits for its turn.
 */
const LIFECYCLE_LOCK = join(REQUESTED_STATE_DIR, "lifecycle.lock");
const LIFECYCLE_BUSY = "another start or stop of Ovis is running";
/** longer than a start holds the lock (its port wait and its readiness wait, 20 s each) or a stop does */
const LIFECYCLE_WAIT_MS = 60_000;
/** the server needs a moment to bind and open its first herdr connection */
const READY_TIMEOUT_MS = 20_000;
/** the supervisor gives its bridge 6 s to exit before it kills it */
const STOP_TIMEOUT_MS = 15_000;
/** how long a killed server gets to disappear before `stop` reports that it could not stop it */
const KILL_WAIT_MS = 3_000;
/** `tailscale serve` waits while the user turns HTTPS on for the tailnet at the link it prints */
const SERVE_TIMEOUT_MS = 180_000;
/** how to come back to `phone` once Tailscale is set up: an action's output goes to herdr's log, not a terminal */
const PHONE_AGAIN = platform() === "win32"
  ? "irm https://ovis.sh/install.ps1 | iex"
  : "curl -fsSL https://ovis.sh/install.sh | sh";

/**
 * Run by hand (`pair` on a headless PC), herdr's env is not there to name the config dir:
 * ask herdr for it, so the PORT, HOST and token the plugin runs with are the ones used.
 */
function herdrConfigDir(): string | null {
  const herdr = Bun.which("herdr");
  if (herdr === null) return null;
  for (const id of [PLUGIN_ID, LEGACY_PLUGIN_ID]) {
    try {
      const result = Bun.spawnSync([herdr, "plugin", "config-dir", id], { windowsHide: true, stdout: "pipe", stderr: "ignore", timeout: 3000 });
      const dir = result.exitCode === 0 ? result.stdout.toString().trim() : "";
      if (dir !== "" && ENV_FILES.some((name) => existsSync(join(dir, name)))) return dir;
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * herdr keeps a plugin's config dir by its id (`plugins/config/<id>`), so the settings and token
 * an install wrote under the old id are copied to the new id's dir the first time it has none.
 * The old dir stays: the plugin under the old id, still installed until the installer removes
 * it, reads it too.
 */
function adoptLegacyConfig(dir: string): void {
  if (basename(dir) !== PLUGIN_ID || ENV_FILES.some((name) => existsSync(join(dir, name)))) return;
  const legacy = join(dirname(dir), LEGACY_PLUGIN_ID);
  for (const name of ENV_FILES) {
    const from = join(legacy, name);
    if (!existsSync(from)) continue;
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    copyFileSync(from, join(dir, name));
    // the token is in there: keep the old file's owner-only mode
    chmodSync(join(dir, name), statSync(from).mode & 0o777);
  }
}

/** `KEY=value` lines of one settings file */
function readEnvFile(file: string): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    vars[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
  }
  return vars;
}

/** the settings files in the plugin's config dir: the token lives here, not in herdr's env */
const CONFIG_FILES = ENV_FILES.map((name) => join(CONFIG_DIR, name)).filter((file) => existsSync(file));
const fileVars = CONFIG_FILES.map(readEnvFile);
/** keys both files set to different values: `.env` wins, which someone editing `env` would not expect */
const shadowed = fileVars.length === 2 ? Object.keys(fileVars[0]!).filter((key) => key in fileVars[1]! && fileVars[0]![key] !== fileVars[1]![key]) : [];
const env = mergeEnvLayers([process.env, ...fileVars]);
/** HERDR_SOCKET the user put in the config files: it names the session to show, so herdr's own socket does not replace it */
const configuredSocket = fileVars.some((vars) => (vars["HERDR_SOCKET"] ?? "") !== "");
const PATH_KEY = platform() === "win32" ? Object.keys(env).sort().find(key => key.toLowerCase() === "path") ?? "PATH" : "PATH";
/** the app's own state, as the server finds it (server/update-state.ts): the same path with or without herdr's env */
const APP_STATE_DIR = defaultStateDir(env);
/** the port a start took because the default could not be opened; absent while the default serves */
const PORT_FILE = join(APP_STATE_DIR, "plugin-port");
/** a PORT the user set is theirs: it is never swapped for another */
const portSet = (env["PORT"] ?? "") !== "";
let port = portSet ? Number(env["PORT"]) : savedPort(PORT_FILE) ?? DEFAULT_PORT;
const host = env["HOST"] ?? "127.0.0.1";
const ipv6Loopback = env["OVIS_IPV6_LOOPBACK"] === "1";
const originOf = (value: number): string => `http://${host === "0.0.0.0" ? "127.0.0.1" : host}:${value}`;
let origin = originOf(port);

/**
 * herdr's PATH plus where the one-line installer (install.sh) puts Bun, Node and herdr: herdr may
 * have been started from a shell that has none of them, and the server spawns `node` for every
 * terminal. Appended, so a Node the user chose (nvm, Homebrew) still comes first.
 */
function toolPath(): string {
  const current = (env[PATH_KEY] ?? "").split(delimiter).filter(Boolean);
  const home = homedir();
  const extra = [join(home, ".bun", "bin"), join(home, ".local", "bin"), join(home, ".local", "share", "ovis", "node", "bin"), join(home, ".local", "share", "herdr-web-ui", "node", "bin")];
  return [...current, ...extra.filter((dir) => existsSync(dir) && !current.includes(dir))].join(delimiter);
}

/** A clickable address where a terminal shows it (OSC 8), plain where the output goes to a log or a file. */
function link(url: string): string {
  return process.stdout.isTTY ? `\x1b]8;;${url}\x1b\\${url}\x1b]8;;\x1b\\` : url;
}

function qr(text: string): string {
  const code = qrcode(0, "M");
  code.addData(text);
  code.make();
  return code.createASCII(1, 1);
}

async function health(): Promise<boolean> {
  try {
    const response = await fetch(`${origin}/api/health`, { signal: AbortSignal.timeout(1500) });
    if (!response.ok) return false;
    // the port may hold another program's 200 (a kept port that went stale): only the app's answer
    // counts, in the shape every release has sent (server/index.ts)
    const body = await response.json() as { ok?: unknown; herdr?: unknown; auth?: unknown };
    return body.ok === true && typeof body.herdr === "object" && body.herdr !== null && appAuth(body.auth);
  } catch {
    return false;
  }
}

/** Whether the app holds the port: its bridge health answers without asking herdr. */
async function appOnPort(): Promise<boolean> {
  try {
    const response = await fetch(`${origin}/api/health?scope=bridge`, { signal: AbortSignal.timeout(1500) });
    if (!response.ok) return false;
    // another program's JSON can say ok too: only the app's own answer (server/index.ts) counts
    const body = (await response.json()) as { ok?: unknown; auth?: unknown; bridge_protocol?: unknown };
    return body.ok === true && Number.isInteger(body.bridge_protocol) && appAuth(body.auth);
  } catch {
    return false;
  }
}

/** The `auth` the app's health answers carry: whether a token is required and whether this request got in. */
function appAuth(auth: unknown): boolean {
  const fields = auth as { required?: unknown; authenticated?: unknown } | null | undefined;
  return typeof fields?.required === "boolean" && typeof fields.authenticated === "boolean";
}

/** Why the app's full health fails, as it says: herdr's error while herdr is away; null when it answers now (herdr came back). */
async function healthError(): Promise<string | null> {
  try {
    // short, as health() is: the wait before this has already spent the start's deadline
    const response = await fetch(`${origin}/api/health`, { signal: AbortSignal.timeout(1500) });
    const body = (await response.json()) as { ok?: unknown; error?: { message?: unknown } };
    if (response.ok && body.ok === true) return null;
    return typeof body.error?.message === "string" ? body.error.message : `its health check answered ${response.status}`;
  } catch {
    return "its health check did not answer";
  }
}

function recordedPid(): number | null {
  return pidIn(PID_FILE);
}

/**
 * The recorded server while it may still run: null once it is proved gone or replaced, or when no
 * record of its identity was kept (recordedServer).
 */
function provedServer(): number | null {
  const pid = recordedPid();
  // an exited server its parent has not reaped yet still answers signal 0, with its birth
  if (pid === null || liveProcess(pid) === false) return null;
  return recordedServer(pid) === "ours" ? pid : null;
}

/**
 * What the record says of the process under `pid`: "replaced" once the recorded server is proved
 * gone or another process holds its pid (the pid is free, another birth runs there now, or, for a
 * record without a birth, the PC restarted after it was recorded); "unrecorded" when no record of its identity was kept (a server
 * started by a version before this one); else "ours". A birth that could not be read, when it was
 * recorded or now, proves nothing either way, so the server counts as ours.
 */
function recordedServer(pid: number): "ours" | "replaced" | "unrecorded" {
  let owner: { pid?: unknown; birth?: unknown; birth_unknown?: unknown } | null = null;
  let recordedAt = 0;
  try {
    owner = JSON.parse(readFileSync(OWNER_FILE, "utf8")) as typeof owner;
    recordedAt = statSync(OWNER_FILE).mtimeMs;
  } catch { /* none kept */ }
  if (owner?.pid !== pid) return "unrecorded";
  const now = readProcessBirth(pid);
  if (now.state === "absent") return "replaced";
  // a recorded birth alone decides (Linux's carries the boot id): the wall clock can step forward
  // (NTP on a PC without a clock of its own, a resumed VM) and make a live server look older than this boot
  const birth = parseBirth(owner.birth);
  if (birth !== null && birth.platform === process.platform) return now.state === "unknown" || now.birth.value === birth.value ? "ours" : "replaced";
  if (owner.birth_unknown !== true) return "unrecorded";
  // no birth to compare: a record from before this boot names a process that is gone
  if (recordedAt < Date.now() - uptime() * 1000 - 1000) return "replaced";
  return now.state === "identified" && startedAfter(now.birth.value, recordedAt) ? "replaced" : "ours";
}

/** Whether a birth read now is of a process that started after `time` (ms), where the platform's birth is a time. */
function startedAfter(birth: string, time: number): boolean {
  if (process.platform === "win32") return Number(birth) > time;
  if (process.platform === "darwin") {
    // `ps -o lstart` under TZ=UTC, to the second: "Wed Oct 21 17:41:40 2026"
    const [, month, day, clock, year] = birth.split(" ");
    return Date.parse(`${month} ${day} ${year} ${clock} UTC`) > time + 1000;
  }
  return false; // Linux: ticks after boot; a reused pid within one boot needs the pid space to wrap
}

/** the live process a pid file names, or null */
/**
 * herdr keeps a plugin's state dir by its id too. A server started under the old id keeps its pid
 * in the old id's dir until it stops (the installer stops it before moving the install to the new
 * id; `herdr plugin update` never moves the id), so `stop` and `status` read that dir while it runs.
 */
function runningStateDir(dir: string): string {
  if (basename(dir) !== PLUGIN_ID || pidIn(join(dir, "server.pid")) !== null) return dir;
  const legacy = join(dirname(dir), LEGACY_PLUGIN_ID);
  return pidIn(join(legacy, "server.pid")) !== null ? legacy : dir;
}

function pidIn(file: string): number | null {
  if (!existsSync(file)) return null;
  const pid = Number(readFileSync(file, "utf8").trim());
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    process.kill(pid, 0);
    return pid;
  } catch {
    return null;
  }
}


/**
 * Waits for this process's turn to start or stop: the lease, or why there is none. A lock whose
 * owner is proved gone (it crashed, or the PC restarted under it) is taken over at once.
 */
async function takeTurn(): Promise<OwnerLease | string> {
  // the lock reports a guard it cannot open as a start in progress: a state dir this user cannot
  // write would then be waited on for a minute, and its message would name a lock nobody holds
  try { closeSync(openSync(guardPath(LIFECYCLE_LOCK), "a", 0o600)); }
  catch (error) { return `${guardPath(LIFECYCLE_LOCK)} could not be opened: ${(error as Error).message}`; }
  const deadline = Date.now() + LIFECYCLE_WAIT_MS;
  let said = false;
  for (;;) {
    try {
      // never blocked on the lock's native guard: a holder stopped while it holds it would outlast the deadline
      return acquireOwnerDirectory(LIFECYCLE_LOCK, { running: LIFECYCLE_BUSY, starting: LIFECYCLE_BUSY }, {}, { wait: false });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // anything else (the state dir cannot be written) does not pass by waiting
      if (!message.startsWith(LIFECYCLE_BUSY)) return message;
      if (Date.now() >= deadline) return `${message} and did not finish within ${LIFECYCLE_WAIT_MS / 1000}s; if none is running, remove ${LIFECYCLE_LOCK}`;
      if (!said) process.stdout.write(`${message}; waiting for it to finish\n`);
      said = true;
    }
    await Bun.sleep(250);
  }
}

/** names the keys only, never their values: a token must not reach herdr's log */
function warnShadowed(): void {
  if (shadowed.length === 0) return;
  process.stdout.write(`both env and .env in ${CONFIG_DIR} set ${shadowed.join(", ")}; .env wins. Merge them into one file.\n`);
}

/**
 * A start's failure, in full to herdr's plugin log and in one line to server.log: the Windows
 * launcher runs this in a hidden console, so the log is all it can show. A start that opened its
 * server's log passes that handle, so the line stays with its run if the log has moved meanwhile.
 */
function failStart(message: string, detail = "", log: number | string = LOG_FILE): number {
  process.stderr.write(`${message}${detail}\n`);
  appendFileSync(log, `start: ${message}\n`);
  return 1;
}

/** A failed start reads at most this much of the log's end, so a log of any size costs the same. */
const LOG_TAIL_BYTES = 64 * 1024;

/**
 * What the server wrote to `log` since `offset`: its own error is in the last lines. Read through
 * the start's own handle, so a log another start has moved meanwhile is still this run's.
 */
function logSince(log: number, offset: number): string {
  const size = fstatSync(log).size;
  // a cut read's first byte only shows whether the next one starts a line
  const from = Math.max(offset, size - LOG_TAIL_BYTES);
  const bytes = Buffer.alloc(Math.max(0, size - from));
  let text = bytes.subarray(0, readSync(log, bytes, 0, bytes.length, from)).toString("utf8");
  // a read that starts mid-file drops its cut-off first piece, unless that piece is all there is
  if (from > offset) {
    const rest = text.slice(text.indexOf("\n") + 1);
    if (rest.trim() !== "") text = rest;
  }
  const lines = text.split("\n").filter((line) => line.trim() !== "");
  return lines.length === 0 ? "(nothing)" : lines.slice(-15).join("\n");
}

/**
 * Keeps the run before this one as server.log.1 rather than appending every run to one file. A
 * recorded server that is still alive may still write the log, so it is appended to then, as is a
 * log that cannot be moved (Windows refuses while some program holds it open without sharing).
 */
function keepPreviousLog(): void {
  if (recordedPid() !== null) return;
  try {
    renameSync(LOG_FILE, `${LOG_FILE}.1`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    const message = `appending to ${LOG_FILE}: it could not be moved to ${LOG_FILE}.1 (${(error as Error).message})`;
    process.stdout.write(`${message}\n`);
    // the Windows launcher's console is hidden: the log is where this can be read
    appendFileSync(LOG_FILE, `start: ${message}\n`);
  }
}

/**
 * Leaves `port` on one the server can open, or says why none is. Returns "running" when the port
 * was held by a server of ours that came up meanwhile.
 */
async function settlePort(): Promise<"ready" | "running" | "failed"> {
  if (await canServe(host, port, ipv6Loopback)) return "ready";
  // a start still coming up holds the port: wait for it rather than open a second server beside it
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (recordedPid() !== null && Date.now() < deadline) {
    // that start may have moved to another port itself: follow its choice, or two servers end up side by side
    const kept = portSet ? port : savedPort(PORT_FILE) ?? DEFAULT_PORT;
    if (kept !== port) {
      port = kept;
      origin = originOf(port);
    }
    if (await health()) return "running";
    await Bun.sleep(250);
  }
  // the app holds the port but cannot reach herdr: another port would put a second server beside it (#428)
  if (await appOnPort()) {
    if (await health()) return "running";
    const why = await healthError();
    if (why === null) return "running";
    const pid = recordedPid();
    failStart(`Ovis is running at ${origin}${pid === null ? "" : ` (pid ${pid})`} but cannot reach herdr: ${why}. It keeps this port and answers again once herdr is back.`);
    return "failed";
  }
  const settings = CONFIG_FILES.at(-1) ?? join(CONFIG_DIR, "env");
  const blocked = platform() === "win32"
    ? `port ${port} on ${host} cannot be opened: another program has it, or Windows reserves it for Hyper-V, WSL2 or Docker (netsh interface ipv4 show excludedportrange protocol=tcp lists the reserved ranges).`
    : `port ${port} on ${host} cannot be opened: another program has it.`;
  if (portSet) {
    failStart(`${blocked} Set another PORT in ${settings}`);
    return "failed";
  }
  const free = await freePort(port, DEFAULT_PORT, (candidate) => canServe(host, candidate, ipv6Loopback));
  if (free === null) {
    failStart(`${blocked} Neither can ${[DEFAULT_PORT, ...FALLBACK_PORTS].filter((candidate) => candidate !== port).join(", ")}. Put PORT=<a free port> in ${settings}`);
    return "failed";
  }
  process.stdout.write(`${blocked} Using port ${free} instead; to choose one yourself, put PORT=<port> in ${settings}\n`);
  port = free;
  origin = originOf(port);
  return "ready";
}

async function start(): Promise<number> {
  warnShadowed();
  if (await health()) {
    process.stdout.write(`Ovis already running at ${origin}\n`);
    return 0;
  }
  mkdirSync(REQUESTED_STATE_DIR, { recursive: true });
  const turn = await takeTurn();
  if (typeof turn === "string") return failStart(`could not start Ovis: ${turn}`);
  try {
    settleStateDir();
    return await startInTurn();
  } finally {
    turn.release();
  }
}

/** The rest of `start`, while no other start or stop runs: a server another start recorded is seen here. */
async function startInTurn(): Promise<number> {
  // a start this one waited for may have moved to another port and come up there
  if (!portSet) {
    const kept = savedPort(PORT_FILE) ?? DEFAULT_PORT;
    if (kept !== port) {
      port = kept;
      origin = originOf(port);
    }
  }
  if (await health()) {
    process.stdout.write(`Ovis already running at ${origin}\n`);
    return 0;
  }
  const settled = await settlePort();
  if (settled === "failed") return 1;
  if (settled === "running") {
    process.stdout.write(`Ovis already running at ${origin}\n`);
    return 0;
  }
  // a server an earlier start left running (it did not answer in time: herdr was away, say) may
  // have let go of its port for a moment; another server would stop at its supervisor's lock and
  // take over its record, and `stop` would then miss the one that runs
  const running = provedServer();
  if (running !== null) return failStart(`Ovis (pid ${running}) is still running but does not answer ${origin}/api/health. Stop it before starting it again.`);
  if (!portSet) {
    // kept, so the address a phone or a bookmark holds survives a restart
    if (port === DEFAULT_PORT) rmSync(PORT_FILE, { force: true });
    else {
      mkdirSync(APP_STATE_DIR, { recursive: true, mode: 0o700 });
      writeFileSync(`${PORT_FILE}.tmp`, `${port}\n`, { mode: 0o600 });
      renameSync(`${PORT_FILE}.tmp`, PORT_FILE);
    }
  }
  keepPreviousLog();
  // readable too: a failed start reads its server's last lines back through this handle
  const log = openSync(LOG_FILE, "a+");
  const logged = fstatSync(log).size;
  const child = spawn(process.execPath, [join(ROOT, "server", "managed.ts")], {
    cwd: ROOT,
    detached: true,
    windowsHide: true,
    stdio: ["ignore", log, log],
    env: {
      ...env,
      [PATH_KEY]: toolPath(),
      HOST: host,
      PORT: String(port),
      // herdr hands the plugin HERDR_SOCKET_PATH; the server (and the attach it
      // spawns) reads HERDR_SOCKET. A HERDR_SOCKET set in the config files wins.
      ...(env["HERDR_SOCKET_PATH"] !== undefined && !configuredSocket ? { HERDR_SOCKET: env["HERDR_SOCKET_PATH"] } : {}),
    },
  });
  child.unref();
  if (child.pid === undefined) {
    process.stderr.write("could not spawn the server\n");
    return 1;
  }
  try {
    // the identity first: a reader that finds the pid finds what it was
    const birth = readProcessBirth(child.pid);
    writeRecord(OWNER_FILE, `${JSON.stringify({ pid: child.pid, ...(birth.state === "identified" ? { birth: birth.birth } : { birth_unknown: true }) })}\n`);
    writeRecord(PID_FILE, `${child.pid}\n`);
  } catch (error) {
    // a server nothing records would run on unmanaged: `stop` could not find it
    const stopped = await stopSpawned(child);
    forgetServer(child.pid);
    return failStart(`could not record the server it started (pid ${child.pid}): ${(error as Error).message}; ${stopped ? "it was stopped" : "it may still be running"}`, "", log);
  }

  const deadline = Date.now() + READY_TIMEOUT_MS;
  // a server that has exited will not answer: its last words are in the log now
  while (Date.now() < deadline && child.exitCode === null) {
    if (await health()) {
      process.stdout.write(`Ovis listening at ${origin}\n`);
      if ((env["OVIS_TOKEN"] ?? "") === "") {
        process.stdout.write(`no token set: your own Tailscale devices get in as you; pair any other device in Settings → Devices, or put OVIS_TOKEN=<token> in ${join(CONFIG_DIR, "env")}\n`);
      }
      return 0;
    }
    await Bun.sleep(250);
  }
  const why = child.exitCode === null
    ? `server did not answer ${origin}/api/health within ${READY_TIMEOUT_MS / 1000}s`
    : `the server stopped (exit ${child.exitCode}) before it answered ${origin}/api/health`;
  return failStart(why, `; ${LOG_FILE} ends with:\n${logSince(log, logged)}`, log);
}

/** Written whole or not at all: a reader never finds half a record. */
function writeRecord(file: string, text: string): void {
  const staging = `${file}.tmp`;
  try {
    writeFileSync(staging, text, { mode: 0o600 });
    renameSync(staging, file);
  } catch (error) {
    rmSync(staging, { force: true });
    throw error;
  }
}

/** Removes the records that name `pid`, and only those: a start that ran meanwhile may have recorded its own server. */
function forgetServer(pid: number): void {
  try { if (Number(readFileSync(PID_FILE, "utf8").trim()) === pid) rmSync(PID_FILE, { force: true }); } catch { /* none */ }
  try { if ((JSON.parse(readFileSync(OWNER_FILE, "utf8")) as { pid?: unknown }).pid === pid) rmSync(OWNER_FILE, { force: true }); } catch { /* none, or not a record */ }
}

/** Stops a server this start spawned and returns once it is gone (its process group, on Unix), or false if it did not go. */
async function stopSpawned(child: ReturnType<typeof spawn>): Promise<boolean> {
  const pid = child.pid!;
  const windows = platform() === "win32";
  try {
    if (windows) stopDependencies.terminateTree(pid);
    else process.kill(-pid, "SIGKILL");
  } catch { /* gone meanwhile */ }
  const exited = () => child.exitCode !== null || child.signalCode !== null;
  const gone = (): boolean => {
    if (!exited()) return false;
    if (windows) return true;
    try { process.kill(-pid, 0); } catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; }
    return liveProcess(-pid) === false;
  };
  const deadline = Date.now() + KILL_WAIT_MS;
  while (!gone() && Date.now() < deadline) await Bun.sleep(50);
  return gone();
}

/**
 * Whether a process (a pid) or process group (a negative pgid) has a member that has not exited,
 * from /proc: a zombie, exited but not yet reaped by its parent, still answers `kill(pid, 0)`.
 * null without /proc (macOS), where signal 0 is all there is.
 */
function liveProcess(target: number): boolean | null {
  if (!existsSync("/proc/self/stat")) return null;
  // "<pid> (<comm>) <state> <ppid> <pgrp> ...": comm may hold spaces and parens
  const stat = (pid: string): { state: string; group: number } | null => {
    try {
      const fields = readFileSync(`/proc/${pid}/stat`, "utf8");
      const [state, , group] = fields.slice(fields.lastIndexOf(")") + 2).split(" ");
      return { state: state!, group: Number(group) };
    } catch {
      return null; // gone meanwhile
    }
  };
  if (target > 0) {
    const own = stat(String(target));
    return own !== null && own.state !== "Z";
  }
  return readdirSync("/proc").some((pid) => {
    if (!/^\d+$/.test(pid)) return false;
    const member = stat(pid);
    return member !== null && member.group === -target && member.state !== "Z";
  });
}

type StopDependencies = {
  readonly isWindows: boolean;
  readonly processTable: typeof windowsProcessTable;
  readonly isAlive: (pid: number) => boolean;
  readonly terminateTree: (pid: number) => { status: number | null; error: Error | undefined; stderr: string };
};

const stopDependencies: StopDependencies = {
  isWindows: platform() === "win32",
  processTable: windowsProcessTable,
  isAlive(pid) {
    try { process.kill(pid, 0); return true; }
    catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
  },
  terminateTree(pid) {
    const result = spawnSync("taskkill", ["/pid", String(pid), "/t", "/f"], { windowsHide: true, encoding: "utf8" });
    return {
      status: result.status,
      error: result.error,
      stderr: result.stderr?.trim() ?? "",
    };
  },
};

/**
 * Returns once the server is gone. It stops answering at once, but its supervisor holds the
 * checkout's lock until the bridge under it exits, and a `start` before then finds that lock,
 * gives up, and leaves nothing running.
 */
export async function stop(dependencies: StopDependencies = stopDependencies): Promise<number> {
  // no start made the dir, and no server runs under the old id's: nothing to stop
  if (!existsSync(REQUESTED_STATE_DIR) && recordedPid() === null) {
    process.stdout.write("Ovis is not running\n");
    return 0;
  }
  mkdirSync(REQUESTED_STATE_DIR, { recursive: true });
  const turn = await takeTurn();
  if (typeof turn === "string") {
    process.stderr.write(`could not stop Ovis: ${turn}\n`);
    return 1;
  }
  try {
    settleStateDir();
    return await stopInTurn(dependencies);
  } finally {
    turn.release();
  }
}

async function stopInTurn(dependencies: StopDependencies): Promise<number> {
  const pid = recordedPid();
  if (pid === null) {
    rmSync(PID_FILE, { force: true });
    process.stdout.write("Ovis is not running\n");
    return 0;
  }
  // the whole process group when the server leads one, as `start` spawns it
  let target = dependencies.isWindows ? pid : -pid;
  if (dependencies.isWindows) {
    // A stale PID can belong to another app, or a newer instance of this plugin.
    const recordedAt = statSync(PID_FILE).mtimeMs;
    const processes = await dependencies.processTable();
    const owner = processes.find(row => row.pid === pid);
    const argv = windowsArgv(owner?.commandLine ?? "");
    if (owner?.path?.toLowerCase() !== process.execPath.toLowerCase()
      || argv[1]?.toLowerCase() !== join(ROOT, "server", "managed.ts").toLowerCase()
      || owner.started === undefined || owner.started > recordedAt
      || !existsSync(PID_FILE) || statSync(PID_FILE).mtimeMs !== recordedAt
      || Number(readFileSync(PID_FILE, "utf8").trim()) !== pid) {
      process.stderr.write("could not verify the recorded Ovis process; it was left running and its pid file was kept\n");
      return 1;
    }
    const tree = [owner, ...descendantProcesses(processes, pid).flatMap(({ pid: memberPid }) => {
      const member = processes.find(row => row.pid === memberPid);
      return member ? [member] : [];
    })];
    // Windows has no Unix process groups or graceful SIGTERM: include the supervisor and bridge.
    const killed = dependencies.terminateTree(pid);
    if (killed.status !== 0 && recordedPid() !== null) {
      process.stderr.write(`could not stop Ovis: ${killed.error?.message ?? killed.stderr.trim()}\n`);
      return 1;
    }
    const deadline = Date.now() + 10_000;
    let exited = false;
    while (Date.now() < deadline) {
      // the process table (a PowerShell query, seconds on a busy PC) only tells a reused number from
      // a member still running: once every number is free, the tree is gone without asking it
      const alive = tree.filter(member => dependencies.isAlive(member.pid));
      if (alive.length === 0) { exited = true; break; }
      const currentProcesses = await dependencies.processTable(Math.max(1, deadline - Date.now()));
      const running = alive.some(member => {
        if (!dependencies.isAlive(member.pid)) return false;
        const current = currentProcesses.find(row => row.pid === member.pid);
        return !(member.started !== undefined && current?.started !== undefined && current.started !== member.started);
      });
      if (!running) { exited = true; break; }
      await Bun.sleep(50);
    }
    if (!exited) {
      process.stderr.write("could not confirm Ovis stopped; its pid file was kept\n");
      return 1;
    }
    // Never send another kill to a number Windows may have reassigned after taskkill.
    if (existsSync(PID_FILE) && statSync(PID_FILE).mtimeMs === recordedAt
      && Number(readFileSync(PID_FILE, "utf8").trim()) === pid) rmSync(PID_FILE);
    process.stdout.write(`stopped Ovis (pid ${pid})\n`);
    return 0;
  } else {
    // the recorded server is gone and its pid is someone else's now: nothing of ours to signal. A
    // record without the server's identity (from a version before it was kept) is signalled as before
    if (recordedServer(pid) === "replaced") {
      forgetServer(pid);
      process.stdout.write(`Ovis is not running (pid ${pid} now belongs to another process)\n`);
      return 0;
    }
    try {
      process.kill(target, "SIGTERM");
    } catch {
      target = pid;
      process.kill(pid, "SIGTERM");
    }
  }
  const running = (): boolean => {
    try {
      process.kill(target, 0);
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "EPERM";
    }
    // an exited server its parent has not reaped yet still answers signal 0
    return liveProcess(target) ?? true;
  };
  const deadline = Date.now() + STOP_TIMEOUT_MS;
  while (running() && Date.now() < deadline) await Bun.sleep(100);
  const killed = running();
  // a lone process (no group of its own) that exited and whose pid another process took meanwhile is not ours to kill
  const handedOn = killed && target === pid && recordedServer(pid) === "replaced";
  if (killed && !handedOn) {
    try { process.kill(target, "SIGKILL"); } catch { /* gone meanwhile */ }
    // SIGKILL only asks: the lock is free, and a start can follow, once the group is gone
    const killDeadline = Date.now() + KILL_WAIT_MS;
    while (running() && Date.now() < killDeadline) await Bun.sleep(100);
    if (running()) {
      process.stderr.write(`Ovis (pid ${pid}) is still running after SIGKILL; its pid file is kept\n`);
      return 1;
    }
  }
  // a start that ran meanwhile may have recorded its own server: leave that one's records alone
  forgetServer(pid);
  process.stdout.write(`stopped Ovis (pid ${pid})${killed && !handedOn ? `; it was still running after ${STOP_TIMEOUT_MS / 1000}s, so it was killed` : ""}\n`);
  return 0;
}

/**
 * A pairing code for another device, printed here. A headless PC has no browser of its own to
 * open Settings → Devices in, so this is how its owner lets a phone in: the code, the address the
 * phone opens (when Tailscale serves one), and that address as a QR code for a screen to scan.
 */
async function pair(): Promise<number> {
  if (process.argv.includes("--approve")) return approvePairings();
  if (!(await health())) {
    process.stderr.write(`Ovis is not running at ${origin}; start it first\n`);
    return 1;
  }
  const headers: Record<string, string> = { "content-type": "application/json", "x-herdr-machine": "1" };
  if ((env["OVIS_TOKEN"] ?? "") !== "") headers["authorization"] = `Bearer ${env["OVIS_TOKEN"]}`;
  const started = await fetch(`${origin}/api/devices/pair/start`, { method: "POST", headers, body: "{}" });
  if (!started.ok) {
    process.stderr.write(`could not start a pairing (${started.status}): ${await started.text()}\n`);
    return 1;
  }
  const { code } = (await started.json()) as { code: string; expires_at: string };
  let url: string | null = null;
  try {
    const access = (await (await fetch(`${origin}/api/access`, { headers })).json()) as { tailscale: { serving_url: string | null } };
    url = access.tailscale.serving_url;
  } catch { /* an older server: the code alone */ }
  const out: string[] = [`Pairing code: ${code.slice(0, 3)} ${code.slice(3)}   (good for 10 minutes, for one device)`];
  if (url !== null) {
    out.push(`On the other device, open ${link(url)} and enter the code, or scan this to open it with the code filled in:`, "");
    out.push(qr(`${url}/?pair=${code}`));
  } else {
    out.push("On the other device, open the app's address and enter the code. Settings → Phone, on any signed-in device, shows the address and how to get one.");
  }
  try {
    const relayResponse = await fetch(`${origin}/api/relay`, { headers, signal: AbortSignal.timeout(5000) });
    if (relayResponse.status !== 404) {
      if (!relayResponse.ok) throw new Error(`relay status request failed (${relayResponse.status})`);
      const relayStatus: unknown = await relayResponse.json();
      if (typeof relayStatus !== "object" || relayStatus === null || !("phase" in relayStatus) || typeof relayStatus.phase !== "string") {
        throw new Error("invalid relay status response");
      }
      if (relayStatus.phase === "online") {
        const offerResponse = await fetch(`${origin}/api/relay/offer`, {
          method: "POST",
          headers: { ...headers, "x-herdr-update": "1", origin },
          body: "{}",
          signal: AbortSignal.timeout(5000),
        });
        if (!offerResponse.ok) throw new Error(`relay offer request failed (${offerResponse.status})`);
        const offer: unknown = await offerResponse.json();
        if (typeof offer !== "object" || offer === null || !("url" in offer) || typeof offer.url !== "string" || !offer.url.includes("#offer=")) {
          throw new Error("invalid relay offer response");
        }
        if (!decodeOffer(offer.url)) throw new Error("invalid relay offer URL");
        out.push("", "Ovis relay", link(offer.url), "", qr(offer.url));
      } else {
        out.push("To turn on Ovis relay: Settings -> Devices and PCs -> Ovis relay.");
      }
    }
  } catch (error) {
    process.stderr.write(`Could not read Ovis relay pairing: ${error instanceof Error ? error.message : String(error)}\n`);
  }
  process.stdout.write(out.join("\n") + "\n");
  return 0;
}

/**
 * `pair --approve`: the devices waiting to pair through the relay by comparing digits, one by one,
 * with the digits their screens show, approved or declined here. The PC's terminal is the PC
 * itself, so this is approval on this PC (docs/account.md, "Who may admit a device").
 */
async function approvePairings(): Promise<number> {
  if (!(await health())) {
    process.stderr.write(`Ovis is not running at ${origin}; start it first\n`);
    return 1;
  }
  const headers: Record<string, string> = { "content-type": "application/json", "x-herdr-machine": "1", "x-herdr-update": "1", origin };
  if ((env["OVIS_TOKEN"] ?? "") !== "") headers["authorization"] = `Bearer ${env["OVIS_TOKEN"]}`;
  const listed = await fetch(`${origin}/api/relay/pairings`, { headers });
  if (!listed.ok) {
    process.stderr.write(`could not read the waiting pairings (${listed.status}): ${await listed.text()}\n`);
    return 1;
  }
  const { pairings } = (await listed.json()) as { pairings: { id: string; label: string; digits: string; intent?: string }[] };
  if (pairings.length === 0) {
    process.stdout.write("No device is waiting to pair.\n");
    return 0;
  }
  const lines = console[Symbol.asyncIterator]();
  for (const pairing of pairings) {
    process.stdout.write(approvalPrompt(pairing));
    const answer = await lines.next();
    // only the request's own digits approve it: a line typed ahead, or for the one before, carries none of them
    const decision = !answer.done && approves(answer.value, pairing.digits) ? "approve" : "decline";
    const decided = await fetch(`${origin}/api/relay/pairing`, { method: "POST", headers, body: JSON.stringify({ id: pairing.id, decision }) });
    process.stdout.write(decided.ok ? decision === "approve" ? "Approved.\n" : declinedNote(answer.done ? null : answer.value) : `${plainLabel(pairing.label)} is no longer waiting.\n`);
  }
  return 0;
}

/**
 * `link [--code | --approve] [--print] [--github | --google]`, also `add` and `login`: this PC joins the relay from
 * its own terminal (scripts/plugin-link.ts), signed in to the account by a device code and then added by a QR code
 * (`--approve`: by an approval here), or with a code to type and a QR code.
 */
async function linkCommand(): Promise<number> {
  // the checkout survives in-app updates: the release that runs has the link that fits its server (as phone-setup)
  const active = activePluginScript(ROOT, port, APP_STATE_DIR);
  if (active !== join(resolve(ROOT), "scripts", "plugin.ts") && resolve(active) !== resolve(import.meta.filename)) {
    // Ctrl+C reaches the release's link too, which takes its code back; this one waits for it.
    // Always "link", whichever name it was run by: a release from before `add` and `login` knows only that one
    process.on("SIGINT", () => undefined);
    const child = Bun.spawn([process.execPath, active, "link", ...process.argv.slice(3)], { cwd: ROOT, windowsHide: true, env, stdin: "inherit", stdout: "inherit", stderr: "inherit" });
    // a SIGTERM or SIGHUP sent to this process alone is passed on, so the release takes its code back too
    for (const signal of ["SIGTERM", "SIGHUP"] as const) process.on(signal, () => child.kill(signal));
    return await child.exited;
  }
  if (!(await health())) {
    process.stderr.write(`Ovis is not running at ${origin}; start it first\n`);
    return 1;
  }
  const headers: Record<string, string> = {};
  if ((env["OVIS_TOKEN"] ?? "") !== "") headers["authorization"] = `Bearer ${env["OVIS_TOKEN"]}`;
  const stop = new AbortController();
  // Ctrl+C, a supervisor's SIGTERM or the terminal closing (SIGHUP): each takes the code back on the way out, and
  // removes a device the code let in that nobody kept. A signal can come twice (to the process group, and passed on
  // by a checkout's link), so every one is caught, and the clean-up gets ten seconds before the process ends anyway
  const halt = (): void => {
    if (stop.signal.aborted) return;
    stop.abort();
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(signal, halt);
  // An output that went away (the terminal closed, a pipe's reader ended) fails the next write. A failed write nobody
  // hears ends the process where it stands, or leaves it running with nobody to read it: the code stays valid either
  // way. It is heard instead, and stops the run as its signal would
  process.stdout.on("error", halt);
  return linkPc(process.argv.slice(3), {
    origin, headers, signal: stop.signal,
    accountService: accountServiceOrigin(env["OVIS_ACCOUNT_SERVICE_URL"] ?? DEFAULT_ACCOUNT_SERVICE),
    out: (text) => process.stdout.write(text),
    lines: console[Symbol.asyncIterator](),
    // a pipe, a file or a closed stdin approves nothing, whatever it carries and whenever (`yes | ovis add`)
    terminal: process.stdin.isTTY === true,
    // the QR code that adds this PC is a key to it: drawn on a terminal only, unless --print asks for it anyway
    isTty: process.stdout.isTTY === true,
    size: () => process.stdout.isTTY === true ? { rows: process.stdout.rows, columns: process.stdout.columns } : null,
  });
}

/**
 * The address a phone opens, as a QR code. When Tailscale runs on this PC but does not yet serve
 * the app, this is the one place that changes it: `tailscale serve` of the app's port on the first
 * free HTTPS port, or only on the one OVIS_TAILSCALE_HTTPS_PORT names, said out loud with the
 * command that undoes it. Everything else only reads. Run by install.sh (and by hand); neither the
 * server nor startup ever calls it.
 */
async function phone(): Promise<number> {
  const say = (line = "") => process.stdout.write(line + "\n");
  const running = await health();
  say(`Ovis on this PC: ${link(origin)}${running ? "" : " (not running yet: it starts with herdr)"}`);
  if (!["127.0.0.1", "0.0.0.0", "localhost"].includes(host)) {
    say(`HOST is ${host}, so Tailscale, which serves 127.0.0.1, is left alone. On the phone, open ${link(`http://${host}:${port}`)}.`);
    return 0;
  }
  const chosen = env[HTTPS_PORT_VARIABLE]?.trim() ?? "";
  const candidates = httpsPorts(chosen);
  const binary = tailscaleBinary();
  let output = await readTailscale(binary);
  let access = parseTailscale(output, port, candidates);
  if (binary === null || access.state === "missing") {
    say("For your phone: install Tailscale on this PC and on the phone (https://tailscale.com/download),");
    say(`sign in to the same account on both, then run: ${PHONE_AGAIN}`);
    return 0;
  }
  if (access.state === "stopped") {
    say(`For your phone: Tailscale is installed but not signed in. Run \`tailscale up\` (or open the Tailscale app), then run: ${PHONE_AGAIN}`);
    return 0;
  }
  let published = false;
  if (access.serving_url === null) {
    if (access.serve_command === null) {
      if (chosen === "") say(`Tailscale on this PC already uses every HTTPS port this would take (${HTTPS_PORTS.join(", ")}). Settings → Phone shows what to do.`);
      else if (candidates.length === 0) say(`${HTTPS_PORT_VARIABLE} is "${chosen}", which is not a port (1-65535). Fix it where you set it (the plugin's env file, or the installer's command), then run: ${PHONE_AGAIN}`);
      else say(`Tailscale on this PC already uses HTTPS port ${candidates[0]}, which ${HTTPS_PORT_VARIABLE} names, so the app is not published on another one. Free that port or name another, then run: ${PHONE_AGAIN}`);
      return chosen !== "" && candidates.length === 0 ? 1 : 0;
    }
    say(`Publishing the app to your tailnet: ${access.serve_command}`);
    const [, ...args] = access.serve_command.split(" ");
    const serve = Bun.spawn([binary, ...args.slice(0, 1), "--yes", ...args.slice(1)], { windowsHide: true, stdin: "ignore", stdout: "inherit", stderr: "inherit" });
    const timer = setTimeout(() => serve.kill(), SERVE_TIMEOUT_MS);
    const code = await serve.exited;
    clearTimeout(timer);
    if (code !== 0) {
      say(`Tailscale did not take it (exit ${code}).${platform() === "linux" ? " On Linux, let your user change Tailscale once with `sudo tailscale set --operator=$USER`," : ""}`);
      say(`then run: ${PHONE_AGAIN}   Or run the command above yourself.`);
      return 1;
    }
    output = await readTailscale(binary);
    access = parseTailscale(output, port, candidates);
    published = true;
  }
  const url = access.serving_url;
  if (url === null) {
    say("Tailscale accepted the command, but does not report the address yet. Settings → Phone shows it once it does.");
    return 1;
  }
  const httpsPort = new URL(url).port || "443";
  if (published) say(`Tailscale now serves ${url} → http://127.0.0.1:${port}, for your tailnet only. To undo: tailscale serve --https=${httpsPort} off`);
  const owner = parseTailscaleOwner(output?.status ?? null);
  const ip = parseTailscaleIp(output?.status ?? null);
  say("");
  say(`On your phone: ${link(url)}`);
  // the name, not the IP, is what the HTTPS certificate is for: https://100.x.y.z would warn
  if (ip !== null) say(`Tailscale IP of this PC: ${ip}. Open the name above, not the IP: the HTTPS certificate is for the name.`);
  say(`Scan this with a phone signed in to Tailscale${owner === null ? "" : ` as ${owner}`}; that login gets in without a code (with OVIS_TOKEN set, after entering the token once).`);
  say("Anyone else on your tailnet needs a pairing code: Settings → Devices, or the pair command.");
  say(qr(url));
  return 0;
}

/** The marketplace action has a real pane, so its address, QR and pairing code stay visible. */
async function phoneSetup(): Promise<number> {
  const active = activePluginScript(ROOT, port, APP_STATE_DIR);
  if (active !== join(resolve(ROOT), "scripts", "plugin.ts") && resolve(active) !== resolve(import.meta.filename)) {
    const child = Bun.spawn([process.execPath, active, "phone-setup"], { cwd: ROOT, windowsHide: true, env, stdin: "inherit", stdout: "inherit", stderr: "inherit" });
    return await child.exited;
  }
  process.stdout.write(`Phone setup\n\nApp on this PC: ${link(origin)}\n`);
  let code = 0;
  if (!(await health())) {
    process.stdout.write("The app is not running. Run the Start Ovis action, then reopen Phone setup.\n");
    code = 1;
  } else {
    const headers: Record<string, string> = {};
    if (env["OVIS_TOKEN"]) headers["authorization"] = `Bearer ${env["OVIS_TOKEN"]}`;
    try {
      const response = await fetch(`${origin}/api/access`, { headers, signal: AbortSignal.timeout(5000) });
      if (!response.ok) throw new Error(`access request failed (${response.status})`);
      const access = await response.json() as RemoteAccess;
      if (!access.tailscale.serving_url) {
        if (access.tailscale.serve_command) process.stdout.write(`To make a phone address, run this on the PC, then reopen Phone setup:\n\n  ${access.tailscale.serve_command}\n\n`);
        else process.stdout.write("For a phone address, set up Tailscale on both devices, or use your own HTTPS proxy. Settings → Phone shows the connection options.\n\n");
      }
      code = await pair();
    } catch {
      process.stderr.write("Could not read phone setup. Check the app's token and connection, then reopen this pane.\n");
      code = 1;
    }
  }
  if (process.stdin.isTTY) {
    process.stdout.write("\nPress Enter to finish. Reopen Phone setup for a fresh pairing code.\n");
    await new Promise<void>((done) => { process.stdin.once("data", () => done()); process.stdin.resume(); });
    process.stdin.pause();
  }
  return code;
}

/**
 * The version that runs, or runs at the next start: the release Settings → Updates installed, else
 * this checkout. herdr's plugin list names only the checkout's, which keeps the version first
 * installed, so Ovis for Windows reads this line to tell an old server from an updated one.
 */
function runningVersion(): string | null {
  try {
    const version = (JSON.parse(readFileSync(join(dirname(activePluginScript(ROOT, port, APP_STATE_DIR)), "..", "package.json"), "utf8")) as { version?: unknown }).version;
    return typeof version === "string" ? version : null;
  } catch { return null; }
}

/** Reporting "down" is not an action failure: herdr logs a nonzero exit as failed. */
async function status(): Promise<number> {
  const pid = recordedPid();
  const up = await health();
  process.stdout.write(`${up ? "running" : "down"} ${origin}${pid === null ? "" : ` (pid ${pid})`}\n`);
  const version = runningVersion();
  if (version !== null) process.stdout.write(`version: ${version}\n`);
  process.stdout.write(`config: ${CONFIG_FILES.length === 0 ? `none (settings go in ${join(CONFIG_DIR, "env")})` : CONFIG_FILES.join(", ")}\n`);
  warnShadowed();
  return 0;
}

if (import.meta.main) {
  const named = process.argv[2] ?? "status";
  const command = Object.hasOwn(COMMAND_ALIASES, named) ? COMMAND_ALIASES[named] : named;
  if (command === "start") process.exit(await start());
  else if (command === "stop") process.exit(await stop());
  else if (command === "status") process.exit(await status());
  else if (command === "pair") process.exit(await pair());
  else if (command === "link") process.exit(await linkCommand());
  else if (command === "phone") process.exit(await phone());
  else if (command === "phone-setup") process.exit(await phoneSetup());
  else {
    process.stderr.write([
      "usage: bun scripts/plugin.ts <start|stop|status|pair|link|add|login|phone|phone-setup>",
      "add (also login, link): sign this PC in, then scan its QR code with a device of your Ovis account to add it (--approve: approve that device here instead; --print: write the QR code where there is no terminal).",
      "link --code: show a code and a QR code to pair one device instead.",
      "",
    ].join("\n"));
    process.exit(2);
  }
}
