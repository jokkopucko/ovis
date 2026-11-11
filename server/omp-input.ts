import { ompComposerPromptRow } from "./dialogs/omp.ts";

/**
 * One character of a screen row as herdr's ANSI read draws it: its foreground (null for the terminal's own,
 * `38;2;r;g;b` or `38;5;n` for an extended one, the code for one of the 16 named ones), and whether it is dim,
 * inverse and blinking.
 */
interface Cell { char: string; fg: string | null; dim: boolean; inverse: boolean; blink: boolean }

/**
 * A row's characters with the attributes they are drawn in. Only SGR changes them; other escapes are dropped.
 * An extended color is read in both forms: `38;2;r;g;b` and `38;5;n` take the parameters after it, `38:2::r:g:b`
 * (its color space slot optional) and `38:5:n` carry theirs as subparameters, so no channel is read as a code.
 */
function rowCells(row: string): Cell[] {
  const cells: Cell[] = [];
  let fg: string | null = null;
  let dim = false;
  let inverse = false;
  let blink = false;
  let offset = 0;
  const add = (text: string): void => { for (const char of text) cells.push({ char, fg, dim, inverse, blink }); };
  const escape = /\u001b(?:\[([0-?]*)[ -/]*([@-~])|\][^\u0007\u001b]*(?:\u0007|\u001b\\)|[@-Z\\-_])/g;
  for (const match of row.matchAll(escape)) {
    if (match.index > offset) add(row.slice(offset, match.index));
    offset = match.index + match[0].length;
    if (match[2] !== "m") continue;
    const params = (match[1] || "0").split(";");
    for (let index = 0; index < params.length; index++) {
      const sub = params[index]!.split(":").map((value) => value === "" ? null : Number(value));
      const code = sub[0] ?? 0;
      if (code === 38 || code === 48 || code === 58) {
        let color: (number | null)[];
        if (sub.length > 1) {
          // colon form: 2 then an optional color space before the three channels, or 5 then the index
          color = sub[1] === 2 ? [2, ...sub.slice(sub.length >= 6 ? 3 : 2, sub.length >= 6 ? 6 : 5)] : sub.slice(1, 3);
        } else {
          const kind = Number(params[index + 1] || 0);
          const take = kind === 2 ? 4 : kind === 5 ? 2 : 0;
          color = params.slice(index + 1, index + 1 + take).map(Number);
          index += take;
        }
        if (code === 38) fg = color.length === 4 || (color.length === 2 && color[0] === 5) ? `38;${color.join(";")}` : null;
      } else if (code === 0) { fg = null; dim = false; inverse = false; blink = false; }
      else if (code === 39) fg = null;
      else if ((code >= 30 && code <= 37) || (code >= 90 && code <= 97)) fg = String(code);
      else if (code === 2) dim = true;
      else if (code === 22) dim = false;
      else if (code === 5 || code === 6) blink = true;
      else if (code === 25) blink = false;
      else if (code === 7) inverse = true;
      else if (code === 27) inverse = false;
    }
  }
  if (offset < row.length) add(row.slice(offset));
  return cells;
}

/** gjc paints typed text in the terminal's own color: any other color, or dim, is its ghost text (or its placeholder). */
const gjcGhostDrawn = (cell: Cell): boolean => cell.fg !== null || cell.dim;

/**
 * The `dim` colors of omp's built-in themes (omp 18.18, pi-tui `theme/defaults.json`, `dark.json` and `light.json`),
 * the color omp paints its prediction in, as truecolor and as the 256-color cell omp picks for each without
 * truecolor (`Bun.color(hex, "ansi-256")`, as its `colorToAnsi`). omp paints typed text in the theme's `text` color,
 * which for most themes is the contrast-safe fallback of pi-tui's `Theme.fgResolved` (#e5e5e7 over a dark background,
 * #000000 over a light one), and a skill or a keyword in its `accent` or `customMessageLabel`: a color any built-in
 * theme uses for those is left out (2 truecolor, 14 256-color), as the theme on screen is not known. A custom theme's
 * prediction is offered only when it is drawn in one of these.
 */
const OMP_DIM_TRUECOLOR = new Set([
  "434c5e", "44475a", "4a0e5f", "4a433d", "4a4642", "4a4a55", "4c566a", "51597d", "544840", "546e7a", "556b5f",
  "5a5a5a", "5a7b99", "5c2c6d", "5c5e60", "5c6370", "5e508d", "5f6673", "606060", "607d8b", "617289", "6272a4",
  "657289", "657b83", "664400", "66574f", "66627b", "666666", "666b73", "667381", "667a71", "67616c", "676c78",
  "67726b", "6a5a78", "6a6378", "6a6760", "6a7686", "6b7280", "6b7381", "6b7f8d", "6c7086", "6c7a78", "6d6378",
  "6e7681", "6e7e72", "707070", "75715e", "767676", "767c9d", "7a746c", "7a746d", "7a7481", "7a857b", "7a8a95",
  "7a8f86", "7b8f9a", "7c6f64", "807880", "848cb5", "888888", "8893a8", "8a847c", "8a8a8a", "8a9d84", "8b7355",
  "8b735f", "8b7d6b", "8c8fa1", "8c959f", "8d6e63", "8e908c", "908caa", "909080", "909098", "90a4ae", "928374",
  "93a1a1", "9a7a65", "9a8772", "9a968f", "9a9aa0", "9b8a78", "9e9e9e", "a0a1a7", "a0a8b8", "a89080", "a898b0",
  "a99bb5", "b4bcc8",
]);
const OMP_DIM_256 = new Set([58, 59, 102, 103, 241, 242, 243, 244, 245, 246, 248, 250]);

/** Whether a cell is drawn in a built-in omp theme's `dim` and in no color omp paints typed text in. */
function ompGhostDrawn(cell: Cell): boolean {
  if (cell.inverse || cell.fg === null) return false;
  const codes = cell.fg.split(";").map(Number);
  if (codes[1] === 5) return OMP_DIM_256.has(codes[2]!);
  if (codes[1] !== 2) return false;
  return OMP_DIM_TRUECOLOR.has(codes.slice(2, 5).map((value) => value.toString(16).padStart(2, "0")).join(""));
}

const blank = (cell: Cell): boolean => cell.char.trim() === "";
const styleOf = (cell: Cell): string => `${cell.fg ?? ""}|${cell.dim}`;

/**
 * The ghost text drawn in a prompt row from `start` on: the composer's own cursor (with the hardware cursor turned
 * off) may come first, then the ghost begins at once, in one style that `drawn` takes for a ghost's, and holds every
 * character up to the first one drawn otherwise (a border, a cap). The cursor is pi-tui's `#getStyledInputCursor`:
 * `▏` (`|` in the ascii symbol preset), blinking in gjc. omp 18.18 draws it steady, in the terminal's own color:
 * with `steadyCursor` such a `▏` is the cursor too, where a typed one takes omp's text color and a ghost's own `▏`
 * its dim. A steady `|` reads the same as a typed one in a theme that leaves typed text to the terminal: no
 * prediction is read past it. An inverse blank is omp's cursor in Vim's normal mode.
 * `from` and `to` are where it lies in the row's cells, `start` where the cursor before it lies, if any.
 */
function ghostFrom(cells: readonly Cell[], start: number, drawn: (cell: Cell) => boolean, steadyCursor: boolean): { text: string; start: number; from: number; to: number } | null {
  let from = start;
  const cursor = cells[from];
  const glyph = cursor !== undefined && (cursor.char === "▏" || cursor.char === "|");
  const steady = steadyCursor && cursor?.char === "▏" && cursor.fg === null && !cursor.dim && !cursor.inverse;
  if (cursor && ((cursor.inverse && blank(cursor)) || (glyph && cursor.blink) || steady)) from += 1;
  const first = cells[from];
  if (!first || blank(first) || !drawn(first)) return null;
  const style = styleOf(first);
  let to = from + 1;
  for (let index = from + 1; index < cells.length; index++) {
    const cell = cells[index]!;
    if (blank(cell)) continue;
    if (styleOf(cell) !== style) break;
    to = index + 1;
  }
  return { text: cells.slice(from, to).map((cell) => cell.char).join(""), start, from, to };
}

/** A row's text with the cells of a ghost and the cursor before it blanked out: what the empty row shows. */
const withoutGhost = (cells: readonly Cell[], ghost: { start: number; to: number }): string =>
  cells.map((cell, index) => index >= ghost.start && index < ghost.to ? " " : cell.char).join("");

/**
 * The words of a ghost as a suggestion: none when pi-tui cut it at the row's edge (`truncateToWidth` ends it
 * with `…`), as only part of it would go into the box, and none for a ghost with no letter or digit in it: a
 * glyph drawn alone in the box is the composer's own (gjc's microphone while it records speech), not a prompt.
 */
function suggestionWords(text: string): string | null {
  const words = text.replace(/\u00a0/g, " ").trim();
  return words === "" || words.endsWith("…") || !/[\p{L}\p{N}]/u.test(words) ? null : words;
}

/** The screen's rows as cells, and as plain text untrimmed. */
function screenRows(ansi: string): { cells: Cell[][]; raw: string[] } {
  const cells = ansi.split("\n").map((row) => rowCells(row.replace(/\r$/, "")));
  return { cells, raw: cells.map((row) => row.map((cell) => cell.char).join("")) };
}

/** Where the rows show text, by index: the last one is the screen's bottom-most. */
const filledRows = (raw: readonly string[]): number[] => raw.flatMap((row, index) => row.trim() === "" ? [] : [index]);

/** How many blank cells a row starts with. */
const leadingBlanks = (cells: readonly Cell[]): number => {
  const first = cells.findIndex((cell) => !blank(cell));
  return first < 0 ? cells.length : first;
};

/** gjc's prompt row, `│ > ` before what is typed and ` │` after it, between its box's top and bottom border. */
const GJC_PROMPT_RE = /^[│|] > /u;
const GJC_BOX_TOP_RE = /^(?:╭─+╮|\+-+\+)$/u;
const GJC_BOX_BOTTOM_RE = /^(?:╰─+╯|\+-+\+)$/u;
/** the prompt row with nothing typed */
const GJC_EMPTY_PROMPT_RE = /^[│|] > *[│|]$/u;
/** gjc's placeholder in the empty box (`buildComposerPlaceholder`), drawn in the same dim color as a suggestion */
const GJC_PLACEHOLDER_RE = /^Type your message/;

/**
 * The prompt gjc suggests next (its `promptSuggestions` setting): ghost text in the empty box that ends the
 * screen (`╭─╮`, `│ > … │`, `╰─╯`), drawn in the theme's dim color where typed text takes the terminal's own.
 * None for the placeholder, for a box with anything typed, of more than one row or under anything else (an
 * autocomplete list), and for a suggestion gjc cut short at the box's edge.
 */
export function parseGjcSuggestion(ansi: string): string | null {
  const { cells, raw } = screenRows(ansi);
  const rows = filledRows(raw);
  if (rows.length < 3) return null;
  const [top, prompt, bottom] = rows.slice(-3) as [number, number, number];
  if (prompt !== top + 1 || bottom !== prompt + 1) return null;
  if (!GJC_BOX_TOP_RE.test(raw[top]!.trim()) || !GJC_BOX_BOTTOM_RE.test(raw[bottom]!.trim())) return null;
  const lead = leadingBlanks(cells[prompt]!);
  if (!GJC_PROMPT_RE.test(raw[prompt]!.trimStart())) return null;
  const ghost = ghostFrom(cells[prompt]!, lead + 4, gjcGhostDrawn, false);
  if (ghost === null) return null;
  if (!GJC_EMPTY_PROMPT_RE.test(withoutGhost(cells[prompt]!, ghost).trim()) || GJC_PLACEHOLDER_RE.test(ghost.text)) return null;
  return suggestionWords(ghost.text);
}

/** what comes before the text in omp's prompt row, by `composer.shape`: band's and box's `╰─ `, `❯ ` (claude, rule, borderless), the box's IME-safe `│ `, field's `▐ `, rail's `▎ `; pi's row has none */
const OMP_GUTTER_RE = /^ *(?:╰─? |\+-? |❯ |[│|] |▐ |▎ )?/u;
/**
 * The header omp draws in its `dim` over a queue draft: typed `->` or `=>` reads `Queueing ➤` (pi-tui
 * `prompt/custom-editor.ts` decorateText), with the draft's body on the rows under it, blank at first.
 */
const OMP_QUEUE_HEADER_RE = /^Queueing\b/u;

/**
 * The prompt omp predicts next (its `composer.predictions` setting): ghost text in the empty composer that ends
 * the screen, in any built-in `composer.shape`, drawn in a built-in theme's `dim` (OMP_DIM_TRUECOLOR). With the
 * prediction taken out, the row must read as the empty prompt row of that shape (dialogs/omp.ts). None while
 * anything is typed (a prediction then shows only after what was typed), for a queue draft's header, for the
 * right-aligned hint of an empty composer, and for a prediction omp cut short at the row's edge.
 * Known limit: the theme on screen is not known, so a custom theme whose `text` is exactly one of the built-in
 * `dim` colors draws typed text that reads as a prediction. Telling it apart would take omp's resolved theme
 * (its config, a project's, its flags) and its list of built-in names, for a collision on an exact color.
 */
export function parseOmpSuggestion(ansi: string): string | null {
  const { cells, raw } = screenRows(ansi);
  const rows = filledRows(raw);
  for (const row of rows.slice(-4).reverse()) {
    const gutter = Array.from(OMP_GUTTER_RE.exec(raw[row]!)![0]).length;
    const ghost = ghostFrom(cells[row]!, gutter, ompGhostDrawn, true);
    if (ghost === null || OMP_QUEUE_HEADER_RE.test(ghost.text)) continue;
    const blanked = raw.slice();
    blanked[row] = withoutGhost(cells[row]!, ghost);
    if (ompComposerPromptRow(blanked.map((line) => line.trim()), blanked) !== row) continue;
    return suggestionWords(ghost.text);
  }
  return null;
}
