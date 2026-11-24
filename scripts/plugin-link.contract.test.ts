/**
 * `ovis add` against this PC's own server (server/index.ts on a state folder of its own and a free port), with devices
 * coming through the relay's test harness (server/account/pairing.test-helpers.ts). Without --qr, a device of the
 * account that signed in presses Add, and this PC takes that admission from the command (POST /api/account/one-press)
 * on its own proof to the account service. With --qr, the code it shows is made for the account that signed in, so a
 * device signed in to no account, or to another account, gets nothing of the PC with it, also once the command is
 * gone without taking it back, and a device of that account joins with it. The relay of that harness never comes
 * online, so the command alone is told it is (GET /api/relay); every other call reaches the server. No test sleeps:
 * the command's waits between looks are released one at a time, each bounded.
 */
import { afterEach, expect, spyOn, test } from "bun:test";
import { bytesToHex } from "@noble/hashes/utils.js";
import { accountDeviceId, exportAccountKey } from "../shared/account-records.ts";
import { decodeOffer } from "../shared/relay-offer.ts";
import { channelBinding, importPublicKey } from "../shared/relay-e2ee.ts";
import { FrameType, PAIR_INTENT_ACCOUNT, PAIR_SAS_FEATURE, type MuxFrame } from "../shared/relay-mux.ts";
import { fromBase64Url, pairCommitment, pairDigits, randomPairNonce, toBase64Url } from "../shared/relay-pair-sas.ts";
import { PAIRING_LINK_MS } from "../server/devices.ts";
import { JOIN_HOLD_MS } from "../server/account/join-hold.ts";
import { TestList } from "../server/account/list.test-helpers.ts";
import { ask, ended, linkRecord, pairingPc, phone, sendLink, signedInWith, vouchFor, type Pc, type Phone } from "../server/account/pairing.test-helpers.ts";
import { bounded, deferred, relayConnection, TestClock } from "../server/relay/test-helpers.ts";
import { approveJoins, link, type OwnJoin } from "./plugin-link.ts";

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
  // the command signs in to the service the PC's own Ovis uses (both read OVIS_ACCOUNT_SERVICE_URL): the PC's proof on
  // its listing is a challenge of that service
  const service = made.account;
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
  const run = link(["--qr"], {
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

test("ovis add --account, as a script or an agent runs it with no terminal: this PC takes the admission of a device of that account that pressed Add, on its own proof", async () => {
  const made = await pairingPc();
  pcs.push(made);
  const service = made.account;
  service.opensAll = true;
  const origin = `http://127.0.0.1:${made.app.port}`;
  const out: string[] = [];
  const asked: number[] = [];
  let signedIn = false;
  let pressed: Promise<Response> | null = null;
  const serverId = made.app.context.services.relay.currentIdentity()!.server_id;
  const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    const path = new URL(request.url).pathname;
    if (path === "/api/relay" && request.method === "GET") return Response.json({ phase: made.devices.account() === null ? "connecting" : "online", blocked: null });
    const response = await globalThis.fetch(request);
    if (path === "/api/account/one-press") asked.push(response.status);
    return response;
  };
  const code = await bounded(link(["--account", OWNER], {
    origin, headers: {}, fetch, accountService: "https://account.test", serviceFetch: service.fetch, signal: new AbortController().signal,
    lines: { next: () => new Promise(() => {}) }, terminal: false, isTty: false,
    // the waits between asks end at once, until the device pressed Add
    wait: (_ms, signal) => new Promise((resolve, reject) => { if (signal.aborted) reject(signal.reason); else setTimeout(resolve, 0); }),
    out: (text) => {
      out.push(text);
      const shown = /code:? ([A-Z0-9-]{4,16})\b/.exec(text);
      if (shown && !signedIn) { signedIn = true; service.approveDevice(shown[1]!, OWNER); }
      // a device of the account, with a sign-in of its own made just now, presses Add on this PC's card
      if (text.includes("press Add for")) {
        pressed = service.fetch(new Request(`https://account.test/v1/pcs/${serverId}/admit`, {
          method: "POST", headers: { authorization: `Bearer ${service.issueToken(OWNER)}`, "content-type": "application/json" }, body: "{}",
        }));
      }
    },
  }));
  expect((await pressed!)?.status).toBe(200);
  expect(code).toBe(0);
  expect(out.join("")).toContain(`Ovis account ${OWNER.slice(0, 12)} (signed in with GitHub) is the one --account names.`);
  expect(out.join("")).not.toContain("\x1b");
  expect(out.join("")).toContain("Added. Open ");
  // the first ask, with no account, only asked whether this PC takes such an add; every ask after it but the last found no admission yet
  expect(asked[0]).toBe(400);
  expect(asked.slice(1, -1).every((status) => status === 404)).toBe(true);
  expect(asked.at(-1)).toBe(200);
  expect(made.devices.account()).toBe(OWNER);
  expect(service.pcs(OWNER).map((entry) => [entry.server_id, entry.listed_by_device])).toEqual([[serverId, false]]);
});

test("ovis add at a terminal, for an account that keeps a signed list: the PC and the adding device show one number, a yes typed here confirms it, and the PC joins by the list", async () => {
  const made = await pairingPc({ server: { accountOpensAll: true, accountListAddPollMs: 0 } });
  pcs.push(made);
  const service = made.account;
  service.opensAll = true;
  service.listAccounts = "*";
  service.completions = true;
  const account = await TestList.start(service, OWNER);
  const identity = made.app.context.services.relay.currentIdentity()!;
  const endpoint = bytesToHex(importPublicKey(identity.public_key));
  const origin = `http://127.0.0.1:${made.app.port}`;
  const out: string[] = [];
  const keys = terminalLines();
  let at = Date.now();
  const pressed: string[] = [];
  let signedIn = false;
  let phoneShows: string | null = null;
  let comparing: Promise<void> | null = null;
  let adding: Promise<unknown> | null = null;
  const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    const path = new URL(request.url).pathname;
    if (path === "/api/relay" && request.method === "GET") return Response.json({ phase: made.devices.account() === null ? "connecting" : "online", blocked: null });
    if (path === "/api/account/one-press") pressed.push(await request.clone().text());
    const response = await globalThis.fetch(request);
    if (path === "/api/account/list/add" && revealing !== null && phoneShows === null) {
      phoneShows = await (revealing as { reveal: () => Promise<string | null> }).reveal();
      if (phoneShows !== null) answered.resolve();
    }
    return response;
  };
  // the device that adds the PC: it opens the comparison on the PC's card, and shows its number once the PC answered
  // it reveals once the PC answered its commitment, which the command's next ask of the PC brings about
  let revealing: { reveal: () => Promise<string | null> } | null = null;
  const answered = deferred<void>();
  const compare = async (): Promise<void> => {
    const number = await account.compare(endpoint);
    await number.commit();
    revealing = number;
    await answered.promise;
  };
  const code = await bounded(link([], {
    origin, headers: {}, fetch, accountService: "https://account.test", serviceFetch: service.fetch, signal: new AbortController().signal,
    lines: keys.lines, discard: keys.discard, terminal: true, isTty: true, now: () => at,
    wait: (ms, signal) => new Promise((resolve, reject) => { if (signal.aborted) reject(signal.reason); else setTimeout(() => { at += ms; resolve(); }, 1); }),
    out: (text) => {
      out.push(text);
      const typeLater = (line: string): void => { setTimeout(() => { at += 2_000; keys.type(line); }, 0); };
      const shown = /code:? ([A-Z0-9-]{4,16})\b/.exec(text);
      if (shown && !signedIn) { signedIn = true; service.approveDevice(shown[1]!, OWNER); }
      if (text.includes("Is this your account? Type yes")) typeLater("yes");
      if (text.includes("Your account keeps a signed list")) comparing = compare();
      const asked = /This PC shows ([0-9]{3}) ([0-9]{3})\. Does the device that adds it show the same number\?/.exec(text);
      // the person compares the two screens, and says yes only when they agree
      if (asked) void comparing!.then(() => { if (phoneShows === `${asked[1]}${asked[2]}`) typeLater("yes"); });
      // then presses Add on the device: the account admits the PC, and the device signs its entry
      if (text.includes("Confirmed. Press Add for")) {
        adding = service.fetch(new Request(`https://account.test/v1/pcs/${identity.server_id}/admit`, { method: "POST",
          headers: { authorization: `Bearer ${service.issueToken(OWNER, { twoStep: true })}`, "content-type": "application/json" }, body: "{}" }))
          .then(() => account.addPostedPc(endpoint));
      }
      if (text.endsWith("type them here (Enter to finish without): ")) typeLater("");
    },
  }), 60_000);
  await adding;
  const text = out.join("");
  expect(text).toContain("Confirmed. Press Add for");
  expect(code).toBe(0);
  expect(text).toContain("Added. ");
  expect(phoneShows).toMatch(/^[0-9]{6}$/);
  // bound by the list alone: no admission of the account service was asked for, and the binding is pinned from its start
  expect(pressed).toEqual(["{}"]);
  expect(made.devices.account()).toBe(OWNER);
  expect(made.devices.listFollowed()).toBe(true);
  expect(made.devices.serviceBinding()).toBeNull();
  expect(made.app.context.services.accountList!.status()).toMatchObject({ pinned: true, standing: "in", list: account.id });
});

/** Lines typed at a terminal when the test types them: one typed while nothing reads waits for the next read. */
function terminalLines() {
  const kept: string[] = [];
  let reader: ((line: IteratorResult<string>) => void) | null = null;
  return {
    lines: { next: () => { const line = kept.shift(); return line !== undefined ? Promise.resolve({ value: line, done: false as const }) : new Promise<IteratorResult<string>>((resolve) => { reader = resolve; }); } },
    type: (line: string) => { const resolve = reader; reader = null; if (resolve === null) kept.push(line); else resolve({ value: line, done: false }); },
    discard: () => { kept.length = 0; return true; },
  };
}

/**
 * The first device that opens a PC added in one press, which has no member yet: its account admitted it (an admission
 * for its key, `vouchFor`), and it asks to join through the relay with the account intent. The PC takes that as a first
 * join, which only its own window, or its terminal, may let in. The PC reads its account's admissions at most once every
 * 10 seconds, so every device that asks in one test is vouched for before the first asks.
 */
async function firstJoin(pc: Pc, device: Phone) {
  const session = await relayConnection(pc);
  const frames: MuxFrame[] = [];
  let heard: (() => void) | undefined;
  session.onFrame = (frame) => { frames.push(frame); heard?.(); };
  const next = async (type: number): Promise<MuxFrame> => {
    for (;;) {
      const index = frames.findIndex((frame) => frame.type === type || frame.type === FrameType.SESSION_ERROR);
      if (index >= 0) return frames.splice(index, 1)[0]!;
      const arrived = deferred<void>();
      heard = arrived.resolve;
      await bounded(arrived.promise);
    }
  };
  await session.hello([PAIR_SAS_FEATURE, PAIR_INTENT_ACCOUNT]);
  const binding = channelBinding(session.channel);
  if (!binding) throw new Error("No channel binding");
  const nonce = randomPairNonce();
  session.mux.sendSession({ type: FrameType.PAIR_REQUEST, flags: 0, stream_id: 0,
    payload: { label: "Android · Chrome", public_key: device.spki, commitment: toBase64Url(pairCommitment(binding, device.spki, nonce)) } });
  const challenge = await next(FrameType.PAIR_CHALLENGE);
  if (challenge.type !== FrameType.PAIR_CHALLENGE) throw new Error(`The join was refused: ${JSON.stringify(challenge.payload)}`);
  session.mux.sendSession({ type: FrameType.PAIR_REVEAL, flags: 0, stream_id: 0, payload: { nonce: toBase64Url(nonce) } });
  return {
    next, approveOn: challenge.payload.approve_on as string | undefined, digits: pairDigits(binding, device.spki, nonce, fromBase64Url(challenge.payload.nonce)),
    /** the device goes on once the digits show, as the app does for a join the PC decides (docs/relay.md, step 7) */
    confirm: () => session.mux.sendSession({ type: FrameType.PAIR_CONFIRM, flags: 0, stream_id: 0, payload: { confirmed: true } }),
  };
}

/** Resolves once this PC holds a join for its own window. */
function joinWaiting(pc: Pc): Promise<void> {
  const approvals = pc.app.context.services.relay.approvals;
  const found = deferred<void>();
  const stop = approvals.subscribe(() => { if (approvals.ownJoins().length > 0) found.resolve(); });
  if (approvals.ownJoins().length > 0) found.resolve();
  return bounded(found.promise).finally(stop);
}

/**
 * `ovis add --account` at a terminal on a fresh PC, run until it is added and asks for a phone's digits (its watch). A
 * device of the account presses Add as the command says to. `type` sends a line once the question could be read, on
 * the command's own clock.
 */
async function addedAtTerminal(made: Pc) {
  const service = made.account;
  service.opensAll = true;
  const origin = `http://127.0.0.1:${made.app.port}`;
  const serverId = made.app.context.services.relay.currentIdentity()!.server_id;
  const keys = terminalLines();
  const out: string[] = [];
  let signedIn = false;
  let skew = 0;
  const watching = deferred<void>();
  const asked = deferred<string>();
  const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    if (new URL(request.url).pathname === "/api/relay" && request.method === "GET") return Response.json({ phase: made.devices.account() === null ? "connecting" : "online", blocked: null });
    return await globalThis.fetch(request);
  };
  const run = link(["--account", OWNER], {
    origin, headers: {}, fetch, accountService: "https://account.test", serviceFetch: service.fetch, signal: new AbortController().signal,
    lines: keys.lines, discard: keys.discard, terminal: true, isTty: true, now: () => Date.now() + skew,
    wait: (_ms, signal) => new Promise((resolve, reject) => { if (signal.aborted) reject(signal.reason); else setTimeout(resolve, 0); }),
    out: (text) => {
      out.push(text);
      const shown = /code:? ([A-Z0-9-]{4,16})\b/.exec(text);
      if (shown && !signedIn) { signedIn = true; service.approveDevice(shown[1]!, OWNER); }
      if (text.includes("press Add for")) {
        void service.fetch(new Request(`https://account.test/v1/pcs/${serverId}/admit`, {
          method: "POST", headers: { authorization: `Bearer ${service.issueToken(OWNER)}`, "content-type": "application/json" }, body: "{}",
        }));
      }
      if (text.includes("If the phone shows six digits, type them here")) watching.resolve();
      if (text.includes("asks to open this PC")) asked.resolve(text);
    },
  });
  await bounded(watching.promise);
  expect(made.devices.account()).toBe(OWNER);
  return {
    run, serverId, asked: asked.promise,
    text: () => out.join(""),
    type: (line: string) => { skew += 2_000; keys.type(line); },
  };
}

test("ovis add at a terminal goes on after Added: the first device that opens the PC asks for a first join, and the six digits it shows, typed here, let it in", async () => {
  const made = await pairingPc({ server: { accountOpensAll: true, platform: "linux" } });
  pcs.push(made);
  const add = await addedAtTerminal(made);
  expect(made.devices.hasAccountApprover()).toBe(false);
  // the phone opens the PC from My PCs: no member could approve it, so this PC itself is asked
  const device = await phone();
  await vouchFor(made, OWNER, device);
  const waiting = joinWaiting(made);
  const join = await firstJoin(made, device);
  expect(join.approveOn).toBe("linux");
  await waiting;
  const question = await bounded(add.asked);
  expect(question).toContain("Android · Chrome asks to open this PC (from Ovis account acct_owner,");
  expect(question).not.toContain(join.digits.slice(3));
  join.confirm();
  add.type(join.digits);
  expect(await bounded(add.run)).toBe(0);
  expect(add.text()).toContain("Android · Chrome is let in; it opens this PC in a moment.\n");
  expect((await join.next(FrameType.AUTH_OK)).type).toBe(FrameType.AUTH_OK);
  expect(made.devices.hasKey(device.spki)).toBe(true);
});

test("ovis add at a terminal ends its watch when the phone, a row of the account's list it knew from the start, signs in with no join", async () => {
  const made = await pairingPc({ server: { accountOpensAll: true, platform: "linux" } });
  pcs.push(made);
  // the phone is on the account's list before the press: the PC's first read of that list lets it in
  const keys = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
  const publicKey = await exportAccountKey(keys.publicKey);
  made.account.registerDevice(OWNER, publicKey, "Pixel");
  const add = await addedAtTerminal(made);
  const id = accountDeviceId(add.serverId, publicKey);
  const listed = (await made.listed()).find((row) => row.id === id);
  expect(listed).toMatchObject({ through_account: true, last_seen_at: null });
  // it opens the PC with its account key once its row's join hold is over: no join, nothing to type
  const realNow = Date.now.bind(Date);
  const clock = spyOn(Date, "now").mockImplementation(() => realNow() + JOIN_HOLD_MS);
  try {
    const session = await relayConnection(made, { serverId: add.serverId });
    await session.auth({ keys, publicKey, id });
    expect(await bounded(add.run)).toBe(0);
  } finally { clock.mockRestore(); }
  expect(add.text()).toContain("Pixel can open this PC now: it got in through your account. If your phone asks for six digits when you open ");
  expect(add.text()).not.toContain("asks to open this PC");
});

/** A PC added to OWNER in one press, as `ovis add` leaves it: in the account, with no member to approve a join. */
async function addedPc(): Promise<Pc> {
  const made = await pairingPc({ server: { accountOpensAll: true, platform: "linux" } });
  pcs.push(made);
  made.account.opensAll = true;
  const identity = made.app.context.services.relay.currentIdentity()!;
  const named = await made.local("/api/account/relay-account", { method: "POST", headers: { "x-herdr-machine": "1" }, body: { account: OWNER } });
  if (named.status !== 204) throw new Error(`The account was not named: ${named.status} ${JSON.stringify(named.body)}`);
  const token = made.account.issueToken(OWNER, { twoStep: true });
  const call = (path: string, method: string) => made.account.fetch(new Request(`https://account.test${path}`, { method, headers: { authorization: `Bearer ${token}` },
    body: JSON.stringify(method === "PUT" ? { label: "PC", public_key: bytesToHex(importPublicKey(identity.public_key)), relay: "wss://relay.ovis.sh" } : {}) }));
  await call(`/v1/pcs/${identity.server_id}`, "PUT");
  await call(`/v1/pcs/${identity.server_id}/admit`, "POST");
  const pressed = await made.local("/api/account/one-press", { method: "POST", headers: { "x-herdr-machine": "1", "x-herdr-update": "1" }, body: { account: OWNER } });
  if (pressed.status !== 200) throw new Error(`The PC was not added: ${pressed.status} ${JSON.stringify(pressed.body)}`);
  expect(made.devices.hasAccountApprover()).toBe(false);
  return made;
}

/**
 * `ovis approve` at this PC's terminal (scripts/plugin.ts approvePairings): the joins this PC's own route lists to it,
 * each first join asked about with the six digits typed, sent to that route as the command sends them.
 */
async function approving(pc: Pc, answer: (said: string, type: (line: string) => void) => void) {
  const base = `http://127.0.0.1:${pc.app.port}`;
  const headers = { "content-type": "application/json", "x-herdr-machine": "1", "x-herdr-update": "1", origin: base };
  const { joins } = await (await fetch(`${base}/api/relay/joins`, { headers })).json() as { joins: OwnJoin[] };
  const keys = terminalLines();
  let at = Date.now();
  const out: string[] = [];
  const code = await approveJoins(joins, {
    account: OWNER, lines: keys.lines, discard: keys.discard, terminal: true, signal: new AbortController().signal, now: () => at,
    out: (text) => { out.push(text); answer(text, (line) => { setTimeout(() => { at += 2_000; keys.type(line); }, 0); }); },
    approve: async (id, digits) => {
      const typed = await fetch(`${base}/api/relay/join`, { method: "POST", headers, body: JSON.stringify({ id, digits }) });
      if (typed.ok) return "approved";
      const code = ((await typed.json()) as { error?: { code?: string } }).error?.code;
      return code === "wrong_digits" ? "wrong_digits" : code === "relay_pairing_gone" ? "gone" : "away";
    },
  });
  return { code, joins, text: out.join("") };
}

test("ovis approve lets in a first join, listed to this PC's terminal, with the six digits its device shows; wrong digits end it, and Enter leaves it waiting", async () => {
  const pc = await addedPc();
  const device = await phone();
  await vouchFor(pc, OWNER, device);
  // Enter by itself: nothing is sent, and the join still waits
  let waiting = joinWaiting(pc);
  const left = await firstJoin(pc, device);
  await waiting;
  const skip = await approving(pc, (said, type) => { if (said.includes("press Enter to skip")) type(""); });
  expect(skip.joins).toHaveLength(1);
  expect(skip.joins[0]!.digits).toBe(left.digits);
  expect(skip.text).toContain("Android · Chrome asks to open this PC (from Ovis account acct_owner,");
  expect(skip.text).not.toContain(left.digits.slice(3));
  expect(skip.text).toContain("Android · Chrome is left waiting until its time runs out.\n");
  expect(pc.app.context.services.relay.approvals.ownJoins()).toHaveLength(1);
  // wrong digits end that join: the device is refused, and nothing was let in
  const wrong = left.digits === "000000" ? "111111" : "000000";
  const refused = await approving(pc, (said, type) => { if (said.includes("press Enter to skip")) type(wrong); });
  expect(refused.text).toContain("That is not the number Android · Chrome shows, so it was not let in.");
  const ended = await left.next(FrameType.AUTH_OK);
  expect(ended.type === FrameType.SESSION_ERROR ? ended.payload.code : ended.type).toBe("auth_failed");
  expect(pc.devices.hasKey(device.spki)).toBe(false);
  expect(pc.app.context.services.relay.approvals.ownJoins()).toEqual([]);
  // the device asks again, with new digits, and those typed here let it in
  waiting = joinWaiting(pc);
  const join = await firstJoin(pc, device);
  await waiting;
  join.confirm();
  const approved = await approving(pc, (said, type) => { if (said.includes("press Enter to skip")) type(join.digits); });
  expect(approved.code).toBe(0);
  expect(approved.text).toContain("Android · Chrome is let in; it opens this PC in a moment.\n");
  expect((await join.next(FrameType.AUTH_OK)).type).toBe(FrameType.AUTH_OK);
  expect(pc.devices.hasKey(device.spki)).toBe(true);
});
