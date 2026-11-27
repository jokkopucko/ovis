/**
 * Adding this PC to an account in one press (docs/account.md, "One press"): POST /api/account/one-press binds a PC in
 * no account to the account its local owner is signed in to, on the account service's word for that account alone.
 * Conditions of security-triage: only the PC's owner here names the account, the PC's named account and the service's
 * answer must both be it, and nothing is bound otherwise.
 */
import { afterEach, expect, jest, spyOn, test } from "bun:test";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bytesToHex } from "@noble/hashes/utils.js";
import { accountDeviceId, exportAccountKey, newRecordId, signAccountRecord, signSafetyRecord } from "../../shared/account-records.ts";
import { channelBinding, importPublicKey } from "../../shared/relay-e2ee.ts";
import { fromBase64Url, pairCommitment, pairDigits, randomPairNonce, toBase64Url } from "../../shared/relay-pair-sas.ts";
import { handleRequest, type ServerContext } from "../dispatch.ts";
import { createServer } from "../index.ts";
import { ask, firstPairingRead, linkRecord, memberRow, pairingPc, phone, provingDevice, sendLink, setUpFor, signedInWith, vouchFor, type Pc, type Phone } from "./pairing.test-helpers.ts";
import { bounded, relayConnection, TestClock } from "../relay/test-helpers.ts";
import { ACCOUNT_OPENS_ALL_FEATURE, FrameType, PAIR_INTENT_ACCOUNT, PAIR_SAS_FEATURE } from "../../shared/relay-mux.ts";
import { STALE_READ_MS } from "./account-devices.ts";
import { privateStateFs } from "../private-state.ts";
import { JOIN_HOLD_MS } from "./join-hold.ts";
import { pressOnce } from "./one-press.ts";

const pcs: Pc[] = [];
afterEach(async () => { for (const pc of pcs.splice(0)) await pc.close(); });

async function pc(options: Parameters<typeof pairingPc>[0] = {}): Promise<Pc> {
  const made = await pairingPc({ ...options, server: { accountOpensAll: true, ...options.server } });
  made.account.opensAll = true;
  // as the account service is: each listing has an ID, and an admission names its listing
  made.account.completions = true;
  pcs.push(made);
  return made;
}

/** What the owner's signed-in browser does first: lists this PC in `account` and admits it in one press (S1). */
async function admitAt(f: Pc, account: string, twoStep: boolean | null = true): Promise<void> {
  const identity = f.app.context.services.relay.currentIdentity();
  if (!identity) throw new Error("The PC has no relay identity");
  const token = f.account.issueToken(account, { twoStep });
  const call = (path: string, method: string, body: unknown) =>
    f.account.fetch(new Request(`https://account.test${path}`, { method, headers: { authorization: `Bearer ${token}` }, body: JSON.stringify(body) }));
  const listed = await call(`/v1/pcs/${identity.server_id}`, "PUT", { label: "PC", public_key: bytesToHex(importPublicKey(identity.public_key)), relay: "wss://relay.ovis.sh" });
  if (!listed.ok) throw new Error(`The PC was not listed: ${listed.status} ${await listed.text()}`);
  const admitted = await call(`/v1/pcs/${identity.server_id}/admit`, "POST", {});
  if (!admitted.ok) throw new Error(`The PC was not admitted: ${admitted.status} ${await admitted.text()}`);
}

const press = (f: Pc, account: string) => f.local("/api/account/one-press", { method: "POST", headers: { "x-herdr-machine": "1" }, body: { account } });

async function firstPcWithPhone(f: Pc, twoStep: boolean | null = null) {
  const clock = new TestClock();
  f.devices.useClock(clock);
  await setUpFor(f, "acct_1");
  await admitAt(f, "acct_1", twoStep);
  expect((await press(f, "acct_1")).status).toBe(200);
  const token = f.account.issueToken("acct_1");
  const key = await phone();
  f.account.registerSessionKey(token, key.spki, "Phone");
  expect(await f.app.context.services.accountMailbox.readSnapshot()).toMatchObject({ committed: true });
  const identity = f.app.context.services.relay.currentIdentity()!;
  const serverId = identity.server_id;
  const id = accountDeviceId(serverId, key.spki);
  const future = Date.now() + JOIN_HOLD_MS + 1;
  const time = spyOn(Date, "now").mockImplementation(() => future);
  f.closes.push(() => time.mockRestore());
  const device = { id, keys: key.keys, publicKey: key.spki };
  expect(f.devices.sessionRow(id)?.role).toBe("drive");
  expect(f.stored().some(row => row.relay_public_key === key.spki)).toBe(false);
  const url = `https://account.test/v1/pcs/${serverId}`;
  const headers = { authorization: `Bearer ${token}` };
  return { device, serverId, clock, token,
    remove: async () => { expect((await f.account.fetch(new Request(url, { method: "DELETE", headers }))).status).toBe(204); },
    relist: async () => {
      const answer = await f.account.fetch(new Request(url, { method: "PUT", headers, body: JSON.stringify({
        label: "PC", public_key: bytesToHex(importPublicKey(identity.public_key)), relay: "wss://relay.test",
      }) }));
      expect(answer.status).toBe(200);
      const { pc: listed } = await answer.json();
      expect(listed.server_id).toBe(serverId);
      expect(listed.admitted_at ?? null).toBeNull();
      expect(listed.completed_at ?? null).toBeNull();
    },
  };
}

test("removed PC: not_listed closes the open account session and keeps the local pairing", async () => {
  let refusal: unknown;
  const f = await pc({ accountFetch: async (request, service) => {
    const response = await service.fetch(request);
    if (new URL(request.url).pathname === "/v1/pc/snapshot" && response.status === 403) refusal = await response.clone().json();
    return response;
  } });
  const { device, serverId, remove } = await firstPcWithPhone(f);
  const local = await phone();
  const paired = f.devices.pairRelay(f.devices.startPairing().code, "Local", local.spki)!.device;
  using audit = spyOn(console, "info").mockImplementation(() => {});
  const link = await relayConnection(f, { serverId });
  expect(await link.auth(device)).toMatchObject({ role: "drive" });
  const second = await relayConnection(f, { serverId });
  expect(await second.auth(device)).toMatchObject({ role: "drive" });
  await remove();
  await f.app.context.services.accountMailbox.readSnapshot();
  expect(refusal).toMatchObject({ error: { code: "not_listed" } });
  expect(await bounded(link.serverError, 2000)).toBe("auth_revoked");
  await bounded(Promise.all([link.closed, second.closed]), 2000);
  expect(f.devices.serviceBinding()).toBeNull();
  expect(f.devices.sessionRow(device.id)).toBeNull();
  const next = await relayConnection(f, { serverId });
  await expect(next.auth(device)).rejects.toThrow("Relay closed before admission");
  expect(await next.serverError).toBe("auth_failed");
  const own = await relayConnection(f, { serverId });
  expect(await own.auth({ id: paired.id, keys: local.keys, publicKey: local.spki })).toMatchObject({ role: paired.role });
  const time = expect.any(String);
  expect(audit.mock.calls.map(([line]) => JSON.parse(line))).toEqual(expect.arrayContaining([
    { time, event: "relay.session.accepted", role: "drive", origin: "account", device_no: expect.any(Number) },
    { time, event: "relay.session.closed", reason: "auth_revoked" },
    { time, event: "account.snapshot.refused", status: 403, reason: "not_listed" },
    { time, event: "account.binding.cleared", reason: "unlisted" },
    { time, event: "account.sessions.closed", count: 2 },
    { time, event: "relay.session.accepted", role: paired.role, origin: "local-pairing", device_no: expect.any(Number) },
  ]));
});

test("removed PC: an idle PC learns of removal at the five-minute poll", async () => {
  jest.useFakeTimers();
  try {
    const f = await pc();
    const { remove } = await firstPcWithPhone(f);
    await remove();
    jest.advanceTimersByTime(5 * 60_000);
    jest.useRealTimers();
    // Join the serialized mailbox turn, without asking for another snapshot.
    await f.app.context.services.accountMailbox.settle();
    expect(f.devices.account()).toBeNull();
  } finally { jest.useRealTimers(); }
});

test("removed PC: a grant after the last answer lapsed waits for the service, not the next periodic poll", async () => {
  let validating = false;
  const asked = Promise.withResolvers<void>();
  const resume = Promise.withResolvers<void>();
  const f = await pc({ accountFetch: async (request, service) => {
    if (validating) { asked.resolve(); await resume.promise; }
    return service.fetch(request);
  } });
  const { device, serverId, remove, clock } = await firstPcWithPhone(f);
  clock.advance(LISTING_CONFIRMED_MS);
  const next = await relayConnection(f, { serverId });
  validating = true;
  const verdict = next.auth(device).then(() => "admitted", () => next.serverError);
  try {
    expect(await bounded(Promise.race([asked.promise.then(() => "checking"), verdict]))).toBe("checking");
    await remove();
  } finally { resume.resolve(); }
  expect(await bounded(verdict)).toBe("auth_failed");
});

const ACCOUNT_LISTING_ERRORS = "account-listing-errors-1";
const LISTING_CONFIRMED_MS = 60_000;
const listingFeatures = [ACCOUNT_LISTING_ERRORS];
const completionChecks = (f: Pc) => f.account.requests.filter(path => path === "POST /v1/pc/complete").length;
/** One sign-in of an account device on a connection of its own: "admitted", or the code the PC ended it with. */
async function signIn(f: Parameters<typeof relayConnection>[0], serverId: string, device: Parameters<Awaited<ReturnType<typeof relayConnection>>["auth"]>[0],
  features: readonly string[] = listingFeatures, required: readonly string[] = []): Promise<string> {
  const link = await relayConnection(f, { serverId });
  return link.auth(device, features, required).then(() => "admitted", () => bounded(link.serverError));
}
/** The same as a signed-in app opens a PC of its account: the PC must take account sign-ins at all. */
const accountOpen = (f: Parameters<typeof relayConnection>[0], serverId: string, device: Parameters<typeof signIn>[2], features: readonly string[] = listingFeatures) =>
  signIn(f, serverId, device, [ACCOUNT_OPENS_ALL_FEATURE, ...features], [ACCOUNT_OPENS_ALL_FEATURE]);
const lastClear = (stateDir: string) => JSON.parse(readFileSync(join(stateDir, "account-pc.json"), "utf8")).clears.at(-1);

test("listing confirmation: an outage says so, clears nothing and cannot interrupt a local pairing", async () => {
  let offline = false;
  const f = await pc({ accountFetch: async (req, svc) => offline ? new Response(null, { status: 503 }) : svc.fetch(req) });
  const { device, serverId, clock } = await firstPcWithPhone(f);
  const local = await phone();
  const paired = f.devices.pairRelay(f.devices.startPairing().code, "Local", local.spki)!.device;
  const binding = f.devices.serviceBinding();
  clock.advance(LISTING_CONFIRMED_MS);
  offline = true;
  using audit = spyOn(console, "info").mockImplementation(() => {});
  expect(await signIn(f, serverId, { id: paired.id, keys: local.keys, publicKey: local.spki }, [])).toBe("admitted");
  // An app from before the two codes would forget its key over auth_failed: an outage is no word against the key.
  expect(await signIn(f, serverId, device, [])).toBe("internal_error");
  expect(await signIn(f, serverId, device)).toBe("account_unreachable");
  expect(audit.mock.calls.map(([line]) => JSON.parse(line)).filter(line => line.event === "relay.session.closed").map(line => line.reason))
    .toEqual(["account_unreachable", "account_unreachable"]);
  expect(f.devices.serviceBinding()).toBe(binding);
  expect(f.devices.sessionRow(device.id)?.role).toBe("drive");
  offline = false;
  expect(await signIn(f, serverId, device)).toBe("admitted");
});

test("listing confirmation: an account service that does not answer is an outage before the device's own 10 seconds run out", async () => {
  const asked = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let hung = false;
  const f = await pc({ accountFetch: async (req, svc) => {
    if (hung) { asked.resolve(); await release.promise; }
    return svc.fetch(req);
  } });
  const { device, serverId, clock } = await firstPcWithPhone(f);
  clock.advance(LISTING_CONFIRMED_MS);
  hung = true;
  const session = new TestClock();
  const link = await relayConnection(f, { serverId, clock: session });
  const verdict = link.auth(device, listingFeatures).then(() => "admitted", () => bounded(link.serverError));
  try {
    await bounded(asked.promise);
    session.advance(3_999);
    expect(await Promise.race([verdict, Promise.resolve("waiting")])).toBe("waiting");
    session.advance(1);
    expect(await verdict).toBe("account_unreachable");
  } finally { hung = false; release.resolve(); }
  expect(f.devices.serviceBinding()).not.toBeNull();
});

test("listing confirmation: a reconnect burst shares one check until exactly 60 monotonic seconds", async () => {
  const f = await pc();
  const { device, serverId, clock } = await firstPcWithPhone(f);
  clock.advance(LISTING_CONFIRMED_MS);
  const start = completionChecks(f);
  await Promise.all([signIn(f, serverId, device), signIn(f, serverId, device), signIn(f, serverId, device)]);
  expect(completionChecks(f) - start).toBe(1);
  clock.advance(LISTING_CONFIRMED_MS - 1);
  expect(await signIn(f, serverId, device)).toBe("admitted");
  expect(completionChecks(f) - start).toBe(1);
  clock.advance(1);
  expect(await signIn(f, serverId, device)).toBe("admitted");
  expect(completionChecks(f) - start).toBe(2);
});

test("listing confirmation: neither an outage, a failed check nor a clock set back stretches a positive answer", async () => {
  let offline = false;
  const f = await pc({ accountFetch: async (req, svc) => offline ? new Response(null, { status: 503 }) : svc.fetch(req) });
  const { device, serverId, clock } = await firstPcWithPhone(f);
  clock.advance(LISTING_CONFIRMED_MS);
  expect(await signIn(f, serverId, device)).toBe("admitted");
  offline = true;
  clock.advance(LISTING_CONFIRMED_MS - 1);
  expect(await signIn(f, serverId, device)).toBe("admitted");
  clock.advance(1);
  expect(await signIn(f, serverId, device)).toBe("account_unreachable");
  expect(await signIn(f, serverId, device)).toBe("account_unreachable");
  offline = false;
  const start = completionChecks(f);
  expect(await signIn(f, serverId, device)).toBe("admitted");
  expect(completionChecks(f) - start).toBe(1);
  const wall = Date.now();
  const time = spyOn(Date, "now");
  time.mockImplementation(() => wall - 1);
  expect(await signIn(f, serverId, device)).toBe("admitted");
  expect(completionChecks(f) - start).toBe(2);
  // a sleep the monotonic clock did not count: only the wall clock moved
  time.mockImplementation(() => wall + LISTING_CONFIRMED_MS);
  expect(await signIn(f, serverId, device)).toBe("admitted");
  expect(completionChecks(f) - start).toBe(3);
});

test.each(["unbind", "listing_changed", "identity_reset"] as const)("listing confirmation: %s supersedes a warm grant", async why => {
  const f = await pc();
  const { device, serverId, remove, relist } = await firstPcWithPhone(f);
  expect(await signIn(f, serverId, device)).toBe("admitted");
  if (why === "unbind") f.devices.clearAccountBinding("unlisted", "account");
  else if (why === "identity_reset") await f.app.context.services.relay.resetIdentity();
  else {
    await remove();
    await relist();
    await f.app.context.services.accountMailbox.readSnapshot();
  }
  expect(f.devices.serviceBinding()).toBeNull();
  expect(await signIn(f, serverId, device)).toBe(why === "identity_reset" ? "auth_failed" : "account_readd_required");
});

test("listing confirmation: a removal the PC has not read ends the account's sessions at the first sign-in after the 60 seconds", async () => {
  const f = await pc();
  const { device, serverId, remove, relist, clock } = await firstPcWithPhone(f);
  clock.advance(LISTING_CONFIRMED_MS);
  const open = await relayConnection(f, { serverId });
  expect(await open.auth(device, listingFeatures)).toMatchObject({ role: "drive" });
  await remove();
  await relist();
  clock.advance(LISTING_CONFIRMED_MS - 1);
  const within = await relayConnection(f, { serverId });
  expect(await within.auth(device, listingFeatures)).toMatchObject({ role: "drive" });
  clock.advance(1);
  expect(await signIn(f, serverId, device)).toBe("account_readd_required");
  expect(f.devices.serviceBinding()).toBeNull();
  expect(lastClear(f.stateDir)).toMatchObject({ reason: "unlisted", by: "account" });
  // removed by the account: its device keeps its key and is told to add the PC again, as the account's sign-in is
  expect(await accountOpen(f, serverId, device)).toBe("account_readd_required");
  expect(await bounded(open.serverError, 2000)).toBe("auth_revoked");
  await bounded(Promise.all([open.closed, within.closed]), 2000);
});

const restarted: (() => Promise<void>)[] = [];
afterEach(async () => { for (const end of restarted.splice(0)) await end(); });
const bindingOf = (stateDir: string) => JSON.parse(readFileSync(join(stateDir, "account-pc.json"), "utf8")).binding;

/**
 * The PC stopped, and started again from a copy of its state folder. `legacy`: its binding names no listing, as every
 * binding made before 0.5.10. `receipt`: the completion receipt of its bind was never taken.
 */
async function restartedFrom(f: Pc, options: { legacy?: boolean; receipt?: boolean; pull?: boolean; fetch?: (request: Request) => Promise<Response>; edit?: (state: { clears: Record<string, unknown>[] }) => void } = {}) {
  await f.app.stop();
  const stateDir = mkdtempSync(join(tmpdir(), "ovis-upgrade-listing-"));
  cpSync(f.stateDir, stateDir, { recursive: true });
  const path = join(stateDir, "account-pc.json");
  const state = JSON.parse(readFileSync(path, "utf8"));
  const { listing_id: listing, ...binding } = state.binding ?? {};
  if (options.legacy) writeFileSync(path, JSON.stringify({ ...state, binding }));
  if (options.edit) { options.edit(state); writeFileSync(path, JSON.stringify(state)); }
  if (options.receipt) writeFileSync(join(stateDir, "account-completion.json"), JSON.stringify({ account: binding.account, listing_id: listing }));
  const app = createServer({ stateDir, port: 0, hostname: "127.0.0.1", token: "", tailscaleOwner: null, registerBridge: false, sidecar: false,
    accountOpensAll: true, accountService: { url: "https://account.test", fetch: options.fetch ?? f.account.fetch } });
  const closes: (() => void)[] = [];
  restarted.push(async () => { for (const end of closes) end(); await app.stop(); rmSync(stateDir, { recursive: true, force: true }); });
  if (options.pull !== false) await app.context.services.accountMailbox.pull();
  return { stateDir, app, closes, close() {}, devices: app.context.services.devices, listing: listing as string, bindId: binding.bind_id as string };
}
/** The PC as an update finds it. */
const updated = (f: Pc, options: Omit<NonNullable<Parameters<typeof restartedFrom>[1]>, "legacy"> = {}) => restartedFrom(f, { ...options, legacy: true });
const pathOf = (request: Request) => new URL(request.url).pathname;

test("upgrade: a binding without a listing ID pins the listing of its kept completion receipt", async () => {
  const f = await pc();
  const { device, serverId } = await firstPcWithPhone(f);
  const now = await updated(f, { receipt: true });
  expect(bindingOf(now.stateDir)).toMatchObject({ bind_id: now.bindId, listing_id: now.listing });
  expect(await signIn(now, serverId, device)).toBe("admitted");
});

test("upgrade: a kept completion receipt is not spent by a pull whose read failed, and pins at the next", async () => {
  const f = await pc();
  const { device, serverId } = await firstPcWithPhone(f);
  let down = true;
  const now = await updated(f, { receipt: true, fetch: async req => down && pathOf(req) === "/v1/pc/snapshot" ? new Response(null, { status: 503 }) : f.account.fetch(req) });
  expect(bindingOf(now.stateDir)).toEqual({ account: "acct_1", bind_id: now.bindId, service: true });
  down = false;
  await now.app.context.services.accountMailbox.pull();
  expect(bindingOf(now.stateDir)).toMatchObject({ bind_id: now.bindId, listing_id: now.listing });
  expect(await signIn(now, serverId, device)).toBe("admitted");
});

test.each([
  // the account removed the PC and a device listed it again with no press at the PC: the listing stands on no admission it took
  [false],
  // the receipt names the listing the account removed: the relisting is another
  [true],
] as const)("upgrade: with a relisted listing and no receipt the service confirms (receipt kept: %p) the PC leaves the account and says to add it again", async (receipt) => {
  const f = await pc();
  const { device, serverId, remove, relist } = await firstPcWithPhone(f);
  const local = await phone();
  const paired = f.devices.pairRelay(f.devices.startPairing().code, "Local", local.spki)!.device;
  await remove();
  await relist();
  const completions = completionChecks(f);
  const admissions = () => f.account.requests.filter(path => path === "POST /v1/pc/admission").length;
  const taken = admissions();
  const now = await updated(f, { receipt });
  expect(admissions()).toBe(taken);
  expect(bindingOf(now.stateDir)).toBeNull();
  expect(now.devices.account()).toBeNull();
  // A listing some device wrote since is never completed on this PC's own word.
  expect(completionChecks(f) - completions).toBe(receipt ? 1 : 0);
  expect(now.devices.sessionRow(device.id)).toBeNull();
  expect(await signIn(now, serverId, device)).toBe("account_readd_required");
  expect(await signIn(now, serverId, { id: paired.id, keys: local.keys, publicKey: local.spki }, [])).toBe("admitted");
  expect(await accountOpen(now, serverId, device)).toBe("account_readd_required");
  expect(await accountOpen(now, serverId, device, [])).toBe("unsupported_extension");
  // why this PC left its account is said only to a key it knew, once proved
  const stranger = await phone();
  expect(await accountOpen(now, serverId, { id: accountDeviceId(serverId, stranger.spki), keys: stranger.keys, publicKey: stranger.spki })).toBe("auth_failed");
  expect(await accountOpen(now, serverId, { ...device, keys: stranger.keys })).toBe("auth_failed");
  await admitAt(f, "acct_1");
  expect(await pressOnce(now.app.context.services, "acct_1")).toEqual({ account: "acct_1" });
  expect(bindingOf(now.stateDir)).toMatchObject({ account: "acct_1", service: true, listing_id: expect.stringMatching(/^[0-9a-f]{32}$/) });
  expect(bindingOf(now.stateDir).listing_id).not.toBe(now.listing);
  expect(await accountOpen(now, serverId, device)).toBe("held");
  const held = Date.now();
  spyOn(Date, "now").mockImplementation(() => held + JOIN_HOLD_MS + 1);
  expect(await accountOpen(now, serverId, device)).toBe("admitted");
});

test.each([
  ["an outage", () => new Response(null, { status: 503 })],
  ["a hidden 404", () => Response.json({ error: { code: "not_found", message: "Unknown request" } }, { status: 404 })],
  ["a 409 that names no changed listing", () => Response.json({ error: { code: "try_again", message: "Send it again" } }, { status: 409 })],
  ["a success with no completion time", () => Response.json({})],
] as const)("upgrade: %s for the kept receipt clears no binding, and it pins once the service confirms it", async (_case, answer) => {
  const f = await pc();
  const { device, serverId } = await firstPcWithPhone(f);
  let failing = true;
  const now = await updated(f, { receipt: true, fetch: async req => failing && pathOf(req) === "/v1/pc/complete" ? answer() : f.account.fetch(req) });
  expect(await signIn(now, serverId, device)).toBe("account_unreachable");
  expect(bindingOf(now.stateDir)).toEqual({ account: "acct_1", bind_id: now.bindId, service: true });
  failing = false;
  await now.app.context.services.accountMailbox.pull();
  expect(bindingOf(now.stateDir)).toMatchObject({ bind_id: now.bindId, listing_id: now.listing });
  expect(await signIn(now, serverId, device)).toBe("admitted");
});

test("upgrade: with the account service down, a binding with nothing to ask about is kept until the service answers", async () => {
  const f = await pc();
  const { device, serverId } = await firstPcWithPhone(f);
  let down = true;
  const now = await updated(f, { fetch: async req => down ? new Response(null, { status: 503 }) : f.account.fetch(req) });
  expect(await signIn(now, serverId, device)).toBe("account_unreachable");
  expect(bindingOf(now.stateDir)).toEqual({ account: "acct_1", bind_id: now.bindId, service: true });
  down = false;
  await now.app.context.services.accountMailbox.pull();
  expect(bindingOf(now.stateDir)).toMatchObject({ bind_id: now.bindId, listing_id: now.listing });
  expect(await signIn(now, serverId, device)).toBe("admitted");
});

const clearsOf = (stateDir: string) => JSON.parse(readFileSync(join(stateDir, "account-pc.json"), "utf8")).clears as unknown[];

test.each([
  ["a sign-in with no two-step, on an account never used before", null],
  ["a two-step sign-in", true],
] as const)("upgrade: a PC its account added in one press (%s) stays in the account with no add: its binding pins the listing the service says it admitted", async (_case, twoStep) => {
  const f = await pc();
  const { device, serverId } = await firstPcWithPhone(f, twoStep);
  const local = await phone();
  const paired = f.devices.pairRelay(f.devices.startPairing().code, "Local", local.spki)!.device;
  const mine = { id: paired.id, keys: local.keys, publicKey: local.spki };
  using audit = spyOn(console, "info").mockImplementation(() => {});
  // the update: the new code starts on the binding 0.5.9 wrote, which names no listing, with no receipt kept
  const now = await updated(f, { pull: false });
  expect(bindingOf(now.stateDir)).toEqual({ account: "acct_1", bind_id: now.bindId, service: true });
  // the first pull
  await now.app.context.services.accountMailbox.pull();
  expect(bindingOf(now.stateDir)).toEqual({ account: "acct_1", bind_id: now.bindId, service: true, listing_id: now.listing });
  const pairedSession = await relayConnection(now, { serverId });
  expect(await pairedSession.auth(mine)).toMatchObject({ role: "drive" });
  const accountSession = await relayConnection(now, { serverId });
  expect(await accountSession.auth(device, listingFeatures)).toMatchObject({ role: "drive" });
  // and the pulls after it: both stay in, on the sessions they have
  await now.app.context.services.accountMailbox.pull();
  await now.app.context.services.accountMailbox.pull();
  const status = (await ask(pairedSession, "/api/account/status")).body as { account?: unknown; pc_add_required?: unknown };
  expect([status.account, status.pc_add_required]).toEqual(["acct_1", undefined]);
  expect((await ask(accountSession, "/api/devices")).status).toBe(200);
  expect(clearsOf(now.stateDir)).toEqual(clearsOf(f.stateDir));
  expect(audit.mock.calls.map(call => String(call[0])).filter(line => line.includes("account.binding.cleared") || line.includes("account_readd_required"))).toEqual([]);
  // after another start it asks about the listing it pinned, as any binding made since
  const again = await restartedFrom({ ...f, stateDir: now.stateDir, app: now.app } as Pc);
  expect(bindingOf(again.stateDir)).toMatchObject({ bind_id: now.bindId, listing_id: now.listing });
  expect(await signIn(again, serverId, device)).toBe("admitted");
  expect(await signIn(again, serverId, mine, [])).toBe("admitted");
});

const mailboxSaying = (f: Pc, change: (body: Record<string, unknown>) => Record<string, unknown> | Response) => async (req: Request): Promise<Response> => {
  const answer = await f.account.fetch(req);
  if (pathOf(req) !== "/v1/pc/mailbox" || !answer.ok) return answer;
  const changed = change(await answer.json() as Record<string, unknown>);
  return changed instanceof Response ? changed : Response.json(changed);
};

test.each([
  ["an account service from before the field, which omits it", (body: Record<string, unknown>) => { const { listing_admitted: _said, ...old } = body; return old; }],
  ["a field that is no yes or no", (body: Record<string, unknown>) => ({ ...body, listing_admitted: "true" })],
  ["a yes beside a listing that does not parse", (body: Record<string, unknown>) => ({ ...body, listing_id: "the-first" })],
  ["a yes beside no listing", (body: Record<string, unknown>) => ({ ...body, listing_id: null, listing_admitted: true })],
  ["a yes that names no listing at all", (body: Record<string, unknown>) => { const { listing_id: _named, ...rest } = body; return rest; }],
] as const)("upgrade: %s neither pins nor clears: the account's device is told the service gave no answer, a device paired at the PC opens it, and the binding pins once the service says", async (_case, change) => {
  const f = await pc();
  const { device, serverId } = await firstPcWithPhone(f);
  const local = await phone();
  const paired = f.devices.pairRelay(f.devices.startPairing().code, "Local", local.spki)!.device;
  const mine = { id: paired.id, keys: local.keys, publicKey: local.spki };
  let silent = true;
  const now = await updated(f, { fetch: req => silent ? mailboxSaying(f, change)(req) : f.account.fetch(req) });
  expect(bindingOf(now.stateDir)).toEqual({ account: "acct_1", bind_id: now.bindId, service: true });
  expect(clearsOf(now.stateDir)).toEqual(clearsOf(f.stateDir));
  expect(await signIn(now, serverId, device)).toBe("account_unreachable");
  // an app from before the two codes keeps its key too
  expect(await signIn(now, serverId, device, [])).toBe("internal_error");
  // the read reached its last page and applied every block: a key paired at the PC needs nothing more of it
  expect(await signIn(now, serverId, mine, [])).toBe("admitted");
  // the hour without a read that commits changes nothing for either
  now.devices.staleAccountMembers();
  expect(await signIn(now, serverId, mine, [])).toBe("admitted");
  expect(await signIn(now, serverId, device)).toBe("account_unreachable");
  await now.app.context.services.accountMailbox.pull();
  expect(bindingOf(now.stateDir)).toEqual({ account: "acct_1", bind_id: now.bindId, service: true });
  expect(now.devices.account()).toBe("acct_1");
  silent = false;
  await now.app.context.services.accountMailbox.pull();
  expect(bindingOf(now.stateDir)).toMatchObject({ bind_id: now.bindId, listing_id: now.listing });
  expect(await signIn(now, serverId, device)).toBe("admitted");
});

test("upgrade: while the service does not say, a device another device of the account approved waits, and a linked phone paired at the PC approves nothing for the account", async () => {
  const { f, serverId, mine, reopen } = await pcWithLocalPhone();
  const tablet = await phone();
  expect(await remoteJoin(f, serverId, await reopen(), tablet)).toBe("admitted");
  const approved = f.stored().find(row => row.relay_public_key === tablet.spki)!;
  expect(approved).toMatchObject({ member_approved_in: "acct_1" });
  f.account.saysListingAdmitted = false;
  const now = await updated(f);
  expect(bindingOf(now.stateDir)).toEqual({ account: "acct_1", bind_id: now.bindId, service: true });
  expect(await signIn(now, serverId, mine, [])).toBe("admitted");
  expect(await signIn(now, serverId, { id: approved.id, keys: tablet.keys, publicKey: tablet.spki })).toBe("account_unreachable");
  expect([now.devices.catchingUp(mine.id), now.devices.catchingUp(mine.id, false), now.devices.catchingUp(approved.id)]).toEqual([false, true, true]);
  expect(now.devices.isAccountApprover(mine.id)).toBe(false);
  // once the service says, each is what it was
  f.account.saysListingAdmitted = true;
  await now.app.context.services.accountMailbox.pull();
  expect([now.devices.catchingUp(mine.id, false), now.devices.catchingUp(approved.id), now.devices.isAccountApprover(mine.id)]).toEqual([false, false, true]);
  expect(await signIn(now, serverId, { id: approved.id, keys: tablet.keys, publicKey: tablet.spki })).toBe("admitted");
});

test.each([
  ["fails", () => new Response(null, { status: 503 })],
  ["does not parse", () => new Response("<html>", { status: 200 })],
] as const)("upgrade: a mailbox call that %s neither pins nor clears, and the binding pins once the service answers", async (_case, answer) => {
  const f = await pc();
  const { device, serverId } = await firstPcWithPhone(f);
  let failing = true;
  const now = await updated(f, { fetch: async req => failing && pathOf(req) === "/v1/pc/mailbox" ? answer() : f.account.fetch(req) });
  expect(bindingOf(now.stateDir)).toEqual({ account: "acct_1", bind_id: now.bindId, service: true });
  expect(clearsOf(now.stateDir)).toEqual(clearsOf(f.stateDir));
  expect(await signIn(now, serverId, device)).toBe("account_unreachable");
  failing = false;
  await now.app.context.services.accountMailbox.pull();
  expect(bindingOf(now.stateDir)).toMatchObject({ bind_id: now.bindId, listing_id: now.listing });
  expect(await signIn(now, serverId, device)).toBe("admitted");
});

test("upgrade: the test account service omits the field when switched to a service from before it, and a PC then neither pins nor clears", async () => {
  const f = await pc();
  const { device, serverId } = await firstPcWithPhone(f);
  f.account.saysListingAdmitted = false;
  const now = await updated(f);
  expect(bindingOf(now.stateDir)).toEqual({ account: "acct_1", bind_id: now.bindId, service: true });
  expect(await signIn(now, serverId, device)).toBe("account_unreachable");
  f.account.saysListingAdmitted = true;
  await now.app.context.services.accountMailbox.pull();
  expect(bindingOf(now.stateDir)).toMatchObject({ bind_id: now.bindId, listing_id: now.listing });
  expect(await signIn(now, serverId, device)).toBe("admitted");
});

test.each([
  ["the listing a device wrote again", "string", async (t: Awaited<ReturnType<typeof firstPcWithPhone>>) => { await t.remove(); await t.relist(); }],
  ["no listing", "object", async (t: Awaited<ReturnType<typeof firstPcWithPhone>>) => { await t.remove(); }],
] as const)("upgrade: a no beside %s clears the binding, and the PC waits to be added again at the PC", async (_case, named, before) => {
  const f = await pc();
  const made = await firstPcWithPhone(f);
  await before(made);
  const said: unknown[] = [];
  const now = await updated(f, { fetch: mailboxSaying(f, body => { said.push([typeof body.listing_id, body.listing_admitted]); return body; }) });
  expect(said.at(-1)).toEqual([named, false]);
  expect(bindingOf(now.stateDir)).toBeNull();
  expect(now.devices.addAtPcRequired()).toBe(true);
  expect(await signIn(now, made.serverId, made.device)).toBe("account_readd_required");
});

test("upgrade: a yes that comes back after the binding it was asked for is gone pins nothing", async () => {
  const f = await pc();
  const { device, serverId } = await firstPcWithPhone(f);
  const held = Promise.withResolvers<void>(), asked = Promise.withResolvers<void>();
  let holding = false;
  const now = await updated(f, { pull: false, fetch: async req => {
    const answer = await f.account.fetch(req);
    if (holding && pathOf(req) === "/v1/pc/mailbox") { asked.resolve(); await held.promise; }
    return answer;
  } });
  const completions = completionChecks(f);
  holding = true;
  const refused = signIn(now, serverId, device);
  await bounded(asked.promise);
  holding = false;
  expect(now.devices.clearAccountBinding("unlisted", "account")).toBe(true);
  held.resolve();
  expect(await refused).toBe("account_readd_required");
  expect(bindingOf(now.stateDir)).toBeNull();
  expect(completionChecks(f)).toBe(completions);
});

test("upgrade: an admission another device made for a replacement listing pins nothing to a binding without a listing ID", async () => {
  const f = await pc();
  const { device, serverId, remove, relist } = await firstPcWithPhone(f);
  await remove();
  await relist();
  // a device of the account, freshly signed in with two-step, admits the relisted PC: nobody pressed at the PC
  await admitAt(f, "acct_1");
  const now = await updated(f);
  expect(bindingOf(now.stateDir)).toBeNull();
  expect(now.devices.sessionRow(device.id)).toBeNull();
  expect(await signIn(now, serverId, device)).toBe("account_readd_required");
});

test.each([
  ["an empty completed_at", { completed_at: "" }],
  ["a completed_at that is no time", { completed_at: "soon" }],
  ["a completed_at that only parses", { completed_at: "0" }],
  ["a completed_at on a day that does not exist", { completed_at: "2026-02-30T00:00:00.000Z" }],
  ["no completed_at", {}],
  ["a null body", null],
] as const)("listing confirmation: a completion answered 200 with %s confirms nothing", async (_case, body) => {
  let garbled = false;
  const f = await pc({ accountFetch: async (req, svc) => {
    const answer = await svc.fetch(req);
    return garbled && pathOf(req) === "/v1/pc/complete" && answer.ok ? Response.json(body) : answer;
  } });
  const { device, serverId, clock } = await firstPcWithPhone(f);
  const binding = f.devices.serviceBinding();
  clock.advance(LISTING_CONFIRMED_MS);
  garbled = true;
  expect(await signIn(f, serverId, device)).toBe("account_unreachable");
  expect(await f.app.context.services.accountMailbox.readSnapshot()).toMatchObject({ committed: false });
  expect(f.devices.serviceBinding()).toBe(binding);
});

test("the completion receipt is kept until the service takes it or says its listing changed", async () => {
  let answer: (() => Response) | null = () => Response.json(null);
  const f = await pc({ accountFetch: async (req, svc) => {
    if (answer !== null && pathOf(req) === "/v1/pc/complete") return answer();
    return svc.fetch(req);
  } });
  await setUpFor(f, "acct_1");
  await admitAt(f, "acct_1", null);
  expect((await press(f, "acct_1")).status).toBe(200);
  const kept = () => JSON.parse(readFileSync(join(f.stateDir, "account-completion.json"), "utf8"));
  const receipt = { account: "acct_1", listing_id: f.devices.serviceListing() };
  expect(kept()).toEqual(receipt);
  for (const next of [() => Response.json({ completed_at: "" }), () => Response.json({ error: { code: "try_again" } }, { status: 409 }), () => new Response(null, { status: 503 })]) {
    answer = next;
    await f.app.context.services.accountMailbox.pull();
    expect(kept()).toEqual(receipt);
  }
  answer = null;
  await f.app.context.services.accountMailbox.pull();
  expect(kept()).toBeNull();
});

test.each([
  ["no listing ID", (body: Record<string, unknown>) => { const { listing_id: _listing, ...rest } = body; return rest; }],
  ["a null listing ID", (body: Record<string, unknown>) => ({ ...body, listing_id: null })],
  ["a malformed listing ID", (body: Record<string, unknown>) => ({ ...body, listing_id: "L1" })],
] as const)("a press whose admission names %s binds nothing", async (_case, change) => {
  const f = await pc({ accountFetch: async (req, svc) => {
    const answer = await svc.fetch(req);
    return pathOf(req) === "/v1/pc/admission" && answer.ok ? Response.json(change(await answer.json())) : answer;
  } });
  await setUpFor(f, "acct_1");
  await admitAt(f, "acct_1", null);
  const pressed = await press(f, "acct_1");
  expect([pressed.status, pressed.body.error?.code]).toEqual([502, "listing_unnamed"]);
  expect(f.devices.account()).toBeNull();
});

test("listing confirmation: after a restart with the account service down, a device from before the account codes keeps its key", async () => {
  const f = await pc();
  const { device, serverId } = await firstPcWithPhone(f);
  const now = await restartedFrom(f, { fetch: async () => new Response(null, { status: 503 }) });
  // auth_failed would make that app forget its pairing; the row only waits for a read that cannot come
  expect(await signIn(now, serverId, device, [])).toBe("internal_error");
  expect(await signIn(now, serverId, device, [ACCOUNT_OPENS_ALL_FEATURE])).toBe("held");
  expect(await signIn(now, serverId, device)).toBe("account_unreachable");
  expect(bindingOf(now.stateDir)).toMatchObject({ bind_id: now.bindId, listing_id: now.listing });
});

test("one press: a listing replaced between the admission and the first read releases no account row", async () => {
  let replace: (() => Promise<void>) | null = null;
  const f = await pc({ accountFetch: async (req, svc) => {
    if (pathOf(req) === "/v1/pc/complete") return new Response(null, { status: 503 });
    const answer = await svc.fetch(req);
    if (pathOf(req) === "/v1/pc/admission" && replace !== null) { const run = replace; replace = null; await run(); }
    return answer;
  } });
  await setUpFor(f, "acct_1");
  await admitAt(f, "acct_1");
  const token = f.account.issueToken("acct_1");
  const key = await phone();
  f.account.registerSessionKey(token, key.spki, "Phone");
  const identity = f.app.context.services.relay.currentIdentity()!;
  const url = `https://account.test/v1/pcs/${identity.server_id}`;
  const headers = { authorization: `Bearer ${token}` };
  replace = async () => {
    expect((await f.account.fetch(new Request(url, { method: "DELETE", headers }))).status).toBe(204);
    expect((await f.account.fetch(new Request(url, { method: "PUT", headers, body: JSON.stringify({ label: "PC", public_key: bytesToHex(importPublicKey(identity.public_key)), relay: "wss://relay.test" }) }))).status).toBe(200);
  };
  await press(f, "acct_1");
  expect(replace).toBeNull();
  expect(f.devices.has(accountDeviceId(identity.server_id, key.spki))).toBe(false);
});

test("a snapshot read whose listing is replaced before its last page releases nothing", async () => {
  let replace: (() => Promise<void>) | null = null;
  const f = await pc({ accountFetch: async (req, svc) => {
    if (replace !== null && pathOf(req) === "/v1/pc/snapshot" && (await req.clone().json()).page === 1) { const run = replace; replace = null; await run(); }
    return svc.fetch(req);
  } });
  const { serverId, remove, relist } = await firstPcWithPhone(f);
  const late = await phone();
  f.account.registerDevice("acct_1", late.spki, "Late");
  for (let index = 0; index < 100; index++) f.account.registerDevice("acct_1", (await phone()).spki, `Device ${index}`);
  replace = async () => { await remove(); await relist(); };
  expect(await f.app.context.services.accountMailbox.readSnapshot()).toMatchObject({ committed: false });
  expect(replace).toBeNull();
  expect(f.devices.has(accountDeviceId(serverId, late.spki))).toBe(false);
});

test("listing confirmation: an AUTH_OK that leaves the queue after the 60 seconds admits nobody", async () => {
  const f = await pc();
  const { device, serverId, clock } = await firstPcWithPhone(f);
  clock.advance(LISTING_CONFIRMED_MS);
  const link = await relayConnection(f, { serverId });
  const mux = link.session.mux;
  const enqueue = mux.enqueueControl.bind(mux);
  const queued = Promise.withResolvers<() => void>();
  // the carrier holds the frame back: its commit runs only when it is sent
  mux.enqueueControl = (frame, ...rest) => {
    if (frame.type !== FrameType.AUTH_OK) return enqueue(frame, ...rest);
    queued.resolve(() => enqueue(frame, ...rest));
  };
  const verdict = link.auth(device, listingFeatures).then(() => "admitted", () => bounded(link.serverError));
  const send = await bounded(queued.promise);
  clock.advance(LISTING_CONFIRMED_MS);
  send();
  expect(await verdict).toBe("timeout");
  expect(await signIn(f, serverId, device)).toBe("admitted");
});

test("listing confirmation: a later check that fails ends a warm answer", async () => {
  let offline = false;
  const f = await pc({ accountFetch: async (req, svc) => offline && pathOf(req) === "/v1/pc/complete" ? new Response(null, { status: 503 }) : svc.fetch(req) });
  const { device, serverId, clock } = await firstPcWithPhone(f);
  clock.advance(LISTING_CONFIRMED_MS);
  expect(await signIn(f, serverId, device)).toBe("admitted");
  offline = true;
  clock.advance(1_000);
  expect(await f.app.context.services.accountMailbox.readSnapshot()).toMatchObject({ committed: false });
  expect(await signIn(f, serverId, device)).toBe("account_unreachable");
});

/** The link a signed-in app sends for its own row: the row keeps its key and becomes a member of `account`. */
const linkOf = (serverId: string, id: string, account: string, key: Phone) => signAccountRecord({ v: 1, kind: "link", account, key: key.spki, server_id: serverId,
  device_id: id, old_key: key.spki, issued_at: new Date().toISOString(), id: newRecordId(), signer: key.spki }, key.keys.privateKey);

/** A one-press PC with an account-only device and a phone paired at the PC that linked itself into the account, as a signed-in app does on its first open. */
async function pcWithLocalPhone(options: Parameters<typeof pc>[0] = {}) {
  const f = await pc(options);
  const made = await firstPcWithPhone(f);
  const local = await phone();
  const paired = f.devices.pairRelay(f.devices.startPairing().code, "Local", local.spki)!.device;
  const mine = { id: paired.id, keys: local.keys, publicKey: local.spki };
  const reopen = async (from: Parameters<typeof relayConnection>[0] = f) => {
    const link = await relayConnection(from, { serverId: made.serverId });
    await link.auth(mine);
    return link;
  };
  const link = () => linkOf(made.serverId, paired.id, "acct_1", local);
  expect((await sendLink(await reopen(), await link())).status).toBe(200);
  expect(f.stored().find(row => row.id === paired.id)?.account).toBe("acct_1");
  const puts = () => f.account.requests.filter(path => path === `PUT /v1/pcs/${made.serverId}`).length;
  return { f, ...made, local, paired, mine, reopen, link, puts };
}

test("removed PC: a signed-in phone paired at the PC that reopens its saved connection does not put the PC back", async () => {
  const { f, device, serverId, remove, relist, reopen, link, mine } = await pcWithLocalPhone();
  // "I didn't add this" on another device of the account
  await remove();
  await f.app.context.services.accountMailbox.readSnapshot();
  expect(f.devices.account()).toBeNull();
  // the phone's page reloads: its enrollment reads the PC's status, and a PC in no account used to get its link
  const again = await reopen();
  const refused = await sendLink(again, await link());
  expect([refused.status, refused.body.error?.code]).toEqual([409, "account_mismatch"]);
  expect(bindingOf(f.stateDir)).toBeNull();
  expect((await ask(again, "/api/account/status")).body).toMatchObject({ account: null, pc_add_required: true });
  expect(f.stored().find(row => row.id === mine.id)?.account).toBeUndefined();
  // an app from before this rule lists the PC again all the same: the PC stays out, and the account's other device with it
  await relist();
  expect(await f.app.context.services.accountMailbox.pull()).toBe(0);
  expect(f.devices.account()).toBeNull();
  expect(await signIn(f, serverId, device)).toBe("account_readd_required");

  const now = await restartedFrom(f);
  expect(bindingOf(now.stateDir)).toBeNull();
  const reopened = await reopen(now);
  expect((await ask(reopened, "/api/account/status")).body).toMatchObject({ account: null, pc_add_required: true });
  expect((await sendLink(reopened, await link())).status).toBe(409);
  expect(bindingOf(now.stateDir)).toBeNull();
  expect(await signIn(now, serverId, device)).toBe("account_readd_required");
});

test.each([
  ["a code this PC issued itself", true],
  ["a code a paired device asked for", false],
] as const)("removed PC: %s brings it into the account again: %p", async (_case, atPc) => {
  const { f, remove, reopen, link, local, paired } = await pcWithLocalPhone();
  await remove();
  await f.app.context.services.accountMailbox.readSnapshot();
  expect(f.devices.account()).toBeNull();
  f.devices.pairingForNoAccount(atPc ? null : paired.id, Date.now(), "acct_1");
  await vouchFor(f, "acct_1", local);
  const answer = await sendLink(await reopen(), await link());
  expect(answer.status).toBe(atPc ? 200 : 409);
  expect(f.devices.account()).toBe(atPc ? "acct_1" : null);
  expect((await f.status()).pc_add_required).toBe(atPc ? undefined : true);
});

/** A device asks to join by comparing digits, and the account member on `approver` approves it: "admitted", or the code the PC ended it with. */
async function remoteJoin(f: Pc, serverId: string, approver: Awaited<ReturnType<typeof relayConnection>>, key: Phone): Promise<string> {
  f.app.context.services.relay.approvals.openWindow();
  const joiner = await relayConnection(f, { serverId });
  await joiner.hello([PAIR_SAS_FEATURE, PAIR_INTENT_ACCOUNT]);
  const binding = channelBinding(joiner.channel);
  if (!binding) throw new Error("Missing SAS binding");
  const nonce = randomPairNonce();
  const challenge = Promise.withResolvers<string>();
  const outcome = Promise.withResolvers<string>();
  joiner.onFrame = frame => {
    if (frame.type === FrameType.PAIR_CHALLENGE) challenge.resolve(frame.payload.nonce);
    if (frame.type === FrameType.AUTH_OK) outcome.resolve("admitted");
    if (frame.type === FrameType.SESSION_ERROR) outcome.resolve(frame.payload.code);
  };
  joiner.mux.sendSession({ type: FrameType.PAIR_REQUEST, flags: 0, stream_id: 0, payload: { label: "Tablet", public_key: key.spki, commitment: toBase64Url(pairCommitment(binding, key.spki, nonce)) } });
  const digits = pairDigits(binding, key.spki, nonce, fromBase64Url(await bounded(challenge.promise)));
  const request = Promise.withResolvers<string>();
  const unsubscribe = f.app.context.services.relay.approvals.subscribeRemote(list => {
    const prompt = list.find(entry => entry.key === key.spki);
    if (prompt) request.resolve(prompt.id);
  });
  joiner.mux.sendSession({ type: FrameType.PAIR_REVEAL, flags: 0, stream_id: 0, payload: { nonce: toBase64Url(nonce) } });
  const id = await bounded(request.promise).finally(unsubscribe);
  expect((await ask(approver, "/api/relay/pairing", { method: "POST", body: { id, decision: "approve", digits } })).status).toBe(200);
  joiner.mux.sendSession({ type: FrameType.PAIR_CONFIRM, flags: 0, stream_id: 0, payload: { confirmed: true } });
  return bounded(outcome.promise);
}

test("T56: the hour without a whole read keeps a phone that paired with this PC's own code and linked with the same key, and suspends what it may do for the account", async () => {
  const f = await pc();
  const clock = new TestClock();
  f.devices.useClock(clock);
  await setUpFor(f, "acct_1");
  const key = await phone();
  const paired = await signedInWith(f, await f.tabCode(), key);
  await vouchFor(f, "acct_1", key);
  expect((await sendLink(paired.session, await linkRecord(paired.id, "acct_1", key))).status).toBe(200);
  expect(f.stored().find(row => row.id === paired.id)).toMatchObject({ account: "acct_1", origin: { from: "remote", how: "link" } });
  await firstPairingRead(f);
  const open = await relayConnection(f);
  await open.auth({ id: paired.id, keys: key.keys, publicKey: key.spki });
  expect(f.devices.isAccountApprover(paired.id)).toBe(true);
  f.account.opensAll = false;
  clock.advance(STALE_READ_MS);
  expect(f.devices.isAccountApprover(paired.id)).toBe(false);
  expect((await ask(open, "/api/health")).status).toBe(200);
  const again = await relayConnection(f);
  expect(await again.auth({ id: paired.id, keys: key.keys, publicKey: key.spki })).toMatchObject({ role: "drive" });
  f.account.opensAll = true;
  expect(await f.app.context.services.accountMailbox.readSnapshot()).toMatchObject({ committed: true });
  expect(f.devices.isAccountApprover(paired.id)).toBe(true);
});

test("T56: the hour without a whole read keeps a phone that `ovis recover` admitted and that linked with the same key, and suspends what it may do for the account", async () => {
  const f = await pc();
  const clock = new TestClock();
  f.devices.useClock(clock);
  const key = await phone();
  const { code } = f.devices.startAccountPairing("acct_1");
  const redeemed = f.devices.redeemCode(code, "qr", key.spki);
  if (!redeemed.ok) throw new Error("The recovered key did not reserve the code");
  const waiting = f.devices.admitConfirmed({ codeId: redeemed.codeId, key: key.spki, label: "Phone", source: "recover", by: "alice" });
  if (waiting === null) throw new Error("Recovery made no waiting row");
  expect(f.devices.linkAccountKey(waiting.id, key.spki, key.spki, "acct_1", "", true)).toMatchObject({ id: waiting.id });
  expect(f.devices.originOf(waiting.id)).toMatchObject({ from: "recover" });
  await firstPairingRead(f);
  const mine = { id: waiting.id, keys: key.keys, publicKey: key.spki };
  const open = await relayConnection(f);
  await open.auth(mine);
  expect(f.devices.isAccountApprover(waiting.id)).toBe(true);
  f.account.opensAll = false;
  clock.advance(STALE_READ_MS);
  expect(f.devices.isAccountApprover(waiting.id)).toBe(false);
  expect((await ask(open, "/api/health")).status).toBe(200);
  const again = await relayConnection(f);
  expect(await again.auth(mine)).toMatchObject({ role: "drive" });
});

test("update: a removal from before the add-at-the-PC rule whose state folder takes no write does not keep the PC from starting, and counts no approval", async () => {
  const { f, serverId, remove } = await pcWithLocalPhone();
  const old = await phone();
  const kept = f.devices.pairRelayApproved("Old", old.spki, { path: "code" })?.device;
  if (!kept) throw new Error("The PC approved no device");
  await remove();
  await f.app.context.services.accountMailbox.readSnapshot();
  expect(f.devices.account()).toBeNull();
  const rename = privateStateFs.renameSync;
  const fault = spyOn(privateStateFs, "renameSync").mockImplementation((from, to) => {
    if (String(to).endsWith("/account-pc.json")) throw new Error("the folder takes no write");
    rename(from, to);
  });
  try {
    const now = await restartedFrom(f, { edit: state => { delete state.clears.at(-1)!["admits"]; } });
    expect(now.devices.addAtPcRequired()).toBe(true);
    expect(now.devices.approvedAtPcSinceClear(kept.id)).toBe(false);
    const session = await relayConnection(now, { serverId });
    expect(await session.auth({ id: kept.id, keys: old.keys, publicKey: old.spki })).toMatchObject({ role: "drive" });
  } finally { fault.mockRestore(); }
});

test("listing confirmation: a join a member approves from afar makes no device while the listing cannot be confirmed", async () => {
  let offline = false;
  const { f, serverId, clock, reopen } = await pcWithLocalPhone({ accountFetch: async (req, svc) => offline && pathOf(req) === "/v1/pc/complete" ? new Response(null, { status: 503 }) : svc.fetch(req) });
  clock.advance(LISTING_CONFIRMED_MS);
  offline = true;
  const tablet = await phone();
  // a comparison offers no account codes: the outage is an error of the PC's, not a decline
  expect(await remoteJoin(f, serverId, await reopen(), tablet)).toBe("internal_error");
  expect(f.stored().some(row => row.relay_public_key === tablet.spki)).toBe(false);
  offline = false;
  expect(await remoteJoin(f, serverId, await reopen(), tablet)).toBe("admitted");
});

test("a snapshot whose listing cannot be confirmed still applies its blocks, and releases nothing", async () => {
  let offline = false;
  const f = await pc({ accountFetch: async (req, svc) => offline && pathOf(req) === "/v1/pc/complete" ? new Response(null, { status: 503 }) : svc.fetch(req) });
  const { device, serverId, token } = await firstPcWithPhone(f);
  const target = await phone();
  f.account.registerDevice("acct_1", target.spki, "Target");
  expect(await f.app.context.services.accountMailbox.readSnapshot()).toMatchObject({ committed: true });
  const late = await phone();
  f.account.registerDevice("acct_1", late.spki, "Late");
  const block = await signSafetyRecord({ v: 1, kind: "block", account: "acct_1", target: target.spki, target_no: 2,
    signer: device.publicKey, signer_no: 1, signed_at: new Date().toISOString(), nonce: newRecordId() }, device.keys.privateKey);
  // sent by the sign-in that registered the phone's key, as the account service wants it
  const filed = await f.account.fetch(new Request("https://account.test/v1/safety-records", { method: "POST", headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ record: block }) }));
  expect(filed.status).toBeLessThan(300);
  offline = true;
  expect(await f.app.context.services.accountMailbox.readSnapshot()).toMatchObject({ committed: false, denials: 1 });
  expect(f.app.context.services.safetyLog?.inForce.blocks.map(entry => entry.record.id)).toContain(block.id);
  expect(f.devices.has(accountDeviceId(serverId, late.spki))).toBe(false);
});

test("upgrade: a last page that does not parse says nothing for a binding with nothing to ask about", async () => {
  const f = await pc();
  await firstPcWithPhone(f);
  let garbled = true;
  const now = await updated(f, { fetch: async req => garbled && pathOf(req) === "/v1/pc/snapshot" ? Response.json({ last: true }) : f.account.fetch(req) });
  expect(bindingOf(now.stateDir)).toEqual({ account: "acct_1", bind_id: now.bindId, service: true });
  garbled = false;
  await now.app.context.services.accountMailbox.pull();
  expect(bindingOf(now.stateDir)).toMatchObject({ bind_id: now.bindId, listing_id: now.listing });
});

test("listing confirmation: after a restart whose reads fail while the listing is confirmed, a device from before the account codes keeps its key", async () => {
  const f = await pc();
  const { device, serverId } = await firstPcWithPhone(f);
  const now = await restartedFrom(f, { fetch: async req => pathOf(req) === "/v1/pc/snapshot" ? new Response(null, { status: 503 }) : f.account.fetch(req) });
  expect(await signIn(now, serverId, device, [])).toBe("internal_error");
  expect(await signIn(now, serverId, device, [ACCOUNT_OPENS_ALL_FEATURE])).toBe("held");
});

test("listing confirmation: a sign-in whose row starts to wait for a read while its listing is asked about is held, not refused", async () => {
  let atAsk: (() => void) | null = null;
  const f = await pc({ accountFetch: async (req, svc) => {
    if (atAsk !== null && pathOf(req) === "/v1/pc/complete") { const run = atAsk; atAsk = null; run(); }
    return svc.fetch(req);
  } });
  const { device, serverId, clock } = await firstPcWithPhone(f);
  clock.advance(STALE_READ_MS - 1_000);
  // the hour since the last whole read ends while the service is asked
  atAsk = () => clock.advance(1_000);
  expect(await signIn(f, serverId, device, [ACCOUNT_OPENS_ALL_FEATURE, ACCOUNT_LISTING_ERRORS])).toBe("held");
  expect(atAsk).toBeNull();
  // the refused sign-in started the read the row waited for
  expect(await signIn(f, serverId, device, [ACCOUNT_OPENS_ALL_FEATURE, ACCOUNT_LISTING_ERRORS])).toBe("admitted");
});

test("listing confirmation: a yes that arrives after a later check failed is not kept", async () => {
  let held: { promise: Promise<void> } | null = null;
  const reached = Promise.withResolvers<void>();
  let offline = false;
  const f = await pc({ accountFetch: async (req, svc) => {
    if (pathOf(req) !== "/v1/pc/complete") return svc.fetch(req);
    if (offline) return new Response(null, { status: 503 });
    const answer = await svc.fetch(req);
    if (held !== null) { const wait = held; held = null; offline = true; reached.resolve(); await wait.promise; }
    return answer;
  } });
  const { device, serverId, clock } = await firstPcWithPhone(f);
  clock.advance(LISTING_CONFIRMED_MS);
  const release = Promise.withResolvers<void>();
  held = release;
  const first = signIn(f, serverId, device);
  await bounded(reached.promise);
  // the service said yes to the sign-in's check; a read that began after it gets no answer
  expect(await f.app.context.services.accountMailbox.readSnapshot()).toMatchObject({ committed: false });
  release.resolve();
  expect(await first).toBe("account_unreachable");
  expect(await signIn(f, serverId, device)).toBe("account_unreachable");
});

test("removed PC: a device whose digits the owner approves on the PC after it left brings it into the account again", async () => {
  const { f, serverId, remove, reopen, link } = await pcWithLocalPhone();
  await remove();
  await f.app.context.services.accountMailbox.readSnapshot();
  expect(f.devices.account()).toBeNull();
  // the PC's own Add this PC screen waits, and its owner approves the digits a device of the account shows
  const key = await phone();
  const approved = f.devices.pairRelayApproved("Tablet", key.spki, { path: "code" })?.device;
  if (!approved) throw new Error("The PC approved no device");
  expect(f.devices.originOf(approved.id)).toMatchObject({ how: "digits", by: null });
  // the phone it kept paired from before is still not the one to add it
  expect((await sendLink(await reopen(), await link())).status).toBe(409);
  const session = await relayConnection(f, { serverId });
  await session.auth({ id: approved.id, keys: key.keys, publicKey: key.spki });
  expect((await sendLink(session, await linkOf(serverId, approved.id, "acct_1", key))).status).toBe(200);
  expect(f.devices.account()).toBe("acct_1");
});

/**
 * A PC in no account whose own first-link code a signed-in phone paired with, and which that phone's link (same key)
 * brought into the account: the row is the phone's own pairing and an account member at once.
 */
async function pcWithFirstLinkPhone() {
  const f = await pc();
  await setUpFor(f, "acct_1");
  const key = await phone();
  const paired = await signedInWith(f, await f.tabCode(), key);
  await vouchFor(f, "acct_1", key);
  expect((await sendLink(paired.session, await linkRecord(paired.id, "acct_1", key))).status).toBe(200);
  expect(f.stored().find(row => row.id === paired.id)).toMatchObject({ account: "acct_1", link_moved_key: false, origin: { from: "remote", how: "link", by: null } });
  const mine = { id: paired.id, keys: key.keys, publicKey: key.spki };
  const opens = async (from: Parameters<typeof relayConnection>[0] = f) => {
    const link = await relayConnection(from);
    return link.auth(mine).then(() => "admitted", () => bounded(link.serverError));
  };
  return { f, key, mine, opens };
}

test("removed PC: a phone that paired with the PC's own first-link code and kept its key keeps its own access when the account removes the PC", async () => {
  const { f, mine, opens } = await pcWithFirstLinkPhone();
  await firstPairingRead(f);
  await f.app.context.services.accountMailbox.pull();
  const serverId = f.app.context.services.relay.currentIdentity()!.server_id;
  // "I didn't add this" on another device of the account
  expect((await f.account.fetch(new Request(`https://account.test/v1/pcs/${serverId}`, { method: "DELETE", headers: { authorization: `Bearer ${f.account.issueToken("acct_1")}` } }))).status).toBe(204);
  await f.app.context.services.accountMailbox.pull();
  expect(f.devices.account()).toBeNull();
  expect(f.stored().find(row => row.id === mine.id)).toMatchObject({ role: "drive" });
  expect(f.stored().find(row => row.id === mine.id)?.account).toBeUndefined();
  expect(await opens()).toBe("admitted");
  const now = await restartedFrom(f);
  expect(await opens(now)).toBe("admitted");
});

test("upgrade: the clear of a binding without a listing ID keeps a phone that paired with the PC's own first-link code and kept its key", async () => {
  const { f, key, mine, opens } = await pcWithFirstLinkPhone();
  // the account removes the PC, its owner adds it again in one press, and the phone it kept links again
  expect(f.devices.clearAccountBinding("unlisted", "account")).toBe(true);
  expect(await opens()).toBe("admitted");
  await admitAt(f, "acct_1");
  expect((await press(f, "acct_1")).status).toBe(200);
  const session = await relayConnection(f);
  await session.auth(mine);
  expect((await sendLink(session, await linkRecord(mine.id, "acct_1", key))).status).toBe(200);
  expect(f.stored().find(row => row.id === mine.id)).toMatchObject({ account: "acct_1", origin: { from: "remote", how: "link" } });
  // the account removes the PC again and a device lists it again with no press at the PC
  const identity = f.app.context.services.relay.currentIdentity()!;
  const headers = { authorization: `Bearer ${f.account.issueToken("acct_1")}` };
  expect((await f.account.fetch(new Request(`https://account.test/v1/pcs/${identity.server_id}`, { method: "DELETE", headers }))).status).toBe(204);
  expect((await f.account.fetch(new Request(`https://account.test/v1/pcs/${identity.server_id}`, { method: "PUT", headers,
    body: JSON.stringify({ label: "PC", public_key: bytesToHex(importPublicKey(identity.public_key)), relay: "wss://relay.test" }) }))).status).toBe(200);
  // the update: its one-press binding names no listing, and the service says the listing stands on no admission it took
  const now = await updated(f);
  expect(bindingOf(now.stateDir)).toBeNull();
  expect(await opens(now)).toBe("admitted");
  const again = await restartedFrom({ ...f, stateDir: now.stateDir, app: now.app } as Pc);
  expect(await opens(again)).toBe("admitted");
});

/** A PC in no account that a paired phone's link brings into the one named for it; the phone's app lists it only afterwards. */
async function pcJustLinked() {
  const f = await pc();
  await setUpFor(f, "acct_1");
  const serverId = f.app.context.services.relay.currentIdentity()!.server_id;
  const key = await phone();
  const paired = f.devices.pairRelay(f.devices.startPairing().code, "Phone", key.spki)!.device;
  const mine = { id: paired.id, keys: key.keys, publicKey: key.spki };
  const session = await relayConnection(f, { serverId });
  await session.auth(mine);
  expect((await sendLink(session, await linkOf(serverId, paired.id, "acct_1", key))).status).toBe(200);
  expect(bindingOf(f.stateDir)).toMatchObject({ account: "acct_1" });
  const list = () => admitlessListing(f, serverId);
  // the link ends the session that sent it: the app signs in again, which makes the PC read the account
  const again = () => signIn(f, serverId, mine, [ACCOUNT_OPENS_ALL_FEATURE]);
  return { f, serverId, again, list };
}
async function admitlessListing(f: Pc, serverId: string): Promise<void> {
  const identity = f.app.context.services.relay.currentIdentity()!;
  const listed = await f.account.fetch(new Request(`https://account.test/v1/pcs/${serverId}`, { method: "PUT", headers: { authorization: `Bearer ${f.account.issueToken("acct_1")}` },
    body: JSON.stringify({ label: "PC", public_key: bytesToHex(importPublicKey(identity.public_key)), relay: "wss://relay.test" }) }));
  expect(listed.status).toBe(200);
}

test("a PC a device's link just brought into the account stays in it while reads find no listing yet, then names its listing", async () => {
  const { f, again, list } = await pcJustLinked();
  // the app signs in again before it has listed the PC: the read that sign-in starts, and the PC's own poll, find no listing
  expect(await again()).toBe("held");
  await f.app.context.services.accountMailbox.pull();
  expect(f.devices.account()).toBe("acct_1");
  expect(f.devices.addAtPcRequired()).toBe(false);
  await list();
  await f.app.context.services.accountMailbox.pull();
  expect(await again()).toBe("admitted");
  expect(bindingOf(f.stateDir)).toMatchObject({ account: "acct_1", listing_id: expect.stringMatching(/^[0-9a-f]{32}$/) });
  expect(bindingOf(f.stateDir).listing_due).toBeUndefined();
});

test("a PC a device's link brought into the account that is still not listed ten minutes later leaves it", async () => {
  const { f } = await pcJustLinked();
  const linked = Date.now();
  const time = spyOn(Date, "now").mockImplementation(() => linked + 10 * 60_000 - 5_000);
  f.closes.push(() => time.mockRestore());
  await f.app.context.services.accountMailbox.pull();
  expect(f.devices.account()).toBe("acct_1");
  time.mockImplementation(() => linked + 10 * 60_000 + 1_000);
  await f.app.context.services.accountMailbox.pull();
  expect(f.devices.account()).toBeNull();
  expect(f.devices.addAtPcRequired()).toBe(true);
});

test("update: an account's removal from before the add-at-the-PC rule counts no approval from before this version first read it", async () => {
  const { f, serverId, remove } = await pcWithLocalPhone();
  // digits this PC approved while it was in the account: a pairing of its own, which the removal keeps
  const old = await phone();
  const kept = f.devices.pairRelayApproved("Old", old.spki, { path: "code" })?.device;
  if (!kept) throw new Error("The PC approved no device");
  expect(f.devices.originOf(kept.id)).toMatchObject({ how: "digits", by: null });
  await remove();
  await f.app.context.services.accountMailbox.readSnapshot();
  expect(f.devices.account()).toBeNull();
  // as an older version wrote the clear: with no word of what was admitted before it
  const now = await restartedFrom(f, { edit: state => { delete state.clears.at(-1)!["admits"]; } });
  const linkAs = async (id: string, key: Phone) => {
    const session = await relayConnection(now, { serverId });
    await session.auth({ id, keys: key.keys, publicKey: key.spki });
    return (await sendLink(session, await linkOf(serverId, id, "acct_1", key))).status;
  };
  expect(await linkAs(kept.id, old)).toBe(409);
  expect(now.devices.account()).toBeNull();
  const fresh = await phone();
  const approved = now.devices.pairRelayApproved("New", fresh.spki, { path: "code" })?.device;
  if (!approved) throw new Error("The PC approved no device");
  expect(await linkAs(approved.id, fresh)).toBe(200);
  expect(now.devices.account()).toBe("acct_1");
});

test("removed PC: restarting after a bare relist cannot release the old phone row", async () => {
  const f = await pc();
  const { device, serverId, remove, relist } = await firstPcWithPhone(f);
  await f.app.stop();
  await remove();
  await relist();
  // A distinct folder forces all path-keyed state handles to reopen the files from disk.
  const stateDir = mkdtempSync(join(tmpdir(), "ovis-relisted-"));
  cpSync(f.stateDir, stateDir, { recursive: true });
  const app = createServer({ stateDir, port: 0, hostname: "127.0.0.1", token: "", tailscaleOwner: null,
    registerBridge: false, sidecar: false, accountOpensAll: true, accountService: { url: "https://account.test", fetch: f.account.fetch } });
  const closes: (() => void)[] = [];
  try {
    await app.context.services.accountMailbox.pull();
    expect(app.context.services.devices.sessionRow(device.id)).toBeNull();
    const next = await relayConnection({ stateDir, app, closes, close() {} }, { serverId });
    await expect(next.auth(device)).rejects.toThrow("Relay closed before admission");
    expect(await next.serverError).toBe("auth_failed");
  } finally { for (const close of closes) close(); await app.stop(); rmSync(stateDir, { recursive: true, force: true }); }
});

test("the owner's press binds a PC in no account to the account it is signed in to, and the account's devices are let in by its snapshot", async () => {
  const f = await pc();
  await setUpFor(f, "acct_1");
  await admitAt(f, "acct_1");
  const keys = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
  const laptop = await exportAccountKey(keys.publicKey);
  f.account.registerDevice("acct_1", laptop, "Laptop");
  const pressed = await press(f, "acct_1");
  expect([pressed.status, pressed.body]).toEqual([200, { account: "acct_1" }]);
  expect(f.devices.account()).toBe("acct_1");
  expect(f.devices.has(accountDeviceId(f.app.context.services.relay.currentIdentity()!.server_id, laptop))).toBe(true);
  expect(await f.status()).toMatchObject({ account: "acct_1" });
  // the admission is spent: a second press finds the PC in its account
  const again = await press(f, "acct_1");
  expect([again.status, again.body.error?.code]).toEqual([409, "in_account"]);
});

test("a press with no admission of that account binds nothing", async () => {
  const f = await pc();
  await setUpFor(f, "acct_1");
  const pressed = await press(f, "acct_1");
  expect([pressed.status, pressed.body.error?.code]).toEqual([404, "no_admission"]);
  expect(f.devices.account()).toBeNull();
});

test("the account pressed for must be the one named for this PC: a relay-account another drive caller set to B makes the owner's press for A refuse, and nothing is bound", async () => {
  const f = await pc();
  // any direct drive caller may name the relay-account (routes.ts): here it names B
  await setUpFor(f, "acct_b");
  await admitAt(f, "acct_a");
  await admitAt(f, "acct_b");
  const pressed = await press(f, "acct_a");
  expect([pressed.status, pressed.body.error?.code]).toEqual([409, "account_mismatch"]);
  expect(f.devices.account()).toBeNull();
});

test("an admission by another account is invisible to the PC: the press for its named account binds nothing", async () => {
  const f = await pc();
  await setUpFor(f, "acct_a");
  await admitAt(f, "acct_b");
  const pressed = await press(f, "acct_a");
  expect([pressed.status, pressed.body.error?.code]).toEqual([404, "no_admission"]);
  expect(f.devices.account()).toBeNull();
});

test("an answer of the account service that names another account is refused, and nothing is bound", async () => {
  const f = await pc({ accountFetch: async (request, service) => {
    if (new URL(request.url).pathname !== "/v1/pc/admission") return await service.fetch(request);
    const answer = await service.fetch(request);
    const body = await answer.json() as Record<string, unknown>;
    return Response.json({ ...body, account: "acct_other" }, { status: answer.status });
  } });
  await setUpFor(f, "acct_1");
  await admitAt(f, "acct_1");
  const pressed = await press(f, "acct_1");
  expect([pressed.status, pressed.body.error?.code]).toEqual([502, "account_mismatch"]);
  expect(f.devices.account()).toBeNull();
});

test("a device through the relay cannot press, and a watching one cannot either: nothing is bound", async () => {
  const f = await pc();
  await setUpFor(f, "acct_1");
  await admitAt(f, "acct_1");
  const serverId = f.app.context.services.relay.currentIdentity()!.server_id;
  const relayed = async (role: "drive" | "watch") => {
    const response = await handleRequest(new Request("https://relay.ovis.invalid/api/account/one-press", {
      method: "POST", headers: { origin: "https://relay.ovis.invalid", "x-herdr-machine": "1", "content-type": "application/json" }, body: JSON.stringify({ account: "acct_1" }),
    }), { ...f.app.context, peer: { kind: "relay", device: { id: "aaaaaaaaaaaaaaaa", label: "Relay", role }, sessionId: "s", serverId, key: "" }, timeout: () => {} });
    return [response?.status, ((await response!.json()) as { error: { code: string } }).error.code];
  };
  expect(await relayed("drive")).toEqual([403, "owner_only"]);
  expect(await relayed("watch")).toEqual([403, "read_only"]);
  expect(f.devices.account()).toBeNull();
});

test("an open LAN window cannot press", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "ovis-one-press-open-"));
  const app = createServer({ port: 0, hostname: "127.0.0.1", stateDir, token: "", tailscaleOwner: null, machines: false, sidecar: false, accountOpensAll: true });
  try {
    const base = `http://192.168.1.10:${app.port}`;
    const ctx: ServerContext = { ...app.context, requestIP: () => ({ address: "192.168.1.50" }), timeout: () => {}, upgrade: () => false };
    const response = await handleRequest(new Request(`${base}/api/account/one-press`, {
      method: "POST", headers: { host: `192.168.1.10:${app.port}`, origin: base, "x-herdr-machine": "1", "content-type": "application/json" },
      body: JSON.stringify({ account: "acct_1" }),
    }), ctx);
    expect(response?.status).toBe(403);
    expect(((await response!.json()) as { error: { code: string } }).error.code).toBe("owner_only");
    expect(app.context.services.devices.account()).toBeNull();
  } finally {
    app.stop();
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("with the step-2 switch off the PC has no such route", async () => {
  const f = await pc({ server: { accountOpensAll: false } });
  await setUpFor(f, "acct_1");
  const pressed = await press(f, "acct_1");
  expect([pressed.status, pressed.body.error?.code]).toEqual([404, "not_found"]);
  expect(f.devices.account()).toBeNull();
});

test("a PC bound in one press keeps its account when the snapshot route answers 404 (step 2 turned off for the account)", async () => {
  const f = await pc();
  await setUpFor(f, "acct_1");
  await admitAt(f, "acct_1");
  expect((await press(f, "acct_1")).status).toBe(200);
  f.account.opensAll = false;
  await f.app.context.services.accountMailbox.readSnapshot();
  expect(f.devices.account()).toBe("acct_1");
});

test("service unlisting clears one-press status without a screen channel", async () => {
  const f = await pc({ server: { platform: "darwin" } });
  await setUpFor(f, "acct_1");
  await admitAt(f, "acct_1");
  expect((await press(f, "acct_1")).status).toBe(200);
  const serverId = f.app.context.services.relay.currentIdentity()!.server_id;
  expect((await f.account.fetch(new Request(`https://account.test/v1/pcs/${serverId}`, { method: "DELETE",
    headers: { authorization: `Bearer ${f.account.issueToken("acct_1")}` } }))).status).toBe(204);
  await f.app.context.services.accountMailbox.readSnapshot();
  expect(await f.status()).toMatchObject({ account: null });
});

test.skipIf(process.platform !== "linux").each(["herdr-web-ui", "ovis"])("sibling unlisting: offline restart from %s keeps only this PC's pairings", async restartFolder => {
  const screen = new TransformStream<Uint8Array, Uint8Array>();
  const writer = screen.writable.getWriter();
  const legacy = await memberRow("acct_1");
  const { account: _, ...plain } = legacy.row;
  const f = await pc({ rows: [plain], server: { desktopOwner: { input: screen.readable, write() {} } } });
  await setUpFor(f, "acct_1");
  await admitAt(f, "acct_1");
  expect((await press(f, "acct_1")).status).toBe(200);
  const { devices, relay, accountMailbox, localConfirms } = f.app.context.services;
  const serverId = relay.currentIdentity()!.server_id;
  const listed = await phone();
  f.account.registerDevice("acct_1", listed.spki, "Listed only");
  expect(await accountMailbox.readSnapshot()).toMatchObject({ committed: true });
  const link = (id: string, key: string) => expect(devices.linkAccountKey(id, key, key, "acct_1")).not.toBeNull();
  link(plain.id, legacy.key.spki);
  const code = await phone(), localDigits = await phone(), memberDigits = await phone(), memberCode = await phone();
  const coded = devices.pairRelay(devices.startPairing().code, "Local code", code.spki)!;
  link(coded.device.id, code.spki);
  const memberCoded = devices.pairRelay(devices.startPairing().code, "Member code", memberCode.spki)!;
  link(memberCoded.device.id, memberCode.spki);
  expect(devices.originOf(memberCoded.device.id)).toMatchObject({ from: "remote", how: "code", by: null });
  const digits = devices.pairRelayApproved("Local digits", localDigits.spki, { path: "account" })!;
  link(digits.device.id, localDigits.spki);
  const member = devices.pairRelayApproved("Member digits", memberDigits.spki, { path: "account", addedBy: plain.id })!;
  const proof = await provingDevice(f, await f.offerCode());
  await proof.pending;
  const approval = localConfirms!.pending().find(e => e.action.kind === "approve_key")!;
  const admitted = Promise.withResolvers<string>();
  proof.link.onFrame = frame => { if (frame.type === FrameType.AUTH_OK) admitted.resolve(frame.payload.device_id); };
  await writer.write(new TextEncoder().encode(`${JSON.stringify({ approve: approval.id })}\n`));
  const screened = await bounded(admitted.promise);
  link(screened, proof.device.spki);
  expect(devices.originOf(digits.device.id)).toMatchObject({ from: "remote", how: "digits", by: null });
  expect(devices.originOf(member.device.id)).toMatchObject({ from: "remote", how: "member", by: legacy.key.spki });
  await f.app.stop();
  // a code a member device started names that member as `by`: it stood on the account's authority, not this PC's
  const rowsFile = join(f.stateDir, "devices.json");
  const rows = JSON.parse(readFileSync(rowsFile, "utf8")) as { devices: { id: string; origin?: object }[] };
  rows.devices = rows.devices.map(row => row.id === memberCoded.device.id ? { ...row, origin: { ...row.origin, by: legacy.key.spki } } : row);
  writeFileSync(rowsFile, JSON.stringify(rows), { mode: 0o600 });
  const root = mkdtempSync(join(tmpdir(), "unlisting-siblings-"));
  try {
    const active = join(root, "herdr-web-ui"), sibling = join(root, "ovis");
    for (const dest of [active, sibling]) cpSync(f.stateDir, dest, { recursive: true });
    const opts = { port: 0, hostname: "127.0.0.1", token: "", tailscaleOwner: null, registerBridge: false, sidecar: false };
    const bound = createServer({ ...opts, stateDir: active, siblingStateDir: sibling, accountService: { url: "https://account.test", fetch: f.account.fetch } });
    try {
      expect(bound.context.services.devices.account()).toBe("acct_1");
      expect(bound.context.services.devices.serviceBinding()).not.toBeNull();
      expect((await f.account.fetch(new Request(`https://account.test/v1/pcs/${serverId}`, { method: "DELETE",
        headers: { authorization: `Bearer ${f.account.issueToken("acct_1")}` } }))).status).toBe(204);
      await bound.context.services.accountMailbox.readSnapshot();
      expect(bound.context.services.devices.account()).toBeNull();
    } finally { await bound.stop(); }
    const stateDir = join(root, restartFolder);
    const offline = createServer({ ...opts, stateDir, siblingStateDir: stateDir === active ? sibling : active, accountService: { url: "off" } });
    const closes: (() => void)[] = [];
    try {
      const statuses: number[] = [];
      for (const [id, key] of [[plain.id, legacy.key], [coded.device.id, code], [memberCoded.device.id, memberCode], [screened, proof.device],
        [digits.device.id, localDigits], [member.device.id, memberDigits], [accountDeviceId(serverId, listed.spki), listed]] as const) {
        const session = await relayConnection({ app: offline, stateDir, closes, close() {} });
        statuses.push(await session.auth({ id, keys: key.keys, publicKey: key.spki })
          .then(async () => (await ask(session, "/api/devices")).status, () => 401));
      }
      const own = await fetch(`http://127.0.0.1:${offline.port}/api/account/status`);
      expect({ own: own.status, account: (await own.json()).account, statuses }).toEqual({ own: 200, account: null, statuses: [200, 200, 401, 200, 200, 401, 401] });
    } finally { for (const close of closes) close(); await offline.stop(); }
  } finally { rmSync(root, { recursive: true, force: true }); writer.releaseLock(); }
});

test.skipIf(process.platform !== "linux").each([false, true])("service unlisting keeps a locally paired linked phone through offline restart (locked: %s)", async locked => {
  const screen = new TransformStream<Uint8Array, Uint8Array>();
  const writer = screen.writable.getWriter();
  const f = await pc({ server: { desktopOwner: { input: screen.readable, write() {} } } });
  await setUpFor(f, "acct_1");
  await admitAt(f, "acct_1");
  const laptop = await phone();
  f.account.registerDevice("acct_1", laptop.spki, "Laptop");
  expect((await press(f, "acct_1")).status).toBe(200);
  const serverId = f.app.context.services.relay.currentIdentity()!.server_id;
  const listedId = accountDeviceId(serverId, laptop.spki);
  expect(f.devices.has(listedId)).toBe(true);
  const pairing = await provingDevice(f, await f.offerCode());
  await pairing.pending;
  const confirm = f.app.context.services.localConfirms?.pending().find(e => e.action.kind === "approve_key");
  if (!confirm) throw new Error("Missing local pairing approval");
  const admitted = Promise.withResolvers<string>();
  pairing.link.onFrame = frame => { if (frame.type === FrameType.AUTH_OK) admitted.resolve(frame.payload.device_id); };
  await writer.write(new TextEncoder().encode(`${JSON.stringify({ approve: confirm.id })}\n`));
  const id = await bounded(admitted.promise);
  await vouchFor(f, "acct_1", pairing.device);
  expect((await sendLink(pairing.link, await linkRecord(id, "acct_1", pairing.device))).status).toBe(200);
  expect(f.stored().find(d => d.id === id)).toMatchObject({ account: "acct_1", origin: { from: "pc" } });
  const lock = locked ? f.app.context.services.safetyLog!.appendLock({ account: "acct_1" }).id : null;
  const removed = await f.account.fetch(new Request(`https://account.test/v1/pcs/${serverId}`, { method: "DELETE", headers: { authorization: `Bearer ${f.account.issueToken("acct_1")}` } }));
  expect(removed.status).toBe(204);
  await f.app.context.services.accountMailbox.readSnapshot();
  expect(f.devices.account()).toBeNull();
  expect(f.devices.has(listedId)).toBe(false);
  const atClear = f.stored().find(d => d.id === id);
  await f.app.context.services.relay.stop();
  await f.app.stop();
  const offline = createServer({ stateDir: f.stateDir, port: 0, hostname: "127.0.0.1", token: "", tailscaleOwner: null,
    registerBridge: false, sidecar: false, accountService: { url: "off" } });
  const closes: (() => void)[] = [];
  try {
    const base = `http://127.0.0.1:${offline.port}`;
    const local = await fetch(`${base}/api/devices`);
    const signed = await relayConnection({ stateDir: f.stateDir, app: offline, closes, close() {} });
    const pairedStatus = await signed.auth({ id, keys: pairing.device.keys, publicKey: pairing.device.spki })
      .then(async () => (await ask(signed, "/api/devices")).status, () => 401);
    expect({ pairedStatus, local: local.status, account: atClear?.account, linked: atClear?.linked_at,
      stored: atClear?.id }).toEqual({ pairedStatus: 200, local: locked ? 403 : 200, account: undefined, linked: undefined, stored: id });
    expect(offline.context.services.devices.accountError).toBeNull();
    const listed = await relayConnection({ stateDir: f.stateDir, app: offline, closes, close() {} });
    await expect(listed.auth({ id: listedId, keys: laptop.keys, publicKey: laptop.spki })).rejects.toThrow();
    if (lock !== null) {
      expect(await local.json()).toMatchObject({ error: { code: "locked" } });
      expect(await (await fetch(`${base}/api/account/lock`)).json()).toMatchObject({ locked: lock, bound: false });
      expect((await fetch(`${base}/api/account/unlock`, { method: "POST", headers: { origin: base, "x-herdr-machine": "1" },
        body: JSON.stringify({ lock }) })).status).toBe(202);
    }
  } finally { for (const close of closes) close(); await offline.stop(); writer.releaseLock(); }
});

test("first-PC exemption: an account never used, signed in with Google whose two-step is unknown, adds its first PC in one press", async () => {
  const f = await pc();
  await setUpFor(f, "acct_new");
  await admitAt(f, "acct_new", null);
  expect((await press(f, "acct_new")).status).toBe(200);
  expect(f.devices.account()).toBe("acct_new");
});

// account#62: device keys count only once the account had a confirmed or admitted PC, since a person may sign in on the
// phone first; the fake's own tests hold that they count from then on (shared/account-service-fake.test.ts)
test("first-PC exemption: an account whose only device key (revoked included) came before any PC adds its first PC in one press", async () => {
  const f = await pc();
  await setUpFor(f, "acct_phone_first");
  const keys = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
  const key = await exportAccountKey(keys.publicKey);
  f.account.registerDevice("acct_phone_first", key, "Old phone");
  f.account.removeDevice("acct_phone_first", key);
  await admitAt(f, "acct_phone_first", null);
  expect((await press(f, "acct_phone_first")).status).toBe(200);
  expect(f.devices.account()).toBe("acct_phone_first");
});

test("a LAN window holding the access token, or any window that is not this PC's own, cannot press", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "ovis-one-press-token-"));
  const app = createServer({ port: 0, hostname: "127.0.0.1", stateDir, token: "secret-token", tailscaleOwner: null, machines: false, sidecar: false, accountOpensAll: true });
  try {
    const base = `http://192.168.1.10:${app.port}`;
    const ctx: ServerContext = { ...app.context, requestIP: () => ({ address: "192.168.1.50" }), timeout: () => {}, upgrade: () => false };
    const response = await handleRequest(new Request(`${base}/api/account/one-press`, {
      method: "POST", headers: { host: `192.168.1.10:${app.port}`, origin: base, authorization: "Bearer secret-token", "x-herdr-machine": "1", "content-type": "application/json" },
      body: JSON.stringify({ account: "acct_1" }),
    }), ctx);
    expect(response?.status).toBe(403);
    expect(((await response!.json()) as { error: { code: string } }).error.code).toBe("owner_only");
    expect(app.context.services.devices.account()).toBeNull();
  } finally {
    app.stop();
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("a press whose PC is named for another account while the service answers binds nothing", async () => {
  let rename: (() => Promise<void>) | null = null;
  const f = await pc({ accountFetch: async (request, service) => {
    if (new URL(request.url).pathname === "/v1/pc/admission" && rename !== null) { const now = rename; rename = null; await now(); }
    return await service.fetch(request);
  } });
  await setUpFor(f, "acct_a");
  await admitAt(f, "acct_a");
  rename = () => setUpFor(f, "acct_b");
  const pressed = await press(f, "acct_a");
  expect([pressed.status, pressed.body.error?.code]).toEqual([409, "account_mismatch"]);
  expect(f.devices.account()).toBeNull();
});

test("a not_listed that answers a read begun under an earlier binding never clears a binding made since", async () => {
  let rebind = false;
  const f = await pc({ accountFetch: async (request, service) => {
    if (rebind && new URL(request.url).pathname === "/v1/pc/snapshot") {
      rebind = false;
      // the PC left and was added again in one press while this read was on its way
      f.devices.clearAccountBinding("unlisted", "test");
      f.devices.bindByService("acct_1");
      return Response.json({ error: { code: "not_listed", message: "gone" } }, { status: 403 });
    }
    return await service.fetch(request);
  } });
  await setUpFor(f, "acct_1");
  await admitAt(f, "acct_1");
  expect((await press(f, "acct_1")).status).toBe(200);
  const first = f.devices.serviceBinding();
  rebind = true;
  await f.app.context.services.accountMailbox.readSnapshot();
  expect(f.devices.account()).toBe("acct_1");
  expect(f.devices.serviceBinding()).not.toBe(first);
});

test("first-PC exemption: a device key the admitting sign-in registered itself does not count as the account being used", async () => {
  const f = await pc();
  await setUpFor(f, "acct_own");
  const identity = f.app.context.services.relay.currentIdentity()!;
  const token = f.account.issueToken("acct_own", { twoStep: null });
  const keys = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
  f.account.registerSessionKey(token, await exportAccountKey(keys.publicKey), "This browser");
  const call = (path: string, method: string, body: unknown) => f.account.fetch(new Request(`https://account.test${path}`, { method, headers: { authorization: `Bearer ${token}` }, body: JSON.stringify(body) }));
  expect((await call(`/v1/pcs/${identity.server_id}`, "PUT", { label: "PC", public_key: bytesToHex(importPublicKey(identity.public_key)), relay: "wss://relay.ovis.sh" })).ok).toBe(true);
  expect((await call(`/v1/pcs/${identity.server_id}/admit`, "POST", {})).status).toBe(200);
  expect((await press(f, "acct_own")).status).toBe(200);
});

test("a press whose PC the account removes during its first read answers no success, and the PC is in no account", async () => {
  let remove = false;
  const f = await pc({ accountFetch: async (request, service) => {
    if (remove && new URL(request.url).pathname === "/v1/pc/snapshot") {
      remove = false;
      const serverId = f.app.context.services.relay.currentIdentity()!.server_id;
      await service.fetch(new Request(`https://account.test/v1/pcs/${serverId}`, { method: "DELETE", headers: { authorization: `Bearer ${service.issueToken("acct_1")}` } }));
    }
    return await service.fetch(request);
  } });
  await setUpFor(f, "acct_1");
  await admitAt(f, "acct_1");
  remove = true;
  const pressed = await press(f, "acct_1");
  expect([pressed.status, pressed.body.error?.code]).toEqual([409, "not_listed"]);
  expect(f.devices.account()).toBeNull();
});

test("a not_listed refusal of anything but the snapshot route never unbinds a PC bound in one press", async () => {
  let refuseChallenge = false;
  const f = await pc({ accountFetch: async (request, service) => {
    if (refuseChallenge && new URL(request.url).pathname === "/v1/pc/challenge") return Response.json({ error: { code: "not_listed", message: "x" } }, { status: 403 });
    return await service.fetch(request);
  } });
  await setUpFor(f, "acct_1");
  await admitAt(f, "acct_1");
  expect((await press(f, "acct_1")).status).toBe(200);
  refuseChallenge = true;
  await f.app.context.services.accountMailbox.readSnapshot();
  expect(f.devices.account()).toBe("acct_1");
});

test("PADD-1: a Revoke all that finishes while the press waits on the account service binds nothing", async () => {
  let revoke: (() => void) | null = null;
  const f = await pc({ accountFetch: async (request, service) => {
    if (new URL(request.url).pathname === "/v1/pc/admission" && revoke !== null) { const now = revoke; revoke = null; now(); }
    return await service.fetch(request);
  } });
  await setUpFor(f, "acct_1");
  await admitAt(f, "acct_1");
  revoke = () => { f.devices.revokeAll(); };
  const pressed = await press(f, "acct_1");
  expect(pressed.status).toBe(409);
  expect(f.devices.account()).toBeNull();
});

test("first-PC exemption: the same sign-in may repeat its admit before the PC reads it, and gets the same admission", async () => {
  const f = await pc();
  // an account service that asks a used account's admit for two-step, as until 2026-11-23
  f.account.admitAsksTwoStep = true;
  await setUpFor(f, "acct_retry");
  const identity = f.app.context.services.relay.currentIdentity()!;
  const token = f.account.issueToken("acct_retry", { twoStep: null });
  const call = (path: string, method: string, body: unknown) => f.account.fetch(new Request(`https://account.test${path}`, { method, headers: { authorization: `Bearer ${token}` }, body: JSON.stringify(body) }));
  expect((await call(`/v1/pcs/${identity.server_id}`, "PUT", { label: "PC", public_key: bytesToHex(importPublicKey(identity.public_key)), relay: "wss://relay.ovis.sh" })).ok).toBe(true);
  const first = await (await call(`/v1/pcs/${identity.server_id}/admit`, "POST", {})).json() as { admitted_at: string };
  const again = await call(`/v1/pcs/${identity.server_id}/admit`, "POST", {});
  expect(again.status).toBe(200);
  expect(((await again.json()) as { admitted_at: string }).admitted_at).toBe(first.admitted_at);
  // another sign-in of the account gets no exemption of its own
  const other = f.account.issueToken("acct_retry", { twoStep: null });
  expect((await f.account.fetch(new Request(`https://account.test/v1/pcs/${identity.server_id}/admit`, { method: "POST", headers: { authorization: `Bearer ${other}` }, body: "{}" }))).status).toBe(403);
  expect((await press(f, "acct_retry")).status).toBe(200);
});

test("PADD-1: a relay identity reset that finishes while the press waits on the account service binds nothing", async () => {
  let reset: (() => Promise<void>) | null = null;
  const f = await pc({ accountFetch: async (request, service) => {
    if (new URL(request.url).pathname === "/v1/pc/admission" && reset !== null) { const now = reset; reset = null; const answer = await service.fetch(request); await now(); return answer; }
    return await service.fetch(request);
  } });
  await setUpFor(f, "acct_1");
  await admitAt(f, "acct_1");
  const before = f.app.context.services.relay.currentIdentity()!.server_id;
  reset = async () => { await f.app.context.services.relay.resetIdentity(); };
  const pressed = await press(f, "acct_1");
  expect(f.app.context.services.relay.currentIdentity()?.server_id).not.toBe(before);
  expect([pressed.status, pressed.body.error?.code]).toEqual([409, "identity_changed"]);
  expect(f.devices.account()).toBeNull();
});
