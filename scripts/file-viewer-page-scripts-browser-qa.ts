/**
 * Browser regression with the real file viewer and the server's real Page renderer: an HTML page is drawn without
 * its scripts until the person asks for them, and beside the pane a page with scripts cannot take the app's keys.
 * `PAGE_SCRIPTS_SHOTS` names a folder for screenshots of each state; `PAGE_SCRIPTS_ENGINE=webkit` runs it on
 * Playwright's WebKit instead of Chrome (CI runs Chrome).
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, webkit } from "playwright-core";
import { fileInfo, fileResponse } from "../server/file-view.ts";
import { chromePath } from "./chrome-path.ts";
import { pngPixel } from "./png-pixel.ts";
import { CONTENT_SECURITY_POLICY } from "../server/static.ts";

const root = mkdtempSync(join(tmpdir(), "ovis-page-scripts-qa-"));
const STATIC = [18, 52, 86], RAN = [20, 120, 60];
/** A page that shows by its colour and to the app around it whether its script ran, and which keys reached it; `grab` also takes the focus over and over. */
const probe = (grab: boolean) => `<!doctype html><html><head><meta charset="utf-8"><title>probe</title>
<style>html,body{margin:0;min-height:100%;background:rgb(${STATIC.join(",")});color:white;font:16px system-ui}h1{margin:0;padding:16px}</style></head>
<body><h1 id="ran">static</h1><input id="field" autofocus aria-label="field in the page">
<script>
document.getElementById("ran").textContent = "script ran";
document.body.style.background = "rgb(${RAN.join(",")})";
document.documentElement.style.background = "rgb(${RAN.join(",")})";
parent.postMessage({ probe: "ran" }, "*");
addEventListener("keydown", (event) => parent.postMessage({ probe: "key", key: event.key }, "*"));
${grab ? `setInterval(() => { window.focus(); document.getElementById("field").focus(); }, 20);` : ""}
</script></body></html>`;
const quiet = join(root, "report.html"), grabber = join(root, "grabber.html"), other = join(root, "other.html");
writeFileSync(quiet, probe(false));
writeFileSync(grabber, probe(true));
writeFileSync(other, probe(false));
const build = await Bun.build({ entrypoints: ["scripts/page-scripts-fixture.tsx"], outdir: root, target: "browser", define: { "process.env.NODE_ENV": '"production"' } });
assert.ok(build.success, String(build.logs));
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
  const url = new URL(request.url);
  const path = url.searchParams.get("path") ?? "";
  if (url.pathname === "/api/fs/stat") { const info = path.startsWith(root) ? fileInfo(path) : null; return info ? Response.json(info) : Response.json({ error: { code: "not_found", message: "not found" } }, { status: 404 }); }
  if (url.pathname === "/api/fs/file" && path.startsWith(root)) return fileResponse(fileInfo(path)!, url.searchParams.get("download") === "1", url.searchParams.get("render") === "1", null, request);
  if (url.pathname === "/") return new Response('<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/page-scripts-fixture.css"></head><body><div id="root"></div><script type="module" src="/page-scripts-fixture.js"></script></body></html>', { headers: { "content-security-policy": CONTENT_SECURITY_POLICY, "content-type": "text/html" } });
  if (/^\/page-scripts-fixture\.(?:js|css)$/.test(url.pathname)) return new Response(Bun.file(join(root, url.pathname.slice(1))));
  return Response.json({ error: { code: "not_found", message: "not found" } }, { status: 404 });
} });
const shots = process.env["PAGE_SCRIPTS_SHOTS"];
if (shots) mkdirSync(shots, { recursive: true });
const engine = process.env["PAGE_SCRIPTS_ENGINE"] === "webkit" ? "webkit" : "chromium";
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
const pageErrors: string[] = [];
try {
  browser = engine === "webkit" ? await webkit.launch({ headless: true })
    : await chromium.launch({ executablePath: chromePath(), headless: true, args: ["--no-sandbox", "--accept-lang=en-US"] });
  const page = await browser.newPage({ locale: "en-US", viewport: { width: 1280, height: 800 } });
  await page.addInitScript(() => { if (window === top) localStorage.setItem("ovis:settings", JSON.stringify({ language: "en", theme: "dark", darkTheme: "codex" })); });
  const errors = pageErrors;
  page.setDefaultTimeout(10_000);
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.port}/`);
  await page.waitForFunction(() => !!window.pageScriptsQa);
  const frame = page.locator("iframe.file-viewer-page");
  const notice = page.locator(".file-viewer-scripts");
  const run = page.getByRole("button", { name: "Run scripts", exact: true });
  const composer = page.locator("#composer");
  const messages = (kind: string) => page.evaluate((kind) => window.pageScriptsQa.messages.filter((each) => each["probe"] === kind).map((each) => String(each["key"] ?? "")), kind);
  const forget = () => page.evaluate(() => { window.pageScriptsQa.messages.length = 0; });
  /** the colour the page draws in the middle of its frame: what a frame without scripts shows can only be seen in a picture of it */
  const drawn = async (): Promise<number[]> => {
    const box = (await frame.boundingBox())!;
    return pngPixel(await page.screenshot(), Math.round(box.x + box.width / 2), Math.round(box.y + box.height / 2));
  };
  const draws = async (colour: number[], what: string): Promise<void> => {
    let seen: number[] = [];
    for (const end = Date.now() + 10_000; Date.now() < end;) { seen = await drawn(); if (seen.join() === colour.join()) return; await page.waitForTimeout(50); }
    assert.deepEqual(seen, colour, what);
  };
  const open = async (path: string, docked: boolean): Promise<void> => {
    await forget();
    await page.evaluate(({ path, docked }) => window.pageScriptsQa.open(path, docked), { path, docked });
    await frame.waitFor();
  };
  const shot = async (name: string): Promise<void> => { if (shots) await page.screenshot({ path: join(shots, `${name}.png`) }); };
  /**
   * The pointer over the page reaches the app, not the frame: the browser routes a press by what it last drew, so
   * for a moment after the app takes the focus back a press still goes into the frame. A person cannot press that
   * soon; a script can, so it moves the pointer until the app sees it there.
   */
  const overPage = async (x: number, y: number): Promise<void> => {
    await page.evaluate(() => {
      const seen = window as unknown as { pointerOverPage?: boolean };
      seen.pointerOverPage = false;
      document.querySelector(".file-viewer-page-frame")!.addEventListener("mousemove", () => { seen.pointerOverPage = true; }, { once: true });
    });
    for (let moves = 0; !(await page.evaluate(() => (window as unknown as { pointerOverPage?: boolean }).pointerOverPage === true)); moves++) {
      assert.ok(moves < 500, "the pointer over the guarded page never reached the app");
      await page.mouse.move(x + (moves % 2), y);
    }
  };

  // 1. the popup: the page is drawn, its HTML and CSS, and nothing in it has run
  await open(quiet, false);
  await draws(STATIC, "the page's own HTML and CSS are drawn without its scripts");
  assert.equal(await frame.getAttribute("sandbox"), "", "the frame allows no script");
  assert.equal(await notice.innerText().then((text) => text.replace(/\s+/g, " ").trim()), "Scripts in this page are off. Run scripts");
  assert.deepEqual(await messages("ran"), [], "no script of the page ran");
  await shot("after-popup-scripts-off");
  // a field with autofocus in the page does not take the keys either
  await composer.focus();
  await page.keyboard.type("abc");
  assert.equal(await composer.inputValue(), "abc");
  await composer.fill("");
  // the press runs them, in a frame loaded anew, and the line goes
  await run.click();
  await draws(RAN, "the press runs the page's scripts");
  assert.equal(await frame.getAttribute("sandbox"), "allow-scripts");
  assert.deepEqual(await messages("ran"), [""]);
  assert.equal(await notice.count(), 0);
  await shot("after-popup-scripts-on");
  // another file, and the same file opened again, start without scripts: nothing is remembered
  await open(other, false);
  await draws(STATIC, "another file starts without its scripts");
  assert.deepEqual(await messages("ran"), []);
  await page.evaluate(() => window.pageScriptsQa.close());
  await frame.waitFor({ state: "detached" });
  await open(quiet, false);
  await draws(STATIC, "the file opened again starts without its scripts");
  assert.equal(await run.count(), 1);
  assert.deepEqual(await messages("ran"), []);
  // in the popup a page that takes the focus keeps its scripts: the dialog holds the focus, and the app under it takes no keys
  await open(grabber, false);
  await run.click();
  await draws(RAN, "the popup runs a page that takes the focus");
  await page.waitForFunction(() => document.activeElement === document.querySelector("iframe.file-viewer-page"));
  assert.equal(await frame.getAttribute("sandbox"), "allow-scripts");
  await page.evaluate(() => window.pageScriptsQa.close());
  await frame.waitFor({ state: "detached" });

  // 2. beside the pane: the same line and button, and the message box takes its keys while the page has no scripts
  await open(grabber, true);
  await draws(STATIC, "beside the pane the page is drawn without its scripts");
  assert.equal(await page.locator("aside.file-panel").count(), 1);
  await composer.click();
  await page.keyboard.type("before");
  assert.equal(await composer.inputValue(), "before");
  await composer.fill("");
  await shot("after-docked-scripts-off");
  // its scripts run on the press; this page takes the focus by itself, which the press that asked for it allows
  await run.click();
  await draws(RAN, "beside the pane the press runs the page's scripts");
  await shot("after-docked-scripts-on");
  // back in the message box the keys are the app's: the page takes the focus again, loses its scripts for it, and gets no key
  await forget();
  // the status line is already in the document, clipped and without words: the words it gets next are announced
  assert.equal(await page.locator("div.visually-hidden > span[role=status]").textContent(), "");
  await composer.click();
  await page.locator(".file-viewer-scripts > span[role=status]").filter({ hasText: "took the keyboard" }).waitFor();
  assert.equal(await notice.innerText().then((text) => text.replace(/\s+/g, " ").trim()), "This page took the keyboard, so its scripts are off again. Run scripts");
  assert.equal(await frame.getAttribute("sandbox"), "", "the page is drawn without its scripts again");
  await page.waitForFunction(() => document.activeElement?.id === "composer");
  await page.keyboard.type("hunter2", { delay: 20 });
  assert.equal(await composer.inputValue(), "hunter2", "every key went to the message box");
  assert.deepEqual(await messages("key"), [], "and none to the page");
  await composer.fill("");
  await shot("after-docked-took-the-keyboard");

  // 3. beside the pane, a page that leaves the focus alone: a press on it gives it the keys, and so does Tab
  await open(quiet, true);
  await run.click();
  await draws(RAN, "the quiet page runs");
  await composer.click();
  const shield = page.locator(".file-viewer-page-frame[data-page-shield]");
  await shield.waitFor();
  await page.keyboard.type("mine");
  assert.equal(await composer.inputValue(), "mine");
  assert.deepEqual(await messages("key"), []);
  // the press on the page puts the focus in it; the keys after it are the page's
  const box = (await frame.boundingBox())!;
  await overPage(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await shield.waitFor({ state: "detached" });
  await page.waitForFunction(() => document.activeElement === document.querySelector("iframe.file-viewer-page"));
  await page.keyboard.type("ab");
  await page.waitForFunction(() => window.pageScriptsQa.messages.filter((each) => each["probe"] === "key").length === 2);
  assert.equal(await composer.inputValue(), "mine");
  assert.equal(await frame.getAttribute("sandbox"), "allow-scripts", "a page the person pressed keeps its scripts");
  // back in the app, then Tab from the control before the frame into it: the page keeps its scripts
  await composer.click();
  await shield.waitFor();
  await page.locator("aside.file-panel").getByRole("button", { name: "Source", exact: true }).focus();
  await page.keyboard.press("Tab");
  await page.waitForFunction(() => document.activeElement === document.querySelector("iframe.file-viewer-page"));
  await shield.waitFor({ state: "detached" });
  assert.equal(await frame.getAttribute("sandbox"), "allow-scripts", "Tab into the page is the person's own");
  assert.equal(await page.locator(".file-viewer-scripts").count(), 0);
  assert.deepEqual(errors, []);
  console.log(`PASS (${engine} ${browser.version()}) a page draws without its scripts until Run scripts; nothing is remembered across files and closes; the popup keeps a page that takes the focus; beside the pane such a page loses its scripts and gets no key, and a press or Tab gives a page the keys`);
} catch (error) {
  // what the page itself said, beside the step that failed
  console.error(`page errors: ${JSON.stringify(pageErrors)}`);
  throw error;
} finally {
  await browser?.close();
  server.stop(true);
  rmSync(root, { recursive: true, force: true });
}
