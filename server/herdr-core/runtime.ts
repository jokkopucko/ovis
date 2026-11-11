import { chmodSync, mkdirSync, realpathSync, statSync } from "node:fs";
import { startHerdrCoreAdapter, type HerdrCoreAdapter } from "./adapter.ts";
import { HcConnection, spawnHcConnect } from "./connection.ts";
import { MachineScopedConnection } from "./machine-scope.ts";
import { SeenMarker } from "./seen-label.ts";
import { existsSync } from "node:fs";
import { coreSocket, findHc, type FoundHc } from "./discovery.ts";
import { adapterAddress } from "./pipe.ts";
import { opencodeDatabasePath, opencodeSessionsTitled } from "../opencode.ts";
import { HERDR_CORE, serveRuntime } from "../runtime/capabilities.ts";
import type { RuntimeName } from "../../shared/machines.ts";

/**
 * Which runtime this PC's terminals run on. `OVIS_RUNTIME=herdr-core` serves the terminals of
 * herdr-core (`hc`), the core the Herdr desktop app runs on, in place of herdr's TUI server; unset,
 * or `herdr`, keeps herdr; without it, the choice saved from Settings or what the PC has decides
 * (runtime-choice.ts). `alt-runtime` is known, but this Ovis cannot start it yet (startRuntime).
 * Settled once per process: a server does not change runtime while it runs.
 */
export type Runtime = RuntimeName;

/** the runtime the server chose as it started (runtime-choice.ts); unset, OVIS_RUNTIME decides */
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

/** the hc startRuntime found (server/herdr-core/discovery.ts); null before it ran */
let found: string | null = null;

/** the search startRuntime ran, run again to find hc once the one found is gone */
let search: (() => Promise<FoundHc | null>) | null = null;
let recovering: Promise<void> | null = null;
/** the hc found is gone and no search has verified another yet */
let lost = false;
/** a search that found nothing is not run again sooner: each one runs the login shell and every candidate */
const RECOVERY_GAP_MS = 10_000;
let searchedAt = 0;
/** what hcBin answers meanwhile: a path that cannot exist (/dev/null is no folder), so nothing unverified runs */
export const HC_MOVED = "/dev/null/herdr-core-moved";

/**
 * The `hc` to run: the one startRuntime found as the Herdr app finds it; before that, OVIS_HC_BIN,
 * else `hc` on the PATH. Once an update moved the one found, nothing but a freshly verified hc is
 * handed out: the start's own search runs again (the login shell's PATH included, every candidate
 * asked `--version` afresh), and until it finds one this answers HC_MOVED, which no spawn can run,
 * so even a file that reappears at the old path is not run unchecked.
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

/** the search for a moved hc in progress, for a caller (a test) that waits for it; null when none runs */
export function hcRecovery(): Promise<void> | null {
  return recovering;
}

/** No hc answered `--version` as herdr-core's: the one start failure a choice saved in Settings falls back from. */
export class NoHerdrCoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NoHerdrCoreError";
  }
}

/** alt-runtime was chosen, but this Ovis cannot start it: a choice saved in Settings falls back from it as from NoHerdrCoreError. */
export class NoAltRuntimeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NoAltRuntimeError";
  }
}

/**
 * The other machine of the core this server shows as a PC of its own (OVIS_HC_MACHINE, set by
 * machine-bridge.ts for the server it starts per machine); null for the core's own terminals.
 */
export function hcMachine(): { name: string; id: string } | null {
  const name = process.env["OVIS_HC_MACHINE"];
  const id = process.env["OVIS_HC_MACHINE_ID"];
  return name && id ? { name, id } : null;
}

/**
 * What `hc connect` runs in: a machine's server runs with a home of its own (machine-bridge.ts), and
 * OVIS_HC_ENV holds what finds the core (HOME, HC_*, XDG_*) as the server that started it has them.
 */
export function hcEnv(): Record<string, string | undefined> | undefined {
  const kept = process.env["OVIS_HC_ENV"];
  return kept ? { ...process.env, ...(JSON.parse(kept) as Record<string, string>) } : undefined;
}

/** Where the core this server's `hc connect` reaches listens, found as hc finds it (discovery.ts coreSocket). */
export function coreSocketPath(): string {
  return coreSocket({ env: hcEnv() ?? process.env }).path;
}

/** HERDR_SOCKET as this process had it before startRuntime pointed it at the adapter (null until then): a core `hc connect` starts hands its env to every pane */
let herdrSocketBefore: { HERDR_SOCKET: string | undefined } | null = null;
/** the adapter socket startRuntime last put in HERDR_SOCKET: a later start in this process finds it there, not the one from before */
let adapterSocket: string | null = null;

let connection: HcConnection | null = null;

let marker: SeenMarker | null = null;

/** The server's one `herdr.seen` writer, which the adapter's events tell what other clients marked seen. */
export function coreSeenMarker(): SeenMarker {
  marker ??= new SeenMarker(coreConnection());
  return marker;
}

/** The server's one line to hc, which the adapter answers through and live terminals stream on. */
export function coreConnection(): HcConnection {
  const spawn = () => spawnHcConnect(hcBin(), { ...(hcEnv() ?? process.env), ...herdrSocketBefore });
  const machine = hcMachine();
  connection ??= machine === null ? new HcConnection(spawn) : new MachineScopedConnection(spawn, machine.name, machine.id);
  return connection;
}

/**
 * On herdr-core, the adapter that answers herdr's API from hc (server/herdr-core/adapter.ts),
 * listening in the state folder (on Windows, on a named pipe named after it: pipe.ts), and
 * HERDR_SOCKET pointed at it before anything reads it; on herdr, nothing. Another Ovis still serving the same state folder is an error, and so is a PC
 * where no hc answers as herdr-core's: nothing is started, and nothing else is run as hc.
 */
export async function startRuntime(stateDir: string, find: (onRefused?: (bin: string, reason: string) => void) => Promise<FoundHc | null> = (onRefused) => findHc(onRefused ? { onRefused } : {})): Promise<HerdrCoreAdapter | null> {
  // never serve herdr in its place under its name: the server says which runtime it serves
  if (runtime() === "alt-runtime") throw new NoAltRuntimeError("this Ovis cannot start alt-runtime yet");
  if (runtime() !== "herdr-core") return null;
  const platform = process.platform;
  if (platform !== "linux" && platform !== "darwin" && platform !== "win32") {
    throw new Error(`OVIS_RUNTIME=herdr-core is served on Linux, macOS and Windows, not ${platform}`);
  }
  // before the first `hc connect`: the plugin's or a service's PATH may not hold hc, or hold another one
  const refused: string[] = [];
  const core = await find((bin, reason) => { refused.push(`${bin}: ${reason}`); });
  if (core === null) {
    // the message is what the server logs as it gives up: each refused hc is named there, once
    const passedOver = refused.length === 0 ? "" : ` Passed over as another account could change them: ${refused.join("; ")}. Make the folder yours alone (\`chmod g-w <folder>\`) or set OVIS_HC_BIN to the hc you trust.`;
    throw new NoHerdrCoreError(`no herdr-core found: no OVIS_HC_BIN, nor herdr-core or hc in ~/.local/bin, /opt/homebrew/bin, /usr/local/bin, mise, Nix, cargo, the PATH or the login shell's PATH, answered \`--version\` with \`hc …\` (one in a folder another account can change is not run). Install herdr-core (https://herdr.dev/core) or set OVIS_HC_BIN to its full path.${passedOver}`);
  }
  found = core.bin;
  search = find;
  // the state folder is otherwise created on first write: the socket goes there first
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  // Windows has no owner uid or mode bits to check: the folder is in the user's own profile
  const unix = platform !== "win32";
  if (unix && statSync(stateDir).uid !== process.geteuid?.()) throw new Error("the herdr-core state directory is not owned by this user");
  if (unix) chmodSync(stateDir, 0o700);
  const hc = coreConnection();
  // on Windows the pipe is named after the folder itself: a junction or a short (8.3) spelling of it names the same pipe
  const adapter = await startHerdrCoreAdapter(hc, adapterAddress(unix ? stateDir : realpathSync.native(stateDir), platform), (address, turn, labels) => coreSeenMarker().observe(address, turn, labels),
    // another machine's OpenCode keeps its sessions there: none of its panes is bound to one here
    hcMachine() !== null ? { otherMachine: true } : { opencodeTitled: (title) => opencodeSessionsTitled(opencodeDatabasePath(), title) });
  if (unix) chmodSync(adapter.socketPath, 0o600);
  if (herdrSocketBefore === null || process.env["HERDR_SOCKET"] !== adapterSocket) herdrSocketBefore = { HERDR_SOCKET: process.env["HERDR_SOCKET"] };
  adapterSocket = adapter.socketPath;
  process.env["HERDR_SOCKET"] = adapter.socketPath;
  // only now: a remote bridge inheriting OVIS_RUNTIME starts no runtime, and serves herdr
  serveRuntime(HERDR_CORE);
  return {
    socketPath: adapter.socketPath,
    stop: () => {
      adapter.stop();
      hc.close();
      connection = null;
      marker = null;
      serveRuntime(null);
      found = null;
      search = null;
      lost = false;
      searchedAt = 0;
    },
  };
}
