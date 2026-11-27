/**
 * Ovis's own settings files, as the plugin reads them: `env` and `.env` in its config dir. scripts/plugin.ts reads them
 * at import, and `ovis tui` reads them without that import (scripts/plugin-tui.ts).
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { mergeEnvLayers } from "../server/legacy-env.ts";

/**
 * Read in this order, so `.env` wins: `env` is what this plugin read first, `.env` is what herdr's
 * plugin docs suggest, and a user who edits `.env` from those docs must not be overridden by an old `env`.
 */
export const ENV_FILES = ["env", ".env"];
export const PLUGIN_ID = "devswha.ovis";
export const LEGACY_PLUGIN_ID = "devswha.herdr-web-ui";

/** An installed launcher from before the app's first start after an upgrade has only its config directory. */
export function desktopCommandRecord(env: Readonly<Record<string, string | undefined>>): string | undefined {
  const config = env["HERDR_PLUGIN_CONFIG_DIR"];
  return env["OVIS_DESKTOP_COMMAND_RECORD"] ?? (config && join(dirname(config), "desktop.json"));
}

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

/** A shell outside herdr has no injected directory: ask herdr on that shell's PATH. */
export function pluginConfigDir(env: Record<string, string | undefined>, home: string): string {
  const explicit = env["HERDR_PLUGIN_CONFIG_DIR"];
  if (explicit !== undefined) return explicit;
  const pathName = process.platform === "win32" ? Object.keys(env).find((name) => name.toUpperCase() === "PATH") : "PATH";
  const herdr = Bun.which("herdr", { PATH: env[pathName ?? "PATH"] ?? "" });
  if (herdr !== null) {
    for (const id of [PLUGIN_ID, LEGACY_PLUGIN_ID]) {
      try {
        const result = Bun.spawnSync([herdr, "plugin", "config-dir", id], {
          env, windowsHide: true, stdin: "ignore", stdout: "pipe", stderr: "ignore", timeout: 3000,
        });
        const dir = result.exitCode === 0 ? result.stdout.toString().trim() : "";
        if (dir !== "" && ENV_FILES.some((name) => existsSync(join(dir, name)))) return dir;
      } catch {
        break;
      }
    }
  }
  return ownDir(join(home, ".config"));
}

/** Ovis's settings files, read without copying any legacy files. */
export function readPluginSettings(env: Record<string, string | undefined>, home: string): Record<string, string | undefined> {
  const dir = pluginConfigDir(env, home);
  return mergeEnvLayers(ENV_FILES.map((name) => join(dir, name)).filter((file) => existsSync(file)).map(readEnvFile));
}
