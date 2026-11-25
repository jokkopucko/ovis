/**
 * Ovis's own settings files, as the plugin reads them: `env` and `.env` in its config dir. scripts/plugin.ts reads them
 * at import, and `ovis tui` reads them without that import (scripts/plugin-tui.ts).
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { mergeEnvLayers } from "../server/legacy-env.ts";

/**
 * Read in this order, so `.env` wins: `env` is what this plugin read first, `.env` is what herdr's
 * plugin docs suggest, and a user who edits `.env` from those docs must not be overridden by an old `env`.
 */
export const ENV_FILES = ["env", ".env"];

/** the dir under its Ovis name, or under the name before the rename while only that one exists */
export function ownDir(parent: string): string {
  const legacy = join(parent, "herdr-web-ui");
  const next = join(parent, "ovis");
  return existsSync(next) || !existsSync(legacy) ? next : legacy;
}

/** `KEY=value` lines of one settings file */
export function readEnvFile(file: string): Record<string, string> {
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

/** Ovis's settings files, read where scripts/plugin.ts reads them, without asking herdr for its config dir. */
export function readPluginSettings(env: Record<string, string | undefined>, home: string): Record<string, string | undefined> {
  const dir = env["HERDR_PLUGIN_CONFIG_DIR"] ?? ownDir(join(home, ".config"));
  return mergeEnvLayers(ENV_FILES.map((name) => join(dir, name)).filter((file) => existsSync(file)).map(readEnvFile));
}
