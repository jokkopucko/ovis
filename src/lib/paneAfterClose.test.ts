import { describe, expect, it } from "bun:test";

import { paneAfterClose } from "./paneAfterClose.ts";

function roster(tree: Record<string, Record<string, string[]>>, focus: Record<string, string> = {}) {
  const workspaces = Object.entries(tree).map(([workspace_id, tabs], index) => ({ workspace_id, number: index + 1, active_tab_id: Object.keys(tabs)[0] }));
  const tabs = Object.entries(tree).flatMap(([workspace_id, entries]) => Object.keys(entries).map((tab_id, index) => ({ tab_id, workspace_id, number: index + 1 })));
  const panes = Object.entries(tree).flatMap(([workspace_id, entries]) => Object.entries(entries).flatMap(([tab_id, ids]) => ids.map((pane_id) => ({ pane_id, tab_id, workspace_id }))));
  const layouts = Object.values(tree).flatMap((entries) => Object.entries(entries).map(([tab_id, ids]) => ({ tab_id, focused_pane_id: focus[tab_id] ?? ids[0], panes: ids.map((pane_id) => ({ pane_id })) })));
  return { workspaces, tabs, panes, layouts } as never;
}

describe("paneAfterClose", () => {
  it("stays in the tab: the pane selected before, else the next in layout order, else the one before", () => {
    const before = roster({ w1: { t1: ["a", "b", "c"] }, w2: { t2: ["x"] } });
    const after = roster({ w1: { t1: ["a", "c"] }, w2: { t2: ["x"] } });
    expect(paneAfterClose(before, after, "b", "a")).toBe("a");
    expect(paneAfterClose(before, after, "b", null)).toBe("c");
    expect(paneAfterClose(before, after, "b", "x")).toBe("c");
    expect(paneAfterClose(before, roster({ w1: { t1: ["a", "b"] }, w2: { t2: ["x"] } }), "c", null)).toBe("b");
    expect(paneAfterClose(roster({ w1: { t1: ["a"], t2: ["y"] } }), roster({ w1: { t1: ["n"], t2: ["y"] } }), "a", null)).toBe("n");
  });

  it("with its tab gone, opens the tab before it, else the one after, at that tab's focused pane", () => {
    const before = roster({ w1: { t1: ["a", "b"], t2: ["c"], t3: ["d", "e"] } }, { t1: "b", t3: "e" });
    expect(paneAfterClose(before, roster({ w1: { t1: ["a", "b"], t3: ["d", "e"] } }, { t1: "b", t3: "e" }), "c", null)).toBe("b");
    const first = roster({ w1: { t2: ["c"], t3: ["d", "e"] } }, { t3: "e" });
    expect(paneAfterClose(roster({ w1: { t1: ["a"], t2: ["c"], t3: ["d", "e"] } }, { t3: "e" }), first, "a", null)).toBe("c");
  });

  it("with its workspace gone, opens the workspace after it, else the one before", () => {
    const before = roster({ w1: { t1: ["a"] }, w2: { t2: ["b"] }, w3: { t3: ["c"] } });
    expect(paneAfterClose(before, roster({ w1: { t1: ["a"] }, w3: { t3: ["c"] } }), "b", null)).toBe("c");
    expect(paneAfterClose(before, roster({ w1: { t1: ["a"] }, w2: { t2: ["b"] } }), "c", null)).toBe("b");
  });

  it("takes the neighbouring tab in the order the roster shows, not by tab number, after tabs were reordered", () => {
    const reorder = (tree: ReturnType<typeof roster>) => {
      const value = tree as unknown as { tabs: Array<{ tab_id: string; number: number }> };
      const number: Record<string, number> = { t1: 1, t2: 2, t3: 3 };
      for (const tab of value.tabs) tab.number = number[tab.tab_id]!;
      return tree;
    };
    const before = reorder(roster({ w1: { t3: ["c"], t1: ["a"], t2: ["b"] } }));
    expect(paneAfterClose(before, reorder(roster({ w1: { t3: ["c"], t2: ["b"] } })), "a", null)).toBe("c");
  });

  it("keeps the selection in its workspace when a tab made there after `before` is all it has left", () => {
    const before = roster({ w1: { t1: ["a"] }, w2: { t2: ["x"] } });
    expect(paneAfterClose(before, roster({ w1: { t3: ["n"] }, w2: { t2: ["x"] } }), "a", null)).toBe("n");
  });

  it("opens the pane this browser last viewed in the tab or workspace it moves to, as clicking it would", () => {
    const remembered: Record<string, string> = { "tab:t1": "a2", "workspace:w2": "y" };
    const viewed = (scope: "tab" | "workspace", id: string) => remembered[`${scope}:${id}`];
    const tabs = roster({ w1: { t1: ["a1", "a2"], t2: ["c"] } });
    expect(paneAfterClose(tabs, roster({ w1: { t1: ["a1", "a2"] } }), "c", null, viewed)).toBe("a2");
    const workspaces = roster({ w1: { t1: ["a"] }, w2: { t2: ["x", "y"] } });
    expect(paneAfterClose(workspaces, roster({ w2: { t2: ["x", "y"] } }), "a", null, viewed)).toBe("y");
    expect(paneAfterClose(tabs, roster({ w1: { t1: ["a1"] } }), "c", null, viewed)).toBe("a1");
  });

  it("names nothing for a pane it never saw, or when nothing is left", () => {
    const before = roster({ w1: { t1: ["a"] } });
    expect(paneAfterClose(before, before, "gone", null)).toBeNull();
    expect(paneAfterClose(before, roster({}), "a", null)).toBeNull();
  });
});
