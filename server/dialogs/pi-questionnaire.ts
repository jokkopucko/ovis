import type { DialogReader } from "./registry.ts";
import { piActiveTab } from "./pi-ask-tabs.ts";
import { ANSI_RE, KEY, PROMPT_LINE_RE, type ParsedPrompt, finishPrompt, keySteps, navigationKeys } from "./shared.ts";

// Installed questionnaire.ts uses ui.custom, not native Pi dialogs or rpiv's widget.
// Bind to a pending call: visible prose alone cannot distinguish an ordinary option
// named "Type something." from the synthetic editor row, or recover hard-wrapped words.
interface Question {
  id: string; label: string; prompt: string;
  options: { value: string; label: string; description?: string }[]; allowOther: boolean;
}
export interface PiQuestionnaire { id: string; questions: Question[] }
const SINGLE = "↑↓ navigate • Enter select • Esc cancel";
const MULTI = "Tab/←→ navigate • ↑↓ select • Enter confirm • Esc cancel";
const INPUT = "Enter to submit • Esc to cancel";
const compact = (text: string): string => text.replace(/\s/g, "");
const same = (a: string, b: string): boolean => compact(a) === compact(b);
const rule = (line: string): boolean => /^─{8,}$/.test(line);
const piStats = (line: string): boolean => /\d+(?:\.\d+)?%\/\d/.test(line) && !/^[>›❯]/.test(line.trim());
const piFolder = (line: string): boolean => /^(?:[A-Za-z]:[\\/]|[~\/])/.test(line);
/**
 * An extension's `ctx.ui.setStatus` line, which pi draws under its folder and stats lines (one line,
 * truncated, never wrapped). Only directly under them, and never a composer's or a shell's prompt. Not on
 * Windows, where no foreground process tells a live pi from the shell under its last screen.
 */
const piStatus = (lines: string[], at: number): boolean => process.platform !== "win32" && at >= 2 && !piStats(lines[at] ?? "")
  && !PROMPT_LINE_RE.test(lines[at]!.trim()) && piStats(lines[at - 1] ?? "") && piFolder(lines[at - 2] ?? "");

/** Also reserves malformed/clipped active drawings, never old hints above a newer prompt. */
export function isPiQuestionnaireScreen(screen: string): boolean {
  const lines = screen.slice(-8192).replace(ANSI_RE, "").split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  if (piStatus(lines, lines.length - 1)) lines.pop();
  const last = lines.at(-1) ?? "";
  if (/\d+(?:\.\d+)?%\/\d/.test(last) && !/^[>›❯]/.test(last)
    && /^(?:[A-Za-z]:[\\/]|[~\/])/.test(lines.at(-2) ?? "")) lines.splice(-2);
  if (rule(lines.at(-1) ?? "")) lines.pop();
  const tail = compact(lines.slice(-32).join(" "));
  return /↑↓navigate•Enterselect(?:•Esc(?:cancel)?)?$/.test(tail)
    || /Tab\/←→navigate•↑↓select(?:•Enterconfirm(?:•Esc(?:cancel)?)?)?$/.test(tail)
    || /Entertosubmit•Esc(?:tocancel)?$/.test(tail);
}

// Bound synchronous work before splitting, stripping escapes or reconstructing any frame.
export const MAX_QUESTIONNAIRE_SCREEN_CHARS = 64 * 1024;
const MAX_QUESTIONNAIRE_SCREEN_LINES = 512;

/** Compare a wrapped suffix one line at a time, without copying growing screen suffixes. */
function suffixStart(lines: string[], text: string): number {
  const wanted = compact(text);
  let end = wanted.length;
  let at = lines.length;
  while (at > 0 && end > 0) {
    const line = compact(lines[--at]!);
    if (line.length > end || !wanted.endsWith(line, end)) return -1;
    end -= line.length;
  }
  return end > 0 ? -1 : at;
}

export function piQuestionnaireOf(id: string, args: unknown): PiQuestionnaire | null {
  const raw = (args as { questions?: unknown } | null)?.questions;
  if (!Array.isArray(raw) || !raw.length || raw.length > 32) return null;
  const text = (value: unknown, allowEmpty = false): value is string => typeof value === "string" && (allowEmpty || !!value.trim())
    && value.length <= 12_000 && !/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/.test(value);
  const questions: Question[] = [];
  for (const q of raw) {
    if (!q || !text(q.id) || questions.some(other => other.id === q.id) || !text(q.prompt)
      || q.label !== undefined && !text(q.label, true) || q.allowOther !== undefined && typeof q.allowOther !== "boolean"
      || !Array.isArray(q.options) || q.options.length > 64) return null;
    const label = q.label || `Q${questions.length + 1}`;
    if (raw.length > 1 && /[□■✓←→\r\n]/.test(label)) return null;
    if (q.options.some((o: Question["options"][number]) => !o || !text(o.value, true) || !text(o.label)
      || o.description !== undefined && !text(o.description, true))) return null;
    if (!q.options.length && q.allowOther === false) return null;
    questions.push({ ...q, label, allowOther: q.allowOther !== false });
  }
  if (new Set(questions.map(q => compact(q.label))).size !== questions.length) return null;
  return { id, questions };
}

export function parsePiQuestionnaire(screen: string, source?: PiQuestionnaire): ParsedPrompt | null {
  if (!source || screen.length > MAX_QUESTIONNAIRE_SCREEN_CHARS) return null;
  const raw = screen.replace(/\u001b_pi:[^\u0007]*\u0007/g, "").split(/\r?\n/).map(line => line.trimEnd());
  if (raw.length > MAX_QUESTIONNAIRE_SCREEN_LINES) return null;
  const lines = raw.map(line => line.replace(ANSI_RE, ""));
  let bottom = lines.length - 1;
  while (bottom >= 0 && !lines[bottom]) bottom--;
  // Pi's own two-line footer is allowed, and an extension's status under it, never a composer or
  // output below an old form.
  if (!rule(lines[bottom] ?? "") && piStatus(lines, bottom)) bottom--;
  if (!rule(lines[bottom] ?? "")) {
    if (!/\d+(?:\.\d+)?%\/\d/.test(lines[bottom] ?? "") || /^[>›❯]/.test(lines[bottom]?.trim() ?? "")
      || !/^(?:[A-Za-z]:[\\/]|[~\/])/.test(lines[bottom - 1] ?? "")) return null;
    bottom -= 2;
    while (bottom >= 0 && !lines[bottom]) bottom--;
  }
  if (!rule(lines[bottom] ?? "")) return null;
  let top = bottom - 1;
  while (top >= 0 && !rule(lines[top]!)) top--;
  if (top < 0 || lines[top] !== lines[bottom]) return null;
  const body = lines.slice(top + 1, bottom);
  const multi = source.questions.length > 1;
  let index = 0;
  let tabs: { label: string; answered: boolean; current: boolean; can_navigate?: boolean }[] | undefined;
  let tabIdentity = "";
  let offset = 0;
  if (multi) {
    const end = body.findIndex(line => !line.trim());
    if (end < 1) return null;
    // Keep SGR even when pane.read reserializes it before the line's padding.
    const bar = raw.slice(top + 1, top + 1 + end).join(" ");
    const plain = bar.replace(ANSI_RE, "");
    const marks = [...plain.matchAll(/[□■✓]/g)];
    const expected = `← ${source.questions.map((q, at) => `${marks[at]?.[0]} ${q.label}`).join(" ")} ✓ Submit →`;
    if (marks.length !== source.questions.length + 1 || marks.at(-1)?.[0] !== "✓"
      || marks.slice(0, -1).some(mark => !/[□■]/.test(mark[0])) || !same(plain, expected)) return null;
    const active = piActiveTab(bar, marks.map(mark => mark.index!));
    if (active === null) return null;
    index = active;
    const all = marks.slice(0, -1).every(mark => mark[0] === "■");
    tabs = [...source.questions.map((q, at) => ({ label: q.label, answered: marks[at]![0] === "■", current: index === at, can_navigate: true })),
      { label: "Submit", answered: false, current: index === source.questions.length, can_navigate: all }];
    tabIdentity = JSON.stringify(tabs.map(tab => [tab.label, tab.answered]));
    offset = end + 1;
  }
  const content = body.slice(offset);
  const hint = index === source.questions.length || multi ? MULTI : SINGLE;
  const joined = compact(content.join(" "));
  const inputMode = joined.endsWith(compact(INPUT));
  if (!joined.endsWith(compact(inputMode ? INPUT : hint))) return null;
  // Strip the complete wrapped hint, preserving all content before its leading blank.
  const hintStart = suffixStart(content, inputMode ? INPUT : hint);
  if (hintStart <= 0) return null;
  let own = content.slice(0, hintStart);
  while (own.at(-1)?.trim() === "") own.pop();
  const internal = {
    ...(tabs ? { piAskForm: { identity: `${source.id}\0${tabIdentity}`, index } } : {}),
    menuLabels: [] as string[], selectedIndex: 0, checkedOptionIndices: [], customMenuIndex: null, rejectWithEscapeIndex: null,
  };
  const hashed = { call: `${source.id}\0${index}\0${tabIdentity}`, steps: undefined, can_step_back: undefined };
  if (index === source.questions.length) {
    if (inputMode || own.shift()?.trim() !== "Ready to submit") return null;
    const answered = tabs!.slice(0, -1);
    const missing = answered.filter(tab => !tab.answered);
    const caption = missing.length ? `Unanswered: ${missing.map(tab => tab.label).join(", ")}` : "Press Enter to submit";
    const captionStart = suffixStart(own, caption);
    if (captionStart < 0) return null;
    // Keep row boundaries: joining a hard wrap with a space can turn "Savefile"
    // into the distinct option "Save file". Only unwrapped text is exact evidence.
    const summary = own.slice(0, captionStart).map(line => line.trim()).filter(Boolean).join("\n");
    const dense = compact(summary);
    const positions = [...summary.matchAll(/\S/g)].map(match => match.index!);
    const answers: { question: string; answer: string | null }[] = [];
    let at = 0;
    for (const [questionIndex, tab] of answered.entries()) {
      if (!tab.answered) { answers.push({ question: tab.label, answer: null }); continue; }
      const prefix = `${compact(tab.label)}:`;
      if (!dense.startsWith(prefix, at)) return null;
      at += prefix.length;
      const next = answered.slice(questionIndex + 1).find(tab => tab.answered);
      const nextPrefix = next ? `${compact(next.label)}:` : null;
      const end = nextPrefix ? dense.indexOf(nextPrefix, at) : dense.length;
      // A header inside an answer is ambiguous, not a guessed summary boundary.
      if (end <= at || nextPrefix && dense.indexOf(nextPrefix, end + 1) !== -1) return null;
      const rendered = summary.slice(positions[at], positions[end] ?? summary.length).trim();
      let answer = rendered.replace(/\n/g, " ");
      const q = source.questions[questionIndex]!;
      if (dense.slice(at, end).startsWith("(wrote)")) {
        const custom = summary.slice(positions[at + 7], positions[end] ?? summary.length).trim();
        if (!custom) return null;
        answer = `(wrote) ${custom.replace(/\n/g, " ")}`;
      } else {
        const exact = rendered.includes("\n") ? [] : q.options.filter(option => option.label === rendered);
        const candidates = exact.length ? exact : q.options.filter(option => same(option.label, answer));
        if (candidates.length !== 1) return null;
        answer = candidates[0]!.label; // recover only unambiguous hard-wrapped words
      }
      answers.push({ question: tab.label, answer });
      at = end;
    }
    if (at !== dense.length) return null;
    return finishPrompt("pi", {
      kind: "question", title: "Review your answers", question: missing.length ? caption : "Submit these answers?", body: null, answers,
      options: missing.length ? [{ label: "Cancel", description: null }] : [{ label: "Submit answers", description: null }, { label: "Cancel", description: null }],
      multi_select: false, custom_option_index: null, steps: tabs, can_step_back: true,
    }, { ...internal, responder: "pi-questionnaire-submit", optionSteps: missing.length ? [keySteps([KEY.escape])] : [keySteps([KEY.enter]), keySteps([KEY.escape])] }, hashed);
  }
  const q = source.questions[index];
  if (!q) return null;
  const first = own.findIndex(line => /^(?:> | {2})1\. /.test(line));
  if (first < 0 || !same(own.slice(0, first).join(" "), q.prompt)) return null;
  let editorRows: string[] | undefined;
  if (inputMode) {
    const answerAt = own.findIndex(line => line.trim() === "Your answer:");
    if (!q.allowOther || answerAt < first) return null;
    const editor = own.slice(answerAt + 1).filter(line => line.trim());
    // An empty editor still has its blank cursor row. Inspect the full slice instead.
    const drawing = own.slice(answerAt + 1);
    while (!drawing[0]?.trim() && drawing.length) drawing.shift();
    if (editor.length < 2 || !/^ ─{6,}$/.test(drawing[0] ?? "") || drawing.at(-1) !== drawing[0]) return null;
    editorRows = drawing.slice(1, -1).map(line => line.slice(1).trimEnd());
    own = own.slice(0, answerAt);
    while (!own.at(-1)?.trim() && own.length) own.pop();
  }
  const expected = [...q.options, ...(q.allowOther ? [{ value: "__other__", label: "Type something." }] : [])];
  const rows: { label: string; description: string; selected: boolean }[] = [];
  let description = false;
  for (const line of own.slice(first)) {
    if (!line.trim()) continue;
    const match = line.match(/^(> | {2})(\d+)\. (.*)$/);
    if (match) {
      if (Number(match[2]) !== rows.length + 1) return null;
      rows.push({ label: match[3]!, description: "", selected: match[1] === "> " }); description = false;
    } else {
      const row = rows.at(-1);
      if (!row || !/^ {2}\S|^ {5}\S/.test(line)) return null;
      if (line.startsWith("     ")) description = true;
      row[description ? "description" : "label"] += ` ${line.trim()}`;
    }
  }
  if (rows.length !== expected.length || rows.filter(row => row.selected).length !== 1) return null;
  const cursor = rows.findIndex(row => row.selected);
  if (inputMode && cursor !== expected.length - 1) return null;
  if (rows.some((row, at) => !same(row.label, `${expected[at]!.label}${inputMode && at === cursor ? " ✎" : ""}`)
    || !same(row.description, expected[at]!.description ?? ""))) return null;
  const custom = q.allowOther ? q.options.length : null;
  return finishPrompt("pi", {
    kind: "question", title: multi ? q.label : "", question: q.prompt, body: null,
    options: q.options.map(option => ({ label: option.label, description: option.description ?? null })),
    multi_select: false, custom_option_index: custom,
    ...(tabs ? { steps: inputMode ? tabs.map(tab => ({ ...tab, can_navigate: false })) : tabs, can_step_back: !inputMode && index > 0 } : {}),
  }, {
    ...internal, responder: "pi-questionnaire-question", menuLabels: expected.map(option => option.label), selectedIndex: cursor, customMenuIndex: custom,
    ...(inputMode ? { piQuestionnaireInput: editorRows!.join(""), piQuestionnaireInputRows: editorRows! } : {}),
    customSteps: text => [...keySteps(navigationKeys(custom! - cursor)), ...keySteps([KEY.enter]), { text }, ...keySteps([KEY.enter])],
  }, hashed);
}

export const readers: readonly DialogReader[] = ["pi-questionnaire-question", "pi-questionnaire-submit"].map(id => ({
  id, agents: ["pi"], priority: 84, reread: "each-move", list: "none",
  // Only readKnownPrompt can supply the pane's verified pending call.
  parse: () => null,
}));

/** Editor word wrapping trims whitespace at row ends. Match every visible character in
 * order, permitting only that invisible whitespace between wrapped rows, never within one. */
export function piQuestionnaireInputMatches(shown: ParsedPrompt, draft: string): boolean {
  const rows = shown.piQuestionnaireInputRows;
  if (!rows?.length) return false;
  let at = 0;
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index]!;
    if (!draft.startsWith(row, at)) return false;
    at += row.length;
    if (index < rows.length - 1) {
      while (draft[at] === " " && !draft.startsWith(rows[index + 1]!, at)) at++;
    }
  }
  return at === draft.length;
}
