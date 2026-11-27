import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import { join, posix } from "node:path";

type Env = Record<string, string | undefined>;

const MARKER = "staging.json";
const CORE_SOCKET_LIMIT = 100;
const CORE_SOCKET_OVERHEAD = 64;
const STAGING_ENV = {
  HC_SESSION: "ost",
  OVIS_ACCOUNT_SERVICE_URL: "https://account-staging.devswha.workers.dev",
  OVIS_RELAY_URL: "wss://ovis-relay-staging.devswha.workers.dev",
  OVIS_RELAY_STAGING: "1",
  OVIS_RELAY_APP_URL: "https://relay-0510.ovis-app.pages.dev",
};

/**
 * The feed a build's updater reads (electron-builder writes it into app-update.yml). A preview build, the staging one,
 * reads OVIS_PREVIEW_FEED alone, so it updates to the next preview and never to a release; every other build reads
 * OVIS_UPDATE_FEED alone, so no release ever reads the preview feed. None when the one it reads is unset.
 */
export function updateFeed(env: Env, staging: boolean): string | null {
  return (staging ? env["OVIS_PREVIEW_FEED"] : env["OVIS_UPDATE_FEED"])?.trim() || null;
}

export function writeStagingMarker(resources: string, enabled: boolean): void {
  const path = join(resources, MARKER);
  if (enabled) writeFileSync(path, JSON.stringify(STAGING_ENV));
  else rmSync(path, { force: true });
}

export function readStagingProfile({ resources, env, user }: {
  resources: string;
  env: Env;
  user?: { homedir: string; uid: number };
}): { env: Env; userData: string } | null {
  const path = join(resources, MARKER);
  let text: string;
  try { text = readFileSync(path, "utf8"); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }

  const marker: unknown = JSON.parse(text);
  if (typeof marker !== "object" || marker === null) throw new Error(`Invalid staging marker: ${path}`);
  const settings = marker as Record<string, unknown>;
  const resolved = { ...env };
  for (const key of Object.keys(STAGING_ENV)) {
    const value = settings[key];
    if (typeof value !== "string" || !value) throw new Error(`Invalid staging marker: ${path} (${key})`);
    resolved[key] ??= value;
  }

  const { homedir, uid } = user ?? userInfo();
  // The profile only ever opens on a Mac, so its paths are POSIX ones on whatever host builds or tests this.
  const preferred = posix.join(homedir, ".ost");
  const session = resolved["HC_SESSION"]?.trim() || "ovis";
  const socketLength = Buffer.byteLength(preferred) + Buffer.byteLength(session) + CORE_SOCKET_OVERHEAD;
  const stagingHome = socketLength > CORE_SOCKET_LIMIT ? `/tmp/ost-${uid}` : preferred;
  if (env["HOME"] === undefined || env["HOME"] === homedir) resolved["HOME"] = stagingHome;
  resolved["CFFIXED_USER_HOME"] ??= stagingHome;
  // its own Ovis lives in that home, so the one it finds on a PC over SSH is a released one: the server leaves it alone
  resolved["OVIS_PREVIEW_PROFILE"] ??= "1";
  return { env: resolved, userData: posix.join(stagingHome, "app") };
}
