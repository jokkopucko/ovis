import { afterAll, beforeAll, beforeEach, describe, expect, it, spyOn, type Mock } from "bun:test";

import type { AgentStatus, HerdrPane } from "../../shared/protocol.ts";
import { startFakePushService, type FakePushService } from "../push.fake.ts";
import { handlers, hub } from "./status.fake.ts";

let device: FakePushService;
beforeAll(async () => { device = await startFakePushService(); });
afterAll(() => device.stop());
beforeEach(() => { device.received.length = 0; });

const pane = { pane_id: "w1:p1", workspace_id: "w1", tab_id: "w1:t1", agent: "gemini", agent_status: "working" } as HerdrPane;
const moved = { ...pane, pane_id: "w2:p1", workspace_id: "w2", tab_id: "w2:t1" } as HerdrPane;
const bodies: Record<"blocked" | "done", string> = { blocked: "waiting for your input", done: "work finished" };

it("does not cancel a tracked agent's question when the move describes its provider", async () => {
  const h = hub(undefined, undefined, undefined, undefined, { short: 0, long: 0, longTurn: 0 });
  (h.status.push.onStatus as Mock<typeof h.status.push.onStatus>).mockRestore();
  h.status.push.subscribe(device.subscription);
  h.herdrSays(pane);
  handlers.onBaseline([pane]);
  await h.snapshot();
  await h.status.push.onStatus(pane.pane_id, "blocked");
  const tracks = spyOn(h.status.gjc, "tracks").mockImplementation((id) => id === pane.pane_id);
  try { handlers.onPaneMoved(pane.pane_id, moved.pane_id, "working"); }
  finally { tracks.mockRestore(); }
  handlers.onBaseline([moved]);
  await h.status.push.settled();
  expect(device.received.map((sent) => sent.payload.pane_id)).toEqual([moved.pane_id]);
});

// #4217: the hub's real push service, driven through the collector handlers the hub registers
describe.each(["blocked", "done"] as const)("a %s alert still waiting when its pane goes away", (status: AgentStatus & keyof typeof bodies) => {
  const move = (agent_status: AgentStatus) => {
    const destination = { ...moved, agent_status };
    handlers.onPaneMoved(pane.pane_id, destination.pane_id, agent_status);
    handlers.onBaseline([destination]);
  };
  it.each([
    ["is delivered when the pane stays", () => {}, [pane.pane_id]],
    ["is called off when the pane closes", () => handlers.onPaneClosed(pane.pane_id), []],
    ["is called off when a snapshot no longer lists the pane (its tab, workspace or worktree closed)", () => handlers.onBaseline([]), []],
    ["is delivered under the new ID when the pane moves without a status change", () => move(status), [moved.pane_id]],
    ["calls off only the question when the pane moves and is already working", () => move("working"), status === "blocked" ? [] : [moved.pane_id]],
  ] as const)("%s", async (_label, away, expected) => {
    // no wait: the alert's timer still fires only after the synchronous close, move or snapshot below
    const h = hub(undefined, undefined, undefined, undefined, { short: 0, long: 0, longTurn: 0 });
    (h.status.push.onStatus as Mock<typeof h.status.push.onStatus>).mockRestore();
    h.status.push.subscribe(device.subscription);
    h.herdrSays(pane);
    handlers.onBaseline([pane]);
    await h.snapshot();
    handlers.onStatus(pane.pane_id, status, "gemini");
    away();
    await h.status.push.settled();
    expect(device.received.map((push) => ({ pane: push.payload.pane_id, body: push.payload.body })))
      .toEqual(expected.map((id) => ({ pane: id, body: bodies[status] })));
  });
});
