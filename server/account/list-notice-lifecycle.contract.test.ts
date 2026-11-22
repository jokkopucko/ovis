import { afterEach, expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { accountDeviceId, newRecordId, signAccountRecord } from "../../shared/account-records.ts";
import { privateStateFs } from "../private-state.ts";
import { relayFixture } from "../relay/test-helpers.ts";
import { ACCOUNT_DEVICES_FILE } from "./account-devices.ts";
import { keyOf } from "./account-devices.test-helpers.ts";
import { DeviceJournal, JOURNAL_FILE } from "./device-journal.ts";
import { ACCOUNT, createListedPc } from "./listed-pc.test-helpers.ts";
import { applyAccountRecords } from "./records.ts";
import { SAFETY_LOG_FILE } from "./safety-log.ts";

const closes: (() => void)[] = [];
afterEach(() => { for (const close of closes.splice(0)) close(); });
const listed = () => createListedPc(close => closes.push(close));

test("G15/T57/P8: a plain decision changes neither the held row nor the safety log, and stays decided", async () => {
  const { fixture, device, service } = await listed();
  const { devices } = fixture.app.context.services;
  const [notice] = devices.openNotices();
  if (!notice || notice.row !== device.id) throw new Error("Missing listed admission");
  const state = () => [ACCOUNT_DEVICES_FILE, SAFETY_LOG_FILE].map(file => readFileSync(join(fixture.stateDir, file), "utf8"));
  const before = state();
  expect(devices.sessionRow(device.id)).toBeNull();
  devices.decideNotice(notice.id);
  expect(devices.openNotices()).toHaveLength(0);
  expect(state()).toEqual(before);
  expect(devices.sessionRow(device.id)).toBeNull();
  fixture.app.stop();
  const reopened = relayFixture(false, { stateDir: fixture.stateDir, accountOpensAll: true, accountService: { url: "https://account.test", fetch: service.fetch } });
  closes.unshift(() => reopened.app.stop());
  const services = reopened.app.context.services;
  expect(await services.accountMailbox.readSnapshot()).toMatchObject({ committed: true });
  expect(services.devices.openNotices()).toHaveLength(0);
  expect(services.devices.sessionRow(device.id)).toBeNull();
});

test("G15/T57/P8: local Revoke removes the listed row and frees its notice slot", async () => {
  const { fixture, device } = await listed();
  const { devices } = fixture.app.context.services;
  expect(devices.openNotices().map(n => n.row)).toEqual([device.id]);
  expect(devices.revoke(device.id)).toBe(true);
  expect(devices.has(device.id)).toBe(false);
  expect(devices.openNotices()).toHaveLength(0);
});

test("G15/T57/P8: a key-only local recovery marker decides just its listed admission before pruning", async () => {
  const { fixture, device, service, member } = await listed();
  const { accountMailbox, devices } = fixture.app.context.services;
  const other = keyOf("k-other");
  service.registerDevice(ACCOUNT, other, "Kept");
  expect(await accountMailbox.readSnapshot()).toMatchObject({ committed: true });
  expect(devices.openNotices().map(n => n.key)).toEqual([device.publicKey, other]);
  const [notice] = devices.openNotices();
  if (!notice) throw new Error("Missing listed admission");
  devices.noticeSeen(member.id, notice.seq);
  let atMarker: ReturnType<DeviceJournal["replay"]> | undefined;
  const off = devices.onNotice(entry => {
    if (entry.kind === "remove" && entry.how === "recover") {
      atMarker = DeviceJournal.open(fixture.stateDir).replay(member.id, n => n.id === notice.id);
    }
  });
  closes.push(off);
  devices.removeKey({ target: device.publicKey, by: "local" });
  expect(devices.isTombstoned(device.publicKey)).toBe(true);
  expect(devices.openNotices().map(n => n.key)).toEqual([other]);
  expect(atMarker?.notices).toMatchObject([{ id: notice.id, open: false }]);
});

test.each(["Revoke", "Revoke all", "lock teardown", "signed leave"] as const)(
  "S2P-10: %s persists a carried admission's close with the paired removal", async (reason) => {
    const { fixture, device, member, serverId } = await listed();
    const { devices, safetyLog } = fixture.app.context.services;
    const [notice] = devices.openNotices();
    if (!notice || !safetyLog) throw new Error("Missing listed admission or safety log");
    devices.noticeSeen(member.id, notice.seq);
    const paired = reason === "signed leave"
      ? devices.addAccountDevice({ id: device.id, key: device.publicKey, label: "Laptop", role: "drive", account: ACCOUNT, addedBy: member.id })
      : devices.pairRelayApproved("Laptop", device.publicKey, { path: "account", addedBy: member.id, id: device.id })?.device;
    expect(paired?.id).toBe(device.id);
    expect(devices.openNotices().find(entry => entry.id === notice.id)).toEqual(notice);

    let atRemoval: ReturnType<DeviceJournal["replay"]> | undefined;
    closes.push(devices.onNotice(entry => {
      if (entry.kind === "remove" && entry.row === device.id) {
        // For Revoke all the observer itself is gone, so read the acknowledged journal directly.
        atRemoval = DeviceJournal.open(fixture.stateDir).replay(member.id, n => n.id === notice.id);
      }
    }));
    if (reason === "Revoke") expect(devices.revoke(device.id)).toBe(true);
    else if (reason === "Revoke all") devices.revokeAll();
    else if (reason === "lock teardown") {
      expect(safetyLog.appendLock({ account: ACCOUNT }).outcome).toBe("applied");
      expect(devices.endUnlockedRows()).toContain(device.id);
    } else {
      const record = await signAccountRecord({ v: 1, kind: "remove", account: ACCOUNT, signer: device.publicKey,
        key: device.publicKey, id: newRecordId(), issued_at: new Date().toISOString() }, device.keys.privateKey);
      expect(await applyAccountRecords(devices, [record], serverId)).toEqual([{ id: record.id, outcome: "applied" }]);
    }
    expect(devices.has(device.id)).toBe(false);
    expect(atRemoval?.notices).toMatchObject([{ id: notice.id, open: false }]);
  },
);

test("S2P-10: a screen-confirmed promotion retires the listed admission with a replayable close", async () => {
  const { fixture, device, member } = await listed();
  const { devices } = fixture.app.context.services;
  const [notice] = devices.openNotices();
  if (!notice) throw new Error("Missing listed admission");
  devices.noticeSeen(member.id, notice.seq);
  const reserved = devices.redeemCode(devices.startPairing().code, "code", device.publicKey);
  if (!reserved.ok) throw new Error("Could not reserve the pairing code");
  const promoted = devices.admitConfirmed({ codeId: reserved.codeId, key: device.publicKey, label: "Laptop", source: "screen" });
  expect(promoted).not.toBeNull();
  expect(devices.openNotices().some(entry => entry.id === notice.id)).toBe(false);
  expect(devices.noticeReplay(member.id)?.notices.find(entry => entry.id === notice.id)).toMatchObject({ open: false });
});

test("S2P-10: Revoke all resumed on startup closes a carried admission even if no member removal was journalled", async () => {
  const { fixture, device, member, service } = await listed();
  const { devices } = fixture.app.context.services;
  const [notice] = devices.openNotices();
  if (!notice) throw new Error("Missing listed admission");
  devices.noticeSeen(member.id, notice.seq);
  expect(devices.pairRelayApproved("Laptop", device.publicKey, { path: "account", addedBy: member.id, id: device.id })?.device.id).toBe(device.id);
  const rename = privateStateFs.renameSync;
  const fault = spyOn(privateStateFs, "renameSync").mockImplementation((from, to) => {
    if (to === join(fixture.stateDir, JOURNAL_FILE)) throw new Error("interrupted journal write");
    rename(from, to);
  });
  try {
    expect(() => devices.revokeAll()).toThrow("interrupted journal write");
  } finally {
    fault.mockRestore();
    fixture.app.stop();
  }

  const restarted = relayFixture(false, { stateDir: fixture.stateDir, accountOpensAll: true, accountService: { url: "https://account.test", fetch: service.fetch } });
  closes.unshift(() => restarted.app.stop());
  expect(restarted.app.context.services.devices.has(device.id)).toBe(false);
  const disk = DeviceJournal.open(fixture.stateDir);
  expect(disk.openNotices().some(entry => entry.id === notice.id)).toBe(false);
  expect(disk.replay(member.id, entry => entry.id === notice.id).notices).toMatchObject([{ id: notice.id, open: false }]);
});

test("G15/T57/P8: a failed listed-row save leaves no open notice for the unsaved row", async () => {
  const { fixture, service, serverId } = await listed();
  const { devices, accountMailbox } = fixture.app.context.services;
  const before = devices.openNotices().map(n => n.id);
  const key = keyOf("k-unsaved");
  const id = accountDeviceId(serverId, key);
  service.registerDevice(ACCOUNT, key, "Unsaved");
  const rename = privateStateFs.renameSync;
  const fault = spyOn(privateStateFs, "renameSync").mockImplementation((from, to) => {
    if (to === join(fixture.stateDir, ACCOUNT_DEVICES_FILE) && readFileSync(from, "utf8").includes(id)) throw new Error("listed row save failed");
    rename(from, to);
  });
  try {
    await accountMailbox.readSnapshot();
    expect(accountMailbox.error).toBe("listed row save failed");
    expect(devices.has(id)).toBe(false);
    expect(devices.openNotices().map(n => n.id)).toEqual(before);
  } finally { fault.mockRestore(); }
});
