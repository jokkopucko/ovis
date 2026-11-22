/**
 * The terminal's inputs ask a phone keyboard for no word suggestions: the input line and xterm's
 * helper textarea say autocomplete="off" (with autocorrect, autocapitalize and spellcheck off), the
 * attribute Chrome on Android turns into TYPE_TEXT_FLAG_NO_SUGGESTIONS.
 */
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Browser } from "playwright-core";
import { workspaceClose, workspaceCreate } from "../server/herdr/client.ts";
import { chromePath } from "./chrome-path.ts";
import { openLens } from "./header-lens.ts";

export async function checkTerminalKeyboardSuggestions(browser: Browser, origin: string): Promise<void> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ovis-suggestions-")));
  let workspaceId: string | null = null;
  const context = await browser.newContext({ viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true, locale: "en-US" });
  try {
    const created = await workspaceCreate({ cwd: root, label: "ovis-test-suggestions" });
    workspaceId = created.workspace.workspace_id;
    await context.addInitScript(() => {
      localStorage.setItem("ovis:settings", JSON.stringify({ language: "en", terminalInputMode: "line" }));
    });
    const page = await context.newPage();
    await page.goto(`${origin}/?pane=${encodeURIComponent(created.root_pane.pane_id)}`);
    const line = page.locator(".terminal-input-text");
    await line.waitFor();
    for (const [name, field] of [["the input line", line], ["xterm's helper textarea", page.locator(".xterm-helper-textarea")]] as const) {
      await field.waitFor({ state: "attached" });
      const attributes = await field.evaluate((node) => Object.fromEntries(["autocomplete", "autocorrect", "autocapitalize", "spellcheck"].map((name) => [name, node.getAttribute(name)])));
      assert.deepEqual(attributes, { autocomplete: "off", autocorrect: "off", autocapitalize: "off", spellcheck: "false" }, `${name} asks the keyboard for no suggestions`);
    }
    await openLens(page, "chat");
    const composer = page.getByRole("textbox", { name: "Message", exact: true });
    await composer.waitFor();
    assert.notEqual(await composer.getAttribute("autocomplete"), "off", "the chat composer keeps its suggestions");
    console.log("PASS the terminal's input line and xterm's textarea ask the keyboard for no suggestions (autocomplete=off); the chat composer keeps them");
  } finally {
    await context.close();
    if (workspaceId) await workspaceClose(workspaceId).catch(() => {});
    rmSync(root, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  await import("./test-herdr.ts");
  const { chromium } = await import("playwright-core");
  const { createServer } = await import("../server/index.ts");
  const { UsageService } = await import("../server/usage.ts");
  const state = mkdtempSync(join(tmpdir(), "ovis-suggestions-state-"));
  const server = createServer({ port: 0, hostname: "127.0.0.1", token: "", stateDir: state, usage: new UsageService(undefined, []) });
  const browser = await chromium.launch({ executablePath: chromePath(), headless: true, args: ["--no-sandbox"] });
  try {
    await checkTerminalKeyboardSuggestions(browser, `http://127.0.0.1:${server.port}`);
  } finally {
    await browser.close();
    server.stop();
    rmSync(state, { recursive: true, force: true });
  }
}
