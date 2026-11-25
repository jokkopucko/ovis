import type { ILink, ILinkDecorations, ILinkProvider } from "@xterm/xterm";
import { fileUriPath } from "../../shared/fileUri.ts";
import { terminalPathMatches } from "../../shared/terminal-links.ts";
import { isWebLink } from "./externalLink.ts";
import { isCodeName } from "./filePaths.ts";
import type { ScreenRows } from "./terminalScreen.ts";

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

function logicalLine(buffer: ScreenRows, lineNumber: number): LogicalLine | null {
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

type FileLink = Omit<ILink, "activate"> & { activate: (event: MouseEvent) => void };

/** `now`: the rows as they are at a click, read again then (a reader's rows can be held as they were when it was made) */
export function terminalFileLinks(buffer: ScreenRows, lineNumber: number, open: (path: string, event: MouseEvent) => void, bare?: BareNameLinks, now: () => ScreenRows = () => buffer): FileLink[] {
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
        const same = terminalFileLinks(now(), lineNumber, () => {}, bare).some((found) => found.text === shown
          && found.range.start.x === start.x && found.range.start.y === start.y
          && found.range.end.x === last.x + last.width - 1 && found.range.end.y === last.y);
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
  // A bare name is opt-in: plain pane clicks must not open a file viewer on names from ordinary output.
  for (const match of terminalPathMatches(text, bare !== undefined)) {
    if (!match.folder && isCodeName(match.path)) continue;
    link(match.index, match.link, match.link, match.folder ? undefined : bare);
  }
  return links;
}

export function terminalFileLinkProvider(buffer: () => ScreenRows, open: (path: string, event: MouseEvent) => void, bare?: BareNameLinks): ILinkProvider {
  // a click reads the rows again (libghostty's are held as they were read), on the screen the link was found on: a
  // full-screen program that came up between the press and the release does not take the link away
  const screenOf = (rows: ScreenRows): boolean => ("alternate" in rows ? rows.alternate === true : (rows as { type?: string }).type === "alternate");
  return {
    provideLinks: (line, callback) => {
      const found = buffer();
      callback(terminalFileLinks(found, line, open, bare, () => { const now = buffer(); return screenOf(now) === screenOf(found) ? now : found; }));
    },
  };
}
