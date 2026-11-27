import assert from "node:assert/strict";
import { join } from "node:path";
import type { Browser, Page } from "playwright-core";
import panes from "../site/demo/fixtures/panes.json";
import { appContext } from "./app-context.ts";
import { withDemoBrowser } from "./demo-browser.ts";

// All files and HTTP traffic stay in this disposable, loopback-only app; no herdr session is opened.
const evidence = process.env.UI_EVIDENCE_DIR;

const ROOT = "/home/demo/.herdr/worktrees/checkout-api";
const LISTED = ["docs/plans/rollout-plan.md", "HANDOFF.md", "docs/review/report-2026-11-04.md", "README.md"];

const DOCS_SCRIPT = `<script>(${((root: string, listed: string[]) => {
  const demoFetch = window.fetch;
  const hour = 3_600_000;
  window.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input), window.location.href);
    if (url.pathname.endsWith("/pane/docs")) {
      return Response.json({ root, truncated: false, documents: listed.map((path, index) => ({ path, size: 400 + index, modified: new Date(Date.now() - (index * 30 + 5) * 60_000 - (index > 2 ? 72 * hour : 0)).toISOString() })) });
    }
    const asked = url.searchParams.get("path") ?? "";
    if (asked.startsWith(`${root}/`) && asked.endsWith(".md")) {
      const name = asked.slice(asked.lastIndexOf("/") + 1);
      const text = `# ${name}\n\nOpened from Documents.\n`;
      if (url.pathname.endsWith("/fs/stat")) return Response.json({ path: asked, name, kind: "text", mime: "text/markdown", size: text.length, modified: new Date().toISOString() });
      if (url.pathname.endsWith("/fs/file")) return new Response(text, { headers: { "content-type": "text/markdown" } });
    }
    return demoFetch(input, init);
  };
}).toString()})(${JSON.stringify(ROOT)}, ${JSON.stringify(LISTED)});</script>`;

async function open(browser: Browser, width: number, settings: Record<string, unknown>, query = ""): Promise<{ page: Page; errors: string[]; close: () => Promise<void> }> {
  const phone = width <= 480;
  const context = await appContext(browser, { viewport: { width, height: phone ? 844 : 900 }, hasTouch: phone, isMobile: phone });
  const { filesDocuments, filesPanel, filePanelWidth, ...main } = settings;
  await context.addInitScript(([value, documents, panel, panelWidth]) => {
    if (localStorage.getItem("ovis:settings") !== null) return;
    localStorage.setItem("ovis:settings", value!);
    if (documents !== "") localStorage.setItem("ovis:files-documents", documents!);
    if (panel !== "") localStorage.setItem("ovis:files-panel", panel!);
    if (panelWidth !== "") localStorage.setItem("ovis:file-panel-width", panelWidth!);
  }, [JSON.stringify({ language: "en", ...main }), filesDocuments === undefined ? "" : JSON.stringify(filesDocuments), filesPanel === undefined ? "" : JSON.stringify(filesPanel), filePanelWidth === undefined ? "" : String(filePanelWidth)]);
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

const rowTitles = (page: Page) => page.locator(".md-docs .md-docs-item").evaluateAll((rows) => rows.map((row) => row.getAttribute("title")));

async function exercise(page: Page, surface: string, theme: string): Promise<void> {
  const tabs = page.locator(".files-dialog-tabs");
  const header = await page.locator(".files-dialog .modal-header").evaluate((row) => row.scrollWidth - row.clientWidth);
  assert.ok(header <= 1, `the four tabs and Close fit the header (${header}px over)`);
  await tabs.getByRole("button", { name: "Documents", exact: true }).click();
  await page.locator(".md-docs .md-docs-item").first().waitFor();
  assert.deepEqual(await tabs.locator("button[aria-pressed='true']").allInnerTexts(), ["Documents"], "the tab shown is the one pressed");
  assert.deepEqual(await rowTitles(page), LISTED, "newest first, as the PC answered");
  assert.equal(await page.locator(".md-docs .dir-browser-path").innerText(), ROOT, "the folder listed is named");
  const overflow = await page.locator(".md-docs").evaluate((list) => list.scrollWidth - list.clientWidth);
  assert.ok(overflow <= 1, `the list does not scroll sideways (${overflow}px)`);
  // the tabs fade their background: the picture waits for the pressed one to land
  await page.waitForFunction(() => document.getAnimations().every((animation) => animation.playState !== "running"));
  await shot(page, `files-documents-${surface}-${theme}`);
  const filter = page.getByRole("searchbox", { name: "Filter documents" });
  await filter.fill("plan");
  assert.deepEqual(await rowTitles(page), ["docs/plans/rollout-plan.md"]);
  await filter.press("Escape");
  assert.equal(await filter.inputValue(), "");
  assert.deepEqual(await rowTitles(page), LISTED, "Escape clears the filter and keeps Files open");
  await page.locator(".md-docs .md-docs-item", { hasText: "HANDOFF.md" }).click();
  await page.getByRole("heading", { name: "HANDOFF.md" }).waitFor();
  await shot(page, `files-documents-file-${surface}-${theme}`);
}

async function desktop(browser: Browser, theme: "light" | "dark"): Promise<void> {
  {
    const { page, errors, close } = await open(browser, 1280, { theme, filesDocuments: false });
    try {
      await page.locator(".header-files-button").click();
      await page.locator(".modal-scrim .files-dialog").waitFor();
      assert.deepEqual(await page.locator(".files-dialog-tabs button").allInnerTexts(), ["Browse", "Changes", "Pull request", "Documents"]);
      assert.deepEqual(errors, []);
    } finally { await close(); }
  }
  {
    const { page, errors, close } = await open(browser, 1280, { theme });
    try {
      await page.locator(".header-files-button").click();
      await page.locator(".modal-scrim .files-dialog").waitFor();
      await exercise(page, "1280", theme);
      assert.deepEqual(errors, []);
    } finally { await close(); }
  }
  const { page, errors, close } = await open(browser, 1280, { theme, filesPanel: true, fileOpen: "panel", filePanelWidth: 320 });
  try {
    await page.locator(".header-files-button").click();
    await page.locator("aside.files-panel").waitFor();
    await exercise(page, "panel-1280", theme);
    assert.deepEqual(errors, []);
    console.log(`PASS 1280px ${theme}: the Documents tab, also with the old switch stored off; the list, its filter and a file opened, in the dialog and beside the pane`);
  } finally { await close(); }
}

async function phone(browser: Browser, theme: "light" | "dark"): Promise<void> {
  const { page, errors, close } = await open(browser, 390, { theme });
  try {
    const at = () => page.evaluate(() => (window as unknown as { navigation: { currentEntry: { index: number } } }).navigation.currentEntry.index);
    const paneEntry = await at();
    await page.locator(".header-more-button").click();
    await page.getByText("Browse files", { exact: true }).click();
    await page.locator(".modal-scrim .files-dialog").waitFor();
    // the menu's sheet drops while the Files sheet rises: the picture waits for both to land
    await page.waitForFunction(() => document.getAnimations().every((animation) => animation.playState !== "running"));
    await exercise(page, "390", theme);
    await page.keyboard.press("ControlOrMeta+Shift+K");
    await page.getByRole("dialog", { name: "Command palette" }).waitFor();
    await page.waitForFunction(() => typeof window.history.state?.["ovis:sheet"] === "string");
    await page.reload();
    await page.locator(".conn-live").waitFor({ state: "attached" });
    await page.getByRole("heading", { name: "HANDOFF.md" }).waitFor();
    await page.getByRole("button", { name: "Close file" }).click();
    await page.waitForFunction((index) => (window as unknown as { navigation: { currentEntry: { index: number } } }).navigation.currentEntry.index <= index, paneEntry, { timeout: 5_000 })
      .catch(async () => assert.fail(`closing the file after a reload under the palette goes back to the pane's entry (${paneEntry}), not ${await at()}`));
    await page.getByRole("heading", { name: "HANDOFF.md" }).waitFor({ state: "detached" });
    assert.equal(await page.evaluate(() => window.history.state?.["ovis:file-preview"]), undefined, "no entry of the file is left under the pane");
    assert.deepEqual(errors, []);
    console.log(`PASS 390px ${theme}: the four tabs fit and the list works on the sheet; closing a file after a reload under the palette goes back to the pane`);
  } finally { await close(); }
}

let origin = "";
await withDemoBrowser({ tempPrefix: "ovis-files-documents-demo-", afterTransport: DOCS_SCRIPT }, async ({ browser, origin: served }) => {
  origin = served;
  for (const theme of ["light", "dark"] as const) {
    await desktop(browser, theme);
    await phone(browser, theme);
  }
});
