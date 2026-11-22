import { describe, expect, it } from "bun:test";

import { LaunchedAgents, STARTUP_MS } from "./launched-agents.ts";

describe("LaunchedAgents", () => {
  it("answers a conversation not begun for a pane it started an agent in, under one history", () => {
    const launched = new LaunchedAgents();
    launched.launched("w1:p1", "codex", 0);
    const first = launched.notBegun("w1:p1", undefined, 10);
    expect(first).toEqual({ source: "codex-transcript", historyId: "unwritten:launch:w1:p1:1" });
    expect(launched.notBegun("w1:p1", "done", 5_000)).toEqual(first);
    expect(launched.notBegun("w1:p2", "idle", 10)).toBeNull();
  });

  it("takes the status of an agent not yet seen at rest for its startup's", () => {
    const launched = new LaunchedAgents();
    launched.launched("w1:p1", "codex", 0);
    expect(launched.notBegun("w1:p1", "working", 4_000)).not.toBeNull();
    launched.launched("w2:p1", "claude", 0);
    expect(launched.notBegun("w2:p1", "blocked", 4_000)).not.toBeNull();
  });

  it("ends with the first turn: at work or asking after it rested", () => {
    const launched = new LaunchedAgents();
    launched.launched("w1:p1", "codex", 0);
    expect(launched.notBegun("w1:p1", "idle", 5_000)).not.toBeNull();
    expect(launched.notBegun("w1:p1", "working", 6_000)).toBeNull();
    expect(launched.notBegun("w1:p1", "done", 60_000)).toBeNull();
  });

  it("takes an agent at work long after its launch for one on its first turn", () => {
    const launched = new LaunchedAgents();
    launched.launched("w1:p1", "opencode", 0);
    expect(launched.notBegun("w1:p1", "working", STARTUP_MS + 1)).toBeNull();
    expect(launched.notBegun("w1:p1", "idle", STARTUP_MS + 2)).toBeNull();
  });

  it("reads a start screen's working and done as rest, and the first turn's as they are", () => {
    const launched = new LaunchedAgents();
    launched.launched("w1:p1", "codex", 0);
    expect(launched.settle("w1:p1", "unknown", 500)).toBe("unknown");
    expect(launched.settle("w1:p1", "working", 4_000)).toBe("idle");
    expect(launched.settle("w1:p1", "done", 4_500)).toBe("idle");
    expect(launched.settle("w1:p1", "working", 9_000)).toBe("working");
    expect(launched.settle("w1:p1", "done", 12_000)).toBe("done");
  });

  it("keeps a question asked at the start, and every status of a pane it did not start", () => {
    const launched = new LaunchedAgents();
    launched.launched("w1:p1", "claude", 0);
    expect(launched.settle("w1:p1", "blocked", 4_000)).toBe("blocked");
    expect(launched.settle("w1:p1", "idle", 6_000)).toBe("idle");
    expect(launched.settle("w2:p1", "working", 4_000)).toBe("working");
    expect(launched.settle("w2:p1", "done", 4_500)).toBe("done");
  });

  it("keeps the terminal's fallback for a kind it reads no transcript of", () => {
    const launched = new LaunchedAgents();
    launched.launched("w1:p1", "muse", 0);
    expect(launched.notBegun("w1:p1", "idle", 10)).toBeNull();
    expect(launched.notBegun("w1:p1", "idle", 10)).toBeNull();
    launched.launched("w1:p2", "constructor", 0);
    expect(launched.notBegun("w1:p2", "idle", 10)).toBeNull();
  });

  it("gives a pane id launched again a history of its own, and forgets a pane that ended", () => {
    const launched = new LaunchedAgents();
    launched.launched("w1:p1", "claude", 0);
    const first = launched.notBegun("w1:p1", "idle", 10);
    launched.launched("w1:p1", "claude", 20);
    expect(launched.notBegun("w1:p1", "idle", 30)?.historyId).not.toBe(first?.historyId);
    launched.forget("w1:p1");
    expect(launched.notBegun("w1:p1", "idle", 40)).toBeNull();
  });
});
