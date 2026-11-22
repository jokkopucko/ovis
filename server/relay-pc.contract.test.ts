import { afterEach, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { startBunRelay } from "../relay/bun.ts";
import type { HerdrIdentity, Machine, MachineEvent, PcUpdateAll } from "../shared/machines.ts";
import type { SessionSnapshot } from "../shared/protocol.ts";
import { createServer } from "./index.ts";
import { handleRequest } from "./dispatch.ts";
import { bindTestPc, expectPcAddRefused, pcAddCases, type PcAddMode } from "./pc-add-policy.test-helpers.ts";
import { RelayService } from "./relay/service.ts";
import { newRouteProbes, openRelayPcTunnel, RelayPcKey } from "./relay-pc.ts";
import { decodeOffer } from "../shared/relay-offer.ts";
import type { RelayOffer } from "../shared/relay-offer.ts";
import { bounded, deferred } from "./relay/test-helpers.ts";
import type { UpdateService } from "./update-api.ts";
import { noInstalledNotes, noUpdateNotes, unmanagedUpdateStatus, type UpdateStatus, INSTALL_ID } from "../shared/update.ts";

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

function stateDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "ovis-relay-pc-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/**
 * The private address B names for its direct carrier in these tests, on the direct listener's own port (the only one
 * a PC server dials); A's dials to it reach B's loopback listener on whatever port that got.
 */
const LAN = "10.99.0.1";
const TAILNET = "100.64.0.7";
const listener = { port: 0 };

// An unspecified mode follows the shipped default, on both PCs.
async function twoPcs(options: { direct?: { reachable: (dial: number, host: string) => boolean; held?: (dial: number) => Promise<void> | undefined; named?: (port: number) => readonly string[] }; updates?: UpdateService; accountOpensAll?: boolean; mode?: PcAddMode; platform?: NodeJS.Platform } = {}) {
  const opensAll = options.mode ? options.mode !== "off" : options.accountOpensAll;
  const relay = startBunRelay({ port: 0, limiters: {
    perAddress: { async limit() { return { success: true }; } },
    global: { async limit() { return { success: true }; } },
  } });
  cleanup.push(() => relay.stop());
  const synced = deferred<void>();
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
  if (options.mode === "target-bound") bindTestPc(bState);
  const service = new RelayService({ stateDir: bState, relay: `wss://127.0.0.1:${relay.port}`, connect: local, pairCodeRelay: `wss://127.0.0.1:${relay.port}`,
    ...(options.direct ? { direct: { addresses: () => ["127.0.0.1"], advertise: (port: number) => { listener.port = port; return options.direct!.named?.(port) ?? [`ws://${LAN}:7319`]; }, peerAllowed: () => true, preferredPort: 0 } } : {}) });
  const b = createServer({ port: 0, hostname: "127.0.0.1", stateDir: bState, token: "", tailscaleOwner: null, sidecar: false, registerBridge: false, relay: service, accountOpensAll: opensAll, ...(options.platform ? { platform: options.platform } : {}), ...(options.updates ? { updates: options.updates } : {}) });
  cleanup.push(async () => { await service.shutdown(); b.stop(); });
  const bBase = `http://127.0.0.1:${b.port}`;
  const started = await fetch(`${bBase}/api/relay/start`, { method: "POST", headers: { origin: bBase, "x-herdr-update": "1" } });
  expect(started.status).toBe(200);
  await bounded(synced.promise);
  const offered = await fetch(`${bBase}/api/relay/offer`, { method: "POST", headers: { origin: bBase, "x-herdr-update": "1" } });
  expect(offered.status).toBe(200);
  const approvals = b.context.services.relay.approvals;
  expect((await fetch(`${bBase}/api/relay/link`, { method: "POST", headers: { origin: bBase, "x-herdr-update": "1" } })).status).toBe(200);
  expect(approvals.localOnlyOpen()).toBe(false);
  expect((await fetch(`${bBase}/api/relay/link`, { method: "POST", headers: { origin: bBase, "x-herdr-update": "1", "x-ovis-local-only": "1" } })).status).toBe(200);
  expect(approvals.localOnlyOpen()).toBe(true);
  const { url: link } = await offered.json() as { url: string };
  const aState = stateDir();
  if (options.mode === "source-bound") bindTestPc(aState);
  const lan = { dials: 0, dialed: [] as string[], ended: [] as string[] };
  const onLan = (url: string): WebSocket => {
    const target = new URL(url);
    lan.dialed.push(target.host);
    if (target.hostname !== LAN && target.hostname !== TAILNET) return new WebSocket("ws://127.0.0.1:1/");
    // port 1 on loopback refuses at once, as an address of another network does
    const dial = ++lan.dials;
    const port = options.direct?.reachable(dial, target.hostname) ? (target.port === "7319" ? String(listener.port) : target.port) : "1";
    const socket = new WebSocket(`ws://127.0.0.1:${port}${target.pathname}${target.search}`);
    socket.addEventListener("close", () => lan.ended.push(target.hostname));
    const held = options.direct?.held?.(dial);
    if (!held) return socket;
    const answer = Object.getOwnPropertyDescriptor(WebSocket.prototype, "onmessage")!;
    let handler: ((event: MessageEvent) => void) | null = null;
    answer.set!.call(socket, (event: MessageEvent) => { void held.then(() => handler?.(event)); });
    Object.defineProperty(socket, "onmessage", { get: () => handler, set: (next) => { handler = next; } });
    return socket;
  };
  const startA = () => {
    const a = createServer({ port: 0, hostname: "127.0.0.1", stateDir: aState, token: "", tailscaleOwner: null, sidecar: false, registerBridge: false, relayPcSocket: local, relayPcDirectSocket: onLan,
      accountOpensAll: opensAll, pcUpdateTimings: { pollMs: 20, startMs: 5_000, checkMs: 1_000 } });
    let stopped = false;
    const stop = () => { if (!stopped) { stopped = true; a.stop(); } };
    cleanup.push(stop);
    return { app: a, base: `http://127.0.0.1:${a.port}`, stop };
  };
  return { b, bBase, link, aState, startA, delay, lan, local, onLan };
}

const findRelayPc = (base: string, code: string) => postRelay(base, { code }, "/code");

it("unreadable account evidence refuses a PC add without claiming the unbound source is in an account", async () => {
  const { aState, startA, link, b } = await twoPcs({ mode: "unbound", platform: "linux" });
  writeFileSync(join(aState, "account-tombstones.json"), "unreadable", { mode: 0o600 });
  const a = startA();
  expect(a.app.context.services.devices.account()).toBeNull();
  expect(a.app.context.services.devices.accountError).not.toBeNull();
  const publicRequest = await addRelayPc(a.base, link);
  expect([publicRequest.status, await errorCode(publicRequest)]).toEqual([403, "strict"]);
  // Exercise the already-authorized handler separately. Dispatch must not reveal account details to a blocked caller.
  const response = await handleRequest(new Request(`${a.base}/api/machines/relay`, { method: "POST",
    headers: { host: new URL(a.base).host, origin: a.base, "content-type": "application/json", "x-herdr-machine": "1", "x-herdr-update": "1" },
    body: JSON.stringify({ link }) }), { ...a.app.context, ownerSocket: true, requestIP: () => ({ address: "127.0.0.1" }), timeout() {} });
  expect(b.context.services.devices.list(null).filter(row => row.via_relay)).toEqual([]);
  expect(response?.status).toBe(409);
  expect(await response?.json()).toMatchObject({ error: { code: "pc_add_account_unavailable", message: "Can't add a PC right now. Try again in a moment." } });
  const status = await handleRequest(new Request(`${a.base}/api/account/status`, { headers: { host: new URL(a.base).host } }),
    { ...a.app.context, ownerSocket: true, requestIP: () => ({ address: "127.0.0.1" }), timeout() {} });
  expect(status?.status).toBe(200);
  expect(await status?.json()).toMatchObject({ account: null, pc_add_from_account: "unavailable" });
});

const errorCode = async (response: Response) => (await response.json() as { error: { code: string } }).error.code;

function addRelayPc(base: string, link: string, name?: string): Promise<Response> {
  return postRelay(base, { link, ...(name === undefined ? {} : { name }) });
}

function postRelay(base: string, body: Record<string, string>, path = ""): Promise<Response> {
  return fetch(`${base}/api/machines/relay${path}`, {
    method: "POST", headers: { origin: base, "x-herdr-machine": "1", "x-herdr-update": "1", "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function machineWhen(base: string, wanted: (machine: Machine) => boolean, stop?: AbortSignal): Promise<Machine> {
  const abort = new AbortController();
  stop?.addEventListener("abort", () => abort.abort(), { once: true });
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

it.each(pcAddCases)("relay-link PC add follows the live account binding: %s", async mode => {
  const { b, link, aState, startA } = await twoPcs({ mode, platform: "linux" });
  let a = startA();

  const added = await addRelayPc(a.base, link, "Lab");
  if (mode === "source-bound" || mode === "target-bound") return expectPcAddRefused(added, mode, b);
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

  const connected = await machineWhen(a.base, (pc) => pc.id === machine.id && pc.state === "connected" && pc.snapshot !== null);
  const direct = await (await fetch(`http://127.0.0.1:${b.port}/api/session`, { headers: { origin: `http://127.0.0.1:${b.port}` } })).json() as { snapshot: SessionSnapshot };
  expect(connected.snapshot!.workspaces.map((workspace) => workspace.workspace_id)).toEqual(direct.snapshot.workspaces.map((workspace) => workspace.workspace_id));
  const proxied = await fetch(`${a.base}/api/machines/${machine.id}/session`, { headers: { origin: a.base } });
  expect(proxied.status).toBe(200);
  expect((await proxied.json() as { snapshot: SessionSnapshot }).snapshot.panes.length).toBe(direct.snapshot.panes.length);

  const health = await (await fetch(`http://127.0.0.1:${b.port}/api/health`, { headers: { origin: `http://127.0.0.1:${b.port}` } })).json() as { herdr: HerdrIdentity };
  expect(health.herdr.protocol).toBeNumber();
  const known = await machineWhen(a.base, (pc) => pc.id === machine.id && pc.herdr !== undefined);
  expect(known.herdr).toEqual(health.herdr);

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
  const removed = await fetch(`${a.base}/api/machines/${machine.id}`, { method: "DELETE", headers: { origin: a.base, "x-herdr-machine": "1", "x-herdr-update": "1" } });
  expect(removed.status).toBe(200);
  const keys = join(aState, "relay-pcs");
  expect(existsSync(keys) ? readdirSync(keys) : []).toEqual([]);
}, 60_000);

it.each(pcAddCases)("typed-code PC add follows the live account binding: %s", async mode => {
  const { b, bBase, startA } = await twoPcs({ mode, platform: "linux" });
  const a = startA();
  if (mode === "source-bound") return expectPcAddRefused(await findRelayPc(a.base, "ZZZZZ-ZZZZZ"), mode, b);
  const notACode = await findRelayPc(a.base, "hello");
  expect(notACode.status).toBe(400);
  expect(await errorCode(notACode)).toBe("typed_code_not-a-code");
  const noPc = await findRelayPc(a.base, "ZZZZZ-ZZZZZ");
  expect(noPc.status).toBe(404);
  expect(await errorCode(noPc)).toBe("typed_code_no-pc");

  const minted = await fetch(`${bBase}/api/relay/code`, { method: "POST", headers: { origin: bBase, "x-herdr-update": "1" } });
  expect(minted.status).toBe(200);
  const { code, server_id } = await minted.json() as { code: string; server_id: string };
  const found = await findRelayPc(a.base, code.toLowerCase());
  expect(found.status).toBe(200);
  // the ID to compare with B's screen, and no pairing code: the offer that holds one stays on A
  const answer = await found.json() as { ticket: string; server_id: string; name: string };
  expect(answer).toEqual({ ticket: expect.any(String), server_id, name: expect.any(String) });
  // one exchange spends the code: nothing finds B with it again
  expect(await errorCode(await findRelayPc(a.base, code))).toBe("typed_code_no-pc");

  // only the window holding the ticket adds it: another client naming B's public ID takes nothing
  const other = await postRelay(a.base, { found: server_id });
  expect(other.status).toBe(400);
  expect((await other.json() as { error: { message: string } }).error.message).toContain("no longer waiting");
  const added = await postRelay(a.base, { found: answer.ticket });
  if (mode === "target-bound") return expectPcAddRefused(added, mode, b);
  expect(added.status).toBe(201);
  const { machine } = await added.json() as { machine: Machine };
  expect(machine.relay?.server_id).toBe(server_id);
  await machineWhen(a.base, (pc) => pc.id === machine.id && pc.state === "connected");
  // and only once
  expect((await postRelay(a.base, { found: answer.ticket })).status).toBe(400);
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

it("leaves no relay PC behind when its registration cannot be saved", async () => {
  const { link, aState, startA } = await twoPcs();
  let a = startA();
  const registrations = join(aState, "machines.json");
  mkdirSync(registrations);
  const failed = await addRelayPc(a.base, link, "Lab");
  expect(failed.status).toBe(400);
  expect((await failed.json() as { error: { message: string } }).error.message).toContain("could not be saved");
  const keys = join(aState, "relay-pcs");
  expect(existsSync(keys) ? readdirSync(keys) : []).toEqual([]);
  expect(existsSync(join(aState, "relay-pcs.json"))).toBe(false);

  a.stop();
  rmSync(registrations, { recursive: true });
  a = startA();
  const { machines } = await (await fetch(`${a.base}/api/machines`, { headers: { origin: a.base } })).json() as { machines: Machine[] };
  expect(machines.filter((machine) => machine.kind === "relay")).toEqual([]);
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

async function terminalAnswers(base: string, machineId: string): Promise<string> {
  const opened = deferred<string>();
  const RuntimeSocket = WebSocket as unknown as new (url: string, options: { headers: Record<string, string> }) => WebSocket;
  const terminal = new RuntimeSocket(`${base.replace("http:", "ws:")}/ws?machine_id=${machineId}`, { headers: { origin: base } });
  terminal.onmessage = (event) => opened.resolve(String(event.data));
  terminal.onclose = (event) => opened.reject(new Error(`terminal socket closed ${event.code}`));
  try { return await bounded(opened.promise); } finally { terminal.onclose = null; terminal.close(); }
}

it("moves a relay PC's connection to its same-network address without dropping it, and starts there after a restart", async () => {
  const { link, startA } = await twoPcs({ direct: { reachable: () => true } });
  let a = startA();
  const { machine } = await (await addRelayPc(a.base, link, "Lab")).json() as { machine: Machine };
  // When A has paired through the relay (pairing never goes direct) and B named its address inside the channel
  const seen: string[] = [];
  const routedEarly: string[] = [];
  const moved = await machineWhen(a.base, (pc) => {
    if (pc.id !== machine.id) return false;
    if (pc.state !== "connected" || seen.length > 0) seen.push(pc.state);
    if (pc.route !== undefined && pc.state !== "connected") routedEarly.push(`${pc.state}/${pc.route}`);
    return pc.route === "direct";
  });
  expect(moved.state).toBe("connected");
  expect(seen.filter((state) => state !== "connected")).toEqual([]);
  expect(routedEarly).toEqual([]);
  expect((await fetch(`${a.base}/api/machines/${machine.id}/session`, { headers: { origin: a.base } })).status).toBe(200);
  expect(JSON.parse(await terminalAnswers(a.base, machine.id)).type).toBeString();

  a.stop();
  a = startA();
  const back = await machineWhen(a.base, (pc) => pc.id === machine.id && pc.state === "connected");
  expect(back.route).toBe("direct");
  // and that channel outlives the deadline its sign-in had (each carrier's share of 1.5 s)
  const watch = new AbortController();
  const dropped: string[] = [];
  const watching = machineWhen(a.base, (pc) => { if (pc.id === machine.id && pc.state !== "connected") dropped.push(pc.state); return false; }, watch.signal).catch(() => undefined);
  // fixed wait: proving nothing happens past the sign-in deadline
  await Bun.sleep(2_500);
  watch.abort();
  await watching;
  expect(dropped).toEqual([]);
  expect((await fetch(`${a.base}/api/machines/${machine.id}/session`, { headers: { origin: a.base } })).status).toBe(200);
}, 60_000);

it("keeps a relay PC on the relay while its same-network address does not answer", async () => {
  const { link, startA, lan } = await twoPcs({ direct: { reachable: () => false } });
  let a = startA();
  const { machine } = await (await addRelayPc(a.base, link, "Lab")).json() as { machine: Machine };
  await machineWhen(a.base, (pc) => pc.id === machine.id && pc.state === "connected");
  a.stop();
  const dialsBefore = lan.dials;
  a = startA();
  const back = await machineWhen(a.base, (pc) => pc.id === machine.id && pc.state === "connected");
  expect(lan.dials).toBeGreaterThan(dialsBefore);
  expect(back.route).toBe("relay");
  expect(JSON.parse(await terminalAnswers(a.base, machine.id)).type).toBeString();
}, 60_000);

it("lets a request that starts while a move signs in finish, and still moves", async () => {
  const release = deferred<void>();
  const holding = deferred<void>();
  const { link, local, onLan } = await twoPcs({ direct: { reachable: () => true, held: (dial) => {
    if (dial !== 2) return undefined;
    holding.resolve();
    return release.promise;
  } } });
  const offer = decodeOffer(link)!;
  const key = await RelayPcKey.create(join(stateDir(), "key.json"), offer, () => true);
  const lost: Error[] = [];
  const moved = deferred<void>();
  const tunnel = await openRelayPcTunnel(offer, key, { socket: local as never, directSocket: onLan as never, onLost: (error) => lost.push(error), onMoved: () => moved.resolve() });
  cleanup.push(() => tunnel.close());
  await bounded(holding.promise);
  const request = fetch(`${tunnel.endpoint.url}/api/session`, { headers: { authorization: `Bearer ${tunnel.endpoint.token}` } });
  release.resolve();
  expect((await bounded(request)).status).toBe(200);
  await bounded(moved.promise, 30_000);
  expect(tunnel.route).toBe("direct");
  expect(lost).toEqual([]);
}, 60_000);

it("keeps the old session when input is sent while a move signs in, and moves on a later try", async () => {
  const release = deferred<void>();
  const holding = deferred<void>();
  const { link, local, onLan, lan } = await twoPcs({ direct: { reachable: () => true, held: (dial) => {
    if (dial !== 2) return undefined;
    holding.resolve();
    return release.promise;
  } } });
  const offer = decodeOffer(link)!;
  const key = await RelayPcKey.create(join(stateDir(), "key.json"), offer, () => true);
  const lost: Error[] = [];
  const moved = deferred<void>();
  const tunnel = await openRelayPcTunnel(offer, key, { socket: local as never, directSocket: onLan as never, onLost: (error) => lost.push(error), onMoved: () => moved.resolve() });
  cleanup.push(() => tunnel.close());
  await bounded(holding.promise);
  const RuntimeSocket = WebSocket as unknown as new (url: string, options: { headers: Record<string, string> }) => WebSocket;
  const socket = new RuntimeSocket(`${tunnel.endpoint.url.replace("http:", "ws:")}/ws`, { headers: { authorization: `Bearer ${tunnel.endpoint.token}` } });
  cleanup.push(() => socket.close());
  const open = deferred<void>();
  socket.onopen = () => open.resolve();
  await bounded(open.promise);
  socket.send(JSON.stringify({ type: "role", mode: "observe" }));
  release.resolve();
  await bounded(moved.promise, 45_000);
  expect(lan.dials).toBeGreaterThanOrEqual(3);
  expect(tunnel.route).toBe("direct");
  expect(lost).toEqual([]);
}, 60_000);

it("checks the direct route again when this PC's addresses change, and moves there", async () => {
  const lanUp = { now: false };
  const { link, local, onLan } = await twoPcs({ direct: { reachable: () => lanUp.now } });
  const offer = decodeOffer(link)!;
  const key = await RelayPcKey.create(join(stateDir(), "key.json"), offer, () => true);
  const network = { now: "192.168.1.5" };
  const lost: Error[] = [];
  const moved = deferred<void>();
  const probed = deferred<void>();
  const tunnel = await openRelayPcTunnel(offer, key, { socket: local as never, onLost: (error) => lost.push(error), onMoved: () => moved.resolve(),
    directSocket: ((url: string) => { if (!lanUp.now) probed.resolve(); return onLan(url); }) as never,
    network: () => network.now, networkCheckMs: 50 });
  cleanup.push(() => tunnel.close());
  await bounded(probed.promise);
  expect(tunnel.route).toBe("relay");
  lanUp.now = true;
  network.now = "10.99.0.20";
  await bounded(moved.promise);
  expect(tunnel.route).toBe("direct");
  expect(lost).toEqual([]);
}, 60_000);

it("dials none of the carriers a PC names off its listener's port family or on link-local, and uses the one it may", async () => {
  const { link, local, onLan, lan } = await twoPcs({ direct: { reachable: () => true,
    named: (port) => ["ws://169.254.169.254:7319", `ws://${LAN}:80`, `ws://${LAN}:${port === 7319 ? 7320 : port}`, `ws://${LAN}:7319`] } });
  const offer = decodeOffer(link)!;
  const key = await RelayPcKey.create(join(stateDir(), "key.json"), offer, () => true);
  const moved = deferred<void>();
  const tunnel = await openRelayPcTunnel(offer, key, { socket: local as never, directSocket: onLan as never, onLost: () => {}, onMoved: () => moved.resolve() });
  cleanup.push(() => tunnel.close());
  await bounded(moved.promise);
  // Then it only ever dialed B's listener on the direct port, and keeps only that one
  expect([...new Set(lan.dialed)]).toEqual([`${LAN}:7319`]);
  expect(key.direct).toEqual([`ws://${LAN}:7319`]);
}, 60_000);

async function until(done: () => boolean): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!done()) { if (Date.now() > deadline) throw new Error("condition not reached"); await Bun.sleep(10); }
}

it("keeps a PC's probe deadline across its tunnels, so reconnects dial its routes no more often", async () => {
  const { link, local, onLan, lan } = await twoPcs({ direct: { reachable: () => false } });
  const offer = decodeOffer(link)!;
  const key = await RelayPcKey.create(join(stateDir(), "key.json"), offer, () => true);
  const probes = newRouteProbes();
  const first = await openRelayPcTunnel(offer, key, { socket: local as never, directSocket: onLan as never, onLost: () => {}, probes });
  expect(lan.dials).toBe(1);
  await until(() => probes.failed);
  first.close();
  const { code: _code, ...signIn } = offer;
  for (let again = 0; again < 3; again++) {
    const tunnel = await openRelayPcTunnel(signIn, key, { socket: local as never, directSocket: onLan as never, onLost: () => {}, probes });
    tunnel.close();
  }
  expect(lan.dials).toBe(1);
}, 60_000);

it("tries a PC's routes again on reconnect when this PC changed networks while away", async () => {
  const { link, local, onLan, lan } = await twoPcs({ direct: { reachable: () => false } });
  const offer = decodeOffer(link)!;
  const key = await RelayPcKey.create(join(stateDir(), "key.json"), offer, () => true);
  const probes = newRouteProbes();
  const network = { now: "192.168.1.5" };
  const first = await openRelayPcTunnel(offer, key, { socket: local as never, directSocket: onLan as never, onLost: () => {}, probes, network: () => network.now });
  await until(() => probes.failed);
  first.close();
  const before = lan.dials;
  network.now = "10.99.0.20";
  const { code: _code, ...signIn } = offer;
  const second = await openRelayPcTunnel(signIn, key, { socket: local as never, directSocket: onLan as never, onLost: () => {}, probes, network: () => network.now });
  cleanup.push(() => second.close());
  expect(lan.dials).toBeGreaterThan(before);
}, 60_000);

it("still signs in on a working Tailscale route after a check of its same-network route found that silent", async () => {
  const { link, local, onLan, lan } = await twoPcs({ direct: { reachable: (_dial, host) => host === TAILNET,
    named: () => [`ws://${LAN}:7319`, `ws://${TAILNET}:7319`] } });
  const offer = decodeOffer(link)!;
  const key = await RelayPcKey.create(join(stateDir(), "key.json"), offer, () => true);
  const probes = newRouteProbes();
  const network = { now: "192.168.1.5" };
  const open = (from: RelayOffer, moved?: () => void) => openRelayPcTunnel(from, key, { socket: local as never, directSocket: onLan as never,
    onLost: () => {}, ...(moved ? { onMoved: moved } : {}), probes, network: () => network.now, networkCheckMs: 50 });
  const moved = deferred<void>();
  const first = await open(offer, () => moved.resolve());
  await bounded(moved.promise);
  first.close();
  const { code: _code, ...signIn } = offer;
  const second = await open(signIn);
  expect(second.route).toBe("direct");
  const endedBefore = lan.ended.filter((host) => host === LAN).length;
  network.now = "10.20.0.3";
  await until(() => lan.ended.filter((host) => host === LAN).length > endedBefore);
  await new Promise((resolve) => setTimeout(resolve, 0));
  second.close();
  const third = await open(signIn);
  cleanup.push(() => third.close());
  expect(third.route).toBe("direct");
}, 60_000);

it("lets a sign-in try the direct routes again once a check found one answering, even if it could not move", async () => {
  const { link, local, onLan, lan } = await twoPcs({ direct: { reachable: (dial) => dial === 1 } });
  const offer = decodeOffer(link)!;
  const key = await RelayPcKey.create(join(stateDir(), "key.json"), offer, () => true);
  const probes = { ...newRouteProbes(), failed: true, at: performance.now() - 5 * 60_000 + 300 };
  const tunnel = await openRelayPcTunnel(offer, key, { socket: local as never, directSocket: onLan as never, onLost: () => {}, probes });
  cleanup.push(() => tunnel.close());
  await until(() => lan.ended.length >= 2);
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(tunnel.route).toBe("relay");
  expect(probes.failed).toBe(false);
}, 60_000);

it("records nothing for a PC when its tunnel closes in the middle of a check", async () => {
  const holding = deferred<void>();
  const { link, local, onLan } = await twoPcs({ direct: { reachable: () => true, held: (dial) => {
    if (dial !== 1) return undefined;
    holding.resolve();
    return new Promise<void>(() => {});
  } } });
  const offer = decodeOffer(link)!;
  const key = await RelayPcKey.create(join(stateDir(), "key.json"), offer, () => true);
  const probes = newRouteProbes();
  const tunnel = await openRelayPcTunnel(offer, key, { socket: local as never, directSocket: onLan as never, onLost: () => {}, probes });
  await bounded(holding.promise);
  tunnel.close();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(probes.failed).toBe(false);
}, 60_000);

function updater(status: UpdateStatus, after: Partial<UpdateStatus>[]) {
  const requests: unknown[] = [];
  let reads = -1;
  const service: UpdateService = {
    status: () => reads < 0 ? status : { ...status, ...after[Math.min(reads++, after.length - 1)] },
    notes: noUpdateNotes,
    installed: noInstalledNotes,
    request: (request) => { requests.push(request); if (request.command === "install") reads = 0; },
  };
  return { service, requests };
}
const OFFERED_RELEASE = "a".repeat(40);
const ownOffer = (patch: Partial<UpdateStatus> = {}): UpdateStatus => ({ ...unmanagedUpdateStatus(), managed: true, blocked_reason: null, available: true,
  current_version: "0.5.0", latest_version: "0.5.1", current_revision: "c".repeat(40), latest_revision: OFFERED_RELEASE, revision_bound_install: true, ...patch });
const machinePost = (base: string, path: string, method = "POST") => fetch(`${base}/api/machines/${path}`, { method, headers: { origin: base, "x-herdr-machine": "1", "x-herdr-update": "1" } });

it("shows a relay PC's own update on its card and installs it from here, with its steps, until that PC answers on the new release", async () => {
  const b = updater(ownOffer(), [{ phase: "building", step: "download" }, { phase: "building", step: "build" }, { phase: "idle", available: false, current_revision: OFFERED_RELEASE, current_version: "0.5.1" }]);
  const { link, startA } = await twoPcs({ updates: b.service });
  const a = startA();
  const { machine } = await (await addRelayPc(a.base, link, "Lab")).json() as { machine: Machine };
  const offered = await machineWhen(a.base, (pc) => pc.id === machine.id && pc.state === "connected" && pc.ovis_update != null);
  expect(offered.ovis_update).toEqual({ how: "own", current_version: "0.5.0", latest_version: "0.5.1", updatable: true, reason: null, revision: OFFERED_RELEASE });
  // a release other than the one shown is refused, and nothing is asked of that PC
  const other = await fetch(`${a.base}/api/machines/${machine.id}/update`, { method: "POST", headers: { origin: a.base, "x-herdr-machine": "1", "x-herdr-update": "1", "content-type": "application/json" }, body: JSON.stringify({ revision: "b".repeat(40) }) });
  expect(other.status).toBe(409);
  expect(b.requests).toEqual([]);

  const seen = new AbortController();
  const step = machineWhen(a.base, (pc) => pc.id === machine.id && pc.updating?.step.includes("building") === true, seen.signal);
  const started = await fetch(`${a.base}/api/machines/${machine.id}/update`, { method: "POST", headers: { origin: a.base, "x-herdr-machine": "1", "x-herdr-update": "1", "content-type": "application/json" }, body: JSON.stringify({ revision: OFFERED_RELEASE }) });
  expect(started.status).toBe(202);
  const { job_id } = await started.json() as { job_id: string };
  expect((await step).updating).toMatchObject({ job_id, ovis: true });
  // the install names the release shown, and carries the id its 202 gave (POST /api/updates/install), which only a cancel by
  // the one that asked for it names
  expect(b.requests).toEqual([{ command: "install", expected_revision: OFFERED_RELEASE, install_id: expect.stringMatching(INSTALL_ID) }]);
  const done = await machineWhen(a.base, (pc) => pc.id === machine.id && !pc.updating && pc.ovis_update === null);
  expect(done.update_error ?? null).toBeNull();
  const again = await machinePost(a.base, `${machine.id}/update`);
  expect(again.status).toBe(409);
  expect(await again.json()).toEqual({ error: { code: "update_unavailable", message: "This PC's Ovis is up to date." } });
});

it("tells why a relay PC cannot update, and Update all skips it with that reason", async () => {
  const b = updater(ownOffer({ revision_bound_install: undefined }), []);
  const { link, startA } = await twoPcs({ updates: b.service });
  const a = startA();
  const { machine } = await (await addRelayPc(a.base, link, "Lab")).json() as { machine: Machine };
  const offered = await machineWhen(a.base, (pc) => pc.id === machine.id && pc.state === "connected" && pc.ovis_update != null);
  expect(offered.ovis_update).toMatchObject({ how: "own", updatable: false, reason: expect.stringContaining("too old") });
  const refused = await machinePost(a.base, `${machine.id}/update`);
  expect(refused.status).toBe(409);
  expect((await refused.json() as { error: { code: string } }).error.code).toBe("update_unavailable");
  const all = await machinePost(a.base, "update-all");
  expect(all.status).toBe(202);
  expect(await all.json() as PcUpdateAll).toEqual({ started: [], queued: [], skipped: [{ machine_id: machine.id, reason: offered.ovis_update!.reason! }] });
  expect(b.requests).toEqual([]);
});

it("starts every relay PC's update with Update all, and reports a failure there on its card", async () => {
  const b = updater(ownOffer(), [{ phase: "building", step: "build" }, { phase: "error", error: "The build failed." }]);
  const { link, startA } = await twoPcs({ updates: b.service });
  const a = startA();
  const { machine } = await (await addRelayPc(a.base, link, "Lab")).json() as { machine: Machine };
  await machineWhen(a.base, (pc) => pc.id === machine.id && pc.ovis_update?.updatable === true);
  const all = await machinePost(a.base, "update-all");
  expect(all.status).toBe(202);
  const { started } = await all.json() as PcUpdateAll;
  expect(started.map((entry) => entry.machine_id)).toEqual([machine.id]);
  const failed = await machineWhen(a.base, (pc) => pc.id === machine.id && !pc.updating && typeof pc.update_error === "string");
  expect(failed.update_error).toBe("That PC's Ovis could not update itself: The build failed.");
});
