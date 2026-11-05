import type { DialogReader } from "./registry.ts";
import { pickerPlan } from "./interaction-plan.ts";
import { type InteractivePromptAnswer, type InteractivePromptStep } from "../../shared/protocol.ts";
import { piActiveTab } from "./pi-ask-tabs.ts";
import { ANSI_RE, onePerPass, type CardWords, KEY, NUMBERED_OPTION_RE, type ParsedPrompt, SELECTED_RE, SOLID_RULE_RE, cleanLine, englishOf, findLastIndex, finishPrompt, own, isDivider, joinWrapped, keySteps, listNames, listRows, menuRows, navigationKeys, nearestQuestion, normalizeText, parseNumberedRows, screenWidth, sequentialRows, sliderKeys, wrapped } from "./shared.ts";

// several questions navigate between tabs: "Tab/Arrow keys to navigate"
export const CLAUDE_ASK_HINT_RE = /enter to select.*(?:↑\/↓|tab\/arrow keys) to navigate.*esc to cancel/i;

// question tabs, whole (`←  ☒ Route  ☐ Author  ✔ Submit  →`) or cut off by a narrow pane
const CLAUDE_TABS_RE = /^←\s+[☐☒☑✔]/;

// Claude Code's unnumbered menus (the folder-trust check on a new folder, among others):
// plain rows, `❯` on the selected one, under this hint
export const CLAUDE_CONFIRM_HINT_RE = /enter to confirm.*esc to (?:cancel|exit|go back)/i;

/** Claude Code took invisible characters out of a message and holds it in its input (2.1.294) */
const CLAUDE_HELD_HINT_RE = /^Removed (\d+) invisible characters?\s*·\s*review and press \S+ to send$/i;

// Claude Code's `/effort` slider (2.1.294), the same two keys in other words: Enter saves the level
// as the default for new sessions, `s` keeps it to this session
export const CLAUDE_EFFORT_HINT_RE = /←\/→ to adjust\s*·\s*enter to confirm\s*·\s*s for this session only\s*·\s*esc to cancel/i;

// The slider by its keys alone, for the guard that keeps the fallback card and pending input off
// it: a hint cut inside a word, or drawn without `s`, is still a slider whose Enter saves a default
const guardRe = (parts: string[]): RegExp => new RegExp(parts
  .map((part) => [...part.replace(/\s+/g, "")].map((char) => char.replace(/[/.*+?^${}()|[\]\\]/g, "\\$&")).join("\\s*")).join(".*"), "i");

export const CLAUDE_EFFORT_GUARD_RE = guardRe(["←/→ to adjust · Enter to confirm", "Esc to cancel"]);

// Claude Code's `/model` list, by the two keys it takes a pick with: Enter saves it as the default
// for new sessions, `s` keeps it to this session. Read with spaces optional, as the slider's, for a
// hint a narrow pane cut inside a word (#542)
const CLAUDE_MODEL_GUARD_RE = guardRe(["Enter to set as default", "s to use this session only", "Esc to cancel"]);

/** lines a hint is read over at most: a phone-width pane wraps the model list's over seven (#542) */
const CLAUDE_HINT_LINES = 16;

/** Lines as one, every space taken out: a hint a narrow pane wrapped anywhere, inside a word too, reads whole. */
function compactLines(lines: string[]): string {
  return lines.map(cleanLine).filter((line) => !isDivider(line)).join("").replace(/\s+/g, "");
}

/** Whether hint `re` (spaces optional between its characters) begins line `index` and is read whole by line `end`. */
function hintAt(lines: string[], index: number, re: RegExp, end = index + CLAUDE_HINT_LINES): boolean {
  if (!cleanLine(lines[index] ?? "") || isDivider(cleanLine(lines[index]!))) return false;
  return re.exec(compactLines(lines.slice(index, end)))?.index === 0;
}

/**
 * A question whose options carry a preview (AskUserQuestion's `preview`): the selected option's
 * preview is drawn in a box to the right of the options, "Notes: press n to add notes" under it,
 * with no "Type something" row and an unnumbered "Chat about this" (Claude Code 2.1.288).
 * The box and the notes line are cut off each line, leaving the options as in the plain form.
 * The box stands in one column on every line (its top corner names it), so only what sits in
 * that column goes: a `│` inside an option's own text stays.
 */
const CLAUDE_PREVIEW_HINT_RE = /\bn to add notes\b/i;

const PREVIEW_EDGE = "┌│└├╭╰┐┘╮╯";

/** where the terminal column `column` begins in `line`: a wide character takes two columns and a joined
 * emoji is one grapheme of two, so the index may be smaller; -1 when no grapheme starts there */
const GRAPHEMES = new Intl.Segmenter(undefined, { granularity: "grapheme" });

function indexAtColumn(line: string, column: number): number {
  let width = 0;
  for (const { segment, index } of GRAPHEMES.segment(line)) {
    if (width === column) return index;
    width += Bun.stringWidth(segment);
  }
  return width === column ? line.length : -1;
}

/**
 * Claude Code's fullscreen layout (`"tui": "fullscreen"`) can draw a side panel to the right of the
 * session, its diff panel (`/diff`, `1 file changed +2 … source: Current ▾`) on a wide pane (from about
 * 110 columns on 2.1.303; only the edge is checked here, not the pane's width): every row from the
 * screen's top carries the panel's left edge `│` in one column, the panel's own text after it,
 * down through the prompt and its footer. Those rows are cut at that edge so the session's menus read
 * as without the panel (measured on 2.1.303). A screen whose edge stops
 * before its last non-blank row (a markdown table scrolled above a plan, say) is left as it is.
 */
const CLAUDE_SIDE_PANEL_MIN_COLUMN = 40;
const CLAUDE_SIDE_PANEL_MIN_ROWS = 8;
export function withoutClaudeSidePanel(screen: string): string {
  const lines = screen.replace(ANSI_RE, "").split(/\r?\n/);
  const edges = (line: string): number[] => {
    const columns: number[] = [];
    let width = 0;
    for (const { segment } of GRAPHEMES.segment(line)) {
      if (segment === "│") columns.push(width);
      width += Bun.stringWidth(segment);
    }
    return columns;
  };
  const top = edges(lines[0] ?? "").filter((at) => at >= CLAUDE_SIDE_PANEL_MIN_COLUMN);
  if (top.length === 0) return screen;
  // each row's edges once, past the top row's check that turns away most screens
  const rowEdges = lines.map((line, index) => index === 0 ? top : edges(line));
  const rowsAt = (column: number): number => {
    let rows = 0;
    while (rows < lines.length && rowEdges[rows]!.includes(column)) rows += 1;
    return rows;
  };
  // the panel's edge runs through the footer; a table's column divider stops where the table ends
  const throughFooter = (rows: number): boolean => rows >= CLAUDE_SIDE_PANEL_MIN_ROWS && lines.slice(rows).every((line) => line.trim() === "");
  const column = top.find((at) => throughFooter(rowsAt(at)));
  if (column === undefined) return screen;
  const rows = rowsAt(column);
  return lines.map((line, index) => index < rows ? line.slice(0, indexAtColumn(line, column)).trimEnd() : line).join("\n");
}

function withoutPreview(lines: string[], from: number, to: number): string[] {
  let column = -1;
  for (let index = from; index <= to && column < 0; index += 1) {
    const line = lines[index] ?? "";
    const corner = /\s{2,}[┌╭]/.exec(line);
    if (corner !== null) column = Bun.stringWidth(line.slice(0, corner.index + corner[0].length - 1));
  }
  return lines.map((line) => {
    const at = column >= 2 ? indexAtColumn(line, column) : -1;
    const edge = at >= 0 ? line[at] : undefined;
    const boxed = edge !== undefined && PREVIEW_EDGE.includes(edge) && line.slice(Math.max(0, at - 2), at) === "  ";
    // only the preview's own notes line goes: a question may begin with "Notes:" too
    return (boxed ? line.slice(0, at).trimEnd() : line).replace(/^\s*Notes:\s+press n to add notes\b.*$/i, "");
  });
}

function parseClaudeQuestion(screen: string): ParsedPrompt | null {
  const colored = screen.split(/\r?\n/);
  const raw = screen.replace(ANSI_RE, "").split(/\r?\n/);
  const hintIndex = findLastIndex(raw, (_, index) => CLAUDE_ASK_HINT_RE.test(wrapped(raw, index)));
  if (hintIndex < 0) return null;
  const preview = CLAUDE_PREVIEW_HINT_RE.test(wrapped(raw, hintIndex));
  const lines = preview ? withoutPreview(raw, Math.max(0, hintIndex - 64), hintIndex) : raw;
  // with a preview the options end at the rule above "Chat about this": nothing under it is theirs
  const end = preview ? findLastIndex(lines.slice(0, hintIndex), (line) => isDivider(line)) : hintIndex;
  const rows = menuRows(lines, Math.max(0, hintIndex - 64), end);
  // a multiple choice draws an unnumbered Submit row between the typed answer and "Chat about
  // this", which the cursor moves through like any other row
  const submitLine = rows.length < 2 ? undefined
    : lines.slice(rows.at(-2)!.lineIndex + 1, rows.at(-1)!.lineIndex).map(cleanLine).find((line) => /^(?:[›>❯]\s*)?Submit$/.test(line));
  const onSubmit = submitLine !== undefined && SELECTED_RE.test(submitLine);
  if (!sequentialRows(rows) || rows.filter((row) => row.selected).length !== (onSubmit ? 0 : 1)) return null;
  const chatIndex = rows.findIndex((row) => row.label === "Chat about this");
  let customIndex = rows.findIndex((row) => /^Type something\.?$/i.test(row.label));
  // typed into, the row shows the draft instead of "Type something.", with the cursor on it or
  // not (2.1.295): in Claude's own form, where the question is named by its chip or tabs and a
  // rule parts that row from "Chat about this", it is still the typed answer's
  const drafted = customIndex < 0 && !preview && chatIndex > 1
    && lines.slice(rows[chatIndex - 1]!.lineIndex + 1, rows[chatIndex]!.lineIndex).some((line) => isDivider(line))
    && (claudeTabs(lines, rows[0]!.lineIndex) !== null || claudeChip(lines, rows[0]!.lineIndex) !== null);
  if (drafted) customIndex = chatIndex - 1;
  if (preview) {
    // its notes are no answer of their own: no typed-answer row, the options are the menu
    if (customIndex >= 0 || chatIndex >= 0) return null;
  } else if (chatIndex !== rows.length - 1 || customIndex !== chatIndex - 1 || customIndex < 1) return null;
  const tabs = claudeTabs(lines, rows[0]!.lineIndex);
  const question = claudeQuestionText(lines, tabs?.index ?? -1, rows[0]!.lineIndex) ?? nearestQuestion(lines, rows[0]!.lineIndex);
  const chip = tabs === null ? claudeChip(lines, rows[0]!.lineIndex) : null;
  if (!question) return null;
  const optionRows = preview ? rows : rows.slice(0, customIndex);
  const multiSelect = optionRows.some((row) => /^\s*(?:[›>❯]\s*)?\d+\.\s+\[[ xX✓✔]\]/.test(lines[row.lineIndex]!));
  if (onSubmit && !multiSelect) return null;
  const submit = multiSelect && submitLine !== undefined;
  const rowAt = rows.findIndex((row) => row.selected);
  // the cursor's place among the rows it moves through, Submit counted before the last one
  const selectedIndex = onSubmit ? rows.length - 1 : submit && rowAt === rows.length - 1 ? rowAt + 1 : rowAt;
  // the tab the bar's colors show; without them, the first question still open
  const shown = tabs ? claudeTabSteps(colored[tabs.index] ?? "", tabs) : null;
  const open = tabs?.tabs.findIndex((tab) => !tab.answered) ?? -1;
  // a bar cut off by a narrow pane does not show how many questions there are
  const titleOf = (current: number) => tabs && current >= 0
    ? tabs.whole && tabs.tabs.length > 1 ? own("{label} · {n} of {total}", { label: tabs.tabs[current]!.label, n: current + 1, total: tabs.tabs.length }) : tabs.tabs[current]!.label
    : chip ?? own(multiSelect ? "Multiple choice" : "Question");
  const nav = shown !== null && shown.index < tabs!.tabs.length ? shown : null;
  const title = titleOf(nav?.index ?? open);
  // read off the screen, not part of the question: left out of the card's id
  const words = claudeWordsAbove(raw, rows[0]!.lineIndex);
  const parsed = finishPrompt("claude", {
    kind: "question", title, question, body: null,
    options: optionRows.map((row) => ({ label: row.label, description: row.description ?? null })),
    // a multiple choice takes its typed answer where its Submit row shows: Enter there sends it
    multi_select: multiSelect, custom_option_index: preview || (multiSelect && !submit) ? null : customIndex,
    ...(nav ? { steps: nav.steps, can_step_back: nav.index > 0 } : {}),
  }, {
    responder: "claude-question",
    ...(nav ? { claudeTabs: { identity: nav.identity, index: nav.index } } : {}),
    menuLabels: submit ? [...rows.slice(0, -1).map((row) => row.label), "Submit", rows.at(-1)!.label] : rows.map((row) => row.label),
    selectedIndex,
    checkedOptionIndices: optionRows.flatMap((row, index) => row.checked ? [index] : []),
    customMenuIndex: preview ? null : customIndex, rejectWithEscapeIndex: null,
    // an answer typed into the draft would join it, so once the cursor is in the row it is
    // emptied first, after the cursor and before it (ctrl+k, ctrl+u; measured on 2.1.295)
    ...(drafted ? {
      customSteps: (text: string) => [
        ...keySteps([...navigationKeys(customIndex - selectedIndex), "ctrl+k", "ctrl+u"]),
        { text }, ...keySteps(multiSelect ? [KEY.down, KEY.enter] : [KEY.enter]),
      ],
    } : {}),
    // the id reads the tab shown (its title names it and its place): two tabs asking the same are two
    // cards. On the first question still open it is the title a read without colors gives too
  }, { steps: undefined, can_step_back: undefined });
  return words === null ? parsed : { ...parsed, screen_words: words };
}

/**
 * Claude's tool call line, `● Write(a.ts)` or an MCP call `● plugin/server - tool (MCP)(…)`: an ASCII name
 * right before its `(`; Claude's own text opens with ● too (`● 패치(Patch)는 …` is text)
 */
const CLAUDE_CALL_RE = /^[●⏺]\s+(?:[\w.:/-]+|\S.* \(MCP\))\(/;

/** a collapsed group of tool calls, `Read 2 files (ctrl+o to expand)` (2.1.311), its bullet drawn or not */
const CLAUDE_COLLAPSED_RE = /\(ctrl\+o\s+to\s+expand\)/i;

/** a list item, or a line of a table or a rule, opens a line of its own: never the rest of the line above it */
const OWN_LINE_RE = /^\s*(?:(?:[-*•]|\d+[.)])\s|[│├└┌┬┼─╭╰])/;

/** words and sentence punctuation only: a line with a path, a URL, code or a command's signs keeps its breaks */
const PROSE_RE = /^[\p{L}\p{N}\s.,:;!?'"’‘“”()\-–—…%&。、，！？：；「」『』（）]+$/u;

/** a command's option (`--oneline`, `-rf`): its line is a command, never prose to join */
const OPTION_RE = /(?:^|\s)--?\w/;

/**
 * A line that is a command or a path, read on its own: it opens with a common command (`git push`,
 * `bun test`, a `$ ` prompt), or it is one token with a `/` or a file's extension. Such a line keeps
 * its breaks on both sides, whatever the rest of its paragraph says. A command this list does not
 * name is caught only by its options or its signs (OPTION_RE, PROSE_RE).
 */
const COMMAND_LINE_RE = /^\s*(?:\$\s+\S|(?:git|gh|npm|npx|bun|bunx|yarn|pnpm|node|deno|python3?|pip3?|uv|cargo|rustc|go|make|cd|ls|rm|cp|mv|mkdir|cat|echo|curl|wget|ssh|scp|rsync|sudo|docker|kubectl|helm|terraform|export|source|chmod|chown|tar|grep|rg|sed|awk|find|touch|kill|systemctl|brew|apt|apt-get|dnf|herdr|claude|codex|tmux)(?:\s|$)|\S*(?:\/|\w\.[a-z][a-z0-9]{0,5}\b)\S*[.,;:]?\s*$)/;

/** how a sentence ends, a closing quote or bracket after it allowed */
const SENTENCE_END_RE = /[.!?\u2026\u3002\uff01\uff1f]["'\u201d\u2019)\]\u300d\u300f\uff09]*$/u;

/** a script written without spaces between words: a line of it the pane broke goes on without a space */
const UNSPACED_RE = /[\p{scx=Han}\p{scx=Hiragana}\p{scx=Katakana}]/u;

/**
 * Claude's own words over its question (#2088). Claude Code 2.1.311 writes a turn's text to the
 * session file only with the answer, so while the question waits the screen is the only place they
 * are. They are the text block right over the question panel's top rule, as recorded at 120 and 40
 * columns: a `●` line that is no tool call, the lines under it at its two-column indent, paragraphs
 * parted by blank lines.
 *
 *   ● The file a.txt has a made-up bug: its
 *     last line is missing a trailing
 *     …
 *   ────────────────────────────────────────
 *    ☐ Fix
 *
 * The rule is the panel's own only with nothing but the panel's header and question under it.
 * Anything else right over the panel (the user's prompt, a tool's output or its collapsed group, a
 * status line) is not Claude's words, and no words are read then. Neither are a block whose `●`
 * start is above the screen's top: its lines read the same as the user's own prompt wrapped under
 * its `❯`.
 *
 * Lines the pane wrapped are joined back only where that cannot change what they say: two lines of
 * plain prose, the first one too full for the next one's first word, and not ending in a colon (what
 * follows may be a command), in a paragraph that ends as a sentence does. A paragraph of commands
 * (`git merge experimental-feature-branch` over `git push` reads as prose and can fill the line)
 * ends in none of a sentence's marks: every break in it stays as drawn, as do all other breaks.
 */
function claudeWordsAbove(lines: string[], firstRow: number): string | null {
  let rule = -1;
  for (let index = firstRow - 1; index >= Math.max(0, firstRow - 60) && rule < 0; index -= 1) {
    const line = cleanLine(lines[index]!);
    if (SOLID_RULE_RE.test(line)) rule = index;
    // the user's prompt, Claude's text or a tool between: the rule above them is not this panel's
    else if (/^[❯●⏺⎿✻]/.test(line)) return null;
  }
  if (rule < 0) return null;
  const width = Bun.stringWidth(cleanLine(lines[rule]!));
  // each line as drawn (its width says where the pane wrapped it) and its text, the block's indent off
  const block: { drawn: string; text: string }[] = [];
  let start = -1;
  for (let index = rule - 1; index >= 0 && start < 0; index -= 1) {
    const drawn = lines[index]!.replace(ANSI_RE, "").trimEnd();
    if (CLAUDE_COLLAPSED_RE.test(drawn) || /^\s*⎿/.test(drawn)) return null;
    if (drawn === "") block.unshift({ drawn, text: "" });
    else if (drawn.startsWith("  ")) block.unshift({ drawn, text: drawn.slice(2) });
    else if (/^[●⏺]\s/.test(drawn) && !CLAUDE_CALL_RE.test(drawn)) {
      block.unshift({ drawn, text: drawn.replace(/^[●⏺]\s+/, "") });
      start = index;
    } else return null;
  }
  if (start < 0) return null;
  // a hint a narrow pane wrapped: "(ctrl+o" over "to expand)"
  if (CLAUDE_COLLAPSED_RE.test(block.map(({ text }) => text.trim()).join(" "))) return null;
  // the block's paragraphs, each its lines as drawn
  const groups: { drawn: string; text: string }[][] = [[]];
  for (const line of block) {
    if (line.text !== "") groups.at(-1)!.push(line);
    else if (groups.at(-1)!.length > 0) groups.push([]);
  }
  const paragraphs: string[] = [];
  for (const group of groups.filter((lines) => lines.length > 0)) {
    const sentence = SENTENCE_END_RE.test(group.at(-1)!.text.trimEnd());
    let paragraph = "";
    let previous = { drawn: "", text: "" };
    for (const line of group) {
      const { text } = line;
      if (paragraph === "") paragraph = text;
      else if (!sentence) paragraph += `\n${text}`;
      else {
        const next = text.trimStart();
        const first = /^\S+/.exec(next)![0];
        const before = [...previous.text.trimEnd()].at(-1) ?? "";
        const unspaced = UNSPACED_RE.test(before) || UNSPACED_RE.test([...next][0]!);
        const prose = PROSE_RE.test(previous.text) && PROSE_RE.test(text) && !OPTION_RE.test(previous.text) && !OPTION_RE.test(text)
          && !COMMAND_LINE_RE.test(previous.text) && !COMMAND_LINE_RE.test(text) && !OWN_LINE_RE.test(text) && before !== ":";
        // Claude Code can break a line where the word would have just reached the edge (2.1.311 at 40
        // columns: "  properly. It's a contrived example," over "so"); a script without spaces breaks
        // anywhere, so only a line filled to the edge goes on
        const full = unspaced
          ? Bun.stringWidth(previous.drawn) >= width - 1
          : Bun.stringWidth(previous.drawn) + 1 + Bun.stringWidth(first) >= width;
        paragraph += prose && full ? `${unspaced ? "" : " "}${next}` : `\n${text}`;
      }
      previous = line;
    }
    paragraphs.push(paragraph);
  }
  // capped as a card's body is, never inside a character
  const words = [...paragraphs.join("\n\n")].slice(0, 12_000).join("");
  return words.trim() === "" ? null : words;
}

/** A single question's header chip (`☐ Dataset`), the question's own short name; null when there is none. */
function claudeChip(lines: string[], firstRow: number): string | null {
  for (let index = firstRow - 1; index >= Math.max(0, firstRow - 40); index -= 1) {
    const line = cleanLine(lines[index]!);
    if (isDivider(line) || CLAUDE_TABS_RE.test(line)) return null;
    const chip = /^[☐☒☑✔]\s+(\S.*)$/.exec(line);
    if (chip !== null) return chip[1]!.trim();
  }
  return null;
}

/**
 * Claude's question tabs above several questions, `←  ☒ Route  ☐ Author  ✔ Submit  →`,
 * looked for up the panel however far a long question wraps; a narrow pane can cut
 * the bar off at its right edge. ☐ is unanswered, ☒ answered, ✔ the Submit step.
 */
function claudeTabs(lines: string[], beforeIndex: number): { index: number; whole: boolean; tabs: { label: string; answered: boolean }[] } | null {
  for (let index = beforeIndex - 1; index >= Math.max(0, beforeIndex - 60); index -= 1) {
    const line = cleanLine(lines[index]!);
    if (SOLID_RULE_RE.test(line)) return null;
    if (!CLAUDE_TABS_RE.test(line)) continue;
    const tabs = [...line.replace(/^←/, "").replace(/→$/, "").matchAll(/([☐☒☑✔])\s+(.+?)(?=\s{2,}|\s*$)/g)]
      .filter((match) => match[1] !== "✔")
      .map((match) => ({ label: match[2]!.trim(), answered: match[1] !== "☐" }));
    return { index, whole: /→$/.test(line), tabs };
  }
  return null;
}

/**
 * The card's steps from Claude's whole tab bar, the questions and its Submit: the tab shown is the one
 * drawn on a background, the others in the default color (measured on 2.1.312:
 * `\x1b[38;2;0;0;0m\x1b[48;2;177;185;249m ☒ Device \x1b[0m ☐ Symptoms  ✔ Submit  →`). Claude moves
 * between them with ←/→ and keeps the answers given. Under NO_COLOR, with two tabs lit, or with a bar
 * cut off by a narrow pane, nothing says which tab is shown: null, and the card offers no steps.
 */
function claudeTabSteps(coloredLine: string, bar: { whole: boolean; tabs: { label: string; answered: boolean }[] }): { steps: InteractivePromptStep[]; index: number; identity: string } | null {
  if (!bar.whole || bar.tabs.length < 2) return null;
  const plain = coloredLine.replace(ANSI_RE, "");
  const marks = [...plain.matchAll(/[☐☒☑✔]/g)];
  if (marks.length !== bar.tabs.length + 1 || plain[marks.at(-1)!.index!] !== "✔") return null;
  const index = piActiveTab(coloredLine, marks.map((mark) => mark.index!), true);
  if (index === null) return null;
  const steps = [...bar.tabs, { label: "Submit", answered: false }].map((tab, at) => ({
    label: tab.label, answered: tab.answered, current: at === index, ...(at !== index ? { can_navigate: true } : {}),
  }));
  return { steps, index, identity: JSON.stringify(bar.tabs.map((tab) => [tab.label, tab.answered])) };
}

/** The question over Claude's options, joined back when a narrow pane wraps it over several lines. */
function claudeQuestionText(lines: string[], tabsIndex: number, firstRow: number): string | null {
  const text: string[] = [];
  for (let index = firstRow - 1; index > Math.max(tabsIndex, firstRow - 30); index -= 1) {
    const line = cleanLine(lines[index]!);
    if (!line) { if (text.length > 0) break; continue; }
    // the single question's header chip (`☐ Dataset`) or the panel's top rule ends the question
    if (/^[☐☒☑✔]\s+\S/.test(line) || isDivider(line) || CLAUDE_TABS_RE.test(line)) break;
    text.unshift(line);
  }
  return text.length > 0 ? normalizeText(text.join(" ")) : null;
}

/**
 * Claude's review lists each question (`● …`) over its answer (`→ …`), both indented and wrapped at
 * the pane's edge: an indented line that opens neither goes on the one above. What Claude draws at
 * the panel's edge instead (its "You have not answered all questions" warning over the list, a
 * permission note under it) is no answer's and stays the card's text. A review cut off at the top
 * can open on the rest of a question or answer, its start out of view.
 */
function claudeReviewAnswers(panel: string[], width: number): { answers: InteractivePromptAnswer[]; notes: string[] } | null {
  const items: { question: string[]; answer: string[] | null }[] = [];
  const notes: string[] = [];
  // indented lines over the first marker, which a cut-off review opens on: the rest of a question
  // (an answer follows) or of an answer (a question follows)
  const lead: string[] = [];
  for (const raw of panel) {
    const line = cleanLine(raw);
    if (!line || isDivider(line) || /^Review your answers$/i.test(line)) continue;
    const open = items.at(-1);
    if (/^●\s/.test(line)) {
      if (!open && lead.length > 0) items.push({ question: [], answer: lead.splice(0) });
      items.push({ question: [raw], answer: null });
    } else if (/^→\s/.test(line)) {
      if (open && open.answer === null) open.answer = [raw];
      else items.push({ question: open ? [] : lead.splice(0), answer: [raw] });
    } else if (!/^\s|^│/.test(raw.replace(ANSI_RE, ""))) notes.push(line);
    else if (open) (open.answer ?? open.question).push(raw);
    else lead.push(raw);
  }
  if (items.length === 0) return null;
  // what the top cut off starts with "…": the rest of a question or answer is not all of it
  const cut = (text: string, whole: boolean): string | null => text === "" ? null : whole ? text : `…${text}`;
  return {
    answers: items.map((item) => ({
      question: cut(joinWrapped(item.question, width, /^●\s+/), /^●\s/.test(cleanLine(item.question[0] ?? ""))),
      answer: item.answer ? cut(joinWrapped(item.answer, width, /^→\s+/), /^→\s/.test(cleanLine(item.answer[0] ?? ""))) : null,
    })),
    notes,
  };
}

/**
 * After several questions Claude shows the answers and asks before sending them. The review is one
 * panel from its tabs down to its question, with no rule inside it. A review taller than the pane
 * (long answers, a phone-width pane) is cut off at the top, tabs and heading out of view: then the
 * screen's first line starts it, and only Claude's own answers (`→ …`) and rows make it the review.
 */
function parseClaudeSubmit(screen: string): ParsedPrompt | null {
  const lines = screen.replace(ANSI_RE, "").split(/\r?\n/);
  const questionIndex = findLastIndex(lines, (line) => /^Ready to submit your answers\?$/i.test(cleanLine(line)));
  if (questionIndex < 0) return null;
  const tabsIndex = findLastIndex(lines.slice(0, questionIndex), (line) => CLAUDE_TABS_RE.test(cleanLine(line)));
  const panel = lines.slice(tabsIndex + 1, questionIndex);
  if (panel.some((line) => isDivider(line))) return null;
  const rows = parseNumberedRows(lines, questionIndex + 1, lines.length);
  if (!sequentialRows(rows) || rows.length < 2 || rows.filter((row) => row.selected).length !== 1) return null;
  if (tabsIndex < 0 && (!panel.some((line) => /^→\s/.test(cleanLine(line)))
    || rows.map((row) => row.label).join("\n") !== "Submit answers\nCancel")) return null;
  const review = claudeReviewAnswers(panel, screenWidth(lines));
  const answers = review?.answers;
  const body = review ? review.notes.join("\n") : panel.map(cleanLine)
    .filter((line) => line && !isDivider(line) && !/^Review your answers$/i.test(line)).join("\n");
  // the review is the bar's Submit tab: Back and the steps go to its questions
  const bar = tabsIndex >= 0 ? claudeTabs(lines, tabsIndex + 1) : null;
  const shown = bar ? claudeTabSteps(screen.split(/\r?\n/)[tabsIndex] ?? "", bar) : null;
  const nav = shown !== null && shown.index === bar!.tabs.length ? shown : null;
  return finishPrompt("claude", {
    // a menu, not a question: a typed pick submits every answer at once, so it waits for Confirm
    kind: "menu", title: own("Review your answers"), question: cleanLine(lines[questionIndex]!), body: body || null,
    ...(answers ? { answers } : {}),
    options: rows.map((row) => ({ label: row.label, description: null })), multi_select: false, custom_option_index: null,
    ...(nav ? { steps: nav.steps, can_step_back: true } : {}),
  }, {
    responder: "claude-submit", menuLabels: rows.map((row) => row.label), selectedIndex: rows.findIndex((row) => row.selected),
    checkedOptionIndices: [], customMenuIndex: null, rejectWithEscapeIndex: null,
    ...(nav ? { claudeTabs: { identity: nav.identity, index: nav.index } } : {}),
  }, { steps: undefined, can_step_back: undefined });
}

function parseClaudeApproval(screen: string): ParsedPrompt | null {
  const lines = screen.replace(ANSI_RE, "").split(/\r?\n/);
  const planIndex = findLastIndex(lines, (_, index) => /Claude has written up a plan and is ready to execute\. Would you like to proceed\?/i.test(wrapped(lines, index)));
  if (planIndex >= 0) {
    const rows = parseNumberedRows(lines, planIndex + 1, lines.length);
    if (!sequentialRows(rows) || rows.length < 3 || rows.filter((row) => row.selected).length !== 1) return null;
    const customIndex = rows.findIndex((row) => /^Tell Claude what to change$/i.test(row.label));
    const bodyStart = Math.max(0, findLastIndex(lines.slice(0, planIndex), (line) => /Ready to code\?/i.test(cleanLine(line))));
    return finishPrompt("claude", {
      kind: "plan", title: own("Ready to code?"), question: cleanLine(lines[planIndex]!),
      body: lines.slice(bodyStart, planIndex).map(cleanLine).filter((line) => !isDivider(line)).join("\n") || null,
      options: rows.map((row) => ({ label: row.label, description: null })), multi_select: false,
      custom_option_index: customIndex >= 0 ? customIndex : null,
    }, {
      responder: "claude-plan", menuLabels: rows.map((row) => row.label), selectedIndex: rows.findIndex((row) => row.selected),
      checkedOptionIndices: [], customMenuIndex: customIndex >= 0 ? customIndex : null, rejectWithEscapeIndex: null,
    });
  }

  const requiredIndex = findLastIndex(lines, (line) => /This command requires approval/i.test(cleanLine(line)));
  const dangerousRmIndex = findLastIndex(lines, (line) => /^Dangerous rm operation\b/i.test(cleanLine(line)));
  const approvalIndex = Math.max(requiredIndex, dangerousRmIndex);
  // "Do you want to proceed?", "Do you want to create hello.txt?", "Do you want to make this edit to a.ts?"
  const questionIndex = findLastIndex(lines, (line) => /^Do you want to .+\?$/i.test(cleanLine(line)));
  if (questionIndex < 0) return null;
  // options end at the key hint: a line under the last one is then only its wrapped label
  const hintIndex = findLastIndex(lines, (_, index) => /esc to cancel/i.test(wrapped(lines, index)));
  const rows = parseNumberedRows(lines, questionIndex + 1, hintIndex > questionIndex ? hintIndex : lines.length);
  if (!sequentialRows(rows) || rows.length < 2 || rows.filter((row) => row.selected).length !== 1) return null;
  // a hint of its own under the last row and over the last hint, whole or wrapped by a narrow
  // pane: the panel was answered, and what ends the screen now is another prompt ("Password:"
  // over a bare "Esc to cancel"); an option's own words may name the keys
  if (/esc to\s+cancel/i.test(lines.slice(rows.at(-1)!.lineIndex + 1, hintIndex).map(cleanLine).join(" "))) return null;
  let title: CardWords;
  let body: string;
  if (approvalIndex >= 0 && approvalIndex < questionIndex) {
    title = nearestQuestion(lines, approvalIndex) ?? own("Command approval");
    const bodyEnd = dangerousRmIndex > requiredIndex ? questionIndex : approvalIndex;
    body = lines.slice(Math.max(0, approvalIndex - 8), bodyEnd).map(cleanLine).filter((line) => line && !isDivider(line)).join("\n");
  } else {
    // Claude Code 2.1 has neither marker: the panel under a solid rule opens with the
    // tool ("Bash command", "Create file"), then the command or file and its description
    // the panel's rule is the first one under the tool call (`● Write(a.ts)`): rules further
    // down belong to a file preview; with the call scrolled away, the nearest rule
    // Claude's own text opens with ● too ("● Results table follows:"): a call is a tool name and "("
    // (an MCP call reads "● server - tool (MCP)(…)")
    const callIndex = findLastIndex(lines.slice(0, questionIndex), (line) => /^●\s+[\w.:-]+(?:\s[\w.:-]+)*(?:\s\(MCP\))?\(/.test(cleanLine(line)));
    const rules = lines.slice(0, questionIndex).flatMap((line, index) => index > callIndex && SOLID_RULE_RE.test(cleanLine(line)) ? [index] : []);
    const ruleIndex = callIndex >= 0 ? rules[0] ?? -1 : rules.at(-1) ?? -1;
    // a long command pushes the panel's rule and tool name off the top of the screen: the
    // numbered rows and Claude's own key hint under them, with what is left of the panel above
    // them (its `│` command block and the dashed rule under that), still say it is an approval
    // the dashed rule is the last divider over the question, the block right above it, and
    // only the panel's own few lines (never Claude's or the user's text) between it and the question
    const above = lines.slice(0, questionIndex).map((line) => line.replace(ANSI_RE, "").trim());
    const dashIndex = findLastIndex(above, (line) => isDivider(line));
    const scrolled = ruleIndex < 0 && callIndex < 0 && hintIndex > questionIndex && /^esc to cancel\b/i.test(cleanLine(lines[hintIndex]!))
      && dashIndex >= 1 && questionIndex - dashIndex <= 8 && /^╌{8,}$/.test(above[dashIndex]!) && /^│\s/.test(above[dashIndex - 1]!)
      && above.slice(dashIndex + 1).every((line) => !/^[●⏺❯>›]/.test(line));
    if (!scrolled && (ruleIndex < 0 || questionIndex - ruleIndex > 60)) return null;
    // all of a scrolled panel is the body: a command line changed far above the question is another asking
    // Claude's own tip is a line of the panel; a `│ Tip:` line is the command's
    const panel = lines.slice(scrolled ? 0 : ruleIndex + 1, questionIndex)
      .filter((line) => !/^Tip:/i.test(line.replace(ANSI_RE, "").trim())).map(cleanLine)
      .filter((line) => line && !isDivider(line));
    if (panel.length === 0) return null;
    title = scrolled ? own("Command approval") : panel[0]!;
    body = (scrolled ? panel : panel.slice(1)).join("\n");
  }
  return finishPrompt("claude", {
    kind: "approval", title, question: cleanLine(lines[questionIndex]!),
    body: body || null,
    // an approval's options have no descriptions: lines under one are its label wrapped by a narrow pane
    options: rows.map((row, index) => ({ label: normalizeText([row.label, ...lines.slice(row.lineIndex + 1, rows[index + 1]?.lineIndex ?? (hintIndex > questionIndex ? hintIndex : lines.length))
      .map(cleanLine).filter((line) => line && !isDivider(line))].join(" ")), description: null })),
    multi_select: false, custom_option_index: null,
  }, {
    responder: "claude-approval", menuLabels: rows.map((row) => row.label), selectedIndex: rows.findIndex((row) => row.selected),
    checkedOptionIndices: [], customMenuIndex: null, rejectWithEscapeIndex: null,
  });
}

/**
 * Claude Code 2.1.294 takes zero-width and other invisible characters out of a message, and instead
 * of sending it keeps it in its input until it is reviewed. For a moment it says so over the box:
 *
 *                       Removed 1 invisible character · review and press Enter to send
 *   ────────────────
 *   ❯ helloworld test
 *   ────────────────
 *     [Haiku 4.5] │ project
 *
 * The chat had sent the message and cleared its box, so it seemed gone. The card shows the
 * message as Claude now holds it and sends it (Enter) or drops it (Ctrl+C clears the input).
 * The hint does not stay (a turn's status line takes its row), so the box counts on its own too:
 * when it still holds what the chat last sent here less only invisible characters (`sent`).
 * `working`: Claude is under a turn. Ctrl+C then interrupts the turn and leaves the box as it was
 * (live, 2.1.294: "Interrupted · What should Claude do instead?"), so the card offers Send alone
 * until the turn ends; Enter under a turn queues the message as it does from the terminal.
 */
function parseClaudeHeld(screen: string, sent: string | null, working: boolean): ParsedPrompt | null {
  const lines = screen.replace(ANSI_RE, "").split(/\r?\n/);
  // the input box: the last rule with only Claude's footer under it, the rule above it, and a ❯ line first
  const bottom = findLastIndex(lines, (line) => isDivider(line));
  if (bottom < 0) return null;
  const footer = lines.slice(bottom + 1).map(cleanLine).filter(Boolean);
  if (footer.length > 8 || footer.some((line) => line.startsWith("❯"))) return null;
  let top = bottom - 1;
  while (top >= 0 && !isDivider(lines[top]!)) top -= 1;
  if (top < 0 || bottom - top > 40) return null;
  const box = lines.slice(top + 1, bottom).map((line) => line.replace(/\s+$/, ""));
  if (!/^\s*❯/.test(box[0] ?? "")) return null;
  // the box's own lines: the first after its ❯, the rest at the box's indent
  const message = box.map((line, index) => index === 0 ? line.replace(/^\s*❯\s?/, "") : line.replace(/^ {0,2}/, "")).join("\n").trim();
  if (!message) return null;
  let above = top - 1;
  while (above >= 0 && !cleanLine(lines[above]!)) above -= 1;
  const hint = above >= 0 ? CLAUDE_HELD_HINT_RE.exec(cleanLine(lines[above]!)) : null;
  const removed = hint ? Number(hint[1]) : sent !== null ? removedInvisible(sent, message) : 0;
  if (removed <= 0) return null;
  const title = removed === 1 ? own("Claude Code removed 1 invisible character") : own("Claude Code removed {count} invisible characters", { count: removed });
  // the choices are part of the card's id: a Discard tapped on a card read before the turn began is refused
  const choices = [{ label: own("Send"), steps: keySteps([KEY.enter]) }, ...(working ? [] : [{ label: own("Discard"), steps: keySteps(["ctrl+c"]) }])];
  return finishPrompt("claude", {
    kind: "approval", title, question: own("The message waits in its input. Send it as it is now?"),
    body: message,
    options: choices.map(({ label }) => ({ label, description: null })),
    multi_select: false, custom_option_index: null,
  }, {
    responder: "claude-held", menuLabels: choices.map(({ label }) => englishOf(label)), selectedIndex: -1,
    checkedOptionIndices: [], customMenuIndex: null, rejectWithEscapeIndex: null,
    optionSteps: choices.map(({ steps }) => steps),
  });
}

/**
 * Claude Code's bare `/goal`, as 2.1.304 draws it under the session's labelled rule, with a goal
 * and without one (the condition wraps at the pane's edge, under its `Goal:` at that column):
 *
 *   ▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔ ◐ medium · /effort ▔
 *      ◎ Goal active
 *      running 25s · 0 tokens
 *
 *      Goal: the file hello.txt exists in
 *            the project directory
 *
 *      /goal clear to stop early · Esc to dismiss
 *
 * The dialog's one key is Esc (dismiss); clearing is a command typed after it, which the card
 * never sends. Another header or row (a paused or achieved goal) is not read: the terminal shows it.
 */
/** the status row as recorded: `running 25s · 0 tokens` (a longer run adds units, a count may carry a separator or k/M) */
const CLAUDE_GOAL_STATUS_RE = /^running \d+[dhms](?: \d+[dhms])* · \d[\d,.]*[kKmM]? tokens$/;

function parseClaudeGoal(screen: string): ParsedPrompt | null {
  const lines = screen.replace(ANSI_RE, "").split(/\r?\n/);
  // the panel is what follows the session's rule and runs to the end of the screen
  const rule = findLastIndex(lines, (line) => cleanLine(line).startsWith("▔"));
  if (rule < 0) return null;
  const blocks: string[][] = [[]];
  for (const line of lines.slice(rule + 1).map(cleanLine)) {
    if (line === "") { if (blocks.at(-1)!.length > 0) blocks.push([]); } else blocks.at(-1)!.push(line);
  }
  if (blocks.at(-1)!.length === 0) blocks.pop();
  if (blocks.length !== 3) return null;
  const [head, middle, hint] = blocks as [string[], string[], string[]];
  const hinted = normalizeText(hint.join(" "));
  if (head.length === 1 && head[0] === "Goal") {
    if (normalizeText(middle.join(" ")) !== "No goal set /goal <condition> to set one" || hinted !== "Esc to dismiss") return null;
    return goalCard(own("Goal"), own("No goal set"), null);
  }
  if (head.length === 2 && head[0] === "◎ Goal active" && CLAUDE_GOAL_STATUS_RE.test(head[1]!) && /^Goal:\s*\S/.test(middle[0]!)
    && hinted === "/goal clear to stop early · Esc to dismiss") {
    return goalCard(own("Goal active"), joinWrapped(middle, screenWidth(lines), /^Goal:\s*/), head[1]!);
  }
  return null;
}

/** The card for the goal dialog: its one key is Esc, shown as Close; the elapsed time ticks, so it stays out of the card's id. */
function goalCard(title: CardWords, question: CardWords, status: string | null): ParsedPrompt {
  return finishPrompt("claude", {
    kind: "menu", title, question, body: status,
    options: [{ label: own("Close"), description: null }], multi_select: false, custom_option_index: null,
  }, {
    responder: "claude-goal", menuLabels: ["Close"], selectedIndex: -1,
    checkedOptionIndices: [], customMenuIndex: null, rejectWithEscapeIndex: null,
    optionSteps: [keySteps([KEY.escape])],
  }, { body: null });
}

/** The rewind panel the screen ends in: its blocks of lines from its `Rewind` title down, and all that is drawn under its rule; null when there is none. */
function claudeRewindPanelAt(screen: string): { blocks: string[][]; below: string } | null {
  const lines = screen.replace(ANSI_RE, "").split(/\r?\n/).map((line) => line.trimEnd());
  // the session's rule, or the end of it where a tip takes its start (" tmux detected · scroll… ▔", recorded at 40 columns)
  const rule = findLastIndex(lines, (line) => cleanLine(line).startsWith("▔") || cleanLine(line).endsWith("▔"));
  if (rule < 0) return null;
  const below = lines.slice(rule + 1);
  const blocks: string[][] = [[]];
  for (const line of below) {
    if (line.trim() === "") { if (blocks.at(-1)!.length > 0) blocks.push([]); } else blocks.at(-1)!.push(line);
  }
  if (blocks.at(-1)!.length === 0) blocks.pop();
  return blocks.length >= 3 && blocks[0]!.length === 1 && cleanLine(blocks[0]![0]!) === "Rewind" ? { blocks: blocks.slice(1), below: below.join("\n") } : null;
}

/** What is drawn under the rule of the rewind panel the screen ends in (the panel, and anything under it); null when it ends in none. */
export function claudeRewindPanelBelow(screen: string): string | null {
  return claudeRewindPanelAt(screen)?.below ?? null;
}

/** A send refused while Claude Code's rewind dialog is on screen (any of its states). */
export const CLAUDE_REWIND_OPEN_MESSAGE = "Claude Code's rewind dialog is open; finish or close it in the terminal (Esc), then send";

/** Characters no one sees: format controls (zero-width spaces and joiners, bidi marks, tags), combining marks, Hangul fillers. */
export const INVISIBLE_CHAR_RE = /[\p{Cf}\p{Mn}\p{Me}\u115F\u1160\u3164\uFFA0]/u;

/**
 * How many characters of `sent` the box `shown` lacks, when it lacks only invisible ones (0 when
 * anything else differs). Whitespace is left out of both: the box wraps a long message.
 */
export function removedInvisible(sent: string, shown: string): number {
  // whitespace, but not U+FEFF, which \s takes for a space and Claude Code counts as invisible
  const a = [...sent.replace(/[^\S\uFEFF]+/g, "")];
  const b = [...shown.replace(/[^\S\uFEFF]+/g, "")];
  let i = 0;
  let removed = 0;
  for (const char of a) {
    if (i < b.length && b[i] === char) { i += 1; continue; }
    if (!INVISIBLE_CHAR_RE.test(char)) return 0;
    removed += 1;
  }
  return i === b.length ? removed : 0;
}

/**
 * Claude Code's unnumbered menus, live in 2.1.285 on a folder it has not seen:
 *
 *   Accessing workspace:
 *   /home/user/project
 *   Quick safety check: Is this a project you created or one you trust? (Like your own code,
 *   …
 *   ❯ No, exit
 *     Yes, I trust this folder
 *   Enter to confirm · Esc to cancel
 *
 * herdr reports the pane blocked. The rows are the lines right above the hint, up to a blank
 * line or a rule, exactly one of them `❯`; numbered rows are left to the menus above.
 */
function parseClaudeConfirm(screen: string): ParsedPrompt | null {
  const lines = screen.replace(ANSI_RE, "").split(/\r?\n/);
  const hintIndex = findLastIndex(lines, (_, index) => CLAUDE_CONFIRM_HINT_RE.test(wrapped(lines, index)));
  if (hintIndex < 0) return null;
  let end = hintIndex - 1;
  while (end >= 0 && !cleanLine(lines[end]!)) end -= 1;
  let start = end;
  while (start > 0 && cleanLine(lines[start - 1]!) && !isDivider(lines[start - 1]!)) start -= 1;
  if (end < 0 || start < 0) return null;
  // A narrow pane wraps a long label onto the next line, at the label's own indent, so the
  // indent cannot tell a wrapped label from the next row. Words wrap only when the next one no
  // longer fits: a line under a row (without its own ❯) continues that row when its first word
  // would not have fitted after it. The widest line off the rows stands for the pane's width; a
  // row wider than all of them says nothing of it, and the line under it could be either, so a
  // screen like that gets no card rather than one that answers a row it does not show.
  const width = Math.max(0, ...lines.filter((_, index) => index < start || index > end).map((line) => line.trimEnd().length));
  let unsure = false;
  const wrappedFrom = (above: string, line: string): boolean => {
    if (above.trimEnd().length + 1 + (line.split(/\s+/)[0]?.length ?? 0) <= width) return false;
    if (above.trimEnd().length > width) unsure = true;
    return true;
  };
  const rows: { label: string; selected: boolean; lineIndex: number }[] = [];
  for (let index = start; index <= end; index += 1) {
    const line = cleanLine(lines[index]!);
    const selected = SELECTED_RE.test(line);
    const previous = rows.at(-1);
    if (previous && !selected && wrappedFrom(lines[index - 1]!, line)) {
      previous.label = normalizeText(`${previous.label} ${line}`);
      continue;
    }
    rows.push({ label: line.replace(SELECTED_RE, "").trim(), selected, lineIndex: index });
  }
  if (unsure) return null;
  if (rows.length < 2 || rows.length > 9 || rows.filter((row) => row.selected).length !== 1) return null;
  if (rows.some((row) => !row.label || NUMBERED_OPTION_RE.test(row.label))) return null;
  // the panel above the rows: its first line names it, a sentence ending in "?" asks
  let top = start - 1;
  while (top >= 0 && !isDivider(lines[top]!) && start - top <= 30) top -= 1;
  const panel = lines.slice(top + 1, start).map(cleanLine).filter(Boolean);
  const title = panel[0]?.replace(/:$/, "") ?? own("Choose an option");
  const prose = normalizeText(panel.slice(1).join(" "));
  const asked = /(?:^|[.:!]\s+)([^.:!?]*\?)/.exec(prose)?.[1]?.trim();
  return finishPrompt("claude", {
    kind: "menu", title, question: asked ?? title,
    body: panel.slice(1).join("\n") || null,
    options: rows.map((row) => ({ label: row.label, description: null })), multi_select: false, custom_option_index: null,
  }, {
    responder: "claude-confirm", menuLabels: rows.map((row) => row.label), selectedIndex: rows.findIndex((row) => row.selected),
    checkedOptionIndices: [], customMenuIndex: null, rejectWithEscapeIndex: null,
  });
}

/**
 * Claude Code's `/model` list, live in 2.1.290:
 *
 *   Select model
 *   Switch between Claude models. Your pick becomes the default for new sessions. …
 *
 *     1.  Default (recommended)  Fable 5.1
 *   ❯ 2.  Opus 5.5 ✔             For complex work and everyday tasks
 *     …
 *   ↓ 10. Opus 4.7               Best for everyday, complex tasks
 *      … +2 models
 *
 *   ◐ Medium effort (default) ←/→ to adjust
 *
 *   Enter to set as default · s to use this session only · Esc to cancel
 *
 * herdr never reports the pane blocked while it waits (idle, on herdr 0.9.3), so the card can
 * only come from the screen. The list is read off its hint, the one line that is always there:
 * a pane shorter than the list scrolls the title off its top, and Claude then draws fewer rows
 * (five of twelve at 24 lines) so that the one under the cursor stays on screen.
 *
 * What the list holds is Claude's to decide and differs from one session to the next (twelve
 * models by name, or five by family with the name in the description), so a row is read by its
 * shape alone: its number, what it names, `✔` on the model in use, and after two spaces or more
 * what it says of it, which a narrow pane wraps under itself at the same column. The rows drawn
 * are a window on the list: `↑` and `↓` stand in the cursor's column on the first and last of
 * them when more lie beyond, and `… +2 models` counts the ones below. Only the rows drawn become
 * options, the rest are counted for the card to say so.
 *
 * The line under the rows is the effort the pick would run at. It follows the cursor (a model's
 * own default, or the session's when one was set), so it is no part of what the card asks.
 */
const CLAUDE_MODEL_ROW_RE = /^\s*([❯›>↑↓])?\s*(\d+)\.\s+(\S.*)$/;

const CLAUDE_MODEL_MORE_RE = /^…\s*\+(\d+) models?$/;

/** lines between the rows and the hint, at most: the effort line, wrapped by a narrow pane */
const CLAUDE_MODEL_UNDER_LINES = 3;

/**
 * Whether Claude Code's model list holds the end of the screen, by its hint alone: also a list
 * parseClaudeModel could not read (a name the pane cut in two). Such a list gets no fallback card
 * while herdr happens to report the pane blocked: that card offers Enter, and Enter on this list
 * saves the row under the cursor as the default for every new session. `hint`: the effort slider's
 * instead, whose Enter saves a default the same way.
 */
export function claudeModelListWaits(screen: string, hint: RegExp = CLAUDE_MODEL_GUARD_RE): boolean {
  const visible = screen.replace(ANSI_RE, "").split(/\r?\n/).map(cleanLine).filter((line) => line && !isDivider(line));
  // The hint is read with its spaces taken out over as many lines as a narrow pane wraps it to,
  // also inside a word. The shortest run of lines holding it must begin with it, so the same
  // words quoted in Claude's output (`\u23fa Example: Enter to set\u2026`) are no list, and run into
  // the line it ends at, as in promptTailIsActive: a hint that ended above later output is an
  // answered list's, and holds nothing
  const ends = (lines: string[], end: number): boolean => {
    for (let from = end - 1; from >= Math.max(0, end - CLAUDE_HINT_LINES); from -= 1) {
      if (hint.test(compactLines(lines.slice(from, end)))) return hintAt(lines, from, hint, end) && !hint.test(compactLines(lines.slice(from, end - 1)));
    }
    return false;
  };
  // Claude's own footer under the open list (the session's rule, its task list) is no later
  // output, and it sits under a wrapped hint as under a whole one
  const shown = withoutClaudeTasks(visible, ends);
  return ends(shown, shown.length);
}

function parseClaudeModel(screen: string): ParsedPrompt | null {
  const lines = screen.replace(ANSI_RE, "").split(/\r?\n/).map((line) => line.trimEnd());
  // read as the guard reads it, so the card and the guard agree (#542)
  const hintIndex = findLastIndex(lines, (_, index) => hintAt(lines, index, CLAUDE_MODEL_GUARD_RE));
  if (hintIndex < 0) return null;
  const { rows, below, last, unread } = listRows(lines, hintIndex, CLAUDE_MODEL_ROW_RE, CLAUDE_MODEL_MORE_RE);
  const under = lines.slice(last + 1, hintIndex).filter((line) => line.trim() !== "").length;
  const selectedIndex = rows.findIndex((row) => row.cursor);
  if (unread || under > CLAUDE_MODEL_UNDER_LINES || rows.length < 2 || rows.filter((row) => row.cursor).length !== 1) return null;
  const names = listNames(rows);
  if (names === null) return null;
  const options = names.map(({ name, said }) => ({ label: name.replace(/\s*[✔✓]$/, ""), description: said }));
  // counted, not named: the rows above the window (the list counts from 1) and the ones below it
  const hidden = rows[0]!.number - 1 + below;
  const current = names.findIndex(({ name }) => /\s[✔✓]$/.test(name));
  // "Default (recommended)" in use reads as Default: the tag is the list's advice, not the model's name
  const asked = current >= 0
    ? own("Select model for this session (currently {model})", { model: options[current]!.label.replace(/\s*\(recommended\)$/i, "") })
    : own("Select model for this session");
  return finishPrompt("claude", {
    kind: "question",
    title: "",
    question: hidden <= 0 ? asked : hidden === 1 ? own("{question}. 1 more model is listed in the terminal.", { question: asked })
      : own("{question}. {count} more models are listed in the terminal.", { question: asked, count: hidden }),
    body: null,
    options,
    multi_select: false,
    custom_option_index: null,
  }, {
    // a row by its number in the whole list and by what it says too: the window moves, two rows
    // may share a name, and a list by family names the model itself only in what the row says
    responder: "claude-model", menuLabels: rows.map((row, index) => `${row.number}. ${options[index]!.label}  ${options[index]!.description ?? ""}`), selectedIndex,
    checkedOptionIndices: [], customMenuIndex: null, rejectWithEscapeIndex: null,
    // `s`, never Enter: the pick stays in this session, and the default for new ones is left alone
    optionSteps: rows.map((_, index) => [...keySteps(navigationKeys(index - selectedIndex)), { text: "s" }]),
  });
}

/**
 * Claude Code's `/effort` slider, as 2.1.311 draws it in a pane of 70 columns or more, Ultracode's
 * switch beside the slider:
 *
 *   Effort
 *
 *                Faster                             Smarter
 *                ──────────────────────────────▲───────────      Ultracode  on
 *                low     medium     high     xhigh      max      Tab to toggle
 *                Ultracode: dynamic workflows on every task
 *
 *   ←/→ to adjust · Enter to confirm · s for this session only · Esc to cancel
 *
 * and in a narrower one, the switch on two lines of its own under the slider:
 *
 *         ──────────────────────────────▲───────────
 *         low     medium     high     xhigh      max
 *
 *
 *                       Ultracode  off
 *                       Tab to toggle
 *
 *   ←/→ to adjust · Enter to confirm · s for this session
 *   only · Esc to cancel
 *
 * ▲ stands over the level the slider is on. The levels are the card's options, picked with ←/→
 * and `s`, never Enter: Enter saves the level as the default for new sessions.
 *
 * The line under the names is blank while the switch is off, and Claude's "Ultracode: dynamic
 * workflows on every task" while it is on. The switch's key (Tab, unless the user bound another)
 * flips it in the dialog only: `s` applies it, with the level ▲ is over, for this session, and Esc
 * drops it. Nothing of it is saved for later sessions. So the card's own row for it is Tab, then
 * `s` once the slider shows the switch flipped, and only where the slider names Tab as its key. A
 * user who unbound the key gets the state alone, no key's line with it: the levels stay, with no
 * row for the switch. Without Ultracode (a model that has no xhigh, dynamic workflows turned off)
 * Claude draws no switch and no line for it, not even the blank one: at max the level's
 * description is the line right under the names. So the names are found under the track.
 *
 * 2.1.301 describes the level ▲ is over between the names and the hint, after a blank line:
 * "~1.5x the estimated cost of medium (the default)", or two lines at max. 2.1.311 draws max's
 * under the Ultracode line, and in a narrow pane above the switch.
 */
const CLAUDE_EFFORT_LEVEL_RE = /\b(?:low|medium|high|xhigh|max)\b/g;

/** how far ▲ may stand from the middle of a level's name and still be over it */
const CLAUDE_EFFORT_ALIGN = 3;

/**
 * lines between the level names and the hint, at most: the Ultracode line, the level's description
 * that a narrow pane wrapped, and the switch's two lines drawn under them there
 */
const CLAUDE_EFFORT_UNDER_LINES = 12;

/** the switch's state: at the end of the track, or on a line of its own in a narrow pane */
const CLAUDE_ULTRACODE_STATE_RE = /(?:^|\s{2,})Ultracode {2}(on|off)$/;

/** the switch's key: at the end of the names, or on the line under the state in a narrow pane */
const CLAUDE_ULTRACODE_KEY_RE = /(?:^|\s{2,})(\S+(?: \S+)*) to toggle$/;

/** Claude's own line under the names while the switch is on, cut short by a narrow pane maybe */
const CLAUDE_ULTRACODE_LINE_RE = /^Ultracode:(?:\s|…|$)/;

/** a line of level names and nothing else (the switch's key aside): a key's line alone names none */
function claudeEffortLevelsOnly(line: string): boolean {
  const names = line.replace(CLAUDE_ULTRACODE_KEY_RE, "");
  return names.search(CLAUDE_EFFORT_LEVEL_RE) >= 0 && names.replace(CLAUDE_EFFORT_LEVEL_RE, "").trim() === "";
}

/**
 * Ultracode's switch as the slider draws it, beside the slider (70 columns or more) or under it on
 * its own lines: its state and its key (null: the user unbound it, and Claude draws the state
 * alone), or null when it draws none. Undefined: a drawing this reader does not know (a key without
 * its state, or a switch drawn twice or in both places), which gets no card.
 */
function claudeUltracodeSwitch(lines: string[], labelsIndex: number, hintIndex: number): { on: boolean; key: string | null } | null | undefined {
  const besideState = CLAUDE_ULTRACODE_STATE_RE.exec(lines[labelsIndex - 1]!);
  const besideKey = CLAUDE_ULTRACODE_KEY_RE.exec(lines[labelsIndex]!);
  const under: { on: boolean; key: string | null }[] = [];
  // under the slider a state has its key on the line under it, or none where the key is unbound:
  // a key under anything but a state (the names, a second key under the first) is half a switch
  for (let index = labelsIndex; index < hintIndex; index += 1) {
    const state = CLAUDE_ULTRACODE_STATE_RE.exec(lines[index]!.trim());
    const key = CLAUDE_ULTRACODE_KEY_RE.exec(lines[index + 1]!.trim());
    if (state) under.push({ on: state[1] === "on", key: key?.[1] ?? null });
    else if (key) return undefined;
  }
  if ((besideKey && !besideState) || under.length > 1 || (besideState && under.length > 0)) return undefined;
  if (besideState) return { on: besideState[1] === "on", key: besideKey?.[1] ?? null };
  return under[0] ?? null;
}

function parseClaudeEffort(screen: string): ParsedPrompt | null {
  const lines = screen.replace(ANSI_RE, "").split(/\r?\n/).map((line) => line.trimEnd());
  const hintIndex = findLastIndex(lines, (_, index) => CLAUDE_EFFORT_HINT_RE.test(wrapped(lines, index)));
  if (hintIndex < 0) return null;
  // the names: the nearest line of them above the hint right under the ▲ track, which passes over
  // what lies between them (Claude's Ultracode line, a level's description, the switch a narrow
  // pane draws under the slider). Names cut or wrapped by a narrow pane are not read: a line of
  // names under them is the rest of them
  let labelsIndex = -1;
  for (let index = hintIndex - 1; index > 0 && hintIndex - index <= CLAUDE_EFFORT_UNDER_LINES + 1; index -= 1) {
    if (claudeEffortLevelsOnly(lines[index]!) && /^\s*─*▲/.test(lines[index - 1]!) && !claudeEffortLevelsOnly(lines[index + 1]!)) { labelsIndex = index; break; }
  }
  if (labelsIndex < 0) return null;
  const labels = lines[labelsIndex]!;
  const track = lines[labelsIndex - 1]!;
  const scale = /^\s*[─▲]+/.exec(track)?.[0] ?? "";
  const titled = lines.slice(Math.max(0, labelsIndex - 4), Math.max(0, labelsIndex - 1)).some((line) => line.trim() === "Effort");
  if (!titled || scale.split("▲").length !== 2) return null;
  // the switch and the line under the names agree: Claude's Ultracode line while the switch is on,
  // a blank line while it is off, and no Ultracode line where it draws no switch
  const ultracode = claudeUltracodeSwitch(lines, labelsIndex, hintIndex);
  const under = lines[labelsIndex + 1]!.trim();
  const said = CLAUDE_ULTRACODE_LINE_RE.test(under);
  if (ultracode === undefined || (ultracode === null ? said : ultracode.on ? !said : under !== "")) return null;
  const arrow = track.indexOf("▲");
  const levels = [...labels.replace(CLAUDE_ULTRACODE_KEY_RE, "").matchAll(CLAUDE_EFFORT_LEVEL_RE)].map((match) => ({ name: match[0], middle: match.index + match[0].length / 2 }));
  if (levels.length < 2 || new Set(levels.map(({ name }) => name)).size !== levels.length) return null;
  const distance = (index: number) => Math.abs(levels[index]!.middle - arrow);
  const selectedIndex = levels.reduce((best, _, index) => distance(index) < distance(best) ? index : best, 0);
  if (distance(selectedIndex) > CLAUDE_EFFORT_ALIGN) return null;
  const names = levels.map(({ name }) => name);
  // the switch from the card only with the key the card sends: a key the user bound instead is
  // theirs to press, and an unbound one leaves the switch to `/effort ultracode on|off`
  const toggle = ultracode !== null && /^tab$/i.test(ultracode.key ?? "");
  return finishPrompt("claude", {
    // where the slider stands is no part of what the card asks: one card wherever ▲ is. The
    // switch's row names the state it turns to, so the card differs with the switch
    kind: "question",
    title: "",
    question: own("Set effort for this session"),
    body: null,
    options: [
      ...names.map((label) => ({ label, description: null })),
      ...(toggle ? [{ label: own(ultracode.on ? "Turn Ultracode off" : "Turn Ultracode on"), description: own("Keeps the effort level, for this session only") }] : []),
    ],
    multi_select: false,
    custom_option_index: null,
  }, {
    responder: "claude-effort", menuLabels: names, selectedIndex,
    checkedOptionIndices: [], customMenuIndex: null, rejectWithEscapeIndex: null,
    // `s`, never Enter: the level stays in this session, and the default for new ones is left
    // alone. The switch flips with Tab, and `s` applies it with the level ▲ is over
    optionSteps: [
      ...names.map((_, index) => [...keySteps(sliderKeys(index - selectedIndex)), { text: "s" }]),
      ...(toggle ? [[{ keys: [KEY.tab] }, { text: "s" }]] : []),
    ],
    // the state the switch shows, which the card does not send: an answer's last look checks it before `s`
    claudeUltracode: ultracode?.on ?? null,
  });
}

/**
 * Claude Code keeps its task list under an open panel (2.1.289): a rule with the session's name
 * on it, `3 tasks (0 done, 1 in progress, 2 open)`, a row per task (◻ ◼ ✔), an in-progress task's
 * activity (`…`) and `… +2 pending`. Cut off, the panel is the last thing on screen again.
 *
 * Only Claude's own footer goes, and only where it sits directly under the panel's hint: the
 * list holds task rows, the activity under a task in progress and the pending count, nothing
 * else. The agent's answer to the question, a shell's prompt or a rule of another program under
 * the hint keep the panel what it is then: answered, with its keys owed to no one.
 */
const CLAUDE_TASKS_HEAD_RE = /^(\d+) tasks \(\d+ done, (?:\d+ in progress, )?\d+ open\)$/;

const CLAUDE_TASK_ROW_RE = /^[◻◼✔]\s/;

const CLAUDE_TASKS_MORE_RE = /^…\s\+\d+ pending$/;

const LABELED_RULE_RE = /^─{3,}\s.*─$/;

const CLAUDE_HINT_TAIL_RE = /\besc to (?:cancel|exit|go back)\b/i;

/** `hintEnds`: whether the panel's hint ends at line `end`; a hint a narrow pane wrapped needs its own reading */
export function withoutClaudeTasks(shown: string[], hintEnds: (lines: string[], end: number) => boolean = (lines, end) => CLAUDE_HINT_TAIL_RE.test(lines[end - 1] ?? "")): string[] {
  let end = shown.length;
  const head = findLastIndex(shown, (line) => CLAUDE_TASKS_HEAD_RE.test(line));
  if (head >= 0) {
    const total = Number(CLAUDE_TASKS_HEAD_RE.exec(shown[head]!)![1]);
    let rows = 0;
    let inProgress = false;
    let list = true;
    for (let index = head + 1; index < shown.length && list; index += 1) {
      const line = shown[index]!;
      if (CLAUDE_TASK_ROW_RE.test(line)) { rows += 1; inProgress = line.startsWith("◼"); }
      else if (CLAUDE_TASKS_MORE_RE.test(line)) list = index === shown.length - 1;
      // the activity under the task in progress: one line, ending in an ellipsis, no prompt or bullet of its own
      else if (inProgress && line.endsWith("…") && !/^[❯>›●⏺]/.test(line)) inProgress = false;
      else list = false;
    }
    if (list && rows > 0 && rows <= total) end = head;
  }
  // the session's rule is drawn above the list, and with no task list too
  if (LABELED_RULE_RE.test(shown[end - 1] ?? "")) end -= 1;
  return end < shown.length && hintEnds(shown, end) ? shown.slice(0, end) : shown;
}

const approvalRead = onePerPass((screen) => parseClaudeApproval(screen));

export const readers: readonly DialogReader[] = [
  {
    id: "claude-goal", agents: ["claude"], priority: 5,
    // looked at again before Esc: the dialog may show another goal by then
    reread: "before-commit", list: "none",
    parse: (screen) => {
      const parsed = parseClaudeGoal(screen);
      return parsed?.responder === "claude-goal" ? parsed : null;
    },
  },
  {
    id: "claude-question", agents: ["claude"], priority: 10,
    reread: "none", list: "none",
    parse: (screen) => {
      const parsed = parseClaudeQuestion(screen);
      return parsed?.responder === "claude-question" ? parsed : null;
    },
  },
  {
    id: "claude-submit", agents: ["claude"], priority: 20,
    reread: "none", list: "none",
    parse: (screen) => {
      const parsed = parseClaudeSubmit(screen);
      return parsed?.responder === "claude-submit" ? parsed : null;
    },
  },
  {
    id: "claude-approval", agents: ["claude"], priority: 30,
    reread: "none", list: "none",
    parse: (screen, ctx) => {
      const parsed = approvalRead(screen, ctx);
      return parsed?.responder === "claude-approval" ? parsed : null;
    },
  },
  {
    id: "claude-plan", agents: ["claude"], priority: 30,
    reread: "none", list: "none",
    parse: (screen, ctx) => {
      const parsed = approvalRead(screen, ctx);
      return parsed?.responder === "claude-plan" ? parsed : null;
    },
  },
  {
    id: "claude-confirm", agents: ["claude"], priority: 40,
    reread: "before-commit", list: "none",
    parse: (screen) => {
      const parsed = parseClaudeConfirm(screen);
      return parsed?.responder === "claude-confirm" ? parsed : null;
    },
  },
  {
    id: "claude-model", agents: ["claude"], priority: 50,
    reread: "before-commit", list: "letter-window",
    interaction: (parsed) => pickerPlan(parsed, parseClaudeModel, parsed.optionSteps ?? [], (shown, cursor) => shown.menuLabels[cursor]),
    parse: (screen) => {
      const parsed = parseClaudeModel(screen);
      return parsed?.responder === "claude-model" ? parsed : null;
    },
  },
  {
    id: "claude-effort", agents: ["claude"], priority: 60,
    reread: "before-commit", list: "slider",
    // the level under ▲, and Ultracode's switch as the Tabs sent so far leave it: a level's `s`
    // waits for the switch unchanged, the switch's own `s` for it flipped
    interaction: (parsed) => pickerPlan(parsed, parseClaudeEffort, parsed.optionSteps ?? [], (shown, cursor, toggles) => {
      const drawn = shown.claudeUltracode ?? null;
      return `${shown.menuLabels[cursor]} ${drawn === null ? "no switch" : drawn !== (toggles % 2 === 1) ? "on" : "off"}`;
    }),
    parse: (screen) => {
      const parsed = parseClaudeEffort(screen);
      return parsed?.responder === "claude-effort" ? parsed : null;
    },
  },
  {
    id: "claude-held", agents: ["claude"], priority: 70,
    reread: "none", list: "none",
    parse: (screen, ctx) => {
      const parsed = parseClaudeHeld(screen, ctx.sent, ctx.working);
      return parsed?.responder === "claude-held" ? parsed : null;
    },
  },
];
