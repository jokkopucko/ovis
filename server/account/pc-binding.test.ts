import { afterEach, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exportAccountKey, newRecordId, signAccountRecord } from "../../shared/account-records.ts";
import { DeviceStore, type StoredDevice } from "../devices.ts";
import { relayConnection, relayDevice, relayFixture } from "../relay/test-helpers.ts";
import { ADMISSION_FILE } from "./admission-order.ts";
import { PcAccountState } from "./pc-binding.ts";
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
    expect(pcFile(dir).binding).toEqual({ account: ACCOUNT, bind_id: bindId });

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
