import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { comboKey, LEGACY_COMBOS, legacyCascade } from "../../scripts/theme-baseline.ts";
import { terminalTheme, themeColor } from "./settings.ts";
import baseline from "./themes.legacy-baseline.json";
import { resolveEntry } from "./themeCss.ts";

// The permanent parity oracle (#1121): amber, charcoal and catppuccin in dark and light look as they
// did at baseline.source.commit, frozen before the theme table refactor. The json is never
// regenerated; a new theme adds its own checks, never an edit here.
const frozen: Record<string, { declared: Record<string, string>; resolved: Record<string, string>; terminal: ReturnType<typeof terminalTheme>; themeColor: string }> = baseline.combos;
const css = readFileSync(join(import.meta.dir, "..", "styles.css"), "utf8");

function drift(kind: "declared" | "resolved"): string[] {
  return LEGACY_COMBOS.flatMap(({ palette, mode }) => {
    const key = comboKey(palette, mode);
    const now = legacyCascade(css, palette, mode)[kind];
    return Object.entries(frozen[key]![kind]).filter(([name, value]) => now[name] !== value).map(([name, value]) => `${key} ${name}: ${value} -> ${now[name] ?? "(not declared)"}`);
  });
}

describe("legacy palette parity", () => {
  it("resolves the canonical Latte id to the unchanged legacy Catppuccin light row", () => {
    const latte = resolveEntry(css, "catppuccin-latte", "light").resolved;
    expect(latte).toEqual(resolveEntry(css, "catppuccin", "light").resolved);
    expect(latte).toMatchObject(frozen["catppuccin/light"]!.resolved);
  });

  it("freezes exactly the six legacy combos", () => {
    expect(Object.keys(frozen).sort()).toEqual(LEGACY_COMBOS.map(({ palette, mode }) => comboKey(palette, mode)).sort());
  });

  it("declared: every legacy combo's winning declaration is unchanged", () => {
    expect(drift("declared")).toEqual([]);
  });

  it("resolved: every legacy combo's used color is unchanged", () => {
    expect(drift("resolved")).toEqual([]);
  });

  it("terminal and theme-color: xterm and the <meta> color of every legacy combo are unchanged", () => {
    for (const { palette, mode } of LEGACY_COMBOS) {
      const key = comboKey(palette, mode);
      expect({ key, terminal: terminalTheme(mode, palette), themeColor: themeColor(mode, palette) }).toMatchObject({ key, terminal: frozen[key]!.terminal, themeColor: frozen[key]!.themeColor });
    }
  });
});
