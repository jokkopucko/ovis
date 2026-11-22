/**
 * The browser tool an agent Ovis starts may be given (Settings → Agents → Browser tool): an MCP server the agent
 * runs itself, pinned to one version, whose browser keeps its profile only for the session (`--isolated`), so
 * none of the user's sign-ins goes with it. Ovis neither sees nor limits that browser.
 *
 * Only agents that take an MCP server on their command line are offered one: the server adds it to the launch
 * (server/agent-launch.ts) and never writes the agent's own settings. Checked 2026-11-21 with each CLI's
 * `--help` and a start in an empty HOME: Claude Code 2.1.326 (`--mcp-config <file>`), Codex 0.169.0
 * (`-c mcp_servers.<name>.…`), GitHub Copilot CLI 1.0.109 (`--additional-mcp-config @<file>`). Left out: agents
 * whose `mcp` commands write their own settings files (grok, agy, droid, letta, OpenCode), and Gajae Code, whose
 * `--mcp-config` waits at most 1.75 s for a server to connect, less than an `npx` start takes.
 */
export const BROWSER_TOOLS = {
  "chrome-devtools": { name: "Chrome DevTools MCP", package: "chrome-devtools-mcp", version: "1.13.0" },
  playwright: { name: "Playwright MCP", package: "@playwright/mcp", version: "0.0.86" },
} as const;
export type BrowserToolId = keyof typeof BROWSER_TOOLS;
export const BROWSER_TOOL_IDS = Object.keys(BROWSER_TOOLS) as BrowserToolId[];

export const BROWSER_TOOL_AGENTS = ["claude", "codex", "copilot"] as const;
export type BrowserToolAgent = (typeof BROWSER_TOOL_AGENTS)[number];
/** the shared setting `agentBrowserTools`: an agent that is absent gets none */
export type BrowserToolChoices = Partial<Record<BrowserToolAgent, BrowserToolId>>;

/** the name the tool's MCP server has in the agent, so the user's own servers of the same tool keep theirs */
export const BROWSER_TOOL_SERVER = "ovis-browser";

export const isBrowserToolAgent = (kind: string): kind is BrowserToolAgent => (BROWSER_TOOL_AGENTS as readonly string[]).includes(kind);
const isBrowserTool = (value: unknown): value is BrowserToolId => typeof value === "string" && Object.hasOwn(BROWSER_TOOLS, value);

/** the choices kept from a stored value: only a known tool for an agent that takes one */
export function browserToolChoices(value: unknown): BrowserToolChoices {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  const choices: BrowserToolChoices = {};
  for (const agent of BROWSER_TOOL_AGENTS) {
    const tool = (value as Record<string, unknown>)[agent];
    if (isBrowserTool(tool)) choices[agent] = tool;
  }
  return choices;
}

/** The command the agent runs for the tool. On Windows `npx` is a batch file, which an agent starts only through cmd. */
export function browserToolCommand(tool: BrowserToolId, platform: string): string[] {
  const { package: name, version } = BROWSER_TOOLS[tool];
  const npx = ["npx", "-y", `${name}@${version}`, "--isolated"];
  return platform === "win32" ? ["cmd", "/c", ...npx] : npx;
}

/** The MCP config file Claude Code or Copilot reads the tool from; Codex takes it as `-c` settings instead. */
export function browserToolConfig(agent: Exclude<BrowserToolAgent, "codex">, tool: BrowserToolId, platform: string): string {
  const [command, ...args] = browserToolCommand(tool, platform);
  const server = agent === "claude" ? { type: "stdio", command, args } : { type: "local", command, args, tools: ["*"] };
  return `${JSON.stringify({ mcpServers: { [BROWSER_TOOL_SERVER]: server } }, null, 2)}\n`;
}

/** a TOML literal string: the tool's words never hold a quote, and single quotes survive Windows PowerShell's passing on */
const literal = (text: string): string => `'${text}'`;

/** The arguments that give the agent the tool, `file` being where its browserToolConfig was written (unused for Codex). */
export function browserToolArgs(agent: BrowserToolAgent, tool: BrowserToolId, platform: string, file: string): string[] {
  if (agent === "claude") return ["--mcp-config", file];
  if (agent === "copilot") return ["--additional-mcp-config", `@${file}`];
  const [command, ...args] = browserToolCommand(tool, platform);
  return [
    "-c", `mcp_servers.${BROWSER_TOOL_SERVER}.command=${literal(command!)}`,
    "-c", `mcp_servers.${BROWSER_TOOL_SERVER}.args=[${args.map(literal).join(",")}]`,
  ];
}

/** `args` with the tool's arguments put before a `--` that ends the options (Codex's prompt follows it), else at the end */
export function withBrowserToolArgs(args: readonly string[], added: readonly string[]): string[] {
  const end = args.indexOf("--");
  return end < 0 ? [...args, ...added] : [...args.slice(0, end), ...added, ...args.slice(end)];
}
