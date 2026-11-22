import { describe, expect, it } from "bun:test";

import { CLAUDE_EFFORTS, CLAUDE_ULTRACODE_SETTINGS, firstMessageFault, launchArgsFault, MODEL_NAME } from "./launch-rules.ts";

describe("an agent's launch arguments", () => {
  it("refuses a control character in any argument, a tab and a line break included", () => {
    expect(launchArgsFault("codex", ["--", "a\tb"])).toContain("control characters");
    expect(launchArgsFault("codex", ["--", "a\nb"])).toContain("control characters");
    expect(launchArgsFault("omp", ["--flag\u001b[2J"])).toContain("control characters");
  });
  it("takes Codex's one prompt after -- by a first message's rules", () => {
    expect(launchArgsFault("codex", ["--", "$review-pr the branch"])).toBeNull();
    expect(launchArgsFault("codex", ["--", "   "])).toContain("one prompt");
    expect(launchArgsFault("codex", ["--", "x".repeat(20_001)])).toContain("one prompt");
    expect(launchArgsFault("codex", ["--", "a", "b"])).toContain("one prompt");
  });
  it("takes only a one-word model and the effort levels each agent names", () => {
    expect(launchArgsFault("claude", ["--permission-mode", "plan", "--model", "opus[1m]", "--effort", "ultracode"])).toBeNull();
    expect(launchArgsFault("claude", ["--model", "--dangerously-skip-permissions"])).toContain("--model");
    expect(launchArgsFault("claude", ["--model"])).toContain("--model");
    expect(launchArgsFault("claude", ["--effort", "ultra"])).toContain("--effort");
    expect(launchArgsFault("codex", ["-c", "model_reasoning_effort=ultra", "-m", "gpt-6.1"])).toBeNull();
    expect(launchArgsFault("codex", ["-c", "model_reasoning_effort=ultracode"])).toContain("model_reasoning_effort");
    // DeepSeek Harness's levels, in both spellings
    expect(launchArgsFault("dsh-tui", ["--effort", "off"])).toBeNull();
    expect(launchArgsFault("dsh-tui", ["--effort=max"])).toBeNull();
    expect(launchArgsFault("dsh-tui", ["--effort", "xhigh"])).toBe("agent.args --effort must be one of off, low, high, max");
    expect(launchArgsFault("omp", ["--model", "two words"])).toBeNull();
  });
  it("still takes Claude Code's --effort ultracode, which the dialog no longer lists as a level", () => {
    expect(CLAUDE_EFFORTS).toEqual(["low", "medium", "high", "xhigh", "max"]);
    // Claude Code 2.1.311 still reads it as xhigh with Ultracode on; the refusal names it with the levels
    expect(launchArgsFault("claude", ["--effort", "ultracode"])).toBeNull();
    expect(launchArgsFault("claude", ["--effort", "ultra"])).toBe("agent.args --effort must be one of low, medium, high, xhigh, max, ultracode");
  });
  it("passes Ultracode's --settings as the agent's own flag, after an effort or on its own", () => {
    expect(JSON.parse(CLAUDE_ULTRACODE_SETTINGS)).toEqual({ ultracode: true });
    expect(launchArgsFault("claude", ["--effort", "medium", "--settings", CLAUDE_ULTRACODE_SETTINGS])).toBeNull();
    expect(launchArgsFault("claude", ["--permission-mode", "plan", "--model", "opus", "--effort", "high", "--settings", "{\"ultracode\":true}"])).toBeNull();
    expect(launchArgsFault("claude", ["--settings", "{\"ultracode\":true}"])).toBeNull();
    expect(launchArgsFault("claude", ["--effort", "INVALID", "--settings", "{\"ultracode\":true}"])).toContain("--effort");
  });
});

describe("every spelling the CLIs accept for a model or an effort", () => {
  it.each([
    ["codex", ["-m", "two words"], "--model"],
    ["codex", ["-mtwo words"], "--model"],
    ["codex", ["-m=two words"], "--model"],
    ["codex", ["--model=two words"], "--model"],
    ["codex", ["--config", "model_reasoning_effort=INVALID"], "model_reasoning_effort"],
    ["codex", ["--config=model_reasoning_effort=INVALID"], "model_reasoning_effort"],
    ["codex", ["-cmodel_reasoning_effort=INVALID"], "model_reasoning_effort"],
    ["codex", ["-c", "model_reasoning_effort=\"INVALID\""], "model_reasoning_effort"],
    ["codex", ["-c", "model=\"two words\""], "--model"],
    ["claude", ["--effort=INVALID"], "--effort"],
    ["claude", ["--model=two words"], "--model"],
    ["codex", ["-m", "gpt-6.1", "--model=gpt-6.1", "--config", "model_reasoning_effort=high", "-c", "model_reasoning_effort=\"xhigh\"", "-c", "model=\"gpt-6.1\""], null],
    ["claude", ["--effort=max", "--model=opus[1m]"], null],
    ["claude", ["--effort=ultracode"], null],
    ["claude", ["--effort=medium", "--settings={\"ultracode\":true}"], null],
    ["codex", ["--config=model_reasoning_effort=ultracode"], "model_reasoning_effort"],
    // a flag's value is the flag's: "--" there is not the end of the options
    ["codex", ["-m", "--"], "--model"],
  ] as const)("%s %j", (kind, args, flag) => {
    const fault = launchArgsFault(kind, args);
    if (flag === null) expect(fault).toBeNull();
    else expect(fault).toContain(flag);
  });
});

describe("a model name", () => {
  it("is one word, with an optional bracketed variant such as Claude Code's [1m]", () => {
    for (const name of ["opus", "claude-opus-4-5", "opus[1m]", "sonnet[1m]", "gpt-6.1", "openrouter/qwen:free"]) expect(MODEL_NAME.test(name), name).toBeTrue();
    for (const name of ["--model", "two words", "opus[1m", "opus[]", "[1m]"]) expect(MODEL_NAME.test(name), name).toBeFalse();
  });
});

describe("a first message", () => {
  it("keeps tabs and line breaks, which the queued path types as text, and refuses other control characters", () => {
    expect(firstMessageFault("line one\n\tline two", true)).toBeNull();
    expect(firstMessageFault("run \u001b[2J this", true)).toContain("control characters");
    expect(firstMessageFault("hi", null)).toContain("needs an agent");
  });
});

describe("an MCP server named by the client", () => {
  it.each([
    ["claude", ["--mcp-config", "/tmp/evil.json"]],
    ["claude", ["--model", "opus", "--mcp-config={\"mcpServers\":{}}"]],
    ["copilot", ["--additional-mcp-config", "@/tmp/evil.json"]],
    ["codex", ["-c", "mcp_servers.x.command='sh'"]],
    ["codex", ["--config=mcp_servers={}"]],
    ["codex", ["-c", "\"mcp_servers\".x.args=[]"]],
  ])("is refused for %s: only the PC adds one, from its settings", (kind, args) => {
    expect(launchArgsFault(kind, args)).toContain("browser tool");
  });
  it.each([
    ["codex", ["mcp", "add", "x", "--", "sh"]],
    ["claude", ["mcp", "add", "x", "sh"]],
    ["copilot", ["--model", "x", "mcp", "add", "x", "--", "sh"]],
    ["claude", ["--", "mcp", "add", "x", "sh"]],
    ["copilot", ["--", "mcp", "add", "x"]],
    ["claude", ["-c", "mcp", "add", "x", "sh"]],
  ])("is refused through %s's own mcp command, which writes its settings", (kind, args) => {
    expect(launchArgsFault(kind, args)).toContain("mcp command");
  });
  it("is no command as a flag's value, nor in Codex's prompt after --", () => {
    expect(launchArgsFault("claude", ["--model", "mcp"])).toBeNull();
    expect(launchArgsFault("codex", ["-m", "mcp", "--", "mcp"])).toBeNull();
  });
  it("is the prompt's own text after --", () => {
    expect(launchArgsFault("codex", ["--", "--mcp-config and mcp_servers"])).toBeNull();
    expect(launchArgsFault("claude", ["--", "--mcp-config"])).toBeNull();
    expect(launchArgsFault("codex", ["-c", "model_reasoning_effort=high"])).toBeNull();
  });
});
