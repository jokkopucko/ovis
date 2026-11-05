import type { DialogReader } from "./registry.ts";
import { piAskTabs } from "./pi-ask-tabs.ts";
import { ANSI_RE, KEY, type AnswerStep, type OmoAsk, type ParsedPrompt, cleanLine, findLastIndex, finishPrompt, keySteps, navigationKeys, normalizeText, own } from "./shared.ts";

// rpiv-ask-user-question uses ui.custom, not Pi's native select widget. Its numbered
// rows are cursor positions, NOT numeric shortcuts. Keep it separate from pi.ts.
const HINT_RE = /^Enter to select · ↑\/↓ to navigate(?: ·.*|…)?$/;
const RULE_RE = /^─{8,}$/;
const ROW_RE = /^(❯ | {2})(\d+)\.\s*(.*)$/;
const CURSOR_APC_RE = /\u001b_pi:[^\u0007]*\u0007/g;
const OTHER = "Type something.";

interface Frame { lines: string[]; rawLines: string[]; hint: string; top: number; bottom: number; hintIndex: number }

function formTabs(frame: Frame) {
  const raw = frame.rawLines.slice(frame.top + 1, frame.bottom).find(line => /^\s*←.*✓ Submit\s*→$/.test(line.replace(ANSI_RE, "")));
  return raw ? piAskTabs(raw) : null;
}

/** Only the widget's own hint, optionally followed by Pi's folder/context footer, may own input. */
function frame(screen: string): Frame | null {
  const rawLines = screen.replace(CURSOR_APC_RE, "").split(/\r?\n/).map(line => line.trimEnd());
  const lines = rawLines.map(line => line.replace(ANSI_RE, ""));
  const hintIndex = findLastIndex(lines, line => HINT_RE.test(line.trim()));
  if (hintIndex < 0) return null;
  const tail = lines.slice(hintIndex + 1).map(line => line.trim()).filter(Boolean);
  if (tail.length) {
    // Standalone overlay: no footer. Inline editor: folder + context directly under the
    // widget's hint; native/older compositions can put a rule before those same two lines.
    // Never accept a new composer or arbitrary output after a stale copy of the widget.
    const footer = RULE_RE.test(tail[0] ?? "") ? tail.slice(1) : tail;
    if (footer.length !== 2
      || !/^(?:[A-Za-z]:[\\/]|[~\/])/.test(footer[0] ?? "")
      || !/\d+(?:\.\d+)?%\/\d/.test(footer[1] ?? "")
      || /^[❯›>]/.test(footer[1]!)) return null;
  }
  const bottom = findLastIndex(lines.slice(0, hintIndex), line => RULE_RE.test(line));
  const top = findLastIndex(lines.slice(0, bottom), line => RULE_RE.test(line));
  if (top < 0 || bottom < 0) return null;
  // Notes editors add their own rules; side-by-side previews add a second column. Neither
  // is a complete, unambiguous row list in a plain screen mirror. Leave those to Terminal.
  if (lines.slice(top + 1, bottom).some(line => /[│┌┐└┘]|^\s*(?:Notes:|Global note:|Note for this answer:)/.test(line))) return null;
  return { lines, rawLines, hint: lines[hintIndex]!.trim(), top, bottom, hintIndex };
}

interface Row { label: string; description: string[]; selected: boolean; checked: boolean; box: boolean }

function question(frame: Frame, expected?: OmoAsk): ParsedPrompt | null {
  const { lines, top, bottom, hint, hintIndex } = frame;
  if (lines.slice(bottom + 1, hintIndex).some(line => line.trim())) return null;
  const first = lines.findIndex((line, index) => index > top && index < bottom && ROW_RE.test(line));
  if (first < 0) return null;
  const rows: Row[] = [];
  let next: { label: string; selected: boolean } | null = null;
  for (const line of lines.slice(first, bottom)) {
    if (!line.trim()) continue;
    const match = line.match(ROW_RE);
    if (match) {
      if (next || Number(match[2]) !== rows.length + 1) return null;
      const box = match[3]!.match(/^\[([ ✔xX])\]\s*(.*)$/);
      rows.push({ label: box ? box[2]! : match[3]!, description: [], selected: match[1] === "❯ ", checked: !!box && box[1] !== " ", box: !!box });
    } else if (/^(?:❯ | {2})(?:Next|Submit)$/.test(line)) {
      if (next) return null;
      next = { label: line.trim().replace(/^❯ /, ""), selected: line.startsWith("❯ ") };
    } else {
      const row = rows.at(-1);
      if (!row || next || !/^\s{2,}\S/.test(line) || /…|\.\.\.|^\s*[↑↓]/.test(line)) return null;
      row.description.push(line.trim());
    }
  }
  const multi = rows[0]?.box === true;
  if (rows.length < 3 || rows.length > 5 || rows.some(row => row.box !== multi)
    || (multi !== (next !== null)) || (!multi && /Space to toggle/.test(hint))) return null;
  if (rows.filter(row => row.selected).length + Number(next?.selected ?? false) !== 1) return null;
  const other = rows.at(-1)!;
  // Focusing Other immediately opens the inline editor: its placeholder disappears. This
  // variant is identified by the input-specific hint, never by arbitrary numbered prose.
  const typing = other.selected && /Shift\+Enter for newline|Ctrl\+U to clear/.test(hint);
  if (other.label !== OTHER && !typing && !expected) return null;
  if (other.description.length || rows.slice(0, -1).some(row => !row.label || /…$/.test(row.label))) return null;
  // A multi-pick from the web must not silently include a custom draft owned by the terminal.
  if (multi && (other.checked || (typing && other.label.trim()))) return null;
  const heading = lines.slice(top + 1, first);
  const tabBar = heading.filter(line => /^\s*←.*✓ Submit\s*→$/.test(line)).map(line => line.trim()).join(" ");
  const content = heading.filter(line => !/^\s*←.*✓ Submit\s*→$/.test(line));
  const start = content.findIndex(line => line.trim());
  if (start < 0) return null;
  // The optional single-question badge has its own leading space inside Text's padding.
  // Blank lines within the following question are paragraphs, not extra widget headings.
  const badge = !tabBar && /^ {2}\S/.test(content[start]!) && !content[start + 1]?.trim();
  const title = badge ? normalizeText(content[start]!) : "";
  const text = normalizeText(content.slice(start + Number(badge)).join("\n"));
  if (!text) return null;
  const options = rows.slice(0, -1).map(row => ({ label: row.label, description: row.description.length ? normalizeText(row.description.join(" ")) : null }));
  const selectedIndex = next?.selected ? rows.length : rows.findIndex(row => row.selected);
  const checked = rows.slice(0, -1).flatMap((row, index) => row.checked ? [index] : []);
  const custom = rows.length - 1;
  const tabs = formTabs(frame);
  let confirmed: number | undefined;
  if (expected) {
    const source = tabs?.index !== null && tabs?.index !== undefined ? expected.questions[tabs.index] : undefined;
    const same = (a: string, b: string) => a.replace(/\s/g, "") === b.replace(/\s/g, "");
    if (!source || !same(source.question, text) || source.multiSelect !== multi
      || tabs!.steps.length !== expected.questions.length + 1
      || expected.questions.some((q, index) => !same(q.header, tabs!.steps[index]!.label))
      || source.options.length !== options.length || source.options.some((option, index) => (!same(option.label, options[index]!.label) && !same(`${option.label} ✔`, options[index]!.label))
        || !same(option.description ?? "", options[index]!.description ?? ""))) return null;
    const marked = source.options.findIndex((option, index) => !same(option.label, options[index]!.label));
    if (marked >= 0) confirmed = marked;
    options.forEach((option, index) => { option.label = source.options[index]!.label; });
  }
  const navigable = tabs?.index !== null && tabs?.index !== undefined && !typing;
  return finishPrompt("pi", {
    kind: "question", title: tabs?.index !== null && tabs?.index !== undefined ? tabs.steps[tabs.index]!.label : title,
    question: text, body: null, options,
    multi_select: multi, custom_option_index: multi ? null : custom,
    ...(multi ? { default_option_indices: checked } : {}),
    ...(confirmed !== undefined ? { default_option_index: confirmed } : {}),
    ...(expected && other.label !== OTHER ? { default_custom_text: typing ? other.label : other.label.replace(/ ✔$/, "") } : {}),
    ...(tabs ? { steps: typing ? tabs.steps.map(step => ({ ...step, can_navigate: false })) : tabs.steps,
      can_step_back: navigable && tabs.index! > 0,
      can_step_next: navigable && tabs.steps[tabs.index! + 1]?.can_navigate === true } : {}),
  }, {
    ...(navigable ? { piAskForm: { identity: `${expected?.id ?? ""}\0${tabs!.identity}`, index: tabs!.index! } } : {}),
    ...(typing ? { piAskTyping: true as const } : {}),
    responder: "pi-ask-question", menuLabels: [...options.map(option => option.label), OTHER, ...(next ? [next.label] : [])],
    selectedIndex, checkedOptionIndices: checked, customMenuIndex: multi ? null : custom, rejectWithEscapeIndex: null,
    ...(!multi ? { customSteps: (text: string): AnswerStep[] => [
      ...keySteps(navigationKeys(custom - selectedIndex)), ...keySteps(["ctrl+u"]), { text }, ...keySteps([KEY.enter]),
    ] } : { multiSteps: (choices: number[]): AnswerStep[] => {
      const desired = new Set(choices);
      const keys: string[] = [];
      let cursor = selectedIndex;
      for (let index = 0; index < options.length; index += 1) {
        if (desired.has(index) === checked.includes(index)) continue;
        keys.push(...navigationKeys(index - cursor), KEY.space);
        cursor = index;
      }
      keys.push(...navigationKeys(rows.length - cursor), KEY.enter);
      return keySteps(keys);
    } }),
  }, { steps: undefined, can_step_back: undefined, can_step_next: undefined, default_custom_text: undefined,
    call: JSON.stringify({ source: expected?.id, tabBar, tab: tabs?.index ?? null, ...(multi ? { checked } : {}) }) });
}

function review(frame: Frame, expected?: OmoAsk): ParsedPrompt | null {
  const { lines, top, bottom, hintIndex, hint } = frame;
  if (!lines.slice(top + 1, bottom).some(line => line.trim() === "Review your answers")) return null;
  const picker = lines.slice(bottom + 1, hintIndex).filter(line => line.trim());
  if (picker.length < 3 || !/n to add a note/.test(hint)) return null;
  const rows = picker.slice(-2).map(line => line.match(ROW_RE));
  if (!rows[0] || !rows[1] || rows[0][2] !== "1" || rows[1][2] !== "2"
    || rows[0][3] !== "Submit answers" || rows[1][3] !== "Cancel"
    || rows.filter(row => row![1] === "❯ ").length !== 1) return null;
  const tabs = formTabs(frame);
  if (!tabs || tabs.index !== null && tabs.index !== tabs.steps.length - 1) return null;
  if (expected && (tabs.steps.length !== expected.questions.length + 1
    || expected.questions.some((q, index) => normalizeText(q.header) !== normalizeText(tabs.steps[index]!.label)))) return null;
  const questions = tabs.steps.slice(0, -1);
  const missing = questions.filter(step => !step.answered);
  const caption = normalizeText(picker.slice(0, -2).join("\n"));
  if (caption !== (missing.length ? `⚠ Answer remaining questions before submitting: ${missing.map(step => step.label).join(", ")}` : "Ready to submit your answers?")) return null;
  // Reuse Ovis's review <dl>, not an ASCII/monospace copy of the terminal widget.
  // Answered headers must appear once in native order; a clipped summary is not complete.
  const answered = questions.filter(step => step.answered);
  const summaries: { question: string; answer: string | null }[] = [];
  for (const line of lines.slice(top + 1, bottom).map(cleanLine).filter(Boolean)) {
    if (/^←/.test(line) || line === "Review your answers") continue;
    const header = line.match(/^●\s+(.*)$/);
    if (header) {
      if (header[1] !== answered[summaries.length]?.label || summaries.at(-1)?.answer === null) return null;
      summaries.push({ question: header[1]!, answer: null });
    } else {
      const current = summaries.at(-1);
      if (!current) return null;
      const value = line.match(/^→\s*(.*)$/);
      if (value) {
        if (current.answer !== null || !value[1]) return null;
        current.answer = value[1];
      } else {
        if (current.answer === null) return null;
        current.answer = normalizeText(`${current.answer} ${line}`);
      }
    }
  }
  if (summaries.length !== answered.length || summaries.some(item => item.answer === null)) return null;
  let at = 0;
  const answers = questions.map(step => ({ question: step.label, answer: step.answered ? summaries[at++]!.answer : null }));
  return finishPrompt("pi", {
    kind: "question", title: own("Review your answers"), question: missing.length ? caption.replace(/^⚠\s+/, "") : own("Submit these answers?"), body: null, answers,
    options: missing.length ? [{ label: "Cancel", description: null }]
      : [{ label: "Submit answers", description: null }, { label: "Cancel", description: null }],
    multi_select: false, custom_option_index: null,
    ...(tabs ? { steps: tabs.steps, can_step_back: tabs.index !== null && tabs.index > 0 } : {}),
  }, {
    ...(tabs?.index !== null && tabs?.index !== undefined ? { piAskForm: { identity: `${expected?.id ?? ""}\0${tabs.identity}`, index: tabs.index } } : {}),
    responder: "pi-ask-submit", menuLabels: ["Submit answers", "Cancel"],
    selectedIndex: rows[0][1] === "❯ " ? 0 : 1, checkedOptionIndices: [], customMenuIndex: null,
    // Partial review offers recovery through the question chips, never an accidental Submit.
    // Its only answer is cancellation via Escape, independent of the native highlighted row.
    rejectWithEscapeIndex: missing.length ? 0 : null,
  }, { call: expected?.id });
}

export function parsePiAsk(screen: string, expected?: OmoAsk): ParsedPrompt | null {
  const shown = frame(screen);
  return shown ? question(shown, expected) ?? review(shown, expected) : null;
}

export const readers: readonly DialogReader[] = ["pi-ask-question", "pi-ask-submit"].map(id => ({
  id, agents: ["pi"], priority: 85, reread: "before-commit", list: "none",
  parse: (screen: string) => {
    const parsed = parsePiAsk(screen);
    return parsed?.responder === id ? parsed : null;
  },
}));
