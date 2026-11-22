import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright-core";
import panes from "../site/demo/fixtures/panes.json";
import { appFaces } from "./app-faces.ts";
import { buildDemoApp } from "./demo-build.ts";
import { chromePath } from "./chrome-path.ts";
import type { PlanStep, PlanSummary } from "../shared/protocol.ts";
import { serveDemo } from "./demo-server.ts";

// The plan chip's step in progress (#1040) on the unmodified app over the demo's fixture transport:
// the Claude pane's plan as the demo keeps it, then every state the chip and its list can be in,
// pushed as the server would push them (a pane-status frame on the machine events, the roster and
// the plan answer rewritten alike) in this disposable, loopback-only copy of the demo. No herdr
// session is opened and nothing is typed.
const app = mkdtempSync(join(tmpdir(), "herdr-plan-chip-demo-"));
const evidence = process.env["UI_EVIDENCE_DIR"];
if (evidence) mkdirSync(evidence, { recursive: true });
const PANE = panes.api;
const STEP = "Adding the replay metric";
const LONG = "Verify-the-replay-counter-against-the-idempotency-store-under-concurrent-retries-without-breaking-a-single-line-anywhere";
const KO_STEP = "재시도 응답을 세는 지표를 추가하는 중";
const KO_LONG = "동시재시도에서도멱등저장소와재생카운터가맞는지한줄에서확인하는아주긴한국어단계이름";
const KO_STEPS: PlanStep[] = [
  { id: "1", label: "재생된 요청의 경로를 추적하기", active: null, status: "completed", blocked_by: [], owner: null, started_at: null, ended_at: null },
  { id: "2", label: "멱등 재생 횟수를 세는 지표를 추가하고 기존 요청 지표 옆에 노출하기", active: KO_STEP, status: "in_progress", blocked_by: ["1"], owner: null, started_at: null, ended_at: null },
  { id: "3", label: "지표를 테스트로 덮기", active: null, status: "pending", blocked_by: ["2"], owner: null, started_at: null, ended_at: null },
];
const MANY: PlanStep[] = Array.from({ length: 16 }, (_, index) => ({
  id: String(index + 1), label: `Step ${index + 1}: ${["trace the request", "count the replay", "store the counter", "expose the metric"][index % 4]}`, active: null,
  status: index < 5 ? "completed" : index === 5 ? "in_progress" : "pending", blocked_by: index === 0 ? [] : [String(index)], owner: null, started_at: null, ended_at: null,
}));

interface Capture { file: string; width: number; height: number; theme: string; language: string; state: string }
const captures: Capture[] = [];
const results: Array<Record<string, unknown>> = [];

const hook = `<script>(() => {
  const PANE = ${JSON.stringify(PANE)};
  const sockets = new Set();
  const sources = new Set();
  let last = [];
  // what the page is told of the pane now: undefined leaves the demo's own value
  const about = { plan: undefined, background: undefined, offline: false, answer: undefined };
  const patchPane = (pane) => {
    if (pane.pane_id !== PANE) return;
    if (about.plan !== undefined) { if (about.plan === null) delete pane.plan; else pane.plan = structuredClone(about.plan); }
    if (about.background !== undefined) { if (about.background > 0) pane.background_tasks = about.background; else delete pane.background_tasks; }
  };
  const patchSnapshot = (snapshot) => { if (snapshot) for (const pane of snapshot.panes ?? []) patchPane(pane); return snapshot; };
  const roster = (machines) => machines.map((machine) => {
    const copy = structuredClone(machine);
    if (copy.id === "local" && about.offline) copy.state = "disconnected";
    patchSnapshot(copy.snapshot);
    return copy;
  });
  const tell = (message) => { for (const source of sources) source.tell(message); };
  window.planChip = {
    sockets,
    /** the pane's plan and background count, as a pane-status frame after the roster says the same */
    status(plan, background) {
      about.plan = plan; about.background = background;
      const local = last.find((machine) => machine.id === "local");
      const pane = local?.snapshot?.panes.find((pane) => pane.pane_id === PANE);
      if (!local || !pane) throw new Error("the demo roster has not arrived");
      tell({ type: "machines", machines: roster(last) });
      tell({ type: "machine-message", machine_id: "local", message: { type: "pane-status", pane_id: PANE, agent_status: pane.agent_status, finish_id: pane.finish_id, finish_epoch: local.snapshot.finish_epoch, plan, background_tasks: background } });
    },
    /** the PC gone (its snapshot still cached), or back */
    offline(down) { about.offline = down; tell({ type: "machines", machines: roster(last) }); },
    /** what GET /api/pane/plan answers: undefined the demo's, null no plan, steps, "error" or "hang" */
    answer(value) { about.answer = value; },
    /** the server's word on this connection's role */
    role(mode) { for (const socket of sockets) if (socket.readyState === 1) socket.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ type: "role-ack", mode }) })); },
  };
  const Socket = window.WebSocket;
  const Wrapped = function (...args) { const socket = new Socket(...args); sockets.add(socket); return socket; };
  for (const name of ["CONNECTING", "OPEN", "CLOSING", "CLOSED"]) Object.defineProperty(Wrapped, name, { value: Socket[name] });
  window.WebSocket = Wrapped;
  const Source = window.EventSource;
  window.EventSource = class extends EventTarget {
    constructor(url, options) {
      super(); this.inner = new Source(url, options); this.readyState = 1; sources.add(this);
      this.inner.onmessage = (event) => {
        const message = JSON.parse(event.data);
        if (message.type === "machines") { last = message.machines; message.machines = roster(message.machines); }
        this.tell(message);
      };
      this.inner.onerror = (event) => this.onerror?.(event);
      this.inner.onopen = (event) => this.onopen?.(event);
    }
    tell(message) { this.onmessage?.(new MessageEvent("message", { data: JSON.stringify(message) })); }
    close() { this.inner.close(); this.readyState = 2; sources.delete(this); }
  };
  const demoFetch = window.fetch;
  window.fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, location.href);
    if (url.pathname === "/api/pane/plan" && about.answer !== undefined) {
      if (about.answer === "hang") return new Promise(() => {});
      if (about.answer === "error") return new Response(JSON.stringify({ error: "fixture_failure", message: "fixture plan read failed" }), { status: 500, headers: { "content-type": "application/json" } });
      return new Response(JSON.stringify({ plan: about.answer === null ? null : { steps: about.answer }, server_time: new Date().toISOString() }), { status: 200, headers: { "content-type": "application/json" } });
    }
    const response = await demoFetch(input, init);
    if (url.pathname !== "/api/machines" && url.pathname !== "/api/session") return response;
    const body = await response.json();
    if (Array.isArray(body.machines)) body.machines = roster(body.machines);
    if (body.snapshot) patchSnapshot(body.snapshot);
    return new Response(JSON.stringify(body), { status: response.status, headers: response.headers });
  };
})();</script>`;

/** The demo ends the Claude pane's turn 4500 ms in (and answers a sent message 2400 ms in). Run as a context init script, before
 *  any of the page's own scripts, this holds those timers for good: the transport's completion is registered here and never runs,
 *  so every assertion and capture sees the same working turn. window.planChipHeld lists what was held. */
const holdTurn = () => {
  const held: number[] = [];
  const later = window.setTimeout.bind(window);
  window.setTimeout = ((callback: TimerHandler, ms?: number, ...args: unknown[]) => {
    if (ms === 4500 || ms === 2400) { held.push(ms); return 0; }
    return later(callback, ms, ...args);
  }) as typeof window.setTimeout;
  Object.defineProperty(window, "planChipHeld", { value: held });
};
const turnHeld = async (page: Page, what: string): Promise<void> => {
  const turn = await page.evaluate(() => ({
    held: [...(window as unknown as { planChipHeld: number[] }).planChipHeld],
    finished: document.body.innerText.includes("exposed with the other counters"),
    composer: document.querySelector(".composer-surface") !== null,
    stop: document.querySelector(".composer-controls-right .composer-stop") !== null,
    send: document.querySelector(".composer-controls-right .composer-send") !== null,
  }));
  assert.deepEqual(turn.held, [4500], `${what}: the demo's turn completion was held before it could be scheduled: ${JSON.stringify(turn)}`);
  assert.equal(turn.finished, false, `${what}: the demo's turn has not finished: ${JSON.stringify(turn)}`);
  if (turn.composer) assert.ok(turn.stop && !turn.send, `${what}: the turn is still working (Stop, not Send): ${JSON.stringify(turn)}`);
};

type Hook = { status(plan: PlanSummary | null, background: number): void; offline(down: boolean): void; answer(value: PlanStep[] | null | "error" | "hang" | undefined): void; role(mode: "interact" | "observe"): void };
const hookOf = (page: Page) => ({
  status: (plan: PlanSummary | null, background = 0) => page.evaluate(([plan, background]) => (window as unknown as { planChip: Hook }).planChip.status(plan, background), [plan, background] as const),
  offline: (down: boolean) => page.evaluate((down) => (window as unknown as { planChip: Hook }).planChip.offline(down), down),
  answer: (value: PlanStep[] | null | "error" | "hang" | undefined) => page.evaluate((value) => (window as unknown as { planChip: Hook }).planChip.answer(value), value),
  role: (mode: "interact" | "observe") => page.evaluate((mode) => (window as unknown as { planChip: Hook }).planChip.role(mode), mode),
});

const measure = (page: Page) => page.evaluate(() => {
  const chip = document.querySelector<HTMLElement>(".bg-tasks-toggle");
  const box = (element: Element | null) => { const rect = element?.getBoundingClientRect(); return rect ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height } : null; };
  const inside = (inner: Element | null, outer: Element | null): boolean => {
    const a = inner?.getBoundingClientRect(), b = outer?.getBoundingClientRect();
    return !!a && !!b && a.left >= b.left - 0.5 && a.right <= b.right + 0.5 && a.top >= b.top - 0.5 && a.bottom <= b.bottom + 0.5;
  };
  // the step is a one-line clamp over wrapping text: what it hides is below its line, not past its edge
  const clipped = (element: Element | null): boolean => element !== null && (element.scrollWidth > element.clientWidth || element.scrollHeight > element.clientHeight);
  const drawn = [...document.querySelectorAll<HTMLElement>(".composer-controls-left > *:not(input), .composer-status-meta > *, .composer-status-hint, .composer-controls-right > *")]
    .filter((item) => item.getBoundingClientRect().width > 1.5 && item.getBoundingClientRect().height > 1.5);
  const overlaps: string[] = [];
  for (const [index, one] of drawn.entries()) for (const other of drawn.slice(index + 1)) {
    if (one.contains(other) || other.contains(one)) continue;
    const a = one.getBoundingClientRect(), b = other.getBoundingClientRect();
    if (Math.min(a.right, b.right) - Math.max(a.left, b.left) > 0.5 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 0.5) overlaps.push(`${one.className} | ${other.className}`);
  }
  const plan = chip?.querySelector(".bg-tasks-plan") ?? null;
  const current = chip?.querySelector(".bg-tasks-current") ?? null;
  const count = chip?.querySelector(".bg-tasks-count") ?? null;
  const label = chip?.querySelector(".bg-tasks-label") ?? null;
  return {
    chip: chip && { ...box(chip), idle: chip.classList.contains("is-idle"), name: chip.getAttribute("aria-label"), title: chip.getAttribute("title"), expanded: chip.getAttribute("aria-expanded"), minHeight: parseFloat(getComputedStyle(chip).minHeight), focusVisible: chip.matches(":focus-visible") },
    label: label && { text: label.textContent, drawn: label.getBoundingClientRect().width > 1 },
    plan: plan && { text: plan.textContent, clipped: clipped(plan), inside: inside(plan, chip), height: plan.getBoundingClientRect().height },
    current: current && { text: current.textContent, clipped: clipped(current), inside: inside(current, chip), height: current.getBoundingClientRect().height, width: current.getBoundingClientRect().width },
    count: count && { text: count.textContent, drawn: count.getBoundingClientRect().width > 1, inside: inside(count, chip) },
    card: box(document.querySelector(".composer-surface")), compact: document.querySelector(".composer-surface")?.hasAttribute("data-compact") ?? false,
    model: document.querySelector(".composer-model")?.getBoundingClientRect().width ?? 0,
    overlaps, overflowing: document.documentElement.scrollWidth > window.innerWidth,
    menu: (() => { const menu = document.querySelector<HTMLElement>(".bg-tasks-menu"); return menu && { scrolls: menu.scrollHeight > menu.clientHeight + 1, atEnd: menu.scrollTop + menu.clientHeight >= menu.scrollHeight - 1, steps: [...menu.querySelectorAll(".bg-step .bg-task-title")].map((step) => step.textContent), notes: [...menu.querySelectorAll(".bg-tasks-note")].map((note) => note.textContent) }; })(),
  };
});
type Row = Awaited<ReturnType<typeof measure>>;

const fonts = (page: Page) => page.evaluate(() => {
  const size = (selector: string) => { const element = document.querySelector(selector); return element ? getComputedStyle(element).fontSize : null; };
  return { chip: size(".bg-tasks-toggle"), label: size(".bg-tasks-toggle .bg-tasks-label"), figures: size(".bg-tasks-plan"), current: size(".bg-tasks-current"), count: size(".bg-tasks-count"),
    heading: size(".bg-tasks-menu .menu-heading"), stepTitle: size(".bg-tasks-menu .bg-step .bg-task-title"), stepActive: size(".bg-tasks-menu .bg-step-active"), stepMeta: size(".bg-tasks-menu .bg-step .bg-task-meta"), note: size(".bg-tasks-menu .bg-tasks-note") };
});

const hitBox = (page: Page) => page.evaluate(() => {
  const chip = document.querySelector<HTMLElement>(".bg-tasks-toggle")!;
  const rect = chip.getBoundingClientRect();
  const cx = rect.left + rect.width / 2, cy = rect.top + rect.height / 2;
  const hits = (x: number, y: number) => { const element = document.elementFromPoint(x, y); return element !== null && chip.contains(element); };
  const reach = (dx: number, dy: number) => { let step = 0; while (step < 200 && hits(cx + dx * (step + 0.5), cy + dy * (step + 0.5))) step++; return step; };
  const up = reach(0, -1), down = reach(0, 1), left = reach(-1, 0), right = reach(1, 0);
  return { drawn: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }, hit: { x: cx - left, y: cy - up, width: left + right, height: up + down },
    coarse: matchMedia("(pointer: coarse)").matches, expander: getComputedStyle(chip, "::before").content !== "none" };
});

function oneRow(row: Row, what: string): void {
  assert.ok(row.chip, `${what}: the chip is drawn`);
  assert.ok(row.chip.height <= row.chip.minHeight + 1, `${what}: the chip stays one line: ${JSON.stringify(row.chip)}`);
  assert.ok(row.plan && !row.plan.clipped && row.plan.inside, `${what}: done/total is whole inside the chip: ${JSON.stringify(row.plan)}`);
  if (row.current) {
    assert.ok(row.current.inside && Math.abs(row.current.height - row.plan.height) <= 1, `${what}: the step shares the figures' line: ${JSON.stringify(row.current)}`);
  }
  assert.deepEqual(row.overlaps, [], `${what}: nothing in the row overlaps its neighbour`);
  assert.equal(row.overflowing, false, `${what}: the page does not scroll sideways`);
}

const chipOf = (page: Page) => page.locator(".bg-tasks-toggle");
const menuOf = (page: Page) => page.locator(".bg-tasks-menu");
const shot = async (page: Page, width: number, theme: string, language: string, state: string | null, file?: string): Promise<void> => {
  const name = file ?? `plan-chip-${width}-${theme}${language === "ko" ? "-ko" : ""}${state ? `-${state}` : ""}.png`;
  await turnHeld(page, name);
  if (!evidence) return;
  await page.screenshot({ path: join(evidence, name) });
  const size = page.viewportSize()!;
  captures.push({ file: name, width: size.width, height: size.height, theme, language, state: state ?? "rest" });
};
const focusChip = async (page: Page): Promise<void> => {
  await page.getByRole("textbox", { name: "Message", exact: true }).focus();
  for (let step = 0; step < 8; step++) {
    await page.keyboard.press("Tab");
    if (await page.evaluate(() => document.activeElement?.classList.contains("bg-tasks-toggle"))) return;
  }
  assert.fail("Tab never reached the plan chip");
};
const open = async (page: Page, touch: boolean): Promise<void> => {
  if (touch) await chipOf(page).tap(); else await chipOf(page).click();
  await menuOf(page).waitFor();
};
const close = async (page: Page): Promise<void> => {
  await page.keyboard.press("Escape");
  await menuOf(page).waitFor({ state: "detached" });
};
const rest = (page: Page) => page.evaluate(() => { (document.activeElement as HTMLElement | null)?.blur(); return new Promise((resolve) => requestAnimationFrame(resolve)); });

async function scenario(browser: Browser, width: number, theme: "dark" | "light", language: "en" | "ko", run: (page: Page, touch: boolean) => Promise<void>): Promise<void> {
  const touch = width <= 480;
  const context = await browser.newContext(touch
    ? { viewport: { width, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true, locale: language === "ko" ? "ko-KR" : "en-US", colorScheme: theme }
    : { viewport: { width, height: 900 }, locale: language === "ko" ? "ko-KR" : "en-US", colorScheme: theme });
  try {
    await context.addInitScript(holdTurn);
    await context.addInitScript(([language, theme, pane]) => {
      localStorage.setItem("ovis:settings", JSON.stringify({ language, theme }));
      localStorage.setItem(`ovis:view:${pane}`, "chat");
    }, [language, theme, PANE] as const);
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => { if (message.type() === "error" && message.text().includes("ResizeObserver")) errors.push(message.text()); });
    await page.goto(`${url}&view=chat`);
    await page.locator(".conn-live").waitFor({ state: "attached" });
    await page.locator(".terminal-stack.is-chat").waitFor();
    await chipOf(page).waitFor();
    await appFaces(page);
    await turnHeld(page, "loaded");
    await run(page, touch);
    await turnHeld(page, "finished");
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
}

let url = "";
try {
  await buildDemoApp(app);
  const index = join(app, "index.html");
  const html = readFileSync(index, "utf8");
  assert.match(html, /<script type="module"/);
  writeFileSync(index, html.replace(/<script type="module"/, () => `<script src="./demo-transport.js"></script>\n    ${hook}\n    <script type="module"`));
  const server = serveDemo(app);
  url = `http://127.0.0.1:${server.port}/herdr-web-ui/demo/app/?pane=${encodeURIComponent(PANE)}`;
  try {
    const browser = await chromium.launch({ executablePath: chromePath(), headless: true, args: ["--no-sandbox"] });
    try {
      for (const width of [390, 1440]) for (const theme of ["dark", "light"] as const) await scenario(browser, width, theme, "en", async (page, touch) => {
        const what = `${width}px ${theme}`;
        const hook = hookOf(page);
        let row = await measure(page);
        oneRow(row, what);
        assert.equal(row.current?.text, STEP, `${what}: the step in progress is drawn in the chip`);
        assert.equal(row.plan?.text, "1/3");
        assert.equal(row.chip?.name, `Plan: 1 of 3 done · ${STEP}`, `${what}: the button's name says the whole step`);
        assert.equal(row.chip?.title, row.chip?.name, `${what}: and so does its title`);
        assert.equal(row.compact, touch, `${what}: a phone's card is the compact one`);
        assert.equal(row.label?.drawn, !touch, `${what}: the word Plan is drawn beside a mouse and gives way on a phone`);
        assert.equal(row.count, null, `${what}: no task count without tasks`);
        await shot(page, width, theme, "en", null);
        const target = await hitBox(page);
        if (touch) {
          assert.equal(target.coarse, true, `${what}: a phone is a coarse pointer`);
          assert.ok(target.hit.width >= 44 && target.hit.height >= 44, `${what}: the chip's hit rectangle is at least 44x44: ${JSON.stringify(target)}`);
        }
        results.push({ what, state: "rest", chip: row.chip, current: row.current, plan: row.plan, model: row.model, fonts: await fonts(page), target });
        if (!touch) {
          await chipOf(page).hover();
          await shot(page, width, theme, "en", "hover");
        }
        await focusChip(page);
        row = await measure(page);
        assert.equal(row.chip?.focusVisible, true, `${what}: the chip shows its focus ring from the keyboard`);
        oneRow(row, `${what} focused`);
        await shot(page, width, theme, "en", "focus");
        // pressed: the pointer held on the chip before it lets go (a held touch is cancelled, so the tap below opens it)
        const centre = await chipOf(page).boundingBox();
        assert.ok(centre, `${what}: the chip has a box to press`);
        const point = { x: centre.x + centre.width / 2, y: centre.y + centre.height / 2 };
        const cdp = touch ? await page.context().newCDPSession(page) : null;
        if (cdp) await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [point] });
        else { await page.mouse.move(point.x, point.y); await page.mouse.down(); }
        row = await measure(page);
        oneRow(row, `${what} pressed`);
        await shot(page, width, theme, "en", "pressed");
        if (cdp) { await cdp.send("Input.dispatchTouchEvent", { type: "touchCancel", touchPoints: [] }); await cdp.detach(); }
        if (touch) await open(page, touch); else { await page.mouse.up(); await menuOf(page).waitFor(); }
        await menuOf(page).locator(".bg-step").nth(2).waitFor();
        row = await measure(page);
        assert.equal(row.chip?.expanded, "true");
        assert.deepEqual(row.menu?.steps, ["Trace replayed requests", "Count idempotent replays", "Cover the metric with tests"], `${what}: the list has the demo's three steps`);
        await shot(page, width, theme, "en", "open");
        results.push({ what, state: "open", fonts: await fonts(page) });
        await close(page);
        await hook.answer(MANY);
        await hook.status({ done: 5, total: 16, current: "Step 6: count the replay" }, 0);
        await chipOf(page).filter({ hasText: "5/16" }).waitFor();
        await open(page, touch);
        await menuOf(page).locator(".bg-step").nth(15).waitFor();
        row = await measure(page);
        assert.equal(row.menu?.scrolls, true, `${what}: sixteen steps scroll inside the list`);
        await menuOf(page).evaluate((menu) => { menu.scrollTop = menu.scrollHeight; });
        await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(resolve)));
        row = await measure(page);
        assert.equal(row.menu?.atEnd, true, `${what}: the list scrolled to its end`);
        await shot(page, width, theme, "en", "open-end");
        await close(page);
        await hook.answer(undefined);
        await rest(page);
        await hook.status({ done: 1, total: 3, current: null }, 0);
        await page.waitForFunction(() => document.querySelector(".bg-tasks-current") === null);
        row = await measure(page);
        oneRow(row, `${what} no step`);
        assert.equal(row.current, null);
        assert.equal(row.chip?.name, "Plan: 1 of 3 done", `${what}: no step, no separator in the name`);
        assert.equal(row.chip?.idle, false);
        await shot(page, width, theme, "en", "empty");
        await hook.status({ done: 2, total: 3, current: "Covering the metric with tests" }, 0);
        await chipOf(page).filter({ hasText: "2/3" }).waitFor();
        row = await measure(page);
        oneRow(row, `${what} running`);
        assert.equal(row.current?.text, "Covering the metric with tests");
        assert.equal(row.chip?.name, "Plan: 2 of 3 done · Covering the metric with tests");
        assert.equal(row.chip?.idle, false);
        await shot(page, width, theme, "en", "running");
        results.push({ what, state: "running", chip: row.chip, current: row.current, plan: row.plan });
        await hook.status({ done: 1, total: 3, current: "Test" }, 0);
        await page.waitForFunction(() => document.querySelector(".bg-tasks-current")?.textContent === "Test" && document.querySelector(".bg-tasks-plan")?.textContent === "1/3");
        await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        assert.equal(await page.locator(".composer-model").evaluate((element) => element.clientWidth >= element.scrollWidth), true, `${what}: with a short step the model label is whole`);
        await hook.status({ done: 1, total: 3, current: LONG }, 0);
        await page.waitForFunction((long) => document.querySelector(".bg-tasks-current")?.textContent === long, LONG);
        await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        row = await measure(page);
        oneRow(row, `${what} step text only`);
        assert.equal(row.plan?.text, "1/3");
        const model = await page.locator(".composer-model").evaluate((element) => ({ clientWidth: element.clientWidth, scrollWidth: element.scrollWidth, drawn: element.getBoundingClientRect().width > 1, fit: element.closest(".composer-status")?.getAttribute("data-model") ?? "full" }));
        assert.ok(!model.drawn || model.clientWidth >= model.scrollWidth, `${what}: a step text change alone refits the model label: ${JSON.stringify(model)}`);
        results.push({ what, state: "step-text-only", chip: row.chip, current: row.current, plan: row.plan, model });
        await hook.status({ done: 3, total: 3, current: null }, 0);
        await page.locator(".bg-tasks-toggle.is-idle").waitFor();
        row = await measure(page);
        oneRow(row, `${what} complete`);
        assert.equal(row.plan?.text, "3/3");
        assert.equal(row.current, null);
        await shot(page, width, theme, "en", "complete");
        await hook.status({ done: 1, total: 3, current: STEP }, 2);
        await page.locator(".bg-tasks-count").waitFor();
        row = await measure(page);
        oneRow(row, `${what} with tasks`);
        assert.equal(row.current?.text, STEP);
        assert.ok(row.count?.drawn && row.count.inside && row.count.text === "2", `${what}: the task count is whole beside the plan: ${JSON.stringify(row.count)}`);
        assert.equal(row.chip?.name, `Plan: 1 of 3 done · ${STEP} · 2 background tasks`);
        await shot(page, width, theme, "en", "tasks");
        results.push({ what, state: "tasks", chip: row.chip, current: row.current, count: row.count });
        await hook.status({ done: 1, total: 3, current: LONG }, 2);
        await page.waitForFunction((long) => document.querySelector(".bg-tasks-current")?.textContent === long, LONG);
        row = await measure(page);
        oneRow(row, `${what} long`);
        assert.equal(row.current?.clipped, true, `${what}: the long step is cut: ${JSON.stringify(row.current)}`);
        assert.ok(row.count?.drawn && row.count.inside, `${what}: the count stays whole beside a long step`);
        assert.equal(row.chip?.name, `Plan: 1 of 3 done · ${LONG} · 2 background tasks`, `${what}: the name says the whole step`);
        assert.ok(row.chip && row.card && row.chip.width < row.card.width / 2 + 60, `${what}: the step's room is bounded: ${JSON.stringify({ chip: row.chip.width, card: row.card.width })}`);
        await shot(page, width, theme, "en", "long");
        results.push({ what, state: "long", chip: row.chip, current: row.current, card: row.card, model: row.model });
        // the list while the plan is still being read, then while it cannot be read (a failed read
        // stays said until one succeeds, so this order)
        await hook.status({ done: 1, total: 3, current: STEP }, 0);
        await page.waitForFunction((step) => document.querySelector(".bg-tasks-current")?.textContent === step && document.querySelector(".bg-tasks-count") === null, STEP);
        await hook.answer("hang");
        await open(page, touch);
        await menuOf(page).getByText("Reading the plan…", { exact: true }).waitFor();
        await shot(page, width, theme, "en", "loading");
        await close(page);
        await hook.answer("error");
        await open(page, touch);
        await menuOf(page).getByRole("status").filter({ hasText: "Couldn't read the plan. Trying again…" }).waitFor();
        await shot(page, width, theme, "en", "error");
        await close(page);
        await hook.answer(null);
        await open(page, touch);
        await menuOf(page).getByText("This session keeps no plan right now", { exact: true }).waitFor();
        await shot(page, width, theme, "en", "missing");
        await close(page);
        await hook.answer(undefined);
        await rest(page);
        // an observer gets no composer (PaneTerminal draws its observing notice instead), so no chip:
        // the plan stays the sidebar's count until the connection interacts again
        await hook.role("observe");
        await chipOf(page).waitFor({ state: "detached" });
        assert.equal(await page.locator(".composer-surface").count(), 0, `${what}: an observer has no composer to hold the chip`);
        await shot(page, width, theme, "en", "observe");
        await hook.role("interact");
        await chipOf(page).waitFor();
        row = await measure(page);
        oneRow(row, `${what} interacting again`);
        assert.equal(row.current?.text, STEP);
        await hook.offline(true);
        await chipOf(page).waitFor({ state: "detached" });
        assert.equal(await page.locator(".bg-tasks-toggle").count(), 0, `${what}: an offline PC's cached plan draws no chip`);
        await shot(page, width, theme, "en", "offline");
        await hook.offline(false);
        await chipOf(page).waitFor();
        row = await measure(page);
        oneRow(row, `${what} back online`);
        assert.equal(row.current?.text, STEP);
        await hook.status(null, 0);
        await chipOf(page).waitFor({ state: "detached" });
        await shot(page, width, theme, "en", "absent");
        await hook.status({ done: 1, total: 3, current: STEP }, 0);
        await chipOf(page).waitFor();
        if (!touch) {
          const status = await page.evaluate(async (pane) => (await fetch("/api/pane/split", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ pane_id: pane, direction: "right", focus: false }) })).status, PANE);
          assert.equal(status, 200, `${what}: the demo split the pane`);
          await page.waitForFunction(() => document.querySelectorAll(".pane-frame").length === 2);
          for (const target of [560, 320]) {
            await page.setViewportSize({ width: target * 2 + 300, height: 900 });
            await page.waitForFunction((target) => { const card = document.querySelector(".composer-surface")?.getBoundingClientRect().width ?? 0; return card > 0 && card <= target + 20; }, target);
            await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
            row = await measure(page);
            oneRow(row, `${what} split ${target}`);
            assert.equal(row.compact, true, `${what}: a split's narrow card is compact`);
            assert.equal(row.current?.text, STEP);
            await shot(page, width, theme, "en", `split-${target}`);
            results.push({ what, state: `split-${target}`, chip: row.chip, current: row.current, card: row.card, model: row.model });
          }
        }
        console.log(`PASS ${what}: the step in the chip at rest, focused, pressed, open and scrolled, without a step, running a later one, complete, with tasks, cut when long, the list's read states, observed, offline and split`);
      });

      for (const width of [390, 1440]) for (const theme of ["dark", "light"] as const) await scenario(browser, width, theme, "ko", async (page, touch) => {
        const what = `${width}px ${theme} ko`;
        const hook = hookOf(page);
        await hook.answer(KO_STEPS);
        await hook.status({ done: 1, total: 3, current: KO_STEP }, 0);
        await page.waitForFunction((step) => document.querySelector(".bg-tasks-current")?.textContent === step, KO_STEP);
        let row = await measure(page);
        oneRow(row, what);
        assert.equal(row.chip?.name, `계획: 3개 중 1개 완료 · ${KO_STEP}`, `${what}: the name in Korean, the step as the agent wrote it`);
        assert.equal(row.label?.text, "계획");
        await shot(page, width, theme, "ko", null);
        await open(page, touch);
        await menuOf(page).locator(".bg-step").nth(2).waitFor();
        row = await measure(page);
        assert.deepEqual(row.menu?.steps, KO_STEPS.map((step) => step.label));
        await shot(page, width, theme, "ko", "open");
        await close(page);
        await hook.status({ done: 1, total: 3, current: KO_LONG }, 0);
        await page.waitForFunction((step) => document.querySelector(".bg-tasks-current")?.textContent === step, KO_LONG);
        row = await measure(page);
        oneRow(row, `${what} long`);
        assert.equal(row.current?.clipped, true, `${what}: an unbroken Korean step is cut, not wrapped`);
        await shot(page, width, theme, "ko", "long");
        if (theme === "dark" && width === 390) results.push({ what, state: "long", chip: row.chip, current: row.current });
        console.log(`PASS ${what}: Korean chip words, step, list and an unbroken step`);
      });

      for (const width of [320, 360]) for (const theme of ["dark", "light"] as const) await scenario(browser, width, theme, "en", async (page, touch) => {
        const what = `${width}px ${theme}`;
        const hook = hookOf(page);
        await hook.status({ done: 1, total: 3, current: LONG }, 2);
        await page.locator(".bg-tasks-count").waitFor();
        const row = await measure(page);
        oneRow(row, what);
        assert.ok(row.count?.drawn && row.count.inside, `${what}: the task count is whole on the narrowest phone`);
        assert.equal(row.current?.clipped, true);
        assert.equal(await page.locator(".composer-controls-right .composer-stop, .composer-controls-right .composer-send").count(), 1, `${what}: the round control keeps its place`);
        await shot(page, width, theme, "en", "narrow");
        results.push({ what, state: "narrow", chip: row.chip, current: row.current, count: row.count, card: row.card, model: row.model });
        console.log(`PASS ${what}: one row with a long step, the figures and a task count`);
        void touch;
      });
    } finally {
      await browser.close();
    }
  } finally {
    server.stop(true);
  }
  if (evidence) {
    writeFileSync(join(evidence, "plan-chip-captures.json"), JSON.stringify(captures, null, 2) + "\n");
    writeFileSync(join(evidence, "plan-chip-results.json"), JSON.stringify(results, null, 2) + "\n");
    console.log(`Evidence: ${evidence} (${captures.length} captures)`);
  }
  console.log("PASS plan chip demo regression");
} finally {
  rmSync(app, { recursive: true, force: true });
  console.log("Cleanup: browser closed, loopback server stopped, demo build removed");
}
