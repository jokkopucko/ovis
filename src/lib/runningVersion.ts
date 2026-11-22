import type { HerdrUpdateStatus, UpdateStatus } from "../../shared/update.ts";

export function versionLabel(version: string | null | undefined, revision: string | null | undefined): string | null {
  const commit = revision?.slice(0, 12);
  if (version) return commit ? `v${version} (${commit})` : `v${version}`;
  return commit ?? null;
}

export function runningAppVersion(status: Pick<UpdateStatus, "current_version" | "current_revision"> | null, built: string): string {
  return versionLabel(status?.current_version || built, status?.current_revision) ?? `v${built}`;
}

export function staleClientVersion(status: Pick<UpdateStatus, "current_version"> | null, built: string): string | null {
  return status?.current_version && status.current_version !== built ? `v${built}` : null;
}

/**
 * The herdr version Settings prints: the running server's, else the installed binary's, else
 * the one the health check reported, which is all there is where herdr cannot be updated from
 * here (Windows, an older server, the demo).
 */
export function runningHerdrVersion(status: Pick<HerdrUpdateStatus, "server_version" | "binary_version"> | null, reported: string | null): string | null {
  return status?.server_version || status?.binary_version || reported || null;
}
