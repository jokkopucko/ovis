import { paneRead } from "../herdr/client.ts";
import { ANSI_RE, type OmoAsk, PI_MODEL_HINT_RE, PROMPT_LINE_RE, type ParsedPrompt, SOLID_RULE_RE, cleanLine, findLastIndex, isDivider, wrapped } from "./shared.ts";
import { registry } from "./registry.ts";
import { CODEX_ASK_HINT_RE, CODEX_ASYNC_ASK_HINT_RE, CODEX_CONTINUE_HINT_RE } from "./codex.ts";
import { OMO_FOOTER_LINES, OMO_HINT_LINES, OMO_NOT_FOOTER_RE, OMO_OPTIONS_HINT_RE, OMO_PENDING_HINT_RE, OMO_REVIEW_HINT_RE, OMO_TYPING_HINT_RE, omoModelListWaits } from "./omo.ts";
import { CLAUDE_ASK_HINT_RE, CLAUDE_CONFIRM_HINT_RE, CLAUDE_EFFORT_HINT_RE, claudeModelListWaits, withoutClaudeSidePanel, withoutClaudeTasks } from "./claude.ts";
import { OMP_CLIPPED_SINGLE_HINT_RE, OMP_MULTI_CLIPPED_HINT_RE, OMP_MULTI_HINT_RE, OMP_REVIEW_HINT_RE, OMP_SINGLE_CLIPPED_HINT_RE, OMP_SINGLE_HINT_RE, ompApprovalPanelShown } from "./omp.ts";
import { HERMES_HINT_RE } from "./hermes.ts";
import { PI_INPUT_HINT_RE, PI_MENU_HINT_RE, PI_THINKING_HINT_LINES } from "./pi.ts";
import { openCodeV1QuestionActive } from "./opencode.ts";
import { isPiQuestionnaireScreen } from "./pi-questionnaire.ts";
import { cmdFooterStart } from "./cmd.ts";

/**
 * A row of OmO's omo-task widget under the input box (omo-ai plugin/extensions/omo-task.js): a live row
 * `<spinner> <task> · <route> · <state>[ · <elapsed>]` with the route `agent:X`, `category:X` or `task`,
 * a finished row `<task>|<route> <mode> <status>`, or the `+N more` line after five rows.
 */
const OMO_TASK_ROW_RE = /^(?:[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏‖] .+? · (?:agent:|category:|task(?: ·|$))|[^|]+\|(?:agent:|category:|task\b)|\+\d+ more$)/u;
/** a spinner row with no task route: another program's output, never the widget */
const OMO_SPINNER_ROW_RE = /^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏‖] /u;
/** a narrow pane wraps a task row's last fields (ending in the elapsed time) onto one more short line */
const OMO_TASK_TAIL_RE = /^(?:[^\u00b7]+ \u00b7 )*\d+[hms](?: \d+[hms])*$/u;
const OMO_TASK_WRAP_MAX = 32;
/** where each of the form's hints ends, however a narrow pane wraps it */
const OMO_HINT_END_RE = /\besc (?:cancel|back|discard)$/;
/** OmO's apparently empty input box; never sufficient evidence for sending text into it. */
const OMO_EMPTY_BOX_RE = /^[❯›>]$/;

/**
 * omp's status row (18.12.6 with `composer.shape: pi`): a spinner and the elapsed time while the agent waits, or
 * `π` at rest, then its ` · `-separated fields, e.g. ` ⠋ 0s · ⬢ Ask fixture · 🗑 …/home/fixture · ◫ 5.7%/131K ⟲`.
 */
const OMP_STATUS_ROW_RE = /^(?:[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] \S+|π) · /u;
const OMP_PANEL_BOTTOM_RE = /^╰─+╯$/u;

/**
 * omp prints its status row right under the Ask panel's bottom border while the question waits (#1644), one empty
 * row lower in the composer shapes that keep a gap over it (`rule`, `field`, `rail`; pi-tui `bottomBarGap`): that row,
 * there and nowhere else, is not later output. Alone it proves nothing; the border above it does, and only
 * as the panel's own: right under the panel's last row, the last line shown once the row is left out. Another
 * box drawn under an old panel ends in a border too, but its own (empty) rows sit between that border and the hint.
 */
function withoutOmpStatusRow(visible: string[], cleanLines: string[]): string[] {
  const end = findLastIndex(cleanLines, (line) => line !== "");
  const border = cleanLines[end - 1] === "" ? end - 2 : end - 1;
  if (border < 1 || !OMP_STATUS_ROW_RE.test(cleanLines[end]!) || !OMP_PANEL_BOTTOM_RE.test(cleanLines[border]!)
    || cleanLines[border - 1] !== visible.at(-2)) return visible;
  return visible.slice(0, -1);
}

/** the last row of Claude's review of several answers, which ends it in place of a hint */
/** the last row of Claude's review of several answers, which ends it in place of a hint */
const CLAUDE_SUBMIT_TAIL_RE = /^(?:[›>❯]\s*)?\d+\.\s+Cancel$/i;

/** The rule below an OmO form or composer, then extension task status and the native footer. */
function omoFooterIsActive(lines: string[]): boolean {
  let rules = 0;
  let footer = 0;
  let widget = false;
  let tail = false;
  for (const line of lines) {
    if (!line) continue;
    if (OMO_SPINNER_ROW_RE.test(line) && !OMO_TASK_ROW_RE.test(line)) return false;
    if (SOLID_RULE_RE.test(line)) {
      if (rules > 0 || footer > 0) return false;
      rules = 1;
    } else if (rules > 0 && footer === 0 && (
      /^(?:[▶◌✗✓] .*\bcategory:|▶ .* \bwave \d+\/\d+\b)/.test(line)
      || (widget && /^(?:\d+[hms]\s*)+$/.test(line))
    )) {
      tail = false;
      // A duration may wrap off the task row. Only these status rows precede the native footer;
      // arbitrary output, a second rule, or another program's input still invalidates the form.
      widget = true;
    } else if (rules > 0 && footer === 0 && !OMO_NOT_FOOTER_RE.test(line) && (
      OMO_TASK_ROW_RE.test(line)
      || (tail && line.length <= OMO_TASK_WRAP_MAX && OMO_TASK_TAIL_RE.test(line))
    )) {
      // a task row, or the one short line it wrapped onto
      tail = OMO_TASK_ROW_RE.test(line);
    } else if (rules === 0 || ++footer > OMO_FOOTER_LINES || OMO_NOT_FOOTER_RE.test(line)) return false;
  }
  return rules === 1;
}

export function promptTailIsActive(prompt: ParsedPrompt, screen: string): boolean {
  const cleanLines = screen.replace(ANSI_RE, "").split(/\r?\n/).map(cleanLine);
  const visible = cleanLines.filter((line) => line && !isDivider(line));
  // Claude's review has no hint of its own: its last row ends the panel, the session's rule and task list come after it
  const shown = prompt.responder === "claude-submit" ? withoutClaudeTasks(visible, (lines, end) => CLAUDE_SUBMIT_TAIL_RE.test(lines[end - 1] ?? ""))
    : prompt.responder.startsWith("claude-") ? withoutClaudeTasks(visible)
    : prompt.responder === "omp-question" || prompt.responder === "omp-submit" ? withoutOmpStatusRow(visible, cleanLines) : visible;
  const last = shown.at(-1) ?? "";
  // The menu is still at the bottom. A narrow pane wraps its hint, so the last line alone can
  // be the hint's tail (`cancel`): the lines before it count only when the match runs into
  // the last one, never for a hint that ended above later output (an answered, stale menu).
  const ends = (re: RegExp): boolean => [1, 2, 3].some((span) =>
    re.test(shown.slice(-span).join(" ")) && (span === 1 || !re.test(shown.slice(-span, -1).join(" "))));
  // Pi custom readers validate their complete frame and Pi footer themselves.
  if (prompt.responder.startsWith("pi-questionnaire-")) return true;
  if (prompt.responder === "pi-ask-question" || prompt.responder === "pi-ask-submit") return true;
  if (prompt.responder === "omp-question") return ends(OMP_SINGLE_HINT_RE) || ends(OMP_CLIPPED_SINGLE_HINT_RE) || ends(OMP_SINGLE_CLIPPED_HINT_RE) || ends(OMP_MULTI_HINT_RE)
    || ends(OMP_MULTI_CLIPPED_HINT_RE);
  if (prompt.responder === "omp-submit") return ends(OMP_REVIEW_HINT_RE);
  // Hermes keeps its status line (and maybe the hint's wrapped tail) under the hint; an answered
  // question leaves the screen, so a hint among the last few lines is the live one
  if (prompt.responder === "hermes-question" || prompt.responder === "hermes-input") return shown.slice(-4).some((line) => HERMES_HINT_RE.test(line));
  if (prompt.responder === "codex-menu") return ends(CODEX_CONTINUE_HINT_RE);
  if (prompt.responder === "codex-question") return ends(CODEX_ASK_HINT_RE);
  if (prompt.responder === "codex-async-question") return cleanLines.slice(-4).some((line) => CODEX_ASYNC_ASK_HINT_RE.test(line)) || ends(CODEX_ASYNC_ASK_HINT_RE);
  if (prompt.responder === "claude-question") return ends(CLAUDE_ASK_HINT_RE);
  if (prompt.responder === "claude-submit") return CLAUDE_SUBMIT_TAIL_RE.test(last);
  // the last row carries the cursor once a move has put it there
  // Codex's folder trust prompt ends "enter continue · esc back" or, from 0.163, "· esc quit".
  // Only those two: its update prompt ends "· esc skip" and must not read as an approval.
  if (prompt.responder === "codex-approval") return ends(/press enter to confirm|esc to cancel|enter continue\s*·\s*esc (?:back|quit)$|^(?:[›>❯]\s*)?\d+\.\s+(?:No|Reject|Cancel|Deny)\b/i);
  // the panel (with 18.13's composer under it), or the older Approve/Deny menu's rows
  if (prompt.responder === "omp-approval") return ompApprovalPanelShown(screen) || ends(/^(?:[›>❯•]\s*)?(?:Approve|Deny)$|esc.*cancel/i);
  // Claude Code 2.1.29x ends with "Esc to cancel", optionally followed by its stop-agents
  // chord. Anchor that suffix so arbitrary trailing text cannot keep an old approval live.
  if (prompt.responder === "claude-approval") return ends(/esc to cancel.*(?:tab|ctrl\+e)|ctrl\+e to explain|^esc to cancel(?:\s*·\s*ctrl\+x ctrl\+k twice to stop background agents)?$/i);
  if (prompt.responder === "claude-confirm") return ends(CLAUDE_CONFIRM_HINT_RE);
  // its parser already found the hint over the input box with only the footer under it
  if (prompt.responder === "claude-held") return true;
  // so has omp's handoff status: only omp's status bar and editor under it
  if (prompt.responder === "omp-handoff") return true;
  // the goal dialog ends the screen with its own dismiss hint
  if (prompt.responder === "claude-goal") return ends(/esc to dismiss$/i);
  if (prompt.responder === "claude-model") return claudeModelListWaits(screen);
  if (prompt.responder === "claude-effort") return ends(CLAUDE_EFFORT_HINT_RE);
  if (prompt.responder === "codex-model") return ends(/(?:^|\s)enter select\s*·\s*esc back$|(?:^|\s)enter (?:default|apply)\s*·\s*s session\s*·\s*esc back$/i);
  if (prompt.responder === "omo-question" || prompt.responder === "omo-review" || prompt.responder === "omo-typing") {
    // The form is live only with OmO's footer and extension status under its hint: blank lines, one
    // rule, status widgets, then the footer's few lines (cwd, context, model). Anything else is the form's text
    // in another program (printed in a shell, quoted in a transcript over an input box), where
    // an answer's keys would be typed into that program.
    const hint = { "omo-question": OMO_OPTIONS_HINT_RE, "omo-review": OMO_REVIEW_HINT_RE, "omo-typing": OMO_TYPING_HINT_RE }[prompt.responder];
    const at = findLastIndex(cleanLines, (line, index) => line !== "" && hint.test(wrapped(cleanLines, index, OMO_HINT_LINES)));
    if (at < 0) return false;
    let end = at;
    while (end < at + OMO_HINT_LINES && !OMO_HINT_END_RE.test(cleanLines.slice(at, end + 1).join(" ").trim())) end += 1;
    if (end >= at + OMO_HINT_LINES) return false;
    return omoFooterIsActive(cleanLines.slice(end + 1));
  }
  if (prompt.responder === "omo-pending") {
    // The widget is live over OmO's input box, other widgets maybe between them: the box (a rule,
    // the box's line, empty, a rule) and then OmO's extension status and native footer.
    const at = findLastIndex(cleanLines, (line, index) => line !== "" && OMO_PENDING_HINT_RE.test(wrapped(cleanLines, index)));
    const box = cleanLines.findIndex((line, index) => index > at && OMO_EMPTY_BOX_RE.test(line));
    if (at < 0 || box < 0 || box - at > 60 || !cleanLines[box - 1]!.startsWith("─")) return false;
    return omoFooterIsActive(cleanLines.slice(box + 1));
  }
  // pi keeps its footer under every dialog — the pane's folder, then its stats line, then any
  // extension status (piFooterLines) — so the hint sits near the end without being it. A dialog
  // already answered leaves its hint far above whatever came after, which is what keeps this window narrow.
  if (prompt.responder === "pi-model") return hintAtEnd(shown, PI_MODEL_HINT_AT_END_RE, piFooterLines(shown));
  if (prompt.responder === "pi-thinking") return hintAtEnd(shown, PI_MODEL_HINT_AT_END_RE, piFooterLines(shown), PI_THINKING_HINT_LINES);
  if (prompt.responder === "omo-model") return omoModelListWaits(screen);
  // its reader already found the picker ending the screen, which only an open picker does
  if (prompt.responder === "omp-model") return true;
  if (prompt.responder === "pi-question" || prompt.responder === "pi-confirm" || prompt.responder === "pi-input") {
    return hintAtEnd(shown, PI_MENU_HINT_AT_END_RE, piFooterLines(shown), 4)
      || hintAtEnd(shown, PI_INPUT_HINT_AT_END_RE, piFooterLines(shown), 4);
  }
  // Command Code's permission footer names its keys at the dialog's end and wraps on a narrow
  // pane: `↑/↓ navigate · enter select · ctrl+e explain · Run cmd --yolo to bypass all …`
  if (prompt.responder === "cmd-question") return cmdFooterStart(shown) >= 0;
  // its footer ends the screen, wrapped or not (dialogs/opencode.ts)
  if (prompt.responder === "opencode-v1-question") return openCodeV1QuestionActive(screen);
  // Claude's plan: its footer, wrapped or not, ends the screen
  return ends(/ctrl\+g to edit|shift\+tab to approve with this feedback/i) || claudePlanFooterEnds(shown);
}

const CLAUDE_PLAN_FOOTER_RE = /^ctrl\+g to edit in [^·]+?[ \n]·[ \n]([^]+)$/i;

/**
 * Whether Claude's plan footer, `ctrl+g to edit in VS Code · ~/.claude/plans/x.md`, ends the screen. A narrow pane
 * wraps it with nothing marking the breaks: at a space before the path, or anywhere inside the path, even
 * between `.m` and `d`, and over as many lines as the path needs. So the path's lines are joined as one
 * word, and `.md` may show only at its very end: output under an answered plan (`⏺ Updated README.md`, a bare
 * `README.md`, even one written on the footer's last row) comes after a path already complete, so it never
 * extends it; a plan folder with `.md` in its name goes unread instead. The folder may hold a `·`
 * (`CLAUDE_CONFIG_DIR`), so only the first `·` after the editor's name separates the path.
 */
function claudePlanFooterEnds(shown: string[]): boolean {
  const at = findLastIndex(shown, (line) => /^ctrl\+g to edit\b/i.test(line));
  const path = at < 0 ? undefined : CLAUDE_PLAN_FOOTER_RE.exec(shown.slice(at).join("\n"))?.[1];
  if (path === undefined) return false;
  const joined = path.replaceAll("\n", "");
  return joined.indexOf(".md") === joined.length - 3;
}
/**
 * The same two hints told from the end of the window. A phone leaves pi a pane barely wide enough
 * for its hint, which wraps it, and pi keeps its footer underneath: the wrapped hint then sits
 * further from the bottom than a three-line window reaches, while a wider pane still has it as the
 * last thing. Anchored, because the footer's own lines complete a join that merely starts with the
 * hint's words, which would keep an answered dialog offering to press keys into the pane.
 */
const PI_MENU_HINT_AT_END_RE = new RegExp(`${PI_MENU_HINT_RE.source}$`, "i");
const PI_INPUT_HINT_AT_END_RE = new RegExp(`${PI_INPUT_HINT_RE.source}$`, "i");
/** The same hint told from the end, so lines that follow it cannot complete a match of their own. */
const PI_MODEL_HINT_AT_END_RE = new RegExp(`${PI_MODEL_HINT_RE.source}$`, "i");
/**
 * pi's own footer, under `/model` and under every dialog alike: the pane's folder, then its
 * stats line. A hint is allowed this many lines of it before the bottom of the screen, one more
 * under an extension's status (piFooterLines).
 */
const PI_FOOTER_LINES = 2;

/**
 * pi's stats line, its second footer line: usage counters (`↑1.2k ↓300 R… W… CH…% $0.012 (sub)`), then
 * the context meter (`3.7%/1.0M`, `?/200k`). The meter comes last, and a narrow pane cuts the line
 * with `...` before it (`↑52 ↓5.3k R460k W33k CH98.9% $0.461 (sub) 3.7...`), so the line is told by how
 * it starts: both counters (`↑52 ↓5.3k`), or the meter alone when pi has no usage yet (pi 1.4.0's footer).
 */
const PI_STATS_LINE_RE = /^(?:↑[\d.]+[kKmMbB]? ↓[\d.]+[kKmMbB]?|(?:\d+(?:\.\d+)?%|\?)\/[\d.]+[kKmMbB]?)(?:\s|\.\.\.|$)/u;

/** pi's first footer line, the pane's folder: `~/app (main)`, `/tmp/app`, `C:\work\app`. */
const PI_FOLDER_LINE_RE = /^(?:~(?:[\\/]|\s|$)|\/|[A-Za-z]:[\\/])/u;

/**
 * An extension's `ctx.ui.setStatus` adds a third footer line under the stats line: pi joins every
 * status into that one line and truncates it to the pane's width, so it never wraps (pi 1.4.0's
 * footer). pi mounts its footer last, so while it runs nothing else can follow the stats line, and a
 * single line there is taken for that status, but only under pi's whole footer (its folder line, then
 * its stats line). A prompt there, or more output than that one line, still buries the hint. A screen
 * pi left behind when it ended looks the same with one line of the shell's under it, so a card answers
 * only while pi still holds the pane's input (piOwnsInput in prompt.ts).
 */
function piFooterLines(shown: string[]): number {
  // Windows names no foreground process to tell a live pi from the shell under its last screen: no status line there
  if (process.platform === "win32") return PI_FOOTER_LINES;
  const status = shown.at(-1) ?? "";
  const footer = PI_FOLDER_LINE_RE.test(shown.at(-3) ?? "") && PI_STATS_LINE_RE.test(shown.at(-2) ?? "");
  return footer && !PROMPT_LINE_RE.test(status) ? PI_FOOTER_LINES + 1 : PI_FOOTER_LINES;
}

/**
 * Whether a hint is the last thing before an agent's footer, allowing for a phone's pane being
 * too narrow to hold it on one line: a TUI hard-wraps, so the hint arrives split over two or
 * three lines with nothing marking the break. Anchored to the end of the joined window, because
 * a hint's words also match a join that merely starts with them — the footer's own lines read as
 * a hint that way, which would keep an answered, buried list offering a switch into whatever the
 * pane shows by then.
 */
function hintAtEnd(shown: string[], atEnd: RegExp, footerLines: number, span = 3): boolean {
  for (let end = shown.length - 1; end >= Math.max(0, shown.length - 1 - footerLines); end -= 1) {
    for (let size = 1; size <= span; size += 1) {
      const from = end - size + 1;
      if (from < 0) break;
      if (atEnd.test(shown.slice(from, end + 1).join(" "))) return true;
    }
  }
  return false;
}

export function parsePrompt(agent: string, fullScreen: string, omoAsk: OmoAsk | null = null, omoTrusted = true, omoOpen: OmoAsk[] = [], sent: string | null = null, working = false): ParsedPrompt | null {
  // Claude's menus are read, and their tail checked, on the session's side of a fullscreen side panel
  const screen = agent === "claude" ? withoutClaudeSidePanel(fullScreen) : fullScreen;
  if (agent === "pi" && isPiQuestionnaireScreen(screen)) return null; // requires native call binding
  const ctx = { agent, omoAsk, omoTrusted, omoOpen, sent, working };
  for (const reader of registry.readersFor(agent)) {
    // a result reader reads only below a send's own echo (outcome.ts), never a card on the whole screen
    if (reader.kind === "result") continue;
    const candidate = reader.parse(screen, ctx);
    if (candidate !== null && promptTailIsActive(candidate, screen)) return candidate;
  }
  return null;
}

/**
 * The pane's live screen as text: herdr's bottom buffer, whatever part of the history the pane's
 * viewport shows. A pane scrolled up (a drag or the wheel in a terminal) stays scrolled while the
 * agent draws its next menu at the bottom, out of that viewport.
 */
export async function liveScreen(paneId: string): Promise<string> {
  return (await paneRead({ paneId, source: "detection", format: "text" })).text;
}
