/**
 * A recent tab kept live off-screen while another viewer drives the pane at another size: once the
 * tab is selected again its screen must match what a fresh attach at the same size shows.
 */
import "./test-herdr.ts";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright-core";
import { createServer } from "../server/index.ts";
import { paneSendText, tabCreate, workspaceClose, workspaceCreate } from "../server/herdr/client.ts";
import { UsageService } from "../server/usage.ts";
import { chromePath } from "./chrome-path.ts";

const root = realpathSync(mkdtempSync(join(tmpdir(), "ovis-switch-resize-")));
const evidence = process.env["UI_EVIDENCE_DIR"];
if (evidence) mkdirSync(evidence, { recursive: true });
// Draws a screen for the pty's current width: a right-edge marker per row and a line long enough to wrap.
const draw = join(root, "draw.sh");
writeFileSync(draw, [
  "label=$1; set -- $(stty size); c=$2",
  "printf '\\033[2J\\033[H'",
  "i=1; while [ $i -le 6 ]; do printf \"\\033[$i;1HROW$i\\033[$i;${c}H#\"; i=$((i+1)); done",
  "printf '\\033[8;1H'; i=0; while [ $i -le 14 ]; do printf 'LONG%04d' $i; i=$((i+1)); done",
  "printf '\\nDRAWN-%s\\n' \"$label\"",
  "",
].join("\n"));
const server = createServer({ port: 0, hostname: "127.0.0.1", token: "", stateDir: join(root, "state"), usage: new UsageService(undefined, []) });
const browsers: Browser[] = [];
let workspace: string | null = null;

type Viewer = { page: Page; sent: { type: string; pane_id?: string }[]; close: () => Promise<void> };
async function viewer(width: number, pane: string, panes: string[]): Promise<Viewer> {
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
  await page.goto(`http://127.0.0.1:${server.port}/?pane=${encodeURIComponent(pane)}`);
  await page.locator(`[data-layout-pane="${pane}"] [data-pane-content]`).waitFor();
  return { page, sent, close: async () => { assert.deepEqual(errors, [], "no browser errors"); await context.close(); } };
}
const rows = (page: Page, pane: string): Promise<string[]> => page.locator(`[data-layout-pane="${pane}"] .xterm-rows > div`)
  .evaluateAll((divs) => divs.map((div) => (div.textContent ?? "").replace(/\s+$/, "")));
const shows = async (page: Page, pane: string, text: string): Promise<void> => {
  try {
    await page.locator(`[data-layout-pane="${pane}"] .xterm-rows`, { hasText: text }).waitFor({ state: "attached", timeout: 15_000 });
  } catch (error) {
    if (evidence) await page.screenshot({ path: join(evidence, `missing-${text}.png`) });
    throw new Error(`${text} never drawn; rows:\n${(await rows(page, pane)).join("\n")}`, { cause: error });
  }
};

try {
  const made = await workspaceCreate({ cwd: root, label: "switch-resize-fixture" });
  workspace = made.workspace.workspace_id;
  const other = await tabCreate({ workspaceId: workspace, label: "other" });
  const target = made.root_pane.pane_id;
  const panes = [target, other.root_pane.pane_id];
  const tabs = new Map([[target, made.root_pane.tab_id], [other.root_pane.pane_id, other.tab.tab_id]]);
  const select = async (page: Page, id: string) => {
    await page.locator(`.tab-strip [role="tab"][data-tab-id="${tabs.get(id)}"]`).click();
    await page.locator(`[data-layout-pane="${id}"] [data-pane-content]`).waitFor();
  };
  const failures: string[] = [];
  // Each direction: the viewer whose tab is cached, then the one that drives the pty meanwhile.
  for (const [cachedWidth, driverWidth] of [[1280, 390], [390, 1280]] as const) {
    const round = `${cachedWidth}-${driverWidth}`;
    const cached = await viewer(cachedWidth, target, panes);
    await paneSendText(target, `sh ${draw} before-${round}\n`);
    await shows(cached.page, target, `DRAWN-before-${round}`);
    await select(cached.page, panes[1]!);
    // The other device drives the pane at its own size and the program draws for it.
    const driver = await viewer(driverWidth, target, panes);
    await paneSendText(target, `sh ${draw} hidden-${round}\n`);
    await shows(driver.page, target, `DRAWN-hidden-${round}`);
    await driver.close();
    // Back on the tab: whatever it paints on the way (the screen it left, the pane as herdr shows it
    // now, the pane at its own size) is drawn for one grid, never output for another grid parsed
    // into its own (a row with two edge markers, the long line twice), and it ends as a fresh attach.
    await cached.page.evaluate((pane) => {
      const frames: string[][] = [];
      const matched = Promise.withResolvers<void>();
      const state: { frames: string[][]; expected?: string; matched: Promise<void> } = { frames, matched: matched.promise };
      Object.assign(window, { switchState: state });
      // armed before the switch: every frame painted from the press on, until one is the fresh attach's screen
      document.addEventListener("pointerdown", () => {
        const grab = () => {
          const frame = document.querySelector(`[data-layout-pane="${pane}"]`);
          if (frame && getComputedStyle(frame).visibility === "visible") {
            const lines = [...frame.querySelectorAll(".xterm-rows > div")].map((div) => (div.textContent ?? "").replace(/\s+$/, ""));
            frames.push(lines);
            if (state.expected !== undefined && lines.join("\n") === state.expected) { matched.resolve(); return; }
          }
          requestAnimationFrame(grab);
        };
        requestAnimationFrame(grab);
      }, { once: true, capture: true });
    }, target);
    await select(cached.page, target);
    const truth = await viewer(cachedWidth, target, panes);
    const expected = await rows(truth.page, target);
    const settled = await cached.page.evaluate(async (expected) => {
      const state = (window as unknown as { switchState: { frames: string[][]; expected?: string; matched: Promise<void> } }).switchState;
      state.expected = expected;
      // the screen may already match from an earlier frame; the next frame resolves it
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
  server.stop();
  if (workspace !== null) await workspaceClose(workspace);
  rmSync(root, { recursive: true, force: true });
}
