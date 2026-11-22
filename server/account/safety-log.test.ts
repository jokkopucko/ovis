import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DeviceStore, type StoredDevice } from "../devices.ts";
import { mergeRegistries } from "../state-merge.ts";
import { legacyOrigin } from "./admission-order.ts";
import { RemovalEvidence } from "./removal-evidence.ts";
import { relayFixture } from "../relay/test-helpers.ts";
import { exportAccountKey, newRecordId, signSafetyRecord, type SafetyRecord } from "../../shared/account-records.ts";
import { DEVICE_JOURNAL_FILE, pcRecordId, SAFETY_LOG_FILE, SafetyLog, type BlockAsOf } from "./safety-log.ts";

const dirs: string[] = [];
const fixtures: ReturnType<typeof relayFixture>[] = [];
afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function stateDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "ovis-safety-log-"));
  dirs.push(dir);
  return dir;
}

const ACCOUNT = "acct_1";
const AT = "2026-11-20T10:00:00.000Z";
const ASOF: BlockAsOf = { signer_no: 1, target_no: 3, after: 3, joined: 7, signer_removed: false };

/** A P-256 SPKI in base64url, as the log stores keys; only its form matters here. */
async function key(): Promise<string> {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  return Buffer.from(await crypto.subtle.exportKey("spki", pair.publicKey)).toString("base64url");
}

interface Signer { keys: CryptoKeyPair; spki: string }
async function signer(): Promise<Signer> {
  const keys = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
  return { keys, spki: await exportAccountKey(keys.publicKey) };
}

/** A block a device signed: its id is the SHA-256 of its signed bytes, which the record whole gives again. */
const signedBlock = (target: string, by: Signer): Promise<SafetyRecord> =>
  signSafetyRecord({ v: 1, kind: "block", account: ACCOUNT, target, target_no: 3, signer: by.spki, signer_no: 1, signed_at: AT, nonce: newRecordId() }, by.keys.privateKey);
const signedLift = (block: string, by: Signer): Promise<SafetyRecord> =>
  signSafetyRecord({ v: 1, kind: "lift", account: ACCOUNT, target: block, signer: by.spki, signer_no: 1, signed_at: AT }, by.keys.privateKey);

function pcRecord(kind: "lock" | "unlock" | "lift", target: string | null, forget = false): SafetyRecord {
  return { v: 1, id: pcRecordId(), kind, account: ACCOUNT, target, signer: "pc", signed_at: AT, signature: "", ...(kind === "lift" ? { forget } : {}) } as SafetyRecord;
}

function serviceFreeze(blockId: string, target: string): SafetyRecord {
  return { v: 1, id: `f:${blockId}`, kind: "freeze", account: ACCOUNT, target, after: 3, signer: "service", signed_at: AT, signature: "" };
}

const ids = (entries: readonly { record: { id: string } }[]) => entries.map((entry) => entry.record.id).sort();

describe("the PC safety log (account-log.json)", () => {
  test.each(["older-own", "newer-own", "quarantined", "imported", "sibling-time"] as const)(
    "a keyless cookie under a legacy cutoff needs an older, trusted own timestamp: %s", async history => {
      const dir = stateDir();
      const cutoff = Date.parse(AT);
      const older = new Date(cutoff - 1000).toISOString();
      const newer = new Date(cutoff + 1000).toISOString();
      const created = history === "newer-own" || history === "sibling-time" ? newer : older;
      const token = newRecordId();
      const row: StoredDevice = { id: "12".repeat(8), label: "Browser", role: "drive",
        token_hash: createHash("sha256").update(token).digest("hex"), last_seen_at: null, created_at: created,
        origin: legacyOrigin(created), ...(history === "imported" ? { imported: true } : {}),
        ...(history === "quarantined" ? { untrusted_created_at: created } : {}) };
      const registry = { gate_closed_at: older, devices: [row] };
      const { origin: _origin, ...twin } = row;
      const merged = history === "sibling-time" ? mergeRegistries(registry, {
        gate_closed_at: older, devices: [{ ...twin, created_at: older }],
      }, { own: null, other: null }, undefined, { dropConflictingKeys: true }) : registry;
      writeFileSync(join(dir, "devices.json"), JSON.stringify({ gate_closed_at: older, devices: merged.devices }), { mode: 0o600 });
      const safety = SafetyLog.open(dir);
      const devices = new DeviceStore(dir, null, null, { safety, removals: RemovalEvidence.open(dir, safety) });
      expect(devices.match(token)?.id).toBe(row.id);
      const block = await signedBlock(await key(), await signer());
      expect(safety.append({ got: "snapshot", record: block, asof: { signer_no: 0, target_no: 0, after: 0,
        joined: 0, legacy_created_at: cutoff, signer_removed: false } }).outcome).toBe("applied");
      expect(devices.match(token)?.id ?? null).toBe(history === "older-own" ? row.id : null);
    },
  );

  test("P24: append preserves signed bytes, IDs and increasing local numbers", async () => {
    const dir = stateDir();
    const by = await signer();
    const target = await key();
    const log = SafetyLog.open(dir);
    expect(log.strict).toBeNull();
    const block = await signedBlock(target, by);
    expect(log.append({ record: block, got: "handed", asof: ASOF })).toEqual({ outcome: "applied", id: block.id, n: 1 });
    const lock = pcRecord("lock", null);
    expect(log.append({ record: lock, got: "pc" })).toEqual({ outcome: "applied", id: lock.id, n: 2 });
    // the same record again is the same receipt, read from the log, and appends nothing
    expect(log.append({ record: block, got: "mailbox", asof: ASOF })).toEqual({ outcome: "applied", id: block.id, n: 1 });
    expect(log.receipt(block.id)).toEqual({ outcome: "applied", id: block.id, n: 1 });

    // what a restart reads is what was appended: the signed record whole, ids and numbers kept, the next number never used
    const again = SafetyLog.open(dir);
    expect(again.strict).toBeNull();
    const entries = again.entries();
    expect(entries.map((entry) => entry.n)).toEqual([1, 2]);
    expect(entries[0]!.record).toEqual(block);
    expect(entries[0]!.got).toBe("handed");
    expect(entries[0]!.asof).toEqual(ASOF);
    expect(entries[1]!.record).toEqual(lock);
    const unlock = pcRecord("unlock", lock.id);
    expect(again.append({ record: unlock, got: "pc" })).toEqual({ outcome: "applied", id: unlock.id, n: 3 });
    const file = JSON.parse(readFileSync(join(dir, SAFETY_LOG_FILE), "utf8")) as { v: number; next: number; base: unknown[]; entries: unknown[]; waiting: unknown[] };
    expect(file).toMatchObject({ v: 1, next: 4, base: [], waiting: [] });
    expect(file.entries).toHaveLength(3);

    // a signed record whose id is not the hash of its signed bytes, and a second record under a known id, are refused and change nothing
    const forged = await signedBlock(target, by);
    expect(again.append({ record: { ...forged, id: createHash("sha256").update("other").digest("hex") }, got: "handed", asof: ASOF }).outcome).toBe("refused");
    expect(again.append({ record: { ...lock, signed_at: "2026-11-21T10:00:00.000Z" }, got: "pc" })).toEqual({ outcome: "refused", id: lock.id, code: "conflict" });
    expect(again.entries()).toHaveLength(3);
    expect(again.strict).toBeNull();
  });

  test("T41: replay derives block, freeze, lock and record-specific endings before serving", async () => {
    const dir = stateDir();
    const by = await signer();
    const [a, b, c, frozen] = [await key(), await key(), await key(), await key()];
    const log = SafetyLog.open(dir);
    const blockA = await signedBlock(a, by);
    const blockB = await signedBlock(b, by);
    const blockC = await signedBlock(c, by);
    for (const block of [blockA, blockB, blockC]) log.append({ record: block, got: "mailbox", asof: ASOF });
    const freeze = serviceFreeze(createHash("sha256").update("a block this log does not hold").digest("hex"), frozen);
    log.append({ record: freeze, got: "snapshot" });
    const lock1 = pcRecord("lock", null);
    const lock2 = pcRecord("lock", null);
    log.append({ record: lock1, got: "pc" });
    log.append({ record: lock2, got: "pc" });
    // a lift ends the block it names and that block's freeze; its marker stands
    const liftA = await signedLift(blockA.id, by);
    log.append({ record: liftA, got: "snapshot", cause: "snapshot" });
    // a forgetting lift ends block B and its marker
    log.append({ record: pcRecord("lift", blockB.id, true), got: "pc", cause: "screen" });
    // an unlock ends the one lock it names
    log.append({ record: pcRecord("unlock", lock1.id), got: "pc" });
    // endings that name a record of another kind end nothing
    log.append({ record: pcRecord("unlock", blockC.id), got: "pc" });
    log.append({ record: pcRecord("lift", lock2.id), got: "pc", cause: "screen" });
    const replayed = (state: ReturnType<SafetyLog["state"]>) => ({
      locked: state.locked,
      locks: ids(state.locks),
      blocks: ids(state.blocks),
      freezes: ids(state.freezes),
      markers: ids(state.markers),
    });
    const expected = {
      locked: true,
      locks: [lock2.id],
      blocks: [blockC.id],
      freezes: [blockC.id, freeze.id].sort(),
      markers: [blockA.id, blockC.id].sort(),
    };
    expect(replayed(log.state())).toEqual(expected);
    // a start replays the file alone and derives the same: nothing ended comes back
    expect(replayed(SafetyLog.open(dir).state())).toEqual(expected);

    // a lift of a service freeze's block ends that freeze (by `f:` and the block's id)
    const liftFreeze = pcRecord("lift", freeze.id.slice(2));
    log.append({ record: liftFreeze, got: "pc", cause: "screen" });
    log.append({ record: pcRecord("unlock", lock2.id), got: "pc" });
    expect(replayed(SafetyLog.open(dir).state())).toEqual({ ...expected, locked: false, locks: [], freezes: [blockC.id] });

    // T73: startup cannot lift a block just because its signer has no row here.
    const fixture = relayFixture(false, { stateDir: dir, accountOpensAll: true });
    fixtures.push(fixture);
    dirs.splice(dirs.indexOf(dir), 1);
    const served = fixture.app.context.services.safetyLog;
    expect(served).not.toBeNull();
    expect(replayed(served!.state())).toEqual({ ...expected, locked: false, locks: [], freezes: [blockC.id] });
  });

  test("T73: lifting a standalone service freeze notifies its target after the lift is durable", async () => {
    const dir = stateDir();
    const log = SafetyLog.open(dir);
    const target = await key();
    const blockId = createHash("sha256").update("standalone freeze").digest("hex");
    const freeze = serviceFreeze(blockId, target);
    expect(log.append({ record: freeze, got: "snapshot" }).outcome).toBe("applied");
    const lift = pcRecord("lift", blockId);
    const heard: unknown[] = [];
    log.onLifted((key, cause) => heard.push([key, cause, SafetyLog.open(dir).receipt(lift.id)?.outcome]));
    expect(log.append({ record: lift, got: "pc", cause: "screen" }).outcome).toBe("applied");
    expect(log.state().freezes).toEqual([]);
    expect(heard).toEqual([[target, "screen", "applied"]]);
  });

  test("T28: missing or invalid log fails closed once journal exists", async () => {
    // no journal and no log: a PC that never kept one starts with an empty log
    const fresh = stateDir();
    expect(SafetyLog.open(fresh).strict).toBeNull();
    expect(existsSync(join(fresh, SAFETY_LOG_FILE))).toBe(false);

    const journalled = () => {
      const dir = stateDir();
      writeFileSync(join(dir, DEVICE_JOURNAL_FILE), JSON.stringify({ v: 1, entries: [] }), { mode: 0o600 });
      return dir;
    };
    // missing beside a journal
    const missing = journalled();
    expect(SafetyLog.open(missing).strict).toContain(SAFETY_LOG_FILE);
    // not JSON
    const garbled = journalled();
    writeFileSync(join(garbled, SAFETY_LOG_FILE), "{not json", { mode: 0o600 });
    expect(SafetyLog.open(garbled).strict).not.toBeNull();
    // one id with two different records
    const block = await signedBlock(await key(), await signer());
    const entry = { n: 1, got: "handed", record: block, asof: ASOF };
    const lock = pcRecord("lock", null);
    const twice = journalled();
    writeFileSync(join(twice, SAFETY_LOG_FILE), JSON.stringify({ v: 1, next: 3, base: [], waiting: [], entries: [{ n: 1, got: "pc", record: lock }, { n: 2, got: "pc", record: { ...lock, signed_at: "2026-11-21T10:00:00.000Z" } }] }), { mode: 0o600 });
    expect(SafetyLog.open(twice).strict).not.toBeNull();
    // a signed record whose id is not the hash of its signed bytes
    const forged = journalled();
    writeFileSync(join(forged, SAFETY_LOG_FILE), JSON.stringify({ v: 1, next: 2, base: [], waiting: [], entries: [{ ...entry, record: { ...block, target: await key() } }] }), { mode: 0o600 });
    expect(SafetyLog.open(forged).strict).not.toBeNull();
    // a number taken twice, or one at or past `next`
    const numbered = journalled();
    writeFileSync(join(numbered, SAFETY_LOG_FILE), JSON.stringify({ v: 1, next: 1, base: [], waiting: [], entries: [entry] }), { mode: 0o600 });
    expect(SafetyLog.open(numbered).strict).not.toBeNull();

    // a strict log appends nothing, so the file it could not read is never written over
    const before = readFileSync(join(garbled, SAFETY_LOG_FILE), "utf8");
    const strictLog = SafetyLog.open(garbled);
    expect(strictLog.append({ record: pcRecord("lock", null), got: "pc" })).toMatchObject({ outcome: "refused", code: "log_unavailable" });
    expect(readFileSync(join(garbled, SAFETY_LOG_FILE), "utf8")).toBe(before);

    // fails closed: a device this PC paired signs in no more, and account records are refused, until the log is put right
    const dir = journalled();
    writeFileSync(join(dir, SAFETY_LOG_FILE), "[]", { mode: 0o600 });
    const pairing = new DeviceStore(dir);
    const { token } = pairing.pair(pairing.startPairing().code, "Phone", "drive")!;
    expect(pairing.match(token)).not.toBeNull();
    const closed = new DeviceStore(dir, null, null, { safety: SafetyLog.open(dir) });
    expect(closed.match(token)).toBeNull();
    expect(closed.accountError).not.toBeNull();
    expect(closed.gated).toBe(true);
    expect(closed.pair(closed.startPairing().code, "Other", "drive")).toBeNull();

    // the same through the server's own start
    const fixture = relayFixture(false, { stateDir: dir, accountOpensAll: true });
    fixtures.push(fixture);
    dirs.splice(dirs.indexOf(dir), 1);
    expect(fixture.app.context.services.safetyLog?.strict).not.toBeNull();
    expect(fixture.app.context.services.devices.match(token)).toBeNull();
  });

  test("P24: no route appends to the log; only this PC's own code does", async () => {
    // S2-01 gives no network or mailbox path an append: a block reaches the log only after S2-09 verified it
    const fixture = relayFixture(false, { accountOpensAll: true });
    fixtures.push(fixture);
    const block = await signedBlock(await key(), await signer());
    const lock = pcRecord("lock", null);
    const headers = { "content-type": "application/json", "x-herdr-machine": "1" };
    for (const [path, body] of [
      ["/api/account/records", { records: [block, lock] }],
      ["/api/account/enroll", { account: ACCOUNT, records: [block, lock] }],
      ["/api/account/link", { record: block }],
      ["/api/account/introduce", { record: block }],
    ] as const) {
      const response = await fetch(`http://127.0.0.1:${fixture.app.port}${path}`, { method: "POST", headers, body: JSON.stringify(body) });
      await response.text();
    }
    expect(existsSync(join(fixture.stateDir, SAFETY_LOG_FILE))).toBe(false);
    expect(fixture.app.context.services.safetyLog!.entries()).toHaveLength(0);
  });

  test("P24: only an explicit opt-out leaves the existing PC path and files untouched", () => {
    const previous = process.env["OVIS_ACCOUNT_OPENS_ALL"];
    process.env["OVIS_ACCOUNT_OPENS_ALL"] = "0";
    try {
      // a log that would fail closed, beside a journal: with the flag off nobody reads it, and nothing is written
      const dir = stateDir();
      writeFileSync(join(dir, DEVICE_JOURNAL_FILE), JSON.stringify({ v: 1, entries: [] }), { mode: 0o600 });
      writeFileSync(join(dir, SAFETY_LOG_FILE), "{not json", { mode: 0o600 });
      const pairing = new DeviceStore(dir);
      const { token } = pairing.pair(pairing.startPairing().code, "Phone", "drive")!;
      expect(pairing.match(token)).not.toBeNull();
      const fixture = relayFixture(false, { stateDir: dir, accountOpensAll: undefined });
      fixtures.push(fixture);
      dirs.splice(dirs.indexOf(dir), 1);
      expect(fixture.app.context.services.safetyLog).toBeNull();
      expect(fixture.app.context.services.devices.match(token)).not.toBeNull();
      expect(fixture.app.context.services.devices.accountError).toBeNull();
      expect(readFileSync(join(dir, SAFETY_LOG_FILE), "utf8")).toBe("{not json");

      // a PC with no log gets none
      const empty = relayFixture(false, { accountOpensAll: undefined });
      fixtures.push(empty);
      expect(empty.app.context.services.safetyLog).toBeNull();
      expect(existsSync(join(empty.stateDir, SAFETY_LOG_FILE))).toBe(false);

      // Any value other than "0" leaves Step 2 on.
      process.env["OVIS_ACCOUNT_OPENS_ALL"] = "true";
      const other = relayFixture(false, { accountOpensAll: undefined });
      fixtures.push(other);
      expect(other.app.context.services.safetyLog).toBeInstanceOf(SafetyLog);
    } finally {
      if (previous === undefined) delete process.env["OVIS_ACCOUNT_OPENS_ALL"];
      else process.env["OVIS_ACCOUNT_OPENS_ALL"] = previous;
    }
  });
});
