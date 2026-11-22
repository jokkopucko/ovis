/**
 * At 412 and 720 wide, DPR 2.625, in Input line and Direct typing modes, with the
 * default font and with the bundled "JetBrains Mono Web": a long composition (CDP
 * Input.imeSetComposition, as Gboard's voice typing sends one) leaves the page and the terminal host
 * at scroll 0, keeps xterm's composition box inside the grid, and the grid is the pane's width less
 * its padding and less than one cell.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Browser } from "playwright-core";
import { herdrRpc, workspaceClose, workspaceCreate } from "../server/herdr/client.ts";
import { chromePath } from "./chrome-path.ts";
import { shownRows } from "./shown-rows.ts";

function compositionGlyphs(): { left: number; right: number; first: { left: number; right: number }; last: { left: number; right: number } } | null {
  const view = document.querySelector(".composition-view.active");
  const text = view?.firstChild;
  if (!view || !text || text.nodeType !== Node.TEXT_NODE || !text.textContent) return null;
  const glyph = (start: number, end: number): { left: number; right: number } => {
    const range = document.createRange();
    range.setStart(text, start);
    range.setEnd(text, end);
    const { left, right } = range.getBoundingClientRect();
    return { left, right };
  };
  const length = text.textContent.length;
  const box = view.getBoundingClientRect();
  return { left: box.left, right: box.right, first: glyph(0, 1), last: glyph(length - 1, length) };
}

export async function checkTerminalComposition(browser: Browser, origin: string): Promise<void> {
  const out = process.env["UI_EVIDENCE_DIR"];
  if (out) mkdirSync(out, { recursive: true });
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ovis-composition-")));
  const ws = await workspaceCreate({ cwd: root, label: "ovis-test-composition" });
  try {
    await herdrRpc("pane.send_text", { pane_id: ws.root_pane.pane_id, text: "seq -s ' ' 1 400\r" });
    for (const w of [412, 720]) for (const mode of ["line", "direct"]) for (const font of ["", "JetBrains Mono Web"]) {
      const ctx = await browser.newContext({ viewport: { width: w, height: 915 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2.625, locale: "en-US" });
      await ctx.addInitScript(([m, f]) => localStorage.setItem("ovis:settings", JSON.stringify({ language: "en", terminalInputMode: m, ...(f ? { terminalFontFamily: f } : {}) })), [mode, font]);
      const page = await ctx.newPage();
      await page.goto(`${origin}/?pane=${encodeURIComponent(ws.root_pane.pane_id)}`);
      await page.locator(shownRows()).first().waitFor();
      await page.waitForFunction((rows) => document.querySelector(rows)?.textContent?.includes("400") ?? false, shownRows(), { timeout: 15_000 });
      const cdp = await ctx.newCDPSession(page);
      const target = mode === "line" ? ".terminal-input-text" : ".xterm-helper-textarea";
      await page.locator(target).focus();
      const long = "this is a long dictated sentence that keeps going and going without stopping for a while";
      let composed = "";
      for (let i = 10; i <= long.length; i += 10) {
        composed = long.slice(0, i);
        await cdp.send("Input.imeSetComposition", { text: composed, selectionStart: i, selectionEnd: i });
      }
      await page.waitForFunction(([m, text]) => m === "line"
        ? (document.querySelector(".terminal-input-text") as HTMLTextAreaElement | null)?.value.includes(text) ?? false
        : document.querySelector(".composition-view.active")?.textContent === text, [mode, composed] as const, { timeout: 10_000 });
      const after = await page.evaluate(() => {
        const scrollers: string[] = [];
        for (const n of document.querySelectorAll<HTMLElement>("*")) if (n.scrollLeft > 0) scrollers.push(`${n.className || n.tagName}:${n.scrollLeft}`);
        return { docScroll: document.documentElement.scrollWidth, inner: innerWidth, scrollX, scrollers: scrollers.slice(0, 6) };
      });
      const label = `${w} ${mode} ${font || "default font"}`;
      const view = await page.evaluate(() => {
        const box = document.querySelector(".composition-view.active")?.getBoundingClientRect();
        const screen = document.querySelector(".xterm-screen")!.getBoundingClientRect();
        const layer = document.querySelector<HTMLElement>(".pane-terminal[data-renderer='ghostty'] .ghostty-layer");
        const cell = layer
          ? parseFloat(layer.style.getPropertyValue("--ghostty-cw"))
          : screen.width / (document.querySelector(".xterm-rows")!.firstElementChild!.textContent!.length || 1);
        const host = document.querySelector<HTMLElement>(".pane-terminal")!;
        const pad = getComputedStyle(document.querySelector(".pane-terminal .xterm")!);
        const room = host.clientWidth - parseFloat(pad.paddingLeft) - parseFloat(pad.paddingRight);
        return { right: box?.right ?? null, screenRight: screen.right, screen: screen.width, room, cell, host: host.scrollLeft };
      });
      if (out) await page.screenshot({ path: `${out}/composition-${w}-${mode}-${font ? "jb" : "default"}.png` });
      assert.ok(after.docScroll <= after.inner, `${label}: the page does not grow sideways (${after.docScroll} > ${after.inner}; ${after.scrollers.join(", ")})`);
      assert.equal(after.scrollX, 0, `${label}: the page is not scrolled sideways`);
      assert.equal(view.host, 0, `${label}: the terminal is not pushed sideways (${view.host})`);
      if (mode === "direct") {
        assert.ok(view.right !== null && view.right <= view.screenRight + 1, `${label}: the composition stays inside the grid (${view.right} > ${view.screenRight})`);
        const glyphs = await page.evaluate(compositionGlyphs);
        assert.ok(glyphs && glyphs.last.right <= glyphs.right + 1 && glyphs.last.left >= glyphs.left - 1, `${label}: the newest character is in view (${JSON.stringify(glyphs)})`);
      }
      assert.ok(view.screen <= view.room + 0.5 && view.room - view.screen < Math.max(view.cell, 12), `${label}: the grid fills the pane and stays inside it (${view.screen} of ${view.room})`);
      console.log("ok", label);
      await cdp.send("Input.imeSetComposition", { text: "", selectionStart: 0, selectionEnd: 0 }).catch(() => {});
      await ctx.close();
    }
    await herdrRpc("pane.send_text", { pane_id: ws.root_pane.pane_id, text: "clear\r" });
    await herdrRpc("pane.send_text", { pane_id: ws.root_pane.pane_id, text: "x".repeat(31) });
    {
      const ctx = await browser.newContext({ viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2.625, locale: "ja-JP" });
      await ctx.addInitScript(() => localStorage.setItem("ovis:settings", JSON.stringify({ language: "en", terminalInputMode: "direct" })));
      const page = await ctx.newPage();
      await page.goto(`${origin}/?pane=${encodeURIComponent(ws.root_pane.pane_id)}`);
      await page.locator(shownRows()).first().waitFor();
      await page.waitForFunction((rows) => document.querySelector(rows)?.textContent?.includes("x".repeat(31)) ?? false, shownRows(), { timeout: 15_000 });
      const cdp = await ctx.newCDPSession(page);
      await page.locator(".xterm-helper-textarea").focus();
      const word = "あああああああああかさたなはまや";
      for (let i = 1; i <= word.length; i++) await cdp.send("Input.imeSetComposition", { text: word.slice(0, i), selectionStart: i, selectionEnd: i });
      await page.waitForFunction((text) => document.querySelector(".composition-view.active")?.textContent === text, word, { timeout: 10_000 });
      const screen = await page.evaluate(() => {
        const { left, right } = document.querySelector(".xterm-screen")!.getBoundingClientRect();
        return { left, right, host: document.querySelector<HTMLElement>(".pane-terminal")!.scrollLeft };
      });
      const glyphs = await page.evaluate(compositionGlyphs);
      if (out) await page.screenshot({ path: `${out}/composition-412-direct-japanese.png` });
      const label = "412 direct Japanese after 31 typed characters";
      assert.equal(screen.host, 0, `${label}: the terminal is not pushed sideways (${screen.host})`);
      assert.ok(glyphs && glyphs.left >= screen.left - 1 && glyphs.right <= screen.right + 1, `${label}: the composition stays inside the grid (${JSON.stringify(glyphs)}, ${JSON.stringify(screen)})`);
      assert.ok(glyphs.first.left >= glyphs.left - 1 && glyphs.last.right <= glyphs.right + 1, `${label}: the whole composition is in view (${JSON.stringify(glyphs)})`);
      console.log("ok", label);
      await cdp.send("Input.imeSetComposition", { text: "", selectionStart: 0, selectionEnd: 0 }).catch(() => {});
      await ctx.close();
    }
    console.log("PASS a long composition never pushes the terminal sideways and the grid fills the pane, at 412 and 720, Input line and Direct typing, default and bundled font, and its newest characters stay in view");
  } finally {
    await workspaceClose(ws.workspace.workspace_id).catch(() => {});
    rmSync(root, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  await import("./test-herdr.ts");
  const { chromium } = await import("playwright-core");
  const { createServer } = await import("../server/index.ts");
  const { UsageService } = await import("../server/usage.ts");
  const state = mkdtempSync(join(tmpdir(), "ovis-composition-state-"));
  let server: ReturnType<typeof createServer> | undefined;
  let browser: Browser | undefined;
  try {
    server = createServer({ port: 0, hostname: "127.0.0.1", token: "", stateDir: state, usage: new UsageService(undefined, []) });
    browser = await chromium.launch({ executablePath: chromePath(), headless: true, args: ["--no-sandbox"] });
    await checkTerminalComposition(browser, `http://127.0.0.1:${server.port}`);
  } finally {
    await browser?.close();
    server?.stop();
    rmSync(state, { recursive: true, force: true });
  }
}
