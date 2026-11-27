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
/** Harness kinds with an ACP launch in server/agent-tools/harnesses.ts (resolveHarness). */
export const ACP_LAUNCH_HARNESSES = ["claude", "codex", "copilot", "opencode", "agy", "gjc", "gemini", "kiro", "kimi", "qwen"] as const;
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
