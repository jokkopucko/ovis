import { describe, expect, it } from "bun:test";
import type { Machine } from "../../shared/machines.ts";
import type { AgentStatus, HerdrPane } from "../../shared/protocol.ts";
import machinesFixture from "../../site/demo/fixtures/machines.json";
import { heldOrder, inboxEmpty, inboxFiltered, inboxOrder, inboxSearched, inboxSinceAt, inboxStartsOpen, inboxStatus, inboxWords, questionWords } from "./agentInbox.ts";
import type { AgentRow } from "./agentRoster.ts";
import type { SidebarActivity } from "./sidebarActivity.tsx";

const fixture: Machine[] = JSON.parse(JSON.stringify(machinesFixture.machines));
const t = (text: string): string => text;

function activity(states: Record<string, AgentStatus> = {}, seqs: ReadonlyMap<string, number> = new Map()): SidebarActivity {
  return { seqs: () => seqs, status: (_machineId, pane) => states[pane.pane_id] ?? "idle" };
}

const ids = (rows: readonly AgentRow[]): string[] => rows.map(({ entry }) => entry.pane.pane_id);
const label = (rows: readonly AgentRow[]): string[] => rows.map(({ entry }) => (entry.pane as HerdrPane & { label?: string }).label ?? "");

describe("agent inbox", () => {
  it("orders the rows needs you, working, done, then resting", () => {
    const states = { "w1E:p1": "blocked", "w1F:p1": "working", "w1C:p1": "done" } as const;
    expect(ids(inboxOrder(fixture, activity(states)))).toEqual(["w1E:p1", "w1F:p1", "w1C:p1", "w1D:p1"]);
  });

  describe("within a state, the Agents list's order (Settings → Within a state)", () => {
    const lab: Machine = { ...JSON.parse(JSON.stringify(fixture[0])), id: "lab", name: "lab" };
    const pcs = [fixture[0]!, lab];
    const counters: Record<string, ReadonlyMap<string, number>> = {
      local: new Map([["w1C:p1", 3], ["w1D:p1", 1], ["w1E:p1", 2]]),
      lab: new Map([["w1C:p1", 1], ["w1D:p1", 3], ["w1E:p1", 2]]),
    };
    const resting: SidebarActivity = { seqs: (machineId) => counters[machineId] ?? new Map(), status: () => "idle" };
    const named = (row: AgentRow): string => label([row])[0]!;
    const order = (rows: readonly AgentRow[]): string[] => rows.map(({ machine, entry }) => `${machine.id}/${entry.pane.pane_id}`);

    it("puts the longest in the state first by default, each PC's rows apart in the PCs' order", () => {
      const wait = ["local/w1D:p1", "local/w1E:p1", "local/w1C:p1", "local/w1F:p1", "lab/w1C:p1", "lab/w1E:p1", "lab/w1D:p1", "lab/w1F:p1"];
      expect(order(inboxOrder(pcs, resting))).toEqual(wait);
      expect(order(inboxOrder(pcs, resting, { sort: "wait", name: named }))).toEqual(wait);
    });

    it("puts the most recently changed first under Recent, each PC's rows apart", () => {
      expect(order(inboxOrder(pcs, resting, { sort: "recent", name: named }))).toEqual(["local/w1C:p1", "local/w1E:p1", "local/w1D:p1", "local/w1F:p1", "lab/w1D:p1", "lab/w1E:p1", "lab/w1C:p1", "lab/w1F:p1"]);
    });

    it("orders every PC's rows by name under Name, a tie by the PCs' order", () => {
      expect(order(inboxOrder(pcs, resting, { sort: "name", name: named }))).toEqual(["local/w1D:p1", "lab/w1D:p1", "local/w1C:p1", "lab/w1C:p1", "local/w1F:p1", "lab/w1F:p1", "local/w1E:p1", "lab/w1E:p1"]);
    });
  });

  it("keeps a row by its own state under a filter, and every row under All", () => {
    const shown = activity({ "w1C:p1": "waiting" });
    const rows = inboxOrder(fixture, shown);
    expect(ids(inboxFiltered(rows, "working", shown))).toEqual(["w1C:p1"]);
    expect(ids(inboxFiltered(rows, "all", shown))).toEqual(ids(rows));
  });

  it("keeps the rows whose shown labels match the query", () => {
    const rows = inboxOrder(fixture, activity());
    expect(label(inboxSearched(rows, "export", fixture, t, () => null))).toEqual(["Guard the export button"]);
  });

  it("keeps a row whose drawn words match the query: a waiting agent's question, a working agent's plan step", () => {
    const rows = inboxOrder(fixture, activity());
    const drawn: Record<string, string> = { "w1D:p1": "Allow rm of node_modules?", "w1C:p1": "Bisect the flaky checkout" };
    const words = (row: AgentRow): string | null => drawn[row.entry.pane.pane_id] ?? null;
    expect(ids(inboxSearched(rows, "node_modules", fixture, t, words))).toEqual(["w1D:p1"]);
    expect(ids(inboxSearched(rows, "flaky checkout", fixture, t, words))).toEqual(["w1C:p1"]);
    expect(label(inboxSearched(rows, "export", fixture, t, words))).toEqual(["Guard the export button"]);
  });

  it("matches a row's drawn words only where they hold the query as typed, in any letter case", () => {
    const rows = inboxOrder(fixture, activity());
    const words = (row: AgentRow): string | null => row.entry.pane.pane_id === "w1D:p1" ? "Allow the agent to edit settings.json?" : null;
    expect(ids(inboxSearched(rows, "tests", fixture, t, words))).toEqual([]);
    expect(ids(inboxSearched(rows, "  EDIT Settings ", fixture, t, words))).toEqual(["w1D:p1"]);
  });

  it("keeps every row for a blank query", () => {
    const rows = inboxOrder(fixture, activity());
    expect(ids(inboxSearched(rows, "", fixture, t, () => "words"))).toEqual(ids(rows));
    expect(ids(inboxSearched(rows, "   ", fixture, t, () => "words"))).toEqual(ids(rows));
  });

  it("says a waiting agent's question, then the first line of what it is about", () => {
    expect(questionWords({ question: "Allow command?", body: "git push origin feat/export-guard\nmore" })).toBe("Allow command?\ngit push origin feat/export-guard");
    expect(questionWords({ question: "Allow command?", body: "\n  \nfirst\nmore" })).toBe("Allow command?\nfirst");
  });

  it("cuts a question at 240 units without splitting a character", () => {
    expect(questionWords({ question: `${"a".repeat(239)}\u{1F600}more`, body: null })).toBe("a".repeat(239));
    expect(questionWords({ question: `${"a".repeat(238)}\u{1F600}more`, body: null })).toBe(`${"a".repeat(238)}\u{1F600}`);
  });

  it("says the trimmed question alone when the body has no words", () => {
    expect(questionWords({ question: "  Allow command?  ", body: null })).toBe("Allow command?");
    expect(questionWords({ question: "  Allow command?  ", body: "\n   \n\t\n" })).toBe("Allow command?");
  });

  it("opens on the list unless the address names a place", () => {
    expect(inboxStartsOpen(true, null)).toBe(true);
    expect(inboxStartsOpen(true, { machine: "local", workspace: null, pane: "w1:p1", view: null, settings: null })).toBe(false);
    expect(inboxStartsOpen(true, { machine: "local", workspace: "w1", pane: null, view: null, settings: null })).toBe(false);
    expect(inboxStartsOpen(true, { machine: "local", workspace: null, pane: null, view: null, settings: "appearance" })).toBe(true);
    expect(inboxStartsOpen(true, { machine: "local", workspace: null, pane: null, view: null, settings: null, create: { kind: "workspace", cwd: null, name: null, agent: null } })).toBe(true);
  });

  it("gives a PC that is away no state and files its rows with the resting ones", () => {
    const away = fixture.map((machine) => ({ ...machine, state: "disconnected" as const }));
    const shown = activity({ "w1D:p1": "blocked" });
    const rows = inboxOrder(away, shown);
    expect(rows.map((row) => inboxStatus(row, shown))).toEqual(rows.map(() => undefined));
    expect(ids(inboxFiltered(rows, "blocked", shown))).toEqual([]);
  });

  it("borrows no words from another state", () => {
    expect(inboxWords({ group: "done", blocked: "x", question: "y", plan: { done: 1, total: 2, current: "z" }, last: null })).toBeNull();
  });

  it("says a waiting agent's note, else its question, else its last words", () => {
    const blocked = (blocked: string | null, question: string | null, last: string | null) => inboxWords({ group: "blocked", blocked, question, plan: undefined, last });
    expect(blocked("note", "ask", "said")).toBe("note");
    expect(blocked(null, "ask", "said")).toBe("ask");
    expect(blocked(null, null, "said")).toBe("said");
    expect(blocked(null, null, null)).toBeNull();
  });

  it("says a working agent's step, else its last words, and a resting one's last words", () => {
    const working = (current: string, last: string | null) => inboxWords({ group: "working", blocked: null, question: null, plan: { done: 1, total: 2, current }, last });
    expect(working("  run the tests  ", "said")).toBe("run the tests");
    expect(working("   ", "said")).toBe("said");
    expect(working("   ", null)).toBeNull();
    expect(inboxWords({ group: "idle", blocked: null, question: null, plan: undefined, last: "said" })).toBe("said");
  });

  it("keeps a key it does not hold after the held ones", () => {
    expect(heldOrder(["new", "b", "a"], (key) => key, ["a", "b"])).toEqual(["a", "b", "new"]);
  });

  it("tells loading, no agent and no match apart", () => {
    const empty = fixture.map((machine) => ({ ...machine, snapshot: machine.snapshot && { ...machine.snapshot, panes: [], agents: [] } }));
    expect(inboxEmpty([], 0, 0)).toBe("loading");
    expect(inboxEmpty(fixture.map((machine) => ({ ...machine, state: "connected" as const, snapshot: null })), 0, 0)).toBe("loading");
    expect(inboxEmpty(empty, 0, 0)).toBe("none");
    expect(inboxEmpty(fixture, 4, 0)).toBe("no-match");
    expect(inboxEmpty(fixture, 4, 4)).toBeNull();
  });
});

describe("inboxSinceAt", () => {
  const summary = { role: "assistant" as const, text: "Done.", at: 5_000, askedAt: 2_000, failed: false };
  it("times a working agent from the user's last ask, else from its last words", () => {
    expect(inboxSinceAt("working", summary, null)).toBe(2_000);
    expect(inboxSinceAt("working", { ...summary, askedAt: null }, null)).toBe(5_000);
  });
  it("times a waiting agent from when this page saw it begin to wait, else from its last message, and not at all with neither", () => {
    expect(inboxSinceAt("blocked", summary, 7_000)).toBe(7_000);
    expect(inboxSinceAt("blocked", undefined, 7_000)).toBe(7_000);
    expect(inboxSinceAt("blocked", summary, null)).toBe(5_000);
    expect(inboxSinceAt("blocked", { ...summary, at: null }, null)).toBeNull();
    expect(inboxSinceAt("blocked", undefined, null)).toBeNull();
  });
  it("times a done or resting agent from its last words", () => {
    for (const group of ["done", "idle"] as const) expect(inboxSinceAt(group, summary, 7_000)).toBe(5_000);
    expect(inboxSinceAt("done", { ...summary, at: null }, null)).toBeNull();
  });
  it("has no time without a summary, but for a wait seen to begin", () => {
    expect(inboxSinceAt("working", undefined, null)).toBeNull();
    expect(inboxSinceAt("done", null, null)).toBeNull();
  });
});

