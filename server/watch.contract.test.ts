import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerMessage } from "../shared/protocol.ts";
import { herdrRpc, sessionSnapshot } from "./herdr/client.ts";
import { createServer, type ServerInstance } from "./index.ts";

async function until(predicate: () => boolean, label: string, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`${label} not observed within ${ms}ms`);
    // These are real CLI processes and WebSocket deliveries; fake timers cannot
    // advance their external lifecycle. Poll the named condition to a deadline.
    await Bun.sleep(25);
  }
}

/** Capture real wire frames, with bounded waits rather than assuming delivery timing. */
class RecordingSocket {
  readonly seen: ServerMessage[] = [];
  private readonly ws: WebSocket;

  constructor(url: string) {
    this.ws = new WebSocket(url);
    this.ws.addEventListener("message", (event) => {
      this.seen.push(JSON.parse(String(event.data)) as ServerMessage);
    });
  }

  async ready(): Promise<void> {
    await until(() => this.ws.readyState === WebSocket.OPEN, "WebSocket open");
    await this.waitFor((message) => message.type === "snapshot", "snapshot");
  }

  async waitFor(predicate: (message: ServerMessage) => boolean, label: string, from = 0): Promise<ServerMessage> {
    let found: ServerMessage | undefined;
    await until(() => {
      found = this.seen.slice(from).find(predicate);
      return found !== undefined;
    }, label);
    return found!;
  }

  send(message: unknown): void {
    this.ws.send(JSON.stringify(message));
  }

  async close(): Promise<void> {
    this.ws.close();
    await until(() => this.ws.readyState === WebSocket.CLOSED, "WebSocket close");
  }
}

function processCount(pattern: string): number {
  const found = Bun.spawnSync(["pgrep", "-f", pattern]);
  if (found.exitCode !== 0 && found.exitCode !== 1) {
    throw new Error(`pgrep failed (${found.exitCode}): ${found.stderr.toString()}`);
  }
  return found.stdout.toString().split("\n").filter(Boolean).length;
}

describe("WebSocket read-only live watch", () => {
  const stateDir = mkdtempSync(join(tmpdir(), "ovis-watch-"));
  const sockets = new Set<RecordingSocket>();
  let bridge: ServerInstance | undefined;
  let workspaceId: string | undefined;
  let paneId: string;
  let terminalId: string;

  const observeCount = () => processCount(`terminal session observe ${paneId}( |$)`);
  const attachCount = () => processCount(`terminal attach ${terminalId}( |$)`);

  async function connect(): Promise<RecordingSocket> {
    const socket = new RecordingSocket(`ws://127.0.0.1:${bridge!.port}/ws`);
    sockets.add(socket);
    await socket.ready();
    return socket;
  }

  async function close(socket: RecordingSocket): Promise<void> {
    await socket.close();
    sockets.delete(socket);
    await until(() => observeCount() === 0, "observer cleanup after WebSocket close");
  }

  beforeAll(async () => {
    bridge = createServer({ port: 0, hostname: "127.0.0.1", stateDir, token: "", machines: false, tailscaleOwner: null });
    const created = await herdrRpc<{ workspace: { workspace_id: string }; root_pane: { pane_id: string } }>(
      "workspace.create", { label: "ovis-test-watch", cwd: tmpdir(), focus: false },
    );
    workspaceId = created.workspace.workspace_id;
    paneId = created.root_pane.pane_id;
    const pane = (await sessionSnapshot()).panes.find((candidate) => candidate.pane_id === paneId);
    if (!pane?.terminal_id) throw new Error(`Test pane ${paneId} has no terminal`);
    terminalId = pane.terminal_id;
  });

  afterAll(async () => {
    try {
      await Promise.all([...sockets].map((socket) => socket.close()));
    } finally {
      bridge?.stop();
      if (workspaceId) await herdrRpc("workspace.close", { workspace_id: workspaceId }).catch(() => undefined);
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("advertises watch in the initial snapshot", async () => {
    const socket = await connect();
    try {
      const snapshot = await socket.waitFor((message) => message.type === "snapshot", "snapshot");
      if (snapshot.type !== "snapshot") throw new Error("Expected snapshot");
      expect(snapshot.features).toContain("watch");
    } finally { await close(socket); }
  }, 20_000);

  it("streams an unattached pane for an observe-role client without an attach process", async () => {
    const socket = await connect();
    try {
      socket.send({ type: "role", mode: "observe" });
      await socket.waitFor((message) => message.type === "role-ack" && message.mode === "observe", "observe role");
      socket.send({ type: "watch", pane_id: paneId, cols: 100, rows: 30 });
      await socket.waitFor((message) => message.type === "watch-data" && message.pane_id === paneId, "initial watch frame");
      await until(() => observeCount() === 1, "live observe process");
      expect(attachCount()).toBe(0);

      const nonce = crypto.randomUUID().replaceAll("-", "");
      const marker = `watch-${nonce}`;
      // The full marker occurs only in the command's output, not its typed echo.
      await herdrRpc("pane.send_text", { pane_id: paneId, text: `printf 'watch-%s\\n' '${nonce}'` });
      await herdrRpc("pane.send_keys", { pane_id: paneId, keys: ["Enter"] });
      const frame = await socket.waitFor(
        (message) => message.type === "watch-data" && message.pane_id === paneId && message.data.includes(marker),
        "live command output",
      );
      expect(frame.type).toBe("watch-data");
      expect(attachCount()).toBe(0);
      expect(socket.seen.some((message) => message.type === "pane-geometry" || message.type === "input-ready" || message.type === "pty-data")).toBe(false);
    } finally { await close(socket); }
  }, 30_000);

  it("unwatch stops the observe process without sending watch-end", async () => {
    const socket = await connect();
    try {
      socket.send({ type: "watch", pane_id: paneId, cols: 100, rows: 30 });
      await socket.waitFor((message) => message.type === "watch-data" && message.pane_id === paneId, "initial watch frame");
      await until(() => observeCount() === 1, "live observe process");
      socket.send({ type: "unwatch", pane_id: paneId });
      await until(() => observeCount() === 0, "observer gone after unwatch");
      // A subsequent answered frame proves this connection is still usable.
      socket.send({ type: "role", mode: "observe" });
      await socket.waitFor((message) => message.type === "role-ack", "role after unwatch");
      expect(socket.seen.some((message) => message.type === "watch-end" && message.pane_id === paneId)).toBe(false);
    } finally { await close(socket); }
  }, 25_000);

  it("draws a watched pane again at another grid with one observe process, and tells the page of no end", async () => {
    const socket = await connect();
    try {
      socket.send({ type: "watch", pane_id: paneId, cols: 100, rows: 30 });
      await socket.waitFor((message) => message.type === "watch-data" && message.pane_id === paneId, "initial watch frame");
      await until(() => observeCount() === 1, "live observe process");
      // the tab's window was resized: the view starts again once the first process has ended
      socket.send({ type: "watch", pane_id: paneId, cols: 90, rows: 28 });
      await until(() => processCount(`terminal session observe ${paneId} --cols 90 --rows 28`) === 1, "the observe process of the new grid", 5_000);
      await until(() => observeCount() === 1, "the first observe process gone");
      const nonce = crypto.randomUUID().replaceAll("-", "");
      const from = socket.seen.length;
      await herdrRpc("pane.send_text", { pane_id: paneId, text: `printf 'again-%s\\n' '${nonce}'` });
      await herdrRpc("pane.send_keys", { pane_id: paneId, keys: ["Enter"] });
      await socket.waitFor((message) => message.type === "watch-data" && message.pane_id === paneId && message.data.includes(`again-${nonce}`), "output in the new view", from);
      expect(socket.seen.some((message) => message.type === "watch-end" && message.pane_id === paneId)).toBe(false);
      expect(observeCount()).toBe(1);
    } finally { await close(socket); }
  }, 30_000);

  it("closing the WebSocket stops its observe process", async () => {
    const socket = await connect();
    try {
      socket.send({ type: "watch", pane_id: paneId, cols: 100, rows: 30 });
      await socket.waitFor((message) => message.type === "watch-data" && message.pane_id === paneId, "initial watch frame");
      await until(() => observeCount() === 1, "live observe process");
    } finally { await close(socket); }
    expect(observeCount()).toBe(0);
  }, 25_000);

  it("ends a watch for a pane that does not exist", async () => {
    const socket = await connect();
    try {
      const missing = `missing-watch-${crypto.randomUUID()}`;
      socket.send({ type: "watch", pane_id: missing, cols: 100, rows: 30 });
      const ended = await socket.waitFor((message) => message.type === "watch-end" && message.pane_id === missing, "missing pane watch-end");
      expect(ended).toEqual({ type: "watch-end", pane_id: missing });
    } finally { await close(socket); }
  }, 20_000);

  it("rejects invalid watch geometry in-band", async () => {
    const socket = await connect();
    try {
      for (const [cols, rows] of [[0, 30], [100, 1001], [1.5, 30], ["100", 30]]) {
        const from = socket.seen.length;
        socket.send({ type: "watch", pane_id: paneId, cols, rows });
        const error = await socket.waitFor((message) => message.type === "error", "invalid_geometry", from);
        expect(error).toEqual({ type: "error", code: "invalid_geometry", message: "cols and rows must be integers in 1..1000" });
      }
      expect(observeCount()).toBe(0);
    } finally { await close(socket); }
  }, 20_000);
});
