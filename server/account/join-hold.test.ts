import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AccountDeviceStore, EXPIRY_DAYS, type AccountRowPorts } from "./account-devices.ts";
import { DeviceJournal, JOURNAL_FILE, JOURNAL_MAX } from "./device-journal.ts";
import { listNotices } from "./list-notices.ts";
import { RemovalEvidence } from "./removal-evidence.ts";
import { keyOf, listOrigins, snapshotList as list, nameOf, SERVER } from "./account-devices.test-helpers.ts";
import { ITS_ME_MIN_AGE_MS, JOIN_HOLD_MS, type Sayer } from "./join-hold.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function machine(over: Partial<AccountRowPorts> = {}, first: { othersEver?: boolean; listKey?: string | null; otherRows?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "s2-29-"));
  dirs.push(dir);
  const clock = { now: 5 * ITS_ME_MIN_AGE_MS };
  const events: string[] = [];
  const binding = { othersEver: first.othersEver ?? true, listKey: first.listKey === undefined || first.listKey === null ? null : keyOf(first.listKey), otherRows: first.otherRows ?? false };
  const ports: AccountRowPorts = {
    admitListedRows: write => [...write()],
    journal: (entry) => { events.push(`journal ${entry.kind} ${nameOf(entry.key)}`); },
    closeSessions: () => {},
    heldByDevicesJson: () => false,
    hasNoticeSlot: () => true,
    admits: () => true,
    publish: (entry) => { events.push(`publish ${nameOf(entry.key)}`); },
    now: () => clock.now,
    admitOrigin: listOrigins(),
    firstDevice: {
      othersEver: () => binding.othersEver,
      setOthersEver: () => { events.push("others_ever"); binding.othersEver = true; },
      listKey: () => binding.listKey,
      otherRows: () => binding.otherRows,
    },
    ...over,
  };
  return { dir, clock, events, binding, ports, store: new AccountDeviceStore(dir, SERVER, ports) };
}

const established = (over: Partial<Sayer> = {}): Sayer => ({ key: keyOf("k-old"), drives: true, state: "live", no: 1, late: false, admitNo: null, admittedAt: 0, ...over });

describe("S2-29 the join hold and the first device (T34, T53, T67)", () => {
  test("a whole read publishes an interrupted admission after trimming before restarting its hold", async () => {
    const { dir, ports } = machine();
    const evidence = RemovalEvidence.open(dir, null);
    const read = list(["k-held"]);
    const first = new AccountDeviceStore(dir, SERVER, { ...ports, ...listNotices(DeviceJournal.open(dir), evidence, () => {}),
      admitListedRows(write) { write(); throw new Error("stopped after row write"); },
    });
    expect(() => first.commitList(read)).toThrow("stopped after row write");
    // Fill the replay window in one fixture write; a real append performs the trim.
    const file = Bun.file(join(dir, JOURNAL_FILE));
    const doc = await file.json();
    const fillers = Array.from({ length: JOURNAL_MAX - 1 }, (_, i) => ({ ...doc.entries[0],
      seq: doc.next_seq + i, id: `history-${i}`, kind: "merge", row: null, awaitingListCheck: undefined }));
    await Bun.write(file, JSON.stringify({ ...doc, entries: [...doc.entries, ...fillers], next_seq: doc.next_seq + fillers.length }));
    DeviceJournal.open(dir).append({ kind: "merge", how: "merge", row: null, no: null, key: null, account: null, by: null, label: "" });
    const journal = DeviceJournal.open(dir);
    expect(journal.openNotices()).toEqual([]);
    const notices = listNotices(journal, evidence, () => {});
    const restarted = new AccountDeviceStore(dir, SERVER, { ...ports, ...notices, publish(entry) {
      // T42 has judged the row, but T34 cannot start the hold before the notice is published.
      expect(restarted.access(entry.row)).toEqual({ refused: "join_hold", seconds: null });
      notices.publish(entry);
    } });
    const [held] = restarted.rows();
    if (!held) throw new Error("Missing durable row");
    expect(restarted.access(held.id)).toEqual({ refused: "catching_up" });
    restarted.commitList(read);
    expect(DeviceJournal.open(dir).openNotices().map(entry => entry.row)).toEqual([held.id]);
    expect(restarted.access(held.id)).toEqual({ refused: "join_hold", seconds: 10 });
  });
  test("P17/T42: a fresh read replaces a pre-fix snapshot-numbered notice before restarting the hold", () => {
    const { dir, clock, ports } = machine();
    const journal = DeviceJournal.open(dir);
    const read = list(["k-held"]);
    // Prior S2-29 persisted the snapshot number (1), not this admission's PC-local number (42).
    const prior = new AccountDeviceStore(dir, SERVER, { ...ports,
      admitOrigin: (at) => ({ from: "remote", how: "list", by: null, admit_no: 42, at: new Date(at).toISOString() }),
      journal: (entry) => { journal.append({ kind: "admit", how: "list", key: entry.key, no: 1, row: entry.row, label: "held", by: null, account: read.account, provider: "google", two_step: "set" }); },
    });
    prior.commitList(read);
    const [row] = prior.rows();
    const [obsolete] = journal.openNotices();
    if (!row || !obsolete) throw new Error("Missing pre-fix admission");
    const observer = "member-who-saw-old-notice";
    journal.ack(observer, obsolete.seq);
    clock.now += JOIN_HOLD_MS * 2;
    const disk = DeviceJournal.open(dir);
    const reopened = new AccountDeviceStore(dir, SERVER, { ...ports, ...listNotices(disk, RemovalEvidence.open(dir, null), () => {}) });
    reopened.commitList(read);
    expect(reopened.access(row.id)).toEqual({ refused: "join_hold", seconds: 10 });
    const replay = disk.replay("older-member", (entry) => entry.no !== null && 5 < entry.no);
    expect(replay.notices).toMatchObject([{ row: row.id, open: true, no: 42, method: "google", two_step: "set" }]);
    const [replacement] = replay.notices;
    if (!replacement) throw new Error("The repaired notice was not replayed");
    expect(disk.openNotices().map((entry) => entry.id)).toEqual([replacement.id]);
    expect(replacement.id).not.toBe(obsolete.id);
    expect(DeviceJournal.open(dir).replay(observer, () => true).notices.find(entry => entry.id === obsolete.id)).toMatchObject({ open: false });
  });
  test.each(["list change", "catch-up guard", "idle expiry", "PC leave", "identity reset"] as const)(
    "S2P-10: a listed drop after %s persists the acknowledged admission's close", (reason) => {
      const { dir, clock, ports } = machine();
      const journal = DeviceJournal.open(dir);
      const observer = "older-device";
      const notices = listNotices(journal, RemovalEvidence.open(dir, null), () => {});
      let allowed = true;
      let atDrop: ReturnType<DeviceJournal["replay"]> | undefined;
      const store = new AccountDeviceStore(dir, SERVER, { ...ports, ...notices, admits: () => allowed, journal(entry) {
        notices.journal(entry);
        if (entry.kind === "drop") atDrop = DeviceJournal.open(dir).replay(observer, () => true);
      } });
      store.commitList(list(["k-held"]));
      const [admission] = journal.openNotices();
      if (!admission) throw new Error("Missing listed admission");
      journal.ack(observer, admission.seq);
      if (reason === "list change") store.commitList(list([], [], 2));
      else if (reason === "catch-up guard") {
        allowed = false;
        store.commitList(list(["k-held"], [], 2));
      } else if (reason === "idle expiry") {
        clock.now += EXPIRY_DAYS * 24 * 60 * 60_000;
        store.expire();
      } else {
        store.clear(reason === "PC leave" ? "remove" : "identity_reset");
      }
      expect(store.access(admission.row ?? "")).not.toEqual({ ok: true });
      expect(atDrop?.notices.find(entry => entry.id === admission.id)).toMatchObject({ open: false });
    },
  );
  test("H1/T42: reopening a held row requires a whole read and a new uninterrupted ten seconds", () => {
    const { store, clock, dir, ports } = machine();
    const read = list(["k-new"]);
    store.commitList(read);
    const [row] = store.rows();
    if (!row) throw new Error("Missing held row");
    clock.now += JOIN_HOLD_MS * 2;
    const reopened = new AccountDeviceStore(dir, SERVER, ports);
    // after a start the row first waits for a whole read (S2-27), whatever its hold says
    expect(reopened.access(row.id)).toEqual({ refused: "catching_up" });
    reopened.commitList(read);
    expect(reopened.access(row.id)).toEqual({ refused: "join_hold", seconds: 10 });
    clock.now += JOIN_HOLD_MS - 1;
    reopened.commitList(read);
    expect(reopened.access(row.id)).toEqual({ refused: "join_hold", seconds: 1 });
    ++clock.now;
    expect(reopened.access(row.id)).toEqual({ ok: true });
  });
  test("T34: durable notice publication precedes any held row access and starts the ten seconds", () => {
    const { store, events, clock } = machine();
    store.commitList(list(["k-new"]));
    expect(events).toEqual(["journal admit k-new", "publish k-new"]);
    const [row] = store.rows();
    expect(store.access(row!.id)).toEqual({ refused: "join_hold", seconds: 10 });
    clock.now += JOIN_HOLD_MS - 1;
    expect(store.access(row!.id)).toEqual({ refused: "join_hold", seconds: 1 });
    clock.now += 1;
    expect(store.access(row!.id)).toEqual({ ok: true });

    // a notice that could not be published starts no ten seconds: the row stays held however long it waits
    let diskFull = true;
    const failing = machine({ publish: () => { if (diskFull) throw new Error("journal unseen set not written"); } });
    failing.store.commitList(list(["k-new"]));
    const [held] = failing.store.rows();
    failing.clock.now += 10 * JOIN_HOLD_MS;
    expect(failing.store.access(held!.id)).toEqual({ refused: "join_hold", seconds: null });
    diskFull = false;
    failing.store.republish();
    expect(failing.store.access(held!.id)).toEqual({ refused: "join_hold", seconds: 10 });
  });

  test("T53: timer or established older proved caller ends the hold only with a final unchanged admission check", () => {
    let admits = true;
    const { store, clock } = machine({ admits: () => admits });
    store.commitList({ ...list(["k-new"]), devices: [{ key: keyOf("k-new"), no: 5, label: "new", eligible: true }] });
    const [row] = store.rows();

    // who may say "It's me": a driving, live row with a lower order number, admitted here over an hour ago
    const refusedBy: [string, Sayer][] = [
      ["watch row", established({ drives: false })],
      ["in its own hold", established({ state: "hold" })],
      ["on hold for a read", established({ state: "waiting" })],
      ["not older", established({ no: 5 })],
      ["newer", established({ no: 9 })],
      ["late order number", established({ late: true })],
      ["exactly one hour", established({ admittedAt: clock.now - ITS_ME_MIN_AGE_MS })],
      ["admitted within the hour", established({ admittedAt: clock.now - ITS_ME_MIN_AGE_MS + 1 })],
      ["admission time ahead of the clock", established({ admittedAt: clock.now + 60_000 })],
      ["no age at all", established({ no: null, admitNo: null })],
      ["the held row itself", established({ key: keyOf("k-new") })],
    ];
    for (const [name, sayer] of refusedBy) expect({ name, ended: store.itsMe(row!.id, sayer) }).toEqual({ name, ended: false });
    expect(store.access(row!.id)).toMatchObject({ refused: "join_hold" });

    // an established older row ends it, but only if the admission check still passes at that moment
    admits = false;
    expect(store.itsMe(row!.id, established())).toBe(false);
    admits = true;
    expect(store.itsMe(row!.id, established())).toBe(true);
    expect(store.access(row!.id)).toEqual({ ok: true });

    // the timer also asks the admission check again: a row that fails it stays out after its ten seconds
    const timed = machine();
    timed.store.commitList(list(["k-new"]));
    const [later] = timed.store.rows();
    timed.clock.now += JOIN_HOLD_MS;
    timed.ports.admits = () => false;
    expect(timed.store.access(later!.id)).toEqual({ refused: "admission" });
    timed.ports.admits = () => true;
    expect(timed.store.access(later!.id)).toEqual({ ok: true });
    expect(new AccountDeviceStore(timed.dir, SERVER, timed.ports).live(later!.id)).toBe(true);
  });

  test("T67: first-device bypass requires proved same key and no other key, row or history, and cannot happen twice", () => {
    const first = () => machine({}, { othersEver: false, listKey: "k-first", otherRows: false });

    const ok = first();
    ok.store.commitList(list(["k-first"]));
    expect(ok.events).toEqual(["others_ever", "journal admit k-first", "publish k-first"]);
    expect(ok.store.access(ok.store.rows()[0]!.id)).toEqual({ ok: true });

    const cases: [string, ReturnType<typeof first>, ReturnType<typeof list>][] = [
      ["another key in the list", first(), list(["k-first", "k-other"])],
      ["another key removed", first(), list(["k-first"], ["k-gone"])],
      ["another row on this PC", machine({}, { othersEver: false, listKey: "k-first", otherRows: true }), list(["k-first"])],
      ["history: others_ever set", machine({}, { othersEver: true, listKey: "k-first" }), list(["k-first"])],
      ["key not proved in the link", machine({}, { othersEver: false, listKey: null }), list(["k-first"])],
      ["a different key", machine({}, { othersEver: false, listKey: "k-proved" }), list(["k-first"])],
    ];
    for (const [name, pc, read] of cases) {
      pc.store.commitList(read);
      const row = pc.store.rows().find((candidate) => candidate.key === keyOf("k-first"));
      expect({ name, access: pc.store.access(row!.id) }).toEqual({ name, access: { refused: "join_hold", seconds: 10 } });
    }

    // used up by its first use: the same key named again after it left takes the hold
    ok.store.commitList(list([]));
    ok.store.commitList(list(["k-first"]));
    expect(ok.store.access(ok.store.rows()[0]!.id)).toEqual({ refused: "join_hold", seconds: 10 });
  });
});
