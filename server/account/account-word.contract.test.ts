/**
 * The account's word (docs/account.md, "The account's word"): while a code made to put a PC in an account lives, a
 * link passes only when the account service holds that account's admission for the link's key at this PC. No test
 * sleeps: the clock the waits are counted on is moved by hand, the test account service's calls are counted or held,
 * and every wait is for the event its line names, bounded.
 */
import { afterEach, expect, setSystemTime, test } from "bun:test";
import { decodeOffer } from "../../shared/relay-offer.ts";
import { PAIRING_LINK_MS } from "../devices.ts";
import { bounded, TestClock } from "../relay/test-helpers.ts";
import { VOUCH_READ_GAP_MS, VOUCH_READ_MS } from "./mailbox.ts";
import { ask, ended, linkRecord, memberRow, nextAsk, pair, pairingPc, phone, sendLink, setUpFor, signedInWith, untilNextRead, vouchFor, type Answer, type Pc } from "./pairing.test-helpers.ts";

const pcs: Pc[] = [];
afterEach(async () => {
  setSystemTime();
  for (const pc of pcs.splice(0)) await pc.close();
});

async function pc(options: Parameters<typeof pairingPc>[0] = {}) {
  const made = await pairingPc({ ...options, server: { accountOpensAll: false, ...options.server } });
  pcs.push(made);
  const clock = new TestClock();
  made.devices.useClock(clock);
  return Object.assign(made, { clock });
}

type WordPc = Awaited<ReturnType<typeof pc>>;

const forAccount = (f: Pc, account: string, path = "/api/relay/offer") =>
  f.local(path, { method: "POST", headers: { "x-herdr-update": "1", "x-ovis-expect-account": account } });

function codeOf(answer: Answer): string {
  const code = typeof answer.body.url === "string" ? decodeOffer(answer.body.url)?.code : undefined;
  if (answer.status !== 200 || code === undefined) throw new Error(`The offer gave no code: ${answer.status} ${JSON.stringify(answer.body)}`);
  return code;
}

const idOf = (answer: Answer) => (answer.body.pairing as { id: string }).id;
const state = async (f: Pc, id: unknown) => (await f.local("/api/relay/offer/keep", { method: "POST", headers: { "x-herdr-update": "1" }, body: { id } })).body;
const refusal = (answer: Answer) => [answer.status, answer.body.error?.code];

/** Moves the clock to when the next read may start, then sends a link: that read judges it. */
async function linkAfterGap(f: WordPc, session: Parameters<typeof sendLink>[0], record: unknown): Promise<Answer> {
  untilNextRead(f);
  return await bounded(sendLink(session, record));
}

/** The account service's calls, by path, and a switch for what it answers. */
function serviceCalls() {
  const calls: string[] = [];
  let answer: ((request: Request) => Promise<Response> | undefined) | undefined;
  const count = (path: string) => calls.filter((call) => call === path).length;
  return {
    calls, count,
    set: (next: typeof answer) => { answer = next; },
    fetch: async (request: Request, service: { fetch: (request: Request) => Promise<Response> }) => {
      const path = new URL(request.url).pathname;
      if (path.startsWith("/v1/pc/")) calls.push(path);
      return await (answer?.(request) ?? service.fetch(request));
    },
  };
}

const tooMany = (retryAfter?: string) => Promise.resolve(new Response(JSON.stringify({ error: { code: "rate_limited" } }), {
  status: 429, headers: { "content-type": "application/json", ...(retryAfter === undefined ? {} : { "retry-after": retryAfter }) },
}));

test("a device its account did not vouch for is refused and goes, and the code stays; with the account's admission for its key a device joins", async () => {
  const f = await pc();
  const offer = await forAccount(f, "acct_owner");
  const code = codeOf(offer);
  // a client that names the owner's account, signed in to another account or to none
  const stranger = await signedInWith(f, code);
  await vouchFor(f, "acct_other", stranger.key);
  const refused = await sendLink(stranger.session, await linkRecord(stranger.id, "acct_owner", stranger.key));
  expect(refusal(refused)).toEqual([403, "unverified_device"]);
  expect([await ended(stranger.session), await ended(stranger.pairing)]).toEqual(["auth_revoked", "auth_revoked"]);
  const unsigned = await signedInWith(f, code);
  expect(refusal(await linkAfterGap(f, unsigned.session, await linkRecord(unsigned.id, "acct_owner", unsigned.key)))).toEqual([403, "unverified_device"]);
  expect(await f.status()).toMatchObject({ account: null, members: 0 });
  expect(f.stored()).toEqual([]);
  expect(await state(f, idOf(offer))).toMatchObject({ state: "live", waiting: [],
    turned_away: [{ n: 1, id: stranger.id, why: "unverified", link: "asked" }, { n: 2, id: unsigned.id, why: "unverified", link: "asked" }] });
  // the owner's device: its account posted its admission before it paired
  const key = await phone();
  await vouchFor(f, "acct_owner", key);
  const owner = await signedInWith(f, code, key);
  const joined = await linkAfterGap(f, owner.session, await linkRecord(owner.id, "acct_owner", owner.key));
  expect(joined.status).toBe(200);
  expect(await f.status()).toMatchObject({ account: "acct_owner", members: 1, own_word: [] });
  expect(f.stored().map((device) => [device.id, device.account, device.joined_by])).toEqual([[owner.id, "acct_owner", "service"]]);
});

test("the offer of a code made for an account and of the relay tab's code carries the mark; a plain offer does not", async () => {
  const f = await pc();
  await setUpFor(f, "acct_owner");
  const named = await forAccount(f, "acct_owner");
  expect(decodeOffer(named.body.url as string)?.admission).toBe(1);
  const tab = await f.local("/api/relay/offer", { method: "POST", headers: { "x-herdr-update": "1", "x-ovis-no-account-only": "1" } });
  expect(decodeOffer(tab.body.url as string)?.admission).toBe(1);
  const plain = await f.local("/api/relay/offer", { method: "POST", headers: { "x-herdr-update": "1" } });
  expect("admission" in decodeOffer(plain.body.url as string)!).toBe(false);
});

test("the key asked about is the one the device holds once linked: an admission for the key it paired with, of another account, or for another PC lets nothing in", async () => {
  const f = await pc();
  const other = await pc();
  const code = codeOf(await forAccount(f, "acct_owner"));
  const paired = await phone();
  const moved = await phone();
  await vouchFor(f, "acct_owner", paired);
  await vouchFor(f, "acct_other", moved);
  await vouchFor(f, "acct_owner", moved, { server: other.app.context.services.relay.currentIdentity()! });
  const first = await signedInWith(f, code, paired);
  expect(refusal(await sendLink(first.session, await linkRecord(first.id, "acct_owner", paired, moved)))).toEqual([403, "unverified_device"]);
  await vouchFor(f, "acct_owner", moved);
  const second = await signedInWith(f, code, await phone());
  const from = second.key;
  const joined = await linkAfterGap(f, second.session, await linkRecord(second.id, "acct_owner", from, moved));
  expect(joined.status).toBe(200);
  expect(f.stored().map((device) => device.relay_public_key)).toEqual([moved.spki]);
});

test("while the account service does not answer a link gets 503 with when to ask again, within the bound; the device and the code stay, and the same link joins once it answers", async () => {
  const service = serviceCalls();
  const f = await pc({ accountFetch: service.fetch });
  const offer = await forAccount(f, "acct_owner");
  const key = await phone();
  await vouchFor(f, "acct_owner", key);
  const device = await signedInWith(f, codeOf(offer), key);
  const record = await linkRecord(device.id, "acct_owner", key);
  // a service that does not answer: the read has VOUCH_READ_MS for its two calls
  service.set(() => new Promise<Response>(() => {}));
  const asked = nextAsk(f);
  const waiting = sendLink(device.session, record);
  await asked;
  expect(await state(f, idOf(offer))).toMatchObject({ waiting: [{ id: device.id, link: "asked" }] });
  f.clock.advance(VOUCH_READ_MS);
  const late = await bounded(waiting);
  expect(refusal(late)).toEqual([503, "account_unavailable"]);
  expect(Number(late.headers.get("retry-after"))).toBeGreaterThan(0);
  expect(await state(f, idOf(offer))).toMatchObject({ state: "live", waiting: [{ id: device.id, link: "service_unreachable" }], turned_away: [] });
  // a service that answers 503 at once
  service.set(() => Promise.resolve(new Response("{}", { status: 503 })));
  expect(refusal(await linkAfterGap(f, device.session, record))).toEqual([503, "account_unavailable"]);
  service.set(undefined);
  const joined = await linkAfterGap(f, device.session, record);
  expect(joined.status).toBe(200);
  expect(await f.status()).toMatchObject({ account: "acct_owner", members: 1 });
});

test("a 429 that names a long wait: links are answered at once with that wait, no call is made before it, the device's 30 seconds are not made longer, and after the wait a device joins", async () => {
  const service = serviceCalls();
  const f = await pc({ accountFetch: service.fetch });
  const offer = await forAccount(f, "acct_owner");
  const code = codeOf(offer);
  const key = await phone();
  await vouchFor(f, "acct_owner", key);
  const device = await signedInWith(f, code, key);
  const record = await linkRecord(device.id, "acct_owner", key);
  service.set((request) => new URL(request.url).pathname === "/v1/pc/mailbox" ? tooMany("60") : undefined);
  const first = await sendLink(device.session, record);
  expect([...refusal(first), first.headers.get("retry-after")]).toEqual([503, "account_unavailable", "60"]);
  expect(service.calls).toEqual(["/v1/pc/challenge", "/v1/pc/mailbox"]);
  f.clock.advance(1_000);
  const second = await sendLink(device.session, record);
  expect([...refusal(second), second.headers.get("retry-after")]).toEqual([503, "account_unavailable", "59"]);
  expect(service.calls).toHaveLength(2);
  const live = await state(f, idOf(offer));
  expect(live).toMatchObject({ state: "live", waiting: [{ id: device.id, link: "service_unreachable" }] });
  expect(live.service_retry_ms).toBe(59_000);
  f.clock.advance(PAIRING_LINK_MS - 1_000);
  expect(await ended(device.session)).toBe("auth_revoked");
  expect(await state(f, idOf(offer))).toMatchObject({ state: "live", waiting: [], turned_away: [{ id: device.id, why: "link_timeout", link: "service_unreachable" }] });
  f.clock.advance(60_000 - PAIRING_LINK_MS);
  service.set(undefined);
  const later = await phone();
  await vouchFor(f, "acct_owner", later);
  const owner = await signedInWith(f, code, later);
  expect((await sendLink(owner.session, await linkRecord(owner.id, "acct_owner", later))).status).toBe(200);
});

test("a refused challenge makes no mailbox call and no second challenge; with a wait links are answered at once, and without one the next read starts 10 seconds after the last", async () => {
  const service = serviceCalls();
  const f = await pc({ accountFetch: service.fetch });
  const code = codeOf(await forAccount(f, "acct_owner"));
  const device = await signedInWith(f, code);
  const record = await linkRecord(device.id, "acct_owner", device.key);
  service.set((request) => new URL(request.url).pathname === "/v1/pc/challenge" ? tooMany("30") : undefined);
  const named = await sendLink(device.session, record);
  expect([...refusal(named), named.headers.get("retry-after")]).toEqual([503, "account_unavailable", "30"]);
  expect(service.calls).toEqual(["/v1/pc/challenge"]);
  f.clock.advance(30_000);
  service.set((request) => new URL(request.url).pathname === "/v1/pc/challenge" ? tooMany() : undefined);
  const plain = await signedInWith(f, code);
  expect(refusal(await sendLink(plain.session, await linkRecord(plain.id, "acct_owner", plain.key)))).toEqual([503, "account_unavailable"]);
  expect(service.calls).toEqual(["/v1/pc/challenge", "/v1/pc/challenge"]);
  // one second later a link waits for the read that may start 10 seconds after the last one, and no sooner
  f.clock.advance(1_000);
  service.set(undefined);
  const asked = nextAsk(f);
  const waiting = sendLink(plain.session, await linkRecord(plain.id, "acct_owner", plain.key));
  await asked;
  expect(service.count("/v1/pc/challenge")).toBe(2);
  f.clock.advance(VOUCH_READ_GAP_MS - 1_000 - 1);
  expect(service.count("/v1/pc/challenge")).toBe(2);
  f.clock.advance(1);
  expect(refusal(await bounded(waiting))).toEqual([403, "unverified_device"]);
  expect(service.calls).toEqual(["/v1/pc/challenge", "/v1/pc/challenge", "/v1/pc/challenge", "/v1/pc/mailbox"]);
});

/** Holds the account service's next mailbox call until `release`: `reached` settles once the call is made. */
function holdMailbox(service: ReturnType<typeof serviceCalls>, f: Pc) {
  let reached: () => void = () => {};
  let release: () => void = () => {};
  const atMailbox = new Promise<void>((resolve) => { reached = resolve; });
  const held = new Promise<void>((resolve) => { release = resolve; });
  service.set((request) => {
    if (new URL(request.url).pathname !== "/v1/pc/mailbox") return undefined;
    service.set(undefined);
    reached();
    return held.then(() => f.account.fetch(request));
  });
  return { reached: bounded(atMailbox), release: () => release() };
}

test("reads are bounded: links that come before a read are all judged by it, one that comes during a read waits for the next, and no two reads start within 10 seconds", async () => {
  const service = serviceCalls();
  const f = await pc({ accountFetch: service.fetch });
  const code = codeOf(await forAccount(f, "acct_owner"));
  const first = await signedInWith(f, code);
  expect(refusal(await sendLink(first.session, await linkRecord(first.id, "acct_owner", first.key)))).toEqual([403, "unverified_device"]);
  expect(service.count("/v1/pc/challenge")).toBe(1);
  // ten links from three devices within one second, all before the next read may start
  const rows = [await signedInWith(f, code), await signedInWith(f, code), await signedInWith(f, code)];
  const links: Promise<Answer>[] = [];
  for (let index = 0; index < 10; index++) {
    const row = rows[index % 3]!;
    const asked = nextAsk(f);
    links.push(sendLink(row.session, await linkRecord(row.id, "acct_owner", row.key)));
    await asked;
    f.clock.advance(100);
  }
  expect(service.count("/v1/pc/challenge")).toBe(1);
  const hold = holdMailbox(service, f);
  f.clock.advance(VOUCH_READ_GAP_MS - 1_000);
  await hold.reached;
  expect(service.count("/v1/pc/challenge")).toBe(2);
  const late = await signedInWith(f, code);
  const lateAsked = nextAsk(f);
  const lateLink = sendLink(late.session, await linkRecord(late.id, "acct_owner", late.key));
  await lateAsked;
  hold.release();
  const answers = await bounded(Promise.all(links));
  expect(answers.map((answer) => answer.status)).toEqual(Array(10).fill(403));
  expect(service.count("/v1/pc/challenge")).toBe(2);
  // the late link waits for a read of its own, 10 seconds after the last began
  f.clock.advance(VOUCH_READ_GAP_MS);
  expect(refusal(await bounded(lateLink))).toEqual([403, "unverified_device"]);
  expect(service.count("/v1/pc/challenge")).toBe(3);
});

test("a link waiting for the account's word writes nothing when, before the answer, its 30 seconds end or its code ends", async () => {
  for (const what of ["time", "code"] as const) {
    const service = serviceCalls();
    const f = await pc({ accountFetch: service.fetch });
    const offer = await forAccount(f, "acct_owner");
    const key = await phone();
    await vouchFor(f, "acct_owner", key);
    const device = await signedInWith(f, codeOf(offer), key);
    if (what === "time") f.clock.advance(PAIRING_LINK_MS - 4_000);
    const hold = holdMailbox(service, f);
    const waiting = sendLink(device.session, await linkRecord(device.id, "acct_owner", key));
    await hold.reached;
    if (what === "time") f.clock.advance(4_000);
    else f.devices.endPairing();
    hold.release();
    expect([what, ...refusal(await bounded(waiting))]).toEqual([what, 403, "link_required"]);
    expect(f.stored()).toEqual([]);
    expect(await f.status()).toMatchObject({ account: null, members: 0 });
  }
});

test("a device that already drives the PC, whose link waits for the account's word, gets pairing_ended when the code ends meanwhile, and keeps what it had", async () => {
  const service = serviceCalls();
  const f = await pc({ accountFetch: service.fetch });
  const key = await phone();
  const older = await signedInWith(f, await f.offerCode(), key);
  codeOf(await forAccount(f, "acct_1"));
  await vouchFor(f, "acct_1", key);
  const hold = holdMailbox(service, f);
  const waiting = sendLink(older.session, await linkRecord(older.id, "acct_1", key));
  await hold.reached;
  f.devices.endPairing();
  hold.release();
  expect(refusal(await bounded(waiting))).toEqual([409, "pairing_ended"]);
  expect(await f.status()).toMatchObject({ account: null, unlinked: [older.id] });
});

test("two devices vouched for, judged by one read: the first link joins and the other writes nothing", async () => {
  const f = await pc();
  const code = codeOf(await forAccount(f, "acct_owner"));
  const [a, b] = [await phone(), await phone()];
  await vouchFor(f, "acct_owner", a);
  await vouchFor(f, "acct_owner", b);
  const stranger = await signedInWith(f, code);
  expect(refusal(await sendLink(stranger.session, await linkRecord(stranger.id, "acct_owner", stranger.key)))).toEqual([403, "unverified_device"]);
  const first = await signedInWith(f, code, a);
  const second = await signedInWith(f, code, b);
  const asked = [nextAsk(f)];
  const links = [sendLink(first.session, await linkRecord(first.id, "acct_owner", a))];
  await asked[0];
  const askedAgain = nextAsk(f);
  links.push(sendLink(second.session, await linkRecord(second.id, "acct_owner", b)));
  await askedAgain;
  f.clock.advance(VOUCH_READ_GAP_MS);
  const answers = await bounded(Promise.all(links));
  expect(answers.map((answer) => answer.status).sort()).toEqual([200, 403]);
  expect(f.stored()).toHaveLength(1);
  expect(await f.status()).toMatchObject({ members: 1 });
});

test("a device that already drives the PC, linking while a code made for an account lives, needs that account's ordinary admission: a quiet one does not count, and it keeps what it had", async () => {
  const f = await pc();
  const key = await phone();
  const older = await signedInWith(f, await f.offerCode(), key);
  expect(older.role).toBe("drive");
  codeOf(await forAccount(f, "acct_1"));
  const another = await sendLink(older.session, await linkRecord(older.id, "acct_2", key));
  expect(refusal(another)).toEqual([409, "account_mismatch"]);
  const refused = await sendLink(older.session, await linkRecord(older.id, "acct_1", key));
  expect(refusal(refused)).toEqual([403, "unverified_device"]);
  await vouchFor(f, "acct_1", key, { quiet: true });
  expect(refusal(await linkAfterGap(f, older.session, await linkRecord(older.id, "acct_1", key)))).toEqual([403, "unverified_device"]);
  expect((await ask(older.session, "/api/devices")).status).toBe(200);
  expect(await f.status()).toMatchObject({ account: null, unlinked: [older.id] });
  await vouchFor(f, "acct_1", key);
  expect((await linkAfterGap(f, older.session, await linkRecord(older.id, "acct_1", key))).status).toBe(200);
  expect(f.stored().map((device) => [device.id, device.account, device.joined_by])).toEqual([[older.id, "acct_1", "service"]]);
});

test("a quiet admission lets in the PC's first member, a device that paired with the code made for its account", async () => {
  const f = await pc();
  const code = codeOf(await forAccount(f, "acct_owner"));
  const key = await phone();
  await vouchFor(f, "acct_owner", key, { quiet: true });
  const device = await signedInWith(f, code, key);
  expect((await sendLink(device.session, await linkRecord(device.id, "acct_owner", key))).status).toBe(200);
  expect(f.stored().map((row) => [row.account, row.joined_by])).toEqual([["acct_owner", "service"]]);
});

test("joining by digits counts only the ordinary admissions of the PC's account, never the quiet ones", async () => {
  const f = await pc({ rows: [(await memberRow("acct_1")).row] });
  const mailbox = f.app.context.services.accountMailbox;
  const [quiet, ordinary] = [await phone(), await phone()];
  await vouchFor(f, "acct_1", quiet, { quiet: true });
  await vouchFor(f, "acct_1", ordinary);
  await mailbox.pull();
  expect(mailbox.error).toBeNull();
  expect([await mailbox.admitted(quiet.spki), await mailbox.admitted(ordinary.spki)]).toEqual([false, true]);
});

test("a PC whose account service is turned off makes no code to put it in an account, and its plain codes stay", async () => {
  const f = await pc({ accountService: "off" });
  await setUpFor(f, "acct_owner");
  for (const path of ["/api/relay/offer", "/api/relay/code"]) expect([path, ...refusal(await forAccount(f, "acct_owner", path))]).toEqual([path, 409, "account_service_off"]);
  const tab = await f.local("/api/relay/offer", { method: "POST", headers: { "x-herdr-update": "1", "x-ovis-no-account-only": "1" } });
  expect(refusal(tab)).toEqual([409, "account_service_off"]);
  expect(f.devices.activePairing()).toBeNull();
  expect(decodeOffer((await f.local("/api/relay/offer", { method: "POST", headers: { "x-herdr-update": "1" } })).body.url as string)?.code).toMatch(/^\d{6}$/);
});

test("an offer asked for with neither header pairs and links as before: no admission, and no call to the account service", async () => {
  const service = serviceCalls();
  const f = await pc({ accountFetch: service.fetch });
  const key = await phone();
  const device = await signedInWith(f, await f.offerCode(), key);
  expect((await sendLink(device.session, await linkRecord(device.id, "acct_any", key))).status).toBe(200);
  expect(service.calls).toEqual([]);
  expect(f.stored().map((row) => [row.account, row.joined_by])).toEqual([["acct_any", "word"]]);
});

/** The wall clock moved to `ms` before the code's ten minutes end (negative: after), as a code's end is read on it. */
const codeAt = (made: number, ms: number) => setSystemTime(new Date(made + 10 * 60_000 - ms));

for (const kind of ["a code made for an account", "the relay tab's code"] as const) {
  test(`a device that pairs with ${kind} just before its ten minutes end and links just after is still held to the account's word: refused without it, and it goes`, async () => {
    const service = serviceCalls();
    const f = await pc({ accountFetch: service.fetch });
    await setUpFor(f, "acct_owner");
    const made = Date.now();
    const offer = kind === "a code made for an account" ? await forAccount(f, "acct_owner")
      : await f.local("/api/relay/offer", { method: "POST", headers: { "x-herdr-update": "1", "x-ovis-no-account-only": "1" } });
    codeAt(made, 500);
    const late = await signedInWith(f, codeOf(offer));
    codeAt(made, -500);
    expect(refusal(await sendLink(late.session, await linkRecord(late.id, "acct_owner", late.key)))).toEqual([403, "unverified_device"]);
    expect(service.calls).toEqual(["/v1/pc/challenge", "/v1/pc/mailbox"]);
    expect(await ended(late.session)).toBe("auth_revoked");
    expect(f.stored()).toEqual([]);
    expect(await f.status()).toMatchObject({ account: null, members: 0 });
    if (kind === "a code made for an account") {
      expect(await state(f, idOf(offer))).toMatchObject({ state: "ended", ended: { why: "expired" }, turned_away: [{ id: late.id, why: "unverified" }] });
    }
  });

  test(`a device that pairs with ${kind} just before its ten minutes end, and that its account vouched for, finishes its link after them`, async () => {
    const f = await pc();
    await setUpFor(f, "acct_owner");
    const made = Date.now();
    const offer = kind === "a code made for an account" ? await forAccount(f, "acct_owner")
      : await f.local("/api/relay/offer", { method: "POST", headers: { "x-herdr-update": "1", "x-ovis-no-account-only": "1" } });
    const key = await phone();
    codeAt(made, 500);
    await vouchFor(f, "acct_owner", key);
    const late = await signedInWith(f, codeOf(offer), key);
    codeAt(made, -500);
    expect((await sendLink(late.session, await linkRecord(late.id, "acct_owner", key))).status).toBe(200);
    expect(f.stored().map((device) => [device.id, device.account, device.joined_by])).toEqual([[late.id, "acct_owner", "service"]]);
  });
}

test("a device that pairs with a code made for one account on a PC set up for another, and links into that other just after the code ends, is refused and goes", async () => {
  const f = await pc();
  await setUpFor(f, "acct_y");
  const made = Date.now();
  const code = codeOf(await forAccount(f, "acct_x"));
  codeAt(made, 500);
  const late = await signedInWith(f, code);
  codeAt(made, -500);
  expect(refusal(await sendLink(late.session, await linkRecord(late.id, "acct_y", late.key)))).toEqual([409, "account_mismatch"]);
  expect(await ended(late.session)).toBe("auth_revoked");
  expect(f.stored()).toEqual([]);
  expect(await f.status()).toMatchObject({ account: null, members: 0 });
});

test("a 429 that names a wait longer than a minute holds the account service's reads back for a minute only", async () => {
  const service = serviceCalls();
  const f = await pc({ accountFetch: service.fetch });
  const code = codeOf(await forAccount(f, "acct_owner"));
  const device = await signedInWith(f, code);
  service.set((request) => new URL(request.url).pathname === "/v1/pc/mailbox" ? tooMany("999999999") : undefined);
  const held = await sendLink(device.session, await linkRecord(device.id, "acct_owner", device.key));
  expect([...refusal(held), held.headers.get("retry-after")]).toEqual([503, "account_unavailable", "60"]);
  expect(f.app.context.services.accountMailbox.serviceRetryMs()).toBe(60_000);
  service.set(undefined);
  // 49 seconds on, no read may start within a link's 10 seconds: answered at once, with no call
  f.clock.advance(49_000);
  const early = await signedInWith(f, code);
  const answered = await sendLink(early.session, await linkRecord(early.id, "acct_owner", early.key));
  expect([...refusal(answered), answered.headers.get("retry-after")]).toEqual([503, "account_unavailable", "11"]);
  expect(service.count("/v1/pc/challenge")).toBe(1);
  // at the minute the service is asked again
  f.clock.advance(11_000);
  const key = await phone();
  await vouchFor(f, "acct_owner", key);
  const owner = await signedInWith(f, code, key);
  expect((await sendLink(owner.session, await linkRecord(owner.id, "acct_owner", key))).status).toBe(200);
  expect(service.count("/v1/pc/challenge")).toBe(2);
});

test("two links of one waiting device judged by one read: the first makes it a member, and the second, judged as a waiting device's, changes nothing", async () => {
  const f = await pc();
  const code = codeOf(await forAccount(f, "acct_owner"));
  const [key, other] = [await phone(), await phone()];
  await vouchFor(f, "acct_owner", key, { quiet: true });
  await vouchFor(f, "acct_owner", other, { quiet: true });
  const stranger = await signedInWith(f, code);
  expect(refusal(await sendLink(stranger.session, await linkRecord(stranger.id, "acct_owner", stranger.key)))).toEqual([403, "unverified_device"]);
  const device = await signedInWith(f, code, key);
  const links: Promise<Answer>[] = [];
  for (const to of [key, other]) {
    const asked = nextAsk(f);
    links.push(sendLink(device.session, await linkRecord(device.id, "acct_owner", key, to)));
    await asked;
  }
  f.clock.advance(VOUCH_READ_GAP_MS);
  const answers = await bounded(Promise.all(links));
  expect(answers.map(refusal)).toEqual([[200, undefined], [403, "link_required"]]);
  expect(f.stored().map((row) => [row.id, row.relay_public_key])).toEqual([[device.id, key.spki]]);
});

test("a link that waits for the account's word after the code's ten minutes still joins when the code is read meanwhile", async () => {
  const service = serviceCalls();
  const f = await pc({ accountFetch: service.fetch });
  const made = Date.now();
  const offer = await forAccount(f, "acct_owner");
  const key = await phone();
  codeAt(made, 500);
  await vouchFor(f, "acct_owner", key);
  const device = await signedInWith(f, codeOf(offer), key);
  codeAt(made, -500);
  const hold = holdMailbox(service, f);
  const linking = sendLink(device.session, await linkRecord(device.id, "acct_owner", key));
  await hold.reached;
  // what `ovis add` does while it waits: it reads its code
  expect(await state(f, idOf(offer))).toMatchObject({ state: "live", waiting: [{ id: device.id, link: "asked" }] });
  hold.release();
  expect((await bounded(linking)).status).toBe(200);
  expect(await f.status()).toMatchObject({ account: "acct_owner", members: 1 });
});

test("past a code's ten minutes, while a device that paired with it in time still waits, a device that already drives the PC is still held to the code's account and its word, and the code pairs no new device", async () => {
  const service = serviceCalls();
  const f = await pc({ accountFetch: service.fetch });
  const made = Date.now();
  const older = await signedInWith(f, await f.offerCode());
  const offer = await forAccount(f, "acct_1");
  const owner = await signedInWith(f, codeOf(offer));
  codeAt(made, -500);
  expect(await state(f, idOf(offer))).toMatchObject({ state: "live", waiting: [{ id: owner.id }] });
  expect(await pair(f, codeOf(offer), await phone())).toMatchObject({ error: "auth_failed" });
  expect(refusal(await sendLink(older.session, await linkRecord(older.id, "acct_2", older.key)))).toEqual([409, "account_mismatch"]);
  expect(refusal(await sendLink(older.session, await linkRecord(older.id, "acct_1", older.key)))).toEqual([403, "unverified_device"]);
  expect(service.count("/v1/pc/mailbox")).toBe(1);
  expect(await f.status()).toMatchObject({ account: null, members: 0, unlinked: [older.id] });
  expect(await state(f, idOf(offer))).toMatchObject({ state: "live", waiting: [{ id: owner.id }] });
});
