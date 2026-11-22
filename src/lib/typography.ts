
import { sanitizeFontFamily } from "./fontFamily.ts";
import type { Language } from "./i18n.ts";

/**
 * The built-in interface stack: `--font-ui` in src/styles.css, verbatim (typography.test.ts holds
 * the two equal). A copy, because a chosen font is written as `--font-ui` itself, and a token
 * cannot fall back to its own stylesheet value.
 */
export const UI_FONT_STACK = '"Pretendard Variable", Pretendard, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Noto Sans KR", "Malgun Gothic", sans-serif';

export const UI_FONT_PRESETS = ["default", "system", "noto"] as const;
export type UiFontPreset = (typeof UI_FONT_PRESETS)[number];

export const UI_FONT_PRESET_FAMILY: Record<UiFontPreset, string> = {
  default: "",
  system: "system-ui",
  noto: '"Noto Sans"',
};

// Noto's CJK families, the UI language's first: the four draw the same Han characters in
// different shapes, and the first one installed draws them all. Each region comes under both of
// its names (the per-language family and the CJK collection's) before the next region
const NOTO_CJK_ORDER: Record<Language, readonly string[]> = {
  en: ["JP", "KR", "SC", "TC"],
  ja: ["JP", "KR", "SC", "TC"],
  ko: ["KR", "JP", "SC", "TC"],
  zh: ["SC", "TC", "JP", "KR"],
};

export function uiFontPreset(family: string): UiFontPreset | "custom" {
  const chosen = sanitizeFontFamily(family);
  return UI_FONT_PRESETS.find((preset) => UI_FONT_PRESET_FAMILY[preset] === chosen) ?? "custom";
}

/**
 * A preset is a whole stack with no Pretendard behind it: a browser takes each character from the
 * first family in the list that has it, so with Pretendard there the kana would still be
 * Pretendard's and the kanji another font's.
 */
export function uiFontStack(family: string, language: Language = "en"): string | null {
  const chosen = sanitizeFontFamily(family);
  if (chosen === "") return null;
  if (chosen === UI_FONT_PRESET_FAMILY.system) return "system-ui, sans-serif";
  if (chosen === UI_FONT_PRESET_FAMILY.noto) {
    const regions = NOTO_CJK_ORDER[language];
    return [chosen, ...regions.flatMap((region) => [`"Noto Sans ${region}"`, `"Noto Sans CJK ${region}"`]), "sans-serif"].join(", ");
  }
  return `${chosen}, ${UI_FONT_STACK}`;
}

/** The interface's body size (`--fs-md`) in px: the chat's range, less the sizes a 32px control cannot hold. */
export const UI_FONT_MIN = 11;
export const UI_FONT_MAX = 20;

export function sanitizeUiFontSize(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.min(UI_FONT_MAX, Math.max(UI_FONT_MIN, Math.round(value)));
}

export function fontScale(sizePx: number, basePx: number): number {
  if (!(sizePx > 0) || !(basePx > 0)) return 1;
  return sizePx / basePx;
}
