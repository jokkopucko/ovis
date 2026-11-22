import { afterEach, expect, it, spyOn } from "bun:test";
import type { AgentStatus, HerdrPane } from "../../shared/protocol.ts";
import { handlers, hub } from "./status.fake.ts";

const spies: { mockRestore(): void }[] = [];
afterEach(() => { for (const spy of spies.splice(0)) spy.mockRestore(); });

/** what web push and the queue hear of one snapshot, with the creation statuses the collector hands over */
function heard(created: ReadonlyMap<string, AgentStatus>) {
  const h = hub();
  const push: string[] = [];
  spies.push(spyOn(h.status.push, "firstStatus").mockImplementation(async (paneId, began, status) => { push.push(`first ${paneId} ${began}->${status}`); }));
  spies.push(spyOn(h.status.push, "seed").mockImplementation((panes) => { push.push(`seed ${panes.map((pane) => `${pane.pane_id} ${pane.agent_status}`).join(", ")}`); }));
  const queue = spyOn(h.pending, "baseline");
  spies.push(queue);
  const pane = { pane_id: "w2:p1", workspace_id: "w2", tab_id: "w2:t1", agent: "codex", agent_status: "blocked" };
  h.herdrSays(pane);
  const onBaseline = handlers.onBaseline as unknown as (panes: readonly HerdrPane[], newer: ReadonlySet<string>, askedAt: number, created: ReadonlyMap<string, AgentStatus>) => void;
  onBaseline([pane as unknown as HerdrPane], new Set(), 1_000, created);
  return { push, queue: queue.mock.calls.map((call) => [...call]) };
}

it("hands web push alone a new pane's creation status, before the snapshot's, and the queue the snapshot as for any pane", () => {
  const created = heard(new Map([["w2:p1", "unknown"]]));
  const known = heard(new Map());
  expect(created.push).toEqual(["first w2:p1 unknown->blocked", "seed w2:p1 blocked"]);
  expect(known.push).toEqual(["seed w2:p1 blocked"]);
  expect(created.queue.length).toBeGreaterThan(0);
  expect(created.queue).toEqual(known.queue);
});
