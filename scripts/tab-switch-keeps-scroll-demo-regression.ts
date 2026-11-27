import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "playwright-core";
import panes from "../site/demo/fixtures/panes.json";
import { withDemoBrowser } from "./demo-browser.ts";

// All files stay in this disposable, loopback-only app; no herdr session is opened.
const PANE = panes.api!;
const WAIT = { timeout: 15_000 } as const;
// The demo's own chats are four rows and cannot scroll: the history is repeated so a reader has a
// place up the page to keep, and every text part says which round it came from.
const ROUNDS = 14;

/** The demo page's own hook: the frames React moved, filled by watchMoves. */
type MoveLog = { moves?: string[] };

const rows = (page: Page) => page.waitForFunction(() => (document.querySelector(".pane-frame.is-current .chat-view")?.scrollHeight ?? 0) > 6_000, null, WAIT);

const look = (page: Page, paneId: string) => page.evaluate((id) => {
  const frame = document.querySelector(`.pane-frame[data-layout-pane="${CSS.escape(id)}"]`);
  const view = frame?.querySelector<HTMLElement>(".chat-view") ?? null;
  return {
    scrollTop: view === null ? null : Math.round(view.scrollTop),
    scrollHeight: view === null ? null : view.scrollHeight,
    clientHeight: view === null ? null : view.clientHeight,
    hidden: frame === null ? null : frame.classList.contains("is-hidden"),
    order: [...document.querySelectorAll(".pane-frame")].map((node) => node.getAttribute("data-layout-pane")),
  };
}, paneId);

/** The row the view starts with, which is what a reader reads from when they come back: the first
 * row on the screen, waited for so a list still filling in never reads as no row. */
const topRow = async (page: Page, paneId: string): Promise<string> => {
  const handle = await page.waitForFunction((id) => {
    const view = document.querySelector<HTMLElement>(`.pane-frame[data-layout-pane="${CSS.escape(id)}"] .chat-view`);
    if (view === null) return null;
    const box = view.getBoundingClientRect();
    const rows = [...view.querySelectorAll<HTMLElement>("[data-chat-row]")]
      .filter((row) => { const rect = row.getBoundingClientRect(); return rect.bottom > box.top && rect.top < box.bottom; })
      .sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top);
    return rows[0]?.getAttribute("data-chat-row") || null;
  }, paneId, WAIT);
  const row = await handle.jsonValue();
  assert.ok(typeof row === "string" && row !== "", "a chat row is on the screen");
  return row;
};

/** Waits until the chat's list holds still: rows it renders are measured after the scroll that showed them,
 * which grows the transcript and moves scrollTop to keep the rows on the screen where they were. */
const settled = (page: Page, paneId: string) => page.evaluate((id) => new Promise<void>((resolve, reject) => {
  const view = document.querySelector<HTMLElement>(`.pane-frame[data-layout-pane="${CSS.escape(id)}"] .chat-view`)!;
  const deadline = performance.now() + 15_000;
  let last = "", still = 0;
  const check = () => {
    const now = `${Math.round(view.scrollTop)}|${view.scrollHeight}`;
    still = now === last ? still + 1 : 0;
    last = now;
    if (still >= 20) resolve();
    else if (performance.now() > deadline) reject(new Error(`the chat never held still (${now})`));
    else requestAnimationFrame(check);
  };
  requestAnimationFrame(check);
}), paneId);

/** The reader's own scroll up the transcript, with the wheel: a scroll the chat did not see the reader make
 * is taken for the list's own, and a chat that was at its end goes on following it. */
const readUp = async (page: Page, paneId: string, fraction: number): Promise<void> => {
  const view = page.locator(`.pane-frame[data-layout-pane="${paneId}"] .chat-view`);
  const distance = await view.evaluate((node, share) => Math.round((node.scrollHeight - node.clientHeight) * share), fraction);
  await view.hover();
  await page.mouse.wheel(0, -distance);
};

/** The panes whose frame React moves in the canvas: a moved frame loses the scrollTop of what it scrolls. */
async function watchMoves(page: Page): Promise<void> {
  await page.evaluate(() => {
    const canvas = document.querySelector(".pane-canvas")!;
    const seen = new Set([...canvas.querySelectorAll(".pane-frame")].map((node) => node.getAttribute("data-layout-pane")));
    const moves: string[] = [];
    new MutationObserver((records) => {
      for (const record of records) for (const node of record.addedNodes) {
        const id = node instanceof HTMLElement ? node.getAttribute("data-layout-pane") : null;
        if (id === null) continue;
        if (seen.has(id)) moves.push(id); else seen.add(id);
      }
    }).observe(canvas, { childList: true });
    (window as Window & MoveLog).moves = moves;
  });
}

/** The frames on the screen, in DOM order (the Tab order) and in left-to-right order. */
const drawnOrder = (page: Page) => page.evaluate(() => {
  const frames = [...document.querySelectorAll<HTMLElement>(".pane-frame:not(.is-hidden)")];
  const id = (node: HTMLElement) => node.getAttribute("data-layout-pane");
  return { dom: frames.map(id), visual: [...frames].sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left).map(id) };
});

const post = (page: Page, route: string, body: object): Promise<unknown> => page.evaluate(async ({ path, payload }) => {
  const answer = await fetch(`/api/${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
  if (!answer.ok) throw new Error(`${path}: ${answer.status} ${await answer.text()}`);
  return answer.json();
}, { path: route, payload: body });

const moves = (page: Page): Promise<string[] | undefined> => page.evaluate(() => (window as Window & MoveLog).moves);

/** A new tab of this workspace, one pane, answering with the pane herdr made. */
const newTab = (page: Page, paneId: string, label: string): Promise<string> => page.evaluate(async ({ id, name }) => {
  const workspace = id.split(":")[0];
  const answer = await fetch("/api/tab/create", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ workspace_id: workspace, label: name, agent: { kind: "omp" } }) });
  const made = await answer.json() as { pane_id: string };
  localStorage.setItem(`ovis:view:${made.pane_id}`, "chat");
  return made.pane_id;
}, { id: paneId, name: label });

const switchTo = async (page: Page, label: string): Promise<void> => {
  await page.locator(".tab-strip-item", { hasText: label }).first().click();
  await page.waitForFunction((text) => document.querySelector(".tab-strip-item.is-active")?.textContent?.includes(text) === true, label, WAIT);
};

await withDemoBrowser({ tempPrefix: "herdr-tab-switch-demo-", afterTransport: '\n    <script src="./long-history.js"></script>' }, async ({ app, newContext, baseUrl }) => {
  // the demo transport installs its own fetch, so the long history is wrapped once it has loaded
  // the demo's agent finishes its last turn after the first read; repeated in every round, that would grow
  // the transcript above the reader too, so each pane keeps the turns of its first answer
  writeFileSync(join(app, "long-history.js"), `(() => {
    const native = window.fetch;
    const first = new Map();
    window.fetch = async (...args) => {
      const answer = await native(...args);
      const url = typeof args[0] === "string" ? args[0] : args[0] instanceof Request ? args[0].url : String(args[0]);
      if (!url.includes("/api/pane/conversation") || url.includes("/search")) return answer;
      const data = await answer.clone().json();
      if (!Array.isArray(data.turns) || data.turns.length === 0) return answer;
      const pane = new URL(url, location.href).searchParams.get("pane_id");
      if (!first.has(pane)) first.set(pane, data.turns);
      const turns = first.get(pane);
      data.turns = Array.from({ length: ${ROUNDS} }, (_, round) => turns.map((turn, index) => ({
        ...turn,
        parts: turn.parts.map((part) => part.kind === "text" ? { ...part, text: "Round " + round + " #" + index + ": " + part.text } : part),
      }))).flat();
      return new Response(JSON.stringify(data), { status: 200, headers: { "content-type": "application/json" } });
    };
  })();`);
  for (const [face, viewport] of [["a desktop", { width: 1440, height: 900 }], ["a phone", { width: 390, height: 844 }]] as const) {
    const context = await newContext({ viewport });
    try {
      await context.addInitScript((id) => {
        localStorage.setItem("ovis:settings", JSON.stringify({ language: "en", alertsOn: false }));
        for (const pane of [id, "w1D:p1", "w1J:p1"]) localStorage.setItem(`ovis:view:${pane}`, "chat");
      }, PANE);
      const opened = await context.newPage();
      // a loaded CI runner measures the chat's rows late: the same slowness here, so the place is read as CI reads it
      await (await context.newCDPSession(opened)).send("Emulation.setCPUThrottlingRate", { rate: 4 });
      const errors: string[] = [];
      opened.on("pageerror", (error) => errors.push(error.message));
      await opened.goto(`${baseUrl}?pane=${encodeURIComponent(PANE)}`);
      await rows(opened);

      await readUp(opened, PANE, 0.55);
      await settled(opened, PANE);
      const before = await look(opened, PANE);
      const gap = before.scrollHeight! - before.clientHeight! - before.scrollTop!;
      assert.ok(before.scrollTop! > 200 && gap > 400, `${face}: the reader is up the page, away from its end (scrollTop ${before.scrollTop}, ${gap} px above the end)`);
      const topBefore = await topRow(opened, PANE);
      await watchMoves(opened);

      // two more tabs, so returning to this one moves its frame past two panes already mounted
      const second = await newTab(opened, PANE, "probe2");
      const third = await newTab(opened, PANE, "probe3");
      await opened.waitForFunction(() => document.querySelectorAll(".tab-strip-item").length >= 4, null, WAIT);
      await switchTo(opened, "probe2");
      const onSecond = await look(opened, PANE);
      assert.equal(onSecond.hidden, true, `${face}: the tab left behind keeps its pane mounted, hidden`);
      await switchTo(opened, "probe3");
      assert.equal((await look(opened, PANE)).hidden, true, `${face}: and still mounted two tabs away`);
      await switchTo(opened, "Idempotent");

      const after = await look(opened, PANE);
      assert.equal(after.hidden, false, `${face}: the pane is back on the screen`);
      assert.deepEqual(await moves(opened), [], `${face}: no pane frame is moved in the canvas, so nothing it scrolls is reset`);
      assert.deepEqual(after.order, [PANE, second, third], `${face}: the frames keep the order they were mounted in`);
      // the reader's place is kept: the row they were reading stays at the top of the view
      assert.ok(after.scrollTop! > 200, `${face}: not back at the oldest row (scrollTop ${after.scrollTop})`);
      assert.equal(await topRow(opened, PANE), topBefore, `${face}: the reader comes back to the row they left (${before.scrollTop} → ${after.scrollTop})`);
      // main leaves this frame in place on the way back and moves the two others; one more trip moves
      // this one there (it is no longer first among the mounted frames), so the place is checked again
      await switchTo(opened, "probe2");
      await switchTo(opened, "Idempotent");
      assert.deepEqual(await moves(opened), [], `${face}: a second trip moves no pane frame either`);
      await settled(opened, PANE);
      // the row, not scrollTop: the demo's live turn re-renders while the reader is away, and the list moves
      // scrollTop to keep the reader's row where it was
      const again = await look(opened, PANE);
      assert.ok(again.scrollTop! > 200, `${face}: the second trip is not back at the oldest row (scrollTop ${again.scrollTop})`);
      assert.equal(await topRow(opened, PANE), topBefore, `${face}: the second trip keeps the row the reader left`);
      assert.deepEqual(errors, []);
      console.log(`PASS ${face}: a tab switch keeps the reader's place in a chat (${before.scrollTop} → ${after.scrollTop}) and moves no pane frame`);
      if (viewport.width < 500) assert.ok(after.order.length === 3, `${face}: all three panes stay mounted on a phone`);
      else {
        // a swap in the tab on the screen reorders the frames it draws, so Tab follows the panes left to right;
        // the two other tabs' frames stay mounted between them and must not be moved by it
        await opened.evaluate(() => { (window as Window & MoveLog).moves!.length = 0; });
        const made = await post(opened, "pane/split", { pane_id: PANE, direction: "right" }) as { pane: { pane_id: string } };
        const split = made.pane.pane_id;
        await opened.waitForFunction((ids) => ids.every((id) => document.querySelector(`.pane-frame[data-layout-pane="${CSS.escape(id)}"]:not(.is-hidden)`) !== null), [PANE, split], WAIT);
        await post(opened, "pane/swap", { pane_id: PANE, target_pane_id: split });
        await opened.waitForFunction(({ left, right }) => {
          const x = (id: string) => document.querySelector(`.pane-frame[data-layout-pane="${CSS.escape(id)}"]`)?.getBoundingClientRect().left ?? Number.NaN;
          return x(left) < x(right);
        }, { left: split, right: PANE }, WAIT);
        assert.deepEqual(await drawnOrder(opened), { dom: [split, PANE], visual: [split, PANE] }, `${face}: after a swap the drawn frames follow the panes left to right`);
        const swapped = await moves(opened) ?? [];
        assert.deepEqual(swapped.filter((id) => id !== PANE && id !== split), [], `${face}: the split and the swap move no frame of another tab (moved: ${swapped.join(", ")})`);
        console.log(`PASS ${face}: a swap reorders the drawn frames to the layout`);
      }
    } finally { await context.close(); }
  }
});
