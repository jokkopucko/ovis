import type { PaneInfo, SessionSnapshot } from "../../shared/protocol.ts";
import type { Translate } from "./i18n.ts";
import { tabLabel } from "./tabName.ts";

/**
 * The pane region the tab strip governs. Every tab's `aria-controls` points at this id
 * (TabStrip.tsx); the region carries the panel role and the governing tab's name (App.tsx), so
 * a screen reader relates the tab it is on to the pane that tab selects.
 */
export const PANE_TABPANEL_ID = "pane-tabpanel";

export function paneTabPanelLabel(snapshot: SessionSnapshot | null, pane: PaneInfo | null, t: Translate): string | null {
  if (snapshot === null || pane === null) return null;
  const tabs = snapshot.tabs.filter((tab) => tab.workspace_id === pane.workspace_id);
  const tab = tabs.find((candidate) => candidate.tab_id === pane.tab_id);
  return tab === undefined ? null : tabLabel(tab, t, tabs.indexOf(tab) + 1);
}
