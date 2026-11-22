import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { build as viteBuild } from "vite";
import { transcriptPage } from "../server/conversation.ts";
import type { ConversationResponse } from "../shared/protocol.ts";
import { chromePath } from "./chrome-path.ts";

const root = realpathSync(mkdtempSync(join(tmpdir(), "herdr-math-browser-")));
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
let server: ReturnType<typeof Bun.serve> | undefined;
let conversation: ConversationResponse;
const write = (answer: string) => {
  const path = join(root, "session.jsonl");
  writeFileSync(path, [
    { type: "session", version: 3, id: "s", timestamp: "2026-09-30T00:00:00Z", cwd: root },
    { type: "model_change", id: "m1", parentId: null, timestamp: "2026-09-30T00:00:00Z", provider: "test", modelId: "qwen-test" },
    { type: "message", id: "u1", parentId: "m1", timestamp: "2026-09-30T00:00:01Z", message: { role: "user", content: "show me some math" } },
    { type: "message", id: "a1", parentId: "u1", timestamp: "2026-09-30T00:00:02Z", message: {
      role: "assistant", model: "qwen-test", provider: "test", stopReason: "stop", usage: { input: 10, output: 4 },
      content: [{ type: "text", text: answer }],
    } },
  ].map((row) => JSON.stringify(row)).join("\n") + "\n");
  const { source, turns, metadata } = transcriptPage("pi-transcript", path);
  conversation = { source, history_id: "fixture", cursor: null, turns, metadata, version: 1 };
};
try {
  // Exercise the production bundler too: Vite must load the stylesheet with its JS chunk.
  const repo = join(import.meta.dir, "..");
  const output = join(root, "dist");
  symlinkSync(join(repo, "node_modules"), join(root, "node_modules"), "dir");
  symlinkSync(join(repo, "scripts/chat-history-fixture.tsx"), join(root, "fixture.tsx"));
  writeFileSync(join(root, "index.html"), '<html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="/fixture.tsx"></script></body></html>');
  await viteBuild({ configFile: join(repo, "vite.config.ts"), root, publicDir: false, logLevel: "warn", build: { outDir: output, emptyOutDir: true } });
  server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch(request) {
    const path = new URL(request.url).pathname;
    if (path.endsWith("/pane/commands")) return Response.json({ commands: [] });
    if (path.endsWith("/pane/conversation")) return Response.json(conversation);
    return new Response(Bun.file(join(output, path === "/" ? "index.html" : path.slice(1))));
  } });

  browser = await chromium.launch({ executablePath: chromePath(), headless: true, args: ["--no-sandbox"] });
  // The notice and button locators are English; do not inherit the host's system language.
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 }, locale: "en-US" });
  const errors: string[] = [];
  const scripts: string[] = [];
  const mathAssets: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (request.resourceType() === "script") scripts.push(path);
    if (/\/katex-[^/]+\.(?:js|css)$/.test(path)) mathAssets.push(path);
  });
  await page.route("**/api/pane/conversation?*", (route) => route.fulfill({ json: conversation }));

  write("Prose only, nothing to typeset.");
  await page.goto(`http://127.0.0.1:${server.port}/`);
  await page.getByText("Prose only, nothing to typeset.").waitFor();
  const atStart = scripts.length;
  assert.deepEqual(mathAssets, [], "prose fetches neither KaTeX JavaScript nor its stylesheet");
  assert.equal(await page.locator(".katex").count(), 0);

  write("Euler: \\(e^{i\\pi}+1=0\\)\n\n\\[\\int_0^1 x\\,dx = \\tfrac{1}{2}\\]");
  await page.evaluate(() => window.qa.refresh());
  await page.locator(".markdown-math .katex").waitFor();
  await page.locator(".markdown-math-display .katex-display").waitFor();
  assert.ok(scripts.length > atStart, "the first expression fetches the KaTeX chunk");
  // Rollup may split KaTeX into several chunks; what matters is that it comes now, and each file once
  const mathScripts = mathAssets.filter((path) => path.endsWith(".js"));
  assert.ok(mathScripts.length > 0, "the first expression fetches KaTeX's JavaScript");
  assert.equal(new Set(mathScripts).size, mathScripts.length, "each KaTeX script is fetched once");
  assert.equal(mathAssets.filter((path) => path.endsWith(".css")).length, 1);
  const fetched = mathAssets.length;
  await page.waitForFunction(() => getComputedStyle(document.querySelector(".katex")!).fontFamily.includes("KaTeX_Main"));
  assert.match(await page.locator(".markdown-math .katex-mathml annotation").textContent() ?? "", /e\^\{i\\pi\}\+1=0/);

  const loaded = scripts.length;
  write("Again: \\(a^2+b^2=c^2\\)");
  await page.evaluate(() => window.qa.refresh());
  await page.getByText("Again:").waitFor();
  await page.locator(".markdown-math .katex").waitFor();
  assert.equal(scripts.length, loaded, "KaTeX is fetched once");
  assert.equal(mathAssets.length, fetched, "later expressions fetch no more KaTeX");
  assert.equal(await page.getByText("\\(a^2+b^2=c^2\\)").count(), 0, "a later expression is typeset at once");
  assert.equal(await page.locator(".update-notice").count(), 0, "math that loads asks for no reload");
  assert.deepEqual(errors, []);

  const offline = await browser.newPage({ locale: "en-US" });
  offline.on("pageerror", (error) => errors.push(error.message));
  await offline.route("**/api/pane/conversation?*", (route) => route.fulfill({ json: conversation }));
  write("Prose only, nothing to typeset.");
  await offline.goto(`http://127.0.0.1:${server.port}/`);
  await offline.getByText("Prose only, nothing to typeset.").waitFor();
  let aborted = 0;
  let reloads = 0;
  offline.on("framenavigated", (frame) => { if (frame === offline.mainFrame()) reloads++; });
  const failedChunk = offline.waitForEvent("requestfailed", { predicate: (request) => request.resourceType() === "script", timeout: 5_000 });
  await offline.route("**/*.js", (route) => { aborted++; return route.abort(); });
  write("First: \\(x^2\\)\n\nSecond: \\(y^2\\)");
  await offline.evaluate(() => window.qa.refresh());
  await offline.getByText("\\(y^2\\)").waitFor();
  await failedChunk;
  assert.equal(await offline.locator(".katex").count(), 0);
  assert.equal(await offline.getByText("\\(x^2\\)").count(), 1, "an expression KaTeX could not reach shows its source");
  // the first load may abort several chunks (Vite preloads KaTeX's with its loader); count them once
  const abortedFirst = aborted;
  write("Later: \\(z^2\\)");
  await offline.evaluate(() => window.qa.refresh());
  await offline.getByText("\\(z^2\\)").waitFor();
  // a later expression does not ask again: Chrome would answer from the failed import without a
  // fetch, so the recovery is the reload line (lib/lazyChunk.ts), not a retry
  assert.equal(aborted, abortedFirst, "later expressions reuse the failed load without retrying");
  assert.equal(await offline.locator(".katex").count(), 0);
  const notice = offline.locator(".update-notice.is-warning");
  await notice.getByText("Part of the app could not load.").waitFor({ timeout: 5_000 });
  assert.equal(reloads, 0, "the page is not reloaded until it is asked to be");
  await offline.unroute("**/*.js");
  await Promise.all([offline.waitForEvent("load"), notice.getByRole("button", { name: "Reload app" }).click()]);
  assert.equal(reloads, 1, "Reload app reloads the page");
  assert.deepEqual(errors, []);

  // a diagram chunk Mermaid loads on its own: its entry and the flowchart chunk load, then the
  // sequence diagram's is gone (a tab older than the server's build). Mermaid makes that a failed
  // render, as a diagram that does not parse is; Vite's loader still tells of it (lib/lazyChunk.ts)
  const diagrams = await browser.newPage({ locale: "en-US" });
  diagrams.on("pageerror", (error) => errors.push(error.message));
  await diagrams.route("**/api/pane/conversation?*", (route) => route.fulfill({ json: conversation }));
  write("```mermaid\ngraph LR\n  A[Start] --> B[End]\n```");
  await diagrams.goto(`http://127.0.0.1:${server.port}/`);
  await diagrams.locator(".markdown-mermaid svg").waitFor({ timeout: 15_000 });
  assert.equal(await diagrams.locator(".update-notice").count(), 0, "a diagram that loads asks for no reload");
  write("```mermaid\ngraph LR\n  A[Start --> \n```");
  await diagrams.evaluate(() => window.qa.refresh());
  await diagrams.locator(".markdown-code").first().waitFor();
  await diagrams.waitForTimeout(800); // fixed wait: no reload notice may appear for the syntax error
  assert.equal(await diagrams.locator(".update-notice").count(), 0, "a syntax error asks for no reload");
  const goneChunk = diagrams.waitForEvent("requestfailed", { predicate: (request) => /\/sequenceDiagram-[^/]+\.js$/.test(request.url()), timeout: 5_000 });
  await diagrams.route(/\/sequenceDiagram-[^/]+\.js$/, (route) => route.abort());
  write("```mermaid\nsequenceDiagram\n  Alice->>Bob: Hi\n```");
  await diagrams.evaluate(() => window.qa.refresh());
  await goneChunk;
  await diagrams.locator(".update-notice.is-warning").getByText("Part of the app could not load.").waitFor({ timeout: 5_000 });
  assert.equal(await diagrams.locator(".markdown-mermaid svg").count(), 0, "the diagram whose chunk is gone stays a code block");
  assert.deepEqual(errors, []);

  // only the stylesheet fails: Vite's loader never asks for a stylesheet twice, so a second try
  // would import the script alone and draw math unstyled. Every expression keeps its source.
  const unstyled = await browser.newPage({ locale: "en-US" });
  unstyled.on("pageerror", (error) => errors.push(error.message));
  await unstyled.route("**/api/pane/conversation?*", (route) => route.fulfill({ json: conversation }));
  write("Prose only, nothing to typeset.");
  await unstyled.goto(`http://127.0.0.1:${server.port}/`);
  await unstyled.getByText("Prose only, nothing to typeset.").waitFor();
  const failedStyle = unstyled.waitForEvent("requestfailed", { predicate: (request) => /\/katex-[^/]+\.css$/.test(request.url()), timeout: 5_000 });
  await unstyled.route(/\/katex-[^/]+\.css$/, (route) => route.abort());
  write("First: \\(x^2\\)");
  await unstyled.evaluate(() => window.qa.refresh());
  await failedStyle;
  await unstyled.getByText("\\(x^2\\)").waitFor();
  await unstyled.unroute(/\/katex-[^/]+\.css$/);
  const katexAfter: string[] = [];
  unstyled.on("request", (request) => { if (/\/katex-[^/]+\.(?:js|css)$/.test(new URL(request.url()).pathname)) katexAfter.push(new URL(request.url()).pathname); });
  write("Later: \\(z^2\\)\n\nAnd: \\(w^2\\)\n\nAgain: \\(v^2\\)");
  await unstyled.evaluate(() => window.qa.refresh());
  await unstyled.getByText("Again:").waitFor();
  await unstyled.evaluate(() => fetch("/index.html").then((response) => response.text()));
  assert.deepEqual(katexAfter, [], "a later expression does not load KaTeX without its stylesheet");
  assert.equal(await unstyled.locator(".katex").count(), 0, "math is not drawn without its stylesheet");
  assert.equal(await unstyled.getByText("\\(v^2\\)").count(), 1, "a later expression keeps its source");
  assert.deepEqual(errors, []);
  console.log("math: browser OK (KaTeX fetched with the first expression, once; inline and display typeset; offline keeps the source and offers a reload; a missing diagram chunk offers it too; a failed stylesheet is not retried into unstyled math)");
} finally {
  await browser?.close();
  server?.stop();
  rmSync(root, { recursive: true, force: true });
}
