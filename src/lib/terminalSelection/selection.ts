/**
 * Copyright (c) 2017 The xterm.js authors. All rights reserved.
 * @license MIT
 * Adapted for Ovis.
 */

import { selectionText, wordAt, wrappedRange } from "../ghostty/selection.ts";
import { advance, SelectionModel } from "./model.ts";
import { before, clamp, equal, linkContains, mouseGrid, signal } from "./mouse.ts";
import type { DrawnSelection, Point, Selection, SelectionHost } from "./types.ts";

const SCROLL_INTERVAL = 50;
const SCROLL_THRESHOLD = 50;
const SCROLL_SPEED = 15;

export function createSelection(host: SelectionHost): Selection {
  const page = host.screen.ownerDocument;
  const view = page.defaultView;
  const platform = view?.navigator.platform ?? "";
  const model = new SelectionModel(host);
  const changes = signal<void>(), redraws = signal<void>(), linuxSelection = signal<string>();
  let enabled = true, disposed = false;
  let timer: number | undefined;
  let edge = 0;
  let published: DrawnSelection | null = null;
  let alternate = host.screenRows().alternate;
  let height = host.rows();

  const active = (): DrawnSelection | null => {
    const range = model.range();
    return range && !equal(range.start, range.end) ? range : null;
  };
  const getSelection = (): string => {
    const range = model.range();
    return range ? selectionText(host.screenRows(), range.start, range.end, range.column, /Win/.test(platform) ? "\r\n" : "\n") : "";
  };
  const publish = (): void => {
    published = active();
    changes.emit();
  };
  const redraw = (mouse = false): void => {
    redraws.emit();
    if (mouse && /Linux/.test(platform)) {
      const text = getSelection();
      if (text) linuxSelection.emit(text);
    }
  };
  const stopDrag = (): void => {
    page.removeEventListener("mousemove", move);
    page.removeEventListener("mouseup", up);
    view?.removeEventListener("blur", stopDrag);
    if (timer !== undefined) view?.clearInterval(timer);
    timer = undefined;
    edge = 0;
  };
  const clearSelection = (): void => {
    model.start(undefined, "normal");
    stopDrag();
    redraw();
    publish();
  };
  const wideBoundary = ([x, y]: Point): Point =>
    x < host.cols() && host.screenRows().getLine(y)?.getCell(x)?.getWidth() === 0 ? [x + 1, y] : [x, y];
  const word = (point: Point): { start: Point; length: number } | undefined => {
    const cols = host.cols();
    const found = wordAt(host.screenRows(), cols, host.wordSeparator(), point, true);
    if (!found) return undefined;
    const rowsUp = Math.min(0, Math.floor(found.start / cols));
    return { start: [found.start - rowsUp * cols, point[1] + rowsUp], length: found.length };
  };

  function down(event: MouseEvent): void {
    if (event.button !== 0 || event.defaultPrevented) return;
    const normallySelects = enabled && !host.mouseReporting();
    const forced = host.isMac ? event.altKey && host.macOptionClickForcesSelection : event.shiftKey;
    if (!normallySelects && !forced) return;
    if (!normallySelects) event.stopImmediatePropagation();
    event.preventDefault();
    const hit = mouseGrid(host, event);
    if (!hit) return;
    stopDrag();
    if (normallySelects && event.shiftKey) {
      if (model.anchor) model.end = hit.boundary;
    } else if (event.detail <= 1) {
      const column = event.altKey && (!host.isMac || event.metaKey);
      model.start(wideBoundary(hit.boundary), column ? "column" : "normal");
    } else if (event.detail === 2) {
      const link = host.focusedLink?.();
      if (link && hit.cell && linkContains(link, hit.cell)) {
        const { start, end } = link.range;
        model.start([start.x - 1, start.y - 1], "word", (end.y - start.y) * hit.cols + end.x - start.x + 1);
      } else {
        const found = word(hit.boundary);
        if (found) model.start(found.start, "word", found.length);
      }
    } else if (event.detail === 3) {
      const { first, last } = wrappedRange(host.screenRows(), hit.boundary[1]);
      model.start([0, first], "line", host.cols() * (last - first + 1));
    }
    page.addEventListener("mousemove", move);
    page.addEventListener("mouseup", up);
    view?.addEventListener("blur", stopDrag);
    timer = view?.setInterval(scroll, SCROLL_INTERVAL);
    redraw(true);
  }

  function move(event: MouseEvent): void {
    event.stopImmediatePropagation();
    const anchor = model.anchor;
    const hit = mouseGrid(host, event);
    if (!anchor || !hit) return;
    const cols = host.cols();
    const point = hit.boundary;
    let end = point;
    if (model.mode === "line") {
      end = [point[1] < anchor[1] ? 0 : cols, point[1]];
    } else if (model.mode === "word") {
      const found = word(point);
      if (found) end = before(point, anchor) ? found.start : advance(found.start, found.length, cols);
    }
    edge = hit.edge;
    if (edge !== 0 && model.mode !== "column") end = [edge < 0 ? 0 : cols, end[1]];
    const previous = model.end;
    model.end = wideBoundary(end);
    // Redraw is also the renderer's drag-step signal, even within the same cell.
    redraw(!previous || !equal(previous, model.end));
  }

  function scroll(): void {
    if (edge === 0 || !model.anchor || !model.end) return;
    const { baseY, viewportY } = host.screenRows();
    if (edge < 0 ? viewportY <= 0 : viewportY >= baseY) return;
    const speed = clamp(edge, -SCROLL_THRESHOLD, SCROLL_THRESHOLD) / SCROLL_THRESHOLD;
    host.scrollLines(Math.sign(speed) + Math.round(speed * (SCROLL_SPEED - 1)));
    const rows = host.screenRows();
    const end = model.end;
    if (!end) return; // A synchronous host refresh may have cleared it.
    model.end = [
      model.mode === "column" ? end[0] : edge < 0 ? 0 : host.cols(),
      edge < 0 ? rows.viewportY : Math.min(rows.viewportY + host.rows(), rows.length - 1),
    ];
    redraw();
  }

  function up(event: MouseEvent): void {
    if (event.button !== 0) return;
    stopDrag();
    const next = active();
    if (next && published ? !equal(next.start, published.start) || !equal(next.end, published.end) || next.column !== published.column
      : next !== published) publish();
  }

  host.element.addEventListener("mousedown", down);
  const offInput = host.onUserInput(() => { if (model.anchor || model.all) clearSelection(); });
  return {
    hasSelection: () => active() !== null,
    getSelection,
    getSelectionPosition() {
      const range = active();
      return range ? { start: { x: range.start[0], y: range.start[1] }, end: { x: range.end[0], y: range.end[1] } } : undefined;
    },
    select(column, row, length) {
      stopDrag();
      model.start([column, row], "normal", length);
      redraw();
      publish();
    },
    selectAll() {
      stopDrag();
      model.start(undefined, "normal");
      model.all = true;
      redraw();
      publish();
    },
    selectLines(start, end) {
      stopDrag();
      model.start([0, Math.max(0, start)], "normal");
      model.end = [host.cols(), Math.min(end, host.screenRows().length - 1)];
      redraw();
      publish();
    },
    clearSelection,
    drawnSelection: () => model.range(),
    onSelectionChange: changes.subscribe,
    onRedraw: redraws.subscribe,
    onLinuxMouseSelection: linuxSelection.subscribe,
    refresh(trimmedRows = 0) {
      const nextAlternate = host.screenRows().alternate, nextHeight = host.rows();
      const reset = alternate !== nextAlternate || height !== nextHeight;
      alternate = nextAlternate;
      height = nextHeight;
      if (reset) { clearSelection(); return; }
      model.trim(trimmedRows);
      redraw();
    },
    enable: () => { enabled = true; },
    disable: () => { enabled = false; clearSelection(); },
    dispose() {
      if (disposed) return;
      disposed = true;
      host.element.removeEventListener("mousedown", down);
      offInput();
      stopDrag();
      model.start(undefined, "normal");
      changes.dispose();
      redraws.dispose();
      linuxSelection.dispose();
    },
  };
}
