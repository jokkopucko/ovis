/**
 * The test-session rules: whether this process asked for an isolated herdr (HERDR_TEST_SESSION),
 * and one spelling of a socket path to compare against the user's own. Both the herdr client and
 * the herdr-core connection use them, so neither has to import the other.
 */

import { realpathSync } from "node:fs";
import { basename, dirname, join, resolve, win32 } from "node:path";

/**
 * Whether this process asked for an isolated herdr (HERDR_TEST_SESSION) and did not say the user's own
 * session is meant (OVIS_ALLOW_LIVE_HERDR=1, or the tests' HERDR_TEST_LIVE=1): its herdr and herdr-core
 * connections then never reach the user's own sessions.
 */
export function liveSessionsRefused(env: Record<string, string | undefined> = process.env): boolean {
  return Boolean(env["HERDR_TEST_SESSION"]) && env["OVIS_ALLOW_LIVE_HERDR"] !== "1" && env["HERDR_TEST_LIVE"] !== "1";
}

/** One spelling of a socket: absolute, through the links of its folder, and on Windows the pipe's name in one case. */
export function sameSocket(path: string): string {
  // Windows resolves `..` and `.` in a \\.\ device path, a pipe's too: one name, in one case
  if (process.platform === "win32") return win32.normalize(path.replace(/^\\\\\.\\pipe\\/i, "")).toLowerCase();
  const absolute = resolve(path);
  try { return join(realpathSync(dirname(absolute)), basename(absolute)); } catch { return absolute; }
}
