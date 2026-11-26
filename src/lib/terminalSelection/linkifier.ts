/**
 * Copyright (c) 2019 The xterm.js authors. All rights reserved.
 * @license MIT
 * Adapted for Ovis.
 */

import { equal, linkContains, mouseGrid, signal } from "./mouse.ts";
import type { ILink, ILinkDecorations, ILinkProvider, Linkifier, LinkHost, LinkUnderline } from "./types.ts";

type Grid = NonNullable<ReturnType<typeof mouseGrid>>;
type View = Pick<Grid, "viewportY" | "alternate" | "cols" | "rows">;
type Press = { readonly grid: Grid; readonly link: ILink };
type Registration = { readonly provider: ILinkProvider };
type Query = {
  readonly y: number;
  readonly view: View;
  readonly replies: Map<Registration, ILink[]>;
};

const POINTER = "xterm-cursor-pointer";
const sameView = (a: View, b: View): boolean =>
  a.viewportY === b.viewportY && a.alternate === b.alternate && a.cols === b.cols && a.rows === b.rows;
const sameLink = (a: ILink, b: ILink): boolean =>
  a.text === b.text && a.range.start.x === b.range.start.x && a.range.start.y === b.range.start.y
  && a.range.end.x === b.range.end.x && a.range.end.y === b.range.end.y;

function underlineOf({ range }: ILink, { viewportY, rows, cols }: View): LinkUnderline {
  const first = range.start.y - viewportY - 1, last = range.end.y - viewportY - 1;
  return {
    start: first < 0 ? [0, 0] : [range.start.x - 1, first],
    end: last >= rows ? [cols, rows - 1] : [range.end.x, last],
  };
}

export function createLinkifier(host: LinkHost): Linkifier {
  const { screen } = host;
  const view = screen.ownerDocument.defaultView;
  const underlines = signal<LinkUnderline | null>();
  const registrations = new Set<Registration>();
  let query: Query | undefined;
  let current: { readonly link: ILink; readonly restoreDecorations: () => void } | undefined;
  let press: Press | undefined;
  let shownUnderline = false;
  let last: { readonly event: MouseEvent; readonly grid: Grid } | undefined;
  let disposed = false;

  const paintUnderline = (range: LinkUnderline | null): void => {
    if (range || shownUnderline) {
      shownUnderline = range !== null;
      underlines.emit(range);
    }
  };
  const clearCurrent = (event: MouseEvent | undefined): void => {
    const previous = current;
    current = undefined;
    if (!previous) return;
    previous.restoreDecorations();
    screen.classList.remove(POINTER);
    paintUnderline(null);
    if (event) previous.link.leave?.(event, previous.link.text);
  };
  const invalidate = (event: MouseEvent | undefined): void => {
    const previous = query;
    query = undefined;
    clearCurrent(event);
    if (previous) {
      const links = new Set([...previous.replies.values()].flat());
      for (const link of links) link.dispose?.();
    }
  };
  const hover = (link: ILink, event: MouseEvent, grid: Grid): void => {
    const original = link.decorations;
    let pointerCursor = original?.pointerCursor ?? true;
    let underline = original?.underline ?? true;
    const tracked: ILinkDecorations = {
      get pointerCursor() { return pointerCursor; },
      set pointerCursor(value) {
        pointerCursor = value;
        if (current?.link === link) screen.classList.toggle(POINTER, value);
      },
      get underline() { return underline; },
      set underline(value) {
        if (underline === value) return;
        underline = value;
        if (current?.link === link) paintUnderline(value ? underlineOf(link, grid) : null);
      },
    };
    current = { link, restoreDecorations: () => {
      if (link.decorations === tracked) {
        if (original) link.decorations = original;
        else delete link.decorations;
      }
    } };
    link.decorations = tracked;
    screen.classList.toggle(POINTER, pointerCursor);
    if (underline) paintUnderline(underlineOf(link, grid));
    link.hover?.(event, link.text);
  };
  const resolve = (): void => {
    if (!query || !last?.grid.cell) return;
    const [x, y] = last.grid.cell;
    const occupied = new Set<number>();
    let found: ILink | undefined;
    // A higher-priority provider owns its whole span on this row, even if the pointer
    // is over a non-overlapping cell of an intersecting, lower-priority link.
    search: for (const registration of registrations) {
      const links = query.replies.get(registration);
      if (!links) break;
      for (const link of links) {
        const { start, end } = link.range;
        if (y < start.y || y > end.y) continue;
        const left = y === start.y ? Math.max(start.x, 1) : 1;
        const right = y === end.y ? Math.min(end.x, query.view.cols) : query.view.cols;
        let overlaps = false;
        for (let col = left; col <= right && !overlaps; col++) overlaps = occupied.has(col);
        if (overlaps) continue;
        if (x >= left && x <= right) { found = link; break search; }
        for (let col = left; col <= right; col++) occupied.add(col);
      }
    }
    if (current?.link === found) return;
    const { event, grid } = last;
    clearCurrent(event);
    if (found) hover(found, event, grid);
  };
  const queryAt = (event: MouseEvent, grid: Grid): void => {
    if (!grid.cell) return;
    const [, y] = grid.cell;
    const previousCell = last?.grid.cell;
    last = { event, grid };
    if (query?.y === y && sameView(query.view, grid)) {
      if (!previousCell || !equal(previousCell, grid.cell)) resolve();
      return;
    }
    invalidate(event);
    const pending: Query = { y, view: grid, replies: new Map() };
    query = pending;
    for (const registration of registrations) {
      // Providers get the hovered row only. A provider reading a logical line (as the
      // web/file providers do) returns ranges that can extend into either wrapped row.
      if (query !== pending) break;
      registration.provider.provideLinks(y, (links) => {
        if (query !== pending || pending.replies.has(registration)) {
          for (const link of new Set(links)) link.dispose?.();
          return;
        }
        pending.replies.set(registration, links ?? []);
        resolve();
      });
    }
  };

  function leave(event: MouseEvent | undefined): void {
    last = undefined;
    press = undefined;
    invalidate(event);
  }
  const mouseLeave = (event: MouseEvent): void => leave(event);
  const blur = (): void => leave(last?.event);
  function move(event: MouseEvent): void {
    const grid = mouseGrid(host, event);
    if (!grid?.cell) { leave(event); return; }
    if (press && (!sameView(press.grid, grid) || !equal(press.grid.boundary, grid.boundary)
      || !press.grid.cell || !equal(press.grid.cell, grid.cell))) press = undefined;
    // Ignore events from a client tooltip embedded inside the terminal.
    if (view) {
      for (const target of event.composedPath()) {
        if (target === screen) break;
        if (target instanceof view.Element && target.classList.contains("xterm-hover")) return;
      }
    }
    queryAt(event, grid);
  }
  function down(event: MouseEvent): void {
    if (event.button !== 0) return;
    press = undefined;
    const grid = mouseGrid(host, event);
    const link = current?.link;
    if (grid?.cell && link && query && sameView(query.view, grid) && linkContains(link, grid.cell)) {
      press = { grid, link };
    }
  }
  function up(event: MouseEvent): void {
    if (event.button !== 0) return;
    const previous = press;
    press = undefined;
    const link = current?.link;
    if (!previous || !link || !sameLink(previous.link, link)) return;
    const grid = mouseGrid(host, event);
    if (grid?.cell && previous.grid.cell && equal(grid.cell, previous.grid.cell) && equal(grid.boundary, previous.grid.boundary)
      && sameView(previous.grid, grid) && linkContains(link, grid.cell)) link.activate(event, link.text);
  }
  const refresh = (): void => {
    const event = last?.event;
    invalidate(event);
    if (event) move(event);
  };

  screen.addEventListener("mousemove", move);
  screen.addEventListener("mouseleave", mouseLeave);
  screen.addEventListener("mousedown", down);
  screen.addEventListener("mouseup", up);
  view?.addEventListener("blur", blur);
  return {
    registerLinkProvider(provider) {
      const registration: Registration = { provider };
      if (!disposed) { registrations.add(registration); refresh(); }
      return { dispose() { if (registrations.delete(registration)) refresh(); } };
    },
    focusedLink: () => current?.link,
    onUnderlineChange: underlines.subscribe,
    refresh,
    dispose() {
      if (disposed) return;
      disposed = true;
      screen.removeEventListener("mousemove", move);
      screen.removeEventListener("mouseleave", mouseLeave);
      screen.removeEventListener("mousedown", down);
      screen.removeEventListener("mouseup", up);
      view?.removeEventListener("blur", blur);
      registrations.clear();
      blur();
      underlines.dispose();
    },
  };
}
