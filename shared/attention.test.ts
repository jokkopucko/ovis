import { describe, expect, it } from "bun:test";
import fixture from "../site/demo/fixtures/machines.json";
import type { Machine } from "./machines.ts";
import type { AgentStatus, HerdrPane, SessionSnapshot } from "./protocol.ts";
import { activityOrder, AGENT_GROUPS, agentGroup, type AttentionRow, groupAgentRows, type KnownStatus, knownStatus, nestRows, rollupStatus, seenTurnOf, shownStatusOfWord, sidebarPinKey, stateSeqs } from "./attention.ts";
import { agentRoster, type AgentRow, groupAgentRows as browserGroupAgentRows } from "../src/lib/agentRoster.ts";

type Row = AttentionRow & { status: AgentStatus; name: string };

/** a row of PC `machine`, pane `pane`, in state `status`, started by `parent` */
function row(machine: string, pane: string, status: AgentStatus, parent?: string, name = pane): Row {
  return { machine: { id: machine }, entry: { pane: { pane_id: pane, ...(parent ? { parent_pane_id: parent } : {}) } }, status, name };
}

/** the groups as `[group, ["pc:pane", ...]]` */
const sections = (groups: { group: string; rows: AttentionRow[] }[]) =>
  groups.map(({ group, rows }) => [group, rows.map(({ machine, entry }) => sidebarPinKey(machine.id, entry.pane.pane_id))]);

describe("attention rules", () => {
  it("shown state table", () => {
    const seen = (turn: string) => ({ "herdr.seen": turn });
    const cases: [word: AgentStatus, turn: number | undefined, labels: Record<string, string> | undefined, firstTurn: number | undefined, shown: AgentStatus][] = [
      ["working", 9, seen("1"), 1, "working"],
      ["blocked", 9, seen("1"), undefined, "blocked"],
      ["unknown", 9, seen("1"), undefined, "unknown"],
      ["idle", 5, seen("4"), undefined, "done"],
      ["idle", 4, seen("4"), undefined, "idle"],
      ["done", 3, seen("3"), 0, "idle"],
      ["done", undefined, seen("0"), undefined, "idle"],
      ["done", 7, seen("not a turn"), undefined, "done"],
      ["idle", 3, undefined, 2, "done"],
      ["idle", 3, undefined, 3, "idle"],
      ["done", 3, {}, undefined, "done"],
    ];
    expect(cases.map(([word, turn, labels, firstTurn]) => shownStatusOfWord(word, turn, labels, firstTurn))).toEqual(cases.map((entry) => entry[4]));
    expect([seenTurnOf({ "herdr.seen": "12" }), seenTurnOf({ "herdr.seen": "1e3" }), seenTurnOf({ "herdr.seen": "1234567890123456" }), seenTurnOf(undefined)]).toEqual([12, null, null, null]);
    expect(["idle", "working", "blocked", "done", "waiting", "paused", undefined].map((status) => knownStatus(status))).toEqual(["idle", "working", "blocked", "done", "waiting", "unknown", "unknown"]);
  });

  it("roll-up", () => {
    const rolled: [ReadonlyArray<AgentStatus | undefined>, KnownStatus][] = [
      [["working", "done"], "done"],
      [["blocked", "done"], "blocked"],
      [["idle", "working"], "working"],
      [["waiting", "working"], "working"],
      [["idle", "waiting"], "waiting"],
      [["idle", undefined], "idle"],
      [["paused", undefined], "unknown"],
      [[], "unknown"],
    ];
    expect(rolled.map(([statuses]) => rollupStatus(statuses))).toEqual(rolled.map(([, state]) => state));
  });

  it("sections", () => {
    expect(AGENT_GROUPS).toEqual(["blocked", "working", "done", "idle"]);
    expect((["blocked", "done", "working", "waiting", "idle", "unknown", undefined] as const).map(agentGroup)).toEqual(["blocked", "done", "working", "working", "idle", "idle", "idle"]);
    // pc a: a blocked helper (p3) brings its agent (p2) up; pc b's rows follow a's in each group
    const rows = [row("a", "p1", "idle", undefined, "zeta"), row("a", "p2", "working"), row("a", "p3", "blocked", "p2"), row("b", "p1", "done"), row("a", "p4", "done"), row("b", "p2", "idle", undefined, "alpha")];
    const seqs = new Map([["a", new Map([["p1", 5], ["p2", 1], ["p4", 3]])], ["b", new Map([["p1", 2], ["p2", 4]])]]);
    const options = (sort: "wait" | "recent" | "name") => ({ sort, status: (entry: Row) => entry.status, name: (entry: Row) => entry.name, seqs: (machineId: string) => seqs.get(machineId) ?? new Map<string, number>() });
    expect(sections(groupAgentRows(rows, options("wait")))).toEqual([["blocked", ["a:p2", "a:p3"]], ["done", ["a:p4", "b:p1"]], ["idle", ["a:p1", "b:p2"]]]);
    expect(sections(groupAgentRows(rows, options("recent")))).toEqual([["blocked", ["a:p2", "a:p3"]], ["done", ["a:p4", "b:p1"]], ["idle", ["a:p1", "b:p2"]]]);
    expect(sections(groupAgentRows([row("a", "p5", "idle"), row("a", "p6", "idle")], options("recent")))).toEqual([["idle", ["a:p5", "a:p6"]]]);
    expect(sections(groupAgentRows([row("a", "p4", "idle"), row("a", "p1", "idle")], options("wait")))).toEqual([["idle", ["a:p4", "a:p1"]]]);
    expect(sections(groupAgentRows([row("a", "p4", "idle"), row("a", "p1", "idle")], options("recent")))).toEqual([["idle", ["a:p1", "a:p4"]]]);
    expect(sections(groupAgentRows(rows, options("name")))).toEqual([["blocked", ["a:p2", "a:p3"]], ["done", ["b:p1", "a:p4"]], ["idle", ["b:p2", "a:p1"]]]);
    // Activity order: blocked first, then the latest state change, then the order given
    const panes = ([["p1", "idle"], ["p2", "working"], ["p3", "blocked"], ["p4", "done"], ["p5", "idle"]] as const).map(([pane_id, agent_status]) => ({ pane_id, agent_status }));
    expect(activityOrder(panes, (pane) => pane, new Map([["p1", 5], ["p2", 1], ["p4", 9]])).map((pane) => pane.pane_id)).toEqual(["p3", "p4", "p1", "p2", "p5"]);
  });

  it("one fixture, two surfaces", () => {
    const machine = { ...fixture.machines[0]!, snapshot: fixture.machines[0]!.snapshot as SessionSnapshot } as Machine;
    const snapshot = machine.snapshot!;
    const seqs = stateSeqs(snapshot);
    const status = (entry: { entry: { pane: Pick<HerdrPane, "agent_status"> } }) => entry.entry.pane.agent_status;
    const options = { sort: "wait" as const, status, name: () => "", seqs: () => seqs };
    // the browser: its roster of the PC in Activity order, then its groups
    const browser = browserGroupAgentRows<AgentRow>(agentRoster([machine], { byActivity: true, seqs: () => seqs, pinned: [] }).rest, options);
    // a screen: the snapshot's agent panes, put in order and grouped by the shared rules alone
    const panes = snapshot.panes.filter((pane) => pane.agent).map((pane): AttentionRow & { entry: { pane: HerdrPane } } => ({ machine: { id: machine.id }, entry: { pane } }));
    const ordered = nestRows(activityOrder(panes, (entry) => entry.entry.pane, seqs), (entry) => entry.entry.pane.pane_id, (entry) => entry.entry.pane.parent_pane_id);
    const screen = groupAgentRows<(typeof ordered)[number]>(ordered, options);
    expect(sections(browser)).toEqual([["blocked", ["local:w1D:p1"]], ["working", ["local:w1C:p1"]], ["idle", ["local:w1E:p1", "local:w1F:p1"]]]);
    expect(sections(screen)).toEqual(sections(browser));
    expect(ordered.map((entry) => entry.entry.pane.pane_id)).toEqual(["w1D:p1", "w1F:p1", "w1E:p1", "w1C:p1"]);
  });
});
