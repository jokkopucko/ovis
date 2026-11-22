import { useLayoutEffect, type RefObject } from "react";

import { chatLaneLength, useSettings } from "./settings.ts";

/**
 * A percentage would resolve against each column's own box and leave them a gutter apart. The lane's
 * ceiling stays 60rem inside the length, so a change of the browser's font size moves it at once, as it
 * moves Wide's 72rem.
 */
function useLaneOf(target: RefObject<HTMLElement | null>, locate: () => HTMLElement | null, key: string | null): void {
  const { settings } = useSettings();
  useLayoutEffect(() => {
    const surface = target.current;
    if (!surface) return;
    const pane = settings.chatWidth === "default" ? locate() : null;
    if (!pane) {
      surface.style.removeProperty("--chat-w");
      return;
    }
    const apply = (): void => {
      if (pane.isConnected) surface.style.setProperty("--chat-w", chatLaneLength(pane.clientWidth));
      else surface.style.removeProperty("--chat-w");
    };
    apply();
    const observer = new ResizeObserver(apply);
    observer.observe(pane);
    return () => observer.disconnect();
  }, [target, key, settings.chatWidth]);
}

export function usePaneLane(stack: RefObject<HTMLElement | null>): void {
  useLaneOf(stack, () => stack.current, null);
}

export function useOpeningPaneLane(target: RefObject<HTMLElement | null>, owner: string | null): void {
  useLaneOf(target, () => owner === null ? null : document.querySelector<HTMLElement>(`.terminal-stack[data-pane-owner="${CSS.escape(owner)}"]`), owner);
}
