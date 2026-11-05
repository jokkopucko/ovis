/**
 * Comments on a reply (#511) on the unmodified app over the demo's fixture transport: a selection
 * in one agent reply offers Comment over the chat without moving it, the comment waits in one chip
 * over the input card, and the next message carries the comments first, as `> quote` lines and
 * the comment, then the typed text, with `agent_only`. A slash command leaves them waiting, and a
 * selection reaching a user message offers nothing. At 1280 with a mouse and at 390 on a touch
 * screen. With UI_EVIDENCE_DIR set, each state is captured in the Codex palette, dark and light.
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

/** Two painted frames: what the page already took has been committed and laid out. */
const frames = (page: Page): Promise<void> => page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));

/** The chat scroller's box and place: a selection in progress must leave both as they were (#1922). */
const layout = (page: Page) => page.evaluate(() => {
  const view = document.querySelector<HTMLElement>(".chat-view")!;
  return { height: view.clientHeight, scrollTop: view.scrollTop, composer: document.querySelector(".composer")!.getBoundingClientRect().top };
});

/** The text-node range of `phrase` in the last agent reply (or from the user's ask through it), as client rects' ends. */
const rangeOf = (page: Page, phrase: string, fromAsk = false) => page.evaluate(([words, ask]) => {
  const rows = [...document.querySelectorAll(".chat-turn-agent")];
  const turn = rows[rows.length - 1]!;
  const textNodes = (root: Node): Text[] => { const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT); const nodes: Text[] = []; for (let node = walker.nextNode(); node; node = walker.nextNode()) nodes.push(node as Text); return nodes; };
  const find = (nodes: Text[], target: string): [Text, number, Text, number] => {
    const all = nodes.map((node) => node.data).join("");
    const at = all.indexOf(target);
    if (at < 0) throw new Error(`not in the reply: ${target}`);
    const point = (offset: number): [Text, number] => { let left = offset; for (const node of nodes) { if (left <= node.data.length) return [node, left]; left -= node.data.length; } throw new Error("offset"); };
    return [...point(at), ...point(at + target.length)];
  };
  const [wordsNode, wordsAt, endText, end] = find(textNodes(turn), words);
  const user = ask === null ? null : [...document.querySelectorAll(".chat-turn-user")].find((node) => node.textContent?.includes(ask))!;
  const [startNode, startAt] = user === null ? [wordsNode, wordsAt] : find(textNodes(user), ask!);
  const range = document.createRange();
  range.setStart(startNode, startAt);
  range.setEnd(endText, end);
  const rects = [...range.getClientRects()].filter((rect) => rect.width > 0);
  return { x0: rects[0]!.left + 1, y0: rects[0]!.top + rects[0]!.height / 2, x1: rects.at(-1)!.right - 1, y1: rects.at(-1)!.top + rects.at(-1)!.height / 2 };
}, [phrase, fromAsk ? ASK : null] as const);

/** Selects as a reader does: a mouse drag on a desktop; on a touch screen the range the handles leave. */
async function select(page: Page, phrase: string, mouse: boolean, fromAsk = false): Promise<void> {
  if (mouse) {
    const box = await rangeOf(page, phrase, fromAsk);
    await page.mouse.move(box.x0, box.y0);
    await page.mouse.down();
    await page.mouse.move((box.x0 + box.x1) / 2, (box.y0 + box.y1) / 2, { steps: 4 });
    await page.mouse.move(box.x1, box.y1, { steps: 4 });
    await page.mouse.up();
  } else {
    await page.evaluate(([words, ask]) => {
      const rows = [...document.querySelectorAll(".chat-turn-agent")];
      const turn = rows[rows.length - 1]!;
      const textNodes = (root: Node): Text[] => { const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT); const nodes: Text[] = []; for (let node = walker.nextNode(); node; node = walker.nextNode()) nodes.push(node as Text); return nodes; };
      const point = (nodes: Text[], offset: number): [Text, number] => { let left = offset; for (const node of nodes) { if (left <= node.data.length) return [node, left]; left -= node.data.length; } throw new Error("offset"); };
      const nodes = textNodes(turn);
      const all = nodes.map((node) => node.data).join("");
      const at = all.indexOf(words);
      const range = document.createRange();
      if (ask !== null) {
        const user = [...document.querySelectorAll(".chat-turn-user")].find((node) => node.textContent?.includes(ask))!;
        const userNodes = textNodes(user);
        range.setStart(...point(userNodes, userNodes.map((node) => node.data).join("").indexOf(ask)));
      } else range.setStart(...point(nodes, at));
      range.setEnd(...point(nodes, at + words.length));
      getSelection()!.removeAllRanges();
      getSelection()!.addRange(range);
    }, [phrase, fromAsk ? ASK : null] as const);
  }
  await frames(page);
}

async function comment(page: Page, phrase: string, text: string, mouse: boolean, count: number): Promise<void> {
  await select(page, phrase, mouse);
  await page.locator(".reply-comment-offer").waitFor(WAIT);
  await page.locator(".reply-comment-offer").click();
  const field = page.getByRole("textbox", { name: "Comment", exact: true });
  await field.fill(text);
  // Ctrl+Enter saves, as the form says; the selection goes with it
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
  // Over the demo's own transport: the pane's transcript reads end in a plan to comment on, and
  // every submit frame the client sends is recorded (window.replyLab). Everything else is the demo's.
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
      // The chat's timeline chunk arriving after the Comment layer mounted (a cold load on a slow link): its
      // selection is still offered and saved once the replies are drawn
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

          // a selection reaching the user's message offers nothing
          await select(page, "backfill it from", !shape.mobile, true);
          assert.ok((await page.evaluate(() => getSelection()?.toString() ?? "")).includes("backfill it from"), `${label}: the crossing selection holds`);
          assert.equal(await page.locator(".reply-comment-offer").count(), 0, `${label}: no Comment across a user message`);
          await page.evaluate(() => getSelection()?.removeAllRanges());
          await frames(page);

          // the action floats: the chat keeps its size and place while the selection is made and offered
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
          await page.locator(".reply-comments-open", { hasText: "1 comment on the reply" }).waitFor(WAIT);
          await frames(page);
          assert.equal(await page.evaluate(() => getSelection()?.isCollapsed ?? true), true, `${label}: saving clears the selection`);

          await comment(page, SECOND.quote, SECOND.comment, !shape.mobile, 2);
          await page.locator(".reply-comments-open").click();
          await page.getByRole("dialog", { name: "Comments on the reply" }).waitFor(WAIT);
          assert.deepEqual(await page.locator(".reply-comments-list li > p").allTextContents(), [FIRST.comment, SECOND.comment], `${label}: the list in the order written`);
          const composer = page.getByRole("textbox", { name: "Message", exact: true });
          await composer.fill("Go ahead with step 1.");
          await page.locator(".reply-comments-open").click();
          await shot("3-chip");
          await page.keyboard.press("Escape");

          // a slash command goes alone: the comments wait for the next message
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

          // the next message carries them, first, then what was typed, for an agent alone
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
