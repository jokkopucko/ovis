import type { HerdrPane } from "../shared/protocol.ts";
import { omoTranscriptForPane } from "./omo.ts";
import { OmoAskReader, omoAsksAfter, type OmoAskCall, type OmoAsks } from "./omo-ask.ts";
import type { OmoAsk } from "./dialogs/shared.ts";

/**
 * The key OmO files the answer to the call's question at `index` under (its ask-user schema.js at senpi 2026.11.19-5):
 * `q1`, `q2`, ... for `ask_user_question`, whatever the call says; the call's own snake_case `id` for
 * `request_user_input`. None for a call whose tool is not known.
 */
function answerKey(call: OmoAskCall, question: Record<string, unknown>, index: number): string | undefined {
  if (call.tool === "ask_user_question") return `q${index + 1}`;
  const id = question["id"];
  return call.tool === "request_user_input" && typeof id === "string" && id.trim() !== "" ? id.trim() : undefined;
}

export function omoAskOf(call: OmoAskCall): OmoAsk | null {
  const questions = (call.args as { questions?: unknown } | null | undefined)?.questions;
  if (!Array.isArray(questions) || questions.length === 0) return null;
  const ask: OmoAsk = { id: call.id, questions: [], wait: call.wait };
  for (const [index, question] of (questions as Record<string, unknown>[]).entries()) {
    if (typeof question?.["header"] !== "string" || typeof question["question"] !== "string" || (question["options"] !== undefined && !Array.isArray(question["options"]))) return null;
    const options = ((question["options"] ?? []) as Record<string, unknown>[]).map((option) => ({
      label: typeof option?.["label"] === "string" ? option["label"] : "",
      description: typeof option?.["description"] === "string" && option["description"] ? option["description"] : null,
    }));
    if (options.some((option) => !option.label)) return null;
    const id = answerKey(call, question, index);
    ask.questions.push({ ...(id === undefined ? {} : { id }), header: question["header"], question: question["question"], multiSelect: question["multiSelect"] === true, options });
  }
  return ask;
}

const OMO_ASK_RECORD_RE = /"role":"(?:assistant|toolResult|user)"|ask-user:settlement/;

export function openOmoAsks(jsonl: string): OmoAsk[] {
  let open: OmoAsks = [];
  for (const line of jsonl.split("\n")) {
    if (!OMO_ASK_RECORD_RE.test(line)) continue;
    let entry: unknown;
    try { entry = JSON.parse(line); } catch { continue; }
    if (typeof entry === "object" && entry !== null) open = omoAsksAfter(open, entry);
  }
  return open.flatMap((call) => omoAskOf(call) ?? []).reverse();
}

export function pendingOmoAsk(jsonl: string): OmoAsk | null {
  return openOmoAsks(jsonl)[0] ?? null;
}

export const OMO_FORM_RE = /\b1-9\s+select\b|enter\s+save\s+and\s+next|\btab\s+next\s+question\b|\bor\s+just\s+type\s+your\s+reply\b/;
const omoAskReader = new OmoAskReader();

/** Resolve the live process tree every time: a cached session can outlive its agent. */
export async function omoAsksFor(paneId: string, cwd: string, panes: HerdrPane[]): Promise<OmoAsk[]> {
  const path = await omoTranscriptForPane(paneId, cwd, panes).catch(() => null);
  if (!path) return [];
  try { return omoAskReader.read(path).flatMap((call) => omoAskOf({ ...call, id: `${path}\0${call.id}` }) ?? []).reverse(); }
  catch { return []; }
}
