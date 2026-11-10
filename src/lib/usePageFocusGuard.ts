/**
 * The app's keyboard while a page's scripts run beside the pane (the docked file viewer).
 *
 * A frame's script can take the focus by itself (`window.focus()`), and the keys typed for the message box or
 * the terminal then go to the page. Measured in Chrome 156 and WebKit 26.6: nothing on the frame element stops
 * it (`inert`, `tabindex`, a permissions policy), the page around a frame of another origin sees neither a hover
 * nor a press inside it, and it cannot take the focus back while the frame is there. Only taking the frame away
 * gives the keys back.
 *
 * So the person puts the focus in the page, and nothing else does:
 * - by asking for its scripts (the press that started them), until the focus is in the app again;
 * - by a press on the page. A press inside the frame would not be seen here, so while `shield` is set the
 *   viewer lets the frame take no pointer and takes the press itself (`enter`). That press only puts the
 *   focus in the page; the next one is the page's;
 * - by Tab from the control before it. Only a Tab the app left to the browser counts (one the terminal took for
 *   itself moves no focus), only until the focus lands in the app, and only once.
 * A frame that has the focus otherwise took it: `onGrab` must take its scripts away at once (the viewer draws the
 * page without them again), and the focus goes back to where it was.
 */
import { useCallback, useEffect, useRef, useState, type RefObject } from "react";

/** how long after a Tab the focus arriving in the frame counts as that Tab's */
const TAB_REACH_MS = 150;

export function usePageFocusGuard(frame: RefObject<HTMLIFrameElement | null>, active: boolean, onGrab: () => void): { shield: boolean; enter: () => void } {
  // the person asked for the scripts with a press: the page may take the focus until the app has it again
  const [inside, setInside] = useState(true);
  const state = useRef({ inside: true, tabAt: -Infinity, last: null as HTMLElement | null });
  const grabbed = useRef(onGrab);
  grabbed.current = onGrab;
  const put = useCallback((value: boolean): void => { state.current.inside = value; setInside(value); }, []);
  useEffect(() => {
    if (!active) return;
    put(true);
    state.current.tabAt = -Infinity;
    const focused = (event: FocusEvent): void => {
      if (!(event.target instanceof HTMLElement) || event.target === frame.current) return;
      // the focus is in the app again: the page has to be given it anew
      state.current.last = event.target;
      // and a Tab that went there did not go to the page
      state.current.tabAt = -Infinity;
      put(false);
    };
    // on the way up, so a Tab its target kept for itself (the terminal's completion stops it) never arrives
    const keyed = (event: KeyboardEvent): void => { if (event.key === "Tab" && !event.defaultPrevented) state.current.tabAt = performance.now(); };
    const left = (): void => {
      // the window's blur with the frame as the active element: the focus went into the page. The same is asked
      // when the window comes back to the front: a page that took the focus while another window had it made no blur
      if (frame.current === null || document.activeElement !== frame.current || state.current.inside) return;
      const tabbed = performance.now() - state.current.tabAt < TAB_REACH_MS;
      state.current.tabAt = -Infinity;
      if (tabbed) { put(true); return; }
      const back = state.current.last;
      grabbed.current();
      const home = (): void => {
        window.focus();
        if (back?.isConnected) back.focus({ preventScroll: true });
      };
      home();
      // WebKit 26.6 leaves the window without the focus when it is asked for inside the window's own blur event
      // (the element is active, and every key typed is dropped): asked again once that event is over
      setTimeout(() => { if (!document.hasFocus()) home(); }, 0);
    };
    document.addEventListener("focusin", focused, true);
    window.addEventListener("keydown", keyed);
    window.addEventListener("blur", left);
    window.addEventListener("focus", left);
    return () => {
      document.removeEventListener("focusin", focused, true);
      window.removeEventListener("keydown", keyed);
      window.removeEventListener("blur", left);
      window.removeEventListener("focus", left);
    };
  }, [active, frame, put]);
  const enter = useCallback((): void => {
    put(true);
    frame.current?.focus({ preventScroll: true });
  }, [frame, put]);
  return { shield: active && !inside, enter };
}
