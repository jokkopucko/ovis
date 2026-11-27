/**
 * Chromium's own Back skips every entry of a page that added one with no tap since the user's last
 * Back or Forward, which leaves the app with the surface still up, and a script cannot press that
 * button. So each entry the app adds is counted with the taps since the user last moved in the
 * history (a step the page takes by itself ends nothing: Chromium counts a tap through it): none
 * may be added with no tap behind it.
 */
import assert from "node:assert/strict";
import { join } from "node:path";
import type { Browser, Page } from "playwright-core";
import panes from "../site/demo/fixtures/panes.json";
import { appContext } from "./app-context.ts";
import { withDemoBrowser } from "./demo-browser.ts";
import { openSettingsPage } from "./settings-page.ts";

type Screen = { label: string; width: number; height: number };
type Entry = { taps: number; keys: string };

const UPRIGHT: Screen = { label: "upright", width: 390, height: 844 };
const ON_ITS_SIDE: Screen = { label: "on its side", width: 844, height: 390 };
const TABLET: Screen = { label: "a tablet", width: 1180, height: 820 };

const evidence = process.env["UI_EVIDENCE_DIR"];
const keep = async (page: Page, name: string): Promise<void> => { if (evidence) await page.screenshot({ path: join(evidence, `phone-back-${name}.png`) }); };

async function open(browser: Browser, origin: string, screen: Screen, run: (page: Page, entries: Entry[]) => Promise<void>, settings: Record<string, string> = {}, navigationApi = true, pane = panes.api): Promise<void> {
  const context = await appContext(browser, { viewport: { width: screen.width, height: screen.height }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  const entries: Entry[] = [];
  try {
    if (!navigationApi) await context.addInitScript(() => { delete (window as unknown as { navigation?: unknown }).navigation; });
    // the blank page the app is reached from, and left for, has no storage
    await context.addInitScript((saved) => { if (location.protocol !== "about:") localStorage.setItem("ovis:settings", JSON.stringify({ language: "en", ...saved })); }, settings);
    await context.exposeBinding("entryAdded", (_source, entry: Entry) => { entries.push(entry); });
    await context.addInitScript(() => {
      let taps = 0;
      const push = history.pushState.bind(history);
      history.pushState = (...args: Parameters<History["pushState"]>) => {
        const state: unknown = args[0];
        if (location.protocol !== "about:") void (window as unknown as { entryAdded: (entry: Entry) => Promise<void> }).entryAdded({ taps, keys: state !== null && typeof state === "object" ? Object.keys(state).join(",") : String(state) });
        return push(...args);
      };
      // a step the page takes by itself lands as a popstate too, and is none of the user's
      let own = false;
      for (const name of ["back", "forward", "go"] as const) {
        const step = (history[name] as (by?: number) => void).bind(history);
        (history as unknown as Record<string, (by?: number) => void>)[name] = (by) => { own = true; step(by); };
      }
      const navigation = (window as unknown as { navigation?: { traverseTo: (key: string) => unknown } }).navigation;
      if (navigation) {
        const traverse = navigation.traverseTo.bind(navigation);
        navigation.traverseTo = (key) => { own = true; return traverse(key); };
      }
      addEventListener("popstate", () => { if (own) own = false; else taps = 0; }, true);
      for (const type of ["pointerup", "touchend", "keydown"]) addEventListener(type, (event) => { if (event.isTrusted) taps += 1; }, true);
    });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto("about:blank");
    await page.goto(`${origin}/?pane=${encodeURIComponent(pane)}`);
    await page.locator(".conn-live").waitFor();
    assert.equal(await page.evaluate(() => (window as unknown as { navigation?: unknown }).navigation !== undefined), navigationApi, `${screen.label}: the browser's Navigation API is ${navigationApi ? "there" : "taken away"}`);
    await run(page, entries);
    assert.deepEqual(errors, [], `${screen.label}: no page errors`);
    assert.deepEqual(entries.filter((entry) => entry.taps === 0), [], `${screen.label}: no history entry is added with no tap since the page last moved in its history`);
  } finally { await context.close(); }
}

const entryHeld = (page: Page): Promise<unknown> => page.waitForFunction(() => typeof (history.state as Record<string, unknown> | null)?.["ovis:sheet"] === "string");
const drawerOpen = (page: Page): Promise<unknown> => page.locator("#workspace-drawer.is-open").waitFor();
const drawerClosed = (page: Page): Promise<unknown> => page.locator("#workspace-drawer.is-open").waitFor({ state: "detached" });
const paneShown = (page: Page): Promise<string | null> => page.evaluate(() => new URLSearchParams(location.search).get("pane"));

async function back(page: Page): Promise<void> {
  await page.goBack({ waitUntil: "commit" });
}

async function stillHere(page: Page, origin: string, shown: string | null, label: string): Promise<void> {
  assert.ok(page.url().startsWith(origin), `${label}: Back stayed in the app (${page.url()})`);
  assert.equal(await paneShown(page), shown, `${label}: the pane shown is the one it was`);
}

await withDemoBrowser({ tempPrefix: "ovis-phone-back-demo-", prefix: "/" }, async ({ browser, origin }) => {
  const pages = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("<!doctype html><title>Report</title><h1>Report</h1>", { headers: { "content-type": "text/html; charset=utf-8" } }) });
  try {
    await open(browser, origin, UPRIGHT, async (page) => {
      const shown = await paneShown(page);
      await page.locator(".drawer-toggle").tap();
      await drawerOpen(page);
      await entryHeld(page);
      await keep(page, "drawer-open");
      await back(page);
      await drawerClosed(page);
      await stillHere(page, origin, shown, "the drawer");
      await keep(page, "drawer-after-back");
      await back(page);
      await page.waitForURL("about:blank");
    });

    await open(browser, origin, UPRIGHT, async (page) => {
      const shown = await paneShown(page);
      await page.locator(".drawer-toggle").tap();
      await drawerOpen(page);
      await page.getByRole("button", { name: "More for checkout-api" }).tap();
      const menu = page.locator(".row-sheet");
      await menu.waitFor();
      await entryHeld(page);
      await back(page);
      await menu.waitFor({ state: "detached" });
      assert.equal(await page.locator("#workspace-drawer.is-open").count(), 1, "a row's menu over the drawer: Back closes the menu and leaves the drawer");
      await entryHeld(page);
      await back(page);
      await drawerClosed(page);
      await stillHere(page, origin, shown, "the drawer under a menu");
    });

    await open(browser, origin, UPRIGHT, async (page) => {
      const shown = await paneShown(page);
      const dialog = page.locator(".new-session-modal");
      const openDialog = async (): Promise<void> => {
        await page.locator(".drawer-toggle").tap();
        await drawerOpen(page);
        await page.locator(".machine-list .machine-new-row").tap();
        await dialog.waitFor();
        await entryHeld(page);
      };
      await openDialog();
      await back(page);
      await dialog.waitFor({ state: "detached" });
      await stillHere(page, origin, shown, "New workspace from the drawer");

      await openDialog();
      await dialog.locator(".agent-picker-trigger").tap();
      const list = page.locator(".agent-picker-menu");
      await list.waitFor();
      await back(page);
      await list.waitFor({ state: "detached" });
      assert.equal(await dialog.count(), 1, "the agent list in New workspace: Back closes the list and leaves the dialog");
      await entryHeld(page);

      await dialog.getByRole("button", { name: "Browse", exact: true }).tap();
      const folders = dialog.locator(".dir-browser");
      await folders.waitFor();
      await back(page);
      await folders.waitFor({ state: "detached" });
      assert.equal(await dialog.count(), 1, "the folder browser in New workspace: Back closes it and leaves the dialog");
      await entryHeld(page);

      await back(page);
      await dialog.waitFor({ state: "detached" });
      await stillHere(page, origin, shown, "New workspace after its list and its folder browser");
    });

    await open(browser, origin, UPRIGHT, async (page) => {
      const shown = await paneShown(page);
      await page.locator(".header-more-button").tap();
      const sheet = page.locator(".row-sheet");
      await sheet.waitFor();
      await entryHeld(page);
      await back(page);
      await sheet.waitFor({ state: "detached" });
      await stillHere(page, origin, shown, "the header's More sheet");

      await page.locator(".header-more-button").tap();
      const findGroup = sheet.getByRole("button", { name: "Find…" });
      const findItem = sheet.getByRole("button", { name: "Find in terminal" });
      await findGroup.or(findItem).first().waitFor();
      if (await findGroup.count() > 0) await findGroup.tap();
      await page.locator(".row-sheet").getByRole("button", { name: "Find in terminal" }).tap();
      const find = page.locator(".find-bar");
      await find.waitFor();
      await entryHeld(page);
      await back(page);
      await find.waitFor({ state: "detached" });
      await stillHere(page, origin, shown, "the terminal's find bar");
      assert.equal(await page.locator(".pane-column.is-chat").count(), 0, "the terminal's find bar: Back closes the bar and leaves the terminal shown");
      await page.locator(".lens-toggle").tap();
      await page.locator(".pane-column.is-chat").waitFor();

      await page.locator(".drawer-toggle").tap();
      await drawerOpen(page);
      await page.locator(".sidebar .workspace-select", { hasText: "flaky-retry-test" }).first().tap();
      await drawerClosed(page);
      await page.waitForFunction((pane) => new URLSearchParams(location.search).get("pane") === pane, panes.flaky);
      const moved = await paneShown(page);
      await page.locator(".drawer-toggle").tap();
      await drawerOpen(page);
      await entryHeld(page);
      await back(page);
      await drawerClosed(page);
      await stillHere(page, origin, moved, "the drawer over a pane opened after another");
    });

    await open(browser, origin, UPRIGHT, async (page) => {
      const shown = await paneShown(page);
      await page.locator(".header-more-button").tap();
      await page.getByRole("dialog", { name: "More", exact: true }).getByRole("button", { name: "Browse files", exact: true }).tap();
      const files = page.getByRole("dialog", { name: "Files", exact: true });
      await files.getByRole("button", { name: "Documents", exact: true }).tap();
      await files.locator(".md-docs-item").first().tap();
      const viewer = page.locator(".modal.file-viewer");
      await viewer.waitFor();
      await viewer.getByRole("button", { name: "Close file", exact: true }).tap();
      await viewer.waitFor({ state: "detached" });
      assert.equal(await files.count(), 1, "a file closed by its X leaves Files up under it");
      await entryHeld(page);
      await back(page);
      await files.waitFor({ state: "detached" });
      await stillHere(page, origin, shown, "Files after a file closed by its X");
    });

    // the same file closed by Back: Files is in front again with no tap since, where the browser's
    // Back would skip an entry made now.
    await open(browser, origin, UPRIGHT, async (page) => {
      const shown = await paneShown(page);
      await page.locator(".header-more-button").tap();
      await page.getByRole("dialog", { name: "More", exact: true }).getByRole("button", { name: "Browse files", exact: true }).tap();
      const files = page.getByRole("dialog", { name: "Files", exact: true });
      await files.getByRole("button", { name: "Documents", exact: true }).tap();
      await files.locator(".md-docs-item").first().tap();
      const viewer = page.locator(".modal.file-viewer");
      await viewer.waitFor();
      await back(page);
      await viewer.waitFor({ state: "detached" });
      assert.equal(await files.count(), 1, "a file closed by Back leaves Files up under it");
      await entryHeld(page);
      await page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
      assert.equal(await viewer.count(), 0, "the entry Files takes after Back does not bring its file back");
      await keep(page, "files-after-file-back");
      await back(page);
      await files.waitFor({ state: "detached" });
      await stillHere(page, origin, shown, "Files after Back closed a file opened from it");
    });

    await open(browser, origin, UPRIGHT, async (page) => {
      const shown = await paneShown(page);
      await page.locator(".drawer-toggle").tap();
      await drawerOpen(page);
      await page.locator(".sidebar-footer-settings").tap();
      const settings = page.locator(".settings-dialog");
      await openSettingsPage(page, "Devices and PCs");
      await settings.getByRole("button", { name: "Add a connection", exact: true }).tap();
      const connect = page.getByRole("dialog", { name: "Add a connection", exact: true });
      await connect.locator('.connect-tabs [data-tab="ssh"]').tap();
      await connect.getByLabel("Add another PC from this one", { exact: true }).fill("qa@pc.invalid");
      await connect.locator(".connect-ssh-form").getByRole("button", { name: "Connect", exact: true }).tap();
      const addPc = page.locator("dialog.machine-dialog");
      await addPc.waitFor();
      await settings.waitFor({ state: "detached" });
      await entryHeld(page);
      assert.equal(new URL(page.url()).searchParams.has("settings"), false, "Add PC opened from Settings: the address is the pane's, not a Settings page's");
      await keep(page, "add-pc-from-settings");
      await back(page);
      await addPc.waitFor({ state: "detached" });
      await stillHere(page, origin, shown, "Add PC opened from Settings");
      assert.equal(await settings.count(), 0, "Add PC opened from Settings: Back closes Add PC and does not bring Settings back");
      await back(page);
      await page.waitForURL("about:blank");
    });

    await open(browser, origin, ON_ITS_SIDE, async (page) => {
      const shown = await paneShown(page);
      await page.locator(".header-more-button").tap();
      const menu = page.locator(".row-menu");
      await menu.waitFor();
      await entryHeld(page);
      await keep(page, "on-its-side-menu");
      await back(page);
      await menu.waitFor({ state: "detached" });
      await stillHere(page, origin, shown, "a menu with the phone on its side");
    });

    await open(browser, origin, TABLET, async (page) => {
      const shown = await paneShown(page);
      assert.equal(await page.locator(".drawer-toggle").isVisible(), false, "a tablet keeps the sidebar beside the pane: there is no drawer");
      await page.locator('.sidebar [aria-label="More for checkout-api"]').tap();
      const menu = page.locator(".row-menu");
      await menu.waitFor();
      await entryHeld(page);
      await keep(page, "tablet-row-menu");
      await back(page);
      await menu.waitFor({ state: "detached" });
      await stillHere(page, origin, shown, "a row's menu on a tablet");
      await back(page);
      await page.waitForURL("about:blank");
    });

    // a busy tab's close asks first, even among other tabs: Back closes the question, and the tab is still there. On
    // the web pane, whose agent waits on its question for good, beside a new terminal, so the question comes from the
    // busy agent, not from a last tab: the api pane's turn ends 4.5 s after load (site/demo/transport.ts), and an idle
    // tab among others closes without asking
    await open(browser, origin, TABLET, async (page) => {
      const busyTab = await page.locator(".tab-strip-close").first().getAttribute("aria-label");
      assert.ok(busyTab, "the web pane's tab has a close button");
      await page.locator(".tab-strip-add").tap();
      await page.locator(".tab-strip-tab").nth(1).waitFor();
      const tabs = await page.locator(".tab-strip-tab").count();
      assert.equal(tabs, 2, "a tablet's busy tab among others: the web pane's tab and a new terminal");
      await page.locator(".tab-strip-tab").first().tap();
      await page.locator(".tab-strip-item.is-active").first().getByRole("button", { name: busyTab, exact: true }).waitFor();
      const here = await paneShown(page);
      await page.getByRole("button", { name: busyTab, exact: true }).tap();
      const confirm = page.locator(".confirm-dialog");
      await confirm.waitFor();
      await entryHeld(page);
      await back(page);
      await confirm.waitFor({ state: "detached" });
      await stillHere(page, origin, here, "a tab's close confirmation on a tablet");
      assert.equal(await page.locator(".tab-strip-tab").count(), tabs, "a tab's close confirmation on a tablet: Back closes the question and no tab");
    }, {}, true, panes.web);

    await open(browser, origin, TABLET, async (page) => {
      const shown = await paneShown(page);
      const files = page.getByRole("dialog", { name: "Files", exact: true });
      await page.locator(".header-files-button").tap();
      await files.getByRole("button", { name: "Documents", exact: true }).tap();
      await files.locator(".md-docs-item").first().tap();
      const viewer = page.locator(".modal.file-viewer");
      await viewer.waitFor();
      await back(page);
      await viewer.waitFor({ state: "detached" });
      assert.equal(await files.count(), 1, "a document over Files on a tablet: Back closes the document and leaves Files");
      await entryHeld(page);

      await files.getByRole("button", { name: "Changes", exact: true }).tap();
      await files.locator(".repo-change").first().tap();
      const diff = page.locator(".repo-diff-viewer");
      await diff.waitFor();
      await back(page);
      await diff.waitFor({ state: "detached" });
      assert.equal(await files.count(), 1, "a change over Files on a tablet: Back closes the diff and leaves Files");
      await entryHeld(page);
      await keep(page, "tablet-files-after-diff-back");
      await back(page);
      await files.waitFor({ state: "detached" });
      await stillHere(page, origin, shown, "Files on a tablet");
    });

    await open(browser, origin, TABLET, async (page) => {
      const shown = await paneShown(page);
      await page.locator(".header-more-button").tap();
      await page.locator(".row-menu").getByRole("menuitem", { name: "Search panes and actions" }).tap();
      const palette = page.getByRole("dialog", { name: "Command palette" });
      const search = palette.getByRole("searchbox");
      await search.fill(">open a page");
      await page.getByRole("option", { name: "Open a page on this PC…", exact: true }).tap();
      await search.pressSequentially(`${pages.port}/report`);
      await page.getByRole("option", { name: `Open localhost:${pages.port}/report`, exact: true }).waitFor();
      await search.press("Enter");
      const report = page.locator(".file-panel.web-panel");
      await page.frameLocator(".web-panel-page").getByRole("heading", { name: "Report" }).waitFor();
      await palette.waitFor({ state: "detached" });
      await page.waitForFunction(() => (history.state as Record<string, unknown> | null)?.["ovis:sheet"] === undefined);

      await page.locator('.sidebar [aria-label="More for checkout-api"]').tap();
      const menu = page.locator(".row-menu");
      await menu.waitFor();
      await entryHeld(page);
      await keep(page, "tablet-menu-over-web-page");
      await back(page);
      await menu.waitFor({ state: "detached" });
      await stillHere(page, origin, shown, "a menu over a web page beside the pane");
      assert.equal(await report.count(), 1, "a menu over a web page beside the pane: Back closes the menu and leaves the page");
      await page.frameLocator(".web-panel-page").getByRole("heading", { name: "Report" }).waitFor();
    }, { webLinks: "panel" });

    // a Chromium with no Navigation API (before 102) tells the app neither which entry the history is on nor
    // how to go onto one
    await open(browser, origin, UPRIGHT, async (page) => {
      const shown = await paneShown(page);
      await page.locator(".drawer-toggle").tap();
      await drawerOpen(page);
      await page.getByRole("button", { name: "More for checkout-api" }).tap();
      const menu = page.locator(".row-sheet");
      await menu.waitFor();
      await entryHeld(page);
      await back(page);
      await menu.waitFor({ state: "detached" });
      assert.equal(await page.locator("#workspace-drawer.is-open").count(), 1, "with no Navigation API, a row's menu over the drawer: Back closes the menu and leaves the drawer");
      await entryHeld(page);
      await back(page);
      await drawerClosed(page);
      await stillHere(page, origin, shown, "with no Navigation API, the drawer under a menu");

      await page.locator(".header-more-button").tap();
      await page.getByRole("dialog", { name: "More", exact: true }).getByRole("button", { name: "Browse files", exact: true }).tap();
      const files = page.getByRole("dialog", { name: "Files", exact: true });
      await files.getByRole("button", { name: "Documents", exact: true }).tap();
      await files.locator(".md-docs-item").first().tap();
      const viewer = page.locator(".modal.file-viewer");
      await viewer.waitFor();
      await back(page);
      await viewer.waitFor({ state: "detached" });
      assert.equal(await files.count(), 1, "with no Navigation API, a file closed by Back leaves Files up under it");
      await entryHeld(page);
      await back(page);
      await files.waitFor({ state: "detached" });
      await stillHere(page, origin, shown, "with no Navigation API, Files after Back closed a file opened from it");
    }, {}, false);
  } finally { await pages.stop(true); }
  console.log("PASS a phone's Back closes the drawer, a menu over it, New workspace and its lists one at a time, Files after a file closed by its X or by Back and Add PC opened as Settings closed, upright and on its side; a tablet's closes a menu, a confirmation, Files with a document or a diff over it and a menu over a page beside the pane; with no Navigation API a menu over the drawer and Files after a file closed by Back close the same; and no entry is added with no tap behind it");
});
