import { LIGHT_ANSI_ROLES, ROLES } from "./themeRoles.ts";
import type { Mode } from "./themes.ts";

export function normalizeThemeValue(value: string): string {
  return value
    .replace(/\s+/g, " ")
    .trim()
    .replace(/#[0-9a-f]{3,8}\b/gi, (hex) => hex.toLowerCase())
    .replace(/rgba\(([^()]*)\)/gi, (_, args: string) => `rgba(${args.split(",").map((part) => String(Number(part.trim()))).join(", ")})`);
}

export class ThemeValueError extends Error {
  constructor(readonly entry: string, readonly role: string, readonly value: string, reason = "unreadable value") {
    super(`${entry} ${role}: ${reason} ${value}`);
    this.name = "ThemeValueError";
  }
}

export type ThemeValue =
  | { readonly kind: "color"; readonly value: string }
  | { readonly kind: "alias"; readonly role: string }
  | { readonly kind: "shadow"; readonly layers: readonly { readonly geometry: string; readonly color: string }[] };

const ALIAS = /^var\((--[\w-]+)\)$/;
const RGBA = /^rgba\((\d+), (\d+), (\d+), (0(?:\.\d+)?|1(?:\.0+)?)\)$/;
const COLOR_ROLES = { ...ROLES, ...Object.fromEntries(Object.values(LIGHT_ANSI_ROLES).map((role) => [role, "color"])) };

function isColor(value: string): boolean {
  if (/^#[0-9a-f]{6}$/.test(value) || value === "transparent") return true;
  const rgba = RGBA.exec(value);
  return rgba !== null && rgba.slice(1, 4).every((channel) => Number(channel) <= 255);
}

export function parseThemeValue(entry: string, role: string, raw: string): ThemeValue {
  for (const [, args] of raw.matchAll(/rgba\(([^()]*)\)/gi)) {
    if (args === undefined || !/^\s*\d+\s*,\s*\d+\s*,\s*\d+\s*,\s*(?:\d+(?:\.\d+)?|\.\d+)\s*$/.test(args)) {
      throw new ThemeValueError(entry, role, raw);
    }
  }
  const value = normalizeThemeValue(raw);
  if (isColor(value)) return { kind: "color", value };
  const alias = ALIAS.exec(value);
  if (alias?.[1]) return { kind: "alias", role: alias[1] };
  // A layer separator is a comma outside rgba(), whose arguments contain commas too.
  const layers = value.split(/,\s*(?![^()]*\))/).map((layer) => {
    const match = /^((?:-?\d+(?:\.\d+)?(?:px)? ){1,3}-?\d+(?:\.\d+)?(?:px)?) (rgba\([^()]*\)|var\(--border\))$/.exec(layer);
    if (!match?.[1] || !match[2]) throw new ThemeValueError(entry, role, raw);
    const [, geometry, color] = match;
    if (color === "var(--border)" ? geometry !== "0 0 0 1px" : !RGBA.test(color) || !isColor(color)) {
      throw new ThemeValueError(entry, role, raw);
    }
    return { geometry, color };
  });
  return { kind: "shadow", layers };
}

export type ThemeBlock = {
  readonly id: string;
  readonly mode: Mode;
  readonly declared: Readonly<Record<string, string>>;
};

export function parseThemeBlocks(css: string): Record<string, ThemeBlock> {
  const blocks: Record<string, ThemeBlock> = {};
  const text = css.replace(/\/\*[\s\S]*?\*\//g, "");
  for (let at = 0; at < text.length;) {
    const open = text.indexOf("{", at);
    if (open < 0) break;
    let close = open + 1;
    let depth = 1;
    for (; depth > 0 && close < text.length; close++) depth += text[close] === "{" ? 1 : text[close] === "}" ? -1 : 0;
    const selectors = text.slice(at, open).trim();
    if (depth !== 0) throw new ThemeValueError(selectors, "block", text.slice(open), "unclosed block");
    const body = text.slice(open + 1, close - 1);
    for (const selector of selectors.split(",").map((part) => part.trim())) {
      const match = /^\[data-theme="(dark|light)"\]\s*\[data-palette="([\w-]+)"\]$/.exec(selector);
      const mode = selector === ":root" ? "dark" : selector === '[data-theme="light"]' ? "light" : match?.[1];
      const id = match?.[2] ?? "amber";
      if (mode !== "dark" && mode !== "light") continue;
      const entry = `${id}/${mode}`;
      if (blocks[entry]) throw new ThemeValueError(entry, "block", selector, "duplicate block");
      const declared: Record<string, string> = {};
      for (const piece of body.split(";")) {
        const declaration = /^\s*(--[\w-]+)\s*:\s*([\s\S]*?)\s*$/.exec(piece);
        if (!declaration?.[1] || declaration[2] === undefined) continue;
        const [, name, raw] = declaration;
        const role = name.slice(2);
        if (declared[name] !== undefined) throw new ThemeValueError(entry, role, raw, "duplicate declaration");
        const value = normalizeThemeValue(raw);
        if (role === "bar-bg" || role === "card-glass") {
          const expected = role === "bar-bg" ? "color-mix(in srgb, var(--bg-panel) 72%, transparent)" : "color-mix(in srgb, var(--bg-elevated) 80%, transparent)";
          if (value !== expected) throw new ThemeValueError(entry, role, raw);
        } else if (role in COLOR_ROLES || /^(indicator-|droplet-|pdf-page$|syntax-(comment|inserted|deleted)$)/.test(role) || id !== "amber") {
          const parsed = parseThemeValue(entry, role, role === "droplet-bg" && value === "#000" ? "#000000" : raw);
          const expectedKind = Object.entries(COLOR_ROLES).find(([name]) => name === role)?.[1];
          if (expectedKind && parsed.kind !== "alias" && parsed.kind !== expectedKind) throw new ThemeValueError(entry, role, raw);
        }
        declared[name] = value;
      }
      blocks[entry] = { id, mode, declared };
    }
    at = close;
  }
  for (const entry of ["amber/dark", "amber/light"]) {
    if (!blocks[entry]) throw new ThemeValueError(entry, "block", "(missing)", "missing block");
  }
  return blocks;
}

export function resolveEntry(css: string | Readonly<Record<string, ThemeBlock>>, id: string, mode: Mode): {
  declared: Record<string, string>;
  resolved: Record<string, string>;
} {
  const blocks = typeof css === "string" ? parseThemeBlocks(css) : css;
  const entry = `${id}/${mode}`;
  const block = blocks[entry];
  if (!block) throw new ThemeValueError(entry, "block", "(missing)", "missing block");
  const declared = {
    ...blocks["amber/dark"]?.declared,
    ...(mode === "light" ? blocks["amber/light"]?.declared : {}),
    ...block.declared,
  };
  const resolved: Record<string, string> = {};
  const resolve = (name: string, seen: readonly string[]): string => {
    const cached = resolved[name];
    if (cached !== undefined) return cached;
    const value = declared[name];
    if (value === undefined) throw new ThemeValueError(entry, seen.at(-1) ?? name, name, "missing alias target");
    if (seen.includes(name)) throw new ThemeValueError(entry, name, value, "cyclic alias");
    return resolved[name] = normalizeThemeValue(value.replace(/var\(\s*(--[\w-]+)\s*\)/g, (_, ref: string) => resolve(ref, [...seen, name])));
  };
  for (const name of Object.keys(declared)) {
    const value = resolve(name, []);
    if (Object.entries(COLOR_ROLES).some(([role, kind]) => name === `--${role}` && kind === "color") && !isColor(value)) {
      throw new ThemeValueError(entry, name.slice(2), declared[name] ?? value);
    }
  }
  return { declared, resolved };
}
