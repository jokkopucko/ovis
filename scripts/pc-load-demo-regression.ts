import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright-core";
import { buildDemoApp } from "./demo-build.ts";
import { chromePath } from "./chrome-path.ts";
import { openSettingsPage } from "./settings-page.ts";

// The PC load line (components/MachineStats.tsx PcLoadStatus) on the unmodified app over the demo's fixture transport,
// at a phone's and a desktop's width. Only this disposable fixture rewrites the roster into three connected PCs: the
// Host "Laptop", "Work PC" under load and "Lab", a herdr-core machine; no herdr session is opened. PC load lives in
// the bottom status bar only (App.tsx StatusBar pcLoad), on until Settings -> Devices and PCs -> PC load in the
// status bar turns it off, in a key of its own. On: the selected PC's figures in the status bar at a desktop's width,
// none for the herdr-core machine (never asked), and no CPU, memory or disk text in the sidebar; a phone has no status
// bar, so none in the drawer either. Off: none anywhere and no PC asked. Screenshots go to UI_EVIDENCE_DIR when set.
const app = mkdtempSync(join(tmpdir(), "ovis-pc-load-demo-"));
const evidence = process.env.UI_EVIDENCE_DIR;
const patch = `(() => {
  const fetchDemo = window.fetch.bind(window), EventSourceDemo = window.EventSource;
  const json = (value) => new Response(JSON.stringify(value), { headers: { "content-type": "application/json", "cache-control": "no-store" } });
  const PCS = [["local", "local", "Laptop"], ["work", "ssh", "Work PC"], ["lab", "hc", "Lab"]];
  let last = null;
  const roster = (original) => PCS.map(([id, kind, name]) => {
    const machine = structuredClone(original.find((item) => item.id === "local"));
    machine.id = id; machine.kind = kind; machine.name = name; machine.state = "connected";
    return machine;
  });
  const gib = 1024 ** 3;
  const loaded = () => ({ sampled_at: Date.now(), platform: "linux", uptime_s: 12 * 86400 + 4 * 3600, cpu_count: 16, cpu_percent: 93,
    memory: { used: 57 * gib, total: 64 * gib, percent: 89 }, load: [14.2, 12.8, 11.9],
    disks: [{ path: "/", used: 433 * gib, total: 466 * gib, percent: 93 }, { path: "/home/dev", used: 1.1 * 1024 * gib, total: 1.8 * 1024 * gib, percent: 61 }] });
  window.__systemAsks = { local: 0, work: 0, lab: 0 };
  window.EventSource = class extends EventTarget {
    constructor(url, options) {
      super(); this.inner = new EventSourceDemo(url, options); this.readyState = 1;
      this.inner.onmessage = (event) => {
        const message = JSON.parse(event.data);
        if (message.type === "machines") { last = message.machines; message.machines = roster(last); }
        this.onmessage?.(new MessageEvent("message", { data: JSON.stringify(message) }));
      };
      this.inner.onerror = (event) => this.onerror?.(event);
      this.inner.onopen = (event) => this.onopen?.(event);
    }
    close() { this.inner.close(); this.readyState = 2; }
  };
  window.fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, location.href);
    if (url.pathname === "/api/machines") { const value = await (await fetchDemo(input, init)).json(); last = value.machines; return json({ ...value, machines: roster(last) }); }
    const match = url.pathname.match(/^\\/api\\/machines\\/([^/]+)(\\/.*)$/);
    const machine = match ? decodeURIComponent(match[1]) : "local";
    const path = match ? "/api" + match[2] : url.pathname;
    if (path === "/api/system") {
      window.__systemAsks[machine] += 1;
      if (machine === "work") return json(loaded());
    }
    if (match && path === "/api/session" && last) return json({ snapshot: roster(last).find((item) => item.id === machine).snapshot });
    if (match) return fetchDemo(path + url.search, init);
    return fetchDemo(input, init);
  };
})();`;

let origin = "";
const group = (page: Page, name: string) => page.locator(`section.machine-group[aria-label="PC ${name}"]`);
// a screenshot waits for the drawer and the sheet to finish moving, so it shows where they come to rest (a
// pulse that never ends is not a move)
const still = (page: Page): Promise<unknown> => page.waitForFunction(() => document.getAnimations().every((animation) => animation.playState !== "running" || animation.effect?.getComputedTiming().iterations === Infinity));
const asks = (page: Page): Promise<{ local: number; work: number; lab: number }> => page.evaluate(() => (window as unknown as { __systemAsks: { local: number; work: number; lab: number } }).__systemAsks);
const total = async (page: Page): Promise<number> => { const n = await asks(page); return n.local + n.work + n.lab; };

async function open(browser: Browser, width: number, theme: "dark" | "light" = "dark", sidebarWidth: number | null = null): Promise<{ page: Page; errors: string[]; phone: boolean; close: () => Promise<void> }> {
  const phone = width <= 480;
  const context = await browser.newContext({ viewport: { width, height: phone ? 844 : 900 }, locale: "en-US", hasTouch: phone, isMobile: phone });
  await context.addInitScript(([theme, sidebarWidth]) => {
    if (localStorage.getItem("ovis:settings") === null) localStorage.setItem("ovis:settings", JSON.stringify({ language: "en", theme }));
    if (sidebarWidth !== null) localStorage.setItem("ovis:sidebar-width", String(sidebarWidth));
  }, [theme, sidebarWidth] as const);
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  // the poll's 5 s waits run on this clock, so "no ask while hidden" is told by moving it, not by waiting
  await page.clock.install();
  await page.goto(`${origin}/`);
  await page.locator(".conn-live").waitFor({ state: "attached" });
  return { page, errors, phone, close: () => context.close() };
}

/** The sidebar in view or out of it: a phone's drawer, a desktop's Show/Hide workspace list. */
async function showSidebar(page: Page, phone: boolean, shown: boolean): Promise<void> {
  const name = phone ? (shown ? "Open workspace list" : "Close workspace list") : (shown ? "Show workspace list" : "Hide workspace list");
  const toggle = page.getByRole("button", { name, exact: true });
  if (await toggle.count() > 0) await toggle.click();
  if (shown) await group(page, "Laptop").waitFor();
  await still(page);
}

/** No CPU, memory or disk figure in the sidebar or the phone's drawer. */
async function noSidebarLoad(page: Page, label: string): Promise<void> {
  const shown = await page.evaluate(() => [...document.querySelectorAll("aside.sidebar *")]
    .filter((el) => /\b(CPU|Memory|Disk)\b/.test([...el.childNodes].filter((node) => node.nodeType === Node.TEXT_NODE).map((node) => node.textContent).join("")) && el.getClientRects().length > 0)
    .map((el) => el.outerHTML.slice(0, 120)));
  assert.deepEqual(shown, [], `${label}: no PC load in the sidebar`);
  assert.equal(await page.locator(".machine-stats").count(), 0, `${label}: no per-PC load line`);
}
/** No PC load anywhere: not in the sidebar, not in the status bar, no "CPU <n>%" on the page. */
async function noLoadAnywhere(page: Page, label: string): Promise<void> {
  await noSidebarLoad(page, label);
  assert.equal(await page.locator(".status-bar-load").count(), 0, `${label}: no load in the status bar`);
  assert.doesNotMatch(await page.evaluate(() => document.body.innerText), /CPU \d+%/, `${label}: no load on the page`);
}
/** Settings -> Devices and PCs -> PC load in the status bar, flipped to `on`, then the dialog closed. */
async function setPcLoad(page: Page, on: boolean): Promise<void> {
  await page.locator(".sidebar-footer-settings").click();
  await openSettingsPage(page, "Devices and PCs");
  const toggle = page.locator(".settings-dialog").getByRole("switch", { name: "PC load in the status bar", exact: true });
  assert.equal(await toggle.getAttribute("aria-checked"), String(!on));
  await toggle.click();
  await page.waitForFunction((want) => document.querySelector('[role="switch"][aria-label="PC load in the status bar"]')?.getAttribute("aria-checked") === want, String(on));
  await page.keyboard.press("Escape");
  await page.locator(".settings-dialog").waitFor({ state: "detached" });
}

try {
  await buildDemoApp(app);
  writeFileSync(join(app, "pc-load.js"), patch);
  const index = join(app, "index.html");
  writeFileSync(index, readFileSync(index, "utf8").replace(/<script type="module"/, '<script src="./demo-transport.js"></script><script src="./pc-load.js"></script><script type="module"'));
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const path = new URL(request.url).pathname;
    let file: string;
    try { file = decodeURIComponent(path.slice(1)); } catch { return new Response("bad path", { status: 400 }); }
    if (!file || file.endsWith("/")) file += "index.html";
    if (file.split("/").includes("..") || file.includes("\\")) return new Response("bad path", { status: 400 });
    const body = Bun.file(join(app, file));
    return await body.exists() ? new Response(body) : new Response("not found", { status: 404 });
  } });
  origin = `http://127.0.0.1:${server.port}`;
  try {
    const browser = await chromium.launch({ executablePath: chromePath(), headless: true, args: ["--no-sandbox"] });
    try {
      if (evidence) mkdirSync(evidence, { recursive: true });
      for (const width of [390, 1280]) {
        const { page, errors, phone, close } = await open(browser, width);
        try {
          const label = `${width}px`;
          await showSidebar(page, phone, true);
          // nothing chosen: on, the selected PC's load in a desktop's status bar
          if (!phone) await page.locator(".status-bar .status-bar-load").waitFor();
          assert.equal(await page.evaluate(() => localStorage.getItem("ovis:pc-load")), null, `${label}: nothing chosen yet`);

          // turned off: none anywhere, and no PC is asked any more
          await setPcLoad(page, false);
          assert.equal(await page.evaluate(() => localStorage.getItem("ovis:pc-load")), "false");
          const asked = await total(page);
          await page.clock.runFor(10_000);
          await showSidebar(page, phone, true);
          await noLoadAnywhere(page, `${label} off`);
          assert.equal(await total(page), asked, `${label}: off, no PC is asked`);

          await showSidebar(page, phone, true);
          await setPcLoad(page, true);
          assert.equal(await page.evaluate(() => localStorage.getItem("ovis:pc-load")), "true");
          assert.equal(await page.evaluate(() => "pcLoad" in JSON.parse(localStorage.getItem("ovis:settings") ?? "{}")), false, "not in ovis:settings");
          if (phone) {
            // a phone has no status bar: time passes, a PC could have answered, and still nothing shows a load
            await page.clock.runFor(10_000);
            await showSidebar(page, phone, true);
            await noLoadAnywhere(page, `${label} on`);
            assert.equal(await page.locator(".status-bar").count(), 0, `${label}: no status bar on a phone`);
            if (evidence) await page.screenshot({ path: join(evidence, "pc-load-390-on-drawer.png") });
          } else {
            const load = page.locator(".status-bar .status-bar-load");
            // the selected PC (the Laptop the demo opens on): its CPU in the status bar
            await load.waitFor();
            assert.match(await load.textContent() ?? "", /^CPU \d+%/, `${label}: the status bar names the CPU load`);
            // Work PC selected: its own figures, the fullest disk
            await page.locator('.agent-item[data-machine="work"]').first().click();
            await page.waitForFunction(() => document.querySelector(".status-bar .status-bar-load")?.textContent === "CPU 93% · Memory 89% · Disk 93%");
            if (evidence) { await still(page); await page.screenshot({ path: join(evidence, "pc-load-1280-on-status-bar.png") }); }
            await noSidebarLoad(page, `${label} on, the load in the status bar`);
            // the herdr-core machine selected: no load, and it is never asked
            await page.locator('.agent-item[data-machine="lab"]').first().click();
            await page.waitForFunction(() => document.querySelector(".status-bar .machine-context-name")?.textContent === "Lab");
            await page.clock.runFor(10_000);
            assert.equal(await load.count(), 0, `${label}: a herdr-core machine shows no load`);
            assert.equal((await asks(page)).lab, 0, `${label}: and is never asked for it`);
            await page.locator('.agent-item[data-machine="work"]').first().click();
            await page.waitForFunction(() => document.querySelector(".status-bar .status-bar-load")?.textContent === "CPU 93% · Memory 89% · Disk 93%");
          }

          assert.deepEqual(errors, []);
          console.log(`PASS ${label}: on by default; off, none anywhere and no PC asked, kept in its own key; on again, ${phone ? "no load in the drawer and no status bar" : "the selected PC's load in the status bar (none for the herdr-core machine) and none in the sidebar"}`);
        } finally { await close(); }
      }
    } finally { await browser.close(); }
  } finally { await server.stop(true); }
} finally {
  rmSync(app, { recursive: true, force: true });
}
