import { describe, expect, it } from "bun:test";

import { BackgroundWait, WAIT_GRACE_MS, WAIT_LIMIT_MS } from "./background-wait.ts";

function clock() {
  let now = 0;
  return { now: () => now, pass: (ms: number) => { now += ms; } };
}

describe("BackgroundWait", () => {
  it("holds an OmO turn past the limit while its tasks run, and a Claude turn no longer", () => {
    const time = clock();
    const waits = new BackgroundWait(time.now);
    for (const [pane, capped] of [["omo", false], ["claude", true]] as const) {
      waits.status(pane, "working");
      waits.running(pane, 1, null, capped);
      waits.status(pane, "done");
    }
    time.pass(WAIT_LIMIT_MS + 1000);
    expect(waits.tick()).toEqual(["claude"]);
    expect([waits.waiting("omo"), waits.waiting("claude")]).toEqual([true, false]);
    waits.running("omo", 0, null, false);
    time.pass(WAIT_GRACE_MS);
    expect(waits.tick()).toEqual(["omo"]);
    expect(waits.waiting("omo")).toBe(false);
  });

  it("holds an OmO turn that ends in the same read as its running tasks are counted", () => {
    const time = clock();
    const waits = new BackgroundWait(time.now);
    waits.running("p1", 0, null, false);
    waits.status("p1", "working");
    waits.running("p1", 2, null, false);
    waits.status("p1", "done");
    expect(waits.waiting("p1")).toBe(true);
    waits.running("p1", 0, null, false);
    expect(waits.waiting("p1")).toBe(true);
    waits.running("p1", 0, null, false);
    waits.status("p1", "working");
    expect(waits.waiting("p1")).toBe(false);
    waits.running("p1", 0, null, false);
    waits.status("p1", "done");
    expect(waits.waiting("p1")).toBe(false);
  });

  it("accepts the first working baseline after count-only discovery without overwriting later events", () => {
    const waits = new BackgroundWait(clock().now);
    waits.running("p1", 1, 0);
    waits.seed("p1", "working");
    expect(waits.status("p1", "done")).toBe(true);
    waits.seed("p1", "working");
    expect(waits.waiting("p1")).toBe(true);
  });

  it("does not rehold a resting baseline after restart or generate another finish", () => {
    const time = clock();
    const waits = new BackgroundWait(time.now);
    waits.seed("p1", "done");
    expect(waits.running("p1", 1)).toBe(false);
    expect(waits.waiting("p1")).toBe(false);
    time.pass(WAIT_LIMIT_MS);
    expect(waits.tick()).toEqual([]);
    waits.status("p1", "idle");
    expect(waits.waiting("p1")).toBe(false);
  });

  it("gives each rest its own deadline when a notice resumes a turn and it rests on what still runs", () => {
    const time = clock();
    const waits = new BackgroundWait(time.now);
    waits.status("p1", "working");
    waits.running("p1", 2);
    waits.status("p1", "done");
    time.pass(WAIT_LIMIT_MS - 1000);
    waits.running("p1", 1);
    waits.status("p1", "working");
    waits.status("p1", "done");
    time.pass(1000);
    expect(waits.tick()).toEqual([]);
    expect(waits.waiting("p1")).toBe(true);
    time.pass(WAIT_LIMIT_MS - 1000);
    expect(waits.tick()).toEqual(["p1"]);
    expect(waits.waiting("p1")).toBe(false);
  });

  it("holds a turn that ended while what it started runs, and lets go once Claude goes on with it", () => {
    const time = clock();
    const waits = new BackgroundWait(time.now);
    waits.status("p1", "working");
    expect(waits.running("p1", 1)).toBe(false);
    expect(waits.status("p1", "done")).toBe(true);
    expect(waits.waiting("p1")).toBe(true);
    time.pass(5 * 60_000);
    expect(waits.running("p1", 0)).toBe(false);
    time.pass(2000);
    expect(waits.status("p1", "working")).toBe(true);
    expect(waits.waiting("p1")).toBe(false);
    expect(waits.status("p1", "done")).toBe(false);
    expect(waits.waiting("p1")).toBe(false);
  });

  it("holds a while after the work ended for Claude to go on, then lets go", () => {
    const time = clock();
    const waits = new BackgroundWait(time.now);
    waits.status("p1", "working");
    waits.running("p1", 2);
    waits.status("p1", "idle");
    waits.running("p1", 1);
    waits.running("p1", 0);
    time.pass(WAIT_GRACE_MS - 1);
    expect(waits.tick()).toEqual([]);
    time.pass(1);
    expect(waits.tick()).toEqual(["p1"]);
    expect(waits.waiting("p1")).toBe(false);
  });

  it("holds nothing for work that ended before the turn did, or for a turn that started nothing", () => {
    const time = clock();
    const waits = new BackgroundWait(time.now);
    waits.status("p1", "working");
    waits.running("p1", 1);
    waits.running("p1", 0);
    expect(waits.status("p1", "done")).toBe(false);
    waits.status("p2", "working");
    expect(waits.status("p2", "done")).toBe(false);
    expect([waits.waiting("p1"), waits.waiting("p2")]).toEqual([false, false]);
  });

  it("lets go at the limit, takes no status seen meanwhile for a new rest, and holds a new prompt's", () => {
    const time = clock();
    const waits = new BackgroundWait(time.now);
    waits.status("p1", "working");
    waits.running("p1", 1, time.now());
    waits.status("p1", "done");
    time.pass(WAIT_LIMIT_MS - 1);
    expect(waits.tick()).toEqual([]);
    time.pass(1);
    expect(waits.tick()).toEqual(["p1"]);
    expect(waits.status("p1", "idle")).toBe(false);
    waits.status("p1", "working");
    waits.running("p1", 1, time.now());
    expect(waits.status("p1", "done")).toBe(true);
  });

  it("associates delayed prompts with the rests observed before discovery, the last one owning the deadline", () => {
    const time = clock();
    const waits = new BackgroundWait(time.now);
    waits.status("p1", "working");
    time.pass(10);
    waits.status("p1", "done");
    time.pass(10);
    expect(waits.running("p1", 1, 0)).toBe(true);
    const prompt = time.now();
    waits.status("p1", "working");
    time.pass(10);
    waits.status("p1", "done");
    time.pass(10);
    waits.status("p1", "working");
    waits.status("p1", "done");
    waits.running("p1", 1, prompt);
    time.pass(WAIT_LIMIT_MS - 1);
    expect(waits.waiting("p1")).toBe(true);
    expect(waits.tick()).toEqual([]);
    time.pass(1);
    expect(waits.tick()).toEqual(["p1"]);
    waits.running("p1", 1, null);
    waits.status("p1", "working");
    time.pass(WAIT_LIMIT_MS);
    waits.status("p1", "done");
    waits.running("p1", 1, prompt);
    expect(waits.waiting("p1")).toBe(true);
    time.pass(1);
    waits.running("p1", 0, time.now());
    expect(waits.waiting("p1")).toBe(false);
    waits.running("p1", 1, time.now());
    expect(waits.waiting("p1")).toBe(false);
  });

  it("holds only an observed busy-to-rest transition and never masks blocked", () => {
    const time = clock();
    const waits = new BackgroundWait(time.now);
    waits.running("p1", 1);
    expect(waits.waiting("p1")).toBe(false);
    expect(waits.status("p1", "done")).toBe(false);
    expect(waits.status("p1", "blocked")).toBe(false);
    expect(waits.waiting("p1")).toBe(false);
    expect(waits.status("p1", "done")).toBe(true);
    expect(waits.status("p1", "blocked")).toBe(true);
  });

  it("takes a snapshot's status only for a pane it does not know yet: an event seen is newer", () => {
    const waits = new BackgroundWait(clock().now);
    waits.seed("p1", "working");
    waits.running("p1", 1);
    waits.status("p1", "done");
    expect(waits.waiting("p1")).toBe(true);
    waits.seed("p1", "working");
    expect(waits.waiting("p1")).toBe(true);
  });

  it("keeps, past another agent's lifetime, only the rests seen since the agent that followed began", () => {
    const time = clock();
    const waits = new BackgroundWait(time.now);
    waits.status("p", "working");
    waits.running("p", 1, null);
    waits.status("p", "done");
    expect(waits.waiting("p")).toBe(true);
    time.pass(1000);
    const since = time.now();
    waits.status("p", "working");
    time.pass(1000);
    waits.status("p", "idle");
    waits.resetBefore("p", since);
    expect(waits.waiting("p")).toBe(false);
    waits.running("p", 1, since);
    expect(waits.waiting("p")).toBe(true);
    waits.reset("p");
    waits.running("p", 1, since);
    expect(waits.waiting("p")).toBe(false);
  });

  it("lets go at once when a count falls without its work ending (a setting turned off)", () => {
    const waits = new BackgroundWait(clock().now);
    waits.status("p1", "working");
    waits.running("p1", 1);
    waits.status("p1", "done");
    expect(waits.waiting("p1")).toBe(true);
    expect(waits.running("p1", 0, null, true, true)).toBe(true);
    expect(waits.waiting("p1")).toBe(false);
  });

  it("forgets a pane", () => {
    const waits = new BackgroundWait(clock().now);
    waits.running("p1", 1);
    waits.status("p1", "done");
    waits.forget("p1");
    expect(waits.waiting("p1")).toBe(false);
    expect(waits.tick()).toEqual([]);
  });
});
