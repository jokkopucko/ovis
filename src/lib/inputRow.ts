/**
 * Whether an agent's own empty input row is on its screen (the terminal peek's way back to the
 * chat, lib/terminalPeek.ts). herdr reports the agents' pickers, panels and dialogs as idle, and
 * none of them writes its close to a transcript (Claude Code alone does, for some), so the screen is
 * the only thing that says a command's screen has closed: the row the agent takes a message in is
 * drawn again, empty, with nothing over or under it.
 *
 * One recognizer per agent, each a pure function over a small snapshot of the screen (its rows'
 * text and the few cell attributes a placeholder needs), built here from the xterm buffer. The
 * rules come from recordings of every command the automatic return lists, at 119 or 120 and at 40
 * columns, idle, open and closed (Codex 0.163.0, omp 18.8.7, pi 0.86.0, gjc 0.18.12, OmO 5.1.40,
 * Hermes classic 0.21.5, Devin 3000.11.92, agy 1.4.4, Grok 1.0.67), and Claude Code's box follows
 * server/prompt.ts claudeInputBox. Each one prefers "not back" when in doubt: a missed return leaves
 * the reader one press away from the chat, an early one hides a screen they are still using.
 */

import type { IBuffer, IBufferCell } from "@xterm/xterm";

/**
 * What a frame shows of the agent's input row:
 * - ready: the agent's own empty input row, with nothing drawn over or under it
 * - covered: the row is drawn and empty, but a command's screen is drawn too (an overlay, a panel
 *   under the box, a hidden status bar)
 * - draft: the row is drawn and holds text
 * - gone: the row is not on screen
 * - unknown: a blank frame, which says nothing
 */
export type InputRowState = "ready" | "covered" | "draft" | "gone" | "unknown";

export interface ScreenCell {
  /** the cell's character, a space for an empty cell */
  char: string;
  dim: boolean;
  italic: boolean;
  inverse: boolean;
  /** drawn in the terminal's default foreground: a placeholder colour is not */
  fgDefault: boolean;
}

export interface ScreenRow {
  /** the row's characters, its right edge trimmed */
  text: string;
  /** one per drawn character: the second half of a wide one is left out, as in `text` */
  cells: readonly ScreenCell[];
}

export interface ScreenSnapshot {
  cols: number;
  rows: readonly ScreenRow[];
}

export type InputRowRecognizer = (screen: ScreenSnapshot) => InputRowState;

/** The screen's rows as the recognizers read them: the live screen's, top to bottom, from the buffer. */
export function readScreen(buffer: IBuffer, cols: number, rows: number): ScreenSnapshot {
  const out: ScreenRow[] = [];
  let cell: IBufferCell | undefined;
  for (let y = 0; y < rows; y++) {
    const line = buffer.getLine(buffer.baseY + y);
    const cells: ScreenCell[] = [];
    if (line) {
      for (let x = 0; x < Math.min(cols, line.length); x++) {
        cell = line.getCell(x, cell);
        if (!cell || cell.getWidth() === 0) continue;
        cells.push({
          char: cell.getChars() || " ",
          dim: cell.isDim() !== 0,
          italic: cell.isItalic() !== 0,
          inverse: cell.isInverse() !== 0,
          fgDefault: cell.isFgDefault(),
        });
      }
    }
    out.push({ text: cells.map((item) => item.char).join("").trimEnd(), cells });
  }
  return { cols, rows: out };
}

/** The live screen as logical lines, preserving spaces across xterm wraps (as in useTerminalMount). */
export function readScreenLines(buffer: IBuffer, rows: number): string[] | null {
  const lines: string[] = [];
  for (let y = 0; y < rows; y++) {
    const line = buffer.getLine(buffer.baseY + y);
    // A clipped first line or missing row cannot prove what the screen says.
    if (!line || (y === 0 && line.isWrapped)) return null;
    const text = line.translateToString(y === rows - 1 || !buffer.getLine(buffer.baseY + y + 1)?.isWrapped);
    if (line.isWrapped && lines.length) lines[lines.length - 1] += text;
    else lines.push(text);
  }
  return lines;
}

/** a full-width rule of pi's TUI and its family */
const RULE = /^─{10,}$/;
const blank = (cell: ScreenCell): boolean => cell.char.trim() === "";
/** the non-empty rows' indexes, top to bottom */
const filled = (screen: ScreenSnapshot): number[] => screen.rows.flatMap((row, index) => row.text.trim() === "" ? [] : [index]);
/** the row's cells from a character index on (cells and characters line up, wide halves left out) */
const cellsFrom = (row: ScreenRow, index: number): readonly ScreenCell[] => row.cells.slice(index);
/** every drawn character is blank or passes `test` */
const blankOr = (cells: readonly ScreenCell[], test: (cell: ScreenCell) => boolean): boolean => cells.every((cell) => blank(cell) || test(cell));

// ---- Claude Code (server/prompt.ts claudeInputBox, claudeInputDraft) ----------------------------

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

// ---- Codex ----------------------------------------------------------------------------------------

/** a picker's or a field's hint under a row that only looks like the composer (/rename's field) */
const CODEX_HINT = /\besc (back|cancel|close|exit|dismiss)\b|\bq close\b|\benter (select|submit|save|continue|open|resume)\b/;

/**
 * Codex: the bottom-most `› ` row (`» ` at Ultra reasoning effort; not a numbered `› 1.` choice), its mark not
 * inverse, every cell after it blank or dim (the placeholder rotates, so it is never matched), no picker or field hint
 * under it, and `? for shortcuts` (`? for shortc` at 40 columns) in one of the next 4 rows: the hint
 * leaves while the composer holds text. Picker rows (`› catppuccin-mocha`, `› [x] Use theme colors`)
 * and /rename's field (`› Type a name and press Enter`, over `enter submit · esc back`) look alike.
 */
export const codexInputRow: InputRowRecognizer = (screen) => {
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
  if (!blankOr(cellsFrom(row, 2), (cell) => cell.dim)) return "draft";
  return below.slice(0, 4).some((text) => text.includes("? for")) ? "ready" : "covered";
};

// ---- omp ------------------------------------------------------------------------------------------

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
export const piInputRow: InputRowRecognizer = (screen) => {
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
  if (inner.length > 0 && inner.length <= 6 && inner.every((row) => !row.startsWith("  "))
    && inner.some((row) => row.trim() !== "") && !inner.some((row) => row.trim() === ">")) return "draft";
  return "gone";
};

/**
 * OmO: from the bottom, 1 to 3 footer rows (the folder and model, `(😺 OmO Native by Q Kim)`) and no
 * autocomplete, a full-width rule, a row that is exactly `❯` (the cursor is an inverse space), and a
 * full-width rule. Its dialogs draw a bare `>` under a single rule, which the row never matches.
 */
export const omoInputRow: InputRowRecognizer = (screen) => {
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
      if (footer.some((row) => /^\s*→ /.test(text(row)))) return "draft";
      if (text(index) !== "❯") return "draft";
      return footer.length >= 1 && footer.length <= 3 ? "ready" : "covered";
    }
    if (RULE.test(text(index)) || index >= last - 4) continue;
    break;
  }
  return "gone";
};

// ---- gjc ------------------------------------------------------------------------------------------

/**
 * gjc: the screen ends in its box, `╭─╮`, `│ > … │`, `╰─╯`, holding nothing or the placeholder
 * (`Type your message…`, cut short at 40 columns), which gjc draws in its placeholder colour where
 * typed text takes the default one. Panels take the box's place; autocomplete draws under it.
 */
export const gjcInputRow: InputRowRecognizer = (screen) => {
  const rows = filled(screen);
  const text = (index: number): string => screen.rows[index]!.text;
  for (let position = rows.length - 1; position >= 2; position--) {
    const index = rows[position]!;
    if (!text(index).startsWith("│ >")) continue;
    const top = rows[position - 1]!;
    const bottom = rows[position + 1];
    if (!/^╭─+╮$/.test(text(top)) || bottom === undefined || !/^╰─+╯$/.test(text(bottom))) continue;
    const body = text(index).slice(3).replace(/│+$/, "").trim();
    const cells = cellsFrom(screen.rows[index]!, 4).filter((cell) => !blank(cell) && cell.char !== "│");
    const placeholder = body.startsWith("Type your message") && cells.every((cell) => !cell.fgDefault);
    const after = rows.slice(position + 2);
    if (body === "" || placeholder) return after.length === 0 ? "ready" : "covered";
    return "draft";
  }
  return "gone";
};

// ---- Hermes Agent (classic CLI) -------------------------------------------------------------------

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

// ---- Devin ----------------------------------------------------------------------------------------

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

// ---- agy (Antigravity CLI) ------------------------------------------------------------------------

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

// ---- Grok -----------------------------------------------------------------------------------------

/**
 * Grok: the bottom-most `│ ❯ │` row empty, `Ctrl+.:shortcuts` in the last two rows, and no modal on
 * screen (`Esc close`, `F2/Esc close`, `Esc:cancel`, a `┌─ … ─` title). A modal drawn across the row
 * leaves box characters in it. The Agent Dashboard has its own field (`Enter:create` in its footer)
 * and /history's search reads `│ ?`.
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
  if (body !== "") return "draft";
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

/** Whether the pane's agent has a recognizer: without one, nothing here reads its screen. */
export function readsInputRow(agent: string | null | undefined): boolean {
  return agent != null && Object.hasOwn(RECOGNIZERS, agent);
}

/** What the screen shows of `agent`'s input row; null: no recognizer for that agent. A blank screen is `unknown`. */
export function inputRowState(agent: string | null | undefined, screen: ScreenSnapshot): InputRowState | null {
  if (!readsInputRow(agent)) return null;
  if (screen.rows.every((row) => row.text.trim() === "")) return "unknown";
  return RECOGNIZERS[agent!]!(screen);
}

// ---- when a frame may be read ---------------------------------------------------------------------

/** Where the stream stood when a chunk of it was handed to xterm (FrameGate.enqueue). */
export interface FrameStamp {
  readonly epoch: number;
  /** no synchronized-update block is open after this chunk: the screen is a whole frame once it is parsed */
  readonly boundary: boolean;
  /** the chunk closed a block it opened in this epoch, or the stream draws without blocks */
  readonly whole: boolean;
  /** the grid this terminal draws matched the pane's (pane-geometry) as the chunk came */
  readonly geometry: boolean;
}

const SYNC = /\u001b\[\?2026([hl])/g;

/**
 * Whether the screen xterm has parsed is a frame the recognizers may read. herdr wraps each frame
 * it draws in a synchronized-update block (`CSI ? 2026 h` … `l`). xterm 6 holds its drawing until a
 * block closes, but what it has parsed can still end inside one: a frame is read only once its
 * block has closed. A grid resized here (a fit, a phone peek's narrower grid, a pane's grid
 * adopted) holds the old screen until the agent draws again for the new one: from the resize on, nothing is read until a
 * whole frame has come for the new grid, written after the pane's grid said it was that size. When
 * the pane's grid itself changes size, herdr may first draw the old screen again, reflowed for the
 * new size (an idle box cut at its borders reads as gone), before the agent's own redraw, or both
 * may come as one frame: the first frame after it is `reflowing`, read when asked but never taken
 * as a change of screen. A stream drawn without blocks (a mirrored pane's whole screens) counts each
 * chunk as a frame.
 *
 * `enqueue` is called as a chunk is written (xterm parses later, in order), `settle` in its write
 * callback, `resized` on every resize of the grid, `reflowed` when the pane's grid changes size and
 * `reset` where the stream starts over.
 */
export class FrameGate {
  private open = false;
  private carry = "";
  private synced = false;
  private openedIn = -1;
  private epoch = 0;
  private settledEpoch = -1;
  private last = false;
  private reflow = false;
  private reflowFrame = false;

  enqueue(data: string, geometry: boolean): FrameStamp {
    const text = this.carry + data;
    let whole = false;
    for (const match of text.matchAll(SYNC)) {
      this.synced = true;
      if (match[1] === "h") { this.open = true; this.openedIn = this.epoch; }
      else { if (this.open && this.openedIn === this.epoch) whole = true; this.open = false; }
    }
    // an escape cut at the chunk's end is read again with the next chunk
    const escape = text.lastIndexOf("\u001b");
    const tail = escape < 0 ? "" : text.slice(escape);
    this.carry = tail.length < 8 && !/^\u001b\[\?2026[hl]/.test(tail) ? tail : "";
    return { epoch: this.epoch, boundary: !this.open, whole: whole || !this.synced, geometry };
  }

  /** after the chunk's parse; `ready`: the stream is current and the grid still matches the pane's */
  settle(stamp: FrameStamp, ready: boolean): boolean {
    let settled = ready && stamp.geometry && stamp.boundary && stamp.epoch === this.epoch;
    if (settled && this.settledEpoch !== this.epoch) {
      if (stamp.whole) this.settledEpoch = this.epoch;
      else settled = false;
    }
    // the first frame for the pane's new size: maybe herdr's reflow of the old screen, the agent's redraw after it
    this.reflowFrame = settled && this.reflow;
    if (settled) this.reflow = false;
    this.last = settled;
    return settled;
  }

  resized(): void {
    this.epoch++;
    this.last = false;
  }

  /** the pane's grid changed size (pane-geometry): the next frame that settles is `reflowing` */
  reflowed(): void {
    this.reflow = true;
    this.last = false;
  }

  /** the stream starts over (another pane, a reconnect, a terminal reset): a block it cut is gone */
  reset(): void {
    this.open = false;
    this.carry = "";
    this.synced = false;
    this.reflow = false;
    this.resized();
  }

  /** the screen as parsed so far is a settled frame: the last chunk settled, and nothing resized since */
  get current(): boolean {
    return this.last;
  }

  /**
   * The current frame is the first since the pane's grid changed size: possibly herdr's own redraw
   * of the old screen, reflowed. It may be read, but no screen opened or closed by it: a watched
   * peek neither arms nor comes back on it.
   */
  get reflowing(): boolean {
    return this.last && this.reflowFrame;
  }
}
