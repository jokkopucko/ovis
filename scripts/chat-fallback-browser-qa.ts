/** Real ChatView with an unavailable conversation and a stalled optional terminal. */
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { build as viteBuild } from "vite";
import { CONTENT_SECURITY_POLICY } from "../server/static.ts";
import { chromePath } from "./chrome-path.ts";
import { parseClaudeTranscript } from "../server/conversation.ts";
import type { ConversationTurn, InteractivePrompt } from "../shared/protocol.ts";
import type {} from "./chat-fallback-fixture.tsx";
import { parseInteractivePrompt } from "../server/prompt.ts";
import { parseOmpTranscript } from "../server/transcript-records.ts";
import piNavigation from "../server/fixtures/pi-ask-navigation.json";
const root = realpathSync(mkdtempSync(join(tmpdir(), "herdr-chat-fallback-")));
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
let server: ReturnType<typeof Bun.serve> | undefined;
try {
  const repo = join(import.meta.dir, ".."), output = join(root, "dist");
  symlinkSync(join(repo, "node_modules"), join(root, "node_modules"), "dir");
  symlinkSync(join(repo, "scripts/chat-fallback-fixture.tsx"), join(root, "fixture.tsx"));
  writeFileSync(join(root, "index.html"), '<html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="/fixture.tsx"></script></body></html>');
  await viteBuild({ configFile: join(repo, "vite.config.ts"), root, publicDir: false, logLevel: "warn", build: { outDir: output, emptyOutDir: true } });
  const terminalReads: string[] = [];
  let structured = false, resolveAgent!: () => void, agentReadArrived!: () => void;
  let lookupTimeout = false;
  let source = "codex-transcript";
  let prompt: InteractivePrompt | null = null;
  // the answers of pane "screen": settings read off the agent's own screen (ConversationResponse.screen)
  let screenAnswer: Record<string, unknown> = {};
  let turns: ConversationTurn[] = [{ role: "assistant", ts: null, parts: [{ kind: "text", text: "Structured conversation arrived" }] }];
  // resolved by the server's handler: a browser-side waitForRequest can win the race against it
  const agentRead = new Promise<void>((resolve) => { agentReadArrived = resolve; });
  server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    const url = new URL(request.url), pane = url.searchParams.get("pane_id");
    if (url.pathname === "/api/pane/prompt") return Response.json({ prompt, outcomes: [] });
    // the chat's skill matcher asks for the pane's commands
    if (url.pathname === "/api/pane/commands") return Response.json({ commands: [] });
    if (url.pathname === "/api/pane/conversation") {
      if (pane === "screen") return Response.json({ cursor: null, turns: [], ...screenAnswer });
      if (lookupTimeout && pane === "agent") return Response.json({ error: { code: "read_timeout", message: "Conversation read timed out." } }, { status: 504 });
      return Response.json({ source: (structured && pane === "agent") || pane === "empty" ? source : "scrollback", cursor: null, turns: structured && pane === "agent" ? turns : [] });
    }
    if (url.pathname === "/api/pane/read") {
      terminalReads.push(pane ?? "");
      if (pane === "error") return Response.json({ error: { code: "read_failed", message: "Terminal output unavailable" } }, { status: 500 });
      const response = () => Response.json({ read: { text: pane === "shell" ? "Shell inline output" : "OLD AGENT TERMINAL", truncated: false } });
      if (pane === "agent") return new Promise<Response>((resolve) => { resolveAgent = () => resolve(response()); agentReadArrived(); });
      return response();
    }
    if (url.pathname === "/favicon.ico") return new Response(null, { status: 204 });
    return new Response(Bun.file(join(output, url.pathname === "/" ? "index.html" : url.pathname.slice(1))), { headers: { "content-security-policy": CONTENT_SECURITY_POLICY } });
  } });
  browser = await chromium.launch({ executablePath: chromePath(), headless: true, args: ["--no-sandbox"] });
  const page = await browser.newPage(); page.setDefaultTimeout(10_000);
  await page.addInitScript(() => localStorage.setItem("ovis:settings", JSON.stringify({ language: "en" })));
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.port}`);
  const summary = page.locator(".chat-terminal-fallback summary");
  await summary.waitFor();
  await page.getByText("Loading conversation…", { exact: true }).waitFor({ state: "detached" });
  assert.equal(terminalReads.length, 0, "a hidden terminal read cannot hold the initial chat");
  assert.equal(await page.locator(".chat-empty").count(), 0, "an agent terminal fallback does not claim the conversation is empty");
  if (process.env.UI_EVIDENCE_DIR) {
    mkdirSync(process.env.UI_EVIDENCE_DIR, { recursive: true });
    await page.screenshot({ path: join(process.env.UI_EVIDENCE_DIR, "terminal-fallback-closed.png") });
  }
  await summary.click();
  let deadline: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([agentRead, new Promise<never>((_, reject) => { deadline = setTimeout(() => reject(new Error("opening the disclosure never read the agent terminal")), 10_000); })]);
  clearTimeout(deadline);
  assert.ok(terminalReads.includes("agent"));
  structured = true;
  await page.evaluate(() => window.chatFallbackQA.refresh());
  await page.getByText("Structured conversation arrived", { exact: true }).waitFor();
  lookupTimeout = true;
  const timedOut = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/pane/conversation" && response.status() === 504);
  await page.evaluate(() => window.chatFallbackQA.refresh());
  await timedOut;
  await page.getByText("Waiting for the PC…", { exact: true }).waitFor();
  assert.equal(await page.getByText("Structured conversation arrived", { exact: true }).isVisible(), true, "a temporary SDK timeout keeps the already rendered conversation");
  assert.equal(await page.locator(".chat-terminal-fallback").count(), 0, "a timeout does not replace the conversation with terminal fallback");
  lookupTimeout = false;
  turns = [{ role: "assistant", ts: null, parts: [{ kind: "text", text: "Conversation recovered after SDK timeout" }] }];
  await page.evaluate(() => window.chatFallbackQA.refresh());
  await page.getByText("Conversation recovered after SDK timeout", { exact: true }).waitFor();
  await page.getByText("Waiting for the PC…", { exact: true }).waitFor({ state: "hidden" });
  const nextKindRead = page.waitForRequest((request) => new URL(request.url()).pathname === "/api/pane/conversation", { timeout: 3_000 });
  await page.evaluate(() => window.chatFallbackQA.agent("claude"));
  await nextKindRead;
  resolveAgent();
  await page.locator(".chat-terminal-fallback").waitFor({ state: "detached" });
  assert.ok(!(await page.locator("body").innerText()).includes("OLD AGENT TERMINAL"));
  await page.evaluate(() => window.chatFallbackQA.pane("shell"));
  await page.getByText("Shell inline output", { exact: true }).waitFor();
  assert.ok(terminalReads.includes("shell"), "non-agent scrollback remains inline");
  await page.evaluate(() => window.chatFallbackQA.pane("error"));
  await summary.waitFor();
  await summary.click();
  // the failure is one line naming what failed, Try again beside it (no cause is known), and the
  // advice with the server's words folded behind Details (lib/userError.ts, ChatView FailureLine)
  const fallbackError = page.locator(".chat-terminal-fallback [role=\"alert\"]");
  await fallbackError.waitFor();
  assert.equal(await fallbackError.count(), 1, "terminal-read failures are announced as errors");
  assert.equal(await fallbackError.locator(".chat-failure-line").innerText(), "Couldn't load the terminal output", "the alert names what failed, nothing more on the line");
  assert.equal(await fallbackError.getByRole("button", { name: "Try again", exact: true }).count(), 1, "an unknown cause offers Try again");
  const fold = fallbackError.locator("details");
  assert.equal(await fold.locator("> summary").innerText(), "Details", "the rest is folded");
  assert.equal(await fold.evaluate((node: HTMLDetailsElement) => node.open), false, "and folded until asked");
  await fold.locator("> summary").click();
  assert.ok((await fold.innerText()).includes("Try again; if it keeps failing, restart Ovis on the PC."), "opened, Details holds the advice");
  assert.equal(await fold.locator("code").innerText(), "Terminal output unavailable", "and the server's words, selectable, beside it");
  assert.equal(await page.locator(".chat-empty").count(), 0, "a fallback failure is not an empty structured conversation");
  await page.evaluate(() => window.chatFallbackQA.pane("empty"));
  await page.getByText("No conversation yet — say something below", { exact: true }).waitFor();
  assert.equal(await page.locator(".chat-terminal-fallback").count(), 0, "an empty structured conversation keeps its ordinary prompt");
  // Native parser output crosses HTTP into the real ChatView. Later activity must not
  // move a final reply into the fold or duplicate it. Only explicit commentary joins the tools there.
  const jsonl = (...records: unknown[]) => records.map((record) => JSON.stringify(record)).join("\n");
  source = "claude-transcript";
  turns = parseClaudeTranscript(jsonl(
    { type: "assistant", timestamp: "2026-01-01T12:00:00Z", message: { content: [{ type: "text", text: "The catalog has three books." }], stop_reason: "end_turn" } },
    { type: "user", message: { content: "<task-notification><task-id>catalog</task-id><status>completed</status><summary>Catalog check finished.</summary></task-notification>" } },
    { type: "assistant", timestamp: "2026-01-01T12:01:00Z", message: { content: [{ type: "tool_use", id: "check", name: "Bash", input: { command: "true" } }], stop_reason: "tool_use" } },
    { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "check", content: "Two available" }] } },
    { type: "assistant", timestamp: "2026-01-01T12:02:00Z", message: { content: [{ type: "text", text: "Two books are available." }], stop_reason: "end_turn" } },
    { type: "user", isMeta: true, userType: "external", message: { content: "Background command catalog-check failed with exit code 124" } },
    { type: "assistant", timestamp: "2026-01-01T12:03:00Z", message: { content: [{ type: "text", text: "The background check timed out." }], stop_reason: "end_turn" } },
  ));
  await page.evaluate(() => { window.chatFallbackQA.agent("claude"); window.chatFallbackQA.pane("agent"); window.chatFallbackQA.refresh(); });
  await page.getByText("The background check timed out.", { exact: true }).waitFor();
  const replies = page.locator(".chat-turn-agent");
  console.log("Claude background reply rendering:", JSON.stringify(await replies.allTextContents()));
  assert.equal(await replies.count(), 3, "completed replies have separate message bubbles");
  for (const [index, text] of ["The catalog has three books.", "Two books are available.", "The background check timed out."].entries()) {
    assert.equal(await replies.nth(index).getByText(text, { exact: true }).isVisible(), true, "replies stay visible in transcript order");
    assert.equal(await replies.nth(index).locator("time").count(), 1, "each reply has its own time");
    assert.equal(await replies.nth(index).locator("time").getAttribute("datetime"), ["2026-01-01T12:00:00Z", "2026-01-01T12:01:00Z", "2026-01-01T12:03:00Z"][index], "each bubble keeps its own turn timestamp");
  }
  assert.equal(await replies.nth(0).locator(".work-block").count(), 0, "later tools do not move before the first reply");
  assert.equal(await replies.nth(1).locator(".work-block").count(), 1, "tools stay with the reply they produced");
  assert.equal(await replies.nth(2).locator(".work-block").count(), 0, "later reply does not inherit earlier tools");
  if (process.env.UI_EVIDENCE_DIR) await page.screenshot({ path: join(process.env.UI_EVIDENCE_DIR, "claude-separate-replies.png") });
  console.log("PASS Claude background continuations keep separate replies, times and intervening work");
  {
    const answer = "The fictional Claude catalog contains three books.";
    const narration = "Checking the Claude catalog.";
    turns = parseClaudeTranscript(jsonl(
      { type: "assistant", message: { content: [{ type: "text", text: answer }], stop_reason: "end_turn" } },
      { type: "user", isMeta: true, userType: "external", message: { role: "user", content: "Stop hook feedback: Verify the fictional catalog." } },
      { type: "system", subtype: "stop_hook_summary" },
      { type: "assistant", message: { content: [{ type: "text", text: narration }, { type: "tool_use", id: "cleanup", name: "Bash", input: { command: "true" } }], stop_reason: "tool_use" } },
      { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "cleanup", content: "Verified" }] } },
      { type: "assistant", message: { content: [{ type: "text", text: "Catalog verification complete." }], stop_reason: "end_turn" } },
    ));
    await page.evaluate(() => { window.chatFallbackQA.agent("claude"); window.chatFallbackQA.pane("agent"); window.chatFallbackQA.refresh(); });
    await page.getByText(answer, { exact: true }).waitFor();
    const continuation = page.locator(".chat-turn-agent").nth(1);
    const work = continuation.locator(".work-block");
    const head = work.locator(".work-block-head");
    await head.waitFor();
    if (await head.getAttribute("aria-expanded") === "true") await head.click();
    await work.locator(".work-block-rows").waitFor({ state: "hidden" });
    assert.equal(await work.getByText(answer, { exact: true }).count(), 0, "the reply is outside work");
    assert.equal(await page.getByText(answer, { exact: true }).count(), 1, "the reply appears once");
    assert.equal(await page.getByText(answer, { exact: true }).isVisible(), true, "folding work keeps the reply visible");
    assert.equal(await continuation.getByText(narration, { exact: true }).isVisible(), true, "unphased narration stays visible outside folded work");
    assert.equal(await work.getByText(narration, { exact: true }).count(), 0, "unphased narration is not part of work");
    assert.equal(await page.getByText(narration, { exact: true }).count(), 1, "unphased narration appears once");
    assert.equal(await page.getByText("Catalog verification complete.", { exact: true }).isVisible(), true, "the hook continuation's short reply is also visible");
    assert.equal(await page.locator(".chat-turn-agent").count(), 2, "hook continuation answers have separate bubbles");
    assert.equal(await page.getByText(/Stop hook feedback:/).count(), 0, "injected hook context is not a user message");
    await head.click();
    assert.equal(await work.locator(".work-row-head").count(), 1, "the tool stays inside work");
    await head.click();
    if (process.env.UI_EVIDENCE_DIR) await page.screenshot({ path: join(process.env.UI_EVIDENCE_DIR, "claude-hook-separate-replies.png") });
    console.log("PASS Claude hook narration and replies stay visible outside folded work; the tool remains inside");
  }
  {
    // A turn reads in the agent's own order, as its terminal does: words written before a tool call
    // stay above it, and each run of work sits between the words around it.
    const rows = () => page.locator(".chat-turn-agent").last().evaluate((turn) => [...turn.children].flatMap((child) => {
      if (child.classList.contains("chat-turn-meta")) return [];
      if (child.classList.contains("work-block")) return [["work", ...[".work-block-title", ".work-block-summary"].map((part) => child.querySelector(part)?.textContent ?? "")].join(" ")];
      const words = (child as HTMLElement).innerText.trim();
      return words ? [words] : [];
    }));
    const message = (role: string, extra: Record<string, unknown>) => ({ type: "message", message: { role, ...extra } });
    source = "pi-transcript";
    turns = parseOmpTranscript(jsonl(
      message("user", { content: [{ type: "text", text: "Update the test server." }] }),
      message("assistant", { stopReason: "toolUse", content: [
        { type: "thinking", thinking: "Check what it runs first." },
        { type: "text", text: "I read this as: bring the test server up to date." },
        { type: "toolCall", id: "one", name: "eval", arguments: { summary: "Checking the revision" } },
      ] }),
      message("toolResult", { toolCallId: "one", content: [{ type: "text", text: "rev a" }] }),
      message("assistant", { stopReason: "toolUse", content: [{ type: "toolCall", id: "two", name: "eval", arguments: { summary: "Checking the service" } }] }),
      message("toolResult", { toolCallId: "two", content: [{ type: "text", text: "active" }] }),
      message("assistant", { stopReason: "toolUse", content: [{ type: "thinking", thinking: "Restart it." }, { type: "toolCall", id: "three", name: "eval", arguments: { summary: "Restarting" } }] }),
      message("toolResult", { toolCallId: "three", content: [{ type: "text", text: "restarted" }] }),
      message("assistant", { stopReason: "stop", content: [{ type: "text", text: "The test server runs the latest main." }] }),
    ));
    await page.evaluate(() => { window.chatFallbackQA.agent("pi"); window.chatFallbackQA.pane("agent"); window.chatFallbackQA.refresh(); });
    await page.getByText("The test server runs the latest main.", { exact: true }).waitFor();
    const piRows = await rows();
    console.log("OmO/pi turn order:", JSON.stringify(piRows));
    assert.deepEqual(piRows, ["I read this as: bring the test server up to date.", "work Worked \u00b7 3 commands", "The test server runs the latest main."], "words before the tool calls stay above their one work block");
    if (process.env.UI_EVIDENCE_DIR) await page.screenshot({ path: join(process.env.UI_EVIDENCE_DIR, "pi-words-before-tools.png") });
    source = "claude-transcript";
    // the turn, ended (Claude's end_turn makes its last words the final answer) or still at work on them
    const catalog = (stop: "end_turn" | null): ConversationTurn[] => parseClaudeTranscript(jsonl(
      { type: "user", message: { content: "Check the catalog." } },
      { type: "assistant", message: { content: [{ type: "text", text: "Checking the catalog first." }, { type: "tool_use", id: "a", name: "Bash", input: { command: "ls" } }], stop_reason: "tool_use" } },
      { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "a", content: "books" }] } },
      { type: "assistant", message: { content: [{ type: "text", text: "Three books. Now the loans." }, { type: "tool_use", id: "b", name: "Bash", input: { command: "cat loans" } }], stop_reason: "tool_use" } },
      { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "b", content: "none" }] } },
      { type: "assistant", message: { content: [{ type: "text", text: "No book is on loan." }], stop_reason: stop } },
    ));
    turns = catalog("end_turn");
    await page.evaluate(() => { window.chatFallbackQA.agent("claude"); window.chatFallbackQA.refresh(); });
    await page.getByText("No book is on loan.", { exact: true }).waitFor();
    assert.deepEqual(await rows(), ["Checking the catalog first.", "work Worked \u00b7 1 command", "Three books. Now the loans.", "work Worked \u00b7 1 command", "No book is on loan."], "each run of work stays between the words around it");
    // the turn still at work: one that ended on its final answer stays finished while the agent works again
    turns = catalog(null);
    await page.evaluate(() => { window.chatFallbackQA.status("working"); window.chatFallbackQA.refresh(); });
    const live = page.locator(".chat-turn-agent").last().locator(".work-block.is-live");
    await live.waitFor();
    assert.deepEqual(await rows(), ["Checking the catalog first.", "work Worked \u00b7 1 command", "Three books. Now the loans.", "work Working\u2026 \u00b7 1 command", "No book is on loan."], "while the turn runs, only its last run of work reads Working");
    assert.equal(await live.count(), 1, "one Working at a time");
    if (process.env.UI_EVIDENCE_DIR) await page.screenshot({ path: join(process.env.UI_EVIDENCE_DIR, "claude-runs-live.png") });
    // An earlier run splits when its blank text gets words: every block keeps the fold it had.
    const bash = (command: string) => ({ kind: "tool" as const, name: "Bash", summary: command, input: JSON.stringify({ command }), output: "" });
    const said = (value: string) => ({ kind: "text" as const, text: value });
    const shelves = (first: string): ConversationTurn[] => [
      { role: "user", ts: null, parts: [said("List the shelves.")] },
      { role: "assistant", ts: null, parts: [said("Three shelves.")] },
      { role: "user", ts: null, parts: [said("Check each shelf.")] },
      { role: "assistant", ts: null, parts: [bash("ls a"), said(first), bash("ls b"), said("Shelf b next."), bash("ls c")] },
    ];
    const heads = page.locator(".chat-turn-agent").last().locator(".work-block-head");
    const opened = async () => Promise.all((await heads.all()).map(async (head) => await head.getAttribute("aria-expanded") === "true"));
    turns = shelves("");
    await page.evaluate(() => window.chatFallbackQA.refresh());
    await page.getByText("Shelf b next.", { exact: true }).waitFor();
    assert.deepEqual(await opened(), [false, true], "while the turn runs only its working run is open");
    const headRows = page.locator(".chat-turn-agent").last().locator(".work-block").last().locator(".work-block-rows");
    await heads.last().click();
    await headRows.waitFor({ state: "hidden" });
    assert.deepEqual(await opened(), [false, false], "the reader folds the working run");
    turns = shelves("Shelf a is empty.");
    await page.evaluate(() => window.chatFallbackQA.refresh());
    await page.getByText("Shelf a is empty.", { exact: true }).waitFor();
    assert.deepEqual(await opened(), [false, false, false], "a run that splits moves no fold to another block: the folded run stays folded");
    await headRows.waitFor({ state: "hidden" });
    if (process.env.UI_EVIDENCE_DIR) await page.screenshot({ path: join(process.env.UI_EVIDENCE_DIR, "claude-run-split.png") });
    // Words before a run's tools join it later (a Codex record marks them commentary): the run
    // keeps the fold the reader gave it (#2063). A history without an ID keeps each row's memory
    // by its place, so the turn sits on row 5, which the four rows above left with none.
    const sorting = (words: { kind: "text"; text: string; phase?: "commentary" }): ConversationTurn[] => [
      ...shelves("Shelf a is empty."),
      { role: "user", ts: null, parts: [said("Sort the shelves.")] },
      { role: "assistant", ts: null, parts: [words, bash("sort a")] },
    ];
    turns = sorting(said("Sorting shelf a."));
    await page.evaluate(() => window.chatFallbackQA.refresh());
    await page.getByText("Sorting shelf a.", { exact: true }).waitFor();
    assert.deepEqual(await rows(), ["Sorting shelf a.", "work Working\u2026 \u00b7 1 command"], "the words stand above the working run");
    assert.deepEqual(await opened(), [true], "the working run is open");
    await heads.last().click();
    await headRows.waitFor({ state: "hidden" });
    assert.deepEqual(await opened(), [false], "the reader folds the working run");
    turns = sorting({ ...said("Sorting shelf a."), phase: "commentary" });
    await page.evaluate(() => window.chatFallbackQA.refresh());
    // drawn once the words left the turn for its run of work
    await page.waitForFunction(() => [...[...document.querySelectorAll(".chat-turn-agent")].at(-1)!.children].every((child) => child.classList.contains("work-block")));
    assert.deepEqual(await opened(), [false], "words that join the run keep it folded");
    assert.equal(await page.getByText("Sorting shelf a.", { exact: true }).isVisible(), false, "and fold with it");
    if (process.env.UI_EVIDENCE_DIR) await page.screenshot({ path: join(process.env.UI_EVIDENCE_DIR, "run-words-join-fold.png") });
    await page.evaluate(() => window.chatFallbackQA.status(undefined));
    await live.waitFor({ state: "detached" });
    console.log("PASS words and runs of work keep the agent's order, settled and live");
  }
  for (const viewport of [{ width: 390, height: 844 }, { width: 390, height: 420 }, { width: 1440, height: 900 }]) {
    await page.setViewportSize(viewport);
    prompt = parseInteractivePrompt("claude", readFileSync(join(repo, "server/fixtures/claude-question-words-2.1.311-40.txt"), "utf8"))!;
    assert.ok(prompt.screen_words, "the recorded question includes Claude's preceding words");
    await page.evaluate(() => { window.chatFallbackQA.agent("claude"); window.chatFallbackQA.refresh(); });
    const card = page.locator(".prompt-card");
    await card.locator(".prompt-card-words").waitFor({ state: "attached" });
    // the context, its caption and the question in the card's order, each box whole, and the
    // context at eight lines at rest (its content, when shorter) and two when the card is short
    const layout = await card.evaluate(node => {
      const text = node.querySelector(".prompt-card-words-text")!;
      const caption = node.querySelector(".prompt-card-words .prompt-card-hint")!.getBoundingClientRect();
      const question = node.querySelector(".prompt-card-question")!.getBoundingClientRect();
      const bounds = text.getBoundingClientRect();
      return { textBottom: bounds.bottom, textHeight: bounds.height, textScroll: text.scrollHeight, lineHeight: parseFloat(getComputedStyle(text).lineHeight), captionTop: caption.top, captionBottom: caption.bottom, questionTop: question.top, questionBottom: question.bottom, cardBottom: node.getBoundingClientRect().bottom };
    });
    assert.ok(layout.textBottom <= layout.captionTop, "terminal context and its caption do not overlap");
    assert.ok(layout.captionBottom <= layout.questionTop, "the caption stays above the question");
    if (viewport.height < 600) {
      assert.ok(layout.textHeight <= 2 * layout.lineHeight + 1, `a short card's context gives way down to two lines (${layout.textHeight}px of ${layout.lineHeight}px lines)`);
      assert.ok(layout.textScroll > layout.textHeight + 1, "and scrolls the rest in itself");
      assert.ok(layout.questionBottom <= layout.cardBottom, "so the question is in view without scrolling the card");
    } else {
      assert.ok(layout.textHeight >= Math.min(layout.textScroll, 8 * layout.lineHeight) - 1, `at rest the context shows its lines, up to eight (${layout.textHeight}px of ${layout.textScroll}px)`);
    }
    if (process.env.UI_EVIDENCE_DIR) await page.screenshot({ path: join(process.env.UI_EVIDENCE_DIR, `claude-question-context-${viewport.width}-${viewport.height}.png`) });
    await card.locator("input.input").scrollIntoViewIfNeeded();
    const answerInView = await card.evaluate(node => {
      const bounds = node.getBoundingClientRect();
      const input = node.querySelector("input.input")!.getBoundingClientRect();
      return input.top >= bounds.top && input.bottom <= bounds.bottom;
    });
    assert.equal(answerInView, true, "the custom answer remains reachable by scrolling the card");
    prompt = null;
    await page.evaluate(() => window.chatFallbackQA.refresh());
    await card.waitFor({ state: "detached" });
  }
  console.log("PASS Claude's recorded terminal context, caption and question do not overlap at desktop, mobile and short mobile sizes");
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 });
    prompt = parseInteractivePrompt("pi", piNavigation["custom-empty"])!;
    const originalId = prompt.id;
    await page.evaluate(() => { window.chatFallbackQA.agent("pi"); window.chatFallbackQA.refresh(); });
    const card = page.locator(".prompt-card");
    await card.waitFor();
    const back = card.getByRole("button", { name: "Back", exact: true });
    const question = card.getByRole("button", { name: "单元格内容", exact: true });
    assert.equal(await back.count(), 0, "native custom editor owns navigation");
    assert.equal(await question.count(), 0);
    const input = card.locator("input.input");
    await input.fill("unsent browser draft");
    const mountedCard = await card.elementHandle();
    prompt = parseInteractivePrompt("pi", piNavigation["second-answered"])!;
    assert.equal(prompt.id, originalId, "leaving the editor does not change question identity");
    await page.evaluate(() => window.chatFallbackQA.refresh());
    await back.waitFor();
    await question.waitFor();
    assert.equal(await input.inputValue(), "unsent browser draft", "metadata refresh preserves web edits");
    assert.equal(await mountedCard!.evaluate(node => node.isConnected), true, "the card stays mounted");
    await input.fill("");
    assert.equal(await back.isEnabled(), true);
    assert.equal(await question.isEnabled(), true);
    if (process.env.UI_EVIDENCE_DIR) await page.screenshot({ path: join(process.env.UI_EVIDENCE_DIR, `pi-navigation-${width}.png`) });
    // Start the next width with a new occurrence so its initial navigation state is observed.
    prompt = null;
    await page.evaluate(() => window.chatFallbackQA.refresh());
    await card.waitFor({ state: "detached" });
  }
  console.log("PASS same-id Pi navigation refresh restores Back/question buttons without losing web drafts at desktop and mobile widths");
  assert.deepEqual(errors, []);
  structured = false;
  const polling = await browser.newPage();
  let pollingReads = 0;
  polling.on("request", (request) => {
    if (new URL(request.url()).pathname === "/api/pane/conversation") pollingReads += 1;
  });
  await polling.clock.install();
  await polling.clock.pauseAt(new Date());
  await polling.addInitScript(() => {
    localStorage.setItem("ovis:settings", JSON.stringify({ language: "en" }));
  });
  await polling.goto(`http://127.0.0.1:${server.port}/?pushes`);
  await polling.locator(".chat-terminal-fallback summary").waitFor();
  const codexReads = pollingReads;
  await polling.clock.runFor(2000);
  assert.equal(pollingReads, codexReads, "non-Copilot terminal fallback keeps its 10s backstop");
  const codexBackstop = polling.waitForResponse((response) => new URL(response.url()).pathname === "/api/pane/conversation");
  await polling.clock.runFor(8000);
  await codexBackstop;
  assert.equal(pollingReads, codexReads + 1);
  const changedAgent = polling.waitForResponse((response) => new URL(response.url()).pathname === "/api/pane/conversation");
  await polling.evaluate(() => window.chatFallbackQA.agent("copilot"));
  await changedAgent;
  const copilotReads = pollingReads;
  const copilotPoll = polling.waitForResponse((response) => new URL(response.url()).pathname === "/api/pane/conversation");
  await polling.clock.runFor(2000);
  await copilotPoll;
  assert.equal(pollingReads, copilotReads + 1, "only Copilot terminal fallback uses the 2s recovery poll");
  await polling.close();
  console.log("PASS fallback polling keeps 10s for other agents and 2s for Copilot under a controlled clock");
  {
    // A Codex that reported no session: the scrollback stands in with the model its live footer
    // states, and a conversation not begun with the model its screen states. No file changes when
    // that model does, so the terminal's output re-reads them. Pushes are on and the clock is
    // paused, so neither the 2s poll nor the 10s backstop reads in its place.
    const screen = await browser.newPage();
    let screenReads = 0;
    screen.on("request", (request) => {
      const url = new URL(request.url());
      if (url.pathname === "/api/pane/conversation" && url.searchParams.get("pane_id") === "screen") screenReads += 1;
    });
    await screen.clock.install();
    await screen.clock.pauseAt(new Date());
    await screen.addInitScript(() => localStorage.setItem("ovis:settings", JSON.stringify({ language: "en" })));
    await screen.goto(`http://127.0.0.1:${server.port}/?pushes`);
    await screen.locator(".chat-terminal-fallback summary").waitFor();
    const within = async (what: string, until: Promise<void>): Promise<void> => {
      let deadline: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([until, new Promise<never>((_, reject) => { deadline = setTimeout(() => reject(new Error(what)), 10_000); })]);
      } finally { clearTimeout(deadline); }
    };
    const forwarded = (model: string, effort: string) => within(`the chat never forwarded ${model} ${effort}`, screen.evaluate(([model, effort]) =>
      window.chatFallbackQA.until(() => window.chatFallbackQA.metadata("screen")?.model === model && window.chatFallbackQA.metadata("screen")?.reasoning_effort === effort), [model, effort]));
    const listening = (expected: boolean, what: string) => within(what, screen.evaluate((expected) =>
      window.chatFallbackQA.until(() => window.chatFallbackQA.listening() === expected), expected));
    const sol = { model: "gpt-6.1-sol", reasoning_effort: "low" }, luna = { model: "gpt-6-luna", reasoning_effort: "medium" };
    for (const source of ["scrollback", "codex-transcript"]) {
      screenAnswer = { source, metadata: sol, screen: true };
      if (source === "scrollback") await screen.evaluate(() => window.chatFallbackQA.pane("screen"));
      else await screen.evaluate(() => window.chatFallbackQA.refresh());
      await forwarded("gpt-6.1-sol", "low");
      await listening(true, `a ${source} answer read off the screen never listened to the terminal`);
      // a model switched in the terminal: its output, once the 1s bound since the last read has passed, reads it
      screenAnswer = { source, metadata: luna, screen: true };
      await screen.clock.runFor(1000);
      const reads = screenReads;
      await screen.evaluate(() => window.chatFallbackQA.output());
      await forwarded("gpt-6-luna", "medium");
      assert.equal(screenReads, reads + 1, `terminal output re-reads a ${source} answer read off the screen once`);
    }
    // a conversation whose settings come from its transcript has a file to watch: output reads nothing
    screenAnswer = { source: "codex-transcript", metadata: sol };
    await screen.evaluate(() => window.chatFallbackQA.refresh());
    await forwarded("gpt-6.1-sol", "low");
    await listening(false, "a transcript's answer kept listening to the terminal");
    await screen.close();
    screenAnswer = {};
  }
  console.log("PASS a scrollback or not-begun answer forwards the model its screen states, and terminal output re-reads it");
  console.log("chat fallback: browser OK (no hidden terminal reads, opened stalled output cannot block structured refresh, late cleanup, non-agent inline output, fallback error announcement and accurate empty state)");

} finally {
  await browser?.close(); server?.stop(true); rmSync(root, { recursive: true, force: true });
}
