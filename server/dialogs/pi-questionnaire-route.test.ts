import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InteractivePrompt } from "../../shared/protocol.ts";
import { handlePromptRequest, promptWaitEnded } from "../prompt.ts";
import { socketAddress } from "../herdr/client.ts";
import fixture from "../fixtures/pi-questionnaire.json";
import { ANSI_RE } from "./shared.ts";

const screens = fixture.screens;

// A fake RPC endpoint on a unique pipe/socket. Never connects to a real Herdr session.
async function withPane(initial: string, args: unknown, run: (pane: {
  screen: string; status: string; sent: string[]; visible?: string; scroll: number; onSent?: (key: string) => void;
  bind(args: unknown): void;
  settle(): void;
  append(entry: object): void;
  card(): Promise<InteractivePrompt>; read(): Promise<InteractivePrompt | null>;
  answer(id: string, choice: object, signal?: AbortSignal): Promise<number>;
}) => Promise<void>) {
  const root = mkdtempSync(join(tmpdir(), "ovis-pi-questionnaire-"));
  const endpoint = socketAddress(join(root, "herdr.sock"));
  const id = `pi-questionnaire-${randomUUID()}`;
  const sockets = new Set<Socket>();
  const session = join(root, "session.jsonl");
  let nativeCall = 0;
  let sequence = 0;
  let leaf: string | null = null;
  const append = (entry: object) => {
    const record = { id: `entry-${++sequence}`, parentId: leaf, timestamp: "2026-10-27T00:00:00.000Z", ...entry };
    appendFileSync(session, JSON.stringify(record) + "\n");
    leaf = record.id;
  };
  appendFileSync(session, JSON.stringify({ type: "session", version: 3, id: "fixture-session", cwd: root }) + "\n");
  append({ type: "message", id: "root", parentId: null, message: { role: "user", content: "Synthetic questionnaire fixture" } });
  const readCard = async (): Promise<InteractivePrompt | null> => {
    const url = new URL(`http://127.0.0.1/api/pane/prompt?pane_id=${id}`);
    const response = (await handlePromptRequest(new Request(url), url))!;
    expect(response.status).toBe(200);
    return (await response.json() as { prompt: InteractivePrompt | null }).prompt;
  };
  const pane = {
    screen: initial, status: "blocked", sent: [] as string[], visible: undefined as string | undefined, scroll: 0, onSent: undefined as ((key: string) => void) | undefined,
    read: readCard, append,
    settle: () => append({ type: "message", message: { role: "toolResult", toolCallId: `native-${nativeCall}` } }),
    bind: (args: unknown) => {
      if (nativeCall) append({ type: "message", message: { role: "toolResult", toolCallId: `native-${nativeCall}` } });
      append({ type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: `native-${++nativeCall}`, name: "questionnaire", arguments: args }] } });
    },
    card: async () => {
      const prompt = await readCard();
      expect(prompt).not.toBeNull();
      return prompt!;
    },
    answer: async (prompt: string, choice: object, signal?: AbortSignal) => {
      const url = new URL("http://127.0.0.1/api/pane/prompt/answer");
      const response = (await handlePromptRequest(new Request(url, {
        method: "POST", signal, body: JSON.stringify({ pane_id: id, prompt_id: prompt, ...choice }),
      }), url))!;
      return response.status;
    },
  };
  pane.bind(args);
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

test("questionnaire route navigates actual option cursor and never guesses digit shortcuts", async () => {
  await withPane(screens.single, fixture.single, async pane => {
    pane.status = "idle"; // Pi's ui.custom does not report blocked.
    const card = await pane.card();
    pane.onSent = key => { if (key === "down") pane.screen = screens.second; };
    expect(await pane.answer(card.id, { option_index: 1 })).toBe(200);
    expect(pane.sent).toEqual(["down", "enter"]);
    expect(await pane.answer(card.id, { option_index: 1 })).toBe(409);
  });
});

test("questionnaire free text enters its editor, rereads before text and before submitting", async () => {
  await withPane(screens.single, fixture.single, async pane => {
    const card = await pane.card();
    let moves = 0;
    pane.onSent = key => {
      if (key === "down") pane.screen = ++moves === 1 ? screens.second : screens.other;
      if (key === "enter") pane.screen = screens["input-empty"];
      if (key === "text:custom response") pane.screen = screens["input-text"];
    };
    expect(await pane.answer(card.id, { custom_text: "custom response" })).toBe(200);
    expect(pane.sent).toEqual(["down", "down", "enter", "text:custom response", "enter"]);
  });
});

test.each(["\n", "\r", "\t", "\x1b[A", "\x00", "\x7f", "\x85"])("questionnaire rejects unsafe custom controls before any write: %j", async control => {
  await withPane(screens.single, fixture.single, async pane => {
    expect(await pane.answer((await pane.card()).id, { custom_text: `answer${control}` })).toBe(400);
    expect(pane.sent).toEqual([]);
  });
});

test("questionnaire allowOther false refuses text before navigation", async () => {
  await withPane(screens["no-other"], { questions: [{ ...fixture.single.questions[0], allowOther: false }] }, async pane => {
    expect(await pane.answer((await pane.card()).id, { custom_text: "no" })).toBe(400);
    expect(pane.sent).toEqual([]);
  });
});

test("questionnaire refuses terminal-owned drafts rather than interpreting menu keys in an editor", async () => {
  await withPane(screens["input-text"], fixture.single, async pane => {
    expect(await pane.answer((await pane.card()).id, { option_index: 0 })).toBe(400);
    expect(pane.sent).toEqual([]);
  });
});

test("questionnaire changed call identity invalidates an identical-looking stale card", async () => {
  await withPane(screens.single, fixture.single, async pane => {
    const card = await pane.card();
    pane.bind(fixture.single);
    expect(await pane.answer(card.id, { option_index: 0 })).toBe(409);
    expect(pane.sent).toEqual([]);
  });
});

test("questionnaire cannot answer a completed call or fall back to guessed controls", async () => {
  await withPane(screens.single, fixture.single, async pane => {
    pane.settle();
    expect(await pane.read()).toBeNull();
    pane.bind({ questions: [] });
    expect(await pane.read()).toBeNull();
  });
});

test("questionnaire refuses replaced question after a cursor move", async () => {
  await withPane(screens.single, fixture.single, async pane => {
    const card = await pane.card();
    pane.onSent = key => { if (key === "down") pane.screen = screens.second.replace("Which implementation", "Different question"); };
    expect(await pane.answer(card.id, { option_index: 1 })).toBe(409);
    expect(pane.sent).toEqual(["down"]);
  });
}, 4_000);

test.each(["enter", "text:custom response"])("questionnaire stops custom delivery if editor disappears after %s", async disappear => {
  await withPane(screens.other, fixture.single, async pane => {
    const card = await pane.card();
    pane.onSent = key => {
      if (key === "enter") pane.screen = screens["input-empty"];
      if (key === "text:custom response") pane.screen = screens["input-text"];
      if (key === disappear) pane.screen = screens.single;
    };
    expect(await pane.answer(card.id, { custom_text: "custom response" })).toBe(409);
    expect(pane.sent).toEqual(disappear === "enter" ? ["enter"] : ["enter", "text:custom response"]);
  });
});

test("questionnaire refuses final submit if terminal edits replace its custom draft", async () => {
  await withPane(screens.other, fixture.single, async pane => {
    const card = await pane.card();
    pane.onSent = key => {
      if (key === "enter") pane.screen = screens["input-empty"];
      if (key === "text:custom response") pane.screen = screens["input-text"].replace("custom response", "terminal draft");
    };
    expect(await pane.answer(card.id, { custom_text: "custom response" })).toBe(409);
    expect(pane.sent).toEqual(["enter", "text:custom response"]);
  });
});

test("questionnaire multiple-question navigation observes active styled tabs even while idle", async () => {
  await withPane(screens["multi-first-narrow"], fixture.multi, async pane => {
    pane.status = "idle";
    const card = await pane.card();
    pane.onSent = key => { if (key === "right") pane.screen = screens["multi-second"]; };
    expect(await pane.answer(card.id, { step_index: 1 })).toBe(200);
    expect(pane.sent).toEqual(["right"]);
    expect((await pane.card()).title).toBe("Verification");
  });
});

test("questionnaire refuses unverifiable styled viewport and stale tab transitions", async () => {
  await withPane(screens["multi-first"], fixture.multi, async pane => {
    const card = await pane.card();
    pane.visible = screens["multi-second"];
    expect(await pane.answer(card.id, { step_index: 1 })).toBe(409);
    expect(pane.sent).toEqual([]);
    pane.visible = undefined;
    const fresh = await pane.card();
    pane.onSent = key => { if (key === "right") pane.screen = screens["review-empty"]; };
    expect(await pane.answer(fresh.id, { step_index: 1 })).toBe(409);
    expect(pane.sent).toEqual(["right"]);
  });
});

test("questionnaire incomplete review refuses submit, but permits safe cancellation", async () => {
  await withPane(screens["review-missing"], fixture.multi, async pane => {
    const card = await pane.card();
    expect(card.options.map(o => o.label)).toEqual(["Cancel"]);
    expect(await pane.answer(card.id, { option_index: 1 })).toBe(400);
    expect(pane.sent).toEqual([]);
    expect(await pane.answer(card.id, { option_index: 0 })).toBe(200);
    expect(pane.sent).toEqual(["esc"]);
  });
});

test("questionnaire complete review uses Enter, cancellation uses Escape, never row navigation", async () => {
  for (const option of [0, 1]) await withPane(screens.review, fixture.multi, async pane => {
    const card = await pane.card();
    expect(await pane.answer(card.id, { option_index: option })).toBe(200);
    expect(pane.sent).toEqual([option === 0 ? "enter" : "esc"]);
  });
});

test("questionnaire rereads between every reversible move before opening a custom editor", async () => {
  await withPane(screens.single, fixture.single, async pane => {
    const card = await pane.card();
    pane.onSent = key => { if (key === "down") pane.screen = screens.second.replace("Which implementation", "Other question"); };
    expect(await pane.answer(card.id, { custom_text: "custom response" })).toBe(409);
    expect(pane.sent).toEqual(["down"]);
  });
}, 4_000);

test("questionnaire request cancellation after editor entry prevents custom text", async () => {
  await withPane(screens.other, fixture.single, async pane => {
    const card = await pane.card();
    const controller = new AbortController();
    pane.onSent = key => {
      if (key === "enter") { pane.screen = screens["input-empty"]; controller.abort(); }
    };
    expect(await pane.answer(card.id, { custom_text: "custom response" }, controller.signal)).toBe(409);
    expect(pane.sent).toEqual(["enter"]);
  });
});

test("questionnaire missing review navigates back without implicitly submitting or answering", async () => {
  await withPane(screens["review-missing"], fixture.multi, async pane => {
    const card = await pane.card();
    pane.onSent = key => { if (key === "left") pane.screen = screens["review-missing-back"]; };
    expect(await pane.answer(card.id, { step_back: true })).toBe(200);
    expect(pane.sent).toEqual(["left"]);
  });
});

test("questionnaire rejects edits on tab navigation rather than silently discarding them", async () => {
  await withPane(screens["multi-first"], fixture.multi, async pane => {
    const card = await pane.card();
    expect(await pane.answer(card.id, { step_index: 1, draft: { option_indices: [], custom_text: "unsent" } })).toBe(400);
    expect(pane.sent).toEqual([]);
  });
});

test("questionnaire refuses clipped drawings instead of guessed fallback controls", async () => {
  await withPane(screens.single.split("\n").slice(3, -3).join("\n"), fixture.single, async pane => {
    expect(await pane.read()).toBeNull();
    expect(pane.sent).toEqual([]);
  });
});

test("questionnaire custom answer remains guarded across multiple narrow editor rows", async () => {
  const draft = "custom response with a longer sentence that wraps across multiple editor rows on a narrow pane";
  await withPane(screens.other, fixture.single, async pane => {
    const card = await pane.card();
    pane.onSent = key => {
      if (key === "enter") pane.screen = screens["input-empty"];
      if (key === `text:${draft}`) pane.screen = screens["input-long-narrow"];
    };
    expect(await pane.answer(card.id, { custom_text: draft })).toBe(200);
    expect(pane.sent).toEqual(["enter", `text:${draft}`, "enter"]);
  });
});

test("active Pi branch excludes an abandoned unresolved identical questionnaire", async () => {
  await withPane(screens.single, fixture.single, async pane => {
    const abandoned = await pane.card();
    pane.append({ type: "branch_summary", id: "new-branch", parentId: "root", fromId: "entry-2", summary: "Abandon interrupted question" });
    pane.append({ type: "message", id: "new-call", parentId: "new-branch", message: { role: "assistant", content: [
      { type: "toolCall", id: "active-questionnaire", name: "questionnaire", arguments: fixture.single },
    ] } });
    const current = await pane.card();
    expect(current.id).not.toBe(abandoned.id);
    expect(await pane.answer(abandoned.id, { option_index: 0 })).toBe(409);
    expect(pane.sent).toEqual([]);
    expect(await pane.answer(current.id, { option_index: 0 })).toBe(200);
    expect(pane.sent).toEqual(["enter"]);
  });
});

test("abandoned questionnaire does not suppress an unrelated native Pi dialog", async () => {
  await withPane(screens.single, fixture.single, async pane => {
    pane.append({ type: "message", id: "other-branch", parentId: "root", message: { role: "user", content: "Open a native dialog" } });
    pane.screen = "────────────────────────\n Choose a color\n\n → Red\n   Blue\n\n ↑↓ navigate  enter select  escape/ctrl+c cancel";
    const card = await pane.card();
    expect(card.question).toBe("Choose a color");
    expect(card.options.map(o => o.label)).toEqual(["Red", "Blue"]);
    expect(await pane.answer(card.id, { option_index: 0 })).toBe(200);
    expect(pane.sent).toEqual(["enter"]);
  });
});

test("questionnaire call with unverifiable Pi parent ancestry cannot authorize answers", async () => {
  await withPane(screens.single, fixture.single, async pane => {
    pane.append({ type: "message", id: "broken-call", parentId: "missing-parent", message: { role: "assistant", content: [
      { type: "toolCall", id: "broken-questionnaire", name: "questionnaire", arguments: fixture.single },
    ] } });
    expect(await pane.read()).toBeNull();
    expect(pane.sent).toEqual([]);
  });
});

test("route review preserves exact whitespace-colliding selection and refuses ambiguous wraps", async () => {
  const args = { questions: fixture.multi.questions.map((q, at) => at ? q : {
    ...q, options: [{ value: "spaced", label: "Save file" }, { value: "unspaced", label: "Savefile" }],
  }) };
  await withPane(screens.review.replace("Small compatibility fix", "Savefile"), args, async pane => {
    const card = await pane.card();
    expect(card.answers?.[0]?.answer).toBe("Savefile");
    pane.screen = screens.review.replace("Small compatibility fix", "Save\n file");
    expect(await pane.answer(card.id, { option_index: 0 })).toBe(409);
    expect(await pane.read()).toBeNull();
    expect(pane.sent).toEqual([]);
  });
});

test("old questionnaire scrollback leaves the live native Pi menu readable and answerable", async () => {
  await withPane(screens["multi-first-narrow"], fixture.multi, async pane => {
    pane.settle();
    pane.screen += "\n────────────────────────\n Choose a color\n\n → Red\n   Blue\n\n ↑↓ navigate  enter select  escape/ctrl+c cancel\n/home/fixture\n12.0%/200k some-model";
    const card = await pane.card();
    expect(card.question).toBe("Choose a color");
    expect(card.options.map(option => option.label)).toEqual(["Red", "Blue"]);
    expect(await pane.answer(card.id, { option_index: 0 })).toBe(200);
    expect(pane.sent).toEqual(["enter"]);
  });
});

test("oversized active questionnaire review cannot offer guessed fallback controls or submit", async () => {
  await withPane(screens.review, fixture.multi, async pane => {
    const card = await pane.card();
    pane.screen = screens.review.replace("Press Enter to submit", `${"x".repeat(80)}\n`.repeat(8000));
    expect(await pane.answer(card.id, { option_index: 0 })).toBe(409);
    expect(await pane.read()).toBeNull();
    expect(pane.sent).toEqual([]);
  });
});
