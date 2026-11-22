import { SOURCE_PREVIEW_BYTES, SOURCE_PREVIEW_LINES, TEXT_PREVIEW_BYTES } from "./filePreviewText.ts";
import { countLines } from "./highlight.ts";
import { hasPreview } from "./textPreview.ts";

export const VIRTUAL_SOURCE_LINES = 2_000;

/**
 * A virtualized source is colored only up to these (characters, so a budget the text itself can be
 * measured against; lines). The virtualizer's highlighter colors the whole file in its worker and
 * keeps the result on the page: 8 MiB of JavaScript measured 55 s of worker time and 192 MB of
 * heap, so past these the rows are plain text, with the notice the header shows for code too long
 * to color.
 */
export const VIRTUAL_HIGHLIGHT_CHARS = 256 * 1024;
export const VIRTUAL_HIGHLIGHT_LINES = 5_000;

export type SourceLayout = "elements" | "virtual";

export function sourceLayout(lines: number): SourceLayout {
  return lines > VIRTUAL_SOURCE_LINES ? "virtual" : "elements";
}

export function virtualHighlightable(chars: number, lines: number): boolean {
  return chars <= VIRTUAL_HIGHLIGHT_CHARS && lines <= VIRTUAL_HIGHLIGHT_LINES;
}

export interface ReadBudget {
  bytes: number;
  lines: number;
  timeoutMs: number;
}

export function readBudget(language: string | null, size: number): ReadBudget {
  if (hasPreview(language) || size <= TEXT_PREVIEW_BYTES) return { bytes: TEXT_PREVIEW_BYTES, lines: SOURCE_PREVIEW_LINES, timeoutMs: 5_000 };
  return { bytes: SOURCE_PREVIEW_BYTES, lines: SOURCE_PREVIEW_LINES, timeoutMs: 30_000 };
}

export function shownSource(text: string, truncated: boolean): string {
  return truncated && text.endsWith("\n") ? text.slice(0, -1) : text;
}

export type LineRequest =
  | { readonly kind: "shown"; readonly line: number }
  | { readonly kind: "past-preview"; readonly line: number }
  | { readonly kind: "past-end"; readonly line: number; readonly lines: number };

export function lineRequest(line: number | null, source: string, truncated: boolean, loadedLines?: number): LineRequest | null {
  if (line === null) return null;
  const lines = truncated && loadedLines !== undefined ? loadedLines : countLines(source);
  if (line <= lines) return { kind: "shown", line };
  return truncated ? { kind: "past-preview", line } : { kind: "past-end", line, lines };
}
