import { useEffectEvent, useLayoutEffect, useState, type RefObject } from "react";

import { safeAreaInsets } from "../lib/safeArea.ts";

const GAP = 4;
const EDGE = 8;

interface Options {
  readonly anchor: HTMLElement;
  readonly surface: RefObject<HTMLDivElement | null>;
  readonly point?: { readonly x: number; readonly y: number };
  readonly align: "start" | "end";
  readonly sheet: boolean;
  readonly onClose: () => void;
}

export function useRowMenuPosition({ anchor, surface, point, align, sheet, onClose }: Options) {
  const [place, setPlace] = useState<{ top: number; left: number; maxHeight: number } | null>(null);
  const close = useEffectEvent(onClose);

  useLayoutEffect(() => {
    if (sheet) return;
    const menu = surface.current;
    if (menu === null || !anchor.isConnected) { close(); return; }
    const origin = anchor.getBoundingClientRect();
    const clips: { readonly parent: HTMLElement; readonly x: boolean; readonly y: boolean }[] = [];
    for (let parent = anchor.parentElement; parent && parent !== document.documentElement; parent = parent.parentElement) {
      const { overflowX, overflowY } = getComputedStyle(parent);
      const x = overflowX !== "visible";
      const y = overflowY !== "visible";
      if (x || y) clips.push({ parent, x, y });
    }
    let last = origin;
    let width = window.innerWidth;
    let height = window.innerHeight;
    // Measure the full height even when maxHeight keeps the menu's visible box from growing.
    const fullMenuHeight = () => menu.scrollHeight + menu.offsetHeight - menu.clientHeight;
    let menuWidth = menu.offsetWidth;
    let menuHeight = fullMenuHeight();

    const position = (rect: DOMRect): void => {
      const safe = safeAreaInsets();
      const minX = safe.left + EDGE;
      const maxX = width - safe.right - EDGE;
      const minY = safe.top + EDGE;
      const maxY = height - safe.bottom - EDGE;
      if (point) {
        setPlace({
          left: Math.max(minX, Math.min(point.x + rect.left - origin.left, maxX - menuWidth)),
          top: Math.max(minY, Math.min(point.y + rect.top - origin.top, maxY - menuHeight)),
          maxHeight: maxY - minY,
        });
        return;
      }
      const left = Math.max(minX, Math.min(align === "start" ? rect.left : rect.right - menuWidth, maxX - menuWidth));
      const below = rect.bottom + GAP;
      const roomBelow = maxY - below;
      const roomAbove = rect.top - GAP - minY;
      const up = below + menuHeight > maxY && roomAbove > roomBelow;
      const top = up ? Math.max(minY, rect.top - GAP - menuHeight) : below;
      setPlace({ top, left, maxHeight: Math.max(EDGE, up ? roomAbove : roomBelow) });
    };

    // Sample while open: a row can move when a badge appears without either resizing or scrolling.
    const follow = (): void => {
      if (!anchor.isConnected) { close(); return; }
      const rect = anchor.getBoundingClientRect();
      let left = Math.max(0, rect.left), right = Math.min(window.innerWidth, rect.right);
      let top = Math.max(0, rect.top), bottom = Math.min(window.innerHeight, rect.bottom);
      for (const { parent, x, y } of clips) {
        const bounds = parent.getBoundingClientRect();
        if (x) {
          const edge = bounds.left + parent.clientLeft;
          left = Math.max(left, edge);
          right = Math.min(right, edge + parent.clientWidth);
        }
        if (y) {
          const edge = bounds.top + parent.clientTop;
          top = Math.max(top, edge);
          bottom = Math.min(bottom, edge + parent.clientHeight);
        }
      }
      if (left >= right || top >= bottom) { close(); return; }
      const nextMenuWidth = menu.offsetWidth;
      const nextMenuHeight = fullMenuHeight();
      if (rect.top !== last.top || rect.left !== last.left || rect.right !== last.right || rect.bottom !== last.bottom ||
          width !== window.innerWidth || height !== window.innerHeight ||
          menuWidth !== nextMenuWidth || menuHeight !== nextMenuHeight) {
        last = rect;
        width = window.innerWidth;
        height = window.innerHeight;
        menuWidth = nextMenuWidth;
        menuHeight = nextMenuHeight;
        position(rect);
      }
      frame = window.requestAnimationFrame(follow);
    };
    position(origin);
    let frame = window.requestAnimationFrame(follow);
    return () => window.cancelAnimationFrame(frame);
  }, [align, anchor, point, sheet, surface]);

  return place;
}
