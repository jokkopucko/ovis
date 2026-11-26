import type { GhosttyTerminal } from "./ghostty/terminal.ts";
import { HERDR_MOUSE_SCROLL_LINES } from "./wheelSteps.ts";

export interface TerminalWheelState {
  readonly speed: number;
  readonly omoQuestion: boolean;
}

interface WheelViewport {
  readonly drag: (event: WheelEvent) => boolean;
  readonly adopted: () => boolean;
  readonly mirrored: () => boolean;
  readonly pan?: (event: WheelEvent) => boolean;
  readonly scroll: (lines: number) => void;
}

const forwarded = new WeakSet<Event>();
const gridPans = new WeakSet<WheelEvent>();
export const wheelPansGrid = (event: WheelEvent): boolean => gridPans.has(event);

export function forwardWheel(target: EventTarget, event: WheelEvent): void {
  const copy = new WheelEvent("wheel", event);
  if (event.isTrusted) forwarded.add(copy);
  target.dispatchEvent(copy);
}
const real = (event: WheelEvent): boolean => event.isTrusted || forwarded.has(event);

export function canPanTerminalGrid(view: Pick<HTMLElement, "scrollTop" | "scrollHeight" | "clientHeight">, delta: number): boolean {
  // DOM heights round to integers; a fractional physical edge must still release history scrolling.
  return delta < 0 ? view.scrollTop > 1 : delta > 0 && view.scrollTop < view.scrollHeight - view.clientHeight - 1;
}

/** herdr owns history; the input layer owns encoding mouse reports for applications that use them. */
export function attachTerminalWheel(term: Pick<GhosttyTerminal, "hasSelection" | "clearSelection" | "modes" | "attachCustomWheelEventHandler">, state: { readonly current: TerminalWheelState }, viewport: WheelViewport): void {
  term.attachCustomWheelEventHandler((event) => {
    if (viewport.drag(event)) return false;
    if (viewport.pan?.(event)) {
      gridPans.add(event);
      return false;
    }
    // Observers pan locally; an interactive mirror can scroll herdr through the API.
    const mirrored = viewport.mirrored();
    if (viewport.adopted() && !mirrored) return false;
    if (mirrored && event.deltaY === 0) return false;
    if (term.hasSelection()) term.clearSelection();
    // OmO consumes wheel reports without acting while a question captures mouse input, so the
    // wheel moves herdr's history itself, as far as the reports below would: one three-line step
    // per event whatever its delta, repeated at the chosen speed for a real wheel only.
    // Mirrors have no mouse-reporting attach stream, so use the same history API.
    if ((mirrored || state.current.omoQuestion) && !event.ctrlKey && !event.shiftKey) {
      event.preventDefault();
      if (event.deltaY !== 0) viewport.scroll(-Math.sign(event.deltaY) * HERDR_MOUSE_SCROLL_LINES * (real(event) ? state.current.speed : 1));
      return false;
    }
    const reporting = term.modes.mouseTrackingMode !== "none";
    // A program that does not report must not receive fallback arrow keys.
    // Trusted wheels replay at the chosen speed; touch/replays already supply their steps.
    // A trackpad pinch (Ctrl) keeps its original single-event path and all replayed modifiers.
    if (reporting && real(event) && event.target && !event.ctrlKey) {
      for (let sent = 1; sent < state.current.speed; sent += 1) {
        event.target.dispatchEvent(new WheelEvent("wheel", {
          bubbles: true, cancelable: true, deltaX: event.deltaX, deltaY: event.deltaY, deltaMode: event.deltaMode,
          clientX: event.clientX, clientY: event.clientY,
          ctrlKey: event.ctrlKey, altKey: event.altKey, shiftKey: event.shiftKey, metaKey: event.metaKey,
        }));
      }
    }
    return reporting;
  });
}
