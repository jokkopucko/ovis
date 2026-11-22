import { expect, jest, test } from "bun:test";
import { bytesToHex } from "@noble/hashes/utils.js";
import { newRecordId, signSafetyRecord } from "../../shared/account-records.ts";
import { FakeAccountService } from "../../shared/account-service-fake.ts";
import { importPublicKey } from "../../shared/relay-e2ee.ts";
import { rotateRelayIdentity } from "../relay/identity.ts";
import { bounded, relayAccountFixture, relayDevice } from "../relay/test-helpers.ts";

test("T51/T60/T65: an idle bound PC applies a snapshot block at its five-minute check", async () => {
  const account = "acct_1";
  const service = new FakeAccountService();
  service.opensAll = true;
  jest.useFakeTimers();
  let close: (() => void) | undefined;
  try {
    const { fixture, member } = await relayAccountFixture("drive", account, {
      accountOpensAll: true, accountService: { url: "https://account.test", fetch: service.fetch },
    });
    close = fixture.close;
    const { devices, relay, accountMailbox, safetyLog } = fixture.app.context.services;
    rotateRelayIdentity(fixture.stateDir);
    const identity = relay.currentIdentity();
    if (identity === undefined) throw new Error("Missing relay identity");
    const headers = { authorization: `Bearer ${service.issueToken(account)}` };
    expect((await service.fetch(new Request(`https://account.test/v1/pcs/${identity.server_id}`, {
      method: "PUT", headers,
      body: JSON.stringify({ label: "PC", public_key: bytesToHex(importPublicKey(identity.public_key)), relay: "wss://relay.ovis.sh" }),
    }))).ok).toBe(true);
    const target = await relayDevice(fixture);
    const signerNo = service.registerDevice(account, member.publicKey, "Signer");
    const targetNo = service.registerDevice(account, target.publicKey, "Target");
    await accountMailbox.pull();
    const block = await signSafetyRecord({ v: 1, kind: "block", account, target: target.publicKey, target_no: targetNo,
      signer: member.publicKey, signer_no: signerNo, signed_at: new Date().toISOString(), nonce: newRecordId() }, member.keys.privateKey);
    expect((await service.fetch("https://account.test/v1/safety-records", {
      method: "POST", headers, body: JSON.stringify({ record: block }),
    })).ok).toBe(true);
    expect(service.mailbox(identity.server_id, account)).toEqual([]);
    expect(devices.has(target.id)).toBe(true);
    const removed = Promise.withResolvers<void>();
    const off = devices.onRemoved(event => { if (event.device_id === target.id) removed.resolve(); });
    const before = service.requests.length;
    try {
      jest.advanceTimersByTime(5 * 60_000);
      jest.useRealTimers();
      await bounded(removed.promise, 2_000);
      expect(service.requests.slice(before)).toContain("POST /v1/pc/snapshot");
      expect(safetyLog?.receipt(block.id)).toMatchObject({ outcome: "applied", id: block.id });
      expect(devices.has(target.id)).toBe(false);
    } finally { off(); }
  } finally {
    close?.();
    jest.useRealTimers();
  }
});
