import { expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ServerMessage, STREAM_COOKIE_PREFIX } from "../shared/protocol.ts";
import { DEVICE_COOKIE } from "./auth.ts";
import { createServer } from "./index.ts";
import { authenticatedWebSocket } from "./remote-websocket.ts";
import { withHeaders } from "./websocket.test-helpers.ts";
import type { Machine } from "../shared/machines.ts";
import type { SessionSnapshot } from "../shared/protocol.ts";
import { expandMachine, expandMachineEvent, type WireMachine, type WireMachineEvent } from "../shared/compact-agents.ts";

async function connection(base: string, open?: (url: string) => WebSocket) {
  const frames: ServerMessage[] = [];
  const socket = (open ?? ((url) => authenticatedWebSocket(url, "test-token")))(base.replace("http:", "ws:") + "/ws");
  const waiting = new Set<() => void>();
  socket.onmessage = (event) => { frames.push(JSON.parse(String(event.data)) as ServerMessage); for (const check of waiting) check(); };
  const wait = (matches: (frame: ServerMessage) => boolean) => new Promise<ServerMessage>((resolve, reject) => {
    const timer = setTimeout(() => { waiting.delete(check); reject(new Error("machine event did not arrive")); }, 5_000);
    const check = () => { const frame = frames.find(matches); if (frame) { clearTimeout(timer); waiting.delete(check); resolve(frame); } };
    waiting.add(check); check();
  });
  const features = await wait((frame) => frame.type === "features");
  let pings = 0;
  const fence = async () => { const id = ++pings; socket.send(JSON.stringify({ type: "ping", id })); await wait((frame) => frame.type === "pong" && frame.id === id); };
  return { socket, frames, wait, features, fence };
}

const pairings = (frames: ServerMessage[]) => frames.filter((frame) => frame.type === "machine-event" && frame.event.type === "device-paired");

it("negotiates compact agents over HTTP, SSE and WS without changing legacy responses or restored rows", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "ovis-compact-agents-"));
  const server = createServer({ port: 0, hostname: "127.0.0.1", stateDir, token: "test-token", tailscaleOwner: null });
  const base = `http://127.0.0.1:${server.port}`;
  const pane = { pane_id: "w1:p1", terminal_id: "terminal", workspace_id: "w1", tab_id: "w1:t1", focused: true, revision: 1, agent_status: "working" as const, cwd: "/fixture/project" };
  const snapshot: SessionSnapshot = { version: "test", protocol: 22, workspaces: [], tabs: [], layouts: [], panes: [pane], agents: [{ ...pane, state_change_seq: 11 }] };
  const machines: Machine[] = [{ id: "local", name: "PC", kind: "local", enabled: true, state: "connected", error: null, snapshot }];
  const headers = { authorization: "Bearer test-token" };
  let client: Awaited<ReturnType<typeof connection>> | undefined;
  const abort = new AbortController();
  try {
    server.context.services.core.machines!.list = () => machines;
    const legacy = (await (await fetch(base + "/api/machines", { headers })).json()).machines as Machine[];
    expect(legacy[0]!.snapshot!.agents).toHaveLength(1);
    expect("agent_refs" in legacy[0]!.snapshot!).toBe(false);
    const compact = (await (await fetch(base + "/api/machines?compact_agents=1", { headers })).json()).machines as WireMachine[];
    expect("agent_refs" in compact[0]!.snapshot!).toBe(true);
    expect(compact.map(expandMachine)).toEqual(legacy);
    const response = await fetch(base + "/api/machines/events?compact_agents=1", { headers, signal: abort.signal });
    const reader = response.body!.getReader();
    const decoder = new TextDecoder(); let body = "";
    let sse: WireMachineEvent | undefined;
    while (!sse) {
      const chunk = await reader.read();
      if (chunk.done) throw new Error("stream ended before roster");
      body += decoder.decode(chunk.value, { stream: true });
      let end: number;
      while ((end = body.indexOf("\n\n")) !== -1) {
        const line = body.slice(0, end); body = body.slice(end + 2);
        if (!line.startsWith("data: ")) continue;
        const event = JSON.parse(line.slice(6)) as WireMachineEvent;
        if (event.type === "machines") { sse = event; break; }
      }
    }
    expect(sse.type === "machines" && "agent_refs" in sse.machines[0]!.snapshot!).toBe(true);
    expect(expandMachineEvent(sse)).toEqual({ type: "machines", machines: legacy });
    abort.abort();
    client = await connection(base);
    client.socket.send(JSON.stringify({ type: "machine-events", enabled: true, compact_agents: true }));
    const frame = await client.wait((frame) => frame.type === "machine-event" && frame.event.type === "machines");
    if (frame.type !== "machine-event") throw new Error("expected roster");
    const event = frame.event as WireMachineEvent;
    expect(event.type === "machines" && "agent_refs" in event.machines[0]!.snapshot!).toBe(true);
    expect(expandMachineEvent(event)).toEqual({ type: "machines", machines: legacy });
    client.socket.send(JSON.stringify({ type: "machine-events", enabled: false })); await client.fence();
    const before = client.frames.length;
    client.socket.send(JSON.stringify({ type: "machine-events", enabled: true })); await client.fence();
    const full = client.frames.slice(before).find((frame) => frame.type === "machine-event" && frame.event.type === "machines");
    expect(full?.type === "machine-event" && full.event).toEqual({ type: "machines", machines: legacy });
  } finally { abort.abort(); client?.socket.close(); server.stop(); rmSync(stateDir, { recursive: true, force: true }); }
});

it("multiplexes initial documents and live updates onto the existing authenticated socket", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "ovis-machine-events-"));
  const server = createServer({ port: 0, hostname: "127.0.0.1", stateDir, token: "test-token", tailscaleOwner: null });
  const base = `http://127.0.0.1:${server.port}`;
  const client = await connection(base);
  try {
    expect(client.features.type === "features" && client.features.features).toContain("machine-events");
    expect(client.frames.some((frame) => frame.type === "machine-event")).toBe(false);
    client.socket.send(JSON.stringify({ type: "machine-events", enabled: true }));
    await client.wait((frame) => frame.type === "machine-event" && frame.event.type === "preferences");
    await client.wait((frame) => frame.type === "machine-event" && frame.event.type === "machines");
    client.socket.send(JSON.stringify({ type: "machine-events", enabled: true }));
    const change = await fetch(base + "/api/preferences", {
      method: "PUT", headers: { authorization: "Bearer test-token", origin: base, "content-type": "application/json" },
      body: JSON.stringify({ settings: { language: "ko" } }),
    });
    expect(change.status).toBe(200);
    const revision = (await change.json()).revision;
    await client.wait((frame) => frame.type === "machine-event" && frame.event.type === "preferences" && frame.event.preferences.revision === revision);
    expect(client.frames.filter((frame) => frame.type === "machine-event" && frame.event.type === "preferences" && frame.event.preferences.revision === revision)).toHaveLength(1);
    client.socket.send(JSON.stringify({ type: "machine-events", enabled: false }));
    client.socket.send(JSON.stringify({ type: "ping", id: 23 }));
    await client.wait((frame) => frame.type === "pong" && frame.id === 23);
    const before = client.frames.filter((frame) => frame.type === "machine-event").length;
    await fetch(base + "/api/preferences", { method: "PUT", headers: { authorization: "Bearer test-token", origin: base, "content-type": "application/json" }, body: JSON.stringify({ settings: { language: "en" } }) });
    client.socket.send(JSON.stringify({ type: "ping", id: 24 }));
    await client.wait((frame) => frame.type === "pong" && frame.id === 24);
    expect(client.frames.filter((frame) => frame.type === "machine-event")).toHaveLength(before);
    client.socket.send(JSON.stringify({ type: "machine-events", enabled: "yes" }));
    await client.wait((frame) => frame.type === "error" && frame.code === "invalid_subscription");
  } finally { client.socket.close(); server.stop(); rmSync(stateDir, { recursive: true, force: true }); }
});

it("keeps SSE available when the server's transport rollback switch disables the capability", async () => {
  const before = process.env["OVIS_MACHINE_EVENTS_WS"];
  const stateDir = mkdtempSync(join(tmpdir(), "ovis-machine-events-rollback-"));
  process.env["OVIS_MACHINE_EVENTS_WS"] = "0";
  const server = createServer({ port: 0, hostname: "127.0.0.1", stateDir, token: "test-token", tailscaleOwner: null });
  const base = `http://127.0.0.1:${server.port}`;
  let client: Awaited<ReturnType<typeof connection>> | undefined;
  try {
    client = await connection(base);
    expect(client.features.type === "features" && client.features.features).not.toContain("machine-events");
    const abort = new AbortController();
    try {
      const response = await fetch(base + "/api/machines/events", { headers: { authorization: "Bearer test-token" }, signal: abort.signal });
      expect(response.status).toBe(200);
      expect(new TextDecoder().decode((await response.body!.getReader().read()).value)).toContain('"type":"machines"');
    } finally { abort.abort(); }
  } finally {
    client?.socket.close(); server.stop(); rmSync(stateDir, { recursive: true, force: true });
    if (before === undefined) delete process.env["OVIS_MACHINE_EVENTS_WS"]; else process.env["OVIS_MACHINE_EVENTS_WS"] = before;
  }
});

it("keeps watch-device authority and closes its machine document when the device is revoked", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "ovis-machine-events-watch-"));
  const server = createServer({ port: 0, hostname: "127.0.0.1", stateDir, token: "test-token", tailscaleOwner: null });
  const base = `http://127.0.0.1:${server.port}`;
  const devices = server.context.services.devices;
  const paired = devices.pair(devices.startPairing().code, "Observer", "watch")!;
  const RuntimeSocket = WebSocket as unknown as new (url: string, options: { headers: { cookie: string } }) => WebSocket;
  const client = await connection(base, (url) => new RuntimeSocket(url, { headers: { cookie: `${DEVICE_COOKIE}=${paired.token}` } }));
  try {
    client.socket.send(JSON.stringify({ type: "machine-events", enabled: true }));
    await client.wait((frame) => frame.type === "machine-event" && frame.event.type === "preferences");
    // Receiving the roster does not grant an observing device permission to type.
    client.socket.send(JSON.stringify({ type: "input", pane_id: "not-a-terminal", data: "never typed" }));
    await client.wait((frame) => frame.type === "error" && frame.code === "read_only");
    const closed = new Promise<number>((resolve) => { client.socket.onclose = (event) => resolve(event.code); });
    expect(devices.revoke(paired.device.id)).toBe(true);
    expect(await closed).toBe(1008);
  } finally { client.socket.close(); server.stop(); rmSync(stateDir, { recursive: true, force: true }); }
});

it("gives another server's bridge no machine document, even when it asks for one", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "ovis-machine-events-bridge-"));
  const server = createServer({ port: 0, hostname: "127.0.0.1", stateDir, token: "test-token", bridgeToken: "test-bridge", tailscaleOwner: null });
  const base = `http://127.0.0.1:${server.port}`;
  let client: Awaited<ReturnType<typeof connection>> | undefined;
  try {
    client = await connection(base, (url) => authenticatedWebSocket(url, "test-bridge"));
    expect(client.features.type === "features" && client.features.features).not.toContain("machine-events");
    client.socket.send(JSON.stringify({ type: "machine-events", enabled: true }));
    await client.fence();
    expect(client.frames.filter((frame) => frame.type === "machine-event")).toEqual([]);
  } finally { client?.socket.close(); server.stop(); rmSync(stateDir, { recursive: true, force: true }); }
});

it("tells a pairing to every machine-event socket but the asking browser's and one that came in through the open LAN, as SSE does", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "ovis-machine-events-pairing-"));
  const server = createServer({ port: 0, hostname: "127.0.0.1", stateDir, token: "", tailscaleOwner: null });
  const base = `http://127.0.0.1:${server.port}`;
  const guard = { "x-herdr-machine": "1", "content-type": "application/json" };
  const askingBrowser = `${STREAM_COOKIE_PREFIX}${"a".repeat(32)}=1`;
  const clients: Awaited<ReturnType<typeof connection>>[] = [];
  try {
    const local = await connection(base, withHeaders({})); clients.push(local);
    const asking = await connection(base, withHeaders({ cookie: askingBrowser })); clients.push(asking);
    const lan = await connection(base, withHeaders({ "x-forwarded-for": "192.168.0.20" })); clients.push(lan);
    for (const client of clients) {
      client.socket.send(JSON.stringify({ type: "machine-events", enabled: true }));
      await client.wait((frame) => frame.type === "machine-event" && frame.event.type === "preferences");
    }
    const { code } = await (await fetch(`${base}/api/devices/pair/start`, { method: "POST", headers: guard })).json() as { code: string };
    const told = local.wait((frame) => frame.type === "machine-event" && frame.event.type === "device-paired");
    const paired = await fetch(`${base}/api/devices/pair`, { method: "POST", headers: { ...guard, "x-forwarded-for": "192.168.0.30", cookie: askingBrowser }, body: JSON.stringify({ code, label: "Phone" }) });
    expect(paired.status).toBe(204);
    // the first device on an open install is enrolled, and told, once it signs in
    const device = paired.headers.get("set-cookie")!.split(";")[0]!;
    expect((await fetch(`${base}/api/session`, { headers: { "x-forwarded-for": "192.168.0.30", cookie: device } })).status).toBe(200);
    expect(await told).toMatchObject({ event: { type: "device-paired", label: "Phone" } });
    await asking.fence();
    expect(pairings(asking.frames)).toEqual([]);
    if (lan.socket.readyState === WebSocket.OPEN) await lan.fence().catch(() => {});
    expect(pairings(lan.frames)).toEqual([]);
  } finally { for (const client of clients) client.socket.close(); server.stop(); rmSync(stateDir, { recursive: true, force: true }); }
});

it("tells relay pairings waiting for approval to a driving machine-event socket, as SSE does", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "ovis-machine-events-relay-pairings-"));
  const server = createServer({ port: 0, hostname: "127.0.0.1", stateDir, token: "test-token", tailscaleOwner: null });
  const client = await connection(`http://127.0.0.1:${server.port}`);
  const waiting = (count: number) => (frame: ServerMessage) => frame.type === "machine-event" && frame.event.type === "relay-pairings" && frame.event.pairings.length === count;
  try {
    client.socket.send(JSON.stringify({ type: "machine-events", enabled: true }));
    await client.wait(waiting(0));
    const asked = server.context.services.relay.approvals.ask("New phone", "123456", Date.now() + 90_000);
    const shown = await client.wait(waiting(1));
    expect(shown.type === "machine-event" && shown.event.type === "relay-pairings" && shown.event.pairings[0]?.digits).toBe("123456");
    const frames = client.frames.length;
    asked?.withdraw();
    await client.wait((frame) => client.frames.indexOf(frame) >= frames && waiting(0)(frame));
  } finally {
    client.socket.close();
    server.stop();
    rmSync(stateDir, { recursive: true, force: true });
  }
});

it("tells a watch device's machine-event socket that no relay pairing waits for it, so a window that lost drive drops its prompts", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "ovis-machine-events-relay-watch-"));
  const server = createServer({ port: 0, hostname: "127.0.0.1", stateDir, token: "test-token", tailscaleOwner: null });
  const devices = server.context.services.devices;
  const paired = devices.pair(devices.startPairing().code, "Observer", "watch")!;
  const asked = server.context.services.relay.approvals.ask("New phone", "123456", Date.now() + 90_000);
  const client = await connection(`http://127.0.0.1:${server.port}`, withHeaders({ cookie: `${DEVICE_COOKIE}=${paired.token}` }));
  try {
    client.socket.send(JSON.stringify({ type: "machine-events", enabled: true }));
    const told = await client.wait((frame) => frame.type === "machine-event" && frame.event.type === "relay-pairings");
    expect(told.type === "machine-event" && told.event.type === "relay-pairings" && told.event.pairings).toEqual([]);
  } finally {
    asked?.withdraw();
    client.socket.close();
    server.stop();
    rmSync(stateDir, { recursive: true, force: true });
  }
});
