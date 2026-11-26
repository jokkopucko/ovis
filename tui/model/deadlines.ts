/**
 * Named deadlines, each a time in ms on a clock the caller keeps (the loop's injected clock).
 * A value: setting or clearing a name answers a new one and leaves the old as it was, so the
 * model can hold it in its state. It reads no clock and starts no timer; the loop asks for the
 * earliest deadline and arms its one timer for that.
 */
export type Deadlines = ReadonlyMap<string, number>;

// The waits and limits of the screen, each named once here: code elsewhere uses these names, never a
// number of its own. Times are ms on the caller's clock.

/** How long a read that ends in a lone ESC, `ESC [` or `ESC O` waits for the rest before it is Escape, Alt+[ or Alt+O. */
export const ESC_WAIT_MS = 30;
/**
 * The same wait while the host reports the mouse or has the kitty keyboard flag on: a mouse report cut
 * after `ESC [` must not become Alt+[ and text, and with the kitty flag the Escape key is `CSI 27 u` anyway.
 */
export const ESC_WAIT_SLOW_MS = 150;
/** An unfinished longer escape sequence (CSI with parameters, OSC, DCS, APC) is dropped this long after its first byte. */
export const SEQUENCE_DROP_MS = 500;
/** The longest the host's replies to the start probe are awaited; its DA1 reply ends the wait sooner. */
export const REPLY_WAIT_MS = 500;
/** A bracketed paste longer than this many bytes is refused whole. */
export const PASTE_LIMIT_BYTES = 1024 * 1024;
/** The most bytes of one escape sequence kept; a longer one is consumed to its end and reported cut to this. */
export const SEQUENCE_LIMIT_BYTES = 4096;
/** How long the core link waits before it opens a new line after one ended; each attempt that fails doubles it. */
export const RECONNECT_FIRST_MS = 250;
/** The longest the core link waits between two attempts at a new line. */
export const RECONNECT_MOST_MS = 5_000;
/**
 * A line to the core that stayed up this long was healthy: when it ends, the core link's wait starts
 * again at RECONNECT_FIRST_MS. A line that ends sooner keeps doubling it, so a core that breaks its
 * line right after each start is tried every RECONNECT_MOST_MS, not every RECONNECT_FIRST_MS.
 */
export const LINE_STABLE_MS = 5_000;
/** A line to the core that brought no event and no heartbeat (hc sends one every 15 s) for this long is ended, as an EOF ends it. */
export const LINE_SILENCE_MS = 40_000;

/** A drain of stdin ends when no more bytes arrive within this long (probe d: one `readable` wait, repeated). */
export const DRAIN_WAIT_MS = 50;
/** After a signal gave the terminal back, the host ends the process once its end listeners settle, or after this long. */
export const SIGNAL_END_WAIT_MS = 2000;
/** A write the terminal refuses with EAGAIN (a tty another program left non-blocking) is tried again this often... */
export const WRITE_AGAIN_LIMIT = 2000;
/** ...this long apart; past the limit the write fails and the host reports the terminal gone. */
export const WRITE_AGAIN_PAUSE_MS = 1;
/** At a stop, a launcher seen running is looked at again this often, until it stops or the job's continue is heard... */
export const LAUNCHER_STOP_LOOK_MS = 1;
/** ...for this long at most; then the job counts as continued already, and the screen does not stop. */
export const LAUNCHER_STOP_WAIT_MS = 2_000;

export const NO_DEADLINES: Deadlines = new Map();

/** `deadlines` with `name` due at `at`, replacing that name's earlier time if it had one. */
export function setDeadline(deadlines: Deadlines, name: string, at: number): Deadlines {
  return new Map(deadlines).set(name, at);
}

/** `deadlines` without `name`; the same value when that name is not set. */
export function clearDeadline(deadlines: Deadlines, name: string): Deadlines {
  if (!deadlines.has(name)) return deadlines;
  const next = new Map(deadlines);
  next.delete(name);
  return next;
}

/**
 * The deadline due first, or undefined when there is none. Of two due at the same time, the name
 * that sorts first (by code unit) wins, so the answer never depends on the order they were set.
 */
export function earliest(deadlines: Deadlines): { name: string; at: number } | undefined {
  let first: { name: string; at: number } | undefined;
  for (const [name, at] of deadlines) {
    if (!first || at < first.at || (at === first.at && name < first.name)) first = { name, at };
  }
  return first;
}

// The state core's waits and limits. Its one deadline name is `notice`; an armed prefix waits without end, as herdr's does.

/** How long a notice stays on screen (herdr keeps a failure on screen for 5 s). */
export const NOTICE_SHOW_MS = 5_000;
/** The most notices kept at once; a new one pushes out the oldest. */
export const NOTICES_KEPT = 8;
/** The most code points of config text (a binding or a reason as written) drawn; longer text is cut with an ellipsis. */
export const CONFIG_TEXT_MAX_CHARS = 80;
/** The most refusals of the key config listed; the rest are counted. */
export const REFUSALS_SHOWN = 20;
/** The most graphemes a one-line text field (rename, new tab name, goto) holds; typing or pasting past it is cut. */
export const TEXT_FIELD_MAX_GRAPHEMES = 256;
/**
 * The most code points such a field holds, whatever its graphemes: a letter with endless marks after it is one
 * grapheme, and its marks past this are refused. Room for every grapheme to carry three more (an emoji sequence).
 */
export const TEXT_FIELD_MAX_CODE_POINTS = 4 * TEXT_FIELD_MAX_GRAPHEMES;

/**
 * A pane's first paint normally ends at hc's mark. Without one it counts as complete once the stream
 * was quiet this long with every byte of it credited back, so a core that changes the mark costs a
 * pane this wait and not its life.
 */
export const PAINT_QUIET_MS = 1_000;
/**
 * How long a pane waits after the last change of its rectangle, or the last `size` event another
 * viewer caused, before it attaches again: a window being dragged, or a viewer resizing in steps,
 * costs one new attach and not one per step.
 */
export const REATTACH_SETTLE_MS = 150;
/**
 * How long a pane waits after the last change of its own rectangle before it attaches again. A host
 * sends a dragged window's steps at its frame rate (16 ms at 60 Hz), so two frames still make a drag
 * one attach; the size rules do not depend on it (another viewer's change still waits REATTACH_SETTLE_MS).
 */
export const RESIZE_SETTLE_MS = 32;
/**
 * How often in a row a pane attaches again by itself after its stream was dropped though its terminal
 * lives, or after its emulator died, before it is Failed and waits for the user's retry. Counted from
 * the last time the pane was live.
 */
export const PANE_REOPEN_LIMIT = 3;

// The loop's waits and limits (tui/loop.ts) and the entry's (tui/main.ts).

/** A frame pass runs at most this often: changes closer together than this share one pass. */
export const FRAME_PASS_MS = 8;
/** The most bytes of credit one frame pass hands back to the core, the focused pane first. */
export const PASS_CREDIT_BYTES = 512 * 1024;
/** Quit and a hang-up close every pane channel and the event stream within this long, answered or not. */
export const QUIT_BOUND_MS = 2_000;
/**
 * Input that waited behind a layout write waits this long more, once the write is done, for the screen to show what the
 * write did (the pane it made or moved, with focus on it; the panes a close ended, gone); past it that input is
 * refused, never sent to the pane focused before.
 */
export const LAYOUT_SHOWN_WAIT_MS = 2_000;
/**
 * How long a screen's claim to open the first workspace holds once written (tui/core/layout.ts `claimFirst`). The screen
 * lets it go when it is done or leaves; one that died holding it leaves the claim to this time, after which another
 * screen takes it. Longer than a call waits for its answer (10 s), so the shell's start a claim covers was answered, or
 * given up, before another screen starts one.
 */
export const FIRST_CLAIM_MS = 15_000;
/** The most input events that wait behind a layout write; past it nothing more waits until the write is done. */
export const BEHIND_WRITE_EVENTS = 4_096;
/** The most bytes of typed and pasted text that wait behind a layout write: one paste at its limit. */
export const BEHIND_WRITE_BYTES = PASTE_LIMIT_BYTES;
/** A program's synchronized-output hold is ended this long after it began, if the program did not end it. */
export const HOLD_RELEASE_MS = 1_000;
/**
 * After a paste the input layer refused, it swallows input until the paste's end mark. When no read brought an
 * event for this long, the mark is taken as lost and the input layer is reset, so the keyboard is back. Not
 * shorter: a long paste over a slow link arrives with gaps, and a reset inside one would type the rest of it.
 */
export const PASTE_ABANDON_MS = 3_000;
/** The painter's style table never shrinks: the painter and its grids are made anew once it holds this many styles. */
export const STYLE_TABLE_LIMIT = 65_536;
/** The crash records kept in the screen's state folder: the newest this many. */
export const CRASH_RECORDS_KEPT = 10;
/** The action codes a crash record carries: the last this many. */
export const CRASH_ACTIONS_KEPT = 32;
