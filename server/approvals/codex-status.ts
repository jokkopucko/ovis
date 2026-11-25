/**
 * What the Codex server of a pane Ovis started (codex.ts) says about the pane's own thread as it runs, read only: how
 * much of its context the last request filled (`thread/tokenUsage/updated`), the model that answers a turn Codex moved
 * to another one (`model/rerouted`), and the questions it waits on (`item/tool/requestUserInput`), each by its request
 * id. The rollout file says the same later; these say it as it happens, and only while Ovis is connected.
 *
 * Measured on 0.171.0 with the real TUI and Ovis as a second client: Ovis gets the token usage and the questions too,
 * and a question still waiting comes again when Ovis subscribes anew. A reroute (only for high-risk cyber activity) was
 * not seen, and is read as the schema has it. Codex 0.171.0 gives its models no `update_plan` tool, so
 * `turn/plan/updated` never came and is not read; nor is `thread/name/updated`, which nothing in Ovis shows.
 */
import type { PaneContext } from "../../shared/protocol.ts";

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);
const count = (value: unknown): number | null => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;

/** How much of its context the last request filled (`last`, not the thread's `total`), as the rollout's token_count says. */
export function tokenContext(params: Json): PaneContext | null {
  const usage = isObject(params["tokenUsage"]) ? params["tokenUsage"] : null;
  const used = usage !== null && isObject(usage["last"]) ? count(usage["last"]["totalTokens"]) : null;
  if (used === null || used === 0) return null;
  return { used, window: count(usage!["modelContextWindow"]) || null };
}

/** One question of a request, as Codex asks it. */
export interface CodexQuestion {
  id: string;
  header: string;
  question: string;
  options: { label: string; description: string }[] | null;
  isOther: boolean;
  isSecret: boolean;
}

/** A question request Codex waits on: `key` is its JSON-RPC id as JSON, the one an answer goes back with. */
export interface CodexAsk {
  key: string;
  threadId: string;
  turnId: string;
  itemId: string;
  questions: CodexQuestion[];
}

/** The questions of an `item/tool/requestUserInput` request, or null for a shape this does not know. */
export function askOf(key: string, params: Json): CodexAsk | null {
  const { threadId, turnId, itemId, questions } = params;
  if (typeof threadId !== "string" || typeof turnId !== "string" || typeof itemId !== "string" || !Array.isArray(questions) || questions.length === 0) return null;
  const read: CodexQuestion[] = [];
  for (const question of questions) {
    if (!isObject(question) || typeof question["id"] !== "string" || typeof question["header"] !== "string" || typeof question["question"] !== "string") return null;
    const options = question["options"];
    if (options != null && !(Array.isArray(options) && options.every((option) => isObject(option) && typeof option["label"] === "string" && typeof option["description"] === "string"))) return null;
    read.push({
      id: question["id"],
      header: question["header"],
      question: question["question"],
      options: Array.isArray(options) ? options.map((option) => ({ label: String(option["label"]), description: String(option["description"]) })) : null,
      isOther: question["isOther"] === true,
      isSecret: question["isSecret"] === true,
    });
  }
  return { key, threadId, turnId, itemId, questions: read };
}

/** What Ovis knows of a pane's own thread from its server; a field is null until the server says it. */
export interface ServedStatus {
  threadId: string;
  context: PaneContext | null;
  /** The model Codex moved the thread's current turn to, while that turn is the last one. */
  model: string | null;
}
