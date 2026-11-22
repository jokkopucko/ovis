import { afterEach, expect, spyOn, test } from "bun:test";
import { accountDeviceId } from "../../shared/account-records.ts";
import { relayFixture } from "../relay/test-helpers.ts";
import { privateStateFs } from "../private-state.ts";
import { parseAccountDevicesFile } from "../../shared/account-snapshot.ts";
import { ACCOUNT_DEVICES_FILE } from "./account-devices.ts";
import { join } from "node:path";
import { keyOf } from "./account-devices.test-helpers.ts";
import { ACCOUNT, createListedPc } from "./listed-pc.test-helpers.ts";

const closes: (() => void)[] = [];
afterEach(() => { for (const close of closes.splice(0)) close(); });

async function atCapacity() {
  // These cases cover slots and holds, not power loss. Keep real file writes, replacements
  // and restarts without hundreds of synchronous file and directory flushes per fixture.
  const flush = spyOn(privateStateFs, "fsyncSync").mockImplementation(() => {});
  closes.push(() => flush.mockRestore());
  const pc = await createListedPc(close => closes.push(close));
  const time = { now: Date.now() + 3_600_001 };
  const clock = spyOn(Date, "now").mockImplementation(() => time.now);
  closes.push(() => clock.mockRestore());
  for (let i = 0; i < 64; ++i) pc.service.registerDevice(ACCOUNT, keyOf(`k-${i}`), `Phone ${i}`);
  const { devices, accountMailbox } = pc.fixture.app.context.services;
  expect(await accountMailbox.readSnapshot()).toMatchObject({ committed: true });
  expect(devices.openNotices()).toHaveLength(64);
  expect(devices.has(accountDeviceId(pc.serverId, keyOf("k-63")))).toBe(false);
  const held = devices.openNotices().find(n => n.key === keyOf("k-0"));
  if (!held?.row) throw new Error("Expected the first phone's admission");
  return { ...pc, devices, time, row: held.row, notice: held.id };
}

test("G15/T57/P8: 64 open admissions stop the next phone; ending all 64 admits it", async () => {
  const { fixture, devices, service, serverId } = await atCapacity();
  const next = accountDeviceId(serverId, keyOf("k-63"));
  for (const notice of devices.openNotices()) {
    if (!notice.key) throw new Error("Expected a listed key");
    service.removeDevice(ACCOUNT, notice.key);
  }
  expect(await fixture.app.context.services.accountMailbox.readSnapshot()).toMatchObject({ committed: true });
  expect(devices.has(next)).toBe(true);
  expect(devices.openNotices().map(n => n.row)).toEqual([next]);
});

test("P15/T57, P17/T53, G15: at capacity the timer releases the row and an elder can still answer its notice", async () => {
  const { devices, time, row, notice, member } = await atCapacity();
  time.now += 9_999;
  expect(devices.sessionRow(row)).toBeNull();
  time.now++;
  expect(devices.sessionRow(row)).toMatchObject({ role: "drive" });
  expect(devices.openNotices()).toHaveLength(64);
  expect(devices.itsMe(member.id, notice, member.publicKey)).toBe(true);
  expect(devices.openNotices()).toHaveLength(63);
  expect(devices.openNotices().some(n => n.id === notice)).toBe(false);
});

test("P17/T53, G15: an eligible It's me settles its notice at capacity", async () => {
  const { devices, row, notice, member } = await atCapacity();
  expect(devices.itsMe(member.id, notice, member.publicKey)).toBe(true);
  expect(devices.openNotices().some(n => n.id === notice)).toBe(false);
  expect(devices.sessionRow(row)).toMatchObject({ role: "drive" });
});

test("H1/T42, G15: a fresh whole read restarts the hold at capacity", async () => {
  const { fixture, service, time, row } = await atCapacity();
  fixture.app.stop();
  time.now += 30_000;
  const reopened = relayFixture(false, { stateDir: fixture.stateDir, accountOpensAll: true, accountService: { url: "https://account.test", fetch: service.fetch } });
  closes.unshift(() => reopened.app.stop());
  const { devices, accountMailbox } = reopened.app.context.services;
  expect(devices.sessionRow(row)).toBeNull();
  expect(await accountMailbox.readSnapshot()).toMatchObject({ committed: true });
  expect(devices.openNotices()).toHaveLength(64);
  const file = parseAccountDevicesFile(await Bun.file(join(fixture.stateDir, ACCOUNT_DEVICES_FILE)).json());
  expect(file.devices.find(r => r.id === row)?.hold_until).toBe(new Date(time.now + 10_000).toISOString());
});
