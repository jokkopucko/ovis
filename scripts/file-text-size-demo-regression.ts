import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright-core";
import panes from "../site/demo/fixtures/panes.json";
import { buildDemoApp } from "./demo-build.ts";
import { chromePath } from "./chrome-path.ts";

// Settings → Appearance → File text size on the unmodified app over the demo's fixture transport,
// at a phone's and a desktop's width, light and dark (#2005): with nothing chosen a Markdown preview
// keeps the chat's size and a plain-text source the interface's; a chosen size draws both at it while
// the chat and the viewer's header stay put; Reset gives the old sizes back. All files and HTTP
// traffic stay in this disposable, loopback-only app; no herdr session is opened. Screenshots go to
// UI_EVIDENCE_DIR when it is set.
const app = mkdtempSync(join(tmpdir(), "ovis-file-text-size-demo-"));
const evidence = process.env.UI_EVIDENCE_DIR;

// the demo has no files: a Markdown and a plain-text one, with Korean, emoji and a long line
const FILES_SCRIPT = `<script>(${(() => {
  const demoFetch = window.fetch;
  const body = "한국어 문장과 English words, 이모지 🙂🚀, and a long line: " + "word ".repeat(80);
  const files: Record<string, { text: string; mime: string; kind: string }> = {
    "notes.md": { text: `# Plan\n\n${body}\n\n- 첫째 항목\n- second item\n\n\`\`\`ts\nconst size = 18;\n\`\`\`\n`, mime: "text/markdown", kind: "text" },
    "notes.txt": { text: `${body}\n둘째 줄\n`, mime: "text/plain", kind: "text" },
    "long.log": { text: Array.from({ length: 3000 }, (_, at) => `line ${at + 1} 한글 🙂`).join("\n"), mime: "text/plain", kind: "text" },
  };
  window.fetch = (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input), window.location.href);
    const path = url.searchParams.get("path") ?? "";
    const name = path.split("/").pop() ?? "";
    const file = files[name];
    if (file !== undefined) {
      if (url.pathname.endsWith("/fs/stat")) return Promise.resolve(Response.json({ path, name, kind: file.kind, mime: file.mime, size: file.text.length }));
      if (url.pathname.endsWith("/fs/file")) return Promise.resolve(new Response(file.text, { headers: { "content-type": file.mime } }));
    }
    return demoFetch(input, init);
  };
}).toString()})();</script>`;

const px = (page: Page, selector: string): Promise<number> =>
  page.locator(selector).first().evaluate((node) => Number.parseFloat(getComputedStyle(node).fontSize));

async function open(browser: Browser, width: number, settings: Record<string, unknown>, query: string): Promise<{ page: Page; errors: string[]; close: () => Promise<void> }> {
  const phone = width <= 480;
  const context = await browser.newContext({ viewport: { width, height: phone ? 844 : 900 }, locale: "en-US", hasTouch: phone, isMobile: phone });
  // the file text size is kept in a key of its own (lib/settings.ts), not in ovis:settings
  const { fileFontSize, fileFontBase, ...main } = settings;
  await context.addInitScript(([value, size, base]) => {
    if (localStorage.getItem("ovis:settings") !== null) return;
    localStorage.setItem("ovis:settings", value!);
    if (size !== "") localStorage.setItem("ovis:file-font-size", size!);
    if (base !== "") localStorage.setItem("ovis:file-font-base", base!);
  }, [JSON.stringify({ language: "en", ...main }), fileFontSize === undefined ? "" : JSON.stringify(fileFontSize), fileFontBase === undefined ? "" : JSON.stringify(fileFontBase)]);
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${origin}/herdr-web-ui/demo/app/?pane=${encodeURIComponent(panes.web)}${query}`);
  await page.locator(".conn-live").waitFor({ state: "attached" });
  return { page, errors, close: () => context.close() };
}

interface Sizes { preview: number; source: number; title: number; chat: number }

async function sizes(browser: Browser, width: number, settings: Record<string, unknown>, shot: string | null): Promise<Sizes> {
  const read = async (file: string, selector: string): Promise<{ size: number; title: number }> => {
    const { page, errors, close } = await open(browser, width, settings, `&file=${file}`);
    try {
      await page.locator(selector).first().waitFor();
      const size = await px(page, selector);
      const title = await px(page, ".file-viewer .file-viewer-name, .file-viewer .modal-title");
      if (evidence && shot !== null) await page.screenshot({ path: join(evidence, `${shot}-${file.replace(".", "-")}-${width}.png`) });
      assert.deepEqual(errors, []);
      return { size, title };
    } finally { await close(); }
  };
  const preview = await read("notes.md", ".file-viewer-markdown p");
  const source = await read("notes.txt", ".file-viewer-text");
  const { page, close } = await open(browser, width, settings, "&view=chat");
  try {
    await page.locator(".chat-transcript").first().waitFor({ state: "attached" });
    const chat = await page.evaluate(() => {
      const probe = document.createElement("p");
      document.querySelector(".chat-transcript")!.append(probe);
      const size = Number.parseFloat(getComputedStyle(probe).fontSize);
      probe.remove();
      return size;
    });
    return { preview: preview.size, source: source.size, title: preview.title, chat };
  } finally { await close(); }
}

let origin = "";
try {
  await buildDemoApp(app);
  const index = join(app, "index.html");
  writeFileSync(index, readFileSync(index, "utf8").replace(/<script type="module"/, () => `<script src="./demo-transport.js"></script>${FILES_SCRIPT}\n    <script type="module"`));
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
      for (const width of [390, 1280]) {
        for (const theme of ["light", "dark"] as const) {
          const base = await sizes(browser, width, { theme }, null);
          // a chat size of its own moves the preview with it, as today, and leaves the source at the interface's
          const chat = await sizes(browser, width, { theme, chatFontSize: 21 }, `follow-${theme}`);
          assert.ok(Math.abs(chat.preview - base.preview * 1.5) < 0.1, `${width}px ${theme}: the preview follows the chat (${chat.preview} vs ${base.preview})`);
          assert.equal(chat.source, base.source, `${width}px ${theme}: the source keeps the interface's size until a file size is chosen`);
          assert.equal(chat.title, base.title);
          assert.ok(Math.abs(chat.chat - base.chat * 1.5) < 0.1, `${width}px ${theme}: the chat takes its own size (${chat.chat} vs ${base.chat})`);
          // a file size of its own: preview and source at it, the chat and the header where they were
          const own = await sizes(browser, width, { theme, chatFontSize: 21, fileFontSize: 18 }, `own-${theme}`);
          assert.ok(Math.abs(own.preview - base.preview * 18 / 14) < 0.1, `${width}px ${theme}: the preview takes the file size (${own.preview})`);
          assert.ok(Math.abs(own.source - base.source * 18 / 21) < 0.1, `${width}px ${theme}: the source scales with it (${own.source})`);
          assert.equal(own.chat, chat.chat, `${width}px ${theme}: the chat keeps its own size`);
          assert.equal(own.title, base.title, `${width}px ${theme}: the viewer's header keeps the interface's size`);
          console.log(`PASS ${width}px ${theme}: preview ${base.preview}→${own.preview}px, source ${base.source}→${own.source}px, chat ${own.chat}px, title ${own.title}px`);
        }

        // a long file's source is virtualized: its rows, in a shadow root, take the size and the row estimate matches
        // them, so its last line is drawn at the end; a size changed while it is open re-measures the rows
        {
          const { page, errors, close } = await open(browser, width, { fileFontSize: 24 }, "&file=long.log&settings=appearance&section=typography-more");
          try {
            const rowAt = (): Promise<{ host: number; row: number; last: boolean }> => page.evaluate(() => {
              const host = document.querySelector<HTMLElement>(".virtual-source")!;
              const shadow = document.querySelector("diffs-container")!.shadowRoot!;
              const row = shadow.querySelector<HTMLElement>("[data-line]")!;
              const scroll = document.querySelector<HTMLElement>(".virtual-source-scroll")!;
              const bottom = scroll.getBoundingClientRect().bottom;
              const last = shadow.querySelector<HTMLElement>('[data-line="3000"]');
              const box = last?.getBoundingClientRect();
              return { host: Number.parseFloat(getComputedStyle(host).lineHeight), row: row.getBoundingClientRect().height, last: box !== undefined && box.bottom <= bottom + 1 && box.bottom > bottom - scroll.clientHeight };
            });
            const toEnd = async (): Promise<void> => {
              await page.waitForFunction(() => (document.querySelector("diffs-container")?.shadowRoot?.querySelectorAll("[data-line]").length ?? 0) > 0);
              for (let pass = 0; pass < 6; pass++) {
                await page.evaluate(() => { const scroll = document.querySelector<HTMLElement>(".virtual-source-scroll")!; scroll.scrollTop = scroll.scrollHeight; });
                await page.waitForFunction(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => done(true)))));
              }
            };
            await toEnd();
            const big = await rowAt();
            assert.ok(Math.abs(big.row - big.host) < 0.5, `${width}px: a virtualized row is drawn at the measured line height (${big.row} vs ${big.host})`);
            assert.ok(big.last, `${width}px: the last line is in view at the end of a long file`);
            // from the middle of the file, back to the chat's size at once: the estimate follows the new rows (3,000 of
            // them) and the view keeps the line it showed, with no scroll of the reader's own after it
            const topLine = (): Promise<number> => page.evaluate(() => {
              const view = document.querySelector<HTMLElement>(".virtual-source-scroll")!.getBoundingClientRect();
              const rows = [...document.querySelector("diffs-container")!.shadowRoot!.querySelectorAll<HTMLElement>("[data-line]")];
              const shown = rows.filter((row) => { const box = row.getBoundingClientRect(); return box.bottom > view.top + 1 && box.top < view.bottom; });
              return Math.min(...shown.map((row) => Number(row.dataset["line"])));
            });
            await page.evaluate((height) => { document.querySelector<HTMLElement>(".virtual-source-scroll")!.scrollTop = 1499 * height; }, big.host);
            await page.waitForFunction(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => done(true)))));
            const before = await topLine();
            assert.ok(before > 1400 && before < 1600, `${width}px: scrolled to the middle (${before})`);
            await page.locator(".settings-dialog").getByRole("button", { name: "Reset", exact: true }).click();
            await page.waitForFunction((was) => Number.parseFloat(getComputedStyle(document.querySelector(".virtual-source")!).lineHeight) < was, big.host);
            const small = await page.evaluate(() => Number.parseFloat(getComputedStyle(document.querySelector(".virtual-source")!).lineHeight));
            await page.waitForFunction((height) => {
              const scroll = document.querySelector<HTMLElement>(".virtual-source-scroll")!;
              return Math.abs(scroll.scrollHeight - 3000 * height) < 3000 * height * 0.05;
            }, small);
            await page.waitForFunction(() => new Promise((done) => setTimeout(() => requestAnimationFrame(() => done(true)), 0)));
            const after = await topLine();
            assert.ok(Math.abs(after - before) <= 3, `${width}px: the view keeps its line across the change (${before} → ${after})`);
            await page.keyboard.press("Escape");
            await page.locator(".settings-dialog").waitFor({ state: "detached" });
            await toEnd();
            const end = await rowAt();
            assert.ok(Math.abs(end.row - end.host) < 0.5, `${width}px: the rows are drawn at the new height (${end.row} vs ${end.host})`);
            assert.ok(end.last, `${width}px: the last line is still in view after the change`);
            if (evidence) await page.screenshot({ path: join(evidence, `virtual-source-${width}.png`) });
            assert.deepEqual(errors, []);
            console.log(`PASS ${width}px: a virtualized source draws its rows at the file size (${big.row}px, then ${end.row}px), keeps its line across a change and reaches its last line`);
          } finally { await close(); }
        }

        // with a size chosen the source keeps it through a later chat size, and through a later interface size (#2984):
        // its rows stay as they were and the long file's height with them
        {
          const { page, errors, close } = await open(browser, width, { fileFontSize: 24, fileFontBase: { size: 24, chat: 14, ui: 14 } }, "&file=long.log&settings=appearance&section=typography");
          try {
            const lineOf = (): Promise<number> => page.evaluate(() => Number.parseFloat(getComputedStyle(document.querySelector(".virtual-source")!).lineHeight));
            await page.waitForFunction(() => (document.querySelector("diffs-container")?.shadowRoot?.querySelectorAll("[data-line]").length ?? 0) > 0);
            const before = await lineOf();
            const dialog = page.locator(".settings-dialog");
            for (let step = 0; step < 10; step++) await dialog.getByRole("button", { name: "Increase chat font size", exact: true }).click();
            assert.equal(await lineOf(), before, `${width}px: a chat size change leaves a chosen file size's source as it was`);
            await page.goto(`${origin}/herdr-web-ui/demo/app/?pane=${encodeURIComponent(panes.web)}&file=long.log&settings=appearance&section=typography-more`);
            await page.waitForFunction(() => (document.querySelector("diffs-container")?.shadowRoot?.querySelectorAll("[data-line]").length ?? 0) > 0);
            const uiScale = (): Promise<string> => page.evaluate(() => document.documentElement.style.getPropertyValue("--ui-scale"));
            const uiBefore = await uiScale();
            for (let step = 0; step < 3; step++) await dialog.getByRole("button", { name: "Increase interface font size", exact: true }).click();
            await page.keyboard.press("Escape");
            await dialog.waitFor({ state: "detached" });
            await page.waitForFunction((was) => document.documentElement.style.getPropertyValue("--ui-scale") !== was, uiBefore);
            const height = await lineOf();
            assert.ok(Math.abs(height - before) < 0.01, `${width}px: an interface size change leaves a chosen file size's source as it was (${before} vs ${height})`);
            await page.waitForFunction((row) => Math.abs(document.querySelector<HTMLElement>(".virtual-source-scroll")!.scrollHeight - 3000 * row) < 3000 * row * 0.05, height);
            assert.deepEqual(errors, []);
            console.log(`PASS ${width}px: a chosen file size's source keeps its size through a chat and an interface size (${before}px, ${height}px)`);
          } finally { await close(); }
        }

        // the control: a step sets a size of its own, kept for the device; Reset drops it
        const { page, errors, close } = await open(browser, width, { chatFontSize: 16 }, "&settings=appearance&section=typography-more");
        try {
          const dialog = page.locator(".settings-dialog");
          const stepper = dialog.getByRole("group", { name: "File text size", exact: true });
          await stepper.waitFor();
          assert.equal(await stepper.locator("output").textContent(), "16px", "it shows the chat's size while it follows it");
          assert.equal(await dialog.getByRole("button", { name: "Reset", exact: true }).count(), 0, "nothing to reset while it follows");
          await stepper.getByRole("button", { name: "Increase file text size", exact: true }).click();
          assert.equal(await stepper.locator("output").textContent(), "17px");
          assert.ok(Math.abs(Number(await page.evaluate(() => document.documentElement.style.getPropertyValue("--file-source-scale"))) - 17 / 16) < 1e-9, "a step up from the chat's size moves the source up with the preview");
          assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem("ovis:file-font-size") ?? "null")), 17, "kept on this device");
          const stored = await page.evaluate(() => JSON.parse(localStorage.getItem("ovis:file-font-base") ?? "null"));
          assert.deepEqual({ size: stored?.size, chat: stored?.chat }, { size: 17, chat: 16 }, "with the chat's size it started from, for the size chosen");
          assert.ok(Number.isInteger(stored?.ui), "and the interface's");
          if (evidence) await page.screenshot({ path: join(evidence, `settings-file-text-size-${width}.png`) });
          await dialog.getByRole("button", { name: "Reset", exact: true }).click();
          assert.equal(await stepper.locator("output").textContent(), "16px", "Reset gives the chat's size back");
          assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem("ovis:file-font-size") ?? "null")), null);
          assert.deepEqual(errors, []);
          console.log(`PASS ${width}px: File text size steps from the chat's size, is kept, and Reset drops it`);
        } finally { await close(); }
      }
    } finally { await browser.close(); }
  } finally { await server.stop(true); }
} finally {
  rmSync(app, { recursive: true, force: true });
}
