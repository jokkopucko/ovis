import { afterEach, expect, spyOn, test } from "bun:test";
import { join } from "node:path";
import { newRecordId, signSafetyRecord } from "../../shared/account-records.ts";
import { parseAccountDevicesFile } from "../../shared/account-snapshot.ts";
import { channelBinding } from "../../shared/relay-e2ee.ts";
import { ACCOUNT_OPENS_ALL_FEATURE, FrameType, PAIR_INTENT_ACCOUNT, PAIR_SAS_FEATURE } from "../../shared/relay-mux.ts";
import { fromBase64Url, pairCommitment, pairDigits, randomPairNonce, toBase64Url } from "../../shared/relay-pair-sas.ts";
import { readDeviceRegistry } from "../devices.ts";
import { bounded, deferred, relayConnection, relayDevice } from "../relay/test-helpers.ts";
import { ACCOUNT_DEVICES_FILE } from "./account-devices.ts";
import { DeviceJournal } from "./device-journal.ts";
import { RemovalEvidence } from "./removal-evidence.ts";
import { ACCOUNT, createListedPc } from "./listed-pc.test-helpers.ts";
import { ask, phone } from "./pairing.test-helpers.ts";

const closes: (() => void)[] = [];
afterEach(() => { for (const close of closes.splice(0)) close(); });

test("a promoted key removed by a waiting block is not announced and cannot sign in", async () => {
  const { fixture, member, serverId, device } = await createListedPc(close => closes.push(close));
  const { devices, safetyLog } = fixture.app.context.services;
  const record = await signSafetyRecord({ v: 1, kind: "block", account: ACCOUNT, target: device.publicKey, target_no: 2,
    signer: member.publicKey, signer_no: 1, signed_at: new Date().toISOString(), nonce: newRecordId() }, member.keys.privateKey);
  expect(safetyLog?.wait({ record, got: "mailbox", signer_removed: false })).toBe(true);
  const announced: string[] = [];
  closes.push(devices.onNotice(entry => { if (entry.kind === "promote" && entry.row === device.id) announced.push(entry.id); }));
  expect(devices.pairRelayApproved("Laptop", device.publicKey, { path: "account", addedBy: member.id, id: device.id })).toBeNull();
  expect(devices.removedByAccount(device.publicKey)).toBe(true);
  expect(devices.has(device.id)).toBe(false);
  const link = await relayConnection(fixture, { serverId });
  expect(await bounded(Promise.race([link.auth(device, [ACCOUNT_OPENS_ALL_FEATURE]), link.serverError]))).toBe("auth_failed");
  expect(announced).toEqual([]);
});

test("promotion origin and member creation follow a local Revoke at the same wall time", async () => {
  const { fixture, member, device } = await createListedPc(close => closes.push(close));
  const { devices } = fixture.app.context.services;
  const clock = spyOn(Date, "now").mockReturnValue(Date.now());
  closes.push(() => clock.mockRestore());
  const other = await relayDevice(fixture);
  expect(devices.revoke(other.id)).toBe(true);
  const [revoke] = RemovalEvidence.open(fixture.stateDir, null).standingRevokes(other.publicKey);
  if (!revoke) throw new Error("Missing durable Revoke");
  expect(devices.pairRelayApproved("Laptop", device.publicKey, { path: "account", addedBy: member.id, id: device.id })?.device.id).toBe(device.id);
  const registry = readDeviceRegistry(join(fixture.stateDir, "devices.json"));
  const promoted = registry.kind === "ok" && registry.devices.find(row => row.id === device.id);
  if (!promoted || !promoted.origin) throw new Error("Missing promoted member");
  expect(Date.parse(promoted.origin.at)).toBeGreaterThan(Date.parse(revoke.at));
  expect(promoted.created_at).toBe(promoted.origin.at);
});

async function approveListed(memberAgeMs: number, elapsed = 4_000) {
  const { fixture, member, serverId, service } = await createListedPc(close => closes.push(close));
  const { relay, devices, accountMailbox } = fixture.app.context.services;
  const time = { now: Date.now() + memberAgeMs };
  const clock = spyOn(Date, "now").mockImplementation(() => time.now);
  closes.push(() => clock.mockRestore());
  const { spki: key } = await phone();
  service.registerDevice(ACCOUNT, key, "Tablet");
  expect(await accountMailbox.readSnapshot()).toMatchObject({ committed: true });
  const notice = devices.openNotices().find(n => n.key === key);
  if (!notice?.row) throw new Error("Expected a listed tablet");
  const id = notice.row;
  time.now += elapsed;
  if (elapsed === 10_000) expect(devices.sessionRow(id)).toMatchObject({ role: "drive" });

  const approver = await relayConnection(fixture, { serverId });
  await approver.auth(member);
  relay.approvals.openWindow();
  const tablet = await relayConnection(fixture, { serverId });
  await tablet.hello([PAIR_SAS_FEATURE, PAIR_INTENT_ACCOUNT]);
  const binding = channelBinding(tablet.channel);
  if (!binding) throw new Error("Missing SAS binding");
  const nonce = randomPairNonce();
  const challenge = deferred<string>();
  const outcome = deferred<number>();
  tablet.onFrame = frame => {
    if (frame.type === FrameType.PAIR_CHALLENGE) challenge.resolve(frame.payload.nonce);
    if (frame.type === FrameType.AUTH_OK || frame.type === FrameType.SESSION_ERROR) outcome.resolve(frame.type);
  };
  tablet.mux.sendSession({ type: FrameType.PAIR_REQUEST, flags: 0, stream_id: 0, payload: { label: "Tablet", public_key: key, commitment: toBase64Url(pairCommitment(binding, key, nonce)) } });
  const digits = pairDigits(binding, key, nonce, fromBase64Url(await bounded(challenge.promise)));
  const request = deferred<string>();
  const unsubscribe = relay.approvals.subscribeRemote(list => {
    const prompt = list.find(p => p.key === key);
    if (prompt) request.resolve(prompt.id);
  });
  tablet.mux.sendSession({ type: FrameType.PAIR_REVEAL, flags: 0, stream_id: 0, payload: { nonce: toBase64Url(nonce) } });
  const requestId = await bounded(request.promise).finally(unsubscribe);
  expect((await ask(approver, "/api/relay/pairing", { method: "POST", body: { id: requestId, decision: "approve", digits } })).status).toBe(200);
  tablet.mux.sendSession({ type: FrameType.PAIR_CONFIRM, flags: 0, stream_id: 0, payload: { confirmed: true } });
  const frame = await bounded(outcome.promise);

  const registry = readDeviceRegistry(join(fixture.stateDir, "devices.json"));
  if (registry.kind !== "ok") throw new Error("Unreadable device registry");
  const promoted = registry.devices.filter(d => d.relay_public_key === key);
  expect(promoted).toMatchObject([{ id, added_by: member.id, member_approved_in: ACCOUNT, origin: { from: "remote", how: "promoted", by: member.publicKey } }]);
  const list = parseAccountDevicesFile(await Bun.file(join(fixture.stateDir, ACCOUNT_DEVICES_FILE)).json());
  expect(list.devices.filter(r => r.key === key)).toEqual([]);
  expect(DeviceJournal.open(fixture.stateDir).entries().at(-1)).toMatchObject({ kind: "promote", row: id, by: member.publicKey });
  return { devices, time, member, id, frame, held: promoted[0]?.held, notice: notice.id };
}

test("H1/T38: a recent member's digits promote the row with the original hold", async () => {
  const { devices, time, id, frame, held, notice } = await approveListed(0);
  expect(frame).toBe(FrameType.SESSION_ERROR);
  expect(held).toBe(notice);
  time.now += 5_999;
  expect(devices.sessionRow(id)).toBeNull();
  time.now++;
  expect(devices.sessionRow(id)).toMatchObject({ role: "drive" });
});

test.each([
  { case: "recent approval after timer release", age: 0, elapsed: 10_000 },
  { case: "established approval during the hold", age: 3_600_001, elapsed: 4_000 },
])("P15/T57, H1/T38: $case promotes without answering the notice", async ({ age, elapsed }) => {
  const { devices, time, member, id, frame, held, notice } = await approveListed(age, elapsed);
  expect(frame).toBe(FrameType.AUTH_OK);
  expect(held).toBeUndefined();
  expect(devices.sessionRow(id)).toMatchObject({ role: "drive" });
  expect(devices.openNotices().some(n => n.id === notice)).toBe(true);
  time.now += 3_600_001;
  expect(devices.itsMe(member.id, notice, member.publicKey)).toBe(true);
  expect(devices.openNotices().some(n => n.id === notice)).toBe(false);
});
