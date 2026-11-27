import { LAYOUT_SCROLL_START, LAYOUT_SCROLL_END } from "./layoutScroll.ts";
import { claimTouchStroke } from "./touchClaim.ts";

/*
 * The workspace drawer follows a phone's finger: a rightward swipe opens it, as the menu button
 * does, and a swipe to the left closes it again. Away from the left edge the opening angle is
 * flatter. Only at the drawer's
 * width (<=768px, styles.css) and only for a mostly horizontal stroke, so the terminal's
 * one-finger scrolling and the transcript's vertical scrolling keep working.
 *
 * While the finger is down the drawer is under it, as an iPhone's is: it moves with the
 * stroke rather than playing a slide of its own, and where it is let go, and how fast, decide
 * whether it stays open (`drawerSettles`).
 */

/** Inside this left edge, an opening stroke keeps the looser horizontal angle. */
export const EDGE_PX = 24;
export const SWIPE_PX = 56;
const SLOP_PX = 10;
export const FLING_SPEED = 0.35;
const REST_MS = 100;

export type SwipeVerdict = "open" | "close" | "claim" | "pending" | "ignore";

export function swipeVerdict(drawerOpen: boolean, startX: number, dx: number, dy: number): SwipeVerdict {
  if (Math.abs(dx) < SLOP_PX && Math.abs(dy) < SLOP_PX) return "pending";
  if (Math.abs(dy) >= Math.abs(dx)) return "ignore";
  if (!drawerOpen && dx > 0) {
    if (startX > EDGE_PX && dx < 2 * Math.abs(dy)) return "ignore";
    // Interior strokes may still become a page scroll: do not cancel their first flat move.
    if (startX > EDGE_PX && dx < SWIPE_PX) return "pending";
    return dx >= SWIPE_PX ? "open" : "claim";
  }
  if (drawerOpen && dx < 0) return -dx >= SWIPE_PX ? "close" : "claim";
  return "ignore";
}

export function drawerSettles(shown: number, width: number, speed: number): boolean {
  if (speed >= FLING_SPEED) return true;
  if (speed <= -FLING_SPEED) return false;
  return shown > width / 2;
}

const MODAL = "[aria-modal='true']:not(#workspace-drawer), dialog[open]";

/** Something under the finger scrolled sideways, a code block or a table: a swipe right scrolls it back. */
function scrolledAside(target: EventTarget | null): boolean {
  for (let node = target as HTMLElement | null; node; node = node.parentElement) {
    if (node.scrollLeft > 0 && node.scrollWidth > node.clientWidth) return true;
  }
  return false;
}

/** A finger on a text field edits its text: a sideways stroke there moves the caret or the selection. */
function editable(target: EventTarget | null): boolean {
  for (let node = target as HTMLElement | null; node; node = node.parentElement) {
    if (node.isContentEditable === true || /^(?:INPUT|TEXTAREA|SELECT)$/.test(node.tagName ?? "")) return true;
  }
  return false;
}

/** A split divider owns sideways drags, including strokes on its child elements. */
function onDivider(target: EventTarget | null): boolean {
  for (let node = target as HTMLElement | null; node; node = node.parentElement) {
    if (node.getAttribute?.("role") === "separator") return true;
  }
  return false;
}

/** Text is selected (the transcript's, a long press in the gutter): a stroke drags its handles. */
function selecting(): boolean {
  const selection = document.getSelection?.() ?? null;
  return selection !== null && !selection.isCollapsed;
}

/** Native scrolling or a terminal grid pan that already started keeps the gesture. */
function scrollOrigins(target: EventTarget | null): { node: HTMLElement; top: number; left: number; maxTop: number; depth: number; x: boolean; y: boolean }[] {
  const origins: ReturnType<typeof scrollOrigins> = [];
  for (let node = target as HTMLElement | null; node; node = node.parentElement) {
    const style = typeof getComputedStyle === "function" ? getComputedStyle(node) : null;
    const x = style ? /^(auto|scroll)$/.test(style.overflowX) : node.scrollWidth > node.clientWidth;
    const y = style ? /^(auto|scroll)$/.test(style.overflowY) : node.scrollHeight > node.clientHeight;
    if (x || y) origins.push({ node, top: node.scrollTop, left: node.scrollLeft,
      maxTop: Math.max(0, node.scrollHeight - node.clientHeight), depth: 0, x, y });
  }
  return origins;
}

/** Listens on the whole document; returns the cleanup. */
export function watchDrawerSwipe(isOpen: () => boolean, setOpen: (open: boolean) => void, canOpen: () => boolean): () => void {
  const narrow = window.matchMedia("(max-width: 768px)");
  type Stroke = { x: number; y: number; open: boolean; at: number; path: EventTarget[];
    scrolls: ReturnType<typeof scrollOrigins>; pageX: number; pageY: number };
  let start: Stroke | null = null;
  // a recognised swipe owns the stroke until the finger lifts, after the drawer moved too
  let claimed = false;
  let done = false;
  let state = false;
  let follow: { drawer: HTMLElement; scrim: HTMLElement | null; width: number; shown: number; x: number; at: number; speed: number } | null = null;
  let touchOrigin: EventTarget | undefined;
  // Touch events keep their original target even when a streaming render removes it.
  const moveAtOrigin: EventListener = (event) => {
    if (!event.composedPath().includes(document)) onMove(event as TouchEvent);
  };
  const endAtOrigin: EventListener = (event) => {
    if (!event.composedPath().includes(document)) onEnd(event as TouchEvent);
  };
  const clearTouchOrigin = (): void => {
    touchOrigin?.removeEventListener?.("touchmove", moveAtOrigin, { capture: true });
    touchOrigin?.removeEventListener?.("touchend", endAtOrigin, { capture: true });
    touchOrigin?.removeEventListener?.("touchcancel", endAtOrigin, { capture: true });
    touchOrigin = undefined;
  };
  let restoreScroll: (() => void) | null = null;
  const unlockScroll = (): void => {
    const restore = restoreScroll;
    restoreScroll = null;
    restore?.();
  };
  const lockScroll = (origins: ReturnType<typeof scrollOrigins>): void => {
    const saved: { style: CSSStyleDeclaration; property: string; value: string; priority: string }[] = [];
    for (const { node, x, y } of origins) {
      const style = node.style;
      if (!style) continue;
      for (const property of [...(x ? ["overflow-x"] : []), ...(y ? ["overflow-y"] : [])]) {
        saved.push({ style, property, value: style.getPropertyValue(property), priority: style.getPropertyPriority(property) });
      }
    }
    // Capture every original axis before changing a shorthand, and register restoration before
    // the first write so a partially applied lock that throws cannot leave a scroller locked.
    restoreScroll = () => {
      for (const { style, property, value, priority } of saved) {
        if (value) style.setProperty(property, value, priority);
        else style.removeProperty(property);
      }
    };
    for (const { style, property } of saved) style.setProperty(property, "hidden", "important");
  };
  const onStart = (event: TouchEvent): void => {
    clearTouchOrigin();
    unlockScroll();
    const touch = event.touches[0];
    // the last stroke still holds the drawer: a second finger, or its end never came (the element
    // it began on left the page and took its touches with it). It lets go where it was first
    const open = follow !== null ? onEnd() : isOpen();
    start = event.touches.length === 1 && touch && narrow.matches && document.querySelector(MODAL) === null && (open || (canOpen() && !scrolledAside(event.target) && !onDivider(event.target)))
      && !editable(event.target) && !selecting()
      ? { x: touch.clientX, y: touch.clientY, open, at: event.timeStamp,
        path: event.composedPath?.() ?? (event.target ? [event.target] : []),
        scrolls: !open && touch.clientX > EDGE_PX ? scrollOrigins(event.target) : [],
        pageX: window.scrollX ?? 0, pageY: window.scrollY ?? 0 } : null;
    claimed = false;
    done = false;
    state = open;
    follow = null;
    touchOrigin = start?.path[0];
    touchOrigin?.addEventListener?.("touchmove", moveAtOrigin, { capture: true, passive: false });
    touchOrigin?.addEventListener?.("touchend", endAtOrigin, { capture: true, passive: true });
    touchOrigin?.addEventListener?.("touchcancel", endAtOrigin, { capture: true, passive: true });
  };
  const pageScrolled = (): boolean => {
    const stroke = start;
    return stroke !== null && !stroke.open && stroke.x > EDGE_PX && (
    stroke.scrolls.some((origin) => {
      const { node } = origin;
      if (origin.depth > 0) return false;
      const maxTop = Math.max(0, node.scrollHeight - node.clientHeight);
      // A shorter transcript clamps a view past its new end before any JS scroll write.
      // Only that unavoidable bound correction is automatic without an explicit layout signal.
      if (origin.y && maxTop < origin.maxTop && origin.top > maxTop
          && Math.abs(node.scrollTop - maxTop) <= 1) {
        origin.top = node.scrollTop;
        origin.maxTop = maxTop;
      }
      if (node.scrollTop === origin.top) origin.maxTop = maxTop;
      return (origin.y && node.scrollTop !== origin.top) || (origin.x && node.scrollLeft !== origin.left);
    })
    || (window.scrollX ?? 0) !== stroke.pageX || (window.scrollY ?? 0) !== stroke.pageY
    );
  };
  const onMove = (event: TouchEvent): void => {
    try {
      const touch = event.touches[0];
      if (start === null || !touch) return;
      // The shell can disappear or enter inbox mode between touchstart and the claim.
      if (!start.open && !canOpen()) { onEnd(undefined, false); return; }
      if (pageScrolled()) { onEnd(undefined, false); return; }
      // the screen turned wide mid-stroke: there is no drawer to swipe any more
      if (!narrow.matches) { onEnd(); return; }
      // a selection begun mid-stroke is the finger's: until the drawer moved, the stroke goes back
      if (!done && selecting()) { onEnd(); return; }
      const verdict = done ? "claim" : swipeVerdict(start.open, start.x, touch.clientX - start.x, touch.clientY - start.y);
      // a stroke that was already the drawer's stays so when it comes back near where it started;
      // one that never was waits for a direction. Until the drawer moves, a stroke that turns to
      // scrolling goes back to the page, so the terminal's one-finger scroll is not held up
      if (!claimed && verdict === "pending") return;
      // A long press can open a sheet while the stroke is still waiting for the drawer to move.
      if (verdict === "ignore" || (!done && document.querySelector(MODAL) !== null)) { onEnd(); return; }
      claimed = true;
      // a recognised swipe belongs to the drawer, not to the terminal or list under the finger
      // After an uncancelled first move Chromium may send non-cancelable moves even on a
      // horizontal stroke that scrolls nothing. The direction test still decides ownership.
      if (event.cancelable !== false) event.preventDefault();
      event.stopPropagation();
      if (!done && (verdict === "open" || verdict === "close")) {
        // Pending interior moves reached the terminal. Cancel their queued/remainder work before
        // showing the drawer, while still letting end/cancel reach every consumer for cleanup.
        if (!start.open && start.x > EDGE_PX) {
          // No scroll has won before this claim. Freeze native scrolling for the held stroke;
          // instant layout writes can still follow streaming text through overflow:hidden.
          const target = start.path.find((node) => (node as Node).isConnected !== false) ?? null;
          start.scrolls = scrollOrigins(target);
          lockScroll(start.scrolls);
          claimTouchStroke(start.path);
        }
        state = verdict === "open";
        setOpen(state);
        done = true;
      }
      track(touch.clientX - start.x, touch.clientX, event.timeStamp);
    } catch (error) {
      try { onEnd(undefined, false); }
      finally { unlockScroll(); }
      throw error;
    }
  };
  const track = (dx: number, x: number, at: number): void => {
    if (start === null) return;
    if (follow === null) {
      const drawer = document.getElementById?.("workspace-drawer") ?? null;
      if (drawer === null) return;
      const scrim = document.querySelector<HTMLElement>(".scrim");
      // a flick may lift after one move: its speed so far is measured from where the finger came down
      const speed = at > start.at ? (x - start.x) / (at - start.at) : 0;
      follow = { drawer, scrim, width: drawer.getBoundingClientRect().width, shown: 0, x, at, speed };
      drawer.style.transition = "none";
      drawer.style.visibility = "visible";
      if (scrim !== null) scrim.style.transition = "none";
    }
    const shown = Math.min(follow.width, Math.max(0, (start.open ? follow.width : 0) + dx));
    if (at > follow.at) follow.speed = (x - follow.x) / (at - follow.at);
    follow.shown = shown;
    follow.x = x;
    follow.at = at;
    follow.drawer.style.transform = `translateX(${shown - follow.width}px)`;
    if (follow.scrim !== null) follow.scrim.style.opacity = String(shown / Math.max(1, follow.width));
  };
  /** Ends the stroke; returns what the drawer is set to now. */
  const onEnd = (event?: TouchEvent, forcedState?: boolean): boolean => {
    clearTouchOrigin();
    const held = follow;
    try {
      if (forcedState === undefined && pageScrolled()) forcedState = false;
    } finally { unlockScroll(); }
    // Near the right edge there may be too little room to reveal half the drawer. Reaching
    // the interior opening threshold is enough, unless the finger flicked back to close it.
    const interiorOpening = start !== null && !start.open && start.x > EDGE_PX && held !== null && held.x - start.x >= SWIPE_PX;
    start = null;
    claimed = false;
    done = false;
    follow = null;
    if (held === null) {
      if (forcedState !== undefined && forcedState !== state) { state = forcedState; setOpen(state); }
      return state;
    }
    // a finger that rested before it lifted, or a stroke handed back mid-way, flicks nothing
    const rested = event === undefined || event.timeStamp - held.at > REST_MS;
    const speed = rested ? 0 : held.speed;
    const open = forcedState ?? ((interiorOpening && speed > -FLING_SPEED) || drawerSettles(held.shown, held.width, speed));
    if (open !== state) setOpen(open);
    state = open;
    held.drawer.style.transition = "";
    held.drawer.style.visibility = "";
    held.drawer.style.transform = "";
    if (held.scrim !== null) { held.scrim.style.transition = ""; held.scrim.style.opacity = ""; }
    return open;
  };
  // A compositor update can arrive after the claiming move. While held, actual movement
  // still yields if the native lock failed. After lift, automatic receipts may scroll freely.
  const onScroll = (): void => { if (pageScrolled()) onEnd(undefined, false); };
  // Check first: a pending native scroll cannot be hidden by the layout's next absolute write.
  const onLayoutStart = (event: Event): void => {
    const origin = start?.scrolls.find(({ node }) => node === event.target);
    if (!origin) return;
    if (origin.depth === 0 && pageScrolled()) { onEnd(undefined, false); return; }
    origin.depth++;
  };
  const onLayoutEnd = (event: Event): void => {
    const origin = start?.scrolls.find(({ node }) => node === event.target);
    if (origin && origin.depth > 0 && --origin.depth === 0) {
      origin.top = origin.node.scrollTop;
      origin.left = origin.node.scrollLeft;
      origin.maxTop = Math.max(0, origin.node.scrollHeight - origin.node.clientHeight);
    }
  };
  const onWidthChange = (): void => { if (!narrow.matches) onEnd(); };
  const onBackground = (): void => { onEnd(); };
  const onVisibility = (): void => { if (document.visibilityState === "hidden") onEnd(); };
  window.addEventListener?.("blur", onBackground);
  window.addEventListener?.("pagehide", onBackground);
  document.addEventListener("visibilitychange", onVisibility);
  narrow.addEventListener?.("change", onWidthChange);
  document.addEventListener(LAYOUT_SCROLL_START, onLayoutStart, { capture: true });
  document.addEventListener(LAYOUT_SCROLL_END, onLayoutEnd, { capture: true });
  document.addEventListener("scroll", onScroll, { capture: true, passive: true });
  document.addEventListener("touchstart", onStart, { capture: true, passive: true });
  document.addEventListener("touchmove", onMove, { capture: true, passive: false });
  document.addEventListener("touchend", onEnd, { capture: true, passive: true });
  document.addEventListener("touchcancel", onEnd, { capture: true, passive: true });
  return () => {
    clearTouchOrigin();
    unlockScroll();
    window.removeEventListener?.("blur", onBackground);
    window.removeEventListener?.("pagehide", onBackground);
    document.removeEventListener("visibilitychange", onVisibility);
    narrow.removeEventListener?.("change", onWidthChange);
    document.removeEventListener(LAYOUT_SCROLL_START, onLayoutStart, { capture: true });
    document.removeEventListener(LAYOUT_SCROLL_END, onLayoutEnd, { capture: true });
    document.removeEventListener("scroll", onScroll, { capture: true });
    document.removeEventListener("touchstart", onStart, { capture: true });
    document.removeEventListener("touchmove", onMove, { capture: true });
    document.removeEventListener("touchend", onEnd, { capture: true });
    document.removeEventListener("touchcancel", onEnd, { capture: true });
  };
}
