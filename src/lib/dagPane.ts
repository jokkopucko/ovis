import type { PaneInfo } from "../../shared/protocol.ts";
import { knownStatus } from "./status.ts";

/**
 * A pane omo-herdr-dag opened beside an OmO pane to draw its workflow in the TUI. Told the way
 * the plugin finds its own panes: the label it gives the pane (`DAG · <session>`) or the title
 * its viewer sets (`OmO DAG`). A viewer is no agent: a pane that has one, or that works or waits
 * for input, is never taken for it whatever it is called, so a pane left out of the roster is
 * never one a status, an alert or a close confirmation is about.
 */
export function isDagViewerPane(pane: PaneInfo): boolean {
  if (pane.agent) return false;
  const status = knownStatus(pane.agent_status);
  if (status === "working" || status === "blocked") return false;
  return (typeof pane.label === "string" && pane.label.startsWith("DAG · "))
    || pane.terminal_title === "OmO DAG" || pane.terminal_title_stripped === "OmO DAG";
}

export function rosterPanes<T extends PaneInfo>(panes: readonly T[], keep?: string | null): T[] {
  return panes.filter((pane) => pane.pane_id === keep || !isDagViewerPane(pane)
    || !panes.some((other) => other.tab_id === pane.tab_id && !isDagViewerPane(other)));
}
