import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";

import { useT } from "../lib/i18n.ts";
import { currentHeading, type OutlineEntry } from "../lib/markdownOutline.ts";

const JUMP_INSET_PX = 8;
const READING_LINE_PX = 32;
export const OUTLINE_COLUMN_MIN_PX = 760;

function headingsIn(scroller: HTMLElement): NodeListOf<HTMLElement> {
  return scroller.querySelectorAll<HTMLElement>(".file-viewer-markdown > h3");
}

export function useWideEnough(element: HTMLElement | null, min: number): boolean {
  const [wide, setWide] = useState(false);
  useLayoutEffect(() => {
    if (element === null) return;
    setWide(element.clientWidth >= min);
    const observer = new ResizeObserver(() => setWide(element.clientWidth >= min));
    observer.observe(element);
    return () => observer.disconnect();
  }, [element, min]);
  return wide;
}

export interface MarkdownOutlineProps {
  id: string;
  entries: readonly OutlineEntry[];
  scroller: RefObject<HTMLElement | null>;
  drawer: boolean;
  toggle: RefObject<HTMLElement | null>;
  onClose: (refocus: boolean) => void;
}

export function MarkdownOutline({ id, entries, scroller, drawer, toggle, onClose }: MarkdownOutlineProps) {
  const t = useT();
  const list = useRef<HTMLElement>(null);
  const [active, setActive] = useState(-1);
  const chosen = useRef<{ index: number; scrollTop: number } | null>(null);
  const shallowest = Math.min(...entries.map((entry) => entry.level));

  useLayoutEffect(() => {
    const box = scroller.current;
    if (box === null) return;
    let frame = 0;
    const measure = (): void => {
      frame = 0;
      if (chosen.current !== null && Math.abs(box.scrollTop - chosen.current.scrollTop) < 1) {
        setActive(chosen.current.index);
        return;
      }
      chosen.current = null;
      const top = box.getBoundingClientRect().top;
      const headings = headingsIn(box);
      const atEnd = box.scrollTop > 0 && box.scrollTop + box.clientHeight >= box.scrollHeight - 1;
      setActive(currentHeading(entries.map((entry) => (headings[entry.at]?.getBoundingClientRect().top ?? Infinity) - top), atEnd ? box.clientHeight : READING_LINE_PX));
    };
    measure();
    const onScroll = (): void => { if (frame === 0) frame = requestAnimationFrame(measure); };
    box.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      box.removeEventListener("scroll", onScroll);
      cancelAnimationFrame(frame);
    };
  }, [scroller, entries]);

  useLayoutEffect(() => {
    const box = list.current;
    if (box === null) return;
    const item = box.querySelector<HTMLElement>("[aria-current]");
    box.scrollTop = item === null ? 0 : item.offsetTop - (box.clientHeight - item.offsetHeight) / 2;
  }, [active]);

  const focusedIn = useRef(false);
  useLayoutEffect(() => {
    if (!drawer || focusedIn.current || active < 0) return;
    focusedIn.current = true;
    list.current?.querySelector<HTMLElement>("[aria-current]")?.focus({ preventScroll: true });
  }, [drawer, active]);

  useEffect(() => {
    if (!drawer) return;
    const onPointer = (event: PointerEvent): void => {
      const target = event.target as Node;
      if (!list.current?.contains(target) && !toggle.current?.contains(target)) onClose(false);
    };
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== "Escape" || event.isComposing) return;
      const viewer = list.current?.closest("[role=dialog], .file-panel, .file-reader");
      if (!viewer?.contains(document.activeElement)) return;
      if (document.activeElement?.closest("[role=menu]")) return;
      event.stopPropagation();
      onClose(true);
    };
    document.addEventListener("pointerdown", onPointer);
    window.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [drawer, toggle, onClose]);

  const choose = (entry: OutlineEntry, index: number): void => {
    const box = scroller.current;
    const heading = box === null ? undefined : headingsIn(box)[entry.at];
    if (box === null || heading === undefined) return;
    box.scrollTop += heading.getBoundingClientRect().top - box.getBoundingClientRect().top - JUMP_INSET_PX;
    chosen.current = { index, scrollTop: box.scrollTop };
    setActive(index);
    if (drawer) onClose(true);
  };

  return <nav ref={list} id={id} className={drawer ? "markdown-outline is-drawer" : "markdown-outline"} aria-label={t("Outline")} data-sheet-stroke="own">
    <ol>
      {entries.map((entry, index) => <li key={entry.at}>
        <button type="button" className={`markdown-outline-item is-depth-${entry.level - shallowest}`} aria-current={index === active ? "location" : undefined} title={entry.text} onClick={() => choose(entry, index)}>{entry.text}</button>
      </li>)}
    </ol>
  </nav>;
}
