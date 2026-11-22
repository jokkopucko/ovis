import type { IBuffer, IBufferCell } from "@xterm/xterm";
import type { ScreenCell, ScreenRow, ScreenSnapshot } from "../../shared/input-row.ts";

export { inputRowState, readsInputRow, type InputRowRecognizer, type InputRowState, type ScreenCell, type ScreenRow, type ScreenSnapshot } from "../../shared/input-row.ts";

export function readScreen(buffer: IBuffer, cols: number, rows: number): ScreenSnapshot {
  const out: ScreenRow[] = [];
  let cell: IBufferCell | undefined;
  for (let y = 0; y < rows; y++) {
    const line = buffer.getLine(buffer.baseY + y);
    const cells: ScreenCell[] = [];
    if (line) {
      for (let x = 0; x < Math.min(cols, line.length); x++) {
        cell = line.getCell(x, cell);
        if (!cell || cell.getWidth() === 0) continue;
        cells.push({
          char: cell.getChars() || " ",
          dim: cell.isDim() !== 0,
          italic: cell.isItalic() !== 0,
          inverse: cell.isInverse() !== 0,
          fgDefault: cell.isFgDefault(),
        });
      }
    }
    out.push({ text: cells.map((item) => item.char).join("").trimEnd(), cells });
  }
  return { cols, rows: out };
}

export function readScreenLines(buffer: IBuffer, rows: number): string[] | null {
  const lines: string[] = [];
  for (let y = 0; y < rows; y++) {
    const line = buffer.getLine(buffer.baseY + y);
    if (!line || (y === 0 && line.isWrapped)) return null;
    const text = line.translateToString(y === rows - 1 || !buffer.getLine(buffer.baseY + y + 1)?.isWrapped);
    if (line.isWrapped && lines.length) lines[lines.length - 1] += text;
    else lines.push(text);
  }
  return lines;
}

export interface FrameStamp {
  readonly epoch: number;
  readonly boundary: boolean;
  readonly whole: boolean;
  readonly synchronized: boolean;
  readonly geometry: boolean;
}

const SYNC = /\u001b\[\?2026([hl])/g;

/**
 * herdr wraps each frame it draws in a synchronized-update block (`CSI ? 2026 h` … `l`). xterm 6 holds its drawing until a
 * block closes, but what it has parsed can still end inside one: a frame is read only once its block has closed. When the
 * pane's grid itself changes size, herdr may first draw the old screen again, reflowed for the new size (an idle box cut at
 * its borders reads as gone), before the agent's own redraw, or both may come as one frame: the first frame after it is
 * `reflowing`, read when asked but never taken as a change of screen.
 *
 * `enqueue` is called as a chunk is written (xterm parses later, in order), `settle` in its write callback, `resized` on
 * every resize of the grid, `reflowed` when the pane's grid changes size and `reset` where the stream starts over.
 */
export class FrameGate {
  private open = false;
  private carry = "";
  private synced = false;
  private openedIn = -1;
  private epoch = 0;
  private settledEpoch = -1;
  private last = false;
  private reflow = false;
  private reflowFrame = false;

  enqueue(data: string, geometry: boolean): FrameStamp {
    const text = this.carry + data;
    let whole = false;
    for (const match of text.matchAll(SYNC)) {
      this.synced = true;
      if (match[1] === "h") { this.open = true; this.openedIn = this.epoch; }
      else { if (this.open && this.openedIn === this.epoch) whole = true; this.open = false; }
    }
    const escape = text.lastIndexOf("\u001b");
    const tail = escape < 0 ? "" : text.slice(escape);
    this.carry = tail.length < 8 && !/^\u001b\[\?2026[hl]/.test(tail) ? tail : "";
    return { epoch: this.epoch, boundary: !this.open, whole: whole || !this.synced, synchronized: whole, geometry };
  }

  settle(stamp: FrameStamp, ready: boolean): boolean {
    let settled = ready && stamp.geometry && stamp.boundary && stamp.epoch === this.epoch;
    if (settled && this.settledEpoch !== this.epoch) {
      if (stamp.whole) this.settledEpoch = this.epoch;
      else settled = false;
    }
    // the first frame for the pane's new size: maybe herdr's reflow of the old screen, the agent's redraw after it
    this.reflowFrame = settled && this.reflow;
    if (settled) this.reflow = false;
    this.last = settled;
    return settled;
  }

  resized(): void {
    this.epoch++;
    this.last = false;
  }

  reflowed(): void {
    this.reflow = true;
    this.last = false;
  }

  reset(): void {
    this.open = false;
    this.carry = "";
    this.synced = false;
    this.reflow = false;
    this.resized();
  }

  get current(): boolean {
    return this.last;
  }

  /**
   * The current frame is the first since the pane's grid changed size: possibly herdr's own redraw
   * of the old screen, reflowed. It may be read, but no screen opened or closed by it: a watched
   * peek neither arms nor comes back on it.
   */
  get reflowing(): boolean {
    return this.last && this.reflowFrame;
  }
}
