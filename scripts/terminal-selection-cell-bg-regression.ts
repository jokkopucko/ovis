/** Selection over a cell with its own background must remain visible. */
import "./test-herdr.ts";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { createServer } from "../server/index.ts";
import { UsageService } from "../server/usage.ts";
import { herdrRpc, workspaceClose, workspaceCreate } from "../server/herdr/client.ts";
import { contrastRatio } from "../src/lib/terminalFold.ts";
import { chromePath } from "./chrome-path.ts";
import { shownRow, shownRows } from "./shown-rows.ts";

type Rgb = readonly [number, number, number];
interface Probe { readonly name: string; readonly row: string; readonly column: number; readonly own: Rgb | null }

const LINES = [
  "\x1b[48;2;50;60;70mCOLORED-TEST-TEXT     \x1b[0m NORMAL-TEST-TEXT",
  "\x1b[44mPALETTE-TEST-TEXT     \x1b[0m NORMAL-TEST-TEXT",
  "\x1b[38;2;0;0;0;48;2;230;230;230mDARK-ON-LIGHT-TEXT    \x1b[0m NORMAL-TEST-TEXT",
  "\x1b[48;2;50;60;70mWIDE-ROW-TEXT \u3000\u3000\uAC00  \x1b[0m NORMAL-TEST-TEXT",
];
const MINIMUM_CONTRAST = 4.5;
const PROBES: readonly Probe[] = [
  { name: "truecolor cell", row: "COLORED-TEST-TEXT", column: 19, own: [50, 60, 70] },
  { name: "palette cell", row: "PALETTE-TEST-TEXT", column: 19, own: null },
  { name: "uncoloured cell", row: "COLORED-TEST-TEXT", column: 22, own: null },
];
const TOLERANCE = 3;

const state = mkdtempSync(join(tmpdir(), "terminal-selection-cell-bg-"));
const evidence = process.env["CHECK_BROWSER_EVIDENCE_DIR"] || state;
mkdirSync(evidence, { recursive: true });
const workspaces: string[] = [];
let server: ReturnType<typeof createServer> | undefined;
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const failures: string[] = [];
const check = (ok: boolean, message: string): void => { if (!ok) failures.push(message); };
const near = (a: Rgb, b: Rgb): boolean => a.every((channel, index) => Math.abs(channel - b[index]!) <= TOLERANCE);

try {
  const program = join(state, "rows.mjs");
  writeFileSync(program, `process.stdout.write(${JSON.stringify(`\x1b[2J\x1b[H${LINES.join("\r\n")}\r\nROWS_READY\r\n`)});
setInterval(() => {}, 1 << 30);
`);
  const made = await workspaceCreate({ cwd: state, label: "ovis-test-selection-cell-bg" });
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
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await context.addInitScript(() => localStorage.setItem("ovis:settings", JSON.stringify({ defaultView: "terminal", alertsOn: false })));
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.port}/?pane=${encodeURIComponent(pane)}`);
  await page.locator(".conn-live").waitFor();
  // libghostty's layer attaches after xterm's first rows: measured before it, xterm's own selection was measured
  await page.locator(".pane-terminal[data-renderer='ghostty']").waitFor();
  await page.locator(shownRows(), { hasText: "ROWS_READY" }).waitFor();
  await page.evaluate(() => document.fonts.ready.then(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))));

  const cellCentre = (row: string, column: number) => page.evaluate(([text, at, rowSelector]) => {
    const element = [...document.querySelectorAll<HTMLElement>(rowSelector)].find((candidate) => candidate.textContent?.includes(text))!;
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    const glyph = (wanted: string): DOMRect => {
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const index = node.textContent!.indexOf(wanted);
        if (index < 0) continue;
        const range = document.createRange();
        range.setStart(node, index);
        range.setEnd(node, index + 1);
        return range.getBoundingClientRect();
      }
      throw new Error(`no ${wanted} in the row`);
    };
    const first = glyph(text);
    walker.currentNode = element;
    const width = (glyph("NORMAL").left - first.left) / 23;
    return { x: first.left + width * (at + 0.5), y: first.top + first.height / 2, width };
  }, [row, column, shownRow()] as const);

  // the app's CSP refuses a data: URL, so the screenshot is decoded in a blank page of its own
  const decoder = await context.newPage();
  const pixels = async (points: readonly { x: number; y: number }[]): Promise<Rgb[]> => {
    // xterm's own renderer highlights coloured cells: measured after a fallback to it, the test would prove nothing
    assert.equal(await page.evaluate(() => document.querySelector<HTMLElement>(".pane-terminal")?.dataset["renderer"]), "ghostty",
      "libghostty draws the pane at every measurement");
    const shot = (await page.screenshot()).toString("base64");
    return decoder.evaluate(async ([data, at]) => {
      const bitmap = await createImageBitmap(await (await fetch(`data:image/png;base64,${data}`)).blob());
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      const context = canvas.getContext("2d")!;
      context.drawImage(bitmap, 0, 0);
      return at.map(({ x, y }) => {
        const [r, g, b] = context.getImageData(Math.round(x), Math.round(y), 1, 1).data;
        return [r!, g!, b!] as const;
      });
    }, [shot, points] as const);
  };

  const centres = await Promise.all(PROBES.map((probe) => cellCentre(probe.row, probe.column)));
  const outside = await cellCentre("COLORED-TEST-TEXT", 17);
  const before = await pixels([...centres, outside]);
  /** two frames: libghostty's layer draws on the frame after xterm's change */
  const drawn = () => page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));

  const selectionShown = () => page.waitForFunction(() => document.querySelector(".pane-terminal .xterm-selection div") !== null);
  const truecolor = PROBES.findIndex((probe) => probe.own !== null);
  check(near(before[truecolor]!, PROBES[truecolor]!.own!), `the truecolor cell is drawn in its own colour before the drag (${before[truecolor]})`);

  const top = await cellCentre("COLORED-TEST-TEXT", 18);
  const bottom = await cellCentre("DARK-ON-LIGHT-TEXT", 40);
  await page.mouse.move(top.x - top.width / 2 + 1, top.y);
  await page.mouse.down();
  await page.mouse.move(bottom.x, bottom.y, { steps: 6 });
  await selectionShown();
  await drawn();
  const box = await page.evaluate(() => getComputedStyle(document.querySelector(".pane-terminal .xterm-selection div")!).backgroundColor);
  const boxRgb = box.match(/\d+/g)!.slice(0, 3).map(Number) as unknown as Rgb;
  const [dragging] = await pixels([centres[truecolor]!]);
  await page.screenshot({ path: join(evidence, "terminal-selection-cell-bg-dragging.png") });
  check(near(dragging!, boxRgb), `mid-drag, the truecolor cell shows the selection ${boxRgb}, not ${dragging}`);
  await page.mouse.up();
  await drawn();
  const selected = await pixels([...centres, outside]);
  await page.screenshot({ path: join(evidence, "terminal-selection-cell-bg.png") });
  console.log(JSON.stringify({ selectionBox: box,
    cells: PROBES.map((probe, index) => ({ cell: probe.name, before: before[index], selected: selected[index] })) }));

  const plain = selected[PROBES.length - 1]!;
  check(!near(plain, before[PROBES.length - 1]!), `the uncoloured cell shows the selection (${before.at(-1)} -> ${plain})`);
  PROBES.forEach((probe, index) => {
    check(!near(selected[index]!, before[index]!), `the ${probe.name} changes under the selection (${before[index]} -> ${selected[index]})`);
    check(near(selected[index]!, plain), `the ${probe.name} shows the selection colour ${plain}, not ${selected[index]}`);
  });
  check(near(selected[PROBES.length]!, PROBES[truecolor]!.own!), `a coloured cell outside the selection keeps its colour (${selected[PROBES.length]})`);
  const dark = await page.evaluate(([rowSelector]) => {
    const row = [...document.querySelectorAll<HTMLElement>(rowSelector)].find((candidate) => candidate.textContent?.includes("DARK-ON-LIGHT"))!;
    const glyphs = [...row.querySelectorAll<HTMLElement>("span")].find((span) => span.textContent?.startsWith("DARK"))!;
    return getComputedStyle(glyphs).color;
  }, [shownRow()] as const);
  const hex = (rgb: string): string => `#${rgb.match(/\d+/g)!.slice(0, 3).map((n) => Number(n).toString(16).padStart(2, "0")).join("")}`;
  const darkContrast = contrastRatio(hex(dark), hex(box))!;
  check(darkContrast >= MINIMUM_CONTRAST - 0.05, `selected text is readable on the selection: ${dark} on ${box} is ${darkContrast.toFixed(2)}:1`);

  await page.mouse.click(bottom.x, bottom.y + bottom.width * 6);
  await page.waitForFunction(() => document.querySelector(".pane-terminal .xterm-selection div") === null);
  await drawn();
  const [cleared] = await pixels([centres[truecolor]!]);
  check(near(cleared!, PROBES[truecolor]!.own!), `the truecolor cell is its own colour once the selection is gone (${cleared})`);

  // an Alt drag selects a column (xterm's column select): the same columns on every row, and no others
  const [colTop, colBottom] = [await cellCentre("COLORED-TEST-TEXT", 18), await cellCentre("PALETTE-TEST-TEXT", 20)];
  const columnProbes = [
    { name: "first row's selected cell", at: await cellCentre("COLORED-TEST-TEXT", 19), selected: true },
    { name: "second row's selected cell", at: await cellCentre("PALETTE-TEST-TEXT", 19), selected: true },
    { name: "first row's cell right of the column", at: await cellCentre("COLORED-TEST-TEXT", 21), selected: false },
    { name: "second row's cell left of the column", at: await cellCentre("PALETTE-TEST-TEXT", 17), selected: false },
  ];
  const columnBefore = await pixels(columnProbes.map((probe) => probe.at));
  await page.keyboard.down("Alt");
  await page.mouse.move(colTop.x - colTop.width / 2 + 1, colTop.y);
  await page.mouse.down();
  await page.mouse.move(colBottom.x, colBottom.y, { steps: 4 });
  await page.mouse.up();
  await page.keyboard.up("Alt");
  await selectionShown();
  await drawn();
  const columnAfter = await pixels(columnProbes.map((probe) => probe.at));
  await page.screenshot({ path: join(evidence, "terminal-selection-cell-bg-column.png") });
  columnProbes.forEach((probe, index) => {
    const expected = probe.selected ? boxRgb : columnBefore[index]!;
    check(near(columnAfter[index]!, expected), `column select: the ${probe.name} is ${columnAfter[index]}, expected ${expected}`);
  });

  // a column whose edge falls inside a wide glyph: xterm tells a wide cell selected by its first column alone
  // (DomRendererRowFactory) and copies only that, so a glyph whose first column is left of the column stays unselected
  await page.mouse.click(bottom.x, bottom.y + bottom.width * 6);
  await page.waitForFunction(() => document.querySelector(".pane-terminal .xterm-selection div") === null);
  await drawn();
  const wideProbes = [
    { name: "unselected wide glyph's half left of the column", at: await cellCentre("WIDE-ROW-TEXT", 14), selected: false },
    { name: "unselected wide glyph's half inside the column", at: await cellCentre("WIDE-ROW-TEXT", 15), selected: false },
    { name: "selected wide glyph's first half", at: await cellCentre("WIDE-ROW-TEXT", 16), selected: true },
    { name: "selected wide glyph's second half", at: await cellCentre("WIDE-ROW-TEXT", 17), selected: true },
  ];
  const wideBefore = await pixels(wideProbes.map((probe) => probe.at));
  wideProbes.forEach((probe, index) => check(near(wideBefore[index]!, PROBES[truecolor]!.own!),
    `the ${probe.name} is drawn in its own colour before the drag (${wideBefore[index]})`));
  // the column starts a row up, on text: a column of blanks alone copies nothing, and xterm takes it for an Alt click
  // that moves the cursor (altClickMovesCursor)
  const [wideFrom, wideTo] = [await cellCentre("DARK-ON-LIGHT-TEXT", 15), wideProbes[3]!.at];
  await page.keyboard.down("Alt");
  await page.mouse.move(wideFrom.x - wideFrom.width / 2 + 1, wideFrom.y);
  await page.mouse.down();
  await page.mouse.move(wideTo.x, wideTo.y, { steps: 4 });
  await page.mouse.up();
  await page.keyboard.up("Alt");
  await selectionShown();
  await drawn();
  const wideAfter = await pixels(wideProbes.map((probe) => probe.at));
  await page.screenshot({ path: join(evidence, "terminal-selection-cell-bg-wide.png") });
  wideProbes.forEach((probe, index) => {
    const expected = probe.selected ? boxRgb : PROBES[truecolor]!.own!;
    check(near(wideAfter[index]!, expected), `wide column select: the ${probe.name} is ${wideAfter[index]}, expected ${expected}`);
  });
  assert.deepEqual(failures, []);
  assert.deepEqual(errors, []);
  console.log("PASS a drag selection is seen over truecolor, palette and uncoloured cells alike, and only there");
} finally {
  await browser?.close();
  server?.stop();
  for (const workspace of workspaces) await workspaceClose(workspace);
  rmSync(state, { recursive: true, force: true });
}
