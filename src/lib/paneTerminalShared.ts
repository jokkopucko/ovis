import { HerdrSocket } from "./ws.ts";
import { userErrorMessage } from "./userError.ts";

/** How long a resize must rest before the grid refits and the pty follows it. */
export const RESIZE_SETTLE_MS = 120;
/** How long a tab is out of use before it lets go of its pane: a glance at another window keeps it. */
export const RELEASE_AFTER_MS = 1000;
/**
 * How long a tab in use goes without typing, clicking or pasting in its terminal before it lets go of its pane too,
 * with Settings → Use alongside herdr's own window on (#712): a few seconds of reading the output keep it.
 */
export const IDLE_RELEASE_MS = 10_000;
/** How long keys typed to take an idle pane back wait for its attach before they are held for review instead. */
export const RESUME_INPUT_WAIT_MS = 5_000;
/** The most a hidden recent tab keeps of its view unparsed: past it, its return draws from the attach alone. */
export const VIEW_BUFFER_MAX = 512 * 1024;
/** How long hidden tabs' views wait for a switch's pane to draw its first output before they start or stop anyway. */
export const VIEW_HOLD_MS = 1000;

// A switch's pane attaches before the hidden recent tabs' views start or stop: herdr serves a
// starting view and the attach in turn, so a view started beside it delays the pane the user picked.
const viewHold = { held: false, queued: new Set<() => void>(), timer: 0 };

/** Called as a shown pane attaches: hidden tabs' view changes wait for its first output. */
export function holdViews(): void {
  viewHold.held = true;
  window.clearTimeout(viewHold.timer);
  viewHold.timer = window.setTimeout(releaseViews, VIEW_HOLD_MS);
}

/** The shown pane drew its first output (or the hold ran out): the waiting view changes run. */
export function releaseViews(): void {
  if (!viewHold.held) return;
  viewHold.held = false;
  window.clearTimeout(viewHold.timer);
  const run = [...viewHold.queued];
  viewHold.queued.clear();
  for (const change of run) change();
}

/** Runs a hidden tab's view change after the current commit, and after a switch's pane drew, if one is attaching. */
export function afterSwitch(change: () => void): void {
  // the switch's own effects run in the same commit: a microtask sees the hold its pane set
  queueMicrotask(() => {
    if (viewHold.held) viewHold.queued.add(change);
    else change();
  });
}

/** A terminal going away takes its waiting view change with it. */
export function dropViewChange(change: () => void): void {
  viewHold.queued.delete(change);
}

// Only a tab the user is in drives the shared grid. A window left open behind another app
// still turns visible when the screen wakes, and reconnects, reloads or moves on to the next pane
// in the background: taking the pane then sized it for nobody, and herdr's own TUI drew it cut
// off at its split's edge
export const inUse = (): boolean => document.visibilityState === "visible" && document.hasFocus();

/** The PC sockets this page has been connected to (lib/machineSession.ts keeps one per PC, across pane
    views and terminal mounts): not connected on one of them, a terminal is reconnecting; on any other, it
    is connecting for the first time. The words say which (here, ChatView and the header's chip). */
export const connectedSockets = new WeakSet<HerdrSocket>();

/** A failure as one line: the plain sentence, then what the server or the browser said. */
export const plainError = (cause: unknown): string => {
  const failure = userErrorMessage(cause);
  return failure.detail === null ? failure.message : `${failure.message} (${failure.detail})`;
};

export type StillOpen = { pane: string; agent: string; command: string; named: boolean; history: string | undefined };
