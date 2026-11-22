import { useEffect, useRef, useState } from "react";
import { ArrowDown } from "lucide-react";
import type { Terminal } from "@xterm/xterm";
import type { PaneFindResponse, PaneScrollInfo } from "../../shared/protocol.ts";
import { useMachineApi } from "../lib/machineContext.tsx";
import type { ViewportIntentGate } from "../lib/viewportIntent.ts";
import { ApiError } from "../lib/api.ts";
import { useT } from "../lib/i18n.ts";
import { PAGE_OVERLAP_ROWS, pageScrollDistance } from "../lib/pageScroll.ts";
import { SCROLL_POLL_BUSY_MS, SCROLL_POLL_SETTLE_MS, scrollPollDelay, validScroll, visibleFindRects, type FindCellRect } from "../lib/terminalViewport.ts";
import { VIEW_MOVED_EVENT } from "../lib/ghostty/viewMoved.ts";
import "./TerminalViewportTools.css";

export interface TerminalSearchState { query: string; result: PaneFindResponse }
interface Box { left: number; top: number; width: number; height: number; cols: number; rows: number; anchorX: number; anchorY: number }
interface Props {
  viewportIntent: ViewportIntentGate;
  terminal: Terminal | null;
  paneId: string;
  pageScroll?: { current: ((direction: -1 | 1) => void) | null };
  lineScroll?: { current: ((lines: number) => void) | null };
  onApplicationPage?: (direction: -1 | 1) => void;
  enabled: boolean;
  interactive: boolean;
  search: TerminalSearchState | null;
  onError(message: string): void;
}

/** UI over the attach stream. History belongs to herdr; xterm still has zero scrollback. */
const HELD_PAGE_MS = 1000;
const HELD_PAGE_RETURN_MS = 3 * HELD_PAGE_MS;

export function TerminalViewportTools({ viewportIntent, terminal, paneId, pageScroll, lineScroll, onApplicationPage, enabled, interactive, search, onError }: Props) {
  const t = useT();
  const api = useMachineApi();
  const layer = useRef<HTMLDivElement>(null);
  const [scroll, setScroll] = useState<PaneScrollInfo | null>(null);
  // read up in the history xterm keeps itself (a herdr-core server's `terminal-history`): herdr's metrics never see it
  const [localBack, setLocalBack] = useState(false);
  const scrollRef = useRef(scroll); scrollRef.current = scroll;
  const [box, setBox] = useState<Box | null>(null);
  const [hits, setHits] = useState<FindCellRect[]>([]);
  const previewRef = useRef<number | null>(null);
  const searchRef = useRef(search); searchRef.current = search;
  const errorRef = useRef(onError); errorRef.current = onError;
  const refreshRef = useRef<() => void>(() => {});
  const writeRef = useRef<(offset: number) => void>(() => {});
  // Old bridges ignore unknown request fields and would scroll on an automatic search.
  // Only a new explicit result advertises the no-jump range response contract.
  const query = interactive && search && Array.isArray(search.result.matches) && search.result.scroll !== undefined ? search.query : "";

  useEffect(() => {
    if (!terminal || !enabled) { setScroll(null); setLocalBack(false); setHits([]); previewRef.current = null; if (pageScroll) pageScroll.current = null; if (lineScroll) lineScroll.current = null; return; }
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let timerDue = 0;
    let pending = false;
    let writing = false;
    let desired: number | null = null;
    let dirty = false;
    let urgent = false;
    let idle = 0;
    let version = 0;
    let outputVersion = 0;
    // the output the current metrics were read after: a program leaving its alternate screen hands the
    // history back, and until the next read says so its zero-history metrics must not turn a page into
    // keys for the shell. A page asked for meanwhile waits for that read, briefly.
    let metricsOutput = -1;
    let metricsAt = 0;
    let outputAt = -Infinity, burstFrom = -Infinity;
    let gestureUntil = 0;
    let heldPage: { steps: number; at: number; strict: boolean } | null = null;
    let heldLines: { lines: number; at: number } | null = null;
    let data: PaneFindResponse | null = null;
    let lastKey = "";
    const showing = () => document.visibilityState !== "hidden" && !!terminal.element?.getClientRects().length
      && getComputedStyle(terminal.element).visibility !== "hidden";
    const clearHits = () => { data = null; lastKey = ""; setHits((old) => old.length ? [] : old); };
    const screen = terminal.element?.querySelector<HTMLElement>(".xterm-screen") ?? null;
    const mount = terminal.element?.parentElement;
    const paintBox = () => {
      if (!alive || !showing()) return;
      const parent = layer.current?.parentElement;
      if (!screen || !parent) return;
      const rect = screen.getBoundingClientRect(), outer = parent.getBoundingClientRect();
      const view = mount?.getBoundingClientRect();
      const right = Math.min(rect.right, outer.right, mount && view ? view.left + mount.clientLeft + mount.clientWidth : Infinity);
      const bottom = Math.min(rect.bottom, outer.bottom, mount && view ? view.top + mount.clientTop + mount.clientHeight : Infinity);
      const next = { left: rect.left - outer.left, top: rect.top - outer.top, width: rect.width, height: rect.height, cols: terminal.cols, rows: terminal.rows,
        anchorX: right - outer.left, anchorY: bottom - outer.top };
      setBox((old) => old && Object.keys(next).every((key) => old[key as keyof Box] === next[key as keyof Box]) ? old : next);
    };
    const paintHits = () => {
      if (!alive) return;
      const active = searchRef.current;
      if (!active || !data) {
        if (lastKey !== "[]") { lastKey = "[]"; setHits((old) => old.length ? [] : old); }
        return;
      }
      if (!showing()) return;
      const matches = data?.matches ?? [];
      const nativeScroll = data?.scroll;
      const rectangles = active && data && validScroll(nativeScroll) ? visibleFindRects(matches, nativeScroll, active.query, terminal.cols, terminal.rows,
        (row, col) => {
          const cell = terminal.buffer.active.getLine(terminal.buffer.active.viewportY + row)?.getCell(col);
          return cell ? { chars: cell.getChars(), width: cell.getWidth() } : undefined;
        }, active.result.match) : [];
      const key = JSON.stringify(rectangles);
      if (key !== lastKey) { lastKey = key; setHits((old) => old.length === 0 && rectangles.length === 0 ? old : rectangles); }
    };
    const paint = () => { paintBox(); paintHits(); };
    const schedule = (delay = 250) => {
      if (!alive || document.visibilityState === "hidden") return;
      const due = Date.now() + delay;
      if (timer !== null && timerDue <= due) return;
      if (timer !== null) clearTimeout(timer);
      timerDue = due;
      timer = setTimeout(() => { timer = null; void read(); }, delay);
    };
    const read = async () => {
      if (!alive) return;
      if (pending || writing) { dirty = true; return; }
      if (!showing()) { idle = 0; schedule(1000); return; }
      pending = true; dirty = false; urgent = false;
      const startedAt = Date.now();
      const revision = version;
      const output = outputVersion;
      const cols = terminal.cols, rows = terminal.rows;
      let readMetrics: PaneScrollInfo | null = null;
      try {
        let found: PaneFindResponse | null = null;
        if (query) {
          try { found = await api.findPane({ pane_id: paneId, query, direction: "forward", jump: false }); }
          catch { /* Moving output can invalidate search while its scroll metrics remain useful. */ }
        }
        const metrics = found?.scroll ?? await api.fetchPaneScroll(paneId);
        if (!alive || revision !== version || cols !== terminal.cols || rows !== terminal.rows) return;
        readMetrics = metrics;
        setScroll((old) => validScroll(metrics) ? old && old.offset_from_bottom === metrics.offset_from_bottom && old.max_offset_from_bottom === metrics.max_offset_from_bottom && old.viewport_rows === metrics.viewport_rows ? old : metrics : null);
        if (validScroll(metrics)) {
          const last = scrollRef.current;
          if (last && (last.offset_from_bottom !== metrics.offset_from_bottom || last.max_offset_from_bottom !== metrics.max_offset_from_bottom)) idle = 0;
          scrollRef.current = metrics; metricsOutput = output; metricsAt = startedAt;
        }
        data = output === outputVersion ? found : null;
        // also the box: a pane shown again by its visibility style, not its size, gets no ResizeObserver call
        paint();
        if (heldPage && validScroll(metrics) && (output === outputVersion || (!heldPage.strict && heldPage.at <= startedAt))) {
          const held = heldPage;
          heldPage = null;
          if (startedAt - held.at < HELD_PAGE_MS && Date.now() - held.at < HELD_PAGE_RETURN_MS) {
            for (let step = 0; step < Math.abs(held.steps); step++) scrollPage(held.steps > 0 ? 1 : -1, true);
          }
        }
        if (heldLines && validScroll(metrics) && (output === outputVersion || heldLines.at <= startedAt)) {
          const held = heldLines; heldLines = null;
          if (startedAt - held.at < HELD_PAGE_MS) scrollLines(held.lines, true);
        }
      } catch {
        if (alive && revision === version) { clearHits(); if (!query) setScroll(null); idle = 0; }
      } finally {
        pending = false;
        if (alive) schedule(scrollPollDelay(dirty || !!heldPage || !!heldLines, idle++, readMetrics, following()));
      }
    };
    const following = () => {
      const now = Date.now();
      return !urgent && !query && !heldPage && !heldLines && now >= gestureUntil && now - burstFrom >= SCROLL_POLL_SETTLE_MS;
    };
    const holdPage = (direction: -1 | 1, strict: boolean) => {
      const now = Date.now();
      const live = heldPage && now - heldPage.at < HELD_PAGE_MS ? heldPage : null;
      heldPage = { steps: (live?.steps ?? 0) + direction, at: now, strict: strict || !!live?.strict };
      dirty = true; idle = 0; schedule(0);
    };
    const wake = () => { dirty = true; urgent = true; idle = 0; schedule(); };
    const flush = async () => {
      if (writing || desired === null || !alive || viewportIntent.isSearching()) return;
      writing = true;
      const target = desired; desired = null;
      version++;
      clearHits();
      try {
        const output = outputVersion;
        const startedAt = Date.now();
        const request = viewportIntent.scroll(() => api.scrollPane(paneId, target));
        if (!request) return;
        const metrics = await request;
        if (alive && validScroll(metrics)) { scrollRef.current = metrics; metricsOutput = output; metricsAt = startedAt; setScroll(metrics); }
      } catch (cause) {
        if (alive) {
          desired = null;
          errorRef.current(t("Scroll failed: {reason}", { reason: cause instanceof ApiError ? cause.detail : cause instanceof Error ? cause.message : String(cause) }));
        }
      } finally {
        writing = false;
        if (alive) {
          if (desired !== null) void flush();
          else { previewRef.current = null; wake(); }
        }
      }
    };
    writeRef.current = (offset) => {
      const metrics = scrollRef.current;
      if (!interactive || !alive || viewportIntent.isSearching() || !validScroll(metrics) || !showing()) return;
      desired = Math.max(0, Math.min(metrics.max_offset_from_bottom, Math.round(offset)));
      // herdr paints the moved view as output: libghostty's layer tells it apart from new lines (ghostty/overlay.ts)
      terminal.element?.dispatchEvent(new Event(VIEW_MOVED_EVENT, { bubbles: true }));
      previewRef.current = desired;
      void flush();
    };
    const scrollPage = (direction: -1 | 1, fresh = false) => {
      const metrics = scrollRef.current;
      if (!interactive || !alive || viewportIntent.isSearching() || !showing()) return;
      if (validScroll(metrics) && metrics.max_offset_from_bottom === 0) {
        // keys for the program only on metrics read after its latest output: it may just have left
        // its alternate screen, and the shell behind it has history to scroll instead
        if (metricsOutput !== outputVersion) { holdPage(direction, true); return; }
        onApplicationPage?.(direction);
        return;
      }
      // metrics that output has overtaken and that are older than the busy cadence (the follow pace reads
      // them up to 2 s apart): the program may have entered its alternate screen since, so read before
      // choosing herdr's scroll over the program's page keys
      if (!fresh && validScroll(metrics) && metricsOutput !== outputVersion && Date.now() - metricsAt > SCROLL_POLL_BUSY_MS) {
        holdPage(direction, false); return;
      }
      if (validScroll(metrics)) writeRef.current((previewRef.current ?? metrics.offset_from_bottom) - direction * pageScrollDistance(metrics.viewport_rows, 1, PAGE_OVERLAP_ROWS));
      else { dirty = true; idle = 0; schedule(0); }
    };
    if (pageScroll) pageScroll.current = scrollPage;
    const scrollLines = (lines: number, fresh = false) => {
      if (!interactive || !alive || viewportIntent.isSearching() || !showing()) return;
      const metrics = scrollRef.current;
      const stale = !fresh && metricsOutput !== outputVersion && Date.now() - metricsAt > SCROLL_POLL_BUSY_MS;
      if (validScroll(metrics) && !stale) {
        // lines held on stale metrics go out with a line these metrics are fresh enough for: the read that would release
        // them waits while the wheel's own writes run back to back, past the hold. The hold stays, empty, so the poll and
        // that read (and its write) come as they would have: page keys keep their timing. They wait for that read as
        // before behind a held page, which it hands out first; past the top these metrics know (the history may have
        // grown since); against this line's direction; and behind a write still out, whose failure drops what is queued
        // after it. At the bottom they stop, as the wheel would have.
        const from = previewRef.current ?? metrics.offset_from_bottom;
        const top = metrics.max_offset_from_bottom;
        let held = 0;
        if (heldLines && !heldPage && !writing && heldLines.lines * lines >= 0 && Date.now() - heldLines.at < HELD_PAGE_MS
          && from + heldLines.lines <= top && from + heldLines.lines + lines <= top) {
          held = heldLines.lines;
          heldLines = { lines: 0, at: heldLines.at };
        }
        writeRef.current((held ? Math.max(0, from + held) : from) + lines);
      } else {
        heldLines = { lines: (heldLines && Date.now() - heldLines.at < HELD_PAGE_MS ? heldLines.lines : 0) + lines, at: Date.now() };
        dirty = true; idle = 0; schedule(0);
      }
    };
    if (lineScroll) lineScroll.current = scrollLines;
    const unregisterCancellation = viewportIntent.registerScrollCancellation(() => {
      desired = null; heldLines = null; heldPage = null; version++;
      previewRef.current = null;
      clearHits();
    });
    refreshRef.current = () => { dirty = true; urgent = true; idle = 0; paint(); schedule(0); };
    const parsed = terminal.onWriteParsed(() => {
      outputVersion++; clearHits(); dirty = true; idle = 0;
      const now = Date.now();
      if (now - outputAt > SCROLL_POLL_SETTLE_MS) burstFrom = now;
      outputAt = now;
      schedule(scrollPollDelay(true, 0, scrollRef.current, following()));
    });
    // xterm's own scrollback is 0 on a herdr server, so its view sits below history only on a herdr-core one
    const readLocal = () => {
      const buffer = terminal.buffer.active;
      setLocalBack(buffer.viewportY < buffer.baseY);
    };
    const scrolled = terminal.onScroll(readLocal);
    const rendered = terminal.onRender(() => { readLocal(); paintHits(); });
    // a wheel or swipe that xterm sends to herdr as mouse reports comes back only as output, from a view
    // that left the bottom: read at the busy cadence, not the follow pace
    const gesture = () => { gestureUntil = Date.now() + SCROLL_POLL_SETTLE_MS; wake(); };
    terminal.element?.addEventListener("wheel", gesture, { passive: true, capture: true });
    terminal.element?.addEventListener("touchmove", gesture, { passive: true, capture: true });
    const resized = terminal.onResize(() => { version++; clearHits(); setScroll(null); wake(); paint(); });
    const visibility = () => {
      if (document.visibilityState === "hidden") { if (timer !== null) clearTimeout(timer); timer = null; clearHits(); }
      else wake();
    };
    const observer = new ResizeObserver(() => { paint(); wake(); });
    if (layer.current?.parentElement) observer.observe(layer.current.parentElement);
    if (screen) observer.observe(screen);
    mount?.addEventListener("scroll", paint, { passive: true });
    document.addEventListener("visibilitychange", visibility);
    paint(); readLocal(); void read();
    return () => {
      alive = false; desired = null; version++; heldPage = null;
      if (pageScroll?.current === scrollPage) pageScroll.current = null;
      if (lineScroll?.current === scrollLines) lineScroll.current = null;
      previewRef.current = null;
      unregisterCancellation();
      if (timer !== null) clearTimeout(timer);
      parsed.dispose(); scrolled.dispose(); rendered.dispose(); resized.dispose(); observer.disconnect();
      mount?.removeEventListener("scroll", paint);
      terminal.element?.removeEventListener("wheel", gesture, { capture: true });
      terminal.element?.removeEventListener("touchmove", gesture, { capture: true });
      document.removeEventListener("visibilitychange", visibility);
      refreshRef.current = () => {}; writeRef.current = () => {};
    };
  }, [terminal, paneId, enabled, interactive, query, api, t, viewportIntent, pageScroll, lineScroll, onApplicationPage]);

  useEffect(() => { refreshRef.current(); }, [search?.result]);
  return <div ref={layer} className="terminal-viewport-tools" aria-hidden={!enabled || undefined}>
    {enabled && search && box && hits.map((hit, index) => <span key={index} className={`terminal-find-hit${hit.current ? " is-current" : ""}`} aria-hidden="true"
      style={{ left: box.left + hit.col * box.width / box.cols, top: box.top + hit.row * box.height / box.rows, width: hit.width * box.width / box.cols, height: box.height / box.rows }} />)}
    {enabled && interactive && box && (localBack || (validScroll(scroll) && scroll.offset_from_bottom > 0)) && <button type="button" className="btn terminal-jump-bottom"
      aria-label={t("Jump to bottom")} title={t("Jump to bottom")} style={{ left: box.anchorX, top: box.anchorY }}
      onPointerDown={(event) => event.preventDefault()} onClick={() => {
        // the browser's own history scrolls here; herdr's viewport (shared with its other clients) only when it is scrolled
        if (localBack) terminal?.scrollToBottom();
        if (validScroll(scroll) && scroll.offset_from_bottom > 0) writeRef.current(0);
      }}><ArrowDown aria-hidden="true" /></button>}
  </div>;
}
