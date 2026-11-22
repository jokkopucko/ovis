import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exportAccountKey } from "../../shared/account-records.ts";
import { DeviceStore, PairingRateLimitedError } from "../devices.ts";
import { relayFixture, TestClock } from "../relay/test-helpers.ts";
import { DeviceJournal } from "./device-journal.ts";
import { PcAccountState } from "./pc-binding.ts";
import { RemovalEvidence } from "./removal-evidence.ts";
import { SafetyLog } from "./safety-log.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function dir(): string {
  const made = mkdtempSync(join(tmpdir(), "ovis-redeem-"));
  dirs.push(made);
  return made;
}
function store(at: string, opensAll = true): DeviceStore {
  if (!opensAll) return new DeviceStore(at);
  const log = SafetyLog.open(at);
  return new DeviceStore(at, null, null, { safety: log, pc: PcAccountState.open(at), removals: RemovalEvidence.open(at, log), journal: DeviceJournal.open(at, () => log.ensureFile()) });
}
async function key(): Promise<string> {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  return exportAccountKey(pair.publicKey);
}

describe("a code redeemed now, its key admitted on the PC's screen later (S2-13 seams, T5, T72)", () => {
  test("T72: a reservation binds one code to one named key and commits only through every guard", async () => {
    const devices = store(dir());
    const [named, other] = [await key(), await key()];
    const { code } = devices.startPairing();
    // a wrong code spends a guess like today's pairing, and reserves nothing
    expect(devices.redeemCode(code === "000000" ? "000001" : "000000", "code", named)).toMatchObject({ ok: false });
    const redeemed = devices.redeemCode(code, "code", named);
    expect(redeemed).toMatchObject({ ok: true });
    const codeId = (redeemed as { codeId: string }).codeId;
    // nothing is written by the redemption; another key reserves a use of its own (T71: up to five at once)
    expect(devices.list(null)).toHaveLength(0);
    expect(devices.redeemCode(code, "code", other)).toMatchObject({ ok: true, codeId });
    // a key never reserved, or another code id, admits nobody
    expect(devices.admitConfirmed({ codeId, key: await key(), label: "Other", source: "screen" })).toBeNull();
    expect(devices.admitConfirmed({ codeId: "f".repeat(32), key: named, label: "Phone", source: "screen" })).toBeNull();
    // the confirmed key gets the row, with an origin the store sets from where the confirm came from
    const admitted = devices.admitConfirmed({ codeId, key: named, label: "Phone", source: "screen" });
    expect(admitted).not.toBeNull();
    expect(devices.list(null).map((row) => row.id)).toEqual([admitted!.id]);
    // the use is spent: the same reservation admits nobody again, nor does the other key's, shown on screen or not
    expect(devices.admitConfirmed({ codeId, key: named, label: "Phone", source: "screen" })).toBeNull();
    expect(devices.admitConfirmed({ codeId, key: other, label: "Other", source: "screen" })).toBeNull();
    // a late release of a reservation already taken frees nothing: the next code is the only way in again
    devices.releaseRedemption(codeId, named);
    expect(devices.redeemCode(code, "code", other)).toMatchObject({ ok: false });
    // a release must name both the code and the key; a second release of the same one is a no-op
    const next = devices.startPairing();
    const { codeId: nextId } = devices.redeemCode(next.code, "code", other) as { codeId: string };
    devices.releaseRedemption(nextId, named);
    expect(devices.redeemCode(next.code, "code", named)).toMatchObject({ ok: true });
    devices.releaseRedemption(nextId, named);
    devices.releaseRedemption(nextId, other);
    devices.releaseRedemption(nextId, other);
    const third = await key();
    const { codeId: thirdId } = devices.redeemCode(next.code, "code", third) as { codeId: string };
    devices.releaseRedemption(nextId, other);
    expect(devices.admitConfirmed({ codeId: thirdId, key: third, label: "Tablet", source: "screen" })).not.toBeNull();
  });

  test("T72: a released or restarted reservation admits nobody, and a removed key is refused at commit", async () => {
    const at = dir();
    const devices = store(at);
    const named = await key();
    const { code } = devices.startPairing();
    const { codeId } = devices.redeemCode(code, "code", named) as { codeId: string };
    devices.releaseRedemption(codeId, named);
    expect(devices.admitConfirmed({ codeId, key: named, label: "Phone", source: "screen" })).toBeNull();
    // a restart ends every reservation
    const second = store(at);
    const fresh = second.startPairing();
    const { codeId: id2 } = second.redeemCode(fresh.code, "code", named) as { codeId: string };
    expect(store(at).admitConfirmed({ codeId: id2, key: named, label: "Phone", source: "screen" })).toBeNull();
    // a key removed between the redemption and the confirm is refused in the commit turn
    const removed: string[] = [];
    second.onKeyRemoved((gone) => removed.push(gone));
    second.removeAccountKey(named, "acct_1", { id: "a".repeat(32), issuedAt: new Date().toISOString() });
    expect(removed).toEqual([named]);
    expect(second.admitConfirmed({ codeId: id2, key: named, label: "Phone", source: "screen" })).toBeNull();
  });

  test("P22: with the release flag off the seams take no code and pairRelay is today's", async () => {
    const devices = store(dir(), false);
    const named = await key();
    const { code } = devices.startPairing();
    expect(devices.redeemCode(code, "code", named)).toMatchObject({ ok: false });
    expect(devices.pairRelay(code, "Phone", named)).not.toBeNull();
  });

  test("P23: a confirm on this PC's screen lets in its own frozen key only, and never past a lock or a Revoke", async () => {
    const at = dir();
    const devices = store(at);
    const internals = devices as unknown as { safety: SafetyLog; evidence: RemovalEvidence };
    // a Revoke made before the freeze, then a freeze the service states: every key with no place here is held out
    const revoked = await key();
    const revokedRow = devices.pairRelay(devices.startPairing().code, "Gone", revoked)!.device.id;
    devices.revoke(revokedRow);
    internals.safety.append({ record: { v: 1, id: "f:" + "a".repeat(64), kind: "freeze", account: "acct_1", target: await key(), after: 2, signer: "service", signed_at: new Date().toISOString(), signature: "" }, got: "snapshot" });
    const [frozen, other] = [await key(), await key()];
    expect(devices.admits(frozen)).toBe(false);
    // (c) a redemption alone lets nobody in; (b) the confirm of one key proves nothing for another
    const first = devices.startPairing();
    const { codeId } = devices.redeemCode(first.code, "code", frozen) as { codeId: string };
    expect(devices.list(null).some((row) => row.label === "Mine")).toBe(false);
    expect(devices.admits(other, { codeId, key: other, source: "screen" })).toBe(false);
    // a proof built by hand, even for the reserved key itself, passes neither the freeze nor (below) the lock
    expect(devices.admits(frozen, { codeId, key: frozen, source: "screen" })).toBe(false);
    // (a) the confirmed key itself comes in, past the freeze
    expect(devices.admitConfirmed({ codeId, key: frozen, label: "Mine", source: "screen" })).not.toBeNull();
    // (d) a key under a standing Revoke stays out unless the confirm names that Revoke
    const again = devices.startPairing();
    const { codeId: id2 } = devices.redeemCode(again.code, "code", revoked) as { codeId: string };
    expect(devices.admitConfirmed({ codeId: id2, key: revoked, label: "Back", source: "screen" })).toBeNull();
    const revokeId = internals.evidence.standingRevokes(revoked)[0]!.id;
    expect(devices.admitConfirmed({ codeId: id2, key: revoked, label: "Back", source: "screen", unrevokes: [revokeId] })).not.toBeNull();
    // (e) a locked PC still admits a key confirmed on its own screen, with origin pc; (f) never one from ovis recover
    internals.safety.append({ record: { v: 1, id: "1".repeat(32), kind: "lock", account: "acct_1", target: null, signer: "pc", signed_at: new Date().toISOString(), signature: "" }, got: "pc" });
    const fourth = devices.startPairing();
    const viaRecover = await key();
    const { codeId: id4 } = devices.redeemCode(fourth.code, "code", viaRecover) as { codeId: string };
    expect(devices.admitConfirmed({ codeId: id4, key: viaRecover, label: "Recovered", source: "recover" })).toBeNull();
    devices.releaseRedemption(id4, viaRecover);
    const third = devices.startPairing();
    const onScreen = await key();
    const { codeId: id3 } = devices.redeemCode(third.code, "code", onScreen) as { codeId: string };
    const admitted = devices.admitConfirmed({ codeId: id3, key: onScreen, label: "Screen", source: "screen" });
    expect(admitted).not.toBeNull();
    const rows = JSON.parse(readFileSync(join(at, "devices.json"), "utf8")) as { devices: { id: string; origin?: { from: string } }[] };
    expect(rows.devices.find((row) => row.id === admitted!.id)?.origin?.from).toBe("pc");
    expect(devices.admits(await key(), { codeId: id3, key: onScreen, source: "screen" })).toBe(false);
    expect(devices.admits(onScreen, { codeId: id3, key: onScreen, source: "screen" })).toBe(false);
    // (g) a PC that fails closed admits nobody, a screen confirm included
    const fifth = devices.startPairing();
    const late = await key();
    const { codeId: id5 } = devices.redeemCode(fifth.code, "code", late) as { codeId: string };
    rmSync(join(at, "account-log.json"));
    mkdirSync(join(at, "account-log.json"));
    internals.safety.append({ record: { v: 1, id: "2".repeat(32), kind: "unlock", account: "acct_1", target: "1".repeat(32), signer: "pc", signed_at: new Date().toISOString(), signature: "" }, got: "pc" });
    expect(devices.admitConfirmed({ codeId: id5, key: late, label: "Late", source: "screen" })).toBeNull();
  });

  test("P13: a screen confirm naming a local Revoke ends it; a relay-started code never does", async () => {
    const devices = store(dir());
    const internals = devices as unknown as { evidence: RemovalEvidence };
    const gone = await key();
    const row = devices.pairRelay(devices.startPairing().code, "Phone", gone)!.device.id;
    devices.revoke(row);
    // (a) a code started through the relay re-admits nobody, and the Revoke stands
    const remote = devices.startPairing(Date.now(), { remote: true, startedBy: null, memberRequired: false, by: null });
    expect(devices.pairRelay(remote.code, "Again", gone)).toBeNull();
    expect(internals.evidence.standingRevokes(gone)).toHaveLength(1);
    // (b) a key confirm on this PC's screen that names the Revoke admits it, and writes the unrevoke
    const local = devices.startPairing();
    const { codeId } = devices.redeemCode(local.code, "code", gone) as { codeId: string };
    const revokeId = internals.evidence.standingRevokes(gone)[0]!.id;
    expect(devices.admitConfirmed({ codeId, key: gone, label: "Back", source: "screen", unrevokes: [revokeId] })).not.toBeNull();
    expect(internals.evidence.standingRevokes(gone)).toEqual([]);
  });

  test("T71: a code takes five reservations at once, a sixth key is refused, and a release frees its place", async () => {
    const devices = store(dir());
    const { code } = devices.startPairing();
    const keys = await Promise.all(Array.from({ length: 6 }, () => key()));
    const ids = keys.slice(0, 5).map((k) => (devices.redeemCode(code, "code", k) as { ok: boolean; codeId: string }));
    expect(ids.every((r) => r.ok)).toBe(true);
    expect(devices.redeemCode(code, "code", keys[5]!)).toMatchObject({ ok: false, reason: "in_use" });
    devices.releaseRedemption(ids[0]!.codeId, keys[0]!);
    expect(devices.redeemCode(code, "code", keys[5]!)).toMatchObject({ ok: true });
  });

  test("T71, T72: a first-link code is redeemed; a proved key unconfirmed gets no row and no binding, and a confirmed one waits to link", async () => {
    const devices = store(dir());
    const { code } = devices.startAccountPairing("acct_1");
    const k = await key();
    const redeemed = devices.redeemCode(code, "qr", k);
    expect(redeemed).toMatchObject({ ok: true });
    expect(devices.list(null)).toHaveLength(0);
    expect(devices.account()).toBeNull();
    const waiting = devices.admitConfirmed({ codeId: (redeemed as { codeId: string }).codeId, key: k, label: "Phone", source: "screen" });
    expect(waiting).toMatchObject({ role: "watch" });
    // the confirm makes no member: the row waits for its link, which the first-link rules take as today
    expect(devices.list(null)).toHaveLength(0);
    expect(devices.account()).toBeNull();
  });

  test("T5: the relay code cooldown refuses redemption of a valid code", async () => {
    const devices = store(dir());
    const named = await key();
    const now = Date.now();
    for (let i = 0; i < 4; i++) {
      const { code } = devices.startPairing(now);
      const wrong = code === "000000" ? "000001" : "000000";
      for (let j = 0; j < 5; j++) {
        expect(devices.redeemCode(wrong, "code", named, now)).toEqual({ ok: false, reason: "invalid_code" });
      }
    }
    const { code } = devices.startPairing(now);
    expect(() => devices.redeemCode(code, "code", named, now)).toThrow(PairingRateLimitedError);
  });

  test("T72: first-link confirmation reserves the join for the selected key", async () => {
    const devices = store(dir());
    const [named, other] = await Promise.all([key(), key()]);
    const { code, pairing } = devices.startAccountPairing("acct_1");
    const redeemed = devices.redeemCode(code, "qr", named);
    if (!redeemed.ok) throw new Error("Selected key did not reserve the code");
    const prior = devices.pairRelay(code, "Other", other);
    if (prior === null) throw new Error("Other key did not get a provisional row");
    const waiting = devices.admitConfirmed({ codeId: redeemed.codeId, key: named, label: "Phone", source: "screen" });
    if (waiting === null) throw new Error("Selected key was not confirmed");

    expect(devices.redeemCode(code, "qr", other)).toMatchObject({ ok: false });
    expect(devices.pairRelay(code, "Other", other)).toBeNull();
    expect(devices.linkAccountKey(prior.device.id, other, other, "acct_1", "", true)).toBeNull();
    expect(devices.linkAccountKey(waiting.id, named, named, "acct_1", "", true)).toMatchObject({ id: waiting.id, role: "drive" });
    expect(devices.accountPairingState(pairing.id)).toMatchObject({ state: "ended", ended: { why: "joined" }, joined: { device_id: waiting.id } });
  });

  test("P11: a first link keeping the screen-confirmed key passes a lock and its named Revoke", async () => {
    const at = dir();
    const devices = store(at);
    const named = await key();
    const earlier = devices.pairRelay(devices.startPairing().code, "Phone", named);
    if (earlier === null) throw new Error("Initial pairing failed");
    devices.revoke(earlier.device.id);
    const log = SafetyLog.open(at);
    const [revoke] = RemovalEvidence.open(at, log).standingRevokes(named);
    if (revoke === undefined) throw new Error("Expected retained Revoke evidence");
    log.append({ record: { v: 1, id: "1".repeat(32), kind: "lock", account: "acct_1", target: null, signer: "pc", signed_at: new Date().toISOString(), signature: "" }, got: "pc" });
    const locked = store(at);
    expect(locked.admits(named)).toBe(false);
    const { code } = locked.startAccountPairing("acct_1");
    const redeemed = locked.redeemCode(code, "qr", named);
    if (!redeemed.ok) throw new Error("Key did not reserve the code");
    const confirm = { codeId: redeemed.codeId, key: named, label: "Phone", source: "screen" } as const;
    expect(locked.admitConfirmed(confirm)).toBeNull();
    const waiting = locked.admitConfirmed({ ...confirm, unrevokes: [revoke.id] });
    if (waiting === null) throw new Error("Screen confirmation did not create a waiting row");

    expect(locked.linkAccountKey(waiting.id, named, await key(), "acct_1", "", true)).toBeNull();
    expect(locked.linkAccountKey(waiting.id, named, named, "acct_1", "", true)).toMatchObject({ id: waiting.id, role: "drive" });
    expect(locked.isTombstoned(named)).toBe(false);
  });

  test("P24: a first link keeping the recovered key journals the recovery actor", async () => {
    const at = dir();
    const devices = store(at);
    const named = await key();
    const { code } = devices.startAccountPairing("acct_1");
    const redeemed = devices.redeemCode(code, "qr", named);
    if (!redeemed.ok) throw new Error("Recovered key did not reserve the code");
    const waiting = devices.admitConfirmed({ codeId: redeemed.codeId, key: named, label: "Phone", source: "recover", by: "alice" });
    if (waiting === null) throw new Error("Recovery did not create a waiting row");

    expect(devices.linkAccountKey(waiting.id, named, named, "acct_1", "", true)).toMatchObject({ id: waiting.id });
    expect(DeviceJournal.open(at).entries()).toContainEqual(expect.objectContaining({ kind: "admit", row: waiting.id, how: "recover", by: "alice" }));
  });

  test("T13: a first link can retry after its admission counter write fails", async () => {
    const at = dir();
    const devices = store(at);
    const named = await key();
    const { code, pairing } = devices.startAccountPairing("acct_1");
    const redeemed = devices.redeemCode(code, "qr", named);
    if (!redeemed.ok) throw new Error("Key did not reserve the code");
    const waiting = devices.admitConfirmed({ codeId: redeemed.codeId, key: named, label: "Phone", source: "screen" });
    if (waiting === null) throw new Error("Screen confirmation did not create a waiting row");
    const path = join(at, "account-pc.json");
    renameSync(path, `${path}.saved`);
    mkdirSync(path);
    try {
      expect(() => devices.linkAccountKey(waiting.id, named, named, "acct_1", "", true)).toThrow();
    } finally {
      rmSync(path, { recursive: true });
      renameSync(`${path}.saved`, path);
    }

    expect(devices.account()).toBeNull();
    expect(devices.accountPairingState(pairing.id)).toMatchObject({ state: "live", waiting: [{ id: waiting.id }] });
    expect(devices.linkAccountKey(waiting.id, named, named, "acct_1", "", true)).toMatchObject({ id: waiting.id, role: "drive" });
  });

  test("T71: every end of a code is heard, and a reservation it dropped is never confirmed after", async () => {
    const ends: string[] = [];
    const devices = store(dir());
    devices.onPairingEnded((codeId) => ends.push(codeId));
    const cancelled = devices.startPairing();
    const k = await key();
    const { codeId } = devices.redeemCode(cancelled.code, "code", k) as { codeId: string };
    devices.endPairing();
    expect(ends).toEqual([codeId]);
    expect(devices.admitConfirmed({ codeId, key: k, label: "Phone", source: "screen" })).toBeNull();
    const admittedCode = devices.startPairing();
    const { codeId: second } = devices.redeemCode(admittedCode.code, "code", k) as { codeId: string };
    devices.admitConfirmed({ codeId: second, key: k, label: "Phone", source: "screen" });
    expect(ends).toEqual([codeId, second]);
    const revoked = devices.startPairing();
    const { codeId: third } = devices.redeemCode(revoked.code, "code", await key()) as { codeId: string };
    devices.revokeAll();
    expect(ends).toEqual([codeId, second, third]);
  });

  test("T71: a relay identity reset ends the open code, and the hook hears it", async () => {
    const ends: string[] = [];
    const f = relayFixture(false, { accountOpensAll: true });
    try {
      const devices = f.app.context.services.devices;
      devices.onPairingEnded((codeId) => ends.push(codeId));
      const k = await key();
      const { codeId } = devices.redeemCode(devices.startPairing().code, "code", k) as { codeId: string };
      await f.app.context.services.relay.resetIdentity();
      expect(ends).toEqual([codeId]);
      expect(devices.admitConfirmed({ codeId, key: k, label: "Phone", source: "screen" })).toBeNull();
    } finally { f.close(); }
  });

  test("T71: a code that runs out its ten minutes ends on the store's own clock, and the hook hears it with nobody looking", async () => {
    const ends: string[] = [];
    const devices = store(dir());
    const clock = new TestClock();
    devices.useClock(clock);
    devices.onPairingEnded((codeId) => ends.push(codeId));
    const k = await key();
    const { codeId } = devices.redeemCode(devices.startPairing().code, "code", k) as { codeId: string };
    clock.advance(10 * 60 * 1000 + 1);
    expect(ends).toEqual([codeId]);
    expect(devices.admitConfirmed({ codeId, key: k, label: "Phone", source: "screen" })).toBeNull();
  });

  test("with the flag off, an expired code is recorded as main records it", () => {
    const devices = store(dir(), false);
    const clock = new TestClock();
    devices.useClock(clock);
    const { pairing: { id } } = devices.startAccountPairing("acct_1");
    clock.advance(10 * 60 * 1000 + 1);

    const cancelled = devices.endPairing({ id });
    expect(devices.accountPairingState(id)).toMatchObject({ state: "ended", ended: { why: "cancelled" } });
    expect(cancelled).toBe(true);
  });

  test("P24, T70: a key admitted by ovis recover is journalled as a recovery, by the OS user who ran it", async () => {
    const at = dir();
    const devices = store(at);
    const k = await key();
    const { codeId } = devices.redeemCode(devices.startPairing().code, "code", k) as { codeId: string };
    devices.admitConfirmed({ codeId, key: k, label: "Phone", source: "recover", by: "alice" });
    const entries = (JSON.parse(readFileSync(join(at, "device-journal.json"), "utf8")) as { entries: { kind: string; how: string; by: string | null }[] }).entries;
    expect(entries.filter((entry) => entry.kind === "admit")).toEqual([expect.objectContaining({ how: "recover", by: "alice" })]);
  });

  test("P13, T26: a key confirmed on the screen while the clock ran ahead, then revoked after it stepped back, stays out after a stop", async () => {
    const at = dir();
    const k = await key();
    try {
      setSystemTime(new Date("2026-10-01T00:00:05.000Z"));
      const devices = store(at);
      const { codeId } = devices.redeemCode(devices.startPairing().code, "code", k) as { codeId: string };
      const id = devices.admitConfirmed({ codeId, key: k, label: "Phone", source: "screen" })!.id;
      const kept = readFileSync(join(at, "devices.json"));
      setSystemTime(new Date("2026-10-01T00:00:00.000Z"));
      devices.revoke(id);
      writeFileSync(join(at, "devices.json"), kept, { mode: 0o600 });
      expect(store(at).has(id)).toBe(false);
    } finally { setSystemTime(); }
  });

  test("T26: a cookie paired after the gate closes is stamped after every row the store holds", async () => {
    const at = dir();
    try {
      setSystemTime(new Date("2026-10-01T00:00:05.000Z"));
      const devices = store(at);
      const relay = devices.pairRelay(devices.startPairing().code, "Phone", await key())!.device.id;
      setSystemTime(new Date("2026-10-01T00:00:00.000Z"));
      const cookie = devices.pair(devices.startPairing().code, "Laptop", "drive")!;
      devices.match(cookie.token);
      const rows = (JSON.parse(readFileSync(join(at, "devices.json"), "utf8")) as { devices: { id: string; created_at: string }[] }).devices;
      const created = (id: string) => Date.parse(rows.find((row) => row.id === id)!.created_at);
      expect(created(cookie.device.id)).toBeGreaterThan(created(relay));
    } finally { setSystemTime(); }
  });

  test("T26: first use of a first-pair cookie is stamped after prior Revoke evidence", async () => {
    const at = dir();
    const relayKey = await key();
    const ahead = Date.parse("2026-10-01T00:00:05.000Z");
    try {
      setSystemTime(ahead);
      const earlier = store(at);
      const relay = earlier.pairRelay(earlier.startPairing().code, "Phone", relayKey);
      if (relay === null) throw new Error("Initial relay pairing failed");
      earlier.revoke(relay.device.id);
      const revoke = RemovalEvidence.open(at, SafetyLog.open(at)).standingRevokes(relayKey)[0];
      if (revoke === undefined) throw new Error("Expected retained Revoke evidence");
      // Start with a fresh registry, retaining the Revoke of the relay row made while the clock was ahead.
      rmSync(join(at, "devices.json"));
      setSystemTime(ahead - 5_000);
      const devices = store(at);
      expect(devices.gated).toBe(false);
      const cookie = devices.pair(devices.startPairing().code, "Laptop", "drive");
      if (cookie === null) throw new Error("First cookie pairing failed");
      expect(devices.gated).toBe(false);
      expect(devices.list(null)).toHaveLength(0);

      expect(devices.match(cookie.token)).toEqual(cookie.device);
      expect(devices.gated).toBe(true);
      const row = devices.list(null).find((listed) => listed.id === cookie.device.id);
      if (row === undefined) throw new Error("First use did not save the cookie row");
      expect(Date.parse(row.created_at)).toBeGreaterThan(Date.parse(revoke.at));
    } finally {
      setSystemTime();
    }
  });
});
