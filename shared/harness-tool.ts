import schema from "./harness-contract.schema.json";

export const TOOL_SCHEMAS = schema.tools;
export const HARNESS_CONTRACT = "ovis-harness/0";
export const harnessStopReason = (value: string): string => schema.$defs.TurnResult.properties.stop_reason.enum.includes(value) ? value : "unknown";
export type HarnessVerb = keyof typeof TOOL_SCHEMAS;
export const VIEW_VERBS = ["machines", "harnesses", "ls", "read"] as const;
export const HARNESS_LIMITS = { child_minutes: 60, calls_per_minute: 30, wait_seconds: 45 } as const;

export interface HarnessToolSetting {
  readonly level: "off" | "view" | "start";
  readonly depth: 1 | 2 | 3;
  readonly harnesses: readonly string[];
}
/** What a parent that cannot prove its permission ceiling may start, at the one version each has an ask-every-time launch for (server/agent-tools/permission-launch.ts, hub.ts's version check). */
export const ASK_EVERY_TIME_HARNESSES: Readonly<Record<string, string>> = { claude: "2.1.330", codex: "0.171.0", copilot: "1.0.109", opencode: "2.2.2", agy: "1.5.16" };
/** Of those, the ones whose own allow rules (the person's, or a project folder's) still let an action through unasked. */
export const OWN_RULES_HARNESSES: readonly string[] = ["codex", "copilot", "agy"];
/** Of those, the ones whose built-in web search runs unasked in every launch. */
export const UNASKED_SEARCH_HARNESSES: readonly string[] = ["agy"];
/** Harness kinds with an ACP launch in server/agent-tools/harnesses.ts (resolveHarness). */
export const ACP_LAUNCH_HARNESSES = ["claude", "codex", "copilot", "opencode", "agy", "gjc"] as const;
export const HARNESS_TOOL_DEFAULT: HarnessToolSetting = { level: "start", depth: 1, harnesses: ACP_LAUNCH_HARNESSES };
export const HARNESS_TOOL_OFF: HarnessToolSetting = { level: "off", depth: 1, harnesses: [] };
export function parseHarnessSetting(stored: unknown): HarnessToolSetting | null {
  if (!isRecord(stored) || !Object.keys(stored).every(k => ["level","depth","harnesses"].includes(k))) return null;
  const { level, depth, harnesses } = stored;
  if (level === "off" && depth === undefined && harnesses === undefined) return HARNESS_TOOL_OFF;
  if (!(level === "view" || level === "start" || level === "off") || !(depth === 1 || depth === 2 || depth === 3)
    || !Array.isArray(harnesses) || !harnesses.every((id): id is string => typeof id === "string" && /^[a-z][a-z0-9-]*$/.test(id))) return null;
  return { level, depth, harnesses: [...new Set(harnesses)] };
}
export function harnessToolSetting(stored: unknown): HarnessToolSetting {
  return stored === undefined ? HARNESS_TOOL_DEFAULT : parseHarnessSetting(stored) ?? HARNESS_TOOL_OFF;
}
export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
export const harnessVerb = (value: unknown): value is HarnessVerb => typeof value === "string" && Object.hasOwn(TOOL_SCHEMAS, value);
export const isView = (verb: HarnessVerb) => VIEW_VERBS.some(v => v === verb);
export const answer = <K extends string, B extends object>(kind: K, body: B) => ({ contract: HARNESS_CONTRACT, kind, ...body });
export const refuse = (code: string, message: string) => answer("refusal", { error: { code, message } });

/** Panes hc started that asked for the agent tool (`agent-tool-panes`, GET /api/agent-tools/panes): this PC's owner only. */
export interface AgentToolPane { readonly id: string; readonly pane: string; readonly label: string }
export interface AgentToolPanes { readonly pending: readonly AgentToolPane[]; readonly allowed: readonly AgentToolPane[] }
