/** Synthetic Devin SQLite -> real parser -> conversation HTTP -> real ChatView (not live pane discovery). */
import assert from "node:assert/strict";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { devinConversation, forgetDevinState } from "../server/devin.ts";

const root = mkdtempSync(join(tmpdir(), "ovis-devin-chat-browser-"));
const dbPath = join(root, "sessions.db");
const cwd = "/synthetic/devin-work";
const session = "synthetic-devin";
const question = "What did the fictional inspection find?";
const answer = "The fictional inspection found a green result.";
const output = "Synthetic inspection output: green";

try {
  const db = new Database(dbPath);
  try {
    // Minimal native schema and records, following server/devin.test.ts; never open a real Devin database.
    db.exec("PRAGMA journal_mode=WAL; CREATE TABLE sessions(id TEXT, working_directory TEXT, main_chain_id INTEGER, hidden INTEGER, model TEXT); CREATE TABLE message_nodes(session_id TEXT, node_id INTEGER, parent_node_id INTEGER, chat_message TEXT, created_at INTEGER); CREATE TABLE tool_call_state(session_id TEXT, tool_call_id TEXT, tool_call_json TEXT, tool_call_update_json TEXT)");
    db.query("INSERT INTO sessions VALUES (?, ?, ?, 0, NULL)").run(session, cwd, 4);
    const insert = db.query("INSERT INTO message_nodes VALUES (?, ?, ?, ?, ?)");
    const node = (id: number, parent: number | null, message: unknown) => insert.run(session, id, parent, JSON.stringify(message), 1_700_000_000 + id);
    node(1, null, { role: "user", content: question });
    node(2, 1, { role: "assistant", tool_calls: [{ id: "call-1", name: "synthetic_tool", arguments: { command: "inspect fictional data" } }] });
    node(3, 2, { role: "tool", tool_call_id: "call-1", content: output });
    node(4, 3, { role: "assistant", content: answer });
  } finally { db.close(); }

  const conversation = devinConversation(session, cwd, {}, dbPath);
  assert.equal(conversation.source, "devin-transcript");
  assert.deepEqual(conversation.turns.map((turn) => turn.role), ["user", "assistant"]);
  const build = await Bun.build({ entrypoints: ["scripts/chat-virtual-fixture.tsx"], outdir: root, target: "browser", define: { "process.env.NODE_ENV": '"development"' } });
  assert.ok(build.success, String(build.logs));
  let conversationRequests = 0;
  const terminalReads: string[] = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname;
    if (path.endsWith("/pane/read")) {
      terminalReads.push(request.url);
      return Response.json({ error: "Unexpected terminal fallback" }, { status: 500 });
    }
    if (path.endsWith("/pane/conversation")) {
      conversationRequests++;
      return Response.json(conversation);
    }
    if (path.endsWith("/pane/commands")) return Response.json({ commands: [] });
    if (path === "/favicon.ico") return new Response(null, { status: 204 });
    if (path === "/") return new Response('<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/chat-virtual-fixture.css"></head><body><div id="root"></div><script type="module" src="/chat-virtual-fixture.js"></script></body></html>', { headers: { "content-type": "text/html" } });
    if (path === "/chat-virtual-fixture.js" || path === "/chat-virtual-fixture.css") return new Response(Bun.file(join(root, path.slice(1))));
    if (/^\/[\w.-]+\.(?:woff2?|ttf)$/.test(path)) return new Response(Bun.file(join(root, path.slice(1))));
    return new Response("Not found", { status: 404 });
  } });
  try {
    const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH, headless: true });
    try {
      for (const width of [1440, 393]) {
        const beforeRequests = conversationRequests;
        const context = await browser.newContext({ viewport: { width, height: 900 }, locale: "en-US", hasTouch: width === 393, isMobile: width === 393 });
        try {
          const page = await context.newPage();
          page.setDefaultTimeout(10_000);
          await page.goto(`http://127.0.0.1:${server.port}/`);
          await page.locator('.chat-transcript[data-conversation-source="devin-transcript"]').waitFor();
          const user = page.locator(".chat-turn-user");
          const assistant = page.locator(".chat-turn-agent");
          await user.getByText(question, { exact: true }).waitFor({ state: "visible" });
          await assistant.getByText(answer, { exact: true }).waitFor({ state: "visible" });
          assert.equal(await user.count(), 1, "one user message");
          assert.equal(await assistant.count(), 1, "one assistant message");
          const block = assistant.locator(".work-block-head");
          await block.waitFor({ state: "visible" });
          if (await block.getAttribute("aria-expanded") === "false") await block.click();
          const tool = assistant.locator(".work-row-head");
          await tool.waitFor({ state: "visible" });
          assert.match(await tool.innerText(), /synthetic_tool/, "the tool is rendered as a work row");
          if (await tool.getAttribute("aria-expanded") === "false") await tool.click();
          await assistant.getByText(output, { exact: true }).waitFor({ state: "visible" });
          assert.equal(await user.getByRole("button", { name: "Copy message", exact: true }).count(), 1, "one user copy control");
          assert.equal(await assistant.getByRole("button", { name: "Copy as markdown", exact: true }).count(), 1, "one Markdown copy control");
          assert.equal(await assistant.getByRole("button", { name: "Copy as plain text", exact: true }).count(), 1, "one plain-text copy control");
          assert.equal(await page.locator(".chat-fallback, .chat-terminal-fallback, [data-pane-content-error]").count(), 0, "no terminal fallback or render error");
          assert.ok(conversationRequests > beforeRequests, "the fixture fetched the parser response");
          assert.deepEqual(terminalReads, [], "no pane/read terminal fallback requests");
          if (width === 393) {
            assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), "mobile page has no horizontal overflow");
            assert.ok(await page.locator(".chat-view").evaluate((node) => node.scrollWidth <= node.clientWidth), "mobile chat has no horizontal overflow");
          }
          console.log(`PASS ${width}: synthetic Devin parser response renders user, assistant and tool without terminal fallback`);
        } finally { await context.close(); }
      }
    } finally { await browser.close(); }
  } finally { await server.stop(true); }
} finally {
  forgetDevinState(session, cwd, dbPath);
  rmSync(root, { recursive: true, force: true });
}
