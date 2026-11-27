/**
 * Copyright (c) 2019 The xterm.js authors. All rights reserved.
 * @license MIT
 * Adapted for Ovis from the xterm.js Web Links addon 0.12.0 (WebLinkProvider, WebLinksAddon's URL pattern): the http(s)
 * addresses in a row and the rows it wraps over become links, read from any ScreenRows.
 */
import type { ScreenRows } from "../terminalScreen.ts";
import type { ILink, ILinkProvider } from "./types.ts";

const STRICT_URL = /(https?|HTTPS?):[/]{2}[^\s"'!*(){}|\\^<>`]*[^\s"':,.!?{}|\\^~[\]`()<>]/;
/** a wrapped line is read up and down this far at most */
const WINDOW_CHARS = 2048;

function isUrl(text: string): boolean {
  try {
    const url = new URL(text);
    const base = url.password && url.username
      ? `${url.protocol}//${url.username}:${url.password}@${url.host}`
      : url.username ? `${url.protocol}//${url.username}@${url.host}` : `${url.protocol}//${url.host}`;
    return text.toLocaleLowerCase().startsWith(base.toLocaleLowerCase());
  } catch {
    return false;
  }
}

/** the row's text with the rows it wraps over, stopping at a space or past WINDOW_CHARS, and the first row's index */
function windowedLines(rows: ScreenRows, index: number): [string[], number] {
  const lines: string[] = [];
  let top = index;
  let bottom = index;
  let line = rows.getLine(index);
  if (!line) return [lines, top];
  const current = line.translateToString(true);
  if (line.isWrapped && current[0] !== " ") {
    let length = 0;
    while ((line = rows.getLine(--top)) && length < WINDOW_CHARS) {
      const content = line.translateToString(true);
      length += content.length;
      lines.push(content);
      if (!line.isWrapped || content.includes(" ")) break;
    }
    lines.reverse();
  }
  lines.push(current);
  let length = 0;
  while ((line = rows.getLine(++bottom)) && line.isWrapped && length < WINDOW_CHARS) {
    const content = line.translateToString(true);
    length += content.length;
    lines.push(content);
    if (content.includes(" ")) break;
  }
  return [lines, top];
}

/** a string index back to the cell it is in: [row, column] 0-based, or [-1, -1] past the rows */
function mapIndex(rows: ScreenRows, row: number, column: number, index: number): [number, number] {
  const cell = rows.getNullCell();
  let start = column;
  while (index) {
    const line = rows.getLine(row);
    if (!line) return [-1, -1];
    for (let x = start; x < line.length; ++x) {
      line.getCell(x, cell);
      const chars = cell.getChars();
      if (cell.getWidth()) {
        index -= chars.length || 1;
        // a wide character wrapped early leaves the row's last cell empty, which the trimmed text left out
        if (x === line.length - 1 && chars === "") {
          const next = rows.getLine(row + 1);
          if (next?.isWrapped) {
            next.getCell(0, cell);
            if (cell.getWidth() === 2) index += 1;
          }
        }
      }
      if (index < 0) return [row, x];
    }
    row++;
    start = 0;
  }
  return [row, start];
}

/** the http(s) links of view row `y` (1-based, as providers are asked), each as xterm's link ranges give it */
export function webLinksAt(rows: ScreenRows, y: number, activate: (event: MouseEvent, uri: string) => void, pattern = STRICT_URL): ILink[] {
  const search = new RegExp(pattern.source, `${pattern.flags.replace("g", "")}g`);
  const [lines, top] = windowedLines(rows, y - 1);
  const text = lines.join("");
  const links: ILink[] = [];
  for (let match = search.exec(text); match; match = search.exec(text)) {
    const uri = match[0];
    if (!isUrl(uri)) continue;
    const [startY, startX] = mapIndex(rows, top, 0, match.index);
    const [endY, endX] = mapIndex(rows, startY, startX, uri.length);
    if (startY === -1 || startX === -1 || endY === -1 || endX === -1) continue;
    links.push({ range: { start: { x: startX + 1, y: startY + 1 }, end: { x: endX, y: endY + 1 } }, text: uri, activate });
  }
  return links;
}

/** a link provider for the http(s) addresses in the rows `rows()` reads, opened with `activate` */
export function webLinkProvider(rows: () => ScreenRows, activate: (event: MouseEvent, uri: string) => void): ILinkProvider {
  return { provideLinks: (y, callback) => callback(webLinksAt(rows(), y, activate)) };
}
