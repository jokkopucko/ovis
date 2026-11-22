import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exportAccountKey } from "../../shared/account-records.ts";
import { DeviceStore, readDeviceRegistry, ReplacementNeedsAppError } from "../devices.ts";
import { DeviceJournal } from "./device-journal.ts";
import { PcAccountState } from "./pc-binding.ts";
import { RemovalEvidence } from "./removal-evidence.ts";
import { SafetyLog } from "./safety-log.ts";

const ACCOUNT = "acct_1";
const FIVE_MINUTES = 5 * 60_000;
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

const key = async () => exportAccountKey((await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign"])).publicKey);

function open(dir: string) {
  const log = SafetyLog.open(dir);
  const pc = PcAccountState.open(dir);
  return { pc, devices: new DeviceStore(dir, null, null, { safety: log, pc, removals: RemovalEvidence.open(dir, log), journal: DeviceJournal.open(dir, () => log.ensureFile()) }) };
}
function pc() {
  const dir = mkdtempSync(join(tmpdir(), "ovis-link-replacement-"));
  dirs.push(dir);
  return { dir, ...open(dir) };
}
const row = (dir: string, id: string) => {
  const read = readDeviceRegistry(join(dir, "devices.json"));
  return read.kind === "ok" ? read.devices.find((d) => d.id === id) : undefined;
};

async function screenApproved(devices: DeviceStore): Promise<{ id: string; key: string }> {
  const k = await key();
  const redeemed = devices.redeemCode(devices.startPairing().code, "code", k);
  if (!redeemed.ok) throw new Error(redeemed.reason);
  const id = devices.admitConfirmed({ codeId: redeemed.codeId, key: k, label: "Phone", source: "screen" })!.id;
  return { id, key: k };
}

test("flag off: a key move preserves a legacy registry's null gate timestamp", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ovis-legacy-link-"));
  dirs.push(dir);
  const path = join(dir, "devices.json");
  const old = await key();
  const next = await key();
  const device = { id: "0011223344556677", label: "Phone", role: "drive", token_hash: "a".repeat(64),
    relay_public_key: old, created_at: "2026-10-01T00:00:00.000Z", last_seen_at: null };
  writeFileSync(path, JSON.stringify({ gate_closed_at: null, devices: [device] }), { mode: 0o600 });
  const store = new DeviceStore(dir);
  expect(store.linkAccountKey(device.id, old, next, ACCOUNT)?.id).toBe(device.id);
  expect(readDeviceRegistry(path)).toMatchObject({
    gateClosedAt: null, devices: [{ id: device.id, relay_public_key: next }],
  });
  expect(store.gated).toBe(true);
});

describe("a key approved on this PC's screen is replaced only by a confirm of its own (P22, T7, T11, T72, T59)", () => {
  test("T7: a link that moves a screen-approved key changes nothing at once: the new key waits as a replacement", async () => {
    const { dir, devices } = pc();
    const approved = await screenApproved(devices);
    const before = row(dir, approved.id)!;
    const next = await key();
    devices.linkAccountKey(approved.id, approved.key, next, ACCOUNT, "", false, true);
    expect(row(dir, approved.id)).toEqual(before);
    expect(devices.pendingReplacement(approved.id)).toMatchObject({ key: next, account: ACCOUNT });
  });

  test("T72: the replacement takes the row only by its own confirm; the row keeps pc with how link and a new number", async () => {
    const { dir, devices, pc: state } = pc();
    const approved = await screenApproved(devices);
    const next = await key();
    devices.linkAccountKey(approved.id, approved.key, next, ACCOUNT, "", false, true);
    expect(devices.replaceConfirmed({ row: approved.id, key: await key(), source: "screen" })).toBeNull();
    expect(devices.replaceConfirmed({ row: approved.id, key: next, source: "screen" })).toMatchObject({ id: approved.id });
    expect(row(dir, approved.id)).toMatchObject({ relay_public_key: next, account: ACCOUNT, origin: { from: "pc", how: "link", admit_no: 2 } });
    expect(state.account()).toBe(ACCOUNT);
    expect(devices.pendingReplacement(approved.id)).toBeNull();
    expect(devices.replaceConfirmed({ row: approved.id, key: next, source: "screen" })).toBeNull();
  });

  test("T72: a second link while one waits replaces it with a new challenge, and only the newest key can be confirmed", async () => {
    const { devices } = pc();
    const approved = await screenApproved(devices);
    const [first, second] = [await key(), await key()];
    devices.linkAccountKey(approved.id, approved.key, first, ACCOUNT, "", false, true);
    const firstChallenge = devices.pendingReplacement(approved.id)!.challenge;
    devices.linkAccountKey(approved.id, approved.key, second, ACCOUNT, "", false, true);
    expect(devices.pendingReplacement(approved.id)).toMatchObject({ key: second, challenge: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/) });
    expect(devices.pendingReplacement(approved.id)!.challenge).not.toBe(firstChallenge);
    expect(devices.replaceConfirmed({ row: approved.id, key: first, source: "screen" })).toBeNull();
  });

  test("P22: declined, unanswered for five minutes, or a restart: the replacement is dropped and the approved key stays", async () => {
    const { dir, devices } = pc();
    const approved = await screenApproved(devices);
    const next = await key();
    devices.linkAccountKey(approved.id, approved.key, next, ACCOUNT, "", false, true);
    devices.declineReplacement(approved.id);
    expect(devices.pendingReplacement(approved.id)).toBeNull();

    devices.linkAccountKey(approved.id, approved.key, next, ACCOUNT, "", false, true);
    // past the time the replacement was stamped with, not a clock read before the link (it can be a millisecond later)
    const { at } = devices.pendingReplacement(approved.id)!;
    expect(devices.replaceConfirmed({ row: approved.id, key: next, source: "screen" }, at + FIVE_MINUTES + 1)).toBeNull();
    expect(devices.pendingReplacement(approved.id)).toBeNull();

    devices.linkAccountKey(approved.id, approved.key, next, ACCOUNT, "", false, true);
    const restarted = open(dir).devices;
    expect(restarted.pendingReplacement(approved.id)).toBeNull();
    expect(row(dir, approved.id)).toMatchObject({ relay_public_key: approved.key, origin: { from: "pc" } });
  });

  test("T7: an app that cannot compare a replacement is refused and nothing changes: no replacement waits, the old key stays", async () => {
    const { dir, devices } = pc();
    const approved = await screenApproved(devices);
    const before = row(dir, approved.id)!;
    expect(() => devices.linkAccountKey(approved.id, approved.key, "MFkw" + "A".repeat(87), ACCOUNT)).toThrow(ReplacementNeedsAppError);
    expect(devices.pendingReplacement(approved.id)).toBeNull();
    expect(row(dir, approved.id)).toEqual(before);
  });

  test("T11: a link that moves a key of a row not approved on the screen admits the new key with a number of its own", async () => {
    const { dir, devices } = pc();
    const old = await key();
    const id = devices.pairRelay(devices.startPairing().code, "Phone", old)!.device.id;
    const next = await key();
    devices.linkAccountKey(id, old, next, ACCOUNT);
    expect(devices.pendingReplacement(id)).toBeNull();
    expect(row(dir, id)).toMatchObject({ relay_public_key: next, origin: { from: "remote", how: "link", admit_no: 2 } });
  });

  test("T59: no link sets the first device's list key: it stays empty this release, so T67 never applies", async () => {
    const { devices, pc: state } = pc();
    const k = await key();
    const id = devices.pairRelay(devices.startPairing().code, "Phone", k)!.device.id;
    devices.linkAccountKey(id, k, k, ACCOUNT);
    expect(state.first()).toEqual({ key: k, list_key: null });
    const approved = await screenApproved(devices);
    const next = await key();
    devices.linkAccountKey(approved.id, approved.key, next, ACCOUNT, "", false, true);
    devices.replaceConfirmed({ row: approved.id, key: next, source: "screen" });
    expect(state.first()).toEqual({ key: k, list_key: null });
  });


  test("T7, T72: a row waiting to link that links with another key joins nobody until that key is confirmed on this PC's screen", async () => {
    const { dir, devices } = pc();
    const { code } = devices.startAccountPairing(ACCOUNT);
    const first = await key();
    const id = devices.pairRelay(code, "Phone", first)!.device.id;
    const next = await key();
    // only an app that shows the fingerprint may ask, as for a stored row
    expect(() => devices.linkAccountKey(id, first, next, ACCOUNT)).toThrow(ReplacementNeedsAppError);
    expect(devices.linkAccountKey(id, first, next, ACCOUNT, "", false, true)).toMatchObject({ id });
    // no member, no binding, nothing on disk: the new key waits for its confirm
    expect(row(dir, id)).toBeUndefined();
    expect(devices.account()).toBeNull();
    expect(devices.pendingReplacement(id)).toMatchObject({ key: next, account: ACCOUNT });
    // the waiting row outlives its link window while the replacement waits on the screen
    expect(devices.replaceConfirmed({ row: id, key: first, source: "screen" })).toBeNull();
    expect(devices.replaceConfirmed({ row: id, key: next, source: "screen" })).toMatchObject({ id });
    expect(row(dir, id)).toMatchObject({ relay_public_key: next, account: ACCOUNT, origin: expect.objectContaining({ from: "pc" }) });
    expect(devices.account()).toBe(ACCOUNT);
  });

  test("T7: a declined or expired replacement of a waiting row admits nobody, and the same-key link still joins", async () => {
    const { dir, devices } = pc();
    const { code } = devices.startAccountPairing(ACCOUNT);
    const first = await key();
    const id = devices.pairRelay(code, "Phone", first)!.device.id;
    devices.linkAccountKey(id, first, await key(), ACCOUNT, "", false, true);
    devices.declineReplacement(id);
    expect(devices.pendingReplacement(id)).toBeNull();
    expect(devices.linkAccountKey(id, first, first, ACCOUNT)).toMatchObject({ id });
    expect(row(dir, id)).toMatchObject({ relay_public_key: first, account: ACCOUNT });
  });
});
