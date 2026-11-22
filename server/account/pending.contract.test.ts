/**
 * Devices waiting for this PC's screen (device-row-states rows S31, T71, T72), as the PC's own windows and its drive
 * devices read them: the list, and a decline that frees a slot. Approving is no route: it is a screen confirm.
 */
import { afterEach, expect, test } from "bun:test";
import { exportAccountKey } from "../../shared/account-records.ts";
import { signPairProof } from "../../shared/pair-fingerprint.ts";
import type { PendingKey } from "../../shared/machines.ts";
import { pairingPc, type Pc } from "./pairing.test-helpers.ts";
import { bindTestPc } from "../pc-add-policy.test-helpers.ts";

const pcs: Pc[] = [];
afterEach(async () => { for (const pc of pcs.splice(0)) await pc.close(); });

async function pc(accountOpensAll: boolean) {
  const made = await pairingPc({ prepare: bindTestPc, server: { accountOpensAll } });
  pcs.push(made);
  return made;
}

async function redeemed(made: Pc, code: string, label: string) {
  const pending = made.app.context.services.pendingRedemptions!;
  const keys = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]) as CryptoKeyPair;
  const spki = await exportAccountKey(keys.publicKey);
  const serverId = made.app.context.services.relay.currentIdentity()!.server_id;
  const { challenge } = pending.name(code, label, spki, "relay");
  return (await pending.prove(challenge, await signPairProof(serverId, challenge, spki, keys.privateKey)))!;
}

test("T71: the PC's window lists every device waiting for its screen, with the fingerprint to compare and the code's slots", async () => {
  const made = await pc(true);
  const first = await redeemed(made, "123456", "Phone");
  await redeemed(made, "123456", "Laptop");
  const listed = await made.local("/api/devices/pending");
  expect(listed.status).toBe(200);
  const pending = listed.body.pending as PendingKey[];
  expect(pending.map((entry) => [entry.label, entry.via, entry.slots])).toEqual([["Phone", "relay", { used: 2, of: 5 }], ["Laptop", "relay", { used: 2, of: 5 }]]);
  expect(pending[0]!.fingerprint).toBe(first.fingerprint);
  expect(pending[0]!.id).toBe(first.id);
});

test("T72: declining one frees its slot, and the others stay", async () => {
  const made = await pc(true);
  const first = await redeemed(made, "123456", "Stranger");
  await redeemed(made, "123456", "Phone");
  const declined = await made.local("/api/devices/pending/decline", { method: "POST", headers: { "x-herdr-machine": "1" }, body: { id: first.id } });
  expect(declined.status).toBe(200);
  const pending = (await made.local("/api/devices/pending")).body.pending as PendingKey[];
  expect(pending.map((entry) => [entry.label, entry.slots])).toEqual([["Phone", { used: 1, of: 5 }]]);
});

test("T72: no route approves a waiting device", async () => {
  const made = await pc(true);
  const first = await redeemed(made, "123456", "Phone");
  for (const path of ["/api/devices/pending/approve", `/api/devices/pending/${first.id}`]) {
    const tried = await made.local(path, { method: "POST", headers: { "x-herdr-machine": "1" }, body: { id: first.id, fingerprint: first.fingerprint } });
    expect(tried.status).toBeGreaterThanOrEqual(400);
  }
  expect(((await made.local("/api/devices/pending")).body.pending as PendingKey[]).map((entry) => entry.id)).toEqual([first.id]);
});

test("T71: a decline from another page is refused", async () => {
  const made = await pc(true);
  const first = await redeemed(made, "123456", "Phone");
  const tried = await made.local("/api/devices/pending/decline", { method: "POST", headers: { origin: "http://evil.example", "x-herdr-machine": "1" }, body: { id: first.id } });
  expect(tried.status).toBe(403);
});

test("T71: with the release flag off there is no pending list", async () => {
  const made = await pc(false);
  expect(made.app.context.services.pendingRedemptions).toBeUndefined();
  const tried = await made.local("/api/devices/pending");
  expect(tried.status).not.toBe(200);
  expect(tried.body.pending).toBeUndefined();
});
