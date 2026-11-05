import { describe, expect, it } from "bun:test";
import type { HerdrPane, SessionSnapshot, TabInfo, WorkspaceInfo } from "../../shared/protocol.ts";
import { adjacentTabPane, adjacentWorkspacePane, sidebarWorkspaceSteps } from "./adjacentTarget.ts";

function workspace(id: string, overrides: Partial<WorkspaceInfo> = {}): WorkspaceInfo {
  return { workspace_id: id, active_tab_id: `${id}:t1`, label: id, number: 1, tab_count: 1, pane_count: 1, focused: false, agent_status: "idle", ...overrides };
}

function tab(id: string, workspaceId: string): TabInfo {
  return { tab_id: id, workspace_id: workspaceId, label: id, number: 1, pane_count: 1, focused: false, agent_status: "idle" };
}

function pane(id: string, tabId: string, overrides: Partial<HerdrPane> = {}): HerdrPane {
  return { pane_id: id, workspace_id: tabId.split(":")[0]!, tab_id: tabId, terminal_id: `${id}:term`, revision: 1, focused: false, agent_status: "idle", ...overrides };
}

function roster(workspaces: WorkspaceInfo[], tabs: TabInfo[], panes: HerdrPane[], layouts: SessionSnapshot["layouts"] = []): SessionSnapshot {
  return { protocol: 22, version: "test", workspaces, tabs, layouts, panes, agents: [] };
}

const nothingViewed = () => undefined;

describe("adjacentTabPane", () => {
  // herdr's order (the tab strip's) is the snapshot's, not the tab numbers
  const tabs = [tab("w1:t2", "w1"), tab("w1:t1", "w1"), tab("w2:t1", "w2"), tab("w1:t3", "w1")];
  const panes = [pane("p1", "w1:t1"), pane("p2", "w1:t2"), pane("p3a", "w1:t3"), pane("p3b", "w1:t3"), pane("q1", "w2:t1")];
  const snapshot = roster([workspace("w1"), workspace("w2")], tabs, panes);

  it("steps through the selected pane's workspace in the strip's order and wraps at both ends", () => {
    expect(adjacentTabPane(snapshot, "p1", 1, nothingViewed)).toBe("p3a");
    expect(adjacentTabPane(snapshot, "p3b", 1, nothingViewed)).toBe("p2");
    expect(adjacentTabPane(snapshot, "p2", -1, nothingViewed)).toBe("p3a");
    expect(adjacentTabPane(snapshot, "p1", -1, nothingViewed)).toBe("p2");
  });

  it("opens the pane the tab's own click opens: the one last viewed here, else herdr's focused one in it", () => {
    const layouts = [{ tab_id: "w1:t3", focused_pane_id: "p3b" }] as SessionSnapshot["layouts"];
    const withLayout = roster([workspace("w1"), workspace("w2")], tabs, panes, layouts);
    expect(adjacentTabPane(withLayout, "p1", 1, nothingViewed)).toBe("p3b");
    const viewed = (scope: "tab" | "workspace", id: string) => scope === "tab" && id === "w1:t3" ? "p3a" : undefined;
    expect(adjacentTabPane(withLayout, "p1", 1, viewed)).toBe("p3a");
    // a remembered pane that has since closed is passed over
    expect(adjacentTabPane(withLayout, "p1", 1, () => "gone")).toBe("p3b");
  });

  it("does nothing without another tab in the workspace or without a selected pane", () => {
    expect(adjacentTabPane(snapshot, "q1", 1, nothingViewed)).toBeNull();
    expect(adjacentTabPane(snapshot, null, 1, nothingViewed)).toBeNull();
    expect(adjacentTabPane(snapshot, "closed", 1, nothingViewed)).toBeNull();
  });

  it("never lands on a DAG viewer the strip leaves out beside its agent", () => {
    const viewer = pane("dag", "w1:t3", { label: "DAG · s1" });
    const withViewer = roster([workspace("w1")], [tab("w1:t1", "w1"), tab("w1:t3", "w1")], [pane("p1", "w1:t1"), viewer, pane("omo", "w1:t3", { agent: "omo" })],
      [{ tab_id: "w1:t3", focused_pane_id: "dag" }] as SessionSnapshot["layouts"]);
    expect(adjacentTabPane(withViewer, "p1", 1, nothingViewed)).toBe("omo");
  });
});

describe("sidebarWorkspaceSteps", () => {
  const repo = (linked: boolean) => ({ worktree: { is_linked_worktree: linked, repo_key: "r", repo_name: "r", checkout_path: "/r" } as WorkspaceInfo["worktree"] });
  const ordered = [workspace("a"), workspace("b", repo(false)), workspace("c", repo(true)), workspace("d")];

  it("is the sidebar's order: pinned rows first in pin order, then each row with the worktrees under it", () => {
    expect(sidebarWorkspaceSteps(ordered, [], () => false, null)).toEqual(["a", "b", "c", "d"]);
    expect(sidebarWorkspaceSteps(ordered, ["d", "a"], () => false, null)).toEqual(["d", "a", "b", "c"]);
  });

  it("passes over the worktrees of a folded group, unless the selection is in one", () => {
    expect(sidebarWorkspaceSteps(ordered, [], (key) => key === "r", null)).toEqual(["a", "b", "d"]);
    expect(sidebarWorkspaceSteps(ordered, [], (key) => key === "r", "c")).toEqual(["a", "b", "c", "d"]);
  });
});

describe("adjacentWorkspacePane", () => {
  const workspaces = [workspace("a"), workspace("b", { active_tab_id: "b:t2" }), workspace("c")];
  const tabs = [tab("a:t1", "a"), tab("b:t1", "b"), tab("b:t2", "b"), tab("c:t1", "c")];
  const panes = [pane("a1", "a:t1"), pane("b1", "b:t1"), pane("b2", "b:t2"), pane("c1", "c:t1")];
  const layouts = [{ tab_id: "b:t2", focused_pane_id: "b2" }] as SessionSnapshot["layouts"];
  const snapshot = roster(workspaces, tabs, panes, layouts);

  it("steps along the order given and wraps, opening the pane the row opens", () => {
    expect(adjacentWorkspacePane(snapshot, ["a", "b", "c"], "a1", 1, nothingViewed)).toBe("b2");
    expect(adjacentWorkspacePane(snapshot, ["a", "b", "c"], "c1", 1, nothingViewed)).toBe("a1");
    expect(adjacentWorkspacePane(snapshot, ["a", "b", "c"], "a1", -1, nothingViewed)).toBe("c1");
    expect(adjacentWorkspacePane(snapshot, ["c", "a", "b"], "c1", 1, nothingViewed)).toBe("a1");
    const viewed = (scope: "tab" | "workspace", id: string) => scope === "workspace" && id === "b" ? "b1" : undefined;
    expect(adjacentWorkspacePane(snapshot, ["a", "b", "c"], "a1", 1, viewed)).toBe("b1");
  });

  it("starts at an end without a selection, and does nothing with one workspace", () => {
    expect(adjacentWorkspacePane(snapshot, ["a", "b", "c"], null, 1, nothingViewed)).toBe("a1");
    expect(adjacentWorkspacePane(snapshot, ["a", "b", "c"], null, -1, nothingViewed)).toBe("c1");
    expect(adjacentWorkspacePane(snapshot, ["a"], "a1", 1, nothingViewed)).toBeNull();
  });

  it("passes over a workspace with no pane to open", () => {
    expect(adjacentWorkspacePane(snapshot, ["a", "empty", "c"], "a1", 1, nothingViewed)).toBe("c1");
  });
});
