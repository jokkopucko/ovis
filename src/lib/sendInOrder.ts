/**
 * Sends keys that waited (an idle pane's resume queue, a new terminal's caught keys) in order. A key the pane cannot
 * take is held by `send` itself, and every key after it is held too, Enter included: nothing runs ahead of input
 * that waits for the user's Send. `held`: something is held already, so all of them are.
 */
export function sendInOrder<T>(items: readonly T[], held: boolean, send: (item: T) => boolean, hold: (item: T) => void): void {
  for (const item of items) {
    if (held) hold(item);
    else held = !send(item);
  }
}
