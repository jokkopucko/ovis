import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Page } from "playwright-core";
import { buildDemoApp } from "./demo-build.ts";
import { DEMO_FILE_PREVIEW_SCRIPT } from "./demo-file-preview.ts";
import { sheetRisen } from "./settings-page.ts";
import { PAGES, SETTINGS, openPalette, openSettings } from "./settings-pages-harness.ts";
import { KO } from "../src/lib/i18n.ko.ts";
import { JA } from "../src/lib/i18n.ja.ts";
import { ZH } from "../src/lib/i18n.zh.ts";

// Settings found through the command palette, on the unmodified app over the demo's fixture
// transport: what a user types for a setting, in each language, opens its page and its group. All
// files and HTTP traffic stay in this disposable, loopback-only app; no herdr session is opened.
const app = mkdtempSync(join(tmpdir(), "herdr-settings-demo-"));

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
  const ids: Record<string, string> = { Appearance: "appearance", Chat: "chat", Terminal: "terminal", Alerts: "alerts", Agents: "agents", Shortcuts: "shortcuts", "Devices and PCs": "devices", Experimental: "experimental", About: "about" };
  const name = PAGES.find((name) => label(name) === shown.page);
  return { ...shown, page: shown.page === null ? null : name === undefined ? `unknown: ${shown.page}` : ids[name] };
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

try {
  await buildDemoApp(app);
  // the same loop as scripts/settings-rows-demo-regression.ts, which has a second root: each Settings demo script loads the same index.html
  for (const [dir, extra] of [[app, ""]] as const) {
    const index = join(dir, "index.html");
    writeFileSync(index, readFileSync(index, "utf8").replace(/<script type="module"/, () => `<script src="./demo-transport.js"></script>${extra}${DEMO_FILE_PREVIEW_SCRIPT}\n    <script type="module"`));
  }
  const roots = { "/herdr-web-ui/demo/app/": app };
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
  try {
    const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? chromium.executablePath(), headless: true, args: ["--no-sandbox"] });
    try {
      // settingsSearch writes its rows into the evidence folder itself: no screenshot comes first here to make it
      if (process.env.UI_EVIDENCE_DIR) mkdirSync(process.env.UI_EVIDENCE_DIR, { recursive: true });
      await settingsSearch(browser, url);
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
  console.log("CLEANUP disposable demo apps removed");
}
