import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser } from "playwright-core";
import panes from "../site/demo/fixtures/panes.json";
import { appFaces } from "./app-faces.ts";
import { buildDemoApp } from "./demo-build.ts";
import { chromePath } from "./chrome-path.ts";

// A header tab's mark (its agent's logo, or a shell's glyph) sits on the tab's middle, beside its
// name. The agent's mark is a span around an SVG: drawn inline, the SVG sat on the text baseline
// of a line box taller than the mark, and the logo rode a few pixels above the name. On the
// unmodified app over the demo's fixture transport, at a desktop's width and a touch tablet's
// (the header row starts at 769px), every tab's mark is centred on its tab, and an agent's mark
// box is as tall as its logo. All files and HTTP traffic stay in this disposable, loopback-only
// app and no herdr session is opened. Screenshots go to UI_EVIDENCE_DIR when it is set.
const app = mkdtempSync(join(tmpdir(), "herdr-tab-agent-mark-demo-"));
const evidence = process.env["UI_EVIDENCE_DIR"] || null;
if (evidence !== null) mkdirSync(evidence, { recursive: true });

const PANE = panes.api;
const CASES = [
  { name: "desktop", width: 1280, touch: false, shell: true },
  // a tablet's finger-sized tabs leave the shell's behind More: the agent's tab is the one checked
  { name: "tablet", width: 800, touch: true, shell: false },
] as const;

interface TabMark { name: string; agent: boolean; markOffset: number; boxHeight: number; logoHeight: number }

async function prepareDemo(): Promise<void> {
  await buildDemoApp(app);
  const index = join(app, "index.html");
  const html = readFileSync(index, "utf8");
  assert.match(html, /<script type="module"/);
  writeFileSync(index, html.replace(/<script type="module"/, () => `<script src="./demo-transport.js"></script>\n    <script type="module"`));
}

async function check(browser: Browser, origin: string, testCase: (typeof CASES)[number]): Promise<void> {
  const context = await browser.newContext({ viewport: { width: testCase.width, height: 900 }, hasTouch: testCase.touch, locale: "en-US" });
  try {
    await context.addInitScript(() => localStorage.setItem("ovis:settings", JSON.stringify({ language: "en", alertsOn: false })));
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`${origin}/herdr-web-ui/demo/app/?pane=${encodeURIComponent(PANE)}`);
    await page.locator(".conn-live").waitFor({ state: "attached" });
    await page.locator(".header-tabs .tab-strip-agent .agent-mark svg").first().waitFor();
    if (testCase.shell) await page.locator(".header-tabs .tab-strip-agent.is-shell svg").first().waitFor();
    await appFaces(page);

    const marks = await page.locator(".header-tabs .tab-strip-tab").evaluateAll((tabs): TabMark[] => tabs.flatMap((tab) => {
      const logo = tab.querySelector(".tab-strip-agent svg");
      if (!logo) return [];
      const box = tab.querySelector(".tab-strip-agent .agent-mark") ?? logo;
      const middle = (rect: DOMRect) => rect.top + rect.height / 2;
      const drawn = logo.getBoundingClientRect();
      return [{
        name: tab.querySelector(".tab-strip-label")?.textContent ?? "",
        agent: tab.querySelector(".agent-mark") !== null,
        markOffset: Math.round((middle(drawn) - middle(tab.getBoundingClientRect())) * 10) / 10,
        boxHeight: box.getBoundingClientRect().height,
        logoHeight: drawn.height,
      }];
    }));
    assert.ok(marks.some((mark) => mark.agent), `${testCase.name}: an agent's tab is drawn`);
    if (testCase.shell) assert.ok(marks.some((mark) => !mark.agent), `${testCase.name}: a shell's tab is drawn`);
    const offCentre = marks.filter((mark) => Math.abs(mark.markOffset) > 0.5);
    assert.deepEqual(offCentre, [], `${testCase.name} ${testCase.width}px: every tab's mark is centred on its tab`);
    const tallBoxes = marks.filter((mark) => mark.agent && Math.abs(mark.boxHeight - mark.logoHeight) > 0.5);
    assert.deepEqual(tallBoxes, [], `${testCase.name} ${testCase.width}px: an agent's mark box is as tall as its logo, no line box around it`);
    assert.deepEqual(errors, []);
    if (evidence !== null) {
      const row = (await page.locator(".header-tabs").boundingBox())!;
      await page.screenshot({ path: join(evidence, `tab-agent-mark-${testCase.name}.png`), clip: { x: row.x, y: row.y, width: Math.min(row.width, 600), height: row.height } });
    }
    console.log(`PASS ${testCase.width}px ${testCase.name}: ${marks.length} tab marks centred on their tabs`);
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
      for (const testCase of CASES) await check(browser, `http://127.0.0.1:${server.port}`, testCase);
    } finally { await browser.close(); }
  } finally { await server.stop(true); }
} finally {
  rmSync(app, { recursive: true, force: true });
}
