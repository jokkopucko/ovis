import type { AgentInstallState } from "./agent-catalog.ts";

/**
 * Display names for every agent in shared/agent-catalog.ts, kept separate so UI code that only
 * formats an agent name does not pull the 52 KB install catalog into the initial browser bundle.
 */
export const AGENT_DISPLAY_NAMES: Readonly<Record<string, string>> = {
  claude: "Claude Code",
  codex: "Codex",
  copilot: "GitHub Copilot",
  opencode: "OpenCode",
  devin: "Devin CLI",
  grok: "Grok Build",
  agy: "Antigravity",
  gemini: "Gemini CLI",
  kiro: "Kiro CLI",
  kimi: "Kimi Code",
  qwen: "Qwen Code",
  omp: "Oh My Pi",
  omo: "OmO",
  gjc: "Gajae Code",
  pi: "pi",
  letta: "Letta Code",
  cmd: "Command Code",
  muse: "Muse Code",
  "dsh-tui": "DeepSeek Harness",
  hermes: "Hermes",
};

export function agentDisplayName(kind: string): string {
  return Object.hasOwn(AGENT_DISPLAY_NAMES, kind) ? AGENT_DISPLAY_NAMES[kind]! : kind;
}

export function agentRuns(state: AgentInstallState): boolean {
  return state.installed === true && state.version_error !== "failed" && state.version_error !== "timeout";
}
