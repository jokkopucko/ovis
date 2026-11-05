import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Page } from "playwright-core";
import panes from "../site/demo/fixtures/panes.json";
import { buildDemoApp, buildDevelopmentDemoApp } from "./demo-build.ts";
import { DEMO_FILE_PREVIEW_SCRIPT } from "./demo-file-preview.ts";
import { openSettingsPage, sheetRisen } from "./settings-page.ts";
import { KO } from "../src/lib/i18n.ko.ts";
import { JA } from "../src/lib/i18n.ja.ts";
import { ZH } from "../src/lib/i18n.zh.ts";
import { terminalTheme } from "../src/lib/settings.ts";
import { THEME_IDS, type ThemeId } from "../src/lib/themes.ts";
import baseline from "../src/lib/themes.legacy-baseline.json";
import { comboKey, LEGACY_COMBOS } from "./theme-baseline.ts";

// Settings on the unmodified app over the demo's fixture transport: every page fits a phone, and
// the browser's Back button steps out of the dialog instead of out of the app. All files and
// HTTP traffic stay in this disposable, loopback-only app; no herdr session is opened.
const app = mkdtempSync(join(tmpdir(), "herdr-settings-demo-"));
const devApp = mkdtempSync(join(tmpdir(), "herdr-settings-dev-"));
const PAGES = ["Appearance", "Chat", "Terminal", "Alerts", "Voice input", "Agents", "Shortcuts", "Phone & devices", "Remote PCs", "About"];
const SETTINGS = { language: "en", showUsage: true, voiceInput: true, showQuickReplies: true, fileOpen: "panel" };

const dialogOf = (page: Page) => page.getByRole("dialog", { name: "Settings", exact: true });
const openSettings = async (page: Page): Promise<void> => {
  await page.keyboard.press("ControlOrMeta+Shift+Comma");
  await page.locator(".settings-dialog").waitFor();
  await sheetRisen(page);
};
/** Closes Settings by its X and waits for its step back off the history to land. */
const closeSettings = async (page: Page): Promise<void> => {
  await sheetRisen(page);
  await page.getByRole("button", { name: "Close settings", exact: true }).click();
  await page.locator(".settings-dialog").waitFor({ state: "detached" });
  await page.waitForFunction(() => (history.state as Record<string, unknown> | null)?.["ovis:settings"] === undefined);
};
/** The Settings entry of the current history state, as the app wrote it. */
const entryOf = (page: Page): Promise<{ page: string | null; keyBar: boolean; depth: number } | null> =>
  page.evaluate(() => (history.state as Record<string, unknown> | null)?.["ovis:settings"] as never ?? null);
/** Waits for the history to hold what a step left; a wait that runs out says what it holds instead, and how it came to. */
const historyHolds = async (page: Page, step: string, holds: () => boolean): Promise<void> => {
  try { await page.waitForFunction(holds); }
  catch (error) {
    const seen = await page.evaluate(() => ({ state: history.state as unknown, address: location.search, dialogs: document.querySelectorAll(".settings-dialog").length, trace: (window as unknown as { historyTrace?: string[] }).historyTrace?.slice(-40) }));
    throw new Error(`${step}: the history never held it. ${JSON.stringify(seen, null, 1)}`, { cause: error });
  }
};
/** Controls and text that reach past their card, and cards past the page's box: a row wider than its card is cut there. */
const cutOff = (page: Page): Promise<string[]> => page.locator(".settings-body:not([hidden]), .settings-key-bar-body").evaluate((body) => {
  const edge = body.getBoundingClientRect();
  const out = [...body.querySelectorAll<HTMLElement>("button, input, select, a, .settings-card, .settings-row")]
    .filter((node) => {
      const box = node.getBoundingClientRect();
      // a control is held by its card, where it has one; a card by the page
      const card = node.classList.contains("settings-card") ? null : node.closest<HTMLElement>(".settings-card");
      const within = card ? card.getBoundingClientRect() : edge;
      return box.width > 0 && (box.right > within.right + 0.5 || box.left < within.left - 0.5);
    })
    .map((node) => `${node.tagName.toLowerCase()}.${node.className} ${node.getAttribute("aria-label") ?? node.textContent?.trim().slice(0, 30) ?? ""}`);
  return body.scrollWidth > body.clientWidth ? [`the page scrolls sideways (${body.scrollWidth} > ${body.clientWidth})`, ...out] : out;
});

/** What a user types for a setting, by language, and the page (and group, or `-`) the first Settings result opens. */
const MATRIX: readonly (readonly ["en" | "ko" | "ja" | "zh", string, string, string])[] = [
  ["en", "theme", "appearance", "-"],
  ["en", "palette", "appearance", "-"],
  ["en", "interface font size", "appearance", "typography"],
  ["en", "chat font size", "chat", "-"],
  ["en", "chat width", "chat", "-"],
  ["en", "Enter sends", "chat", "composer"],
  ["en", "quick replies", "chat", "quick-replies"],
  ["en", "terminal font", "terminal", "-"],
  ["en", "notifications", "alerts", "-"],
  ["en", "shortcuts", "shortcuts", "-"],
  ["en", "phone", "devices", "-"],
  ["en", "OpenAI API key", "voice", "openai-key"],
  ["en", "Return inserts a new line", "chat", "composer"],
  ["en", "Send queued messages automatically", "chat", "composer"],
  ["en", "New tab button", "chat", "composer"],
  ["en", "Suggestion chip", "chat", "composer"],
  ["en", "Show above the message box", "chat", "quick-replies"],
  ["ko", "인터페이스 글자 크기", "appearance", "typography"],
  ["ko", "채팅 글자 크기", "chat", "-"],
  ["ko", "Enter로 보내기", "chat", "composer"],
  ["ko", "빠른 답장", "chat", "quick-replies"],
  ["ko", "터미널 글자 크기", "terminal", "-"],
  ["ko", "OpenAI API 키", "voice", "openai-key"],
  ["ko", "단축키", "shortcuts", "-"],
  ["ko", "알림", "alerts", "-"],
  ["ko", "대기 메시지 자동 전송", "chat", "composer"],
  ["ko", "입력창 위에 표시", "chat", "quick-replies"],
  ["ja", "インターフェースの文字サイズ", "appearance", "typography"],
  ["ja", "チャットのフォントサイズ", "chat", "-"],
  ["ja", "Enter で送信", "chat", "composer"],
  ["ja", "クイック返信", "chat", "quick-replies"],
  ["ja", "ターミナルのフォントサイズ", "terminal", "-"],
  ["ja", "OpenAI API キー", "voice", "openai-key"],
  ["ja", "ショートカット", "shortcuts", "-"],
  ["ja", "通知", "alerts", "-"],
  ["ja", "送信待ちメッセージを自動で送信", "chat", "composer"],
  ["ja", "入力欄の上に表示", "chat", "quick-replies"],
  ["zh", "界面字号", "appearance", "typography"],
  ["zh", "聊天字号", "chat", "-"],
  ["zh", "按 Enter 发送", "chat", "composer"],
  ["zh", "快捷回复", "chat", "quick-replies"],
  ["zh", "终端字号", "terminal", "-"],
  ["zh", "OpenAI API 密钥", "voice", "openai-key"],
  ["zh", "快捷键", "shortcuts", "-"],
  ["zh", "提醒", "alerts", "-"],
  ["zh", "自动发送排队消息", "chat", "composer"],
  ["zh", "显示在输入框上方", "chat", "quick-replies"],
];

interface SearchResult { width: number; language: string; query: string; expected: { page: string; section: string }; first: string | null; page: string | null; focusedSection: string | null; sectionVisible: boolean | null; overflow: string[]; focusReturned: boolean; pass: boolean }

/** Where the focus is, as a selector-like name, so the one before the palette and the one after Settings closes compare. */
const focusName = (page: Page): Promise<string> => page.evaluate(() => {
  const node = document.activeElement as HTMLElement | null;
  return node ? `${node.tagName.toLowerCase()}.${node.className}#${node.id}[${node.getAttribute("aria-label") ?? ""}]` : "none";
});
const openPalette = async (page: Page, query: string): Promise<void> => {
  await page.keyboard.press("ControlOrMeta+Shift+K");
  const input = page.locator(".command-palette input[type='search']");
  await input.waitFor();
  await input.fill(query);
  // the list drawn for this query: its rows or its empty line, never the last query's
  await page.waitForFunction((query) => document.querySelector<HTMLInputElement>(".command-palette input[type='search']")?.value === query, query);
  // a phone's palette is a sheet too: its rows are clicked once it has risen
  await sheetRisen(page, ".command-palette");
};
/** The page Settings shows, by the selected tab's id, and the group the focus is on. */
const landing = async (page: Page, label: (name: string) => string): Promise<{ page: string | null; section: string | null; visible: boolean | null }> => {
  const shown = await page.evaluate(() => {
  const id = document.querySelector<HTMLElement>(".settings-dialog [role='tabpanel']:not([hidden])")?.getAttribute("aria-label") ?? null;
  const active = document.activeElement as HTMLElement | null;
  const section = active?.dataset.section ?? null;
  let visible: boolean | null = null;
  if (section !== null && active) {
    // the group's head and its first control, which may arrive after it opens (the OpenAI key's form)
    const body = active.closest(".settings-body")?.getBoundingClientRect(), box = active.getBoundingClientRect();
    const control = active.querySelector("input, select, button, textarea")?.getBoundingClientRect();
    visible = body !== undefined && box.top >= body.top - 1 && box.top < body.bottom && control !== undefined && control.bottom <= body.bottom + 1;
  }
  return { page: id, section, visible };
  });
  // the panel is named by its page's label in the language shown: back to the page's id
  const ids = ["appearance", "chat", "terminal", "alerts", "voice", "agents", "shortcuts", "devices", "remote", "about"];
  return { ...shown, page: shown.page === null ? null : ids[PAGES.findIndex((name) => label(name) === shown.page)] ?? `unknown: ${shown.page}` };
};
/** Anything in the palette or Settings wider than the window: a long query or label must not push the sheet sideways. */
const sideways = (page: Page): Promise<string[]> => page.evaluate(() => [...document.querySelectorAll<HTMLElement>(".command-palette, .palette-results, .settings-dialog, .settings-body:not([hidden])")]
  .filter((node) => node.scrollWidth > node.clientWidth + 1 || node.getBoundingClientRect().right > window.innerWidth + 0.5)
  .map((node) => `${node.className} ${node.scrollWidth}>${node.clientWidth}`));

/**
 * Settings found through the palette: every row of the matrix in its language, on a desktop and on a
 * phone with a hardware keyboard, opens on its page and, when it names one, on its group, focused
 * and in view; closing returns the focus. A search that finds nothing, or one closed without
 * picking a result, leaves no request behind: Settings opened next starts at its top, and Back
 * and Forward do not land on a group either.
 */
async function settingsSearch(browser: import("playwright-core").Browser, url: string): Promise<void> {
  const results: SearchResult[] = [];
  const stale: { width: number; language: string; query: string; settingsRows: number; page: string | null; section: string | null; overflow: string[]; pass: boolean }[] = [];
  for (const width of [1440, 390] as const) {
    for (const language of ["en", "ko", "ja", "zh"] as const) {
      const strings: Record<string, string> = language === "ko" ? KO : language === "ja" ? JA : language === "zh" ? ZH : {};
      const label = (name: string): string => strings[name] ?? name;
      const context = await browser.newContext(width === 390 ? { viewport: { width, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true, locale: language } : { viewport: { width, height: 900 }, locale: language });
      try {
        await context.addInitScript((settings) => localStorage.setItem("ovis:settings", settings), JSON.stringify({ ...SETTINGS, language }));
        const page = await context.newPage();
        const errors: string[] = [];
        page.on("pageerror", (error) => errors.push(error.message));
        await page.goto(url);
        await page.locator(".conn-live").waitFor({ state: "attached" });
        await page.locator(".composer-text").focus();
        const close = async (): Promise<void> => {
          await sheetRisen(page);
          await page.getByRole("button", { name: label("Close settings"), exact: true }).click();
          await page.locator(".settings-dialog").waitFor({ state: "detached" });
          // the next row opens Settings again: its close's step back lands first
          await page.waitForFunction(() => (history.state as Record<string, unknown> | null)?.["ovis:settings"] === undefined);
        };
        for (const [rowLanguage, query, expectedPage, expectedSection] of MATRIX) {
          if (rowLanguage !== language) continue;
          const before = await focusName(page);
          await openPalette(page, query);
          const first = page.locator(".palette-section[data-section='settings-pages'] [role='option']").first();
          const found = await first.count() > 0;
          const firstText = found ? (await first.textContent())?.trim() ?? null : null;
          let shown: { page: string | null; section: string | null; visible: boolean | null } = { page: null, section: null, visible: null };
          let overflow: string[] = [];
          let focusReturned = false;
          if (found) {
            await first.click();
            await page.locator(".settings-dialog").waitFor();
            await page.waitForFunction(() => document.querySelector(".settings-dialog [role='tabpanel']:not([hidden])") !== null);
            if (expectedSection !== "-") await page.waitForFunction((section) => (document.activeElement as HTMLElement | null)?.dataset.section === section, expectedSection, { timeout: 3000 }).catch(() => undefined);
            // a group's control drawn after the server answers is in view once it is there
            if (expectedSection !== "-") await page.waitForFunction(() => {
              const active = document.activeElement as HTMLElement | null;
              const body = active?.closest(".settings-body")?.getBoundingClientRect();
              const control = active?.querySelector("input, select, button, textarea")?.getBoundingClientRect();
              return body !== undefined && control !== undefined && control.bottom <= body.bottom + 1;
            }, undefined, { timeout: 3000 }).catch(() => undefined);
            shown = await landing(page, label);
            overflow = await sideways(page);
            await close();
          } else {
            await page.keyboard.press("Escape");
            await page.locator(".command-palette").waitFor({ state: "detached" });
          }
          focusReturned = await focusName(page) === before;
          const pass = shown.page === expectedPage && (expectedSection === "-" || (shown.section === expectedSection && shown.visible === true)) && overflow.length === 0 && focusReturned;
          results.push({ width, language, query, expected: { page: expectedPage, section: expectedSection }, first: firstText, page: shown.page, focusedSection: shown.section, sectionVisible: shown.visible, overflow, focusReturned, pass });
        }
        // a search that finds nothing, one closed without picking, and a 200-character unbroken one:
        // none of them steers the Settings opened next, nor its Back and Forward
        for (const query of ["zzqxv-nothing-matches", MATRIX.find(([rowLanguage, , , section]) => rowLanguage === language && section === "quick-replies")![1], "w".repeat(200)]) {
          await openPalette(page, query);
          const settingsRows = await page.locator(".palette-section[data-section='settings-pages'] [role='option']").count();
          const overflow = await sideways(page);
          await page.keyboard.press("Escape");
          await page.locator(".command-palette").waitFor({ state: "detached" });
          await openSettings(page);
          const opened = await landing(page, label);
          const steps: { page: string | null; section: string | null }[] = [opened];
          if (width === 1440) {
            await page.goBack();
            await page.locator(".settings-dialog").waitFor({ state: "detached" });
            await page.goForward();
            await page.locator(".settings-dialog").waitFor();
            await page.waitForFunction(() => document.querySelector(".settings-dialog [role='tabpanel']:not([hidden])") !== null);
            steps.push(await landing(page, label));
          }
          await close();
          const quiet = steps.every((step) => step.section === null) && (width === 390 ? opened.page === null : opened.page === "appearance");
          const expectedRows = query.startsWith("zzq") || query.length === 200 ? 0 : 1;
          stale.push({ width, language, query, settingsRows, page: opened.page, section: steps.find((step) => step.section !== null)?.section ?? null, overflow, pass: quiet && overflow.length === 0 && (expectedRows === 0 ? settingsRows === 0 : settingsRows > 0) });
        }
        assert.deepEqual(errors, [], `no page errors (${width}px, ${language})`);
      } finally {
        await context.close();
      }
    }
  }
  if (process.env.UI_EVIDENCE_DIR) writeFileSync(join(process.env.UI_EVIDENCE_DIR, "settings-search.json"), `${JSON.stringify({ rows: results, stale }, null, 1)}\n`);
  assert.equal(results.length, MATRIX.length * 2, "every matrix row ran at both widths");
  assert.deepEqual(results.filter((result) => !result.pass), [], "every matrix row opens its page and group from the first Settings result");
  assert.deepEqual(stale.filter((result) => !result.pass), [], "no search steers a later opening of Settings");
  console.log(`PASS ${MATRIX.length} settings searches at 1440 and 390px land on their page and group; no stale request in en, ko, ja, zh`);
}

interface HeldSteps { holdSteps: (timers?: boolean) => void; releaseSteps: () => void; releaseTimers: () => void; heldSteps: () => number; landed: number }

/**
 * Settings closed and opened again before the browser lands the step back off the closed one's entry,
 * as on a slow phone or a loaded runner (#2000): the app's address bar writes its address on that
 * entry meanwhile, and the step is still Settings' own when it lands. The dialog stays open, and its
 * entry is made again. The step is held here until Settings is open again, and the timers the page
 * sets meanwhile start only once it has landed: a step that lands after Settings' landing deadline is
 * no longer known for its own, and a slow runner must not reach that deadline before the step lands.
 */
async function lateCloseStep(browser: import("playwright-core").Browser, url: string): Promise<void> {
  for (const width of [1440, 390] as const) {
    const context = await browser.newContext(width === 390 ? { viewport: { width, height: 844 }, isMobile: true, hasTouch: true } : { viewport: { width, height: 900 } });
    try {
      await context.addInitScript((settings) => {
        localStorage.setItem("ovis:settings", settings);
        const go = history.go.bind(history), back = history.back.bind(history);
        const held: (() => void)[] = [];
        let holding = false;
        const setTimer = window.setTimeout.bind(window), clearTimer = window.clearTimeout.bind(window);
        // a timer set while held: its arguments until it starts, then the id it started with
        const timers = new Map<number, Parameters<typeof setTimeout> | number>();
        let holdingTimers = false, heldId = 0;
        window.setTimeout = ((...args: Parameters<typeof setTimeout>) => {
          if (!holdingTimers) return setTimer(...args);
          timers.set(--heldId, args);
          return heldId;
        }) as typeof setTimeout;
        window.clearTimeout = (id?: number) => {
          const timer = id === undefined ? undefined : timers.get(id);
          if (timer === undefined) clearTimer(id);
          else { timers.delete(id!); if (typeof timer === "number") clearTimer(timer); }
        };
        const steps = window as unknown as HeldSteps;
        steps.holdSteps = (timers = true) => { holding = true; holdingTimers = timers; };
        steps.releaseSteps = () => { holding = false; for (const step of held.splice(0)) step(); };
        steps.releaseTimers = () => {
          holdingTimers = false;
          for (const [id, timer] of timers) if (typeof timer !== "number") timers.set(id, setTimer(...timer));
        };
        steps.heldSteps = () => held.length;
        steps.landed = 0;
        addEventListener("popstate", () => { steps.landed += 1; });
        // a browser picks a traversal's entry when it is asked for, and lands on it later: the held
        // step goes to the entry it named then, whatever was pushed meanwhile
        const navigation = (window as unknown as { navigation: { currentEntry: { index: number } | null; entries: () => { key: string }[]; traverseTo: (key: string) => { committed: Promise<unknown>; finished: Promise<unknown> } } }).navigation;
        const later = (delta: number): void => {
          const target = navigation.entries()[(navigation.currentEntry?.index ?? 0) + delta];
          if (target) held.push(() => { const step = navigation.traverseTo(target.key); step.committed.catch(() => undefined); step.finished.catch(() => undefined); });
        };
        history.go = (delta?: number) => { if (holding) later(delta ?? 0); else go(delta); };
        history.back = () => { if (holding) later(-1); else back(); };
      }, JSON.stringify(SETTINGS));
      const page = await context.newPage();
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(url);
      await page.locator(".conn-live").waitFor({ state: "attached" });
      await page.locator(".composer-text").focus();
      await openSettings(page);
      await page.evaluate(() => (window as unknown as HeldSteps).holdSteps());
      await page.getByRole("button", { name: "Close settings", exact: true }).click();
      await page.locator(".settings-dialog").waitFor({ state: "detached" });
      await page.waitForFunction(() => (window as unknown as HeldSteps).heldSteps() === 1);
      await openSettings(page);
      const landed = await page.evaluate(() => (window as unknown as HeldSteps).landed);
      await page.evaluate(() => (window as unknown as HeldSteps).releaseSteps());
      await page.waitForFunction((before) => (window as unknown as HeldSteps).landed > before, landed);
      await historyHolds(page, `the late step back at ${width}px`, () => (history.state as Record<string, { depth: number }> | null)?.["ovis:settings"]?.depth === 1);
      assert.equal(await page.locator(".settings-dialog").count(), 1, `a Settings opened before the step back landed stays open (${width}px)`);
      await page.evaluate(() => (window as unknown as HeldSteps).releaseTimers());
      await closeSettings(page);
      if (width === 390) {
        // a phone's palette is a sheet: closed, it steps back off its own entry, and Settings opened
        // before that step lands is no Back of the user's either
        await page.keyboard.press("ControlOrMeta+Shift+K");
        await page.locator(".command-palette input[type='search']").waitFor();
        await page.evaluate(() => (window as unknown as HeldSteps).holdSteps(false));
        await page.keyboard.press("Escape");
        await page.locator(".command-palette").waitFor({ state: "detached" });
        await page.waitForFunction(() => (window as unknown as HeldSteps).heldSteps() === 1);
        await openSettings(page);
        const before = await page.evaluate(() => (window as unknown as HeldSteps).landed);
        await page.evaluate(() => (window as unknown as HeldSteps).releaseSteps());
        await page.waitForFunction((count) => (window as unknown as HeldSteps).landed > count, before);
        await historyHolds(page, "the palette's late step back", () => (history.state as Record<string, { depth: number }> | null)?.["ovis:settings"]?.depth === 1);
        assert.equal(await page.locator(".settings-dialog").count(), 1, "a Settings opened before the palette's step back landed stays open");
        await closeSettings(page);
      }
      assert.deepEqual(errors, []);
    } finally {
      await context.close();
    }
  }
  console.log("PASS a Settings opened again before its closing step back lands stays open, at 1440 and 390px");
}

/**
 * Loaded after the demo's transport in the development app: the voice status the Voice input page
 * asks for is held until the page releases it, and the observers made on the OpenAI key's group are
 * counted, live and made.
 */
const HOLD_VOICE = `(() => {
  const fetch = window.fetch, held = [];
  let holding = true, asked = 0, made = 0;
  window.voiceAsked = () => asked;
  window.releaseVoice = () => { holding = false; for (const go of held.splice(0)) go(); };
  window.fetch = (input, init) => {
    const path = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, location.href).pathname;
    if (!holding || path !== "/api/voice") return fetch(input, init);
    asked += 1;
    return new Promise((resolve) => held.push(() => resolve(fetch(input, init))));
  };
  const Native = window.ResizeObserver, live = new Set();
  window.groupObservers = () => ({ made, live: live.size });
  window.ResizeObserver = class extends Native {
    observe(node, options) { if (node.dataset && node.dataset.section === "openai-key") { made += 1; live.add(this); } return super.observe(node, options); }
    disconnect() { live.delete(this); return super.disconnect(); }
  };
})();
`;
interface HeldVoice { voiceAsked: () => number; releaseVoice: () => void; groupObservers: () => { made: number; live: number } }

/**
 * The OpenAI key's group, whose form waits for the server's answer, on React's development build:
 * StrictMode runs the landing's effect, its cleanup and the effect again, and the group is still
 * followed into view when the held answer comes. A reader who scrolled before it came stays where
 * they scrolled.
 */
async function heldGroupLanding(browser: import("playwright-core").Browser, url: string): Promise<void> {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true, locale: "en" });
  try {
    await context.addInitScript((settings) => localStorage.setItem("ovis:settings", settings), JSON.stringify(SETTINGS));
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const body = page.locator(".settings-body:not([hidden])");
    const observers = () => page.evaluate(() => (window as unknown as HeldVoice).groupObservers());
    const land = async (): Promise<void> => {
      await page.goto(url);
      await page.locator(".conn-live").waitFor({ state: "attached" });
      const asked = await page.evaluate(() => (window as unknown as HeldVoice).voiceAsked());
      await openPalette(page, "OpenAI API key");
      await page.locator(".palette-section[data-section='settings-pages'] [role='option']").first().click();
      await page.waitForFunction((asked) => (document.activeElement as HTMLElement | null)?.dataset.section === "openai-key" && (window as unknown as HeldVoice).voiceAsked() > asked, asked);
      assert.equal(await page.locator(".voice-key").count(), 0, "the key's form waits for the held answer");
    };
    await land();
    const replayed = await observers();
    assert.equal(replayed.live, 1, `one observer still follows the group after StrictMode's cleanup of the landing (${JSON.stringify(replayed)})`);
    assert.ok(replayed.made >= 2, `the follow was set up again after the replay's cleanup (${replayed.made} observers made)`);
    await page.evaluate(() => (window as unknown as HeldVoice).releaseVoice());
    await page.locator(".voice-key input").waitFor();
    await page.waitForFunction(() => {
      const body = document.querySelector(".settings-body:not([hidden])")?.getBoundingClientRect();
      const control = document.querySelector("[data-section='openai-key'] input")?.getBoundingClientRect();
      return body !== undefined && control !== undefined && control.top >= body.top - 1 && control.bottom <= body.bottom + 1;
    });

    await land();
    assert.ok(await body.evaluate((node) => node.scrollTop) > 0, "the landing scrolled to the group");
    // the reader goes back to the page's top with the hardware keyboard before the answer comes
    await page.keyboard.press("Home");
    await page.waitForFunction(() => document.querySelector(".settings-body:not([hidden])")?.scrollTop === 0);
    await page.evaluate(() => (window as unknown as HeldVoice).releaseVoice());
    await page.locator(".voice-key input").waitFor();
    // the frames after the form arrives, when an observer still following would have scrolled to it
    await page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
    assert.equal(await body.evaluate((node) => node.scrollTop), 0, "a reader who scrolled away is not pulled back");
    assert.equal((await observers()).live, 0, "the reader's scroll ended the follow");
    assert.deepEqual(errors, []);
    console.log("PASS under development StrictMode the OpenAI key's group is followed into view when its held form arrives, and a reader's scroll ends it");
  } finally {
    await context.close();
  }
}

const checkSelectArrows = async (page: Page): Promise<void> => {
  const controls = await page.locator(".settings-select").evaluateAll((nodes) => nodes.map((select) => {
    const arrow = select.parentElement?.querySelector("svg");
    if (!arrow) return { arrow: false };
    const field = select.getBoundingClientRect();
    const glyph = arrow.getBoundingClientRect();
    const style = getComputedStyle(select);
    return {
      arrow: true,
      inset: field.right - glyph.right,
      expectedInset: parseFloat(style.paddingLeft),
      centered: Math.abs((field.top + field.bottom) / 2 - (glyph.top + glyph.bottom) / 2) < 1,
      textClear: parseFloat(style.paddingRight) > field.right - glyph.left,
      nativeArrowHidden: style.appearance === "none",
      clickThrough: getComputedStyle(arrow).pointerEvents === "none",
      decorative: arrow.getAttribute("aria-hidden") === "true",
    };
  }));
  for (const control of controls) {
    assert.equal(control.arrow, true, "each Settings select has an inset chevron");
    assert.ok(Math.abs(control.inset! - control.expectedInset!) < 1, "the chevron matches the text inset");
    for (const key of ["centered", "textClear", "nativeArrowHidden", "clickThrough", "decorative"] as const) assert.equal(control[key], true, key);
  }
};

try {
  await buildDemoApp(app);
  await buildDevelopmentDemoApp(devApp);
  writeFileSync(join(devApp, "hold-voice.js"), HOLD_VOICE);
  for (const [dir, extra] of [[app, ""], [devApp, `<script src="./hold-voice.js"></script>`]] as const) {
    const index = join(dir, "index.html");
    writeFileSync(index, readFileSync(index, "utf8").replace(/<script type="module"/, () => `<script src="./demo-transport.js"></script>${extra}${DEMO_FILE_PREVIEW_SCRIPT}\n    <script type="module"`));
  }
  const roots = { "/herdr-web-ui/demo/app/": app, "/herdr-web-ui/demo/dev/": devApp };
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const path = new URL(request.url).pathname;
    const [prefix, root] = Object.entries(roots).find(([prefix]) => path.startsWith(prefix)) ?? [];
    if (prefix === undefined || root === undefined) return new Response("not found", { status: 404 });
    let file: string;
    try { file = decodeURIComponent(path.slice(prefix.length)); }
    catch { return new Response("bad path", { status: 400 }); }
    if (!file || file.endsWith("/")) file += "index.html";
    if (file.split("/").includes("..") || file.includes("\\")) return new Response("bad path", { status: 400 });
    const body = Bun.file(join(root, file));
    return await body.exists() ? new Response(body) : new Response("not found", { status: 404 });
  } });
  const url = `http://127.0.0.1:${server.port}/herdr-web-ui/demo/app/`;
  const devUrl = `http://127.0.0.1:${server.port}/herdr-web-ui/demo/dev/`;
  try {
    const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? chromium.executablePath(), headless: true, args: ["--no-sandbox"] });
    try {
      for (const [width, language] of [[390, "en"], [320, "en"], [320, "ko"], [320, "ja"], [320, "zh"]] as const) {
        const started = performance.now();
        const strings: Record<string, string> = language === "ko" ? KO : language === "ja" ? JA : language === "zh" ? ZH : {};
        const label = (name: string): string => strings[name] ?? name;
        const context = await browser.newContext({ viewport: { width, height: 760 }, isMobile: true, hasTouch: true, locale: language });
        try {
          await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: new URL(url).origin });
          await context.addInitScript((settings) => { if (localStorage.getItem("ovis:settings") === null) localStorage.setItem("ovis:settings", settings); }, JSON.stringify({ ...SETTINGS, language }));
          const page = await context.newPage();
          const errors: string[] = [];
          page.on("pageerror", (error) => errors.push(error.message));
          await page.goto(url);
          await page.locator(".conn-live").waitFor({ state: "attached" });
          const terminal = page.locator(".pane-terminal");
          await terminal.waitFor({ state: "attached" });
          const lens = page.getByRole("group", { name: "Pane view", exact: true });
          await lens.getByTitle(label("Live terminal (⌘⇧J)"), { exact: true }).tap();
          assert.equal(await terminal.getAttribute("role"), "region");
          assert.equal(await terminal.getAttribute("aria-roledescription"), label("Terminal"));
          assert.equal(await terminal.getAttribute("aria-label"), label("Terminal for {title}").replace("{title}", "Idempotent payments"));
          assert.equal(await terminal.getAttribute("tabindex"), null, "the wrapper adds no empty keyboard stop");
          await lens.getByTitle(label("Chat transcript (⌘⇧J)"), { exact: true }).tap();
          assert.equal(await terminal.getAttribute("role"), null, "chat exposes no empty terminal landmark");
          assert.equal(await terminal.getAttribute("aria-label"), null);
          await openSettings(page);
          for (const name of PAGES) {
            await openSettingsPage(page, label(name), label("Back to settings"));
            // what a page asks the server for (devices, the phone address, the accounts) has arrived
            await page.waitForFunction((loading) => ![...document.querySelectorAll(".settings-body [role='status']")].some((node) => loading.includes(node.textContent?.trim() ?? "")),
              [label("Loading…"), label("Asking this PC about Tailscale…")]);
            if (name === "Appearance" && process.env.UI_EVIDENCE_DIR) await page.screenshot({ path: join(process.env.UI_EVIDENCE_DIR, `select-arrows-${width}-${language}.png`), animations: "disabled" });
            await checkSelectArrows(page);
            if (name === "Agents") await page.locator(".usage-accounts-row").first().waitFor();
            if (name === "Voice input") {
              await page.locator(".voice-key").waitFor();
              const dictation = page.getByLabel(label("Dictation language"), { exact: true });
              await dictation.selectOption("hu-HU");
              await page.waitForFunction(() => JSON.parse(localStorage.getItem("ovis:settings")!).voiceLanguage === "hu-HU");
              assert.equal(await dictation.inputValue(), "hu-HU");
              assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem("ovis:settings")!).language), language,
                "dictation selection does not change the display language");
              await dictation.selectOption("auto");
            }
            if (name === "Agents") {
              // the demo's PC has Claude Code, Codex, Oh My Pi, pi and Hermes; its accounts go under their
              // agent, and the rest (Cursor, OpenCode, whose agent is not on the PC) under Other accounts
              const body = page.locator(".settings-body:not([hidden])");
              await body.locator(".agents-item").first().waitFor();
              assert.equal(await body.locator("[role='alert']").count(), 0, "the Agents page shows no error");
              assert.deepEqual(await body.locator(".agents-item").evaluateAll((rows) => rows.map((row) => row.getAttribute("data-agent"))), ["claude", "codex", "omp", "pi", "hermes"]);
              assert.deepEqual(await body.locator("[data-section='other-accounts'] .usage-provider-heading > span:not(.usage-account-count):not(.agent-mark)").allTextContents(), ["Cursor", "OpenCode"]);
              assert.deepEqual(await body.locator("h3").allTextContents(), [label("On this PC"), label("Other agents herdr found"), label("Not found on this PC"), label("Other accounts"), label("New agents"), label("Plan limits")]);
              // herdr's integrations no row shows: found on the PC first, then the rest, each with its command
              assert.deepEqual(await body.locator("[data-section='integrations'] .settings-label").allTextContents(), ["opencode"]);
              assert.deepEqual(await body.locator("[data-section='integrations-missing'] .settings-label").allTextContents(), ["copilot", "cursor", "antigravity-cli"]);
              // the launch modes are always there, whatever the PC has
              assert.equal(await body.locator("[data-section='launch-modes'] select").count(), 2);
              const install = (target: string): string => `herdr integration install ${target}`;
              const copyLabel = (target: string): string => label("Copy the command for {name}").replace("{name}", target);
              // a row opens on its accounts and herdr's session resume
              const codex = body.locator(".agents-item[data-agent='codex']");
              await codex.locator(".agents-toggle").tap();
              assert.equal(await codex.locator(".agents-toggle").getAttribute("aria-expanded"), "true");
              assert.equal(await codex.locator(".usage-accounts-row").count(), 2, "Codex's two accounts are in its row");
              assert.equal(await codex.locator("code").textContent(), install("codex"));
              const copy = codex.getByRole("button", { name: copyLabel("codex"), exact: true });
              await copy.tap();
              await codex.getByRole("button", { name: copyLabel("codex"), exact: true }).filter({ hasText: label("Copied") }).waitFor();
              assert.equal(await page.evaluate(() => navigator.clipboard.readText()), install("codex"));
              // a move within Codex's row swaps its two accounts and leaves Claude's place in the meters' order
              const second = codex.locator(".usage-accounts-row").nth(1);
              const moved = await second.locator(".usage-accounts-account").textContent();
              await second.locator(".usage-accounts-actions .icon-button").first().tap();
              await page.waitForFunction(() => (JSON.parse(localStorage.getItem("ovis:settings")!).usageOrder as string[]).length > 0);
              const order = await page.evaluate(() => JSON.parse(localStorage.getItem("ovis:settings")!).usageOrder as string[]);
              assert.ok(order[0]!.startsWith("claude"), `Claude keeps the first place: ${order.join(", ")}`);
              assert.equal(await codex.locator(".usage-accounts-row").first().locator(".usage-accounts-account").textContent(), moved);
              // a Check again that fails after a good read keeps the rows it had, and says why beside them
              await page.evaluate(() => {
                const passing = window.fetch;
                (window as unknown as { restoreCatalog: () => void }).restoreCatalog = () => { window.fetch = passing; };
                window.fetch = (input, init) => new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, location.href).pathname === "/api/agent-catalog"
                  ? Promise.resolve(Response.json({ error: { code: "fixture", message: "The catalog check failed (fixture)." } }, { status: 500 }))
                  : passing(input, init);
              });
              await body.getByRole("button", { name: label("Check again"), exact: true }).tap();
              await body.locator("[data-section='agents-installed'] [role='alert']").filter({ hasText: "The catalog check failed (fixture)." }).waitFor();
              assert.equal(await codex.locator(".usage-accounts-row").count(), 2, "Codex's accounts stay after a failed Check again");
              assert.deepEqual(await body.locator(".agents-item").evaluateAll((rows) => rows.map((row) => row.getAttribute("data-agent"))), ["claude", "codex", "omp", "pi", "hermes"]);
              await page.evaluate(() => (window as unknown as { restoreCatalog: () => void }).restoreCatalog());
              await body.getByRole("button", { name: label("Check again"), exact: true }).tap();
              await body.locator("[data-section='agents-installed'] [role='alert']").waitFor({ state: "detached" });
              await codex.locator(".agents-toggle").tap();
            }
            if (name === "Appearance" && language === "en") {
              // each legacy palette-mode is written to the document and saved, and its blocks of styles.css
              // reach the page: every color token computes to the frozen baseline's used value
              // (src/lib/themes.legacy-baseline.json), and the --term-* tokens to the theme xterm is given.
              // The build minifies colors (rgba() to #rrggbbaa), so both sides are compared as the browser
              // computes them on a probe: a color, a box-shadow, or a border for `2px solid <color>`
              const themes = page.getByRole("group", { name: "Theme", exact: true });
              const pickers = { dark: page.locator("#settings-theme-dark"), light: page.locator("#settings-theme-light") };
              // both pickers offer every theme, grouped by kind with the side's own kind first (Q1: any theme on either side)
              for (const side of ["dark", "light"] as const) {
                const listed = await pickers[side].locator("option").evaluateAll((nodes) => nodes.map((node) => (node as HTMLOptionElement).value));
                assert.deepEqual([...listed].sort(), [...THEME_IDS].sort(), `the ${side} picker lists every theme once`);
                assert.ok(listed.includes("dracula"), `the ${side} picker offers Dracula`);
                assert.deepEqual(await pickers[side].locator("optgroup").evaluateAll((nodes) => nodes.map((node) => node.getAttribute("label"))), side === "dark" ? ["Dark", "Light"] : ["Light", "Dark"]);
              }
              const drawn = (mode: string, id: string): Promise<unknown> => page.waitForFunction(([mode, id]) => document.documentElement.dataset.theme === mode && document.documentElement.dataset.palette === id && getComputedStyle(document.documentElement).colorScheme === mode, [mode, id]);
              /** The theme keys of the saved record and of the second key old code never touches. */
              const stored = () => page.evaluate(() => {
                const record = JSON.parse(localStorage.getItem("ovis:settings")!) as Record<string, string>;
                const themes = JSON.parse(localStorage.getItem("ovis:themes")!) as Record<string, string>;
                return { palette: record["palette"], darkTheme: record["darkTheme"], lightTheme: record["lightTheme"], second: { darkTheme: themes["darkTheme"], lightTheme: themes["lightTheme"] } };
              });
              const xtermTokens = (mode: "dark" | "light", id: ThemeId): (readonly [string, string])[] => {
                const xterm = terminalTheme(mode, id);
                return ([["--term-bg", xterm.background], ["--term-fg", xterm.foreground], ["--term-cursor", xterm.cursor], ["--term-selection", xterm.selectionBackground]] as const).map(([name, value]) => [`xterm ${name}`, value] as const);
              };
              /** The expected tokens the page computes differently, as `name: want -> got`. */
              const drift = (expected: (readonly [string, string])[]): Promise<string[]> => page.evaluate((expected) => {
                const root = getComputedStyle(document.documentElement);
                const probe = document.body.appendChild(document.createElement("div"));
                const used = (value: string): string => {
                  const kind = /\bsolid\b/.test(value) ? "border" : /\dpx\b/.test(value) ? "boxShadow" : "color";
                  probe.removeAttribute("style");
                  probe.style[kind] = value;
                  if (probe.style[kind] === "") return `invalid ${kind}: ${value}`;
                  const style = getComputedStyle(probe);
                  return kind === "border" ? `${style.borderTopWidth} ${style.borderTopStyle} ${style.borderTopColor}` : style[kind];
                };
                const out = expected.flatMap(([name, value]) => {
                  const [want, got] = [used(value), used(root.getPropertyValue(name.replace(/^xterm /, "")))];
                  return want === got ? [] : [`${name}: ${want} -> ${got}`];
                });
                probe.remove();
                return out;
              }, expected);
              const combos: Record<string, { resolved: Record<string, string> }> = baseline.combos;
              for (const { palette: id, mode } of LEGACY_COMBOS) {
                const key = comboKey(id, mode);
                await themes.getByRole("button", { name: mode === "dark" ? "Dark" : "Light", exact: true }).tap();
                await pickers[mode].selectOption(id);
                await drawn(mode, id);
                await checkSelectArrows(page);
                assert.equal((await stored()).palette, id);
                assert.deepEqual(await drift([...Object.entries(combos[key]!.resolved), ...xtermTokens(mode, id)]), [], `${key}: the page computes the frozen colors, and --term-* as the theme xterm is given`);
                if (key === "catppuccin/dark" && process.env.UI_EVIDENCE_DIR) await page.screenshot({ path: join(process.env.UI_EVIDENCE_DIR, `catppuccin-palette-${width}.png`), fullPage: true });
              }
              // a herdr pair: Tokyo Night on the dark side fills the untouched light side with Tokyo Night Day, each
              // side draws its own row with its xterm colors, and the look follows the mode toggle
              await themes.getByRole("button", { name: "Dark", exact: true }).tap();
              await pickers.light.selectOption("amber");
              await pickers.dark.selectOption("tokyo-night");
              await drawn("dark", "tokyo-night");
              assert.deepEqual(await stored(), { palette: "tokyo-night", darkTheme: "tokyo-night", lightTheme: "tokyo-night-day", second: { darkTheme: "tokyo-night", lightTheme: "tokyo-night-day" } }, "a paired dark theme fills the light side still at its default with its sibling");
              assert.equal(await pickers.light.inputValue(), "tokyo-night-day");
              assert.deepEqual(await drift(xtermTokens("dark", "tokyo-night")), [], "tokyo-night/dark: --term-* as the theme xterm is given");
              await themes.getByRole("button", { name: "Light", exact: true }).tap();
              await drawn("light", "tokyo-night-day");
              assert.equal((await stored()).palette, "tokyo-night-day", "the legacy palette mirrors the side the mode draws");
              assert.deepEqual(await drift(xtermTokens("light", "tokyo-night-day")), [], "tokyo-night-day/light: --term-* as the theme xterm is given");
              // any theme on either side (Q1): a dark theme picked for the light side draws dark in Light mode
              await pickers.light.selectOption("tokyo-night");
              await drawn("dark", "tokyo-night");
              assert.deepEqual(await stored(), { palette: "tokyo-night", darkTheme: "tokyo-night", lightTheme: "tokyo-night", second: { darkTheme: "tokyo-night", lightTheme: "tokyo-night" } }, "a dark theme on the light side is kept as chosen");
              assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem("ovis:settings")!).theme), "light", "the mode stays Light while the row drawn is dark");
              // a side chosen by hand keeps its theme when the other side picks a pair
              await themes.getByRole("button", { name: "Dark", exact: true }).tap();
              await pickers.dark.selectOption("gruvbox");
              await drawn("dark", "gruvbox");
              assert.deepEqual(await stored(), { palette: "gruvbox", darkTheme: "gruvbox", lightTheme: "tokyo-night", second: { darkTheme: "gruvbox", lightTheme: "tokyo-night" } }, "a light side chosen by hand is not filled with the pair's sibling");
              // the pages after this one are checked on the default theme
              await pickers.dark.selectOption("amber");
              await pickers.light.selectOption("amber");
              await drawn("dark", "amber");
            }
            assert.deepEqual(await cutOff(page), [], `${name} fits a ${width}px phone (${language})`);
          }
          await openSettingsPage(page, label("Terminal"), label("Back to settings"));
          await page.getByRole("button", { name: label("Edit key bar"), exact: true }).tap();
          await page.locator(".key-bar-settings").waitFor();
          assert.deepEqual(await cutOff(page), [], `Key bar fits a ${width}px phone (${language})`);
          await page.getByRole("button", { name: label("Back to settings"), exact: true }).tap();
          // the quick replies are text fields beside a Remove button each: both stay in the card
          if (language === "en") {
            await openSettingsPage(page, "Chat");
            const replies = page.locator(".quick-replies-list li");
            assert.ok(await replies.count() > 0);
            await page.getByRole("button", { name: "Remove quick reply 1", exact: true }).tap();
            assert.equal(await replies.count(), (JSON.parse(await page.evaluate(() => localStorage.getItem("ovis:settings")!)) as { quickReplies: string[] }).quickReplies.length);
            await page.getByRole("button", { name: "Restore defaults", exact: true }).tap();
          }
          assert.deepEqual(errors, []);
          await page.getByRole("button", { name: label("Close settings"), exact: true }).tap();
          if (language === "en") {
            const composer = page.locator(".composer-text");
            await composer.fill("/");
            const menu = page.getByRole("listbox", { name: "Slash commands" });
            await menu.getByRole("option").last().waitFor();
            await composer.press("ArrowUp");
            await page.waitForFunction(() => {
              const menu = document.querySelector(".composer-menu");
              const active = menu?.querySelector('[aria-selected="true"]');
              if (!menu || !active) return false;
              const box = menu.getBoundingClientRect(), row = active.getBoundingClientRect();
              // the terminal commands end the list, so the last row is the last of them
              return active === [...menu.querySelectorAll('[role="option"]')].at(-1) && active.textContent?.includes("terminal-setup") && row.top >= box.top && row.bottom <= box.bottom;
            });
            // Enter right after the keystroke that narrows the list, before React's next render, completes the row
            await page.evaluate(async () => {
              const box = document.querySelector<HTMLTextAreaElement>(".composer-text")!;
              Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(box, "/comments");
              box.selectionStart = box.selectionEnd = box.value.length;
              box.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }));
              await Promise.resolve(); await Promise.resolve();
              box.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
            });
            await page.waitForFunction(() => document.querySelector<HTMLTextAreaElement>(".composer-text")?.value === "/pr-comments ");
            await composer.fill("/comments");
            await menu.getByRole("option").filter({ hasText: "pr-comments" }).waitFor();
            assert.equal(await menu.getByRole("option").count(), 1);
            await composer.press("Tab");
            await page.waitForFunction(() => document.querySelector<HTMLTextAreaElement>(".composer-text")?.value === "/pr-comments ");
            assert.equal(await composer.inputValue(), "/pr-comments ");
            // a key typed after a completion, before the next frame (a busy phone), stays where it was typed
            await composer.fill("/comments");
            await menu.getByRole("option").filter({ hasText: "pr-comments" }).waitFor();
            await page.evaluate(() => {
              const real = window.requestAnimationFrame, held: FrameRequestCallback[] = [];
              window.requestAnimationFrame = (callback) => { held.push(callback); return 0; };
              addEventListener("release-frames", () => {
                window.requestAnimationFrame = real;
                for (const callback of held) callback(performance.now());
              }, { once: true });
            });
            await composer.press("Tab");
            await page.keyboard.type("a");
            await page.evaluate(() => dispatchEvent(new Event("release-frames")));
            await page.keyboard.type("b");
            assert.equal(await composer.inputValue(), "/pr-comments ab");
            await composer.fill("/rln");
            await menu.getByRole("option").filter({ hasText: "release-notes" }).waitFor();
            assert.equal(await menu.getByRole("option").count(), 1);
            await composer.fill("");
            console.log(`PASS fuzzy commands and offscreen keyboard selection (${width}px)`);
          }
          console.log(`PASS every Settings page and key bar fit a ${width}px phone (${language}); ${(performance.now() - started).toFixed(0)}ms`);
        } finally {
          await context.close();
        }
      }

      const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, locale: "en-US" });
      try {
        await phone.addInitScript((settings) => localStorage.setItem("ovis:settings", settings), JSON.stringify(SETTINGS));
        // every move of the history, for historyHolds to tell when a step never lands
        await phone.addInitScript(() => {
          const trace: string[] = [];
          (window as unknown as { historyTrace: string[] }).historyTrace = trace;
          const note = (what: string): void => { trace.push(`${Math.round(performance.now())}ms ${what} ${JSON.stringify(history.state)} ${location.search}`); };
          for (const method of ["go", "back", "pushState", "replaceState"] as const) {
            const call = (history[method] as (...args: unknown[]) => void).bind(history);
            (history as unknown as Record<string, unknown>)[method] = (...args: unknown[]) => { note(`before ${method}(${method === "go" ? String(args[0]) : ""})`); call(...args); note(`after ${method}`); };
          }
          addEventListener("popstate", () => note("popstate"), true);
          note("loaded");
        });
        // a load that was asked to hold its steps back keeps them until the app has drawn itself, as a
        // slow device does, and notes whether Settings was ever shown
        await phone.addInitScript(() => {
          if (sessionStorage.getItem("hold-steps-back") !== "1") return;
          sessionStorage.removeItem("hold-steps-back");
          const page = window as unknown as { releaseStepsBack: () => void; settingsShown: boolean };
          const go = history.go.bind(history);
          const held: Array<() => void> = [];
          history.go = (delta?: number) => { held.push(() => go(delta)); };
          page.releaseStepsBack = () => { history.go = go; for (const step of held.splice(0)) step(); };
          page.settingsShown = false;
          new MutationObserver(() => { if (document.querySelector(".settings-dialog") !== null) page.settingsShown = true; }).observe(document, { childList: true, subtree: true });
        });
        const page = await phone.newPage();
        const errors: string[] = [];
        page.on("pageerror", (error) => errors.push(error.message));
        await page.goto(url);
        await page.locator(".conn-live").waitFor({ state: "attached" });
        const dialog = dialogOf(page);
        const list = dialog.getByRole("tablist");

        // Back steps out one screen at a time: the key bar editor, the page, the list, and only then nothing.
        // The address names the pane shown (lib/deepLink.ts) once the roster is in: that is where Back returns
        await page.waitForFunction(() => new URLSearchParams(window.location.search).has("pane"));
        const before = page.url();
        await openSettings(page);
        assert.deepEqual(await entryOf(page), { page: null, keyBar: false, depth: 1 });
        await openSettingsPage(page, "Terminal");
        await dialog.getByRole("button", { name: "Edit key bar", exact: true }).tap();
        await page.getByRole("dialog", { name: "Key bar", exact: true }).waitFor();
        assert.deepEqual(await entryOf(page), { page: "terminal", keyBar: true, depth: 3 });
        await page.goBack();
        await dialog.getByRole("tabpanel", { name: "Terminal", exact: true }).waitFor();
        assert.equal(await page.locator(".key-bar-settings").count(), 0);
        await page.goBack();
        await list.waitFor();
        assert.equal(await dialog.getByRole("tabpanel").count(), 0, "Back from a page shows the list again");
        await page.goBack();
        await page.locator(".settings-dialog").waitFor({ state: "detached" });
        assert.equal(await entryOf(page), null);
        assert.equal(page.url(), before, "the last Back closes Settings and leaves the app where it was");
        await page.locator(".conn-live").waitFor({ state: "attached" });
        console.log("PASS Back on a phone leaves the key bar editor, then the page, then the list, and stays in the app");

        // the dialog's own Back control takes the same entry off: the next Back is not spent on it
        await openSettings(page);
        await openSettingsPage(page, "Chat");
        await dialog.getByRole("button", { name: "Back to settings", exact: true }).tap();
        await list.waitFor();
        await historyHolds(page, "the Back control to the list", () => (history.state as Record<string, { depth: number }> | null)?.["ovis:settings"]?.depth === 1);
        await page.goBack();
        await page.locator(".settings-dialog").waitFor({ state: "detached" });
        console.log("PASS the Back control in the dialog and the system Back button share one history");

        // closing from the deepest screen leaves no entry behind, and Forward does not reopen what the X closed by itself
        await openSettings(page);
        await openSettingsPage(page, "Terminal");
        await dialog.getByRole("button", { name: "Edit key bar", exact: true }).tap();
        await page.getByRole("button", { name: "Close settings", exact: true }).tap();
        await page.locator(".settings-dialog").waitFor({ state: "detached" });
        await historyHolds(page, "the X from the key bar editor", () => (history.state as Record<string, unknown> | null)?.["ovis:settings"] === undefined);
        // and a new opening starts on the list, with one entry
        await openSettings(page);
        await list.waitFor();
        await historyHolds(page, "a new opening", () => (history.state as Record<string, { depth: number }> | null)?.["ovis:settings"]?.depth === 1);
        // a reload keeps the history but not the dialog: its entries are stepped out of. The step lands
        // when the browser gets to it, which on a slow device is after the app has drawn itself from an
        // address that still names Settings: held back until then here, it must not show the dialog
        await openSettingsPage(page, "Alerts");
        await page.waitForFunction(() => new URLSearchParams(window.location.search).get("settings") === "alerts");
        await page.evaluate(() => sessionStorage.setItem("hold-steps-back", "1"));
        await page.reload();
        await page.locator(".conn-live").waitFor({ state: "attached" });
        await page.evaluate(() => (window as unknown as { releaseStepsBack: () => void }).releaseStepsBack());
        await historyHolds(page, "the reload", () => (history.state as Record<string, unknown> | null)?.["ovis:settings"] === undefined);
        assert.equal(await page.locator(".settings-dialog").count(), 0, "a reload does not reopen Settings");
        assert.equal(await page.evaluate(() => (window as unknown as { settingsShown: boolean }).settingsShown), false, "a reload never shows Settings, however late its step back lands");
        assert.deepEqual(errors, []);
        console.log("PASS the X from the key bar editor and a reload leave no Settings entry in the history");

        // a link to Settings opens it, and a reload there closes it as well: the entry the reload
        // steps back to is the one the link opened, whose address names Settings still
        await page.goto(`${url}?settings=about`);
        await dialog.getByRole("tabpanel", { name: "About", exact: true }).waitFor();
        await historyHolds(page, "a link to Settings", () => (history.state as Record<string, { page: string; depth: number }> | null)?.["ovis:settings"]?.page === "about");
        await page.reload();
        await page.locator(".conn-live").waitFor({ state: "attached" });
        await historyHolds(page, "the reload on a linked Settings", () => (history.state as Record<string, unknown> | null)?.["ovis:settings"] === undefined && !new URLSearchParams(window.location.search).has("settings"));
        assert.equal(await page.locator(".settings-dialog").count(), 0, "a reload closes the Settings a link opened");
        assert.deepEqual(errors, []);
        console.log("PASS a link to Settings opens it, and a reload there closes it");

        // another script's entries pushed while Settings is open bury its entries: Back out of them
        // closes Settings, and the next Back steps over the buried entries instead of opening them again
        await page.goto(url);
        await page.locator(".conn-live").waitFor({ state: "attached" });
        await openSettings(page);
        await openSettingsPage(page, "Terminal");
        await dialog.getByRole("button", { name: "Edit key bar", exact: true }).tap();
        await page.getByRole("dialog", { name: "Key bar", exact: true }).waitFor();
        await historyHolds(page, "the key bar editor", () => (history.state as Record<string, { depth: number }> | null)?.["ovis:settings"]?.depth === 3);
        await page.evaluate(() => { history.pushState({ route: "markerless" }, ""); history.pushState({ route: "after-markerless" }, ""); });
        await page.goBack();
        await page.locator(".settings-dialog").waitFor({ state: "detached" });
        await page.evaluate(() => {
          const seen = window as unknown as { settingsShown: boolean };
          seen.settingsShown = false;
          new MutationObserver(() => { if (document.querySelector(".settings-dialog") !== null) seen.settingsShown = true; }).observe(document, { childList: true, subtree: true });
        });
        await page.goBack();
        await historyHolds(page, "Back over the buried entries", () => {
          const state = history.state as Record<string, unknown> | null;
          return state?.["ovis:settings"] === undefined && state?.["route"] === undefined;
        });
        assert.equal(await page.locator(".settings-dialog").count(), 0, "Back under an unrelated entry does not reopen Settings");
        assert.equal(await page.evaluate(() => (window as unknown as { settingsShown: boolean }).settingsShown), false, "the buried entries are stepped over without showing Settings");
        assert.deepEqual(errors, []);
        console.log("PASS Back past an unrelated entry steps over the Settings entries it buried");
      } finally {
        await phone.close();
      }

      if (process.env.UI_EVIDENCE_DIR) {
        for (const width of [1280, 390]) {
          const context = await browser.newContext({
            viewport: { width, height: width === 390 ? 844 : 800 },
            isMobile: width === 390, hasTouch: width === 390, locale: "en-US",
          });
          try {
            await context.addInitScript((settings) => localStorage.setItem("ovis:settings", settings), JSON.stringify(SETTINGS));
            const page = await context.newPage();
            await page.goto(url);
            await page.locator(".conn-live").waitFor({ state: "attached" });
            await openSettings(page);
            await openSettingsPage(page, "Appearance");
            for (const mode of ["light", "dark"]) {
              await page.getByRole("group", { name: "Theme", exact: true }).getByRole("button", { name: mode === "dark" ? "Dark" : "Light", exact: true }).click();
              await page.waitForFunction((mode) => document.documentElement.dataset.theme === mode, mode);
              await checkSelectArrows(page);
              await page.screenshot({ path: join(process.env.UI_EVIDENCE_DIR, `select-arrows-${width}-${mode}.png`), animations: "disabled" });
            }
          } finally {
            await context.close();
          }
        }
      }

      const desktop = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: "en-US" });
      try {
        await desktop.addInitScript((settings) => {
          if (localStorage.getItem("ovis:settings") === null) localStorage.setItem("ovis:settings", settings);
        }, JSON.stringify(SETTINGS));
        const page = await desktop.newPage();
        const errors: string[] = [];
        page.on("pageerror", (error) => errors.push(error.message));
        await page.goto(url);
        await page.locator(".conn-live").waitFor({ state: "attached" });
        await openSettings(page);
        await openSettingsPage(page, "Appearance");
        await checkSelectArrows(page);
        if (process.env.UI_EVIDENCE_DIR) await page.screenshot({ path: join(process.env.UI_EVIDENCE_DIR, "select-arrows-desktop.png"), animations: "disabled" });
        const themePicker = page.getByLabel("Dark theme", { exact: true });
        await themePicker.focus();
        await page.keyboard.press("ArrowDown");
        assert.notEqual(await themePicker.inputValue(), "amber", "the native select keeps keyboard selection");
        await themePicker.selectOption("amber");
        await page.emulateMedia({ forcedColors: "active" });
        assert.equal(await themePicker.evaluate((select) => getComputedStyle(select).appearance), "auto", "forced colors restores the native indicator");
        assert.equal(await themePicker.locator("..").locator("svg").evaluate((arrow) => getComputedStyle(arrow).display), "none");
        await page.emulateMedia({ forcedColors: "none" });
        await checkSelectArrows(page);
        await page.keyboard.press("Escape");
        await page.locator(".settings-dialog").waitFor({ state: "detached" });
        // Settings is opened again below: its close's step back lands first, or, landing over a second late,
        // it is taken for a Back and closes the Settings opened meanwhile (settingsHistory's landing deadline)
        await page.waitForFunction(() => (history.state as Record<string, unknown> | null)?.["ovis:settings"] === undefined);
        for (const id of ["dracula", "nord", "vesper", "black"]) {
          await openSettings(page);
          await openSettingsPage(page, "Appearance");
          await page.getByRole("group", { name: "Theme", exact: true }).getByRole("button", { name: "Dark", exact: true }).click();
          await page.locator("#settings-theme-dark").selectOption(id);
          await page.waitForFunction((id) => document.documentElement.dataset.palette === id && document.documentElement.dataset.theme === "dark", id);
          assert.equal(await page.locator("#settings-theme-light").inputValue(), "amber", `${id} has no sibling pre-fill`);
          const surfaces = await page.evaluate(() => {
            const style = getComputedStyle(document.documentElement);
            return ["--border", "--bg-elevated", "--bg-input"].map((role) => style.getPropertyValue(role).trim());
          });
          assert.notEqual(surfaces[0], surfaces[1], `${id} border differs from elevated surface`);
          assert.notEqual(surfaces[0], surfaces[2], `${id} border differs from input surface`);
          await checkSelectArrows(page);
          if (process.env.UI_EVIDENCE_DIR) await page.screenshot({ path: join(process.env.UI_EVIDENCE_DIR, `${id}-appearance-1280.png`), animations: "disabled" });
          await page.keyboard.press("Escape");
          await page.locator(".settings-dialog").waitFor({ state: "detached" });
          await page.waitForFunction(() => (history.state as Record<string, unknown> | null)?.["ovis:settings"] === undefined);
          await page.locator(".composer-text").waitFor();
          if (process.env.UI_EVIDENCE_DIR) await page.screenshot({ path: join(process.env.UI_EVIDENCE_DIR, `${id}-chat-1280.png`), animations: "disabled" });
        }
        await openSettings(page);
        await openSettingsPage(page, "Appearance");
        await page.locator("#settings-theme-light").selectOption("dracula");
        await page.getByRole("group", { name: "Theme", exact: true }).getByRole("button", { name: "Light", exact: true }).click();
        await page.waitForFunction(() => document.documentElement.dataset.palette === "dracula" && document.documentElement.dataset.theme === "dark" && getComputedStyle(document.documentElement).colorScheme === "dark");
        assert.equal(await page.getByRole("group", { name: "Theme", exact: true }).getByRole("button", { name: "Light", exact: true }).getAttribute("aria-pressed"), "true");
        assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem("ovis:settings")!).theme), "light");
        if (process.env.UI_EVIDENCE_DIR) await page.screenshot({ path: join(process.env.UI_EVIDENCE_DIR, "dracula-light-side-1280.png"), animations: "disabled" });
        await page.evaluate(() => {
          const settings = JSON.parse(localStorage.getItem("ovis:settings")!);
          localStorage.setItem("ovis:settings", JSON.stringify({ ...settings, theme: "light", lightTheme: "not-a-theme" }));
          localStorage.setItem("ovis:themes", JSON.stringify({ darkTheme: "vesper", lightTheme: "not-a-theme" }));
        });
        await page.reload();
        await page.locator(".conn-live").waitFor({ state: "attached" });
        await page.waitForFunction(() => document.documentElement.dataset.palette === "codex" && document.documentElement.dataset.theme === "light" && getComputedStyle(document.documentElement).colorScheme === "light");
        if (process.env.UI_EVIDENCE_DIR) writeFileSync(join(process.env.UI_EVIDENCE_DIR, "any-side.txt"), "PASS Light mode with lightTheme=dracula draws data-theme=dark, data-palette=dracula, color-scheme=dark.\nPASS injected lightTheme=not-a-theme reloads codex light, the default.\nPASS Dracula, Nord and Vesper do not pre-fill a sibling.\n");
        console.log("PASS dark-only themes on either side, distinct borders, no siblings, and unknown-id reload");
        // the reload was made with Settings open: its step out of Settings' entry lands before Settings opens again
        await historyHolds(page, "the reload with Settings open", () => (history.state as Record<string, unknown> | null)?.["ovis:settings"] === undefined);
        await openSettings(page);
        // beside the list, turning pages is one step however many are turned
        for (const name of ["Chat", "Shortcuts", "About"]) await openSettingsPage(page, name);
        await page.waitForFunction(() => (history.state as Record<string, { page: string; depth: number }> | null)?.["ovis:settings"]?.page === "about");
        assert.equal((await entryOf(page))?.depth, 1);
        await page.goBack();
        await page.locator(".settings-dialog").waitFor({ state: "detached" });
        // Forward opens it where it was
        await page.goForward();
        await dialogOf(page).getByRole("tabpanel", { name: "About", exact: true }).waitFor();
        await page.keyboard.press("Escape");
        await page.locator(".settings-dialog").waitFor({ state: "detached" });
        await page.waitForFunction(() => (history.state as Record<string, unknown> | null)?.["ovis:settings"] === undefined);
        assert.deepEqual(errors, []);
        console.log("PASS on a desktop Back closes Settings in one step, Forward reopens its page, Escape takes the entry off");

        // the window changes width with Settings open: the steps Back takes are the ones now shown
        await openSettings(page);
        await openSettingsPage(page, "Terminal");
        await page.setViewportSize({ width: 390, height: 844 });
        await page.waitForFunction(() => (history.state as Record<string, { depth: number }> | null)?.["ovis:settings"]?.depth === 2);
        await page.goBack();
        await dialogOf(page).getByRole("tablist").waitFor();
        assert.equal(await dialogOf(page).getByRole("tabpanel").count(), 0, "narrowed, Back from the page shows the list");
        await page.goBack();
        await page.locator(".settings-dialog").waitFor({ state: "detached" });
        await openSettings(page);
        await openSettingsPage(page, "Terminal");
        await dialogOf(page).getByRole("button", { name: "Edit key bar", exact: true }).click();
        await page.getByRole("dialog", { name: "Key bar", exact: true }).waitFor();
        await page.setViewportSize({ width: 1280, height: 800 });
        // the rebuilt stack, not the step the widening passes through
        await page.waitForFunction(() => { const entry = (history.state as Record<string, { page: string; keyBar: boolean; depth: number }> | null)?.["ovis:settings"]; return entry?.depth === 2 && entry.page === "terminal" && entry.keyBar === true; });
        await page.goBack();
        await dialogOf(page).getByRole("tabpanel", { name: "Terminal", exact: true }).waitFor();
        assert.equal(await page.locator(".key-bar-settings").count(), 0, "widened, Back from the editor shows the Terminal page");
        await page.goBack();
        await page.locator(".settings-dialog").waitFor({ state: "detached" });
        await page.waitForFunction(() => (history.state as Record<string, unknown> | null)?.["ovis:settings"] === undefined);
        assert.deepEqual(errors, []);
        console.log("PASS a window that changes width with Settings open keeps Back to the steps it shows");

        // a link to a file and Settings opens the preview (a panel beside the pane at this width) under
        // Settings; a reload there closes Settings and keeps the file, and Back then steps out of both
        const infra = panes.omp;
        await page.goto(`${url}?ws=${infra.split(":")[0]}&pane=${encodeURIComponent(infra)}&file=README.md&settings=about`);
        await dialogOf(page).getByRole("tabpanel", { name: "About", exact: true }).waitFor();
        await page.locator("aside.file-panel .file-viewer").waitFor();
        await historyHolds(page, "a link to a file and Settings", () => (history.state as Record<string, unknown> | null)?.["ovis:file-preview"] !== undefined);
        await page.reload();
        await page.locator(".conn-live").waitFor({ state: "attached" });
        await page.locator("aside.file-panel .file-viewer").waitFor();
        await historyHolds(page, "the reload on a preview over Settings", () => {
          const address = new URLSearchParams(window.location.search);
          return address.get("file") === "README.md" && !address.has("settings") && (history.state as Record<string, unknown> | null)?.["ovis:settings"] === undefined;
        });
        assert.equal(await page.locator(".settings-dialog").count(), 0, "a reload on a preview over Settings closes Settings");
        assert.equal(await page.locator("aside.file-panel .file-viewer").count(), 1, "a reload on a preview over Settings keeps the file open");
        await page.goBack();
        await page.locator("aside.file-panel .file-viewer").waitFor({ state: "detached" });
        await historyHolds(page, "Back from the reloaded preview", () => (history.state as Record<string, unknown> | null)?.["ovis:settings"] === undefined);
        assert.equal(await page.locator(".settings-dialog").count(), 0, "Back from the reloaded preview does not reopen Settings");
        assert.deepEqual(errors, []);
        console.log("PASS a reload on a preview opened over Settings closes Settings and keeps the file");
      } finally {
        await desktop.close();
      }

      await lateCloseStep(browser, url);
      await settingsSearch(browser, url);
      await heldGroupLanding(browser, devUrl);
    } finally {
      await browser.close();
      console.log("CLEANUP browser closed");
    }
  } finally {
    server.stop(true);
    console.log("CLEANUP loopback demo server stopped");
  }
} finally {
  rmSync(app, { recursive: true, force: true });
  rmSync(devApp, { recursive: true, force: true });
  console.log("CLEANUP disposable demo apps removed");
}
