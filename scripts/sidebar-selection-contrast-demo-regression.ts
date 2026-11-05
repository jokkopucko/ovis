/**
 * Purpose: measure the selected workspace and agent rows of the sidebar in every theme entry of src/styles.css
 * (SUPPORTED_ENTRIES, both modes) on the real demo client, as the browser paints them: selected with the focus
 * elsewhere, selected and hovered, selected and keyboard-focused. In a theme the selection is the row's fill alone,
 * with no leading stroke (the owner's call after #2352: on a rounded row the stroke read as a bracket); its contrast
 * on the panel is recorded, not held to 3:1. Every text in the row stays at least 4.5:1 on what is behind it (issue
 * #1618). Prints one CONTRAST line per entry, row and state, and with UI_EVIDENCE_DIR writes them to
 * measurements.json beside the Codex theme's screenshots at 1280 and 390, dark and light.
 * Tags: sidebar, theme, contrast, accessibility, browser, regression.
 * The same rows are measured with forced colors (Windows high contrast) active, where the browser repaints fills
 * as Canvas and the fill would vanish: there the selection keeps a leading bar of at least 3:1.
 * Usage: bun scripts/sidebar-selection-contrast-demo-regression.ts   (UI_EVIDENCE_DIR=<dir> for the table and shots;
 *   SIDEBAR_SELECTION_CASE=themes|forced runs one half)
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser, type Locator, type Page } from "playwright-core";
import { buildDemoApp } from "./demo-build.ts";
import { chromePath } from "./chrome-path.ts";
import { SUPPORTED_ENTRIES } from "../src/lib/themes.ts";

type Mode = "dark" | "light";
type RowKind = "workspace" | "agent";
type State = "selected" | "selected+hover" | "selected+focus";

const app = mkdtempSync(join(tmpdir(), "herdr-sidebar-selection-"));
const evidence = process.env["UI_EVIDENCE_DIR"];
const only = process.env["SIDEBAR_SELECTION_CASE"];
const CUE_MIN = 3;
const TEXT_MIN = 4.5;
// the row as a pointer and the keyboard reach it, and the box its selection paints
const ROW: Record<RowKind, { painted: string; target: string }> = {
  workspace: { painted: ".workspace-group.is-selected > .workspace-header", target: ".workspace-group.is-selected > .workspace-header > .workspace-select" },
  agent: { painted: ".agents-sidebar .agent-item.is-selected", target: ".agents-sidebar .agent-item.is-selected > .agent-row" },
};

interface Measurement {
  /** the strongest persistent cue: the fill against the panel, or a stroke against both the fill and the panel */
  cue: number;
  fill: number;
  stroke: { color: string; widthPx: number; exposedPx: number; againstFill: number; againstPanel: number } | null;
  text: { text: string; contrast: number }[];
  outline: boolean;
}

/** a stroke counts only where at least this much of it is drawn, clear of a focus ring over it */
const STROKE_MIN_PX = 2;

/**
 * Everything read in the page: computed colors composited over what is really behind them, through the opacity
 * of every ancestor, WCAG 2 ratios. `target` is the element the keyboard focuses, whose ring may cover the stroke.
 */
function measure(painted: Element, { target: targetSelector, strokeMinPx }: { target: string; strokeMinPx: number }): Measurement {
  type Color = [number, number, number, number];
  const parse = (value: string): Color => {
    // a color-mix() computes to color(srgb r g b / a), its channels from 0 to 1
    const srgb = /^color\(srgb ([\d.e-]+) ([\d.e-]+) ([\d.e-]+)(?: \/ ([\d.]+))?\)$/.exec(value);
    if (srgb) return [Number(srgb[1]) * 255, Number(srgb[2]) * 255, Number(srgb[3]) * 255, srgb[4] === undefined ? 1 : Number(srgb[4])];
    const parts = value.match(/[\d.]+/g)?.map(Number);
    if (!value.startsWith("rgb") || !parts || parts.length < 3) throw new Error(`unexpected computed color ${value}`);
    return [parts[0]!, parts[1]!, parts[2]!, parts[3] ?? 1];
  };
  const over = (front: Color, back: Color): Color => {
    const a = front[3];
    return [front[0] * a + back[0] * (1 - a), front[1] * a + back[1] * (1 - a), front[2] * a + back[2] * (1 - a), 1];
  };
  const linear = (c: number) => (c / 255 <= 0.04045 ? c / 255 / 12.92 : ((c / 255 + 0.055) / 1.055) ** 2.4);
  const luminance = (c: Color) => 0.2126 * linear(c[0]) + 0.7152 * linear(c[1]) + 0.0722 * linear(c[2]);
  const ratio = (a: Color, b: Color) => {
    const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
    return Math.round(((hi + 0.05) / (lo + 0.05)) * 100) / 100;
  };
  /** the backgrounds from the page down to an element, each over the last, before any opacity */
  const backdrop = (element: Element | null): Color => {
    const chain: Element[] = [];
    for (let node = element; node; node = node.parentElement) chain.unshift(node);
    return chain.reduce<Color>((under, node) => over(parse(getComputedStyle(node).backgroundColor), under), [255, 255, 255, 1]);
  };
  /** a color painted in `element` as the screen shows it: each translucent ancestor (itself included), innermost
   *  first, blends what it painted with what is behind it (a dimmed offline PC's group, a faded row) */
  const seen = (color: Color, element: Element | null): Color => {
    let shown = color;
    for (let node = element; node; node = node.parentElement) {
      const alpha = Number(getComputedStyle(node).opacity);
      if (alpha < 1) shown = over([shown[0], shown[1], shown[2], alpha], backdrop(node.parentElement));
    }
    return shown;
  };
  const panel = seen(backdrop(painted.parentElement), painted.parentElement);
  const rawFill = backdrop(painted);
  const fill = seen(rawFill, painted);
  const style = getComputedStyle(painted);
  const box = painted.getBoundingClientRect();
  // a leading stroke: an inset shadow pushed in from the left edge, or a left border, and the band it draws
  const strokes: { color: Color; from: number; to: number }[] = [];
  for (const layer of style.boxShadow === "none" ? [] : style.boxShadow.split(/,(?![^(]*\))/)) {
    if (!/\binset\b/.test(layer)) continue;
    const color = layer.match(/(?:rgba?|color)\([^)]*\)/)?.[0];
    const [x = 0, , blur = 0, spread = 0] = layer.replace(/(?:rgba?|color)\([^)]*\)/, "").match(/-?[\d.]+px/g)?.map(parseFloat) ?? [];
    // an inset shadow's leading band is its x offset plus its spread (a negative spread takes it back); a blurred one is
    // no crisp stroke
    const width = blur === 0 ? Math.max(0, x + spread) : 0;
    if (color && width > 0) strokes.push({ color: seen(over(parse(color), rawFill), painted), from: box.left, to: box.left + width });
  }
  const border = parseFloat(style.borderLeftWidth);
  if (border > 0 && style.borderLeftStyle !== "none") strokes.push({ color: seen(over(parse(style.borderLeftColor), rawFill), painted), from: box.left, to: box.left + border });
  // a pseudo-element's leading border (laid out inside the row, from its left offset)
  for (const pseudo of ["::before", "::after"]) {
    const drawn = getComputedStyle(painted, pseudo);
    const width = parseFloat(drawn.borderLeftWidth);
    if (drawn.content === "none" || drawn.display === "none" || !(width > 0) || drawn.borderLeftStyle === "none") continue;
    const left = box.left + border + (parseFloat(drawn.left) || 0);
    strokes.push({ color: seen(over(parse(drawn.borderLeftColor), rawFill), painted), from: left, to: left + width });
  }
  // a scrolling or clipping ancestor cuts off whatever lies outside its padding box
  let clipFrom = -Infinity, clipTo = Infinity;
  for (let node = painted.parentElement; node; node = node.parentElement) {
    const css = getComputedStyle(node);
    if (css.overflowX === "visible") continue;
    const rect = node.getBoundingClientRect();
    clipFrom = Math.max(clipFrom, rect.left + parseFloat(css.borderLeftWidth));
    clipTo = Math.min(clipTo, rect.right - parseFloat(css.borderRightWidth));
  }
  // the focus ring (an outline, inside when its offset is negative) covers this band of the leading edge
  const covered: [number, number][] = [];
  for (const element of [painted, document.querySelector(targetSelector)]) {
    if (!element) continue;
    const css = getComputedStyle(element);
    const width = parseFloat(css.outlineWidth);
    if (css.outlineStyle === "none" || !(width > 0)) continue;
    const inner = element.getBoundingClientRect().left - parseFloat(css.outlineOffset);
    covered.push([inner - width, inner]);
  }
  const exposed = (start: number, end: number): number => {
    const from = Math.max(start, clipFrom), to = Math.min(end, clipTo);
    if (to <= from) return 0;
    let shown = to - from;
    for (const [ringFrom, ringTo] of covered) shown -= Math.max(0, Math.min(to, ringTo) - Math.max(from, ringFrom));
    return Math.round(shown * 100) / 100;
  };
  const strongest = strokes.map(({ color, from, to }) => ({ color: `rgb(${color.slice(0, 3).map(Math.round).join(", ")})`, widthPx: Math.round((to - from) * 100) / 100, exposedPx: exposed(from, to), againstFill: ratio(color, fill), againstPanel: ratio(color, panel) }))
    .filter((stroke) => stroke.exposedPx >= strokeMinPx)
    .sort((a, b) => Math.min(b.againstFill, b.againstPanel) - Math.min(a.againstFill, a.againstPanel))[0] ?? null;
  const fillCue = ratio(fill, panel);
  // every text the row shows: an element with a text node of its own, drawn, its color over what is behind it
  const text: Measurement["text"] = [];
  for (const element of [painted, ...painted.querySelectorAll("*")]) {
    const own = [...element.childNodes].filter((node) => node.nodeType === Node.TEXT_NODE).map((node) => node.textContent ?? "").join("").trim();
    if (!own || element.getClientRects().length === 0) continue;
    const css = getComputedStyle(element);
    if (css.visibility !== "visible") continue;
    let opacity = 1;
    for (let node: Element | null = element; node; node = node.parentElement) opacity *= Number(getComputedStyle(node).opacity);
    if (opacity === 0) continue;
    const behind = backdrop(element);
    text.push({ text: own.slice(0, 40), contrast: ratio(seen(over(parse(css.color), behind), element), seen(behind, element)) });
  }
  return { cue: Math.max(fillCue, strongest ? Math.min(strongest.againstFill, strongest.againstPanel) : 0), fill: fillCue, stroke: strongest, text, outline: style.outlineStyle !== "none" && parseFloat(style.outlineWidth) > 0 };
}


async function settle(page: Page): Promise<void> {
  await page.evaluate(async () => {
    void getComputedStyle(document.body).backgroundColor;
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    await Promise.all(document.getAnimations().filter((animation) => animation.effect?.getComputedTiming().endTime !== Infinity).map((animation) => animation.finished.catch(() => undefined)));
  });
}

/** The focus and the pointer leave the sidebar: the selection alone marks the row. */
async function away(page: Page): Promise<void> {
  const main = await page.locator("main, .main, .pane-area").first().boundingBox();
  await page.mouse.move(main ? main.x + main.width / 2 : 1200, main ? main.y + main.height / 2 : 450);
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
}

async function enter(page: Page, kind: RowKind, state: State): Promise<Locator> {
  const painted = page.locator(ROW[kind].painted);
  const target = page.locator(ROW[kind].target);
  await away(page);
  await target.scrollIntoViewIfNeeded();
  if (state === "selected+hover") await target.hover();
  if (state === "selected+focus") {
    await target.focus();
    // a key press makes the programmatic focus a keyboard one (:focus-visible)
    await page.keyboard.press("Shift");
    assert.ok(await target.evaluate((element) => element.matches(":focus-visible")), `${kind} row takes the keyboard focus`);
  }
  await settle(page);
  return painted;
}

async function selectRows(page: Page): Promise<void> {
  if (await page.locator(ROW.agent.painted).count() === 0) await page.locator(".agents-sidebar .agent-row:enabled").first().click();
  await page.locator(ROW.agent.painted).waitFor({ state: "attached" });
  await page.locator(ROW.workspace.painted).waitFor({ state: "attached" });
}

async function open(browser: Browser, url: string, mode: Mode, phone: boolean): Promise<{ page: Page; errors: string[]; close(): Promise<void> }> {
  const context = await browser.newContext(phone
    ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3, locale: "en-US", colorScheme: mode }
    : { viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1, locale: "en-US", colorScheme: mode });
  await context.addInitScript((mode) => {
    localStorage.setItem("ovis:settings", JSON.stringify({ language: "en", theme: mode, palette: "codex", defaultView: "chat" }));
  }, mode);
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(url);
  await page.locator(".conn-live").waitFor({ state: "attached" });
  await page.locator(".agents-sidebar .agent-item").first().waitFor({ state: "attached" });
  await page.evaluate(() => document.fonts.ready);
  return { page, errors, close: () => context.close() };
}

const usePalette = (page: Page, id: string, mode: Mode) => page.evaluate(({ id, mode }) => {
  // as lib/themeBoot.ts applyThemeEntry sets them
  const root = document.documentElement;
  root.dataset["theme"] = mode;
  root.dataset["palette"] = id;
  root.style.colorScheme = mode;
}, { id, mode });

const rows: (Measurement & { entry: string; row: RowKind; state: State })[] = [];
const failures: string[] = [];

async function measureMode(browser: Browser, url: string, mode: Mode): Promise<void> {
  const { page, errors, close } = await open(browser, url, mode, false);
  try {
    await selectRows(page);
    for (const { id } of SUPPORTED_ENTRIES.filter((entry) => entry.mode === mode)) {
      await usePalette(page, id, mode);
      for (const kind of ["workspace", "agent"] as const) {
        for (const state of ["selected", "selected+hover", "selected+focus"] as const) {
          const painted = await enter(page, kind, state);
          // any shown width counts here (measure rounds it to 0.01px): a theme draws no leading stroke at all
          const measured = await painted.evaluate(measure, { target: ROW[kind].target, strokeMinPx: 0.01 });
          const entry = `${id}/${mode}`;
          rows.push({ entry, row: kind, state, ...measured });
          assert.ok(measured.text.length > 0, `${entry} ${kind} ${state}: the row shows text`);
          const weakest = measured.text.reduce((low, item) => (item.contrast < low.contrast ? item : low));
          const stroke = measured.stroke ? `stroke ${measured.stroke.exposedPx}/${measured.stroke.widthPx}px shown` : "no stroke";
          console.log(`CONTRAST ${entry} ${kind} ${state}: fill ${measured.fill}:1 on the panel, ${stroke}, text ${weakest.contrast}:1 ("${weakest.text}")`);
          if (measured.stroke) failures.push(`${entry} ${kind} ${state}: a leading stroke is drawn (${measured.stroke.exposedPx}px shown in ${measured.stroke.color}); the fill alone marks the selection`);
          // nothing but the fill is painted on the row: no shadow (blurred or not), no border, no drawn pseudo-element
          const extra = await painted.evaluate((element) => {
            const css = getComputedStyle(element);
            const found: string[] = [];
            if (css.boxShadow !== "none") found.push(`box-shadow ${css.boxShadow}`);
            for (const side of ["top", "right", "bottom", "left"]) {
              if (parseFloat(css.getPropertyValue(`border-${side}-width`)) > 0 && css.getPropertyValue(`border-${side}-style`) !== "none") found.push(`border-${side}`);
            }
            for (const pseudo of ["::before", "::after"]) {
              const drawn = getComputedStyle(element, pseudo);
              if (drawn.content !== "none" && drawn.display !== "none") found.push(`${pseudo} ${drawn.content}`);
            }
            return found;
          });
          if (extra.length > 0) failures.push(`${entry} ${kind} ${state}: the selected row paints more than its fill (${extra.join("; ")})`);
          for (const item of measured.text) if (item.contrast < TEXT_MIN) failures.push(`${entry} ${kind} ${state}: "${item.text}" ${item.contrast}:1 < ${TEXT_MIN}:1`);
        }
      }
    }
    assert.deepEqual(errors, [], `${mode}: no uncaught browser errors`);
  } finally {
    await close();
  }
}

/** Forced colors replace every theme colour with the system's and drop box shadows: one pass per mode is the whole case. */
async function measureForced(browser: Browser, url: string, mode: Mode): Promise<void> {
  const { page, errors, close } = await open(browser, url, mode, false);
  try {
    await page.emulateMedia({ forcedColors: "active", colorScheme: mode });
    assert.ok(await page.evaluate(() => matchMedia("(forced-colors: active)").matches), `forced colors are active in ${mode}`);
    await selectRows(page);
    for (const kind of ["workspace", "agent"] as const) {
      for (const state of ["selected", "selected+hover", "selected+focus"] as const) {
        const painted = await enter(page, kind, state);
        const measured = await painted.evaluate(measure, { target: ROW[kind].target, strokeMinPx: STROKE_MIN_PX });
        const entry = `forced-colors/${mode}`;
        rows.push({ entry, row: kind, state, ...measured });
        const weakest = measured.text.reduce((low, item) => (item.contrast < low.contrast ? item : low));
        const stroke = measured.stroke ? `stroke ${measured.stroke.exposedPx}/${measured.stroke.widthPx}px shown, ${measured.stroke.againstFill}:1 on the fill, ${measured.stroke.againstPanel}:1 on the panel` : `no stroke of ${STROKE_MIN_PX}px shown`;
        console.log(`CONTRAST ${entry} ${kind} ${state}: cue ${measured.cue}:1 (fill ${measured.fill}:1 on the panel, ${stroke}), text ${weakest.contrast}:1 ("${weakest.text}")`);
        if (measured.cue < CUE_MIN) failures.push(`${entry} ${kind} ${state}: selection cue ${measured.cue}:1 < ${CUE_MIN}:1`);
        for (const item of measured.text) if (item.contrast < TEXT_MIN) failures.push(`${entry} ${kind} ${state}: "${item.text}" ${item.contrast}:1 < ${TEXT_MIN}:1`);
      }
    }
    assert.deepEqual(errors, [], `forced colors ${mode}: no uncaught browser errors`);
  } finally {
    await close();
  }
}

/** The Codex theme (the default) as a person sees it: the sidebar at 1280 and in a phone's drawer at 390. */
async function screenshots(browser: Browser, url: string, dir: string): Promise<void> {
  for (const phone of [false, true]) for (const mode of ["dark", "light"] as const) {
    const { page, close } = await open(browser, url, mode, phone);
    try {
      if (phone) {
        await page.getByRole("button", { name: "Open workspace list", exact: true }).click();
        await page.locator(".sidebar.is-open").waitFor();
      }
      await selectRows(page);
      if (phone && await page.locator(".sidebar.is-open").count() === 0) {
        await page.getByRole("button", { name: "Open workspace list", exact: true }).click();
        await page.locator(".sidebar.is-open").waitFor();
      }
      // a phone's drawer folds the Agents list by default: open it so the shot shows a selected agent row too
      const agentsToggle = page.locator(".agent-section-toggle");
      if (await agentsToggle.getAttribute("aria-expanded") === "false") {
        await agentsToggle.click();
        await page.locator(ROW.agent.painted).waitFor({ state: "visible" });
      }
      await page.locator(ROW.agent.painted).scrollIntoViewIfNeeded();
      await away(page);
      if (phone) await page.mouse.move(-50, -50);
      await settle(page);
      await page.screenshot({ path: join(dir, `sidebar-selection-codex-${phone ? 390 : 1280}-${mode}.png`), style: ".droplet { visibility: hidden !important; }" });
    } finally {
      await close();
    }
  }
}

try {
  await buildDemoApp(app);
  const index = join(app, "index.html");
  writeFileSync(index, readFileSync(index, "utf8").replace(/<script type="module"/, '<script src="./demo-transport.js"></script><script type="module"'));
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    let file: string;
    try { file = decodeURIComponent(new URL(request.url).pathname.slice(1)); } catch { return new Response("bad path", { status: 400 }); }
    if (!file || file.endsWith("/")) file += "index.html";
    if (file.split("/").includes("..") || file.includes("\\")) return new Response("bad path", { status: 400 });
    const body = Bun.file(join(app, file));
    return await body.exists() ? new Response(body) : new Response("not found", { status: 404 });
  } });
  try {
    const browser = await chromium.launch({ executablePath: chromePath(), headless: true, args: ["--no-sandbox"] });
    try {
      const url = `http://127.0.0.1:${server.port}/`;
      if (!only || only === "themes") for (const mode of ["dark", "light"] as const) await measureMode(browser, url, mode);
      if (!only || only === "forced") for (const mode of ["dark", "light"] as const) await measureForced(browser, url, mode);
      if (evidence && !only) {
        mkdirSync(evidence, { recursive: true });
        writeFileSync(join(evidence, "measurements.json"), JSON.stringify(rows, null, 2));
        await screenshots(browser, url, evidence);
      }
    } finally { await browser.close(); }
  } finally { server.stop(true); }
  const themed = new Set(rows.map((row) => row.entry).filter((entry) => !entry.startsWith("forced-colors/")));
  if (!only || only === "themes") assert.equal(themed.size, SUPPORTED_ENTRIES.length, "every theme entry was measured");
  if (!only || only === "forced") assert.equal(rows.filter((row) => row.entry.startsWith("forced-colors/")).length, 12, "both forced-color modes were measured");
  assert.deepEqual(failures, [], `selected sidebar rows:\n${failures.join("\n")}`);
  console.log(`PASS sidebar selection contrast: ${themed.size} theme entries and ${rows.length - themed.size * 6} forced-color measurements, workspace and agent rows, ${rows.length} measurements`);
} finally {
  rmSync(app, { recursive: true, force: true });
}
