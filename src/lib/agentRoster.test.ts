import { describe, expect, it } from "bun:test";
import type { Machine, MachineState } from "../../shared/machines.ts";
import type { AgentStatus, HerdrPane, SessionSnapshot } from "../../shared/protocol.ts";
import fixture from "../../site/demo/fixtures/machines.json";
import { agentRoster, groupAgentRows, splitBackgroundRows, type AgentRow } from "./agentRoster.ts";
import { sidebarPinKey } from "./sidebarPins.ts";
import { stateSeqs } from "./sidebarOrder.ts";

const template = fixture.machines[0]!.snapshot as SessionSnapshot;
const templatePane = template.panes.find((pane) => pane.agent) ?? template.panes[0]!;
const workspace = template.workspaces[0]!;

function machine(id: string, state: MachineState, panes: [id: string, status: AgentStatus, parent?: string, tokens?: Record<string, string>][]): Machine {
  const snapshot: SessionSnapshot = {
    ...template,
    panes: panes.map(([pane_id, agent_status, parent, tokens]): HerdrPane => ({ ...templatePane, pane_id, agent_status, workspace_id: workspace.workspace_id, agent: "claude", background_wait: undefined, tokens: tokens ?? {}, ...(parent ? { parent_pane_id: parent } : {}) })),
    agents: panes.map(([pane_id, agent_status], index) => ({ ...template.agents[0]!, pane_id, agent_status, agent: "claude", state_change_seq: index + 1 })),
  };
  return { id, name: id, kind: id === "local" ? "local" : "ssh", enabled: true, state, error: null, snapshot };
}

describe("agent roster", () => {
  it("keeps the pinned card first in pin order, then every PC's blocked agents, then each PC's own Activity order", () => {
    const machines = [machine("local", "connected", [["a", "done"], ["b", "blocked"], ["c", "working"]]), machine("remote", "connected", [["d", "idle"], ["e", "blocked"]])];
    const seqs = new Map<string, ReadonlyMap<string, number>>([["local", new Map([["a", 1], ["b", 2], ["c", 3]])], ["remote", new Map([["d", 9], ["e", 1]])]]);
    const split = agentRoster(machines, { byActivity: true, seqs: (id) => seqs.get(id) ?? new Map(), pinned: [sidebarPinKey("remote", "d"), sidebarPinKey("local", "c")] });
    const key = ({ machine, entry }: { machine: Machine; entry: { pane: HerdrPane } }) => `${machine.id}/${entry.pane.pane_id}`;
    expect(split.pinned.map(key)).toEqual(["remote/d", "local/c"]);
    expect(split.rest.map(key)).toEqual(["local/b", "remote/e", "local/a"]);
  });

  describe("Activity across PCs", () => {
    const key = ({ machine, entry }: AgentRow) => `${machine.id}/${entry.pane.pane_id}`;
    /** the hub's change times (HerdrPane.changed_at) of the named rows */
    const dated = (pc: Machine, times: Record<string, number>): Machine => ({ ...pc, snapshot: { ...pc.snapshot!, panes: pc.snapshot!.panes.map((pane) => pane.pane_id in times ? { ...pane, changed_at: times[pane.pane_id] } : pane) } });
    const order = (machines: Machine[], pinned: string[] = [], byActivity = true) => {
      const split = agentRoster(machines, { byActivity, seqs: (id) => stateSeqs(machines.find((pc) => pc.id === id)?.snapshot), pinned });
      return [...split.pinned, ...split.rest].map(key);
    };

    it("puts the agent the hub saw change last first, whichever PC it is on", () => {
      // the local PC's counters are far higher than the remote one's: only the hub's times are compared
      const local = machine("local", "connected", [["a", "done"], ["b", "idle"]]);
      local.snapshot!.agents.forEach((agent) => { agent.state_change_seq = 10_000; });
      const remote = machine("win", "connected", [["w", "working"]]);
      expect(order([dated(local, { a: 2_000, b: 1_000 }), dated(remote, { w: 3_000 })])).toEqual(["win/w", "local/a", "local/b"]);
      // a blocked agent still stands first, and pins keep their pin order
      const blocked = machine("local", "connected", [["a", "done"], ["b", "blocked"]]);
      expect(order([dated(blocked, { a: 2_000, b: 1_000 }), dated(remote, { w: 3_000 })], [sidebarPinKey("local", "a")])).toEqual(["local/a", "local/b", "win/w"]);
    });

    it("keeps each PC's own Activity order after the dated rows, and two PCs' same pane ID apart", () => {
      const local = machine("local", "connected", [["a", "idle"], ["b", "idle"]]);
      const remote = machine("win", "connected", [["a", "idle"]]);
      // b's counter is higher than a's on this PC: per-PC Activity puts it first
      expect(order([local, dated(remote, { a: 5 })])).toEqual(["win/a", "local/b", "local/a"]);
    });

    it("leaves one PC's agents in herdr's Activity order, whatever their change times", () => {
      // b's counter is the higher one, a's change time the later one
      const local = dated(machine("local", "connected", [["a", "idle"], ["b", "idle"]]), { a: 9, b: 1 });
      expect(order([local])).toEqual(["local/b", "local/a"]);
    });

    it("keeps each PC's rows together in the Workspaces order", () => {
      const local = dated(machine("local", "connected", [["a", "idle"]]), { a: 1 });
      const remote = dated(machine("win", "connected", [["w", "idle"]]), { w: 2 });
      expect(order([local, remote], [], false)).toEqual(["local/a", "win/w"]);
    });

    it("keeps a helper under its agent", () => {
      const local = dated(machine("local", "connected", [["a", "idle"], ["h", "working", "a"]]), { a: 1, h: 9 });
      const remote = dated(machine("win", "connected", [["w", "working"]]), { w: 5 });
      expect(order([local, remote])).toEqual(["local/a", "local/h", "win/w"]);
    });
  });

  it("draws each helper right under the agent that started it, after its earlier helpers, in either order", () => {
    const panes: [string, AgentStatus, string?][] = [["a", "working"], ["b", "idle"], ["c", "blocked", "a"], ["d", "working", "a"], ["e", "done", "c"], ["f", "blocked", "gone"]];
    const key = ({ entry }: { entry: { pane: HerdrPane } }) => entry.pane.pane_id;
    const seqs = new Map([["a", 1], ["b", 2], ["c", 3], ["d", 4], ["e", 5], ["f", 6]]);
    for (const byActivity of [false, true]) {
      const split = agentRoster([machine("local", "connected", panes)], { byActivity, seqs: () => seqs, pinned: [] });
      expect(split.rest.map(key)).toEqual(byActivity ? ["f", "a", "c", "e", "d", "b"] : ["a", "c", "e", "d", "b", "f"]);
    }
  });

  it("keeps rows that name each other as parents, and a row naming itself, in their own order", () => {
    const panes: [string, AgentStatus, string?][] = [["x", "idle", "y"], ["y", "idle", "x"], ["z", "idle", "z"]];
    const split = agentRoster([machine("local", "connected", panes)], { byActivity: false, seqs: () => new Map(), pinned: [] });
    expect(split.rest.map(({ entry }) => entry.pane.pane_id)).toEqual(["x", "y", "z"]);
  });

  describe("apart from background agents", () => {
    const background = { role: "background" };
    const parts = (machines: Machine[]) => {
      const { people, background: rest } = splitBackgroundRows(agentRoster(machines, { byActivity: false, seqs: () => new Map(), pinned: [] }).rest,
        ({ machine, entry }) => machine.state === "connected" ? entry.pane.agent_status : undefined);
      return { people: people.map(({ machine, entry }) => `${machine.id}/${entry.pane.pane_id}`), background: rest.map(({ machine, entry }) => `${machine.id}/${entry.pane.pane_id}`) };
    };

    it("moves panes tagged role=background, and the helpers they started, to the background part in their order", () => {
      const machines = [
        machine("local", "connected", [["a", "idle"], ["w1", "working", undefined, background], ["h", "working", "w1"], ["b", "working"], ["w2", "done", undefined, { role: " Background " }]]),
        machine("away", "disconnected", [["w3", "idle", undefined, background], ["c", "idle", undefined, { role: "lead" }]]),
      ];
      expect(parts(machines)).toEqual({ people: ["local/a", "local/b", "away/c"], background: ["local/w1", "local/h", "local/w2", "away/w3"] });
    });

    it("keeps a blocked background agent with the people's rows, so its question is never folded away", () => {
      const machines = [machine("local", "connected", [["a", "idle"], ["w1", "working", undefined, background], ["h", "blocked", "w1"], ["w2", "blocked", undefined, background]])];
      expect(parts(machines)).toEqual({ people: ["local/a", "local/h", "local/w2"], background: ["local/w1"] });
    });
    it("looks up a helper's agent among every row, so a helper of a pinned or filtered-out background agent stays background", () => {
      const all = agentRoster([machine("local", "connected", [["w1", "working", undefined, background], ["h", "working", "w1"], ["a", "idle"]])], { byActivity: false, seqs: () => new Map(), pinned: [sidebarPinKey("local", "w1")] });
      const { people, background: rest } = splitBackgroundRows(all.rest, ({ entry }) => entry.pane.agent_status, [...all.pinned, ...all.rest]);
      expect({ people: people.map(({ entry }) => entry.pane.pane_id), background: rest.map(({ entry }) => entry.pane.pane_id) }).toEqual({ people: ["a"], background: ["h"] });
    });

    it("lays out the background part anew, a helper whose agent stayed with the people standing as a root", () => {
      const machines = [machine("local", "connected", [["a", "working", undefined, background], ["b", "blocked", "a"], ["c", "working", "b"], ["d", "working", "a"]])];
      expect(parts(machines)).toEqual({ people: ["local/b"], background: ["local/a", "local/d", "local/c"] });
    });

    it("lays out the people's rows anew too, a blocked helper of a background helper standing as a root", () => {
      const machines = [machine("local", "connected", [["a", "idle"], ["b", "working", "a", background], ["c", "blocked", "b"], ["d", "working", "a"]])];
      expect(parts(machines)).toEqual({ people: ["local/a", "local/d", "local/c"], background: ["local/b"] });
    });
  });

  describe("in groups by state", () => {
    const key = ({ machine, entry }: AgentRow) => `${machine.id}/${entry.pane.pane_id}`;
    const grouped = (machines: Machine[], sort: "wait" | "recent" | "name", seqs: Record<string, Record<string, number>>, names: Record<string, string> = {}) =>
      groupAgentRows(agentRoster(machines, { byActivity: false, seqs: () => new Map(), pinned: [] }).rest, {
        sort,
        status: ({ machine, entry }) => machine.state === "connected" ? entry.pane.agent_status : undefined,
        name: ({ entry }) => names[entry.pane.pane_id] ?? entry.pane.pane_id,
        seqs: (id) => new Map(Object.entries(seqs[id] ?? {})),
      }).map(({ group, rows }) => [group, rows.map(key)]);

    it("lists needs-you, working, done, then idle, each PC's longest wait first; BG works, unknown and an away PC rest", () => {
      const machines = [
        machine("local", "connected", [["a", "blocked"], ["b", "working"], ["c", "blocked"], ["d", "done"], ["e", "idle"], ["f", "waiting" as AgentStatus], ["g", "mystery" as AgentStatus]]),
        machine("remote", "connected", [["h", "blocked"]]),
        machine("away", "disconnected", [["i", "blocked"]]),
      ];
      const seqs = { local: { a: 5, b: 1, c: 2, d: 3, e: 4, f: 6, g: 7 }, remote: { h: 1 } };
      expect(grouped(machines, "wait", seqs)).toEqual([
        ["blocked", ["local/c", "local/a", "remote/h"]],
        ["working", ["local/b", "local/f"]],
        ["done", ["local/d"]],
        ["idle", ["local/e", "local/g", "away/i"]],
      ]);
      expect(grouped(machines, "recent", seqs)[0]).toEqual(["blocked", ["local/a", "local/c", "remote/h"]]);
    });

    it("orders by name across PCs, numbers as numbers", () => {
      const machines = [machine("local", "connected", [["a", "idle"], ["b", "idle"]]), machine("remote", "connected", [["c", "idle"]])];
      expect(grouped(machines, "name", {}, { a: "task 10", b: "Beta", c: "task 9" })).toEqual([["idle", ["local/b", "remote/c", "local/a"]]]);
    });

    it("keeps a helper under its agent, in the group of the one of them that needs the reader most", () => {
      const machines = [machine("local", "connected", [["a", "working"], ["b", "blocked", "a"], ["c", "done"], ["d", "idle", "c"]])];
      expect(grouped(machines, "wait", { local: { a: 1, b: 2, c: 3, d: 4 } })).toEqual([
        ["blocked", ["local/a", "local/b"]],
        ["done", ["local/c", "local/d"]],
      ]);
    });
  });
});
