import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type BrowserContext, type CDPSession, type Locator, type Page } from "playwright-core";
import { manifestBody } from "../server/static.ts";
import { buildDemoApp } from "./demo-build.ts";
import { openSettingsPage } from "./settings-page.ts";

// Install app against a real install: the unmodified app over the demo's fixture
// transport, served at the ROOT of a loopback origin so the manifest's id, start_url and scope "/"
// are this app, installed with the browser's own PWA domain (CDP). The browser runs on a profile,
// HOME and XDG data dir of its own, so the install's OS integration (desktop entries, icons) lands
// in this run's directory and never in the user's; no herdr session is opened.
// The sidebar offers no Install app at any point: it kept showing in every tab of a browser that had
// the app installed and in browsers that never prompt. Settings → Phone & devices → Install offers it:
// the button while the browser holds a prompt, the steps while it holds none, Installed once it is.
// HEADED=1 (under xvfb-run where there is no display) runs the same steps in a window.
const root = mkdtempSync(join(tmpdir(), "herdr-install-state-demo-"));
const app = join(root, "app");
const profile = join(root, "profile");
const home = join(root, "home");
const realApplications = join(process.env["XDG_DATA_HOME"] || join(homedir(), ".local/share"), "applications");
const started = Date.now();
const headless = process.env["HEADED"] !== "1";

const newRealDesktopEntries = (): string[] => existsSync(realApplications)
  ? readdirSync(realApplications).filter((name) => /^chrome-.*\.desktop$/.test(name) && statSync(join(realApplications, name)).mtimeMs >= started)
  : [];

const ready = async (page: Page): Promise<void> => {
  await page.locator(".conn-live").waitFor({ state: "attached" });
  await page.locator(".sidebar-footer").waitFor();
  await assertNoSidebarInstall(page);
};
// by its words or by a name alone (an icon-only button labelled Install app counts too)
const assertNoSidebarInstall = async (page: Page): Promise<void> => {
  const sidebar = page.locator(".sidebar-shell");
  assert.equal(await sidebar.getByText(/install app/i).count() + await sidebar.getByRole("button", { name: /install/i }).count(), 0, "the sidebar offers no Install app");
};
// installHelp() for desktop Chromium over loopback (src/lib/install.ts)
const CHROMIUM_HELP = "Use the install icon in the address bar, or the browser menu's Install option.";
/** Settings → Phone & devices → Install, opened in this page. */
const installRow = async (page: Page): Promise<Locator> => {
  await page.keyboard.press("ControlOrMeta+Shift+Comma");
  await openSettingsPage(page, "Phone & devices");
  return page.locator(".settings-row").filter({ has: page.locator(".settings-label", { hasText: /^Install$/ }) });
};
const installButton = (row: Locator): Locator => row.getByRole("button", { name: "Install app", exact: true });
const relatedApps = (page: Page): Promise<number> =>
  page.evaluate(async () => (await (navigator as Navigator & { getInstalledRelatedApps(): Promise<unknown[]> }).getInstalledRelatedApps()).length);
const nextPage = async (context: BrowserContext, open: () => Promise<unknown>): Promise<Page> => {
  const opened = context.waitForEvent("page", { timeout: 15_000 });
  await open();
  const page = await opened;
  await page.waitForLoadState();
  return page;
};
const send = <T>(cdp: CDPSession, method: string, params: Record<string, unknown>): Promise<T> =>
  (cdp.send as unknown as (method: string, params: Record<string, unknown>) => Promise<T>)(method, params);
const shot = async (page: Page, name: string): Promise<void> => {
  const dir = process.env["UI_EVIDENCE_DIR"];
  if (dir) await page.screenshot({ path: join(dir, `install-state-${name}.png`) });
};

let failed = false;
try {
  mkdirSync(home);
  await buildDemoApp(app);
  const index = join(app, "index.html");
  writeFileSync(index, readFileSync(index, "utf8").replace(/<script type="module"/, () => `<script src="./demo-transport.js"></script>\n    <script type="module"`));
  const manifest = readFileSync(join(app, "manifest.webmanifest"), "utf8");
  let origin = "";
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    let file: string;
    try { file = decodeURIComponent(new URL(request.url).pathname.slice(1)); }
    catch { return new Response("bad path", { status: 400 }); }
    if (!file || file.endsWith("/")) file += "index.html";
    if (file.split("/").includes("..") || file.includes("\\")) return new Response("bad path", { status: 400 });
    // the production path the server answers the manifest with (server/static.ts)
    if (file === "manifest.webmanifest") return new Response(manifestBody(manifest, origin), { headers: { "content-type": "application/manifest+json" } });
    const body = Bun.file(join(app, file));
    return await body.exists() ? new Response(body) : new Response("not found", { status: 404 });
  } });
  origin = `http://127.0.0.1:${server.port}`;
  const manifestId = `${origin}/`;
  try {
    const context = await chromium.launchPersistentContext(profile, {
      executablePath: process.env["CHROME_PATH"] ?? chromium.executablePath(),
      headless,
      args: ["--no-sandbox"],
      viewport: { width: 1280, height: 800 },
      locale: "en-US",
      env: { ...process.env, HOME: home, XDG_DATA_HOME: join(home, ".local/share"), XDG_CONFIG_HOME: join(home, ".config"), XDG_CACHE_HOME: join(home, ".cache") },
    });
    try {
      // Chromium may offer its own install prompt on any page of an installable origin, at a time of
      // its choosing: the steps below decide whether a prompt is there, so a trusted one is held back.
      await context.addInitScript(() => {
        addEventListener("beforeinstallprompt", (event) => { if (event.isTrusted) event.stopImmediatePropagation(); }, { capture: true });
      });
      const browser = context.browser();
      assert.ok(browser, "a persistent context exposes its browser for the browser-level PWA domain");
      const cdp = await browser.newBrowserCDPSession();
      const errors: string[] = [];
      const watch = (page: Page): Page => { page.on("pageerror", (error) => errors.push(`${page.url()}: ${error.message}`)); return page; };

      // spike: the PWA domain installs and uninstalls in this mode at all
      await send(cdp, "PWA.install", { manifestId, installUrlOrBundleUrl: manifestId });
      await send(cdp, "PWA.uninstall", { manifestId });
      console.log(`PASS spike: PWA.install and PWA.uninstall accepted in ${headless ? "headless" : "headed"} Chromium ${browser.version()}`);

      // (a) before the install, with no prompt held: no sidebar Install app; Settings says how to install
      const tab = watch(context.pages()[0] ?? await context.newPage());
      await tab.goto(manifestId);
      await ready(tab);
      assert.equal(await relatedApps(tab), 0, "nothing is installed yet");
      const tabRow = await installRow(tab);
      assert.equal((await tabRow.locator(".settings-description").textContent())?.trim(), CHROMIUM_HELP, "Settings > Install says how to install");
      assert.equal(await installButton(tabRow).count(), 0, "no Install app button without a prompt");
      await shot(tab, "settings-help");
      console.log("PASS (a) before install, without a prompt: no sidebar Install app, Settings > Install shows the steps");

      // (a2) a prompt: Settings' Install app shows it, once, and no help
      const prompted = watch(await context.newPage());
      await prompted.goto(manifestId);
      await ready(prompted);
      await prompted.evaluate(() => {
        const event = Object.assign(new Event("beforeinstallprompt", { cancelable: true }), {
          prompt: () => { const page = window as unknown as { __prompts?: number }; page.__prompts = (page.__prompts ?? 0) + 1; return Promise.resolve(); },
          userChoice: Promise.resolve({ outcome: "dismissed", platform: "web" }),
        });
        window.dispatchEvent(event);
      });
      await assertNoSidebarInstall(prompted);
      const promptedRow = await installRow(prompted);
      assert.equal(await promptedRow.locator(".settings-description").count(), 0, "a prompt shows no help text");
      await installButton(promptedRow).click();
      await prompted.waitForFunction(() => (window as unknown as { __prompts?: number }).__prompts === 1);
      console.log("PASS (a2) with a prompt: no sidebar Install app, Settings' Install app calls prompt() exactly once and shows no help");
      await prompted.close();

      // (b) installed and launched in its own window: no Install app, Settings says Installed.
      // An install through CDP opens in a tab by default; the user setting makes it a window.
      await send(cdp, "PWA.install", { manifestId, installUrlOrBundleUrl: manifestId });
      await send(cdp, "PWA.changeAppUserSettings", { manifestId, displayMode: "standalone" });
      const appWindow = watch(await nextPage(context, () => send(cdp, "PWA.launch", { manifestId })));
      assert.equal(new URL(appWindow.url()).origin, origin);
      await ready(appWindow);
      assert.equal(await appWindow.evaluate(() => matchMedia("(display-mode: standalone)").matches), true, "the app runs in a standalone window");
      const appRow = await installRow(appWindow);
      assert.equal(await appRow.locator(".settings-description").textContent(), "Installed");
      assert.equal(await installButton(appRow).count(), 0, "the app window offers no Install app");
      await shot(appWindow, "app-window");
      console.log("PASS (b) the installed app window: display-mode standalone, no Install app, Settings > Install says Installed");

      // (c) a normal tab of the same origin knows the app is installed (related_applications)
      const related = watch(await nextPage(context, () => send(cdp, "Target.createTarget", { url: manifestId })));
      await ready(related);
      assert.equal(await related.evaluate(() => matchMedia("(display-mode: browser)").matches), true, "this is a browser tab, not the app window");
      const linked = await related.evaluate(async () => (await (await fetch(document.querySelector<HTMLLinkElement>("link[rel=manifest]")!.href)).json()) as { related_applications?: unknown });
      assert.equal(await relatedApps(related), 1, `(c) getInstalledRelatedApps() finds the installed app; the served related_applications: ${JSON.stringify(linked.related_applications)}`);
      const relatedRow = await installRow(related);
      try { await relatedRow.locator(".settings-description", { hasText: /^Installed$/ }).waitFor({ timeout: 10_000 }); }
      catch (error) { throw new Error("(c) Settings in the tab of the installed app does not say Installed", { cause: error }); }
      assert.equal(await installButton(relatedRow).count(), 0, "the tab of the installed app offers no Install app");
      await shot(related, "tab");
      console.log("PASS (c) a tab of the installed origin: getInstalledRelatedApps() has 1 entry, no sidebar Install app, Settings > Install says Installed");

      // (d) after the uninstall a NEW tab is told how to install again (installedByEvent is per page)
      await send(cdp, "PWA.uninstall", { manifestId });
      const after = watch(await context.newPage());
      await after.goto(manifestId);
      await ready(after);
      assert.equal(await relatedApps(after), 0, "nothing is installed after the uninstall");
      const afterRow = await installRow(after);
      assert.equal((await afterRow.locator(".settings-description").textContent())?.trim(), CHROMIUM_HELP, "Settings > Install shows the steps again");
      assert.equal(await installButton(afterRow).count(), 0, "no Install app button without a prompt after the uninstall");
      console.log("PASS (d) after uninstall, a new tab: no sidebar Install app, Settings > Install shows the steps, getInstalledRelatedApps() is empty");
      assert.deepEqual(errors, [], "no page error");
    } finally {
      await context.close();
    }
  } finally {
    server.stop(true);
  }
} catch (error) {
  failed = true;
  console.error("FAIL", error);
} finally {
  const running = Bun.spawnSync(["pgrep", "-f", profile]).stdout.toString().trim();
  rmSync(root, { recursive: true, force: true });
  const entries = newRealDesktopEntries();
  const cleanup: Array<[string, boolean, string]> = [
    ["no browser process on the run's profile", running === "", running],
    ["the run's profile, HOME and XDG dirs are removed", !existsSync(root), root],
    [`no new chrome-*.desktop in ${realApplications}`, entries.length === 0, entries.join(", ")],
  ];
  for (const [name, ok, detail] of cleanup) {
    if (ok) console.log(`PASS cleanup: ${name}`);
    else { failed = true; console.error(`FAIL cleanup: ${name}: ${detail}`); }
  }
}
if (failed) process.exit(1);
