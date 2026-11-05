import "./test-herdr.ts";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Browser, Page } from "playwright-core";
import { chromePath } from "./chrome-path.ts";
import { openSettingsPage } from "./settings-page.ts";

/**
 * Two tabs of one browser share its device settings (#2485): a save in one tab writes only what it
 * changed, so it keeps a change the other tab made after it loaded.
 */
export async function checkSettingsAcrossTabs(browser: Browser, origin: string): Promise<void> {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: "en-US" });
  try {
    await context.addInitScript(() => {
      if (localStorage.getItem("ovis:settings") === null) localStorage.setItem("ovis:settings", JSON.stringify({ language: "en" }));
    });
    const errors: string[] = [];
    const open = async (): Promise<Page> => {
      const page = await context.newPage();
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(origin);
      await page.locator(".conn-live").waitFor();
      return page;
    };
    const settingsOf = (page: Page) => page.evaluate(() => ({
      chatWidth: document.documentElement.dataset["chatWidth"],
      composerArtifacts: localStorage.getItem("ovis:composer-artifacts"),
      terminalFontSize: (JSON.parse(localStorage.getItem("ovis:settings") ?? "{}") as { terminalFontSize?: number }).terminalFontSize,
    }));
    const tabA = await open();
    const tabB = await open();

    // tab A: Chat width Wide and the Artifacts chip on
    await tabA.bringToFront();
    await tabA.keyboard.press("ControlOrMeta+Shift+Comma");
    await openSettingsPage(tabA, "Chat");
    await tabA.getByRole("group", { name: "Chat width", exact: true }).getByRole("button", { name: "Wide", exact: true }).click();
    await tabA.getByRole("switch", { name: "Artifacts chip", exact: true }).click();
    await tabA.waitForFunction(() => document.documentElement.dataset["chatWidth"] === "wide" && localStorage.getItem("ovis:composer-artifacts") === "true");
    const fontBefore = (await settingsOf(tabB)).terminalFontSize;
    assert.equal(typeof fontBefore, "number", "tab A's save stored a font size");

    // tab B, open since before that change: an unrelated setting
    await tabB.bringToFront();
    await tabB.keyboard.press("ControlOrMeta+Shift+Comma");
    await openSettingsPage(tabB, "Terminal");
    await tabB.getByRole("button", { name: "Increase terminal font size", exact: true }).click();
    await tabB.waitForFunction((before) => {
      const size = (JSON.parse(localStorage.getItem("ovis:settings") ?? "{}") as { terminalFontSize?: number }).terminalFontSize;
      return size === before! + 1;
    }, fontBefore);
    const font = (await settingsOf(tabB)).terminalFontSize;

    // a reload of tab B, and a tab opened now, start with both changes
    await tabB.reload();
    await tabB.locator(".conn-live").waitFor();
    const fresh = await open();
    for (const [name, page] of [["reloaded tab B", tabB], ["a new tab", fresh]] as const) {
      assert.deepEqual(await settingsOf(page), { chatWidth: "wide", composerArtifacts: "true", terminalFontSize: font }, `${name} keeps tab A's Chat width and Artifacts chip and tab B's font size`);
    }
    assert.deepEqual(errors, []);
    console.log("PASS a tab's settings save keeps another tab's change");
  } finally {
    await context.close();
  }
}

// Also runnable on its own through `bun run check run --build bun scripts/settings-tabs-regression.ts`.
if (import.meta.main) {
  const { chromium } = await import("playwright-core");
  const { createServer } = await import("../server/index.ts");
  const { UsageService } = await import("../server/usage.ts");
  const stateDir = mkdtempSync(join(tmpdir(), "ovis-settings-tabs-"));
  let server: ReturnType<typeof createServer> | undefined;
  let browser: Browser | undefined;
  try {
    server = createServer({ port: 0, hostname: "127.0.0.1", token: "", stateDir, usage: new UsageService(undefined, []) });
    browser = await chromium.launch({ executablePath: chromePath(), headless: true, args: ["--no-sandbox", "--accept-lang=en-US"] });
    await checkSettingsAcrossTabs(browser, `http://127.0.0.1:${server.port}`);
  } finally {
    try {
      await browser?.close();
    } finally {
      try {
        server?.stop();
      } finally {
        rmSync(stateDir, { recursive: true, force: true });
      }
    }
  }
}
