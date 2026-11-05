import type { IBuffer, ILink, ILinkDecorations, ILinkProvider } from "@xterm/xterm";
import { fileUriPath } from "../../shared/fileUri.ts";
import { isCodeName } from "./filePaths.ts";
import { inMacApp, inNativeApp } from "./nativeApp.ts";

/**
 * Whether this page can keep a browser tab to reuse. The iOS, Android, Mac and desktop apps hand an
 * external address to the system browser, so the window they give back is never that tab.
 */
export function canReuseExternalLinkTab(): boolean {
  return !inNativeApp() && !inMacApp() && !(typeof navigator !== "undefined" && /\bElectron\//.test(navigator.userAgent));
}

/** what a name is made of: letters, digits and the marks that complete them (a decomposed `é` is two) */
const NAME = "\\p{L}\\p{N}\\p{M}_";
/**
 * A path, optionally followed by an agent's line/column or #L reference, kept for the viewer.
 * A path with a folder in it opens on a plain click. A bare name (`README.md`) opens only on
 * Cmd+click, Ctrl+click off a Mac (`bareNameLinks`): a terminal is full of them (`ls`, `git status`, a
 * compiler's output), a tap or a click to focus the pane lands on one, and the file viewer
 * would open over the terminal for it. A chat's plain text is read the same way (BARE_PATH in
 * filePaths.ts). The character before it is matched too, not looked behind at
 * (shared/lookbehind.ts): group 1 is the link, group 2 its path.
 */
const FILE_PATH = new RegExp(`(?:^|[^${NAME}/.@~:-])(((?:~\\/|\\.{1,2}\\/|\\/)?(?:[${NAME}@.+-]+\\/)*[${NAME}@+-][${NAME}@.+-]*\\.[A-Za-z0-9]{1,8})(?::\\d+(?::\\d+)?|#L\\d+(?:-L?\\d+)?)?)(?![${NAME}/])`, "gu");
/** `name.ext(` is a call, not a file, unless the parenthesis holds a compiler's line and column: `App.tsx(120,8)` */
const CALL = /\s*\((?!\d+(?:,\d+)?\))/y;
const FILE_URI = /file:\/\/\/[^\s<>"`]+/gi;
/** A logical line longer than this is not prose with paths in it (a minified bundle, a blob): it is left alone. */
const MAX_LINE_CHARS = 8192;

/**
 * A URI this app opens in a new tab: an http(s) address and nothing else. Both link paths in
 * PaneTerminal answer to it, so a line crafted to look like a link cannot hand the browser a
 * scheme of its own choosing (`javascript:`, `data:`, an OS handler).
 */
export function isWebLink(uri: string): boolean {
  return /^https?:\/\//i.test(uri);
}

/**
 * Makes an http(s) link opener. Each instance owns at most one reusable tab. A browser lets a page
 * steer a tab of another site only as its opener, so the reused tab keeps its opener: the site in it
 * can see and navigate this tab. That is why reuse is a setting, off by default; a new tab has none.
 */
export function createWebLinkOpener(): (uri: string, reuse: boolean) => void {
  let reusable: Window | null = null;
  const newTab = (uri: string): void => {
    const link = document.createElement("a");
    link.href = uri;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.click();
  };
  return (uri, reuse) => {
    if (!reuse || !canReuseExternalLinkTab()) {
      newTab(uri);
      return;
    }
    try {
      if (reusable === null || reusable.closed) {
        reusable = window.open(uri, "_blank");
        if (reusable === null) newTab(uri);
        return;
      }
      reusable.location.href = uri;
      reusable.focus();
    } catch {
      // the browser refused to open or steer that tab (say, it no longer counts this page as its opener): a click never does nothing
      reusable = null;
      newTab(uri);
    }
  };
}

/** Opens links from coding-agent chat and terminal output. */
export const openWebLink = createWebLinkOpener();

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
  /** the line's beginning scrolled off the top: its first word is the end of something longer */
  clipped: boolean;
}

/** The whole wrapped line that buffer row `lineNumber` (1-based) is part of. */
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

/** The runs of `text` that hold `://`, each from the whitespace before to the whitespace after: one pass. */
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

/** With `bare`, bare names are links too, followed only with its key; without it only paths with a folder are. */
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
      // a wide character's last cell is the link's end, not its first
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
  // Web addresses belong to WebLinksAddon, and a file URI was read above.
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
