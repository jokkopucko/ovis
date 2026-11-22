import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exportAccountKey, newRecordId, signSafetyRecord, type BlockRecord, type DeviceLiftRecord } from "../../shared/account-records.ts";
import type { AccountSnapshotPage } from "../../shared/account-snapshot.ts";
import { DeviceStore } from "../devices.ts";
import { privateStateFs } from "../private-state.ts";
import { ACCOUNT_ORDER_FILE, AccountOrder } from "./account-order.ts";
import { DeviceJournal, JOURNAL_FILE, JOURNAL_MAX } from "./device-journal.ts";
import { PcAccountState } from "./pc-binding.ts";
import { RemovalEvidence } from "./removal-evidence.ts";
import { SafetyLog } from "./safety-log.ts";
import { snapshotPorts } from "./snapshot-ports.ts";
import { readSnapshot, type PageAnswer } from "./snapshot-read.ts";

const ACCOUNT = "acct_1";
const SERVER = "0123456789abcdef0123456789abcdef";
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

interface Key { keys: CryptoKeyPair; spki: string }
async function key(): Promise<Key> {
  const keys = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
  return { keys, spki: await exportAccountKey(keys.publicKey) };
}

function pc(dir = mkdtempSync(join(tmpdir(), "s2-24-ports-")), serverId = SERVER) {
  if (!dirs.includes(dir)) dirs.push(dir);
  const safetyLog = SafetyLog.open(dir);
  const pcAccount = PcAccountState.open(dir);
  const journal = DeviceJournal.open(dir, () => safetyLog.ensureFile());
  const devices = new DeviceStore(dir, null, null, { safety: safetyLog, pc: pcAccount, removals: RemovalEvidence.open(dir, safetyLog), journal });
  const reads: string[] = [];
  const order = AccountOrder.open(dir);
  devices.attachAccountOrder(order);
  const ports = snapshotPorts({ devices, safetyLog, pc: pcAccount, journal, order, serverId: () => serverId, requestRead: () => { reads.push("read"); } });
  return { dir, devices, safetyLog, journal, ports, reads };
}

/** A drive member of the account here, admitted now: each one joins after the ones before it. */
async function member(devices: DeviceStore): Promise<Key & { id: string }> {
  const k = await key();
  const id = devices.pairRelay(devices.startPairing().code, "Phone", k.spki)!.device.id;
  devices.linkAccountKey(id, k.spki, k.spki, ACCOUNT);
  return { ...k, id };
}

const block = (target: string, by: Key, claims = { target_no: 9, signer_no: 1 }): Promise<BlockRecord> =>
  signSafetyRecord({ v: 1, kind: "block", account: ACCOUNT, target, ...claims, signer: by.spki, signed_at: new Date().toISOString(), nonce: newRecordId() }, by.keys.privateKey) as Promise<BlockRecord>;
const lift = (target: string, by: Key): Promise<DeviceLiftRecord> =>
  signSafetyRecord({ v: 1, kind: "lift", account: ACCOUNT, target, signer: by.spki, signer_no: 1, signed_at: new Date().toISOString() }, by.keys.privateKey) as Promise<DeviceLiftRecord>;

let snapshots = 0;
function page(over: Partial<AccountSnapshotPage>): { page: AccountSnapshotPage } {
  snapshots++;
  return { page: { v: 1, snapshot: snapshots.toString(16).padStart(32, "0"), account: ACCOUNT, server_id: SERVER, version: snapshots, methods_version: 0, page: 0, last: true, devices: [], removed: [], blocks: [], lifts: [], freezes: [], ...over } };
}
const read = (ports: ReturnType<typeof pc>["ports"], answer: PageAnswer) => readSnapshot(async () => answer, ports);

describe("S2-24 a whole read applied to this PC's real state (G1, T15, T52, T58)", () => {
  test("T52: a forged block in a snapshot page is not applied and raises nothing", async () => {
    const { devices, safetyLog, ports } = pc();
    const [older, target] = [await member(devices), await member(devices)];
    const good = await block(target.spki, older);
    const forged = { ...good, signature: (await block(older.spki, target)).signature };
    expect(await read(ports, page({ blocks: [forged] }))).toMatchObject({ committed: true, denials: 1 });
    expect(safetyLog.entries()).toHaveLength(0);
    expect(devices.has(target.id)).toBe(true);
  });

  test("P21: a newer key's block claiming signer number 1 is refused; a valid block applies as it is read", async () => {
    const { devices, safetyLog, ports } = pc();
    const [older, target, late] = [await member(devices), await member(devices), await member(devices)];
    expect(await read(ports, page({ blocks: [await block(target.spki, late, { target_no: 99, signer_no: 1 })] }))).toMatchObject({ committed: true });
    expect(devices.has(target.id)).toBe(true);
    expect(safetyLog.entries()).toHaveLength(0);
    expect(await read(ports, page({ blocks: [await block(target.spki, older)] }))).toMatchObject({ committed: true });
    expect(devices.has(target.id)).toBe(false);
    expect(safetyLog.entries()).toHaveLength(1);
  });

  test("T52: a lift signed by a key newer here is refused; an older device's lift in a whole read ends the freeze", async () => {
    const { devices, safetyLog, ports } = pc();
    const [older, target, newer] = [await member(devices), await member(devices), await member(devices)];
    const blocked = await block(target.spki, older);
    expect(await devices.applyBlock(blocked, "handed")).toMatchObject({ outcome: "applied" });
    const stranger = (await key()).spki;
    expect(devices.admits(stranger)).toBe(false);
    expect(await read(ports, page({ devices: [{ key: older.spki, no: 1, eligible: true, label: "Phone" },
      { key: newer.spki, no: 3, eligible: true, label: "Tablet" }], removed: [{ key: target.spki, no: 2 }] }))).toMatchObject({ committed: true });
    expect(await read(ports, page({ lifts: [await lift(blocked.id, newer)] }))).toMatchObject({ committed: true, liftsRefused: 1 });
    expect(devices.admits(stranger)).toBe(false);
    expect(await read(ports, page({ lifts: [await lift(blocked.id, older)] }))).toMatchObject({ committed: true, liftsRefused: 0 });
    expect(devices.admits(stranger)).toBe(true);
    expect(safetyLog.state().freezes).toEqual([]);
  });

  test("G1, P6: restarting preserves the snapshot watermark for this relay identity only", async () => {
    const first = pc();
    await member(first.devices);
    expect(await read(first.ports, page({ version: 9 }))).toMatchObject({ committed: true });
    const reopened = pc(first.dir);
    expect(reopened.devices.accountError).toBeNull();
    expect(await read(reopened.ports, page({ version: 8 }))).toMatchObject({ committed: false, reason: "stale" });
    const rotated = "a".repeat(32);
    expect(await read(pc(first.dir, rotated).ports, page({ version: 1, server_id: rotated }))).toMatchObject({ committed: true });
  });

  test("T52: the first whole read uses its own order to decide a lift", async () => {
    const { devices, safetyLog, ports } = pc();
    const signer = await member(devices);
    const target = await member(devices);
    const blocked = await block(target.spki, signer);
    expect((await devices.applyBlock(blocked, "handed")).outcome).toBe("applied");
    const record = await lift(blocked.id, signer);
    const first = page({ devices: [{ key: signer.spki, no: 1, eligible: true, label: "Phone" }],
      removed: [{ key: target.spki, no: 2 }], blocks: [blocked], lifts: [record] });
    expect(await read(ports, first)).toMatchObject({ committed: true, liftsRefused: 0 });
    expect(safetyLog.state().freezes).toEqual([]);
  });

  test("P15, T52: each applied lift is journalled once across reopen and replay", async () => {
    const first = pc();
    const signer = await member(first.devices);
    const targets = [await member(first.devices), await member(first.devices)];
    const blocks = await Promise.all(targets.map((target) => block(target.spki, signer)));
    for (const record of blocks) expect((await first.devices.applyBlock(record, "handed")).outcome).toBe("applied");
    const lifts = await Promise.all(blocks.map((record) => lift(record.id, signer)));
    const stage = { snapshot: page({ lifts }).page, lifts };
    const heard: string[][] = [];
    first.devices.onLifted((key, cause) => heard.push([key, cause]));
    first.ports.commit(stage);
    expect(heard).toEqual(targets.map(({ spki }) => [spki, "snapshot"]));
    expect(first.safetyLog.state().blocks).toEqual([]);
    const again = pc(first.dir);
    const notices = () => DeviceJournal.open(first.dir).entries().filter(({ kind }) => kind === "lift").map(({ key }) => key);
    expect(notices()).toEqual(targets.map(({ spki }) => spki));
    again.ports.commit(stage);
    expect(notices()).toEqual(targets.map(({ spki }) => spki));
  });

  test("P14: a refused block earns no credit for a concurrent independent revoke", async () => {
    const { devices, ports } = pc();
    const older = await member(devices);
    const younger = await member(devices);
    const other = await member(devices);
    const refused = await block(older.spki, younger);
    const pending = ports.deny(refused);
    expect(devices.revoke(other.id)).toBe(true);
    expect(await pending).toBe(false);
  });

  test("T52/P14: a commit with a new service line drops a staged lift with no current authority", async () => {
    const { devices, ports, safetyLog } = pc();
    const owner = await member(devices);
    const target = await key();
    const line = await block(target.spki, owner);
    // Exercise the commit boundary alone. No denial exists for this staged lift to end.
    const orphan = await lift("a".repeat(64), owner);
    const snapshot = page({ blocks: [line], freezes: [{ block: line.id, target: target.spki, after: 9 }], lifts: [orphan] }).page;
    ports.commit({ snapshot, lifts: [orphan] });
    expect(safetyLog.state().freezes).toHaveLength(1);
    expect(safetyLog.receipt(orphan.id)).toBeNull();
  });

  test("P14: an unfenced service freeze invalidates read scope until generation repair", async () => {
    const { dir, devices, ports, safetyLog } = pc();
    const owner = await member(devices);
    const target = await key();
    const record = await block(target.spki, owner);
    const snapshot = page({ blocks: [record], freezes: [{ block: record.id, target: target.spki, after: 9 }] }).page;
    const before = ports.scope();
    const observed: boolean[] = [];
    const recheck = devices.recheckListedSessions.bind(devices);
    spyOn(devices, "recheckListedSessions").mockImplementation(() => {
      observed.push(devices.failsClosed);
      recheck();
    });
    const rename = privateStateFs.renameSync;
    const fault = spyOn(privateStateFs, "renameSync").mockImplementation((from, to) => {
      if (String(to).endsWith("/account-pc.json")) throw new Error("generation unavailable");
      rename(from, to);
    });
    try {
      expect(() => ports.commit({ snapshot, lifts: [] })).toThrow();
      expect(safetyLog.state().freezes).toHaveLength(1);
      expect(devices.failsClosed).toBe(true);
      expect(observed).toContain(true);
      expect(ports.scope()).toBeNull();
    } finally { fault.mockRestore(); }
    const reopened = pc(dir);
    reopened.ports.commit({ snapshot, lifts: [] });
    expect(reopened.ports.scope()?.gen).toBe((before?.gen ?? -1) + 1);
    expect(reopened.safetyLog.state().freezes).toHaveLength(1);
  });

  test("G12, P23, P24: an unapplied service block restricts newer admissions across restart until an older key lifts it", async () => {
    const first = pc();
    const signer = await member(first.devices);
    const target = await key();
    const newer = await key();
    const record = await block(target.spki, signer, { signer_no: 1, target_no: 2 });
    expect(await read(first.ports, page({ blocks: [record], freezes: [{ block: record.id, target: target.spki, after: 2 }],
      devices: [{ key: signer.spki, no: 1, eligible: true, label: "Phone" }, { key: newer.spki, no: 3, eligible: false, label: "Tablet" }],
      removed: [{ key: target.spki, no: 2 }] }))).toMatchObject({ committed: true });
    expect(first.devices.admits(newer.spki)).toBe(false);
    const again = pc(first.dir);
    expect(again.devices.admits(signer.spki)).toBe(true);
    expect(again.devices.isTombstoned(target.spki)).toBe(false);
    expect(await read(again.ports, page({}))).toMatchObject({ committed: true });
    expect(again.devices.admits(newer.spki)).toBe(false);
    expect(await read(again.ports, page({ lifts: [await lift(record.id, signer)] }))).toMatchObject({ committed: true, liftsRefused: 0 });
    expect(again.devices.admits(newer.spki)).toBe(true);
  });

  test("T58: an unchanged methods version is not announced after retention and restart", async () => {
    const first = pc();
    await member(first.devices);
    expect(await read(first.ports, page({ methods_version: 5 }))).toMatchObject({ committed: true });
    // fill the journal to its limit in one write (as JOURNAL_MAX appends would leave it), then one real append trims
    // the method entry, as retention does
    const path = join(first.dir, JOURNAL_FILE);
    const doc = JSON.parse(readFileSync(path, "utf8")) as { next_seq: number; entries: unknown[] };
    const fillers = Array.from({ length: JOURNAL_MAX }, (_, i) => ({ kind: "merge", how: "merge", key: null, no: null, row: null, label: "Merge", by: null, account: ACCOUNT, seq: doc.next_seq + i, id: i.toString(16).padStart(32, "0"), at: new Date().toISOString() }));
    writeFileSync(path, JSON.stringify({ ...doc, entries: [...doc.entries, ...fillers].slice(-JOURNAL_MAX), next_seq: doc.next_seq + JOURNAL_MAX }));
    pc(first.dir).journal.append({ kind: "merge", how: "merge", key: null, no: null, row: null, label: "Merge", by: null, account: ACCOUNT });
    const again = pc(first.dir);
    expect(again.journal.entries().some((entry) => entry.kind === "method")).toBe(false);
    expect(await read(again.ports, page({ methods_version: 5 }))).toMatchObject({ committed: true });
    expect(again.journal.entries().filter((entry) => entry.kind === "method")).toHaveLength(0);
    expect(await read(again.ports, page({ methods_version: 6 }))).toMatchObject({ committed: true });
    expect(again.journal.entries().filter((entry) => entry.kind === "method")).toHaveLength(1);
  });

  test("T58: a committed methods version change is journalled once", async () => {
    const { devices, journal, ports } = pc();
    await member(devices);
    const methods = () => journal.entries().filter((entry) => entry.kind === "method").length;
    await read(ports, page({ methods_version: 2 }));
    await read(ports, page({ methods_version: 2 }));
    expect(methods()).toBe(1);
    await read(ports, page({ methods_version: 3 }));
    expect(methods()).toBe(2);
  });

  test("G1: a snapshot older than the last one applied is refused", async () => {
    const { devices, ports } = pc();
    await member(devices);
    const newer = page({});
    const older = page({});
    older.page = { ...older.page, version: 1 };
    newer.page = { ...newer.page, version: 5 };
    expect(await read(ports, newer)).toMatchObject({ committed: true });
    expect(await read(ports, older)).toEqual({ committed: false, reason: "stale", denials: 0 });
  });

  test("T52, P14: a refused durable lift does not advance the watermark", async () => {
    const { devices, ports, safetyLog } = pc();
    const [older, target] = [await member(devices), await member(devices)];
    const blocked = await block(target.spki, older);
    expect((await devices.applyBlock(blocked, "handed")).outcome).toBe("applied");
    expect(await read(ports, page({ version: 1, devices: [{ key: older.spki, no: 1, eligible: false, label: "Phone" }],
      removed: [{ key: target.spki, no: 2 }] }))).toMatchObject({ committed: true });
    const record = await lift(blocked.id, older);
    const rename = privateStateFs.renameSync;
    const refused = spyOn(privateStateFs, "renameSync").mockImplementation((from, to) => {
      if (String(to).endsWith("/account-log.json")) throw new Error("log unavailable");
      rename(from, to);
    });
    try {
      expect(await read(ports, page({ version: 2, lifts: [record] }))).toMatchObject({ committed: false });
      expect(ports.lastVersion()).toBe(1);
      expect(safetyLog.state().blocks.map(({ record }) => record.id)).toEqual([blocked.id]);
    } finally { refused.mockRestore(); }
  });

  test("P6, P14, T52: a conflict on the second lift leaves neither append and the old watermark on disk", async () => {
    const first = pc();
    const signer = await member(first.devices);
    expect(await read(first.ports, page({ version: 1 }))).toMatchObject({ committed: true });
    const a = await lift("a".repeat(64), signer);
    const b = await lift("b".repeat(64), signer);
    // The log already has different bytes for b's id. This is a refusal at append, not a page parse failure.
    expect(first.safetyLog.append({ got: "snapshot", cause: "snapshot", record: { ...b, signature: a.signature } }).outcome).toBe("applied");
    const snapshot = page({ version: 2, lifts: [a, b] }).page;
    expect(() => first.ports.commit({ snapshot, lifts: snapshot.lifts })).toThrow("conflict");
    const reopened = pc(first.dir);
    expect(reopened.ports.lastVersion()).toBe(1);
    expect(reopened.safetyLog.receipt(a.id)).toBeNull();
    expect(reopened.safetyLog.entries().map(({ record }) => record.signature)).toEqual([a.signature]);
  });

  test("P14: a failed generation write leaves the block standing, and no lift counts at an unraised generation", async () => {
    const first = pc();
    const signer = await member(first.devices);
    const target = await member(first.devices);
    const blocked = await block(target.spki, signer);
    expect((await first.devices.applyBlock(blocked, "handed")).outcome).toBe("applied");
    await read(first.ports, page({ version: 1 }));
    const gen = first.devices.gen();
    const record = await lift(blocked.id, signer);
    const snapshot = page({ version: 2, lifts: [record] }).page;
    const rename = privateStateFs.renameSync;
    const fault = spyOn(privateStateFs, "renameSync").mockImplementation((from, to) => {
      if (String(to).endsWith("account-pc.json")) throw new Error("generation unavailable");
      rename(from, to);
    });
    try { expect(() => first.ports.commit({ snapshot, lifts: [record] })).toThrow(); }
    finally { fault.mockRestore(); }
    const again = pc(first.dir);
    expect(again.safetyLog.receipt(record.id)).toBeNull();
    expect(again.safetyLog.state().blocks.map(({ record }) => record.id)).toEqual([blocked.id]);
    expect(again.devices.gen()).toBe(gen);
  });

  test("P6, P14: a failed watermark replacement leaves the freeze in force after restart", async () => {
    const first = pc();
    const signer = await member(first.devices);
    const target = await member(first.devices);
    const blocked = await block(target.spki, signer);
    expect((await first.devices.applyBlock(blocked, "handed")).outcome).toBe("applied");
    await read(first.ports, page({ version: 1 }));
    const record = await lift(blocked.id, signer);
    const snapshot = page({ version: 2, lifts: [record] }).page;
    const rename = privateStateFs.renameSync;
    const fault = spyOn(privateStateFs, "renameSync").mockImplementation((from, to) => {
      if (to === join(first.dir, ACCOUNT_ORDER_FILE)) throw new Error("watermark unavailable");
      rename(from, to);
    });
    try { expect(() => first.ports.commit({ snapshot, lifts: [record] })).toThrow(); }
    finally { fault.mockRestore(); }
    const again = pc(first.dir);
    expect(again.ports.lastVersion()).toBe(1);
    expect(again.safetyLog.receipt(record.id)).toBeNull();
    expect(again.safetyLog.state().blocks.map(({ record }) => record.id)).toEqual([blocked.id]);
  });

  for (const missing of ["signer", "target", "both", "older target"] as const) {
    test(`T52, P21, P23: a lift lacks pinned seniority with ${missing}`, async () => {
      const { devices, safetyLog, ports } = pc();
      const [older, target] = [await member(devices), await member(devices)];
      const blocked = await block(target.spki, older);
      expect((await devices.applyBlock(blocked, "handed")).outcome).toBe("applied");
      const devicesOnList = missing === "target" || missing === "older target"
        ? [{ key: older.spki, no: 3, eligible: false, label: "Phone" }] : [];
      const removed = missing === "signer" || missing === "older target" ? [{ key: target.spki, no: 2 }] : [];
      expect(await read(ports, page({ devices: devicesOnList, removed }))).toMatchObject({ committed: true });
      expect(await read(ports, page({ lifts: [await lift(blocked.id, older)] }))).toMatchObject({ committed: true, liftsRefused: 1 });
      expect(safetyLog.state().blocks.map(({ record }) => record.id)).toEqual([blocked.id]);
    });
  }

  test("P21, G1: renumbering a pinned key refuses and journals the read without moving its watermark", async () => {
    const { devices, ports, journal } = pc();
    const signer = await member(devices);
    const row = { key: signer.spki, no: 2, eligible: false, label: "Phone" };
    expect(await read(ports, page({ version: 10, devices: [row] }))).toMatchObject({ committed: true });
    expect(await read(ports, page({ version: 11, removed: [{ key: row.key, no: 3 }] }))).toMatchObject({ committed: false });
    expect(ports.lastVersion()).toBe(10);
    expect(journal.entries().at(-1)).toMatchObject({ key: row.key, how: "order_conflict" });
  });

  for (const when of ["in this read", "before restart"] as const) {
    test(`T52, P21, P23: a signer removed ${when} cannot lift`, async () => {
      const first = pc();
      const signer = await member(first.devices);
      const target = await member(first.devices);
      const blocked = await block(target.spki, signer);
      expect((await first.devices.applyBlock(blocked, "handed")).outcome).toBe("applied");
      const row = { key: signer.spki, no: 1, eligible: false, label: "Phone" };
      expect(await read(first.ports, page({ devices: [row], removed: [{ key: target.spki, no: 2 }] }))).toMatchObject({ committed: true });
      const removed = [{ key: signer.spki, no: 1 }];
      if (when === "before restart") expect(await read(first.ports, page({ removed }))).toMatchObject({ committed: true });
      const current = when === "before restart" ? pc(first.dir) : first;
      const result = await read(current.ports, page({ removed: when === "in this read" ? removed : [], lifts: [await lift(blocked.id, signer)] }));
      expect(result).toMatchObject({ committed: true, liftsRefused: 1 });
      expect(current.safetyLog.state().blocks.map(({ record }) => record.id)).toEqual([blocked.id]);
      const table = await Bun.file(join(first.dir, ACCOUNT_ORDER_FILE)).json();
      const listed_in = PcAccountState.open(first.dir).binding()?.bind_id;
      expect(table.keys[target.spki]).toEqual({ no: 2, removed: true, late: false, joined: 2, listed_in });
      expect(table.keys[signer.spki]).toEqual({ no: 1, removed: true, late: false, joined: 1, listed_in });
    });
  }

  test("T52, P21: a lift signed by a key the account's order marks late is refused, though it is older here", async () => {
    const { devices, ports } = pc();
    const [older, target] = [await member(devices), await member(devices)];
    const blocked = await block(target.spki, older);
    expect(await devices.applyBlock(blocked, "handed")).toMatchObject({ outcome: "applied" });
    // the first read lists the target at 5; the next lists the older key first at 3: late in the account's order
    await read(ports, page({ devices: [{ key: target.spki, no: 5, eligible: true, label: "T" }] }));
    await read(ports, page({ devices: [{ key: older.spki, no: 3, eligible: true, label: "O" }, { key: target.spki, no: 5, eligible: true, label: "T" }] }));
    expect(await devices.liftAuthority(await lift(blocked.id, older))).toBe(false);
  });
});
