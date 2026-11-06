#!/usr/bin/env bun
/**
 * Generate the theme data and the static color copies from the theme blocks of src/styles.css,
 * the one place theme colors are authored.
 *
 *   bun run scripts/generate-themes.ts                # write the generated outputs
 *   bun run scripts/generate-themes.ts --check        # fail if a committed output is stale; never writes
 *   bun run scripts/generate-themes.ts --root <dir>   # work on a copy of the repo (tests)
 *
 * Outputs, and why each is written the way it is:
 *
 * - src/lib/themes.generated.ts is written whole: the supported (theme, mode) entries, each with its
 *   declared roles, xterm colors and panel color, so runtime code never parses CSS.
 * - DESIGN.md: only the amber palette and terminal rows between `<!-- BEGIN GENERATED THEMES -->` and
 *   `<!-- END GENERATED THEMES -->`. Everything outside the markers stays handwritten.
 * - index.html `<meta name="theme-color">` and the manifest's theme_color and background_color, in the
 *   default theme's dark colors (DEFAULT_ID, src/lib/themes.ts DEFAULT_THEME): one targeted replacement
 *   each, so the rest of those files keeps its bytes.
 *
 * Every copy fails closed: a missing, repeated or out-of-order marker, or a target found other
 * than exactly once, stops the run with the file and marker named. Output is deterministic (CSS
 * order, no timestamps), and src/styles.css is only ever read.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseThemeBlocks, resolveEntry } from "../src/lib/themeCss.ts";
import { LIGHT_ANSI_ROLES, ROLES } from "../src/lib/themeRoles.ts";

export const SOURCE = "src/styles.css";
export const OUTPUTS = {
  module: "src/lib/themes.generated.ts",
  design: "DESIGN.md",
  index: "index.html",
  manifest: "public/manifest.webmanifest",
} as const;

/** src/lib/themes.ts DEFAULT_THEME, kept apart so this script reads no generated module (settings.test.ts holds them equal) */
export const DEFAULT_ID = "codex";

export const DESIGN_BEGIN = "<!-- BEGIN GENERATED THEMES -->";
export const DESIGN_END = "<!-- END GENERATED THEMES -->";

/** The amber palette rows of DESIGN.md, in reading order: the role label and its token. */
const DESIGN_ROWS: readonly (readonly [label: string, token: string])[] = [
  ["Surface/base", "--bg"],
  ["Surface/panel", "--bg-panel"],
  ["Surface/elevated", "--bg-elevated"],
  ["Surface/hover", "--bg-hover"],
  ["Surface/input", "--bg-input"],
  ["Border", "--border"],
  ["Border/strong", "--border-strong"],
  ["Chat bubble edge", "--bubble-border"],
  ["Text/primary", "--text"],
  ["Text/dim", "--text-dim"],
  ["Text/strong", "--text-strong"],
  ["Accent", "--accent"],
  ["Accent/tint", "--accent-tint"],
  ["Primary", "--primary"],
  ["Primary/hover", "--primary-hover"],
  ["Primary/text", "--primary-text"],
  ["Primary/tint", "--primary-tint"],
  ["Status/idle", "--status-idle"],
  ["Status/working", "--status-working"],
  ["Status/blocked", "--status-blocked"],
  ["Status/done", "--status-done"],
  ["Working/tint", "--status-working-tint"],
  ["Blocked/tint", "--status-blocked-tint"],
  ["Done/tint", "--status-done-tint"],
  ["Indicator/working", "--indicator-working"],
  ["Indicator/blocked", "--indicator-blocked"],
  ["Indicator/done", "--indicator-done"],
  ["Indicator/idle", "--indicator-idle"],
  ["Indicator/unknown", "--indicator-unknown"],
  ["Danger/tint", "--danger-tint"],
  ["Danger/text", "--danger-text"],
  ["Notice", "--notice"],
  ["Overlay/scrim", "--scrim"],
  ["Drawer shadow", "--shadow-drawer"],
  ["Popover shadow", "--shadow-pop"],
  ["Card shadow", "--shadow-card"],
  ["Document surface", "--pdf-page"],
  ["Terminal/background", "--term-bg"],
  ["Terminal/foreground", "--term-fg"],
  ["Terminal/cursor", "--term-cursor"],
  ["Terminal/selection", "--term-selection"],
  ["Syntax/keyword", "--syntax-keyword"],
  ["Syntax/string", "--syntax-string"],
  ["Syntax/number", "--syntax-number"],
  ["Syntax/type", "--syntax-type"],
  ["Syntax/variable", "--syntax-variable"],
  ["Syntax/meta", "--syntax-meta"],
  ["Alert/background", "--droplet-bg"],
  ["Alert/text", "--droplet-text"],
  ["Alert/dim text", "--droplet-text-dim"],
  ["Alert/blocked", "--droplet-blocked"],
  ["Alert/done", "--droplet-done"],
  ["Alert/mark background", "--droplet-mark-bg"],
  ["Alert/ring", "--droplet-ring"],
  ["Alert/shadow", "--droplet-shadow"],
];

function resolveTheme(blocks: ReturnType<typeof parseThemeBlocks>, id: string) {
  return { id, dark: resolveEntry(blocks, id, "dark"), light: resolveEntry(blocks, id, "light") };
}

function resolveAmber(blocks: ReturnType<typeof parseThemeBlocks>) {
  return resolveTheme(blocks, "amber");
}

function tokenColor(theme: ReturnType<typeof resolveTheme>, token: string, mode: "dark" | "light", kind: "declared" | "resolved"): string {
  const value = theme[mode][kind][token];
  if (value === undefined) throw new Error(`${SOURCE}: ${theme.id}/${mode} declares no ${token}`);
  return value;
}

export function renderModule(css: string, blocks = parseThemeBlocks(css), amber = resolveAmber(blocks)): string {
  const entries = Object.values(blocks).map((block) => {
    const { resolved } = block.id === "amber" ? amber[block.mode] : resolveEntry(blocks, block.id, block.mode);
    const color = (role: string): string => {
      const value = resolved[`--${role}`];
      if (value === undefined) throw new Error(`${SOURCE}: ${block.id}/${block.mode} has no --${role}`);
      return JSON.stringify(value);
    };
    const ansi = Object.entries(LIGHT_ANSI_ROLES).map(([name, role]) => {
      const declared = block.declared[`--${role}`];
      if (block.mode === "dark") {
        if (declared !== undefined) throw new Error(`${SOURCE}: ${block.id}/dark must not declare --${role}`);
        return "";
      }
      if (declared === undefined) throw new Error(`${SOURCE}: ${block.id}/light must declare --${role}`);
      return `, ${name}: ${color(role)}`;
    }).join("");
    const roles = [...Object.keys(ROLES), ...Object.values(LIGHT_ANSI_ROLES)].filter((role) => block.declared[`--${role}`] !== undefined);
    return [
      "  {",
      `    id: ${JSON.stringify(block.id)},`,
      `    mode: ${JSON.stringify(block.mode)},`,
      `    roles: [${roles.map((role) => JSON.stringify(role)).join(", ")}],`,
      `    terminal: { background: ${color("term-bg")}, foreground: ${color("term-fg")}, cursor: ${color("term-cursor")}, selectionBackground: ${color("term-selection")}${ansi} },`,
      `    bgPanel: ${color("bg-panel")},`,
      // the page's own surface, which the boot script paints before the stylesheet arrives (src/theme-bootstrap.ts)
      `    bg: ${color("bg")},`,
      // the few colours Settings' theme cards draw a theme with (SettingsDialog.tsx, ThemeCards)
      `    preview: { elevated: ${color("bg-elevated")}, border: ${color("border")}, text: ${color("text")}, textDim: ${color("text-dim")}, accent: ${color("accent")}, primary: ${color("primary")} },`,
      "  },",
    ].join("\n");
  });
  const ids = [...new Set(Object.values(blocks).map((block) => block.id))];
  return [
    "// GENERATED by scripts/generate-themes.ts from src/styles.css - do not edit; run: bun run generate:themes",
    "",
    `export const THEME_IDS = [${ids.map((id) => JSON.stringify(id)).join(", ")}] as const;`,
    "",
    "export type ThemeId = (typeof THEME_IDS)[number];",
    "",
    "export const SUPPORTED_ENTRIES = [",
    ...entries,
    "] as const;",
    "",
  ].join("\n");
}

function countOf(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

export function renderDesign(css: string, design: string, amber = resolveAmber(parseThemeBlocks(css))): string {
  for (const marker of [DESIGN_BEGIN, DESIGN_END]) {
    const count = countOf(design, marker);
    if (count !== 1) throw new Error(`${OUTPUTS.design}: marker ${marker} found ${count} times, expected exactly once`);
  }
  const begin = design.indexOf(DESIGN_BEGIN);
  const end = design.indexOf(DESIGN_END);
  if (end < begin) throw new Error(`${OUTPUTS.design}: marker ${DESIGN_END} comes before ${DESIGN_BEGIN}`);
  const rows = DESIGN_ROWS.map(([label, token]) =>
    `| ${label} | \`${token}\` | \`${tokenColor(amber, token, "dark", "declared")}\` | \`${tokenColor(amber, token, "light", "declared")}\` |`);
  const table = ["| Role | Token | Dark | Light |", "|------|-------|------|-------|", ...rows].join("\n");
  const blocks = parseThemeBlocks(css);
  const light = Object.values(blocks).filter((block) => block.mode === "light");
  const ansi = [
    "### Light terminal ANSI colours",
    "",
    "Each colour is at least 4.5:1 on its row's `--term-bg`. Dark rows use xterm's defaults.",
    "Normal and bright slots may share a colour to preserve the palette while keeping both readable.",
    "",
    `| ANSI | xterm key | ${light.map(({ id }) => id).join(" | ")} |`,
    `|------|-----------|${light.map(() => "-------|").join("")}`,
    ...Object.entries(LIGHT_ANSI_ROLES).map(([name, role], index) =>
      `| ${index} | \`${name}\` | ${light.map(({ id, mode }) => `\`${resolveEntry(blocks, id, mode).resolved[`--${role}`]}\``).join(" | ")} |`),
  ].join("\n");
  return `${design.slice(0, begin + DESIGN_BEGIN.length)}\n${table}\n\n${ansi}\n${design.slice(end)}`;
}

function decodeNumericEntities(value: string): string {
  return value.replace(/&#(x[0-9a-f]+|\d+);?/gi, (_, code: string) => {
    const point = code[0] === "x" || code[0] === "X" ? Number.parseInt(code.slice(1), 16) : Number(code);
    return point <= 0x10ffff ? String.fromCodePoint(point) : "\ufffd";
  });
}

/**
 * Bun's HTMLRewriter (lol-html) parses the page, so comments, quoted attributes and raw-text elements are
 * read as a browser reads them, and only the matched tag's content attribute is re-serialized. Its
 * getAttribute returns the first `name` undecoded, so numeric references are decoded here as a browser would.
 */
export function renderIndex(css: string, html: string, theme = resolveTheme(parseThemeBlocks(css), DEFAULT_ID)): string {
  const color = tokenColor(theme, "--bg-panel", "dark", "resolved");
  let count = 0;
  const output = new HTMLRewriter().on("meta", {
    element(element) {
      if (decodeNumericEntities(element.getAttribute("name") ?? "").toLowerCase() !== "theme-color") return;
      count++;
      element.setAttribute("content", color);
    },
  }).transform(html);
  if (count !== 1) throw new Error(`${OUTPUTS.index}: marker <meta name="theme-color"> found ${count} times, expected exactly once`);
  return output;
}

/** The keys of the top-level object of valid JSON, decoded, with the span of each value that is a string. */
function topLevelKeys(json: string): { key: string; value: { start: number; end: number } | null }[] {
  const stringEnd = (at: number): number => {
    let index = at + 1;
    while (json[index] !== '"') index += json[index] === "\\" ? 2 : 1;
    return index + 1;
  };
  const skipSpace = (at: number): number => {
    let index = at;
    while (/\s/.test(json[index] ?? "")) index++;
    return index;
  };
  const keys: { key: string; value: { start: number; end: number } | null }[] = [];
  const open: string[] = [];
  for (let index = 0; index < json.length;) {
    const char = json[index]!;
    if (char !== '"') {
      if (char === "{" || char === "[") open.push(char);
      else if (char === "}" || char === "]") open.pop();
      index++;
      continue;
    }
    const end = stringEnd(index);
    const colon = skipSpace(end);
    if (open.length === 1 && open[0] === "{" && json[colon] === ":") {
      const start = skipSpace(colon + 1);
      const value = json[start] === '"' ? { start, end: stringEnd(start) } : null;
      keys.push({ key: JSON.parse(json.slice(index, end)) as string, value });
      index = value?.end ?? start;
    } else {
      index = end;
    }
  }
  return keys;
}

export function renderManifest(css: string, json: string, theme = resolveTheme(parseThemeBlocks(css), DEFAULT_ID)): string {
  const values = { theme_color: tokenColor(theme, "--bg-panel", "dark", "resolved"), background_color: tokenColor(theme, "--bg", "dark", "resolved") };
  const before = JSON.parse(json) as Record<string, unknown>;
  // JSON.parse keeps only the last of duplicate keys, so the keys are counted in the text itself
  const keys = topLevelKeys(json);
  const edits = Object.entries(values).map(([key, value]) => {
    const found = keys.filter((entry) => entry.key === key);
    if (found.length !== 1) throw new Error(`${OUTPUTS.manifest}: marker "${key}" found ${found.length} times, expected exactly once`);
    const span = found[0]!.value;
    if (!span) throw new Error(`${OUTPUTS.manifest}: marker "${key}" has no string value`);
    return { ...span, value: JSON.stringify(value) };
  });
  let text = json;
  for (const edit of edits.sort((a, b) => b.start - a.start)) text = `${text.slice(0, edit.start)}${edit.value}${text.slice(edit.end)}`;
  // the targeted edit must leave valid JSON whose other keys are untouched
  const after = JSON.parse(text) as Record<string, unknown>;
  if (JSON.stringify({ ...before, ...values }) !== JSON.stringify(after)) {
    throw new Error(`${OUTPUTS.manifest}: the theme color edit changed more than theme_color and background_color`);
  }
  return text;
}

export function renderAll(root: string): { path: string; content: string }[] {
  const at = (file: string): string => join(root, file);
  const css = readFileSync(at(SOURCE), "utf8");
  const blocks = parseThemeBlocks(css);
  const amber = resolveAmber(blocks);
  const fallback = resolveTheme(blocks, DEFAULT_ID);
  return [
    { path: OUTPUTS.module, content: renderModule(css, blocks, amber) },
    { path: OUTPUTS.design, content: renderDesign(css, readFileSync(at(OUTPUTS.design), "utf8"), amber) },
    { path: OUTPUTS.index, content: renderIndex(css, readFileSync(at(OUTPUTS.index), "utf8"), fallback) },
    { path: OUTPUTS.manifest, content: renderManifest(css, readFileSync(at(OUTPUTS.manifest), "utf8"), fallback) },
  ];
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const check = args.includes("--check");
  const rootAt = args.indexOf("--root");
  const rootArg = rootAt >= 0 ? args[rootAt + 1] : undefined;
  if (rootAt >= 0 && !rootArg) {
    console.error("--root needs a directory");
    process.exit(2);
  }
  const root = rootArg ? resolve(rootArg) : join(import.meta.dir, "..");
  let outputs: { path: string; content: string }[];
  try {
    outputs = renderAll(root);
  } catch (error) {
    console.error(`generate-themes: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
  if (check) {
    const stale = outputs.filter(({ path, content }) => {
      const file = join(root, path);
      return !existsSync(file) || readFileSync(file, "utf8") !== content;
    });
    for (const { path } of stale) console.error(`STALE ${path} - Run: bun run generate:themes`);
    if (stale.length > 0) process.exit(1);
    console.log("generated themes are up to date");
  } else {
    for (const { path, content } of outputs) {
      const file = join(root, path);
      if (existsSync(file) && readFileSync(file, "utf8") === content) continue;
      writeFileSync(file, content);
      console.log(`wrote ${path}`);
    }
  }
}
