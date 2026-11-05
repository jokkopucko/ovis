import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Page } from "playwright-core";
import { browserEvidencePage, browserEvidenceTracing, startBrowserEvidence } from "./browser-evidence.ts";
import type { BrowserEvidenceSession } from "./browser-evidence.ts";
import { appFaces } from "./app-faces.ts";
import panes from "../site/demo/fixtures/panes.json";
import { buildDemoApp } from "./demo-build.ts";
import { chromePath } from "./chrome-path.ts";

// The prompt card's place, on the unmodified app over the demo's fixture transport: the demo's
// "web" pane has an approval open. A second, tall form (steps, reference text, descriptions, a
// custom answer) is answered by this script in the transport's place, for the "web" pane, and a
// prompt of another pane the same way (window.panePrompts). All files and HTTP traffic stay in
// this disposable, loopback-only app; no herdr session is opened.
// PROMPT_DOCK_SHOTS=<dir> also saves a screenshot of each state there.
const repo = join(import.meta.dir, "..");
const app = mkdtempSync(join(tmpdir(), "herdr-prompt-dock-demo-"));
const shots = process.env.PROMPT_DOCK_SHOTS ?? null;
const evidenceDirectory = process.env.CHECK_BROWSER_EVIDENCE_DIR;
const evidenceTrace = process.env.CHECK_BROWSER_EVIDENCE_TRACE === "1";

/** omo's form on its second question, as server/prompt.ts hands it over */
const FORM = {
  id: "demo-form", agent: "omo", kind: "question", title: "Question 2 of 3",
  question: "Which store should hold the rate-limit counters for the export button?",
  body: ["export.rateLimit:", "  window: 30s", "  max: 1", "  key: user.id + report.id", "  store: ?            # memory | redis | postgres", "  onLimit: 429 + Retry-After", "  audit: true", "  tests: reports.export.spec.ts"].join("\n"),
  options: [
    { label: "In memory", description: "Simplest; counters reset on deploy and are per instance." },
    { label: "Redis (Recommended)", description: "Shared across instances; the cluster already runs one." },
    { label: "Postgres", description: "No new dependency, one extra write per export." },
    { label: "Type your own answer", description: null },
  ],
  multi_select: false, custom_option_index: 3,
  steps: [{ label: "Scope", answered: true, current: false }, { label: "Store", answered: false, current: true }, { label: "Rollout", answered: false, current: false }],
};
/** Claude's review of several answers, as server/prompt.ts hands it over: the pane wrapped the
 * second question, and the card reads it whole */
const ANSWERS_REVIEW = {
  id: "demo-review", agent: "claude", kind: "menu", title: "Review your answers", question: "Ready to submit your answers?", body: null,
  answers: [
    { question: "What should the two top-level rows be called?", answer: "Fictional repo names (Recommended)" },
    { question: "The demo's terminal replay (git log, bun test, the pretend shell) lives in the 'release' shell workspace. What happens to it?", answer: "Second tab in a repo (Recommended)" },
  ],
  options: [{ label: "Submit answers", description: null }, { label: "Cancel", description: null }],
  multi_select: false, custom_option_index: null,
};
/** the same form as a plan to approve: a typed pick waits for Confirm */
const PLAN = { ...FORM, id: "demo-plan", kind: "plan", title: "Ready to code?", steps: undefined };
/** the prompt that comes after one of those, while the answer to the first is still on its way */
const NEXT = { ...PLAN, id: "demo-next", title: "One more thing", question: "Which region should the counters live in?" };
/** another pane's prompt */
const OTHER = { ...PLAN, id: "demo-other", agent: "omo", title: "Proofread", question: "Which chapters should the proofread cover?" };
/** an option whose label is a whole review, as omo's parser hands it over: 2,166 characters */
const LONG_LABEL = "Approve with the changes the reviewer listed: keep the rate limit per user and report, move the counters to the shared store, and return Retry-After. ".repeat(15).slice(0, 2166);
const REVIEW = {
  id: "demo-review", agent: "omo", kind: "plan", title: "Review", question: "How should the review end?", body: null,
  options: [{ label: "Approve", description: null }, { label: LONG_LABEL, description: null }, { label: "Reject", description: null }],
  multi_select: false, custom_option_index: null,
};

interface Box { top: number; bottom: number; left: number; right: number }
interface Layout {
  inTranscript: boolean;
  inComposer: boolean;
  order: string[];
  card: Box;
  input: Box;
  transcript: Box;
  cardTop: boolean;
  queue: Box | null;
  cap: number;
  scrolls: boolean;
  pageScrolls: boolean;
  placeholder: string;
  badge: { text: string; width: number } | null;
  live: string | null;
  overscroll: string;
}

const layoutOf = (page: Page): Promise<Layout> => page.evaluate(() => {
  const box = (node: Element): { top: number; bottom: number; left: number; right: number } => {
    const rect = node.getBoundingClientRect();
    return { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right };
  };
  const card = document.querySelector<HTMLElement>(".prompt-card")!;
  const stack = document.querySelector(".terminal-stack")!;
  const queue = document.querySelector(".composer-queue");
  const badge = card.querySelector<HTMLElement>(".prompt-card-header .visually-hidden");
  const app = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--app-height")) || window.innerHeight;
  return {
    inTranscript: card.closest(".chat-view, [role=log]") !== null,
    inComposer: card.closest(".composer") !== null,
    // the stack's own children, in order: what stands over what
    order: [...stack.children].filter((node) => node.getBoundingClientRect().height > 0).map((node) => node.className.split(" ")[0]!),
    card: box(card),
    input: box(document.querySelector(".composer-surface")!),
    // the transcript's visible box: its scroller keeps its padding and is clipped by this one
    transcript: box(document.querySelector(".terminal-surface")!),
    cardTop: (() => { const rect = card.getBoundingClientRect(); return document.elementFromPoint(rect.left + rect.width / 2, rect.top + 4)?.closest(".prompt-card") === card; })(),
    queue: queue === null ? null : box(queue),
    cap: Math.max(app * 0.6, 240),
    scrolls: card.scrollHeight > card.clientHeight + 1,
    pageScrolls: document.documentElement.scrollHeight > window.innerHeight || document.documentElement.scrollWidth > window.innerWidth,
    placeholder: document.querySelector<HTMLTextAreaElement>(".composer-text")!.placeholder,
    badge: badge === null ? null : { text: badge.textContent ?? "", width: badge.getBoundingClientRect().width },
    live: card.closest("[aria-live]")?.getAttribute("aria-live") ?? null,
    overscroll: getComputedStyle(card).overscrollBehaviorY,
  };
});

/** What a press at the middle of an element's visible box lands on, as a class of the card. */
const hitOf = (page: Page, selector: string, at: "middle" | "bottom" = "middle"): Promise<{ hit: string | null; visible: boolean }> => page.evaluate(([target, where]) => {
  const node = [...document.querySelectorAll(target!)].at(-1)!;
  const card = document.querySelector(".prompt-card")!.getBoundingClientRect();
  const rect = node.getBoundingClientRect();
  const visible = rect.top >= card.top - 1 && rect.bottom <= card.bottom + 1;
  const x = rect.left + rect.width / 2;
  const y = where === "bottom" ? rect.bottom - 2 : rect.top + rect.height / 2;
  const found = document.elementFromPoint(x, y);
  return { hit: found?.closest(target!) === node ? "self" : found === null ? null : (found as HTMLElement).className || found.tagName, visible };
}, [selector, at] as const);

/** Scrolls the card (never the page) until the element is in its box, as a finger or a wheel would. */
const reach = async (page: Page, selector: string): Promise<{ hit: string | null; visible: boolean }> => {
  await page.evaluate((target) => {
    const card = document.querySelector<HTMLElement>(".prompt-card")!;
    const node = [...document.querySelectorAll<HTMLElement>(target)].at(-1)!;
    const sticky = card.querySelector<HTMLElement>(".prompt-card-confirm");
    // clear of what stays pinned on the card's fold: the confirm row and the fade under it
    const pinned = (sticky === null || sticky === node ? 0 : sticky.offsetHeight + 12) + 12;
    const over = node.getBoundingClientRect().bottom - (card.getBoundingClientRect().bottom - pinned);
    if (over > 0) card.scrollTop += over;
    const under = card.getBoundingClientRect().top - node.getBoundingClientRect().top;
    if (under > 0) card.scrollTop -= under;
  }, selector);
  return hitOf(page, selector);
};

const setPrompt = (page: Page, prompt: unknown): Promise<void> => page.evaluate((next) => { (window as unknown as { formPrompt: unknown }).formPrompt = next; }, prompt);
const setPanePrompt = (page: Page, pane: string, prompt: unknown): Promise<void> => page.evaluate(([at, next]) => { (window as unknown as { panePrompts: Record<string, unknown> }).panePrompts[at as string] = next; }, [pane, prompt] as const);
/** The delayed answers that have come back, and a little longer: what they change in the app has been drawn. */
const returned = async (page: Page, count: number): Promise<void> => {
  await page.waitForFunction((n) => (window as unknown as { formReturned: number }).formReturned >= n, count, { timeout: 15_000 });
  await page.waitForTimeout(300);
};
/** From now on, every card taken out of the dock is counted (window.cardsRemoved). */
const watchCards = (page: Page): Promise<void> => page.evaluate(() => {
  const counter = window as unknown as { cardsRemoved: number };
  counter.cardsRemoved = 0;
  new MutationObserver((records) => { for (const record of records) counter.cardsRemoved += [...record.removedNodes].filter((node) => node instanceof HTMLElement && node.classList.contains("prompt-card")).length; }).observe(document.querySelector(".prompt-dock")!, { childList: true });
});
const cardsRemoved = (page: Page): Promise<number> => page.evaluate(() => (window as unknown as { cardsRemoved: number }).cardsRemoved);
// the same row click the sidebar gets, without moving the focus the way a real click would
const select = async (page: Page, pane: string): Promise<void> => {
  const row = page.locator(`.pane-select[title^="${pane} —"]`).first();
  await row.waitFor({ state: "attached" });
  await row.evaluate((node: HTMLElement) => node.click());
  await page.locator(`.pane-select[title^="${pane} —"][aria-current="true"]`).first().waitFor({ state: "attached" });
};
/** The pinned Confirm row: its two buttons, its question's own box, and what it leaves of the card over it. */
const confirmRowOf = (page: Page): Promise<{ oneLine: boolean; height: number; over: number; text: { height: number; line: number; scrolls: boolean; whole: string } }> => page.evaluate(() => {
  const card = document.querySelector<HTMLElement>(".prompt-card")!;
  const row = card.querySelector<HTMLElement>(".prompt-card-confirm")!;
  const [confirm, cancel] = [...row.querySelectorAll<HTMLElement>(".btn")].map((node) => node.getBoundingClientRect());
  const text = row.querySelector<HTMLElement>(".prompt-card-confirm-text") ?? row.querySelector<HTMLElement>("span")!;
  return {
    oneLine: Math.abs(confirm!.top - cancel!.top) <= 1 && cancel!.left >= confirm!.right,
    height: row.getBoundingClientRect().height,
    over: row.getBoundingClientRect().top - card.getBoundingClientRect().top,
    text: { height: text.clientHeight, line: parseFloat(getComputedStyle(text).lineHeight), scrolls: text.scrollHeight > text.clientHeight + 1, whole: text.textContent ?? "" },
  };
});
const answersOf = (page: Page): Promise<Record<string, unknown>[]> => page.evaluate(() => (window as unknown as { formAnswers: Record<string, unknown>[] }).formAnswers);

try {
  await buildDemoApp(app);
  const index = join(app, "index.html");
  const html = readFileSync(index, "utf8");
  assert.match(html, /<script type="module"/);
  // The demo has one approval. While window.formPrompt is set, the "web" pane's prompt read
  // answers with it, and another pane's with window.panePrompts[pane]; an answer to either is
  // kept in window.formAnswers. Each pane has its own prompt, as on the server: one pane's read
  // or answer never touches another's. Everything else is the demo's.
  const form = `<script>(() => {
    const demo = window.fetch;
    const web = ${JSON.stringify(panes.web)};
    window.formPrompt = null;
    window.panePrompts = {};
    window.formAnswers = [];
    window.formNext = null;
    window.formDelay = 0;
    window.formReturned = 0;
    window.formReadFails = false;
    window.formFailedReads = 0;
    window.formReadHold = false;
    window.formHoldAfterFailure = false;
    const promptOf = (pane) => pane === web ? window.formPrompt : window.panePrompts[pane] ?? null;
    const json = (body, status = 200) => Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));
    window.fetch = (input, init) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, location.href);
      if (url.pathname === "/api/pane/prompt") {
        // window.formReadFails: reads of the screen fail as a dropped connection does
        // window.formReadHold: a read that never comes back, until a refused answer ends the hold; formHoldAfterFailure starts it after each failed read
        if (window.formReadHold) return new Promise(() => {});
        if (window.formReadFails) { window.formFailedReads += 1; if (window.formHoldAfterFailure) window.formReadHold = true; return Promise.reject(new TypeError("Failed to fetch")); }
        const prompt = promptOf(url.searchParams.get("pane_id"));
        if (prompt !== null) return json({ prompt, suggestion: null });
      }
      if (url.pathname === "/api/pane/prompt/answer") {
        const answer = JSON.parse(init.body);
        const prompt = promptOf(answer.pane_id);
        if (prompt !== null) {
          if (answer.prompt_id !== prompt.id) { window.formReadHold = false; return json({ error: { code: "prompt_changed", message: "the screen no longer shows that prompt" } }, 409); }
          window.formAnswers.push(answer);
          // window.formNext: the form's next question, on screen once the answer is back, as the server waits for it
          const next = answer.pane_id === web ? window.formNext : null;
          window.formNext = null;
          if (next === null) { if (answer.pane_id === web) window.formPrompt = null; else delete window.panePrompts[answer.pane_id]; }
          // window.formDelay: the answer takes that long to come back, as send_keys and the re-read do
          return new Promise((done) => setTimeout(done, window.formDelay || 0)).then(() => { if (next !== null) window.formPrompt = next; window.formReturned += 1; return json({ ok: true }); });
        }
      }
      return demo(input, init);
    };
  })();</script>`;
  writeFileSync(index, html.replace(/<script type="module"/, () => `<script src="./demo-transport.js"></script>\n    ${form}\n    <script type="module"`));

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
  const url = `http://127.0.0.1:${server.port}/herdr-web-ui/demo/app/?pane=${encodeURIComponent(panes.web)}`;
  if (shots !== null) mkdirSync(shots, { recursive: true });
  try {
    const browser = await chromium.launch({ executablePath: chromePath(), headless: true, args: ["--no-sandbox"] });
    try {
      interface Opened { page: Page; errors: string[]; shot: (name: string) => Promise<void>; close: () => Promise<void> }
      const evidenceByPage = new WeakMap<Page, BrowserEvidenceSession>();
      const preserveFailure = async (page: Page, error: unknown): Promise<never> => {
        const evidence = evidenceByPage.get(page);
        if (evidence) await evidence.captureFailure(error);
        throw error;
      };
      let evidenceSequence = 0;
      const open = async ({ width, height, touch = false, finePointer = false, held = [], prompt = null, theme = "dark", language = "en", settings = {} }: { width: number; height: number; touch?: boolean; finePointer?: boolean; held?: string[]; prompt?: unknown; theme?: string; language?: string; settings?: Record<string, unknown> }): Promise<Opened> => {
        const context = await browser.newContext({ viewport: { width, height }, locale: "en-US", hasTouch: touch, isMobile: touch && !finePointer });
        // a laptop with a touch screen: Chromium calls any screen with touch a coarse pointer, and
        // such a laptop's mouse is its first one. The app asks through matchMedia (useMediaQuery)
        if (finePointer) await context.addInitScript(() => {
          const media = window.matchMedia.bind(window);
          window.matchMedia = (query) => media(query === "(pointer: coarse)" ? "not all" : query);
        });
        await context.addInitScript(([owner, messages, settings]) => {
          localStorage.setItem("ovis:settings", settings!);
          // Enter sends, chosen, also on a phone (whose Return breaks the line by default): these cases answer
          // with the send key. A choice is kept in a key of its own (ENTER_SENDS_STORAGE_KEY in src/lib/settings.ts)
          const enterSends: unknown = JSON.parse(settings!).enterSends;
          if (typeof enterSends === "boolean") localStorage.setItem("ovis:enter-sends", String(enterSends));
          // held under the demo's herdr (site/demo/transport.ts), not an earlier release's (lib/paneLifetime.ts)
          localStorage.setItem("ovis:pane-lifetime:local", "demo-local");
          if (messages !== "") localStorage.setItem(`ovis:queue:${owner}`, messages!);
        }, [panes.web, held.length === 0 ? "" : JSON.stringify({ version: 1, messages: held.map((text, at) => ({ id: `m${at}`, text })) }), JSON.stringify({ language, theme, enterSends: true, ...settings })] as const);
        // a soft keyboard the script can raise: lib/viewport.ts reads navigator.virtualKeyboard
        if (touch) await context.addInitScript(() => {
          const keyboard = Object.assign(new EventTarget(), { height: 0 });
          Object.defineProperty(keyboard, "boundingRect", { get: () => new DOMRect(0, 0, 390, keyboard.height) });
          Object.defineProperty(navigator, "virtualKeyboard", { configurable: true, value: keyboard });
        });
        if (prompt !== null) await context.addInitScript((next) => { window.addEventListener("DOMContentLoaded", () => { (window as unknown as { formPrompt: unknown }).formPrompt = next; }); }, prompt);
        const page = await context.newPage();
        const evidence = evidenceDirectory ? await startBrowserEvidence({
          page: browserEvidencePage(page),
          tracing: browserEvidenceTracing(context),
          directory: evidenceDirectory,
          script: "prompt-dock-demo-regression",
          scenario: `page-${++evidenceSequence}-${width}x${height}-${theme}-${language}`,
          trace: evidenceTrace,
        }) : undefined;
        if (evidence) evidenceByPage.set(page, evidence);
        const errors: string[] = [];
        page.on("pageerror", (error) => errors.push(error.message));
        try {
          await page.goto(url);
          await page.locator(".conn-live").waitFor({ state: "attached" });
          await page.locator(".terminal-stack.is-chat").waitFor();
          if (prompt !== null) await setPrompt(page, prompt);
          await page.locator(".prompt-card").waitFor();
          if (prompt !== null) await page.locator(".prompt-card").getByText((prompt as { question: string }).question).waitFor();
          await appFaces(page);
          return {
            page,
            errors,
            close: async () => { if (evidence) await evidence.finish(); await context.close(); },
            shot: async (name) => { if (shots !== null) await page.screenshot({ path: join(shots, `${name}.png`) }); },
          };
        } catch (error) {
          if (evidence) await evidence.captureFailure(error);
          throw error;
        }
      };

      /** the card's place in the stack, the same at every size */
      const placed = (layout: Layout, label: string): void => {
        assert.equal(layout.inTranscript, false, `${label}: the card is outside the transcript`);
        assert.equal(layout.inComposer, false, `${label}: the card is not inside the message composer's group`);
        assert.equal(layout.live, "polite", `${label}: a prompt that arrives is announced`);
        assert.equal(layout.overscroll, "contain", `${label}: a drag past the card's top is not handed to the page (pull-to-refresh)`);
        const at = layout.order.indexOf("prompt-dock");
        assert.equal(layout.order[at + 1], "composer", `${label}: the input card is the next thing under the card (${layout.order.join(" > ")})`);
        assert.ok(layout.order.indexOf("terminal-surface") < at, `${label}: the transcript is over the card`);
        assert.ok(layout.card.bottom <= layout.input.top, `${label}: the card ends over the input card`);
        assert.ok(layout.input.top - layout.card.bottom <= 24, `${label}: nothing stands between them (${layout.input.top - layout.card.bottom}px)`);
        assert.ok(Math.abs(layout.card.left - layout.input.left) <= 1 && Math.abs(layout.card.right - layout.input.right) <= 1, `${label}: one column (${layout.card.left}–${layout.card.right} over ${layout.input.left}–${layout.input.right})`);
        assert.ok(layout.transcript.bottom <= layout.card.top + 1, `${label}: the transcript ends over the card`);
        assert.equal(layout.cardTop, true, `${label}: nothing of the transcript is painted over the card`);
        assert.ok(layout.card.bottom - layout.card.top <= layout.cap + 1, `${label}: the card keeps to its height (${layout.card.bottom - layout.card.top} of ${layout.cap})`);
        assert.equal(layout.pageScrolls, false, `${label}: the page itself does not scroll`);
        assert.deepEqual(layout.badge?.text, "input needed", `${label}: the badge is still read`);
        assert.ok(layout.badge!.width <= 1, `${label}: the badge is not drawn`);
      };

      for (const size of [{ width: 1440, height: 900 }, { width: 390, height: 844, touch: true }]) {
        for (const theme of ["dark", "light"]) {
          const { page, errors, shot, close } = await open({ ...size, theme });
          try {
            const layout = await layoutOf(page);
            placed(layout, `${size.width}x${size.height} ${theme}`);
            assert.equal(layout.scrolls, false, "a three-option approval is whole");
            assert.equal(layout.placeholder, "Type 1–3 to choose…");
            assert.equal(await page.evaluate(() => { const box = document.querySelector<HTMLTextAreaElement>(".composer-text")!; const probe = document.createElement("span"); probe.style.cssText = `position:absolute;visibility:hidden;white-space:nowrap;font:${getComputedStyle(box).font}`; probe.textContent = box.placeholder; document.body.append(probe); const fits = probe.getBoundingClientRect().width <= box.clientWidth - parseFloat(getComputedStyle(box).paddingLeft) - parseFloat(getComputedStyle(box).paddingRight); probe.remove(); return fits; }), true, "the placeholder is whole on one line");
            // the command is the card's mono box; the title, the card's one red, is its heading
            assert.equal(await page.locator(".prompt-card-body").textContent(), "git push origin feat/export-guard");
            assert.equal(await page.locator(".prompt-card-question").count(), 0, "a heading that is the question is said once");
            // every option weighs the same: none is filled or outlined as the default
            const weights = await page.locator(".prompt-card-option").evaluateAll((nodes) => nodes.map((node) => { const style = getComputedStyle(node); return `${style.backgroundColor}|${style.borderTopColor}|${style.fontWeight}`; }));
            assert.equal(new Set(weights).size, 1, `no option is emphasised: ${weights.join(" / ")}`);
            // the keycap draws the number alone; the option is still named as the agent's menu shows it
            assert.deepEqual(await page.locator(".prompt-card-number > [aria-hidden]").allTextContents(), ["1", "2", "3"]);
            for (const name of ["1. Yes", "2. Yes, and don't ask again for git push", "3. No, and tell Codex what to do differently"]) assert.equal(await page.locator(".prompt-card").getByRole("button", { name, exact: true }).count(), 1, name);
            // the card's last row is pressed at its bottom edge
            assert.deepEqual(await hitOf(page, ".prompt-card-option", "bottom"), { hit: "self", visible: true });
            // the open work block says who waits: the sidebar's words, a still red dot
            const head = await page.locator(".work-block.is-live .work-block-title").evaluate((node) => ({ text: node.textContent, waiting: node.closest(".work-block")!.classList.contains("is-waiting"), dot: getComputedStyle(node, "::before").animationName }));
            assert.deepEqual(head, { text: "Needs you", waiting: true, dot: "none" });
            assert.deepEqual(errors, []);
            await shot(`approval-${size.width}-${theme}`);
          } catch (error) { await preserveFailure(page, error); } finally { await close(); }
        }
      }
      console.log("PASS the approval card sits outside the transcript, directly over the input card on its column, at 1440 and 390, dark and light");

      {
        // nothing is answered without a press: Enter in an empty message box picks no option
        const { page, errors, close } = await open({ width: 1440, height: 900 });
        try {
          const box = page.locator(".composer-text");
          await box.focus();
          await box.press("Enter");
          await page.waitForTimeout(300); // fixed wait: an Enter in an empty box may answer nothing
          assert.equal(await page.locator(".prompt-card").count(), 1, "Enter in an empty box answers nothing");
          assert.equal(await page.locator(".prompt-card-confirm").count(), 0);
          // a typed number picks, and waits for Confirm in the card
          await box.fill("2");
          await box.press("Enter");
          await page.locator(".prompt-card-confirm").waitFor();
          assert.equal(await page.locator(".prompt-card-option.is-typed .prompt-card-option-label").textContent(), "Yes, and don't ask again for git push");
          assert.equal(await page.locator(".prompt-card").count(), 1, "a typed pick is not sent before Confirm");
          // the typed pick keeps its accent: the one row that is outlined and tinted
          // (the outline fades in: read it once the transition is over)
          await page.waitForFunction(() => document.querySelector(".prompt-card-option.is-typed")!.getAnimations().length === 0);
          const typed = await page.evaluate(() => { const style = (selector: string): CSSStyleDeclaration => getComputedStyle(document.querySelector(selector)!); return { row: style(".prompt-card-option.is-typed").borderTopColor, fill: style(".prompt-card-option.is-typed").backgroundColor, confirm: style(".prompt-card-confirm").borderTopColor, other: style(".prompt-card-option:not(.is-typed)").backgroundColor }; });
          assert.equal(typed.row, typed.confirm, "the typed option is outlined in the accent");
          assert.notEqual(typed.fill, typed.other, "and tinted");
          await page.locator(".prompt-card-confirm").getByRole("button", { name: "Cancel" }).click();
          assert.equal(await page.locator(".prompt-card-confirm").count(), 0);
          // keyboard order: the card's options come before the message box
          await page.getByRole("button", { name: "1. Yes", exact: true }).focus();
          for (let step = 0; step < 3; step += 1) await page.keyboard.press("Tab");
          assert.equal(await page.evaluate(() => document.activeElement?.closest(".composer") !== null), true, "Tab leaves the card into the composer");
          // a press on an option answers, and the keyboard's focus goes on to the message box
          await page.getByRole("button", { name: "1. Yes", exact: true }).click();
          await page.locator(".prompt-card").waitFor({ state: "detached" });
          assert.equal(await page.evaluate(() => document.activeElement?.className.split(" ")[0]), "composer-text");
          assert.equal(await page.locator(".prompt-dock").evaluate((node) => node.getBoundingClientRect().height), 0, "without a card its place takes no room");
          // but it is still rendered: a live region that appears together with its card is not read
          const region = await page.locator(".prompt-dock").evaluate((node) => ({ live: node.getAttribute("aria-live"), display: getComputedStyle(node).display, hidden: getComputedStyle(node).visibility, empty: node.childElementCount === 0, gap: node.getBoundingClientRect().bottom - document.querySelector(".composer")!.getBoundingClientRect().top }));
          assert.deepEqual(region, { live: "polite", display: "flex", hidden: "visible", empty: true, gap: 0 }, "the empty dock is an exposed live region, waiting for the next card, and adds no space");
          // the next prompt is an addition inside that region
          await setPrompt(page, FORM);
          await page.locator(".prompt-dock > .prompt-card").getByText(FORM.question).waitFor();
          assert.deepEqual(errors, []);
        } catch (error) { await preserveFailure(page, error); } finally { await close(); }
        console.log("PASS an empty Enter answers nothing, a typed pick waits for Confirm, a press answers and hands the focus to the message box");
      }

      for (const size of [{ width: 1280, height: 800 }, { width: 390, height: 844, touch: true }]) {
        for (const enterSends of [true, false]) {
          // the keyboard alone: with a typed pick waiting, the empty box's Escape is the card's Cancel
          // and its Enter the card's Confirm, so the hands never leave the keys
          const { page, errors, shot, close } = await open({ ...size, prompt: PLAN, settings: { enterSends } });
          try {
            const box = page.locator(".composer-text");
            const sendKey = enterSends ? "Enter" : "Control+Enter";
            await box.fill("2");
            await box.press(sendKey);
            await page.locator(".prompt-card-confirm").waitFor();
            await box.press("Escape");
            await page.locator(".prompt-card-confirm").waitFor({ state: "detached" });
            assert.equal(await page.locator(".prompt-card").count(), 1, "Escape cancels the pick, not the question");
            // a held Enter: its first press picks, and its repeats confirm nothing
            await box.fill("2");
            if (!enterSends) await page.keyboard.down("Control");
            await page.keyboard.down("Enter");
            await page.locator(".prompt-card-confirm").waitFor();
            await page.keyboard.down("Enter");
            await page.keyboard.up("Enter");
            if (!enterSends) await page.keyboard.up("Control");
            // a box holding only a space is not empty: its Enter keeps the pick waiting
            await box.fill(" ");
            await box.press(sendKey);
            // The fixture records an answer synchronously in fetch, before returning its promise.
            // Reading it after the completed key event needs no timing window.
            assert.deepEqual(await answersOf(page), [], "a held Enter, or an Enter over a space, does not confirm the pick");
            assert.equal(await page.locator(".prompt-card-confirm").count(), 1);
            // text in the box is a message being written: Escape there leaves the pick waiting
            await box.fill("never mind");
            await box.press("Escape");
            assert.equal(await page.locator(".prompt-card-confirm").count(), 1, "Escape over text keeps the pick");
            await box.fill("");
            await shot(`typed-pick-${size.width}-${enterSends ? "enter" : "ctrl-enter"}`);
            await box.press(sendKey);
            await page.locator(".prompt-card").getByText(PLAN.question).waitFor({ state: "detached" });
            assert.deepEqual(await answersOf(page), [{ pane_id: panes.web, prompt_id: "demo-plan", option_index: 1 }], "Enter in the empty box confirms the pick, once");
            assert.equal(await page.evaluate(() => document.activeElement?.className.split(" ")[0]), "composer-text", "and the focus stays in the box");
            assert.deepEqual(errors, []);
          } catch (error) { await preserveFailure(page, error); } finally { await close(); }
          console.log(`PASS a typed pick is confirmed with ${enterSends ? "Enter" : "Ctrl+Enter"}, or cancelled with Escape, at ${size.width}px`);
        }
      }

      {
        // held messages fold to their caption over the card: caption, card, input card
        const { page, errors, shot, close } = await open({ width: 1440, height: 900, held: ["Also cover a replay after the key has expired."] });
        try {
          await page.locator(".composer-queue-toggle").waitFor();
          const layout = await layoutOf(page);
          placed(layout, "held");
          assert.deepEqual(layout.order.slice(-3), ["composer-queue", "prompt-dock", "composer"]);
          assert.ok(layout.queue!.bottom <= layout.card.top, "the held caption is over the card");
          assert.ok(Math.abs(layout.queue!.left - layout.card.left) <= 1 && Math.abs(layout.queue!.right - layout.card.right) <= 1, "the caption and the card share the column");
          await shot("held-1440");
          // opened, the rows' buttons end over the card and are pressed, not the card
          await page.locator(".composer-queue-toggle").click();
          const opened = await layoutOf(page);
          placed(opened, "held rows opened");
          assert.ok(opened.queue!.bottom <= opened.card.top);
          assert.deepEqual(errors, []);
        } catch (error) { await preserveFailure(page, error); } finally { await close(); }
        console.log("PASS a held caption sits over the card, on its column");
      }

      // the tall form: steps, reference text, descriptions, a custom answer
      // ... and again at the largest chat font size, which the card follows
      for (const size of [{ width: 1440, height: 900 }, { width: 800, height: 600 }, { width: 390, height: 844, touch: true }, { width: 390, height: 500, touch: true }, { width: 1440, height: 900, font: 24 }, { width: 390, height: 844, touch: true, font: 24 }, { width: 390, height: 500, touch: true, font: 24 }]) {
        const label = `${size.width}x${size.height}${size.font ? ` at ${size.font}px` : ""}`;
        const { page, errors, shot, close } = await open({ ...size, prompt: PLAN, settings: size.font ? { chatFontSize: size.font } : {} });
        try {
          const layout = await layoutOf(page);
          placed(layout, label);
          assert.equal(layout.placeholder, "Type 1–3 or your own reply…");
          // a desktop window keeps some of the transcript in sight over the tallest card: two lines
          // of it at 800x600, where the card has its full 60%
          if (size.width >= 800) assert.ok(layout.transcript.bottom - layout.transcript.top >= 48, `${label}: the transcript keeps ${layout.transcript.bottom - layout.transcript.top}px`);
          // what the user answers with keeps its height: only the reference text gives way
          const parts = await page.evaluate(() => Object.fromEntries([".prompt-card-header", ".prompt-card-question", ".prompt-card-options", ".prompt-card-custom"].map((selector) => { const node = document.querySelector<HTMLElement>(selector)!; return [selector, node.offsetHeight >= node.scrollHeight]; })));
          assert.deepEqual(parts, { ".prompt-card-header": true, ".prompt-card-question": true, ".prompt-card-options": true, ".prompt-card-custom": true }, `${label}: nothing to answer with is squeezed`);
          const body = await page.locator(".prompt-card-body").evaluate((node) => ({ height: node.clientHeight, line: parseFloat(getComputedStyle(node).lineHeight) }));
          assert.ok(body.height >= 2 * body.line && body.height <= 6 * body.line + 20, `${label}: the reference text shows two to six lines (${body.height / body.line})`);
          // a typed pick: its Confirm row is in sight at once, whatever the card's scroll
          await page.locator(".composer-text").fill("2");
          await page.locator(".composer-text").press("Enter");
          await page.locator(".prompt-card-confirm").waitFor();
          assert.deepEqual(await hitOf(page, ".prompt-card-confirm .btn-primary"), { hit: "self", visible: true }, `${label}: Confirm is in sight and pressable`);
          // the pinned row is as short as it can be: Confirm and Cancel share one line
          assert.equal((await confirmRowOf(page)).oneLine, true, `${label}: Confirm and Cancel are on one line`);
          assert.deepEqual(await hitOf(page, ".prompt-card-confirm .btn:not(.btn-primary)"), { hit: "self", visible: true }, `${label}: Cancel is in sight and pressable`);
          await page.waitForFunction(() => document.querySelector(".prompt-card-option.is-typed")!.getAnimations().length === 0);
          await shot(`form-${label}`);
          // every option and the custom answer are reached by scrolling the card alone
          for (let option = 0; option < 3; option += 1) {
            const reached = await page.evaluate((at) => { document.querySelectorAll(".prompt-card-option")[at]!.setAttribute("data-reach", ""); return true; }, option);
            assert.ok(reached);
            assert.deepEqual(await reach(page, ".prompt-card-option[data-reach]"), { hit: "self", visible: true }, `${label}: option ${option + 1} is reachable`);
            await page.evaluate(() => document.querySelector("[data-reach]")!.removeAttribute("data-reach"));
          }
          assert.deepEqual(await reach(page, ".prompt-card-custom .input"), { hit: "self", visible: true }, `${label}: the custom answer is reachable`);
          assert.deepEqual(await reach(page, ".prompt-card-custom .btn"), { hit: "self", visible: true }, `${label}: its Send is reachable`);
          assert.deepEqual(await hitOf(page, ".prompt-card-confirm .btn-primary"), { hit: "self", visible: true }, `${label}: Confirm stays in sight while the card is scrolled`);
          assert.equal((await layoutOf(page)).pageScrolls, false, `${label}: only the card scrolled`);
          // Confirm sends the typed pick, once, through the answer endpoint
          await page.locator(".prompt-card-confirm").getByRole("button", { name: "Confirm" }).click();
          await page.locator(".prompt-card").getByText(PLAN.question).waitFor({ state: "detached" });
          assert.deepEqual(await answersOf(page), [{ pane_id: panes.web, prompt_id: "demo-plan", option_index: 1 }]);
          assert.deepEqual(errors, []);
        } catch (error) { await preserveFailure(page, error); } finally { await close(); }
        console.log(`PASS at ${label} the tall form's options, custom answer and Confirm are all reachable, and Confirm sends the pick once`);
      }

      {
        // omo's form: step chips, a recommended tag kept as the agent marked it, a custom answer sent as text
        const { page, errors, shot, close } = await open({ width: 390, height: 500, touch: true, prompt: FORM, held: ["Then bump the changelog."] });
        try {
          await page.locator(".composer-queue-toggle").waitFor();
          const layout = await layoutOf(page);
          placed(layout, "form + held at 390x500");
          assert.ok(layout.queue!.bottom <= layout.card.top, "the held caption is over the card on a short phone too");
          assert.equal(await page.locator(".prompt-card-step").count(), 3);
          assert.equal(await page.locator(".prompt-card-tag").textContent(), "Recommended");
          assert.equal(layout.scrolls, true, "the form is taller than a phone with its keyboard up: the card scrolls");
          await shot("form-held-390x500");
          assert.deepEqual(await reach(page, ".prompt-card-custom .input"), { hit: "self", visible: true });
          // the card's last row is pressed at its bottom edge
          assert.deepEqual(await reach(page, ".prompt-card-custom .btn"), { hit: "self", visible: true });
          assert.deepEqual(await hitOf(page, ".prompt-card-custom .btn", "bottom"), { hit: "self", visible: true });
          await page.locator(".prompt-card-custom .input").fill("sqlite, one file");
          await page.locator(".prompt-card-custom").getByRole("button", { name: "Send" }).tap();
          await page.locator(".prompt-card").getByText(FORM.question).waitFor({ state: "detached" });
          assert.deepEqual(await answersOf(page), [{ pane_id: panes.web, prompt_id: "demo-form", custom_text: "sqlite, one file" }]);
          // a tap: the answer does not raise the keyboard by moving focus to the message box
          assert.notEqual(await page.evaluate(() => document.activeElement?.className.split(" ")[0]), "composer-text");
          assert.deepEqual(errors, []);
        } catch (error) { await preserveFailure(page, error); } finally { await close(); }
        console.log("PASS omo's form under a held caption on a short phone: steps, the agent's own Recommended tag, a custom answer sent as text");
      }

      {
        // Settings → Chat font size and Chat font reach the card, as they did inside the transcript
        const { page, errors, close } = await open({ width: 1440, height: 900, settings: { chatFontSize: 22, chatFontFamily: "Georgia" } });
        try {
          const type = await page.evaluate(() => {
            const of = (selector: string): { size: number; family: string } => { const style = getComputedStyle(document.querySelector(selector)!); return { size: parseFloat(style.fontSize), family: style.fontFamily }; };
            return { prose: of(".chat-transcript"), title: of(".prompt-card-header h2"), option: of(".prompt-card-option-label"), body: of(".prompt-card-body"), keycap: of(".prompt-card-number"), scale: parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--chat-scale")) };
          });
          assert.equal(type.prose.size, 22);
          assert.ok(type.scale > 1.5, `the chat is scaled (${type.scale})`);
          // each part keeps its own step of the scale: 13px, 12px and 11px times the chat's
          assert.ok(Math.abs(type.title.size - 13 * type.scale) < 0.1 && Math.abs(type.option.size - 13 * type.scale) < 0.1, `the title and the options grow with the chat (${type.title.size}px, ${type.option.size}px)`);
          assert.ok(Math.abs(type.body.size - 12 * type.scale) < 0.1, `so does the reference text (${type.body.size}px)`);
          assert.ok(Math.abs(type.keycap.size - 11 * type.scale) < 0.1, `and the keycap (${type.keycap.size}px)`);
          assert.match(type.title.family, /Georgia/, "the card's prose is in the chat's font");
          assert.match(type.option.family, /Georgia/);
          assert.doesNotMatch(type.body.family, /Georgia/, "the reference text stays mono");
          assert.doesNotMatch(type.keycap.family, /Georgia/);
          placed(await layoutOf(page), "chat font 22px");
          assert.deepEqual(errors, []);
        } catch (error) { await preserveFailure(page, error); } finally { await close(); }
        console.log("PASS the card follows the chat's font size and font; its reference text and keycaps stay mono");
      }

      {
        // A phone with its keyboard up: the card stands where the transcript was, so a tap on its
        // text and a drag down it put the keyboard away, as on the transcript. Chromium blurs a
        // field on any real tap outside it and iOS does not, so these are events without a
        // browser default: only the card's own handler can blur the box.
        const { page, errors, close } = await open({ width: 390, height: 500, touch: true, prompt: FORM });
        try {
          const box = page.locator(".composer-text");
          const raise = async (): Promise<void> => {
            await box.focus();
            await page.evaluate(() => { const keyboard = (navigator as unknown as { virtualKeyboard: EventTarget & { height: number } }).virtualKeyboard; keyboard.height = 300; keyboard.dispatchEvent(new Event("geometrychange")); });
            await page.waitForFunction(() => document.documentElement.hasAttribute("data-keyboard") && document.activeElement?.classList.contains("composer-text") === true);
          };
          const typing = (): Promise<boolean> => page.evaluate(() => document.activeElement?.classList.contains("composer-text") === true);
          const drag = (selector: string): Promise<void> => page.evaluate((target) => {
            const node = document.querySelector(target)!;
            const rect = node.getBoundingClientRect();
            const at = (y: number): TouchEventInit => ({ bubbles: true, touches: [new Touch({ identifier: 1, target: node, clientX: rect.left + 40, clientY: y })] });
            node.dispatchEvent(new TouchEvent("touchstart", at(rect.top + 4)));
            node.dispatchEvent(new TouchEvent("touchmove", at(rect.top + 64)));
          }, selector);
          const click = (selector: string): Promise<void> => page.evaluate((target) => { document.querySelector(target)!.dispatchEvent(new MouseEvent("click", { bubbles: true })); }, selector);

          await raise();
          await click(".prompt-card-question");
          assert.equal(await typing(), false, "a tap on the card's question puts the keyboard away");
          await raise();
          await drag(".prompt-card-question");
          assert.equal(await typing(), false, "a drag down the card at its top puts the keyboard away");
          // a scrolled card: the drag down is the way back to its top, and the keyboard stays
          await raise();
          assert.ok(await page.locator(".prompt-card").evaluate((node) => { node.scrollTop = 40; return node.scrollTop; }) > 0);
          await drag(".prompt-card-options");
          assert.equal(await typing(), true, "a drag down a scrolled card keeps the keyboard");
          await page.locator(".prompt-card").evaluate((node) => { node.scrollTop = 0; });
          // the card's own field keeps its keyboard, and a press on a row is not a request to read
          await drag(".prompt-card-custom .input");
          assert.equal(await typing(), true, "a drag on the card's field keeps the keyboard");
          await click(".prompt-card-option-label");
          assert.equal(await typing(), true, "an option is a button: its tap is not a request to read");
          assert.deepEqual(await answersOf(page), [{ pane_id: panes.web, prompt_id: "demo-form", option_index: 0 }], "and it still answers");
          assert.deepEqual(errors, []);
        } catch (error) { await preserveFailure(page, error); } finally { await close(); }
        console.log("PASS with a phone's keyboard up, a tap on the card's text or a drag down it at its top puts the keyboard away; an option still answers");
      }

      {
        // An answer that takes a moment: focus goes on to the message box only if nothing else
        // took it meanwhile
        const { page, errors, close } = await open({ width: 1440, height: 900, prompt: FORM });
        try {
          await page.evaluate(() => { (window as unknown as { formDelay: number }).formDelay = 600; });
          await page.locator(".prompt-card").getByRole("button", { name: /^1\. In memory/ }).click();
          await page.locator(".prompt-card-options[aria-busy=true]").waitFor();
          // the user goes on to something else while the answer is on its way
          const elsewhere = page.locator(".app-header button:not([disabled]):visible").first();
          await elsewhere.focus();
          assert.equal(await elsewhere.evaluate((node) => document.activeElement === node), true);
          assert.equal(await page.locator(".prompt-card-options").getAttribute("aria-busy"), "true", "the answer is still on its way");
          await page.locator(".prompt-card").getByText(FORM.question).waitFor({ state: "detached" });
          assert.equal((await answersOf(page)).length, 1);
          assert.equal(await elsewhere.evaluate((node) => document.activeElement === node), true, "focus stays where the user put it while the answer was on its way");
          assert.deepEqual(errors, []);
        } catch (error) { await preserveFailure(page, error); } finally { await close(); }
        console.log("PASS an answer that comes back late does not pull the focus from where the user went");
      }

      // An option whose label is a whole review: the pinned Confirm row shows two lines of it and
      // scrolls in itself, so the options stay in sight and in reach under the largest chat text
      for (const size of [{ width: 1440, height: 900 }, { width: 390, height: 500, touch: true }, { width: 390, height: 500, touch: true, font: 24 }]) {
        const label = `long label at ${size.width}x${size.height}${size.font ? ` at ${size.font}px` : ""}`;
        const { page, errors, shot, close } = await open({ ...size, prompt: REVIEW, settings: size.font ? { chatFontSize: size.font } : {} });
        try {
          placed(await layoutOf(page), label);
          await page.locator(".composer-text").fill("2");
          await page.locator(".composer-text").press("Enter");
          await page.locator(".prompt-card-confirm").waitFor();
          await page.waitForFunction(() => document.querySelector(".prompt-card-option.is-typed")!.getAnimations().length === 0);
          const row = await confirmRowOf(page);
          const card = await page.locator(".prompt-card").evaluate((node) => node.clientHeight);
          assert.equal(row.text.whole, `Send 2. ${LONG_LABEL}?`, `${label}: the whole label is in the question`);
          assert.ok(row.text.height <= 2 * row.text.line + 1, `${label}: the question shows two lines at most (${row.text.height / row.text.line})`);
          assert.equal(row.text.scrolls, true, `${label}: and scrolls in itself`);
          assert.equal(row.oneLine, true, `${label}: Confirm and Cancel are on one line`);
          assert.ok(row.over >= 80, `${label}: the card keeps ${row.over}px of its ${card}px over the Confirm row (the row is ${row.height}px)`);
          for (const button of [".prompt-card-confirm .btn-primary", ".prompt-card-confirm .btn:not(.btn-primary)"]) assert.deepEqual(await hitOf(page, button), { hit: "self", visible: true }, `${label}: ${button} is in sight and pressable`);
          await shot(label.replaceAll(" ", "-"));
          // the short options on both sides of the long one are reached whole; the long one, taller
          // than the card, is pressed at its top
          for (const option of [0, 2]) {
            await page.evaluate((at) => document.querySelectorAll(".prompt-card-option")[at]!.setAttribute("data-reach", ""), option);
            assert.deepEqual(await reach(page, ".prompt-card-option[data-reach]"), { hit: "self", visible: true }, `${label}: option ${option + 1} is reachable`);
            await page.evaluate(() => document.querySelector("[data-reach]")!.removeAttribute("data-reach"));
          }
          assert.equal(await page.evaluate(() => {
            const card = document.querySelector<HTMLElement>(".prompt-card")!;
            const long = document.querySelectorAll<HTMLElement>(".prompt-card-option")[1]!;
            card.scrollTop += long.getBoundingClientRect().top - card.getBoundingClientRect().top;
            const rect = long.getBoundingClientRect();
            return document.elementFromPoint(rect.left + rect.width / 2, rect.top + 12)?.closest(".prompt-card-option") === long;
          }), true, `${label}: the long option is pressable`);
          assert.deepEqual(await hitOf(page, ".prompt-card-confirm .btn-primary"), { hit: "self", visible: true }, `${label}: Confirm stays in sight while the card is scrolled`);
          assert.equal((await layoutOf(page)).pageScrolls, false, `${label}: only the card scrolled`);
          await page.locator(".prompt-card-confirm").getByRole("button", { name: "Confirm" }).click();
          await page.locator(".prompt-card").getByText(REVIEW.question).waitFor({ state: "detached" });
          assert.deepEqual(await answersOf(page), [{ pane_id: panes.web, prompt_id: "demo-review", option_index: 1 }]);
          assert.deepEqual(errors, []);
        } catch (error) { await preserveFailure(page, error); } finally { await close(); }
        console.log(`PASS ${label}: the Confirm row keeps to two lines of the label with its buttons on one line, and the options stay in reach`);
      }

      {
        // A prompt that takes another's place opens at its top, with nothing of the one before it
        const { page, errors, close } = await open({ width: 390, height: 500, touch: true, prompt: FORM });
        try {
          await page.locator(".prompt-card-custom .input").fill("sqlite");
          const before = await page.evaluate(() => {
            const card = document.querySelector<HTMLElement>(".prompt-card")!;
            const body = card.querySelector<HTMLElement>(".prompt-card-body")!;
            card.scrollTop = card.scrollHeight;
            body.scrollTop = body.scrollHeight;
            return { card: card.scrollTop, body: body.scrollTop };
          });
          assert.ok(before.card > 0 && before.body > 0, `the first card and its reference text are scrolled (${before.card}, ${before.body})`);
          await setPrompt(page, PLAN);
          await page.locator(".prompt-card").getByText(PLAN.title).waitFor();
          const after = await page.evaluate(() => {
            const card = document.querySelector<HTMLElement>(".prompt-card")!;
            return { card: card.scrollTop, body: card.querySelector<HTMLElement>(".prompt-card-body")!.scrollTop, custom: card.querySelector<HTMLInputElement>(".prompt-card-custom .input")!.value, cards: document.querySelectorAll(".prompt-card").length, inRegion: card.parentElement!.getAttribute("aria-live") };
          });
          assert.deepEqual(after, { card: 0, body: 0, custom: "", cards: 1, inRegion: "polite" }, "the next prompt opens at its top, empty, as an addition to the live region");
          assert.deepEqual(errors, []);
        } catch (error) { await preserveFailure(page, error); } finally { await close(); }
        console.log("PASS a prompt that replaces a scrolled one opens at its top");
      }

      {
        // Reads that keep failing leave the card in place and say it may be out of date, until a read answers (#1335)
        const { page, errors, close } = await open({ width: 1440, height: 900, prompt: FORM });
        try {
          const status = page.locator(".prompt-card [role=status]");
          const STALE = "Not updated: the question on screen may have changed.";
          assert.equal(await status.textContent(), "", "a card read a moment ago says nothing");
          await page.evaluate(() => { (window as unknown as { formReadFails: boolean }).formReadFails = true; });
          await page.waitForFunction((text) => document.querySelector(".prompt-card [role=status]")?.textContent === text, STALE, { timeout: 10_000 });
          assert.equal(await page.locator(".prompt-card").count(), 1, "the card stays while reads fail");
          assert.ok(await page.locator(".prompt-card").getByText(FORM.question).isVisible(), "its question is still shown");
          // the screen moved on while reads failed: the answer is refused, the poll restarts, and the notice stays
          await setPrompt(page, { ...FORM, id: "demo-form-moved" });
          await page.locator(".prompt-card-option-label").first().click();
          await page.locator(".prompt-card").getByText("The question on screen changed; check it and answer again.").waitFor();
          // the refusal's note and the poll restart land in one render, which cancels the old poll: past at
          // most one read still in flight, the next failed read is the restarted poll's, so two more prove one
          const failed = await page.evaluate(() => (window as unknown as { formFailedReads: number }).formFailedReads);
          await page.waitForFunction((n) => (window as unknown as { formFailedReads: number }).formFailedReads >= n + 2, failed, { timeout: 10_000 });
          assert.equal(await status.textContent(), STALE, "a refused answer restarts the reads without clearing the notice");
          await setPrompt(page, FORM);
          await page.evaluate(() => { (window as unknown as { formReadFails: boolean }).formReadFails = false; });
          await page.waitForFunction(() => document.querySelector(".prompt-card [role=status]")?.textContent === "", undefined, { timeout: 10_000 });
          assert.deepEqual(errors, []);
        } catch (error) { await preserveFailure(page, error); } finally { await close(); }
        console.log("PASS reads that keep failing mark the card as not updated, and the next read that answers clears it");
      }

      {
        // A restarted poll goes on counting the failed reads: one failure, a refused answer, one more failure is two in a row
        const { page, errors, close } = await open({ width: 1440, height: 900, prompt: FORM });
        try {
          const status = page.locator(".prompt-card [role=status]");
          type Mock = { formReadFails: boolean; formHoldAfterFailure: boolean; formFailedReads: number };
          // each failed read is followed by reads that hang until a refused answer: the restart's read is the next to fail, and the last
          await page.evaluate(() => { const mock = window as unknown as Mock; mock.formHoldAfterFailure = true; mock.formReadFails = true; });
          await page.waitForFunction(() => (window as unknown as Mock).formFailedReads >= 1, undefined, { timeout: 10_000 });
          assert.equal(await status.textContent(), "", "one failed read says nothing yet");
          await setPrompt(page, { ...FORM, id: "demo-form-moved" });
          await page.locator(".prompt-card-option-label").first().click();
          await page.locator(".prompt-card").getByText("The question on screen changed; check it and answer again.").waitFor();
          await page.waitForFunction((text) => document.querySelector(".prompt-card [role=status]")?.textContent === text, "Not updated: the question on screen may have changed.", { timeout: 10_000 });
          assert.deepEqual(errors, []);
        } catch (error) { await preserveFailure(page, error); } finally { await close(); }
        console.log("PASS a restarted poll counts the failed reads before it");
      }

      for (const size of [{ width: 1440, height: 900 }, { width: 390, height: 700, touch: true }]) {
        // A review of several answers reads as text, a question over its answer, not as the
        // terminal's lines in the mono box
        const { page, errors, shot, close } = await open({ ...size, prompt: ANSWERS_REVIEW });
        try {
          assert.equal(await page.locator(".prompt-card-body").count(), 0, "no mono box");
          const read = await page.locator(".prompt-card-answer").evaluateAll((rows) => rows.map((row) => ({
            question: row.querySelector("dt")!.textContent, answer: row.querySelector("dd")!.textContent,
            font: getComputedStyle(row).fontFamily,
          })));
          assert.deepEqual(read.map(({ question }) => question), ANSWERS_REVIEW.answers.map(({ question }) => question), "each question whole");
          assert.deepEqual(read.map(({ answer }) => answer), ["Fictional repo names Recommended", "Second tab in a repo Recommended"], "each answer, its recommendation as the tag");
          assert.ok(read.every(({ font }) => font === read[0]!.font) && !/mono/i.test(read[0]!.font), `the card's own font (${read[0]!.font})`);
          await shot(`review-${size.width}`);
          assert.deepEqual(errors, []);
        } catch (error) { await preserveFailure(page, error); } finally { await close(); }
        console.log(`PASS a review of answers reads as a question over each answer at ${size.width}px`);
      }

      {
        // An answer that comes back after the next prompt is already showing belongs to the prompt
        // it was pressed for: the one on screen stays, with its focus
        const { page, errors, close } = await open({ width: 1440, height: 900, prompt: FORM });
        try {
          await page.evaluate(() => { (window as unknown as { formDelay: number }).formDelay = 3500; });
          await page.locator(".prompt-card").getByRole("button", { name: /^1\. In memory/ }).click();
          await page.locator(".prompt-card-options[aria-busy=true]").waitFor();
          await setPrompt(page, NEXT);
          await page.locator(".prompt-card").getByText(NEXT.question).waitFor();
          assert.equal(await page.evaluate(() => (window as unknown as { formReturned: number }).formReturned), 0, "the first answer is still on its way");
          assert.equal(await page.locator(".prompt-card-options").getAttribute("aria-busy"), "false", "the next prompt is not waiting on the first one's answer");
          await watchCards(page);
          const second = page.locator(".prompt-card").getByRole("button", { name: /^2\. Redis/ });
          await second.focus();
          await returned(page, 1);
          assert.equal(await page.locator(".prompt-card").getByText(NEXT.question).count(), 1, "the prompt on screen is still there");
          assert.equal(await cardsRemoved(page), 0, "and was never taken away");
          assert.equal(await second.evaluate((node) => document.activeElement === node), true, "with the focus where it was");
          assert.deepEqual(await answersOf(page), [{ pane_id: panes.web, prompt_id: "demo-form", option_index: 0 }], "nothing was answered for it");

          // the same with a typed pick waiting in the second prompt
          await setPrompt(page, null);
          await page.locator(".prompt-card").getByText(NEXT.question).waitFor({ state: "detached" });
          await setPrompt(page, FORM);
          await page.locator(".prompt-card").getByText(FORM.title).waitFor();
          await page.locator(".prompt-card").getByRole("button", { name: /^1\. In memory/ }).click();
          await page.locator(".prompt-card-options[aria-busy=true]").waitFor();
          await setPrompt(page, NEXT);
          await page.locator(".prompt-card").getByText(NEXT.question).waitFor();
          await page.locator(".composer-text").fill("3");
          await page.locator(".composer-text").press("Enter");
          await page.locator(".prompt-card-confirm").waitFor();
          await returned(page, 2);
          assert.equal(await page.locator(".prompt-card-option.is-typed .prompt-card-option-label").textContent(), "Postgres", "the typed pick of the prompt on screen still waits for Confirm");
          assert.equal((await answersOf(page)).length, 2, "and was not sent");
          await page.evaluate(() => { (window as unknown as { formDelay: number }).formDelay = 0; });
          await page.locator(".prompt-card-confirm").getByRole("button", { name: "Confirm" }).click();
          await page.locator(".prompt-card").getByText(NEXT.question).waitFor({ state: "detached" });
          assert.deepEqual((await answersOf(page)).at(-1), { pane_id: panes.web, prompt_id: "demo-next", option_index: 2 });
          assert.deepEqual(errors, []);
        } catch (error) { await preserveFailure(page, error); } finally { await close(); }
        console.log("PASS an answer that comes back after the next prompt is showing leaves that prompt, its focus and its typed pick alone");
      }

      for (const width of [390, 1440]) {
        for (const theme of ["light", "dark"]) {
          const { page, errors, shot, close } = await open({ width, height: 900, touch: width === 390, theme, prompt: FORM });
          try {
            await page.evaluate(() => { (window as unknown as { formReadFails: boolean }).formReadFails = true; });
            await page.locator(".prompt-card").getByRole("button", { name: /^1\. In memory/ }).click();
            await page.waitForFunction(() => (window as unknown as { formReturned: number }).formReturned === 1);
            const status = page.locator(".prompt-card [role=status]");
            await status.getByText("Not updated: the question on screen may have changed.", { exact: false }).waitFor();
            assert.ok((await status.textContent())?.includes("Sending your answer…"), "sending status remains alongside the stale notice");
            const box = page.locator(".composer-text");
            await box.fill("2");
            await box.press("Enter");
            assert.equal(await box.inputValue(), "2", "the refused duplicate answer keeps the user's draft");
            assert.equal((await answersOf(page)).length, 1, "the composer sent no second answer");
            assert.equal(await page.locator(".prompt-card-confirm").count(), 0, "no second pick waits for confirmation");
            await shot(`answered-stale-${width}-${theme}`);
            assert.deepEqual(errors, []);
          } catch (error) { await preserveFailure(page, error); } finally { await close(); }
          console.log(`PASS an answered stale card blocks composer answers and keeps its draft at ${width}px in ${theme}`);
        }
      }

      {
        // A form's next question takes the card's place once the answer is back and the screen is read
        // again: the card waits for it, and the dock is never empty between the two questions
        const { page, errors, close } = await open({ width: 1440, height: 900, prompt: FORM });
        try {
          await page.evaluate((next) => {
            const at = window as unknown as { formDelay: number; formNext: unknown; dockEmptied: number };
            at.formDelay = 300;
            at.formNext = next;
            at.dockEmptied = 0;
            const dock = document.querySelector(".prompt-dock")!;
            new MutationObserver(() => { if (dock.querySelector(".prompt-card") === null) at.dockEmptied += 1; }).observe(dock, { childList: true, subtree: true });
          }, NEXT);
          await page.locator(".prompt-card").getByRole("button", { name: /^1\. In memory/ }).click();
          await page.locator(".prompt-card").getByText(NEXT.question).waitFor();
          assert.equal(await page.evaluate(() => (window as unknown as { dockEmptied: number }).dockEmptied), 0, "the card never left the dock");
          assert.equal(await page.locator(".prompt-card-options").getAttribute("aria-busy"), "false", "the next question can be answered");
          assert.deepEqual(await answersOf(page), [{ pane_id: panes.web, prompt_id: "demo-form", option_index: 0 }]);
          assert.deepEqual(errors, []);
        } catch (error) { await preserveFailure(page, error); } finally { await close(); }
        console.log("PASS a form's next question takes the card's place: the dock is never empty between two questions");
      }

      {
        // The same question asked again is another prompt. The server gives each asking its own id
        // (server/prompt.ts, asked), and that id is all that tells the two apart here: the same
        // text and options, and no read without a prompt in between
        const AGAIN = { ...PLAN, id: "demo-plan-asked-again" };
        const { page, errors, close } = await open({ width: 1440, height: 900, prompt: PLAN });
        try {
          const box = page.locator(".composer-text");
          // a pick typed for the first asking waits for Confirm, and an answer of the user's own is half written
          await box.fill("3");
          await box.press("Enter");
          await page.locator(".prompt-card-confirm").waitFor();
          await page.locator(".prompt-card-custom .input").fill("only for exports over 10 MB");
          await watchCards(page);
          await setPrompt(page, AGAIN);
          await page.waitForFunction(() => (window as unknown as { cardsRemoved: number }).cardsRemoved === 1, undefined, { timeout: 15_000 });
          await page.locator(".prompt-card").getByText(PLAN.question).waitFor();
          assert.equal(await page.locator(".prompt-card").count(), 1, "the second asking has a card of its own");
          assert.equal(await page.locator(".prompt-card-confirm").count(), 0, "which does not inherit the first asking's typed pick");
          assert.equal(await page.locator(".prompt-card-option.is-typed").count(), 0);
          assert.equal(await page.locator(".prompt-card-custom .input").inputValue(), "", "nor what was being written in the first one's card");
          assert.deepEqual(await answersOf(page), [], "and nothing was sent");

          // an answer pressed for the first asking that comes back once the second one is showing
          await setPrompt(page, PLAN);
          await page.waitForFunction(() => (window as unknown as { cardsRemoved: number }).cardsRemoved === 2, undefined, { timeout: 15_000 });
          await page.evaluate(() => { (window as unknown as { formDelay: number }).formDelay = 3500; });
          await page.locator(".prompt-card").getByRole("button", { name: /^1\. In memory/ }).click();
          await page.locator(".prompt-card-options[aria-busy=true]").waitFor();
          await setPrompt(page, AGAIN);
          await page.locator(".prompt-card-options[aria-busy=false]").waitFor();
          assert.equal(await page.evaluate(() => (window as unknown as { formReturned: number }).formReturned), 0, "the first asking's answer is still on its way");
          await box.fill("3");
          await box.press("Enter");
          await page.locator(".prompt-card-confirm").waitFor();
          await watchCards(page);
          const second = page.locator(".prompt-card").getByRole("button", { name: /^2\. Redis/ });
          await second.focus();
          await returned(page, 1);
          assert.equal(await page.locator(".prompt-card").count(), 1, "the second asking is still on screen");
          assert.equal(await cardsRemoved(page), 0, "and was never taken away");
          assert.equal(await second.evaluate((node) => document.activeElement === node), true, "with the focus where it was, not in the message box");
          assert.equal(await page.locator(".prompt-card-option.is-typed .prompt-card-option-label").textContent(), "Postgres", "and its own typed pick still waiting for Confirm");
          assert.deepEqual(await answersOf(page), [{ pane_id: panes.web, prompt_id: "demo-plan", option_index: 0 }], "only the first asking was answered");
          await page.evaluate(() => { (window as unknown as { formDelay: number }).formDelay = 0; });
          await page.locator(".prompt-card-confirm").getByRole("button", { name: "Confirm" }).click();
          // this asking's card, by its question: the demo's own approval is read as soon as this one
          // is answered, and a poll that lands before the answer returns puts its card here at once
          await page.locator(".prompt-card").getByText(PLAN.question).waitFor({ state: "detached" });
          assert.deepEqual((await answersOf(page)).at(-1), { pane_id: panes.web, prompt_id: "demo-plan-asked-again", option_index: 2 }, "Confirm answers the second asking under its own id");
          assert.deepEqual(errors, []);
        } catch (error) { await preserveFailure(page, error); } finally { await close(); }
        console.log("PASS the same question asked again is a card of its own: no typed pick or input carried over, and the first one's late answer leaves it alone");
      }

      {
        // Two panes, each with a prompt of its own: an answer for one that comes back after the
        // other is opened changes nothing there
        const { page, errors, close } = await open({ width: 1440, height: 900, prompt: FORM });
        try {
          await setPanePrompt(page, panes.hermes, OTHER);
          await page.evaluate(() => { (window as unknown as { formDelay: number }).formDelay = 3500; });
          await page.locator(".prompt-card").getByRole("button", { name: /^1\. In memory/ }).click();
          await page.locator(".prompt-card-options[aria-busy=true]").waitFor();
          await select(page, panes.hermes);
          await page.locator(".prompt-card").getByText(OTHER.question).waitFor();
          assert.equal(await page.locator(".prompt-card-options").getAttribute("aria-busy"), "false");
          await page.locator(".composer-text").fill("2");
          await page.locator(".composer-text").press("Enter");
          await page.locator(".prompt-card-confirm").waitFor();
          await watchCards(page);
          assert.equal(await page.evaluate(() => (window as unknown as { formReturned: number }).formReturned), 0, "the first pane's answer is still on its way");
          await returned(page, 1);
          assert.equal(await page.locator(".prompt-card").getByText(OTHER.question).count(), 1, "the other pane's prompt is still there");
          assert.equal(await cardsRemoved(page), 0, "and was never taken away");
          assert.equal(await page.locator(".prompt-card-option.is-typed .prompt-card-option-label").textContent(), "Redis Recommended", "its typed pick still waits for Confirm");
          assert.equal(await page.evaluate(() => document.activeElement?.className.split(" ")[0]), "composer-text", "the focus is where the user was typing");
          assert.deepEqual(await answersOf(page), [{ pane_id: panes.web, prompt_id: "demo-form", option_index: 0 }], "only the first pane's prompt was answered");
          assert.equal(await page.evaluate((pane) => (window as unknown as { panePrompts: Record<string, { id: string } | undefined> }).panePrompts[pane]?.id, panes.hermes), "demo-other", "the other pane's prompt is still open");
          // and its own answer goes to it alone
          await page.evaluate(() => { (window as unknown as { formDelay: number }).formDelay = 0; });
          await page.locator(".prompt-card-confirm").getByRole("button", { name: "Confirm" }).click();
          await page.locator(".prompt-card").getByText(OTHER.question).waitFor({ state: "detached" });
          assert.deepEqual((await answersOf(page)).at(-1), { pane_id: panes.hermes, prompt_id: "demo-other", option_index: 1 });
          assert.deepEqual(errors, []);
        } catch (error) { await preserveFailure(page, error); } finally { await close(); }
        console.log("PASS an answer for one pane that comes back after another pane is opened leaves that pane's prompt and typed pick alone");
      }

      {
        // A laptop with a touch screen: its pointer is fine, and an option can still be tapped.
        // The tap answers and leaves the message box alone (focus there raises the on-screen
        // keyboard); a mouse press on the same screen hands the focus on
        const { page, errors, close } = await open({ width: 1440, height: 900, touch: true, finePointer: true, prompt: FORM });
        try {
          assert.equal(await page.evaluate(() => matchMedia("(pointer: coarse)").matches), false, "the app is told the pointer is fine");
          await page.locator(".prompt-card").getByRole("button", { name: /^1\. In memory/ }).tap();
          await page.locator(".prompt-card").getByText(FORM.question).waitFor({ state: "detached" });
          assert.equal((await answersOf(page)).length, 1, "the tap answered");
          await page.waitForTimeout(300); // fixed wait: the answer may not move the focus into the message box
          assert.notEqual(await page.evaluate(() => document.activeElement?.className.split(" ")[0]), "composer-text", "a tap does not move the focus into the message box");
          await setPrompt(page, FORM);
          await page.locator(".prompt-card").getByText(FORM.question).waitFor();
          await page.locator(".prompt-card").getByRole("button", { name: /^1\. In memory/ }).click();
          await page.locator(".prompt-card").getByText(FORM.question).waitFor({ state: "detached" });
          await page.waitForFunction(() => document.activeElement?.classList.contains("composer-text") === true);
          // a key on the option is not a tap either
          await setPrompt(page, FORM);
          await page.locator(".prompt-card").getByText(FORM.question).waitFor();
          await page.locator(".prompt-card").getByRole("button", { name: /^1\. In memory/ }).focus();
          await page.keyboard.press("Enter");
          await page.locator(".prompt-card").getByText(FORM.question).waitFor({ state: "detached" });
          await page.waitForFunction(() => document.activeElement?.classList.contains("composer-text") === true);
          assert.equal((await answersOf(page)).length, 3);
          assert.deepEqual(errors, []);
        } catch (error) { await preserveFailure(page, error); } finally { await close(); }
        console.log("PASS on a touch-screen laptop a tapped answer leaves the message box alone; a mouse press or a key hands the focus on");
      }

      {
        // A tablet with a keyboard or a mouse, or a phone with a keyboard: the pointer is coarse,
        // and a key or a mouse press still hands the focus on. The card goes with the answer, so
        // the focus would otherwise fall to the page and the keyboard user would lose their place
        const { page, errors, close } = await open({ width: 1024, height: 768, touch: true, prompt: FORM });
        try {
          assert.equal(await page.evaluate(() => matchMedia("(pointer: coarse)").matches), true, "the app is told the pointer is coarse");
          // where the focus was at the moment each card left the dock
          await page.evaluate(() => {
            const seen = window as unknown as { focusAtRemoval: string[] };
            seen.focusAtRemoval = [];
            new MutationObserver((records) => { for (const record of records) for (const node of record.removedNodes) if (node instanceof HTMLElement && node.classList.contains("prompt-card")) seen.focusAtRemoval.push(document.activeElement === null || document.activeElement === document.body ? "page" : document.activeElement.className.split(" ")[0]!); }).observe(document.querySelector(".prompt-dock")!, { childList: true });
          });
          const focusAtRemoval = (): Promise<string[]> => page.evaluate(() => (window as unknown as { focusAtRemoval: string[] }).focusAtRemoval);
          const option = page.locator(".prompt-card").getByRole("button", { name: /^1\. In memory/ });
          const ask = async (): Promise<void> => { await setPrompt(page, FORM); await page.locator(".prompt-card").getByText(FORM.question).waitFor(); };
          const gone = (): Promise<void> => page.locator(".prompt-card").getByText(FORM.question).waitFor({ state: "detached" });
          const active = (): Promise<string | undefined> => page.evaluate(() => document.activeElement === document.body ? "page" : document.activeElement?.className.split(" ")[0]);

          // Enter and Space on an option, and Enter in the card's own field
          for (const key of ["Enter", "Space"]) {
            await option.focus();
            await page.keyboard.press(key);
            await gone();
            assert.equal(await active(), "composer-text", `${key} on an option hands the focus to the message box on a coarse pointer`);
            await ask();
          }
          await page.locator(".prompt-card-custom .input").fill("sqlite, one file");
          await page.locator(".prompt-card-custom .input").press("Enter");
          await gone();
          assert.equal(await active(), "composer-text", "Enter in the card's field hands the focus to the message box");
          await ask();
          // an answer that takes a moment: the pressed option is disabled meanwhile, and the focus still goes on
          await page.evaluate(() => { (window as unknown as { formDelay: number }).formDelay = 400; });
          await option.focus();
          await page.keyboard.press("Enter");
          await page.locator(".prompt-card-options[aria-busy=true]").waitFor();
          await gone();
          assert.equal(await active(), "composer-text", "and after an answer that took a moment");
          await page.evaluate(() => { (window as unknown as { formDelay: number }).formDelay = 0; });
          await ask();
          // a mouse on the same device
          await option.click();
          await gone();
          assert.equal(await active(), "composer-text", "a mouse press hands the focus on with a coarse pointer too");
          // (the demo's own approval, shown between two forms, leaves the dock too)
          assert.deepEqual([...new Set(await focusAtRemoval())], ["composer-text"], "the focus of a key or a mouse press was never left on the page when its card went");
          assert.equal((await answersOf(page)).length, 5, "each press answered once");

          // a tap answers and stays out of the message box
          await page.locator(".composer-text").evaluate((node: HTMLElement) => node.blur());
          await ask();
          await option.tap();
          await gone();
          await page.waitForTimeout(300); // fixed wait: the answer may not move the focus into the message box
          assert.notEqual(await active(), "composer-text", "a tap does not move the focus into the message box");
          // a click that names no pointer and had no key (a script, an assistive technology): the
          // coarse pointer decides, and the keyboard is not raised
          await ask();
          await option.focus();
          await option.evaluate((node: HTMLElement) => node.click());
          await gone();
          await page.waitForTimeout(300); // fixed wait: the answer may not move the focus into the message box
          assert.notEqual(await active(), "composer-text", "a click of unknown origin stays out of the message box on a coarse pointer");
          // a finger went down on the option and its click says "mouse", as iOS Safari has done
          // (WebKit bug 282988): the pointerdown is believed, and the keyboard is not raised
          await ask();
          await option.focus();
          await option.evaluate((node: HTMLElement) => {
            node.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerType: "touch" }));
            node.dispatchEvent(new PointerEvent("click", { bubbles: true, pointerType: "mouse", detail: 1 }));
          });
          await gone();
          await page.waitForTimeout(300); // fixed wait: the answer may not move the focus into the message box
          assert.notEqual(await active(), "composer-text", "a tap whose click is called a mouse's stays out of the message box");
          assert.equal((await answersOf(page)).length, 8);
          assert.deepEqual(errors, []);
        } catch (error) { await preserveFailure(page, error); } finally { await close(); }
        console.log("PASS with a coarse pointer a key (Enter, Space, the card's field) or a mouse press hands the focus to the message box and never leaves it on the page; a tap, an unnamed click or a tap misnamed a mouse does not");
      }

      for (const language of ["ko", "ja", "zh"]) {
        // the translated placeholders fit the phone's message box on one line too
        const { page, close } = await open({ width: 390, height: 844, touch: true, prompt: PLAN, language });
        try {
          const fit = await page.evaluate(() => { const box = document.querySelector<HTMLTextAreaElement>(".composer-text")!; const probe = document.createElement("span"); probe.style.cssText = `position:absolute;visibility:hidden;white-space:nowrap;font:${getComputedStyle(box).font}`; probe.textContent = box.placeholder; document.body.append(probe); const width = probe.getBoundingClientRect().width; probe.remove(); return { text: box.placeholder, width, room: box.clientWidth - parseFloat(getComputedStyle(box).paddingLeft) - parseFloat(getComputedStyle(box).paddingRight) }; });
          assert.ok(fit.width <= fit.room, `${language}: "${fit.text}" is ${fit.width}px in ${fit.room}px`);
        } catch (error) { await preserveFailure(page, error); } finally { await close(); }
      }
      console.log("PASS the placeholder with a custom answer fits a 390px message box in ko, ja and zh");
    } finally { await browser.close(); }
  } finally { server.stop(); }
} finally { rmSync(app, { recursive: true, force: true }); }
