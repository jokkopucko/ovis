import { afterEach, beforeEach, expect, it, spyOn } from "bun:test";
import { agentLaunch } from "../agent-launch.ts";
import * as shell from "../shell-agent.ts";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AcpChildren } from "../acp/children.ts";
import { HcConnection } from "../herdr-core/connection.ts";
import { FakeHcCore } from "../herdr-core/core.fake.ts";
import * as runtime from "../herdr-core/runtime.ts";
import { HERDR_CORE, serveRuntime } from "../runtime/capabilities.ts";
import { HARNESS_SKILL } from "../../shared/harness-skill.ts";
import { TOOL_SCHEMAS, type HarnessToolSetting } from "../../shared/harness-tool.ts";
import { AgentToolHub } from "./hub.ts";
import { forgetLocalRun, launchHarnessTool, useAgentToolHub } from "./launch.ts";
import { mcpMessage } from "./mcp.ts";

let hc: HcConnection;
let connection: ReturnType<typeof spyOn>;
beforeEach(() => {
  const fake = new FakeHcCore();
  fake.spawn();
  hc = new HcConnection(() => fake.transport());
  connection = spyOn(runtime, "coreConnection").mockReturnValue(hc);
});
afterEach(() => { connection.mockRestore(); hc.close(); });

it.skipIf(process.platform === "win32")("one launch config holds both relays; no run secret is in argv, config or the MCP answers", async () => {
  const dir = mkdtempSync(join(tmpdir(), "at-launch-"));
  let setting: HarnessToolSetting = { level: "start", depth: 2, harnesses: ["opencode"] };
  const hub = new AgentToolHub({ dir, acp: new AcpChildren(join(dir, "acp")), setting: () => setting });
  serveRuntime(HERDR_CORE); useAgentToolHub(hub);
  try {
    hub.listen();
    for (const kind of ["claude","codex","copilot"]) {
      const launch = launchHarnessTool("t1", kind, { platform: "linux", args: ["--", "prompt"], browsers: { [kind]: "playwright" } });
      if (!launch) throw new Error("no launch");
      const token = readFileSync(launch.tokenFile, "utf8");
      expect(launch.args.slice(-2)).toEqual(["--", "prompt"]);
      const config = kind === "codex" ? launch.args.join(" ") : readFileSync(String(launch.args[1]).replace(/^@/, ""), "utf8");
      expect(config).toContain("ovis-agent"); expect(config).toContain("ovis-browser");
      expect(config).not.toContain(token);
      expect(JSON.stringify(launch.args)).not.toContain(token);
      expect(statSync(launch.socket).mode & 0o777).toBe(0o600);
      const door = { socket: launch.socket, tokenFile: launch.tokenFile };
      expect(await mcpMessage(door, { method: "initialize", id: 1 })).toMatchObject({result:{ instructions: HARNESS_SKILL }});
      const tools = await mcpMessage(door, { method: "tools/list", id: 2 });
      expect(tools).toMatchObject({ result: { tools: Object.entries(TOOL_SCHEMAS).map(([v,schema]) => ({ name: `agent_${v}`, inputSchema: schema })) } });
      expect(JSON.stringify(tools)).not.toContain(token);
      const replacement = spyOn(shell, "startShellAgent").mockRejectedValueOnce(new Error("fixture: replacement missing"));
      try {
        expect(await agentLaunch("t1", { kind: "omo" })).toMatchObject({ agent_started: false });
        expect(hub.runs.verify(token)?.self).toBe("t1");
      } finally { replacement.mockRestore(); }
      forgetLocalRun("t1");
      expect(hub.runs.verify(token)).toBeNull();
      expect(existsSync(launch.tokenFile)).toBe(false);
    }
    setting = { ...setting, level: "off" };
    hub.settingsChanged();
    expect(launchHarnessTool("t1", "claude", { platform: "linux", browsers: {} })).toBeNull();
  } finally { useAgentToolHub(null); serveRuntime(null); hub.close(); rmSync(dir,{recursive:true,force:true}); }
});

it.skipIf(process.platform === "win32")("an OmO started from the pane's shell gets the extension and its run's token in its environment", async () => {
  const dir = mkdtempSync(join(tmpdir(), "at-launch-"));
  const hub = new AgentToolHub({ dir, acp: new AcpChildren(join(dir, "acp")), setting: () => ({ level: "view", depth: 1, harnesses: [] }) });
  serveRuntime(HERDR_CORE); useAgentToolHub(hub);
  const started = spyOn(shell, "startShellAgent").mockResolvedValueOnce(null);
  try {
    hub.listen();
    expect(await agentLaunch("t1", { kind: "omo", args: ["--model", "x"] })).toEqual({ agent_started: true });
    const [, , args, options] = started.mock.calls[0]!;
    expect(args?.[0]).toBe("-e");
    expect(args?.slice(2)).toEqual(["--model", "x"]);
    expect(options?.env?.["OVIS_AGENT_SOCKET"]).toBe(hub.address);
    expect(hub.runs.verify(readFileSync(options!.env!["OVIS_AGENT_TOKEN_FILE"]!, "utf8"))?.harness).toBe("omo");
  } finally { started.mockRestore(); useAgentToolHub(null); serveRuntime(null); hub.close(); rmSync(dir,{recursive:true,force:true}); }
});

it.skipIf(process.platform === "win32")("OmO and pi get the relay from a launch extension that registers it as an MCP server; no run secret in it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "at-launch-"));
  const hub = new AgentToolHub({ dir, acp: new AcpChildren(join(dir, "acp")), setting: () => ({ level: "view", depth: 1, harnesses: [] }) });
  serveRuntime(HERDR_CORE); useAgentToolHub(hub);
  try {
    hub.listen();
    for (const [kind, timeout] of [["omo", { requestTimeoutMs: 100_000 }], ["pi", { timeout: 100 }]] as const) {
    const launch = launchHarnessTool("t1", kind, { platform: "linux", args: ["-e", "/approvals.js", "--model", "x"], browsers: {} });
    if (!launch) throw new Error("no launch");
    expect(launch.args.slice(0, 1)).toEqual(["-e"]);
    expect(launch.args.slice(2)).toEqual(["-e", "/approvals.js", "--model", "x"]);
    const file = launch.args[1]!;
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const token = readFileSync(launch.tokenFile, "utf8");
    expect(readFileSync(file, "utf8")).not.toContain(token);
    const registered: [string, { command: string; args: string[]; exposure: string }][] = [];
    const { default: extension } = await import(file) as { default: (pi: unknown) => void };
    extension({ registerMcpServer: (name: string, config: { command: string; args: string[]; exposure: string }) => registered.push([name, config]) });
    expect(registered.map(([name]) => name)).toEqual(["ovis-agent"]);
    const [, server] = registered[0]!;
    // agent_wait holds a call up to 95 s, past both agents' default timeouts
    expect(server).toMatchObject({ exposure: "direct", ...timeout });
    // the server the agent starts from it is the relay of this run
    const relay = Bun.spawn([server.command, ...server.args], { stdin: "pipe", stdout: "pipe" });
    relay.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })}\n`); relay.stdin.end();
    const reply = JSON.parse((await new Response(relay.stdout).text()).trim());
    expect(reply.result.tools.map((t: { name: string }) => t.name)).toContain("agent_ls");
    // an OmO without the call loads the extension and gets no tool
    expect(() => extension({})).not.toThrow();
    forgetLocalRun("t1");
    expect(existsSync(file)).toBe(false);
    }
  } finally { useAgentToolHub(null); serveRuntime(null); hub.close(); rmSync(dir,{recursive:true,force:true}); }
});
