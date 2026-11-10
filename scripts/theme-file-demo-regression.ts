import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright-core";
import panes from "../site/demo/fixtures/panes.json";
import { readThemeFile } from "../src/lib/customThemes.ts";
import { deriveTheme } from "../src/lib/themeDerive.ts";
import { buildDemoApp } from "./demo-build.ts";
import { chromePath } from "./chrome-path.ts";

// Settings → Appearance → Theme file on the unmodified app over the demo's fixture transport, at a
// phone's and a desktop's width, in a dark and a light system: the example file of docs/themes.md
// is imported and drawn at once in the colours the app derives from it, it is a card that can be
// picked like a built-in theme, the page's boot script alone draws it on the next launch, a
// built-in card takes the side back, a Base16 scheme in YAML goes to its own side, a file that is
// no theme says so and changes nothing, and Remove gives the side back to its built-in theme. All
// files and HTTP traffic stay in this disposable, loopback-only app; no herdr session is opened.
// Screenshots go to UI_EVIDENCE_DIR when it is set.
const repo = join(import.meta.dir, "..");
const app = mkdtempSync(join(tmpdir(), "herdr-theme-file-demo-"));
const evidence = process.env.UI_EVIDENCE_DIR;
const EXAMPLE = /```json\n([\s\S]*?)```/.exec(readFileSync(join(repo, "docs/themes.md"), "utf8"))![1]!;
const example = readThemeFile(EXAMPLE);
assert.ok("theme" in example, "the example of docs/themes.md is a theme");
const SCHEME = ['system: "base16"', 'name: "Harbor Night"', 'variant: "dark"', "palette:",
  ...["1B2B34", "343D46", "4F5B66", "65737E", "A7ADBA", "C0C5CE", "CDD3DE", "D8DEE9", "EC5F67", "F99157", "FAC863", "99C794", "5FB3B3", "6699CC", "C594C5", "AB7967"]
    .map((color, at) => `  base0${at.toString(16).toUpperCase()}: "#${color}"  # a comment`)].join("\n");

type Scheme = "dark" | "light";
const file = (name: string, text: string) => ({ name, mimeType: "application/octet-stream", buffer: Buffer.from(text) });
const token = (page: Page, name: string): Promise<string> => page.evaluate((property) => getComputedStyle(document.documentElement).getPropertyValue(property).trim(), name);
const inline = (page: Page, name: string): Promise<string> => page.evaluate((property) => document.documentElement.style.getPropertyValue(property), name);
const palette = (page: Page): Promise<string | undefined> => page.evaluate(() => document.documentElement.dataset["palette"]);
const stored = (page: Page): Promise<{ list: { themes: { name: string }[]; dark: string | null; light: string | null } | null; rows: string[]; inMain: boolean }> => page.evaluate(() => ({
  list: JSON.parse(localStorage.getItem("ovis:custom-themes") ?? "null"),
  rows: Object.keys(JSON.parse(localStorage.getItem("ovis:custom-theme-rows") ?? "{}")),
  inMain: "customThemes" in JSON.parse(localStorage.getItem("ovis:settings") ?? "{}"),
}));

const address = (): string => `${origin}/herdr-web-ui/demo/app/?pane=${encodeURIComponent(panes.web)}&settings=appearance`;

async function open(browser: Browser, width: number, scheme: Scheme): Promise<{ page: Page; errors: string[]; close: () => Promise<void> }> {
  const phone = width <= 480;
  const context = await browser.newContext({ viewport: { width, height: phone ? 844 : 900 }, locale: "en-US", hasTouch: phone, isMobile: phone, colorScheme: scheme,
    // every script comes over the network, so the launch below can hold all but the boot script back
    serviceWorkers: "block" });
  await context.addInitScript(() => {
    if (localStorage.getItem("ovis:settings") === null) localStorage.setItem("ovis:settings", JSON.stringify({ language: "en", theme: "system" }));
  });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(address());
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
    let name: string;
    try { name = decodeURIComponent(path.slice("/herdr-web-ui/demo/app/".length)); }
    catch { return new Response("bad path", { status: 400 }); }
    if (!name || name.endsWith("/")) name += "index.html";
    if (name.split("/").includes("..") || name.includes("\\")) return new Response("bad path", { status: 400 });
    const body = Bun.file(join(app, name));
    return (await body.exists()) ? new Response(body) : new Response("not found", { status: 404 });
  } });
  origin = `http://127.0.0.1:${server.port}`;
  try {
    const browser = await chromium.launch({ executablePath: chromePath(), headless: true, args: ["--no-sandbox"] });
    try {
      if (evidence) mkdirSync(evidence, { recursive: true });
      for (const width of [390, 1440]) {
        for (const scheme of ["dark", "light"] as const) {
          const { page, errors, close } = await open(browser, width, scheme);
          try {
            const where = `${width}px ${scheme}`;
            const other: Scheme = scheme === "dark" ? "light" : "dark";
            const dialog = page.locator(".settings-dialog");
            const picker = dialog.locator('input[type="file"]');
            const cards = dialog.locator('[data-theme-card^="custom:"]');
            await dialog.getByRole("button", { name: "Import", exact: true }).waitFor();
            const builtIn = await palette(page);
            assert.ok(builtIn && builtIn !== "custom", `${where}: a built-in theme is drawn before anything is imported`);
            assert.equal(await cards.count(), 0);
            assert.equal(await inline(page, "--bg"), "", `${where}: a built-in theme's colours are the stylesheet's`);
            const format = dialog.getByRole("link", { name: "File format", exact: true });
            assert.ok(await format.isVisible(), `${where}: the link to the file format is in sight`);
            assert.match(await format.getAttribute("href") ?? "", /\/docs\/themes\.md$/);
            if (evidence) await page.screenshot({ path: join(evidence, `theme-file-before-${width}-${scheme}.png`) });

            // a file that is no theme: said, and nothing changes
            await picker.setInputFiles(file("notes.txt", "hello, this is not a theme"));
            await dialog.getByRole("alert").filter({ hasText: "No theme was found in that file." }).waitFor();
            assert.equal(await cards.count(), 0);
            assert.equal(await palette(page), builtIn);

            // the example of docs/themes.md: both sides, so both are chosen and the one drawn now changes at once
            await picker.setInputFiles(file("lamplight.json", EXAMPLE));
            await page.waitForFunction(() => document.documentElement.dataset["palette"] === "custom");
            await dialog.getByRole("status").filter({ hasText: "Imported Lamplight." }).waitFor();
            const want = deriveTheme(example.theme[scheme]!).vars;
            for (const role of ["bg", "bg-elevated", "text", "text-dim", "accent", "notice", "notice-tint", "term-bg", "syntax-keyword"] as const) {
              assert.equal(await token(page, `--${role}`), want[role], `${where}: --${role} is the colour derived from the file`);
            }
            assert.equal(await page.evaluate(() => document.documentElement.dataset["theme"]), scheme);
            assert.equal(await page.evaluate(() => document.querySelector('meta[name="theme-color"]')?.getAttribute("content")), want["bg-panel"], `${where}: the browser's bar follows the panel`);
            assert.equal(await cards.count(), 1);
            assert.equal(await cards.first().getAttribute("aria-checked"), "true", `${where}: its card is the checked one`);
            assert.equal((await cards.first().innerText()).trim(), "Lamplight");
            assert.equal(await dialog.locator('[data-theme-card][aria-checked="true"]').count(), 1, `${where}: one card is checked`);
            assert.equal(await dialog.getByRole("list", { name: "Imported themes" }).getByRole("listitem").count(), 1);
            await page.waitForFunction(() => localStorage.getItem("ovis:custom-theme-rows") !== null);
            const saved = await stored(page);
            assert.equal(saved.inMain, false, `${where}: kept in its own key, out of ovis:settings`);
            assert.deepEqual(saved.list?.themes.map((theme) => theme.name), ["Lamplight"]);
            assert.ok(saved.list?.dark !== null && saved.list?.dark === saved.list?.light, `${where}: a theme with both sides is chosen for both`);
            assert.deepEqual(saved.rows.sort(), ["dark", "light"], `${where}: the rows the boot script draws from are stored`);
            // the page does not scroll sideways for the new row or the list under it
            assert.ok(await dialog.locator(".settings-body").evaluate((node) => node.scrollWidth <= node.clientWidth + 1), `${where}: the page stays within its width`);
            if (evidence) await page.screenshot({ path: join(evidence, `theme-file-imported-${width}-${scheme}.png`) });

            // the next launch: the boot script alone, with the app's own scripts held back, draws the imported colours
            await page.route("**/*.js", (route) => route.request().url().includes("theme-bootstrap") ? route.continue() : route.abort());
            await page.goto(address(), { waitUntil: "domcontentloaded" });
            await page.waitForFunction(() => document.documentElement.dataset["palette"] !== undefined);
            assert.equal(await palette(page), "custom", `${where}: the boot script draws the imported theme`);
            assert.equal(await inline(page, "--bg"), want.bg, `${where}: in its own colours, before the app has run`);
            assert.equal(await inline(page, "--text"), want.text);
            assert.equal(await page.evaluate(() => document.documentElement.style.backgroundColor !== ""), true, `${where}: the page surface is held until the stylesheet arrives`);
            await page.unroute("**/*.js");
            await page.goto(address());
            await page.locator(".conn-live").waitFor({ state: "attached" });
            await dialog.getByRole("button", { name: "Import", exact: true }).waitFor();
            assert.equal(await palette(page), "custom", `${where}: the app goes on drawing it`);
            assert.equal(await token(page, "--bg"), want.bg);

            // the file edited and imported again: the same card in its new colours, not a second one
            await picker.setInputFiles(file("lamplight.json", EXAMPLE.replace(example.theme[scheme]!.base00, "#123456")));
            await page.waitForFunction(() => getComputedStyle(document.documentElement).getPropertyValue("--bg").trim() === "#123456");
            assert.equal(await cards.count(), 1, `${where}: an edited file takes its earlier self's place`);
            assert.equal(await cards.first().getAttribute("aria-checked"), "true");
            assert.deepEqual((await stored(page)).list?.themes.map((theme) => theme.name), ["Lamplight"]);
            // JSON but for a trailing comma is said to be that, and the theme drawn stays
            await picker.setInputFiles(file("lamplight.json", '{"base00": "#101010", "base05": "#e0e0e0",}'));
            await dialog.getByRole("alert").filter({ hasText: "That file is not valid JSON." }).waitFor();
            assert.equal(await token(page, "--bg"), "#123456");
            await picker.setInputFiles(file("lamplight.json", EXAMPLE));
            await page.waitForFunction((bg) => getComputedStyle(document.documentElement).getPropertyValue("--bg").trim() === bg, want.bg);
            assert.equal(await cards.count(), 1);

            // a built-in card takes the side back, the imported card takes it again
            const first = dialog.locator('[data-theme-card]:not([data-theme-card^="custom:"])').first();
            const firstId = await first.getAttribute("data-theme-card");
            await first.click();
            await page.waitForFunction((id) => document.documentElement.dataset["palette"] === id, firstId);
            assert.equal(await inline(page, "--bg"), "", `${where}: a built-in theme leaves none of the imported colours on the document`);
            assert.equal(await cards.first().getAttribute("aria-checked"), "false");
            assert.equal((await stored(page)).list?.[scheme], null, `${where}: the side draws no imported theme`);
            assert.ok((await stored(page)).list?.[other] !== null, `${where}: the other side keeps its own`);
            await cards.first().click();
            await page.waitForFunction(() => document.documentElement.dataset["palette"] === "custom");
            assert.equal(await token(page, "--bg"), want.bg);

            // a Base16 scheme as published, one side: it goes to that side, and the picker shows that side's cards
            await picker.setInputFiles(file("harbor-night.yaml", SCHEME));
            await dialog.getByRole("status").filter({ hasText: "Imported Harbor Night." }).waitFor();
            assert.equal(await cards.count(), 2);
            assert.equal(await dialog.getByRole("button", { name: "Show dark themes", exact: true }).getAttribute("aria-pressed"), "true", `${where}: Dark is the side shown`);
            const night = dialog.locator('[data-theme-card^="custom:"]', { hasText: "Harbor Night" });
            assert.equal(await night.getAttribute("aria-checked"), "true", `${where}: the scheme is the dark side's theme`);
            const after = await stored(page);
            assert.notEqual(after.list?.dark, after.list?.light, `${where}: the light side keeps the theme it had`);
            if (scheme === "dark") {
              await page.waitForFunction((bg) => getComputedStyle(document.documentElement).getPropertyValue("--bg").trim() === bg, "#1b2b34");
            } else {
              assert.equal(await token(page, "--bg"), want.bg, `${where}: a dark scheme does not change the light side drawn now`);
            }
            if (evidence) await page.screenshot({ path: join(evidence, `theme-file-two-${width}-${scheme}.png`) });

            // a second theme of the same name with other sides is its own theme, and the two say their sides
            const lone = JSON.stringify({ name: "Lamplight", dark: example.theme.dark });
            await picker.setInputFiles(file("lamplight-dark.json", lone));
            await page.waitForFunction(() => document.querySelectorAll('.settings-dialog [data-theme-card^="custom:"]').length === 3);
            assert.deepEqual((await cards.allInnerTexts()).map((text) => text.trim()).sort(), ["Harbor Night", "Lamplight · Dark", "Lamplight · Dark · Light"]);
            assert.equal(await dialog.getByRole("button", { name: "Remove theme Lamplight · Dark · Light", exact: true }).count(), 1);
            await dialog.getByRole("button", { name: "Remove theme Lamplight · Dark", exact: true }).click();
            await page.waitForFunction(() => document.querySelectorAll('.settings-dialog [data-theme-card^="custom:"]').length === 2);
            assert.deepEqual((await cards.allInnerTexts()).map((text) => text.trim()).sort(), ["Harbor Night", "Lamplight"], `${where}: alone again, the name stands by itself`);
            // YAML that holds two sides is refused, and told why
            await picker.setInputFiles(file("two.yaml", 'name: "Two"\ndark:\n  base00: "101010"\n  base05: "e0e0e0"\nlight:\n  base00: "ffffff"\n  base05: "202020"\n'));
            await dialog.getByRole("alert").filter({ hasText: "That file holds more than one side." }).waitFor();
            assert.equal(await cards.count(), 2);

            // Remove: the cards go, and a side that drew one is its built-in theme again
            await dialog.getByRole("button", { name: "Remove theme Harbor Night", exact: true }).click();
            await dialog.getByRole("button", { name: "Remove theme Lamplight", exact: true }).click();
            await page.waitForFunction(() => document.documentElement.dataset["palette"] !== "custom");
            assert.equal(await cards.count(), 0);
            assert.equal(await dialog.getByRole("list", { name: "Imported themes" }).count(), 0);
            assert.equal(await inline(page, "--bg"), "");
            await page.waitForFunction(() => localStorage.getItem("ovis:custom-theme-rows") === null);
            assert.deepEqual(await stored(page), { list: { themes: [], dark: null, light: null }, rows: [], inMain: false });
            assert.equal(await dialog.locator('[data-theme-card][aria-checked="true"]').count(), 1, `${where}: a built-in card is checked again`);
            assert.deepEqual(errors, []);
            console.log(`PASS ${where}: a theme file is imported, drawn, kept for the first frame, picked like a built-in theme and removed`);
          } finally { await close(); }
        }
      }
    } finally { await browser.close(); }
  } finally { await server.stop(true); }
} finally {
  rmSync(app, { recursive: true, force: true });
}
