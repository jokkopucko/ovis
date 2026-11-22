import { afterEach, beforeEach, expect, it, mock, spyOn } from "bun:test";
import * as client from "../herdr/client.ts";
import type { HerdrPane } from "../../shared/protocol.ts";
import { createSubmitText } from "./composer.ts";

afterEach(() => mock.restore());

const pane: HerdrPane = { pane_id: "chat-guard", workspace_id: "w", tab_id: "t", terminal_id: "terminal",
  cwd: "/fixture", focused: false, revision: 0, agent: "pi", agent_status: "idle" };

beforeEach(() => {
  spyOn(client, "paneGet").mockResolvedValue(pane);
  spyOn(client, "paneProcessInfo").mockResolvedValue(undefined);
  spyOn(client, "paneRead").mockResolvedValue({ text: "" } as Awaited<ReturnType<typeof client.paneRead>>);
});

const submitter = () => createSubmitText({
  options: { submitDelayMs: 0 }, lastTyped: new Map(), attachments: new Map(), terminalAttach: async () => true,
  SUBMIT_DEADLINE_MS: 1000, TYPED_SETTLE_MS: 0, DRAFT_CLEAR_WAIT_MS: 0, DRAFT_CLEAR_POLL_MS: 0, SUBMIT_DELAY_MS: 0,
});

function senderLeavesWhileConnecting() {
  let watching = false;
  const authorize = () => { if (watching) throw new client.HerdrError("read_only", "this connection can only watch"); };
  const prompt = spyOn(client, "agentPrompt").mockImplementation(async (_target, _text, _socketPath, guard) => {
    watching = true;
    if (guard && !guard()) throw new client.HerdrError("cancelled", "herdr agent.prompt was not sent");
  });
  return { authorize, prompt, typed: spyOn(client, "paneSendText").mockResolvedValue(), keys: spyOn(client, "paneSendKeys").mockResolvedValue() };
}

it("sends a chat message to the pane's agent with a guard asked right before herdr is written to", async () => {
  const prompt = spyOn(client, "agentPrompt").mockResolvedValue();
  await submitter()(pane.pane_id, "hello", "hello", Date.now());
  expect(prompt).toHaveBeenCalledWith(pane.pane_id, "hello", undefined, expect.any(Function));
});

it("writes and types nothing of a chat message whose sender may no longer type once herdr is reached", async () => {
  const { authorize, prompt, typed, keys } = senderLeavesWhileConnecting();
  const failed = await submitter()(pane.pane_id, "hello", "hello", Date.now(), false, authorize).then(() => null, (error: unknown) => error);
  expect(failed).toBeInstanceOf(client.HerdrError);
  expect((failed as client.HerdrError).code).toBe("read_only");
  expect(prompt).toHaveBeenCalledTimes(1);
  expect(typed).not.toHaveBeenCalled();
  expect(keys).not.toHaveBeenCalled();
});

it("still types a chat message into a pane herdr finds no agent in", async () => {
  spyOn(client, "agentPrompt").mockRejectedValue(new client.HerdrError("agent_not_found", "no agent"));
  const typed = spyOn(client, "paneSendText").mockResolvedValue();
  const keys = spyOn(client, "paneSendKeys").mockResolvedValue();
  await submitter()(pane.pane_id, "hello", "hello", Date.now());
  expect(typed).toHaveBeenCalledWith(pane.pane_id, "hello", undefined, expect.any(Function));
  expect(keys).toHaveBeenCalledWith(pane.pane_id, ["Enter"], undefined, expect.any(Function));
});
