import { describe, expect, it } from "bun:test";
import { advanceStateStamps, loadStateStamps, parseStateStamps, saveStateStamps, stampState, stateSince, type LastLook, type PcLook, type StampState, type StateStamps } from "./agentStateSince.ts";

const MIN = 60_000;
const DAY = 86_400_000;
const T = 1_800_000_000_000;

type Row = [state: StampState, seq?: number, finish?: number, more?: { done?: boolean; wait?: boolean; own?: boolean; terminal?: string }];
const look = (rows: Record<string, Row> | null, lifetime = "herdr-1", id = "pc", epoch: string | null = "server-1"): PcLook =>
  ({ id, lifetime, epoch, rows: rows === null ? null : Object.entries(rows).map(([pane, [state, seq, finish = 0, more]]) => ({ pane, terminal: more?.terminal ?? `term-${pane}`, state, seq, finish, done: more?.done ?? false, wait: more?.wait ?? false, own: more?.own ?? false })) });
const DONE = { done: true };
const WAITING = { done: true, wait: true };
const OWN = { own: true };

function device(kept: { stamps: StateStamps } = { stamps: {} }) {
  let last: LastLook = new Map();
  return {
    see(now: number, ...looks: PcLook[]): StateStamps {
      ({ stamps: kept.stamps, last } = advanceStateStamps({ stamps: kept.stamps, last }, looks, now));
      return kept.stamps;
    },
    seeUndated(now: number, ...looks: PcLook[]): StateStamps {
      ({ stamps: kept.stamps, last } = advanceStateStamps({ stamps: kept.stamps, last }, looks, now, false));
      return kept.stamps;
    },
    reload(): void { last = new Map(); },
    since: (pane: string, state: StampState, terminal = `term-${pane}`): number | null => stateSince(kept.stamps, "pc", pane, terminal, state),
  };
}

describe("state stamps: when this device saw a state begin", () => {
  it("gives a row first seen no time, and stamps it when its state changes in sight", () => {
    const page = device();
    page.see(T, look({ a: ["working", 1] }));
    expect(page.since("a", "working")).toBeNull();

    page.see(T + 5 * MIN, look({ a: ["idle", 2] }));
    expect(page.since("a", "idle")).toBe(T + 5 * MIN);
    expect(page.since("a", "working")).toBeNull();
  });

  it("stamps a pane that appears in a roster the page has been looking at for longer than it bridges", () => {
    const page = device();
    page.see(T, look({ a: ["idle", 1] }));
    page.see(T + 2 * MIN, look({ a: ["idle", 1], b: ["working", 2] }));
    expect(page.since("b", "working")).toBe(T + 2 * MIN);
    expect(page.since("a", "idle")).toBeNull();
  });

  it("says no time for a pane that appears soon after the page's first look: the roster may not have listed its agent yet", () => {
    const page = device();
    page.see(T, look({ a: ["idle", 1] }));
    page.see(T + 1000, look({ a: ["idle", 1], b: ["working", 2] }));
    expect(page.since("b", "working")).toBeNull();
    page.see(T + MIN, look({ a: ["idle", 1], b: ["blocked", 3] }));
    expect(page.since("b", "blocked")).toBe(T + MIN);

    page.see(T + 10 * MIN, look({ a: ["idle", 1], b: ["blocked", 3] }));
    page.reload();
    page.see(T + 11 * MIN, look({ a: ["idle", 1], b: ["blocked", 3] }));
    page.see(T + 11 * MIN + 5000, look({ a: ["idle", 1], b: ["blocked", 3], c: ["working", 4] }));
    expect(page.since("c", "working")).toBeNull();

    // nor do its looks at the herdr another one replaced: that one finds its agents again over its first moments
    const replaced = device();
    replaced.see(T, look({ a: ["idle", 1] }));
    replaced.see(T + 10 * MIN, look({ a: ["idle", 1] }, "herdr-2"));
    replaced.see(T + 10 * MIN + 5000, look({ a: ["idle", 1], b: ["working", 2] }, "herdr-2"));
    expect(replaced.since("b", "working")).toBeNull();
  });

  it("keeps a stamp across a reload while herdr's counter says nothing changed", () => {
    const page = device();
    page.see(T, look({ a: ["working", 1] }));
    page.see(T + MIN, look({ a: ["blocked", 2] }));
    page.reload();
    page.see(T + 9 * MIN, look({ a: ["blocked", 2] }));
    expect(page.since("a", "blocked")).toBe(T + MIN);
  });

  it("drops a stamp on a reload when the state went away and came back out of sight", () => {
    const page = device();
    page.see(T, look({ a: ["working", 1] }));
    page.see(T + MIN, look({ a: ["blocked", 2] }));
    page.reload();
    page.see(T + 9 * MIN, look({ a: ["blocked", 4] }));
    expect(page.since("a", "blocked")).toBeNull();
  });

  it("drops a stamp on a reload when herdr gives no counter: nothing proves the state did not go and come back", () => {
    const page = device();
    page.see(T, look({ a: ["working"] }));
    page.see(T + MIN, look({ a: ["blocked"] }));
    page.see(T + 2 * MIN, look({ a: ["blocked"] }));
    expect(page.since("a", "blocked")).toBe(T + MIN);

    page.reload();
    page.see(T + 9 * MIN, look({ a: ["blocked"] }));
    expect(page.since("a", "blocked")).toBeNull();

    page.see(T + 10 * MIN, look({ a: ["working"] }));
    expect(page.since("a", "working")).toBe(T + 10 * MIN);
  });

  it("drops a stamp on a reload when only the stamp, or only the row, carries herdr's counter", () => {
    const counted = device();
    counted.see(T, look({ a: ["working", 1] }));
    counted.see(T + MIN, look({ a: ["blocked", 2] }));
    counted.reload();
    counted.see(T + 5 * MIN, look({ a: ["blocked"] }));
    expect(counted.since("a", "blocked")).toBeNull();

    const uncounted = device();
    uncounted.see(T, look({ a: ["working"] }));
    uncounted.see(T + MIN, look({ a: ["blocked"] }));
    uncounted.reload();
    uncounted.see(T + 5 * MIN, look({ a: ["blocked", 2] }));
    expect(uncounted.since("a", "blocked")).toBeNull();
  });

  it("counts done and idle as one state: a finish that is read keeps its time, in sight and across a reload", () => {
    expect(stampState("done")).toBe("idle");
    expect(stampState("blocked")).toBe("blocked");
    const page = device();
    page.see(T, look({ a: ["working", 1] }));
    page.see(T + MIN, look({ a: [stampState("done"), 2, 1, DONE] }));
    page.see(T + 3 * MIN, look({ a: [stampState("idle"), 2, 1] }));
    page.see(T + 3 * MIN + 1000, look({ a: ["idle", 3, 1] }));
    expect(page.since("a", "idle")).toBe(T + MIN);

    page.reload();
    page.see(T + 4 * MIN, look({ a: ["idle", 3, 1] }));
    expect(page.since("a", "idle")).toBe(T + MIN);
  });

  it("drops a stamp on a reload when a turn ended meanwhile, though herdr's counter stands: the state Ovis shows is not always herdr's", () => {
    const page = device();
    page.see(T, look({ a: ["idle", 1] }));
    page.see(T + MIN, look({ a: ["working", 2] }));
    page.reload();
    // a Claude whose turn ended while a subagent kept herdr at working, and that works again: one finish counted, herdr's counter where it was
    page.see(T + 600 * MIN, look({ a: ["working", 2, 1] }));
    expect(page.since("a", "working")).toBeNull();
  });

  it("trusts no kept stamp of an agent whose state Ovis reads itself: herdr's counter stands whatever it does", () => {
    const page = device();
    // here herdr's counter even moved with the change, as it may for what herdr takes the pane for
    page.see(T, look({ a: ["idle", 5, 0, OWN] }));
    page.see(T + MIN, look({ a: ["working", 6, 0, OWN] }));
    expect(page.since("a", "working")).toBe(T + MIN);

    page.reload();
    page.see(T + 600 * MIN, look({ a: ["working", 6, 0, OWN] }));
    expect(page.since("a", "working")).toBeNull();
  });

  it("drops a PC's kept stamps on a reload after its server started anew, and keeps them in a page that watched through it", () => {
    const reloaded = device();
    reloaded.see(T, look({ a: ["idle", 1] }));
    reloaded.see(T + MIN, look({ a: ["working", 2, 4] }));
    reloaded.reload();
    reloaded.see(T + 2 * MIN, look({ a: ["working", 2, 4] }, "herdr-1", "pc", "server-2"));
    expect(reloaded.since("a", "working")).toBeNull();

    const watching = device();
    watching.see(T, look({ a: ["idle", 1] }));
    watching.see(T + MIN, look({ a: ["working", 2, 4] }));
    watching.see(T + 2 * MIN, look({ a: ["working", 2, 0] }, "herdr-1", "pc", "server-2"));
    expect(watching.since("a", "working")).toBe(T + MIN);
    watching.reload();
    watching.see(T + 3 * MIN, look({ a: ["working", 2, 0] }, "herdr-1", "pc", "server-2"));
    expect(watching.since("a", "working")).toBe(T + MIN);
  });

  it("drops the time of a state that was left and come back to between two looks", () => {
    const waited = device();
    waited.see(T, look({ a: ["working", 1] }));
    waited.see(T + MIN, look({ a: ["blocked", 2] }));
    waited.see(T + 5 * MIN, look({ a: ["blocked", 4] }));
    expect(waited.since("a", "blocked")).toBeNull();

    const rested = device();
    rested.see(T, look({ a: ["working", 1] }));
    rested.see(T + MIN, look({ a: ["idle", 2, 1] }));
    rested.see(T + 5 * MIN, look({ a: ["idle", 2, 2] }));
    expect(rested.since("a", "idle")).toBeNull();
  });

  it("drops no time for a roster that names no counter for a moment: only two numbers that differ are a move", () => {
    const page = device();
    page.see(T, look({ a: ["working", 1] }));
    page.see(T + MIN, look({ a: ["blocked", 2] }));
    page.see(T + 2 * MIN, { ...look({ a: ["blocked"] }), rows: [{ pane: "a", terminal: "term-a", state: "blocked", seq: undefined, finish: undefined, done: false, wait: false, own: false }] });
    page.see(T + 3 * MIN, look({ a: ["blocked", 2] }));
    expect(page.since("a", "blocked")).toBe(T + MIN);
  });

  it("keeps a time through the roster that brings the counter of a change a pushed status told of first", () => {
    const page = device();
    page.see(T, look({ a: ["working", 1] }));
    page.see(T + MIN, look({ a: ["blocked", 1] }));
    page.see(T + MIN + 1000, look({ a: ["blocked", 2] }));
    expect(page.since("a", "blocked")).toBe(T + MIN);

    page.reload();
    page.see(T + 9 * MIN, look({ a: ["blocked", 2] }));
    expect(page.since("a", "blocked")).toBe(T + MIN);
  });

  it("keeps a time through a move of herdr's counter it can account for: one a pushed status told of, or a move by exactly one", () => {
    const page = device();
    page.see(T, look({ a: ["working", 1] }));
    page.see(T + MIN, look({ a: ["idle", 2, 1, DONE] }));
    page.see(T + 2 * MIN, look({ a: ["idle", 2, 1] }));
    page.see(T + 2 * MIN + 1000, look({ a: ["idle", 7, 1] }));
    expect(page.since("a", "idle")).toBe(T + MIN);
    page.see(T + 5 * MIN, look({ a: ["idle", 9, 1] }));
    expect(page.since("a", "idle")).toBeNull();

    const single = device();
    single.see(T, look({ a: ["working", 1] }));
    single.see(T + MIN, look({ a: ["idle", 2, 1, DONE] }));
    single.see(T + 3 * MIN, look({ a: ["idle", 3, 1] }));
    expect(single.since("a", "idle")).toBe(T + MIN);

    const untold = device();
    untold.see(T, look({ a: ["working", 1] }));
    untold.see(T + MIN, look({ a: ["idle", 2, 1, DONE] }));
    untold.see(T + 3 * MIN, look({ a: ["idle", 4, 1] }));
    expect(untold.since("a", "idle")).toBeNull();
  });

  it("keeps a working time through the end of a turn whose background work holds the row at working", () => {
    for (const pushed of [true, false]) {
      const page = device();
      page.see(T, look({ a: ["idle", 1] }));
      page.see(T + MIN, look({ a: ["working", 2] }));
      if (pushed) page.see(T + 10 * MIN, look({ a: ["working", 2, 1, WAITING] }));
      page.see(T + 10 * MIN + 1000, look({ a: ["working", 3, 1, WAITING] }));
      expect(page.since("a", "working")).toBe(T + MIN);
      // the subagent's notice starts the next turn: herdr turns from done to working, told by a pushed status first
      page.see(T + 12 * MIN, look({ a: ["working", 3, 1] }));
      page.see(T + 12 * MIN + 1000, look({ a: ["working", 4, 1] }));
      expect(page.since("a", "working")).toBe(T + MIN);
    }

    const rested = device();
    rested.see(T, look({ a: ["idle", 1] }));
    rested.see(T + MIN, look({ a: ["working", 2] }));
    rested.see(T + 10 * MIN, look({ a: ["working", 3, 1, WAITING] }));
    rested.see(T + 12 * MIN, look({ a: ["working", 4, 1] }));
    expect(rested.since("a", "working")).toBeNull();

    const missed = device();
    missed.see(T, look({ a: ["idle", 1] }));
    missed.see(T + MIN, look({ a: ["working", 2] }));
    missed.see(T + 10 * MIN, look({ a: ["working", 4, 1] }));
    expect(missed.since("a", "working")).toBeNull();

    const later = device();
    later.see(T, look({ a: ["idle", 1] }));
    later.see(T + MIN, look({ a: ["working", 2] }));
    later.see(T + 10 * MIN, look({ a: ["working", 5, 2, WAITING] }));
    expect(later.since("a", "working")).toBeNull();

    const more = device();
    more.see(T, look({ a: ["idle", 1] }));
    more.see(T + MIN, look({ a: ["working", 2] }));
    more.see(T + 10 * MIN, look({ a: ["working", 5, 1, WAITING] }));
    expect(more.since("a", "working")).toBeNull();
  });

  it("drops a stamp on a reload that only a pushed status told of: its change's counter never came", () => {
    const page = device();
    page.see(T, look({ a: ["working", 1] }));
    page.see(T + MIN, look({ a: ["blocked", 1] }));
    page.reload();
    page.see(T + 9 * MIN, look({ a: ["blocked", 2] }));
    expect(page.since("a", "blocked")).toBeNull();
  });

  it("keeps the time of a pane that leaves the roster for a look and returns unchanged", () => {
    const page = device();
    page.see(T, look({ a: ["idle", 1], b: ["idle", 2] }));
    page.see(T + MIN, look({ a: ["working", 3], b: ["idle", 2] }));
    page.see(T + 2 * MIN, look({ b: ["idle", 2] }));
    page.see(T + 3 * MIN, look({ a: ["working", 3], b: ["idle", 2] }));
    expect(page.since("a", "working")).toBe(T + MIN);
  });

  it("says no time for a pane back under another counter than it left with: what it shows began out of sight", () => {
    const page = device();
    page.see(T, look({ a: ["idle", 1] }));
    page.see(T + MIN, look({ a: ["working", 2] }));
    page.see(T + 2 * MIN, look({}));
    page.see(T + 3 * MIN, look({ a: ["working", 7] }));
    expect(page.since("a", "working")).toBeNull();
    page.see(T + 4 * MIN, look({}));
    page.see(T + 5 * MIN, look({ a: ["blocked", 9] }));
    expect(page.since("a", "blocked")).toBe(T + 5 * MIN);
  });

  it("takes a pane back from a look that missed it for the row it was seeing: a kept time stands, and coming back is no beginning", () => {
    const page = device();
    page.see(T, look({ a: ["idle", 5], b: ["working", 6] }));
    page.see(T + MIN, look({ a: ["working", 7], b: ["working", 6] }));
    page.see(T + 20 * MIN, look({}));
    page.see(T + 21 * MIN, look({ a: ["working", 7], b: ["working", 6] }));
    expect(page.since("a", "working")).toBe(T + MIN);
    expect(page.since("b", "working")).toBeNull();
  });

  it("says no time for a pane back from a missed look in the state it left in where herdr's counter does not stand: another agent may have been started there", () => {
    // herdr-core names no counter: an agent that rested, and one started in its pane a moment later, read the same
    const uncounted = device();
    uncounted.see(T, look({ a: ["working"] }));
    uncounted.see(T + MIN, look({ a: ["idle"] }));
    uncounted.see(T + 10 * MIN, look({}));
    uncounted.see(T + 10 * MIN + 20_000, look({ a: ["idle"] }));
    expect(uncounted.since("a", "idle")).toBeNull();

    const counted = device();
    counted.see(T, look({ a: ["working", 1] }));
    counted.see(T + MIN, look({ a: ["idle", 2] }));
    counted.see(T + 10 * MIN, look({}));
    counted.see(T + 10 * MIN + 20_000, look({ a: ["idle", 3] }));
    expect(counted.since("a", "idle")).toBeNull();
    counted.see(T + 11 * MIN, look({ a: ["working", 4] }));
    expect(counted.since("a", "working")).toBe(T + 11 * MIN);

    // herdr's counter stands for an agent whose state Ovis reads itself whatever it did meanwhile
    const own = device();
    own.see(T, look({ a: ["idle", 5, 0, OWN] }));
    own.see(T + MIN, look({ a: ["working", 5, 0, OWN] }));
    own.see(T + 10 * MIN, look({}));
    own.see(T + 10 * MIN + 20_000, look({ a: ["working", 5, 0, OWN] }));
    expect(own.since("a", "working")).toBeNull();
  });

  it("does not take the stamp of an agent that left for another tab's stamp of the one that comes after it", () => {
    // herdr-core names no counter. An agent rests and leaves in one moment, and nothing else changes until another is started in its pane
    const page = device();
    page.see(T, look({ a: ["working"] }));
    page.see(T + MIN, look({ a: ["idle"] }));
    page.see(T + MIN, look({}));
    page.see(T + 9 * MIN, look({ a: ["idle"] }));
    expect(page.since("a", "idle")).toBeNull();
  });

  it("goes by proof alone for a pane back after longer than a page bridges", () => {
    const page = device();
    page.see(T, look({ a: ["idle", 1], b: ["idle", 5, 0, OWN] }));
    page.see(T + MIN, look({ a: ["working", 2], b: ["working", 5, 0, OWN] }));
    page.see(T + 2 * MIN, look({}));
    page.see(T + 10 * MIN, look({ a: ["working", 2], b: ["working", 5, 0, OWN] }));
    expect(page.since("a", "working")).toBe(T + MIN);
    expect(page.since("b", "working")).toBeNull();
  });

  it("knows a pane herdr moved under a new ID by its terminal, and keeps its time there", () => {
    const TERM = { done: true, terminal: "term-1" };
    const page = device();
    page.see(T, look({ "w1:p1": ["working", 4, 0, { terminal: "term-1" }] }));
    page.see(T + MIN, look({ "w1:p1": ["idle", 5, 1, TERM] }));
    page.see(T + 121 * MIN, look({ "w2:p1": ["idle", 5, 1, TERM], "w3:p1": ["working", 8] }));
    expect(page.since("w2:p1", "idle", "term-1")).toBe(T + MIN);
    expect(page.since("w3:p1", "working")).toBe(T + 121 * MIN);
    page.see(T + 122 * MIN, look({ "w2:p1": ["idle", 9, 2, TERM], "w3:p1": ["working", 8] }));
    expect(page.since("w2:p1", "idle", "term-1")).toBeNull();

    const reloaded = device();
    reloaded.see(T, look({ "w1:p1": ["working", 4, 0, { terminal: "term-1" }] }));
    reloaded.see(T + MIN, look({ "w1:p1": ["idle", 5, 1, TERM] }));
    reloaded.see(T + 121 * MIN, look({ "w2:p1": ["idle", 5, 1, TERM] }));
    reloaded.reload();
    reloaded.see(T + 122 * MIN, look({ "w2:p1": ["idle", 5, 1, TERM] }));
    expect(reloaded.since("w2:p1", "idle", "term-1")).toBe(T + MIN);

    const core = device();
    const term = (state: StampState): Row => [state, undefined, 0, { terminal: "term-1" }];
    core.see(T, look({ "w1:p1": term("working"), other: ["idle"] }));
    core.see(T + MIN, look({ "w1:p1": term("blocked"), other: ["idle"] }));
    core.see(T + 2 * MIN, look({ "w1:p1": term("blocked"), other: ["working"] }));
    core.see(T + 30 * MIN, look({ "w2:p1": term("blocked"), other: ["working"] }));
    expect(core.since("w2:p1", "blocked", "term-1")).toBe(T + MIN);
    core.see(T + 40 * MIN, look({ "w3:p1": term("working"), other: ["working"] }));
    expect(core.since("w3:p1", "working", "term-1")).toBe(T + 40 * MIN);
    core.see(T + 41 * MIN, look({ "w3:p1": term("working"), other: ["idle"] }));
    core.see(T + 50 * MIN, look({ "w1:p1": term("working"), other: ["idle"] }));
    expect(core.since("w1:p1", "working", "term-1")).toBe(T + 40 * MIN);
  });

  it("takes a moved pane's own stamp to its new ID, never the one another pane left there", () => {
    const page = device();
    page.see(T, look({ "w2:p1": ["working", 2], "w1:p1": ["idle", 3, 0, { terminal: "term-1" }] }));
    page.see(T + MIN, look({ "w2:p1": ["idle", 4, 1, DONE], "w1:p1": ["idle", 3, 0, { terminal: "term-1" }] }));
    page.see(T + 2 * MIN, look({ "w1:p1": ["idle", 3, 0, { terminal: "term-1" }] }));
    const after = page.see(T + 3 * MIN, look({ "w2:p1": ["idle", 3, 0, { terminal: "term-1" }] }));
    expect(page.since("w2:p1", "idle", "term-1")).toBeNull();
    expect(after["pc"]?.rows["w2:p1"]).toEqual({ state: "idle", at: T + MIN, terminal: "term-w2:p1", seq: 4, finish: 1, gone: T + 2 * MIN });

    const atOnce = device();
    atOnce.see(T, look({ "w2:p1": ["working", 2], "w1:p1": ["idle", 3, 0, { terminal: "term-1" }] }));
    atOnce.see(T + MIN, look({ "w2:p1": ["idle", 4, 1, DONE], "w1:p1": ["idle", 3, 0, { terminal: "term-1" }] }));
    const then = atOnce.see(T + 2 * MIN, look({ "w2:p1": ["idle", 3, 0, { terminal: "term-1" }] }));
    expect(atOnce.since("w2:p1", "idle", "term-1")).toBeNull();
    expect(then["pc"]?.rows["w2:p1"]).toEqual({ state: "idle", at: T + MIN, terminal: "term-w2:p1", seq: 4, finish: 1, gone: T + 2 * MIN });
    atOnce.see(T + 3 * MIN, look({ "w2:p1": ["working", 5, 0, { terminal: "term-1" }] }));
    expect(atOnce.since("w2:p1", "working", "term-1")).toBe(T + 3 * MIN);
  });

  it("takes another pane under an ID it knew for one it has not seen: neither the stamp there nor the page's memory of it is its own", () => {
    const page = device();
    page.see(T, look({ "w1:p1": ["working", 4, 0, { terminal: "term-1" }] }));
    page.see(T + MIN, look({ "w1:p1": ["idle", 5, 0, { terminal: "term-1" }] }));
    page.see(T + 120 * MIN, look({ "w2:p1": ["idle", 5, 0, { terminal: "term-1" }], "w1:p1": ["idle", 6, 0, { terminal: "term-9" }] }));
    expect(page.since("w2:p1", "idle", "term-1")).toBe(T + MIN);
    expect(page.since("w1:p1", "idle", "term-9")).toBe(T + 120 * MIN);

    const ended = device();
    ended.see(T, look({ a: ["working", 4], b: ["idle", 1] }));
    ended.see(T + MIN, look({ a: ["idle", 5], b: ["idle", 1] }));
    ended.see(T + 10 * MIN, look({ a: ["idle", 5, 0, { terminal: "term-9" }], b: ["idle", 1] }));
    expect(ended.since("a", "idle", "term-9")).toBe(T + 10 * MIN);
    expect(ended.since("a", "idle")).toBeNull();

    const closed = device();
    closed.see(T, look({ "w2:p1": ["working", 2] }));
    closed.see(T + MIN, look({ "w2:p1": ["idle", 4, 1, DONE] }));
    closed.reload();
    closed.see(T + 60 * MIN, look({ "w2:p1": ["idle", 3, 2, { done: true, terminal: "term-other" }] }));
    expect(closed.since("w2:p1", "idle", "term-other")).toBeNull();
  });

  it("keeps the stamp of the pane that has an ID now when a tab a roster behind still lists the last pane there", () => {
    const kept = { stamps: {} as StateStamps };
    const ahead = device(kept);
    const behind = device(kept);
    ahead.see(T, look({ a: ["idle", 1], b: ["idle", 2] }));
    behind.see(T, look({ a: ["idle", 1], b: ["idle", 2] }));
    ahead.see(T + 5 * MIN, look({ a: ["idle", 7, 0, { terminal: "term-9" }], b: ["idle", 2] }));
    expect(ahead.since("a", "idle", "term-9")).toBe(T + 5 * MIN);
    behind.see(T + 5 * MIN + 1000, look({ a: ["idle", 1], b: ["working", 8] }));
    expect(behind.since("a", "idle")).toBeNull();
    ahead.see(T + 6 * MIN, look({ a: ["idle", 7, 0, { terminal: "term-9" }], b: ["working", 8] }));
    expect(ahead.since("a", "idle", "term-9")).toBe(T + 5 * MIN);
  });

  it("does not take a pane for a new one because its ID went to another while it was out of sight", () => {
    const rests: Row = ["idle", 5, 1, { done: true, terminal: "term-1" }];
    const other: Row = ["working", 12, 0, { terminal: "term-9" }];
    const page = device();
    page.see(T, look({ x: ["working", 4, 0, { terminal: "term-1" }], still: ["idle", 9] }));
    page.see(T + MIN, look({ x: rests, still: ["idle", 9] }));
    page.see(T + 3 * DAY, look({ still: ["idle", 9] }));
    page.see(T + 3 * DAY + 2000, look({ x: other, still: ["idle", 9] }));
    expect(page.since("x", "working", "term-9")).toBe(T + 3 * DAY + 2000);
    page.see(T + 3 * DAY + 5000, look({ x: other, y: rests, still: ["idle", 9] }));
    expect(page.since("y", "idle", "term-1")).toBeNull();

    const back = device();
    back.see(T, look({ x: ["working", 4, 0, { terminal: "term-1" }], still: ["idle", 9] }));
    back.see(T + MIN, look({ x: rests, still: ["idle", 9] }));
    back.see(T + 10 * MIN, look({ still: ["idle", 9] }));
    back.see(T + 11 * MIN, look({ x: other, still: ["idle", 9] }));
    back.see(T + 12 * MIN, look({ still: ["idle", 9] }));
    back.see(T + 20 * MIN, look({ x: rests, still: ["idle", 9] }));
    expect(back.since("x", "idle", "term-1")).toBeNull();

    const long = device();
    long.see(T, look({ x: rests, still: ["idle", 9] }));
    long.see(T + MIN, look({ still: ["idle", 9] }));
    long.see(T + 2 * MIN, look({ x: other, still: ["idle", 9] }));
    long.see(T + 31 * DAY, look({ x: other, still: ["idle", 9] }));
    long.see(T + 31 * DAY + MIN, look({ x: other, y: rests, still: ["idle", 9] }));
    expect(long.since("y", "idle", "term-1")).toBe(T + 31 * DAY + MIN);
  });

  it("reads no time for a row from a stamp of another pane that had its ID: a roster is drawn before it is looked at", () => {
    const page = device();
    page.see(T, look({ a: ["working", 4] }));
    page.see(T + MIN, look({ a: ["idle", 5] }));
    expect(page.since("a", "idle")).toBe(T + MIN);
    expect(page.since("a", "idle", "term-9")).toBeNull();
  });

  it("does not take for a moved pane the stamp it left when it last had the ID: only the one it had where it came from", () => {
    const term = (state: StampState, seq: number, finish = 0): Row => [state, seq, finish, { terminal: "term-1" }];
    const page = device();
    page.see(T, look({ p1: term("idle", 1), other: ["idle", 9] }));
    page.see(T + MIN, look({ p1: term("working", 2), other: ["idle", 9] }));
    page.see(T + 2 * MIN, look({ p2: term("working", 2), other: ["idle", 9] }));
    expect(page.since("p2", "working", "term-1")).toBe(T + MIN);
    page.reload();
    page.see(T + 30 * MIN, look({ p2: term("working", 6, 1), other: ["idle", 9] }));
    expect(page.since("p2", "working", "term-1")).toBeNull();
    page.see(T + 31 * MIN, look({ p1: term("working", 6, 1), other: ["idle", 9] }));
    expect(page.since("p1", "working", "term-1")).toBeNull();

    const derived = device();
    derived.see(T, look({ p1: term("idle", 1), other: ["idle", 9] }));
    derived.see(T + MIN, look({ p1: term("working", 2), other: ["idle", 9] }));
    derived.see(T + 2 * MIN, look({ p2: term("working", 2), other: ["idle", 9] }));
    derived.see(T + 3 * MIN, look({ p2: term("idle", 2), other: ["idle", 9] }));
    derived.see(T + 4 * MIN, look({ p2: term("working", 2), other: ["idle", 9] }));
    derived.see(T + 5 * MIN, look({ p1: term("working", 2), other: ["idle", 9] }));
    expect(derived.since("p1", "working", "term-1")).toBe(T + 4 * MIN);
  });

  it("takes the stamp another tab carried to the new ID where the counters prove it, when the old ID's is gone", () => {
    const kept = { stamps: {} as StateStamps };
    const first = device(kept);
    const second = device(kept);
    const TERM = { done: true, terminal: "term-1" };
    first.see(T, look({ "w1:p1": ["working", 4, 0, { terminal: "term-1" }] }));
    second.see(T, look({ "w1:p1": ["working", 4, 0, { terminal: "term-1" }] }));
    first.see(T + MIN, look({ "w1:p1": ["idle", 5, 1, TERM] }));
    second.see(T + MIN + 1000, look({ "w1:p1": ["idle", 5, 1, TERM] }));
    const moved = { "w2:p1": ["idle", 5, 1, TERM], "w1:p1": ["working", 8, 0, { terminal: "term-9" }] } satisfies Record<string, Row>;
    first.see(T + 60 * MIN, look(moved));
    second.see(T + 60 * MIN + 1000, look(moved));
    expect(second.since("w2:p1", "idle", "term-1")).toBe(T + MIN);
    expect(second.since("w1:p1", "working", "term-9")).toBe(T + 60 * MIN);

    const store = { stamps: {} as StateStamps };
    const one = device(store);
    const two = device(store);
    const waits = (terminal: string): Row => ["blocked", undefined, 0, { terminal }];
    one.see(T, look({ "w1:p1": ["working", undefined, 0, { terminal: "term-1" }] }));
    two.see(T, look({ "w1:p1": ["working", undefined, 0, { terminal: "term-1" }] }));
    one.see(T + MIN, look({ "w1:p1": waits("term-1") }));
    two.see(T + MIN + 1000, look({ "w1:p1": waits("term-1") }));
    const both = { "w2:p1": waits("term-1"), "w1:p1": waits("term-9") } satisfies Record<string, Row>;
    one.see(T + 60 * MIN, look(both));
    expect(one.since("w2:p1", "blocked", "term-1")).toBe(T + MIN);
    two.see(T + 60 * MIN + 1000, look(both));
    expect(two.since("w2:p1", "blocked", "term-1")).toBeNull();
    expect(two.since("w1:p1", "blocked", "term-9")).toBe(T + 60 * MIN);
  });

  it("asks nothing of a moved pane's count of finishes: the server counts them by pane ID, and under the ID it left it is another count", () => {
    const rests = (pane: string, seq: number, finish: number): Record<string, Row> => ({ [pane]: ["idle", seq, finish, { done: true, terminal: "tx" }] });
    const works = (pane: string, seq: number, finish: number): Record<string, Row> => ({ [pane]: ["working", seq, finish, { terminal: "tx" }] });
    const page = device();
    page.see(T, look(works("a", 9, 2)));
    page.see(T + MIN, look(rests("a", 10, 3)));
    page.see(T + 5 * MIN, look(rests("b", 10, 0)));
    expect(page.since("b", "idle", "tx")).toBe(T + MIN);
    page.see(T + 6 * MIN, look(works("b", 11, 0)));
    expect(page.since("b", "working", "tx")).toBe(T + 6 * MIN);
    page.see(T + 8 * MIN, look(rests("b", 12, 1)));
    expect(page.since("b", "idle", "tx")).toBe(T + 8 * MIN);

    const pushed = device();
    pushed.see(T, look(works("a", 9, 2)));
    pushed.see(T + MIN, look(rests("a", 9, 3)));
    pushed.see(T + 5 * MIN, look(rests("b", 10, 0)));
    expect(pushed.since("b", "idle", "tx")).toBe(T + MIN);
    pushed.see(T + 6 * MIN, look(works("b", 11, 0)));
    expect(pushed.since("b", "working", "tx")).toBe(T + 6 * MIN);

    const above = device();
    above.see(T, look(works("a", 9, 0)));
    above.see(T + MIN, look(rests("a", 10, 1)));
    above.see(T + 5 * MIN, look(rests("b", 10, 7)));
    expect(above.since("b", "idle", "tx")).toBe(T + MIN);
    above.see(T + 6 * MIN, look(rests("b", 10, 8)));
    expect(above.since("b", "idle", "tx")).toBeNull();

    const late = device();
    late.see(T, look({ ...works("a", 9, 0), still: ["idle", 1] }));
    late.see(T + MIN, look({ ...rests("a", 10, 1), still: ["idle", 1] }));
    late.see(T + 2 * MIN, look({ still: ["idle", 1] }));
    late.see(T + 10 * MIN, look({ ...rests("b", 10, 1), still: ["idle", 1] }));
    expect(late.since("b", "idle", "tx")).toBeNull();

    const missed = device();
    missed.see(T, look(works("a", 9, 0)));
    missed.see(T + MIN, look(rests("a", 10, 1)));
    missed.see(T + 5 * MIN, look({}));
    missed.see(T + 5 * MIN + 30_000, look(rests("b", 10, 4)));
    expect(missed.since("b", "idle", "tx")).toBeNull();

    const same = device();
    same.see(T, look({ ...works("a", 9, 0), still: ["idle", 1] }));
    same.see(T + MIN, look({ ...rests("a", 10, 1), still: ["idle", 1] }));
    same.see(T + 2 * MIN, look({ still: ["idle", 1] }));
    same.seeUndated(T + 3 * MIN, look({ a: ["working", 20, 1, { terminal: "other" }], still: ["idle", 1] }));
    same.see(T + 4 * MIN, look({ still: ["idle", 1] }));
    same.see(T + 20 * MIN, look({ ...rests("a", 10, 1), still: ["idle", 1] }));
    expect(same.since("a", "idle", "tx")).toBe(T + MIN);
  });

  it("goes by a pane's ID alone where a terminal is named twice: nothing says which pane is which", () => {
    const SHARED = { done: true, terminal: "shared" };
    const page = device();
    page.see(T, look({ a: ["working", 1, 0, { terminal: "shared" }] }));
    page.see(T + MIN, look({ a: ["idle", 3, 1, SHARED] }));
    page.see(T + 5 * MIN, look({ a: ["idle", 3, 1, SHARED], c: ["idle", 3, 1, SHARED] }));
    expect(page.since("a", "idle", "shared")).toBe(T + MIN);
    expect(page.since("c", "idle", "shared")).toBe(T + 5 * MIN);
    page.see(T + 6 * MIN, look({ d: ["idle", 3, 1, SHARED] }));
    expect(page.since("d", "idle", "shared")).toBe(T + 6 * MIN);
  });

  it("keeps a moved pane's time in a second tab that sees the move later", () => {
    const kept = { stamps: {} as StateStamps };
    const first = device(kept);
    const second = device(kept);
    const TERM = { done: true, terminal: "term-1" };
    first.see(T, look({ "w1:p1": ["working", 4, 0, { terminal: "term-1" }] }));
    second.see(T, look({ "w1:p1": ["working", 4, 0, { terminal: "term-1" }] }));
    first.see(T + MIN, look({ "w1:p1": ["idle", 5, 1, TERM] }));
    second.see(T + MIN + 1000, look({ "w1:p1": ["idle", 5, 1, TERM] }));
    first.see(T + 60 * MIN, look({ "w2:p1": ["idle", 5, 1, TERM] }));
    second.see(T + 60 * MIN + 500, look({ "w1:p1": ["idle", 5, 1, TERM], other: ["working", 9] }));
    expect(second.since("w1:p1", "idle", "term-1")).toBe(T + MIN);
    second.see(T + 60 * MIN + 1000, look({ "w2:p1": ["idle", 5, 1, TERM], other: ["working", 9] }));
    expect(second.since("w2:p1", "idle", "term-1")).toBe(T + MIN);
    first.see(T + 61 * MIN, look({ "w2:p1": ["idle", 5, 1, TERM], other: ["working", 9] }));
    expect(first.since("w2:p1", "idle", "term-1")).toBe(T + MIN);
  });

  it("leaves the newer stamp another tab made under the new ID when this tab sees the move later, with old news", () => {
    const kept = { stamps: {} as StateStamps };
    const first = device(kept);
    const second = device(kept);
    const TERM = { done: true, terminal: "term-1" };
    first.see(T, look({ "w1:p1": ["working", 4, 0, { terminal: "term-1" }] }));
    second.see(T, look({ "w1:p1": ["working", 4, 0, { terminal: "term-1" }] }));
    first.see(T + MIN, look({ "w1:p1": ["idle", 5, 1, TERM] }));
    second.see(T + MIN + 1000, look({ "w1:p1": ["idle", 5, 1, TERM] }));
    first.see(T + 60 * MIN, look({ "w2:p1": ["idle", 5, 1, TERM] }));
    first.see(T + 61 * MIN, look({ "w2:p1": ["working", 6, 1, { terminal: "term-1" }] }));
    second.see(T + 61 * MIN + 1000, look({ "w2:p1": ["idle", 5, 1, TERM] }));
    first.see(T + 62 * MIN, look({ "w2:p1": ["working", 6, 1, { terminal: "term-1" }], other: ["idle", 1] }));
    expect(first.since("w2:p1", "working", "term-1")).toBe(T + 61 * MIN);
  });

  it("forgets a pane it saw thirty days after it left the roster, as the device forgets its stamp", () => {
    const page = device();
    page.see(T, look({ a: ["idle", 1], b: ["idle", 2] }));
    page.see(T + MIN, look({ a: ["idle", 1] }));
    page.see(T + 29 * DAY, look({ a: ["idle", 1], b: ["working", 9] }));
    expect(page.since("b", "working")).toBeNull();

    const long = device();
    long.see(T, look({ a: ["idle", 1], b: ["idle", 2] }));
    long.see(T + MIN, look({ a: ["idle", 1] }));
    long.see(T + 31 * DAY, look({ a: ["idle", 1] }));
    long.see(T + 31 * DAY + MIN, look({ a: ["idle", 1], b: ["working", 9] }));
    expect(long.since("b", "working")).toBe(T + 31 * DAY + MIN);
  });

  it("stamps no change at a look that cannot date it, and keeps the times the page had", () => {
    const page = device();
    page.see(T, look({ a: ["idle", 1], b: ["idle", 2], c: ["idle", 3] }));
    page.see(T + MIN, look({ a: ["working", 4], b: ["working", 5], c: ["idle", 3] }));
    page.seeUndated(T + 60 * MIN, look({ a: ["working", 4], b: ["blocked", 6], c: ["idle", 3], d: ["working", 7] }));
    expect(page.since("a", "working")).toBe(T + MIN);
    expect(page.since("b", "blocked")).toBeNull();
    expect(page.since("d", "working")).toBeNull();

    page.see(T + 61 * MIN, look({ a: ["working", 4], b: ["working", 8], c: ["idle", 3], d: ["working", 7] }));
    expect(page.since("b", "working")).toBe(T + 61 * MIN);
  });

  it("leaves a PC's stamps alone while it is away, and trusts them on its return only where nothing changed", () => {
    const page = device();
    page.see(T, look({ a: ["idle", 1], b: ["idle", 2] }));
    page.see(T + MIN, look({ a: ["working", 3], b: ["blocked", 4] }));
    page.see(T + 2 * MIN, look(null));
    expect(page.since("a", "working")).toBe(T + MIN);

    page.see(T + 30 * MIN, look({ a: ["working", 3], b: ["idle", 5] }));
    expect(page.since("a", "working")).toBe(T + MIN);
    expect(page.since("b", "idle")).toBeNull();
  });

  it("drops a PC's stamps when its herdr is another one: the pane ids start over", () => {
    const page = device();
    page.see(T, look({ a: ["idle", 1] }));
    page.see(T + MIN, look({ a: ["working", 2] }));
    page.reload();
    page.see(T + 2 * MIN, look({ a: ["working", 2] }, "herdr-2"));
    expect(page.since("a", "working")).toBeNull();
  });

  it("gives the panes of another herdr no time when it replaces the one this page was watching", () => {
    const page = device();
    page.see(T, look({ a: ["working", 1], b: ["idle", 2] }));
    page.see(T + MIN, look({ a: ["idle", 1], b: ["idle", 2], c: ["working", 3] }, "herdr-2"));
    expect(page.since("a", "idle")).toBeNull();
    expect(page.since("b", "idle")).toBeNull();
    expect(page.since("c", "working")).toBeNull();

    page.see(T + 2 * MIN, look({ a: ["working", 4], b: ["idle", 2], c: ["working", 3] }, "herdr-2"));
    expect(page.since("a", "working")).toBe(T + 2 * MIN);
  });

  it("keeps the time another tab of this device stamped for a change both see", () => {
    const kept = { stamps: {} };
    const first = device(kept), second = device(kept);
    first.see(T, look({ a: ["idle", 1] }));
    second.see(T, look({ a: ["idle", 1] }));
    first.see(T + MIN, look({ a: ["working", 2] }));
    second.see(T + 20 * MIN, look({ a: ["working", 2] }));
    expect(second.since("a", "working")).toBe(T + MIN);

    second.see(T + 30 * MIN, look({ a: ["idle", 3] }));
    first.see(T + 31 * MIN, look({ a: ["idle", 3] }));
    expect(first.since("a", "idle")).toBe(T + 30 * MIN);
  });

  it("keeps the time another tab stamped for a pane both see appear", () => {
    const kept = { stamps: {} };
    const first = device(kept), second = device(kept);
    first.see(T, look({ a: ["idle"] }));
    second.see(T, look({ a: ["idle"] }));
    first.see(T + 2 * MIN, look({ a: ["idle"], b: ["working"] }));
    second.see(T + 2 * MIN + 2000, look({ a: ["idle"], b: ["working"] }));
    expect(second.since("b", "working")).toBe(T + 2 * MIN);
  });

  it("keeps another tab's time for a change that tab heard of by a pushed status, and takes the counter the roster brings", () => {
    const kept = { stamps: {} };
    const first = device(kept), second = device(kept);
    first.see(T, look({ a: ["working", 1] }));
    second.see(T, look({ a: ["working", 1] }));
    first.see(T + MIN, look({ a: ["blocked", 1] }));
    second.see(T + MIN + 2000, look({ a: ["blocked", 2] }));
    expect(second.since("a", "blocked")).toBe(T + MIN);
    first.see(T + MIN + 3000, look({ a: ["blocked", 2] }));
    expect(first.since("a", "blocked")).toBe(T + MIN);

    first.reload();
    first.see(T + 9 * MIN, look({ a: ["blocked", 2] }));
    expect(first.since("a", "blocked")).toBe(T + MIN);
  });

  it("keeps another tab's time for a change both see where herdr counts nothing: the stamp was made while this tab had the last state", () => {
    const kept = { stamps: {} };
    const first = device(kept), second = device(kept);
    first.see(T, look({ a: ["idle"] }));
    second.see(T, look({ a: ["idle"] }));
    first.see(T + MIN, look({ a: ["working"] }));
    second.see(T + 2 * MIN, look({ a: ["working"] }));
    expect(second.since("a", "working")).toBe(T + MIN);
  });

  it("leaves another tab's stamp of a state this tab has not seen yet, and keeps its time when it sees it", () => {
    for (const counts of [true, false]) {
      const seq = (n: number): number | undefined => counts ? n : undefined;
      const kept = { stamps: {} };
      const ahead = device(kept), behind = device(kept);
      ahead.see(T, look({ a: ["working", seq(1)], b: ["idle", seq(2)] }));
      behind.see(T, look({ a: ["working", seq(1)], b: ["idle", seq(2)] }));
      ahead.see(T + MIN, look({ a: ["blocked", seq(3)], b: ["idle", seq(2)] }));
      behind.see(T + 2 * MIN, look({ a: ["working", seq(1)], b: ["working", seq(4)] }));
      expect(ahead.since("a", "blocked")).toBe(T + MIN);
      behind.see(T + 3 * MIN, look({ a: ["blocked", seq(3)], b: ["working", seq(4)] }));
      expect(behind.since("a", "blocked")).toBe(T + MIN);
      expect(behind.since("b", "working")).toBe(T + 2 * MIN);
    }
  });

  it("leaves another tab's stamp alone when this tab's own counters move under a state it has been seeing", () => {
    const kept = { stamps: {} };
    const ahead = device(kept), behind = device(kept);
    ahead.see(T, look({ a: ["working", 5, 0, OWN] }));
    behind.see(T, look({ a: ["working", 5, 0, OWN] }));
    ahead.see(T + MIN, look({ a: ["blocked", 5, 1, OWN] }));
    behind.see(T + 2 * MIN, look({ a: ["working", 5, 1, OWN] }));
    expect(ahead.since("a", "blocked")).toBe(T + MIN);
  });

  it("goes by what this tab saw: a stamp from before it saw the pane's last state is not the time of a change it is then told of", () => {
    const kept = { stamps: {} };
    const ahead = device(kept), late = device(kept);
    ahead.see(T, look({ a: ["working", 5] }));
    ahead.see(T + MIN, look({ a: ["blocked", 7] }));
    late.see(T + 2 * MIN, look({ a: ["working", 5] }));
    expect(ahead.since("a", "blocked")).toBe(T + MIN);
    late.see(T + 3 * MIN, look({ a: ["blocked", 5] }));
    expect(late.since("a", "blocked")).toBe(T + 3 * MIN);
  });

  it("leaves another tab's newer stamp alone when that tab's look missed the pane: the time is there when it is back", () => {
    const kept = { stamps: {} as StateStamps };
    const ahead = device(kept);
    const behind = device(kept);
    ahead.see(T, look({ a: ["working", 3, 1, WAITING] }));
    behind.see(T, look({ a: ["working", 3, 1, WAITING] }));
    ahead.see(T + MIN, look({ a: ["idle", 3, 1, DONE] }));
    ahead.see(T + MIN + 1000, look({}));
    behind.see(T + MIN + 2000, look({ a: ["working", 3, 1, WAITING] }));
    ahead.see(T + MIN + 3000, look({ a: ["idle", 3, 1, DONE] }));
    expect(ahead.since("a", "idle")).toBe(T + MIN);
  });

  it("leaves the mark on a stamp ahead of its roster too: the agent that comes after is not taken for the one that left", () => {
    const kept = { stamps: {} as StateStamps };
    const ahead = device(kept);
    const behind = device(kept);
    ahead.see(T, look({ a: ["working", undefined, 1] }));
    behind.see(T, look({ a: ["working", undefined, 1] }));
    ahead.see(T + MIN, look({ a: ["idle", undefined, 2, DONE] }));
    ahead.see(T + 2 * MIN, look({}));
    behind.see(T + 2 * MIN + 1000, look({ a: ["working", undefined, 1], b: ["idle"] }));
    behind.see(T + 10 * MIN, look({ a: ["idle", undefined, 3, DONE], b: ["idle"] }));
    expect(behind.since("a", "idle")).toBe(T + 10 * MIN);
  });

  it("does not let a tab behind stamp its old news over a newer stamp", () => {
    const kept = { stamps: {} };
    const ahead = device(kept), behind = device(kept);
    ahead.see(T, look({ a: ["idle", 1] }));
    behind.see(T, look({ a: ["idle", 1] }));
    ahead.see(T + MIN, look({ a: ["working", 2] }));
    ahead.see(T + 2 * MIN, look({ a: ["blocked", 3] }));
    behind.see(T + 3 * MIN, look({ a: ["working", 2] }));
    expect(ahead.since("a", "blocked")).toBe(T + 2 * MIN);
    behind.reload();
    behind.see(T + 4 * MIN, look({ a: ["working", 2] }));
    expect(ahead.since("a", "blocked")).toBe(T + 2 * MIN);
  });

  it("never leaves a stamp ahead of a clock that was set back", () => {
    const page = device();
    page.see(T, look({ a: ["idle", 1] }));
    page.see(T + 10 * MIN, look({ a: ["working", 2] }));
    page.see(T + 4 * MIN, look({ a: ["working", 2] }));
    expect(page.since("a", "working")).toBe(T + 4 * MIN);

    page.see(T + 20 * MIN, look({ a: ["working", 2] }));
    expect(page.since("a", "working")).toBe(T + 4 * MIN);

    page.see(T + 30 * MIN, look({}));
    expect(page.see(T + 25 * MIN, look({}))).toEqual({ pc: { lifetime: "herdr-1", epoch: "server-1", rows: { a: { state: "working", at: T + 4 * MIN, terminal: "term-a", seq: 2, finish: 0, gone: T + 25 * MIN } } } });
  });

  it("forgets a pane thirty days after it left its PC's roster, however long it had been in its state, and no listed one", () => {
    const page = device();
    page.see(T, look({ a: ["idle", 1], b: ["idle", 2] }));
    page.see(T + MIN, look({ a: ["working", 3], b: ["working", 4] }));
    page.see(T + 40 * DAY, look({ a: ["working", 3], b: ["working", 4] }));
    page.see(T + 40 * DAY + MIN, look({ b: ["working", 4] }));
    page.see(T + 69 * DAY, look({ b: ["working", 4] }));
    expect(page.since("a", "working")).toBe(T + MIN);

    const kept = page.see(T + 71 * DAY, look({ b: ["working", 4] }));
    expect(kept).toEqual({ pc: { lifetime: "herdr-1", epoch: "server-1", rows: { b: { state: "working", at: T + MIN, terminal: "term-b", seq: 4, finish: 0 } } } });
  });

  it("keeps the time of a pane more than thirty days in its state that leaves the roster for a look", () => {
    const page = device();
    page.see(T, look({ a: ["idle", 1] }));
    page.see(T + MIN, look({ a: ["working", 2] }));
    page.see(T + 40 * DAY, look({}));
    expect(page.see(T + 40 * DAY + MIN, look({ a: ["working", 2] }))).toEqual({ pc: { lifetime: "herdr-1", epoch: "server-1", rows: { a: { state: "working", at: T + MIN, terminal: "term-a", seq: 2, finish: 0 } } } });
  });

  it("keeps the stamps of a PC that left the roster for thirty days from the look that first missed it", () => {
    const page = device();
    page.see(T, look({ a: ["idle", 1] }));
    page.see(T + MIN, look({ a: ["working", 2] }));
    page.see(T + 40 * DAY);
    page.see(T + 69 * DAY);
    expect(page.since("a", "working")).toBe(T + MIN);
    expect(page.see(T + 71 * DAY)).toEqual({});
  });

  it("hands back the very stamps it was given when a look changes nothing, so nothing is written", () => {
    const empty: StateStamps = {};
    expect(advanceStateStamps({ stamps: empty, last: new Map() }, [look({ a: ["idle", 1] })], T).stamps).toBe(empty);

    const page = device();
    page.see(T, look({ a: ["idle", 1] }));
    const stamped = page.see(T + MIN, look({ a: ["working", 2] }));
    expect(page.see(T + 2 * MIN, look({ a: ["working", 2] }))).toBe(stamped);
  });
});

describe("stored state stamps", () => {
  it("reads what it wrote and drops every field that is not a stamp", () => {
    const stored = JSON.stringify({ version: 1, pcs: {
      pc: { lifetime: "herdr-1", epoch: "server-1", rows: {
        good: { state: "blocked", at: T, terminal: "t1", seq: 4, finish: 2 },
        unseq: { state: "idle", at: T + 1, terminal: "t2", finish: "two" },
        left: { state: "idle", at: T + 2, terminal: "t3", seq: 5, gone: T + 9 },
        leaving: { state: "idle", at: T + 3, terminal: "t4", gone: "soon" },
        done: { state: "done", at: T, terminal: "t5" },
        undated: { state: "idle", at: "yesterday", terminal: "t6" },
        endless: { state: "working", at: Infinity, terminal: "t7" },
        unnamed: { state: "idle", at: T },
        misnamed: { state: "idle", at: T, terminal: 8 },
      } },
      nameless: { epoch: 7, rows: { a: { state: "working", at: T, terminal: "t9", seq: "9" } } },
      broken: "rows",
    } });
    expect(parseStateStamps(stored)).toEqual({
      pc: { lifetime: "herdr-1", epoch: "server-1", rows: { good: { state: "blocked", at: T, terminal: "t1", seq: 4, finish: 2 }, unseq: { state: "idle", at: T + 1, terminal: "t2" }, left: { state: "idle", at: T + 2, terminal: "t3", seq: 5, gone: T + 9 }, leaving: { state: "idle", at: T + 3, terminal: "t4" } } },
      nameless: { lifetime: null, epoch: null, rows: { a: { state: "working", at: T, terminal: "t9" } } },
    });
  });

  it("reads what this page wrote without parsing it again, and what another tab then wrote", () => {
    const page = Object.getOwnPropertyDescriptor(globalThis, "window");
    let text: string | null = null;
    Object.defineProperty(globalThis, "window", { configurable: true, value: { localStorage: {
      getItem: () => text,
      setItem: (_key: string, value: string) => { text = value; },
    } } });
    try {
      const mine: StateStamps = { pc: { lifetime: "herdr-1", epoch: "server-1", rows: { a: { state: "idle", at: T, terminal: "t1", seq: 1, finish: 0 } } } };
      expect(saveStateStamps(mine)).toBe(true);
      expect(loadStateStamps()).toBe(mine);

      const theirs: StateStamps = { pc: { lifetime: "herdr-1", epoch: "server-1", rows: { a: { state: "working", at: T + MIN, terminal: "t1", seq: 2, finish: 0 } } } };
      text = JSON.stringify({ version: 1, pcs: theirs });
      const read = loadStateStamps();
      expect(read).toEqual(theirs);
      expect(loadStateStamps()).toBe(read);
    } finally {
      if (page) Object.defineProperty(globalThis, "window", page);
      else Reflect.deleteProperty(globalThis, "window");
    }
  });

  it("reads nothing from another version, from text that is not JSON, or from no record", () => {
    expect(parseStateStamps(JSON.stringify({ version: 2, pcs: { pc: { lifetime: "h", rows: { a: { state: "idle", at: T, terminal: "t1" } } } } }))).toEqual({});
    expect(parseStateStamps("{")).toEqual({});
    expect(parseStateStamps(null)).toEqual({});
  });
});
