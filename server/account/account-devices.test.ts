import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DeviceStore } from "../devices.ts";
import { privateStateFs } from "../private-state.ts";
import { JOIN_HOLD_MS } from "./join-hold.ts";
import { ACCOUNT_DEVICES_FILE, ACCOUNT_DEVICES_MAX, AccountDeviceStore, EXPIRY_DAYS, type AccountRowPorts, accountRowsFor } from "./account-devices.ts";
import { keyOf, listOrigins, snapshotList as list, nameOf, SERVER } from "./account-devices.test-helpers.ts";
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function stateDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "s2-25-"));
  dirs.push(dir);
  return dir;
}

function fileKeys(dir: string): string[] {
  const path = join(dir, ACCOUNT_DEVICES_FILE);
  if (!existsSync(path)) return [];
  return (JSON.parse(readFileSync(path, "utf8")) as { devices: { key: string }[] }).devices.map((row) => nameOf(row.key));
}

/** Ports that record their calls in order, with what the file held at each journal entry. */
const clock = { now: Date.UTC(2026, 0, 1) };

function ports(dir: string, over: Partial<AccountRowPorts> = {}) {
  const events: string[] = [];
  const base: AccountRowPorts = {
    admitListedRows: write => [...write()],
    journal: (entry) => { events.push(`journal ${entry.kind} ${nameOf(entry.key)} file=[${fileKeys(dir).join(",")}]`); },
    closeSessions: (rowId, reason) => { events.push(`close ${rowId} ${reason}`); },
    heldByDevicesJson: () => false,
    hasNoticeSlot: () => true,
    admits: () => true,
    publish: () => {},
    now: () => clock.now,
    admitOrigin: listOrigins(),
    firstDevice: { othersEver: () => true, setOthersEver: () => {}, listKey: () => null, otherRows: () => false },
  };
  return { events, ports: { ...base, ...over } };
}

describe("S2-25 account-joined rows in their own file (T34, T35, T44, T49)", () => {
  test("T34: guarded whole read journals before writing a capped account row and makes it non-live until the hold is satisfied", () => {
    const dir = stateDir();
    const { events, ports: p } = ports(dir, { admits: (key) => key !== keyOf("k-guarded"), heldByDevicesJson: (key) => key === keyOf("k-paired") });
    const store = new AccountDeviceStore(dir, SERVER, p);
    const result = store.commitList(list(["k-1", "k-guarded", "k-paired"]));
    expect(result).toEqual({ admitted: [keyOf("k-1")], dropped: [] });
    // the journal entry is on disk before the row is: the file did not hold the key when it was journalled
    expect(events).toEqual(["journal admit k-1 file=[]"]);
    expect(fileKeys(dir)).toEqual(["k-1"]);
    const [row] = store.rows();
    expect(row).toMatchObject({ key: keyOf("k-1"), no: 1, label: "k-1", origin: { from: "remote", how: "list", by: null }, state: "hold" });
    expect(store.live(row!.id)).toBe(false);
    clock.now += JOIN_HOLD_MS;
    expect(store.access(row!.id)).toEqual({ ok: true });
    expect(store.live(row!.id)).toBe(true);
    expect(new AccountDeviceStore(dir, SERVER, p).live(row!.id)).toBe(true);

    // a failed journal write admits nobody: no row in memory, none on disk
    const failing = stateDir();
    const broken = new AccountDeviceStore(failing, SERVER, ports(failing, { journal: () => { throw new Error("disk full"); } }).ports);
    expect(() => broken.commitList(list(["k-1"]))).toThrow("disk full");
    expect(broken.rows()).toEqual([]);
    expect(fileKeys(failing)).toEqual([]);

    // capped: past the cap the list admits nobody more
    const capped = stateDir();
    const many = Array.from({ length: ACCOUNT_DEVICES_MAX + 3 }, (_, index) => `k-${index}`);
    const full = new AccountDeviceStore(capped, SERVER, ports(capped).ports);
    expect(full.commitList(list(many)).admitted).toHaveLength(ACCOUNT_DEVICES_MAX);
    expect(fileKeys(capped)).toHaveLength(ACCOUNT_DEVICES_MAX);
  });

  test("T35: a well-formed list drop closes only account-joined rows with no new marker and cannot give authority by account order", () => {
    const dir = stateDir();
    const { events, ports: p } = ports(dir);
    const store = new AccountDeviceStore(dir, SERVER, p);
    store.commitList(list(["k-1", "k-2", "k-3"]));
    clock.now += JOIN_HOLD_MS;
    for (const row of store.rows()) store.access(row.id);
    events.length = 0;

    const [one, two, three] = store.rows();
    const result = store.commitList({ ...list(["k-1", "k-3"], ["k-2"], 2, (name) => name !== "k-3") });
    expect(result).toEqual({ admitted: [], dropped: [keyOf("k-2"), keyOf("k-3")] });
    // sessions first, then the journal, then the file
    expect(events).toEqual([
      `close ${two!.id} list`, `close ${three!.id} list`,
      "journal drop k-2 file=[k-1,k-2,k-3]", "journal drop k-3 file=[k-1,k-2,k-3]",
    ]);
    expect(fileKeys(dir)).toEqual(["k-1"]);
    expect(store.live(one!.id)).toBe(true);
    for (const file of ["account-tombstones.json", "account-removed.json", "devices.json"]) expect({ file, exists: existsSync(join(dir, file)) }).toEqual({ file, exists: false });

    // named again by a later list: a new row with a new admission and a new hold, whatever its order says
    events.length = 0;
    expect(store.commitList(list(["k-1", "k-2"], [], 3)).admitted).toEqual([keyOf("k-2")]);
    expect(events).toEqual(["journal admit k-2 file=[k-1]"]);
    expect(store.live(two!.id)).toBe(false);
  });

  test("T35: a failed drop journal cannot keep omitted rows or their sessions", () => {
    const dir = stateDir();
    const closed: string[] = [];
    const store = new AccountDeviceStore(dir, SERVER, ports(dir, {
      closeSessions: id => { closed.push(id); },
      journal: entry => { if (entry.kind === "drop") throw new Error("journal unavailable"); },
    }).ports);
    store.commitList(list(["k-1", "k-2", "k-3"]));
    const omitted = store.rows().filter(row => row.key !== keyOf("k-2")).map(row => row.id);

    expect(() => store.commitList(list(["k-2"], [], 2))).toThrow("journal unavailable");
    expect({ closed, memory: store.rows().map(row => nameOf(row.key)), disk: fileKeys(dir) })
      .toEqual({ closed: omitted, memory: ["k-2"], disk: ["k-2"] });
  });

  test("T44: clearing binding or resetting identity drops account rows, but the last member leaving does not", () => {
    for (const reason of ["remove", "revoke_all", "identity_reset"] as const) {
      const dir = stateDir();
      const { events, ports: p } = ports(dir);
      const store = new AccountDeviceStore(dir, SERVER, p);
      store.commitList(list(["k-1", "k-2"]));
      events.length = 0;
      const ids = store.rows().map((row) => row.id);
      store.clear(reason);
      expect({ reason, events }).toEqual({ reason, events: [`close ${ids[0]} ${reason}`, `close ${ids[1]} ${reason}`, "journal drop k-1 file=[k-1,k-2]", "journal drop k-2 file=[k-1,k-2]"] });
      expect(fileKeys(dir)).toEqual([]);
      expect(new AccountDeviceStore(dir, SERVER, p).rows()).toEqual([]);
    }

    // devices.json losing its last member row is no clear: the account rows stay
    const dir = stateDir();
    const { ports: p } = ports(dir);
    const store = new AccountDeviceStore(dir, SERVER, p);
    store.commitList(list(["k-1"]));
    rmSync(join(dir, "devices.json"), { force: true });
    expect(new AccountDeviceStore(dir, SERVER, p).rows().map((row) => nameOf(row.key))).toEqual(["k-1"]);
  });

  test("T49: an old binary ignores the separate account file", () => {
    const dir = stateDir();
    const store = new AccountDeviceStore(dir, SERVER, ports(dir).ports);
    store.commitList(list(["k-1"]));
    expect(existsSync(join(dir, "devices.json"))).toBe(false);
    const devices = new DeviceStore(dir);
    expect(devices.list(null, true)).toEqual([]);
    expect(devices.hasKey(keyOf("k-1"))).toBe(false);
  });

  test("T34: a file for another relay identity or one that will not parse admits and serves nobody", () => {
    const dir = stateDir();
    new AccountDeviceStore(dir, SERVER, ports(dir).ports).commitList(list(["k-1"]));
    expect(new AccountDeviceStore(dir, "f".repeat(32), ports(dir).ports).rows()).toEqual([]);

    const bad = stateDir();
    writeFileSync(join(bad, ACCOUNT_DEVICES_FILE), "{not json");
    const broken = new AccountDeviceStore(bad, SERVER, ports(bad).ports);
    expect(broken.error).not.toBeNull();
    expect(() => broken.commitList(list(["k-1"]))).toThrow();
    expect(readFileSync(join(bad, ACCOUNT_DEVICES_FILE), "utf8")).toBe("{not json");
  });

  test("T34: the store answers Track A's deny path for its rows: by id, by key, and a removal that only persists and journals", () => {
    const dir = stateDir();
    const { events, ports: p } = ports(dir);
    const store = new AccountDeviceStore(dir, SERVER, p);
    store.commitList(list(["k-1", "k-2"]));
    events.length = 0;
    const [one, two] = store.rows();
    expect(store.row(one!.id)).toEqual(one!);
    expect(store.row("0".repeat(16))).toBeNull();
    expect(store.rowsByKey(keyOf("k-2"))).toEqual([two!]);
    expect(store.rowsByKey(keyOf("k-none"))).toEqual([]);
    store.removeRows([two!.id], "block");
    // the deny turn already closed the sessions: the store journals and writes, and closes nothing
    expect(events).toEqual(["journal drop k-2 file=[k-1,k-2]"]);
    expect(fileKeys(dir)).toEqual(["k-1"]);
    expect(store.row(two!.id)).toBeNull();
  });

  test("T44: a new relay identity ends the rows of the old one: their sessions close and the file holds none", () => {
    const dir = stateDir();
    const { ports: p } = ports(dir);
    const closed: string[] = [];
    let serverId: string | null = SERVER;
    const source = accountRowsFor(dir, () => serverId, { ...p, closeSessions: (id: string) => { closed.push(id); } });
    source.store()!.commitList(list(["k-1"]));
    const [row] = source.rows();
    serverId = "f".repeat(32);
    expect(source.rows()).toEqual([]);
    expect(closed).toEqual([row!.id]);
    expect(fileKeys(dir)).toEqual([]);
  });

  test("T44: a reader called back from the old rows' clear, as an identity changes, sees no rows and does not open the store again", () => {
    const dir = stateDir();
    let serverId: string | null = SERVER;
    const seen: (string | null)[] = [];
    let rowId: string | null = null;
    // what DeviceStore.listsAccountRow does when a write settles a waiting list notice (JoinNotices.settleListed)
    let read: () => void = () => {};
    const { ports: p } = ports(dir, { settleNotices: () => { read(); } });
    const source = accountRowsFor(dir, () => serverId, p);
    source.store()!.commitList(list(["k-1"]));
    rowId = source.rows()[0]!.id;
    read = () => { if (rowId !== null) seen.push(source.row(rowId)?.id ?? null); };
    serverId = "f".repeat(32);
    expect(source.rows()).toEqual([]);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((id) => id === null)).toBe(true);
    expect(fileKeys(dir)).toEqual([]);
  });

  test("T44: a store opened for another relay identity empties the file at once", () => {
    const dir = stateDir();
    const { ports: p } = ports(dir);
    new AccountDeviceStore(dir, SERVER, p).commitList(list(["k-1"]));
    new AccountDeviceStore(dir, "f".repeat(32), p);
    expect(fileKeys(dir)).toEqual([]);
  });

  test("the rows one whole read admits are told once, together: not on a re-read, a republish, a sign-in or a start; a readmission is a new one", () => {
    const dir = stateDir();
    const told: string[][] = [];
    const down = new Set<string>();
    const { ports: p } = ports(dir, {
      admitted: (rows) => { told.push(rows.map((row) => nameOf(row.key))); },
      publish: (entry) => { if (down.has(nameOf(entry.key))) throw new Error("relay down"); },
    });
    const store = new AccountDeviceStore(dir, SERVER, p);
    store.commitList(list(["k-1", "k-2", "k-3"]));
    expect(told).toEqual([["k-1", "k-2", "k-3"]]);
    store.commitList(list(["k-1", "k-2", "k-3"]));
    clock.now += JOIN_HOLD_MS;
    const [one] = store.rows();
    expect(store.access(one!.id)).toEqual({ ok: true });
    expect(told).toEqual([["k-1", "k-2", "k-3"]]);

    // a notice that could not go out is published again later; the admission was told when its row was written
    down.add("k-4");
    store.commitList(list(["k-1", "k-2", "k-3", "k-4"]));
    expect(told).toEqual([["k-1", "k-2", "k-3"], ["k-4"]]);
    down.clear();
    store.commitList(list(["k-1", "k-2", "k-3", "k-4"]));
    expect(store.rows().find((row) => nameOf(row.key) === "k-4")?.hold_until).not.toBeNull();
    expect(told).toHaveLength(2);

    // a start reads the rows it had: none of them is news
    const reopened = new AccountDeviceStore(dir, SERVER, p);
    reopened.commitList(list(["k-1", "k-2", "k-3", "k-4"]));
    expect(told).toHaveLength(2);

    // an expired row the device itself brings back is a new admission
    clock.now += (EXPIRY_DAYS + 1) * 86_400_000;
    reopened.expire();
    expect(reopened.readmit(keyOf("k-1"), list(["k-1", "k-2", "k-3", "k-4"]))).toBe(true);
    expect(told.at(-1)).toEqual(["k-1"]);
  });

  test("a row on disk is told even when the write of its hold fails after it", () => {
    const dir = stateDir();
    const told: string[] = [];
    const { ports: p } = ports(dir, { admitted: (rows) => { told.push(...rows.map((row) => nameOf(row.key))); } });
    const store = new AccountDeviceStore(dir, SERVER, p);
    const rename = privateStateFs.renameSync;
    // the second write of an admission, the one that starts its ten seconds, cannot be made
    const fault = spyOn(privateStateFs, "renameSync").mockImplementation((from, to) => {
      if (String(to).endsWith(ACCOUNT_DEVICES_FILE) && /"hold_until":\s*"/.test(readFileSync(from, "utf8"))) throw new Error("disk full");
      rename(from, to);
    });
    try { expect(() => store.commitList(list(["k-1"]))).toThrow("disk full"); }
    finally { fault.mockRestore(); }
    expect(fileKeys(dir)).toEqual(["k-1"]);
    expect(told).toEqual(["k-1"]);
    // the next read publishes its notice again (republish) and tells nothing new
    store.commitList(list(["k-1"]));
    expect(store.rows()[0]?.hold_until).not.toBeNull();
    expect(told).toEqual(["k-1"]);
  });

  test("an announcement that fails is only logged: the admission stands", () => {
    const dir = stateDir();
    const asked: string[] = [];
    const { ports: p } = ports(dir, { admitted: (rows) => { asked.push(...rows.map((row) => nameOf(row.key))); throw new Error("no window"); } });
    const store = new AccountDeviceStore(dir, SERVER, p);
    expect(store.commitList(list(["k-1"])).admitted).toEqual([keyOf("k-1")]);
    expect(asked).toEqual(["k-1"]);
    expect(fileKeys(dir)).toEqual(["k-1"]);
  });

  test("a row stands while it is admitted: in its hold, then out of it only through the admission guard, and never once expired", () => {
    const dir = stateDir();
    const guard = { admits: true };
    let settled = 0;
    const { ports: p } = ports(dir, { admits: () => guard.admits, settleNotices: () => { settled++; } });
    const store = new AccountDeviceStore(dir, SERVER, p);
    store.commitList(list(["k-1"]));
    const [row] = store.rows();
    expect(store.standing(row!.id)).toBe(true);
    guard.admits = false;
    // in its ten seconds the guard is not asked yet
    expect(store.standing(row!.id)).toBe(true);
    clock.now += JOIN_HOLD_MS;
    expect(store.standing(row!.id)).toBe(false);
    // the refusal settles what was said of its admission (DeviceStore.onListedChange takes the notice back)
    const before = settled;
    expect(store.access(row!.id)).toEqual({ refused: "admission" });
    expect(settled).toBe(before + 1);
    guard.admits = true;
    expect(store.standing(row!.id)).toBe(true);
    expect(store.access(row!.id)).toEqual({ ok: true });
    clock.now += (EXPIRY_DAYS + 1) * 86_400_000;
    expect(store.standing(row!.id)).toBe(false);
    expect(store.standing("0000000000000000")).toBe(false);
  });
});

describe("what the record of how long a key has been let in reads of the rows (witnessed)", () => {
  test("a row counts once it is out of its hold; a waiting row lets nobody in unless a release of this PC's own lets that row in", () => {
    const dir = stateDir();
    const released = new Set<string>();
    let off = false;
    const { ports: p } = ports(dir, { releaseOf: (id) => released.has(id) ? "release-1" : null, serviceStep2Off: () => off });
    const store = new AccountDeviceStore(dir, SERVER, p);
    store.commitList(list(["k-1", "k-2"]));
    // in their hold: no row of the record yet
    expect(store.witnessed()).toEqual([]);
    clock.now += JOIN_HOLD_MS;
    for (const row of store.rows()) expect(store.access(row.id)).toEqual({ ok: true });
    expect(store.witnessed()).toEqual([{ key: keyOf("k-1"), lets: true, seen: null }, { key: keyOf("k-2"), lets: true, seen: null }]);
    // after a start every row waits for a whole read
    const again = new AccountDeviceStore(dir, SERVER, p);
    const [one] = again.rows();
    expect(again.witnessed()?.map((row) => row.lets)).toEqual([false, false]);
    // a release a person at this PC gave lets that one row in while it waits, as its sign-in is let in
    released.add(one!.id);
    expect(again.access(one!.id)).toEqual({ ok: true });
    expect(again.witnessed()?.map((row) => row.lets)).toEqual([true, false]);
    // with Step 2 off here no row of the account is let in, a released one included
    off = true;
    expect(again.witnessed()?.map((row) => row.lets)).toEqual([false, false]);
    off = false;
    again.commitList(list(["k-1", "k-2"]));
    expect(again.witnessed()?.map((row) => row.lets)).toEqual([true, true]);
  });
});

describe("a key a person at this PC has just let in", () => {
  test("waits no join hold on its row, also while no notice can be made: making that row live takes none", () => {
    const dir = stateDir();
    const slots = { free: true };
    const { ports: p } = ports(dir, { hasNoticeSlot: () => slots.free });
    const store = new AccountDeviceStore(dir, SERVER, p);
    store.commitList(list(["k-1", "k-2"]));
    expect(store.rows().map((row) => row.state)).toEqual(["hold", "hold"]);
    // every notice is taken: nobody new is admitted, and the row of the key a person let in goes live all the same
    slots.free = false;
    expect(store.commitList(list(["k-1", "k-2", "k-3"], [], 2), undefined, (key) => key === keyOf("k-2")).admitted).toEqual([]);
    expect(store.rows().map((row) => [nameOf(row.key), row.state])).toEqual([["k-1", "hold"], ["k-2", "live"]]);
  });
});

describe("a row that moves with its device's hand-over (a list's `moved`)", () => {
  test("a held row that waits for a whole read keeps waiting under its new key, and gets a fresh hold when the read comes, as it would have under the old", () => {
    const dir = stateDir();
    const { ports: p } = ports(dir);
    const store = new AccountDeviceStore(dir, SERVER, p);
    store.commitList(list(["k-old"]));
    const [held] = store.rows();
    expect(held).toMatchObject({ state: "hold" });
    // no whole read for an hour: every row waits for one (T56), and the hold's deadline passes meanwhile
    store.waitForRead();
    clock.now += 2 * JOIN_HOLD_MS;
    const moved = { ...list(["k-new"]), moved: [{ from: keyOf("k-old"), to: keyOf("k-new") }] };
    store.commitList(moved);
    const row = store.rows().find((candidate) => candidate.key === keyOf("k-new"))!;
    expect(row).toMatchObject({ no: held!.no, state: "hold" });
    // the read that ended its wait starts its hold again: it is not let in at once
    expect(Date.parse(row.hold_until!)).toBe(clock.now + JOIN_HOLD_MS);
    expect(store.access(row.id)).toMatchObject({ refused: "join_hold" });
  });
});

describe("the names of the rows", () => {
  test("a row still named by the placeholder takes the list's name for it, from the list's commits alone: a snapshot's leaves it as it is", () => {
    const dir = stateDir();
    const store = new AccountDeviceStore(dir, SERVER, ports(dir).ports);
    const named = (label: string) => ({ ...list(["k-1"]), devices: list(["k-1"]).devices.map((entry) => ({ ...entry, label })) });
    store.commitList(named("Device"));
    expect(store.rows()[0]?.label).toBe("Device");
    // a whole read of the account service's snapshot (a PC that follows no list) names nothing anew
    store.commitList(named("Dana's tablet"));
    expect(store.rows()[0]?.label).toBe("Device");
    // the list's own commit (names: true) does
    store.commitList({ ...named("Dana's tablet"), names: true });
    expect(store.rows()[0]?.label).toBe("Dana's tablet");
  });
});

