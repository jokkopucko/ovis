/**
 * A pairing code made for an account (POST /api/relay/offer and POST /api/relay/code with `x-ovis-expect-account`;
 * docs/account.md, "A code made for an account"): a device that pairs with it waits to link, as with the relay tab's
 * code, and only a link into that account makes it a device of the PC. No test sleeps: the clock a waiting device is
 * bounded on is moved by hand, and every wait is for the event its line names, bounded.
 */
import { afterEach, expect, spyOn, test } from "bun:test";
import { decodeOffer } from "../../shared/relay-offer.ts";
import { CODE_TTL_MS, PAIRING_LINK_MS, PAIRING_USES } from "../devices.ts";
import { handleRelayRequest } from "../relay/routes.ts";
import { TestClock } from "../relay/test-helpers.ts";
import { ask, ended, linkRecord, memberRow, pair, pairingPc, phone, sendLink, setUpFor, signedInWith, signIn, vouchFor, type Answer, type Pc } from "./pairing.test-helpers.ts";

const pcs: Pc[] = [];
afterEach(async () => {
  for (const pc of pcs.splice(0)) await pc.close();
});

async function pc(options: Parameters<typeof pairingPc>[0] = {}) {
  const made = await pairingPc(options);
  pcs.push(made);
  const clock = new TestClock();
  made.devices.useClock(clock);
  return Object.assign(made, { clock });
}

/** POST `path` (the offer by default) as this PC's own page or command does, naming `account` in the header. */
const forAccount = (f: Pc, account: string, path = "/api/relay/offer") =>
  f.local(path, { method: "POST", headers: { "x-herdr-update": "1", "x-ovis-expect-account": account } });

/** The six-digit code an offer's answer carries. */
function codeOf(answer: Answer): string {
  const code = typeof answer.body.url === "string" ? decodeOffer(answer.body.url)?.code : undefined;
  if (answer.status !== 200 || code === undefined) throw new Error(`The offer gave no code: ${answer.status} ${JSON.stringify(answer.body)}`);
  return code;
}

const idOf = (answer: Answer) => (answer.body.pairing as { id: string }).id;

/** The read of a code made for an account by its id. */
const state = async (f: Pc, id: unknown) => (await f.local("/api/relay/offer/keep", { method: "POST", headers: { "x-herdr-update": "1" }, body: { id } })).body;

test("a code made for an account: its answer repeats the account and names it; a device that links into another account goes and the code stays, and one of that account joins with it", async () => {
  const f = await pc();
  const offer = await forAccount(f, "acct_owner");
  expect(offer.status).toBe(200);
  expect(offer.body.expect_account).toBe("acct_owner");
  expect(idOf(offer)).toMatch(/^[0-9a-f]{32}$/);
  const code = codeOf(offer);
  expect(await state(f, idOf(offer))).toEqual({ state: "live", id: idOf(offer), expect_account: "acct_owner", expires_at: offer.body.expires_at, waiting: [], turned_away: [], service_retry_ms: 0 });
  // the device that pairs with it waits to link: no device of the PC, and it may not use the PC
  const other = await signedInWith(f, code);
  expect(other.role).toBe("watch");
  expect(await f.listed()).toEqual([]);
  expect([(await ask(other.session, "/api/devices")).body.error?.code]).toEqual(["link_required"]);
  const refused = await sendLink(other.session, await linkRecord(other.id, "acct_other", other.key));
  expect([refused.status, refused.body.error?.code]).toEqual([409, "account_mismatch"]);
  expect(JSON.stringify(refused.body)).not.toContain("acct_owner");
  expect([await ended(other.session), await ended(other.pairing)]).toEqual(["auth_revoked", "auth_revoked"]);
  expect(await signIn(f, other.id, other.key)).toEqual({ error: "auth_failed" });
  expect(await f.status()).toMatchObject({ account: null, members: 0, unlinked: [] });
  expect(f.stored()).toEqual([]);
  // the same code, still pending: the device of the account it was made for joins with it
  expect(f.devices.activePairing()?.code).toBe(code);
  expect(await state(f, idOf(offer))).toMatchObject({ state: "live" });
  const owner = await signedInWith(f, code);
  await vouchFor(f, "acct_owner", owner.key);
  expect((await sendLink(owner.session, await linkRecord(owner.id, "acct_owner", owner.key))).status).toBe(200);
  expect(await f.status()).toMatchObject({ account: "acct_owner", members: 1 });
  expect(f.stored().map((device) => [device.id, device.account])).toEqual([[owner.id, "acct_owner"]]);
  expect(await state(f, idOf(offer))).toMatchObject({ state: "ended", id: idOf(offer), expect_account: "acct_owner", ended: { why: "joined" }, joined: { device_id: owner.id } });
});

test("a code made for an account takes its devices into that account alone, whatever account was named for the PC", async () => {
  const f = await pc();
  await setUpFor(f, "acct_named");
  const code = codeOf(await forAccount(f, "acct_owner"));
  const named = await signedInWith(f, code);
  const refused = await sendLink(named.session, await linkRecord(named.id, "acct_named", named.key));
  expect([refused.status, refused.body.error?.code]).toEqual([409, "account_mismatch"]);
  expect(await f.status()).toMatchObject({ account: null, members: 0 });
  const owner = await signedInWith(f, code);
  await vouchFor(f, "acct_owner", owner.key);
  expect((await sendLink(owner.session, await linkRecord(owner.id, "acct_owner", owner.key))).status).toBe(200);
  expect(await f.status()).toMatchObject({ account: "acct_owner", members: 1 });
});

test("its devices wait as the relay tab's do: one that has not linked in time goes, and the code ends once its five pairings are spent", async () => {
  const f = await pc();
  const offer = await forAccount(f, "acct_owner");
  const code = codeOf(offer);
  const late = await signedInWith(f, code);
  f.clock.advance(PAIRING_LINK_MS);
  expect([await ended(late.session), await ended(late.pairing)]).toEqual(["auth_revoked", "auth_revoked"]);
  expect(await state(f, idOf(offer))).toMatchObject({ state: "live" });
  for (let use = 1; use < PAIRING_USES; use++) {
    const made = await pair(f, code, await phone());
    if ("error" in made) throw new Error(`The pairing was refused: ${made.error}`);
  }
  f.clock.advance(PAIRING_LINK_MS);
  expect(await state(f, idOf(offer))).toMatchObject({ state: "ended", ended: { why: "overused" } });
  expect("joined" in await state(f, idOf(offer))).toBe(false);
  expect(f.devices.activePairing()).toBeNull();
  expect(await f.listed()).toEqual([]);
});

for (const between of ["nothing", "a read of the code", "a pairing that came too late"] as const) {
  test(`a device that paired before its code ran out still links in its own ${PAIRING_LINK_MS / 1000} seconds, with ${between} in between`, async () => {
    const f = await pc();
    const offer = await forAccount(f, "acct_owner");
    const owner = await signedInWith(f, codeOf(offer));
    spyOn(Date, "now").mockReturnValue(Date.parse(String(offer.body.expires_at)) + 1);
    try {
      if (between === "a read of the code") expect(await state(f, idOf(offer))).toMatchObject({ state: "live" });
      // the code pairs no new device once its ten minutes are over
      if (between === "a pairing that came too late") expect(await pair(f, codeOf(offer), await phone())).toMatchObject({ error: "auth_failed" });
      // its account vouched for it (docs/account.md, "The account's word")
      await vouchFor(f, "acct_owner", owner.key);
      f.clock.advance(PAIRING_LINK_MS - 1);
      expect((await sendLink(owner.session, await linkRecord(owner.id, "acct_owner", owner.key))).status).toBe(200);
      expect(await f.status()).toMatchObject({ account: "acct_owner", members: 1 });
      expect(await state(f, idOf(offer))).toMatchObject({ state: "ended", ended: { why: "joined" }, joined: { device_id: owner.id } });
    } finally { (Date.now as unknown as { mockRestore(): void }).mockRestore(); }
  });
}

test("a code kept past its ten minutes for a device that paired with it in time pairs no new device when the wall clock is set back", async () => {
  const f = await pc();
  const offer = await forAccount(f, "acct_owner");
  const code = codeOf(offer);
  const expires = Date.parse(String(offer.body.expires_at));
  // the device of the account pairs a second before the code's ten minutes are over, on the store's clock
  f.clock.advance(CODE_TTL_MS - 1000);
  const owner = await signedInWith(f, code);
  f.clock.advance(2000);
  const wall = spyOn(Date, "now").mockReturnValue(expires + 1);
  try {
    expect(await pair(f, code, await phone())).toMatchObject({ error: "auth_failed" });
    // the wall clock is set back to before the code's expiry: the code is past its ten minutes all the same
    wall.mockReturnValue(expires - 60_000);
    expect(await pair(f, code, await phone())).toMatchObject({ error: "auth_failed" });
    // the device that paired in time still links in its own seconds, on its account's word (docs/account.md, "The account's word")
    await vouchFor(f, "acct_owner", owner.key);
    expect((await sendLink(owner.session, await linkRecord(owner.id, "acct_owner", owner.key))).status).toBe(200);
    expect(await f.status()).toMatchObject({ account: "acct_owner", members: 1 });
  } finally { wall.mockRestore(); }
});

test("a code that the wall clock once put past its ten minutes pairs no new device when that clock is set back, while the device that paired in time still links", async () => {
  const f = await pc();
  const offer = await forAccount(f, "acct_owner");
  const code = codeOf(offer);
  const expires = Date.parse(String(offer.body.expires_at));
  // the device of the account pairs in time; the store's clock stays well inside the code's ten minutes
  const owner = await signedInWith(f, code);
  const wall = spyOn(Date, "now").mockReturnValue(expires + 1);
  try {
    expect(await pair(f, code, await phone())).toMatchObject({ error: "auth_failed" });
    // the wall clock is set back to before the code's expiry: the code stays past its ten minutes
    wall.mockReturnValue(expires - 60_000);
    expect(await pair(f, code, await phone())).toMatchObject({ error: "auth_failed" });
    // the device that paired in time still links in its own seconds, on its account's word (docs/account.md, "The account's word")
    await vouchFor(f, "acct_owner", owner.key);
    expect((await sendLink(owner.session, await linkRecord(owner.id, "acct_owner", owner.key))).status).toBe(200);
    expect(await f.status()).toMatchObject({ account: "acct_owner", members: 1 });
  } finally { wall.mockRestore(); }
});

test("a code whose ten minutes are over ends expired once the last device that paired with it in time has had its seconds", async () => {
  const f = await pc();
  const offer = await forAccount(f, "acct_owner");
  const late = await signedInWith(f, codeOf(offer));
  spyOn(Date, "now").mockReturnValue(Date.parse(String(offer.body.expires_at)) + 1);
  try {
    expect(await state(f, idOf(offer))).toMatchObject({ state: "live" });
    f.clock.advance(PAIRING_LINK_MS);
    expect([await ended(late.session), await ended(late.pairing)]).toEqual(["auth_revoked", "auth_revoked"]);
    expect(await state(f, idOf(offer))).toMatchObject({ state: "ended", ended: { why: "expired" } });
    expect("joined" in await state(f, idOf(offer))).toBe(false);
    expect(f.devices.activePairing()).toBeNull();
  } finally { (Date.now as unknown as { mockRestore(): void }).mockRestore(); }
});

test("a PC in an account makes no code for an account, on the offer and on the typed code, and the code pending stays", async () => {
  const f = await pc({ rows: [(await memberRow("acct_1")).row] });
  const pending = f.devices.startPairing().code;
  for (const path of ["/api/relay/offer", "/api/relay/code"]) {
    const refused = await forAccount(f, "acct_1", path);
    expect([path, refused.status, refused.body.error?.code]).toEqual([path, 409, "in_account"]);
  }
  expect(f.devices.activePairing()?.code).toBe(pending);
  // without the header the typed code answers as before: this relay takes none
  const plain = await f.local("/api/relay/code", { method: "POST", headers: { "x-herdr-update": "1" } });
  expect([plain.status, plain.body.error?.code]).toEqual([409, "code_unavailable"]);
});

test("a header that names no account is refused, and the code pending stays", async () => {
  const f = await pc();
  const pending = f.devices.startPairing().code;
  for (const path of ["/api/relay/offer", "/api/relay/code"]) {
    for (const account of ["not an id", "acct/1", "a".repeat(65)]) {
      const refused = await forAccount(f, account, path);
      expect([path, account, refused.status, refused.body.error?.code]).toEqual([path, account, 400, "invalid_account"]);
    }
  }
  expect(f.devices.activePairing()?.code).toBe(pending);
});

test("an offer for the same account gets the same code; one for another account, an offer without the header and the relay tab's offer each start their own", async () => {
  const f = await pc();
  await setUpFor(f, "acct_named");
  const first = await forAccount(f, "acct_owner");
  const again = await forAccount(f, "acct_owner");
  expect([codeOf(again), idOf(again)]).toEqual([codeOf(first), idOf(first)]);
  const another = await forAccount(f, "acct_other");
  expect(codeOf(another)).not.toBe(codeOf(first));
  expect(idOf(another)).not.toBe(idOf(first));
  expect(await state(f, idOf(first))).toMatchObject({ state: "ended", expect_account: "acct_owner", ended: { why: "replaced" } });
  // an offer without the header answers what it always did and names its code by its id, and carries a code of its own
  const plain = await f.local("/api/relay/offer", { method: "POST", headers: { "x-herdr-update": "1" } });
  expect(Object.keys(plain.body).sort()).toEqual(["expires_at", "pairing", "url"]);
  expect(codeOf(plain)).not.toBe(codeOf(another));
  expect(await state(f, idOf(another))).toMatchObject({ state: "ended", ended: { why: "replaced" } });
  // the relay tab's code is the account named for the PC's, never the code made for one account
  const owner = await forAccount(f, "acct_owner");
  const tab = await f.tabCode();
  expect(tab).not.toBe(codeOf(owner));
  expect(await state(f, idOf(owner))).toMatchObject({ state: "ended", ended: { why: "replaced" } });
  // and with the relay tab's code pending, an offer for an account starts its own
  expect(codeOf(await forAccount(f, "acct_owner"))).not.toBe(tab);
});

test("an offer that names a code another code replaced since starts none: the code pending and the device that waits under it stay", async () => {
  const f = await pc();
  const mine = f.devices.startAccountPairing("acct_owner").pairing.id;
  // another run makes its code after this one, and a device pairs with it and waits to link
  const theirs = f.devices.startAccountPairing("acct_owner");
  const waiting = await signedInWith(f, theirs.code);
  const offer = (headers: Record<string, string>) => f.local("/api/relay/offer", { method: "POST", headers: { "x-herdr-update": "1", ...headers } });
  for (const headers of [{ "x-ovis-expect-account": "acct_owner", "x-ovis-pairing": mine }, { "x-ovis-pairing": mine }] as Record<string, string>[]) {
    const refused = await offer(headers);
    expect([refused.status, refused.body.error?.code]).toEqual([409, "pairing_gone"]);
  }
  expect(f.devices.activePairing()?.code).toBe(theirs.code);
  expect(await state(f, theirs.pairing.id)).toMatchObject({ state: "live" });
  expect((await ask(waiting.session, "/api/devices")).body.error?.code).toBe("link_required");
  // the device that waited links with the other run's code, on its account's word (docs/account.md, "The account's word")
  await vouchFor(f, "acct_owner", waiting.key);
  expect((await sendLink(waiting.session, await linkRecord(waiting.id, "acct_owner", waiting.key))).status).toBe(200);
  expect(await f.status()).toMatchObject({ account: "acct_owner", members: 1 });
});

test("a device that loses drive access while its read of a code is on its way reads nothing", async () => {
  const f = await pc();
  const paired = (label: string) => {
    const made = f.devices.pair(f.devices.startPairing().code, label, "drive")!;
    f.devices.match(made.token);
    return made.device.id;
  };
  const [laptop, tablet, phone] = [paired("Laptop"), paired("Tablet"), paired("Phone")];
  const id = f.devices.pairingForAccount("acct_owner").pairing.id;
  const base = `http://127.0.0.1:${f.app.port}`;
  /** The read as `caller` sends it, its body held back until `finish`: the request is past every check made before its body is read. */
  const read = (caller: string) => {
    let finish = () => {};
    const body = new ReadableStream<Uint8Array>({ start(controller) {
      finish = () => { controller.enqueue(new TextEncoder().encode(JSON.stringify({ id }))); controller.close(); };
    } });
    const answer = handleRelayRequest(new Request(`${base}/api/relay/offer/keep`, { method: "POST", headers: { origin: base, "x-herdr-update": "1", "content-type": "application/json" }, body }),
      "/api/relay/offer/keep", f.app.context, caller);
    return { finish, answer: answer.then(async (response) => [response.status, await response.json()]) };
  };
  const kept = read(phone);
  const revoked = read(laptop);
  const demoted = read(tablet);
  f.devices.revoke(laptop);
  f.devices.update(tablet, { role: "watch" });
  for (const call of [kept, revoked, demoted]) call.finish();
  expect(await kept.answer).toEqual([200, expect.objectContaining({ state: "live", id })]);
  expect(await revoked.answer).toEqual([401, { error: { code: "unauthorized", message: "this device is no longer paired" } }]);
  expect(await demoted.answer).toEqual([403, { error: { code: "read_only", message: "this device can only watch" } }]);
});

test("the read of a code by its id: unknown ids, a body with none, and a code that was cancelled, revoked, guessed or ran out of time", async () => {
  const f = await pc();
  expect(await state(f, "0".repeat(32))).toEqual({ state: "unknown" });
  const none = await f.local("/api/relay/offer/keep", { method: "POST", headers: { "x-herdr-update": "1" }, body: {} });
  expect([none.status, none.body.error?.code]).toEqual([400, "invalid_body"]);
  const cancelled = await forAccount(f, "acct_owner");
  await f.local("/api/devices/pair/cancel", { method: "POST", headers: { "x-herdr-machine": "1" }, body: {} });
  expect(await state(f, idOf(cancelled))).toMatchObject({ state: "ended", ended: { why: "cancelled" } });
  // a device that was handed the code takes it along when it is revoked
  const laptop = f.devices.pair(f.devices.startPairing().code, "Laptop", "drive")!;
  f.devices.match(laptop.token);
  const held = f.devices.pairingForAccount("acct_owner", laptop.device.id);
  f.devices.revoke(laptop.device.id);
  expect(await state(f, held.pairing.id)).toMatchObject({ state: "ended", ended: { why: "revoked" } });
  const revoked = await forAccount(f, "acct_owner");
  expect((await f.local("/api/devices/revoke-all", { method: "POST", headers: { "x-herdr-machine": "1" } })).status).toBe(200);
  expect(await state(f, idOf(revoked))).toMatchObject({ state: "ended", ended: { why: "revoked" } });
  const guessed = await forAccount(f, "acct_owner");
  const wrong = codeOf(guessed) === "000000" ? "000001" : "000000";
  for (let tries = 0; tries < 5; tries++) expect(await pair(f, wrong, await phone())).toMatchObject({ error: "auth_failed" });
  expect(await state(f, idOf(guessed))).toMatchObject({ state: "ended", ended: { why: "guessed" } });
  const expired = await forAccount(f, "acct_owner");
  const after = Date.parse(String(expired.body.expires_at)) + 1;
  spyOn(Date, "now").mockReturnValue(after);
  try {
    expect(await state(f, idOf(expired))).toMatchObject({ state: "ended", ended: { why: "expired" } });
  } finally { (Date.now as unknown as { mockRestore(): void }).mockRestore(); }
  expect(f.devices.activePairing()).toBeNull();
});
