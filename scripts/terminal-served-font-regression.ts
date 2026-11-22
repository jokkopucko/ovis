import "./test-herdr.ts";
import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Page } from "playwright-core";
import { createServer } from "../server/index.ts";
import { UsageService } from "../server/usage.ts";
import { herdrRpc, workspaceClose, workspaceCreate } from "../server/herdr/client.ts";
import { chromePath } from "./chrome-path.ts";
import { shownRows } from "./shown-rows.ts";

const ROW = "|abcdefghijklmn|";
const FAMILY = "QA Served Mono";
const WAIT_MS = 10000;

const state = mkdtempSync(join(tmpdir(), "terminal-served-font-"));
const evidence = process.env["CHECK_BROWSER_EVIDENCE_DIR"] || state;
mkdirSync(evidence, { recursive: true });
const workspaces: string[] = [];
let server: ReturnType<typeof createServer> | undefined;
let locked: ReturnType<typeof createServer> | undefined;
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

interface Frame { type: string; pane_id?: string; cols?: number; rows?: number }

function paneFrames(page: Page, pane: string): Frame[] {
  const sent: Frame[] = [];
  page.on("websocket", (socket) => socket.on("framesent", ({ payload }) => {
    const message = JSON.parse(String(payload)) as Frame;
    if (message.pane_id === pane) sent.push(message);
  }));
  return sent;
}

function fontRequests(page: Page): string[] {
  const asked: string[] = [];
  page.on("request", (request) => {
    const { pathname } = new URL(request.url());
    if (pathname.startsWith("/api/fonts")) asked.push(decodeURIComponent(pathname));
  });
  return asked;
}

async function open(page: Page, pane: string): Promise<void> {
  await page.goto(`http://127.0.0.1:${server!.port}/?pane=${encodeURIComponent(pane)}`);
  await page.locator(".conn-live").waitFor();
  await page.locator(shownRows(), { hasText: ROW }).waitFor();
}

try {
  const program = join(state, "row.mjs");
  writeFileSync(program, `process.stdout.write(${JSON.stringify(`\x1b[2J\x1b[H${ROW}\r\nROW_READY\r\n`)});
setInterval(() => {}, 1 << 30);
`);
  const made = await workspaceCreate({ cwd: state, label: "ovis-test-served-font" });
  workspaces.push(made.workspace.workspace_id);
  const pane = made.root_pane.pane_id;
  const ready = herdrRpc("pane.wait_for_output", {
    pane_id: pane, source: "visible", match: { type: "substring", value: "ROW_READY" }, timeout_ms: 10000,
  }, undefined, 12000);
  await herdrRpc("pane.send_input", { pane_id: pane, text: `exec ${quote(process.execPath)} ${quote(program)}`, keys: ["enter"] });
  await ready;

  const stateDir = join(state, "server");
  mkdirSync(join(stateDir, "fonts"), { recursive: true });
  copyFileSync(new URL("../src/fonts/JetBrainsMono-Regular.woff2", import.meta.url), join(stateDir, "fonts", `${FAMILY}.woff2`));
  server = createServer({ port: 0, hostname: "127.0.0.1", token: "", stateDir, tailscaleOwner: null, usage: new UsageService(undefined, []) });
  browser = await chromium.launch({ executablePath: chromePath(), headless: true, args: ["--no-sandbox"] });

  for (const [width, height, theme] of [[1280, 800, "dark"], [1280, 800, "light"], [390, 844, "dark"], [390, 844, "light"]] as const) {
    const phone = width < 600;
    const context = await browser.newContext({ viewport: { width, height }, isMobile: phone, hasTouch: phone, serviceWorkers: "block" });
    await context.addInitScript(([family, chosen]) => {
      localStorage.setItem("ovis:settings", JSON.stringify({ language: "en", defaultView: "terminal", alertsOn: false, theme: chosen, terminalFontFamily: family }));
    }, [FAMILY, theme] as const);
    const page = await context.newPage();
    page.setDefaultTimeout(WAIT_MS);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const frames = paneFrames(page, pane);
    const asked = fontRequests(page);
    await open(page, pane);
    await page.waitForFunction(([family, shown]) => getComputedStyle(document.querySelector(shown)!).fontFamily.includes(family), [FAMILY, shownRows()] as const);

    const drawn = await page.evaluate(async ([family, shown]) => {
      const rows = document.querySelector<HTMLElement>(shown)!;
      const size = Number.parseFloat(getComputedStyle(rows).fontSize);
      const canvas = document.createElement("canvas").getContext("2d")!;
      const advance = (font: string) => { canvas.font = font; return canvas.measureText("W").width; };
      const bars: number[] = [];
      const walker = document.createTreeWalker(rows.children[0]!, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        for (let at = node.textContent!.indexOf("|"); at >= 0; at = node.textContent!.indexOf("|", at + 1)) {
          const range = document.createRange();
          range.setStart(node, at);
          range.setEnd(node, at + 1);
          bars.push(range.getBoundingClientRect().left);
        }
      }
      const glyph = advance(`${size}px "${family}", serif`);
      return {
        face: [...document.fonts].filter((face) => face.family.replaceAll('"', "") === family).map((face) => face.status),
        glyph,
        serif: advance(`${size}px serif`),
        cell: (bars.at(-1)! - bars[0]!) / 15,
        cols: Math.round(Number.parseFloat(document.querySelector<HTMLElement>(".pane-terminal .xterm-screen")!.style.width) / glyph),
        gridRows: rows.children.length,
        kept: await (await caches.open("ovis-files-v1")).keys().then((keys) => keys.map((key) => decodeURIComponent(new URL(key.url).pathname)).filter((path) => path.startsWith("/api/fonts/"))),
      };
    }, [FAMILY, shownRows()] as const);
    const attach = frames.find((frame) => frame.type === "attach");
    const resizes = frames.filter((frame) => frame.type === "resize");
    console.log(JSON.stringify({ width, theme, asked, attach, resizes, ...drawn }));
    await page.screenshot({ path: join(evidence, `terminal-served-font-${width}-${theme}.png`) });
    assert.deepEqual(drawn.face, ["loaded"], "the served face is on the page, once");
    assert.notEqual(drawn.glyph, drawn.serif, "the family draws in the served face, not a fallback");
    assert.ok(Math.abs(drawn.cell - drawn.glyph) < 0.05, `a cell is the served face's advance: ${drawn.cell} against ${drawn.glyph}`);
    assert.deepEqual(asked, ["/api/fonts", `/api/fonts/${FAMILY}.woff2`], "the list and the named file, each once");
    assert.deepEqual(drawn.kept, [`/api/fonts/${FAMILY}.woff2`], "the file is kept for the next load");
    assert.ok(attach, "the pane is attached");
    assert.deepEqual([attach.cols, attach.rows], [drawn.cols, drawn.gridRows], "the pane is attached at the served face's grid");
    // a resize to the grid it attached at changes no pty (the server drops it): a late first role-ack refits to that
    // same grid, so only a resize to another grid is the served face resizing the pty
    assert.deepEqual(resizes.filter((frame) => frame.cols !== attach.cols || frame.rows !== attach.rows), [], "the served face resizes no pty");
    assert.deepEqual(errors, []);
    await context.close();
  }

  {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    await context.addInitScript((family) => {
      localStorage.setItem("ovis:settings", JSON.stringify({ language: "en", defaultView: "terminal", alertsOn: false, terminalFontFamily: family }));
    }, FAMILY);
    const page = await context.newPage();
    page.setDefaultTimeout(WAIT_MS);
    const asked = fontRequests(page);
    const loaded = () => page.waitForFunction((family) => [...document.fonts].some((face) => face.family.replaceAll('"', "") === family && face.status === "loaded"), FAMILY);
    await open(page, pane);
    await loaded();
    await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
    await page.reload();
    await page.locator(".conn-live").waitFor();
    await loaded();
    await page.waitForFunction(async () => (await caches.keys()).some((name) => name.startsWith("ovis-v4-")));
    await page.reload();
    await page.locator(".conn-live").waitFor();
    await loaded();
    console.log(JSON.stringify({ serviceWorker: true, asked, caches: await page.evaluate(() => caches.keys()) }));
    assert.deepEqual(asked.filter((path) => path !== "/api/fonts"), [`/api/fonts/${FAMILY}.woff2`], "the file is fetched once across reloads under the service worker");
    await context.close();
  }

  {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, serviceWorkers: "block" });
    await context.addInitScript((family) => {
      localStorage.setItem("ovis:settings", JSON.stringify({ language: "en", defaultView: "terminal", alertsOn: false, chatFontFamily: family }));
    }, FAMILY);
    const page = await context.newPage();
    page.setDefaultTimeout(WAIT_MS);
    const asked = fontRequests(page);
    await open(page, pane);
    await page.waitForFunction((family) => [...document.fonts].some((face) => face.family.replaceAll('"', "") === family && face.status === "loaded"), FAMILY);
    assert.deepEqual(asked, ["/api/fonts", `/api/fonts/${FAMILY}.woff2`], "the chat font's served file is fetched");
    await context.close();
  }

  // When: the device must sign in first, with the chat font naming FAMILY: the list asked while signed out is
  // refused, and the face joins the page once the token is in, with no reload.
  {
    const lockedDir = join(state, "locked");
    mkdirSync(join(lockedDir, "fonts"), { recursive: true });
    copyFileSync(new URL("../src/fonts/JetBrainsMono-Regular.woff2", import.meta.url), join(lockedDir, "fonts", `${FAMILY}.woff2`));
    locked = createServer({ port: 0, hostname: "127.0.0.1", token: "served-font-token", stateDir: lockedDir, tailscaleOwner: null, usage: new UsageService(undefined, []) });
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, serviceWorkers: "block" });
    await context.addInitScript((family) => {
      localStorage.setItem("ovis:settings", JSON.stringify({ language: "en", alertsOn: false, chatFontFamily: family }));
    }, FAMILY);
    const page = await context.newPage();
    page.setDefaultTimeout(WAIT_MS);
    const asked = fontRequests(page);
    await page.goto(`http://127.0.0.1:${locked.port}/`);
    await page.getByText("Have an access token instead?").click();
    await page.locator("#access-gate-token").fill("served-font-token");
    await page.getByRole("button", { name: "Unlock" }).click();
    await page.waitForFunction((family) => [...document.fonts].some((face) => face.family.replaceAll('"', "") === family && face.status === "loaded"), FAMILY);
    console.log(JSON.stringify({ signIn: true, asked }));
    assert.ok(asked.includes(`/api/fonts/${FAMILY}.woff2`), "the chat font's served file is fetched once signed in");
    await context.close();
  }

  {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, serviceWorkers: "block" });
    await context.addInitScript(() => {
      localStorage.setItem("ovis:settings", JSON.stringify({ language: "en", defaultView: "terminal", alertsOn: false }));
    });
    const page = await context.newPage();
    page.setDefaultTimeout(WAIT_MS);
    const asked = fontRequests(page);
    await open(page, pane);
    await page.waitForFunction((shown) => getComputedStyle(document.querySelector(shown)!).fontFamily.includes("JetBrains Mono Web"), shownRows());
    assert.deepEqual(asked, [], "no request for fonts while none is named");
    await context.close();
  }
  console.log("PASS a font named in Settings is drawn from the PC's fonts/ folder, the terminal measured from it and attached once, and nothing is asked while none is named");
} finally {
  await browser?.close();
  server?.stop();
  locked?.stop();
  for (const workspace of workspaces) await workspaceClose(workspace);
  rmSync(state, { recursive: true, force: true });
}
