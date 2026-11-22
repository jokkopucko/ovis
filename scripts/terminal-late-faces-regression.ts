/**
 * Icons and Hangul are fitted from the faces that draw them, however their late loads interleave
 * (#2064). The icon font and the Hangul face load only once a pane prints an icon or Korean, after
 * xterm and lib/terminalGlyphs.ts measured those characters with a stand-in, narrower than either
 * in WebKit (Apple SD Gothic Neo's Hangul is 0.86em, the bundled face's 1em). Each arrival set the
 * terminal's font family again in another form so that both measured anew, and two arrivals heard
 * in the same task (both Hangul weights from WebKit's cache, or an icon with Korean) undid each
 * other's change before the glyph fit looked: the family read as before, and the widths measured
 * with the stand-in stayed. An icon stayed its full em across the cell after it, and Hangul was
 * enlarged as for the stand-in and pushed the rest of its row right.
 *
 * Chromium on Linux stands in with fonts as wide as the faces, so the page gets WebKit's: the same
 * two files drawn smaller (size-adjust) behind the late faces. The promises that tell of an arrival
 * wait at a gate while both faces load, and go on together, as from a cache.
 */
import "./test-herdr.ts";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Route } from "playwright-core";
import { createServer } from "../server/index.ts";
import { UsageService } from "../server/usage.ts";
import { herdrRpc, workspaceClose, workspaceCreate } from "../server/herdr/client.ts";
import { chromePath } from "./chrome-path.ts";
import { shownRows } from "./shown-rows.ts";

const ICONS = ["\uf07b", "\uf113", "\ue0a0"];
const ROWS = [
  "|abcdefghijklmn|",
  "|가나다라마바사|",
  `|${ICONS.join(" ")} abcdefghi|`,
];
// JetBrains Mono Web gives every machine the same 0.6em cell
const TERMINAL_FONT = "Ovis Hangul Mono, Late Stand-in, JetBrains Mono Web";
const LATE_FACES = [/\/SymbolsNerdFontMono-Regular[^/]*\.woff2$/, /\/OvisHangulMono-Regular[^/]*\.woff2$/];
// the stand-ins, as narrow as WebKit's: an icon inside its one cell, Hangul at Apple SD Gothic Neo's width
const STAND_INS: Record<string, string> = {
  "/late-faces-stand-in/icons.woff2": "src/fonts/SymbolsNerdFontMono-Regular.woff2",
  "/late-faces-stand-in/hangul.woff2": "src/fonts/OvisHangulMono-Regular.woff2",
};

const state = mkdtempSync(join(tmpdir(), "terminal-late-faces-"));
const evidence = process.env["CHECK_BROWSER_EVIDENCE_DIR"] || state;
mkdirSync(evidence, { recursive: true });
const workspaces: string[] = [];
let server: ReturnType<typeof createServer> | undefined;
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

try {
  const program = join(state, "rows.mjs");
  writeFileSync(program, `process.stdout.write(${JSON.stringify(`\x1b[2J\x1b[H${ROWS.join("\r\n")}\r\nROWS_READY\r\n`)});
setInterval(() => {}, 1 << 30);
`);
  const made = await workspaceCreate({ cwd: state, label: "ovis-test-late-faces" });
  workspaces.push(made.workspace.workspace_id);
  const pane = made.root_pane.pane_id;
  const ready = herdrRpc("pane.wait_for_output", {
    pane_id: pane, source: "visible", match: { type: "substring", value: "ROWS_READY" }, timeout_ms: 10000,
  }, undefined, 12000);
  await herdrRpc("pane.send_input", { pane_id: pane, text: `exec ${quote(process.execPath)} ${quote(program)}`, keys: ["enter"] });
  await ready;

  server = createServer({ port: 0, hostname: "127.0.0.1", token: "", stateDir: join(state, "server"),
    tailscaleOwner: null, usage: new UsageService(undefined, []) });
  browser = await chromium.launch({ executablePath: chromePath(), headless: true, args: ["--no-sandbox"] });
  // a service worker's fetches pass by the page's routes
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, serviceWorkers: "block" });
  await context.addInitScript((terminalFontFamily) => {
    localStorage.setItem("ovis:settings", JSON.stringify({ language: "en", defaultView: "terminal", alertsOn: false, terminalFontFamily }));
    for (const [file, sizeAdjust, unicodeRange] of [["icons", "50%", "U+E000-F8FF"], ["hangul", "86%", "U+3131-318E, U+AC00-D7A3"]] as const) {
      const face = new FontFace("Late Stand-in", `url(/late-faces-stand-in/${file}.woff2)`, { unicodeRange, sizeAdjust } as FontFaceDescriptors);
      document.fonts.add(face);
      void face.load();
    }
    const nativeLoaded = Object.getOwnPropertyDescriptor(FontFace.prototype, "loaded")!.get!;
    const nativeLoad = FontFaceSet.prototype.load;
    let open = Promise.resolve();
    let openGate = (): void => {};
    const through = <T,>(promise: Promise<T>): Promise<T> =>
      promise.then(value => open.then(() => value), (error: unknown) => open.then(() => { throw error; }));
    Object.defineProperty(FontFace.prototype, "loaded", { configurable: true, get(this: FontFace) { return through(nativeLoaded.call(this) as Promise<FontFace>); } });
    FontFaceSet.prototype.load = function (this: FontFaceSet, ...args: Parameters<FontFaceSet["load"]>) { return through(nativeLoad.apply(this, args)); };
    Object.assign(window, { lateFacesGate: {
      hold: () => { open = new Promise<void>((resolve) => { openGate = resolve; }); },
      open: () => openGate(),
      arrived: (face: FontFace) => nativeLoaded.call(face) as Promise<FontFace>,
    } });
  }, TERMINAL_FONT);
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  const waiting = new Map<string, Route>();
  const fetched: string[] = [];
  let bothAsked: () => void = () => {};
  const asked = new Promise<void>(resolve => { bothAsked = resolve; });
  await page.route(/\.woff2$/, (route) => {
    const path = new URL(route.request().url()).pathname;
    fetched.push(path);
    const standIn = STAND_INS[path];
    if (standIn) return route.fulfill({ contentType: "font/woff2", body: readFileSync(standIn) });
    const face = LATE_FACES.find(pattern => pattern.test(path));
    if (!face) return route.continue();
    waiting.set(face.source, route);
    if (waiting.size === LATE_FACES.length) bothAsked();
  });
  await page.goto(`http://127.0.0.1:${server.port}/?pane=${encodeURIComponent(pane)}`);
  await page.locator(".conn-live").waitFor();
  await page.locator(shownRows(), { hasText: "ROWS_READY" }).waitFor();
  await page.waitForFunction((shown) => {
    const rows = document.querySelector(shown);
    return rows !== null && getComputedStyle(rows).fontFamily.includes("Late Stand-in");
  }, shownRows(), { timeout: 15000 });
  await Promise.race([asked, page.waitForTimeout(15000).then(() => {
    throw new Error(`the late faces were not both asked for: ${JSON.stringify(fetched)}`);
  })]);
  // xterm draws the rows with the stand-ins in the frame after the font is set
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));

  type Gate = { hold: () => void; open: () => void; arrived: (face: FontFace) => Promise<FontFace> };
  await page.evaluate(() => (window as unknown as { lateFacesGate: Gate }).lateFacesGate.hold());
  await Promise.all([...waiting.values()].map(route => route.continue()));
  const arrived = await page.evaluate(async () => {
    const gate = (window as unknown as { lateFacesGate: Gate }).lateFacesGate;
    const faces: FontFace[] = [];
    document.fonts.forEach(face => { if (face.family.includes("Symbols Nerd Font Mono") || (face.family.includes("Ovis Hangul Mono") && face.weight === "400")) faces.push(face); });
    await Promise.race([Promise.all(faces.map(face => gate.arrived(face))), new Promise(resolve => setTimeout(resolve, 10000))]);
    return faces.map(face => `${face.family} ${face.weight} ${face.status}`);
  });
  await page.evaluate(() => new Promise<void>((resolve) => {
    (window as unknown as { lateFacesGate: Gate }).lateFacesGate.open();
    let frames = 4;
    const tick = (): void => { frames -= 1; if (frames === 0) resolve(); else requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
  }));

  const drawn = await page.evaluate(([icons, shown]) => {
    const rows = document.querySelector<HTMLElement>(shown)!;
    const left = rows.getBoundingClientRect().left;
    const base = Number.parseFloat(getComputedStyle(rows).fontSize);
    const bars: number[] = [];
    for (const row of rows.children) {
      const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
      let bar: number | undefined;
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const at = node.textContent!.lastIndexOf("|");
        if (at < 0) continue;
        const range = document.createRange();
        range.setStart(node, at);
        range.setEnd(node, at + 1);
        bar = range.getBoundingClientRect().left - left;
      }
      if (bar !== undefined) bars.push(bar);
    }
    const sizes = icons.map((icon) => {
      const walker = document.createTreeWalker(rows, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (node.textContent!.includes(icon)) return Number.parseFloat(getComputedStyle(node.parentElement!).fontSize);
      }
      return null;
    });
    const hangul = [...rows.querySelectorAll("span")].find(span => span.textContent === "가나다라마바사") ?? rows.querySelector(".ghostty-wide");
    return { base, bars, sizes, hangulSize: hangul ? getComputedStyle(hangul).fontSize : null,
      renderer: document.querySelector<HTMLElement>(".pane-terminal")?.dataset["renderer"] ?? "xterm" };
  }, [ICONS, shownRows()] as const);
  console.log(JSON.stringify({ arrived, ...drawn }));
  await page.screenshot({ path: join(evidence, "terminal-late-faces.png") });

  assert.deepEqual(arrived.map(face => face.endsWith(" loaded")), LATE_FACES.map(() => true), `both late faces loaded: ${arrived.join(", ")}`);
  drawn.sizes.forEach((size, index) => assert.ok(size !== null && size < drawn.base - 0.1,
    `icon ${index + 1} is drawn at ${size}px, the font's ${drawn.base}px: measured as its stand-in, not its own face`));
  const [latin, hangul] = drawn.bars;
  assert.ok(latin !== undefined && hangul !== undefined && Math.abs(hangul - latin) <= 0.5,
    `the Korean row's bar is ${((hangul ?? 0) - (latin ?? 0)).toFixed(2)}px from the Latin row's (Hangul at ${drawn.hangulSize})`);
  assert.deepEqual(errors, []);
  console.log("PASS icons and Hangul are fitted from their faces when two late faces arrive in the same task");
} finally {
  await browser?.close();
  server?.stop();
  for (const workspace of workspaces) await workspaceClose(workspace);
  rmSync(state, { recursive: true, force: true });
}
