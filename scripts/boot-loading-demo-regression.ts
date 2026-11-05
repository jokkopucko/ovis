/**
 * The page says it is loading while the app's script is on its way (#2329): on a slow link the entry
 * module takes seconds, and a page that shows nothing until it runs looks frozen. Per case the entry
 * module is held by a request gate, as a slow link holds it: a loading status must show in the page
 * (index.html's own markup, under the app's Content-Security-Policy), turn once a step, keep still
 * under reduced motion, and be gone once the app has drawn. No herdr session and no user state: the
 * demo build on a loopback server on port 0 and a temporary directory, removed at the end.
 *
 * UI_EVIDENCE_DIR=<dir>: also writes a screenshot of each case while the app is held.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, devices, type Browser, type BrowserContextOptions } from "playwright-core";
import { CONTENT_SECURITY_POLICY } from "../server/static.ts";
import { chromePath } from "./chrome-path.ts";
import { buildDemoApp } from "./demo-build.ts";

const PREFIX = "/herdr-web-ui/demo/app/";
const evidence = process.env["UI_EVIDENCE_DIR"] || null;
const app = mkdtempSync(join(tmpdir(), "herdr-boot-loading-"));

interface Case { name: string; context: BrowserContextOptions; reducedMotion?: boolean; settings?: Record<string, string> }
const CASES: Case[] = [
  { name: "phone", context: { ...devices["iPhone 14"] } },
  { name: "desktop", context: { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 } },
  { name: "phone, reduced motion", context: { ...devices["iPhone 14"] }, reducedMotion: true },
  { name: "phone, saved light theme", context: { ...devices["iPhone 14"] }, settings: { theme: "light" } },
];

/** the ring's color per case: a saved light theme must not draw the dark one's */
const rings = new Map<string, string>();
let browser: Browser | null = null;
let server: ReturnType<typeof Bun.serve> | null = null;
try {
  await buildDemoApp(app);
  const index = join(app, "index.html");
  writeFileSync(index, readFileSync(index, "utf8").replace(/<script type="module"/, () => `<script src="./demo-transport.js"></script>\n    <script type="module"`));
  server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const csp = { "content-security-policy": CONTENT_SECURITY_POLICY };
    const path = new URL(request.url).pathname;
    if (!path.startsWith(PREFIX)) return new Response("not found", { status: 404, headers: csp });
    let file = decodeURIComponent(path.slice(PREFIX.length));
    if (!file || file.endsWith("/")) file += "index.html";
    if (file.split("/").includes("..") || file.includes("\\")) return new Response("bad path", { status: 400, headers: csp });
    const body = Bun.file(join(app, file));
    return (await body.exists()) ? new Response(body, { headers: { ...csp, "content-type": body.type } }) : new Response("not found", { status: 404, headers: csp });
  } });
  const url = `http://127.0.0.1:${server.port}${PREFIX}`;
  browser = await chromium.launch({ executablePath: chromePath(), headless: true, args: ["--no-sandbox"] });

  for (const item of CASES) {
    const context = await browser.newContext({ ...item.context, locale: "en-US", serviceWorkers: "block", reducedMotion: item.reducedMotion ? "reduce" : "no-preference" });
    try {
      await context.addInitScript((settings) => {
        localStorage.setItem("ovis:settings", JSON.stringify({ language: "en", ...settings }));
        const seen = { violations: [] as string[] };
        (window as unknown as { __seen: typeof seen }).__seen = seen;
        document.addEventListener("securitypolicyviolation", (event) => seen.violations.push(`${event.violatedDirective} ${event.blockedURI}`));
      }, item.settings ?? {});
      const page = await context.newPage();
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      let release = (): void => undefined;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      await page.route((address) => /\/assets\/index-[\w-]+\.js$/.test(address.pathname), async (route) => { await gate; await route.continue(); });
      // a face asked for while the app is held downloads beside its script, on the same slow link
      const heldFonts: string[] = [];
      let held = true;
      page.on("request", (request) => { if (held && request.resourceType() === "font") heldFonts.push(request.url()); });
      await page.goto(url, { waitUntil: "commit" });

      // the app's script is held: the page itself must say it is loading, drawn and opaque
      const status = page.locator("#root > [role='status']");
      await status.waitFor({ state: "attached", timeout: 10_000 }).catch(() => {
        throw new Error(`${item.name}: nothing on the page says it is loading while the app's script is on its way`);
      });
      await page.waitForFunction(() => {
        const node = document.querySelector("#root > [role='status']");
        if (!node) return false;
        const box = node.getBoundingClientRect();
        return getComputedStyle(node).opacity === "1" && box.width > 0 && box.height > 0;
      }, undefined, { timeout: 10_000 });
      // a status is announced by its words, not its name: the ring is decoration
      assert.equal((await status.textContent())?.trim(), "Loading Ovis", `${item.name}: the status says what is loading`);
      assert.equal(await status.locator(".boot-spinner").getAttribute("aria-hidden"), "true", `${item.name}: the ring is hidden from screen readers`);
      const shown = await page.evaluate(() => {
        const node = document.querySelector("#root > [role='status']")!;
        const spinner = node.querySelector(".boot-spinner");
        const outer = getComputedStyle(node);
        const style = spinner ? getComputedStyle(spinner) : null;
        const box = spinner?.getBoundingClientRect();
        return { window: [innerWidth, innerHeight], show: { name: outer.animationName, delay: parseFloat(outer.animationDelay) * (outer.animationDelay.endsWith("ms") ? 1 : 1000) },
          spinner: style && box ? { center: [box.left + box.width / 2, box.top + box.height / 2], width: box.width, animation: style.animationName, timing: style.animationTimingFunction, iterations: style.animationIterationCount, border: style.borderTopColor } : null };
      });
      assert.ok(shown.spinner, `${item.name}: the status draws a spinner`);
      assert.ok(shown.spinner.width > 0, `${item.name}: the spinner has a size`);
      assert.ok(Math.abs(shown.spinner.center[0]! - shown.window[0]! / 2) <= 2 && Math.abs(shown.spinner.center[1]! - shown.window[1]! / 2) <= 2, `${item.name}: the spinner sits in the middle of the window (${shown.spinner.center.join(",")} in ${shown.window.join("x")})`);
      // a fast start does not flash it: it shows only after a moment
      assert.equal(shown.show.name, "boot-show", `${item.name}: the status waits before it shows`);
      assert.ok(shown.show.delay >= 300 && shown.show.delay <= 1000, `${item.name}: the status shows after a moment, and within a second (${shown.show.delay} ms)`);
      rings.set(item.name, shown.spinner.border);
      if (item.reducedMotion) assert.equal(shown.spinner.animation, "none", `${item.name}: under reduced motion the spinner keeps still`);
      else {
        assert.notEqual(shown.spinner.animation, "none", `${item.name}: the spinner turns`);
        assert.equal(shown.spinner.iterations, "infinite", `${item.name}: the spinner turns until the app comes`);
        assert.match(shown.spinner.timing, /^steps\(/, `${item.name}: the spinner turns in steps, not at every display refresh`);
      }
      if (evidence) {
        mkdirSync(evidence, { recursive: true });
        await page.screenshot({ path: join(evidence, `boot-loading-${item.name.replace(/\W+/g, "-")}.png`) });
      }

      assert.deepEqual(heldFonts, [], `${item.name}: the status asks for no font while the app's script is on its way`);

      // the app comes: it draws over the status, which is gone with its first frame
      held = false;
      release();
      await page.locator(".app").first().waitFor({ timeout: 30_000 });
      assert.equal(await page.locator("#root > [role='status']").count(), 0, `${item.name}: the loading status is gone once the app draws`);
      const seen = await page.evaluate(() => (window as unknown as { __seen: { violations: string[] } }).__seen);
      assert.deepEqual(seen.violations, [], `${item.name}: no CSP violation`);
      assert.deepEqual(errors, [], `${item.name}: no page error`);
      console.log(`PASS ${item.name}: a loading status while the app's script is held, gone once the app draws`);
    } finally {
      await context.close();
    }
  }
} finally {
  await browser?.close();
  await server?.stop(true);
  rmSync(app, { recursive: true, force: true });
}
assert.notEqual(rings.get("phone, saved light theme"), rings.get("phone"), "the ring takes the saved theme's colors");
console.log(`boot loading: ${CASES.length} cases`);
