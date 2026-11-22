/*
 * Putting a phone's soft keyboard away to read the chat. iOS gives a textarea's keyboard
 * no dismiss key, so the chat offers two ways, as messaging apps do: a tap on the
 * transcript and a drag down on it. Each only blurs the field: the draft stays in the
 * composer.
 */

export const DISMISS_DRAG_PX = 32;

export function keyboardUp(): boolean {
  return typeof document !== "undefined" && document.documentElement.hasAttribute("data-keyboard");
}

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
  const resizedWindow = remembered && large < remembered.large && height <= large && large - height <= large * 0.2
    && (!keyboardActive || height < layout);
  return Math.max(large, resizedWindow ? 0 : remembered?.height ?? 0, layout);
}

/**
 * Whether the soft keyboard holds the terminal's grid: the keyboard takes the bottom of the screen,
 * not the pane, so a fit to what is left above it would size the shared pty to that strip and
 * reflow every other viewer of the pane twice per keyboard (#1045).
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

export function dragDismisses(dx: number, dy: number): boolean {
  return dy >= DISMISS_DRAG_PX && dy > Math.abs(dx);
}

export function tapDismisses(target: EventTarget | null, selection: string): boolean {
  if (selection.length > 0) return false;
  const element = target as Element | null;
  if (element === null || typeof element.closest !== "function") return true;
  return element.closest("a, button, input, textarea, select, summary, label, [role='button'], [contenteditable='true']") === null;
}

export function scrolledDown(target: unknown, node: { scrollTop: number }): boolean {
  for (let at = target as { scrollTop?: number; parentElement?: unknown } | null; at != null; at = at.parentElement as typeof at) {
    if ((at.scrollTop ?? 0) > 0) return true;
    if (at === node) return false;
  }
  return node.scrollTop > 0;
}

export function dismissKeyboardOn(node: HTMLElement, { atTopOnly = false }: { atTopOnly?: boolean } = {}): () => void {
  let start: { x: number; y: number } | null = null;
  const onTouchStart = (event: TouchEvent): void => {
    const touch = event.touches[0];
    if (atTopOnly && scrolledDown(event.target, node)) { start = null; return; }
    // a drag that starts on a text selection moves its handles; it is not a request to read
    const selecting = (window.getSelection()?.toString() ?? "").length > 0;
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
