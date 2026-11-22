import "./test-herdr.ts";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright-core";
import { paneSendText, tabCreate, workspaceClose, workspaceCreate } from "../server/herdr/client.ts";
import { chromePath } from "./chrome-path.ts";
import { shownRow, shownRows } from "./shown-rows.ts";
import { pickTab } from "./tab-pick.ts";
import { gridTestServer, terminalGrid } from "./terminal-grid.ts";

const root = realpathSync(mkdtempSync(join(tmpdir(), "ovis-switch-resize-")));
const evidence = process.env["UI_EVIDENCE_DIR"];
if (evidence) mkdirSync(evidence, { recursive: true });
const draw = join(root, "draw.sh");
writeFileSync(draw, [
  "label=$1; set -- $(stty size); c=$2",
  "printf '\\033[2J\\033[H'",
  "i=1; while [ $i -le 6 ]; do printf \"\\033[$i;1HROW$i\\033[$i;${c}H#\"; i=$((i+1)); done",
  "printf '\\033[8;1H'; i=0; while [ $i -le 14 ]; do printf 'LONG%04d' $i; i=$((i+1)); done",
  "printf '\\nDRAWN-%s\\n' \"$label\"",
  "",
].join("\n"));
let server: Awaited<ReturnType<typeof gridTestServer>> | undefined;
const browsers: Browser[] = [];
let workspace: string | null = null;

async function viewer(origin: string, width: number, pane: string, panes: string[], allowReplay = false) {
  // Separate browsers: each viewer keeps its own window focus, as two devices do.
  const browser = await chromium.launch({ executablePath: chromePath(), headless: true, args: ["--no-sandbox"] });
  browsers.push(browser);
  const phone = width < 600;
  const context = await browser.newContext({ viewport: { width, height: phone ? 800 : 900 }, isMobile: phone, hasTouch: phone, colorScheme: "dark" });
  await context.addInitScript(({ panes }) => {
    localStorage.setItem("ovis:settings", JSON.stringify({ language: "en", theme: "dark", releasePaneAway: false }));
    for (const id of panes) localStorage.setItem(`ovis:view:${id}`, "terminal");
  }, { panes });
  const page = await context.newPage();
  const sent: { type: string; pane_id?: string }[] = [];
  page.on("websocket", (ws) => ws.on("framesent", ({ payload }) => { sent.push(JSON.parse(String(payload))); }));
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const waitForGrid = await terminalGrid(page, pane);
  const [grid] = await Promise.all([waitForGrid(15_000, allowReplay), page.goto(`${origin}/?pane=${encodeURIComponent(pane)}`)]);
  await page.locator(`[data-layout-pane="${pane}"] [data-pane-content]`).waitFor();
  return { page, sent, grid, waitForGrid, close: async () => { assert.deepEqual(errors, [], "no browser errors"); await context.close(); } };
}
const rows = (page: Page, pane: string): Promise<string[]> => page.locator(shownRow(`[data-layout-pane="${pane}"]`))
  .evaluateAll((divs) => divs.map((div) => (div.textContent ?? "").replace(/\s+$/, "")));
const shows = async (page: Page, pane: string, text: string): Promise<void> => {
  try {
    await page.locator(shownRows(`[data-layout-pane="${pane}"]`), { hasText: text }).waitFor({ state: "attached", timeout: 15_000 });
  } catch (error) {
    if (evidence) await page.screenshot({ path: join(evidence, `missing-${text}.png`) });
    throw new Error(`${text} never drawn; rows:\n${(await rows(page, pane)).join("\n")}`, { cause: error });
  }
};

try {
  server = await gridTestServer(root);
  const origin = `http://127.0.0.1:${server.port}`;
  const made = await workspaceCreate({ cwd: root, label: "switch-resize-fixture" });
  workspace = made.workspace.workspace_id;
  const other = await tabCreate({ workspaceId: workspace, label: "other" });
  const target = made.root_pane.pane_id;
  const panes = [target, other.root_pane.pane_id];
  const tabs = new Map([[target, made.root_pane.tab_id], [other.root_pane.pane_id, other.tab.tab_id]]);
  const select = async (page: Page, id: string) => {
    await pickTab(page, tabs.get(id)!);
    await page.locator(`[data-layout-pane="${id}"] [data-pane-content]`).waitFor();
  };
  const failures: string[] = [];
  for (const [cachedWidth, driverWidth] of [[1280, 390], [390, 1280]] as const) {
    const round = `${cachedWidth}-${driverWidth}`;
    const cached = await viewer(origin, cachedWidth, target, panes);
    await Promise.all([shows(cached.page, target, `DRAWN-before-${round}`), paneSendText(target, `sh ${draw} before-${round}\n`)]);
    await select(cached.page, panes[1]!);
    const driver = await viewer(origin, driverWidth, target, panes);
    const marker = `DRAWN-hidden-${round}`;
    await Promise.all([shows(driver.page, target, marker), paneSendText(target, `sh ${draw} hidden-${round}\n`)]);
    await driver.close();
    await cached.page.evaluate(({ pane, row }) => {
      const frames: string[][] = [];
      const matched = Promise.withResolvers<void>();
      const state: { frames: string[][]; expected?: string; matched: Promise<void> } = { frames, matched: matched.promise };
      Object.assign(window, { switchState: state });
      document.addEventListener("pointerdown", () => {
        const grab = () => {
          const frame = document.querySelector(`[data-layout-pane="${pane}"]`);
          if (frame && getComputedStyle(frame).visibility === "visible") {
            const lines = [...frame.querySelectorAll(row)].map((div) => (div.textContent ?? "").replace(/\s+$/, ""));
            frames.push(lines);
            if (state.expected !== undefined && lines.join("\n") === state.expected) { matched.resolve(); return; }
          }
          requestAnimationFrame(grab);
        };
        requestAnimationFrame(grab);
      }, { once: true, capture: true });
    }, { pane: target, row: shownRow() });
    // Starting the reference attach earlier can snapshot the replay for the driver's grid.
    // Capture the return from pointerdown as before, but open the reference after the
    // cached device has taken back its grid and parsed herdr's live whole-screen redraw.
    const [returnedGrid] = await Promise.all([cached.waitForGrid(15_000), select(cached.page, target)]);
    const truth = await viewer(origin, cachedWidth, target, panes, true);
    assert.deepEqual(truth.grid, returnedGrid, `${round}: both viewers use the same grid`);
    const painted = await truth.page.waitForFunction(({ row, count, marker }) => {
      const lines = [...document.querySelectorAll(row)].map(div => (div.textContent ?? "").replace(/\s+$/, ""));
      return lines.length === count && lines.some(line => line.includes(marker)) ? lines : null;
    }, { row: shownRow(`[data-layout-pane="${target}"]`), count: truth.grid.rows, marker }, { timeout: 15_000 });
    const expected = await painted.jsonValue();
    await painted.dispose();
    assert.ok(expected);
    const settled = await cached.page.evaluate(async (expected) => {
      const state = (window as unknown as { switchState: { frames: string[][]; expected?: string; matched: Promise<void> } }).switchState;
      state.expected = expected;
      const bound = new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 5000));
      return { matched: await Promise.race([state.matched.then(() => true), bound]), painted: state.frames };
    }, expected.join("\n"));
    const actual = await rows(cached.page, target);
    if (!cached.sent.some((frame) => frame.type === "watch" && frame.pane_id === target)) failures.push(`${round}: the hidden tab never watched its pane`);
    if (!settled.matched) {
      failures.push(`${round}: the returned tab differs from a fresh attach\n--- returned\n${actual.join("\n")}\n--- fresh attach\n${expected.join("\n")}`);
    } else {
      // a frame drawn for a wider grid is shown cut at this one's edge (herdr's own view of it), so only
      // what no single grid draws marks a torn frame: two edge markers on one row, or the long line twice
      const torn = settled.painted.find((lines) => lines.some((line) => line.split("#").length > 2) || lines.join("\n").split("LONG0014").length > 2);
      if (torn) failures.push(`${round}: a frame painted on return mixes two grids\n${torn.join("\n")}`);
    }
    if (evidence) {
      await cached.page.screenshot({ path: join(evidence, `returned-${round}.png`) });
      await truth.page.screenshot({ path: join(evidence, `fresh-${round}.png`) });
    }
    console.log(JSON.stringify({ round, match: settled.matched }));
    await truth.close();
    await cached.close();
  }
  assert.deepEqual(failures, [], failures.join("\n\n"));
} finally {
  for (const browser of browsers) await browser.close();
  server?.stop();
  if (workspace !== null) await workspaceClose(workspace);
  rmSync(root, { recursive: true, force: true });
}
