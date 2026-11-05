import { describe, expect, it } from "bun:test";
import type { Machine, MachineState } from "../../shared/machines.ts";
import type { AgentStatus, HerdrPane, SessionSnapshot } from "../../shared/protocol.ts";
import fixture from "../../site/demo/fixtures/machines.json";
import { agentRoster } from "./agentRoster.ts";
import { sidebarPinKey } from "./sidebarPins.ts";

const template = fixture.machines[0]!.snapshot as SessionSnapshot;
const templatePane = template.panes.find((pane) => pane.agent) ?? template.panes[0]!;
const workspace = template.workspaces[0]!;

/** a PC whose agents are the named panes, in that order, each with its own status */
function machine(id: string, state: MachineState, panes: [id: string, status: AgentStatus, parent?: string][]): Machine {
  const snapshot: SessionSnapshot = {
    ...template,
    panes: panes.map(([pane_id, agent_status, parent]): HerdrPane => ({ ...templatePane, pane_id, agent_status, workspace_id: workspace.workspace_id, agent: "claude", background_wait: undefined, ...(parent ? { parent_pane_id: parent } : {}) })),
    agents: panes.map(([pane_id, agent_status], index) => ({ ...template.agents[0]!, pane_id, agent_status, agent: "claude", state_change_seq: index + 1 })),
  };
  return { id, name: id, kind: id === "local" ? "local" : "ssh", enabled: true, state, error: null, snapshot };
}

describe("agent roster", () => {
  it("keeps the pinned card first in pin order and each PC's rows in its own Activity order", () => {
    const machines = [machine("local", "connected", [["a", "done"], ["b", "blocked"], ["c", "working"]]), machine("remote", "connected", [["d", "idle"], ["e", "blocked"]])];
    const seqs = new Map<string, ReadonlyMap<string, number>>([["local", new Map([["a", 1], ["b", 2], ["c", 3]])], ["remote", new Map([["d", 9], ["e", 1]])]]);
    const split = agentRoster(machines, { byActivity: true, seqs: (id) => seqs.get(id) ?? new Map(), pinned: [sidebarPinKey("remote", "d"), sidebarPinKey("local", "c")] });
    const key = ({ machine, entry }: { machine: Machine; entry: { pane: HerdrPane } }) => `${machine.id}/${entry.pane.pane_id}`;
    expect(split.pinned.map(key)).toEqual(["remote/d", "local/c"]);
    // blocked first, then the latest change, within each PC; the PCs keep their order
    expect(split.rest.map(key)).toEqual(["local/b", "local/a", "remote/e"]);
  });

  it("draws each helper right under the agent that started it, after its earlier helpers, in either order", () => {
    // herdr-core's parent: c and d started from a, e from c; f names a pane that is no row
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
});
