import { resolveHerdrKeys } from "../shared/herdr-keys.ts";
import type { HerdrUiConfig } from "../shared/protocol.ts";
import { herdrConfigPath, readHerdrConfig } from "./herdr-sidebar.ts";

/**
 * The herdr client preferences of the PC serving this web UI that its own selection follows (#1559):
 * `[ui] copy_on_select`, read again on each request. herdr's default (on) stands for a config that
 * is missing, unreadable or no TOML, and for a value that is no boolean.
 */
export function readHerdrUi(path = herdrConfigPath()): HerdrUiConfig {
  const config = readHerdrConfig(path);
  const ui = typeof config === "object" && config !== null ? (config as { ui?: unknown }).ui : undefined;
  const copy = typeof ui === "object" && ui !== null ? (ui as { copy_on_select?: unknown }).copy_on_select : undefined;
  return { copy_on_select: typeof copy === "boolean" ? copy : true, keys: resolveHerdrKeys(typeof config === "object" && config !== null ? (config as { keys?: unknown }).keys : undefined) };
}

