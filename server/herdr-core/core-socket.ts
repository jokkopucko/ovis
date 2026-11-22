/**
 * Where the core of this environment listens, as hc works it out, and whether its socket file is
 * there. It reads hc's config.toml and the home of the user and nothing more, so a client that
 * only talks to a core can import it without the rest of the server; it never connects.
 */

import { statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { readHerdrConfig } from "../herdr-sidebar.ts";
import { sameSocket } from "../herdr/test-session.ts";
import { userHome } from "../user-home.ts";

type Env = Record<string, string | undefined>;

export interface CoreSocketOptions {
  env?: Env;
  home?: string;
  platform?: NodeJS.Platform;
  /** `/run/user/<uid>` when that folder exists, else null: hc's runtime dir without XDG_RUNTIME_DIR */
  userRuntimeDir?: string | null;
}

export interface CoreSocket {
  session: string;
  path: string;
  /** the socket file is there; it is never connected to, so a core that died may leave one */
  running: boolean;
}

/**
 * Where the core of this environment listens, as hc works it out (herdr-core paths.rs): HC_SOCKET,
 * else `socket` in its config.toml, else `<session>.sock` in herdr-core under the runtime dir
 * (XDG_RUNTIME_DIR, else /run/user/<uid>), else beside the state in
 * `$XDG_STATE_HOME/herdr-core/<session>/` (macOS). The session is HC_SESSION, else `default`.
 */
export function coreSocket(options: CoreSocketOptions = {}): CoreSocket {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const home = options.home ?? userHome(env, platform);
  const session = env["HC_SESSION"]?.trim() || "default";
  const config = join(env["XDG_CONFIG_HOME"] || join(home, ".config"), "herdr-core", "config.toml");
  const state = join(env["XDG_STATE_HOME"] || join(home, ".local", "state"), "herdr-core", session);
  const path = env["HC_SOCKET"] || configuredSocket(config) || defaultSocket();
  return { session, path, running: exists(path) };

  function defaultSocket(): string {
    if (platform === "win32") return `\\\\.\\pipe\\herdr-core-${(env["USERNAME"] ?? "").replace(/[^A-Za-z0-9]/g, "")}-${session}.sock`;
    const run = runtimeDir(env, options);
    return run === null ? join(state, `${session}.sock`) : join(run, "herdr-core", `${session}.sock`);
  }
}

/** Whether hc in `env` would reach the user's default core: the one this process's environment, or its owner's home, names when no HC_SOCKET or HC_SESSION does. */
export function userCore(env: Record<string, string | undefined>): boolean {
  const unnamed = { ...process.env, HC_SOCKET: undefined, HC_SESSION: undefined };
  const defaults = [coreSocket({ env: unnamed }).path, coreSocket({ env: unnamed, home: homedir() }).path].map(sameSocket);
  return defaults.includes(sameSocket(coreSocket({ env }).path));
}

function runtimeDir(env: Env, options: CoreSocketOptions): string | null {
  if (env["XDG_RUNTIME_DIR"]) return env["XDG_RUNTIME_DIR"];
  if (options.userRuntimeDir !== undefined) return options.userRuntimeDir;
  const uid = process.getuid?.();
  if (uid === undefined) return null;
  const dir = `/run/user/${uid}`;
  try { return statSync(dir).isDirectory() ? dir : null; } catch { return null; }
}

/** `socket` in hc's config.toml, when it sets one */
function configuredSocket(config: string): string | null {
  // read as herdr's own config is: a regular file of a config's size, never a FIFO a health poll would block on
  const parsed = readHerdrConfig(config);
  const socket = parsed !== null && typeof parsed === "object" ? (parsed as Record<string, unknown>)["socket"] : undefined;
  return typeof socket === "string" && socket !== "" ? socket : null;
}

/** hc's Windows pipe answers a stat with EBUSY while each of its instances is taken (live-seen with a core running): it is there */
function exists(path: string): boolean {
  try { statSync(path); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === "EBUSY"; }
}

export function plainSession(session: string): string | null {
  return /^[A-Za-z0-9_.-]{1,64}$/.test(session) && session !== "." && session !== ".." ? session : null;
}
