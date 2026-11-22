import { describe, expect, it } from "bun:test";

import { BROWSER_TOOL_SERVER, browserToolArgs, browserToolChoices, browserToolCommand, browserToolConfig, withBrowserToolArgs } from "./browser-tools.ts";

describe("the browser tool chosen for an agent", () => {
  it("keeps only a known tool for an agent that takes one", () => {
    expect(browserToolChoices({ claude: "playwright", codex: "chrome-devtools", copilot: "selenium", grok: "playwright", gjc: "playwright" }))
      .toEqual({ claude: "playwright", codex: "chrome-devtools" });
    for (const stored of [undefined, null, "playwright", ["playwright"], { claude: "__proto__" }]) expect(browserToolChoices(stored)).toEqual({});
  });

  it("runs a pinned npx package with a profile thrown away, through cmd on Windows", () => {
    expect(browserToolCommand("chrome-devtools", "linux")).toEqual(["npx", "-y", "chrome-devtools-mcp@1.13.0", "--isolated"]);
    expect(browserToolCommand("playwright", "win32")).toEqual(["cmd", "/c", "npx", "-y", "@playwright/mcp@0.0.86", "--isolated"]);
  });

  it("writes Claude Code's and Copilot's config in each one's shape", () => {
    expect(JSON.parse(browserToolConfig("claude", "playwright", "darwin"))).toEqual({
      mcpServers: { [BROWSER_TOOL_SERVER]: { type: "stdio", command: "npx", args: ["-y", "@playwright/mcp@0.0.86", "--isolated"] } },
    });
    expect(JSON.parse(browserToolConfig("copilot", "chrome-devtools", "win32"))).toEqual({
      mcpServers: { [BROWSER_TOOL_SERVER]: { type: "local", command: "cmd", args: ["/c", "npx", "-y", "chrome-devtools-mcp@1.13.0", "--isolated"], tools: ["*"] } },
    });
  });

  it("names the config file for Claude Code and Copilot, and gives Codex settings its TOML reads back", () => {
    expect(browserToolArgs("claude", "playwright", "linux", "/state/browser-tools/claude-playwright.json")).toEqual(["--mcp-config", "/state/browser-tools/claude-playwright.json"]);
    expect(browserToolArgs("copilot", "playwright", "linux", "/state/x.json")).toEqual(["--additional-mcp-config", "@/state/x.json"]);
    const codex = browserToolArgs("codex", "playwright", "win32", "");
    expect(codex.filter((_, at) => at % 2 === 0)).toEqual(["-c", "-c"]);
    const settings = codex.filter((_, at) => at % 2 === 1).map((setting) => {
      const split = setting.indexOf("=");
      return [setting.slice(0, split), (Bun.TOML.parse(`value = ${setting.slice(split + 1)}`) as { value: unknown }).value] as const;
    });
    expect(settings).toEqual([
      [`mcp_servers.${BROWSER_TOOL_SERVER}.command`, "cmd"],
      [`mcp_servers.${BROWSER_TOOL_SERVER}.args`, ["/c", "npx", "-y", "@playwright/mcp@0.0.86", "--isolated"]],
    ]);
  });

  it("goes before the -- that ends the options, or at the end", () => {
    expect(withBrowserToolArgs(["--model", "o3", "--", "hello"], ["-c", "x"])).toEqual(["--model", "o3", "-c", "x", "--", "hello"]);
    expect(withBrowserToolArgs(["--effort", "high"], ["--mcp-config", "/f"])).toEqual(["--effort", "high", "--mcp-config", "/f"]);
    expect(withBrowserToolArgs([], ["--mcp-config", "/f"])).toEqual(["--mcp-config", "/f"]);
  });
});
