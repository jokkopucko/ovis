import type { PaneFindMatch, PaneFindRequest, PaneFindResponse, PaneScrollInfo } from "../../shared/protocol.ts";
import { herdrWidthProvider } from "../../src/lib/terminalWidths.ts";

const widths = herdrWidthProvider();
interface Cell { text: string; from: number; to: number; width: number }
interface Span extends Cell { start: { row: number; col: number }; end: { row: number; col: number } }
interface Layout { rows: string[]; lines: Array<{ text: string; spans: Span[] }> }
const compare = (a: { row: number; col: number }, b: { row: number; col: number }): number => a.row - b.row || a.col - b.col;

function cells(text: string): Cell[] {
  const result: Cell[] = [];
  let preceding = 0;
  let index = 0;
  for (const char of text) {
    const property = widths.charProperties!(char.codePointAt(0)!, preceding);
    const width = (property >> 1) & 3;
    // UnicodeCharProperties packs shouldJoin in bit 0 and cell width in bits 1–2.
    const last = result.at(-1);
    if ((property & 1) !== 0 && last) {
      last.text += char; last.to += char.length; last.width = width;
    } else result.push({ text: char, from: index, to: index + char.length, width });
    index += char.length;
    preceding = property;
  }
  return result;
}

export const DEMO_LOG_LINES = [
  "release $ demo logs",
  "Fictional checkout service logs. Search ERROR, WARN or ready; scroll to browse.",
  ...Array.from({ length: 180 }, (_, index) => {
    const n = index + 1;
    const time = `10:${String(Math.floor(index / 60)).padStart(2, "0")}:${String(index % 60).padStart(2, "0")}`;
    const event = n % 29 === 0 ? "ERROR payment gateway timeout; retry scheduled"
      : n % 13 === 0 ? "WARN cache miss; refreshing checkout summary"
      : n % 7 === 0 ? "INFO worker ready; queued jobs processed"
      : `INFO request ${String(n).padStart(4, "0")} completed; status=200`;
    return `${time} ${event}`;
  }),
  "10:03:00 INFO service ready; 180 fictional log entries retained",
  "release $ ",
];

export class DemoHistory {
  revision = 2;
  offset = 0;
  private lines: string[];
  private layout: Layout;
  constructor(public cols: number, public rows: number, lines: readonly string[] = DEMO_LOG_LINES) {
    this.lines = [...lines];
    this.layout = this.reflow();
  }
  private reflow(): Layout {
    const result: Layout = { rows: [], lines: [] };
    for (const text of this.lines) {
      const spans: Span[] = [];
      let rendered = "";
      let col = 0;
      for (const cell of cells(text)) {
        if (col > 0 && col + cell.width > this.cols) {
          result.rows.push(rendered); rendered = ""; col = 0;
        }
        const start = { row: result.rows.length, col };
        const end = { row: start.row, col: Math.min(this.cols - 1, col + Math.max(1, cell.width) - 1) };
        spans.push({ ...cell, start, end });
        rendered += cell.text;
        col += cell.width;
      }
      result.rows.push(rendered);
      result.lines.push({ text, spans });
    }
    return result;
  }
  scroll(): PaneScrollInfo {
    const max = Math.max(0, this.layout.rows.length - this.rows);
    return { offset_from_bottom: Math.min(max, this.offset), max_offset_from_bottom: max, viewport_rows: this.rows };
  }
  setOffset(offset: number): PaneScrollInfo {
    this.offset = Math.min(this.scroll().max_offset_from_bottom, Math.max(0, Math.round(offset)));
    return this.scroll();
  }
  resize(cols: number, rows: number): boolean {
    if (this.cols === cols && this.rows === rows) return false;
    this.cols = cols; this.rows = rows;
    this.layout = this.reflow(); this.revision += 2;
    this.setOffset(this.offset);
    return true;
  }
  setPrompt(text: string): void {
    this.lines[this.lines.length - 1] = text;
    this.layout = this.reflow(); this.revision += 2; this.offset = 0;
  }
  append(lines: string[]): void {
    this.lines.push(...lines); this.layout = this.reflow(); this.revision += 2; this.offset = 0;
  }
  clear(): void {
    this.lines = [""]; this.layout = this.reflow(); this.revision += 2; this.offset = 0;
  }
  render(): string {
    const scroll = this.scroll();
    const top = scroll.max_offset_from_bottom - scroll.offset_from_bottom;
    const visible = this.layout.rows.slice(top, top + this.rows);
    // Absolute row positioning avoids a full-width last row scrolling xterm's zero-history grid.
    const output = visible.map((line, row) => `\x1b[${row + 1};1H${line}`).join("");
    const last = visible.at(-1) ?? "";
    const cursor = Math.min(this.cols, cells(last).reduce((sum, cell) => sum + cell.width, 0) + 1);
    return `\x1b[?1000h\x1b[?1006h${this.offset > 0 ? "\x1b[?25l" : "\x1b[?25h"}\x1b[?7l\x1b[2J\x1b[H${output}\x1b[${Math.max(1, visible.length)};${cursor}H\x1b[?7h`;
  }
  find(request: PaneFindRequest): PaneFindResponse {
    const matches: PaneFindMatch[] = [];
    const literal = request.query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const regex = new RegExp(literal, /\p{Lu}/u.test(request.query) ? "gu" : "giu");
    for (const line of this.layout.lines) {
      for (const found of line.text.matchAll(regex)) {
        const start = line.spans.find((span) => span.from === found.index);
        const end = line.spans.find((span) => span.to === found.index! + found[0].length);
        if (start && end) matches.push({ start: start.start, end: end.end });
      }
    }
    const scroll = this.scroll();
    const top = scroll.max_offset_from_bottom - scroll.offset_from_bottom;
    const origin = request.previous
      ? request.direction === "forward" ? request.previous.end : request.previous.start
      : { row: top, col: request.direction === "forward" ? 0 : this.cols - 1 };
    let current = -1;
    for (let index = 0; index < matches.length; index += 1) {
      if (request.direction === "forward" && compare(matches[index]!.start, origin) > 0) { current = index; break; }
      if (request.direction === "backward" && compare(matches[index]!.end, origin) < 0) current = index;
    }
    if (current < 0 && matches.length > 0) current = request.direction === "forward" ? 0 : matches.length - 1;
    const match = current < 0 ? null : matches[current]!;
    if (match && request.jump !== false) this.setOffset(scroll.max_offset_from_bottom - match.start.row);
    const start = Math.min(Math.max(0, current - 512), Math.max(0, matches.length - 1024));
    return { total: matches.length, current: current < 0 ? null : current + 1, match, matches: matches.slice(start, start + 1024), content_revision: this.revision, scroll: this.scroll() };
  }
}
