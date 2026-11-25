import type { ScreenCell, ScreenRow, ScreenSnapshot } from "../../shared/input-row.ts";
import type { ScreenCell as GridCell, ScreenRows } from "./terminalScreen.ts";

export { inputRowState, readsInputRow, type InputRowRecognizer, type InputRowState, type ScreenCell, type ScreenRow, type ScreenSnapshot } from "../../shared/input-row.ts";

export function readScreen(buffer: ScreenRows, cols: number, rows: number): ScreenSnapshot {
  const out: ScreenRow[] = [];
  let cell: GridCell | undefined;
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

export function readScreenLines(buffer: ScreenRows, rows: number): string[] | null {
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

type GateParse = "ground" | "can" | "can-esc" | "can-csi" | "can-bang" | "esc" | "csi" | "bang" | "private";
/** xterm 6 Params capacity (node_modules/@xterm/xterm/src/common/parser/Params.ts). */
const XTERM_MAX_CSI_PARAMS = 32;

/**
 * herdr wraps each frame it draws in a synchronized-update block (`CSI ? 2026 h` … `l`, including
 * combined private-mode switches such as `CSI ? 25;2026 h`). xterm 6 holds its drawing until a
 * block closes, but what it has parsed can still end inside one: a frame is read only once its
 * block has closed. An unmatched `CSI ? 2026 l` outside a herdr-core paint (such as ReplayBuffer's
 * restored mode prefix on a truncated 128 KiB replay) still marks the stream as synchronized so a
 * truncated diff never settles as a complete screen. herdr-core's attach and same-channel recovery
 * paints start with CAN + DECSTR (`\x18\x1b[!p`) followed by `CSI ? 2026 l` and end with
 * `CSI ? 9001 [hl]`, so the paint stays unboundary across split 16 KiB chunks and settles as a
 * complete screen (resetting prior synchronized state) only once `?9001[hl]` closes a paint that
 * both started and ended on the current grid geometry. RIS (`ESC c`) and standalone DECSTR
 * (`CSI ! p`) clear synchronized state just as xterm 6 does. When the pane's grid itself changes
 * size, herdr may first draw the old screen again, reflowed for the new size (an idle box cut at
 * its borders reads as gone), before the agent's own redraw, or both may come as one frame: the
 * first frame after it is `reflowing`, read when asked but never taken as a change of screen.
 *
 * `enqueue` is called as a chunk is written (xterm parses later, in order), `settle` in its write callback, `resized` on
 * every resize of the grid, `reflowed` when the pane's grid changes size and `reset` where the stream starts over.
 */
export class FrameGate {
  private open = false;
  private synced = false;
  private openedIn = -1;
  private openedGeometry = false;
  private painting = false;
  private paintEpoch = -1;
  private paintGeometry = false;
  private epoch = 0;
  private settledEpoch = -1;
  private last = false;
  private reflow = false;
  private reflowFrame = false;
  private parse: GateParse = "ground";
  private paramVal = 0;
  private paramDigits = false;
  private paramSub = false;
  private paramCount = 0;
  private saw2026 = false;
  private saw9001 = false;

  private resetParser(): void {
    this.parse = "ground";
    this.paramVal = 0;
    this.paramDigits = false;
    this.paramSub = false;
    this.paramCount = 0;
    this.saw2026 = false;
    this.saw9001 = false;
  }

  private flushParam(): void {
    if (this.paramCount < XTERM_MAX_CSI_PARAMS) {
      if (this.paramDigits) {
        if (this.paramVal === 2026) this.saw2026 = true;
        else if (this.paramVal === 9001) this.saw9001 = true;
      }
      this.paramCount++;
    }
    this.paramVal = 0;
    this.paramDigits = false;
    this.paramSub = false;
  }

  enqueue(data: string, geometry: boolean): FrameStamp {
    let syncWhole = false;
    let paintWhole = false;
    let stalePaintClose = false;
    for (let i = 0; i < data.length; i++) {
      const code = data.charCodeAt(i);
      if (code === 0x18) {
        this.resetParser();
        this.parse = "can";
        continue;
      }
      if (code === 0x1a) {
        this.resetParser();
        continue;
      }
      if (code === 0x1b) {
        const next: GateParse = this.parse === "can" ? "can-esc" : "esc";
        this.resetParser();
        this.parse = next;
        continue;
      }
      if (this.parse === "ground") continue;
      if (code < 0x20) {
        if (this.parse === "can") this.resetParser();
        continue;
      }
      switch (this.parse) {
        case "can":
          this.parse = "ground";
          break;
        case "can-esc":
          if (code === 0x5b) this.parse = "can-csi";
          else {
            if (code === 0x63) { this.open = false; if (!this.painting) this.synced = false; }
            this.parse = "ground";
          }
          break;
        case "can-csi":
          if (code === 0x21) this.parse = "can-bang";
          else if (code === 0x3f) this.parse = "private";
          else this.parse = "ground";
          break;
        case "can-bang":
          if (code === 0x70) {
            this.painting = true;
            this.paintEpoch = this.epoch;
            this.paintGeometry = geometry;
            this.open = false;
          }
          this.parse = "ground";
          break;
        case "esc":
          if (code === 0x5b) this.parse = "csi";
          else {
            if (code === 0x63) { this.open = false; if (!this.painting) this.synced = false; }
            this.parse = "ground";
          }
          break;
        case "csi":
          if (code === 0x3f) this.parse = "private";
          else if (code === 0x21) this.parse = "bang";
          else this.parse = "ground";
          break;
        case "bang":
          if (code === 0x70) {
            this.open = false;
            if (!this.painting) this.synced = false;
          }
          this.parse = "ground";
          break;
        case "private":
          if (code >= 0x30 && code <= 0x39) {
            if (!this.paramSub) {
              this.paramVal = Math.min(this.paramVal * 10 + (code - 0x30), 99999);
              this.paramDigits = true;
            }
            break;
          }
          if (code === 0x3a) {
            this.paramSub = true;
            break;
          }
          if (code === 0x3b) {
            this.flushParam();
            break;
          }
          this.flushParam();
          if (code === 0x68 || code === 0x6c) {
            const wasPainting = this.painting;
            if (this.saw9001 && this.painting) {
              this.painting = false;
              if (this.paintEpoch === this.epoch && this.paintGeometry && geometry) {
                paintWhole = true;
                this.synced = false;
              } else {
                stalePaintClose = true;
              }
            }
            if (this.saw2026) {
              if (code === 0x68) {
                this.synced = true;
                this.open = true;
                this.openedIn = this.epoch;
                this.openedGeometry = geometry;
              } else if (this.open) {
                if (this.openedIn === this.epoch && this.openedGeometry && geometry) syncWhole = true;
                this.open = false;
                this.painting = false;
              } else if (!wasPainting) {
                this.synced = true;
              }
            }
          }
          this.resetParser();
          break;
      }
    }
    return {
      epoch: this.epoch,
      boundary: !this.open && !this.painting,
      whole: syncWhole || paintWhole || (!this.synced && !stalePaintClose),
      synchronized: syncWhole,
      geometry,
    };
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
    this.synced = false;
    this.openedIn = -1;
    this.openedGeometry = false;
    this.painting = false;
    this.paintEpoch = -1;
    this.paintGeometry = false;
    this.reflow = false;
    this.resetParser();
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
