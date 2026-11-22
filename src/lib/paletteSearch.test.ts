import { describe, expect, it } from "bun:test";

import type { HerdrPane, PluginActions, TabInfo, WorkspaceInfo } from "../../shared/protocol.ts";
import { translate } from "./i18n.ts";
import { filterPanesByStatus, groupByWorkspace, offeredPluginActions, parseQuery, rankPanes, recentPanes, statusCounts } from "./paletteSearch.ts";

function pane(paneId: string, fields: Partial<HerdrPane> = {}): HerdrPane {
  return {
    pane_id: paneId,
    workspace_id: "w1",
    tab_id: "t1",
    terminal_id: `term-${paneId}`,
    agent_status: "idle",
    focused: false,
    revision: 1,
    ...fields,
  };
}

const workspaces = [
  { workspace_id: "w1", label: "Frontend", active_tab_id: "t1", agent_status: "idle", focused: false, number: 1, pane_count: 2, tab_count: 1 },
  { workspace_id: "w2", label: "Backend", active_tab_id: "t2", agent_status: "working", focused: false, number: 2, pane_count: 1, tab_count: 1 },
] satisfies WorkspaceInfo[];

const tabs = [
  { tab_id: "t1", workspace_id: "w1", label: "Editing", number: 1, agent_status: "idle", focused: false, pane_count: 2 },
  { tab_id: "t2", workspace_id: "w2", label: "Reviewing", number: 1, agent_status: "working", focused: false, pane_count: 1 },
] satisfies TabInfo[];

const panes = [
  pane("alpha", { label: "Dashboard", cwd: "/work/client", agent: "claude" }),
  pane("beta", { label: "Database migration", cwd: "/work/server", agent: "codex", workspace_id: "w2", tab_id: "t2" }),
  pane("gamma", { title: "Shell", cwd: "/work/frontend-tools" }),
];

const ids = (list: readonly HerdrPane[]): string[] => list.map((item) => item.pane_id);

describe("rankPanes", () => {
  it("keeps session order for an empty query", () => {
    expect(ids(rankPanes("  ", panes, workspaces))).toEqual(["alpha", "beta", "gamma"]);
  });

  it("searches title, cwd, workspace and agent metadata", () => {
    expect(ids(rankPanes("migration", panes, workspaces))).toEqual(["beta"]);
    expect(ids(rankPanes("server", panes, workspaces))).toEqual(["beta"]);
    expect(ids(rankPanes("backend", panes, workspaces))).toEqual(["beta"]);
    expect(ids(rankPanes("claude", panes, workspaces))).toEqual(["alpha"]);
  });

  it("supports ordered fuzzy characters and ranks a direct match first", () => {
    expect(ids(rankPanes("dsh", panes, workspaces))).toEqual(["alpha"]);
    expect(ids(rankPanes("front", panes, workspaces))).toEqual(["alpha", "gamma"]);
    expect(rankPanes("zzq", panes, workspaces)).toEqual([]);
  });

  it("finds a pane by its tab's label", () => {
    expect(ids(rankPanes("reviewing", panes, workspaces, { tabs }))).toEqual(["beta"]);
    expect(ids(rankPanes("editing", panes, workspaces, { tabs }))).toEqual(["alpha", "gamma"]);
    expect(rankPanes("reviewing", panes, workspaces)).toEqual([]);
  });

  it("finds a pane by the name the UI gives a tab herdr still numbers, in the user's language too", () => {
    // herdr names a tab by its place ("2") until it is renamed; the strip and the footer say "Tab 2"
    const numbered = [
      { ...tabs[0]!, label: "1" },
      { tab_id: "t1b", workspace_id: "w1", label: "2", number: 2, agent_status: "idle", focused: false, pane_count: 1 },
      { ...tabs[1]!, label: "1" },
    ] satisfies TabInfo[];
    const roster = [...panes, pane("delta", { label: "Logs", tab_id: "t1b" })];
    expect(ids(rankPanes("Tab 2", roster, workspaces, { tabs: numbered }))).toEqual(["delta"]);
    expect(ids(rankPanes("탭 2", roster, workspaces, { tabs: numbered, t: (key, vars) => translate("ko", key, vars) }))).toEqual(["delta"]);
    expect(ids(rankPanes("탭 2", roster, workspaces, { tabs: numbered }))).toEqual([]);
    expect(ids(rankPanes("2", roster, workspaces, { tabs: numbered }))).toContain("delta");
    expect(ids(rankPanes("Tab 2", roster, workspaces, { tabs }))).toEqual([]);
  });

  it("finds a pane by its workspace's branch", () => {
    const branches = new Map([["w2", { branch: "feat/palette-goto-filters" }], ["w1", { branch: null }]]);
    expect(ids(rankPanes("goto-filters", panes, workspaces, { branches }))).toEqual(["beta"]);
    expect(ids(rankPanes("feat/pal", panes, workspaces, { branches }))).toEqual(["beta"]);
    expect(rankPanes("goto-filters", panes, workspaces)).toEqual([]);
  });

  it("finds a pane by any part of its path and by the agent kind herdr shows", () => {
    const shown = [...panes, pane("delta", { agent: "omo", display_agent: "OmO", foreground_cwd: "/home/me/repos/herdr-web-ui/server", workspace_id: "w2", tab_id: "t2" })];
    expect(ids(rankPanes("/work/", shown, workspaces))).toEqual(["alpha", "beta", "gamma"]);
    expect(ids(rankPanes("repos/herdr", shown, workspaces))).toEqual(["delta"]);
    expect(ids(rankPanes("omo", shown, workspaces))).toEqual(["delta"]);
  });
});

describe("parseQuery", () => {
  it("reads a leading > as actions only and searches the rest", () => {
    expect(parseQuery(">")).toEqual({ actionsOnly: true, text: "" });
    expect(parseQuery("  > set")).toEqual({ actionsOnly: true, text: "set" });
    expect(parseQuery(">theme ")).toEqual({ actionsOnly: true, text: "theme" });
  });

  it("leaves any other query to the panes and the actions", () => {
    expect(parseQuery(" dash ")).toEqual({ actionsOnly: false, text: "dash" });
    expect(parseQuery("a > b")).toEqual({ actionsOnly: false, text: "a > b" });
  });
});

describe("filterPanesByStatus", () => {
  const roster = [
    pane("ready"),
    pane("busy", { agent_status: "working" }),
    pane("asks", { agent_status: "blocked" }),
    pane("finished", { agent_status: "done" }),
    pane("background", { agent_status: "done", background_wait: true }),
    pane("background-ready", { agent_status: "idle", background_wait: true }),
    pane("odd", { agent_status: "compacting" }),
  ];

  it("keeps every pane in order for All", () => {
    expect(ids(filterPanesByStatus(roster, "all"))).toEqual(ids(roster));
  });

  it("keeps the panes in one status, read as the sidebar reads them", () => {
    expect(ids(filterPanesByStatus(roster, "idle"))).toEqual(["ready"]);
    expect(ids(filterPanesByStatus(roster, "working"))).toEqual(["busy"]);
    expect(ids(filterPanesByStatus(roster, "blocked"))).toEqual(["asks"]);
    expect(ids(filterPanesByStatus(roster, "done"))).toEqual(["finished"]);
  });

  it("files a pane at rest with background work still running under BG, not under its raw status", () => {
    expect(ids(filterPanesByStatus(roster, "waiting"))).toEqual(["background", "background-ready"]);
    expect(ids(filterPanesByStatus([pane("running", { agent_status: "working", background_wait: true })], "waiting"))).toEqual([]);
  });

  it("counts the whole roster for the chips, an unknown status only under All", () => {
    expect(statusCounts(roster)).toEqual({ all: 7, blocked: 1, working: 1, idle: 1, done: 1, waiting: 2 });
    expect(statusCounts([])).toEqual({ all: 0, blocked: 0, working: 0, idle: 0, done: 0, waiting: 0 });
  });
});

describe("groupByWorkspace", () => {
  const roster = [
    pane("a1", { label: "alpha one" }),
    pane("b1", { label: "one", workspace_id: "w2", tab_id: "t2" }),
    pane("a2", { label: "alpha two one" }),
    pane("orphan", { label: "nine", workspace_id: "w9", tab_id: "t9" }),
  ];

  it("makes one section per workspace in session order, rows in their order inside it", () => {
    const sections = groupByWorkspace(roster, workspaces);
    expect(sections.map((section) => [section.workspaceId, section.workspace?.label, ids(section.panes)])).toEqual([
      ["w1", "Frontend", ["a1", "a2"]],
      ["w2", "Backend", ["b1"]],
      ["w9", undefined, ["orphan"]],
    ]);
  });

  it("follows the workspaces' order for an unsearched list, as a move in the roster leaves it", () => {
    // workspace.move reorders the workspaces alone; the panes keep the order they came in
    const moved = [workspaces[1]!, workspaces[0]!];
    expect(groupByWorkspace(roster, moved).map((section) => [section.workspaceId, ids(section.panes)])).toEqual([
      ["w2", ["b1"]],
      ["w1", ["a1", "a2"]],
      ["w9", ["orphan"]],
    ]);
  });

  it("puts the best match's workspace first for a ranked list and keeps the rank inside a section", () => {
    const ranked = rankPanes("one", roster, workspaces);
    expect(ids(ranked)).toEqual(["b1", "a1", "a2"]);
    expect(groupByWorkspace(ranked, workspaces, true).map((section) => [section.workspaceId, ids(section.panes)])).toEqual([
      ["w2", ["b1"]],
      ["w1", ["a1", "a2"]],
    ]);
    expect(groupByWorkspace(ranked, [workspaces[0]!, workspaces[1]!], true).map((section) => section.workspaceId)).toEqual(["w2", "w1"]);
  });

  it("has no sections without panes", () => {
    expect(groupByWorkspace([], workspaces)).toEqual([]);
  });
});

describe("recentPanes", () => {
  it("lists the remembered panes newest first, without the open one or a closed one, up to the limit", () => {
    expect(ids(recentPanes(panes, ["gamma", "closed", "alpha", "beta"], "alpha", 3))).toEqual(["gamma", "beta"]);
    expect(ids(recentPanes(panes, ["gamma", "beta", "alpha"], null, 2))).toEqual(["gamma", "beta"]);
    expect(recentPanes(panes, [], null, 3)).toEqual([]);
  });
});

const plugin = (overrides: Partial<PluginActions>): PluginActions => ({ plugin_id: "example.layout", name: "Layout", version: "0.1.0", description: null, enabled: true, actions: [], ...overrides });
const action = (action_id: string, contexts: string[], title = action_id) => ({ action_id, title, description: null, contexts });
const offeredIds = (offered: ReturnType<typeof offeredPluginActions>) => offered.map(({ plugin: owner, action: entry }) => `${owner.plugin_id}.${entry.action_id}`);

describe("offeredPluginActions", () => {
  const plugins = [
    plugin({ actions: [action("apply", ["workspace"], "Apply layout"), action("anywhere", ["global"]), action("bare", []), action("quote", ["selection"]), action("pane-or-text", ["pane", "selection"])] }),
    plugin({ plugin_id: "example.off", name: "Off", enabled: false, actions: [action("hidden", ["global"])] }),
  ];

  it("offers what applies to the selected pane and leaves out a disabled plugin and a selection-only action", () => {
    expect(offeredIds(offeredPluginActions(plugins, true, ""))).toEqual(["example.layout.apply", "example.layout.anywhere", "example.layout.bare", "example.layout.pane-or-text"]);
  });

  it("offers only an action that needs no place when no pane is selected", () => {
    expect(offeredIds(offeredPluginActions(plugins, false, ""))).toEqual(["example.layout.anywhere", "example.layout.bare"]);
  });

  it("searches the action's title and its plugin's name", () => {
    expect(offeredIds(offeredPluginActions(plugins, true, " APPLY "))).toEqual(["example.layout.apply"]);
    expect(offeredIds(offeredPluginActions(plugins, true, "layout")).length).toBe(4);
    expect(offeredPluginActions(plugins, true, "nothing like it")).toEqual([]);
  });
});
