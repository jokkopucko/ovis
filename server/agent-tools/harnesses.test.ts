import { afterEach, beforeEach, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AGENT_CATALOG } from "../../shared/agent-catalog.ts";
import { ACP_LAUNCH_HARNESSES } from "../../shared/harness-tool.ts";
import { resolveHarness } from "./harnesses.ts";

let dir: string;
let oldPath: string | undefined;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ha-"));
  oldPath = process.env.PATH;
  process.env.PATH = dir;
  const installed = [...AGENT_CATALOG.map(entry => entry.id), "claude-agent-acp", "codex-acp"];
  for (const binary of installed) writeFileSync(join(dir, binary), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
});
afterEach(() => {
  if (oldPath === undefined) delete process.env.PATH; else process.env.PATH = oldPath;
  rmSync(dir, { recursive: true, force: true });
});

it("Settings offers exactly the installed harness kinds the server can resolve for ACP", () => {
  const resolved = AGENT_CATALOG.filter(entry => resolveHarness(entry.id) !== null).map(entry => entry.id);
  expect(resolved.sort()).toEqual([...ACP_LAUNCH_HARNESSES].sort());
});

it("opens Claude and Codex with installed adapters regardless of adapter package version", () => {
  const manifest = join(dir, "package.json");
  writeFileSync(manifest, JSON.stringify({ name: "@agentclientprotocol/claude-agent-acp", version: "99.1.2" }));
  expect(resolveHarness("claude")).toEqual({
    argv: [join(dir, "claude-agent-acp"), "--hide-claude-auth"],
    env: { CLAUDE_CODE_EXECUTABLE: join(dir, "claude") },
    sessionMeta: { claudeCode: { options: { allowDangerouslySkipPermissions: false } } },
    configOptions: [{ configId: "mode", value: "default" }],
  });
  writeFileSync(manifest, JSON.stringify({ name: "@agentclientprotocol/codex-acp", version: "99.1.2" }));
  expect(resolveHarness("codex")).toEqual({
    argv: [join(dir, "codex-acp")], env: { CODEX_PATH: join(dir, "codex") },
  });
});

it("requires the separately installed adapter for Claude Code", () => {
  rmSync(join(dir, "claude-agent-acp"));
  expect(resolveHarness("claude")).toBeNull();
});

it("keeps native ACP launch hygiene and selects ordinary startup permissions", () => {
  expect(resolveHarness("opencode")).toEqual({ argv: [join(dir, "opencode"), "acp"] });
  expect(resolveHarness("gjc")).toEqual({ argv: [join(dir, "gjc"), "--mode", "acp"], env: { GJC_ACP_PERMISSION_MODE: "prompt" } });
  expect(resolveHarness("copilot")).toEqual({ argv: [join(dir, "copilot"), "--acp", "--stdio", "--no-auto-update"], env: { COPILOT_ALLOW_ALL: "false" } });
  expect(resolveHarness("agy")).toEqual({
    argv: [join(dir, "agy"), "--mode=default", "acp", "--disable-telemetry", "--log-file", "/dev/null"],
    env: { AGY_CLI_DISABLE_AUTO_UPDATE: "1" },
  });
});
