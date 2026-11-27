/**
 * Copyright (c) 2017 The xterm.js authors. All rights reserved.
 * @license MIT
 * Adapted for Ovis.
 */

import { before } from "./mouse.ts";
import type { DrawnSelection, LinkHost, Point } from "./types.ts";

type Mode = "normal" | "word" | "line" | "column";

/** Advance in buffer cells, keeping an exact right edge on its own row. */
export function advance([x, y]: Point, length: number, cols: number): Point {
  const offset = x + length;
  if (offset <= cols) return [offset, y];
  const full = Math.floor((offset - 1) / cols);
  return [offset - full * cols, y + full];
}

export class SelectionModel {
  anchor: Point | undefined;
  end: Point | undefined;
  length = 0;
  all = false;
  mode: Mode = "normal";

  constructor(private readonly host: LinkHost) {}

  start(anchor: Point | undefined, mode: Mode, length = 0): void {
    this.anchor = anchor;
    this.end = undefined;
    this.length = length;
    this.mode = mode;
    this.all = false;
  }

  range(): DrawnSelection | null {
    const cols = this.host.cols();
    if (cols <= 0) return null;
    if (this.all) {
      const rows = this.host.screenRows();
      const last = Math.min(rows.length, rows.baseY + this.host.rows()) - 1;
      return last < 0 ? null : { start: [0, 0], end: [cols, last], column: false };
    }
    const { anchor, end } = this;
    if (!anchor) return null;
    const minimum = advance(anchor, this.length, cols);
    const column = this.mode === "column";
    if (end && before(end, anchor)) return { start: [...end], end: minimum, column };
    return { start: [...anchor], end: end && before(minimum, end) ? [...end] : minimum, column };
  }

  trim(amount: number): void {
    const anchor = this.anchor;
    if (amount <= 0 || this.all || !anchor) return;
    const range = this.range();
    if (!range || range.end[1] < amount || (range.end[1] === amount && range.end[0] === 0)) {
      this.start(undefined, "normal");
      return;
    }
    const cols = this.host.cols();
    const rebase = ([x, y]: Point): Point => y < amount ? [this.mode === "column" ? x : 0, 0] : [x, y - amount];
    const next = rebase(anchor);
    const minimum = rebase(advance(anchor, this.length, cols));
    this.length = Math.max(0, (minimum[1] - next[1]) * cols + minimum[0] - next[0]);
    this.anchor = next;
    if (this.end) this.end = rebase(this.end);
  }
}
