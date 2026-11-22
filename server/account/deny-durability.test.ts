import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exportAccountKey } from "../../shared/account-records.ts";
import { DeviceStore, readDeviceRegistry } from "../devices.ts";
import { privateStateFs } from "../private-state.ts";
import { REMOVAL_FILE } from "./removal-evidence.ts";
import { PcAccountState } from "./pc-binding.ts";
import { RemovalEvidence } from "./removal-evidence.ts";
import { SafetyLog } from "./safety-log.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) { chmodSync(dir, 0o700); rmSync(dir, { recursive: true, force: true }); }
});

function dir(): string {
  const made = mkdtempSync(join(tmpdir(), "ovis-deny-"));
  dirs.push(made);
  return made;
}
function store(at: string): DeviceStore {
  const log = SafetyLog.open(at);
  return new DeviceStore(at, null, null, { safety: log, pc: PcAccountState.open(at), removals: RemovalEvidence.open(at, log) });
}
async function key(): Promise<string> {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  return exportAccountKey(pair.publicKey);
}

describe("a deny holds for every row and every live session (P8, S19)", () => {
  test("P8: a cookie row whose Revoke cannot be written is never acknowledged, and the PC fails closed meanwhile", () => {
    const at = dir();
    const devices = store(at);
    const cookie = devices.pair(devices.startPairing().code, "Laptop", "drive")!;
    devices.match(cookie.token);
    let closed = false;
    devices.onRevoke(cookie.device.id, () => { closed = true; });
    // the registry is its only deny: when it cannot be written the Revoke throws, its sessions end anyway, and
    // nothing but this PC gets in until a deny is written
    chmodSync(at, 0o500);
    expect(() => devices.revoke(cookie.device.id)).toThrow();
    chmodSync(at, 0o700);
    expect(closed).toBe(true);
    expect(devices.match(cookie.token)).toBeNull();
    expect(devices.accountError).not.toBeNull();
  });

  test("S19: a session signed in before the PC failed closed opens no new stream", async () => {
    const at = dir();
    const devices = store(at);
    const row = devices.pairRelay(devices.startPairing().code, "Phone", await key())!.device.id;
    expect(devices.sessionRow(row)).not.toBeNull();
    const other = devices.pairRelay(devices.startPairing().code, "Tablet", await key())!.device.id;
    chmodSync(at, 0o500);
    expect(() => devices.revoke(other)).toThrow();
    chmodSync(at, 0o700);
    // the deny of the other row could not be written: the live session of this one is asked again and refused
    expect(devices.sessionRow(row)).toBeNull();
  });

  test("P8: an interrupted Revoke all is finished at start even when the old tombstone file cannot be read", async () => {
    const at = dir();
    const devices = store(at);
    devices.pairRelay(devices.startPairing().code, "Phone", await key());
    writeFileSync(join(at, "revoke-all.json"), JSON.stringify({ id: "a".repeat(32), by: "pc", at: new Date().toISOString() }), { mode: 0o600 });
    rmSync(join(at, "account-tombstones.json"), { force: true });
    mkdirSync(join(at, "account-tombstones.json"));
    const reopened = store(at);
    expect(reopened.list(null)).toEqual([]);
  });

  test("P8: a Revoke whose deny cannot be written changes nothing on disk, and only that key's own deny ends the closing", async () => {
    const at = dir();
    const devices = store(at);
    const [a, b] = [await key(), await key()];
    const rowA = devices.pairRelay(devices.startPairing().code, "A", a)!.device.id;
    const rowB = devices.pairRelay(devices.startPairing().code, "B", b)!.device.id;
    const rename = privateStateFs.renameSync;
    privateStateFs.renameSync = (from, to) => {
      if (to === join(at, REMOVAL_FILE)) throw new Error("simulated EIO");
      return rename(from, to);
    };
    try { expect(() => devices.revoke(rowA)).toThrow(); } finally { privateStateFs.renameSync = rename; }
    // the row stays on disk, where the failed Revoke stays visible; in this run it is out and the PC fails closed
    const registry = readDeviceRegistry(join(at, "devices.json"));
    expect(registry.kind === "ok" && registry.devices.some((d) => d.id === rowA)).toBe(true);
    expect(devices.hasKey(a)).toBe(false);
    expect(devices.failsClosed).toBe(true);
    // another key's deny landing does not end it
    devices.revoke(rowB);
    expect(devices.failsClosed).toBe(true);
    expect(devices.hasKey(a)).toBe(false);
    // that key's own deny does
    devices.revoke(rowA);
    expect(devices.failsClosed).toBe(false);
    expect(store(at).isTombstoned(a)).toBe(true);
  });

  test("P8: a Revoke all that fails after its intent is on disk fails the PC closed at once", async () => {
    const at = dir();
    const devices = store(at);
    devices.pairRelay(devices.startPairing().code, "A", await key());
    const rename = privateStateFs.renameSync;
    privateStateFs.renameSync = (from, to) => {
      if (to === join(at, "devices.json")) throw new Error("simulated EIO");
      return rename(from, to);
    };
    try { expect(() => devices.revokeAll()).toThrow(); } finally { privateStateFs.renameSync = rename; }
    expect(devices.failsClosed).toBe(true);
  });

  test("P8, S19: a cookie row whose registry write fails stays out for the run and the PC fails closed", () => {
    const at = dir();
    const devices = store(at);
    const cookie = devices.pair(devices.startPairing().code, "Laptop", "drive")!;
    devices.match(cookie.token);
    const rename = privateStateFs.renameSync;
    privateStateFs.renameSync = (from, to) => {
      if (to === join(at, "devices.json")) throw new Error("simulated EIO");
      return rename(from, to);
    };
    try { expect(() => devices.revoke(cookie.device.id)).toThrow(); } finally { privateStateFs.renameSync = rename; }
    expect(devices.match(cookie.token)).toBeNull();
    expect(devices.failsClosed).toBe(true);
  });

  test("P8, S19: an account removal retried after the folder is repaired writes its deny and ends the closing", async () => {
    const at = dir();
    const devices = store(at);
    const k = await key();
    devices.pairRelay(devices.startPairing().code, "A", k);
    const record = { id: "r".repeat(32), issuedAt: new Date().toISOString() };
    const rename = privateStateFs.renameSync;
    privateStateFs.renameSync = (from, to) => {
      if (to === join(at, REMOVAL_FILE)) throw new Error("simulated EIO");
      return rename(from, to);
    };
    try { expect(() => devices.removeAccountKey(k, "acct", record)).toThrow(); } finally { privateStateFs.renameSync = rename; }
    expect(devices.failsClosed).toBe(true);
    devices.removeAccountKey(k, "acct", record);
    expect(devices.failsClosed).toBe(false);
    expect(devices.removedByAccount(k)).toBe(true);
  });

  test("P8, T41: a Revoke all finished at start raises the generation, as the live path does", () => {
    const at = dir();
    store(at);
    const before = PcAccountState.open(at).gen();
    writeFileSync(join(at, "revoke-all.json"), JSON.stringify({ id: "a".repeat(32), by: "pc", at: new Date().toISOString() }), { mode: 0o600 });
    store(at);
    expect(PcAccountState.open(at).gen()).toBeGreaterThan(before);
  });

  test("P8: a removal is told after the registry no longer holds the row", async () => {
    const at = dir();
    const devices = store(at);
    const id = devices.pairRelay(devices.startPairing().code, "A", await key())!.device.id;
    let onDisk = null as boolean | null;
    devices.onRemoved(() => {
      const registry = readDeviceRegistry(join(at, "devices.json"));
      onDisk = registry.kind === "ok" && registry.devices.some((d) => d.id === id);
    });
    devices.revoke(id);
    expect(onDisk).toBe(false);
  });

  test("P8, S19: a cookie Revoke whose deny fails keeps that row out until its own removal lands, whatever other key is denied", async () => {
    const at = dir();
    const devices = store(at);
    const cookie = devices.pair(devices.startPairing().code, "Laptop", "drive")!;
    devices.match(cookie.token);
    const other = devices.pairRelay(devices.startPairing().code, "B", await key())!.device.id;
    const counter = join(at, "account-pc.json");
    const rename = privateStateFs.renameSync;
    privateStateFs.renameSync = (from, to) => {
      if (to === counter) throw new Error("simulated EIO");
      return rename(from, to);
    };
    try { expect(() => devices.revoke(cookie.device.id)).toThrow(); } finally { privateStateFs.renameSync = rename; }
    devices.revoke(other);
    expect(devices.failsClosed).toBe(true);
    expect(devices.match(cookie.token)).toBeNull();
  });

  test("P8: a cookie Revoke whose registry write fails is never told as removed, and after a restart the row is live", () => {
    const at = dir();
    const devices = store(at);
    const cookie = devices.pair(devices.startPairing().code, "Laptop", "drive")!;
    devices.match(cookie.token);
    const told: string[] = [];
    devices.onRemoved((event) => told.push(JSON.stringify(event)));
    const rename = privateStateFs.renameSync;
    privateStateFs.renameSync = (from, to) => {
      if (to === join(at, "devices.json")) throw new Error("simulated EIO");
      return rename(from, to);
    };
    try { expect(() => devices.revoke(cookie.device.id)).toThrow(); } finally { privateStateFs.renameSync = rename; }
    expect(told).toEqual([]);
    expect(devices.match(cookie.token)).toBeNull();
    expect(store(at).match(cookie.token)).not.toBeNull();
  });

  test("P8, T41: a Revoke recovered at start after a stop before its gen was raised raises it then", async () => {
    const at = dir();
    const devices = store(at);
    const id = devices.pairRelay(devices.startPairing().code, "A", await key())!.device.id;
    const registry = readFileSync(join(at, "devices.json"));
    const counter = readFileSync(join(at, "account-pc.json"));
    const before = PcAccountState.open(at).gen();
    devices.revoke(id);
    // the stop: the deny is on disk, the gen raise and the registry write are not
    writeFileSync(join(at, "devices.json"), registry, { mode: 0o600 });
    writeFileSync(join(at, "account-pc.json"), counter, { mode: 0o600 });
    store(at);
    expect(PcAccountState.open(at).gen()).toBeGreaterThan(before);
  });

  test("P8: a Revoke all that cannot clear the binding says so, not that rows could not be migrated", async () => {
    const at = dir();
    const devices = store(at);
    devices.pairRelay(devices.startPairing().code, "A", await key());
    const rename = privateStateFs.renameSync;
    privateStateFs.renameSync = (from, to) => {
      if (to === join(at, "devices.json")) throw new Error("simulated EIO");
      return rename(from, to);
    };
    try { expect(() => devices.revokeAll()).toThrow(); } finally { privateStateFs.renameSync = rename; }
    expect(devices.accountError ?? "").not.toContain("before the upgrade");
  });

  test("P8, T20: a Revoke all whose Revokes failed and a second Revoke all keep the first one's keys out", async () => {
    const at = dir();
    const devices = store(at);
    const a = await key();
    devices.pairRelay(devices.startPairing().code, "A", a);
    const rename = privateStateFs.renameSync;
    privateStateFs.renameSync = (from, to) => {
      if (to === join(at, REMOVAL_FILE)) throw new Error("simulated EIO");
      return rename(from, to);
    };
    try { expect(() => devices.revokeAll()).toThrow(); } finally { privateStateFs.renameSync = rename; }
    // the file names what it covers, so no later Revoke all can finish it without them
    expect(JSON.stringify(JSON.parse(readFileSync(join(at, "revoke-all.json"), "utf8")))).toContain(a);
    try { devices.revokeAll(); } catch { /* the PC is closed until a start finishes it */ }
    const reopened = store(at);
    expect(reopened.hasKey(a)).toBe(false);
    expect(reopened.isTombstoned(a)).toBe(true);
  });

  test("T3: Revoke all on a store that never closed its gate tells every gate listener", async () => {
    const at = dir();
    const devices = store(at);
    let told = false;
    devices.onGateClosed(() => { told = true; });
    devices.revokeAll();
    await Promise.resolve();
    expect(told).toBe(true);
  });

  test("P8, P12: a Revoke all that cannot clear the binding at start keeps its file, and a start after the repair clears it", async () => {
    const at = dir();
    const devices = store(at);
    const k = await key();
    const id = devices.pairRelay(devices.startPairing().code, "A", k)!.device.id;
    devices.linkAccountKey(id, k, k, "acct_1");
    expect(PcAccountState.open(at).account()).toBe("acct_1");
    const binding = readFileSync(join(at, "account-pc.json"));
    writeFileSync(join(at, "revoke-all.json"), JSON.stringify({ id: "a".repeat(32), by: "pc", at: new Date().toISOString() }), { mode: 0o600 });
    writeFileSync(join(at, "account-pc.json"), "not json", { mode: 0o600 });
    expect(store(at).failsClosed).toBe(true);
    expect(existsSync(join(at, "revoke-all.json"))).toBe(true);
    writeFileSync(join(at, "account-pc.json"), binding, { mode: 0o600 });
    store(at);
    expect(PcAccountState.open(at).account()).toBeNull();
    expect(existsSync(join(at, "revoke-all.json"))).toBe(false);
  });

  test("P8, T20: a Revoke all whose own file cannot be written keeps its rows, and the next Revoke all revokes them", async () => {
    const at = dir();
    const devices = store(at);
    const k = await key();
    devices.pairRelay(devices.startPairing().code, "A", k);
    const rename = privateStateFs.renameSync;
    privateStateFs.renameSync = (from, to) => {
      if (to === join(at, "revoke-all.json")) throw new Error("simulated EIO");
      return rename(from, to);
    };
    try { expect(() => devices.revokeAll()).toThrow(); } finally { privateStateFs.renameSync = rename; }
    expect(devices.hasKey(k)).toBe(false);
    expect(devices.failsClosed).toBe(true);
    devices.revokeAll();
    expect(devices.isTombstoned(k)).toBe(true);
    expect(devices.failsClosed).toBe(false);
    const reopened = store(at);
    expect(reopened.isTombstoned(k)).toBe(true);
    expect(reopened.hasKey(k)).toBe(false);
  });
});
