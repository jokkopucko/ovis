import { describe, expect, it, jest } from "bun:test";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { copilotApprovals } from "../approvals/copilot.ts";
import { handlers, hub, line, root } from "./status.fake.ts";

// Copilot CLI 1.0.109's hooks, as recorded: the session whose second prompt was typed while the first turn ran, which
// Copilot told only as it took it in, after the first turn's Stop
const recorded = readFileSync(join(import.meta.dir, "..", "fixtures", "copilot-1.0.109-hooks.jsonl"), "utf8")
  .trim().split("\n").map((entry) => JSON.parse(entry) as Record<string, unknown>)
  .filter((event) => event["session_id"] === "45237465-a4e2-47e4-8ea8-4a9927746b1f" && event["hook_event_name"] !== "SessionStart");
const [firstPrompt, firstStop, secondPrompt, secondStop] = recorded;

let sessions = 0;
async function copilotHub() {
  const path = join(root, `copilot-${++sessions}.jsonl`);
  writeFileSync(path, line({ type: "session.start", data: {} }));
  const pane = { pane_id: "w1:p1", workspace_id: "w1", tab_id: "w1:t1", agent_status: "idle", agent: "copilot" };
  const h = hub(path);
  h.herdrSays(pane);
  handlers.onBaseline([pane]);
  await h.snapshot();
  // what the hook tells, its transcript this test's
  const tell = (event: Record<string, unknown> | undefined) => {
    const turn = copilotApprovals.turn!({ ...event, ...(event?.["hook_event_name"] === "Stop" ? { transcript_path: path } : {}) });
    if (turn !== null) h.status.hookTurn(pane.pane_id, "copilot", turn);
  };
  return { ...h, path, pane, tell };
}

describe("a Copilot pane whose Stop hook told its turn ended", () => {
  it("is DONE at the hook's word while herdr still reads it at work, and stays DONE when herdr's rest follows", async () => {
    const h = await copilotHub();
    const id = h.pane.pane_id;
    h.tell(firstPrompt);
    handlers.onStatus(id, "working", "copilot");
    h.herdrSays({ ...h.pane, agent_status: "working" });
    h.tell(firstStop);
    expect(h.last().status).toBe("done");
    expect(h.alerts).toEqual(["working", "done"]);
    // the queue waits for herdr's own rest: another Stop hook may keep the turn going
    expect(h.pending.current(id)).toBe("working");
    expect((await h.snapshot()).panes[0]!.agent_status).toBe("done");
    handlers.onStatus(id, "idle", "copilot");
    expect(h.last().status).toBe("done");
    expect(h.pending.current(id)).toBe("done");
  });

  it("is at work again when Copilot takes in the prompt typed during the turn, and DONE at that turn's Stop", async () => {
    const h = await copilotHub();
    const id = h.pane.pane_id;
    h.tell(firstPrompt);
    handlers.onStatus(id, "working", "copilot");
    h.herdrSays({ ...h.pane, agent_status: "working" });
    h.tell(firstStop);
    expect(h.last().status).toBe("done");
    h.tell(secondPrompt);
    expect(h.last().status).toBe("working");
    expect((await h.snapshot()).panes[0]!.agent_status).toBe("working");
    h.tell(secondStop);
    expect(h.last().status).toBe("done");
  });

  it("ends nothing at a Stop with no prompt open, after herdr's rest, or once the pane runs another agent", async () => {
    const h = await copilotHub();
    const id = h.pane.pane_id;
    handlers.onStatus(id, "working", "copilot");
    h.tell(firstStop);
    expect(h.last().status).toBe("working");
    h.tell(firstPrompt);
    handlers.onStatus(id, "idle", "copilot");
    handlers.onStatus(id, "working", "copilot");
    h.tell(firstStop);
    expect(h.last().status).toBe("working");
    h.tell(secondPrompt);
    handlers.onStatus(id, "working", "claude");
    h.tell(secondStop);
    expect(h.last().status).toBe("working");
  });

  it("keeps the prompt open through an approval wait, and takes a turn that failed with no Stop as over at the next prompt", async () => {
    const h = await copilotHub();
    const id = h.pane.pane_id;
    h.tell(firstPrompt);
    handlers.onStatus(id, "working", "copilot");
    handlers.onStatus(id, "blocked", "copilot");
    handlers.onStatus(id, "working", "copilot");
    h.herdrSays({ ...h.pane, agent_status: "working" });
    h.tell(firstStop);
    expect(h.last().status).toBe("done");
    // a model error ends a turn with no Stop (1.0.109); herdr read no rest before the next prompt
    h.tell(secondPrompt);
    expect(h.last().status).toBe("working");
    h.tell(secondPrompt);
    h.tell(secondStop);
    expect(h.last().status).toBe("done");
  });

  it("takes back the DONE of a Stop once Copilot begins another turn in the transcript (another Stop hook blocked it)", async () => {
    jest.useFakeTimers();
    try {
      const h = await copilotHub();
      const id = h.pane.pane_id;
      h.tell(firstPrompt);
      handlers.onStatus(id, "working", "copilot");
      h.herdrSays({ ...h.pane, agent_status: "working" });
      h.tell(firstStop);
      expect(h.last().status).toBe("done");
      // Copilot writes its own hooks' runs after the Stop: no turn
      appendFileSync(h.path, line({ type: "hook.start", data: {} }) + line({ type: "hook.end", data: {} }));
      jest.advanceTimersByTime(1000);
      expect(h.last().status).toBe("done");
      appendFileSync(h.path, line({ type: "assistant.turn_start", data: {} }));
      jest.advanceTimersByTime(1000);
      expect(h.last().status).toBe("working");
      expect(h.pending.current(id)).toBe("working");
    } finally {
      jest.useRealTimers();
    }
  });
});
