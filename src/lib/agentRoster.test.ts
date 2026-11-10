import { describe, expect, it } from "bun:test";
import type { Machine, MachineState } from "../../shared/machines.ts";
import type { AgentStatus, HerdrPane, SessionSnapshot } from "../../shared/protocol.ts";
import fixture from "../../site/demo/fixtures/machines.json";
import { agentRoster } from "./agentRoster.ts";
import { sidebarPinKey } from "./sidebarPins.ts";
import { agentActivity, newAgentActivityMemory } from "./agentActivity.ts";
import { stateSeqs } from "./sidebarOrder.ts";

const template = fixture.machines[0]!.snapshot as SessionSnapshot;
const templatePane = template.panes.find((pane) => pane.agent) ?? template.panes[0]!;
const workspace = template.workspaces[0]!;

/** a PC whose agents are the named panes, in that order, each with its own status */
function machine(id: string, state: MachineState, panes: [id: string, status: AgentStatus][]): Machine {
  const snapshot: SessionSnapshot = {
    ...template,
    panes: panes.map(([pane_id, agent_status]): HerdrPane => ({ ...templatePane, pane_id, agent_status, workspace_id: workspace.workspace_id, agent: "claude", background_wait: undefined })),
    agents: panes.map(([pane_id, agent_status], index) => ({ ...template.agents[0]!, pane_id, agent_status, agent: "claude", state_change_seq: index + 1 })),
  };
  return { id, name: id, kind: id === "local" ? "local" : "ssh", enabled: true, state, error: null, snapshot };
}

describe("agent roster", () => {
  it("keeps pins in pin order and puts blocked agents first across PCs", () => {
    const machines = [machine("local", "connected", [["a", "done"], ["b", "blocked"], ["c", "working"]]), machine("remote", "connected", [["d", "idle"], ["e", "blocked"]])];
    const seqs = new Map<string, ReadonlyMap<string, number>>([["local", new Map([["a", 1], ["b", 2], ["c", 3]])], ["remote", new Map([["d", 9], ["e", 1]])]]);
    const split = agentRoster(machines, { byActivity: true, seqs: (id) => seqs.get(id) ?? new Map(), recent: new Map(), pinned: [sidebarPinKey("remote", "d"), sidebarPinKey("local", "c")] });
    const key = ({ machine, entry }: { machine: Machine; entry: { pane: HerdrPane } }) => `${machine.id}/${entry.pane.pane_id}`;
    expect(split.pinned.map(key)).toEqual(["remote/d", "local/c"]);
    expect(split.rest.map(key)).toEqual(["local/b", "remote/e", "local/a"]);
  });

  it("orders observed changes across PCs without comparing their native counters or mixing pane IDs", () => {
    const machines = [machine("local", "connected", [["a", "working"]]), machine("remote", "connected", [["a", "working"]])];
    machines[0]!.snapshot!.agents[0]!.state_change_seq = 10_000;
    const memory = newAgentActivityMemory();
    const seqs = (id: string) => stateSeqs(machines.find((machine) => machine.id === id)?.snapshot);
    const order = (byActivity = true, pinned: string[] = []) => {
      const recent = agentActivity(machines, seqs, memory);
      const rows = agentRoster(machines, { byActivity, seqs, recent, pinned });
      return [...rows.pinned, ...rows.rest].map((row) => row.machine.id);
    };
    expect(order()).toEqual(["local", "remote"]);
    machines[1]!.snapshot!.agents[0]!.state_change_seq = 2;
    expect(order()).toEqual(["remote", "local"]);
    expect(order()).toEqual(["remote", "local"]);
    expect(order(false)).toEqual(["local", "remote"]);
    expect(order(true, [sidebarPinKey("local", "a")])).toEqual(["local", "remote"]);
    machines[0]!.snapshot!.agents[0]!.state_change_seq = 10_001;
    expect(order()).toEqual(["local", "remote"]);
  });

  it("drops old cross-PC recency on restart, removal and counter rollback", () => {
    const machines = [machine("local", "connected", [["a", "working"]]), machine("remote", "connected", [["a", "working"]])];
    const memory = newAgentActivityMemory();
    const seqs = (id: string) => stateSeqs(machines.find((machine) => machine.id === id)?.snapshot);
    const update = () => agentActivity(machines, seqs, memory);
    const key = sidebarPinKey("remote", "a");
    update();
    machines[1]!.snapshot!.agents[0]!.state_change_seq = 2;
    expect(update().has(key)).toBe(true);
    machines[1]!.snapshot!.finish_epoch = "new-epoch";
    expect(update().has(key)).toBe(false);
    machines[1]!.snapshot!.agents[0]!.state_change_seq = 3;
    expect(update().has(key)).toBe(true);
    machines[1]!.snapshot!.agents[0]!.state_change_seq = 1;
    expect(update().has(key)).toBe(false);
    machines[1]!.snapshot!.agents[0]!.state_change_seq = 2;
    expect(update().has(key)).toBe(true);
    machines.pop();
    expect(update().has(key)).toBe(false);
    expect(memory.machines.has("remote")).toBe(false);
  });
});
