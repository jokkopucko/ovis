import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright-core";
import panes from "../site/demo/fixtures/panes.json";
import { buildDemoApp } from "./demo-build.ts";
import { chromePath } from "./chrome-path.ts";
import { openSettingsPage } from "./settings-page.ts";
import { serveDemo } from "./demo-server.ts";

const app = mkdtempSync(join(tmpdir(), "herdr-hide-pc-demo-"));
const evidence = process.env.UI_EVIDENCE_DIR;
const patch = `(() => {
  const fetchDemo = window.fetch.bind(window), EventSourceDemo = window.EventSource;
  const json = (value) => new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
  let last = null;
  // the PCs a check asks for (open()'s roster), else the Host and Work PC
  let ids = window.hidePcRoster ?? ["local", "work"];
  const names = { local: "Laptop", work: "Work PC", lab: "Lab PC" };
  const roster = (original) => ids.map((id) => {
    const machine = structuredClone(original.find((item) => item.id === "local"));
    machine.id = id; machine.kind = id === "local" ? "local" : "ssh";
    machine.name = names[id];
    machine.state = "connected";
    return machine;
  });
  // the server's roster changing under the page (a PC removed elsewhere): the open streams carry the new one
  const sources = new Set();
  let lastRoster = null;
  window.hidePcSetRoster = (next) => {
    ids = next;
    for (const source of sources) if (lastRoster) source.onmessage?.(new MessageEvent("message", { data: JSON.stringify({ ...lastRoster, machines: roster(last) }) }));
  };
  window.EventSource = class extends EventTarget {
    constructor(url, options) {
      super(); this.inner = new EventSourceDemo(url, options); this.readyState = 1;
      sources.add(this);
      this.inner.onmessage = (event) => {
        const message = JSON.parse(event.data);
        if (message.type === "machines") { last = message.machines; lastRoster = message; message.machines = roster(last); }
        this.onmessage?.(new MessageEvent("message", { data: JSON.stringify(message) }));
      };
      this.inner.onerror = (event) => this.onerror?.(event);
      this.inner.onopen = (event) => this.onopen?.(event);
    }
    close() { this.inner.close(); this.readyState = 2; sources.delete(this); }
  };
  window.fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, location.href);
    if (url.pathname === "/api/machines") { const value = await (await fetchDemo(input, init)).json(); last = value.machines; return json({ ...value, machines: roster(last) }); }
    const match = url.pathname.match(/^\\/api\\/machines\\/([^/]+)(\\/.*)$/);
    const machine = match ? decodeURIComponent(match[1]) : "local";
    const path = match ? "/api" + match[2] : url.pathname;
    if (match && path === "/api/session" && last) return json({ snapshot: roster(last).find((item) => item.id === machine).snapshot });
    if (match) return fetchDemo(path + url.search, init);
    return fetchDemo(input, init);
  };
})();`;

let origin = "";
const pane = encodeURIComponent(panes.web);
const workGroup = (page: Page) => page.locator('section.machine-group[aria-label="PC Work PC"]');
const still = (page: Page): Promise<unknown> => page.waitForFunction(() => document.getAnimations().every((animation) => animation.playState !== "running"));
const selection = (page: Page): Promise<string | null> => page.evaluate(() => JSON.parse(localStorage.getItem("ovis:selection") ?? "null")?.machine_id ?? null);

type Theme = "light" | "dark";
interface OpenOptions { roster?: string[]; theme?: Theme; hidden?: string[] }

async function open(browser: Browser, width: number, query: string, options: OpenOptions = {}): Promise<{ page: Page; errors: string[]; phone: boolean; close: () => Promise<void> }> {
  const phone = width <= 480;
  const context = await browser.newContext({ viewport: { width, height: phone ? 844 : 900 }, locale: "en-US", hasTouch: phone, isMobile: phone, colorScheme: options.theme ?? "light" });
  await context.addInitScript(({ roster, theme, hidden }) => {
    if (roster !== null) Object.assign(window, { hidePcRoster: roster });
    if (sessionStorage.getItem("hide-pc-seeded") !== null) return;
    sessionStorage.setItem("hide-pc-seeded", "1");
    if (localStorage.getItem("ovis:settings") === null) localStorage.setItem("ovis:settings", JSON.stringify(theme === null ? { language: "en" } : { language: "en", theme }));
    if (hidden !== null) localStorage.setItem("ovis:hidden-pcs", JSON.stringify(hidden));
  }, { roster: options.roster ?? null, theme: options.theme ?? null, hidden: options.hidden ?? null });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${origin}/${query}`);
  await page.locator(".conn-live").waitFor({ state: "attached" });
  return { page, errors, phone, close: () => context.close() };
}

const pcsHead = (page: Page) => page.locator(".pcs-sidebar > :not(.machine-list)");
const storedHidden = (page: Page): Promise<unknown> => page.evaluate(() => JSON.parse(localStorage.getItem("ovis:hidden-pcs") ?? "null"));
const group = (page: Page, name: string) => page.locator(`section.machine-group[aria-label="PC ${name}"]`);
const NO_DROPLET = ".droplet { visibility: hidden !important; }";

async function sidebar(page: Page, phone: boolean): Promise<void> {
  if (phone) {
    const toggle = page.getByRole("button", { name: "Open workspace list", exact: true });
    if (await toggle.count() > 0) await toggle.click();
  }
  await page.locator('section.machine-group[aria-label="PC Laptop"]').waitFor();
}

try {
  await buildDemoApp(app);
  writeFileSync(join(app, "hide-pc.js"), patch);
  const index = join(app, "index.html");
  writeFileSync(index, readFileSync(index, "utf8").replace(/<script type="module"/, '<script src="./demo-transport.js"></script><script src="./hide-pc.js"></script><script type="module"'));
  const server = serveDemo(app, { prefix: "/" });
  origin = `http://127.0.0.1:${server.port}`;
  try {
    const browser = await chromium.launch({ executablePath: chromePath(), headless: true, args: ["--no-sandbox"] });
    try {
      if (evidence) mkdirSync(evidence, { recursive: true });
      for (const width of [390, 1440]) {
        const { page, errors, phone, close } = await open(browser, width, `?machine=work&pane=${pane}`);
        try {
          await sidebar(page, phone);
          assert.equal(await workGroup(page).count(), 1, "both PCs are shown until one is hidden");
          assert.ok(await page.locator('.agent-item[data-machine="work"]').count() > 0, "Work PC's agents are listed");
          await page.waitForFunction(() => JSON.parse(localStorage.getItem("ovis:selection") ?? "null")?.machine_id === "work");

          await page.locator(".sidebar-footer-settings").click();
          await openSettingsPage(page, "Devices and PCs");
          const dialog = page.locator(".settings-dialog");
          const work = dialog.getByRole("switch", { name: "Show Work PC in sidebar", exact: true });
          const laptop = dialog.getByRole("switch", { name: "Show Laptop in sidebar", exact: true });
          await work.waitFor();
          assert.equal(await work.getAttribute("aria-checked"), "true");
          assert.equal(await laptop.isEnabled(), true);
          await work.click();
          await page.waitForFunction(() => document.querySelector('[role="switch"][aria-label="Show Work PC in sidebar"]')?.getAttribute("aria-checked") === "false");
          assert.equal(await laptop.isDisabled(), true, "the last PC shown cannot be hidden");
          assert.deepEqual(await page.evaluate(() => JSON.parse(localStorage.getItem("ovis:hidden-pcs") ?? "null")), ["work"], "kept in this browser, in its own key");
          assert.equal(await page.evaluate(() => (localStorage.getItem("ovis:settings") ?? "").includes("hidden")), false, "and not in ovis:settings");
          await page.waitForFunction(() => JSON.parse(localStorage.getItem("ovis:selection") ?? "null")?.machine_id === "local");
          if (evidence) { await still(page); await page.screenshot({ path: join(evidence, `hide-pc-settings-${width}.png`) }); }

          await page.keyboard.press("Escape");
          await dialog.waitFor({ state: "detached" });
          await page.waitForFunction(() => !(history.state !== null && typeof history.state === "object" && "ovis:settings" in history.state) && !location.search.includes("machine=work"));
          await page.locator(".machine-context-name").first().waitFor({ state: "attached" });
          assert.equal(await selection(page), "local", "the selection stays off the hidden PC after Settings closes");
          assert.equal(await page.locator(".machine-context-name").first().innerText(), "Laptop");
          await sidebar(page, phone);
          assert.equal(await workGroup(page).count(), 0, "a hidden PC leaves the sidebar");
          assert.equal(await page.locator('.agent-item[data-machine="work"]').count(), 0, "and the Agents list");
          assert.ok(await page.locator('.agent-item[data-machine="local"]').count() > 0);
          assert.equal(await pcsHead(page).count(), 0, "nothing is drawn above the PCs");
          assert.equal(await page.locator(".machine-hidden-note").count(), 0, "no line under the PCs says it either");
          if (evidence) { await still(page); await page.screenshot({ path: join(evidence, `hide-pc-sidebar-${width}.png`) }); }

          if (!phone) {
            await page.keyboard.press("ControlOrMeta+Shift+K");
            const palette = page.getByRole("dialog", { name: "Command palette", exact: true });
            await palette.locator('.palette-pane[data-machine="local"]').first().waitFor();
            assert.equal(await palette.locator('.palette-pane[data-machine="work"]').count(), 0, "and the command palette");
            await page.keyboard.press("Escape");
            await palette.waitFor({ state: "detached" });
          }

          await page.reload();
          await page.locator(".conn-live").waitFor({ state: "attached" });
          await sidebar(page, phone);
          assert.equal(await workGroup(page).count(), 0, "a reload keeps it hidden");

          await page.goto(`${origin}/?machine=work&pane=${pane}`);
          await page.locator(".conn-live").waitFor({ state: "attached" });
          await page.waitForFunction(() => JSON.parse(localStorage.getItem("ovis:selection") ?? "null")?.machine_id === "work");
          await page.locator(".machine-context-name", { hasText: "Work PC" }).first().waitFor({ state: "attached" });
          assert.equal(await page.getByText("That link's PC is not set up here").count(), 0);
          assert.equal(await selection(page), "work");
          await sidebar(page, phone);
          assert.equal(await workGroup(page).count(), 0);

          await page.locator(".sidebar-footer-settings").click();
          await openSettingsPage(page, "Devices and PCs");
          const back = page.locator(".settings-dialog").getByRole("switch", { name: "Show Work PC in sidebar", exact: true });
          await back.click();
          await page.waitForFunction(() => document.querySelector('[role="switch"][aria-label="Show Work PC in sidebar"]')?.getAttribute("aria-checked") === "true");
          await page.keyboard.press("Escape");
          await page.locator(".settings-dialog").waitFor({ state: "detached" });
          await sidebar(page, phone);
          assert.equal(await workGroup(page).count(), 1, "Settings' way back shows it again");
          assert.deepEqual(await storedHidden(page), [], "shown again on this device");
          assert.equal(await selection(page), "work", "showing a PC moves no selection");
          assert.deepEqual(errors, []);

          if (phone) {
            await page.goto(`${origin}/?machine=work&pane=${pane}`);
            await page.locator(".conn-live").waitFor({ state: "attached" });
            await page.waitForFunction(() => JSON.parse(localStorage.getItem("ovis:selection") ?? "null")?.machine_id === "work");
            await page.keyboard.press("ControlOrMeta+Shift+K");
            const palette = page.getByRole("dialog", { name: "Command palette", exact: true });
            await palette.getByRole("searchbox", { name: "Search panes and actions", exact: true }).fill("Show in sidebar");
            await palette.getByRole("option").filter({ hasText: "Show in sidebar" }).first().click();
            const fromPalette = page.locator(".settings-dialog").getByRole("switch", { name: "Show Work PC in sidebar", exact: true });
            await fromPalette.click();
            await page.waitForFunction(() => JSON.parse(localStorage.getItem("ovis:selection") ?? "null")?.machine_id === "local");
            await page.keyboard.press("Escape");
            await page.locator(".settings-dialog").waitFor({ state: "detached" });
            await page.waitForFunction(() => !(history.state !== null && typeof history.state === "object" && "ovis:settings" in history.state) && !location.search.includes("machine=work"));
            assert.equal(await selection(page), "local", "Settings opened from the palette sheet keeps the moved selection when it closes");
            await page.evaluate(() => localStorage.removeItem("ovis:hidden-pcs"));
          }

          await page.evaluate((paneId) => {
            localStorage.setItem("ovis:hidden-pcs", JSON.stringify(["work"]));
            localStorage.setItem("ovis:selection", JSON.stringify({ machine_id: "work", pane_id: paneId }));
            sessionStorage.setItem("ovis:selection", JSON.stringify({ machine_id: "work", pane_id: paneId }));
          }, panes.web);
          await page.goto(`${origin}/`);
          await page.locator(".conn-live").waitFor({ state: "attached" });
          await page.waitForFunction(() => JSON.parse(localStorage.getItem("ovis:selection") ?? "null")?.machine_id === "local");
          assert.equal(await page.getByText("That link's PC is not set up here").count(), 0);
          assert.deepEqual(errors, []);
          console.log(`PASS ${width}px: Work PC hidden from the sidebar, Agents${phone ? "" : " and palette"}, selection moved, Laptop kept, reload kept, its link still opens, Settings shows it again`);
        } finally { await close(); }
      }

      for (const width of [390, 1280]) {
        for (const theme of ["light", "dark"] as const) {
          const { page, errors, phone, close } = await open(browser, width, "", { roster: ["local", "work", "lab"], theme, hidden: ["work", "lab", "gone"] });
          try {
            await sidebar(page, phone);
            assert.equal(await group(page, "Work PC").count() + await group(page, "Lab PC").count(), 0, "both hidden PCs are out of the sidebar");
            assert.equal(await pcsHead(page).count(), 0, "no PCs head, no hidden count");
            const section = (await page.locator(".pcs-sidebar").boundingBox())!;
            const first = (await group(page, "Laptop").boundingBox())!;
            assert.ok(first.y - section.y < 16, `the first PC starts the PCs' section, with no head above it (${first.y - section.y}px)`);
            if (evidence) { await still(page); await page.screenshot({ path: join(evidence, `hidden-pcs-sidebar-${width}-${theme}.png`), style: NO_DROPLET }); }

            await page.locator(".sidebar-footer-settings").click();
            await openSettingsPage(page, "Devices and PCs");
            const dialog = page.locator(".settings-dialog");
            const laptop = dialog.getByRole("switch", { name: "Show Laptop in sidebar", exact: true });
            await laptop.waitFor();
            assert.equal(await laptop.getAttribute("aria-checked"), "true");
            assert.equal(await laptop.isDisabled(), true, "the last PC shown cannot be hidden");
            assert.equal(await dialog.getByRole("switch", { name: "Show Work PC in sidebar", exact: true }).getAttribute("aria-checked"), "false");
            assert.equal(await dialog.getByRole("switch", { name: "Show Lab PC in sidebar", exact: true }).getAttribute("aria-checked"), "false");
            await dialog.getByRole("switch", { name: "Show Work PC in sidebar", exact: true }).click();
            await page.waitForFunction(() => document.querySelector('[role="switch"][aria-label="Show Work PC in sidebar"]')?.getAttribute("aria-checked") === "true");
            assert.deepEqual(await storedHidden(page), ["lab"], "only Lab PC stays hidden; the removed PC's id is dropped");
            await page.keyboard.press("Escape");
            await dialog.waitFor({ state: "detached" });
            await sidebar(page, phone);
            await group(page, "Work PC").waitFor();
            assert.equal(await group(page, "Lab PC").count(), 0);
            assert.equal(await pcsHead(page).count(), 0);
            assert.deepEqual(errors, []);
          } finally { await close(); }
        }
        console.log(`PASS ${width}px: no PCs head or hidden count, the list starts under the logo, Settings shows a hidden PC again and keeps the last one shown, light and dark`);
      }
    } finally { await browser.close(); }
  } finally { await server.stop(true); }
} finally {
  rmSync(app, { recursive: true, force: true });
}
