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
