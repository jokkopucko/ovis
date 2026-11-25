import { afterEach, expect, it, mock, spyOn } from "bun:test";
import * as herdr from "../herdr/client.ts";
import * as conversation from "../conversation.ts";
import * as prompt from "../prompt.ts";
import * as codex from "../approvals/codex.ts";
import { commandDataRoute, withDataRoutes } from "../command-data-send.ts";
import { createSubmitText } from "./composer.ts";
import type { CommandSend } from "../outcome.ts";
import type { HerdrPane, SlashCommand } from "../../shared/protocol.ts";

afterEach(() => mock.restore());

const sendOf = (text: string, name: string): CommandSend => ({
  id: "c1", text, at: Date.now(), agent: "codex", identity: "i", screen: "", form: null,
  invocations: [{ name, argument: "", form: null }],
});

function codexPane(send: CommandSend, served: boolean, answer: Awaited<ReturnType<typeof codex.servedPlan>>, shown: string | null = "t1") {
  const typed: string[] = [];
  const noted: unknown[] = [];
  const evidence: string[] = [];
  const asked: string[] = [];
  const pane = { pane_id: "p", terminal_id: "t", agent: "codex", agent_status: "idle", agent_session: shown === null ? null : { agent: "codex", source: "herdr:codex", kind: "id", value: shown } } as HerdrPane;
  spyOn(herdr, "paneGet").mockImplementation(async () => pane);
  spyOn(herdr, "paneRead").mockImplementation(async () => ({ text: "", revision: 0 }) as Awaited<ReturnType<typeof herdr.paneRead>>);
  spyOn(conversation, "paneProcessRoots").mockImplementation(async () => ({ omo: null, processes: undefined }) as Awaited<ReturnType<typeof conversation.paneProcessRoots>>);
  spyOn(prompt, "prepareCommandSend").mockReturnValue(send as ReturnType<typeof prompt.prepareCommandSend>);
  spyOn(prompt, "bindCommandProcess").mockImplementation(() => {});
  spyOn(prompt, "noteSubmitted").mockImplementation((_pane, _text, command) => { noted.push(command); });
  spyOn(prompt, "noteCommandEvidence").mockImplementation((_pane, _id, found) => { evidence.push(found.kind); });
  spyOn(codex, "servesCommands").mockReturnValue(served);
  spyOn(codex, "servedStatus").mockReturnValue(served ? { threadId: "t1", context: null, model: null } : null);
  spyOn(codex, "servedPlan").mockImplementation(async (_pane, threadId, mayWrite) => { asked.push(threadId); return mayWrite() ? answer : "unsent"; });
  spyOn(herdr, "agentPrompt").mockImplementation(async (_pane, text) => { typed.push(text); });
  spyOn(herdr, "paneSendText").mockImplementation(async (_pane, data) => { typed.push(data); });
  spyOn(herdr, "paneSendKeys").mockImplementation(async () => {});
  const submit = createSubmitText({ options: { submitDelayMs: 0 }, lastTyped: new Map(), attachments: new Map(), terminalAttach: async () => true,
    SUBMIT_DEADLINE_MS: 45_000, TYPED_SETTLE_MS: 0, DRAFT_CLEAR_WAIT_MS: 0, DRAFT_CLEAR_POLL_MS: 0, SUBMIT_DELAY_MS: 0 });
  return { typed, noted, evidence, asked, submit: (text: string) => submit("p", text, text, Date.now()) };
}

it("sends a bare /plan to the Codex server Ovis started, typing nothing, and takes its answer as the result", async () => {
  const pane = codexPane(sendOf("/plan", "plan"), true, "applied");
  await pane.submit("/plan");
  expect(pane.asked).toEqual(["t1"]);
  expect(pane.typed).toEqual([]);
  expect(pane.noted).toHaveLength(1);
  expect(pane.evidence).toEqual(["native"]);
});

it("sends /plan where herdr reports no session for the pane, as herdr-core does", async () => {
  const pane = codexPane(sendOf("/plan", "plan"), true, "applied", null);
  await pane.submit("/plan");
  expect(pane.asked).toEqual(["t1"]);
  expect(pane.typed).toEqual([]);
});

it("types /plan where Ovis has no server for the pane, the TUI shows another thread, or the server sent nothing", async () => {
  const unserved = codexPane(sendOf("/plan", "plan"), false, "applied");
  await unserved.submit("/plan");
  expect(unserved.asked).toEqual([]);
  expect(unserved.typed).toHaveLength(1);
  mock.restore();
  const resumed = codexPane(sendOf("/plan", "plan"), true, "applied", "t2");
  await resumed.submit("/plan");
  expect(resumed.asked).toEqual([]);
  expect(resumed.typed).toHaveLength(1);
  mock.restore();
  const unsent = codexPane(sendOf("/plan", "plan"), true, "unsent");
  await unsent.submit("/plan");
  expect(unsent.typed).toHaveLength(1);
});

it("never types a /plan the server may have taken without answering", async () => {
  const pane = codexPane(sendOf("/plan", "plan"), true, "unknown");
  await expect(pane.submit("/plan")).rejects.toMatchObject({ code: "timeout" });
  expect(pane.typed).toEqual([]);
  expect(pane.noted).toEqual([]);
});

it("routes only Codex's bare /plan and /compact", () => {
  expect(commandDataRoute(sendOf("/plan", "plan"), "/plan ")).toEqual({ agent: "codex", kind: "plan" });
  expect(commandDataRoute(sendOf("/plan", "plan"), " /plan")).toBeNull();
  expect(commandDataRoute(sendOf("/compact", "compact"), "/compact")).toBeNull();
  expect(commandDataRoute(sendOf("/plan fix it", "plan"), "/plan fix it")).toBeNull();
  expect(commandDataRoute(sendOf("/model", "model"), "/model")).toBeNull();
});

it("offers /plan again only in a pane whose Codex server Ovis serves", () => {
  const rows: SlashCommand[] = [
    { name: "plan", description: "", source: "builtin", chatPaletteHidden: true },
    { name: "plan", description: "", source: "skill", chatPaletteHidden: true },
  ];
  spyOn(codex, "servesCommands").mockReturnValue(true);
  expect(withDataRoutes("codex", "p", rows).map((row) => row.chatPaletteHidden)).toEqual([undefined, true]);
  expect(withDataRoutes("claude", "p", rows)).toBe(rows);
  spyOn(codex, "servesCommands").mockReturnValue(false);
  expect(withDataRoutes("codex", "p", rows)).toBe(rows);
});
