import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DeviceStore } from "../devices.ts";
import { JOIN_HOLD_MS } from "./join-hold.ts";
import { ACCOUNT_DEVICES_FILE, ACCOUNT_DEVICES_MAX, AccountDeviceStore, type AccountRowPorts, accountRowsFor } from "./account-devices.ts";
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

  test("T44: a store opened for another relay identity empties the file at once", () => {
    const dir = stateDir();
    const { ports: p } = ports(dir);
    new AccountDeviceStore(dir, SERVER, p).commitList(list(["k-1"]));
    new AccountDeviceStore(dir, "f".repeat(32), p);
    expect(fileKeys(dir)).toEqual([]);
  });
});
