/** Which port the plugin's server takes when the user has not set PORT. */
import { readFileSync } from "node:fs";

/** Tried in order after the default: far apart, so one reserved range cannot hold them all. */
export const FALLBACK_PORTS = [17317, 27317, 37317, 47317];

/** The port an earlier start settled on, so the app's address stays the same across restarts. */
export function savedPort(file: string): number | null {
  let text: string;
  try { text = readFileSync(file, "utf8"); } catch { return null; } // no start has chosen one
  const port = Number(text.trim());
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : null;
}

/**
 * Whether the server could listen here, opened the way the server opens it. A port inside a range
 * Windows reserves (Hyper-V, WSL2, Docker) fails although nothing listens on it.
 */
export async function canBind(hostname: string, port: number): Promise<boolean> {
  try {
    await Bun.serve({ hostname, port, fetch: () => new Response() }).stop(true);
    return true;
  } catch {
    return false;
  }
}

/** Whether the server could open every listener it starts here: with OVIS_IPV6_LOOPBACK=1, `::1` beside `127.0.0.1` too. */
export async function canServe(hostname: string, port: number, ipv6Loopback: boolean): Promise<boolean> {
  if (!await canBind(hostname, port)) return false;
  return !ipv6Loopback || hostname !== "127.0.0.1" || canBind("::1", port);
}

/** The first port that opens, other than the one that just failed: the default, then the fallbacks. */
export async function freePort(failed: number, defaultPort: number, opens: (port: number) => Promise<boolean>): Promise<number | null> {
  for (const port of [defaultPort, ...FALLBACK_PORTS]) {
    if (port !== failed && await opens(port)) return port;
  }
  return null;
}
