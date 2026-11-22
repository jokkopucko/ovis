/**
 * How a test knows the herdr config it is about to write to was made for this check run and will
 * be thrown away with it. herdr keeps linked plugins per user, in `$XDG_CONFIG_HOME/herdr`, not per
 * session: a session name of the test's own does not keep a plugin out of the registry of the
 * herdr the user works in, and neither does a socket path that merely lies outside `~/.config`
 * (anyone's own XDG_CONFIG_HOME does). Only `bun run check` (scripts/check.ts `isolate`) says so,
 * twice: it names the directory in the environment and leaves a file of this name inside it.
 */
import { existsSync } from "node:fs";
import { join, resolve, sep } from "node:path";

export const DISPOSABLE_CONFIG_ENV = "HERDR_TEST_DISPOSABLE_CONFIG";
export const DISPOSABLE_CONFIG_FILE = ".ovis-check-run";

/**
 * The check run's own config directory when herdr's plugin registry and the socket under test
 * both live in it, else null: the caller then writes nothing to any registry.
 */
export function disposableConfig(env: Record<string, string | undefined>, socketPath: string): string | null {
  const named = env[DISPOSABLE_CONFIG_ENV];
  const config = env["XDG_CONFIG_HOME"];
  if (!named || !config || resolve(named) !== resolve(config)) return null;
  if (!existsSync(join(resolve(named), DISPOSABLE_CONFIG_FILE))) return null;
  if (!resolve(socketPath).startsWith(join(resolve(named), "herdr") + sep)) return null;
  return resolve(named);
}
