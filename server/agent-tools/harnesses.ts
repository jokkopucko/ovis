import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { isBrowserToolAgent } from "../../shared/browser-tools.ts";
import type { Capabilities } from "../../shared/harness-contract.generated.ts";
import { isRecord } from "../../shared/harness-tool.ts";

const adapters = {
  claude: { command: "claude-agent-acp", versions: ["0.110.0", "0.112.0"], pathVar: "CLAUDE_CODE_EXECUTABLE" },
  codex: { command: "codex-acp", versions: ["2.10.0", "2.11.0"], pathVar: "CODEX_PATH" },
} as const;
export interface HarnessCommand {
  readonly argv: readonly string[]; readonly env?: Record<string, string>;
  /** Only a launch recipe with a proven permission profile may supply this. ACP's free-form
   * currentModeId alone proves nothing across harnesses or local user settings. */
  readonly ceiling?: { readonly profile: string; readonly mode: string };
}
/** The file a link on PATH names, so the one whose version is checked is the one that runs; null once it is gone. */
const resolved = (path: string | null): string | null => {
  try { return path && realpathSync(path); } catch { return null; }
};
export function resolveHarness(kind: string): HarnessCommand | null {
  switch (kind) {
    case "gjc": case "opencode": case "agy": {
      const path = resolved(Bun.which(kind, { PATH: process.env["PATH"] }));
      return path ? { argv: [path, ...(kind === "gjc" ? ["--mode", "acp"] : ["acp"])] } : null;
    }
    case "copilot": {
      const path = resolved(Bun.which(kind, { PATH: process.env["PATH"] }));
      return path ? { argv: [path, "--acp", "--stdio"] } : null;
    }
    case "claude": case "codex": {
      const adapter = adapters[kind];
      const script = resolved(Bun.which(adapter.command, { PATH: process.env["PATH"] })), executable = resolved(Bun.which(kind, { PATH: process.env["PATH"] }));
      if (!script || !executable) return null;
      let dir = dirname(script);
      while (dir !== dirname(dir)) {
        const file = join(dir, "package.json");
        if (existsSync(file)) {
          try {
            const pkg: unknown = JSON.parse(readFileSync(file, "utf8"));
            if (isRecord(pkg) && pkg.name === `@agentclientprotocol/${adapter.command}`) {
              return (adapter.versions as readonly unknown[]).includes(pkg.version) ? { argv: [script, ...(kind === "claude" ? ["--hide-claude-auth"] : [])], env: { [adapter.pathVar]: executable } } : null;
            }
          } catch { return null; }
        }
        dir = dirname(dir);
      }
      return null;
    }
    default: return null;
  }
}

/**
 * What `agent_harnesses` announces for one harness on this PC, built in this one place from what Ovis can prove here:
 * an ACP launch it resolves (resolveHarness), an approval hook the hub handles, the browser tool. A flag that is not
 * proven reports its safe value (docs/harness-contract.md, "Capability flags").
 */
export function harnessCapabilities(kind: string, hasHook: boolean): Capabilities {
  const acp = resolveHarness(kind) !== null, browser = isBrowserToolAgent(kind);
  return {
    drive: acp ? ["terminal", "acp"] : ["terminal"], level: acp ? "structured" : "terminal", acp_protocol: acp ? 1 : null,
    approvals: ["keys", ...(hasHook ? ["hook"] : []), ...(acp ? ["acp"] : [])], transcript: acp ? "acp" : "none", turn_end: acp ? "strong" : "weak", turn_end_from: acp ? ["acp"] : ["terminal"],
    model_switch: "none", resume: false, images: false, slash_commands: false, subagents: false, tool_delivery: browser || acp ? ["mcp", "shell"] : [],
    browser_tool: browser, memory_tool: false,
  };
}
