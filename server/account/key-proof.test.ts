/**
 * A pairing that proves its key and waits for this PC's screen (device-row-states rows S31, T71, T72; the hub's and
 * security-triage's S2-13 conditions): the order is HELLO with key-proof-1, PAIR naming the key, KEY_CHALLENGE made
 * only then, one KEY_PROVE, KEY_PENDING, and a row only when the screen approves that very key.
 */
import { expect, test } from "bun:test";
import { exportAccountKey } from "../../shared/account-records.ts";
import { pairFingerprint, signPairProof } from "../../shared/pair-fingerprint.ts";
import { bounded } from "../relay/test-helpers.ts";
import { askScreenForKey, KeyProofPairings, type RedeemSeams } from "./key-proof.ts";
import { LocalConfirms } from "./local-confirm.ts";
import { PENDING_PER_CODE, PendingRedemptions } from "./pending.ts";

const SERVER = "0123456789abcdef0123456789abcdef";

async function device() {
  const keys = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]) as CryptoKeyPair;
  return { keys, spki: await exportAccountKey(keys.publicKey) };
}

function setup(options: { codeOk?: boolean; admitted?: boolean | "throws"; shared?: boolean; live?: () => boolean } = {}) {
  const calls: string[] = [];
  const held = new Set<string>();
  const seams: RedeemSeams = {
    redeemCode: (code, how, key) => {
      calls.push(`redeem ${code} ${how}`);
      if (options.codeOk === false) return { ok: false, reason: "invalid_code" };
      const codeId = options.shared ? code : `use-${calls.length}`;
      held.add(JSON.stringify([codeId, key]));
      return { ok: true, codeId, origin: "pc" };
    },
    releaseRedemption: (codeId, key) => { calls.push(`release ${codeId}`); held.delete(JSON.stringify([codeId, key])); },
    codeLive: () => options.live?.() ?? true,
    admitConfirmed: ({ codeId, key, source }) => {
      calls.push(`admit ${codeId} ${source}`);
      if (options.admitted === "throws") throw new Error("Admission storage failed");
      return options.admitted === false || !held.delete(JSON.stringify([codeId, key])) ? null : { id: "0123456789abcdef", label: "Phone", role: "drive" };
    },
  };
  const pending = new PendingRedemptions({ serverId: SERVER, journalDrop: () => {}, release: (codeId, key) => seams.releaseRedemption(codeId, key) });
  const pairings = new KeyProofPairings({ pending, seams });
  return { pairings, pending, calls };
}

test("T71: a device that does not offer key-proof-1 is refused unsupported_version, never left waiting", async () => {
  const { pairings, calls } = setup();
  const phone = await device();
  expect(pairings.pair({ code: "123456", label: "Phone", publicKey: phone.spki, how: "code", via: "relay", keyProof: false })).toEqual({ refuse: "unsupported_version" });
  expect(calls).toEqual([]);
});

test("T71: a wrong code is refused before any challenge, and spends the guess", async () => {
  const { pairings, calls } = setup({ codeOk: false });
  const phone = await device();
  expect(pairings.pair({ code: "123456", label: "Phone", publicKey: phone.spki, how: "code", via: "relay", keyProof: true })).toEqual({ refuse: "auth_failed" });
  expect(calls).toEqual(["redeem 123456 code"]);
});

test("T71/T72: the challenge comes after the key is named, the proof makes it wait, and only the screen's approval of that key admits it", async () => {
  const { pairings, calls } = setup();
  const phone = await device();
  const started = pairings.pair({ code: "123456", label: "Phone", publicKey: phone.spki, how: "code", via: "relay", keyProof: true });
  if (!("challenge" in started)) throw new Error("no challenge");
  const proved = await pairings.prove(started.session, await signPairProof(SERVER, started.challenge, phone.spki, phone.keys.privateKey));
  if (!("pending" in proved)) throw new Error("not pending");
  const fingerprint = await pairFingerprint(SERVER, started.challenge, phone.spki);
  expect(proved.pending.fingerprint).toBe(fingerprint);
  const decided = pairings.decision(started.session);
  expect(pairings.approve(proved.pending.id, "AAAA-BBBB", "screen")).toBeNull();
  expect(pairings.approve(proved.pending.id, fingerprint, "screen")?.id).toBe("0123456789abcdef");
  expect(await bounded(decided)).toEqual({ admitted: { id: "0123456789abcdef", label: "Phone", role: "drive" } });
  expect(calls).toEqual(["redeem 123456 code", "admit use-1 screen"]);
});

test("T71: a proof for a challenge this session was not given, or a second proof, is refused and frees the use", async () => {
  const { pairings, calls } = setup();
  const phone = await device();
  const stranger = await device();
  const started = pairings.pair({ code: "123456", label: "Phone", publicKey: phone.spki, how: "code", via: "relay", keyProof: true });
  if (!("challenge" in started)) throw new Error("no challenge");
  expect(await pairings.prove(started.session, await signPairProof(SERVER, started.challenge, stranger.spki, stranger.keys.privateKey))).toEqual({ refuse: "auth_failed" });
  expect(await pairings.prove(started.session, await signPairProof(SERVER, started.challenge, phone.spki, phone.keys.privateKey))).toEqual({ refuse: "auth_failed" });
  expect(await pairings.prove("no-such-session", "x")).toEqual({ refuse: "auth_failed" });
  expect(calls).toEqual(["redeem 123456 code", "release use-1"]);
});

test("T72: a decline or the session leaving ends the wait and gives the use back", async () => {
  const { pairings, calls } = setup();
  const declined = await device();
  const left = await device();
  const first = pairings.pair({ code: "123456", label: "Stranger", publicKey: declined.spki, how: "code", via: "relay", keyProof: true });
  const second = pairings.pair({ code: "123456", label: "Phone", publicKey: left.spki, how: "code", via: "relay", keyProof: true });
  if (!("challenge" in first) || !("challenge" in second)) throw new Error("no challenge");
  const one = await pairings.prove(first.session, await signPairProof(SERVER, first.challenge, declined.spki, declined.keys.privateKey));
  await pairings.prove(second.session, await signPairProof(SERVER, second.challenge, left.spki, left.keys.privateKey));
  if (!("pending" in one)) throw new Error("not pending");
  const decided = pairings.decision(first.session);
  pairings.decline(one.pending.id);
  expect(await bounded(decided)).toEqual({ admitted: null });
  pairings.leave(second.session);
  expect(calls.filter((call) => call.startsWith("release")).sort()).toEqual(["release use-1", "release use-2"]);
});

test("T72: an approval the admission refuses admits nobody", async () => {
  const { pairings } = setup({ admitted: false });
  const phone = await device();
  const started = pairings.pair({ code: "123456", label: "Phone", publicKey: phone.spki, how: "code", via: "relay", keyProof: true });
  if (!("challenge" in started)) throw new Error("no challenge");
  const proved = await pairings.prove(started.session, await signPairProof(SERVER, started.challenge, phone.spki, phone.keys.privateKey));
  if (!("pending" in proved)) throw new Error("not pending");
  const decided = pairings.decision(started.session);
  expect(pairings.approve(proved.pending.id, proved.pending.fingerprint, "screen")).toBeNull();
  expect(await bounded(decided)).toEqual({ admitted: null });
});

test("T72: an admission error resolves the wait without a device and releases the reservation", async () => {
  const { pairings, calls } = setup({ admitted: "throws" });
  const phone = await device();
  const started = pairings.pair({ code: "123456", label: "Phone", publicKey: phone.spki, how: "code", via: "relay", keyProof: true });
  if (!("challenge" in started)) throw new Error("Expected a challenge");
  const proved = await pairings.prove(started.session, await signPairProof(SERVER, started.challenge, phone.spki, phone.keys.privateKey));
  if (!("pending" in proved)) throw new Error("Expected a pending proof");
  const decided = pairings.decision(started.session);

  expect(pairings.approve(proved.pending.id, proved.pending.fingerprint, "screen")).toBeNull();

  expect(await bounded(decided)).toEqual({ admitted: null });
  expect(calls.filter((call) => call.startsWith("release "))).toEqual(["release use-1"]);
});

test.each(["named", "waiting"] as const)("T72/S31: another session can still be approved after a %s session leaves their shared reservation", async (stage) => {
  const { pairings } = setup({ shared: true });
  const phone = await device();
  const request = { code: "123456", label: "Phone", publicKey: phone.spki, how: "code", via: "relay", keyProof: true } as const;
  const first = pairings.pair(request);
  const second = pairings.pair(request);
  if (!("challenge" in first) || !("challenge" in second)) throw new Error("Expected two challenges");
  if (stage === "waiting") {
    const proved = await pairings.prove(first.session, await signPairProof(SERVER, first.challenge, phone.spki, phone.keys.privateKey));
    expect(proved).toHaveProperty("pending");
  }
  const proved = await pairings.prove(second.session, await signPairProof(SERVER, second.challenge, phone.spki, phone.keys.privateKey));
  if (!("pending" in proved)) throw new Error("Expected the second session to wait");
  const decision = pairings.decision(second.session);

  pairings.leave(first.session);
  pairings.approve(proved.pending.id, proved.pending.fingerprint, "screen");

  expect(await bounded(decision)).toEqual({ admitted: { id: "0123456789abcdef", label: "Phone", role: "drive" } });
});

test("S13-1: a code that runs out while the proof is checked, before its expiry timer ends it, puts nothing on the screen and gives its use back once", async () => {
  let live = true;
  const { pairings, pending, calls } = setup({ live: () => live });
  const phone = await device();
  const started = pairings.pair({ code: "123456", label: "Phone", publicKey: phone.spki, how: "code", via: "relay", keyProof: true });
  if (!("session" in started)) throw new Error("Pairing did not start");
  const signature = await signPairProof(SERVER, started.challenge, phone.spki, phone.keys.privateKey);
  const proving = pairings.prove(started.session, signature);
  live = false;
  expect(await proving).toEqual({ refuse: "auth_failed" });
  expect(pending.list()).toEqual([]);
  expect(calls.filter((call) => call.startsWith("release"))).toEqual(["release use-1"]);
});

test("S13-1: a key that stopped waiting before the screen is asked (its code ended right after the proof) puts no prompt on the screen", async () => {
  const { pairings, pending } = setup();
  const phone = await device();
  const started = pairings.pair({ code: "123456", label: "Phone", publicKey: phone.spki, how: "code", via: "relay", keyProof: true });
  if (!("session" in started)) throw new Error("Pairing did not start");
  const proved = await pairings.prove(started.session, await signPairProof(SERVER, started.challenge, phone.spki, phone.keys.privateKey));
  if (!("pending" in proved)) throw new Error("The proof was refused");
  pending.dropCode("use-1");
  const confirms = new LocalConfirms();
  askScreenForKey(confirms, pairings, proved.pending);
  expect(confirms.pending()).toEqual([]);
  expect(pairings.isWaiting(proved.pending.id)).toBe(false);
});

test("S13-1: a session that leaves while its proof is checked ends with nothing waiting", async () => {
  const { pairings, pending } = setup();
  const phone = await device();
  const started = pairings.pair({ code: "123456", label: "Phone", publicKey: phone.spki, how: "code", via: "relay", keyProof: true });
  if (!("session" in started)) throw new Error("Pairing did not start");
  const proving = pairings.prove(started.session, await signPairProof(SERVER, started.challenge, phone.spki, phone.keys.privateKey));
  pairings.leave(started.session);
  expect(await proving).toEqual({ refuse: "auth_failed" });
  expect(pending.list()).toEqual([]);
});

test("S13-1: a session that closes right as its proof is published leaves nothing waiting, and the code's five slots stay usable", async () => {
  const { pairings, pending } = setup({ shared: true });
  const phone = await device();
  const started = pairings.pair({ code: "123456", label: "Phone", publicKey: phone.spki, how: "code", via: "relay", keyProof: true });
  if (!("session" in started)) throw new Error("Pairing did not start");
  // the carrier goes in the same turn the entry is published, before prove() records its id on the session
  const stop = pending.onChange(() => { stop(); pairings.leave(started.session); });
  expect(await pairings.prove(started.session, await signPairProof(SERVER, started.challenge, phone.spki, phone.keys.privateKey))).toEqual({ refuse: "auth_failed" });
  expect(pending.list()).toEqual([]);
  for (let i = 0; i < PENDING_PER_CODE; i++) {
    const next = await device();
    expect("session" in pairings.pair({ code: "123456", label: `Phone ${i}`, publicKey: next.spki, how: "code", via: "relay", keyProof: true })).toBe(true);
  }
});
