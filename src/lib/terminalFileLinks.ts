import type { IBuffer, ILink, ILinkDecorations, ILinkProvider } from "@xterm/xterm";
import { fileUriPath } from "../../shared/fileUri.ts";
import { isWebLink } from "./externalLink.ts";
import { isCodeName } from "./filePaths.ts";

const NAME = "\\p{L}\\p{N}\\p{M}_";
/**
 * A bare name (`README.md`) opens only on Cmd+click, Ctrl+click off a Mac (`bareNameLinks`): a terminal
 * is full of them (`ls`, `git status`, a compiler's output), a tap or a click to focus the pane lands on
 * one, and the file viewer would open over the terminal for it. The character before it is matched too,
 * not looked behind at (shared/lookbehind.ts): group 1 is the link, group 2 its path.
 */
const FILE_PATH = new RegExp(`(?:^|[^${NAME}/.@~:-])(((?:~\\/|\\.{1,2}\\/|\\/)?(?:[${NAME}@.+-]+\\/)*[${NAME}@+-][${NAME}@.+-]*\\.[A-Za-z0-9]{1,8})(?::\\d+(?::\\d+)?|#L\\d+(?:-L?\\d+)?)?)(?![${NAME}/])`, "gu");
const CALL = /\s*\((?!\d+(?:,\d+)?\))/y;
const FILE_URI = /file:\/\/\/[^\s<>"`]+/gi;
const MAX_LINE_CHARS = 8192;

/**
 * The OSC 8 handler that keeps a hyperlink this app cannot open from being drawn as one (#739).
 * xterm underlines every linked cell with a dashed line, and herdr's attach stream keeps a row's
 * link open over the padding after its text, so OmO's side panel (`omo-panel:` links, which only
 * OmO's own mouse handling follows) showed a dotted rule under every file row to the panel's edge.
 * Here such a link opens nothing (the link handler takes http(s) and file URIs only), so its
 * opening is swallowed. Not while a link xterm holds is still open: xterm ends that one only on
 * the next OSC 8 it is handed, and it would run on over the new link's text.
 * `handler` answers true to swallow the sequence, false to hand it to xterm; `reset` goes with
 * `term.reset()`, which ends xterm's open link too.
 */
export function hyperlinkFilter(): { handler: (payload: string) => boolean; reset: () => void } {
  let open = false;
  return {
    handler: (payload) => {
      const separator = payload.indexOf(";");
      if (separator === -1) return false; // malformed: xterm ignores it, and so does `open`
      const uri = payload.slice(separator + 1);
      if (uri !== "" && !open && !isWebLink(uri) && fileUriPath(uri) === null) return true;
      open = uri !== "";
      return false;
    },
    reset: () => { open = false; },
  };
}

/**
 * The links of bare file names (`design.md`, no folder), which only Cmd+click (Ctrl+click off a
 * Mac) follows, as in VS Code's terminal, and which are drawn as links (underline, pointer) only
 * while that key is held. `update` hears the key go down and up (and the mouse's keys as it moves:
 * the key may have gone down in another window). xterm reads a link's decorations as the pointer
 * reaches it, then swaps them for its own object, whose setters redraw the link it hovers now,
 * whichever link's object is written: so only the hovered bare name's are written, never one the
 * pointer has left for a path with a folder, which stays drawn. A link hovered again on the same
 * row is read from that object, which still holds how it was drawn when the pointer left: its
 * hover draws it for the key as it is now.
 */
export function bareNameLinks(mac: boolean) {
  let held = false;
  let hovered: ILink | null = null;
  const show = (next: boolean): void => {
    if (next === held) return;
    held = next;
    if (!hovered?.decorations) return;
    hovered.decorations.pointerCursor = held;
    hovered.decorations.underline = held;
  };
  return {
    /** the key that follows a bare name: Cmd on a Mac, Ctrl elsewhere */
    pressed: (event: { metaKey: boolean; ctrlKey: boolean }): boolean => mac ? event.metaKey : event.ctrlKey,
    // read when xterm first hovers the link; the hover's own write lands on nothing until xterm swaps them
    decorations: (): ILinkDecorations => ({
      get pointerCursor() { return held; }, set pointerCursor(_: boolean) {},
      get underline() { return held; }, set underline(_: boolean) {},
    }),
    hover: (link: ILink): void => {
      hovered = link;
      if (!link.decorations) return;
      link.decorations.pointerCursor = held;
      link.decorations.underline = held;
    },
    leave: (link: ILink): void => { if (hovered === link) hovered = null; },
    update: (event: { metaKey: boolean; ctrlKey: boolean }): void => show(mac ? event.metaKey : event.ctrlKey),
    reset: (): void => show(false),
  };
}
export type BareNameLinks = ReturnType<typeof bareNameLinks>;

interface LogicalLine {
  text: string;
  /** the cell each UTF-16 unit of `text` sits in (1-based, as xterm's link ranges are) and its width */
  positions: { x: number; y: number; width: number }[];
  clipped: boolean;
}

function logicalLine(buffer: IBuffer, lineNumber: number): LogicalLine | null {
  let first = lineNumber - 1;
  while (first > 0 && buffer.getLine(first)?.isWrapped) first--;
  let text = "";
  const positions: LogicalLine["positions"] = [];
  for (let y = first; y < buffer.length; y++) {
    const line = buffer.getLine(y);
    if (!line || (y > first && !line.isWrapped)) break;
    for (let x = 0; x < line.length; x++) {
      const cell = line.getCell(x);
      if (!cell || cell.getWidth() === 0) continue;
      if (x === line.length - 1 && !cell.getChars() && buffer.getLine(y + 1)?.isWrapped
        && buffer.getLine(y + 1)?.getCell(0)?.getWidth() === 2) continue;
      const chars = cell.getChars() || " ";
      text += chars;
      for (let i = 0; i < chars.length; i++) positions.push({ x: x + 1, y: y + 1, width: cell.getWidth() });
    }
    if (text.length > MAX_LINE_CHARS) return null;
  }
  return { text, positions, clipped: buffer.getLine(first)?.isWrapped === true };
}

function addresses(text: string): [number, number][] {
  const spans: [number, number][] = [];
  let end = 0;
  for (let at = text.indexOf("://"); at !== -1; at = text.indexOf("://", end)) {
    let start = at;
    while (start > end && !/\s/.test(text[start - 1]!)) start--;
    end = at + 3;
    while (end < text.length && !/\s/.test(text[end]!)) end++;
    spans.push([start, end]);
  }
  return spans;
}

type FileLink = Omit<ILink, "activate"> & { activate: (event: MouseEvent) => void };

export function terminalFileLinks(buffer: IBuffer, lineNumber: number, open: (path: string, event: MouseEvent) => void, bare?: BareNameLinks): FileLink[] {
  const line = logicalLine(buffer, lineNumber);
  if (line === null) return [];
  const { text, positions } = line;
  // the first word of a line whose beginning is gone would open as a path of its own: `hijk/App.tsx`
  const firstGap = text.search(/\s/);
  const lead = !line.clipped ? 0 : firstGap === -1 ? text.length : firstGap;
  const links: FileLink[] = [];
  const link = (index: number, shown: string, path: string, keyed?: BareNameLinks): void => {
    const start = positions[index];
    const last = positions[index + shown.length - 1];
    if (!start || !last || index < lead || lineNumber < start.y || lineNumber > last.y) return;
    const found: FileLink = {
      range: { start: { x: start.x, y: start.y }, end: { x: last.x + last.width - 1, y: last.y } },
      text: shown,
      // xterm keeps a row's links until the pointer leaves the row: the row is read again at the
      // click, and it opens only if the same whole link is still there (`foo.ts` grown to `foo.tsx` is not)
      activate: (event) => {
        if (keyed && !keyed.pressed(event)) return;
        const same = terminalFileLinks(buffer, lineNumber, () => {}, bare).some((now) => now.text === shown
          && now.range.start.x === start.x && now.range.start.y === start.y
          && now.range.end.x === last.x + last.width - 1 && now.range.end.y === last.y);
        if (same) open(path, event);
      },
    };
    if (keyed) {
      found.decorations = keyed.decorations();
      found.hover = () => keyed.hover(found);
      found.leave = () => keyed.leave(found);
    }
    links.push(found);
  };
  for (const match of text.matchAll(FILE_URI)) {
    const uri = match[0].replace(/[),.;:!?']+$/, "");
    const path = fileUriPath(uri);
    if (path) link(match.index, uri, path);
  }
  const spans = addresses(text);
  let span = 0;
  for (const found of text.matchAll(FILE_PATH)) {
    const linked = found[1]!;
    const match = { index: found.index! + found[0].length - linked.length, 0: linked };
    const path = found[2];
    const folder = path?.includes("/") === true;
    if (!path || (!folder && !bare) || !/\p{L}/u.test(path.replace(/\.[A-Za-z0-9]{1,8}$/, ""))) continue;
    if (/^v?\d+(?:\.\d+)+$/.test(path) || (!folder && isCodeName(path))) continue;
    CALL.lastIndex = match.index + match[0].length;
    if (CALL.test(text)) continue;
    while (span < spans.length && spans[span]![1] <= match.index) span++;
    if (span < spans.length && spans[span]![0] <= match.index) continue;
    link(match.index, match[0], match[0], folder ? undefined : bare);
  }
  return links;
}

export function terminalFileLinkProvider(buffer: () => IBuffer, open: (path: string, event: MouseEvent) => void, bare?: BareNameLinks): ILinkProvider {
  return { provideLinks: (line, callback) => callback(terminalFileLinks(buffer(), line, open, bare)) };
}
