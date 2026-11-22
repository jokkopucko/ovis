/**
 * herdr reports the agents' pickers, panels and dialogs as idle, and none of them writes its close to
 * a transcript (Claude Code alone does, for some), so the screen is the only thing that says a
 * command's screen has closed: the row the agent takes a message in is drawn again, empty, with
 * nothing over or under it.
 *
 * The rules come from recordings of every command the automatic return lists, at 119 or 120 and at 40
 * columns, idle, open and closed (Codex 0.163.0, omp 18.8.7, pi 0.86.0, gjc 0.18.12, OmO 5.1.40,
 * Hermes classic 0.21.5, Devin 3000.11.92, agy 1.4.4, Grok 1.0.67), and Claude Code's box follows
 * server/prompt.ts claudeInputBox.
 */

export type InputRowState = "ready" | "covered" | "draft" | "gone" | "unknown";

export interface ScreenCell {
  char: string;
  dim: boolean;
  italic: boolean;
  inverse: boolean;
  fgDefault: boolean;
  /** the foreground colour as its SGR parameters (`2;204;211;219`, `5;244`), where a read gives it (screenFromAnsi) */
  fg?: string;
}

export interface ScreenRow {
  text: string;
  /** one per drawn character: the second half of a wide one is left out, as in `text` */
  cells: readonly ScreenCell[];
}

export interface ScreenSnapshot {
  cols: number;
  rows: readonly ScreenRow[];
}

export type InputRowRecognizer = (screen: ScreenSnapshot, typed?: ScreenCell[]) => InputRowState;

/** a full-width rule of pi's TUI and its family */
const RULE = /^─{10,}$/;
const blank = (cell: ScreenCell): boolean => cell.char.trim() === "";
const filled = (screen: ScreenSnapshot): number[] => screen.rows.flatMap((row, index) => row.text.trim() === "" ? [] : [index]);
const cellsFrom = (row: ScreenRow, index: number): readonly ScreenCell[] => row.cells.slice(index);
const blankOr = (cells: readonly ScreenCell[], test: (cell: ScreenCell) => boolean): boolean => cells.every((cell) => blank(cell) || test(cell));

const CLAUDE_SOLID_RULE = /^[─━]{8,}$/;
/** a named session labels its rule (`──── my-session ─`) */
const CLAUDE_LABELED_RULE = /^─{2,}\s.*─$/;
/** Claude's IDE pill after the `❯` is no input */
const CLAUDE_IDE_PILL = /^[ \u00a0]?\[⧉ [^\]\n]+\] ?/;
/** Claude's new-session tip as a whole input row, which NO_COLOR draws undimmed */
const CLAUDE_TIP_ROW = /^Try "[^"]+"$/;

/**
 * Claude Code: the rows between the screen's last two rules are its input box, and the box is empty
 * when nothing follows its `❯` but Claude's own grey text (a suggested prompt, its tip) and the
 * cursor Claude draws itself, inverse on the first grey character. A panel or picker takes the box's
 * place (its rows hold no rule pair, or a `❯ 1.` choice); a paste placeholder is content.
 */
export const claudeInputRow: InputRowRecognizer = (screen) => {
  const rule = (text: string): boolean => CLAUDE_SOLID_RULE.test(text.trim()) || CLAUDE_LABELED_RULE.test(text.trim());
  let end = screen.rows.length - 1;
  while (end >= 0 && !rule(screen.rows[end]!.text)) end--;
  if (end < 0) return "gone";
  let start = end - 1;
  while (start >= 0 && !rule(screen.rows[start]!.text)) start--;
  if (start < 0) return "gone";
  const box = screen.rows.slice(start + 1, end);
  const first = box[0];
  if (!first?.text.startsWith("❯")) return first?.text.startsWith("!") ? "draft" : "gone";
  const afterPrompt = first.text.slice(1);
  const pill = CLAUDE_IDE_PILL.exec(afterPrompt)?.[0] ?? "";
  const words = [afterPrompt.slice(pill.length), ...box.slice(1).map((row) => row.text)].join("\n");
  if (words.trim() === "") return "ready";
  if (/\[(?:Pasted text #\d+|Image #\d+)/.test(words)) return "draft";
  // Under NO_COLOR the tip is not dim: only its exact form as the box's one row, on a screen drawn
  // without any colour, tells it from typed words
  const colorless = screen.rows.every((row) => row.cells.every((cell) => cell.fgDefault && !cell.dim));
  if (box.length === 1 && colorless && CLAUDE_TIP_ROW.test(words.trim())) return "ready";
  let cursor = false;
  let grey = false;
  let firstSeen = false;
  const skip = 1 + Array.from(pill).length;
  for (const [index, row] of box.entries()) {
    for (const cell of cellsFrom(row, index === 0 ? skip : 0)) {
      if (blank(cell)) continue;
      if (cell.dim) grey = true;
      else if (!firstSeen && cell.inverse) cursor = true;
      else return "draft";
      firstSeen = true;
    }
  }
  return cursor && !grey ? "draft" : "ready";
};

/** a picker's or a field's hint under a row that only looks like the composer (/rename's field) */
const CODEX_HINT = /\besc (back|cancel|close|exit|dismiss)\b|\bq close\b|\benter (select|submit|save|continue|open|resume)\b/;

/**
 * Codex: the bottom-most `› ` row (`» ` at Ultra reasoning effort; not a numbered `› 1.` choice), its mark not
 * inverse, every cell after it blank or dim (the placeholder rotates, so it is never matched), no picker or field hint
 * under it, and `? for shortcuts` (`? for shortc` at 40 columns) in one of the next 4 rows: the hint
 * leaves while the composer holds text. Picker rows (`› catppuccin-mocha`, `› [x] Use theme colors`)
 * and /rename's field (`› Type a name and press Enter`, over `enter submit · esc back`) look alike.
 */
export const codexInputRow: InputRowRecognizer = (screen, typed) => {
  const rows = filled(screen);
  const candidates = rows.filter((index) => {
    const text = screen.rows[index]!.text;
    // `»` is the composer's mark at Ultra reasoning effort (Codex 0.164 on); a list's cursor stays `›`
    return /^[›»](?: |$)/.test(text) && !/^[›»] \d+\./.test(text);
  });
  const at = candidates.at(-1);
  if (at === undefined) return "gone";
  const row = screen.rows[at]!;
  if (row.cells[0]?.inverse) return "gone";
  const below = rows.filter((index) => index > at).map((index) => screen.rows[index]!.text);
  if (below.some((text) => CODEX_HINT.test(text) || /^[↑↓]$/.test(text.trim()))) return "gone";
  if (!blankOr(cellsFrom(row, 2), (cell) => cell.dim)) {
    // only the composer, which Codex always draws over its model and folder line (a `›` row with nothing
    // under it is a message of the history's, not a box), and without its `? for shortcuts` hint, which
    // leaves while the composer holds text: a placeholder drawn undimmed (NO_COLOR) is no draft
    if (below.length > 0 && !below.slice(0, 4).some((text) => text.includes("? for"))) typed?.push(...cellsFrom(row, 2));
    return "draft";
  }
  return below.slice(0, 4).some((text) => text.includes("? for")) ? "ready" : "covered";
};

/**
 * omp: its status bar `╭── π … ╮` is the editor's top border, and the editor is empty when the next
 * row is `╰─ … ─╯` with nothing in it and nothing under it. /context draws a `⎋ to close` box over
 * a status bar and an editor that both stay drawn (at 119 columns), so a box ending right above the
 * bar with a `⎋` in it is a screen still open. Only the bar's frame and `π` are matched: its words
 * (plan mode, model, context) change.
 */
export const ompInputRow: InputRowRecognizer = (screen) => {
  const rows = filled(screen);
  const text = (index: number): string => screen.rows[index]!.text;
  const bar = rows.filter((index) => text(index).startsWith("╭──") && text(index).includes("π") && text(index).endsWith("╮")).at(-1);
  if (bar === undefined) return "gone";
  const after = rows.filter((index) => index > bar);
  if (after.length === 0 || !text(after[0]!).startsWith("╰─")) return "gone";
  if (!/^╰─\s+─╯$/.test(text(after[0]!))) return "draft";
  if (after.length > 1) return "covered";
  const above = rows.filter((index) => index < bar).at(-1);
  if (above !== undefined && /^╰─+╯$/.test(text(above))) {
    for (let index = above - 1; index >= 0 && !text(index).startsWith("╭"); index--) {
      if (text(index).includes("⎋")) return "covered";
    }
  }
  return "ready";
};

// ---- pi and OmO (pi's TUI) ------------------------------------------------------------------------

/**
 * pi: the editor is the one blank row between the screen's last two full-width rules, under it 1 to
 * 3 footer rows (the folder and branch, the context and model) and no autocomplete (`→ `). The
 * footer stays under every dialog, so it proves nothing alone; dialogs end with one rule above it,
 * their content indented, several rows between the rules. More footer rows (an extension's status)
 * fail safe.
 */
export const piInputRow: InputRowRecognizer = (screen, typed) => {
  const stock = piStockInputRow(screen, typed);
  return stock === "gone" ? piPowerlineInputRow(screen, typed) : stock;
};

const piStockInputRow: InputRowRecognizer = (screen, typed) => {
  const rows = filled(screen);
  const text = (index: number): string => screen.rows[index]!.text;
  const rules = rows.filter((index) => RULE.test(text(index)));
  const lower = rules.at(-1);
  if (lower === undefined) return "gone";
  const footer = rows.filter((index) => index > lower);
  if (footer.length < 1 || footer.length > 4) return "gone";
  if (footer.some((index) => /^\s*→ /.test(text(index)))) return "draft";
  if (footer.length > 3) return "gone";
  const upper = rules.filter((index) => index < lower).at(-1);
  if (upper === undefined) return "gone";
  const inner = Array.from({ length: lower - upper - 1 }, (_, offset) => text(upper + 1 + offset));
  if (inner.length === 1 && inner[0]!.trim() === "") return "ready";
  // the draft check (`typed` given) also takes rows typed with leading spaces (an indented snippet), which the peek
  // reads as a dialog's, and keeps doing so; only a dialog's search field (`> `) over its select cursor (`→ `, which pi
  // draws in colour: typed text takes the terminal's own) is none
  const cursor = (index: number): boolean => {
    const at = /^\s*→ /.exec(text(index))?.[0].indexOf("→") ?? -1;
    return at >= 0 && screen.rows[index]!.cells[at]?.fgDefault === false;
  };
  const dialog = Array.from({ length: lower - upper - 1 }, (_, offset) => upper + 1 + offset).some(cursor)
    && inner.some((row) => /^\s*>(?: |$)/.test(row));
  if (inner.length > 0 && inner.length <= 6
    && (typed === undefined ? inner.every((row) => !row.startsWith("  ")) : !dialog)
    && inner.some((row) => row.trim() !== "") && !inner.some((row) => row.trim() === ">")) {
    for (let index = upper + 1; index < lower; index++) typed?.push(...screen.rows[index]!.cells);
    return "draft";
  }
  return "gone";
};

/** pi-powerline-footer's editor border: a rule indented one column, `↑` or `↓` at its start where the editor scrolls. */
const POWERLINE_RULE = /^ [↑↓─]─{9,}$/;

/**
 * pi with the pi-powerline-footer extension (0.22.0): its status bar sits above the editor, whose two borders
 * are the screen's last rows. Its first row starts ` > ` (` $ ` in bash mode), the others `   `; nothing in it but
 * the prompt is an empty box. Under the lower border only the extension's last-prompt row (` ↳ `, drawn once a
 * prompt was sent) is taken; anything else there (an autocomplete list, another widget) fails safe.
 * The editor has no placeholder; its cursor draws the character under it inverse, which is still typed text.
 */
const piPowerlineInputRow: InputRowRecognizer = (screen, typed) => {
  const rows = filled(screen);
  const text = (index: number): string => screen.rows[index]!.text;
  const last = rows.at(-1);
  const lower = last !== undefined && /^ ↳ /.test(text(last)) ? rows.at(-2) : last;
  if (lower === undefined || !POWERLINE_RULE.test(text(lower))) return "gone";
  const upper = rows.filter((index) => index < lower && POWERLINE_RULE.test(text(index))).at(-1);
  if (upper === undefined || lower - upper < 2) return "gone";
  const inner = Array.from({ length: lower - upper - 1 }, (_, offset) => upper + 1 + offset);
  if (!/^ [>$](?: |$)/.test(text(inner[0]!)) || inner.slice(1).some((index) => !/^ {3}|^$/.test(text(index)))) return "gone";
  if (inner.length === 1 && text(inner[0]!).trim().length === 1) return "ready";
  for (const index of inner) typed?.push(...cellsFrom(screen.rows[index]!, 3).map((cell) => cell.inverse ? { ...cell, inverse: false } : cell));
  return "draft";
};

/**
 * OmO: from the bottom, 1 to 3 footer rows (the folder and model, `(😺 OmO Native by Q Kim)`) and no
 * autocomplete, a full-width rule, a row that is exactly `❯` (the cursor is an inverse space), and a
 * full-width rule. Its dialogs draw a bare `>` under a single rule, which the row never matches.
 */
export const omoInputRow: InputRowRecognizer = (screen, typed) => {
  const rows = filled(screen);
  const text = (index: number): string => screen.rows[index]!.text;
  const last = rows.at(-1);
  if (last === undefined) return "gone";
  for (let position = rows.length - 1; position >= 0; position--) {
    const index = rows[position]!;
    if (text(index).startsWith("❯")) {
      const above = rows[position - 1];
      const below = rows.filter((row) => row > index);
      if (above === undefined || below.length === 0 || !RULE.test(text(above)) || !RULE.test(text(below[0]!))) return "gone";
      const footer = below.slice(1);
      if (footer.some((row) => /^\s*→ /.test(text(row))) || text(index) !== "❯") {
        typed?.push(...cellsFrom(screen.rows[index]!, 1));
        return "draft";
      }
      return footer.length >= 1 && footer.length <= 3 ? "ready" : "covered";
    }
    if (RULE.test(text(index)) || index >= last - 4) continue;
    break;
  }
  return "gone";
};

/**
 * gjc: the screen ends in its box, `╭─╮`, `│ > … │`, `╰─╯`, holding nothing or the placeholder
 * (`Type your message…`, cut short at 40 columns), which gjc draws in its placeholder colour where
 * typed text takes the default one. Panels take the box's place; autocomplete draws under it.
 */
export const gjcInputRow: InputRowRecognizer = (screen, typed) => {
  const rows = filled(screen);
  const text = (index: number): string => screen.rows[index]!.text;
  for (let position = rows.length - 1; position >= 2; position--) {
    const index = rows[position]!;
    if (!text(index).startsWith("│ >")) continue;
    const top = rows[position - 1]!;
    // the draft check (`typed` given) also reads the rows a draft wraps onto, `│ …│` down to the bottom border
    const wrapped = typed === undefined ? 0 : Math.max(0, rows.slice(position + 1, position + 1 + BOX_MAX_ROWS).findIndex((row) => !/^│ .*│$/.test(text(row))));
    const bottom = rows[position + 1 + wrapped];
    if (!/^╭─+╮$/.test(text(top)) || bottom === undefined || !/^╰─+╯$/.test(text(bottom))) continue;
    const body = text(index).slice(3).replace(/│+$/, "").trim();
    const cells = [cellsFrom(screen.rows[index]!, 4), ...rows.slice(position + 1, position + 1 + wrapped).map((row) => cellsFrom(screen.rows[row]!, 2))]
      .flat().filter((cell) => !blank(cell) && cell.char !== "│");
    const placeholder = body.startsWith("Type your message") && cells.every((cell) => !cell.fgDefault);
    const after = rows.slice(position + 2 + wrapped);
    if ((wrapped === 0 ? body === "" : cells.length === 0) || placeholder) return after.length === 0 ? "ready" : "covered";
    typed?.push(...cells);
    return "draft";
  }
  return "gone";
};

/**
 * Hermes' classic CLI: the bottom-most row that is no rule is `❯` with nothing after it but its
 * italic placeholder, a rule above it and the ` ☤ ` status bar above that. A confirmation replaces
 * the row with `⚠ …`, and the model picker and the palette hide the status bar over an empty row:
 * both are a screen still open. With the status bar turned off nothing is ever ready.
 */
export const hermesInputRow: InputRowRecognizer = (screen) => {
  const rows = filled(screen);
  const text = (index: number): string => screen.rows[index]!.text;
  let position = rows.length - 1;
  while (position >= 0 && RULE.test(text(rows[position]!))) position--;
  if (position < 0) return "gone";
  const index = rows[position]!;
  if (text(index).startsWith("⚠ ")) return "covered";
  if (!/^❯( |$)/.test(text(index))) return "gone";
  const above = position >= 1 ? text(rows[position - 1]!) : "";
  const status = position >= 2 ? text(rows[position - 2]!) : "";
  if (!RULE.test(above)) return "gone";
  if (!blankOr(cellsFrom(screen.rows[index]!, 2), (cell) => cell.italic)) return "draft";
  return status.startsWith(" ☤ ") ? "ready" : "covered";
};

/**
 * Devin: in the last 10 rows, a `❭` box between two plain full-width rules (a labelled top rule is
 * /btw's own field), holding nothing or the `Ask Devin` placeholder in its grey (typed text takes the
 * default colour), and under it the footer with at most one status line, none saying
 * `esc back to chat`. Picker rows start with `❭` too, but between no such rules.
 */
export const devinInputRow: InputRowRecognizer = (screen) => {
  const rows = filled(screen);
  const text = (index: number): string => screen.rows[index]!.text;
  const rules = rows.slice(-10).filter((index) => /^─{10,}$/.test(text(index)) || /^─+ \S.* ──$/.test(text(index)));
  if (rules.length < 2) return "gone";
  const upper = rules.at(-2)!;
  const lower = rules.at(-1)!;
  const box = rows.filter((index) => index > upper && index < lower);
  if (box.length === 0 || !text(box[0]!).startsWith("❭")) return "gone";
  if (!/^─{10,}$/.test(text(upper)) || !/^─{10,}$/.test(text(lower))) return "gone";
  const cells: ScreenCell[] = [...cellsFrom(screen.rows[box[0]!]!, 2)];
  for (const index of box.slice(1)) {
    if (!text(index).startsWith("  ")) return "gone";
    cells.push(...screen.rows[index]!.cells);
  }
  const words = cells.map((cell) => cell.char).join("").trim();
  const placeholder = words.startsWith("Ask Devin") && cells.every((cell) => blank(cell) || !cell.fgDefault);
  if (words !== "" && !placeholder) return "draft";
  const footer = rows.filter((index) => index > lower);
  if (footer.some((index) => text(index).includes("esc back to chat"))) return "gone";
  return footer.length >= 1 && footer.length <= 2 ? "ready" : "covered";
};

/**
 * agy: the bottom-most pair of unindented full-width rules with one row between them, that row
 * exactly `>`, and under it one row with `? for shortcuts`. Most of its panels draw under the box
 * and leave it empty (covered); picker rows (`> Agent Mode`) start with `>` too.
 */
export const agyInputRow: InputRowRecognizer = (screen) => {
  const rows = filled(screen);
  const text = (index: number): string => screen.rows[index]!.text;
  const rules = rows.filter((index) => /^─{10,}$/.test(text(index)));
  for (let position = rules.length - 1; position >= 1; position--) {
    const upper = rules[position - 1]!;
    const lower = rules[position]!;
    const box = rows.filter((index) => index > upper && index < lower);
    if (box.length === 0 || !text(box[0]!).startsWith(">") || !box.slice(1).every((index) => text(index).startsWith("  "))) continue;
    if (text(box[0]!).trim() !== ">" || box.length > 1) return "draft";
    const after = rows.filter((index) => index > lower);
    return after.length === 1 && text(after[0]!).includes("? for shortcuts") ? "ready" : "covered";
  }
  return "gone";
};

/**
 * Grok: the bottom-most `│ ❯ │` row empty with every row of the box under it (a draft's later lines, Grok 1.0.77),
 * `Ctrl+.:shortcuts` in the last two rows, and no modal on screen (`Esc close`, `F2/Esc close`, `Esc:cancel`, a
 * `┌─ … ─` title). A modal drawn across the row leaves box characters in it. The Agent Dashboard has its own
 * field (`Enter:create` in its footer) and /history's search reads `│ ?`.
 */
export const grokInputRow: InputRowRecognizer = (screen) => {
  const rows = filled(screen);
  const text = (index: number): string => screen.rows[index]!.text;
  const at = rows.filter((index) => /^\s*│ [❯?]/.test(text(index))).at(-1);
  if (at === undefined) return "gone";
  const body = text(at).replace(/^\s*│ [❯?]/, "").replace(/\s*│\s*$/, "").trim();
  const lastTwo = rows.slice(-2).map(text);
  if (lastTwo.join(" ").includes("Enter:create") || /^\s*│ \?/.test(text(at))) return "gone";
  if (/[│└┘┌┐]/.test(body)) return "covered";
  const bottom = rows.find((index) => index > at && /^\s*╰/.test(text(index)));
  const lines = rows.filter((index) => index > at && bottom !== undefined && index < bottom).map((index) => text(index).replace(/^\s*│/, "").replace(/│\s*$/, "").trim());
  if (body !== "" || lines.some((line) => line !== "")) return "draft";
  const modal = screen.rows.some((row) => row.text.includes("Esc close") || row.text.includes("F2/Esc close")
    || row.text.includes("Esc:cancel") || /┌─ .* ─/.test(row.text));
  return modal || !lastTwo.some((row) => row.includes("Ctrl+.:shortcuts")) ? "covered" : "ready";
};

/**
 * The agents whose input row is known, by herdr's agent name (OmO's own, not the `pi` herdr labels
 * it with). OpenCode is not here: only its home screen was recorded, not the in-session layout most
 * of its screens open over. Neither is Command Code, which was not recorded.
 */
const RECOGNIZERS: Readonly<Record<string, InputRowRecognizer>> = {
  claude: claudeInputRow,
  codex: codexInputRow,
  omp: ompInputRow,
  pi: piInputRow,
  omo: omoInputRow,
  gjc: gjcInputRow,
  hermes: hermesInputRow,
  devin: devinInputRow,
  agy: agyInputRow,
  grok: grokInputRow,
};

export function readsInputRow(agent: string | null | undefined): boolean {
  return agent != null && Object.hasOwn(RECOGNIZERS, agent);
}

export function inputRowState(agent: string | null | undefined, screen: ScreenSnapshot): InputRowState | null {
  if (!readsInputRow(agent)) return null;
  if (screen.rows.every((row) => row.text.trim() === "")) return "unknown";
  return RECOGNIZERS[agent!]!(screen);
}

const BOX_MAX_ROWS = 8;

function boxRow(screen: ScreenSnapshot, mark: RegExp, above: RegExp, below: RegExp, typed: ScreenCell[] | undefined): InputRowState {
  const rows = filled(screen);
  const text = (index: number): string => screen.rows[index]!.text;
  for (let position = rows.length - 1; position >= 1; position--) {
    const index = rows[position]!;
    const found = mark.exec(text(index));
    if (!found) continue;
    // a draft's own row may start with the mark (a quoted line in Qwen's): the box's first row has the border above it
    if (!above.test(text(rows[position - 1]!))) continue;
    const end = rows.slice(position + 1, position + 1 + BOX_MAX_ROWS).findIndex((row) => below.test(text(row)));
    if (end < 0) return "gone";
    const cells = [cellsFrom(screen.rows[index]!, Array.from(found[0]).length), ...rows.slice(position + 1, position + 1 + end).map((row) => screen.rows[row]!.cells)]
      .flat().filter((cell) => cell.char !== "│");
    if (cells.every(blank)) return "ready";
    typed?.push(...cells);
    return "draft";
  }
  return "gone";
}

const FULL_RULE = /^\s*─{10,}\s*$/;

/** Muse Code 1.4.14: `❯ ` between two full-width rules, the folder and model under them; no placeholder. */
const museInputRow: InputRowRecognizer = (screen, typed) => boxRow(screen, /^❯ ?/, FULL_RULE, FULL_RULE, typed);

/** Qwen Code 0.27.2: `> ` between two full-width rules, its placeholder grey behind a drawn cursor. */
const qwenInputRow: InputRowRecognizer = (screen, typed) => boxRow(screen, /^> /, FULL_RULE, FULL_RULE, typed);

/** cline 3.0.74: an indented `❯ ` between two rules of its own width, its placeholder grey. */
const clineInputRow: InputRowRecognizer = (screen, typed) => boxRow(screen, /^\s*❯ /, FULL_RULE, FULL_RULE, typed);

/** dsh-tui 0.19.0: `│ ❯ ` in a rounded box, its placeholder grey. */
const dshTuiInputRow: InputRowRecognizer = (screen, typed) => boxRow(screen, /^\s*│ ❯ /, /^\s*╭─+╮$/, /^\s*╰─+╯$/, typed);

/** Letta Code 0.34.23: `› ` between two full-width rules, its suggestion grey behind a drawn cursor. */
const lettaInputRow: InputRowRecognizer = (screen, typed) => boxRow(screen, /^› ?/, FULL_RULE, FULL_RULE, typed);

/** maki 0.7.1: `❯ ` between two full-width rules, its placeholder grey. */
const makiInputRow: InputRowRecognizer = (screen, typed) => boxRow(screen, /^❯ ?/, FULL_RULE, FULL_RULE, typed);

/** Kimi Code 2.5.3 (herdr's `kimi`): `│ > ` in a rounded box. */
const kimiInputRow: InputRowRecognizer = (screen, typed) => boxRow(screen, /^\s*│ > ?/, /^\s*╭─+╮$/, /^\s*╰─+╯$/, typed);

/** Gemini CLI 0.68.0: `> ` between a row of `▄` and one of `▀`, its placeholder grey behind a drawn cursor. */
const geminiInputRow: InputRowRecognizer = (screen, typed) => boxRow(screen, /^\s*> ?/, /^▄+$/, /^▀+$/, typed);

/**
 * Kilo 7.8.27: rows starting with `┃` over a `╹▀…` row, home screen and session alike; the last of them is its
 * agent and model, the ones above it the editor (its command list too, drawn there once `/` is typed).
 */
const kiloInputRow: InputRowRecognizer = (screen, typed) => {
  const rows = filled(screen);
  const text = (index: number): string => screen.rows[index]!.text;
  let end = rows.length - 1;
  while (end >= 0 && !/^\s*╹▀+$/.test(text(rows[end]!))) end--;
  if (end < 2) return "gone";
  let start = end;
  while (start > 0 && /^\s*┃/.test(text(rows[start - 1]!))) start--;
  const editor = rows.slice(start, end - 1);
  if (editor.length === 0) return "gone";
  const cells = editor.flatMap((index) => cellsFrom(screen.rows[index]!, text(index).indexOf("┃") + 1));
  if (cells.every(blank)) return "ready";
  typed?.push(...cells);
  return "draft";
};

/**
 * omp 18.14 (recorded 2026-11-14, src/lib/fixtures-input-rows/README.md): its status line `π > … ▶` with no frame,
 * then the editor right under it, its first row `╰─ ` and the rows a draft runs onto, each indented three columns
 * (an empty row of the draft is blank). The empty editor holds only its `⇧⇥ to change thinking effort` hint, drawn in
 * colours no typed text takes, so its cells are reported and typedDraft's colour test tells it from typed words; the
 * command list draws under the editor. omp 18.8.7's framed editor (ompInputRow) was recorded only empty and reports
 * no cells.
 */
const ompDraftInputRow: InputRowRecognizer = (screen, typed) => {
  const bar = filled(screen).filter((index) => /^ ?π > .*▶/.test(screen.rows[index]!.text)).at(-1);
  if (bar === undefined || !screen.rows[bar + 1]?.text.startsWith("╰─")) return ompInputRow(screen);
  // the draft's rows run on while they are indented three columns or blank; the last indented one ends it
  let end = bar + 2;
  for (let index = bar + 2; index < screen.rows.length && index < bar + 2 + BOX_MAX_ROWS; index++) {
    const text = screen.rows[index]!.text;
    if (text.trim() === "") continue;
    if (!text.startsWith("   ")) break;
    end = index + 1;
  }
  const cells = screen.rows.slice(bar + 1, end).flatMap((row) => cellsFrom(row, 3));
  if (cells.every(blank)) return screen.rows.slice(end).some((row) => row.text.trim() !== "") ? "covered" : "ready";
  typed?.push(...cells);
  return "draft";
};

const DRAFT_RECOGNIZERS: Readonly<Record<string, InputRowRecognizer>> = {
  ...RECOGNIZERS, omp: ompDraftInputRow, muse: museInputRow, qwen: qwenInputRow, cline: clineInputRow, "dsh-tui": dshTuiInputRow,
  letta: lettaInputRow, maki: makiInputRow, kimi: kimiInputRow, gemini: geminiInputRow, kilo: kiloInputRow,
};

const REPORTS_TYPED: ReadonlySet<string> = new Set(["codex", "pi", "omo", "gjc", "omp", "muse", "qwen", "cline", "dsh-tui", "letta", "maki", "kimi", "gemini", "kilo"]);

/**
 * The colours an agent draws typed text in where it does not use the terminal's own (as recorded, default
 * theme): text in any other colour is its placeholder or a suggestion, or a theme not recorded, and counts
 * as no evidence.
 */
const TYPED_COLOURS: Readonly<Record<string, readonly string[]>> = {
  omp: ["5;254"],
  muse: ["2;204;211;219"],
  cline: ["2;237;241;242"],
  maki: ["2;191;189;182"],
  gemini: ["2;255;255;255"],
  kilo: ["2;250;250;249"],
};

export function readsTypedDraft(agent: string | null | undefined): boolean {
  return agent != null && REPORTS_TYPED.has(agent);
}

/**
 * Whether `agent`'s input box on this screen holds text a person typed, which a pasted chat message would
 * join and its Enter send along. Only positive evidence counts: the recognizer found the box, answered
 * "draft" and reported its cells (InputRowRecognizer `typed`), and one of them is drawn as typed text is,
 * in the terminal's own colour or one TYPED_COLOURS lists for that agent, neither dim nor italic nor
 * inverse. A placeholder or a suggestion (dim, grey, italic), a drawn cursor, a box not found, a screen a
 * recognizer cannot read, and an agent without one all answer false: a send there goes as it always did,
 * never refused for good on a misreading.
 */
export function typedDraft(agent: string | null | undefined, screen: ScreenSnapshot): boolean {
  if (!readsTypedDraft(agent)) return false;
  const typed: ScreenCell[] = [];
  if (DRAFT_RECOGNIZERS[agent!]!(screen, typed) !== "draft") return false;
  const colours = TYPED_COLOURS[agent!] ?? [];
  // a character that draws nothing (a zero-width space an agent pads its box with) is no evidence either
  return typed.some((cell) => /[^\p{Z}\p{C}]/u.test(cell.char) && !cell.dim && !cell.italic && !cell.inverse
    && (cell.fgDefault || (cell.fg !== undefined && colours.includes(cell.fg))));
}

/** Whether a screen read carries any colour or text style (SGR 2, 3, 7, a foreground or background colour): without one nothing is told from a placeholder. */
export function drawsColour(text: string): boolean {
  for (const match of text.matchAll(/\u001b\[([0-9;:]*)m/g)) {
    for (const parameter of (match[1] || "0").split(";")) {
      const code = Number(parameter.split(":")[0] || 0);
      if ([2, 3, 7].includes(code) || (code >= 30 && code <= 38) || (code >= 40 && code <= 48) || (code >= 90 && code <= 97) || (code >= 100 && code <= 107)) return true;
    }
  }
  return false;
}

const ESCAPE = /\u001b(?:\[([0-?]*)[ -/]*([@-~])|\][^\u0007\u001b]*(?:\u0007|\u001b\\)|[@-Z\\-_])/g;
/** Made on first use, where the runtime has one: a browser this module is bundled for may not (Safari 14, Firefox before 125). */
let graphemes: Intl.Segmenter | undefined;

function characters(text: string): string[] {
  if (typeof Intl.Segmenter === "function") graphemes ??= new Intl.Segmenter(undefined, { granularity: "grapheme" });
  return graphemes ? Array.from(graphemes.segment(text), ({ segment }) => segment) : Array.from(text);
}

/**
 * A screen as herdr's `pane.read` gives it with `format: "ansi"` (one row per line, SGR only), as the
 * recognizers read it: the same cells src/lib/inputRow.ts readScreen builds from the xterm buffer, one per
 * drawn character, with the attributes they look at. Other escapes are dropped.
 */
export function screenFromAnsi(text: string): ScreenSnapshot {
  const rows = text.split("\n").map((line): ScreenRow => {
    const cells: ScreenCell[] = [];
    let dim = false, italic = false, inverse = false, fgDefault = true;
    let fg: string | undefined;
    const draw = (piece: string): void => {
      for (const char of characters(piece.replace(/\r/g, ""))) cells.push({ char, dim, italic, inverse, fgDefault, ...(fg === undefined ? {} : { fg }) });
    };
    let offset = 0;
    for (const match of line.matchAll(ESCAPE)) {
      draw(line.slice(offset, match.index));
      offset = match.index + match[0].length;
      if (match[2] !== "m") continue;
      const codes = (match[1] || "0").split(";");
      for (let index = 0; index < codes.length; index++) {
        const code = codes[index]!;
        // a colour in colon form (`38:2::r:g:b`) is one parameter
        const head = Number(code.split(":")[0] || 0);
        if (head === 38 || head === 48 || head === 58) {
          const span = code.includes(":") ? 0 : codes[index + 1] === "5" ? 2 : codes[index + 1] === "2" ? 4 : 0;
          if (head === 38) {
            fgDefault = false;
            fg = code.includes(":") ? code.split(":").slice(1).filter(Boolean).join(";") : codes.slice(index + 1, index + 1 + span).join(";");
          }
          index += span;
        } else if (head === 0) { dim = false; italic = false; inverse = false; fgDefault = true; fg = undefined; }
        else if (head === 2) dim = true;
        else if (head === 22) dim = false;
        else if (head === 3) italic = true;
        else if (head === 23) italic = false;
        else if (head === 7) inverse = true;
        else if (head === 27) inverse = false;
        else if (head === 39) { fgDefault = true; fg = undefined; }
        else if ((head >= 30 && head <= 37) || (head >= 90 && head <= 97)) { fgDefault = false; fg = String(head); }
      }
    }
    draw(line.slice(offset));
    return { text: cells.map((cell) => cell.char).join("").trimEnd(), cells };
  });
  return { cols: Math.max(0, ...rows.map((row) => row.cells.length)), rows };
}
