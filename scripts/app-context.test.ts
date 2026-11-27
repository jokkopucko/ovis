import { afterAll, afterEach, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import { appContext, installClock } from "./app-context.ts";
import { chromePath } from "./chrome-path.ts";
import { withDemoBrowser } from "./demo-browser.ts";

// skipped, not failed, on a machine with no browser to drive (the browser lane always has one)
const noBrowser = !existsSync(chromePath());
setDefaultTimeout(30_000);

/** A page on a secure origin (127.0.0.1) with a worker to register: what the app's own page is to a script. */
const site = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
  const path = new URL(request.url).pathname;
  if (path === "/sw.js") return new Response("self.addEventListener('install', () => self.skipWaiting());", { headers: { "content-type": "text/javascript" } });
  return new Response("<!doctype html><title>app</title>", { headers: { "content-type": "text/html; charset=utf-8" } });
} });
const origin = `http://127.0.0.1:${site.port}/`;

let browser: Browser;
const opened: BrowserContext[] = [];
// A Korean machine, for every browser this file starts: headless Chromium reads LANGUAGE, and a context with no
// language of its own would read Korean from it.
const machine = { LANGUAGE: process.env["LANGUAGE"], HERDR_DEMO_BUILD: process.env["HERDR_DEMO_BUILD"] };
beforeAll(async () => {
  process.env["LANGUAGE"] = "ko_KR:ko";
  if (!noBrowser) browser = await chromium.launch({ executablePath: chromePath(), args: ["--no-sandbox"] });
});
afterEach(async () => { await Promise.all(opened.splice(0).map((context) => context.close())); });
afterAll(async () => {
  for (const [name, value] of Object.entries(machine)) if (value === undefined) delete process.env[name]; else process.env[name] = value;
  await browser?.close();
  await site.stop(true);
});

async function pageOf(context: BrowserContext): Promise<Page> {
  opened.push(context);
  const page = await context.newPage();
  await page.goto(origin);
  return page;
}

/** What the page reads: whether a worker it registers is one, how many it has, and its language. */
const seen = (page: Page) => page.evaluate(async () => {
  const registration = await navigator.serviceWorker.register("/sw.js");
  return { registered: registration !== undefined, workers: (await navigator.serviceWorker.getRegistrations()).length, language: navigator.language, format: new Intl.NumberFormat().resolvedOptions().locale };
});

/** A stand-in for the built demo (HERDR_DEMO_BUILD is the build the browser lane shares): the session is under test, not the client. */
async function withStandInBuild(run: () => Promise<void>): Promise<void> {
  const build = mkdtempSync(join(tmpdir(), "ovis-app-context-build-"));
  try {
    writeFileSync(join(build, "index.html"), "<!doctype html><title>demo</title>\n    <script type=\"module\">(window.loaded ??= []).push(\"app\");</script>");
    writeFileSync(join(build, "demo-transport.js"), "(window.loaded ??= []).push(\"transport\");");
    process.env["HERDR_DEMO_BUILD"] = build;
    await run();
  } finally {
    rmSync(build, { recursive: true, force: true });
  }
}

describe("the shared browser context", () => {
  test.skipIf(noBrowser)("registers no service worker and reads English, whatever the machine's language", async () => {
    expect(await seen(await pageOf(await appContext(browser)))).toEqual({ registered: false, workers: 0, language: "en-US", format: "en-US" });
  });

  test.skipIf(noBrowser)("takes a script's own options over the defaults, key by key", async () => {
    expect(await seen(await pageOf(await appContext(browser, { serviceWorkers: "allow" })))).toEqual({ registered: true, workers: 1, language: "en-US", format: "en-US" });
    expect(await seen(await pageOf(await appContext(browser, { locale: "ja-JP" })))).toEqual({ registered: false, workers: 0, language: "ja-JP", format: "ja-JP" });
  });

  test.skipIf(noBrowser)("is what a demo script's session opens, on a page with the script's snippets around the transport", async () => {
    await withStandInBuild(async () => {
      const snippets = { beforeTransport: "<script>(window.loaded ??= []).push(\"before\");</script>", afterTransport: "<script>window.loaded.push(\"after\");</script>" };
      await withDemoBrowser({ tempPrefix: "ovis-app-context-", ...snippets }, async ({ newContext, baseUrl }) => {
        const context = await newContext({ viewport: { width: 390, height: 844 } });
        const page = await context.newPage();
        await page.goto(baseUrl);
        expect(await page.evaluate(async () => ({ registered: await navigator.serviceWorker.register("./demo-transport.js") !== undefined, language: navigator.language, width: window.innerWidth, loaded: (window as unknown as { loaded: string[] }).loaded })))
          .toEqual({ registered: false, language: "en-US", width: 390, loaded: ["before", "transport", "after", "app"] });
      });
    });
  });

  test.skipIf(noBrowser)("serves the demo through a script's own server when it has one, under the script's prefix", async () => {
    await withStandInBuild(async () => {
      const serve = (app: string) => Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
        const file = Bun.file(join(app, new URL(request.url).pathname.replace(/^\/own\//, "") || "index.html"));
        return (await file.exists()) ? new Response(file, { headers: { "x-own-server": "1" } }) : new Response("not found", { status: 404 });
      } });
      await withDemoBrowser({ tempPrefix: "ovis-app-context-", prefix: "/own/", serve }, async ({ newContext, baseUrl }) => {
        const page = await (await newContext()).newPage();
        const response = await page.goto(baseUrl);
        expect([new URL(baseUrl).pathname, response?.headers()["x-own-server"], await page.title()]).toEqual(["/own/", "1", "demo"]);
      });
    });
  });
});

describe("the fake clock", () => {
  test.skipIf(noBrowser)("starts before the page loads anything, and is refused under a loaded page", async () => {
    const context = await appContext(browser);
    opened.push(context);
    const page = await context.newPage();
    await installClock(page, { time: new Date("2001-02-03T04:05:06Z") });
    await page.goto(origin);
    expect(await page.evaluate(() => new Date().getUTCFullYear())).toBe(2001);
    await expect(installClock(page)).rejects.toThrow("before the page loads anything");
  });

  test.skipIf(noBrowser)("is refused under a document set with setContent, whose address is still about:blank", async () => {
    const context = await appContext(browser);
    opened.push(context);
    const page = await context.newPage();
    await page.setContent("<script>window.started = setInterval(() => {}, 1000);</script>");
    expect([page.url(), await page.evaluate(() => typeof (window as unknown as { started: unknown }).started)]).toEqual(["about:blank", "number"]);
    await expect(installClock(page)).rejects.toThrow("before the page loads anything");
  });

  test.skipIf(noBrowser)("is refused under a setContent whose script left no node behind", async () => {
    const context = await appContext(browser);
    opened.push(context);
    const page = await context.newPage();
    await page.setContent("<script>window.started = setInterval(() => {}, 1000); document.currentScript.remove();</script>");
    expect([page.url(), await page.evaluate(() => document.head.childNodes.length + document.body.childNodes.length), await page.evaluate(() => typeof (window as unknown as { started: unknown }).started)]).toEqual(["about:blank", 0, "number"]);
    await expect(installClock(page)).rejects.toThrow("before the page loads anything");
  });
});
