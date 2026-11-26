import { readFileSync } from "node:fs";
import { processStart } from "./desktop-process.ts";

export interface Saved {
  readonly port: number | null;
  /**
   * the server it ran last, so a run after a crash can end one left behind; `started` is its start time (`ps -o lstart=`).
   * `bun` is the program it ran: the server's binary, or the bundled Bun of an app from before the binary.
   */
  readonly server: { readonly pid: number; readonly bun: string; readonly started: string | null; readonly ready?: boolean } | null;
}

export function readSaved(path: string): Saved {
  try {
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (typeof value !== "object" || value === null) return { port: null, server: null };
    const port = "port" in value && typeof value.port === "number" ? value.port : null;
    const entry = "server" in value ? value.server : null;
    const server = typeof entry === "object" && entry !== null
      && "pid" in entry && typeof entry.pid === "number" && "bun" in entry && typeof entry.bun === "string"
      ? {
        pid: entry.pid, bun: entry.bun,
        started: "started" in entry && typeof entry.started === "string" ? entry.started : null,
        ...("ready" in entry && typeof entry.ready === "boolean" ? { ready: entry.ready } : {}),
      }
      : null;
    return { port, server };
  } catch {
    return { port: null, server: null };
  }
}

export const desktopListenerPath = (record: string): string => `${record}.listening`;

/** The desktop CLI needs the listener to still be open, not just its shutting-down process. */
export function desktopListenerMatches(record: string, pid: number): boolean {
  try { return readFileSync(desktopListenerPath(record), "utf8") === String(pid); } catch { return false; }
}

/** A saved port isn't enough: the CLI can only use the live process that owns the desktop listener record. */
export async function desktopCommandListener(path: string): Promise<{ readonly port: number; readonly identity: string } | null> {
  const { port, server } = readSaved(path);
  if (port === null || !Number.isInteger(port) || port < 1 || port > 65535
    || server?.ready !== true || !Number.isSafeInteger(server.pid) || server.pid <= 0 || server.started === null) return null;
  if (await processStart(server.pid) !== server.started || !desktopListenerMatches(path, server.pid)) return null;
  return { port, identity: JSON.stringify([server.pid, server.started]) };
}
