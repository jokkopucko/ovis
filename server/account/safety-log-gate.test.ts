import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SafetyRecord } from "../../shared/account-records.ts";
import { DeviceStore, readDeviceRegistry } from "../devices.ts";
import { relayFixture } from "../relay/test-helpers.ts";
import { DEVICE_JOURNAL_FILE, pcRecordId, SAFETY_LOG_FILE, SafetyLog } from "./safety-log.ts";

const dirs: string[] = [];
const fixtures: ReturnType<typeof relayFixture>[] = [];
afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.close();
  for (const dir of dirs.splice(0)) { chmodSync(dir, 0o700); rmSync(dir, { recursive: true, force: true }); }
});

function dir(): string {
  const made = mkdtempSync(join(tmpdir(), "ovis-safety-gate-"));
  dirs.push(made);
  return made;
}
/** A folder this process cannot write to: not one as root, nor on Windows, where the mode does not hold. */
const NO_CHMOD = process.platform === "win32" || process.getuid?.() === 0;
const lock = (): SafetyRecord => ({ v: 1, id: pcRecordId(), kind: "lock", account: "acct_1", target: null, signer: "pc", signed_at: new Date().toISOString(), signature: "" });

describe("the safety log holds what it acknowledged (P24, T28, T41, S19)", () => {
  test("T28: a log missing beside the device journal S2-07 writes fails closed", () => {
    const at = dir();
    expect(DEVICE_JOURNAL_FILE).toBe("device-journal.json");
    writeFileSync(join(at, DEVICE_JOURNAL_FILE), JSON.stringify({ v: 1, next_seq: 1, entries: [], seen: {}, open: [], trimmed: 0 }), { mode: 0o600 });
    expect(SafetyLog.open(at).strict).not.toBeNull();
  });

  test("T41: what is in force is worked out at start, before any listener answers", () => {
    const at = dir();
    SafetyLog.open(at).append({ record: lock(), got: "pc" });
    const fixture = relayFixture(false, { stateDir: at, accountOpensAll: true });
    fixtures.push(fixture);
    dirs.splice(dirs.indexOf(at), 1);
    // the replay ran in createServer: the served handle holds the lock without being asked
    expect(fixture.app.context.services.safetyLog?.inForce.locked).toBe(true);
  });

  test.skipIf(NO_CHMOD)("S19: a failed append keeps the log strict until a reload finds it whole", () => {
    const at = dir();
    const log = SafetyLog.open(at);
    log.append({ record: lock(), got: "pc" });
    chmodSync(at, 0o500);
    expect(log.append({ record: lock(), got: "pc" }).outcome).toBe("refused");
    chmodSync(at, 0o700);
    // a later, unrelated append neither goes in nor clears the failure
    expect(log.append({ record: lock(), got: "pc" })).toMatchObject({ outcome: "refused", code: "log_unavailable" });
    expect(log.strict).not.toBeNull();
    expect(SafetyLog.open(at).strict).toBeNull();
  });

  test("P24: numbers account for every entry, so a history this writer could not have made fails closed", () => {
    const at = dir();
    writeFileSync(join(at, SAFETY_LOG_FILE), JSON.stringify({ v: 1, next: 2, base: [], entries: [], waiting: [] }), { mode: 0o600 });
    expect(SafetyLog.open(at).strict).not.toBeNull();
  });

  test("P24: one folder has one log handle in a process, and a second open is the same handle read again", () => {
    const at = dir();
    const a = SafetyLog.open(at);
    const first = lock();
    expect(a.append({ record: first, got: "pc" })).toEqual({ outcome: "applied", id: first.id, n: 1 });
    const b = SafetyLog.open(at);
    expect(b).toBe(a);
    const second = lock();
    expect(b.append({ record: second, got: "pc" })).toEqual({ outcome: "applied", id: second.id, n: 2 });
    expect(SafetyLog.open(at).receipt(first.id)).toEqual({ outcome: "applied", id: first.id, n: 1 });
  });

  test("T41: what is in force follows every read of the file, an acknowledged record included", () => {
    const at = dir();
    const log = SafetyLog.open(at);
    const held = lock();
    // the file is ahead of the handle (written before it read it again): the lock is there, the handle has not seen it
    writeFileSync(join(at, SAFETY_LOG_FILE), JSON.stringify({ v: 1, next: 2, base: [], waiting: [], entries: [{ n: 1, got: "pc", record: held }] }), { mode: 0o600 });
    expect(log.append({ record: held, got: "pc" })).toEqual({ outcome: "applied", id: held.id, n: 1 });
    expect(log.inForce.locked).toBe(log.state().locked);
    expect(log.inForce.locked).toBe(true);
  });

  test("T28: an open handle whose log was deleted beside the device journal goes strict and writes no fresh log", () => {
    const at = dir();
    const log = SafetyLog.open(at);
    log.append({ record: lock(), got: "pc" });
    writeFileSync(join(at, DEVICE_JOURNAL_FILE), JSON.stringify({ v: 1, next_seq: 1, entries: [], seen: {}, open: [], trimmed: 0 }), { mode: 0o600 });
    rmSync(join(at, SAFETY_LOG_FILE));
    expect(log.append({ record: lock(), got: "pc" })).toMatchObject({ outcome: "refused", code: "log_unavailable" });
    expect(log.strict).not.toBeNull();
    expect(existsSync(join(at, SAFETY_LOG_FILE))).toBe(false);
  });

  test.skipIf(process.platform === "win32")("S19: a log another account can write is no log this PC trusts", () => {
    const at = dir();
    SafetyLog.open(at).append({ record: lock(), got: "pc" });
    chmodSync(join(at, SAFETY_LOG_FILE), 0o602);
    const log = SafetyLog.open(at);
    expect(log.strict).not.toBeNull();
    // nothing it holds is taken as in force, and a strict log reads as locked
    expect(log.inForce.locked).toBe(true);
  });

  test.skipIf(NO_CHMOD)("S19: a log strict after a failed write reads as locked", () => {
    const at = dir();
    const log = SafetyLog.open(at);
    log.append({ record: lock(), got: "pc" });
    log.append({ record: { v: 1, id: pcRecordId(), kind: "unlock", account: "acct_1", target: log.entries()[0]!.record.id, signer: "pc", signed_at: new Date().toISOString(), signature: "" }, got: "pc" });
    expect(log.inForce.locked).toBe(false);
    chmodSync(at, 0o500);
    expect(log.append({ record: lock(), got: "pc" }).outcome).toBe("refused");
    chmodSync(at, 0o700);
    expect(log.inForce.locked).toBe(true);
  });

  test("S19: a strict PC that was never paired is no open LAN: its gate stays closed to strangers", () => {
    const at = dir();
    writeFileSync(join(at, SAFETY_LOG_FILE), "not json", { mode: 0o600 });
    const devices = new DeviceStore(at, null, null, { safety: SafetyLog.open(at) });
    expect(devices.list(null)).toEqual([]);
    expect(devices.gated).toBe(true);
  });

  test("S19: a machine-profile start on a strict PC still closes the gate on disk", () => {
    const at = dir();
    writeFileSync(join(at, SAFETY_LOG_FILE), "not json", { mode: 0o600 });
    const fixture = relayFixture(false, { stateDir: at, accountOpensAll: true, profile: "machine" });
    fixtures.push(fixture);
    dirs.splice(dirs.indexOf(at), 1);
    const registry = readDeviceRegistry(join(at, "devices.json"));
    expect(registry.kind === "ok" && registry.gateClosedAt !== null).toBe(true);
  });

  test("P24: one id twice among the folded lines is a damaged log", () => {
    const at = dir();
    writeFileSync(join(at, SAFETY_LOG_FILE), JSON.stringify({ v: 1, next: 3, base: [{ id: "a".repeat(32) }, { id: "a".repeat(32) }], entries: [], waiting: [] }), { mode: 0o600 });
    expect(SafetyLog.open(at).strict).not.toBeNull();
  });

  test("P24: a closed server gives its folder's log handle up", () => {
    const at = dir();
    const fixture = relayFixture(false, { stateDir: at, accountOpensAll: true });
    const served = fixture.app.context.services.safetyLog;
    fixture.close();
    dirs.splice(dirs.indexOf(at), 1);
    expect(SafetyLog.open(at)).not.toBe(served);
    rmSync(at, { recursive: true, force: true });
  });

  test("a machine profile with a broken devices.json still starts, flag on or off, for its recovery", () => {
    for (const accountOpensAll of [false, true]) {
      const at = dir();
      writeFileSync(join(at, "devices.json"), "not json", { mode: 0o600 });
      const fixture = relayFixture(false, { stateDir: at, accountOpensAll, profile: "machine" });
      fixtures.push(fixture);
      dirs.splice(dirs.indexOf(at), 1);
      expect(fixture.app.context.services.devices.error).not.toBeNull();
    }
  });

  test("S19: pairing_gate reads the safety log alone, not an old tombstone file it cannot read", () => {
    const at = dir();
    const devices = new DeviceStore(at, null, "the account tombstones could not be merged");
    expect(devices.failsClosed).toBe(false);
    const strict = dir();
    writeFileSync(join(strict, SAFETY_LOG_FILE), "not json", { mode: 0o600 });
    expect(new DeviceStore(strict, null, null, { safety: SafetyLog.open(strict) }).failsClosed).toBe(true);
  });
});

