import { afterEach, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { startBunRelay } from "../relay/bun.ts";
import type { Machine, MachineEvent } from "../shared/machines.ts";
import type { SessionSnapshot } from "../shared/protocol.ts";
import { createServer } from "./index.ts";
import { RelayService } from "./relay/service.ts";
import { bounded, deferred } from "./relay/test-helpers.ts";

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

function stateDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "ovis-relay-pc-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** PC B with the relay on, PC A that adds it through the relay, and the local relay between them. */
async function twoPcs() {
  const relay = startBunRelay({ port: 0, limiters: {
    perAddress: { async limit() { return { success: true }; } },
    global: { async limit() { return { success: true }; } },
  } });
  cleanup.push(() => relay.stop());
  const synced = deferred<void>();
  /** while set, what B sends its phones (A, here) reaches the relay this much later */
  const delay = { ms: 0 };
  const local = (url: string): WebSocket => {
    const target = new URL(url);
    const socket = new WebSocket(`ws://127.0.0.1:${relay.port}${target.pathname}${target.search}`);
    if (target.searchParams.has("connection_id")) {
      const send = socket.send.bind(socket);
      socket.send = (data) => { if (delay.ms > 0) setTimeout(() => send(data), delay.ms); else send(data); };
    }
    if (target.searchParams.get("role") === "server" && !target.searchParams.has("connection_id")) {
      socket.addEventListener("message", (event) => {
        if (typeof event.data === "string" && JSON.parse(event.data).type === "sync") synced.resolve();
      });
    }
    return socket;
  };
  const bState = stateDir();
  const service = new RelayService({ stateDir: bState, relay: `wss://127.0.0.1:${relay.port}`, connect: local });
  const b = createServer({ port: 0, hostname: "127.0.0.1", stateDir: bState, token: "", tailscaleOwner: null, sidecar: false, registerBridge: false, relay: service });
  cleanup.push(async () => { await service.shutdown(); b.stop(); });
  const bBase = `http://127.0.0.1:${b.port}`;
  const started = await fetch(`${bBase}/api/relay/start`, { method: "POST", headers: { origin: bBase, "x-herdr-update": "1" } });
  expect(started.status).toBe(200);
  await bounded(synced.promise);
  const offered = await fetch(`${bBase}/api/relay/offer`, { method: "POST", headers: { origin: bBase, "x-herdr-update": "1" } });
  expect(offered.status).toBe(200);
  const { url: link } = await offered.json() as { url: string };
  const aState = stateDir();
  const startA = () => {
    const a = createServer({ port: 0, hostname: "127.0.0.1", stateDir: aState, token: "", tailscaleOwner: null, sidecar: false, registerBridge: false, relayPcSocket: local });
    let stopped = false;
    const stop = () => { if (!stopped) { stopped = true; a.stop(); } };
    cleanup.push(stop);
    return { app: a, base: `http://127.0.0.1:${a.port}`, stop };
  };
  return { b, link, aState, startA, delay };
}

function addRelayPc(base: string, link: string, name?: string): Promise<Response> {
  return fetch(`${base}/api/machines/relay`, {
    method: "POST", headers: { origin: base, "x-herdr-machine": "1", "content-type": "application/json" },
    body: JSON.stringify({ link, ...(name === undefined ? {} : { name }) }),
  });
}

/** The first roster on A's machine events stream (the browser's own feed) in which `wanted` holds for a PC. */
async function machineWhen(base: string, wanted: (machine: Machine) => boolean): Promise<Machine> {
  const abort = new AbortController();
  const response = await fetch(`${base}/api/machines/events`, { headers: { origin: base }, signal: abort.signal });
  const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  try {
    return await bounded((async () => {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) throw new Error("machine events ended");
        buffer += value;
        for (let end = buffer.indexOf("\n\n"); end >= 0; end = buffer.indexOf("\n\n")) {
          const frame = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          if (!frame.startsWith("data: ")) continue;
          const event = JSON.parse(frame.slice(6)) as MachineEvent;
          const found = event.type === "machines" ? event.machines.find(wanted) : undefined;
          if (found) return found;
        }
      }
    })(), 30_000);
  } finally { abort.abort(); }
}

it("adds a PC through the relay, shows its panes, signs in again after a restart and stops at a revocation", async () => {
  const { b, link, aState, startA } = await twoPcs();
  let a = startA();

  const added = await addRelayPc(a.base, link, "Lab");
  expect(added.status).toBe(201);
  const { machine } = await added.json() as { machine: Machine };
  expect(machine).toMatchObject({ kind: "relay", name: "Lab", relay: { server_id: new URL(link).pathname.split("/")[2] } });

  // a release from before relay PCs reads machines.json: a relay PC is kept apart, so a rollback still starts
  expect(readFileSync(join(aState, "machines.json"), "utf8")).not.toContain(machine.id);
  expect(readFileSync(join(aState, "relay-pcs.json"), "utf8")).toContain(machine.id);

  // B admitted A as one more paired device, by the same consent a phone needs
  const devices = b.context.services.devices;
  const paired = devices.list(null).find((device) => device.via_relay);
  expect(paired?.label).toBe(`Ovis on ${hostname()}`.slice(0, 64));

  // B's roster reaches A's sidebar feed over the relay, and A's API routes reach B through it
  const connected = await machineWhen(a.base, (pc) => pc.id === machine.id && pc.state === "connected" && pc.snapshot !== null);
  const direct = await (await fetch(`http://127.0.0.1:${b.port}/api/session`, { headers: { origin: `http://127.0.0.1:${b.port}` } })).json() as { snapshot: SessionSnapshot };
  expect(connected.snapshot!.workspaces.map((workspace) => workspace.workspace_id)).toEqual(direct.snapshot.workspaces.map((workspace) => workspace.workspace_id));
  const proxied = await fetch(`${a.base}/api/machines/${machine.id}/session`, { headers: { origin: a.base } });
  expect(proxied.status).toBe(200);
  expect((await proxied.json() as { snapshot: SessionSnapshot }).snapshot.panes.length).toBe(direct.snapshot.panes.length);

  // a terminal socket for that PC goes through the same tunnel
  const opened = deferred<string>();
  const RuntimeSocket = WebSocket as unknown as new (url: string, options: { headers: Record<string, string> }) => WebSocket;
  const terminal = new RuntimeSocket(`${a.base.replace("http:", "ws:")}/ws?machine_id=${machine.id}`, { headers: { origin: a.base } });
  terminal.onmessage = (event) => opened.resolve(String(event.data));
  terminal.onclose = (event) => opened.reject(new Error(`terminal socket closed ${event.code}`));
  expect(JSON.parse(await bounded(opened.promise)).type).toBeString();
  terminal.onclose = null;
  terminal.close();

  // a restart signs in with the saved key: the pairing code is spent, and none is sent again
  a.stop();
  a = startA();
  await machineWhen(a.base, (pc) => pc.id === machine.id && pc.state === "connected");

  // B revokes A: A stops, says why, and does not try again
  devices.revoke(paired!.id);
  const revoked = await machineWhen(a.base, (pc) => pc.id === machine.id && pc.state === "error");
  expect(revoked.error).toContain("removed this PC's access");

  // Remove PC forgets the key with the registration
  const removed = await fetch(`${a.base}/api/machines/${machine.id}`, { method: "DELETE", headers: { origin: a.base, "x-herdr-machine": "1" } });
  expect(removed.status).toBe(200);
  const keys = join(aState, "relay-pcs");
  expect(existsSync(keys) ? readdirSync(keys) : []).toEqual([]);
}, 60_000);

it("refuses a link without a pairing code and a PC already added", async () => {
  const { link, startA } = await twoPcs();
  const a = startA();
  const bare = new URL(link);
  bare.hash = "";
  const refused = await addRelayPc(a.base, bare.href);
  expect(refused.status).toBe(400);
  expect((await refused.json() as { error: { message: string } }).error.message).toContain("not a pairing link");
  expect((await addRelayPc(a.base, link)).status).toBe(201);
  const again = await addRelayPc(a.base, link);
  expect(again.status).toBe(400);
  expect((await again.json() as { error: { message: string } }).error.message).toContain("already added");
}, 60_000);

it("waits for a PC that answers slower than an idle connection's default limit", async () => {
  const { link, startA, delay } = await twoPcs();
  const a = startA();
  const { machine } = await (await addRelayPc(a.base, link)).json() as { machine: Machine };
  await machineWhen(a.base, (pc) => pc.id === machine.id && pc.state === "connected");
  // Bun ends a request its server has not answered for 10 s unless told otherwise
  delay.ms = 12_000;
  const slow = await fetch(`${a.base}/api/machines/${machine.id}/session`, { headers: { origin: a.base } });
  expect(slow.status).toBe(200);
}, 60_000);
