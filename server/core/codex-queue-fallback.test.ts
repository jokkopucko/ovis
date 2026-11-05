import { afterEach, expect, it, mock, spyOn } from "bun:test";
import * as herdr from "../herdr/client.ts";
import * as conversation from "../conversation.ts";
import * as prompt from "../prompt.ts";
import * as native from "../opencode-native.ts";
import { createSubmitText } from "./composer.ts";
import type { HerdrPane } from "../../shared/protocol.ts";

afterEach(() => mock.restore());

const QUEUE_SCREEN = "• WAITING\n• Queued follow-up inputs\n  ? 2 questions · 8s\n    alt+↑ to answer\n› Ask Codex to do anything\n  GPT-6-Sol xhigh · ~/lab · Context 97% left\n";

/** Codex blocked only by its collapsed question queue; `exitsOnRead`: it exits while that screen is read. */
function codexQueue(exitsOnRead: boolean) {
  let alive = true;
  const writes: string[] = [];
  const pane = { pane_id: "p", terminal_id: "t", agent: "codex", agent_status: "blocked" } as HerdrPane;
  spyOn(herdr, "paneGet").mockImplementation(async () => ({ ...pane, agent: alive ? "codex" : null }));
  spyOn(conversation, "paneProcessRoots").mockImplementation(async () => ({ omo: null, processes: undefined }) as Awaited<ReturnType<typeof conversation.paneProcessRoots>>);
  spyOn(prompt, "prepareCommandSend").mockReturnValue(undefined);
  spyOn(prompt, "bindCommandProcess").mockImplementation(() => {});
  spyOn(prompt, "noteSubmitted").mockImplementation(() => {});
  spyOn(native, "openCodeSkillsToType").mockImplementation(async (_pane, sent) => ({ sent, skills: [] }));
  spyOn(native, "startOpenCodeWatch").mockReturnValue(null);
  spyOn(herdr, "agentPrompt").mockImplementation(async () => { throw new herdr.HerdrError("agent_blocked", "questions collapsed"); });
  spyOn(herdr, "paneRead").mockImplementation(async () => {
    if (exitsOnRead) alive = false;
    return { text: QUEUE_SCREEN } as Awaited<ReturnType<typeof herdr.paneRead>>;
  });
  spyOn(herdr, "paneSendText").mockImplementation(async (_pane, data) => { writes.push(data); });
  spyOn(herdr, "paneSendKeys").mockImplementation(async (_pane, keys) => { writes.push(keys.join("+")); });
  const submit = createSubmitText({ options: { submitDelayMs: 0 }, lastTyped: new Map(), attachments: new Map(), terminalAttach: async () => true,
    SUBMIT_DEADLINE_MS: 45_000, TYPED_SETTLE_MS: 0, DRAFT_CLEAR_WAIT_MS: 0, DRAFT_CLEAR_POLL_MS: 0, SUBMIT_DELAY_MS: 0 });
  const send = (agentOnly: boolean) => submit("p", "> quoted\ncomment", "> quoted\rcomment", Date.now(), false, () => {}, undefined, undefined, false, agentOnly);
  return { writes, send };
}

// the queue's screen is Codex's only while Codex still runs once it is read
it("types nothing when Codex exits while its collapsed queue is read", async () => {
  const { writes, send } = codexQueue(true);
  await expect(send(false)).rejects.toMatchObject({ code: "agent_blocked" });
  expect(writes).toEqual([]);
});

// #511: herdr cannot type only if the agent still runs, so a message for an agent alone never takes the raw fallback
it("refuses an agent-only message while Codex's collapsed queue blocks its prompt, and types nothing", async () => {
  const { writes, send } = codexQueue(false);
  await expect(send(true)).rejects.toMatchObject({ code: "agent_blocked" });
  expect(writes).toEqual([]);
});

it("still types an ordinary message into Codex while only its collapsed queue blocks it (control)", async () => {
  const { writes, send } = codexQueue(false);
  await send(false);
  expect(writes).toEqual(["> quoted\rcomment", "Enter"]);
});
