import { TERMINAL_HISTORY_LINES } from "../../shared/terminal-flow.ts";
import type { Channel, HcConnection } from "./connection.ts";

/** Asks the viewer's terminal for its colours, cursor colour and cell size; DA1 marks the end (as `hc attach` asks). */
const ASK_DISPLAY = "\x1b]10;?\x1b\\\x1b]11;?\x1b\\\x1b]12;?\x1b\\\x1b[16t\x1b[c";
/** Focus reports pick hc's active viewer, so they stay on whatever the program asks (as `hc attach` keeps them). */
const FOCUS_ON = "\x1b[?1004h";
const FOCUS_OFF = "\x1b[?1004l";
/**
 * Erases the viewer's scrollback (ED 3) and screen ahead of the history hc replays first: a viewer that kept
 * the last attach's lines (a reconnect, a recent tab coming back, a joiner's bounded replay) holds them once,
 * not once per attach. It leaves the alternate screen first, or ED 3 would clear that buffer and leave the
 * main screen's old history for the replay to double.
 */
export const CLEAR_HISTORY = "\x1b[?1049l\x1b[3J\x1b[H\x1b[2J";
/**
 * The scrollback alone, for a joiner whose bounded tail starts on the main screen: its screen stays, as a cut
 * tail of in-place updates cannot draw it again (hc has no repaint), and the tail's lines land once.
 */
export const CLEAR_JOINER_HISTORY = "\x1b[?1049l\x1b[3J";
/** One unmodified cursor or Home/End key, in either cursor mode's form. */
export const CURSOR_KEY = /^\x1b[[O]([ABCDHF])$/;
/** The key a CURSOR_KEY names, as hc's `terminal.keys` names it. */
export const CURSOR_KEY_NAMES: Record<string, string> = { A: "up", B: "down", C: "right", D: "left", H: "home", F: "end" };

type Display = { fg?: string; bg?: string; cursor?: string; cell?: [number, number] };

function rgb(body: string): string | undefined {
  const parts = /^rgb:([0-9a-f]+)\/([0-9a-f]+)\/([0-9a-f]+)$/i.exec(body);
  if (!parts) return undefined;
  return `#${parts.slice(1).map((part) => part.slice(0, 2).padEnd(2, part[0]!)).join("").toLowerCase()}`;
}

/** Ported from `hc attach`'s take_replies. */
export function takeReplies(input: string, display: Display): { rest: string; focus: boolean[] } {
  let rest = "";
  const focus: boolean[] = [];
  let at = 0;
  while (at < input.length) {
    const tail = input.slice(at);
    const osc = /^\x1b\](1[012]);([^\x07\x1b]*)(?:\x07|\x1b\\)/.exec(tail);
    if (osc) {
      const color = rgb(osc[2]!);
      if (osc[1] === "10") display.fg = color;
      else if (osc[1] === "11") display.bg = color;
      else display.cursor = color;
      at += osc[0].length;
      continue;
    }
    const cell = /^\x1b\[6;(\d+);(\d+)t/.exec(tail);
    if (cell) {
      display.cell = [Number(cell[2]), Number(cell[1])];
      at += cell[0].length;
      continue;
    }
    const da1 = /^\x1b\[\?[\d;]*c/.exec(tail);
    if (da1) {
      at += da1[0].length;
      continue;
    }
    if (tail.startsWith("\x1b[I") || tail.startsWith("\x1b[O")) {
      focus.push(tail[2] === "I");
      at += 3;
      continue;
    }
    rest += input[at];
    at++;
  }
  return { rest, focus };
}

export interface CoreAttachOptions {
  hc: HcConnection;
  terminal: string;
  cols: number;
  rows: number;
  onData: (data: string) => void;
  onExit: (code: number | null) => void;
}

/**
 * It answers the calls the server makes on a PtySession:
 * keystrokes are DATA, a size is hc's RESIZE, and pausing holds back hc's credit, which stops the
 * stream once hc's window is spent.
 *
 * The viewer keeps the scrollback (`terminal-history`): each attach starts with the terminal's last
 * TERMINAL_HISTORY_LINES lines, main screen only, as `hc attach --history` shows them.
 */
export class CoreAttachSession {
  /** goes ahead of a joiner's cut main-screen replay, which lost the first attach's CLEAR_HISTORY */
  readonly replayPrefix = CLEAR_JOINER_HISTORY;
  readonly exited: Promise<void>;
  private channel: Channel | null = null;
  private closed = false;
  private paused = false;
  private owed = 0;
  private typed: { data: string; automatic: boolean }[] = [];
  private display: Display = {};
  private sentDisplay = "{}";
  /**
   * Asks ASK_DISPLAY, and turns focus reports on with it only on attach: xterm.js answers every
   * `ESC[?1004h` with a focus report, so turning them on again for each focus-in made every focused
   * viewer answer the others' focus-in, endlessly (#2815).
   */
  private readonly ask: (focusOn?: boolean) => void;
  private cols: number;
  private rows: number;
  private readonly end: (code: number | null) => void;
  /**
   * The program's cursor mode (DECCKM) as hc's stream last said. The viewer's terminal learns it a link's round trip
   * later: a key typed in between was encoded in the old mode.
   */
  private applicationCursor = false;
  /** where hc's stream stands in a sequence that may change the cursor mode, carried from frame to frame */
  private modeParse: "ground" | "escape" | "csi" | "private" | "bang" = "ground";
  private modeParams = "";

  constructor(options: CoreAttachOptions) {
    this.cols = options.cols;
    this.rows = options.rows;
    this.ask = (focusOn = false) => options.onData((focusOn ? FOCUS_ON : "") + ASK_DISPLAY);
    const { promise, resolve } = Promise.withResolvers<void>();
    this.exited = promise;
    const decoder = new TextDecoder();
    let ended = false;
    let first = true;
    this.end = (code) => {
      if (ended) return;
      ended = true;
      this.closed = true;
      const tail = decoder.decode();
      if (tail) options.onData(tail);
      options.onExit(code);
      resolve();
    };
    options.hc.open("terminal.attach", { terminal: options.terminal, cols: options.cols, rows: options.rows, history: TERMINAL_HISTORY_LINES }, {
      credit: "manual",
      onData: (payload) => {
        this.owed += payload.length;
        this.settle();
        let text = decoder.decode(payload, { stream: true });
        this.trackCursorMode(text);
        if (text && first) {
          first = false;
          text = CLEAR_HISTORY + text;
        }
        // a program turning focus reports off would leave hc without this viewer's focus
        if (text) options.onData(text.includes(FOCUS_OFF) ? text + FOCUS_ON : text);
      },
      onClose: (reason) => this.end(typeof reason?.["exit_code"] === "number" ? reason["exit_code"] : null),
    }).then(({ channel }) => {
      if (this.closed) {
        void channel.close().then(() => this.end(null));
        return;
      }
      this.channel = channel;
      if (this.cols !== options.cols || this.rows !== options.rows) channel.resize(this.cols, this.rows);
      for (const { data, automatic } of this.typed) this.send(data, automatic);
      this.typed = [];
      this.settle();
      this.report();
      // the viewer's terminal answers through write(), as it answered `hc attach`
      this.ask(true);
    }, (error: unknown) => {
      // the old `hc attach` printed why in the pane; the server log is where it goes now
      console.error(`herdr-core attach for ${options.terminal} failed: ${error instanceof Error ? error.message : String(error)}`);
      this.end(null);
    });
  }

  /**
   * `automatic`: the viewer's terminal made these bytes itself (a query's answer), nobody typed them.
   * The tag comes from a client, so it holds only for what a reply looks like: escape sequences with
   * no line break. Anything else (a command and its Enter) goes as typing, whatever the client says.
   */
  write(data: string, automatic = false): boolean {
    if (this.closed) return false;
    automatic &&= /^\x1b[^\r\n]*$/.test(data);
    const { rest, focus } = takeReplies(data, this.display);
    this.report();
    for (const focused of focus) {
      this.channel?.focus(focused);
      if (focused) this.ask();
    }
    if (!rest) return true;
    // a lone cursor key goes in the form the program reads now, whichever the viewer's terminal still believed in
    const key = automatic ? null : CURSOR_KEY.exec(rest);
    const typed = key ? `${this.applicationCursor ? "\x1bO" : "\x1b["}${key[1]}` : rest;
    if (this.channel) this.send(typed, automatic);
    else this.typed.push({ data: typed, automatic });
    return true;
  }

  /**
   * Follows DECCKM as xterm does: `CSI ? … 1 … h/l` with 1 a top-level parameter (`?01h` too, `?1004:1h` is mode
   * 1004's), and the resets that put it back to normal mode, RIS (`ESC c`) and DECSTR (`CSI ! p`).
   */
  private trackCursorMode(text: string): void {
    let at = this.modeParse === "ground" ? text.indexOf("\x1b") : 0;
    while (at !== -1 && at < text.length) {
      const char = text[at]!;
      if (char === "\x1b") this.modeParse = "escape";
      else {
        switch (this.modeParse) {
          case "ground":
            break;
          case "escape":
            if (char === "c") this.applicationCursor = false;
            this.modeParse = char === "[" ? "csi" : "ground";
            break;
          case "csi":
            this.modeParams = "";
            this.modeParse = char === "?" ? "private" : char === "!" ? "bang" : "ground";
            break;
          case "bang":
            if (char === "p") this.applicationCursor = false;
            this.modeParse = "ground";
            break;
          case "private":
            if (/[\d;:]/.test(char)) {
              if (this.modeParams.length < 256) this.modeParams += char;
              break;
            }
            if ((char === "h" || char === "l") && this.modeParams.split(";").some((param) => /^\d+$/.test(param) && Number(param) === 1)) {
              this.applicationCursor = char === "h";
            }
            this.modeParse = "ground";
            break;
        }
      }
      at = this.modeParse === "ground" ? text.indexOf("\x1b", at + 1) : at + 1;
    }
  }

  private send(data: string, automatic: boolean): void {
    if (automatic) this.channel!.writeAutomatic(data);
    else this.channel!.write(data);
  }

  resize(cols: number, rows: number): void {
    this.cols = cols;
    this.rows = rows;
    this.channel?.resize(cols, rows);
  }

  /**
   * Nothing to do: `hc attach` sends RESIZE only when its grid changed, and a same-size RESIZE would
   * make this viewer the active one, taking the size from whoever works in the terminal.
   */
  winch(): void {}

  /**
   * Whether the cursor mode this attach parsed is hc's latest: while the stream is paused (a viewer behind on output
   * holds hc's credit back), hc may hold output that changed the mode, and only hc's `terminal.keys` reads it.
   */
  get modeCurrent(): boolean {
    return !this.paused;
  }

  pause(): void {
    this.paused = true;
  }

  resume(): void {
    this.paused = false;
    this.settle();
  }

  /**
   * Detaches; `exited` settles when `Channel.close` does. When hc answered, a next attach cannot
   * overlap this one; when the close gave up after 10 s with no answer, it may.
   */
  kill(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.channel) void this.channel.close().then(() => this.end(null));
  }

  /** As `kill`: hc reads the close after what was typed, both going over the one connection in the order written. */
  leave(): void {
    this.kill();
  }

  private report(): void {
    const json = JSON.stringify(this.display);
    if (!this.channel || json === this.sentDisplay) return;
    this.sentDisplay = json;
    this.channel.facts(this.display);
  }

  private settle(): void {
    if (this.paused || !this.channel || this.owed === 0) return;
    this.channel.credit(this.owed);
    this.owed = 0;
  }
}
