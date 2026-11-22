import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exportAccountKey, newRecordId, signSafetyRecord, type SafetyRecord } from "../../shared/account-records.ts";
import { DeviceStore } from "../devices.ts";
import { pcRecordId, SafetyLog } from "./safety-log.ts";

const AT = "2026-11-20T09:00:00.000Z";
/** A folder this process cannot write to: not one as root, nor on Windows, where the mode does not hold. */
const NO_CHMOD = process.platform === "win32" || process.getuid?.() === 0;
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) { chmodSync(dir, 0o700); rmSync(dir, { recursive: true, force: true }); } });

function dir(): string {
  const made = mkdtempSync(join(tmpdir(), "ovis-safety-strict-"));
  dirs.push(made);
  return made;
}
async function signer() {
  const keys = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
  return { keys, spki: await exportAccountKey(keys.publicKey) };
}
const pc = (kind: "lock" | "unlock" | "lift", account: string, target: string | null): SafetyRecord =>
  ({ v: 1, id: pcRecordId(), kind, account, target, signer: "pc", signed_at: AT, signature: "", ...(kind === "lift" ? { forget: false } : {}) }) as SafetyRecord;

describe("the safety log's endings and its failed writes (P24, S19)", () => {
  test("P24: an ending ends only a record of its own account", async () => {
    const log = SafetyLog.open(dir());
    const by = await signer();
    const block = await signSafetyRecord({ v: 1, kind: "block", account: "acct_1", target: (await signer()).spki, target_no: 3, signer: by.spki, signer_no: 1, signed_at: AT, nonce: newRecordId() }, by.keys.privateKey);
    const lock = pc("lock", "acct_1", null);
    for (const record of [block, lock]) log.append({ record, got: "pc", ...(record.kind === "block" ? { asof: { signer_no: 1, target_no: 3, after: 3, joined: 3, signer_removed: false } } : {}) });
    log.append({ record: pc("lift", "acct_2", block.id), got: "pc", cause: "screen" });
    log.append({ record: pc("unlock", "acct_2", lock.id), got: "pc" });
    expect(log.state().blocks.map((entry) => entry.record.id)).toEqual([block.id]);
    expect(log.state().locked).toBe(true);
    log.append({ record: pc("lift", "acct_1", block.id), got: "pc", cause: "screen" });
    log.append({ record: pc("unlock", "acct_1", lock.id), got: "pc" });
    expect(log.state().blocks).toEqual([]);
    expect(log.state().locked).toBe(false);
  });

  test.skipIf(NO_CHMOD)("S19: an append that cannot be written fails the PC closed until a reload finds the log whole, and every way in is refused meanwhile", async () => {
    const at = dir();
    const log = SafetyLog.open(at);
    const devices = new DeviceStore(at, null, null, { safety: log });
    const phone = await signer();
    const id = devices.pairRelay(devices.startPairing().code, "Phone", phone.spki)!.device.id;
    chmodSync(at, 0o500);
    expect(log.append({ record: pc("lock", "acct_1", null), got: "pc" })).toMatchObject({ outcome: "refused", code: "log_unavailable" });
    expect(log.strict).not.toBeNull();
    const nonce = crypto.getRandomValues(new Uint8Array(32));
    const serverId = "0123456789abcdef0123456789abcdef";
    const signature = Buffer.from(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, phone.keys.privateKey, Buffer.concat([Buffer.from("ovis-relay-auth/1"), nonce, Buffer.from(serverId)]))).toString("base64url");
    expect(await devices.matchRelay(id, nonce, signature, serverId)).toBeNull();
    expect(devices.pairRelay(devices.startPairing().code, "Tablet", (await signer()).spki)).toBeNull();
    expect(devices.pairRelayApproved("Tablet", (await signer()).spki, { path: "account", addedBy: id })).toBeNull();
    chmodSync(at, 0o700);
    // strict stays on this handle until a reload finds the log whole (S19)
    expect(log.append({ record: pc("lock", "acct_1", null), got: "pc" }).outcome).toBe("refused");
    expect(log.strict).not.toBeNull();
    expect(SafetyLog.open(at).strict).toBeNull();
  });

  test("S19: a strict log leaves the tombstone files' own start-up repair alone", () => {
    const at = dir();
    writeFileSync(join(at, "account-log.json"), "not json", { mode: 0o600 });
    const tombstone = { key: "k".repeat(87), account: "acct_1", record_id: "local", removed_at: AT };
    writeFileSync(join(at, "account-tombstones.pending.json"), JSON.stringify({ v: 1, tombstones: [tombstone] }), { mode: 0o600 });
    const log = SafetyLog.open(at);
    expect(log.strict).not.toBeNull();
    new DeviceStore(at, null, null, { safety: log });
    // the pending tombstone joins the main file and the pending file goes, as it does with the log whole
    expect(existsSync(join(at, "account-tombstones.pending.json"))).toBe(false);
    expect((JSON.parse(readFileSync(join(at, "account-tombstones.json"), "utf8")) as { tombstones: unknown[] }).tombstones).toHaveLength(1);
  });

  test.skipIf(NO_CHMOD)("S19: a sign-in whose proof was checked while the log turned strict is refused", async () => {
    const at = dir();
    const log = SafetyLog.open(at);
    const devices = new DeviceStore(at, null, null, { safety: log });
    const phone = await signer();
    const id = devices.pairRelay(devices.startPairing().code, "Phone", phone.spki)!.device.id;
    const nonce = crypto.getRandomValues(new Uint8Array(32));
    const serverId = "0123456789abcdef0123456789abcdef";
    const signature = Buffer.from(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, phone.keys.privateKey, Buffer.concat([Buffer.from("ovis-relay-auth/1"), nonce, Buffer.from(serverId)]))).toString("base64url");
    const pending = devices.matchRelay(id, nonce, signature, serverId);
    chmodSync(at, 0o500);
    log.append({ record: pc("lock", "acct_1", null), got: "pc" });
    chmodSync(at, 0o700);
    expect(await pending).toBeNull();
  });

  test("P24: an ending of another account folds nothing, and the marker it does not end stays", async () => {
    const at = dir();
    const log = SafetyLog.open(at);
    const by = await signer();
    const block = await signSafetyRecord({ v: 1, kind: "block", account: "acct_1", target: (await signer()).spki, target_no: 3, signer: by.spki, signer_no: 1, signed_at: AT, nonce: newRecordId() }, by.keys.privateKey);
    log.append({ record: block, got: "handed", asof: { signer_no: 1, target_no: 3, after: 3, joined: 3, signer_removed: false } });
    log.append({ record: pc("lift", "acct_1", block.id), got: "pc", cause: "screen" });
    log.append({ record: { ...pc("lift", "acct_2", block.id), forget: true } as SafetyRecord, got: "pc", cause: "screen" });
    expect(log.state().markers).toHaveLength(1);
    log.fold();
    expect(SafetyLog.open(at).state().markers).toHaveLength(1);
  });

  test("S19: a Revoke while the log is strict writes the main tombstone file", async () => {
    const at = dir();
    writeFileSync(join(at, "account-log.json"), "not json", { mode: 0o600 });
    const devices = new DeviceStore(at, null, null, { safety: SafetyLog.open(at) });
    const phone = await signer();
    const row = devices.pairRelay(devices.startPairing().code, "Phone", phone.spki);
    expect(row).toBeNull();
    writeFileSync(join(at, "devices.json"), JSON.stringify({ gate_closed_at: AT, devices: [{ id: "0123456789abcdef", label: "Phone", role: "drive", token_hash: "x".repeat(64), relay_public_key: phone.spki, created_at: AT, last_seen_at: null, account: "acct_1" }] }), { mode: 0o600 });
    const reopened = new DeviceStore(at, null, null, { safety: SafetyLog.open(at) });
    expect(reopened.revoke("0123456789abcdef")).toBe(true);
    expect(existsSync(join(at, "account-tombstones.pending.json"))).toBe(false);
    expect((JSON.parse(readFileSync(join(at, "account-tombstones.json"), "utf8")) as { tombstones: { key: string }[] }).tombstones.map((t) => t.key)).toEqual([phone.spki]);
  });

  test("S19: a log a merge could not make reads as locked", () => {
    const log = SafetyLog.open(dir(), "the sibling folder's log could not be read");
    expect(log.strict).not.toBeNull();
    expect(log.inForce.locked).toBe(true);
  });
});

