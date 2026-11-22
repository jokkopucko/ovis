/**
 * The questions an agent asked the user with its question tool, read from the call's recorded
 * arguments: omp's `ask`, OmO's `ask_user_question` (`request_user_input` under a Codex model) and
 * Claude Code's `AskUserQuestion`.
 */

export interface AskedOption {
  label: string;
  description: string | null;
  /** what the option would look like (Claude's and omp's `preview`), shown as written */
  preview: string | null;
}

export interface AskedQuestion {
  header: string | null;
  question: string;
  /** more than one option may be picked */
  multi: boolean;
  /** omp's recommended option, by its index */
  recommended: number | null;
  /** none: the question takes a typed answer */
  options: AskedOption[];
}

const ASK_TOOLS: ReadonlySet<string> = new Set(["ask", "ask_user", "ask_user_question", "request_user_input", "AskUserQuestion", "ask_question"]);
const RECOMMENDED_PREFIX = /^\(recommended\)\s+/i;

const optionalText = (value: unknown): value is string | null | undefined => value == null || typeof value === "string";

/** A question tool's questions, or null for another tool or arguments not in a shape it asks with. */
export function askedQuestions(tool: string, args: unknown): AskedQuestion[] | null {
  if (!ASK_TOOLS.has(tool) || args === null || typeof args !== "object") return null;
  if (tool === "ask_user") {
    const input = args as Record<string, unknown>;
    if (typeof input["question"] !== "string" || !input["question"].trim()) return null;
    const choices = input["choices"];
    if (choices !== undefined && (!Array.isArray(choices) || choices.some((choice) => typeof choice !== "string" || !choice.trim()))) return null;
    return [{
      header: null, question: input["question"], multi: false, recommended: null,
      options: ((choices ?? []) as string[]).map((label) => ({ label, description: null, preview: null })),
    }];
  }
  const questions = (args as Record<string, unknown>)["questions"];
  if (!Array.isArray(questions) || questions.length === 0) return null;
  const asked: AskedQuestion[] = [];
  for (const value of questions) {
    if (value === null || typeof value !== "object") return null;
    const question = value as Record<string, unknown>;
    if (typeof question["question"] !== "string" || !question["question"].trim() || !optionalText(question["header"])) return null;
    const rawOptions = question["options"] ?? [];
    if (!Array.isArray(rawOptions)) return null;
    const options: AskedOption[] = [];
    let recommendedIndex: number | null = null;
    for (const item of rawOptions) {
      if (tool === "ask_question" && typeof item === "string") {
        const label = item.replace(RECOMMENDED_PREFIX, "");
        if (!label.trim()) return null;
        if (label !== item && recommendedIndex === null) recommendedIndex = options.length;
        options.push({ label, description: null, preview: null });
        continue;
      }
      if (item === null || typeof item !== "object") return null;
      const option = item as Record<string, unknown>;
      if (typeof option["label"] !== "string" || !option["label"].trim() || !optionalText(option["description"]) || !optionalText(option["preview"])) return null;
      options.push({ label: option["label"], description: option["description"] || null, preview: option["preview"] || null });
    }
    const recommended = question["recommended"];
    asked.push({
      header: question["header"] || null,
      question: question["question"],
      multi: question["multi"] === true || question["multiSelect"] === true || question["is_multi_select"] === true,
      recommended: Number.isInteger(recommended) && (recommended as number) >= 0 && (recommended as number) < options.length ? recommended as number : recommendedIndex,
      options,
    });
  }
  return asked;
}
