import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";

import { sanitizeFontFamily, TERMINAL_FONT_STACK } from "./fontFamily.ts";
import { UI_FONT_MAX, UI_FONT_MIN, UI_FONT_PRESETS, UI_FONT_PRESET_FAMILY, UI_FONT_STACK, fontScale, sanitizeUiFontSize, uiFontPreset, uiFontStack } from "./typography.ts";
import { CHAT_FONT_MAX, CHAT_FONT_MIN, DEFAULT_SETTINGS, SETTING_SCOPE, chatFontSize, fileFontSize, sanitizeSettings, uiFontSize } from "./settings.ts";

const styles = readFileSync(new URL("../styles.css", import.meta.url), "utf8");
const token = (name: string): string => new RegExp(`${name}:\\s*([^;]+);`).exec(styles)![1]!.trim();

describe("the built-in stacks", () => {
  it("draw the terminal and the chrome's code in the same bundled face", () => {
    expect(TERMINAL_FONT_STACK.startsWith('"Symbols Nerd Font Mono", "JetBrains Mono Web", ')).toBe(true);
    expect(token("--font-mono")).toContain('"JetBrains Mono Web"');
  });
});

describe("interface font", () => {
  it("copies --font-ui verbatim, since a chosen font is written as the token itself", () => {
    expect(UI_FONT_STACK).toBe(token("--font-ui"));
  });

  it("keeps the stylesheet's stack until a font is chosen", () => {
    expect(uiFontStack("")).toBeNull();
    expect(uiFontStack(" , ")).toBeNull();
    expect(uiFontStack(";{}")).toBeNull();
  });

  it("puts a typed list in front of the built-in stack, never in place of it", () => {
    expect(uiFontStack("Noto Sans JP, Segoe UI")).toBe(`"Noto Sans JP", "Segoe UI", ${UI_FONT_STACK}`);
    expect(uiFontStack("x; } body { color: red")).toBe(`"x body color: red", ${UI_FONT_STACK}`);
  });

  it("draws a preset without Pretendard behind it, so kana and kanji come from one family", () => {
    expect(uiFontStack(UI_FONT_PRESET_FAMILY.system)).toBe("system-ui, sans-serif");
    for (const language of ["en", "ko", "ja", "zh"] as const) {
      expect(uiFontStack(UI_FONT_PRESET_FAMILY.noto, language)).not.toContain("Pretendard");
      expect(uiFontStack(UI_FONT_PRESET_FAMILY.noto, language)!.endsWith(", sans-serif")).toBe(true);
    }
  });

  it("puts the UI language's Noto CJK family first", () => {
    expect(uiFontStack(UI_FONT_PRESET_FAMILY.noto, "ja")).toBe('"Noto Sans", "Noto Sans JP", "Noto Sans CJK JP", "Noto Sans KR", "Noto Sans CJK KR", "Noto Sans SC", "Noto Sans CJK SC", "Noto Sans TC", "Noto Sans CJK TC", sans-serif');
    expect(uiFontStack(UI_FONT_PRESET_FAMILY.noto, "ko")).toStartWith('"Noto Sans", "Noto Sans KR", "Noto Sans CJK KR", "Noto Sans JP", ');
    expect(uiFontStack(UI_FONT_PRESET_FAMILY.noto, "zh")).toStartWith('"Noto Sans", "Noto Sans SC", "Noto Sans CJK SC", "Noto Sans TC", ');
  });

  it("stores each preset in the form the sanitizer keeps, and reads it back as that preset", () => {
    for (const preset of UI_FONT_PRESETS) {
      expect(sanitizeFontFamily(UI_FONT_PRESET_FAMILY[preset])).toBe(UI_FONT_PRESET_FAMILY[preset]);
      expect(uiFontPreset(UI_FONT_PRESET_FAMILY[preset])).toBe(preset);
    }
    expect(uiFontPreset("")).toBe("default");
    expect(uiFontPreset(" system-ui ")).toBe("system");
    expect(uiFontPreset("Hiragino Sans")).toBe("custom");
  });
});

describe("interface font size", () => {
  it("is a whole px within the limits, or follows the density", () => {
    expect(sanitizeUiFontSize(15.6)).toBe(16);
    expect(sanitizeUiFontSize(99)).toBe(UI_FONT_MAX);
    expect(sanitizeUiFontSize(2)).toBe(UI_FONT_MIN);
    expect(sanitizeUiFontSize("18")).toBeNull();
    expect(sanitizeUiFontSize(Number.NaN)).toBeNull();
    expect(sanitizeUiFontSize(undefined)).toBeNull();
  });

  it("scales the type tokens by the chosen size over the density's", () => {
    expect(fontScale(14, 14)).toBe(1);
    expect(fontScale(21, 14)).toBe(1.5);
    expect(fontScale(13, 13)).toBe(1);
    expect(fontScale(0, 14)).toBe(1);
    expect(fontScale(14, Number.NaN)).toBe(1);
  });
});

describe("in Settings", () => {
  it("stays on this device, with nothing chosen by default", () => {
    expect(DEFAULT_SETTINGS.uiFontSize).toBeNull();
    expect(SETTING_SCOPE.uiFontSize).toBe("device");
    expect(DEFAULT_SETTINGS.uiFontFamily).toBe("");
    expect(SETTING_SCOPE.uiFontFamily).toBe("device");
  });

  it("keeps a stored interface font sanitized, and drops one that is not text", () => {
    expect(sanitizeSettings({ uiFontFamily: " Noto Sans JP ; , x" }).uiFontFamily).toBe('"Noto Sans JP", x');
    expect(sanitizeSettings({ uiFontFamily: 3 }).uiFontFamily).toBe("");
    expect(sanitizeSettings({}).uiFontFamily).toBe("");
  });

  it("keeps only a valid size from a stored record", () => {
    expect(sanitizeSettings({ uiFontSize: 17 }).uiFontSize).toBe(17);
    expect(sanitizeSettings({ uiFontSize: "17" }).uiFontSize).toBeNull();
  });

  it("gives the interface the density's body size until one is chosen, and the chat the interface's until it has its own", () => {
    expect(uiFontSize(DEFAULT_SETTINGS)).toBe(14);
    expect(uiFontSize(sanitizeSettings({ density: "compact" }))).toBe(13);
    expect(uiFontSize(sanitizeSettings({ density: "compact", uiFontSize: 16 }))).toBe(16);
    expect(chatFontSize(sanitizeSettings({ uiFontSize: 16 }))).toBe(16);
    expect(chatFontSize(sanitizeSettings({ uiFontSize: 16, chatFontSize: 12 }))).toBe(12);
  });

  it("gives a file's text the chat's size until it has its own, on this device", () => {
    expect(DEFAULT_SETTINGS.fileFontSize).toBeNull();
    expect(SETTING_SCOPE.fileFontSize).toBe("device");
    expect(fileFontSize(sanitizeSettings({ uiFontSize: 16 }))).toBe(16);
    expect(fileFontSize(sanitizeSettings({ uiFontSize: 16, chatFontSize: 12 }))).toBe(12);
    expect(fileFontSize(sanitizeSettings({ chatFontSize: 12, fileFontSize: 19 }))).toBe(19);
    expect(sanitizeSettings({ fileFontSize: 99 }).fileFontSize).toBe(CHAT_FONT_MAX);
    expect(sanitizeSettings({ fileFontSize: 2 }).fileFontSize).toBe(CHAT_FONT_MIN);
    expect(sanitizeSettings({ fileFontSize: 15.6 }).fileFontSize).toBe(16);
    expect(sanitizeSettings({ fileFontSize: "18" }).fileFontSize).toBeNull();
  });
});
