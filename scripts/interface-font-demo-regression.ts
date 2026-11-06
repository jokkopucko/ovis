import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright-core";
import panes from "../site/demo/fixtures/panes.json";
import { buildDemoApp } from "./demo-build.ts";
import { chromePath } from "./chrome-path.ts";

// Settings → Appearance → Interface font on the unmodified app over the demo's fixture transport,
// at a phone's and a desktop's width: a preset and a typed list go in front of the built-in stack
// as --font-ui on <html>, what is set in it follows, a reload keeps the choice, Default gives the
// stylesheet its token back, and code keeps --font-mono. The message box takes the Chat font, as
// the transcript does (#1904). All files and HTTP traffic stay in this disposable, loopback-only
// app; no herdr session is opened. Screenshots go to UI_EVIDENCE_DIR when it is set.
const repo = join(import.meta.dir, "..");
const app = mkdtempSync(join(tmpdir(), "herdr-interface-font-demo-"));
const BUILT_IN = readFileSync(join(repo, "src/styles.css"), "utf8").match(/--font-ui:\s*([^;]+);/)![1]!.trim();
const evidence = process.env.UI_EVIDENCE_DIR;

const token = (page: Page): Promise<string> => page.evaluate(() => document.documentElement.style.getPropertyValue("--font-ui"));
const fontOf = (page: Page, selector: string): Promise<string> => page.locator(selector).first().evaluate((node) => getComputedStyle(node).fontFamily);
// the interface font is kept in a key of its own (lib/settings.ts), not in ovis:settings
const stored = (page: Page): Promise<unknown> => page.evaluate(() => {
  const raw = localStorage.getItem("ovis:ui-font");
  return { own: raw === null ? null : JSON.parse(raw), inMain: "uiFontFamily" in JSON.parse(localStorage.getItem("ovis:settings") ?? "{}") };
});

async function open(browser: Browser, width: number, settings: Record<string, unknown>, query: string, uiFont = ""): Promise<{ page: Page; errors: string[]; close: () => Promise<void> }> {
  const phone = width <= 480;
  const context = await browser.newContext({ viewport: { width, height: phone ? 844 : 900 }, locale: "en-US", hasTouch: phone, isMobile: phone });
  await context.addInitScript(([value, font]) => {
    if (localStorage.getItem("ovis:settings") !== null) return;
    localStorage.setItem("ovis:settings", value!);
    if (font) localStorage.setItem("ovis:ui-font", JSON.stringify(font));
  }, [JSON.stringify({ language: "en", ...settings }), uiFont]);
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${origin}/herdr-web-ui/demo/app/?pane=${encodeURIComponent(panes.web)}${query}`);
  await page.locator(".conn-live").waitFor({ state: "attached" });
  return { page, errors, close: () => context.close() };
}

let origin = "";
try {
  await buildDemoApp(app);
  const index = join(app, "index.html");
  writeFileSync(index, readFileSync(index, "utf8").replace(/<script type="module"/, () => `<script src="./demo-transport.js"></script>\n    <script type="module"`));
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
  origin = `http://127.0.0.1:${server.port}`;
  try {
    const browser = await chromium.launch({ executablePath: chromePath(), headless: true, args: ["--no-sandbox"] });
    try {
      if (evidence) mkdirSync(evidence, { recursive: true });
      for (const width of [390, 1440]) {
        const { page, errors, close } = await open(browser, width, {}, "&settings=appearance&section=typography");
        try {
          const dialog = page.locator(".settings-dialog");
          const select = dialog.getByLabel("Interface font", { exact: true });
          await select.waitFor();
          assert.equal(await select.inputValue(), "default", "nothing is chosen until the user picks");
          assert.equal(await token(page), "", "Default leaves --font-ui to the stylesheet");
          const monoBefore = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--font-mono").trim());

          await select.selectOption("system");
          assert.equal(await token(page), "system-ui, sans-serif", "System is the device's own stack, with no Pretendard behind it");
          assert.equal(await fontOf(page, "body"), "system-ui, sans-serif", "the interface is set in it");
          assert.equal(await fontOf(page, ".settings-label"), "system-ui, sans-serif", "and so is Settings itself");
          assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--font-mono").trim()), monoBefore, "code keeps its own stack");
          assert.deepEqual(await stored(page), { own: "system-ui", inMain: false }, "kept in its own key, out of ovis:settings");
          if (evidence) await page.screenshot({ path: join(evidence, `interface-font-system-${width}.png`) });

          await select.selectOption("custom");
          const field = dialog.getByRole("textbox", { name: "Custom interface font", exact: true });
          await field.fill("Fixture UI Font, Hiragino Sans");
          await field.press("Enter");
          await page.waitForFunction(() => document.documentElement.style.getPropertyValue("--font-ui").startsWith('"Fixture UI Font"'));
          assert.equal(await token(page), `"Fixture UI Font", "Hiragino Sans", ${BUILT_IN}`, "a typed list goes in front of the built-in stack");
          assert.equal(await select.inputValue(), "custom");
          if (evidence) await page.screenshot({ path: join(evidence, `interface-font-custom-${width}.png`) });

          // a reload steps out of Settings (lib/settingsHistory.ts): the app comes back with the choice, and the link opens the page again
          await page.reload();
          await page.locator(".conn-live").waitFor({ state: "attached" });
          assert.equal(await token(page), `"Fixture UI Font", "Hiragino Sans", ${BUILT_IN}`, "a reload keeps the typed list");
          await page.goto(`${origin}/herdr-web-ui/demo/app/?pane=${encodeURIComponent(panes.web)}&settings=appearance&section=typography`);
          await select.waitFor();
          assert.equal(await select.inputValue(), "custom", "and Settings says it is a typed list");

          await select.selectOption("default");
          assert.equal(await token(page), "", "Default gives the stylesheet its token back");
          assert.deepEqual(await stored(page), { own: "", inMain: false });
          assert.equal(await dialog.getByRole("textbox", { name: "Custom interface font", exact: true }).count(), 0, "the field goes with Custom");
          assert.deepEqual(errors, []);
          console.log(`PASS ${width}px: Interface font System and a typed list lead --font-ui, a reload keeps it, Default restores the stylesheet's`);
        } finally { await close(); }
      }

      for (const width of [390, 1440]) {
        for (const [settings, uiFont, want] of [[{ chatFontFamily: "Georgia" }, "", /^Georgia, "Pretendard Variable"/], [{}, "system-ui", /^system-ui, sans-serif$/]] as const) {
          const { page, errors, close } = await open(browser, width, settings, "&view=chat", uiFont);
          try {
            await page.locator(".composer-text").waitFor();
            assert.match(await fontOf(page, ".composer-text"), want, `${width}px ${JSON.stringify(settings)}: the message box`);
            assert.match(await fontOf(page, ".composer-measure"), want, `${width}px ${JSON.stringify(settings)}: its measure copy`);
            assert.deepEqual(errors, []);
            if (evidence && uiFont === "") await page.screenshot({ path: join(evidence, `composer-chat-font-${width}.png`) });
          } finally { await close(); }
        }
        console.log(`PASS ${width}px: the message box takes the Chat font, else the interface font`);
      }
    } finally { await browser.close(); }
  } finally { await server.stop(true); }
} finally {
  rmSync(app, { recursive: true, force: true });
}
