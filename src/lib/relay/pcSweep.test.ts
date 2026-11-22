import { afterEach, beforeEach, expect, it, jest } from "bun:test";
import { createPcSweep } from "./pcSweep.ts";
import type { RelayDevice, RelayDeviceStore } from "./device.ts";
import type { PcFinding as Found } from "./pcStatus.ts";
import { dashboardModel } from "./dashboard.ts";
import { OFFLINE_AFTER_MS } from "../account/myPcs.ts";
import { exportPublicKey, generateKeyPair } from "../../../shared/relay-e2ee.ts";
import { deriveServerId } from "../../../shared/relay-server-proof.ts";

const descriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
beforeEach(() => {
  const storage = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
  } });
});
afterEach(() => {
  jest.useRealTimers();
  if (descriptor) Object.defineProperty(globalThis, "localStorage", descriptor);
  else Reflect.deleteProperty(globalThis, "localStorage");
});

async function savedPcs(count: number): Promise<{ devices: RelayDevice[]; store: RelayDeviceStore }> {
  const key = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
  const devices: RelayDevice[] = Array.from({ length: count }, (_, index) => {
    const pair = generateKeyPair();
    return { server_id: deriveServerId(pair.publicKey), device_id: String(index), private_key: key.privateKey, public_spki: "fixture",
      label: "Phone", server_public_key: exportPublicKey(pair.publicKey), relay: "wss://relay.ovis.sh" };
  });
  const store: RelayDeviceStore = {
    list: async () => devices, get: async (id) => devices.find((device) => device.server_id === id),
    remove: async () => {}, update: async () => { throw new Error("sweep cannot change pairings"); },
  };
  return { devices, store };
}

function heldProbe() {
  const pending: ReturnType<typeof Promise.withResolvers<Found>>[] = [];
  const checked: string[] = [];
  const waiting = new Map<number, ReturnType<typeof Promise.withResolvers<void>>>();
  const arrived = (count: number): Promise<void> => {
    if (checked.length >= count) return Promise.resolve();
    const gate = waiting.get(count) ?? Promise.withResolvers<void>();
    waiting.set(count, gate);
    return gate.promise;
  };
  const probe = async (device: RelayDevice): Promise<Found> => {
    checked.push(device.server_id);
    const result = Promise.withResolvers<Found>();
    pending.push(result);
    waiting.get(checked.length)?.resolve();
    return result.promise;
  };
  return { pending, checked, arrived, probe };
}

it("limits each rotating sweep to eight PCs and two simultaneous checks, including repeated requests", async () => {
  jest.useFakeTimers();
  const { devices, store } = await savedPcs(12);
  const { pending, checked, arrived, probe } = heldProbe();
  const sweep = createPcSweep(store, { active: () => true, redraw() {} }, { probe });
  const first = sweep.check();
  await arrived(2);
  await sweep.check();
  expect(pending).toHaveLength(2);
  for (let wave = 0; wave < 4; wave++) {
    pending[wave * 2]?.resolve({ kind: "answered", route: "relay", rttMs: 20 });
    pending[wave * 2 + 1]?.resolve({ kind: "offline", reason: "pc" });
    if (wave < 3) await arrived((wave + 2) * 2);
  }
  await first;
  expect(checked).toEqual(devices.slice(0, 8).map((device) => device.server_id));
  await sweep.check();
  expect(checked).toHaveLength(8);
  expect(sweep.status.get(devices[0]?.server_id ?? "")).toEqual({ kind: "answered", route: "relay", rttMs: 20 });
  jest.advanceTimersByTime(60_000);
  await arrived(10);
  expect(checked.slice(8)).toEqual(devices.slice(8, 10).map((device) => device.server_id));
  for (let wave = 4; wave < 8; wave++) {
    pending[wave * 2]?.resolve({ kind: "offline", reason: "pc" });
    pending[wave * 2 + 1]?.resolve({ kind: "offline", reason: "pc" });
    if (wave < 7) await arrived((wave + 2) * 2);
  }
  await arrived(16);
  expect(checked.slice(8)).toEqual([...devices.slice(8), ...devices.slice(0, 4)].map((device) => device.server_id));
});

it("checks exactly the PC asked for, ahead of a sweep's remaining PCs and within its two checks at once, and never twice while its check runs", async () => {
  const { devices, store } = await savedPcs(12);
  const ids = devices.map((device) => device.server_id);
  const [queued, outside] = [ids[7] ?? "", ids[10] ?? ""];
  const { pending, checked, arrived, probe } = heldProbe();
  const sweep = createPcSweep(store, { active: () => true, redraw() {} }, { probe });
  const asked = sweep.checkOne(outside);
  await arrived(1);
  expect(checked).toEqual([outside]);
  expect(sweep.status.get(outside)).toEqual({ kind: "checking" });
  const first = sweep.check();
  await arrived(2);
  expect(checked).toEqual([outside, ids[0] ?? ""]);
  const movedUp = sweep.checkOne(queued);
  const another = sweep.checkOne(ids[11] ?? "");
  // asked again while its check runs: no second check, and it settles with that one
  const repeat = sweep.checkOne(outside);
  expect(checked).toHaveLength(2);
  pending[0]?.resolve({ kind: "answered", route: "lan", rttMs: 4 });
  await arrived(3);
  expect(checked[2]).toBe(ids[11]);
  await Promise.all([asked, repeat]);
  expect(sweep.status.get(outside)).toEqual({ kind: "answered", route: "lan", rttMs: 4 });
  pending[1]?.resolve({ kind: "answered", route: "relay", rttMs: 20 });
  await arrived(4);
  expect(checked[3]).toBe(queued);
  pending[2]?.resolve({ kind: "offline", reason: "pc" });
  await another;
  expect(sweep.status.get(ids[11] ?? "")).toEqual({ kind: "offline", reason: "pc" });
  pending[3]?.resolve({ kind: "offline", reason: "pc" });
  await movedUp;
  expect(sweep.status.get(queued)).toEqual({ kind: "offline", reason: "pc" });
  for (let turn = 4; turn < 10; turn++) {
    await arrived(turn + 1);
    pending[turn]?.resolve({ kind: "offline", reason: "pc" });
  }
  await first;
  expect(checked).toEqual([outside, ids[0], ids[11], queued, ...ids.slice(1, 7)].map((id) => id ?? ""));
});

it("lets an answer go once it is older than the directory's 15 minutes, while a newer answer for the PC stays", async () => {
  jest.useFakeTimers();
  const { devices, store } = await savedPcs(1);
  const id = devices[0]?.server_id ?? "";
  const { pending, arrived, probe } = heldProbe();
  let redraws = 0;
  const sweep = createPcSweep(store, { active: () => true, redraw() { redraws += 1; } }, { probe });
  const first = sweep.checkOne(id);
  await arrived(1);
  pending[0]?.resolve({ kind: "answered", route: "relay", rttMs: 20 });
  await first;
  jest.advanceTimersByTime(10 * 60_000);
  const second = sweep.checkOne(id);
  await arrived(2);
  pending[1]?.resolve({ kind: "answered", route: "lan", rttMs: 4 });
  await second;
  jest.advanceTimersByTime(5 * 60_000);
  expect(sweep.status.get(id)).toEqual({ kind: "answered", route: "lan", rttMs: 4 });
  const drawn = redraws;
  jest.advanceTimersByTime(10 * 60_000);
  expect(sweep.status.has(id)).toBe(false);
  expect(redraws).toBe(drawn + 1);
});

it("checks the list again every minute by itself, the PCs a relay refused first, until each of 20 PCs is checked, and calls a PC unanswered only when the relay refuses twice in a row", async () => {
  jest.useFakeTimers();
  const { devices, store } = await savedPcs(20);
  const ids = devices.map((device) => device.server_id);
  const { pending, checked, arrived, probe } = heldProbe();
  // a sweep started by its timer has no promise of its own: its end is the redraw after its last result
  const ends: { readonly count: number; readonly done: ReturnType<typeof Promise.withResolvers<void>> }[] = [];
  const swept = (count: number): Promise<void> => {
    const done = Promise.withResolvers<void>();
    ends.push({ count, done });
    return done.promise;
  };
  const sweep = createPcSweep(store, { active: () => true, redraw() {
    const idle = ids.every((id) => sweep.status.get(id)?.kind !== "checking");
    for (const end of ends) if (idle && checked.length === end.count) end.done.resolve();
  } }, { probe });
  const answer = { kind: "answered", route: "relay", rttMs: 20 } as const;
  const refusal = { kind: "offline", reason: "refused" } as const;
  const run = async (from: number, result: (turn: number) => Found): Promise<void> => {
    const done = swept(from + 8);
    for (let turn = from; turn < from + 8; turn++) {
      await arrived(turn + 1);
      pending[turn]?.resolve(result(turn));
    }
    await done;
  };
  // the cold open after a wave: the relay refuses all eight checks of the first sweep (429s)
  void sweep.check();
  await run(0, () => refusal);
  // a refused check says nothing of the PC: none of the eight says "No answer", they still read as not checked
  expect(ids.filter((id) => sweep.status.has(id))).toEqual([]);
  // a minute on, with nobody pressing anything, the refused eight go first; one is refused again and that is kept
  jest.advanceTimersByTime(60_000);
  await run(8, (turn) => turn === 8 ? refusal : answer);
  expect(checked.slice(8, 16)).toEqual(ids.slice(0, 8));
  expect(sweep.status.get(ids[0] ?? "")).toEqual(refusal);
  // the next two minutes take the twelve not checked yet, eight at a time, then the rotation goes round
  jest.advanceTimersByTime(60_000);
  await run(16, () => answer);
  jest.advanceTimersByTime(60_000);
  await run(24, () => answer);
  expect(checked.slice(16)).toEqual([...ids.slice(8, 20), ...ids.slice(0, 4)]);
  // three minutes after the cold open, every one of the 20 rows has its check's answer
  expect(ids.filter((id) => sweep.status.get(id)?.kind === "answered")).toHaveLength(20);
});

it("keeps what the last finished check found while the minute's re-check runs: an off PC stays Machine offline, in Needs you and under Offline, never Ready", async () => {
  jest.useFakeTimers();
  const { devices, store } = await savedPcs(1);
  const id = devices[0]?.server_id ?? "";
  const { pending, arrived, probe } = heldProbe();
  // a re-check started by the minute's timer has no promise of its own: its end is the redraw after its result
  let drawn: (() => void) | undefined;
  const redrawn = (): Promise<void> => new Promise((resolve) => { drawn = resolve; });
  const sweep = createPcSweep(store, { active: () => true, redraw() { drawn?.(); } }, { probe });
  // the account heard from it lately, so its own word is Ready; this device's check found nobody at the relay
  const row = { server_id: id, name: "Desk PC", state: "paired", last_seen_at: null, added_at: null, listed: true, paired: true, linked: false, relay: null } as const;
  const shown = () => {
    const m = dashboardModel([row], { label: "Me", status: sweep.status }, "wss://relay.ovis.sh");
    return { state: m.rows[0]?.displayState, ready: m.filters.ready, needs: m.filters.needs, offline: m.filters.offline };
  };
  const first = sweep.check();
  await arrived(1);
  pending[0]?.resolve({ kind: "offline", reason: "pc" });
  await first;
  const off: ReturnType<typeof shown> = { state: "offline", ready: [], needs: [id], offline: [id] };
  expect(shown()).toEqual(off);
  jest.advanceTimersByTime(60_000);
  await arrived(2);
  expect(sweep.status.get(id)?.kind).toBe("checking");
  expect(shown()).toEqual(off);
  const settled = redrawn();
  pending[1]?.resolve({ kind: "answered", route: "relay", rttMs: 20 });
  await settled;
  expect(shown()).toEqual({ state: "paired", ready: [id], needs: [], offline: [] });
});

it("lets an answer lapse during a re-check the relay then refuses: the row neither keeps it meanwhile nor gets it back", async () => {
  jest.useFakeTimers();
  const { devices, store } = await savedPcs(1);
  const id = devices[0]?.server_id ?? "";
  const { pending, arrived, probe } = heldProbe();
  const sweep = createPcSweep(store, { active: () => true, redraw() {} }, { probe });
  const answered = sweep.checkOne(id);
  await arrived(1);
  pending[0]?.resolve({ kind: "answered", route: "relay", rttMs: 20 });
  await answered;
  jest.advanceTimersByTime(OFFLINE_AFTER_MS - 60_000);
  const refused = sweep.checkOne(id);
  await arrived(2);
  expect(sweep.status.get(id)).toEqual({ kind: "checking", previous: { kind: "answered", route: "relay", rttMs: 20 } });
  jest.advanceTimersByTime(60_000);
  expect(sweep.status.get(id)).toEqual({ kind: "checking" });
  pending[1]?.resolve({ kind: "offline", reason: "relay" });
  await refused;
  expect(sweep.status.has(id)).toBe(false);
});

it("sweeps again exactly a minute after the last sweep began, and a sweep that comes due while the page is hidden waits until it is shown", async () => {
  jest.useFakeTimers();
  const page = { visibilityState: "visible" };
  Object.defineProperty(globalThis, "document", { configurable: true, value: page });
  try {
    const { store } = await savedPcs(1);
    const { pending, checked, arrived, probe } = heldProbe();
    const sweep = createPcSweep(store, { active: () => true, redraw() {} }, { probe });
    const first = sweep.check();
    await arrived(1);
    pending[0]?.resolve({ kind: "offline", reason: "pc" });
    await first;
    jest.advanceTimersByTime(59_999);
    for (let turn = 0; turn < 500; turn++) await Promise.resolve();
    expect(checked).toHaveLength(1);
    jest.advanceTimersByTime(1);
    await arrived(2);
    // the next minute comes due while this sweep's check is still out: the sweep waits for it, and the page is hidden meanwhile
    jest.advanceTimersByTime(60_000);
    page.visibilityState = "hidden";
    pending[1]?.resolve({ kind: "offline", reason: "pc" });
    for (let turn = 0; turn < 500; turn++) await Promise.resolve();
    expect(checked).toHaveLength(2);
    page.visibilityState = "visible";
    jest.advanceTimersByTime(60_000);
    await arrived(3);
  } finally { Reflect.deleteProperty(globalThis, "document"); }
});

it("lets a tab that finds another tab's sweep this minute wait for the next one, and sweep then once that tab is gone", async () => {
  jest.useFakeTimers();
  const { devices, store } = await savedPcs(8);
  const ids = devices.map((device) => device.server_id);
  const { pending, checked, arrived, probe } = heldProbe();
  let aShown = true;
  const tabA = createPcSweep(store, { active: () => aShown, redraw() {} }, { probe });
  const tabB = createPcSweep(store, { active: () => true, redraw() {} }, { probe });
  const first = tabA.check();
  await arrived(2);
  // B is shown too: A's sweep began this minute (the shared gap), so B checks nothing and waits for the next one
  await tabB.check();
  expect(ids.filter((id) => tabB.status.has(id))).toEqual([]);
  for (let turn = 0; turn < 8; turn++) {
    pending[turn]?.resolve({ kind: "offline", reason: "pc" });
    if (turn + 3 <= 8) await arrived(turn + 3);
  }
  await first;
  // A's tab is closed: B's own minute, armed when it found A's sweep, sweeps
  aShown = false;
  jest.advanceTimersByTime(60_000);
  await arrived(10);
  expect(ids.filter((id) => tabB.status.get(id)?.kind === "checking")).toEqual(ids);
  expect(checked).toHaveLength(10);
});

it("keeps a PC's earlier answer when the relay refuses its next check", async () => {
  const { devices, store } = await savedPcs(1);
  const id = devices[0]?.server_id ?? "";
  const { pending, arrived, probe } = heldProbe();
  const sweep = createPcSweep(store, { active: () => true, redraw() {} }, { probe });
  const answered = sweep.checkOne(id);
  await arrived(1);
  pending[0]?.resolve({ kind: "answered", route: "lan", rttMs: 4 });
  await answered;
  const refused = sweep.checkOne(id);
  await arrived(2);
  pending[1]?.resolve({ kind: "offline", reason: "relay" });
  await refused;
  expect(sweep.status.get(id)).toEqual({ kind: "answered", route: "lan", rttMs: 4 });
});

it("starts no sweep of its own while its page is hidden, and the first minute after it is shown again sweeps", async () => {
  jest.useFakeTimers();
  const page = { visibilityState: "visible" };
  Object.defineProperty(globalThis, "document", { configurable: true, value: page });
  try {
    const { store } = await savedPcs(1);
    const { pending, checked, arrived, probe } = heldProbe();
    const sweep = createPcSweep(store, { active: () => true, redraw() {} }, { probe });
    const first = sweep.check();
    await arrived(1);
    pending[0]?.resolve({ kind: "answered", route: "relay", rttMs: 20 });
    await first;
    page.visibilityState = "hidden";
    jest.advanceTimersByTime(180_000);
    // enough turns for a sweep wrongly started to reach the probe (it takes a few)
    for (let turn = 0; turn < 500; turn++) await Promise.resolve();
    expect(checked).toHaveLength(1);
    page.visibilityState = "visible";
    jest.advanceTimersByTime(60_000);
    await arrived(2);
    expect(checked).toHaveLength(2);
  } finally { Reflect.deleteProperty(globalThis, "document"); }
});

it("keeps draining its queue while the front page shows another screen, as it always did", async () => {
  const { store } = await savedPcs(4);
  const { pending, checked, arrived, probe } = heldProbe();
  let shown = true;
  const sweep = createPcSweep(store, { active: () => shown, redraw() {} }, { probe });
  const swept = sweep.check();
  await arrived(2);
  shown = false;
  pending[0]!.resolve({ kind: "offline", reason: "pc" });
  pending[1]!.resolve({ kind: "offline", reason: "pc" });
  await arrived(4);
  pending[2]!.resolve({ kind: "offline", reason: "pc" });
  pending[3]!.resolve({ kind: "offline", reason: "pc" });
  await swept;
  expect(new Set(checked).size).toBe(4);
});

it("starts no new check while a pausing view is out of sight, and its next check goes on with what waited", async () => {
  const { store } = await savedPcs(4);
  const { pending, checked, arrived, probe } = heldProbe();
  let shown = true;
  const sweep = createPcSweep(store, { active: () => shown, redraw() {} }, { probe, pauseOutOfSight: true });
  const swept = sweep.check();
  await arrived(2);
  shown = false;
  pending[0]!.resolve({ kind: "offline", reason: "pc" });
  pending[1]!.resolve({ kind: "offline", reason: "pc" });
  for (let turn = 0; turn < 50; turn++) await Promise.resolve();
  expect(checked).toHaveLength(2);
  // the drawer opens again: the view asks for a check, as ShellPcs does, and the paused sweep goes on
  shown = true;
  void sweep.check();
  await arrived(4);
  pending[2]!.resolve({ kind: "offline", reason: "pc" });
  pending[3]!.resolve({ kind: "offline", reason: "pc" });
  await swept;
  expect(new Set(checked).size).toBe(4);
  expect([...sweep.status.values()].every((status) => status.kind === "offline")).toBe(true);
});

it("is over once stopped: a list still being read, a later check and a later checkOne start and keep nothing", async () => {
  jest.useFakeTimers();
  const { devices, store } = await savedPcs(4);
  const listed = Promise.withResolvers<RelayDevice[]>();
  const slow: RelayDeviceStore = { ...store, list: () => listed.promise };
  const { checked, probe } = heldProbe();
  const sweep = createPcSweep(slow, { active: () => true, redraw() {} }, { probe });
  const swept = sweep.check();
  sweep.stop();
  listed.resolve(devices);
  await swept;
  await sweep.check();
  await sweep.checkOne(devices[0]!.server_id);
  expect(checked).toEqual([]);
  expect(sweep.status.size).toBe(0);
  expect(jest.getTimerCount()).toBe(0);
  expect(localStorage.getItem("ovis-pc-check-cursor")).toBeNull();
});

it("lets the answers it was keeping go when stopped, with no timer left", async () => {
  jest.useFakeTimers();
  const { store } = await savedPcs(2);
  const { pending, arrived, probe } = heldProbe();
  const sweep = createPcSweep(store, { active: () => true, redraw() {} }, { probe });
  const swept = sweep.check();
  await arrived(2);
  for (const held of pending) held.resolve({ kind: "answered", route: "relay", rttMs: 10 });
  await swept;
  sweep.stop();
  expect(jest.getTimerCount()).toBe(0);
});

it("lets a check asked for while that PC's check is under way settle with that one's answer", async () => {
  const { devices, store } = await savedPcs(1);
  const id = devices[0]?.server_id ?? "";
  const { pending, checked, arrived, probe } = heldProbe();
  const sweep = createPcSweep(store, { active: () => true, redraw() {} }, { probe });
  const first = sweep.checkOne(id);
  await arrived(1);
  let settled = false;
  const again = sweep.checkOne(id).then(() => { settled = true; });
  await Promise.resolve();
  expect(settled).toBe(false);
  pending[0]?.resolve({ kind: "answered", route: "relay", rttMs: 20 });
  await Promise.all([first, again]);
  expect([checked.length, sweep.status.get(id)?.kind]).toEqual([1, "answered"]);
  sweep.stop();
});
