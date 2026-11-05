/**
 * The agent entry points for people who already use Ovis, on the unmodified app over the demo's
 * fixture transport (no herdr), at 1280 and 390, dark and light:
 *
 * - New workspace's agent picker ends with Add another agent…, which shows only the catalog agents
 *   the demo PC lacks, as the setup guide's tiles; a tap on Install asks the PC (the demo refuses, and
 *   the tile says so), and Back returns the focus to the picker. New worktree's picker ends with the
 *   same row.
 * - Settings → Agents starts with the setup guide's row, then lists the agents on this PC (with
 *   versions; herdr's session resume inside each row) and Install another agent (the tiles); there
 *   is no Sign in. Open setup guide closes Settings and opens the guide again (lib/setupGuide.ts).
 * - A device that only watches (`?demo_devices=watch`) gets no Add another agent…, no Install and no
 *   Open setup guide: an install types into a terminal on the PC, which it may not do.
 *
 * With UI_EVIDENCE_DIR, each step is captured under agent-entry-points/.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright-core";
import panes from "../site/demo/fixtures/panes.json";
import { buildDemoApp } from "./demo-build.ts";
import { chromePath } from "./chrome-path.ts";

const app = mkdtempSync(join(tmpdir(), "ovis-agent-entry-"));
const evidence = process.env["UI_EVIDENCE_DIR"] ? join(process.env["UI_EVIDENCE_DIR"], "agent-entry-points") : null;
if (evidence) mkdirSync(evidence, { recursive: true });
/** the agents the demo PC has (site/demo/fixtures.ts DEMO_INSTALLED), in the catalog's order */
const INSTALLED = ["Claude Code", "Codex", "Oh My Pi", "pi", "Hermes"];
const ADD_ROW = "Add another agent…";
const settled = (page: Page) => page.evaluate(() => Promise.all(document.getAnimations().map((animation) => animation.finished.catch(() => undefined))).then(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done())))));

let server: ReturnType<typeof Bun.serve> | undefined;
let browser: Browser | undefined;
try {
  await buildDemoApp(app);
  const index = join(app, "index.html");
  writeFileSync(index, readFileSync(index, "utf8").replace(/<script type="module"/, () => `<script src="./demo-transport.js"></script>\n    <script type="module"`));
  server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
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
  const root = `http://127.0.0.1:${server.port}/herdr-web-ui/demo/app/?pane=${encodeURIComponent(panes.api)}`;
  browser = await chromium.launch({ executablePath: chromePath(), headless: true, args: ["--no-sandbox"] });
  for (const width of [1280, 390] as const) {
    for (const theme of ["dark", "light"] as const) {
      const at = `${width}-${theme}`;
      const context = await browser.newContext(width === 390
        ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3, locale: "en-US", colorScheme: theme }
        : { viewport: { width: 1280, height: 800 }, locale: "en-US", colorScheme: theme });
      await context.addInitScript((value) => { localStorage.setItem("ovis:settings", JSON.stringify({ language: "en", theme: value, palette: "codex", darkTheme: "codex", lightTheme: "codex" })); }, theme);
      const page = await context.newPage();
      page.setDefaultTimeout(10_000);
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      const shot = async (name: string): Promise<void> => {
        if (!evidence) return;
        await settled(page);
        await page.screenshot({ path: join(evidence, `${name}-${at}.png`) });
      };
      const press = (locator: ReturnType<Page["locator"]>) => width === 390 ? locator.tap() : locator.click();
      try {
        const base = `${root}&demo_devices=empty`;
        // New workspace: the row is the picker's last, its tiles are what the PC lacks
        await page.goto(`${base}&new=workspace`);
        const dialog = page.getByRole("dialog", { name: /^New workspace · / });
        await dialog.waitFor();
        await press(dialog.locator(".agent-picker-trigger"));
        const options = page.getByRole("option");
        await options.last().waitFor();
        assert.equal((await options.last().textContent())?.trim(), ADD_ROW, `the picker's last row ${at}`);
        await options.last().scrollIntoViewIfNeeded();
        await shot("1-picker");
        await press(options.last());
        await dialog.locator(".add-agent .setup-tile").first().waitFor();
        const names = await dialog.locator(".add-agent .setup-found-name strong").allTextContents();
        assert.ok(names.length > 0 && names.every((name) => !INSTALLED.includes(name)), `only agents the demo PC lacks: ${names.join(", ")} ${at}`);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, `no sideways scroll ${at}`);
        await page.waitForFunction(() => document.activeElement?.classList.contains("setup-tile-install") ?? false);
        await shot("2-add-tiles");
        // the one tap asks the PC to install; the demo refuses, and the tile and the line say so
        await press(dialog.getByRole("button", { name: `Install ${names[0]}`, exact: true }));
        await dialog.locator(".add-agent [role='alert']").waitFor();
        assert.match((await dialog.locator(".add-agent [role='alert']").textContent()) ?? "", /The demo installs nothing/, `a refused install says why ${at}`);
        assert.equal(await dialog.getByRole("button", { name: `Try installing ${names[0]} again`, exact: true }).count(), 1, `the tile offers Try again ${at}`);
        await shot("3-add-refused");
        await press(dialog.getByRole("button", { name: "Back", exact: true }));
        await dialog.locator(".agent-picker-trigger").waitFor();
        await page.waitForFunction(() => document.activeElement?.classList.contains("agent-picker-trigger") ?? false);
        await page.keyboard.press("Escape");
        await dialog.waitFor({ state: "detached" });
        console.log(`PASS Add another agent… shows ${names.length} agents the PC lacks as tiles, Install asks the PC, and Back returns to the picker (${at})`);

        // Settings → Agents
        await page.goto(`${base}&settings=agents`);
        const body = page.locator(".settings-body:not([hidden])");
        await body.locator(".agents-item").first().waitFor();
        const installed = await body.locator("[data-section='agents-installed'] .agents-item").evaluateAll((rows) => rows.map((row) => ({ name: row.querySelector(".settings-label")?.textContent ?? "", version: row.querySelector(".agents-version")?.textContent ?? "" })));
        assert.deepEqual(installed.map((row) => row.name), INSTALLED, `Installed ${at}`);
        assert.ok(installed.every((row) => /^\d+\.\d+/.test(row.version)), `each installed agent has its version ${at}: ${JSON.stringify(installed)}`);
        await press(body.locator("[data-section='install'] > summary"));
        assert.ok(await body.locator(".settings-agent-tiles .setup-tile-install").count() > 0, `Install another agent has its tiles with Install ${at}`);
        assert.equal(await body.getByRole("button", { name: /^Sign in/ }).count(), 0, `no Sign in ${at}`);
        await press(body.locator(".agents-item[data-agent='codex'] .agents-toggle"));
        assert.ok(await body.locator(".agents-item[data-agent='codex'] code").count() > 0, `herdr's session resume is in the agent's row ${at}`);
        await shot("4-settings-agents");
        await page.evaluate(() => {
          const counted = window as unknown as { asked: number };
          counted.asked = 0;
          window.addEventListener("ovis:open-setup-guide", () => { counted.asked += 1; });
        });
        assert.equal(await page.getByRole("region", { name: "Setup guide", exact: true }).count(), 0, `an existing user's app shows no guide by itself ${at}`);
        await press(body.getByRole("button", { name: "Open setup guide", exact: true }));
        await page.getByRole("dialog", { name: "Settings" }).waitFor({ state: "detached" });
        assert.equal(await page.evaluate(() => (window as unknown as { asked: number }).asked), 1, `Open setup guide asks for the guide once ${at}`);
        // the first-run guide (components/SetupGuide.tsx) answers it: it checks the PC again, then the tiles
        const guide = page.getByRole("region", { name: "Setup guide", exact: true });
        await guide.waitFor();
        await guide.locator(".setup-found .setup-tile").first().waitFor();
        await shot("5-guide-reopened");
        console.log(`PASS Settings lists ${installed.map((row) => `${row.name} ${row.version}`).join(", ")} and the tiles to install; Open setup guide opens the guide (${at})`);

        if (width === 1280) {
          // New worktree, from a repository row's menu
          await page.goto(base);
          const row = page.locator(`.workspace-group[data-workspace="${panes.api.split(":")[0]}"] > .workspace-header .workspace-select`);
          const bounds = (await row.boundingBox())!;
          await row.click({ button: "right", position: { x: 32, y: bounds.height / 2 } });
          await page.getByRole("menuitem", { name: "New worktree", exact: true }).click();
          const worktree = page.getByRole("dialog", { name: /^New worktree · / });
          await worktree.waitFor();
          await worktree.locator(".agent-picker-trigger").click();
          await options.last().waitFor();
          assert.equal((await options.last().textContent())?.trim(), ADD_ROW, `New worktree's last row ${at}`);
          await options.last().scrollIntoViewIfNeeded();
          await shot("6-worktree-picker");
          await options.last().click();
          await worktree.locator(".add-agent .setup-tile").first().waitFor();
          console.log(`PASS New worktree's picker ends with ${ADD_ROW} (${at})`);
        }

        // a device that turns into a watching one (its pairing changed) loses what was already open:
        // the next health answer says role "watch" (site/demo/transport.ts demoSecurity)
        const becomeWatching = () => page.evaluate(() => { sessionStorage.setItem("ovis:demo-security", "watch"); document.dispatchEvent(new Event("visibilitychange")); });
        const driveAgain = () => page.evaluate(() => sessionStorage.removeItem("ovis:demo-security"));
        // Settings: the tiles to install and the guide's row go
        await page.goto(`${base}&settings=agents`);
        await press(body.locator("[data-section='install'] > summary"));
        await body.locator(".settings-agent-tiles .setup-tile-install").first().waitFor();
        await becomeWatching();
        await body.locator(".settings-agent-tiles").waitFor({ state: "detached" });
        assert.equal(await body.getByRole("button", { name: "Open setup guide", exact: true }).count(), 0, `no Open setup guide once watching ${at}`);
        await driveAgain();
        // New workspace: the open Add another agent… panel goes, and the picker offers no row
        await page.goto(`${base}&new=workspace`);
        const opened = page.getByRole("dialog", { name: /^New workspace · / });
        await opened.waitFor();
        await press(opened.locator(".agent-picker-trigger"));
        await options.last().waitFor();
        await press(options.last());
        await opened.locator(".add-agent .setup-tile").first().waitFor();
        await becomeWatching();
        await opened.locator(".add-agent").waitFor({ state: "detached" });
        await press(opened.locator(".agent-picker-trigger"));
        await options.last().waitFor();
        assert.notEqual((await options.last().textContent())?.trim(), ADD_ROW, `no ${ADD_ROW} once watching ${at}`);
        await page.keyboard.press("Escape");
        await driveAgain();
        if (width === 1280) {
          // New worktree is not offered to a watching device: an open one closes
          await page.goto(base);
          const row = page.locator(`.workspace-group[data-workspace="${panes.api.split(":")[0]}"] > .workspace-header .workspace-select`);
          const bounds = (await row.boundingBox())!;
          await row.click({ button: "right", position: { x: 32, y: bounds.height / 2 } });
          await page.getByRole("menuitem", { name: "New worktree", exact: true }).click();
          const worktree = page.getByRole("dialog", { name: /^New worktree · / });
          await worktree.waitFor();
          await worktree.locator(".agent-picker-trigger").click();
          await options.last().click();
          await worktree.locator(".add-agent .setup-tile").first().waitFor();
          await becomeWatching();
          await worktree.waitFor({ state: "detached" });
          await driveAgain();
        }
        console.log(`PASS turning into a watching device takes away the tiles to install, Open setup guide, the Add another agent… panel${width === 1280 ? " and New worktree" : ""} (${at})`);

        // a device that only watches may not type into the PC's terminal: no install anywhere
        await page.goto(`${root}&demo_devices=watch&new=workspace`);
        const watched = page.getByRole("dialog", { name: /^New workspace · / });
        await watched.waitFor();
        await press(watched.locator(".agent-picker-trigger"));
        await options.last().waitFor();
        const offered = (await options.allTextContents()).map((text) => text.trim());
        assert.ok(offered.length > 1, `a watching device still sees the agents ${at}`);
        assert.ok(!offered.includes(ADD_ROW), `a watching device gets no ${ADD_ROW} ${at}: ${offered.join(", ")}`);
        await page.keyboard.press("Escape");
        await page.goto(`${root}&demo_devices=watch&settings=agents`);
        await body.locator(".agents-item").first().waitFor();
        assert.equal(await body.locator(".setup-tile-install").count(), 0, `a watching device gets no Install ${at}`);
        assert.equal(await body.getByRole("button", { name: "Open setup guide", exact: true }).count(), 0, `a watching device gets no Open setup guide ${at}`);
        console.log(`PASS a watching device lists the agents but gets no ${ADD_ROW}, Install or Open setup guide (${at})`);

        assert.deepEqual(errors, [], `no page errors ${at}`);
      } finally {
        await context.close();
      }
    }
  }
} finally {
  await browser?.close();
  server?.stop(true);
  rmSync(app, { recursive: true, force: true });
}
