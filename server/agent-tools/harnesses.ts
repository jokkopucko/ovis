import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
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
export function resolveHarness(kind: string): HarnessCommand | null {
  switch (kind) {
    case "gjc": case "opencode": case "agy": {
      const path = Bun.which(kind, { PATH: process.env["PATH"] });
      return path ? { argv: [path, ...(kind === "gjc" ? ["--mode", "acp"] : ["acp"])] } : null;
    }
    case "copilot": {
      // the file whose version is checked is the one that runs, whatever its link points to later
      const path = Bun.which(kind, { PATH: process.env["PATH"] });
      return path ? { argv: [realpathSync(path), "--acp", "--stdio"] } : null;
    }
    case "claude": case "codex": {
      const adapter = adapters[kind];
      const path = Bun.which(adapter.command, { PATH: process.env["PATH"] }), found = Bun.which(kind, { PATH: process.env["PATH"] });
      if (!path || !found) return null;
      // the files whose versions are checked are the ones that run, whatever their links point to later
      const executable = realpathSync(found);
      const script = realpathSync(path);
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
