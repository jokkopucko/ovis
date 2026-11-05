/**
 * What every `aria-modal` surface owes its keyboard: Tab stays inside it, and the focus goes
 * back to whatever opened it. Browsers do not enforce the first for the keyboard, and nothing
 * does the second for us - lifted from ConfirmDialog, which was the one dialog that had both.
 *
 * `useFocusTrap(open)` returns the ref for the dialog surface. Give the surface `tabIndex={-1}`
 * when it can hold the focus itself (a dialog whose controls are all disabled while it works).
 */
import { useEffect, useLayoutEffect, useRef, type MutableRefObject, type RefObject } from "react";

/** Tab stops in DOM order; what a user reaches with Tab inside the surface. */
const FOCUSABLE = [
  "a[href]",
  "area[href]",
  "button",
  "input",
  "select",
  "textarea",
  "summary",
  "iframe",
  "audio[controls]",
  "video[controls]",
  "[tabindex]",
  "[contenteditable]",
].join(",");

export interface FocusTrapOptions {
  /** focused on open when the dialog has one control to start at (ConfirmDialog's Cancel) */
  initialFocus?: RefObject<HTMLElement | null>;
  /** the focus returns to the opener unless this says otherwise when the surface goes */
  shouldRestore?: () => boolean;
  /** suspend keyboard ownership while another surface covers this one */
  paused?: boolean;
}

/** The tab stops a user can actually land on, in order: rendered, and not disabled or skipped. */
function tabStops(surface: HTMLElement): HTMLElement[] {
  return [...surface.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((node) => {
    if (node.hasAttribute("disabled") || node.getAttribute("aria-hidden") === "true") return false;
    if (node.tabIndex < 0) return false;
    // hidden ancestors and collapsed sections report no box at all
    return node.getClientRects().length > 0;
  });
}

/**
 * The traps open now, oldest first. Dialogs stack (a file preview over Files, Settings over a
 * preview) and every trap listens on the window: only the top one may move the focus, or the one
 * beneath pulls it out of the dialog in front and the one in front sends it back to its start.
 */
const openTraps: object[] = [];

/**
 * A native modal (`showModal()`, as Add PC opens) the surface is not part of. It never joins
 * `openTraps`, but the browser puts it in the top layer and makes the rest of the page inert, so
 * while it is open it owns Tab, Escape and the focus, and every trap and overlay beneath stands down.
 */
export function nativeModalOver(surface: HTMLElement | null): boolean {
  for (const dialog of document.querySelectorAll("dialog")) {
    if (!dialog.matches(":modal")) continue;
    if (surface && (dialog.contains(surface) || surface.contains(dialog))) continue;
    return true;
  }
  return false;
}

export function useFocusTrap<T extends HTMLElement>(open: boolean, options: FocusTrapOptions = {}): MutableRefObject<T | null> {
  const surface = useRef<T | null>(null);
  // read in the listeners, so a dialog that changes its mind mid-life is not held to its first render
  const latest = useRef(options);
  latest.current = options;
  // Own the keyboard in the opening commit: a menu can just have restored the terminal,
  // whose Escape handler would consume a key arriving before the first animation frame.
  useLayoutEffect(() => {
    if (!open) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    return () => {
      // a covering dialog owns focus; otherwise return it only when this surface closes
      if (!latest.current.paused && latest.current.shouldRestore?.() !== false && opener?.isConnected && !nativeModalOver(surface.current)) opener.focus({ preventScroll: true });
    };
  }, [open]);

  useLayoutEffect(() => {
    if (!open || options.paused) return;
    const node = surface.current;
    if (node && !nativeModalOver(node) && !node.contains(document.activeElement)) {
      // AutoFocus or a child's layout effect may already have placed focus inside the surface.
      // Otherwise try the preferred control, then a tab stop, then the surface: a connected
      // control can still refuse focus (disabled, hidden or inside a disabled fieldset).
      const wanted = latest.current.initialFocus?.current;
      wanted?.focus({ preventScroll: true });
      if (!node.contains(document.activeElement)) tabStops(node)[0]?.focus({ preventScroll: true });
      if (!node.contains(document.activeElement)) node.focus({ preventScroll: true });
    }
  }, [open, options.paused]);

  useEffect(() => {
    if (!open || options.paused) return;
    const trap = {};
    openTraps.push(trap);
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "Tab" || openTraps.at(-1) !== trap) return;
      const node = surface.current;
      if (!node || nativeModalOver(node)) return;
      const stops = tabStops(node);
      // every control disabled (a deed that cannot be undone): Tab goes nowhere rather than out
      if (stops.length === 0) { event.preventDefault(); return; }
      const active = document.activeElement;
      const at = active instanceof HTMLElement ? stops.indexOf(active) : -1;
      const next = event.shiftKey
        ? (at <= 0 ? stops[stops.length - 1] : stops[at - 1])
        : (at === stops.length - 1 ? stops[0] : stops[at + 1]);
      // focus already inside, in the middle: let the browser's own order carry on
      if (!next) return;
      event.preventDefault();
      next.focus({ preventScroll: true });
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      openTraps.splice(openTraps.indexOf(trap), 1);
    };
  }, [open, options.paused]);

  return surface;
}

/**
 * The return alone, for a surface that is no dialog (the file panel beside the pane): nothing
 * holds Tab or moves the focus in, but when the surface goes and took the focus with it (Close
 * file, Escape inside it), the focus goes back to what opened it, as a dialog's does. A focus
 * that is elsewhere by then (the pane's composer, the sidebar row that moved to another pane)
 * stays there. Owned by the surface's parent, not the surface: a surface remade for another
 * file must not send the focus back meanwhile.
 */
export function useFocusReturn(shown: boolean): void {
  useLayoutEffect(() => {
    if (!shown) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    return () => {
      // after the surface left the DOM: a focus it held is the body's now
      const active = document.activeElement;
      if (active !== null && active !== document.body) return;
      if (opener?.isConnected && !nativeModalOver(null)) opener.focus({ preventScroll: true });
    };
  }, [shown]);
}
