/**
 * Every colour the app draws, from the sixteen of a Base16 scheme (https://github.com/chriskempson/base16):
 * the public contract of an imported theme (customThemes.ts) is those sixteen seeds, never the
 * app's own roles, so a role can be renamed, split or added here without breaking a theme file.
 *
 * The scheme's own colours are kept wherever they read: a colour moves only when it is under a
 * floor of themeContrast.ts, and then only its lightness, by the smallest step that clears the
 * floor on every surface it is drawn on (its chroma gives way only when no lightness does). A
 * surface the text could only be read on by moving far gives way to the text instead, and a
 * hovered or selected row always tells from the ground. So any sixteen colours, however they were
 * chosen, come out as a theme the contrast test of the built-in themes would pass.
 */
import { contrast, deltaE, fromLab, hex, lab, luminance, mix, over, rgb, rgba, type Vector } from "./colorMath.ts";
import { INDICATOR_FLOOR, TEXT_FLOOR } from "./themeContrast.ts";
import { INDICATOR_ROLES, LIGHT_ANSI_ROLES, ROLES, SHADOW_GEOMETRY } from "./themeRoles.ts";
import type { Mode } from "./themes.ts";

export const BASE16_KEYS = [
  "base00", "base01", "base02", "base03", "base04", "base05", "base06", "base07",
  "base08", "base09", "base0A", "base0B", "base0C", "base0D", "base0E", "base0F",
] as const;
export type Base16Key = (typeof BASE16_KEYS)[number];
/** Sixteen `#rrggbb` colours, lowercase. */
export type Base16 = Readonly<Record<Base16Key, string>>;

export type RoleName = keyof typeof ROLES | "notice-tint" | (typeof INDICATOR_ROLES)[number] | (typeof LIGHT_ANSI_ROLES)[keyof typeof LIGHT_ANSI_ROLES];

/** What a colour is read on: a fixed colour, or one that follows the candidate (a tint of itself). */
type Under = string | ((candidate: Vector) => Vector);
/** A surface a colour is read on, and the ratio it must keep there. */
interface Ground { readonly color: Under; readonly floor: number }

/** How far over a floor a moved colour is taken, so rounding it to #rrggbb cannot leave it under. */
const MARGIN = 0.1;
/** Lightness steps a colour is tried at, either way from its own. */
const STEPS = 200;
/** Chroma kept at each try: the hue stays whole while any lightness of it reads. */
const CHROMA = [1, 0.9, 0.75, 0.5, 0.25, 0] as const;

const ground = (color: Under, floor: number): Ground => ({ color, floor });
/** A colour as it is drawn: whole channels, 0 to 255. */
const drawn = ([r, g, b]: Vector): Vector => [r, g, b].map((channel) => Math.round(Math.max(0, Math.min(255, channel)))) as unknown as Vector;
const ratio = (a: number, b: number): number => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);

/** The grounds with each fixed colour's luminance worked out once: a search asks about them a few hundred times. */
type Measured = readonly { readonly floor: number; readonly light: (candidate: Vector) => number }[];
function measured(grounds: readonly Ground[]): Measured {
  return grounds.map(({ color, floor }) => {
    if (typeof color !== "string") return { floor, light: (candidate: Vector) => luminance(drawn(color(candidate))) };
    const fixed = luminance(rgb(color));
    return { floor, light: () => fixed };
  });
}
/** The least share of its floor `candidate` keeps on any ground: 1 or more when it clears them all. */
const kept = (candidate: Vector, grounds: Measured, margin = 0): number => {
  const own = luminance(candidate);
  return Math.min(...grounds.map((entry) => ratio(own, entry.light(candidate)) / (entry.floor + margin)));
};
const clears = (color: string, grounds: readonly Ground[]): boolean => kept(rgb(color), measured(grounds)) >= 1;

/** `color` as it is when it reads on every ground, else at the nearest lightness that does. */
export function fit(color: string, grounds: readonly Ground[]): string {
  const held = measured(grounds);
  const own = rgb(color);
  if (kept(own, held) >= 1) return color;
  const [L, a, b] = lab(own);
  for (const scale of CHROMA) {
    const at = (l: number): Vector => drawn(fromLab([l, a * scale, b * scale]));
    for (let step = 1; step <= STEPS; step++) {
      for (const direction of [1, -1]) {
        const l = L + direction * step / STEPS;
        if (l < 0 || l > 1 || kept(at(l), held, MARGIN) < 1) continue;
        // the step before failed: the boundary is between the two
        let passing = l, failing = l - direction / STEPS;
        for (let i = 0; i < 12; i++) {
          const mid = (passing + failing) / 2;
          if (kept(at(mid), held, MARGIN) >= 1) passing = mid;
          else failing = mid;
        }
        return hex(at(passing));
      }
    }
  }
  // no lightness clears the margin: black or white, whichever keeps the most of every floor
  return kept([255, 255, 255], held) >= kept([0, 0, 0], held) ? "#ffffff" : "#000000";
}

const blend = (color: string, under: string, alpha: number): string => hex(over(rgb(color), rgb(under), alpha));

/** Whether `text` reads on a surface from the same side as on `bg` (lighter than both, or darker than both). */
function reading(bg: string, text: string): (surface: string) => boolean {
  const light = luminance(rgb(text)) > luminance(rgb(bg));
  return (surface) => contrast(text, surface) >= TEXT_FLOOR && (luminance(rgb(text)) > luminance(rgb(surface))) === light;
}

/**
 * `surface` as it is when the text reads on it, else moved toward `bg` until it does: with every
 * surface on one side of the text, a colour pushed far enough to that side reads on all of them.
 */
function yielding(surface: string, bg: string, reads: (surface: string) => boolean): string {
  if (reads(surface)) return surface;
  let failing = 0, passing = 1;
  for (let i = 0; i < 16; i++) {
    const mid = (failing + passing) / 2;
    if (reads(blend(bg, surface, mid))) passing = mid;
    else failing = mid;
  }
  return blend(bg, surface, passing);
}

/** `bg` made lighter (`way` 1) or darker (-1) until it is `ratio` off itself; null where that way runs out first. */
function stepped(bg: string, way: number, ratio: number): string | null {
  const [L, a, b] = lab(rgb(bg));
  for (let l = L + way * 0.005; l >= 0 && l <= 1; l += way * 0.005) {
    const candidate = hex(fromLab([l, a, b]));
    if (contrast(candidate, bg) >= ratio) return candidate;
  }
  return null;
}

/** How far past reading on the ground the text may move (dE, 100 * OKLab distance) to read on a surface of the scheme too, before that surface moves instead. */
const TEXT_STEP = 12;
/** How far off the ground a surface lies that the theme has to make itself, as contrast with the ground: the built-in themes' medians. */
const RAISED = 1.1;
const ROW = 1.2;
/** Under this a surface cannot be told from the ground it lies on (the built-in themes' least is 1.09). */
const TELLS = 1.05;

/**
 * The raised surface and the hovered or selected row for `text`. The scheme's own are kept where
 * the text reads on them; one it cannot be read on gives way toward the ground, and one that would
 * end on the ground itself takes a step off it instead: on the side away from the text, where the
 * text reads better still, else on the text's side when the text reads there. A row is always told
 * from the ground, also when the scheme gave it the ground's own colour. `crowded` names the steps
 * that found no room: the ground is as dark (or light) as colours go and the text sits at its floor.
 */
function place(seeds: Base16, text: string): { elevated: string; hover: string; crowded: string[] } {
  const bg = seeds.base00;
  const reads = reading(bg, text);
  const away = luminance(rgb(text)) > luminance(rgb(bg)) ? -1 : 1;
  const crowded: string[] = [];
  const settle = (surface: string, ratio: number, always: boolean): string => {
    const moved = yielding(surface, bg, reads);
    if (contrast(moved, bg) >= TELLS || (!always && moved === surface)) return moved;
    const far = stepped(bg, away, ratio);
    if (far !== null && reads(far)) return far;
    const near = stepped(bg, -away, ratio);
    if (near !== null && reads(near)) return near;
    if (near !== null) crowded.push(near);
    return moved;
  };
  return { elevated: settle(seeds.base01, RAISED, false), hover: settle(seeds.base02, ROW, true), crowded };
}

/** The share of `--notice` in `--notice-tint`, over the panel (DESIGN.md, Notice tint). */
const NOTICE_TINT = { dark: 0.12, light: 0.06 } as const;

/**
 * herdr's TUI state colours as the base blocks of src/styles.css carry them (Catppuccin Mocha, and
 * Latte in light). An imported theme keeps them, moved only as far as its own surfaces need;
 * themeDerive.test.ts holds this copy to the stylesheet.
 */
export const INDICATORS: Readonly<Record<Mode, Readonly<Record<(typeof INDICATOR_ROLES)[number], string>>>> = {
  dark: { "indicator-working": "#f9e2af", "indicator-blocked": "#f38ba8", "indicator-done": "#94e2d5", "indicator-idle": "#a6e3a1", "indicator-unknown": "#6c7086" },
  light: { "indicator-working": "#df8e1d", "indicator-blocked": "#d20f39", "indicator-done": "#179299", "indicator-idle": "#40a02b", "indicator-unknown": "#9ca0b0" },
};

/**
 * Every role of themeRoles.ts, `notice-tint`, the state colours and, on a light theme, the sixteen
 * ANSI colours, by role name. `mode` is what the colours are, whatever the file called them: light
 * text on a darker ground is a dark theme.
 */
export function deriveTheme(seeds: Base16): { mode: Mode; vars: Record<RoleName, string> } {
  const bg = seeds.base00;
  // The text first reads on the ground, which some lightness of it always does. From there it
  // keeps the scheme's surfaces where a small further step lets it read on them (as the built-in
  // themes were repaired): on all three, else on the ground and the raised surface.
  const onGround = [ground(bg, TEXT_FLOOR)];
  const plain = fit(seeds.base05, onGround);
  let text = [[seeds.base01, seeds.base02], [seeds.base01]]
    .map((kept) => [...onGround, ...kept.map((surface) => ground(surface, TEXT_FLOOR))])
    .map((grounds) => ({ grounds, candidate: fit(seeds.base05, grounds) }))
    .find(({ grounds, candidate }) => clears(candidate, grounds) && deltaE(plain, candidate) <= TEXT_STEP)?.candidate ?? plain;
  let surfaces = place(seeds, text);
  if (surfaces.crowded.length > 0) {
    // no room for a row on either side of a text at its floor: the text moves off the ground, and the row lies between them
    text = fit(text, [...onGround, ...surfaces.crowded.map((surface) => ground(surface, TEXT_FLOOR))]);
    surfaces = place(seeds, text);
  }
  const { elevated, hover } = surfaces;
  const dark = luminance(rgb(text)) > luminance(rgb(bg));
  const mode: Mode = dark ? "dark" : "light";
  const onSurfaces = (floor: number): Ground[] => [bg, elevated, hover].map((surface) => ground(surface, floor));
  const panels = [ground(bg, TEXT_FLOOR), ground(elevated, TEXT_FLOOR)];

  // the tint under a notice is the notice itself over the panel: it reads on its own tint where a
  // lightness of it can, and where none can the tint thins below instead
  const ground0 = rgb(bg);
  const tintOf = (alpha: number) => (candidate: Vector): Vector => over(candidate, ground0, alpha);
  const underNotice = [...panels, ground(hover, INDICATOR_FLOOR)];
  const tinted = fit(seeds.base0A, [...underNotice, ground(tintOf(NOTICE_TINT[mode]), TEXT_FLOOR)]);
  const notice = clears(tinted, underNotice) ? tinted : fit(seeds.base0A, underNotice);
  // the text reads on the tint too: a tint it cannot be read on thins toward the panel, where it can
  let noticeTint = bg;
  for (let alpha: number = NOTICE_TINT[mode]; alpha >= 0.01; alpha /= 2) {
    const tint = blend(notice, bg, alpha);
    if (contrast(text, tint) < TEXT_FLOOR || contrast(notice, tint) < TEXT_FLOOR) continue;
    noticeTint = tint;
    break;
  }
  const indicator = [...onSurfaces(INDICATOR_FLOOR), ground(noticeTint, INDICATOR_FLOOR)];

  const textDim = fit(seeds.base04, [...onSurfaces(TEXT_FLOOR), ground(noticeTint, INDICATOR_FLOOR)]);
  const accent = fit(seeds.base0D, [ground(bg, INDICATOR_FLOOR)]);
  const working = fit(seeds.base0D, indicator);
  const blocked = fit(seeds.base08, indicator);
  const done = fit(seeds.base0B, indicator);
  const statusAlpha = dark ? 0.14 : 0.12;
  const shadow = dark ? "#000000" : text;

  const roles: Record<keyof typeof ROLES | "notice-tint", string> = {
    bg, "bg-panel": bg, "bg-elevated": elevated, "bg-hover": hover, "bg-input": elevated,
    border: seeds.base02, "border-strong": seeds.base03,
    text, "text-dim": textDim, "text-strong": text,
    accent, "accent-tint": rgba(accent, dark ? 0.13 : 0.1),
    primary: accent, "primary-hover": mix(accent, text),
    "primary-text": fit(bg, [ground(accent, TEXT_FLOOR)]),
    "primary-tint": rgba(accent, dark ? 0.16 : 0.14),
    "status-idle": fit(seeds.base03, [ground(bg, INDICATOR_FLOOR)]),
    "status-working": working, "status-blocked": blocked, "status-done": done,
    "status-working-tint": rgba(working, statusAlpha), "status-blocked-tint": rgba(blocked, statusAlpha), "status-done-tint": rgba(done, statusAlpha),
    "danger-tint": rgba(blocked, dark ? 0.12 : 0.1),
    notice, "notice-tint": noticeTint,
    "danger-text": fit(blocked, [ground(bg, TEXT_FLOOR)]),
    scrim: rgba(dark ? bg : text, dark ? 0.5 : 0.35),
    "term-bg": bg, "term-fg": text, "term-cursor": text, "term-selection": hover,
    "line-number": textDim,
    "syntax-function": fit(seeds.base0D, panels), "syntax-keyword": fit(seeds.base0E, panels), "syntax-string": fit(seeds.base0B, panels),
    "syntax-number": fit(seeds.base09, panels), "syntax-type": fit(seeds.base0A, panels), "syntax-variable": text, "syntax-meta": fit(seeds.base0C, panels),
    "bubble-border": "var(--border)",
    "shadow-drawer": `${SHADOW_GEOMETRY[mode]["shadow-drawer"][0]} ${rgba(shadow, dark ? 0.6 : 0.22)}`,
    "shadow-pop": `${SHADOW_GEOMETRY[mode]["shadow-pop"][0]} ${rgba(shadow, dark ? 0.55 : 0.16)}, ${SHADOW_GEOMETRY[mode]["shadow-pop"][1]} var(--border)`,
    "shadow-card": `${SHADOW_GEOMETRY[mode]["shadow-card"][0]} ${rgba(shadow, dark ? 0.35 : 0.07)}`,
  };
  const vars: Record<string, string> = { ...roles };
  for (const role of INDICATOR_ROLES) vars[role] = fit(INDICATORS[mode][role], indicator);
  if (!dark) {
    // xterm's own ANSI colours are made for a dark ground: a light theme names all sixteen, from the scheme's hues
    const hues = { red: seeds.base08, green: seeds.base0B, yellow: seeds.base0A, blue: seeds.base0D, magenta: seeds.base0E, cyan: seeds.base0C };
    Object.assign(vars, { [LIGHT_ANSI_ROLES.black]: text, [LIGHT_ANSI_ROLES.white]: textDim, [LIGHT_ANSI_ROLES.brightBlack]: textDim, [LIGHT_ANSI_ROLES.brightWhite]: text });
    for (const [name, color] of Object.entries(hues)) {
      const fitted = fit(color, onGround);
      vars[LIGHT_ANSI_ROLES[name as keyof typeof hues]] = fitted;
      vars[LIGHT_ANSI_ROLES[`bright${name[0]!.toUpperCase()}${name.slice(1)}` as keyof typeof LIGHT_ANSI_ROLES]] = fitted;
    }
  }
  return { mode, vars: vars as Record<RoleName, string> };
}
