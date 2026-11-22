import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ACCOUNT_DEVICES_FILE, AccountDeviceStore, EXPIRY_DAYS, type AccountRowPorts } from "./account-devices.ts";
import { keyOf, listOrigins, nameOf, SERVER, snapshotList } from "./account-devices.test-helpers.ts";
import { JOIN_HOLD_MS } from "./join-hold.ts";

const DAY = 24 * 60 * 60_000;
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function machine() {
  const dir = mkdtempSync(join(tmpdir(), "s2-28-"));
  dirs.push(dir);
  const clock = { now: Date.UTC(2026, 0, 1, 12) };
  const events: string[] = [];
  const guard = { admits: true };
  const ports: AccountRowPorts = {
    admitListedRows: write => [...write()],
    journal: (entry) => { events.push(`journal ${entry.kind} ${nameOf(entry.key)}${entry.reason ? ` ${entry.reason}` : ""}`); },
    closeSessions: (rowId, reason) => { events.push(`close ${rowId} ${reason}`); },
    heldByDevicesJson: () => false,
    admits: () => guard.admits,
    hasNoticeSlot: () => true,
    publish: (entry) => { events.push(`publish ${nameOf(entry.key)}`); },
    now: () => clock.now,
    admitOrigin: listOrigins(),
    firstDevice: { othersEver: () => true, setOthersEver: () => {}, listKey: () => null, otherRows: () => false },
  };
  const store = new AccountDeviceStore(dir, SERVER, ports);
  const list = (names: readonly string[]) => snapshotList(names);
  const live = (keys: readonly string[]) => {
    store.commitList(list(keys));
    clock.now += JOIN_HOLD_MS;
    for (const row of store.rows()) store.access(row.id);
    events.length = 0;
  };
  const day = (id: string) => (JSON.parse(readFileSync(join(dir, ACCOUNT_DEVICES_FILE), "utf8")) as { devices: { id: string; last_signin_day: string | null; state: string }[] }).devices.find((row) => row.id === id);
  return { clock, events, guard, store, list, live, day };
}

describe("S2-28 expiry by use this PC saw (T54, T55)", () => {
  test("T54: only authenticated PC use moves the day and 60 idle days end the local account row", () => {
    const pc = machine();
    pc.live(["k-used", "k-idle"]);
    const [used, idle] = pc.store.rows();
    // an admission is no use: the day stays empty until this PC sees the row sign in, and expiry counts from admission
    expect(pc.day(used!.id)?.last_signin_day).toBeNull();

    // a list naming the key, a refused sign-in and a later read are no use: only a proved sign-in or request is
    pc.clock.now += 30 * DAY;
    pc.store.commitList(pc.list(["k-used", "k-idle"]));
    pc.store.seen(used!.id);
    expect(pc.day(used!.id)?.last_signin_day).toBe("2026-01-31");
    expect(pc.day(idle!.id)?.last_signin_day).toBeNull();

    // day 59 of idleness: still live; day 60: closed, journalled, kept as expired
    pc.clock.now = Date.UTC(2026, 0, 1, 12) + (EXPIRY_DAYS - 1) * DAY;
    expect(pc.store.expire()).toEqual([]);
    pc.clock.now += DAY;
    expect(pc.store.expire()).toEqual([keyOf("k-idle")]);
    expect(pc.events).toEqual([`close ${idle!.id} expired`, "journal drop k-idle expired"]);
    expect(pc.day(idle!.id)?.state).toBe("expired");
    expect(pc.store.access(idle!.id)).toEqual({ refused: "expired" });
    expect(pc.store.access(used!.id)).toEqual({ ok: true });

    // a session's use is written at most once a day
    pc.events.length = 0;
    pc.store.seen(used!.id);
    pc.store.seen(used!.id);
    expect(pc.store.expire()).toEqual([]);
  });

  test("T55: list alone cannot revive an expired row; its own proved attempt readmits through all guards with a new hold", () => {
    const pc = machine();
    pc.live(["k-1"]);
    const [row] = pc.store.rows();
    pc.clock.now += EXPIRY_DAYS * DAY;
    pc.store.expire();
    pc.events.length = 0;

    expect(pc.store.commitList(pc.list(["k-1"])).admitted).toEqual([]);
    expect(pc.store.access(row!.id)).toEqual({ refused: "expired" });
    expect(pc.events).toEqual([]);

    // the device's own attempt: refused while the guard says no, then a new admission with a new notice and hold
    pc.guard.admits = false;
    expect(pc.store.readmit(keyOf("k-1"), pc.list(["k-1"]))).toBe(false);
    expect(pc.store.access(row!.id)).toEqual({ refused: "expired" });
    pc.guard.admits = true;
    expect(pc.store.readmit(keyOf("k-1"), pc.list([]))).toBe(false);
    expect(pc.store.readmit(keyOf("k-1"), pc.list(["k-1"]))).toBe(true);
    expect(pc.events).toEqual(["journal admit k-1", "publish k-1"]);
    expect(pc.store.access(row!.id)).toEqual({ refused: "join_hold", seconds: 10 });
    expect(pc.day(row!.id)?.last_signin_day).toBeNull();
  });

  test("P9: only a use this PC saw is reported, as a UTC day per key; an admission alone reports nothing", () => {
    const pc = machine();
    pc.live(["k-used", "k-quiet"]);
    const [used] = pc.store.rows();
    expect(pc.store.usedReport()).toEqual([]);
    pc.clock.now += 3 * DAY;
    pc.store.seen(used!.id);
    expect(pc.store.usedReport()).toEqual([{ key: keyOf("k-used"), day: "2026-01-04" }]);
  });
});
