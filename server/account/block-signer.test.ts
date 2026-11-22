import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { accountDeviceId, exportAccountKey, newRecordId, signAccountRecord, signSafetyRecord, type BlockRecord, type SafetyRecord } from "../../shared/account-records.ts";
import { signPairProof } from "../../shared/pair-fingerprint.ts";
import { FrameType, KEY_PROOF_FEATURE } from "../../shared/relay-mux.ts";
import { DeviceStore } from "../devices.ts";
import { privateStateFs } from "../private-state.ts";
import { loadRelayIdentity } from "../relay/identity.ts";
import { bounded, deferred, relayConnection, relayDevice, relayFixture } from "../relay/test-helpers.ts";
import { DeviceJournal } from "./device-journal.ts";
import { memberSnapshotPc } from "./listed-pc.test-helpers.ts";
import { AccountHolds } from "./holds.ts";
import { AccountMailbox } from "./mailbox.ts";
import { PcAccountState } from "./pc-binding.ts";
import { applyAccountRecords } from "./records.ts";
import { RemovalEvidence } from "./removal-evidence.ts";
import { pcRecordId, SAFETY_LOG_FILE, SAFETY_OVERFLOW_FILE, SafetyLog, WAITING_MAX } from "./safety-log.ts";

const ACCOUNT = "acct_1";
const SERVER = "0123456789abcdef0123456789abcdef";
const dirs: string[] = [];
const fixtures: ReturnType<typeof relayFixture>[] = [];
afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

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
  const dir = mkdtempSync(join(tmpdir(), "ovis-block-signer-"));
  dirs.push(dir);
  return { dir, ...open(dir) };
}

async function paired(devices: DeviceStore): Promise<Key & { id: string }> {
  const k = await key();
  const pairing = devices.pairRelay(devices.startPairing().code, "Phone", k.spki);
  if (pairing === null) throw new Error("Fixture pairing was refused");
  return { ...k, id: pairing.device.id };
}

async function member(devices: DeviceStore): Promise<Key & { id: string }> {
  const k = await paired(devices);
  devices.linkAccountKey(k.id, k.spki, k.spki, ACCOUNT);
  return k;
}

const block = (target: string, by: Key): Promise<BlockRecord> =>
  signSafetyRecord({ v: 1, kind: "block", account: ACCOUNT, target, target_no: 9, signer: by.spki, signer_no: 1, signed_at: new Date().toISOString(), nonce: newRecordId() }, by.keys.privateKey) as Promise<BlockRecord>;
const lift = (blockId: string, by: Key): Promise<SafetyRecord> =>
  signSafetyRecord({ v: 1, kind: "lift", account: ACCOUNT, target: blockId, signer: by.spki, signer_no: 1, signed_at: new Date().toISOString() }, by.keys.privateKey);

const remove = (target: string, by: Key) =>
  signAccountRecord({ v: 1, kind: "remove", account: ACCOUNT, key: target, issued_at: new Date().toISOString(), id: newRecordId(), signer: by.spki }, by.keys.privateKey);

const blocksInForce = (log: SafetyLog) => log.state().blocks.map((entry) => entry.record.id);

describe("a block holds only while its signer is a member here (P16, P19, T73)", () => {
  test("T17: only an authorized waiting remove can hold a key and a full queue cannot gate the list", async () => {
    const { dir, devices } = pc();
    await member(devices);
    const [k, own, stranger] = [await key(), await key(), await key()];
    // a remove of another key from a signer that is no member here, and one a key signed of itself, both waiting
    writeFileSync(join(dir, "account-pending.json"), JSON.stringify([await remove(k.spki, stranger), await remove(own.spki, own)]), { mode: 0o600 });
    const holds = new AccountHolds({ heldPath: join(dir, "account-held.json") });
    const mailbox = new AccountMailbox({ devices, identity: () => undefined, service: "https://account.test", pendingPath: join(dir, "account-pending.json"), holds });
    expect(mailbox.gates().held(k.spki)).toBe(false);
    expect(mailbox.gates().held(own.spki)).toBe(true);
    // a queue that overflowed holds every add back, but never the account's list
    holds.overflow();
    expect(mailbox.gates().held(k.spki)).toBe(true);
    expect(mailbox.listHeld(k.spki)).toBe(false);
    expect(mailbox.listHeld(own.spki)).toBe(true);
  });

  test("P19, T36: a waiting removal survives an unrelated Revoke and applies when its signer joins", async () => {
    const { dir, devices } = pc();
    const signer = await paired(devices);
    const target = await member(devices);
    const unrelated = await member(devices);
    const identity = loadRelayIdentity(dir);
    const mailbox = new AccountMailbox({ devices, identity: () => identity, service: "https://account.test", pendingPath: join(dir, "account-pending.json") });
    const removal = await remove(target.spki, signer);
    expect(await applyAccountRecords(devices, [removal], identity.server_id, Date.now(), mailbox.gates(), (record) => mailbox.wait(record)))
      .toEqual([{ id: removal.id, outcome: "refused", code: "signer_not_member" }]);
    expect(devices.revoke(unrelated.id)).toBe(true);

    expect(devices.linkAccountKey(signer.id, signer.spki, signer.spki, ACCOUNT)).not.toBeNull();
    expect(await mailbox.settle()).toBe(1);
    expect(devices.has(target.id)).toBe(false);
  });

  test("P21, T36: a waiting removal whose signer joins after its target is refused, not kept", async () => {
    const { dir, devices } = pc();
    const target = await member(devices);
    const signer = await key();
    const identity = loadRelayIdentity(dir);
    const pendingPath = join(dir, "account-pending.json");
    const mailbox = new AccountMailbox({ devices, identity: () => identity, service: "https://account.test", pendingPath });
    const removal = await remove(target.spki, signer);
    expect(await applyAccountRecords(devices, [removal], identity.server_id, Date.now(), mailbox.gates(), (record) => mailbox.wait(record)))
      .toEqual([{ id: removal.id, outcome: "refused", code: "signer_not_member" }]);

    const pairing = devices.pairRelay(devices.startPairing().code, "Signer", signer.spki);
    if (pairing === null) throw new Error("Fixture pairing was refused");
    expect(devices.linkAccountKey(pairing.device.id, signer.spki, signer.spki, ACCOUNT)).not.toBeNull();
    expect(mailbox.waitingRemoveKeys()).toEqual([target.spki]);
    expect(await applyAccountRecords(devices, [removal], identity.server_id, Date.now(), mailbox.gates()))
      .toEqual([{ id: removal.id, outcome: "refused", code: "older_device" }]);

    expect(await mailbox.settle()).toBe(0);
    expect(devices.has(target.id)).toBe(true);
    expect(mailbox.waitingRemoveKeys()).toEqual([]);
    expect(JSON.parse(readFileSync(pendingPath, "utf8"))).toEqual([]);
  });

  test("P19, T36: revoking the signer discards its pending removal (T18)", async () => {
    const { dir, devices } = pc();
    const signer = await member(devices);
    const k = await key();
    const pendingPath = join(dir, "account-pending.json");
    const mailbox = new AccountMailbox({ devices, identity: () => undefined, service: "https://account.test", pendingPath });
    expect(mailbox.wait(await remove(k.spki, signer))).toBe(true);
    expect(mailbox.listHeld(k.spki)).toBe(true);
    expect(devices.revoke(signer.id)).toBe(true);
    expect(mailbox.listHeld(k.spki)).toBe(false);
    expect(mailbox.waitingRemoveKeys()).toEqual([]);
    expect(JSON.parse(readFileSync(pendingPath, "utf8"))).toEqual([]);
  });

  test("P19, T36: removing the signer during retry discards its draining removal only", async () => {
    const { dir, devices } = pc();
    const revoker = await member(devices);
    const signer = await member(devices);
    const target = await member(devices);
    const absent = await key();
    const identity = loadRelayIdentity(dir);
    const pendingPath = join(dir, "account-pending.json");
    const mailbox = new AccountMailbox({ devices, identity: () => identity, service: "https://account.test", pendingPath });
    const unrelated = await remove(target.spki, absent);
    expect(mailbox.wait(await remove(signer.spki, revoker))).toBe(true);
    expect(mailbox.wait(await remove(target.spki, signer))).toBe(true);
    expect(mailbox.wait(unrelated)).toBe(true);

    expect(await mailbox.settle()).toBe(1);
    expect(devices.has(signer.id)).toBe(false);
    expect(devices.has(target.id)).toBe(true);
    expect(JSON.parse(readFileSync(pendingPath, "utf8"))).toEqual([unrelated]);
  });

  test("P19: a waiting block write failure makes the safety log strict", async () => {
    const { dir, log } = pc();
    log.ensureFile();
    const record = await block((await key()).spki, await key());
    const rename = privateStateFs.renameSync;
    const eio = new Error("simulated EIO");
    privateStateFs.renameSync = (from, to) => {
      if (to === join(dir, SAFETY_LOG_FILE)) throw eio;
      return rename(from, to);
    };
    try {
      log.wait({ record, got: "mailbox", signer_removed: false });
    } catch (error) {
      if (error !== eio) throw error;
    } finally {
      privateStateFs.renameSync = rename;
    }
    expect(log.strict).not.toBeNull();
  });

  test("P19, S19: a full waiting queue fails the PC closed across a restart", async () => {
    const { dir, devices, log } = pc();
    const signer = await member(devices);
    const absent = await key();
    for (let i = 0; i < WAITING_MAX; i += 1) {
      const record = await block(absent.spki, signer);
      expect(log.wait({ record, got: "mailbox", signer_removed: false })).toBe(true);
    }
    expect(log.waitingBlocks()).toHaveLength(WAITING_MAX);
    expect(devices.failsClosed).toBe(false);

    const overflow = await block((await key()).spki, signer);
    expect(await devices.applyBlock(overflow, "mailbox")).toEqual({ outcome: "refused", id: overflow.id, reason: "record_invalid" });
    expect(devices.failsClosed).toBe(true);

    log.close();
    const reopened = open(dir);
    try {
      expect(reopened.devices.failsClosed).toBe(true);
      expect(reopened.log.strict).not.toBeNull();
    } finally {
      reopened.log.close();
    }
  });

  test("T51: a pairing whose row a waiting block removes still spends its code", async () => {
    const { devices, log } = pc();
    const signer = await member(devices);
    const target = await key();
    const record = await block(target.spki, signer);
    expect(log.wait({ record, got: "mailbox", signer_removed: false })).toBe(true);
    const { code } = devices.startPairing();

    expect(devices.pairRelay(code, "Joining", target.spki)).toBeNull();
    expect(log.receipt(record.id)).toMatchObject({ outcome: "applied" });
    expect(devices.pairingId()).toBeNull();
  });

  test("T51: a queued block rechecks the signer at apply and writes nothing if it was removed", async () => {
    const { devices, log } = pc();
    const signer = await member(devices);
    const later = await key();
    // the target is not here yet: the block waits and ends nobody
    const record = await block(later.spki, signer);
    expect(await devices.applyBlock(record, "mailbox")).toMatchObject({ outcome: "refused", reason: "unknown_target" });
    expect(log.waitingBlocks().map((waiting) => waiting.record.id)).toEqual([record.id]);
    expect(log.entries()).toHaveLength(0);
    // its signer is removed here before the target appears: applying the queue writes nothing and empties it
    devices.revoke(signer.id);
    const target = devices.pairRelayApproved("Later", later.spki, { path: "code" });
    expect(log.state().blocks).toHaveLength(0);
    expect(log.waitingBlocks()).toHaveLength(0);
    expect(target).not.toBeNull();
    expect(devices.hasKey(later.spki)).toBe(true);
  });

  test.each(["relay pairing", "account add", "startup"] as const)("T51: %s applies a waiting block before relay sign-in", async (path) => {
    const stateDir = mkdtempSync(join(tmpdir(), "ovis-waiting-relay-"));
    dirs.push(stateDir);
    const target = await key();
    const id = accountDeviceId(SERVER, target.spki);
    let queued: BlockRecord | undefined;
    if (path === "startup") {
      const { devices, log } = open(stateDir);
      const signer = await member(devices);
      expect(devices.pairRelayApproved("Joining", target.spki, { path: "code", id })).not.toBeNull();
      queued = await block(target.spki, signer);
      // P19: startup can find the row and the waiting block together after a merge.
      expect(log.wait({ record: queued, got: "mailbox", signer_removed: false })).toBe(true);
    }
    const screen = new TransformStream<Uint8Array>();
    const { fixture, firstRead } = memberSnapshotPc({
      stateDir,
      ...(path === "relay pairing" ? { platform: "linux", desktopOwner: { input: screen.readable, write() {} } } : {}),
    });
    fixtures.push(fixture);
    const { devices, safetyLog } = fixture.app.context.services;
    if (path !== "startup") {
      const signer = await relayDevice(fixture);
      devices.linkAccountKey(signer.id, signer.publicKey, signer.publicKey, ACCOUNT);
      await firstRead();
      queued = await block(target.spki, { keys: signer.keys, spki: signer.publicKey });
      expect(await devices.applyBlock(queued, "mailbox")).toMatchObject({ outcome: "refused", reason: "unknown_target" });
      if (path === "account add") {
        const add = await signAccountRecord({ v: 1, kind: "add", account: ACCOUNT, key: target.spki, label: "Joining", role: "drive", id: newRecordId(), issued_at: new Date().toISOString(), signer: signer.publicKey }, signer.keys.privateKey);
        await applyAccountRecords(devices, [add], SERVER);
      }
    }
    const link = await relayConnection(fixture);
    let signIn: Promise<"auth_ok">;
    if (path === "relay pairing") {
      const challenge = deferred<string>();
      const pending = deferred<void>();
      const authenticated = deferred<"auth_ok">();
      link.onFrame = (frame) => {
        if (frame.type === FrameType.KEY_CHALLENGE) challenge.resolve(frame.payload.challenge);
        if (frame.type === FrameType.KEY_PENDING) pending.resolve();
        if (frame.type === FrameType.AUTH_OK) authenticated.resolve("auth_ok");
      };
      await link.hello([KEY_PROOF_FEATURE]);
      link.mux.sendSession({ type: FrameType.PAIR, flags: 0, stream_id: 0, payload: {
        code: devices.startPairing().code, label: "Joining", public_key: target.spki,
      } });
      const signature = await signPairProof(SERVER, await bounded(challenge.promise), target.spki, target.keys.privateKey);
      link.mux.sendSession({ type: FrameType.KEY_PROVE, flags: 0, stream_id: 0, payload: { signature } });
      await bounded(pending.promise);
      // The waiting block needs the target's row; approve the proved key so enrollment reaches it.
      const prompt = fixture.app.context.services.localConfirms?.pending().find(({ action }) => action.kind === "approve_key");
      if (!prompt) throw new Error("The proved key did not reach the PC screen");
      const writer = screen.writable.getWriter();
      await writer.write(new TextEncoder().encode(`${JSON.stringify({ approve: prompt.id })}\n`));
      writer.releaseLock();
      signIn = authenticated.promise;
    } else {
      signIn = link.auth({ id, keys: target.keys, publicKey: target.spki }).then(() => "auth_ok");
    }
    expect(await bounded(Promise.race([link.serverError, signIn]))).toBe("auth_failed");
    if (!queued || !safetyLog) throw new Error("Waiting block fixture did not initialize");
    expect(safetyLog.receipt(queued.id)).toMatchObject({ outcome: "applied" });
    expect(safetyLog.waitingBlocks()).toEqual([]);
  });

  test("T73, S29: a blocked start lifts nothing at load, though a block's signer is no member here", async () => {
    const { dir, devices, log } = pc();
    const [signer, target] = [await member(devices), await member(devices)];
    const record = await block(target.spki, signer);
    await devices.applyBlock(record, "handed");
    // the signer's row goes without the store, as a merge from another folder would take it
    const registry = JSON.parse(readFileSync(join(dir, "devices.json"), "utf8")) as { devices: { id: string }[] };
    writeFileSync(join(dir, "devices.json"), JSON.stringify({ ...registry, devices: registry.devices.filter((d) => d.id !== signer.id) }), { mode: 0o600 });
    const before = readFileSync(join(dir, "account-log.json"), "utf8");
    const reopened = SafetyLog.open(dir);
    new DeviceStore(dir, "the order is damaged", null, { safety: reopened, pc: PcAccountState.open(dir), removals: RemovalEvidence.open(dir, reopened), journal: DeviceJournal.open(dir, () => reopened.ensureFile()) });
    expect(readFileSync(join(dir, "account-log.json"), "utf8")).toBe(before);
    expect(blocksInForce(log)).toEqual([record.id]);
  });

  test("T73: local signer removal appends durable lifts while markers, local Revokes and locks survive", async () => {
    const { dir, devices, log } = pc();
    const [signer, target, revoked] = [await member(devices), await member(devices), await member(devices)];
    devices.revoke(revoked.id);
    const lock = { v: 1, id: pcRecordId(), kind: "lock", account: ACCOUNT, target: null, signer: "pc", signed_at: new Date().toISOString(), signature: "" } as SafetyRecord;
    log.append({ record: lock, got: "pc" });
    const record = await block(target.spki, signer);
    expect(await devices.applyBlock(record, "handed")).toMatchObject({ outcome: "applied" });
    expect(blocksInForce(log)).toEqual([record.id]);
    devices.revoke(signer.id);
    // the block and its freeze end by a lift the PC wrote; the target stays removed, the Revoke and the lock stand
    expect(blocksInForce(log)).toEqual([]);
    expect(log.entries().some((entry) => entry.record.kind === "lift" && entry.record.target === record.id && entry.record.signer === "pc")).toBe(true);
    expect(devices.removedByAccount(target.spki)).toBe(true);
    expect(devices.isTombstoned(revoked.spki)).toBe(true);
    expect(log.state().locked).toBe(true);
    // durable: a restart keeps it lifted
    expect(blocksInForce(open(dir).log)).toEqual([]);
  });

  test("T73, seam for S2-27: every lift is heard with its target key and its cause, once it is on disk", async () => {
    const { devices, log } = pc();
    const heard: [string, string][] = [];
    devices.onLifted((target, cause) => heard.push([target, cause]));
    const [signer, target] = [await member(devices), await member(devices)];
    const record = await block(target.spki, signer);
    await devices.applyBlock(record, "handed");
    devices.revoke(signer.id);
    expect(heard).toEqual([[target.spki, "orphan"]]);
    expect(log.entries().some((entry) => entry.record.kind === "lift" && entry.record.target === record.id)).toBe(true);
  });

  test("T73: later signer reentry never changes those local endings", async () => {
    const { dir, devices, log } = pc();
    const [signer, target] = [await member(devices), await member(devices)];
    const record = await block(target.spki, signer);
    await devices.applyBlock(record, "handed");
    devices.revoke(signer.id);
    // the signer pairs here again: what was lifted stays lifted, and the target stays out
    devices.pairRelay(devices.startPairing().code, "Back", signer.spki);
    expect(blocksInForce(log)).toEqual([]);
    expect(devices.removedByAccount(target.spki)).toBe(true);
    // a start re-reads the same endings; nothing of the service takes part
    const reopened = open(dir);
    expect(blocksInForce(reopened.log)).toEqual([]);
    expect(reopened.devices.removedByAccount(target.spki)).toBe(true);
  });

  test("T73: startup preserves a block when its signer row is missing without a removal", async () => {
    const { dir, devices, log } = pc();
    const [signer, target] = [await member(devices), await member(devices)];
    const record = await block(target.spki, signer);
    await devices.applyBlock(record, "handed");
    const rows = JSON.parse(readFileSync(join(dir, "devices.json"), "utf8")) as { devices: { id: string }[] };
    writeFileSync(join(dir, "devices.json"), JSON.stringify({ ...rows, devices: rows.devices.filter((row) => row.id !== signer.id) }), { mode: 0o600 });
    const reopened = open(dir);
    expect(blocksInForce(reopened.log)).toEqual([record.id]);
    expect(reopened.log.state().freezes.map((entry) => entry.record.id)).toEqual([record.id]);
    expect(reopened.log.entries()).toEqual(log.entries());
  });

  test("T73: a signed account removal lifts only blocks of the key removed here", async () => {
    const { devices, log } = pc();
    const [signer, target] = [await member(devices), await member(devices)];
    const local = await block(target.spki, signer);
    expect(await devices.applyBlock(local, "handed")).toMatchObject({ outcome: "applied" });
    const service = await block((await key()).spki, await key());
    // the service block freezes nobody here: every row joined before its cutoff (S2-09 refuses a freeze of unknown age)
    expect(log.append({ record: service, got: "snapshot", asof: { signer_no: null, target_no: 1000, after: 1000, joined: 1000, signer_removed: false } }).outcome).toBe("applied");
    const removal = await signAccountRecord({ v: 1, kind: "remove", account: ACCOUNT, key: signer.spki, id: newRecordId(), issued_at: new Date().toISOString(), signer: signer.spki }, signer.keys.privateKey);
    expect(await applyAccountRecords(devices, [removal], SERVER)).toEqual([{ id: removal.id, outcome: "applied" }]);
    expect(blocksInForce(log)).toEqual([service.id]);
  });

  test("P23: Revoke all ends no standing block or freeze and emits no lift", async () => {
    const { devices, log } = pc();
    const [signer, target] = [await member(devices), await member(devices)];
    const record = await block(target.spki, signer);
    expect(await devices.applyBlock(record, "handed")).toMatchObject({ outcome: "applied" });
    const heard: string[] = [];
    devices.onLifted((key) => heard.push(key));
    expect(devices.revokeAll()).toContain(signer.id);
    expect([blocksInForce(log), log.state().freezes.map((entry) => entry.record.id), heard]).toEqual([[record.id], [record.id], []]);
  });

  test("P23: a device lift counts only from a signer older here than the blocked key", async () => {
    const { devices } = pc();
    const [older, target, newer] = [await member(devices), await member(devices), await member(devices)];
    const record = await block(target.spki, older);
    await devices.applyBlock(record, "handed");
    expect(await devices.liftAuthority(await lift(record.id, older))).toBe(true);
    expect(await devices.liftAuthority(await lift(record.id, newer))).toBe(false);
    expect(await devices.liftAuthority(await lift(record.id, await key()))).toBe(false);
    const forged = { ...(await lift(record.id, older)), signature: (await lift(record.id, newer)).signature };
    expect(await devices.liftAuthority(forged)).toBe(false);
    // a signer admitted after the block came is late (T52): its row is newer than the blocked key, so it lifts nothing
    const late = await key();
    const lateRow = devices.pairRelay(devices.startPairing().code, "Late", late.spki, Date.now(), () => true);
    expect(lateRow).toBeNull();
    expect(await devices.liftAuthority(await lift(record.id, late))).toBe(false);
  });

  test("P23: a lift gives no authority when this PC has no admission number for its signer or its target", async () => {
    const { devices, log } = pc();
    const [signer, target] = [await member(devices), await member(devices)];
    // a block whose target has no number here (joined unknown): no lift ends it
    const unknownTarget = await block(target.spki, signer);
    log.append({ record: unknownTarget, got: "handed", asof: { signer_no: null, target_no: null, after: null, joined: null, signer_removed: false } });
    expect(await devices.liftAuthority(await lift(unknownTarget.id, signer))).toBe(false);
    // a signer whose row has no origin here, however old its row is
    const other = pc();
    const [s2, t2] = [await member(other.devices), await member(other.devices)];
    const record = await block(t2.spki, s2);
    await other.devices.applyBlock(record, "handed");
    (other.devices as unknown as { devices: { id: string; origin?: unknown }[] }).devices.find((row) => row.id === s2.id)!.origin = undefined;
    expect(await other.devices.liftAuthority(await lift(record.id, s2))).toBe(false);
  });

  test("P23: a lift from a key with no member row here, of a block whose target has no number here, lifts nothing", async () => {
    const { devices, log } = pc();
    const [stranger, target] = [await key(), await key()];
    const record = await block(target.spki, stranger);
    log.append({ record, got: "handed", asof: { signer_no: null, target_no: null, after: null, joined: null, signer_removed: false } });
    expect(await devices.liftAuthority(await lift(record.id, stranger))).toBe(false);
  });

  test("T51, seam for S2-25: rows a list commit writes stand only if no waiting block takes them", async () => {
    const { devices, log } = pc();
    const signer = await member(devices);
    const target = await key();
    const other = await key();
    const queued = await block(target.spki, signer);
    expect(log.wait({ record: queued, got: "mailbox", signer_removed: false })).toBe(true);
    const ids = [accountDeviceId(SERVER, target.spki), accountDeviceId(SERVER, other.spki)];
    const standing = devices.admitListedRows(() => {
      // the other row joins first: a block freezes the rows newer than its target
      devices.pairRelayApproved("Other", other.spki, { path: "code", id: ids[1] });
      devices.pairRelayApproved("Listed", target.spki, { path: "code", id: ids[0] });
      return ids;
    });
    expect(standing).toEqual([ids[1]!]);
    expect(devices.has(ids[0]!)).toBe(false);
    // a write that throws publishes nothing
    expect(() => devices.admitListedRows(() => { throw new Error("list write failed"); })).toThrow("list write failed");
  });

  /** A PC with WAITING_MAX blocks waiting on a target it has no row of. */
  async function fullQueue() {
    const made = pc();
    const signer = await member(made.devices);
    const absent = await key();
    for (let i = 0; i < WAITING_MAX; i += 1) made.log.wait({ record: await block(absent.spki, signer), got: "mailbox", signer_removed: false });
    return { ...made, signer };
  }
  const failing = (names: readonly string[]) => {
    const rename = privateStateFs.renameSync;
    privateStateFs.renameSync = (from, to) => { if (names.some((name) => String(to).endsWith(name))) throw new Error("simulated EIO"); return rename(from, to); };
    return () => { privateStateFs.renameSync = rename; };
  };

  test("S10-2: a queue of exactly WAITING_MAX drops nothing and opens after a restart; one judged leaves it open", async () => {
    const { dir, devices, log } = await fullQueue();
    expect(devices.failsClosed).toBe(false);
    log.unwait(log.waitingBlocks()[0]!.record.id);
    expect({ waiting: log.waitingBlocks().length, closed: devices.failsClosed }).toEqual({ waiting: WAITING_MAX - 1, closed: false });
    log.close();
    const reopened = open(dir);
    try { expect(reopened.devices.failsClosed).toBe(false); } finally { reopened.log.close(); }
  });

  test("S10-2: when neither the log nor the side file takes the mark, the block is kept, nothing is dropped, and the PC is closed for this run", async () => {
    const { devices, log, signer } = await fullQueue();
    const extra = await block((await key()).spki, signer);
    const restore = failing(["account-log.json", SAFETY_OVERFLOW_FILE]);
    try { await devices.applyBlock(extra, "session"); } finally { restore(); }
    expect(devices.failsClosed).toBe(true);
    expect(log.waitingBlocks().map((kept) => kept.record.id)).toContain(extra.id);
    expect(log.waitingBlocks()).toHaveLength(WAITING_MAX + 1);
  });

  test("S10-2: a marker that is a dangling link, or a log missing beside a marker, fails closed", async () => {
    for (const shape of ["dangling", "missing log"] as const) {
      const { dir, log } = pc();
      log.close();
      if (shape === "dangling") symlinkSync(join(dir, "nowhere"), join(dir, SAFETY_OVERFLOW_FILE));
      else { writeFileSync(join(dir, SAFETY_OVERFLOW_FILE), "{}", { mode: 0o600 }); rmSync(join(dir, SAFETY_LOG_FILE), { force: true }); }
      const reopened = open(dir);
      try { expect({ shape, strict: reopened.devices.failsClosed }).toEqual({ shape, strict: true }); } finally { reopened.log.close(); }
    }
  });

  test("S10-2, P19, S19: a full queue whose overflow mark cannot be written in the log still fails closed after a restart", async () => {
    const { dir, devices, log } = pc();
    const signer = await member(devices);
    const absent = await key();
    for (let i = 0; i < WAITING_MAX; i += 1) log.wait({ record: await block(absent.spki, signer), got: "mailbox", signer_removed: false });
    const overflow = await block((await key()).spki, signer);
    const rename = privateStateFs.renameSync;
    privateStateFs.renameSync = (from, to) => { if (String(to).endsWith("account-log.json")) throw new Error("simulated EIO"); return rename(from, to); };
    try { await devices.applyBlock(overflow, "mailbox"); } finally { privateStateFs.renameSync = rename; }
    expect(devices.failsClosed).toBe(true);
    expect(existsSync(join(dir, SAFETY_OVERFLOW_FILE))).toBe(true);
    log.close();
    const reopened = open(dir);
    try { expect(reopened.devices.failsClosed).toBe(true); } finally { reopened.log.close(); }
  });
});
