import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exportAccountKey, newRecordId, signSafetyRecord, type BlockRecord } from "../../shared/account-records.ts";
import { DeviceStore } from "../devices.ts";
import { applyAccountRecords } from "./records.ts";
import { accountDeviceId, signAccountRecord } from "../../shared/account-records.ts";
import { ACCOUNT_DEVICES_FILE } from "./account-devices.ts";
import { readFileSync } from "node:fs";
import { AccountDeviceStore } from "./account-devices.ts";
import { CatchUpGate } from "./catch-up-gate.ts";
import { DeviceJournal } from "./device-journal.ts";
import { AccountOrder } from "./account-order.ts";
import { listNotices } from "./list-notices.ts";
import { JOIN_HOLD_MS } from "./join-hold.ts";
import { PcAccountState } from "./pc-binding.ts";
import { RemovalEvidence } from "./removal-evidence.ts";
import { SafetyLog } from "./safety-log.ts";

const ACCOUNT = "acct_1";
const SERVER = "0123456789abcdef0123456789abcdef";
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

interface Key { keys: CryptoKeyPair; spki: string }
async function key(): Promise<Key> {
  const keys = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
  return { keys, spki: await exportAccountKey(keys.publicKey) };
}

/** A PC in ACCOUNT with its real log, binding and journal, and the account rows attached to its device store. */
function pc(dir = mkdtempSync(join(tmpdir(), "s2-25-signin-")), admits?: (key: string, account: string) => boolean) {
  if (!dirs.includes(dir)) dirs.push(dir);
  const safety = SafetyLog.open(dir);
  const binding = PcAccountState.open(dir);
  const journal = DeviceJournal.open(dir, () => safety.ensureFile());
  const evidence = RemovalEvidence.open(dir, safety);
  const devices = new DeviceStore(dir, null, null, { safety, pc: binding, removals: evidence, journal });
  const clock = { now: Date.now() };
  const rows = new AccountDeviceStore(dir, SERVER, {
    evidence,
    ...listNotices(journal, evidence, (entry) => devices.publish(entry)),
    closeSessions: (id) => { devices.closeAccountSessions(id); },
    heldByDevicesJson: (candidate) => devices.hasKey(candidate),
    admits: admits ?? ((key, account) => devices.admitsFromList(key, account)),
    now: () => clock.now,
    admitOrigin: (at) => binding.admit("remote", "list", null, at),
    publish: entry => journal.openListedRows([entry.row]),
    firstDevice: { othersEver: () => binding.othersEver(), setOthersEver: () => binding.setOthersEver(), listKey: () => binding.first()?.list_key ?? null, otherRows: () => devices.list(null).length > 1 },
    admitListedRows: write => devices.admitListedRows(write),
  });
  devices.attachAccountRows(rows);
  return { devices, rows, clock, dir, evidence, journal, binding };
}

async function member(devices: DeviceStore): Promise<Key & { id: string }> {
  const k = await key();
  const id = devices.pairRelay(devices.startPairing().code, "Phone", k.spki)!.device.id;
  devices.linkAccountKey(id, k.spki, k.spki, ACCOUNT);
  return { ...k, id };
}

function listed(...keys: Key[]) {
  return { account: ACCOUNT, snapshot: "1".padStart(32, "0"), version: 1, devices: keys.map((k, index) => ({ key: k.spki, no: index + 10, label: `Device ${index}`, eligible: true })), removed: [] };
}

async function signIn(devices: DeviceStore, id: string, signer: Key, serverId = SERVER) {
  const nonce = crypto.getRandomValues(new Uint8Array(32));
  const message = Buffer.concat([Buffer.from("ovis-relay-auth/1"), nonce, Buffer.from(serverId)]);
  const signature = Buffer.from(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, signer.keys.privateKey, message)).toString("base64url");
  return devices.matchAccountRelay(id, nonce, signature, serverId);
}

test("T34: a list admission durably records its registering sign-in claims", async () => {
  const { devices, rows, dir } = pc();
  await member(devices);
  const phone = await key();
  const list = listed(phone);
  rows.commitList({ ...list, devices: list.devices.map((device) => ({ ...device, provider: "google", two_step: "set" } as const)) });
  const entry = DeviceJournal.open(dir).entries().find((record) => record.kind === "admit" && record.key === phone.spki);
  expect(entry).toMatchObject({ how: "list", provider: "google", two_step: "set" });
});

describe("S2-25 an account-joined row signs in by relay AUTH (S21, S25, T35)", () => {
  test("T38/T53: an established signer ends the hold during promotion, a recent signer cannot", async () => {
    for (const recent of [false, true]) {
      const { devices, rows, clock, journal } = pc();
      const elder = await member(devices);
      clock.now += 2 * 60 * 60_000;
      const junior = await key();
      const paired = devices.pairRelay(devices.startPairing(clock.now).code, "Junior", junior.spki, clock.now);
      if (!paired) throw new Error("Junior was not paired");
      devices.linkAccountKey(paired.device.id, junior.spki, junior.spki, ACCOUNT);
      const phone = await key();
      rows.commitList(listed(phone));
      const [row] = rows.rows();
      if (!row) throw new Error("Phone was not listed");
      const signer = recent ? junior : elder;
      const add = await signAccountRecord({ v: 1, kind: "add", account: ACCOUNT, key: phone.spki, label: "Phone", role: "watch", issued_at: new Date(clock.now).toISOString(), id: newRecordId(), signer: signer.spki }, signer.keys.privateKey);
      const [result] = await applyAccountRecords(devices, [add], SERVER, clock.now);
      expect(result).toMatchObject({ outcome: "applied" });
      expect(rows.row(row.id)).toBeNull();
      expect(journal.entries().at(-1)).toMatchObject({ kind: "promote", row: row.id, by: signer.spki });
      expect(devices.sessionRow(row.id)?.role ?? null).toBe(recent ? null : "watch");
    }
  });
  test("T53/H1: a proved local elder with a late or higher account number cannot decide", async () => {
    for (const mode of ["late", "higher", "lower"] as const) {
      const { devices, rows, clock, journal, dir } = pc();
      const owner = await member(devices);
      const phone = await key();
      clock.now += 2 * 60 * 60_000;
      const order = AccountOrder.open(dir);
      const list = listed(phone);
      if (mode === "late") order.record({ ...list, server_id: SERVER }, "binding");
      order.record({ ...list, server_id: SERVER, devices: [...list.devices, { key: owner.spki, no: mode === "higher" ? 11 : 1 }] }, "binding");
      devices.attachAccountOrder(order);
      rows.commitList(list);
      const notice = journal.openNotices().find((n) => n.key === phone.spki);
      if (!notice) throw new Error("Missing current admission");
      expect({ mode, ended: devices.itsMe(owner.id, notice.id, owner.spki) }).toEqual({ mode, ended: mode === "lower" });
    }
  });
  test("T53, P16: an account-joined sayer that a block froze cannot end a hold; unfrozen, it can", async () => {
    for (const frozen of [false, true]) {
      const { devices, rows, clock, journal } = pc(undefined, () => true); // Isolate the sayer: the target passes its independent final guard.
      const [older, target] = [await member(devices), await member(devices)];
      const sayer = await key();
      rows.commitList(listed(sayer));
      clock.now += 2 * 60 * 60_000;
      const [sayerRow] = rows.rows();
      expect(rows.access(sayerRow!.id)).toEqual({ ok: true });
      const phone = await key();
      rows.commitList({ ...listed(sayer, phone), snapshot: "2".padStart(32, "0"), version: 2 });
      const held = rows.rows().find((row) => row.key === phone.spki)!;
      const notice = journal.entries().find((entry) => entry.kind === "admit" && entry.row === held.id)!;
      if (frozen) {
        const block = await signSafetyRecord({ v: 1, kind: "block", account: ACCOUNT, target: target.spki, target_no: 2, signer: older.spki, signer_no: 1, signed_at: new Date().toISOString(), nonce: newRecordId() }, older.keys.privateKey) as BlockRecord;
        expect(await devices.applyBlock(block, "handed")).toMatchObject({ outcome: "applied" });
        expect(devices.sessionRow(sayerRow!.id)).toBeNull();
      }
      expect({ frozen, ended: devices.itsMe(sayerRow!.id, notice.id, sayer.spki) }).toEqual({ frozen, ended: !frozen });
    }
  });
  test("S25: a proved sign-in of a held row is refused with its reason, and a wrong key learns nothing", async () => {
    const { devices, rows } = pc();
    await member(devices);
    const phone = await key();
    rows.commitList(listed(phone));
    const [row] = rows.rows();
    expect(await signIn(devices, row!.id, phone)).toMatchObject({ refused: { refused: "join_hold", seconds: 10 } });
    expect(await signIn(devices, row!.id, await key())).toBeNull();
    expect(devices.sessionRow(row!.id)).toBeNull();
    expect(devices.has(row!.id)).toBe(true);
  });

  test("T34, G6: standing evidence alone keeps a key off the list before its tombstone is materialized", async () => {
    const { devices, rows, evidence } = pc();
    await member(devices);
    const phone = await key();
    evidence.addRemoval(phone.spki, ACCOUNT, { id: newRecordId(), at: "2026-11-01T00:00:00.000Z" });
    expect(devices.isTombstoned(phone.spki)).toBe(false);
    expect(rows.commitList(listed(phone)).admitted).toEqual([]);
    expect(rows.rowsByKey(phone.spki)).toEqual([]);
  });

  test("T35: a list drop reaches the row's revoke listeners through the device store, and the row is gone", async () => {
    const { devices, rows } = pc();
    await member(devices);
    const phone = await key();
    rows.commitList(listed(phone));
    const [row] = rows.rows();
    const closed: string[] = [];
    devices.onRevoke(row!.id, () => { closed.push(row!.id); });
    expect(closed).toEqual([]);
    rows.commitList({ ...listed(), snapshot: "2".padStart(32, "0"), version: 2 });
    expect(closed).toEqual([row!.id]);
    expect(devices.has(row!.id)).toBe(false);
    expect(await signIn(devices, row!.id, phone)).toBeNull();
  });

  test("T64: a block of an account-joined key ends its row and closes the sessions of the account rows it freezes, in the apply turn", async () => {
    const { devices, rows } = pc();
    const signer = await member(devices);
    const [target, newer] = [await key(), await key()];
    rows.commitList(listed(target, newer));
    const [targetRow, newerRow] = rows.rows();
    const closed: string[] = [];
    for (const row of [targetRow!, newerRow!]) devices.onRevoke(row.id, () => { closed.push(row.id); });
    devices.onRevoke(signer.id, () => { closed.push(signer.id); });
    const record = await signSafetyRecord({ v: 1, kind: "block", account: ACCOUNT, target: target.spki, target_no: 10, signer: signer.spki, signer_no: 1, signed_at: new Date().toISOString(), nonce: newRecordId() }, signer.keys.privateKey) as BlockRecord;
    expect(await devices.applyBlock(record, "handed")).toMatchObject({ outcome: "applied" });
    expect(closed.sort()).toEqual([targetRow!.id, newerRow!.id].sort());
    expect(rows.row(targetRow!.id)).toBeNull();
    expect(rows.row(newerRow!.id)).not.toBeNull();
    expect(devices.sessionRow(newerRow!.id)).toBeNull();
  });

  test("S25, P17, P21: a held signer cannot block; a live older signer can", async () => {
    const { devices, rows, clock, dir } = pc();
    await member(devices);
    const [signer, target] = [await key(), await key()];
    rows.commitList(listed(signer, target));
    const late = await member(devices);
    const block = (by: Key, of: string) => signSafetyRecord({ v: 1, kind: "block", account: ACCOUNT, target: of, target_no: 9, signer: by.spki, signer_no: 1, signed_at: new Date().toISOString(), nonce: newRecordId() }, by.keys.privateKey) as Promise<BlockRecord>;
    // the devices.json row that joined after both account rows cannot block the older account row
    expect(await devices.applyBlock(await block(late, signer.spki), "handed")).toMatchObject({ outcome: "refused", reason: "signer_not_older" });
    const signed = await block(signer, target.spki);
    expect((await devices.applyBlock(signed, "handed")).outcome).toBe("refused");
    expect(rows.rowsByKey(target.spki)).toHaveLength(1);
    clock.now += JOIN_HOLD_MS;
    expect(rows.access(accountDeviceId(SERVER, signer.spki))).toEqual({ ok: true });
    const restarted = pc(dir);
    expect(restarted.devices.accountSigner(signer.spki, ACCOUNT, true)).toBeNull();
    restarted.rows.commitList(listed(signer, target));
    expect((await restarted.devices.applyBlock(signed, "handed")).outcome).toBe("applied");
  });

  test("T36, P5: an account-joined key signs no remove of another key, newer or not; a devices.json member still may", async () => {
    const { devices, rows } = pc();
    const older = await member(devices);
    const [joined, newer] = [await key(), await key()];
    rows.commitList(listed(joined, newer));
    expect(devices.removeAuthority(joined.spki, newer.spki, ACCOUNT)).toBe(false);
    expect(devices.removeAuthority(joined.spki, joined.spki, ACCOUNT)).toBe(true);
    expect(devices.removeAuthority(older.spki, newer.spki, ACCOUNT)).toBe(true);
  });

  for (const [name, leave] of [
    ["binding clear", (devices: DeviceStore) => { devices.clearAccountBinding("unlisted", "account"); }],
    ["Revoke all", (devices: DeviceStore) => { devices.revokeAll(); }],
  ] as const) {
    test(`T44: ${name} ends every account row: its session closes and it is gone from the file, also after a restart`, async () => {
      const { devices, rows, dir } = pc();
      await member(devices);
      const phone = await key();
      rows.commitList(listed(phone));
      const [row] = rows.rows();
      const closed: string[] = [];
      devices.onRevoke(row!.id, () => { closed.push(row!.id); });
      leave(devices);
      expect(closed).toEqual([row!.id]);
      expect(rows.rows()).toEqual([]);
      expect((JSON.parse(readFileSync(join(dir, ACCOUNT_DEVICES_FILE), "utf8")) as { devices: unknown[] }).devices).toEqual([]);
    });
  }

  test("P5, S25, T36: a held account key's own signed leave applies on the records path and ends its row", async () => {
    const { devices, rows, dir } = pc();
    await member(devices);
    const phone = await key();
    rows.commitList(listed(phone));
    const [row] = rows.rows();
    expect(rows.access(row!.id)).toMatchObject({ refused: "join_hold" });
    const leave = await signAccountRecord({ v: 1, kind: "remove", account: ACCOUNT, key: phone.spki, issued_at: new Date().toISOString(), id: newRecordId(), signer: phone.spki }, phone.keys.privateKey);
    const [outcome] = await applyAccountRecords(devices, [leave], SERVER);
    expect(outcome).toMatchObject({ outcome: "applied" });
    expect(rows.rows()).toEqual([]);
    expect((JSON.parse(readFileSync(join(dir, ACCOUNT_DEVICES_FILE), "utf8")) as { devices: unknown[] }).devices).toEqual([]);
  });

  test("Rule B, T19, T36: every target row must have joined after every row of the caller's or signer's key", async () => {
    const { devices } = pc();
    const caller = await member(devices);
    const target = await member(devices);
    // a second row of the caller's key that joined after the target
    const later = devices.pairRelayApproved("Later", caller.spki, { path: "account", addedBy: caller.id });
    expect(later).not.toBeNull();
    expect(devices.remoteRevoke(caller.id, target.id)).toBe("older");
    expect(devices.removeAuthority(caller.spki, target.spki, ACCOUNT)).toBe(false);
  });

  test("T53: once its hold is over, the row signs in as a drive principal", async () => {
    const { devices, rows, clock } = pc();
    await member(devices);
    const phone = await key();
    rows.commitList(listed(phone));
    const [row] = rows.rows();
    clock.now += JOIN_HOLD_MS;
    expect(await signIn(devices, row!.id, phone)).toEqual({ match: { id: row!.id, label: "Device 0", role: "drive" } });
    expect(devices.sessionRow(row!.id)).toEqual({ role: "drive", key: phone.spki, provisional: false });
  });

  test("T66: a block that freezes the row ends its sign-in, before any stream", async () => {
    const { devices, rows, clock } = pc();
    const [older, target] = [await member(devices), await member(devices)];
    const phone = await key();
    rows.commitList(listed(phone));
    clock.now += JOIN_HOLD_MS;
    const [row] = rows.rows();
    expect(await signIn(devices, row!.id, phone)).toMatchObject({ match: { id: row!.id } });
    const record = await signSafetyRecord({ v: 1, kind: "block", account: ACCOUNT, target: target.spki, target_no: 2, signer: older.spki, signer_no: 1, signed_at: new Date().toISOString(), nonce: newRecordId() }, older.keys.privateKey) as BlockRecord;
    expect(await devices.applyBlock(record, "handed")).toMatchObject({ outcome: "applied" });
    expect(await signIn(devices, row!.id, phone)).toBeNull();
    expect(devices.sessionRow(row!.id)).toBeNull();
  });

  test("T53: It's me from a member admitted here over an hour ago ends the hold and decides the notice; a newer sayer cannot", async () => {
    const { devices, rows, clock, journal } = pc();
    const older = await member(devices);
    const phone = await key();
    clock.now += 2 * 60 * 60_000;
    rows.commitList(listed(phone));
    const [row] = rows.rows();
    const notice = journal.entries().find((entry) => entry.kind === "admit" && entry.row === row!.id)!;
    const newer = await member(devices);
    expect(devices.itsMe(newer.id, notice.id, newer.spki)).toBe(false);
    expect(devices.itsMe(older.id, notice.id, newer.spki)).toBe(false);
    expect(rows.access(row!.id)).toMatchObject({ refused: "join_hold" });
    expect(devices.itsMe(older.id, notice.id, older.spki)).toBe(true);
    expect(rows.access(row!.id)).toEqual({ ok: true });
    expect(journal.openNotices().some((entry) => entry.id === notice.id)).toBe(false);
    expect(journal.openNotices().filter((entry) => entry.row === row!.id)).toEqual([]);
    expect(journal.entries().at(-1)).toMatchObject({ kind: "confirm", how: "its_me", by: older.spki, row: row!.id });
  });

  test("T53/P15: a notice for an earlier admission cannot decide a readmitted row", async () => {
    const { devices, rows, clock, journal } = pc();
    const owner = await member(devices);
    const phone = await key();
    clock.now += 2 * 60 * 60_000;
    rows.commitList(listed(phone));
    const old = journal.openNotices().find((entry) => entry.key === phone.spki);
    if (!old) throw new Error("Missing first admission");
    rows.commitList(listed());
    rows.commitList(listed(phone));
    expect(devices.itsMe(owner.id, old.id, owner.spki)).toBe(false);
  });

  test("T54: a proved sign-in and each request of the row's session are the use this PC sees, written once a day", async () => {
    const { devices, rows, clock } = pc();
    await member(devices);
    const phone = await key();
    rows.commitList(listed(phone));
    clock.now += JOIN_HOLD_MS;
    const [row] = rows.rows();
    expect(rows.usedReport()).toEqual([]);
    expect(await signIn(devices, row!.id, phone)).toMatchObject({ match: { id: row!.id } });
    expect(rows.usedReport()).toEqual([{ key: phone.spki, day: new Date(clock.now).toISOString().slice(0, 10) }]);
    clock.now += 2 * 24 * 60 * 60_000;
    expect(devices.sessionRow(row!.id)).not.toBeNull();
    expect(rows.usedReport()).toEqual([{ key: phone.spki, day: new Date(clock.now).toISOString().slice(0, 10) }]);
  });

  test("T41, T53: a sayer whose own row still waits for the first whole read cannot end a hold", async () => {
    const { devices, rows, clock, journal, binding } = pc();
    const older = await member(devices);
    const gate = new CatchUpGate(() => binding.binding()?.bind_id ?? null);
    devices.attachCatchUp(gate);
    const phone = await key();
    clock.now += 2 * 60 * 60_000;
    rows.commitList(listed(phone));
    const [row] = rows.rows();
    const notice = journal.entries().find((entry) => entry.kind === "admit" && entry.row === row!.id)!;
    expect(devices.itsMe(older.id, notice.id, older.spki)).toBe(false);
    gate.wholeRead();
    expect(devices.itsMe(older.id, notice.id, older.spki)).toBe(true);
  });

  test("T39: a screen-approved admission of the same key replaces its account row, with no second row", async () => {
    const { devices, rows } = pc();
    await member(devices);
    const phone = await key();
    rows.commitList(listed(phone));
    const [row] = rows.rows();
    const closed: string[] = [];
    devices.onRevoke(row!.id, () => { closed.push(row!.id); });
    const redeemed = devices.redeemCode(devices.startPairing().code, "code", phone.spki);
    expect(redeemed).toMatchObject({ ok: true });
    const admitted = devices.admitConfirmed({ codeId: (redeemed as { codeId: string }).codeId, key: phone.spki, label: "Phone", source: "screen" });
    expect(admitted).not.toBeNull();
    expect(rows.rowsByKey(phone.spki)).toEqual([]);
    expect(closed).toEqual([row!.id]);
    expect(devices.sessionRow(admitted!.id)).toMatchObject({ key: phone.spki });
  });

  test("T38: a promotion that is not a screen approval keeps the account row's hold, and the row leaves its store", async () => {
    const { devices, rows } = pc();
    await member(devices);
    const phone = await key();
    rows.commitList(listed(phone));
    const [row] = rows.rows();
    const promoted = devices.pairRelay(devices.startPairing().code, "Phone", phone.spki);
    expect(promoted).not.toBeNull();
    expect(rows.rowsByKey(phone.spki)).toEqual([]);
    expect(devices.has(row!.id)).toBe(false);
    // held: no stream until the hold the account row had ends
    expect(devices.sessionRow(promoted!.device.id)).toBeNull();
  });
});
