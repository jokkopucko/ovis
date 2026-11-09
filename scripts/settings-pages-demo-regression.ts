import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Page } from "playwright-core";
import panes from "../site/demo/fixtures/panes.json";
import { buildDemoApp, buildDevelopmentDemoApp } from "./demo-build.ts";
import { DEMO_FILE_PREVIEW_SCRIPT } from "./demo-file-preview.ts";
import { openSettingsFolds, openSettingsPage, sheetRisen, themeSide } from "./settings-page.ts";
import { KO } from "../src/lib/i18n.ko.ts";
import { JA } from "../src/lib/i18n.ja.ts";
import { ZH } from "../src/lib/i18n.zh.ts";
import { DEFAULT_SETTINGS, terminalTheme } from "../src/lib/settings.ts";
import { rowFor, THEME_IDS, type ThemeId } from "../src/lib/themes.ts";
import baseline from "../src/lib/themes.legacy-baseline.json";
import { comboKey, LEGACY_COMBOS } from "./theme-baseline.ts";

// Settings on the unmodified app over the demo's fixture transport: every page fits a phone, and
// the browser's Back button steps out of the dialog instead of out of the app. All files and
// HTTP traffic stay in this disposable, loopback-only app; no herdr session is opened.
const app = mkdtempSync(join(tmpdir(), "herdr-settings-demo-"));
const devApp = mkdtempSync(join(tmpdir(), "herdr-settings-dev-"));
const PAGES = ["Appearance", "Chat", "Terminal", "Alerts", "Agents", "Shortcuts", "Devices and PCs", "Experimental", "About"];
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
  const out = [...body.querySelectorAll<HTMLElement>("button, input, select, a, .settings-card, .settings-row, .theme-cards")]
    .filter((node) => {
      const box = node.getBoundingClientRect();
      // a control is held by its card, where it has one; a card by the page
      const card = node.classList.contains("settings-card") ? null : node.closest<HTMLElement>(".settings-card");
      // a theme card is held by the row of cards that scrolls sideways on purpose; the row itself is checked against its card
      if (!node.classList.contains("theme-cards") && node.closest(".theme-cards")) return false;
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
  ["en", "chat font size", "appearance", "typography"],
  ["en", "chat width", "chat", "-"],
  ["en", "Enter sends", "chat", "composer"],
  ["en", "quick replies", "chat", "quick-replies"],
  ["en", "terminal font", "appearance", "typography"],
  ["en", "notifications", "alerts", "-"],
  ["en", "shortcuts", "shortcuts", "-"],
  ["en", "phone", "devices", "-"],
  ["en", "OpenAI API key", "chat", "openai-key"],
  ["en", "Return inserts a new line", "chat", "composer"],
  ["en", "Send queued messages automatically", "chat", "composer-more"],
  ["en", "Suggestion chip", "chat", "composer"],
  ["en", "Show above the message box", "chat", "quick-replies"],
  ["ko", "인터페이스 글자 크기", "appearance", "typography"],
  ["ko", "채팅 글자 크기", "appearance", "typography"],
  ["ko", "Enter로 보내기", "chat", "composer"],
  ["ko", "빠른 답장", "chat", "quick-replies"],
  ["ko", "터미널 글자 크기", "appearance", "typography"],
  ["ko", "OpenAI API 키", "chat", "openai-key"],
  ["ko", "단축키", "shortcuts", "-"],
  ["ko", "알림", "alerts", "-"],
  ["ko", "대기 메시지 자동 전송", "chat", "composer-more"],
  ["ko", "입력창 위에 표시", "chat", "quick-replies"],
  ["ja", "インターフェースの文字サイズ", "appearance", "typography"],
  ["ja", "チャットのフォントサイズ", "appearance", "typography"],
  ["ja", "Enter で送信", "chat", "composer"],
  ["ja", "クイック返信", "chat", "quick-replies"],
  ["ja", "ターミナルのフォントサイズ", "appearance", "typography"],
  ["ja", "OpenAI API キー", "chat", "openai-key"],
  ["ja", "ショートカット", "shortcuts", "-"],
  ["ja", "通知", "alerts", "-"],
  ["ja", "送信待ちメッセージを自動で送信", "chat", "composer-more"],
  ["ja", "入力欄の上に表示", "chat", "quick-replies"],
  ["zh", "界面字号", "appearance", "typography"],
  ["zh", "聊天字号", "appearance", "typography"],
  ["zh", "按 Enter 发送", "chat", "composer"],
  ["zh", "快捷回复", "chat", "quick-replies"],
  ["zh", "终端字号", "appearance", "typography"],
  ["zh", "OpenAI API 密钥", "chat", "openai-key"],
  ["zh", "快捷键", "shortcuts", "-"],
  ["zh", "提醒", "alerts", "-"],
  ["zh", "自动发送排队消息", "chat", "composer-more"],
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
  const ids = ["appearance", "chat", "terminal", "alerts", "agents", "shortcuts", "devices", "about"];
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
  // short enough that the OpenAI key's group starts below the fold, so a landing has to scroll to it
  const context = await browser.newContext({ viewport: { width: 390, height: 480 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true, locale: "en" });
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

/**
 * At 1440: a press on the page already open leaves nothing that takes Back from the key bar editor
 * away from Edit key bar; a search result whose group the server fills in (Also send to) is landed on
 * once the group comes; the OpenAI key's field drawn again empty by a search keeps Save waiting for a
 * key; and Check again keeps the focus its press gave it while it reads and after.
 */
async function focusAndLandings(browser: import("playwright-core").Browser, url: string): Promise<void> {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "en" });
  try {
    await context.addInitScript((settings) => localStorage.setItem("ovis:settings", settings), JSON.stringify(SETTINGS));
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(url);
    await page.locator(".conn-live").waitFor({ state: "attached" });
    await openSettings(page);
    const dialog = dialogOf(page);
    const focusedOn = (selector: string) => page.evaluate((selector) => document.activeElement?.matches(selector) ?? false, selector);

    await openSettingsPage(page, "Terminal");
    await dialog.getByRole("tab", { name: "Terminal", exact: true }).click();
    await dialog.getByRole("button", { name: "Edit key bar", exact: true }).click();
    await page.getByRole("dialog", { name: "Key bar", exact: true }).waitFor();
    await page.locator(".settings-dialog").getByRole("button", { name: "Back to settings", exact: true }).click();
    await dialog.getByRole("tabpanel", { name: "Terminal", exact: true }).waitFor();
    assert.equal(await page.evaluate(() => document.activeElement?.textContent), "Edit key bar", "after a press on the open page's tab, Back from the key bar editor returns to Edit key bar");

    const search = dialog.getByRole("searchbox", { name: "Search settings", exact: true });
    const results = dialog.getByRole("region", { name: "Search results", exact: true });
    await search.fill("webhook");
    await results.locator("[data-section='alert-webhook']").waitFor();
    await results.getByRole("button", { name: "Open Alerts", exact: true }).click();
    await dialog.getByRole("tabpanel", { name: "Alerts", exact: true }).waitFor();
    await page.waitForFunction(() => (document.activeElement as HTMLElement | null)?.dataset.section === "alert-webhook", undefined, { timeout: 10_000 });

    await search.fill("openai api key");
    const key = results.locator('input[aria-label="OpenAI API key"]');
    const save = results.getByRole("button", { name: "Save key", exact: true });
    await key.fill("sk-fixture");
    assert.equal(await save.isEnabled(), true, "a typed key can be saved");
    await search.fill("zzqxv nothing");
    await dialog.getByRole("status").filter({ hasText: "No settings match." }).waitFor();
    await search.fill("openai api key");
    await key.waitFor();
    assert.equal(await key.inputValue(), "", "the key's field comes back empty");
    assert.equal(await save.isDisabled(), true, "Save waits for a key typed again");

    await search.fill("");
    await openSettingsPage(page, "Agents");
    await page.evaluate(() => {
      const passing = window.fetch, held: (() => void)[] = [];
      (window as unknown as { releaseCatalog: () => void }).releaseCatalog = () => { window.fetch = passing; for (const go of held.splice(0)) go(); };
      window.fetch = (input, init) => new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, location.href).pathname === "/api/agent-catalog"
        ? new Promise<Response>((resolve) => held.push(() => resolve(passing(input, init))))
        : passing(input, init);
    });
    await dialog.getByRole("button", { name: "Check again", exact: true }).focus();
    await page.keyboard.press("Enter");
    await dialog.getByRole("button", { name: "Checking…", exact: true }).waitFor();
    assert.equal(await focusedOn(".agents-check-again"), true, "a pressed Check again keeps the focus while it reads");
    await page.evaluate(() => (window as unknown as { releaseCatalog: () => void }).releaseCatalog());
    await dialog.getByRole("button", { name: "Check again", exact: true }).waitFor();
    assert.equal(await focusedOn(".agents-check-again"), true, "and once the read lands");
    assert.deepEqual(errors, []);
    console.log("PASS at 1440 a no-op tab press, a group the server fills in, a key field drawn again and Check again keep the focus and Save where they belong");
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

/**
 * Settings' own search, at 1440 and 390: the settings of every page that hold all the words typed,
 * each under its page's name and changed right there; a group named by the words shows its settings;
 * a page's name opens it; no match says so; and Escape empties the search before it closes Settings.
 */
async function dialogSearch(browser: import("playwright-core").Browser, url: string): Promise<void> {
  for (const width of [1440, 390] as const) {
    const context = await browser.newContext(width === 390 ? { viewport: { width, height: 844 }, isMobile: true, hasTouch: true, locale: "en" } : { viewport: { width, height: 900 }, locale: "en" });
    try {
      await context.addInitScript((settings) => localStorage.setItem("ovis:settings", settings), JSON.stringify(SETTINGS));
      const page = await context.newPage();
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(url);
      await page.locator(".conn-live").waitFor({ state: "attached" });
      await openSettings(page);
      const dialog = dialogOf(page);
      const search = dialog.getByRole("searchbox", { name: "Search settings", exact: true });
      const results = dialog.getByRole("region", { name: "Search results", exact: true });
      // the pages drawn with what each shows: its name and the labels of the settings in sight
      const shown = () => results.evaluate((region) => [...region.querySelectorAll<HTMLElement>(".settings-search-page")].filter((section) => section.checkVisibility())
        .map((section) => [section.getAttribute("aria-label"), [...section.querySelectorAll<HTMLElement>("[data-setting]")].filter((row) => row.checkVisibility()).map((row) => row.querySelector(".settings-label")?.textContent ?? "")] as const));

      await search.fill("Font SIZE");
      const found = await shown();
      // every font row is on Appearance: the terminal's and the chat's are found by their sizes' words
      assert.deepEqual(found.map(([name]) => name), ["Appearance"], `${width}px: "font size" finds settings on Appearance only`);
      for (const [name, label] of [["Appearance", "Interface font size"], ["Appearance", "Chat font"], ["Appearance", "Terminal font"]] as const) {
        assert.ok(found.find(([page]) => page === name)?.[1].includes(label), `${width}px: ${label} is found under ${name}`);
      }
      assert.equal(await dialog.getByRole("tablist").isVisible(), width !== 390, `${width}px: a phone's results take the list's place`);

      // a setting found is changed where it is shown
      await results.getByRole("button", { name: "Increase terminal font size", exact: true }).click();
      await page.waitForFunction(() => JSON.parse(localStorage.getItem("ovis:settings") ?? "{}").terminalFontSize === 14);
      const typedSize = results.getByRole("group", { name: "Terminal font size", exact: true }).getByRole("textbox", { name: "Terminal font size", exact: true });
      assert.equal(await typedSize.inputValue(), "14");
      // the -/+ buttons still have the new size read out
      assert.equal(await results.getByRole("group", { name: "Terminal font size", exact: true }).locator('[aria-live="polite"]').textContent(), "14px", `${width}px: a stepped size is announced`);
      // a finger's field is read at --fs-input or larger, so iOS does not zoom into it
      if (width === 390) assert.ok(await typedSize.evaluate((input) => {
        const probe = document.createElement("span");
        probe.style.fontSize = "var(--fs-input)";
        document.body.append(probe);
        const least = Number.parseFloat(getComputedStyle(probe).fontSize);
        probe.remove();
        return Number.parseFloat(getComputedStyle(input).fontSize) >= least;
      }), `${width}px: the typed size is read at --fs-input or larger`);
      // the number is typed in its place too: one out of range is refused and the field goes back (G-179)
      await typedSize.fill("30");
      await typedSize.press("Enter");
      assert.equal(await typedSize.inputValue(), "14", `${width}px: a size out of range is refused`);
      // the refusal names the range under the field until the next edit, and the field is described by it all along
      const rangeLine = results.locator(`[id="${await typedSize.getAttribute("aria-describedby")}"]`);
      assert.equal(await rangeLine.textContent(), "Enter 10–22px", `${width}px: the field is described by its range`);
      assert.equal(await rangeLine.isVisible(), true, `${width}px: a refused size shows the range`);
      // a pasted number is read whole: 200 is refused, never cut to 20
      await typedSize.focus();
      await typedSize.selectText();
      await page.keyboard.insertText("200");
      assert.equal(await typedSize.inputValue(), "200", `${width}px: a pasted number is kept whole`);
      assert.equal(await rangeLine.evaluate((node) => node.classList.contains("visually-hidden")), true, `${width}px: the next edit hides the range line`);
      await typedSize.press("Enter");
      assert.equal(await typedSize.inputValue(), "14", `${width}px: a pasted size out of range is refused`);
      assert.equal(await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => done(JSON.parse(localStorage.getItem("ovis:settings") ?? "{}").terminalFontSize)))), 14, `${width}px: a refused paste saves nothing`);
      await typedSize.fill("16");
      await typedSize.press("Enter");
      await page.waitForFunction(() => JSON.parse(localStorage.getItem("ovis:settings") ?? "{}").terminalFontSize === 16);
      await typedSize.fill("14");
      await typedSize.press("Enter");
      await page.waitForFunction(() => JSON.parse(localStorage.getItem("ovis:settings") ?? "{}").terminalFontSize === 14);

      // a group named by the words shows each of its settings, and one with a form but no setting row shows the form
      await search.fill("quick replies");
      assert.deepEqual(await shown(), [["Chat", ["Show above the message box"]]], `${width}px: the Quick replies group's setting is found by the group's name`);
      await search.fill("openai api key");
      await results.locator('input[aria-label="OpenAI API key"]').waitFor();

      // Escape empties a search from a result too, not only from the field
      await search.fill("sound");
      await results.getByRole("switch", { name: "Play sounds", exact: true }).focus();
      await page.keyboard.press("Escape");
      assert.equal(await search.inputValue(), "", `${width}px: Escape on a result empties the search`);
      assert.equal(await search.evaluate((field) => field === document.activeElement), true, `${width}px: the field takes the focus back`);

      // a row a found row opens is found with it: Custom from a description match shows its field
      await search.fill("menus dialogs");
      await results.getByRole("combobox", { name: "Interface font", exact: true }).selectOption("custom");
      await results.getByRole("textbox", { name: "Custom interface font", exact: true }).waitFor();
      await results.getByRole("combobox", { name: "Interface font", exact: true }).selectOption("default");
      assert.equal(await page.locator(".settings-dialog").count(), 1, `${width}px: and keeps Settings open`);

      // the key bar editor opened from a search sits over the Terminal page: Back steps out to it, not out of Settings
      if (width === 390) {
        await search.fill("key bar");
        await results.getByRole("button", { name: "Edit key bar", exact: true }).click();
        await page.getByRole("dialog", { name: "Key bar", exact: true }).waitFor();
        await historyHolds(page, "the key bar opened from a search", () => (history.state as { "ovis:settings"?: { page: string | null; keyBar: boolean } } | null)?.["ovis:settings"]?.keyBar === true);
        await page.goBack();
        await dialog.getByRole("tabpanel", { name: "Terminal", exact: true }).waitFor();
        await page.goBack();
        await dialog.getByRole("tablist").waitFor();
        assert.equal(await page.locator(".settings-dialog").count(), 1, "390px: Back from the key bar opened by a search leaves Settings open");
      }

      await search.fill("zzqxv nothing");
      await dialog.getByRole("status").filter({ hasText: "No settings match." }).waitFor();
      assert.deepEqual(await shown(), [], `${width}px: no page is drawn when nothing matches`);

      // the first Escape empties the search and keeps Settings; the next one closes it
      await search.press("Escape");
      assert.equal(await search.inputValue(), "");
      assert.equal(await results.count(), 0);
      assert.equal(await dialog.getByRole("tablist").isVisible(), true, `${width}px: the list of pages is back`);
      assert.equal(await page.locator(".settings-dialog").count(), 1, `${width}px: Escape on a search does not close Settings`);

      // a page's name opens the page and ends the search
      await search.fill("sound");
      await results.getByRole("button", { name: "Open Alerts", exact: true }).click();
      await dialog.getByRole("tabpanel", { name: "Alerts", exact: true }).waitFor();
      assert.equal(await search.count() === 0 || await search.inputValue() === "", true, `${width}px: opening a page ends the search`);
      if (width === 1440) {
        await search.press("Escape");
        await page.locator(".settings-dialog").waitFor({ state: "detached" });
      }
      assert.deepEqual(errors, []);
    } finally {
      await context.close();
    }
  }
  console.log("PASS Settings' search at 1440 and 390px: settings of every page found and changed in place, groups by name, pages opened, nothing matching said, Escape empties first");
}

/**
 * The folded part of a page (SettingsFold), at 1440 and 390: closed on opening, with the count of what this
 * device changed in it on its line; a link to a group inside opens it on that group; a search finds its rows.
 */
async function foldedGroups(browser: import("playwright-core").Browser, url: string): Promise<void> {
  for (const width of [1440, 390] as const) {
    const context = await browser.newContext(width === 390 ? { viewport: { width, height: 844 }, isMobile: true, hasTouch: true, locale: "en" } : { viewport: { width, height: 900 }, locale: "en" });
    try {
      await context.addInitScript((settings) => localStorage.setItem("ovis:settings", settings), JSON.stringify({ ...SETTINGS, sidebarPeek: true }));
      const page = await context.newPage();
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(url);
      await page.locator(".conn-live").waitFor({ state: "attached" });
      await openSettings(page);
      const dialog = dialogOf(page);
      await dialog.getByRole("tab", { name: "Appearance", exact: true }).click();
      const panel = dialog.getByRole("tabpanel", { name: "Appearance", exact: true });
      const more = panel.locator("details.settings-fold[data-fold='more']");
      assert.equal(await more.evaluate((fold) => (fold as HTMLDetailsElement).open), false, `${width}px: More settings starts folded`);
      assert.equal(await panel.getByRole("switch", { name: "Show the sidebar on hover", exact: true }).isVisible(), false, `${width}px: its rows are out of the first view`);
      assert.equal(await more.locator(".settings-fold-changed").textContent(), "1 changed", `${width}px: the line counts what this device changed inside`);
      await more.locator("> summary").click();
      await panel.getByRole("switch", { name: "Show the sidebar on hover", exact: true }).waitFor();

      // a search finds a folded row with the rest
      await closeSettings(page);
      await openSettings(page);
      await dialog.getByRole("searchbox", { name: "Search settings", exact: true }).fill("sidebar on hover");
      await dialog.getByRole("region", { name: "Search results", exact: true }).getByRole("switch", { name: "Show the sidebar on hover", exact: true }).waitFor();
      // an agent's own setting is found with its agent's row shut, in a group named after it
      await dialog.getByRole("searchbox", { name: "Search settings", exact: true }).fill("sandbox");
      await dialog.getByRole("region", { name: "Search results", exact: true }).getByLabel("Sandbox and approvals", { exact: true }).waitFor();
      // Model and Effort are alike for every agent: each found group says whose it is
      await dialog.getByRole("searchbox", { name: "Search settings", exact: true }).fill("effort");
      const found = dialog.getByRole("region", { name: "Search results", exact: true });
      await found.locator("[data-section='agent-codex']").waitFor();
      assert.deepEqual(await found.locator("[data-section='agent-claude'] > h3, [data-section='agent-codex'] > h3").allTextContents(), ["Claude Code", "Codex"], `${width}px: a found agent's rows sit under its name`);
      await closeSettings(page);

      // an old link to the Chat page's folded Chat group lands on Conversation, where its row went
      await page.goto(`${url}?settings=chat&section=chat-more`);
      await page.getByRole("switch", { name: "Collapse work", exact: true }).waitFor();
      assert.equal(await page.locator(".settings-body:not([hidden]) [data-section='conversation']").evaluate((group) => document.activeElement === group), true, `${width}px: chat-more lands on Conversation`);
      await closeSettings(page);

      // a link to a group inside a fold opens it on that group
      await page.goto(`${url}?settings=chat&section=composer-more`);
      const queued = page.getByRole("switch", { name: "Send queued messages automatically", exact: true });
      await queued.waitFor();
      assert.equal(await page.locator(".settings-body:not([hidden]) [data-section='composer-more']").evaluate((group) => group.closest("details")?.open === true && document.activeElement === group), true, `${width}px: the link opened the fold and focused its group`);
      assert.deepEqual(errors, []);
    } finally {
      await context.close();
    }
  }
  console.log("PASS folded groups at 1440 and 390px: closed on opening with a count of what changed, opened by a click, a link to a group inside and a search");
}

/**
 * The three merged rows keep both settings each stands for: Agents order's By state groups this device's list
 * (and shows Within a state), Show thinking's Expanded opens reasoning, and Tidy dictated text's Terminal tidies
 * the terminal alone; each choice is kept through a reload.
 */
/**
 * Signed in on a PC's own page, Settings > Devices and PCs lists the account's PCs in My devices, one
 * row each with a hairline under it and a PC pill, after this PC; the Account group lists none of its own. The sign-in is a fixture in this page's IndexedDB and the account service a route
 * of this context: nothing reaches GitHub or account.ovis.sh.
 */
/**
 * About's first line names the runtime this PC serves with its version. With herdr's TUI and the
 * Herdr app's core both installed (`?demo_runtime=both`) it is a choice between them, and picking
 * the other asks before switching; with one installed it is a plain fact.
 */
async function runtimeInUse(browser: import("playwright-core").Browser, url: string): Promise<void> {
  for (const width of [390, 1280]) {
    const context = await browser.newContext({ viewport: { width, height: width === 390 ? 844 : 800 }, isMobile: width === 390, hasTouch: width === 390, locale: "en" });
    try {
      await context.addInitScript((settings) => localStorage.setItem("ovis:settings", settings), JSON.stringify(SETTINGS));
      const page = await context.newPage();
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(`${url}?settings=about`);
      const panel = dialogOf(page).getByRole("tabpanel", { name: "About", exact: true });
      const row = panel.locator(".settings-row").filter({ hasText: "In use" });
      await row.getByText("herdr 0.9.0", { exact: true }).waitFor();
      assert.equal(await row.getByRole("group", { name: "In use" }).count(), 0, `${width}px: one runtime installed, no switch`);
      await page.goto(`${url}?demo_runtime=both&settings=about`);
      const choice = row.getByRole("group", { name: "In use" });
      await choice.getByRole("button", { name: "herdr-core 0.1.17", exact: true }).waitFor();
      assert.equal(await choice.getByRole("button", { name: "herdr 0.9.0", exact: true }).getAttribute("aria-pressed"), "true", `${width}px: the runtime served is the one pressed`);
      await choice.getByRole("button", { name: "herdr-core 0.1.17", exact: true }).click();
      const confirm = page.getByRole("alertdialog", { name: "Show the Herdr app's terminals?" });
      await confirm.waitFor();
      await confirm.getByRole("button", { name: "Cancel", exact: true }).click();
      await confirm.waitFor({ state: "detached" });
      assert.equal(await choice.getByRole("button", { name: "herdr 0.9.0", exact: true }).getAttribute("aria-pressed"), "true", `${width}px: cancelled, nothing switched`);
      assert.deepEqual(errors, []);
    } finally {
      await context.close();
    }
  }
  console.log("PASS About names the runtime in use, and offers the switch only with two installed, asking first");
}

/**
 * About after an update: its compact Updates line keeps the notes of what the update brought (the
 * header's "What's new" opens them), the section's name and the running version.
 */
async function installedNotes(browser: import("playwright-core").Browser, url: string): Promise<void> {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: "en" });
  try {
    await context.addInitScript((settings) => localStorage.setItem("ovis:settings", settings), JSON.stringify(SETTINGS));
    // the demo's transport answers /api in the page: these two answers go in over it. The running
    // revision is the build's own, so the app reads no reload and the notes are this release's.
    await context.addInitScript((revision) => {
      const answers: Record<string, unknown> = {
        "/api/updates": { managed: true, auto_update: false, phase: "idle", current_revision: revision, latest_revision: null, current_version: null, latest_version: null, available: false, checked_at: "2099-01-01T00:00:00Z", blocked_reason: null, error: null },
        "/api/updates/installed": { revision, version: "99.0.0", previous_version: "98.0.0", installed_at: "2099-01-01T00:00:00Z", omitted: 0, releases: [{ version: "99.0.0", date: "2099-01-01", notes: "- A fixture release note." }] },
      };
      let inner = window.fetch;
      const outer: typeof window.fetch = (input, init) => {
        // the demo app is served under a path of its own: its requests end in the API's path
        const path = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, location.href).pathname;
        const answer = Object.keys(answers).find((key) => path.endsWith(key));
        return answer !== undefined ? Promise.resolve(new Response(JSON.stringify(answers[answer]), { headers: { "content-type": "application/json" } })) : inner(input, init);
      };
      // the transport's own assignment goes under these answers; a later wrapper (the file preview's)
      // reads them as its fetch and replaces the property as a plain value
      Object.defineProperty(window, "fetch", { configurable: true, get: () => outer, set: (next: typeof window.fetch) => {
        inner = next;
        Object.defineProperty(window, "fetch", { configurable: true, writable: true, value: outer });
      } });
    }, execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim());
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`${url}?settings=about`);
    const panel = dialogOf(page).getByRole("tabpanel", { name: "About", exact: true });
    await panel.getByRole("region", { name: "What the last update brought", exact: true }).getByText("A fixture release note.").waitFor();
    assert.equal(await panel.getByRole("heading", { name: "Updates", exact: true }).count(), 1, "the Updates section keeps its name");
    await panel.getByText(/^Running v/).waitFor();
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
  console.log("PASS About's compact Updates line keeps what the last update brought, its name and the running version");
}

/**
 * Alerts' one line of chips: Any turn finished lights Long turn finished too, and the row's ↺ puts
 * back all five, the two kept in the alert filters' own store included.
 */
async function alertChipsReset(browser: import("playwright-core").Browser, url: string): Promise<void> {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: "en" });
  try {
    await context.addInitScript((settings) => {
      localStorage.setItem("ovis:settings", settings);
      localStorage.setItem("ovis:alert-filters", JSON.stringify({ permission: false, error: true, pcsOff: [] }));
    }, JSON.stringify({ ...SETTINGS, alertDone: "always" }));
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`${url}?settings=alerts`);
    const chips = dialogOf(page).getByRole("group", { name: "Alert me when", exact: true });
    const pressed = async () => Object.fromEntries(await Promise.all(["Needs input", "Needs permission", "Long turn finished", "Any turn finished", "Stopped on an error"]
      .map(async (name) => [name, await chips.getByRole("button", { name, exact: true }).getAttribute("aria-pressed")])));
    await chips.waitFor();
    assert.deepEqual(await pressed(), { "Needs input": "true", "Needs permission": "false", "Long turn finished": "true", "Any turn finished": "true", "Stopped on an error": "true" }, "every turn lights the long turns too");
    await dialogOf(page).getByRole("button", { name: "Restore defaults: Alert me when", exact: true }).click();
    await dialogOf(page).getByRole("button", { name: "Restore defaults: Alert me when", exact: true }).waitFor({ state: "detached" });
    assert.deepEqual(await pressed(), { "Needs input": "true", "Needs permission": "true", "Long turn finished": "true", "Any turn finished": "false", "Stopped on an error": "false" }, "↺ puts back all five");
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
  console.log("PASS Alerts' chips: every turn lights the long turns, and ↺ restores all five");
}

async function accountPcList(browser: import("playwright-core").Browser, url: string): Promise<void> {
  const service = "https://account.ovis.sh";
  for (const [width, theme] of [[390, "light"], [390, "dark"], [1280, "light"], [1280, "dark"]] as const) {
    const context = await browser.newContext({ viewport: { width, height: width === 390 ? 844 : 800 }, isMobile: width === 390, hasTouch: width === 390, locale: "en" });
    try {
      await context.addInitScript((settings) => localStorage.setItem("ovis:settings", settings), JSON.stringify({ ...SETTINGS, theme }));
      // the PC's server names the account service its page signs in with (server/static.ts)
      await context.route((address) => address.href.startsWith(url) && (address.pathname.endsWith("/") || address.pathname.endsWith("/index.html")), async (route) => {
        const response = await route.fetch();
        await route.fulfill({ response, body: (await response.text()).replace("</head>", `<meta name="ovis-pc-account-service" content="${service}" />\n</head>`) });
      });
      await context.route(`${service}/**`, (route) => {
        const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "authorization, content-type", "access-control-allow-methods": "GET, POST, PUT, DELETE" };
        if (route.request().method() === "OPTIONS") return route.fulfill({ status: 204, headers: cors });
        if (new URL(route.request().url()).pathname !== "/v1/pcs") return route.fulfill({ status: 404, headers: cors, json: { error: { code: "not_found" } } });
        return route.fulfill({ headers: cors, json: { pcs: [
          { server_id: "a".repeat(32), label: "home-server", added_at: "2026-11-01T00:00:00Z", last_seen_at: new Date().toISOString() },
          { server_id: "b".repeat(32), label: "office-mac", added_at: "2026-11-01T00:00:00Z", last_seen_at: "2026-11-01T00:00:00Z" },
        ] } });
      });
      const page = await context.newPage();
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(url);
      await page.locator(".conn-live").waitFor({ state: "attached" });
      await page.evaluate((service) => new Promise<void>((resolve, reject) => {
        const request = indexedDB.open("ovis-account", 1);
        request.onupgradeneeded = () => { request.result.createObjectStore("account"); };
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const tx = request.result.transaction("account", "readwrite");
          tx.objectStore("account").put({ service, account: "fixture", provider: "github", access_token: "fixture-access", refresh_token: "fixture-refresh", expires_at: Date.now() + 3_600_000 }, "session");
          tx.oncomplete = () => { request.result.close(); resolve(); };
          tx.onabort = () => reject(tx.error);
        };
      }), service);
      await openSettings(page);
      await openSettingsPage(page, "Devices and PCs");
      const list = page.locator("[data-section='devices'] .my-pcs");
      const accountRows = list.locator(".devices-row").filter({ hasText: /home-server|office-mac/ });
      await accountRows.nth(1).waitFor();
      assert.deepEqual(await accountRows.locator(".devices-kind").allTextContents(), ["PC", "PC"], `each account PC is marked PC (${width}px, ${theme})`);
      const style = await list.evaluate((node) => {
        const row = node.querySelector(".devices-row:not([data-testid='this-pc'])")!;
        return { listStyle: getComputedStyle(node).listStyleType, display: getComputedStyle(row).display, border: getComputedStyle(row).borderBottomStyle };
      });
      assert.deepEqual(style, { listStyle: "none", display: "flex", border: "solid" }, `the account's PCs are styled rows in My devices (${width}px, ${theme})`);
      assert.equal(await page.locator("[data-section='account'] .relay-shell-pcs").count(), 0, "the Account group does not list the PCs a second time");
      if (process.env.UI_EVIDENCE_DIR) {
        await list.scrollIntoViewIfNeeded();
        await page.screenshot({ path: join(process.env.UI_EVIDENCE_DIR, `account-pcs-${width}-${theme}.png`), animations: "disabled" });
      }
      assert.deepEqual(errors, []);
    } finally {
      await context.close();
    }
  }
  console.log("PASS the account's PCs are styled rows of My devices at 390 and 1280px, light and dark");
}

/**
 * Continue with Google on a PC's own page: the button shows under GitHub's only while the account
 * service lists Google for a PC's page (`GET /v1/providers`), and once signed in the Account group
 * lists the account's ways to sign in, with Remove on every one but the one this page signed in
 * with. The account service is a route of this context: nothing reaches Google, GitHub or account.ovis.sh.
 */
async function accountGoogle(browser: import("playwright-core").Browser, url: string): Promise<void> {
  const service = "https://account.ovis.sh";
  for (const width of [390, 1280] as const) {
    for (const offered of [["github", "google"], ["github"]] as const) {
      for (const signedIn of [false, true]) {
        if (signedIn && offered.length === 1) continue;
        const context = await browser.newContext({ viewport: { width, height: width === 390 ? 844 : 800 }, isMobile: width === 390, hasTouch: width === 390, locale: "en" });
        try {
          await context.addInitScript((settings) => localStorage.setItem("ovis:settings", settings), JSON.stringify({ ...SETTINGS, theme: "light" }));
          await context.route((address) => address.href.startsWith(url) && (address.pathname.endsWith("/") || address.pathname.endsWith("/index.html")), async (route) => {
            const response = await route.fetch();
            await route.fulfill({ response, body: (await response.text()).replace("</head>", `<meta name="ovis-pc-account-service" content="${service}" />\n</head>`) });
          });
          await context.route(`${service}/**`, (route) => {
            const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "authorization, content-type", "access-control-allow-methods": "GET, POST, PUT, DELETE" };
            if (route.request().method() === "OPTIONS") return route.fulfill({ status: 204, headers: cors });
            switch (new URL(route.request().url()).pathname) {
              case "/v1/providers": return route.fulfill({ headers: cors, json: { providers: offered, device: offered } });
              case "/v1/pcs": return route.fulfill({ headers: cors, json: { pcs: [] } });
              case "/v1/identities": return route.fulfill({ headers: cors, json: { identities: [
                { provider: "github", added_at: "2026-11-01T00:00:00Z" },
                { provider: "google", added_at: "2026-11-06T00:00:00Z" },
              ] } });
              default: return route.fulfill({ status: 404, headers: cors, json: { error: { code: "not_found" } } });
            }
          });
          const page = await context.newPage();
          const errors: string[] = [];
          page.on("pageerror", (error) => errors.push(error.message));
          await page.goto(url);
          await page.locator(".conn-live").waitFor({ state: "attached" });
          if (signedIn) {
            await page.evaluate((service) => new Promise<void>((resolve, reject) => {
              const request = indexedDB.open("ovis-account", 1);
              request.onupgradeneeded = () => { request.result.createObjectStore("account"); };
              request.onerror = () => reject(request.error);
              request.onsuccess = () => {
                const tx = request.result.transaction("account", "readwrite");
                tx.objectStore("account").put({ service, account: "fixture", provider: "google", access_token: "fixture-access", refresh_token: "fixture-refresh", expires_at: Date.now() + 3_600_000 }, "session");
                tx.oncomplete = () => { request.result.close(); resolve(); };
                tx.onabort = () => reject(tx.error);
              };
            }), service);
          }
          await openSettings(page);
          await openSettingsPage(page, "Devices and PCs");
          // the account waits in More settings
          await openSettingsFolds(page);
          const account = page.locator("[data-section='account']");
          const shot = async (name: string) => {
            if (!process.env.UI_EVIDENCE_DIR) return;
            await account.scrollIntoViewIfNeeded();
            await page.screenshot({ path: join(process.env.UI_EVIDENCE_DIR, `${name}-${width}.png`), animations: "disabled" });
          };
          if (!signedIn) {
            const buttons = account.locator(".account-provider");
            if (offered.length === 2) {
              await buttons.nth(1).waitFor();
              assert.deepEqual(await buttons.allTextContents(), ["Continue with GitHub", "Continue with Google"], `Google sits under GitHub (${width}px)`);
              assert.equal(await account.locator("[data-provider='google'] svg path").count(), 4, "Google's G keeps its four colours");
              await shot("account-google-signin");
            } else {
              // once the service's answer is on screen, GitHub stays alone
              await account.locator("[data-offer='service'] .account-provider").first().waitFor();
              assert.deepEqual(await buttons.allTextContents(), ["Continue with GitHub"], `no Google button while the service offers none (${width}px)`);
            }
          } else {
            const methods = account.locator(".account-method");
            await methods.nth(1).waitFor();
            assert.equal(await account.getByText("Signed in with Google").count(), 1, "the account row names Google");
            assert.deepEqual(await methods.evaluateAll((rows) => rows.map((row) => [row.getAttribute("data-provider"), row.querySelector("button") !== null])), [["github", true], ["google", false]],
              "every way to sign in can be removed but the one this page signed in with");
            await shot("account-google-methods");
          }
          assert.deepEqual(errors, []);
        } finally {
          await context.close();
        }
      }
    }
  }
  console.log("PASS Continue with Google shows under GitHub only while the service offers it, and the account lists its ways to sign in, at 390 and 1280px");
}

/**
 * Sign-in on the first-run welcome (components/SetupGuide.tsx): Continue with each provider the account
 * service lists for this page (`GET /v1/providers`), none without an account service, Not now folds it
 * away and leaves the two choices, and a sign-in this page already holds is the one Settings shows.
 * The account service is a route of this context: nothing reaches GitHub, Google or account.ovis.sh.
 */
async function welcomeSignIn(browser: import("playwright-core").Browser, url: string): Promise<void> {
  const service = "https://account.ovis.sh";
  const cases = [
    { offered: ["github", "google"], signedIn: false },
    { offered: ["github"], signedIn: false },
    { offered: ["google"], signedIn: false },
    { offered: null, signedIn: false },
    { offered: ["github", "google"], signedIn: true },
  ] as const;
  for (const width of [390, 1280] as const) {
    for (const { offered, signedIn } of cases) {
      const at = `(${width}px, ${offered === null ? "no account service" : offered.join("+")}${signedIn ? ", signed in" : ""})`;
      const context = await browser.newContext({ viewport: { width, height: width === 390 ? 844 : 800 }, isMobile: width === 390, hasTouch: width === 390, locale: "en" });
      try {
        await context.addInitScript((settings) => {
          localStorage.setItem("ovis:settings", settings);
          localStorage.setItem("ovis:setup-guide", JSON.stringify({ status: "open", state: { step: "welcome" } }));
        }, JSON.stringify({ ...SETTINGS, theme: "light" }));
        if (offered !== null) {
          await context.route((address) => address.href.startsWith(url) && (address.pathname.endsWith("/") || address.pathname.endsWith("/index.html")), async (route) => {
            const response = await route.fetch();
            await route.fulfill({ response, body: (await response.text()).replace("</head>", `<meta name="ovis-pc-account-service" content="${service}" />\n</head>`) });
          });
          await context.route(`${service}/**`, (route) => {
            const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "authorization, content-type", "access-control-allow-methods": "GET, POST, PUT, DELETE" };
            if (route.request().method() === "OPTIONS") return route.fulfill({ status: 204, headers: cors });
            switch (new URL(route.request().url()).pathname) {
              case "/v1/providers": return route.fulfill({ headers: cors, json: { providers: offered, device: offered } });
              case "/v1/pcs": return route.fulfill({ headers: cors, json: { pcs: [] } });
              case "/v1/identities": return route.fulfill({ headers: cors, json: { identities: [{ provider: "google", added_at: "2026-11-06T00:00:00Z" }] } });
              // a device sign-in that stays pending: the code shows until someone approves it elsewhere
              case "/v1/signin/github/device": return route.fulfill({ headers: cors, json: { code_challenge_method: "S256", device_code: "fixture-device", user_code: "ABCD-1234", verification_uri: "https://github.com/login/device", expires_in: 900, interval: 5 } });
              case "/v1/token": return route.fulfill({ status: 400, headers: cors, json: { error: { code: "authorization_pending" } } });
              default: return route.fulfill({ status: 404, headers: cors, json: { error: { code: "not_found" } } });
            }
          });
        }
        if (signedIn) {
          await context.addInitScript((service) => {
            const request = indexedDB.open("ovis-account", 1);
            request.onupgradeneeded = () => { request.result.createObjectStore("account"); };
            request.onsuccess = () => {
              const tx = request.result.transaction("account", "readwrite");
              tx.objectStore("account").put({ service, account: "fixture", provider: "google", access_token: "fixture-access", refresh_token: "fixture-refresh", expires_at: Date.now() + 3_600_000 }, "session");
              tx.oncomplete = () => request.result.close();
            };
          }, service);
        }
        const page = await context.newPage();
        const errors: string[] = [];
        page.on("pageerror", (error) => errors.push(error.message));
        await page.goto(url);
        const guide = page.getByRole("region", { name: "Setup guide", exact: true });
        await guide.getByRole("button", { name: /I've used Ovis before/ }).waitFor();
        const signIn = guide.locator(".setup-signin");
        const shot = async (name: string) => {
          if (process.env.UI_EVIDENCE_DIR) await page.screenshot({ path: join(process.env.UI_EVIDENCE_DIR, `${name}-${width}.png`), animations: "disabled" });
        };
        if (offered === null) {
          // whether this page has an account service is known on first render (its meta tag), with the welcome
          assert.equal(await signIn.count(), 0, `no sign-in without an account service ${at}`);
          assert.equal(await guide.locator(".account-provider").count(), 0, `no provider button without an account service ${at}`);
        } else if (!signedIn) {
          await signIn.locator("[data-offer='service'] .account-provider").first().waitFor();
          const expected = offered.map((provider) => provider === "github" ? "Continue with GitHub" : "Continue with Google");
          assert.deepEqual(await signIn.locator(".account-provider").allTextContents(), expected, `one button for each provider the service lists ${at}`);
          await shot(`welcome-signin-${offered.join("-")}`);
          if (offered.length === 1 && offered[0] === "github") {
            // a code on screen: only its Cancel ends it, Not now cannot fold it away unnoticed
            await signIn.getByRole("button", { name: "Continue with GitHub", exact: true }).click();
            await signIn.locator(".account-device-code").filter({ hasText: "ABCD-1234" }).waitFor();
            assert.equal(await signIn.getByRole("button", { name: "Not now", exact: true }).count(), 0, `no Not now while a device code waits ${at}`);
            await signIn.getByRole("button", { name: "Cancel", exact: true }).click();
            await signIn.locator("[data-offer='service'] .account-provider").first().waitFor();
          }
          // by keyboard: the box goes and the keyboard's place moves to the first choice, not the page
          await signIn.getByRole("button", { name: "Not now", exact: true }).focus();
          await page.keyboard.press("Enter");
          await signIn.waitFor({ state: "detached" });
          assert.equal(await page.evaluate(() => document.activeElement?.classList.contains("setup-choice") ?? false), true, `Not now hands the keyboard to the first choice ${at}`);
          assert.equal(await guide.getByRole("button", { name: /I'm new to Ovis/ }).count(), 1, `Not now leaves the welcome's choices ${at}`);
          assert.equal(await guide.getByRole("button", { name: /I've used Ovis before/ }).count(), 1, `Not now leaves the welcome's choices ${at}`);
        } else {
          // the account's id is the service's own, never shown: the line names the way in, as Settings does
          await signIn.getByText("Signed in with Google", { exact: true }).waitFor();
          assert.equal(await signIn.getByRole("button", { name: "Not now", exact: true }).count(), 0, `no Not now once signed in ${at}`);
          assert.equal(await signIn.locator(".account-provider").count(), 0, `no provider buttons once signed in ${at}`);
          await shot("welcome-signin-signed-in");
          await guide.getByRole("button", { name: /I've used Ovis before/ }).click();
          await guide.waitFor({ state: "detached" });
          await openSettings(page);
          await openSettingsPage(page, "Devices and PCs");
          await openSettingsFolds(page);
          await page.locator("[data-section='account']").getByText("Signed in with Google", { exact: true }).waitFor();
        }
        assert.deepEqual(errors, [], `no page errors ${at}`);
      } finally {
        await context.close();
      }
    }
  }
  console.log("PASS the welcome offers Continue with each provider the account service lists, none without one, Not now keeps the choices, and its sign-in is the one Settings shows, at 390 and 1280px");
}

/**
 * Appearance's ↺ beside a changed row, and its theme cards by keyboard: ↺ shows only off the default,
 * puts back every key of its row (a font and its size; a theme and the palette it draws) and goes; the
 * arrows pick along the row as a radio group's do; the cards follow the Theme mode until a side is chosen.
 */
async function rowResets(browser: import("playwright-core").Browser, url: string): Promise<void> {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "en" });
  try {
    await context.addInitScript((settings) => { if (localStorage.getItem("ovis:settings") === null) localStorage.setItem("ovis:settings", settings); }, JSON.stringify(SETTINGS));
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const saved = () => page.evaluate(() => JSON.parse(localStorage.getItem("ovis:settings")!) as Record<string, unknown>);
    const reset = (row: string) => page.getByRole("button", { name: `Restore defaults: ${row}`, exact: true });
    await page.goto(`${url}?settings=appearance`);
    await page.locator(".conn-live").waitFor({ state: "attached" });
    await page.locator(".theme-cards").waitFor();
    // the cards follow the Theme mode while no side is chosen here
    const mode = page.getByRole("group", { name: "Theme", exact: true });
    await mode.getByRole("button", { name: "Light", exact: true }).click();
    await page.getByRole("radiogroup", { name: "Light theme", exact: true }).waitFor();
    await mode.getByRole("button", { name: "Dark", exact: true }).click();
    await page.getByRole("radiogroup", { name: "Dark theme", exact: true }).waitFor();

    assert.equal(await reset("Terminal font").count(), 0, "no ↺ while the terminal font and size are the defaults");
    await page.getByRole("button", { name: "Increase terminal font size", exact: true }).click();
    await reset("Terminal font").waitFor();
    assert.equal((await saved())["terminalFontSize"], DEFAULT_SETTINGS.terminalFontSize + 1);
    await reset("Terminal font").focus();
    await page.keyboard.press("Enter");
    await reset("Terminal font").waitFor({ state: "detached" });
    assert.equal(await page.evaluate(() => document.activeElement?.closest(".settings-row")?.querySelector(".settings-label")?.textContent), "Terminal font", "the row keeps the focus once its ↺ goes");
    const fonts = await saved();
    assert.deepEqual([fonts["terminalFontSize"], fonts["terminalFontFamily"] ?? DEFAULT_SETTINGS.terminalFontFamily], [DEFAULT_SETTINGS.terminalFontSize, DEFAULT_SETTINGS.terminalFontFamily], "↺ puts back the size and the font of its row");

    // a custom interface font put back: the field closes and the typed list is not saved again as it goes
    const uiFont = page.getByLabel("Interface font", { exact: true });
    await uiFont.selectOption("custom");
    const custom = page.getByRole("textbox", { name: "Custom interface font", exact: true });
    await custom.fill('"Noto Sans JP"');
    await custom.press("Enter");
    await reset("Interface font").click();
    await custom.waitFor({ state: "detached" });
    assert.equal(await uiFont.inputValue(), "default", "the select shows Default once the font is put back");
    // a reload closes Settings: open the page again from its address
    await page.goto(`${url}?settings=appearance`);
    await page.locator(".theme-cards").waitFor();
    assert.equal(await page.getByLabel("Interface font", { exact: true }).inputValue(), "default", "the font put back stays put back after a reload");

    const dark = themeSide(page, "dark");
    await dark.selectOption("dracula");
    await page.waitForFunction(() => document.documentElement.dataset.palette === "dracula");
    await reset("Dark theme").click();
    await page.waitForFunction((id) => document.documentElement.dataset.palette === id, DEFAULT_SETTINGS.darkTheme);
    assert.deepEqual([(await saved())["darkTheme"], (await saved())["palette"]], [DEFAULT_SETTINGS.darkTheme, DEFAULT_SETTINGS.darkTheme], "↺ puts back the dark theme and the palette it draws");
    assert.equal(await reset("Dark theme").count(), 0, "↺ goes once the theme is back");

    // the arrows pick along the row, Home goes to its first card
    const cards = page.getByRole("radiogroup", { name: "Dark theme", exact: true });
    const listed = await dark.listed();
    await cards.locator('[role="radio"][aria-checked="true"]').focus();
    await page.keyboard.press("ArrowRight");
    const next = listed[listed.indexOf(DEFAULT_SETTINGS.darkTheme) + 1]!;
    await page.waitForFunction((id) => document.documentElement.dataset.palette === id, next);
    assert.equal(await cards.locator('[role="radio"][aria-checked="true"]').getAttribute("data-theme-card"), next, "ArrowRight picks the next card");
    assert.equal(await page.evaluate(() => (document.activeElement as HTMLElement | null)?.dataset["themeCard"]), next, "the picked card takes the focus");
    await page.keyboard.press("Home");
    await page.waitForFunction((id) => document.documentElement.dataset.palette === id, listed[0]!);

    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
  console.log("PASS Appearance: ↺ shows only off the default and puts back its row's keys; theme cards pick by arrow and follow the Theme mode");
}

async function mergedRows(browser: import("playwright-core").Browser, url: string): Promise<void> {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "en" });
  try {
    await context.addInitScript((settings) => { if (localStorage.getItem("ovis:settings") === null) localStorage.setItem("ovis:settings", settings); }, JSON.stringify({ ...SETTINGS, voiceInput: "on", voiceEngine: "auto" }));
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const pick = async (pageName: string, group: string, option: string) => {
      await page.goto(`${url}?settings=${pageName}`);
      await page.locator(".conn-live").waitFor({ state: "attached" });
      await openSettingsFolds(page);
      await page.getByRole("group", { name: group, exact: true }).getByRole("button", { name: option, exact: true }).click();
    };
    const pressed = async (pageName: string, group: string) => {
      await page.goto(`${url}?settings=${pageName}`);
      await page.locator(".conn-live").waitFor({ state: "attached" });
      await openSettingsFolds(page);
      return page.getByRole("group", { name: group, exact: true }).locator("button[aria-pressed='true']").textContent();
    };
    await pick("appearance", "Agents order", "By state");
    await page.getByRole("group", { name: "Within a state", exact: true }).waitFor();
    assert.equal(await pressed("appearance", "Agents order"), "By state");
    await pick("appearance", "Agents order", "Activity");
    assert.equal(await page.getByRole("group", { name: "Within a state", exact: true }).count(), 0, "Within a state goes with By state");
    assert.equal(await pressed("appearance", "Agents order"), "Activity");
    await pick("chat", "Show thinking", "Expanded");
    assert.equal(await pressed("chat", "Show thinking"), "Expanded");
    await pick("chat", "Show thinking", "Hidden");
    assert.equal(await pressed("chat", "Show thinking"), "Hidden");
    await pick("chat", "Tidy dictated text", "Terminal");
    assert.equal(await pressed("chat", "Tidy dictated text"), "Terminal");
    assert.deepEqual(await page.evaluate(() => { const saved = JSON.parse(localStorage.getItem("ovis:settings")!); return [saved.voicePolishChat, saved.voicePolishTerminal]; }), [false, true]);
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
  console.log("PASS the merged rows (Agents order, Show thinking, Tidy dictated text) keep both settings each stands for, through a reload");
}

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
          const lens = page.locator(".view-switch");
          await lens.getByRole("button", { name: label("Terminal"), exact: true }).tap();
          assert.equal(await terminal.getAttribute("role"), "region");
          assert.equal(await terminal.getAttribute("aria-roledescription"), label("Terminal"));
          assert.equal(await terminal.getAttribute("aria-label"), label("Terminal for {title}").replace("{title}", "Idempotent payments"));
          assert.equal(await terminal.getAttribute("tabindex"), null, "the wrapper adds no empty keyboard stop");
          await lens.getByRole("button", { name: label("Chat"), exact: true }).tap();
          assert.equal(await terminal.getAttribute("role"), null, "chat exposes no empty terminal landmark");
          assert.equal(await terminal.getAttribute("aria-label"), null);
          await openSettings(page);
          for (const name of PAGES) {
            await openSettingsPage(page, label(name), label("Back to settings"));
            // what a page asks the server for (devices, the phone address, the accounts) has arrived
            await page.waitForFunction((loading) => ![...document.querySelectorAll(".settings-body [role='status']")].some((node) => loading.includes(node.textContent?.trim() ?? "")),
              [label("Loading…")]);
            if (name === "Appearance" && process.env.UI_EVIDENCE_DIR) await page.screenshot({ path: join(process.env.UI_EVIDENCE_DIR, `select-arrows-${width}-${language}.png`), animations: "disabled" });
            await checkSelectArrows(page);
            if (name === "Agents") await page.locator(".usage-accounts-row").first().waitFor();
            if (name === "Chat") {
              // Voice input is Chat's group; its OpenAI key is in Chat's More settings
              await openSettingsFolds(page);
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
              // herdr-app's rows: no group captions on this page
              assert.deepEqual(await body.locator("h3").allTextContents(), []);
              // an agent's own settings are in its row: Claude Code's permission mode for New tab
              await body.locator(".agents-item[data-agent='claude'] .agents-toggle").click();
              await body.locator(".agents-item[data-agent='claude']").getByLabel(label("Permission mode"), { exact: true }).waitFor();
              // and the model and effort New tab fills in for it: a name its --model takes is kept, any other is said why
              const claudeRow = body.locator(".agents-item[data-agent='claude']");
              const launchDefaults = () => page.evaluate(() => { const stored = JSON.parse(localStorage.getItem("ovis:settings") ?? "{}"); return [stored.claudeLaunchModel ?? "", stored.claudeLaunchEffort ?? ""]; });
              await claudeRow.getByLabel(label("Model"), { exact: true }).fill("opus");
              await claudeRow.getByLabel(label("Effort"), { exact: true }).selectOption("high");
              await page.waitForFunction(() => { const stored = JSON.parse(localStorage.getItem("ovis:settings")!); return stored.claudeLaunchModel === "opus" && stored.claudeLaunchEffort === "high"; });
              await claudeRow.getByLabel(label("Model"), { exact: true }).fill("opus --verbose");
              await claudeRow.locator("[role='alert']").filter({ hasText: label("One model name, without spaces.") }).waitFor();
              assert.deepEqual(await launchDefaults(), ["opus", "high"], "a name --model would refuse is not kept");
              await claudeRow.getByLabel(label("Model"), { exact: true }).fill("");
              await claudeRow.getByLabel(label("Effort"), { exact: true }).selectOption("");
              await page.waitForFunction(() => { const stored = JSON.parse(localStorage.getItem("ovis:settings")!); return stored.claudeLaunchModel === "" && stored.claudeLaunchEffort === ""; });
              await body.locator(".agents-item[data-agent='claude'] .agents-toggle").click();
              // herdr's integrations no row shows, each with its command; one with neither its agent nor its
              // hook on the PC (copilot, cursor, antigravity-cli) is not listed at all (#2738)
              assert.deepEqual(await body.locator("[data-section='integrations'] .settings-label").allTextContents(), ["opencode"]);
              assert.equal(await body.locator("[data-section='integrations-missing']").count(), 0);
              const install = (target: string): string => `herdr integration install ${target}`;
              const copyLabel = (target: string): string => label("Copy the command for {name}").replace("{name}", target);
              // a row opens on its accounts and herdr's session resume
              const codex = body.locator(".agents-item[data-agent='codex']");
              await codex.locator(".agents-toggle").tap();
              assert.equal(await codex.locator(".agents-toggle").getAttribute("aria-expanded"), "true");
              assert.equal(await codex.getByLabel(label("Sandbox and approvals"), { exact: true }).count(), 1, "Codex's row holds the mode New tab starts it in");
              assert.equal(await codex.getByLabel(label("Effort"), { exact: true }).count(), 1, "and the effort New tab fills in for it");
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
              const pickers = { dark: themeSide(page, "dark"), light: themeSide(page, "light") };
              // both sides' cards offer every theme, the side's own kind first (Q1: any theme on either side)
              for (const side of ["dark", "light"] as const) {
                const listed = await pickers[side].listed();
                assert.deepEqual([...listed].sort(), [...THEME_IDS].sort(), `the ${side} cards list every theme once`);
                assert.ok(listed.includes("dracula"), `the ${side} cards offer Dracula`);
                const kinds = listed.map((id) => rowFor(id, side).mode === side);
                assert.deepEqual(kinds, [...kinds].sort((a, b) => Number(b) - Number(a)), `the ${side} cards list the side's own kind first`);
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
            // the list is edited only while the replies show; off, the row stands alone
            const showReplies = page.getByRole("switch", { name: "Show above the message box", exact: true });
            await showReplies.tap();
            await page.locator(".quick-replies-list").waitFor({ state: "detached" });
            await showReplies.tap();
            await replies.first().waitFor();
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
        // a select on Appearance (the theme pickers are cards now): Interface font
        const themePicker = page.getByLabel("Interface font", { exact: true });
        await themePicker.focus();
        await page.keyboard.press("ArrowDown");
        assert.notEqual(await themePicker.inputValue(), "default", "the native select keeps keyboard selection");
        await themePicker.selectOption("default");
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
          await themeSide(page, "dark").selectOption(id);
          await page.waitForFunction((id) => document.documentElement.dataset.palette === id && document.documentElement.dataset.theme === "dark", id);
          assert.equal(await themeSide(page, "light").inputValue(), "amber", `${id} has no sibling pre-fill`);
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
        await themeSide(page, "light").selectOption("dracula");
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
      await dialogSearch(browser, url);
      await foldedGroups(browser, url);
      await mergedRows(browser, url);
      await rowResets(browser, url);
      await accountPcList(browser, url);
      await accountGoogle(browser, url);
      await welcomeSignIn(browser, url);
      await runtimeInUse(browser, url);
      await alertChipsReset(browser, url);
      await installedNotes(browser, url);
      await focusAndLandings(browser, url);
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
