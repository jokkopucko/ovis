/**
 * The app on a browser older than the built-ins it calls (#2513): it runs from Safari 16.4, so each
 * newer one it uses must be there by the time a module runs (src/lib/builtins.ts). Each page here
 * loses those built-ins before the app's script runs, as Safari 16.4 to 17.3 lacks them, and a chat
 * pane and a terminal pane must both draw with no "can't be shown" and no uncaught error. No herdr
 * session and no user state: the demo build on a loopback server on port 0 under the app's
 * Content-Security-Policy, and a temporary directory removed at the end.
 *
 * UI_EVIDENCE_DIR=<dir>: also writes a screenshot of each pane.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, devices, type Browser } from "playwright-core";
import panes from "../site/demo/fixtures/panes.json";
import { CONTENT_SECURITY_POLICY } from "../server/static.ts";
import { chromePath } from "./chrome-path.ts";
import { buildDemoApp } from "./demo-build.ts";

const PREFIX = "/herdr-web-ui/demo/app/";
const evidence = process.env["UI_EVIDENCE_DIR"] || null;
const app = mkdtempSync(join(tmpdir(), "herdr-old-safari-"));

/**
 * What each browser lacks of the built-ins the app calls. iOS 16 (the last on an iPhone 8) lacks
 * the two that came in Safari 17.4; on a plain-http address, which is no secure context, any
 * browser also lacks crypto.randomUUID. Before 16.4 (`lookbehind`) Safari cannot parse a
 * lookbehind either (#2534): the build hands every regular expression with one to `RegExp`, which
 * then throws as Safari does.
 */
const BROWSERS = [
  { name: "ios-16", gone: ["Promise.withResolvers", "AbortSignal.any"], lookbehind: true },
  { name: "ios-16-plain-http", gone: ["Promise.withResolvers", "AbortSignal.any", "Crypto.prototype.randomUUID"], lookbehind: true },
  { name: "ios-16.0", gone: ["Promise.withResolvers", "AbortSignal.any"], lookbehind: false },
];
const PANES = [
  { name: "chat", pane: panes.omp, drawn: ".pane-frame.is-current .chat-turn" },
  { name: "terminal", pane: panes.shell, drawn: ".pane-frame.is-current .xterm-rows" },
];
const failures: string[] = [];

let browser: Browser | null = null;
let server: ReturnType<typeof Bun.serve> | null = null;
try {
  await buildDemoApp(app);
  const index = join(app, "index.html");
  // the built-ins go after the demo's transport, which needs randomUUID as it loads, and before the
  // app: a file of the page's own, as the Content-Security-Policy allows no inline script
  writeFileSync(join(app, "old-browser.js"), `{
    const owners = { Promise, AbortSignal, "Crypto.prototype": Crypto.prototype };
    for (const path of window.oldBrowserLacks.gone) {
      const dot = path.lastIndexOf(".");
      delete owners[path.slice(0, dot)][path.slice(dot + 1)];
    }
    if (!window.oldBrowserLacks.lookbehind) {
      const lookbehind = /(?:^|[^\\\\])(?:\\\\\\\\)*\\(\\?<[=!]/;
      const parse = (args) => {
        if (typeof args[0] === "string" && lookbehind.test(args[0])) throw new SyntaxError("Invalid regular expression: invalid group specifier name");
        return args;
      };
      window.RegExp = new Proxy(RegExp, {
        construct: (target, args, newTarget) => Reflect.construct(target, parse(args), newTarget),
        apply: (target, self, args) => Reflect.apply(target, self, parse(args)),
      });
    }
  }\n`);
  writeFileSync(index, readFileSync(index, "utf8").replace(/<script type="module"/, () => `<script src="./demo-transport.js"></script>\n    <script src="./old-browser.js"></script>\n    <script type="module"`));
  server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const csp = { "content-security-policy": CONTENT_SECURITY_POLICY };
    const path = new URL(request.url).pathname;
    if (!path.startsWith(PREFIX)) return new Response("not found", { status: 404, headers: csp });
    let file: string;
    try { file = decodeURIComponent(path.slice(PREFIX.length)); }
    catch { return new Response("bad path", { status: 400, headers: csp }); }
    if (!file || file.endsWith("/")) file += "index.html";
    if (file.split("/").includes("..") || file.includes("\\")) return new Response("bad path", { status: 400, headers: csp });
    const body = Bun.file(join(app, file));
    return (await body.exists()) ? new Response(body, { headers: { ...csp, "content-type": body.type } }) : new Response("not found", { status: 404, headers: csp });
  } });
  browser = await chromium.launch({ executablePath: chromePath(), headless: true, args: ["--no-sandbox"] });

  for (const old of BROWSERS) for (const item of PANES) {
    const label = `${old.name} ${item.name}`;
    const context = await browser.newContext({ ...devices["iPhone 14"], locale: "en-US", serviceWorkers: "block" });
    try {
      await context.addInitScript((lacks) => {
        localStorage.setItem("ovis:settings", JSON.stringify({ language: "en" }));
        (window as unknown as { oldBrowserLacks: typeof lacks }).oldBrowserLacks = lacks;
      }, { gone: old.gone, lookbehind: old.lookbehind });
      const page = await context.newPage();
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(`http://127.0.0.1:${server.port}${PREFIX}?pane=${encodeURIComponent(item.pane)}`);
      // drawn, or a part of the page that says it can't be shown: whichever comes first
      const outcome = await page.waitForFunction((drawn) => {
        if (/can.t be shown/.test(document.body.innerText)) return "a part of the page can't be shown";
        return document.querySelector(drawn) ? "drawn" : null;
      }, item.drawn, { timeout: 15_000 }).then((handle) => handle.jsonValue(),
        async () => `nothing drawn in 15 s; the page reads ${JSON.stringify((await page.evaluate(() => document.body.innerText)).slice(0, 300))}, errors ${JSON.stringify(errors)}`);
      if (evidence) {
        mkdirSync(evidence, { recursive: true });
        await page.screenshot({ path: join(evidence, `old-safari-${old.name}-${item.name}.png`) });
      }
      if (outcome !== "drawn") failures.push(`${label}: ${outcome}`);
      else if (errors.length > 0) failures.push(`${label}: uncaught errors ${JSON.stringify(errors)}`);
      else console.log(`old safari: the ${item.name} pane draws without what ${old.name} lacks (${[...old.gone, ...(old.lookbehind ? [] : ["lookbehind"])].join(", ")})`);
    } finally { await context.close(); }
  }
  assert.deepEqual(failures, [], "panes on older browsers");
} finally {
  await browser?.close();
  await server?.stop(true);
  rmSync(app, { recursive: true, force: true });
}
