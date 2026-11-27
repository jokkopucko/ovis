import assert from "node:assert/strict";
import type { Locator, Page } from "playwright-core";

import panes from "../site/demo/fixtures/panes.json";
import { appFaces } from "./app-faces.ts";
import { withDemoBrowser } from "./demo-browser.ts";
import { openLens } from "./header-lens.ts";

const scrollerSelector = ".pane-frame.is-current .chat-view[data-chat-virtual]";
const transcript = (page: Page) => page.locator(scrollerSelector);
const workspace = (page: Page, pane: string) => page.locator(`[data-workspace="${pane.split(":")[0]}"] > .workspace-header .workspace-select`);
const activePane = (page: Page, pane: string) => page.locator(`.pane-frame.is-current[data-layout-pane="${pane}"]`);

function readingPlace(node: HTMLElement) {
  const { top, bottom } = node.getBoundingClientRect();
  const row = [...node.querySelectorAll<HTMLElement>("[data-chat-row]")]
    .map((item) => ({ rect: item.getBoundingClientRect(), text: item.textContent?.match(/Reading row \d+/)?.[0] }))
    .filter((item) => item.rect.bottom > top && item.rect.top < bottom)
    .sort((a, b) => a.rect.top - b.rect.top)[0];
  return {
    row: row?.text ?? null,
    offset: row === undefined ? 0 : row.rect.top - top,
    top: node.scrollTop,
    gap: node.scrollHeight - node.clientHeight - node.scrollTop,
  };
}

async function atEnd(chat: Locator): Promise<void> {
  await chat.evaluate((node) => {
    return new Promise<void>((resolve, reject) => {
      const deadline = performance.now() + 5000;
      const check = () => {
        if (node.scrollHeight > node.clientHeight + 400 && node.scrollHeight - node.clientHeight - node.scrollTop <= 1) resolve();
        else if (performance.now() > deadline) reject(new Error("Chat did not follow the end"));
        else requestAnimationFrame(check);
      };
      requestAnimationFrame(check);
    });
  });
}

async function wheelTo(page: Page, target: (place: ReturnType<typeof readingPlace>) => number) {
  const chat = transcript(page);
  const before = await chat.evaluate(readingPlace);
  const top = target(before);
  await chat.hover();
  await page.mouse.wheel(0, top - before.top);
  await page.waitForFunction(({ selector, before }) => {
    const node = document.querySelector(selector);
    return node !== null && Math.abs(node.scrollTop - before) > 100;
  }, { selector: scrollerSelector, before: before.top });
  await chat.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  const place = await chat.evaluate(readingPlace);
  assert.ok(place.row !== null && place.top > 400 && place.gap > 400, JSON.stringify(place));
  return place;
}

const readUp = (page: Page, distance: number) => wheelTo(page, (place) => place.top - distance);

async function expectSamePlace(chat: Locator, before: ReturnType<typeof readingPlace>, label: string): Promise<void> {
  const deadline = performance.now() + 4000;
  for (let stable = 0; performance.now() < deadline;) {
    const after = await chat.evaluate(readingPlace);
    if (after.row === before.row && Math.abs(after.offset - before.offset) <= 2) {
      if (++stable === 12) return;
    } else stable = 0;
    await chat.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
  }
  assert.fail(`${label}: ${JSON.stringify(before)} -> ${JSON.stringify(await chat.evaluate(readingPlace))}`);
}

const fixture = `<script>(() => {
  const demo = window.fetch;
  const panels = ${JSON.stringify([panes.api, panes.hermes, panes.web])};
  const short = ${JSON.stringify(panes.web)};
  window.olderReads = 0;
  const turns = Array.from({ length: 108 }, (_, i) => ({
    role: i % 2 === 0 ? "user" : "assistant",
    ts: new Date(Date.UTC(2026, 9, 12, 0, i)).toISOString(),
    ...(i % 2 === 0 ? {} : { end_ts: new Date(Date.UTC(2026, 9, 12, 0, i, 1)).toISOString() }),
    parts: [{ kind: "text", ...(i % 2 === 0 ? {} : { phase: "final_answer" }),
      text: "Reading row " + i + ". " + "Each message has a few lines so the transcript needs a browser scroll. ".repeat(3 + i % 5) }],
  }));
  window.fetch = (input, init) => {
    const url = new URL(typeof input === "string" ? input : input.url, location.href);
    const pane = url.searchParams.get("pane_id");
    if (url.pathname === "/api/pane/prompt" && pane === panels[0] && sessionStorage.getItem("fixture:outcome") !== null) {
      // the prompt state, and with it the outcome rows, answers well after the transcript
      const at = new Date(Date.UTC(2026, 9, 12, 0, 85, 30)).toISOString();
      const outcome = { id: "fixture-outcome", pane_id: pane, text: "/fixture-outcome", state: "accepted", evidence: [], created_at: at, updated_at: at };
      return new Promise((resolve) => setTimeout(() => resolve(Response.json({ prompt: null, outcomes: [outcome] })), 1500));
    }
    if (url.pathname !== "/api/pane/conversation" || !panels.includes(pane)) return demo(input, init);
    const before = url.searchParams.get("before");
    if (before !== null) window.olderReads += 1;
    if (pane === short) return Promise.resolve(Response.json({ source: "codex-transcript", history_id: pane, turns: turns.slice(0, 6), cursor: null }));
    if (before !== null && sessionStorage.getItem("fixture:fail-older-read") !== null) {
      sessionStorage.removeItem("fixture:fail-older-read");
      return Promise.resolve(Response.json({ error: { code: "internal", message: "Could not read earlier messages" } }, { status: 500 }));
    }
    const end = before === null ? turns.length : Number(before);
    const start = Number(url.searchParams.get("from") ?? Math.max(0, end - 36));
    return Promise.resolve(Response.json({ source: "codex-transcript", history_id: pane, turns: turns.slice(start, end), cursor: start === 0 ? null : String(start) }));
  };
})();</script>`;

await withDemoBrowser({ tempPrefix: "ovis-chat-reading-position-", afterTransport: `\n${fixture}` }, async ({ newContext, baseUrl }) => {
  const context = await newContext({ viewport: { width: 1280, height: 800 }, reducedMotion: "reduce" });
  await context.addInitScript(() => {
    localStorage.setItem("ovis:settings", JSON.stringify({ language: "en", defaultView: "chat", alertsOn: false }));
  });
  const scenarios = ["tab", "workspace", "older", "following", "vanished", "outcome", "fits"] as const;
  const failures: unknown[] = [];
  for (const scenario of scenarios) {
    const page = await context.newPage();
    page.setDefaultTimeout(6000);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    try {
      if (scenario === "vanished" || scenario === "outcome") {
        // a place kept from an earlier visit, as chatScrollMemory.ts stores it: a turn row that is no longer
        // there although its time is inside the newest page, or an outcome row the prompt state draws late
        const turn = scenario === "outcome" ? "outcome|fixture-outcome"
          : `user|${new Date(Date.UTC(2026, 9, 12, 0, 90)).toISOString()}|text|Reading row 90, as it read before it was rewritten`;
        await page.addInitScript(({ pane, turn, outcome }) => {
          if (sessionStorage.getItem("fixture:placed") !== null) return;
          sessionStorage.setItem("fixture:placed", "1");
          if (outcome) sessionStorage.setItem("fixture:outcome", "1");
          sessionStorage.setItem("ovis:chat-positions", JSON.stringify([[pane, { historyId: pane, turn, offset: 0, atEnd: false }]]));
        }, { pane: panes.api, turn, outcome: scenario === "outcome" });
      }
      await page.goto(`${baseUrl}?pane=${encodeURIComponent(panes.api)}&view=chat`);
      await page.locator(".conn-live").waitFor();
      await appFaces(page);
      const chat = transcript(page);
      if (scenario === "outcome") {
        await page.waitForFunction((selector) => {
          const node = document.querySelector(selector);
          const row = node?.querySelector<HTMLElement>(`[data-chat-row="outcome:fixture-outcome"]`);
          if (!node || !row) return false;
          return Math.abs(row.getBoundingClientRect().top - node.getBoundingClientRect().top) <= 2;
        }, scrollerSelector);
        assert.equal(await page.evaluate(() => (window as Window & { olderReads?: number }).olderReads), 0, "no earlier page is read while the outcome rows are still on their way");
        assert.deepEqual(errors, []);
        console.log(`PASS chat reading position: ${scenario}`);
        continue;
      }
      await atEnd(chat);
      if (scenario === "vanished") {
        assert.equal(await page.evaluate(() => (window as Window & { olderReads?: number }).olderReads), 0, "a kept row that is gone from the loaded range reads no earlier page");
      } else if (scenario === "fits") {
        const fits = async () => chat.evaluate((node) => new Promise<void>((resolve, reject) => {
          const deadline = performance.now() + 5000;
          const check = () => {
            if (node.scrollHeight > node.clientHeight && node.scrollHeight - node.clientHeight - node.scrollTop <= 1) resolve();
            else if (performance.now() > deadline) reject(new Error(`Chat is not at its end: ${node.scrollTop} / ${node.scrollHeight - node.clientHeight}`));
            else requestAnimationFrame(check);
          };
          requestAnimationFrame(check);
        }));
        await workspace(page, panes.web).click();
        await activePane(page, panes.web).waitFor();
        await page.waitForFunction((selector) => { const node = document.querySelector(selector); return node !== null && node.scrollHeight > node.clientHeight + 100; }, scrollerSelector);
        await fits();
        await chat.hover();
        await page.mouse.wheel(0, -5000);
        await page.waitForFunction((selector) => (document.querySelector(selector)?.scrollTop ?? 1) === 0, scrollerSelector);
        await chat.evaluate(() => new Promise<void>((resolve) => setTimeout(resolve, 400)));
        // the whole transcript fits a taller window: the chat is at its end without a scroll
        await page.setViewportSize({ width: 1280, height: 1600 });
        await page.waitForFunction((selector) => { const node = document.querySelector(selector); return node !== null && node.scrollHeight <= node.clientHeight; }, scrollerSelector);
        await chat.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
        await workspace(page, panes.api).click();
        await activePane(page, panes.api).waitFor();
        await page.setViewportSize({ width: 1280, height: 800 });
        await workspace(page, panes.web).click();
        await activePane(page, panes.web).waitFor();
        await fits();
      } else if (scenario === "older") {
        const earlier = chat.getByRole("button", { name: "Earlier messages", exact: true });
        const height = await chat.evaluate((node) => node.scrollHeight);
        // pressed from the keyboard where it is: a click scrolls the button to the top first, and the top
        // reads an earlier page by itself, so the click would race a second read
        await earlier.evaluate((button) => button.focus({ preventScroll: true }));
        await page.keyboard.press("Enter");
        const pagesRead = (reads: number, grown: number) => page.waitForFunction(({ selector, height, reads, grown }) =>
          (window as Window & { olderReads?: number }).olderReads === reads && (document.querySelector(selector)?.scrollHeight ?? 0) > height + grown,
        { selector: scrollerSelector, height, reads, grown });
        await pagesRead(1, 1500);
        await chat.hover();
        await page.mouse.wheel(0, -height * 3);
        await pagesRead(2, 6500);
        const place = await wheelTo(page, (place) => Math.floor((place.top + place.gap) / 4));
        assert.ok(Number(place.row?.split(" ").at(-1)) < 36, "reader is in the second earlier page");
        await workspace(page, panes.hermes).click();
        await activePane(page, panes.hermes).waitFor();
        await workspace(page, panes.api).click();
        await activePane(page, panes.api).waitFor();
        await expectSamePlace(chat, place, "workspace round trip in older history");
        await openLens(page, "terminal");
        await chat.waitFor({ state: "detached" });
        await openLens(page, "chat");
        await expectSamePlace(chat, place, "Chat → Terminal → Chat in older history");
        await page.reload();
        await appFaces(page);
        await expectSamePlace(chat, place, "reload while reading older history");
        await openLens(page, "terminal");
        await chat.waitFor({ state: "detached" });
        await page.evaluate(() => sessionStorage.setItem("fixture:fail-older-read", "1"));
        await openLens(page, "chat");
        await chat.getByRole("button", { name: "Couldn't load earlier messages — retry", exact: true }).press("Space");
        await expectSamePlace(chat, place, "keyboard retry after an older page fails");
        await page.getByRole("button", { name: "Jump to latest", exact: true }).click();
        await atEnd(chat);
      } else if (scenario === "workspace") {
        const first = await readUp(page, 1800);
        await workspace(page, panes.hermes).click();
        await activePane(page, panes.hermes).waitFor();
        await atEnd(chat);
        const second = await readUp(page, 2100);
        const retained = await chat.evaluateHandle((node) => node);
        await workspace(page, panes.api).click();
        await activePane(page, panes.api).waitFor();
        assert.ok(await retained.evaluate((node) => node.isConnected && node.closest(".pane-frame")?.classList.contains("is-hidden")), "the other pane's chat remains mounted while hidden");
        await retained.dispose();
        await expectSamePlace(chat, first, "workspace A → B → A");
        await workspace(page, panes.hermes).click();
        await activePane(page, panes.hermes).waitFor();
        await expectSamePlace(chat, second, "workspace B → A → B");
      } else {
        const place = scenario === "tab" ? await readUp(page, 2000) : null;
        await page.getByRole("tab", { name: /release/i }).click();
        await activePane(page, panes.shell).waitFor();
        await page.locator(`[role="tab"][data-tab-id="${panes.api.split(":")[0]}:t1"]`).click();
        await activePane(page, panes.api).waitFor();
        if (place === null) {
          await atEnd(chat);
          await openLens(page, "terminal");
          await chat.waitFor({ state: "detached" });
          await openLens(page, "chat");
          await atEnd(chat);
        }
        else await expectSamePlace(chat, place, "tab round trip");
      }
      assert.deepEqual(errors, []);
      console.log(`PASS chat reading position: ${scenario}`);
    } catch (cause) {
      failures.push(cause);
      console.error(`FAIL chat reading position: ${scenario}`, cause);
    } finally { await page.close(); }
  }
  assert.equal(failures.length, 0, "browser regression failures");
});
