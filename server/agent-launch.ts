import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, type Stats } from "node:fs";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { freeAgentName } from "./agent-name.ts";
import { launchedAgents } from "./launched-agents.ts";
import { isShellAgentKind, startShellAgent, type ShellAgentLocator } from "./shell-agent.ts";
import { agentStart, HerdrError, sessionSnapshot } from "./herdr/client.ts";
import { requestFault } from "./http.ts";
import { agentStartArgs } from "./claude-settings-file.ts";
import type { ApprovalHub } from "./approvals/hub.ts";
import type { CodexServers } from "./approvals/codex.ts";
import { DSH_EFFORTS, launchArgsFault } from "../shared/launch-rules.ts";
import { browserToolArgs, browserToolChoices, browserToolConfig, isBrowserToolAgent, withBrowserToolArgs } from "../shared/browser-tools.ts";
import { hcMachine } from "./herdr-core/runtime.ts";
import { capabilities } from "./runtime/capabilities.ts";
import { userHome } from "./user-home.ts";
import { forgetLocalRun, launchHarnessTool, markLocalAgentLaunch } from "./agent-tools/launch.ts";

export type AgentPayload = { kind?: unknown; name?: unknown; args?: unknown };

export function agentFault(agent: AgentPayload | undefined): string | null {
  if (agent === undefined) return null;
  if (typeof agent !== "object" || typeof agent.kind !== "string" || agent.kind.length === 0) return "agent.kind is required";
  if ((agent.name !== undefined && typeof agent.name !== "string")
    || (agent.args !== undefined && (!Array.isArray(agent.args) || !agent.args.every((arg) => typeof arg === "string")))) {
    return "agent.name must be a string and agent.args must be an array of strings";
  }
  // the dialog's model, effort and Codex prompt, checked as the dialog checks them: a client is not trusted to
  return agent.args === undefined ? null : launchArgsFault(agent.kind, agent.args as string[]);
}

/**
 * A dsh-tui launch's arguments without `--effort <level>`, which dsh-tui 0.20.0 has no flag for, and the level they
 * named. Read as launchArgsFault reads them: only before `--` (what follows is passed on as it is), and a level
 * outside DSH_EFFORTS is no level, so nothing the check would refuse is ever saved.
 */
export function dshEffortArgs(args: readonly string[]): { args: string[]; effort: string | undefined } {
  const rest: string[] = [];
  let effort: string | undefined;
  for (let at = 0; at < args.length; at++) {
    const arg = args[at]!;
    if (arg === "--") { rest.push(...args.slice(at)); break; }
    let value: string | undefined;
    if (arg === "--effort") value = args[++at] ?? "";
    else if (arg.startsWith("--effort=")) value = arg.slice("--effort=".length);
    else { rest.push(arg); continue; }
    effort = (DSH_EFFORTS as readonly string[]).includes(value) ? value : undefined;
  }
  return { args: rest, effort };
}

/**
 * Starts dsh-tui with its `--effort <level>` saved to `<home>/.dsh-tui/effort.json` instead, the file dsh-tui's own
 * `/effort <id>` writes and its boot reads (lib/types/effortPrefs.js), so the session starts on it and later ones
 * keep it, as after `/effort`; a /settings "default reasoning effort" set in dsh-tui still outranks it there. The
 * file is written just before the command is typed, since dsh-tui reads it as it boots, and put back as it was when
 * the start fails, unless something else wrote it meanwhile (even the same level). One file serves every dsh-tui and
 * none takes a level of its own, so two launches at about the same time may both start on the later level. With no
 * home a chosen level cannot be saved, so dsh-tui is not started.
 */
async function startDshTui(paneId: string, args: string[], options: { locator?: ShellAgentLocator }, home: string): Promise<number | null> {
  const { args: rest, effort } = dshEffortArgs(args);
  if (effort === undefined) return startShellAgent("dsh-tui", paneId, rest, options);
  if (home === "") throw new Error("the effort level could not be saved to ~/.dsh-tui/effort.json: this server has no home folder (HOME is not set)");
  const file = join(home, ".dsh-tui", "effort.json");
  const before = existsSync(file) ? readFileSync(file, "utf8") : null;
  const written = JSON.stringify({ effort }, null, 2);
  mkdirSync(join(home, ".dsh-tui"), { recursive: true });
  writeFileSync(file, written);
  const same = (stats: Stats, then: Stats): boolean => stats.ino === then.ino && stats.size === then.size && stats.mtimeMs === then.mtimeMs && stats.ctimeMs === then.ctimeMs;
  const ours = statSync(file);
  try {
    return await startShellAgent("dsh-tui", paneId, rest, options);
  } catch (error) {
    try {
      if (existsSync(file) && same(statSync(file), ours) && readFileSync(file, "utf8") === written) {
        if (before === null) rmSync(file);
        else writeFileSync(file, before);
      }
    } catch (restoreError) {
      console.warn(`dsh-tui effort: ${file} could not be put back (${restoreError instanceof Error ? restoreError.message : String(restoreError)})`);
    }
    throw error;
  }
}

let approvals: { hub: ApprovalHub; version: (kind: string) => Promise<string | null>; codex: CodexServers | null } | null = null;

/**
 * What an agent this server starts asks its approvals through (server/approvals/hub.ts), and how its installed version
 * is read, which decides whether it gets the hook; and where a Codex gets its own app server (server/approvals/codex.ts).
 */
export function useApprovalHub(hub: ApprovalHub | null, version: (kind: string) => Promise<string | null> = async () => null, codex: CodexServers | null = null): void {
  approvals = hub === null ? null : { hub, version, codex };
}

/**
 * The launcher a Codex starts through on its own app server, or undefined for one that starts as before: only where the
 * runtime can run a launcher (herdr-core), on this PC, never on Windows, and for the versions it was measured on.
 */
async function codexLauncher(kind: string, paneId: string, args: string[] | undefined, platform: string): Promise<string | undefined> {
  if (kind !== "codex" || approvals?.codex == null || !capabilities().launcher || hcMachine() !== null || platform === "win32") return undefined;
  return approvals.codex.launch(paneId, args, await approvals.version(kind)) ?? undefined;
}

let browserTools: { read: () => unknown; dir: string } | null = null;

/** Where the launch reads the shared `agentBrowserTools` setting from, and the folder its MCP config files go in. */
export function readBrowserToolSetting(read: () => unknown, dir: string): void {
  browserTools = { read, dir: resolve(dir) };
}

/**
 * `args` with the browser tool chosen for this agent, if any (shared/browser-tools.ts). Claude Code and Copilot read
 * it from a file in this PC's state folder, so an agent another machine of the core starts gets none: it would look
 * for the file there.
 */
export function withBrowserTool(kind: string, args: string[] | undefined, platform: string): string[] | undefined {
  if (browserTools === null || !isBrowserToolAgent(kind)) return args;
  const tool = browserToolChoices(browserTools.read())[kind];
  if (tool === undefined) return args;
  let file = "";
  if (kind !== "codex") {
    if (hcMachine() !== null) {
      console.warn(`browser tool: not added to ${kind}, which starts on another machine than this PC's config file`);
      return args;
    }
    file = join(browserTools.dir, `${kind}-${tool}.json`);
    const config = browserToolConfig(kind, tool, platform);
    if (!existsSync(file) || readFileSync(file, "utf8") !== config) {
      mkdirSync(browserTools.dir, { recursive: true, mode: 0o700 });
      // a new file renamed over the old one: a link left at that name is replaced, never written through
      const staged = `${file}.${randomUUID()}.tmp`;
      try {
        writeFileSync(staged, config, { flag: "wx", mode: 0o600 });
        renameSync(staged, file);
      } catch (error) {
        rmSync(staged, { force: true });
        throw error;
      }
    }
  }
  return withBrowserToolArgs(args ?? [], browserToolArgs(kind, tool, platform, file));
}

export async function agentLaunch(paneId: string, agent: AgentPayload, launched?: (pid: number) => void, locator?: ShellAgentLocator, options: { platform?: string; settingsDir?: string; home?: string } = {}): Promise<{ agent_started: true } | { agent_started: false; error: { code: string; message: string } }> {
  let program: string | undefined;
  let tool: ReturnType<typeof launchHarnessTool> = null;
  try {
    const kind = agent.kind as string;
    const shell = isShellAgentKind(kind);
    // another machine of the core: its path would be this PC's, and its start is never seen there (no pids)
    if (shell && hcMachine() !== null) return { agent_started: false, error: { code: "other_machine", message: `${kind} starts only on the PC that runs Ovis` } };
    // an agent another machine of the core starts could not reach this PC's hub
    const args = approvals !== null && approvals.hub.handles(kind) && hcMachine() === null
      ? approvals.hub.launchArgs(kind, paneId, agent.args as string[] | undefined, await approvals.version(kind)) : agent.args as string[] | undefined;
    await markLocalAgentLaunch(paneId, options.platform ?? process.platform);
    if (shell) {
      const shellOptions = locator ? { locator } : {};
      tool = kind === "dsh-tui" ? null : launchHarnessTool(paneId, kind, { args, platform: options.platform ?? process.platform, browsers: null });
      const pid = kind === "dsh-tui" && args !== undefined
        ? await startDshTui(paneId, args, shellOptions, options.home ?? userHome())
        : await startShellAgent(kind, paneId, tool?.args ?? args, tool ? { ...shellOptions, env: { OVIS_AGENT_SOCKET: tool.socket, OVIS_AGENT_TOKEN_FILE: tool.tokenFile } } : shellOptions);
      if (pid !== null) launched?.(pid);
      await tool?.confirmed();
    }
    else {
      const given = typeof agent.name === "string" && agent.name.length > 0 ? agent.name : null;
      // on Windows a Claude Code's inline JSON --settings goes as a file's path (server/claude-settings-file.ts)
      tool = launchHarnessTool(paneId, kind, { args, platform: options.platform ?? process.platform, browsers: browserTools?.read() });
      const launchArgs = tool?.args ?? withBrowserTool(kind, args, options.platform ?? process.platform);
      const startArgs = launchArgs === undefined ? undefined : agentStartArgs(kind, launchArgs, { platform: options.platform, dir: options.settingsDir });
      program = await codexLauncher(kind, paneId, startArgs, options.platform ?? process.platform);
      // herdr refuses a name another agent holds. Two creations at once can pick the same
      // free one: the refused one picks again. It also refuses a pane whose shell is not up
      // yet (`agent_pane_busy`, herdr 0.9.3), which a pane made a moment ago can be.
      const shellDeadline = Date.now() + 10_000;
      for (let attempt = 1; ; ) {
        try {
          await agentStart({
            name: given ?? freeAgentName(kind, (await sessionSnapshot()).agents.map((running) => running.name)),
            kind,
            paneId,
            ...(startArgs === undefined ? {} : { args: startArgs }),
            ...(program === undefined ? {} : { program }),
            ...(tool ? { toolDoor: { socket: tool.socket, tokenFile: tool.tokenFile } } : {}),
            timeoutMs: 60_000,
          });
          await tool?.confirmed();
          break;
        } catch (error) {
          if (!(error instanceof HerdrError)) throw error;
          if (error.code === "agent_pane_busy" && Date.now() < shellDeadline) {
            await Bun.sleep(100);
            continue;
          }
          if (given !== null || attempt === 3 || error.code !== "agent_name_taken") throw error;
          attempt += 1;
        }
      }
    }
    forgetLocalRun(paneId, tool?.id);
    launchedAgents.launched(paneId, kind);
    return { agent_started: true };
  } catch (error) {
    // a launcher that never ran: its folder goes, and Ovis stops waiting for its server
    tool?.cancel();
    if (program !== undefined) approvals?.codex?.abandon(paneId, program);
    return {
      agent_started: false,
      error: requestFault(error, "agent_start_failed"),
    };
  }
}
