import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Browser } from "playwright-core";
import { appContext } from "./app-context.ts";
import { sheetsSettled } from "./sheets-settled.ts";
import { openLens } from "./header-lens.ts";

type ViewportQA = Window & { viewportQA: { resize: (height: number) => void; pointer: (touch: boolean) => void } };

export async function checkMobileViewport(browser: Browser, origin: string, paneId: string): Promise<void> {
  const context = await appContext(browser, { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  try {
    await context.addInitScript(() => {
      if (localStorage.getItem("ovis:settings") === null) localStorage.setItem("ovis:settings", JSON.stringify({ terminalInputMode: "line" }));
      const viewport = window.visualViewport!;
      let height = 795; // a standalone app's idle visual viewport can exclude its status bar
      Object.defineProperty(viewport, "height", { get: () => height });
      const query = "(pointer: coarse)";
      let touch = true;
      const media = new EventTarget();
      Object.defineProperty(media, "matches", { get: () => touch });
      const matchMedia = window.matchMedia.bind(window);
      window.matchMedia = (value) => value === query ? media as MediaQueryList : matchMedia(value);
      (window as ViewportQA).viewportQA = {
        resize: (value) => { height = value; viewport.dispatchEvent(new Event("resize")); },
        pointer: (value) => { touch = value; media.dispatchEvent(new MediaQueryListEvent("change", { matches: value, media: query })); },
      };
    });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`${origin}/?pane=${encodeURIComponent(paneId)}`);
    await page.locator(".conn-live").waitFor();
    await openLens(page, "chat");
    const composer = page.getByRole("textbox", { name: "Message", exact: true });
    await composer.waitFor();
    // read in one step: the transcript's first node is replaced as the conversation loads, and a node
    // found before that and read after it is out of the document, with no style at all
    assert.equal(await page.evaluate(() => { const view = document.querySelector(".chat-view"); return view ? getComputedStyle(view).overscrollBehaviorY : "no .chat-view"; }), "contain",
      "a drag past the transcript's top stays in the transcript, or Android Chrome reloads the app");
    assert.deepEqual(await page.evaluate(() => [document.documentElement, document.body].map((node) => getComputedStyle(node).overscrollBehaviorY)),
      ["contain", "contain"], "a drag on a surface with nothing to scroll reaches the page, which Android Chrome before 144 reloads unless html and body contain it");
    const blur = () => page.evaluate(() => new Promise<void>((resolve) => {
      const active = document.activeElement;
      if (!(active instanceof HTMLElement) || active === document.body) { resolve(); return; }
      document.addEventListener("focusout", () => window.setTimeout(resolve, 0), { once: true });
      active.blur();
    }));
    const height = (value: number) => page.evaluate((value) => (window as ViewportQA).viewportQA.resize(value), value);
    const shell = async (keyboard: boolean, appHeight: string, pixels: number) => {
      try {
        await page.waitForFunction(({ keyboard, appHeight, pixels }) => {
          const root = document.documentElement;
          return root.hasAttribute("data-keyboard") === keyboard
            && root.style.getPropertyValue("--app-height") === appHeight
            && Math.round(document.querySelector(".app")!.getBoundingClientRect().height) === pixels;
        }, { keyboard, appHeight, pixels }, { timeout: 5_000 });
      } catch (cause) {
        const actual = await page.evaluate(() => ({ keyboard: document.documentElement.hasAttribute("data-keyboard"),
          appHeight: document.documentElement.style.getPropertyValue("--app-height"), pixels: document.querySelector(".app")?.getBoundingClientRect().height,
          active: document.activeElement?.className, touch: window.matchMedia("(pointer: coarse)").matches, visualHeight: window.visualViewport?.height }));
        throw new Error(`Viewport expected ${JSON.stringify({ keyboard, appHeight, pixels })}; observed ${JSON.stringify(actual)}`, { cause });
      }
    };

    await blur();
    await shell(false, "", 844);
    await height(780);
    await shell(false, "", 844);
    // focused with the keyboard down (back from a dictation app, or closed by its own key):
    // no keyboard sizing, so no status-bar band under the composer
    await composer.focus();
    await shell(false, "", 844);
    await height(500);
    await shell(true, "500px", 500);
    await height(795);
    await shell(false, "", 844);
    await height(500);
    await shell(true, "500px", 500);
    await page.evaluate(() => {
      const next = document.createElement("input");
      next.id = "qa-next-field";
      next.type = "password";
      document.body.append(next);
      next.focus();
    });
    await page.waitForTimeout(20);
    await shell(true, "500px", 500);
    await blur();
    // Focus loss alone does not dismiss the still-occluding keyboard.
    await shell(true, "500px", 500);
    await height(795);
    await shell(false, "", 844);
    await page.locator("#qa-next-field").evaluate((node) => node.remove());
    // WebKit need not report focusout when a focused field leaves the page with its pane:
    // the keyboard closing (a viewport resize) must still clear keyboard sizing.
    await page.evaluate(() => {
      const field = document.createElement("textarea");
      document.body.append(field);
      field.focus();
    });
    await height(500);
    await shell(true, "500px", 500);
    await page.evaluate(() => {
      const swallow = (event: Event) => event.stopImmediatePropagation();
      window.addEventListener("focusout", swallow, { capture: true });
      document.activeElement!.remove();
      window.removeEventListener("focusout", swallow, { capture: true });
    });
    await height(795);
    await shell(false, "", 844);
    await height(500);
    await page.setViewportSize({ width: 844, height: 390 });
    await height(365);
    await shell(false, "", 390);
    await page.setViewportSize({ width: 390, height: 844 });
    await height(500);

    await openLens(page, "terminal");
    const terminal = page.locator(".xterm-helper-textarea");
    await terminal.focus();
    await shell(false, "", 844);
    const direct = page.getByRole("button", { name: "Input line", exact: true });
    await direct.click();
    await page.locator("[data-direct-typing]").waitFor();
    await shell(true, "500px", 500);
    if (process.env.UI_EVIDENCE_DIR) {
      mkdirSync(process.env.UI_EVIDENCE_DIR, { recursive: true });
      await page.screenshot({ path: join(process.env.UI_EVIDENCE_DIR, "viewport-direct-typing.png") });
    }
    await direct.click();
    await shell(true, "500px", 500);
    assert.equal(await page.evaluate(() => document.activeElement?.className), "terminal-input-text", "direct to line with the keyboard up hands the focus to the line");
    await height(795);
    await shell(false, "", 844);
    await blur();
    await height(500);
    await shell(false, "", 844);
    await page.getByRole("textbox", { name: "Terminal input line", exact: true }).focus();
    await shell(true, "500px", 500);
    await blur();
    await shell(true, "500px", 500);
    await height(795);
    await shell(false, "", 844);

    await openLens(page, "chat");
    await composer.focus();
    await height(500);
    await shell(true, "500px", 500);
    await page.evaluate(() => (window as ViewportQA).viewportQA.pointer(false));
    await shell(true, "500px", 500);
    await height(795);
    await shell(false, "", 844);
    await height(500);
    await shell(false, "", 844);
    await page.evaluate(() => (window as ViewportQA).viewportQA.pointer(true));
    await shell(true, "500px", 500);
    await blur();
    await shell(true, "500px", 500);
    await height(795);
    await shell(false, "", 844);
    if (process.env.UI_EVIDENCE_DIR) await page.screenshot({ path: join(process.env.UI_EVIDENCE_DIR, "viewport-idle.png") });

    // A sheet with a text field ends where the keyboard begins: an iPhone home screen app keeps
    // the layout viewport at full height, so a sheet on its bottom edge would sit under the keyboard.
    assert.equal(await page.locator(".app-header .palette-button").isVisible(), false, "a phone's header has no palette button");
    await page.keyboard.press("ControlOrMeta+Shift+K");
    await page.getByRole("dialog", { name: "Command palette", exact: true }).waitFor();
    const search = page.locator(".palette-search input");
    await search.focus();
    await height(500);
    await shell(true, "500px", 500);
    const sheet = async () => {
      await sheetsSettled(page);
      return page.evaluate(() => {
        const edges = (selector: string) => { const r = document.querySelector(selector)!.getBoundingClientRect(); return { top: Math.round(r.top), bottom: Math.round(r.bottom) }; };
        return { scrim: edges(".modal-scrim"), palette: edges(".command-palette"), search: edges(".palette-search input") };
      });
    };
    for (const query of ["", "no pane or action is named like this"]) {
      await search.fill(query);
      const at = await sheet();
      assert.equal(at.scrim.bottom, 500, `the scrim ends at the keyboard (${JSON.stringify(at)})`);
      assert.ok(at.palette.top >= 0 && at.palette.bottom <= 500, `the palette is above the keyboard (${JSON.stringify(at)})`);
      assert.ok(at.search.top >= 0 && at.search.bottom <= 500, `its search field is above the keyboard (${JSON.stringify(at)})`);
    }
    if (process.env.UI_EVIDENCE_DIR) await page.screenshot({ path: join(process.env.UI_EVIDENCE_DIR, "viewport-sheet-keyboard.png") });
    await page.keyboard.press("Escape");
    await page.locator(".command-palette").waitFor({ state: "hidden" });
    await blur();
    await shell(true, "500px", 500);
    await height(795);
    await shell(false, "", 844);
    assert.deepEqual(errors, []);
    console.log("PASS viewport contract: idle, keyboard resize, field handoff, blur, rotation, xterm modes, pointer changes and a sheet above the keyboard");
  } finally { await context.close(); }
}

if (import.meta.main) {
  if (process.env.HERDR_TEST_MODE === "unit") throw new Error("HERDR_TEST_MODE=unit cannot run mobile viewport checks");
  const runner = Bun.spawn([process.execPath, join(import.meta.dir, "keyboard-viewport-demo-regression.ts")], {
    stdin: "inherit", stdout: "inherit", stderr: "inherit",
  });
  process.exitCode = await runner.exited;
}
