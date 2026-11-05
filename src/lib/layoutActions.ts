import type { AppActions } from "./actions.ts";
import { splitPane, zoomPane } from "./api.ts";
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
export function layoutActions({ selectedPaneId, offer, selection, load, selectPane, layoutRefused }: {
  selectedPaneId: string | null;
  offer: Pick<LayoutOffer, "split" | "arrange">;
  /** App's selection as it is when herdr answers, not as it was when the call was made */
  selection: { readonly current: SelectionMark };
  load: () => unknown;
  selectPane: (paneId: string) => void;
  layoutRefused: (what: string, err: unknown) => void;
}): Pick<AppActions, "splitPane" | "zoomPane"> {
  if (selectedPaneId === null) return { splitPane: null, zoomPane: null };
  return {
    splitPane: !offer.split ? null : (direction, focus = false) => {
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
    zoomPane: !offer.arrange ? null : (mode) => {
      const { machineId, paneId } = selection.current;
      if (paneId === null) return;
      void zoomPane(paneId, mode, machineId).then(() => void load()).catch((err) => layoutRefused("pane zoom failed", err));
    },
  };
}
