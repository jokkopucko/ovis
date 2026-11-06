/**
 * Settings → Devices and PCs → My devices on the unmodified app over the demo's fixture transport, the
 * relay on: the same Wi-Fi direct connection row says it is on and who can sign in there, its switch turns
 * it off (the row says so) and on again. At 390 and 1280, light and dark.
 *
 * UI_EVIDENCE_DIR: relay-direct-<390|1280>-<light|dark>.png.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser } from "playwright-core";
import { buildDemoApp } from "./demo-build.ts";
import { chromePath } from "./chrome-path.ts";
import { openSettingsPage } from "./settings-page.ts";

const EVIDENCE = process.env.UI_EVIDENCE_DIR;

async function run(browser: Browser, origin: string, width: number, theme: "light" | "dark"): Promise<void> {
  const phone = width === 390;
  const tag = `${width} ${theme}`;
  const context = await browser.newContext({ viewport: { width, height: phone ? 844 : 900 }, ...(phone ? { deviceScaleFactor: 3, isMobile: true, hasTouch: true } : {}), locale: "en-US" });
  await context.addInitScript((settings) => localStorage.setItem("ovis:settings", settings), JSON.stringify({ language: "en", theme }));
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${origin}?demo_relay=on`);
  await page.locator(".conn-live").waitFor();
  await page.keyboard.press("ControlOrMeta+Shift+Comma");
  await openSettingsPage(page, "Devices and PCs");
  const group = page.locator('[data-section="devices"]');
  await group.getByText("Same Wi-Fi direct connection on", { exact: true }).waitFor();
  await group.getByText("Only devices paired through the relay can sign in there; nothing new pairs.", { exact: false }).waitFor();
  const toggle = group.getByRole("switch", { name: "Same Wi-Fi direct connection" });
  assert.equal(await toggle.getAttribute("aria-checked"), "true", `${tag}: on by default`);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, `${tag}: no sideways scroll`);
  await group.scrollIntoViewIfNeeded();
  if (EVIDENCE) await group.screenshot({ path: join(EVIDENCE, `relay-direct-${width}-${theme}.png`) });

  await toggle.click();
  await group.getByText("Same Wi-Fi direct connection off", { exact: true }).waitFor();
  assert.equal(await toggle.getAttribute("aria-checked"), "false", `${tag}: turned off`);
  await toggle.click();
  await group.getByText("Same Wi-Fi direct connection on", { exact: true }).waitFor();
  assert.deepEqual(errors, [], `${tag}: no page errors`);
  await context.close();
  console.log(`PASS relay direct ${tag}`);
}

const app = mkdtempSync(join(tmpdir(), "ovis-relay-direct-demo-"));
try {
  await buildDemoApp(app);
  const index = join(app, "index.html");
  const html = readFileSync(index, "utf8");
  assert.match(html, /<script type="module"/);
  writeFileSync(index, html.replace(/<script type="module"/, () => `<script src="./demo-transport.js"></script>\n    <script type="module"`));
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const prefix = "/herdr-web-ui/demo/app/";
    const path = new URL(request.url).pathname;
    if (!path.startsWith(prefix)) return new Response("not found", { status: 404 });
    let file: string;
    try { file = decodeURIComponent(path.slice(prefix.length)); } catch { return new Response("bad path", { status: 400 }); }
    if (!file || file.endsWith("/")) file += "index.html";
    if (file.split("/").includes("..") || file.includes("\\")) return new Response("bad path", { status: 400 });
    const body = Bun.file(join(app, file));
    return await body.exists() ? new Response(body) : new Response("not found", { status: 404 });
  } });
  try {
    if (EVIDENCE) mkdirSync(EVIDENCE, { recursive: true });
    const browser = await chromium.launch({ executablePath: chromePath(), headless: true, args: ["--no-sandbox"] });
    try {
      const origin = `http://127.0.0.1:${server.port}/herdr-web-ui/demo/app/`;
      for (const [width, theme] of [[390, "light"], [390, "dark"], [1280, "light"], [1280, "dark"]] as const) await run(browser, origin, width, theme);
    } finally { await browser.close(); }
  } finally { server.stop(true); }
} finally {
  rmSync(app, { recursive: true, force: true });
}
