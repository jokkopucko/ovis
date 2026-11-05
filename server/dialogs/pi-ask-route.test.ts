import { expect, spyOn, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InteractivePrompt } from "../../shared/protocol.ts";
import { handlePromptRequest, type PromptRequestOptions, promptWaitEnded } from "../prompt.ts";
import { socketAddress } from "../herdr/client.ts";
import * as client from "../herdr/client.ts";
import fixtures from "../fixtures/pi-ask-2.13.9.json";
import navigation from "../fixtures/pi-ask-navigation.json";
import system from "../fixtures/pi-ask-system-theme.json";
import { ANSI_RE, type OmoAsk } from "./shared.ts";

// A fake RPC endpoint on a unique pipe/socket. Never connects to a real Herdr session.
async function withPane(initial: string, run: (pane: {
  screen: string; status: string; sent: string[]; visible?: string; scroll: number; onSent?: (key: string) => void;
  bind(questions: OmoAsk["questions"]): void;
  card(): Promise<InteractivePrompt>; read(): Promise<InteractivePrompt | null>;
  answer(id: string, choice: object, signal?: AbortSignal, options?: PromptRequestOptions): Promise<number>;
}) => Promise<void>) {
  const root = mkdtempSync(join(tmpdir(), "ovis-pi-ask-"));
  const endpoint = socketAddress(join(root, "herdr.sock"));
  const id = `pi-ask-${randomUUID()}`;
  const sockets = new Set<Socket>();
  const session = join(root, "session.jsonl");
  let nativeCall = 0;
  const readCard = async (): Promise<InteractivePrompt | null> => {
    const url = new URL(`http://127.0.0.1/api/pane/prompt?pane_id=${id}`);
    const response = (await handlePromptRequest(new Request(url), url))!;
    expect(response.status).toBe(200);
    return (await response.json() as { prompt: InteractivePrompt | null }).prompt;
  };
  const pane = {
    screen: initial, status: "blocked", sent: [] as string[], visible: undefined as string | undefined, scroll: 0, onSent: undefined as ((key: string) => void) | undefined,
    read: readCard,
    bind: (questions: OmoAsk["questions"]) => {
      if (nativeCall) appendFileSync(session, JSON.stringify({ type: "message", message: { role: "toolResult", toolCallId: `native-${nativeCall}` } }) + "\n");
      appendFileSync(session, JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: `native-${++nativeCall}`, name: "ask_user_question", arguments: { questions } }] } }) + "\n");
    },
    card: async () => {
      const prompt = await readCard();
      expect(prompt).not.toBeNull();
      return prompt!;
    },
    answer: async (prompt: string, choice: object, signal?: AbortSignal, options?: PromptRequestOptions) => {
      const url = new URL("http://127.0.0.1/api/pane/prompt/answer");
      const response = (await handlePromptRequest(new Request(url, {
        method: "POST", signal, body: JSON.stringify({ pane_id: id, prompt_id: prompt, ...choice }),
      }), url, options))!;
      return response.status;
    },
  };
  const server = createServer(socket => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => undefined);
    let buffer = "";
    socket.on("data", chunk => {
      buffer += chunk.toString();
      if (!buffer.includes("\n")) return;
      const request = JSON.parse(buffer.split("\n")[0]!) as { id: string; method: string; params: { keys?: string[]; text?: string; format?: string } };
      const reply = (result: unknown) => socket.end(JSON.stringify({ id: request.id, result }) + "\n");
      if (request.method === "session.snapshot") return reply({ snapshot: { panes: [{ pane_id: id, agent: "pi", agent_status: pane.status, terminal_id: id, focused: false }], layouts: [] } });
      if (request.method === "pane.read") return reply({ read: { text: request.params.format === "ansi" ? pane.visible ?? pane.screen : pane.screen.replace(ANSI_RE, "") } });
      if (request.method === "pane.get") return reply({ pane: { pane_id: id, scroll: { offset_from_bottom: pane.scroll } } });
      // pi holds the pane's input: its key-driven cards answer only then
      if (request.method === "pane.process_info") return reply({ process_info: { foreground_processes: [{ pid: 2147483646, argv: ["pi"] }] } });
      if (request.method === "agent.get") return reply({ agent: nativeCall ? { agent: "pi", agent_session: { agent: "pi", source: "herdr:pi", kind: "path", value: session } } : {} });
      if (request.method === "pane.send_keys" || request.method === "pane.send_text") {
        for (const key of request.params.keys ?? [`text:${request.params.text}`]) {
          pane.sent.push(key);
          pane.onSent?.(key);
        }
        return reply({});
      }
      socket.end(JSON.stringify({ id: request.id, error: { code: "unexpected_fixture_rpc", message: "Unexpected test RPC" } }) + "\n");
    });
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(endpoint, resolve); });
  const previous = process.env["HERDR_SOCKET"];
  const previousStore = process.env["PI_CODING_AGENT_SESSION_DIR"];
  process.env["PI_CODING_AGENT_SESSION_DIR"] = root;
  process.env["HERDR_SOCKET"] = endpoint;
  try { await run(pane); } finally {
    promptWaitEnded(id);
    if (previous === undefined) delete process.env["HERDR_SOCKET"];
    else process.env["HERDR_SOCKET"] = previous;
    if (previousStore === undefined) delete process.env["PI_CODING_AGENT_SESSION_DIR"];
    else process.env["PI_CODING_AGENT_SESSION_DIR"] = previousStore;
    for (const socket of sockets) socket.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
}

test("Pi ask answer route confirms the real second choice after observing its cursor", async () => {
  await withPane(fixtures.single, async pane => {
    const card = await pane.card();
    expect(card).not.toBeNull();
    expect(card.options[1]!.label).toBe("只允许普通单值");
    pane.onSent = key => { if (key === "down") pane.screen = fixtures["single-second"]; };
    expect(await pane.answer(card.id, { option_index: 1 })).toBe(200);
    expect(pane.sent).toEqual(["down", "enter"]);
    expect(await pane.answer(card.id, { option_index: 1 })).toBe(409);
    expect(pane.sent).toEqual(["down", "enter"]);
  });
});

test("Pi ask answer route handles an unfocused pane with paragraphs and thinking off", async () => {
  const screen = (name: "single" | "single-second") => fixtures[name]
    .replace("结果表是否允许结构化单元格？", "第一段问题？\n\n 第二段说明。\n\n 第三段说明。")
    + "\nC:\\project\n12.0%/200k (auto)    some-model • thinking off\n";
  await withPane(screen("single"), async pane => {
    const card = await pane.card();
    expect(card.fallback).not.toBe(true);
    expect(card.question).toBe("第一段问题？ 第二段说明。 第三段说明。");
    expect(card.options.map(option => option.label)).toEqual(["允许结构化单元格", "只允许普通单值"]);
    pane.onSent = key => { if (key === "down") pane.screen = screen("single-second"); };
    expect(await pane.answer(card.id, { option_index: 1 })).toBe(200);
    expect(pane.sent).toEqual(["down", "enter"]);
  });
});

test("Pi ask answer route refuses a question replaced during navigation", async () => {
  await withPane(fixtures.single, async pane => {
    const card = await pane.card();
    pane.onSent = key => { if (key === "down") pane.screen = fixtures["single-second"].replace("结果表是否允许结构化单元格？", "A different question?"); };
    expect(await pane.answer(card.id, { option_index: 1 })).toBe(409);
    expect(pane.sent).toEqual(["down"]);
  });
}, 4_000);

test("Pi ask answer route writes a custom answer only after focusing the inline input", async () => {
  await withPane(fixtures.single, async pane => {
    const card = await pane.card();
    let moves = 0;
    pane.onSent = key => { if (key === "down") pane.screen = ++moves === 1 ? fixtures["single-second"] : fixtures["single-custom-empty"]; };
    expect(await pane.answer(card.id, { custom_text: "typed answer" })).toBe(200);
    expect(pane.sent).toEqual(["down", "down", "ctrl+u", "text:typed answer", "enter"]);
  });
});

test.each(["ctrl+u", "text:typed answer"])("Pi ask stops when its custom editor disappears after %s", async dismissAfter => {
  await withPane(fixtures.single, async pane => {
    const card = await pane.card();
    let moves = 0;
    pane.onSent = key => {
      if (key === "down") pane.screen = ++moves === 1 ? fixtures["single-second"] : fixtures["single-custom-empty"];
      if (key === dismissAfter) pane.screen = fixtures.single;
    };
    expect(await pane.answer(card.id, { custom_text: "typed answer" })).toBe(409);
    expect(pane.sent).toEqual(["down", "down", "ctrl+u", ...(dismissAfter.startsWith("text:") ? [dismissAfter] : [])]);
  });
});

test.each(["first\nsecond", "first\rsecond", "first\r\nsecond", "\nanswer", "answer\n", "first\tsecond", "first\u001bsecond", "first\u0085second"])("Pi ask answer route rejects unsafe typed input without sending even navigation %#", async text => {
  await withPane(fixtures.single, async pane => {
    const card = await pane.card();
    const original = pane.screen;
    let moves = 0;
    // Allow the real custom-input focus path: rejection must be validation, not a stale cursor.
    // Any premature Enter would close the question and expose a later screen to the remaining input.
    pane.onSent = key => {
      if (key === "down") pane.screen = ++moves === 1 ? fixtures["single-second"] : fixtures["single-custom-empty"];
      else if (key.includes("\n") || key.includes("\r") || key === "enter") pane.screen = fixtures.review;
    };
    expect(await pane.answer(card.id, { custom_text: text })).toBe(400);
    expect(pane.sent).toEqual([]);
    expect(pane.screen).toBe(original);
    expect((await pane.card()).id).toBe(card.id);
  });
});

test("Pi ask answer route toggles a multi-pick and commits only its Submit row", async () => {
  await withPane(fixtures.multi, async pane => {
    const card = await pane.card();
    expect(await pane.answer(card.id, { option_indices: [0, 1] })).toBe(200);
    expect(pane.sent).toEqual(["space", "down", "space", "down", "down", "enter"]);
  });
});

test("Pi ask answer route keeps the final review explicit and observes its Cancel cursor", async () => {
  await withPane(fixtures.review, async pane => {
    const card = await pane.card();
    pane.onSent = key => { if (key === "down") pane.screen = fixtures["review-cancel"]; };
    expect(await pane.answer(card.id, { option_index: 1 })).toBe(200);
    expect(pane.sent).toEqual(["down", "enter"]);
  });
});

test("Pi ask answer route goes back without sending Enter and permits answering the returned question", async () => {
  await withPane(navigation.second, async pane => {
    const card = await pane.card();
    expect(card.can_step_back).toBe(true);
    pane.onSent = key => { if (key === "left") pane.screen = navigation["first-after-one"]; };
    expect(await pane.answer(card.id, { step_back: true, draft: { option_indices: [], custom_text: "" } })).toBe(200);
    expect(pane.sent).toEqual(["left"]);
    const returned = await pane.card();
    expect(returned.title).toBe("单元格内容");
    expect(returned.steps?.[0]?.current).toBe(true);
    expect(await pane.answer(card.id, { step_back: true })).toBe(409);
    pane.onSent = key => { if (key === "enter") pane.screen = navigation.second; };
    expect(await pane.answer(returned.id, { option_index: 0 })).toBe(200);
  });
});

test("Pi ask tab moves are held to the request's deadline: a look before the key that outlasts it sends nothing", async () => {
  await withPane(navigation.first, async pane => {
    const card = await pane.card();
    pane.onSent = key => { if (key === "right") pane.screen = navigation["second-unanswered"]; };
    // the look before the key (pi-ask's) never comes back: the deadline ends it, 300 ms here, 4 s in the server
    const beforeKey = (): Promise<void> => new Promise<void>(() => undefined);
    expect(await pane.answer(card.id, { step_index: 1 }, undefined, { answerDeadlineMs: 300, beforeKey })).toBe(409);
    expect(pane.sent).toEqual([]);
  });
});

test("Pi ask answer route switches to unanswered tabs and returns from review", async () => {
  await withPane(navigation.first, async pane => {
    let card = await pane.card();
    pane.onSent = key => { if (key === "right") pane.screen = navigation["second-unanswered"]; };
    expect(await pane.answer(card.id, { step_index: 1 })).toBe(200);
    expect(pane.sent).toEqual(["right"]);
    expect((await pane.card()).title).toBe("输出类型");
    pane.screen = navigation.review;
    card = await pane.card();
    let moves = 0;
    pane.onSent = key => { if (key === "left") pane.screen = ++moves === 1 ? navigation["second-answered"] : navigation["first-answered"]; };
    expect(await pane.answer(card.id, { step_index: 0 })).toBe(200);
    expect(pane.sent).toEqual(["right", "left", "left"]);
    expect((await pane.card()).title).toBe("单元格内容");
  });
});

test("Pi ask Next reaches an unanswered question using only Right", async () => {
  await withPane(navigation.first, async pane => {
    const first = await pane.card();
    expect(first.can_step_next).toBe(true);
    expect(await pane.answer(first.id, { step_next: true, step_back: true })).toBe(400);
    expect(await pane.answer(first.id, { step_next: true, option_index: 0 })).toBe(400);
    expect(await pane.answer(first.id, { step_next: true, draft: { option_indices: [], custom_text: "unsent" } })).toBe(400);
    pane.onSent = key => { if (key === "right") pane.screen = navigation["second-unanswered"]; };
    expect(await pane.answer(first.id, { step_next: true })).toBe(200);
    expect(pane.sent).toEqual(["right"]);
    const second = await pane.card();
    expect(second.steps?.map(step => step.answered)).toEqual([false, false, false]);
    expect(second.steps?.findIndex(step => step.current)).toBe(1);
    expect(second.can_step_next ?? false).toBe(false);
  });
});

test("Pi ask Next cancelled just before herdr writes sends no key", async () => {
  await withPane(navigation.first, async pane => {
    const card = await pane.card();
    const abort = new AbortController();
    const original = client.paneSendKeys;
    const send = spyOn(client, "paneSendKeys").mockImplementation(async (...args) => {
      abort.abort();
      await original(...args);
    });
    try {
      expect(await pane.answer(card.id, { step_next: true }, abort.signal)).toBe(409);
      expect(send).toHaveBeenCalledTimes(1);
      expect(pane.sent).toEqual([]);
    } finally { send.mockRestore(); }
  });
});

test("Pi ask does not mistake a scrolled or mismatched viewport for the live selected tab", async () => {
  await withPane(navigation.second, async pane => {
    const card = await pane.card();
    pane.scroll = 20;
    expect((await pane.card()).can_step_back).not.toBe(true);
    expect(await pane.answer(card.id, { step_back: true })).toBe(409);
    pane.scroll = 0;
    pane.visible = navigation["first-after-one"];
    expect((await pane.card()).can_step_back).not.toBe(true);
    expect(pane.sent).toEqual([]);
  });
});

test("Pi ask refuses an answer when the bottom viewport shows an older question", async () => {
  await withPane(navigation["first-after-one"], async pane => {
    const card = await pane.card();
    pane.visible = navigation["first-after-one"];
    pane.screen = navigation.second;
    expect(await pane.answer(card.id, { option_index: 0 })).toBe(409);
    expect(pane.sent).toEqual([]);
    const refreshed = await pane.card();
    expect(refreshed.question).toBe("结果使用哪种类型？");
    for (const choice of [{ option_index: 0 }, { custom_text: "must not be sent" }, { step_back: true }, { step_index: 0 }]) {
      expect(await pane.answer(refreshed.id, choice)).toBe(409);
    }
    expect(pane.sent).toEqual([]);
    pane.visible = navigation.second;
    const verified = await pane.card();
    expect(await pane.answer(verified.id, { option_index: 0 })).toBe(200);
    expect(pane.sent).toEqual(["enter"]);
  });
});

test("system-theme review returns to the clicked first question, not the second, including incomplete forms", async () => {
  const state = (name: string) => system.states.find(item => item.name === name)!.screen;
  await withPane(state("review-incomplete"), async pane => {
    pane.bind(system.questions.map(q => ({ ...q, multiSelect: q.multiSelect ?? false })));
    let index = 3;
    pane.onSent = key => {
      expect(key).toBe("left");
      pane.screen = state(["partial-first", "partial-second", "partial-third"][--index]!);
    };
    const card = await pane.card();
    expect(card.fallback).not.toBe(true);
    expect(card.options.map(option => option.label)).toEqual(["Cancel"]);
    expect(await pane.answer(card.id, { step_index: 0, draft: { option_indices: [], custom_text: "" } })).toBe(200);
    expect(pane.sent).toEqual(["left", "left", "left"]);
    expect((await pane.card()).title).toBe("返回修改");
    expect((await pane.card()).multi_select).toBe(false);
  });
});

test("incomplete review cancellation sends Escape, never the native partial-submit Enter", async () => {
  const screen = system.states.find(item => item.name === "review-incomplete")!.screen;
  await withPane(screen, async pane => {
    const card = await pane.card();
    pane.onSent = key => { if (key === "esc") { pane.screen = "Question complete"; pane.status = "working"; } };
    expect(await pane.answer(card.id, { option_index: 0 })).toBe(200);
    expect(pane.sent).toEqual(["esc"]);
    expect(await pane.read()).toBeNull();
  });
});

const nativeQuestions: OmoAsk["questions"] = [
  { header: "单元格内容", question: "结果表是否允许结构化单元格？", multiSelect: false, options: [
    { label: "允许结构化单元格", description: "单元格可包含列表或对象。" }, { label: "只允许普通单值", description: "仅数字、文字和布尔值。" },
  ] },
  { header: "输出类型", question: "结果使用哪种类型？", multiSelect: false, options: [
    { label: "允许结构化单元格", description: "单元格可包含列表或对象。" }, { label: "只允许普通单值", description: "仅数字、文字和布尔值。" },
  ] },
];

test("Pi's verified pending call restores saved custom answers and single choices when returning", async () => {
  await withPane(navigation["custom-returned"], async pane => {
    pane.bind(nativeQuestions);
    const card = await pane.card();
    expect(card.default_custom_text).toBe("existing draft");
    pane.onSent = key => { if (key === "left") pane.screen = navigation["first-answered"]; };
    expect(await pane.answer(card.id, { step_back: true, draft: { option_indices: [], custom_text: "existing draft" } })).toBe(200);
    const first = await pane.card();
    expect(first.default_option_index).toBe(0);
    expect(first.options[0]!.label).toBe("允许结构化单元格");
    pane.onSent = key => { if (key === "right") pane.screen = navigation["custom-returned"]; };
    expect(await pane.answer(first.id, { step_index: 1, draft: { option_indices: [0], custom_text: "" } })).toBe(200);
    expect((await pane.card()).default_custom_text).toBe("existing draft");
    expect(pane.sent).toEqual(["left", "right"]);
  });
});

test("Pi navigation rejects another invocation even with identical question labels and content", async () => {
  await withPane(navigation.second, async pane => {
    pane.bind(nativeQuestions);
    const card = await pane.card();
    pane.bind(nativeQuestions);
    expect(await pane.answer(card.id, { step_back: true })).toBe(409);
    expect(pane.sent).toEqual([]);
  });
});

test("Pi ask navigation refuses mixed actions, invalid steps and unsent drafts before any keys", async () => {
  await withPane(navigation.second, async pane => {
    const card = await pane.card();
    for (const choice of [{ step_index: -1 }, { step_index: 1 }, { step_index: 2 }, { step_index: 0.5 },
      { step_index: 0, step_back: true }, { step_back: true, option_index: 0 },
      { step_back: true, draft: { option_indices: [], custom_text: "unsent" } },
      { step_back: true, draft: { option_indices: [0], custom_text: "" } }]) {
      expect(await pane.answer(card.id, choice)).toBe(400);
    }
    expect(pane.sent).toEqual([]);
  });
});

test("Pi ask navigation stops after a wrong tab, closed widget or changed form instead of overshooting", async () => {
  for (const changed of [navigation["first-answered"], "Working...", navigation["second-answered"].replaceAll("输出类型", "Other form")]) {
    await withPane(navigation.review, async pane => {
      const card = await pane.card();
      pane.onSent = key => { if (key === "left") pane.screen = changed; };
      expect(await pane.answer(card.id, { step_index: 0 })).toBe(409);
      expect(pane.sent).toEqual(["left"]);
    });
  }
});

const closingScreen = "Question complete\nEnter to select · ↑/↓ to navigate · Esc to cancel";

test.each([fixtures.single, fixtures.multi, fixtures.review])("Pi ask successful answer does not flash fallback keys while blocked status catches up %#", async screen => {
  await withPane(screen, async pane => {
    const card = await pane.card();
    // The widget has closed, but its hint and the preceding blocked snapshot can outlive it.
    pane.onSent = key => { if (key === "enter") pane.screen = closingScreen; };
    const choice = card.multi_select ? { option_indices: [0] } : { option_index: 0 };
    expect(await pane.answer(card.id, choice)).toBe(200);
    expect(await pane.read()).toBeNull();
  });
});

test("Pi ask closing screen needs no fallback once Herdr reports working", async () => {
  await withPane(fixtures.review, async pane => {
    const card = await pane.card();
    pane.onSent = key => { if (key === "enter") { pane.screen = closingScreen; pane.status = "working"; } };
    expect(await pane.answer(card.id, { option_index: 0 })).toBe(200);
    expect(await pane.read()).toBeNull();
  });
});

test("Pi ask settling does not delay a recognized next question", async () => {
  await withPane(fixtures["tabs-first"], async pane => {
    const card = await pane.card();
    pane.onSent = key => { if (key === "enter") pane.screen = fixtures["tabs-second"]; };
    expect(await pane.answer(card.id, { option_index: 0 })).toBe(200);
    const next = await pane.card();
    expect(next.fallback).not.toBe(true);
    expect(next.id).not.toBe(card.id);
    expect(next.question).not.toBe(card.question);
  });
});

test("Pi's unknown blocker after a refused rpiv answer gets no generic card: no key is guessed into pi", async () => {
  await withPane(fixtures.review, async pane => {
    const card = await pane.card();
    expect(await pane.answer(card.id, { option_index: 99 })).toBe(400);
    pane.screen = closingScreen;
    expect(await pane.read()).toBeNull();
  });
});

test("Pi's unknown blocker stays without a generic card after an rpiv answer settles", async () => {
  await withPane(fixtures.review, async pane => {
    const card = await pane.card();
    pane.onSent = key => { if (key === "enter") pane.screen = closingScreen; };
    expect(await pane.answer(card.id, { option_index: 0 })).toBe(200);
    expect(await pane.read()).toBeNull();
    const clock = spyOn(Date, "now").mockReturnValue(Date.now() + 4_000);
    try { expect(await pane.read()).toBeNull(); }
    finally { clock.mockRestore(); }
  });
});

test("Pi ask answer route sends no input for invalid, stale or cancelled answers", async () => {
  await withPane(fixtures.single, async pane => {
    const card = await pane.card();
    expect(await pane.answer(card.id, { option_index: 99 })).toBe(400);
    const abort = new AbortController(); abort.abort();
    expect(await pane.answer(card.id, { option_index: 0 }, abort.signal)).toBe(409);
    pane.screen = "Working…";
    expect(await pane.answer(card.id, { option_index: 0 })).toBe(409);
    expect(pane.sent).toEqual([]);
  });
});
