import type { DialogReader } from "./registry.ts";
import { ANSI_RE, type AnswerStep, KEY, editorRowsMatch, finishPrompt, keySteps, own, type ParsedPrompt, type TypedEditorAnswer } from "./shared.ts";

/**
 * OpenCode v2's questions are forms its service holds (GET /api/session/{id}/form), read for the
 * exact session herdr reports for the pane and answered through POST .../reply (prompt.ts), never
 * from the screen.
 */
export const nativeQuestionReader: DialogReader = {
  id: "opencode-question",
  agents: ["opencode"],
  priority: 0,
  parse: () => null,
  // the reply re-checks the pane's session and the form's revision before it is sent
  reread: "before-commit",
  list: "none",
};

/** the TUI's own text for a typed answer's row (routes/session/question.tsx at v1.2.27) */
const CUSTOM_LABEL = "Type your own answer";
const ROW_RE = /^ *┃(?: {2}(.*))?$/u;
const OPTION_RE = /^(\d+)\. (.+)$/u;
/** a single question's footer: one row wide, or wrapped into a key row and a word row on a narrow pane */
const FOOTER_RE = /^↑↓ select {2}enter submit {2}esc dismiss$/u;
const FOOTER_KEYS_RE = /^↑↓ +enter +esc$/u;
const FOOTER_WORDS_RE = /^select +submit +dismiss$/u;
/** OpenCode 2's form shares the footer under this header; its questions are read natively */
const V2_FORM_HEADER_RE = /^(?:Field \d+ of \d+|Review)(?: · |$)/u;

/**
 * OpenCode 1.x's question prompt (#1386), as recorded from 1.2.27 at 40 and 120 columns (fixtures
 * opencode-question-1.2.27-*): a box drawn with a left border `┃`, holding the question, its numbered
 * options (each with its description indented under it, the last "Type your own answer" when a
 * typed answer is allowed) and the footer, which ends the screen. Only a single question that is not
 * a multiple choice: its footer says `enter submit`, and a digit picks that row and submits it
 * (`pick` in question.tsx), so the answer never depends on where the cursor is (drawn only in color).
 * 1.x keeps no form a service could answer: these keys are the only way.
 */
export function parseOpenCodeV1Question(screen: string): ParsedPrompt | null {
  return readOpenCodeV1Question(screen);
}

function readOpenCodeV1Question(screen: string, answer?: TypedEditorAnswer): ParsedPrompt | null {
  const lines = screen.replace(ANSI_RE, "").split(/\r?\n/u).map((line) => line.trimEnd());
  let end = lines.length - 1;
  while (end >= 0 && (lines[end] === "" || ROW_RE.exec(lines[end]!)?.[1] === undefined && ROW_RE.test(lines[end]!))) end--;
  const row = (index: number): string | undefined => {
    const match = ROW_RE.exec(lines[index] ?? "");
    return match ? match[1] ?? "" : undefined;
  };
  let footer = end;
  if (FOOTER_RE.test(row(end) ?? "")) footer = end;
  else if (FOOTER_WORDS_RE.test(row(end) ?? "") && FOOTER_KEYS_RE.test(row(end - 1) ?? "")) footer = end - 1;
  else return null;
  if (row(footer - 1) !== "") return null;
  let top = footer - 1;
  while (top > 0 && row(top - 1) !== undefined) top--;
  const body = lines.slice(top, footer - 1).map((line) => ROW_RE.exec(line)![1] ?? "");
  if (body.some((text) => V2_FORM_HEADER_RE.test(text))) return null;
  const first = body.findIndex((text) => OPTION_RE.test(text));
  if (first < 2 || body[first - 1] !== "") return null;
  const question = body.slice(0, first - 1).filter(Boolean).join(" ").trim();
  if (!question) return null;
  const options: { label: string; description: string | null }[] = [];
  for (const [index, text] of body.entries()) {
    if (index < first) continue;
    const option = OPTION_RE.exec(text);
    if (option) {
      if (Number(option[1]) !== options.length + 1) return null;
      options.push({ label: option[2]!.trim(), description: null });
      if (answer && options.length - 1 === answer.prompt.customMenuIndex) {
        // the custom row read for a typed answer is its editor, or the answer is not where it was typed
        if (option[2]!.trim() !== CUSTOM_LABEL) return null;
        // The textarea sits below Other, with the description indent. At its six-row limit
        // the visible rows no longer prove the full value; the placeholder isn't a value either.
        const field = body.slice(index + 1);
        if (field.length >= 6 || !field.every((line) => line.startsWith("   ") || line === "")) return null;
        const rows = field.map((line) => line.slice(3));
        if (!editorRowsMatch(rows, answer.text) || editorRowsMatch(rows, CUSTOM_LABEL)) return null;
        break;
      }
    } else if (/^ {3}\S/u.test(text) && options.length > 0) {
      const last = options.at(-1)!;
      last.description = `${last.description ? `${last.description} ` : ""}${text.trim()}`;
    } else if (text !== "") return null;
  }
  // digits reach the first nine rows only
  if (options.length < 2 || options.length > 9) return null;
  const custom = options.at(-1)!.label === CUSTOM_LABEL ? options.length - 1 : null;
  const digit = (index: number): AnswerStep => ({ text: String(index + 1) });
  return finishPrompt("opencode", {
    kind: "question", title: own("Question"), question, body: null, options, multi_select: false, custom_option_index: custom,
  }, {
    responder: "opencode-v1-question",
    menuLabels: options.map((option) => option.label),
    selectedIndex: 0,
    checkedOptionIndices: [],
    customMenuIndex: custom,
    rejectWithEscapeIndex: null,
    optionSteps: options.map((_, index) => [digit(index)]),
    // the custom row's digit opens its text box; Enter there submits the typed answer
    ...(custom !== null ? { customSteps: (text: string) => [digit(custom), { text }, ...keySteps([KEY.enter])] } : {}),
  });
}

export function openCodeV1CustomEditorMatches(screen: string, answer: TypedEditorAnswer): boolean {
  const shown = readOpenCodeV1Question(screen, answer);
  return shown?.id === answer.prompt.id && shown.customMenuIndex === answer.prompt.customMenuIndex;
}

export const openCodeV1QuestionActive = (screen: string): boolean => parseOpenCodeV1Question(screen) !== null;

export const v1QuestionReader: DialogReader = {
  id: "opencode-v1-question",
  agents: ["opencode"],
  priority: 90,
  reread: "none",
  list: "none",
  parse: (screen) => parseOpenCodeV1Question(screen),
};

export const readers: readonly DialogReader[] = [nativeQuestionReader, v1QuestionReader];
