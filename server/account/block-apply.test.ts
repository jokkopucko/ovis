import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exportAccountKey, newRecordId, signSafetyRecord, type BlockRecord } from "../../shared/account-records.ts";
import { DeviceStore } from "../devices.ts";
import { bounded, deferred } from "../relay/test-helpers.ts";
import { ADMISSION_FILE } from "./admission-order.ts";
import { DeviceJournal } from "./device-journal.ts";
import { PcAccountState } from "./pc-binding.ts";
import { RemovalEvidence } from "./removal-evidence.ts";
import { SafetyLog } from "./safety-log.ts";

const ACCOUNT = "acct_1";
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

interface Key { keys: CryptoKeyPair; spki: string }
async function key(): Promise<Key> {
  const keys = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
  return { keys, spki: await exportAccountKey(keys.publicKey) };
}

function open(dir: string): DeviceStore {
  const log = SafetyLog.open(dir);
  return new DeviceStore(dir, null, null, { safety: log, pc: PcAccountState.open(dir), removals: RemovalEvidence.open(dir, log), journal: DeviceJournal.open(dir, () => log.ensureFile()) });
}

function pc() {
  const dir = mkdtempSync(join(tmpdir(), "ovis-block-apply-"));
  dirs.push(dir);
  const devices = open(dir);
  const log = (devices as unknown as { safety: SafetyLog }).safety;
  return { dir, devices, log };
}

/** A drive member of the account here, admitted now: each one joins after the ones before it. */
async function member(devices: DeviceStore): Promise<Key & { id: string }> {
  const k = await key();
  const id = devices.pairRelay(devices.startPairing().code, "Phone", k.spki)!.device.id;
  devices.linkAccountKey(id, k.spki, k.spki, ACCOUNT);
  return { ...k, id };
}

async function migratedMembers() {
  const dir = mkdtempSync(join(tmpdir(), "ovis-block-migration-"));
  dirs.push(dir);
  const created = ["2026-10-01T00:00:00.000Z", "2026-10-02T00:00:00.000Z", "2026-10-03T00:00:00.000Z"];
  const [older, target, newer] = await Promise.all([key(), key(), key()]);
  const rows = [older, target, newer].map((member, index) => ({
    id: `legacy-${index}`, relay_public_key: member.spki, account: ACCOUNT, created_at: created[index],
    label: `Phone ${index}`, role: "drive", token_hash: String(index).repeat(64), last_seen_at: null,
  }));
  writeFileSync(join(dir, "devices.json"), JSON.stringify({ gate_closed_at: created[0], devices: rows }), { mode: 0o600 });
  return { dir, devices: open(dir), older, target, newer: { ...newer, id: "legacy-2" } };
}

/** "Not me" signed by `by` against `target`; the numbers are the record's claims, which the PC does not go by. */
const block = (target: string, by: Key, claims = { target_no: 9, signer_no: 1 }): Promise<BlockRecord> =>
  signSafetyRecord({ v: 1, kind: "block", account: ACCOUNT, target, ...claims, signer: by.spki, signed_at: new Date().toISOString(), nonce: newRecordId() }, by.keys.privateKey) as Promise<BlockRecord>;

const closes = (devices: DeviceStore, id: string) => {
  const seen = { closed: false };
  devices.onRevoke(id, () => { seen.closed = true; });
  return seen;
};

/** A relay sign-in of `row` as the session does it: the nonce signed with the row's key. */
async function signIn(devices: DeviceStore, row: Key & { id: string }, serverId = "0123456789abcdef0123456789abcdef") {
  const nonce = crypto.getRandomValues(new Uint8Array(32));
  const message = Buffer.concat([Buffer.from("ovis-relay-auth/1"), nonce, Buffer.from(serverId)]);
  const signature = Buffer.from(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, row.keys.privateKey, message)).toString("base64url");
  return devices.matchRelay(row.id, nonce, signature, serverId);
}

describe("blocks and freezes on the PC (P16, P21, T51)", () => {
  test("T51: a stored block receipt does not authenticate a different signature", async () => {
    const { devices } = pc();
    const signer = await member(devices);
    const target = await member(devices);
    const record = await block(target.spki, signer);
    expect(await devices.applyBlock(record, "handed")).toMatchObject({ outcome: "applied" });
    const other = await block(target.spki, signer);

    expect(await devices.applyBlock({ ...record, signature: other.signature }, "handed"))
      .toEqual({ outcome: "refused", id: record.id, reason: "record_invalid" });
  });

  test("T51: concurrent deliveries of one verified block share one receipt and one commit", async () => {
    const { devices, log } = pc();
    const signer = await member(devices);
    const target = await member(devices);
    const record = await block(target.spki, signer);
    const gen = devices.gen();
    const verifying = deferred<void>();
    const release = deferred<void>();
    const verify = crypto.subtle.verify.bind(crypto.subtle);
    let started = 0;
    const spy = spyOn(crypto.subtle, "verify").mockImplementation(async (...args) => {
      if (++started === 2) verifying.resolve();
      await release.promise;
      return verify(...args);
    });
    const delivered = Promise.all([devices.applyBlock(record, "handed"), devices.applyBlock(record, "mailbox")]);
    try {
      await bounded(verifying.promise, 1000);
      release.resolve();
      const receipt = { outcome: "applied", id: record.id, n: 1 } as const;
      expect(await delivered).toEqual([receipt, receipt]);
      expect(log.entries()).toHaveLength(1);
      expect(devices.gen()).toBe(gen + 1);
    } finally {
      release.resolve();
      spy.mockRestore();
      await delivered;
    }
  });

  test("P16: blocking the middle migrated row closes the newer relay session and refuses sign-in", async () => {
    const { dir, devices, older, target, newer } = await migratedMembers();
    expect(await signIn(devices, newer)).not.toBeNull();
    const session = closes(devices, newer.id);

    expect(await devices.applyBlock(await block(target.spki, older), "handed")).toMatchObject({ outcome: "applied" });

    expect([session.closed, await signIn(devices, newer)]).toEqual([true, null]);
    expect(await signIn(open(dir), newer)).toBeNull();
  });

  test("P23: an older migrated signer remains eligible after blocking a newer migrated key", async () => {
    const { devices, older, target } = await migratedMembers();
    expect(devices.admits(older.spki)).toBe(true);

    expect(await devices.applyBlock(await block(target.spki, older), "handed")).toMatchObject({ outcome: "applied" });

    expect(devices.admits(older.spki)).toBe(true);
  });

  test("P16: a newer key confirmed on the PC screen keeps its session and admission", async () => {
    const { devices } = pc();
    const [older, target] = [await member(devices), await member(devices)];
    const screen = await key();
    const reserved = devices.redeemCode(devices.startPairing().code, "code", screen.spki);
    if (!reserved.ok) throw new Error(`Code reservation failed: ${reserved.reason}`);
    const row = devices.admitConfirmed({ codeId: reserved.codeId, key: screen.spki, label: "Screen", source: "screen" });
    if (row === null) throw new Error("Screen confirmation failed");
    const session = closes(devices, row.id);
    expect(await signIn(devices, { ...screen, id: row.id })).not.toBeNull();

    expect(await devices.applyBlock(await block(target.spki, older), "handed")).toMatchObject({ outcome: "applied" });

    expect([session.closed, devices.admits(screen.spki)]).toEqual([false, true]);
    expect(await signIn(devices, { ...screen, id: row.id })).not.toBeNull();
  });

  test("P8: a failed generation write refuses the block and its retry while strict", async () => {
    const { dir, devices } = pc();
    const [older, target, newer] = [await member(devices), await member(devices), await member(devices)];
    const record = await block(target.spki, older);
    const sessions = [closes(devices, target.id), closes(devices, newer.id)];
    const generation = devices.gen();
    const path = join(dir, ADMISSION_FILE);
    renameSync(path, `${path}.saved`);
    mkdirSync(path);

    const receipt = await devices.applyBlock(record, "handed");

    expect(receipt).toMatchObject({ outcome: "refused", id: record.id });
    expect(devices.gen()).toBe(generation);
    expect(devices.failsClosed).toBe(true);
    expect(devices.sessionRow(older.id)).toBeNull();
    expect(sessions.map((session) => session.closed)).toEqual([true, true]);
    expect(await devices.applyBlock(record, "mailbox")).toMatchObject({ outcome: "refused", id: record.id });

    rmSync(path, { recursive: true });
    renameSync(`${path}.saved`, path);
    const reopened = open(dir);
    expect(await reopened.applyBlock(record, "mailbox")).toMatchObject({ outcome: "applied", id: record.id });
    expect(reopened.gen()).toBe(generation + 1);
  });

  test("T51: one verified block marks the target and freezes only eligible newer rows without locking", async () => {
    const { devices, log } = pc();
    const [older, target, newer] = [await member(devices), await member(devices), await member(devices)];
    const sessions = { target: closes(devices, target.id), newer: closes(devices, newer.id), older: closes(devices, older.id) };
    const record = await block(target.spki, older);
    expect(await devices.applyBlock(record, "handed")).toEqual({ outcome: "applied", id: record.id, n: 1 });
    // the target is out and marked; the newer row is frozen in place, its sessions ended; the older row is untouched
    expect(devices.has(target.id)).toBe(false);
    expect(devices.removedByAccount(target.spki)).toBe(true);
    expect(devices.has(newer.id)).toBe(true);
    expect(sessions).toEqual({ target: { closed: true }, newer: { closed: true }, older: { closed: false } });
    expect(await signIn(devices, newer)).toBeNull();
    expect(await signIn(devices, older)).not.toBeNull();
    // closed to every key newer than the target, never locked
    expect(log.state().locked).toBe(false);
    expect(devices.admits((await key()).spki)).toBe(false);
    expect(devices.admits(older.spki)).toBe(true);
    // the same block again is the same receipt
    expect(await devices.applyBlock(record, "mailbox")).toEqual({ outcome: "applied", id: record.id, n: 1 });
  });

  test("T51: an older or ambiguous duplicate prevents the entire unauthorized operation", async () => {
    const { devices, log } = pc();
    const target = await key();
    const first = devices.pairRelay(devices.startPairing().code, "Old", target.spki)!.device.id;
    devices.linkAccountKey(first, target.spki, target.spki, ACCOUNT);
    const signer = await member(devices);
    // a second row of the same key that joined after the signer: one row of it is older, so nothing applies
    const second = devices.pairRelayApproved("New", target.spki, { path: "account", addedBy: signer.id });
    expect(second).not.toBeNull();
    expect(await devices.applyBlock(await block(target.spki, signer), "handed")).toMatchObject({ outcome: "refused", reason: "signer_not_older" });
    expect(log.entries()).toHaveLength(0);
    expect(devices.has(first) && devices.has(second!.device.id)).toBe(true);

    // a block that claims the signer is first in the account, from a key that joined this PC after its target
    const victim = await member(devices);
    const late = await member(devices);
    expect(await devices.applyBlock(await block(victim.spki, late, { target_no: 99, signer_no: 1 }), "handed")).toMatchObject({ outcome: "refused", reason: "signer_not_older" });
    expect(devices.has(victim.id)).toBe(true);
    // a signer that is no member here, and a forged signature, are refused too, with nothing written
    expect(await devices.applyBlock(await block(victim.spki, await key()), "handed")).toMatchObject({ outcome: "refused", reason: "signer_not_member" });
    const forged = { ...(await block(late.spki, victim)), signature: (await block(late.spki, victim)).signature };
    expect(await devices.applyBlock(forged, "handed")).toMatchObject({ outcome: "refused", reason: "record_invalid" });
    expect(log.entries()).toHaveLength(0);
  });

  test("T64: both row types lose affected streams in the apply turn even if a registry write fails", async () => {
    const { dir, devices } = pc();
    const [older, target] = [await member(devices), await member(devices)];
    const added = devices.pairRelayApproved("Added", (await key()).spki, { path: "account", addedBy: older.id })!.device.id;
    const sessions = { target: closes(devices, target.id), added: closes(devices, added) };
    rmSync(join(dir, "devices.json"));
    mkdirSync(join(dir, "devices.json"));
    const record = await block(target.spki, older);
    // the deny is on disk: the receipt stands, and every affected stream ended in that turn
    expect(await devices.applyBlock(record, "handed")).toMatchObject({ outcome: "applied", id: record.id });
    expect(sessions).toEqual({ target: { closed: true }, added: { closed: true } });
    expect(devices.sessionRow(target.id)).toBeNull();
    expect(devices.sessionRow(added)).toBeNull();
  });

  test("T66: a pre-admission block stales the staged read or sign-in before a stream opens", async () => {
    const { devices } = pc();
    const [older, target] = [await member(devices), await member(devices)];
    // the target's sign-in is being verified when the block applies
    const verify = crypto.subtle.verify.bind(crypto.subtle);
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const spy = spyOn(crypto.subtle, "verify").mockImplementation(async (algorithm, publicKey, signature, data) => {
      const message = Buffer.from(data as ArrayBuffer);
      if (message.subarray(0, 17).toString() === "ovis-relay-auth/1") await held;
      return verify(algorithm, publicKey, signature, data);
    });
    try {
      const pending = signIn(devices, target);
      expect(await devices.applyBlock(await block(target.spki, older), "handed")).toMatchObject({ outcome: "applied" });
      release();
      expect(await pending).toBeNull();
    } finally { spy.mockRestore(); }
  });

  test("S22: a frozen cookie row signs in nowhere", async () => {
    const { devices } = pc();
    const [older, target] = [await member(devices), await member(devices)];
    const laptop = devices.pair(devices.startPairing().code, "Laptop", "drive")!;
    devices.match(laptop.token);
    expect(devices.match(laptop.token)).not.toBeNull();
    expect(await devices.applyBlock(await block(target.spki, older), "handed")).toMatchObject({ outcome: "applied" });
    // the laptop joined after the target: frozen in place, and its cookie opens nothing
    expect(devices.has(laptop.device.id)).toBe(true);
    expect(devices.match(laptop.token)).toBeNull();
  });

  test("P24: a block in the log whose marker was never written still denies its target after a restart", async () => {
    const { dir, devices, log } = pc();
    const [older, target] = [await member(devices), await member(devices)];
    // the stop between the append and the marker: the block is in the log, nothing else was written
    const record = await block(target.spki, older);
    log.append({ record, got: "handed", asof: { signer_no: 1, target_no: 2, after: 2, joined: 2, signer_removed: false } });
    const reopened = open(dir);
    expect(reopened.removedByAccount(target.spki)).toBe(true);
    expect(reopened.has(target.id)).toBe(false);
  });
});

