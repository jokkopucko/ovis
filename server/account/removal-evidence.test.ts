import { afterEach, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newRecordId } from "../../shared/account-records.ts";
import { DeviceStore, readDeviceRegistry, type StoredDevice } from "../devices.ts";
import { PcAccountState } from "./pc-binding.ts";
import { REMOVAL_FILE, RemovalEvidence } from "./removal-evidence.ts";
import { pcRecordId, SafetyLog } from "./safety-log.ts";

const ACCOUNT = "acct_1";
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function stateDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "ovis-removal-evidence-"));
  dirs.push(dir);
  return dir;
}

async function key(): Promise<string> {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  return Buffer.from(await crypto.subtle.exportKey("spki", pair.publicKey)).toString("base64url");
}

function store(dir: string): DeviceStore {
  const safety = SafetyLog.open(dir);
  return new DeviceStore(dir, null, null, { safety, pc: PcAccountState.open(dir), removals: RemovalEvidence.open(dir, safety) });
}

const evidence = (dir: string) => JSON.parse(readFileSync(join(dir, REMOVAL_FILE), "utf8")) as {
  v: number;
  markers: { key: string; account: string; removals: { id: string; over: string[]; tomb: string }[] }[];
  revokes: { id: string; key: string; account: string | null; at: string }[];
  unrevokes: { id: string; revoke: string; by: string }[];
};
const tombstones = (dir: string) => (JSON.parse(readFileSync(join(dir, "account-tombstones.json"), "utf8")) as { tombstones: { key: string; account: string; record_id: string }[] }).tombstones;
const rows = (dir: string): StoredDevice[] => {
  const registry = readDeviceRegistry(join(dir, "devices.json"));
  if (registry.kind !== "ok") throw new Error("devices.json unreadable");
  return registry.devices;
};
const removal = () => ({ id: newRecordId(), issuedAt: new Date().toISOString() });

/** A pairing on this PC, using a screen confirm with the Revoke IDs when needed (P13). */
function pairHere(devices: DeviceStore, publicKey: string): string {
  const revokes = (devices as unknown as { evidence: RemovalEvidence }).evidence.standingRevokes(publicKey);
  if (revokes.length === 0) {
    const paired = devices.pairRelay(devices.startPairing().code, "Phone", publicKey);
    if (!paired) throw new Error("pairing failed");
    return paired.device.id;
  }
  const { codeId } = devices.redeemCode(devices.startPairing().code, "code", publicKey) as { codeId: string };
  const confirmed = devices.admitConfirmed({ codeId, key: publicKey, label: "Phone", source: "screen", unrevokes: revokes.map((revoke) => revoke.id) });
  if (!confirmed) throw new Error("confirm failed");
  return confirmed.id;
}

describe("account removals and local Revokes kept apart (account-removed.json)", () => {
  test("T16: a valid remove with no local row still records account-scoped evidence", async () => {
    const dir = stateDir();
    const devices = store(dir);
    const k = await key();
    const signed = removal();
    expect(devices.removeAccountKey(k, ACCOUNT, signed)).toBe(true);
    expect(evidence(dir).markers).toEqual([{ key: k, account: ACCOUNT, removals: [expect.objectContaining({ id: signed.id, over: [], tomb: signed.id })] }]);
    expect(tombstones(dir)).toEqual([expect.objectContaining({ key: k, account: ACCOUNT, record_id: signed.id })]);
    expect(devices.removedByAccount(k)).toBe(true);
    // the same remove again changes nothing
    expect(devices.removeAccountKey(k, ACCOUNT, signed)).toBe(false);
    expect(evidence(dir).markers[0]!.removals).toHaveLength(1);

    // no time is compared: a row of the key paired here after the remove was signed goes all the same
    const late = await key();
    const old = { id: newRecordId(), issuedAt: "2026-01-01T00:00:00.000Z" };
    const id = pairHere(devices, late);
    devices.linkAccountKey(id, late, late, ACCOUNT);
    expect(devices.removeAccountKey(late, ACCOUNT, old)).toBe(true);
    expect(rows(dir).some((row) => row.id === id)).toBe(false);
  });

  test("T21: account removal blocks screen re-pair; an unrevoke never clears account evidence", async () => {
    const dir = stateDir();
    const devices = store(dir);
    const k = await key();
    devices.revoke(pairHere(devices, k));
    const [revoke] = evidence(dir).revokes;
    expect(revoke).toMatchObject({ key: k });
    const signed = removal();
    devices.removeAccountKey(k, ACCOUNT, signed);
    const redeemed = devices.redeemCode(devices.startPairing().code, "code", k);
    if (!redeemed.ok || revoke === undefined) throw new Error("Expected a reservation and a standing Revoke");
    expect(devices.admitConfirmed({ codeId: redeemed.codeId, key: k, label: "Phone", source: "screen", unrevokes: [revoke.id] })).toBeNull();
    expect(evidence(dir).unrevokes).toEqual([]);
    expect(devices.hasKey(k)).toBe(false);
    // The evidence operation itself ends only the local Revoke, even with both kinds of removal on disk.
    expect(RemovalEvidence.open(dir, SafetyLog.open(dir)).unrevoke(k, "pc", Date.now())).toBe(1);
    expect(evidence(dir).unrevokes).toEqual([expect.objectContaining({ revoke: revoke!.id })]);
    expect(evidence(dir).markers[0]!.removals.map((r) => r.id)).toEqual([signed.id]);
    expect(tombstones(dir)).toEqual([expect.objectContaining({ key: k, record_id: signed.id })]);
  });

  test("T22: taking an account removal preserves a pre-existing local Revoke", async () => {
    const dir = stateDir();
    const devices = store(dir);
    const k = await key();
    devices.revoke(pairHere(devices, k));
    const [revoke] = evidence(dir).revokes;
    devices.removeAccountKey(k, ACCOUNT, removal());
    // the account's tombstone shows; the Revoke stays its own evidence, never coalesced into it
    expect(evidence(dir).revokes).toEqual([revoke!]);
    expect(tombstones(dir)[0]!.record_id).not.toBe("local");
    // forgetting the account's removal brings the PC's own Revoke back into the tombstone file
    SafetyLog.open(dir).append({ record: { v: 1, id: pcRecordId(), kind: "forget", account: ACCOUNT, target: k, signer: "pc", signed_at: new Date().toISOString(), signature: "" }, got: "pc" });
    const reopened = store(dir);
    expect(tombstones(dir)).toEqual([expect.objectContaining({ key: k, record_id: "local" })]);
    expect(reopened.isTombstoned(k)).toBe(true);
    expect(reopened.removedByAccount(k)).toBe(false);
    // folding the forget record into the log's base keeps it held: the forgotten removal does not stand again (P13, T61)
    expect(SafetyLog.open(dir).fold()).toBeGreaterThan(0);
    expect(SafetyLog.open(dir).entries().some((entry) => entry.record.kind === "forget")).toBe(false);
    const folded = store(dir);
    expect(folded.removedByAccount(k)).toBe(false);
    expect(folded.isTombstoned(k)).toBe(true);
  });

  test("T23: an account marker blocks fresh pairing but preserves an old unlinked row that knew it", async () => {
    const dir = stateDir();
    const devices = store(dir);
    const member = await key();
    devices.linkAccountKey(pairHere(devices, member), member, member, ACCOUNT);
    const k = await key();
    const id = pairHere(devices, k);
    const unlinked = rows(dir).find((row) => row.id === id);
    if (unlinked === undefined) throw new Error("Expected an unlinked row");
    devices.linkAccountKey(id, k, k, ACCOUNT);
    const signed = removal();
    devices.removeAccountKey(k, ACCOUNT, signed);
    expect(devices.pairRelay(devices.startPairing().code, "Phone", k)).toBeNull();
    expect(devices.removedByAccount(k)).toBe(true);
    // A registry from before G3 was tightened could already have an unlinked row recording this removal.
    writeFileSync(join(dir, "devices.json"), JSON.stringify({
      gate_closed_at: unlinked.created_at, devices: [...rows(dir), { ...unlinked, paired_over: [signed.id] }],
    }), { mode: 0o600 });
    const reopened = store(dir);
    expect(rows(dir).find((row) => row.id === id)).toMatchObject({ paired_over: [signed.id] });
    expect(rows(dir).find((row) => row.id === id)?.account).toBeUndefined();
    expect(reopened.removeAccountKey(k, ACCOUNT, removal())).toBe(true);
    expect(rows(dir).some((row) => row.id === id)).toBe(false);
  });

  test("T26: load rebuilds tombstones after importing pending local evidence", async () => {
    const dir = stateDir();
    const [a, b, c] = [await key(), await key(), await key()];
    const row = (k: string, created_at: string): StoredDevice => ({ id: randomBytes(8).toString("hex"), label: "Phone", role: "drive", token_hash: randomBytes(32).toString("hex"), relay_public_key: k, created_at, last_seen_at: null });
    const rowB = row(b, "2026-10-01T00:00:00.000Z");
    const rowC = row(c, "2026-10-05T00:00:00.000Z");
    writeFileSync(join(dir, "devices.json"), JSON.stringify({ gate_closed_at: rowB.created_at, devices: [rowB, rowC] }), { mode: 0o600 });
    writeFileSync(join(dir, "account-tombstones.json"), JSON.stringify({ v: 1, tombstones: [{ key: a, account: ACCOUNT, record_id: "a".repeat(32), removed_at: "2026-10-02T00:00:00.000Z" }] }), { mode: 0o600 });
    writeFileSync(join(dir, "account-tombstones.pending.json"), JSON.stringify({ v: 1, tombstones: [
      { key: b, account: "", record_id: "local", removed_at: "2026-10-03T00:00:00.000Z" },
      { key: c, account: "", record_id: "local", removed_at: "2026-10-04T00:00:00.000Z" },
    ] }), { mode: 0o600 });

    store(dir);
    const kept = evidence(dir);
    // every local tombstone became a Revoke of its own; one older than a row of its key paired here was ended already
    expect(kept.revokes.map((r) => r.key).sort()).toEqual([b, c].sort());
    expect(kept.unrevokes.map((u) => kept.revokes.find((r) => r.id === u.revoke)?.key)).toEqual([c]);
    expect(kept.markers.map((m) => m.key)).toEqual([a]);
    // the tombstone file is written from the evidence, and the pending file is gone
    expect(tombstones(dir).map((t) => [t.key, t.record_id === "local"]).sort()).toEqual([[a, false], [b, true]].sort());
    expect(existsSync(join(dir, "account-tombstones.pending.json"))).toBe(false);
    expect(rows(dir).map((r) => r.id)).toEqual([rowC.id]);
    // a second load imports nothing twice
    store(dir);
    expect(evidence(dir).revokes).toHaveLength(2);
  });

  test("P13, T61: a ninth removal of one key never evicts a removal that still stands", async () => {
    const dir = stateDir();
    const evidence = RemovalEvidence.open(dir, null);
    const k = await key();
    for (let n = 0; n < 9; n++) evidence.addRemoval(k, ACCOUNT, { id: String(n).padStart(32, "0"), at: new Date(Date.UTC(2026, 9, 1 + n)).toISOString() });
    expect(evidence.standingMarkers(k).flatMap((m) => m.standing.map((r) => r.id))).toContain("0".repeat(32));
  });

  test("S19, P13: removal evidence written once and then deleted fails the PC closed, also with no device journal", async () => {
    const dir = stateDir();
    const devices = store(dir);
    devices.revoke(pairHere(devices, await key()));
    rmSync(join(dir, REMOVAL_FILE));
    expect(store(dir).failsClosed).toBe(true);
  });
});
