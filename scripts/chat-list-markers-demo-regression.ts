import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser, type Locator } from "playwright-core";
import panes from "../site/demo/fixtures/panes.json";
import { appFaces } from "./app-faces.ts";
import { buildDemoApp } from "./demo-build.ts";
import { chromePath } from "./chrome-path.ts";

// A list's markers sit outside its items, in the list's indent, and are drawn in the Chat font: in
// a monospace face each digit and the ". " after it take a whole cell, so "1. " outgrew the old
// fixed 20px and was cut off at the transcript's left edge (#1993), and "10." or "100." need more.
// On the unmodified app over the demo's fixture transport, at a phone's and a desktop's width, in
// the default face, a monospace face and a monospace face at the largest Chat size, every marker
// of a reply's lists (1-3, 8-12, 99-100, bullets and a nested list) fits inside its list's indent;
// in the default face a bullet list keeps its 20px indent. The marker is measured as the browser
// draws it: its text in its own computed font. The omp pane's conversation answers TURNS; all
// files and HTTP traffic stay in this disposable, loopback-only app and no herdr session is
// opened. Screenshots go to UI_EVIDENCE_DIR when it is set.
const app = mkdtempSync(join(tmpdir(), "herdr-chat-list-markers-demo-"));
const evidence = process.env["UI_EVIDENCE_DIR"] || null;
if (evidence !== null) mkdirSync(evidence, { recursive: true });

const PANE = panes.omp;
const REPLY = [
  "Short:", "", "1. one", "2. two", "3. three", "",
  "Past ten:", "", "8. eight", "9. nine", "10. ten", "11. eleven", "12. twelve", "",
  "Past a hundred:", "", "99. ninety-nine", "100. a hundred", "",
  "Bullets:", "", "- a bullet", "- another", "  - nested under it",
].join("\n");
const TURNS = [
  { role: "user", ts: "2026-10-28T10:00:00.000Z", parts: [{ kind: "text", text: "Number them" }] },
  { role: "assistant", ts: "2026-10-28T10:00:05.000Z", parts: [{ kind: "text", text: REPLY }] },
];

const CASES = [
  { name: "default", settings: {}, defaultFace: true },
  { name: "monospace", settings: { chatFontFamily: "monospace" }, defaultFace: false },
  { name: "monospace-24px", settings: { chatFontFamily: "monospace", chatFontSize: 24 }, defaultFace: false },
] as const;

interface Marker { list: number; text: string; width: number; indent: number; font: string }
/** Every marker of the transcript's lists: the text the browser draws for it, its width in its own font, and its list's indent. */
const markers = (scope: Locator): Promise<Marker[]> => scope.locator(".markdown-list").evaluateAll((lists) => {
  const bullets: Record<string, string> = { disc: "\u2022 ", circle: "\u25e6 ", square: "\u25aa " };
  const found: Marker[] = [];
  lists.forEach((list, index) => {
    const indent = parseFloat(getComputedStyle(list).paddingLeft);
    const start = list instanceof HTMLOListElement ? list.start : 1;
    [...list.children].forEach((item, position) => {
      const marker = getComputedStyle(item, "::marker");
      const type = getComputedStyle(item).listStyleType;
      const text = type === "decimal" ? `${start + position}. ` : bullets[type];
      if (text === undefined) throw new Error(`no marker text for list-style-type ${type}`);
      const probe = document.createElement("span");
      probe.style.cssText = "position: absolute; visibility: hidden; white-space: pre";
      for (const property of ["font-family", "font-size", "font-weight", "font-style", "font-stretch", "font-variant-numeric", "letter-spacing"]) {
        probe.style.setProperty(property, marker.getPropertyValue(property));
      }
      probe.textContent = text;
      document.body.append(probe);
      found.push({ list: index, text, width: probe.getBoundingClientRect().width, indent, font: `${marker.fontSize} ${marker.fontFamily}` });
      probe.remove();
    });
  });
  return found;
});

async function prepareDemo(): Promise<void> {
  await buildDemoApp(app);
  const index = join(app, "index.html");
  const html = readFileSync(index, "utf8");
  assert.match(html, /<script type="module"/);
  // over the demo's own fetch: only this pane's conversation read is answered here
  const override = `<script>(() => {
    const demo = window.fetch;
    const turns = ${JSON.stringify(TURNS)};
    window.fetch = (input, init) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, location.href);
      if (url.pathname === "/api/pane/conversation" && url.searchParams.get("pane_id") === ${JSON.stringify(PANE)}) {
        const body = { source: "claude-transcript", history_id: "list-markers", cursor: null, turns: url.searchParams.has("before") ? [] : turns };
        return Promise.resolve(new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } }));
      }
      return demo(input, init);
    };
  })();</script>`;
  writeFileSync(index, html.replace(/<script type="module"/, () => `<script src="./demo-transport.js"></script>\n    ${override}\n    <script type="module"`));
}

async function check(browser: Browser, origin: string, width: number, testCase: (typeof CASES)[number]): Promise<void> {
  const phone = width <= 480;
  const context = await browser.newContext(phone
    ? { viewport: { width, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true, locale: "en-US" }
    : { viewport: { width, height: 900 }, locale: "en-US" });
  try {
    // the demo's other agents finish turns now and then: their in-app alerts stay off over the transcript
    await context.addInitScript(([settings, pane]) => {
      localStorage.setItem("ovis:settings", settings!);
      localStorage.setItem(`ovis:view:${pane}`, "chat");
    }, [JSON.stringify({ language: "en", alertsOn: false, ...testCase.settings }), PANE]);
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`${origin}/herdr-web-ui/demo/app/?pane=${encodeURIComponent(PANE)}`);
    await page.locator(".conn-live").waitFor({ state: "attached" });
    const scope = page.locator(`[data-layout-pane=${JSON.stringify(PANE)}].is-current`);
    await scope.locator(".terminal-stack.is-chat").waitFor();
    await scope.getByText("a hundred", { exact: true }).waitFor();
    await appFaces(page);

    const found = await markers(scope);
    assert.equal(found.length, 3 + 5 + 2 + 3, `${testCase.name} ${width}px: every item of the reply's lists is drawn`);
    if (testCase.name !== "default") assert.match(found[0]!.font, /monospace/, `${testCase.name} ${width}px: the markers are drawn in the Chat font`);
    const clipped = found.filter((marker) => marker.width > marker.indent + 0.5);
    assert.deepEqual(clipped, [], `${testCase.name} ${width}px: every marker fits inside its list's indent`);
    if (testCase.defaultFace) {
      const bulletIndents = [...new Set(found.filter((marker) => !/\d/.test(marker.text)).map((marker) => marker.indent))];
      assert.deepEqual(bulletIndents, [20], `${width}px: in the default face a bullet list keeps its 20px indent`);
    }
    assert.deepEqual(errors, []);
    if (evidence !== null) {
      await scope.locator(".markdown-list").first().scrollIntoViewIfNeeded();
      await page.screenshot({ path: join(evidence, `chat-list-markers-${testCase.name}-${width}.png`) });
    }
    const widest = found.reduce((most, marker) => marker.width > most.width ? marker : most);
    console.log(`PASS ${width}px ${testCase.name}: ${found.length} markers fit their indents (widest "${widest.text.trim()}" ${widest.width.toFixed(1)}px in ${widest.indent.toFixed(1)}px)`);
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
      for (const width of [390, 1440]) {
        for (const testCase of CASES) await check(browser, `http://127.0.0.1:${server.port}`, width, testCase);
      }
    } finally { await browser.close(); }
  } finally { await server.stop(true); }
} finally {
  rmSync(app, { recursive: true, force: true });
}
