import { join } from "node:path";
import { AcpChildren } from "../acp/children.ts";
import { chmodSync, mkdirSync, realpathSync, statSync } from "node:fs";
import { startHerdrCoreAdapter, type HerdrCoreAdapter } from "./adapter.ts";
import { HcConnection } from "./connection.ts";
import { spawnHcConnect } from "./hc-connect.ts";
import { MachineScopedConnection } from "./machine-scope.ts";
import { SeenMarker } from "./seen-label.ts";
import { coreStartEnv, terminalEnvFor, userTerminalEnv } from "./terminal-env.ts";
import { existsSync } from "node:fs";
import { createConnection } from "node:net";
import { coreSocket } from "./core-socket.ts";
import { BUNDLED_PROBE_TIMEOUT_MS, findHc, type FoundHc } from "./discovery.ts";
import { adapterAddress } from "./pipe.ts";
import { opencodeDatabasePath, opencodeSessionsTitled } from "../opencode.ts";
import { HERDR_CORE, serveRuntime } from "../runtime/capabilities.ts";
import type { RuntimeName } from "../../shared/machines.ts";

export type Runtime = RuntimeName;

let chosen: Runtime | null = null;

export function setRuntime(runtime: Runtime | null): void {
  chosen = runtime;
}

export function runtime(): Runtime {
  if (chosen !== null) return chosen;
  const value = process.env["OVIS_RUNTIME"];
  if (value === undefined || value === "" || value === "herdr") return "herdr";
  if (value === "herdr-core" || value === "alt-runtime") return value;
  throw new Error(`OVIS_RUNTIME=${value} is not a runtime Ovis knows: use herdr (the default), herdr-core or alt-runtime`);
}

let found: string | null = null;

let search: (() => Promise<FoundHc | null>) | null = null;
let recovering: Promise<void> | null = null;
let lost = false;
/** a search that found nothing is not run again sooner: each one runs the login shell and every candidate */
const RECOVERY_GAP_MS = 10_000;
let searchedAt = 0;
/** what hcBin answers meanwhile: a path that cannot exist (/dev/null is no folder), so nothing unverified runs */
export const HC_MOVED = "/dev/null/herdr-core-moved";

/**
 * Once an update moved the one found, nothing but a freshly verified hc is handed out: the start's
 * own search runs again (the login shell's PATH included, every candidate asked `--version`
 * afresh), and until it finds one this answers HC_MOVED, which no spawn can run, so even a file
 * that reappears at the old path is not run unchecked.
 */
export function hcBin(): string {
  if (found !== null && search !== null && !lost && !existsSync(found)) lost = true;
  if (lost && search !== null && recovering === null && Date.now() - searchedAt >= RECOVERY_GAP_MS) {
    const again = search;
    searchedAt = Date.now();
    recovering = again().then((core) => {
      if (core !== null && search === again) { found = core.bin; lost = false; }
    }, () => {}).finally(() => { recovering = null; });
  }
  if (lost) return HC_MOVED;
  return found ?? (process.env["OVIS_HC_BIN"] || "hc");
}

export function hcRecovery(): Promise<void> | null {
  return recovering;
}

export class NoHerdrCoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NoHerdrCoreError";
  }
}

export class NoAltRuntimeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NoAltRuntimeError";
  }
}

export function hcMachine(): { name: string; id: string } | null {
  const name = process.env["OVIS_HC_MACHINE"];
  const id = process.env["OVIS_HC_MACHINE_ID"];
  return name && id ? { name, id } : null;
}

export function hcEnv(): Record<string, string | undefined> | undefined {
  const kept = process.env["OVIS_HC_ENV"];
  return kept ? { ...process.env, ...(JSON.parse(kept) as Record<string, string>) } : undefined;
}

export function coreSocketPath(): string {
  return coreSocket({ env: hcEnv() ?? process.env }).path;
}

/**
 * Whether a core answers on `path`: a connect, not the file, decides, as a core that crashed or was
 * killed leaves its socket file (on macOS in the state folder, also across a reboot).
 */
function coreAnswers(path: string): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = createConnection(path);
    const done = (answers: boolean) => { probe.destroy(); resolve(answers); };
    probe.setTimeout(1000, () => done(false));
    probe.once("connect", () => done(true));
    probe.once("error", () => done(false));
  });
}

/** HERDR_SOCKET as this process had it before startRuntime pointed it at the adapter (null until then): a core `hc connect` starts hands its env to every pane */
let herdrSocketBefore: { HERDR_SOCKET: string | undefined } | null = null;
let adapterSocket: string | null = null;
let children: AcpChildren | null = null;

/** The registry of this runtime only, never a terminal with the same address on another core. */
export function coreAcp(): AcpChildren | null {
  return process.env["HERDR_SOCKET"] === adapterSocket ? children : null;
}

let terminalEnvironment: Record<string, string> = {};

let connection: HcConnection | null = null;

let marker: SeenMarker | null = null;

export function coreSeenMarker(): SeenMarker {
  marker ??= new SeenMarker(coreConnection());
  return marker;
}

export function coreConnection(): HcConnection {
  const spawn = () => spawnHcConnect(hcBin(), coreStartEnv({ ...(hcEnv() ?? process.env), ...herdrSocketBefore }, terminalEnvironment));
  const machine = hcMachine();
  connection ??= machine === null ? new HcConnection(spawn) : new MachineScopedConnection(spawn, machine.name, machine.id);
  return connection;
}

export async function startRuntime(stateDir: string, find: (onRefused?: (bin: string, reason: string) => void) => Promise<FoundHc | null> = (onRefused) => findHc(onRefused ? { onRefused } : {}),
  terminalEnv: () => Promise<Record<string, string>> = () => userTerminalEnv(hcEnv() ?? process.env)): Promise<HerdrCoreAdapter | null> {
  if (runtime() === "alt-runtime") throw new NoAltRuntimeError("this Ovis cannot start alt-runtime yet");
  if (runtime() !== "herdr-core") return null;
  const platform = process.platform;
  if (platform !== "linux" && platform !== "darwin" && platform !== "win32") {
    throw new Error(`OVIS_RUNTIME=herdr-core is served on Linux, macOS and Windows, not ${platform}`);
  }
  // The terminals' environment is read while hc is looked for (both run a login shell); another machine's
  // terminals are not this PC's user's, and keep that machine's own.
  const failed = (error: unknown): Record<string, string> => {
    console.warn(`[herdr-core] terminals start without the login shell's environment: ${error instanceof Error ? error.message : String(error)}`);
    return {};
  };
  const reading = hcMachine() === null ? terminalEnv().catch(failed) : Promise.resolve({});
  const unix = platform !== "win32";
  try {
    // before the first `hc connect`: the plugin's or a service's PATH may not hold hc, or hold another one
    const refused: string[] = [];
    const core = await find((bin, reason) => { refused.push(`${bin}: ${reason}`); });
    if (core === null) {
      const passedOver = refused.length === 0 ? "" : ` Passed over as another account could change them: ${refused.join("; ")}. ${unix ? "Make the folder yours alone (`chmod g-w <folder>`)" : "Keep hc inside your profile folder"} or set OVIS_HC_BIN to the hc you trust.`;
      const named = process.env["OVIS_HC_BIN"];
      if (named && process.env["OVIS_HC_BIN_BUNDLED"] === "1") throw new NoHerdrCoreError(`no herdr-core found: the app's own hc (OVIS_HC_BIN=${named}) did not answer \`--version\` with \`hc …\` within ${BUNDLED_PROBE_TIMEOUT_MS / 1000}s, nor did herdr-core or hc in ~/.local/bin, /opt/homebrew/bin, /usr/local/bin, mise, Nix, cargo, the PATH or the login shell's PATH. Reinstall the app, or install herdr-core (https://herdr.dev/core).${passedOver}`);
      if (named) throw new NoHerdrCoreError(`no herdr-core found: OVIS_HC_BIN (${named}) did not answer \`--version\` with \`hc …\`, and no other hc is run while it is set. Fix OVIS_HC_BIN or unset it.${passedOver}`);
      throw new NoHerdrCoreError(`no herdr-core found: no OVIS_HC_BIN, nor herdr-core or hc in ~/.local/bin, /opt/homebrew/bin, /usr/local/bin, mise, Nix, cargo, the PATH or the login shell's PATH, answered \`--version\` with \`hc …\` (one in a folder another account can change is not run). Install herdr-core (https://herdr.dev/core) or set OVIS_HC_BIN to its full path.${passedOver}`);
    }
    // the app's own hc did not answer: say which one runs instead, once, as the server starts
    if (core.insteadOf) console.warn(`[herdr-core] the app's own hc (${core.insteadOf}) did not answer \`--version\` within ${BUNDLED_PROBE_TIMEOUT_MS / 1000}s; using ${core.bin} (hc ${core.version}) instead`);
    found = core.bin;
    search = find;
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    // Windows has no owner uid or mode bits to check: the folder is in the user's own profile
    if (unix && statSync(stateDir).uid !== process.geteuid?.()) throw new Error("the herdr-core state directory is not owned by this user");
    if (unix) chmodSync(stateDir, 0o700);
  } catch (error) {
    await reading;
    throw error;
  }
  // a core this server's `hc connect` may start keeps the environment it is started in: wait for the read.
  // One already running has its own, and its terminals wait for the read themselves (terminalEnvFor), so
  // the server does not wait on a slow profile at its start
  const coreRuns = await coreAnswers(coreSocketPath());
  if (!coreRuns) terminalEnvironment = await reading;
  const hc = coreConnection();
  if (coreRuns) void reading.then((env) => { if (connection === hc) terminalEnvironment = env; });
  // on Windows the pipe is named after the folder itself: a junction or a short (8.3) spelling of it names the same pipe
  const acp = hcMachine() === null ? new AcpChildren(join(stateDir, "acp"), { hc }) : null;
  const adapter = await startHerdrCoreAdapter(hc, adapterAddress(unix ? stateDir : realpathSync.native(stateDir), platform), (address, turn, labels) => coreSeenMarker().observe(address, turn, labels),
    // another machine's OpenCode keeps its sessions there: none of its panes is bound to one here
    hcMachine() !== null ? { otherMachine: true } : { acp, opencodeTitled: (title) => opencodeSessionsTitled(opencodeDatabasePath(), title), terminalEnv: terminalEnvFor(hc, reading, hcEnv() ?? process.env) });
  if (unix) chmodSync(adapter.socketPath, 0o600);
  if (herdrSocketBefore === null || process.env["HERDR_SOCKET"] !== adapterSocket) herdrSocketBefore = { HERDR_SOCKET: process.env["HERDR_SOCKET"] };
  adapterSocket = adapter.socketPath;
  children = acp;
  process.env["HERDR_SOCKET"] = adapter.socketPath;
  serveRuntime(HERDR_CORE);
  return {
    socketPath: adapter.socketPath,
    stop: (options) => {
      children?.close();
      children = null;
      const drained = adapter.stop(options);
      if (drained) return drained.finally(finish);
      finish();
    },
  };

  function finish(): void {
    hc.close();
    connection = null;
    marker = null;
    terminalEnvironment = {};
    serveRuntime(null);
    found = null;
    search = null;
    lost = false;
    searchedAt = 0;
  }
}
