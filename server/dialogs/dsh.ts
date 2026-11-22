import type { DialogReader } from "./registry.ts";
import { ANSI_RE, KEY, cleanLine, findLastIndex, finishPrompt, joinWrapped, keySteps, navigationKeys, own, screenWidth, type ParsedPrompt } from "./shared.ts";

/**
 * DeepSeek Harness's `ask_user_question` panel, as dsh-tui 0.20.0 draws it
 * (lib/types/components/questions/AskUserQuestionPanel.js):
 *
 *   ─────────▾  📋 Question 1/2  · 2 left  ─────────
 *
 *   ◈ Platforms
 *   Which platforms should we test?
 *
 *   ❯○ iOS
 *    ○ Android
 *       optional description, dim
 *    ✎ Custom answer： Type directly…
 *
 *   ↑/↓ select · Space multi-select · Ctrl+V paste · Type text to attach an answer · Enter
 *   submit · Esc cancel · ←/→ switch question · Ctrl+K to fold / click the header
 *
 * A row is `<cursor><mark> label` with the cursor `❯` or a space and the mark `●`/`○` (one
 * choice) or `◉`/`○` (several); a description, and a label the pane wraps, go on two columns
 * further in. The last row is always the free-text row (`✎`), which typing on any row fills.
 * ↑/↓ move, Space ticks a row of a multiple choice, Enter answers the question (and goes on to the
 * next one of the batch), ←/→ switch questions without answering, Esc cancels.
 *
 * dsh-tui speaks English or Chinese (DSH_TUI_LANG, else the OS locale): both hints are read. A word
 * boundary (`\b`) never follows Chinese text, so the hints' words end at a space or the line's end.
 */
const DSH_HEADER_RE = /▾\s+📋\s*(?:Question\s+(\d+)\/(\d+)|提问\s*·\s*第\s*(\d+)\/(\d+)\s*题)/;
/** the option list's hint: its select key first, its cancel or previous-question key later */
const DSH_HINT_RE = /^(?:↑\/↓ select|↑\/↓ 选择)(?=\s|$).*(?:Esc (?:cancel|previous question)|Esc (?:中断|上一题))/;
const DSH_TYPING_HINT_RE = /^(?:Type answer|输入回答)(?=\s|$).*(?:Esc (?:cancel|previous question)|Esc (?:中断|上一题))/;
const DSH_MULTI_RE = /\bSpace (?:multi-select|多选)(?=\s|$)/;
const DSH_SWITCH_RE = /←\/→ (?:switch question|换题)|行首←\/行尾→ 换题|←\/→ at the text edge switches question/;
/** rows, from the free-text row's column: dsh sets the panel in two columns past the chat's own margin */
const DSH_ROW_RE = /^( *)([❯ ])([●○◉])\s(.+)$/;
/**
 * The free-text row: `✎`, its label, `：`, then what is typed. A typed text longer than the row squeezes the label into a
 * column of its own, its words on lines of their own (`✎ Custom     ：Use the…` over `   answer       runs…`).
 */
const DSH_CUSTOM_RE = /^( *)([❯ ])✎\s([^：]*)：(.*)$/;
/** the same row once a long typed text squeezes the `：` out of it: its label's first word, then the text */
const DSH_SQUEEZED_RE = /^( *)([❯ ])✎\s(\S+)\s{2,}(\S.*)$/;
/** the label, its spaces dropped: alone, or with an option's label attached (`(attached: …)`, `（附加：…）`) */
const DSH_LABEL_RE = /^(?:Customanswer|自定义回答)$/;
const DSH_ATTACHED_LABEL_RE = /^(?:Customanswer\(attached:.*|自定义回答（附加)$/;
const DSH_PLACEHOLDER_RE = /^\s*(?:Type directly…|直接输入…)$/;
const DSH_HINT_LINES = 4;
const DSH_HINT_END_RE = /(?:click the header|点标题行收起)$/;
/**
 * dsh-tui's own footer under the panel (screens/StatusLine.js): at most three rows, the context meter, the status fields
 * and the key hint, whatever its settings put in them (a ctx field or none, compact or not, a wake or a hover's detail).
 */
const DSH_FOOTER_ROWS = 3;
/**
 * a line of dsh-tui's conversation or its input box, which its footer never starts with; but for its status row's
 * background-jobs chip (`● 1 · high · …` with the model field off)
 */
const DSH_TRANSCRIPT_RE = /^(?!● \d+(?: ·|$))[╭╰│⌸●❯!⎿▾▴◈✎·]/;
/** the line saying how much of a long question dsh-tui folds out of view (i18n `question-detail-scroll`) */
const DSH_FOLD_RE = /^…\s+\d+\s+(?:lines?\s+outside view|行未显示)/;

/** What an answer types into the free-text row: one line (dsh-tui submits the row on Enter). */
export function dshTypedText(text: string): string {
  return text.replace(/\s*\r?\n\s*/g, " ").trim();
}

function atColumn(line: string, column: number): [string, string] {
  let width = 0;
  let at = 0;
  for (const char of line) {
    if (width >= column) break;
    width += Bun.stringWidth(char);
    at += char.length;
  }
  return [line.slice(0, at), line.slice(at)];
}

function hintAt(lines: string[], index: number): string {
  return lines.slice(index, index + DSH_HINT_LINES).map(cleanLine).filter(Boolean).join(" ");
}

interface DshPanel {
  prompt: ParsedPrompt;
  typed: string[] | null;
  typedFull: boolean[];
  /**
   * The cursor on the free-text row of a question no mark says is a multiple choice: a single choice marks no row
   * then, and neither does a multiple choice with nothing ticked, whose hint there names no Space either
   * (AskUserQuestionPanel.js), so `prompt` reads it as a single choice it may not be.
   */
  modeUnknown: boolean;
}

export function parseDshQuestion(screen: string): ParsedPrompt | null {
  const panel = readDshPanel(screen);
  // text typed in the terminal (or an option's label it attached) would go out with any answer the card sends:
  // the terminal finishes what it began there
  if (!panel || panel.modeUnknown || panel.typed?.join("") !== "") return null;
  return panel.prompt;
}

/**
 * The free-text row of the card's own single choice, with the cursor on it, as a typed answer leaves it: "typed"
 * when it holds exactly `text`, "typing" while it holds only the start of it (dsh-tui draws the text as it comes),
 * null on any other screen (another question, the panel gone, another option's label attached, other words in the row).
 */
export function dshFreeTextRow(screen: string, expected: ParsedPrompt, text: string): "typed" | "typing" | null {
  const panel = readDshPanel(screen);
  if (!panel?.typed || expected.multi_select || panel.prompt.multi_select || panel.prompt.id !== expected.id
    || panel.prompt.selectedIndex !== panel.prompt.options.length || !dshQuestionActive(screen)) return null;
  // a wrapped line may drop or keep the space it broke at
  // dsh wraps at a space and drops it: exactly one space between two lines, but none or one under a line that
  // reaches the row's end (a word broken there, or one that ends right there)
  let pieces = "";
  let fullAbove = false;
  panel.typed.forEach((piece, at) => {
    if (!piece) return;
    const escaped = piece.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    pieces += pieces ? `${fullAbove ? " ?" : " "}${escaped}` : escaped;
    fullAbove = panel.typedFull[at] === true;
  });
  if (new RegExp(`^${pieces}$`).test(text)) return "typed";
  return new RegExp(`^${pieces}`).test(text) ? "typing" : null;
}

function readDshPanel(screen: string): DshPanel | null {
  const lines = screen.replace(ANSI_RE, "").split(/\r?\n/).map((line) => line.trimEnd());
  const headerIndex = findLastIndex(lines, (line) => DSH_HEADER_RE.test(line));
  if (headerIndex < 0) return null;
  const header = DSH_HEADER_RE.exec(lines[headerIndex]!)!;
  const n = Number(header[1] ?? header[3]);
  const total = Number(header[2] ?? header[4]);
  if (!Number.isInteger(n) || !Number.isInteger(total) || n < 1 || total < n) return null;

  const customIndex = lines.findIndex((line, index) => index > headerIndex && (DSH_CUSTOM_RE.test(line) || DSH_SQUEEZED_RE.test(line)));
  if (customIndex < 0) return null;
  const colon = DSH_CUSTOM_RE.exec(lines[customIndex]!);
  const custom = colon ?? DSH_SQUEEZED_RE.exec(lines[customIndex]!)!;
  const indent = custom[1]!;
  const customCursor = custom[2] === "❯";
  // typed text the pane wraps goes on under the row's text, from the column after `：`, the label's words under the label
  const textColumn = Bun.stringWidth(lines[customIndex]!) - Bun.stringWidth(custom[4]!);
  let typedEnd = customIndex + 1;
  while (typedEnd < lines.length && lines[typedEnd]!.startsWith(`${indent}   `) && lines[typedEnd]!.trim()) typedEnd += 1;
  const wrapped = lines.slice(customIndex + 1, typedEnd).map((line) => atColumn(line, textColumn));
  const label = [custom[3]!, ...wrapped.map(([before]) => before)].join("").replace(/\s/g, "");
  if (!DSH_LABEL_RE.test(label) && !DSH_ATTACHED_LABEL_RE.test(label)) return null;
  // the hint follows the free-text row (a multiple choice's Submit row may stand between them)
  const hintIndex = lines.findIndex((line, index) => index >= typedEnd && index < typedEnd + 4
    && (DSH_HINT_RE.test(hintAt(lines, index)) || DSH_TYPING_HINT_RE.test(hintAt(lines, index))));
  if (hintIndex < 0) return null;
  const hint = hintAt(lines, hintIndex);
  const text = custom[4]!;
  const typed = !DSH_LABEL_RE.test(label) ? null
    : [!customCursor && DSH_PLACEHOLDER_RE.test(text) ? "" : text.trim(), ...wrapped.map(([, after]) => after.trim())];
  // the row ends one cell short of the header's divider (the caret takes the last one), two with the `：` squeezed out
  // (recorded on 0.20.0 at 101-118 columns). A line is full when the next line's first character would not have
  // fitted after it: a wide (CJK) one leaves a cell
  const rowEnd = Bun.stringWidth(lines[headerIndex]!) - (colon ? 1 : 2);
  const typedFull = lines.slice(customIndex, typedEnd).map((line, at) => {
    const next = typed?.slice(at + 1).find(Boolean);
    return next !== undefined && Bun.stringWidth(line) + Bun.stringWidth([...next][0]!) > rowEnd;
  });
  const rows: { cursor: boolean; checked: boolean; ticked: boolean; head: string; rest: string[] }[] = [];
  let firstRow = -1;
  let rest: string[] = [];
  for (let index = customIndex - 1; index > headerIndex; index -= 1) {
    const line = lines[index]!;
    const row = DSH_ROW_RE.exec(line);
    if (row && row[1] === indent) {
      rows.unshift({ cursor: row[2] === "❯", checked: row[3] === "●" || row[3] === "◉", ticked: row[3] === "◉", head: row[4]!.trim(), rest });
      rest = [];
      firstRow = index;
      continue;
    }
    // a focused row stands apart by one blank line (marginTop), which a continuation never does
    if (!line.trim()) continue;
    if (line.startsWith(`${indent}   `) && /\S/.test(line)) { rest.unshift(line); continue; }
    break;
  }
  if (rows.length === 0 || firstRow < 0 || rest.length > 0) return null;
  const cursors = rows.filter((row) => row.cursor).length + (customCursor ? 1 : 0);
  if (cursors !== 1) return null;
  // each row has its own hint: the option list's, or the free-text row's with the cursor on it
  if (customCursor !== DSH_TYPING_HINT_RE.test(hint)) return null;

  // the free-text row's hint names no Space: a multiple choice is told by its ticks there, in the rows' mark column (an
  // option's words may hold a `◉` of their own)
  const multi = DSH_MULTI_RE.test(hint) || rows.some((row) => row.ticked || (row.checked && !row.cursor));
  const modeUnknown = customCursor && !multi;
  // a single choice marks the cursor's row alone, and none while the cursor is on the free-text row
  if (!multi && rows.some((row) => row.checked !== row.cursor)) return null;

  // the header chip (`◈ Platforms`), the question, then a blank line and the question's detail; a long question and
  // detail fold into a window with a line saying how much of them is hidden (`… 16 lines outside view · Alt+Up/Alt+Down
  // to scroll`): the card would ask it cut short, so the terminal, which scrolls it, answers it
  const paragraphs: string[][] = [];
  let chip: string | null = null;
  let blank = true;
  for (const raw of lines.slice(headerIndex + 1, firstRow)) {
    const line = cleanLine(raw);
    if (!line) { blank = true; continue; }
    if (chip === null && paragraphs.length === 0 && line.startsWith("◈ ")) { chip = line.slice(2).trim(); continue; }
    if (DSH_FOLD_RE.test(line)) return null;
    if (blank) paragraphs.push([]);
    paragraphs.at(-1)!.push(raw);
    blank = false;
  }
  const width = screenWidth(lines);
  const question = joinWrapped(paragraphs[0] ?? [], width);
  if (!question) return null;
  const detail = paragraphs.slice(1).map((lines) => joinWrapped(lines, width)).filter(Boolean).join("\n");
  const body = [chip, detail].filter(Boolean).join("\n") || null;

  // Plain text cannot tell a label's wrapped rest from a description (only dsh's dim colour does).
  const options = rows.map((row) => {
    if (row.rest.length === 0) return { label: row.head, description: null };
    return { label: row.head, description: joinWrapped(row.rest, width) || null };
  });
  const selectedIndex = customCursor ? rows.length : rows.findIndex((row) => row.cursor);
  const checked = rows.flatMap((row, index) => multi && row.checked ? [index] : []);
  const at = n - 1;
  const switches = total > 1 && DSH_SWITCH_RE.test(hint);
  const back = switches && at > 0;
  const next = switches && at < total - 1;
  const title = total > 1 ? own("Question {n} of {total}", { n: String(n), total: String(total) }) : own("Question");

  const prompt = finishPrompt("dsh-tui", {
    kind: "question",
    title,
    question,
    body,
    options,
    multi_select: multi,
    custom_option_index: multi ? null : options.length,
    ...(checked.length > 0 ? { default_option_indices: checked } : {}),
    ...(back ? { can_step_back: true } : {}),
    ...(next ? { can_step_next: true } : {}),
  }, {
    ...(back || next ? { nativeSteps: { identity: `dsh:${total}`, index: at, count: total, next: KEY.right, previous: KEY.left } } : {}),
    responder: "dsh-question",
    menuLabels: [...options.map((option) => option.label), "Custom answer"],
    selectedIndex,
    checkedOptionIndices: checked,
    customMenuIndex: multi ? null : options.length,
    rejectWithEscapeIndex: null,
    // Enter on the free-text row with nothing typed only says to type first: the text goes in
    // once the cursor is there, then Enter sends it (measured on dsh-tui 0.20.0)
    customSteps: (text: string) => [
      ...keySteps(navigationKeys(options.length - selectedIndex)),
      { text: dshTypedText(text) },
      ...keySteps([KEY.enter]),
    ],
    ...(multi ? {
      multiSteps: (picked: number[]) => {
        const want = new Set(picked);
        let cursor = selectedIndex;
        const keys: string[] = [];
        for (const index of options.keys()) {
          if (want.has(index) === checked.includes(index)) continue;
          keys.push(...navigationKeys(index - cursor), KEY.space);
          cursor = index;
        }
        // Enter on the free-text row with nothing typed asks for text instead of submitting the ticks
        if (cursor === options.length) keys.push(KEY.up);
        return keySteps([...keys, KEY.enter]);
      },
    } : {}),
  }, { default_option_indices: undefined, can_step_back: undefined, can_step_next: undefined });
  return { prompt, typed, typedFull, modeUnknown };
}

/**
 * Whether the panel's hint is the last thing on the screen but dsh-tui's own footer: a panel-shaped text with
 * anything else under it (later output, dsh's input box) asks nothing.
 */
export function dshQuestionActive(screen: string): boolean {
  const lines = screen.replace(ANSI_RE, "").split(/\r?\n/).map(cleanLine).filter(Boolean);
  // the hint, as many lines as the pane wrapped it onto, ends with its own last words right over the footer: dsh's
  // input box and its conversation, under a panel already answered, are more rows than the footer has and start apart
  for (let end = lines.length - 1; end >= Math.max(0, lines.length - 1 - DSH_FOOTER_ROWS); end -= 1) {
    if (lines.slice(end + 1).some((line) => DSH_TRANSCRIPT_RE.test(line))) return false;
    for (let start = end; start >= Math.max(0, end - DSH_HINT_LINES + 1); start -= 1) {
      const hint = lines.slice(start, end + 1).join(" ");
      if ((DSH_HINT_RE.test(hint) || DSH_TYPING_HINT_RE.test(hint)) && DSH_HINT_END_RE.test(hint)) return true;
    }
  }
  return false;
}

export const readers: readonly DialogReader[] = [{
  id: "dsh-question",
  agents: ["dsh-tui"],
  priority: 10,
  // the cursor is read off the screen: a row moved to in the terminal since the card was drawn is looked at again before Enter
  reread: "before-commit",
  list: "none",
  parse: (screen) => parseDshQuestion(screen),
}];
