import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exportAccountKey, newRecordId, signAccountRecord } from "../../shared/account-records.ts";
import { DeviceStore, type StoredDevice } from "../devices.ts";
import { relayConnection, relayDevice, relayFixture } from "../relay/test-helpers.ts";
import { ADMISSION_FILE } from "./admission-order.ts";
import { ACCOUNT_LIST_KEYS_FILE, ListKeyStore } from "./list-keys.ts";
import { bindingFs, PcAccountState, RemovedOnDiskError } from "./pc-binding.ts";
import { PendingRedemptions } from "./pending.ts";
import { signPairProof } from "../../shared/pair-fingerprint.ts";

const SERVER_ID = "0123456789abcdef0123456789abcdef";
const ACCOUNT = "acct_1";
const dirs: string[] = [];
const fixtures: ReturnType<typeof relayFixture>[] = [];
afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function stateDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "ovis-pc-binding-"));
  dirs.push(dir);
  return dir;
}

test("a rolled-back first link does not publish a binding change or cancel another pending pairing", async () => {
  const dir = stateDir();
  const binding = PcAccountState.open(dir);
  const devices = new DeviceStore(dir, null, null, { pc: binding });
  const key = await accountKey(), waitingKey = await accountKey();
  const row = devices.pairRelay(devices.startPairing().code, "First link", key.spki);
  if (!row) throw new Error("First link fixture did not pair");
  const pending = new PendingRedemptions({ serverId: SERVER_ID, journalDrop() {} });
  const { challenge } = pending.name("123456", "Other phone", waitingKey.spki, "relay");
  const entry = await pending.prove(challenge, await signPairProof(SERVER_ID, challenge, waitingKey.spki, waitingKey.keys.privateKey));
  if (!entry) throw new Error("Unrelated proven key did not enter the pending queue");
  const changes: (string | null)[] = [];
  const stop = binding.onBindingChange(() => {
    changes.push(binding.account());
    for (const item of pending.list()) pending.decline(item.id);
  });
  try {
    rmSync(join(dir, "devices.json"));
    mkdirSync(join(dir, "devices.json"));
    expect(() => devices.linkAccountKey(row.device.id, key.spki, key.spki, ACCOUNT)).toThrow();
    expect(pcFile(dir).binding).toBeNull();
    expect({ changes, pending: pending.list().map(item => item.id) }).toEqual({ changes: [], pending: [entry.id] });
    binding.bind(ACCOUNT, key.spki).commit();
    expect(changes).toEqual([ACCOUNT]);
    expect(pending.list()).toEqual([]);
    expect(binding.clear("unlisted", "account")).toBe(true);
    binding.bindByService(ACCOUNT);
    expect(changes).toEqual([ACCOUNT, null, ACCOUNT]);
  } finally { stop(); }
});

async function accountKey() {
  const keys = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
  return { keys, spki: await exportAccountKey(keys.publicKey) };
}

const store = (dir: string) => new DeviceStore(dir, null, null, { pc: PcAccountState.open(dir) });
const pcFile = (dir: string) => JSON.parse(readFileSync(join(dir, ADMISSION_FILE), "utf8")) as {
  v: number; binding: { account: string; bind_id: string } | null; clears: { bind_id: string; reason: string; by: string }[];
  first: { key: string; list_key: string | null } | null; others_ever: boolean; next_admit: number;
};

/** A relay row of this PC that links into `account` with its own key, as the link route does after its checks. */
async function linked(devices: DeviceStore, account = ACCOUNT): Promise<{ id: string; key: string }> {
  const key = (await accountKey()).spki;
  const paired = devices.pairRelay(devices.startPairing().code, "Phone", key);
  if (!paired) throw new Error("pairing failed");
  if (devices.linkAccountKey(paired.device.id, key, key, account) === null) throw new Error("link failed");
  return { id: paired.device.id, key };
}

function memberRow(account: string): StoredDevice {
  return { id: randomBytes(8).toString("hex"), label: "Old phone", role: "drive", token_hash: randomBytes(32).toString("hex"),
    account, created_at: "2026-10-01T00:00:00.000Z", last_seen_at: null };
}

describe("the PC's account binding (account-pc.json)", () => {
  test("unlisting retains only owned pairing origins and never retains an imported or invalid origin", async () => {
    const dir = stateDir();
    const binding = PcAccountState.open(dir);
    binding.migrate(null, true);
    binding.bindByService(ACCOUNT);
    const makeRow = (from: "legacy" | "pc" | "remote", how: "code" | "digits" | "add" = "code", extra: Partial<StoredDevice> = {}, by: string | null = null) => {
      const row = memberRow(ACCOUNT);
      return { ...row, linked_at: row.created_at, origin: from === "legacy"
        ? { from, how: "legacy" as const, at: row.created_at, admit_no: 0, by: null }
        : binding.admit(from, how, by, Date.parse(row.created_at)), ...extra };
    };
    const keep = [makeRow("pc"), makeRow("legacy"), makeRow("remote", "code", { role: "watch" }), makeRow("remote", "digits")];
    const drop = [makeRow("pc", "code", { imported: true }), makeRow("legacy", "code", { invalid_origin: true }),
      makeRow("remote", "add"), makeRow("remote", "code", { added_by: keep[0]!.id }), makeRow("remote", "code", { link_moved_key: true }),
      makeRow("remote", "code", {}, (await accountKey()).spki), makeRow("remote", "digits", {}, (await accountKey()).spki),
      makeRow("remote", "digits", { imported: true })];
    writeFileSync(join(dir, "devices.json"), JSON.stringify({ gate_closed_at: keep[0]!.created_at, devices: [...keep, ...drop] }), { mode: 0o600 });
    const devices = store(dir);
    expect(devices.accountError).toBeNull();
    const closed: string[] = [];
    for (const row of drop) devices.onRevoke(row.id, () => closed.push(row.id));
    expect(devices.clearAccountBinding("unlisted", "account")).toBe(true);
    expect(closed.sort()).toEqual(drop.map(row => row.id).sort());
    const rows = JSON.parse(readFileSync(join(dir, "devices.json"), "utf8")).devices as StoredDevice[];
    expect(rows.map(d => [d.id, d.role, d.origin, d.account, d.linked_at])).toEqual(keep.map(d => [d.id, d.role, d.origin, undefined, undefined]));
    expect(store(dir).accountError).toBeNull();
  });
  test.each(["active", "sibling"] as const)("T48: a service opt-out in the %s folder persists in both folders of the same binding", side => {
    const active = stateDir();
    const sibling = stateDir();
    const source = PcAccountState.open(active);
    source.migrate(ACCOUNT, true);
    const other = PcAccountState.open(sibling);
    other.takeSibling(active);
    other.migrate(ACCOUNT, true);
    expect(other.binding()).toEqual(source.binding());
    expect((side === "active" ? source : other).setServiceStep2Off(true)).toBe(true);

    PcAccountState.open(active).takeSibling(sibling);

    expect([PcAccountState.open(active).serviceStep2Off(), PcAccountState.open(sibling).serviceStep2Off()]).toEqual([true, true]);
  });

  test("T59/T67: neither a current nor stale relay challenge binds a first-device list key", async () => {
    for (const fresh of [true, false]) {
      const f = relayFixture(false, { accountOpensAll: true });
      fixtures.push(f);
      const device = await relayDevice(f);
      const listKey = await accountKey();
      const link = await relayConnection(f);
      await link.auth(device);
      const nonce = Buffer.from((await link.welcome).payload.nonce, "base64url");
      if (!fresh) nonce[0] = (nonce[0] ?? 0) ^ 1;
      const signature = Buffer.from(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, listKey.keys.privateKey,
        Buffer.concat([Buffer.from("ovis-relay-auth/1"), nonce, Buffer.from(SERVER_ID)]))).toString("base64url");
      const record = await signAccountRecord({ v: 1, kind: "link", account: ACCOUNT, key: device.publicKey, server_id: SERVER_ID, device_id: device.id, old_key: device.publicKey, issued_at: new Date().toISOString(), id: newRecordId(), signer: device.publicKey }, device.keys.privateKey);
      const request = link.open("/api/account/link", { method: "POST", headers: [["content-type", "application/json"], ["x-herdr-machine", "1"]], body: "stream" });
      await request.stream.sendBody(new Response(JSON.stringify({ record, list_key: listKey.spki, list_signature: signature })).body!);
      expect((await request.response).status).toBe(200);
      expect(pcFile(f.stateDir).first).toEqual({ key: device.publicKey, list_key: null });
    }
  });

  test("T67/H2: another linked member permanently consumes first-device status", async () => {
    const dir = stateDir();
    const devices = store(dir);
    await linked(devices);
    expect(pcFile(dir).others_ever).toBe(false);
    const second = await linked(devices);
    expect(devices.revoke(second.id)).toBe(true);
    expect(PcAccountState.open(dir).othersEver()).toBe(true);
  });
  test("T13: first link and enrollment barrier commit together", async () => {
    const f = relayFixture(false, { accountOpensAll: true });
    fixtures.push(f);
    const device = await relayDevice(f);
    const key = await accountKey();
    const link = await relayConnection(f);
    await link.auth(device);
    const record = await signAccountRecord({ v: 1, kind: "link", account: ACCOUNT, key: key.spki, server_id: SERVER_ID, device_id: device.id, old_key: device.publicKey, issued_at: new Date().toISOString(), id: newRecordId(), signer: key.spki }, key.keys.privateKey);
    const request = link.open("/api/account/link", { method: "POST", headers: [["content-type", "application/json"], ["x-herdr-machine", "1"]], body: "stream" });
    void request.stream.sendBody(new Response(JSON.stringify({ record })).body!).catch(() => {});
    expect((await request.response).status).toBe(200);
    // the barrier that holds account adds back, and the binding, are both on disk once the link answered
    expect(existsSync(join(f.stateDir, "account-enrolling.json"))).toBe(true);
    const bound = pcFile(f.stateDir);
    expect(bound.binding?.account).toBe(ACCOUNT);
    expect(bound.binding?.bind_id).toMatch(/^[0-9a-f]{32}$/);
    expect(bound.first).toEqual({ key: key.spki, list_key: null });

    // a link whose row cannot be written leaves no binding behind
    const dir = stateDir();
    const devices = store(dir);
    const key2 = (await accountKey()).spki;
    const paired = devices.pairRelay(devices.startPairing().code, "Phone", key2)!;
    rmSync(join(dir, "devices.json"));
    mkdirSync(join(dir, "devices.json"));
    expect(() => devices.linkAccountKey(paired.device.id, key2, key2, ACCOUNT)).toThrow();
    expect(devices.account()).toBeNull();
    expect(pcFile(dir).binding).toBeNull();
  });

  test("T59: link binds the PC and only a named local clear or identity reset clears it", async () => {
    const dir = stateDir();
    const devices = store(dir);
    expect(devices.account()).toBeNull();
    const first = await linked(devices);
    expect(devices.account()).toBe(ACCOUNT);
    const bindId = pcFile(dir).binding!.bind_id;
    // a second member, a record that removes it, and a Revoke change nothing of the binding
    const second = await linked(devices);
    expect(devices.removeAccountKey(second.key, ACCOUNT, { id: newRecordId(), issuedAt: new Date().toISOString() })).toBe(true);
    expect(devices.revoke(first.id)).toBe(true);
    // with how long it waits for the device that linked it to list it
    expect<object | null>(pcFile(dir).binding).toEqual({ account: ACCOUNT, bind_id: bindId, listing_due: expect.any(String) });

    // a named clear at the PC: the binding goes, the clear is kept, and the file stays
    devices.clearAccountBinding("unlisted", "account");
    expect(devices.account()).toBeNull();
    expect(pcFile(dir)).toMatchObject({ binding: null, clears: [{ bind_id: bindId, reason: "unlisted", by: "account" }] });
    // the next first link makes a new binding; the earlier clear is never cut
    await linked(devices, "acct_2");
    const rebound = pcFile(dir);
    expect(rebound.binding?.account).toBe("acct_2");
    expect(rebound.binding?.bind_id).not.toBe(bindId);
    // Revoke all clears too
    devices.revokeAll();
    expect(pcFile(dir).clears.map((clear) => clear.reason)).toEqual(["unlisted", "revoke_all"]);
    expect(store(dir).account()).toBeNull();

    // a relay identity reset clears it
    const f = relayFixture(false, { accountOpensAll: true });
    fixtures.push(f);
    const served = f.app.context.services.devices;
    await linked(served);
    expect(served.account()).toBe(ACCOUNT);
    await f.app.context.services.relay.resetIdentity();
    expect(served.account()).toBeNull();
    expect(pcFile(f.stateDir).clears.at(-1)?.reason).toBe("identity_reset");
  });

  test("T30: removing the last member leaves the PC bound", async () => {
    const dir = stateDir();
    const devices = store(dir);
    const only = await linked(devices);
    expect(devices.removeAccountKey(only.key, ACCOUNT, { id: newRecordId(), issuedAt: new Date().toISOString() })).toBe(true);
    expect(devices.list(null).filter((device) => device.account !== undefined)).toHaveLength(0);
    expect(devices.account()).toBe(ACCOUNT);
    expect(store(dir).account()).toBe(ACCOUNT);
  });

  test("T50: legacy migration is once only and conflicting accounts fail closed", () => {
    // the rows' one account becomes the binding, once; an upgraded PC never takes the first-device path
    const dir = stateDir();
    const rows = [memberRow(ACCOUNT), memberRow(ACCOUNT), { ...memberRow(ACCOUNT), account: undefined }];
    writeFileSync(join(dir, "devices.json"), JSON.stringify({ gate_closed_at: rows[0]!.created_at, devices: rows }), { mode: 0o600 });
    expect(store(dir).account()).toBe(ACCOUNT);
    const migrated = pcFile(dir);
    expect(migrated).toMatchObject({ v: 1, binding: { account: ACCOUNT }, clears: [], first: null, others_ever: true, next_admit: 1 });
    expect(store(dir).account()).toBe(ACCOUNT);
    expect(pcFile(dir).binding?.bind_id).toBe(migrated.binding!.bind_id);

    // a PC with no rows starts with no binding and no history
    const fresh = stateDir();
    expect(store(fresh).account()).toBeNull();
    expect(pcFile(fresh)).toMatchObject({ binding: null, clears: [], first: null, others_ever: false });

    // rows of two accounts: no binding is guessed, and the PC fails closed
    const split = stateDir();
    const two = [memberRow(ACCOUNT), memberRow("acct_2")];
    writeFileSync(join(split, "devices.json"), JSON.stringify({ gate_closed_at: two[0]!.created_at, devices: two }), { mode: 0o600 });
    const pc = PcAccountState.open(split);
    const closed = new DeviceStore(split, null, null, { pc });
    expect(closed.accountError).not.toBeNull();
    expect(closed.pair(closed.startPairing().code, "New", "drive")).toBeNull();
    expect(existsSync(join(split, ADMISSION_FILE))).toBe(false);
  });
});

describe("a binding pinned to the account's signed list", () => {
  const LIST = "ab".repeat(32);
  const OTHER_LIST = "cd".repeat(32);

  test("the pin is with the binding, on disk, one-way, and raises gen", async () => {
    const dir = stateDir();
    const devices = store(dir);
    await linked(devices);
    const pc = PcAccountState.open(dir);
    const binding = pc.binding()!;
    const gen = pc.gen();
    expect(pc.pinToList("0".repeat(32), LIST)).toBe(false);
    expect(pc.pinToList(binding.bind_id, "not a list")).toBe(false);
    expect(pc.binding()?.list).toBeUndefined();
    expect(pc.pinToList(binding.bind_id, LIST)).toBe(true);
    expect(pc.gen()).toBe(gen + 1);
    // the same list again changes nothing; another list is refused
    expect(pc.pinToList(binding.bind_id, LIST)).toBe(true);
    expect(pc.gen()).toBe(gen + 1);
    expect(pc.pinToList(binding.bind_id, OTHER_LIST)).toBe(false);
    expect(PcAccountState.open(dir).binding()).toMatchObject({ bind_id: binding.bind_id, account: ACCOUNT, list: LIST });
    // naming the listing the binding stands on keeps the pin
    PcAccountState.open(dir).pinListing(binding.bind_id, "1".repeat(32));
    expect(PcAccountState.open(dir).binding()).toMatchObject({ list: LIST });
  });

  test("the pin ends only with the binding, and the next binding starts without one", async () => {
    const dir = stateDir();
    const devices = store(dir);
    await linked(devices);
    const pc = PcAccountState.open(dir);
    expect(pc.pinToList(pc.binding()!.bind_id, LIST)).toBe(true);
    expect(devices.clearAccountBinding("revoke_all", "pc")).toBe(true);
    expect(PcAccountState.open(dir).binding()).toBeNull();
    const again = store(dir);
    await linked(again);
    expect(PcAccountState.open(dir).binding()?.list).toBeUndefined();
  });

  test("a list's removal of the PC is kept for the account and the relay identity it had, and for no other", async () => {
    const dir = stateDir();
    const devices = store(dir);
    await linked(devices);
    const pc = PcAccountState.open(dir);
    expect(pc.removedByList(ACCOUNT, SERVER_ID)).toBe(false);
    expect(devices.clearAccountBinding("unlisted", "list", SERVER_ID)).toBe(true);
    const kept = PcAccountState.open(dir);
    expect(kept.removedByList(ACCOUNT, SERVER_ID)).toBe(true);
    expect(kept.removedByList("acct_2", SERVER_ID)).toBe(false);
    expect(kept.removedByList(ACCOUNT, "f".repeat(32))).toBe(false);
    // any other clear keeps no such word, whoever names a relay identity with it
    const other = stateDir();
    const more = store(other);
    await linked(more);
    expect(more.clearAccountBinding("unlisted", "account", SERVER_ID)).toBe(true);
    expect(PcAccountState.open(other).removedByList(ACCOUNT, SERVER_ID)).toBe(false);
  });

  test("a file whose pin or removal is out of form is not trusted", async () => {
    type Doc = { binding: { list?: unknown }; clears: unknown[] };
    for (const damage of [
      (doc: Doc) => { doc.binding.list = "AB".repeat(32); },
      (doc: Doc) => { doc.binding.list = 7; },
      (doc: Doc) => { doc.clears = [{ bind_id: "0".repeat(32), reason: "unlisted", by: "list", removed_as: { account: ACCOUNT, server_id: "nope" } }]; },
    ]) {
      const dir = stateDir();
      await linked(store(dir));
      const doc = JSON.parse(readFileSync(join(dir, ADMISSION_FILE), "utf8")) as Doc;
      damage(doc);
      writeFileSync(join(dir, ADMISSION_FILE), JSON.stringify(doc));
      expect(PcAccountState.open(dir).strict).not.toBeNull();
    }
  });

  test("a folder whose other folder holds a pin it does not hold itself takes no pin: it is closed, says which folder holds it, and writes nothing", async () => {
    const [dir, sibling, fresh] = [stateDir(), stateDir(), stateDir()];
    await linked(store(dir));
    const pinned = PcAccountState.open(dir);
    const binding = pinned.binding()!;
    // the other folder holds the same binding, as after a merge, with no pin
    writeFileSync(join(sibling, ADMISSION_FILE), readFileSync(join(dir, ADMISSION_FILE)));
    expect(pinned.pinToList(binding.bind_id, LIST)).toBe(true);
    await new ListKeyStore(dir).keysFor(SERVER_ID);
    const before = readFileSync(join(sibling, ADMISSION_FILE), "utf8");
    const other = PcAccountState.open(sibling);
    other.takeSibling(dir);
    expect(other.strict).toContain(dir);
    expect(other.strict).toContain("pinned");
    expect(readFileSync(join(sibling, ADMISSION_FILE), "utf8")).toBe(before);
    expect(existsSync(join(sibling, ACCOUNT_LIST_KEYS_FILE))).toBe(false);
    // a folder with no account state of its own: the same, and it takes no binding at its migration
    const none = PcAccountState.open(fresh);
    none.takeSibling(dir);
    expect(none.strict).toContain(dir);
    none.migrate(null, false);
    expect(existsSync(join(fresh, ADMISSION_FILE))).toBe(false);
    // the folder that holds the pin is closed by nothing the other holds
    const mine = PcAccountState.open(dir);
    mine.takeSibling(sibling);
    expect(mine.strict).toBeNull();
    expect(mine.binding()).toMatchObject({ bind_id: binding.bind_id, list: LIST });
    expect((JSON.parse(readFileSync(join(sibling, ADMISSION_FILE), "utf8")) as { binding: { list?: string } }).binding.list).toBeUndefined();
  });

  test("a pin the other folder holds for a binding that both cleared closes nothing", async () => {
    const [dir, sibling] = [stateDir(), stateDir()];
    const devices = store(dir);
    await linked(devices);
    const pc = PcAccountState.open(dir);
    expect(pc.pinToList(pc.binding()!.bind_id, LIST)).toBe(true);
    writeFileSync(join(sibling, ADMISSION_FILE), readFileSync(join(dir, ADMISSION_FILE)));
    expect(devices.clearAccountBinding("revoke_all", "pc")).toBe(true);
    // the other folder still shows the pinned binding; this folder's clear of it stands in both
    const mine = PcAccountState.open(dir);
    mine.takeSibling(sibling);
    expect(mine.strict).toBeNull();
    expect(mine.binding()).toBeNull();
    expect(PcAccountState.open(sibling).binding()).toBeNull();
  });

  test("a list's removal of the PC outlives a merge with a folder that cleared the same binding another way, in either direction", async () => {
    for (const reverse of [false, true]) {
      const [dir, sibling] = [stateDir(), stateDir()];
      const devices = store(dir);
      await linked(devices);
      writeFileSync(join(sibling, ADMISSION_FILE), readFileSync(join(dir, ADMISSION_FILE)));
      // this folder: the list removed the PC; the other: its owner chose Revoke all for the same binding
      expect(devices.clearAccountBinding("unlisted", "list", SERVER_ID)).toBe(true);
      expect(store(sibling).clearAccountBinding("revoke_all", "pc")).toBe(true);
      const [taker, from] = reverse ? [sibling, dir] : [dir, sibling];
      PcAccountState.open(taker).takeSibling(from);
      for (const folder of [dir, sibling]) expect(PcAccountState.open(folder).removedByList(ACCOUNT, SERVER_ID)).toBe(true);
    }
  });

  test("another server on the same folder pinned the binding: one that read the file before takes the pin over, clears nothing on the service's word and never writes the file without it", async () => {
    const dir = stateDir();
    const devices = store(dir);
    await linked(devices);
    const pc = PcAccountState.open(dir);
    const path = join(dir, ADMISSION_FILE);
    const onDisk = () => JSON.parse(readFileSync(path, "utf8")) as { v: number; gen: number; next_admit: number; binding: { bind_id: string; list?: string; list_alarm?: true } | null; clears: unknown[] };
    // the other server pins the binding and keeps an alarm beside it: the file gains both, this server's memory neither
    const theirs = onDisk();
    writeFileSync(path, JSON.stringify({ ...theirs, v: 2, gen: theirs.gen + 1, binding: { ...theirs.binding, list: LIST, list_alarm: true } }));
    expect(pc.binding()?.list).toBeUndefined();
    // the account service stops listing the PC: the server with the old document leaves nothing
    expect(devices.clearAccountBinding("unlisted", "account")).toBe(false);
    expect(onDisk().binding).toMatchObject({ list: LIST, list_alarm: true });
    expect(pc.binding()).toMatchObject({ list: LIST, list_alarm: true });
    // a write for anything else (a number for an admission) keeps the pin too
    writeFileSync(path, JSON.stringify({ ...onDisk(), binding: { ...onDisk().binding, list: LIST, list_alarm: true } }));
    const other = stateDir();
    const stale = store(other);
    await linked(stale);
    const mine = PcAccountState.open(other);
    const before = JSON.parse(readFileSync(join(other, ADMISSION_FILE), "utf8")) as { v: number; gen: number; binding: object };
    writeFileSync(join(other, ADMISSION_FILE), JSON.stringify({ ...before, v: 2, gen: before.gen + 1, binding: { ...before.binding, list: LIST } }));
    mine.admit("pc", "code", null, Date.now());
    expect((JSON.parse(readFileSync(join(other, ADMISSION_FILE), "utf8")) as { v: number; binding: { list?: string } })).toMatchObject({ v: 2, binding: { list: LIST } });
    expect(mine.binding()).toMatchObject({ list: LIST });
    // a pin for another list than the one this server holds is no pin to take over: nothing is written
    expect(mine.pinToList(mine.binding()!.bind_id, OTHER_LIST)).toBe(false);
    // what a person does at the PC, and the list's own removal, still end the binding
    expect(devices.clearAccountBinding("revoke_all", "pc")).toBe(true);
    expect(onDisk().binding).toBeNull();
    expect(stale.clearAccountBinding("unlisted", "list", SERVER_ID)).toBe(true);
    expect(PcAccountState.open(other).removedByList(ACCOUNT, SERVER_ID)).toBe(true);
  });

  test("a removal of the PC by its list that another server wrote is never written away: the server that still held the binding drops it at its next write", async () => {
    const dir = stateDir();
    const devices = store(dir);
    await linked(devices);
    const stale = PcAccountState.open(dir);
    const held = stale.binding()!;
    const path = join(dir, ADMISSION_FILE);
    // another server on this folder pinned the binding, and its list then removed the PC: the file holds no binding and the receipt
    const disk = JSON.parse(readFileSync(path, "utf8")) as { gen: number; next_admit: number; clears: unknown[] };
    writeFileSync(path, JSON.stringify({ ...disk, v: 2, gen: disk.gen + 2, next_admit: disk.next_admit + 3, binding: null,
      clears: [...disk.clears, { bind_id: held.bind_id, reason: "unlisted", by: "list", admits: disk.next_admit, removed_as: { account: ACCOUNT, server_id: SERVER_ID } }] }));
    expect(stale.binding()).toMatchObject({ bind_id: held.bind_id });
    // an ordinary write of the server with the old document: a number for an admission
    const origin = stale.admit("pc", "code", null, Date.now());
    // it gives a number the other server did not give, keeps the receipt, and its cached binding does not come back
    expect(origin.admit_no).toBe(disk.next_admit + 3);
    const after = PcAccountState.open(dir);
    expect(after.binding()).toBeNull();
    expect(after.removedByList(ACCOUNT, SERVER_ID)).toBe(true);
    expect(stale.binding()).toBeNull();
    expect(stale.gen()).toBeGreaterThanOrEqual(disk.gen + 2);
  });

  test("a PC binds itself by a list only while the file holds no removal of it from that account, read under the lock", async () => {
    const dir = stateDir();
    const devices = store(dir);
    await linked(devices);
    const pc = PcAccountState.open(dir);
    expect(devices.clearAccountBinding("revoke_all", "pc")).toBe(true);
    const path = join(dir, ADMISSION_FILE);
    // another server on this folder bound the PC meanwhile, and its list removed it: this server's memory holds neither
    const disk = JSON.parse(readFileSync(path, "utf8")) as { gen: number; clears: unknown[] };
    writeFileSync(path, JSON.stringify({ ...disk, v: 2, gen: disk.gen + 2,
      clears: [...disk.clears, { bind_id: "cd".repeat(16), reason: "unlisted", by: "list", removed_as: { account: ACCOUNT, server_id: SERVER_ID } }] }));
    expect(() => pc.bindByList(ACCOUNT, LIST, SERVER_ID)).toThrow(RemovedOnDiskError);
    expect((JSON.parse(readFileSync(path, "utf8")) as { binding: unknown }).binding).toBeNull();
    // another relay identity, as a reset makes, is a new PC to that account
    expect(pc.bindByList(ACCOUNT, LIST, "f".repeat(32))).toMatchObject({ account: ACCOUNT, list: LIST, won: true });
  });

  test("a server that read the file before another server changed it learns of the pin, and of a clear, when it looks again", async () => {
    const dir = stateDir();
    await linked(store(dir));
    const stale = PcAccountState.open(dir);
    const held = stale.binding()!;
    const path = join(dir, ADMISSION_FILE);
    const disk = JSON.parse(readFileSync(path, "utf8")) as { gen: number; binding: object; clears: unknown[] };
    writeFileSync(path, JSON.stringify({ ...disk, v: 2, gen: disk.gen + 1, binding: { ...disk.binding, list: LIST } }));
    let told = 0;
    stale.onBindingChange(() => { told++; });
    stale.refresh();
    expect(stale.binding()).toMatchObject({ list: LIST });
    expect(told).toBe(1);
    stale.refresh();
    expect(told).toBe(1);
    writeFileSync(path, JSON.stringify({ ...disk, v: 1, gen: disk.gen + 2, binding: null, clears: [...disk.clears, { bind_id: held.bind_id, reason: "revoke_all", by: "pc" }] }));
    stale.refresh();
    expect(stale.binding()).toBeNull();
    expect(told).toBe(2);
    // a file that does not read changes nothing in memory
    writeFileSync(path, "{");
    stale.refresh();
    expect(stale.binding()).toBeNull();
  });

  test("the other folder learns a clear it does not hold, written onto what its file holds at that moment", async () => {
    const [dir, sibling] = [stateDir(), stateDir()];
    const devices = store(dir);
    const first = (await linked(devices), PcAccountState.open(dir).binding()!);
    // the other folder: another binding of the same account
    await linked(store(sibling));
    const other = PcAccountState.open(sibling).binding()!;
    // this folder cleared its own binding: a clear the other folder has to learn
    expect(devices.clearAccountBinding("revoke_all", "pc")).toBe(true);
    const mine = PcAccountState.open(dir);
    // between this folder's read of that file and its write, a server in the other folder records its listing
    const real = bindingFs.openSync;
    let raced = false;
    const racing = spyOn(bindingFs, "openSync").mockImplementation(((...args: Parameters<typeof real>) => {
      if (!raced && String(args[0]) === `${join(sibling, ADMISSION_FILE)}.lock`) {
        raced = true;
        const held = JSON.parse(readFileSync(join(sibling, ADMISSION_FILE), "utf8")) as { binding: object };
        writeFileSync(join(sibling, ADMISSION_FILE), JSON.stringify({ ...held, binding: { ...held.binding, listing_id: "2".repeat(32) } }));
      }
      return real(...args);
    }) as typeof real);
    try { mine.takeSibling(sibling); } finally { racing.mockRestore(); }
    expect(raced).toBe(true);
    const after = JSON.parse(readFileSync(join(sibling, ADMISSION_FILE), "utf8")) as { binding: { bind_id: string; listing_id?: string }; clears: { bind_id: string }[] };
    expect(after.clears.map((clear) => clear.bind_id)).toContain(first.bind_id);
    expect(after.binding).toMatchObject({ bind_id: other.bind_id, listing_id: "2".repeat(32) });
  });

  test("a folder closed for the other's pin writes nothing to the other folder either, a clear it would have taught it included", async () => {
    const [dir, sibling] = [stateDir(), stateDir()];
    const devices = store(dir);
    await linked(devices);
    await linked(store(sibling));
    const theirs = PcAccountState.open(sibling);
    expect(theirs.pinToList(theirs.binding()!.bind_id, LIST)).toBe(true);
    expect(devices.clearAccountBinding("revoke_all", "pc")).toBe(true);
    const [mineBefore, theirsBefore] = [readFileSync(join(dir, ADMISSION_FILE), "utf8"), readFileSync(join(sibling, ADMISSION_FILE), "utf8")];
    const mine = PcAccountState.open(dir);
    mine.takeSibling(sibling);
    expect(mine.strict).toContain(sibling);
    expect(readFileSync(join(dir, ADMISSION_FILE), "utf8")).toBe(mineBefore);
    expect(readFileSync(join(sibling, ADMISSION_FILE), "utf8")).toBe(theirsBefore);
  });

  test("a file that is there and cannot be read under the lock aborts the write: the pin another server wrote is not written over", async () => {
    const dir = stateDir();
    await linked(store(dir));
    const stale = PcAccountState.open(dir);
    const path = join(dir, ADMISSION_FILE);
    const disk = JSON.parse(readFileSync(path, "utf8")) as { gen: number; binding: object };
    const pinned = JSON.stringify({ ...disk, v: 2, gen: disk.gen + 1, binding: { ...disk.binding, list: LIST } });
    writeFileSync(path, pinned);
    // the disk gives an error for one read
    const failing = spyOn(bindingFs, "readFileSync").mockImplementation(() => { throw Object.assign(new Error("i/o error"), { code: "EIO" }); });
    try { expect(() => stale.admit("pc", "code", null, Date.now())).toThrow(); } finally { failing.mockRestore(); }
    expect(readFileSync(path, "utf8")).toBe(pinned);
    // and a file that does not parse is no missing file either
    writeFileSync(path, "{");
    expect(() => stale.admit("pc", "code", null, Date.now())).toThrow();
    expect(readFileSync(path, "utf8")).toBe("{");
    // the write goes through once the file reads again, and keeps the pin
    writeFileSync(path, pinned);
    stale.admit("pc", "code", null, Date.now());
    expect(PcAccountState.open(dir).binding()).toMatchObject({ list: LIST });
  });

  test("a lock that cannot be made ends the write with an error: nothing is written without the lock", async () => {
    const dir = stateDir();
    await linked(store(dir));
    const pc = PcAccountState.open(dir);
    const before = readFileSync(join(dir, ADMISSION_FILE), "utf8");
    const refused = spyOn(bindingFs, "openSync").mockImplementation(() => { throw Object.assign(new Error("no access"), { code: "EACCES" }); });
    try { expect(() => pc.admit("pc", "code", null, Date.now())).toThrow("cannot be locked"); } finally { refused.mockRestore(); }
    expect(readFileSync(join(dir, ADMISSION_FILE), "utf8")).toBe(before);
  });

  test("looking at the file again costs no read while it has not changed, and tells nobody of a change that is neither the binding nor the pin", async () => {
    const dir = stateDir();
    await linked(store(dir));
    const mine = PcAccountState.open(dir);
    let told = 0;
    mine.onBindingChange(() => { told++; });
    const reads = spyOn(bindingFs, "readFileSync");
    try {
      mine.refresh();
      mine.refresh();
      expect(reads).toHaveBeenCalledTimes(0);
      // another server on this folder records the listing its binding stands on: a pending approval here must stand
      const path = join(dir, ADMISSION_FILE);
      const disk = JSON.parse(readFileSync(path, "utf8")) as { binding: object };
      reads.mockClear();
      writeFileSync(path, JSON.stringify({ ...disk, binding: { ...disk.binding, listing_id: "1".repeat(32) } }));
      mine.refresh();
      expect(reads).toHaveBeenCalledTimes(1);
      expect(mine.binding()).toMatchObject({ listing_id: "1".repeat(32) });
      expect(told).toBe(0);
      mine.refresh();
      expect(reads).toHaveBeenCalledTimes(1);
    } finally { reads.mockRestore(); }
  });

  test("a stale lock that cannot be deleted ends the write with an error after its wait, and hangs nothing", async () => {
    const dir = stateDir();
    await linked(store(dir));
    const pc = PcAccountState.open(dir);
    const lock = `${join(dir, ADMISSION_FILE)}.lock`;
    writeFileSync(lock, "");
    utimesSync(lock, new Date(Date.now() - 60_000), new Date(Date.now() - 60_000));
    const stuck = spyOn(bindingFs, "unlinkSync").mockImplementation(() => { throw Object.assign(new Error("read-only"), { code: "EROFS" }); });
    const began = performance.now();
    try { expect(() => pc.admit("pc", "code", null, Date.now())).toThrow("another Ovis"); } finally { stuck.mockRestore(); }
    expect(performance.now() - began).toBeLessThan(5_000);
    rmSync(lock);
    expect(pc.admit("pc", "code", null, Date.now()).admit_no).toBeGreaterThan(0);
  });

  test("two writers of the binding's file take turns: one that finds the other at it waits, and a lock nobody holds any more is taken over", async () => {
    const dir = stateDir();
    await linked(store(dir));
    const pc = PcAccountState.open(dir);
    const lock = `${join(dir, ADMISSION_FILE)}.lock`;
    // a lock left by a server that ended while it wrote
    writeFileSync(lock, "");
    utimesSync(lock, new Date(Date.now() - 60_000), new Date(Date.now() - 60_000));
    expect(pc.pinToList(pc.binding()!.bind_id, LIST)).toBe(true);
    expect(existsSync(lock)).toBe(false);
    // one that another server holds right now is waited for, a moment, and the write then fails with nothing written
    writeFileSync(lock, "");
    expect(() => pc.admit("pc", "code", null, Date.now())).toThrow();
    rmSync(lock);
    expect(PcAccountState.open(dir).binding()).toMatchObject({ list: LIST });
  });

  test("a file that holds a pin or a list's removal is one an Ovis from before the list refuses to read; any other stays as it was", async () => {
    const dir = stateDir();
    const devices = store(dir);
    await linked(devices);
    const version = () => (JSON.parse(readFileSync(join(dir, ADMISSION_FILE), "utf8")) as { v: number }).v;
    expect(version()).toBe(1);
    const pc = PcAccountState.open(dir);
    expect(pc.pinToList(pc.binding()!.bind_id, LIST)).toBe(true);
    // an Ovis from before the list reads version 1 alone: it would hold this binding with no pin and go by the snapshot
    expect(version()).toBe(2);
    expect(PcAccountState.open(dir).binding()).toMatchObject({ list: LIST });
    // the pin gone with its binding, the file is one every Ovis reads again
    expect(devices.clearAccountBinding("revoke_all", "pc")).toBe(true);
    expect(version()).toBe(1);
    const again = store(dir);
    await linked(again);
    expect(again.clearAccountBinding("unlisted", "list", SERVER_ID)).toBe(true);
    expect(version()).toBe(2);
    expect(PcAccountState.open(dir).strict).toBeNull();
  });

  test("two folders pinned to two lists fail closed", async () => {
    const [dir, sibling] = [stateDir(), stateDir()];
    await linked(store(dir));
    const pinned = PcAccountState.open(dir);
    const binding = pinned.binding()!;
    writeFileSync(join(sibling, ADMISSION_FILE), readFileSync(join(dir, ADMISSION_FILE)));
    expect(pinned.pinToList(binding.bind_id, LIST)).toBe(true);
    expect(PcAccountState.open(sibling).pinToList(binding.bind_id, OTHER_LIST)).toBe(true);
    const split = PcAccountState.open(dir);
    split.takeSibling(sibling);
    expect(split.strict).toContain("two lists");
  });
});
