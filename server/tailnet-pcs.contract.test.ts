import { afterEach, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startBunRelay } from "../relay/bun.ts";
import type { Machine } from "../shared/machines.ts";
import type { CompletionTracker } from "./completion.ts";
import { createServer } from "./index.ts";
import { handleMachineRequest } from "./machine-api.ts";
import { MachineManager } from "./machines.ts";
import type { PushService } from "./push.ts";
import { RelayService } from "./relay/service.ts";
import { bounded, deferred } from "./relay/test-helpers.ts";
import { tailnetPeers } from "./tailnet-pcs.ts";

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

function stateDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "ovis-tailnet-pcs-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** `tailscale status --json` for this PC (user 1) and its peers */
function status(peers: { name: string; user: string; online?: boolean; tags?: string[]; os?: string }[]): string {
  const peer = Object.fromEntries(peers.map((p, index) => [`key${index}`, {
    HostName: `os-host-of-${p.name}`, DNSName: `${p.name}.tail.ts.net.`, UserID: p.user, Online: p.online ?? true, OS: p.os ?? "linux", ...(p.tags ? { Tags: p.tags } : {}),
  }]));
  // a real status writes user ids as bare numbers, some past 2^53
  return JSON.stringify({ BackendState: "Running", Self: { HostName: "pc-a", DNSName: "pc-a.tail.ts.net.", UserID: "USER1" }, Peer: peer })
    .replace(/"UserID":"(USER1|\d+)"/g, (_, id: string) => `"UserID":${id === "USER1" ? "9007199254740993" : id}`);
}

it("lists only online, untagged PCs of this PC's own Tailscale login, never phones", () => {
  const found = tailnetPeers(status([
    { name: "mine", user: "9007199254740993" },
    { name: "other-login", user: "9007199254740992" },
    { name: "tagged", user: "9007199254740993", tags: ["tag:server"] },
    { name: "asleep", user: "9007199254740993", online: false },
    { name: "phone", user: "9007199254740993", os: "iOS" },
  ]));
  expect(found).toEqual([{ name: "mine", dnsName: "mine.tail.ts.net" }]);
  expect(tailnetPeers(null)).toEqual([]);
  expect(tailnetPeers(JSON.stringify({ BackendState: "Stopped" }))).toEqual([]);
});

/**
 * PC B with the relay on, reached as `tailscale serve` would bring a request from another node of the
 * tailnet: from loopback, with the asking node's login and its tailnet source address.
 */
async function pcB(login: string, options: { codeServerId?: string } = {}) {
  const relay = startBunRelay({ port: 0, limiters: {
    perAddress: { async limit() { return { success: true }; } },
    global: { async limit() { return { success: true }; } },
  } });
  cleanup.push(() => relay.stop());
  const synced = deferred<void>();
  const local = (url: string): WebSocket => {
    const target = new URL(url);
    const socket = new WebSocket(`ws://127.0.0.1:${relay.port}${target.pathname}${target.search}`);
    if (target.searchParams.get("role") === "server" && !target.searchParams.has("connection_id")) {
      socket.addEventListener("message", (event) => {
        if (typeof event.data === "string" && JSON.parse(event.data).type === "sync") synced.resolve();
      });
    }
    return socket;
  };
  const bState = stateDir();
  const service = new RelayService({ stateDir: bState, relay: `wss://127.0.0.1:${relay.port}`, connect: local, pairCodeRelay: `wss://127.0.0.1:${relay.port}` });
  const b = createServer({ port: 0, hostname: "127.0.0.1", stateDir: bState, token: "", tailscaleOwner: "me@example.com", sidecar: false, registerBridge: false, relay: service });
  cleanup.push(async () => { await service.shutdown(); b.stop(); });
  const bBase = `http://127.0.0.1:${b.port}`;
  expect((await fetch(`${bBase}/api/relay/start`, { method: "POST", headers: { origin: bBase, "x-herdr-update": "1" } })).status).toBe(200);
  await bounded(synced.promise);
  const asked: string[] = [];
  const serve = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(request) {
    const url = new URL(request.url);
    asked.push(`${request.method} ${url.pathname}`);
    const headers = new Headers(request.headers);
    headers.set("tailscale-user-login", login);
    headers.set("x-forwarded-for", "100.64.0.7");
    const answer = await fetch(`${bBase}${url.pathname}${url.search}`, { method: request.method, headers, body: request.body });
    // a PC that names another PC's ID beside its code
    if (url.pathname === "/api/relay/code" && options.codeServerId !== undefined) return Response.json({ ...await answer.json() as object, server_id: options.codeServerId });
    return answer;
  } });
  cleanup.push(() => serve.stop(true));
  return { b, bBase, serveUrl: `http://127.0.0.1:${serve.port}`, local, asked };
}

async function pcA(initial: Parameters<typeof status>[0], origins: Record<string, string>, local: (url: string) => WebSocket) {
  const probed: string[] = [];
  let peers = initial;
  const a = createServer({ port: 0, hostname: "127.0.0.1", stateDir: stateDir(), token: "", tailscaleOwner: null, sidecar: false, registerBridge: false, relayPcSocket: local,
    tailnetPcs: { readStatus: async () => status(peers), ports: [443], origin: (dnsName) => { probed.push(dnsName); return origins[dnsName] ?? "http://127.0.0.1:9"; } } });
  cleanup.push(() => a.stop());
  const base = `http://127.0.0.1:${a.port}`;
  const ask = (method: string, body?: unknown) => fetch(`${base}/api/machines/tailnet`, {
    method, headers: { origin: base, "x-herdr-machine": "1", "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { ask, probed, base, setPeers: (next: Parameters<typeof status>[0]) => { peers = next; } };
}

type Found = { pcs: { name: string; url: string; relay: string | null }[] };

it("adds a PC of the same Tailscale login through the relay with one tap, after the IDs match by themselves", async () => {
  const { b, serveUrl, local } = await pcB("me@example.com");
  const { ask, probed } = await pcA([{ name: "pc-b", user: "9007199254740993" }, { name: "stranger", user: "42" }], { "pc-b.tail.ts.net": serveUrl }, local);

  const listed = await ask("GET");
  expect(listed.status).toBe(200);
  const { pcs } = await listed.json() as Found;
  expect(pcs).toEqual([{ name: "pc-b", url: serveUrl, relay: "online" }]);
  // a node of another login is never asked anything
  expect(probed).toEqual(["pc-b.tail.ts.net"]);

  // only an address the list found is asked for a code
  expect((await ask("POST", { url: "http://127.0.0.1:9" })).status).toBe(404);

  const added = await ask("POST", { url: serveUrl });
  expect(added.status).toBe(201);
  const { machine } = await added.json() as { machine: Machine };
  expect(machine).toMatchObject({ kind: "relay", name: "pc-b", relay: { server_id: b.context.services.relay.serverId() } });
  // added, it is no longer offered
  expect(await (await ask("GET")).json()).toEqual({ pcs: [] });
});

it("adds nothing when the relay finds another PC than the one that gave the code", async () => {
  const { serveUrl, local } = await pcB("me@example.com", { codeServerId: "f".repeat(43) });
  const { ask, base } = await pcA([{ name: "pc-b", user: "9007199254740993" }], { "pc-b.tail.ts.net": serveUrl }, local);
  await ask("GET");
  const added = await ask("POST", { url: serveUrl });
  expect(added.status).toBe(409);
  expect((await added.json() as { error: { code: string } }).error.code).toBe("tailnet_mismatch");
  const { machines } = await (await fetch(`${base}/api/machines`, { headers: { origin: base } })).json() as { machines: Machine[] };
  expect(machines.filter((machine) => machine.kind === "relay")).toEqual([]);
});

it("asks no code of a PC whose relay is off", async () => {
  const { bBase, serveUrl, local, asked } = await pcB("me@example.com");
  expect((await fetch(`${bBase}/api/relay/stop`, { method: "POST", headers: { origin: bBase, "x-herdr-update": "1" } })).status).toBe(200);
  const { ask } = await pcA([{ name: "pc-b", user: "9007199254740993" }], { "pc-b.tail.ts.net": serveUrl }, local);
  expect((await (await ask("GET")).json() as Found).pcs).toEqual([{ name: "pc-b", url: serveUrl, relay: "off" }]);
  const added = await ask("POST", { url: serveUrl });
  expect((await added.json() as { error: { code: string } }).error.code).toBe("tailnet_relay_off");
  expect(asked).not.toContain("POST /api/relay/code");
});

it("tells a watching device nothing and asks no PC", async () => {
  let asked = 0;
  const manager = new MachineManager(stateDir(), {} as PushService, {} as CompletionTracker, async () => { throw new Error("local offline"); },
    { tailnet: { readStatus: async () => { asked++; return status([{ name: "pc-b", user: "9007199254740993" }]); } } });
  const response = await handleMachineRequest(new Request("http://127.0.0.1/api/machines/tailnet"), manager, undefined, undefined, true);
  expect(response.status).toBe(403);
  expect(asked).toBe(0);
  manager.stop();
});

it("lets no open LAN window borrow this PC's Tailscale login, and adds no PC that has since left it", async () => {
  const { serveUrl, local } = await pcB("me@example.com");
  const { ask, base, setPeers } = await pcA([{ name: "pc-b", user: "9007199254740993" }], { "pc-b.tail.ts.net": serveUrl }, local);
  const fromLan = await fetch(`${base}/api/machines/tailnet`, { headers: { origin: base, "x-forwarded-for": "192.168.1.5" } });
  expect(fromLan.status).toBe(403);
  expect((await fromLan.json() as { error: { code: string } }).error.code).toBe("owner_only");

  expect((await (await ask("GET")).json() as Found).pcs).toHaveLength(1);
  // Tailscale now says that name is another login's: the list minutes ago does not make it addable
  setPeers([{ name: "pc-b", user: "42" }]);
  const added = await ask("POST", { url: serveUrl });
  expect(added.status).toBe(404);
  expect((await added.json() as { error: { code: string } }).error.code).toBe("tailnet_not_found");
});

it("stops reading a PC's answer past its size bound", async () => {
  const big = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response(JSON.stringify({ ok: true, auth: { authenticated: true, via: "tailscale", role: "drive" }, pad: "x".repeat(200_000) })) });
  cleanup.push(() => big.stop(true));
  const { ask } = await pcA([{ name: "pc-b", user: "9007199254740993" }], { "pc-b.tail.ts.net": `http://127.0.0.1:${big.port}` }, (url) => new WebSocket(url));
  expect(await (await ask("GET")).json()).toEqual({ pcs: [] });
});

it("does not list a PC that does not let this PC's login drive it", async () => {
  const { serveUrl, local } = await pcB("them@example.com");
  const { ask } = await pcA([{ name: "pc-b", user: "9007199254740993" }], { "pc-b.tail.ts.net": serveUrl }, local);
  expect(await (await ask("GET")).json()).toEqual({ pcs: [] });
  expect((await ask("POST", { url: serveUrl })).status).toBe(404);
});
