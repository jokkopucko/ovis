import { afterEach, expect, test } from "bun:test";
import { accountDeviceId, newRecordId, signSafetyRecord } from "../../shared/account-records.ts";
import { ACCOUNT_OPENS_ALL_FEATURE } from "../../shared/relay-mux.ts";
import { bounded, relayConnection } from "../relay/test-helpers.ts";
import { DeviceJournal } from "./device-journal.ts";
import { ACCOUNT, createListedPc } from "./listed-pc.test-helpers.ts";
import { phone } from "./pairing.test-helpers.ts";

const closes: (() => void)[] = [];
afterEach(() => { for (const close of closes.splice(0)) close(); });
const listedPc = () => createListedPc(close => closes.push(close));
type Pc = Awaited<ReturnType<typeof listedPc>>;

function block(member: Pc["member"], target: string) {
  return signSafetyRecord({ v: 1, kind: "block", account: ACCOUNT, target, signer: member.publicKey,
    target_no: 2, signer_no: 1, signed_at: new Date().toISOString(), nonce: newRecordId() }, member.keys.privateKey);
}

async function expectBlocked(pc: Pc, device: Pc["device"]) {
  const { devices } = pc.fixture.app.context.services;
  // A join hold also refuses sign-in. The block must have left its marker and removed the row.
  expect(devices.removedByAccount(device.publicKey)).toBe(true);
  expect(devices.has(device.id)).toBe(false);
  const link = await relayConnection(pc.fixture, { serverId: pc.serverId });
  const reply = Promise.race([link.serverError, link.auth(device, [ACCOUNT_OPENS_ALL_FEATURE])]);
  expect(await bounded(reply)).toBe("auth_failed");
}

test("P19/T51: a waiting block applies when a whole read lists its key; the key is refused", async () => {
  const pc = await listedPc();
  const { devices, safetyLog, accountMailbox } = pc.fixture.app.context.services;
  const { keys, spki } = await phone();
  const record = await block(pc.member, spki);
  expect(await devices.applyBlock(record, "mailbox")).toMatchObject({ outcome: "refused", reason: "unknown_target" });
  expect(safetyLog?.waitingBlocks().map(entry => entry.record.id)).toEqual([record.id]);
  const slots = devices.openNotices().map(entry => entry.id);

  pc.service.registerDevice(ACCOUNT, spki, "Phone");
  expect(await accountMailbox.readSnapshot()).toMatchObject({ committed: true });
  await expectBlocked(pc, { keys, publicKey: spki, id: accountDeviceId(pc.serverId, spki) });
  expect(safetyLog?.waitingBlocks()).toHaveLength(0);
  const journal = DeviceJournal.open(pc.fixture.stateDir);
  expect(journal.entries().filter(entry => entry.key === spki && (entry.kind === "admit" || entry.kind === "drop"))
    .map(entry => [entry.kind, entry.how])).toEqual([["admit", "list"], ["drop", "block"]]);
  expect(journal.openNotices().map(entry => entry.id)).toEqual(slots);
  expect(journal.openNotices().some(entry => entry.key === spki)).toBe(false);
});

test("P19/T51: a block for a listed key's account arriving after the listing applies on arrival; the key is refused", async () => {
  const pc = await listedPc();
  const { devices } = pc.fixture.app.context.services;
  expect(devices.has(pc.device.id)).toBe(true);
  const record = await block(pc.member, pc.device.publicKey);
  expect(await devices.applyBlock(record, "mailbox")).toMatchObject({ outcome: "applied", id: record.id });
  await expectBlocked(pc, pc.device);
});
