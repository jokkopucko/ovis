/**
 * Copied text from an agent's pane, as one paragraph per paragraph (#2558). An agent on the
 * alternate screen (Claude Code, Codex) wraps its reply itself: it breaks a paragraph at the pane
 * width and starts each continuation row at its block's hanging indent, so those breaks are real
 * rows on the grid, and both xterm's selection and herdr's `pane.selection.read` return them with
 * the newline and the indent. herdr's own TUI copies the same rows as one line.
 *
 * The rows alone cannot tell a wrap from a line the agent ended there (two commands in a code
 * block, a path in tool output, a hard break in prose all look the same at a phone's width), so a
 * break is joined only when the agent's own text proves it was a wrap: the words on either side of
 * it stand in that text with a space between them (or none, for a word split at the edge, or
 * Chinese and Japanese text), never with a line break. On the grid it must also look like a wrap:
 * the row below starts at the row above's hanging indent (its indent plus a marker such as `⏺ `,
 * `- `, `1. `), the row above ends where the row below's first word could not have fit after it,
 * no box or table border meets the break, and the row above is no wider than the pane. A break the
 * text does not prove, tool output included (it is not the agent's text), is kept as it is.
 */
import { herdrWidthProvider } from "./terminalWidths.ts";

const MARKER = /^(?:[⏺●•◦▪*+-]|[⎿└]|\d{1,3}[.)])\s+/u;
const BOX = /[\u2500-\u257f|]/u;
/** words taken from each side of a break to find it in the agent's text */
const CONTEXT_WORDS = 3;

let widths: ReturnType<typeof herdrWidthProvider> | undefined;

/** The cells `text` takes on herdr's grid. */
function cells(text: string): number {
  widths ??= herdrWidthProvider();
  let count = 0;
  for (const char of text) count += widths.wcwidth(char.codePointAt(0)!);
  return count;
}

const leading = (text: string): number => text.length - text.trimStart().length;

/** Text as drawn and as written compare alike: no Markdown emphasis or code ticks, one space for a run, no indent after a line break. */
const plain = (text: string): string => text.replace(/[`*]/g, "").replace(/[ \t]+/g, " ").replace(/ ?\n */g, "\n");

/** How the agent's text joins `before` to `after`: with a space, with nothing, or unproven (absent, broken, or both ways). */
function joinIn(said: readonly string[], before: string, after: string): " " | "" | null {
  const has = (joint: string): boolean => said.some((text) => text.includes(before + joint + after));
  if (has("\n")) return null;
  const spaced = has(" ");
  const unspaced = has("");
  return spaced === unspaced ? null : spaced ? " " : "";
}

/**
 * `text` as selected from rows `cols` cells wide, its first row starting at cell `firstCol`, with
 * the wraps `said` (the agent's own replies) proves joined back into their lines and the
 * continuation indent dropped.
 */
export function unwrapAgentRows(text: string, cols: number, firstCol: number, said: readonly string[]): string {
  if (said.length === 0) return text;
  const written = said.map(plain);
  // xterm joins rows with \r\n on Windows
  const parts = text.split(/(\r?\n)/);
  let joined = parts[0]!;
  let row = joined;
  let rowStart = firstCol;
  // where the row above's continuation rows start: its indent plus its marker
  let hanging = rowStart + leading(row) + (MARKER.exec(row.trimStart())?.[0].length ?? 0);
  for (let i = 1; i < parts.length; i += 2) {
    const separator = parts[i]!;
    const next = parts[i + 1]!;
    const indent = leading(next);
    const rest = next.slice(indent);
    const above = row.trimEnd();
    const end = rowStart + cells(above);
    const words = plain(rest).split(" ");
    const wraps = indent > 0 && indent === hanging && rest !== "" && above.trim() !== ""
      && end <= cols && end + 1 + cells(words[0]!) > cols
      && !BOX.test(above.at(-1)!) && !BOX.test(rest[0]!);
    const before = plain(above.trimStart().replace(MARKER, "")).split(" ").slice(-CONTEXT_WORDS).join(" ");
    const joint = wraps ? joinIn(written, before, words.slice(0, CONTEXT_WORDS).join(" ")) : null;
    if (joint !== null) joined = joined.trimEnd() + joint + rest;
    else {
      joined += separator + next;
      hanging = indent + (MARKER.exec(rest)?.[0].length ?? 0);
    }
    row = next;
    rowStart = 0;
  }
  return joined;
}
