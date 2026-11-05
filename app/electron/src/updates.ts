/**
 * Whether the app updates itself, and from where. A packaged build does when it was built with a
 * feed (OVIS_UPDATE_FEED at build time writes electron-builder's app-update.yml) or is started
 * with OVIS_UPDATE_URL; a development run never does, and OVIS_UPDATES=0 turns it off.
 *
 * The beta channel (the same setting as the server's: OVIS_UPDATE_CHANNEL, or `beta` in the
 * `update-channel` file of the server's state dir) takes the beta builds CI publishes from green
 * main (.github/workflows/beta.yml) from BETA_FEED instead. It is read when the app starts.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { readUpdateChannel, type UpdateChannel } from "../../../shared/update.ts";

type Env = Record<string, string | undefined>;

/** The rolling `desktop-beta` prerelease the beta workflow uploads each beta build and its feed files to. */
export const BETA_FEED = "https://github.com/devswha/ovis/releases/download/desktop-beta";
/** The setting file in the server's state dir, the one server/updater.ts reads (UPDATE_CHANNEL_FILE). */
const CHANNEL_FILE = "update-channel";

export type UpdatePlan = { enabled: false; reason: string } | { enabled: true; feed: string | null; channel: UpdateChannel };

/** OVIS_UPDATE_CHANNEL when it names a channel, else the state dir's `update-channel` file, else stable. */
export function updateChannel(env: Env, stateDir: string): UpdateChannel {
  const set = readUpdateChannel(env["OVIS_UPDATE_CHANNEL"]);
  if (set) return set;
  try { return readUpdateChannel(readFileSync(join(stateDir, CHANNEL_FILE), "utf8")) ?? "stable"; }
  catch { return "stable"; }
}

export function updatePlan(options: { packaged: boolean; env: Env; platform: string; builtWithFeed: boolean; channel?: UpdateChannel }): UpdatePlan {
  const { env } = options;
  const channel = options.channel ?? "stable";
  if (["0", "false", "off", "no"].includes(env["OVIS_UPDATES"]?.trim().toLowerCase() ?? "")) return { enabled: false, reason: "turned off with OVIS_UPDATES" };
  if (!options.packaged) return { enabled: false, reason: "a development run" };
  // electron-updater replaces only an AppImage on Linux
  if (options.platform === "linux" && !env["APPIMAGE"]) return { enabled: false, reason: "only the AppImage updates itself" };
  const override = env["OVIS_UPDATE_URL"]?.trim();
  if (override) {
    let url: URL;
    try { url = new URL(override); } catch { return { enabled: false, reason: `OVIS_UPDATE_URL is not an address: ${override}` }; }
    if (url.protocol !== "https:") return { enabled: false, reason: "OVIS_UPDATE_URL must be an https address" };
    return { enabled: true, feed: url.href, channel };
  }
  if (options.builtWithFeed) return { enabled: true, feed: channel === "beta" ? BETA_FEED : null, channel };
  return { enabled: false, reason: "this build has no update feed" };
}
