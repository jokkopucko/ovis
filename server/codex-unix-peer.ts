import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";

const exec = promisify(execFile);

/** The kernel's one established stream from the TUI to this listener, or no proof. */
export async function codexUnixPeer({ path, server, tui }: {
  readonly path: string;
  readonly server: ReadonlySet<string>;
  readonly tui: ReadonlySet<string>;
}): Promise<string | null> {
  try {
    const [sockets, peers] = await Promise.all([
      readFile("/proc/net/unix", "utf8"),
      exec("ss", ["-xHn", "state", "established"], { timeout: 1000, maxBuffer: 2 * 1024 * 1024 }),
    ]);
    const listeners: string[] = [];
    const accepted: string[] = [];
    for (const line of sockets.split("\n")) {
      const hit = /^\S+:\s+\S+\s+\S+\s+(\S+)\s+0001\s+(\S+)\s+(\d+)\s+(\/.*)$/.exec(line);
      if (hit === null) continue;
      const [, flags = "", state, inode = "", name] = hit;
      if (name !== path) continue;
      if ((Number.parseInt(flags, 16) & 0x10000) !== 0) listeners.push(inode);
      else if (state === "03" && server.has(inode)) accepted.push(inode);
    }
    const [listener] = listeners;
    const [connection] = accepted;
    if (listeners.length !== 1 || listener === undefined || !server.has(listener)) return null;
    if (accepted.length !== 1 || connection === undefined) return null;
    // `ss` gives the peer inode that /proc/net/unix lacks. Require an unnamed client endpoint
    // so its address column cannot be mistaken for an inode (Unix paths may contain spaces).
    for (const line of peers.stdout.split("\n")) {
      const pair = /^u_str\s+\d+\s+\d+\s+(.*)\s+(\d+)\s+\*\s+(\d+)\s*$/.exec(line);
      const client = pair?.[3];
      if (pair?.[1]?.trimEnd() === path && pair[2] === connection && client !== undefined && tui.has(client)) {
        return `${listener}:${connection}:${client}`;
      }
    }
    return null;
  } catch { return null; }
}
