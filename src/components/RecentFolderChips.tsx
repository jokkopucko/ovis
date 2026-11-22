import { useLayoutEffect, useRef, useState } from "react";
import { FolderOpen } from "lucide-react";

import { useT } from "../lib/i18n.ts";
import { useMediaQuery } from "../lib/useMediaQuery.ts";
import { RowMenu } from "./RowMenu.tsx";

const SWIPE_QUERY = "(max-width: 640px), (pointer: coarse)";

interface Props {
  folders: readonly string[];
  disabled: boolean;
  labelledBy: string;
  basename: (path: string) => string;
  onPick: (path: string) => void;
}

export function chipsThatFit(widths: readonly number[], more: number, gap: number, room: number): number {
  const total = (count: number): number => widths.slice(0, count).reduce((sum, width) => sum + width, 0) + gap * Math.max(0, count - 1);
  if (total(widths.length) <= room) return widths.length;
  for (let count = widths.length - 1; count > 0; count -= 1) {
    if (total(count) + gap + more <= room) return count;
  }
  return Math.min(1, widths.length);
}

export function RecentFolderChips({ folders, disabled, labelledBy, basename, onPick }: Props) {
  const t = useT();
  const swipe = useMediaQuery(SWIPE_QUERY);
  const row = useRef<HTMLDivElement>(null);
  const measure = useRef<HTMLDivElement>(null);
  const [fit, setFit] = useState(folders.length);
  const [menu, setMenu] = useState<HTMLElement | null>(null);

  useLayoutEffect(() => {
    if (swipe) return;
    const place = (): void => {
      const box = row.current;
      const sizes = measure.current;
      if (!box || !sizes) return;
      const chips = [...sizes.children].map((node) => (node as HTMLElement).getBoundingClientRect().width);
      const more = chips.pop() ?? 0;
      const gap = Number.parseFloat(getComputedStyle(box).columnGap) || 0;
      setFit(chipsThatFit(chips, more, gap, box.clientWidth));
    };
    place();
    const observer = new ResizeObserver(place);
    if (row.current) observer.observe(row.current);
    void document.fonts?.ready.then(place);
    return () => observer.disconnect();
  }, [swipe, folders]);

  const shown = swipe ? folders : folders.slice(0, fit);
  const rest = swipe ? [] : folders.slice(fit);
  const chip = (path: string) => <button type="button" className="btn new-session-folder-chip" key={path}
    disabled={disabled} title={path} aria-label={t("Use folder {path}", { path })} onClick={() => onPick(path)}>
    <FolderOpen aria-hidden="true" /><span>{basename(path)}</span>
  </button>;

  return <div className="new-session-folder-chips-frame">
    <div ref={row} className="new-session-folder-chips" role="group" aria-labelledby={labelledBy}>
      {shown.map(chip)}
      {rest.length > 0 && <button type="button" className="btn new-session-folder-chip new-session-folder-more" disabled={disabled}
        aria-haspopup="menu" aria-expanded={menu !== null} aria-label={t("{n} more recent folders", { n: rest.length })}
        onClick={(event) => { const anchor = event.currentTarget; setMenu((open) => open ? null : anchor); }}>
        +{rest.length}
      </button>}
    </div>
    {!swipe && <div className="new-session-folder-measure-clip" aria-hidden="true">
      <div ref={measure} className="new-session-folder-measure">
        {folders.map((path) => <span key={path} className="btn new-session-folder-chip"><FolderOpen aria-hidden="true" /><span>{basename(path)}</span></span>)}
        <span className="btn new-session-folder-chip new-session-folder-more">+{folders.length}</span>
      </div>
    </div>}
    {menu && rest.length > 0 && <RowMenu anchor={menu} title={t("Recent folders")} variant="paths" onClose={() => setMenu(null)}
      items={rest.map((path) => ({ id: path, label: basename(path), hint: path, title: path, icon: FolderOpen, run: () => onPick(path) }))} />}
  </div>;
}
