import type { DialogReader } from "./registry.ts";
import { ANSI_RE, onePerPass, type AnswerStep, type CardWords, KEY, type ParsedPrompt, type PromptDraft, editorRowsMatch, englishOf, findLastIndex, finishPrompt, keySteps, navigationKeys, own, toggleMultiSelectKeys } from "./shared.ts";
import type { NativeSteps } from "./step-navigate.ts";

/**
 * Hermes's clarify question, as its Ink TUI draws it (ui-tui/src/components/prompts.tsx):
 *
 *   ask 1 question
 *   ▸ Pick a colour
 *     ▸ 1. Red (Recommended)
 *       2. Blue
 *       3. Other (type your answer)
 *   0/1 answered · ↑/↓ select · Enter confirm and continue · Tab/Shift+Tab switch question · Esc/Ctrl+C cancel
 *
 * An open question, or "Other" once picked, shows a `> ` line instead of the rows. A batch of
 * questions shows each one's line (✓ answered, · waiting) and expands only the active (▸) one.
 */
export const HERMES_HINT_RE = /^(\d+)\/(\d+) answered · /;

const HERMES_ASK_RE = /^ask \d+ questions?$/;

// the batch's hint while Tab moves the open question (ui-tui i18n/en/overlays.ts clarify.hint)
const HERMES_SWITCH_RE = /· Tab\/Shift\+Tab switch question ·/;

const HERMES_ROW_RE = /^(▸ )?(\[[ x]\] )?(\d+)\. (.+)$/;

const HERMES_OTHER = "Other (type your answer)";

/**
 * A batch's questions as the card's steps, each line `✓` answered, `▸` open now, `·` waiting,
 * the question wrapped at its own indent. Tab and Shift+Tab move the open one (ui-tui
 * prompts.tsx), but an answered question shows `✓` even while Tab is on it, so nothing tells it
 * is there.
 *
 * Hermes draws a question's options only while it is open.
 */
function hermesNavigation(block: string[], base: number, current: number, switches: boolean): Pick<PromptDraft, "steps" | "can_step_back" | "can_step_next"> & { nativeSteps?: NativeSteps } {
  const indent = (line: string) => line.length - line.trimStart().length;
  const questions: { label: string; answered: boolean; current: boolean }[] = [];
  const drawn: string[][] = [];
  for (const [index, line] of block.entries()) {
    const text = line.trim();
    if (indent(line) !== base) {
      if (questions.at(-1)?.answered) drawn.at(-1)!.push(text);
      continue;
    }
    if (/^[▸·✓] /.test(text)) {
      questions.push({ label: text.slice(2), answered: text.startsWith("✓"), current: index === current });
      drawn.push([]);
    } else if (questions.length > 0) questions.at(-1)!.label += ` ${text}`;
  }
  const at = questions.findIndex((question) => question.current);
  if (questions.length < 2 || at < 0) return {};
  // while an answer is typed the hint drops "Tab/Shift+Tab switch question", and Tab does nothing
  if (!switches) return { steps: questions };
  const reachable = (to: number) => Math.abs(to - at) === 1 && questions[to] !== undefined && !questions[to].answered;
  return {
    steps: questions.map((question, index) => ({ ...question, ...(reachable(index) ? { can_navigate: true } : {}) })),
    can_step_back: reachable(at - 1),
    can_step_next: reachable(at + 1),
    nativeSteps: { identity: JSON.stringify(questions.map((question, index) => [question.label, question.answered, drawn[index]])), index: at, count: questions.length, next: KEY.tab, previous: KEY.backtab },
  };
}

function parseHermesClarify(screen: string): ParsedPrompt | null {
  const lines = screen.replace(ANSI_RE, "").split(/\r?\n/).map((line) => line.trimEnd());
  const hintIndex = findLastIndex(lines, (line) => HERMES_HINT_RE.test(line.trim()));
  if (hintIndex < 0) return null;
  const askIndex = findLastIndex(lines.slice(0, hintIndex), (line) => HERMES_ASK_RE.test(line.trim()));
  if (askIndex < 0) return null;
  const rawBlock = lines.slice(askIndex + 1, hintIndex);
  const occupied = rawBlock.flatMap((line, index) => line.trim() ? [index] : []);
  const block = occupied.map((index) => rawBlock[index]!);
  const indent = (line: string) => line.length - line.trimStart().length;
  const at = block.findIndex((line) => line.trimStart().startsWith("▸ ") && !HERMES_ROW_RE.test(line.trim()));
  if (at < 0) return null;
  const base = indent(block[at]!);
  // the question wraps at its own indent; its rows (or `> ` line) sit deeper
  let end = at + 1;
  while (end < block.length && indent(block[end]!) === base && !/^[▸·✓] /.test(block[end]!.trim())) end += 1;
  const question = block.slice(at, end).map((line) => line.trim()).join(" ").slice(2);
  const member: string[] = [];
  for (let i = end; i < block.length && indent(block[i]!) > base; i += 1) member.push(block[i]!.trim());
  const [answered, total] = lines[hintIndex]!.trim().match(HERMES_HINT_RE)!.slice(1).map(Number);
  const body = total! > 1 ? own("{answered}/{total} answered", { answered: answered!, total: total! }) : null;
  // text already on the `>` line (typed in the terminal, or a typed answer Tab brought back)
  // would join the answer: the line is emptied first, after the cursor and before it (its
  // TextInput's ctrl+k and ctrl+u, on every platform)
  const typed = (text: string): AnswerStep[] => [...keySteps(["ctrl+k", "ctrl+u"]), { text }, ...keySteps([KEY.enter])];
  const switches = HERMES_SWITCH_RE.test(lines[hintIndex]!);
  if (member[0]?.startsWith(">")) {
    const { nativeSteps, ...navigation } = hermesNavigation(block, base, at, switches);
    const questionStep = (step: { readonly label: CardWords; readonly current: boolean; readonly answered: boolean }) => [englishOf(step.label), step.current, step.answered];
    return finishPrompt("hermes", {
      kind: "question", title: own("Question"), question, body,
      options: [{ label: own("Type your answer"), description: null }], multi_select: false, custom_option_index: 0,
      ...navigation,
    }, {
      ...(nativeSteps ? { nativeSteps } : {}),
      responder: "hermes-input", menuLabels: [], selectedIndex: 0, checkedOptionIndices: [], customMenuIndex: 0,
      rejectWithEscapeIndex: null, customSteps: typed,
      customEditorMatches: ({ prompt, text }) => {
        const start = occupied[end];
        if (start === undefined || question !== prompt.question || (total! > 1 && prompt.steps?.length !== total)
          || JSON.stringify(navigation.steps?.map(questionStep)) !== JSON.stringify(prompt.steps?.map(questionStep))
          || lines.slice(hintIndex + 1).some((line) => /^\s*[❯›>$]/.test(line))) return false;
        const input = rawBlock.slice(start, occupied[end + member.length]);
        const first = /^(\s*> )(.*)$/.exec(input[0] ?? "");
        if (!first) return false;
        const indent = " ".repeat(first[1]?.length ?? 0);
        return input.slice(1).every((line) => line === "" || line.startsWith(indent))
          && editorRowsMatch([first[2] ?? "", ...input.slice(1).map((line) => line.slice(indent.length))], text);
      },
    });
  }
  const rows: { label: string; selected: boolean; box: boolean; checked: boolean }[] = [];
  for (const line of member) {
    const row = line.match(HERMES_ROW_RE);
    if (row && Number(row[3]) === rows.length + 1) rows.push({ label: row[4]!, selected: Boolean(row[1]), box: Boolean(row[2]), checked: row[2] === "[x] " });
    else if (rows.length) rows.at(-1)!.label += ` ${line}`;
    else return null;
  }
  if (rows.length < 2 || rows.at(-1)!.label !== HERMES_OTHER) return null;
  const selectedIndex = rows.findIndex((row) => row.selected);
  if (selectedIndex < 0) return null;
  const choices = rows.slice(0, -1);
  // a multi-select question draws a box on every choice; its Other row has none
  const multi = choices.every((row) => row.box);
  if (!multi && choices.some((row) => row.box)) return null;
  const checked = choices.flatMap((row, index) => row.checked ? [index] : []);
  const { nativeSteps, ...navigation } = hermesNavigation(block, base, at, switches);
  return finishPrompt("hermes", {
    kind: "question", title: own("Question"), question, body,
    options: choices.map((row) => ({ label: row.label.replace(/ \(Recommended\)$/i, ""), description: null })),
    // typed text on a multi-select question joins the ticks, which the card has no way to say
    multi_select: multi, custom_option_index: multi ? null : choices.length,
    ...navigation,
  }, {
    ...(nativeSteps ? { nativeSteps } : {}),
    responder: "hermes-question", menuLabels: rows.map((row) => row.label), selectedIndex,
    checkedOptionIndices: checked, customMenuIndex: multi ? null : choices.length, rejectWithEscapeIndex: null,
    // Enter on the Other row opens its `>` line
    ...(multi ? {} : { customSteps: (text: string) => [...keySteps([...navigationKeys(choices.length - selectedIndex), KEY.enter]), ...typed(text)] }),
    // Space ticks the row under the cursor; Enter then locks the ticked rows
    ...(multi ? { multiSteps: (picked: number[]) => {
      const { keys, cursor } = toggleMultiSelectKeys(choices.length, selectedIndex, checked, picked);
      // Enter on the Other row opens its text line instead of locking the ticks
      if (cursor === choices.length) keys.push(KEY.up);
      return keySteps([...keys, KEY.enter]);
    } } : {}),
  });
}

/**
 * Hermes's dangerous-command approval, as its CLI draws it (0.21.5's classic layout below; 0.23's default modern
 * layout draws the same panel, with the hint, the rule over the input holding the spinner, the input, then the status
 * bar under it, recorded in server/fixtures/hermes-approval/modern-*) over
 * the input (hermes_cli/cli_tui_mixin.py _get_approval_display_fragments), recorded on panes 120 and
 * 38 columns wide, 15 and 14 rows high, and 41 columns attached from a phone, in
 * server/fixtures/hermes-approval/:
 *
 *   ╭────────────────────────────────────────────────╮
 *   │ ⚠️  Dangerous Command                          │
 *   │                                                │
 *   │ rm -rf ./scratch                               │
 *   │                                                │
 *   │ ❯ 1. Allow once                                │
 *   │   2. Allow for this session                    │
 *   │   3. Add to permanent allowlist                │
 *   │   4. Deny                                      │
 *   │                                                │
 *   │ recursive delete                               │
 *   ╰────────────────────────────────────────────────╯
 *
 *     💻 rm -rf ./scratch  (  6.7s · ↓ 5 tok)
 *     ↑/↓ to select, Enter to confirm  (3593s)
 *    ☤ fixture-model │ …
 *   ─────────────────
 *   ⚠ ❯
 *   ─────────────────
 *
 * A pane short of rows drops the blank rows, then the description (the warning), with nothing to say
 * so; a command over 70 characters adds a last row, Show full command, which only redraws the panel.
 * A digit picks a row and confirms it at once: the card's answer moves to the row and takes Enter.
 *
 * The card is the panel as drawn, its command lines as they wrap. A panel that leaves anything out
 * (its own "… (" note where it cut the command or the description, or no description), a box out of
 * line (a newline or tab in the command breaks its rows), labels other than these, or anything under
 * it but Hermes's own lines is no card, and no generic card either: the terminal answers it.
 */
const HERMES_APPROVAL_TITLE_RE = /^⚠\uFE0F?\s+Dangerous Command$/u;

/** the hint under the panel (locales/en.yaml cli.tui.hint_approval), its countdown cut by a narrow pane */
const HERMES_APPROVAL_HINT_RE = /^ {2}↑\/↓ to select, Enter to confirm(?: {2}\((?:\d+(?:s\)?)?)?)?$/u;

/** the input line while a panel holds it, the prompt's mark after it on a pane 64 columns or wider */
const HERMES_APPROVAL_INPUT_RE = /^⚠(?: ❯)?$/u;

/**
 * the input line while any of Hermes's modals holds it (an approval, or a command's own confirmation), in
 * every language and with a draft typed into it (cli_tui_mixin.py _get_tui_prompt_fragments)
 */
const HERMES_MODAL_INPUT_RE = /^⚠(?: .*)?$/u;

const HERMES_RULE_RE = /^─{8,}$/u;

/**
 * the rule over the input in Hermes's modern layout (0.23, its default) while it works: its spinner, the tool and
 * timers, then the user's last prompt at the right; a narrow pane cuts it anywhere, with "..." or at its very edge
 */
const HERMES_SPINNER_RULE_RE = /^── [\u2800-\u28FF] /u;

/** Hermes's status bar: its own line, under the input in the modern layout and over it in the classic one */
const HERMES_STATUS_BAR = " ☤ ";

const HERMES_APPROVAL_ROW_RE = /^([❯ ]) (\d)\. (.+)$/u;

const HERMES_CHOICE_LIKE_RE = /^\s*(?:❯\s*)?\d+\.\s/u;

/**
 * Hermes's classic spinner line between the panel and its hint (0.21.5): an icon, the tool and its timer in
 * parentheses, e.g. "  💻 rm -rf ./scratch  (  6.7s · ↓ 5 tok)"; nothing else may stand there
 */
const HERMES_SPINNER_LINE_RE = /^ {2}\p{Extended_Pictographic}\uFE0F? \S.* {2}\((?: *\d+\.\ds|\d{2}m\d{2}s)(?: · [^()]*)?\)$/u;

/** what Hermes left out, in its own words: "… (choose Show full command)", "… (command truncated — …)", "… (description truncated)" */
const HERMES_APPROVAL_CUT_RE = /^… \((?:choose |command truncated|description truncated)/u;

/** the menus Hermes offers, in its order (cli_modal_mixin.py _approval_choices), Show full command left off */
const HERMES_APPROVAL_MENUS = [
  ["Allow once", "Allow for this session", "Add to permanent allowlist", "Deny"],
  ["Allow once", "Allow for this session", "Deny"],
  ["Allow once", "Deny"],
];

const HERMES_SHOW_FULL = "Show full command";

/**
 * Where the approval hint is, read up from the bottom of the screen: the input line the panel holds
 * between its rules, the status bar, then the hint. A pane under 64 columns has no rule under the
 * input, and for a moment after a resize Hermes hides both rules and the status bar
 * (cli_terminal_mixin.py _status_bar_suppressed_after_resize).
 */
function hermesApprovalHint(lines: string[]): number {
  let at = hermesInputLine(lines);
  if (!HERMES_APPROVAL_INPUT_RE.test(lines[at] ?? "")) return -1;
  at -= 1;
  if (HERMES_RULE_RE.test(lines[at] ?? "") || HERMES_SPINNER_RULE_RE.test(lines[at] ?? "")) at -= 1;
  if (lines[at]?.startsWith(HERMES_STATUS_BAR)) at -= 1;
  return HERMES_APPROVAL_HINT_RE.test(lines[at] ?? "") ? at : -1;
}

/**
 * Where the input line is: the last line shown, or the one over the rule a pane 64 columns or wider closes it with;
 * in the modern layout (Hermes 0.23's default) the status bar comes last, under both.
 */
function hermesInputLine(lines: string[]): number {
  let at = lines.length - 1;
  while (at >= 0 && !lines[at]!.trim()) at -= 1;
  if (lines[at]?.startsWith(HERMES_STATUS_BAR)) at -= 1;
  return HERMES_RULE_RE.test(lines[at] ?? "") ? at - 1 : at;
}

/**
 * Whether a modal of Hermes's holds the pane's input, read or not: no generic card is offered over it.
 * Its Enter takes the row under the cursor, Allow once as an approval opens, and the countdown on its hint
 * changes the generic card's id every second anyway. An approval this reader leaves out (cut, in another
 * language, a pane too narrow for its hint) and a command's confirmation alike stay for the terminal.
 */
export function hermesModalWaits(screen: string): boolean {
  const lines = screen.replace(ANSI_RE, "").split(/\r?\n/).map((line) => line.trimEnd());
  // a draft longer than the pane wraps the input onto more lines: its mark is on the first of them, so the lines
  // up to the rule over the input (or Hermes's own line above it) are looked at, not only the last
  // (a draft can hold blank rows, so only Hermes's own lines over the input end the look: a rule, the status bar, the hint)
  for (let at = hermesInputLine(lines); at >= 0; at -= 1) {
    const line = lines[at]!;
    if (HERMES_MODAL_INPUT_RE.test(line)) return true;
    if (/^─{2,}/u.test(line) || line.startsWith(HERMES_STATUS_BAR) || HERMES_APPROVAL_HINT_RE.test(line)) return false;
  }
  return false;
}

function parseHermesApproval(screen: string): ParsedPrompt | null {
  const lines = screen.replace(ANSI_RE, "").split(/\r?\n/).map((line) => line.trimEnd());
  const hint = hermesApprovalHint(lines);
  if (hint < 0) return null;
  // the panel's bottom border, over the spinner's line or lines; the rows a pane has to spare (a phone's
  // pane taller than Hermes needs) stay blank under the panel
  let bottom = hint - 1;
  for (let spinner = 0; bottom >= 0 && !/^╰─+╯$/u.test(lines[bottom]!); bottom -= 1) {
    if (lines[bottom]!.trim() && (!HERMES_SPINNER_LINE_RE.test(lines[bottom]!) || ++spinner > 1)) return null;
  }
  if (bottom < 0) return null;
  const width = [...lines[bottom]!].length;
  let top = bottom - 1;
  while (top >= 0 && /^│ .* │$/u.test(lines[top]!) && [...lines[top]!].length === width) top -= 1;
  if (top < 0 || !/^╭─+╮$/u.test(lines[top]!) || [...lines[top]!].length !== width) return null;
  const [title, ...rows] = lines.slice(top + 1, bottom).map((line) => line.slice(2, -1).trimEnd());
  if (!HERMES_APPROVAL_TITLE_RE.test(title ?? "")) return null;
  // the choices: rows numbered from 1, a label wrapped onto the rows under it at four spaces in. They are the last
  // such block, over the warning; a command or warning that reads like a choice anywhere else is no card, since its
  // rows could stand in for Hermes's own and move the cursor's meaning
  let first = rows.length - 1;
  while (first >= 0 && HERMES_APPROVAL_ROW_RE.exec(rows[first]!)?.[2] !== "1") first -= 1;
  if (first < 1) return null;
  if (rows.slice(0, first).some((row) => HERMES_CHOICE_LIKE_RE.test(row))) return null;
  const choices: { label: string; cursor: boolean }[] = [];
  let end = first;
  for (; end < rows.length; end += 1) {
    const row = HERMES_APPROVAL_ROW_RE.exec(rows[end]!);
    if (row && Number(row[2]) === choices.length + 1) choices.push({ label: row[3]!, cursor: row[1] === "❯" });
    else if (/^ {4}\S/u.test(rows[end]!)) choices.at(-1)!.label += ` ${rows[end]!.trim()}`;
    else break;
  }
  const labels = choices.map((choice) => choice.label);
  const offered = labels.at(-1) === HERMES_SHOW_FULL ? labels.slice(0, -1) : labels;
  if (!HERMES_APPROVAL_MENUS.some((menu) => menu.join("\n") === offered.join("\n"))) return null;
  if (choices.filter((choice) => choice.cursor).length !== 1) return null;
  // a blank row under the title, over the choices and over the description, or none at all
  const spaced = rows[0] === "";
  const command = rows.slice(spaced ? 1 : 0, spaced ? first - 1 : first);
  const description = rows.slice(spaced ? end + 1 : end);
  if ((spaced && (rows[first - 1] !== "" || rows[end] !== "")) || !command.some(Boolean) || !description.some(Boolean)) return null;
  if ([...command, ...description].some((line) => HERMES_APPROVAL_CUT_RE.test(line))) return null;
  if (description.some((line) => HERMES_CHOICE_LIKE_RE.test(line))) return null;
  return finishPrompt("hermes", {
    kind: "approval", title: title!.replace(/^⚠\uFE0F?\s+/u, ""), question: description.map((line) => line.trim()).filter(Boolean).join(" "),
    body: command.join("\n"),
    options: offered.map((label) => ({ label, description: null })), multi_select: false, custom_option_index: null,
  }, {
    responder: "hermes-approval", menuLabels: labels, selectedIndex: choices.findIndex((choice) => choice.cursor),
    checkedOptionIndices: [], customMenuIndex: null, rejectWithEscapeIndex: null,
  });
}

/**
 * What Hermes's classic CLI (0.21.5, its default interface) prints for /help, /status, /version,
 * /profile and /reload-skills: each is printed inline under the CLI's own echo of the command
 * (cli_tui_runtime_mixin.py: `⚙️  /status`); none opens a pager. Recorded at 40 and 120 columns
 * in server/fixtures/hermes-results/.
 *
 *   ⚙️  /status
 *   Hermes CLI Status
 *
 *   Session ID: 20261020_184853_b7a650
 *   …
 *   Agent Running: No
 *    ☤ fixture-model │ ctx -- │ …        (the status bar)
 *   ────────────────────────────
 *   ❯ …                                  (the prompt, idle again)
 */
type HermesResultReader = "hermes-help" | "hermes-status" | "hermes-version" | "hermes-profile" | "hermes-reload-skills";

export const HERMES_ECHO_RE = /^⚙\uFE0F?\s+(\/\S+)$/;
const HERMES_BLOCK_END_RE = /^(?:⚙\uFE0F?\s+\/| ☤ |─{8,}$|❯ ?)/;
const HERMES_IDLE_RE = /^❯(?: |$)/;
const RELOAD_INTRO_RE = /^(?:⏳|🔄) Reloading skills\.\.\.$/;
const RELOAD_COUNT_RE = /^📚 \d+ skill\(s\) available$/;

const endsWith = (lines: string[], end: RegExp): boolean =>
  [1, 2, 3, 4].some((count) => count <= lines.length && end.test(lines.slice(-count).map((line) => line.trim()).join("")));

const firstLine = (lines: string[]): string => lines[0]?.trim() ?? "";

/**
 * cli_info_mixin.py _reload_skills, under the busy line: "No new skills detected." or the added and
 * removed lists, then the count; or one failure line.
 */
function reloadLayout(lines: string[]): "succeeded" | "failed" | null {
  const shown = lines.map((line) => line.trim());
  if (!RELOAD_INTRO_RE.test(shown[0] ?? "")) return null;
  if (shown[1]?.startsWith("❌ Skills reload failed: ")) return "failed";
  const count = shown.findIndex((line, index) => index > 1 && RELOAD_COUNT_RE.test(line));
  if (count < 0 || count !== shown.length - 1) return null;
  const middle = shown.slice(1, count);
  if (middle.length === 1 && middle[0] === "No new skills detected.") return "succeeded";
  // the added section, then the removed one, each printed only with its skills (`- name: description`);
  // a skill line the terminal wrapped goes on at column 0
  const headers = ["➕ Added Skills:", "➖ Removed Skills:"];
  let next = 0;
  let items = -1;
  for (let index = 1; index < count; index += 1) {
    const line = shown[index]!;
    const header = headers.indexOf(line);
    if (header >= next) {
      if (items === 0) return null;
      next = header + 1;
      items = 0;
    } else if (items >= 0 && line.startsWith("- ")) items += 1;
    else if (items <= 0 || /^\s/.test(lines[index]!) || !line) return null;
  }
  return items > 0 ? "succeeded" : null;
}

const HERMES_LAYOUTS: readonly { reader: HermesResultReader; names: readonly string[]; complete(lines: string[], movedOn: boolean): boolean }[] = [
  {
    reader: "hermes-status", names: ["/status"],
    // cli_session_mixin.py _show_session_status: title, blank, fields; "Agent Running" is always last
    complete: (lines) => firstLine(lines) === "Hermes CLI Status" && /^Agent Running: (?:Yes|No)$/.test(lines.at(-1)!.trim()),
  },
  {
    reader: "hermes-version", names: ["/version", "/v"],
    // _startup_fast.py print_fast_version_info: the update line is optional (a failed check prints none)
    complete: (lines, movedOn) => /^Hermes Agent v\S/.test(firstLine(lines))
      && (endsWith(lines, /(?:Update available.*run '[^']+'|Up to date)$/) || (movedOn && /^OpenAI SDK: /.test(lines.at(-1)!.trim()))),
  },
  {
    reader: "hermes-profile", names: ["/profile"],
    // cli_commands_session_tools.py _handle_profile_command: both lines in one print
    complete: (lines) => /^Profile: \S/.test(firstLine(lines)) && lines[1]?.trim().startsWith("Home:") === true,
  },
  {
    reader: "hermes-reload-skills", names: ["/reload-skills", "/reload_skills"],
    complete: (lines) => reloadLayout(lines) !== null,
  },
  {
    reader: "hermes-help", names: ["/help"],
    // cli_info_mixin.py show_help: a framed header; the paste hint is its last line
    complete: (lines) => firstLine(lines).startsWith("+---") && endsWith(lines, /Paste image: Alt\+V \(or \/paste\)$/),
  },
];

function blockAt(lines: string[], start: number, layout: (typeof HERMES_LAYOUTS)[number]): { lines: string[]; catalogChanged?: true } | null {
  let end = start;
  while (end < lines.length && !HERMES_BLOCK_END_RE.test(lines[end]!.trimEnd())) end += 1;
  if (end >= lines.length) return null;
  const block = lines.slice(start, end);
  while (block.length && !block[0]!.trim()) block.shift();
  while (block.length && !block.at(-1)!.trim()) block.pop();
  const movedOn = HERMES_ECHO_RE.test(lines[end]!.trimEnd()) || lines.slice(end).some((line) => HERMES_IDLE_RE.test(line));
  if (!block.length || !movedOn || !layout.complete(block, movedOn)) return null;
  return layout.reader === "hermes-reload-skills" && reloadLayout(block) === "succeeded" ? { lines: block, catalogChanged: true } : { lines: block };
}

const screenLines = (screen: string): string[] => screen.replace(ANSI_RE, "").split(/\r?\n/);

function parseHermesResult(below: string, sent: string | null, reader: HermesResultReader): ParsedPrompt | null {
  const layout = HERMES_LAYOUTS.find((candidate) => candidate.reader === reader)!;
  const command = sent?.trim() ?? "";
  if (!layout.names.includes(command)) return null;
  const block = blockAt(screenLines(below), 0, layout);
  if (!block) return null;
  const text = block.lines.join("\n");
  return {
    ...finishPrompt("hermes", {
      kind: "menu", title: command, question: command, body: text,
      options: [{ label: own("Dismiss"), description: null }], multi_select: false, custom_option_index: null,
    }, {
      responder: reader, menuLabels: ["Dismiss"], selectedIndex: 0, checkedOptionIndices: [], customMenuIndex: null,
      rejectWithEscapeIndex: null, optionSteps: [[]],
    }),
    resultText: text,
    ...(block.catalogChanged ? { catalogChanged: true as const } : {}),
  };
}

/** Hermes's echo of a submitted command line (`⚙️  /status`); its input line is cleared, so no `❯ /status` stays. */
export function hermesEchoOf(line: string, command: string): boolean {
  const echoed = /^⚙\uFE0F?\s+(\S.*)$/u.exec(line.trim())?.[1];
  return echoed !== undefined && echoed.replace(/\s+/gu, " ") === command.trim().replace(/\s+/gu, " ");
}

/**
 * Where Hermes's bottom chrome starts, matching the recorded layout only: the status bar (` ☤ model …`,
 * its timer ticking), the rule, the `❯` input line, and the closing rule when the pane shows it, with
 * nothing but blank lines under them. Also the input line alone at the bottom, with no rule above or under it (under
 * the status bar when that is drawn): Hermes redraws its input area that way while a terminal attaches, slowly on a
 * loaded host (F3 r2 D1). -1 for any other bottom: a rule is chrome only directly above the input line.
 */
export function hermesChromeStart(lines: string[]): number {
  const rule = (line: string | undefined): boolean => line !== undefined && /^─{8,}$/u.test(line);
  let at = lines.length - 1;
  while (at >= 0 && !lines[at]!.trim()) at -= 1;
  if (rule(lines[at])) at -= 1;
  else if (/^❯(?: |$)/u.test(lines[at] ?? "") && !rule(lines[at - 1])) return lines[at - 1]?.startsWith(" ☤ ") ? at - 1 : at;
  if (!/^❯(?: |$)/u.test(lines[at] ?? "")) return -1;
  const top = at - 1;
  if (!rule(lines[top])) return -1;
  return lines[top - 1]?.startsWith(" ☤ ") ? top - 1 : top;
}

const resultReader = (id: HermesResultReader): DialogReader => ({
  id, kind: "result", agents: ["hermes"], priority: 20, reread: "none", list: "none",
  echoOf: hermesEchoOf,
  chromeStart: hermesChromeStart,
  parse: (below, ctx) => parseHermesResult(below, ctx.sent, id),
});

const clarifyRead = onePerPass((screen) => parseHermesClarify(screen));

export const readers: readonly DialogReader[] = [
  {
    id: "hermes-question", agents: ["hermes"], priority: 10,
    reread: "none", list: "none",
    parse: (screen, ctx) => {
      const parsed = clarifyRead(screen, ctx);
      return parsed?.responder === "hermes-question" ? parsed : null;
    },
  },
  {
    id: "hermes-input", agents: ["hermes"], priority: 10,
    reread: "none", list: "none",
    parse: (screen, ctx) => {
      const parsed = clarifyRead(screen, ctx);
      return parsed?.responder === "hermes-input" ? parsed : null;
    },
  },
  {
    id: "hermes-approval", agents: ["hermes"], priority: 10,
    reread: "none", list: "none",
    parse: (screen) => parseHermesApproval(screen),
  },
  ...HERMES_LAYOUTS.map(({ reader }) => resultReader(reader)),
];
