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

type TurnAnswer = Awaited<ReturnType<typeof codex.servedTurn>>;
/** A turn of the pane's thread as Codex's server names it, its end not told. */
const turnOf = (turn: "started" | "running"): TurnAnswer => ({ turn, over: new Promise<boolean>(() => {}) });

function codexPane(send: CommandSend | undefined, served: boolean, answer: Awaited<ReturnType<typeof codex.servedPlan>>, shown: string | null = "t1",
  turn: TurnAnswer = turnOf("started")) {
  const typed: string[] = [];
  const noted: unknown[] = [];
  const evidence: string[] = [];
  const asked: string[] = [];
  const turns: string[] = [];
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
  spyOn(codex, "servedTurn").mockImplementation(async (_pane, threadId, input, _id, mayWrite) => { turns.push(`${threadId}:${input}`); return mayWrite() ? turn : "unsent"; });
  spyOn(herdr, "agentPrompt").mockImplementation(async (_pane, text) => { typed.push(text); });
  spyOn(herdr, "paneSendText").mockImplementation(async (_pane, data) => { typed.push(data); });
  spyOn(herdr, "paneSendKeys").mockImplementation(async () => {});
  const submit = createSubmitText({ options: { submitDelayMs: 0 }, lastTyped: new Map(), attachments: new Map(), terminalAttach: async () => true,
    SUBMIT_DEADLINE_MS: 45_000, TYPED_SETTLE_MS: 0, DRAFT_CLEAR_WAIT_MS: 0, DRAFT_CLEAR_POLL_MS: 0, SUBMIT_DELAY_MS: 0 });
  return { typed, noted, evidence, asked, turns, submit: (text: string) => submit("p", text, text, Date.now()) };
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

it("sends a plain message to the Codex server Ovis started as a turn of the thread the pane shows, typing nothing", async () => {
  const pane = codexPane(undefined, true, "unsent");
  await pane.submit("Summarize the failing test, then fix it");
  expect(pane.turns).toEqual(["t1:Summarize the failing test, then fix it"]);
  expect(pane.typed).toEqual([]);
  expect(pane.noted).toHaveLength(1);
});

it("types a message the TUI reads itself, and one the server did not take, as before", async () => {
  for (const text of ["!ls", "/model", "look at @src/app.ts", "use $review", "see /home/user/paste-1.png", "what is in ./shot.png?", "open 'my shot.JPG'"]) {
    const pane = codexPane(undefined, true, "unsent");
    await pane.submit(text);
    expect(pane.turns).toEqual([]);
    expect(pane.typed).toHaveLength(1);
    mock.restore();
  }
  for (const [served, shown] of [[false, "t1"], [true, "t2"]] as const) {
    const pane = codexPane(undefined, served, "unsent", shown);
    await pane.submit("hello");
    expect(pane.turns).toEqual([]);
    expect(pane.typed).toHaveLength(1);
    mock.restore();
  }
  const left = codexPane(undefined, true, "unsent", "t1");
  spyOn(herdr, "paneGet").mockImplementation(async () => ({ pane_id: "p", terminal_id: "t", agent: "bash", agent_status: "idle", agent_session: null }) as unknown as HerdrPane);
  await left.submit("hello").catch(() => {});
  expect(left.turns).toEqual([]);
  mock.restore();
  // sent at once, it is the user's own send: typed also into a turn the server says the thread runs
  for (const answer of ["unsent", turnOf("running")] as const) {
    const refused = codexPane(undefined, true, "unsent", "t1", answer);
    await refused.submit("hello");
    expect(refused.turns).toEqual(["t1:hello"]);
    expect(refused.typed).toHaveLength(1);
    mock.restore();
  }
});

it("never types a message the server may have taken without answering", async () => {
  const pane = codexPane(undefined, true, "unsent", "t1", "unknown");
  await expect(pane.submit("hello")).rejects.toMatchObject({ code: "submit_changed" });
  expect(pane.typed).toEqual([]);
  expect(pane.noted).toEqual([]);
});

it("answers with the end of the turn Codex's server took a message sent at once as, for the queue to wait for", async () => {
  const over = Promise.resolve(true);
  const d = codexPane(undefined, true, "unsent", "t1", { turn: "started", over });
  const answer = await d.submit("hello");
  expect(answer && answer.over).toBe(over);
  expect(d.typed).toEqual([]);
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
