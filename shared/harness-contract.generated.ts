/** Generated from shared/harness-contract.schema.json by bun run generate:types. */

export interface Machine {
  id: string;
  name: string;
  online: boolean;
  reach: "address" | "hc-ssh" | "hc-via" | "local" | "relay" | (string & {});
  versions: {
    hc?: string;
    herdr?: string;
    ovis?: string;
  };
}

export interface Harness {
  capabilities: Capabilities;
  installed: boolean | null;
  kind: string;
  signed_in: boolean | null;
  version: string | null;
}

export interface Capabilities {
  acp_protocol: number | null;
  approvals: ("acp" | "hook" | "keys" | (string & {}))[];
  browser_tool: boolean;
  drive: ("acp" | "terminal" | (string & {}))[];
  images: boolean;
  level: "structured" | "terminal" | (string & {});
  memory_tool: boolean;
  model_switch: "launch" | "none" | "session" | (string & {});
  resume: boolean;
  slash_commands: boolean;
  subagents: boolean;
  tool_delivery: ("mcp" | "shell" | (string & {}))[];
  transcript: "acp" | "file" | "none" | (string & {});
  turn_end: "none" | "strong" | "weak" | (string & {});
  turn_end_from: ("acp" | "hook" | "reader" | "terminal" | (string & {}))[];
}

export interface AuditRecord {
  at: string;
  child: string;
  harness: string;
  machine: string;
  parent: string;
  run: string;
  stop_reason: string | null;
  turn_id: string | null;
  verb: "answer" | "send" | "start" | "stop" | "turn" | (string & {});
}

export interface Screen {
  cols: number;
  rows: number;
  text: Untrusted;
}

export interface TranscriptPage {
  items: SessionUpdate[];
  next: string | null;
}

export interface SessionUpdate {
  text: Untrusted;
  type: "agent_message_chunk" | "agent_thought_chunk" | "plan" | "tool_call" | "user_message_chunk" | (string & {});
}

export interface Refusal {
  error: {
    code: RefusalCode;
    message: string;
  };
}

export type Scope = "send" | "start" | "start_elsewhere" | "view" | (string & {});

export type RefusalCode = "ancestor_target" | "approval_required" | "bad_request" | "busy" | "depth_exceeded" | "not_granted" | "not_owner" | "rate_limited" | "self_target" | "start_failed" | "taken_over" | "time_limit" | "tools_off" | "unavailable" | "unknown_contract" | "unknown_session" | "waiting_human" | (string & {});

export interface Untrusted {
  from: string;
  text: string;
  truncated?: true;
  untrusted: true;
}

export interface SessionRef {
  address: string;
  agent_session_id: string | null;
  drive: "acp" | "terminal" | (string & {});
  harness: string;
  machine: string;
  parent: string | null;
  started_by: "agent" | "human" | (string & {});
  version?: string;
}

export interface SessionState {
  on?: "approval" | "question" | (string & {});
  question?: ChildQuestion;
  state: "done" | "gone" | "idle" | "waiting_human" | "waiting_parent" | "working" | (string & {});
  turn: number | null;
}

export interface ChildQuestion {
  accepts_text: boolean;
  choices: Untrusted[];
  id: string;
  multiple: boolean;
  prompt: Untrusted;
}

export interface SendAccepted {
  accepted: true;
  duplicate: boolean;
  key: string | null;
  turn_id: string;
}

export interface TurnResult {
  answer_from: "acp" | null | "reader" | "terminal" | (string & {});
  end_from: "acp" | "hook" | "reader" | "terminal" | (string & {});
  error: Untrusted | null;
  final_message: Untrusted | null;
  model: string | null;
  stop_reason: "cancelled" | "end_turn" | "gone" | "max_tokens" | "max_turn_requests" | "refusal" | "unknown" | (string & {});
  turn_id: string;
  usage: {
    tokens?: number;
  } | null;
}
