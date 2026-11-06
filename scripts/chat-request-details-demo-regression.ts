import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser } from "playwright-core";
import panes from "../site/demo/fixtures/panes.json";
import { searchPattern, searchTurns } from "../shared/conversation-search.ts";
import type { ConversationTurn } from "../shared/protocol.ts";
import { appFaces } from "./app-faces.ts";
import { buildDemoApp } from "./demo-build.ts";
import { chromePath } from "./chrome-path.ts";

// Compaction and failed requests (#901), always on, on the unmodified app over the demo's fixture
// transport, at a phone's and a desktop's width, light and dark, also on a device that stored the
// old switch off (its choice is ignored). The turn's three failed requests are one folded row that says another request
// followed, opens to their three errors and fits the transcript's width, the answer after them
// stays outside it, a search's pick of words in one of the errors opens the row again (#3082),
// and the compaction card names the token counts its record stated. The omp
// pane's conversation answers TURNS; all files and HTTP traffic stay in this disposable,
// loopback-only app and no herdr session is opened. Screenshots go to UI_EVIDENCE_DIR when set.
const app = mkdtempSync(join(tmpdir(), "herdr-chat-request-details-demo-"));
const evidence = process.env["UI_EVIDENCE_DIR"] || null;
if (evidence !== null) mkdirSync(evidence, { recursive: true });

const PANE = panes.omp;
const ERRORS = [
  "503 {\"type\":\"error\",\"error\":{\"type\":\"overloaded_error\",\"message\":\"Overloaded\"}}",
  "Connection error.",
  "Anthropic stream ended before message_stop",
];
const TURNS = [
  { role: "user", ts: "2026-11-06T01:00:00.000Z", parts: [{ kind: "text", text: "Find why the checkout test is flaky" }] },
  { role: "user", ts: "2026-11-06T01:20:00.000Z", parts: [{ kind: "compact", text: "## Goal\nFind why the checkout test is flaky.", tokens_before: 761969, tokens_saved: 493241 }] },
  { role: "user", ts: "2026-11-06T01:21:00.000Z", parts: [{ kind: "text", text: "Go on" }] },
  { role: "assistant", ts: "2026-11-06T01:21:01.000Z", end_ts: "2026-11-06T01:21:40.000Z", parts: [
    ...ERRORS.map((error) => ({ kind: "text", text: `Error: ${error}`, failed: true })),
    { kind: "text", text: "The test waits on a fixed sleep; the fix awaits the payment event instead.", phase: "final_answer" },
  ] },
] satisfies ConversationTurn[];
// what the PC's search answers for words of the second error
const QUERY = "connection error";
const SEARCH = { history_id: "request-details", cursor: null, matches: searchTurns(TURNS, searchPattern(QUERY)!) };

async function prepareDemo(): Promise<void> {
  await buildDemoApp(app);
  const index = join(app, "index.html");
  const html = readFileSync(index, "utf8");
  assert.match(html, /<script type="module"/);
  // over the demo's own fetch: only this pane's conversation read is answered here
  const override = `<script>(() => {
    const demo = window.fetch;
    const turns = ${JSON.stringify(TURNS)};
    window.fetch = (input, init) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, location.href);
      if (url.pathname === "/api/pane/conversation/search" && url.searchParams.get("pane_id") === ${JSON.stringify(PANE)}) {
        return Promise.resolve(new Response(${JSON.stringify(JSON.stringify(SEARCH))}, { headers: { "content-type": "application/json" } }));
      }
      if (url.pathname === "/api/pane/conversation" && url.searchParams.get("pane_id") === ${JSON.stringify(PANE)}) {
        const body = { source: "omp-transcript", history_id: "request-details", cursor: null, turns: url.searchParams.has("before") ? [] : turns };
        return Promise.resolve(new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } }));
      }
      return demo(input, init);
    };
  })();</script>`;
  writeFileSync(index, html.replace(/<script type="module"/, () => `<script src="./demo-transport.js"></script>\n    ${override}\n    <script type="module"`));
}

async function check(browser: Browser, origin: string, width: number, theme: "light" | "dark", storedOff: boolean): Promise<void> {
  const phone = width <= 480;
  const context = await browser.newContext(phone
    ? { viewport: { width, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true, locale: "en-US", colorScheme: theme }
    : { viewport: { width, height: 900 }, locale: "en-US", colorScheme: theme });
  const name = `${width}px ${theme}${storedOff ? " with the old switch stored off" : ""}`;
  try {
    // the demo's other agents finish turns now and then: their in-app alerts stay off over the transcript
    await context.addInitScript(([settings, pane, stored]) => {
      localStorage.setItem("ovis:settings", settings!);
      localStorage.setItem(`ovis:view:${pane}`, "chat");
      if (stored === "true") localStorage.setItem("ovis:chat-request-details", "false");
    }, [JSON.stringify({ language: "en", alertsOn: false, theme }), PANE, String(storedOff)]);
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`${origin}/herdr-web-ui/demo/app/?pane=${encodeURIComponent(PANE)}`);
    await page.locator(".conn-live").waitFor({ state: "attached" });
    const scope = page.locator(`[data-layout-pane=${JSON.stringify(PANE)}].is-current`);
    await scope.locator(".terminal-stack.is-chat").waitFor();
    await scope.getByText("the fix awaits the payment event", { exact: false }).waitFor();
    await appFaces(page);

    const compact = (await scope.locator(".chat-compact > summary").first().innerText()).replace(/\s+/g, " ");
    const rows = scope.locator(".chat-failed-requests");
    {
      assert.equal(await rows.count(), 1, `${name}: the three failed requests are one row`);
      const row = rows.first();
      assert.equal((await row.locator(".chat-skill-name").innerText()).trim(), "3 requests failed, then tried again", `${name}: the row says how many failed and that another request followed`);
      assert.equal(await row.evaluate((element) => (element as HTMLDetailsElement).open), false, `${name}: the row starts folded`);
      assert.equal(await scope.getByText("Error: Connection error.", { exact: true }).count(), 0, `${name}: no error line outside the row`);
      await row.locator("summary").click();
      assert.deepEqual(await row.locator("li").allInnerTexts(), ERRORS, `${name}: opened, the row lists each error in order`);
      const fits = await row.evaluate((element) => {
        const turn = element.closest(".chat-turn")!.getBoundingClientRect();
        const box = element.getBoundingClientRect();
        return box.left >= turn.left - 0.5 && box.right <= turn.right + 0.5 && element.scrollWidth <= element.clientWidth + 1;
      });
      assert.ok(fits, `${name}: the opened row fits the turn's width`);

      // folded again, a search's pick of words in an error opens the row it is in
      await row.locator("summary").click();
      await page.waitForFunction((element) => !(element as HTMLDetailsElement).open, await row.elementHandle());
      // a phone's header lists the tabs, so its More carries the pane's actions
      if (phone) await page.locator(".header-more-button").click();
      else await scope.locator(".chat-view").click({ button: "right", position: { x: 300, y: 200 } });
      await page.getByText("Search conversation", { exact: true }).click();
      const search = page.getByRole("dialog", { name: "Search conversation" });
      await search.getByRole("searchbox").fill(QUERY);
      await search.getByText("Searched the whole conversation.").waitFor();
      assert.equal(await search.getByRole("option").count(), 1, `${name}: the one turn whose error holds the words is found`);
      await search.getByRole("option").first().click();
      await search.waitFor({ state: "detached", timeout: 5_000 });
      await page.waitForFunction((element) => (element as HTMLDetailsElement).open, await row.elementHandle(), { timeout: 5_000 });
      assert.ok(await row.getByText("Connection error.", { exact: true }).isVisible(), `${name}: the pick opens the folded row to the error it found`);
      if (evidence !== null) {
        // the sheet that closed is painted away first
        await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
        await page.screenshot({ path: join(evidence, `chat-request-details-search-${width}-${theme}.png`) });
      }
      assert.match(compact, /Conversation compacted · 762k tokens before · 493k tokens saved/, `${name}: the compaction card names its recorded counts`);
    }
    assert.ok(await scope.getByText("the fix awaits the payment event", { exact: false }).isVisible(), `${name}: the answer stays drawn`);
    assert.deepEqual(errors, []);
    if (evidence !== null) {
      await scope.locator(".chat-compact").first().scrollIntoViewIfNeeded();
      await page.screenshot({ path: join(evidence, `chat-request-details-${storedOff ? "stored-off" : "on"}-${width}-${theme}.png`) });
    }
    console.log(`PASS ${name}`);
  } finally { await context.close(); }
}

try {
  await prepareDemo();
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const path = new URL(request.url).pathname;
    if (!path.startsWith("/herdr-web-ui/demo/app/")) return new Response("not found", { status: 404 });
    let file: string;
    try { file = decodeURIComponent(path.slice("/herdr-web-ui/demo/app/".length)); }
    catch { return new Response("bad path", { status: 400 }); }
    if (!file || file.endsWith("/")) file += "index.html";
    if (file.split("/").includes("..") || file.includes("\\")) return new Response("bad path", { status: 400 });
    const body = Bun.file(join(app, file));
    return (await body.exists()) ? new Response(body) : new Response("not found", { status: 404 });
  } });
  try {
    const browser = await chromium.launch({ executablePath: chromePath(), headless: true, args: ["--no-sandbox"] });
    try {
      for (const width of [390, 1280]) {
        for (const theme of ["light", "dark"] as const) {
          for (const storedOff of [false, true]) await check(browser, `http://127.0.0.1:${server.port}`, width, theme, storedOff);
        }
      }
    } finally { await browser.close(); }
  } finally { await server.stop(true); }
} finally {
  rmSync(app, { recursive: true, force: true });
}
