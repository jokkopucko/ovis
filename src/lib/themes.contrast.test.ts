import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { hex, over, rgb } from "./colorMath.ts";
import { contrastRatio } from "./terminalFold.ts";
import { customRow, readThemeFile } from "./customThemes.ts";
import { parseThemeBlocks, resolveEntry } from "./themeCss.ts";
import { CONTRAST_PAIRS, LIGHT_ANSI_PAIRS, TEXT_FLOOR } from "./themeContrast.ts";
import { SUPPORTED_ENTRIES } from "./themes.ts";

const css = readFileSync(new URL("../styles.css", import.meta.url), "utf8");
const blocks = parseThemeBlocks(css);
const chatCss = readFileSync(new URL("../components/ChatView.css", import.meta.url), "utf8");
const EDITORIAL_CODE = '[data-markdown-style="editorial"] .chat-turn-agent .markdown :not(pre):not(.markdown-file):not(.markdown-code-link):not(a) > code';
const TINTED_MARKER = '[data-markdown-style="tinted"] .chat-turn-agent .markdown .markdown-list > li::marker';

/** the value a rule in ChatView.css declares for a property, so a check reads the color the page draws */
function declared(selector: string, property: string): string {
  const start = chatCss.indexOf(`${selector} {`);
  if (start < 0) throw new Error(`Missing rule ${selector} in ChatView.css`);
  const body = chatCss.slice(start + selector.length + 2, chatCss.indexOf("}", start));
  const match = new RegExp(String.raw`(?:^|[;\s])${property}:\s*([^;]+);`).exec(body);
  if (!match?.[1]) throw new Error(`Missing ${property} in ${selector}`);
  return match[1].trim();
}

function paint(value: string, colors: Record<string, string>): string {
  const role = /^var\((--[\w-]+)\)$/.exec(value);
  if (role?.[1]) return colors[role[1]] ?? "";
  const mixed = /^color-mix\(in srgb,\s*var\((--[\w-]+)\)\s*(\d+(?:\.\d+)?)%,\s*var\((--[\w-]+)\)\)$/.exec(value);
  if (mixed?.[1] && mixed[2] && mixed[3]) return hex(over(rgb(colors[mixed[1]] ?? ""), rgb(colors[mixed[3]] ?? ""), Number(mixed[2]) / 100));
  throw new Error(`Cannot paint ${value}`);
}

function mixRule(role: string): { weight: number; base: string } {
  const match = new RegExp(String.raw`--${role}:\s*color-mix\(in srgb,\s*var\(--accent\)\s*(\d+(?:\.\d+)?)%,\s*var\((--[\w-]+)\)\)`).exec(css);
  if (!match?.[1] || !match[2]) throw new Error(`Missing color-mix formula for --${role} in styles.css`);
  return { weight: Number(match[1]) / 100, base: match[2] };
}

describe("theme contrast", () => {
  it("checks every supported theme entry", () => {
    expect(SUPPORTED_ENTRIES.length).toBeGreaterThan(0);
  });

  for (const entry of SUPPORTED_ENTRIES) {
    it(`${entry.id}/${entry.mode} meets the WCAG AA floors`, () => {
      const colors = resolveEntry(blocks, entry.id, entry.mode).resolved;
      const below = [...CONTRAST_PAIRS, ...(entry.mode === "light" ? LIGHT_ANSI_PAIRS : [])].flatMap(({ fg, bg, floor }) => {
        const ratio = contrastRatio(colors[`--${fg}`] ?? "", colors[`--${bg}`] ?? "");
        if (ratio === null) return [`${fg} on ${bg}: ${colors[`--${fg}`]} / ${colors[`--${bg}`]} is not #rrggbb`];
        return ratio < floor ? [`${fg} on ${bg}: ${ratio.toFixed(2)}:1 < ${floor}:1 (${colors[`--${fg}`]} / ${colors[`--${bg}`]})`] : [];
      });
      expect(below).toEqual([]);
    });

    it(`${entry.id}/${entry.mode} keeps the user chat bubble readable and separated from the canvas`, () => {
      const colors = resolveEntry(blocks, entry.id, entry.mode).resolved;
      const bubbleBgRule = mixRule("bubble-bg");
      const bubbleEdgeRule = mixRule("bubble-edge");
      const accent = colors["--accent"] ?? "";
      const bg = colors["--bg"] ?? "";
      const bubbleBg = hex(over(rgb(accent), rgb(colors[bubbleBgRule.base] ?? ""), bubbleBgRule.weight));
      const bubbleEdge = hex(over(rgb(accent), rgb(colors[bubbleEdgeRule.base] ?? ""), bubbleEdgeRule.weight));

      for (const role of ["--text-strong", "--text", "--text-dim"] as const) {
        const fg = colors[role] ?? "";
        const ratio = contrastRatio(fg, bubbleBg);
        expect(ratio, `${role} (${fg}) on --bubble-bg (${bubbleBg})`).not.toBeNull();
        expect(ratio!, `${role} (${fg}) on --bubble-bg (${bubbleBg})`).toBeGreaterThanOrEqual(TEXT_FLOOR);
      }

      const bgDiff = contrastRatio(bubbleBg, bg);
      expect(bgDiff, `--bubble-bg (${bubbleBg}) vs --bg (${bg})`).not.toBeNull();
      expect(bgDiff!, `--bubble-bg (${bubbleBg}) vs --bg (${bg})`).toBeGreaterThanOrEqual(1.08);

      const edgeDiff = contrastRatio(bubbleEdge, bg);
      expect(edgeDiff, `--bubble-edge (${bubbleEdge}) vs --bg (${bg})`).not.toBeNull();
      expect(edgeDiff!, `--bubble-edge (${bubbleEdge}) vs --bg (${bg})`).toBeGreaterThanOrEqual(1.5);
    });

    it(`${entry.id}/${entry.mode} keeps every chat Markdown style preset readable (WCAG AA)`, () => {
      const colors = resolveEntry(blocks, entry.id, entry.mode).resolved;
      const mix = (fg: string, bg: string, weight: number) => hex(over(rgb(fg), rgb(bg), weight));
      const bg = colors["--bg"]!;
      const elev = colors["--bg-elevated"]!;
      const strong = colors["--text-strong"]!;
      const dim = colors["--text-dim"]!;
      const accent = colors["--accent"]!;
      const fn = colors["--syntax-function"]!;
      const ty = colors["--syntax-type"]!;
      const kw = colors["--syntax-keyword"]!;
      const meta = colors["--syntax-meta"]!;
      const variable = colors["--syntax-variable"]!;
      const checks: readonly [string, string, string][] = [
        ["editorial code", paint(declared(EDITORIAL_CODE, "color"), colors), mix(accent, bg, 0.07)],
        ["editorial blockquote", dim, mix(accent, bg, 0.04)],
        ["editorial table header", strong, mix(elev, bg, 0.75)],
        ["tinted heading", mix(fn, strong, 0.42), bg],
        ["tinted subheading", mix(ty, strong, 0.38), bg],
        ["tinted code", mix(kw, strong, 0.38), mix(kw, bg, 0.06)],
        ["tinted blockquote", dim, mix(ty, bg, 0.04)],
        ["tinted list number", paint(declared(TINTED_MARKER, "color"), colors), bg],
        ["tinted table header", mix(ty, strong, 0.38), mix(elev, bg, 0.75)],
        ["colorful heading", mix(fn, strong, 0.7), bg],
        ["colorful subheading", mix(ty, strong, 0.7), bg],
        ["colorful detail", mix(meta, strong, 0.7), bg],
        ["colorful strong", mix(variable, strong, 0.7), bg],
        ["colorful emphasis", mix(meta, strong, 0.7), bg],
        ["colorful code", mix(kw, strong, 0.7), elev],
        ["colorful table header", mix(ty, strong, 0.7), elev],
      ];
      const below = checks.flatMap(([name, fg, surface]) => {
        const ratio = contrastRatio(fg, surface);
        return ratio === null || ratio < TEXT_FLOOR ? [`${name}: ${ratio?.toFixed(2) ?? "invalid"}:1 (${fg} on ${surface})`] : [];
      });
      expect(below).toEqual([]);
    });
  }

  it("keeps Editorial inline code readable in an imported theme whose text and accent sit on either side of its ground", () => {
    const file = readThemeFile(JSON.stringify({ name: "Gray", base00: "757575", base01: "757575", base02: "757575", base05: "ffffff", base0D: "000000" }));
    if (!("theme" in file)) throw new Error(`the gray theme did not import: ${file.error}`);
    const colors = Object.fromEntries(Object.entries(customRow(file.theme, "dark").vars ?? {}).map(([role, value]) => [`--${role}`, value]));
    const pill = hex(over(rgb(colors["--accent"]!), rgb(colors["--bg"]!), 0.07));
    expect(contrastRatio(paint(declared(EDITORIAL_CODE, "color"), colors), pill)!).toBeGreaterThanOrEqual(TEXT_FLOOR);
  });
});
