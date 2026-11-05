/**
 * Quoting a selection into the composer, on the unmodified app over the demo's fixture transport: a
 * selection in one agent reply offers Quote first and Comment second; Quote puts the words in the
 * message box as a `> ` quote with a blank line after it, after what was typed, the box takes the
 * keyboard with its caret at the end, and nothing is sent. A second quote stacks under the first,
 * Comment still opens its form, and the message then goes for an agent alone. At 1280 with a mouse
 * and at 390 on a touch screen. With UI_EVIDENCE_DIR set, each state is captured in the Codex
 * palette, dark and light. All files and HTTP traffic stay in this disposable, loopback-only app;
 * no herdr session is opened.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Page } from "playwright-core";
import { appFaces } from "./app-faces.ts";
import panes from "../site/demo/fixtures/panes.json";
import { buildDemoApp } from "./demo-build.ts";
import { chromePath } from "./chrome-path.ts";

const playwrightCore = "playwright-core";
const { chromium } = (await import(playwrightCore)) as typeof import("playwright-core");

const app = mkdtempSync(join(tmpdir(), "herdr-chat-quote-demo-"));
const evidence = process.env.UI_EVIDENCE_DIR;
if (evidence) mkdirSync(evidence, { recursive: true });
const PANE = panes.api;
const WAIT = { timeout: 10_000 } as const;
const ASK = "Plan the offline sync rework first, no code yet.";
const PLAN = "Here is the plan for the sync rework:\n\n1. Add a `revision` column to `notes` and backfill it from `updated_at`.\n2. On reconnect, fetch the server copy and replay the local edit on top of it.\n3. Show a conflict banner when both sides changed the same note.\n\nThe migration touches the `notes` table only. I will start with step 1 once you confirm.";
const FIRST = "backfill it from updated_at";
const SECOND = "replay the local edit on top of it";
const TYPED = "Before step 1:";

interface Submit { text: string; agent_only?: true }

const frames = (page: Page): Promise<void> => page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
const submits = (page: Page): Promise<Submit[]> => page.evaluate(() => (window as unknown as { quoteLab: { submits: Submit[] } }).quoteLab.submits);

/** Selects `phrase` in the last agent reply that holds it, as a reader does: a mouse drag on a desktop; on a touch screen the range the handles leave. */
async function select(page: Page, phrase: string, mouse: boolean): Promise<void> {
  const box = await page.evaluate((words) => {
    const rows = [...document.querySelectorAll(".chat-turn-agent")].filter((row) => (row.textContent ?? "").includes(words));
    const turn = rows[rows.length - 1];
    if (!turn) throw new Error(`not in a reply: ${words}`);
    const walker = document.createTreeWalker(turn, NodeFilter.SHOW_TEXT);
    const nodes: Text[] = [];
    for (let node = walker.nextNode(); node; node = walker.nextNode()) nodes.push(node as Text);
    const at = nodes.map((node) => node.data).join("").indexOf(words);
    if (at < 0) throw new Error(`not in the reply: ${words}`);
    const point = (offset: number): [Text, number] => { let left = offset; for (const node of nodes) { if (left <= node.data.length) return [node, left]; left -= node.data.length; } throw new Error("offset"); };
    const range = document.createRange();
    range.setStart(...point(at));
    range.setEnd(...point(at + words.length));
    const rects = [...range.getClientRects()].filter((rect) => rect.width > 0);
    return { x0: rects[0]!.left + 1, y0: rects[0]!.top + rects[0]!.height / 2, x1: rects.at(-1)!.right - 1, y1: rects.at(-1)!.top + rects.at(-1)!.height / 2 };
  }, phrase);
  if (mouse) {
    await page.mouse.move(box.x0, box.y0);
    await page.mouse.down();
    await page.mouse.move((box.x0 + box.x1) / 2, (box.y0 + box.y1) / 2, { steps: 4 });
    await page.mouse.move(box.x1, box.y1, { steps: 4 });
    await page.mouse.up();
    // the drag took the words, or the page moved under it: say which, at once
    const taken = await page.evaluate(() => getSelection()?.toString() ?? "");
    assert.ok(taken.includes(phrase), `the drag selected "${phrase}", not "${taken}"`);
  } else {
    await page.evaluate((words) => {
      const rows = [...document.querySelectorAll(".chat-turn-agent")].filter((row) => (row.textContent ?? "").includes(words));
      const turn = rows[rows.length - 1]!;
      const walker = document.createTreeWalker(turn, NodeFilter.SHOW_TEXT);
      const nodes: Text[] = [];
      for (let node = walker.nextNode(); node; node = walker.nextNode()) nodes.push(node as Text);
      const at = nodes.map((node) => node.data).join("").indexOf(words);
      const point = (offset: number): [Text, number] => { let left = offset; for (const node of nodes) { if (left <= node.data.length) return [node, left]; left -= node.data.length; } throw new Error("offset"); };
      const range = document.createRange();
      range.setStart(...point(at));
      range.setEnd(...point(at + words.length));
      const selection = getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
    }, phrase);
  }
  await page.locator(".selection-offer").waitFor(WAIT);
  await frames(page);
}

try {
  await buildDemoApp(app);
  const index = join(app, "index.html");
  const html = readFileSync(index, "utf8");
  assert.match(html, /<script type="module"/);
  // Over the demo's own transport: the pane's transcript ends in a plan to quote from, and every
  // submit frame the client sends is recorded (window.quoteLab). Everything else is the demo's.
  const gates = `<script>(() => {
    const demo = window.fetch;
    const lab = window.quoteLab = { submits: [], answers: 0 };
    const DemoSocket = window.WebSocket;
    const Socket = function (...args) {
      const socket = new DemoSocket(...args);
      const send = socket.send.bind(socket);
      socket.send = (raw) => { try { const message = JSON.parse(raw); if (message.type === "submit") lab.submits.push(message); } catch {} send(raw); };
      return socket;
    };
    Socket.prototype = DemoSocket.prototype;
    Object.setPrototypeOf(Socket, DemoSocket);
    window.WebSocket = Socket;
    window.fetch = (input, init) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, location.href);
      if (url.pathname !== "/api/pane/conversation" || url.searchParams.get("pane_id") !== ${JSON.stringify(PANE)}) return demo(input, init);
      return Promise.resolve(demo(input, init)).then(async (response) => {
        if (!response.ok) return response;
        const body = await response.json();
        // the demo's answers to a sent message, as the chat reads them: drawn or not, the page has them
        if (Array.isArray(body.turns)) lab.answers = body.turns.filter((turn) => turn.role === "assistant" && JSON.stringify(turn.parts).includes("This is the demo, so nothing ran")).length;
        if (Array.isArray(body.turns)) body.turns = [...body.turns,
          { role: "user", ts: "2026-10-29T00:00:00.000Z", parts: [{ kind: "text", text: ${JSON.stringify(ASK)} }] },
          { role: "assistant", ts: "2026-10-29T00:00:01.000Z", end_ts: "2026-10-29T00:00:20.000Z", parts: [{ kind: "text", phase: "final_answer", text: ${JSON.stringify(PLAN)} }] }];
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
  const url = `http://127.0.0.1:${server.port}/herdr-web-ui/demo/app/?pane=${encodeURIComponent(PANE)}`;
  try {
    const browser = await chromium.launch({ executablePath: chromePath(), headless: true, args: ["--no-sandbox"] });
    try {
      const shapes = [
        { name: "desktop-1280", width: 1280, height: 800, mobile: false },
        { name: "phone-390", width: 390, height: 844, mobile: true },
      ] as const;
      for (const shape of shapes) for (const theme of evidence ? ["dark", "light"] as const : ["dark"] as const) {
        const label = `${shape.name}-${theme}`;
        const context = await browser.newContext({ viewport: { width: shape.width, height: shape.height }, locale: "en-US", hasTouch: shape.mobile, isMobile: shape.mobile, deviceScaleFactor: evidence ? 2 : 1 });
        try {
          await context.addInitScript(([id, scheme]) => {
            localStorage.setItem("ovis:settings", JSON.stringify({ language: "en", theme: scheme, palette: "codex" }));
            localStorage.setItem(`ovis:view:${id}`, "chat");
          }, [PANE, theme] as const);
          const page = await context.newPage();
          const errors: string[] = [];
          page.on("pageerror", (error) => errors.push(error.message));
          page.setDefaultTimeout(WAIT.timeout);
          await page.goto(url);
          await page.getByText("Show a conflict banner", { exact: false }).waitFor(WAIT);
          // the demo's Claude pane is mid-turn when it opens, and ends that turn a few seconds later
          // (site/demo/transport.ts): the earlier reply gets its last words and the Working line goes,
          // and the chat, following its end, moves the reply quoted from. A drag made meanwhile ends
          // on other words, so the selections start once that turn has ended
          await page.getByText("6 tests pass.", { exact: false }).waitFor(WAIT);
          await page.locator(".chat-virtual-footer", { hasText: "Working" }).waitFor({ state: "detached", ...WAIT });
          await page.locator(".chat-frame[data-pane-content]").waitFor({ state: "attached", ...WAIT });
          await appFaces(page);
          await frames(page);
          const shot = async (step: string) => { if (evidence) await page.screenshot({ path: join(evidence, `${label}-${step}.png`) }); };
          const composer = page.getByRole("textbox", { name: "Message", exact: true });

          // something typed already: the quote goes after it
          await composer.fill(TYPED);
          await composer.blur();

          // Quote first, labelled; Comment second
          await select(page, FIRST, !shape.mobile);
          const buttons = page.locator(".selection-offer button");
          assert.equal(await buttons.count(), 2, `${label}: two actions on the selection`);
          assert.equal((await buttons.nth(0).textContent())?.trim(), "Quote", `${label}: Quote comes first, with its label`);
          assert.equal(await buttons.nth(1).getAttribute("aria-label"), "Comment", `${label}: Comment comes second`);
          await shot("1-select");

          const sent = (await submits(page)).length;
          await buttons.nth(0).click();
          await page.locator(".selection-offer").waitFor({ state: "detached", ...WAIT });
          await frames(page);
          const quoted = `${TYPED}\n\n> ${FIRST}\n\n`;
          assert.equal(await composer.inputValue(), quoted, `${label}: the quote goes after the typed text, a blank line after it`);
          const box = await page.evaluate(() => { const field = document.activeElement as HTMLTextAreaElement | null; return { focused: field?.getAttribute("aria-label") ?? null, start: field?.selectionStart ?? -1, end: field?.selectionEnd ?? -1 }; });
          assert.deepEqual(box, { focused: "Message", start: quoted.length, end: quoted.length }, `${label}: the message box has the keyboard, its caret at the end`);
          assert.equal(await page.evaluate(() => getSelection()?.isCollapsed ?? true), true, `${label}: quoting clears the selection`);

          // a second quote stacks under the first
          await composer.blur();
          await select(page, SECOND, !shape.mobile);
          await page.locator(".selection-quote").click();
          await page.locator(".selection-offer").waitFor({ state: "detached", ...WAIT });
          await frames(page);
          const stacked = `${quoted}> ${SECOND}\n\n`;
          assert.equal(await composer.inputValue(), stacked, `${label}: quotes stack in the order taken`);
          await shot("2-quoted");
          assert.equal((await submits(page)).length, sent, `${label}: quoting sends nothing`);

          // Comment still opens its form, as before
          await composer.blur();
          await select(page, FIRST, !shape.mobile);
          await page.locator(".reply-comment-offer").click();
          await page.getByRole("textbox", { name: "Comment", exact: true }).waitFor(WAIT);
          await page.getByRole("button", { name: "Cancel", exact: true }).click();
          await page.locator(".reply-comment-form").waitFor({ state: "detached", ...WAIT });
          assert.equal(await composer.inputValue(), stacked, `${label}: Comment leaves the message box alone`);

          // the message goes as written, for an agent alone: a shell would read its `>` lines as redirects
          await composer.press("End");
          await composer.pressSequentially("Go ahead.");
          const answers = await page.evaluate(() => (window as unknown as { quoteLab: { answers: number } }).quoteLab.answers);
          await page.getByRole("button", { name: "Send message", exact: true }).click();
          await page.waitForFunction((count) => (window as unknown as { quoteLab: { submits: Submit[] } }).quoteLab.submits.length > count, sent, WAIT);
          const message = (await submits(page)).at(-1)!;
          assert.equal(message.text, `${stacked}Go ahead.`, `${label}: the message the agent gets`);
          assert.equal(message.agent_only, true, `${label}: for an agent alone`);
          // the demo answers the message: once its answer is in and the Working line gone, the chat stops moving under the next drag
          await page.waitForFunction((count) => (window as unknown as { quoteLab: { answers: number } }).quoteLab.answers > count, answers, WAIT);
          // read is not drawn: the answer's row is in the page (the list keeps the rows near the end it shows), then the Working line is gone
          await page.locator(".chat-turn-agent", { hasText: "This is the demo, so nothing ran" }).last().waitFor({ state: "attached", ...WAIT });
          await page.locator(".chat-virtual-footer", { hasText: "Working" }).waitFor({ state: "detached", ...WAIT });
          await frames(page);

          // a quote past the composer's limit is refused, saying why in words, and the draft is never cut
          const full = "x".repeat(19_990);
          await composer.fill(full);
          await composer.blur();
          await select(page, FIRST, !shape.mobile);
          assert.equal(await page.locator(".selection-quote").getAttribute("aria-disabled"), "true", `${label}: Quote refuses a quote past the limit`);
          assert.equal((await page.locator(".selection-note").textContent())?.trim(), "Too long to quote: shorten the message or the selection.", `${label}: it says why`);
          await shot("3-too-long");
          // aria-disabled stays pressable (Playwright counts it as not enabled): the press must change nothing
          await page.locator(".selection-quote").click({ force: true });
          await frames(page);
          assert.equal(await composer.inputValue(), full, `${label}: the draft stays whole`);
          assert.deepEqual(errors, [], `${label}: no page errors`);
          console.log(`PASS ${label}`);
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
