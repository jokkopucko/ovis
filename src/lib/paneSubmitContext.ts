import { createContext } from "react";
import type { PaneSubmitRetention } from "./paneSubmitRetention.ts";

export const PaneSubmitContext = createContext<PaneSubmitRetention | null>(null);
export const PanePresentedContext = createContext(true);
export const PaneCachedContext = createContext(false);
/** A cached pane among the most recent ones also watches its pane while this window is in use. */
export const PaneWatchedContext = createContext(false);
/** false for a split tab's pane a phone keeps hidden behind the one it shows: it must not size the shared pty */
export const PaneShownContext = createContext(true);
/**
 * true for a pane the inbox mode's list stands over (App.tsx): the list takes the shell's bars away, so the pane is laid
 * out in another box than the one its pty was sized to. It sizes nothing while covered and keeps its hold on the size,
 * as it does under a phone's open drawer; shown again, it fits the box it is shown in.
 */
export const PaneCoveredContext = createContext(false);
/** true in the split half that is not active while both halves draw one tab: the active half sizes the
 *  pty, and this half draws its screen at that grid instead of taking it (lib/split.ts) */
export const PaneFollowContext = createContext(false);
export const PanePressContext = createContext<((machineId: string, paneId: string) => void) | null>(null);
