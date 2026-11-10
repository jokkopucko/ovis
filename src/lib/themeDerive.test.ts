import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { contrast } from "./colorMath.ts";
import { parseThemeBlocks, parseThemeValue } from "./themeCss.ts";
import { CONTRAST_PAIRS, INDICATOR_FLOOR, LIGHT_ANSI_PAIRS, TEXT_FLOOR } from "./themeContrast.ts";
import { BASE16_KEYS, deriveTheme, fit, INDICATORS, type Base16 } from "./themeDerive.ts";
import { INDICATOR_ROLES, LIGHT_ANSI_ROLES, ROLES } from "./themeRoles.ts";

/** Under this a hovered or selected row cannot be told from the ground (themeDerive.ts TELLS). */
const TELLS = 1.05;
/**
 * The two tests that derive hundreds of themes take a few seconds of plain arithmetic: more than a
 * single file's default five on a PC that is busy with other checks, where CI gives a minute.
 */
const HEAVY = 30_000;

/**
 * What a derived theme is under: the pairs of themeContrast.ts, the way themes.contrast.test.ts reads a
 * built-in theme, the state colours on the surfaces a row can take, and a row that tells from the ground.
 */
function below({ mode, vars }: ReturnType<typeof deriveTheme>): string[] {
  const roles = vars as Record<string, string>;
  const states = INDICATOR_ROLES.flatMap((fg) => ["bg", "bg-elevated", "bg-hover"].map((bg) => ({ fg, bg, floor: INDICATOR_FLOOR })));
  const under = [...CONTRAST_PAIRS, ...(mode === "light" ? LIGHT_ANSI_PAIRS : []), ...states].flatMap(({ fg, bg, floor }) => {
    const ratio = contrast(roles[fg]!, roles[bg]!);
    return ratio < floor ? [`${fg} on ${bg}: ${ratio.toFixed(2)}:1 < ${floor}:1 (${roles[fg]} / ${roles[bg]})`] : [];
  });
  // the filled button's text under the pointer: not a pair the built-in themes are held to, and one a derived theme keeps
  const pressed = contrast(roles["primary-text"]!, roles["primary-hover"]!);
  if (pressed < TEXT_FLOOR) under.push(`primary-text on primary-hover: ${pressed.toFixed(2)}:1 (${roles["primary-text"]} / ${roles["primary-hover"]})`);
  const row = contrast(roles["bg-hover"]!, roles["bg"]!);
  return row < TELLS ? [...under, `a row on the ground: ${row.toFixed(3)}:1 (${roles["bg-hover"]} / ${roles["bg"]})`] : under;
}

/** A seeded generator, so a failing palette can be found again. */
function palettes(count: number, seed: number, grey = false): Base16[] {
  let state = seed;
  const next = (): number => (state = (Math.imul(state, 1664525) + 1013904223) >>> 0) / 2 ** 32;
  const channel = (): string => Math.floor(next() * 256).toString(16).padStart(2, "0");
  const color = (): string => grey ? `#${channel().repeat(3)}` : `#${channel()}${channel()}${channel()}`;
  return Array.from({ length: count }, () => Object.fromEntries(BASE16_KEYS.map((key) => [key, color()])) as unknown as Base16);
}

const seeds = (colors: Partial<Base16>, rest = "#808080"): Base16 => Object.fromEntries(BASE16_KEYS.map((key) => [key, colors[key] ?? rest])) as unknown as Base16;

// a readable dark scheme and a readable light one, in the app's own amber colours
const DARK = seeds({
  base00: "#181613", base01: "#211e1a", base02: "#2a2621", base03: "#3e3830", base04: "#9b9183", base05: "#d8d0c3", base06: "#f2ebdf", base07: "#fff8ec",
  base08: "#ff7b70", base09: "#f0a830", base0A: "#e8c55c", base0B: "#93c36b", base0C: "#6cc5b0", base0D: "#6cb8d6", base0E: "#c39bd3", base0F: "#b07a4a",
});
const LIGHT = seeds({
  base00: "#faf8f3", base01: "#f2eee6", base02: "#e6dfd2", base03: "#b5ab9b", base04: "#685e52", base05: "#2a251f", base06: "#16120d", base07: "#000000",
  base08: "#a82323", base09: "#8c5000", base0A: "#7a5a00", base0B: "#2f6317", base0C: "#0f6b6f", base0D: "#155a72", base0E: "#8a3f7a", base0F: "#6b4a2a",
});

describe("deriveTheme", () => {
  test("any sixteen colours come out meeting every floor the built-in themes are held to, with a row that shows", () => {
    const failures: string[] = [];
    for (const [index, palette] of [...palettes(150, 12345), ...palettes(60, 777, true)].entries()) {
      const under = below(deriveTheme(palette));
      if (under.length > 0) failures.push(`palette ${index}: ${under.join("; ")} ${JSON.stringify(palette)}`);
    }
    expect(failures).toEqual([]);
  }, HEAVY);

  test("the hardest grounds still read: one colour for all sixteen, greys at the balance point, black and white", () => {
    for (const all of ["#808080", "#777777", "#000000", "#ffffff", "#ff0000", "#00ff00", "#0000ff", "#757575", "#767676", "#959595"]) {
      expect(below(deriveTheme(seeds({}, all))), all).toEqual([]);
    }
    // a surface on the other side of the text, a text at its floor on a ground with no room beyond it, and the pairs between
    const edges = ["#000000", "#ffffff", "#757575", "#202020", "#e8e8e8", "#ff0000"];
    for (const base00 of edges) for (const base01 of edges) for (const base02 of edges) for (const base05 of ["#757575", "#000000", "#ffffff", "#606060"]) {
      expect(below(deriveTheme(seeds({ base00, base01, base02, base05 }))), `${base00} ${base01} ${base02} ${base05}`).toEqual([]);
    }
  }, HEAVY);

  test("a scheme that already reads is drawn in its own colours", () => {
    const dark = deriveTheme(DARK);
    expect(dark.mode).toBe("dark");
    expect(dark.vars).toMatchObject({
      bg: DARK.base00, "bg-panel": DARK.base00, "bg-elevated": DARK.base01, "bg-input": DARK.base01, "bg-hover": DARK.base02,
      border: DARK.base02, "border-strong": DARK.base03, text: DARK.base05, "text-strong": DARK.base05, "text-dim": DARK.base04,
      accent: DARK.base0D, primary: DARK.base0D, notice: DARK.base0A,
      "status-working": DARK.base0D, "status-blocked": DARK.base08, "status-done": DARK.base0B,
      "syntax-keyword": DARK.base0E, "syntax-string": DARK.base0B, "syntax-number": DARK.base09, "syntax-type": DARK.base0A, "syntax-meta": DARK.base0C, "syntax-function": DARK.base0D,
      "term-bg": DARK.base00, "term-fg": DARK.base05, "term-cursor": DARK.base05, "term-selection": DARK.base02,
    });
    const light = deriveTheme(LIGHT);
    expect(light.mode).toBe("light");
    expect(light.vars).toMatchObject({ bg: LIGHT.base00, text: LIGHT.base05, "text-dim": LIGHT.base04, "bg-elevated": LIGHT.base01, "bg-hover": LIGHT.base02, "status-blocked": LIGHT.base08, "syntax-keyword": LIGHT.base0E });
    expect(below(dark)).toEqual([]);
    expect(below(light)).toEqual([]);
  });

  test("the side is what the colours are: light text on a darker ground is dark", () => {
    expect(deriveTheme(seeds({ base00: "#ffffff", base05: "#202020" })).mode).toBe("light");
    expect(deriveTheme(seeds({ base00: "#101010", base05: "#e0e0e0" })).mode).toBe("dark");
    // a text that has to cross its ground to be read is told by where it ends
    const crossed = deriveTheme(seeds({ base00: "#808080", base05: "#909090" }));
    expect(crossed.mode).toBe(contrast(crossed.vars.text, "#000000") < contrast(crossed.vars.text, "#ffffff") ? "light" : "dark");
  });

  test("names every role with a value the theme language reads, the state colours, and a light theme's ANSI colours", () => {
    for (const scheme of [DARK, LIGHT]) {
      const { mode, vars } = deriveTheme(scheme);
      const expected = [...Object.keys(ROLES), "notice-tint", ...INDICATOR_ROLES, ...(mode === "light" ? Object.values(LIGHT_ANSI_ROLES) : [])];
      expect(Object.keys(vars).sort()).toEqual([...expected].sort());
      for (const [role, value] of Object.entries(vars)) {
        const kind = (ROLES as Record<string, string>)[role] ?? "color";
        const parsed = parseThemeValue(`derived/${mode}`, role, value);
        expect(parsed.kind === kind || parsed.kind === "alias", `${role}: ${value}`).toBe(true);
      }
    }
  });

  test("a surface the text cannot be read on gives way, and the text keeps its colour", () => {
    // Base16 Solarized Dark: base02 is a mid tone the text does not read on
    const { vars } = deriveTheme(seeds({ base00: "#002b36", base01: "#073642", base02: "#586e75", base05: "#93a1a1" }));
    expect(vars.text).toBe("#93a1a1");
    expect(vars["bg-hover"]).not.toBe("#586e75");
    expect(contrast(vars.text, vars["bg-hover"])).toBeGreaterThanOrEqual(4.5);
    expect(contrast(vars["bg-hover"], vars.bg)).toBeGreaterThanOrEqual(TELLS);
    // the border is no surface: it keeps the scheme's colour
    expect(vars.border).toBe("#586e75");
  });

  test("the text takes a small step to keep the scheme's surfaces, as the built-in themes were repaired", () => {
    // Base16 Solarized Light: the text is just under 4.5:1 on the raised surface
    const { vars } = deriveTheme(seeds({ base00: "#fdf6e3", base01: "#eee8d5", base02: "#93a1a1", base05: "#586e75" }));
    expect(vars["bg-elevated"]).toBe("#eee8d5");
    expect(vars.text).not.toBe("#586e75");
    expect(contrast(vars.text, "#eee8d5")).toBeGreaterThanOrEqual(4.5);
    expect(contrast(vars.text, "#586e75")).toBeLessThan(1.15);
    // the mid tone it could only be read on as near-black gives way instead
    expect(vars["bg-hover"]).not.toBe("#93a1a1");
  });

  test("a row always shows: on a faint scheme, where the scheme gave it the ground's colour, and on a ground with no room", () => {
    // 2.6:1 as written: the text moves, and no surface ends on the ground
    const faint = deriveTheme(seeds({ base00: "#202020", base01: "#282828", base02: "#383838", base05: "#606060" }));
    expect(contrast(faint.vars["bg-hover"], "#202020")).toBeGreaterThanOrEqual(TELLS);
    expect(contrast(faint.vars["bg-elevated"], "#202020")).toBeGreaterThanOrEqual(TELLS);
    expect(faint.vars["term-selection"]).toBe(faint.vars["bg-hover"]);
    expect(below(faint)).toEqual([]);
    // a row the scheme gave the ground's own colour is told from it all the same; a raised surface it made flat stays flat
    const flat = deriveTheme(seeds({ base00: "#e8e8e8", base01: "#e8e8e8", base02: "#e8e8e8", base05: "#8a8a8a" }));
    expect(contrast(flat.vars["bg-hover"], flat.vars.bg)).toBeGreaterThanOrEqual(TELLS);
    expect(flat.vars["bg-elevated"]).toBe("#e8e8e8");
    expect(below(flat)).toEqual([]);
    // the ground is as dark as colours go and the text sat at its floor: the text moves off it, and the row lies between
    const pit = deriveTheme(seeds({ base00: "#000000", base01: "#000000", base02: "#ffffff", base05: "#757575" }));
    expect(pit.vars.text).not.toBe("#757575");
    expect(below(pit)).toEqual([]);
  });

  test("the filled button's text reads on its fill and on the fill under the pointer", () => {
    // 4.60:1 at rest and 3.45:1 under the pointer when the text was fitted to the resting fill alone
    const { vars } = deriveTheme(seeds({ base00: "#d419b4", base01: "#d419b4", base02: "#d419b4", base05: "#6bdb67", base0D: "#dfa7ef" }));
    expect(contrast(vars["primary-text"], vars.primary)).toBeGreaterThanOrEqual(TEXT_FLOOR);
    expect(contrast(vars["primary-text"], vars["primary-hover"])).toBeGreaterThanOrEqual(TEXT_FLOOR);
    expect(vars["primary-hover"]).not.toBe(vars.primary);
    // a readable scheme keeps the hover it had: a tenth of the way to the text
    expect(deriveTheme(DARK).vars["primary-hover"]).not.toBe(DARK.base0D);
    expect(contrast(deriveTheme(DARK).vars["primary-text"], deriveTheme(DARK).vars["primary-hover"])).toBeGreaterThanOrEqual(TEXT_FLOOR);
  });

  test("herdr's state colours are the stylesheet's, moved only where the theme's surfaces need it", () => {
    const blocks = parseThemeBlocks(readFileSync(new URL("../styles.css", import.meta.url), "utf8"));
    for (const mode of ["dark", "light"] as const) {
      for (const role of INDICATOR_ROLES) expect(INDICATORS[mode][role], `${mode} ${role}`).toBe(blocks[`amber/${mode}`]!.declared[`--${role}`]!);
    }
    // on Catppuccin Mocha's own ground they are drawn as written
    const mocha = deriveTheme(seeds({ base00: "#1e1e2e", base01: "#181825", base02: "#313244", base05: "#cdd6f4" }));
    expect(mocha.vars).toMatchObject({ "indicator-working": "#f9e2af", "indicator-blocked": "#f38ba8", "indicator-done": "#94e2d5", "indicator-idle": "#a6e3a1" });
    // on a pale ground the light ones are darkened until they show
    const pale = deriveTheme(seeds({ base00: "#c8c8c8", base01: "#d0d0d0", base02: "#b8b8b8", base05: "#101010" }));
    expect(pale.mode).toBe("light");
    for (const role of INDICATOR_ROLES) expect(contrast(pale.vars[role], "#c8c8c8"), role).toBeGreaterThanOrEqual(INDICATOR_FLOOR);
  });

  test("a colour under its floor keeps its hue and moves the least it can", () => {
    const moved = fit("#bf616a", [{ color: "#2e3440", floor: 4.5 }]);
    expect(contrast(moved, "#2e3440")).toBeGreaterThanOrEqual(4.5);
    expect(contrast(moved, "#2e3440")).toBeLessThan(4.9);
    // still a red: its red channel leads as before
    const [r, g, b] = [1, 3, 5].map((at) => parseInt(moved.slice(at, at + 2), 16));
    expect(r!).toBeGreaterThan(g!);
    expect(r!).toBeGreaterThan(b!);
    // a colour that reads is returned as it is
    expect(fit("#eceff4", [{ color: "#2e3440", floor: 4.5 }])).toBe("#eceff4");
  });

  test("is the same for the same seeds", () => {
    expect(deriveTheme(DARK)).toEqual(deriveTheme({ ...DARK }));
  });
});
