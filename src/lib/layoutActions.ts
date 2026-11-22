import type { SessionSnapshot } from "../../shared/protocol.ts";
import type { AppActions } from "./actions.ts";
import { splitPane, zoomPane } from "./api.ts";
import { zoomMode, type ZoomMode } from "./layoutMap.ts";
import type { LayoutOffer } from "./machineContext.tsx";
import { selectionStill, type SelectionMark } from "./selectionMark.ts";

/**
 * herdr's layout calls on the selected pane, for the palette and the split shortcuts
 * (components/TabStrip.tsx has the same for the tab's own menu): the new layout reaches every
 * client as session-changed, so only a refusal is left to say, and that is logged as other
 * background failures are. Both are null without a pane, and each on a PC whose herdr does not
 * answer it (lib/machineContext.tsx AppLayoutContext: herdr-core never zooms, and splits only where
 * Ovis keeps its layout), so the palette does not list it and the shortcut does nothing there.
 */
export function layoutActions({ selectedPaneId, offer, paneSplits, selection, roster, load, selectPane, layoutRefused }: {
  selectedPaneId: string | null;
  offer: Pick<LayoutOffer, "split" | "arrange">;
  /** false for a pane in a tab of its own terminal, which herdr-core does not split (HerdrPane `own_tab`) */
  paneSplits: boolean;
  selection: { readonly current: SelectionMark };
  roster: { readonly current: Pick<SessionSnapshot, "panes" | "layouts"> | null };
  load: () => unknown;
  selectPane: (paneId: string) => void;
  layoutRefused: (what: string, err: unknown) => void;
}): Pick<AppActions, "splitPane" | "zoomPane" | "toggleZoom"> {
  if (selectedPaneId === null) return { splitPane: null, zoomPane: null, toggleZoom: null };
  let asked: { paneId: string; mode: ZoomMode } | null = null;
  const zoom = (mode: ZoomMode): void => {
    const { machineId, paneId } = selection.current;
    if (paneId === null) return;
    const request = { paneId, mode };
    asked = request;
    void zoomPane(paneId, mode, machineId).then(() => load()).catch((err) => layoutRefused("pane zoom failed", err))
      .finally(() => { if (asked === request) asked = null; });
  };
  return {
    splitPane: !offer.split || !paneSplits ? null : (direction, focus = false) => {
      const asked = selection.current;
      if (asked.paneId === null) return;
      void splitPane(asked.paneId, direction, focus, asked.machineId)
        .then((pane) => {
          void load();
          // herdr focused the new pane: the app follows, unless another pane or PC was opened
          // while herdr answered (over SSH, say): what the user went to is theirs to keep
          if (focus && selectionStill(asked, selection.current)) selectPane(pane.pane_id);
        })
        .catch((err) => layoutRefused("pane split failed", err));
    },
    zoomPane: !offer.arrange ? null : zoom,
    // the mode the palette's row would name (lib/layoutMap.ts zoomMode), never herdr's toggle
    toggleZoom: !offer.arrange ? null : () => {
      const { paneId } = selection.current;
      const tabId = roster.current?.panes.find((pane) => pane.pane_id === paneId)?.tab_id;
      const layout = roster.current?.layouts.find((entry) => entry.tab_id === tabId);
      const panes = roster.current?.panes.filter((pane) => pane.tab_id === tabId).length ?? 0;
      if (paneId === null || !layout || panes < 2) return;
      zoom(asked?.paneId === paneId ? (asked.mode === "on" ? "off" : "on") : zoomMode(layout, paneId));
    },
  };
}
