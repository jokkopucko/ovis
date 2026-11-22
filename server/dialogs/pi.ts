import type { DialogReader } from "./registry.ts";
import { pickerPlan } from "./interaction-plan.ts";
import { ANSI_RE, onePerPass, KEY, PI_MODEL_HINT_RE, PI_ROW_RE, type ParsedPrompt, cleanLine, findLastIndex, finishPrompt, isDivider, keySteps, navigationKeys, own, piModelRows, wrapped } from "./shared.ts";

/**
 * pi draws one menu widget for its dialogs — an extension's `ctx.ui.select`, `confirm` and
 * `input`, and the selectors `/login` and `/scoped-models` open — and names what it takes in a
 * hint line at the dialog's end: `↑↓ navigate  enter select  escape/ctrl+c cancel`, or
 * `enter submit  escape/ctrl+c cancel` while it wants text. Read off that hint, not off
 * indentation: a confirm's message sits indented beside its options, so a row is told from
 * prose only by the hint that follows it. `/tree` is left alone on purpose: its hint says
 * `↑/↓ move`, and answering it from the chat would move the session's branch, which the chat
 * has no way to undo by clicking. pi never reports itself blocked for a dialog — it stays idle
 * while one waits — so the card can only come from the screen, as it does for the other agents.
 * OmO draws the same widget but names Escape `esc` (`esc/ctrl+c cancel`, senpi 2026.10.19).
 */
export const PI_MENU_HINT_RE = /\u2191\u2193 navigate\s+enter select\s+esc(?:ape)?\/ctrl\+c cancel/i;

export const PI_INPUT_HINT_RE = /enter submit\s+esc(?:ape)?\/ctrl\+c cancel/i;

/**
 * A dialog asked with a timeout counts down at the end of its title (`Init-deep (9s)`) and cancels
 * itself at zero. A confirm is a select titled with its title and message on two lines, so there
 * the count ends the message. The card's id reads the dialog's words without the count, or an
 * answer tapped a second later would be refused as one to another card. Only the last line can
 * hold it, alone there when a narrow pane wrapped it (`(10s)` may wrap where `(9s)` fits); a
 * `(30s)` on an earlier line is the text's.
 */
const PI_COUNTDOWN_RE = /(?:^|\s)\(\d+s\)$/;
const uncounted = (words: string[]): string[] => {
  const last = words.at(-1)?.replace(PI_COUNTDOWN_RE, "");
  return last ? [...words.slice(0, -1), last] : words.slice(0, -1);
};

const ownLine = (words: string[]): string => words[0] ?? "";
const restOf = (words: string[]): string | undefined => words.length > 1 ? words.slice(1).join(" ") : undefined;

const PI_INPUT_LINE_RE = /^[\u203a>\u276f]+\s*(.*)$/;

const PI_MODEL_FILTER_RE = /^[\u203a>\u276f]\s*$/;

const PI_MODEL_DEFAULT_RE = /\s*\u00b7\s*default$/;

/**
 * The rows a dialog takes its answer from, and its own words over them. pi separates the two
 * with a blank line and ends the block with its hint, so the run of lines directly above the
 * hint is what its arrow keys move through, and what sits above the blank over it is what the
 * dialog asks. The rule over the dialog is no use for this: it stands over the whole thing,
 * title included, and a confirm indents its message level with its own options.
 *
 * A pane narrower than an option wraps it, and the rest of the label lands on a line of its own.
 * pi sets a row three columns in (` → ` on the cursor's, three spaces on the others) and the
 * wrapped rest one column in, which is all that tells them apart: read as a row of its own, the
 * rest became one more option, and tapping it pressed Down once more than pi has rows, onto the
 * option after it (measured on pi 0.87.1 at 46 columns). The title and a confirm's message wrap
 * the same way, so they are read as one run of lines, the title first.
 */
const PI_WRAPPED_REST_RE = /^ (?![\u2192\u276f\u279c])\S/;

function piDialogRows(lines: string[], hintIndex: number): { rows: { line: string; cursor: boolean }[]; title: string[] } {
  const rows: { line: string; cursor: boolean }[] = [];
  let index = hintIndex - 1;
  while (index >= 0 && !cleanLine(lines[index]!)) index -= 1;
  let rest: string[] = [];
  for (; index >= 0; index -= 1) {
    const raw = lines[index]!.replace(ANSI_RE, "");
    const line = cleanLine(raw);
    if (!line || isDivider(line)) break;
    if (PI_WRAPPED_REST_RE.test(raw)) { rest.unshift(line); continue; }
    rows.unshift({ line: [line, ...rest].join(" "), cursor: /^[\u2192\u276f\u279c]\s*\S/.test(line) });
    rest = [];
  }
  // lines one column in with no row over them are not a wrapped option (the slash palette's own
  // first line, for one): they stand as rows without the cursor, which a first read refuses; a
  // `moved` read keeps them as options, and the answer route then finds the card's id changed
  rows.unshift(...rest.map((line) => ({ line, cursor: false })));
  const title: string[] = [];
  for (; index >= 0 && title.length < 8; index -= 1) {
    if (isDivider(lines[index]!)) break;
    const line = cleanLine(lines[index]!);
    if (!line) {
      if (title.length > 0) break;
      continue;
    }
    title.unshift(line);
  }
  return { rows, title };
}

function parsePiModel(screen: string): ParsedPrompt | null {
  const lines = screen.replace(ANSI_RE, "").split(/\r?\n/);
  const hintIndex = findLastIndex(lines, (_, index) => PI_MODEL_HINT_RE.test(wrapped(lines, index)));
  if (hintIndex < 0) return null;
  // the filter line is the anchor: the catalogue is what sits under it, and anything above
  // belongs to whatever the pane showed before `/model` was typed
  const filterIndex = findLastIndex(lines.slice(0, hintIndex), (line) => PI_MODEL_FILTER_RE.test(cleanLine(line)));
  if (filterIndex < 0) return null;
  const rows = piModelRows(lines, filterIndex + 1);
  if (rows === null) return null;
  const selectedIndex = rows.findIndex((row) => row.cursor);
  const labels = rows.map((row) => row.label);
  // the card names the model answering now, because the answer switches it and whoever taps
  // should know what they are switching from; pi's tick is the only mark that says so
  const current = rows.find((row) => row.current);
  const question = current
    ? own("Select model (currently {model})", { model: current.label.replace(PI_MODEL_DEFAULT_RE, "") })
    : own("Select model");
  return finishPrompt("pi", {
    kind: "question",
    title: "",
    question,
    body: null,
    options: labels.map((label) => ({ label, description: null })),
    multi_select: false,
    custom_option_index: null,
  }, {
    responder: "pi-model", menuLabels: labels, selectedIndex, checkedOptionIndices: [], customMenuIndex: null,
    rejectWithEscapeIndex: null,
  });
}

export const PI_THINKING_HINT_LINES = 6;

/** Thinking uses the model selector's footer, but only visibly offered level rows are choices. */
function parsePiThinking(screen: string): ParsedPrompt | null {
  const lines = screen.replace(ANSI_RE, "").split(/\r?\n/);
  const hintIndex = findLastIndex(lines, (_, index) => PI_MODEL_HINT_RE.test(wrapped(lines, index, PI_THINKING_HINT_LINES)));
  if (hintIndex < 0) return null;
  const headingIndex = findLastIndex(lines.slice(0, hintIndex), (line) => cleanLine(line) === "Thinking Level");
  if (headingIndex < 0) return null;
  const filterIndex = lines.findIndex((line, index) => index > headingIndex && index < hintIndex && /^[>›❯](?:\s|$)/.test(cleanLine(line)));
  if (filterIndex < 0) return null;
  const rows: { label: string; description: string | null; cursor: boolean; current: boolean }[] = [];
  for (const line of lines.slice(filterIndex + 1, hintIndex)) {
    if (!line.trim()) continue;
    // Arrow = highlight, tick = session level; `· default` belongs to the description only.
    const row = line.match(/^([→ ]) ([✓ ]) (off|minimal|low|medium|high|xhigh|max)(?: +(.+))?\s*$/);
    if (!row || rows.some((other) => other.label === row[3])) return null;
    rows.push({ label: row[3]!, description: row[4]?.trim() || null, cursor: row[1] === "→", current: row[2] === "✓" });
  }
  if (rows.length === 0 || rows.filter((row) => row.cursor).length !== 1 || rows.filter((row) => row.current).length > 1) return null;
  const current = rows.find((row) => row.current);
  return finishPrompt("pi", {
    kind: "question", title: "", question: current ? own("Select thinking level (currently {level})", { level: current.label }) : own("Select thinking level"),
    body: null, options: rows.map(({ label, description }) => ({ label, description })),
    multi_select: false, custom_option_index: null,
  }, {
    responder: "pi-thinking", menuLabels: rows.map((row) => row.label),
    selectedIndex: rows.findIndex((row) => row.cursor), checkedOptionIndices: [], customMenuIndex: null,
    rejectWithEscapeIndex: null,
  });
}

export function parsePiDialog(screen: string, moved = false): ParsedPrompt | null {
  const lines = screen.replace(ANSI_RE, "").split(/\r?\n/);
  const hintIndex = findLastIndex(lines, (_, index) => PI_MENU_HINT_RE.test(wrapped(lines, index)) || PI_INPUT_HINT_RE.test(wrapped(lines, index)));
  if (hintIndex < 0) return null;
  const block = piDialogRows(lines, hintIndex);
  if (block.rows.length === 0) return null;
  // pi wants text on a `>` line: there is nothing to pick, and the answer is typed into it
  if (PI_INPUT_HINT_RE.test(wrapped(lines, hintIndex))) {
    if (!block.rows.every((row) => PI_INPUT_LINE_RE.test(row.line))) return null;
    const text = (words: string[]) => ({ title: restOf(words) ?? "", question: ownLine(words) });
    return finishPrompt("pi", {
      kind: "question", ...text(block.title), body: null,
      options: [{ label: own("Type your answer"), description: null }], multi_select: false, custom_option_index: 0,
    }, { responder: "pi-input", menuLabels: [], selectedIndex: 0, checkedOptionIndices: [], customMenuIndex: 0, rejectWithEscapeIndex: null },
    text(uncounted(block.title)));
  }
  // every line of the block must be a row, and a row must be a single label: pi sets its
  // command palette out in two columns, and offering those as options would run a slash
  // command on a click. The palette ends in a row count of its own, not this hint.
  const rows = block.rows.map((row) => row.line.match(PI_ROW_RE)).filter((row): row is RegExpMatchArray => row !== null && row[2] !== undefined);
  if (rows.length !== block.rows.length || rows.length < 2) return null;
  if (rows.some((row) => /\s{2,}/.test(row[2]!))) return null;
  // a dialog moved through by hand sits wherever its last key left the cursor, and the chat
  // would then navigate from a position it cannot see. `moved`: an answer's own keys moved it,
  // and the read before its Enter looks where it stands (the answer route)
  const cursor = block.rows.findIndex((row) => row.cursor);
  if (moved ? cursor < 0 : cursor !== 0) return null;
  const labels = rows.map((row) => row[2]!.trim());
  const confirming = labels.length === 2 && /^yes\b/i.test(labels[0]!) && /^no\b/i.test(labels[1]!);
  const text = (words: string[]) => confirming
    ? { title: ownLine(words), question: restOf(words) ?? ownLine(words) }
    : { title: "", question: words.join(" ") };
  return finishPrompt("pi", {
    kind: confirming ? "approval" : "question",
    ...text(block.title),
    body: null,
    options: labels.map((label) => ({ label, description: null })),
    multi_select: false,
    custom_option_index: null,
  }, {
    responder: confirming ? "pi-confirm" : "pi-question",
    menuLabels: block.rows.map((row) => row.line),
    selectedIndex: cursor, checkedOptionIndices: [], customMenuIndex: null,
    // "No" is pressed, not cancelled: pi's own Yes/No answers the question false, which is
    // what a confirmation means, where Escape would leave it unanswered
    rejectWithEscapeIndex: null,
  }, text(uncounted(block.title)));
}

const dialogRead = onePerPass((screen) => parsePiDialog(screen));

export const readers: readonly DialogReader[] = [
  {
    id: "pi-thinking", agents: ["pi"], priority: 10,
    reread: "before-commit", list: "none",
    interaction: (parsed) => pickerPlan(parsed, parsePiThinking,
      parsed.options.map((_, index) => keySteps([...navigationKeys(index - parsed.selectedIndex), KEY.enter])),
      (shown, cursor) => shown.options[cursor]?.label),
    parse: (screen) => parsePiThinking(screen),
  },
  {
    id: "pi-model", agents: ["pi"], priority: 10,
    reread: "before-commit", list: "none",
    interaction: (parsed) => pickerPlan(parsed, parsePiModel,
      parsed.options.map((_, index) => keySteps([...navigationKeys(index - parsed.selectedIndex), KEY.enter])),
      (shown, cursor) => shown.options[cursor]?.label),
    parse: (screen) => {
      const parsed = parsePiModel(screen);
      return parsed?.responder === "pi-model" ? parsed : null;
    },
  },
  {
    id: "pi-question", agents: ["pi"], priority: 90,
    reread: "none", list: "none",
    parse: (screen, ctx) => {
      const parsed = dialogRead(screen, ctx);
      return parsed?.responder === "pi-question" ? parsed : null;
    },
  },
  {
    id: "pi-confirm", agents: ["pi"], priority: 90,
    reread: "none", list: "none",
    parse: (screen, ctx) => {
      const parsed = dialogRead(screen, ctx);
      return parsed?.responder === "pi-confirm" ? parsed : null;
    },
  },
  {
    id: "pi-input", agents: ["pi"], priority: 90,
    reread: "none", list: "none",
    parse: (screen, ctx) => {
      const parsed = dialogRead(screen, ctx);
      return parsed?.responder === "pi-input" ? parsed : null;
    },
  },
];
