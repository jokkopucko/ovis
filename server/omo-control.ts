/**
 * OmO's terminal-control socket: the one its extension registers for each TUI (senpi docs/rpc.md, "terminal
 * control"), under `<agentDir>/rpc/tui/`, mode 0600, with a 32-byte secret beside it (`<socket>.secret`). A
 * connection sends that secret's raw bytes, then JSON lines; each request is answered by a `response` line with its
 * `id`. Measured on OmO 5.1.81 (senpi 2026.11.19-5): `set_thinking_level` and `set_model` change the TUI's own
 * session and footer; compact, a new session, a permission preset and slash commands are not on it.
 *
 * A pane's socket is the one its own OmO process listens on, found through /proc (Linux only): never one guessed by
 * folder or by time.
 */
import { readdirSync, readFileSync, readlinkSync } from "node:fs";
import { connect } from "node:net";
import { basename, join } from "node:path";

/** How long a control request waits for its answer before it counts as unknown. */
const CONTROL_MS = 5_000;
const SECRET_BYTES = 32;

/**
 * The control socket process `pid` listens on, or null (not Linux, none). It is OmO's when it sits under
 * `<agentDir>/rpc/tui/`, or is any `t-<16 hex>.sock` the process holds (senpi's short-path fallback for a socket
 * address too long for its folder, docs/rpc.md).
 */
export function omoControlSocket(pid: number, agentDir: string, proc = "/proc"): string | null {
  if (process.platform !== "linux" && proc === "/proc") return null;
  const folder = join(agentDir, "rpc", "tui") + "/";
  const inodes = new Map<string, string>();
  try {
    for (const line of readFileSync(join(proc, "net", "unix"), "utf8").split("\n").slice(1)) {
      // seven fields, then the path, which may hold spaces
      const row = /^\s*\S+:\s+\S+\s+\S+\s+\S+\s+\S+\s+\S+\s+(\d+)\s+(\S.*)$/u.exec(line);
      if (!row) continue;
      const [, inode, path] = row as unknown as [string, string, string];
      if (path.endsWith(".sock") && (path.startsWith(folder) || /^t-[0-9a-f]{16}\.sock$/u.test(basename(path)))) inodes.set(inode, path);
    }
    if (inodes.size === 0) return null;
    for (const fd of readdirSync(join(proc, String(pid), "fd"))) {
      let target: string;
      try { target = readlinkSync(join(proc, String(pid), "fd", fd)); } catch { continue; }
      const inode = /^socket:\[(\d+)\]$/u.exec(target)?.[1];
      const path = inode === undefined ? undefined : inodes.get(inode);
      if (path !== undefined) return path;
    }
  } catch {}
  return null;
}

/**
 * Sends one request on `socket` and reads its answer: `unsent` when nothing reached OmO (no secret, no connection, or
 * `mayWrite`, asked once connected and right before the bytes go, said no), `unknown` when the request went and no
 * answer came within `timeoutMs` or the socket closed first.
 */
export function omoControlCall(socket: string, request: Record<string, unknown>, mayWrite: () => boolean = () => true, timeoutMs = CONTROL_MS): Promise<Record<string, unknown> | "unsent" | "unknown"> {
  let secret: Buffer;
  try { secret = readFileSync(`${socket}.secret`); } catch { return Promise.resolve("unsent"); }
  if (secret.length !== SECRET_BYTES) return Promise.resolve("unsent");
  const id = `ovis-${crypto.randomUUID()}`;
  return new Promise((resolve) => {
    let sent = false;
    let buffered = "";
    const done = (answer: Record<string, unknown> | "unsent" | "unknown") => {
      clearTimeout(timer);
      client.destroy();
      resolve(answer);
    };
    const timer = setTimeout(() => done(sent ? "unknown" : "unsent"), Math.max(0, timeoutMs));
    const client = connect(socket, () => {
      if (!mayWrite()) return done("unsent");
      sent = true;
      client.write(Buffer.concat([secret, Buffer.from(`${JSON.stringify({ ...request, id })}\n`)]));
    });
    client.setEncoding("utf8");
    client.on("data", (chunk: string) => {
      buffered += chunk;
      for (let end = buffered.indexOf("\n"); end >= 0; end = buffered.indexOf("\n")) {
        const line = buffered.slice(0, end);
        buffered = buffered.slice(end + 1);
        try {
          const message = JSON.parse(line) as Record<string, unknown>;
          if (message["type"] === "response" && message["id"] === id) return done(message);
        } catch {}
      }
    });
    client.on("error", () => done(sent ? "unknown" : "unsent"));
    client.on("close", () => done(sent ? "unknown" : "unsent"));
  });
}
