import type { DialogReader } from "./registry.ts";
import { ANSI_RE, onePerPass, type AnswerStep, KEY, type ParsedPrompt, type PromptDraft, findLastIndex, finishPrompt, keySteps, navigationKeys, own } from "./shared.ts";
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
 * questions shows each one's line (✓ answered, · waiting) and expands only the active (▸) one,
 * so the card is that question; the next one becomes the next card.
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
 * is there: the card goes only to open questions with none answered on the way.
 *
 * The batch is named by all it draws of itself: every question's text, which are answered and the
 * answer drawn under each. Hermes draws a question's options only while it is open, so nothing on
 * the screen names the options of the question a key moves to: a move is one key, and each one is
 * asked for anew against the card it leaves (whose id holds the open question and its options).
 */
function hermesNavigation(block: string[], base: number, current: number, switches: boolean): Pick<PromptDraft, "steps" | "can_step_back" | "can_step_next"> & { nativeSteps?: NativeSteps } {
  const indent = (line: string) => line.length - line.trimStart().length;
  const questions: { label: string; answered: boolean; current: boolean }[] = [];
  const drawn: string[][] = [];
  for (const [index, line] of block.entries()) {
    const text = line.trim();
    if (indent(line) !== base) {
      // an answered question's answer, drawn under it; the open one's rows change as it moves
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
  // the question next to the open one, itself still open
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
  const block = lines.slice(askIndex + 1, hintIndex).filter((line) => line.trim());
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
    return finishPrompt("hermes", {
      kind: "question", title: own("Question"), question, body,
      options: [{ label: own("Type your answer"), description: null }], multi_select: false, custom_option_index: 0,
      ...navigation,
    }, {
      ...(nativeSteps ? { nativeSteps } : {}),
      responder: "hermes-input", menuLabels: [], selectedIndex: 0, checkedOptionIndices: [], customMenuIndex: 0,
      rejectWithEscapeIndex: null, customSteps: typed,
    });
  }
  const rows: { label: string; selected: boolean; box: boolean; checked: boolean }[] = [];
  for (const line of member) {
    const row = line.match(HERMES_ROW_RE);
    if (row && Number(row[3]) === rows.length + 1) rows.push({ label: row[4]!, selected: Boolean(row[1]), box: Boolean(row[2]), checked: row[2] === "[x] " });
    else if (rows.length) rows.at(-1)!.label += ` ${line}`; // a label wrapped onto the next line
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
      const want = new Set(picked);
      let cursor = selectedIndex;
      const keys: string[] = [];
      for (const index of choices.keys()) {
        if (want.has(index) === checked.includes(index)) continue;
        keys.push(...navigationKeys(index - cursor), KEY.space);
        cursor = index;
      }
      // Enter on the Other row opens its text line instead of locking the ticks
      if (cursor === choices.length) keys.push(KEY.up);
      return keySteps([...keys, KEY.enter]);
    } } : {}),
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
 *
 * A result counts only when it is complete: its layout's own lines are all there, and the CLI has
 * moved on, back at its idle `❯` prompt or on to the next command's echo.
 */
type HermesResultReader = "hermes-help" | "hermes-status" | "hermes-version" | "hermes-profile" | "hermes-reload-skills";

export const HERMES_ECHO_RE = /^⚙\uFE0F?\s+(\/\S+)$/;
/** where a block ends: the next echo, the status bar, the input's rule or the prompt */
const HERMES_BLOCK_END_RE = /^(?:⚙\uFE0F?\s+\/| ☤ |─{8,}$|❯ ?)/;
const HERMES_IDLE_RE = /^❯(?: |$)/;
const RELOAD_INTRO_RE = /^(?:⏳|🔄) Reloading skills\.\.\.$/;
const RELOAD_COUNT_RE = /^📚 \d+ skill\(s\) available$/;

/** The last lines of a block joined as the terminal wrapped them, for an end that may wrap. */
const endsWith = (lines: string[], end: RegExp): boolean =>
  [1, 2, 3, 4].some((count) => count <= lines.length && end.test(lines.slice(-count).map((line) => line.trim()).join("")));

const firstLine = (lines: string[]): string => lines[0]?.trim() ?? "";

/**
 * cli_info_mixin.py _reload_skills, under the busy line: "No new skills detected." or the added and
 * removed lists, then the count; or one failure line. Anything less is not a reload Hermes printed.
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

/** each command's layout: its echoed names, and whether a block is the whole of its output */
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

/**
 * The complete block of `layout` starting at `start` (the line under its echo), as the screen shows it:
 * it ends at a later echo or at the bottom chrome, never where the text merely stops.
 */
function blockAt(lines: string[], start: number, layout: (typeof HERMES_LAYOUTS)[number]): { lines: string[]; catalogChanged?: true } | null {
  let end = start;
  while (end < lines.length && !HERMES_BLOCK_END_RE.test(lines[end]!.trimEnd())) end += 1;
  if (end >= lines.length) return null;
  const block = lines.slice(start, end);
  while (block.length && !block[0]!.trim()) block.shift();
  while (block.length && !block.at(-1)!.trim()) block.pop();
  // printing ends once the next command is echoed, or the prompt is idle again
  const movedOn = HERMES_ECHO_RE.test(lines[end]!.trimEnd()) || lines.slice(end).some((line) => HERMES_IDLE_RE.test(line));
  if (!block.length || !movedOn || !layout.complete(block, movedOn)) return null;
  return layout.reader === "hermes-reload-skills" && reloadLayout(block) === "succeeded" ? { lines: block, catalogChanged: true } : { lines: block };
}

const screenLines = (screen: string): string[] => screen.replace(ANSI_RE, "").split(/\r?\n/);

/**
 * A result reader is given what is below this send's own echo (server/outcome.ts) and the text sent:
 * the block must start there. Its card shows what Hermes printed and closes with Dismiss, which
 * sends nothing.
 */
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
  ...HERMES_LAYOUTS.map(({ reader }) => resultReader(reader)),
];
