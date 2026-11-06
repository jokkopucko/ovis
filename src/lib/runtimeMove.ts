/**
 * The move of this PC's whole herdr session to herdr-core (shared/runtime-move.ts), as Settings
 * shows it: what each pane becomes, in a tag; which panes hold the move up; the panes of a tab in
 * the order its splits put them; and the agents whose input line Ovis could not read.
 */
import { AGENT_CATALOG } from "../../shared/agent-catalog.ts";
import type { MoveNode, MovePane, MovePlan, MoveStatus, MoveVerdict } from "../../shared/runtime-move.ts";
import type { Translate } from "./i18n.ts";

/**
 * How a pane's verdict reads: `ok` goes on as it was, `plain` is replaced by one like it, `warn`
 * starts over, `wait` holds the move up until it is done, `you` holds it up until the person acts.
 */
export type MoveTone = "ok" | "plain" | "warn" | "wait" | "you";

export interface MoveTag { text: string; tone: MoveTone }

/** The agent's product name ("Claude Code"), or the kind itself for one the catalog does not list. */
export function agentName(kind: string): string {
  return AGENT_CATALOG.find((entry) => entry.id === kind)?.name ?? kind;
}

/** What becomes of a pane, as its tag says it. */
export function verdictTag(t: Translate, verdict: MoveVerdict): MoveTag {
  switch (verdict.kind) {
    case "resume": return { text: t("Continues the same conversation"), tone: "ok" };
    case "fresh": return { text: t("Starts new (no conversation found)"), tone: "warn" };
    case "shell": return { text: t("New shell in the same folder"), tone: "plain" };
    case "needs_you": return { text: t("End it yourself"), tone: "you" };
    case "busy": {
      switch (verdict.reason) {
        case "agent_working": return { text: t("Answering"), tone: "wait" };
        case "agent_waiting": return { text: t("Waiting for an answer"), tone: "wait" };
        case "command_running": return { text: verdict.command === null ? t("A command is running") : t("{command} running", { command: verdict.command }), tone: "wait" };
        default: return unreachable(verdict.reason);
      }
    }
    default: return unreachable(verdict);
  }
}

export function paneAgent(pane: MovePane): string | null {
  const { verdict } = pane;
  switch (verdict.kind) {
    case "resume": case "fresh": case "needs_you": case "busy": return verdict.agent;
    case "shell": return null;
    default: return unreachable(verdict);
  }
}

/** The pane's title: the name the person gave it, else its agent's name, else Shell. */
export function paneTitle(t: Translate, pane: MovePane): string {
  if (pane.name !== null) return pane.name;
  const agent = paneAgent(pane);
  return agent === null ? t("Shell") : agentName(agent);
}

/** The panes that hold the move up: an agent at work or waiting, a shell running a command, an agent the person must end. */
export function blockingPanes(plan: MovePlan): MovePane[] {
  return plan.panes.filter((pane) => pane.verdict.kind === "busy" || pane.verdict.kind === "needs_you");
}

/** A tab's pane ids in reading order: a split's left or top side first, then the other. */
export function tabPaneIds(node: MoveNode): string[] {
  return "pane" in node ? [node.pane] : [...tabPaneIds(node.first), ...tabPaneIds(node.second)];
}

export function moveInProgress(status: MoveStatus): boolean {
  return status.state === "waiting" || status.state === "moving";
}

export function moveStepText(t: Translate, step: Extract<MoveStatus, { state: "moving" }>["step"]): string {
  switch (step) {
    case "ending_agents": return t("Ending the agents in herdr");
    case "building": return t("Rebuilding the workspaces, tabs and splits on herdr-core");
    case "starting_agents": return t("Reopening the agents on herdr-core");
    case "switching": return t("Switching Ovis to herdr-core");
    default: return unreachable(step);
  }
}

function unreachable(value: never): never {
  throw new Error(`unexpected value ${JSON.stringify(value)}`);
}

/** The reason a move stopped, as the person reads it; the server's own words only for an unexpected failure. */
export function moveReasonText(t: Translate, reason: string): string {
  if (reason === "agent_busy") return t("An agent started working again.");
  if (reason === "input_left") return t("Text was left in an agent's input box.");
  if (reason === "agent_did_not_exit" || reason === "no_exit_command") return t("An agent did not end in time.");
  if (reason === "plan_changed" || reason === "not_ready") return t("The panes changed since you looked: look again.");
  if (reason === "herdr_app") return t("The Herdr app arranges herdr-core on this PC.");
  if (reason.startsWith("switch_refused")) return t("The switch to herdr-core was refused.");
  if (reason === "switch_not_started") return t("The switch to herdr-core did not come up; the agents run there. Switch again in Settings.");
  if (reason === "resume_unconfirmed") return t("An agent did not reopen its conversation on herdr-core.");
  if (reason === "runtime_switching") return t("The server was switching its runtime.");
  if (reason === "server_stopped") return t("A server stopped partway; nothing was put back. Check the agents listed below.");
  return t("Something failed: {detail}", { detail: reason.replace(/^failed: /, "") });
}

/** Why an agent was not reopened in herdr, as the person reads it. */
export function moveWhyText(t: Translate, why: string): string {
  if (why === "agent_still_there") return t("It is running again.");
  if (why === "pane_gone") return t("Its pane is gone.");
  if (why === "conversation_open_elsewhere") return t("Its conversation is open in another pane.");
  if (why === "herdr_core_not_cleared") return t("What was started on herdr-core could not be ended.");
  if (why === "server_stopped") return t("Ended when the server stopped.");
  if (why === "running_on_herdr_core") return t("Running on herdr-core.");
  return t("It could not start: {detail}", { detail: why.replace(/^start_failed: /, "") });
}
