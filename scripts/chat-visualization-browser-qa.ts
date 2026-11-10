/** Browser regression with the real Markdown component: a visualization reference's card in a chat answer. */
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { chromePath } from "./chrome-path.ts";
import { CONTENT_SECURITY_POLICY } from "../server/static.ts";

const root = mkdtempSync(join(tmpdir(), "ovis-visualization-qa-"));
// the card looks nothing up, so the file need not exist: only its path is shown and handed on
const path = join(root, "before-after.html");
const reference = (data: unknown) => `\uE200visualize\uE202${JSON.stringify(data)}\uE201`;
const directive = reference({ path, mode: "wide", title: "Transmission comparison" });
const build = await Bun.build({ entrypoints: ["scripts/chat-visualization-fixture.tsx"], outdir: root, target: "browser", define: { "process.env.NODE_ENV": '"production"' } });
assert.ok(build.success, String(build.logs));
/** every request for anything but the fixture's own page: the card must make none */
const asked: string[] = [];
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
  const url = new URL(request.url);
  if (url.pathname === "/") return new Response('<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/chat-visualization-fixture.css"></head><body><div id="root"></div><script type="module" src="/chat-visualization-fixture.js"></script></body></html>', { headers: { "content-security-policy": CONTENT_SECURITY_POLICY, "content-type": "text/html" } });
  if (/^\/chat-visualization-fixture\.(?:js|css)$/.test(url.pathname)) return new Response(Bun.file(join(root, url.pathname.slice(1))));
  if (url.pathname !== "/favicon.ico") asked.push(`${url.pathname}${url.search}`);
  return new Response("not found", { status: 404 });
} });
const origin = `http://127.0.0.1:${server.port}`;
if (process.argv.includes("--serve")) {
  console.log(JSON.stringify({ origin, path, directive }));
  await new Promise(() => {});
}
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
  browser = await chromium.launch({ executablePath: chromePath(), headless: true, args: ["--no-sandbox", "--accept-lang=en-US"] });
  const page = await browser.newPage({ locale: "en-US", viewport: { width: 1100, height: 850 } });
  await page.addInitScript(() => { if (window === top) localStorage.setItem("ovis:settings", JSON.stringify({ language: "en", theme: "dark", darkTheme: "codex" })); });
  const errors: string[] = [];
  page.setDefaultTimeout(10_000);
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(origin);
  await page.waitForFunction(() => !!window.visualizationQa);
  await page.evaluate((text) => window.visualizationQa.update(`Intro\n${text}\nConclusion`), directive);
  // in an answer the reference is a card: the file's own name, the reference's title under it, and one button
  const answer = page.locator("#answer"), card = answer.locator(".markdown-visualization");
  const preview = card.getByRole("button", { name: "Open preview", exact: true });
  await preview.waitFor();
  assert.equal(await card.locator(".markdown-visualization-name").innerText(), "before-after.html");
  assert.equal(await card.locator(".markdown-visualization-title").innerText(), "Transmission comparison");
  assert.equal(await card.getByRole("button").count(), 1);
  // the button says which file it opens, to a reader that hears several "Open preview"
  assert.equal(await preview.evaluate((button) => document.getElementById(button.getAttribute("aria-describedby") ?? "")?.textContent), "before-after.html");
  // a copy of the card is the name and the title on two lines, without the button's words: as plain text and as rich text
  assert.equal(await preview.evaluate((button) => getComputedStyle(button).userSelect), "none");
  const copied = await page.evaluate(() => { getSelection()!.selectAllChildren(document.querySelector("#answer .markdown-visualization")!); const payload = window.visualizationQa.copied(); getSelection()!.removeAllRanges(); return payload; });
  assert.deepEqual(copied, { text: "before-after.html\nTransmission comparison", html: "before-after.html<br>Transmission comparison" });
  assert.ok(!await answer.innerText().then((text) => text.includes("\uE200visualize")), "the reference's own text is not shown in an answer");
  // any other Markdown keeps the reference as the text it is
  assert.equal(await page.locator("#elsewhere .markdown-visualization").count(), 0);
  assert.ok(await page.locator("#elsewhere").innerText().then((text) => text.includes("visualize") && text.includes("before-after.html")), "the reference stays text outside an answer");
  mkdirSync(".ci/visualization", { recursive: true });
  await page.screenshot({ path: ".ci/visualization/desktop.png" });
  // a press opens the file viewer on exactly that path; the card itself draws no frame and asks the PC for nothing
  await preview.click();
  assert.deepEqual(await page.evaluate(() => window.visualizationQa.opened), [path]);
  assert.equal(await page.locator("iframe").count(), 0, "the card draws no frame");
  // a name with a right-to-left override, and a title that pretends to be another file: the name shown is the file's own
  await page.evaluate((text) => window.visualizationQa.update(text), reference({ path: join(root, "report\u202Efdp.html"), title: "\u202Einvoice.pdf" }));
  await page.waitForFunction(() => document.querySelector("#answer .markdown-visualization-name")?.textContent === "reportfdp.html");
  assert.equal(await card.locator(".markdown-visualization-title").innerText(), "invoice.pdf");
  // Codex's `mode` is not read: one this app has never seen draws the same card
  await page.evaluate((text) => window.visualizationQa.update(text), reference({ path, mode: "split", title: "Another layout" }));
  await page.waitForFunction(() => document.querySelector("#answer .markdown-visualization-title")?.textContent === "Another layout");
  assert.equal(await card.locator(".markdown-visualization-name").innerText(), "before-after.html");
  // a reference indented under an ordered list's item is drawn in that item, and the list goes on as one
  await page.evaluate((text) => window.visualizationQa.update(`1. First\n   ${text}\n1. Second`), directive);
  const items = answer.locator("ol > li");
  await items.first().locator(".markdown-visualization").getByRole("button", { name: "Open preview", exact: true }).waitFor();
  assert.equal(await items.count(), 2, "the card does not end its list");
  assert.equal(await answer.locator("ol").count(), 1);
  // a phone's width: the card and its button stay inside the page
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  const edge = (await items.first().locator(".markdown-visualization .btn").boundingBox())!;
  assert.ok(edge.x >= 0 && edge.x + edge.width <= 390, JSON.stringify(edge));
  await page.screenshot({ path: ".ci/visualization/mobile.png" });
  assert.deepEqual(asked, [], "no lookup or read of the file, before or after the press");
  assert.deepEqual(errors, []);
  console.log("PASS a reference in an answer is a card with the file's own name and Open preview; it asks the PC for nothing and draws no frame, opens the viewer on its path, names its file on the button, copies as two lines, draws for any mode, stays text elsewhere, sits in its list item, and fits a phone");
} finally {
  await browser?.close();
  server.stop(true);
  rmSync(root, { recursive: true, force: true });
}
