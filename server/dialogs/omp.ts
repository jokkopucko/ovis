import type { DialogReader } from "./registry.ts";
import { pickerPlan } from "./interaction-plan.ts";
import { piActiveTab } from "./pi-ask-tabs.ts";
import { type InteractivePromptAnswer } from "../../shared/protocol.ts";
import { ANSI_RE, KEY, type MenuRow, type ParsedPrompt, cleanLine, findLastIndex, finishPrompt, isDivider, own, keySteps, navigationKeys, nearestQuestion, normalizeText, wrapped } from "./shared.ts";

const OMP_OPTION_MARKER_RE = /^([ \t]*)(?:[❯›>]\s*)?([○●◉◯☐☑☒✓])/;

export const OMP_SINGLE_HINT_RE = /(?:enter|⏎)\s+select.*↑\/↓\s*move.*(?:esc|⎋)\s*cancel/i;

// A legacy single-question footer can clip after the Tab keys or inside the cancel label.
export const OMP_SINGLE_CLIPPED_HINT_RE = /enter select.*n note.*↑\/↓ move.*(?:tab\/←\/→|esc(?: c(?:a(?:n(?:c(?:e(?:l)?)?)?)?)?)?)(?:…|\.{3})$/i;

// A narrow footer can cut the question-navigation word at any letter, followed by an ellipsis.
export const OMP_CLIPPED_SINGLE_HINT_RE = /(?:enter|⏎)\s+select.*\bn\s+note.*↑\/↓\s*move.*(?:tab|⇥).*\b(?:question…?|(?:q|qu|que|ques|quest|questi|questio)…)(?=\s|$)/i;

export const OMP_MULTI_HINT_RE = /(?:space\/enter toggle|(?:space|␠|␣)\s+toggle.*(?:enter|⏎)\s+(?:submit|next)).*↑\/↓\s*move.*(?:esc|⎋)\s*cancel/i;

// A narrow multi-select footer clips inside the cancel label after its question keys (omp 18.12.6 at 60 columns: `⎋ cance…`).
export const OMP_MULTI_CLIPPED_HINT_RE = /(?:space|␠|␣)\s+toggle.*(?:enter|⏎)\s+(?:submit|next).*↑\/↓\s*move.*(?:esc|⎋)(?:\s+c(?:a(?:n(?:c(?:e(?:l)?)?)?)?)?)?(?:…|\.{3})(?=\s|$)/i;

export const OMP_REVIEW_HINT_RE = /(?:enter|⏎)\s+submit.*↑\/↓\s*scroll.*(?:esc|⎋)\s*cancel/i;

/** omp shows a question in at most this many rows, the last one cut with `…` (pi-tui ask-dialog.ts `MAX_HEADER_ROWS`) */
const OMP_QUESTION_ROWS = 4;

const OMP_EXPAND_HINT_RE = /\s\u00b7\s\S+\sexpand(?:\s\u00b7|$)/;

export const OMP_TABS_HINT_RE = /(?:tab|⇥).*?(?:←|left).*?(?:→|right)|(?:←|left).*?(?:→|right).*?(?:tab|⇥)/i;

/** OMP options have a marker; their descriptions and wrapped labels are indented below them. */
function parseOmpRows(lines: string[], startDivider: number, endDivider: number): MenuRow[] | null {
  const rows: MenuRow[] = [];
  const marker = "○●◉◯☐☑☒✓";
  const selectedRows = lines.slice(startDivider + 1, endDivider).map((line, index) => {
    const raw = line.replace(ANSI_RE, "").replace(/^\s*│/, "").replace(/│\s*$/, "");
    const match = raw.match(/^\s*(?:❯|›|>)\s*[○●◉◯☐☑☒✓]/);
    return match ? { raw, lineIndex: startDivider + 1 + index, markerColumn: match[0].search(/[○●◉◯☐☑☒✓]/) } : null;
  }).filter((row): row is { raw: string; lineIndex: number; markerColumn: number } => row !== null);
  if (selectedRows.length !== 1) return null;
  const markerColumn = selectedRows[0]!.markerColumn;
  for (let index = startDivider + 1; index < endDivider; index += 1) {
    const raw = lines[index]!.replace(ANSI_RE, "").replace(/^\s*│/, "").replace(/│\s*$/, "");
    const prefix = raw.slice(0, markerColumn);
    const glyph = raw[markerColumn] ?? "";
    const option = marker.includes(glyph) && (/^\s*$/.test(prefix) || /^\s*(?:❯|›|>)\s*$/.test(prefix));
    if (option) {
      const label = normalizeText(raw.slice(markerColumn + 1));
      if (label) rows.push({
        label, selected: /(?:❯|›|>)\s*$/.test(prefix), checked: /^[☑☒✓]/.test(glyph), lineIndex: index,
      });
      continue;
    }
    const row = rows.at(-1);
    if (!row) continue;
    const description = raw.match(/^\s*↳\s*(.*)$/);
    const indentation = raw.match(/^\s*/)?.[0].length ?? 0;
    const continuation = raw.trim();
    if (description) row.description = normalizeText([row.description, description[1]!].filter(Boolean).join(" "));
    else if (row.description && indentation >= markerColumn + 4 && continuation) row.description = normalizeText(`${row.description} ${continuation}`);
    else if (!row.description && indentation >= markerColumn + 4 && continuation) row.description = normalizeText(continuation);
    else if (!row.description && indentation >= markerColumn + 2 && continuation) row.label = normalizeText(`${row.label} ${continuation}`);
    else if (continuation) return null;
  }
  return rows;
}

/** The question, and how many rows it takes in the panel (0 when it is not read from the panel's header). */
function ompQuestionText(lines: string[], startDivider: number, hasQuestionTabs: boolean): { text: string | null; rows: number } {
  const panelTop = findLastIndex(lines, (_, index) => index < startDivider && /^\s*╭/.test(lines[index]!));
  const headerDivider = panelTop >= 0 ? panelTop
    : findLastIndex(lines, (_, index) => index < startDivider && isDivider(lines[index]!));
  if (headerDivider < 0) return { text: nearestQuestion(lines, startDivider), rows: 0 };
  const headerRows = lines.slice(headerDivider + 1, startDivider);
  // With question navigation, OMP draws its tab bar before the question title. Drop its leading
  // rows by position and the tab cells' extra left padding, not by their text: the strip can wrap
  // to one cell per row or clip its final tab, and the question can itself end in `Submit`.
  const firstHeaderRow = headerRows.findIndex((line) => cleanLine(line));
  let tabRows = 0;
  if (hasQuestionTabs) {
    for (let index = firstHeaderRow; index >= 0 && index < headerRows.length; index += 1) {
      if (!isOmpTabStripRow(headerRows[index]!)) break;
      tabRows += 1;
      if (isOmpSubmitTabRow(headerRows[index]!)) break;
    }
  }
  const header = headerRows.map((line, index) => ({ line: cleanLine(line), index })).filter(({ line, index }) => line
    && !(hasQuestionTabs && index >= firstHeaderRow && index < firstHeaderRow + tabRows)
    && !/^[←→].*Submit/i.test(line) && !/^[☐☑✔]\s+\S/.test(line) && !/^Question \d+\/\d+/i.test(line)).map(({ line }) => line);
  if (header.length === 0) return { text: nearestQuestion(lines, startDivider), rows: 0 };
  const shown = headerRows.slice(Math.max(firstHeaderRow, 0) + tabRows);
  while (shown.length > 0 && !cleanLine(shown.at(-1)!)) shown.pop();
  return { text: normalizeText(header.join(" ")), rows: shown.length };
}

/** The panel adds one space; TabBar cells start with one space, plus a wrapped separator when present. */
function isOmpTabStripRow(rawLine: string): boolean {
  const raw = ompTabRowText(rawLine);
  const indentation = raw.match(/^\s*/)?.[0].length ?? 0;
  return (indentation === 2 || indentation === 4) && Boolean(raw.trim());
}

/** Stop at the final visible tab so following indented question text is never consumed as tabs. */
function isOmpSubmitTabRow(rawLine: string): boolean {
  const cells = ompTabRowText(rawLine).trim().split(/\s{2,}/).map((cell) => cell.trim());
  return cells.at(-1) === "Submit";
}

function ompTabRowText(rawLine: string): string {
  return rawLine.replace(ANSI_RE, "").replace(/^\s*│/, "").replace(/│\s*$/, "");
}

/** Only complete, independently styled TabBar cells prove stops; clipped/plain strips do not. */
function ompSteps(screen: string, before: number) {
  const lines = screen.split(/\r?\n/);
  const top = findLastIndex(lines, (line, index) => index < before && /^\s*╭/.test(line.replace(ANSI_RE, "")));
  if (top < 0) return null;
  const strip: string[] = [];
  for (let at = top + 1; at < before; at++) {
    const line = lines[at];
    if (line === undefined || !isOmpTabStripRow(line)) break;
    strip.push(line.slice(line.indexOf("│") + 1, line.lastIndexOf("│")));
    if (isOmpSubmitTabRow(line)) break;
  }
  const raw = strip.join("\n");
  const cell = /(?:\x1b\[[0-9;]*m)+ ([^\x1b\r\n]+?) (?:\x1b\[[0-9;]*m)+/g;
  const cells = [...raw.matchAll(cell)];
  if (raw.replace(cell, "").replace(ANSI_RE, "").trim()) return null;
  const labels = cells.map(match => match[1]?.trim() ?? "");
  if (labels.length < 2 || labels.at(-1) !== "Submit" || labels.some(label => !label || /…|\.\.\./.test(label))
    || new Set(labels).size !== labels.length) return null;
  let offset = 0;
  const plain = raw.replace(ANSI_RE, "");
  const markers = labels.map(label => {
    const at = plain.indexOf(` ${label} `, offset) + 1;
    offset = at + label.length;
    return at;
  });
  const index = piActiveTab(raw, markers);
  if (index === null) return null;
  return {
    // The strip has no answered markers: leave steps unmarked unless review rows prove an answer.
    // the review (Submit, last) draws no question of the call, so a move to it cannot be checked: questions only
    steps: labels.map((label, at) => ({ label, answered: false, current: at === index, can_navigate: at !== index && at < labels.length - 1 })),
    can_step_back: index > 0,
    can_step_next: index < labels.length - 2,
    nativeSteps: { identity: JSON.stringify(labels), index, count: labels.length, next: KEY.tab, previous: KEY.backtab },
  };
}

const OMP_REVIEW_ROW_RE = /^\d+\.\s+(.*?):(?:\s+(.*))?$/;

const OMP_REVIEW_NOTE_RE = /^Note:\s*(.*)$/;

/**
 * omp's review: a row per question (`1. Transport: Remote relay`), a `Note: …` under an answer
 * given one. omp cuts a long row at the pane's edge instead of wrapping it. Null when a line is
 * neither, so the panel is shown as drawn.
 */
function ompReviewAnswers(panel: string[]): InteractivePromptAnswer[] | null {
  const answers: InteractivePromptAnswer[] = [];
  for (const line of panel) {
    const row = OMP_REVIEW_ROW_RE.exec(line);
    const note = OMP_REVIEW_NOTE_RE.exec(line);
    if (row) answers.push({ question: row[1]!.trim(), answer: row[2]?.trim() || null });
    else if (note && answers.length > 0 && answers.at(-1)!.note === undefined) answers.at(-1)!.note = note[1]!.trim();
    // the warning over the rows ("1 unanswered question; Enter still submits.") stays the body
    else if (answers.length > 0) return null;
  }
  return answers.length > 0 ? answers : null;
}

/** The Submit tab is a separate review state: Enter submits, Esc cancels the native dialog. */
function parseOmpSubmit(screen: string): ParsedPrompt | null {
  const lines = screen.replace(ANSI_RE, "").split(/\r?\n/);
  const hintIndex = findLastIndex(lines, (_, index) => OMP_REVIEW_HINT_RE.test(wrapped(lines, index)));
  if (hintIndex < 0) return null;
  const panelTop = findLastIndex(lines, (_, index) => index < hintIndex && /^\s*╭/.test(lines[index]!));
  if (panelTop < 0) return null;
  const heading = findLastIndex(lines, (line, index) => index > panelTop && index < hintIndex && cleanLine(line) === "Review answers");
  if (heading < 0) return null;
  const submitRows = lines.flatMap((line, index) => {
    if (index <= heading || index >= hintIndex) return [];
    return /^\s*[❯›>]\s*Submit\s*$/i.test(cleanLine(line)) ? [index] : [];
  });
  if (submitRows.length !== 1) return null;
  const submitRow = submitRows[0]!;
  const panel = lines.slice(heading + 1, submitRow).map(cleanLine).filter((line) => line && !isDivider(line));
  const answers = ompReviewAnswers(panel);
  // without answers read, the panel as it is drawn; with them, only what is not an answer (the
  // unanswered-questions warning)
  const body = (answers ? panel.filter((line) => !OMP_REVIEW_ROW_RE.test(line) && !OMP_REVIEW_NOTE_RE.test(line)) : panel).join("\n");
  const navigation = ompSteps(screen, heading);
  return finishPrompt("omp", {
    kind: "menu", title: own("Review answers"), question: own("Submit these answers?"), body: body || null,
    ...(answers ? { answers } : {}),
    options: [{ label: own("Submit"), description: null }, { label: own("Cancel"), description: null }],
    multi_select: false, custom_option_index: null,
    ...(navigation ? {
      steps: navigation.steps.map(step => ({ ...step, answered: answers?.some(answer => answer.question === step.label
        && answer.answer !== null && answer.answer !== "unanswered" && !/…|\.\.\./.test(answer.answer)) ?? false })),
      can_step_back: navigation.can_step_back, can_step_next: navigation.can_step_next,
    } : {}),
  }, {
    ...(navigation ? { nativeSteps: navigation.nativeSteps } : {}),
    responder: "omp-submit", menuLabels: ["Submit", "Cancel"], selectedIndex: 0,
    checkedOptionIndices: [], customMenuIndex: null, rejectWithEscapeIndex: 1,
    // where the review stands among the tabs comes and goes with the colours read: not part of the card's id
  }, { steps: undefined, can_step_back: undefined, can_step_next: undefined });
}

/** A clipped legacy footer is enough to identify a menu only when every parsed row
 * starts with an option marker in the cursor row's physical column. */
function ompRowsHaveAlignedMarkers(lines: string[], rows: MenuRow[]): boolean {
  const markerColumn = (lineIndex: number): number | null => {
    let line = lines[lineIndex]?.replace(ANSI_RE, "") ?? "";
    if (line.startsWith("│")) line = line.slice(1);
    const match = OMP_OPTION_MARKER_RE.exec(line);
    return match ? match[1]!.length + (match[0].length - match[1]!.length - match[2]!.length) : null;
  };
  const selected = rows.filter((row) => row.selected);
  if (selected.length !== 1) return false;
  const selectedColumn = markerColumn(selected[0]!.lineIndex);
  return selectedColumn !== null && rows.every((row) => markerColumn(row.lineIndex) === selectedColumn);
}

function findMenuDividers(lines: string[], hintIndex: number): [number, number] | null {
  let end = -1;
  for (let index = hintIndex - 1; index >= 0; index -= 1) {
    if (!isDivider(lines[index]!)) continue;
    if (end < 0) end = index;
    else return [index, end];
  }
  return null;
}

function parseOmpQuestion(screen: string): ParsedPrompt | null {
  const lines = screen.replace(ANSI_RE, "").split(/\r?\n/);
  const clippedHintIndex = findLastIndex(lines, (_, index) => OMP_SINGLE_CLIPPED_HINT_RE.test(wrapped(lines, index)));
  const hintIndex = findLastIndex(lines, (_, index) => OMP_SINGLE_HINT_RE.test(wrapped(lines, index))
    || OMP_CLIPPED_SINGLE_HINT_RE.test(wrapped(lines, index)) || OMP_SINGLE_CLIPPED_HINT_RE.test(wrapped(lines, index)) || OMP_MULTI_HINT_RE.test(wrapped(lines, index))
    || OMP_MULTI_CLIPPED_HINT_RE.test(wrapped(lines, index)));
  if (hintIndex < 0) return null;
  const dividers = findMenuDividers(lines, hintIndex);
  if (!dividers) return null;
  const [startDivider, endDivider] = dividers;
  const rows = parseOmpRows(lines, startDivider, endDivider);
  if (!rows) return null;
  const selectedIndex = rows.findIndex((row) => row.selected);
  if (rows.filter((row) => row.selected).length !== 1) return null;
  const customIndex = rows.findIndex((row) => /^Other \(type your own\)$/i.test(row.label));
  const optionRows = rows.filter((_, index) => index !== customIndex);
  const hint = wrapped(lines, hintIndex);
  const multiSelect = OMP_MULTI_HINT_RE.test(hint) || OMP_MULTI_CLIPPED_HINT_RE.test(hint);
  const currentMulti = /(?:space|␠|␣)\s+toggle.*(?:enter|⏎)\s+(?:submit|next)/i.test(hint);
  const { text: question, rows: questionRows } = ompQuestionText(lines, startDivider, OMP_TABS_HINT_RE.test(hint));
  const navigation = OMP_TABS_HINT_RE.test(hint) ? ompSteps(screen, startDivider) : null;
  if (!question || selectedIndex < 0 || optionRows.length === 0 || customIndex !== rows.length - 1
    || (hintIndex === clippedHintIndex && !ompRowsHaveAlignedMarkers(lines, rows))) return null;
  return finishPrompt("omp", {
    kind: "question", title: own(multiSelect ? "Multiple choice" : "Question"), question, body: null,
    options: optionRows.map((row) => ({ label: row.label.replace(/ \(Recommended\)$/i, ""), description: row.description ?? null })),
    multi_select: multiSelect, custom_option_index: multiSelect ? null : optionRows.length,
    ...(navigation ? { steps: navigation.steps, can_step_back: navigation.can_step_back, can_step_next: navigation.can_step_next } : {}),
  }, {
    ...(navigation ? { nativeSteps: navigation.nativeSteps } : {}),
    responder: "omp-question", menuLabels: rows.map((row) => row.label), selectedIndex,
    // omp offers `<key> expand` only for a question past its four rows or a description past its two
    // (pi-tui ask-dialog.ts `#expandHint`, 18.12.6 to 18.13.2); a footer cut short shows neither
    ...(questionRows === OMP_QUESTION_ROWS && OMP_EXPAND_HINT_RE.test(hint) ? { ompQuestionCut: true as const } : {}),
    checkedOptionIndices: optionRows.flatMap((row, index) => row.checked ? [index] : []),
    customMenuIndex: customIndex, rejectWithEscapeIndex: null,
    // OMP's Other row opens its own text prompt on Enter. The ordinary Enter in
    // the question dialog selects an option, so keep the activation step explicit.
    ...(!multiSelect ? { customSteps: (text: string) => [
      ...keySteps(navigationKeys(customIndex - selectedIndex)),
      ...keySteps([KEY.enter]), { text }, ...keySteps([KEY.enter]),
    ] } : {}),
    ...(currentMulti ? { multiSteps: (choices: number[]) => {
      const desired = new Set(choices);
      const checked = new Set(optionRows.flatMap((row, index) => row.checked ? [index] : []));
      const toggles = optionRows.flatMap((_, index) => desired.has(index) !== checked.has(index) ? [index] : []);
      let cursor = selectedIndex;
      const keys: string[] = [];
      for (const index of toggles) {
        keys.push(...navigationKeys(index - cursor), KEY.space);
        cursor = index;
      }
      // Current OMP advances/finishes the active question on Enter. Tab changes
      // the active question and would make that Enter answer a different row.
      // Enter on the Other row opens its text editor instead of advancing.
      if (cursor === customIndex) keys.push(KEY.up);
      keys.push(KEY.enter);
      return keySteps(keys);
    } } : {}),
    // the steps come and go with the colours read and the call found: not part of the card's id
  }, { steps: undefined, can_step_back: undefined, can_step_next: undefined });
}

/**
 * omp's tool approval since 18.10 (`ApprovalDialogComponent`), in the composer's place. 18.10 draws
 * only the call and a hint naming the keys; 18.13 adds a menu of choices and mounts the composer
 * (its status row and frame) under the panel —
 *
 *   ╭─ Allow tool: bash ─────────────────────╮     ╭─ Allow tool: bash ───────────────────────────────╮
 *   │ Command: ls -la                        │     │ Command: ls -la                                  │
 *   ├────────────────────────────────────────┤     │ ❯ Approve                                        │
 *   │ Ctrl+⏎/Ctrl+Q approve · ⎋ deny         │     │   Approve bash for this session                  │
 *   ╰────────────────────────────────────────╯     │   Deny                                           │
 *                                                  ├──────────────────────────────────────────────────┤
 *                                                  │ ↑/↓ choose · ⏎ select · Ctrl+⏎/Ctrl+Q approve ·… │
 *                                                  ╰──────────────────────────────────────────────────╯
 *
 * The keys are the user's bindings, drawn in the theme's symbol preset: words (`Ctrl+Enter`, `Esc`),
 * keycaps (`⌃⏎`, `⎋`) or Nerd Font icons; the ascii preset also draws the box in `+-|`. A countdown
 * adds `(Ns)` to the title. Not read: details taller than the panel, which scroll (the card would show
 * part of the call), and a draft in the composer, which turns Enter into "deny and send"; the terminal
 * answers those. A narrow pane cuts 18.13's hint: read only while the approve keys are still whole, since omp
 * takes them before any other key (bound to Enter, the select on Deny would approve). Deny is then answered
 * by moving to it, while fewer details than omp scrolls at show that none are hidden.
 *
 * omp cuts a detail at the panel's edge or past its length (`[…120ch elided…]`) and summarizes a multi-line one
 * (`… +2 lines in the tool call`, or 18.13's one row ending ` …`): two calls could then draw the same panel, and
 * a card read for one would answer the other. So is ast_edit's `+N more ops` (its first rewrite only): none of
 * them is a card. Not the screen above it either: omp keeps redrawing the transcript there (a running tool's
 * elapsed time) while it waits.
 * Known limit: some tools never show their whole call (edit names only the files, lsp and debug the action and
 * target), so two calls to them draw the same panel. A card read for the first answers the second only when
 * the first was answered in the terminal and the second drawn before the card was read again.
 */
const OMP_DETAIL_CUT_RE = /…|\bin the tool call$|(?:^|· )\+\d+ more ops?(?: ·|$)/;
/** a key may hold a space: the Nerd Font preset joins a modifier icon to its key with one (`\u{f0634} O`, Ctrl+O on macOS) */
const OMP_APPROVAL_HINT_RE = /^(?:(\S+) choose · (\S.*?) select · )?(\S.*?) approve · (\S.*?) deny(?: · \S.*? (?:details|less))?( · \S.*? scroll)?( · type to deny and steer)?$/;
const OMP_APPROVAL_CLIPPED_HINT_RE = /^(\S+) choose · (\S.*?) select · (\S.*?) approve · .*…$/;
/** omp scrolls the details past this many rows (`PREVIEW_LIMITS.COLLAPSED_ITEMS`, 18.10 to 18.13) */
const OMP_APPROVAL_DETAIL_ROWS = 8;
const OMP_APPROVAL_TOP_RE = /^(?:╭─|\+-) (Allow tool: .*?\S)(?: \(\d+s\))? (?:─+╮|-+\+)$/;
const OMP_PANEL_RULE_RE = /^(?:├─+┤|╰─+╯|\+-+\+)$/;
const OMP_PANEL_ROW_RE = /^[│|] ?(.*?)\s*[│|]$/;
/**
 * The composer 18.13 mounts under the panel, empty, as each built-in `composer.shape` draws it (pi-tui
 * `components/composer/*.ts` and `components/editor.ts`, 18.13.2), its rows trimmed. The frame is drawn in the theme's
 * box glyphs (`+-|` in the ascii symbol preset); the prompt's `╰─ ` and `❯ ` and the field and rail caps are always
 * these. With `showHardwareCursor: false` the empty prompt holds omp's own cursor (`▏`, ascii `|`). `null` is the
 * status row, whose text the user's status-line settings choose: read by its place and the space omp pads each
 * segment group with (OMP_STATUS_ROW_RE). With no segments at all, omp leaves the row out, and the gap over it.
 * A shape an extension adds, a hook's status line under the bar, a draft in the prompt (omp then also redraws the hint
 * and the Deny row), or anything else under the panel matches none: the terminal answers.
 */
const CURSOR = "(?: [▏|])?";
/** a rule as omp draws one, across the pane: a run of its glyphs, never a word that holds some (`-rw-r--r--`) */
const OMP_RULE = /^(?:─{4,}|-{4,})$/u;
/** a top rule (claude, rule): its run of glyphs, then the status' right group when it rides the rule, then the rule's last glyph */
const OMP_STATUS_RULE = /^(?:─{4,}(?:[^─].*)?─|-{4,}(?:[^-].*)?-)$/u;
/** the box's top border: a rule out of each corner, in one glyph set, the status between */
const OMP_BOX_TOP = /^(?:╭─.*─╮|\+-.*-\+)$/u;
const OMP_PROMPT = new RegExp(`^❯${CURSOR}$`, "u");
const OMP_COMPOSERS: readonly (readonly (RegExp | null)[])[] = [
  // band (the default): the status band (an empty row without one), then the prompt's gutter
  [null, new RegExp(`^╰─${CURSOR}$`, "u")],
  [/^$/u, new RegExp(`^╰─${CURSOR}$`, "u")],
  // box: the status in the top border, then the prompt row merged into the bottom border; with IME-safe cursor
  // layout, the prompt row on its own over a whole bottom border
  [OMP_BOX_TOP, /^(?:╰─? +(?:[▏|] *)?─?╯|\+-? +(?:[▏|] *)?-?\+)$/u],
  [OMP_BOX_TOP, /^[│|](?: [▏|])?$/u, /^(?:╰─+╯|\+-+\+)$/u],
  // claude: a top rule, the prompt, a closing rule, the status' left group
  [OMP_STATUS_RULE, OMP_PROMPT, OMP_RULE, null],
  [OMP_STATUS_RULE, OMP_PROMPT, OMP_RULE],
  // rule: a top rule, the prompt, a gap, the status' left group
  [OMP_STATUS_RULE, OMP_PROMPT, /^$/u, null],
  [OMP_STATUS_RULE, OMP_PROMPT],
  // pi: the prompt between two rules, then the status
  [OMP_RULE, /^[▏|]?$/u, OMP_RULE, null],
  [OMP_RULE, /^[▏|]?$/u, OMP_RULE],
  // borderless: never without its status, as a bare `❯` is also a shell's prompt
  [OMP_PROMPT, null],
  // field (its right cap left off with IME-safe layout), then rail: one filled row, a gap, the status
  [/^▐(?: +(?:[▏|] *)?▌| [▏|])?$/u, /^$/u, null],
  [/^▐(?: +(?:[▏|] *)?▌| [▏|])?$/u],
  [new RegExp(`^▎${CURSOR}$`, "u"), /^$/u, null],
  [new RegExp(`^▎${CURSOR}$`, "u")],
];
/**
 * the status row as drawn: the band's powerline cap (Nerd Font preset), the space omp pads a segment group with, or with
 * no left group the band's gauge rule up to the right group's cap (ascii `-…< `); never text from a line's first character
 */
const OMP_STATUS_ROW_RE = /^(?:[\ue0b0-\ue0d4] | +|─+|-+< )\S/u;

/** the last row over omp's composer when the screen ends in one, else the screen's last row; `raw` holds the rows untrimmed */
function ompAboveComposer(lines: string[], raw: string[]): number {
  const last = findLastIndex(lines, (line) => line !== "");
  for (const rows of OMP_COMPOSERS) {
    const top = last - rows.length + 1;
    if (top > 0 && rows.every((row, index) => row === null ? OMP_STATUS_ROW_RE.test(raw[top + index]!) : row.test(lines[top + index]!))) return top - 1;
  }
  return last;
}
/** a choice row: the cursor (❯, its Nerd Font icon, or `>`) on the highlighted one, two spaces before the rest */
const OMP_CHOICE_RE = /^(?:([❯\uf054>])|  )\s?(\S.*)$/u;
const OMP_REMEMBER_RE = /^(?:[☐☑\uf096\uf14a]|\[[ x]\]) Remember across sessions$/u;
/** the toggle ticked: the grants under it are kept across sessions */
const OMP_REMEMBERED_RE = /^(?:[☑\uf14a]|\[x\]) /u;

/** a modifier as omp draws it: a word with `+`, or a keycap or Nerd Font icon and the preset's joiner */
const OMP_KEY_MODIFIERS: readonly [RegExp, string][] = [
  [/^(?:Ctrl\+|[⌃\u{f0634}] ?)/u, "ctrl"],
  [/^(?:Alt\+|Option\+|[⌥\u{f0635}] ?)/u, "alt"],
  [/^(?:Shift\+|[⇧\u{f0636}] ?)/u, "shift"],
];
const OMP_KEY_NAMES: Readonly<Record<string, string>> = {
  "⏎": KEY.enter, Enter: KEY.enter, "\u{f0311}": KEY.enter,
  "⎋": KEY.escape, Esc: KEY.escape, "\u{f12b7}": KEY.escape,
  "⇥": KEY.tab, Tab: KEY.tab, "\u{f0312}": KEY.tab,
  "␣": KEY.space, Space: KEY.space, "\u{f1050}": KEY.space,
  "↑": KEY.up, Up: KEY.up, "↓": KEY.down, Down: KEY.down,
};

/** One key of omp's hint as herdr's key name (`Ctrl+Q` → `ctrl+q`); null for one we cannot send as drawn (⌘, a word omp spells out). */
function ompHintKey(drawn: string): string | null {
  const modifiers: string[] = [];
  let rest = drawn;
  for (const [re, name] of OMP_KEY_MODIFIERS) {
    const match = re.exec(rest);
    if (match) { modifiers.push(name); rest = rest.slice(match[0].length); }
  }
  const base = OMP_KEY_NAMES[rest] ?? (/^[A-Za-z0-9]$/.test(rest) ? rest.toLowerCase() : null);
  return base === null ? null : [...modifiers, base].join("+");
}

/**
 * The keys sent as drawn: Esc and a Ctrl+letter arrive the same on every terminal. Without extended key reporting a
 * terminal sends Ctrl+J and Ctrl+M as LF and CR, and Ctrl+Enter and Shift+Enter as CR, which omp reads as Enter (the
 * highlighted row on 18.13's menu, or an approve key bound to Enter); Ctrl+H and Ctrl+I as Backspace and Tab. A choice
 * whose key is none of these is answered by moving to its row, or the terminal answers it.
 */
const OMP_DIRECT_KEY_RE = /^(?:esc|ctrl\+[a-gkln-z])$/;
/** a select key arrives unchanged too: Enter or Space themselves, or a direct key */
const OMP_SELECT_KEY_RE = /^(?:enter|space|ctrl\+[a-gkln-z])$/;

/** every key of a slash-separated hint (`Ctrl+⏎/Ctrl+Q`), or null when one cannot be sent */
function ompHintKeys(drawn: string): string[] | null {
  const keys = drawn.split("/").map(ompHintKey);
  return keys.some((key) => key === null) ? null : keys as string[];
}

type OmpChoice = { label: string; cursor: boolean; toggle: boolean };

/**
 * 18.13's choices, the last rows over the hint, read up from Deny: Approve, or the one row that
 * approves for the session and Approve over it; with grants, "Approve Once" (a grant may itself
 * read "Approve"), the grants over it, and the toggle that keeps them across sessions on top.
 * `first` is the first row of the menu (the rows above it are the call's details), `approve` the choice
 * that approves this call alone.
 */
function ompChoices(rows: string[]): { choices: OmpChoice[]; first: number; approve: number } | null {
  const choices: OmpChoice[] = [];
  let once = false;
  for (let index = rows.length - 1; index >= 0 && choices.length < 16; index -= 1) {
    const match = OMP_CHOICE_RE.exec(rows[index]!);
    if (!match) return null;
    const choice = { label: match[2]!, cursor: match[1] !== undefined, toggle: OMP_REMEMBER_RE.test(match[2]!) };
    choices.unshift(choice);
    if (choices.length === 1 && choice.label !== "Deny") return null;
    if (choices.length > 1 && choices.length <= 3 && choice.label === "Approve Once") once = true;
    const done = once ? choice.toggle : choices.length > 1 && choices.length <= 3 && choice.label === "Approve";
    if (!done) continue;
    const approve = once ? choices.map((row) => row.label).lastIndexOf("Approve Once") : 0;
    return choices.filter((row) => row.cursor).length === 1 ? { choices, first: index, approve } : null;
  }
  return null;
}

function parseOmpApprovalPanel(screen: string): ParsedPrompt | null {
  const raw = screen.replace(ANSI_RE, "").split(/\r?\n/);
  const lines = raw.map((line) => line.trim());
  // under 18.13's panel, the composer it mounts there, and nothing else
  const bottom = ompAboveComposer(lines, raw);
  if (bottom < 4 || !OMP_PANEL_RULE_RE.test(lines[bottom]!) || !OMP_PANEL_RULE_RE.test(lines[bottom - 2]!)) return null;
  const hintRow = OMP_PANEL_ROW_RE.exec(lines[bottom - 1]!);
  const full = hintRow ? OMP_APPROVAL_HINT_RE.exec(hintRow[1]!) : null;
  const clipped = hintRow && !full ? OMP_APPROVAL_CLIPPED_HINT_RE.exec(hintRow[1]!) : null;
  if (full?.[5] !== undefined || (!full && !clipped)) return null;
  const [, chooseKeys, selectDrawn, approveDrawn] = (full ?? clipped)!;
  const approveKeys = ompHintKeys(approveDrawn!);
  // with the hint cut, the deny key is not shown: Deny is answered by moving to it
  const denyKey = full ? ompHintKey(full[4]!) : null;
  if (!approveKeys || (full && (!denyKey || approveKeys.includes(denyKey)))) return null;
  const plainKey = approveKeys.find((key) => key !== KEY.escape && OMP_DIRECT_KEY_RE.test(key));
  const directDeny = denyKey !== null && OMP_DIRECT_KEY_RE.test(denyKey) ? denyKey : null;
  let top = bottom - 3;
  while (top >= 0 && OMP_PANEL_ROW_RE.test(lines[top]!)) top -= 1;
  const title = top >= 0 ? OMP_APPROVAL_TOP_RE.exec(lines[top]!) : null;
  if (!title) return null;
  const rows = lines.slice(top + 1, bottom - 2).map((line) => OMP_PANEL_ROW_RE.exec(line)![1]!);
  const card = { kind: "approval" as const, title: title[1]!, question: title[1]!, multi_select: false, custom_option_index: null };
  const internal = { responder: "omp-approval" as const, checkedOptionIndices: [], customMenuIndex: null, rejectWithEscapeIndex: null };
  if (chooseKeys === undefined) {
    // 18.10 has no rows to move to: both answers need a key that arrives as drawn
    if (rows.length === 0 || !plainKey || !directDeny || rows.some((row) => OMP_DETAIL_CUT_RE.test(row))) return null;
    return finishPrompt("omp", {
      ...card, body: rows.join("\n").trim() || null,
      options: [{ label: own("Approve"), description: null }, { label: own("Deny"), description: null }],
    }, { ...internal, menuLabels: ["Approve", "Deny"], selectedIndex: -1, optionSteps: [keySteps([plainKey]), keySteps([directDeny])] });
  }
  const selectKey = ompHintKey(selectDrawn!);
  if ((chooseKeys !== "↑/↓" && chooseKeys !== "Up/Down") || !selectKey || !OMP_SELECT_KEY_RE.test(selectKey)) return null;
  // omp takes the approve and deny keys before moving or selecting: bound to one of those, a move would answer
  const moves: string[] = [KEY.up, KEY.down, selectKey];
  if ([...approveKeys, ...(denyKey ? [denyKey] : [])].some((key) => moves.includes(key))) return null;
  const menu = ompChoices(rows);
  if (!menu) return null;
  const { choices, first, approve } = menu;
  // a grant taken while the toggle is ticked outlives the session: the terminal answers that, where the box shows
  if (choices.some((choice) => choice.toggle && OMP_REMEMBERED_RE.test(choice.label))) return null;
  if ((clipped && first >= OMP_APPROVAL_DETAIL_ROWS) || rows.slice(0, first).some((row) => OMP_DETAIL_CUT_RE.test(row))) return null;
  const cursor = choices.findIndex((choice) => choice.cursor);
  // the toggle answers nothing: it changes which grants the rows under it record
  const offered = choices.flatMap((choice, row) => choice.toggle ? [] : [{ ...choice, row }]);
  return finishPrompt("omp", {
    ...card, body: rows.slice(0, first).join("\n").trim() || null,
    options: offered.map((choice) => ({ label: choice.label, description: null })),
  }, {
    ...internal, menuLabels: offered.map((choice) => choice.label), selectedIndex: offered.findIndex((choice) => choice.cursor),
    // Approve and Deny by their keys when those arrive as drawn, wherever the cursor is; every other row by moving to it
    optionSteps: offered.map((choice) => choice.row === approve && plainKey ? keySteps([plainKey])
      : directDeny && choice.row === choices.length - 1 ? keySteps([directDeny])
      : keySteps([...navigationKeys(choice.row - cursor), selectKey])),
  });
}

/** Whether omp's approval panel (not the older menu) is what the screen ends in. */
export function ompApprovalPanelShown(screen: string): boolean {
  return parseOmpApprovalPanel(screen) !== null;
}

function parseOmpApproval(screen: string): ParsedPrompt | null {
  const panel = parseOmpApprovalPanel(screen);
  if (panel) return panel;
  const lines = screen.replace(ANSI_RE, "").split(/\r?\n/);
  const headerIndex = findLastIndex(lines, (line) => /^\s*Allow tool:\s*\S+/i.test(cleanLine(line)));
  if (headerIndex < 0) return null;
  const rows: MenuRow[] = [];
  for (let index = headerIndex + 1; index < lines.length; index += 1) {
    const match = cleanLine(lines[index]!).match(/^([›>❯•])?\s*(Approve|Deny)$/i);
    if (match) rows.push({ label: match[2]!, selected: Boolean(match[1]), checked: false, lineIndex: index });
  }
  if (rows.length !== 2 || rows.filter((row) => row.selected).length !== 1) return null;
  return finishPrompt("omp", {
    kind: "approval", title: cleanLine(lines[headerIndex]!), question: cleanLine(lines[headerIndex]!),
    body: lines.slice(headerIndex + 1, rows[0]!.lineIndex).map(cleanLine).filter(Boolean).join("\n") || null,
    options: rows.map((row) => ({ label: row.label, description: null })), multi_select: false, custom_option_index: null,
  }, {
    responder: "omp-approval", menuLabels: rows.map((row) => row.label),
    selectedIndex: rows.findIndex((row) => row.selected), checkedOptionIndices: [], customMenuIndex: null,
    rejectWithEscapeIndex: null,
  });
}

/**
 * omp's session-only model picker (omp 18.11.1), which `/switch` and Alt+P open: a box over the
 * bottom of the screen, with the screen's last line its bottom border —
 *
 *   ╭─ Switch Model ─────────────────────────────────────────────╮
 *   │  Session-only switch — role models stay unchanged           │
 *   │  🔍 >                                                       │
 *   │                                                             │
 *   │ ❯ anthropic/claude-opus-5-5 ●       5.5s 49t/s  1m ◫  $4/20█ │
 *   │   openai/gpt-6-sol                        1.1m ◫     $2/10│ │
 *   │   ───────────────────────────────────────────────────────   │
 *   │   openai/gpt-oss-120b                      131k ◫ $0.35/0.75│ │
 *   │                                                             │
 *   │   Claude Opus 5.5 · 1m ctx · 128k out · $4/20 per M · …     │
 *   │   ● current · ● default ⟳ · ○ smol · ○ slow                 │
 *   │ ↑/↓ models · ⏎ use for this session · type to search · @ quick roles · ⎋ close │
 *   ╰─────────────────────────────────────────────────────────────╯
 *
 * The rows are a window on the list, padded with blank lines to its height and followed by a
 * blank and two lines on the row under the cursor. A list longer than the window draws a
 * scrollbar after every row. `●` marks the model the session runs; a rule sets recent and role
 * models apart, and ↑/↓ step over it. A model whose window the conversation already overflows
 * says `⦸ context>131k`: omp compacts the conversation with the model in use before it switches.
 * Typing in the box filters the list. A leading `@` lists quick roles and Alt+P lists models for
 * task subagents: both change the status line or the title, and are not read here. omp's
 * `/model` opens its Models hub instead, which assigns roles, the default one saved for later
 * sessions, so no card answers it.
 */
const OMP_MODEL_TOP_RE = /^╭─ Switch Model ─/;
const OMP_MODEL_STATUS_RE = /^Session-only switch\b/;
/** the search box: omp's search icon, then what was typed */
const OMP_MODEL_SEARCH_RE = /^\S+ >(?: .*)?$/;
/** the footer, cut at the pane's edge on a phone */
const OMP_MODEL_HINT_RE = /^\S+ models · \S+ use for this session(?: ·|…|$)/;
const OMP_MODEL_BOTTOM_RE = /^╰─+╯$/;
/** a row: the cursor, `provider/id`, `●` on the model in use, then its figures */
const OMP_MODEL_ROW_RE = /^(❯ )?(\S+\/\S+)( ●)?(?: |$)/;
/** the scrollbar's thumb or track after a row */
const OMP_MODEL_SCROLLBAR_RE = /[█│]$/;
const OMP_MODEL_OVER_CONTEXT_RE = /⦸ context>(\S+)/;

function ompModelPicker(lines: string[]): { rows: { label: string; cursor: boolean; current: boolean; overContext: string | null }[]; more: boolean } | null {
  // the bottom border is the screen's last line: the picker is drawn over everything else
  let bottom = lines.length - 1;
  while (bottom >= 0 && !lines[bottom]!.trim()) bottom -= 1;
  if (bottom < 5 || !OMP_MODEL_BOTTOM_RE.test(lines[bottom]!.trim())) return null;
  const hint = bottom - 1;
  if (!OMP_MODEL_HINT_RE.test(cleanLine(lines[hint]!))) return null;
  const top = findLastIndex(lines, (line, index) => index < hint && OMP_MODEL_TOP_RE.test(line.trim()));
  if (top < 0 || !OMP_MODEL_STATUS_RE.test(cleanLine(lines[top + 1] ?? "")) || !OMP_MODEL_SEARCH_RE.test(cleanLine(lines[top + 2] ?? ""))) return null;
  // the search box and a blank over the rows; a blank and the two lines on the cursor's row under them
  const window = lines.slice(top + 4, hint - 3);
  if (window.length === 0 || cleanLine(lines[top + 3]!) || cleanLine(lines[hint - 3]!)) return null;
  const rows: { label: string; cursor: boolean; current: boolean; overContext: string | null }[] = [];
  let more = false;
  let padding = false;
  for (const raw of window) {
    const shown = cleanLine(raw);
    const line = shown.replace(OMP_MODEL_SCROLLBAR_RE, "").trimEnd();
    if (line !== shown) more = true;
    // the window's padding comes after its last row, never between two
    if (!line) { padding = true; continue; }
    if (padding) return null;
    if (isDivider(line)) continue;
    const row = OMP_MODEL_ROW_RE.exec(line);
    if (!row) return null;
    rows.push({ label: row[2]!, cursor: row[1] !== undefined, current: row[3] !== undefined, overContext: OMP_MODEL_OVER_CONTEXT_RE.exec(line)?.[1] ?? null });
  }
  return rows.filter((row) => row.cursor).length === 1 ? { rows, more } : null;
}

function parseOmpModel(screen: string): ParsedPrompt | null {
  const list = ompModelPicker(screen.replace(ANSI_RE, "").split(/\r?\n/));
  if (list === null) return null;
  const labels = list.rows.map((row) => row.label);
  const current = list.rows.find((row) => row.current);
  const asked = current ? own("Select model for this session (currently {model})", { model: current.label }) : own("Select model for this session");
  return finishPrompt("omp", {
    kind: "question",
    title: "",
    question: list.more ? own("{question}. More models are listed in the terminal.", { question: asked }) : asked,
    body: null,
    options: list.rows.map((row) => ({
      label: row.label,
      description: row.overContext === null ? null : own("The conversation is over its {context} context: omp compacts it first", { context: row.overContext }),
    })),
    multi_select: false,
    custom_option_index: null,
  }, {
    responder: "omp-model", menuLabels: labels, selectedIndex: list.rows.findIndex((row) => row.cursor), checkedOptionIndices: [], customMenuIndex: null,
    rejectWithEscapeIndex: null,
  });
}

const OMP_HANDOFF_RE = /^\S\s+(Generating handoff…)\s+\((?:⎋|esc|escape)\s+to cancel\)$/i;

/**
 * omp's /handoff (18.8.7, same in 18.12.3) shows no dialog: one status line while it writes the
 * handoff document, which Esc cancels. Read only while that line is the live status, right above
 * omp's status bar and editor; a line left in the transcript above them is history.
 */
function parseOmpHandoff(screen: string): ParsedPrompt | null {
  const lines = screen.replace(ANSI_RE, "").split(/\r?\n/).map((line) => line.trim());
  const index = findLastIndex(lines, (line) => OMP_HANDOFF_RE.test(line));
  if (index < 0) return null;
  const below = lines.slice(index + 1).filter(Boolean);
  if (below.length < 2 || !below[0]!.startsWith("π >") || !below.slice(1).every((line) => line.startsWith("╰─"))) return null;
  return finishPrompt("omp", {
    kind: "menu", title: own("Handoff"), question: OMP_HANDOFF_RE.exec(lines[index]!)![1]!, body: null,
    options: [{ label: own("Cancel"), description: null }], multi_select: false, custom_option_index: null,
  }, {
    responder: "omp-handoff", menuLabels: ["Cancel"], selectedIndex: 0,
    checkedOptionIndices: [], customMenuIndex: null, rejectWithEscapeIndex: 0,
  });
}

export const readers: readonly DialogReader[] = [
  {
    id: "omp-question", agents: ["omp"], priority: 10,
    reread: "none", list: "none",
    parse: (screen) => {
      const parsed = parseOmpQuestion(screen);
      return parsed?.responder === "omp-question" ? parsed : null;
    },
  },
  {
    id: "omp-submit", agents: ["omp"], priority: 20,
    reread: "none", list: "none",
    parse: (screen) => {
      const parsed = parseOmpSubmit(screen);
      return parsed?.responder === "omp-submit" ? parsed : null;
    },
  },
  {
    id: "omp-approval", agents: ["omp"], priority: 30,
    reread: "none", list: "none",
    parse: (screen) => {
      const parsed = parseOmpApproval(screen);
      return parsed?.responder === "omp-approval" ? parsed : null;
    },
  },
  {
    id: "omp-model", agents: ["omp"], priority: 40,
    // closed under the moves (Esc in the terminal), the picker leaves omp's input box, which takes
    // ↑/↓ as its history: every move after the first waits for the picker on the row before it
    reread: "each-move", list: "none",
    // ↑/↓ step over the rule between recent and other models, as the rows do. omp reorders its
    // rows when its catalogue refreshes under them, which the name under the cursor catches
    interaction: (parsed) => pickerPlan(parsed, parseOmpModel,
      parsed.options.map((_, index) => keySteps([...navigationKeys(index - parsed.selectedIndex), KEY.enter])),
      (shown, cursor) => shown.options[cursor]?.label),
    parse: (screen) => {
      const parsed = parseOmpModel(screen);
      return parsed?.responder === "omp-model" ? parsed : null;
    },
  },
  {
    // Esc only while the handoff is still being written: the loop reads the screen again first
    id: "omp-handoff", agents: ["omp"], priority: 40,
    reread: "before-commit", list: "none",
    parse: parseOmpHandoff,
  },
];
