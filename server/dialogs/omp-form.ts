import type { DialogReader } from "./registry.ts";
import type { InteractivePrompt, InteractivePromptAnswer, InteractivePromptStep } from "../../shared/protocol.ts";
import { ANSI_RE, KEY, type AnswerStep, type CardWords, type OmpFormChoices, type OmpFormChoiceWindow, type ParsedPrompt, type PromptDraft, finishPrompt, findLastIndex, keySteps, navigationKeys, own } from "./shared.ts";
import { formChoiceGroups } from "./omp-form-html.ts";

/**
 * omp 19's `ask` (pi-tui `html-form/dialog.ts` HtmlFormDialog, measured on omp 19.1.0): the agent's HTML form in one
 * box over the composer, titled `Ask`, with ` · N of M answered` once it holds two fields. The field under the cursor
 * is drawn open; every other one folds to a mark (`✓` answered, `○` not, `!` an error), its question and one summary
 * row; the Submit row comes last. There is no footer of keys and no divider inside the box, unlike the 18.x Ask.
 *
 * The card is the field under the cursor. omp's own Enter answers it and moves on to the next field, whose card
 * follows; Tab and Shift+Tab move between fields without answering. Esc never cancels the form: it hands the keys
 * to the composer, where the next Esc interrupts the turn, so the card offers no Cancel.
 */

const TOP_RE = /^\s*(?:╭─|\+-) Ask(?: · (\d+) of (\d+) answered)?(?: \(\d+s\))? (?:─+╮|-+\+)\s*$/u;
const BOTTOM_RE = /^\s*(?:╰─+╯|\+-+\+)\s*$/u;
const ROW_RE = /^\s*[│|] (.*) [│|]\s*$/u;
/** a body taller than the box ends each row with its scrollbar's track or thumb, in the column before the border */
const SCROLLBAR_RE = /[█│|]$/u;
/** under the box: blank rows, omp's status line, its status bar and the composer, never more output */
const TAIL_ROWS = 8;

const CURSOR_ROW_RE = /^[❯>\uf054] (.*)$/u;
/** an option row: the cursor or two spaces, the marker as each symbol preset draws it (unicode, Nerd Font, ascii) */
const OPTION_RE = /^(?:[❯>\uf054] | {2})(◉|○|\uf192|\uf10c|\(o\)|\( \)|☑|☐|\uf14a|\uf096|\[x\]|\[ \]) (.*)$/u;
const CHECKED_MARKERS = new Set(["◉", "\uf192", "(o)", "☑", "\uf14a", "[x]"]);
const BOX_MARKERS = new Set(["☑", "☐", "\uf14a", "\uf096", "[x]", "[ ]"]);
/** a wrapped option label hangs under the label's first character */
const CONTINUATION_RE = /^ {4,}\S/u;
const FOLD_RE = /^([✓○!]) (\S.*)$/u;
const SUBMIT_RE = /^(?:([❯>\uf054]) | {2})Submit(?: {2}(\d+ to fix))?$/u;
/** the free-text answer omp adds to a radio or checkbox group of two or more options */
const OTHER_RE = /^Other: (.*)$/u;
const OTHER_PLACEHOLDER = "type your own";
/** `✎ note` on a chosen option with a note, `✎ draft` on another one */
const NOTE_MARK_RE = / {2}✎ \S.*$/u;
/** an option's note editor holds the keys: the card waits for it to close */
const NOTE_EDITOR_RE = /^ +Note for .* · enter save\b/u;
/** pi-tui html-form/data.ts `fieldError`, under the field it is about */
const ERROR_RE = /^ {4}(Required|Select at least one|Enter a number|Must be at (?:least|most) .+|Needs at least .+|At most .+|Enter an email address|Enter a full URL|Must match .+)$/u;
const VALUE_RE = /^ {2}[│|](?: (.*))?$/u;
const DROPDOWN_RE = /^‹ (.*) › {2}(\d+|—)\/(\d+)(?: \*)?$/u;
/** after a text field's label: ` *` when required, then its bounds (`1–10`, `≥ 1`, `≤ 10`) */
const LABEL_SUFFIX_RE = /^(.*?)(?: \*)?(?: {2}(\S+–\S+|[≥≤] \S+))?$/u;
/** an open dropdown's box, `↑`/`↓` in its rule when options are scrolled off */
const OVERLAY_EDGE_RE = /^( +)(?:[╭╰]|\+)[─\-↑↓]+(?:[╮╯]|\+)$/u;

interface FormBox {
  rows: string[];
  /** fields omp counts in its title, null under two */
  total: number | null;
  /** the body is taller than the box: rows past its top or bottom edge are not on screen */
  scrolled: boolean;
}

interface Block {
  start: number;
  end: number;
}

interface Folded {
  block: number;
  label: string;
  answered: boolean;
  answer: string | null;
}

interface ChoiceOption {
  label: string;
  checked: boolean;
}

function formBox(screen: string): FormBox | null {
  const lines = screen.replace(ANSI_RE, "").split(/\r?\n/u);
  while (lines.length > 0 && lines.at(-1)!.trim() === "") lines.pop();
  const top = findLastIndex(lines, (line) => TOP_RE.test(line));
  if (top < 0) return null;
  const bottom = lines.findIndex((line, index) => index > top && BOTTOM_RE.test(line));
  if (bottom < 0 || lines.slice(bottom + 1).filter((line) => line.trim()).length > TAIL_ROWS) return null;
  const raw: string[] = [];
  for (const line of lines.slice(top + 1, bottom)) {
    const row = ROW_RE.exec(line);
    if (!row) return null;
    raw.push(row[1]!);
  }
  if (raw.length === 0) return null;
  const scrolled = raw.every((row) => SCROLLBAR_RE.test(row));
  const total = TOP_RE.exec(lines[top]!)![2];
  return { rows: raw.map((row) => (scrolled ? row.slice(0, -1) : row).trimEnd()), total: total === undefined ? null : Number(total), scrolled };
}

export function ompFormOnScreen(screen: string): boolean {
  return formBox(screen) !== null;
}

function blocksOf(rows: string[]): Block[] {
  const blocks: Block[] = [];
  let start = -1;
  for (let index = 0; index <= rows.length; index += 1) {
    const blank = index === rows.length || rows[index]!.trim() === "";
    if (blank && start >= 0) {
      blocks.push({ start, end: index });
      start = -1;
    } else if (!blank && start < 0) start = index;
  }
  return blocks;
}

const joined = (rows: readonly string[]): string => rows.map((row) => row.trim()).filter(Boolean).join(" ");

/** A folded field: its mark and question, wrapped rows indented, then the one summary row, then its error under a `!`. */
function foldedField(rows: readonly string[], block: number): Folded | null {
  const head = FOLD_RE.exec(rows[0] ?? "");
  if (!head) return null;
  const rest = rows.slice(1);
  const summaryAt = rest.length - 1 - (head[1] === "!" ? 1 : 0);
  if (summaryAt < 0) return null;
  const summary = rest[summaryAt]!.replace(NOTE_MARK_RE, "");
  const label = joined([head[2]!, ...rest.slice(0, summaryAt)]);
  // a choice's summary is its option pills, each drawn with a space either side and the chosen ones marked `✓`
  const chosen = summary.startsWith("   ")
    ? summary.trim().split(/ {3}/u).flatMap((pill) => pill.startsWith("✓ ") ? [pill.slice(2)] : []).join(", ")
    : head[1] === "✓" ? summary.trim() : "";
  // a narrow pane cuts the pills at its edge: an answered choice whose chosen pill is past it reads as cut, not unanswered
  return { block, label, answered: head[1] === "✓", answer: chosen || (head[1] === "✓" ? "…" : null) };
}

/** The pasted text omp's field gets: one line for an input, lines kept for a textarea; never a control key. */
function typedSteps(text: string, multiline: boolean): AnswerStep[] {
  const lines = multiline ? text.replace(/\r\n?/gu, "\n") : text.replace(/\s*[\r\n]+\s*/gu, " ");
  const clean = lines.replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/gu, "");
  // Ctrl+K and Ctrl+U empty the line on either side of the caret (pi-tui Input); a paste keeps a textarea's newlines,
  // where a typed newline is omp's Enter and would move on mid-answer
  return [...keySteps(["ctrl+k", "ctrl+u"]), { text: `\u001b[200~${clean}\u001b[201~` }, ...keySteps([KEY.enter])];
}

/** Space on each option whose tick differs, walking from `from`; where the walk ends. */
function toggleKeys(checked: readonly boolean[], desired: ReadonlySet<number>, from: number): { keys: string[]; cursor: number } {
  const keys: string[] = [];
  let cursor = from;
  checked.forEach((ticked, index) => {
    if (desired.has(index) === ticked) return;
    keys.push(...navigationKeys(index - cursor), KEY.space);
    cursor = index;
  });
  return { keys, cursor };
}

type Field = { question: CardWords; draft: PromptDraft; internal: Omit<ParsedPrompt, keyof InteractivePrompt | "responder"> };

/**
 * The choice group under the cursor. In a scrolled box it can run past an edge: past the top when no caption is above
 * its first option, past the bottom when its last shown row is the box's last one and not the Other row omp draws last.
 * The card then lists what shows and says more is in the terminal, until omp-ask.ts binds it to the call's radio group.
 */
function choiceField(rows: readonly string[], at: number, block: Block, context: string | null, scrolled: boolean): Field | null {
  const belongs = (index: number): boolean => OPTION_RE.test(rows[index]!) || (CONTINUATION_RE.test(rows[index]!) && !ERROR_RE.test(rows[index]!));
  let first = at;
  while (first - 1 >= block.start && belongs(first - 1)) first -= 1;
  while (!OPTION_RE.test(rows[first]!)) first += 1;
  let last = at;
  while (last + 1 < block.end && belongs(last + 1)) last += 1;
  const options: ChoiceOption[] = [];
  const markers: string[] = [];
  let cursor = -1;
  for (let index = first; index <= last; index += 1) {
    const option = OPTION_RE.exec(rows[index]!);
    if (option) {
      markers.push(option[1]!);
      options.push({ label: option[2]!, checked: CHECKED_MARKERS.has(option[1]!) });
    } else options.at(-1)!.label += ` ${rows[index]!.trim()}`;
    if (index === at) cursor = options.length - 1;
  }
  const multi = BOX_MARKERS.has(markers[0]!);
  if (markers.some((marker) => BOX_MARKERS.has(marker) !== multi)) return null;
  for (const option of options) option.label = option.label.replace(NOTE_MARK_RE, "");
  // the rows above the first option are its caption, or the wrapped end of an option past the top edge
  const top = scrolled && block.start === 0 && rows.slice(0, first).every((row) => CONTINUATION_RE.test(row));
  const bottomEdge = scrolled && last === rows.length - 1;
  // Space toggles the checks already set by omp. Hidden options can carry ticks we cannot read.
  if (multi && (top || bottomEdge)) return null;
  const bottom = bottomEdge && !OTHER_RE.test(options.at(-1)!.label);
  const otherRow = (options.length > 2 || top) && !bottom ? OTHER_RE.exec(options.at(-1)!.label) : null;
  const choices = otherRow ? options.slice(0, -1) : options;
  const other = otherRow ? {
    label: options.at(-1)!.label,
    // focused and empty, the Other input draws its caret as a space before the placeholder
    text: !otherRow[1]!.startsWith(" ") && !(otherRow[1] === OTHER_PLACEHOLDER && !options.at(-1)!.checked) ? otherRow[1]! : "",
    ticked: options.at(-1)!.checked,
  } : null;
  const shown: OmpFormChoices = {
    labels: choices.map((option) => option.label), checked: choices.map((option) => option.checked), multi, cursor, other,
    caption: top ? "" : joined(rows.slice(block.start, first)),
  };
  const error = ERROR_RE.exec(rows[last + 1] ?? "")?.[1] ?? null;
  const body = [context, error].filter(Boolean).join("\n\n") || null;
  const field = choiceCard(shown, body, top || bottom);
  field.internal.ompFormChoices = { shown, top, bottom };
  return field;
}

function choiceCard(group: OmpFormChoices, body: string | null, cut: boolean): Field {
  const { labels, checked, multi, cursor, other } = group;
  const otherIndex = other ? labels.length : null;
  const question = group.caption || (labels.length === 1 ? labels[0]! : own("Choose an option"));
  const typedOther = (text: string, picked?: number[]): AnswerStep[] => {
    const { keys, cursor: from } = picked === undefined ? { keys: [], cursor } : toggleKeys(checked, new Set(picked), cursor);
    return [...keySteps([...keys, ...navigationKeys(otherIndex! - from)]), ...typedSteps(text, false)];
  };
  return {
    question,
    draft: {
      kind: "question", title: own(multi ? "Multiple choice" : "Question"),
      question: cut ? own("{question}. More options are listed in the terminal.", { question }) : question, body,
      options: labels.map((label) => ({ label, description: null })),
      multi_select: multi, custom_option_index: otherIndex,
      ...(multi ? { default_option_indices: checked.flatMap((ticked, index) => ticked ? [index] : []) } : { default_option_index: checked.indexOf(true) >= 0 ? checked.indexOf(true) : null }),
      ...(other?.text ? { default_custom_text: other.text } : {}),
      ...(multi && otherIndex !== null ? { checks_with_text: true as const } : {}),
    },
    internal: {
      menuLabels: [...labels, ...(otherIndex === null ? [] : ["Other"])], selectedIndex: cursor,
      checkedOptionIndices: checked.flatMap((ticked, index) => ticked ? [index] : []), customMenuIndex: otherIndex, rejectWithEscapeIndex: null,
      ...(otherIndex === null ? {} : { customSteps: typedOther }),
      // Space ticks, and Enter leaves the group once something is ticked (it would tick the focused box of an empty one).
      // Other is ticked while it holds text, and Space there would type one: emptying its text unticks it
      ...(multi ? { multiSteps: (picked: number[]) => {
        const { keys, cursor: from } = toggleKeys(checked, new Set(picked), cursor);
        const untick = otherIndex !== null && other!.ticked ? [...navigationKeys(otherIndex - from), "ctrl+k", "ctrl+u"] : [];
        return keySteps([...keys, ...untick, KEY.enter]);
      } } : {}),
    },
  };
}

/**
 * Match the displayed group to its `ask` call's HTML: the one group whose labels hold the shown ones in a row,
 * starting at its first option unless the top is cut and ending at its last unless the bottom is. The card keeps its id
 * and its words around the options. A checkbox group whose ticks might be offscreen has no card to bind.
 */
export function bindFormChoiceGroup(parsed: ParsedPrompt, html: string): ParsedPrompt | null {
  const window: OmpFormChoiceWindow | undefined = parsed.ompFormChoices;
  if (!window || window.shown.labels.length === 0) return parsed;
  const { shown, top, bottom } = window;
  const bare = (text: string): string => text.replace(/\s+/gu, "");
  // the Other row is drawn last: shown, the group's end shows with it
  const ends = !bottom || shown.other !== null;
  let clippedLabel = false;
  const found = formChoiceGroups(html).flatMap((group, index) => {
    if (group.multi !== shown.multi) return [];
    if (ends && group.other && shown.other === null) return [];
    const fixedOther = !group.other ? shown.other : null;
    const wanted = [...shown.labels, ...(fixedOther ? [fixedOther.label] : [])].map(bare);
    const labels = group.labels.map(bare);
    const offsets: number[] = [];
    const last = wanted.at(-1) ?? "";
    for (let offset = 0; offset + wanted.length <= labels.length && (top || offset === 0); offset += 1) {
      if (ends && offset + wanted.length !== labels.length) continue;
      if (!wanted.slice(0, -1).every((label, index) => labels[offset + index] === label)) continue;
      const full = labels[offset + wanted.length - 1];
      if (full === last && !group.disabled) offsets.push(offset);
      // At the bottom edge the last label may wrap offscreen. Even an exact match in a different group
      // cannot prove that this is the whole label.
      if (!ends && full !== last && full?.startsWith(last)) clippedLabel = true;
    }
    return offsets.map((offset) => ({ group, index, offset, fixedOther }));
  });
  if (clippedLabel) return null;
  if (found.length !== 1) return parsed;
  const { group, index, offset, fixedOther } = found[0]!;
  const bound = group.multi ? parsed : { ...parsed, ompFormRadioGroup: index };
  if ((!top && !bottom || group.multi) && !fixedOther) return bound;
  const shownChecks = fixedOther ? [...shown.checked, fixedOther.ticked] : shown.checked;
  const labels = group.multi ? [...shown.labels, ...(fixedOther ? [fixedOther.label] : [])] : group.labels;
  const field = choiceCard({
    labels, multi: group.multi, caption: shown.caption,
    checked: group.multi ? shownChecks : labels.map((_, index) => shownChecks[index - offset] ?? false),
    cursor: group.multi ? shown.cursor : group.other && shown.cursor === shown.labels.length ? labels.length : offset + shown.cursor,
    other: group.other ? shown.other ?? { label: "", text: "", ticked: false } : null,
  }, null, false);
  const whole = finishPrompt("omp", field.draft, { ...field.internal, responder: "omp-form" });
  const kept = Object.entries(parsed.own_text ?? {}).filter(([key]) => key !== "question" && key !== "labels");
  const ownText = { ...Object.fromEntries(kept), ...whole.own_text };
  return {
    ...bound,
    // A click carries an index, so the raw rows and the restored option list must never share an id.
    id: `${parsed.id}@${whole.id}`,
    question: whole.question, options: whole.options, custom_option_index: whole.custom_option_index,
    default_option_index: whole.default_option_index, default_option_indices: whole.default_option_indices,
    default_custom_text: whole.default_custom_text, checks_with_text: whole.checks_with_text,
    own_text: Object.keys(ownText).length > 0 ? ownText : undefined,
    menuLabels: whole.menuLabels, selectedIndex: whole.selectedIndex, checkedOptionIndices: whole.checkedOptionIndices,
    customMenuIndex: whole.customMenuIndex, customSteps: whole.customSteps, multiSteps: whole.multiSteps,
  };
}

/** The characters of `row` from display column `start`, `width` columns long. */
function columns(row: string, start: number, width: number): string {
  let column = 0;
  let cell = "";
  for (const { segment } of new Intl.Segmenter().segment(row)) {
    if (column >= start + width) break;
    if (column >= start) cell += segment;
    column += Bun.stringWidth(segment);
  }
  return cell;
}

function dropdownField(rows: readonly string[], at: number, block: Block, context: string | null, label: string, value: RegExpExecArray, valueRow: number): Field | null {
  const question = label || joined(rows.slice(block.start, at)) || own("Choose an option");
  const body = [context].filter(Boolean).join("\n\n") || null;
  const edges = rows.flatMap((row, index) => index >= block.start && index < block.end && OVERLAY_EDGE_RE.test(row) ? [index] : []);
  if (edges.length === 0) {
    // closed: only the value shows; Space opens the list, whose card offers every option
    return {
      question,
      draft: {
        kind: "question", title: own("Question"), question, body,
        options: [{ label: value[1]!, description: `${value[2]}/${value[3]}` }, { label: own("Show all choices"), description: null }],
        multi_select: false, custom_option_index: null, default_option_index: 0,
      },
      internal: {
        menuLabels: [value[1]!, "Show all choices"], selectedIndex: 0, checkedOptionIndices: [], customMenuIndex: null, rejectWithEscapeIndex: null,
        optionSteps: [keySteps([KEY.enter]), keySteps([KEY.space])],
      },
    };
  }
  if (edges.length !== 2 || (edges[0]! < valueRow) !== (edges[1]! < valueRow)) return null;
  const [top, bottom] = edges as [number, number];
  const left = OVERLAY_EDGE_RE.exec(rows[top]!)![1]!.length;
  const width = rows[top]!.trim().length;
  const options: { label: string; highlight: boolean; current: boolean }[] = [];
  for (let index = top + 1; index < bottom; index += 1) {
    // the box covers the rows under it, whose right-hand part still shows; a wide character before it takes two columns
    const cell = columns(rows[index]!, left, width);
    const item = /^[│|] (?:([❯>\uf054]) | {2})(.*?)( ✓)? *[│|]$/u.exec(cell);
    if (!item) return null;
    options.push({ label: item[2]!.replace(NOTE_MARK_RE, "").trim(), highlight: item[1] !== undefined, current: item[3] !== undefined });
  }
  const highlight = options.findIndex((option) => option.highlight);
  if (highlight < 0 || options.filter((option) => option.highlight).length !== 1) return null;
  const current = options.findIndex((option) => option.current);
  return {
    question,
    draft: {
      kind: "question", title: own("Question"), question, body,
      options: options.map((option) => ({ label: option.label, description: null })),
      multi_select: false, custom_option_index: null, default_option_index: current >= 0 ? current : null,
    },
    // ↑/↓ move the highlight and Enter picks it and closes the list (the field keeps the focus)
    internal: { menuLabels: options.map((option) => option.label), selectedIndex: highlight, checkedOptionIndices: [], customMenuIndex: null, rejectWithEscapeIndex: null },
  };
}

function textField(rows: readonly string[], at: number, block: Block, context: string | null, label: string, allowMultilineDraft: boolean): Field | null {
  let end = at + 1;
  while (end < block.end && VALUE_RE.test(rows[end]!)) end += 1;
  const lines = rows.slice(at + 1, end).map((row) => VALUE_RE.exec(row)![1] ?? "");
  while (lines.length > 1 && lines.at(-1) === "") lines.pop();
  const multiline = end - at - 1 > 1;
  // focused and empty, the input draws its caret as a space before the placeholder
  const value = lines[0]?.startsWith(" ") ? "" : lines.join("\n");
  // Ctrl+K and Ctrl+U empty one line: a textarea holding several is changed in the terminal
  if (value.includes("\n") && !allowMultilineDraft) return null;
  const [, name, bounds] = LABEL_SUFFIX_RE.exec(label)!;
  const caption = joined(rows.slice(block.start, at));
  const question = name!.trim() || caption || own("Type your answer");
  const error = ERROR_RE.exec(rows[end] ?? "")?.[1] ?? null;
  return {
    question,
    draft: {
      kind: "question", title: own("Question"), question,
      body: [context, name!.trim() ? caption : null, bounds ?? null, error].filter(Boolean).join("\n\n") || null,
      options: [{ label: own("Type your answer"), description: null }], multi_select: false, custom_option_index: 0,
      ...(value ? { default_custom_text: value } : {}),
    },
    internal: {
      menuLabels: ["Type your answer"], selectedIndex: 0, checkedOptionIndices: [], customMenuIndex: 0, rejectWithEscapeIndex: null,
      customSteps: (text: string) => typedSteps(text, multiline),
    },
  };
}

function parseOmpForm(screen: string, allowMultilineDraft = false): ParsedPrompt | null {
  const box = formBox(screen);
  if (!box) return null;
  const { rows } = box;
  // the cursor shows only while the form holds the keys: with a draft in the composer, they are the composer's
  const cursors = rows.flatMap((row, index) => CURSOR_ROW_RE.test(row) ? [index] : []);
  if (cursors.length !== 1 || rows.some((row) => NOTE_EDITOR_RE.test(row))) return null;
  const at = cursors[0]!;
  const blocks = blocksOf(rows);
  const focusedBlock = blocks.findIndex((block) => block.start <= at && at < block.end);
  const block = blocks[focusedBlock]!;
  const folded: Folded[] = [];
  let submitBlock = -1;
  const context = new Set<number>();
  blocks.forEach((each, index) => {
    if (index === focusedBlock) return;
    const fold = foldedField(rows.slice(each.start, each.end), index);
    if (fold) folded.push(fold);
    else if (each.end - each.start === 1 && SUBMIT_RE.test(rows[each.start]!)) submitBlock = index;
    else context.add(index);
  });
  // the form's words between the field before and this one: the open question's own context
  const before: string[] = [];
  for (let index = focusedBlock - 1; index >= 0 && context.has(index); index -= 1) before.unshift(joined(rows.slice(blocks[index]!.start, blocks[index]!.end)));
  const intro = before.join("\n\n") || null;

  const cursorText = CURSOR_ROW_RE.exec(rows[at]!)![1]!;
  const submit = SUBMIT_RE.exec(rows[at]!);
  const onSubmit = submit !== null && block.end - block.start === 1;
  let field: Field | null = null;
  if (onSubmit) submitBlock = focusedBlock;
  else if (OPTION_RE.test(rows[at]!)) field = choiceField(rows, at, block, intro, box.scrolled);
  else {
    const bare = DROPDOWN_RE.exec(cursorText);
    const valueRow = VALUE_RE.exec(rows[at + 1] ?? "");
    const labelled = valueRow && at + 1 < block.end ? DROPDOWN_RE.exec(valueRow[1] ?? "") : null;
    if (bare) field = dropdownField(rows, at, block, intro, "", bare, at);
    else if (labelled) field = dropdownField(rows, at, block, intro, cursorText.replace(/ \*$/u, ""), labelled, at + 1);
    else if (valueRow && at + 1 < block.end) field = textField(rows, at, block, intro, cursorText, allowMultilineDraft);
  }
  if (!onSubmit && !field) return null;

  // the fields as omp lists them, when every one shows: Tab and Shift+Tab move between them
  const labels: { label: CardWords; answered: boolean }[] = [];
  let current = -1;
  blocks.forEach((_, index) => {
    const fold = folded.find((entry) => entry.block === index);
    if (fold) labels.push({ label: fold.label, answered: fold.answered });
    else if (index === focusedBlock && field) {
      current = labels.length;
      labels.push({ label: field.question, answered: false });
    }
  });
  const fields = labels.length;
  if (onSubmit) current = fields;
  const navigable = submitBlock >= 0 && box.total !== null && fields === box.total;
  const steps: (Omit<InteractivePromptStep, "label"> & { label: CardWords })[] | undefined = navigable
    ? [...labels, { label: own("Submit"), answered: false }].map((step, index) => ({ ...step, current: index === current, can_navigate: index !== current }))
    : undefined;
  const navigation = navigable ? {
    steps, can_step_back: current > 0, can_step_next: current < fields,
  } : {};
  const nativeSteps = navigable ? { nativeSteps: { identity: JSON.stringify(["omp-form", fields]), index: current, count: fields + 1, next: KEY.tab, previous: KEY.backtab } } : {};
  const hashed = { steps: undefined, can_step_back: undefined, can_step_next: undefined, call: navigable ? String(current) : undefined };

  if (onSubmit) {
    const answers: InteractivePromptAnswer[] = folded.map((entry) => ({ question: entry.label, answer: entry.answer }));
    return finishPrompt("omp", {
      kind: "menu", title: own("Review answers"), question: own("Submit these answers?"), body: submit[2] ?? null,
      ...(answers.length > 0 ? { answers } : {}),
      options: [{ label: own("Submit"), description: null }], multi_select: false, custom_option_index: null,
      ...navigation,
    }, {
      ...nativeSteps,
      responder: "omp-form", menuLabels: ["Submit"], selectedIndex: 0, checkedOptionIndices: [], customMenuIndex: null, rejectWithEscapeIndex: null,
      optionSteps: [keySteps([KEY.enter])],
    }, hashed);
  }
  if (!field) return null;
  // Text labels and dropdown values can repeat. Without the field's position, a stale card could answer its twin.
  const positionUnverified = box.total !== null && !navigable && field.internal.ompFormChoices === undefined;
  return finishPrompt("omp", { ...field.draft, ...navigation }, {
    ...field.internal, ...nativeSteps, responder: "omp-form",
    ...(positionUnverified ? { ompFormPositionUnverified: true } : {}),
  }, hashed);
}

/** A pasted textarea can prove it still holds the keys even when its draft is too tall to offer a new card. */
export function ompFormTextareaFocus(screen: string): ParsedPrompt | null {
  const field = parseOmpForm(screen, true);
  return field?.default_custom_text?.includes("\n") && field.ompFormChoices === undefined && !field.ompFormPositionUnverified ? field : null;
}

export const readers: readonly DialogReader[] = [
  {
    id: "omp-form", agents: ["omp"], priority: 25,
    reread: "none", list: "none",
    parse: (screen) => parseOmpForm(screen),
  },
];
