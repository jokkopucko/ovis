import "./test-herdr.ts";
import assert from "node:assert/strict";
import { once } from "node:events";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, watch, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright-core";
import { createServer } from "../server/index.ts";
import { workspaceClose, workspaceCreate } from "../server/herdr/client.ts";
import { omoSessionFolder } from "../server/omo.ts";
import { startShellAgent } from "../server/shell-agent.ts";
import { UsageService } from "../server/usage.ts";
import type { HerdrPane, PlanSummary, ServerMessage } from "../shared/protocol.ts";
import type { Page } from "playwright-core";
import { checkChromeTmpdir } from "./chrome-path.ts";

const root = mkdtempSync(join(tmpdir(), "omo-plan-browser-"));
const evidence = process.env.UI_EVIDENCE_DIR || join(root, "evidence");
mkdirSync(evidence, { recursive: true });
const quote = (word: string) => `'${word.replaceAll("'", "'\\''")}'`;
const id = "synthetic-omo-plan-session";
const store = join(root, "agent");
const sessions = join(store, "sessions", omoSessionFolder(root));
const readyDir = join(root, "ready");
mkdirSync(readyDir);
mkdirSync(sessions, { recursive: true });
const transcript = join(sessions, `2026-10-17T00-00-00-000Z_${id}.jsonl`);
const answer = "Overall: 1/3 done\n  Build:\n    - [X] Read the source\n    - [ ] Implement OmO plans (in progress)\n  Verify:\n    - [ ] Run isolated validation";
const LONG = "Verify-the-plan-chip-against-an-unbroken-label-that-never-wraps-and-stays-whole-in-the-button-name";
const LATER: Record<string, { answer: string; plan: PlanSummary | null }> = {
  advanced: { answer: "Overall: 2/3 done\n  Build:\n    - [X] Read the source\n    - [X] Implement OmO plans\n  Verify:\n    - [ ] Run isolated validation (in progress)", plan: { done: 2, total: 3, current: "Run isolated validation" } },
  long: { answer: `Overall: 3/4 done\n  Build:\n    - [X] Read the source\n    - [X] Implement OmO plans\n  Verify:\n    - [X] Run isolated validation\n    - [ ] ${LONG} (in progress)`, plan: { done: 3, total: 4, current: LONG } },
  between: { answer: `Overall: 3/4 done\n  Build:\n    - [X] Read the source\n    - [X] Implement OmO plans\n  Verify:\n    - [X] Run isolated validation\n    - [ ] ${LONG}`, plan: { done: 3, total: 4, current: null } },
  done: { answer: `Overall: 4/4 done\n  Build:\n    - [X] Read the source\n    - [X] Implement OmO plans\n  Verify:\n    - [X] Run isolated validation\n    - [X] ${LONG}`, plan: { done: 4, total: 4, current: null } },
  cleared: { answer: "Todo list cleared.", plan: null },
};
const records = [
  { type: "session", version: 3, id, cwd: root, timestamp: "2026-10-17T00:00:00.000Z" },
  { type: "message", id: "u1", parentId: null, message: { role: "user", content: [{ type: "text", text: "Show this synthetic plan" }] } },
  { type: "message", id: "a1", parentId: "u1", message: { role: "assistant", stopReason: "toolUse", content: [{ type: "toolCall", id: "t1", name: "todo", arguments: { op: "view" } }] } },
  { type: "message", id: "t1", parentId: "a1", timestamp: "2026-10-17T00:01:00.000Z", message: { role: "toolResult", toolName: "todo", toolCallId: "t1", content: [{ type: "text", text: answer }] } },
  { type: "message", id: "a2", parentId: "t1", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Synthetic plan ready" }] } },
];
writeFileSync(transcript, records.map((row) => JSON.stringify(row)).join("\n") + "\n");
const launcher = join(root, "omo-fixture.mjs");
writeFileSync(launcher, `import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { processStartedAt } from ${JSON.stringify(pathToFileURL(join(import.meta.dir, "../server/process-start.ts")).href)};
const dir = ${JSON.stringify(join(sessions, "session-holders", id))};
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, process.pid + ".json"), JSON.stringify({ pid: process.pid, processStartedAtMs: processStartedAt(process.pid), cwd: ${JSON.stringify(root)} }));
writeFileSync(${JSON.stringify(join(readyDir, "held"))}, "");
setInterval(() => {}, 1000);
`);

let workspaceId: string | undefined;
let server: ReturnType<typeof createServer> | undefined;
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
let socket: WebSocket | undefined;
let appended = 0;
function publish(text: string): void {
  const n = ++appended;
  const at = new Date(Date.parse("2026-10-17T00:01:00.000Z") + n * 60_000).toISOString();
  const rows = [
    { type: "message", id: `u${n + 1}`, parentId: `a${n + 1}`, message: { role: "user", content: [{ type: "text", text: "Go on" }] } },
    { type: "message", id: `a${n + 1}c`, parentId: `u${n + 1}`, message: { role: "assistant", stopReason: "toolUse", content: [{ type: "toolCall", id: `t${n + 1}`, name: "todo", arguments: { op: "view" } }] } },
    { type: "message", id: `t${n + 1}`, parentId: `a${n + 1}c`, timestamp: at, message: { role: "toolResult", toolName: "todo", toolCallId: `t${n + 1}`, content: [{ type: "text", text }] } },
    { type: "message", id: `a${n + 2}`, parentId: `t${n + 1}`, message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Synthetic plan moved on" }] } },
  ];
  appendFileSync(transcript, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
}
function pushed(want: (plan: PlanSummary | null | undefined, background: number | undefined) => boolean, what: string): Promise<{ plan: PlanSummary | null | undefined; background: number | undefined }> {
  return new Promise((resolve, reject) => {
    const signal = AbortSignal.timeout(20_000);
    const listener = (event: MessageEvent): void => {
      const frame: ServerMessage = JSON.parse(String(event.data));
      if (frame.type !== "pane-status" || frame.pane_id !== paneIdOf()) return;
      if (!want(frame.plan, frame.background_tasks)) return;
      socket?.removeEventListener("message", listener);
      resolve({ plan: frame.plan, background: frame.background_tasks });
    };
    signal.addEventListener("abort", () => { socket?.removeEventListener("message", listener); reject(new Error(`${what}: the bridge never pushed it`)); }, { once: true });
    socket?.addEventListener("message", listener);
  });
}
let paneIdOf = (): string => "";
const chip = (page: Page) => page.evaluate(() => {
  const toggle = document.querySelector<HTMLElement>(".bg-tasks-toggle");
  const current = toggle?.querySelector<HTMLElement>(".bg-tasks-current") ?? null;
  const figures = toggle?.querySelector<HTMLElement>(".bg-tasks-plan") ?? null;
  const count = toggle?.querySelector<HTMLElement>(".bg-tasks-count") ?? null;
  const inside = (inner: HTMLElement | null): boolean => {
    const a = inner?.getBoundingClientRect(), b = toggle?.getBoundingClientRect();
    return !!a && !!b && a.left >= b.left - 0.5 && a.right <= b.right + 0.5 && a.top >= b.top - 0.5 && a.bottom <= b.bottom + 0.5;
  };
  return toggle && {
    name: toggle.getAttribute("aria-label"), title: toggle.getAttribute("title"), idle: toggle.classList.contains("is-idle"),
    height: toggle.getBoundingClientRect().height, minHeight: parseFloat(getComputedStyle(toggle).minHeight), focused: document.activeElement === toggle,
    figures: figures && { text: figures.textContent, inside: inside(figures), clipped: figures.scrollWidth > figures.clientWidth },
    current: current && { text: current.textContent, inside: inside(current), clipped: current.scrollHeight > current.clientHeight || current.scrollWidth > current.clientWidth, height: current.getBoundingClientRect().height },
    count: count && { text: count.textContent, drawn: count.getBoundingClientRect().width > 1, inside: inside(count) },
    card: document.querySelector(".composer-surface")?.getBoundingClientRect().width ?? 0, compact: document.querySelector(".composer-surface")?.hasAttribute("data-compact") ?? false,
    overflowing: document.documentElement.scrollWidth > window.innerWidth,
  };
});
type Chip = NonNullable<Awaited<ReturnType<typeof chip>>>;
function oneRow(drawn: Chip | null, what: string): asserts drawn is Chip {
  assert.ok(drawn, `${what}: the chip is drawn`);
  assert.ok(drawn.height <= drawn.minHeight + 1, `${what}: the chip is one line: ${JSON.stringify(drawn)}`);
  assert.ok(drawn.figures && drawn.figures.inside && !drawn.figures.clipped, `${what}: done/total is whole: ${JSON.stringify(drawn.figures)}`);
  if (drawn.current) assert.ok(drawn.current.inside && drawn.current.height <= drawn.minHeight, `${what}: the step shares the line: ${JSON.stringify(drawn.current)}`);
  assert.equal(drawn.overflowing, false, `${what}: no sideways page scroll`);
}
const focusedPane = async (origin: string): Promise<string | null | undefined> => {
  const body: { snapshot: { focused_pane_id?: string | null } } = await (await fetch(`${origin}/api/session`, { signal: AbortSignal.timeout(5000) })).json();
  return body.snapshot.focused_pane_id;
};
try {
  const created = await workspaceCreate({ cwd: root, label: "Synthetic OmO plan" });
  workspaceId = created.workspace.workspace_id;
  const paneId = created.root_pane.pane_id;
  paneIdOf = () => paneId;
  const watcher = watch(readyDir);
  try {
    const ready = once(watcher, "change", { signal: AbortSignal.timeout(20_000) });
    await startShellAgent("omo", paneId, [], { command: `export OMO_CODING_AGENT_DIR=${quote(store)}; cd ${quote(root)} && exec ${quote(process.execPath)} ${quote(launcher)}` });
    await ready;
  } finally { watcher.close(); }
  server = createServer({ port: 0, hostname: "127.0.0.1", token: "", stateDir: join(root, "state"), tailscaleOwner: null, usage: new UsageService(undefined, []) });
  const origin = `http://127.0.0.1:${server.port}`;
  await new Promise<void>((resolve, reject) => {
    const signal = AbortSignal.timeout(30_000);
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    socket = new WebSocket(`ws://127.0.0.1:${server?.port}/ws`);
    socket.addEventListener("error", () => reject(new Error("Synthetic status socket failed")), { once: true });
    socket.addEventListener("message", (event) => {
      const frame: ServerMessage = JSON.parse(String(event.data));
      const snapshotPane: HerdrPane | undefined = frame.type === "snapshot" ? frame.snapshot.panes.find((pane) => pane.pane_id === paneId) : undefined;
      const plan = frame.type === "pane-status" && frame.pane_id === paneId ? frame.plan : snapshotPane?.plan;
      if (plan?.done === 1 && plan.total === 3) resolve();
    });
  });
  const response = await fetch(`${origin}/api/session`, { signal: AbortSignal.timeout(5000) });
  assert.equal(response.status, 200);
  const body: { snapshot: { panes: HerdrPane[] } } = await response.json();
  const pane = body.snapshot.panes.find((item) => item.pane_id === paneId);
  assert.equal(pane?.agent, "omo");
  assert.deepEqual(pane.plan, { done: 1, total: 3, current: "Implement OmO plans" });
  writeFileSync(join(evidence, "snapshot-pane.json"), JSON.stringify(pane, null, 2) + "\n");

  checkChromeTmpdir();
  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? "/opt/google/chrome/chrome", headless: true, args: ["--no-sandbox", "--no-proxy-server"] });
  const errors: string[] = [];
  for (const width of [1280, 390]) {
    for (const theme of ["dark", "light"] as const) {
      const context = await browser.newContext({ viewport: { width, height: 844 }, isMobile: width === 390, hasTouch: width === 390, colorScheme: theme, locale: "en-US" });
      try {
        await context.addInitScript(({ paneId, theme }) => {
          localStorage.setItem("ovis:settings", JSON.stringify({ language: "en", theme }));
          localStorage.setItem(`ovis:view:${paneId}`, "chat");
        }, { paneId, theme });
        const page = await context.newPage();
        page.setDefaultTimeout(20_000);
        page.on("pageerror", (error) => errors.push(error.message));
        await page.goto(`${origin}/?pane=${encodeURIComponent(paneId)}`);
        await page.locator(".conn-live").waitFor();
        if (width === 390) {
          await page.getByRole("button", { name: "Open workspace list", exact: true }).click();
          await page.locator(".agents-sidebar .agent-section-toggle").click();
        }
        const row = page.locator(`.agents-sidebar .agent-item[data-pane="${paneId}"]`);
        const badge = row.getByTestId("plan-progress");
        if (width !== 390) await row.hover();
        await badge.waitFor({ state: "visible" });
        assert.equal(await badge.textContent(), "1/3");
        await page.screenshot({ path: join(evidence, `${width}-${theme}-sidebar.png`), fullPage: true });
        await row.locator(".agent-select").click();
        const toggle = page.locator(".bg-tasks-toggle");
        await toggle.click();
        const panel = page.locator(".bg-tasks-menu");
        await panel.locator(".bg-step.is-in_progress").getByText("Implement OmO plans", { exact: true }).waitFor();
        assert.deepEqual(await panel.locator(".bg-step .bg-task-title").allTextContents(), ["Read the source", "Implement OmO plans", "Run isolated validation"]);
        await page.screenshot({ path: join(evidence, `${width}-${theme}-plan.png`), fullPage: true });
        console.log(`PASS ${width}px ${theme}: sidebar 1/3 and all three plan steps`);
      } finally { await context.close(); }
    }
  }
  assert.deepEqual(errors, []);
  console.log(`PASS pane.plan ${JSON.stringify(pane.plan)}`);

  const advances: Array<Record<string, unknown>> = [];
  const desktop = await browser.newContext({ viewport: { width: 1280, height: 844 }, colorScheme: "dark", locale: "en-US" });
  const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3, colorScheme: "light", locale: "en-US" });
  try {
    const pages: Array<{ page: Page; what: string }> = [];
    for (const [context, what, theme] of [[desktop, "1280px dark", "dark"], [phone, "390px light", "light"]] as const) {
      await context.addInitScript(({ paneId, theme }) => {
        localStorage.setItem("ovis:settings", JSON.stringify({ language: "en", theme }));
        localStorage.setItem(`ovis:view:${paneId}`, "chat");
      }, { paneId, theme });
      const page = await context.newPage();
      page.setDefaultTimeout(20_000);
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(`${origin}/?pane=${encodeURIComponent(paneId)}&view=chat`);
      await page.locator(".conn-live").waitFor();
      await page.locator(".terminal-stack.is-chat").waitFor();
      await page.locator(".bg-tasks-current").waitFor();
      pages.push({ page, what });
    }
    const focusBefore = await focusedPane(origin);
    for (const { page, what } of pages) {
      const drawn = await chip(page);
      oneRow(drawn, `${what} at rest`);
      assert.equal(drawn.current?.text, "Implement OmO plans", `${what}: the step in progress is in the chip`);
      assert.equal(drawn.figures?.text, "1/3");
      assert.equal(drawn.name, "Plan: 1 of 3 done · Implement OmO plans · Background tasks", `${what}: the name says the whole step, then the OmO pane's tasks`);
      assert.equal(drawn.title, drawn.name);
    }
    const { page: desk } = pages[0]!;
    await desk.getByRole("textbox", { name: "Message", exact: true }).focus();
    for (let step = 0; step < 8 && !(await desk.evaluate(() => document.activeElement?.classList.contains("bg-tasks-toggle"))); step++) await desk.keyboard.press("Tab");
    assert.equal(await desk.evaluate(() => document.activeElement?.classList.contains("bg-tasks-toggle")), true, "Tab reaches the chip");

    let frame = pushed((plan) => plan?.done === 2 && plan.current === "Run isolated validation", "the advanced plan");
    publish(LATER.advanced!.answer);
    advances.push({ state: "advanced", pushed: await frame });
    for (const { page, what } of pages) {
      await page.locator(".bg-tasks-current").filter({ hasText: "Run isolated validation" }).waitFor();
      const drawn = await chip(page);
      oneRow(drawn, `${what} advanced`);
      assert.equal(drawn.figures?.text, "2/3", `${what}: the figures moved with the step`);
      assert.equal(drawn.name, "Plan: 2 of 3 done · Run isolated validation · Background tasks");
      advances.push({ what, state: "advanced", chip: drawn });
    }
    assert.equal((await chip(desk))?.focused, true, "the pushed step leaves the keyboard where it was");
    await pages[1]!.page.locator(".bg-tasks-toggle").tap();
    const list = pages[1]!.page.locator(".bg-tasks-menu");
    await list.locator(".bg-step.is-in_progress").getByText("Run isolated validation", { exact: true }).waitFor();
    assert.deepEqual(await list.locator(".bg-step.is-completed .bg-task-title").allTextContents(), ["Read the source", "Implement OmO plans"]);
    await pages[1]!.page.screenshot({ path: join(evidence, "native-390-light-advanced-open.png") });
    await pages[1]!.page.keyboard.press("Escape");
    await list.waitFor({ state: "detached" });

    const taskDir = join(root, ".omo", "senpi-task", "tasks");
    mkdirSync(taskDir, { recursive: true });
    const taskFile = join(taskDir, "st_00000001.json");
    frame = pushed((_plan, background) => background === 1, "one running task");
    writeFileSync(taskFile, JSON.stringify({ task_id: "st_00000001", parent_session_id: id, status: "running", task_summary: "Synthetic subagent", started_at: new Date().toISOString() }));
    advances.push({ state: "task", pushed: await frame });
    for (const { page, what } of pages) {
      await page.locator(".bg-tasks-count").waitFor();
      const drawn = await chip(page);
      oneRow(drawn, `${what} with a task`);
      assert.ok(drawn.count?.drawn && drawn.count.inside && drawn.count.text === "1", `${what}: the task count is whole beside the plan: ${JSON.stringify(drawn.count)}`);
      assert.equal(drawn.current?.text, "Run isolated validation");
      assert.equal(drawn.name, "Plan: 2 of 3 done · Run isolated validation · 1 background task");
    }

    frame = pushed((plan) => plan?.current === LONG, "the unbroken step");
    publish(LATER.long!.answer);
    advances.push({ state: "long", pushed: await frame });
    for (const { page, what } of pages) {
      await page.locator(".bg-tasks-current").filter({ hasText: LONG }).waitFor();
      const drawn = await chip(page);
      oneRow(drawn, `${what} long`);
      assert.equal(drawn.current?.clipped, true, `${what}: the long step is cut: ${JSON.stringify(drawn.current)}`);
      assert.equal(drawn.figures?.text, "3/4");
      assert.ok(drawn.count?.drawn && drawn.count.inside, `${what}: the count stays whole beside a long step`);
      assert.equal(drawn.name, `Plan: 3 of 4 done · ${LONG} · 1 background task`, `${what}: the name says the whole step`);
      advances.push({ what, state: "long", chip: drawn });
      await page.screenshot({ path: join(evidence, `native-${what.split("px")[0]}-${what.split(" ")[1]}-long.png`) });
    }
    assert.equal(await focusedPane(origin), focusBefore, "herdr's own focus did not move for the chip");

    const split = await desk.evaluate(async (pane) => { const response = await fetch("/api/pane/split", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ pane_id: pane, direction: "right", focus: false }) }); return { status: response.status, text: await response.text() }; }, paneId);
    assert.equal(split.status, 200, `the bridge split the pane: ${split.text}`);
    await desk.waitForFunction(() => document.querySelectorAll(".pane-frame").length === 2);
    await desk.setViewportSize({ width: 1000, height: 844 });
    await desk.waitForFunction(() => { const card = document.querySelector(".composer-surface")?.getBoundingClientRect().width ?? 0; return card > 0 && card < 360; });
    await desk.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    {
      const drawn = await chip(desk);
      oneRow(drawn, "a narrow split");
      assert.equal(drawn.compact, true, "a narrow split's card is compact");
      assert.equal(drawn.current?.clipped, true);
      assert.ok(drawn.count?.drawn && drawn.count.inside, `the count is whole in a narrow split: ${JSON.stringify(drawn)}`);
      assert.equal(await desk.locator(".composer-controls-right .composer-send, .composer-controls-right .composer-stop").evaluate((button) => { const card = button.closest(".composer-surface")!.getBoundingClientRect(); const box = button.getBoundingClientRect(); return box.right <= card.right + 0.5 && box.left >= card.left - 0.5; }), true, "the round button keeps its place in a narrow split");
      advances.push({ what: "1000px split", state: "split", chip: drawn });
      await desk.screenshot({ path: join(evidence, "native-1000-dark-split.png") });
    }

    frame = pushed((plan) => plan?.done === 3 && plan.current === null, "a plan between steps");
    publish(LATER.between!.answer);
    advances.push({ state: "between", pushed: await frame });
    for (const { page, what } of pages) {
      await page.waitForFunction(() => document.querySelector(".bg-tasks-toggle") !== null && document.querySelector(".bg-tasks-current") === null);
      const drawn = await chip(page);
      oneRow(drawn, `${what} between steps`);
      assert.equal(drawn.figures?.text, "3/4");
      assert.equal(drawn.name, "Plan: 3 of 4 done · 1 background task", `${what}: no step, no separator`);
      assert.equal(drawn.idle, false);
    }
    frame = pushed((_plan, background) => background === 0, "the task gone");
    writeFileSync(taskFile, JSON.stringify({ task_id: "st_00000001", parent_session_id: id, status: "completed", task_summary: "Synthetic subagent", started_at: new Date(Date.now() - 60_000).toISOString(), terminal_at: new Date().toISOString() }));
    advances.push({ state: "task-ended", pushed: await frame });
    frame = pushed((plan) => plan?.done === 4 && plan.total === 4, "every step done");
    publish(LATER.done!.answer);
    advances.push({ state: "done", pushed: await frame });
    for (const { page, what } of pages) {
      await page.locator(".bg-tasks-toggle.is-idle").waitFor();
      const drawn = await chip(page);
      oneRow(drawn, `${what} done`);
      assert.equal(drawn.figures?.text, "4/4");
      assert.equal(drawn.current, null);
      assert.equal(drawn.count, null, `${what}: the ended task counts no more`);
    }
    frame = pushed((plan) => plan === null, "the cleared plan");
    publish(LATER.cleared!.answer);
    advances.push({ state: "cleared", pushed: await frame });
    for (const { page, what } of pages) {
      await page.waitForFunction(() => document.querySelector(".bg-tasks-toggle") !== null && document.querySelector(".bg-tasks-plan") === null);
      const drawn = await chip(page);
      assert.ok(drawn && drawn.current === null && drawn.figures === null, `${what}: no figures and no step without a plan`);
      assert.equal(drawn.name, "Background tasks");
    }
    writeFileSync(join(evidence, "current-step-advances.json"), JSON.stringify(advances, null, 2) + "\n");
    console.log("PASS the chip's step follows the fixture: advanced, with a task, unbroken, split, between steps, done and cleared, with herdr's focus where it was");
  } finally {
    await phone.close();
    await desktop.close();
  }
  assert.deepEqual(errors, []);
  console.log(`Evidence: ${evidence}`);
} finally {
  socket?.close();
  try { await browser?.close(); } finally {
    try { server?.stop(); } finally {
      try { if (workspaceId !== undefined) await workspaceClose(workspaceId); } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  }
  console.log("Cleanup: browser, bridge, fixture workspace and fixture directory removed");
}
