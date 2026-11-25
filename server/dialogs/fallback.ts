import type { DialogReader } from "./registry.ts";
import { type InteractivePrompt } from "../../shared/protocol.ts";
import { createHash } from "node:crypto";
import { ANSI_RE, type AnswerStep, type CardWords, KEY, type MenuRow, NUMBERED_OPTION_RE, type NumberedRow, type ParsedPrompt, SELECTED_RE, cleanLine, englishOf, findLastIndex, finishPrompt, isDivider, keySteps, navigationKeys, normalizeText, own, parseNumberedRows, publicPrompt, sequentialRows, parsedByPublicPrompt } from "./shared.ts";

const ASKED_RE = /\?\s*(?:[([][^)\]]*[)\]])?\s*$/;

const YES_NO_RE = /[([]\s*y(?:es)?\s*\/\s*n(?:o)?\s*[)\]]\s*[:?]?\s*$/i;

const ARROWS_RE = /[↑↓]|\barrow keys\b/i;

/**
 * The refusal row of Copilot's and Letta's approval dialogs (Copilot 1.0.109, Letta Code 0.34.23): "3. No, and tell
 * Copilot what to do differently (Esc to stop)", "3. No, and tell Letta Code what to do differently". Neither takes
 * its typed number (Copilot moves its cursor there, Letta ignores it); Esc refuses in both (#4570).
 */
const ESCAPE_REFUSAL_ROW_RE: Readonly<Record<string, RegExp>> = {
  copilot: /^No, and tell Copilot what to do differently\b/,
  letta: /^No, and tell Letta Code what to do differently$/,
};

/**
 * Grok's permission panel row that refuses, its number the key that picks it (Grok 1.0.92): "┃  4 (○) No, reject (type
 * to add feedback)", its hint cut on a narrow pane. Esc moves Grok's focus to its scrollback and leaves the panel up
 * (#4571). The row is read only inside the panel that ends the screen: from the call it asks about ("┃  ›  Run …") down
 * to its footer ("2/4:select  │  Tab:next option  │ …"; a question's says "Tab:next answer"), every row on its bar.
 */
const GROK_REJECT_ROW_RE = /^┃\s+(\d) \([○●]\) (No, reject) \(type to add feedback/u;
const GROK_PROCEED_ROW_RE = /^┃\s+\d \([○●]\) Yes, proceed$/u;
const GROK_PANEL_CALL_RE = /^┃\s+›\s/u;
const GROK_PANEL_FOOTER_RE = /^\d+\/\d+:select\s+│\s+Tab:next option(?:\s+│|$)/u;

/** The rows of Grok's permission panel when it ends the screen (Grok 1.0.92), its call's row first; null otherwise. */
function grokPermissionPanel(rows: string[]): string[] | null {
  if (!GROK_PANEL_FOOTER_RE.test(rows.at(-1) ?? "")) return null;
  for (let start = rows.length - 2; start >= 0 && rows[start]!.startsWith("┃"); start -= 1) {
    if (GROK_PANEL_CALL_RE.test(rows[start]!)) return rows.slice(start, -1);
  }
  return null;
}

/**
 * what a menu's hint line says to do with it: a way to choose ("Enter to select", "↵ choose",
 * "Enter a number", "Type 1-3", "↑/↓ to move"). A plain Enter or Press asks for something else
 * ("Enter recovery code", "Enter your phone number", "Press any key").
 */
const MENU_HINT_RE = /\b(?:select|choose|pick|confirm|navigate|move|esc|cancel)\b|[↑↓↵⏎]|\b(?:enter|type)\s+(?:(?:a|an|the)\s+)?number\b|\b\d\s*[-–]\s*\d\b/i;

const GJC_SELECT_HINT_RE = /^(?:\[↑↓ to navigate, enter to select, esc to (?:cancel|go back)\]|up\/down navigate\s+enter select(?:\s+←\/→ question)?\s+esc cancel|↑\/↓ select\s+enter(?:\s+←\/→ question)?\s+esc\s+PgUp\/PgDn\/Ctrl\+u\/d: question · Wheel: transcript)$/i;

/** GJC also uses the Nerd Font chevron for its active question row. */
const GJC_SELECTED_RE = /^[❯›>]\s*/;

const INPUT_FIELD_RE = /:\s*\S{0,3}$/;

const HINT_LINE_RE = /^(?:[↵⏎]|(?:Press|Enter|Select|Choose|Pick|Type|Esc|ESC)\b)/;

const MENU_WRAP_LINES = 2;

const NOT_PROMPT_TEXT_RE = /^(?:[❯›>"'“]|\$ )/;

/**
 * Claude Code's working line, whole: one of its spinner's frames, what it is doing ending in an
 * ellipsis, and in parentheses the time it has taken and the tokens it has used, then maybe the
 * interrupt hint: "✢ Tempering… (1m 55s · ↓ 10.0k tokens)".
 */
const WORKING_LINE_RE = /^[·✢✳✶✻✽*] (\S(?:.*\S)?…) \((?:\d+h )?(?:\d+m )?\d+s · [↑↓] [\d.,]+[kKmM]? tokens( · esc to interrupt)?\)$/u;

/**
 * The ticking start of omp's status row under its panel while a question waits, in every status-line preset its fixtures
 * hold (omp 18.12-18.13): a spinner frame, braille or the ascii preset's `/-\|`, and the elapsed time, or `π` at rest.
 * The separator and segments after it are the user's choice (" · ⬢ …", " > ⬢ … ▶──6%", " > [M] …", Nerd Font gaps)
 * and stay in the id, as do the model, folder and context they name (#3412, #3416). It may follow the Nerd Font
 * band's powerline cap or the box shape's top border (`╭── `). A braille frame and a time is omp's alone and needs nothing
 * more, as the user may have turned the context segment off; the ascii preset's frame or the resting `π` also needs
 * the context gauge every preset draws (`◫ 5.7%`, `▶──6%`, `>--6%`, `──6%`), so a question's "- 5s delay" or
 * "| 30s timeout" is no status row.
 */
const OMP_STATUS_ROW_RE = /^((?:[\ue0b0-\ue0d4] |╭─+ )?)(?:[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] (?:\d+h )?(?:\d+m )?\d+s( +\S.*)|(?:[/\\|-] (?:\d+h )?(?:\d+m )?\d+s|π)( +\S.*(?:◫ |[─-])\d+(?:\.\d+)?%.*))$/u;

/**
 * How a fallback card's id reads a line of the screen. Claude Code keeps its working line on the
 * screen while it waits on a prompt, and the line's spinner, time and token count change every
 * second or so. An id that took them in refused each answer tapped after a tick as stale (#365).
 *
 * They are blanked on that one line, and only when it is known to be it: the pane runs Claude,
 * the line is its working line to the letter, token count with its arrow included, and no other
 * line of the screen has that shape. Without the token count a time in parentheses may be one
 * that is offered ("Restart service… (300s)"), and two such lines may be a menu's rows with their
 * marker ("· Delete all…" / "* Cancel…"): those screens are hashed as they are, like every other
 * line and every other agent's screen. The words stay in the id, so "Deleting staging…" is never
 * "Deleting production…".
 */
function steadyReader(agent: string, shown: string[]): SteadyReader {
  const waiting = agent === "claude" || agent === "omp" ? undefined : WAITING_LINES[agent];
  if (waiting) return waitingReader(waiting, shown);
  const pattern = agent === "claude" ? WORKING_LINE_RE : agent === "omp" ? OMP_STATUS_ROW_RE : null;
  // omp draws its status row last, under the panel: a status-shaped line anywhere else is read as written, and a
  // row whose exact text another shown line also has is not blanked at all, as `read` goes by the text (#3412)
  const last = shown.at(-1);
  const working = pattern === null ? []
    : agent === "omp" ? (last !== undefined && pattern.test(last) && shown.indexOf(last) === shown.length - 1 ? [shown.length - 1] : [])
    : shown.flatMap((line, at) => pattern.test(line) ? [at] : []);
  const [at] = working;
  if (working.length !== 1 || at === undefined) return { read: (other) => other, working: null };
  const line = shown[at]!;
  const steady = agent === "omp"
    // the spinner and the elapsed time, or the resting π, are omp's ticking part; the model, folder and context stay (#3412)
    ? line.replace(OMP_STATUS_ROW_RE, (_all, lead: string, braille: string | undefined, gauged: string | undefined) => `${lead}<status>${braille ?? gauged}`)
    : line.replace(WORKING_LINE_RE, (_all, doing: string, hint: string | undefined) => `* ${doing} (<time> · <tokens>${hint ?? ""})`);
  return { read: (other) => other === line ? steady : other, working: at };
}

/** A spinner of braille frames as maki and kimi draw it at the start of a row: one frame and a space. */
const BRAILLE_SPINNER = "[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]";

/** an elapsed time as agents draw it: "7.4s", "59s", "1m 06s", "01m05s", "1h 2m 3s" */
const ELAPSED = String.raw`(?:\d+h ?)?(?:\d+m ?)?\d+(?:\.\d+)?s`;

/**
 * The lines agents with no reader of their own (and Hermes, for its generic card) redraw while a prompt of theirs
 * waits, each to the letter, and what it reads as in the id: the clock, countdown, spinner frame or token count
 * blanked, every word kept. A rule is applied only when exactly one shown line has its shape, so two rows of a menu
 * that happen to look alike are read as written; `each` (a spinner frame that starts a row) applies to every row with
 * it, as maki draws one on its tool row and its status bar at once. Recorded from Copilot 1.0.109, Grok 1.0.77,
 * Hermes 0.21.5, Muse 1.4.14, maki, kimi and dsh-tui as the agent lab runs them (2026-11-12).
 */
const WAITING_LINES: Readonly<Record<string, readonly WaitingLine[]>> = {
  // "○ Asking user Waiting for response      36s"
  copilot: [{ pattern: /^(○ \S(?:.*\S)?) {2,}(?:\d+h )?(?:\d+m )?\d+s$/u, steady: "$1 <time>" }],
  // "◆ Waiting on answers for Option A or option B?      7.4s ⇣21.5k [stop]"
  grok: [
    { pattern: /^(◆ Waiting on answers for \S(?:.*\S)?) {2,}(?:\d+m )?\d+(?:\.\d+)?s [⇣↓][\d.]+[kKmM]? \[stop\]$/u, steady: "$1 <time> <tokens> [stop]" },
    // the tool call its permission panel asks about, with the call's time and the turn's (one only on a narrow pane):
    // "◆ Run the file's contents as one shell cal… 0.0s      15s ⇣12.1k [↓][stop]" (Grok 1.0.92)
    { pattern: /^(◆ \S.*?)(?: \d+(?:\.\d+)?s)? {2,}(?:\d+m )?\d+(?:\.\d+)?s [⇣↓][\d.]+[kKmM]? \[↓\]\[stop\]$/u, steady: "$1 <time> <tokens> [↓][stop]" },
  ],
  hermes: [
    // the question with its timer, padded to six characters: "❓ Which color?  ( 57.9s · ↓ 34 tok)", "(01m05s · ↓ 34 tok)",
    // and so "(  5.2s · ↓ 34 tok)" in its first ten seconds
    { pattern: new RegExp(`^(❓ \\S(?:.*\\S)?) {2}\\(\\s*${ELAPSED} · ↓ [\\d.,]+[kKmM]? tok\\)$`, "u"), steady: "$1  (<time> · ↓ <tokens> tok)" },
    // the hint with the time left to answer: "↑/↓ to select, Enter to lock, Tab next question  (3542s)"
    { pattern: /^(↑\/↓ to select, Enter to lock\b.*\S) {2}\(\d+s\)$/u, steady: "$1  (<time left>)" },
    // the status bar under it: the model's name first, then segments that each tick, up to its timer; the name and the
    // words it echoes after the timer stay:
    // "☤ gpt-6-luna │ 12.7K/1.1M │ … │ ⏱ 1m 2s   ─ Use your…"
    { pattern: new RegExp(`^☤ ([^│\\s][^│]*?) │ (?:.* │ )?⏱ ${ELAPSED}(?: {2,}(\\S.*))?$`, "u"), steady: (_all, model, echo) => `☤ ${model} <status>${echo ? ` ${echo}` : ""}` },
  ],
  // "◈ Request user input Color — running (59s)", its glyph turning ◆/◈/◇
  muse: [
    { pattern: new RegExp(`^[◆◈◇] (\\S(?:.*\\S)?) — running \\(${ELAPSED}\\)$`, "u"), steady: "◈ $1 — running (<time>)" },
    // over its approval dialog, while the call waits (Muse 1.4.25): "◇ Calling tools (21s · esc to interrupt)"
    { pattern: new RegExp(`^[◆◈◇] (\\S(?:.*\\S)?) \\(${ELAPSED} · esc to interrupt\\)$`, "u"), steady: "◈ $1 (<time> · esc to interrupt)" },
  ],
  // "⠏ bash> List directory contents    16:34:03" and "⠇ [BUILD]../lab-maki  anthropic/… $0.001"
  maki: [{ pattern: new RegExp(`^${BRAILLE_SPINNER} (\\S.*)$`, "u"), steady: "<spinner> $1", each: true }],
  // "⠋ Using Shell (ls -la)"
  kimi: [{ pattern: new RegExp(`^${BRAILLE_SPINNER} (\\S.*)$`, "u"), steady: "<spinner> $1", each: true }],
  // "🌖 Checking with you · 50s · ↑ 11.3k · ↓ 18 tokens", its moon turning
  "dsh-tui": [{ pattern: new RegExp(`^[\\u{1F311}-\\u{1F318}] (\\S(?:.*\\S)?) · ${ELAPSED} · ↑ [\\d.,]+[kKmM]? · ↓ [\\d.,]+[kKmM]? tokens$`, "u"), steady: "<moon> $1 · <time> · <tokens>" }],
};

interface WaitingLine { pattern: RegExp; steady: string | ((all: string, ...groups: (string | undefined)[]) => string); each?: true }

function waitingReader(rules: readonly WaitingLine[], shown: string[]): SteadyReader {
  const steadied = new Map<string, string>();
  const working: number[] = [];
  for (const rule of rules) {
    const at = shown.flatMap((line, index) => rule.pattern.test(line) ? [index] : []);
    if (at.length === 0 || (at.length > 1 && !rule.each)) continue;
    for (const index of at) {
      steadied.set(shown[index]!, (typeof rule.steady === "string" ? shown[index]!.replace(rule.pattern, rule.steady) : shown[index]!.replace(rule.pattern, rule.steady)));
      working.push(index);
    }
  }
  return working.length === 0 ? { read: (other) => other, working: null }
    : { read: (other) => steadied.get(other) ?? other, working: working.length === 1 ? working[0]! : working.sort((a, b) => a - b) };
}

interface SteadyReader {
  read(line: string): string;
  working: number | number[] | null;
}

export function parseFallbackPrompt(agent: string, screen: string): InteractivePrompt {
  const lines = screen.replace(ANSI_RE, "").split(/\r?\n/);
  const shown = lines.flatMap((line, index) => cleanLine(line) && !isDivider(line) ? [index] : []);
  const steady = steadyReader(agent, shown.map((index) => cleanLine(lines[index]!)));
  // GJC's exact selector first: a label of its that starts with a number is still moved to, never typed
  const selectionMenu = fallbackGjcSelectionMenu(agent, lines, shown);
  const menu = selectionMenu ? null : fallbackMenu(lines.map(unboxed), shown);
  if (menu) {
    const above = shown.filter((index) => index < menu.start).map((index) => cleanLine(lines[index]!));
    const question = [...above].reverse().find((line) => ASKED_RE.test(line)) ?? above.at(-1);
    // a row's number is typed alone, as a menu reading keys takes it; a program reading a whole
    // line ("Enter a number >") still waits for the Enter after it, and Esc backs out
    const refusal = ESCAPE_REFUSAL_ROW_RE[agent];
    const refusalRows = refusal ? menu.rows.flatMap((row, index) => refusal.test(row.label) ? [index] : []) : [];
    const escapeRow = refusalRows.length === 1 ? refusalRows[0]! : null;
    const choices: { label: string; steps: AnswerStep[] }[] = [
      ...menu.rows.map((row, index) => ({ label: row.label, steps: index === escapeRow ? keySteps([KEY.escape]) : [{ text: String(row.number) }] })),
      { label: "Enter", steps: keySteps([KEY.enter]) },
      { label: "Esc", steps: keySteps([KEY.escape]) },
    ];
    const body = withoutLine(above, question);
    return screenCard(lines, shown, steady, finishPrompt(agent, {
      // the body is every other line above the rows, so a changed command above a same-looking
      // menu is another card; the display cap applies after the hash
      kind: "menu", fallback: true, title: own("Waiting for your answer"), question: question ?? own("The agent is waiting for your answer."),
      body,
      options: choices.map(({ label }) => ({ label, description: null })),
      multi_select: false, custom_option_index: null,
    }, {
      responder: "fallback-menu", menuLabels: choices.map(({ label }) => label), selectedIndex: 0,
      checkedOptionIndices: [], customMenuIndex: null, rejectWithEscapeIndex: escapeRow,
      optionSteps: choices.map(({ steps }) => steps),
    }, steadyFields(agent, question, body, steady.read)));
  }
  if (selectionMenu) {
    let headEnd = selectionMenu.start;
    while (headEnd > 0 && (!cleanLine(lines[headEnd - 1]!) || isDivider(lines[headEnd - 1]!))) headEnd -= 1;
    // GJC's question dialog has its own opening border before the title. The transcript and
    // ticking status above it do not belong to this asking. Its outer borders are unindented
    // and identical; Markdown title rules have left padding. Keep every title paragraph inside,
    // including approval details; without the matching frame keep the whole screen.
    const closing = lines[findLastIndex(lines, (line) => Boolean(line.trim()))]?.trimEnd();
    const border = closing && isDivider(closing) && !/^\s/.test(closing)
      ? findLastIndex(lines.slice(0, headEnd), (line) => line.trimEnd() === closing)
      : -1;
    const dialogShown = border < 0 ? shown : shown.filter((index) => index > border);
    const above = dialogShown.filter((index) => index < selectionMenu.start).map((index) => cleanLine(lines[index]!));
    let headStart = headEnd;
    while (headStart > 0 && cleanLine(lines[headStart - 1]!) && !isDivider(lines[headStart - 1]!)) headStart -= 1;
    const heading = lines.slice(headStart, headEnd).map((line) => cleanLine(line));
    const question = [...heading].reverse().find((line) => ASKED_RE.test(line)) ?? heading.at(-1);
    const choiceRows = new Set(selectionMenu.rows.map((row) => row.lineIndex));
    const customRows = selectionMenu.rows.flatMap((row, index) => /^(?:\d+\.\s*)?Other \(type your own\)$/i.test(row.label) ? [index] : []);
    const customIndex = customRows.length === 1 ? customRows[0]! : null;
    const choices = [
      ...selectionMenu.rows.map((row, index) => ({
        label: row.label,
        steps: keySteps([...navigationKeys(index - selectionMenu.selectedIndex), KEY.enter]),
      })),
      { label: "Esc", steps: keySteps([KEY.escape]) },
    ];
    const body = withoutLine(above, question);
    return screenCard(lines, dialogShown, steady, finishPrompt(agent, {
      kind: "menu", fallback: true, title: own("Waiting for your answer"), question: question ?? own("The agent is waiting for your answer."),
      body,
      options: choices.map(({ label }) => ({ label, description: null })),
      multi_select: false, custom_option_index: customIndex,
    }, {
      responder: "fallback-gjc-menu", menuLabels: choices.map(({ label }) => label), selectedIndex: selectionMenu.selectedIndex,
      checkedOptionIndices: [], customMenuIndex: customIndex, rejectWithEscapeIndex: null,
      optionSteps: choices.map(({ steps }) => steps),
      gjcTitleRows: above,
      ...(border >= 0 && closing ? { gjcTitleWidth: closing.length } : {}),
    }, steadyFields(agent, question, body, steady.read)), choiceRows);
  }
  const last = shown.slice(-16).map((index) => cleanLine(lines[index]!));
  // letters and arrows only for the prompt's own last lines, never while an input box ends the
  // screen (the agent's composer owns the keys then) or for a line of quoted output
  const hints = NOT_PROMPT_TEXT_RE.test(last.at(-1) ?? "") ? [] : last.slice(-2).filter((line) => !NOT_PROMPT_TEXT_RE.test(line));
  const question = [...last].reverse().find((line) => ASKED_RE.test(line)) ?? last.at(-1);
  const panel = agent === "grok" ? grokPermissionPanel(shown.map((index) => cleanLine(lines[index]!))) : null;
  const grokRejects = panel?.filter((line) => GROK_REJECT_ROW_RE.test(line)) ?? [];
  const grokReject = grokRejects.length === 1 && panel!.filter((line) => GROK_PROCEED_ROW_RE.test(line)).length === 1
    ? GROK_REJECT_ROW_RE.exec(grokRejects[0]!) : null;
  // a (y/n) letter is offered only for the prompt at the screen's end, never for a mention
  // above it; it is typed without an Enter: a program reading a whole line still waits for
  // one, and the card that follows offers it
  const choices: { label: CardWords; steps: AnswerStep[] }[] = [
    ...(hints.some((line) => YES_NO_RE.test(line)) ? [{ label: own("Yes (y)"), steps: [{ text: "y" }] }, { label: own("No (n)"), steps: [{ text: "n" }] }] : []),
    ...(hints.some((line) => ARROWS_RE.test(line)) ? [{ label: "↑", steps: keySteps([KEY.up]) }, { label: "↓", steps: keySteps([KEY.down]) }] : []),
    { label: "Enter", steps: keySteps([KEY.enter]) },
    grokReject ? { label: grokReject[2]!, steps: [{ text: grokReject[1]! }] } : { label: "Esc", steps: keySteps([KEY.escape]) },
  ];
  const body = withoutLine(last, question);
  return screenCard(lines, shown, steady, finishPrompt(agent, {
    kind: "menu", fallback: true, title: own("Waiting for input"), question: question ?? own("The agent is waiting for input."),
    body,
    options: choices.map(({ label }) => ({ label, description: null })),
    multi_select: false, custom_option_index: null,
  }, {
    responder: "fallback-keys", menuLabels: choices.map(({ label }) => englishOf(label)), selectedIndex: 0,
    checkedOptionIndices: [], customMenuIndex: null, rejectWithEscapeIndex: null,
    optionSteps: choices.map(({ steps }) => steps),
  }, steadyFields(agent, question, body, steady.read)));
}

function steadyFields(agent: string, question: string | undefined, body: string | null, steady: (line: string) => string): Partial<Pick<InteractivePrompt, "question" | "body">> {
  return { ...(question === undefined ? {} : { question: steady(question) }), body: body === null ? null : body.split("\n").map((line) => tickless(agent, steady(line))).join("\n") };
}

/**
 * Copilot's banner logo (Copilot 1.0.109), which it animates while a prompt of its waits: a drawing at the start of a
 * banner row, before the row's own words and the panel's `│` ("╰─╯╰─╯  Copilot v1.0.109 uses AI.  │  Use the tabs…").
 * Only that drawing, on a row whose words are the banner's own (each of its four rows, as recorded), reads as one mark; the words after it stay. Drawing glyphs anywhere else are
 * read as written: a glyph may mark a menu's selected row ("██ Delete" against "░░ Keep"), and no rule tells it from a
 * drawing, so only an animation known to the letter is read as steady.
 */
const COPILOT_LOGO_ROW_RE = /^[\u2500-\u259f\u2800-\u28ff](?:[\u2500-\u259f\u2800-\u28ff ]*[\u2500-\u259f\u2800-\u28ff])?(\s+(?:(?:Copilot v\S+ uses AI\.|Check for mistakes\.)\s+)?│(?:\s+(?:Getting started|Use the tabs above to explore your sessions and pull requests|\/model — Switch models across providers, or use Copilot Fusion))?)\s*$/u;

function tickless(agent: string, line: string): string {
  return agent === "copilot" ? line.replace(COPILOT_LOGO_ROW_RE, (_all, rest: string) => `<logo>${rest.replace(/\s+/g, " ")}`) : line;
}

const gjcMenuIdentities = new WeakMap<ParsedPrompt, string>();

/** A gjc selector's card with other words shown (server/gjc-ask.ts): its id, keys and custom-editor identity stay the screen's. */
export function gjcMenuShown(parsed: ParsedPrompt, shown: Pick<ParsedPrompt, "question" | "body" | "options" | "text_format" | "gjcCall">): ParsedPrompt {
  const next = { ...parsed, ...shown };
  const identity = gjcMenuIdentities.get(parsed);
  if (identity !== undefined) gjcMenuIdentities.set(next, identity);
  return next;
}

/**
 * A fallback card's id covers the whole visible screen, not just the lines it shows: a changed
 * command, footer or wrapped label anywhere on it makes an answer to the old card stale. A working
 * line's spinner, time and token count are the one thing it leaves out (steadyReader).
 */
function screenCard(lines: string[], shown: number[], steady: SteadyReader, parsed: ParsedPrompt, cursorRows?: ReadonlySet<number>): InteractivePrompt {
  // Preserve the card hash before adding the selector footer's screen hash. The inline editor
  // has a different footer, but must retain the full question body hashed before its display cap.
  if (parsed.responder === "fallback-gjc-menu") gjcMenuIdentities.set(parsed, parsed.id);
  // A cmd heredoc's indentation and separators can change which text is executable.
  const screen = parsed.agent === "cmd" ? lines.join("\n") : shown.map((index) => {
    const line = cleanLine(lines[index]!);
    // GJC moves its cursor within the same menu; the selectedIndex is checked separately on reread.
    const read = steady.read(cursorRows?.has(index) ? line.replace(GJC_SELECTED_RE, "") : line);
    return read === parsed.question ? read : tickless(parsed.agent, read);
  }).join("\n");
  parsed.id = createHash("sha256").update(JSON.stringify({ card: parsed.id, screen, ...(steady.working === null ? {} : { working: steady.working }) })).digest("hex").slice(0, 12);
  return publicPrompt(parsed);
}

function withoutLine(lines: string[], question: string | undefined): string | null {
  const at = question === undefined ? -1 : lines.lastIndexOf(question);
  return lines.filter((_, index) => index !== at).join("\n") || null;
}

/**
 * A numbered menu (`1.` … `n.`, 2 to 9 rows, at most one marked) that still owns the screen's
 * end: its hint, a line that says to choose, is the screen's last, and between the last row and
 * it are only the lines that row wraps onto (right under it, indented past its number). Anything
 * else there (another hint, a new prompt, an input box) may be what takes the keys now, so it is
 * no menu.
 */
function fallbackMenu(lines: string[], shown: number[]): { start: number; rows: NumberedRow[] } | null {
  const lastRow = [...shown].reverse().find((index) => NUMBERED_OPTION_RE.test(cleanLine(lines[index]!)));
  const hintIndex = shown.at(-1);
  if (lastRow === undefined || hintIndex === undefined || hintIndex === lastRow) return null;
  const hint = cleanLine(lines[hintIndex]!);
  // a hint that says to choose, and no input field ("Password:", "Choice: 2"): a numbered
  // list in the agent's output is not a menu
  if (!MENU_HINT_RE.test(hint) || SELECTED_RE.test(hint) || NOT_PROMPT_TEXT_RE.test(hint) || INPUT_FIELD_RE.test(hint)) return null;
  let end = lastRow + 1;
  const numberAt = lines[lastRow]!.search(/\d/);
  while (end < hintIndex && cleanLine(lines[end]!) && !isDivider(lines[end]!) && lines[end]!.search(/\S/) > numberAt) end += 1;
  if (shown.some((index) => index >= end && index < hintIndex) || end - lastRow - 1 > MENU_WRAP_LINES) return null;
  let start = lastRow;
  while (start > 0 && cleanLine(lines[start - 1]!) && !isDivider(lines[start - 1]!)) start -= 1;
  while (start < lastRow && !NUMBERED_OPTION_RE.test(cleanLine(lines[start]!))) start += 1;
  const rows = parseNumberedRows(lines, start, end);
  if (!sequentialRows(rows) || rows.length < 2 || rows.length > 9 || rows.filter((row) => row.selected).length > 1) return null;
  // the lines a row wraps onto belong to its label; an input box or quote between rows, or a
  // row with its own letter key ("Read only (r)"), means the number may not be the key
  for (const [at, row] of rows.entries()) {
    const wrapped = lines.slice(row.lineIndex + 1, rows[at + 1]?.lineIndex ?? end).map(cleanLine).filter(Boolean);
    // a hint or an input field inside the last row's wrap may be an older prompt, with a new one under it
    if (wrapped.some((line) => NOT_PROMPT_TEXT_RE.test(line) || (at === rows.length - 1 && (HINT_LINE_RE.test(line) || /:\s*$/.test(line))))) return null;
    if ([row.label, ...wrapped].some((line) => /\(\w\)$/.test(line))) return null;
    row.label = [row.label, ...wrapped].join(" ");
  }
  return { start, rows };
}

/** GJC's unnumbered selector: a cursor-marked row, two-space rows, and its own selection footer. */
function fallbackGjcSelectionMenu(agent: string, lines: string[], shown: number[]): { start: number; rows: MenuRow[]; selectedIndex: number } | null {
  if (agent !== "gjc" || shown.length === 0) return null;
  let hintStart = -1;
  for (let length = 1; length <= Math.min(3, shown.length); length += 1) {
    const suffix = shown.slice(-length).map((index) => cleanLine(lines[index]!)).join(" ");
    if (GJC_SELECT_HINT_RE.test(suffix)) {
      hintStart = shown[shown.length - length]!;
      break;
    }
  }
  if (hintStart < 0) return null;

  // GJC's standard selector separates the footer with a spacer and can outline its rows.
  // The provider wizard puts its footer directly below them.
  let end = hintStart;
  while (end > 0 && (!cleanLine(lines[end - 1]!) || isDivider(lines[end - 1]!))) end -= 1;
  let start = end;
  while (start > 0 && cleanLine(lines[start - 1]!) && !isDivider(lines[start - 1]!)) start -= 1;
  if (start === 0 || (cleanLine(lines[start - 1]!) && !isDivider(lines[start - 1]!))) return null;
  const rows: MenuRow[] = [];
  for (let index = start; index < end; index += 1) {
    const text = cleanLine(lines[index]!);
    const selected = GJC_SELECTED_RE.test(text);
    const label = normalizeText(text.replace(GJC_SELECTED_RE, ""));
    if (!label || /^\(\d+\/\d+\)$/.test(label) || /…|\.\.\./.test(label)) return null;
    rows.push({ label, selected, checked: false, lineIndex: index });
  }
  const selectedIndex = rows.findIndex((row) => row.selected);
  if (rows.length < 2 || selectedIndex < 0 || rows.filter((row) => row.selected).length !== 1) return null;
  return { start, rows, selectedIndex };
}

const PICKER_MOVE_RE = /↑\s*\/?\s*↓|\bup\/down\b/i;
const PICKER_CHOOSE_RE = /[↵⏎]|\benter\b/i;

const PICKER_CURSOR_ROW_RE = /^[❯›>❭]\s*\S/;

/**
 * Whether a picker of the agent's own owns its input: a key hint that moves and chooses with Enter among the screen's
 * last two lines, and a row under a cursor marker in the few lines above it. Agents no reader knows draw their folder
 * trust this way at start (Devin 2026.7, Copilot 1.0.109, Antigravity 1.5.6), and herdr reports them at rest under it,
 * so a chat message's paste and Enter would pick the row under the cursor ("Yes, trust") and the message would be lost.
 * A narrow pane wraps the hint onto a second row, so two rows joined (where the wrap fell inside a word or not) count too.
 */
export function agentPickerOwnsScreen(screen: string): boolean {
  const shown = screen.replace(ANSI_RE, "").split(/\r?\n/).filter((line) => cleanLine(line) && !isDivider(line)).map(cleanLine);
  const isHint = (line: string): boolean => PICKER_MOVE_RE.test(line) && PICKER_CHOOSE_RE.test(line);
  const starts = [shown.length - 2, shown.length - 1].filter((start) => start >= 0 && isHint(shown[start]!));
  for (const start of [shown.length - 2, shown.length - 3]) {
    const [head, tail] = [shown[start], shown[start + 1]];
    if (start >= 0 && head !== undefined && tail !== undefined && (isHint(`${head} ${tail}`) || isHint(`${head}${tail}`))) starts.push(start);
  }
  return starts.some((end) => shown.slice(Math.max(0, end - 8), end).some((line) => PICKER_CURSOR_ROW_RE.test(line)));
}

/**
 * A line with the side borders of the boxes it is drawn in taken off, the indentation inside kept ("│   2. No  │" is
 * "  2. No"): a numbered menu Copilot draws in a box (its folder trust, its command and edit approvals) reads as the
 * same menu drawn bare, its rows' numbers and the lines they wrap onto where they are.
 */
function unboxed(line: string): string {
  for (let inner = line; ;) {
    const box = inner.match(/^(\s*)│ ?(.*?)\s*│\s*$/);
    if (!box) return inner;
    inner = `${box[1]}${box[2]}`;
  }
}

export function gjcCustomEditorMatches(screen: string, expected: ParsedPrompt, draft: string): boolean {
  if (expected.responder !== "fallback-gjc-menu" || expected.customMenuIndex === null) return false;
  const identity = gjcMenuIdentities.get(expected);
  if (!identity || /[\r\n]/.test(draft)) return false;
  const lines = screen.replace(ANSI_RE, "").split(/\r?\n/);
  const shown = lines.flatMap((line, index) => cleanLine(line) && !isDivider(line) ? [index] : []);
  const footer = "enter submit esc back to options ctrl+g external editor PgUp/PgDn: question · Wheel: transcript";
  let footerStart = -1;
  let footerEnd = -1;
  for (let count = 1; count <= Math.min(3, shown.length); count++) {
    const tail = shown.slice(-count);
    if (normalizeText(tail.map((index) => cleanLine(lines[index]!)).join(" ")) === footer) {
      footerStart = tail[0]!;
      footerEnd = tail.at(-1)!;
      break;
    }
  }
  if (footerStart < 0) return false;
  const text = draft.normalize("NFC").replace(/\t/g, "    ");
  const draftCharacters = text.replace(/\s/g, "").length;
  const editorLines = lines.slice(0, footerStart).map((line) => line.normalize("NFC").replace(/\t/g, "    ").trimEnd());
  while (editorLines.at(-1) === "") editorLines.pop();
  let characters = 0;
  // A wrapped draft can itself start a row with "> ". Only the start that restores the
  // original selector identity belongs to its editor, rather than to the draft or transcript.
  for (let input = editorLines.length - 1; input >= 0; input--) {
    characters += editorLines[input]!.replace(/\s/g, "").length;
    if (characters > draftCharacters + 1) break;
    if (characters !== draftCharacters + 1 || !/^>(?:\s|$)/.test(cleanLine(editorLines[input]!))) continue;
    // Like claudeRestoredDraft, walk exact row contents: a soft wrap can split a word or
    // consume one separating space. Do not flatten internal whitespace or accept missing text.
    let positions = new Set([0]);
    for (let index = input; index < editorLines.length; index++) {
      // Keep leading spaces in continuation rows: a wrap can split two adjacent spaces.
      const row = index === input ? editorLines[index]!.replace(/^\s*> ?/, "") : editorLines[index]!;
      const next = new Set<number>();
      for (const from of positions) {
        const starts = index > input && text[from] === " " ? [from, from + 1] : [from];
        for (const start of starts) if (text.startsWith(row, start)) next.add(start + row.length);
      }
      positions = next;
      if (positions.size === 0) break;
    }
    if (!positions.has(text.length)) continue;
    const restored = [...lines.slice(0, input), "↑/↓ select enter esc PgUp/PgDn/Ctrl+u/d: question · Wheel: transcript", ...lines.slice(footerEnd + 1)].join("\n");
    const parsed = parsedByPublicPrompt.get(parseFallbackPrompt("gjc", restored));
    return parsed?.responder === expected.responder && parsed.selectedIndex === expected.customMenuIndex
      && gjcMenuIdentities.get(parsed) === identity;
  }
  return false;
}

export const readers: readonly DialogReader[] = [
  { id: "fallback-menu", agents: ["*"], priority: 1000, reread: "none", list: "none", parse: () => null },
  { id: "fallback-gjc-menu", agents: ["*"], priority: 1000, reread: "before-commit", list: "none", parse: () => null },
  { id: "fallback-keys", agents: ["*"], priority: 1000, reread: "none", list: "none", parse: () => null },
];
