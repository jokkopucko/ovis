import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { DEFAULT_VIRTUAL_FILE_METRICS, parsePatchFiles, trimPatchContext, type FileDiffMetadata, type VirtualizedFileDiff, type Virtualizer as VirtualizerInstance } from "@pierre/diffs";
import { FileDiff, useVirtualizer, Virtualizer, type FileDiffOptions } from "@pierre/diffs/react";
import { Plus } from "lucide-react";

import { DiffWorkerPool } from "./DiffWorkerPool.tsx";
import { useT } from "../lib/i18n.ts";
import { diffFindLines, type DiffSide } from "../lib/repoDiffFind.ts";
import type { DiffStyle } from "../lib/settings.ts";
import { VIRTUAL_HIGHLIGHT_LINES } from "../lib/sourcePreview.ts";
import { contentKey, keepEmptyRows, SCROLL_CONFIG, SHADOW_CSS, SOURCE_THEME } from "../lib/sourceTheme.ts";
import "./RepoDiff.css";

export interface RepoDiffProps {
  /** git's patch for one file, from its `diff --git` line on, whole */
  patch: string;
  style: DiffStyle;
  /** one unchanged line around each change instead of the three git printed; the rest counts in the separators */
  folded: boolean;
  wrap: boolean;
  theme: "dark" | "light";
  /** colored in the pool's worker; false draws plain rows, still windowed by the pool's manager (the setting off, or too long, which the host says) */
  colored: boolean;
  /** the active find match: its row is marked and its text highlighted, and it is brought to the middle of the view (the match itself, when its row is taller than the view) */
  active?: DiffMark | null;
  /** the active match is on a line the folded context leaves out: the host shows the context whole */
  onUnfold?: () => void;
  /**
   * A row was pointed at (#1603): `open` from the + a hovered row shows, which begins a note at once;
   * otherwise a click or tap on the row, which only picks its line. The row by its side and number.
   */
  onLine?: (side: "deletions" | "additions", lineNumber: number, open: boolean) => void;
  /** why no note can be begun (the hovered + then says so, disabled), or null */
  noteBlocked?: string | null;
}

/** A logical line of the patch (an unchanged line is anchored to the new side) and the columns of a match in it. */
export interface DiffMark {
  side: DiffSide;
  line: number;
  start: number;
  end: number;
  /** ringed where it is, never scrolled to: a line just clicked or tapped is in view already */
  quiet?: boolean;
}

/** The CSS highlight the active match's text is painted with (styled in the shadow CSS below). */
const FIND_HIGHLIGHT = "repo-diff-find";

// as VirtualSource's reveal: a row is re-read after each render a scroll causes, since rows past the
// measured ones are estimates; six passes settle every measured case with room
const MAX_REVEAL_PASSES = 6;

function VirtualizerProbe({ onInstance }: { onInstance: (instance: VirtualizerInstance | undefined) => void }) {
  const instance = useVirtualizer();
  useLayoutEffect(() => { onInstance(instance); }, [instance, onInstance]);
  return null;
}

/** The mounted row of a logical line: split draws each side in its own column; unified draws a deletion by its old number, the rest by their new one. */
function markRow(shadow: ShadowRoot, mark: DiffMark): HTMLElement | null {
  const split = shadow.querySelector("pre")?.getAttribute("data-diff-type") === "split";
  if (split) return shadow.querySelector<HTMLElement>(`code[data-${mark.side === "old" ? "deletions" : "additions"}] [data-line="${mark.line}"]`);
  return shadow.querySelector<HTMLElement>(mark.side === "old"
    ? `[data-line="${mark.line}"][data-line-type="change-deletion"]`
    : `[data-line="${mark.line}"]:not([data-line-type="change-deletion"])`);
}

/** The range of columns `start`..`end` of a row's text, across the token spans it is drawn in. */
function textRange(row: HTMLElement, start: number, end: number): Range | null {
  const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
  const range = document.createRange();
  let offset = 0;
  let started = false;
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    const length = node.textContent?.length ?? 0;
    if (!started && start < offset + length) { range.setStart(node, start - offset); started = true; }
    if (started && end <= offset + length) { range.setEnd(node, end - offset); return range; }
    offset += length;
  }
  return null;
}

/**
 * Brings a match's columns into view in its row's horizontal scroller (unwrapped rows; in split, its
 * side's column), centred beside the sticky line numbers; a match already in view stays put.
 */
function revealColumns(row: HTMLElement, mark: DiffMark): void {
  const scroller = row.closest<HTMLElement>("[data-code]");
  if (scroller === null || scroller.scrollWidth <= scroller.clientWidth + 1) return;
  const range = textRange(row, mark.start, mark.end);
  if (range === null) return;
  const match = range.getBoundingClientRect();
  const box = scroller.getBoundingClientRect();
  const left = Math.max(box.left, scroller.querySelector("[data-gutter]")?.getBoundingClientRect().right ?? box.left);
  const right = box.left + scroller.clientWidth;
  if (match.left >= left && match.right <= right) return;
  scroller.scrollLeft += (match.left + match.right) / 2 - (left + right) / 2;
}

/** The fewest context lines the package's trimmer keeps correct (at 0 it miscounts the lines it drops). */
export const FOLDED_CONTEXT_LINES = 1;

/**
 * The diff colors on top of the source theme: the app's inserted/deleted tokens as the package's
 * base colors. Its gutter bars, signs and word emphasis take them verbatim, and it mixes the row
 * backgrounds from them and the app's background itself (an override here would be mixed again).
 */
const DIFF_SHADOW_CSS = `${SHADOW_CSS}
:host {
  --diffs-light-addition-color: var(--syntax-inserted);
  --diffs-dark-addition-color: var(--syntax-inserted);
  --diffs-light-deletion-color: var(--syntax-deleted);
  --diffs-dark-deletion-color: var(--syntax-deleted);
  --diffs-bg-separator-override: var(--bg-elevated);
  --diffs-bg-context-override: var(--bg);
  --diffs-bg-context-gutter-override: var(--bg);
  --diffs-header-font-family: var(--font-ui);
}
/* the active find match: an inset ring around its row and its text in reverse, so it is not told by the tint alone */
[data-line][data-find-active] {
  box-shadow: inset 0 0 0 2px var(--accent);
}
::highlight(${FIND_HIGHLIGHT}) {
  background-color: var(--accent);
  color: var(--bg);
}
`;

type Options = FileDiffOptions<undefined, undefined>;

/** Pierre's reading of the patch: its one file, parsed strictly so a form it does not read fails here, not in a row. */
function parseFile(text: string): FileDiffMetadata | null {
  return parsePatchFiles(text, contentKey("repo-diff", text), true)[0]?.files[0] ?? null;
}

/**
 * One file's diff as a window of rows from the package's virtualizer, unified or split, with the
 * old and new line numbers in its gutters and the unchanged lines between hunks counted in its
 * separators. The parsed diff keeps its identity while the patch and the fold are unchanged, as
 * the virtualizer renders by identity, and its host fills the scroll root so it has a box before
 * the first anchor pass (the contracts VirtualSource measured).
 */
export default function RepoDiff({ patch, style, folded, wrap, theme, colored, active = null, onUnfold, onLine, noteBlocked = null }: RepoDiffProps) {
  const t = useT();
  const onLineRef = useRef(onLine);
  onLineRef.current = onLine;
  const noting = onLine !== undefined;
  const hostRef = useRef<HTMLDivElement>(null);
  const [lineHeight, setLineHeight] = useState<number | null>(null);
  const fileRef = useRef<VirtualizedFileDiff<undefined> | null>(null);
  const containerRef = useRef<HTMLElement | null>(null);
  const virtualizerRef = useRef<VirtualizerInstance | undefined>(undefined);
  const activeRef = useRef(active);
  activeRef.current = active;
  const reveal = useRef<{ mark: DiffMark; passes: number } | null>(null);

  useLayoutEffect(() => {
    const host = hostRef.current;
    if (host === null) return;
    const measured = Number.parseFloat(getComputedStyle(host).lineHeight);
    setLineHeight(Number.isFinite(measured) && measured > 0 ? measured : DEFAULT_VIRTUAL_FILE_METRICS.lineHeight);
  }, []);

  const text = useMemo(() => (folded ? trimPatchContext(patch, FOLDED_CONTEXT_LINES) : patch), [patch, folded]);
  const fileDiff = useMemo(() => parseFile(text), [text]);
  // the logical lines the folded rows still hold; a match on another one unfolds the context before it is revealed
  const foldedLines = useMemo(() => folded ? new Set(diffFindLines(text).map((line) => `${line.side}:${line.line}`)) : null, [folded, text]);
  const hiddenByFold = useRef(false);
  hiddenByFold.current = active !== null && foldedLines !== null && !foldedLines.has(`${active.side}:${active.line}`);
  // only a newly active match unfolds: folding again while one is active is the user's choice and stays
  useEffect(() => { if (hiddenByFold.current) onUnfold?.(); }, [active?.side, active?.line, active?.start, active?.end, onUnfold]);
  /**
   * Rings the active match's row (in split, only its side's: the package's selected line spans
   * both columns) and paints its text, when the row is mounted; the highlight is the page's one
   * find highlight. Runs after every render, which may have recycled the rows.
   */
  const paint = useCallback((): void => {
    const mark = activeRef.current;
    const shadow = containerRef.current?.shadowRoot ?? null;
    const row = mark === null || shadow === null ? null : markRow(shadow, mark);
    for (const marked of shadow?.querySelectorAll("[data-find-active]") ?? []) if (marked !== row) marked.removeAttribute("data-find-active");
    row?.setAttribute("data-find-active", "");
    if (typeof CSS === "undefined" || !("highlights" in CSS) || typeof Highlight === "undefined") return;
    const range = row === null || mark === null ? null : textRange(row, mark.start, mark.end);
    if (range === null) CSS.highlights.delete(FIND_HIGHLIGHT);
    else CSS.highlights.set(FIND_HIGHLIGHT, new Highlight(range));
  }, []);

  /** Scrolls the virtualizer's root; false when the scroll was clamped and nothing moved. */
  const scrollTo = useCallback((top: number): boolean => {
    const virtualizer = virtualizerRef.current;
    const root = virtualizer?.getRoot();
    if (virtualizer === undefined || !(root instanceof HTMLElement)) return false;
    const before = root.scrollTop;
    virtualizer.markDOMDirty();
    virtualizer.scrollTo({ top: Math.max(0, top) });
    return root.scrollTop !== before;
  }, []);

  /**
   * One pass of the pending reveal, as VirtualSource's: a mounted row within a pixel of the middle
   * ends it (a row taller than the view, by the match's own lines), one further off is scrolled there, and an unmounted one to the package's estimate of
   * its place on its side. The render a scroll causes runs the next pass; a pass count bounds it.
   */
  const settle = useCallback((): void => {
    const pending = reveal.current;
    const file = fileRef.current;
    const root = virtualizerRef.current?.getRoot();
    const shadow = containerRef.current?.shadowRoot ?? null;
    if (pending === null || file === null || !(root instanceof HTMLElement) || shadow === null) return;
    const row = markRow(shadow, pending.mark);
    // across first: a mounted row's text may lie past the scroller's right edge, also in a diff too short to scroll down
    if (row !== null) revealColumns(row, pending.mark);
    // the file's height arrives with its first rows: until then there is nothing to scroll, and the next render settles
    if (root.scrollHeight <= root.clientHeight + 1) return;
    const view = root.getBoundingClientRect();
    let target: number;
    if (row !== null) {
      const box = row.getBoundingClientRect();
      // a wrapped row taller than the view: its middle may not hold the match, so the match's own lines are centred
      const rect = box.height > view.height ? textRange(row, pending.mark.start, pending.mark.end)?.getBoundingClientRect() ?? box : box;
      const delta = rect.top - view.top - (view.height - rect.height) / 2;
      if (Math.abs(delta) <= 1) { reveal.current = null; return; }
      target = root.scrollTop + delta;
    } else {
      const position = file.getLinePosition(pending.mark.line, pending.mark.side === "old" ? "deletions" : "additions");
      if (position === undefined) { reveal.current = null; return; }
      target = (file.top ?? 0) + position.top - (view.height - position.height) / 2;
    }
    if (pending.passes >= MAX_REVEAL_PASSES) { reveal.current = null; return; }
    pending.passes += 1;
    if (!scrollTo(target)) { reveal.current = null; return; }
    requestAnimationFrame(() => requestAnimationFrame(settle));
  }, [scrollTo]);

  const onPostRender = useCallback<NonNullable<Options["onPostRender"]>>((node, instance, phase) => {
    if (phase === "unmount") { fileRef.current = null; containerRef.current = null; return; }
    // inside a Virtualizer the FileDiff component constructs a VirtualizedFileDiff
    fileRef.current = instance as unknown as VirtualizedFileDiff<undefined>;
    containerRef.current = node;
    if (node.shadowRoot !== null) keepEmptyRows(node.shadowRoot);
    paint();
    // this fires inside the virtualizer's render pass, which ends by fixing its scroll anchor: the reveal waits for it
    queueMicrotask(settle);
  }, [paint, settle]);

  const onVirtualizer = useCallback((instance: VirtualizerInstance | undefined): void => { virtualizerRef.current = instance; }, []);

  // the user's wheel, finger, scrollbar or keys cancel a reveal; the virtualizer's own scroll fixes do not
  useEffect(() => {
    const root = hostRef.current?.querySelector<HTMLElement>(".repo-diff-scroll") ?? null;
    if (root === null) return;
    const onInput = (): void => { reveal.current = null; };
    for (const type of ["wheel", "touchstart", "pointerdown", "keydown"] as const) root.addEventListener(type, onInput, { passive: true });
    return () => { for (const type of ["wheel", "touchstart", "pointerdown", "keydown"] as const) root.removeEventListener(type, onInput); };
  }, [fileDiff]);

  // the active match is brought into view when it changes, and again after a layout, wrap, theme or fold change re-lays the rows
  const { side: activeSide, line: activeLine, start: activeStart, end: activeEnd } = active ?? { side: null, line: null, start: null, end: null };
  useEffect(() => {
    paint();
    const mark = activeRef.current;
    if (mark === null || mark.quiet === true) { reveal.current = null; return; }
    reveal.current = { mark, passes: 0 };
    settle();
  }, [activeSide, activeLine, activeStart, activeEnd, style, wrap, theme, folded, paint, settle]);
  useEffect(() => () => { if (typeof CSS !== "undefined" && "highlights" in CSS) CSS.highlights.delete(FIND_HIGHLIGHT); }, []);
  const selected = useMemo(() => activeSide === null || activeLine === null ? null : { start: activeLine, end: activeLine, side: activeSide === "old" ? "deletions" as const : "additions" as const }, [activeSide, activeLine]);
  const options = useMemo<Options>(() => ({
    disableFileHeader: true,
    diffStyle: style,
    hunkSeparators: "line-info",
    overflow: wrap ? "wrap" : "scroll",
    theme: SOURCE_THEME,
    themeType: theme,
    tokenizeMaxLength: colored ? VIRTUAL_HIGHLIGHT_LINES : 0,
    lineHoverHighlight: "disabled",
    enableLineSelection: false,
    enableGutterUtility: noting,
    // a click that ends a text selection (copying code) picks no line; a selection in the shadow rows reads as collapsed to the page, so its type tells
    onLineClick: noting ? ({ annotationSide, lineNumber }) => { if (getSelection()?.type !== "Range") onLineRef.current?.(annotationSide, lineNumber, false); } : undefined,
    unsafeCSS: DIFF_SHADOW_CSS,
    onPostRender,
  }), [style, wrap, theme, colored, onPostRender, noting]);
  const noteLabel = noteBlocked ?? t("Add a note on this line");
  // the + stands beside the hovered row's number: a pointer's shortcut, so it takes no tab stop (keys pick a line in the viewer)
  const renderGutterUtility = useCallback((hovered: () => { lineNumber: number; side: "deletions" | "additions" } | undefined) => <button type="button" className="repo-diff-line-note-plus" tabIndex={-1}
    aria-label={noteLabel} title={noteLabel} aria-disabled={noteBlocked !== null}
    onClick={() => { const row = hovered(); if (row !== undefined) onLineRef.current?.(row.side, row.lineNumber, noteBlocked === null); }}>
    <Plus aria-hidden="true" />
  </button>, [noteLabel, noteBlocked]);
  const metrics = useMemo(() => (lineHeight === null ? null : { ...DEFAULT_VIRTUAL_FILE_METRICS, lineHeight }), [lineHeight]);

  if (fileDiff === null || fileDiff.hunks.length === 0) return <p className="repo-diff-note">{t("No lines changed.")}</p>;
  // plain rows go through the pool too, though they never reach a worker (tokenizeMaxLength 0 keeps
  // the diff massive, so no highlight is queued): without one the package builds rows for every line
  // of the diff on the page, again on each render (each scroll), where the pool's manager builds
  // only the window's rows. The 10 000-line diff held the page 130-270 ms per scroll step that way
  // at a 4x CPU slowdown.
  return <div ref={hostRef} className="repo-diff" data-style={style} data-colored={colored ? "" : undefined} data-folded={folded ? "" : undefined}>
    <DiffWorkerPool>
      <Virtualizer className="repo-diff-scroll" contentClassName="repo-diff-column" config={SCROLL_CONFIG}>
        <VirtualizerProbe onInstance={onVirtualizer} />
        {metrics !== null && <FileDiff className="repo-diff-file" fileDiff={fileDiff} options={options} metrics={metrics} selectedLines={selected} renderGutterUtility={noting ? renderGutterUtility : undefined} />}
      </Virtualizer>
    </DiffWorkerPool>
  </div>;
}
