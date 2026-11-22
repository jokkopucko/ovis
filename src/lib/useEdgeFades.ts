import { useLayoutEffect, type RefObject } from "react";

import { requestShownFrame } from "./shownFrame.ts";

export function useEdgeFades(ref: RefObject<HTMLElement | null>): void {
  useLayoutEffect(() => {
    const list = ref.current;
    if (list === null || typeof list.toggleAttribute !== "function" || typeof list.addEventListener !== "function") return;
    let cancel: (() => void) | null = null;
    const read = (): void => {
      cancel = null;
      // a pixel of slack: a fractional scroll position never quite reaches the end
      list.toggleAttribute("data-fade-top", list.scrollTop > 1);
      list.toggleAttribute("data-fade-bottom", list.scrollTop + list.clientHeight < list.scrollHeight - 1);
    };
    const schedule = (): void => { cancel ??= requestShownFrame(read); };
    read();
    list.addEventListener("scroll", schedule, { passive: true });
    const resized = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(schedule);
    const observeRows = (): void => {
      if (resized === null) return;
      resized.disconnect();
      resized.observe(list);
      for (const child of list.children) resized.observe(child);
    };
    observeRows();
    const changed = typeof MutationObserver === "undefined" ? null : new MutationObserver(() => { observeRows(); schedule(); });
    changed?.observe(list, { childList: true, subtree: true, attributes: true, attributeFilter: ["hidden", "class"] });
    return () => {
      list.removeEventListener("scroll", schedule);
      resized?.disconnect();
      changed?.disconnect();
      cancel?.();
    };
  }, [ref]);
}
