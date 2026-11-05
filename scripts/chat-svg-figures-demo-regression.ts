import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser } from "playwright-core";
import panes from "../site/demo/fixtures/panes.json";
import { appFaces } from "./app-faces.ts";
import { buildDemoApp } from "./demo-build.ts";
import { chromePath } from "./chrome-path.ts";

// A ```svg fence in a reply (#2441) is drawn as an <img> from a data: URL in the theme's colors,
// and one that could run or load something stays the code block it is. On the unmodified app over
// the demo's fixture transport, at 1280 and 390, Codex palette dark and light: the themed figure
// decodes as an image with its tokens resolved to the theme, the unsafe fence is a code block, its
// script never runs, nothing is fetched from outside the app, and the enlarge view shows the same
// image. The omp pane's conversation answers TURNS; all files and HTTP traffic stay in this
// disposable, loopback-only app and no herdr session is opened. Screenshots go to UI_EVIDENCE_DIR
// when it is set.
const app = mkdtempSync(join(tmpdir(), "herdr-chat-svg-figures-demo-"));
const evidence = process.env["UI_EVIDENCE_DIR"] || null;
if (evidence !== null) mkdirSync(evidence, { recursive: true });

const PANE = panes.omp;
const FIGURE = [
  '<svg viewBox="0 0 360 120">',
  '  <rect x="4" y="4" width="352" height="112" rx="10" fill="var(--surface)" stroke="var(--border)"/>',
  '  <rect x="24" y="36" width="96" height="48" rx="6" fill="none" stroke="var(--accent)" stroke-width="2"/>',
  '  <text x="72" y="65" text-anchor="middle" fill="currentColor" font-size="14">client</text>',
  '  <path d="M120 60 H236" stroke="var(--muted)" stroke-width="2" marker-end="url(#arrow)"/>',
  '  <defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto"><path d="M0 0 L10 5 L0 10 z" fill="var(--muted)"/></marker></defs>',
  '  <rect x="240" y="36" width="96" height="48" rx="6" fill="none" stroke="var(--success)" stroke-width="2"/>',
  '  <text x="288" y="65" text-anchor="middle" fill="var(--c1)" font-size="14">server</text>',
  "</svg>",
].join("\n");
const UNSAFE = [
  '<svg viewBox="0 0 10 10"><script>window.__svgRan = "script"</script></svg>',
  '<svg viewBox="0 0 10 10" onload="window.__svgRan = \'handler\'"></svg>',
  '<svg viewBox="0 0 10 10"><image href="https://example.invalid/pixel.png" width="10" height="10"/></svg>',
  '<svg xmlns:é="http://www.w3.org/2000/svg"><é:script>window.__svgRan = "prefixed"</é:script></svg>',
  '<svg xmlns:é="http://www.w3.org/2000/svg"><é:style>@\\69mport "https://example.com/x.css";</é:style></svg>',
  '<svg xmlns:é="http://www.w3.org/1999/xlink"><use href="#p"><set attributeName="é:href" to="https://example.com/x.svg#p"/></use></svg>',
  '<svg><rect fill="u\\72l(https://example.com/x)"/></svg>',
  '<svg><style>rect { fill: u<!--x-->rl(https://example.com/x); }</style></svg>',
  '<svg><style>@im<!--x-->port "https://example.com/x.css";</style></svg>',
  '<svg xml:base="https://example.com/"><use href="#p"/></svg>',
];
const REPLY = ["Here is the flow:", "", "```svg", FIGURE, "```", "", "And these must not draw:", "", ...UNSAFE.flatMap((fence) => ["```svg", fence, "```", ""]), "Done."].join("\n");
const TURNS = [
  { role: "user", ts: "2026-10-31T10:00:00.000Z", parts: [{ kind: "text", text: "Draw the flow" }] },
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
        const body = { source: "claude-transcript", history_id: "svg-figures", cursor: null, turns: url.searchParams.has("before") ? [] : turns };
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
    await context.addInitScript(([settings, pane]) => {
      localStorage.setItem("ovis:settings", settings!);
      localStorage.setItem(`ovis:view:${pane}`, "chat");
    }, [JSON.stringify({ language: "en", alertInApp: false, theme, palette: "codex", darkTheme: "codex", lightTheme: "codex" }), PANE]);
    const page = await context.newPage();
    const errors: string[] = [];
    const outside: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("request", (request) => { if (!request.url().startsWith(origin) && !request.url().startsWith("data:")) outside.push(request.url()); });
    await page.goto(`${origin}/herdr-web-ui/demo/app/?pane=${encodeURIComponent(PANE)}`);
    await page.locator(".conn-live").waitFor({ state: "attached" });
    const scope = page.locator(`[data-layout-pane=${JSON.stringify(PANE)}].is-current`);
    await scope.locator(".terminal-stack.is-chat").waitFor();
    await scope.getByText("Done.", { exact: true }).waitFor();
    await appFaces(page);

    const figure = scope.locator(".markdown-mermaid img");
    await figure.waitFor();
    assert.equal(await figure.count(), 1, `${width} ${theme}: one fence is drawn as a figure`);
    const drawn = await figure.evaluate(async (img: HTMLImageElement) => {
      await img.decode();
      return { src: img.src, width: img.naturalWidth, height: img.naturalHeight, text: getComputedStyle(document.documentElement).getPropertyValue("--text").trim(), accent: getComputedStyle(document.documentElement).getPropertyValue("--accent").trim() };
    });
    assert.ok(drawn.src.startsWith("data:image/svg+xml"), `${width} ${theme}: the figure is a data: image`);
    assert.deepEqual([drawn.width, drawn.height], [360, 120], `${width} ${theme}: the figure takes its viewBox size`);
    const markup = decodeURIComponent(drawn.src.slice(drawn.src.indexOf(",") + 1));
    assert.ok(!markup.includes("var("), `${width} ${theme}: every token is resolved`);
    assert.ok(markup.includes(`stroke="${drawn.accent}"`), `${width} ${theme}: --accent is the theme's accent ${drawn.accent}`);
    assert.ok(markup.includes(`color="${drawn.text}"`), `${width} ${theme}: currentColor is the theme's text ${drawn.text}`);

    // each fence holds one unsafe part, so each is judged on its own
    for (const marker of ["<script>", "onload=", "example.invalid", "é:script", "é:style", "é:href", "u\\72l", "u<!--x-->", "@im<!--x-->", "xml:base"]) {
      assert.equal(await scope.locator("pre", { hasText: marker }).count(), 1, `${width} ${theme}: the fence with ${marker} stays a code block`);
    }
    assert.equal(await scope.locator(".markdown-mermaid img").count(), 1, `${width} ${theme}: only the safe fence is drawn`);
    assert.equal(await page.evaluate(() => (window as unknown as { __svgRan?: string }).__svgRan), undefined, `${width} ${theme}: its script never ran`);
    assert.deepEqual(outside, [], `${width} ${theme}: nothing is fetched from outside the app`);

    await figure.scrollIntoViewIfNeeded();
    if (evidence !== null) await page.screenshot({ path: join(evidence, `chat-svg-figures-codex-${theme}-${width}.png`) });
    await scope.getByRole("button", { name: "Enlarge diagram" }).click();
    const zoomed = page.locator(".mermaid-lightbox-canvas img");
    await zoomed.waitFor();
    assert.equal(await zoomed.getAttribute("src"), drawn.src, `${width} ${theme}: the enlarge view shows the same image`);
    if (evidence !== null) await page.screenshot({ path: join(evidence, `chat-svg-figures-codex-${theme}-${width}-enlarged.png`) });
    await page.keyboard.press("Escape");
    await zoomed.waitFor({ state: "detached" });
    // a theme change on a live page redraws the figure in the new colors
    const other = theme === "dark" ? "light" : "dark";
    await page.evaluate((next) => { document.documentElement.dataset.theme = next; }, other);
    await page.waitForFunction((before) => document.querySelector(".markdown-mermaid img")?.getAttribute("src") !== before, drawn.src);
    const redrawn = await figure.evaluate((img: HTMLImageElement) => ({ src: img.src, text: getComputedStyle(document.documentElement).getPropertyValue("--text").trim() }));
    assert.notEqual(redrawn.text, drawn.text, `${width} ${theme}: the ${other} theme has another text color`);
    assert.ok(decodeURIComponent(redrawn.src.slice(redrawn.src.indexOf(",") + 1)).includes(`color="${redrawn.text}"`), `${width} ${theme}: after the switch currentColor is ${redrawn.text}`);
    assert.deepEqual(errors, []);
    console.log(`PASS ${width}px ${theme}: figure ${drawn.width}x${drawn.height} in theme colors, each unsafe fence a code block, nothing ran or loaded, enlarge view, redrawn on a theme switch`);
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
