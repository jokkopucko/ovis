/**
 * `ovis add` against this PC's own server (server/index.ts on a state folder of its own and a free port), with devices
 * coming through the relay's test harness (server/account/pairing.test-helpers.ts): the code it shows is made for the
 * account that signed in, so a device signed in to no account, or to another account, gets nothing of the PC with it,
 * also once the command is gone without taking it back, and a device of that account joins with it. The relay of
 * that harness never comes online, so the command alone is told it is (GET /api/relay); every other call reaches the
 * server. No test sleeps: the command's waits between looks are released one at a time, each bounded.
 */
import { afterEach, expect, test } from "bun:test";
import { decodeOffer } from "../shared/relay-offer.ts";
import { FakeAccountService } from "../shared/account-service-fake.ts";
import { PAIRING_LINK_MS } from "../server/devices.ts";
import { ask, ended, linkRecord, pairingPc, phone, sendLink, signedInWith, vouchFor, type Pc } from "../server/account/pairing.test-helpers.ts";
import { bounded, TestClock } from "../server/relay/test-helpers.ts";
import { link } from "./plugin-link.ts";

const pcs: Pc[] = [];
afterEach(async () => {
  for (const pc of pcs.splice(0)) await pc.close();
});

const OWNER = "acct_owner";

/**
 * `ovis add` run against a fresh PC, signed in to OWNER, until its QR code is on the screen. `look()` lets it take
 * one more look at the PC and waits until it waits again; `die()` makes the PC unreachable for it from then on, as
 * for a command killed outright, whose code nobody takes back. `typed`: what happens on the PC once its code to type
 * was answered, before the command asks for its QR code.
 */
async function adding(typed?: (pc: Pc) => void) {
  const made = await pairingPc();
  pcs.push(made);
  const clock = new TestClock();
  made.devices.useClock(clock);
  const origin = `http://127.0.0.1:${made.app.port}`;
  const service = new FakeAccountService();
  const stop = new AbortController();
  const out: string[] = [];
  const named: (string | null)[] = [];
  let code: string | null = null;
  let drawn = false;
  let signedIn = false;
  let dead = false;
  let parked: (() => void) | null = null;
  let onPark: (() => void) | null = null;
  const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    const path = new URL(request.url).pathname;
    if (dead) throw new TypeError("connection refused");
    if (path === "/api/relay" && request.method === "GET") return Response.json({ phase: "online", blocked: null });
    if (path === "/api/relay/offer" || path === "/api/relay/code") named.push(request.headers.get("x-ovis-expect-account"));
    const response = await globalThis.fetch(request);
    if (path === "/api/relay/code") typed?.(made);
    if (path === "/api/relay/offer" && response.ok) code = decodeOffer((await response.clone().json() as { url: string }).url)?.code ?? null;
    return response;
  };
  // until the QR code is drawn (the sign-in, the relay coming online) and once the run is stopped, waits end at once
  const wait = (_ms: number, signal: AbortSignal): Promise<void> => new Promise((resolve, reject) => {
    if (signal.aborted) { reject(signal.reason); return; }
    if (!drawn || stop.signal.aborted || dead) { setTimeout(resolve, 0); return; }
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    parked = () => { signal.removeEventListener("abort", abort); resolve(); };
    const told = onPark;
    onPark = null;
    told?.();
  });
  const waiting = () => new Promise<void>((resolve) => { if (parked !== null) resolve(); else onPark = resolve; });
  const run = link([], {
    origin, headers: {}, fetch, accountService: "https://account.test", serviceFetch: service.fetch, signal: stop.signal,
    lines: { next: () => new Promise(() => {}) }, terminal: true, isTty: true, wait,
    out: (text) => {
      out.push(text);
      const shown = /code:? ([A-Z0-9-]{4,16})\b/.exec(text);
      if (shown && !signedIn) { signedIn = true; service.approveDevice(shown[1]!, OWNER); }
      if (text.includes("Scan this QR code")) drawn = true;
    },
  });
  await bounded(waiting());
  if (code === null) throw new Error(`No QR code was shown: ${out.join("")}`);
  return {
    pc: made, clock, out, named, run, stop, code: code as string,
    /** what the command said since it started */
    text: () => out.join(""),
    /** one more look at the PC; it is waiting again, or done, when this returns */
    async look() {
      const next = parked!;
      parked = null;
      const again = waiting();
      next();
      await bounded(Promise.race([again, run.then(() => undefined)]));
    },
    die() { dead = true; },
  };
}

test("the code ovis add shows is made for the account that signed in: a device signed in to no account or to another gets nothing of the PC with it, and one of that account joins", async () => {
  const add = await adding();
  expect(add.named).toEqual([OWNER, OWNER]);
  expect(add.text()).not.toContain("older than this command");
  // a device signed in to no account pairs with the code and waits to link: no device of this PC, and gone in time
  const signedOut = await signedInWith(add.pc, add.code);
  expect((await ask(signedOut.session, "/api/devices")).body.error?.code).toBe("link_required");
  expect(await add.pc.listed()).toEqual([]);
  await add.look();
  add.clock.advance(PAIRING_LINK_MS);
  expect([await ended(signedOut.session), await ended(signedOut.pairing)]).toEqual(["auth_revoked", "auth_revoked"]);
  // the command did not end its code for it: the code is still the one pending
  await add.look();
  expect(add.pc.devices.activePairing()?.code).toBe(add.code);
  // a device signed in to another account is refused, goes at once, and the code stays
  const stranger = await signedInWith(add.pc, add.code);
  const refused = await sendLink(stranger.session, await linkRecord(stranger.id, "acct_other", stranger.key));
  expect([refused.status, refused.body.error?.code]).toEqual([409, "account_mismatch"]);
  expect(await ended(stranger.session)).toBe("auth_revoked");
  await add.look();
  expect(await add.pc.listed()).toEqual([]);
  expect(await add.pc.status()).toMatchObject({ account: null, members: 0 });
  expect(add.pc.devices.activePairing()?.code).toBe(add.code);
  // the device of the account that signed in, which its account vouched for, joins with the same code, and the command ends on it
  const key = await phone();
  await vouchFor(add.pc, OWNER, key);
  const owner = await signedInWith(add.pc, add.code, key);
  expect((await sendLink(owner.session, await linkRecord(owner.id, OWNER, owner.key))).status).toBe(200);
  await add.look();
  expect(await add.pc.status()).toMatchObject({ account: OWNER, members: 1 });
  expect((await add.pc.listed()).map((device) => device.id)).toEqual([owner.id]);
  expect(add.pc.devices.activePairing()).toBeNull();
  if (!add.text().includes(`This PC is in your account (${OWNER})`)) add.stop.abort();
  await bounded(add.run);
  expect((await add.pc.listed()).map((device) => device.id)).toEqual([owner.id]);
});

test("a code ovis add left behind, killed before it could take it back, still admits no device of another account or of none", async () => {
  const add = await adding();
  add.die();
  add.stop.abort();
  expect(await bounded(add.run)).toBe(1);
  expect(add.text()).toContain("Taking the code back was not confirmed");
  expect(add.pc.devices.activePairing()?.code).toBe(add.code);
  const signedOut = await signedInWith(add.pc, add.code);
  expect((await ask(signedOut.session, "/api/devices")).body.error?.code).toBe("link_required");
  add.clock.advance(PAIRING_LINK_MS);
  expect(await ended(signedOut.session)).toBe("auth_revoked");
  const stranger = await signedInWith(add.pc, add.code);
  expect((await sendLink(stranger.session, await linkRecord(stranger.id, "acct_other", stranger.key))).body.error?.code).toBe("account_mismatch");
  expect(await add.pc.listed()).toEqual([]);
  expect(await add.pc.status()).toMatchObject({ account: null, members: 0 });
  // what it still lets in is a device of the account that signed in, which its account vouched for
  const key = await phone();
  await vouchFor(add.pc, OWNER, key);
  const owner = await signedInWith(add.pc, add.code, key);
  expect((await sendLink(owner.session, await linkRecord(owner.id, OWNER, owner.key))).status).toBe(200);
  expect(await add.pc.status()).toMatchObject({ account: OWNER, members: 1 });
});

test("ovis add shows a code of its own when another run made a code for the same account between its code to type and its QR code, and takes back only its own", async () => {
  let other: { code: string; pairing: { id: string } } | null = null;
  const add = await adding((pc) => { other ??= pc.devices.startAccountPairing(OWNER); });
  // the QR code carries a code this run asked for, which replaced the other run's
  expect(add.code).not.toBe(other!.code);
  expect(add.pc.devices.accountPairingState(other!.pairing.id)).toMatchObject({ state: "ended", ended: { why: "replaced" } });
  expect(add.pc.devices.activePairing()?.code).toBe(add.code);
  // the other run takes back its own code by its id as it ends: this run's code stays
  const theirs = await add.pc.local("/api/devices/pair/cancel", { method: "POST", headers: { "x-herdr-machine": "1" }, body: { id: other!.pairing.id } });
  expect([theirs.status, theirs.body.cancelled]).toEqual([200, false]);
  expect(add.pc.devices.activePairing()?.code).toBe(add.code);
  add.stop.abort();
  expect(await bounded(add.run)).toBe(1);
  // its own code went back by its id: nothing is pending
  expect(add.text()).toContain("The code and the QR code no longer work.");
  expect(add.pc.devices.activePairing()).toBeNull();
});
