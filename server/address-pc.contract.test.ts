import { afterEach, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import type { HerdrIdentity, Machine, MachineEvent } from "../shared/machines.ts";
import type { SessionSnapshot } from "../shared/protocol.ts";
import { addressOrigin, type AddressPcError, checkAddressTarget, loadAddressPcToken, openAddressPcForward, pairAddressPc } from "./address-pc.ts";
import { createServer } from "./index.ts";
import { bounded, deferred } from "./relay/test-helpers.ts";

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

function stateDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "ovis-address-pc-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function server(token: string) {
  const dir = stateDir();
  const app = createServer({ port: 0, hostname: "127.0.0.1", stateDir: dir, token, tailscaleOwner: null, sidecar: false, registerBridge: false });
  cleanup.push(() => app.stop());
  return { app, dir, base: `http://127.0.0.1:${app.port}` };
}

function addAddressPc(base: string, body: Record<string, string>): Promise<Response> {
  return fetch(`${base}/api/machines/address`, {
    method: "POST", headers: { origin: base, "x-herdr-machine": "1", "x-herdr-update": "1", "content-type": "application/json" }, body: JSON.stringify(body),
  });
}

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

it("adds another PC's Ovis by its address with the code it shows, shows its panes, and stops at a revocation", async () => {
  const b = server("fictional-b-token");
  const a = server("");
  expect((await fetch(`${b.base}/api/session`)).status).toBe(401);
  const devices = b.app.context.services.devices;

  const failure = async (body: Record<string, string>) => { const response = await addAddressPc(a.base, body); return [response.status, (await response.json() as { error: { code: string } }).error.code]; };
  expect(await failure({ address: b.base, code: "000000" })).toEqual([400, "address_pc_wrong_code"]);
  expect(await failure({ address: b.base, code: "12345" })).toEqual([400, "address_pc_code"]);
  expect(await failure({ address: `${b.base}/ovis`, code: "123456" })).toEqual([400, "address_pc_address"]);
  expect(await failure({ address: "https://169.254.169.254", code: "123456" })).toEqual([400, "address_pc_target"]);
  expect(await failure({ address: a.base.replace("127.0.0.1", "localhost"), code: a.app.context.services.devices.startPairing().code })).toEqual([400, "address_pc_self"]);
  expect(a.app.context.services.devices.list(null)).toEqual([]);
  const added = await addAddressPc(a.base, { address: b.base, code: devices.startPairing().code, name: "Desk" });
  expect(added.status).toBe(201);
  const { machine } = await added.json() as { machine: Machine };
  expect(machine).toMatchObject({ kind: "address", name: "Desk", address: b.base });

  const paired = devices.list(null).find((device) => device.label === `Ovis on ${hostname()}`.slice(0, 64));
  expect(paired?.role).toBe("drive");
  const tokenPath = join(a.dir, "address-pcs", `${machine.id}.json`);
  expect(statSync(tokenPath).mode & 0o777).toBe(0o600);
  const deviceToken = (JSON.parse(readFileSync(tokenPath, "utf8")) as { token: string }).token;
  expect(readFileSync(join(a.dir, "address-pcs.json"), "utf8")).toContain(machine.id);
  for (const file of ["machines.json", "address-pcs.json"]) if (existsSync(join(a.dir, file))) expect(readFileSync(join(a.dir, file), "utf8")).not.toContain(deviceToken);
  expect(JSON.stringify(await (await fetch(`${a.base}/api/machines`, { headers: { origin: a.base } })).json())).not.toContain(deviceToken);

  const connected = await machineWhen(a.base, (pc) => pc.id === machine.id && pc.state === "connected" && pc.snapshot !== null);
  const direct = await (await fetch(`${b.base}/api/session`, { headers: { authorization: "Bearer fictional-b-token" } })).json() as { snapshot: SessionSnapshot };
  expect(connected.snapshot!.workspaces.map((workspace) => workspace.workspace_id)).toEqual(direct.snapshot.workspaces.map((workspace) => workspace.workspace_id));
  const proxied = await fetch(`${a.base}/api/machines/${machine.id}/session`, { headers: { origin: a.base } });
  expect(proxied.status).toBe(200);
  const health = await (await fetch(`${b.base}/api/health`, { headers: { authorization: "Bearer fictional-b-token" } })).json() as { herdr: HerdrIdentity };
  expect((await machineWhen(a.base, (pc) => pc.id === machine.id && pc.herdr !== undefined)).herdr).toEqual(health.herdr);
  expect(await failure({ address: b.base, code: devices.startPairing().code })).toEqual([409, "address_pc_added"]);

  expect(devices.revoke(paired!.id)).toBe(true);
  await fetch(`${a.base}/api/machines/${machine.id}/session`, { headers: { origin: a.base } });
  const refused = await machineWhen(a.base, (pc) => pc.id === machine.id && pc.state === "error");
  expect(refused.error).toBe("That PC no longer accepts this one. Remove it here and add it again with a new code from that PC.");

  const removed = await fetch(`${a.base}/api/machines/${machine.id}`, { method: "DELETE", headers: { origin: a.base, "x-herdr-machine": "1", "x-herdr-update": "1" } });
  expect(removed.ok).toBe(true);
  expect(existsSync(tokenPath)).toBe(false);
  expect(readFileSync(join(a.dir, "address-pcs.json"), "utf8")).not.toContain(machine.id);
});

it("starts again with a saved address PC and reaches it with its saved token, and refuses one listed in machines.json", async () => {
  const b = server("fictional-b-token");
  const dir = stateDir();
  const start = () => { const app = createServer({ port: 0, hostname: "127.0.0.1", stateDir: dir, token: "", tailscaleOwner: null, sidecar: false, registerBridge: false }); return { app, base: `http://127.0.0.1:${app.port}` }; };
  const first = start();
  const added = await addAddressPc(first.base, { address: b.base, code: b.app.context.services.devices.startPairing().code });
  const { machine } = await added.json() as { machine: Machine };
  await machineWhen(first.base, (pc) => pc.id === machine.id && pc.state === "connected");
  first.app.stop();
  const again = start();
  cleanup.push(() => again.app.stop());
  const back = await machineWhen(again.base, (pc) => pc.id === machine.id && pc.state === "connected" && pc.snapshot !== null);
  expect(back).toMatchObject({ kind: "address", address: b.base });
  // it runs its own Ovis: no bridge update or SSH setup is started for it from here
  const manager = again.app.context.services.core.machines!;
  expect(() => manager.updateBridge(machine.id)).toThrow("A PC added by its address runs its own Ovis");
  expect(() => manager.setup({ machine_id: machine.id, destination: "desk" })).toThrow("A PC added by its address runs its own Ovis");
  again.app.stop();
  writeFileSync(join(dir, "machines.json"), JSON.stringify([{ id: machine.id, name: "Desk", kind: "address", address: b.base, enabled: true }]));
  expect(() => createServer({ port: 0, hostname: "127.0.0.1", stateDir: dir, token: "", tailscaleOwner: null, sidecar: false, registerBridge: false })).toThrow("Invalid machine registration");
});

it("pairs with only the code and a label, and forwards only allowlisted headers both ways behind its own bearer", async () => {
  const seen: { path: string; headers: Record<string, string>; body: string }[] = [];
  const socketHeaders = deferred<Record<string, string>>();
  const upstream = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    async fetch(request, bun) {
      const url = new URL(request.url);
      if (url.pathname === "/ws") {
        socketHeaders.resolve(Object.fromEntries(request.headers));
        return bun.upgrade(request, { data: undefined }) ? undefined : new Response(null, { status: 400 });
      }
      seen.push({ path: url.pathname, headers: Object.fromEntries(request.headers), body: await request.text() });
      if (url.pathname === "/api/devices/pair") return Response.json({ token: "fictional-device-token-0123456789" });
      return new Response("{}", { headers: { "content-type": "application/json", "set-cookie": "ovis_device=theirs", "x-upstream-secret": "1", etag: "\"e1\"" } });
    },
    websocket: { message(socket, message) { socket.send(message); } },
  });
  cleanup.push(() => upstream.stop(true));
  const origin = `http://127.0.0.1:${upstream.port}`;

  expect(await pairAddressPc(origin, "123456", "Ovis on test")).toBe("fictional-device-token-0123456789");
  expect(JSON.parse(seen[0]!.body)).toEqual({ code: "123456", label: "Ovis on test" });
  expect(seen[0]!.headers.authorization).toBeUndefined();
  expect(seen[0]!.headers.cookie).toBeUndefined();

  const lost: Error[] = [];
  const forward = openAddressPcForward(origin, "fictional-device-token-0123456789", (error) => lost.push(error));
  cleanup.push(() => forward.close());
  expect(new URL(forward.endpoint.url).hostname).toBe("127.0.0.1");
  expect((await fetch(`${forward.endpoint.url}/api/session`)).status).toBe(401);
  expect((await fetch(`${forward.endpoint.url}/api/session`, { headers: { authorization: "Bearer wrong" } })).status).toBe(401);
  expect(seen.length).toBe(1);

  const answer = await fetch(`${forward.endpoint.url}/api/session?x=1`, { headers: {
    authorization: `Bearer ${forward.endpoint.token}`, cookie: "ovis_token=ours", "x-forwarded-for": "203.0.113.9", "x-herdr-machine": "1", "if-none-match": "\"e0\"",
  } });
  expect(answer.status).toBe(200);
  expect(answer.headers.get("set-cookie")).toBeNull();
  expect(answer.headers.get("x-upstream-secret")).toBeNull();
  expect(answer.headers.get("etag")).toBe("\"e1\"");
  const asked = seen[1]!;
  expect(asked.path).toBe("/api/session");
  expect(asked.headers.authorization).toBe("Device fictional-device-token-0123456789");
  expect(asked.headers.cookie).toBeUndefined();
  expect(asked.headers["x-forwarded-for"]).toBeUndefined();
  expect(asked.headers["x-herdr-machine"]).toBe("1");
  expect(asked.headers["if-none-match"]).toBe("\"e0\"");

  const RuntimeSocket = WebSocket as unknown as new (url: string, options: { headers: Record<string, string> }) => WebSocket;
  const socket = new RuntimeSocket(`${forward.endpoint.url.replace("http:", "ws:")}/ws`, { headers: { authorization: `Bearer ${forward.endpoint.token}`, cookie: "ovis_token=ours", "x-forwarded-for": "203.0.113.9" } });
  const echoed = deferred<string>();
  socket.onmessage = (event) => echoed.resolve(String(event.data));
  socket.onopen = () => socket.send("hello");
  expect(await bounded(echoed.promise)).toBe("hello");
  const upgraded = await bounded(socketHeaders.promise);
  expect(upgraded.authorization).toBe("Device fictional-device-token-0123456789");
  expect(upgraded.cookie).toBeUndefined();
  expect(upgraded["x-forwarded-for"]).toBeUndefined();
  socket.close();
  expect(lost).toEqual([]);
});

it("ends the forward when that PC answers 401, and tells it as a refusal", async () => {
  const upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => Response.json({ error: { code: "unauthorized" } }, { status: 401 }) });
  cleanup.push(() => upstream.stop(true));
  const lost = deferred<Error>();
  const forward = openAddressPcForward(`http://127.0.0.1:${upstream.port}`, "fictional-device-token-0123456789", (error) => lost.resolve(error));
  expect((await fetch(`${forward.endpoint.url}/api/session`, { headers: { authorization: `Bearer ${forward.endpoint.token}` } })).status).toBe(401);
  expect((await bounded(lost.promise)).name).toBe("AddressPcRefused");
  expect(await fetch(`${forward.endpoint.url}/api/session`, { headers: { authorization: `Bearer ${forward.endpoint.token}` } }).then(() => "answered", () => "closed")).toBe("closed");
});

it("follows no redirect, pairing or forwarding: the place it points to is never asked", async () => {
  let elsewhere = 0;
  const target = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => { elsewhere++; return Response.json({ token: "fictional-device-token-0123456789" }); } });
  cleanup.push(() => target.stop(true));
  const moved = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (request) => Response.redirect(`http://127.0.0.1:${target.port}${new URL(request.url).pathname}`, 307) });
  cleanup.push(() => moved.stop(true));
  const origin = `http://127.0.0.1:${moved.port}`;
  expect(await pairAddressPc(origin, "123456", "Ovis on test").then(() => "paired", (error: AddressPcError) => error.failure)).toBe("unreachable");
  const forward = openAddressPcForward(origin, "fictional-device-token-0123456789", () => {});
  cleanup.push(() => forward.close());
  expect((await fetch(`${forward.endpoint.url}/api/session`, { headers: { authorization: `Bearer ${forward.endpoint.token}` } })).status).toBe(502);
  expect(elsewhere).toBe(0);
});

it("listens on 127.0.0.1 alone, behind a bearer of its own for every forward", async () => {
  const upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => Response.json({}) });
  cleanup.push(() => upstream.stop(true));
  const origin = `http://127.0.0.1:${upstream.port}`;
  const one = openAddressPcForward(origin, "fictional-device-token-0123456789", () => {});
  const two = openAddressPcForward(origin, "fictional-device-token-0123456789", () => {});
  cleanup.push(() => { one.close(); two.close(); });
  expect(one.endpoint.token).not.toBe(two.endpoint.token);
  expect((await fetch(`${one.endpoint.url}/api/session`, { headers: { authorization: `Bearer ${two.endpoint.token}` } })).status).toBe(401);
  expect((await fetch(`${one.endpoint.url}/api/session`, { headers: { authorization: `Bearer ${one.endpoint.token}` } })).status).toBe(200);
  // another loopback address of this PC reaches a listener bound to all of them, never one bound to 127.0.0.1
  const port = new URL(one.endpoint.url).port;
  expect(await fetch(`http://127.0.0.2:${port}/api/session`, { headers: { authorization: `Bearer ${one.endpoint.token}` } }).then(() => "answered", () => "refused")).toBe("refused");
});

it("looks a saved address up again before it reconnects, and dials none that is never a PC's Ovis", async () => {
  const dir = stateDir();
  const id = randomUUID();
  writeFileSync(join(dir, "address-pcs.json"), JSON.stringify([{ id, name: "Gone", kind: "address", address: "https://0.0.0.0:1", enabled: true }]));
  mkdirSync(join(dir, "address-pcs"));
  writeFileSync(join(dir, "address-pcs", `${id}.json`), JSON.stringify({ v: 1, token: "fictional-device-token-0123456789" }), { mode: 0o600 });
  const app = createServer({ port: 0, hostname: "127.0.0.1", stateDir: dir, token: "", tailscaleOwner: null, sidecar: false, registerBridge: false });
  cleanup.push(() => app.stop());
  const pc = await machineWhen(`http://127.0.0.1:${app.port}`, (machine) => machine.id === id && machine.error !== null);
  expect(pc.error).toBe("That address cannot be another PC's Ovis.");
});

it("leaves no token behind when the PC's registration cannot be saved", async () => {
  const b = server("fictional-b-token");
  const a = server("");
  mkdirSync(join(a.dir, "address-pcs.json"));
  const added = await addAddressPc(a.base, { address: b.base, code: b.app.context.services.devices.startPairing().code });
  expect(await added.json()).toMatchObject({ error: { code: "machine_request_failed" } });
  expect(readdirSync(join(a.dir, "address-pcs"))).toEqual([]);
  expect(((await (await fetch(`${a.base}/api/machines`, { headers: { origin: a.base } })).json()) as { machines: Machine[] }).machines.map((pc) => pc.kind)).toEqual(["local"]);
});

it("passes a 401 of one of that PC's routes on, and stays while that PC still takes this one", async () => {
  const asked: string[] = [];
  const checked = deferred<void>();
  const upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    const { pathname } = new URL(request.url);
    asked.push(pathname);
    if (pathname === "/api/session") { checked.resolve(); return Response.json({ snapshot: null }); }
    return Response.json({ error: { code: "unauthorized" } }, { status: 401 });
  } });
  cleanup.push(() => upstream.stop(true));
  const lost: Error[] = [];
  const forward = openAddressPcForward(`http://127.0.0.1:${upstream.port}`, "fictional-device-token-0123456789", (error) => lost.push(error));
  cleanup.push(() => forward.close());
  const auth = { authorization: `Bearer ${forward.endpoint.token}` };
  expect((await fetch(`${forward.endpoint.url}/api/machines/x/session`, { headers: auth })).status).toBe(401);
  await bounded(checked.promise);
  expect((await fetch(`${forward.endpoint.url}/api/session`, { headers: auth })).status).toBe(200);
  expect(asked).toEqual(["/api/machines/x/session", "/api/session", "/api/session"]);
  expect(lost).toEqual([]);
});

it("hears a refusal on a socket too: one that never opened asks that PC, and a 401 there ends the forward", async () => {
  const upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(null, { status: 401 }) });
  cleanup.push(() => upstream.stop(true));
  const lost = deferred<Error>();
  const forward = openAddressPcForward(`http://127.0.0.1:${upstream.port}`, "fictional-device-token-0123456789", (error) => lost.resolve(error));
  cleanup.push(() => forward.close());
  const RuntimeSocket = WebSocket as unknown as new (url: string, options: { headers: Record<string, string> }) => WebSocket;
  const socket = new RuntimeSocket(`${forward.endpoint.url.replace("http:", "ws:")}/ws`, { headers: { authorization: `Bearer ${forward.endpoint.token}` } });
  const closed = deferred<number>();
  socket.onclose = (event) => closed.resolve(event.code);
  expect(await bounded(closed.promise)).toBe(1012);
  expect((await bounded(lost.promise)).name).toBe("AddressPcRefused");
});

it("ends a socket whose sends pile up before that PC opened it, by count as well as by size", async () => {
  const upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Promise<Response>(() => {}) });
  cleanup.push(() => upstream.stop(true));
  const forward = openAddressPcForward(`http://127.0.0.1:${upstream.port}`, "fictional-device-token-0123456789", () => {});
  cleanup.push(() => forward.close());
  const RuntimeSocket = WebSocket as unknown as new (url: string, options: { headers: Record<string, string> }) => WebSocket;
  const socket = new RuntimeSocket(`${forward.endpoint.url.replace("http:", "ws:")}/ws`, { headers: { authorization: `Bearer ${forward.endpoint.token}` } });
  const closed = deferred<number>();
  socket.onclose = (event) => closed.resolve(event.code);
  socket.onopen = () => { for (let i = 0; i < 1100; i++) socket.send(""); };
  expect(await bounded(closed.promise)).toBe(1009);
});

it("gives up on a token file that is gone or holds no token, and tries again after any other read failure", () => {
  const dir = stateDir();
  const outcome = (path: string) => { try { return loadAddressPcToken(path); } catch (error) { return (error as Error).name; } };
  writeFileSync(join(dir, "saved.json"), JSON.stringify({ v: 1, token: "fictional-device-token-0123456789" }));
  writeFileSync(join(dir, "empty.json"), "{}");
  mkdirSync(join(dir, "unreadable.json"));
  expect([outcome(join(dir, "saved.json")), outcome(join(dir, "gone.json")), outcome(join(dir, "empty.json")), outcome(join(dir, "unreadable.json"))])
    .toEqual(["fictional-device-token-0123456789", "AddressPcRefused", "AddressPcRefused", "Error"]);
});

it("takes an https origin, or plain http to this PC only, and nothing after it", () => {
  expect(addressOrigin(" https://desk.example.ts.net/ ")).toBe("https://desk.example.ts.net");
  expect(addressOrigin("https://desk.example.ts.net:8443")).toBe("https://desk.example.ts.net:8443");
  expect(addressOrigin("http://127.0.0.1:7317")).toBe("http://127.0.0.1:7317");
  for (const refused of ["http://desk.example.ts.net", "ftp://desk", "https://desk.example.ts.net/ovis", "https://desk.example.ts.net/?a=1", "https://desk.example.ts.net/#x", "https://me@desk.example.ts.net", "desk.example.ts.net", 7317]) {
    expect(() => addressOrigin(refused), String(refused)).toThrow();
  }
});

it("takes public, LAN, Tailscale and this PC's addresses, and refuses link-local, unspecified and multicast ones", async () => {
  const resolving = (address: string) => (async () => [{ address, family: address.includes(":") ? 6 : 4 }]) as unknown as Parameters<typeof checkAddressTarget>[1];
  for (const taken of ["203.0.113.5", "192.168.1.5", "10.0.0.2", "100.64.0.7", "fd7a:115c:a1e0::1", "127.0.0.1"]) {
    expect(await checkAddressTarget("https://desk.example.ts.net", resolving(taken)).then(() => "taken", () => "refused"), taken).toBe("taken");
  }
  for (const refused of ["169.254.169.254", "0.0.0.0", "224.0.0.1", "255.255.255.255", "fe80::1", "::", "ff02::1", "::ffff:169.254.169.254"]) {
    expect(await checkAddressTarget("https://desk.example.ts.net", resolving(refused)).then(() => "taken", () => "refused"), refused).toBe("refused");
  }
  expect(await checkAddressTarget("https://169.254.169.254").then(() => "taken", () => "refused")).toBe("refused");
});
