import nodePath from "node:path";
import { AGENT_CATALOG, CATALOG_PLATFORMS, type CatalogPlatform } from "../shared/agent-catalog.ts";
import type { AgentSessionInfo, AgentStatus } from "../shared/herdr-api.generated.ts";

/**
 * Today herdr-core's snapshot names its panes here (herdr's TUI names its own); sessions and status
 * are to follow.
 */
export interface PaneFacts {
  /** the app the program reported itself as (herdr-core's OSC 7501 `app`), in the runtime's words */
  reported?: string | null;
  /** the argv of the process in front of the pane; its name alone when the runtime gives no argv */
  foreground?: readonly string[] | null;
  /** the pid of the process in front, when the runtime tells it (hc's `Foreground.pid`) */
  foregroundPid?: number | null;
  /** how the pane's terminal was started: the argv it was given, and the pid of the process that ran them (hc's `Terminal.pid`) */
  launcher?: { readonly argv: readonly string[]; readonly pid?: number | null } | null;
}

export type ProgramPlatform = CatalogPlatform | "posix" | null;

function candidatesOf(platform: ProgramPlatform): readonly CatalogPlatform[] {
  if (platform === null) return CATALOG_PLATFORMS;
  return platform === "posix" ? ["linux", "macos"] : [platform];
}

const REPORTED_NAMES: Readonly<Record<string, string>> = { "claude-code": "claude", antigravity: "agy", "kimi-code": "kimi", "grok-build": "grok" };

/** The interpreters an agent's script runs under when its install is a script (npm's node bin, a Python entry point). */
const INTERPRETERS = new Set(["node", "bun", "python", "python3"]);

export function programName(word: string): string {
  return nodePath.posix.basename(word.replace(/\\/g, "/")).replace(/\.(?:exe|cmd|js|mjs|cjs)$/i, "");
}

export function reportedAgent(app: string | null | undefined): string | null {
  if (!app) return null;
  return Object.hasOwn(REPORTED_NAMES, app) ? REPORTED_NAMES[app]! : app;
}

/** A path's last part as `platform` names files: on Windows at either slash and in any case, a program without its `.exe` or `.cmd`. */
function fileName(word: string, platform: CatalogPlatform, program: boolean): string {
  // a backslash separates a path on Windows alone: elsewhere it is part of the file's name
  if (platform !== "windows") return nodePath.posix.basename(word);
  const name = nodePath.posix.basename(word.replace(/\\/g, "/")).toLowerCase();
  return program ? name.replace(/\.(?:exe|cmd)$/, "") : name;
}

/** Interpreter options after which the next word is code or a module, not a script file. */
const NOT_A_SCRIPT = new Set(["-e", "--eval", "-p", "--print", "-c", "-m", "-"]);

function scriptOf(argv: readonly string[]): string | null {
  for (const word of argv.slice(1)) {
    if (NOT_A_SCRIPT.has(word) || word === "--") return null;
    if (!word.startsWith("-")) return word;
  }
  return null;
}

/**
 * The catalog agent a foreground process is: one of its detect binaries run directly, or the
 * extensionless script by that name an interpreter runs (npm's bin, a Python entry point), never
 * any `pi.js` that shares a name. A binary whose name proves nothing on `platform` (Windows' own
 * cmd) names none there. `platform` is the one the pane's terminal runs on, not this server's: a
 * Windows terminal started directly as `letta.cmd` (npm's shim) is Letta, as Windows runs
 * `letta` from that shim, while `letta.cmd` on Linux or macOS is a file named so and names none.
 * Where the platform is not known for sure, a name counts only when every platform it may be
 * reads it alike: neither `cmd` nor a shim names anyone there.
 */
export function processAgent(argv: readonly string[], platform: ProgramPlatform): string | null {
  const named = new Set(candidatesOf(platform).map((candidate) => agentOn(argv, candidate)));
  return named.size === 1 ? [...named][0]! : null;
}

function agentOn(argv: readonly string[], platform: CatalogPlatform): string | null {
  const first = fileName(argv[0] ?? "", platform, true);
  const program = INTERPRETERS.has(first) ? fileName(scriptOf(argv) ?? "", platform, false) : first;
  if (!program) return null;
  const entry = AGENT_CATALOG.find((candidate) => candidate.detect.binaries.includes(program) && !candidate.detect.unreliable_on?.[platform]);
  return entry?.id ?? null;
}

/**
 * The status a program's own report says (herdr-core keeps its OSC 7501 word: idle, working, done,
 * blocked, error, …), in herdr's narrower words: an error says nothing about the turn having
 * finished, so it shows as no status, like a word neither knows.
 */
export function reportedStatus(state: string | null | undefined): AgentStatus {
  switch (state) {
    case "working":
    case "blocked":
    case "idle":
    case "done":
      return state;
    default:
      return "unknown";
  }
}

/** Letta Code's terminal title while a turn runs: a braille spinner frame, then its agent's name ("⠋ Tutor"; at rest "Tutor"; letta-code 0.34.44). */
export const LETTA_BUSY_TITLE = /^[\u2800-\u28FF] /;
/** Letta Code's title while a tool call waits for the user's approval, blinking between the two marks ("[ ! ] Action Required | Tutor"; letta-code 0.34.44, standard permission mode). */
export const LETTA_ASKING_TITLE = /^\[ [.!] \] Action Required \| /;

/**
 * The status an agent's own terminal title says, for an agent known to set one: Letta's spinner
 * prefix while it works, its "Action Required" mark while it waits for the user's approval. The
 * program writes the title itself; nothing is read off the screen.
 */
export function titleStatus(agent: string | null, title: string | null | undefined): "working" | "idle" | "blocked" | null {
  if (agent !== "letta" || typeof title !== "string" || title === "") return null;
  if (LETTA_ASKING_TITLE.test(title)) return "blocked";
  return LETTA_BUSY_TITLE.test(title) ? "working" : "idle";
}

export interface SessionFacts {
  /** the sessions the agent named as busy while it ran here (OpenCode's OSC 7501 records), the newest last */
  named?: readonly string[];
  titled?: readonly string[];
}

/**
 * The conversation a pane's agent shows, in herdr's report shape so every resolver reads one form;
 * null when the facts do not settle it. OpenCode: a record names a busy tab, not the one on screen,
 * so the session is the one it named that alone carries the terminal's title.
 */
export function paneSession(agent: string | null, facts: SessionFacts): AgentSessionInfo | null {
  if (agent !== "opencode") return null;
  const titled = facts.titled ?? [];
  return titled.length === 1 && (facts.named ?? []).includes(titled[0]!) ? { agent: "opencode", source: "herdr:opencode", kind: "id", value: titled[0]! } : null;
}

/**
 * The agent a pane runs: the program's own report first, else the process in front of it on
 * `platform`, its terminal's. Only when the runtime names no program in front, the command the
 * terminal was started with, which names an agent only when it runs one directly (a shell's `-c letta` or `cmd /c letta.cmd`
 * names none) and only while the process it started is still the one in front: a terminal started
 * as `claude` whose pane now runs `codex` names Codex, never Claude. No runtime tells a process's
 * start time (hc names a terminal's own pid and the pid in front, herdr's process rows pids), so
 * the same pid is what proves it. Null for none.
 */
export function paneAgent(facts: PaneFacts, platform: ProgramPlatform): string | null {
  const reported = reportedAgent(facts.reported);
  if (reported) return reported;
  // a foreground the runtime names is the program in front, even as the start's pid (a start that exec()ed a shell)
  if (facts.foreground?.length) return processAgent(facts.foreground, platform);
  const launcher = facts.launcher;
  if (!launcher?.argv.length || !startedInFront(facts.foregroundPid, launcher.pid)) return null;
  return processAgent(launcher.argv, platform);
}

/** Whether the process a terminal started with is the one in front now: one live pid, the only proof a runtime gives. */
function startedInFront(front: number | null | undefined, started: number | null | undefined): boolean {
  return typeof front === "number" && front > 0 && front === started;
}
