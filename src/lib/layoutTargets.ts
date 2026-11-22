import { HC_OTHER_WORKSPACE_ID } from "../../shared/machines.ts";
import type { HerdrPane, HerdrWorkspace } from "../../shared/protocol.ts";

/**
 * The layout calls a herdr-core PC offers (lib/machineContext.tsx LayoutOffer) that its adapter
 * still refuses for some targets (server/herdr-core/adapter.ts), so the menus leave those out too.
 * Splits go by the pane's `own_tab`; herdr's TUI has no Other terminals and no `parent_pane_id`.
 */

export const renamesWorkspace = (workspaceId: string): boolean => workspaceId !== HC_OTHER_WORKSPACE_ID;

export const moveDestinations = (workspaces: readonly HerdrWorkspace[], pane: HerdrPane | undefined, from: string): HerdrWorkspace[] =>
  workspaces.filter((entry) => entry.workspace_id !== from && !(entry.workspace_id === HC_OTHER_WORKSPACE_ID && pane?.parent_pane_id !== undefined));
