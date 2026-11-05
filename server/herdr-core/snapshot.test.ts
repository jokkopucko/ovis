import { describe, expect, it } from "bun:test";
import type { HerdrPane } from "../../shared/protocol.ts";
import { buildSnapshot, type HcTerminal, keyBytes, OTHER_WORKSPACE_ID } from "./snapshot.ts";

function terminal(address: string, extra: Partial<HcTerminal> = {}): HcTerminal {
  return { address, cols: 120, rows: 40, cwd: "/home/u", state: "live", ...extra };
}

function block(address: string) {
  return { type: "block", id: `p-${address}`, content: { terminal: address } };
}

describe("buildSnapshot", () => {
  it("reads the app's spaces as workspaces, its tabs as tabs and each terminal block as a pane, in the app's order", () => {
    const layout = {
      spaces: [
        { id: "s1", name: "api", tabs: [
          { id: "s1t1", name: "", root: { type: "row", id: "r", children: [block("t3"), { type: "column", id: "c", children: [block("t1"), block("t2")] }] } },
          { id: "s1t2", name: "logs", root: { type: "row", id: "r2", children: [block("t4")] } },
        ] },
        { id: "s2", name: "", folder: "/work/web", tabs: [{ id: "s2t1", name: "", root: block("t5") }] },
      ],
    };
    const snapshot = buildSnapshot([terminal("t1"), terminal("t2"), terminal("t3"), terminal("t4"), terminal("t5")], layout, "0.1.14");
    expect(snapshot.workspaces.map((w) => [w.workspace_id, w.label, w.tab_count, w.pane_count, w.active_tab_id])).toEqual([
      ["s1", "api", 2, 4, "s1t1"],
      ["s2", "web", 1, 1, "s2t1"],
    ]);
    expect(snapshot.tabs.map((t) => [t.tab_id, t.label, t.number])).toEqual([["s1t1", "1", 1], ["s1t2", "logs", 2], ["s2t1", "1", 1]]);
    expect(snapshot.panes.map((p) => [p.pane_id, p.terminal_id, p.tab_id])).toEqual([
      ["t3", "t3", "s1t1"], ["t1", "t1", "s1t1"], ["t2", "t2", "s1t1"], ["t4", "t4", "s1t2"], ["t5", "t5", "s2t1"],
    ]);
  });

  it("shows an agent at rest as done while a turn ended past herdr.seen, and idle once looked at", () => {
    const resting = (address: string, state: string, turn: number, labels?: Record<string, string>) =>
      terminal(address, { status: { app: "claude-code", state }, turn, ...(labels ? { labels } : {}) });
    const snapshot = buildSnapshot([
      resting("t1", "idle", 3, { "herdr.seen": "2" }),
      resting("t2", "idle", 3, { "herdr.seen": "3" }),
      resting("t3", "done", 3, { "herdr.seen": "3" }),
      resting("t4", "working", 3, { "herdr.seen": "1" }),
      resting("t5", "blocked", 3, { "herdr.seen": "3" }),
      // no label, or one no client wrote as a turn: the program's own word, as before
      resting("t6", "idle", 3),
      resting("t7", "done", 3, { "herdr.seen": "x" }),
      // a shell that never reported stays without a status
      terminal("t8", { turn: 0, labels: { "herdr.seen": "0" } }),
    ], { spaces: [] }, "0.1.17");
    expect(snapshot.panes.map((pane) => [pane.pane_id, pane.agent_status])).toEqual([
      ["t1", "done"], ["t2", "idle"], ["t3", "idle"], ["t4", "working"], ["t5", "blocked"], ["t6", "idle"], ["t7", "done"], ["t8", "unknown"],
    ]);
    // without the label, a turn ended since the server first saw the terminal is done
    const since = buildSnapshot([resting("t6", "idle", 3), resting("t9", "idle", 2)], { spaces: [] }, "0.1.17", () => 2);
    expect(since.panes.map((pane) => [pane.pane_id, pane.agent_status])).toEqual([["t6", "done"], ["t9", "idle"]]);
  });

  it("names an unnamed space and tab as the app labels their terminals", () => {
    const layout = { spaces: [{ id: "s1", name: "", tabs: [{ id: "s1t1", name: "", root: block("t1") }] }] };
    const snapshot = buildSnapshot([terminal("t1", { labels: { where: "tmp / 3" } })], layout, "0.1.14");
    expect(snapshot.workspaces[0]!.label).toBe("tmp");
    expect(snapshot.tabs[0]!.label).toBe("3");
  });

  it("leaves out finished terminals and tabs left with none, and gives a terminal no tab holds a tab of its own", () => {
    const layout = { spaces: [
      { id: "s1", name: "a", tabs: [{ id: "s1t1", name: "", root: { type: "row", id: "r", children: [block("t1"), block("t2")] } }] },
      { id: "s2", name: "b", tabs: [{ id: "s2t1", name: "", root: block("t9") }] },
    ] };
    const snapshot = buildSnapshot([terminal("t1"), terminal("t2", { state: "finished" }), terminal("t7", { name: "worker" }), terminal("t8")], layout, "0.1.14");
    expect(snapshot.workspaces.map((w) => w.workspace_id)).toEqual(["s1", OTHER_WORKSPACE_ID]);
    expect(snapshot.panes.map((p) => [p.pane_id, p.workspace_id])).toEqual([["t1", "s1"], ["t7", OTHER_WORKSPACE_ID], ["t8", OTHER_WORKSPACE_ID]]);
    expect(snapshot.tabs.filter((t) => t.workspace_id === OTHER_WORKSPACE_ID).map((t) => t.label)).toEqual(["worker", "t8"]);
  });

  it("reads a document it cannot make sense of as no layout at all", () => {
    for (const layout of [null, "spaces", { spaces: "x" }, { spaces: [{ id: 1 }, { id: "s", tabs: [{ id: "t", root: { children: 5 } }] }] }]) {
      const snapshot = buildSnapshot([terminal("t1")], layout, "0.1.14");
      expect(snapshot.panes.map((p) => [p.pane_id, p.workspace_id])).toEqual([["t1", OTHER_WORKSPACE_ID]]);
    }
  });

  // an error says nothing about the turn having finished: no badge, never done
  it("takes each pane's agent and status from what its program reported, and rolls the most pressing up", () => {
    const layout = { spaces: [{ id: "s1", name: "a", tabs: [{ id: "s1t1", name: "", root: { type: "row", id: "r", children: [block("t1"), block("t2"), block("t3"), block("t4"), block("t5"), block("t6")] } }] }] };
    const snapshot = buildSnapshot([
      terminal("t1", { status: { app: "claude", state: "working" } }),
      terminal("t2", { status: { app: "codex", state: "blocked" } }),
      terminal("t3", { status: { app: "omp", state: "error" } }),
      terminal("t4"),
      // herdr-core names Claude Code `claude-code` and Antigravity `antigravity`; the rest of the server knows them as herdr's `claude` and `agy`
      terminal("t5", { status: { app: "claude-code", state: "idle" } }),
      terminal("t6", { status: { app: "antigravity", state: "idle" } }),
    ], layout, "0.1.14");
    expect(snapshot.panes.map((p) => [p.agent, p.agent_status])).toEqual([["claude", "working"], ["codex", "blocked"], ["omp", "unknown"], [null, "unknown"], ["claude", "idle"], ["agy", "idle"]]);
    expect(snapshot.tabs[0]!.agent_status).toBe("blocked");
    expect(snapshot.workspaces[0]!.agent_status).toBe("blocked");
    expect(snapshot.agents.map((a) => [a.pane_id, a.agent])).toEqual([["t1", "claude"], ["t2", "codex"], ["t3", "omp"], ["t5", "claude"], ["t6", "agy"]]);
  });

  it("gives each pane its terminal's own grid at its place in the tab's splits, so no two panes overlap", () => {
    const layout = { spaces: [{ id: "s1", name: "a", tabs: [{ id: "s1t1", name: "", root: { type: "row", id: "r", children: [block("t1"), { type: "column", id: "c", children: [block("t2"), block("t3")] }] } }] }] };
    const snapshot = buildSnapshot([terminal("t1", { cols: 80, rows: 49 }), terminal("t2", { cols: 60, rows: 24 }), terminal("t3", { cols: 60, rows: 24 })], layout, "0.1.14");
    const tab = snapshot.layouts[0]!;
    expect(tab.panes.map((pane) => [pane.pane_id, pane.rect])).toEqual([
      ["t1", { x: 0, y: 0, width: 80, height: 49 }],
      ["t2", { x: 81, y: 0, width: 60, height: 24 }],
      ["t3", { x: 81, y: 25, width: 60, height: 24 }],
    ]);
    expect(tab.area).toEqual({ x: 0, y: 0, width: 141, height: 49 });
  });

  it("places a terminal the document names twice once, and skips a space or tab whose id was seen or is empty", () => {
    const layout = { spaces: [
      { id: "s1", name: "a", tabs: [{ id: "s1t1", name: "", root: { type: "row", id: "r", children: [block("t1"), block("t1")] } }, { id: "s1t1", name: "", root: block("t2") }] },
      { id: "s1", name: "b", tabs: [{ id: "x", name: "", root: block("t3") }] },
      { id: OTHER_WORKSPACE_ID, name: "c", tabs: [{ id: "y", name: "", root: block("t3") }] },
      { id: "", name: "d", tabs: [{ id: "z", name: "", root: block("t3") }] },
    ] };
    const snapshot = buildSnapshot([terminal("t1"), terminal("t2"), terminal("t3")], layout, "0.1.14");
    expect(snapshot.panes.map((p) => [p.pane_id, p.workspace_id])).toEqual([["t1", "s1"], ["t2", OTHER_WORKSPACE_ID], ["t3", OTHER_WORKSPACE_ID]]);
    expect(new Set(snapshot.workspaces.map((w) => w.workspace_id)).size).toBe(snapshot.workspaces.length);
  });
});

describe("buildSnapshot, terminals the app has not placed", () => {
  it("groups a labeled terminal by its space and tab, as the app will adopt it, and leaves an unlabeled one under Other terminals", () => {
    const layout = { spaces: [{ id: "s1", name: "api", tabs: [{ id: "s1t1", name: "", root: block("t1") }] }] };
    const snapshot = buildSnapshot([
      terminal("t1"),
      terminal("t2", { labels: { "herdr.space": "s1", "herdr.tab": "ovis-tb", "ovis.tab": "logs" } }),
      terminal("t3", { cwd: "/work/web", labels: { "herdr.space": "ovis-s9", "herdr.tab": "ovis-tc", "ovis.workspace": "web stuff" } }),
      terminal("t4", { labels: { "herdr.space": "ovis-s9", "herdr.tab": "ovis-tc" } }),
      terminal("t5", { cwd: "/srv/db", labels: { "herdr.space": "ovis-s7" } }),
      terminal("t6"),
    ], layout, "0.1.14");
    expect(snapshot.workspaces.map((w) => [w.workspace_id, w.label])).toEqual([["s1", "api"], ["ovis-s9", "web stuff"], ["ovis-s7", "db"], [OTHER_WORKSPACE_ID, "Other terminals"]]);
    expect(snapshot.tabs.map((t) => [t.tab_id, t.workspace_id, t.label])).toEqual([
      ["s1t1", "s1", "1"], ["ovis-tb", "s1", "logs"], ["ovis-tc", "ovis-s9", "1"], ["ovis-s7:t5", "ovis-s7", "1"], [`${OTHER_WORKSPACE_ID}:t6`, OTHER_WORKSPACE_ID, "t6"],
    ]);
    expect(snapshot.panes.filter((p) => p.tab_id === "ovis-tc").map((p) => p.pane_id)).toEqual(["t3", "t4"]);
  });

  it("never makes one tab of two: a labeled id the app uses elsewhere gets an id of its own", () => {
    const layout = { spaces: [
      { id: "s1", name: "a", tabs: [{ id: "T", name: "", root: block("t1") }] },
      { id: "s2", name: "b", tabs: [{ id: "s2t1", name: "", root: block("t2") }] },
    ] };
    const snapshot = buildSnapshot([
      terminal("t1"), terminal("t2"),
      terminal("t3", { labels: { "herdr.space": "s2", "herdr.tab": "T" } }),
      terminal("t4", { labels: { "herdr.space": "s2t1" } }),
    ], layout, "0.1.14");
    expect(snapshot.panes.find((p) => p.pane_id === "t3")).toMatchObject({ workspace_id: "s2", tab_id: "s2:t3" });
    expect(snapshot.panes.filter((p) => p.tab_id === "T").map((p) => p.pane_id)).toEqual(["t1"]);
    // a space id that is the app's tab id is no space: the terminal is one of the others
    expect(snapshot.panes.find((p) => p.pane_id === "t4")!.workspace_id).toBe(OTHER_WORKSPACE_ID);
  });

  it("puts a labeled terminal in the app's space and tab even when nothing else there is live, so adoption keeps its ids", () => {
    // the app's document still names space S and its tab T, whose own terminal is gone
    const layout = { spaces: [{ id: "S", name: "work", tabs: [{ id: "T", name: "main", root: { type: "block", id: "b", content: { terminal: "t1" } } }] }] };
    const snapshot = buildSnapshot([terminal("t5", { labels: { "herdr.space": "S", "herdr.tab": "T" } })], layout, "0.1.14");
    const pane = snapshot.panes.find((p) => p.pane_id === "t5")!;
    expect([pane.workspace_id, pane.tab_id]).toEqual(["S", "T"]);
    expect(snapshot.workspaces.find((w) => w.workspace_id === "S")!.label).toBe("work");
    expect(snapshot.tabs.find((t) => t.tab_id === "T")!.label).toBe("main");
  });

  it("never reuses an id the app's document holds for a terminal's own tab", () => {
    // space S has nothing live; another space's live tab is called "S:t5", the id t5's own tab would get
    const layout = { spaces: [
      { id: "S", name: "", tabs: [] },
      { id: "O", name: "other", tabs: [{ id: "S:t5", name: "", root: { type: "block", id: "b", content: { terminal: "t1" } } }] },
    ] };
    const snapshot = buildSnapshot([terminal("t1"), terminal("t5", { labels: { "herdr.space": "S" } })], layout, "0.1.14");
    const tabIds = snapshot.tabs.map((t) => t.tab_id);
    expect(new Set(tabIds).size).toBe(tabIds.length);
    expect(snapshot.panes.find((p) => p.pane_id === "t5")!.workspace_id).toBe("S");
  });

  it("names an unnamed space and tab of the app's after the terminal it gets, as after adoption", () => {
    const layout = { spaces: [{ id: "S", name: "", folder: "/srv/site", tabs: [{ id: "T", name: "", root: { type: "block", id: "b", content: { terminal: "t1" } } }] }] };
    const snapshot = buildSnapshot([terminal("t5", { labels: { "herdr.space": "S", "herdr.tab": "T", "ovis.workspace": "Web", "ovis.tab": "Logs" } })], layout, "0.1.14");
    expect([snapshot.workspaces[0]!.label, snapshot.tabs[0]!.label]).toEqual(["Web", "Logs"]);
  });

  it("names an unnamed space and tab of the app's from the app's own `where` label first", () => {
    const layout = { spaces: [{ id: "S", name: "", tabs: [{ id: "T", name: "", root: { type: "block", id: "b", content: { terminal: "t1" } } }] }] };
    const snapshot = buildSnapshot([terminal("t5", { labels: { "herdr.space": "S", "herdr.tab": "T", where: "Work / Logs", "ovis.workspace": "Web", "ovis.tab": "Tail" } })], layout, "0.1.14");
    expect([snapshot.workspaces[0]!.label, snapshot.tabs[0]!.label]).toEqual(["Work", "Logs"]);
  });

  it("shows no space or tab of the app's with nothing live in it", () => {
    const layout = { spaces: [{ id: "S", name: "work", tabs: [{ id: "T", name: "main", root: { type: "block", id: "b", content: { terminal: "t1" } } }] }] };
    const snapshot = buildSnapshot([], layout, "0.1.14");
    expect([snapshot.workspaces, snapshot.tabs]).toEqual([[], []]);
  });

  it("never gives a workspace and a tab the same id, even when only labels made them", () => {
    const snapshot = buildSnapshot([
      terminal("t1", { labels: { "herdr.space": "S", "herdr.tab": "T" } }),
      terminal("t2", { labels: { "herdr.space": "X", "herdr.tab": "S" } }),
      terminal("t3", { labels: { "herdr.space": "T" } }),
      terminal("t4", { labels: { "herdr.space": "Y", "herdr.tab": "T" } }),
    ], null, "0.1.14");
    const workspaceIds = snapshot.workspaces.map((w) => w.workspace_id);
    const tabIds = snapshot.tabs.map((t) => t.tab_id);
    expect(workspaceIds.filter((id) => tabIds.includes(id))).toEqual([]);
    expect(snapshot.panes.find((p) => p.pane_id === "t2")!.tab_id).toBe("X:t2");
    // a tab label used in another space: a tab of its own, never one tab in two spaces
    expect(snapshot.panes.find((p) => p.pane_id === "t4")!.tab_id).toBe("Y:t4");
    expect(new Set(tabIds).size).toBe(tabIds.length);
  });

  it("puts a second unplaced terminal of a tab beside the first, not over it", () => {
    const snapshot = buildSnapshot([
      terminal("t1", { cols: 80, labels: { "herdr.space": "ovis-s", "herdr.tab": "ovis-t" } }),
      terminal("t2", { cols: 60, labels: { "herdr.space": "ovis-s", "herdr.tab": "ovis-t" } }),
    ], null, "0.1.14");
    expect(snapshot.layouts[0]!.panes.map((p) => [p.pane_id, p.rect.x])).toEqual([["t1", 0], ["t2", 81]]);
  });

  it("keeps the name a person gave once the app adopts the terminal into an unnamed space and tab", () => {
    const layout = { spaces: [{ id: "ovis-s", name: "", tabs: [{ id: "ovis-t", name: "", root: block("t1") }] }] };
    const snapshot = buildSnapshot([terminal("t1", { labels: { "herdr.space": "ovis-s", "herdr.tab": "ovis-t", "ovis.workspace": "web", "ovis.tab": "logs" } }), terminal("t2", { labels: { "ovis.tab": "scratch" } })], layout, "0.1.14");
    expect(snapshot.workspaces[0]!.label).toBe("web");
    expect(snapshot.tabs.map((t) => t.label)).toEqual(["logs", "scratch"]);
  });
});

describe("buildSnapshot, what herdr-core reports beyond placement", () => {
  it("puts a terminal another one started right after its parent's tab, a helper's helper after it, and keeps the rest with the other terminals", () => {
    const layout = { spaces: [{ id: "s1", name: "web", tabs: [
      { id: "s1t1", name: "main", root: block("t1") },
      { id: "s1t2", name: "logs", root: block("t2") },
    ] }] };
    const snapshot = buildSnapshot([
      terminal("t1"), terminal("t2"),
      terminal("t3", { parent: "t1", name: "tests" }),
      terminal("t4", { parent: "t1" }),
      terminal("t5", { parent: "t3" }),
      // a parent that has finished, or none: as before
      terminal("t6", { parent: "t9" }),
      terminal("t7", { parent: null }),
    ], layout, "0.1.17");
    expect(snapshot.tabs.map((t) => [t.tab_id, t.workspace_id, t.label])).toEqual([
      ["s1t1", "s1", "main"], ["s1:t3", "s1", "tests"], ["s1:t5", "s1", "t5"], ["s1:t4", "s1", "t4"], ["s1t2", "s1", "logs"],
      [`${OTHER_WORKSPACE_ID}:t6`, OTHER_WORKSPACE_ID, "t6"], [`${OTHER_WORKSPACE_ID}:t7`, OTHER_WORKSPACE_ID, "t7"],
    ]);
    expect(snapshot.panes.map((p) => [p.pane_id, (p as HerdrPane).parent_pane_id])).toEqual([
      ["t1", undefined], ["t3", "t1"], ["t5", "t3"], ["t4", "t1"], ["t2", undefined], ["t6", undefined], ["t7", undefined],
    ]);
  });

  it("keeps a helper of a terminal under Other terminals right after it there", () => {
    const snapshot = buildSnapshot([terminal("t1"), terminal("t2"), terminal("t3", { parent: "t1" })], null, "0.1.17");
    expect(snapshot.tabs.map((t) => t.tab_id)).toEqual([`${OTHER_WORKSPACE_ID}:t1`, `${OTHER_WORKSPACE_ID}:t3`, `${OTHER_WORKSPACE_ID}:t2`]);
    expect((snapshot.panes.find((p) => p.pane_id === "t3") as HerdrPane).parent_pane_id).toBe("t1");
  });

  it("leaves a terminal the app placed where the app put it, and names its parent", () => {
    const layout = { spaces: [{ id: "s1", name: "web", tabs: [{ id: "s1t1", name: "", root: block("t1") }, { id: "s1t2", name: "", root: block("t2") }] }] };
    const snapshot = buildSnapshot([terminal("t1"), terminal("t2", { parent: "t1" })], layout, "0.1.17");
    expect(snapshot.panes.map((p) => [p.pane_id, p.tab_id, (p as HerdrPane).parent_pane_id])).toEqual([["t1", "s1t1", undefined], ["t2", "s1t2", "t1"]]);
  });

  it("shows no terminal of another hc machine, labeled, placed or neither, as this PC's (#2768)", () => {
    const layout = { spaces: [{ id: "s1", name: "here", tabs: [{ id: "s1t1", name: "", root: { type: "row", id: "r", children: [block("t1"), block("vps/t2")] } }] }] };
    const snapshot = buildSnapshot([
      terminal("t1"),
      terminal("vps/t2"),
      terminal("vps/t14", { labels: { "herdr.space": "spcRemote", "herdr.tab": "tbRemote", where: "ubuntu / 1" } }),
      terminal("vps/t15"),
      terminal("t3", { parent: "vps/t14" }),
    ], layout, "0.1.17");
    expect(snapshot.workspaces.map((w) => [w.workspace_id, w.label])).toEqual([["s1", "here"], [OTHER_WORKSPACE_ID, "Other terminals"]]);
    expect(snapshot.panes.map((p) => [p.pane_id, p.tab_id, (p as HerdrPane).parent_pane_id])).toEqual([["t1", "s1t1", undefined], ["t3", `${OTHER_WORKSPACE_ID}:t3`, undefined]]);
  });

  it("carries a blocked agent's kind, its message as written and its progress, and only what it reported", () => {
    const snapshot = buildSnapshot([
      terminal("t1", { status: { app: "codex", state: "blocked", kind: "permission", msg: "Allow bash?", progress: 40 } }),
      // kind belongs to blocked alone; a progress outside 0..100 or a blank message is no report
      terminal("t2", { status: { app: "claude", state: "working", kind: "question", msg: "  ", progress: 150 } }),
      terminal("t3", { status: { app: "claude", state: "working", progress: 0 } }),
      // an agent at rest has no progress left, whatever it last said
      terminal("t4", { status: { app: "claude", state: "idle", progress: 90, msg: "Done reading" } }),
      terminal("t5"),
    ], null, "0.1.17");
    const facts = snapshot.panes.map((p) => { const pane = p as HerdrPane; return [pane.pane_id, pane.agent_kind, pane.agent_message, pane.agent_progress]; });
    expect(facts).toEqual([
      ["t1", "permission", "Allow bash?", 40],
      ["t2", undefined, undefined, undefined],
      ["t3", undefined, undefined, 0],
      ["t4", undefined, undefined, undefined],
      ["t5", undefined, undefined, undefined],
    ]);
  });
});

describe("keyBytes", () => {
  it("types printable characters, Enter, Tab, Backspace, and Alt or Shift on a character hc has no key for; leaves the rest to hc's encoder", () => {
    expect(["x", "A", "한", " ", "Enter", "tab", "Backspace", "plus", "shift+plus", "alt+|", "alt+shift+plus"].map(keyBytes))
      .toEqual(["x", "A", "한", " ", "\r", "\t", "\x7f", "+", "+", "\x1b|", "\x1b+"]);
    for (const key of ["\x7f", "\x1b", "esc", "Up", "ctrl+enter", "shift+tab", "ctrl+c", "C-d", "alt+x", "ctrl+|", "constructor", "ctrl+alt+shift+left"]) expect(keyBytes(key)).toBeNull();
  });
});
