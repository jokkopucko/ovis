/**
 * Safari and iOS Safari write the clipboard only during a user gesture, and a pane program's
 * OSC 52 (lib/osc52.ts) answers a click a round trip after it ended. So the click itself starts
 * the write, with a clipboard item whose text is still a promise, and the program's copy fills it
 * in. Nothing fills it within the time limit, or it is cancelled: the write fails and the
 * clipboard keeps what it had.
 */

export const OSC52_RESERVATION_MS = 1000;

export interface ClipboardAccess {
  clipboard: Pick<Clipboard, "write"> | undefined;
  ClipboardItem: (new (items: Record<string, Promise<Blob>>) => ClipboardItem) | undefined;
}

export interface Osc52Reservation {
  fulfil(text: string): Promise<boolean>;
  cancel(): void;
  readonly pending: boolean;
}

/**
 * Starts a clipboard write during the user's click; null where the clipboard API cannot take a
 * pending item (plain HTTP, an old browser).
 */
export function reserveOsc52Copy(
  timeoutMs = OSC52_RESERVATION_MS,
  access: ClipboardAccess = { clipboard: globalThis.navigator?.clipboard, ClipboardItem: globalThis.ClipboardItem },
): Osc52Reservation | null {
  const { clipboard, ClipboardItem: Item } = access;
  if (!Item || typeof clipboard?.write !== "function") return null;
  const blob = Promise.withResolvers<Blob>();
  let pending = true;
  const giveUp = (): void => {
    if (!pending) return;
    pending = false;
    clearTimeout(timer);
    blob.reject(new DOMException("no copy from the pane", "AbortError"));
  };
  let written: Promise<boolean>;
  try {
    written = clipboard.write([new Item({ "text/plain": blob.promise })]).then(() => true, () => false);
  } catch {
    return null;
  }
  blob.promise.catch(() => {});
  const timer = setTimeout(giveUp, timeoutMs);
  return {
    get pending() { return pending; },
    fulfil(text) {
      if (!pending) return Promise.resolve(false);
      pending = false;
      clearTimeout(timer);
      blob.resolve(new Blob([text], { type: "text/plain" }));
      return written;
    },
    cancel: giveUp,
  };
}
