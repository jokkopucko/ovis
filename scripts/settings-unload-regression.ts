import "./test-herdr.ts";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Browser, Page } from "playwright-core";
import { chromePath } from "./chrome-path.ts";
import { openSettingsPage } from "./settings-page.ts";

/** Resolves once the server's event stream carries a preferences document with `showUsage` at `value` (it opens with the current one). */
async function serverHolds(origin: string, value: boolean, timeoutMs: number): Promise<void> {
  const response = await fetch(`${origin}/api/machines/events`, { signal: AbortSignal.timeout(timeoutMs) });
  assert.ok(response.ok && response.body, `the event stream opens (${response.status})`);
  const decoder = new TextDecoder();
  let buffered = "";
  try {
    for await (const chunk of response.body) {
      buffered += decoder.decode(chunk, { stream: true });
      const frames = buffered.split("\n\n");
      buffered = frames.pop() ?? "";
      for (const frame of frames) {
        const data = frame.split("\n").find((line) => line.startsWith("data: "));
        const event = data === undefined ? null : JSON.parse(data.slice(6)) as { type?: string; preferences?: { settings: { showUsage?: unknown } } };
        if (event?.type === "preferences" && event.preferences?.settings.showUsage === value) return;
      }
    }
  } finally {
    await response.body.cancel().catch(() => undefined);
  }
  assert.fail("the event stream ended before the server held the value");
}

/** A shared setting changed just before the page reloads reaches the server, and stays after the reload (#2374). */
export async function checkSettingSurvivesReload(browser: Browser, origin: string): Promise<void> {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: "en-US" });
  try {
    await context.addInitScript(() => {
      if (localStorage.getItem("ovis:settings") === null) localStorage.setItem("ovis:settings", JSON.stringify({ language: "en" }));
    });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const served = async (): Promise<unknown> => ((await (await fetch(`${origin}/api/preferences`)).json()) as { settings: { showUsage?: unknown } }).settings.showUsage;
    const shown = (target: Page) => target.evaluate(() => (JSON.parse(localStorage.getItem("ovis:settings") ?? "{}") as { showUsage?: boolean }).showUsage);
    await page.goto(origin);
    await page.locator(".conn-live").waitFor();
    await page.keyboard.press("ControlOrMeta+Shift+Comma");
    await openSettingsPage(page, "Agents");
    const toggle = page.getByRole("switch", { name: "Show plan limits", exact: true });

    // whatever an earlier check left: one value saved and let land, then the other and a reload at once
    const first = await toggle.getAttribute("aria-checked") !== "true";
    const onSaved = page.waitForResponse((response) => response.request().method() === "PUT" && new URL(response.url()).pathname === "/api/preferences"
      && response.ok() && response.request().postDataJSON()?.settings?.showUsage === first);
    await toggle.click();
    await onSaved;
    assert.equal(await served(), first, "the server holds the first value");

    await toggle.click();
    await page.waitForFunction((last) => (JSON.parse(localStorage.getItem("ovis:settings") ?? "{}") as { showUsage?: boolean }).showUsage === last, !first);
    await page.reload();
    await page.locator(".conn-live").waitFor();
    // the server holds the last value once the change sent on the way out lands, and the reloaded page takes it
    await serverHolds(origin, !first, 5_000);
    await page.waitForFunction((last) => (JSON.parse(localStorage.getItem("ovis:settings") ?? "{}") as { showUsage?: boolean }).showUsage === last, !first, { timeout: 5_000 });
    assert.equal(await served(), !first, "the server took the last value");
    assert.equal(await shown(page), !first, "the reloaded page keeps the last value");
    assert.deepEqual(errors, []);
    console.log("PASS a setting changed just before a reload is kept");
  } finally {
    await context.close();
  }
}

// Also runnable on its own through `bun run check run --build bun scripts/settings-unload-regression.ts`.
if (import.meta.main) {
  const { chromium } = await import("playwright-core");
  const { createServer } = await import("../server/index.ts");
  const { UsageService } = await import("../server/usage.ts");
  const stateDir = mkdtempSync(join(tmpdir(), "ovis-settings-unload-"));
  let server: ReturnType<typeof createServer> | undefined;
  let browser: Browser | undefined;
  try {
    server = createServer({ port: 0, hostname: "127.0.0.1", token: "", stateDir, usage: new UsageService(undefined, []) });
    browser = await chromium.launch({ executablePath: chromePath(), headless: true, args: ["--no-sandbox", "--accept-lang=en-US"] });
    await checkSettingSurvivesReload(browser, `http://127.0.0.1:${server.port}`);
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
