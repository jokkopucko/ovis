/**
 * The pairing code made for a PC in no account (the relay tab's QR code; docs/account.md, "Who may admit a
 * device"): a device that pairs with it through the relay is no device of the PC until it has linked itself into
 * an account. No test sleeps: the clock a waiting device is bounded on is moved by hand, and every wait is for the
 * event its line names, bounded.
 */
import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ACCOUNT_RECORD_PREFIX, newRecordId, signAccountRecord } from "../../shared/account-records.ts";
import type { DevicePairedEvent } from "../../shared/protocol.ts";
import type { HttpRequest } from "../../shared/relay-mux-engine.ts";
import { DIRECT_CARRIER } from "../../shared/relay-mux.ts";
import { PAIRING_LINK_MS, PAIRING_USES } from "../devices.ts";
import { handleRequest } from "../dispatch.ts";
import { privateStateFs } from "../private-state.ts";
import { LEAVING_MS } from "../relay/session.ts";
import { bounded, deferred, TestClock } from "../relay/test-helpers.ts";
import { ask, ended, linkRecord, nextAsk, pair, pairingPc, phone, sendLink, setUpFor, signedInWith, signIn, untilNextRead, vouchFor, type Answer, type Pc, type Phone } from "./pairing.test-helpers.ts";

const pcs: Pc[] = [];
afterEach(async () => {
  mock.restore();
  for (const pc of pcs.splice(0)) await pc.close();
});

/**
 * A PC in no account that its owner set up for `acct_1`, as the relay tab's code is made only for a PC an account
 * was named for, with the clock its waiting devices are bounded on in the test's hand.
 */
async function pc() {
  const made = await pairingPc({ server: { accountOpensAll: false } });
  pcs.push(made);
  await setUpFor(made, "acct_1");
  const clock = new TestClock();
  made.devices.useClock(clock);
  return Object.assign(made, { clock });
}

/** What a device that waits to link reads as its account status, whatever else the PC holds. */
const waitingStatus = (id: string) => ({ account: null, members: 0, unlinked: [id], own_word: [], removals: [], adds: [], blocked: [], enrolling: false, blocked_all: false, mailbox: { last_pull_at: null, error: null } });

/** Every request of a session that reached a route, as `METHOD /path`: one the session refused never does. */
function routed() {
  const reached: string[] = [];
  const dispatch: typeof handleRequest = (request, context) => {
    reached.push(`${request.method} ${new URL(request.url).pathname}`);
    return handleRequest(request, context);
  };
  return { reached, dispatch };
}

/**
 * Holds the signature check of the next account record until the test lets it go, and no check after it;
 * `reached` settles once it waits there.
 */
function holdRecordCheck() {
  const verify = crypto.subtle.verify.bind(crypto.subtle);
  const prefix = new TextEncoder().encode(ACCOUNT_RECORD_PREFIX);
  const reached = deferred<void>();
  const gate = deferred<void>();
  let held = false;
  spyOn(crypto.subtle, "verify").mockImplementation(async (algorithm, key, signature, data) => {
    const bytes = new Uint8Array(ArrayBuffer.isView(data) ? data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) : data);
    if (!held && prefix.every((byte, index) => bytes[index] === byte)) {
      held = true;
      reached.resolve();
      await gate.promise;
    }
    return verify(algorithm, key, signature, data);
  });
  return { reached: reached.promise, release: () => gate.resolve() };
}

/** The enrollment barrier as it is on disk (docs/account.md, "Enrolling a PC"), null with none. */
function barrier(f: Pc): unknown {
  const path = join(f.stateDir, "account-enrolling.json");
  return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null;
}

/** Until the returned call, devices.json takes no write; `seen` runs first at each one that is refused. */
function deviceListUnwritable(seen: () => void = () => {}): () => void {
  const rename = privateStateFs.renameSync;
  const failing = spyOn(privateStateFs, "renameSync").mockImplementation((from, to) => {
    if (!String(to).endsWith("devices.json")) return rename(from, to);
    seen();
    throw Object.assign(new Error("EIO: i/o error, rename"), { code: "EIO" });
  });
  return () => failing.mockRestore();
}

/** The removals this PC's own page makes: of one device (Revoke) and of every device (Revoke all). */
const remove = (f: Pc, id: string) => f.local(`/api/devices/${id}`, { method: "DELETE", headers: { "x-herdr-machine": "1" } });
const removeAll = (f: Pc) => f.local("/api/devices/revoke-all", { method: "POST", headers: { "x-herdr-machine": "1" } });

/** What a sign-in as the row `id` with `key` comes to: the role it is told, or the error the PC ends it with. */
async function signsIn(f: Pc, id: string, key: Phone): Promise<string> {
  const session = await signIn(f, id, key);
  return "error" in session ? session.error : session.role;
}

test("a device that pairs with the relay tab's code is no device of the PC: its role is watch, and it is in no list and on no disk", async () => {
  const f = await pc();
  const code = await f.tabCode();
  const announced: DevicePairedEvent[] = [];
  f.devices.onPaired((event) => { announced.push(event); });
  const row = await signedInWith(f, code);
  expect(row.role).toBe("watch");
  expect(await f.listed()).toEqual([]);
  expect(f.stored()).toEqual([]);
  expect(await f.status()).toMatchObject({ account: null, members: 0, unlinked: [] });
  expect(announced).toEqual([]);
  // the code is not spent by it: the next device pairs with the same one
  expect(f.devices.activePairing()?.code).toBe(code);
});

test("a waiting device makes two calls and nothing else, on the session that paired and on the one that signed in", async () => {
  const f = await pc();
  const seen = routed();
  const row = await signedInWith(f, await f.tabCode(), undefined, { dispatch: seen.dispatch });
  const refused: [HttpRequest["method"], string][] = [
    ["GET", "/api/health"], ["GET", "/api/session"], ["GET", "/api/machines"], ["GET", "/api/devices"], ["POST", "/api/pane/input"],
    ["GET", "/api/account/introduction"], ["GET", "/api/relay"], ["GET", "/api/nothing"], ["GET", "/"],
    // the two calls by any other method, and their neighbours
    ["POST", "/api/account/status"], ["HEAD", "/api/account/status"], ["GET", "/api/account/link"], ["GET", "/api/account/statuses"],
    ["POST", "/api/account/records"], ["POST", "/api/account/enroll"], ["POST", "/api/devices/pair/start"], ["DELETE", `/api/devices/${"0".repeat(16)}`],
  ];
  for (const session of [row.session, row.pairing]) {
    for (const [method, target] of refused) {
      const answer = await ask(session, target, method === "POST" || method === "DELETE" ? { method, body: { pane_id: "1", text: "echo typed" } } : { method });
      expect([method, target, answer.status]).toEqual([method, target, 403]);
      if (method !== "HEAD") expect([method, target, answer.body.error?.code]).toEqual([method, target, "link_required"]);
    }
    // a socket is refused with the same answer
    const socket = session.mux.openWs({ target: "/ws", headers: [], protocols: [] });
    await session.flush();
    expect(socket.rejection?.response?.status).toBe(403);
    expect(JSON.parse(await new Response(socket.rejection?.body).text())).toMatchObject({ error: { code: "link_required" } });
    // its own status: always this body, and `fresh` reads no mailbox for it
    const status = await ask(session, "/api/account/status?fresh=1");
    expect([status.status, status.body]).toEqual([200, waitingStatus(row.id)]);
  }
  // not one of the refused requests reached a route: nothing was read, typed or started
  expect(seen.reached).toEqual(["GET /api/account/status", "GET /api/account/status"]);
});

test("the id of a waiting device signs in with the key it paired with, and with no other", async () => {
  const f = await pc();
  const key = await phone();
  const made = await pair(f, await f.tabCode(), key);
  if ("error" in made) throw new Error(`The pairing was refused: ${made.error}`);
  expect(await signIn(f, made.id, await phone())).toEqual({ error: "auth_failed" });
  // the refused sign-in took nothing from the device: its own key signs in
  const own = await signIn(f, made.id, key);
  expect("error" in own ? own.error : own.role).toBe("watch");
});

test("the link of a waiting device is taken only from a session that signed in with its key: the session that paired is refused, and the device waits on", async () => {
  const f = await pc();
  const row = await signedInWith(f, await f.tabCode());
  const refused = await sendLink(row.pairing, await linkRecord(row.id, "acct_1", row.key));
  expect([refused.status, refused.body.error?.code]).toEqual([403, "link_not_owner"]);
  expect((await f.status()).account).toBeNull();
  await vouchFor(f, "acct_1", row.key);
  expect((await sendLink(row.session, await linkRecord(row.id, "acct_1", row.key))).status).toBe(200);
  expect(await f.status()).toMatchObject({ account: "acct_1", members: 1 });
});

test(`a waiting device that has not linked after ${PAIRING_LINK_MS / 1000} seconds is gone: no session, no row, and its key signs in no more`, async () => {
  const f = await pc();
  const code = await f.tabCode();
  const row = await signedInWith(f, code);
  f.clock.advance(PAIRING_LINK_MS - 1);
  expect((await ask(row.session, "/api/account/status")).status).toBe(200);
  f.clock.advance(1);
  expect([await ended(row.session), await ended(row.pairing)]).toEqual(["auth_revoked", "auth_revoked"]);
  expect(await signIn(f, row.id, row.key)).toEqual({ error: "auth_failed" });
  expect(f.stored()).toEqual([]);
  expect(await f.listed()).toEqual([]);
  expect(existsSync(join(f.stateDir, "account-tombstones.json"))).toBe(false);
  // its use of the code is spent and the code is not: the next device pairs with the same one
  const next = await pair(f, code, await phone());
  expect("error" in next ? next.error : next.role).toBe("watch");
});

test("a waiting device whose time is over is gone at its next call, also where the timer that drops it has not run", async () => {
  const f = await pc();
  const row = await signedInWith(f, await f.tabCode());
  // time passes while the server is held up: no timer runs
  f.clock.tasks.clear();
  f.clock.advance(PAIRING_LINK_MS);
  const late = await ask(row.session, "/api/account/status");
  expect([late.status, late.body.error?.code]).toEqual([403, "link_required"]);
  expect(await ended(row.session)).toBe("auth_revoked");
  expect(await signIn(f, row.id, row.key)).toEqual({ error: "auth_failed" });
});

test("a waiting device whose connection dropped signs in again a second before its time is over, and its link joins", async () => {
  const f = await pc();
  const key = await phone();
  const made = await pair(f, await f.tabCode(), key);
  if ("error" in made) throw new Error(`The pairing was refused: ${made.error}`);
  made.link.stop();
  await bounded(made.link.closed);
  f.clock.advance(PAIRING_LINK_MS - 1_000);
  const session = await signIn(f, made.id, key);
  if ("error" in session) throw new Error(`The sign-in was refused: ${session.error}`);
  await vouchFor(f, "acct_1", key);
  expect((await sendLink(session.link, await linkRecord(made.id, "acct_1", key))).status).toBe(200);
  // a member from here on: the time it had as a waiting device takes nothing from it when it has passed
  f.clock.advance(2_000);
  expect((await ask(session.link, "/api/account/status")).body).toMatchObject({ account: "acct_1", members: 1, unlinked: [] });
});

test("a link still being checked when a waiting device's time runs out is answered link_required and writes nothing; then its session ends", async () => {
  const f = await pc();
  const row = await signedInWith(f, await f.tabCode());
  const check = holdRecordCheck();
  const answer = sendLink(row.session, await linkRecord(row.id, "acct_1", row.key));
  await bounded(check.reached);
  f.clock.advance(PAIRING_LINK_MS);
  check.release();
  const refused = await answer;
  expect([refused.status, refused.body.error?.code]).toEqual([403, "link_required"]);
  expect(await ended(row.session)).toBe("auth_revoked");
  expect([f.stored(), barrier(f)]).toEqual([[], null]);
  expect((await f.status()).account).toBeNull();
});

test(`a request a waiting device never finishes does not keep its session: ${LEAVING_MS / 1000} seconds after the device is gone, the session ends`, async () => {
  const f = await pc();
  // the clock of the device's sessions, apart from the one its time to link is counted on
  const sessions = new TestClock();
  const row = await signedInWith(f, await f.tabCode(), undefined, { clock: sessions });
  // a link whose body never comes
  row.session.mux.openHttp({ target: "/api/account/link", method: "POST", headers: [["content-type", "application/json"], ["x-herdr-machine", "1"]], body: "stream" });
  await row.session.flush();
  f.clock.advance(PAIRING_LINK_MS);
  // the device is gone: its session takes no new request, and waits for the one on its way
  await expect(row.session.open("/api/account/status").response).rejects.toMatchObject({ code: "refused" });
  sessions.advance(LEAVING_MS - 1);
  await expect(row.session.open("/api/account/status").response).rejects.toMatchObject({ code: "refused" });
  sessions.advance(1);
  expect(await ended(row.session)).toBe("auth_revoked");
});

test("the link of a waiting device makes it a member, announced once; the code ends, and the devices that still waited under it go", async () => {
  const f = await pc();
  const code = await f.tabCode();
  const announced: DevicePairedEvent[] = [];
  f.devices.onPaired((event) => { announced.push(event); });
  const other = await signedInWith(f, code);
  const row = await signedInWith(f, code);
  await vouchFor(f, "acct_1", row.key);
  expect((await sendLink(row.session, await linkRecord(row.id, "acct_1", row.key))).status).toBe(200);
  expect(announced.map((event) => event.device_id)).toEqual([row.id]);
  expect(f.stored()).toEqual([expect.objectContaining({ id: row.id, role: "drive", account: "acct_1", relay_public_key: row.key.spki })]);
  expect(await ended(other.session)).toBe("auth_revoked");
  expect(f.devices.activePairing()).toBeNull();
  expect(await pair(f, code, await phone())).toEqual({ error: "auth_failed" });
});

test(`the code takes ${PAIRING_USES} pairings and no more; it ends as the last device that waited under it goes`, async () => {
  const f = await pc();
  const code = await f.tabCode();
  const first = await signedInWith(f, code);
  for (let paired = 1; paired < PAIRING_USES; paired++) await signedInWith(f, code);
  expect(await pair(f, code, await phone())).toEqual({ error: "auth_failed" });
  // the pairing that came too late changed nothing: the code is pending, and its devices wait on
  expect(f.devices.activePairing()?.code).toBe(code);
  expect((await ask(first.session, "/api/account/status")).status).toBe(200);
  f.clock.advance(PAIRING_LINK_MS);
  expect(f.devices.activePairing()).toBeNull();
});

test("a waiting device sends five links; the sixth turns it away, whatever it holds", async () => {
  const f = await pc();
  const row = await signedInWith(f, await f.tabCode());
  for (let sent = 0; sent < 5; sent++) expect((await sendLink(row.session, { not: "a record" })).body.error?.code).toBe("record_invalid");
  const sixth = await sendLink(row.session, await linkRecord(row.id, "acct_1", row.key));
  expect([sixth.status, sixth.body.error?.code]).toEqual([403, "link_required"]);
  expect(await ended(row.session)).toBe("auth_revoked");
  expect((await f.status()).account).toBeNull();
});

test("ending the code takes the devices that wait under it", async () => {
  const f = await pc();
  const code = await f.tabCode();
  const row = await signedInWith(f, code);
  const cancelled = await f.local("/api/devices/pair/cancel", { method: "POST", headers: { "x-herdr-machine": "1" }, body: { code } });
  expect([cancelled.status, cancelled.body.cancelled]).toEqual([200, true]);
  expect([await ended(row.session), await ended(row.pairing)]).toEqual(["auth_revoked", "auth_revoked"]);
  expect(await signIn(f, row.id, row.key)).toEqual({ error: "auth_failed" });
});

test("a waiting device is told none of this PC's direct carriers; a device that drives is", async () => {
  const f = await pc();
  const carriers = ["ws://192.168.0.10:7319"];
  const options = { directCarriers: () => carriers };
  const drives = await phone();
  const driver = await pair(f, await f.startedCode(), drives);
  if ("error" in driver) throw new Error(`The pairing was refused: ${driver.error}`);
  const driving = await signIn(f, driver.id, drives, options, [DIRECT_CARRIER]);
  expect("error" in driving ? driving.error : driving.direct).toEqual(carriers);
  const waits = await phone();
  const waiter = await pair(f, await f.tabCode(), waits);
  if ("error" in waiter) throw new Error(`The pairing was refused: ${waiter.error}`);
  const session = await signIn(f, waiter.id, waits, options, [DIRECT_CARRIER]);
  expect("error" in session ? session.error : [session.role, session.direct]).toEqual(["watch", undefined]);
});

test("a device whose key this PC removed earlier joins again through the code; a link that would move a waiting device to a removed key is refused", async () => {
  const f = await pc();
  // two devices that paired with a code of the PC's own and were then removed on the PC: their keys are kept out
  const [back, gone] = [await phone(), await phone()];
  for (const key of [back, gone]) {
    const made = await pair(f, await f.startedCode(), key);
    if ("error" in made) throw new Error(`The pairing was refused: ${made.error}`);
    expect((await f.local(`/api/devices/${made.id}`, { method: "DELETE", headers: { "x-herdr-machine": "1" } })).status).toBe(204);
  }
  expect([...(await f.status()).blocked ?? []].sort()).toEqual([back.spki, gone.spki].sort());
  const code = await f.tabCode();
  const mover = await signedInWith(f, code);
  // the account vouches for both keys: what keeps the removed one out is this PC's own removal
  await vouchFor(f, "acct_1", gone);
  await vouchFor(f, "acct_1", back);
  const refused = await sendLink(mover.session, await linkRecord(mover.id, "acct_1", mover.key, gone));
  expect([refused.status, refused.body.error?.code]).toEqual([409, "tombstoned"]);
  expect((await ask(mover.session, "/api/account/status")).status).toBe(200);
  // the removed device itself pairs with the code and links with the key it paired with: this PC's own code lets it back in
  const row = await signedInWith(f, code, back);
  untilNextRead(f);
  expect((await sendLink(row.session, await linkRecord(row.id, "acct_1", back))).status).toBe(200);
  expect(await f.status()).toMatchObject({ account: "acct_1", members: 1, blocked: [gone.spki] });
});

const removals: [string, (f: Pc, id: string) => Promise<Answer>, number][] = [["a device", remove, 204], ["every device", removeAll, 200]];
for (const [what, removal, answered] of removals) {
  test(`removing ${what} on the PC takes the device that waits to link with a removed key, at once: its link is not answered, and the key stays removed`, async () => {
    const f = await pc();
    const key = await phone();
    // the key drives the PC by a code started there, and pairs once more with the relay tab's code
    const first = await pair(f, await f.startedCode(), key);
    if ("error" in first) throw new Error(`The pairing was refused: ${first.error}`);
    const waits = await signedInWith(f, await f.tabCode(), key);
    expect((await removal(f, first.id)).status).toBe(answered);
    // the link the waiting device then sends, on the session it signed in with: its answer, or what that session ended with
    const link = await sendLink(waits.session, await linkRecord(waits.id, "acct_1", key)).then((answer) => answer.status, () => ended(waits.session));
    expect(link).toBe("auth_revoked");
    expect([await ended(waits.pairing), await signsIn(f, waits.id, key)]).toEqual(["auth_revoked", "auth_failed"]);
    expect(await f.status()).toMatchObject({ account: null, members: 0, unlinked: [], blocked: [key.spki] });
    expect(f.stored()).toEqual([]);
  });
}

test("a removal whose device list cannot be written still takes the device that waits with that key", async () => {
  const f = await pc();
  const key = await phone();
  const first = await pair(f, await f.startedCode(), key);
  if ("error" in first) throw new Error(`The pairing was refused: ${first.error}`);
  const waits = await signedInWith(f, await f.tabCode(), key);
  const writable = deviceListUnwritable();
  expect((await remove(f, first.id)).status).toBe(500);
  writable();
  expect(await signsIn(f, waits.id, key)).toBe("auth_failed");
  expect((await f.status()).blocked).toEqual([key.spki]);
});

test("an account's removal of a key takes the device that waits with it", async () => {
  const f = await pc();
  const row = await signedInWith(f, await f.tabCode());
  // called as a member's `remove` calls it: a device waits only on a PC with no member, where no record applies
  expect(f.devices.removeAccountKey(row.key.spki, "acct_1", { id: newRecordId(), issuedAt: new Date().toISOString() })).toBe(true);
  expect(await signsIn(f, row.id, row.key)).toBe("auth_failed");
  expect(await ended(row.session)).toBe("auth_revoked");
});

test("a key an account removed stays out when its device pairs with the relay tab's code: its link is refused tombstoned, nothing is written, and the removal stands", async () => {
  const f = await pc();
  // the PC is in an account, and its member removes another device's key through the account
  const member = await signedInWith(f, await f.startedCode());
  expect((await sendLink(member.session, await linkRecord(member.id, "acct_1", member.key))).status).toBe(200);
  const key = await phone();
  const device = await pair(f, await f.startedCode(), key);
  if ("error" in device) throw new Error(`The pairing was refused: ${device.error}`);
  const removal = await signAccountRecord({ v: 1, kind: "remove", account: "acct_1", key: key.spki, issued_at: new Date().toISOString(), id: newRecordId(), signer: member.key.spki }, member.key.keys.privateKey);
  expect((await ask(member.session, "/api/account/records", { method: "POST", body: { records: [removal] } })).body.results).toEqual([{ id: removal.id, outcome: "applied" }]);
  // the removal on record is the account's, by its record's id, and no revoke of this PC
  expect(JSON.parse(readFileSync(join(f.stateDir, "account-tombstones.json"), "utf8")).tombstones).toEqual([expect.objectContaining({ key: key.spki, record_id: removal.id })]);
  // the PC's only member is removed on the PC, which leaves it in no account; the removed device then pairs with the relay tab's code
  expect((await remove(f, member.id)).status).toBe(204);
  const row = await signedInWith(f, await f.tabCode(), key);
  // what the PC's earlier member left on disk: no row, and the barrier of its own first link
  const before = [f.stored(), barrier(f)];
  expect(before).toEqual([[], { by: member.id, confirmed: true }]);
  // the account vouches for the key: what keeps it out is the account's own removal
  await vouchFor(f, "acct_1", key);
  const refused = await sendLink(row.session, await linkRecord(row.id, "acct_1", key));
  expect([refused.status, refused.body.error?.code]).toEqual([409, "tombstoned"]);
  // asked of the device list itself, as a link that passed its checks asks: it writes no row for that key either
  expect(f.devices.linkAccountKey(row.id, key.spki, key.spki, "acct_1")).toBeNull();
  // nothing is written, the account's removal is on record as it was, and the device waits on as after any refused link
  expect([f.stored(), barrier(f)]).toEqual(before);
  expect(JSON.parse(readFileSync(join(f.stateDir, "account-tombstones.json"), "utf8")).tombstones).toContainEqual(expect.objectContaining({ key: key.spki, record_id: removal.id }));
  expect(await f.status()).toMatchObject({ account: null, members: 0, blocked: expect.arrayContaining([key.spki]) });
  expect((await ask(row.session, "/api/account/status")).status).toBe(200);
});

test("an offer asked for without the header never carries the relay tab's code: it starts a code of its own, which ends that one, and its device drives at once and is listed", async () => {
  const f = await pc();
  let started = 0;
  f.devices.onPairingStarted(() => { started += 1; });
  const tab = await f.tabCode();
  const waits = await signedInWith(f, tab);
  expect([started, f.devices.activePairing()?.code]).toEqual([1, tab]);
  const code = await f.offerCode();
  // a code was started for that offer, and the relay tab's ended with the device that waited under it
  expect([started, f.devices.activePairing()?.code]).toEqual([2, code]);
  expect(await ended(waits.session)).toBe("auth_revoked");
  // asked for again, the offer carries the same code and starts none
  expect([await f.offerCode(), started]).toEqual([code, 2]);
  const device = await pair(f, code, await phone());
  if ("error" in device) throw new Error(`The pairing was refused: ${device.error}`);
  expect(device.role).toBe("drive");
  expect((await f.listed()).map((listed) => [listed.id, listed.role])).toEqual([[device.id, "drive"]]);
  expect(f.stored().map((stored) => stored.id)).toEqual([device.id]);
});

test("a waiting device whose link is refused, or whose time runs out, leaves no enrollment barrier; the owner's device then joins, and its enrollment ends the wait", async () => {
  const f = await pc();
  const code = await f.tabCode();
  const row = await signedInWith(f, code);
  // a link whose signature does not hold: the account it names was changed after it was signed
  const refused = await sendLink(row.session, { ...await linkRecord(row.id, "acct_1", row.key), account: "acct_9" });
  expect([refused.status, refused.body.error?.code]).toEqual([400, "signature_invalid"]);
  expect([barrier(f), (await f.status()).enrolling]).toEqual([null, false]);
  f.clock.advance(PAIRING_LINK_MS);
  expect(await ended(row.session)).toBe("auth_revoked");
  expect(barrier(f)).toBeNull();
  // the owner's device pairs with the same code and links: the barrier is its own, and its enrollment ends the wait
  const owner = await signedInWith(f, code);
  await vouchFor(f, "acct_1", owner.key);
  expect((await sendLink(owner.session, await linkRecord(owner.id, "acct_1", owner.key))).status).toBe(200);
  expect(barrier(f)).toEqual({ by: owner.id, confirmed: true });
  const laptop = await phone();
  const add = await signAccountRecord({ v: 1, kind: "add", account: "acct_1", key: laptop.spki, label: "Laptop", role: "drive", issued_at: new Date().toISOString(), id: newRecordId(), signer: owner.key.spki }, owner.key.keys.privateKey);
  const enrolled = await ask(owner.session, "/api/account/enroll", { method: "POST", body: { account: "acct_1", records: [add], last: true } });
  expect(enrolled.body.results).toEqual([{ id: add.id, outcome: "applied" }]);
  expect([barrier(f), await f.status()]).toEqual([null, expect.objectContaining({ account: "acct_1", members: 2, enrolling: false })]);
});

test("the barrier of a waiting device's link is on disk before its row, and is taken back when the row cannot be written: the device waits on, and the same link then joins", async () => {
  const f = await pc();
  const row = await signedInWith(f, await f.tabCode());
  await vouchFor(f, "acct_1", row.key);
  const record = await linkRecord(row.id, "acct_1", row.key);
  // what the barrier holds at the moment the row's write is refused is what a stop at that moment would have left
  let atRowWrite: unknown;
  const writable = deviceListUnwritable(() => { atRowWrite = barrier(f); });
  const unwritten = await sendLink(row.session, record);
  writable();
  expect([unwritten.status, unwritten.body.error?.code]).toEqual([500, "internal_error"]);
  expect(atRowWrite).toEqual({ by: row.id });
  expect([barrier(f), f.stored()]).toEqual([null, []]);
  untilNextRead(f);
  expect((await sendLink(row.session, record)).status).toBe(200);
  expect([barrier(f), await f.status()]).toEqual([{ by: row.id, confirmed: true }, expect.objectContaining({ account: "acct_1", members: 1, enrolling: true })]);
});

test("a waiting device's link whose row cannot be written leaves the barrier of another link that is on its way", async () => {
  const f = await pc();
  // a device that drives the PC by a code started there sends its first link: its barrier is written as the link arrives
  const paired = await signedInWith(f, await f.startedCode());
  const waits = await signedInWith(f, await f.tabCode());
  await vouchFor(f, "acct_1", paired.key);
  await vouchFor(f, "acct_1", waits.key);
  const check = holdRecordCheck();
  const first = sendLink(paired.session, await linkRecord(paired.id, "acct_1", paired.key));
  await bounded(check.reached);
  expect(barrier(f)).toEqual({ by: paired.id });
  // the waiting device's link passes its checks meanwhile, and its row cannot be written
  const writable = deviceListUnwritable();
  const unwritten = await sendLink(waits.session, await linkRecord(waits.id, "acct_1", waits.key));
  writable();
  expect([unwritten.status, unwritten.body.error?.code]).toEqual([500, "internal_error"]);
  expect(barrier(f)).toEqual({ by: paired.id });
  // the first link then waits for a read of the account service of its own
  const asked = nextAsk(f);
  check.release();
  await asked;
  untilNextRead(f);
  expect((await first).status).toBe(200);
  expect(barrier(f)).toEqual({ by: paired.id, confirmed: true });
});
