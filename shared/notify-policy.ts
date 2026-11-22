import type { AgentStatus, PaneInfo } from "./herdr-api.generated.ts";
import { paneStorageId } from "./machines.ts";
import { shortPathTitle, stripPaneChrome } from "./pane-title.ts";

export function shouldNotifyStatus(previous: AgentStatus | undefined, next: AgentStatus): boolean {
  if (previous === undefined) return false;
  if (previous === next) return false;
  return next === "blocked" || next === "done";
}

export function alertStatus(status: AgentStatus, backgroundWorkRuns: boolean | undefined): AgentStatus {
  return backgroundWorkRuns === true && status !== "working" && status !== "blocked" ? "working" : status;
}

export function paneTitle(pane: Pick<PaneInfo, "pane_id" | "cwd" | "terminal_title" | "terminal_title_stripped">): string {
  const title = pane.terminal_title_stripped ?? pane.terminal_title;
  // herdr-core reports a title no program set as "": that is none, and the folder names the pane (#3231)
  return title?.trim() ? title : pane.cwd || pane.pane_id;
}

export function pushPaneTitle(pane: Parameters<typeof paneTitle>[0] & Pick<PaneInfo, "agent" | "label">): string {
  return pane.label?.trim() || shortPathTitle(stripPaneChrome(paneTitle(pane), pane.agent, true)) || pane.pane_id;
}

const STATUS_BODY: Readonly<Record<string, string>> = {
  blocked: "waiting for your input",
  done: "work finished",
};

export function statusNotificationBody(status: AgentStatus): string {
  return STATUS_BODY[status] ?? String(status);
}

export const ENDED_NOTIFICATION_BODY = "terminal ended";
export const PERMISSION_NOTIFICATION_BODY = "waiting for your permission";
export const ERROR_NOTIFICATION_BODY = "stopped on an error";

export function paneNotificationTag(paneId: string, machineId = "local"): string {
  return machineId === "local" ? `herdr-pane-${paneId}` : `herdr-remote-${encodeURIComponent(machineId)}-${encodeURIComponent(paneId)}`;
}

/**
 * What one device wants to be alerted about. `input`: an agent waiting on the user.
 * `done`: a finished turn: never, only after one that worked a while (`long`, the default:
 * a quick answer is read where it was asked), or every one.
 * `permission`: an agent that said it waits for a permission (herdr-core's `agent_kind`); absent,
 * it follows `input`, as it did before there was a choice. A blocked agent that does not say what it
 * waits for is `input`. `error`: a turn that stopped on an error (OmO and GJC say so); absent is off.
 * `pcs_off`: the PCs whose panes this device hears nothing of, each by its relay ID where it has one
 * (one both its own server and every roster know it by), else by its name; absent is none.
 */
export type DoneAlerts = "off" | "long" | "always";
export interface AlertPrefs {
  input: boolean;
  done: DoneAlerts;
  permission?: boolean;
  error?: boolean;
  pcs_off?: string[];
}
export const DEFAULT_ALERTS: AlertPrefs = { input: true, done: "long" };

/** What an alert is about, as the push says (shared/push.ts PushPayload `kind`). */
export type AlertKind = "input" | "permission" | "done" | "ended" | "error";

export const ALERT_PCS_MAX = 64;

export function parseAlertPcs(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((name): name is string => typeof name === "string" && name.length > 0 && name.length <= 200))].slice(0, ALERT_PCS_MAX);
}

export function parseAlerts(value: unknown): AlertPrefs {
  const record = typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
  const done = record["done"];
  const pcsOff = parseAlertPcs(record["pcs_off"]);
  return {
    input: typeof record["input"] === "boolean" ? record["input"] : DEFAULT_ALERTS.input,
    done: done === "off" || done === "long" || done === "always" ? done : DEFAULT_ALERTS.done,
    ...(typeof record["permission"] === "boolean" ? { permission: record["permission"] } : {}),
    ...(typeof record["error"] === "boolean" ? { error: record["error"] } : {}),
    ...(pcsOff.length > 0 ? { pcs_off: pcsOff } : {}),
  };
}

/** What a blocked pane waits for, by what its agent reported (`agent_kind`, herdr-core only). */
export function blockedAlertKind(agentKind: string | null | undefined): "input" | "permission" {
  return agentKind === "permission" ? "permission" : "input";
}

export function alertKindAllowed(prefs: AlertPrefs, kind: AlertKind): boolean {
  switch (kind) {
    case "input": return prefs.input;
    case "permission": return prefs.permission ?? prefs.input;
    case "done":
    case "ended": return prefs.done !== "off";
    case "error": return prefs.error === true;
  }
}

export function alertPcAllowed(prefs: AlertPrefs, ...keys: readonly (string | undefined)[]): boolean {
  const off = prefs.pcs_off ?? [];
  return !keys.some((key) => key !== undefined && off.includes(key));
}

export function alertsAllow(prefs: AlertPrefs, status: AgentStatus, agentKind?: string | null): boolean {
  if (status === "blocked") return alertKindAllowed(prefs, blockedAlertKind(agentKind));
  if (status === "done") return prefs.done !== "off";
  return false;
}

export function paneAlertsMuted(mutedPanes: readonly string[] | null | undefined, machineId: string, paneId: string): boolean {
  return mutedPanes != null && mutedPanes.includes(paneStorageId(machineId, paneId));
}
