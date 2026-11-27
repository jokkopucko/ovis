/**
 * Whether the app updates itself, and from where. A packaged build does when it was built with a
 * feed (OVIS_UPDATE_FEED at build time writes electron-builder's app-update.yml); OVIS_UPDATE_URL
 * only replaces that feed, since electron-updater reads app-update.yml again when it downloads.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { AppUpdater } from "electron-updater";
import { readUpdateChannel, type UpdateChannel } from "../../../shared/update.ts";

type Env = Record<string, string | undefined>;

export const BETA_FEED = "https://github.com/devswha/ovis/releases/download/desktop-beta";
/** What every release and beta build has in its app-update.yml (desktop.yml's UPDATE_FEED, beta.yml's STABLE_FEED) */
export const STABLE_FEED = "https://github.com/devswha/ovis/releases/latest/download";
const CHANNEL_FILE = "update-channel";

export type Installer = "default" | "appimage" | "deb";

export type UpdatePlan = { enabled: false; reason: string } | { enabled: true; feed: string | null; channel: UpdateChannel; installer: Installer };

/**
 * How a downloaded .deb is installed (as root, behind the password prompt): apt-get resolves its
 * dependencies in the same command, fails when it did not install, and with --no-remove stops
 * rather than remove another package. No --allow-* flags: the feed only ever offers a newer
 * version, and a local file needs no repository signature.
 *
 * `file` is electron-updater's installerPath, escaped for one shell except for `'`. Behind the
 * prompt (`prompted`) it runs the command as `bash -c '<command>'`, where a `'` would end the
 * quotes: it goes in as `\'\''`. Run as root, one shell reads the command, and `\'` is enough.
 */
export function debInstallCommand(file: string, prompted: boolean): string[] {
  return ["apt-get", "install", "-y", "--no-remove", file.replace(/'/g, prompted ? "\\'\\''" : "\\'")];
}

export function updateChannel(env: Env, stateDir: string): UpdateChannel {
  const set = readUpdateChannel(env["OVIS_UPDATE_CHANNEL"]);
  if (set) return set;
  try { return readUpdateChannel(readFileSync(join(stateDir, CHANNEL_FILE), "utf8")) ?? "stable"; }
  catch { return "stable"; }
}

export function updatePlan(options: { packaged: boolean; env: Env; platform: string; builtWithFeed: boolean; channel?: UpdateChannel; linuxPackage?: string | null; execPath?: string; writable?: (folder: string) => boolean }): UpdatePlan {
  const { env } = options;
  const channel = options.channel ?? "stable";
  if (["0", "false", "off", "no"].includes(env["OVIS_UPDATES"]?.trim().toLowerCase() ?? "")) return { enabled: false, reason: "turned off with OVIS_UPDATES" };
  if (!options.packaged) return { enabled: false, reason: "a development run" };
  // without app-update.yml electron-updater finds an update but fails to download it. Asked first:
  // a Linux package gets its package-type file only from a build with a feed
  if (!options.builtWithFeed) return { enabled: false, reason: "this build has no update feed" };
  let installer: Installer = "default";
  if (options.platform === "linux") {
    // chosen here, not by electron-updater: it goes by the package-type file alone, and electron-builder
    // writes that file into the folder the AppImage is also built from (whether the AppImage gets it
    // depends on which target builds first). An AppImage only when this program runs from its mount:
    // APPIMAGE alone may be left over from another AppImage that started this one, and the
    // AppImage updater would overwrite that file.
    // (an APPDIR of / would contain every program)
    const mount = env["APPDIR"]?.replace(/\/+$/, "");
    if (env["APPIMAGE"] && mount && options.execPath?.startsWith(`${mount}/`)) {
      // the AppImage updater puts the new file in the place of the old one. In a folder the user cannot
      // write (one under /opt, say) that fails, after Restart to Update has stopped the server for it
      const folder = dirname(env["APPIMAGE"]);
      if (options.writable && !options.writable(folder)) return { enabled: false, reason: `the AppImage is in a folder that cannot be written (${folder}), so it cannot replace itself there` };
      installer = "appimage";
    }
    else if (options.linuxPackage === "deb") installer = "deb";
    else return { enabled: false, reason: "only the AppImage and the .deb install update themselves" };
  }
  const override = env["OVIS_UPDATE_URL"]?.trim();
  if (override) {
    let url: URL;
    try { url = new URL(override); } catch { return { enabled: false, reason: `OVIS_UPDATE_URL is not an address: ${override}` }; }
    if (url.protocol !== "https:") return { enabled: false, reason: "OVIS_UPDATE_URL must be an https address" };
    return { enabled: true, feed: url.href, channel, installer };
  }
  if (channel === "beta" && options.platform === "win32") return { enabled: true, feed: null, channel: "stable", installer };
  return { enabled: true, feed: channel === "beta" ? BETA_FEED : null, channel, installer };
}

/** One feed a check reads: its address (none: the one app-update.yml names), and electron-updater's channel file and prerelease setting for it */
export interface FeedSource {
  feed: string | null;
  channel: "beta" | "latest";
  prerelease: boolean;
}

/**
 * The feeds one check reads, in order, until one offers a version. The beta channel reads the
 * stable feed after its own: a stable release is newer than the beta it came from (0.5.10 after
 * 0.5.10-beta.7), and the beta feed moves past it only with the next daily beta, which is not made
 * while the release's tag holds main's newest green commit. electron-updater never offers a version
 * older than the running one, so a beta newer than the stable release is kept.
 */
export function checkFeeds(plan: Extract<UpdatePlan, { enabled: true }>): FeedSource[] {
  if (plan.channel === "stable") return [{ feed: plan.feed, channel: "latest", prerelease: false }];
  const beta: FeedSource = { feed: plan.feed, channel: "beta", prerelease: true };
  // OVIS_UPDATE_URL names the one feed to read
  return plan.feed === BETA_FEED ? [beta, { feed: STABLE_FEED, channel: "latest", prerelease: false }] : [beta];
}

export const UPDATE_CHECK_INTERVAL_MS = 60 * 60 * 1000;

export interface HeldUpdate {
  version: string;
  file: string;
}

/**
 * A downloaded update on its way to Restart to Update. Everywhere but a Mac the downloaded file is
 * all an install needs, and the update is `ready` at once. On a Mac electron-updater's
 * "update-downloaded" only means the zip was handed to Squirrel, which still has to take it, check
 * its signature and unpack it, and says so with an event of its own: until then the update is
 * `staging`. Offered before that, Restart to Update stops the server and waits for a Squirrel that
 * may have failed for good (an app run from its disk image or translocated, a signature it
 * refuses).
 */
export interface UpdateOffer {
  /** a Mac only: downloaded and handed to Squirrel, which has not said it holds it */
  staging: HeldUpdate | null;
  ready: HeldUpdate | null;
}

export const NO_OFFER: UpdateOffer = { staging: null, ready: null };

export type UpdaterEvent = { is: "downloaded"; update: HeldUpdate } | { is: "staged" } | { is: "error" };

/**
 * The offer after `event`. An error drops what Squirrel had not taken yet (the next check hands it
 * over again); what it already holds stays, also while a newer version stages, since that is what
 * a restart installs until the newer one is held.
 */
export function nextOffer(offer: UpdateOffer, event: UpdaterEvent, platform: string): UpdateOffer {
  if (event.is === "downloaded") return platform === "darwin" ? { ...offer, staging: event.update } : { staging: null, ready: event.update };
  if (offer.staging === null) return offer;
  return event.is === "staged" ? { staging: null, ready: offer.staging } : { ...offer, staging: null };
}

/**
 * The update the app still holds: none once its file is gone. A later download that fails empties
 * electron-updater's folder, the held file with it, and Restart to Update would then stop the
 * server and find nothing to install.
 */
export function stillHeld<Held extends HeldUpdate>(held: Held | null, exists: (file: string) => boolean): Held | null {
  return held !== null && exists(held.file) ? held : null;
}

/**
 * Whether a check downloads the version the feed names (`found`). Not the one the app already
 * holds: electron-updater answers that download with the file it has and says "update-downloaded"
 * again, every check (on a Mac it copies the zip and hands it to Squirrel again first). A held
 * file that is gone is downloaded again, and so is anything once the updater reported an error
 * (`failed`): whatever failed, a Mac's staging of the download too, gets the try it always got.
 */
export function downloadsUpdate(check: { found: string; held: HeldUpdate | null; failed: boolean; exists: (file: string) => boolean }): boolean {
  return check.failed || stillHeld(check.held, check.exists)?.version !== check.found;
}

/** How a check ended: nothing newer, a version not downloaded (held already, or the app quitting), downloaded, or failed. */
export type CheckOutcome = { is: "latest" } | { is: "skipped" } | { is: "downloaded" } | { is: "failed"; error: string };

/**
 * The updater's error event already reports a failed download (a cancelled one is no error): the
 * promise of that download is only caught, where left alone it was logged a second time as an
 * unhandled rejection (#2831). A download that fails before it begins (a feed that names a version
 * with no file for this app) throws instead, with no event, and is logged here.
 */
export async function checkForUpdates(updater: Pick<AppUpdater, "checkForUpdates" | "downloadUpdate">, log: (line: string) => void, wanted: (version: string) => boolean = () => true): Promise<CheckOutcome> {
  const told = (error: unknown) => error instanceof Error ? error.message : String(error);
  let failure: string | null = null;
  const result = await updater.checkForUpdates().catch((error: unknown) => {
    failure = told(error);
    log(`Update check failed: ${failure}`);
    return null;
  });
  if (failure !== null) return { is: "failed", error: failure };
  if (!result?.isUpdateAvailable) return { is: "latest" };
  if (!wanted(result.updateInfo.version)) return { is: "skipped" };
  let download: Promise<unknown>;
  try {
    download = updater.downloadUpdate(result.cancellationToken);
  } catch (error) {
    log(`Update download failed: ${told(error)}`);
    return { is: "failed", error: told(error) };
  }
  return download.then(() => ({ is: "downloaded" as const }), (error: unknown) => ({ is: "failed" as const, error: told(error) }));
}

/** Where the app's own check stands, as main keeps it between checks */
export type AppCheck = { is: "idle" } | { is: "checking" } | { is: "latest" } | { is: "downloading"; version: string; percent: number | null } | { is: "failed"; error: string };

/**
 * What Settings → About shows of the app's own update (preload `ovisUpdate.state`): the running
 * version and one phase. A check or a download under way comes first; then an update the app holds
 * (a Mac's still staging in Squirrel counts as downloading); then how the last check ended.
 */
export interface AppUpdateState {
  version: string;
  phase: "off" | "idle" | "checking" | "latest" | "downloading" | "ready" | "failed";
  update: string | null;
  percent: number | null;
  error: string | null;
}

export function appUpdateState(version: string, enabled: boolean, check: AppCheck, offer: UpdateOffer): AppUpdateState {
  const state = { version, update: null, percent: null, error: null };
  if (!enabled) return { ...state, phase: "off" };
  if (check.is === "checking") return { ...state, phase: "checking" };
  if (check.is === "downloading") return { ...state, phase: "downloading", update: check.version, percent: check.percent };
  if (offer.staging) return { ...state, phase: "downloading", update: offer.staging.version };
  if (offer.ready) return { ...state, phase: "ready", update: offer.ready.version };
  if (check.is === "failed") return { ...state, phase: "failed", error: check.error };
  return { ...state, phase: check.is };
}

export interface UpdateNotices {
  notified: string | null;
  closed: string | null;
}

export function readUpdateNotices(path: string): UpdateNotices {
  const saved = ((): Partial<Record<keyof UpdateNotices, unknown>> | null => {
    try { return JSON.parse(readFileSync(path, "utf8")) as Partial<Record<keyof UpdateNotices, unknown>> | null; } catch { return null; }
  })();
  const version = (value: unknown) => typeof value === "string" && value !== "" ? value : null;
  return { notified: version(saved?.notified), closed: version(saved?.closed) };
}

export function writeUpdateNotices(path: string, notices: UpdateNotices): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, JSON.stringify(notices));
  renameSync(temporary, path);
}

export function updateNotice(version: string, said: UpdateNotices): { notify: boolean; line: boolean } {
  return { notify: said.notified !== version, line: said.closed !== version };
}
