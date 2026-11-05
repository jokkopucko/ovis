import { afterEach, expect, it, mock, spyOn } from "bun:test";
import * as client from "../herdr/client.ts";
import { createSubmitText } from "./composer.ts";

afterEach(() => mock.restore());

const submitter = () => createSubmitText({
  options: { submitDelayMs: 0 }, lastTyped: new Map(), attachments: new Map(), terminalAttach: async () => true,
  SUBMIT_DEADLINE_MS: 1000, TYPED_SETTLE_MS: 0, DRAFT_CLEAR_WAIT_MS: 0, DRAFT_CLEAR_POLL_MS: 0, SUBMIT_DELAY_MS: 0,
});

/** #1174's example: one line of 24 sentences, which typed raw reached Claude Code as only its tail */
const LONG = Array.from({ length: 24 }, (_, i) => `This is sentence number ${i + 1} of a long dictated message.`).join(" ");

const herdr = () => ({
  prompt: spyOn(client, "agentPrompt").mockResolvedValue(),
  typed: spyOn(client, "paneSendText").mockResolvedValue(),
  keys: spyOn(client, "paneSendKeys").mockResolvedValue(),
});

it("sends one long input line to the pane's agent as its prompt, not typed raw", async () => {
  const { prompt, typed, keys } = herdr();
  await submitter()("w:p1", LONG, LONG, Date.now(), true);
  expect(prompt).toHaveBeenCalledWith("w:p1", LONG, undefined, expect.any(Function));
  expect(typed).not.toHaveBeenCalled();
  expect(keys).not.toHaveBeenCalled();
});

it("still types a short input line, an answer into an open menu included", async () => {
  const { prompt, typed, keys } = herdr();
  await submitter()("w:p1", "2", "2", Date.now(), true);
  expect(prompt).not.toHaveBeenCalled();
  expect(typed).toHaveBeenCalledWith("w:p1", "2", undefined, expect.any(Function));
  expect(keys).toHaveBeenCalledWith("w:p1", ["Enter"], undefined, expect.any(Function));
});

for (const code of ["agent_not_found", "agent_not_ready", "agent_blocked"]) {
  it(`types a long input line as before when herdr refuses its prompt with ${code}`, async () => {
    const { prompt, typed, keys } = herdr();
    prompt.mockRejectedValue(new client.HerdrError(code, "fixture refusal"));
    await submitter()("w:p1", LONG, LONG, Date.now(), true);
    expect(typed).toHaveBeenCalledWith("w:p1", LONG, undefined, expect.any(Function));
    expect(keys).toHaveBeenCalledWith("w:p1", ["Enter"], undefined, expect.any(Function));
  });
}

it("writes and types nothing of a long input line whose sender may no longer type once herdr is reached", async () => {
  const { prompt, typed, keys } = herdr();
  let watching = false;
  const authorize = () => { if (watching) throw new client.HerdrError("read_only", "this connection can only watch"); };
  // herdrRpc asks the guard once connected, right before the prompt is written
  prompt.mockImplementation(async (_target, _text, _socketPath, guard) => {
    watching = true;
    if (guard && !guard()) throw new client.HerdrError("cancelled", "herdr agent.prompt was not sent");
  });
  const failed = await submitter()("w:p1", LONG, LONG, Date.now(), true, authorize).then(() => null, (error: unknown) => error);
  expect(failed).toBeInstanceOf(client.HerdrError);
  expect((failed as client.HerdrError).code).toBe("read_only");
  expect(typed).not.toHaveBeenCalled();
  expect(keys).not.toHaveBeenCalled();
});

it("never types a long input line after its prompt failed in a way that may have delivered it", async () => {
  const { prompt, typed, keys } = herdr();
  prompt.mockRejectedValue(new client.HerdrError("timeout", "herdr did not answer"));
  const failed = await submitter()("w:p1", LONG, LONG, Date.now(), true).then(() => null, (error: unknown) => error);
  expect(failed).toBeInstanceOf(client.HerdrError);
  expect(typed).not.toHaveBeenCalled();
  expect(keys).not.toHaveBeenCalled();
});

it("sends chat text through the guarded terminal path when a custom dsh agent has no prompt adapter", async () => {
  const { prompt, typed, keys } = herdr();
  spyOn(client, "paneGet").mockResolvedValue({ pane_id: "w:p1", agent: "dsh", agent_status: "idle", cwd: "/tmp", terminal_id: "dsh-test" } as Awaited<ReturnType<typeof client.paneGet>>);
  prompt.mockRejectedValue(new client.HerdrError("agent_not_ready", "custom dsh agent"));
  await submitter()("w:p1", "hello dsh", "hello dsh", Date.now(), false);
  expect(typed).toHaveBeenCalledWith("w:p1", "hello dsh", undefined, expect.any(Function));
  expect(keys).toHaveBeenCalledWith("w:p1", ["Enter"], undefined, expect.any(Function));
});
