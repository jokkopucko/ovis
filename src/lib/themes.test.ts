import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { contrastRatio } from "./terminalFold.ts";
import { resolveEntry } from "./themeCss.ts";
import { DEFAULT_THEME, isThemeId, pickTheme, rowFor, SUPPORTED_ENTRIES, terminalColors, THEME_IDS, themeColor } from "./themes.ts";

describe("theme lookups", () => {
  it("knows the ids of the generated table and nothing else", () => {
    expect(THEME_IDS.every((id) => isThemeId(id))).toBe(true);
    expect([isThemeId("not-a-theme"), isThemeId(""), isThemeId(undefined), isThemeId(1)]).toEqual([false, false, false, false]);
  });

  it("draws a both-mode theme's row of each side", () => {
    for (const side of ["dark", "light"] as const) {
      const row = rowFor("charcoal", side);
      expect([row.id, row.mode]).toEqual(["charcoal", side]);
    }
  });

  it("falls back to the default theme of the same side for an unknown id", () => {
    for (const side of ["dark", "light"] as const) {
      expect(rowFor("not-a-theme", side)).toBe(rowFor(DEFAULT_THEME, side));
      expect(rowFor("not-a-theme", side).mode).toBe(side);
    }
  });

  it("reads theme-color and terminal colors from the row of the side", () => {
    for (const entry of SUPPORTED_ENTRIES) {
      expect(themeColor(entry.id, entry.mode)).toBe(entry.bgPanel);
      expect(terminalColors(entry.id, entry.mode)).toEqual(entry.terminal);
    }
    expect(themeColor("amber", "dark")).toBe("#181613");
    expect(terminalColors("catppuccin", "light").background).toBe("#eff1f5");
  });

  it("keeps Black identical to Tokyo Night except for its backgrounds, borders and alert outline", () => {
    const black = rowFor("black", "dark");
    const overrides = {
      "droplet-ring": "var(--border-strong)",
      bg: "#000000",
      "bg-panel": "#000000",
      "bg-elevated": "#0a0a0a",
      "bg-hover": "#161616",
      "bg-input": "#000000",
      "notice-tint": "#1b150c",
      border: "#59628c",
      "border-strong": "#5a638d",
      scrim: "rgba(0, 0, 0, 0.5)",
      "term-bg": "#000000",
    };
    const css = readFileSync(new URL("../styles.css", import.meta.url), "utf8");
    expect(resolveEntry(css, "black", "dark").declared)
      .toEqual({ ...resolveEntry(css, "tokyo-night", "dark").declared,
        ...Object.fromEntries(Object.entries(overrides).map(([role, value]) => [`--${role}`, value])) });
    expect(resolveEntry(css, "black", "dark").resolved["--droplet-ring"]).toBe("#5a638d");
    expect(terminalColors("black", "dark"))
      .toEqual({ ...terminalColors("tokyo-night", "dark"), background: "#000000" });
    expect(black.bgPanel).toBe("#000000");
    expect(rowFor("black", "light")).toBe(black);
    expect(pickTheme({ darkTheme: "tokyo-night", lightTheme: "tokyo-night-day" }, "dark", "black"))
      .toEqual({ darkTheme: "black" });
  });

  it("keeps Black's UI borders at 3:1 on each surface", () => {
    const css = readFileSync(new URL("../styles.css", import.meta.url), "utf8");
    const colors = resolveEntry(css, "black", "dark").resolved;
    for (const border of ["--border", "--border-strong"]) {
      for (const surface of ["--bg", "--bg-panel", "--bg-input", "--bg-elevated", "--bg-hover"]) {
        expect(contrastRatio(colors[border]!, colors[surface]!)!).toBeGreaterThanOrEqual(3);
      }
    }
  });
});

describe("picking a theme", () => {
  it("fills the other side with the sibling while that side is the default or the previous pick's sibling", () => {
    expect(pickTheme({ darkTheme: "amber", lightTheme: "amber" }, "dark", "tokyo-night")).toEqual({ darkTheme: "tokyo-night", lightTheme: "tokyo-night-day" });
    expect(pickTheme({ darkTheme: "codex", lightTheme: "codex" }, "dark", "tokyo-night")).toEqual({ darkTheme: "tokyo-night", lightTheme: "tokyo-night-day" });
    expect(pickTheme({ darkTheme: "codex", lightTheme: "amber" }, "light", "catppuccin-latte")).toEqual({ darkTheme: "catppuccin", lightTheme: "catppuccin-latte" });
    expect(pickTheme({ darkTheme: "tokyo-night", lightTheme: "tokyo-night-day" }, "dark", "gruvbox")).toEqual({ darkTheme: "gruvbox", lightTheme: "gruvbox-light" });
    expect(pickTheme({ darkTheme: "amber", lightTheme: "amber" }, "light", "catppuccin-latte")).toEqual({ darkTheme: "catppuccin", lightTheme: "catppuccin-latte" });
  });

  it("keeps a side the user chose, and fills nothing for a theme without a pair or picked for its own kind's other side", () => {
    expect(pickTheme({ darkTheme: "tokyo-night", lightTheme: "charcoal" }, "dark", "gruvbox")).toEqual({ darkTheme: "gruvbox" });
    expect(pickTheme({ darkTheme: "amber", lightTheme: "tokyo-night-day" }, "dark", "gruvbox")).toEqual({ darkTheme: "gruvbox" });
    expect(pickTheme({ darkTheme: "amber", lightTheme: "amber" }, "dark", "charcoal")).toEqual({ darkTheme: "charcoal" });
    expect(pickTheme({ darkTheme: "amber", lightTheme: "amber" }, "light", "tokyo-night")).toEqual({ lightTheme: "tokyo-night" });
  });
});
