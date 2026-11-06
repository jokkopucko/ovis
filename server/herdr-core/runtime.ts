import { chmodSync, mkdirSync, realpathSync, statSync } from "node:fs";
import { startHerdrCoreAdapter, type HerdrCoreAdapter } from "./adapter.ts";
import { HcConnection, spawnHcConnect } from "./connection.ts";
import { MachineScopedConnection } from "./machine-scope.ts";
import { SeenMarker } from "./seen-label.ts";
import { existsSync } from "node:fs";
import { coreSocket, findHc, type FoundHc } from "./discovery.ts";
import { adapterAddress } from "./pipe.ts";
import { opencodeDatabasePath, opencodeSessionsTitled } from "../opencode.ts";

/**
 * Which runtime this PC's terminals run on. `OVIS_RUNTIME=herdr-core` serves the terminals of
 * herdr-core (`hc`), the core the Herdr desktop app runs on, in place of herdr's TUI server; unset,
 * or `herdr`, keeps herdr; without it, the choice saved from Settings or what the PC has decides
 * (runtime-choice.ts). Settled once per process: a server does not change runtime while it runs.
 */
export type Runtime = "herdr" | "herdr-core";

/** the runtime the server chose as it started (runtime-choice.ts); unset, OVIS_RUNTIME decides */
let chosen: Runtime | null = null;

export function setRuntime(runtime: Runtime | null): void {
  chosen = runtime;
}

export function runtime(): Runtime {
  if (chosen !== null) return chosen;
  const value = process.env["OVIS_RUNTIME"];
  if (value === undefined || value === "" || value === "herdr") return "herdr";
  if (value === "herdr-core") return "herdr-core";
  throw new Error(`OVIS_RUNTIME=${value} is not a runtime Ovis knows: use herdr (the default) or herdr-core`);
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

let connection: HcConnection | null = null;
/** whether this process serves herdr-core (startRuntime ran): a remote bridge inheriting OVIS_RUNTIME does not */
let serving = false;

export function servingCore(): boolean {
  return serving;
}

let marker: SeenMarker | null = null;

/** The server's one `herdr.seen` writer, which the adapter's events tell what other clients marked seen. */
export function coreSeenMarker(): SeenMarker {
  marker ??= new SeenMarker(coreConnection());
  return marker;
}

/** The server's one line to hc, which the adapter answers through and live terminals stream on. */
export function coreConnection(): HcConnection {
  const spawn = () => spawnHcConnect(hcBin(), hcEnv());
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
export async function startRuntime(stateDir: string, find: () => Promise<FoundHc | null> = () => findHc()): Promise<HerdrCoreAdapter | null> {
  if (runtime() !== "herdr-core") return null;
  const platform = process.platform;
  if (platform !== "linux" && platform !== "darwin" && platform !== "win32") {
    throw new Error(`OVIS_RUNTIME=herdr-core is served on Linux, macOS and Windows, not ${platform}`);
  }
  // before the first `hc connect`: the plugin's or a service's PATH may not hold hc, or hold another one
  const core = await find();
  if (core === null) {
    throw new NoHerdrCoreError("no herdr-core found: no OVIS_HC_BIN, nor herdr-core or hc on the PATH, the login shell's PATH, ~/.local/bin, /opt/homebrew/bin, /usr/local/bin, mise, Nix or cargo, answered `--version` with `hc …`. Install herdr-core (https://herdr.dev/core) or set OVIS_HC_BIN to its full path");
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
  process.env["HERDR_SOCKET"] = adapter.socketPath;
  serving = true;
  return {
    socketPath: adapter.socketPath,
    stop: () => {
      adapter.stop();
      hc.close();
      connection = null;
      marker = null;
      serving = false;
      found = null;
      search = null;
      lost = false;
      searchedAt = 0;
    },
  };
}
