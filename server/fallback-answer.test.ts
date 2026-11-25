import { expect, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InteractivePrompt } from "../shared/protocol.ts";
import { agentPickerOwnsScreen } from "./dialogs/fallback.ts";
import { handlePromptRequest, parseFallbackPrompt } from "./prompt.ts";
import * as recordCards from "./record-cards.ts";

interface Pane { agent: string; screen: string; sent: string[]; onRead?: () => void }

async function withPane(agent: string, status: string, screen: string, run: (pane: Pane) => Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "herdr-fallback-answer-"));
  const path = join(root, "herdr.sock");
  const pane: Pane = { agent, screen, sent: [] };
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => undefined);
    let input = "";
    socket.on("data", (chunk) => {
      input += chunk.toString();
      if (!input.includes("\n")) return;
      const request = JSON.parse(input.split("\n")[0]!) as { id: string; method: string; params: { keys?: string[]; text?: string } };
      const answer = (result: unknown) => socket.end(`${JSON.stringify({ id: request.id, result })}\n`);
      if (request.method === "session.snapshot") return answer({ snapshot: { panes: [{ pane_id: "p_1", agent: pane.agent, agent_status: status }], layouts: [] } });
      if (request.method === "pane.read") { pane.onRead?.(); return answer({ read: { text: pane.screen } }); }
      if (request.method === "pane.process_info") return answer({ process_info: { foreground_processes: [] } });
      if (request.method === "pane.get") return answer({ pane: { pane_id: "p_1" } });
      if (request.method === "agent.get") return answer({ agent: {} });
      if (request.method !== "pane.send_keys" && request.method !== "pane.send_text") throw new Error(`unexpected fixture RPC: ${request.method}`);
      pane.sent.push(...(request.params.keys ?? [`text:${request.params.text}`]));
      answer({});
    });
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(path, resolve); });
  const previous = process.env["HERDR_SOCKET"];
  process.env["HERDR_SOCKET"] = path;
  try { await run(pane); } finally {
    if (previous === undefined) delete process.env["HERDR_SOCKET"];
    else process.env["HERDR_SOCKET"] = previous;
    for (const socket of sockets) socket.destroy();
    server.close();
    rmSync(root, { recursive: true, force: true });
  }
}

async function card(): Promise<InteractivePrompt | null> {
  const url = new URL("http://127.0.0.1/api/pane/prompt?pane_id=p_1");
  return ((await (await handlePromptRequest(new Request(url), url, {}))!.json()) as { prompt: InteractivePrompt | null }).prompt;
}

async function answer(promptId: string, choice: { option_index: number }, signal?: AbortSignal): Promise<{ status: number; code?: string }> {
  const url = new URL("http://127.0.0.1/api/pane/prompt/answer");
  const response = (await handlePromptRequest(new Request(url, { method: "POST", signal, body: JSON.stringify({ pane_id: "p_1", prompt_id: promptId, ...choice }) }), url, {}))!;
  const body = await response.json() as { error?: { code: string } };
  return { status: response.status, code: body.error?.code };
}

const labels = (prompt: InteractivePrompt) => prompt.options.map((option) => option.label);

// Agents with no reader of their own get the fallback card, and its answer was always refused: the read before the
// key had no screen to compare (readKnownPrompt reads none for them), and what they redraw while the prompt waits
// (Copilot's logo and timer, Grok's status line) changed the id every second. Recorded on Copilot 1.0.109, Grok
// 1.0.77 and Antigravity 1.5.6.
const recorded = (name: string): string => readFileSync(new URL(`./fixtures/${name}.txt`, import.meta.url), "utf8");

test.each([
  ["copilot", "copilot-1.0.109-trust-logo-a", "Do you trust the files in this folder?"],
  ["copilot", "copilot-1.0.109-ask-32s", "Which color?"],
  ["grok", "grok-1.0.77-ask", "┃  Option A or option B?"],
  ["agy", "agy-1.5.6-trust", "Do you trust the contents of this project?"],
])("answers %s's fallback card on a screen that stands still (%s)", async (agent, name, question) => {
  await withPane(agent, "blocked", recorded(name), async (pane) => {
    const prompt = (await card())!;
    expect(prompt.fallback).toBe(true);
    expect(prompt.question).toBe(question);
    expect(await answer(prompt.id, { option_index: labels(prompt).indexOf("Enter") })).toEqual({ status: 200, code: undefined });
    expect(pane.sent).toEqual(["enter"]);
  });
});

// A card showing its record's command (record-cards.ts) answers that request only: the record is read again right
// before the key, and a request no longer open there (answered in the terminal meanwhile) takes no key
test.each([[200, true], [409, false]] as const)("a card read from Copilot's record answers with %i when its request is still open: %p", async (status, open) => {
  const turn = (JSON.parse(readFileSync(join(import.meta.dir, "fixtures/record-cards/copilot.json"), "utf8")) as { turns: { turn: string; screen: string; command: string }[] }).turns
    .find((recorded) => recorded.turn === "short-a1")!;
  const request = { id: "events.jsonl\0request-1", command: turn.command };
  let reads = 0;
  const records = spyOn(recordCards, "recordRequest").mockImplementation(async () => (reads++ < 2 || open ? request : null));
  try {
    await withPane("copilot", "blocked", turn.screen, async (pane) => {
      const prompt = (await card())!;
      expect(prompt.body).toContain(turn.command);
      const result = await answer(prompt.id, { option_index: labels(prompt).indexOf("Yes") });
      expect(result.status).toBe(status);
      expect(pane.sent.length > 0).toBe(open);
      expect(reads).toBeGreaterThanOrEqual(3);
    });
  } finally { records.mockRestore(); }
});

test("answers agy's question through its reader, as a card of its options", async () => {
  await withPane("agy", "blocked", recorded("agy-1.5.6-ask"), async (pane) => {
    const prompt = (await card())!;
    expect(prompt.fallback).not.toBe(true);
    expect(prompt.question).toBe("Which file would you like to create?");
    expect(await answer(prompt.id, { option_index: 0 })).toEqual({ status: 200, code: undefined });
    expect(pane.sent).toEqual(["enter"]);
  });
});

test.each([
  ["Copilot's waiting timer", "copilot", recorded("copilot-1.0.109-ask-32s"), recorded("copilot-1.0.109-ask-36s")],
  ["Copilot's animated logo", "copilot", recorded("copilot-1.0.109-trust-logo-a"), recorded("copilot-1.0.109-trust-logo-b")],
  ["Grok's status line", "grok", recorded("grok-1.0.77-ask"), recorded("grok-1.0.77-ask").replace("7.4s ⇣21.5k [stop]", "9.1s ⇣22.0k [stop]")],
])("keeps the card and takes its answer while %s redraws", async (_what, agent, before, after) => {
  expect(after).not.toBe(before);
  await withPane(agent, "blocked", before, async (pane) => {
    const prompt = (await card())!;
    pane.screen = after;
    expect((await card())!.id).toBe(prompt.id);
    expect(await answer(prompt.id, { option_index: labels(prompt).indexOf("Enter") })).toEqual({ status: 200, code: undefined });
    expect(pane.sent).toEqual(["enter"]);
  });
});

test.each([
  ["the question", "Which color?", "Which size?"],
  ["an option", "   blue", "   green"],
  ["a number that is no time", "Copilot v1.0.109", "Copilot v1.0.110"],
  ["the words of its waiting row", "○ Asking user Waiting for response", "○ Running shell Waiting for response"],
])("still refuses a Copilot answer when %s changed under the card", async (_what, from, to) => {
  const screen = recorded("copilot-1.0.109-ask-32s");
  expect(screen).toContain(from);
  await withPane("copilot", "blocked", screen, async (pane) => {
    const prompt = (await card())!;
    pane.screen = recorded("copilot-1.0.109-ask-36s").replace(from, to);
    expect(await answer(prompt.id, { option_index: labels(prompt).indexOf("Enter") })).toEqual({ status: 409, code: "prompt_changed" });
    expect(pane.sent).toEqual([]);
  });
});

test("reads drawing glyphs outside Copilot's banner logo as written", () => {
  const screen = recorded("copilot-1.0.109-ask-32s");
  const id = (option: string) => parseFallbackPrompt("copilot", screen.replace("   blue", `   ${option}`)).id;
  expect(id("./\u2588.txt")).not.toBe(id("./\u2591.txt"));
  expect(id("blue \u2588")).not.toBe(id("blue \u2591"));
});

// a menu that marks its selection with a filled block against a hollow one: the mark moving is another card, so an
// Enter read for one row never lands on the other (merge-pass review of #3730)
test.each([["\u2591", "\u2588"], ["\u2591\u2591", "\u2588\u2588"], ["\u28c0", "\u28ff"]])("still refuses an answer once a menu marked %s / %s moved its selection", async (hollow, filled) => {
  const menu = (marks: [string, string]) => `Remove the staging database?\n\n${marks[0]} Delete\n${marks[1]} Keep\n\n↑/↓ to move · enter to choose\n`;
  await withPane("copilot", "blocked", menu([hollow, filled]), async (pane) => {
    const prompt = (await card())!;
    pane.screen = menu([filled, hollow]);
    expect(parseFallbackPrompt("copilot", pane.screen).id).not.toBe(prompt.id);
    expect(await answer(prompt.id, { option_index: labels(prompt).indexOf("Enter") })).toEqual({ status: 409, code: "prompt_changed" });
    expect(pane.sent).toEqual([]);
  });
});

// selection marks beside a border or guide glyph, at a row's end, or two glyphs wide (merge-pass review of #3730): the
// mark moving is another card for any agent, so an Enter read for one row never lands on the other
const SWAPPED_MARKS: [string, [string, string], [string, string]][] = [
  ["a heavy rule", ["\u2503 \u2588 Delete", "\u2503 \u2591 Keep"], ["\u2503 \u2591 Delete", "\u2503 \u2588 Keep"]],
  ["a double frame", ["\u2551 \u2588 Delete \u2551", "\u2551 \u2591 Keep \u2551"], ["\u2551 \u2591 Delete \u2551", "\u2551 \u2588 Keep \u2551"]],
  ["a tree guide", ["\u251c \u2588 Delete", "\u2514 \u2591 Keep"], ["\u251c \u2591 Delete", "\u2514 \u2588 Keep"]],
  ["the row's end", ["Delete \u2588", "Keep \u2591"], ["Delete \u2591", "Keep \u2588"]],
  ["two glyphs", ["\u2588\u2588 Delete", "\u2591\u2591 Keep"], ["\u2591\u2591 Delete", "\u2588\u2588 Keep"]],
  ["a column rule", ["\u2588 \u2502 Delete", "\u2591 \u2502 Keep"], ["\u2591 \u2502 Delete", "\u2588 \u2502 Keep"]],
];
test.each(SWAPPED_MARKS.flatMap(([shape, before, after]) => ["copilot", "claude"].map((agent) => [agent, shape, before, after] as const)))(
  "still refuses %s's answer once a selection marked beside %s moved", async (agent, _shape, before, after) => {
    const menu = (rows: readonly [string, string]) => `Remove the staging database?\n\n${rows[0]}\n${rows[1]}\n\n\u2191/\u2193 to move \u00b7 enter to choose\n`;
    await withPane(agent, "blocked", menu(before), async (pane) => {
      const prompt = (await card())!;
      pane.screen = menu(after);
      expect(await answer(prompt.id, { option_index: labels(prompt).indexOf("Enter") })).toEqual({ status: 409, code: "prompt_changed" });
      expect(pane.sent).toEqual([]);
    });
  });

// The read right before the key, not only the answer's first read, must still show the card: the screen changes after
// the answer has read it, between that read and the key (merge-pass review of #3730)
test("refuses the key when the question changed after the answer's first read", async () => {
  const screen = recorded("copilot-1.0.109-ask-32s");
  await withPane("copilot", "blocked", screen, async (pane) => {
    const prompt = (await card())!;
    let reads = 0;
    pane.onRead = () => { if (++reads === 2) pane.screen = screen.replace("Which color?", "Which size?"); };
    expect(await answer(prompt.id, { option_index: labels(prompt).indexOf("Enter") })).toEqual({ status: 409, code: "prompt_changed" });
    expect(reads).toBeGreaterThanOrEqual(2);
    expect(pane.sent).toEqual([]);
  });
});

test("sends nothing for an answer given up during the read before its key", async () => {
  const screen = recorded("copilot-1.0.109-ask-32s");
  await withPane("copilot", "blocked", screen, async (pane) => {
    const prompt = (await card())!;
    const given = new AbortController();
    let reads = 0;
    pane.onRead = () => { if (++reads === 2) given.abort(); };
    expect(await answer(prompt.id, { option_index: labels(prompt).indexOf("Enter") }, given.signal)).toEqual({ status: 409, code: "prompt_changed" });
    expect(pane.sent).toEqual([]);
  });
});

test.each([
  ["hermes", "\u2753 Which color?", "\u2753 Which size?"],
  ["muse", "Request user input Color", "Request user input Size"],
  ["maki", "bash> List directory contents", "bash> Remove directory contents"],
  ["kimi", "Using Shell (ls -la)", "Using Shell (rm -rf .)"],
  ["dsh-tui", "Checking with you", "Deleting for you"],
])("keeps %s's card while its timer or spinner redraws, and not once its words change", (agent, from, to) => {
  const [before, after] = ["a", "b"].map((frame) => recorded(`lab-${agent}-waiting-${frame}`)) as [string, string];
  expect(after).not.toBe(before);
  expect(parseFallbackPrompt(agent, after).id).toBe(parseFallbackPrompt(agent, before).id);
  // Muse turns its glyph through three frames
  if (agent === "muse") expect(parseFallbackPrompt(agent, after.replace("\u25c7 Request", "\u25c6 Request")).id).toBe(parseFallbackPrompt(agent, before).id);
  expect(after.split(from).length).toBe(2);
  expect(parseFallbackPrompt(agent, after.replace(from, to)).id).not.toBe(parseFallbackPrompt(agent, before).id);
});

// Grok 1.0.92 redraws the tool call its permission panel asks about every tenth of a second (server/fixtures/record-cards)
test.each(["long-a1", "phone-a1"])("keeps Grok's permission card (%s) while its tool call's timers tick, and not once its words change", (name) => {
  const turns = (JSON.parse(readFileSync(join(import.meta.dir, "fixtures/record-cards/grok.json"), "utf8")) as { turns: { turn: string; screen: string }[] }).turns;
  const screen = turns.find((turn) => turn.turn === name)!.screen;
  const row = screen.split("\n").find((line) => line.includes("[↓][stop]"))!;
  const ticked = row.replace(/(\d+)s ⇣([\d.]+)k/u, (_all, seconds: string, tokens: string) => `${Number(seconds) + 3}s ⇣${(Number(tokens) + 0.4).toFixed(1)}k`).replace("0.0s", "0.3s");
  expect(ticked).not.toBe(row);
  expect(parseFallbackPrompt("grok", screen.replace(row, ticked)).id).toBe(parseFallbackPrompt("grok", screen).id);
  expect(parseFallbackPrompt("grok", screen.replace(row, row.replace("◆ Run", "◆ Remove"))).id).not.toBe(parseFallbackPrompt("grok", screen).id);
});

// The refusal on each recorded approval (short-d) sends the one key that refuses in that CLI, measured on the real
// TUIs: Copilot 1.0.109 only moves its cursor to a typed 3 and Letta 0.34.23 ignores it, where Esc refuses; Esc in
// Grok 1.0.92 moves its focus to the scrollback, where the panel's own number for "No, reject" refuses (#4570, #4571)
const recordedTurn = (agent: string, name: string): string => (JSON.parse(readFileSync(join(import.meta.dir, `fixtures/record-cards/${agent}.json`), "utf8")) as { turns: { turn: string; screen: string }[] }).turns
  .find((recorded) => recorded.turn === name)!.screen;

test.each([
  ["copilot", "short-d", "No, and tell Copilot what to do differently (Esc to stop)", ["esc"]],
  ["letta", "short-d", "No, and tell Letta Code what to do differently", ["esc"]],
  ["grok", "short-d", "No, reject", ["text:4"]],
  // a phone-wide pane cuts the row's hint, and Grok numbers this panel's rows from 2
  ["grok", "phone-a1", "No, reject", ["text:3"]],
])("refuses %s's recorded approval (%s) from its card with the key that refuses", async (agent, name, refusal, keys) => {
  await withPane(agent, "blocked", recordedTurn(agent, name), async (pane) => {
    const prompt = (await card())!;
    expect(labels(prompt)).toContain(refusal);
    expect(await answer(prompt.id, { option_index: labels(prompt).indexOf(refusal) })).toEqual({ status: 200, code: undefined });
    expect(pane.sent).toEqual(keys);
  });
});

// Grok's refusal is read off the permission panel that ends the screen only: a Grok question drawn like one (its own
// footer says "Tab:next answer"), or a row like the refusal above the panel, gets no key that the panel would take
// for another row
test("offers no refusal row on a Grok question drawn like a permission panel", () => {
  const screen = recorded("grok-1.0.77-ask");
  const alike = screen.replace("┃  Option A or option B?", "┃  ›  Run setup?")
    .replace(/1 \(○\) Option A[^\n]*/u, "1 (●) Yes, proceed").replace(/2 \(○\) Option B[^\n]*/u, "2 (○) No, reject (type to add feedback)");
  expect(alike).toContain("No, reject");
  expect(labels(parseFallbackPrompt("grok", alike))).toEqual(["Enter", "Esc"]);
});

test("takes Grok's refusal from the panel itself, not from a row like it above the panel", async () => {
  const screen = recordedTurn("grok", "phone-a1");
  const above = screen.replace("  ┃\n  ┃  ›", "  ┃  2 (○) No, reject (type to add feedback)\n\n  ┃\n  ┃  ›");
  expect(above).not.toBe(screen);
  await withPane("grok", "blocked", above, async (pane) => {
    const prompt = (await card())!;
    expect(await answer(prompt.id, { option_index: labels(prompt).indexOf("No, reject") })).toEqual({ status: 200, code: undefined });
    expect(pane.sent).toEqual(["text:3"]);
  });
});

// Muse 1.4.25 keeps "◇ Calling tools (21s · esc to interrupt)" over its approval dialog, its time and glyph ticking
test("keeps Muse's approval card while the row over it ticks, and not once its words change", () => {
  const turn = (JSON.parse(readFileSync(join(import.meta.dir, "fixtures/record-cards/muse.json"), "utf8")) as { turns: { turn: string; screen: string }[] }).turns
    .find((recorded) => recorded.turn === "long-a1")!;
  const row = turn.screen.split("\n").find((line) => line.includes("· esc to interrupt)"))!;
  const ticked = row.replace(/\((\d+)s · /u, (_all, seconds: string) => `(${Number(seconds) + 7}s · `).replace(/[◆◈◇]/u, "◇");
  expect(ticked).not.toBe(row);
  expect(parseFallbackPrompt("muse", turn.screen.replace(row, ticked)).id).toBe(parseFallbackPrompt("muse", turn.screen).id);
  expect(parseFallbackPrompt("muse", turn.screen.replace(row, row.replace("Calling tools", "Deleting files"))).id).not.toBe(parseFallbackPrompt("muse", turn.screen).id);
});

test("keeps Hermes's card in its first ten seconds, where the timer is padded with two spaces", () => {
  const screen = recorded("lab-hermes-waiting-a");
  expect(screen.split("( 57.9s").length).toBe(2);
  const at = (time: string) => parseFallbackPrompt("hermes", screen.replace("( 57.9s", time)).id;
  expect(at("(  5.3s")).toBe(at("(  5.2s"));
  expect(at("(  5.2s")).toBe(at("( 57.9s"));
  // a token count past a thousand is drawn with a K
  expect(screen.split("\u2193 34 tok)").length).toBe(2);
  expect(parseFallbackPrompt("hermes", screen.replace("\u2193 34 tok)", "\u2193 1.2K tok)")).id).toBe(at("( 57.9s"));
});

test("keeps the words Hermes's status bar echoes, blanking only its ticking segments", () => {
  const [before, after] = ["a", "b"].map((frame) => recorded(`lab-hermes-waiting-${frame}`)) as [string, string];
  const echo = "\u2500 Use your tool for asking...";
  expect(after.split(echo).length).toBe(2);
  expect(parseFallbackPrompt("hermes", after).id).toBe(parseFallbackPrompt("hermes", before).id);
  expect(parseFallbackPrompt("hermes", after.replace(echo, "\u2500 Delete the staging data...")).id).not.toBe(parseFallbackPrompt("hermes", before).id);
  expect(after.split("\u2624 gpt-6-luna \u2502").length).toBe(2);
  expect(parseFallbackPrompt("hermes", after.replace("\u2624 gpt-6-luna \u2502", "\u2624 gpt-6-sol \u2502")).id).not.toBe(parseFallbackPrompt("hermes", before).id);
});

test("keeps the ids of Copilot's and Grok's cards as #3730 gave them", () => {
  expect(parseFallbackPrompt("copilot", recorded("copilot-1.0.109-ask-32s")).id).toBe("2af485654211");
  expect(parseFallbackPrompt("grok", recorded("grok-1.0.77-ask")).id).toBe("09168e691891");
});

// A picker of the agent's own that herdr reports at rest under (Devin's and Copilot's folder trust at start): the chat
// shows its card, and a chat message is refused rather than picking the row under the cursor (core/composer.ts).
test.each([
  ["devin-3000.12.43-trust", true],
  ["copilot-1.0.109-trust-logo-a", true],
  ["agy-1.5.6-trust", true],
  ["devin-3000.12.43-composer", false],
  ["copilot-1.0.109-composer", false],
  ["grok-1.0.77-composer", false],
])("tells an agent's own picker from its composer (%s)", (name, picker) => {
  expect(agentPickerOwnsScreen(recorded(name))).toBe(picker);
});

// a narrow pane wraps the key hint onto a second row: neither row alone both moves and chooses
test.each(["↑↓ sel", "↑↓ select ·", "↑↓ select · "])("tells Devin's folder trust with its key hint wrapped after %p", (head) => {
  const lines = recorded("devin-3000.12.43-trust").split("\n");
  const at = lines.findIndex((line) => line.includes("↑↓ select"));
  const hint = lines[at]!;
  const cut = hint.indexOf(head) + head.length;
  lines.splice(at, 1, hint.slice(0, cut), hint.slice(cut));
  expect(agentPickerOwnsScreen(lines.join("\n"))).toBe(true);
});

test("tells a picker whose worded key hint wraps inside a word", () => {
  const screen = recorded("devin-3000.12.43-trust").replace(/ ↑↓ select .*/, " up/down to move · en\nter to select");
  expect(agentPickerOwnsScreen(screen)).toBe(true);
});

test("offers and answers Devin's folder trust while herdr reports Devin at rest", async () => {
  await withPane("devin", "idle", recorded("devin-3000.12.43-trust"), async (pane) => {
    const prompt = (await card())!;
    expect(prompt.fallback).toBe(true);
    expect(prompt.question).toBe("\u2731 Do you trust the authors of this directory?");
    expect(await answer(prompt.id, { option_index: labels(prompt).indexOf("Enter") })).toEqual({ status: 200, code: undefined });
    expect(pane.sent).toEqual(["enter"]);
  });
});

test.each([
  ["devin", "idle", recorded("devin-3000.12.43-composer")],
  ["claude", "idle", recorded("devin-3000.12.43-trust")],
])("offers no card for %s at rest without a picker of its own", async (agent, status, screen) => {
  await withPane(agent, status, screen, async () => {
    expect(await card()).toBeNull();
  });
});

// Copilot 1.0.109 draws its numbered menus in a box (`│ ❯ 1. Yes │`): read through the box, each row is an option
// answered by its number, as Copilot takes it (answered live: "1" ran the command)
test.each([
  ["copilot-1.0.109-run-command", "Do you want to run this command?", ["Yes", "No, and tell Copilot what to do differently (Esc to stop)"]],
  ["copilot-1.0.109-trust-logo-a", "Do you trust the files in this folder?", ["Yes", "Yes, and remember this folder for future sessions", "No (Esc)"]],
])("offers each row of Copilot's boxed menu (%s)", async (name, question, rows) => {
  await withPane("copilot", "blocked", recorded(name), async (pane) => {
    const prompt = (await card())!;
    expect(prompt.question).toBe(question);
    expect(labels(prompt)).toEqual([...rows, "Enter", "Esc"]);
    expect(await answer(prompt.id, { option_index: 0 })).toEqual({ status: 200, code: undefined });
    expect(pane.sent).toEqual(["text:1"]);
  });
});
