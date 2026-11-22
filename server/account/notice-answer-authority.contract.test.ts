import { afterEach, expect, spyOn, test } from "bun:test";
import { accountDeviceId, newRecordId, signSafetyRecord } from "../../shared/account-records.ts";
import { ACCOUNT_OPENS_ALL_FEATURE } from "../../shared/relay-mux.ts";
import * as herdr from "../herdr/client.ts";
import { relayConnection, relayDevice } from "../relay/test-helpers.ts";
import { DeviceJournal } from "./device-journal.ts";
import { JOIN_HOLD_MS } from "./join-hold.ts";
import { ACCOUNT, createListedPc } from "./listed-pc.test-helpers.ts";
import { phone } from "./pairing.test-helpers.ts";

const closes: (() => void)[] = [];
afterEach(() => { for (const close of closes.splice(0)) close(); });

test.each(["listed", "transferred"] as const)("S2P-10: Not me on a %s admission replays its close to an offline observer", async (kind) => {
  const { fixture, member, serverId, service } = await createListedPc(close => closes.push(close));
  const { devices, core, accountMailbox } = fixture.app.context.services;
  const observer = await relayDevice(fixture);
  const target = await phone();
  const targetId = accountDeviceId(serverId, target.spki);
  service.registerDevice(ACCOUNT, target.spki, "New phone");
  expect(await accountMailbox.readSnapshot()).toMatchObject({ committed: true });
  const notice = devices.openNotices().find(entry => entry.row === targetId);
  if (!notice) throw new Error("Missing target admission");
  const connect = (device: typeof member) => relayConnection(fixture, { serverId, websocket: core.socketHandlers })
    .then(async link => { await link.auth(device, [ACCOUNT_OPENS_ALL_FEATURE]); return link; });
  const before = await connect(observer);
  const observing = before.openSocket();
  await observing.opened;
  const initial = await observing.until(message => message.type === "device-notice-replay");
  if (initial.type !== "device-notice-replay") throw new Error("Missing observer replay");
  expect(initial.replay.notices.find(entry => entry.id === notice.id)).toMatchObject({ open: true });
  observing.send({ type: "notice-seen", seq: notice.seq });
  observing.send({ type: "ping", id: 10 });
  await observing.until(message => message.type === "pong" && message.id === 10);
  before.stop();
  await before.closed;

  if (kind === "transferred") {
    expect(devices.pairRelayApproved("New phone", target.spki, { path: "account", addedBy: member.id, id: targetId })?.device.id).toBe(targetId);
    expect(devices.openNotices().find(entry => entry.id === notice.id)).toEqual(notice);
  }
  let atRemoval: ReturnType<DeviceJournal["replay"]> | undefined;
  const off = devices.onNotice(entry => {
    if (entry.row === targetId && (entry.kind === "remove" || entry.kind === "drop")) {
      atRemoval = DeviceJournal.open(fixture.stateDir).replay(observer.id, n => n.id === notice.id);
    }
  });
  closes.push(off);
  const block = await signSafetyRecord({ v: 1, kind: "block", account: ACCOUNT, target: target.spki,
    target_no: 3, signer: member.publicKey, signer_no: 1, signed_at: new Date().toISOString(), nonce: newRecordId() }, member.keys.privateKey);
  const answering = (await connect(member)).openSocket();
  await answering.opened;
  answering.send({ type: "notice-answer", answer: "not_me", id: notice.id, blocks: [block] });
  expect(await answering.until(message => message.type === "notice-answer-result")).toMatchObject({ receipts: [{ outcome: "applied", id: block.id }] });
  expect(devices.has(targetId)).toBe(false);
  expect(devices.openNotices().some(entry => entry.id === notice.id)).toBe(false);

  const reconnected = (await connect(observer)).openSocket();
  await reconnected.opened;
  const replay = await reconnected.until(message => message.type === "device-notice-replay");
  if (replay.type !== "device-notice-replay") throw new Error("Missing reconnect replay");
  expect(replay.replay.cut).toBe(0);
  expect(replay.replay.notices.filter(entry => entry.id === notice.id)).toMatchObject([{ id: notice.id, kind: "admit", open: false }]);
  expect(atRemoval?.notices).toMatchObject([{ id: notice.id, kind: "admit", open: false }]);
});

test("a same-account watch member cannot block a listed device or decide its notice", async () => {
  const { fixture, device, member, serverId } = await createListedPc(close => closes.push(close));
  const { devices, core, safetyLog } = fixture.app.context.services;
  const notice = devices.openNotices().find(entry => entry.row === device.id);
  if (!notice || !safetyLog) throw new Error("Missing listed admission or safety log");
  devices.update(member.id, { role: "watch" });
  expect(devices.list(null, true).find(row => row.id === member.id)).toMatchObject({ role: "watch", account: ACCOUNT });
  const before = safetyLog.entries().map(entry => entry.record.id);
  const block = await signSafetyRecord({ v: 1, kind: "block", account: ACCOUNT, target: device.publicKey, target_no: 2,
    signer: member.publicKey, signer_no: 1, signed_at: new Date().toISOString(), nonce: newRecordId() }, member.keys.privateKey);
  const link = await relayConnection(fixture, { serverId, websocket: core.socketHandlers });
  await link.auth(member, [ACCOUNT_OPENS_ALL_FEATURE]);
  const socket = link.openSocket();
  await socket.opened;
  socket.send({ type: "notice-answer", answer: "not_me", id: notice.id, blocks: [block] });
  await socket.until(message => message.type === "notice-answer-result" && message.id === notice.id);
  expect(devices.openNotices().map(entry => entry.id)).toContain(notice.id);
  expect(safetyLog.entries().map(entry => entry.record.id)).toEqual(before);
});

test.each([
  ["admitted device", true], ["different account", true], ["other same-account row", false], ["other block target", true],
  ["stored receipt", true],
] as const)("G15/T57/P8: Not me from %s leaves open = %s", async (actor, staysOpen) => {
  const { fixture, device, member, serverId } = await createListedPc(close => closes.push(close));
  const { devices, core } = fixture.app.context.services;
  const notice = devices.openNotices().find(n => n.row === device.id);
  if (!notice) throw new Error("Missing admission");
  // This layer's socket accepts members. Transfer the admission, including its pending hold,
  // to the same ID/key before opening its own socket.
  if (actor === "admitted device") {
    expect(devices.pairRelayApproved("Laptop", device.publicKey, { path: "account", addedBy: member.id, id: device.id })?.device.id).toBe(device.id);
    expect(devices.openNotices().some(n => n.id === notice.id)).toBe(true);
  }
  const clock = spyOn(Date, "now").mockReturnValue(Date.now() + JOIN_HOLD_MS + 1);
  const snapshot = spyOn(herdr, "sessionSnapshot").mockResolvedValue({
    panes: [], agents: [], workspaces: [], tabs: [], layouts: [], version: "fixture", protocol: 22,
  });
  // Isolate the caller gate from signature verification and the independent removal caused by a real block.
  const block = spyOn(devices, "applyBlock").mockImplementation(async (_record, _got, onRaise) => {
    if (actor !== "stored receipt") onRaise?.();
    return { outcome: "applied", id: "fixture", n: 1 };
  });
  try {
    let caller = actor === "admitted device" ? device : member;
    if (actor === "different account") {
      const foreign = await phone();
      const row = devices.addAccountDevice({ id: "bbbbbbbbbbbbbbbb", key: foreign.spki, label: "Other", role: "drive", account: "acct_other", addedBy: member.id });
      caller = { id: row.id, keys: foreign.keys, publicKey: foreign.spki };
    }
    const link = await relayConnection(fixture, { serverId, websocket: core.socketHandlers });
    await link.auth(caller, [ACCOUNT_OPENS_ALL_FEATURE]);
    const socket = link.openSocket();
    await socket.opened;
    socket.send({ type: "notice-answer", answer: "not_me", id: notice.id, blocks: [{
      v: 1, kind: "block", id: "fixture", account: "acct_1", signer: caller.publicKey,
      target: actor === "other block target" ? "unrelated-fixture-key" : device.publicKey,
      target_no: 2, signer_no: 1, signed_at: new Date().toISOString(), nonce: "fixture", signature: "",
    }] });
    await socket.until(message => message.type === "notice-answer-result");
    expect(devices.openNotices().some(n => n.id === notice.id)).toBe(staysOpen);
  } finally { block.mockRestore(); snapshot.mockRestore(); clock.mockRestore(); }
});
