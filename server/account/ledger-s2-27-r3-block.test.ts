import { afterEach, expect, test } from "bun:test";
import { accountDeviceId, newRecordId, signAccountRecord, signSafetyRecord } from "../../shared/account-records.ts";
import { FakeAccountService } from "../../shared/account-service-fake.ts";
import { ACCOUNT_OPENS_ALL_FEATURE, FrameType } from "../../shared/relay-mux.ts";
import { bounded, relayAccountFixture, relayConnection } from "../relay/test-helpers.ts";
import { ACCOUNT, registerSnapshotPc } from "./listed-pc.test-helpers.ts";
import { ask, phone } from "./pairing.test-helpers.ts";
import { applyAccountRecords } from "./records.ts";

const closes: (() => void)[] = [];
afterEach(() => { for (const close of closes.splice(0).reverse()) close(); });

test("T42 ledger: a member blocked between whole reads stays out after a lift until the next whole read judges it", async () => {
  const service = new FakeAccountService();
  const { fixture, member } = await relayAccountFixture("drive", ACCOUNT, {
    accountOpensAll: true, accountService: { url: "https://account.test", fetch: service.fetch },
  });
  closes.push(() => fixture.close());
  const serverId = await registerSnapshotPc(service, fixture);
  const { devices, accountMailbox, safetyLog } = fixture.app.context.services;
  await accountMailbox.pull();
  service.opensAll = true;
  expect(await accountMailbox.readSnapshot()).toMatchObject({ committed: true });
  const signerNo = service.registerDevice(ACCOUNT, member.publicKey, "Owner");
  const target = await phone();
  const newer = await phone();
  const targetNo = service.registerDevice(ACCOUNT, target.spki, "Target");
  service.registerDevice(ACCOUNT, newer.spki, "Newer member");
  // Admit remote members before their first list admission, so neither is a promoted, held list row.
  for (const device of [target, newer]) {
    const add = await signAccountRecord({ v: 1, kind: "add", account: ACCOUNT, key: device.spki,
      signer: member.publicKey, label: "Remote member", role: "drive",
      issued_at: new Date().toISOString(), id: newRecordId() }, member.keys.privateKey);
    expect(await applyAccountRecords(devices, [add], serverId)).toMatchObject([{ outcome: "applied" }]);
  }
  expect(await accountMailbox.readSnapshot()).toMatchObject({ committed: true });
  const id = accountDeviceId(serverId, newer.spki);
  const original = await relayConnection(fixture, { serverId });
  await original.auth({ id, keys: newer.keys, publicKey: newer.spki }, [ACCOUNT_OPENS_ALL_FEATURE]);
  expect((await ask(original, "/api/account/status")).status).toBe(200);
  expect(devices.catchingUp(id)).toBe(false);

  const block = await signSafetyRecord({ v: 1, kind: "block", account: ACCOUNT,
    target: target.spki, target_no: targetNo, signer: member.publicKey, signer_no: signerNo,
    signed_at: new Date().toISOString(), nonce: newRecordId() }, member.keys.privateKey);
  expect(await devices.applyBlock(block, "handed")).toMatchObject({ outcome: "applied" });
  await bounded(original.closed);
  expect(devices.sessionRow(id)).toBeNull();
  if (!safetyLog) throw new Error("Missing server safety log");
  expect(safetyLog.appendLift(block.id, { account: ACCOUNT }, { cause: "recover" })).toMatchObject({ outcome: "applied" });
  expect(devices.catchingUp(id)).toBe(true);

  // Proved sign-in may itself request a read: keep the service unavailable until the explicit next whole read.
  service.opensAll = false;
  const returning = await relayConnection(fixture, { serverId });
  let refusal: unknown;
  returning.onFrame = frame => { if (frame.type === FrameType.SESSION_ERROR) refusal = frame.payload; };
  const answer = await bounded(returning.auth({ id, keys: newer.keys, publicKey: newer.spki }, [ACCOUNT_OPENS_ALL_FEATURE])
    .then(() => "admitted", () => refusal));
  expect({ answer }).toMatchObject({ answer: { code: "held", hold: { reason: "catching_up" } } });
  expect(devices.catchingUp(id)).toBe(true);
  expect(devices.sessionRow(id)).toBeNull();
  service.opensAll = true;
  expect(await accountMailbox.readSnapshot()).toMatchObject({ committed: true });
  expect(devices.catchingUp(id)).toBe(false);
  expect(devices.sessionRow(id)).toMatchObject({ role: "drive", key: newer.spki });
});
