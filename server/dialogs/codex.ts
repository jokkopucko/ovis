import type { DialogReader } from "./registry.ts";
import { pickerPlan } from "./interaction-plan.ts";
import { type InteractivePrompt } from "../../shared/protocol.ts";
import { ANSI_RE, type AnswerStep, KEY, NUMBERED_OPTION_RE, type ParsedPrompt, cleanLine, findLastIndex, finishPrompt, isDivider, own, keySteps, listNames, listRows, menuRows, navigationKeys, nearestQuestion, normalizeText, parseNumberedRows, sequentialRows, wrapped } from "./shared.ts";

// the last of several questions submits them all
export const CODEX_ASK_HINT_RE = /tab to add notes.*enter to submit (?:answer|all).*esc to interrupt/i;

export const CODEX_ASYNC_ASK_HINT_RE = /(?:enter|return).*submit.*(?:ctrl\s*\+\s*\]|skip)/i;

export const CODEX_CONTINUE_HINT_RE = /press\s+enter\s+to\s+continue/i;

// Codex 0.156's queue of questions asked with request_user_input_async, above the main
// prompt: collapsed ("? 2 questions · 8s" / "alt+↑ to answer") or open on one question
export const CODEX_QUEUE_HEADER_RE = /^(?:•\s*)?Queued follow-up inputs$/;

const CODEX_QUEUE_POSITION_RE = /^(\d+) of (\d+)$/;

// request_user_input's hint over several questions: `←/→ to navigate questions` (Codex 0.156 to 0.166)
const CODEX_NAVIGATE_RE = /←\/→ to navigate questions/;

// Codex's `/model` lists, by the footer of the row under the cursor (its keymap's own words): a
// row that only opens the next list takes Enter, a row that picks takes `s` for this session and
// Enter to save the pick as the default (`enter apply` on Ultra)
const CODEX_MODEL_OPEN_HINT_RE = /^enter select\s*·\s*esc back$/i;

const CODEX_MODEL_PICK_HINT_RE = /^enter (?:default|apply)\s*·\s*s session\s*·\s*esc back$/i;

const CODEX_MODEL_TITLE_RE = /^(?:Select Model and Effort|Select Reasoning Level for (\S.*)|Advanced Reasoning)$/;

// the row of a model's levels that opens the advanced ones, by the name Codex gives it
const CODEX_MODEL_MORE_ROW_RE = /^More reasoning(?:…|\.{3})$/;

const CODEX_APPROVAL_HEADER_RE =
  /(?:Would you like to (?:run|make|apply|continue|grant)|Allow Codex to|Approve (?:this )?(?:app )?tool call|Do you trust the contents|Trust this folder\?|Enable full access)/i;

function parseCodexContinueMenu(screen: string): ParsedPrompt | null {
  const lines = screen.replace(ANSI_RE, "").split(/\r?\n/);
  const hintIndex = findLastIndex(lines, (_, index) => CODEX_CONTINUE_HINT_RE.test(wrapped(lines, index)));
  if (hintIndex < 0) return null;
  const rows = menuRows(lines, Math.max(0, hintIndex - 64), hintIndex);
  if (!sequentialRows(rows) || rows.length < 2 || rows.filter((row) => row.selected).length !== 1) return null;
  const body = lines.slice(Math.max(0, rows[0]!.lineIndex - 16), rows[0]!.lineIndex)
    .map(cleanLine).filter((line) => line && !isDivider(line)).join("\n");
  return finishPrompt("codex", {
    kind: "menu", title: "Codex", question: own("Choose how to continue"), body: body || null,
    options: rows.map((row) => ({ label: row.label, description: row.description ?? null })),
    multi_select: false, custom_option_index: null,
  }, {
    responder: "codex-menu", menuLabels: rows.map((row) => row.label),
    selectedIndex: rows.findIndex((row) => row.selected), checkedOptionIndices: [], customMenuIndex: null,
    rejectWithEscapeIndex: null,
  });
}

function parseCodexQuestion(screen: string): ParsedPrompt | null {
  const lines = screen.replace(ANSI_RE, "").split(/\r?\n/);
  const hintIndex = findLastIndex(lines, (_, index) => CODEX_ASK_HINT_RE.test(wrapped(lines, index)));
  if (hintIndex < 0) return null;
  const rows = menuRows(lines, Math.max(0, hintIndex - 48), hintIndex);
  if (!sequentialRows(rows) || rows.filter((row) => row.selected).length !== 1) return null;
  const customIndex = rows.findIndex((row) => /^None of the above\b/i.test(row.label));
  if (customIndex !== rows.length - 1 || customIndex < 1) return null;
  const question = nearestQuestion(lines, rows[0]!.lineIndex);
  if (!question) return null;
  const options = rows.slice(0, customIndex).map((row) => {
    const [label, ...description] = row.label.split(/\s{2,}/);
    return { label: label!, description: description.length ? description.join(" ") : null };
  });
  const progress = lines.slice(Math.max(0, rows[0]!.lineIndex - 6), rows[0]!.lineIndex)
    .map(cleanLine).map((line) => line.match(/^Question (\d+)\/(\d+)/)).find(Boolean);
  const title = progress && progress[2] !== "1" ? own("Question {n} of {total}", { n: progress[1]!, total: progress[2]! }) : own("Question");
  // several questions, and the hint says ←/→ move between them without answering: the card's Back and Next
  const at = progress ? Number(progress[1]) - 1 : 0;
  const total = progress ? Number(progress[2]) : 1;
  const navigates = total > 1 && at < total && CODEX_NAVIGATE_RE.test(wrapped(lines, hintIndex));
  return finishPrompt("codex", {
    kind: "question", title, question, body: null, options,
    multi_select: false, custom_option_index: options.length,
    ...(navigates ? { can_step_back: at > 0, can_step_next: at < total - 1 } : {}),
  }, {
    ...(navigates ? { nativeSteps: { identity: `codex:${total}`, index: at, count: total, next: KEY.right, previous: KEY.left } } : {}),
    responder: "codex-question", menuLabels: rows.map((row) => row.label),
    selectedIndex: rows.findIndex((row) => row.selected), checkedOptionIndices: [], customMenuIndex: customIndex,
    rejectWithEscapeIndex: null,
    // Back and Next come from the hint, which a narrow pane may cut: the same question keeps its id without them
  }, { can_step_back: undefined, can_step_next: undefined });
}

/**
 * A question from Codex's queue, open: under the queue header, an optional "1 of 2", the
 * question (wrapped over as many lines as the pane needs), then its options and a last
 * row that takes a typed answer ("Other", or what was typed there). A free-form question
 * has no options, only that answer line ("Type your answer").
 */
function parseCodexAsyncQuestion(screen: string): ParsedPrompt | null {
  const lines = screen.replace(ANSI_RE, "").split(/\r?\n/);
  const hintIndex = findLastIndex(lines, (_, index) => CODEX_ASYNC_ASK_HINT_RE.test(wrapped(lines, index)));
  if (hintIndex < 0) return null;
  const header = findLastIndex(lines.slice(Math.max(0, hintIndex - 48), hintIndex), (line) => CODEX_QUEUE_HEADER_RE.test(cleanLine(line)));
  const top = header < 0 ? Math.max(0, hintIndex - 48) : Math.max(0, hintIndex - 48) + header + 1;
  // without the header the rows are read from well above: a message sent before can be there too
  const rows = menuRows(lines, top, hintIndex);
  const text = (from: number, to: number) => lines.slice(from, to).map(cleanLine).filter((line) => line && !isDivider(line));
  let position: RegExpMatchArray | null = null;
  const questionLines = (to: number): string[] => {
    const found = text(top, to);
    position = found[0]?.match(CODEX_QUEUE_POSITION_RE) ?? null;
    return position ? found.slice(1) : found;
  };
  let question: string | null;
  let options: InteractivePrompt["options"];
  let menuLabels: string[];
  let selectedIndex: number;
  if (rows.length === 0) {
    // free form: the answer line sits right above the hint
    if (header < 0) return null;
    const answerLine = findLastIndex(lines.slice(0, hintIndex), (line) => Boolean(cleanLine(line)) && !isDivider(line));
    if (answerLine < top) return null;
    question = normalizeText(questionLines(answerLine).join(" ")) || null;
    options = [];
    menuLabels = [];
    selectedIndex = 0;
  } else {
    if (!sequentialRows(rows) || rows.length < 2 || rows.filter((row) => row.selected).length !== 1) return null;
    // an old layout without the header must still end in its "Other" row
    if (header < 0 && !/^Other\b/i.test(rows.at(-1)!.label)) return null;
    // a wrapped option continues on the lines under it: these rows carry no descriptions
    const labels = rows.map((row, index) => normalizeText([row.label, ...text(row.lineIndex + 1, rows[index + 1]?.lineIndex ?? hintIndex)].join(" ")));
    question = header < 0 ? nearestQuestion(lines, rows[0]!.lineIndex) : normalizeText(questionLines(rows[0]!.lineIndex).join(" ")) || null;
    options = labels.slice(0, -1).map((label) => ({ label, description: null }));
    menuLabels = labels;
    selectedIndex = rows.findIndex((row) => row.selected);
  }
  if (!question) return null;
  const at = position as RegExpMatchArray | null;
  return finishPrompt("codex", {
    kind: "question", title: at ? own("Question {n} of {total}", { n: at[1]!, total: at[2]! }) : own("Question"), question, body: null,
    // Codex keeps working while it asks: the card answers it, never a message typed in the chat
    options, multi_select: false, custom_option_index: options.length, queued: "open",
  }, {
    responder: "codex-async-question", menuLabels, selectedIndex, checkedOptionIndices: [],
    customMenuIndex: menuLabels.length === 0 ? 0 : menuLabels.length - 1, rejectWithEscapeIndex: null,
  });
}

function parseCodexApproval(screen: string): ParsedPrompt | null {
  const lines = screen.replace(ANSI_RE, "").split(/\r?\n/);
  const headerIndex = findLastIndex(lines, (line) => CODEX_APPROVAL_HEADER_RE.test(line) && !NUMBERED_OPTION_RE.test(line));
  if (headerIndex < 0) return null;
  const rows = parseNumberedRows(lines, headerIndex + 1, lines.length);
  if (!sequentialRows(rows) || rows.length < 2 || rows.filter((row) => row.selected).length !== 1) return null;
  // "Trust this folder? Codex can read, …": the question heads the card, its explanation joins the body
  const header = cleanLine(lines[headerIndex]!);
  const split = header.match(/^(.*?\?)\s+(.+)$/);
  const heading = split ? split[1]! : header;
  const body = [split?.[2] ?? "", ...lines.slice(headerIndex + 1, rows[0]!.lineIndex).map(cleanLine)].filter(Boolean).join("\n");
  return finishPrompt("codex", {
    kind: "approval", title: heading, question: heading, body: body || null,
    options: rows.map((row) => ({ label: row.label, description: null })), multi_select: false, custom_option_index: null,
  }, {
    responder: "codex-approval", menuLabels: rows.map((row) => row.label),
    selectedIndex: rows.findIndex((row) => row.selected), checkedOptionIndices: [], customMenuIndex: null,
    rejectWithEscapeIndex: rows.findIndex((row) => /^(?:No|Reject|Cancel|Deny)\b/i.test(row.label)),
  });
}

/**
 * Codex's `/model` lists, live in 0.160.1 and as its source draws them
 * (tui/src/chatwidget/model_popups.rs, session_model_selection.rs):
 *
 *   Select Model and Effort                      Select Reasoning Level for GPT-6-Astra
 *
 *     1. GPT-6.1-Sol (default)  Latest workhorse…   1. Low                         Fast responses…
 *   › 2. GPT-6-Astra (current)  Frontier intelli… › 2. Medium (default) (current)  Balances speed…
 *     …                                             5. More reasoning…             Max and Ultra…
 *
 *     enter select · esc back                       enter default · s session · esc back
 *
 * and, behind "More reasoning…", `Advanced Reasoning` over `⚠ Consumes usage limits faster` with
 * Max and Ultra. herdr never reports the pane blocked while one waits (working, done), so the
 * card can only come from the screen.
 *
 * The footer is the row's own, not the list's. Under `enter select` Enter only opens the next
 * list. Under `enter default · s session` (`enter apply` on Ultra) the row picks: `s` for this
 * session, Enter to save the pick as the default for every new one. A model with a single
 * reasoning level picks from the first list already. So which key a row takes is only known
 * with the cursor on it: `rowKey` is that key for the row under the cursor now, and an answer
 * takes it from the screen it reads after its moves (the `pick` step).
 *
 * Enter is sent in one list only, the list of models, where a row opens that model's levels.
 * In a list of levels the row that opens a list ("More reasoning…") stands beside rows whose
 * Enter saves a default, and the look before a key and the key are two herdr calls: a key
 * pressed in the terminal between them would put an Enter meant for that row on a level. So
 * that row is not offered, and no row of those lists is answered with Enter: open the advanced
 * list in the terminal, then its levels can be picked from the card with `s`. The same gap
 * is left in the list of models, where it matters only
 * beside a model with a single level (issue #469 records it for every card).
 *
 * The list is known by its title, since `enter select · esc back` is the footer of every list
 * Codex draws. `Select Model`, the list of quick presets some accounts get first, was not
 * available to look at and gets no card. A pane too narrow for what a row says draws the names
 * alone, or wraps it under itself (the advanced list at 46 columns). The advanced list does not
 * name its model: two models' advanced lists read the same.
 */
const CODEX_MODEL_ROW_RE = /^\s*([❯›>])?\s*(\d+)\.\s+(\S.*)$/;

/** lines Codex puts under a list's title, at most: what the list is for, a warning */
const CODEX_MODEL_NOTE_LINES = 2;

/** how far back a footer is looked for, including words split across very narrow lines */
const CODEX_MODEL_TAIL_LINES = 30;

// Key names a list hint can display, including remapped keys. Restrict the key field so
// ordinary words before a real footer cannot become a fictitious key name after joining lines.
const CODEX_LIST_KEY_HINT = String.raw`(?:(?:ctrl|alt|shift|cmd|super)\+)*(?:enter|return|tab|space|esc|escape|backspace|delete|insert|home|end|pageup|pagedown|up|down|left|right|f\d{1,2}|[a-z0-9])`;

const CODEX_MODEL_GUARD_HINT_RE = new RegExp(`^${CODEX_LIST_KEY_HINT}(?:select|default|apply|confirm)·(?:ssession·)?${CODEX_LIST_KEY_HINT}back$`, "i");

/**
 * A Codex model list's title and the lines under it, from the block of lines right above the
 * rows (blank lines stand between the two). The title is looked for in that block alone: another
 * list's header under an older title is another list. A pane too narrow for the levels' title
 * wraps the model's name under it, and the two are read as one. Lines over the title are the
 * conversation's.
 */
function codexModelHeader(lines: string[], first: number, allowPresets = false): { title: string; model: string | undefined; notes: string[] } | null {
  let end = first - 1;
  while (end >= 0 && !cleanLine(lines[end]!)) end -= 1;
  let start = end;
  while (start > 0 && cleanLine(lines[start - 1]!)) start -= 1;
  const block = end < 0 ? [] : lines.slice(start, end + 1).map(cleanLine);
  const at = findLastIndex(block, (line) => /^(?:Select\b|Advanced Reasoning$)/.test(line));
  if (at < 0) return null;
  // the levels' title runs on to the end of the block when it wrapped; the others are one line
  const whole = /^Select Reasoning Level for(?: \S.*)?$/.test(block[at]!) ? block.slice(at).join(" ") : block[at]!;
  const match = CODEX_MODEL_TITLE_RE.exec(whole);
  const notes = whole === block[at] ? block.slice(at + 1) : [];
  return (match || (allowPresets && whole === "Select Model")) && notes.length <= CODEX_MODEL_NOTE_LINES ? { title: whole, model: match?.[1], notes } : null;
}

/** The key a Codex list's footer names for picking the row under the cursor; null for any other footer. */
function codexModelRowKey(footer: string): AnswerStep | null {
  if (CODEX_MODEL_PICK_HINT_RE.test(footer)) return { text: "s" };
  return CODEX_MODEL_OPEN_HINT_RE.test(footer) ? { keys: [KEY.enter] } : null;
}

/**
 * Whether a Codex model list holds the end of the screen, read or not: by the footer of a row
 * that picks, or by a model title over rows and a footer cut beyond the reader's limit. Such a
 * list gets no fallback card while herdr happens to report the pane blocked: that card offers
 * Enter, and Enter under a footer that offers `s` saves the row as the default for every new
 * session.
 */
export function codexModelListWaits(screen: string): boolean {
  const lines = screen.replace(ANSI_RE, "").split(/\r?\n/).map((line) => line.trimEnd());
  const shown = lines.map((line, index) => ({ text: cleanLine(line), index }))
    .filter(({ text }) => text && !isDivider(text)).slice(-CODEX_MODEL_TAIL_LINES);
  for (let start = 0; start < shown.length; start += 1) {
    // Join a footer split inside words by a very narrow pane. Anything printed after it
    // prevents the match, so an old title/footer in the transcript cannot hide a new prompt.
    const footer = shown.slice(start).map(({ text }) => text).join("").replace(/\s+/g, "");
    if (/^enter(?:default|apply)·ssession·escback$/i.test(footer)) return true;
    if (!CODEX_MODEL_GUARD_HINT_RE.test(footer)) continue;
    // The generic list footer needs a model header in the block immediately above its rows.
    // Quick presets are recognized only by this guard, never offered as a readable card.
    const { rows, first, last } = listRows(lines, shown[start]!.index, CODEX_MODEL_ROW_RE, null);
    const intervening = lines.slice(last + 1, shown[start]!.index).some((line) => cleanLine(line) && !isDivider(cleanLine(line)));
    if (rows.length > 0 && !intervening && codexModelHeader(lines, first, true) !== null) return true;
  }
  return false;
}

// One key as a footer of Codex's names it (CODEX_LIST_KEY_HINT), the arrows it draws as signs, the paging keys' short
// names, `?`, or a Ctrl chord in caret form (`^c`); several keys that do one thing are joined by a slash (`←/→`).
const CODEX_FOOTER_KEY = String.raw`(?:${CODEX_LIST_KEY_HINT}|[←→↑↓⏎↵?]|pgup|pgdn|\^[a-z])`;
const CODEX_FOOTER_KEYS = String.raw`${CODEX_FOOTER_KEY}(?:/${CODEX_FOOTER_KEY})*`;
// what stands between a footer's items: ` · `, a run of spaces (the agents view, /resume), or 0.162's ` or `
const CODEX_FOOTER_GAP = String.raw`(?:\s+·\s+|\s{2,}|\s+or\s+)`;
/**
 * The item of a footer that names the key leaving the screen, whole: `esc back`, `esc cancel`, `esc exit`,
 * `esc save/close`, `q close`, `^c exit`, 0.162's `esc to go back`. `? / esc close`, under the composer while its
 * shortcuts are shown, is not one: that key is no item's start there, and the composer still takes what is typed.
 */
const CODEX_FOOTER_LEAVES_RE = new RegExp(
  `(?:^|${CODEX_FOOTER_GAP})(?:press\\s+)?${CODEX_FOOTER_KEYS}\\s+(?:to\\s+)?(?:go\\s+)?(?:back|cancel|close|exit|dismiss|quit|save/close)(?=$|${CODEX_FOOTER_GAP})`, "i");
/** How a footer's row begins: a key and what it does, or what to type (`Type to find`). A status line begins with its model. */
const CODEX_FOOTER_STARTS_RE = new RegExp(`^(?:(?:press\\s+)?${CODEX_FOOTER_KEYS}\\s+\\S|type to\\b)`, "i");
/** Codex's search through the prompts sent before (Ctrl+R): its field is the screen's last row, with no footer. */
const CODEX_HISTORY_SEARCH_RE = /^(?:reverse|forward)-i-search:/;

/** What a chat send to a Codex pane is refused with while one of those screens is open (`agent_blocked`). */
export const CODEX_OWN_SCREEN_MESSAGE = "Codex has one of its own screens open in the terminal; close it there, then send";

/** rows at the end of the screen a footer is looked for in: two rows of keys (/resume), or one a narrow pane wrapped */
const CODEX_FOOTER_ROWS = 3;

/**
 * Whether one of Codex's own screens has the pane's input instead of its composer: a list (`/model` and its levels,
 * `/permissions`, `/review`, `/theme`, `/resume`, `/experimental`, the folder question), a field (`/rename`, the
 * transcript's Find, the search through earlier prompts), an editor (`/statusline`, `/keymap`), the agents view or a
 * pager (`/diff`). herdr reports Codex at rest under each of them, so a chat message would be pasted there: a list
 * drops the paste, and the Enter that follows takes the row under the cursor (seen on Codex 0.167: it changed the
 * permission mode, answered the folder question, and under `enter default` would save a model for every new session).
 *
 * Each of them ends the screen with a footer of its keys that names the one leaving it (`enter select · esc back`,
 * `space toggle · ←/→ reorder · enter save · esc cancel`, `? help  esc back  ↑/↓ move  enter open  n new`, `q close`
 * under a pager's keys). The composer ends the screen with its status line and `← for agents · ? for shortcuts`,
 * or with the status line alone over a draft, and names no such key. So the footer is looked for in the last rows
 * of the screen, below the last row Codex marks `›` or `»` (a prompt, its composer, a list's cursor): an answer
 * quoting a footer stands above the composer. A row counts when it begins as a footer does and holds that item
 * whole, by itself or with the rows a narrow pane wrapped it onto, and nothing but rows of keys stands under it. The
 * status line begins with its model, so a thread or a folder named like such an item is not one; a row that goes on
 * from the one above it (cut at a `·`) is that row's end; and a line of a draft that reads like a footer has the
 * status line under it.
 */
export function codexOwnScreenOpen(screen: string): boolean {
  const rows = screen.replace(ANSI_RE, "").split(/\r?\n/).map((row) => row.trimEnd());
  const filled = rows.map((row, at) => ({ text: row.trim(), at })).filter(({ text }) => text !== "");
  if (filled.length === 0) return false;
  if (CODEX_HISTORY_SEARCH_RE.test(filled.at(-1)!.text)) return true;
  const marked = findLastIndex(rows, (row) => /^[›»](?:\s|$)/.test(row));
  const tail = filled.filter(({ at }) => at > marked).slice(-CODEX_FOOTER_ROWS);
  const starts = tail.map(({ text }) => CODEX_FOOTER_STARTS_RE.test(text));
  for (let first = 0; first < tail.length; first += 1) {
    if (!starts[first] || /·$/.test(rows[tail[first]!.at - 1] ?? "")) continue;
    // the row itself, then with the rows under it, joined as a pane wraps a row: at a space, or after a slash
    for (let last = first; last < tail.length; last += 1) {
      // a footer ends the screen: under it stand only more rows of keys (/resume has two)
      if (!starts.slice(last + 1).every(Boolean)) continue;
      const wrapped = tail.slice(first, last + 1).map((row) => row.text);
      if (CODEX_FOOTER_LEAVES_RE.test(wrapped.join(" ")) || CODEX_FOOTER_LEAVES_RE.test(wrapped.join(""))) return true;
    }
  }
  return false;
}

function parseCodexModel(screen: string): ParsedPrompt | null {
  const lines = screen.replace(ANSI_RE, "").split(/\r?\n/).map((line) => line.trimEnd());
  const hintIndex = findLastIndex(lines, (_, index) => codexModelRowKey(wrapped(lines, index)) !== null);
  if (hintIndex < 0) return null;
  const { rows, first, last, unread } = listRows(lines, hintIndex, CODEX_MODEL_ROW_RE, null);
  // the rows end right over their footer, and one of them carries the cursor
  if (unread || rows.length < 2 || rows.filter((row) => row.cursor).length !== 1 || lines.slice(last + 1, hintIndex).some((line) => line.trim() !== "")) return null;
  const header = codexModelHeader(lines, first);
  const names = listNames(rows);
  if (header === null || names === null) return null;
  const drawn = names.map(({ name, said }) => ({ label: name.replace(/\s*\(current\)$/, ""), description: said }));
  const selectedIndex = rows.findIndex((row) => row.cursor);
  const footer = codexModelRowKey(wrapped(lines, hintIndex))!;
  const opens = footer.keys !== undefined;
  // the list of models, where a row opens a model's levels and Enter is its key
  const models = header.title === "Select Model and Effort";
  // elsewhere a row that only opens a list is left to the terminal: the one Codex names so, and
  // the one under the cursor when its footer says so
  const offered = rows.flatMap((_, row) => !models && (CODEX_MODEL_MORE_ROW_RE.test(drawn[row]!.label) || (row === selectedIndex && opens)) ? [] : [row]);
  if (offered.length === 0) return null;
  const current = names.findIndex(({ name }) => /\s\(current\)$/.test(name));
  // "Medium (default)" in use reads as Medium: the tag is the list's, not the level's name
  const now = current >= 0 ? drawn[current]!.label.replace(/\s*\(default\)$/i, "") : null;
  const asked = header.title === "Advanced Reasoning"
    ? now !== null ? own("Select advanced reasoning for this session (currently {level})", { level: now }) : own("Select advanced reasoning for this session")
    : header.model !== undefined
      ? now !== null ? own("Select reasoning level for {model} for this session (currently {level})", { model: header.model, level: now }) : own("Select reasoning level for {model} for this session", { model: header.model })
      : now !== null ? own("Select model for this session (currently {model})", { model: now }) : own("Select model for this session");
  return finishPrompt("codex", {
    kind: "question",
    title: "",
    question: offered.length < rows.length ? own("{question}. More levels are listed in the terminal.", { question: asked }) : asked,
    body: header.notes.join("\n") || null,
    options: offered.map((row) => drawn[row]!),
    multi_select: false,
    custom_option_index: null,
  }, {
    // every row drawn, by its list, its number and what it says (the reasoning list of another
    // model has the same rows): the cursor moves among all of them, offered or not
    responder: "codex-model", menuLabels: rows.map((row, index) => `${header.title}  ${row.number}. ${drawn[index]!.label}  ${drawn[index]!.description ?? ""}`), selectedIndex,
    checkedOptionIndices: [], customMenuIndex: null, rejectWithEscapeIndex: null,
    optionSteps: offered.map((row) => [...keySteps(navigationKeys(row - selectedIndex)), { pick: true as const }]),
    // Enter in the list of models alone; `s` wherever the footer offers it; no key otherwise
    rowKey: opens ? models ? footer : null : footer,
  });
}

export const readers: readonly DialogReader[] = [
  {
    id: "codex-menu", agents: ["codex"], priority: 10,
    reread: "none", list: "none",
    parse: (screen) => {
      const parsed = parseCodexContinueMenu(screen);
      return parsed?.responder === "codex-menu" ? parsed : null;
    },
  },
  {
    id: "codex-question", agents: ["codex"], priority: 20,
    reread: "none", list: "none",
    parse: (screen) => {
      const parsed = parseCodexQuestion(screen);
      return parsed?.responder === "codex-question" ? parsed : null;
    },
  },
  {
    id: "codex-async-question", agents: ["codex"], priority: 30,
    reread: "none", list: "none",
    parse: (screen) => {
      const parsed = parseCodexAsyncQuestion(screen);
      return parsed?.responder === "codex-async-question" ? parsed : null;
    },
  },
  {
    id: "codex-approval", agents: ["codex"], priority: 40,
    reread: "none", list: "none",
    parse: (screen) => {
      const parsed = parseCodexApproval(screen);
      return parsed?.responder === "codex-approval" ? parsed : null;
    },
  },
  {
    id: "codex-model", agents: ["codex"], priority: 50,
    reread: "before-commit", list: "letter-window",
    interaction: (parsed) => pickerPlan(parsed, parseCodexModel, parsed.optionSteps ?? [], (shown, cursor) => shown.menuLabels[cursor]),
    parse: (screen) => {
      const parsed = parseCodexModel(screen);
      return parsed?.responder === "codex-model" ? parsed : null;
    },
  },
];
