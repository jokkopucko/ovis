import { afterEach, expect, it, mock, spyOn } from "bun:test";
import { readFileSync } from "node:fs";
import { FALLBACK_ENTER_WITHHELD_MESSAGE } from "../../shared/submit-outcome.ts";
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

it.each([
  ["devin", "../fixtures/devin-3000.12.43-composer.txt", "../fixtures/devin-3000.12.43-trust.txt"],
  ["codex", "../../src/lib/fixtures-input-rows/codex-0.167.0/composer-empty-100.txt", "../../src/lib/fixtures-input-rows/codex-0.167.0/model-effort-40.txt"],
])("withholds the fallback Enter when a %s menu appears after the paste", async (agent, composerFile, menuFile) => {
  const { prompt, typed, keys } = herdr();
  spyOn(client, "paneGet").mockResolvedValue({ pane_id: "w:p1", agent, agent_status: "idle", cwd: "/tmp", terminal_id: `${agent}-test` } as Awaited<ReturnType<typeof client.paneGet>>);
  const menu = readFileSync(new URL(menuFile, import.meta.url), "utf8");
  let screen = readFileSync(new URL(composerFile, import.meta.url), "utf8");
  spyOn(client, "paneRead").mockImplementation(async () => ({ text: screen }) as Awaited<ReturnType<typeof client.paneRead>>);
  prompt.mockRejectedValue(new client.HerdrError("agent_not_ready", "fixture refusal"));
  typed.mockImplementation(async () => { screen = menu; });
  await expect(submitter()("w:p1", "hello agent", "hello agent", Date.now())).rejects.toMatchObject({
    code: "submit_partial", message: FALLBACK_ENTER_WITHHELD_MESSAGE,
  });
  expect(typed).toHaveBeenCalledTimes(1);
  expect(keys).not.toHaveBeenCalled();
});

it.each(["Up/Down and Enter.", "Up/Down to select a row, Enter to confirm."])("sends a Devin draft ending in %s after a fallback paste", async (ending) => {
  const { prompt, typed, keys } = herdr();
  spyOn(client, "paneGet").mockResolvedValue({ pane_id: "w:p1", agent: "devin", agent_status: "idle", cwd: "/tmp", terminal_id: "devin-test" } as Awaited<ReturnType<typeof client.paneGet>>);
  const composer = readFileSync(new URL("../fixtures/devin-3000.12.43-composer.txt", import.meta.url), "utf8");
  const message = `Document these keyboard shortcuts:\n${ending}`;
  let screen = composer;
  spyOn(client, "paneRead").mockImplementation(async () => ({ text: screen }) as Awaited<ReturnType<typeof client.paneRead>>);
  prompt.mockRejectedValue(new client.HerdrError("agent_not_ready", "fixture refusal"));
  typed.mockImplementation(async () => {
    screen = composer.replace(/^❭ .*$/m, () => `❭ ${message}`);
  });
  await submitter()("w:p1", message, message.replaceAll("\n", "\r"), Date.now());
  expect(typed).toHaveBeenCalledTimes(1);
  expect(keys).toHaveBeenCalledTimes(1);
  expect(keys).toHaveBeenCalledWith("w:p1", ["Enter"], undefined, expect.any(Function));
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
  spyOn(client, "paneRead").mockResolvedValue({ text: "dsh> " } as Awaited<ReturnType<typeof client.paneRead>>);
  prompt.mockRejectedValue(new client.HerdrError("agent_not_ready", "custom dsh agent"));
  await submitter()("w:p1", "hello dsh", "hello dsh", Date.now(), false);
  expect(typed).toHaveBeenCalledWith("w:p1", "hello dsh", undefined, expect.any(Function));
  expect(keys).toHaveBeenCalledWith("w:p1", ["Enter"], undefined, expect.any(Function));
});

// Devin's folder trust (Devin 3000.12.43), which herdr reports as Devin at rest: agent.prompt's paste and Enter would
// pick "Yes, trust" and the message would be lost
it("refuses a chat message over Devin's folder trust and writes nothing", async () => {
  const { prompt, typed, keys } = herdr();
  spyOn(client, "paneGet").mockResolvedValue({ pane_id: "w:p1", agent: "devin", agent_status: "idle", cwd: "/tmp", terminal_id: "devin-test" } as Awaited<ReturnType<typeof client.paneGet>>);
  const trust = readFileSync(new URL("../fixtures/devin-3000.12.43-trust.txt", import.meta.url), "utf8");
  spyOn(client, "paneRead").mockResolvedValue({ text: trust } as Awaited<ReturnType<typeof client.paneRead>>);
  const failed = await submitter()("w:p1", "hello devin", "hello devin", Date.now(), false).then(() => null, (error: unknown) => error);
  expect(failed).toBeInstanceOf(client.HerdrError);
  expect((failed as client.HerdrError).code).toBe("agent_blocked");
  expect(prompt).not.toHaveBeenCalled();
  expect(typed).not.toHaveBeenCalled();
  expect(keys).not.toHaveBeenCalled();
});

// the trust can come up after the read before agent.prompt: once herdr refuses the prompt, the paste typed instead
// would land in it, so the screen is read for a picker again right before that paste
it("types no chat message after a refused prompt once Devin's folder trust came up", async () => {
  const { prompt, typed, keys } = herdr();
  spyOn(client, "paneGet").mockResolvedValue({ pane_id: "w:p1", agent: "devin", agent_status: "idle", cwd: "/tmp", terminal_id: "devin-test" } as Awaited<ReturnType<typeof client.paneGet>>);
  const composer = readFileSync(new URL("../fixtures/devin-3000.12.43-composer.txt", import.meta.url), "utf8");
  const trust = readFileSync(new URL("../fixtures/devin-3000.12.43-trust.txt", import.meta.url), "utf8");
  let screen = composer;
  spyOn(client, "paneRead").mockImplementation(async () => ({ text: screen }) as Awaited<ReturnType<typeof client.paneRead>>);
  prompt.mockImplementation(async () => {
    screen = trust;
    throw new client.HerdrError("agent_not_ready", "fixture refusal");
  });
  const failed = await submitter()("w:p1", "hello devin", "hello devin", Date.now(), false).then(() => null, (error: unknown) => error);
  expect(prompt).toHaveBeenCalledTimes(1);
  expect(failed).toBeInstanceOf(client.HerdrError);
  expect((failed as client.HerdrError).code).toBe("agent_blocked");
  expect(typed).not.toHaveBeenCalled();
  expect(keys).not.toHaveBeenCalled();
});
