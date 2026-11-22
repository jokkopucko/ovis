import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { relayFixture } from "../relay/test-helpers.ts";
import { exportAccountKey, newRecordId, signSafetyRecord, type SafetyRecord } from "../../shared/account-records.ts";
import { mergeSafetyLogs, pcRecordId, SAFETY_LOG_FILE, SafetyLog, type BlockAsOf } from "./safety-log.ts";

const dirs: string[] = [];
const fixtures: ReturnType<typeof relayFixture>[] = [];
afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function stateDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "ovis-safety-merge-"));
  dirs.push(dir);
  return dir;
}

const ACCOUNT = "acct_1";
const AT = "2026-11-20T10:00:00.000Z";
const asof = (after: number): BlockAsOf => ({ signer_no: 1, target_no: after, after, joined: null, signer_removed: false });

async function key(): Promise<string> {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  return Buffer.from(await crypto.subtle.exportKey("spki", pair.publicKey)).toString("base64url");
}

interface Signer { keys: CryptoKeyPair; spki: string }
async function signer(): Promise<Signer> {
  const keys = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
  return { keys, spki: await exportAccountKey(keys.publicKey) };
}

const block = (target: string, by: Signer): Promise<SafetyRecord> =>
  signSafetyRecord({ v: 1, kind: "block", account: ACCOUNT, target, target_no: 3, signer: by.spki, signer_no: 1, signed_at: AT, nonce: newRecordId() }, by.keys.privateKey);

const pc = (kind: "lock" | "unlock" | "lift", target: string | null, forget = false): SafetyRecord =>
  ({ v: 1, id: pcRecordId(), kind, account: ACCOUNT, target, signer: "pc", signed_at: AT, signature: "", ...(kind === "lift" ? { forget } : {}) }) as SafetyRecord;

const inForce = (log: SafetyLog) => {
  const state = log.state();
  return { locked: state.locked, blocks: state.blocks.map((e) => e.record.id).sort(), markers: state.markers.map((e) => e.record.id).sort() };
};
const numbers = (log: SafetyLog) => Object.fromEntries(log.entries().map((entry) => [entry.record.id, { n: entry.n, got: entry.got }]));

describe("merging and folding the PC safety log", () => {
  test("T48: both directories retain endings and local numbering despite different receipt metadata", async () => {
    const [own, other] = [stateDir(), stateDir()];
    const by = await signer();
    const x = await block(await key(), by);
    const y = await block(await key(), by);
    const lock = pc("lock", null);
    const mine = SafetyLog.open(own);
    mine.append({ record: x, got: "handed", asof: asof(3) });
    mine.append({ record: lock, got: "pc" });
    const theirs = SafetyLog.open(other);
    // the same lock, taken another way; an ending the owner made in the other dir only; a block only it holds
    theirs.append({ record: lock, got: "merge" });
    const liftX = pc("lift", x.id);
    theirs.append({ record: liftX, got: "pc", cause: "screen" });
    theirs.append({ record: y, got: "mailbox", asof: asof(5) });

    expect(mergeSafetyLogs(own, other)).toBeNull();
    const [a, b] = [SafetyLog.open(own), SafetyLog.open(other)];
    expect(a.strict).toBeNull();
    expect(b.strict).toBeNull();
    // each dir keeps its numbers, and takes the other's records after its last one, in that dir's order
    expect(numbers(a)).toEqual({ [x.id]: { n: 1, got: "handed" }, [lock.id]: { n: 2, got: "pc" }, [liftX.id]: { n: 3, got: "merge" }, [y.id]: { n: 4, got: "merge" } });
    expect(numbers(b)).toEqual({ [lock.id]: { n: 1, got: "merge" }, [liftX.id]: { n: 2, got: "pc" }, [y.id]: { n: 3, got: "mailbox" }, [x.id]: { n: 4, got: "merge" } });
    // the asof the other dir noted comes with its record; a signed record comes whole
    expect(a.entries().find((e) => e.record.id === y.id)?.asof).toEqual(asof(5));
    expect(b.entries().find((e) => e.record.id === x.id)!.record).toEqual(x);
    // nothing ended comes back, nothing in force is lost: the same state in both
    const expected = { locked: true, blocks: [y.id], markers: [x.id, y.id].sort() };
    expect(inForce(a)).toEqual(expected);
    expect(inForce(b)).toEqual(expected);
    // a second merge changes nothing
    const before = readFileSync(join(own, SAFETY_LOG_FILE), "utf8");
    expect(mergeSafetyLogs(own, other)).toBeNull();
    expect(readFileSync(join(own, SAFETY_LOG_FILE), "utf8")).toBe(before);

    // a merged log that cannot be written fails the PC closed and names the dir (where a mode can refuse a write)
    if (process.platform !== "win32" && process.getuid?.() !== 0) {
      const blocked = stateDir();
      rmSync(blocked, { recursive: true });
      mkdirSync(blocked, { mode: 0o500 });
      expect(mergeSafetyLogs(blocked, own)).toContain(blocked);
    }

    // a dir with no log takes the other's records
    const empty = stateDir();
    expect(mergeSafetyLogs(empty, own)).toBeNull();
    expect(inForce(SafetyLog.open(empty))).toEqual(expected);
  });

  test("T48: conflicting signed records of the same ID fail closed", async () => {
    const [own, other] = [stateDir(), stateDir()];
    // one id with two records: the PC wrote a lock under an id the other dir holds with other content
    const lock = pc("lock", null);
    SafetyLog.open(own).append({ record: lock, got: "pc" });
    const theirs = SafetyLog.open(other);
    expect(theirs.append({ record: { ...lock, signed_at: "2026-11-21T10:00:00.000Z" }, got: "pc" }).outcome).toBe("applied");
    const [ownBefore, otherBefore] = [readFileSync(join(own, SAFETY_LOG_FILE), "utf8"), readFileSync(join(other, SAFETY_LOG_FILE), "utf8")];
    const problem = mergeSafetyLogs(own, other);
    expect(problem).not.toBeNull();
    // nothing written to either dir, and the PC fails closed until it is put right
    expect(readFileSync(join(own, SAFETY_LOG_FILE), "utf8")).toBe(ownBefore);
    expect(readFileSync(join(other, SAFETY_LOG_FILE), "utf8")).toBe(otherBefore);
    expect(SafetyLog.open(own, problem).strict).not.toBeNull();

    // a signed record under its id with other content no longer hashes to it: that dir's log cannot be trusted, and the
    // server's own start fails the PC closed rather than merge it
    const x = await block(await key(), await signer());
    const sibling = stateDir();
    writeFileSync(join(sibling, SAFETY_LOG_FILE), JSON.stringify({ v: 1, next: 2, base: [], waiting: [], entries: [{ n: 1, got: "handed", record: { ...x, target: await key() }, asof: asof(3) }] }), { mode: 0o600 });
    const active = stateDir();
    SafetyLog.open(active).append({ record: x, got: "handed", asof: asof(3) });
    expect(mergeSafetyLogs(active, sibling)).not.toBeNull();
    const fixture = relayFixture(false, { stateDir: active, siblingStateDir: sibling, accountOpensAll: true });
    fixtures.push(fixture);
    dirs.splice(dirs.indexOf(active), 1);
    expect(fixture.app.context.services.safetyLog?.strict).not.toBeNull();
    expect(fixture.app.context.services.devices.accountError).not.toBeNull();
  });

  test("P24: folding keeps evidence needed by a live marker and never forgets an ID", async () => {
    const dir = stateDir();
    const by = await signer();
    const log = SafetyLog.open(dir);
    const x = await block(await key(), by);
    const y = await block(await key(), by);
    const lock = pc("lock", null);
    for (const b of [x, y]) log.append({ record: b, got: "handed", asof: asof(3) });
    log.append({ record: lock, got: "pc" });
    // nothing folds while any record is in force
    expect(log.fold()).toBe(0);
    log.append({ record: pc("unlock", lock.id), got: "pc" });
    log.append({ record: pc("lift", x.id), got: "pc", cause: "screen" });
    log.append({ record: pc("lift", x.id, true), got: "pc", cause: "screen" });
    log.append({ record: pc("lift", y.id), got: "pc", cause: "screen" });
    expect(log.fold()).toBeGreaterThan(0);
    const reopened = SafetyLog.open(dir);
    const kept = reopened.entries().map((e) => e.record.id);
    // y was lifted but not forgotten: its marker stands, so its signed entry stays whole, and so does its lift
    expect(kept).toContain(y.id);
    expect(reopened.entries().find((e) => e.record.id === y.id)?.record).toEqual(y);
    expect(inForce(reopened).markers).toEqual([y.id]);
    // x, the lock and their endings folded: known and ended, never forgotten
    expect(kept).not.toContain(x.id);
    expect(kept).not.toContain(lock.id);
    const base = (JSON.parse(readFileSync(join(dir, SAFETY_LOG_FILE), "utf8")) as { base: { id: string; kind: string; ended_by: string[] }[] }).base;
    expect(base.find((line) => line.id === x.id)).toMatchObject({ kind: "block", account: ACCOUNT });
    expect(base.find((line) => line.id === lock.id)).toBeDefined();
    // a folded id handed again starts nothing, and a merge never brings it back
    expect(reopened.append({ record: x, got: "handed", asof: asof(3) })).toEqual({ outcome: "already_applied", id: x.id });
    const sibling = stateDir();
    SafetyLog.open(sibling).append({ record: x, got: "mailbox", asof: asof(3) });
    expect(mergeSafetyLogs(dir, sibling)).toBeNull();
    expect(inForce(SafetyLog.open(dir))).toEqual({ locked: false, blocks: [], markers: [y.id] });
    expect(inForce(SafetyLog.open(sibling)).blocks).toEqual([]);
    expect(existsSync(join(sibling, SAFETY_LOG_FILE))).toBe(true);
  });

  test("T51: repeat yields applied with its local number until fold, then already_applied", async () => {
    const dir = stateDir();
    const log = SafetyLog.open(dir);
    const x = await block(await key(), await signer());
    expect(log.append({ record: x, got: "handed", asof: asof(3) })).toEqual({ outcome: "applied", id: x.id, n: 1 });
    log.append({ record: pc("lift", x.id), got: "pc", cause: "screen" });
    // lifted, not forgotten: still whole, still the same receipt
    expect(log.fold()).toBe(0);
    expect(log.append({ record: x, got: "mailbox", asof: asof(3) })).toEqual({ outcome: "applied", id: x.id, n: 1 });
    log.append({ record: pc("lift", x.id, true), got: "pc", cause: "screen" });
    expect(log.fold()).toBeGreaterThan(0);
    expect(log.receipt(x.id)).toEqual({ outcome: "already_applied", id: x.id });
    expect(log.append({ record: x, got: "mailbox", asof: asof(3) })).toEqual({ outcome: "already_applied", id: x.id });
  });

  test("P24: folding a service freeze keeps the lift its block still needs", async () => {
    const dir = stateDir();
    const log = SafetyLog.open(dir);
    const x = await block(await key(), await signer());
    log.append({ record: x, got: "handed", asof: asof(3) });
    log.append({ record: { v: 1, id: `f:${x.id}`, kind: "freeze", account: ACCOUNT, target: (x as { target: string }).target, after: 3, signer: "service", signed_at: AT, signature: "" } as SafetyRecord, got: "snapshot" });
    log.append({ record: pc("lift", x.id), got: "pc", cause: "screen" });
    expect(log.state().blocks).toHaveLength(0);
    log.fold();
    const reopened = SafetyLog.open(dir);
    expect(reopened.state().blocks).toHaveLength(0);
    expect(reopened.state().freezes).toHaveLength(0);
  });

  test("T48: one id folded in one folder and whole with other content in the other fails closed and writes neither", async () => {
    const [own, other] = [stateDir(), stateDir()];
    const k = await key();
    const forget = (account: string) => ({ v: 1, id: "c".repeat(32), kind: "forget", account, target: k, signer: "pc", signed_at: AT, signature: "" }) as SafetyRecord;
    SafetyLog.open(own).append({ record: forget(ACCOUNT), got: "pc" });
    SafetyLog.open(own).fold();
    SafetyLog.open(other).append({ record: forget("acct_9"), got: "pc" });
    const [ownBefore, otherBefore] = [readFileSync(join(own, SAFETY_LOG_FILE), "utf8"), readFileSync(join(other, SAFETY_LOG_FILE), "utf8")];
    expect(mergeSafetyLogs(own, other)).not.toBeNull();
    expect(readFileSync(join(own, SAFETY_LOG_FILE), "utf8")).toBe(ownBefore);
    expect(readFileSync(join(other, SAFETY_LOG_FILE), "utf8")).toBe(otherBefore);
  });

  test("P24: one block noted with two freeze lines keeps the stricter one in both folders", async () => {
    const [own, other] = [stateDir(), stateDir()];
    const x = await block(await key(), await signer());
    SafetyLog.open(own).append({ record: x, got: "handed", asof: asof(7) });
    SafetyLog.open(other).append({ record: x, got: "mailbox", asof: asof(4) });
    expect(mergeSafetyLogs(own, other)).toBeNull();
    for (const dir of [own, other]) expect(SafetyLog.open(dir).entries().find((e) => e.record.id === x.id)?.asof?.after).toBe(4);
  });

  test("P24: a lift folded with a service freeze still ends the block a sibling holds whole", async () => {
    const [own, other] = [stateDir(), stateDir()];
    const x = await block(await key(), await signer());
    const mine = SafetyLog.open(own);
    mine.append({ record: { v: 1, id: `f:${x.id}`, kind: "freeze", account: ACCOUNT, target: (x as { target: string }).target, after: 3, signer: "service", signed_at: AT, signature: "" } as SafetyRecord, got: "snapshot" });
    mine.append({ record: pc("lift", x.id), got: "pc", cause: "screen" });
    mine.fold();
    SafetyLog.open(other).append({ record: x, got: "handed", asof: asof(3) });
    expect(mergeSafetyLogs(own, other)).toBeNull();
    for (const dir of [own, other]) expect(SafetyLog.open(dir).state().blocks.map((e) => e.record.id)).toEqual([]);
  });

  test("P24: a lift already folded into base still ends the block a sibling brings whole", async () => {
    const [own, other] = [stateDir(), stateDir()];
    const x = await block(await key(), await signer());
    writeFileSync(join(own, SAFETY_LOG_FILE), JSON.stringify({ v: 1, next: 2, base: [{ id: "d".repeat(32), kind: "lift", account: ACCOUNT, target: x.id, ended_by: [] }], entries: [], waiting: [] }), { mode: 0o600 });
    SafetyLog.open(other).append({ record: x, got: "handed", asof: asof(3) });
    expect(mergeSafetyLogs(own, other)).toBeNull();
    for (const dir of [own, other]) {
      expect(SafetyLog.open(dir).state().blocks).toEqual([]);
      expect(SafetyLog.open(dir).state().freezes).toEqual([]);
    }
  });

  test("T48: one id folded in both folders under different accounts fails closed and writes neither", async () => {
    const [own, other] = [stateDir(), stateDir()];
    const k = await key();
    const line = (account: string) => ({ id: "e".repeat(32), kind: "forget", account, target: k, ended_by: [] });
    writeFileSync(join(own, SAFETY_LOG_FILE), JSON.stringify({ v: 1, next: 2, base: [line(ACCOUNT)], entries: [], waiting: [] }), { mode: 0o600 });
    writeFileSync(join(other, SAFETY_LOG_FILE), JSON.stringify({ v: 1, next: 2, base: [line("acct_2")], entries: [], waiting: [] }), { mode: 0o600 });
    const [ownBefore, otherBefore] = [readFileSync(join(own, SAFETY_LOG_FILE), "utf8"), readFileSync(join(other, SAFETY_LOG_FILE), "utf8")];
    expect(mergeSafetyLogs(own, other)).not.toBeNull();
    expect(readFileSync(join(own, SAFETY_LOG_FILE), "utf8")).toBe(ownBefore);
    expect(readFileSync(join(other, SAFETY_LOG_FILE), "utf8")).toBe(otherBefore);
  });

  test("P21: a merge keeps each folder's own joined, the lower freeze line, and the signer not removed if either saw it so", async () => {
    const [own, other] = [stateDir(), stateDir()];
    const x = await block(await key(), await signer());
    SafetyLog.open(own).append({ record: x, got: "handed", asof: { ...asof(7), joined: 8, signer_removed: true } });
    SafetyLog.open(other).append({ record: x, got: "mailbox", asof: { ...asof(4), joined: 2, signer_removed: false } });
    expect(mergeSafetyLogs(own, other)).toBeNull();
    const notes = [own, other].map((dir) => SafetyLog.open(dir).entries().find((e) => e.record.id === x.id)?.asof);
    expect(notes.map((note) => note?.joined)).toEqual([8, 2]);
    expect(notes.map((note) => note?.after)).toEqual([4, 4]);
    expect(notes.map((note) => note?.signer_removed)).toEqual([false, false]);
  });

  test("P24: a block only the other folder holds is copied with the note that folder took", async () => {
    const [own, other] = [stateDir(), stateDir()];
    const x = await block(await key(), await signer());
    const note = { ...asof(5), joined: 9, signer_removed: true };
    SafetyLog.open(other).append({ record: x, got: "mailbox", asof: note });
    expect(mergeSafetyLogs(own, other)).toBeNull();
    expect(SafetyLog.open(own).entries().find((e) => e.record.id === x.id)?.asof).toEqual(note);
  });
});

