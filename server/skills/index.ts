import type { CommandForm, SlashCommand } from "../../shared/protocol.ts";
import { source as omo } from "./omo.ts";
import { source as claude } from "./claude.ts";
import { source as codex } from "./codex.ts";
import { source as pi } from "./pi.ts";
import { source as cmd } from "./cmd.ts";
import { source as omp } from "./omp.ts";
import { source as gjc } from "./gjc.ts";
import { source as opencode } from "./opencode.ts";
import { source as devin } from "./devin.ts";
import { source as grok } from "./grok.ts";
import { source as hermes } from "./hermes.ts";
import { source as agy } from "./agy.ts";
import { source as copilot } from "./copilot.ts";
import { source as letta } from "./letta.ts";

export interface ProcessRoots {
  readonly agentDir?: string | null;
  readonly pluginDir?: string | null;
  readonly environ?: readonly string[] | null;
}
export interface AgentCommandContext {
  readonly home: string;
  readonly cwd: string | null | undefined;
  readonly repoRoot: string | null;
  readonly env: readonly string[] | null;
  readonly roots: ProcessRoots;
  readonly version?: string | null;
  /**
   * The server's own environment, the fallback for a setting the pane's process does not name
   * (absent: `process.env`). A scan on a file thread (`file-pool.ts`) is handed the server's copy:
   * a Bun thread keeps the environment the process started with, not what the server set since.
   */
  readonly serverEnv?: Readonly<Record<string, string | undefined>>;
}
export interface AgentCommandSource {
  readonly builtins: readonly string[];
  readonly descriptions?: Readonly<Record<string, string>>;
  readonly discover: (ctx: AgentCommandContext) => SlashCommand[];
  readonly forms?: Record<string, CommandForm[]>;
  readonly terminalBound?: readonly string[];
  readonly agentHidden?: readonly string[];
  readonly pin?: string | readonly string[];
  readonly skillsOverrideBuiltins?: boolean;
}
/** omo loads the first skill of a name, in root order (its own, ~/.agents, then the bundled one). */
const omoFirstByName: AgentCommandSource = {
  ...omo,
  discover(ctx) {
    const names = new Set<string>();
    return omo.discover(ctx).filter(({ name }) => !names.has(name) && Boolean(names.add(name)));
  },
};
export const AGENT_SOURCES: Record<string, AgentCommandSource> = { omo: omoFirstByName, claude, codex, pi, cmd, omp, gjc, opencode, devin, grok, hermes, agy, copilot, letta };
