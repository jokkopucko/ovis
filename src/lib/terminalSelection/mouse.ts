/**
 * Copyright (c) 2017 The xterm.js authors. All rights reserved.
 * @license MIT
 * Adapted for Ovis.
 */

import type { ILink, LinkHost, Point } from "./types.ts";

export const clamp = (value: number, min: number, max: number): number => Math.min(Math.max(value, min), max);
export const equal = (a: Point, b: Point): boolean => a[0] === b[0] && a[1] === b[1];
export const before = (a: Point, b: Point): boolean => a[1] < b[1] || (a[1] === b[1] && a[0] < b[0]);

export function linkContains({ range }: ILink, [x, y]: Point): boolean {
  const { start, end } = range;
  return (y > start.y || (y === start.y && x >= start.x)) && (y < end.y || (y === end.y && x <= end.x));
}

export function mouseGrid(host: LinkHost, event: MouseEvent) {
  const { screen } = host;
  const { width, height } = host.cell();
  const cols = host.cols(), rows = host.rows();
  if (width <= 0 || height <= 0 || cols <= 0 || rows <= 0) return undefined;
  const rect = screen.getBoundingClientRect();
  const style = screen.ownerDocument.defaultView?.getComputedStyle(screen);
  const x = event.clientX - rect.left - (parseFloat(style?.paddingLeft ?? "") || 0);
  const y = event.clientY - rect.top - (parseFloat(style?.paddingTop ?? "") || 0);
  const viewportHeight = height * rows;
  const { viewportY, alternate } = host.screenRows();
  const row = clamp(Math.ceil(y / height) - 1, 0, rows - 1) + viewportY;
  // A selection endpoint lies between cells, not on them.
  const boundary: Point = [clamp(Math.ceil(x / width + 0.5) - 1, 0, cols), row];
  const cell: Point | undefined = x < 0 || x > width * cols || y < 0 || y > viewportHeight
    ? undefined : [clamp(Math.ceil(x / width), 1, cols), row + 1];
  return { boundary, cell, edge: y < 0 ? y : Math.max(0, y - viewportHeight), viewportY, alternate, cols, rows };
}

export function signal<T>() {
  const listeners = new Set<(value: T) => void>();
  return {
    subscribe(listener: (value: T) => void): () => void {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    emit(value: T): void { for (const listener of listeners) listener(value); },
    dispose(): void { listeners.clear(); },
  };
}
