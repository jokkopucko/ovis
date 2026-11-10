/**
 * What every `aria-modal` surface owes its keyboard: Tab stays inside it, and the focus goes
 * back to whatever opened it. Browsers do not enforce the first for the keyboard, and nothing
 * does the second for us - lifted from ConfirmDialog, which was the one dialog that had both.
 *
 * `useFocusTrap(open)` returns the ref for the dialog surface. Give the surface `tabIndex={-1}`
 * when it can hold the focus itself (a dialog whose controls are all disabled while it works).
 */
import { useEffect, useLayoutEffect, useRef, type MutableRefObject, type RefObject } from "react";
import { typeAheadFocused } from "./typeAhead.ts";

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
  /** controls outside the surface that belong to it, before its own stops in the Tab order (a phone drawer's header toggle and +) */
  leadingStops?: () => readonly HTMLElement[];
  /** the surface itself (tabIndex -1) gets the focus on open, so no control shows a focus ring a finger did not ask
   *  for and no text field raises a phone's keyboard; Tab goes on to the first stop (a phone's drawer) */
  startOnSurface?: boolean;
}

/** The surfaces whose Tab the hook holds now. */
const heldSurfaces = new Set<HTMLElement>();

/**
 * Whether `node` is in a surface whose Tab this hook holds now. What lies over every dialog (a device
 * waiting for approval) takes the focus only from inside one: its Tab round leads there and back, while
 * an `aria-modal` surface that keeps Tab by its own key handler would lose Tab to the page beneath.
 */
export function inFocusTrap(node: Element): boolean {
  for (const surface of heldSurfaces) if (surface.contains(node)) return true;
  return false;
}

/** A stop a user can actually land on: rendered, and not disabled or skipped. */
function reachable(node: HTMLElement): boolean {
  if (node.hasAttribute("disabled") || node.getAttribute("aria-hidden") === "true") return false;
  if (node.tabIndex < 0) return false;
  // a disconnected PC's cached rows are inert: the browser refuses them the focus, so Tab must not stop there
  if (node.closest("[inert]") !== null) return false;
  // hidden ancestors and collapsed sections report no box at all
  return node.getClientRects().length > 0;
}

/** The tab stops in order: the ones outside the surface that belong to it, then its own. */
function tabStops(surface: HTMLElement, options: FocusTrapOptions): HTMLElement[] {
  return [...(options.leadingStops?.() ?? []), ...surface.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(reachable);
}

/**
 * The stops of what lies over every dialog without being one: a device waiting for this PC's approval
 * (components/RelayPairingPrompt.tsx). They follow the dialog's own in its Tab order, so a prompt that
 * left the focus in one of the dialog's fields can still be answered by keyboard. Each prompt is a stop
 * itself, before its buttons: Tab from the dialog lands on the prompt, never straight on Approve.
 */
export function overlayStops(): HTMLElement[] {
  const stops: HTMLElement[] = [];
  for (const prompt of document.querySelectorAll<HTMLElement>(".relay-pairing-prompt")) {
    // refused the focus under an inert column, or not drawn: no stop
    if (prompt.closest("[inert]") !== null || prompt.getClientRects().length === 0) continue;
    stops.push(prompt, ...[...prompt.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(reachable));
  }
  return stops;
}

/** The waiting prompt `stop` is, or is in. */
function overlayOf(stop: HTMLElement): HTMLElement | undefined {
  return [...document.querySelectorAll<HTMLElement>(".relay-pairing-prompt")].find((prompt) => prompt.contains(stop));
}

/**
 * Where Tab (or Shift+Tab, `back`) goes from `active` among `stops`, round and round; from anything that is
 * no stop, to the first (the last going back). Undefined when there is no stop at all.
 */
export function tabTarget(stops: readonly HTMLElement[], active: Element | null, back: boolean): HTMLElement | undefined {
  const at = active === null ? -1 : stops.indexOf(active as HTMLElement);
  return back
    ? (at <= 0 ? stops[stops.length - 1] : stops[at - 1])
    : (at === stops.length - 1 ? stops[0] : stops[at + 1]);
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

/**
 * The keyboard is in another `aria-modal` surface than this one. Window and document listeners run in the order
 * they were added, not the order the dialogs are drawn in, so a dialog beneath leaves this Escape to the one in
 * front, the one with the focus (#3037).
 */
export function focusInOtherModal(surface: HTMLElement | null): boolean {
  const focused = document.activeElement?.closest("[aria-modal='true']");
  return focused != null && focused !== surface;
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
      if (latest.current.paused || latest.current.shouldRestore?.() === false || !opener?.isConnected || nativeModalOver(surface.current)) return;
      opener.focus({ preventScroll: true });
      // The commit that removes this surface can lift `inert` off the page behind it only after this cleanup ran, so
      // the opener refused the focus: give it again once that commit is done, unless something else took it meanwhile.
      if (document.activeElement !== opener) queueMicrotask(() => {
        const active = document.activeElement;
        if (opener.isConnected && (active === null || active === document.body)) opener.focus({ preventScroll: true });
      });
    };
  }, [open]);

  useLayoutEffect(() => {
    if (!open || options.paused) return;
    const node = surface.current;
    if (node && !nativeModalOver(node) && !node.contains(document.activeElement)) {
      // AutoFocus or a child's layout effect may already have placed focus inside the surface.
      // Otherwise try the preferred control, then a tab stop, then the surface: a connected
      // control can still refuse focus (disabled, hidden or inside a disabled fieldset).
      const wanted = latest.current.startOnSurface ? node : latest.current.initialFocus?.current;
      wanted?.focus({ preventScroll: true });
      const own = [...node.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(reachable);
      if (!node.contains(document.activeElement)) own[0]?.focus({ preventScroll: true });
      if (!node.contains(document.activeElement)) node.focus({ preventScroll: true });
    }
  }, [open, options.paused]);

  useLayoutEffect(() => {
    if (!open || options.paused) return;
    const node = surface.current;
    if (!node) return;
    heldSurfaces.add(node);
    return () => { heldSurfaces.delete(node); };
  }, [open, options.paused]);

  useEffect(() => {
    if (!open || options.paused) return;
    const trap = {};
    openTraps.push(trap);
    const onKeyDown = (event: KeyboardEvent): void => {
      // keys typed ahead for a tab the dialog is making are that tab's, Tab included (lib/typeAhead.ts)
      if (event.key !== "Tab" || openTraps.at(-1) !== trap || typeAheadFocused()) return;
      const node = surface.current;
      if (!node || nativeModalOver(node)) return;
      // another dialog or menu that has the focus (a row's action sheet over the drawer) keeps its own Tab
      const holder = document.activeElement;
      if (holder instanceof Element && !node.contains(holder) && holder.closest('[role="dialog"], [role="alertdialog"], [role="menu"]') !== null) return;
      // a device waiting for approval is in this dialog's round, after its own stops: reached from a field
      // the prompt left the focus in, and left again for the dialog, never for the page beneath
      const stops = [...tabStops(node, latest.current), ...overlayStops()];
      const next = tabTarget(stops, document.activeElement, event.shiftKey);
      // every control disabled (a deed that cannot be undone): Tab goes nowhere rather than out
      event.preventDefault();
      next?.focus({ preventScroll: true });
      // several waiting prompts in a short window scroll: the one Tab lands in is brought into view, its
      // words and number first and then the button on it, so nothing is approved unread
      const overlay = next && overlayOf(next);
      if (!overlay) return;
      overlay.scrollIntoView({ block: "nearest" });
      if (next !== overlay) next.scrollIntoView({ block: "nearest" });
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
