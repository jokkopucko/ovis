import { useLayoutEffect, useRef, useState } from "react";
import { ChevronDown, FolderOpen } from "lucide-react";

import { useT } from "../lib/i18n.ts";
import { useMediaQuery } from "../lib/useMediaQuery.ts";
import { RowMenu, type RowMenuItem } from "./RowMenu.tsx";

const SWIPE_QUERY = "(max-width: 640px), (pointer: coarse)";
/** folders offered at first, and how many more each "Show more" brings */
export const RECENT_FOLDERS_PAGE = 10;

interface Props {
  folders: readonly string[];
  disabled: boolean;
  labelledBy: string;
  basename: (path: string) => string;
  onPick: (path: string) => void;
}

export function chipsThatFit(widths: readonly number[], more: number, gap: number, room: number, overflow = false): number {
  const total = (count: number): number => widths.slice(0, count).reduce((sum, width) => sum + width, 0) + gap * Math.max(0, count - 1);
  if (!overflow && total(widths.length) <= room) return widths.length;
  for (let count = overflow ? widths.length : widths.length - 1; count > 0; count -= 1) {
    if (total(count) + gap + more <= room) return count;
  }
  return Math.min(1, widths.length);
}

export function RecentFolderChips({ folders, disabled, labelledBy, basename, onPick }: Props) {
  const t = useT();
  const swipe = useMediaQuery(SWIPE_QUERY);
  const row = useRef<HTMLDivElement>(null);
  const measure = useRef<HTMLDivElement>(null);
  const focusAfterExpand = useRef<number | null>(null);
  const [limit, setLimit] = useState(RECENT_FOLDERS_PAGE);
  const loaded = folders.slice(0, limit);
  const unloaded = folders.length - loaded.length;
  const [fit, setFit] = useState(loaded.length);
  const [menu, setMenu] = useState<HTMLElement | null>(null);

  useLayoutEffect(() => {
    const index = focusAfterExpand.current;
    if (index === null) return;
    if (swipe) row.current?.querySelectorAll("button")[index]?.focus({ preventScroll: true });
    focusAfterExpand.current = null;
  }, [limit, swipe]);

  useLayoutEffect(() => {
    if (swipe) return;
    const place = (): void => {
      const box = row.current;
      const sizes = measure.current;
      if (!box || !sizes) return;
      const chips = [...sizes.children].map((node) => (node as HTMLElement).getBoundingClientRect().width);
      const more = chips.pop() ?? 0;
      const gap = Number.parseFloat(getComputedStyle(box).columnGap) || 0;
      setFit(chipsThatFit(chips, more, gap, box.clientWidth, unloaded > 0));
    };
    place();
    const observer = new ResizeObserver(place);
    if (row.current) observer.observe(row.current);
    void document.fonts?.ready.then(place);
    return () => observer.disconnect();
  }, [swipe, folders, limit]);

  const shown = swipe ? loaded : loaded.slice(0, fit);
  const rest = swipe ? [] : loaded.slice(fit);
  const hidden = folders.length - shown.length;
  const next = Math.min(unloaded, RECENT_FOLDERS_PAGE);
  const showMore = (): void => setLimit((count) => count + RECENT_FOLDERS_PAGE);
  const items: RowMenuItem[] = rest.map((path) => ({ id: path, label: basename(path), hint: path, title: path, icon: FolderOpen, run: () => onPick(path) }));
  if (unloaded > 0) items.push({ id: "show-more", label: t("Show {n} more", { n: next }), icon: ChevronDown, divider: rest.length > 0, keepOpen: true, run: showMore });
  const chip = (path: string) => <button type="button" className="btn new-session-folder-chip" key={path}
    disabled={disabled} title={path} aria-label={t("Use folder {path}", { path })} onClick={() => onPick(path)}>
    <FolderOpen aria-hidden="true" /><span>{basename(path)}</span>
  </button>;

  return <div className="new-session-folder-chips-frame">
    <div ref={row} className="new-session-folder-chips" role="group" aria-labelledby={labelledBy} onFocus={(event) => {
      // The dialog traps Tab with preventScroll, so reveal keyboard focus in the swipe row.
      if (swipe && (focusAfterExpand.current !== null || event.target.matches(":focus-visible"))) {
        event.target.scrollIntoView({ block: "nearest", inline: "nearest" });
      }
    }}>
      {shown.map(chip)}
      {swipe && unloaded > 0 && <button type="button" className="btn new-session-folder-chip new-session-folder-more" disabled={disabled}
        aria-label={`+${unloaded}: ${t("Show {n} more", { n: next })}`} onClick={(event) => {
          if (event.detail === 0) focusAfterExpand.current = shown.length;
          showMore();
        }}>
        +{unloaded}
      </button>}
      {!swipe && hidden > 0 && <button type="button" className="btn new-session-folder-chip new-session-folder-more" disabled={disabled}
        aria-haspopup="menu" aria-expanded={menu !== null} aria-label={t("{n} more recent folders", { n: hidden })}
        onClick={(event) => { const anchor = event.currentTarget; setMenu((open) => open ? null : anchor); }}>
        +{hidden}
      </button>}
    </div>
    {!swipe && <div className="new-session-folder-measure-clip" aria-hidden="true">
      <div ref={measure} className="new-session-folder-measure">
        {loaded.map((path) => <span key={path} className="btn new-session-folder-chip"><FolderOpen aria-hidden="true" /><span>{basename(path)}</span></span>)}
        <span className="btn new-session-folder-chip new-session-folder-more">+{folders.length}</span>
      </div>
    </div>}
    {menu && !swipe && items.length > 0 && <RowMenu anchor={menu} title={t("Recent folders")} variant="paths" onClose={() => setMenu(null)} items={items} />}
  </div>;
}
