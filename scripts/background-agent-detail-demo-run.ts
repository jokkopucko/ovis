import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type BrowserContext, type Page } from "playwright-core";
import panes from "../site/demo/fixtures/panes.json";
import { buildDemoApp } from "./demo-build.ts";
import { chromePath } from "./chrome-path.ts";

// A running Claude subagent's detail, opened from the background-task list of the demo's
// flaky-retry pane: the sheet opens from the row and closes on Escape, the scrim, a phone's Back,
// with the focus back on the row; Refresh reads again; an answer to a read since closed or moved
// away from is dropped; a command's row and an older bridge's rows say so instead of showing an
// empty transcript; the sheet stays on the screen however long the transcript. The demo answers
// every read; a patch in the page, for this script only, holds a read until released, strips the
// bridge's `detail_kind` for the older-bridge case and answers the error cases the server would.
// All files and HTTP traffic stay in this disposable, loopback-only app; no herdr session is opened.
const app = mkdtempSync(join(tmpdir(), "herdr-background-agent-demo-"));
const evidence = process.env.UI_EVIDENCE_DIR || "";
if (evidence) mkdirSync(evidence, { recursive: true });

interface Case { kind?: string; strip?: boolean; role?: "watch" }
interface Log { requests: string[]; delivered: number; frames: string[]; reads?: number }
declare global { interface Window { bgCase: Case; bgLog: Log; bgRelease?: () => void; bgHold?: boolean } }

const patch = `(() => {
  const demoFetch = window.fetch.bind(window);
  const log = { requests: [], delivered: 0, frames: [] };
  window.bgLog = log;
  window.bgCase = window.bgCase || {};
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const fail = (code, message, status) => json({ error: { code, message } }, status);
  window.fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, location.href);
    const method = (init?.method ?? "GET").toUpperCase();
    log.requests.push(method + " " + url.pathname);
    const c = window.bgCase;
    if (c.role === "watch" && url.pathname.endsWith("/api/health")) {
      const body = await (await demoFetch(input, init)).json();
      return json({ ...body, auth: { required: true, authenticated: true, role: "watch" } });
    }
    if (c.strip && url.pathname.endsWith("/api/pane/omo-tasks")) {
      const body = await (await demoFetch(input, init)).json();
      for (const task of body.tasks) delete task.detail_kind;
      return json(body);
    }
    if (!url.pathname.endsWith("/api/pane/background-agent")) return demoFetch(input, init);
    const kind = c.kind ?? "demo";
    log.reads = (log.reads ?? 0) + 1;
    const respond = async () => {
      // a read the PC failed for a reason of its own; on refresh-error the first read answers and the next ones fail
      if (kind === "error" || (kind === "refresh-error" && log.reads > 1)) return fail("internal", "the read failed", 500);
      // the pane moved to another session after the first read: told so, or answered with the other session's agent of the same id
      if (kind === "refresh-changed" && log.reads > 1) return fail("background_target_changed", "the pane no longer runs the session the agent belongs to", 409);
      if (kind === "session-swap" && log.reads > 1) {
        const base = await (await demoFetch(input, init)).json();
        return json({ ...base, session_id: "demo-session-other", title: "Another session's agent", prompt: "another session's prompt", events: [{ kind: "text", text: "another session's words", at: null }] });
      }
      if (kind === "older") return fail("not_found", "not found", 404);
      if (kind === "unsupported") return fail("background_detail_unsupported", "details can be read for a Claude Code subagent only", 501);
      if (kind === "missing") return fail("background_agent_not_found", "no such subagent in the pane's session", 404);
      if (kind === "changed") return fail("background_target_changed", "the pane no longer runs the session the agent belongs to", 409);
      if (kind === "offline") return fail("machine_offline", "This PC is disconnected", 503);
      if (kind === "unavailable") return fail("background_store_unavailable", "the session's files cannot be read as they are", 503);
      if (kind === "never") return new Promise(() => {});
      const base = await (await demoFetch(input, init)).json();
      if (kind === "empty") return json({ ...base, prompt: null, events: [] });
      if (kind === "cut") return json({ ...base, truncated: true, incomplete: true });
      if (kind === "long") return json({ ...base, events: [...base.events, { kind: "tool", text: "Bash " + JSON.stringify({ command: "bun test " + "test/retry-".repeat(40) + ".test.ts" }), at: null }, { kind: "text", text: "a".repeat(320), at: null }] });
      if (kind === "many") return json({ ...base, truncated: true, events: Array.from({ length: 128 }, (_, index) => index % 3 === 2 ? { kind: "tool", text: 'Read {"file_path":"src/retry-' + index + '.ts"}', at: null } : { kind: "text", text: "Step " + (index + 1) + ": " + base.events[0].text, at: null }) });
      return json(base);
    };
    if (!window.bgHold) return respond();
    // held until the script releases it: the answer then lands after the sheet closed or moved on
    window.bgHold = false;
    // the release exists before the read goes out, so a script that releases as soon as it sees the read out is never lost
    const released = new Promise((resolve) => { window.bgRelease = resolve; });
    const response = await respond();
    const body = await response.json();
    await released;
    if (Array.isArray(body.events)) body.events.push({ kind: "text", text: "stale response", at: null });
    log.delivered += 1;
    return json(body, response.status);
  };
  const send = WebSocket.prototype.send;
  WebSocket.prototype.send = function (data) {
    try { log.frames.push(JSON.parse(String(data)).type); } catch {}
    return send.call(this, data);
  };
})();`;

const results: Array<{ check: string; ok: boolean }> = [];
const pass = (check: string): void => { results.push({ check, ok: true }); console.log(`PASS ${check}`); };

type Theme = "light" | "dark";
interface View { width: 390 | 1440; theme: Theme; language?: "ko" }
const name = ({ width, theme, language }: View, state?: string): string => `background-agent-${width}-${theme}${language ? `-${language}` : ""}${state ? `-${state}` : ""}.png`;
const shot = async (page: Page, view: View, state?: string): Promise<void> => { if (evidence) await page.screenshot({ path: join(evidence, name(view, state)) }); };
/** every animation on the page has ended: a sheet has risen, a scrim has darkened */
const settled = (page: Page): Promise<void> => page.evaluate(() => Promise.all(document.getAnimations().map((animation) => animation.finished.catch(() => undefined))).then(() => undefined));
const log = (page: Page): Promise<Log> => page.evaluate(() => window.bgLog);
const detailReads = async (page: Page): Promise<number> => (await log(page)).requests.filter((request) => request.endsWith("/api/pane/background-agent")).length;
/** what the run measured in the page, for the evidence summary: none of it is judged from pixels */
const fontSizes: Record<string, Record<string, number[]>> = {};
const selection: Record<string, Record<string, boolean | null>> = {};
const geometry: Record<string, Record<string, string>> = {};
const focusTrace: Array<Record<string, unknown>> = [];
const keyTrace: Array<Record<string, unknown>> = [];
const DETAIL_TEXT = [".bg-agent-detail-title", ".bg-agent-detail-meta", ".bg-agent-heading", ".bg-agent-text", ".bg-agent-tool-name", ".bg-agent-tool-args", ".bg-agent-note"];
/** the sheet's reading floors, as the page computes them: on a phone the agent's words and the title at 17 px or more and every other line at 15, on a desktop 14 */
const floors = async (page: Page, view: View): Promise<void> => {
  const sizes = await page.evaluate((selectors) => selectors.map((selector) => [selector, [...document.querySelectorAll(selector)].map((node) => parseFloat(getComputedStyle(node).fontSize))] as [string, number[]]), DETAIL_TEXT);
  const kept = (fontSizes[name(view)] ??= {});
  for (const [selector, values] of sizes) {
    const floor = view.width === 390 ? (selector === ".bg-agent-text" || selector === ".bg-agent-detail-title" ? 17 : 15) : 14;
    assert.ok(values.every((size) => size >= floor), `${name(view)} ${selector}: ${JSON.stringify(values)} px, under ${floor} px`);
    if (values.length > 0) kept[selector] = [...new Set([...(kept[selector] ?? []), ...values])];
  }
};
/** the sheet's labels and words can be selected: a selection of each holds its text */
const selectable = async (page: Page, view: View): Promise<void> => {
  const found = await page.evaluate(() => [".bg-agent-detail-title", ".bg-agent-detail-meta", ".bg-agent-text", ".bg-agent-tool-args"].map((selector): [string, boolean | null] => {
    const node = document.querySelector(selector);
    if (node === null) return [selector, null];
    const range = document.createRange();
    range.selectNodeContents(node);
    const chosen = getSelection()!;
    chosen.removeAllRanges();
    chosen.addRange(range);
    const text = chosen.toString();
    chosen.removeAllRanges();
    return [selector, getComputedStyle(node).userSelect !== "none" && text.trim().length > 0];
  }));
  for (const [selector, ok] of found) assert.equal(ok, true, `${name(view)} ${selector} is selectable`);
  selection[name(view)] = Object.fromEntries(found);
};

export type BackgroundAgentDetailPart = "flow" | "states-desktop" | "states-phone" | "states-korean";
/** the one view whose read states each states part walks */
const STATE_VIEWS: Record<Exclude<BackgroundAgentDetailPart, "flow">, View> = {
  "states-desktop": { width: 1440, theme: "dark" },
  "states-phone": { width: 390, theme: "light" },
  "states-korean": { width: 390, theme: "light", language: "ko" },
};

/**
 * Runs one part of this check. Each part is a browser script of its own, so that the browser
 * lane's workers share the check instead of one of them running all of it: the whole flow in its
 * four views (background-agent-detail-demo-regression.ts), and the states a read can end in, one
 * view to a script (background-agent-states-<desktop|phone|korean>-demo-regression.ts). The states
 * of one view stay in one script: each state's frame is compared with that view's loading one.
 */
export async function runBackgroundAgentDetail(part: BackgroundAgentDetailPart): Promise<void> { try {
  await buildDemoApp(app);
  const index = join(app, "index.html");
  const html = readFileSync(index, "utf8");
  assert.match(html, /<script type="module"/);
  writeFileSync(join(app, "background-agent-patch.js"), patch);
  writeFileSync(index, html.replace(/<script type="module"/, '<script src="./demo-transport.js"></script>\n    <script src="./background-agent-patch.js"></script>\n    <script type="module"'));

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
  const origin = `http://127.0.0.1:${server.port}/herdr-web-ui/demo/app/`;
  try {
    const browser = await chromium.launch({ executablePath: chromePath(), headless: true, args: ["--no-sandbox"] });
    try {
      const open = async (view: View, demo: Case = {}): Promise<{ context: BrowserContext; page: Page; errors: string[] }> => {
        const mobile = view.width === 390;
        const context = await browser.newContext({ viewport: { width: view.width, height: mobile ? 844 : 900 }, deviceScaleFactor: mobile ? 3 : 1, isMobile: mobile, hasTouch: mobile, colorScheme: view.theme, locale: view.language === "ko" ? "ko-KR" : "en-US" });
        // the demo's other Claude pane finishes a few seconds in: its in-app alert is not this surface's
        await context.addInitScript(({ theme, language, demo }) => {
          localStorage.setItem("ovis:settings", JSON.stringify({ language, theme, alertsOn: false }));
          window.bgCase = demo;
        }, { theme: view.theme, language: view.language ?? "en", demo });
        const page = await context.newPage();
        page.setDefaultTimeout(20_000);
        const errors: string[] = [];
        page.on("pageerror", (error) => errors.push(error.message));
        await page.goto(`${origin}?pane=${encodeURIComponent(panes.flaky)}`);
        await page.locator(".conn-live").waitFor();
        return { context, page, errors };
      };
      const list = (page: Page) => page.locator(".bg-tasks-menu");
      const rows = (page: Page) => list(page).locator(".bg-task-list .bg-task-open");
      const dialog = (page: Page) => page.locator(".bg-agent-detail");
      const openList = async (page: Page): Promise<void> => {
        const chip = page.locator(".composer .bg-tasks-toggle");
        await chip.click();
        await rows(page).first().waitFor();
      };
      const openDetail = async (page: Page, row = 0): Promise<void> => {
        await rows(page).nth(row).click();
        await dialog(page).waitFor();
        await settled(page);
      };
      const note = (page: Page, text: string) => dialog(page).locator(".bg-agent-note", { hasText: text });

      // the whole flow, on a desktop and on a phone, in both themes: the captures of the rest states come from here
      for (const view of part === "flow" ? [{ width: 1440, theme: "dark" }, { width: 1440, theme: "light" }, { width: 390, theme: "dark" }, { width: 390, theme: "light" }] as View[] : []) {
        const { context, page, errors } = await open(view);
        try {
          const mobile = view.width === 390;
          await openList(page);
          assert.equal(await rows(page).count(), 2, "both running rows open a detail");
          assert.deepEqual(await rows(page).evaluateAll((nodes) => nodes.map((node) => [node.getAttribute("aria-haspopup"), node.getAttribute("aria-expanded")])), [["dialog", "false"], ["dialog", "false"]]);
          // the fold of what ended is a plain list: nothing there opens
          await list(page).locator(".bg-ended-toggle").click();
          assert.equal(await list(page).locator(".bg-task-list[id] .bg-task-open").count(), 0, "an ended row is no disclosure");
          await list(page).evaluate((node) => { node.scrollTop = node.scrollHeight; });
          await shot(page, view, "list-end");
          await list(page).locator(".bg-ended-toggle").click();
          await list(page).evaluate((node) => { node.scrollTop = 0; });
          if (!mobile) {
            await rows(page).first().hover();
            await shot(page, view, "hover");
            await page.mouse.move(5, 5);
          }
          await shot(page, view, "list");
          // keyboard: Tab from the chip reaches the row, Enter opens it
          await page.locator(".composer .bg-tasks-toggle").focus();
          await page.keyboard.press("Tab");
          assert.equal(await page.evaluate(() => document.activeElement?.classList.contains("bg-task-open")), true, "the first running row is the next tab stop");
          assert.equal(await page.evaluate(() => document.activeElement?.matches(":focus-visible")), true, "the row shows its focus ring");
          await shot(page, view, "focus");
          await page.keyboard.press("Enter");
          await dialog(page).waitFor();
          const opened = await page.evaluate(() => document.activeElement?.getAttribute("aria-label") ?? null);
          await settled(page);
          assert.equal(await rows(page).first().getAttribute("aria-expanded"), "true", "the row says its detail is open");
          assert.equal(await page.evaluate(() => document.querySelector(".bg-agent-detail")?.contains(document.activeElement)), true, "the focus is inside the sheet");
          const heading = dialog(page).locator(".bg-agent-detail-title");
          assert.equal(await heading.textContent(), "Review the retry test for timing assumptions");
          assert.match(await dialog(page).locator(".bg-agent-section").first().locator(".bg-agent-text").textContent() ?? "", /^Review test\/retry\.test\.ts for assumptions about timing/, "the prompt is the dispatch");
          const events = dialog(page).locator(".bg-agent-event");
          assert.equal(await events.count(), 5, "the first read holds five events");
          assert.deepEqual(await dialog(page).locator(".bg-agent-tool-name").allTextContents(), ["Read", "Read", "Grep"]);
          assert.equal(await dialog(page).locator(".bg-agent-tool-args").first().textContent(), '{"file_path":"test/retry.test.ts"}');
          assert.equal(await dialog(page).locator("img, iframe, a[href]").count(), 0, "nothing of the transcript loads or links anywhere");
          await dialog(page).locator('.icon-button[aria-label="Refresh"]:not(:disabled)').waitFor();
          await floors(page, view);
          await shot(page, view, "open");
          // the focus trap: opened while its first read is out, the sheet takes the focus at Close (Refresh rests);
          // Tab walks Refresh, Close and the transcript in reading order and wraps, Shift+Tab wraps back, and the focus never leaves it
          const walk = async (key: string, presses: number): Promise<string[]> => {
            const seen: string[] = [];
            for (let press = 0; press < presses; press++) {
              await page.keyboard.press(key);
              seen.push(await page.evaluate(() => {
                const active = document.activeElement;
                if (!document.querySelector(".bg-agent-detail")?.contains(active)) return `outside:${active?.tagName ?? "none"}`;
                return active?.getAttribute("aria-label") ?? (active?.classList.contains("bg-agent-detail-body") ? "transcript" : active?.tagName ?? "none");
              }));
            }
            return seen;
          };
          assert.equal(opened, "Close details", "the sheet takes the focus at Close while Refresh rests");
          const forward = await walk("Tab", 4);
          assert.deepEqual(forward, ["transcript", "Refresh", "Close details", "transcript"], "Tab walks the sheet in order and wraps");
          const backward = await walk("Shift+Tab", 3);
          assert.deepEqual(backward, ["Close details", "Refresh", "transcript"], "Shift+Tab walks back and wraps");
          focusTrace.push({ view: name(view), initial: opened, tab: forward, shiftTab: backward });
          await dialog(page).getByRole("button", { name: "Close details", exact: true }).focus();
          assert.equal(await page.evaluate(() => document.activeElement?.matches(":focus-visible")), true, "Close shows its focus ring");
          await shot(page, view, "detail-focus");
          // the labels worth copying are selectable, a phone's sheet title and agent line included; after the walk, as a selection moves where Tab starts
          await selectable(page, view);
          pass(`${view.width}px ${view.theme}: the focus is trapped in the sheet, in reading order`);
          const geometry = await page.evaluate(() => {
            const modal = document.querySelector<HTMLElement>(".bg-agent-detail")!.getBoundingClientRect();
            const body = document.querySelector<HTMLElement>(".bg-agent-detail-body")!;
            return { bottom: modal.bottom, top: modal.top, right: modal.right, left: modal.left, viewportH: innerHeight, viewportW: innerWidth, docW: document.documentElement.scrollWidth, bodyScrolls: body.scrollHeight > body.clientHeight + 1, bodyWider: body.scrollWidth > body.clientWidth + 1 };
          });
          assert.ok(geometry.bottom <= geometry.viewportH + 0.5 && geometry.top >= -0.5 && geometry.left >= -0.5 && geometry.right <= geometry.viewportW + 0.5, `the sheet is on the screen: ${JSON.stringify(geometry)}`);
          assert.ok(geometry.docW <= geometry.viewportW && !geometry.bodyWider, `nothing scrolls sideways: ${JSON.stringify(geometry)}`);
          // a touch target on a phone: the row, Refresh and Close are at least 44pt tall
          if (mobile) {
            const heights = await page.evaluate(() => [...document.querySelectorAll<HTMLElement>(".bg-agent-detail-header .icon-button, .bg-task-open")].map((node) => node.getBoundingClientRect().height));
            assert.ok(heights.every((height) => height >= 44), `44pt targets: ${JSON.stringify(heights)}`);
          }
          // Refresh reads again: the agent wrote one more record meanwhile, and the button rests while the read is out
          await page.evaluate(() => { window.bgHold = true; });
          const refresh = dialog(page).getByRole("button", { name: "Refresh", exact: true });
          await refresh.click();
          await dialog(page).locator('.icon-button[aria-label="Refresh"]:disabled').waitFor();
          assert.equal(await events.count(), 5, "the content stays while the read is out");
          await shot(page, view, "refreshing");
          await page.evaluate(() => window.bgRelease?.());
          await events.nth(6).waitFor();
          assert.equal(await events.count(), 7, "the second read holds the new record, and the held read's marker");
          assert.match(await events.nth(5).textContent() ?? "", /^The jitter comes from Math\.random/, "the new record is the agent's next words");
          await dialog(page).locator('.icon-button[aria-label="Refresh"]:not(:disabled)').waitFor();
          assert.equal(await dialog(page).locator(".bg-agent-note").count(), 0, "a whole read has no note");
          // Escape closes the sheet, the list stays, the row has the focus again
          await page.keyboard.press("Escape");
          await dialog(page).waitFor({ state: "detached" });
          assert.equal(await list(page).isVisible(), true, "the list stays open under the sheet");
          assert.equal(await page.evaluate(() => document.activeElement?.classList.contains("bg-task-open") && document.activeElement.getAttribute("aria-expanded")), "false", "the focus is back on the row, which is closed");
          keyTrace.push({ view: name(view), key: "Escape", sheetClosed: true, listOpen: true, focus: "the row that opened it" });
          pass(`${view.width}px ${view.theme}: open, read, refresh, Escape, focus return`);
          if (mobile) {
            // a phone's Back closes the sheet as Escape does, and only the sheet
            await openDetail(page);
            await page.goBack();
            await dialog(page).waitFor({ state: "detached" });
            assert.equal(await list(page).isVisible(), true, "Back closed the sheet and left the list");
            assert.equal(await page.evaluate(() => document.activeElement?.classList.contains("bg-task-open")), true, "the focus is back on the row after Back");
            assert.equal(await page.evaluate(() => new URL(location.href).searchParams.get("pane")), panes.flaky, "Back left the pane alone");
            keyTrace.push({ view: name(view), key: "Back", sheetClosed: true, listOpen: true, focus: "the row that opened it", pane: "unchanged" });
            pass(`${view.width}px ${view.theme}: a phone's Back closes the sheet and returns the focus`);
          } else {
            // the scrim closes it too
            await openDetail(page);
            await page.mouse.click(40, 450);
            await dialog(page).waitFor({ state: "detached" });
            assert.equal(await list(page).isVisible(), true, "a press on the scrim closes the sheet alone");
          }
          // the command's row: this PC reads no transcript of it, and asks for none
          const before = await detailReads(page);
          await openDetail(page, 1);
          await note(page, "This PC can't show details for this task").waitFor();
          await dialog(page).locator(".bg-agent-note-line", { hasText: "Only a running Claude Code or OpenCode subagent's work can be opened here." }).waitFor();
          assert.equal(await dialog(page).locator(".bg-agent-section").count(), 0, "no empty transcript stands in for the command's");
          assert.equal(await dialog(page).getByRole("button", { name: "Refresh", exact: true }).count(), 0, "nothing to read again");
          assert.equal(await detailReads(page), before, "a command's row asks the PC for nothing");
          await shot(page, view, "unsupported");
          await page.keyboard.press("Escape");
          await dialog(page).waitFor({ state: "detached" });
          pass(`${view.width}px ${view.theme}: a command's row says details are unsupported`);
          // an answer that lands after the sheet closed is dropped; so is one that lands after the pane changed
          await page.evaluate(() => { window.bgHold = true; });
          await openDetail(page);
          await page.keyboard.press("Escape");
          await dialog(page).waitFor({ state: "detached" });
          await openDetail(page);
          // the reopened sheet's own read (not held: the first one took the hold) has landed, so the count is the sheet's
          await dialog(page).locator('.icon-button[aria-label="Refresh"]:not(:disabled)').waitFor();
          const fresh = await events.count();
          await page.evaluate(() => window.bgRelease?.());
          await page.waitForFunction(() => window.bgLog.delivered >= 2);
          assert.equal(await events.count(), fresh, "the held answer changed nothing in the sheet opened after it");
          assert.equal(await dialog(page).getByText("stale response").count(), 0, "the held answer's marker is nowhere");
          await page.keyboard.press("Escape");
          await dialog(page).waitFor({ state: "detached" });
          if (!mobile) {
            // a Back to the pane before, under the open sheet (a desktop's Back is the panes'): the read's answer opens nothing there
            const select = async (pane: string): Promise<void> => {
              await page.locator(`.agents-sidebar .agent-item[data-pane="${pane}"] .agent-select`).click();
              await page.waitForFunction((pane) => new URL(location.href).searchParams.get("pane") === pane, pane);
            };
            // the demo's Claude panes have ended by now, and an ended agent rests folded under the one-line list's
            // "+N resting" line: open it, as a reader would, so both rows can be picked
            const resting = page.locator(".agents-sidebar .agent-resting-label .agent-background-toggle");
            if (await resting.getAttribute("aria-expanded") === "false") await resting.click();
            assert.equal(await resting.getAttribute("aria-expanded"), "true", "the resting line opens");
            await select(panes.api);
            await select(panes.flaky);
            await openList(page);
            await page.evaluate(() => { window.bgHold = true; });
            await openDetail(page);
            await page.goBack();
            await page.waitForFunction((pane) => new URL(location.href).searchParams.get("pane") === pane, panes.api);
            await dialog(page).waitFor({ state: "detached" });
            await page.evaluate(() => window.bgRelease?.());
            await page.waitForFunction(() => window.bgLog.delivered >= 3);
            assert.equal(await dialog(page).count(), 0, "the answer to the pane left behind opens nothing");
            assert.equal(await page.getByText("stale response").count(), 0);
          }
          pass(`${view.width}px ${view.theme}: late answers to a closed sheet and a left pane are dropped`);
          // nothing of this is an action: no POST, no input, no focus, no stop
          const seen = await log(page);
          // the app's own bookkeeping (a finish seen here, a connection breadcrumb) is the one thing it writes
          assert.deepEqual(seen.requests.filter((request) => !request.startsWith("GET ") && !request.startsWith("HEAD ") && !/^POST \/api\/(seen|connection-diagnostics)$/.test(request)), [], "only reads went out");
          assert.deepEqual(seen.requests.filter((request) => /\/api\/pane\/(input|keys|focus|close|clear|stop|prompt\/answer)$/.test(request)), [], "no pane action went out");
          assert.deepEqual(seen.frames.filter((frame) => ["input", "keys", "submit", "resize", "focus", "take-over"].includes(frame)), [], "no input or control frame went out");
          assert.deepEqual(errors, []);
        } finally { await context.close(); }
      }

      // the states a read can end in, on a desktop dark and a phone light; the phone's Korean copy of each changed string.
      // Each failure says what happened and what to do next; the sheet's frame and its buttons stand where they stood while loading
      const NEXT = {
        empty: "The agent may still be starting. Try Refresh in a moment.",
        cut: "The middle part is left out.",
        missing: "It may have ended. Close this and look at the task list again.",
        changed: "Close this and open the task again from the list.",
        offline: "Refresh once the PC is connected again.",
        unavailable: "Try Refresh in a moment.",
        update: "Update this PC's bridge to see what a running agent is doing.",
        error: "Try Refresh. If it keeps failing, restart Ovis on the PC.",
      } as const;
      const states: Array<[string, Case, string | null, string | null]> = [
        ["loading", { kind: "never" }, "Loading…", null],
        ["empty", { kind: "empty" }, "Nothing recorded yet", NEXT.empty],
        ["truncated", { kind: "cut" }, "The agent wrote more than this view reads.", NEXT.cut],
        ["missing", { kind: "missing" }, "The agent is no longer in this pane's session", NEXT.missing],
        ["changed", { kind: "changed" }, "The pane moved to another session", NEXT.changed],
        ["offline", { kind: "offline" }, "This PC is disconnected", NEXT.offline],
        ["unavailable", { kind: "unavailable" }, "The agent's files can't be read right now", NEXT.unavailable],
        ["older", { kind: "older" }, "This PC's bridge does not offer this yet", NEXT.update],
        ["older-rows", { strip: true }, "This PC's bridge does not offer this yet", NEXT.update],
        ["long", { kind: "long" }, null, null],
        ["many", { kind: "many" }, "The agent wrote more than this view reads.", NEXT.cut],
        ["observe", { role: "watch" }, null, null],
        ["error", { kind: "error" }, "Couldn't read the agent's details", NEXT.error],
        ["refresh-error", { kind: "refresh-error" }, "Couldn't read the agent's details", NEXT.error],
        ["refresh-changed", { kind: "refresh-changed" }, "The pane moved to another session", NEXT.changed],
        ["session-swap", { kind: "session-swap" }, "The pane moved to another session", NEXT.changed],
      ];
      const korean: Record<string, string> = {
        "Loading…": "불러오는 중…", "Nothing recorded yet": "아직 기록된 내용이 없습니다",
        "The agent wrote more than this view reads.": "에이전트가 쓴 내용이 이 보기에서 읽는 양보다 많습니다.",
        "The middle part is left out.": "중간 부분은 빠졌습니다.",
        "The agent is no longer in this pane's session": "이 에이전트는 더 이상 이 패널의 세션에 없습니다", "The pane moved to another session": "패널이 다른 세션으로 옮겨갔습니다",
        "This PC is disconnected": "이 PC와의 연결이 끊겼습니다", "The agent's files can't be read right now": "지금은 에이전트의 파일을 읽을\u00a0수\u00a0없습니다",
        "This PC's bridge does not offer this yet": "이 PC의 브리지는 아직 이 기능을 제공하지 않습니다.",
        "Couldn't read the agent's details": "에이전트의 자세한 내용을 읽지 못했습니다",
        [NEXT.empty]: "에이전트가 아직 시작하는 중일\u00a0수\u00a0있습니다. 잠시\u00a0후\u00a0새로\u00a0고쳐\u00a0보세요.",
        [NEXT.missing]: "이미 끝났을\u00a0수\u00a0있습니다. 이\u00a0창을\u00a0닫고 작업\u00a0목록을\u00a0다시\u00a0확인하세요.",
        [NEXT.changed]: "이 창을 닫고 목록에서 작업을 다시 여세요.",
        [NEXT.offline]: "PC가 다시 연결되면 새로 고치세요.",
        [NEXT.unavailable]: "잠시 후 새로 고쳐 보세요.",
        [NEXT.update]: "실행 중인 에이전트의 작업을 보려면 이\u00a0PC의\u00a0브리지를\u00a0업데이트하세요.",
        [NEXT.error]: "새로\u00a0고쳐\u00a0보세요. 계속 실패하면 PC에서 Ovis를\u00a0다시\u00a0시작하세요.",
      };
      const say = (view: View, text: string): string => view.language === "ko" ? korean[text] ?? text : text;
      for (const view of part === "flow" ? [] : [STATE_VIEWS[part]]) {
        const frames: Record<string, string> = {};
        for (const [state, demo, text, next] of states) {
          const { context, page, errors } = await open(view, demo);
          try {
            await openList(page);
            const before = await detailReads(page);
            await openDetail(page);
            const refreshed = state === "refresh-error" || state === "refresh-changed" || state === "session-swap";
            if (refreshed) {
              // the first read lands, then Refresh fails or answers for another session
              await dialog(page).locator(".bg-agent-section").first().waitFor();
              await dialog(page).locator(".bg-agent-detail-header .icon-button").first().click();
            }
            if (text !== null) await note(page, say(view, text)).waitFor();
            // what to do next, on a line of its own under what happened
            if (next !== null) await dialog(page).locator(".bg-agent-note-line", { hasText: say(view, next) }).waitFor();
            if (state === "refresh-error") {
              await note(page, view.language === "ko" ? "새로 고치지 못했습니다. 마지막으로\u00a0읽은\u00a0내용입니다" : "Couldn't refresh: this is what it last read").waitFor();
              assert.equal(await dialog(page).locator(".bg-agent-section").count(), 2, "refresh-error: the content as it last read stays");
            }
            if (state === "refresh-changed" || state === "session-swap") {
              // the sheet showed the first session's agent: nothing of it stays, and nothing of the other session's is shown
              assert.equal(await dialog(page).locator(".bg-agent-section").count(), 0, `${state}: the first session's content is gone`);
              assert.equal(await dialog(page).getByText("another session's", { exact: false }).count(), 0, `${state}: the other session's agent is not shown`);
              assert.equal(await dialog(page).locator(".bg-agent-detail-title").textContent(), "Review the retry test for timing assumptions", `${state}: the title is the task's own`);
            }
            if (state === "error") assert.equal(await dialog(page).locator(".bg-agent-section").count(), 0, "error: no transcript stands in for what was not read");
            if (state === "loading") assert.equal(await dialog(page).locator('.icon-button[aria-label="Refresh"]:disabled, .icon-button[aria-label="새로 고침"]:disabled').count(), 1, "Refresh rests while the first read is out");
            if (state === "truncated") await note(page, view.language === "ko" ? "일부 기록은 읽지 못해 빠졌습니다" : "Some records couldn't be read and are left out").waitFor();
            if (state === "older-rows") assert.equal(await detailReads(page), before, "rows without detail_kind ask the PC for nothing");
            if (state === "empty" || state === "missing" || state === "changed" || state === "offline" || state === "unavailable" || state === "older" || state === "older-rows") {
              assert.equal(await dialog(page).locator(".bg-agent-section").count(), 0, `${state}: no transcript stands in for what was not read`);
            }
            await floors(page, view);
            frames[state] = await page.evaluate(() => {
              const box = (node: Element | null | undefined): string => { const rect = node!.getBoundingClientRect(); return [rect.x, rect.y, rect.width, rect.height].map((value) => Math.round(value)).join(","); };
              const sheet = document.querySelector(".bg-agent-detail");
              return `sheet ${box(sheet)} close ${box([...sheet!.querySelectorAll(".bg-agent-detail-header .icon-button")].at(-1))}`;
            });
            if (state === "many") {
              const body = dialog(page).locator(".bg-agent-detail-body");
              assert.equal(await dialog(page).locator(".bg-agent-event").count(), 128, "the cap's worth of events");
              assert.equal(await body.evaluate((node) => node.scrollHeight > node.clientHeight + 1), true, "the body scrolls");
              assert.equal(await page.evaluate(() => document.documentElement.scrollHeight <= innerHeight + 0.5 && document.documentElement.scrollWidth <= innerWidth), true, "the page does not");
              await body.evaluate((node) => { node.scrollTop = node.scrollHeight; });
              await shot(page, view, "detail-end");
            } else {
              const wide = await page.evaluate(() => { const body = document.querySelector<HTMLElement>(".bg-agent-detail-body")!; return body.scrollWidth > body.clientWidth + 1 || document.documentElement.scrollWidth > innerWidth; });
              assert.equal(wide, false, `${state}: nothing scrolls sideways`);
              await shot(page, view, state);
            }
            assert.deepEqual(errors, []);
          } finally { await context.close(); }
        }
        // the frame of every state is the loading one's: nothing moves as a read lands, fails or notes something
        const loading = frames["loading"];
        assert.deepEqual(Object.entries(frames).filter(([, frame]) => frame !== loading), [], `${name(view)}: the sheet and Close stand still across states (${loading})`);
        geometry[name(view)] = frames;
        // the Korean list and open sheet
        if (view.language === "ko") {
          const { context, page } = await open(view);
          try {
            await openList(page);
            await shot(page, view, "list");
            await openDetail(page);
            await dialog(page).getByText("프롬프트", { exact: true }).waitFor();
            await dialog(page).getByText("지금까지의 작업", { exact: true }).waitFor();
            assert.equal(await dialog(page).getByRole("button", { name: "자세한 내용 닫기", exact: true }).count(), 1);
            await shot(page, view, "open");
            await page.keyboard.press("Escape");
            await dialog(page).waitFor({ state: "detached" });
            await openDetail(page, 1);
            await note(page, "이 PC에서는 이 작업을 자세히 볼\u00a0수\u00a0없습니다").waitFor();
            await shot(page, view, "unsupported");
          } finally { await context.close(); }
        }
        pass(`${view.width}px ${view.theme}${view.language === "ko" ? " ko" : ""}: every read state says what it is`);
      }
    } finally { await browser.close(); }
  } finally { server.stop(); }
  // the serial lane hands every script the same evidence folder: each part's summary has a name of its own there
  const script = part === "flow" ? "scripts/background-agent-detail-demo-regression.ts" : `scripts/background-agent-${part}-demo-regression.ts`;
  if (evidence) writeFileSync(join(evidence, `background-agent-detail-${part}-summary.json`), JSON.stringify({ script, ok: results.every((result) => result.ok), results, measured: { fontSizes, selection, geometry, focusTrace, keyTrace } }, null, 2) + "\n");
  console.log(`PASS ${results.length} checks`);
} finally { rmSync(app, { recursive: true, force: true }); } }
