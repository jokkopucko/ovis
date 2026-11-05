import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerMessage } from "../shared/protocol.ts";
import { MachineRelay } from "./machine-relay.ts";
import type { MachineManager } from "./machines.ts";
import { createServer, type ServerInstance } from "./index.ts";

/** A socket whose frames are awaited as events, each wait bounded by a deadline. */
class FrameSocket {
  readonly seen: ServerMessage[] = [];
  private readonly waiters = new Set<() => void>();
  readonly opened: Promise<void>;

  constructor(readonly ws: WebSocket) {
    ws.addEventListener("message", (event) => {
      this.seen.push(JSON.parse(String(event.data)) as ServerMessage);
      for (const waiter of this.waiters) waiter();
    });
    this.opened = new Promise((resolve, reject) => {
      ws.addEventListener("open", () => resolve(), { once: true });
      ws.addEventListener("error", () => reject(new Error("WebSocket failed")), { once: true });
    });
  }

  next(predicate: (message: ServerMessage) => boolean, label: string, from = 0): Promise<ServerMessage> {
    return new Promise((resolve, reject) => {
      const check = () => {
        const found = this.seen.slice(from).find(predicate);
        if (!found) return;
        this.waiters.delete(check); clearTimeout(timer); resolve(found);
      };
      const timer = setTimeout(() => { this.waiters.delete(check); reject(new Error(`${label} not received within 10s`)); }, 10_000);
      this.waiters.add(check);
      check();
    });
  }

  send(message: unknown): void { this.ws.send(JSON.stringify(message)); }
}

describe("WebSocket liveness ping", () => {
  const stateDir = mkdtempSync(join(tmpdir(), "ovis-ping-"));
  const sockets: WebSocket[] = [];
  const relays: MachineRelay[] = [];
  let bridge: ServerInstance | undefined;
  let proxy: ReturnType<typeof Bun.serve<{ relay: MachineRelay }>> | undefined;

  async function connect(url: string): Promise<FrameSocket> {
    const socket = new FrameSocket(new WebSocket(url));
    sockets.push(socket.ws);
    await socket.opened;
    await socket.next((message) => message.type === "snapshot", "snapshot");
    return socket;
  }

  beforeAll(() => {
    bridge = createServer({ port: 0, hostname: "127.0.0.1", stateDir, token: "test-ping", machines: false, tailscaleOwner: null });
    // a remote PC's socket, as /ws?machine_id= relays it, with this bridge as the remote
    const manager = { endpoint: () => ({ url: `http://127.0.0.1:${bridge!.port}`, token: "test-ping" }), trackTerminal: () => () => {} } as unknown as MachineManager;
    proxy = Bun.serve<{ relay: MachineRelay }>({ port: 0, hostname: "127.0.0.1", async fetch(request, instance) {
      const relay = new MachineRelay(manager, "remote", false, (snapshot) => snapshot); relays.push(relay);
      await relay.ready;
      if (instance.upgrade(request, { data: { relay } })) return;
      relay.close(); return new Response(null, { status: 426 });
    }, websocket: { open(ws) { ws.data.relay.bind(ws); }, message(ws, raw) { ws.data.relay.message(raw); }, close(ws) { ws.data.relay.close(); } } });
  });

  afterAll(() => {
    for (const socket of sockets) socket.close();
    for (const relay of relays) relay.close();
    proxy?.stop(true);
    bridge?.stop();
    rmSync(stateDir, { recursive: true, force: true });
  });

  it("lists ping in the snapshot and answers each ping with a pong of its id, for any role", async () => {
    const RuntimeSocket = WebSocket as unknown as new (url: string, options: { headers: Record<string, string> }) => WebSocket;
    const socket = new FrameSocket(new RuntimeSocket(`ws://127.0.0.1:${bridge!.port}/ws`, { headers: { authorization: "Bearer test-ping" } }));
    sockets.push(socket.ws);
    await socket.opened;
    const snapshot = await socket.next((message) => message.type === "snapshot", "snapshot");
    expect(snapshot.type === "snapshot" && snapshot.features).toContain("ping");
    socket.send({ type: "ping", id: 7 });
    expect(await socket.next((message) => message.type === "pong", "pong")).toEqual({ type: "pong", id: 7 });
    socket.send({ type: "role", mode: "observe" });
    await socket.next((message) => message.type === "role-ack" && message.mode === "observe", "observe role");
    const from = socket.seen.length;
    socket.send({ type: "ping", id: 8 });
    expect(await socket.next((message) => message.type === "pong", "observer pong", from)).toEqual({ type: "pong", id: 8 });
    // a malformed id is answered in-band, never with a pong
    const before = socket.seen.length;
    socket.send({ type: "ping", id: "x" });
    expect(await socket.next((message) => message.type === "error", "invalid ping", before)).toMatchObject({ code: "invalid_ping" });
    expect(socket.seen.slice(before).some((message) => message.type === "pong")).toBe(false);
  }, 20_000);

  // #511: a remote PC's own bridge enforces agent_only, so the relay must hand it the flag as sent: an invalid one
  // (only true is allowed) comes back refused by the remote, which a relay that dropped or rewrote it would not cause
  it("relays a submit's agent_only to a remote PC unchanged, and its agent-only feature back", async () => {
    const socket = await connect(`ws://127.0.0.1:${proxy!.port}/ws`);
    const snapshot = socket.seen.find((message) => message.type === "snapshot");
    expect(snapshot?.type === "snapshot" && snapshot.features).toContain("agent-only");
    socket.send({ type: "submit", id: 77, pane_id: "w9:p9", text: "x", payload: "x", agent_only: false } as never);
    expect(await socket.next((message) => message.type === "submit-result" && message.id === 77, "relayed submit result"))
      .toMatchObject({ ok: false, code: "invalid_delivery" });
  }, 20_000);

  it("relays a ping to a remote PC and its pong back unchanged", async () => {
    const socket = await connect(`ws://127.0.0.1:${proxy!.port}/ws`);
    const snapshot = socket.seen.find((message) => message.type === "snapshot");
    expect(snapshot?.type === "snapshot" && snapshot.features).toContain("ping");
    socket.send({ type: "ping", id: 42 });
    expect(await socket.next((message) => message.type === "pong", "relayed pong")).toEqual({ type: "pong", id: 42 });
  }, 20_000);
});
