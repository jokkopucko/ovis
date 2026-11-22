import { afterAll, beforeAll, beforeEach, describe, expect, it, type Mock } from "bun:test";

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

// #4217: the hub's real push service, driven through the collector handlers the hub registers
describe.each(["blocked", "done"] as const)("a %s alert still waiting when its pane goes away", (status: AgentStatus & keyof typeof bodies) => {
  it.each([
    ["is delivered when the pane stays", () => {}, [pane.pane_id]],
    ["is called off when the pane closes", () => handlers.onPaneClosed(pane.pane_id), []],
    ["is called off when a snapshot no longer lists the pane (its tab, workspace or worktree closed)", () => handlers.onBaseline([]), []],
    ["is delivered under the new ID when the pane moves to another workspace", () => { handlers.onPaneMoved(pane.pane_id, moved.pane_id); handlers.onBaseline([moved]); }, [moved.pane_id]],
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
