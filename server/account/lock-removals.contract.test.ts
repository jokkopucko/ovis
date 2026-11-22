/**
 * An unlock waits for its lock's removals (device-row-states rows T46, T47; S2-18 gate round 2, B2): a lock written
 * before a stop that came before its removals ends those rows at the next open; when that open cannot write, the
 * rows stay out for the run and no unlock is taken until a start can write them.
 */
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { relayConnection, relayDevice, relayFixture } from "../relay/test-helpers.ts";
import { SafetyLog } from "./safety-log.ts";

const ACCOUNT = "acct_1";
const dirs: string[] = [];
const fixtures: ReturnType<typeof relayFixture>[] = [];
afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.app.stop();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const folder = () => { const dir = mkdtempSync(join(tmpdir(), "ovis-lock-removals-")); dirs.push(dir); return dir; };
const start = (dir: string, sibling?: string) => {
  bindTestPc(dir);
  const made = relayFixture(false, { stateDir: dir, accountOpensAll: true, ...(sibling ? { siblingStateDir: sibling } : {}) });
  fixtures.push(made);
  return made;
};
const askUnlock = (made: ReturnType<typeof relayFixture>, lock: string) => fetch(`http://127.0.0.1:${made.app.port}/api/account/unlock`, {
  method: "POST", headers: { origin: `http://127.0.0.1:${made.app.port}`, "x-herdr-machine": "1", "content-type": "application/json" }, body: JSON.stringify({ lock }),
});

test("T46/T47: a blocked start refuses the unlock; a start that can write ends the rows, and only then is the unlock taken, and the old row stays out", async () => {
  const dir = folder();
  const first = start(dir);
  const device = await relayDevice(first);
  first.app.stop();
  // the stop: the lock is on disk, its removals are not
  const lock = SafetyLog.open(dir).appendLock({ account: ACCOUNT });
  const sibling = folder();
  writeFileSync(join(sibling, "devices.json"), "not json", { mode: 0o600 });
  const blocked = start(dir, sibling);
  expect(blocked.app.context.services.devices.pendingLockRemovals()).toEqual([device.id]);
  const refused = await askUnlock(blocked, lock.id);
  expect([refused.status, ((await refused.json()) as { error: { code: string } }).error.code]).toEqual([409, "lock_removals_pending"]);
  expect(blocked.app.context.services.localConfirms!.pending()).toEqual([]);
  blocked.app.stop();
  rmSync(join(sibling, "devices.json"));
  const repaired = start(dir, sibling);
  expect(repaired.app.context.services.devices.pendingLockRemovals()).toEqual([]);
  expect(repaired.app.context.services.devices.has(device.id)).toBe(false);
  expect((await askUnlock(repaired, lock.id)).status).toBe(202);
  expect(repaired.app.context.services.safetyLog!.appendUnlock(lock.id, { account: ACCOUNT }).outcome).toBe("applied");
  const link = await relayConnection(repaired);
  expect(await link.auth(device).then(() => "in", () => "refused")).toBe("refused");
});

test("S19/T41: on a PC whose only damage is an unreadable device journal, a loopback window gets 403 strict and the lock says strict", async () => {
  const dir = folder();
  const first = start(dir);
  await relayDevice(first);
  first.app.stop();
  writeFileSync(join(dir, "device-journal.json"), "not json", { mode: 0o600 });
  const made = start(dir);
  expect(made.app.context.services.safetyLog!.strict).toBeNull();
  const base = `http://127.0.0.1:${made.app.port}`;
  const tried = await fetch(`${base}/api/devices`);
  expect([tried.status, ((await tried.json()) as { error?: { code?: string } }).error?.code]).toEqual([403, "strict"]);
  expect(((await (await fetch(`${base}/api/account/lock`)).json()) as { strict: boolean }).strict).toBe(true);
});
import { bindTestPc } from "../pc-add-policy.test-helpers.ts";
