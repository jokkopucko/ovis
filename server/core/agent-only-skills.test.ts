import { afterEach, expect, it, mock, spyOn } from "bun:test";
import * as herdr from "../herdr/client.ts";
import * as conversation from "../conversation.ts";
import * as prompt from "../prompt.ts";
import * as native from "../opencode-native.ts";
import { closeMention, createSubmitText } from "./composer.ts";
import type { HerdrPane } from "../../shared/protocol.ts";

afterEach(() => mock.restore());

// #511: typing a message key by key to attach OpenCode's @skills checks the agent between writes, never with
// them; a message for an agent alone goes whole through herdr's agent.prompt, its @skills left as text
it("sends an agent-only message naming an OpenCode @skill through agent.prompt, typing nothing", async () => {
  const writes: string[] = [];
  const prompts: string[] = [];
  const pane = { pane_id: "p", terminal_id: "t", agent: "opencode", agent_status: "idle" } as HerdrPane;
  spyOn(herdr, "paneGet").mockImplementation(async () => pane);
  spyOn(conversation, "paneProcessRoots").mockImplementation(async () => ({ omo: null, processes: undefined }) as Awaited<ReturnType<typeof conversation.paneProcessRoots>>);
  spyOn(prompt, "prepareCommandSend").mockReturnValue({} as ReturnType<typeof prompt.prepareCommandSend>);
  spyOn(prompt, "bindCommandProcess").mockImplementation(() => {});
  const noted: unknown[] = [];
  spyOn(prompt, "noteSubmitted").mockImplementation((_pane, _text, command) => { noted.push(command); });
  spyOn(native, "openCodeSkillsToType").mockImplementation(async (_pane, sent) => ({ sent, skills: ["effect"] }));
  spyOn(native, "startOpenCodeWatch").mockReturnValue(null);
  spyOn(herdr, "agentPrompt").mockImplementation(async (_pane, text) => { prompts.push(text); });
  spyOn(herdr, "paneSendText").mockImplementation(async (_pane, data) => { writes.push(data); });
  spyOn(herdr, "paneSendKeys").mockImplementation(async (_pane, keys) => { writes.push(keys.join("+")); });
  const submit = createSubmitText({ options: { submitDelayMs: 0 }, lastTyped: new Map(), attachments: new Map(), terminalAttach: async () => true,
    SUBMIT_DEADLINE_MS: 45_000, TYPED_SETTLE_MS: 0, DRAFT_CLEAR_WAIT_MS: 0, DRAFT_CLEAR_POLL_MS: 0, SUBMIT_DELAY_MS: 0 });
  await submit("p", "> backup.txt\nrm backup.txt\n@effect", "> backup.txt\rrm backup.txt\r@effect", Date.now(), false, () => {}, undefined, undefined, false, true);
  expect(writes).toEqual([]);
  expect(prompts).toEqual([closeMention("> backup.txt\nrm backup.txt\n@effect")]);
  expect(noted).toEqual([expect.objectContaining({ unattached: ["effect"] })]);
});
