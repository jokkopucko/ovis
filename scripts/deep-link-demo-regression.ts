import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright-core";
import panes from "../site/demo/fixtures/panes.json";
import { buildDemoApp } from "./demo-build.ts";
import { DEMO_FILE_PREVIEW_SCRIPT } from "./demo-file-preview.ts";
import { chromePath } from "./chrome-path.ts";
import { openMoreGroup } from "./header-more.ts";

// Deep links (lib/deepLink.ts) on the unmodified app over the demo's fixture transport: an
// address names the PC, workspace, pane, lens and Settings page, opens there, and follows the app
// as it moves; Back and Forward walk the panes. All files and HTTP traffic stay in this
// disposable, loopback-only app; no herdr session is opened.
const app = mkdtempSync(join(tmpdir(), "herdr-deep-link-demo-"));
const INFRA = panes.omp;
const DOCS = panes.hermes;
const wsOf = (pane: string) => pane.split(":")[0]!;

const query = (page: Page) => page.evaluate(() => Object.fromEntries(new URLSearchParams(window.location.search)));
const selected = (page: Page) => page.locator('.agents-sidebar .agent-select[aria-current="true"]').evaluate((node) => node.closest(".agent-item")?.getAttribute("data-pane"));
const waitSelected = (page: Page, pane: string) => page.waitForFunction((id) => document.querySelector('.agents-sidebar .agent-select[aria-current="true"]')?.closest(".agent-item")?.getAttribute("data-pane") === id, pane, { timeout: 10_000 });
const waitQuery = (page: Page, name: string, value: string | null) => page.waitForFunction(([key, want]) => new URLSearchParams(window.location.search).get(key) === want, [name, value] as const, { timeout: 10_000 });

/** Opens `pane` from the sidebar, its resting group unfolded first. */
async function openPane(page: Page, pane: string): Promise<void> {
  const resting = page.locator(".agents-sidebar .agent-resting-label .agent-background-toggle");
  await resting.waitFor();
  if (await resting.getAttribute("aria-expanded") === "false") await resting.click();
  await page.locator(`.agents-sidebar .agent-item[data-pane="${pane}"] .agent-select`).click();
  await waitQuery(page, "pane", pane);
}

async function withPage(browser: Browser, search: string, run: (page: Page) => Promise<void>, settings: Record<string, unknown> = {}): Promise<void> {
  const context = await browser.newContext({ viewport: { width: 1280, height: 860 }, locale: "en-US" });
  try {
    await context.addInitScript((extra) => localStorage.setItem("ovis:settings", JSON.stringify({ language: "en", fileOpen: "panel", ...extra })), settings);
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`${url}${search}`);
    await page.locator(".conn-live").waitFor({ state: "attached" });
    // attached, not visible: a link can open with the sidebar collapsed
    await page.locator(".agents-sidebar .agent-item").first().waitFor({ state: "attached" });
    await run(page);
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
}

let url = "";
try {
  await buildDemoApp(app);
  const index = join(app, "index.html");
  const html = readFileSync(index, "utf8");
  assert.match(html, /<script type="module"/);
  writeFileSync(index, html.replace(/<script type="module"/, `<script src="./demo-transport.js"></script>${DEMO_FILE_PREVIEW_SCRIPT}\n    <script type="module"`));
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
  url = `http://127.0.0.1:${server.port}/herdr-web-ui/demo/app/`;

  try {
    const browser = await chromium.launch({ executablePath: chromePath(), headless: true, args: ["--no-sandbox"] });
    try {
      await withPage(browser, "?machine=removed&new=workspace&agent=codex", async (page) => {
        await page.locator(".header-note", { hasText: "That link's PC is not set up here" }).waitFor();
        assert.equal(await page.getByRole("dialog", { name: /New workspace/ }).count(), 0, "a creation link for an unknown PC never opens a local creation dialog");
      });
      await withPage(browser, `?pane=${encodeURIComponent(INFRA)}`, async (page) => {
        await waitSelected(page, INFRA);
        await page.evaluate(() => {
          const selected = JSON.stringify({ machine_id: "previous-PC", pane_id: "w1:p1" });
          sessionStorage.setItem("ovis:selection", selected);
          localStorage.setItem("ovis:selection", selected);
        });
        await page.goto(`${url}?new=workspace&agent=codex`);
        await page.getByRole("dialog", { name: "New workspace · workstation", exact: true }).waitFor();
        assert.equal((await query(page))["machine"], undefined, "a local creation link overrides the remembered PC without a pane or workspace");
      });
      console.log("PASS creation links honor their PC without a pane and never create on another PC when the target is missing");

      // a creation link on the PC already shown opens over its pane: Cancel leaves that pane, not herdr's focused one
      for (const pane of [INFRA, DOCS]) await withPage(browser, `?pane=${encodeURIComponent(pane)}`, async (page) => {
        await waitSelected(page, pane);
        await page.goto(`${url}?new=workspace&agent=codex`);
        const dialog = page.getByRole("dialog", { name: "New workspace · workstation", exact: true });
        await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
        await waitSelected(page, pane);
        await page.evaluate((here) => {
          history.pushState(null, "", "?new=workspace&agent=codex");
          history.pushState(null, "", here);
        }, await page.evaluate(() => location.search));
        await page.goBack();
        await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
        await waitSelected(page, pane);
      });
      console.log("PASS a creation link for the PC already shown keeps its pane, on load and on Back");

      // a link to a workspace opens the pane its row opens, and the address then names it all
      await withPage(browser, `?ws=${wsOf(INFRA)}`, async (page) => {
        await waitSelected(page, INFRA);
        await waitQuery(page, "pane", INFRA);
        const named = await query(page);
        assert.equal(named["ws"], `${wsOf(INFRA)}-cli-tools`, "ws names the workspace by id and slug");
        assert.ok(named["view"] === "chat" || named["view"] === "terminal", JSON.stringify(named));
        assert.equal(named["machine"], undefined, "the local PC is not written");
      });
      // a pane that has closed falls back to the pane its workspace's row opens
      await withPage(browser, `?ws=${wsOf(INFRA)}&pane=${encodeURIComponent(`${wsOf(INFRA)}:p99`)}&view=terminal`, async (page) => {
        await waitSelected(page, INFRA);
        await waitQuery(page, "pane", INFRA);
      });
      console.log("PASS a link to a workspace, or to a pane of it that has closed, opens the pane its row opens");

      // moving between panes is history; the lens is not; Back and Forward walk it
      await withPage(browser, `?ws=${wsOf(INFRA)}&pane=${encodeURIComponent(INFRA)}&view=chat`, async (page) => {
        await waitSelected(page, INFRA);
        assert.equal(await page.locator('.view-switch button[aria-pressed="true"]').innerText(), "Chat", "the linked lens is the one shown");
        const start = await page.evaluate(() => history.length);
        const resting = page.locator(".agents-sidebar .agent-resting-label .agent-background-toggle");
        await resting.waitFor();
        if (await resting.getAttribute("aria-expanded") === "false") await resting.click();
        await page.locator('.agents-sidebar .agent-resting-label .agent-background-toggle[aria-expanded="true"]').waitFor();
        await page.locator(`.agents-sidebar .agent-item[data-pane="${DOCS}"] .agent-select`).click();
        await waitQuery(page, "pane", DOCS);
        assert.equal(await page.evaluate(() => history.length), start + 1, "opening another pane is an entry");
        await page.locator(".view-switch button", { hasText: "Terminal" }).click();
        await waitQuery(page, "view", "terminal");
        assert.equal(await page.evaluate(() => history.length), start + 1, "a lens switch replaces the entry");
        await page.goBack();
        await waitSelected(page, INFRA);
        assert.equal((await query(page))["view"], "chat", "Back returns to the pane in the lens it was left in");
        await page.goForward();
        await waitSelected(page, DOCS);
        await waitQuery(page, "view", "terminal");
        assert.equal(await selected(page), DOCS);
      });
      console.log("PASS opening another pane is a history entry and a lens switch is not; Back and Forward return to each pane in its lens");

      // Back and Forward land on the entry's pane when a listener before the address bar's changes what
      // is shown (Settings closing, the file viewer's file leaving): React draws that before the entry
      // is read, and the place shown must not be written over the entry meanwhile.
      // A jump back from Settings past the entry it opened over (the browser's Back menu):
      await withPage(browser, `?ws=${wsOf(INFRA)}&pane=${encodeURIComponent(INFRA)}&view=chat`, async (page) => {
        await waitSelected(page, INFRA);
        await openPane(page, DOCS);
        const settings = page.getByRole("dialog", { name: "Settings" });
        await page.locator(".sidebar-footer-settings").click();
        await settings.waitFor();
        await page.waitForFunction(() => new URLSearchParams(window.location.search).has("settings"));
        const length = await page.evaluate(() => history.length);
        await page.evaluate(() => history.go(-2));
        await waitSelected(page, INFRA);
        await waitQuery(page, "pane", INFRA);
        await settings.waitFor({ state: "detached" });
        await page.goForward();
        await waitSelected(page, DOCS);
        await waitQuery(page, "pane", DOCS);
        assert.equal(await page.evaluate(() => history.length), length, "the jump and Forward kept every entry");
      });
      // Forward off a file's entry that a move left under it (Reopen files on return):
      await withPage(browser, `?ws=${wsOf(INFRA)}&pane=${encodeURIComponent(INFRA)}&file=README.md`, async (page) => {
        const panel = page.locator("aside.file-panel");
        await panel.locator(".file-viewer").waitFor();
        await waitQuery(page, "file", "README.md");
        await openPane(page, DOCS);
        await panel.waitFor({ state: "detached" });
        await page.goBack();
        await waitSelected(page, INFRA);
        await panel.locator(".file-viewer").waitFor();
        await page.goForward();
        await waitSelected(page, DOCS);
        await waitQuery(page, "pane", DOCS);
        await panel.waitFor({ state: "detached" });
      }, { reopenFileOnReturn: true });
      console.log("PASS a jump back from Settings and Forward off a kept file's entry land on the entry's pane");

      // an entry naming a PC since removed leaves the app where it is and says so, opens no dialog it
      // named; Forward still works
      await withPage(browser, `?ws=${wsOf(INFRA)}&pane=${encodeURIComponent(INFRA)}`, async (page) => {
        await waitSelected(page, INFRA);
        await waitQuery(page, "pane", INFRA);
        const here = await page.evaluate(() => window.location.search);
        // the entries a PC removed since would have left: one for its pane, then this pane's again
        await page.evaluate((search) => {
          history.pushState(null, "", `?machine=removed&ws=w9-gone&pane=${encodeURIComponent("w9:p1")}&new=workspace&name=Elsewhere`);
          history.pushState(null, "", `${window.location.pathname}${search}`);
        }, here);
        const length = await page.evaluate(() => history.length);
        await page.goBack();
        await page.locator(".header-note", { hasText: "That link's PC is not set up here" }).waitFor();
        await waitQuery(page, "machine", null);
        await waitQuery(page, "pane", INFRA);
        assert.equal(await selected(page), INFRA, "the app stays on the pane it showed");
        await page.waitForTimeout(300); // fixed wait: no New workspace dialog may open
        assert.equal(await page.getByRole("dialog", { name: /New workspace/ }).count(), 0, "no New workspace dialog for a PC that is gone");
        await page.goForward();
        await waitQuery(page, "pane", INFRA);
        assert.equal(await page.evaluate(() => history.length), length, "Back and Forward kept every entry");
      });
      console.log("PASS Back to an entry for a PC since removed stays on the pane shown, says so, opens none of its dialogs, and keeps Forward");

      // the same Back before the PC list is in: the entry waits for it, then lands on this PC with the note
      const heldContext = await browser.newContext({ viewport: { width: 1280, height: 860 }, locale: "en-US" });
      try {
        // after a reload marked to hold it, the PC list (its fetch and its stream) waits for __releaseRoster
        await heldContext.addInitScript(`
          localStorage.setItem("ovis:settings", JSON.stringify({ language: "en" }));
          const hold = sessionStorage.getItem("hold-roster") === "1";
          sessionStorage.removeItem("hold-roster");
          let release = () => {};
          const released = hold ? new Promise((done) => { release = done; }) : Promise.resolve();
          window.__releaseRoster = () => release();
          let fixtureFetch = window.fetch;
          Object.defineProperty(window, "fetch", {
            configurable: true, get: () => fixtureFetch,
            set: (fetch) => {
              fixtureFetch = async (input, init) => {
                const path = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, location.href).pathname;
                if (path === "/api/machines") await released;
                return fetch(input, init);
              };
            },
          });
          let fixtureSource = window.EventSource;
          Object.defineProperty(window, "EventSource", {
            configurable: true, get: () => fixtureSource,
            set: (Source) => {
              fixtureSource = class extends EventTarget {
                static CONNECTING = 0; static OPEN = 1; static CLOSED = 2;
                constructor(url, init) {
                  super(); this.readyState = 0; this.url = String(url);
                  this.source = new Source(url, init);
                  const deliver = (event) => { const copy = new MessageEvent("message", { data: event.data }); this.onmessage?.(copy); this.dispatchEvent(copy); };
                  this.source.onmessage = (event) => { void released.then(() => deliver(event)); };
                  this.source.onopen = (event) => { this.readyState = 1; this.onopen?.(event); this.dispatchEvent(new Event("open")); };
                  this.source.onerror = (event) => { this.onerror?.(event); this.dispatchEvent(new Event("error")); };
                }
                close() { this.readyState = 2; this.source.close(); }
              };
            },
          });
        `);
        const page = await heldContext.newPage();
        const errors: string[] = [];
        page.on("pageerror", (error) => errors.push(error.message));
        await page.goto(`${url}?ws=${wsOf(INFRA)}&pane=${encodeURIComponent(INFRA)}`);
        await waitSelected(page, INFRA);
        await waitQuery(page, "pane", INFRA);
        const here = await page.evaluate(() => window.location.search);
        await page.evaluate((search) => {
          history.pushState(null, "", `?machine=removed&ws=w9-gone&pane=${encodeURIComponent("w9:p1")}`);
          history.pushState(null, "", `${window.location.pathname}${search}`);
          sessionStorage.setItem("hold-roster", "1");
        }, here);
        await page.reload();
        await page.waitForFunction(() => typeof (window as unknown as { __releaseRoster?: unknown }).__releaseRoster === "function" && document.querySelector(".sidebar-shell") !== null);
        await page.goBack();
        await waitQuery(page, "machine", "removed");
        await page.evaluate(() => (window as unknown as { __releaseRoster: () => void }).__releaseRoster());
        await page.locator(".header-note", { hasText: "That link's PC is not set up here" }).waitFor();
        await page.locator('.agents-sidebar .agent-select[aria-current="true"]').waitFor();
        await waitQuery(page, "machine", null);
        assert.deepEqual(errors, []);
        // Back off a creation link before the PCs are in, onto an entry that asks for nothing, drops the creation
        await page.goto(`${url}?pane=${encodeURIComponent(INFRA)}`);
        await waitSelected(page, INFRA);
        await page.evaluate(() => {
          history.pushState(null, "", "?");
          history.pushState(null, "", "?new=workspace&agent=codex");
          sessionStorage.setItem("hold-roster", "1");
        });
        await page.reload();
        await page.waitForFunction(() => typeof (window as unknown as { __releaseRoster?: unknown }).__releaseRoster === "function" && document.querySelector(".sidebar-shell") !== null);
        await page.goBack();
        await waitQuery(page, "new", null);
        await page.evaluate(() => (window as unknown as { __releaseRoster: () => void }).__releaseRoster());
        await page.locator('.agents-sidebar .agent-select[aria-current="true"]').waitFor();
        assert.equal(await page.getByRole("dialog", { name: /New workspace/ }).count(), 0, "an entry left before the roster arrived does not open its creation dialog");
        for (const machine of ["local", "removed"]) for (const forward of [false, true]) {
          await page.goto(`${url}?pane=${encodeURIComponent(INFRA)}`);
          await waitSelected(page, INFRA);
          const here = await page.evaluate(() => location.search);
          await page.evaluate(({ here, machine, forward }) => {
            history.pushState(null, "", `?machine=${machine}&new=workspace&agent=codex&name=Held`);
            if (!forward) history.pushState(null, "", here);
          }, { here, machine, forward });
          if (forward) { await page.goBack(); await waitQuery(page, "pane", INFRA); }
          await page.evaluate(() => sessionStorage.setItem("hold-roster", "1"));
          await page.reload();
          await page.waitForFunction(() => typeof (window as unknown as { __releaseRoster?: unknown }).__releaseRoster === "function" && document.querySelector(".sidebar-shell") !== null);
          if (forward) await page.goForward(); else await page.goBack();
          await waitQuery(page, "new", "workspace");
          assert.equal(await page.getByRole("dialog", { name: /New workspace/ }).count(), 0, "creation waits for the first roster");
          await page.evaluate(() => (window as unknown as { __releaseRoster: () => void }).__releaseRoster());
          if (machine === "local") {
            await page.getByRole("dialog", { name: "New workspace · workstation", exact: true }).waitFor();
            assert.equal((await query(page))["name"], "Held", "history preserves the pending creation fields until the roster arrives");
            if (forward) await page.goBack(); else await page.goForward();
            await page.getByRole("dialog", { name: /New workspace/ }).waitFor({ state: "detached" });
          } else {
            await page.locator(".header-note", { hasText: "That link's PC is not set up here" }).waitFor();
            await waitQuery(page, "machine", null);
            assert.equal(await page.getByRole("dialog", { name: /New workspace/ }).count(), 0, "a missing PC cancels held creation before local fallback");
            if (forward) await page.goBack(); else await page.goForward();
            await waitSelected(page, INFRA);
          }
        }
        assert.deepEqual(errors, []);
      } finally {
        await heldContext.close();
      }
      console.log("PASS Back before the PC list is in waits for it, then lands a removed PC's entry on this PC with the note");

      // a link to a Settings page opens it there; the address follows its pages and drops it on close
      await withPage(browser, `?ws=${wsOf(INFRA)}&pane=${encodeURIComponent(INFRA)}&settings=terminal`, async (page) => {
        const dialog = page.getByRole("dialog", { name: "Settings" });
        await dialog.waitFor();
        await dialog.getByRole("tabpanel", { name: "Terminal", exact: true }).waitFor();
        await waitQuery(page, "settings", "terminal");
        await dialog.getByRole("tab", { name: "Chat", exact: true }).click();
        await waitQuery(page, "settings", "chat");
        await page.keyboard.press("Escape");
        await dialog.waitFor({ state: "detached" });
        await waitQuery(page, "settings", null);
        await waitQuery(page, "pane", INFRA);
      });
      console.log("PASS a link to a Settings page opens it there, the address follows its pages, and closing it leaves the pane's address");

      // ws carries the workspace's name as a slug; a slug another workspace has wins over a reused id
      const note = (page: Page) => page.locator(".header-note").textContent();
      await withPage(browser, `?ws=${wsOf(INFRA)}`, async (page) => {
        await waitQuery(page, "ws", `${wsOf(INFRA)}-cli-tools`);
      });
      await withPage(browser, `?ws=${wsOf(panes.api)}-cli-tools&pane=${encodeURIComponent(panes.api)}`, async (page) => {
        await waitSelected(page, INFRA);
        await waitQuery(page, "ws", `${wsOf(INFRA)}-cli-tools`);
        assert.equal(await note(page), "That agent has closed: its workspace is open");
      });
      await withPage(browser, `?ws=w9z-gone&pane=${encodeURIComponent("w9z:p1")}`, async (page) => {
        await page.locator(".header-note").waitFor();
        assert.equal(await note(page), "That link's workspace is closed");
      });
      console.log("PASS ws carries the workspace's slug; a slug that names another workspace wins over the id, and a link to nothing open says so");

      // a link to a Settings group scrolls to it and focuses it; another page drops it from the address
      await withPage(browser, `?ws=${wsOf(INFRA)}&pane=${encodeURIComponent(INFRA)}&settings=chat&section=quick-replies`, async (page) => {
        const dialog = page.getByRole("dialog", { name: "Settings" });
        await dialog.waitFor();
        await page.waitForFunction(() => (document.activeElement as HTMLElement | null)?.dataset["section"] === "quick-replies");
        await waitQuery(page, "section", "quick-replies");
        await dialog.getByRole("tab", { name: "Appearance", exact: true }).click();
        await waitQuery(page, "settings", "appearance");
        await waitQuery(page, "section", null);
      });
      await withPage(browser, `?settings=about&section=updates`, async (page) => {
        await page.waitForFunction(() => (document.activeElement as HTMLElement | null)?.dataset["section"] === "updates");
      });
      console.log("PASS a link to a Settings group scrolls to and focuses it, and another page drops it from the address");

      // a link to a file opens it beside its pane (a panel from 980px); closing the viewer takes it off the address
      await withPage(browser, `?ws=${wsOf(INFRA)}&pane=${encodeURIComponent(INFRA)}&file=README.md`, async (page) => {
        await page.locator("aside.file-panel .file-viewer").waitFor();
        assert.equal(await page.locator(".modal.file-viewer, .file-viewer-scrim").count(), 0, "a wide window docks the file, no dialog");
        await waitQuery(page, "file", "README.md");
        // the pane beside the panel keeps its own Escape: the panel's is pressed from inside it
        await page.locator("aside.file-panel").getByRole("button", { name: "Close file", exact: true }).focus();
        await page.keyboard.press("Escape");
        await page.locator("aside.file-panel").waitFor({ state: "detached" });
        await waitQuery(page, "file", null);
        await waitQuery(page, "pane", INFRA);
      });
      // a reload restores the viewer from its own entry; Back then closes it for good
      await withPage(browser, `?ws=${wsOf(INFRA)}&pane=${encodeURIComponent(INFRA)}&file=README.md`, async (page) => {
        await page.locator("aside.file-panel .file-viewer").waitFor();
        await page.reload();
        await page.locator("aside.file-panel .file-viewer").waitFor();
        await page.goBack();
        await page.locator("aside.file-panel").waitFor({ state: "detached" });
        for (const deadline = Date.now() + 1_500; Date.now() < deadline;) {
          assert.equal(await page.locator(".file-viewer").count(), 0, "the linked file does not open again after Back closed it");
          await page.waitForTimeout(100);
        }
      });
      console.log("PASS a link to a file opens it beside its pane, and closing the viewer takes it off the address");

      // Copy link puts the address on the clipboard and says so
      await withPage(browser, `?ws=${wsOf(DOCS)}&pane=${encodeURIComponent(DOCS)}`, async (page) => {
        await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
        await waitQuery(page, "pane", DOCS);
        await page.locator(".header-more-button").click();
        await page.getByRole("menuitem", { name: "Copy link" }).click();
        await page.locator(".header-note", { hasText: "Link copied" }).waitFor();
        assert.equal(await page.evaluate(() => navigator.clipboard.readText()), page.url());
      });
      console.log("PASS Copy link puts the address on the clipboard");

      // a link to the New workspace dialog fills its fields and creates nothing by itself; the
      // address follows what is typed, and closing the dialog takes it off
      await withPage(browser, `?new=workspace&cwd=${encodeURIComponent("/home/demo/infra")}&name=Fix%20backup&agent=codex`, async (page) => {
        const dialog = page.getByRole("dialog", { name: /New workspace/ });
        const nameField = dialog.getByRole("textbox", { name: "Optional workspace label", exact: true });
        await dialog.waitFor();
        assert.equal(await page.locator("#new-session-cwd").inputValue(), "/home/demo/infra");
        assert.equal(await nameField.inputValue(), "Fix backup");
        await dialog.locator(".agent-picker-label", { hasText: /codex/i }).waitFor();
        const workspaces = async () => (await page.evaluate(async () => (await (await fetch("/api/session")).json()).snapshot.workspaces.length)) as number;
        const before = await workspaces();
        await page.waitForTimeout(800); // fixed wait: no workspace may be created by the link
        assert.equal(await workspaces(), before, "a link fills the form; Create is still the user's");
        await waitQuery(page, "name", "Fix backup");
        await nameField.fill("Fix the nightly backup");
        await waitQuery(page, "name", "Fix the nightly backup");
        assert.equal((await query(page))["new"], "workspace");
        await page.keyboard.press("Escape");
        await dialog.waitFor({ state: "detached" });
        await waitQuery(page, "new", null);
        await waitQuery(page, "name", null);
      });
      // an agent herdr does not offer is left out, and a tab link opens the dialog for the linked workspace
      await withPage(browser, `?ws=${wsOf(INFRA)}-infra&new=tab&agent=nope`, async (page) => {
        const dialog = page.getByRole("dialog", { name: /New tab · cli-tools/ });
        await dialog.waitFor();
        await waitQuery(page, "new", "tab");
        // the dialog drops it once herdr's agents are in, and the address follows a moment later
        await page.waitForFunction(() => new URLSearchParams(window.location.search).get("agent") !== "nope", undefined, { timeout: 5_000 });
      });
      console.log("PASS a link to the New workspace dialog fills it and creates nothing; the address follows the fields, and a tab link opens it for its workspace");

      // the agent picker in that dialog closes when its anchor can move (an ancestor scrolls, the window resizes),
      // not when something else scrolls, such as a text field's own text; its keys scroll the list alone
      await withPage(browser, "?new=workspace", async (page) => {
        const dialog = page.getByRole("dialog", { name: /New workspace/ });
        await dialog.waitFor();
        const trigger = dialog.locator(".agent-picker-trigger");
        const menu = page.locator(".agent-picker-menu");
        const body = dialog.locator(".modal-body");
        const open = async () => {
          await trigger.focus();
          await page.keyboard.press("ArrowDown");
          await menu.waitFor();
        };
        // a scroll event is delivered on the next frame; give a wrong close time to show
        const settle = () => page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        await open();
        assert.equal(await menu.evaluate((node) => node.scrollHeight > node.clientHeight), true, "the demo's agents are more than the list shows");
        await page.locator("#new-session-cwd").evaluate((input: HTMLInputElement) => {
          input.value = "/home/demo/".concat("a-long-folder-name/".repeat(20));
          input.scrollLeft = input.scrollWidth;
          input.dispatchEvent(new Event("scroll"));
        });
        await settle();
        assert.equal(await trigger.getAttribute("aria-expanded"), "true", "a text field scrolling its own text leaves the picker open");
        // the keys move through the list and scroll it alone: neither the dialog nor the page moves
        const scrolls = () => page.evaluate(() => ({ page: scrollY, dialog: document.querySelector(".modal-body")!.scrollTop }));
        const before = await scrolls();
        await page.keyboard.press("End");
        await settle();
        const inView = (option: string) => menu.evaluate((node, id) => {
          const list = node.getBoundingClientRect();
          const row = document.getElementById(id)!.getBoundingClientRect();
          return row.top >= list.top && row.bottom <= list.bottom;
        }, option);
        const last = (await menu.locator('[role="option"]').last().getAttribute("id"))!;
        assert.equal(await trigger.getAttribute("aria-expanded"), "true", "End keeps the picker open");
        assert.equal(await trigger.getAttribute("aria-activedescendant"), last);
        assert.equal(await menu.evaluate((node) => node.scrollTop > 0), true, "End scrolls the list to the last agent");
        assert.equal(await inView(last), true, "the last agent is in view");
        await page.keyboard.press("Home");
        await settle();
        assert.equal(await trigger.getAttribute("aria-expanded"), "true", "Home keeps the picker open");
        assert.equal(await inView((await trigger.getAttribute("aria-activedescendant"))!), true, "the first row is in view");
        assert.deepEqual(await scrolls(), before, "the keys scroll neither the page nor the dialog");
        // an ancestor of the picker moves it: its scroll closes the list, and so does the window's size
        await body.evaluate((node) => node.dispatchEvent(new Event("scroll")));
        await menu.waitFor({ state: "detached" });
        await open();
        await page.evaluate(() => document.dispatchEvent(new Event("scroll")));
        await menu.waitFor({ state: "detached" });
        await open();
        await page.setViewportSize({ width: 1180, height: 760 });
        await menu.waitFor({ state: "detached" });
      });
      console.log("PASS the agent picker stays open when a text field scrolls and closes when its anchor moves; its keys scroll the list alone");

      // sidebar=hidden opens a desktop with the sidebar collapsed; the address follows the toggle both ways
      await withPage(browser, `?ws=${wsOf(INFRA)}&pane=${encodeURIComponent(INFRA)}&sidebar=hidden`, async (page) => {
        await page.locator(".app.sidebar-collapsed").waitFor();
        await waitQuery(page, "pane", INFRA);
        assert.equal((await query(page))["sidebar"], "hidden");
        await page.locator(".sidebar-toggle").click();
        await page.locator(".app:not(.sidebar-collapsed)").waitFor();
        await waitQuery(page, "sidebar", null);
        await page.locator(".sidebar-toggle").click();
        await waitQuery(page, "sidebar", "hidden");
      });
      // sidebar=shown opens a phone with its drawer out; the drawer is a phone's moment, not its address
      {
        const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, locale: "en-US" });
        try {
          await phone.addInitScript(() => localStorage.setItem("ovis:settings", JSON.stringify({ language: "en" })));
          const page = await phone.newPage();
          await page.goto(`${url}?ws=${wsOf(INFRA)}&pane=${encodeURIComponent(INFRA)}&sidebar=shown`);
          await page.locator('.drawer-toggle[aria-expanded="true"]').waitFor();
          await waitQuery(page, "sidebar", null);
          await page.goto(`${url}?ws=${wsOf(panes.api)}-cli-tools&pane=${encodeURIComponent(panes.api)}`);
          await page.locator(".header-note").waitFor();
          const bounds = await page.evaluate(() => {
            const header = document.querySelector(".app-header")!;
            const note = document.querySelector(".header-note")!.getBoundingClientRect();
            const more = document.querySelector(".header-more-button")!.getBoundingClientRect();
            return { viewport: document.documentElement.clientWidth, scroll: header.scrollWidth, noteLeft: note.left, noteRight: note.right, moreLeft: more.left, moreRight: more.right };
          });
          assert.ok(bounds.scroll <= bounds.viewport, `the note keeps the phone header within its viewport: ${JSON.stringify(bounds)}`);
          assert.ok(bounds.noteLeft >= 0 && bounds.noteRight <= bounds.moreLeft && bounds.moreRight <= bounds.viewport, "the note does not overlap More or push it offscreen");
          console.log("PASS a closed-pane note fits the phone header without overlapping or pushing More offscreen");
        } finally {
          await phone.close();
        }
      }
      console.log("PASS sidebar=hidden collapses a desktop's sidebar and the address follows the toggle; sidebar=shown opens a phone's drawer");

      // a link to a PC this app does not have opens this PC, and says so
      await withPage(browser, `?machine=nope&pane=${encodeURIComponent(INFRA)}`, async (page) => {
        await page.locator(".header-note", { hasText: "That link's PC is not set up here" }).waitFor();
        await page.locator('.agents-sidebar .agent-select[aria-current="true"]').waitFor();
        await waitQuery(page, "machine", null);
      });
      console.log("PASS a link to a PC that is not set up here opens this PC's pane in front, and says so");

      // Hold the first local snapshot explicitly, after the configured-PC list arrives.
      const delayedContext = await browser.newContext({ viewport: { width: 1280, height: 860 }, locale: "en-US" });
      try {
        await delayedContext.addInitScript(`
          localStorage.setItem("ovis:settings", JSON.stringify({ language: "en" }));
          let released = false, fullMachines = null;
          const deliveries = [];
          const hold = machines => {
            fullMachines = machines;
            return released ? machines : machines.map(machine => ({ ...machine, snapshot: null }));
          };
          window.__releaseRoster = () => {
            released = true;
            for (const deliver of deliveries) deliver({ type: "machines", machines: fullMachines });
          };
          let fixtureFetch = window.fetch;
          Object.defineProperty(window, "fetch", {
            configurable: true, get: () => fixtureFetch,
            set: fetch => {
              fixtureFetch = async (input, init) => {
                const response = await fetch(input, init);
                const path = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, location.href).pathname;
                if (path !== "/api/machines") return response;
                const body = await response.json();
                return new Response(JSON.stringify({ ...body, machines: hold(body.machines) }), { headers: response.headers });
              };
            }
          });
          let fixtureSource = window.EventSource;
          Object.defineProperty(window, "EventSource", {
            configurable: true, get: () => fixtureSource,
            set: Source => {
              fixtureSource = class extends EventTarget {
                static CONNECTING = 0; static OPEN = 1; static CLOSED = 2;
                constructor(url, init) {
                  super(); this.readyState = 0; this.url = String(url);
                  this.source = new Source(url, init);
                  const deliver = data => {
                    const event = new MessageEvent("message", { data: JSON.stringify(data) });
                    this.onmessage?.(event); this.dispatchEvent(event);
                  };
                  deliveries.push(deliver);
                  this.source.onmessage = event => {
                    const data = JSON.parse(event.data);
                    if (data.type === "machines") data.machines = hold(data.machines);
                    if (released || data.type === "machines") deliver(data);
                  };
                  this.source.onopen = () => {
                    this.readyState = 1;
                    const event = new Event("open"); this.onopen?.(event); this.dispatchEvent(event);
                  };
                }
                close() { this.readyState = 2; this.source.close(); }
              };
            }
          });
        `);
        const page = await delayedContext.newPage();
        const errors: string[] = [];
        page.on("pageerror", (error) => errors.push(error.message));
        await page.goto(`${url}?machine=unregistered-PC&ws=${wsOf(INFRA)}-cli-tools&pane=${encodeURIComponent(INFRA)}&view=chat`);
        await page.locator(".header-note").waitFor();
        await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
        assert.equal(new URL(page.url()).searchParams.get("machine"), "unregistered-PC", "the fallback cannot rewrite the link before its local roster arrives");
        assert.equal(new URL(page.url()).searchParams.get("pane"), INFRA);
        await page.evaluate("window.__releaseRoster()");
        await waitSelected(page, panes.api);
        await waitQuery(page, "machine", null);
        await waitQuery(page, "pane", panes.api);
        assert.deepEqual(errors, []);
        console.log("PASS an unknown-PC fallback preserves the link until its local roster arrives, then writes the pane it opened");
      } finally {
        await delayedContext.close();
      }

      // Back can select a pane while a modal is open: the grid that takes the keyboard when a pane
      // the app picked becomes one the user picked must leave it in the modal (#675 review)
      await withPage(browser, `?ws=${wsOf(INFRA)}&pane=${encodeURIComponent(INFRA)}&view=terminal`, async (page) => {
        await waitSelected(page, INFRA);
        const resting = page.locator(".agents-sidebar .agent-resting-label .agent-background-toggle");
        await resting.waitFor();
        if (await resting.getAttribute("aria-expanded") === "false") await resting.click();
        await page.locator('.agents-sidebar .agent-resting-label .agent-background-toggle[aria-expanded="true"]').waitFor();
        await page.locator(`.agents-sidebar .agent-item[data-pane="${DOCS}"] .agent-select`).click();
        await waitQuery(page, "pane", DOCS);
        // the selected pane closes: the app picks the pane herdr has in front (autoSelected)
        await page.evaluate((pane) => fetch("/api/pane/close", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ pane_id: pane }) }), DOCS);
        await page.waitForFunction((pane) => new URLSearchParams(window.location.search).get("pane") !== pane, DOCS);
        await page.keyboard.press("ControlOrMeta+Shift+K");
        const palette = page.getByRole("dialog", { name: "Command palette" });
        await palette.waitFor();
        await page.goBack();
        await waitSelected(page, INFRA);
        for (const deadline = Date.now() + 1_000; Date.now() < deadline;) {
          assert.equal(await palette.evaluate((node) => node.contains(document.activeElement)), true, "the keyboard stays in the palette");
          await page.waitForTimeout(100);
        }
      });
      console.log("PASS a pane Back selects under an open modal does not take the keyboard out of it");

      // A phone's header has no palette button: the More menu's first item opens it by touch.
      // Files offers no palette entry on a phone; resizing restores it.
      const palettePhone = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, locale: "en-US" });
      try {
        await palettePhone.addInitScript(() => localStorage.setItem("ovis:settings", JSON.stringify({ language: "en" })));
        const page = await palettePhone.newPage();
        await page.goto(`${url}?pane=${encodeURIComponent(INFRA)}`);
        await waitSelected(page, INFRA);
        assert.equal(await page.locator(".palette-button").isVisible(), false, "the phone header has no palette button");
        await page.locator(".header-more-button").tap();
        const more = page.getByRole("dialog", { name: "More", exact: true });
        await more.waitFor();
        const search = more.getByRole("button", { name: "Search panes and actions", exact: true });
        assert.equal(await search.count(), 1, "More offers Search panes and actions");
        // a phone's header lists the tabs, so More leads with the jump to a session waiting for you, when one waits
        assert.equal((await more.locator(".row-sheet-item .row-sheet-label").allTextContents()).find((label) => label !== "Open the next session waiting for you"), "Search panes and actions", "Search panes and actions is More's first item of its own");
        await more.getByRole("button", { name: "Browse files", exact: true }).tap();
        const files = page.getByRole("dialog", { name: "Files", exact: true });
        await files.waitFor();
        // New folder belongs to New workspace's Browse; the Files browser only reads
        await files.locator(".dir-browser-bar").first().waitFor({ state: "attached" });
        assert.equal(await files.locator('.dir-browser-bar button[aria-label="New folder"]').count(), 0, "Files has no New folder");
        const browse = files.getByRole("button", { name: "Browse folders in the palette", exact: true });
        assert.equal(await browse.count(), 0, "Files has no phone palette entry");
        await page.setViewportSize({ width: 1024, height: 768 });
        await browse.waitFor();
        await browse.click();
        const palette = page.getByRole("dialog", { name: "Command palette", exact: true });
        await palette.waitFor();
        await page.keyboard.press("Escape");
        await palette.waitFor({ state: "detached" });
        await page.setViewportSize({ width: 390, height: 844 });
        await browse.waitFor({ state: "detached" });
        await page.keyboard.press("ControlOrMeta+Shift+K");
        await palette.waitFor();
        await page.keyboard.press("Escape");
        await palette.waitFor({ state: "detached" });
        await page.locator(".header-more-button").tap();
        await more.waitFor();
        await search.tap();
        await palette.waitFor();
        await page.waitForFunction(() => document.activeElement?.matches(".command-palette .palette-search input") === true, undefined, { timeout: 5000 });
        assert.equal(await more.count(), 0, "the More sheet has gone");
      } finally { await palettePhone.close(); }
      console.log("PASS phone header and Files omit palette buttons; More's first item opens the palette by touch; wider Files and keyboard shortcuts still open it");

      // a phone's ⋯ sheet is an entry of its own: Back closes it and stays on the pane; a sheet
      // closed by Cancel or by an item leaves no entry behind, so the next Back goes to the pane before
      const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, locale: "en-US" });
      try {
        await phone.addInitScript(() => localStorage.setItem("ovis:settings", JSON.stringify({ language: "en" })));
        const page = await phone.newPage();
        const errors: string[] = [];
        page.on("pageerror", (error) => errors.push(error.message));
        await page.goto(`${url}?ws=${wsOf(INFRA)}&pane=${encodeURIComponent(INFRA)}`);
        await page.locator(".conn-live").waitFor({ state: "attached" });
        await waitSelected(page, INFRA);
        // the sidebar is a closed drawer on a phone: a click on its row in the page is enough here
        await page.locator(`.agents-sidebar .agent-item[data-pane="${DOCS}"] .agent-select`).evaluate((node) => (node as HTMLElement).click());
        await waitQuery(page, "pane", DOCS);
        const length = await page.evaluate(() => history.length);
        const more = page.locator(".header-more-button");
        const sheet = page.getByRole("dialog", { name: "More", exact: true });
        await more.tap();
        await sheet.waitFor();
        assert.equal(await page.evaluate(() => history.length), length + 1, "an open sheet is an entry");
        await page.goBack();
        await sheet.waitFor({ state: "detached" });
        assert.equal(await selected(page), DOCS, "Back closed the sheet and left the pane alone");
        assert.equal((await query(page))["pane"], DOCS);
        await more.tap();
        await sheet.waitFor();
        await sheet.getByRole("button", { name: "Cancel", exact: true }).tap();
        await sheet.waitFor({ state: "detached" });
        await page.waitForFunction(() => !Object.keys(history.state ?? {}).includes("ovis:sheet"));
        await page.goBack();
        await waitSelected(page, INFRA);
        await page.goForward();
        await waitSelected(page, DOCS);
        // an item that opens a dialog on the sheet's address keeps the sheet's entry: More's (a phone's
        // pane menu, under its Pane and tab… sheet, which takes More's entry: G-143) Rename pane dialog stays up once the
        // sheet's closing has settled, and Back closes it alone
        await more.tap();
        await sheet.waitFor();
        await openMoreGroup(page, "pane");
        await page.getByRole("button", { name: "Rename pane", exact: true }).tap();
        const creation = page.getByRole("dialog", { name: /^Rename pane · / });
        await creation.waitFor();
        await page.waitForTimeout(150); // fixed wait: the Rename pane dialog may not close
        assert.equal(await creation.isVisible(), true, "the Rename pane dialog stays up after the sheet's entry settles");
        assert.equal(await page.evaluate(() => history.length), length + 1, "the dialog took the sheet's entry");
        await page.goBack();
        await creation.waitFor({ state: "detached" });
        assert.equal(await selected(page), DOCS, "Back closed the dialog and left the pane alone");
        // every other dialog is a sheet on a phone too: the plan and the palette close on Back
        const API = panes.api;
        await page.locator(`.agents-sidebar .agent-item[data-pane="${API}"] .agent-select`).evaluate((node) => (node as HTMLElement).click());
        await waitQuery(page, "pane", API);
        const atApi = await page.evaluate(() => history.length);
        // the plan lives in the composer's background-task chip now (#846): its list is a phone dialog too
        await page.locator(".composer .bg-tasks-toggle").tap();
        const plan = page.locator(".bg-tasks-menu");
        await plan.waitFor();
        assert.equal(await page.evaluate(() => history.length), atApi + 1, "the plan is an entry");
        await page.goBack();
        await plan.waitFor({ state: "detached" });
        assert.equal(await selected(page), API, "Back closed the plan and left the pane alone");
        await page.keyboard.press("ControlOrMeta+Shift+K");
        const palette = page.getByRole("dialog", { name: "Command palette" });
        await palette.waitFor();
        assert.equal(await page.evaluate(() => history.length), atApi + 1, "the palette is an entry");
        await page.goBack();
        await palette.waitFor({ state: "detached" });
        assert.equal(await selected(page), API, "Back closed the palette and left the pane alone");
        await page.goBack();
        await waitSelected(page, DOCS);
        await page.goBack();
        await waitSelected(page, INFRA);
        assert.deepEqual(errors, []);
      } finally {
        await phone.close();
      }
      console.log("PASS a phone's sheet, plan and palette close on Back without leaving their pane; Cancel and Rename pane leave no Back step behind");
    } finally {
      await browser.close();
    }
  } finally {
    server.stop(true);
  }
} finally {
  rmSync(app, { recursive: true, force: true });
}
