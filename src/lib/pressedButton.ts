/**
 * A press that selects another pane can move what it pressed before the release: the selection
 * closes a file docked beside the panes, and the panes widen under the pointer (#3368). The browser
 * then sends the press's click to an element holding the button or link, not to it. This sends that
 * click on to the pressed button or link when it lands where that was when pressed; a release
 * dragged off that place still cancels the click, as it does on one that stayed put.
 *
 * The browser's own click is cancelled when handed on: a tap's click comes from a new hit test and
 * could press whatever moved under the finger as well.
 */
export function keepPressedButtonClick(press: { target: EventTarget | null }, previous: { current: AbortController | null }): void {
  previous.current?.abort();
  const control = press.target instanceof Element ? press.target.closest("button, a[href]") : null;
  if (control === null) return;
  const box = control.getBoundingClientRect();
  const watch = new AbortController();
  previous.current = watch;
  const stop = (): void => watch.abort();
  window.addEventListener("click", (click) => {
    watch.abort();
    if (!(click.target instanceof Node) || control.contains(click.target) || !control.isConnected) return;
    if (click.clientX < box.left || click.clientX > box.right || click.clientY < box.top || click.clientY > box.bottom) return;
    click.stopImmediatePropagation();
    click.preventDefault();
    // the keys held make a link's click open a tab or a window, as on a link that stayed put
    const { ctrlKey, metaKey, altKey, shiftKey, clientX, clientY, screenX, screenY, detail } = click;
    control.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, composed: true, view: window, button: 0, ctrlKey, metaKey, altKey, shiftKey, clientX, clientY, screenX, screenY, detail }));
  }, { capture: true, signal: watch.signal });
  // this press's own pointerdown is past the window already: the next one is another press
  window.addEventListener("pointerdown", stop, { capture: true, signal: watch.signal });
  window.addEventListener("pointercancel", stop, { signal: watch.signal });
  window.addEventListener("blur", stop, { signal: watch.signal });
}
