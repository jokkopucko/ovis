import { existsSync } from "node:fs";
import { join } from "node:path";
import type { HerdrIdentity } from "../../shared/machines.ts";
import { servingCore } from "../herdr-core/runtime.ts";
import { rustSidecar } from "./host.ts";

/**
 * A terminal attach runs on a PTY host: the Rust one (server/pty/host.ts) where it passes its check,
 * else `node pty-host.mjs`, which imports @lydell/node-pty. A runtime with neither (Windows, whose
 * remote bundle ships Bun alone) cannot start one, whatever herdr itself can do, so its panes stay mirrored.
 */
export interface SidecarRuntime {
  rust?: () => boolean;
  node: () => boolean;
  pty: () => boolean;
}

/** a node that hangs must not hold the server: no answer in this long counts as no Node */
const PROBE_TIMEOUT_MS = 3000;

/** the oldest Node pty-host.mjs runs on (top-level await, its syntax) */
const MIN_NODE_MAJOR = 18;

/**
 * `bun run` puts a `node` that is Bun itself first on PATH when the PC has none, and
 * node-pty must not load in Bun (oven-sh/bun#18546): only a `node` that is Node 18 or newer counts.
 * Nor one built for another architecture than this server (an x64 Node under Rosetta on an arm64
 * Mac): node-pty's prebuilt addon is installed for the server's. The probe is written for any
 * Node, however old (no `??`), so an old one answers and is refused.
 */
export function isRealNode(executable: string, env: Record<string, string | undefined> = process.env, timeoutMs = PROBE_TIMEOUT_MS): boolean {
  try {
    const asked = Bun.spawnSync([executable, "-p", "process.versions.bun ? 'bun' : process.versions.node + ' ' + process.arch"], { env, windowsHide: true, stdin: "ignore", stdout: "pipe", stderr: "ignore", timeout: timeoutMs });
    const answer = /^(\d+)\.\S* (\S+)$/.exec(asked.stdout.toString().trim());
    return asked.success && answer !== null && Number(answer[1]) >= MIN_NODE_MAJOR && answer[2] === process.arch;
  } catch {
    return false;
  }
}

const probed = new Map<string, boolean>();

/**
 * Where install.sh puts the Node it installs for the sidecar, and where it put it before the rename.
 * It no longer links that Node into ~/.local/bin, where it overrode the user's own (#596), so the
 * server looks for it here itself.
 */
const APP_NODE_DIRS = [".local/share/ovis/node", ".local/share/herdr-web-ui/node"];

/**
 * The Node a PTY sidecar spawned with `env` runs, as an absolute path, when it is real Node: the
 * app's own Node, else the `node` on that spawn's own PATH, so the check and the spawn can never
 * find two different `node`s. The PATH is the one the spawn inherits (PtySession passes
 * process.env), not the one this process was launched with: a remote bundle adds its own bin/ at
 * runtime (server/remote-entry.ts), and a bare Bun.which() would not see the Node shipped there.
 */
export function realNode(env: Record<string, string | undefined>): string | null {
  const home = env["HOME"];
  const installed = home ? APP_NODE_DIRS.map((dir) => join(home, dir, "bin", "node")).filter((path) => existsSync(path)) : [];
  const onPath = Bun.which("node", { PATH: env["PATH"] ?? "" });
  for (const found of onPath === null ? installed : [...installed, onPath]) {
    let ok = probed.get(found);
    if (ok === undefined) {
      ok = isRealNode(found, env);
      probed.set(found, ok);
    }
    if (ok) return found;
  }
  return null;
}

function nodeHere(): boolean {
  return realNode(process.env) !== null;
}

const here: SidecarRuntime = {
  rust: () => rustSidecar() !== null,
  node: nodeHere,
  pty: () => {
    try {
      Bun.resolveSync("@lydell/node-pty", import.meta.dir);
      return true;
    } catch {
      return false;
    }
  },
};

let node: boolean | null = null;
let known: boolean | null = null;

/**
 * Whether the Node sidecar can run here, taken once: a real Node and node-pty. PtySession asks before
 * it falls back to Node, so a `node` that is Bun never loads node-pty (AGENTS.md).
 */
export function nodeSidecarAvailable(): boolean {
  node ??= here.pty() && here.node();
  return node;
}

/** One rule for every runtime, this one included: the Rust host needs no Node; the Node sidecar needs Node and node-pty. */
const attaches = (runtime: SidecarRuntime, node: () => boolean): boolean => (runtime.rust?.() ?? false) || node();

/** Forgets what was taken of this runtime. Tests only. */
export function resetSidecarForTests(): void {
  node = null;
  known = null;
  probed.clear();
}

/**
 * This runtime's answer is taken once, at startup, where the Rust host's check runs and says which host
 * attaches: every caller (attach, /api/health, /api/bridge) gets the same one. The Rust host needs no Node.
 */
export function sidecarAvailable(runtime?: SidecarRuntime): boolean {
  if (runtime) return attaches(runtime, () => runtime.pty() && runtime.node());
  if (known === null) {
    const rust = here.rust!();
    known = attaches({ ...here, rust: () => rust }, nodeSidecarAvailable);
    // the Rust host announces itself; without it, say which way the panes go
    if (!rust && process.platform !== "win32") console.log(known ? "PTY host: Node" : "PTY host: none (no Rust host and no Node for the sidecar), so panes are mirrored");
  }
  return known;
}

/**
 * herdr's identity as this bridge can serve it: without the sidecar, told the way a herdr that cannot
 * attach tells it. Where this process serves herdr-core, the live terminal is a stream on the server's own hc connection
 * (server/herdr-core/attach-session.ts), so no PTY host is needed.
 */
export function attachableIdentity(identity: HerdrIdentity, sidecar: boolean, onCore = servingCore()): HerdrIdentity {
  if (sidecar || onCore || identity.terminal_attach === false) return identity;
  return { ...identity, terminal_attach: false, terminal_mirror: true };
}
