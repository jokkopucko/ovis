/**
 * A sign-in by a key this PC in an account holds no row for (a device the account let in that this PC has not read
 * yet): while no read of the account that began after the key first asked here has finished, a client that knows the
 * account codes is told the PC is catching up, and waits; once such a read finished without the key, it is refused.
 * Whom the PC lets in does not change: the key gets in only by a row a read brought.
 */
import { afterEach, expect, spyOn, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { bytesToHex } from "@noble/hashes/utils.js";
import { FakeAccountService } from "../../shared/account-service-fake.ts";
import { importPublicKey } from "../../shared/relay-e2ee.ts";
import { ACCOUNT_OPENS_ALL_FEATURE, FrameType, type MuxFrame } from "../../shared/relay-mux.ts";
import { rotateRelayIdentity } from "../relay/identity.ts";
import { bounded, relayAccountFixture, relayConnection, relayFixture } from "../relay/test-helpers.ts";
import { PcAccountState } from "./pc-binding.ts";

const ACCOUNT = "acct_1";
const closes: (() => void)[] = [];
afterEach(() => { for (const close of closes.splice(0).reverse()) close(); });

/**
 * A PC in ACCOUNT. `ready` makes its account service give whole reads; `down` makes it answer every call 503, as a
 * service under load does, so no read of the account succeeds; `snapshot` answers the snapshot route alone that way.
 */
async function pcInAccount(service: { url: string; fetch?: (request: Request) => Promise<Response> } | null = null) {
  const fake = new FakeAccountService();
  const reach: { down: boolean; snapshot?: Response | undefined } = { down: false };
  const fetchService = async (request: Request) => reach.down ? Response.json({ error: { code: "unavailable" } }, { status: 503 })
    : reach.snapshot !== undefined && new URL(request.url).pathname === "/v1/pc/snapshot" ? reach.snapshot.clone() : await fake.fetch(request);
  const { fixture, member } = await relayAccountFixture("drive", ACCOUNT, {
    accountOpensAll: true, accountService: service ?? { url: "https://account.test", fetch: fetchService },
    prepare: (stateDir) => { const pc = PcAccountState.open(stateDir); pc.migrate(ACCOUNT, true); pc.admit("remote", "code", null, Date.now()); },
    origin: (at) => ({ from: "remote", how: "code", by: null, admit_no: 1, at }),
  });
  closes.push(() => fixture.close());
  rotateRelayIdentity(fixture.stateDir);
  const identity = fixture.app.context.services.relay.currentIdentity()!;
  await fake.fetch(new Request(`https://account.test/v1/pcs/${identity.server_id}`, { method: "PUT", headers: { authorization: `Bearer ${fake.issueToken(ACCOUNT)}` },
    body: JSON.stringify({ label: "PC", public_key: bytesToHex(importPublicKey(identity.public_key)), relay: "wss://relay.ovis.sh" }) }));
  // the start's own pull is over before the test signs in, so no read is under way
  await fixture.app.context.services.accountMailbox.pull();
  const { devices, accountMailbox } = fixture.app.context.services;
  return { fixture, member, serverId: identity.server_id, reach, devices, mailbox: accountMailbox, ready: () => { fake.opensAll = true; } };
}

/** A device key this PC has never seen, signing in under an id of its own (or the id given). */
async function stranger(id = randomBytes(8).toString("hex")) {
  const keys = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
  const publicKey = Buffer.from(await crypto.subtle.exportKey("spki", keys.publicKey)).toString("base64url");
  return { keys, publicKey, id };
}

async function signIn(pc: { fixture: ReturnType<typeof relayFixture>; serverId: string }, device: Awaited<ReturnType<typeof stranger>>, features: readonly string[] = [ACCOUNT_OPENS_ALL_FEATURE]) {
  const link = await relayConnection(pc.fixture, { serverId: pc.serverId });
  let failed: Extract<MuxFrame, { type: typeof FrameType.SESSION_ERROR }>["payload"] | undefined;
  let ok = false;
  link.onFrame = (frame) => {
    if (frame.type === FrameType.SESSION_ERROR) failed = frame.payload;
    if (frame.type === FrameType.AUTH_OK) ok = true;
  };
  await bounded(link.auth(device, features).then(() => undefined, () => undefined), 20_000);
  return ok ? "ok" : failed;
}

const CATCHING_UP = { code: "held", message: "This PC waits for the account's list before letting this device in", hold: { reason: "catching_up" } } as const;
const REFUSED = { code: "auth_failed" } as const;

/** Date.now as the test moves it. */
function testTime() {
  let now = Date.now();
  const spy = spyOn(Date, "now").mockImplementation(() => now);
  closes.push(() => spy.mockRestore());
  return { advance(ms: number) { now += ms; } };
}

test("a key with no row, while no read of the account has finished since it first asked, waits: catching_up", async () => {
  const pc = await pcInAccount();
  const device = await stranger();
  pc.ready();
  // the account service answers 503: the read this sign-in starts reads nothing
  pc.reach.down = true;
  expect(await signIn(pc, device)).toEqual(CATCHING_UP);
  // and so while no read gets through
  expect(await signIn(pc, device)).toEqual(CATCHING_UP);
});

test("a key with no row is refused once a read that began after it first asked finished without it", async () => {
  const pc = await pcInAccount();
  const device = await stranger();
  pc.ready();
  expect(await signIn(pc, device)).toMatchObject(REFUSED);
});

test("a pull whose read of the account's rows failed is no read: the key still waits, though the mailbox was read", async () => {
  const pc = await pcInAccount();
  const device = await stranger();
  pc.ready();
  pc.reach.snapshot = Response.json({ error: { code: "unavailable" } }, { status: 503 });
  expect(await signIn(pc, device)).toEqual(CATCHING_UP);
  // the next whole read finds no row for it: refused
  pc.reach.snapshot = undefined;
  await pc.mailbox.pull();
  expect(await signIn(pc, device)).toMatchObject(REFUSED);
});

test("a service that reads no rows by its own word (step2_off) is a whole read: the key is refused as before", async () => {
  const pc = await pcInAccount();
  const device = await stranger();
  pc.ready();
  pc.reach.snapshot = Response.json({ error: { code: "step2_off" } }, { status: 404 });
  expect(await signIn(pc, device)).toMatchObject(REFUSED);
});

test("the read a sign-in starts itself refuses it, also in the millisecond it first asked", async () => {
  const time = testTime();
  const pc = await pcInAccount();
  const device = await stranger();
  pc.ready();
  // the start's read is a second before; then the clock stands: the key's first ask and the read it starts share one millisecond
  time.advance(1_000);
  expect(await signIn(pc, device)).toMatchObject(REFUSED);
});

test("a read that began before the key first asked does not refuse it: only one after it does", async () => {
  const pc = await pcInAccount();
  const device = await stranger();
  pc.ready();
  // a read finished just before the key asked, and none can start for the next minute
  await pc.mailbox.pull();
  await pc.mailbox.pullForRefusedSignIn(0);
  const started = spyOn(pc.mailbox, "pull");
  try {
    expect(await signIn(pc, device)).toEqual(CATCHING_UP);
    expect(started).not.toHaveBeenCalled();
  } finally { started.mockRestore(); }
});

test("an id with a row and a proof that does not hold is answered as an id with none: the answer tells nobody which ids have a row", async () => {
  const pc = await pcInAccount();
  pc.ready();
  // the minute's sign-in read is spent, as a peer can arrange with a junk id first
  await pc.mailbox.pullForRefusedSignIn(0);
  // the member's real id, signed with a key that is not its own, and an id this PC never saw
  const known = await signIn(pc, await stranger(pc.member.id));
  const unknown = await signIn(pc, await stranger());
  expect(known).toEqual(unknown);
  expect(known).toEqual(CATCHING_UP);
});

test("no wait is told while no read can come: an account service turned off answers every unknown key as before", async () => {
  const pc = await pcInAccount({ url: "off" });
  const device = await stranger();
  for (let tries = 0; tries < 2; tries++) {
    expect(await signIn(pc, device)).toMatchObject(REFUSED);
    await pc.mailbox.pull();
  }
});

test("a key's wait ends three minutes after its first ask with no read since: refused, and the wait does not start again", async () => {
  const time = testTime();
  const pc = await pcInAccount();
  const device = await stranger();
  pc.ready();
  pc.reach.down = true;
  // the key first asks after the start's read
  time.advance(1_000);
  expect(await signIn(pc, device)).toEqual(CATCHING_UP);
  time.advance(2 * 60_000);
  expect(await signIn(pc, device)).toEqual(CATCHING_UP);
  time.advance(60_000 + 1_000);
  expect(await signIn(pc, device)).toMatchObject(REFUSED);
  time.advance(60_000);
  expect(await signIn(pc, device)).toMatchObject(REFUSED);
});

test("a flood of new ids pushes no key's first ask out: once the memory is full, a new id is answered as before", async () => {
  const pc = await pcInAccount();
  const device = await stranger();
  pc.ready();
  pc.reach.down = true;
  expect(await signIn(pc, device)).toEqual(CATCHING_UP);
  const first = pc.mailbox.askedFirst(device.id);
  for (let flood = 0; flood < 600; flood++) pc.mailbox.askedFirst(randomBytes(8).toString("hex"));
  expect(pc.mailbox.askedFirst(device.id)).toBe(first);
  expect(await signIn(pc, await stranger())).toMatchObject(REFUSED);
});

test("refused as before: a client that does not know the account codes, a PC in no account, a pinned PC, a PC that fails closed", async () => {
  const pc = await pcInAccount();
  pc.ready();
  pc.reach.down = true;
  expect(await signIn(pc, await stranger(), [])).toMatchObject(REFUSED);
  const pinned = spyOn(pc.devices, "listFollowed").mockReturnValue(true);
  try { expect(await signIn(pc, await stranger())).toMatchObject(REFUSED); } finally { pinned.mockRestore(); }
  // a PC whose devices fail closed (its own record of them unreadable): an own getter over the store's, taken away after
  Object.defineProperty(pc.devices, "failsClosed", { configurable: true, get: () => true });
  try { expect(await signIn(pc, await stranger())).toMatchObject(REFUSED); } finally { Reflect.deleteProperty(pc.devices, "failsClosed"); }
  const alone = relayFixture(false, { accountOpensAll: true });
  closes.push(() => alone.close());
  expect(await signIn({ fixture: alone, serverId: "0123456789abcdef0123456789abcdef" }, await stranger())).toMatchObject(REFUSED);
});
