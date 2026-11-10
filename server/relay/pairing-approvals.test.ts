import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RelayPairingRequest } from "../../shared/machines.ts";
import { privateStateFs } from "../private-state.ts";
import { PAIRING_WINDOW_MS, RelayPairingApprovals, pairingWindowFs } from "./pairing-approvals.ts";

const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });

/** A window file in a directory of its own, and a clock the test moves. */
function fixture() {
  const stateDir = mkdtempSync(join(tmpdir(), "ovis-pairing-window-"));
  cleanup.push(() => rmSync(stateDir, { recursive: true, force: true }));
  const path = join(stateDir, "relay", "pairing-window.json");
  const clock = { at: 1_700_000_000_000 };
  return {
    path, clock,
    /** what a server started now would read */
    open: () => new RelayPairingApprovals({ path, now: () => clock.at }),
    write(value: unknown) {
      mkdirSync(join(stateDir, "relay"), { recursive: true });
      writeFileSync(path, typeof value === "string" ? value : JSON.stringify(value));
    },
    saved: () => JSON.parse(readFileSync(path, "utf8")) as unknown,
  };
}

describe("the pairing window across a restart", () => {
  it("is still open, and still local-only, for a server started on the same state", () => {
    const f = fixture();
    f.open().openWindow(f.clock.at, { localOnly: true });
    // both deadlines are in the one document
    expect(f.saved()).toEqual({ v: 1, window_until: f.clock.at + PAIRING_WINDOW_MS, local_only_until: f.clock.at + PAIRING_WINDOW_MS });
    f.clock.at += 60_000;
    const restarted = f.open();
    expect(restarted.windowOpen()).toBe(true);
    expect(restarted.localOnlyOpen()).toBe(true);
  });

  it("ends at the deadline it was opened with, not ten minutes after the restart", () => {
    const f = fixture();
    f.open().openWindow(f.clock.at, { localOnly: true });
    f.clock.at += PAIRING_WINDOW_MS - 1;
    const restarted = f.open();
    expect(restarted.windowOpen()).toBe(true);
    expect(restarted.localOnlyOpen()).toBe(true);
    f.clock.at += 1;
    expect(restarted.windowOpen()).toBe(false);
    expect(restarted.localOnlyOpen()).toBe(false);
    // and a server started after it reads it closed
    const later = f.open();
    expect(later.windowOpen()).toBe(false);
    expect(later.localOnlyOpen()).toBe(false);
  });

  it("reads a deadline further ahead than a window opened now as closed, and writes it back closed", () => {
    for (const saved of [
      { v: 1, window_until: 1_700_000_000_000 + 365 * 86_400_000, local_only_until: Number.MAX_SAFE_INTEGER },
      { v: 1, window_until: 1_700_000_000_000 + PAIRING_WINDOW_MS + 1, local_only_until: 0 },
      { v: 1, window_until: 1_700_000_000_000 + 60_000, local_only_until: 1_700_000_000_000 + PAIRING_WINDOW_MS + 1 },
    ]) {
      const f = fixture();
      f.write(saved);
      const restarted = f.open();
      expect(restarted.windowOpen()).toBe(false);
      expect(restarted.localOnlyOpen()).toBe(false);
      expect(f.saved()).toEqual({ v: 1, window_until: 0, local_only_until: 0 });
      // so no later start gets a window from it either, as a clamp to "now" gave at every restart
      f.clock.at += 365 * 86_400_000 - 60_000;
      expect(f.open().windowOpen()).toBe(false);
    }
  });

  it("does not reopen a window when the clock went back: before it was opened, or after it ran out", () => {
    const f = fixture();
    f.open().openWindow(f.clock.at, { localOnly: true });
    const opened = f.clock.at;
    // a start with a clock earlier than the open sees a deadline more than one window ahead
    f.clock.at = opened - 60_000;
    expect(f.open().windowOpen()).toBe(false);
    f.clock.at = opened + 1;
    expect(f.open().windowOpen()).toBe(false);

    const g = fixture();
    g.open().openWindow(g.clock.at, { localOnly: true });
    g.clock.at += PAIRING_WINDOW_MS;
    expect(g.open().windowOpen()).toBe(false);
    expect(g.saved()).toEqual({ v: 1, window_until: 0, local_only_until: 0 });
    g.clock.at -= 60_000;
    expect(g.open().windowOpen()).toBe(false);
  });

  it("a close ends the comparisons this PC was shown, and leaves a members-only join", async () => {
    const f = fixture();
    const approvals = f.open();
    approvals.openWindow(f.clock.at, { localOnly: true });
    const shown = approvals.ask("Phone", "123456", f.clock.at + 90_000, { intent: "pc", key: "k", deviceId: "d" })!;
    const join = approvals.ask("Tablet", "654321", f.clock.at + 90_000, { intent: "account", key: "k2", deviceId: "d2", membersOnly: true })!;
    const id = approvals.list()[0]!.id;
    approvals.closeWindow();
    expect(await shown.decision).toEqual({ approved: false });
    expect(approvals.decide(id, true)).toBe(false);
    expect(approvals.list()).toEqual([]);
    expect(approvals.remoteList().map((one) => one.label)).toEqual(["Tablet"]);
    join.withdraw();
  });

  it("stays not local-only when it was opened without it", () => {
    const f = fixture();
    f.open().openWindow(f.clock.at);
    expect(f.saved()).toEqual({ v: 1, window_until: f.clock.at + PAIRING_WINDOW_MS, local_only_until: 0 });
    const restarted = f.open();
    expect(restarted.windowOpen()).toBe(true);
    expect(restarted.localOnlyOpen()).toBe(false);
  });

  it("keeps an earlier local-only deadline when the window is opened again without it", () => {
    const f = fixture();
    const approvals = f.open();
    approvals.openWindow(f.clock.at, { localOnly: true });
    f.clock.at += 60_000;
    approvals.openWindow(f.clock.at);
    expect(f.saved()).toEqual({ v: 1, window_until: f.clock.at + PAIRING_WINDOW_MS, local_only_until: f.clock.at - 60_000 + PAIRING_WINDOW_MS });
  });

  it.each([
    ["no file", undefined],
    ["only the window", { v: 1, window_until: 1_700_000_300_000 }],
    ["only the local-only half", { v: 1, local_only_until: 1_700_000_300_000 }],
    ["a window that is not a number", { v: 1, window_until: "1700000300000", local_only_until: 1_700_000_300_000 }],
    ["a local-only half that is not a number", { v: 1, window_until: 1_700_000_300_000, local_only_until: true }],
    ["a local-only half of null", { v: 1, window_until: 1_700_000_300_000, local_only_until: null }],
    ["another version", { v: 2, window_until: 1_700_000_300_000, local_only_until: 1_700_000_300_000 }],
    ["no version", { window_until: 1_700_000_300_000, local_only_until: 1_700_000_300_000 }],
    ["a list", [1_700_000_300_000, 1_700_000_300_000]],
    ["damaged JSON", '{ "v": 1, "window_until": 1700000300000, "local_only_'],
    // JSON has no Infinity: 1e999 parses to it
    ["a deadline that is not finite", '{ "v": 1, "window_until": 1e999, "local_only_until": 1700000300000 }'],
  ])("reads %s as closed", (_name, content) => {
    const f = fixture();
    if (content !== undefined) f.write(content);
    const restarted = f.open();
    expect(restarted.windowOpen()).toBe(false);
    expect(restarted.localOnlyOpen()).toBe(false);
  });

  it("closes for this server and the next one", () => {
    const f = fixture();
    const approvals = f.open();
    approvals.openWindow(f.clock.at, { localOnly: true });
    approvals.closeWindow();
    expect(approvals.windowOpen()).toBe(false);
    expect(approvals.localOnlyOpen()).toBe(false);
    expect(f.saved()).toEqual({ v: 1, window_until: 0, local_only_until: 0 });
    const restarted = f.open();
    expect(restarted.windowOpen()).toBe(false);
    expect(restarted.localOnlyOpen()).toBe(false);
  });

  it("writes nothing when a window that was never opened is closed", () => {
    const f = fixture();
    f.open().closeWindow();
    expect(existsSync(f.path)).toBe(false);
  });

  it("still opens in memory when the file cannot be written, and says so", () => {
    const f = fixture();
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    const open = spyOn(privateStateFs, "openSync").mockImplementation(() => { throw new Error("disk full"); });
    cleanup.push(() => { warn.mockRestore(); open.mockRestore(); });
    const approvals = f.open();
    approvals.openWindow(f.clock.at, { localOnly: true });
    expect(approvals.windowOpen()).toBe(true);
    expect(approvals.localOnlyOpen()).toBe(true);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(existsSync(f.path)).toBe(false);
  });

  it("removes a file it cannot rewrite on close, so the next server does not reopen the window", () => {
    const f = fixture();
    const approvals = f.open();
    approvals.openWindow(f.clock.at, { localOnly: true });
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    const open = spyOn(privateStateFs, "openSync").mockImplementation(() => { throw new Error("disk full"); });
    cleanup.push(() => { warn.mockRestore(); open.mockRestore(); });
    approvals.closeWindow();
    expect(approvals.windowOpen()).toBe(false);
    expect(existsSync(f.path)).toBe(false);
    expect(f.open().windowOpen()).toBe(false);
  });

  it("removes an older window it cannot replace on open, so it never comes back without its local-only half", () => {
    const f = fixture();
    const approvals = f.open();
    approvals.openWindow(f.clock.at);
    expect(f.open().windowOpen()).toBe(true);
    expect(f.open().localOnlyOpen()).toBe(false);
    f.clock.at += 60_000;
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    const open = spyOn(privateStateFs, "openSync").mockImplementation(() => { throw new Error("disk full"); });
    cleanup.push(() => { warn.mockRestore(); open.mockRestore(); });
    approvals.openWindow(f.clock.at, { localOnly: true });
    open.mockRestore();
    // this process still has the window it opened
    expect(approvals.windowOpen()).toBe(true);
    expect(approvals.localOnlyOpen()).toBe(true);
    expect(existsSync(f.path)).toBe(false);
    const restarted = f.open();
    expect(restarted.windowOpen()).toBe(false);
    expect(restarted.localOnlyOpen()).toBe(false);
  });

  it("keeps nothing on disk without a path", () => {
    const approvals = new RelayPairingApprovals();
    approvals.openWindow();
    expect(approvals.windowOpen()).toBe(true);
    approvals.closeWindow();
    expect(approvals.windowOpen()).toBe(false);
  });

  it("writes the window closed when it runs out while the server runs, so an earlier clock cannot reopen it", () => {
    const f = fixture();
    const timers: { run: () => void; ms: number }[] = [];
    const approvals = new RelayPairingApprovals({ path: f.path, now: () => f.clock.at, setTimer: (run, ms) => { timers.push({ run, ms }); return () => {}; } });
    approvals.openWindow(f.clock.at, { localOnly: true });
    expect(timers.at(-1)!.ms).toBe(PAIRING_WINDOW_MS);
    // fired early (a timer is not a clock): it waits for the rest
    f.clock.at += PAIRING_WINDOW_MS - 1_000;
    timers.at(-1)!.run();
    expect(timers.at(-1)!.ms).toBe(1_000);
    expect(approvals.windowOpen()).toBe(true);
    f.clock.at += 1_000;
    timers.at(-1)!.run();
    expect(f.saved()).toEqual({ v: 1, window_until: 0, local_only_until: 0 });
    f.clock.at -= 5 * 60_000;
    expect(f.open().windowOpen()).toBe(false);
  });

  it("a restarted server also writes the window it read closed when it runs out", () => {
    const f = fixture();
    f.open().openWindow(f.clock.at);
    const timers: { run: () => void; ms: number }[] = [];
    f.clock.at += 60_000;
    new RelayPairingApprovals({ path: f.path, now: () => f.clock.at, setTimer: (run, ms) => { timers.push({ run, ms }); return () => {}; } });
    expect(timers.at(-1)!.ms).toBe(PAIRING_WINDOW_MS - 60_000);
    f.clock.at += PAIRING_WINDOW_MS;
    timers.at(-1)!.run();
    expect(f.saved()).toEqual({ v: 1, window_until: 0, local_only_until: 0 });
  });

  it("a close that can neither rewrite nor remove the file empties it, and reports one it cannot clear at all", () => {
    const f = fixture();
    const approvals = f.open();
    approvals.openWindow(f.clock.at, { localOnly: true });
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    const open = spyOn(privateStateFs, "openSync").mockImplementation(() => { throw new Error("disk full"); });
    const rm = spyOn(pairingWindowFs, "rmSync").mockImplementation(() => { throw new Error("busy"); });
    cleanup.push(() => { warn.mockRestore(); open.mockRestore(); rm.mockRestore(); });
    expect(approvals.closeWindow()).toBe(true);
    expect(readFileSync(f.path, "utf8")).toBe("");
    expect(f.open().windowOpen()).toBe(false);

    const g = fixture();
    const other = g.open();
    other.openWindow(g.clock.at);
    const truncate = spyOn(pairingWindowFs, "truncateSync").mockImplementation(() => { throw new Error("read-only"); });
    cleanup.push(() => truncate.mockRestore());
    expect(other.closeWindow()).toBe(false);
    expect(other.windowOpen()).toBe(false);
  });

  it("counts each close, for a comparison taken before it", () => {
    const approvals = fixture().open();
    expect(approvals.closes).toBe(0);
    approvals.closeWindow();
    approvals.openWindow();
    approvals.closeWindow();
    expect(approvals.closes).toBe(2);
  });

  it("caps the expiry timer at one window when the clock was set far back", () => {
    const f = fixture();
    const timers: number[] = [];
    const approvals = new RelayPairingApprovals({ path: f.path, now: () => f.clock.at, setTimer: (_run, ms) => { timers.push(ms); return () => {}; } });
    approvals.openWindow(f.clock.at + 40 * 86_400_000);
    expect(timers.at(-1)).toBe(PAIRING_WINDOW_MS);
  });

  it("the expiry write does not bring back a state directory that was removed", () => {
    const f = fixture();
    let fire = () => {};
    const approvals = new RelayPairingApprovals({ path: f.path, now: () => f.clock.at, setTimer: (run) => { fire = run; return () => {}; } });
    approvals.openWindow(f.clock.at);
    rmSync(join(f.path, ".."), { recursive: true, force: true });
    f.clock.at += PAIRING_WINDOW_MS;
    fire();
    expect(existsSync(f.path)).toBe(false);
    expect(approvals.windowOpen()).toBe(false);
  });

  it("a close with nothing open answers closed on a disk that cannot be written, when the file already reads closed", () => {
    const files = [{ v: 1, window_until: 0, local_only_until: 0 }, "", "{"].map((saved) => { const f = fixture(); f.write(saved); return f; });
    const g = fixture();
    g.write({ v: 1, window_until: g.clock.at + PAIRING_WINDOW_MS + 5, local_only_until: 0 });
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    const open = spyOn(privateStateFs, "openSync").mockImplementation(() => { throw new Error("read-only"); });
    const rm = spyOn(pairingWindowFs, "rmSync").mockImplementation(() => { throw new Error("read-only"); });
    const truncate = spyOn(pairingWindowFs, "truncateSync").mockImplementation(() => { throw new Error("read-only"); });
    cleanup.push(() => { warn.mockRestore(); open.mockRestore(); rm.mockRestore(); truncate.mockRestore(); });
    for (const f of files) expect(f.open().closeWindow()).toBe(true);
    // one that a start could not clear either is still reported
    expect(g.open().closeWindow()).toBe(false);
  });
});

// the PC's own prompt words the request by this (src/components/RelayPairingPrompt.tsx): typed on the
// other device while this PC waits to be added, compared on both screens otherwise
describe("what the PC's own windows are told of a waiting request", () => {
  const device = { intent: "account" as const, key: "k", deviceId: "d" };

  it("marks a request asked while the local-only window is open", () => {
    const f = fixture();
    const approvals = f.open();
    approvals.openWindow(f.clock.at, { localOnly: true });
    approvals.ask("phone", "123456", f.clock.at + 90_000, device);
    // as session.ts passes it, fixed when the phone asked
    approvals.ask("tablet", "654321", f.clock.at + 90_000, { ...device, localOnly: true });
    expect(approvals.list().map(({ label, local_only }) => [label, local_only])).toEqual([["phone", true], ["tablet", true]]);
    // account members are not shown it at all
    expect(approvals.remoteList()).toEqual([]);
  });

  it("leaves the mark out of a request asked outside it", () => {
    const f = fixture();
    const approvals = f.open();
    approvals.openWindow(f.clock.at);
    approvals.ask("phone", "123456", f.clock.at + 90_000, device);
    approvals.ask("tablet", "654321", f.clock.at + 90_000, { ...device, localOnly: false });
    const listed = approvals.list();
    expect(listed).toHaveLength(2);
    for (const request of listed) expect("local_only" in request).toBe(false);
    // and once the local-only half has run out, whatever the rest of the window does
    const later = f.open();
    later.openWindow(f.clock.at, { localOnly: true });
    f.clock.at += PAIRING_WINDOW_MS;
    later.ask("laptop", "111222", f.clock.at + 90_000, device);
    expect("local_only" in later.list()[0]!).toBe(false);
  });

  it("leaves it out of a members-only request, which this PC's windows never see", () => {
    const f = fixture();
    const approvals = f.open();
    approvals.openWindow(f.clock.at, { localOnly: true });
    const seen: unknown[] = [];
    approvals.subscribe((pairings) => seen.push(pairings));
    approvals.ask("phone", "123456", f.clock.at + 90_000, { ...device, membersOnly: true, localOnly: true });
    expect(approvals.list()).toEqual([]);
    expect(seen.at(-1)).toEqual([]);
    // what members are told carries no such field either
    expect(approvals.remoteList()).toHaveLength(1);
    expect("local_only" in approvals.remoteList()[0]!).toBe(false);
  });

  // nothing here tells which device shows digits and which takes them typed: the mark is the PC's
  // window, and a plain link asked meanwhile must not hand what the add-me screen waits for to members
  it("keeps the mark, and the request off members' screens, when an ordinary link is asked for meanwhile", () => {
    const f = fixture();
    const approvals = f.open();
    approvals.openWindow(f.clock.at, { localOnly: true });
    f.clock.at += 60_000;
    approvals.openWindow(f.clock.at);
    expect(approvals.localOnlyOpen()).toBe(true);
    approvals.ask("phone", "123456", f.clock.at + 90_000, device);
    expect(approvals.list()[0]!.local_only).toBe(true);
    expect(approvals.remoteList()).toEqual([]);
  });

  it("says how long each request still waits by this PC's clock, never below 0", () => {
    const f = fixture();
    const approvals = f.open();
    approvals.openWindow(f.clock.at);
    approvals.ask("phone", "123456", f.clock.at + 90_000, device);
    expect(approvals.list()[0]!.left_ms).toBe(90_000);
    f.clock.at += 30_500;
    // counted again at each telling: a window that subscribes late hears what is left now
    const seen: RelayPairingRequest[][] = [];
    approvals.subscribe((pairings) => seen.push(pairings));
    expect(seen[0]![0]!.left_ms).toBe(59_500);
    expect(seen[0]![0]!.expires_at).toBe(new Date(f.clock.at + 59_500).toISOString());
    f.clock.at += 120_000;
    expect(approvals.list()[0]!.left_ms).toBe(0);
  });
});
