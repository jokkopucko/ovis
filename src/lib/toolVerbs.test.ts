import { describe, expect, it } from "bun:test";

import { isToolNarration, toolDisplayName, toolVerb, toolVerbKind } from "./toolVerbs.ts";

describe("toolVerbKind", () => {
  it("reads every agent's file and shell tools as one of four verbs", () => {
    const expected: Record<string, string> = {
      Read: "read", Edit: "edit", MultiEdit: "edit", NotebookEdit: "edit", Write: "write", Bash: "run",
      exec: "run", exec_command: "run", shell: "run", shell_command: "run", local_shell: "run", apply_patch: "edit",
      read: "read", edit: "edit", multiedit: "edit", patch: "edit", write: "write", bash: "run",
    };
    for (const [name, kind] of Object.entries(expected)) expect([name, toolVerbKind(name)]).toEqual([name, kind as ReturnType<typeof toolVerbKind>]);
  });

  it("leaves every other tool the chat knows under its own name", () => {
    const untouched = [
      "Grep", "grep", "Glob", "glob", "LS", "ls", "find", "list", "search", "eval", "run_command",
      "Skill", "Task", "Agent", "task", "WebFetch", "WebSearch", "webfetch", "web_search",
      "TodoWrite", "update_plan", "todo", "todo_write", "mcp__omo__todo",
      "create_goal", "update_goal", "get_goal", "request_user_input_async",
      "mcp__files__read_all", "read_mcp_resource", "BashOutput", "write_stdin", "tool",
    ];
    for (const name of untouched) expect([name, toolVerbKind(name)]).toEqual([name, null]);
  });

  it("calls a Codex exec that applies a patch an edit", () => {
    const script = 'const r = await tools.apply_patch("*** Begin Patch\\n*** Update File: src/a.ts\\n@@\\n-a\\n+b\\n*** End Patch");';
    expect(toolVerbKind("exec", script)).toBe("edit");
    expect(toolVerbKind("exec", '{"cmd":"bun test"}')).toBe("run");
    expect(toolVerbKind("Read", "*** Begin Patch\n*** End Patch")).toBe("read");
    expect(toolVerbKind("lookup", "*** Begin Patch\n*** End Patch")).toBeNull();
  });
});

describe("toolVerb", () => {
  const part = (name: string, args: Record<string, unknown> = {}) => ({ name, input: JSON.stringify(args, null, 2) });

  it("is the verb a row shows before its object", () => {
    expect(toolVerb(part("Read", { file_path: "src/metrics.ts" }), "src/metrics.ts")).toBe("Read");
    expect(toolVerb(part("read", { path: "src/metrics.ts" }), "src/metrics.ts")).toBe("Read");
    expect(toolVerb(part("Edit", { file_path: "src/pages/Reports.tsx", old_string: "a", new_string: "b" }), "src/pages/Reports.tsx")).toBe("Edited");
    expect(toolVerb(part("Write", { file_path: "notes.md", content: "x" }), "notes.md")).toBe("Wrote");
    expect(toolVerb(part("exec", { cmd: "pnpm test" }), "pnpm test")).toBe("Ran");
    expect(toolVerb(part("bash", { command: "pnpm test" }), "pnpm test")).toBe("Ran");
  });

  it("names the files of a patch, bare or inside an exec script", () => {
    const patch = "*** Begin Patch\n*** Update File: src/a.ts\n@@\n-a\n+b\n*** Add File: src/b.ts\n+c\n*** End Patch";
    expect(toolVerb({ name: "apply_patch", input: patch }, "src/a.ts, src/b.ts")).toBe("Edited");
    expect(toolVerb({ name: "exec", input: `await tools.apply_patch(${JSON.stringify(patch)});` }, "src/a.ts, src/b.ts")).toBe("Edited");
    expect(toolVerb({ name: "exec", input: `await tools.apply_patch(${JSON.stringify(patch)});` }, "Fixing the typo")).toBeNull();
  });

  it("follows the server's cut of a long command", () => {
    const command = `echo ${"x".repeat(200)}`;
    expect(toolVerb(part("Bash", { command }), command.slice(0, 120))).toBe("Ran");
    expect(toolVerb(part("Bash", { command }), command.slice(0, 60))).toBeNull();
  });

  it("keeps the tool id when the summary is the call's intent, not its command or path", () => {
    expect(toolVerb(part("bash", { command: "ss -tlnp" }), "Checking ports")).toBeNull();
    expect(toolVerb(part("read", { path: "config.toml" }), "Looking at the config")).toBeNull();
    expect(toolVerb(part("edit", { path: "README.md", old_text: "teh", new_text: "the" }), "Fixing the typo")).toBeNull();
    expect(toolVerb(part("write", { path: "notes.md", content: "x" }), "Saving the notes")).toBeNull();
    expect(toolVerb(part("bash", { command: "ss -tlnp" }), "ss -tlnp")).toBe("Ran");
    expect(toolVerb(part("Bash", { command: "ss -tlnp", description: "Check ports" }), "Check ports")).toBeNull();
    expect(toolVerb(part("bash", { path: "src/a.ts" }), "src/a.ts")).toBeNull();
    expect(toolVerb(part("read", { command: "cat a" }), "cat a")).toBeNull();
  });

  it("keeps the tool id when there is nothing to put after the verb", () => {
    expect(toolVerb(part("Bash"), "")).toBeNull();
    expect(toolVerb(part("bash", { command: "   " }), "   ")).toBeNull();
    expect(toolVerb(part("Bash"), "Bash")).toBeNull();
    expect(toolVerb({ name: "exec", input: "console.log(1)" }, "console.log(1)")).toBeNull();
    expect(toolVerb({ name: "exec", input: "null" }, "null")).toBeNull();
  });

  it("keeps the id of a tool it does not know", () => {
    expect(toolVerb(part("Grep", { pattern: "TODO" }), "TODO")).toBeNull();
    expect(toolVerb(part("mcp__linear__create_issue", { path: "Fix the chart" }), "Fix the chart")).toBeNull();
  });
});

describe("isToolNarration", () => {
  const part = (name: string, input: unknown) => ({ name, input: JSON.stringify(input) });

  it("knows the agent's own sentence about a call from its command or path", () => {
    expect(isToolNarration(part("eval", { code: "await check()", summary: "Run the checks" }), "Run the checks")).toBe(true);
    expect(isToolNarration(part("Bash", { command: "bun test", description: " Run the unit tests " }), "Run the unit tests")).toBe(true);
    expect(isToolNarration(part("bash", { command: "lsof -i", intent: "Checking ports" }), "Checking ports")).toBe(true);
    expect(isToolNarration(part("eval", { code: "1", summary: "x".repeat(200) }), "x".repeat(120))).toBe(true);
    expect(isToolNarration(part("Bash", { command: "bun test", description: "Run the unit tests" }), "bun test")).toBe(false);
    expect(isToolNarration(part("Read", { file_path: "src/a.ts" }), "src/a.ts")).toBe(false);
    expect(isToolNarration(part("eval", { code: "1" }), "eval")).toBe(false);
    expect(isToolNarration({ name: "exec", input: "console.log(1)" }, "console.log(1)")).toBe(false);
  });
});

describe("toolDisplayName", () => {
  it("names an MCP tool by its server and tool (#3875)", () => {
    expect(toolDisplayName("mcp__claude_ai_HomeAssistant__get_entity_state")).toBe("HomeAssistant get_entity_state");
    expect(toolDisplayName("mcp__plugin_playwright_playwright__browser_take_screenshot")).toBe("playwright browser_take_screenshot");
    expect(toolDisplayName("mcp__plugin_tools_github__create_issue")).toBe("tools_github create_issue");
    expect(toolDisplayName("mcp__linear__create_issue")).toBe("linear create_issue");
    expect(toolDisplayName("mcp__custom-tools__a__b")).toBe("custom-tools a__b");
  });

  it("keeps any other id as the agent names it", () => {
    for (const name of ["Grep", "exec", "read_mcp_resource", "mcp__linear", "mcp____create_issue", "mcp__linear__", "MCP__linear__create_issue"]) {
      expect(toolDisplayName(name)).toBe(name);
    }
  });
});
