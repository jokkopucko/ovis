#!/usr/bin/env bun
/** Offline proposals only. Review and author CSS by hand; this tool never writes files. */
import { ROLES, SHADOW_GEOMETRY } from "../src/lib/themes.ts";
import type { Mode } from "../src/lib/themes.ts";
import { isHerdrThemeId, KIND, RAW } from "./herdr-themes.ts";
import type { HerdrThemeId, RawPalette } from "./herdr-themes.ts";
import { deltaE, fromLab, hex, lab, luminance, mix, over, rgb, rgba } from "../src/lib/colorMath.ts";

export { contrast, deltaE } from "../src/lib/colorMath.ts";

export type Role = keyof typeof ROLES;
export type ThemeRoles = Record<Role, string>;
const statusAlpha = (mode: Mode): number => mode === "dark" ? 0.14 : 0.12;

/** One executable policy for every role absent from herdr, applied in insertion order. */
export const ROLE_DEFAULTS = {
  "bg-input": (r: ThemeRoles) => r["bg-elevated"],
  "text-strong": (r: ThemeRoles) => r.text,
  "primary-hover": (r: ThemeRoles) => mix(r.primary, r.text),
  "primary-text": (r: ThemeRoles) => r["bg-panel"],
  "danger-text": (r: ThemeRoles) => r["status-blocked"],
  scrim: (r: ThemeRoles, mode: Mode) => rgba(mode === "dark" ? r.bg : r.text, mode === "dark" ? 0.5 : 0.35),
  "line-number": (r: ThemeRoles) => r["text-dim"],
  "bubble-border": () => "var(--border)",
  "accent-tint": (r: ThemeRoles, mode: Mode) => rgba(r.accent, mode === "dark" ? 0.13 : 0.1),
  "primary-tint": (r: ThemeRoles, mode: Mode) => rgba(r.primary, mode === "dark" ? 0.16 : 0.14),
  "status-working-tint": (r: ThemeRoles, mode: Mode) => rgba(r["status-working"], statusAlpha(mode)),
  "status-blocked-tint": (r: ThemeRoles, mode: Mode) => rgba(r["status-blocked"], statusAlpha(mode)),
  "status-done-tint": (r: ThemeRoles, mode: Mode) => rgba(r["status-done"], statusAlpha(mode)),
  "danger-tint": (r: ThemeRoles, mode: Mode) => rgba(r["status-blocked"], mode === "dark" ? 0.12 : 0.1),
  "shadow-drawer": (r: ThemeRoles, mode: Mode) => `${SHADOW_GEOMETRY[mode]["shadow-drawer"][0]} ${rgba(mode === "dark" ? "#000000" : r.text, mode === "dark" ? 0.6 : 0.22)}`,
  "shadow-pop": (r: ThemeRoles, mode: Mode) => `${SHADOW_GEOMETRY[mode]["shadow-pop"][0]} ${rgba(mode === "dark" ? "#000000" : r.text, mode === "dark" ? 0.55 : 0.16)}, ${SHADOW_GEOMETRY[mode]["shadow-pop"][1]} var(--border)`,
  "shadow-card": (r: ThemeRoles, mode: Mode) => `${SHADOW_GEOMETRY[mode]["shadow-card"][0]} ${rgba(mode === "dark" ? "#000000" : r.text, mode === "dark" ? 0.35 : 0.07)}`,
} satisfies Partial<Record<Role, (roles: ThemeRoles, mode: Mode) => string>>;

/** Pure boundary mapping. No repair here: every later repair is an explicit CSS override. */
export function mapTheme(id: HerdrThemeId, raw: RawPalette = RAW[id]): ThemeRoles {
  const bg = id === "catppuccin" || id === "vesper" ? raw.surface_dim : raw.panel_bg;
  const roles: ThemeRoles = {
    bg, "bg-panel": raw.panel_bg, "bg-elevated": raw.surface0, "bg-hover": raw.active_row_bg,
    border: raw.surface0, "border-strong": raw.surface1, text: raw.text, "text-dim": raw.subtext0,
    accent: raw.accent, primary: raw.accent,
    "status-working": raw.blue, "status-blocked": raw.red, "status-done": raw.green,
    "status-idle": raw.overlay1, notice: raw.yellow,
    "term-bg": bg, "term-fg": raw.text, "term-selection": raw.selection_bg, "term-cursor": raw.text,
    "syntax-keyword": raw.mauve, "syntax-string": raw.green, "syntax-number": raw.peach,
    "syntax-type": raw.yellow, "syntax-variable": raw.text, "syntax-meta": raw.teal, "syntax-function": raw.blue,
    // Filled by ROLE_DEFAULTS below, kept explicit so the role contract is type-checked.
    "bg-input": "", "text-strong": "", "primary-hover": "", "primary-text": "", "danger-text": "",
    scrim: "", "line-number": "", "bubble-border": "", "accent-tint": "", "primary-tint": "",
    "status-working-tint": "", "status-blocked-tint": "", "status-done-tint": "", "danger-tint": "",
    "shadow-drawer": "", "shadow-pop": "", "shadow-card": "",
  };
  for (const [role, derive] of Object.entries(ROLE_DEFAULTS)) roles[role as keyof typeof ROLE_DEFAULTS] = derive(roles, KIND[id]);
  return roles;
}

export function minimumContrast(roles: ThemeRoles, role: Role, value = roles[role], mode: Mode): number {
  const surfaces = role.startsWith("syntax-") ? ["bg-panel", "bg-elevated"] as const : ["bg", "bg-panel", "bg-elevated", "bg-hover"] as const;
  return Math.min(...surfaces.map((surface) => {
    const ground = rgb(roles[surface]);
    const background = /^status-(working|blocked|done)$/.test(role) ? over(rgb(value), ground, statusAlpha(mode)) : ground;
    const a = luminance(rgb(value)), b = luminance(background);
    return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
  }));
}

const AA_ROLES: readonly Role[] = ["text", "text-dim", "status-working", "status-blocked", "status-done",
  "syntax-function", "syntax-keyword", "syntax-string", "syntax-number", "syntax-type", "syntax-variable", "syntax-meta"];

/**
 * Search nearest passing quantized L, then bisect its boundary. Only initially AA-failing
 * foregrounds move. Chroma relaxation is bounded at 5%; gamut clipping matches repair.mjs.
 * Failure is explicit: no success-looking partial proposal is printed.
 */
export function proposeTheme(id: HerdrThemeId): { roles: ThemeRoles; moved: { role: Role; value: string; dE: number; reason: string }[] } {
  const mapped = mapTheme(id), roles = { ...mapped }, mode = KIND[id];
  for (const role of AA_ROLES) {
    const original = mapped[role];
    if (minimumContrast(roles, role, original, mode) >= 4.5) continue;
    const [L, a, b] = lab(rgb(original));
    let repaired: string | undefined;
    for (let reduction = 0; reduction <= 50 && repaired === undefined; reduction++) {
      const scale = 1 - reduction / 1000;
      let best: number | undefined;
      const value = (l: number): string => hex(fromLab([l, a * scale, b * scale]));
      for (let step = 0; step <= 10000; step++) {
        const l = step / 10000;
        if (best !== undefined && Math.abs(l - L) >= Math.abs(best - L)) continue;
        if (minimumContrast(roles, role, value(l), mode) >= 4.6) best = l;
      }
      if (best === undefined) continue;
      let passing = best, failing = L;
      for (let step = 0; step < 45; step++) {
        const mid = (passing + failing) / 2;
        if (minimumContrast(roles, role, value(mid), mode) >= 4.6) passing = mid;
        else failing = mid;
      }
      repaired = value(passing);
    }
    if (repaired === undefined) throw new Error(`${id}/${mode} ${role}: cannot reach 4.6 within 5% chroma reduction`);
    roles[role] = repaired;
  }
  // Defaults dependent on repaired foregrounds must travel with those foregrounds.
  for (const [role, derive] of Object.entries(ROLE_DEFAULTS)) roles[role as keyof typeof ROLE_DEFAULTS] = derive(roles, mode);
  const moved = Object.keys(ROLES).flatMap((role) => {
    const key = role as Role, value = roles[key], from = mapped[key];
    if (value === from) return [];
    const colors = (text: string): string[] => [...text.matchAll(/#[0-9a-f]{6}|rgba\((\d+), (\d+), (\d+), [\d.]+\)/g)]
      .map((m) => m[0].startsWith("#") ? m[0] : hex([Number(m[1]), Number(m[2]), Number(m[3])]));
    const before = colors(from), after = colors(value);
    const dE = Math.max(0, ...before.map((color, i) => deltaE(color, after[i] ?? color)));
    return [{ role: key, value, dE, reason: AA_ROLES.includes(key) ? "AA lightness repair on serialized hex (target 4.6; chroma reduction at most 5%)" : "Recomputed default from AA-repaired foreground" }];
  });
  return { roles, moved };
}

if (import.meta.main) {
  const id = process.argv[2] ?? "";
  if (process.argv.length !== 3 || !isHerdrThemeId(id)) {
    console.error(`Usage: bun scripts/herdr-theme-proposal.ts <theme>\nKnown themes: ${Object.keys(RAW).join(", ")}`);
    process.exit(2);
  }
  const { roles, moved } = proposeTheme(id);
  console.log(`/* ${id}/${KIND[id]} - proposal only; dE_OK = 100 * OKLab distance */`);
  console.log(`[data-theme="${KIND[id]}"][data-palette="${id}"] {`);
  for (const role of Object.keys(ROLES)) {
    const key = role as Role;
    console.log(`  --${role}: ${roles[key]}; /* dE ${(moved.find((item) => item.role === key)?.dE ?? 0).toFixed(4)} */`);
  }
  console.log("}");
  console.log(JSON.stringify(moved, null, 2));
}
