import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Page } from "playwright-core";
import type { ConversationSearchResponse } from "../shared/conversation-search.ts";
import { searchPattern, searchTurns } from "../shared/conversation-search.ts";
import type { ConversationTurn } from "../shared/protocol.ts";
import { chromePath } from "./chrome-path.ts";
import type {} from "./conversation-search-fixture.tsx";

const root = mkdtempSync(join(tmpdir(), "ovis-conversation-search-"));
const evidence = process.env.UI_EVIDENCE_DIR;
if (evidence) mkdirSync(evidence, { recursive: true });

const PROMPTS = 200;
const turnAt = (index: number): ConversationTurn => {
  const prompt = Math.floor(index / 2);
  const ts = new Date(Date.parse("2026-10-12T00:00:00Z") + index * 60_000).toISOString();
  if (index % 2 === 0) return { role: "user", ts, parts: [{ kind: "text", text: prompt === 20 ? "Where did the zebra crossing test go?" : `Question ${prompt}: ${"what about this ".repeat(prompt % 7 + 2)}` }] };
  return { role: "assistant", ts, parts: [
    { kind: "tool", name: "Bash", summary: "grep -rn crossing", input: "{}", output: prompt === 120 ? "a zebra in a tool's output" : "ok" },
    { kind: "text", text: prompt === 180 ? "The zebra test moved to crossing.test.ts, beside the other crossing tests." : `Answer ${prompt}. ${"Variable height paragraph. ".repeat(prompt % 5 + 1)}` },
  ] };
};
// each text part read from a store row of its own (as Hermes's are), so a match names the row its words are in
const TURNS = Array.from({ length: PROMPTS * 2 }, (_, index): ConversationTurn => ({ ...turnAt(index), text_rows: [index + 1] }));
const [call, said] = TURNS.at(-1)!.parts as [ConversationTurn["parts"][number], { kind: "text"; text: string }];
const RETRIED: ConversationTurn = { ...TURNS.at(-1)!, parts: [call, { kind: "text", text: `${said.text} Retried.` }], text_rows: [TURNS.length + 1] };
let retried = false;
// a newest page that holds only an agent's tool calls since (Hermes reads its text rows alone):
// no row it shows tells whether a match is newer or older than it
const RUN: ConversationTurn = { role: "assistant", ts: "2026-10-12T06:40:00.000Z", text_rows: [], parts: Array.from({ length: 3 }, (_, step) =>
  ({ kind: "tool" as const, name: "Bash", summary: `cargo build step ${step}`, input: "{}", output: "ok" })) };
let toolRun: "after" | "alone" | null = null;
let newestFails = false;
const reads: { before: string | null; prompts: string | null }[] = [];

let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
const build = await Bun.build({ entrypoints: ["scripts/conversation-search-fixture.tsx"], outdir: root, target: "browser", define: { "process.env.NODE_ENV": '"development"' } });
assert.ok(build.success, String(build.logs));
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
  const url = new URL(request.url);
  if (url.pathname.endsWith("/pane/commands")) return Response.json({ commands: [] });
  if (url.pathname.endsWith("/pane/prompt")) return Response.json({ prompt: null, outcomes: [] });
  if (url.pathname.endsWith("/pane/conversation/search")) {
    const pattern = searchPattern(url.searchParams.get("q") ?? "");
    if (pattern === null) return Response.json({ error: { code: "invalid_query", message: "q" } }, { status: 400 });
    assert.equal(url.searchParams.get("history_id"), "h1");
    if (url.searchParams.get("q") === "retried") return Response.json({ history_id: "h1", cursor: null, matches: searchTurns([RETRIED], pattern) } satisfies ConversationSearchResponse);
    if (url.searchParams.get("q") === "ghost") return Response.json({ history_id: "h1", cursor: null, matches: [{ turn: "user|2020-01-01T00:00:00.000Z|text|ghost", role: "user", ts: "2020-01-01T00:00:00.000Z", before: "a ", match: "ghost", after: " message" }] } satisfies ConversationSearchResponse);
    const before = url.searchParams.get("before");
    const [from, to] = before === null ? [PROMPTS, PROMPTS * 2] : [0, Number(before.slice(2))];
    return Response.json({ history_id: "h1", cursor: from === 0 ? null : `t:${from}`, matches: searchTurns(TURNS.slice(from, to), pattern) } satisfies ConversationSearchResponse);
  }
  if (url.pathname.endsWith("/pane/conversation")) {
    const before = url.searchParams.get("before");
    reads.push({ before, prompts: url.searchParams.get("prompts") });
    const size = 2 * Number(url.searchParams.get("prompts") ?? 50);
    const end = before === null ? TURNS.length : Number(before.slice(2));
    const start = Math.max(0, end - size);
    if (before === null && newestFails) return Response.json({ error: { code: "unavailable", message: "store" } }, { status: 503 });
    const newest = before === null && retried ? [RETRIED] : [];
    if (before === null && toolRun !== null) return Response.json({ source: "claude-transcript", history_id: "h1", cursor: toolRun === "after" ? `t:${TURNS.length}` : null, turns: [RUN, ...newest], metadata: { model: null, reasoning_effort: null } });
    return Response.json({ source: "claude-transcript", history_id: "h1", cursor: start === 0 ? null : `t:${start}`, turns: [...TURNS.slice(start, end), ...newest], metadata: { model: null, reasoning_effort: null } });
  }
  if (url.pathname === "/") return new Response('<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Conversation search QA</title><link rel="stylesheet" href="/conversation-search-fixture.css"></head><body><div id="root"></div><script type="module" src="/conversation-search-fixture.js"></script></body></html>', { headers: { "content-type": "text/html" } });
  const file = Bun.file(join(root, url.pathname.slice(1)));
  return file.size > 0 ? new Response(file) : new Response("not found", { status: 404 });
} });

const dialog = (page: Page) => page.getByRole("dialog", { name: "Search conversation" });
const atTop = (page: Page, text: string) => page.waitForFunction((text) => {
  const view = document.querySelector(".chat-view");
  const row = [...document.querySelectorAll<HTMLElement>("[data-chat-row]")].find((node) => node.textContent?.includes(text));
  if (!view || !row) return false;
  const gap = Math.abs(row.getBoundingClientRect().top - view.getBoundingClientRect().top);
  const held = (window as unknown as { heldAtTop?: number }).heldAtTop ?? 0;
  (window as unknown as { heldAtTop?: number }).heldAtTop = gap <= 2 ? held + 1 : 0;
  return gap <= 2 && held >= 5;
}, text, { polling: "raf", timeout: 15_000 });
const search = async (page: Page, query: string): Promise<void> => {
  await page.evaluate(() => { (window as unknown as { heldAtTop?: number }).heldAtTop = 0; });
  await dialog(page).getByRole("searchbox").fill(query);
};

try {
  browser = await chromium.launch({ executablePath: chromePath(), headless: true, args: ["--no-sandbox"] });
  for (const [width, height] of [[1280, 800], [390, 844]] as const) {
    reads.length = 0;
    retried = false;
    const context = await browser.newContext({ viewport: { width, height }, locale: "en-US", hasTouch: width < 640, isMobile: width < 640 });
    await context.addInitScript(() => localStorage.setItem("ovis:settings", JSON.stringify({ language: "en", theme: "dark" })));
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.setDefaultTimeout(15_000);
    await page.goto(`http://127.0.0.1:${server.port}/`);
    await page.getByText("Answer 199.", { exact: false }).first().waitFor();

    await page.evaluate(() => window.searchQa.open());
    await dialog(page).waitFor();
    const live = dialog(page).locator(".conversation-search-status[role=status]");
    assert.equal(await live.count(), 1, "the search's live region is mounted before any search");
    assert.ok(((await dialog(page).locator(".conversation-search-footer").boundingBox())?.height ?? 0) < 1, "an empty footer takes no room");
    await live.evaluate((node) => { (node as HTMLElement).dataset.qaFirst = "1"; });
    await search(page, "z");
    await dialog(page).locator(".palette-empty").getByText("Type at least 2 characters.").waitFor();
    await search(page, "ZEBRA");
    await dialog(page).getByText("Searched the whole conversation.").waitFor();
    assert.equal(await live.getAttribute("data-qa-first"), "1", "the status that tells the search's end is the live region mounted at the start");
    assert.equal(await live.textContent(), "Searched the whole conversation.");
    await search(page, "z");
    await dialog(page).locator(".palette-empty").getByText("Type at least 2 characters.").waitFor();
    assert.equal(await live.getAttribute("data-qa-first"), "1");
    assert.equal(await live.textContent(), "Type at least 2 characters.", "the guidance goes to the live region mounted at the start");
    assert.equal(await dialog(page).locator("[role=status]").count(), 1, "the dialog has one live region");
    assert.ok(((await dialog(page).locator(".conversation-search-footer").boundingBox())?.height ?? 0) < 1, "the footer still takes no room");
    await search(page, "ZEBRA");
    await dialog(page).getByText("Searched the whole conversation.").waitFor();
    const options = dialog(page).getByRole("option");
    assert.deepEqual(await options.locator(".conversation-search-snippet").allTextContents(), [
      "The zebra test moved to crossing.test.ts, beside the other crossing tests.",
      "Where did the zebra crossing test go?",
    ]);
    assert.deepEqual(await options.locator("mark").allTextContents(), ["zebra", "zebra"]);
    if (evidence) await page.screenshot({ path: join(evidence, `conversation-search-${width}.png`) });
    console.log(`PASS ${width}: two matches listed newest first, the tool's output left out`);

    await options.nth(1).click();
    await dialog(page).waitFor({ state: "detached" });
    await atTop(page, "Where did the zebra crossing test go?");
    const older = reads.filter((read) => read.before !== null);
    assert.deepEqual(older.map((read) => read.prompts), ["50", "50", "50", "50"], JSON.stringify(reads));
    if (evidence) await page.screenshot({ path: join(evidence, `conversation-search-${width}-picked.png`) });
    console.log(`PASS ${width}: a pick on an earlier page loads the pages to it and opens the chat there`);

    const readsBefore = reads.length;
    await page.evaluate(() => window.searchQa.open());
    await search(page, "zebra");
    await dialog(page).getByText("Searched the whole conversation.").waitFor();
    await dialog(page).getByRole("searchbox").press("Enter");
    await dialog(page).waitFor({ state: "detached" });
    await atTop(page, "The zebra test moved to crossing.test.ts");
    assert.equal(reads.filter((read, index) => index >= readsBefore && read.before !== null).length, 0);
    console.log(`PASS ${width}: Enter opens the newest match, already loaded, without a read`);

    await page.evaluate(() => window.searchQa.open());
    await search(page, "nothing like it");
    await dialog(page).locator(".palette-empty").getByText("No message or answer holds this.").waitFor();
    await search(page, "ghost");
    await dialog(page).getByRole("option").click();
    await dialog(page).getByText("This message is no longer in the conversation.").waitFor();
    await page.keyboard.press("Escape");
    await dialog(page).waitFor({ state: "detached" });
    console.log(`PASS ${width}: no match, a match no longer there, and Escape`);

    const firstRead = reads.length;
    await page.evaluate(() => window.searchQa.open());
    await search(page, "retried");
    await dialog(page).getByRole("option").click();
    await dialog(page).getByText("This message is no longer in the conversation.").waitFor();
    assert.ok(reads.slice(firstRead).some((read) => read.before === null), JSON.stringify(reads.slice(firstRead)));
    newestFails = true;
    await dialog(page).getByRole("option").click();
    await dialog(page).getByText("Couldn't load the earlier messages.").waitFor();
    newestFails = false;
    await page.keyboard.press("Escape");
    await dialog(page).waitFor({ state: "detached" });
    retried = true;
    await page.evaluate(() => window.searchQa.open());
    await search(page, "retried");
    await dialog(page).getByRole("option").click();
    await dialog(page).waitFor({ state: "detached" });
    await page.waitForFunction(() => {
      const view = document.querySelector(".chat-view")?.getBoundingClientRect();
      const row = [...document.querySelectorAll<HTMLElement>("[data-chat-row]")].find((node) => node.textContent?.includes("Retried."))?.getBoundingClientRect();
      return view !== undefined && row !== undefined && row.top >= view.top - 1 && row.top < view.bottom;
    });
    console.log(`PASS ${width}: a match the chat has not read opens once read, and none in its place`);
    assert.deepEqual(errors, []);
    await context.close();

    for (const run of ["after", "alone"] as const) {
      toolRun = run;
      retried = false;
      reads.length = 0;
      const runContext = await browser.newContext({ viewport: { width, height }, locale: "en-US", hasTouch: width < 640, isMobile: width < 640 });
      await runContext.addInitScript(() => localStorage.setItem("ovis:settings", JSON.stringify({ language: "en", theme: "dark" })));
      const runPage = await runContext.newPage();
      const runErrors: string[] = [];
      runPage.on("pageerror", (error) => runErrors.push(error.message));
      runPage.setDefaultTimeout(15_000);
      await runPage.goto(`http://127.0.0.1:${server.port}/`);
      await runPage.getByText("3 commands").first().waitFor();
      retried = true;
      const shownRead = reads.length;
      await runPage.evaluate(() => window.searchQa.open());
      await search(runPage, "retried");
      await dialog(runPage).getByRole("option").click();
      await dialog(runPage).waitFor({ state: "detached" });
      await runPage.getByText("Retried.", { exact: false }).first().waitFor();
      assert.ok(reads.slice(shownRead).some((read) => read.before === null), JSON.stringify(reads.slice(shownRead)));
      console.log(`PASS ${width}: a match after a newest page of tool calls alone (${run}) opens once read`);
      assert.deepEqual(runErrors, []);
      await runContext.close();
    }
    toolRun = null;
  }
} finally {
  await browser?.close();
  server.stop(true);
  rmSync(root, { recursive: true, force: true });
}
