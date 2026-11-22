import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AccountDeviceStore, STALE_READ_MS, type AccountRowPorts } from "./account-devices.ts";
import { keyOf, listOrigins, nameOf, SERVER, snapshotList } from "./account-devices.test-helpers.ts";
import { JOIN_HOLD_MS } from "./join-hold.ts";
import { RecoveryReleases } from "./recovery.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function machine() {
  const dir = mkdtempSync(join(tmpdir(), "s2-27-"));
  dirs.push(dir);
  const clock = { now: Date.UTC(2026, 0, 1, 12) };
  const events: string[] = [];
  const frozen = new Set<string>();
  const releases = new RecoveryReleases({ journal: () => {} });
  const ports: AccountRowPorts = {
    releaseOf: id => releases.releaseOf(id),
    admitListedRows: write => [...write()],
    journal: (entry) => { events.push(`journal ${entry.kind} ${nameOf(entry.key)}`); },
    closeSessions: (rowId, reason) => { events.push(`close ${rowId} ${reason}`); },
    heldByDevicesJson: () => false,
    admits: (key) => !frozen.has(nameOf(key)),
    hasNoticeSlot: () => true,
    publish: () => {},
    now: () => clock.now,
    admitOrigin: listOrigins(),
    firstDevice: { othersEver: () => true, setOthersEver: () => {}, listKey: () => null, otherRows: () => false },
  };
  const list = (names: readonly string[]) => snapshotList(names);
  const start = () => new AccountDeviceStore(dir, SERVER, ports);
  const store = start();
  store.commitList(list(["k-live", "k-held"]));
  clock.now += JOIN_HOLD_MS;
  const [live, held] = store.rows();
  store.access(live!.id);
  events.length = 0;
  const release = (target: AccountDeviceStore, keys: readonly string[]) => {
    const named = target.waitingRows().filter(row => keys.includes(row.key));
    if (named.length) releases.release(named, "owner");
    return named.map(row => row.key);
  };
  return { clock, events, frozen, list, start, store, release, live: live!, held: held! };
}

describe("S2-27 account-joined rows wait for the catch-up (T41, T42, T56, T65, T70)", () => {
  test("T41: every non-screen-paired row waits after restart or first binding, including legacy with no metadata", () => {
    const pc = machine();
    const restarted = pc.start();
    expect(restarted.access(pc.live.id)).toEqual({ refused: "catching_up" });
    expect(restarted.access(pc.held.id)).toEqual({ refused: "catching_up" });
    // the wait has no time limit: only a whole read ends it
    // no time ends the wait; past EXPIRY_DAYS the row would expire instead (T54), so stay short of it
    pc.clock.now += 30 * 24 * 60 * 60_000;
    expect(restarted.access(pc.live.id)).toEqual({ refused: "catching_up" });
  });

  test("T42: whole-read release rechecks the gate and restarts carried holds in either file", () => {
    const pc = machine();
    const restarted = pc.start();
    pc.frozen.add("k-live");
    restarted.commitList(pc.list(["k-live", "k-held"]));
    expect(restarted.access(pc.live.id)).toEqual({ refused: "not_listed" });
    // a carried hold starts its ten seconds again from the release
    expect(restarted.access(pc.held.id)).toEqual({ refused: "join_hold", seconds: 10 });
    pc.frozen.delete("k-live");
    restarted.commitList(pc.list(["k-live", "k-held"]));
    expect(restarted.access(pc.live.id)).toEqual({ refused: "join_hold", seconds: 10 });
    expect(restarted.row(pc.live.id)?.origin.admit_no).toBeGreaterThan(pc.live.origin.admit_no);
    pc.clock.now += JOIN_HOLD_MS;
    expect(restarted.access(pc.live.id)).toEqual({ ok: true });
  });

  test("T56: a stale whole read puts account-only rows on hold and ends their sessions", () => {
    const pc = machine();
    pc.store.commitList(pc.list(["k-live", "k-held"]));
    pc.events.length = 0;
    const readAt = pc.clock.now;
    pc.clock.now = readAt + STALE_READ_MS - 1;
    expect(pc.store.access(pc.live.id)).toEqual({ ok: true });
    pc.clock.now = readAt + STALE_READ_MS;
    pc.store.waitForRead();
    expect(pc.events).toEqual([`close ${pc.live.id} catching_up`, `close ${pc.held.id} catching_up`]);
    expect(pc.store.access(pc.live.id)).toEqual({ refused: "catching_up" });
    pc.store.waitForRead();
    expect(pc.events).toHaveLength(2);
  });

  test("T65: service-off keeps the wait; only named released rows have the accepted gap until denial arrives", () => {
    const pc = machine();
    const restarted = pc.start();
    expect(pc.release(restarted, [keyOf("k-live")])).toEqual([keyOf("k-live")]);
    expect(restarted.access(pc.live.id)).toEqual({ ok: true });
    expect(restarted.access(pc.held.id)).toEqual({ refused: "catching_up" });
  });

  test("T70: headless account-only rows can be released by name and first whole read rejudges them", () => {
    const pc = machine();
    const restarted = pc.start();
    expect(pc.release(restarted, [keyOf("k-live"), keyOf("k-unknown")])).toEqual([keyOf("k-live")]);
    pc.frozen.add("k-live");
    restarted.commitList(pc.list(["k-live", "k-held"]));
    expect(restarted.access(pc.live.id)).toEqual({ refused: "not_listed" });
    // The dropped row cannot be released again or recovered by a restart.
    expect(pc.release(restarted, [keyOf("k-live")])).toEqual([]);
    expect(pc.start().access(pc.live.id)).toEqual({ refused: "not_listed" });
  });
});
