import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser } from "playwright-core";
import panes from "../site/demo/fixtures/panes.json";
import { appFaces } from "./app-faces.ts";
import { buildDemoApp } from "./demo-build.ts";
import { chromePath } from "./chrome-path.ts";

// Math in a reply (#2407): `$…$` inline, `$$…$$` and a ```math fence as display math, beside
// `\(…\)` and `\[…\]`, while prices (`$5 and $10`) stay text. On the unmodified app over the
// demo's fixture transport, at 1280 and 390, Codex palette dark and light: every formula is drawn
// by KaTeX in the theme's text color, the prices read as written, and the reply's MD copy keeps the
// source. The omp pane's conversation answers TURNS; all files and HTTP traffic stay in this
// disposable, loopback-only app and no herdr session is opened. Screenshots go to UI_EVIDENCE_DIR
// when it is set.
const app = mkdtempSync(join(tmpdir(), "herdr-chat-math-demo-"));
const evidence = process.env["UI_EVIDENCE_DIR"] || null;
if (evidence !== null) mkdirSync(evidence, { recursive: true });

const PANE = panes.omp;
const REPLY = [
  "Inline: the energy is $E = mc^2$ and the sum is $\\sum_{i=1}^n i = \\frac{n(n+1)}{2}$.",
  "",
  "Prices stay prices: it costs $5 and $10, or $20 for both.",
  "",
  "$$",
  "\\int_0^\\infty e^{-x^2}\\,dx = \\frac{\\sqrt{\\pi}}{2}",
  "$$",
  "",
  "```math",
  "\\begin{pmatrix} a & b \\\\ c & d \\end{pmatrix}",
  "```",
  "",
  "And the older forms: \\(x_i\\) and",
  "",
  "\\[\\nabla \\cdot \\mathbf{E} = \\frac{\\rho}{\\varepsilon_0}\\]",
  "",
  "Done.",
].join("\n");
const TURNS = [
  { role: "user", ts: "2026-10-31T10:00:00.000Z", parts: [{ kind: "text", text: "Show me some math" }] },
  { role: "assistant", ts: "2026-10-31T10:00:05.000Z", parts: [{ kind: "text", text: REPLY }] },
];

async function prepareDemo(): Promise<void> {
  await buildDemoApp(app);
  const index = join(app, "index.html");
  const html = readFileSync(index, "utf8");
  assert.match(html, /<script type="module"/);
  // over the demo's own fetch: only this pane's conversation read is answered here
  const override = `<script>(() => {
    const demo = window.fetch;
    const turns = ${JSON.stringify(TURNS).replaceAll("<", "\\u003c")};
    window.fetch = (input, init) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, location.href);
      if (url.pathname === "/api/pane/conversation" && url.searchParams.get("pane_id") === ${JSON.stringify(PANE)}) {
        const body = { source: "claude-transcript", history_id: "math", cursor: null, turns: url.searchParams.has("before") ? [] : turns };
        return Promise.resolve(new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } }));
      }
      return demo(input, init);
    };
  })();</script>`;
  writeFileSync(index, html.replace(/<script type="module"/, () => `<script src="./demo-transport.js"></script>\n    ${override}\n    <script type="module"`));
}

async function check(browser: Browser, origin: string, width: number, theme: "dark" | "light"): Promise<void> {
  const phone = width <= 480;
  const context = await browser.newContext(phone
    ? { viewport: { width, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true, locale: "en-US" }
    : { viewport: { width, height: 900 }, locale: "en-US" });
  try {
    await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin });
    await context.addInitScript(([settings, pane]) => {
      localStorage.setItem("ovis:settings", settings!);
      localStorage.setItem(`ovis:view:${pane}`, "chat");
    }, [JSON.stringify({ language: "en", alertInApp: false, theme, palette: "codex", darkTheme: "codex", lightTheme: "codex" }), PANE]);
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`${origin}/herdr-web-ui/demo/app/?pane=${encodeURIComponent(PANE)}`);
    await page.locator(".conn-live").waitFor({ state: "attached" });
    const scope = page.locator(`[data-layout-pane=${JSON.stringify(PANE)}].is-current`);
    await scope.locator(".terminal-stack.is-chat").waitFor();
    await scope.getByText("Done.", { exact: true }).waitFor();
    await scope.locator(".markdown-math .katex").first().waitFor();
    await appFaces(page);
    await page.waitForFunction(() => getComputedStyle(document.querySelector(".katex")!).fontFamily.includes("KaTeX_Main"));

    assert.equal(await scope.locator(".markdown-math .katex").count(), 3, `${width} ${theme}: $E = mc^2$, the sum and \\(x_i\\) are inline formulas`);
    assert.equal(await scope.locator(".markdown-math-display .katex-display").count(), 3, `${width} ${theme}: $$, the math fence and \\[ are display formulas`);
    assert.equal(await scope.locator(".katex-error").count(), 0, `${width} ${theme}: KaTeX drew every formula`);
    assert.equal(await scope.locator("pre").count(), 0, `${width} ${theme}: the math fence is no code block`);
    assert.equal(await scope.getByText("Prices stay prices: it costs $5 and $10, or $20 for both.", { exact: true }).count(), 1, `${width} ${theme}: the prices read as written`);
    const sources = await scope.locator(".katex-mathml annotation").allTextContents();
    assert.deepEqual(sources.map((source) => source.trim()).slice(0, 2), ["E = mc^2", "\\sum_{i=1}^n i = \\frac{n(n+1)}{2}"], `${width} ${theme}: the formulas are the ones written`);
    const colors = await scope.locator(".katex").evaluateAll((formulas) => formulas.map((katex) => ({ katex: getComputedStyle(katex).color, text: getComputedStyle(katex.closest(".markdown")!).color })));
    assert.equal(colors.length, 6);
    for (const color of colors) assert.equal(color.katex, color.text, `${width} ${theme}: every formula is drawn in the reply's text color`);

    await scope.locator(".markdown-math-display").first().scrollIntoViewIfNeeded();
    if (evidence !== null) await page.screenshot({ path: join(evidence, `chat-math-codex-${theme}-${width}.png`) });
    // the reply's MD copy is its source, dollars and all
    const reply = scope.locator("article.chat-turn-agent").last();
    await reply.scrollIntoViewIfNeeded();
    await reply.hover();
    await reply.getByRole("button", { name: "Copy as markdown", exact: true }).click();
    const copied = await page.evaluate(() => navigator.clipboard.readText());
    assert.equal(copied, REPLY, `${width} ${theme}: MD copy keeps the source`);
    assert.deepEqual(errors, []);
    console.log(`PASS ${width}px ${theme}: 3 inline and 3 display formulas in the text color, prices as text, MD copy is the source`);
  } finally { await context.close(); }
}

try {
  await prepareDemo();
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
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
  try {
    const browser = await chromium.launch({ executablePath: chromePath(), headless: true, args: ["--no-sandbox"] });
    try {
      for (const width of [1280, 390]) {
        for (const theme of ["dark", "light"] as const) await check(browser, `http://127.0.0.1:${server.port}`, width, theme);
      }
    } finally { await browser.close(); }
  } finally { await server.stop(true); }
} finally {
  rmSync(app, { recursive: true, force: true });
}
