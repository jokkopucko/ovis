import { describe, expect, setSystemTime, spyOn, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InteractivePrompt, PromptAnswer } from "../shared/protocol.ts";
import { handlePromptRequest, KeyRefused, parseInteractivePrompt, type PromptRequestOptions } from "./prompt.ts";

/** A deadline a move that cannot finish reaches at once, so no test waits out the real 4 s */
const SHORT: PromptRequestOptions = { answerDeadlineMs: 300 };
import { omoAskOf } from "./omo-questions.ts";
import { ANSI_RE, type OmoAsk, parsedByPublicPrompt } from "./dialogs/shared.ts";
import * as conversation from "./conversation.ts";
import { ConversationUnavailable } from "./conversation-shared.ts";

// The card moves between a form's questions without answering, as the agent's own keys do: OmO's
// Tab and Shift+Tab, Codex's ←/→, Hermes's Tab and Shift+Tab. Each key is sent alone and the
// screen must show the question it moves to before the next one.

const fixture = (name: string): string => readFileSync(join(import.meta.dir, "fixtures", `question-steps-${name}`), "utf8");
// omo 5.1.51 and Codex 0.166 as captured in a 120x40 herdr pane (fixtures/question-steps-captures.md)
const OMO_SCREENS = ["q1", "q2", "q3", "review"].map((state) => fixture(`omo-5.1.51-${state}.txt`));
/** omo's form of three questions: `at` 3 is its Submit tab. */
const omo = (at: number): string => OMO_SCREENS[at]!;
const OMO_TYPING = fixture("omo-5.1.51-q1-typing.txt");
/** the session's record of the ask_user_question call behind those screens */
const OMO_SESSION_CALL = fixture("omo-5.1.51.jsonl").split("\n")[0]!;
const CODEX_SCREENS = ["q1", "q2"].map((state) => fixture(`codex-0.166.0-${state}.txt`));
/** Codex's request_user_input with two questions. */
const codex = (at: number): string => CODEX_SCREENS[at]!;

const HERMES_HINT = "answered · ↑/↓ select · Enter confirm and continue · Tab/Shift+Tab switch question · Esc/Ctrl+C cancel";
const HERMES: readonly (readonly [string, readonly string[]])[] = [["Pick a colour", ["Red", "Blue"]], ["Pick a size", ["Small", "Large"]], ["Pick a shape", ["Circle", "Square"]]];
const HERMES_OPEN: readonly (readonly [string, readonly string[]])[] = [["Pick a colour", ["Red", "Blue"]], ["Name a fruit", []], ["Pick a shape", ["Circle", "Square"]]];

/** Hermes's clarify batch (ui-tui prompts.tsx): `✓` answered, `▸` the open one expanded, `·` waiting. */
function hermes(at: number, answered: number[] = [], questions = HERMES, typing = false): string {
  const lines = questions.flatMap(([question, choices], index) => [
    ` ${answered.includes(index) ? "✓" : index === at ? "▸" : "·"} ${question}`,
    ...(answered.includes(index) ? [`   ${choices[0] ?? "Apple"}`] : []),
    ...(index !== at ? [] : choices.length === 0 || typing ? ["   > "] : [...choices, "Other (type your answer)"].map((choice, row) => `   ${row === 0 ? "▸" : " "} ${row + 1}. ${choice}`)),
  ]);
  const hint = typing ? "answered · Enter confirm and continue · Esc back" : HERMES_HINT;
  return `\n ask 3 questions\n${lines.join("\n")}\n ${answered.length}/3 ${hint}\n ─ (⌐■_■) deliberating…  · 10s │ opus 5.5\n`;
}

const navigable = (prompt: InteractivePrompt | null) => prompt?.steps?.map((step) => step.can_navigate === true);

/** The session's ask_user_question call behind omo(): the card moves only on a form it can name by its questions. */
const OMO_CALL: OmoAsk = omoAskOf({ id: "session.jsonl\0toolu_qs", wait: true, args: (JSON.parse(OMO_SESSION_CALL) as { message: { content: { arguments: unknown }[] } }).message.content[0]!.arguments })!;
const omoCard = (screen: string, ask: OmoAsk | null = OMO_CALL) => parseInteractivePrompt("pi", screen, ask, true, ask ? [ask] : []);

const QUESTIONS: readonly (readonly [string, string, readonly string[]])[] = [
  ["Color", "Which color?", ["Red", "Blue"]],
  ["Size", "Which size?", ["Small", "Large"]],
  ["Shape", "Which shape?", ["Circle", "Square"]],
];

/** omp 18.13.2 Ask: TabBar's active cell has selectedBg; inactive cells have muted foreground. */
function omp(at: number, wrapped = false, questions = QUESTIONS): string {
  const tabs = [...questions.map(([header]) => header), "Submit"].map((label, index) =>
    index === at ? `\x1b[1m\x1b[48;2;40;49;58m\x1b[38;2;240;240;240m ${label} \x1b[0m`
      : `\x1b[38;2;130;130;130m ${label} \x1b[39m`);
  const header = wrapped ? tabs.map(tab => `│ ${tab} │`).join("\n") : `│ ${tabs.join("  ")} │`;
  const body = at === 3
    ? `│ Review answers │\n├────────────────────────────────────┤\n│ 3 unanswered questions; Enter still submits. │\n│ 1. Color: unanswered │\n│ 2. Size: unanswered │\n│ 3. Shape: unanswered │\n│ ❯ Submit │\n├────────────────────────────────────┤\n│ ⏎ submit · ↑/↓ scroll · ⎋ cancel │`
    : `│ ${questions[at]?.[1]} │\n├────────────────────────────────────┤\n│ ❯ ○ ${questions[at]?.[2][0]} │\n│   ○ ${questions[at]?.[2][1]} │\n│   ○ Other (type your own) │\n├────────────────────────────────────┤\n│ ⏎ select · n note · ↑/↓ move · ⇥/←/→ question · ⎋ cancel │`;
  return `╭─ Ask ──────────────────────────────╮\n${header}\n${body}\n╰────────────────────────────────────╯`;
}

describe("omp Ask question steps", () => {
  test("marks only answers proved by the native review rows", () => {
    const review = omp(3).replace("Color: unanswered", "Color: Red").replace("Shape: unanswered", "Shape:");
    const prompt = parseInteractivePrompt("omp", review);
    expect(prompt?.steps?.map(step => step.answered)).toEqual([true, false, false, false]);
    expect(prompt?.answers?.map(answer => answer.answer)).toEqual(["Red", "unanswered", null]);
  });

  test.each([false, true])("reads every question and review from an unambiguous styled strip, wrapped=%s", wrapped => {
    for (let at = 0; at < 4; at++) {
      const prompt = parseInteractivePrompt("omp", omp(at, wrapped));
      expect(prompt).not.toBeNull();
      expect(prompt?.steps?.map(step => step.label)).toEqual(["Color", "Size", "Shape", "Submit"]);
      expect(prompt?.steps?.findIndex(step => step.current)).toBe(at);
      // the review (Submit) is never a step to go to: nothing on it names the call
      expect(navigable(prompt)).toEqual([0, 1, 2, 3].map(index => index !== at && index < 3));
      expect(prompt?.can_step_back ?? false).toBe(at > 0);
      expect(prompt?.can_step_next ?? false).toBe(at < 2);
    }
  });

  test.each(["plain", "two-active", "clipped", "duplicate", "no-hint"] as const)("offers no steps for ambiguous or incomplete evidence: %s", kind => {
    let screen = omp(0);
    if (kind === "plain") screen = screen.replace(ANSI_RE, "");
    if (kind === "two-active") screen = screen.replace("\x1b[38;2;130;130;130m Size", "\x1b[48;5;20m\x1b[38;2;130;130;130m Size");
    if (kind === "clipped") screen = screen.replace(" Shape ", " Sha… ");
    if (kind === "duplicate") screen = screen.replace(" Size ", " Color ");
    if (kind === "no-hint") screen = screen.replace(" · ⇥/←/→ question", "");
    const prompt = parseInteractivePrompt("omp", screen);
    expect(prompt).not.toBeNull();
    expect(prompt?.steps).toBeUndefined();
    expect(prompt?.can_step_back ?? false).toBe(false);
    expect(prompt?.can_step_next ?? false).toBe(false);
  });
});

describe("OmO's form: the card goes to another question as Tab and Shift+Tab do", () => {
  test("every other question is a step to tap, with Back and Next", () => {
    const first = omoCard(omo(0));
    expect(first).toMatchObject({ agent: "omo", title: "Question 1 of 3", can_step_next: true });
    expect(first?.can_step_back ?? false).toBe(false);
    expect(navigable(first)).toEqual([false, true, true]);
    const second = omoCard(omo(1));
    expect(second).toMatchObject({ title: "Question 2 of 3", can_step_back: true, can_step_next: true });
    expect(navigable(second)).toEqual([true, false, true]);
    // Next on the last question goes on to the review, as Tab does
    expect(omoCard(omo(2))).toMatchObject({ can_step_back: true, can_step_next: true });
  });

  test("a form no session call names is shown with its steps, and offers no move", () => {
    const unnamed = omoCard(omo(0), null);
    expect(unnamed?.steps?.map((step) => step.label)).toEqual(["Color", "Size", "Shape"]);
    expect(navigable(unnamed)).toEqual([false, false, false]);
    expect(unnamed?.can_step_next ?? false).toBe(false);
    // another call whose questions differ is another form: its identity says so
    const other: OmoAsk = { ...OMO_CALL, questions: OMO_CALL.questions.map((question, at) => at === 2 ? { ...question, options: [{ label: "Circle", description: null }, { label: "Triangle", description: null }] } : question) };
    const ids = [omoCard(omo(1)), omoCard(omo(1), other)].map((prompt) => parsedByPublicPrompt.get(prompt!)?.nativeSteps?.identity);
    expect(ids[0]).toBeDefined();
    expect(ids[1]).toBeDefined();
    expect(ids[0]).not.toBe(ids[1]);
  });

  test("the review goes back to any question, and has no Next", () => {
    const review = omoCard(omo(3));
    expect(review).toMatchObject({ title: "Review your answers", can_step_back: true });
    expect(review?.can_step_next ?? false).toBe(false);
    expect(navigable(review)).toEqual([true, true, true]);
  });

  test("an answer typed in the terminal holds the form: Tab would save it, so no step is offered", () => {
    const typing = OMO_TYPING;
    const prompt = omoCard(typing);
    expect(prompt?.kind).toBe("menu");
    expect(navigable(prompt)).toEqual([false, false, false]);
    expect(prompt?.can_step_back ?? false).toBe(false);
    expect(prompt?.can_step_next ?? false).toBe(false);
  });
});

describe("Codex's questions: the card goes back and on as ←/→ do", () => {
  test("Back after the first question, Next before the last", () => {
    const first = parseInteractivePrompt("codex", codex(0));
    expect(first).toMatchObject({ title: "Question 1 of 2", can_step_next: true });
    expect(first?.can_step_back ?? false).toBe(false);
    const last = parseInteractivePrompt("codex", codex(1));
    expect(last).toMatchObject({ title: "Question 2 of 2", can_step_back: true });
    expect(last?.can_step_next ?? false).toBe(false);
  });

  test("a hint without ←/→ offers neither", () => {
    const prompt = parseInteractivePrompt("codex", codex(0).replace(" | ←/→ to navigate questions", ""));
    expect(prompt?.title).toBe("Question 1 of 2");
    expect(prompt?.can_step_back ?? false).toBe(false);
    expect(prompt?.can_step_next ?? false).toBe(false);
  });
});

describe("Hermes's clarify batch: the card goes to another open question as Tab and Shift+Tab do", () => {
  test("each question is a step; the open ones can be gone to", () => {
    const prompt = parseInteractivePrompt("hermes", hermes(0));
    expect(prompt?.question).toBe("Pick a colour");
    expect(prompt?.steps?.map((step) => [step.label, step.answered, step.current])).toEqual([["Pick a colour", false, true], ["Pick a size", false, false], ["Pick a shape", false, false]]);
    // one key at a time: Hermes draws no options for the questions past the next one, so nothing names them
    expect(navigable(prompt)).toEqual([false, true, false]);
    expect(prompt).toMatchObject({ can_step_next: true });
    expect(prompt?.can_step_back ?? false).toBe(false);
  });

  test("the batch is named by every question, which are answered and the answer drawn under each", () => {
    const identity = (screen: string) => parsedByPublicPrompt.get(parseInteractivePrompt("hermes", screen)!)?.nativeSteps?.identity;
    const open = identity(hermes(1));
    expect(open).toBeDefined();
    // the same three questions: the first answered, or answered otherwise, is another batch
    expect(identity(hermes(1, [0]))).not.toBe(open);
    expect(identity(hermes(1, [0]).replace("   Red\n", "   Blue\n"))).not.toBe(identity(hermes(1, [0])));
  });

  test("an answered question shows no open marker once Tab is on it: nothing past it is offered", () => {
    const prompt = parseInteractivePrompt("hermes", hermes(0, [1]));
    expect(prompt?.steps?.map((step) => step.answered)).toEqual([false, true, false]);
    expect(navigable(prompt)).toEqual([false, false, false]);
    expect(prompt?.can_step_next ?? false).toBe(false);
  });
});

describe("Hermes's open-ended question in a batch", () => {
  test("keeps the batch's steps, Back and Next, as Tab moves through it", () => {
    const prompt = parseInteractivePrompt("hermes", hermes(1, [], HERMES_OPEN));
    expect(prompt?.question).toBe("Name a fruit");
    expect(prompt?.custom_option_index).toBe(0);
    expect(prompt?.steps?.map((step) => [step.label, step.current])).toEqual([["Pick a colour", false], ["Name a fruit", true], ["Pick a shape", false]]);
    expect(prompt).toMatchObject({ can_step_back: true, can_step_next: true });
  });

  test("while an answer is typed, Tab does nothing in Hermes: no move is offered", () => {
    const prompt = parseInteractivePrompt("hermes", hermes(1, [], HERMES_OPEN, true));
    expect(prompt?.question).toBe("Name a fruit");
    expect(navigable(prompt)).toEqual([false, false, false]);
    expect(prompt?.can_step_back ?? false).toBe(false);
    expect(prompt?.can_step_next ?? false).toBe(false);
  });
});

interface Pane { agent: string; screen: string; sent: string[]; visible?: string; ompCall?: (id: string, changed?: "question" | "option") => void; onSent?: (key: string) => void; onRpc?: (method: string) => number | void; cwd?: string; omo?: { pid: number; path: string } }

async function withPane(agent: string, screen: string, run: (pane: Pane) => Promise<void>, questions = QUESTIONS): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "question-steps-"));
  const path = join(root, "herdr.sock");
  const pane: Pane = { agent, screen, sent: [] };
  const transcript = join(root, "session.jsonl");
  if (agent === "omp") {
    pane.ompCall = (id, changed) => appendFileSync(transcript, JSON.stringify({ type: "message", message: { role: "user", content: "Ask again" } }) + "\n" + JSON.stringify({
      type: "message", message: { role: "assistant", content: [{ type: "toolCall", id, name: "ask", arguments: {
        questions: questions.map(([header, question, options], index) => ({ id: header, header,
          question: changed === "question" && index === 0 ? "A different question?" : question,
          options: options.map((label, option) => ({ label: changed === "option" && index === 0 && option === 0 ? "Orange" : label })) })),
      } }] },
    }) + "\n");
    pane.ompCall("initial");
  }
  // Session authorization is not under test; the real reader still consumes each call record.
  const resolveTranscript = agent === "omp" ? spyOn(conversation, "ompTranscriptPath").mockResolvedValue({ path: transcript, blobs: null }) : null;
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => undefined);
    let input = "";
    socket.on("data", (chunk) => {
      input += chunk.toString();
      if (!input.includes("\n")) return;
      const request = JSON.parse(input.split("\n")[0]!) as { id: string; method: string; params: { keys?: string[]; text?: string; format?: string } };
      // a herdr that holds its reply this long (ms)
      const stall = pane.onRpc?.(request.method);
      const answer = (result: unknown) => {
        const reply = () => socket.end(`${JSON.stringify({ id: request.id, result })}\n`);
        if (typeof stall === "number") setTimeout(reply, stall);
        else reply();
      };
      if (request.method === "session.snapshot") return answer({ snapshot: { panes: [{ pane_id: "p_1", agent: pane.agent, agent_status: "blocked", cwd: pane.cwd ?? (pane.agent === "omp" ? root : undefined), ...(pane.omo ? { agent_session: { agent: "omo", kind: "path", value: pane.omo.path } } : {}) }], layouts: [] } });
      if (request.method === "pane.read") return answer({ read: { text: pane.agent === "omp" ? request.params.format === "ansi" ? pane.visible ?? pane.screen : pane.screen.replace(ANSI_RE, "") : pane.screen } });
      if (request.method === "pane.get") return answer({ pane: { pane_id: "p_1", scroll: { offset_from_bottom: 0 } } });
      if (request.method === "pane.process_info") return answer({ process_info: { foreground_processes: pane.omo ? [{ pid: pane.omo.pid, argv: ["omo"] }] : ["codex", "omp"].includes(pane.agent) ? [{ pid: 2147483647, argv: [`/usr/bin/${pane.agent}`] }] : [] } });
      if (request.method === "agent.get") return answer({ agent: {} });
      if (request.method !== "pane.send_keys" && request.method !== "pane.send_text") throw new Error(`unexpected fixture RPC: ${request.method}`);
      for (const sent of request.params.keys ?? [`text:${request.params.text}`]) {
        pane.sent.push(sent);
        pane.onSent?.(sent);
      }
      answer({});
    });
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(path, resolve); });
  const previous = process.env["HERDR_SOCKET"];
  process.env["HERDR_SOCKET"] = path;
  try { await run(pane); } finally {
    resolveTranscript?.mockRestore();
    if (previous === undefined) delete process.env["HERDR_SOCKET"];
    else process.env["HERDR_SOCKET"] = previous;
    for (const socket of sockets) socket.destroy();
    server.close();
    rmSync(root, { recursive: true, force: true });
  }
}

/**
 * An omo pane whose session holds the call behind omo(): an inert child gives the pane a real process environment
 * (OMO_CODING_AGENT_DIR), read through /proc as for a live omo, so Linux only.
 */
async function withOmoPane(screen: string, run: (pane: Pane) => Promise<void>, record = OMO_SESSION_CALL): Promise<void> {
  await withPane("pi", screen, async (pane) => {
    const root = mkdtempSync(join(tmpdir(), "question-steps-omo-"));
    const agentDir = join(root, "agent");
    mkdirSync(join(agentDir, "sessions"), { recursive: true });
    pane.cwd = root;
    const path = join(agentDir, "sessions", "2026-11-01T00-00-00_qs-session.jsonl");
    writeFileSync(path, JSON.stringify({ type: "session", id: "qs-session", cwd: root, timestamp: new Date().toISOString() }) + "\n" + record + "\n");
    const child = Bun.spawn([process.execPath, "-e", "process.stdout.write('ready\\n'); process.stdin.resume()"], { cwd: root, stdin: "pipe", stdout: "pipe", stderr: "ignore", env: { ...process.env, OMO_CODING_AGENT_DIR: agentDir } });
    // running its own code, so /proc shows its environment and not the one it started from
    await child.stdout.getReader().read();
    pane.omo = { pid: child.pid, path };
    try { await run(pane); } finally {
      child.kill();
      await child.exited;
      rmSync(root, { recursive: true, force: true });
    }
  });
}

async function card(): Promise<InteractivePrompt> {
  const url = new URL("http://127.0.0.1/api/pane/prompt?pane_id=p_1");
  const prompt = ((await (await handlePromptRequest(new Request(url), url, {}))!.json()) as { prompt: InteractivePrompt | null }).prompt;
  expect(prompt).not.toBeNull();
  return prompt!;
}

async function move(promptId: string, action: Omit<PromptAnswer, "pane_id" | "prompt_id">, options: PromptRequestOptions = {}): Promise<{ status: number; code?: string }> {
  const url = new URL("http://127.0.0.1/api/pane/prompt/answer");
  const response = (await handlePromptRequest(new Request(url, { method: "POST", body: JSON.stringify({ pane_id: "p_1", prompt_id: promptId, ...action }) }), url, options))!;
  const body = await response.json() as { error?: { code: string } };
  return { status: response.status, code: body.error?.code };
}

/** A pane whose form moves as the agent's keys move it, wrapping as they do. */
function follows(pane: Pane, draw: (at: number) => string, count: number, next: string, previous: string, start = 0): void {
  let at = start;
  pane.onSent = (key) => {
    if (key === next) at = (at + 1) % count;
    if (key === previous) at = (at + count - 1) % count;
    pane.screen = draw(at);
  };
}

describe("the answer route moves between questions, one key at a time, each seen", () => {
  test.each(["question", "option"] as const)("omp: a call whose %s differs from the displayed question offers no moves", async changed => {
    await withPane("omp", omp(0), async pane => {
      pane.ompCall?.("ahead-of-screen", changed);
      const prompt = await card();
      expect(prompt.steps?.some(step => step.can_navigate)).toBe(false);
      expect((await move(prompt.id, { step_next: true })).status).toBe(400);
      expect(pane.sent).toEqual([]);
    });
  });

  test("omp: Next, a forward step and Back send only tab keys without answering", async () => {
    await withPane("omp", omp(0), async pane => {
      follows(pane, omp, 4, "tab", "shift+tab");
      expect(await move((await card()).id, { step_next: true })).toEqual({ status: 200, code: undefined });
      expect((await card()).question).toBe("Which size?");
      expect(await move((await card()).id, { step_index: 2 })).toEqual({ status: 200, code: undefined });
      expect((await card()).question).toBe("Which shape?");
      expect(await move((await card()).id, { step_back: true })).toEqual({ status: 200, code: undefined });
      expect((await card()).question).toBe("Which size?");
      expect(pane.sent).toEqual(["tab", "tab", "shift+tab"]);
    });
  });

  test("omp: the review draws no question of the call, so neither it nor a move onto it is offered", async () => {
    await withPane("omp", omp(2), async pane => {
      const last = await card();
      expect(last.steps?.at(-1)?.can_navigate).not.toBe(true);
      expect(last.can_step_next ?? false).toBe(false);
      expect((await move(last.id, { step_index: 3 })).status).toBe(400);
      pane.screen = omp(3);
      const review = await card();
      expect(review.steps?.some(step => step.can_navigate) ?? false).toBe(false);
      expect(review.can_step_back ?? false).toBe(false);
      expect((await move(review.id, { step_back: true })).status).toBe(400);
      expect(pane.sent).toEqual([]);
    });
  });

  test("omp: a card read under one call answers no other call drawn the same", async () => {
    await withPane("omp", omp(0), async pane => {
      const stale = await card();
      // omp asks again with the same questions: the screen draws them alike
      pane.ompCall?.("asked-again");
      expect((await card()).id).not.toBe(stale.id);
      expect(await move(stale.id, { option_index: 0 })).toEqual({ status: 409, code: "prompt_changed" });
      expect(await move(stale.id, { step_next: true })).toEqual({ status: 409, code: "prompt_changed" });
      expect(pane.sent).toEqual([]);
    });
  });

  test("omp: a call the screen does not draw neither binds the card nor changes its id", async () => {
    await withPane("omp", omp(0), async pane => {
      pane.ompCall?.("ahead", "question");
      const first = await card();
      pane.ompCall?.("further-ahead", "question");
      const second = await card();
      expect(second.id).toBe(first.id);
      expect(second.steps?.some(step => step.can_navigate) ?? false).toBe(false);
    });
  });

  test.each([["busy herdr", () => new Error("busy")], ["unreadable /proc", () => new ConversationUnavailable("no_session_path")]] as const)("omp: a session lookup that fails for a moment (%s) keeps the card's id, and its tap", async (_, failure) => {
    await withPane("omp", omp(0), async pane => {
      const bound = await card();
      const lookup = conversation.ompTranscriptPath as unknown as { mockRejectedValueOnce: (error: Error) => void };
      lookup.mockRejectedValueOnce(failure());
      expect((await card()).id).toBe(bound.id);
      // the read whose lookup failed authorizes no key
      lookup.mockRejectedValueOnce(failure());
      expect(await move(bound.id, { option_index: 0 })).toEqual({ status: 409, code: "prompt_changed" });
      expect(pane.sent).toEqual([]);
      follows(pane, omp, 4, "tab", "shift+tab");
      expect(await move(bound.id, { step_next: true })).toEqual({ status: 200, code: undefined });
      expect(pane.sent).toEqual(["tab"]);
    });
  });

  test.each(["answer", "move"] as const)("omp: a call that changes after the last read takes no key (%s)", async kind => {
    await withPane("omp", omp(0), async pane => {
      follows(pane, omp, 4, "tab", "shift+tab");
      // the look right before the key, after every read: omp has asked again by then
      const beforeKey = async (): Promise<void> => { pane.ompCall?.("asked-again"); };
      const action = kind === "answer" ? { option_index: 0 } : { step_next: true };
      expect(await move((await card()).id, action, { beforeKey })).toEqual({ status: 409, code: "prompt_changed" });
      expect(pane.sent).toEqual([]);
    });
  });

  test("omp: an answer's look before its key that never answers sends nothing", async () => {
    await withPane("omp", omp(0), async pane => {
      const prompt = await card();
      const beforeKey = (): Promise<void> => new Promise(() => undefined);
      expect(await move(prompt.id, { option_index: 0 }, { beforeKey })).toEqual({ status: 409, code: "prompt_changed" });
      expect(pane.sent).toEqual([]);
    });
  });

  test("omp: a card read on one of two questions drawn alike answers and moves neither once the form is on the other", async () => {
    const alike = [["First", "Proceed?", ["Yes", "No"]], ["Second", "Proceed?", ["Yes", "No"]], ["Shape", "Which shape?", ["Circle", "Square"]]] as const;
    await withPane("omp", omp(0, false, alike), async pane => {
      const first = await card();
      // the terminal moves on to the second question, drawn as the first was
      pane.screen = omp(1, false, alike);
      expect((await card()).id).not.toBe(first.id);
      expect(await move(first.id, { option_index: 0 })).toEqual({ status: 409, code: "prompt_changed" });
      expect(await move(first.id, { step_next: true })).toEqual({ status: 409, code: "prompt_changed" });
      expect(pane.sent).toEqual([]);
    }, alike);
  });

  test("omp: where the strip cannot say which of two questions drawn alike is shown, no key is sent", async () => {
    const alike = [["First", "Proceed?", ["Yes", "No"]], ["Second", "Proceed?", ["Yes", "No"]], ["Shape", "Which shape?", ["Circle", "Square"]]] as const;
    await withPane("omp", omp(0, false, alike), async pane => {
      // the colours read prove no tab
      pane.visible = omp(1, false, alike).replace(/\x1b\[[0-9;]*m/g, "");
      expect(await move((await card()).id, { option_index: 0 })).toEqual({ status: 409, code: "prompt_changed" });
      expect(pane.sent).toEqual([]);
    }, alike);
  });

  test("omp: a screen that leaves the question while the look before Tab runs takes no Tab", async () => {
    await withPane("omp", omp(0), async pane => {
      // the review comes up between the move's last read and its key
      const beforeKey = async (): Promise<void> => { pane.screen = omp(3); };
      expect(await move((await card()).id, { step_next: true }, { beforeKey })).toEqual({ status: 409, code: "prompt_changed" });
      expect(pane.sent).toEqual([]);
    });
  });

  test("omp: a question clipped to a prefix the open call shares binds nothing", async () => {
    // omp cut the shown question at four rows; the open call asks a longer question that starts the same way
    const clipped = "Should the export button │\n│ wait for the running │\n│ export to finish before │\n│ it starts another …";
    const open = [["Export", "Should the export button wait for the running export to finish before it starts another one, or cancel it?", ["Red", "Blue"]], ["Size", "Which size?", ["Small", "Large"]], ["Shape", "Which shape?", ["Circle", "Square"]]] as const;
    const shown = [["Export", clipped, ["Red", "Blue"]], ...open.slice(1)] as const;
    const screen = omp(0, false, shown).replace("⏎ select · ", "⏎ select · ctrl+o expand · ");
    await withPane("omp", screen, async pane => {
      const prompt = await card();
      expect(prompt.steps?.some(step => step.can_navigate) ?? false).toBe(false);
      expect((await move(prompt.id, { step_next: true })).status).toBe(400);
      expect(pane.sent).toEqual([]);
    }, open);
  });

  describe("every key is sent only on a read, after the look before it, that still shows what the card asked", () => {
    const alike = [["First", "Proceed?", ["Yes", "No"]], ["Second", "Proceed?", ["Yes", "No"]], ["Shape", "Which shape?", ["Circle", "Square"]]] as const;

    test("omp: the other of two questions drawn alike, shown during the look before Enter, takes no Enter", async () => {
      await withPane("omp", omp(0, false, alike), async pane => {
        const first = await card();
        const beforeKey = async (): Promise<void> => { pane.screen = omp(1, false, alike); };
        expect(await move(first.id, { option_index: 0 }, { beforeKey })).toEqual({ status: 409, code: "prompt_changed" });
        expect(pane.sent).toEqual([]);
      }, alike);
    });

    test.each([["Next", { step_next: true }], ["an answer", { option_index: 0 }]] as const)("omp: the review, drawn while the read before %s is still being checked, takes no key", async (_, action) => {
      await withPane("omp", omp(0), async pane => {
        const first = await card();
        // after the look before the key, the terminal leaves the question while the read's own checks run
        let looked = false;
        const beforeKey = async (): Promise<void> => { looked = true; };
        pane.onRpc = (method) => { if (looked && method === "pane.process_info") { looked = false; pane.screen = omp(3); } };
        expect(await move(first.id, action, { beforeKey })).toEqual({ status: 409, code: "prompt_changed" });
        expect(pane.sent).toEqual([]);
      });
    });

    test("omp: a question bound whole, then shown cut, moves nothing", async () => {
      const long = "Which deployment should we choose for the production environment today to delete everything?";
      const open = [["Deploy", long, ["Red", "Blue"]], ...QUESTIONS.slice(1)] as const;
      await withPane("omp", omp(0, false, open), async pane => {
        const first = await card();
        pane.screen = omp(0, false, [["Deploy", "Which deployment │\n│ should we choose │\n│ for the production │\n│ environment today …", ["Red", "Blue"]], ...QUESTIONS.slice(1)])
          .replace("⏎ select · ", "⏎ select · ctrl+e expand · ");
        expect(await move(first.id, { step_next: true })).toEqual({ status: 409, code: "prompt_changed" });
        expect(pane.sent).toEqual([]);
      }, open);
    });

    test("omp: a cut question is not given the open call's words when only a prefix matches", async () => {
      const long = "Which deployment should we choose for the production environment today to delete everything?";
      const open = [["Deploy", long, ["Red", "Blue"]], ...QUESTIONS.slice(1)] as const;
      const cut = omp(0, false, [["Deploy", "Which deployment │\n│ should we choose │\n│ for the production │\n│ environment today …", ["Red", "Blue"]], ...QUESTIONS.slice(1)])
        .replace("⏎ select · ", "⏎ select · ctrl+e expand · ");
      await withPane("omp", cut, async () => {
        // the card says what the terminal shows, not words of a call whose question only starts the same way
        expect((await card()).question).not.toBe(long);
      }, open);
    });
  });

  test("omp: the review keeps its id whether or not the colours prove where the form stands", async () => {
    await withPane("omp", omp(3), async pane => {
      const proven = await card();
      pane.visible = omp(2);
      expect((await card()).id).toBe(proven.id);
    });
  });

  test("omp: the card keeps its id whether or not the colours prove where the form stands", async () => {
    await withPane("omp", omp(0), async pane => {
      const proven = await card();
      expect(proven.can_step_next).toBe(true);
      pane.visible = omp(1);
      const unproven = await card();
      expect(unproven.can_step_next ?? false).toBe(false);
      expect(unproven.id).toBe(proven.id);
    });
  });

  test("omp: a different strip after the first key stops the move", async () => {
    await withPane("omp", omp(0), async pane => {
      pane.onSent = () => { pane.screen = omp(1).replace(" Shape ", " Changed "); };
      // stopped by what it reads, not by the deadline: one far past the test's own time limit
      expect(await move((await card()).id, { step_index: 2 }, { answerDeadlineMs: 60_000 })).toEqual({ status: 409, code: "prompt_changed" });
      expect(pane.sent).toEqual(["tab"]);
    });
  });

  test("omp: a stale colored viewport never authorizes a move", async () => {
    await withPane("omp", omp(0), async pane => {
      pane.visible = omp(1);
      expect((await move((await card()).id, { step_next: true })).status).toBe(400);
      expect(pane.sent).toEqual([]);
    });
  });

  test("omp: another call with identical headers stops after the first key", async () => {
    await withPane("omp", omp(0), async pane => {
      pane.onSent = () => { pane.ompCall?.("reopened"); pane.screen = omp(1); };
      expect(await move((await card()).id, { step_index: 2 }, { answerDeadlineMs: 60_000 })).toEqual({ status: 409, code: "prompt_changed" });
      expect(pane.sent).toEqual(["tab"]);
    });
  });

  test("omp: an unverifiable styled viewport leaves ordinary answers usable", async () => {
    await withPane("omp", omp(0), async pane => {
      pane.visible = omp(1);
      const prompt = await card();
      expect(prompt.steps?.some(step => step.can_navigate)).not.toBe(true);
      expect(await move(prompt.id, { option_index: 0 })).toEqual({ status: 200, code: undefined });
      expect(pane.sent).toEqual(["enter"]);
    });
  });

  test("omp: a clipped navigation hint still enriches the complete styled strip", async () => {
    const clipped = (at: number) => omp(at).replace("question · ⎋ cancel", "quest…");
    await withPane("omp", clipped(0), async pane => {
      follows(pane, clipped, 4, "tab", "shift+tab");
      const first = await card();
      expect(first.can_step_next).toBe(true);
      expect(await move(first.id, { step_next: true })).toEqual({ status: 200, code: undefined });
      expect((await card()).steps?.findIndex(step => step.current)).toBe(1);
      expect(pane.sent).toEqual(["tab"]);
    });
  });

  test.skipIf(process.platform !== "linux")("OmO: Next sends Tab, and the card that comes back is the next question, not answered", async () => {
    await withOmoPane(omo(0), async (pane) => {
      follows(pane, omo, 4, "tab", "shift+tab");
      const first = await card();
      expect(await move(first.id, { step_next: true, draft: { option_indices: [], custom_text: "" } })).toEqual({ status: 200, code: undefined });
      expect(pane.sent).toEqual(["tab"]);
      const second = await card();
      expect(second).toMatchObject({ title: "Question 2 of 3", question: "Which size do you prefer?" });
      expect(second.steps?.map((step) => step.answered)).toEqual([false, false, false]);
    });
  });

  test.skipIf(process.platform !== "linux")("OmO: a tapped step two questions on sends Tab twice; Back on the review sends Shift+Tab", async () => {
    await withOmoPane(omo(0), async (pane) => {
      follows(pane, omo, 4, "tab", "shift+tab");
      expect(await move((await card()).id, { step_index: 2 })).toEqual({ status: 200, code: undefined });
      expect(pane.sent).toEqual(["tab", "tab"]);
      expect((await card()).question).toBe("Which shape do you prefer?");
    });
    await withOmoPane(omo(3), async (pane) => {
      follows(pane, omo, 4, "tab", "shift+tab", 3);
      expect(await move((await card()).id, { step_back: true })).toEqual({ status: 200, code: undefined });
      expect(pane.sent).toEqual(["shift+tab"]);
      expect((await card()).question).toBe("Which shape do you prefer?");
    });
  });

  test.skipIf(process.platform !== "linux")("OmO: a card a poll reads during a step answers the next tap", async () => {
    await withOmoPane(omo(0), async (pane) => {
      let at = 0;
      let poll: Promise<InteractivePrompt> | undefined;
      pane.onSent = (key) => {
        if (key === "tab") at += 1;
        pane.screen = omo(at);
        // the card's own poll, read while the step is still under way
        poll ??= card();
      };
      expect(await move((await card()).id, { step_next: true })).toEqual({ status: 200, code: undefined });
      const polled = await poll!;
      expect(polled.question).toBe("Which size do you prefer?");
      // the next tap comes from the card that poll drew: the same asking, not a stale one
      expect(await move(polled.id, { step_next: true })).toEqual({ status: 200, code: undefined });
      expect(pane.sent).toEqual(["tab", "tab"]);
    });
  });

  test.skipIf(process.platform !== "linux")("OmO: an answer whose look ends after the request's deadline still sends, as before", async () => {
    await withOmoPane(omo(0), async (pane) => {
      // pi's look before a key answers once the request's deadline has passed, as a slow look can: the clock is moved
      // past the deadline from inside the look, so nothing before it depends on how fast this machine is
      let looks = 0;
      const beforeKey = async (): Promise<void> => {
        looks += 1;
        // only while the look runs: what the answer records after it is at the real time
        setSystemTime(new Date(Date.now() + 120_000));
        try {
          // the look answers after the route's own timers have had their turn
          await new Promise((resolve) => setImmediate(resolve));
        } finally { setSystemTime(); }
      };
      expect(await move((await card()).id, { option_index: 0 }, { beforeKey, answerDeadlineMs: 60_000 })).toEqual({ status: 200, code: undefined });
      expect(pane.sent.length).toBeGreaterThan(0);
      expect(looks).toBeGreaterThan(0);
    });
  });

  test.skipIf(process.platform !== "linux")("OmO: a form that does not move stops after its first key", async () => {
    await withOmoPane(omo(0), async (pane) => {
      const first = await card();
      expect(await move(first.id, { step_index: 2 }, SHORT)).toEqual({ status: 409, code: "prompt_changed" });
      expect(pane.sent).toEqual(["tab"]);
      // the Tab went out: the same drawing is asked anew, and the card it left takes no further move
      expect((await card()).id).not.toBe(first.id);
      expect(await move(first.id, { step_index: 1 }, SHORT)).toEqual({ status: 409, code: "prompt_changed" });
      expect(pane.sent).toEqual(["tab"]);
    });
  });

  test.skipIf(process.platform !== "linux")("OmO: a move's keys pass the answer's own guard, which may refuse the next one", async () => {
    await withOmoPane(omo(0), async (pane) => {
      follows(pane, omo, 4, "tab", "shift+tab");
      // the look before each key (a pi-ask form, an omp behind its shell): the second one says no
      const looked: string[] = [];
      const beforeKey = async (paneId: string, agent: string): Promise<void> => {
        looked.push(`${paneId} ${agent}`);
        if (looked.length === 2) throw new KeyRefused();
      };
      expect(await move((await card()).id, { step_index: 2 }, { beforeKey })).toEqual({ status: 409, code: "prompt_changed" });
      expect(looked).toEqual(["p_1 pi", "p_1 pi"]);
      expect(pane.sent).toEqual(["tab"]);
    });
  });

  test.skipIf(process.platform !== "linux")("OmO: a new call asked under the move gets no second key, its tabs alike", async () => {
    // the same headers, its last question asked with other options and another call id: another form, though the tabs read alike
    const CALL_ID = (JSON.parse(OMO_SESSION_CALL) as { message: { content: { id: string }[] } }).message.content[0]!.id;
    const changed = OMO_SESSION_CALL.replace('"label":"Square"', '"label":"Triangle"').replace(CALL_ID, `${CALL_ID}_again`);
    expect(changed).not.toBe(OMO_SESSION_CALL);
    await withOmoPane(omo(0), async (pane) => {
      let at = 0;
      pane.onSent = (key) => {
        if (key === "tab") at += 1;
        pane.screen = omo(at);
        // omo settles the call and asks again, appending to its session as it always does
        if (at === 1) appendFileSync(pane.omo!.path, `${JSON.stringify({ type: "custom", customType: "ask-user:settlement", data: { requestId: CALL_ID } })}\n${changed}\n`);
      };
      expect(await move((await card()).id, { step_index: 2 })).toEqual({ status: 409, code: "prompt_changed" });
      expect(pane.sent).toEqual(["tab"]);
    });
    // and a screen that changed between the card and the move: no key at all
    await withOmoPane(omo(0), async (pane) => {
      const first = await card();
      pane.screen = omo(1);
      expect((await move(first.id, { step_index: 2 })).status).toBe(409);
      expect(pane.sent).toEqual([]);
    });
  });

  test.skipIf(process.platform !== "linux")("OmO: a guard that outlasts the request's deadline sends no further key", async () => {
    await withOmoPane(omo(0), async (pane) => {
      follows(pane, omo, 4, "tab", "shift+tab");
      // the second key's look never comes back (herdr holding its reply): the deadline ends it, 300 ms here, 4 s in the server
      let looks = 0;
      const beforeKey = (): Promise<void> => ++looks === 2 ? new Promise<void>(() => undefined) : Promise.resolve();
      expect(await move((await card()).id, { step_index: 2 }, { ...SHORT, beforeKey })).toEqual({ status: 409, code: "prompt_changed" });
      expect(pane.sent).toEqual(["tab"]);
    });
  });

  test.skipIf(process.platform !== "linux")("OmO: an answer with the move, a step out of reach or the card's unsent edits send nothing", async () => {
    await withOmoPane(omo(0), async (pane) => {
      const first = await card();
      const refused = { status: 400, code: "invalid_answer" };
      expect(await move(first.id, { step_next: true, option_index: 0 })).toEqual(refused);
      expect(await move(first.id, { step_back: true })).toEqual(refused);
      expect(await move(first.id, { step_next: true, step_back: true })).toEqual(refused);
      expect(await move(first.id, { step_index: 0 })).toEqual(refused);
      expect(await move(first.id, { step_next: true, draft: { option_indices: [], custom_text: "green" } })).toEqual(refused);
      expect(pane.sent).toEqual([]);
    });
  });

  test("Codex: Next sends → and Back sends ←, each seen on screen", async () => {
    await withPane("codex", codex(0), async (pane) => {
      let at = 0;
      pane.onSent = (key) => { at = key === "right" ? Math.min(1, at + 1) : key === "left" ? Math.max(0, at - 1) : at; pane.screen = codex(at); };
      expect(await move((await card()).id, { step_next: true })).toEqual({ status: 200, code: undefined });
      expect((await card()).question).toBe("Which size do you choose?");
      expect(await move((await card()).id, { step_back: true })).toEqual({ status: 200, code: undefined });
      expect(pane.sent).toEqual(["right", "left"]);
      expect((await card()).question).toBe("Which color do you choose?");
    });
  });

  test("Hermes: Next sends Tab, and the card comes back on the next open question", async () => {
    await withPane("hermes", hermes(0), async (pane) => {
      follows(pane, (at) => hermes(at), 3, "tab", "shift+tab");
      expect(await move((await card()).id, { step_next: true })).toEqual({ status: 200, code: undefined });
      expect(pane.sent).toEqual(["tab"]);
      expect((await card()).question).toBe("Pick a size");
    });
  });

  test("Hermes: Next onto an open-ended question lands there, its steps kept", async () => {
    await withPane("hermes", hermes(0, [], HERMES_OPEN), async (pane) => {
      follows(pane, (at) => hermes(at, [], HERMES_OPEN), 3, "tab", "shift+tab");
      expect(await move((await card()).id, { step_next: true })).toEqual({ status: 200, code: undefined });
      const open = await card();
      expect(open.question).toBe("Name a fruit");
      expect(open.steps?.findIndex((step) => step.current)).toBe(1);
    });
  });

  test("Hermes: another batch with the same questions drawn after a Tab gets no second one", async () => {
    // the same three questions, asked with other choices
    const OTHER: readonly (readonly [string, readonly string[]])[] = HERMES.map(([question], index) => [question, index === 1 ? ["Tiny", "Huge"] : ["Red", "Blue"]]);
    await withPane("hermes", hermes(0), async (pane) => {
      let at = 0;
      pane.onSent = (key) => {
        if (key === "tab") at += 1;
        pane.screen = hermes(at, [], OTHER);
      };
      expect((await move((await card()).id, { step_index: 2 })).status).toBe(400);
      expect(pane.sent).toEqual([]);
      // a single Next lands; the next move is asked against the card it shows
      expect(await move((await card()).id, { step_next: true })).toEqual({ status: 200, code: undefined });
      expect(pane.sent).toEqual(["tab"]);
      expect((await card()).options.map((option) => option.label)).toEqual(["Tiny", "Huge"]);
    });
  });

  test("an answer whose first read outlasts the deadline sends nothing", async () => {
    await withPane("hermes", hermes(0), async (pane) => {
      const first = await card();
      // herdr answers every read after the deadline
      pane.onRpc = (method) => method === "pane.read" ? 600 : undefined;
      expect(await move(first.id, { option_index: 1 }, SHORT)).toEqual({ status: 409, code: "prompt_changed" });
      expect(pane.sent).toEqual([]);
    });
  });

  test.skipIf(process.platform !== "linux")("OmO: a key whose reply never comes ends the move at the deadline", async () => {
    await withOmoPane(omo(0), async (pane) => {
      follows(pane, omo, 4, "tab", "shift+tab");
      const first = await card();
      // herdr writes the key and holds its reply past any test's budget
      pane.onRpc = (method) => method === "pane.send_keys" ? 60_000 : undefined;
      expect(await move(first.id, { step_index: 2 }, SHORT)).toEqual({ status: 409, code: "prompt_changed" });
      expect(pane.sent).toEqual(["tab"]);
    });
  });

  test("a card with no keys of its own to move by refuses Next", async () => {
    const one = `\n ask 1 question\n ▸ Pick a colour\n   ▸ 1. Red\n     2. Blue\n     3. Other (type your answer)\n 0/1 ${HERMES_HINT}\n`;
    await withPane("hermes", one, async (pane) => {
      // with an answer in the same body, too: Next is never read as that answer
      expect(await move((await card()).id, { step_next: true, option_index: 0 })).toEqual({ status: 400, code: "invalid_answer" });
      expect(await move((await card()).id, { step_next: true })).toEqual({ status: 400, code: "invalid_answer" });
      expect(pane.sent).toEqual([]);
    });
  });
});
