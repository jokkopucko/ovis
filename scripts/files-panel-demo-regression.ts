import assert from "node:assert/strict";
import { join } from "node:path";
import type { Browser, Page } from "playwright-core";
import panes from "../site/demo/fixtures/panes.json";
import { appContext } from "./app-context.ts";
import { withDemoBrowser } from "./demo-browser.ts";

// All files and HTTP traffic stay in this disposable, loopback-only app; no herdr session is opened.
const evidence = process.env.UI_EVIDENCE_DIR;

const FILES_SCRIPT = `<script>(${(() => {
  const demoFetch = window.fetch;
  window.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input), window.location.href);
    if (url.pathname.endsWith("/workspace/directories") && (init?.method ?? "GET") === "GET") {
      if (url.pathname.includes("/machines/laptop/")) return Response.json({ path: "/home/laptop", parent: "/home", home: "/home/laptop", directories: [], truncated: false, files: [{ name: "LAPTOP_ONLY.txt", size: 8 }] });
      const listing = await (await demoFetch(input, init)).json();
      return Response.json({ ...listing, files: [{ name: "README.md", size: 64 }, { name: "package.json", size: 120 }] });
    }
    if ((url.searchParams.get("path") ?? "").endsWith("README.md")) {
      const text = "# Demo\n\nA file opened from Files.\n";
      if (url.pathname.endsWith("/fs/stat")) return Response.json({ path: url.searchParams.get("path"), name: "README.md", kind: "text", mime: "text/markdown", size: text.length });
      if (url.pathname.endsWith("/fs/file")) return new Response(text, { headers: { "content-type": "text/markdown" } });
    }
    return demoFetch(input, init);
  };
}).toString()})();</script>`;

async function open(browser: Browser, width: number, settings: Record<string, unknown>, query = ""): Promise<{ page: Page; errors: string[]; close: () => Promise<void> }> {
  const phone = width <= 480;
  const context = await appContext(browser, { viewport: { width, height: phone ? 844 : 900 }, hasTouch: phone, isMobile: phone });
  const { filesPanel, ...main } = settings;
  await context.addInitScript(([value, panel]) => {
    if (localStorage.getItem("ovis:settings") !== null) return;
    localStorage.setItem("ovis:settings", value!);
    if (panel !== "") localStorage.setItem("ovis:files-panel", panel!);
  }, [JSON.stringify({ language: "en", ...main }), filesPanel === undefined ? "" : JSON.stringify(filesPanel)]);
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${origin}/herdr-web-ui/demo/app/?pane=${encodeURIComponent(panes.web)}&view=chat${query}`);
  await page.locator(".conn-live").waitFor({ state: "attached" });
  return { page, errors, close: () => context.close() };
}

const shot = async (page: Page, name: string): Promise<void> => {
  if (evidence) await page.screenshot({ path: join(evidence, `${name}.png`) });
};

async function desktop(browser: Browser, theme: "light" | "dark"): Promise<void> {
  {
    const { page, errors, close } = await open(browser, 1280, { theme });
    try {
      await page.locator(".header-files-button").click();
      await page.locator(".modal-scrim .files-dialog").waitFor();
      assert.equal(await page.locator("aside.files-panel").count(), 0);
      assert.equal(await page.locator(".header-files-button").getAttribute("aria-pressed"), null);
      await shot(page, `files-dialog-1280-${theme}`);
      assert.deepEqual(errors, []);
    } finally { await close(); }
  }
  const { page, errors, close } = await open(browser, 1280, { theme, filesPanel: true, fileOpen: "panel" });
  try {
    const button = page.locator(".header-files-button");
    await button.click();
    const panel = page.locator("aside.files-panel");
    await panel.waitFor();
    await panel.getByText("README.md").waitFor();
    assert.equal(await page.locator(".modal-scrim").count(), 0, "no dialog covers the pane");
    assert.equal(await button.getAttribute("aria-pressed"), "true");
    const box = (await panel.boundingBox())!;
    const pane = (await page.locator("main").first().boundingBox())!;
    assert.ok(Math.abs(box.x + box.width - 1280) <= 1, `the panel ends at the window's right edge (${box.x + box.width})`);
    assert.ok(pane.x + pane.width <= box.x + 1, `the pane ends where the panel starts (${pane.x + pane.width} vs ${box.x})`);
    await shot(page, `files-panel-1280-${theme}`);

    await page.locator("main").first().click({ position: { x: 40, y: 200 } });
    await page.keyboard.press("Escape");
    assert.equal(await panel.count(), 1, "Escape outside the panel leaves it open");

    await panel.getByRole("button", { name: "Parent folder" }).click();
    await panel.getByText("~/.herdr/worktrees/checkout-api", { exact: true }).waitFor();
    await panel.getByText("README.md").click();
    const viewer = page.locator("aside.file-panel .file-viewer-docked");
    await viewer.waitFor();
    assert.equal(await panel.isVisible(), false, "the file has the panel's place");
    assert.equal(await button.getAttribute("aria-pressed"), "false");
    await shot(page, `files-panel-file-1280-${theme}`);
    await viewer.getByRole("button", { name: "Close" }).click();
    await panel.waitFor();
    await panel.getByText("~/.herdr/worktrees/checkout-api", { exact: true }).waitFor();

    await panel.getByText("README.md").click();
    await viewer.waitFor();
    await page.keyboard.press("ControlOrMeta+Shift+K");
    const palette = page.getByRole("dialog", { name: "Command palette", exact: true });
    await palette.getByRole("searchbox", { name: "Search panes and actions", exact: true }).fill("Browse files");
    await palette.getByRole("option", { name: "Browse files" }).click();
    await viewer.waitFor({ state: "detached" });
    await panel.getByText("~/.herdr/worktrees/checkout-api", { exact: true }).waitFor();

    await page.evaluate(() => (window as unknown as { __herdrDemoOrder: { addPc: () => string } }).__herdrDemoOrder.addPc());
    await page.locator(`[data-machine="laptop"][data-pane="${panes.web}"]`).first().click();
    await panel.getByText("LAPTOP_ONLY.txt").waitFor();
    assert.equal(await panel.getByText("README.md").count(), 0, "no row of the last PC's folder is left");

    await button.click();
    await panel.waitFor({ state: "detached" });
    assert.equal(await button.getAttribute("aria-pressed"), "false");
    assert.deepEqual(errors, []);
    console.log(`PASS 1280px ${theme}: dialog by default; beside the pane when on, a docked file over it and back`);
  } finally { await close(); }
}

async function phone(browser: Browser, theme: "light" | "dark"): Promise<void> {
  {
    const { page, errors, close } = await open(browser, 390, { theme }, "&settings=chat&section=file-viewer-more");
    try {
      const toggle = page.getByRole("switch", { name: "Files beside the pane" });
      await toggle.scrollIntoViewIfNeeded();
      assert.equal(await toggle.getAttribute("aria-checked"), "false", "off by default");
      await shot(page, `files-panel-setting-390-${theme}`);
      assert.deepEqual(errors, []);
    } finally { await close(); }
  }
  const { page, errors, close } = await open(browser, 390, { theme, filesPanel: true });
  try {
    await page.locator(".header-more-button").click();
    await page.getByText("Browse files", { exact: true }).click();
    await page.locator(".modal-scrim .files-dialog").waitFor();
    // the menu's sheet drops while the Files sheet rises: the picture waits for both to land
    await page.waitForFunction(() => document.getAnimations().every((animation) => animation.playState !== "running"));
    await page.getByText("package.json").waitFor();
    assert.equal(await page.locator("aside.files-panel").count(), 0);
    await shot(page, `files-dialog-390-${theme}`);
    assert.deepEqual(errors, []);
    console.log(`PASS 390px ${theme}: the setting is off by default, and Files stays a sheet when it is on`);
  } finally { await close(); }
}

let origin = "";
await withDemoBrowser({ tempPrefix: "ovis-files-panel-demo-", afterTransport: FILES_SCRIPT }, async ({ browser, origin: served }) => {
  origin = served;
  for (const theme of ["light", "dark"] as const) {
    await desktop(browser, theme);
    await phone(browser, theme);
  }
});
