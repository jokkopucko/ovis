import type { DialogReader, ReaderContext } from "./registry.ts";
import { pickerPlan } from "./interaction-plan.ts";
import { type InteractivePrompt } from "../../shared/protocol.ts";
import type { NativeSteps } from "./step-navigate.ts";
import { ANSI_RE, onePerPass, type AnswerStep, type CardWords, KEY, type OmoAsk, PI_MODEL_TAIL_RE, type ParsedPrompt, type PromptDraft, SOLID_RULE_RE, cleanLine, englishOf, findLastIndex, finishPrompt, isDivider, own, joinWrapped, keySteps, navigationKeys, normalizeText, piModelRows, screenWidth, wrapped } from "./shared.ts";

// OmO's ask_user_question form (omo 5.1): `Ask user · 30m`, a tab per question then Submit, and
// under them the active question or, on the Submit tab, the review of the answers
const OMO_ASK_TITLE_RE = /^Ask user(?:\s+·.*)?$/;

export const OMO_OPTIONS_HINT_RE = /^↑↓ move\s+1-9 select\s+space (select|toggle)\s+enter (?:next|toggle)\b.*\besc cancel/;

export const OMO_REVIEW_HINT_RE = /^enter (submit|edit answer)\s+↑.*\btab next question\s+esc back/;

export const OMO_TYPING_HINT_RE = /^enter save and next\s+↑↓ back to options\b.*\besc discard/;

const OMO_OWN_ANSWER = "Type your own answer...";

/** the lines a narrow pane wraps the form's key hint onto, at most */
export const OMO_HINT_LINES = 5;

/** lines of OmO's footer under the form's rule, at most: cwd and context, then model (one may wrap) */
export const OMO_FOOTER_LINES = 3;

/** never a line of OmO's footer: an input box (`>`, `❯`) or a shell's prompt */
export const OMO_NOT_FOOTER_RE = /^[>❯›➜λ$%#]|[$%#>❯›λ]$/;

// OmO's widget over its input box for a question that does not wait for its answer (omo 5.1.19)
const OMO_PENDING_STATUS_RE = /^\?\s+(?:Question pending \((\d+) unanswered\)|\d+ questions pending)(?:\s+·.*)?$/;

export const OMO_PENDING_HINT_RE = /^enter(?: or \S+)? to answer · \/answer · or just type your reply\b/;

// between the widget's header and its question: " - " (omo 5.1.48), " — " (omo 5.1.30); the space
// after it is left unconsumed, so separators sharing a space (`Plan - - Choose`) are each found
const OMO_PENDING_SEPARATOR_RE = / [-—](?= )/g;

interface OmoForm {
  /** the line the tab bar ends on (a narrow pane wraps it between tabs) */
  barEnd: number;
  tabs: { label: string; answered: boolean; current: boolean }[];
  /** the Submit tab is the current one: the answers are reviewed */
  reviewing: boolean;
}

/**
 * The head of OmO's form above its hint: the `Ask user` title, then the tab bar, each tab whole
 * on its line (`→` marks the current one, `✓` an answered one) and Submit last:
 *
 *    Ask user · 30m
 *      표시 위치 ✓  → 월 한도    Submit
 */
function omoForm(lines: string[], hintIndex: number): OmoForm | null {
  const titleIndex = findLastIndex(lines.slice(0, hintIndex), (line) => OMO_ASK_TITLE_RE.test(cleanLine(line)));
  if (titleIndex < 0 || hintIndex - titleIndex > 120) return null;
  let barEnd = titleIndex + 1;
  while (barEnd < hintIndex && !/(?:^|\s)(?:→\s)?Submit$/.test(cleanLine(lines[barEnd]!))) barEnd += 1;
  if (barEnd >= hintIndex || barEnd - titleIndex > 12) return null;
  const labels = lines.slice(titleIndex + 1, barEnd + 1).map(cleanLine).filter(Boolean).join("  ").split(/\s{2,}/);
  const submit = labels.pop()!;
  const tabs = labels.map((label) => ({
    label: label.replace(/^→\s+/, "").replace(/\s+✓$/, ""),
    answered: /\s✓$/.test(label),
    current: label.startsWith("→"),
  }));
  const reviewing = submit.startsWith("→");
  if (tabs.length === 0 || tabs.some((tab) => !tab.label) || tabs.filter((tab) => tab.current).length !== (reviewing ? 0 : 1)) return null;
  return { barEnd, tabs, reviewing };
}

/** A tab shows its question's header, cut with an ellipsis when the pane is too narrow for it. */
function sameHeader(tab: string, header: string): boolean {
  const shown = normalizeText(tab);
  const asked = normalizeText(header);
  return shown === asked || (shown.endsWith("…") && asked.startsWith(shown.slice(0, -1).trimEnd()));
}

/** The session's call is the form on screen: as many tabs, each its question's header. */
function askOnScreen(form: OmoForm, ask: OmoAsk): boolean {
  return form.tabs.length === ask.questions.length && form.tabs.every((tab, index) => sameHeader(tab.label, ask.questions[index]!.header));
}

/** The steps for the card, from the tabs on screen, named as asked when the call is known. */
function omoSteps(tabs: OmoForm["tabs"], ask: OmoAsk | null): InteractivePrompt["steps"] {
  return tabs.length > 1 ? tabs.map((tab, index) => ({ ...tab, label: ask?.questions[index]?.header ?? tab.label })) : undefined;
}

/**
 * The card's steps as OmO's own keys move between its tabs, a question left unanswered: Tab on,
 * Shift+Tab back, through Submit (senpi ask-user-question-keys.js, 5.1.51). Only the tab bar on
 * screen says which tab shows, so a form cut off above it gets its steps and nothing to tap; and
 * only the session's call names the form, so a form no call names gets nothing to tap either.
 */
function omoNavigation(form: OmoForm | null, tabs: OmoForm["tabs"], index: number, ask: OmoAsk | null): Pick<PromptDraft, "steps" | "can_step_back" | "can_step_next"> & { nativeSteps?: NativeSteps } {
  const steps = omoSteps(tabs, ask);
  // the form is the call's: a move needs it named, and named by every question and option it asks
  if (!form || !steps || !ask?.id) return { steps };
  const at = form.reviewing ? tabs.length : index;
  return {
    steps: steps.map((step) => step.current ? step : { ...step, can_navigate: true }),
    can_step_back: at > 0,
    can_step_next: !form.reviewing,
    nativeSteps: { identity: JSON.stringify([ask.id, ask.questions.map((question) => [question.header, question.question, question.multiSelect, question.options.map((option) => option.label)])]), index: at, count: tabs.length + 1, next: KEY.tab, previous: KEY.backtab },
  };
}

/** The card's title: where the question stands among several, else its header. */
function omoTitle(tabs: OmoForm["tabs"], index: number, ask: OmoAsk | null): CardWords {
  return tabs.length > 1 ? own("Question {n} of {total}", { n: index + 1, total: tabs.length }) : ask?.questions[index]?.header ?? tabs[index]!.label;
}

/**
 * Keys from omo's cursor to a row of its list. Without a cursor on screen (its row above the
 * visible part) they start from the top: ↑ stops at the first row, so `rows` of them get there.
 */
function omoWalk(to: number, from: number, rows: number): string[] {
  return from >= 0 ? navigationKeys(to - from) : [...navigationKeys(-rows), ...navigationKeys(to)];
}

/** "Submit (1/2 answered)": how many of the form's questions have an answer. */
function omoAnsweredCount(lines: string[], from: number, to: number): number | null {
  const match = /Submit \((\d+)\/\d+ answered\)/.exec(lines.slice(from, to).map(cleanLine).join(" "));
  return match ? Number(match[1]) : null;
}

interface OmoQuestionView {
  /** the question's lines; none when the pane cut them off */
  question: string[];
  /** the options in view: a pane too short for the form shows only the last ones */
  rows: { number: number; label: string[]; description: string[]; selected: boolean }[];
  own: { selected: boolean; lineIndex: number } | null;
}

/**
 * The question, its numbered options (`→` on the highlighted row, `✓` after a chosen one) with
 * descriptions indented under them, and the row for a typed answer, between `start` and `end`:
 *
 *    음성 사용량과 추정 비용을 어디에 보여줄까요?
 *    → 1. 설정 > 음성 입력 (추천)
 *         오늘, 이번 달, 누적의 분·횟수·추정 비용을 보여주고 … 변경 범위가 가장 작습니
 *    다.
 *      2. 설정 + 사이드바 미터
 *      Type your own answer...
 *
 * A wrapped line starts at the pane's edge, so the indent tells rows from descriptions only on a
 * line's first row: lines under an option are its label wrapped until the first indented one,
 * the description, which takes the rest. From the screen's top (`cut`, the form taller than the
 * pane) the first row in view may be any number, and lines above it belong to rows out of view.
 */
function omoQuestionView(lines: string[], start: number, end: number, cut: boolean): OmoQuestionView {
  const view: OmoQuestionView = { question: [], rows: [], own: null };
  for (let index = start; index < end && view.own === null; index += 1) {
    const raw = lines[index]!;
    const line = cleanLine(raw);
    if (!line || isDivider(line)) continue;
    const indent = raw.search(/\S/);
    const selected = line.startsWith("→");
    const text = line.replace(/^→\s+/, "");
    // the row's label, cut by a narrow pane: "Type your own" / "answer..."
    if ((selected || indent >= 2) && /^Type your own\b/.test(text)) {
      view.own = { selected, lineIndex: index };
      continue;
    }
    const row = /^(\d+)\.\s+(.+)$/.exec(text);
    const last = view.rows.at(-1);
    const next = last ? last.number + 1 : cut ? Number(row?.[1]) : 1;
    if (row && Number(row[1]) === next && (selected || (indent >= 2 && indent < 5))) {
      view.rows.push({ number: next, label: [raw], description: [], selected });
      continue;
    }
    if (!last) { if (!cut) view.question.push(raw); }
    else if (last.description.length > 0 || indent >= 5) last.description.push(raw);
    else last.label.push(raw);
  }
  return view;
}

/**
 * A cut-off form that more than one question of a call fits: it names none of them, and it counts against every
 * other open call it might be, instead of leaving the only other call that fits to take it (#2092).
 */
const AMBIGUOUS = "ambiguous" as const;

/**
 * The question of the session's call a cut-off form shows: the one whose options end with the
 * rows in view, each matched by its first line (which the pane may cut), and that the rest of the
 * screen can show (`shows`). Unique, -1 for none, or AMBIGUOUS when several fit.
 */
function askedQuestion(view: OmoQuestionView, ask: OmoAsk, shows: (index: number) => boolean = () => true): number | typeof AMBIGUOUS {
  const start = (raw: string): string => comparable(cleanLine(raw).replace(/^(?:→\s+)?\d+\.\s+/, "").replace(/\s+✓$/, ""));
  const last = view.rows.at(-1)?.number;
  const matches = ask.questions.flatMap((question, index) => question.options.length === last
    && view.rows.every((row) => comparable(question.options[row.number - 1]!.label).startsWith(start(row.label[0]!))) && shows(index) ? [index] : []);
  return matches.length > 1 ? AMBIGUOUS : matches[0] ?? -1;
}

/**
 * Where the form stands when its tabs are out of view: the question asked now, answered ones
 * before it when the count says so (answered in order, as the card does), none after it.
 */
function cutSteps(ask: OmoAsk, current: number, currentAnswered: boolean, answeredCount: number | null): OmoForm["tabs"] {
  const inOrder = answeredCount !== null && answeredCount - (currentAnswered ? 1 : 0) === current;
  return ask.questions.map((question, index) => ({
    label: question.header,
    answered: index === current ? currentAnswered : inOrder && index < current,
    current: index === current,
  }));
}

/**
 * OmO's form on a question: the tab bar (`→ 표시 위치    월 한도    Submit`) over the question view,
 * then `Submit (0/2 answered) — Enter advances` and the key hint:
 *
 *    ↑↓ move  1-9 select  space select  enter next  tab next question  c comment  esc cancel
 *
 * The question and options read from the session's call when it shows; from the screen
 * otherwise, which then needs the whole form in view. Navigate to an option and confirm it;
 * in a multiple choice, clear the previous answer (Backspace), navigate and toggle each choice
 * with Space, then move on with Tab.
 */
function parseOmoQuestion(screen: string, ask: OmoAsk | null, trusted: boolean): ParsedPrompt | null | typeof AMBIGUOUS {
  const lines = screen.replace(ANSI_RE, "").split(/\r?\n/);
  const hintIndex = findLastIndex(lines, (_, index) => OMO_OPTIONS_HINT_RE.test(wrapped(lines, index, OMO_HINT_LINES)));
  if (hintIndex < 0) return null;
  const form = omoForm(lines, hintIndex);
  if (form?.reviewing || (!form && !ask)) return null;
  const known = ask && (!form || askOnScreen(form, ask)) ? ask : null;
  if (!trusted && !known) return null;
  const view = omoQuestionView(lines, form ? form.barEnd + 1 : 0, hintIndex, !form);
  if (view.own === null || (view.rows.length === 0 && !known)) return null;
  const multiSelect = OMO_OPTIONS_HINT_RE.exec(wrapped(lines, hintIndex, OMO_HINT_LINES))![1] === "toggle";
  const width = screenWidth(lines);
  const shownLabels = view.rows.map((row) => joinWrapped(row.label, width, /^(?:→\s+)?\d+\.\s+/));
  const currentAnswered = shownLabels.some((label) => /\s✓$/.test(label)) || /^(?:→\s+)?Type your own answer\.\.\.:/.test(cleanLine(lines[view.own.lineIndex]!));
  let index: number;
  let tabs: OmoForm["tabs"];
  let question: string;
  let options: InteractivePrompt["options"];
  if (known) {
    // the screen must show this question's rows, numbered to its last option: only a question it can show makes a
    // cut-off form ambiguous (#2092)
    const shows = (asked: OmoAsk["questions"][number]): boolean => asked.multiSelect === multiSelect
      && (view.rows.at(-1)?.number ?? 0) === asked.options.length
      && (view.question.length === 0 || sameText(joinWrapped(view.question, width), asked.question))
      && view.rows.every((row, at) => sameText(shownLabels[at]!.replace(/\s+✓$/, ""), asked.options[row.number - 1]!.label));
    const fit = form ? form.tabs.findIndex((tab) => tab.current) : askedQuestion(view, known, (at) => shows(known.questions[at]!));
    if (fit === AMBIGUOUS) return AMBIGUOUS;
    index = fit;
    if (index < 0) return null;
    const asked = known.questions[index]!;
    if (!shows(asked)) return null;
    tabs = form ? form.tabs : cutSteps(known, index, currentAnswered, omoAnsweredCount(lines, view.own.lineIndex, hintIndex));
    question = normalizeText(asked.question);
    options = asked.options.map((option) => ({ label: normalizeText(option.label), description: option.description && normalizeText(option.description) }));
  } else {
    if (!form || view.question.length === 0 || view.rows[0]!.number !== 1) return null;
    index = form.tabs.findIndex((tab) => tab.current);
    tabs = form.tabs;
    question = joinWrapped(view.question, width);
    options = shownLabels.map((label, row) => ({
      label: label.replace(/\s+✓$/, ""),
      description: view.rows[row]!.description.length > 0 ? joinWrapped(view.rows[row]!.description, width) : null,
    }));
  }
  const highlighted = view.rows.find((row) => row.selected);
  // the cursor, when its row is in view: on an option, or on the typed answer's row
  const selectedIndex = view.own.selected ? options.length : highlighted ? highlighted.number - 1 : -1;
  const rows = options.length + 1;
  const pick = (option: number): AnswerStep[] => keySteps([...omoWalk(option, selectedIndex, rows), KEY.enter]);
  const { nativeSteps, ...navigation } = omoNavigation(form, tabs, index, known);
  return finishPrompt("omo", {
    // several questions: the card's steps name them, the title says where this one stands
    kind: "question", title: omoTitle(tabs, index, known),
    question, body: null, options, multi_select: multiSelect, custom_option_index: multiSelect ? null : options.length,
    ...navigation,
  }, {
    omoQuestion: known?.id ? { call: known.id, index } : undefined,
    ...(nativeSteps ? { nativeSteps } : {}),
    responder: "omo-question", menuLabels: [...options.map((option) => option.label), OMO_OWN_ANSWER], selectedIndex,
    checkedOptionIndices: view.rows.flatMap((row, at) => /\s✓$/.test(shownLabels[at]!) ? [row.number - 1] : []),
    customMenuIndex: options.length, rejectWithEscapeIndex: null,
    optionSteps: options.map((_, option) => pick(option)),
    // what was typed before stays in the row: a Backspace on the options clears the answer first
    customSteps: (text) => [...keySteps([KEY.backspace, ...omoWalk(options.length, selectedIndex, rows), KEY.enter]), { text }, ...keySteps([KEY.enter])],
    multiSteps: (choices) => {
      let at = selectedIndex;
      const steps = keySteps([KEY.backspace]);
      for (const option of [...choices].sort((a, b) => a - b)) {
        steps.push(...keySteps([...omoWalk(option, at, rows), KEY.space]));
        at = option;
      }
      return [...steps, ...keySteps([KEY.tab])];
    },
  }, { call: known?.id });
}

/**
 * OmO's form while an answer is typed in the terminal (the typed answer's row opened):
 *
 *    Your answer (enter to save, ↑↓ back to options, esc to discard)
 *    > 안녕
 *    Submit (0/2 answered) — Enter advances
 *    enter save and next  ↑↓ back to options  tab next question  esc discard
 *
 * The card offers to save what is typed (Enter, which moves on as an answer does) or to discard it.
 */
function parseOmoTyping(screen: string, ask: OmoAsk | null, trusted: boolean): ParsedPrompt | null | typeof AMBIGUOUS {
  const lines = screen.replace(ANSI_RE, "").split(/\r?\n/);
  const hintIndex = findLastIndex(lines, (_, index) => OMO_TYPING_HINT_RE.test(wrapped(lines, index, OMO_HINT_LINES)));
  if (hintIndex < 0) return null;
  const form = omoForm(lines, hintIndex);
  if (form?.reviewing || (!form && !ask)) return null;
  const known = ask && (!form || askOnScreen(form, ask)) ? ask : null;
  if (!trusted && !known) return null;
  const label = findLastIndex(lines.slice(0, hintIndex), (line) => /^Your answer \(/.test(cleanLine(line)));
  const field = findLastIndex(lines.slice(0, hintIndex), (line, index) => index > label && /^>/.test(cleanLine(line)));
  if (label < 0 || field < 0) return null;
  const typed = cleanLine(lines[field]!).replace(/^>\s?/, "").trim();
  const view = omoQuestionView(lines, form ? form.barEnd + 1 : 0, label, !form);
  let index: number;
  let tabs: OmoForm["tabs"];
  let question: string;
  if (known) {
    // as parseOmoQuestion matches it, but for the choice mode, which the typing hint does not show: only a question
    // whose whole labels are the rows in view makes the cut-off form ambiguous (#2092)
    const width = screenWidth(lines);
    const shownLabels = view.rows.map((row) => joinWrapped(row.label, width, /^(?:\u2192\s+)?\d+\.\s+/).replace(/\s+\u2713$/, ""));
    const shows = (at: number): boolean => {
      const asked = known.questions[at]!;
      return (view.question.length === 0 || sameText(joinWrapped(view.question, width), asked.question))
        && view.rows.every((row, rowAt) => sameText(shownLabels[rowAt]!, asked.options[row.number - 1]!.label));
    };
    const fit = form ? form.tabs.findIndex((tab) => tab.current) : view.rows.length > 0 ? askedQuestion(view, known, shows) : -1;
    if (fit === AMBIGUOUS) return AMBIGUOUS;
    index = fit;
    if (index < 0) return null;
    tabs = form ? form.tabs : cutSteps(known, index, false, null);
    question = normalizeText(known.questions[index]!.question);
  } else {
    if (!form || view.question.length === 0) return null;
    index = form.tabs.findIndex((tab) => tab.current);
    tabs = form.tabs;
    question = joinWrapped(view.question, screenWidth(lines));
  }
  const choices: { label: CardWords; description: string | null; steps: AnswerStep[] }[] = [
    { label: own("Save the typed answer"), description: typed || null, steps: keySteps([KEY.enter]) },
    { label: own("Discard it"), description: null, steps: keySteps([KEY.escape]) },
  ];
  return finishPrompt("omo", {
    // a menu: a number typed in the chat acts on the terminal's input, so it waits for Confirm
    kind: "menu", title: omoTitle(tabs, index, known), question, body: null,
    options: choices.map((choice) => ({ label: choice.label, description: choice.description })),
    multi_select: false, custom_option_index: null, steps: omoSteps(tabs, known),
  }, {
    responder: "omo-typing", menuLabels: choices.map((choice) => englishOf(choice.label)), selectedIndex: -1,
    checkedOptionIndices: [], customMenuIndex: null, rejectWithEscapeIndex: null,
    optionSteps: choices.map((choice) => choice.steps),
  }, { call: known?.id });
}

/**
 * OmO's form on its Submit tab, after the last question or a Tab past it: a row per question
 * with its answer, then a comment field, which has the cursor until ↑ moves it onto a row:
 *
 *    Review your answers
 *      표시 위치: 설정 > 음성 입력 (추천)
 *    → 월 한도: 월 $5 한도
 *
 *    Comment (optional; unanswered questions are reported)
 *    >
 *    Submit (2/2 answered)
 *    enter edit answer  ↑↓ move  tab next question  esc back
 *
 * Enter on the comment submits the form (with the comment, when one is typed); on a row it opens
 * that question again. The card offers Submit, each row to change its answer, and the comment.
 * With the tabs out of view, the session's call names the rows; a row above the screen's top
 * then shows by its question's header alone.
 */
function parseOmoReview(screen: string, ask: OmoAsk | null, trusted: boolean): ParsedPrompt | null {
  const lines = screen.replace(ANSI_RE, "").split(/\r?\n/);
  const hintIndex = findLastIndex(lines, (_, index) => OMO_REVIEW_HINT_RE.test(wrapped(lines, index, OMO_HINT_LINES)));
  if (hintIndex < 0) return null;
  const form = omoForm(lines, hintIndex);
  if ((form && !form.reviewing) || (!form && !ask)) return null;
  const known = ask && (!form || askOnScreen(form, ask)) ? ask : null;
  if (!trusted && !known) return null;
  const heading = findLastIndex(lines.slice(0, hintIndex), (line, index) => index > (form?.barEnd ?? -1) && cleanLine(line) === "Review your answers");
  if (heading < 0 && form) return null;
  const rows: { text: string[]; selected: boolean }[] = [];
  let index = heading + 1;
  for (; index < hintIndex; index += 1) {
    const raw = lines[index]!;
    const line = cleanLine(raw);
    // the comment field's label, or with that cut off the field itself
    if (line.startsWith("Comment (") || line.startsWith(">")) break;
    if (!line) { if (heading >= 0 || rows.length > 0) break; continue; }
    const selected = line.startsWith("→");
    if (selected || raw.search(/\S/) >= 2) rows.push({ text: [raw], selected });
    else if (rows.length > 0) rows.at(-1)!.text.push(raw);
  }
  const width = screenWidth(lines);
  const shown = rows.map((row) => ({ label: joinWrapped(row.text, width, /^→\s+/), selected: row.selected }));
  const count = known ? known.questions.length : form!.tabs.length;
  // each question's row: by its header when the call is known (rows above the screen's top are
  // out of view), else in order, all of them
  const rowOf = known
    ? known.questions.map((question) => shown.find((row) => row.label.startsWith(`${normalizeText(question.header)}:`)))
    : shown.length === count ? shown : null;
  if (!rowOf) return null;
  const rest = lines.slice(index, hintIndex).filter((line) => cleanLine(line) && !isDivider(line));
  // the field's label (a narrow pane wraps it), the field (`>` and what is typed there), then
  // a notice (`! …`) and the Submit line, both wrapped as well
  const field = rest.findIndex((line) => cleanLine(line).startsWith(">"));
  if (field < 0) return null;
  const commentLabel = joinWrapped(rest.slice(0, field), width) || own("Comment");
  const comment = cleanLine(rest[field]!).replace(/^>\s?/, "").trim();
  const after = joinWrapped(rest.slice(field + 1), width);
  const submitAt = after.search(/Submit \(\d+\/\d+ answered\)/);
  const notice = (submitAt < 0 ? after : after.slice(0, submitAt)).replace(/^!\s*/, "").trim();
  const answeredCount = omoAnsweredCount(lines, index, hintIndex);
  // the cursor: on the comment (the row after the answers), on the answer it marks, or out of view
  const onComment = OMO_REVIEW_HINT_RE.exec(wrapped(lines, hintIndex, OMO_HINT_LINES))![1] === "submit";
  const selectedIndex = onComment ? count : rowOf.findIndex((row) => row?.selected);
  const labels = rowOf.map((row, at) => row?.label ?? normalizeText(known!.questions[at]!.header));
  const tabs = form ? form.tabs : known!.questions.map((question, at) => ({
    label: question.header,
    answered: rowOf[at] ? !/:\s*unanswered$/.test(rowOf[at]!.label) : answeredCount === count,
    current: false,
  }));
  const choices: { label: CardWords; steps: AnswerStep[] }[] = [
    { label: own("Submit"), steps: keySteps([...omoWalk(count, selectedIndex, count + 1), KEY.enter]) },
    ...labels.map((label, row) => ({ label, steps: keySteps([...omoWalk(row, selectedIndex, count + 1), KEY.enter]) })),
  ];
  const { nativeSteps, ...navigation } = omoNavigation(form, tabs, count, known);
  return finishPrompt("omo", {
    // a menu: a number typed in the chat submits the whole form, so it waits for Confirm
    kind: "menu", title: own("Review your answers"), question: submitAt < 0 ? own("Submit your answers?") : after.slice(submitAt),
    // the notice and the comment are omo's and the user's own words, the label before the comment the bridge's
    body: comment ? (notice ? own("{notice}\nComment: {comment}", { notice, comment }) : own("Comment: {comment}", { comment })) : notice || null,
    options: [...choices.map(({ label }) => ({ label, description: null })), { label: commentLabel, description: null }],
    multi_select: false, custom_option_index: choices.length, ...navigation,
  }, {
    ...(nativeSteps ? { nativeSteps } : {}),
    responder: "omo-review", menuLabels: [...labels, englishOf(commentLabel)], selectedIndex,
    checkedOptionIndices: [], customMenuIndex: count, rejectWithEscapeIndex: null,
    optionSteps: [...choices.map(({ steps }) => steps), []],
    customSteps: (text) => [...keySteps(omoWalk(count, selectedIndex, count + 1)), { text }, ...keySteps([KEY.enter])],
  }, { call: known?.id });
}

/**
 * OmO's widget over its input box for a question asked without waiting for the answer (omo
 * 5.1.19): OmO goes on working, or ends its turn, and the question stays open until answered:
 *
 *    ? Question pending (2 unanswered) · 30m          (`? 2 questions pending · 30m` for several calls)
 *      표시 위치 - 음성 사용량과 추정 비용을 어디에 보여줄까요?     (`—` before omo 5.1.48)
 *    [ 설정 > 음성 입력 (추천) ]  [ 설정 + 사이드바 미터 ]  [ own answer… ]
 *    +1 more question
 *    enter to answer · /answer · or just type your reply
 *
 * It shows the first unanswered question of one call, by its header; the session's open calls
 * that do not wait name it, and the card is only for one of them. The answer route opens the
 * form with Alt+Up, verifies the call and question again, then uses the form's navigation.
 * No answer text is sent to the composer, even when whitespace makes its draft look empty.
 */
function parseOmoPending(screen: string, pending: readonly OmoAsk[]): ParsedPrompt | null {
  const lines = screen.replace(ANSI_RE, "").split(/\r?\n/);
  const hintIndex = findLastIndex(lines, (_, index) => OMO_PENDING_HINT_RE.test(wrapped(lines, index)));
  if (hintIndex < 0) return null;
  const statusIndex = findLastIndex(lines.slice(0, hintIndex), (line) => OMO_PENDING_STATUS_RE.test(cleanLine(line)));
  if (statusIndex < 0 || hintIndex - statusIndex > 12) return null;
  const unanswered = OMO_PENDING_STATUS_RE.exec(cleanLine(lines[statusIndex]!))![1];
  const line = cleanLine(lines[statusIndex + 1] ?? "");
  // a header may hold the separator itself, so each place it occurs is a split to try; the line
  // is cut at the pane's edge. A split with nothing after it still counts against the others:
  // the cut may have left only that question's header, so a question it fits makes the line
  // ambiguous. It never names a question on its own.
  const splits = [...line.matchAll(OMO_PENDING_SEPARATOR_RE)].map((separator) => ({
    header: line.slice(0, separator.index),
    start: comparable(line.slice(separator.index + separator[0].length + 1).replace(/(?:…|\.\.\.)$/, "")),
  }));
  // A line cut at the pane's edge may have lost the separator itself, or its space: every question
  // whose header and text begin with what is shown is a candidate too, so it can only make the
  // line ambiguous.
  const cut = /(?:\u2026|\.\.\.)$/.test(line);
  const shown = comparable(line.replace(/(?:\u2026|\.\.\.)$/, ""));
  const matches = pending.filter((ask) => ask.wait === false).flatMap((ask) => ask.questions.flatMap((question, index) => {
    const fits = splits.filter((split) => sameHeader(split.header, question.header) && comparable(question.question).startsWith(split.start));
    const fitsCut = cut && comparable(question.header + question.question).startsWith(shown);
    return fits.length > 0 || fitsCut ? [{ ask, index, named: fits.some((split) => split.start !== "") }] : [];
  }));
  if (matches.length !== 1 || !matches[0]!.named) return null;
  const { ask, index } = matches[0]!;
  const asked = ask.questions[index]!;
  const tabs = cutSteps(ask, index, false, unanswered === undefined ? null : ask.questions.length - Number(unanswered));
  const options = asked.options.map((option) => ({ label: normalizeText(option.label), description: option.description && normalizeText(option.description) }));
  return finishPrompt("omo", {
    kind: "question", title: omoTitle(tabs, index, ask), question: normalizeText(asked.question), body: null,
    options, multi_select: asked.multiSelect, custom_option_index: asked.multiSelect ? null : options.length,
    steps: omoSteps(tabs, ask),
  }, {
    omoQuestion: ask.id ? { call: ask.id, index } : undefined,
    responder: "omo-pending", menuLabels: [...options.map((option) => option.label), "Type your reply"], selectedIndex: -1,
    checkedOptionIndices: [], customMenuIndex: asked.multiSelect ? null : options.length, rejectWithEscapeIndex: null,
    // Validation only here: execution requires the opened form and its freshly read cursor.
    optionSteps: options.map(() => []),
    customSteps: () => [],
    multiSteps: () => [],
  }, { call: ask.id });
}

/**
 * OmO's `/model` (omo 5.1.30 and 5.1.32, engine senpi): pi's model selector as OmO draws it,
 * fullscreen or not. Its keys stand over the filter line instead of under the catalogue —
 *
 *   enter select  ctrl+s select as default  ctrl+f favorite
 *   > gpt
 *   →   gpt-5.5 [chatgpt-subscription]
 *       gpt-6-sol [chatgpt-subscription]
 *     … 14 more below
 *     Model Name: GPT-5.5
 *
 * — it ticks the model in use after its name (`claude-opus-4-8 [anthropic] ✓`), and it counts the
 * rows below the window instead of numbering them. The rows are pi's catalogue rows
 * (piModelRows): a narrow pane drops the provider's bracket onto a line of its own, and it is
 * joined back the same way. herdr names the pane `omo`, or `pi`, `claude` or nothing at times
 * (parsePrompt), so the hint, which no other program draws, is what tells the list apart.
 */
const OMO_MODEL_HINT_RE = /^enter select\s+ctrl\+s select as default\s+ctrl\+f favorite$/i;

/** the filter line right under the hint: what was typed to narrow the catalogue, if anything */
const OMO_MODEL_FILTER_RE = /^[\u203a>\u276f](?:\s+(.*))?$/;

/** OmO's notes about its catalogue, which a pane may set at column zero */
const OMO_MODEL_NOTE_RE = /^(?:Could not refresh|Refreshing model catalogs|Model catalogs refreshed)/i;

/** OmO's tick on the model in use, after its name */
const OMO_MODEL_TICK_RE = /\s*[\u2713\u2714]$/;

function omoModelList(lines: string[]): { filterAt: number; rows: { label: string; cursor: boolean; current: boolean }[] } | null {
  // the hint on one line, or wrapped onto a second by a narrow pane
  let hintEnd = -1;
  for (let index = lines.length - 1; index >= 0 && hintEnd < 0; index -= 1) {
    const line = cleanLine(lines[index]!);
    if (!line) continue;
    if (OMO_MODEL_HINT_RE.test(line)) hintEnd = index;
    else if (index + 1 < lines.length && OMO_MODEL_HINT_RE.test(`${line} ${cleanLine(lines[index + 1]!)}`)) hintEnd = index + 1;
  }
  if (hintEnd < 0) return null;
  let filterAt = hintEnd + 1;
  while (filterAt < lines.length && !cleanLine(lines[filterAt]!)) filterAt += 1;
  if (filterAt >= lines.length || !OMO_MODEL_FILTER_RE.test(cleanLine(lines[filterAt]!))) return null;
  // a filter can leave a single model, which is still a list to pick from
  const rows = piModelRows(lines, filterAt + 1, 1);
  if (rows === null) return null;
  return { filterAt, rows: rows.map((row) => ({ ...row, label: row.label.replace(OMO_MODEL_TICK_RE, "") })) };
}

function parseOmoModel(screen: string): ParsedPrompt | null {
  const list = omoModelList(screen.replace(ANSI_RE, "").split(/\r?\n/));
  if (list === null) return null;
  const labels = list.rows.map((row) => row.label);
  const current = list.rows.find((row) => row.current);
  return finishPrompt("omo", {
    kind: "question",
    title: "",
    question: current ? own("Select model (currently {model})", { model: current.label }) : own("Select model"),
    body: null,
    options: labels.map((label) => ({ label, description: null })),
    multi_select: false,
    custom_option_index: null,
  }, {
    responder: "omo-model", menuLabels: labels, selectedIndex: list.rows.findIndex((row) => row.cursor), checkedOptionIndices: [], customMenuIndex: null,
    rejectWithEscapeIndex: null,
  });
}

/**
 * Whether OmO's model list still holds the end of the screen: under its catalogue only OmO's own
 * notes (`… 14 more below`, `Model Name: …`, indented), then one rule and the footer. A list
 * answered or dismissed leaves no hint over a filter line, and one quoted elsewhere has
 * something else under it.
 */
export function omoModelListWaits(screen: string): boolean {
  const lines = screen.replace(ANSI_RE, "").split(/\r?\n/);
  const list = omoModelList(lines);
  if (list === null) return false;
  let rules = 0;
  let footer = 0;
  for (const raw of lines.slice(list.filterAt + 1)) {
    const line = cleanLine(raw);
    if (!line) continue;
    if (SOLID_RULE_RE.test(line)) {
      if (rules > 0 || footer > 0) return false;
      rules = 1;
    } else if (rules === 0) {
      // the catalogue's rows, a wrapped provider tail, or one of OmO's notes under them
      if (!/^\s/.test(raw) && !/^[\u2192\u276f\u279c]/.test(line) && !PI_MODEL_TAIL_RE.test(line) && !OMO_MODEL_NOTE_RE.test(line)) return false;
    } else if (++footer > OMO_FOOTER_LINES || OMO_NOT_FOOTER_RE.test(line)) return false;
  }
  return rules === 1;
}

/** Letters and digits only: a question the pane wraps or punctuates differently still compares equal. */
const comparable = (text: string): string => text.normalize("NFKC").replace(/[^\p{L}\p{N}]/gu, "").toLowerCase();

export function sameText(shown: string, asked: string): boolean {
  const a = comparable(shown);
  const b = comparable(asked);
  // a pane too narrow for a line may cut it with an ellipsis
  return a === b || (/…\s*$/.test(shown) && a.length >= 24 && b.startsWith(a));
}

// herdr names OmO pi while waiting, claude while its SDK child runs, or nothing in a shell.
const agents = ["omo", "pi", "claude", ""] as const;

const forms = onePerPass((screen: string, ctx: ReaderContext): (ParsedPrompt | null)[] => {
  const read = (ask: OmoAsk | null, trusted: boolean) => [parseOmoQuestion(screen, ask, trusted), parseOmoTyping(screen, ask, trusted), parseOmoReview(screen, ask, trusted)];
  if (ctx.omoOpen.length === 0) return read(ctx.omoAsk, ctx.omoTrusted).map((form) => form === AMBIGUOUS ? null : form);
  // the form must be exactly one question of one open call: a call it fits more than one way counts too (#2092)
  const fits = ctx.omoOpen.flatMap((ask) => read(ask, false));
  if (fits.includes(AMBIGUOUS)) return [];
  const matched = fits.filter((form): form is ParsedPrompt => form !== null && form !== AMBIGUOUS);
  return matched.length === 1 ? matched : [];
});

export const readers: readonly DialogReader[] = [
  {
    id: "omo-model", agents: agents, priority: 80,
    reread: "before-commit", list: "none",
    interaction: (parsed) => pickerPlan(parsed, parseOmoModel,
      parsed.options.map((_, index) => keySteps([...navigationKeys(index - parsed.selectedIndex), KEY.enter])),
      (shown, cursor) => shown.options[cursor]?.label),
    parse: (screen) => {
      const parsed = parseOmoModel(screen);
      return parsed?.responder === "omo-model" ? parsed : null;
    },
  },
  {
    id: "omo-question", agents: agents, priority: 100,
    reread: "before-commit", list: "none",
    parse: (screen, ctx) => {
      const parsed = forms(screen, ctx).find((form) => form?.responder === "omo-question") ?? null;
      return parsed?.responder === "omo-question" ? parsed : null;
    },
  },
  {
    id: "omo-typing", agents: agents, priority: 110,
    reread: "none", list: "none",
    parse: (screen, ctx) => {
      const parsed = forms(screen, ctx).find((form) => form?.responder === "omo-typing") ?? null;
      return parsed?.responder === "omo-typing" ? parsed : null;
    },
  },
  {
    id: "omo-review", agents: agents, priority: 120,
    reread: "none", list: "none",
    parse: (screen, ctx) => {
      const parsed = forms(screen, ctx).find((form) => form?.responder === "omo-review") ?? null;
      return parsed?.responder === "omo-review" ? parsed : null;
    },
  },
  {
    id: "omo-pending", agents: agents, priority: 130,
    reread: "none", list: "none",
    parse: (screen, ctx) => {
      const parsed = parseOmoPending(screen, ctx.omoOpen);
      return parsed?.responder === "omo-pending" ? parsed : null;
    },
  },
];
