import type { HerdrPane, PluginActionResult, SessionSnapshot } from "../shared/protocol.ts";
import { HerdrError, type PluginCommandLog, type PluginInvocationContext } from "./herdr/client.ts";

/** Every entry herdr keeps in a plugin's command log (0.9.3: src/app/api/plugins/runtime.rs). */
export const PLUGIN_LOG_LIMIT = 200;

/**
 * The entry of one run in the plugin's log, searched over all herdr keeps, so a run that is still
 * listed is found however many newer runs of the plugin came after it.
 */
export async function pluginLogEntry(logId: string, list: (limit: number) => Promise<PluginCommandLog[]>): Promise<PluginCommandLog> {
  const log = (await list(PLUGIN_LOG_LIMIT)).find((entry) => entry.log_id === logId);
  if (!log) throw new HerdrError("plugin_log_not_found", `plugin log ${logId} not found`);
  return log;
}

const PLUGIN_OUTPUT_CHARS = 2_000;

/**
 * "This workspace is no git checkout", in the only form herdr keeps: it reads a worktree of null
 * as left out and fills it from its own focus, and refuses an object without every field
 * (measured on 0.9.3).
 */
const NO_WORKTREE = { repo_key: "", repo_name: "", repo_root: "", checkout_path: "", is_linked_worktree: false };

/**
 * The whole invocation context of one pane. herdr fills every field the caller leaves out, or
 * sends as null, from its OWN focus, never from the pane the other fields name (measured on
 * 0.9.3: a shell pane outside a repository came back with the focused workspace's worktree and
 * the focused pane's agent). So nothing is left out: what the pane does not have goes as an empty
 * string, and no worktree as `NO_WORKTREE`.
 */
export function pluginPaneContext(snapshot: SessionSnapshot, pane: HerdrPane): PluginInvocationContext {
  const workspace = snapshot.workspaces.find((entry) => entry.workspace_id === pane.workspace_id);
  const tab = snapshot.tabs.find((entry) => entry.tab_id === pane.tab_id);
  const cwd = pane.foreground_cwd ?? pane.cwd ?? "";
  return {
    workspace_id: pane.workspace_id,
    workspace_label: workspace?.label ?? "",
    workspace_cwd: cwd,
    worktree: workspace?.worktree ?? NO_WORKTREE,
    tab_id: pane.tab_id,
    tab_label: tab?.label ?? "",
    focused_pane_id: pane.pane_id,
    focused_pane_cwd: cwd,
    focused_pane_agent: pane.agent ?? "",
    focused_pane_status: pane.agent_status,
    invocation_source: "ovis",
  };
}

/**
 * The pane this run itself says it opened with focus: the answer `herdr plugin pane open --focus`
 * prints, found in the run's own stdout. Nothing else ties a pane to an invocation: herdr's invoke
 * answer names none and a pane carries no plugin ID, so a pane that merely appeared while the
 * command ran (one made in herdr's TUI, say) is never taken for the action's. A command that
 * keeps that answer to itself gets null.
 */
export function openedPluginPane(stdout: string | null | undefined): string | null {
  let opened: string | null = null;
  for (const line of (stdout ?? "").split("\n")) {
    if (!line.includes("plugin_pane_opened")) continue;
    let answer: unknown;
    try {
      answer = JSON.parse(line);
    } catch {
      continue;
    }
    const result = (answer as { result?: { type?: unknown; plugin_pane?: { pane?: { pane_id?: unknown; focused?: unknown } } } } | null)?.result;
    const pane = result?.type === "plugin_pane_opened" ? result.plugin_pane?.pane : undefined;
    if (pane?.focused === true && typeof pane.pane_id === "string") opened = pane.pane_id;
  }
  return opened;
}

const PANE_LOOKUP_FLOOR_MS = 1_000;

export async function waitForPluginAction(
  started: PluginCommandLog,
  waitMs: number,
  poll: (timeoutMs: number) => Promise<PluginCommandLog[]>,
  paneIds: (timeoutMs: number) => Promise<string[]>,
): Promise<PluginActionResult> {
  const deadline = Date.now() + waitMs;
  let log = started;
  while (log.status === "running" && deadline - Date.now() > 0) {
    await Bun.sleep(Math.min(100, deadline - Date.now()));
    const left = deadline - Date.now();
    if (left <= 0) break;
    try {
      log = (await poll(left)).find((entry) => entry.log_id === started.log_id) ?? log;
    } catch {
      break;
    }
  }
  return pluginActionResult(log, () => paneIds(Math.max(deadline - Date.now(), PANE_LOOKUP_FLOOR_MS)));
}

export function pluginActionResult(log: PluginCommandLog, paneIds: () => Promise<string[]>): Promise<PluginActionResult> {
  const failed = log.status === "failed";
  const said = failed ? (log.error || log.stderr || log.stdout || "").trim() : "";
  const result: PluginActionResult = {
    log_id: log.log_id,
    status: failed ? "failed" : log.status === "succeeded" ? "succeeded" : "running",
    exit_code: log.exit_code ?? null,
    output: said === "" ? null : said.slice(-PLUGIN_OUTPUT_CHARS),
    opened_pane_id: null,
  };
  const named = log.status === "succeeded" ? openedPluginPane(log.stdout) : null;
  if (named === null) return Promise.resolve(result);
  return paneIds().then((ids) => ({ ...result, opened_pane_id: ids.includes(named) ? named : null }), () => result);
}
