/**
 * How long a tab switch takes where the user feels it: from a tab's click to the terminal showing
 * that tab's screen, and to the pane taking input (`input-ready`). Both are timed in the page
 * (performance.now), at desktop and phone widths, for three kinds of tab:
 * - cold: a tab this page has never shown (a new terminal and a new attach);
 * - recent: the tab shown just before (always kept mounted);
 * - 8th: the tab shown eight switches ago, past the smallest tab cache.
 *
 * Against the isolated herdr test session (scripts/test-herdr.ts), a server on port 0 with its own
 * state dir, and headless Chromium over the built app (`bun run build` first). Every round opens its
 * own workspace, so a cold tab has no attach left from an earlier round.
 *
 *   bun scripts/tab-switch-bench.ts [--rounds 5] [--out results.json] [--label main]
 */
import "./test-herdr.ts";
import { loadavg } from "node:os";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright-core";
import { createServer } from "../server/index.ts";
import { UsageService } from "../server/usage.ts";
import { herdrRpc, paneRead, tabCreate, workspaceClose, workspaceCreate } from "../server/herdr/client.ts";
import { chromePath } from "./chrome-path.ts";
import { shownRows } from "./shown-rows.ts";

const arg = (name: string, fallback: string): string => {
  const at = process.argv.indexOf(`--${name}`);
  return at > 0 && process.argv[at + 1] ? process.argv[at + 1]! : fallback;
};
const ROUNDS = Number(arg("rounds", "5"));
if (!Number.isInteger(ROUNDS) || ROUNDS < 1) throw new Error(`--rounds must be a positive integer, not ${arg("rounds", "5")}`);
const OUT = arg("out", "");
const LABEL = arg("label", "");
const TABS = 9;
const VIEWPORTS = {
  desktop: { viewport: { width: 1280, height: 800 } },
  phone: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true },
} as const;
type Kind = "cold" | "recent" | "8th";
type Sample = { viewport: keyof typeof VIEWPORTS; kind: Kind; round: number; text: number | null; ready: number | null };

/** Busy CPU share over an interval, from /proc/stat (Linux only; null elsewhere). */
function cpuTimes(): { busy: number; total: number } | null {
  try {
    const fields = readFileSync("/proc/stat", "utf8").split("\n")[0]!.trim().split(/\s+/).slice(1).map(Number);
    const total = fields.reduce((sum, value) => sum + value, 0);
    return { busy: total - fields[3]! - (fields[4] ?? 0), total };
  } catch { return null; }
}

async function until(check: () => Promise<boolean>, label: string, ms = 15_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!await check()) {
    if (Date.now() > deadline) throw new Error(`timed out: ${label}`);
    await Bun.sleep(25);
  }
}

async function switchTo(page: Page, tabId: string, paneId: string, marker: string): Promise<{ text: number | null; ready: number | null }> {
  return page.evaluate(async ({ tabId, paneId, marker, rows }) => {
    type Bench = { ready: { pane: string; t: number }[] };
    const bench = (window as unknown as { __bench: Bench }).__bench;
    const button = document.querySelector<HTMLElement>(`[role="tab"][data-tab-id="${CSS.escape(tabId)}"]`);
    if (!button) throw new Error(`no tab ${tabId}`);
    const shown = (): boolean => {
      const frame = document.querySelector<HTMLElement>(`.pane-frame.is-current[data-layout-pane="${CSS.escape(paneId)}"]`);
      if (!frame || !frame.checkVisibility()) return false;
      return (frame.querySelector(rows)?.textContent ?? "").includes(marker);
    };
    const start = performance.now();
    button.click();
    let text: number | null = null;
    let ready: number | null = null;
    const deadline = start + 10_000;
    while ((text === null || ready === null) && performance.now() < deadline) {
      await new Promise<void>((done) => requestAnimationFrame(() => done()));
      const now = performance.now();
      if (text === null && shown()) text = now - start;
      const frame: { pane: string; t: number } | undefined = ready === null ? bench.ready.find((item) => item.pane === paneId && item.t >= start) : undefined;
      if (frame) ready = frame.t - start;
    }
    return { text, ready };
  }, { tabId, paneId, marker, rows: shownRows() });
}

async function round(browser: Browser, origin: string, root: string, viewport: keyof typeof VIEWPORTS, index: number): Promise<Sample[]> {
  const created = await workspaceCreate({ cwd: root, label: `ovis-test-tab-bench-${viewport}-${index}` });
  const workspaceId = created.workspace.workspace_id;
  const context = await browser.newContext({ ...VIEWPORTS[viewport], locale: "en-US", serviceWorkers: "block" });
  try {
    const tabs = [{ tab: created.root_pane.tab_id, pane: created.root_pane.pane_id }];
    for (let i = 1; i < TABS; i++) {
      const tab = await tabCreate({ workspaceId, cwd: root, label: `bench ${i}` });
      tabs.push({ tab: tab.root_pane.tab_id, pane: tab.root_pane.pane_id });
    }
    const marker = (i: number): string => `TABMARK-${String(i).padStart(2, "0")}-${viewport}-${index}`;
    // the marker is the command's output, not its echo (TAB''MARK)
    for (const [i, { pane }] of tabs.entries()) {
      const text = marker(i);
      await herdrRpc("pane.send_text", { pane_id: pane, text: `echo TAB''${text.slice(3)}\n` });
    }
    for (const [i, { pane }] of tabs.entries()) {
      await until(async () => (await paneRead({ paneId: pane })).text.includes(marker(i)), `pane ${i} prints its marker`);
    }

    await context.addInitScript(() => {
      localStorage.setItem("ovis:settings", JSON.stringify({ language: "en", defaultView: "terminal", alertsOn: false }));
      const bench = { ready: [] as { pane: string; t: number }[] };
      (window as unknown as { __bench: typeof bench }).__bench = bench;
      const Native = window.WebSocket;
      window.WebSocket = class extends Native {
        constructor(...args: ConstructorParameters<typeof WebSocket>) {
          super(...args);
          this.addEventListener("message", (event: MessageEvent) => {
            if (typeof event.data !== "string" || !event.data.includes('"input-ready"')) return;
            try {
              const frame = JSON.parse(event.data) as { type?: string; pane_id?: string; ready?: boolean };
              if (frame.type === "input-ready" && frame.ready !== false && frame.pane_id) bench.ready.push({ pane: frame.pane_id, t: performance.now() });
            } catch {}
          });
        }
      };
    });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`${origin}/?pane=${encodeURIComponent(tabs[0]!.pane)}`);
    await page.locator(".conn-live").waitFor({ timeout: 15_000 });
    await page.waitForFunction(({ pane, text, rows }) => {
      const frame = document.querySelector(`.pane-frame.is-current[data-layout-pane="${CSS.escape(pane)}"]`);
      return (frame?.querySelector(rows)?.textContent ?? "").includes(text);
    }, { pane: tabs[0]!.pane, text: marker(0), rows: shownRows() }, { timeout: 15_000 });

    const samples: Sample[] = [];
    const visit = async (i: number, kind: Kind | null): Promise<void> => {
      const result = await switchTo(page, tabs[i]!.tab, tabs[i]!.pane, marker(i));
      if (result.text === null) throw new Error(`${viewport} round ${index}: tab ${i} (${kind ?? "setup"}) never showed its screen`);
      if (kind) samples.push({ viewport, kind, round: index, ...result });
    };
    for (let i = 1; i <= 8; i++) await visit(i, "cold");
    for (let i = 1; i <= 4; i++) await visit(i, "8th");
    for (const i of [3, 4, 3, 4]) await visit(i, "recent");
    if (errors.length) throw new Error(`page errors: ${errors.join("; ")}`);
    return samples;
  } finally {
    await context.close();
    await workspaceClose(workspaceId).catch(() => undefined);
  }
}

function stats(values: number[]): { n: number; median: number; p10: number; p90: number; min: number; max: number } | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const at = (q: number): number => sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(q * (sorted.length - 1))))]!;
  const round1 = (value: number): number => Math.round(value * 10) / 10;
  return { n: sorted.length, median: round1(at(0.5)), p10: round1(at(0.1)), p90: round1(at(0.9)), min: round1(sorted[0]!), max: round1(sorted.at(-1)!) };
}

const root = realpathSync(mkdtempSync(join(tmpdir(), "ovis-tab-bench-")));
let server: ReturnType<typeof createServer> | undefined;
let browser: Browser | undefined;
try {
  server = createServer({ port: 0, hostname: "127.0.0.1", token: "", stateDir: join(root, "state"), usage: new UsageService(undefined, []) });
  const origin = `http://127.0.0.1:${server.port}`;
  browser = await chromium.launch({ executablePath: chromePath(), headless: true, args: ["--no-sandbox", "--accept-lang=en-US"] });
  const loadBefore = loadavg();
  const cpuBefore = cpuTimes();
  const samples: Sample[] = [];
  // one warm-up round of each, not counted: the first attach of a run also loads the PTY host's binary
  for (const viewport of Object.keys(VIEWPORTS) as (keyof typeof VIEWPORTS)[]) await round(browser, origin, root, viewport, -1);
  for (let index = 0; index < ROUNDS; index++) {
    for (const viewport of Object.keys(VIEWPORTS) as (keyof typeof VIEWPORTS)[]) {
      samples.push(...await round(browser, origin, root, viewport, index));
      console.error(`round ${index} ${viewport} done`);
    }
  }
  const cpuAfter = cpuTimes();
  const summary: Record<string, unknown> = {};
  for (const viewport of Object.keys(VIEWPORTS)) {
    for (const kind of ["cold", "recent", "8th"] as Kind[]) {
      const own = samples.filter((sample) => sample.viewport === viewport && sample.kind === kind);
      summary[`${viewport} ${kind}`] = {
        text: stats(own.flatMap((sample) => sample.text === null ? [] : [sample.text])),
        ready: stats(own.flatMap((sample) => sample.ready === null ? [] : [sample.ready])),
        readyMissing: own.filter((sample) => sample.ready === null).length,
      };
    }
  }
  const result = {
    label: LABEL, rounds: ROUNDS, at: new Date().toISOString(),
    host: { loadBefore, loadAfter: loadavg(), cpuBusy: cpuBefore && cpuAfter ? Math.round(1000 * (cpuAfter.busy - cpuBefore.busy) / (cpuAfter.total - cpuBefore.total)) / 10 : null },
    summary, samples,
  };
  if (OUT) writeFileSync(OUT, JSON.stringify(result, null, 2));
  console.log(`${LABEL || "run"}: ${ROUNDS} rounds, load ${loadBefore.map((v) => v.toFixed(1)).join("/")} -> ${result.host.loadAfter.map((v) => v.toFixed(1)).join("/")}, CPU busy ${result.host.cpuBusy}%`);
  console.log("case                 | text median (p10-p90)    | input-ready median (p10-p90)");
  for (const [name, value] of Object.entries(summary)) {
    const { text, ready, readyMissing } = value as { text: ReturnType<typeof stats>; ready: ReturnType<typeof stats>; readyMissing: number };
    const cell = (s: ReturnType<typeof stats>): string => s ? `${s.median} (${s.p10}-${s.p90}) n=${s.n}` : "-";
    console.log(`${name.padEnd(20)} | ${cell(text).padEnd(24)} | ${cell(ready)}${readyMissing ? ` (${readyMissing} missing)` : ""}`);
  }
} finally {
  await browser?.close();
  server?.stop();
  rmSync(root, { recursive: true, force: true });
}
