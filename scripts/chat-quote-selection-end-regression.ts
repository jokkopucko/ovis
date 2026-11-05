/**
 * Quote and Comment on a selection that runs past a reply's last word, on the unmodified app over
 * the demo's fixture transport, in a Claude and a Codex chat: a triple-click on the reply's last
 * paragraph (its range ends at the start of what follows the words: the copy row or a work block)
 * and a drag past the last word both offer Quote and Comment, and Quote takes the reply's words
 * alone, never the copy row's labels or time. A selection reaching a user message or another reply
 * still offers nothing. A reply ending in a word its copy row shows (TXT) keeps it. At 1280 with a mouse and at 390 on a touch screen (the range a triple tap
 * or the handles leave). All files and HTTP traffic stay in this disposable, loopback-only app; no
 * herdr session is opened.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Page } from "playwright-core";
import { appFaces } from "./app-faces.ts";
import panes from "../site/demo/fixtures/panes.json";
import { buildDemoApp } from "./demo-build.ts";
import { chromePath } from "./chrome-path.ts";

const playwrightCore = "playwright-core";
const { chromium } = (await import(playwrightCore)) as typeof import("playwright-core");

const app = mkdtempSync(join(tmpdir(), "herdr-quote-end-demo-"));
const WAIT = { timeout: 10_000 } as const;

const frames = (page: Page): Promise<void> => page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));

/**
 * The last block (a paragraph, a list) of the last reply whose words end just before its copy row (no
 * work block after them): its words, and where a drag starts and goes past its end.
 */
const lastParagraph = (page: Page) => page.evaluate(() => {
  const paragraph = [...document.querySelectorAll(".chat-turn-agent")].map((turn) => [...turn.children].filter((child) => !child.matches(".chat-turn-meta")).at(-1)).filter((last): last is Element => last?.matches(".markdown") === true && last.textContent!.trim() !== "").at(-1)!.lastElementChild!;
  const rects = [...paragraph.getClientRects()];
  const lines = [...(() => { const range = document.createRange(); range.selectNodeContents(paragraph); return range.getClientRects(); })()].filter((rect) => rect.width > 0);
  const first = lines[0]!, last = lines.at(-1)!;
  const below = paragraph.closest(".markdown")!.nextElementSibling?.getBoundingClientRect().top ?? last.bottom + 8;
  return { words: paragraph.textContent!.trim(), x0: first.left + 1, y0: first.top + first.height / 2, x1: Math.max(...rects.map((rect) => rect.right)) + 40, y1: (last.bottom + below) / 2 };
});

/** A triple-click (a triple tap's range on a touch screen): the paragraph, up to the start of what follows the reply's words. */
async function tripleClick(page: Page, mouse: boolean): Promise<void> {
  if (mouse) {
    const box = await lastParagraph(page);
    await page.mouse.click(box.x0 + 4, box.y0, { clickCount: 3 });
  } else await page.evaluate(() => {
    const paragraph = [...document.querySelectorAll(".chat-turn-agent")].map((turn) => [...turn.children].filter((child) => !child.matches(".chat-turn-meta")).at(-1)).filter((last): last is Element => last?.matches(".markdown") === true && last.textContent!.trim() !== "").at(-1)!.lastElementChild!;
    const range = document.createRange();
    range.setStart(paragraph, 0);
    range.setEnd(paragraph.closest(".markdown")!.nextElementSibling!, 0);
    getSelection()!.removeAllRanges();
    getSelection()!.addRange(range);
  });
}

/** A drag from the paragraph's first word past its last one (the handles taken past the reply's end on a touch screen). */
async function dragPastEnd(page: Page, mouse: boolean): Promise<void> {
  if (mouse) {
    const box = await lastParagraph(page);
    await page.mouse.move(box.x0, box.y0);
    await page.mouse.down();
    await page.mouse.move((box.x0 + box.x1) / 2, box.y0, { steps: 4 });
    await page.mouse.move(box.x1, box.y1, { steps: 6 });
    await page.mouse.up();
  } else await page.evaluate(() => {
    const paragraph = [...document.querySelectorAll(".chat-turn-agent")].map((turn) => [...turn.children].filter((child) => !child.matches(".chat-turn-meta")).at(-1)).filter((last): last is Element => last?.matches(".markdown") === true && last.textContent!.trim() !== "").at(-1)!.lastElementChild!;
    const turn = paragraph.closest(".chat-turn-agent")!;
    const range = document.createRange();
    range.setStart(paragraph, 0);
    range.setEnd(turn, turn.childNodes.length);
    getSelection()!.removeAllRanges();
    getSelection()!.addRange(range);
  });
}

/**
 * A range from the user's last message, or the reply before the last one, into the last reply's
 * words, or from a reply's words into the work block after them; false: the chat has no such place.
 */
async function reaching(page: Page, from: "user" | "reply" | "work"): Promise<boolean> {
  return page.evaluate((kind) => {
    const words = (root: Element): Text[] => { const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT); const nodes: Text[] = []; for (let node = walker.nextNode(); node; node = walker.nextNode()) if ((node as Text).data.trim() !== "") nodes.push(node as Text); return nodes; };
    if (kind === "work") {
      const reply = [...document.querySelectorAll(".chat-turn-agent > .markdown")].filter((markdown) => markdown.nextElementSibling?.querySelector(".work-block-title")).at(-1);
      if (reply === undefined) return false;
      const title = words(reply.nextElementSibling!.querySelector(".work-block-title")!)[0]!;
      const range = document.createRange();
      range.setStart(words(reply)[0]!, 0);
      range.setEnd(title, Math.min(3, title.data.length));
      getSelection()!.removeAllRanges();
      getSelection()!.addRange(range);
      return true;
    }
    const replies = [...document.querySelectorAll(".chat-turn-agent .markdown")];
    if (kind === "reply" && replies.length < 2) return false;
    const start = kind === "user" ? words([...document.querySelectorAll(".chat-turn-user")].at(-1)!)[0]! : words(replies.at(-2)!).at(-1)!;
    const end = words(replies.at(-1)!)[0]!;
    const range = document.createRange();
    range.setStart(start, 0);
    range.setEnd(end, Math.min(4, end.data.length));
    getSelection()!.removeAllRanges();
    getSelection()!.addRange(range);
    return true;
  }, from);
}

try {
  await buildDemoApp(app);
  const index = join(app, "index.html");
  const html = readFileSync(index, "utf8");
  assert.match(html, /<script type="module"/);
  // the Claude chat's last reply ends in a word its copy row also shows (TXT): the quote keeps it
  const gates = `<script>(() => {
    const demo = window.fetch;
    window.fetch = (input, init) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, location.href);
      if (url.pathname !== "/api/pane/conversation" || url.searchParams.get("pane_id") !== ${JSON.stringify(panes.api)}) return demo(input, init);
      return Promise.resolve(demo(input, init)).then(async (response) => {
        if (!response.ok) return response;
        const body = await response.json();
        if (Array.isArray(body.turns)) body.turns = [...body.turns,
          { role: "user", ts: "2026-10-29T00:00:00.000Z", parts: [{ kind: "text", text: "How do I get the report out?" }] },
          { role: "assistant", ts: "2026-10-29T00:00:01.000Z", end_ts: "2026-10-29T00:00:05.000Z", parts: [{ kind: "text", phase: "final_answer", text: "Open Reports and press Export.\\n\\nPick the format you want: CSV or TXT" }] }];
        return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
      });
    };
  })();</script>`;
  writeFileSync(index, html.replace(/<script type="module"/, () => `<script src="./demo-transport.js"></script>\n    ${gates}\n    <script type="module"`));

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
      const shapes = [
        { name: "desktop-1280", width: 1280, height: 800, mobile: false },
        { name: "phone-390", width: 390, height: 844, mobile: true },
      ] as const;
      for (const [agent, pane] of [["claude", panes.api], ["codex", panes.web]] as const) for (const shape of shapes) {
        const label = `${agent}-${shape.name}`;
        const context = await browser.newContext({ viewport: { width: shape.width, height: shape.height }, locale: "en-US", hasTouch: shape.mobile, isMobile: shape.mobile });
        try {
          await context.addInitScript((id) => {
            localStorage.setItem("ovis:settings", JSON.stringify({ language: "en", theme: "dark", palette: "codex" }));
            localStorage.setItem(`ovis:view:${id}`, "chat");
          }, pane);
          const page = await context.newPage();
          const errors: string[] = [];
          page.on("pageerror", (error) => errors.push(error.message));
          page.setDefaultTimeout(WAIT.timeout);
          await page.goto(`http://127.0.0.1:${server.port}/herdr-web-ui/demo/app/?pane=${encodeURIComponent(pane)}`);
          await page.locator(".chat-turn-agent > .markdown").last().waitFor({ state: "attached", ...WAIT });
          await page.locator(".chat-frame[data-pane-content]").waitFor({ state: "attached", ...WAIT });
          await appFaces(page);
          await frames(page);
          const composer = page.getByRole("textbox", { name: "Message", exact: true });
          const { words } = await lastParagraph(page);
          if (agent === "claude") assert.equal(words, "Pick the format you want: CSV or TXT", `${label}: the reply ending in TXT`);

          for (const [gesture, select] of [["triple-click", tripleClick], ["drag past the end", dragPastEnd]] as const) {
            await composer.fill("");
            await composer.blur();
            await page.evaluate(() => getSelection()?.removeAllRanges());
            await frames(page);
            await select(page, !shape.mobile);
            await frames(page);
            assert.ok((await page.evaluate(() => getSelection()?.toString() ?? "")).includes(words), `${label} ${gesture}: the paragraph is selected`);
            // a missing offer names where the range ended and what lies between the reply's words and that end
            await page.locator(".selection-offer").waitFor(WAIT).catch(async () => {
              const where = await page.evaluate(() => {
                const range = getSelection()!.getRangeAt(0);
                const end = range.endContainer instanceof Element ? range.endContainer : range.endContainer.parentElement!;
                const words = [...document.querySelectorAll(".chat-turn-agent .markdown")].at(-1)!;
                const tail = document.createRange();
                tail.setStart(words, words.childNodes.length);
                tail.setEnd(range.endContainer, range.endOffset);
                return `ends in .${end.className || end.tagName}@${range.endOffset}, after the words: ${JSON.stringify(tail.toString())}`;
              });
              assert.fail(`${label} ${gesture}: no Quote or Comment; the range ${where}`);
            });
            assert.equal(await page.locator(".selection-quote").count(), 1, `${label} ${gesture}: Quote offered`);
            assert.equal(await page.locator(".reply-comment-offer").count(), 1, `${label} ${gesture}: Comment offered`);
            await page.locator(".selection-quote").click();
            await page.locator(".selection-offer").waitFor({ state: "detached", ...WAIT });
            assert.equal(await composer.inputValue(), `> ${words}\n\n`, `${label} ${gesture}: the reply's words alone, no copy row or time`);
          }

          await composer.fill("");
          await composer.blur();
          let refused = 0;
          for (const from of ["user", "reply", "work"] as const) {
            if (!await reaching(page, from)) continue;
            refused++;
            await frames(page);
            await frames(page);
            assert.equal(await page.locator(".selection-offer").count(), 0, `${label}: nothing offered for a selection ${from === "user" ? "from the user's message" : from === "reply" ? "from the reply before" : "into a work block"}`);
            await page.evaluate(() => getSelection()?.removeAllRanges());
          }
          assert.deepEqual(errors, [], `${label}: no page errors`);
          console.log(`PASS ${label} (${refused} refused selections)`);
        } finally {
          await context.close();
        }
      }
    } finally {
      await browser.close();
    }
  } finally {
    server.stop(true);
  }
} finally {
  rmSync(app, { recursive: true, force: true });
}
