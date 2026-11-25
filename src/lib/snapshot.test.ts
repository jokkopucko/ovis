import { describe, expect, it } from "bun:test";
import type { AgentStatus, SessionSnapshot } from "../../shared/protocol.ts";
import { applyPaneStatus } from "./snapshot.ts";

function snapshotFixture(): SessionSnapshot {
  return {
    protocol: 22,
    version: "test",
    workspaces: [],
    tabs: [],
    layouts: [],
    panes: [
      { pane_id: "w1:p1", workspace_id: "w1", tab_id: "w1:t1", terminal_id: "t1", revision: 1, focused: true, agent_status: "working" },
      { pane_id: "w1:p2", workspace_id: "w1", tab_id: "w1:t1", terminal_id: "t2", revision: 1, focused: false, agent_status: "idle" },
    ],
    agents: [
      { pane_id: "w1:p1", workspace_id: "w1", tab_id: "w1:t1", terminal_id: "t1", revision: 1, focused: true, agent_status: "working" },
    ],
  } as unknown as SessionSnapshot;
}

describe("applyPaneStatus", () => {
  it("takes the server's change time from a frame that has one, and keeps it through frames that do not", () => {
    const current = snapshotFixture();
    const changed = applyPaneStatus(current, "w1:p1", "done", undefined, false, undefined, undefined, undefined, undefined, 2_000);
    expect(changed.panes[0]?.changed_at).toBe(2_000);
    // a frame that only carries a context names no time: the pane keeps the one it has
    const context = applyPaneStatus(changed, "w1:p1", "done", undefined, false, undefined, undefined, undefined, { used: 5, window: 10 });
    expect(context.panes[0]?.changed_at).toBe(2_000);
    expect(applyPaneStatus(context, "w1:p1", "working", undefined, false, undefined, undefined, undefined, undefined, 3_000).panes[0]?.changed_at).toBe(3_000);
  });

  it("carries new finish IDs even when status is unchanged and invalidates other panes on epoch change", () => {
    const current = snapshotFixture();
    current.finish_epoch = "old";
    for (const pane of current.panes) { pane.agent_status = "done"; pane.finish_id = 1; }
    const next = applyPaneStatus(current, "w1:p1", "done", undefined, false, undefined, 2, "old");
    expect(next.panes[0]?.finish_id).toBe(2);
    expect(next.panes[1]?.finish_id).toBe(1);
    const restarted = applyPaneStatus(next, "w1:p1", "done", undefined, false, undefined, 1, "new");
    expect(restarted.finish_epoch).toBe("new");
    expect(restarted.panes[0]?.finish_id).toBe(1);
    expect(restarted.panes[1]?.finish_id).toBeUndefined();
    const legacy = applyPaneStatus(restarted, "w1:p1", "done");
    expect(legacy.finish_epoch).toBeUndefined();
    expect(legacy.panes[0]?.finish_id).toBeUndefined();
  });

  it("updates the pane and its agent entry to the pushed status", () => {
    const current = snapshotFixture();
    const next = applyPaneStatus(current, "w1:p1", "blocked" as AgentStatus);
    expect(next.panes.find((pane) => pane.pane_id === "w1:p1")?.agent_status).toBe("blocked");
    expect(next.agents.find((agent) => agent.pane_id === "w1:p1")?.agent_status).toBe("blocked");
    expect(next.panes.find((pane) => pane.pane_id === "w1:p2")).toBe(current.panes[1]);
  });

  it("carries a pane's background task count, and leaves it alone when a frame says nothing of it", () => {
    const current = snapshotFixture();
    const counted = applyPaneStatus(current, "w1:p1", "working", 2);
    expect(counted.panes.find((pane) => pane.pane_id === "w1:p1")).toMatchObject({ agent_status: "working", background_tasks: 2 });
    // a frame of another source (herdr's own status event) has no count: the one known stays
    const done = applyPaneStatus(counted, "w1:p1", "done" as AgentStatus);
    expect(done.panes.find((pane) => pane.pane_id === "w1:p1")).toMatchObject({ agent_status: "done", background_tasks: 2 });
    expect(applyPaneStatus(done, "w1:p1", "done" as AgentStatus, 2)).toBe(done);
    const none = applyPaneStatus(done, "w1:p1", "done" as AgentStatus, 0);
    expect("background_tasks" in none.panes.find((pane) => pane.pane_id === "w1:p1")!).toBe(false);
  });

  it("carries a pane's plan, keeps it through frames that say nothing of it, and drops it on null", () => {
    const current = snapshotFixture();
    const planned = applyPaneStatus(current, "w1:p1", "working", undefined, false, { done: 1, total: 3, current: "Building" });
    expect(planned.panes.find((pane) => pane.pane_id === "w1:p1")).toMatchObject({ plan: { done: 1, total: 3, current: "Building" } });
    const counted = applyPaneStatus(planned, "w1:p1", "working", 2);
    expect(counted.panes.find((pane) => pane.pane_id === "w1:p1")).toMatchObject({ background_tasks: 2, plan: { done: 1, total: 3 } });
    expect(applyPaneStatus(counted, "w1:p1", "working", undefined, false, { done: 1, total: 3, current: "Building" })).toBe(counted);
    const none = applyPaneStatus(counted, "w1:p1", "working", undefined, false, null);
    expect("plan" in none.panes.find((pane) => pane.pane_id === "w1:p1")!).toBe(false);
  });

  it("carries a pane's context, keeps it through frames that say nothing of it, and drops it on null", () => {
    const current = snapshotFixture();
    const filled = applyPaneStatus(current, "w1:p1", "working", undefined, false, undefined, undefined, undefined, { used: 50_000, window: 200_000 });
    expect(filled.panes.find((pane) => pane.pane_id === "w1:p1")).toMatchObject({ context: { used: 50_000, window: 200_000 } });
    expect(applyPaneStatus(filled, "w1:p1", "working", undefined, false, undefined, undefined, undefined, { used: 50_000, window: 200_000 })).toBe(filled);
    const kept = applyPaneStatus(filled, "w1:p1", "idle");
    expect(kept.panes.find((pane) => pane.pane_id === "w1:p1")).toMatchObject({ context: { used: 50_000, window: 200_000 } });
    const none = applyPaneStatus(kept, "w1:p1", "idle", undefined, false, undefined, undefined, undefined, null);
    expect("context" in none.panes.find((pane) => pane.pane_id === "w1:p1")!).toBe(false);
  });

  it("returns the same snapshot object when the status already matches", () => {
    const current = snapshotFixture();
    expect(applyPaneStatus(current, "w1:p1", "working")).toBe(current);
  });

  it("returns the same snapshot object when the pane is unknown", () => {
    const current = snapshotFixture();
    expect(applyPaneStatus(current, "w9:p9", "done" as AgentStatus)).toBe(current);
  });
});
