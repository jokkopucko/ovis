import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { DEFAULT_VIRTUAL_FILE_METRICS, type FileContents, type VirtualizedFile, type Virtualizer as VirtualizerInstance } from "@pierre/diffs";
import { File, useVirtualizer, Virtualizer, type FileOptions } from "@pierre/diffs/react";

import { DiffWorkerPool } from "./DiffWorkerPool.tsx";
import { VIRTUAL_HIGHLIGHT_LINES } from "../lib/sourcePreview.ts";
import { contentKey, keepEmptyRows, SCROLL_CONFIG, SHADOW_CSS, SOURCE_THEME } from "../lib/sourceTheme.ts";
import { useSettings } from "../lib/settings.ts";
import "./VirtualSource.css";

export interface VirtualSourceProps {
  /** the file's name or path: the virtualizer infers the language from it */
  name: string;
  text: string;
  colored: boolean;
  wrap: boolean;
  theme: "dark" | "light";
  markedLine: number | null;
}

type FileOptionsOf = FileOptions<undefined, undefined>;
type Align = "center" | "start";
interface Reveal { line: number; align: Align; passes: number }

// a reveal re-reads the line's position after each render it causes: wrapped rows are estimated
// until they mount, so the first scroll can land short, and the virtualizer's own anchor fix after
// a re-measure can move an aligned row again. Six passes settle every measured case with room.
const MAX_REVEAL_PASSES = 6;

function VirtualizerProbe({ onInstance }: { onInstance: (instance: VirtualizerInstance | undefined) => void }) {
  const instance = useVirtualizer();
  useLayoutEffect(() => { onInstance(instance); }, [instance, onInstance]);
  return null;
}

/**
 * The file object keeps its identity while name and contents are unchanged, as the virtualizer
 * renders by identity; its host fills the scroll root, so it has a box before the first anchor
 * pass; a requested line is revealed against its mounted row, since positions past the measured
 * rows are estimates; and a wrap toggle or a width change, which re-measure the rows, keeps the
 * marked line in view when it was, else the top line in place.
 */
export default function VirtualSource({ name, text, colored, wrap, theme, markedLine }: VirtualSourceProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<VirtualizedFile | null>(null);
  const containerRef = useRef<HTMLElement | null>(null);
  const virtualizerRef = useRef<VirtualizerInstance | undefined>(undefined);
  const reveal = useRef<Reveal | null>(null);
  const readerInputs = useRef(0);
  const anchor = useRef<{ width: number | null; top: number | null; markedInView: boolean }>({ width: null, top: null, markedInView: false });
  const markedRef = useRef(markedLine);
  markedRef.current = markedLine;
  // the row estimate is the host's line-height, measured when the file mounts and again when Settings → File text size
  // changes it: the metrics are read when the file mounts, so a new height mounts the file again (keyed on it below)
  const { fileFontSize, chatFontSize, uiFontSize, density } = useSettings().settings;
  const [lineHeight, setLineHeight] = useState<number | null>(null);
  const lineHeightRef = useRef<number | null>(null);
  const measureLine = useCallback((): number | null => {
    const host = hostRef.current;
    if (host === null) return null;
    const measured = Number.parseFloat(getComputedStyle(host).lineHeight);
    return Number.isFinite(measured) && measured > 0 ? measured : DEFAULT_VIRTUAL_FILE_METRICS.lineHeight;
  }, []);

  useLayoutEffect(() => {
    lineHeightRef.current = measureLine();
    setLineHeight(lineHeightRef.current);
  }, [measureLine]);

  const scrollRoot = useCallback((): HTMLElement | null => {
    const root = virtualizerRef.current?.getRoot();
    return root instanceof HTMLElement ? root : null;
  }, []);

  const scrollTo = useCallback((top: number): boolean => {
    const virtualizer = virtualizerRef.current;
    const root = virtualizer?.getRoot();
    if (virtualizer === undefined || !(root instanceof HTMLElement)) return false;
    const before = root.scrollTop;
    // the virtualizer clamps a scroll to the height it last measured, which at a mount is the empty host's
    virtualizer.markDOMDirty();
    virtualizer.scrollTo({ top: Math.max(0, top) });
    return root.scrollTop !== before;
  }, []);

  const markedRow = useCallback((): HTMLElement | null => {
    const marked = markedRef.current;
    return marked === null ? null : containerRef.current?.shadowRoot?.querySelector<HTMLElement>(`[data-line="${marked}"]`) ?? null;
  }, []);

  /**
   * A width change re-measures the rows, and the virtualizer renders and scrolls for it before our
   * observer sees it: a reading at another width than the anchor's is the layout after the change,
   * so the anchor from before it stands until re-anchored.
   */
  const readAnchor = useCallback((): void => {
    const file = fileRef.current;
    const root = scrollRoot();
    if (file === null || root === null) return;
    const width = root.clientWidth;
    if (anchor.current.width !== null && anchor.current.width !== width) return;
    const view = root.getBoundingClientRect();
    const rect = markedRow()?.getBoundingClientRect();
    anchor.current = {
      width,
      top: file.getNumericScrollAnchor(root.scrollTop - (file.top ?? 0))?.lineNumber ?? anchor.current.top,
      markedInView: rect !== undefined && rect.bottom > view.top && rect.top < view.bottom,
    };
  }, [scrollRoot, markedRow]);

  const anchoredReveal = useCallback((): Reveal | null => {
    const { top, markedInView } = anchor.current;
    const marked = markedRef.current;
    if (marked !== null && markedInView) return { line: marked, align: "center", passes: 0 };
    return top === null ? null : { line: top, align: "start", passes: 0 };
  }, []);

  /**
   * The render a scroll causes settles the next pass, which also catches the virtualizer moving the
   * row again as it re-measures; a scroll that changes nothing renders nothing, so a frame later
   * looks once more.
   */
  const settle = useCallback((): void => {
    const pending = reveal.current;
    const file = fileRef.current;
    const root = scrollRoot();
    const shadow = containerRef.current?.shadowRoot ?? null;
    if (pending === null || file === null || root === null || shadow === null) return;
    // the file's height arrives with its first rows: until then there is nothing to scroll, and the next render settles
    if (root.scrollHeight <= root.clientHeight + 1) return;
    const view = root.getBoundingClientRect();
    const row = shadow.querySelector<HTMLElement>(`[data-line="${pending.line}"]`);
    let target: number;
    if (row !== null) {
      const rect = row.getBoundingClientRect();
      const offset = pending.align === "center" ? (view.height - rect.height) / 2 : 0;
      const delta = rect.top - view.top - offset;
      if (Math.abs(delta) <= 1) { reveal.current = null; return; }
      target = root.scrollTop + delta;
    } else {
      const position = file.getLinePosition(pending.line);
      if (position === undefined) { reveal.current = null; return; }
      const offset = pending.align === "center" ? (view.height - position.height) / 2 : 0;
      target = (file.top ?? 0) + position.top - offset;
      // already there with the row still unmounted: the virtualizer has not yet drawn the window
      // for the last scroll (wrapped rows re-measuring after a remount take a few frames), and the
      // render that draws it settles the next pass; ending here would leave the line off screen
      if (Math.abs(root.scrollTop - Math.max(0, target)) <= 1) return;
    }
    if (pending.passes >= MAX_REVEAL_PASSES) { reveal.current = null; return; }
    pending.passes += 1;
    if (!scrollTo(target)) { reveal.current = null; return; }
    requestAnimationFrame(() => requestAnimationFrame(settle));
  }, [scrollRoot, scrollTo]);

  const onPostRender = useCallback<NonNullable<FileOptionsOf["onPostRender"]>>((node, instance, phase) => {
    if (phase === "unmount") { fileRef.current = null; containerRef.current = null; return; }
    // inside a Virtualizer the File component constructs a VirtualizedFile
    fileRef.current = instance as unknown as VirtualizedFile;
    containerRef.current = node;
    if (node.shadowRoot !== null) keepEmptyRows(node.shadowRoot);
    // this fires inside the virtualizer's render pass, which ends by fixing its scroll anchor: a
    // scroll made here would be undone, and the layout read here is not yet the one shown (a
    // marked line in the middle of the view can read as off it), so both wait for the pass to finish
    queueMicrotask(() => { readAnchor(); settle(); });
  }, [readAnchor, settle]);

  const onVirtualizer = useCallback((instance: VirtualizerInstance | undefined): void => { virtualizerRef.current = instance; }, []);

  // the user's wheel, finger, scrollbar or keys cancel a reveal (the virtualizer's own scroll fixes
  // must not: they come as scroll events too); every scroll moves the anchor on
  useEffect(() => {
    const root = hostRef.current?.querySelector<HTMLElement>(".virtual-source-scroll") ?? null;
    if (root === null) return;
    const onScroll = (): void => { readAnchor(); };
    const onInput = (): void => { reveal.current = null; readerInputs.current += 1; };
    root.addEventListener("scroll", onScroll, { passive: true });
    for (const type of ["wheel", "touchstart", "pointerdown", "keydown"] as const) root.addEventListener(type, onInput, { passive: true });
    const observer = new ResizeObserver(() => {
      const width = root.clientWidth;
      if (anchor.current.width === null || anchor.current.width === width) return;
      const anchored = anchoredReveal();
      anchor.current = { ...anchor.current, width };
      if (anchored !== null) { reveal.current = anchored; requestAnimationFrame(settle); }
    });
    observer.observe(root);
    return () => {
      root.removeEventListener("scroll", onScroll);
      for (const type of ["wheel", "touchstart", "pointerdown", "keydown"] as const) root.removeEventListener(type, onInput);
      observer.disconnect();
    };
  }, [settle, readAnchor, anchoredReveal]);

  // SettingsProvider writes a new --file-source-scale in a passive effect, after this component's: the height is read
  // a frame later, and the file mounted again at it reveals the line the view showed, as a wrap toggle does. The line
  // is taken now, before the new scale resizes the old rows (a smaller size clamps the scroll to their new end), unless
  // the reader scrolls before the frame: then the line their scroll left at the top
  const sizedOnce = useRef(false);
  useEffect(() => {
    if (!sizedOnce.current) { sizedOnce.current = true; return; }
    const anchored = anchoredReveal();
    const inputs = readerInputs.current;
    const frame = requestAnimationFrame(() => {
      const next = measureLine();
      if (next === null || next === lineHeightRef.current) return;
      reveal.current = readerInputs.current === inputs ? anchored : anchoredReveal();
      lineHeightRef.current = next;
      setLineHeight(next);
    });
    return () => cancelAnimationFrame(frame);
  }, [fileFontSize, chatFontSize, uiFontSize, density, measureLine, anchoredReveal]);

  const lastWrap = useRef(wrap);
  if (lastWrap.current !== wrap) {
    lastWrap.current = wrap;
    reveal.current = anchoredReveal();
  }

  useEffect(() => {
    if (markedLine === null) return;
    reveal.current = { line: markedLine, align: "center", passes: 0 };
    settle();
  }, [markedLine, name, text, settle]);

  const file = useMemo<FileContents>(() => colored
    ? { name, contents: text, cacheKey: contentKey(name, text) }
    : { name, contents: text, lang: "text" }, [name, text, colored]);
  const options = useMemo<FileOptionsOf>(() => ({
    disableFileHeader: true,
    overflow: wrap ? "wrap" : "scroll",
    theme: SOURCE_THEME,
    themeType: theme,
    // plain rows never queue a highlight: the virtualizer treats a file past this as massive
    tokenizeMaxLength: colored ? VIRTUAL_HIGHLIGHT_LINES : 0,
    lineHoverHighlight: "disabled",
    enableLineSelection: false,
    unsafeCSS: SHADOW_CSS,
    onPostRender,
  }), [wrap, theme, colored, onPostRender]);
  const selected = useMemo(() => markedLine === null ? null : { start: markedLine, end: markedLine }, [markedLine]);
  const metrics = useMemo(() => lineHeight === null ? null : { ...DEFAULT_VIRTUAL_FILE_METRICS, lineHeight }, [lineHeight]);

  // plain rows go through the pool too, though they never reach a worker: without one the package
  // draws a plain file by building rows for every line on the page, again on each render (each
  // scroll), where the pool's manager builds only the window's rows. 123 500 lines took 0.5-0.7 s
  // per render at a 5x CPU slowdown that way, past a second on a CI runner.
  return <div ref={hostRef} className="virtual-source" data-colored={colored ? "" : undefined}>
    <DiffWorkerPool>
      <Virtualizer className="virtual-source-scroll" contentClassName="virtual-source-column" config={SCROLL_CONFIG}>
        <VirtualizerProbe onInstance={onVirtualizer} />
        {metrics !== null && <File key={metrics.lineHeight} className="virtual-source-file" file={file} options={options} metrics={metrics} selectedLines={selected} />}
      </Virtualizer>
    </DiffWorkerPool>
  </div>;
}
