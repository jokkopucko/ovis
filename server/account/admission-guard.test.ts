import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exportAccountKey, newRecordId, signAccountRecord, signSafetyRecord } from "../../shared/account-records.ts";
import { DeviceStore } from "../devices.ts";
import { relayFixture } from "../relay/test-helpers.ts";
import { DeviceJournal } from "./device-journal.ts";
import { PcAccountState } from "./pc-binding.ts";
import { applyAccountRecords, applyLink, type AddGates } from "./records.ts";
import { RemovalEvidence } from "./removal-evidence.ts";
import { pcRecordId, SAFETY_LOG_FILE, SafetyLog } from "./safety-log.ts";

const ACCOUNT = "acct_1";
const SERVER_ID = "0123456789abcdef0123456789abcdef";
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

interface Pc { dir: string; devices: DeviceStore; log: SafetyLog }
function pc(): Pc {
  const dir = mkdtempSync(join(tmpdir(), "ovis-admission-guard-"));
  dirs.push(dir);
  const log = SafetyLog.open(dir);
  const devices = new DeviceStore(dir, null, null, { safety: log, pc: PcAccountState.open(dir), removals: RemovalEvidence.open(dir, log), journal: DeviceJournal.open(dir, () => log.ensureFile()) });
  return { dir, devices, log };
}

async function accountKey() {
  const keys = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
  return { keys, spki: await exportAccountKey(keys.publicKey) };
}

/** A drive member of the account on this PC, which signs with its key. */
async function member(devices: DeviceStore) {
  const key = await accountKey();
  const id = devices.pairRelay(devices.startPairing().code, "Member", key.spki)!.device.id;
  devices.linkAccountKey(id, key.spki, key.spki, ACCOUNT);
  return { id, key };
}

/** A block of `target` in force in this PC's log, signed by `by`; the target joined here as admission number `joined`. */
async function block(log: SafetyLog, target: string, by: Awaited<ReturnType<typeof accountKey>>, joined: number | null): Promise<void> {
  const record = await signSafetyRecord({ v: 1, kind: "block", account: ACCOUNT, target, target_no: 2, signer: by.spki, signer_no: 1, signed_at: new Date().toISOString(), nonce: newRecordId() }, by.keys.privateKey);
  log.append({ record, got: "handed", asof: { signer_no: 1, target_no: 2, after: 2, joined, signer_removed: false } });
}

const add = (signer: Awaited<ReturnType<typeof accountKey>>, key: string) =>
  signAccountRecord({ v: 1, kind: "add", account: ACCOUNT, key, label: "New phone", role: "drive", issued_at: new Date().toISOString(), id: newRecordId(), signer: signer.spki }, signer.keys.privateKey);

async function linkSameKey(devices: DeviceStore, deviceId: string, { spki, keys }: Awaited<ReturnType<typeof accountKey>>, gates?: AddGates) {
  const record = await signAccountRecord({ v: 1, kind: "link", account: ACCOUNT, key: spki, old_key: spki, device_id: deviceId, server_id: SERVER_ID, issued_at: new Date().toISOString(), id: newRecordId(), signer: spki }, keys.privateKey);
  const arrival = devices.linkArrived(deviceId);
  if (arrival === null) throw new Error("Link did not reach record validation");
  return applyLink(devices, record, { deviceId, serverId: SERVER_ID, sessionKey: spki }, arrival, gates === undefined ? {} : { gates });
}

describe("one final admission guard (G3, rule R1)", () => {
  test("G3: admits refuses a key held by the account mailbox", async () => {
    const { spki } = await accountKey();
    const fixture = relayFixture(false, { accountOpensAll: true });
    try {
      const { devices, accountHolds, accountMailbox } = fixture.app.context.services;
      expect(devices.admits(spki)).toBe(true);
      accountHolds.hold([spki]);
      expect(accountMailbox.gates().held(spki)).toBe(true);
      expect(devices.admits(spki)).toBe(false);
    } finally {
      fixture.close();
    }
  });

  test("G3: admits refuses a key removed by the account", async () => {
    const { devices } = pc();
    const { spki } = await accountKey();
    expect(devices.admits(spki)).toBe(true);
    devices.removeAccountKey(spki, ACCOUNT, { id: newRecordId(), issuedAt: new Date().toISOString() });
    expect(devices.removedByAccount(spki)).toBe(true);
    expect(devices.admits(spki)).toBe(false);
  });

  test("G3: a held key cannot become an approver through a same-key link", async () => {
    const fixture = relayFixture(false, { accountOpensAll: true });
    try {
      const { devices, accountHolds, accountMailbox } = fixture.app.context.services;
      const named = await accountKey();
      const paired = devices.pairRelay(devices.startPairing().code, "Phone", named.spki);
      if (paired === null) throw new Error("Initial pairing failed");
      accountHolds.hold([named.spki]);
      expect(devices.admits(named.spki)).toBe(false);

      const id = paired.device.id;
      expect(await linkSameKey(devices, id, named, accountMailbox.gates())).toHaveProperty("refused");
      expect(devices.isAccountApprover(id)).toBe(false);
    } finally {
      fixture.close();
    }
  });

  test("G3: a key newer than a block target cannot become an approver through a same-key link", async () => {
    const { devices, log } = pc();
    const [signer, target, named] = await Promise.all([accountKey(), accountKey(), accountKey()]);
    for (const k of [signer, target]) {
      if (devices.pairRelay(devices.startPairing().code, "Older device", k.spki) === null) throw new Error("Older key did not pair");
    }
    const paired = devices.pairRelay(devices.startPairing().code, "Phone", named.spki);
    if (paired === null) throw new Error("Initial pairing failed");
    await block(log, target.spki, signer, 2);
    expect(devices.admits(signer.spki)).toBe(true);
    expect(devices.admits(named.spki)).toBe(false);

    const id = paired.device.id;
    expect(await linkSameKey(devices, id, named)).toHaveProperty("refused");
    expect(devices.isAccountApprover(id)).toBe(false);
  });

  test("keptOut names what keeps a key out where admits refuses it, and nothing where admits lets it in", async () => {
    const fixture = relayFixture(false, { accountOpensAll: true });
    try {
      const { devices, accountHolds } = fixture.app.context.services;
      const held = await accountKey();
      expect([devices.admits(held.spki), devices.keptOut(held.spki)]).toEqual([true, null]);
      accountHolds.hold([held.spki]);
      expect([devices.admits(held.spki), devices.keptOut(held.spki)]).toEqual([false, "account_hold"]);
    } finally {
      fixture.close();
    }
    const { devices, log } = pc();
    const removed = await accountKey();
    devices.removeAccountKey(removed.spki, ACCOUNT, { id: newRecordId(), issuedAt: new Date().toISOString() });
    expect([devices.admits(removed.spki), devices.keptOut(removed.spki)]).toEqual([false, "account_removed"]);
    const [signer, target, older, newer, revoked] = await Promise.all([accountKey(), accountKey(), accountKey(), accountKey(), accountKey()]);
    for (const k of [signer, target, older, revoked]) {
      if (devices.pairRelay(devices.startPairing().code, "Older device", k.spki) === null) throw new Error("Older key did not pair");
    }
    devices.revoke(devices.list(null).find(row => devices.relayKeyOf(row.id) === revoked.spki)!.id);
    // a Revoke here keeps the key out of an approval from afar, never out of a pairing on this PC
    expect([devices.keptOut(revoked.spki), devices.keptOut(revoked.spki, { pairingHere: true })]).toEqual(["revoked", null]);
    await block(log, target.spki, signer, 99);
    expect([older, target, newer].map(k => [devices.admits(k.spki), devices.keptOut(k.spki)])).toEqual([[true, null], [false, "block"], [false, "block"]]);
  });

  test("keptOut names the account's freeze apart from a block, a PC that cannot trust its account state, and a row whose time it cannot trust", async () => {
    const { devices, log } = pc();
    const [target, newer] = await Promise.all([accountKey(), accountKey()]);
    expect(log.append({ record: { v: 1, id: `f:${"a".repeat(64)}`, kind: "freeze", account: ACCOUNT, target: target.spki, after: 2, signer: "service", signed_at: new Date().toISOString(), signature: "" }, got: "snapshot" }).outcome).toBe("applied");
    expect([devices.admits(newer.spki), devices.keptOut(newer.spki)]).toEqual([false, "freeze"]);

    const strict = mkdtempSync(join(tmpdir(), "ovis-admission-guard-"));
    dirs.push(strict);
    writeFileSync(join(strict, SAFETY_LOG_FILE), "not json", { mode: 0o600 });
    const closed = new DeviceStore(strict, null, null, { safety: SafetyLog.open(strict) });
    expect([closed.admits(newer.spki), closed.keptOut(newer.spki)]).toEqual([false, "closed"]);

    const restored = mkdtempSync(join(tmpdir(), "ovis-admission-guard-"));
    dirs.push(restored);
    const at = new Date().toISOString();
    const row = { id: "a".repeat(16), label: "Restored phone", role: "drive", token_hash: "b".repeat(64), relay_public_key: newer.spki, created_at: at, untrusted_created_at: at, last_seen_at: null };
    writeFileSync(join(restored, "devices.json"), JSON.stringify({ gate_closed_at: at, devices: [row] }), { mode: 0o600 });
    const restoredLog = SafetyLog.open(restored);
    const untrusted = new DeviceStore(restored, null, null, { safety: restoredLog, pc: PcAccountState.open(restored), removals: RemovalEvidence.open(restored, restoredLog), journal: DeviceJournal.open(restored, () => restoredLog.ensureFile()) });
    expect([untrusted.admits(newer.spki), untrusted.keptOut(newer.spki, { pairingHere: true })]).toEqual([false, "untrusted"]);
  });

  test("G3: admits and a signed add refuse a key revoked on this PC", async () => {
    const { devices } = pc();
    const signer = await member(devices);
    const { spki } = await accountKey();
    const paired = devices.pairRelay(devices.startPairing().code, "Phone", spki);
    if (paired === null) throw new Error("Initial pairing failed");
    devices.revoke(paired.device.id);
    expect(devices.isTombstoned(spki)).toBe(true);
    expect(devices.removedByAccount(spki)).toBe(false);

    const record = await add(signer.key, spki);
    expect(await applyAccountRecords(devices, [record], SERVER_ID)).toEqual([{ id: record.id, outcome: "refused", code: "tombstoned" }]);
    expect(devices.hasKey(spki)).toBe(false);
    expect(devices.admits(spki)).toBe(false);
  });

  test("G3: a code started on this PC can re-pair a locally revoked key", async () => {
    const { devices } = pc();
    const { spki } = await accountKey();
    const paired = devices.pairRelay(devices.startPairing().code, "Phone", spki);
    if (paired === null) throw new Error("Initial pairing failed");
    devices.revoke(paired.device.id);
    expect(devices.isTombstoned(spki)).toBe(true);

    expect(devices.pairRelay(devices.startPairing().code, "Phone", spki)).not.toBeNull();
    expect(devices.isTombstoned(spki)).toBe(false);
    expect(devices.hasKey(spki)).toBe(true);
  });

  test("T10: digits approval rechecks member authority and the freeze for this key at commit", async () => {
    const { devices, log } = pc();
    const approver = await member(devices);
    // no freeze: the approval of a new key commits
    expect(devices.pairRelayApproved("Phone", (await accountKey()).spki, { path: "account", addedBy: approver.id })).not.toBeNull();
    // a freeze stands: a new key is newer than its target, and the same approval admits nobody
    const target = await member(devices);
    await block(log, target.key.spki, approver.key, 99);
    expect(devices.pairRelayApproved("Tablet", (await accountKey()).spki, { path: "account", addedBy: approver.id })).toBeNull();
    // an approver gone by commit approves nothing
    const fresh = pc();
    const gone = await member(fresh.devices);
    fresh.devices.revoke(gone.id);
    expect(fresh.devices.pairRelayApproved("Phone", (await accountKey()).spki, { path: "account", addedBy: gone.id })).toBeNull();
  });

  test("T15: a handed or mailed add cannot widen under a freeze or after generation changes", async () => {
    const { devices, log } = pc();
    const signer = await member(devices);
    const other = await member(devices);
    // the generation changes while the add is being verified: it does not commit
    const pending = applyAccountRecords(devices, [await add(signer.key, (await accountKey()).spki)], SERVER_ID);
    devices.revoke(other.id);
    expect((await pending).map((r) => r.outcome)).toEqual(["refused"]);
    // unchanged generation: it commits
    expect((await applyAccountRecords(devices, [await add(signer.key, (await accountKey()).spki)], SERVER_ID)).map((r) => r.outcome)).toEqual(["applied"]);
    // a freeze stands: refused, and not kept for later
    await block(log, (await accountKey()).spki, signer.key, 99);
    const newKey = (await accountKey()).spki;
    expect((await applyAccountRecords(devices, [await add(signer.key, newKey)], SERVER_ID)).map((r) => r.outcome)).toEqual(["refused"]);
    expect(devices.hasKey(newKey)).toBe(false);
  });

  test("G3: admission, release and merge import share the same final guard", async () => {
    const { devices, log } = pc();
    const older = await member(devices);
    const target = await member(devices);
    // the block's target joined this PC as admission 2: keys admitted before it stay admissible, every new key is newer
    await block(log, target.key.spki, older.key, 2);
    expect(devices.admits(older.key.spki)).toBe(true);
    const newKey = (await accountKey()).spki;
    expect(devices.admits(newKey)).toBe(false);
    // every admission path asks it at commit
    expect(devices.pair(devices.startPairing().code, "Laptop", "drive")).toBeNull();
    expect(devices.pairRelay(devices.startPairing().code, "Phone", newKey)).toBeNull();
    expect(devices.pairRelayApproved("Phone", newKey, { path: "account", addedBy: older.id })).toBeNull();
    expect((await applyAccountRecords(devices, [await add(older.key, newKey)], SERVER_ID))[0]!.outcome).toBe("refused");
    expect(devices.hasKey(newKey)).toBe(false);

    // a lock admits nobody remote, a key no freeze names included
    const locked = pc();
    const keep = await member(locked.devices);
    locked.log.append({ record: { v: 1, id: pcRecordId(), kind: "lock", account: ACCOUNT, target: null, signer: "pc", signed_at: new Date().toISOString(), signature: "" }, got: "pc" });
    expect(locked.devices.admits(keep.key.spki)).toBe(false);
    expect(locked.devices.pairRelay(locked.devices.startPairing().code, "Phone", (await accountKey()).spki)).toBeNull();
  });
});
