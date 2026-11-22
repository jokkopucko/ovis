import { homedir } from "node:os";
import { join } from "node:path";

const LEGACY_PREFIX = "HERDR_WEB_";
const RENAMED: Record<string, string> = { HERDR_WEB_UI_REF: "OVIS_REF" };

export function ovisName(legacy: string): string | null {
  if (!legacy.startsWith(LEGACY_PREFIX)) return null;
  return RENAMED[legacy] ?? `OVIS_${legacy.slice(LEGACY_PREFIX.length)}`;
}

export function legacyName(name: string): string | null {
  if (!name.startsWith("OVIS_")) return null;
  return Object.keys(RENAMED).find((legacy) => RENAMED[legacy] === name) ?? `${LEGACY_PREFIX}${name.slice("OVIS_".length)}`;
}

export function withLegacyNames(settings: Record<string, string>): Record<string, string> {
  const both = { ...settings };
  for (const [name, value] of Object.entries(settings)) {
    const legacy = legacyName(name);
    if (legacy !== null) both[legacy] = value;
  }
  return both;
}

export function adoptLegacyEnv(env: Record<string, string | undefined>): void {
  for (const [name, value] of Object.entries(env)) {
    const next = ovisName(name);
    if (next !== null && value !== undefined && env[next] === undefined) env[next] = value;
  }
}

/**
 * The state dir of the launcher (server/managed.ts) that started this supervisor, when that
 * launcher is from before the rename; null under a launcher of this version (which sets
 * OVIS_LAUNCHER) or none. An update never replaces a running launcher, and the old one looks for
 * the active release only under its own state dir, so a supervisor it starts keeps the state there.
 */
export function legacyLauncherStateDir(env: Record<string, string | undefined>): string | null {
  if (env["OVIS_LAUNCHER"] !== undefined || env["HERDR_WEB_SOURCE_ROOT"] === undefined) return null;
  return env["HERDR_WEB_STATE_DIR"] || join(env["XDG_CONFIG_HOME"] || join(homedir(), ".config"), "herdr-web-ui");
}

export function mergeEnvLayers(layers: Record<string, string | undefined>[]): Record<string, string | undefined> {
  const merged: Record<string, string | undefined> = {};
  for (const layer of layers) {
    const own = { ...layer };
    adoptLegacyEnv(own);
    Object.assign(merged, own);
  }
  return merged;
}
