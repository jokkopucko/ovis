/*
 * React removes a closed sheet at once, so the drop is drawn by its last frame: the removed
 * scrim is put back, inert and hidden from assistive tech, inside a closed shadow root at the
 * end of <body>, and goes once it has slid out (`.is-leaving`). There no query of the page (the
 * app's, a browser script's) finds it, so a sheet opened again at once is the only one of its
 * kind; the root adopts the page's own rules, under the <html> element's data attributes, so it
 * looks as it did.
 */
import { useEffect, useRef, type MutableRefObject, type RefObject } from "react";

export const SHEET_QUERY = "(max-width: 640px)";

const SLOP_PX = 8;
export const DISMISS_SHARE = 0.3;
export const FLICK_SPEED = 0.5;
export const REST_MS = 100;
const LEAVE_MS = 600;

export type SheetDragVerdict = "pending" | "drag" | "ignore";

export function sheetDragVerdict(dx: number, dy: number, scrolled: number): SheetDragVerdict {
  if (Math.abs(dx) < SLOP_PX && Math.abs(dy) < SLOP_PX) return "pending";
  if (dy <= 0 || Math.abs(dx) >= Math.abs(dy) || scrolled > 0) return "ignore";
  return "drag";
}

export function sheetDismisses(offset: number, height: number, speed: number): boolean {
  return offset > height * DISMISS_SHARE || (speed > FLICK_SPEED && offset > SLOP_PX);
}

const media = (query: string): MediaQueryList | null => (typeof window === "undefined" ? null : window.matchMedia?.(query) ?? null);

function scrolledUnder(target: EventTarget | null, surface: HTMLElement): number {
  for (let node = target instanceof Element ? target : null; node; node = node.parentElement) {
    if (node.scrollTop > 0) return node.scrollTop;
    if (node === surface) break;
  }
  return 0;
}

function ownsStroke(target: EventTarget | null, surface: HTMLElement): boolean {
  for (let node = target instanceof HTMLElement ? target : null; node && node !== surface; node = node.parentElement) {
    if (node.dataset["sheetStroke"] === "own" || node.isContentEditable || /^(?:INPUT|TEXTAREA|SELECT)$/.test(node.tagName)) return true;
    const style = getComputedStyle(node);
    if (style.touchAction === "none" || style.position === "fixed") return true;
  }
  return false;
}

function fadedScrim(color: string, keep: number): string | null {
  const parts = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:\s*[,/]\s*([\d.]+)(%?))?\s*\)$/.exec(color);
  if (!parts) return null;
  const alpha = parts[4] === undefined ? 1 : Number(parts[4]) / (parts[5] === "%" ? 100 : 1);
  return `rgba(${parts[1]}, ${parts[2]}, ${parts[3]}, ${Math.max(0, alpha * keep)})`;
}

export function useSheetSwipe(surface: RefObject<HTMLElement | null>, onDismiss: (() => void) | null): void {
  const dismiss = useLatest(onDismiss);
  useEffect(() => {
    const sheets = media(SHEET_QUERY);
    if (!sheets) return;
    let stroke: { x: number; y: number; scrolled: number; node: HTMLElement } | null = null;
    let drag: { scrim: HTMLElement; color: string; height: number; offset: number; at: number; speed: number } | null = null;

    const onStart = (event: TouchEvent): void => {
      const node = surface.current;
      const touch = event.touches[0];
      // a second finger makes it a pinch, the page's zoom: a sheet being dragged springs back, and
      // no later move of this gesture is held from the browser
      if (drag !== null && stroke !== null) settle(stroke.node, drag.scrim);
      stroke = null;
      drag = null;
      if (!node || !touch || event.touches.length !== 1 || !sheets.matches || dismiss.current === null) return;
      if (!node.contains(event.target as Node) || ownsStroke(event.target, node)) return;
      stroke = { x: touch.clientX, y: touch.clientY, scrolled: scrolledUnder(event.target, node), node };
    };

    const onMove = (event: TouchEvent): void => {
      const touch = event.touches[0];
      if (stroke === null || !touch || event.touches.length !== 1) return;
      const dx = touch.clientX - stroke.x;
      const dy = touch.clientY - stroke.y;
      if (drag === null) {
        const verdict = sheetDragVerdict(dx, dy, stroke.scrolled);
        if (verdict === "pending") return;
        const scrim = stroke.node.parentElement;
        if (verdict === "ignore" || !scrim) { stroke = null; return; }
        for (const animation of [...stroke.node.getAnimations(), ...scrim.getAnimations()]) animation.cancel();
        drag = { scrim, color: getComputedStyle(scrim).backgroundColor, height: stroke.node.getBoundingClientRect().height, offset: 0, at: event.timeStamp, speed: 0 };
        stroke.node.style.transition = "none";
        scrim.style.transition = "none";
      }
      event.preventDefault();
      const offset = Math.max(0, dy);
      const elapsed = event.timeStamp - drag.at;
      if (elapsed > 0) drag.speed = (offset - drag.offset) / elapsed;
      drag.offset = offset;
      drag.at = event.timeStamp;
      stroke.node.style.transform = `translateY(${offset}px)`;
      const faded = fadedScrim(drag.color, 1 - Math.min(1, offset / Math.max(1, drag.height)));
      if (faded !== null) drag.scrim.style.backgroundColor = faded;
    };

    const onEnd = (event: TouchEvent): void => {
      const node = stroke?.node;
      const was = drag;
      stroke = null;
      drag = null;
      if (!node || was === null) return;
      if (event.timeStamp - was.at > REST_MS) was.speed = 0;
      const close = dismiss.current;
      if (close !== null && sheetDismisses(was.offset, was.height, was.speed)) {
        close();
        requestAnimationFrame(() => requestAnimationFrame(() => { if (node.isConnected && !was.scrim.classList.contains("is-leaving")) settle(node, was.scrim); }));
        return;
      }
      settle(node, was.scrim);
    };

    document.addEventListener("touchstart", onStart, { capture: true, passive: true });
    document.addEventListener("touchmove", onMove, { capture: true, passive: false });
    document.addEventListener("touchend", onEnd, { capture: true, passive: true });
    document.addEventListener("touchcancel", onEnd, { capture: true, passive: true });
    return () => {
      document.removeEventListener("touchstart", onStart, { capture: true });
      document.removeEventListener("touchmove", onMove, { capture: true });
      document.removeEventListener("touchend", onEnd, { capture: true });
      document.removeEventListener("touchcancel", onEnd, { capture: true });
    };
  }, [surface, dismiss]);
}

function settle(node: HTMLElement, scrim: HTMLElement): void {
  const reduced = media("(prefers-reduced-motion: reduce)")?.matches === true;
  const timing = reduced ? "none" : "transform var(--dur-sheet) var(--ease-spring)";
  node.style.transition = timing;
  scrim.style.transition = reduced ? "none" : "background-color var(--dur-sheet) var(--ease-out)";
  node.style.transform = "";
  scrim.style.backgroundColor = "";
  const clear = (): void => { node.style.transition = ""; scrim.style.transition = ""; };
  if (reduced) clear();
  else node.addEventListener("transitionend", clear, { once: true });
}

function useLatest<T>(value: T): MutableRefObject<T> {
  const ref = useRef(value);
  ref.current = value;
  return ref;
}

let pageRules: { count: number; sheet: CSSStyleSheet } | null = null;
function pageStyles(): CSSStyleSheet | null {
  if (typeof CSSStyleSheet === "undefined" || !("adoptedStyleSheets" in ShadowRoot.prototype)) return null;
  if (pageRules?.count === document.styleSheets.length) return pageRules.sheet;
  let text = "";
  for (const sheet of document.styleSheets) {
    try {
      for (const rule of sheet.cssRules) if (!(rule instanceof CSSImportRule)) text += `${rule.cssText}\n`;
    } catch {
      // another origin's sheet keeps its rules to itself; none of the app's is one
    }
  }
  const sheet = new CSSStyleSheet();
  try { sheet.replaceSync(text); } catch { return null; }
  pageRules = { count: document.styleSheets.length, sheet };
  return sheet;
}

function leave(scrim: HTMLElement, scrolled: WeakMap<Element, number>): void {
  const rules = pageStyles();
  // a browser with no adoptable sheets has no way to draw it apart from the page: it goes at once
  if (rules === null) return;
  for (const node of scrim.querySelectorAll("iframe, embed, object, video, audio")) node.remove();
  scrim.classList.add("is-leaving");
  const host = document.createElement("div");
  host.inert = true;
  host.setAttribute("aria-hidden", "true");
  const root = host.attachShadow({ mode: "closed" });
  root.adoptedStyleSheets = [rules];
  const page = document.createElement("div");
  for (const { name, value } of document.documentElement.attributes) if (name.startsWith("data-")) page.setAttribute(name, value);
  page.append(scrim);
  root.append(page);
  document.body.append(host);
  // a list put back starts at its top: it drops where the reader had it
  for (const node of [scrim, ...scrim.querySelectorAll("*")]) {
    const top = scrolled.get(node);
    if (top !== undefined) node.scrollTop = top;
  }
  let timer = 0;
  const gone = (): void => { window.clearTimeout(timer); host.remove(); };
  timer = window.setTimeout(gone, LEAVE_MS);
  scrim.addEventListener("animationend", (event) => { if (event.animationName === "sheet-out") gone(); });
}

export function watchSheetExits(): () => void {
  const sheets = media(SHEET_QUERY);
  const reduced = media("(prefers-reduced-motion: reduce)");
  const open = new Set<HTMLElement>();
  // where each list in an open sheet is scrolled to: a detached one reads 0, and its drop should not jump
  const scrolled = new WeakMap<Element, number>();
  const onScroll = (event: Event): void => {
    const node = event.target;
    if (open.size > 0 && node instanceof Element && node.closest(".modal-scrim") !== null) scrolled.set(node, node.scrollTop);
  };
  const observer = new MutationObserver(() => {
    for (const scrim of open) {
      if (scrim.isConnected) continue;
      open.delete(scrim);
      if (sheets?.matches === true && reduced?.matches !== true && !scrim.classList.contains("is-leaving")) leave(scrim, scrolled);
    }
    if (open.size === 0) observer.disconnect();
  });
  const onStart = (event: AnimationEvent): void => {
    const scrim = event.target;
    if (event.animationName !== "scrim-in" || !(scrim instanceof HTMLElement)) return;
    if (open.size === 0) observer.observe(document.body, { childList: true, subtree: true });
    open.add(scrim);
  };
  document.addEventListener("animationstart", onStart, true);
  document.addEventListener("scroll", onScroll, { capture: true, passive: true });
  return () => {
    document.removeEventListener("animationstart", onStart, true);
    document.removeEventListener("scroll", onScroll, { capture: true });
    observer.disconnect();
    open.clear();
  };
}
