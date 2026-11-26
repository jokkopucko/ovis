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
import { writeStateDocument } from "../server/state-document.ts";
import { defaultStateDir } from "../server/update-state.ts";
import { fleetPreview } from "../server/preview.ts";
import { stateDirRefusal } from "../server/machine-profile.ts";
import { COMPILED, entryCommand, ROOT as SERVER_ROOT } from "../server/entries.ts";
import { version as builtVersion } from "../package.json";
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, chmodSync, closeSync, constants, copyFileSync, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, hostname, platform, uptime } from "node:os";
import { basename, delimiter, dirname, join, resolve, sep } from "node:path";

// No application package (node_modules) is loaded with this file: `stop` and `status` must work in a checkout whose
// install was cut off, so a server that runs from it can be stopped.
import { DEFAULT_PORT } from "../shared/protocol.ts";
import type { RemoteAccess } from "../shared/protocol.ts";
import { canServe, FALLBACK_PORTS, freePort, originOf, savedPort, settledPort } from "./plugin-port.ts";
import type { OwnJoin, WaitingDevice } from "./plugin-link.ts";
import { activePluginScript } from "./plugin-runtime.ts";
import { isBareTui, runBareTui, runTui } from "./plugin-tui.ts";
import { parseCommand, shortAccount, unknownCommand, type CliContext } from "./plugin-cli.ts";
import { discardTyped } from "./libc.ts";
import { ENV_FILES, LEGACY_PLUGIN_ID, ownDir, PLUGIN_ID, pluginConfigDir, readEnvFile } from "./plugin-settings.ts";
import { accountServiceOrigin, DEFAULT_ACCOUNT_SERVICE } from "../server/static.ts";
import { herdrStateDir } from "./plugin-state.ts";
import { HTTPS_PORT_VARIABLE, HTTPS_PORTS, httpsPorts, parseTailscale, parseTailscaleIp, parseTailscaleOwner, readTailscale, tailscaleBinary } from "../server/tailscale.ts";
import { descendantProcesses, windowsArgv, windowsProcessTable } from "../server/windows-processes.ts";

// `ovis tui` comes first: the screen needs nothing of this install's state, so it starts before the work below reads the
// state dirs or copies an old install's settings (adoptLegacyConfig).
const words = process.argv.slice(2);
const early = parseCommand(words, { account: false, tui: true });
if (early.kind === "help" && (words[0] === "tui" || words[1] === "tui")) {
  process.stdout.write(early.text);
  process.exit(0);
}
if (early.kind === "run" && early.command === "agent") process.exit(await (await import("./plugin-agent.ts")).runAgent(early.args));
if (early.kind === "run" && early.command === "tui") process.exit(await runTui(early.args));
if (import.meta.main || COMPILED) {
  const opened = await runBareTui(words);
  if (opened !== null) process.exit(opened);
}

let desktopPort: number | null = null;
// help and the version are answered here without a server, so they work with the app closed
if (process.env["OVIS_DESKTOP_COMMAND"] === "1" && early.kind !== "help" && early.kind !== "version") {
  // The app owns its server; these commands only explain how to start or stop it.
  if (early.kind === "run" && (early.command === "start" || early.command === "stop")) {
    process.stderr.write(early.command === "start" ? "The Ovis app starts its own server: open the app.\n" : "The Ovis app stops its own server: quit the app from its menu or tray.\n");
    process.exit(1);
  }
  const config = process.env["HERDR_PLUGIN_CONFIG_DIR"];
  // An installed launcher from before the app's first start after an upgrade has only cli-settings.
  const record = process.env["OVIS_DESKTOP_COMMAND_RECORD"] ?? (config && join(dirname(config), "desktop.json"));
  const { desktopCommandPort } = await import("../app/electron/src/children.ts");
  desktopPort = record ? await desktopCommandPort(record) : null;
  if (desktopPort === null || String(desktopPort) !== process.env["PORT"]) {
    process.stderr.write("ovis: open the Ovis app first, then run this again\n");
    process.exit(1);
  }
}

const ROOT = resolve(process.env["HERDR_PLUGIN_ROOT"] ?? SERVER_ROOT);
const DEFAULT_STATE_DIR = ownDir(join(homedir(), ".local", "state"));
const HERDR_PLUGIN_STATE = join(herdrStateDir(process.env, platform(), homedir()), "plugins");
const MANAGED_STATE_DIR = [PLUGIN_ID, LEGACY_PLUGIN_ID].map((id) => join(HERDR_PLUGIN_STATE, id)).find((dir) => existsSync(dir)) ?? join(HERDR_PLUGIN_STATE, PLUGIN_ID);
// run by hand, without herdr's HERDR_PLUGIN_STATE_DIR: a server started from a checkout keeps its
// own dir while it runs; otherwise the dir herdr gives the plugin, where its startup hook wrote
const REQUESTED_STATE_DIR = process.env["HERDR_PLUGIN_STATE_DIR"]
  ?? (pidIn(join(DEFAULT_STATE_DIR, "server.pid")) !== null || !existsSync(MANAGED_STATE_DIR) ? DEFAULT_STATE_DIR : MANAGED_STATE_DIR);
let STATE_DIR = runningStateDir(REQUESTED_STATE_DIR);
const CONFIG_DIR = pluginConfigDir(process.env, homedir());
adoptLegacyConfig(CONFIG_DIR);
let PID_FILE = join(STATE_DIR, "server.pid");
let LOG_FILE = join(STATE_DIR, "server.log");
let OWNER_FILE = join(STATE_DIR, "server.owner");
function settleStateDir(): void {
  STATE_DIR = runningStateDir(REQUESTED_STATE_DIR);
  PID_FILE = join(STATE_DIR, "server.pid");
  LOG_FILE = join(STATE_DIR, "server.log");
  OWNER_FILE = join(STATE_DIR, "server.owner");
}
/**
 * Without it a second start found the first one's server spawned but not on its port yet, spawned
 * another and overwrote its record, and `stop` then missed the server that kept running (#1611). It
 * is kept in the dir herdr hands the plugin, not the one the record is in, which can change while a
 * start waits for its turn.
 */
const LIFECYCLE_LOCK = join(REQUESTED_STATE_DIR, "lifecycle.lock");
const LIFECYCLE_BUSY = "another start or stop of Ovis is running";
/** longer than a start holds the lock (its port wait and its readiness wait, 20 s each) or a stop does */
const LIFECYCLE_WAIT_MS = 60_000;
const READY_TIMEOUT_MS = 20_000;
/** the supervisor gives its bridge 6 s to exit before it kills it */
const STOP_TIMEOUT_MS = 15_000;
const KILL_WAIT_MS = 3_000;
/** `tailscale serve` waits while the user turns HTTPS on for the tailnet at the link it prints */
const SERVE_TIMEOUT_MS = 180_000;
/** how to come back to `phone` once Tailscale is set up: an action's output goes to herdr's log, not a terminal */
const PHONE_AGAIN = platform() === "win32"
  ? "irm https://ovis.sh/install.ps1 | iex"
  : "curl -fsSL https://ovis.sh/install.sh | sh";

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

/** the settings files in the plugin's config dir: the token lives here, not in herdr's env */
const CONFIG_FILES = ENV_FILES.map((name) => join(CONFIG_DIR, name)).filter((file) => existsSync(file));
const fileVars = CONFIG_FILES.map(readEnvFile);
const shadowed = fileVars.length === 2 ? Object.keys(fileVars[0]!).filter((key) => key in fileVars[1]! && fileVars[0]![key] !== fileVars[1]![key]) : [];
const env = mergeEnvLayers([process.env, ...fileVars]);
if (desktopPort !== null) {
  env["PORT"] = String(desktopPort);
  env["HOST"] = "127.0.0.1";
}
/**
 * The OVIS_STATE_DIR this command was run with, which a settings file may set over (stateDirWayOut). A command handed on
 * to the release Settings installed (handOn) is told it apart: its own environment is the merged one.
 */
const GIVEN_STATE_DIR_VARIABLE = "OVIS_PLUGIN_GIVEN_STATE_DIR";
const givenStateDir = process.env[GIVEN_STATE_DIR_VARIABLE] ?? mergeEnvLayers([process.env])["OVIS_STATE_DIR"] ?? "";
// resolved where the command was run: a handed-on release runs in the plugin's root. And told this process alone: a server
// or command it starts reads its own
const GIVEN_STATE_DIR = givenStateDir === "" ? "" : resolve(givenStateDir);
delete env[GIVEN_STATE_DIR_VARIABLE];
const configuredSocket = fileVars.some((vars) => (vars["HERDR_SOCKET"] ?? "") !== "");
const PATH_KEY = platform() === "win32" ? Object.keys(env).sort().find(key => key.toLowerCase() === "path") ?? "PATH" : "PATH";
const APP_STATE_DIR = defaultStateDir(env);
const PORT_FILE = join(APP_STATE_DIR, "plugin-port");
const portSet = (env["PORT"] ?? "") !== "";
let port = settledPort(env, PORT_FILE);
const host = env["HOST"] ?? "127.0.0.1";
const ipv6Loopback = env["OVIS_IPV6_LOOPBACK"] === "1";
let origin = originOf(host, port);

const machineProfile = fleetPreview(env) && env["OVIS_PROFILE"] === "machine";
const RECORD_MAX_BYTES = 4096;
/**
 * How the record is opened, as server/profile-marker.ts opens the profile's marker: never through a link, never waiting
 * (opening a FIFO for reading would wait for a writer), and never as this process's terminal.
 */
const RECORD_OPEN = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0) | (constants.O_NOCTTY ?? 0);

/**
 * The profile's record at `path`, opened once and asked of that descriptor only: a regular file of at most
 * RECORD_MAX_BYTES, read to its end and never more than one byte past that. null for anything else.
 */
function profileRecord(path: string): unknown {
  let fd: number | undefined;
  try {
    fd = openSync(path, RECORD_OPEN);
    const entry = fstatSync(fd);
    if (!entry.isFile() || entry.size > RECORD_MAX_BYTES) return null;
    const bytes = Buffer.alloc(RECORD_MAX_BYTES + 1);
    let length = 0;
    for (let read = 1; read > 0 && length < bytes.length; length += read) read = readSync(fd, bytes, length, bytes.length - length, length);
    if (length > RECORD_MAX_BYTES) return null;
    return JSON.parse(bytes.toString("utf8", 0, length));
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/**
 * The profile records its owner's unix socket in its state folder (`serve.lock/http.json`, with `door: 1`) and answers only liveness on its TCP
 * port, so the requests to the server go to that socket, addressed as `http://localhost`, the one Host and Origin it takes
 * there. The plugin takes the socket only when the state folder passes the profile's own check (server/machine-profile.ts
 * stateDirRefusal), the record names `serve.sock` in the folder's real path, as the profile names it, and `serve.sock`
 * is a socket this account owns and no group or other may write to, not a link. Otherwise null, also when the record is
 * missing, unreadable, larger than RECORD_MAX_BYTES, not a regular file, names no door or another socket, or the folder
 * is absent: the server then counts as not running (appHealth), and no request goes to it.
 */
function ownerDoor(): string | null {
  if (!machineProfile) return null;
  try {
    const dir = realpathSync(APP_STATE_DIR);
    if (stateDirRefusal(dir) !== null) return null;
    const record = profileRecord(join(dir, "serve.lock", "http.json")) as { door?: unknown; socket?: unknown } | null;
    const own = join(dir, "serve.sock");
    if (typeof record !== "object" || record === null || record.door !== 1 || record.socket !== own) return null;
    const socket = lstatSync(own);
    return socket.isSocket() && socket.uid === process.getuid?.() && (socket.mode & 0o022) === 0 ? own : null;
  } catch { return null; }
}
/**
 * The way out when a machine profile is not found because the plugin's settings file sets OVIS_STATE_DIR over the one
 * the command was run with (the file wins, as INSTALL.md documents): the command looked for the owner socket in another
 * folder (#4210). Empty in any other case: also where the file's folder has an owner socket that did not answer.
 */
function stateDirWayOut(): string {
  const given = GIVEN_STATE_DIR;
  if (!machineProfile || given === "" || serverDoor() !== null || sameDir(given, APP_STATE_DIR)) return "";
  // the last file that sets it is the one that wins
  const setting = CONFIG_FILES.filter((_, index) => "OVIS_STATE_DIR" in mergeEnvLayers([fileVars[index]!]));
  const file = setting[setting.length - 1];
  if (file === undefined) return "";
  return `${file} sets OVIS_STATE_DIR to ${APP_STATE_DIR}, which wins over ${given}. Run it with that profile's HERDR_PLUGIN_CONFIG_DIR, or set the same OVIS_STATE_DIR in the file.\n`;
}

function sameDir(one: string, other: string): boolean {
  try {
    return realpathSync(one) === realpathSync(other);
  } catch {
    return resolve(one) === resolve(other);
  }
}

function notRunning(): number {
  process.stderr.write(`Ovis is not running at ${origin}; start it first\n${stateDirWayOut()}`);
  return 1;
}

/**
 * The door of this command: the one its first passing health check went to (appHealth), kept for every later request
 * of the command, so a command never moves from one door to the other.
 */
let commandDoor: string | null | undefined;
const serverDoor = (): string | null => commandDoor === undefined ? ownerDoor() : commandDoor;
const serverOrigin = (): string => serverDoor() === null ? origin : "http://localhost";
/**
 * A request on a machine profile's owner socket (`door`), as given but with no `authorization` header: the profile
 * takes its owner on that socket itself, and the plugin sends no token there.
 */
function ownerFetch(door: string, input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const request = new Request(input, init);
  request.headers.delete("authorization");
  return fetch(request, { unix: door });
}
/**
 * What `pair`, `phone` and `phone-setup` say for a machine profile instead of an address, a pairing code or a Tailscale
 * serve: its TCP port answers liveness only (server/machine-profile.ts machineTcpAnswer), and a phone pairs with it
 * through the Ovis relay.
 */
function profileRelayOnly(): string {
  const cli = env["OVIS_CLI_NAME"] || "ovis";
  return `A phone reaches this machine profile through the Ovis relay only, not at an address: run ${cli} add to add this machine to your Ovis account, or ${cli} link --code to pair one device.`;
}

function serverFetch(path: string, init: RequestInit = {}, door = serverDoor()): Promise<Response> {
  return door === null ? fetch(`${origin}${path}`, init) : ownerFetch(door, `http://localhost${path}`, init);
}

/** A request that ran past its `AbortSignal.timeout`: the server answered health, then stopped answering. */
function timedOut(error: unknown): boolean {
  return error instanceof DOMException && error.name === "TimeoutError";
}

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

/**
 * A command that draws one loads it before it changes anything (a pairing code, Tailscale), so in a checkout whose install was cut off it fails with nothing changed.
 */
async function qrDrawer(): Promise<(text: string) => string> {
  const { default: qrcode } = await import("qrcode-generator");
  return (text) => {
    const code = qrcode(0, "M");
    code.addData(text);
    code.make();
    return code.createASCII(1, 1);
  };
}

async function pairingParts(): Promise<{ qr: (text: string) => string; decodeOffer: (url: string) => unknown }> {
  const [qr, { decodeOffer }] = await Promise.all([qrDrawer(), import("../shared/relay-offer.ts")]);
  return { qr, decodeOffer };
}

/**
 * For a machine profile it is asked on the owner socket only: with no socket the plugin may take (ownerDoor), it is
 * null and nothing is sent, since the profile answers its TCP port with liveness only. `devices`: the groups the
 * answer lists to its owner (accountDevicesOf); `tokenRequired`: the app let the request in only with its token.
 */
async function appHealth(): Promise<{ readonly engineDown: string | null; readonly devices: AccountDevices | null; readonly tokenRequired: boolean; readonly strict: boolean; readonly relay: string | null } | null> {
  const door = serverDoor();
  if (machineProfile && door === null) return null;
  try {
    const response = await serverFetch("/api/health", { signal: AbortSignal.timeout(1500) }, door);
    if (!response.ok) return null;
    // the port may hold another program's 200 (a kept port that went stale): only the app's answer
    // counts, in the shape every release has sent (server/index.ts)
    const body = await response.json() as { ok?: unknown; herdr?: unknown; auth?: unknown; machine_profile?: unknown; relay?: { phase?: unknown } | null };
    if (body.ok !== true || !appAuth(body.auth)) return null;
    const profile = door === null ? null : body.machine_profile as { runtime_down?: unknown; reason?: unknown } | null | undefined;
    const engine = typeof profile === "object" && profile !== null && typeof profile.runtime_down === "boolean" ? profile : null;
    if ((typeof body.herdr !== "object" || body.herdr === null) && engine === null) return null;
    commandDoor = door;
    return {
      engineDown: engine?.runtime_down === true ? (typeof engine.reason === "string" ? engine.reason : "") : null,
      devices: accountDevicesOf(body), tokenRequired: (body.auth as { reason?: unknown }).reason === "token_required",
      // the PC cannot read its own account state and lets only itself in: this command is then no owner to it either
      strict: (body.auth as { reason?: unknown }).reason === "strict",
      relay: typeof body.relay?.phase === "string" ? body.relay.phase : null,
    };
  } catch {
    return null;
  }
}

async function health(): Promise<boolean> {
  return (await appHealth()) !== null;
}

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

async function healthError(): Promise<string | null> {
  try {
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

function provedServer(): number | null {
  const pid = recordedPid();
  // an exited server its parent has not reaped yet still answers signal 0, with its birth
  if (pid === null || liveProcess(pid) === false) return null;
  return recordedServer(pid) === "ours" ? pid : null;
}

function recordedServer(pid: number): "ours" | "replaced" | "unrecorded" {
  let owner = null as { pid?: unknown; birth?: unknown; birth_unknown?: unknown } | null;
  let recordedAt = 0;
  try {
    owner = JSON.parse(readFileSync(OWNER_FILE, "utf8")) as typeof owner;
    recordedAt = statSync(OWNER_FILE).mtimeMs;
  } catch {}
  if (owner?.pid !== pid) return "unrecorded";
  const now = readProcessBirth(pid);
  if (now.state === "absent") return "replaced";
  // a recorded birth alone decides (Linux's carries the boot id): the wall clock can step forward
  // (NTP on a PC without a clock of its own, a resumed VM) and make a live server look older than this boot
  const birth = parseBirth(owner.birth);
  if (birth !== null && birth.platform === process.platform) return now.state === "unknown" || now.birth.value === birth.value ? "ours" : "replaced";
  if (owner.birth_unknown !== true) return "unrecorded";
  if (recordedAt < Date.now() - uptime() * 1000 - 1000) return "replaced";
  return now.state === "identified" && startedAfter(now.birth.value, recordedAt) ? "replaced" : "ours";
}

/**
 * Whether the recorded pid is positively the server start recorded: the owner record names this pid and its birth (the
 * start time, with the boot id on Linux), and the live process has that same birth now. A bare pid file (a 0.5.9 record
 * after a reboot), a record without a birth, or a birth that cannot be read now proves nothing, so `stop` signals none of them.
 */
function provenServer(pid: number): boolean {
  try {
    const owner = JSON.parse(readFileSync(OWNER_FILE, "utf8")) as { pid?: unknown; birth?: unknown };
    const birth = parseBirth(owner.birth);
    if (owner.pid !== pid || birth === null || birth.platform !== process.platform) return false;
    const now = readProcessBirth(pid);
    return now.state === "identified" && now.birth.value === birth.value;
  } catch { return false; }
}

function startedAfter(birth: string, time: number): boolean {
  if (process.platform === "win32") return Number(birth) > time;
  if (process.platform === "darwin") {
    // `ps -o lstart` under TZ=UTC, to the second: "Wed Oct 21 17:41:40 2026"
    const [, month, day, clock, year] = birth.split(" ");
    return Date.parse(`${month} ${day} ${year} ${clock} UTC`) > time + 1000;
  }
  return false; // Linux: ticks after boot; a reused pid within one boot needs the pid space to wrap
}

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

const LOG_TAIL_BYTES = 64 * 1024;

/** Read through the start's own handle, so a log another start has moved meanwhile is still this run's. */
function logSince(log: number, offset: number): string {
  const size = fstatSync(log).size;
  const from = Math.max(offset, size - LOG_TAIL_BYTES);
  const bytes = Buffer.alloc(Math.max(0, size - from));
  let text = bytes.subarray(0, readSync(log, bytes, 0, bytes.length, from)).toString("utf8");
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

async function settlePort(): Promise<"ready" | "running" | "failed"> {
  if (await canServe(host, port, ipv6Loopback)) return "ready";
  // a start still coming up holds the port: wait for it rather than open a second server beside it
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (recordedPid() !== null && Date.now() < deadline) {
    // that start may have moved to another port itself: follow its choice, or two servers end up side by side
    const kept = portSet ? port : savedPort(PORT_FILE) ?? DEFAULT_PORT;
    if (kept !== port) {
      port = kept;
      origin = originOf(host, port);
    }
    if (await health()) return "running";
    await Bun.sleep(250);
  }
  // the app holds the port but cannot reach herdr: another port would put a second server beside it (#428). A machine
  // profile answers its TCP port with liveness only, so for one the app found there is another server
  if (!machineProfile && await appOnPort()) {
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
  origin = originOf(host, port);
  return "ready";
}

async function start(): Promise<number> {
  warnShadowed();
  if (await health()) {
    process.stdout.write(`Ovis already running at ${origin}\n`);
    return 0;
  }
  if (machineProfile) {
    process.stderr.write("This plugin does not start a machine profile. Start it with OVIS_PROFILE=machine, OVIS_PREVIEW=fleet and OVIS_STATE_DIR naming a folder of its own, running ovis-server serve.\n");
    return 1;
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

async function startInTurn(): Promise<number> {
  if (!portSet) {
    const kept = savedPort(PORT_FILE) ?? DEFAULT_PORT;
    if (kept !== port) {
      port = kept;
      origin = originOf(host, port);
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
    if (port === DEFAULT_PORT) rmSync(PORT_FILE, { force: true });
    else {
      mkdirSync(APP_STATE_DIR, { recursive: true, mode: 0o700 });
      writeFileSync(`${PORT_FILE}.tmp`, `${port}\n`, { mode: 0o600 });
      renameSync(`${PORT_FILE}.tmp`, PORT_FILE);
    }
  }
  keepPreviousLog();
  const log = openSync(LOG_FILE, "a+");
  const logged = fstatSync(log).size;
  const [runtime, managed] = entryCommand("managed", ROOT);
  const child = spawn(runtime, [managed], {
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
      // spawns) reads HERDR_SOCKET.
      ...(env["HERDR_SOCKET_PATH"] !== undefined && !configuredSocket ? { HERDR_SOCKET: env["HERDR_SOCKET_PATH"] } : {}),
    },
  });
  child.unref();
  if (child.pid === undefined) {
    process.stderr.write("could not spawn the server\n");
    return 1;
  }
  try {
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

/** Written whole or not at all, and flushed before it replaces the old one: a reader never finds half a record, nor an empty one after a power cut. */
function writeRecord(file: string, text: string): void {
  writeStateDocument(file, text, false);
}

function forgetServer(pid: number): void {
  try { if (Number(readFileSync(PID_FILE, "utf8").trim()) === pid) rmSync(PID_FILE, { force: true }); } catch {}
  try { if ((JSON.parse(readFileSync(OWNER_FILE, "utf8")) as { pid?: unknown }).pid === pid) rmSync(OWNER_FILE, { force: true }); } catch {}
}

async function stopSpawned(child: ReturnType<typeof spawn>): Promise<boolean> {
  const pid = child.pid!;
  const windows = platform() === "win32";
  try {
    if (windows) stopDependencies.terminateTree(pid);
    else process.kill(-pid, "SIGKILL");
  } catch {}
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
      return null;
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
 * Whether a process (its executable and argv) is this plugin's server in either of the forms it runs in: the form this
 * process would start, Bun running the plugin checkout's server/managed.ts (from source, as before the compiled server),
 * or the checkout's installed ovis-server(.exe) running its managed entry (scripts/plugin-launch.ts). So a stop run by
 * one form finds the server the other started, as after herdr plugin update moved the plugin to the binary.
 */
export function startedByThisPlugin(path: string, argv: string[], env: Record<string, string | undefined> = process.env): boolean {
  const same = (left: string | undefined, right: string) => left?.toLowerCase() === right.toLowerCase();
  if (same(path, process.execPath) && same(argv[1], entryCommand("managed", ROOT)[1])) return true;
  const checkout = env["OVIS_PLUGIN_CHECKOUT"] ?? env["HERDR_PLUGIN_ROOT"];
  if (!checkout) return false;
  if (same(argv[1], join(checkout, "server", "managed.ts")) && /^bun(\.exe)?$/i.test(basename(path))) return true;
  const installed = `${join(checkout, ".ovis", "server").toLowerCase()}${sep}`;
  return argv[1] === "managed" && path.toLowerCase().startsWith(installed) && /^ovis-server(\.exe)?$/i.test(basename(path));
}

/**
 * Returns once the server is gone. It stops answering at once, but its supervisor holds the
 * checkout's lock until the bridge under it exits, and a `start` before then finds that lock,
 * gives up, and leaves nothing running.
 */
export async function stop(dependencies: StopDependencies = stopDependencies): Promise<number> {
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

function recordedWindowsBirth(pid: number): number | null {
  try {
    const owner = JSON.parse(readFileSync(OWNER_FILE, "utf8")) as { pid?: unknown; birth?: unknown };
    const birth = parseBirth(owner.birth);
    return owner.pid === pid && birth?.platform === "win32" ? Number(birth.value) : null;
  } catch { return null; }
}

async function stopInTurn(dependencies: StopDependencies): Promise<number> {
  const pid = recordedPid();
  if (pid === null) {
    rmSync(PID_FILE, { force: true });
    process.stdout.write("Ovis is not running\n");
    return 0;
  }
  let target = dependencies.isWindows ? pid : -pid;
  if (dependencies.isWindows) {
    // A stale PID can belong to another app, or a newer instance of this plugin.
    const recordedAt = statSync(PID_FILE).mtimeMs;
    const processes = await dependencies.processTable();
    const owner = processes.find(row => row.pid === pid);
    // The identity start recorded (the pid and the creation time Windows gives it) decides, whichever installation
    // folder runs this stop: herdr plugin update builds the new version in a new one while the old server runs on.
    const birth = recordedWindowsBirth(pid);
    const identified = owner?.started !== undefined && (birth !== null
      ? owner.started === birth
      : owner.started <= recordedAt && startedByThisPlugin(owner.path ?? "", windowsArgv(owner.commandLine ?? "")));
    if (!owner || !identified
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
    // install.ps1 reads a stdout line starting `stopped ` as "this stop stopped a server" (scripts/plugin-stop-identity.test.ts pins it)
    process.stdout.write(`stopped Ovis (pid ${pid})\n`);
    return 0;
  } else {
    // the recorded server is gone and its pid is someone else's now: nothing of ours to signal.
    if (recordedServer(pid) === "replaced") {
      forgetServer(pid);
      process.stdout.write(`Ovis is not running (pid ${pid} now belongs to another process)\n`);
      return 0;
    }
    if (!provenServer(pid)) {
      if ((liveProcess(pid) ?? dependencies.isAlive(pid)) === false) {
        forgetServer(pid);
        process.stdout.write("Ovis is not running\n");
        return 0;
      }
      process.stderr.write([
        `could not confirm that pid ${pid} is this Ovis server, so nothing was signalled and its pid file was kept.`,
        `If it is an older Ovis, quit it where it runs (its herdr plugin's stop, or the window it runs in), or restart this PC.`,
        `To stop it by hand, first check what it is with: ps -p ${pid} -o command=`,
        `and only if that shows Ovis: kill ${pid}`,
      ].join("\n") + "\n");
      return 1;
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
    try { process.kill(target, "SIGKILL"); } catch {}
    // SIGKILL only asks: the lock is free, and a start can follow, once the group is gone
    const killDeadline = Date.now() + KILL_WAIT_MS;
    while (running() && Date.now() < killDeadline) await Bun.sleep(100);
    if (running()) {
      process.stderr.write(`Ovis (pid ${pid}) is still running after SIGKILL; its pid file is kept\n`);
      return 1;
    }
  }
  forgetServer(pid);
  // install.ps1 reads a stdout line starting `stopped ` as "this stop stopped a server" (scripts/plugin-stop-identity.test.ts pins it)
  process.stdout.write(`stopped Ovis (pid ${pid})${killed && !handedOn ? `; it was still running after ${STOP_TIMEOUT_MS / 1000}s, so it was killed` : ""}\n`);
  return 0;
}

async function pair(args: readonly string[], parts?: Awaited<ReturnType<typeof pairingParts>>): Promise<number> {
  if (args.includes("--approve")) return approvePairings();
  if (machineProfile) {
    process.stderr.write(`${profileRelayOnly()}\n`);
    return 1;
  }
  const { qr, decodeOffer } = parts ?? await pairingParts();
  if (!(await health())) return notRunning();
  const headers: Record<string, string> = { "content-type": "application/json", "x-herdr-machine": "1" };
  if ((env["OVIS_TOKEN"] ?? "") !== "") headers["authorization"] = `Bearer ${env["OVIS_TOKEN"]}`;
  let code: string;
  try {
    const started = await serverFetch("/api/devices/pair/start", { method: "POST", headers, body: "{}", signal: AbortSignal.timeout(5000) });
    if (!started.ok) {
      process.stderr.write(`could not start a pairing (${started.status}): ${await started.text()}\n`);
      return 1;
    }
    ({ code } = (await started.json()) as { code: string; expires_at: string });
  } catch (error) {
    if (!timedOut(error)) throw error;
    // the start may have reached the PC, which then made a code this never got. No route reads it back, and a cancel
    // cannot tell it from a code made elsewhere since; a new start replaces whichever is pending, as every start does
    process.stderr.write(`Ovis at ${origin} did not answer in time. It may have made a pairing code that was not shown: run ${env["OVIS_CLI_NAME"] || "ovis"} pair again to replace it.\n`);
    return 1;
  }
  let url: string | null = null;
  try {
    const access = (await (await serverFetch("/api/access", { headers, signal: AbortSignal.timeout(5000) })).json()) as { tailscale: { serving_url: string | null } };
    url = access.tailscale.serving_url;
  } catch {}
  const out: string[] = [`Pairing code: ${code.slice(0, 3)} ${code.slice(3)}   (good for 10 minutes, for one device)`];
  if (url !== null) {
    out.push(`On the other device, open ${link(url)} and enter the code, or scan this to open it with the code filled in:`, "");
    out.push(qr(`${url}/?pair=${code}`));
  } else {
    out.push("On the other device, open the app's address and enter the code. Settings → Phone, on any signed-in device, shows the address and how to get one.");
  }
  try {
    const relayResponse = await serverFetch("/api/relay", { headers, signal: AbortSignal.timeout(5000) });
    if (relayResponse.status !== 404) {
      if (!relayResponse.ok) throw new Error(`relay status request failed (${relayResponse.status})`);
      const relayStatus: unknown = await relayResponse.json();
      if (typeof relayStatus !== "object" || relayStatus === null || !("phase" in relayStatus) || typeof relayStatus.phase !== "string") {
        throw new Error("invalid relay status response");
      }
      if (relayStatus.phase === "online") {
        const offerResponse = await serverFetch("/api/relay/offer", {
          method: "POST",
          headers: { ...headers, "x-herdr-update": "1", origin: serverOrigin() },
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
 * The PC's terminal is the PC itself, so this is approval on this PC (docs/account.md, "Who may admit a device"): the
 * devices waiting with their digits, and the account joins this PC's own route lists (GET /api/relay/joins, as its own
 * window's card does), each let in with all six digits its device shows typed here: one a member could also approve
 * (#28), and a first join, which only this PC may let in (the first device that opens a PC added in one press).
 */
async function approvePairings(): Promise<number> {
  const { approveJoins, approveWaiting, lockRefusal } = await import("./plugin-link.ts");
  if (!(await health())) return notRunning();
  const headers: Record<string, string> = { "content-type": "application/json", "x-herdr-machine": "1", "x-herdr-update": "1", origin: serverOrigin() };
  if ((env["OVIS_TOKEN"] ?? "") !== "") headers["authorization"] = `Bearer ${env["OVIS_TOKEN"]}`;
  const errorCode = async (response: Response): Promise<unknown> => ((await response.json().catch(() => null)) as { error?: { code?: unknown } } | null)?.error?.code;
  // a locked or strict PC refuses its terminal too (server/lock-boundary.ts), and says so in words
  const refused = async (what: string, response: Response): Promise<number> => {
    const text = await response.text();
    let code: unknown;
    try { code = (JSON.parse(text) as { error?: { code?: unknown } }).error?.code; } catch {}
    process.stderr.write(code === "locked" || code === "strict" ? lockRefusal(code) : `could not read ${what} (${response.status}): ${text}\n`);
    return 1;
  };
  let pairings: WaitingDevice[];
  let joins: OwnJoin[];
  let account: string | null = null;
  try {
    const listed = await serverFetch("/api/relay/pairings", { headers, signal: AbortSignal.timeout(15_000) });
    if (!listed.ok) return await refused("the waiting pairings", listed);
    ({ pairings } = (await listed.json()) as { pairings: WaitingDevice[] });
    // an Ovis older than this route lists none (404, 405)
    const asked = await serverFetch("/api/relay/joins", { headers, signal: AbortSignal.timeout(15_000) });
    if (asked.status === 404 || asked.status === 405) joins = [];
    else if (!asked.ok) return await refused("the waiting account joins", asked);
    else joins = ((await asked.json()) as { joins: OwnJoin[] }).joins;
    // a first join's admission came from this PC's account, named beside its device; left out when it cannot be read
    if (joins.some((join) => join.digits !== undefined)) {
      const status = await serverFetch("/api/account/status", { headers, signal: AbortSignal.timeout(5_000) }).catch(() => null);
      const named = status?.ok === true ? ((await status.json().catch(() => null)) as { account?: unknown } | null)?.account : null;
      if (typeof named === "string") account = named;
    }
  } catch (error) {
    if (!timedOut(error)) throw error;
    process.stderr.write(`Ovis at ${origin} did not answer in time; try again\n`);
    return 1;
  }
  if (pairings.length === 0 && joins.length === 0) {
    process.stdout.write("No device is waiting to pair.\n");
    return 0;
  }
  const out = (text: string): void => { process.stdout.write(text); };
  const lines = console[Symbol.asyncIterator]();
  // a pipe, a file or a closed stdin approves nothing, whatever it carries and whenever
  const terminal = process.stdin.isTTY === true;
  const signal = new AbortController().signal;
  if (joins.length > 0) {
    const code = await approveJoins(joins, {
      out, lines, terminal, discard: discardTyped, signal, account, command: `${env["OVIS_CLI_NAME"] || "ovis"} approve`,
      approve: async (id, digits) => {
        try {
          const typed = await serverFetch("/api/relay/join", { method: "POST", headers, body: JSON.stringify({ id, digits }), signal: AbortSignal.timeout(15_000) });
          if (typed.ok) return "approved";
          const code = await errorCode(typed);
          if (code === "wrong_digits" || code === "locked" || code === "strict") return code;
          return code === "relay_pairing_gone" ? "gone" : "away";
        } catch { return "away"; }
      },
    });
    if (code !== 0 || pairings.length === 0) return code;
  }
  // asked as `ovis add` asks (scripts/plugin-link.ts): a line answers only the request it was typed under
  return approveWaiting(pairings, {
    out, lines, terminal, discard: discardTyped, signal,
    // read again before three digits approve: a request that came since may end in the same three
    list: async () => {
      const again = await serverFetch("/api/relay/pairings", { headers, signal: AbortSignal.timeout(15_000) });
      if (!again.ok) throw new Error(`could not read the waiting pairings (${again.status})`);
      return ((await again.json()) as { pairings: WaitingDevice[] }).pairings;
    },
    decide: async (id, decision) => {
      try {
        const decided = await serverFetch("/api/relay/pairing", { method: "POST", headers, body: JSON.stringify({ id, decision }), signal: AbortSignal.timeout(15_000) });
        return decided.ok ? "taken" : "gone";
      } catch { return "away"; }
    },
  });
}

/**
 * Runs the release Settings → Updates installed (its scripts/plugin.ts, `active`) with `args` in this terminal, and gives
 * back its exit code: the checkout survives in-app updates, and the release that runs has the command that fits its
 * server. A SIGINT, SIGTERM or SIGHUP sent to this process is passed on, and this process waits for the release, which
 * ends with it and takes back what it handed out (link's code). A Ctrl+C on the terminal they share reaches the release
 * itself too, so it gets that SIGINT twice: every release ends at the first or catches each (link). On Windows a SIGINT
 * is not passed on: there Bun ends a child outright for any signal it is sent, without the clean-up the release's own
 * Ctrl+C gives it, and a Ctrl+C reaches every process of the console anyway.
 * Listening starts before the release does, so a signal that comes while it starts no longer ends this process with the
 * release left running: Bun runs the listener from the event loop, after `child` is set. A release that could not be
 * started has nothing to pass one on to, and the listeners go on every way out.
 */
async function handOn(active: string, args: readonly string[]): Promise<number> {
  let child: Bun.Subprocess | undefined;
  const pass = (signal: NodeJS.Signals) => () => { child?.kill(signal); };
  const handlers = { SIGINT: process.platform === "win32" ? () => undefined : pass("SIGINT"), SIGTERM: pass("SIGTERM"), SIGHUP: pass("SIGHUP") } as const;
  for (const [signal, handler] of Object.entries(handlers)) process.on(signal, handler);
  try {
    // the merged environment as it is (the release may not find a settings file named by a relative path), and the folder
    // this command was run with apart, to name both where it finds no machine profile (stateDirWayOut)
    child = Bun.spawn([process.execPath, active, ...args], { cwd: ROOT, windowsHide: true, env: { ...env, [GIVEN_STATE_DIR_VARIABLE]: GIVEN_STATE_DIR }, stdin: "inherit", stdout: "inherit", stderr: "inherit" });
    return await child.exited;
  } finally {
    for (const [signal, handler] of Object.entries(handlers)) process.off(signal, handler);
  }
}

/**
 * `ovis login` opens its sign-in page itself where a person sits at this PC's desktop, as codex login does: never over
 * SSH, with --no-browser (codex's --device-auth), or when the output is not a terminal (a script, a test).
 */
function desktopBrowser(args: readonly string[]): ((url: string) => boolean) | null {
  if (args.includes("--no-browser") || args.includes("--device-auth") || process.stdout.isTTY !== true) return null;
  if ((process.env["SSH_CONNECTION"] ?? "") !== "" || (process.env["SSH_TTY"] ?? "") !== "") return null;
  const desktop = process.platform === "darwin" || (process.platform === "linux" && ((process.env["DISPLAY"] ?? "") !== "" || (process.env["WAYLAND_DISPLAY"] ?? "") !== ""));
  const opener = process.platform === "darwin" ? "open" : "xdg-open";
  if (!desktop || Bun.which(opener) === null) return null;
  return (url) => {
    spawn(opener, [url], { stdio: "ignore", detached: true }).on("error", () => {}).unref();
    return true;
  };
}

/**
 * Ctrl+C, a supervisor's SIGTERM or the terminal closing (SIGHUP) stop a run that has something to undo on the way out
 * (`link` takes its code back and removes a device the code let in that nobody kept; `join` takes a listing nobody
 * added off the account's list). A signal can come twice (to the process group, and passed on by a checkout's link),
 * so every one is caught, and the clean-up gets ten seconds before the process ends anyway. An output that went away
 * (the terminal closed, a pipe's reader ended) fails the next write. A failed write nobody hears ends the process where
 * it stands, or leaves it running with nobody to read it: it is heard instead, and stops the run as its signal would.
 */
function stopOnSignals(): AbortSignal {
  const stop = new AbortController();
  const halt = (): void => {
    if (stop.signal.aborted) return;
    stop.abort();
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(signal, halt);
  process.stdout.on("error", halt);
  return stop.signal;
}

/** A machine profile's owner calls go to its socket, the door health() passed on (serverDoor), with the origin it takes there. */
function ownerCalls(): { readonly origin: string; readonly fetch?: (input: string | URL | Request, init?: RequestInit) => Promise<Response> } {
  const door = serverDoor();
  return door === null ? { origin } : { origin: "http://localhost", fetch: (input, init) => ownerFetch(door, input, init) };
}

async function linkCommand(args: readonly string[]): Promise<number> {
  const active = activePluginScript(ROOT, port, APP_STATE_DIR);
  // Always "link", whichever name it was run by: a release from before `add` and `login` knows only that one
  if (active !== join(resolve(ROOT), "scripts", "plugin.ts") && resolve(active) !== resolve(import.meta.filename)) return await handOn(active, ["link", ...args]);
  const { link: linkPc, linkSettings } = await import("./plugin-link.ts");
  if (!(await health())) return notRunning();
  const headers: Record<string, string> = {};
  if ((env["OVIS_TOKEN"] ?? "") !== "") headers["authorization"] = `Bearer ${env["OVIS_TOKEN"]}`;
  const signal = stopOnSignals();
  const openBrowser = desktopBrowser(args);
  return linkPc(args, {
    ...(openBrowser === null ? {} : { openBrowser }),
    ...ownerCalls(), headers, signal,
    accountService: accountServiceOrigin(env["OVIS_ACCOUNT_SERVICE_URL"] ?? DEFAULT_ACCOUNT_SERVICE),
    ...linkSettings(env),
    out: (text) => process.stdout.write(text),
    lines: console[Symbol.asyncIterator](),
    // a pipe, a file or a closed stdin approves nothing, whatever it carries and whenever (`yes | ovis add`)
    terminal: process.stdin.isTTY === true,
    discard: discardTyped,
    // the QR code that adds this PC is a key to it: drawn on a terminal only, unless --print asks for it anyway
    isTty: process.stdout.isTTY === true,
    size: () => process.stdout.isTTY === true ? { rows: process.stdout.rows, columns: process.stdout.columns } : null,
  });
}

/** `ovis join` (scripts/plugin-join.ts): this PC joins an account with an invite, through the same add as `ovis add`. */
async function joinCommand(args: readonly string[]): Promise<number> {
  const [{ absoluteInviteFile, join: joinPc, INVITE_READ_MAX, readInviteFile }, { linkSettings }] = await Promise.all([import("./plugin-join.ts"), import("./plugin-link.ts")]);
  const active = activePluginScript(ROOT, port, APP_STATE_DIR);
  // the release runs in its own folder: a relative invite file is named from here
  if (active !== join(resolve(ROOT), "scripts", "plugin.ts") && resolve(active) !== resolve(import.meta.filename)) return await handOn(active, ["join", ...absoluteInviteFile(args, process.cwd())]);
  // Ctrl+C ends the run from here on, while the invite is read too (handOn passes signals on to a release instead)
  const signal = stopOnSignals();
  const running = await health();
  const headers: Record<string, string> = {};
  if ((env["OVIS_TOKEN"] ?? "") !== "") headers["authorization"] = `Bearer ${env["OVIS_TOKEN"]}`;
  const json = args.includes("--json");
  return joinPc(args, {
    ...ownerCalls(), headers, signal, running,
    accountService: accountServiceOrigin(env["OVIS_ACCOUNT_SERVICE_URL"] ?? DEFAULT_ACCOUNT_SERVICE),
    ...linkSettings(env),
    out: (text) => process.stdout.write(text),
    err: (text) => process.stderr.write(text),
    lines: console[Symbol.asyncIterator](),
    terminal: process.stdin.isTTY === true,
    discard: discardTyped,
    // what a person reads goes to stderr with --json: that is where the question is asked
    isTty: (json ? process.stderr : process.stdout).isTTY === true,
    // the caller's own environment only: an invite belongs in no settings file
    ...process.env["OVIS_INVITE"] === undefined ? {} : { inviteEnv: process.env["OVIS_INVITE"] },
    readFile: readInviteFile,
    readStdin: async () => {
      const chunks: Uint8Array[] = [];
      let size = 0;
      for await (const chunk of Bun.stdin.stream()) {
        chunks.push(chunk);
        size += chunk.length;
        if (size > INVITE_READ_MAX) break;
      }
      return Buffer.concat(chunks).toString("utf8");
    },
  });
}

/**
 * When Tailscale runs on this PC but does not yet serve the app, this is the one place that changes it:
 * `tailscale serve` of the app's port on the first free HTTPS port, or only on the one
 * OVIS_TAILSCALE_HTTPS_PORT names, said out loud with the command that undoes it. Everything else
 * only reads. Run by install.sh (and by hand); neither the server nor startup ever calls it.
 */
async function phone(): Promise<number> {
  // a machine profile serves no app at its port: no address is shown and Tailscale is not asked or changed
  if (machineProfile) {
    process.stdout.write(`${profileRelayOnly()}\n`);
    return 0;
  }
  const qr = await qrDrawer();
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

async function phoneSetup(): Promise<number> {
  const active = activePluginScript(ROOT, port, APP_STATE_DIR);
  if (active !== join(resolve(ROOT), "scripts", "plugin.ts") && resolve(active) !== resolve(import.meta.filename)) return await handOn(active, ["phone-setup"]);
  const parts = machineProfile ? null : await pairingParts();
  process.stdout.write(`Phone setup\n\n${parts === null ? profileRelayOnly() : `App on this PC: ${link(origin)}`}\n`);
  let code = 0;
  if (parts === null) code = 0;
  else if (!(await health())) {
    process.stdout.write("The app is not running. Run the Start Ovis action, then reopen Phone setup.\n");
    code = 1;
  } else {
    const headers: Record<string, string> = {};
    if (env["OVIS_TOKEN"]) headers["authorization"] = `Bearer ${env["OVIS_TOKEN"]}`;
    try {
      const response = await serverFetch("/api/access", { headers, signal: AbortSignal.timeout(5000) });
      if (!response.ok) throw new Error(`access request failed (${response.status})`);
      const access = await response.json() as RemoteAccess;
      if (!access.tailscale.serving_url) {
        if (access.tailscale.serve_command) process.stdout.write(`To make a phone address, run this on the PC, then reopen Phone setup:\n\n  ${access.tailscale.serve_command}\n\n`);
        else process.stdout.write("For a phone address, set up Tailscale on both devices, or use your own HTTPS proxy. Settings → Phone shows the connection options.\n\n");
      }
      code = await pair([], parts);
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
 * herdr's plugin list names only the checkout's, which keeps the version first installed, so Ovis for Windows reads this line to tell an old server from an updated one.
 */
function runningVersion(): string | null {
  if (COMPILED) return builtVersion;
  try {
    const version = (JSON.parse(readFileSync(join(dirname(activePluginScript(ROOT, port, APP_STATE_DIR)), "..", "package.json"), "utf8")) as { version?: unknown }).version;
    return typeof version === "string" ? version : null;
  } catch { return null; }
}

/** The devices an owner's health answer lists apart (server/devices.ts accountGroups). */
interface AccountDevices { readonly unlinked: readonly ShownDevice[]; readonly own_word: readonly ShownDevice[] }
interface ShownDevice { readonly id: string; readonly label: string }

/** The `account_devices` of a health answer, in the shape this command reads; null without one (an older server, or a caller that is not its owner). */
function accountDevicesOf(body: unknown): AccountDevices | null {
  const groups = (body as { account_devices?: unknown } | null)?.account_devices as Record<string, unknown> | null | undefined;
  const shown = (list: unknown): list is ShownDevice[] => Array.isArray(list)
    && list.every((device) => typeof device?.id === "string" && typeof device.label === "string");
  return typeof groups === "object" && groups !== null && shown(groups["unlinked"]) && shown(groups["own_word"])
    ? { unlinked: groups["unlinked"], own_word: groups["own_word"] } : null;
}

/** One group's line: each device by its name and its id, neither with a control character. */
const deviceLine = (title: string, devices: readonly ShownDevice[]): string => {
  const plain = (text: string) => text.replace(/[\u0000-\u001f\u007f-\u009f]/g, "");
  return `${title}: ${devices.length === 0 ? "none" : devices.map((device) => `${plain(device.label)} (${plain(device.id)})`).join(", ")}\n`;
};

/** What a PC pinned to its account's signed list says of it (GET /api/account/status `list`): the list, where the PC stands in it, and why it lets nobody in when it does not. */
interface ListSummary { readonly pinned_list: string; readonly standing: string | null; readonly reason: string | null }

const listSummaryOf = (value: unknown): ListSummary | null => {
  const { pinned_list, standing, reason } = (typeof value === "object" && value !== null ? value : {}) as Record<string, unknown>;
  return typeof pinned_list === "string" && (standing === null || typeof standing === "string") && (reason === null || typeof reason === "string") ? { pinned_list, standing, reason } : null;
};

/**
 * This PC's account as `GET /api/account/status` tells its owner; null where that does not answer. `problem`: the PC
 * answered that it cannot read its own account state, and said what (a file, a folder): it then tells nothing else.
 */
async function accountTold(): Promise<{ readonly account: string | null; readonly members: number; readonly waiting: boolean | null; readonly list: ListSummary | null; readonly scale: number | null } | { readonly problem: string } | null> {
  try {
    const response = await serverFetch("/api/account/status", { signal: AbortSignal.timeout(1500) });
    if (!response.ok) {
      const refused = await response.json().catch(() => null) as { error?: { code?: unknown; reason?: unknown } } | null;
      return refused?.error?.code === "strict" && typeof refused.error.reason === "string" ? { problem: refused.error.reason } : null;
    }
    const body = await response.json() as { account?: unknown; members?: unknown; waiting_for_add?: unknown; list?: unknown; migrate_time_scale?: unknown };
    if (!(typeof body.account === "string" || body.account === null) || !Number.isSafeInteger(body.members)) return null;
    // null from a server from before the field
    return { account: body.account, members: body.members as number, waiting: typeof body.waiting_for_add === "boolean" ? body.waiting_for_add : null, list: listSummaryOf(body.list),
      scale: Number.isSafeInteger(body.migrate_time_scale) && (body.migrate_time_scale as number) > 1 ? body.migrate_time_scale as number : null };
  } catch { return null; }
}

/** This PC's account as its owner is told it; null where that does not answer, or the PC cannot read its account state. */
async function accountOf() {
  const told = await accountTold();
  return told !== null && "problem" in told ? null : told;
}

/**
 * `ovis status --json`: what an agent reads to know where this PC stands, as one JSON object. No token, key or e-mail
 * address is in it. The account, and whether something waits for Add, are told only to the app's owner, as `status`
 * names the account only to it (`account_known`); the server ID only to this PC's own window and CLI.
 */
async function statusJson(): Promise<number> {
  const answer = await appHealth();
  // a PC that cannot read its account state tells no owner anything, and says what it could not read to its own CLI
  const told = answer !== null && (answer.devices != null || answer.strict) ? await accountTold() : null;
  const account = told !== null && "problem" in told ? null : told;
  let serverId: string | null = null;
  if (answer !== null) {
    try {
      const response = await serverFetch("/api/relay", { signal: AbortSignal.timeout(1500) });
      const body = response.ok ? await response.json() as { server_id?: unknown } : null;
      if (typeof body?.server_id === "string" && /^[0-9a-f]{32}$/.test(body.server_id)) serverId = body.server_id;
    } catch {}
  }
  const phase = answer?.relay ?? null;
  process.stdout.write(`${JSON.stringify({
    version: runningVersion() ?? builtVersion,
    running: answer !== null,
    server_id: serverId,
    relay: phase === null ? null : { on: phase !== "off", connected: phase === "online", phase },
    account: account?.account ?? null,
    account_known: account !== null,
    waiting_for_add: account?.waiting ?? null,
    // a PC pinned to its account's signed list: the list, where the PC stands in it, and why it lets nobody in when it does not
    list: account?.list ?? null,
    // the PC cannot read its own account state, and lets only itself in: what it cannot read
    problem: told !== null && "problem" in told ? told.problem : null,
    // a staging run that turned the waits of a move onto the account's list down (OVIS_LIST_MIGRATE_TIME_SCALE)
    ...(account?.scale ? { migrate_time_scale: account.scale } : {}),
  })}\n`);
  return 0;
}

/** Reporting "down" is not an action failure: herdr logs a nonzero exit as failed. */
async function status(args: readonly string[] = []): Promise<number> {
  if (args.includes("--json")) return await statusJson();
  const pid = recordedPid();
  const answer = await appHealth();
  process.stdout.write(`${answer !== null ? "running" : "down"} ${origin}${pid === null ? "" : ` (pid ${pid})`}\n`);
  // on stderr: install.sh reads status's stdout lines, and a folder's name could begin with "running"
  if (answer === null) process.stderr.write(stateDirWayOut());
  if (typeof answer?.engineDown === "string") process.stdout.write(`engine: down${answer.engineDown === "" ? "" : ` (${answer.engineDown})`}\n`);
  // only to the app's owner, whose answer lists the device groups below: nobody else is told the account
  const account = answer?.devices == null ? null : await accountOf();
  if (account !== null) {
    process.stdout.write(`account: ${account.account === null ? "none (run ovis login)" : `${shortAccount(account.account)} (${account.members} device${account.members === 1 ? "" : "s"})`}\n`);
  }
  if (typeof answer?.relay === "string") process.stdout.write(`relay: ${answer.relay}\n`);
  // the groups of the app's own answer, which carries no token: on a machine profile's owner socket, or over TCP when
  // the app lets the command in without one. Nothing proves which program holds a TCP port, so no token goes there
  const devices = answer?.devices ?? null;
  if (devices !== null) {
    // relay rows only: a browser paired on the PC's own address is outside the account too, and listed in Settings → Devices
    process.stdout.write(deviceLine("relay devices outside the account", devices.unlinked));
    process.stdout.write(deviceLine("devices that joined the account on their own word", devices.own_word));
  } else if (answer !== null) {
    // the answer of an app that is not its owner's (a token, a pairing or the owner's login needed, the open LAN), or of a
    // release from before the groups: only the token is something to name
    process.stdout.write(answer.tokenRequired
      ? "account devices: not shown, as Ovis lets this command in only with a token, which status does not send over TCP\n"
      : "account devices: not shown, as the app's answer to this command does not list them\n");
  }
  const version = runningVersion();
  if (version !== null) process.stdout.write(`version: ${version}\n`);
  process.stdout.write(`config: ${CONFIG_FILES.length === 0 ? `none (settings go in ${join(CONFIG_DIR, "env")})` : CONFIG_FILES.join(", ")}\n`);
  warnShadowed();
  return 0;
}

/**
 * The release flag, read as shared/account-devices-api.ts accountOpensAll() reads it: this script loads in a checkout
 * whose packages are not installed, so it imports nothing the contract module pulls in.
 */
// Like the server, require an explicit opt-out: a padded or otherwise mistyped value must not disable Step 2.
const accountOpensAll = (): boolean => env["OVIS_ACCOUNT_OPENS_ALL"] !== "0";

/** `ovis recover` (scripts/plugin-recover.ts), over the server's recovery socket in this PC's state folder. */
async function recover(args: readonly string[]): Promise<number> {
  const { runRecover } = await import("./plugin-recover.ts");
  return await withRecoveryIo((io) => runRecover(args, io));
}

/** `ovis logout` (scripts/plugin-recover.ts runLogout): Revoke all over the same recovery socket, after a typed yes. */
async function logout(): Promise<number> {
  const { runLogout } = await import("./plugin-recover.ts");
  return await withRecoveryIo((io) => runLogout({ ...io, label: hostname(), account: async () => {
    const health = await appHealth();
    if (health === null) return null;
    if (serverDoor() !== null || !health.tokenRequired) return await accountOf();
    // Liveness does not prove who holds the TCP port. Ask the same local socket that will revoke the devices.
    const reply = await io.send({ act: "account_status" }, 2).catch(() => null);
    if (typeof reply !== "object" || reply === null || !("account" in reply) || !("members" in reply)) return null;
    const { account, members } = reply;
    return (typeof account === "string" || account === null) && typeof members === "number" && Number.isSafeInteger(members) ? { account, members } : null;
  }, leave: leaveListing }));
}

/**
 * Takes this PC off `account`'s list at the account service (POST /v1/pcs/{server_id}/leave), by the proof only the PC
 * itself makes (POST /api/account/pc-proof): no sign-in is needed, and for 30 days only the PC's own `ovis login` lists
 * it again. False where it did not happen: a service from before that route, the service off or away.
 */
async function leaveListing(account: string): Promise<boolean> {
  const service = accountServiceOrigin(env["OVIS_ACCOUNT_SERVICE_URL"] ?? DEFAULT_ACCOUNT_SERVICE);
  if (service === null) return false;
  try {
    const headers: Record<string, string> = { "content-type": "application/json", "x-herdr-machine": "1", "x-herdr-update": "1", origin: serverOrigin() };
    if ((env["OVIS_TOKEN"] ?? "") !== "") headers["authorization"] = `Bearer ${env["OVIS_TOKEN"]}`;
    const proved = await serverFetch("/api/account/pc-proof", { method: "POST", headers, body: "{}", signal: AbortSignal.timeout(15_000) });
    if (!proved.ok) return false;
    const proof = await proved.json() as { server_id?: unknown; challenge_id?: unknown; proof?: unknown };
    if (typeof proof.server_id !== "string" || !/^[0-9a-f]{32}$/.test(proof.server_id) || typeof proof.challenge_id !== "string" || typeof proof.proof !== "string") return false;
    // never followed: a redirect would carry the proof to another origin
    const left = await fetch(`${service}/v1/pcs/${proof.server_id}/leave`, {
      method: "POST", redirect: "error", headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(15_000),
      body: JSON.stringify({ server_id: proof.server_id, account, challenge_id: proof.challenge_id, proof: proof.proof }),
    });
    return left.status === 204;
  } catch { return false; }
}

async function withRecoveryIo(run: (io: import("./plugin-recover.ts").RecoverIo) => Promise<number>): Promise<number> {
  const { askRecovery } = await import("../server/account/recovery.ts");
  const { createInterface } = await import("node:readline/promises");
  const lines = process.stdin.isTTY === true ? createInterface({ input: process.stdin, output: process.stdout }) : null;
  try {
    return await run({
      out: (text) => process.stdout.write(text),
      terminal: lines !== null,
      platform: process.platform,
      ask: (question) => lines === null ? Promise.resolve("") : lines.question(question),
      send: (request, timeoutSeconds) => askRecovery(runningStateDir(APP_STATE_DIR), request, timeoutSeconds),
    });
  } finally { lines?.close(); }
}

/** `ovis confirm` (scripts/plugin-confirm.ts): this PC's confirm page, opened in a browser where there is a desktop. */
async function confirm(): Promise<number> {
  const { runConfirm } = await import("./plugin-confirm.ts");
  return await runConfirm({
    stateDir: runningStateDir(APP_STATE_DIR), platform: process.platform, uid: process.getuid?.(),
    env: { DISPLAY: process.env["DISPLAY"], WAYLAND_DISPLAY: process.env["WAYLAND_DISPLAY"] },
    out: (text) => process.stdout.write(text),
    open: (url) => { spawn("xdg-open", [url], { stdio: "ignore", detached: true }).on("error", () => {}).unref(); },
  });
}

const cliContext = (): CliContext => ({ account: accountOpensAll(), tui: platform() !== "win32" });

/** Plain `ovis`: the help where a person sits at a terminal. A script or a pipe gets `status`, as every release gave it. */

// install.sh's launcher greps this file for COMMAND_ALIASES (scripts/plugin-runtime.ts), "link" and "tui" to tell a
// checkout that knows a command from one that predates it: keep each of them named here
export async function runPlugin(): Promise<void> {
  const words = process.argv.slice(2);
  if (isBareTui(words)) process.exit(await status());
  const parsed = parseCommand(words, cliContext());
  if (parsed.kind === "help") {
    process.stdout.write(parsed.text);
    process.exit(0);
  }
  if (parsed.kind === "version") {
    process.stdout.write(`${runningVersion() ?? builtVersion}\n`);
    process.exit(0);
  }
  if (parsed.kind === "bad") {
    process.stderr.write(parsed.text);
    process.exit(2);
  }
  if (parsed.kind === "unknown") {
    const active = activePluginScript(ROOT, port, APP_STATE_DIR);
    if (active !== join(resolve(ROOT), "scripts", "plugin.ts") && resolve(active) !== resolve(import.meta.filename)) process.exit(await handOn(active, words));
    process.stderr.write(unknownCommand(parsed.word));
    process.exit(2);
  }
  const { command, args } = parsed;
  switch (command) {
    case "agent": process.exit(await (await import("./plugin-agent.ts")).runAgent(args));
    case "start": process.exit(await start());
    case "stop": process.exit(await stop());
    case "status": process.exit(await status(args));
    case "pair": process.exit(await pair(args));
    case "link": process.exit(await linkCommand(args));
    case "join": process.exit(await joinCommand(args));
    case "logout": process.exit(await logout());
    case "recover": process.exit(await recover(args));
    case "confirm": process.exit(await confirm());
    case "phone": process.exit(await phone());
    case "phone-setup": process.exit(await phoneSetup());
    case "tui": process.exit(await runTui(args));
  }
}

if (import.meta.main) await runPlugin();
