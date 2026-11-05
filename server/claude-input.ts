import type { InteractivePrompt } from "../shared/protocol.ts";
import { ANSI_RE, SOLID_RULE_RE, normalizeText, parsedByPublicPrompt } from "./dialogs/shared.ts";
import { claudeRewindPanelBelow } from "./dialogs/claude.ts";
import { paneRead } from "./herdr/client.ts";

/** how long a prompt poll waits for the ANSI read behind Claude's suggestion before going without it */
export const SUGGESTION_READ_MS = 1_500;

/** Claude's new-session tip in the empty input (`Try "how does <filepath> work?"`), not a suggestion. */
const CLAUDE_TIP_RE = /^Try "/;

/**
 * Claude Code's IDE pill, drawn right after the `❯` while an editor is connected: `[⧉ 3 lines
 * selected] ` or `[⧉ In src/foo.ts] ` (Claude Code 2.1.302 matches it as `\[⧉ [^\]\n]+\]`). It is
 * painted in the theme's IDE color, not dim, yet it is no input: typing and Ctrl+K/Ctrl+U leave it.
 */
const CLAUDE_IDE_PILL_RE = /^[ \u00a0]?\[⧉ [^\]\n]+\] ?/;

/** The text after the `❯` of an input row with Claude's IDE pill (CLAUDE_IDE_PILL_RE) taken out. */
const withoutIdePill = (afterPrompt: string): string => afterPrompt.replace(CLAUDE_IDE_PILL_RE, " ");

/**
 * How many characters after the `❯` of a plain input row Claude's IDE pill takes, with the space
 * before it: what a walk over that row skips. 0 without a pill.
 */
function idePillChars(afterPrompt: string): number {
  const match = CLAUDE_IDE_PILL_RE.exec(afterPrompt);
  return match === null ? 0 : Array.from(match[0]).length;
}

/**
 * Whether each character of an ANSI line is drawn dim (SGR 2) and inverse (SGR 7), as
 * [text, dim, inverse] runs. Only SGR sequences change the state; 38/48 colors are skipped whole,
 * so the 2 of `38;2;r;g;b` is a color mode, not dim. Other escapes are dropped.
 */
function sgrRuns(line: string): [string, boolean, boolean][] {
  const runs: [string, boolean, boolean][] = [];
  let dim = false;
  let inverse = false;
  let offset = 0;
  const escape = /\u001b(?:\[([0-?]*)[ -/]*([@-~])|\][^\u0007\u001b]*(?:\u0007|\u001b\\)|[@-Z\\-_])/g;
  for (const match of line.matchAll(escape)) {
    if (match.index! > offset) runs.push([line.slice(offset, match.index), dim, inverse]);
    offset = match.index! + match[0].length;
    if (match[2] !== "m") continue;
    const codes = (match[1] || "0").split(";").map((code) => Number(code || 0));
    for (let index = 0; index < codes.length; index++) {
      const code = codes[index]!;
      if (code === 38 || code === 48 || code === 58) index += codes[index + 1] === 5 ? 2 : codes[index + 1] === 2 ? 4 : 0;
      else if (code === 0) { dim = false; inverse = false; }
      else if (code === 22) dim = false;
      else if (code === 2) dim = true;
      else if (code === 27) inverse = false;
      else if (code === 7) inverse = true;
    }
  }
  if (offset < line.length) runs.push([line.slice(offset), dim, inverse]);
  return runs;
}

/**
 * The prompt Claude Code suggests next, grey in its empty input box: the `❯` line between the
 * screen's last two rules (the live input box, not an earlier one above a bash-mode input), all
 * of it dim but for Claude's own drawn cursor on its first character. None while anything is
 * typed there (typed text is not dim), for the new-session tip, or for an input box of more than
 * one line.
 */
export function parseClaudeSuggestion(ansi: string): string | null {
  const grey = claudeGreyInput(ansi);
  return grey === null || CLAUDE_TIP_RE.test(grey) ? null : grey;
}

/**
 * What Claude Code's input box shows in grey while it is empty (a suggested prompt, or the
 * new-session tip), null when the box holds typed text or nothing. Only an ANSI read tells grey
 * text from a message: as plain text both are `❯ words`.
 */
function claudeGreyInput(ansi: string): string | null {
  const lines = ansi.split("\n").map((line) => line.replace(/\r$/, ""));
  const plain = lines.map((line) => line.replace(ANSI_RE, "").replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, ""));
  let index = plain.length - 1;
  while (index >= 0 && !SOLID_RULE_RE.test(plain[index]!.trim())) index--;
  index--;
  if (index < 1 || !/^❯[\s\u00a0]/.test(plain[index]!) || !SOLID_RULE_RE.test(plain[index - 1]!.trim())) return null;
  let text = "";
  let seenPrompt = false;
  let cursor = false;
  // Claude's IDE pill before the grey text is neither typed nor suggested
  let pill = idePillChars(plain[index]!.slice(plain[index]!.indexOf("❯") + 1));
  for (const [run, dim, inverse] of sgrRuns(lines[index]!)) {
    for (const character of run) {
      if (!seenPrompt) { if (character === "❯") seenPrompt = true; continue; }
      if (pill > 0) { pill--; continue; }
      const blank = character.trim() === "" || character === "\u00a0";
      // the cursor Claude draws itself sits inverse on the first grey character
      if (!dim && !blank && !(inverse && text.trim() === "" && !cursor)) return null;
      if (!dim && !blank) cursor = true;
      text += character;
    }
  }
  // a cursor over typed text has nothing grey after it
  if (cursor && !sgrRuns(lines[index]!).some(([run, dim]) => dim && run.trim() !== "")) return null;
  const suggestion = text.replace(/\u00a0/g, " ").trim();
  return suggestion === "" ? null : suggestion;
}

/**
 * A labeled rule over an input box: Claude's named session (`──── my-session ─`), and OmO's own
 * box while it works (`── • Running eval (7s • esc to interrupt) ───`), which herdr reports as
 * Claude. Only the box reader takes the shorter lead; the task panel keeps LABELED_RULE_RE.
 */
const BOX_LABELED_RULE_RE = /^─{2,}\s.*─$/;

/**
 * Claude Code's input box: the rows between the screen's last two rules (a named session labels
 * its rule). "clipped" when only the bottom rule is on screen, as under a draft taller than the
 * pane; null when the screen has no rule at all.
 */
function claudeInputBox(screen: string): { plain: string[]; raw: string[] } | "clipped" | null {
  const raw = screen.split("\n").map((line) => line.replace(/\r$/, ""));
  const plain = raw.map((line) => line.replace(ANSI_RE, "").replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, "").trimEnd());
  const rule = (line: string): boolean => SOLID_RULE_RE.test(line.trim()) || BOX_LABELED_RULE_RE.test(line.trim());
  let end = plain.length - 1;
  while (end >= 0 && !rule(plain[end]!)) end--;
  if (end < 0) return null;
  let start = end - 1;
  while (start >= 0 && !rule(plain[start]!)) start--;
  if (start < 0) return "clipped";
  return { plain: plain.slice(start + 1, end), raw: raw.slice(start + 1, end) };
}

/** Claude's new-session tip as a whole input row: `Try "how does <filepath> work?"`. */
const CLAUDE_TIP_ROW_RE = /^Try "[^"]+"$/;

/** Whether an ANSI read sets no color and no dim anywhere, as Claude Code draws under NO_COLOR. */
function colorless(ansi: string): boolean {
  for (const match of ansi.matchAll(/\u001b\[([0-9;:]*)m/g)) {
    for (const code of (match[1] || "0").split(/[;:]/).map((value) => Number(value || 0))) {
      if (code === 2 || (code >= 30 && code <= 38) || (code >= 40 && code <= 48) || (code >= 90 && code <= 97) || (code >= 100 && code <= 107)) return false;
    }
  }
  return true;
}

/**
 * Whether Claude Code's input box is not known to be empty, so that a paste would land in what is
 * there and the Enter after it send both, or run it as a command: typed text, bash mode (`!`), a
 * box clipped by the pane, or a box that is not a `❯` input. Claude's own grey text (a suggested
 * prompt, its tip, on any number of rows) and its drawn cursor are not a draft. The box is read
 * from the live screen (`live`, a detection read, as the other pending checks); only the viewport
 * read carries colors (`colors`), and the caller passes it only once it is verified to show that
 * live screen (null otherwise): equal words do not prove it, since an older box in a scrolled
 * viewport, or a grey suggestion the user then typed out, reads the same. Without verified colors a
 * box that is not empty is a draft. False when the screen shows no rule at all.
 */
export function claudeInputDraft(live: string, colors: string | null): boolean {
  const box = claudeInputBox(live);
  if (box === null) return false;
  if (box === "clipped" || !box.plain[0]?.startsWith("❯")) return true;
  // Claude's IDE pill after the `❯` is no input (#1096): a box holding only it is empty
  const afterPill = withoutIdePill(box.plain[0]!.slice(1));
  if ([afterPill, ...box.plain.slice(1)].join("\n").replace(/\u00a0/g, " ").trim() === "") return false;
  // a paste or an image Claude folded into a placeholder is content, however it is colored
  if (/\[(?:Pasted text #\d+|Image #\d+)/.test(box.plain.join(" "))) return true;
  if (colors === null) return true;
  const shown = claudeInputBox(colors);
  if (shown === null || shown === "clipped" || shown.plain.join("\n") !== box.plain.join("\n")) return true;
  // Under NO_COLOR (#926) the tip is not dim: only its exact form as the box's whole one row, on a
  // screen drawn without any color, tells it from typed words. Typed `Try "…"` reads the same there.
  if (box.plain.length === 1 && CLAUDE_TIP_ROW_RE.test(afterPill.replace(/\u00a0/g, " ").trim()) && colorless(colors)) return false;
  let prompt = false;
  let pill = idePillChars(box.plain[0]!.slice(1));
  let first = true;
  let cursor = false;
  let grey = false;
  for (const row of shown.raw) {
    for (const [run, dim, inverse] of sgrRuns(row)) {
      for (const character of run) {
        if (!prompt) { prompt = character === "❯"; continue; }
        if (pill > 0) { pill--; continue; }
        if (character.trim() === "" || character === "\u00a0") continue;
        if (dim) grey = true;
        // the cursor Claude draws itself sits inverse on the first grey character
        else if (first && inverse) cursor = true;
        else return true;
        first = false;
      }
    }
  }
  // a cursor over a typed character has nothing grey after it
  return cursor && !grey;
}

/** Positive proof of an ordinary empty input box, never absence of a readable box. */
export function claudeInputEmpty(live: string, colors: string | null): boolean {
  const box = claudeInputBox(live);
  return box !== null && box !== "clipped" && box.plain[0]?.startsWith("❯") === true
    && !claudeInputDraft(live, colors);
}

/** What empties a one-row Claude input box: the row after the cursor, then before it (measured on 2.1.295; Ctrl+Y puts it back). */
export const CLAUDE_CLEAR_INPUT_KEYS = ["ctrl+k", "ctrl+u"];

/**
 * The draft the chat may offer to clear before it sends (claudeInputDraft with the same reads):
 * typed text on the only row of a `❯` box, read with verified colors, as the user sees it there.
 * CLAUDE_CLEAR_INPUT_KEYS edit one screen row, so a draft on more rows (a long line wraps), bash
 * mode, a pasted or image placeholder and a box read without colors are not offered: null.
 */
export function claudeClearableDraft(live: string, colors: string | null): string | null {
  if (colors === null || !claudeInputDraft(live, colors)) return null;
  const box = claudeInputBox(live);
  if (box === null || box === "clipped" || box.plain.length !== 1 || !box.plain[0]!.startsWith("❯")) return null;
  if (/\[(?:Pasted text #\d+|Image #\d+)/.test(box.plain[0]!)) return null;
  // plain rows trim their right edge for screen parsing. Match the raw row instead: a
  // trailing space, or another space after Claude's one separator, belongs to the user.
  const rowText = (row: string): string => row.replace(ANSI_RE, "").replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, "");
  const row = rowText(box.raw[0]!);
  const shown = claudeInputBox(colors);
  if (shown === null || shown === "clipped" || shown.raw.length !== 1 || rowText(shown.raw[0]!) !== row) return null;
  // Claude's IDE pill is not the user's text, and the clearing keys leave it
  const afterPrompt = row.slice(1);
  const pill = CLAUDE_IDE_PILL_RE.exec(afterPrompt)?.[0];
  const draft = pill === undefined ? afterPrompt.replace(/^[ \u00a0]/, "") : afterPrompt.slice(pill.length);
  return draft.trim() === "" ? null : draft;
}

/** How much of the box an input_draft refusal shows: enough to tell a draft from Claude's own text. */
export const INPUT_BOX_SHOWN_CHARS = 200;

/**
 * The live input box (claudeInputBox) as plain text, whole: what a refusal that names no clearable
 * draft records, so a send anyway goes only over exactly that box. null when no box could be read
 * whole (none on screen, or clipped by the pane): such a box cannot be compared, so nothing is sent over it.
 */
export function claudeInputBoxContent(live: string): string | null {
  const box = claudeInputBox(live);
  if (box === null || box === "clipped") return null;
  return box.plain.map((row) => row.replace(/\u00a0/g, " ").trimEnd()).join("\n").trim();
}

/**
 * Whether Claude Code's rewind dialog is open: the screen ends in its panel and Claude's own input box
 * is not drawn under it (the dialog takes its place in every recorded state). A reply that draws the
 * panel has the box under it, and must not hold the pane's sends; rules above the panel (an earlier
 * reply's) are no box.
 */
export function claudeRewindOpen(screen: string): boolean {
  const below = claudeRewindPanelBelow(screen);
  return below !== null && claudeInputBoxContent(below) === null;
}

/** What the user is shown of a box's content: enough to tell a real draft from a box misread. */
export function shownInputBox(content: string): string {
  return content.length > INPUT_BOX_SHOWN_CHARS ? `${content.slice(0, INPUT_BOX_SHOWN_CHARS)}…` : content;
}

/** The live input box as a refusal shows it (claudeInputBoxContent, cut by shownInputBox). */
export function claudeInputBoxText(live: string): string {
  return shownInputBox(claudeInputBoxContent(live) ?? "");
}

/**
 * The chat's own last message back in Claude Code's input box as typed text, where Claude puts it
 * when the send right before is cancelled: `sent` when the box is a draft (`claudeInputDraft`, so
 * typed text on a verified viewport) holding exactly it — the `❯` of the first row dropped, the
 * wrapped rows joined with nothing (a split word) or one space (a wrap between words), each row's
 * own spaces as they are (U+00A0 read as a space). Anything else a
 * draft could be — bash mode, a clipped box, a `[Pasted text #`/`[Image #` placeholder, other or
 * edited words — and a box that is no known draft, unverified colors or nothing sent answer null.
 */
export function claudeRestoredDraft(live: string, colors: string | null, sent: string | null): string | null {
  if (sent === null || sent.trim() === "" || colors === null || !claudeInputDraft(live, colors)) return null;
  const box = claudeInputBox(live);
  if (box === null || box === "clipped" || !box.plain[0]?.startsWith("❯")) return null;
  if (/\[(?:Pasted text #\d+|Image #\d+)/.test(box.plain.join(" "))) return null;
  // each row's own words exactly (the box's U+00A0 as a space), its marker, indentation and padding
  // aside; where the terminal wrapped, a word split in two joins with nothing between, and a wrap
  // between words with one space or line break. Any other change to the spaces is the user's edit.
  const rows = box.plain.map((row, index) => (index === 0 ? withoutIdePill(row.slice(1)) : row).replace(/\u00a0/g, " ").trim());
  // walked row by row over the set of places the sent text can be at, never a regex: one built from
  // the rows backtracks exponentially over a box of blank rows
  const text = sent.replace(/\u00a0/g, " ").trim();
  let at = new Set([0]);
  rows.forEach((row, index) => {
    const next = new Set<number>();
    for (const from of at) {
      // a wrap between words leaves one space or line break before the next row; within a word, none
      const starts = index === 0 ? [from] : /\s/.test(text[from] ?? "") ? [from, from + 1] : [from];
      for (const start of starts) if (text.startsWith(row, start)) next.add(start + row.length);
    }
    at = next;
  });
  return at.has(text.length) ? sent : null;
}

/**
 * Whether a colored viewport read shows the live screen, so claudeInputDraft may take its colors:
 * the viewport at the bottom of the pane's history before and after the colored read, or, only when
 * herdr reports no scroll for either read, the viewport's whole text equal to the live screen; and
 * the live screen the same before and after it. A scroll known for one read and not the other is
 * no proof.
 */
export function viewportShowsLive(scrollBefore: { offset_from_bottom: number } | null, scrollAfter: { offset_from_bottom: number } | null,
  colors: string, before: string, live: string): boolean {
  const atBottom = scrollBefore !== null && scrollAfter !== null
    ? scrollBefore.offset_from_bottom === 0 && scrollAfter.offset_from_bottom === 0
    : scrollBefore === null && scrollAfter === null && screenLines(colors) === screenLines(live);
  return atBottom && live === before;
}

/** A screen read's rows as plain text, each row's and the screen's right edge trimmed. */
const screenLines = (text: string): string => text.replace(ANSI_RE, "").replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, "")
  .split(/\r?\n/).map((line) => line.trimEnd()).join("\n").trimEnd();

/**
 * Whether a colored read of the history's last rows (`recent`, as many as the viewport has) shows
 * the live screen, so claudeInputDraft may take its colors while the viewport is scrolled into the
 * history: herdr's history ends with the live screen whatever the viewport shows, so only a redraw
 * between the reads can tell them apart. Its text equal to the live screen, every live read taken
 * before and between the colored ones (`lives`) the same, and a second colored read, the last of all,
 * identical to the first, colors included, rule one out: a suggestion accepted with Tab keeps its words
 * and changes only its colors.
 */
export function historyEndShowsLive(colors: string, colorsAfter: string, lives: readonly string[]): boolean {
  // a read without any color (NO_COLOR, a monochrome terminal) cannot tell Claude's tip from the same
  // words typed: a scrolled box keeps refusing as a draft, as it did before it was read from the history
  return colors === colorsAfter && !colorless(colors) && lives.length > 0 && lives.every((live) => live === lives[0])
    && screenLines(colors) === screenLines(lives[0]!);
}

/** Whether a card is the one for a message Claude Code holds back (parseClaudeHeld). */
export function isClaudeHeld(prompt: InteractivePrompt): boolean {
  return parsedByPublicPrompt.get(prompt)?.responder === "claude-held";
}

/**
 * Whether a held-message card was read off Claude's own grey text. Claude's hint outlasts the
 * message for a moment (sent or cleared in the terminal), over a box that is empty again and shows
 * its tip or a suggested prompt: Enter there sends Claude's suggestion and Ctrl+C asks to leave
 * Claude. A read that fails or shows no box says nothing, and the card stays.
 * herdr gives colors for the viewport alone (an ANSI read of "detection", the live screen the card
 * is read from, carries no escapes: measured on 0.9.3), and a viewport scrolled into the history
 * can show an older box. So the grey text counts only when it is the very text the card took for
 * the message.
 */
export async function claudeHeldIsGrey(paneId: string, prompt: InteractivePrompt): Promise<boolean> {
  if (!isClaudeHeld(prompt)) return false;
  const same = (text: string | null): boolean => text !== null && normalizeText(text) === normalizeText(prompt.body ?? "");
  return paneRead({ paneId, source: "visible", format: "ansi", timeoutMs: SUGGESTION_READ_MS })
    .then((read) => same(claudeGreyInput(read.text)), () => false);
}
