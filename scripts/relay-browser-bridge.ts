import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import type { WebSocketRoute } from "playwright-core";
import type { createServer } from "../server/index.ts";
import type { RelayService } from "../server/relay/service.ts";

/** The PC side of a relay browser run: this checkout's server, or another tree's (RELAY_E2E_SERVER_DIR). */
export interface RelayServerTree { dir: string; createServer: typeof createServer; RelayService: typeof RelayService }

/**
 * The server named by RELAY_E2E_SERVER_DIR, else this checkout's: both modules are imported from
 * that tree, so the PCs a run starts are that version's. The shell and the relay stay this checkout's.
 */
export async function relayServerTree(dir = process.env["RELAY_E2E_SERVER_DIR"] || join(import.meta.dir, "..")): Promise<RelayServerTree> {
  const tree = resolve(dir);
  if (!existsSync(join(tree, "server/relay/service.ts"))) throw new Error(`${tree} holds no server/relay/: not a relay-capable server tree`);
  const { createServer } = await import(join(tree, "server/index.ts")) as typeof import("../server/index.ts");
  const { RelayService } = await import(join(tree, "server/relay/service.ts")) as typeof import("../server/relay/service.ts");
  return { dir: tree, createServer, RelayService };
}

/**
 * The shell's wss: origin carried to a test relay, shared by the shell, media and end-to-end browser
 * runs. `frame` hears each frame the relay sends the page, `sent` each frame the page sends.
 */
export function relayBrowserSocket(ws: WebSocketRoute, address: () => string, frame: () => void = () => {}, release?: Promise<void>, sent: () => void = () => {}): void {
  const queue: (string | Buffer)[] = [];
  let upstream: WebSocket | null = null;
  let closed = false;
  ws.onMessage((message) => {
    sent();
    if (upstream?.readyState === WebSocket.OPEN) upstream.send(message); else queue.push(message);
  });
  ws.onClose(() => { closed = true; upstream?.close(); });
  const start = (): void => {
    if (closed) return;
    const socket = new WebSocket(address());
    socket.binaryType = "arraybuffer";
    upstream = socket;
    socket.onopen = () => { for (const message of queue.splice(0)) socket.send(message); };
    socket.onmessage = (event) => {
      frame();
      ws.send(typeof event.data === "string" ? event.data : Buffer.from(event.data as ArrayBuffer));
    };
    socket.onerror = () => { /* The close event carries the browser's network failure. */ };
    socket.onclose = (event) => {
      if (closed) return;
      const code = [1005, 1006, 1015].includes(event.code) ? 1011 : event.code;
      ws.close({ code, reason: event.reason || "relay connection lost" });
    };
  };
  if (release) void release.then(start); else start();
}
