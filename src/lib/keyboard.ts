/*
 * Putting a phone's soft keyboard away to read the chat. iOS gives a textarea's keyboard
 * no dismiss key, so the chat offers two ways, as messaging apps do: a tap on the
 * transcript and a drag down on it. Each only blurs the field: the draft stays in the
 * composer.
 */

/** How far a finger must travel down the transcript before the keyboard goes away. */
export const DISMISS_DRAG_PX = 32;

/** lib/viewport.ts sets data-keyboard while a touch device has a text field focused. */
export function keyboardUp(): boolean {
  return typeof document !== "undefined" && document.documentElement.hasAttribute("data-keyboard");
}

/**
 * Reference height for keyboard occlusion, retaining the unobstructed viewport unless the window resized.
 */
export function keyboardViewportReference(
  height: number,
  large: number,
  layout: number,
  remembered: { large: number; height: number } | undefined,
  keyboardActive: boolean,
): number {
  // Chrome resizes-content can shrink 100lvh along with the keyboard. With a
  // typing field (or a keyboard already up), a visual viewport filling the
  // shortened layout is not evidence that the unobstructed window resized.
  // A split view's separate visual inset still lets its new height replace it.
  const resizedWindow = remembered && large < remembered.large && height <= large && large - height <= large * 0.2
    && (!keyboardActive || height < layout);
  return Math.max(large, resizedWindow ? 0 : remembered?.height ?? 0, layout);
}

/**
 * Whether the soft keyboard holds the terminal's grid: the keyboard takes the bottom of the screen,
 * not the pane, so a fit to what is left above it would size the shared pty to that strip and
 * reflow every other viewer of the pane twice per keyboard (#1045). A host that only lost height
 * under the keyboard keeps its grid and pans; a host whose width changed (a rotation) refits even
 * under the keyboard, and a host with no keyboard over it always does. `fittedWidth` is the host's
 * width at its last fit, null before the first: that first fit waits for the keyboard to go too.
 */
export function keyboardHoldsGrid(keyboard: boolean, width: number, fittedWidth: number | null): boolean {
  return keyboard && (fittedWidth === null || width === fittedWidth);
}

/**
 * The fields a focused element may have the soft keyboard for, as lib/viewport.ts's measurement
 * reads them (syncKeyboard), and the keyboard control needs the same words: a blur that leaves no
 * such field focused anywhere is the keyboard going, where a blind measurement (a zoomed page, a
 * floating keyboard) is not. xterm's automatically focused helper only counts in direct typing.
 */
export function keyboardTypingField(element: Element | null): boolean {
  return (element instanceof HTMLTextAreaElement && (!element.classList.contains("xterm-helper-textarea") || element.closest("[data-direct-typing]") !== null))
    || (element instanceof HTMLInputElement && !["button", "checkbox", "radio", "range", "submit", "reset", "file", "color"].includes(element.type))
    || (element instanceof HTMLElement && element.isContentEditable);
}

function dismissKeyboard(): void {
  const active = document.activeElement;
  if (active instanceof HTMLElement) active.blur();
}

/** A drag that reads older messages (finger moving down, mostly vertical) puts the keyboard away. */
export function dragDismisses(dx: number, dy: number): boolean {
  return dy >= DISMISS_DRAG_PX && dy > Math.abs(dx);
}

/** Taps on controls, links or text being selected do what they do; any other tap reads. */
export function tapDismisses(target: EventTarget | null, selection: string): boolean {
  if (selection.length > 0) return false;
  const element = target as Element | null;
  if (element === null || typeof element.closest !== "function") return true;
  return element.closest("a, button, input, textarea, select, summary, label, [role='button'], [contenteditable='true']") === null;
}

/** A scroller between the touched element and the node (both included) that a drag down would first scroll back up. */
export function scrolledDown(target: unknown, node: { scrollTop: number }): boolean {
  for (let at = target as { scrollTop?: number; parentElement?: unknown } | null; at != null; at = at.parentElement as typeof at) {
    if ((at.scrollTop ?? 0) > 0) return true;
    if (at === node) return false;
  }
  return node.scrollTop > 0;
}

/**
 * Wires the tap and the drag onto a scrolling transcript; returns the cleanup.
 * `atTopOnly` is for a scroller that is not the transcript (the prompt card): there a drag down
 * first scrolls its own text back up, and puts the keyboard away only once nothing is left to scroll.
 */
export function dismissKeyboardOn(node: HTMLElement, { atTopOnly = false }: { atTopOnly?: boolean } = {}): () => void {
  let start: { x: number; y: number } | null = null;
  const onTouchStart = (event: TouchEvent): void => {
    const touch = event.touches[0];
    if (atTopOnly && scrolledDown(event.target, node)) { start = null; return; }
    // a drag that starts on a text selection moves its handles; it is not a request to read
    const selecting = (window.getSelection()?.toString() ?? "").length > 0;
    // a field in the transcript (a prompt card's own answer) keeps its keyboard while a finger drags on it
    const onField = (event.target as Element | null)?.closest?.("input, textarea, select, [contenteditable='true']") != null;
    start = event.touches.length === 1 && touch && keyboardUp() && !selecting && !onField ? { x: touch.clientX, y: touch.clientY } : null;
  };
  const onTouchMove = (event: TouchEvent): void => {
    const touch = event.touches[0];
    if (start === null || !touch) return;
    // a long press that began a selection mid-stroke drags its handles, not the transcript
    if ((window.getSelection()?.toString() ?? "").length > 0) { start = null; return; }
    if (dragDismisses(touch.clientX - start.x, touch.clientY - start.y)) {
      start = null;
      dismissKeyboard();
    }
  };
  const onClick = (event: MouseEvent): void => {
    if (keyboardUp() && tapDismisses(event.target, window.getSelection()?.toString() ?? "")) dismissKeyboard();
  };
  node.addEventListener("touchstart", onTouchStart, { passive: true });
  node.addEventListener("touchmove", onTouchMove, { passive: true });
  node.addEventListener("click", onClick);
  return () => {
    node.removeEventListener("touchstart", onTouchStart);
    node.removeEventListener("touchmove", onTouchMove);
    node.removeEventListener("click", onClick);
  };
}
