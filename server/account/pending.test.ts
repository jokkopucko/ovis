/**
 * Redeemed, waiting for its key confirm (device-row-states rows S31, T71, T72): a code admits nobody by being redeemed.
 * The device names its key, then gets a fresh challenge, proves the key over it, and waits in memory until the PC's
 * screen approves that one key.
 */
import { expect, test } from "bun:test";
import { exportAccountKey } from "../../shared/account-records.ts";
import { signPairProof } from "../../shared/pair-fingerprint.ts";
import { PENDING_MS, PENDING_PER_CODE, PENDING_TOTAL, PendingLimitError, PendingRedemptions } from "./pending.ts";

const SERVER = "0123456789abcdef0123456789abcdef";

async function device() {
  const keys = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]) as CryptoKeyPair;
  return { keys, spki: await exportAccountKey(keys.publicKey) };
}

function store() {
  let now = 1_000_000;
  const dropped: { key: string; label: string; reason: string }[] = [];
  const pending = new PendingRedemptions({ serverId: SERVER, now: () => now, journalDrop: (entry) => { dropped.push(entry); } });
  return { pending, dropped, advance: (ms: number) => { now += ms; } };
}

async function proved(pending: PendingRedemptions, code: string, label = "Phone") {
  const phone = await device();
  const { challenge } = pending.name(code, label, phone.spki, "relay", undefined, { codeId: `id-${code}` });
  const entry = await pending.prove(challenge, await signPairProof(SERVER, challenge, phone.spki, phone.keys.privateKey));
  if (entry === null) throw new Error("The proof was refused");
  return { phone, entry, challenge };
}

test("T71: a redeemed code waits as a pending redemption with the fingerprint of the key it proved, and admits nobody", async () => {
  const { pending } = store();
  const { entry, phone } = await proved(pending, "code1");
  expect(entry.key).toBe(phone.spki);
  expect(entry.fingerprint).toMatch(/^[0-9A-Z]{4}-[0-9A-Z]{4}$/);
  expect(pending.list().map((open) => open.id)).toEqual([entry.id]);
  expect(pending.take(entry.id, "AAAA-BBBB")).toBeNull();
  expect(pending.take(entry.id, entry.fingerprint)?.key).toBe(phone.spki);
  expect(pending.list()).toEqual([]);
});

test("T71: one challenge answers at most one proof", async () => {
  const { pending } = store();
  const phone = await device();
  const { challenge } = pending.name("code1", "Phone", phone.spki, "relay");
  const proof = await signPairProof(SERVER, challenge, phone.spki, phone.keys.privateKey);
  expect(await pending.prove(challenge, "bad")).toBeNull();
  expect(await pending.prove(challenge, proof)).toBeNull();
});

test("T71: a key named again after its challenge was sent gets a new challenge, and the old one proves nothing", async () => {
  const { pending } = store();
  const first = await device();
  const second = await device();
  const named = pending.name("code1", "Phone", first.spki, "relay");
  const again = pending.name("code1", "Phone", second.spki, "relay", named.challenge);
  expect(again.challenge).not.toBe(named.challenge);
  expect(await pending.prove(named.challenge, await signPairProof(SERVER, named.challenge, first.spki, first.keys.privateKey))).toBeNull();
  const entry = await pending.prove(again.challenge, await signPairProof(SERVER, again.challenge, second.spki, second.keys.privateKey));
  expect(entry?.key).toBe(second.spki);
});

test("S31: a pending redemption ends after five minutes, unapproved", async () => {
  const { pending, advance } = store();
  const { entry } = await proved(pending, "code1");
  advance(PENDING_MS + 1);
  expect(pending.list()).toEqual([]);
  expect(pending.take(entry.id, entry.fingerprint)).toBeNull();
});

test("S31: at most five wait per code and eight in all", async () => {
  const { pending } = store();
  for (let index = 0; index < PENDING_PER_CODE; index++) await proved(pending, "code1");
  const phone = await device();
  expect(() => pending.name("code1", "Phone", phone.spki, "relay")).toThrow();
  for (let index = PENDING_PER_CODE; index < PENDING_TOTAL; index++) await proved(pending, `code${index}`);
  expect(() => pending.name("other", "Phone", phone.spki, "relay")).toThrow();
});

test("T71: declining one frees its slot and leaves a trace of its key and name; the others stay", async () => {
  const { pending, dropped } = store();
  const first = await proved(pending, "code1", "Stranger");
  const second = await proved(pending, "code1", "Phone");
  pending.decline(first.entry.id);
  expect(dropped).toEqual([{ key: first.phone.spki, label: "Stranger", reason: "declined" }]);
  expect(pending.list().map((open) => open.id)).toEqual([second.entry.id]);
});

test("T71: removing or blocking a key, or ending its code, drops its pending redemption", async () => {
  const { pending } = store();
  const removed = await proved(pending, "code1");
  const ended = await proved(pending, "code2");
  const kept = await proved(pending, "code3");
  pending.dropKey(removed.phone.spki, "removed");
  pending.dropCode(ended.entry.codeId!);
  expect(pending.list().map((open) => open.id)).toEqual([kept.entry.id]);
});

test("T71/S31: dropping a named key releases its code use and its challenge cannot enter the waiting list", async () => {
  const released: { codeId: string; key: string }[] = [];
  const pending = new PendingRedemptions({ serverId: SERVER, journalDrop: () => {}, release: (codeId, key) => { released.push({ codeId, key }); } });
  const phone = await device();
  const { challenge } = pending.name("code1", "Phone", phone.spki, "relay", undefined, { codeId: "use-1" });
  const proof = await signPairProof(SERVER, challenge, phone.spki, phone.keys.privateKey);

  pending.dropKey(phone.spki, "removed");

  expect(await pending.prove(challenge, proof)).toBeNull();
  expect(pending.list()).toEqual([]);
  expect(released).toEqual([{ codeId: "use-1", key: phone.spki }]);
});

test.each([
  ["its code ends (Revoke all, identity reset, expiry)", "code"],
  ["its key is removed, blocked or Revoked", "key"],
  ["its session closes (KeyProofPairings.leave)", "session"],
] as const)("S13-1: a proof in flight when %s never reaches the waiting list or the screen, and gives its use back once", async (_name, end) => {
  const released: { codeId: string; key: string }[] = [];
  const pending = new PendingRedemptions({ serverId: SERVER, journalDrop: () => {}, release: (codeId, key) => { released.push({ codeId, key }); } });
  const phone = await device();
  const codeId = "use-1";
  const { challenge } = pending.name("code1", "Phone", phone.spki, "relay", undefined, { codeId });
  const signature = await signPairProof(SERVER, challenge, phone.spki, phone.keys.privateKey);
  const screenUpdates: number[] = [];
  pending.onChange(() => { screenUpdates.push(pending.view().length); });

  // verification yields before the proof can publish an entry: the code or key ends in that same turn
  const verifying = pending.prove(challenge, signature);
  if (end === "code") pending.dropCode(codeId);
  else if (end === "key") pending.dropKey(phone.spki, "revoked");
  else pending.forget(challenge);

  const result = await verifying;
  expect({ proved: result?.label ?? null, waiting: pending.view().map((entry) => entry.label), screenUpdates, released })
    .toEqual({ proved: null, waiting: [], screenUpdates: [], released: [{ codeId, key: phone.spki }] });
});

test("T71: the PC's screen sees every redemption of a code side by side, with how each came", async () => {
  const { pending } = store();
  await proved(pending, "code1", "Phone");
  const phone = await device();
  const { challenge } = pending.name("code1", "Laptop", phone.spki, "address");
  await pending.prove(challenge, await signPairProof(SERVER, challenge, phone.spki, phone.keys.privateKey));
  expect(pending.list().map((open) => [open.code, open.label, open.via])).toEqual([["code1", "Phone", "relay"], ["code1", "Laptop", "address"]]);
});

test("T71: every change is told, as the list the PC's screen shows", async () => {
  const { pending } = store();
  const heard: number[] = [];
  pending.onChange(() => { heard.push(pending.view().length); });
  const { entry } = await proved(pending, "code1");
  pending.decline(entry.id);
  expect(heard).toEqual([1, 0]);
});

test("T71: a redemption that ends unapproved gives its code's use back, and an approved one keeps it", async () => {
  let now = 1_000_000;
  const released: string[] = [];
  const pending = new PendingRedemptions({ serverId: SERVER, now: () => now, journalDrop: () => {}, release: (codeId) => { released.push(codeId); } });
  const named = async (code: string, codeId: string) => {
    const phone = await device();
    const { challenge } = pending.name(code, "Phone", phone.spki, "relay", undefined, { codeId });
    return (await pending.prove(challenge, await signPairProof(SERVER, challenge, phone.spki, phone.keys.privateKey)))!;
  };
  const declined = await named("code1", "use-1");
  const approved = await named("code1", "use-2");
  await named("code2", "use-3");
  pending.decline(declined.id);
  pending.take(approved.id, approved.fingerprint);
  now += PENDING_MS + 1;
  pending.list();
  expect(released).toEqual(["use-1", "use-3"]);
  const phone = await device();
  pending.name("code3", "Phone", phone.spki, "relay", undefined, { codeId: "use-4" });
  now += PENDING_MS + 1;
  pending.list();
  expect(released).toEqual(["use-1", "use-3", "use-4"]);
});

test("T71: a proof being checked holds its slot, so a code's limit counts it", async () => {
  const { pending } = store();
  const phone = await device();
  const { challenge } = pending.name("code1", "Phone", phone.spki, "relay", undefined, { codeId: "use-1" });
  const proving = pending.prove(challenge, await signPairProof(SERVER, challenge, phone.spki, phone.keys.privateKey));
  for (let i = 1; i < PENDING_PER_CODE; i++) pending.name("code1", `Phone ${i}`, (await device()).spki, "relay", undefined, { codeId: `use-${i + 1}` });
  let refused = false;
  try { pending.name("code1", "One more", (await device()).spki, "relay", undefined, { codeId: "use-x" }); } catch (error) { refused = error instanceof PendingLimitError; }
  expect(refused).toBe(true);
  await proving;
});
