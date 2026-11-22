/**
 * All files and HTTP traffic stay in this disposable, loopback-only app; no herdr session is opened.
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
import { serveDemo } from "./demo-server.ts";

const playwrightCore = "playwright-core";
const { chromium } = (await import(playwrightCore)) as typeof import("playwright-core");

const app = mkdtempSync(join(tmpdir(), "herdr-reply-comments-demo-"));
const evidence = process.env.UI_EVIDENCE_DIR;
if (evidence) mkdirSync(evidence, { recursive: true });
const PANE = panes.api;
const WAIT = { timeout: 10_000 } as const;
const ASK = "Plan the offline sync rework first, no code yet.";
const PLAN = "Here is the plan for the sync rework:\n\n1. Add a `revision` column to `notes` and backfill it from `updated_at`.\n2. On reconnect, fetch the server copy and replay the local edit on top of it.\n3. Show a conflict banner when both sides changed the same note.\n\nThe migration touches the `notes` table only. I will start with step 1 once you confirm.";
const FIRST = { quote: "backfill it from updated_at", comment: "Backfill in batches of 1,000, the table has 40 million rows." };
const SECOND = { quote: "replay the local edit on top of it", comment: "If both sides changed the same field, ask instead of replaying." };

interface Submit { text: string; agent_only?: true; delivery?: string }

const frames = (page: Page): Promise<void> => page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));

const atEnd = (page: Page) => page.waitForFunction(() => {
  const view = document.querySelector<HTMLElement>('.chat-view[data-chat-pinned="0"]');
  const transcript = view?.querySelector<HTMLElement>(".chat-transcript-virtual");
  // The list can temporarily pad the transcript past its real end.
  return view !== null && transcript?.style.paddingBottom === ""
    && Math.abs(view.scrollHeight - view.clientHeight - view.scrollTop) <= 1;
}, undefined, WAIT);

const layout = (page: Page) => page.evaluate(() => {
  const view = document.querySelector<HTMLElement>(".chat-view")!;
  return { height: view.clientHeight, scrollTop: view.scrollTop, composer: document.querySelector(".composer")!.getBoundingClientRect().top };
});

const selectRange = (page: Page, phrase: string, mouse: boolean, fromAsk?: string) => page.evaluate(async ({ words, ask, drag, timeout }) => {
  const textNodes = (root: Node): Text[] => { const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT); const nodes: Text[] = []; for (let node = walker.nextNode(); node; node = walker.nextNode()) nodes.push(node as Text); return nodes; };
  const find = (nodes: Text[], target: string): [Text, number, Text, number] => {
    const all = nodes.map((node) => node.data).join("");
    const at = all.indexOf(target);
    if (at < 0) throw new Error(`not in the reply: ${target}`);
    const point = (offset: number): [Text, number] => { let left = offset; for (const node of nodes) { if (left <= node.data.length) return [node, left]; left -= node.data.length; } throw new Error("offset"); };
    return [...point(at), ...point(at + target.length)];
  };
  const deadline = performance.now() + timeout;
  let previous = "";
  // Clearing a selection releases the virtual timeline's scroll anchor. Use the range
  // only once the current reply's endpoints are hittable and stop moving across renders.
  while (performance.now() < deadline) {
    let current = "";
    const turn = [...document.querySelectorAll(".chat-turn-agent")].find((node) => node.textContent?.includes("Show a conflict banner"));
    const start = ask === undefined ? turn : [...document.querySelectorAll(".chat-turn-user")].find((node) => node.textContent?.includes(ask));
    if (turn && start) {
      const [wordsNode, wordsAt, endText, end] = find(textNodes(turn), words);
      const [startNode, startAt] = ask === undefined ? [wordsNode, wordsAt] : find(textNodes(start), ask);
      const range = document.createRange();
      range.setStart(startNode, startAt);
      range.setEnd(endText, end);
      if (!drag) {
        const selection = getSelection();
        selection?.removeAllRanges();
        selection?.addRange(range);
        return null;
      }
      const rects = [...range.getClientRects()].filter((rect) => rect.width > 0);
      const first = rects[0], last = rects.at(-1);
      if (first && last) {
        const point = { x0: first.left + 1, y0: first.top + first.height / 2, x1: last.right - 1, y1: last.top + last.height / 2 };
        const hit = start.contains(document.elementFromPoint(point.x0, point.y0)) && turn.contains(document.elementFromPoint(point.x1, point.y1));
        if (hit) {
          current = JSON.stringify(point);
          if (current === previous) return point;
        }
      }
    }
    previous = current;
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  }
  throw new Error(`the range for "${words}" did not settle inside the reply`);
}, { words: phrase, ask: fromAsk, drag: mouse, ...WAIT });

async function select(page: Page, phrase: string, mouse: boolean, fromAsk = false): Promise<void> {
  const box = await selectRange(page, phrase, mouse, fromAsk ? ASK : undefined);
  if (box !== null) {
    await page.mouse.move(box.x0, box.y0);
    await page.mouse.down();
    await page.mouse.move((box.x0 + box.x1) / 2, (box.y0 + box.y1) / 2, { steps: 4 });
    await page.mouse.move(box.x1, box.y1, { steps: 4 });
    await page.mouse.up();
  }
  if (fromAsk) await frames(page);
  else assert.equal((await page.evaluate(() => getSelection()?.toString() ?? "")).trim(), phrase, "the gesture selected the intended quote");
}

async function comment(page: Page, phrase: string, text: string, mouse: boolean, count: number): Promise<void> {
  await select(page, phrase, mouse);
  await page.locator(".reply-comment-offer").waitFor(WAIT);
  await page.locator(".reply-comment-offer").click();
  const field = page.getByRole("textbox", { name: "Comment", exact: true });
  await field.fill(text);
  await field.press("Control+Enter");
  await page.locator(".reply-comment-form").waitFor({ state: "detached", ...WAIT });
  await page.locator(".reply-comments-open", { hasText: count === 1 ? "1 comment on the reply" : `${count} comments on the reply` }).waitFor(WAIT);
  await frames(page);
}

try {
  await buildDemoApp(app);
  const index = join(app, "index.html");
  const html = readFileSync(index, "utf8");
  assert.match(html, /<script type="module"/);
  const gates = `<script>(() => {
    const demo = window.fetch;
    const lab = window.replyLab = { submits: [] };
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
        if (Array.isArray(body.turns)) body.turns = [...body.turns,
          { role: "user", ts: "2026-10-29T00:00:00.000Z", parts: [{ kind: "text", text: ${JSON.stringify(ASK)} }] },
          { role: "assistant", ts: "2026-10-29T00:00:01.000Z", end_ts: "2026-10-29T00:00:20.000Z", parts: [{ kind: "text", phase: "final_answer", text: ${JSON.stringify(PLAN)} }] }];
        return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
      });
    };
  })();</script>`;
  writeFileSync(index, html.replace(/<script type="module"/, () => `<script src="./demo-transport.js"></script>\n    ${gates}\n    <script type="module"`));

  const server = serveDemo(app);
  const url = `http://127.0.0.1:${server.port}/herdr-web-ui/demo/app/?pane=${encodeURIComponent(PANE)}`;
  try {
    const browser = await chromium.launch({ executablePath: chromePath(), headless: true, args: ["--no-sandbox"] });
    try {
      {
        const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: "en-US" });
        try {
          await context.addInitScript((id) => {
            localStorage.setItem("ovis:settings", JSON.stringify({ language: "en", palette: "codex" }));
            localStorage.setItem(`ovis:view:${id}`, "chat");
          }, PANE);
          let release!: () => void;
          const held = new Promise<void>((resolve) => { release = resolve; });
          await context.route(/\/assets\/ChatTimeline-[^/]*\.js$/, async (route) => { await held; await route.continue(); });
          const page = await context.newPage();
          page.setDefaultTimeout(WAIT.timeout);
          await page.goto(url);
          await page.locator(".reply-comment-layer").waitFor({ state: "attached", ...WAIT });
          assert.equal(await page.locator("[data-chat-row]").count(), 0, "late timeline: the action mounted before the replies were drawn");
          release();
          await page.getByText("Show a conflict banner", { exact: false }).waitFor(WAIT);
          await page.locator(".chat-frame[data-pane-content]").waitFor({ state: "attached", ...WAIT });
          await appFaces(page);
          await frames(page);
          await comment(page, FIRST.quote, FIRST.comment, true, 1);
          console.log("PASS late-timeline");
        } finally {
          await context.close();
        }
      }
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
          await page.locator(".chat-frame[data-pane-content]").waitFor({ state: "attached", ...WAIT });
          await appFaces(page);
          await frames(page);
          assert.deepEqual(await page.evaluate(() => [document.documentElement.dataset["palette"], document.documentElement.dataset["theme"]]), ["codex", theme], `${label}: the Codex palette`);
          const shot = async (step: string) => { if (evidence) await page.screenshot({ path: join(evidence, `${label}-${step}.png`) }); };

          await select(page, "backfill it from", !shape.mobile, true);
          assert.ok((await page.evaluate(() => getSelection()?.toString() ?? "")).includes("backfill it from"), `${label}: the crossing selection holds`);
          assert.equal(await page.locator(".reply-comment-offer").count(), 0, `${label}: no Comment across a user message`);
          await page.locator('.chat-view[data-chat-pinned]:not([data-chat-pinned="0"])').waitFor({ state: "attached", ...WAIT });
          await page.evaluate(() => getSelection()?.removeAllRanges());
          await atEnd(page);
          const before = await layout(page);
          await select(page, FIRST.quote, !shape.mobile);
          await page.locator(".reply-comment-offer").waitFor(WAIT);
          await frames(page);
          assert.deepEqual(await layout(page), before, `${label}: the chat did not move under the selection`);
          await shot("1-select");
          const offer = await page.locator(".reply-comment-offer").boundingBox();
          const selected = await page.evaluate(() => { const rect = getSelection()!.getRangeAt(0).getBoundingClientRect(); return { top: rect.top, bottom: rect.bottom }; });
          assert.ok(offer !== null && offer.y >= selected.bottom - 1, `${label}: Comment stands below the selection, clear of it (${offer?.y} < ${selected.bottom})`);

          await page.locator(".reply-comment-offer").click();
          await page.getByRole("textbox", { name: "Comment", exact: true }).fill(FIRST.comment);
          await shot("2-write");
          if (shape.mobile) assert.ok(await page.locator(".reply-comment-form.is-docked").count() === 1, `${label}: the form docks over the message box`);
          await page.getByRole("textbox", { name: "Comment", exact: true }).press("Control+Enter");
          await page.locator(".reply-comment-form").waitFor({ state: "detached", ...WAIT });
          await page.locator(".reply-comments-open", { hasText: "1 comment on the reply" }).waitFor(WAIT);
          assert.equal(await page.evaluate(() => getSelection()?.isCollapsed ?? true), true, `${label}: saving clears the selection`);
          await page.locator(".chat-frame[data-pane-content]").waitFor({ state: "attached", ...WAIT });
          // The chip grew the composer; the chat follows its end a frame or more later, moving the reply under the next gesture.
          await atEnd(page);

          await comment(page, SECOND.quote, SECOND.comment, !shape.mobile, 2);
          await page.locator(".reply-comments-open").click();
          await page.getByRole("dialog", { name: "Comments on the reply" }).waitFor(WAIT);
          assert.deepEqual(await page.locator(".reply-comments-list li > p").allTextContents(), [FIRST.comment, SECOND.comment], `${label}: the list in the order written`);
          const composer = page.getByRole("textbox", { name: "Message", exact: true });
          await composer.fill("Go ahead with step 1.");
          await page.locator(".reply-comments-open").click();
          await shot("3-chip");
          await page.keyboard.press("Escape");

          await composer.fill("/compact");
          await composer.press("Escape");
          await page.locator(".reply-comments-open", { hasText: "2 comments waiting" }).waitFor(WAIT);
          await shot("4-waiting");
          const sent = await page.evaluate(() => (window as unknown as { replyLab: { submits: Submit[] } }).replyLab.submits.length);
          await page.getByRole("button", { name: "Send message", exact: true }).click();
          await page.waitForFunction((count) => (window as unknown as { replyLab: { submits: Submit[] } }).replyLab.submits.length > count, sent, WAIT);
          const command = await page.evaluate(() => (window as unknown as { replyLab: { submits: Submit[] } }).replyLab.submits.at(-1)!);
          assert.equal(command.text, "/compact", `${label}: the command goes without the comments`);
          assert.equal(command.agent_only, undefined, `${label}: a command alone is no agent-only message`);
          await page.locator(".reply-comments-open", { hasText: "2 comments on the reply" }).waitFor(WAIT);

          await composer.fill("Go ahead with step 1.");
          const next = await page.evaluate(() => (window as unknown as { replyLab: { submits: Submit[] } }).replyLab.submits.length);
          await page.getByRole("button", { name: "Send message", exact: true }).click();
          await page.waitForFunction((count) => (window as unknown as { replyLab: { submits: Submit[] } }).replyLab.submits.length > count, next, WAIT);
          const message = await page.evaluate(() => (window as unknown as { replyLab: { submits: Submit[] } }).replyLab.submits.at(-1)!);
          assert.equal(message.text, `> ${FIRST.quote}\n${FIRST.comment}\n\n> ${SECOND.quote}\n${SECOND.comment}\n\nGo ahead with step 1.`, `${label}: the message the agent gets`);
          assert.equal(message.agent_only, true, `${label}: for an agent alone`);
          await page.locator(".reply-comments").waitFor({ state: "detached", ...WAIT });
          assert.equal(await page.evaluate((id) => Object.keys(localStorage).filter((key) => key.startsWith("ovis:reply-comments:") && key.endsWith(id)).length, PANE), 0, `${label}: the sent comments left storage`);
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
