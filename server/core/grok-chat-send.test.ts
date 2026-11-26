import { afterEach, expect, it, mock, spyOn } from "bun:test";
import { readFileSync } from "node:fs";
import * as client from "../herdr/client.ts";
import { GROK_QUEUED_MESSAGE, GROK_SEND_UNCONFIRMED_MESSAGE, grokQueuedBehindMessage } from "../../shared/submit-outcome.ts";
import { createSubmitText } from "./composer.ts";
import { grokScreen } from "./grok-screen.fake.ts";

afterEach(() => mock.restore());

const submitter = () => createSubmitText({
  options: { submitDelayMs: 0 }, lastTyped: new Map(), attachments: new Map(), terminalAttach: async () => true,
  SUBMIT_DEADLINE_MS: 20_000, TYPED_SETTLE_MS: 0, DRAFT_CLEAR_WAIT_MS: 0, DRAFT_CLEAR_POLL_MS: 0, SUBMIT_DELAY_MS: 0,
});

/**
 * A stand-in Grok in pane w:p1, drawn as Grok 1.0.77 draws its screen (grok-screen.fake.ts). Enter on a typed prompt
 * queues it during a turn, and sends it at rest; Enter on its empty prompt sends the top queued row now; Enter on its
 * approval card answers it.
 */
function grok(options: { status?: string; herdr?: string; queued?: string[]; output?: string[]; minimal?: boolean; onQueued?: (state: GrokState) => void } = {}) {
  const state: GrokState = { status: options.status ?? "working", session: "s1", output: options.output ?? ["word1 word2 word3"], card: false, minimal: options.minimal ?? false, prompt: "", queue: [...options.queued ?? []], sent: [] };
  let queuedOnce = false;
  const enter = () => {
    if (state.card) { state.card = false; state.sent.push("<card answered>"); return; }
    if (state.prompt !== "") {
      if (state.status === "working") state.queue.push(state.prompt);
      else state.sent.push(state.prompt);
      state.prompt = "";
      if (!queuedOnce) { queuedOnce = true; options.onQueued?.(state); }
      return;
    }
    const top = state.queue.shift();
    if (top !== undefined) state.sent.push(top);
  };
  const prompt = spyOn(client, "agentPrompt").mockImplementation(async (_pane, text) => { state.prompt = text; enter(); });
  const typed = spyOn(client, "paneSendText").mockImplementation(async (_pane, text) => { state.prompt = text; });
  const keys = spyOn(client, "paneSendKeys").mockImplementation(async () => { enter(); });
  const read = spyOn(client, "paneRead").mockImplementation(async () => ({ text: grokScreen(state) } as Awaited<ReturnType<typeof client.paneRead>>));
  spyOn(client, "paneGet").mockImplementation(async () => ({
    pane_id: "w:p1", agent: "grok", agent_status: options.herdr ?? state.status, cwd: "/tmp", terminal_id: "t1",
    agent_session: { kind: "session", source: "herdr:grok", value: state.session },
  } as Awaited<ReturnType<typeof client.paneGet>>));
  return { state, prompt, typed, keys, read };
}
type GrokState = { status: string; session: string; output: string[]; card: boolean; minimal: boolean; prompt: string; queue: string[]; sent: string[] };

const sendNow = (text = "hello from chat") => submitter()("w:p1", text, text, Date.now(), false, undefined, undefined, undefined, false, false, true);
const failure = (sent: Promise<void>) => sent.then(() => null, (error: unknown) => error as client.HerdrError);

it("keeps a plain chat Send to a working Grok to the one Enter that queues it", async () => {
  const { state, prompt, typed, keys } = grok();
  await submitter()("w:p1", "hello from chat", "hello from chat", Date.now(), false);
  expect(prompt).toHaveBeenCalledTimes(1);
  expect(typed).not.toHaveBeenCalled();
  expect(keys).not.toHaveBeenCalled();
  expect(state.queue).toEqual(["hello from chat"]);
});

it("leaves Send now queued behind the rows the user queued in Grok before it, and says so", async () => {
  const { state, keys } = grok({ queued: ["row A", "row B"] });
  const failed = await failure(sendNow());
  expect(keys).not.toHaveBeenCalled();
  expect(state.sent).toEqual([]);
  expect(state.queue).toEqual(["row A", "row B", "hello from chat"]);
  expect(failed?.code).toBe("submit_changed");
  expect(failed?.message).toBe(grokQueuedBehindMessage(2));
});

it("presses one more Enter at most, even when Grok's queue footer does not leave", async () => {
  const { keys } = grok();
  keys.mockImplementation(async () => {});
  await sendNow();
  expect(keys).toHaveBeenCalledTimes(1);
});

it("sends a working Grok's queued Send now with one empty-prompt Enter", async () => {
  const { state, prompt, typed, keys } = grok();
  await sendNow();
  expect(prompt).toHaveBeenCalledTimes(1);
  expect(typed).not.toHaveBeenCalled();
  expect(keys).toHaveBeenCalledTimes(1);
  expect(keys).toHaveBeenCalledWith("w:p1", ["Enter"], undefined, expect.any(Function));
  expect(state.sent).toEqual(["hello from chat"]);
});

it("presses nothing into Grok's approval card and says the send is unconfirmed, the card in place of its prompt", async () => {
  const { state, keys } = grok({ onQueued: (grok) => { grok.card = true; } });
  const failed = await failure(sendNow());
  expect(keys).not.toHaveBeenCalled();
  expect(state.sent).toEqual([]);
  expect(failed?.code).toBe("submit_changed");
  expect(failed?.message).toBe(GROK_SEND_UNCONFIRMED_MESSAGE);
});

it("presses nothing and says the send is unconfirmed when no queued row is drawn while herdr reports Grok working", async () => {
  const { state, keys } = grok({ output: ["#1 hello from chat", "Enter:send now"], onQueued: (grok) => { grok.sent.push(grok.queue.pop()!); } });
  const failed = await failure(sendNow());
  expect(keys).not.toHaveBeenCalled();
  expect(state.sent).toEqual(["hello from chat"]);
  expect(failed?.message).toBe(GROK_SEND_UNCONFIRMED_MESSAGE);
});

it("presses nothing when the one queued row is not the message", async () => {
  const { state, keys } = grok({ onQueued: (grok) => { grok.sent.push(grok.queue.pop()!); grok.queue.push("typed in the terminal"); } });
  const failed = await failure(sendNow());
  expect(keys).not.toHaveBeenCalled();
  expect(state.queue).toEqual(["typed in the terminal"]);
  expect(failed?.message).toBe(GROK_SEND_UNCONFIRMED_MESSAGE);
});

it("leaves Send now in Grok's queue when another row was queued after it, as one row only is known to be the message", async () => {
  const { state, keys } = grok({ onQueued: (grok) => { grok.queue.push("queued from another device"); } });
  const failed = await failure(sendNow());
  expect(keys).not.toHaveBeenCalled();
  expect(state.queue).toEqual(["hello from chat", "queued from another device"]);
  expect(failed?.message).toBe(GROK_QUEUED_MESSAGE);
});

it("sends a multi-line message Grok draws as its first line and a count", async () => {
  const { state, keys } = grok();
  await submitter()("w:p1", "first line\nsecond line", "first line\rsecond line", Date.now(), false, undefined, undefined, undefined, false, false, true);
  expect(keys).toHaveBeenCalledTimes(1);
  expect(state.sent).toEqual(["first line\nsecond line"]);
});

it("reports the send as unconfirmed when the read after the queue Enter fails", async () => {
  const { state, prompt, keys, read } = grok();
  const draw = read.getMockImplementation()!;
  read.mockImplementation(async (...args) => {
    if (prompt.mock.calls.length > 0) throw new client.HerdrError("timeout", "herdr did not answer");
    return await draw(...args);
  });
  const failed = await failure(sendNow());
  expect(keys).not.toHaveBeenCalled();
  expect(state.queue).toEqual(["hello from chat"]);
  expect(failed?.message).toBe(GROK_SEND_UNCONFIRMED_MESSAGE);
});

it("presses nothing in minimal mode, where herdr says done during a turn, and says the message is queued", async () => {
  const { state, keys } = grok({ herdr: "done", minimal: true });
  const failed = await failure(sendNow());
  expect(keys).not.toHaveBeenCalled();
  expect(state.queue).toEqual(["hello from chat"]);
  expect(failed?.message).toBe(GROK_QUEUED_MESSAGE);
});

it("does not claim a minimal-mode send is done before the pending count is drawn (#3977)", async () => {
  const { state, prompt, read } = grok({ minimal: true });
  const draw = read.getMockImplementation()!;
  read.mockImplementation(async (...args) => {
    if (prompt.mock.calls.length === 0 || state.queue.length === 0) return await draw(...args);
    return { text: grokScreen({ ...state, queue: [] }) } as Awaited<ReturnType<typeof client.paneRead>>;
  });
  const failed = await failure(sendNow());
  expect(state.queue).toEqual(["hello from chat"]);
  expect(failed?.code).toBe("submit_changed");
});

it("does not confirm a send when minimal Grok shows Responding but herdr says done", async () => {
  const { state, keys, read } = grok({ herdr: "done", minimal: true });
  const screen = readFileSync(new URL("../../src/lib/fixtures-input-rows/grok-1.0.77/minimal-working-119.txt", import.meta.url), "utf8");
  const draw = read.getMockImplementation()!;
  read.mockImplementation(async (...args) => ({ ...await draw(...args), text: screen }));

  const failed = await failure(sendNow());

  expect(state.queue).toEqual(["hello from chat"]);
  expect(state.sent).toEqual([]);
  expect(keys).not.toHaveBeenCalled();
  expect(failed).toMatchObject({ code: "submit_changed", message: GROK_SEND_UNCONFIRMED_MESSAGE });
});

it("presses nothing while Grok's prompt holds text typed in the terminal", async () => {
  const { state, keys } = grok({ onQueued: (grok) => { grok.prompt = "git push --force origin ma"; } });
  const failed = await failure(sendNow());
  expect(keys).not.toHaveBeenCalled();
  expect(state.sent).toEqual([]);
  expect(state.prompt).toBe("git push --force origin ma");
  expect(failed?.message).toBe(GROK_QUEUED_MESSAGE);
});

it("says a minimal-mode Grok keeps the message behind the rows it counted before it", async () => {
  const { keys } = grok({ herdr: "done", minimal: true, queued: ["row A"] });
  const failed = await failure(sendNow());
  expect(keys).not.toHaveBeenCalled();
  expect(failed?.message).toBe(grokQueuedBehindMessage(1));
});

it("sends to a minimal-mode Grok at rest with the one Enter inside agent.prompt", async () => {
  const { state, keys } = grok({ status: "done", minimal: true });
  await sendNow();
  expect(keys).not.toHaveBeenCalled();
  expect(state.sent).toEqual(["hello from chat"]);
});

it("presses nothing once the pane holds another Grok session than the send began in", async () => {
  const { state, keys } = grok({ onQueued: (grok) => { grok.session = "s2"; grok.queue = ["row X of the new session"]; } });
  const failed = await failure(sendNow());
  expect(keys).not.toHaveBeenCalled();
  expect(state.sent).toEqual([]);
  expect(failed?.message).toBe(GROK_SEND_UNCONFIRMED_MESSAGE);
});

it("sends an idle Grok's chat message with the one Enter inside agent.prompt", async () => {
  const { state, prompt, typed, keys } = grok({ status: "idle" });
  await sendNow();
  expect(prompt).toHaveBeenCalledTimes(1);
  expect(typed).not.toHaveBeenCalled();
  expect(keys).not.toHaveBeenCalled();
  expect(state.sent).toEqual(["hello from chat"]);
});

it("sends Send now with one more Enter when another client started Grok's turn after the status read", async () => {
  const { state, prompt, keys } = grok({ status: "idle" });
  const type = prompt.getMockImplementation()!;
  prompt.mockImplementation(async (...args) => { state.status = "working"; await type(...args); });
  await sendNow();
  expect(keys).toHaveBeenCalledTimes(1);
  expect(state.sent).toEqual(["hello from chat"]);
  expect(state.queue).toEqual([]);
});

it("sends Send now to a Grok at rest with no more Enter when Grok echoes the message as the turn it started", async () => {
  const { state, keys } = grok({ status: "idle", onQueued: (grok) => { grok.status = "working"; grok.output.push(`❯ ${grok.sent.at(-1)!}`); } });
  await sendNow();
  expect(keys).not.toHaveBeenCalled();
  expect(state.sent).toEqual(["hello from chat"]);
});

it("says Send now is unconfirmed when a Grok read at rest runs another client's turn and has not drawn the message", async () => {
  const { state, keys } = grok({ status: "idle", onQueued: (grok) => { grok.status = "working"; grok.sent.pop(); grok.output.push("❯ from another device"); } });
  const failed = await failure(sendNow());
  expect(keys).not.toHaveBeenCalled();
  expect(state.sent).toEqual([]);
  expect(failed?.message).toBe(GROK_SEND_UNCONFIRMED_MESSAGE);
});

it("does not send another Enter when Grok's turn ends and runs the message before the empty prompt is reached", async () => {
  const { prompt, keys } = grok({ onQueued: (grok) => { grok.status = "idle"; grok.sent.push(grok.queue.shift()!); } });
  await sendNow();
  expect(prompt).toHaveBeenCalledTimes(1);
  expect(keys).not.toHaveBeenCalled();
});

it("does not paste the chat message again when the empty-prompt Enter fails", async () => {
  const { typed, keys } = grok();
  keys.mockRejectedValue(new client.HerdrError("timeout", "herdr did not answer"));
  const failed = await failure(sendNow());
  expect(failed).toBeInstanceOf(client.HerdrError);
  expect(failed?.code).toBe("submit_changed");
  expect(typed).not.toHaveBeenCalled();
  expect(keys).toHaveBeenCalledTimes(1);
});

it("sends the empty-prompt Enter when agent.prompt refuses and the chat paste fallback runs", async () => {
  const { state, prompt, typed, keys } = grok();
  prompt.mockRejectedValue(new client.HerdrError("agent_not_ready", "not ready"));
  await sendNow();
  expect(typed).toHaveBeenCalledTimes(1);
  expect(keys).toHaveBeenCalledTimes(2);
  expect(state.sent).toEqual(["hello from chat"]);
});

it("reports the chat paste fallback as unconfirmed when the empty-prompt Enter fails", async () => {
  const { prompt, typed, keys } = grok();
  prompt.mockRejectedValue(new client.HerdrError("agent_not_ready", "not ready"));
  const press = keys.getMockImplementation()!;
  let sent = 0;
  keys.mockImplementation(async (...args) => {
    if (++sent === 2) throw new client.HerdrError("submit_timeout", "the message waited too long behind earlier input; nothing was typed");
    await press(...args);
  });
  const failed = await failure(sendNow());
  expect(failed).toBeInstanceOf(client.HerdrError);
  expect(failed?.code).toBe("submit_changed");
  expect(typed).toHaveBeenCalledTimes(1);
});

it("reports the empty-prompt Enter as unconfirmed when the sender may no longer type", async () => {
  const { prompt, typed, keys } = grok();
  let armed = false;
  keys.mockImplementation(async (_pane, _keys, _socket, guard) => {
    armed = true;
    if (typeof guard === "function" && !guard()) throw new client.HerdrError("cancelled", "herdr was not sent");
  });
  const authorize = () => { if (armed) throw new client.HerdrError("read_only", "this connection is in observe mode"); };
  const failed = await failure(submitter()("w:p1", "hello from chat", "hello from chat", Date.now(), false, authorize, undefined, undefined, false, false, true));
  expect(prompt).toHaveBeenCalledTimes(1);
  expect(typed).not.toHaveBeenCalled();
  expect(failed).toBeInstanceOf(client.HerdrError);
  expect(failed?.code).toBe("submit_changed");
});

it("keeps the terminal input line to one Enter while Grok is working", async () => {
  const { prompt, typed, keys } = grok();
  await submitter()("w:p1", "ls", "ls", Date.now(), true);
  expect(prompt).not.toHaveBeenCalled();
  expect(typed).toHaveBeenCalledTimes(1);
  expect(keys).toHaveBeenCalledTimes(1);
  expect(keys).toHaveBeenCalledWith("w:p1", ["Enter"], undefined, expect.any(Function));
});
