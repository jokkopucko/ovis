/**
 * A selection in progress never moves what is under it, even when the agent's turn ends under it
 * (#1922, #2650): on the unmodified app over the demo's fixture transport, the demo's opening Claude
 * turn is held until a selection has started, then ended (its last words drawn, its work folded, the
 * Working line gone). The words are in a later reply, or in the ending turn itself below its work
 * block, which folds inside the same row. With a mouse at 1280 the drag is pressed before the turn
 * ends and finished after it, from a bare press and from a drag already partway; at 390 on a touch
 * screen a selection stands (as a long press leaves it) while the turn ends; the fold is also pressed
 * at 1280 with reduced motion, where it lands in one frame. In every painted frame
 * between, the words stay where they were, the drag takes exactly them, and once the selection is
 * gone a reader who was following is at the end again. All files and HTTP traffic stay in
 * this disposable, loopback-only app; no herdr session is opened.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Page } from "playwright-core";
import panes from "../site/demo/fixtures/panes.json";
import { buildDemoApp } from "./demo-build.ts";
import { chromePath } from "./chrome-path.ts";

const playwrightCore = "playwright-core";
const { chromium } = (await import(playwrightCore)) as typeof import("playwright-core");

const app = mkdtempSync(join(tmpdir(), "herdr-chat-selection-turn-end-"));
const PANE = panes.api;
const WAIT = { timeout: 10_000 } as const;
const ASK = "Plan the offline sync rework first, no code yet.";
const PLAN = "Here is the plan for the sync rework:\n\n1. Add a `revision` column to `notes` and backfill it from `updated_at`.\n2. On reconnect, fetch the server copy and replay the local edit on top of it.\n3. Show a conflict banner when both sides changed the same note.\n\nThe migration touches the `notes` table only. I will start with step 1 once you confirm.";
/** words the ending turn writes after its work so far, below the block that folds when it ends */
const INTERIM = "The counter is wired into the replay path; next I run the metrics tests.";
/** words in the reply after the turn that ends */
const LATER = "backfill it from updated_at";
/** words in the ending turn, below its work block */
const FOLDED_UNDER = "wired into the replay path";
/** the demo transport ends its opening turn on a timer of this length (site/demo/transport.ts) */
const TURN_END_MS = 4500;

const frames = (page: Page): Promise<void> => page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));

/** Where `words` lie in the last reply holding them, and a range over them. */
const wordsBox = (page: Page, words: string) => page.evaluate((words) => {
  const turn = [...document.querySelectorAll(".chat-turn-agent")].filter((row) => (row.textContent ?? "").includes(words)).at(-1);
  if (!turn) throw new Error(`not in a reply: ${words}`);
  const walker = document.createTreeWalker(turn, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) nodes.push(node as Text);
  const at = nodes.map((node) => node.data).join("").indexOf(words);
  const point = (offset: number): [Text, number] => { let left = offset; for (const node of nodes) { if (left <= node.data.length) return [node, left]; left -= node.data.length; } throw new Error("offset"); };
  const range = document.createRange();
  range.setStart(...point(at));
  range.setEnd(...point(at + words.length));
  (window as unknown as { wordsRange: Range }).wordsRange = range;
  const rects = [...range.getClientRects()].filter((rect) => rect.width > 0);
  return { x0: rects[0]!.left + 1, y0: rects[0]!.top + rects[0]!.height / 2, x1: rects.at(-1)!.right - 1, y1: rects.at(-1)!.top + rects.at(-1)!.height / 2 };
}, words);

/**
 * Records where the words are in every painted frame from now until `stopWatch`. A frame's reading is
 * taken in its animation frame, and taken again by a resize observer made after the app's: what the
 * app's own observers move before the paint (a fold's step) is read as painted, not as it was before.
 */
const watch = (page: Page) => page.evaluate(() => {
  const lab = window as unknown as { watched: number[]; watching: boolean; wordsRange: Range; watcher?: ResizeObserver };
  // unrounded: a reading rounded to a tenth makes a 0.96 px step read as a whole pixel
  const top = () => lab.wordsRange.getClientRects()[0]?.top ?? Number.NaN;
  lab.watched = []; lab.watching = true;
  const step = () => {
    if (!lab.watching) return;
    lab.watched.push(top());
    requestAnimationFrame(step);
  };
  lab.watcher = new ResizeObserver(() => { if (lab.watching && lab.watched.length > 0) lab.watched[lab.watched.length - 1] = top(); });
  for (const box of document.querySelectorAll(".chat-transcript-virtual, [data-chat-row], .chat-virtual-footer, .animated-height-content")) lab.watcher.observe(box);
  step();
});
const stopWatch = (page: Page) => page.evaluate(() => { const lab = window as unknown as { watched: number[]; watching: boolean; watcher?: ResizeObserver }; lab.watching = false; lab.watcher?.disconnect(); return lab.watched; });

/** The held turn ends now, and resolves once its last words are drawn and the Working line is gone. */
async function endTurn(page: Page): Promise<void> {
  await page.evaluate(() => (window as unknown as { endTurn: () => void }).endTurn());
  await page.locator(".chat-turn-agent", { hasText: "6 tests pass." }).waitFor({ state: "attached", ...WAIT });
  await page.locator(".chat-virtual-footer", { hasText: "Working" }).waitFor({ state: "detached", ...WAIT });
  await frames(page);
}

try {
  await buildDemoApp(app);
  const index = join(app, "index.html");
  const html = readFileSync(index, "utf8");
  assert.match(html, /<script type="module"/);
  // Before the demo's transport runs: its turn-end timer is held until the test calls endTurn(), and
  // the pane's transcript ends in a plan, a reply below the turn that ends, to select in. The turn that
  // ends has written words after its work so far (INTERIM), which its fold leaves below it.
  const gates = `<script>(() => {
    const wait = window.setTimeout;
    let held = null;
    window.setTimeout = (fn, ms, ...rest) => {
      if (ms === ${TURN_END_MS} && held === null) { held = () => fn(...rest); return 0; }
      return wait(fn, ms, ...rest);
    };
    window.endTurn = () => { const end = held; held = () => {}; if (end) end(); };
  })();</script>`;
  const plan = `<script>(() => {
    const demo = window.fetch;
    window.fetch = (input, init) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, location.href);
      if (url.pathname !== "/api/pane/conversation" || url.searchParams.get("pane_id") !== ${JSON.stringify(PANE)}) return demo(input, init);
      return Promise.resolve(demo(input, init)).then(async (response) => {
        if (!response.ok) return response;
        const body = await response.json();
        const working = Array.isArray(body.turns) ? body.turns.find((turn) => turn.role === "assistant" && JSON.stringify(turn.parts).includes("Adding a")) : undefined;
        if (working) working.parts.splice(3, 0, { kind: "text", text: ${JSON.stringify(INTERIM)} });
        if (Array.isArray(body.turns) && !window.endingTurnLast) body.turns = [...body.turns,
          { role: "user", ts: "2026-10-29T00:00:00.000Z", parts: [{ kind: "text", text: ${JSON.stringify(ASK)} }] },
          { role: "assistant", ts: "2026-10-29T00:00:01.000Z", end_ts: "2026-10-29T00:00:20.000Z", parts: [{ kind: "text", phase: "final_answer", text: ${JSON.stringify(PLAN)} }] }];
        return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
      });
    };
  })();</script>`;
  writeFileSync(index, html.replace(/<script type="module"/, () => `${gates}\n    <script src="./demo-transport.js"></script>\n    ${plan}\n    <script type="module"`));

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
        // pressed, nothing selected yet, while the turn ends: the press alone holds the chat
        { name: "desktop-1280-press", width: 1280, height: 800, mobile: false, partway: false, words: LATER, last: false, still: false },
        { name: "desktop-1280-drag", width: 1280, height: 800, mobile: false, partway: true, words: LATER, last: false, still: false },
        { name: "phone-390", width: 390, height: 844, mobile: true, partway: false, words: LATER, last: false, still: false },
        // in the ending turn itself: its row's top stays put while its work block folds above the
        // words, with the plan after it and as the newest turn
        { name: "desktop-1280-fold", width: 1280, height: 800, mobile: false, partway: false, words: FOLDED_UNDER, last: true, still: false },
        { name: "phone-390-fold", width: 390, height: 844, mobile: true, partway: false, words: FOLDED_UNDER, last: false, still: false },
        // with reduced motion the block folds in one frame, as one slow frame of the slide does: the
        // list measures a shrunk row a frame late, and moves the view itself when it does
        { name: "desktop-1280-fold-reduced-motion", width: 1280, height: 800, mobile: false, partway: false, words: FOLDED_UNDER, last: true, still: true },
      ] as const;
      for (const shape of shapes) {
        const label = shape.name;
        const context = await browser.newContext({ viewport: { width: shape.width, height: shape.height }, locale: "en-US", reducedMotion: shape.still ? "reduce" : "no-preference", hasTouch: shape.mobile, isMobile: shape.mobile });
        try {
          await context.addInitScript(([id, last]) => {
            localStorage.setItem("ovis:settings", JSON.stringify({ language: "en", theme: "dark", palette: "codex" }));
            localStorage.setItem(`ovis:view:${id}`, "chat");
            // the plan is left out: the turn that ends is the newest one
            (window as unknown as { endingTurnLast: boolean }).endingTurnLast = last;
          }, [PANE, shape.last] as const);
          const page = await context.newPage();
          const errors: string[] = [];
          page.on("pageerror", (error) => errors.push(error.message));
          page.setDefaultTimeout(WAIT.timeout);
          await page.goto(url);
          await page.getByText(shape.words, { exact: false }).waitFor(WAIT);
          // the turn is still at work: its Working line under a later reply, or its own live block
          await page.locator(shape.last ? ".work-block.is-live" : ".chat-virtual-footer:has-text('Working')").waitFor(WAIT);
          await frames(page);
          const box = await wordsBox(page, shape.words);
          const room = await page.evaluate(() => document.querySelector<HTMLElement>(".chat-transcript-virtual")!.style.minHeight);

          await watch(page);
          if (!shape.mobile) {
            // pressed (and, for a drag, moved partway) before the turn ends, finished after it
            await page.mouse.move(box.x0, box.y0);
            await page.mouse.down();
            if (shape.partway) await page.mouse.move((box.x0 + box.x1) / 2, (box.y0 + box.y1) / 2, { steps: 8 });
            await endTurn(page);
            await page.mouse.move(box.x1, box.y1, { steps: 8 });
            await page.mouse.up();
          } else {
            // the range a long press and its handles leave, standing while the turn ends
            await page.evaluate(() => { const selection = getSelection()!; selection.removeAllRanges(); selection.addRange((window as unknown as { wordsRange: Range }).wordsRange); });
            await frames(page);
            await endTurn(page);
          }
          // watched until the fold has slid shut, and the frames the list measures it in after
          await page.waitForFunction(() => document.querySelector(".chat-view-virtual .animated-height.is-moving") === null, undefined, WAIT);
          await frames(page);
          await frames(page);
          const tops = await stopWatch(page);
          const shown = tops.map((top) => top.toFixed(2)).join(", ");
          assert.ok(tops.length > 2 && tops.every(Number.isFinite), `${label}: the words were watched across the selection (${shown})`);
          // within a pixel: the view scrolls in whole pixels, and a fold's transition moves a fraction of one
          assert.ok(tops.every((top) => Math.abs(top - tops[0]!) < 1), `${label}: the words stay put while they are selected, every painted frame (tops ${shown})`);
          assert.equal(await page.evaluate(() => getSelection()?.toString() ?? ""), shape.words, `${label}: the selection holds exactly the words selected`);

          // once the selection is gone, the reader still following is at the end, with no room kept past it
          await page.evaluate(() => getSelection()?.removeAllRanges());
          await frames(page);
          const end = await page.evaluate(() => {
            const node = document.querySelector<HTMLElement>(".chat-view-virtual")!;
            return { gap: Math.round(node.scrollHeight - node.clientHeight - node.scrollTop), room: document.querySelector<HTMLElement>(".chat-transcript-virtual")!.style.minHeight };
          });
          assert.deepEqual(end, { gap: 0, room }, `${label}: back at the end once the selection is gone, with the list's own min-height`);
          assert.deepEqual(errors, [], `${label}: no page errors`);
          console.log(`PASS ${label}`);
        } finally {
          await context.close();
        }
      }

      // A reader who scrolls up while words stand selected, with no input this page sees (a screen
      // reader, find in page), has left the end: letting the selection go leaves them where they are.
      // In a few steps, a pixel at a time, and a pixel at a time after the transcript grew below the
      // selection (an agent still writing), already far from its end; and back up a pixel at a time
      // after scrolling down into what grew, past where the chat last put the view.
      for (const [step, steps, grown, down] of [[30, 3, 0, 0], [1, 90, 0, 0], [1, 20, 150, 0], [1, 100, 300, 200], [151, 1, 300, 150]] as const) {
        const label = `desktop-1280-reader-away-${step}px${grown ? `-grown-${grown}` : ""}${down ? `-down-${down}` : ""}`;
        const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: "en-US" });
        try {
          await context.addInitScript((id) => {
            localStorage.setItem("ovis:settings", JSON.stringify({ language: "en", theme: "dark", palette: "codex" }));
            localStorage.setItem(`ovis:view:${id}`, "chat");
          }, PANE);
          const page = await context.newPage();
          page.setDefaultTimeout(WAIT.timeout);
          await page.goto(url);
          await page.getByText(LATER, { exact: false }).waitFor(WAIT);
          await frames(page);
          await wordsBox(page, LATER);
          await page.evaluate(() => { const selection = getSelection()!; selection.removeAllRanges(); selection.addRange((window as unknown as { wordsRange: Range }).wordsRange); });
          await frames(page);
          const gap = () => page.evaluate(() => { const node = document.querySelector<HTMLElement>(".chat-view-virtual")!; return Math.round(node.scrollHeight - node.clientHeight - node.scrollTop); });
          assert.equal(await gap(), 0, `${label}: at the end before scrolling`);
          if (grown) {
            await page.evaluate((grown) => {
              const footer = document.querySelector<HTMLElement>(".chat-virtual-footer")!;
              footer.style.paddingBottom = `${Number.parseFloat(getComputedStyle(footer).paddingBottom) + grown}px`;
            }, grown);
            await frames(page);
            assert.equal(await gap(), grown, `${label}: what grew below the selection is not followed under it`);
          }
          if (down) {
            // the row above the words grows first: the hold puts the view back for it, so the chat has
            // put the view somewhere since the selection began
            const wordsTop = () => page.evaluate(() => (window as unknown as { wordsRange: Range }).wordsRange.getClientRects()[0]!.top);
            const before = await wordsTop();
            await page.evaluate(() => {
              const rows = [...document.querySelectorAll<HTMLElement>("[data-chat-row]")].sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top);
              rows.at(-2)!.style.paddingBottom = "40px";
            });
            await frames(page);
            await frames(page);
            assert.ok(Math.abs(await wordsTop() - before) < 1, `${label}: a row growing above the words moves them not, under the selection`);
            await page.evaluate((down) => { document.querySelector<HTMLElement>(".chat-view-virtual")!.scrollTop += down; }, down);
            await frames(page);
            assert.equal(await gap(), grown - down, `${label}: scrolled down into what grew`);
          }
          for (let made = 0; made < steps; made++) {
            await page.evaluate((step) => { document.querySelector<HTMLElement>(".chat-view-virtual")!.scrollTop -= step; }, step);
            await frames(page);
          }
          assert.equal(await gap(), grown - down + step * steps, `${label}: the scroll stands under the selection`);
          await page.evaluate(() => getSelection()?.removeAllRanges());
          await frames(page);
          await frames(page);
          assert.equal(await gap(), grown - down + step * steps, `${label}: still away from the end once the selection is gone`);
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
