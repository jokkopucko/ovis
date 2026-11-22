import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exportAccountKey, newRecordId, signAccountRecord, signSafetyRecord, type BlockRecord } from "../../shared/account-records.ts";
import { DeviceStore, readDeviceRegistry } from "../devices.ts";
import { caughtUp, relayConnection, relayDevice, relayFixture } from "../relay/test-helpers.ts";
import { loadRelayIdentity, savedServerId } from "../relay/identity.ts";
import { DeviceJournal } from "./device-journal.ts";
import { PcAccountState } from "./pc-binding.ts";
import { RemovalEvidence } from "./removal-evidence.ts";
import { pcRecordId, SafetyLog } from "./safety-log.ts";

const ACCOUNT = "acct_1";
const SERVER_ID = "0123456789abcdef0123456789abcdef";
const dirs: string[] = [];
const fixtures: ReturnType<typeof relayFixture>[] = [];
afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function stateDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "ovis-safe-start-"));
  dirs.push(dir);
  return dir;
}

interface Key { keys: CryptoKeyPair; spki: string }
async function key(): Promise<Key> {
  const keys = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
  return { keys, spki: await exportAccountKey(keys.publicKey) };
}

function store(dir: string): DeviceStore {
  const log = SafetyLog.open(dir);
  return new DeviceStore(dir, null, null, { safety: log, pc: PcAccountState.open(dir), removals: RemovalEvidence.open(dir, log), journal: DeviceJournal.open(dir, () => log.ensureFile()) });
}

async function member(devices: DeviceStore): Promise<Key & { id: string }> {
  const k = await key();
  const id = devices.pairRelay(devices.startPairing().code, "Phone", k.spki)!.device.id;
  devices.linkAccountKey(id, k.spki, k.spki, ACCOUNT);
  return { ...k, id };
}

const block = (target: string, by: Key): Promise<BlockRecord> =>
  signSafetyRecord({ v: 1, kind: "block", account: ACCOUNT, target, target_no: 9, signer: by.spki, signer_no: 1, signed_at: new Date().toISOString(), nonce: newRecordId() }, by.keys.privateKey) as Promise<BlockRecord>;

async function signIn(devices: DeviceStore, row: Key & { id: string }) {
  const nonce = crypto.getRandomValues(new Uint8Array(32));
  const message = Buffer.concat([Buffer.from("ovis-relay-auth/1"), nonce, Buffer.from(SERVER_ID)]);
  const signature = Buffer.from(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, row.keys.privateKey, message)).toString("base64url");
  return devices.matchRelay(row.id, nonce, signature, SERVER_ID);
}

const rowOrigin = (dir: string, id: string) => (JSON.parse(readFileSync(join(dir, "devices.json"), "utf8")) as { devices: { id: string; origin?: { admit_no: number } }[] }).devices.find((d) => d.id === id)?.origin;
const rowIds = (dir: string) => {
  const registry = readDeviceRegistry(join(dir, "devices.json"));
  return registry.kind === "ok" ? registry.devices.map((row) => row.id).sort() : [];
};

describe("a safe PC state before any listener (T41, T48)", () => {
  test("T41: reconcile persistent denies before HTTP, WS, relay, mailbox or recovery can serve", async () => {
    const dir = stateDir();
    const devices = store(dir);
    const [signer, kept, target, revoked] = [await member(devices), await member(devices), await member(devices), await member(devices)];
    await devices.applyBlock(await block(target.spki, signer), "handed");
    const before = readFileSync(join(dir, "devices.json"), "utf8");
    devices.revoke(revoked.id);
    // a stop between the Revoke's deny and its registry write: the old registry is back on disk
    writeFileSync(join(dir, "devices.json"), before, { mode: 0o600 });
    const f = relayFixture(false, { stateDir: dir, accountOpensAll: true });
    fixtures.push(f);
    dirs.splice(dirs.indexOf(dir), 1);
    const served = f.app.context.services.devices;
    // by the time the server answers anything, every durable deny holds
    expect(served.has(target.id)).toBe(false);
    expect(served.has(revoked.id)).toBe(false);
    expect(served.admits((await key()).spki)).toBe(false);
    const log = f.app.context.services.safetyLog!;
    expect(log.receipts(target.spki).map((receipt) => receipt.outcome)).toEqual(["applied"]);
    expect(log.blockIds()).toHaveLength(1);
    expect(log.receiptsBySigner(signer.spki, ACCOUNT).map((receipt) => receipt.outcome)).toEqual(["applied"]);
    expect(log.receiptsBySigner(target.spki, ACCOUNT)).toEqual([]);
    // a block signed under another binding of this PC is no receipt of the account it is in now
    expect(log.receiptsBySigner(signer.spki, "acct_other")).toEqual([]);
    // the registry on disk says so too, before any listener answered
    expect(rowIds(dir)).not.toContain(target.id);
    expect(rowIds(dir)).not.toContain(revoked.id);
    // a row nothing denies is untouched
    expect(await signIn(served, kept)).not.toBeNull();
  });

  test("T31: restart discards pending redemptions and recovery releases", async () => {
    const dir = stateDir();
    const first = store(dir);
    await member(first);
    first.clearAccountBinding("unlisted", "account");
    // a code started, and a device that redeemed a code made for a PC in no account and waits to link
    const pending = first.startPairing();
    const waitingKey = await key();
    const waiting = first.pairRelay(first.pairingForNoAccount().code, "Waiting", waitingKey.spki)!;
    expect(first.sessionRow(waiting.device.id)?.provisional).toBe(true);
    // a restart: nothing of either survives, and nothing of them was written
    const second = store(dir);
    expect(second.activePairing()).toBeNull();
    expect(second.sessionRow(waiting.device.id)).toBeNull();
    expect(second.pairRelay(pending.code, "Late", (await key()).spki)).toBeNull();
    expect(rowIds(dir)).not.toContain(waiting.device.id);
  });

  test("T48: merged barrier, holds and clears survive and no sibling row crosses an active closure", async () => {
    const [active, sibling] = [stateDir(), stateDir()];
    const own = store(active);
    const [signer, target] = [await member(own), await member(own)];
    await own.applyBlock(await block(target.spki, signer), "handed");
    // the sibling holds a row this dir does not, an enrollment barrier, a held key and a clear of an old binding
    const other = store(sibling);
    const onlyThere = await member(other);
    other.clearAccountBinding("unlisted", "account");
    writeFileSync(join(sibling, "account-enrolling.json"), JSON.stringify({ by: onlyThere.id }), { mode: 0o600 });
    const heldKey = (await key()).spki;
    writeFileSync(join(sibling, "account-held.json"), JSON.stringify({ keys: [heldKey], full: false }), { mode: 0o600 });
    const f = relayFixture(false, { stateDir: active, siblingStateDir: sibling, accountOpensAll: true });
    fixtures.push(f);
    dirs.splice(dirs.indexOf(active), 1);
    const served = f.app.context.services;
    // the barrier and the held key of either dir stand; the clear is kept; the binding of this dir stands
    expect(served.accountHolds.enrolling()).toBe(true);
    expect(served.accountHolds.holds(heldKey)).toBe(true);
    const pcFile = JSON.parse(readFileSync(join(active, "account-pc.json"), "utf8")) as { binding: { account: string } | null; clears: unknown[] };
    expect(pcFile.binding?.account).toBe(ACCOUNT);
    expect(pcFile.clears).toHaveLength(1);
    // a block stands in the merged log: the sibling's row is no import now, and it stays in the sibling's file
    expect(served.devices.has(onlyThere.id)).toBe(false);
    expect(rowIds(sibling)).toContain(onlyThere.id);
    expect(existsSync(join(active, "account-log.json"))).toBe(true);
  });

  test("P12, T48: a clear the sibling holds ends this folder's binding for good: the store reads the merged file, and a later write keeps it", async () => {
    const [active, sibling] = [stateDir(), stateDir()];
    const own = store(active);
    await member(own);
    const bound = (JSON.parse(readFileSync(join(active, "account-pc.json"), "utf8")) as { binding: { bind_id: string } }).binding;
    // the sibling holds the same binding, cleared there
    writeFileSync(join(sibling, "account-pc.json"), JSON.stringify({ v: 1, next_admit: 1, binding: null, clears: [{ bind_id: bound.bind_id, reason: "left_on_pc", by: "pc" }], first: null, others_ever: true, gen: 1 }), { mode: 0o600 });
    const f = relayFixture(false, { stateDir: active, siblingStateDir: sibling, accountOpensAll: true });
    fixtures.push(f);
    dirs.splice(dirs.indexOf(active), 1);
    const devices = f.app.context.services.devices;
    expect(devices.account()).toBeNull();
    // a write after the start (an admission takes a number) does not bring the cleared binding back
    devices.pairRelay(devices.startPairing().code, "Next", (await key()).spki);
    const pcFile = JSON.parse(readFileSync(join(active, "account-pc.json"), "utf8")) as { binding: unknown; clears: unknown[] };
    expect(pcFile.binding).toBeNull();
    expect(pcFile.clears).toHaveLength(1);
  });

  test("P12, T48: a folder with no account file keeps the sibling's clears and its own count", async () => {
    const [active, sibling] = [stateDir(), stateDir()];
    writeFileSync(join(sibling, "account-pc.json"), JSON.stringify({ v: 1, next_admit: 7, binding: null, clears: [{ bind_id: "c".repeat(32), reason: "left_on_pc", by: "pc" }], first: null, others_ever: true, gen: 1 }), { mode: 0o600 });
    const f = relayFixture(false, { stateDir: active, siblingStateDir: sibling, accountOpensAll: true });
    fixtures.push(f);
    dirs.splice(dirs.indexOf(active), 1);
    const devices = f.app.context.services.devices;
    const id = devices.pairRelay(devices.startPairing().code, "First", (await key()).spki)!.device.id;
    const pcFile = JSON.parse(readFileSync(join(active, "account-pc.json"), "utf8")) as { clears: unknown[]; next_admit: number };
    expect(pcFile.clears).toHaveLength(1);
    expect(rowOrigin(active, id)?.admit_no).toBe(1);
  });

  test("T27: conflicting keys or origins cannot gain authority from a sibling", async () => {
    const [active, sibling] = [stateDir(), stateDir()];
    const own = store(active);
    const row = await member(own);
    // the sibling's copy of the same row holds another key, and claims to be the oldest row of this PC
    const registry = JSON.parse(readFileSync(join(active, "devices.json"), "utf8")) as { gate_closed_at: string; devices: Record<string, unknown>[] };
    const other = (await key()).spki;
    const forged = registry.devices.map((device) => ({ ...device, relay_public_key: other, origin: { from: "legacy", how: "legacy", by: null, admit_no: 0, at: device["created_at"] } }));
    writeFileSync(join(sibling, "devices.json"), JSON.stringify({ ...registry, devices: forged }), { mode: 0o600 });
    const f = relayFixture(false, { stateDir: active, siblingStateDir: sibling, accountOpensAll: true });
    fixtures.push(f);
    dirs.splice(dirs.indexOf(active), 1);
    // a row whose key differs between the copies is dropped: neither key gets it, in either folder, and it is journalled
    expect(f.app.context.services.devices.has(row.id)).toBe(false);
    expect(rowIds(active)).not.toContain(row.id);
    expect(rowIds(sibling)).not.toContain(row.id);
    const journal = JSON.parse(readFileSync(join(active, "device-journal.json"), "utf8")) as { entries: { kind: string; how: string; row: string | null }[] };
    expect(journal.entries.filter((entry) => entry.kind === "drop" && entry.how === "merge_conflict").map((entry) => entry.row)).toEqual([row.id]);
  });

  test("T14: only authorized hand-over ends enrollment and the decision is journaled", async () => {
    const f = relayFixture(false, { accountOpensAll: true });
    fixtures.push(f);
    const devices = f.app.context.services.devices;
    const first = await key();
    const firstId = devices.pairRelay(devices.startPairing().code, "First", first.spki)!.device.id;
    const post = async (link: Awaited<ReturnType<typeof relayConnection>>, target: string, body: unknown) => {
      const request = link.open(target, { method: "POST", headers: [["content-type", "application/json"], ["x-herdr-machine", "1"]], body: "stream" });
      void request.stream.sendBody(new Response(JSON.stringify(body)).body!).catch(() => {});
      return (await request.response).status;
    };
    const firstLink = await relayConnection(f);
    caughtUp(f);
    await firstLink.auth({ keys: first.keys, publicKey: first.spki, id: firstId });
    const record = await signAccountRecord({ v: 1, kind: "link", account: ACCOUNT, key: first.spki, server_id: SERVER_ID, device_id: firstId, old_key: first.spki, issued_at: new Date().toISOString(), id: newRecordId(), signer: first.spki }, first.keys.privateKey);
    expect(await post(firstLink, "/api/account/link", { record })).toBe(200);
    expect(f.app.context.services.accountHolds.enrolling()).toBe(true);
    // a second member's hand-over does not end the first member's barrier
    const second = await member(devices);
    const secondLink = await relayConnection(f);
    caughtUp(f);
    await secondLink.auth({ keys: second.keys, publicKey: second.spki, id: second.id });
    expect(await post(secondLink, "/api/account/enroll", { account: ACCOUNT, records: [] })).toBe(200);
    expect(f.app.context.services.accountHolds.enrolling()).toBe(true);
    // the linking member's does, and the PC's journal says so
    const again = await relayConnection(f);
    caughtUp(f);
    await again.auth({ keys: first.keys, publicKey: first.spki, id: firstId });
    expect(await post(again, "/api/account/enroll", { account: ACCOUNT, records: [] })).toBe(200);
    expect(f.app.context.services.accountHolds.enrolling()).toBe(false);
    expect(DeviceJournal.open(f.stateDir).entries().filter((entry) => entry.kind === "account").map((entry) => [entry.how, entry.row])).toEqual([["enrolled", firstId]]);
  });

  test("P24, T46: a removal the journal holds but devices.json never got ends at the next start, before anything is served", async () => {
    const dir = stateDir();
    const devices = store(dir);
    const row = await member(devices);
    const kept = readFileSync(join(dir, "devices.json"));
    // the lock's drop is journalled, then the stop comes before devices.json is written
    devices.endUnlockedRows();
    writeFileSync(join(dir, "devices.json"), kept, { mode: 0o600 });
    const reopened = store(dir);
    expect(reopened.has(row.id)).toBe(false);
    expect(rowIds(dir)).not.toContain(row.id);
    // nothing written by the finisher is journalled twice
    const journal = JSON.parse(readFileSync(join(dir, "device-journal.json"), "utf8")) as { entries: { kind: string; row: string | null }[] };
    expect(journal.entries.filter((entry) => entry.kind === "remove" && entry.row === row.id)).toHaveLength(1);
  });

  test("P24, T46: with the start blocked, a row the journal removed is refused at relay sign-in though it is still in devices.json", async () => {
    const dir = stateDir();
    const first = relayFixture(false, { stateDir: dir, accountOpensAll: true });
    const device = await relayDevice(first);
    const kept = readFileSync(join(dir, "devices.json"));
    first.app.context.services.devices.endUnlockedRows();
    first.app.stop();
    writeFileSync(join(dir, "devices.json"), kept, { mode: 0o600 });
    // a sibling whose registry will not parse: the start is blocked and the finisher cannot write
    const sibling = stateDir();
    writeFileSync(join(sibling, "devices.json"), "not json", { mode: 0o600 });
    const f = relayFixture(false, { stateDir: dir, siblingStateDir: sibling, accountOpensAll: true });
    fixtures.push(f);
    dirs.splice(dirs.indexOf(dir), 1);
    const link = await relayConnection(f);
    expect(await link.auth(device).then(() => "in", () => "refused")).toBe("refused");
  });

  test("S19: a device journal that cannot be read fails the PC closed", () => {
    const dir = stateDir();
    store(dir);
    writeFileSync(join(dir, "device-journal.json"), "not json", { mode: 0o600 });
    expect(store(dir).failsClosed).toBe(true);
  });

  test("T46, S2-18 B2: a lock whose removals never ran ends its rows at the next open, journalled, and they stay out after an unlock", async () => {
    const dir = stateDir();
    const devices = store(dir);
    const row = await member(devices);
    const lock = SafetyLog.open(dir).appendLock({ account: ACCOUNT });
    // the stop: the lock is on disk, its removals are not
    const reopened = store(dir);
    expect(reopened.has(row.id)).toBe(false);
    expect(rowIds(dir)).not.toContain(row.id);
    expect(reopened.pendingLockRemovals()).toEqual([]);
    SafetyLog.open(dir).appendUnlock(lock.id, { account: ACCOUNT });
    expect(store(dir).has(row.id)).toBe(false);
  });

  test("T46, S2-18 B2: a blocked open holds the lock's removals it cannot write, refuses those rows and names them until a write succeeds", async () => {
    const dir = stateDir();
    const first = relayFixture(false, { stateDir: dir, accountOpensAll: true });
    const device = await relayDevice(first);
    first.app.stop();
    SafetyLog.open(dir).appendLock({ account: ACCOUNT });
    const sibling = stateDir();
    writeFileSync(join(sibling, "devices.json"), "not json", { mode: 0o600 });
    const f = relayFixture(false, { stateDir: dir, siblingStateDir: sibling, accountOpensAll: true });
    fixtures.push(f);
    dirs.splice(dirs.indexOf(dir), 1);
    expect(f.app.context.services.devices.pendingLockRemovals()).toEqual([device.id]);
    const link = await relayConnection(f);
    expect(await link.auth(device).then(() => "in", () => "refused")).toBe("refused");
  });

  test("S19: with only the device journal unreadable, the PC every reader asks fails closed", async () => {
    const dir = stateDir();
    const first = relayFixture(false, { stateDir: dir, accountOpensAll: true });
    await relayDevice(first);
    first.app.stop();
    writeFileSync(join(dir, "device-journal.json"), "not json", { mode: 0o600 });
    const f = relayFixture(false, { stateDir: dir, accountOpensAll: true });
    fixtures.push(f);
    dirs.splice(dirs.indexOf(dir), 1);
    expect(f.app.context.services.devices.failsClosed).toBe(true);
  });

  test("S19: each state file that cannot be read, on its own, fails the PC closed, as account records are refused", async () => {
    for (const file of ["account-log.json", "account-pc.json", "account-removed.json", "device-journal.json", "account-tombstones.json", "account-tombstones.pending.json"]) {
      const dir = stateDir();
      const first = relayFixture(false, { stateDir: dir, accountOpensAll: true });
      await relayDevice(first);
      first.app.stop();
      writeFileSync(join(dir, file), "not json", { mode: 0o600 });
      const f = relayFixture(false, { stateDir: dir, accountOpensAll: true });
      fixtures.push(f);
      dirs.splice(dirs.indexOf(dir), 1);
      const devices = f.app.context.services.devices;
      expect([file, devices.failsClosed]).toEqual([file, true]);
      expect(devices.accountError).not.toBeNull();
    }
  });

  test("T48: a sibling folder of another relay identity merges none of its rows into this PC", async () => {
    const [dir, sibling] = [stateDir(), stateDir()];
    // two PCs: each folder holds its own saved relay identity
    loadRelayIdentity(dir);
    loadRelayIdentity(sibling);
    expect(savedServerId(dir)).not.toBe(savedServerId(sibling));
    const own = relayFixture(false, { stateDir: dir, accountOpensAll: true });
    own.app.stop();
    const other = relayFixture(false, { stateDir: sibling, accountOpensAll: true });
    const foreign = await relayDevice(other);
    other.app.stop();
    const f = relayFixture(false, { stateDir: dir, siblingStateDir: sibling, accountOpensAll: true });
    fixtures.push(f);
    dirs.splice(dirs.indexOf(dir), 1);
    expect(f.app.context.services.devices.has(foreign.id)).toBe(false);
  });

  test("T48: a foreign sibling cannot lift this PC's block and stays byte-identical", async () => {
    const [dir, sibling] = [stateDir(), stateDir()];
    expect(loadRelayIdentity(dir).server_id).not.toBe(loadRelayIdentity(sibling).server_id);
    const own = store(dir);
    const [signer, target] = [await member(own), await member(own)];
    const registry = readFileSync(join(dir, "devices.json"));
    const deny = await block(target.spki, signer);
    expect(await own.applyBlock(deny, "handed")).toMatchObject({ outcome: "applied" });
    // Replay must deny the target even if the registry write did not survive.
    writeFileSync(join(dir, "devices.json"), registry, { mode: 0o600 });
    const other = SafetyLog.open(sibling);
    expect(other.append({
      record: { v: 1, id: pcRecordId(), kind: "lift", account: ACCOUNT, target: deny.id, signer: "pc", signed_at: new Date().toISOString(), forget: false, signature: "" },
      got: "pc", cause: "screen",
    })).toMatchObject({ outcome: "applied" });
    other.close();
    const snapshot = () => new Map(readdirSync(sibling, { encoding: "utf8", recursive: true })
      .filter((path) => statSync(join(sibling, path)).isFile())
      .map((path) => [path, readFileSync(join(sibling, path))]));
    const before = snapshot();

    const f = relayFixture(false, { stateDir: dir, siblingStateDir: sibling, accountOpensAll: true });
    fixtures.push(f);
    dirs.splice(dirs.indexOf(dir), 1);
    const { devices, safetyLog } = f.app.context.services;

    expect(safetyLog?.state().blocks.map(({ record }) => record.id)).toEqual([deny.id]);
    expect(await signIn(devices, target)).toBeNull();
    const after = snapshot();
    expect([...after.keys()].sort()).toEqual([...before.keys()].sort());
    expect([...before].filter(([path, bytes]) => !after.get(path)?.equals(bytes)).map(([path]) => path)).toEqual([]);
  });
});
