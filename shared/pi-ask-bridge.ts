/**
 * pi-ask answers only through `pi.events` inside the pi process (its docs/remote-events.md: no
 * terminal keystrokes, no network API). The extension, which the user installs with
 * `bun scripts/install-pi-integration.ts`, listens there and serves HTTP on a unix socket that only
 * the user can open: `<pi agent dir>/<PI_ASK_BRIDGE_DIRECTORY>/<pid>.sock`.
 */

export const PI_ASK_BRIDGE_DIRECTORY = "herdr-web-ui-ask";
export const PI_ASK_BRIDGE_VERSION = 1;
export const PI_ASK_SUBMIT_TIMEOUT_MS = 3_000;
/** A unix socket path longer than this does not fit sockaddr_un on macOS (104 bytes, with its NUL). */
export const PI_ASK_SOCKET_PATH_MAX = 100;

/** pi-ask 1.2.0's channels (src/remote-ask.ts). */
export const PI_ASK_EVENTS = {
  started: "@eko24ive/pi-ask:started",
  completed: "@eko24ive/pi-ask:completed",
  submit: "@eko24ive/pi-ask:submit",
  submitResult: "@eko24ive/pi-ask:submit-result",
} as const;

export interface PiAskOption {
  value: string;
  label: string;
  description?: string;
  preview?: string;
  recommended?: boolean;
}

export interface PiAskQuestion {
  id: string;
  label?: string;
  prompt: string;
  type?: "single" | "multi" | "preview";
  required?: boolean;
  options: PiAskOption[];
}

export interface PiAskFlow {
  flowId: string;
  toolCallId?: string;
  source: string;
  title?: string;
  questions: PiAskQuestion[];
  createdAt: number;
}

export interface PiAskBridgeState {
  version: typeof PI_ASK_BRIDGE_VERSION;
  pid: number;
  sessionFile: string | null;
  flows: PiAskFlow[];
  /**
   * The ask_user calls pi-ask still waits on, read from pi's live branch (`getBranch()`): a /tree
   * move changes it without writing to the session file.
   */
  openCalls: string[] | null;
}

/**
 * pi-ask's own rule for an open ask_user call (src/pending-ask.ts in 1.2.0), one session entry at a
 * time: opened by an assistant message that stopped for tool use, closed by its tool result or an
 * `ask:pending-dismissed` record.
 */
export function piAskOpenCalls(open: readonly string[], entry: unknown): string[] {
  if (typeof entry !== "object" || entry === null) return [...open];
  const { type, customType, data, message } = entry as { type?: unknown; customType?: unknown; data?: unknown; message?: unknown };
  const without = (id: unknown): string[] => open.filter((call) => call !== id);
  if (type === "custom") return customType === "ask:pending-dismissed" ? without((data as { toolCallId?: unknown } | null)?.toolCallId) : [...open];
  if (type !== "message" || typeof message !== "object" || message === null) return [...open];
  const { role, toolCallId, stopReason, content } = message as { role?: unknown; toolCallId?: unknown; stopReason?: unknown; content?: unknown };
  if (role === "toolResult") return without(toolCallId);
  if (role !== "assistant" || stopReason !== "toolUse" || !Array.isArray(content)) return [...open];
  const calls = (content as Record<string, unknown>[])
    .filter((part) => part?.["type"] === "toolCall" && part["name"] === "ask_user" && typeof part["id"] === "string")
    .map((part) => part["id"] as string);
  return calls.length ? [...open.filter((call) => !calls.includes(call)), ...calls] : [...open];
}

/** One extension command as `pi.getCommands()` lists it (pi 1.3.0 core/slash-commands.ts). */
export interface PiBridgeCommand {
  /** pi's invocation name, without the slash: `name:2` when two extensions register `name` */
  name: string;
  description?: string;
  /** `sourceInfo.scope`: user, project, temporary (-e) or system */
  scope?: string;
  /** `sourceInfo.origin`: package (an installed pi package) or top-level */
  origin?: string;
}

export interface PiBridgeCommands {
  version: typeof PI_ASK_BRIDGE_VERSION;
  pid: number;
  /** Null when pi could not say: no `getCommands` in this pi, or its extension runtime is not bound. */
  commands: PiBridgeCommand[] | null;
}

export interface PiAskRemoteAnswer {
  values?: string[];
  customText?: string;
}

export type PiAskResponse =
  | { kind: "answer"; mode: "submit"; answers: Record<string, PiAskRemoteAnswer> }
  | { kind: "cancel" };

export interface PiAskSubmitRequest {
  flowId: string;
  /** The form the card was read from: pi-ask reopens a call's form under the same flowId. */
  createdAt: number;
  sessionFile: string;
  response: PiAskResponse;
}

export type PiAskSubmitReply =
  | { ok: true }
  | { ok: false; error: "flow_not_found" | "invalid_request" | "invalid_answer" | "timeout"; message: string };
