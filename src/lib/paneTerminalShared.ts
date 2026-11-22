import type { Terminal } from "@xterm/xterm";
import { HerdrSocket } from "./ws.ts";
import { userErrorMessage } from "./userError.ts";

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
export const VIEW_BUFFER_MAX = 512 * 1024;
export const VIEW_HOLD_MS = 1000;

declare const __HERDR_TEST_HOOKS__: boolean;
export interface TerminalTimerTestWindow extends Window {
  __herdrTestTerminalTimeout?: (run: () => void, delay: number) => number;
}

/** Lets browser regressions track terminal work without counting unrelated timers with the same delay. */
export function setTerminalTimeout(run: () => void, delay: number): number {
  const timers: TerminalTimerTestWindow = window;
  if (typeof __HERDR_TEST_HOOKS__ === "boolean" && __HERDR_TEST_HOOKS__ && timers.__herdrTestTerminalTimeout) {
    return timers.__herdrTestTerminalTimeout(run, delay);
  }
  return timers.setTimeout(run, delay);
}

// A switch's pane attaches before the hidden recent tabs' views start or stop: herdr serves a
// starting view and the attach in turn, so a view started beside it delays the pane the user picked.
const viewHold = { held: false, queued: new Set<() => void>(), timer: 0 };

export function holdViews(): void {
  viewHold.held = true;
  window.clearTimeout(viewHold.timer);
  viewHold.timer = setTerminalTimeout(releaseViews, VIEW_HOLD_MS);
}

export function releaseViews(): void {
  if (!viewHold.held) return;
  viewHold.held = false;
  window.clearTimeout(viewHold.timer);
  const run = [...viewHold.queued];
  viewHold.queued.clear();
  for (const change of run) change();
}

export function afterSwitch(change: () => void): void {
  // the switch's own effects run in the same commit: a microtask sees the hold its pane set
  queueMicrotask(() => {
    if (viewHold.held) viewHold.queued.add(change);
    else change();
  });
}

export function dropViewChange(change: () => void): void {
  viewHold.queued.delete(change);
}

// Only a tab the user is in drives the shared grid. A window left open behind another app
// still turns visible when the screen wakes, and reconnects, reloads or moves on to the next pane
// in the background: taking the pane then sized it for nobody, and herdr's own TUI drew it cut
// off at its split's edge
export const inUse = (): boolean => document.visibilityState === "visible" && document.hasFocus();

/**
 * A herdr-core pane's stream is the program's own bytes, drawn for the pty's grid (`terminal-history`): a page attached
 * without sizing the pty draws it in that grid, as an observer does, until it sizes the pty again.
 */
export const keepsCoreGrid = (socket: HerdrSocket | null, pane: string | null): boolean =>
  pane !== null && socket !== null && socket.hasTerminalHistory() && socket.keepsSize(pane);

/** Draws a kept herdr-core pty in its grid as last heard (another device may have sized it meanwhile): whether that moved the grid. */
export function takeKeptCoreGrid(term: Terminal, socket: HerdrSocket | null, pane: string | null, shared: { cols: number; rows: number } | null): boolean {
  if (!shared || !keepsCoreGrid(socket, pane) || (term.cols === shared.cols && term.rows === shared.rows)) return false;
  term.resize(shared.cols, shared.rows);
  return true;
}

export const connectedSockets = new WeakSet<HerdrSocket>();

/** A character a terminal takes as a key (a line break reaches the program as Enter): never pasted inside a stored file's path. */
export const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;

export const plainError = (cause: unknown): string => {
  const failure = userErrorMessage(cause);
  return failure.detail === null ? failure.message : `${failure.message} (${failure.detail})`;
};

export type StillOpen = { pane: string; agent: string; command: string; named: boolean; history: string | undefined };
