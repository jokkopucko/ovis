import { afterEach, expect, it, spyOn } from "bun:test";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bytesToHex } from "@noble/hashes/utils.js";
import { startBunRelay } from "../relay/bun.ts";
import { FakeAccountService } from "../shared/account-service-fake.ts";
import type { Machine, RemotePairingRequest } from "../shared/machines.ts";
import { importPublicKey } from "../shared/relay-e2ee.ts";
import { FrameType, PAIR_INTENT_VOUCHED } from "../shared/relay-mux.ts";
import { decodeOffer } from "../shared/relay-offer.ts";
import type { SessionFrame } from "../shared/relay-mux-engine.ts";
import { readDeviceRegistry } from "./devices.ts";
import { createServer } from "./index.ts";
import { RelayService } from "./relay/service.ts";
import { RelaySession } from "./relay/session.ts";
import { rotateRelayIdentity } from "./relay/identity.ts";
import type { RelayPcKey } from "./relay-pc.ts";
import { bounded, deferred, relayConnection } from "./relay/test-helpers.ts";

// Add a connection → Ovis relay → Add, between two real servers on a local relay (docs/account.md, "Adding a PC of
// your account"): PC A's server pairs with PC B of the same account, vouched for by an admission its page posted, and
// B lets it in only once a drive member of the account picked the digits A shows.

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

function stateDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "ovis-relay-account-pc-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const ACCOUNT = "acct_1";

/** PC B in ACCOUNT (one drive member, its relay on), PC A, the local relay between them, and the account service. */
async function accountPcs(options: { clock?: () => number; aIdentity?: boolean } = {}) {
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
  const service = new FakeAccountService(options.clock ?? Date.now);
  const token = service.issueToken(ACCOUNT);
  // B's account member, in devices.json before B starts, as a PC an account device linked to holds it
  const bState = stateDir();
  const keys = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
  const memberKey = Buffer.from(await crypto.subtle.exportKey("spki", keys.publicKey)).toString("base64url");
  const member = { id: randomBytes(8).toString("hex"), label: "Owner's phone", role: "drive", token_hash: randomBytes(32).toString("hex"),
    relay_public_key: memberKey, account: ACCOUNT, created_at: new Date().toISOString(), last_seen_at: null };
  writeFileSync(join(bState, "devices.json"), JSON.stringify({ gate_closed_at: member.created_at, devices: [member] }), { mode: 0o600 });
  const relayService = new RelayService({ stateDir: bState, relay: `wss://127.0.0.1:${relay.port}`, connect: local });
  const b = createServer({ port: 0, hostname: "127.0.0.1", stateDir: bState, token: "", tailscaleOwner: null, sidecar: false, registerBridge: false, relay: relayService,
    accountService: { url: "https://account.test", fetch: service.fetch } });
  cleanup.push(async () => { await relayService.shutdown(); b.stop(); });
  const bBase = `http://127.0.0.1:${b.port}`;
  expect((await fetch(`${bBase}/api/relay/start`, { method: "POST", headers: { origin: bBase, "x-herdr-update": "1" } })).status).toBe(200);
  await bounded(synced.promise);
  const offered = await fetch(`${bBase}/api/relay/offer`, { method: "POST", headers: { origin: bBase, "x-herdr-update": "1" } });
  const { code: _code, ...offer } = decodeOffer((await offered.json() as { url: string }).url)!;
  // B in the account's directory, as the page of any signed-in device reads it
  await service.fetch(new Request(`https://account.test/v1/pcs/${offer.server_id}`, { method: "PUT", headers: { authorization: `Bearer ${token}` },
    body: JSON.stringify({ label: "Desk", public_key: bytesToHex(importPublicKey(offer.server_public_key)), relay: offer.relay }) }));
  const aState = stateDir();
  const aRelayIdentity = options.aIdentity ? rotateRelayIdentity(aState) : undefined;
  const a = createServer({ port: 0, hostname: "127.0.0.1", stateDir: aState, token: "", tailscaleOwner: null, sidecar: false, registerBridge: false, relayPcSocket: local });
  cleanup.push(() => a.stop());
  const aBase = `http://127.0.0.1:${a.port}`;
  /** the member, signed in to B over a session of B's own, that may approve through the relay */
  const approver = async () => {
    const holder = { app: b, closes: [] as (() => void)[], stateDir: bState, close() {} };
    cleanup.push(() => { for (const close of holder.closes) close(); });
    const link = await relayConnection(holder as never, { serverId: offer.server_id });
    await link.auth({ keys, publicKey: memberKey, id: member.id });
    return {
      async decide(id: string, decision: "approve" | "decline", digits?: string): Promise<number> {
        const request = link.open("/api/relay/pairing", { method: "POST", headers: [["content-type", "application/json"], ["x-herdr-machine", "1"]], body: "stream" });
        void request.stream.sendBody(new Response(JSON.stringify({ id, decision, ...(digits === undefined ? {} : { digits }) })).body!).catch(() => {});
        return (await request.response).status;
      },
    };
  };
  /** what A's page would post: an admission naming `key` at B, under this account's sign-in */
  const admit = (key: string, serverId = offer.server_id) => service.fetch(new Request("https://account.test/v1/admissions", {
    method: "POST", headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ server_id: serverId, label: "Ovis on A", key }),
  }));
  const pc = { server_id: offer.server_id, server_public_key: offer.server_public_key, relay: offer.relay, name: "Desk" };
  return { a, aBase, aState, aRelayIdentity, b, bState, member, service, pc, approver, admit };
}

const machineHeaders = (base: string) => ({ origin: base, "x-herdr-machine": "1", "x-herdr-update": "1", "content-type": "application/json" });

function post(base: string, path: string, body: unknown, signal?: AbortSignal): Promise<Response> {
  return fetch(`${base}/api/machines/relay/account/${path}`, { method: "POST", headers: machineHeaders(base), body: JSON.stringify(body), ...(signal ? { signal } : {}) });
}

/** The lines A's pair answer sends, read one at a time. */
function lines(response: Response) {
  const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  return async (): Promise<{ digits?: string; machine?: Machine; error?: { code: string } }> => {
    for (;;) {
      const end = buffer.indexOf("\n");
      if (end >= 0) { const line = buffer.slice(0, end); buffer = buffer.slice(end + 1); return JSON.parse(line); }
      const chunk = await bounded(reader.read(), 30_000);
      if (chunk.done) throw new Error("The pair answer ended");
      buffer += chunk.value;
    }
  };
}

/** The next comparison B shows its account members. */
function remotePrompt(b: ReturnType<typeof createServer>, check: (list: RemotePairingRequest[]) => boolean = (list) => list.length > 0): Promise<RemotePairingRequest[]> {
  const found = deferred<RemotePairingRequest[]>();
  const stop = b.context.services.relay.approvals.subscribeRemote((list) => { if (check(list)) found.resolve(list); });
  return bounded(found.promise, 30_000).finally(stop);
}

const relayKeys = (aState: string): string[] => existsSync(join(aState, "relay-pcs")) ? readdirSync(join(aState, "relay-pcs")) : [];

async function start(base: string, pc: unknown) {
  const response = await post(base, "start", { pc });
  return { status: response.status, body: await response.json() as { ticket: string; key: string; label: string; error?: { code: string } } };
}

it("adds a PC of the account once a member there picked the digits: a plain row on B, the PC in A's list after a restart, and no add anywhere", async () => {
  const { a, aBase, aState, b, bState, member, service, pc, approver, admit } = await accountPcs();
  const checked = await post(aBase, "check", { pcs: [pc] });
  expect(await checked.json()).toEqual({ pcs: [{ server_id: pc.server_id, state: "ready" }] });
  const started = await start(aBase, pc);
  expect(started.status).toBe(200);
  // a key in memory only, until B admits it
  expect(relayKeys(aState)).toEqual([]);
  expect((await admit(started.body.key)).status).toBe(200);
  const member0 = await approver();
  const prompted = remotePrompt(b);
  const next = lines(await post(aBase, "pair", { ticket: started.body.ticket }));
  const { digits } = await next();
  expect(digits).toMatch(/^\d{6}$/);
  const [request] = await prompted;
  // asked of the account's members as "pair this PC", with the digits among three, never on B's own screen
  expect(request).toMatchObject({ intent: "pc", vouched: true, key: started.body.key, label: started.body.label });
  expect(request!.choices).toContain(digits!);
  expect(b.context.services.relay.approvals.list()).toEqual([]);
  expect(await member0.decide(request!.id, "approve", digits)).toBe(200);
  const { machine } = await next();
  expect(machine).toMatchObject({ kind: "relay", name: "Desk", relay: { server_id: pc.server_id } });

  const registry = readDeviceRegistry(join(bState, "devices.json"));
  const row = registry.kind === "ok" ? registry.devices.find((device) => device.relay_public_key === started.body.key) : undefined;
  expect(row).toMatchObject({ role: "drive", added_by: member.id });
  expect(row).not.toHaveProperty("account");
  expect(row).not.toHaveProperty("account_add");
  // nothing was signed for the account: no record waits for B or for any PC, and A never joined it
  expect(service.mailbox(pc.server_id, ACCOUNT)).toEqual([]);
  expect(existsSync(join(aState, "account-pending.json"))).toBe(false);

  // A keeps the PC as any PC added through the relay: in its machine list and on disk, once
  expect(readFileSync(join(aState, "relay-pcs.json"), "utf8")).toContain(machine!.id);
  expect(relayKeys(aState)).toEqual([`${machine!.id}.json`]);
  const listed = await (await fetch(`${aBase}/api/machines`, { headers: { origin: aBase } })).json() as { machines: Machine[] };
  expect(listed.machines.some((m) => m.id === machine!.id && m.kind === "relay")).toBe(true);
  expect((await start(aBase, pc)).body.error?.code).toBe("account_pc_added");
  a.stop();
  const again = createServer({ port: 0, hostname: "127.0.0.1", stateDir: aState, token: "", tailscaleOwner: null, sidecar: false, registerBridge: false });
  cleanup.push(() => again.stop());
  const restarted = await (await fetch(`http://127.0.0.1:${again.port}/api/machines`, { headers: { origin: `http://127.0.0.1:${again.port}` } })).json() as { machines: Machine[] };
  expect(restarted.machines.some((m) => m.id === machine!.id && m.kind === "relay")).toBe(true);
}, 60_000);

it("adds nothing when the member declines, or picks other digits", async () => {
  for (const answer of ["decline", "wrong"] as const) {
    const { aBase, aState, b, bState, pc, approver, admit } = await accountPcs();
    const started = await start(aBase, pc);
    await admit(started.body.key);
    const member = await approver();
    const prompted = remotePrompt(b);
    const next = lines(await post(aBase, "pair", { ticket: started.body.ticket }));
    const { digits } = await next();
    const [request] = await prompted;
    const decoy = request!.choices.find((choice) => choice !== digits)!;
    await member.decide(request!.id, answer === "decline" ? "decline" : "approve", answer === "decline" ? undefined : decoy);
    expect((await next()).error?.code).toBe("account_pc_declined");
    const registry = readDeviceRegistry(join(bState, "devices.json"));
    expect(registry.kind === "ok" && registry.devices.some((device) => device.relay_public_key === started.body.key)).toBe(false);
    expect(relayKeys(aState)).toEqual([]);
    expect(existsSync(join(aState, "relay-pcs.json"))).toBe(false);
  }
}, 120_000);

it("is refused before any prompt without an admission, with a stale one, or with one for another key", async () => {
  for (const kind of ["none", "stale", "other key"] as const) {
    const late = kind === "stale";
    const { aBase, aState, b, pc, admit } = await accountPcs(late ? { clock: () => Date.now() - 11 * 60_000 } : {});
    const started = await start(aBase, pc);
    if (kind === "stale") await admit(started.body.key);
    if (kind === "other key") {
      const other = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
      await admit(Buffer.from(await crypto.subtle.exportKey("spki", other.publicKey)).toString("base64url"));
    }
    let prompted = false;
    const stop = b.context.services.relay.approvals.subscribeRemote((list) => { if (list.length > 0) prompted = true; });
    const answer = await lines(await post(aBase, "pair", { ticket: started.body.ticket }))();
    stop();
    expect([kind, answer.error?.code, answer.digits]).toEqual([kind, "account_pc_refused", undefined]);
    expect(prompted).toBe(false);
    expect(relayKeys(aState)).toEqual([]);
    // no person was asked: nothing counted against B's pairings by these PCs
    expect(() => b.context.services.devices.assertRelayPairing("vouched")).not.toThrow();
  }
}, 120_000);

it("cancelling while it waits ends the comparison on B and keeps nothing on A", async () => {
  const { aBase, aState, b, pc, admit } = await accountPcs();
  const started = await start(aBase, pc);
  await admit(started.body.key);
  const prompted = remotePrompt(b);
  const abort = new AbortController();
  const next = lines(await post(aBase, "pair", { ticket: started.body.ticket }, abort.signal));
  await next();
  await prompted;
  const withdrawn = remotePrompt(b, (list) => list.length === 0);
  abort.abort();
  await withdrawn;
  const listed = await (await fetch(`${aBase}/api/machines`, { headers: { origin: aBase } })).json() as { machines: Machine[] };
  expect(listed.machines.some((machine) => machine.kind === "relay")).toBe(false);
  expect(relayKeys(aState)).toEqual([]);
  // a ticket is good for one comparison
  expect((await lines(await post(aBase, "pair", { ticket: started.body.ticket }))()).error?.code).toBe("account_pc_gone");
}, 60_000);

it("adds a PC on an Add right after a cancelled one: the key that PC was asked for, still admitted there, is asked for again", async () => {
  const { aBase, aState, b, pc, approver, admit } = await accountPcs();
  const first = await start(aBase, pc);
  await admit(first.body.key);
  const prompted = remotePrompt(b);
  const abort = new AbortController();
  const cancelled = lines(await post(aBase, "pair", { ticket: first.body.ticket }, abort.signal));
  await cancelled();
  await prompted;
  const withdrawn = remotePrompt(b, (list) => list.length === 0);
  abort.abort();
  await withdrawn;
  // at once: well within the 10 s that PC waits between two reads of the account's admissions
  const again = await start(aBase, pc);
  expect(again.status).toBe(200);
  expect((await admit(again.body.key)).status).toBe(200);
  const member = await approver();
  const promptedAgain = remotePrompt(b);
  const next = lines(await post(aBase, "pair", { ticket: again.body.ticket }));
  const { digits, error } = await next();
  expect(error).toBeUndefined();
  const [request] = await promptedAgain;
  expect(await member.decide(request!.id, "approve", digits)).toBe(200);
  const { machine } = await next();
  expect(machine).toMatchObject({ kind: "relay", relay: { server_id: pc.server_id } });
  // the same key, under a ticket of its own: the first ticket was spent on the cancelled comparison
  expect(again.body.key).toBe(first.body.key);
  expect(again.body.ticket).not.toBe(first.body.ticket);
  expect(relayKeys(aState)).toEqual([`${machine!.id}.json`]);
}, 60_000);

it("asks a PC once when two windows add it together: the second is told it is being added", async () => {
  const { aBase, b, pc, admit } = await accountPcs();
  const one = await start(aBase, pc);
  const two = await start(aBase, pc);
  await admit(one.body.key);
  await admit(two.body.key);
  const prompted = remotePrompt(b);
  const first = lines(await post(aBase, "pair", { ticket: one.body.ticket }));
  expect((await first()).digits).toMatch(/^\d{6}$/);
  await prompted;
  expect((await lines(await post(aBase, "pair", { ticket: two.body.ticket }))()).error?.code).toBe("account_pc_busy");
  expect(b.context.services.relay.approvals.remoteList()).toHaveLength(1);
}, 60_000);

/** Every PC's sessions from here on read HELLO as an older Ovis does, knowing no pair-intent-pc-vouched; the frames they were sent. */
function olderB(): number[] {
  const admit = Object.getOwnPropertyDescriptor(RelaySession.prototype, "admit")!.value as (this: RelaySession, frame: SessionFrame) => Promise<void>;
  const asked: number[] = [];
  Object.defineProperty(RelaySession.prototype, "admit", { configurable: true, writable: true, value(this: RelaySession, frame: SessionFrame) {
    asked.push(frame.type);
    if (frame.type !== FrameType.HELLO) return admit.call(this, frame);
    return admit.call(this, { ...frame, payload: { ...frame.payload, features: frame.payload.features.filter((feature) => feature !== PAIR_INTENT_VOUCHED) } });
  } });
  cleanup.push(() => { Object.defineProperty(RelaySession.prototype, "admit", { configurable: true, writable: true, value: admit }); });
  return asked;
}

it("reports an older PC as outdated and sends it nothing to pair", async () => {
  const { aBase, aState, b, pc } = await accountPcs();
  const asked = olderB();
  expect(await (await post(aBase, "check", { pcs: [pc] })).json()).toEqual({ pcs: [{ server_id: pc.server_id, state: "outdated" }] });
  const started = await start(aBase, pc);
  expect([started.status, started.body.error?.code]).toEqual([409, "account_pc_outdated"]);
  expect(asked).not.toContain(FrameType.PAIR_REQUEST);
  expect(asked).not.toContain(FrameType.PAIR);
  expect(b.context.services.relay.approvals.remoteList()).toEqual([]);
  expect(relayKeys(aState)).toEqual([]);
}, 60_000);

it("refuses a PC whose ID is not the one its key gives, or whose relay is not a wss: origin", async () => {
  const { aBase, pc } = await accountPcs();
  expect((await start(aBase, { ...pc, server_id: "0".repeat(32) })).body.error?.code).toBe("account_pc_invalid");
  expect((await post(aBase, "check", { pcs: [{ ...pc, relay: "https://relay.example" }] })).status).toBe(400);
}, 60_000);

it("sends nothing to pair to a PC that runs an older Ovis by the time it is asked, even after it took the start", async () => {
  const { aBase, aState, b, pc, admit } = await accountPcs();
  const started = await start(aBase, pc);
  expect(started.status).toBe(200);
  await admit(started.body.key);
  const asked = olderB();
  expect((await lines(await post(aBase, "pair", { ticket: started.body.ticket }))()).error?.code).toBe("account_pc_outdated");
  expect(asked).toContain(FrameType.HELLO);
  expect(asked).not.toContain(FrameType.PAIR_REQUEST);
  expect(b.context.services.relay.approvals.list()).toEqual([]);
  expect(b.context.services.relay.approvals.remoteList()).toEqual([]);
  expect(relayKeys(aState)).toEqual([]);
}, 60_000);

it("takes a ticket for ten minutes only", async () => {
  const { aBase, b, pc, admit } = await accountPcs();
  const started = await start(aBase, pc);
  await admit(started.body.key);
  const now = performance.now.bind(performance);
  const later = spyOn(performance, "now").mockImplementation(() => now() + 11 * 60_000);
  let answer: Awaited<ReturnType<ReturnType<typeof lines>>>;
  try { answer = await lines(await post(aBase, "pair", { ticket: started.body.ticket }))(); }
  finally { later.mockRestore(); }
  expect(answer.error?.code).toBe("account_pc_gone");
  expect(b.context.services.relay.approvals.remoteList()).toEqual([]);
}, 60_000);

it("writes the key it made for a PC only while that PC's comparison runs, or once that PC is added", async () => {
  const { a, aBase, aState, pc } = await accountPcs();
  const started = await start(aBase, pc);
  const held = (a.context.services.core.machines as unknown as { accountPcTickets: Map<string, { key: RelayPcKey }> }).accountPcTickets.get(started.body.ticket)!;
  // admitted, as far as the key can tell, by no comparison of this PC's: it must not reach the disk
  await expect(held.key.update(pc.server_id, (current) => ({ ...(current ?? { server_id: pc.server_id, server_public_key: pc.server_public_key, relay: pc.relay, label: "x", public_spki: started.body.key, private_key: undefined as unknown as CryptoKey, device_id: null }), device_id: "0011223344556677" }))).rejects.toThrow("removed");
  expect(relayKeys(aState)).toEqual([]);
}, 60_000);

it("refuses to pair this PC with itself", async () => {
  const { aBase, aRelayIdentity, pc } = await accountPcs({ aIdentity: true });
  const self = { ...pc, server_id: aRelayIdentity!.server_id, server_public_key: aRelayIdentity!.public_key, name: "This PC" };
  const started = await start(aBase, self);
  expect([started.status, started.body.error?.code]).toEqual([409, "account_pc_self"]);
}, 60_000);
