/** One option of a permission request, as the agent offered it. */
export interface AcpOption {
  optionId: string;
  name: string;
  kind: string;
}

/** A `session/request_permission` the agent asked and nobody answered yet. */
export interface AcpApproval {
  /** the keeper's id for it (`agent-N`), which an answer names */
  keeperId: string;
  seq: number;
  /** the request as the keeper archived it */
  raw: string;
  sessionId: string | null;
  toolCall: { title: string | null; kind: string | null; rawInput: unknown; content: unknown };
  options: AcpOption[];
}

/** The last `session/prompt` any client sent: running until the agent answers it. */
export interface AcpTurn {
  running: boolean;
  stopReason: string | null;
  /** the turn's `agent_message_chunk` text */
  text: string;
  /** the agent's error, when it answered the prompt with one */
  error: string | null;
}

export type Row = { seq: number; dir: string; ts?: number; client?: number; raw: string };
export type Message = { id?: unknown; method?: unknown; params?: Record<string, unknown>; result?: Record<string, unknown>; error?: { code?: unknown; message?: unknown } };

export const record = (value: unknown): Record<string, unknown> | null => typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
export const text = (value: unknown): string | null => typeof value === "string" ? value : null;

function parseOptions(value: unknown): AcpOption[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const option = record(entry);
    const [optionId, name, kind] = [text(option?.["optionId"]), text(option?.["name"]), text(option?.["kind"])];
    return optionId !== null && name !== null && kind !== null ? [{ optionId, name, kind }] : [];
  });
}

function validMessage(body: Record<string, unknown>): boolean {
  if ("method" in body && typeof body.method !== "string") return false;
  if (body.method !== "session/update") return true;
  const update = record(record(body.params)?.update);
  if (!update || typeof update.sessionUpdate !== "string") return false;
  const nullable = update.sessionUpdate === "tool_call_update";
  if (["kind", "status"].some(key => key in update && !(nullable && update[key] === null) && typeof update[key] !== "string")) return false;
  const blocks = Array.isArray(update.content) ? update.content : [update.content];
  return blocks.every(value => {
    const block = record(value);
    return !block || !("type" in block) || typeof block.type === "string";
  });
}

export function parseLine(line: string): { client: number } | { row: Row; message: Message | null } | null {
  let parsed: unknown;
  try { parsed = JSON.parse(line); } catch { return null; }
  const object = record(parsed);
  if (object === null) return null;
  if (typeof object["through"] === "number" && typeof object["client"] === "number") return { client: object["client"] };
  const { seq, dir, raw } = object;
  if (typeof seq !== "number" || typeof dir !== "string" || typeof raw !== "string") return null;
  let body: Record<string, unknown> | null = null;
  try { body = record(JSON.parse(raw)); } catch (error) { if (!(error instanceof SyntaxError)) throw error; }
  return { row: { seq, dir, raw, ...(typeof object["ts"] === "number" ? { ts: object["ts"] } : {}), ...(typeof object["client"] === "number" ? { client: object["client"] } : {}) }, message: body && validMessage(body) ? body : null };
}

/** What the agent announced for a tool call earlier in the session. */
export interface AnnouncedToolCall { readonly kind: unknown; readonly rawInput: unknown; readonly content: unknown }

/**
 * A permission request's tool call is an update to the one the agent announced (ACP), so what the request leaves out
 * is read from that announcement: Kiro CLI 3.6 names only a title ("Write File") and leaves the path to the tool call.
 */
export function approval(row: Row, keeperId: string, params: Record<string, unknown>, announced?: AnnouncedToolCall): AcpApproval {
  const toolCall = record(params["toolCall"]) ?? {};
  return {
    keeperId, seq: row.seq, raw: row.raw, sessionId: text(params["sessionId"]),
    toolCall: { title: text(toolCall["title"]), kind: text(toolCall["kind"] ?? announced?.kind), rawInput: toolCall["rawInput"] ?? announced?.rawInput ?? null, content: toolCall["content"] ?? announced?.content ?? null },
    options: parseOptions(params["options"]),
  };
}

export class KeeperRequestError extends Error {
  constructor(readonly code: number, message: string) {
    super(message);
    this.name = "KeeperRequestError";
  }
}

export class KeeperDisconnected extends Error {
  constructor() {
    super("the connection to the ACP keeper ended");
    this.name = "KeeperDisconnected";
  }
}
