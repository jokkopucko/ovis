/**
 * Chrome trims a
 * run of fullwidth punctuation (text-spacing-trim). A glyph measured as a run of 32 read ，。（） at half
 * width, so each one took half a glyph too much spacing and the rest of the row drew to the right.
 */
import "./test-herdr.ts";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { herdrRpc, workspaceClose, workspaceCreate } from "../server/herdr/client.ts";
import { chromePath } from "./chrome-path.ts";
import { shownRow, shownRows } from "./shown-rows.ts";
import { gridTestServer, terminalGrid } from "./terminal-grid.ts";

const MARK_COLUMN = 100;
const ROWS = [
  "plain ascii row",
  "Ask: skill 集整改并给证据。wanted: 每条判据可核验。For you 如下，Now / Next 无剩余任务。",
  "完成审计（全绿）「飞机师」、；：。，",
  "한국어，중국어 문장부호（괄호）와 함께。",
];

const state = mkdtempSync(join(tmpdir(), "terminal-cjk-punctuation-"));
const evidence = process.env["CHECK_BROWSER_EVIDENCE_DIR"] || state;
mkdirSync(evidence, { recursive: true });
const workspaces: string[] = [];
let server: Awaited<ReturnType<typeof gridTestServer>> | undefined;
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

try {
  const program = join(state, "rows.mjs");
  const screen = ROWS.map((row, index) => `${row}\x1b[${MARK_COLUMN}G|MARK${index}`).join("\r\n");
  writeFileSync(program, `process.stdout.write(${JSON.stringify(`\x1b[2J\x1b[H${screen}\r\nROWS_READY\r\n`)});
setInterval(() => {}, 1 << 30);
`);
  const made = await workspaceCreate({ cwd: state, label: "ovis-test-cjk-punctuation" });
  workspaces.push(made.workspace.workspace_id);
  const pane = made.root_pane.pane_id;
  server = await gridTestServer(state);
  browser = await chromium.launch({ executablePath: chromePath(), headless: true, args: ["--no-sandbox"] });
  // a Chinese page, as the report's: under zh every fullwidth mark is trimmed, not only ，（）
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: "zh-CN" });
  await context.addInitScript(() => localStorage.setItem("ovis:settings", JSON.stringify({
    language: "zh", defaultView: "terminal", alertsOn: false,
  })));
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  // Draw after herdr has taken the browser's grid, so column 100 and the marker fit.
  const waitForGrid = await terminalGrid(page, pane);
  const [grid] = await Promise.all([waitForGrid(10_000),
    page.goto(`http://127.0.0.1:${server.port}/?pane=${encodeURIComponent(pane)}`)]);
  assert.ok(grid.cols >= MARK_COLUMN + `|MARK${ROWS.length - 1}`.length - 1);
  await page.locator(".conn-live").waitFor();
  await Promise.all([
    herdrRpc("pane.wait_for_output", {
      pane_id: pane, source: "visible", match: { type: "substring", value: "ROWS_READY" }, timeout_ms: 10000,
    }, undefined, 12000),
    herdrRpc("pane.send_input", { pane_id: pane, text: `exec ${quote(process.execPath)} ${quote(program)}`, keys: ["enter"] }),
  ]);
  // xterm can finish a render before Ghostty's rows are ready, and either renderer can
  // split a marker between spans. Locate all markers and measure them in the same paint.
  const sample = await page.waitForFunction(([count, shown, rowSelector]) => {
    const rows = document.querySelector<HTMLElement>(shown);
    if (!rows?.getClientRects().length || getComputedStyle(rows).visibility !== "visible" || document.fonts.status !== "loaded") return null;
    const visibleRows = [...document.querySelectorAll(rowSelector)].filter(row => rows.contains(row));
    const left = rows.getBoundingClientRect().left;
    const marks: number[] = [];
    for (let index = 0; index < count; index += 1) {
      const marker = `|MARK${index}`;
      const row = visibleRows.find(line => line.textContent?.includes(marker));
      if (!row) return null;
      let at = (row.textContent ?? "").indexOf(marker);
      const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node instanceof Text; node = walker.nextNode()) {
        if (at >= node.length) { at -= node.length; continue; }
        const range = document.createRange();
        range.setStart(node, at);
        range.setEnd(node, at + 1);
        const rect = range.getBoundingClientRect();
        if (!rect.width) return null;
        marks.push(rect.left - left);
        break;
      }
    }
    if (marks.length !== count) return null;
    const probe = document.createElement("span");
    probe.style.whiteSpace = "pre";
    probe.style.setProperty("text-spacing-trim", "normal");
    probe.textContent = "，".repeat(32);
    document.body.append(probe);
    const trimmed = probe.getBoundingClientRect().width;
    probe.style.setProperty("text-spacing-trim", "space-all");
    const full = probe.getBoundingClientRect().width;
    probe.remove();
    return { marks, trims: trimmed < full - 1,
      renderer: document.querySelector<HTMLElement>(".pane-terminal")?.dataset["renderer"] ?? "ghostty" };
  }, [ROWS.length, shownRows(), shownRow()] as const);
  const drawn = await sample.jsonValue();
  await sample.dispose();
  assert.ok(drawn);
  console.log(JSON.stringify(drawn));
  await page.screenshot({ path: join(evidence, "terminal-cjk-punctuation.png") });

  assert.equal(drawn.marks.length, ROWS.length, "every row's marker is drawn");
  const [plain, ...others] = drawn.marks;
  others.forEach((x, index) => assert.ok(Math.abs(x - plain!) < 1,
    `row ${index + 1}'s marker is drawn ${(x - plain!).toFixed(1)}px from its column`));
  assert.deepEqual(errors, []);
  console.log(`PASS fullwidth punctuation keeps its row's later cells in their columns${drawn.trims ? "" : " (this browser does not trim punctuation)"}`);
} finally {
  await browser?.close();
  server?.stop();
  for (const workspace of workspaces) await workspaceClose(workspace);
  rmSync(state, { recursive: true, force: true });
}
