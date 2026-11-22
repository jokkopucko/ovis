import { afterEach, expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DeviceStore } from "../devices.ts";
import { bounded, relayConnection, relayDevice, relayFixture } from "../relay/test-helpers.ts";
import { ACCOUNT, createListedPc } from "./listed-pc.test-helpers.ts";
import { linkRecord, phone, sendLink } from "./pairing.test-helpers.ts";
import { JOIN_HOLD_MS } from "./join-hold.ts";

const closes: (() => void)[] = [];
afterEach(() => { for (const close of closes.splice(0)) close(); });

test("T38: a signed member link transfers an already-live listing to its existing member row", async () => {
  const { fixture, device, member } = await createListedPc(close => closes.push(close));
  const { accountRows, devices } = fixture.app.context.services;
  const clock = spyOn(Date, "now").mockReturnValue(Date.now() + JOIN_HOLD_MS);
  try {
    expect(accountRows?.access(device.id)).toEqual({ ok: true });
    const link = await relayConnection(fixture);
    await link.auth(member);
    const signed = await linkRecord(member.id, ACCOUNT, { spki: member.publicKey, keys: member.keys }, { spki: device.publicKey, keys: device.keys });
    expect((await sendLink(link, signed)).status).toBe(200);
    expect(accountRows?.row(device.id)).toBeNull();
    expect(devices.list(null, true).filter(row => row.account_key === device.publicKey).map(row => row.id)).toEqual([member.id]);
  } finally { clock.mockRestore(); }
});

test.each([false, true])("S25/P17/T38: a member link retires the listing; established approver = %s", async established => {
  const { fixture, service } = await createListedPc(close => closes.push(close));
  const { devices, accountRows, accountMailbox } = fixture.app.context.services;
  const member = await relayDevice(fixture);
  devices.linkAccountKey(member.id, member.publicKey, member.publicKey, ACCOUNT);
  const clock = spyOn(Date, "now").mockReturnValue(Date.now() + (established ? 3_600_001 : 1));
  try {
    const { spki } = await phone();
    service.registerDevice(ACCOUNT, spki, "Tablet");
    expect(await accountMailbox.readSnapshot()).toMatchObject({ committed: true });
    const [listed] = accountRows?.rowsByKey(spki) ?? [];
    if (!listed || listed.state !== "hold") throw new Error("Expected a held listing");
    expect(devices.linkAccountKey(member.id, member.publicKey, spki, ACCOUNT)?.id).toBe(member.id);
    expect(accountRows?.rowsByKey(spki)).toEqual([]);
    expect(devices.sessionRow(member.id)).toEqual(established ? { role: "drive", key: spki, provisional: false } : null);
    if (!established && listed.hold_until !== null) {
      clock.mockReturnValue(Date.parse(listed.hold_until));
      expect(devices.sessionRow(member.id)?.key).toBe(spki);
    }
  } finally { clock.mockRestore(); }
});

async function recentlyPromoted() {
  const { fixture, service, member: elder } = await createListedPc(close => closes.push(close));
  const time = { now: Date.now() + 3_600_001 };
  const clock = spyOn(Date, "now").mockImplementation(() => time.now);
  closes.push(() => clock.mockRestore());
  const { devices, accountMailbox } = fixture.app.context.services;
  const recent = await relayDevice(fixture);
  devices.linkAccountKey(recent.id, recent.publicKey, recent.publicKey, ACCOUNT);
  const { spki: key } = await phone();
  service.registerDevice(ACCOUNT, key, "Tablet");
  expect(await accountMailbox.readSnapshot()).toMatchObject({ committed: true });
  const notice = devices.openNotices().find(n => n.key === key);
  if (!notice?.row) throw new Error("Expected the tablet admission");
  const id = notice.row;
  const approve = (addedBy: string) => devices.pairRelayApproved("Tablet", key, { path: "account", addedBy, id });
  expect(approve(recent.id)?.device.id).toBe(id);
  expect(devices.sessionRow(id)).toBeNull();
  time.now++;
  return { fixture, devices, elder, approve, id, key, notice: notice.id };
}

test("flag off: a colliding member approval refuses without reading carried notices", async () => {
  const { fixture, elder, id, key } = await recentlyPromoted();
  fixture.app.stop();
  const devices = new DeviceStore(fixture.stateDir);
  const notices = spyOn(devices, "openNotices");
  try {
    expect(devices.pairRelayApproved("Tablet", key, { path: "account", addedBy: elder.id, id })).toBeNull();
    expect(notices).not.toHaveBeenCalled();
    expect(devices.sessionRow(id)).toBeNull();
  } finally { notices.mockRestore(); }
});

test("flag off: a held member survives rollback listed but cannot sign in or sign records", async () => {
  const { fixture, service } = await createListedPc(close => closes.push(close));
  const { devices, accountMailbox } = fixture.app.context.services;
  const member = await relayDevice(fixture);
  devices.linkAccountKey(member.id, member.publicKey, member.publicKey, ACCOUNT);
  const target = await phone();
  service.registerDevice(ACCOUNT, target.spki, "Tablet");
  expect(await accountMailbox.readSnapshot()).toMatchObject({ committed: true });
  expect(devices.linkAccountKey(member.id, member.publicKey, target.spki, ACCOUNT)?.id).toBe(member.id);
  expect(devices.sessionRow(member.id)).toBeNull();
  fixture.app.stop();

  const path = join(fixture.stateDir, "devices.json");
  const before = readFileSync(path);
  const off = relayFixture(false, { stateDir: fixture.stateDir, accountOpensAll: false, accountService: { url: "https://account.test", fetch: service.fetch } });
  closes.unshift(() => off.close());
  const legacy = off.app.context.services.devices;
  const link = await relayConnection(off);
  await expect(link.auth({ id: member.id, keys: target.keys, publicKey: target.spki })).rejects.toThrow();
  expect(await bounded(link.serverError)).toBe("auth_failed");
  expect(legacy.list(null).some(row => row.id === member.id)).toBe(true);
  expect(legacy.sessionRow(member.id)).toBeNull();
  expect(legacy.accountSigner(target.spki, ACCOUNT, true)).toBeNull();
  expect(readFileSync(path)).toEqual(before);
  expect(legacy.revokeAll()).toContain(member.id);
});

test("H1/T38: an established member's later digits release the same carried hold", async () => {
  const { devices, elder, approve, id, key, notice } = await recentlyPromoted();
  expect(approve(elder.id)?.device.id).toBe(id);
  expect(devices.sessionRow(id)).toMatchObject({ role: "drive", key });
  expect(devices.openNotices().some(n => n.id === notice)).toBe(true);
});

test("T38/P22: confirming the promoted key on the PC screen releases its hold", async () => {
  const { devices, id, key } = await recentlyPromoted();
  const reservation = devices.redeemCode(devices.startPairing().code, "code", key);
  if (!reservation.ok) throw new Error(`Code reservation failed: ${reservation.reason}`);
  expect(devices.admitConfirmed({ codeId: reservation.codeId, key, label: "Tablet", source: "screen" })?.id).toBe(id);
  expect(devices.originOf(id)?.from).toBe("pc");
  expect(devices.sessionRow(id)).toMatchObject({ role: "drive", key });
});
