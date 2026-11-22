import { afterEach, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DeviceStore, readDeviceRegistry, type StoredDevice } from "../devices.ts";
import { mergeRegistries } from "../state-merge.ts";
import { relayFixture } from "../relay/test-helpers.ts";
import { ADMISSION_FILE, compareAdmission, isRowOrigin, remoteReach } from "./admission-order.ts";
import { PcAccountState } from "./pc-binding.ts";
import { CatchUpGate } from "./catch-up-gate.ts";
import { DEVICE_JOURNAL_FILE, SafetyLog } from "./safety-log.ts";

const dirs: string[] = [];
const fixtures: ReturnType<typeof relayFixture>[] = [];
afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function stateDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "ovis-admission-order-"));
  dirs.push(dir);
  return dir;
}

async function key(): Promise<string> {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  return Buffer.from(await crypto.subtle.exportKey("spki", pair.publicKey)).toString("base64url");
}

const store = (dir: string) => new DeviceStore(dir, null, null, { pc: PcAccountState.open(dir) });

async function pairRelay(devices: DeviceStore, now: number): Promise<string> {
  const paired = devices.pairRelay(devices.startPairing(now).code, "Phone", await key(), now);
  if (!paired) throw new Error("pairing failed");
  return paired.device.id;
}

const rows = (dir: string): StoredDevice[] => {
  const registry = readDeviceRegistry(join(dir, "devices.json"));
  if (registry.kind !== "ok") throw new Error("devices.json unreadable");
  return registry.devices;
};
const row = (dir: string, id: string) => rows(dir).find((device) => device.id === id)!;

function legacyRow(created_at: string, extra: Partial<StoredDevice> = {}): StoredDevice {
  return { id: randomBytes(8).toString("hex"), label: "Old phone", role: "drive", token_hash: randomBytes(32).toString("hex"), created_at, last_seen_at: null, ...extra };
}

describe("one admission order per PC (origin and admit_no)", () => {
  test.each(["order", "catch-up"] as const)("a new cookie issued during service opt-out retains its real %s", async check => {
    const dir = stateDir();
    const pc = PcAccountState.open(dir);
    pc.migrate("acct_1", true);
    const devices = new DeviceStore(dir, null, null, { pc, safety: SafetyLog.open(dir) });
    const older = await pairRelay(devices, Date.now() - 1000);
    expect(pc.setServiceStep2Off(true)).toBe(true);
    const browser = devices.pair(devices.startPairing().code, "Opt-out browser", "drive");
    if (!browser) throw new Error("Missing locally issued cookie");
    const id = browser.device.id;
    expect(devices.match(browser.token)?.id).toBe(id);
    expect(pc.setServiceStep2Off(false)).toBe(true);
    const reopened = new DeviceStore(dir, null, null, { pc: PcAccountState.open(dir), safety: SafetyLog.open(dir) });
    if (check === "order") {
      expect({ olderMemberReachesNewRow: remoteReach(row(dir, older), row(dir, id)),
        cookieMayRevokeOlderMember: reopened.remoteRevoke(id, older) === "allowed" })
        .toEqual({ olderMemberReachesNewRow: true, cookieMayRevokeOlderMember: false });
    } else {
      const gate = new CatchUpGate(() => pc.binding()?.bind_id ?? null);
      reopened.attachCatchUp(gate);
      expect(reopened.catchingUp(id)).toBe(true);
      gate.wholeRead();
      expect(reopened.match(browser.token)?.id).toBe(id);
    }
  });

  test("P21: PC admission order wins when service or journal order disagrees", async () => {
    const dir = stateDir();
    const devices = store(dir);
    const base = Date.parse("2026-11-20T10:00:00.000Z");
    // admitted first on this PC, with a clock that later reads earlier: the PC's own order, not a time, decides
    const first = await pairRelay(devices, base + 60_000);
    const second = await pairRelay(devices, base);
    expect(row(dir, first).origin).toMatchObject({ from: "remote", how: "code", admit_no: 1 });
    expect(row(dir, second).origin).toMatchObject({ from: "remote", how: "code", admit_no: 2 });
    expect(row(dir, second).created_at < row(dir, first).created_at).toBe(true);
    expect(compareAdmission(row(dir, first), row(dir, second))).toBe("older");
    expect(compareAdmission(row(dir, second), row(dir, first))).toBe("newer");

    // a number is never used again: not after a Revoke, not after a restart
    expect(devices.revoke(second)).toBe(true);
    const reopened = store(dir);
    const third = await pairRelay(reopened, base + 120_000);
    expect(row(dir, third).origin?.admit_no).toBe(3);
    expect(JSON.parse(readFileSync(join(dir, ADMISSION_FILE), "utf8"))).toMatchObject({ v: 1, next_admit: 4 });

    // a cookie pairing takes the next number of the same order
    const cookie = reopened.pair(reopened.startPairing().code, "Laptop", "drive")!;
    expect(row(dir, cookie.device.id).origin).toMatchObject({ from: "remote", how: "code", admit_no: 4 });
  });

  test("T50: existing rows get legacy origins once and keep comparable creation order", () => {
    const dir = stateDir();
    const older = legacyRow("2026-10-01T00:00:00.000Z");
    const tiedA = legacyRow("2026-10-02T00:00:00.000Z");
    const tiedB = legacyRow("2026-10-02T00:00:00.000Z");
    writeFileSync(join(dir, "devices.json"), JSON.stringify({ gate_closed_at: older.created_at, devices: [older, tiedA, tiedB] }), { mode: 0o600 });

    const devices = store(dir);
    for (const legacy of [older, tiedA, tiedB]) expect(row(dir, legacy.id).origin).toEqual({ from: "legacy", how: "legacy", by: null, admit_no: 0, at: legacy.created_at });
    expect(JSON.parse(readFileSync(join(dir, ADMISSION_FILE), "utf8"))).toMatchObject({ v: 1, next_admit: 1 });
    // legacy rows keep the creation order they had; a tie stays a tie
    expect(compareAdmission(row(dir, older.id), row(dir, tiedA.id))).toBe("older");
    expect(compareAdmission(row(dir, tiedA.id), row(dir, tiedB.id))).toBeNull();
    // every later admission is newer than every legacy row
    const { device } = devices.pair(devices.startPairing().code, "New", "drive")!;
    expect(compareAdmission(row(dir, tiedB.id), row(dir, device.id))).toBe("older");

    // once only: a row that lost its origin afterwards is not stamped again, and has no age
    const edited = rows(dir).map((stored) => stored.id === older.id ? { ...stored, origin: undefined } : stored);
    writeFileSync(join(dir, "devices.json"), JSON.stringify({ gate_closed_at: older.created_at, devices: edited }), { mode: 0o600 });
    store(dir);
    expect(row(dir, older.id).origin).toBeUndefined();
    expect(compareAdmission(row(dir, older.id), row(dir, tiedA.id))).toBeNull();

    // a missing order file beside a journal is damage, never a second run: the PC fails closed
    const journalled = stateDir();
    writeFileSync(join(journalled, "devices.json"), JSON.stringify({ gate_closed_at: older.created_at, devices: [older] }), { mode: 0o600 });
    writeFileSync(join(journalled, DEVICE_JOURNAL_FILE), JSON.stringify({ v: 1, entries: [] }), { mode: 0o600 });
    const admissions = PcAccountState.open(journalled);
    expect(admissions.strict).toContain(ADMISSION_FILE);
    const closed = new DeviceStore(journalled, null, null, { pc: admissions });
    expect(closed.pair(closed.startPairing().code, "New", "drive")).toBeNull();
    expect(row(journalled, older.id).origin).toBeUndefined();
    expect(existsSync(join(journalled, ADMISSION_FILE))).toBe(false);
  });

  test("T19: tied or unorderable rows grant no cross-key remote authority", async () => {
    const dir = stateDir();
    const legacyA = legacyRow("2026-10-02T00:00:00.000Z");
    const legacyB = legacyRow("2026-10-02T00:00:00.000Z");
    writeFileSync(join(dir, "devices.json"), JSON.stringify({ gate_closed_at: legacyA.created_at, devices: [legacyA, legacyB] }), { mode: 0o600 });
    const devices = store(dir);
    const caller = await pairRelay(devices, Date.now());
    const newer = await pairRelay(devices, Date.now());
    const at = (id: string) => row(dir, id);

    // itself, and the rows that joined this PC after it
    expect(remoteReach(at(caller), at(caller))).toBe(true);
    expect(remoteReach(at(caller), at(newer))).toBe(true);
    // never an older row, and never one it cannot be placed against
    expect(remoteReach(at(newer), at(caller))).toBe(false);
    expect(remoteReach(at(caller), at(legacyA.id))).toBe(false);
    expect(remoteReach(at(legacyA.id), at(legacyB.id))).toBe(false);
    expect(remoteReach(at(legacyB.id), at(legacyA.id))).toBe(false);
    const noOrigin = { ...at(newer), origin: undefined };
    expect(remoteReach(at(caller), noOrigin)).toBe(false);
    expect(remoteReach(noOrigin, at(caller))).toBe(false);

    // a merge keeps an origin only when both copies hold the same one; a row only the other dir holds has none here
    // (P22, T27 in 2d)
    const other = { ...at(newer), origin: { ...at(newer).origin!, admit_no: 9 } };
    const onlyThere = { ...at(caller), id: randomBytes(8).toString("hex") };
    const merged = mergeRegistries({ gate_closed_at: null, devices: [at(caller), at(newer)] }, { gate_closed_at: null, devices: [at(caller), other, onlyThere] }, { own: null, other: null });
    expect(merged.devices.find((d) => d.id === caller)?.origin).toEqual(at(caller).origin);
    expect(merged.devices.find((d) => d.id === newer)?.origin).toBeUndefined();
    expect(merged.devices.find((d) => d.id === onlyThere.id)?.origin).toBeUndefined();
    // a copy linked later in the other folder brings a key this folder never admitted: the row keeps no origin here,
    // so that key reaches no row admitted in between (P22: an origin describes the key the row holds)
    const relinked = { ...at(caller), relay_public_key: "moved-key", account: "acct", linked_at: new Date(Date.now() + 1000).toISOString(), link_moved_key: true };
    const taken = mergeRegistries({ gate_closed_at: null, devices: [at(caller)] }, { gate_closed_at: null, devices: [relinked] }, { own: null, other: null }).devices[0]!;
    expect(taken.relay_public_key).toBe("moved-key");
    expect(taken.origin).toBeUndefined();
  });

  test("P22: with the release flag off no row gets an origin and no order file is written", async () => {
    const fixture = relayFixture(false, { accountOpensAll: false });
    fixtures.push(fixture);
    const devices = fixture.app.context.services.devices;
    const id = devices.pairRelay(devices.startPairing().code, "Phone", await key())!.device.id;
    expect(row(fixture.stateDir, id).origin).toBeUndefined();
    expect(existsSync(join(fixture.stateDir, ADMISSION_FILE))).toBe(false);

    const on = relayFixture(false, { accountOpensAll: true });
    fixtures.push(on);
    const onDevices = on.app.context.services.devices;
    const onId = onDevices.pairRelay(onDevices.startPairing().code, "Phone", await key())!.device.id;
    expect(row(on.stateDir, onId).origin).toMatchObject({ from: "remote", how: "code", admit_no: 1 });
  });

  test("T50: only this PC's one-time upgrade pass stamps a row legacy", async () => {
    // (a) the stamp is admit_no 0 with from legacy, and only that
    const at = "2026-10-01T00:00:00.000Z";
    expect(isRowOrigin({ from: "legacy", how: "legacy", by: null, admit_no: 0, at })).toBe(true);
    expect(isRowOrigin({ from: "remote", how: "code", by: null, admit_no: 0, at })).toBe(false);
    expect(isRowOrigin({ from: "legacy", how: "legacy", by: null, admit_no: 1, at })).toBe(false);
    // (b) a row the other dir alone holds, or whose copies disagree, claims legacy for nothing after a merge
    const ours = { ...legacyRow(at), origin: { from: "remote" as const, how: "code" as const, by: null, admit_no: 3, at } };
    const claimed = { ...ours, origin: { from: "legacy" as const, how: "legacy" as const, by: null, admit_no: 0, at } };
    const stranger = { ...legacyRow(at), origin: claimed.origin };
    const merged = mergeRegistries({ gate_closed_at: null, devices: [ours] }, { gate_closed_at: null, devices: [claimed, stranger] }, { own: null, other: null });
    expect(merged.devices.find((d) => d.id === ours.id)?.origin).toBeUndefined();
    expect(merged.devices.find((d) => d.id === stranger.id)?.origin).toBeUndefined();
    // (c) after the pass every admission takes a number of its own, and a row added by hand later is never stamped
    const dir = stateDir();
    writeFileSync(join(dir, "devices.json"), JSON.stringify({ gate_closed_at: at, devices: [legacyRow(at)] }), { mode: 0o600 });
    const devices = store(dir);
    const added = await pairRelay(devices, Date.now());
    expect(row(dir, added).origin).toMatchObject({ from: "remote", admit_no: 1 });
    const late = legacyRow(at);
    writeFileSync(join(dir, "devices.json"), JSON.stringify({ gate_closed_at: at, devices: [...rows(dir), late] }), { mode: 0o600 });
    store(dir);
    expect(row(dir, late.id).origin).toBeUndefined();
  });

  test("P21: rows that carry numbers beside a missing order file are damage, never a fresh count", async () => {
    const dir = stateDir();
    const devices = store(dir);
    await pairRelay(devices, Date.now());
    await pairRelay(devices, Date.now());
    rmSync(join(dir, ADMISSION_FILE));
    const reopened = store(dir);
    expect(reopened.accountError).not.toBeNull();
    expect(reopened.pairRelay(reopened.startPairing().code, "New", (await key()))).toBeNull();
    expect(rows(dir).every((row) => row.origin?.from !== "legacy")).toBe(true);
  });

  test("T50: nothing is numbered before the one-time legacy pass has run", () => {
    const order = PcAccountState.open(stateDir());
    expect(order.migrating).toBe(true);
    expect(() => order.admit("remote", "code", null, Date.now())).toThrow();
    order.migrate(null, false);
    expect(order.admit("remote", "code", null, Date.now()).admit_no).toBe(1);
  });

  test("P22: a link names no approver: a member's code pending while another device links gives it no `by`", async () => {
    const dir = stateDir();
    const memberKey = await key();
    const member = legacyRow("2026-10-01T00:00:00.000Z", { relay_public_key: memberKey, account: "acct", linked_at: "2026-10-01T00:00:00.000Z" });
    writeFileSync(join(dir, "devices.json"), JSON.stringify({ gate_closed_at: member.created_at, devices: [member] }), { mode: 0o600 });
    const devices = store(dir);
    const oldKey = await key();
    const linking = devices.pairRelay(devices.startPairing().code, "Phone", oldKey)!.device.id;
    devices.startPairing(Date.now(), { remote: true, startedBy: member.id, memberRequired: true, by: null });
    devices.linkAccountKey(linking, oldKey, await key(), "acct");
    expect(row(dir, linking).origin).toMatchObject({ how: "link", by: null });
    // the member's own code on this PC's screen names the member
    const cookie = devices.pair(devices.startPairing(Date.now(), { remote: true, startedBy: member.id, memberRequired: true, by: null }).code, "Laptop", "drive")!.device.id;
    expect(row(dir, cookie).origin).toMatchObject({ how: "member", by: memberKey });
  });

  test("S19: a legacy pass that cannot be written leaves this PC strict, not a failed start", () => {
    const dir = stateDir();
    writeFileSync(join(dir, "devices.json"), JSON.stringify({ gate_closed_at: "2026-10-01T00:00:00.000Z", devices: [legacyRow("2026-10-01T00:00:00.000Z")] }), { mode: 0o600 });
    chmodSync(dir, 0o500);
    try {
      const devices = store(dir);
      expect(devices.failsClosed).toBe(true);
    } finally { chmodSync(dir, 0o700); }
  });
});
