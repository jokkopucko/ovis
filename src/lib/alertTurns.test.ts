import { describe, expect, it, jest } from "bun:test";
import { AlertTurns, createAlertTurnPlayer, type AlertTurnMessage } from "./alertTurns.ts";

const key = JSON.stringify(["local", "pane-1", "blocked"]);
const claim: AlertTurnMessage = { type: "claim", tab: "a", key, kind: "blocked" };
const chimed: AlertTurnMessage = { ...claim, type: "chimed" };
const play = { type: "play", key, kind: "blocked" } as const;

describe("alert turns with a local clock", () => {
  it("lets a lone tab chime after its claim window", () => {
    const tab = new AlertTurns("b");
    expect(tab.start(key, "blocked", 0)).toEqual([{ ...claim, tab: "b" }]);
    expect(tab.tick(149)).toEqual([]);
    expect(tab.tick(150)).toEqual([play]);
  });

  it("lets the lower of two claimants chime and the other defer", () => {
    const a = new AlertTurns("a");
    const b = new AlertTurns("b");
    a.start(key, "blocked", 0);
    b.start(key, "blocked", 0);
    a.receive({ ...claim, tab: "b" }, 1);
    b.receive(claim, 1);
    expect(a.tick(150)).toEqual([play]);
    expect(b.tick(150)).toEqual([]);
    b.receive(a.finish(key, true, 150)[0]!, 151);
    expect(b.tick(750)).toEqual([]);
  });

  it("drops an alert already chimed within the local lookback", () => {
    const tab = new AlertTurns("b");
    tab.receive(chimed, 100);
    expect(tab.start(key, "blocked", 200)).toEqual([]);
    expect(tab.tick(350)).toEqual([]);
  });

  it("rescues a question when the winning tab never chimes", () => {
    const tab = new AlertTurns("b");
    tab.start(key, "blocked", 0);
    tab.receive(claim, 1);
    expect(tab.tick(150)).toEqual([]);
    expect(tab.tick(749)).toEqual([]);
    expect(tab.tick(750)).toEqual([play]);
  });

  it("redecides a pending question immediately when its winner withdraws", () => {
    const tab = new AlertTurns("b");
    tab.start(key, "blocked", 0);
    tab.receive(claim, 1);
    tab.tick(150);
    expect(tab.receive({ ...claim, type: "withdraw" }, 200)).toEqual([play]);
  });

  it("chimes a finish in another tab when the winning tab cannot play it", () => {
    const a = new AlertTurns("a");
    const b = new AlertTurns("b");
    a.start(key, "done", 0);
    b.start(key, "done", 0);
    a.receive({ ...claim, tab: "b", kind: "done" }, 1);
    b.receive({ ...claim, kind: "done" }, 1);
    expect(a.tick(150)).toEqual([{ ...play, kind: "done" }]);
    expect(b.tick(150)).toEqual([]);
    expect(b.receive(a.finish(key, false, 160)[0]!, 161)).toEqual([{ ...play, kind: "done" }]);
  });

  it("chimes a finish once when the winning tab played it", () => {
    const a = new AlertTurns("a");
    const b = new AlertTurns("b");
    a.start(key, "done", 0);
    b.start(key, "done", 0);
    a.receive({ ...claim, tab: "b", kind: "done" }, 1);
    b.receive({ ...claim, kind: "done" }, 1);
    expect(a.tick(150)).toEqual([{ ...play, kind: "done" }]);
    expect(b.tick(150)).toEqual([]);
    b.receive(a.finish(key, true, 160)[0]!, 161);
    expect(b.tick(10_000)).toEqual([]);
  });

  it("rescues a finish when the winning tab never answers", () => {
    const tab = new AlertTurns("b");
    tab.start(key, "done", 0);
    tab.receive({ ...claim, kind: "done" }, 1);
    expect(tab.tick(150)).toEqual([]);
    expect(tab.tick(749)).toEqual([]);
    expect(tab.tick(750)).toEqual([{ ...play, kind: "done" }]);
  });

  it("ignores claims older than the lookback", () => {
    const tab = new AlertTurns("b");
    tab.receive(claim, 0);
    tab.start(key, "blocked", 1501);
    expect(tab.tick(1651)).toEqual([play]);
  });

  it("allows the same pane to alert again after the lookback", () => {
    const tab = new AlertTurns("b");
    tab.receive(chimed, 0);
    tab.start(key, "blocked", 1501);
    expect(tab.tick(1651)).toEqual([play]);
  });

  it("honours a received chime even when its own timer runs very late", () => {
    const tab = new AlertTurns("b");
    tab.start(key, "blocked", 0);
    tab.receive(chimed, 100);
    expect(tab.tick(10_000)).toEqual([]);
  });

  it("cancels the safety net when a chime arrives", () => {
    const tab = new AlertTurns("b");
    tab.start(key, "blocked", 0);
    tab.receive(claim, 1);
    tab.tick(150);
    tab.receive(chimed, 749);
    expect(tab.tick(10_000)).toEqual([]);
  });

  it("tells a second question on the same pane that comes after the first one's chime", () => {
    const tab = new AlertTurns("b");
    tab.receive(claim, 1);
    tab.receive(chimed, 151);
    expect(tab.start(key, "blocked", 800)).toEqual([{ ...claim, tab: "b" }]);
    expect(tab.tick(950)).toEqual([play]);
  });

  it("is not silenced by a late duplicate of the chime it played itself", () => {
    const a = new AlertTurns("a");
    a.start(key, "blocked", 0);
    expect(a.tick(150)).toEqual([play]);
    a.finish(key, true, 150);
    a.receive({ ...chimed, tab: "b" }, 1_100);
    expect(a.start(key, "blocked", 1_480)).toEqual([claim]);
    expect(a.tick(1_630)).toEqual([play]);
  });

  it("takes another tab's chime of the pane's next question although it chimed the first one itself", () => {
    const a = new AlertTurns("a");
    const b = new AlertTurns("b");
    b.start(key, "blocked", 0);
    expect(b.tick(150)).toEqual([play]);
    b.finish(key, true, 150);
    a.start(key, "blocked", 800);
    b.start(key, "blocked", 800);
    a.receive({ ...claim, tab: "b" }, 801);
    b.receive(claim, 801);
    expect(a.tick(950)).toEqual([play]);
    expect(b.tick(950)).toEqual([]);
    b.receive(a.finish(key, true, 950)[0]!, 951);
    expect(b.tick(10_000)).toEqual([]);
  });

  it("waits for a winner that is playing, however long its audio waits, and chimes once", () => {
    for (const kind of ["blocked", "done"] as const) {
      const a = new AlertTurns("a");
      const b = new AlertTurns("b");
      a.start(key, kind, 0);
      b.start(key, kind, 0);
      a.receive({ ...claim, tab: "b", kind }, 1);
      b.receive({ ...claim, kind }, 1);
      expect(a.tick(150)).toEqual([{ ...play, kind }]);
      expect(b.tick(150)).toEqual([]);
      b.receive(a.announce(key, kind), 151);
      expect(b.tick(750)).toEqual([]);
      expect(b.tick(1_400)).toEqual([]);
      b.receive(a.finish(key, true, 1_400)[0]!, 1_401);
      expect(b.tick(10_000)).toEqual([]);
    }
  });

  it("still rescues an alert whose winner said it was playing and then went silent", () => {
    const b = new AlertTurns("b");
    b.start(key, "done", 0);
    b.receive({ ...claim, kind: "done" }, 1);
    b.tick(150);
    b.receive({ ...claim, type: "playing", kind: "done" }, 151);
    expect(b.tick(5_150)).toEqual([]);
    expect(b.tick(5_151)).toEqual([{ ...play, kind: "done" }]);
  });

  it("keeps a third tab behind the second one's rescue when a winner that said it was playing goes silent", () => {
    const c = new AlertTurns("c");
    c.start(key, "blocked", 0);
    c.receive(claim, 1);
    c.receive({ ...claim, tab: "b" }, 1);
    c.tick(150);
    c.receive({ ...claim, type: "playing" }, 151);
    expect(c.tick(5_151)).toEqual([]);
    expect(c.tick(5_750)).toEqual([]);
    expect(c.tick(5_751)).toEqual([play]);
  });

  it("redecides at once when a winner that said it was playing withdraws", () => {
    const b = new AlertTurns("b");
    b.start(key, "blocked", 0);
    b.receive(claim, 1);
    b.tick(150);
    b.receive({ ...claim, type: "playing" }, 151);
    expect(b.receive({ ...claim, type: "withdraw" }, 300)).toEqual([play]);
  });

  it("lets a third tab wait for the second one's rescue instead of chiming with it", () => {
    const c = new AlertTurns("c");
    c.start(key, "blocked", 0);
    c.receive(claim, 1);
    c.receive({ ...claim, tab: "b" }, 1);
    expect(c.tick(150)).toEqual([]);
    expect(c.tick(750)).toEqual([]);
    c.receive({ ...chimed, tab: "b" }, 760);
    expect(c.tick(10_000)).toEqual([]);
  });

  it("still rescues a question when every lower tab is gone", () => {
    const c = new AlertTurns("c");
    c.start(key, "blocked", 0);
    c.receive(claim, 1);
    c.receive({ ...claim, tab: "b" }, 1);
    c.tick(150);
    expect(c.tick(1_349)).toEqual([]);
    expect(c.tick(1_350)).toEqual([play]);
  });

  it("keeps other machines and panes independent", () => {
    const tab = new AlertTurns("b");
    tab.receive(chimed, 0);
    tab.start("another-machine-pane", "blocked", 1);
    expect(tab.tick(151)).toEqual([{ ...play, key: "another-machine-pane" }]);
  });

  it("withdraws rather than claiming success when audio becomes unavailable", () => {
    const tab = new AlertTurns("a");
    tab.start(key, "blocked", 0);
    tab.tick(150);
    expect(tab.finish(key, false, 150)).toEqual([{ ...claim, type: "withdraw" }]);
  });

  it("withdraws and forgets live work when the page leaves", () => {
    const tab = new AlertTurns("a");
    tab.start(key, "blocked", 0);
    expect(tab.clear()).toEqual([{ ...claim, type: "withdraw" }]);
    expect(tab.tick(10_000)).toEqual([]);
    expect(tab.start(key, "blocked", 10_001)).toEqual([claim]);
  });

  it("chimes immediately when BroadcastChannel is unavailable", () => {
    const heard: string[] = [];
    const player = createAlertTurnPlayer({ channel: null, play: (kind) => { heard.push(kind); return true; } });
    player.chime(key, "blocked");
    expect(heard).toEqual(["blocked"]);
    player.dispose();
  });
  it("still tells the pane's next question after a peer's chime came while its own was queued", async () => {
    jest.useFakeTimers();
    const channel = { onmessage: null as ((event: MessageEvent<unknown>) => void) | null, postMessage() {}, close() {} };
    const heard: string[] = [];
    let release: (played: boolean) => void = () => {};
    const results: (boolean | Promise<boolean>)[] = [true, new Promise<boolean>((resolve) => { release = resolve; }), true];
    const player = createAlertTurnPlayer({
      channel: channel as unknown as BroadcastChannel,
      play: (kind) => { heard.push(kind); return results.shift() ?? true; },
    });
    try {
      player.chime(key, "blocked");
      jest.advanceTimersByTime(150);
      player.chime(key, "blocked");
      jest.advanceTimersByTime(150);
      expect(heard).toEqual(["blocked", "blocked"]);
      channel.onmessage?.({ data: { ...chimed, tab: "b" } } as MessageEvent<unknown>);
      release(true);
      await Promise.resolve();
      jest.advanceTimersByTime(2_000);
      player.chime(key, "blocked");
      jest.advanceTimersByTime(150);
      expect(heard).toEqual(["blocked", "blocked", "blocked"]);
    } finally {
      player.dispose();
      jest.useRealTimers();
    }
  });
});
