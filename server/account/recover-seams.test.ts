import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exportAccountKey, newRecordId, signSafetyRecord, type BlockRecord, type SafetyRecord } from "../../shared/account-records.ts";
import { DeviceStore } from "../devices.ts";
import { DeviceJournal, JOURNAL_FILE } from "./device-journal.ts";
import { PcAccountState } from "./pc-binding.ts";
import { RemovalEvidence } from "./removal-evidence.ts";
import { pcRecordId, SafetyLog } from "./safety-log.ts";

const ACCOUNT = "acct_1";
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

interface Key { keys: CryptoKeyPair; spki: string }
async function key(): Promise<Key> {
  const keys = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
  return { keys, spki: await exportAccountKey(keys.publicKey) };
}

function open(dir: string) {
  const log = SafetyLog.open(dir);
  return { log, devices: new DeviceStore(dir, null, null, { safety: log, pc: PcAccountState.open(dir), removals: RemovalEvidence.open(dir, log), journal: DeviceJournal.open(dir, () => log.ensureFile()) }) };
}
function pc() {
  const dir = mkdtempSync(join(tmpdir(), "ovis-recover-seams-"));
  dirs.push(dir);
  return { dir, ...open(dir) };
}

async function member(devices: DeviceStore): Promise<Key & { id: string }> {
  const k = await key();
  const id = devices.pairRelay(devices.startPairing().code, "Phone", k.spki)!.device.id;
  devices.linkAccountKey(id, k.spki, k.spki, ACCOUNT);
  return { ...k, id };
}

const block = (target: string, by: Key): Promise<BlockRecord> =>
  signSafetyRecord({ v: 1, kind: "block", account: ACCOUNT, target, target_no: 9, signer: by.spki, signer_no: 1, signed_at: new Date().toISOString(), nonce: newRecordId() }, by.keys.privateKey) as Promise<BlockRecord>;
const blocksInForce = (log: SafetyLog) => log.state().blocks.map((entry) => entry.record.id);
const journal = (dir: string) => (JSON.parse(readFileSync(join(dir, JOURNAL_FILE), "utf8")) as { entries: { kind: string; how: string; key: string | null; by: string | null }[] }).entries;

describe("ovis recover acts on this PC's own state (T70, T73, T69)", () => {
  test("T73: a local removal of a signer's key takes its rows, journals the removal and lifts its blocks by the PC", async () => {
    const { dir, devices, log } = pc();
    const [signer, target] = [await member(devices), await member(devices)];
    const record = await block(target.spki, signer);
    await devices.applyBlock(record, "handed");
    expect(devices.removeKey({ target: signer.spki, by: "local" })).toEqual({ removed: [signer.id] });
    expect(devices.has(signer.id)).toBe(false);
    expect(devices.isTombstoned(signer.spki)).toBe(true);
    expect(blocksInForce(log)).toEqual([]);
    expect(log.entries().some((entry) => entry.record.kind === "lift" && entry.record.target === record.id && entry.record.signer === "pc")).toBe(true);
    expect(journal(dir).some((entry) => entry.kind === "remove" && entry.how === "recover" && entry.key === signer.spki)).toBe(true);
  });

  test("T73: a key with no row here is still removed: its Revoke stands and is journalled", async () => {
    const { dir, devices } = pc();
    await member(devices);
    const stranger = await key();
    expect(devices.removeKey({ target: stranger.spki, by: "local" })).toEqual({ removed: [] });
    expect(devices.isTombstoned(stranger.spki)).toBe(true);
    expect(journal(dir).some((entry) => entry.kind === "remove" && entry.how === "recover" && entry.key === stranger.spki)).toBe(true);
    expect(devices.removeKey({ target: "no-such-row", by: "local" })).toEqual({ refused: "unknown" });
  });

  test("T70: while this PC's log cannot be read, a removal refuses and changes nothing", async () => {
    const { dir, devices } = pc();
    const kept = await member(devices);
    writeFileSync(join(dir, "account-log.json"), "not json", { mode: 0o600 });
    const reopened = open(dir).devices;
    expect(reopened.removeKey({ target: kept.spki, by: "local" })).toEqual({ refused: "log_unreadable" });
    expect(reopened.has(kept.id)).toBe(true);
  });

  test("T69: a lift at the PC ends only the named block; its marker and the lock stay unless it forgets", async () => {
    const { devices, log } = pc();
    const [signer, target, other] = [await member(devices), await member(devices), await member(devices)];
    log.append({ record: { v: 1, id: pcRecordId(), kind: "lock", account: ACCOUNT, target: null, signer: "pc", signed_at: new Date().toISOString(), signature: "" } as SafetyRecord, got: "pc" });
    const [first, second] = [await block(target.spki, signer), await block(other.spki, signer)];
    await devices.applyBlock(first, "handed");
    await devices.applyBlock(second, "handed");
    expect(log.appendLift(first.id, { account: ACCOUNT }, { cause: "recover" })).toMatchObject({ outcome: "applied" });
    expect(blocksInForce(log)).toEqual([second.id]);
    const markers = () => log.state().markers.map((entry) => entry.record.id);
    expect(markers()).toEqual([first.id, second.id]);
    expect(log.state().locked).toBe(true);
    expect(log.appendLift(second.id, { account: ACCOUNT }, { cause: "recover", forget: true })).toMatchObject({ outcome: "applied" });
    expect(blocksInForce(log)).toEqual([]);
    expect(markers()).toEqual([first.id]);
    expect(log.state().locked).toBe(true);
  });

  test("T69: a lift at the PC needs this PC's account and a block this log holds", () => {
    const { log } = pc();
    expect(log.appendLift(newRecordId(), null, { cause: "recover" })).toMatchObject({ outcome: "refused", code: "record_invalid" });
    expect(log.appendLift(newRecordId(), { account: ACCOUNT }, { cause: "recover" })).toMatchObject({ outcome: "refused", code: "record_invalid" });
  });

  test("P24: a removal and Revoke all from the recovery socket journal the act and the OS user who ran it", async () => {
    const { dir, devices } = pc();
    const [first, second, third] = [await member(devices), await member(devices), await member(devices)];
    const stranger = await key();
    devices.removeKey({ target: first.spki, by: "local", user: "alice" });
    devices.removeKey({ target: stranger.spki, by: "local", user: "alice" });
    expect(journal(dir).filter((entry) => entry.kind === "remove" && entry.how === "recover").map((entry) => [entry.key, entry.by])).toEqual([[first.spki, "alice"], [stranger.spki, "alice"]]);
    devices.revokeAll("alice");
    expect(journal(dir).filter((entry) => entry.kind === "remove" && entry.key !== first.spki && entry.key !== stranger.spki).map((entry) => [entry.key, entry.how, entry.by])).toEqual([[second.spki, "recover", "alice"], [third.spki, "recover", "alice"]]);
  });

  test("P23 way 2: ovis recover lifts a service freeze this PC holds without its block, by the freeze's own id", async () => {
    const { devices, log } = pc();
    const blockId = "a".repeat(64);
    const freezeId = `f:${blockId}`;
    log.append({ record: { v: 1, id: freezeId, kind: "freeze", account: ACCOUNT, target: (await member(devices)).spki, after: 2, signer: "service", signed_at: new Date().toISOString(), signature: "" } as SafetyRecord, got: "snapshot" });
    expect(log.state().freezes).toHaveLength(1);
    expect(log.appendLift(freezeId, { account: ACCOUNT }, { cause: "recover" })).toMatchObject({ outcome: "applied" });
    expect(log.state().freezes).toHaveLength(0);
    // a freeze of another account, or an id this PC holds nothing for, is still refused
    expect(log.appendLift(`f:${"b".repeat(64)}`, { account: ACCOUNT }, { cause: "recover" })).toMatchObject({ outcome: "refused", code: "record_invalid" });
  });

  test("P24: a recover removal whose journal entry cannot be written writes no registry change, keeps the row out and fails closed", async () => {
    const { dir, devices } = pc();
    const kept = await member(devices);
    rmSync(join(dir, JOURNAL_FILE));
    mkdirSync(join(dir, JOURNAL_FILE));
    expect(() => devices.removeKey({ target: kept.id, by: "local", user: "alice" })).toThrow();
    const rows = JSON.parse(readFileSync(join(dir, "devices.json"), "utf8")) as { devices: { id: string }[] };
    expect(rows.devices.some((row) => row.id === kept.id)).toBe(true);
    expect(devices.has(kept.id)).toBe(false);
    expect(devices.failsClosed).toBe(true);
  });

  test("P24: a Revoke all whose journal entries cannot be written fails closed and finishes at the next start", async () => {
    const { dir, devices } = pc();
    const kept = await member(devices);
    rmSync(join(dir, JOURNAL_FILE));
    mkdirSync(join(dir, JOURNAL_FILE));
    expect(() => devices.revokeAll()).toThrow();
    expect(devices.failsClosed).toBe(true);
    rmSync(join(dir, JOURNAL_FILE), { recursive: true });
    expect(open(dir).devices.has(kept.id)).toBe(false);
  });
});
