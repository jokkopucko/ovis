/**
 *   bun scripts/ideal-state-behaviour-qa.ts [--only IS-007,IS-042]
 *
 * One probe per check prints `PASS|FAIL|NA IS-0xx <measured value>`; the exit code is 1 when any probe
 * fails. NA names what the demo cannot stage without a product change. A check the owner decided to leave
 * as it is (OWNER_ROWS) is still measured and prints `OWNER IS-0xx <measured value> (<decision file>)`,
 * which fails nothing unless its probe itself breaks.
 */
import type { Page } from "playwright-core";
import { KO } from "../src/lib/i18n.ko.ts";
import { panes, startDemo, type Demo } from "./ideal-state-behaviour-harness.ts";
import { probeIdleState } from "./ideal-state-idle.ts";

type Verdict = { status: "PASS" | "FAIL" | "NA"; value: string; broke?: true };
const OWNER_ROWS: Readonly<Record<string, string>> = { "IS-016": "owner-decisions-added.md" };
const label = (text: string): string => KO[text] ?? text;
const verdict = (pass: boolean, value: string): Verdict => ({ status: pass ? "PASS" : "FAIL", value });
const current = ".pane-frame.is-current";
const PROMPT_PANES = { codex: panes.web, claude: panes.flaky, pi: panes.cli } as const;
const MAX_ROW_HEIGHT_IN_LINES = 1.5;
const SILENT_MINUTES = 30;
const CLICK_RESPONSE_MS = 100;
const LONG_TRANSCRIPT_TURNS = 10_000;
const MAX_TRANSCRIPT_NODES = 1_000;
const HIDDEN_WATCH_MS = 10_000;
const FIRST_PAINT_MS = 1_000;

const probe = (page: Page) => page.evaluate.bind(page);
const finishTurn = (page: Page) => page.evaluate(() => (window as unknown as { __probe: { finishTurn(): void } }).__probe.finishTurn());
const setStatus = (page: Page, pane: string, status: string) => page.evaluate(([id, to]) => (window as unknown as { __probe: { status(p: string, s: string): void } }).__probe.status(id, to), [pane, status] as const);
const rowState = (page: Page, pane: string) => page.locator(`.agent-item[data-pane="${pane}"] .agent-row-state [class*="badge-"]`).first();
const drawnAgents = (page: Page, hovered: string) => probe(page)((pane) => ({
  order: [...document.querySelectorAll<HTMLElement>(".agent-item[data-pane]")].filter((row) => row.getBoundingClientRect().height > 0).map((row) => row.dataset["pane"]!),
  top: Math.round(document.querySelector(`.agent-item[data-pane="${pane}"]`)!.getBoundingClientRect().top),
}), hovered);
const timed = (page: Page, act: string, done: string) => probe(page)(async ([actSelector, doneSelector]) => {
  const start = performance.now();
  (document.querySelector(actSelector) as HTMLElement).click();
  while (document.querySelector(doneSelector) === null) {
    if (performance.now() - start > 2_000) return -1;
    await new Promise((frame) => requestAnimationFrame(frame));
  }
  return Math.round(performance.now() - start);
}, [act, done] as const);

const PROBES: Record<string, (demo: Demo) => Promise<Verdict>> = {
  "IS-007": async (demo) => {
    const { context, page } = await demo.open({ pane: panes.api });
    try {
      const block = page.locator(`${current} .work-block`).last();
      await page.locator(`${current} .work-block.is-live`).waitFor();
      const before = (await block.locator(".work-block-head").textContent())!.trim();
      await finishTurn(page);
      await page.locator(`${current} .work-block.is-live`).waitFor({ state: "detached" });
      const after = (await block.locator(".work-block-head").textContent())!.trim();
      const folded = await block.evaluate((node) => node.classList.contains("is-folded"));
      await block.locator(".work-block-head").click();
      const rows = await block.locator(".work-row-head").evaluateAll((heads) => heads.map((head) => head.getBoundingClientRect().height / parseFloat(getComputedStyle(head).lineHeight)));
      const tallest = Math.max(...rows);
      const done = new RegExp(label("Worked for {duration}").replace("{duration}", ".+"));
      const pass = before.startsWith(label("Working…")) && done.test(after) && folded && rows.length > 0 && tallest <= MAX_ROW_HEIGHT_IN_LINES;
      return verdict(pass, `"${before}" -> "${after}"; folded=${folded}; ${rows.length} rows, tallest ${tallest.toFixed(2)} lines`);
    } finally { await context.close(); }
  },
  "IS-010": async (demo) => {
    const shapes: Record<string, string> = {};
    for (const [kind, pane] of Object.entries(PROMPT_PANES)) {
      const prompt = { id: `probe-${kind}`, agent: kind, kind: "question", title: "저장소 선택", question: "멱등성 키를 어디에 저장할까요?", body: null, options: [{ label: "Postgres", description: "같은 데이터베이스" }, { label: "Redis", description: null }], multi_select: false, custom_option_index: null };
      const { context, page } = await demo.open({ pane, stage: { prompts: { [pane]: prompt } } });
      try {
        await page.locator(`${current} .composer`).first().waitFor();
        await setStatus(page, pane, "blocked");
        await page.locator(".prompt-card").getByText(prompt.question, { exact: true }).waitFor();
        shapes[kind] = await page.locator(".prompt-card").evaluate((card, agent) => [card, ...card.querySelectorAll("*")]
          .filter((node) => node.closest(".agent-mark") === null)
          .map((node) => `${node.tagName}.${[...node.classList].filter((name) => !name.includes(agent)).sort().join(".")}`).join(" "), kind);
      } finally { await context.close(); }
    }
    const distinct = new Set(Object.values(shapes)).size;
    return verdict(distinct === 1, `${Object.keys(shapes).join(", ")}: ${distinct} distinct card class structure(s), ${Object.values(shapes)[0]!.split(" ").length} elements`);
  },
  "IS-016": async (demo) => {
    const { context, page } = await demo.open({ pane: panes.api, clock: true });
    try {
      await page.locator(`${current} .work-block.is-live .work-block-elapsed`).waitFor();
      const before = await rowState(page, panes.api).getAttribute("class");
      await page.clock.fastForward(`${SILENT_MINUTES}:00`);
      await page.waitForFunction((minutes) => Number(/(\d+)분/.exec(document.querySelector(".pane-frame.is-current .work-block.is-live .work-block-elapsed")?.textContent ?? "")?.[1] ?? 0) >= minutes, SILENT_MINUTES, { polling: 100 });
      const row = await rowState(page, panes.api).getAttribute("class");
      const tab = await page.locator(".header-tabs .tab-strip-item.is-active .tab-strip-dot").getAttribute("data-status");
      const working = /badge-working/.test(row ?? "") || tab === "working";
      return verdict(!working, `+${SILENT_MINUTES} min, no output: row "${before}" -> "${row}", tab dot ${tab}`);
    } finally { await context.close(); }
  },
  "IS-018": probeIdleState,
  "IS-042": async (demo) => {
    const { context, page } = await demo.open({ pane: panes.api });
    try {
      await rowState(page, panes.web).waitFor();
      await page.locator(`.agent-item[data-pane="${panes.web}"] .agent-row`).hover();
      const before = await drawnAgents(page, panes.web);
      await setStatus(page, panes.hermes, "blocked");
      await page.locator(`.agent-item[data-pane="${panes.hermes}"] .agent-row-state .badge-blocked`).waitFor({ state: "attached" });
      const after = await drawnAgents(page, panes.web);
      const kept = after.order.filter((pane) => before.order.includes(pane)).join(",") === before.order.join(",") && after.top === before.top;
      const selected = await page.locator(".agent-item.is-selected").getAttribute("data-pane");
      return verdict(kept && selected === panes.api, `hovering ${panes.web}, ${panes.hermes} -> blocked: drawn rows [${before.order}] -> [${after.order}], hovered row top ${before.top} -> ${after.top}px; selected ${selected}`);
    } finally { await context.close(); }
  },
  "IS-050": async (demo) => {
    const { context, page } = await demo.open({ pane: panes.api });
    try {
      const grip = page.locator(".sidebar-resizer");
      const width = () => grip.evaluate((node) => Math.round(node.parentElement!.getBoundingClientRect().width));
      const box = (await grip.boundingBox())!;
      const x = box.x + box.width / 2, y = box.y + box.height / 2;
      const start = await width();
      await page.mouse.move(x, y);
      await page.mouse.down();
      await page.mouse.move(x + 30, y, { steps: 3 });
      await page.waitForFunction((was) => Math.round(document.querySelector(".sidebar-resizer")!.parentElement!.getBoundingClientRect().width) !== was, start);
      const dragged = await width();
      await grip.dispatchEvent("pointercancel", { pointerId: 1, pointerType: "mouse", isPrimary: true });
      await page.mouse.move(x + 90, y, { steps: 3 });
      const stray = await width();
      await page.mouse.up();
      await page.mouse.move(x + 30, y);
      await page.mouse.down();
      await page.mouse.move(x + 70, y, { steps: 4 });
      await page.mouse.up();
      await page.waitForFunction((was) => Math.round(document.querySelector(".sidebar-resizer")!.parentElement!.getBoundingClientRect().width) !== was, stray).catch(() => undefined);
      const end = await width();
      const pass = dragged === start + 30 && stray === dragged && Math.abs(end - (dragged + 40)) <= 2;
      return verdict(pass, `sidebar ${start}px -> drag ${dragged}px -> pointercancel, stray move ${stray}px -> second drag ${end}px (expected ${dragged + 40}px)`);
    } finally { await context.close(); }
  },
  "IS-076": async (demo) => {
    const { context, page } = await demo.open({ pane: panes.api, query: "&crash=pane", ready: ".error-state" });
    try {
      const message = page.locator(".error-state").filter({ hasText: label("This pane can't be shown.") }).first();
      await message.waitFor();
      const recover = await message.evaluate((node) => node.closest(".sidebar-shell, .app-header") === null ? node.querySelectorAll("button").length : 0);
      const sidebarMs = await timed(page, `.agent-item[data-pane="${panes.web}"] .agent-row`, `.agent-item.is-selected[data-pane="${panes.web}"]`);
      const headerMs = await timed(page, ".app-header .sidebar-toggle", ".app-header .sidebar-toggle[aria-pressed=\"false\"]");
      const pass = recover > 0 && sidebarMs >= 0 && sidebarMs <= CLICK_RESPONSE_MS && headerMs >= 0 && headerMs <= CLICK_RESPONSE_MS;
      return verdict(pass, `pane render error: local message with ${recover} recover control(s); sidebar row click ${sidebarMs} ms, header toggle ${headerMs} ms`);
    } finally { await context.close(); }
  },
  "IS-085": async (demo) => {
    const { context, page } = await demo.open({ pane: panes.api });
    try {
      await page.evaluate(() => { const asked = { n: 0 }; (window as unknown as { __asked: typeof asked }).__asked = asked; window.confirm = () => { asked.n++; return true; }; });
      const confirms = () => page.evaluate(() => document.querySelectorAll("[role=alertdialog], .confirm-dialog").length + (window as unknown as { __asked: { n: number } }).__asked.n);
      const seen: string[] = [];
      const step = async (name: string, act: () => Promise<unknown>) => {
        try { await act(); } catch (error) { throw new Error(`${name}: ${String(error instanceof Error ? error.message : error).split("\n")[0]}`); }
        seen.push(`${name} ${await confirms()}`);
      };
      const tab = page.locator(".header-tabs .tab-strip-tab").first();
      const item = (name: string) => page.locator(".row-menu").getByRole("menuitem", { name });
      await step("rename-tab", async () => { await tab.click({ button: "right" }); await item(label("Rename tab")).click(); await page.locator(".tab-strip-rename").fill("probe-tab"); });
      await step("saved", async () => { await page.keyboard.press("Enter"); await page.locator(".header-tabs .tab-strip-tab").filter({ hasText: "probe-tab" }).waitFor(); });
      await step("move-picker", async () => { await tab.click({ button: "right" }); await item(label("Move to workspace…")).click(); await item("export-guard").waitFor(); });
      await step("moved", async () => { await item("export-guard").click(); await page.waitForFunction(() => ![...document.querySelectorAll(".header-tabs [role=tablist]")].some((list) => list.getAttribute("aria-label")?.startsWith("checkout-api") && list.textContent?.includes("probe-tab"))); });
      const total = seen.reduce((sum, step) => sum + Number(step.split(" ").at(-1)), 0);
      return verdict(total === 0, `confirmations per step: ${seen.join(", ")}`);
    } finally { await context.close(); }
  },
  "IS-091": async (demo) => {
    const now = Date.now();
    const turns = Array.from({ length: LONG_TRANSCRIPT_TURNS }, (_, index) => {
      const ts = new Date(now - (LONG_TRANSCRIPT_TURNS - index) * 60_000).toISOString();
      return index % 2 === 0
        ? { role: "user", ts, parts: [{ kind: "text", text: `질문 ${index}: 재시도 예산을 확인해 줘.` }] }
        : { role: "assistant", ts, end_ts: ts, parts: [{ kind: "text", phase: "final_answer", text: `답변 ${index}: 재시도는 세 번까지, 4xx는 다시 시도하지 않습니다.` }] };
    });
    const { context, page } = await demo.open({ pane: panes.flaky, stage: { turns: { [panes.flaky]: turns } } });
    try {
      await page.locator(`${current} .chat-turn`).filter({ hasText: `답변 ${LONG_TRANSCRIPT_TURNS - 1}:` }).waitFor({ timeout: 60_000 });
      const nodes = await page.evaluate(() => document.querySelectorAll(".pane-frame.is-current .chat-transcript *").length);
      return verdict(nodes < MAX_TRANSCRIPT_NODES, `${LONG_TRANSCRIPT_TURNS} turns staged: ${nodes} transcript elements`);
    } finally { await context.close(); }
  },
  "IS-092": async (demo) => {
    // Playwright keeps every page visible (headless or not, a second tab or a minimised window alike), so the
    // page is told it is hidden the way a browser tells it: document.hidden and a visibilitychange event
    const { context, page } = await demo.open({ pane: panes.api });
    try {
      await page.locator(`${current} .work-block.is-live`).waitFor();
      await page.evaluate(() => {
        const counts = { asked: 0, ran: 0 };
        (window as unknown as { __frames: typeof counts }).__frames = counts;
        const ask = window.requestAnimationFrame.bind(window);
        window.requestAnimationFrame = (callback) => { counts.asked++; return ask((at) => { counts.ran++; callback(at); }); };
        Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
        Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
        document.dispatchEvent(new Event("visibilitychange"));
      });
      await finishTurn(page);
      await setStatus(page, panes.web, "idle");
      // fixed wait: the check is what a hidden tab runs in this time
      await Bun.sleep(HIDDEN_WATCH_MS);
      const frames = await page.evaluate(() => (window as unknown as { __frames: { asked: number; ran: number } }).__frames);
      return verdict(frames.asked === 0, `hidden ${HIDDEN_WATCH_MS / 1000} s (document.hidden), with an output event and a status change: ${frames.asked} animation frames requested, ${frames.ran} ran`);
    } finally { await context.close(); }
  },
  "IS-094": async (demo) => {
    const { context, page } = await demo.open({ pane: panes.api });
    try {
      await page.locator(`${current} .work-block.is-live`).waitFor();
      const ms = await page.evaluate(async () => {
        const answer = () => [...document.querySelectorAll(".pane-frame.is-current .chat-transcript .markdown")].some((node) => node.textContent?.includes("6 tests pass"));
        if (answer()) return -2;
        const start = performance.now();
        (window as unknown as { __probe: { finishTurn(): void } }).__probe.finishTurn();
        while (!answer()) {
          if (performance.now() - start > 5_000) return -1;
          await new Promise((frame) => requestAnimationFrame(frame));
        }
        return Math.round(performance.now() - start);
      });
      return verdict(ms >= 0 && ms <= FIRST_PAINT_MS, ms === -2 ? "the answer was drawn before the output event" : ms < 0 ? "no answer drawn within 5 s of the output event" : `answer drawn ${ms} ms after the demo's output event`);
    } finally { await context.close(); }
  },
};

const only = process.argv.includes("--only") ? process.argv[process.argv.indexOf("--only") + 1]!.split(",") : null;
for (const id of only ?? []) if (!(id in PROBES)) throw new Error(`--only ${id}: one of ${Object.keys(PROBES).join(", ")}`);
const demo = await startDemo();
let failed = false;
try {
  for (const [id, run] of Object.entries(PROBES)) {
    if (only && !only.includes(id)) continue;
    const result = await run(demo).catch((error: unknown): Verdict => ({ status: "FAIL", value: `probe error: ${String(error instanceof Error ? error.message : error).split("\n")[0]}`, broke: true }));
    const decision = OWNER_ROWS[id];
    if (decision !== undefined && result.broke !== true) { console.log(`OWNER ${id} ${result.value} (${decision})`); continue; }
    if (result.status !== "PASS") failed = true;
    console.log(`${result.status} ${id} ${result.value}`);
  }
} finally {
  await demo.close();
}
process.exit(failed ? 1 : 0);
