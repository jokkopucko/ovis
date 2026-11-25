import { join } from "node:path";
import { browserToolChoices, browserToolCommand, isBrowserToolAgent, mcpLaunchArgs, mcpLaunchConfig, withBrowserToolArgs } from "../../shared/browser-tools.ts";
import { coreConnection, hcMachine } from "../herdr-core/runtime.ts";
import { capabilities } from "../runtime/capabilities.ts";
import type { AgentToolHub } from "./hub.ts";
import { privateDir, writePrivate } from "./runs.ts";

/**
 * Agents that take the relay from an extension Ovis writes for the launch and adds with `-e <file>`, which loads it for
 * that run only (as the approval hooks do, server/approvals/extension.ts): it registers the relay as an MCP server of
 * the session (`pi.registerMcpServer`; measured on OmO 5.1.81 / senpi 2026.11.19-5 and pi 1.6.0). Nothing the user
 * set is edited. An agent without the call loads the extension and gets no tool; the shell's `ovis agent` still has
 * the run's token. The tools are few, so they are declared to the model (`direct`), and `agent_wait` holds a call up
 * to 95 s (server/agent-tools/mcp.ts), longer than either agent's default request timeout; each names it its own way
 * and senpi refuses a field it does not know.
 */
const EXTENSION_AGENTS: Record<string, object> = {
  omo: { lifecycle: "eager", requestTimeoutMs: 100_000 },
  pi: { timeout: 100 },
};
const extensionSource = (server: { name: string; command: string; args: readonly string[] }, fields: object) => [
  "// Ovis's agent tool for one launch of this agent (server/agent-tools/launch.ts). Written by Ovis, read once at start.",
  `const SERVER = ${JSON.stringify({ type: "stdio", command: server.command, args: server.args, exposure: "direct", ...fields })};`,
  "export default function ovisAgentTool(pi) {",
  "  if (typeof pi.registerMcpServer !== \"function\") return;",
  `  pi.registerMcpServer(${JSON.stringify(server.name)}, SERVER);`,
  "}",
  "",
].join("\n");

let hub: AgentToolHub | null = null;
export const OVIS_AGENT_LAUNCH_LABEL = "ovis.agent-launch";
export function useAgentToolHub(current: AgentToolHub | null): void { hub = current; }
export function forgetLocalRun(pane: string, keep?: string): void { if (hcMachine() === null) hub?.runs.forgetTerminal(pane, keep); }
export async function markLocalAgentLaunch(pane: string, platform: string): Promise<void> {
  if (platform !== "linux" || pane.includes("/") || hcMachine() !== null || capabilities().attach !== "hc") return;
  // The new process may call before launch is confirmed, even for harnesses that never get a token.
  await coreConnection().call("terminal.label", { terminal: pane, labels: { [OVIS_AGENT_LAUNCH_LABEL]: "1" } });
  hub?.runs.forgetPaneRun(pane);
}
export function launchHarnessTool(pane: string, kind: string, options: { args?: string[]; platform: string; browsers: unknown }) {
  if (!hub || hcMachine() !== null || !capabilities().acpChildren || options.platform === "win32") return null;
  const extension = Object.hasOwn(EXTENSION_AGENTS, kind) ? EXTENSION_AGENTS[kind] : null;
  if (!(extension || isBrowserToolAgent(kind)) || hub.setting.level === "off") return null;
  const r = hub.runs.reserve();
  try {
    const relay = hub.command(r.tokenFile);
    const tools = [{ name: relay.name, command: relay.command, args: relay.args }];
    let args: string[];
    if (isBrowserToolAgent(kind)) {
      const browser = browserToolChoices(options.browsers)[kind];
      if (browser) {
        const [command, ...rest] = browserToolCommand(browser, options.platform);
        tools.push({ name: "ovis-browser", command, args: rest });
      }
      let file = "";
      if (kind !== "codex") {
        file = privateFile(hub, `${r.id}.json`);
        writePrivate(file, mcpLaunchConfig(kind, tools));
      }
      args = withBrowserToolArgs(options.args ?? [], mcpLaunchArgs(kind, tools, file));
    } else {
      const file = privateFile(hub, `${r.id}.js`);
      writePrivate(file, extensionSource(tools[0]!, extension!));
      args = ["-e", file, ...options.args ?? []];
    }
    r.bind({ self: pane, depth: 0, started_by: null, root: r.id, harness: kind });
    const runs = hub.runs;
    const confirmed = async () => {
      // Lack of proof costs only recovery of this credential after restart.
      const terminal = await coreConnection().call("terminal.get", { terminal: pane }).catch(() => null);
      const pid = terminal?.foreground?.pid;
      if (pid && pid !== terminal?.pid) runs.rememberForeground(r.id, pid);
    };
    return { id: r.id, args, cancel: r.cancel, socket: hub.address, tokenFile: r.tokenFile, confirmed };
  } catch (error) { r.cancel(); throw error; }
}

function privateFile(current: AgentToolHub, name: string): string {
  const dir = join(current.runs.dir, "mcp");
  privateDir(dir);
  return join(dir, name);
}
