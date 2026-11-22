/**
 * xterm measures its cell, and lib/terminalLineHeight.ts its row, when the family is set,
 * so a terminal opened with the face still loading would keep a fallback's cell and draw the face in
 * it. It opens without the face (lib/fontFamily.ts, openingFontStack), the font effect sets the face
 * once it has loaded, and the pane is attached only then (usePaneAttach.ts): its pty is sized once,
 * for the face's grid, not for a fallback's and then again (a reflow every program on it would see).
 */
import "./test-herdr.ts";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Page, type Route } from "playwright-core";
import { createServer } from "../server/index.ts";
import { UsageService } from "../server/usage.ts";
import { herdrRpc, workspaceClose, workspaceCreate } from "../server/herdr/client.ts";
import { HANGUL_INK_EM, terminalLineHeight } from "../src/lib/terminalLineHeight.ts";
import { chromePath } from "./chrome-path.ts";
import { shownRows } from "./shown-rows.ts";

const ROWS = ["|abcdefghijklmn|", "|가나다라마바사|"];
const FACE = /\/JetBrainsMono-Regular[^/]*\.woff2$/;
const FAMILY = "JetBrains Mono Web";
const WAIT_MS = 10000;

const state = mkdtempSync(join(tmpdir(), "terminal-bundled-mono-"));
const evidence = process.env["CHECK_BROWSER_EVIDENCE_DIR"] || state;
mkdirSync(evidence, { recursive: true });
const workspaces: string[] = [];
let server: ReturnType<typeof createServer> | undefined;
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

async function within<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), WAIT_MS); })]);
  } finally {
    clearTimeout(timer);
  }
}

interface Frame { type: string; pane_id?: string; cols?: number; rows?: number; ready?: boolean }

/**
 * The frames the page sends for the pane, and its input readiness. Chrome reports a frame the page
 * sent before any evaluate that observes what the page did in the same task, so frames are counted
 * once the page shows a state that task left.
 */
function paneFrames(page: Page, pane: string) {
  const sent: Frame[] = [];
  let ready: () => void = () => {};
  const inputReady = new Promise<void>((resolve) => { ready = resolve; });
  let attached: (frame: Frame) => void = () => {};
  const attach = new Promise<Frame>((resolve) => { attached = resolve; });
  page.on("websocket", (socket) => {
    socket.on("framereceived", ({ payload }) => {
      const message = JSON.parse(String(payload)) as Frame;
      if (message.type === "input-ready" && message.pane_id === pane && message.ready !== false) ready();
    });
    socket.on("framesent", ({ payload }) => {
      const message = JSON.parse(String(payload)) as Frame;
      if (message.pane_id !== pane) return;
      sent.push(message);
      if (message.type === "attach") attached(message);
    });
  });
  return {
    inputReady: () => within(inputReady, "the pane's input to be ready"),
    attach: () => within(attach, "the pane's attach"),
    resizes: () => sent.filter((frame) => frame.type === "resize"),
  };
}

const rowsFamily = (page: Page): Promise<string> =>
  page.evaluate((shown) => getComputedStyle(document.querySelector(shown)!).fontFamily, shownRows());

try {
  const program = join(state, "rows.mjs");
  writeFileSync(program, `process.stdout.write(${JSON.stringify(`\x1b[2J\x1b[H${ROWS.join("\r\n")}\r\nROWS_READY\r\n`)});
setInterval(() => {}, 1 << 30);
`);
  const made = await workspaceCreate({ cwd: state, label: "ovis-test-bundled-mono" });
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

  for (const [deviceScaleFactor, slow, typedFails] of [[1, false, false], [2, false, false], [1, true, false], [1, true, true]] as const) {
    // a service worker's fetches pass by the page's routes
    const context = await browser.newContext({ viewport: { width: 1200, height: 760 }, deviceScaleFactor, serviceWorkers: "block" });
    await context.addInitScript((typed) => {
      localStorage.setItem("ovis:settings", JSON.stringify({ language: "en", defaultView: "terminal", alertsOn: false, ...(typed ? { terminalFontFamily: "Pretendard Variable" } : {}) }));
      const asked: string[] = [];
      const load = FontFaceSet.prototype.load;
      FontFaceSet.prototype.load = function (this: FontFaceSet, font: string, text?: string) { asked.push(text ?? ""); return load.call(this, font, text); };
      Object.assign(window, { fontLoadsAsked: asked });
    }, typedFails);
    const page = await context.newPage();
    page.setDefaultTimeout(WAIT_MS);
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    const frames = paneFrames(page, pane);
    const held: Route[] = [];
    let release = false;
    let asked: () => void = () => {};
    const faceAsked = new Promise<void>((resolve) => { asked = resolve; });
    await page.route(FACE, (route) => {
      if (release) return route.continue();
      held.push(route);
      asked();
    });
    if (typedFails) await page.route(/pretendard/i, (route) => route.fulfill({ status: 404, body: "" }));

    await page.goto(`http://127.0.0.1:${server.port}/?pane=${encodeURIComponent(pane)}`);
    await page.locator(".conn-live").waitFor();
    await within(faceAsked, "the page to ask for the face");
    assert.ok(!(await rowsFamily(page)).includes(FAMILY), "the terminal opens without the face it has not loaded");
    // a slow face is let go only once the font effect gave up waiting for it, waits for its arrival
    // instead, and the pane has been attached without it: the attach must not wait for the face, and a
    // face let go any earlier can arrive before the attach and leave it nothing to resize
    let attach: Frame | undefined;
    if (slow) {
      await page.waitForFunction(() => (window as unknown as { fontLoadsAsked: string[] }).fontLoadsAsked.includes("M"));
      attach = await frames.attach();
    }
    release = true;
    for (const route of held.splice(0)) await route.continue();
    attach ??= await frames.attach();
    await page.waitForFunction(([family, shown]) => getComputedStyle(document.querySelector(shown)!).fontFamily.includes(family), [FAMILY, shownRows()] as const);
    await page.locator(shownRows(), { hasText: ROWS[1]! }).waitFor();

    const drawn = await (await page.waitForFunction(([family, shown, written]) => {
      const rows = document.querySelector<HTMLElement>(shown)!;
      const screen = document.querySelector<HTMLElement>(".pane-terminal .xterm-screen")!;
      const size = Number.parseFloat(getComputedStyle(rows).fontSize);
      const canvas = document.createElement("canvas").getContext("2d")!;
      canvas.font = `${size}px "${family}"`;
      const metrics = canvas.measureText("W");
      const bars = [...rows.children].slice(0, 2).map((row) => {
        const found: number[] = [];
        const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          for (let at = node.textContent!.indexOf("|"); at >= 0; at = node.textContent!.indexOf("|", at + 1)) {
            const range = document.createRange();
            range.setStart(node, at);
            range.setEnd(node, at + 1);
            found.push(range.getBoundingClientRect().left);
          }
        }
        return found;
      });
      const texts = [...rows.children].slice(0, 2).map((row) => row.textContent!.replace(/\s/g, ""));
      if (texts.join("\n") !== written.join("\n") || bars.some((found) => found.length !== 2)) return null;
      // the screen's width is set in the resize itself; a row's text is drawn again in a later frame
      const cols = Math.round(Number.parseFloat(screen.style.width) / metrics.width);
      return {
        size,
        cols,
        gridRows: rows.children.length,
        width: Number.parseFloat(screen.style.width),
        // xterm sets each row's height inline; libghostty's rows take theirs from --ghostty-ch
        rowHeight: Number.parseFloat((rows.children[0] as HTMLElement).style.height) || rows.children[0]!.getBoundingClientRect().height,
        hostWidth: screen.closest(".xterm")!.parentElement!.clientWidth,
        glyph: metrics.width,
        charHeight: metrics.fontBoundingBoxAscent + metrics.fontBoundingBoxDescent,
        bars,
        loaded: document.fonts.check(`${size}px "${family}"`, "M"),
        dpr: devicePixelRatio,
        renderer: document.querySelector<HTMLElement>(".pane-terminal")?.dataset["renderer"] ?? "xterm",
      };
    }, [FAMILY, shownRows(), ROWS] as const)).jsonValue();
    const [latin, korean] = drawn.bars;
    const cell = (latin!.at(-1)! - latin![0]!) / (ROWS[0]!.length - 1);
    const line = Math.ceil(drawn.charHeight * drawn.dpr);
    const row = Math.floor(line * terminalLineHeight(drawn.charHeight, drawn.size, drawn.dpr)) / drawn.dpr;
    const hangulGap = drawn.rowHeight - HANGUL_INK_EM * drawn.size;
    const resizes = frames.resizes();
    console.log(JSON.stringify({ deviceScaleFactor, slow, typedFails, cell, row, hangulGap: +hangulGap.toFixed(2), attach: [attach.cols, attach.rows], resizes, ...drawn }));
    await page.screenshot({ path: join(evidence, `terminal-bundled-mono-${deviceScaleFactor}x${slow ? "-slow" : ""}${typedFails ? "-typed-fails" : ""}.png`) });
    assert.ok(drawn.loaded, "the face loaded");
    assert.ok(Math.abs(cell - drawn.glyph) < 0.05, `a cell is the face's advance: ${cell} against ${drawn.glyph}`);
    assert.ok(Math.abs(drawn.rowHeight - row) < 0.01, `a row is the face's: ${drawn.rowHeight}px against ${row}px`);
    assert.ok(hangulGap >= 4, `Korean rows keep their gap: ${hangulGap}px`);
    assert.ok(drawn.width <= drawn.hostWidth + 0.5 && drawn.hostWidth - drawn.width < cell + 16, `the grid fits its host again: ${drawn.width}px of ${drawn.hostWidth}px`);
    assert.ok(Math.abs(latin!.at(-1)! - korean!.at(-1)!) < 0.5, `the Korean row closes on the Latin row's column: ${latin!.at(-1)} / ${korean!.at(-1)}`);
    if (!slow) {
      assert.deepEqual([attach.cols, attach.rows], [drawn.cols, drawn.gridRows], "the pane is attached at the face's grid");
      assert.deepEqual(resizes, [], "a face that arrives within the font effect's wait resizes no pty");
    } else {
      assert.deepEqual(resizes.map((frame) => [frame.cols, frame.rows]).at(-1), [drawn.cols, drawn.gridRows], "a late face sizes the pty for its grid");
    }
    assert.deepEqual(errors, []);
    await context.close();
  }

  for (const grow of [true, false]) {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, serviceWorkers: "block" });
    await context.addInitScript(() => {
      localStorage.setItem("ovis:settings", JSON.stringify({ language: "en", defaultView: "terminal", alertsOn: false }));
      const asked: string[] = [];
      const load = FontFaceSet.prototype.load;
      FontFaceSet.prototype.load = function (this: FontFaceSet, font: string, text?: string) { asked.push(text ?? ""); return load.call(this, font, text); };
      Object.assign(window, { fontLoadsAsked: asked });
    });
    const page = await context.newPage();
    page.setDefaultTimeout(WAIT_MS);
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    const frames = paneFrames(page, pane);
    const held: Route[] = [];
    let release = false;
    await page.route(FACE, (route) => release ? route.continue() : void held.push(route));
    await page.goto(`http://127.0.0.1:${server.port}/?pane=${encodeURIComponent(pane)}`);
    await page.locator(shownRows(), { hasText: ROWS[1]! }).waitFor();
    await frames.inputReady();
    const box = (await page.locator(".pane-terminal").boundingBox())!;
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    const cdp = await context.newCDPSession(page);
    const pair = (distance: number) => [{ x: cx - distance / 2, y: cy, id: 1 }, { x: cx + distance / 2, y: cy, id: 2 }];
    const fontPx = () => page.evaluate((shown) => Number.parseFloat(getComputedStyle(document.querySelector(shown)!).fontSize), shownRows());
    const badge = page.locator(".terminal-font-size");
    const startPx = await fontPx();
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: pair(100) });
    await badge.waitFor({ state: "visible" });
    const steps = grow ? [130, 160, 190, 220] : [130, 160, 130, 100];
    for (const distance of steps) await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: pair(distance) });
    const pinchedPx = await fontPx();
    if (grow) assert.ok(pinchedPx > startPx, `the pinch grew the font: ${startPx} → ${pinchedPx}`);
    else assert.equal(pinchedPx, startPx, "the pinch came back to the saved size");
    const before = frames.resizes().length;
    release = true;
    for (const route of held.splice(0)) await route.continue();
    await page.waitForFunction(([family, shown]) => getComputedStyle(document.querySelector(shown)!).fontFamily.includes(family), [FAMILY, shownRows()] as const);
    assert.equal(await fontPx(), pinchedPx, `the arriving face keeps the pinch's live size (grow=${grow})`);
    assert.deepEqual(frames.resizes().slice(before), [], `no resize while the fingers are down (grow=${grow})`);
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await badge.waitFor({ state: "hidden" });
    // xterm adds and removes row elements in the resize itself; their text is drawn again in a later frame
    const gridRows = await page.evaluate((shown) => document.querySelector(shown)!.children.length, shownRows());
    const after = frames.resizes().slice(before);
    assert.equal(after.length, 1, `one resize when the fingers lift (grow=${grow}): ${JSON.stringify(after)}`);
    assert.equal(after[0]!.rows, gridRows, "the resize is the grid the face gave");
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ grow, startPx, pinchedPx, resizesAfterRelease: after }));
    await context.close();
  }
  console.log("PASS the terminal sizes its grid and its pane from the bundled JetBrains Mono, though the face arrived after it opened, after the font effect's wait, and mid-pinch");
} finally {
  await browser?.close();
  server?.stop();
  for (const workspace of workspaces) await workspaceClose(workspace);
  rmSync(state, { recursive: true, force: true });
}
