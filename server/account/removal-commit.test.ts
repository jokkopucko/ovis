import { afterEach, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newRecordId } from "../../shared/account-records.ts";
import { DeviceStore, readDeviceRegistry, type StoredDevice } from "../devices.ts";
import { ADMISSION_FILE } from "./admission-order.ts";
import { PcAccountState } from "./pc-binding.ts";
import { REMOVAL_FILE, RemovalEvidence } from "./removal-evidence.ts";
import { SafetyLog } from "./safety-log.ts";

const ACCOUNT = "acct_1";
const REVOKE_ALL_FILE = "revoke-all.json";
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function stateDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "ovis-removal-commit-"));
  dirs.push(dir);
  return dir;
}

async function key(): Promise<string> {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  return Buffer.from(await crypto.subtle.exportKey("spki", pair.publicKey)).toString("base64url");
}

function store(dir: string): DeviceStore {
  const safety = SafetyLog.open(dir);
  return new DeviceStore(dir, null, null, { safety, pc: PcAccountState.open(dir), removals: RemovalEvidence.open(dir, safety) });
}

const rows = (dir: string): StoredDevice[] => {
  const registry = readDeviceRegistry(join(dir, "devices.json"));
  if (registry.kind !== "ok") throw new Error("devices.json unreadable");
  return registry.devices;
};

function pairHere(devices: DeviceStore, publicKey: string): string {
  const paired = devices.pairRelay(devices.startPairing().code, "Phone", publicKey);
  if (!paired) throw new Error("pairing failed");
  return paired.device.id;
}

/** Makes the next write of `file` fail: nothing can be renamed over a folder. */
function breakWrites(dir: string, file: string): void {
  rmSync(join(dir, file), { force: true });
  mkdirSync(join(dir, file));
}

const closes = (devices: DeviceStore, id: string) => {
  const seen = { closed: false };
  devices.onRevoke(id, () => { seen.closed = true; });
  return seen;
};

describe("finishing a removal before reporting it (P8)", () => {
  test("T25: failed writes still close sessions, deny stale calls and never acknowledge a failed deny", async () => {
    const dir = stateDir();
    const devices = store(dir);
    const [a, b, c] = [await key(), await key(), await key()];
    const idA = pairHere(devices, a);
    const before = PcAccountState.open(dir).gen();

    // the registry write fails after the deny reached the disk: the session closes, the row is out, and it is reported
    const sessionA = closes(devices, idA);
    breakWrites(dir, "devices.json");
    expect(() => devices.revoke(idA)).toThrow();
    expect(sessionA.closed).toBe(true);
    expect(devices.sessionRow(idA)).toBeNull();
    expect(PcAccountState.open(dir).gen()).toBeGreaterThan(before);

    // the deny itself cannot be written: the session still closes, the call fails, and the PC fails closed
    const fresh = stateDir();
    const second = store(fresh);
    const idB2 = pairHere(second, b);
    const idC = pairHere(second, c);
    const sessionB = closes(second, idB2);
    breakWrites(fresh, REMOVAL_FILE);
    expect(() => second.revoke(idB2)).toThrow();
    expect(sessionB.closed).toBe(true);
    expect(second.sessionRow(idB2)).toBeNull();
    expect(second.accountError).not.toBeNull();
    // until a deny is written nothing but this PC gets in, the other rows' live sessions included (S19)
    expect(second.sessionRow(idC)).toBeNull();
    expect(second.pair(second.startPairing().code, "New", "drive")).toBeNull();
  });

  test("T20: interrupted Revoke all finishes before serving, even on an empty registry", async () => {
    const dir = stateDir();
    const devices = store(dir);
    const [a, b] = [await key(), await key()];
    const idA = pairHere(devices, a);
    devices.linkAccountKey(idA, a, a, ACCOUNT);
    pairHere(devices, b);
    // a stop right after Revoke all's first write: only its file is on disk
    writeFileSync(join(dir, REVOKE_ALL_FILE), JSON.stringify({ id: randomBytes(16).toString("hex"), by: "pc", at: new Date().toISOString() }), { mode: 0o600 });
    const reopened = store(dir);
    expect(rows(dir)).toEqual([]);
    expect(reopened.gated).toBe(true);
    expect(reopened.isTombstoned(a) && reopened.isTombstoned(b)).toBe(true);
    expect(reopened.account()).toBeNull();
    expect((JSON.parse(readFileSync(join(dir, ADMISSION_FILE), "utf8")) as { clears: { reason: string }[] }).clears.map((c) => c.reason)).toEqual(["revoke_all"]);
    expect(existsSync(join(dir, REVOKE_ALL_FILE))).toBe(false);

    // on an empty registry the same: the gate closes and the PC leaves its account
    const empty = stateDir();
    const bound = store(empty);
    const only = await key();
    const id = pairHere(bound, only);
    bound.linkAccountKey(id, only, only, ACCOUNT);
    bound.removeAccountKey(only, ACCOUNT, { id: newRecordId(), issuedAt: new Date().toISOString() });
    expect(rows(empty)).toEqual([]);
    writeFileSync(join(empty, REVOKE_ALL_FILE), JSON.stringify({ id: randomBytes(16).toString("hex"), by: "pc", at: new Date().toISOString() }), { mode: 0o600 });
    const after = store(empty);
    expect(after.gated).toBe(true);
    expect(after.account()).toBeNull();
    expect(existsSync(join(empty, REVOKE_ALL_FILE))).toBe(false);
  });

  test("T26: a durable deny wins after a stop between deny and registry write", async () => {
    const dir = stateDir();
    const devices = store(dir);
    const a = await key();
    const id = pairHere(devices, a);
    const registry = readFileSync(join(dir, "devices.json"), "utf8");
    devices.revoke(id);
    // the registry as it was before the revoke's write, the deny already on disk
    writeFileSync(join(dir, "devices.json"), registry, { mode: 0o600 });
    const reopened = store(dir);
    expect(rows(dir).some((row) => row.id === id)).toBe(false);
    expect(reopened.sessionRow(id)).toBeNull();
  });

  test("T3: Revoke all closes every cookie candidate and the LAN gate", () => {
    const dir = stateDir();
    const devices = store(dir);
    expect(devices.gated).toBe(false);
    const first = devices.pair(devices.startPairing().code, "Laptop", "drive")!;
    // the registry write of Revoke all fails: the gate is closed in memory all the same, and the candidate is gone
    breakWrites(dir, "devices.json");
    expect(() => devices.revokeAll()).toThrow();
    expect(devices.gated).toBe(true);
    expect(devices.match(first.token)).toBeNull();
    expect(existsSync(join(dir, REVOKE_ALL_FILE))).toBe(true);
  });

  test("T8: removing a key ends its pending link before that link can commit", async () => {
    const dir = stateDir();
    const devices = store(dir);
    const k = await key();
    const code = devices.pairingForNoAccount().code;
    const waiting = devices.pairRelay(code, "Phone", k);
    expect(waiting).not.toBeNull();
    const id = waiting!.device.id;
    expect(devices.sessionRow(id)?.provisional).toBe(true);
    devices.removeAccountKey(k, ACCOUNT, { id: newRecordId(), issuedAt: new Date().toISOString() });
    expect(devices.sessionRow(id)).toBeNull();
    expect(devices.linkAccountKey(id, k, k, ACCOUNT)).toBeNull();
    expect(devices.account()).toBeNull();
  });
});
