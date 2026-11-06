import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BrowserContext, Page } from "playwright-core";
import type { ConversationPart, ConversationTurn } from "../shared/protocol.ts";
import { appFaces } from "./app-faces.ts";
import panes from "../site/demo/fixtures/panes.json";
import { buildDemoApp } from "./demo-build.ts";
import { chromePath } from "./chrome-path.ts";

// Contiguous todo updates folded into one row, on the unmodified app over the demo's fixture
// transport. The curated chats carry the native fields (Claude's id and recorded outcome, Codex's id
// alone once answered, neither for another agent); then each pane's conversation reads answer the
// turns this script feeds, announced as a transcript change the way the bridge does: pending calls,
// results appended, the page polled again, narration and hidden thinking between updates, failed,
// unreadable and repeated calls, Codex's unknown outcomes and an agent that records none. Everything
// stays in this disposable, loopback-only app; no herdr session is opened. With UI_EVIDENCE_DIR set,
// every state is also captured at 390 (phone) and 1440, light and dark, and in Korean at 390.
const app = mkdtempSync(join(tmpdir(), "herdr-todo-snapshots-demo-"));
const evidence = process.env["UI_EVIDENCE_DIR"] || null;

// playwright-core's bundle lazily requires packages the lockfile does not carry (chromium-bidi):
// fine at run time, unresolvable to `bun build` — so it is imported past the bundler's analysis
const playwrightCore = "playwright-core";
const { chromium, devices } = (await import(playwrightCore)) as typeof import("playwright-core");

type Tool = Extract<ConversationPart, { kind: "tool" }>;
type State = Tool["state"];

const todos = (labels: string[], done = 0) => ({
  todos: labels.map((content, index) => ({ content, status: index < done ? "completed" : index === done ? "in_progress" : "pending", activeForm: content })),
});
/** A Claude TodoWrite as the server sends it: its id, and the outcome its tool_result recorded. */
const claude = (id: string, state: State, input: unknown, output = state === "ok" ? "Todos have been modified successfully." : ""): Tool => ({
  kind: "tool", name: "TodoWrite", summary: "TodoWrite", input: typeof input === "string" ? input : JSON.stringify(input, null, 2), output, call_id: id,
  ...(state === undefined ? {} : { state }), ...(state === "error" ? { error: true } : {}),
});
/** A Codex update_plan: its id, pending until its output, then no state at all. */
const codex = (id: string, answered: boolean, steps: string[], done: number, output = "Plan updated"): Tool => ({
  kind: "tool", name: "update_plan", summary: "update_plan", call_id: id, output: answered ? output : "",
  input: JSON.stringify({ plan: steps.map((step, index) => ({ step, status: index < done ? "completed" : index === done ? "in_progress" : "pending" })) }, null, 2),
  ...(answered ? {} : { state: "pending" as const }),
});
/** An omp todo call: an operation, answered with the whole list; omp records neither field. */
const legacy = (op: unknown, items: string[], done: number): Tool => ({
  kind: "tool", name: "todo", summary: "todo", input: JSON.stringify(op, null, 2),
  output: `Overall: ${done}/${items.length} done.\n  Plan:\n${items.map((item, index) => `    - [${index < done ? "X" : " "}] ${item}${index === done ? " (in progress)" : ""}`).join("\n")}`,
});
const narration = (text: string): ConversationPart => ({ kind: "text", text, phase: "commentary" });

const STEPS = ["Reproduce the failure", "Find what the timing depends on", "Fix the test and rerun it 50 times"];
const LONG = [
  "Move every retry budget the payment client reads out of the environment and into the typed configuration loader, keeping the old variable names working for one release",
  "Rerun the whole suite fifty times: retrySupervisorBackoffJitterMillisecondsUpperBoundWithoutAnyBreakOpportunityAnywhereInIt",
  "Write the changelog fragment",
];
const PROSE = "The first two updates only reordered the list; reading the test before the next one.";

interface Scenario { pane: string; name: string; parts: ConversationPart[] }

/** The turns a conversation read answers: the user's line names the scenario, so its landing is seen. */
const turnsOf = (scenario: Scenario): ConversationTurn[] => [
  { role: "user", ts: "2026-10-21T09:00:00.000Z", parts: [{ kind: "text", text: `Scenario ${scenario.name}` }] },
  { role: "assistant", ts: "2026-10-21T09:00:02.000Z", parts: scenario.parts },
];

const S = {
  pending: { pane: panes.flaky, name: "pending", parts: [claude("toolu_a", "pending", todos(STEPS, 0)), claude("toolu_b", "pending", todos(STEPS, 1))] },
  // the same calls answered (an empty ok, an explicit failure) and a third appended
  append: { pane: panes.flaky, name: "append", parts: [claude("toolu_a", "ok", todos(STEPS, 1), ""), claude("toolu_b", "error", todos(STEPS, 2), "<tool_use_error>InputValidationError</tool_use_error>"), claude("toolu_c", "pending", todos(STEPS, 2))] },
  narration: { pane: panes.flaky, name: "narration", parts: [
    claude("toolu_n1", "ok", todos(STEPS, 0)), claude("toolu_n2", "ok", todos(STEPS, 1)), narration(PROSE), claude("toolu_n3", "ok", todos(STEPS, 1)),
    { kind: "thinking", text: "hidden reasoning between two updates" }, claude("toolu_n4", "ok", todos(STEPS, 2)), claude("toolu_n5", "error", todos(STEPS, 3), "<tool_use_error>InputValidationError</tool_use_error>"),
  ] },
  failed: { pane: panes.flaky, name: "failed", parts: [claude("toolu_f1", "ok", todos(STEPS, 1)), claude("toolu_f2", "pending", todos(STEPS, 2)), claude("toolu_f3", "error", todos(STEPS, 3), "<tool_use_error>InputValidationError</tool_use_error>")] },
  allFailed: { pane: panes.flaky, name: "all-failed", parts: [claude("toolu_x1", "error", todos(STEPS, 0), "<tool_use_error>A</tool_use_error>"), claude("toolu_x2", "error", todos(STEPS, 0), "<tool_use_error>B</tool_use_error>")] },
  unreadable: { pane: panes.flaky, name: "unreadable", parts: [claude("toolu_u1", "ok", todos(STEPS, 1)), claude("toolu_u2", "ok", '{"todos": "not a list"}')] },
  long: { pane: panes.flaky, name: "long", parts: [claude("toolu_l1", "ok", todos(LONG, 0)), claude("toolu_l2", "ok", todos(LONG, 1))] },
  identical: { pane: panes.flaky, name: "identical", parts: [claude("toolu_i1", "ok", todos(STEPS, 1)), claude("toolu_i2", "ok", todos(STEPS, 1))] },
  codexPending: { pane: panes.web, name: "codex", parts: [codex("call_k1", false, STEPS, 0), codex("call_k2", false, STEPS, 1)] },
  // answered: an empty output and one whose text describes a failure, both outcome unknown
  codexDone: { pane: panes.web, name: "codex-done", parts: [codex("call_k1", true, STEPS, 0, ""), codex("call_k2", true, STEPS, 1, "Error: plan update failed")] },
  codexAfterOk: { pane: panes.web, name: "codex-after-ok", parts: [claude("toolu_o1", "ok", todos(STEPS, 0)), codex("call_o2", true, STEPS, 2)] },
  legacy: { pane: panes.omp, name: "legacy", parts: [legacy({ op: "init", list: [{ phase: "Plan", items: STEPS }] }, STEPS, 0), legacy({ op: "done", task: STEPS[0] }, STEPS, 1)] },
} satisfies Record<string, Scenario>;

interface Group { id: string; expanded: boolean; head: string; caption: string | null; list: string[]; attempts: string[]; failedClipped: boolean }

/** Every folded todo run on the page, as a reader gets it. */
const groups = (page: Page): Promise<Group[]> => page.evaluate(() => [...document.querySelectorAll<HTMLElement>("[data-todo-group]")].map((group) => {
  const head = group.querySelector<HTMLElement>(":scope > .work-row-head")!;
  const failed = head.querySelector<HTMLElement>(".work-row-failed");
  const box = head.getBoundingClientRect();
  return {
    id: group.dataset["todoGroup"]!,
    expanded: head.getAttribute("aria-expanded") === "true",
    head: head.textContent ?? "",
    caption: group.querySelector(".work-todo-caption")?.textContent ?? null,
    list: [...group.querySelectorAll(".todo-label")].map((label) => label.firstChild?.textContent ?? ""),
    attempts: [...group.querySelectorAll(".work-todo-attempts .work-row-head")].map((row) => row.textContent ?? ""),
    failedClipped: failed !== null && (failed.scrollWidth > failed.clientWidth + 1 || failed.getBoundingClientRect().right > box.right + 1),
  };
}));

// the demo's own turn ends a few seconds in and would drop its alert over the captures
const settings = (theme: string, language: string) => JSON.stringify({ language, theme, alertsOn: false });

async function open(context: BrowserContext, base: string, pane: string): Promise<Page> {
  const page = await context.newPage();
  await page.goto(`${base}?pane=${encodeURIComponent(pane)}`);
  await page.locator(".conn-live").waitFor({ state: "attached" });
  await page.locator(".terminal-stack.is-chat").waitFor();
  await appFaces(page, "Mg계획");
  return page;
}

/** Serves the scenario on its pane, announces it, and waits until its turn and its rows are drawn. */
async function feed(page: Page, scenario: Scenario, expectGroups: number, unchanged = false): Promise<void> {
  const reads = await page.evaluate(([pane, turns]) => {
    const view = window as unknown as { todoTurns: Record<string, unknown>; todoReads: Record<string, number>; announceTodos: (pane: string) => void };
    view.todoTurns[pane] = turns;
    const before = view.todoReads[pane] ?? 0;
    view.announceTodos(pane);
    return before;
  }, [scenario.pane, turnsOf(scenario)] as const);
  await page.waitForFunction(([pane, count]) => ((window as unknown as { todoReads: Record<string, number> }).todoReads[pane as string] ?? 0) > (count as number), [scenario.pane, reads] as const, { timeout: 10_000 });
  if (unchanged) {
    // the same content again: nothing to see change, so the frames after the read's answer are waited for
    await page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
  }
  await page.locator(".chat-turn", { hasText: `Scenario ${scenario.name}` }).waitFor({ timeout: 10_000 });
  // the work block of the scenario's turn, opened if the turn settled folded
  const head = page.locator(".chat-turn-agent .work-block-head").last();
  if (await head.getAttribute("aria-expanded") === "false") await head.click();
  await page.waitForFunction((count) => document.querySelectorAll("[data-todo-group]").length === count, expectGroups, { timeout: 10_000 });
}

/** Opens the (only, or first) folded run if it is closed. */
async function expand(page: Page): Promise<void> {
  const heads = page.locator("[data-todo-group] > .work-row-head");
  for (let index = 0; index < await heads.count(); index++) {
    if (await heads.nth(index).getAttribute("aria-expanded") === "false") await heads.nth(index).click();
  }
  await page.waitForFunction(() => [...document.querySelectorAll("[data-todo-group]")].every((group) => group.querySelector(".work-todo-attempts") !== null), undefined, { timeout: 10_000 });
}

async function collapse(page: Page): Promise<void> {
  const head = page.locator("[data-todo-group] > .work-row-head").first();
  if (await head.getAttribute("aria-expanded") === "true") await head.click();
  await page.locator("[data-todo-group] .work-todo-attempts").waitFor({ state: "detached" });
}

/** No page-level or chat-level sideways scroll. */
async function noSidewaysScroll(page: Page, what: string): Promise<void> {
  const overflow = await page.evaluate(() => {
    const root = document.scrollingElement!;
    // the hover plate of a row overhangs its block by design; what counts is a box that scrolls
    const scrollers = [...document.querySelectorAll<HTMLElement>(".terminal-stack *")].filter((node) => /auto|scroll/.test(getComputedStyle(node).overflowX) && node.clientWidth > 0);
    return { page: root.scrollWidth - root.clientWidth, chat: Math.max(0, ...scrollers.map((node) => node.scrollWidth - node.clientWidth)) };
  });
  assert.ok(overflow.page <= 0 && overflow.chat <= 0, `${what}: sideways overflow ${JSON.stringify(overflow)}`);
}

const shots: { file: string; width: number; height: number; theme: string; language: string; state: string; sha256: string; capturedAt: string }[] = [];
const measurements: Record<string, unknown>[] = [];

/** The end of the chat, by the app's own Jump to latest: nothing floats over the last rows then. */
async function toEnd(page: Page): Promise<void> {
  // A reader who opened a run reads there (#1388), so the button can be offered while the chat is
  // already at its end and leave on its own once a layout change scrolls there: it is pressed only
  // if it is there at that moment, and either way the end is reached with nothing over it.
  await page.evaluate(() => document.querySelector<HTMLElement>(".chat-virtual-jump")?.click());
  await page.locator(".chat-virtual-jump").waitFor({ state: "detached", timeout: 10_000 });
}

async function shoot(page: Page, config: Config, state: string, end = false): Promise<void> {
  if (evidence === null) return;
  // a pane waiting on an approval keeps its card over the chat: folded, as a reader can
  const fold = page.locator(".prompt-card-fold[aria-expanded=\"true\"]");
  if (await fold.count() > 0) await fold.click();
  if (end) await toEnd(page);
  else await page.locator("[data-todo-group]").first().scrollIntoViewIfNeeded().catch(() => undefined);
  // a rest state is drawn without the pointer over it: the last click leaves it on the head
  if (state !== "hover" && state !== "pressed") {
    const viewport = page.viewportSize()!;
    await page.mouse.move(viewport.width - 2, Math.round(viewport.height / 2));
  }
  await page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
  const file = `todo-snapshots-${config.width}-${config.theme}${config.language === "ko" ? "-ko" : ""}-${state}.png`;
  const buffer = await page.screenshot({ path: join(evidence, file) });
  const viewport = page.viewportSize()!;
  shots.push({ file, width: viewport.width * config.scale, height: viewport.height * config.scale, theme: config.theme, language: config.language, state, sha256: createHash("sha256").update(buffer).digest("hex"), capturedAt: new Date().toISOString() });
}

/** Font size, contrast against the backdrop and hit box of the run's head and its badges. */
async function measure(page: Page, config: Config, state: string): Promise<void> {
  if (evidence === null) return;
  measurements.push({ config: `${config.width}-${config.theme}${config.language === "ko" ? "-ko" : ""}`, state, ...(await page.evaluate(() => {
    const rgb = (value: string) => (value.match(/[\d.]+/g) ?? []).map(Number);
    const backdrop = (node: Element | null): number[] => {
      for (let at = node; at; at = at.parentElement) {
        const color = rgb(getComputedStyle(at).backgroundColor);
        if (color.length >= 3 && (color[3] ?? 1) > 0.5) return color;
      }
      return rgb(getComputedStyle(document.body).backgroundColor);
    };
    const luminance = ([r, g, b]: number[]) => [r!, g!, b!].map((c) => { const v = c / 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; })
      .reduce((sum, v, index) => sum + v * [0.2126, 0.7152, 0.0722][index]!, 0);
    const contrast = (node: Element) => {
      const fg = luminance(rgb(getComputedStyle(node).color)), bg = luminance(backdrop(node));
      return Math.round(((Math.max(fg, bg) + 0.05) / (Math.min(fg, bg) + 0.05)) * 100) / 100;
    };
    const describe = (node: Element | null) => node === null ? null : {
      text: node.textContent, fontSizePx: parseFloat(getComputedStyle(node).fontSize), contrast: contrast(node),
      box: (({ width, height }) => ({ width: Math.round(width), height: Math.round(height) }))(node.getBoundingClientRect()),
      accessibleName: node.getAttribute("aria-label") ?? node.textContent,
    };
    const head = document.querySelector("[data-todo-group] > .work-row-head");
    return {
      head: describe(head), headSummary: describe(document.querySelector("[data-todo-group] .work-row-summary")),
      failedBadge: describe(document.querySelector("[data-todo-group] > .work-row-head .work-row-failed")),
      pendingBadge: describe(document.querySelector("[data-todo-group] > .work-row-head .work-row-state")),
      attemptState: describe(document.querySelector("[data-todo-group] .work-todo-attempts .work-row-state")),
      attemptHeads: [...document.querySelectorAll("[data-todo-group] .work-todo-attempts .work-row-head")].map((node) => (({ width, height }) => ({ width: Math.round(width), height: Math.round(height) }))(node.getBoundingClientRect())),
      expandedAttr: head?.getAttribute("aria-expanded") ?? null,
    };
  })) });
}

interface Config { width: number; theme: "light" | "dark"; language: "en" | "ko"; phone: boolean; scale: number }

const CONFIGS: Config[] = [
  { width: 1440, theme: "light", language: "en", phone: false, scale: 1 },
  { width: 1440, theme: "dark", language: "en", phone: false, scale: 1 },
  { width: 390, theme: "light", language: "en", phone: true, scale: 3 },
  { width: 390, theme: "dark", language: "en", phone: true, scale: 3 },
  { width: 390, theme: "light", language: "ko", phone: true, scale: 3 },
];

try {
  await buildDemoApp(app);
  if (evidence !== null) mkdirSync(evidence, { recursive: true });
  const index = join(app, "index.html");
  const html = readFileSync(index, "utf8");
  assert.match(html, /<script type="module"/);
  // Over the demo's own fetch: a pane named in window.todoTurns answers those turns (a new parse
  // each read, as the bridge sends), counted in window.todoReads; window.announceTodos pushes the
  // change on the page's sockets. window.todoOffline refuses every socket opened after it is set.
  const wrapper = `<script>(() => {
    const demo = window.fetch;
    window.todoTurns = {};
    window.todoReads = {};
    window.todoOffline = false;
    const DemoSocket = window.WebSocket;
    const sockets = new Set();
    const Socket = function (...args) {
      const socket = new DemoSocket(...args);
      if (window.todoOffline) queueMicrotask(() => socket.close());
      else sockets.add(socket);
      return socket;
    };
    Socket.prototype = DemoSocket.prototype;
    Object.setPrototypeOf(Socket, DemoSocket);
    window.WebSocket = Socket;
    window.todoSockets = sockets;
    let signature = 0;
    window.announceTodos = (pane) => {
      signature += 1;
      for (const socket of sockets) if (socket.readyState === 1) socket.push({ type: "conversation-changed", pane_id: pane, signature: "todos:" + signature });
    };
    window.fetch = (input, init) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, location.href);
      const pane = url.searchParams.get("pane_id");
      if (url.pathname === "/api/pane/conversation" && pane !== null && window.todoTurns[pane] && !url.searchParams.has("before") && !url.searchParams.has("from")) {
        window.todoReads[pane] = (window.todoReads[pane] || 0) + 1;
        const source = pane === ${JSON.stringify(panes.web)} ? "codex-transcript" : pane === ${JSON.stringify(panes.omp)} ? "omp-transcript" : "claude-transcript";
        return Promise.resolve(new Response(JSON.stringify({ source, turns: window.todoTurns[pane], metadata: { model: "fixture", reasoning_effort: "medium" }, cursor: null }), { headers: { "content-type": "application/json" } }));
      }
      return demo(input, init);
    };
  })();</script>`;
  writeFileSync(index, html.replace(/<script type="module"/, () => `<script src="./demo-transport.js"></script>\n    ${wrapper}\n    <script type="module"`));

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
  const base = `http://127.0.0.1:${server.port}/herdr-web-ui/demo/app/`;
  try {
    const browser = await chromium.launch({ executablePath: chromePath(), headless: true, args: ["--no-sandbox"] });
    try {
      for (const config of CONFIGS) {
        const en = config.language === "en";
        const context = await browser.newContext(config.phone
          ? { ...devices["iPhone 14"], locale: en ? "en-US" : "ko-KR" }
          : { viewport: { width: 1440, height: 900 }, locale: "en-US" });
        try {
          await context.addInitScript(([value, ids]) => {
            localStorage.setItem("ovis:settings", value);
            for (const id of ids) localStorage.setItem(`ovis:view:${id}`, "chat");
          }, [settings(config.theme, config.language), [panes.flaky, panes.web, panes.omp, panes.api]] as const);
          const label = `${config.width} ${config.theme}${en ? "" : " ko"}`;

          if (en && config.width === 1440 && config.theme === "light") {
            // the curated chats as the demo serves them: Claude's id and ok, Codex's id alone, omp neither
            const page = await open(context, base, panes.flaky);
            const served = await page.evaluate(async (ids) => Object.fromEntries(await Promise.all(Object.entries(ids).map(async ([key, id]) => {
              const body = await (await fetch(`/api/pane/conversation?pane_id=${encodeURIComponent(id)}`)).json() as { turns: { parts: Record<string, unknown>[] }[] };
              return [key, body.turns.flatMap((turn) => turn.parts).filter((part) => part["kind"] === "tool").map((part) => [part["call_id"] ?? null, "state" in part ? part["state"] : "omitted"])];
            }))), { api: panes.api, flaky: panes.flaky, web: panes.web, omp: panes.omp });
            for (const key of ["api", "flaky"]) assert.ok(served[key].length > 0 && served[key].every(([id, state]: [string | null, string]) => typeof id === "string" && id.startsWith("toolu_") && state === "ok"), `${key}: ${JSON.stringify(served[key])}`);
            assert.ok(served["web"].length > 0 && served["web"].every(([id, state]: [string | null, string]) => typeof id === "string" && id.startsWith("call_") && state === "omitted"), `web: ${JSON.stringify(served["web"])}`);
            assert.ok(served["omp"].length > 0 && served["omp"].every(([id, state]: [string | null, string]) => id === null && state === "omitted"), `omp: ${JSON.stringify(served["omp"])}`);
            const head = page.locator(".chat-turn-agent .work-block-head").last();
            if (await head.getAttribute("aria-expanded") === "false") await head.click();
            await page.locator("[data-todo-group]").waitFor();
            const [curated] = await groups(page);
            assert.match(curated!.head, /^Plan 2 updates · 1\/3 done$/, "a curated Claude run claims its ok list");
            await page.close();
            for (const [pane, name] of [[panes.web, "Codex"], [panes.omp, "omp"]] as const) {
              const other = await open(context, base, pane);
              const block = other.locator(".chat-turn-agent .work-block-head").first();
              if (await block.getAttribute("aria-expanded") === "false") await block.click();
              await other.locator("[data-todo-group]").waitFor();
              const [run] = await groups(other);
              assert.match(run!.head, /outcome not recorded/, `a curated ${name} run claims no success: ${run!.head}`);
              await other.close();
            }
            console.log("PASS curated demo chats carry Claude ids and ok, Codex ids alone, omp neither; only Claude's run claims its list");
          }

          // Claude: pending calls, then their results appended and a third call, then the page polled again
          const page = await open(context, base, panes.flaky);
          const errors: string[] = [];
          page.on("pageerror", (error) => errors.push(error.message));
          await feed(page, S.pending, 1);
          let [run] = await groups(page);
          const firstId = run!.id;
          if (en) assert.equal(run!.head, "Plan 2 updates · no update completed 2 pending", label);
          await shoot(page, config, "pending");
          await expand(page);
          if (en) {
            [run] = await groups(page);
            assert.equal(run!.caption, "No update has completed, so there is no current list.");
            assert.deepEqual(run!.list, [], "no list is invented from pending calls");
          }
          // the reader is on the run: it keeps its row, its opening and the focus through what follows
          await page.locator("[data-todo-group] > .work-row-head").focus();
          await page.locator("[data-todo-group]").evaluate((node) => { (node as HTMLElement & { mark?: boolean }).mark = true; });
          await feed(page, S.append, 1);
          [run] = await groups(page);
          assert.equal(run!.id, firstId, `${label}: the run keeps its identity through append`);
          assert.equal(run!.expanded, true, `${label}: the run stays open through append`);
          assert.equal(await page.locator("[data-todo-group]").evaluate((node) => (node as HTMLElement & { mark?: boolean }).mark === true && document.activeElement === node.querySelector(":scope > .work-row-head")), true, `${label}: same node and focus after append`);
          if (en) {
            assert.equal(run!.head, "Plan 3 updates · 1/3 done 1 pending 1 failed");
            assert.equal(run!.caption, "Current list");
            assert.deepEqual(run!.list, STEPS);
            assert.deepEqual(run!.attempts.map((text) => /\b(succeeded|failed|pending|outcome not recorded)\b/.exec(text)?.[1]), ["succeeded", "failed", "pending"]);
          }
          await shoot(page, config, "streamed-append");
          await measure(page, config, "streamed-append");
          // the next poll: the same content parsed anew
          await feed(page, S.append, 1, true);
          [run] = await groups(page);
          assert.equal(run!.id, firstId);
          assert.equal(await page.locator("[data-todo-group]").evaluate((node) => (node as HTMLElement & { mark?: boolean }).mark === true && document.activeElement === node.querySelector(":scope > .work-row-head")), true, `${label}: same node and focus after the poll`);
          await shoot(page, config, "expanded");
          await page.locator("[data-todo-group] > .work-row-head").blur();
          await collapse(page);
          await shoot(page, config, "collapsed");
          await measure(page, config, "collapsed");
          // interaction states of the disclosure
          // focus after a key press is keyboard focus, as Tab gives it
          await page.keyboard.press("Shift");
          await page.locator("[data-todo-group] > .work-row-head").focus();
          assert.equal(await page.locator("[data-todo-group] > .work-row-head").evaluate((node) => node.matches(":focus-visible")), true, `${label}: keyboard focus is visible`);
          await shoot(page, config, "focus-visible");
          await page.locator("[data-todo-group] > .work-row-head").blur();
          if (!config.phone) {
            await page.locator("[data-todo-group] > .work-row-head").hover();
            await shoot(page, config, "hover");
          }
          const box = (await page.locator("[data-todo-group] > .work-row-head").boundingBox())!;
          if (config.phone) assert.ok(box.height >= 44 && box.width >= 44, `${label}: disclosure target ${box.width}x${box.height}`);
          await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
          await page.mouse.down();
          await shoot(page, config, "pressed");
          await page.mouse.up();
          await page.locator("[data-todo-group] .work-todo-attempts").waitFor();
          await page.mouse.move(0, 0);
          if (config.phone) {
            const targets = await page.locator("[data-todo-group] .work-todo-attempts .work-row-head").evaluateAll((nodes) => nodes.map((node) => node.getBoundingClientRect().height));
            assert.ok(targets.every((height) => height >= 44), `${label}: attempt rows ${JSON.stringify(targets)}`);
          }
          await noSidewaysScroll(page, `${label} append`);
          console.log(`PASS ${label}: Claude pending calls, appended results and a poll keep one open, focused run with its id; ok, failed and pending apart`);

          // narration and hidden thinking end a run: the two before the narration fold, the one
          // between it and the thinking stays a row, the two after fold
          await feed(page, S.narration, 2);
          await expand(page);
          const split = await groups(page);
          const rowKey = await page.locator(".chat-virtual-row").filter({ has: page.locator("[data-todo-group]") }).getAttribute("data-chat-row");
          assert.deepEqual(split.map((group) => group.id), [JSON.stringify([rowKey, "toolu_n1"]), JSON.stringify([rowKey, "toolu_n4"])], `${label}: named by the turn row and each run's first call`);
          run = split[1];
          assert.equal(await page.locator(".work-narration", { hasText: PROSE }).count(), 1, "the narration stays in the open");
          assert.equal(await page.locator(".chat-turn-agent .work-block-rows > .work-row:not(.work-row-thinking)").count(), 3, "the first run of two folds, the one alone stays a row, then the last run");
          if (en) assert.deepEqual(split.map((group) => group.head), ["Plan 2 updates · 1/3 done", "Plan 2 updates · 2/3 done 1 failed"]);
          await shoot(page, config, "narration-boundary", true);
          await noSidewaysScroll(page, `${label} narration`);

          // a later pending and a failed call never stand for the list: the earlier ok one does
          await feed(page, S.failed, 1);
          await expand(page);
          [run] = await groups(page);
          if (en) {
            assert.equal(run!.head, "Plan 3 updates · 1/3 done 1 pending 1 failed");
            assert.deepEqual(run!.list, STEPS);
          }
          assert.equal(run!.failedClipped, false, `${label}: the failure count is never cut`);
          await shoot(page, config, "failed-latest");
          await measure(page, config, "failed-latest");

          await feed(page, S.allFailed, 1);
          await expand(page);
          [run] = await groups(page);
          if (en) assert.equal(run!.head, "Plan 2 updates · no update completed 2 failed");
          assert.deepEqual(run!.list, []);
          await shoot(page, config, "all-failed");

          await feed(page, S.unreadable, 1);
          await expand(page);
          [run] = await groups(page);
          if (en) {
            assert.equal(run!.head, "Plan 2 updates · latest list unreadable");
            assert.equal(run!.caption, "The latest successful update's list can't be read. An earlier list is not shown in its place.");
          }
          assert.deepEqual(run!.list, [], "an earlier list never stands in for an unreadable one");
          await shoot(page, config, "unreadable");

          await feed(page, S.identical, 1);
          await expand(page);
          [run] = await groups(page);
          assert.equal(run!.attempts.length, 2, "identical calls stay two attempts");

          await feed(page, S.long, 1);
          await expand(page);
          await noSidewaysScroll(page, `${label} long labels`);
          await shoot(page, config, "long-labels");
          // the end of the chat, scrolled to
          await shoot(page, config, "list-end", true);
          console.log(`PASS ${label}: narration and hidden thinking split runs; failed, all-failed, unreadable, identical and long runs read right`);

          // an observer reads the same runs
          await feed(page, S.narration, 2);
          await page.evaluate(() => { for (const socket of (window as unknown as { todoSockets: Set<{ send: (text: string) => void; readyState: number }> }).todoSockets) if (socket.readyState === 1) socket.send(JSON.stringify({ type: "role", mode: "observe" })); });
          await expand(page);
          assert.equal(await page.locator(".work-narration", { hasText: PROSE }).count(), 1);
          await shoot(page, config, "observe-readonly", true);
          // the PC goes away: what was drawn stays readable
          await page.evaluate(() => {
            const view = window as unknown as { todoOffline: boolean; todoSockets: Set<{ close: () => void }> };
            view.todoOffline = true;
            for (const socket of view.todoSockets) socket.close();
          });
          await page.locator(".conn-live").waitFor({ state: "detached", timeout: 10_000 });
          assert.equal(await page.locator("[data-todo-group]").count(), 2, "an offline chat keeps the runs");
          assert.equal(await page.locator(".work-narration", { hasText: PROSE }).count(), 1, "and the narration");
          await shoot(page, config, "offline", true);
          console.log(`PASS ${label}: observe-only and offline transcripts keep the run and the narration readable`);
          assert.deepEqual(errors, []);
          await page.close();

          // Codex: pending until its output, then no state; never a success claim, whatever the output says
          const codexPage = await open(context, base, panes.web);
          await feed(codexPage, S.codexPending, 1);
          [run] = await groups(codexPage);
          const codexId = run!.id;
          if (en) assert.equal(run!.head, "Plan 2 updates · no update completed 2 pending");
          await feed(codexPage, S.codexDone, 1);
          await expand(codexPage);
          [run] = await groups(codexPage);
          assert.equal(run!.id, codexId, `${label}: the Codex run keeps its identity`);
          if (en) {
            assert.equal(run!.head, "Plan 2 updates · 1/3 done, outcome not recorded");
            assert.equal(run!.caption, "Latest list. The transcript does not record whether this update succeeded.");
            assert.ok(run!.attempts.every((text) => text.endsWith("outcome not recorded")), JSON.stringify(run!.attempts));
          }
          assert.deepEqual(run!.list, STEPS);
          await shoot(codexPage, config, "codex-no-success");
          await feed(codexPage, S.codexAfterOk, 1);
          [run] = await groups(codexPage);
          if (en) assert.equal(run!.head, "Plan 2 updates · 2/3 done, outcome not recorded", "a completed snapshot after an older ok one claims nothing");
          await codexPage.close();

          // an agent that records neither field
          const ompPage = await open(context, base, panes.omp);
          await feed(ompPage, S.legacy, 1);
          await expand(ompPage);
          [run] = await groups(ompPage);
          assert.equal(run!.id, JSON.stringify([await ompPage.locator(".chat-virtual-row").filter({ has: ompPage.locator("[data-todo-group]") }).getAttribute("data-chat-row"), "#0"]), `${label}: a run without ids is named by its row and first index`);
          if (en) {
            assert.equal(run!.head, "Plan 2 updates · 1/3 done, outcome not recorded");
            assert.ok(!run!.attempts.some((text) => text.includes("succeeded")));
          }
          await shoot(ompPage, config, "legacy");
          await ompPage.close();
          console.log(`PASS ${label}: Codex pending then omitted state and an agent without the fields never claim success`);
        } finally { await context.close(); }
      }
    } finally { await browser.close(); }
  } finally { server.stop(true); }
  if (evidence !== null) {
    writeFileSync(join(evidence, "todo-snapshots-shots.json"), `${JSON.stringify(shots, null, 2)}\n`);
    writeFileSync(join(evidence, "todo-snapshots-measurements.json"), `${JSON.stringify(measurements, null, 2)}\n`);
  }
} finally { rmSync(app, { recursive: true, force: true }); }
