/**
 * lib/terminalGlyphs.ts fits
 * a wide glyph to its two cells (centered, enlarged or widened with scaleX), and did it in the span
 * xterm drew, which also paints the cells' background, clipping that span's trailing half at its
 * last cell. The clipped (and stretched) edge fell inside a device pixel, drawn half-covered, while
 * the next span's background starts on a whole one: in a dark block (Claude Code's prompt, an
 * inverse line) a light line stood after every Korean word, in Chromium and in WebKit (Ovis for
 * Mac, Safari), at 1x and 2x.
 */
import "./test-herdr.ts";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Page } from "playwright-core";
import { createServer } from "../server/index.ts";
import { UsageService } from "../server/usage.ts";
import { herdrRpc, workspaceClose, workspaceCreate } from "../server/herdr/client.ts";
import { chromePath } from "./chrome-path.ts";
import { shownRows } from "./shown-rows.ts";

const DARK = "\x1b[48;2;38;38;38m\x1b[38;2;220;220;220m";
const LIGHT = "\x1b[48;2;232;232;232m\x1b[38;2;30;30;30m";
const RESET = "\x1b[0m";
const ROWS = [
  `${DARK} 화씨, 섭씨를 바꿀 수 있도록 UI를 임시로 넣어 ${RESET}`,
  `${LIGHT} 다만 이건 하나의 의견이니 너의 의견도 ${RESET}`,
  `\x1b[7m 지금은 F는 2도, C는 1도로 했는데 \x1b[27m`,
  `${DARK} 한글${RESET}|`,
  "|abcdefghijklmn|",
  "|가나다라마바사|",
  `\x1b[4m밑줄 친 한글\x1b[24m|`,
];
// the bundled faces, so every machine draws the same: the Latin's 0.6em cell beside 1em Hangul, as Menlo on a Mac
const TERMINAL_FONT = "Ovis Hangul Mono, JetBrains Mono Web";
const TOLERANCE = 24;

const state = mkdtempSync(join(tmpdir(), "terminal-hangul-seam-"));
const evidence = process.env["CHECK_BROWSER_EVIDENCE_DIR"] || state;
mkdirSync(evidence, { recursive: true });
const workspaces: string[] = [];
let server: ReturnType<typeof createServer> | undefined;
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

interface Span { left: number; right: number; background: number[] | null; fitted: boolean; text: string }
interface Row { top: number; height: number; spans: Span[] }

const FITTED = "[style*='clip-path'], .ghostty-wide";

const drawnRows = (page: Page, count: number): Promise<{ rows: Row[]; frame: { left: number; top: number; width: number; height: number } }> =>
  page.evaluate(([count, shown, fitted]) => {
    const container = document.querySelector<HTMLElement>(shown)!;
    const canvas = document.createElement("canvas").getContext("2d", { willReadFrequently: true })!;
    const rgba = (value: string): number[] | null => {
      canvas.clearRect(0, 0, 1, 1);
      canvas.fillStyle = value;
      canvas.fillRect(0, 0, 1, 1);
      const data = [...canvas.getImageData(0, 0, 1, 1).data];
      return data[3] === 0 ? null : data.slice(0, 3);
    };
    const frame = container.getBoundingClientRect();
    const rows = [...container.children].slice(0, count).map((row): Row => {
      const box = row.getBoundingClientRect();
      const spans = [...row.children].filter((node): node is HTMLElement => node instanceof HTMLElement).map((span): Span => {
        const rect = span.getBoundingClientRect();
        return { left: rect.left, right: rect.right, background: rgba(getComputedStyle(span).backgroundColor), fitted: span.style.clipPath !== "" || span.querySelector(fitted) !== null, text: span.textContent ?? "" };
      });
      return { top: box.top, height: box.height, spans };
    });
    return { rows, frame: { left: frame.left, top: frame.top, width: frame.width, height: frame.height } };
  }, [count, shownRows(), FITTED] as const);

async function pixels(page: Page, png: Buffer): Promise<{ width: number; height: number; data: number[] }> {
  return page.evaluate(async (base64) => {
    const image = new Image();
    image.src = `data:image/png;base64,${base64}`;
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const context = canvas.getContext("2d", { willReadFrequently: true })!;
    context.drawImage(image, 0, 0);
    return { width: canvas.width, height: canvas.height, data: [...context.getImageData(0, 0, canvas.width, canvas.height).data] };
  }, png.toString("base64"));
}

try {
  const program = join(state, "rows.mjs");
  writeFileSync(program, `process.stdout.write(${JSON.stringify(`\x1b[2J\x1b[H${ROWS.join("\r\n")}\r\nROWS_READY\r\n`)});
setInterval(() => {}, 1 << 30);
`);
  const made = await workspaceCreate({ cwd: state, label: "ovis-test-hangul-seam" });
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
  const failures: string[] = [];
  for (const theme of ["light", "dark"] as const) {
    for (const deviceScaleFactor of [1, 2]) {
      const context = await browser.newContext({ viewport: { width: 1200, height: 760 }, deviceScaleFactor });
      await context.addInitScript(([terminalFontFamily, theme]) => localStorage.setItem("ovis:settings", JSON.stringify({
        language: "en", defaultView: "terminal", alertsOn: false, terminalFontFamily, theme,
      })), [TERMINAL_FONT, theme] as const);
      const page = await context.newPage();
      page.setDefaultTimeout(10000);
      const errors: string[] = [];
      page.on("pageerror", error => errors.push(error.message));
      await page.goto(`http://127.0.0.1:${server.port}/?pane=${encodeURIComponent(pane)}`);
      await page.locator(".conn-live").waitFor();
      await page.locator(shownRows(), { hasText: "한글" }).waitFor();
      await page.evaluate(() => document.fonts.ready.then(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))));
      await page.waitForFunction(([shown, fitted]) => document.querySelector(shown)?.querySelector(fitted) != null, [shownRows(), FITTED] as const);
      const renderer = await page.evaluate(() => document.querySelector<HTMLElement>(".pane-terminal")?.dataset["renderer"] ?? "xterm");

      const { rows, frame } = await drawnRows(page, ROWS.length);
      const clip = { x: frame.left, y: rows[0]!.top, width: frame.width, height: rows.at(-1)!.top + rows.at(-1)!.height - rows[0]!.top };
      const png = await page.screenshot({ clip });
      const name = `terminal-hangul-seam-${theme}-${deviceScaleFactor}x`;
      writeFileSync(join(evidence, `${name}.png`), png);
      const shot = await pixels(page, png);
      const at = (x: number, y: number): number[] => { const index = (y * shot.width + x) * 4; return shot.data.slice(index, index + 3); };
      const off = (pixel: number[], background: number[]) => Math.max(...pixel.map((value, channel) => Math.abs(value - background[channel]!)));
      const seams: string[] = [];
      let edges = 0;
      rows.forEach((row, index) => {
        const lines = [Math.ceil((row.top - clip.y) * deviceScaleFactor), Math.floor((row.top + row.height - clip.y) * deviceScaleFactor) - 1];
        row.spans.forEach((span, at_) => {
          const next = row.spans[at_ + 1];
          if (!span.fitted || !span.background || !next) return;
          const edge = (next.left - clip.x) * deviceScaleFactor;
          const columns = [Math.floor(edge) - 1, Math.floor(edge), Math.floor(edge) + 1].filter(x => x >= 0 && x < shot.width);
          edges += 1;
          for (const y of lines) {
            for (const x of columns) {
              const expected = x < Math.round(edge) ? span.background : next.background ?? at(shot.width - 2, y);
              const stray = off(at(x, y), expected);
              if (stray > TOLERANCE) seams.push(`row ${index} after "${span.text}" x=${x} y=${y}: ${at(x, y).join(",")} vs ${expected.join(",")}`);
            }
          }
        });
      });
      const bars = await page.evaluate((shown) => [...document.querySelector(shown)!.children].slice(4, 6).map((row) => {
        const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
        let right = Number.NaN;
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          const at = node.textContent!.lastIndexOf("|");
          if (at < 0) continue;
          const range = document.createRange();
          range.setStart(node, at);
          range.setEnd(node, at + 1);
          right = range.getBoundingClientRect().left;
        }
        return right;
      }), shownRows());
      if (!(Math.abs(bars[0]! - bars[1]!) < 0.5)) failures.push(`${name}: the Korean row's closing bar stands at ${bars[1]}, the Latin row's at ${bars[0]}`);
      console.log(`${name} (${renderer}): ${edges} fitted run edges checked, ${seams.length} stray pixels, bars at ${bars.join(" / ")}`);
      if (edges === 0) failures.push(`${name}: no fitted Hangul run was drawn`);
      if (seams.length > 0) failures.push(`${name}: ${seams.slice(0, 6).join("; ")}`);
      if (errors.length > 0) failures.push(`${name}: page errors ${errors.join("; ")}`);
      await context.close();
    }
  }
  assert.deepEqual(failures, []);
  console.log("PASS a fitted Hangul run's background meets the next cell's without a seam");
} finally {
  await browser?.close();
  server?.stop();
  for (const workspace of workspaces) await workspaceClose(workspace);
  rmSync(state, { recursive: true, force: true });
}
