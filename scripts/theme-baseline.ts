import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { normalizeThemeValue } from "../src/lib/themeCss.ts";
import { terminalTheme, themeColor } from "../src/lib/settings.ts";

// Freezes the six legacy palette-modes (amber, charcoal, catppuccin in dark and light) as
// src/lib/themes.legacy-baseline.json, the permanent parity oracle src/lib/themes.parity.test.ts
// checks the current src/styles.css against. One shot: it ran once on the pre-refactor tree and
// refuses to overwrite the baseline, which is never regenerated.

export type LegacyMode = "dark" | "light";
export type LegacyPalette = "amber" | "charcoal" | "catppuccin";
export const LEGACY_COMBOS = (["amber", "charcoal", "catppuccin"] as const).flatMap((palette) => (["dark", "light"] as const).map((mode) => ({ palette, mode })));
export const comboKey = (palette: LegacyPalette, mode: LegacyMode): string => `${palette}/${mode}`;

function layers(palette: LegacyPalette, mode: LegacyMode): string[] {
  const base = mode === "light" ? ['[data-theme="light"]', ":root"] : [":root"];
  return palette === "amber" ? base : [`[data-theme="${mode}"][data-palette="${palette}"]`, ...base];
}

function declarations(css: string, selector: string): Map<string, string> {
  const found = new Map<string, string>();
  const text = css.replace(/\/\*[\s\S]*?\*\//g, "");
  for (let at = 0; at < text.length;) {
    const open = text.indexOf("{", at);
    if (open < 0) break;
    let close = open + 1;
    for (let depth = 1; depth > 0 && close < text.length; close++) depth += text[close] === "{" ? 1 : text[close] === "}" ? -1 : 0;
    if (text.slice(at, open).split(",").map((part) => part.replace(/\s+/g, " ").trim()).includes(selector)) {
      for (const [, name, value] of text.slice(open + 1, close - 1).matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) found.set(name!, value!);
    }
    at = close;
  }
  return found;
}

export function legacyCascade(css: string, palette: LegacyPalette, mode: LegacyMode): { declared: Record<string, string>; resolved: Record<string, string> } {
  const declared: Record<string, string> = {};
  for (const selector of layers(palette, mode).reverse()) {
    for (const [name, value] of declarations(css, selector)) declared[name] = normalizeThemeValue(value);
  }
  const resolved: Record<string, string> = {};
  const resolve = (name: string, seen: readonly string[]): string => {
    if (resolved[name] !== undefined) return resolved[name];
    if (seen.includes(name)) throw new Error(`${comboKey(palette, mode)}: var() cycle through ${[...seen, name].join(" -> ")}`);
    const value = declared[name];
    if (value === undefined) throw new Error(`${comboKey(palette, mode)}: ${seen.at(-1)} uses ${name}, which no layer declares`);
    return resolved[name] = normalizeThemeValue(value.replace(/var\(\s*(--[\w-]+)\s*\)/g, (_, ref: string) => resolve(ref, [...seen, name])));
  };
  for (const name of Object.keys(declared)) resolve(name, []);
  return { declared, resolved };
}

const COLOR = /#[0-9a-f]{3,8}\b|\brgba?\(|\btransparent\b/i;

const sorted = (value: unknown): unknown =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, inner]) => [key, sorted(inner)]))
    : value;

export const BASELINE_PATH = join(import.meta.dir, "..", "src", "lib", "themes.legacy-baseline.json");

if (import.meta.main) {
  if (existsSync(BASELINE_PATH)) throw new Error(`${BASELINE_PATH} is frozen: the legacy baseline is never regenerated`);
  const git = (...args: string[]): string => {
    const run = Bun.spawnSync(["git", ...args], { cwd: join(import.meta.dir, "..") });
    if (run.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${run.stderr.toString()}`);
    return run.stdout.toString().trim();
  };
  if (git("status", "--porcelain", "--", "src/styles.css") !== "") throw new Error("src/styles.css differs from HEAD: the baseline is taken from a committed stylesheet");
  const css = readFileSync(join(import.meta.dir, "..", "src", "styles.css"), "utf8");
  const cascades = LEGACY_COMBOS.map(({ palette, mode }) => ({ palette, mode, ...legacyCascade(css, palette, mode) }));
  const colors = new Set(cascades.flatMap(({ resolved }) => Object.keys(resolved).filter((name) => COLOR.test(resolved[name]!))));
  const pick = (values: Record<string, string>) => Object.fromEntries(Object.entries(values).filter(([name]) => colors.has(name)));
  const combos = Object.fromEntries(cascades.map(({ palette, mode, declared, resolved }) => [comboKey(palette, mode), {
    declared: pick(declared),
    resolved: pick(resolved),
    terminal: terminalTheme(mode, palette),
    themeColor: themeColor(mode, palette),
  }]));
  const source = { commit: git("rev-parse", "HEAD"), css: "src/styles.css", terminal: "src/lib/settings.ts terminalTheme()", themeColor: "src/lib/settings.ts themeColor()" };
  writeFileSync(BASELINE_PATH, `${JSON.stringify(sorted({ source, combos }), null, 2)}\n`);
  console.log(`froze ${Object.keys(combos).length} combos x ${colors.size} color properties from ${source.commit} into ${BASELINE_PATH}`);
}
