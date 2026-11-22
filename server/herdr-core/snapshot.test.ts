import { describe, expect, it } from "bun:test";
import type { HerdrPane } from "../../shared/protocol.ts";
import type { ProgramPlatform } from "../agent-identity.ts";
import { agentOf, buildSnapshot, type HcTerminal, keyBytes, opencodeRecords, OTHER_WORKSPACE_ID, terminalPlatform } from "./snapshot.ts";

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
      resting("t6", "idle", 3),
      resting("t7", "done", 3, { "herdr.seen": "x" }),
      terminal("t8", { turn: 0, labels: { "herdr.seen": "0" } }),
    ], { spaces: [] }, "0.1.17");
    expect(snapshot.panes.map((pane) => [pane.pane_id, pane.agent_status])).toEqual([
      ["t1", "done"], ["t2", "idle"], ["t3", "idle"], ["t4", "working"], ["t5", "blocked"], ["t6", "idle"], ["t7", "done"], ["t8", "unknown"],
    ]);
    const since = buildSnapshot([resting("t6", "idle", 3), resting("t9", "idle", 2)], { spaces: [] }, "0.1.17", () => 2);
    expect(since.panes.map((pane) => [pane.pane_id, pane.agent_status])).toEqual([["t6", "done"], ["t9", "idle"]]);
  });

  it("names an unnamed space and tab as the app labels their terminals", () => {
    const layout = { spaces: [{ id: "s1", name: "", tabs: [{ id: "s1t1", name: "", root: block("t1") }] }] };
    const snapshot = buildSnapshot([terminal("t1", { labels: { where: "tmp / 3" } })], layout, "0.1.14");
    expect(snapshot.workspaces[0]!.label).toBe("tmp");
    expect(snapshot.tabs[0]!.label).toBe("3");
  });

  const named = (cwd: string, folder?: string) => buildSnapshot([terminal("t1", { cwd })], {
    spaces: [{ id: "s1", name: "", ...(folder === undefined ? {} : { folder }), tabs: [{ id: "s1t1", name: "", root: block("t1") }] }],
  }, "0.1.17").workspaces[0]!.label;

  it("names a space with nothing else to go by after the last folder of a Windows path", () => {
    expect(named("C:\\repos\\ovis-app")).toBe("ovis-app");
    expect(named("C:\\repos\\ovis-app\\")).toBe("ovis-app");
    expect(named("C:/repos\\ovis-app")).toBe("ovis-app");
    expect(named("c:\\work\\web")).toBe("web");
    expect(named("\\\\server\\share\\site")).toBe("site");
    expect(named("/home/u", "D:\\work\\web\\")).toBe("web");
    const unplaced = buildSnapshot([terminal("t2", { cwd: "C:\\Users\\u\\api", labels: { "herdr.space": "ovis-s1" } })], null, "0.1.17");
    expect(unplaced.workspaces.map((w) => [w.workspace_id, w.label])).toEqual([["ovis-s1", "api"]]);
    const adopted = (folder?: string) => buildSnapshot([terminal("t5", { cwd: "C:\\Users\\u\\api", labels: { "herdr.space": "s1" } })], {
      spaces: [{ id: "s1", name: "", ...(folder === undefined ? {} : { folder }), tabs: [{ id: "s1t1", name: "", root: block("t1") }] }],
    }, "0.1.17").workspaces[0]!.label;
    expect(adopted("D:\\work\\web")).toBe("web");
    expect(adopted()).toBe("api");
  });

  it("keeps a POSIX folder's name whole, backslash and all, and a forward-slash Windows path's as before", () => {
    expect(named("/home/u/back\\slash")).toBe("back\\slash");
    expect(named("/home/u/back\\slash/")).toBe("back\\slash");
    expect(named("/mnt/c:\\work")).toBe("c:\\work");
    expect(named("/mnt/c:/")).toBe("c:");
    expect(named("/home//u/")).toBe("u");
    expect(named("/")).toBe("/");
    expect(named("d:/work/web")).toBe("web");
    expect(named("\\foo\\bar")).toBe("\\foo\\bar");
    expect(named("C:foo\\bar")).toBe("C:foo\\bar");
  });

  it("leaves a drive root as written, so it still reads as a place", () => {
    expect(named("C:\\")).toBe("C:\\");
    expect(named("C:/")).toBe("C:/");
    expect(named("\\\\?\\C:\\")).toBe("\\\\?\\C:\\");
    expect(named("\\\\?\\C:\\repos\\ovis-app")).toBe("ovis-app");
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

  // hc 0.1.17 records on old-desktop, 2026-11-08: Letta Code and Devin send no OSC 7501, Grok Build reports `grok-build`
  it("names an agent that reports nothing from the process in front, and Grok Build as herdr's grok", () => {
    const snapshot = buildSnapshot([
      terminal("t1", { argv: ["bash"], status: null, foreground: { pid: 11, name: "node", argv: ["node", "/home/u/npm/node_modules/.bin/letta", "--backend", "local"] } }),
      terminal("t2", { argv: ["bash"], foreground: { pid: 21, name: "devin", argv: ["devin"] } }),
      terminal("t3", { argv: ["bash"], status: { app: "grok-build", state: "blocked", kind: "auth" }, foreground: { pid: 31, name: "grok", argv: ["grok"] } }),
      terminal("t4", { argv: ["bash"], foreground: { pid: 41, name: "bash", argv: ["bash"] } }),
    ], { spaces: [] }, "0.1.17");
    expect(snapshot.panes.map((p) => [p.pane_id, p.agent, p.agent_status])).toEqual([["t1", "letta", "unknown"], ["t2", "devin", "unknown"], ["t3", "grok", "blocked"], ["t4", null, "unknown"]]);
    expect(snapshot.agents.map((a) => [a.pane_id, a.agent])).toEqual([["t1", "letta"], ["t2", "devin"], ["t3", "grok"]]);
  });

  // hc names no platform, and a terminal may be another machine's (machine-scope.ts) (#3319)
  it("takes a terminal's platform as this PC's on its own core, and by its folder's shape on another machine", () => {
    for (const here of ["linux", "macos", "windows", null] as const) expect(terminalPlatform("C:\\Users\\u", here)).toBe(here);
    // `//server/share` is a share to Windows and a root to POSIX: either; WSL's `/mnt/c` is Linux's
    const shapes: Record<string, ProgramPlatform> = { "C:\\Users\\u": "windows", "c:/work": "windows", "\\\\server\\share\\x": "windows", "\\\\?\\C:\\work": "windows", "//server/share": null, "/mnt/c/Users/u": "posix", "/home/u": "posix", "": null, "work": null, "~": null };
    expect(Object.keys(shapes).map((cwd) => terminalPlatform(cwd, "elsewhere"))).toEqual(Object.values(shapes));
    expect(terminalPlatform(undefined, "elsewhere")).toBeNull();
  });

  it("names another machine's process in front by that machine's platform, and nothing a platform decides when its folder tells none", () => {
    const front = (argv: string[], cwd?: string) => ({ status: null, foreground: { pid: 11, name: argv[0]!, argv, ...(cwd === undefined ? {} : { cwd }) } });
    expect(agentOf({ cwd: "C:\\Users\\u", ...front(["C:\\Users\\u\\letta.cmd"]) }, "elsewhere")).toBe("letta");
    expect(agentOf({ cwd: "/home/u", ...front(["/home/u/.local/bin/cmd"]) }, "elsewhere")).toBe("cmd");
    expect(agentOf({ cwd: "C:\\Users\\u", ...front(["C:\\Windows\\System32\\cmd.exe"]) }, "elsewhere")).toBeNull();
    expect(agentOf({ cwd: "", ...front(["letta.cmd"], "C:\\Users\\u") }, "elsewhere")).toBe("letta");
    for (const argv of [["cmd"], ["letta.cmd"]]) expect(agentOf({ cwd: "", ...front(argv) }, "elsewhere")).toBeNull();
    expect(agentOf(front(["claude"]), "elsewhere")).toBe("claude");
    expect(agentOf({ cwd: "C:\\Users\\u", ...front(["cmd"]) }, "linux")).toBe("cmd");
  });

  // hc tells a terminal's own pid and the pid in front of it, never a process start (#3319 review)
  it("names a terminal started directly as an agent while the process it started is still in front, and none a shell started", () => {
    const started = (argv: string[], cwd: string, front: string | null = null) => ({ status: null, pid: 7, foreground: { pid: 7, name: front ?? "", argv: front ? [front] : [] }, argv, cwd });
    expect(agentOf(started(["C:\\Users\\u\\letta.cmd"], "C:\\Users\\u"), "windows")).toBe("letta");
    expect(agentOf(started(["C:\\Users\\u\\letta.cmd"], "C:\\Users\\u"), "elsewhere")).toBe("letta");
    expect(agentOf(started(["node", "/home/u/.bin/letta"], "/home/u"), "linux")).toBe("letta");
    // a program the core names in front wins, even as the start's pid: a claude start that exec()ed bash is bash
    expect(agentOf(started(["claude"], "/home/u", "bash"), "linux")).toBeNull();
    expect(agentOf(started(["C:\\Users\\u\\letta.cmd"], "C:\\Users\\u", "cmd.exe"), "windows")).toBeNull();
    for (const argv of [["cmd.exe", "/c", "letta.cmd"], ["pwsh", "-c", "letta"]]) expect(agentOf(started(argv, "C:\\Users\\u", "cmd.exe"), "windows")).toBeNull();
    expect(agentOf(started(["bash", "-lc", "letta"], "/home/u"), "linux")).toBeNull();
    expect(agentOf({ status: null, pid: 7, argv: ["claude"], cwd: "/home/u", foreground: { pid: 9, name: "codex", argv: ["codex"] } }, "linux")).toBe("codex");
    expect(agentOf({ status: null, pid: 7, argv: ["claude"], cwd: "/home/u", foreground: { pid: 9, name: "bash", argv: ["bash"] } }, "linux")).toBeNull();
    expect(agentOf({ status: null, pid: 7, argv: ["letta"], cwd: "/home/u", foreground: null }, "linux")).toBeNull();
    expect(agentOf({ status: null, argv: ["letta"], cwd: "/home/u", foreground: { pid: 9, name: "bash", argv: ["bash"] } }, "linux")).toBeNull();
  });

  it("cuts the tab top down by the app's tree and weights, whatever size the terminals are, with a divider per split", () => {
    const weighted = { ...block("t1"), size: { weight: 3 } };
    const layout = { spaces: [{ id: "s1", name: "a", tabs: [{ id: "s1t1", name: "", root: { type: "row", id: "r", children: [weighted, { type: "column", id: "c", children: [block("t2"), block("t3")] }] } }] }] };
    const snapshot = buildSnapshot([terminal("t1", { cols: 80, rows: 49 }), terminal("t2", { cols: 60, rows: 1 }), terminal("t3", { cols: 60, rows: 24 })], layout, "0.1.14");
    const tab = snapshot.layouts[0]!;
    expect(tab.panes.map((pane) => [pane.pane_id, pane.rect])).toEqual([
      ["t1", { x: 0, y: 0, width: 750, height: 1000 }],
      ["t2", { x: 750, y: 0, width: 250, height: 500 }],
      ["t3", { x: 750, y: 500, width: 250, height: 500 }],
    ]);
    expect(tab.area).toEqual({ x: 0, y: 0, width: 1000, height: 1000 });
    expect(tab.splits.map((split) => [split.id, split.direction, split.ratio])).toEqual([["split_0_root", "right", 0.75], ["split_1_1", "down", 0.5]]);
  });

  it("gives a pane the app sizes in pixels its pixels of the tab, and the weighted ones what is left", () => {
    const heights = (children: unknown[], type = "column", count = children.length) => buildSnapshot(
      Array.from({ length: count }, (_, index) => terminal(`t${index + 1}`)),
      { spaces: [{ id: "s1", name: "a", tabs: [{ id: "s1t1", name: "", root: { type, id: "r", children } }] }] }, "0.1.17",
    ).layouts[0]!.panes.map((pane) => type === "column" ? pane.rect.height : pane.rect.width);
    const sized = (address: string, size: unknown) => ({ ...block(address), size });
    expect(heights([block("t1"), sized("t2", { px: 200 })])).toEqual([800, 200]);
    expect(heights([sized("t1", { weight: 0.5 }), sized("t2", { px: 200 })])).toEqual([800, 200]);
    expect(heights([sized("t1", { weight: 1 }), sized("t2", { px: 300 }), sized("t3", { weight: 3 })], "row")).toEqual([175, 300, 525]);
    expect(heights([sized("t1", { px: 100 }), sized("t2", { px: 300 })])).toEqual([250, 750]);
    const nested = { type: "row", id: "n", children: [{ type: "column", id: "c", children: [block("t2"), sized("t3", { px: 200 })] }, block("t4")] };
    expect(heights([block("t1"), nested], "column", 4)).toEqual([500, 300, 200, 500]);
    expect(heights([block("t9"), { type: "column", id: "c", children: [block("t1"), sized("t2", { px: 200 })] }])).toEqual([800, 200]);
    const squeezed = { type: "column", id: "c", children: [sized("t2", { px: 100 }), block("t3")] };
    expect(heights([sized("t1", { px: 1200 }), squeezed], "column", 3)).toEqual([900, 90, 10]);
    expect(heights([sized("t1", { px: 1200 }), block("t2"), block("t3")], "row")).toEqual([900, 50, 50]);
  });

  it("shows every child of a stack and a hidden node in the app's tab, once, as Ovis can neither switch nor show them", () => {
    const hidden = { ...block("t3"), hidden: true };
    const layout = { spaces: [{ id: "s1", name: "a", tabs: [{ id: "s1t1", name: "", root: { type: "row", id: "r", children: [
      { type: "stack", id: "st", active: "p-t2", children: [block("t1"), block("t2")] }, hidden, block("t4"),
    ] } }] }] };
    for (const labels of [undefined, { "herdr.space": "s1", "herdr.tab": "s1t1" }]) {
      const snapshot = buildSnapshot(["t1", "t2", "t3", "t4"].map((address) => terminal(address, labels ? { labels } : {})), layout, "0.1.17");
      expect(snapshot.layouts.map((tab) => tab.panes.map((pane) => [pane.pane_id, pane.rect.x, pane.rect.width]))).toEqual([[["t1", 0, 167], ["t2", 167, 166], ["t3", 333, 334], ["t4", 667, 333]]]);
      expect(snapshot.tabs.map((tab) => tab.tab_id)).toEqual(["s1t1"]);
    }
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
    expect(snapshot.panes.find((p) => p.pane_id === "t4")!.workspace_id).toBe(OTHER_WORKSPACE_ID);
  });

  it("puts a labeled terminal in the app's space and tab even when nothing else there is live, so adoption keeps its ids", () => {
    const layout = { spaces: [{ id: "S", name: "work", tabs: [{ id: "T", name: "main", root: { type: "block", id: "b", content: { terminal: "t1" } } }] }] };
    const snapshot = buildSnapshot([terminal("t5", { labels: { "herdr.space": "S", "herdr.tab": "T" } })], layout, "0.1.14");
    const pane = snapshot.panes.find((p) => p.pane_id === "t5")!;
    expect([pane.workspace_id, pane.tab_id]).toEqual(["S", "T"]);
    expect(snapshot.workspaces.find((w) => w.workspace_id === "S")!.label).toBe("work");
    expect(snapshot.tabs.find((t) => t.tab_id === "T")!.label).toBe("main");
  });

  it("never reuses an id the app's document holds for a terminal's own tab", () => {
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
    expect(snapshot.panes.find((p) => p.pane_id === "t4")!.tab_id).toBe("Y:t4");
    expect(new Set(tabIds).size).toBe(tabIds.length);
  });

  it("keeps split panes' rects while viewers size each terminal to its pane, so none shrinks (#2812)", () => {
    const labels = { "herdr.space": "ovis-s", "herdr.tab": "ovis-t" };
    const doc = { schema: 1, workspaces: [{ id: "ovis-s", tabs: [{ id: "ovis-t", zoomed: null, root: { split: "right", ratio: 0.5, first: { split: "down", ratio: 0.5, first: { leaf: "t5" }, second: { leaf: "t7" } }, second: { leaf: "t6" } } }] }] };
    let grids: HcTerminal[] = ["t5", "t7", "t6"].map((address) => terminal(address, { cols: 200, rows: 120, labels }));
    const seen: unknown[] = [];
    for (let round = 0; round < 3; round++) {
      const tab = buildSnapshot(grids, null, "0.1.17", undefined, doc).layouts[0]!;
      seen.push(tab.panes.map((pane) => [pane.pane_id, pane.rect]));
      grids = grids.map((held) => {
        const rect = tab.panes.find((pane) => pane.pane_id === held.address)!.rect;
        return { ...held, cols: Math.floor(rect.width / tab.area.width * 160), rows: Math.floor(rect.height / tab.area.height * 50) };
      });
    }
    expect(seen[0]).toEqual([
      ["t5", { x: 0, y: 0, width: 500, height: 500 }],
      ["t7", { x: 0, y: 500, width: 500, height: 500 }],
      ["t6", { x: 500, y: 0, width: 500, height: 1000 }],
    ]);
    expect(seen[1]).toEqual(seen[0]);
    expect(seen[2]).toEqual(seen[0]);
    expect(buildSnapshot(grids, null, "0.1.17", undefined, doc).panes.map((pane) => [pane.pane_id, (pane as HerdrPane).grid])).toEqual([
      ["t5", { cols: 80, rows: 25 }], ["t7", { cols: 80, rows: 25 }], ["t6", { cols: 80, rows: 50 }],
    ]);
  });

  it("puts a second unplaced terminal of a tab beside the first, not over it", () => {
    const snapshot = buildSnapshot([
      terminal("t1", { cols: 80, labels: { "herdr.space": "ovis-s", "herdr.tab": "ovis-t" } }),
      terminal("t2", { cols: 60, labels: { "herdr.space": "ovis-s", "herdr.tab": "ovis-t" } }),
    ], null, "0.1.14");
    expect(snapshot.layouts[0]!.panes.map((p) => [p.pane_id, p.rect.x])).toEqual([["t1", 0], ["t2", 500]]);
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

  it("marks the panes in a tab of their own terminal, in Other terminals or a helper's, which take no split (#2806)", () => {
    const kept = { "herdr.space": "s1", "herdr.tab": "tb1" };
    const snapshot = buildSnapshot([terminal("t1", { labels: kept }), terminal("t2", { labels: kept }), terminal("t3", { parent: "t1" }), terminal("t4")], null, "0.1.17");
    expect(snapshot.panes.map((p) => [p.pane_id, p.tab_id, (p as HerdrPane).own_tab])).toEqual([
      ["t1", "tb1", undefined], ["t2", "tb1", undefined], ["t3", "s1:t3", true], ["t4", `${OTHER_WORKSPACE_ID}:t4`, true],
    ]);
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
      terminal("t2", { status: { app: "claude", state: "working", kind: "question", msg: "  ", progress: 150 } }),
      terminal("t3", { status: { app: "claude", state: "working", progress: 0 } }),
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

describe("OpenCode sessions", () => {
  it("reads OpenCode's own pending records only, by their ids", () => {
    expect(opencodeRecords({ ses_a: { app: "opencode", state: "working" }, deploy: { app: "make", state: "working" }, ses_b: "working" })).toEqual(["ses_a"]);
    expect(opencodeRecords(undefined)).toEqual([]);
  });

  it("puts the session it is given on the pane and its agent", () => {
    const session = { agent: "opencode", source: "herdr:opencode", kind: "id", value: "ses_a" };
    const snapshot = buildSnapshot([terminal("t1", { status: { app: "opencode", state: "idle" } }), terminal("t2")], null, "0.1.18", undefined, undefined,
      (entry) => entry.address === "t1" ? session : null);
    expect(snapshot.panes.map((pane) => pane.agent_session ?? null)).toEqual([session, null]);
    expect(snapshot.agents.map((agent) => agent.agent_session ?? null)).toEqual([session]);
  });
});

describe("keyBytes", () => {
  it("types printable characters, Enter, Tab, Backspace, and Alt or Shift on a character hc has no key for; leaves the rest to hc's encoder", () => {
    expect(["x", "A", "한", " ", "Enter", "tab", "Backspace", "plus", "shift+plus", "alt+|", "alt+shift+plus"].map(keyBytes))
      .toEqual(["x", "A", "한", " ", "\r", "\t", "\x7f", "+", "+", "\x1b|", "\x1b+"]);
    for (const key of ["\x7f", "\x1b", "esc", "Up", "ctrl+enter", "shift+tab", "ctrl+c", "C-d", "alt+x", "ctrl+|", "constructor", "ctrl+alt+shift+left"]) expect(keyBytes(key)).toBeNull();
  });
});
