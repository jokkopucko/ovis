import { useEffect, useRef } from "react";
import type { IDisposable, Terminal } from "@xterm/xterm";
import type { IImageAddonOptions, ImageAddon } from "@xterm/addon-image";
import { itermPictures, type OscStreamHandler, type PictureFeed, type PictureLimits } from "./itermPictures.ts";

/**
 * Caps on what a pane's pictures may hold in this tab. Decoded pictures are RGBA in memory, four bytes
 * a pixel: the addon's own defaults (16 megapixels a picture, 128 MB stored) suit a desk, not a phone's
 * WebView, which a tab past its memory share is reloaded from. Past the stored cap the oldest picture
 * goes first; one larger than the pixel cap is not drawn at all.
 */
export function terminalImageOptions(coarse: boolean): IImageAddonOptions {
  return coarse
    ? { pixelLimit: 2048 * 2048, storageLimit: 16, sixelSizeLimit: 8_000_000, iipSizeLimit: 8_000_000 }
    : { pixelLimit: 4096 * 4096, storageLimit: 64 };
}

interface Loaded {
  addon: ImageAddon;
  /** the window reports the terminal answered before the addon turned its pixel size reports on */
  windowOptions: Terminal["options"]["windowOptions"];
  /** whether the setting is on for it now */
  enabled: boolean;
  /** drops a multipart iTerm2 picture still coming in (lib/itermPictures.ts) */
  resetPictures(): void;
}

/**
 * Registers an OSC handler that is fed a payload piece by piece on xterm's own parser, as the addon does.
 * xterm's public handlers take the payload as one string and are not called for one past 10,000,000
 * characters: such a picture went past them. Null where the parser is not where xterm 6 keeps it.
 */
export function registerOscStream(terminal: Terminal, ident: number, handler: OscStreamHandler): IDisposable | null {
  type Parser = { registerOscHandler?(ident: number, handler: OscStreamHandler): IDisposable };
  const parser = (terminal as unknown as { _core?: { _inputHandler?: { _parser?: Parser } } })._core?._inputHandler?._parser;
  return typeof parser?.registerOscHandler === "function" ? parser.registerOscHandler(ident, handler) : null;
}

const SWALLOW: OscStreamHandler = { start() {}, put() {}, end: () => true };

/**
 * The addon's own iTerm2 decoder, fed a whole `File=` payload as the parser would feed it: the addon has
 * no public way in, and lib/itermPictures.ts hands it the pictures it cannot read as they came. Null
 * where an addon of another version keeps it elsewhere: those pictures are then left to the addon.
 */
function iipFeed(addon: ImageAddon): PictureFeed | null {
  const iip = (addon as unknown as { _handlers?: Map<string, Partial<OscStreamHandler>> })._handlers?.get("iip");
  if (typeof iip?.start !== "function" || typeof iip.put !== "function" || typeof iip.end !== "function") return null;
  const handler = iip as OscStreamHandler;
  const chunk = new Uint32Array(0x10000);
  return (payload) => {
    handler.start();
    for (let at = 0; at < payload.length; at += chunk.length) {
      const end = Math.min(payload.length, at + chunk.length);
      for (let i = at; i < end; i++) chunk[i - at] = payload.charCodeAt(i);
      handler.put(chunk, 0, end - at);
    }
    return handler.end(true);
  };
}

/**
 * One addon for a terminal's whole life, loaded the first time pictures are on. A cell keeps the id of
 * the picture drawn in it, and a new addon numbers its pictures from 1 again: loaded anew after being
 * disposed, it drew its first picture into every cell an old picture 1 had left.
 */
const loaded = new WeakMap<Terminal, Loaded>();

/** output held for a terminal until its pictures are decided (holdForPictures), with what resumes it */
const holding = new WeakMap<Terminal, { resumes: Array<() => void>; timer: ReturnType<typeof setTimeout> }>();
/** the addon's chunk did not load: no output waits for it again */
let unavailable = false;
/**
 * How long output waits for the addon's chunk: a stalled fetch (a phone on a slow link) must not stop the
 * pane. The mount acknowledges what waits, so the server's flow control (server/output-window.ts) does not
 * take the wait for a reader that stopped.
 */
const PICTURES_WAIT_MS = 1000;
/** terminals that waited that long once: their output no longer waits, a picture before the addon is lost */
const waitedOut = new WeakSet<Terminal>();
const release = (terminal: Terminal): void => {
  const held = holding.get(terminal);
  if (held === undefined) return;
  holding.delete(terminal);
  clearTimeout(held.timer);
  for (const resume of held.resumes) resume();
};

/**
 * Output that may hold a picture (an OSC 1337 or a DCS, sixel's form) waits for the addon: xterm drops a
 * picture parsed before it, and with no choice stored the addon loads only once the server listed its
 * features, as the first output comes (#3184). True when `resume` is called once useTerminalImages has
 * turned pictures on or off for this terminal, or once PICTURES_WAIT_MS passed; false when nothing need wait.
 */
/**
 * A DCS or an OSC 1337, or a frame ending inside an OSC 1337's introducer (split across two frames). A frame
 * ending in a bare ESC does not wait: most are a key sequence's first byte, and a DCS split there is rare.
 */
const PICTURE_START = /\x1bP|1337;|\x1b\](?:1(?:3(?:37?)?)?)?$/;

export function holdForPictures(terminal: Terminal, data: string, resume: () => void): boolean {
  if (unavailable || waitedOut.has(terminal) || loaded.get(terminal)?.enabled === true || !PICTURE_START.test(data)) return false;
  const held = holding.get(terminal);
  if (held) held.resumes.push(resume);
  else holding.set(terminal, { resumes: [resume], timer: setTimeout(() => { waitedOut.add(terminal); release(terminal); }, PICTURES_WAIT_MS) });
  return true;
}

/** Build-time constant: on only in the browser lane's demo build (lib/crashProbe.ts). */
declare const __HERDR_TEST_HOOKS__: boolean;

/** the colour at a picture's top left corner, for the browser scripts' probe */
function pictureColour(picture: CanvasImageSource | undefined): number[] | null {
  if (picture === undefined) return null;
  const canvas = document.createElement("canvas");
  canvas.width = 1;
  canvas.height = 1;
  const context = canvas.getContext("2d")!;
  context.drawImage(picture, 0, 0);
  return [...context.getImageData(0, 0, 1, 1).data.slice(0, 3)];
}

const SIZE_REPORTS = { getWinSizePixels: true, getCellSizePixels: true, getWinSizeChars: true };

/**
 * Settings -> Terminal -> Pictures in the terminal: draws sixel and iTerm2 inline images (imgcat,
 * img2sixel, chafa, yazi) with xterm's image addon, loaded only once the setting is on. It does not
 * draw kitty's graphics protocol. The pictures reach the tab only where the attach stream carries
 * them: herdr-core passes a pane's output on as it is, herdr draws the pane from its own grid again
 * and drops them; a pane drawn again (attached anew) comes back without its pictures either way.
 */
/** whether xterm draws iTerm2 and sixel pictures in this terminal (Pictures in the terminal is on and loaded) */
export function terminalDrawsPictures(terminal: Terminal): boolean {
  return loaded.get(terminal)?.enabled === true;
}

export function useTerminalImages(terminal: Terminal | null, enabled: boolean, coarse: boolean): void {
  // the addon takes the caps of the pointer at the moment it loads, not at the moment its import began
  const coarseRef = useRef(coarse);
  coarseRef.current = coarse;
  useEffect(() => {
    if (terminal === null) return;
    const present = loaded.get(terminal);
    if (!enabled) {
      release(terminal);
      if (present === undefined) return;
      // off: its pictures go, and the next ones are taken before the addon sees them
      present.addon.reset();
      // an iTerm2 picture still decoding places itself once done: cleared again after what came before
      // (the parser waits for a decode before it reads on)
      terminal.write("", () => { if (!present.enabled) present.addon.reset(); });
      present.enabled = false;
      present.resetPictures();
      terminal.options.windowOptions = present.windowOptions;
      const swallowed: IDisposable[] = [
        terminal.parser.registerDcsHandler({ final: "q" }, () => true),
        registerOscStream(terminal, 1337, SWALLOW) ?? terminal.parser.registerOscHandler(1337, () => true),
      ];
      return () => { for (const handler of swallowed) handler.dispose(); };
    }
    if (present !== undefined) {
      present.enabled = true;
      terminal.options.windowOptions = { ...present.windowOptions, ...SIZE_REPORTS };
      release(terminal);
      return;
    }
    let gone = false;
    import("@xterm/addon-image").then(({ ImageAddon }) => {
      if (gone || loaded.has(terminal)) return;
      // the addon turns xterm's pixel size reports on (the bridge passes the cell size on to hc, which
      // answers the program with it); turned off, the terminal answers as it did before
      const windowOptions = { ...terminal.options.windowOptions };
      const options = terminalImageOptions(coarseRef.current);
      const addon = new ImageAddon(options);
      terminal.loadAddon(addon);
      // registered after the addon, so it reads each iTerm2 payload first (xterm asks the newest handler first)
      const feed = iipFeed(addon);
      const limits: PictureLimits = { sizeLimit: options.iipSizeLimit ?? 20_000_000, pixelLimit: options.pixelLimit ?? 16_777_216 };
      const pictures = feed && itermPictures(feed, () => limits);
      const entry: Loaded = { addon, windowOptions, enabled: true, resetPictures: () => pictures?.reset() };
      // xterm feeds every handler each piece and asks only at the end who takes it: while off, a payload
      // that began then is not held here
      let taking = false;
      const stream: OscStreamHandler | null = pictures && {
        start: () => { taking = entry.enabled; pictures.stream.start(); },
        put: (data, start, end) => { if (taking) pictures.stream.put(data, start, end); },
        end: (success) => pictures.stream.end(success && taking),
      };
      if (pictures && stream && !registerOscStream(terminal, 1337, stream)) terminal.parser.registerOscHandler(1337, pictures.handle);
      // XTSMGRAPHICS goes unanswered, as without the addon: hc leaves it to its viewers, and two
      // browsers on one pane answered it late, into the program's next read (measured on hc 0.1.17).
      // xterm disposes the handler with the terminal, as it does the addon.
      terminal.parser.registerCsiHandler({ prefix: "?", final: "S" }, () => true);
      loaded.set(terminal, entry);
      if (typeof __HERDR_TEST_HOOKS__ === "boolean" && __HERDR_TEST_HOOKS__ && terminal.element) {
        // browser scripts ask which picture a cell holds (never in a release build)
        Object.assign(terminal.element, { imageAt: (col: number, row: number) => pictureColour(addon.getImageAtBufferCell(col, row)) });
      }
    }, (error: unknown) => {
      unavailable = true;
      console.error("terminal pictures could not be loaded", error);
    }).finally(() => { if (!gone) release(terminal); });
    return () => {
      gone = true;
      release(terminal);
    };
    // the caps are the ones of the screen the addon was loaded on; a change of pointer moves the stored cap below
  }, [terminal, enabled]);

  useEffect(() => {
    const present = terminal === null ? undefined : loaded.get(terminal);
    if (present !== undefined) present.addon.storageLimit = terminalImageOptions(coarse).storageLimit!;
  }, [terminal, coarse]);
}
