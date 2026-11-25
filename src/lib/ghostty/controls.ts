/**
 * When libghostty alone parses a pane's output (overlay `only`), xterm still encodes the keys, paste, mouse and focus
 * reports, answers the program's questions about the terminal, places the IME's composition and its helper textarea
 * at the cursor, and hands OSC 52 to the clipboard. Those depend on a few sequences of the output and on where the
 * cursor is, not on the text. The scanner picks the sequences out of the stream, whole even when a frame splits one,
 * so xterm parses those bytes alone:
 *
 * - DEC private modes (`CSI ? … h/l`): cursor keys, bracketed paste, mouse tracking and format, focus reports, the
 *   alternate screen (which buffer xterm says is active), cursor visibility and the rest of xterm's mode flags
 * - modifyOtherKeys (`CSI > … m`), which useTerminalMount follows for Ctrl+Enter
 * - the questions xterm answers: device attributes (`CSI c`, `CSI > c`, `CSI = c`), status and cursor reports
 *   (`CSI n`, `CSI ? n`), mode reports (`CSI … $ p`), the version (`CSI > q`) and the cell and window sizes (`CSI … t`)
 * - the resets that put the modes back: RIS (`ESC c`) and DECSTR (`CSI ! p`)
 * - OSC 52 (clipboard) and the colour questions OSC 10/11/12 `?`
 *
 * Everything else (text, styles, cursor moves, hyperlinks, titles, pictures) goes to libghostty alone. xterm's cursor
 * is put where libghostty's is after each write and before each question, so a cursor report and the IME's
 * composition are where the program's cursor is.
 */

const GROUND = 0, ESC = 1, CSI = 2, OSC = 3, STRING = 4, STRING_ESC = 5, OSC_ESC = 6;
/** what xterm takes of a CSI sequence (`body` is everything after `ESC [`): "mode", "question", or nothing */
function csiKind(body: string): "mode" | "question" | null {
  const final = body.at(-1);
  const prefix = body[0];
  if (final === "p") return body === "!p" ? "mode" : body.endsWith("$p") ? "question" : null;
  // DEC private modes and ANSI ones (insert mode 4, new-line mode 20): xterm keeps both, and reports them
  if ((final === "h" || final === "l") && (prefix === "?" || /^[\d;]+[hl]$/.test(body))) return "mode";
  if (prefix === ">" && final === "m") return "mode";
  if (final === "c" || final === "n") return "question";
  if (final === "q") return prefix === ">" ? "question" : null;
  if (final === "t") return /^(14|16|18)t$/.test(body) ? "question" : null;
  return null;
}

/** A stretch of the stream up to `end` (an index in the text), with what xterm takes of it; `question` ends it. */
interface ControlPiece { readonly end: number; readonly controls: string; readonly question: string | null }

type SpanKind = "query" | "clipboard";

/** the sequences xterm takes from each piece of text, the state carried from one call to the next */
export function controlScanner(span?: (kind: SpanKind, start: number, end: number) => void) {
  let state = GROUND;
  let seq = "";
  let intro = "";
  let position = 0;
  let start = 0;
  let oscId = -1;
  let oscPayload = false;
  let streaming = false;
  // an OSC whose ESC ended a write was already ended for xterm with that ESC (xterm dispatches on the ESC)
  let escSent = false;
  const control = /[\x1b\u0090\u0098\u009b\u009d-\u009f]/g;
  const scanner = (text: string): ControlPiece[] => {
    const pieces: ControlPiece[] = [];
    let out = "";
    let at = 0;
    const length = text.length;
    const question = (data: string, end: number): void => {
      span?.("query", start, position + end);
      pieces.push({ end: Math.max(0, end), controls: out, question: data });
      out = "";
    };
    const openOsc = (): void => {
      state = OSC;
      oscId = -1;
      oscPayload = false;
      seq = "";
      // xterm's replay guard must see a candidate OSC even before its ID is complete.
      streaming = true;
      out += "\x1b]";
    };
    const endOsc = (end: number, terminator: string): void => {
      if (streaming) out += terminator;
      if (oscId === 52) span?.("clipboard", start, position + end);
      else if (oscPayload && oscId >= 10 && oscId <= 12 && seq === "?") question(`\x1b]${oscId};?\x07`, end);
      streaming = false;
      state = GROUND;
    };
    while (at < length) {
      if (state === GROUND) {
        control.lastIndex = at;
        const next = control.exec(text);
        if (!next) break;
        at = next.index;
      }
      const ch = text.charAt(at);
      const code = ch.charCodeAt(0);
      at++;
      if (state !== OSC_ESC && state !== STRING_ESC && (code === 0x1b || code === 0x90 || code === 0x98
        || code === 0x9b || code === 0x9d || code === 0x9e || code === 0x9f)) {
        if (state === OSC && code === 0x1b) { state = OSC_ESC; continue; }
        if (state === STRING && code === 0x1b) { state = STRING_ESC; continue; }
        if (state === OSC && streaming) out += "\x18";
        streaming = false;
        start = position + at - 1;
        seq = "";
        if (code === 0x1b) state = ESC;
        else if (code === 0x9b) { state = CSI; intro = ch; }
        else if (code === 0x9d) openOsc();
        else state = STRING;
        continue;
      }
      switch (state) {
        case ESC:
          if (ch === "[") { state = CSI; intro = "\x1b["; }
          else if (ch === "]") openOsc();
          else if (ch === "P" || ch === "_" || ch === "^" || ch === "X") state = STRING;
          else if (ch === "c") { out += "\x1bc"; state = GROUND; }
          // the keypad's application and numeric modes (DECKPAM, DECKPNM), which xterm keeps for its keys
          else if (ch === "=" || ch === ">") { out += `\x1b${ch}`; state = GROUND; }
          else if ((code >= 0x20 && code !== 0x7f) || code === 0x18 || code === 0x1a) state = GROUND;
          break;
        case CSI:
          if (code === 0x18 || code === 0x1a || (code >= 0x80 && code < 0xa0)) { state = GROUND; break; }
          if (code < 0x20 || code === 0x7f) break;
          seq += ch;
          if (code >= 0x40 && code <= 0x7e) {
            const kind = csiKind(seq);
            if (kind === "mode") out += intro + seq;
            else if (kind === "question") question(intro + seq, at);
            state = GROUND;
          }
          break;
        case OSC:
          if (code === 0x07 || code === 0x9c) endOsc(at, ch);
          else if (code === 0x18 || code === 0x1a) {
            if (streaming) out += ch;
            if (oscId === 52) span?.("clipboard", start, position + at);
            streaming = false;
            state = GROUND;
          } else if (code >= 0x20) {
            if (oscPayload) {
              if (seq.length < 2) seq += ch;
            } else if (ch === ";") oscPayload = true;
            else oscId = code >= 0x30 && code <= 0x39 ? Math.max(0, oscId) * 10 + code - 0x30 : NaN;
            if (streaming) {
              if (oscId === 52 || (!oscPayload && (oscId === 0 || oscId === 5))) out += ch;
              else { out += "\x18"; streaming = false; }
            }
          }
          break;
        case OSC_ESC: {
          const st = ch === "\\";
          endOsc(st ? at : at - 2, escSent ? (st ? "\\" : "") : st ? "\x1b\\" : "\x1b");
          escSent = false;
          if (!st) { start = position + at - 2; state = ESC; seq = ""; at--; }
          break;
        }
        case STRING:
          if (code === 0x9c || code === 0x18 || code === 0x1a) state = GROUND;
          break;
        case STRING_ESC:
          if (ch === "\\") state = GROUND;
          else { start = position + at - 2; state = ESC; seq = ""; at--; }
          break;
      }
    }
    // xterm ends an OSC at its ESC: a write that stops between ESC and the backslash gives xterm the ESC now, so a copy
    // is made when xterm would make it, and the backslash that follows is all that is left to send
    if (state === OSC_ESC && streaming && !escSent) { out += "\x1b"; escSent = true; }
    position += length;
    pieces.push({ end: length, controls: out, question: null });
    return pieces;
  };
  return Object.assign(scanner, {
    streaming: () => streaming,
    pending: () => state === GROUND ? null : { start, clipboard: streaming, escaped: state === OSC_ESC },
  });
}

export interface ControlsEngine {
  write(data: string | Uint8Array): void;
  screenCursor(): { x: number; y: number };
}

/**
 * The write for a terminal whose output libghostty alone parses: `engine` takes every byte, and `xterm` (its own
 * write, whose callback still acknowledges the frame) the controls the scanner picks, with its cursor put where the
 * engine's is.
 */
export function controlsWriter(engine: ControlsEngine, xterm: (data: string, callback?: () => void) => void) {
  let decoder = new TextDecoder();
  let scan = controlScanner();
  // libghostty accepts the 7-bit introducer, not the UTF-8 encoding of C1 CSI.
  const writeEngine = (text: string): void => engine.write(text.replaceAll("\u009b", "\x1b["));
  const cursorAt = (): string => { const { x, y } = engine.screenCursor(); return `\x1b[${y + 1};${x + 1}H`; };
  const write = (data: string | Uint8Array, callback?: () => void): void => {
    const text = typeof data === "string" ? data : decoder.decode(data, { stream: true });
    const pieces = scan(text);
    let out = "";
    // bytes are fed as the text decoded from them, so a character split between two writes reaches the engine once
    if (pieces.length === 1 && typeof data === "string") {
      writeEngine(data);
      out = pieces[0]!.controls;
    } else {
      // a question is answered from the cursor where the program asked it: the engine takes the text up to it first
      let from = 0;
      for (const piece of pieces) {
        writeEngine(text.slice(from, piece.end));
        from = piece.end;
        out += piece.controls;
        if (piece.question !== null) out += cursorAt() + piece.question;
      }
    }
    // xterm's cursor follows libghostty's, unless an OSC 52 it was given is still open (a CUP would end it)
    xterm(scan.streaming() ? out : out + cursorAt(), callback);
  };
  // xterm already parsed the startup controls. Seed the engine and scanner without sending them again.
  return Object.assign(write, {
    seed(data: string | Uint8Array): void {
      const text = typeof data === "string" ? data : decoder.decode(data, { stream: true });
      scan(text);
      writeEngine(text);
    },
    syncCursor(questions = ""): boolean {
      if (scan.streaming()) return false;
      xterm(cursorAt() + questions);
      return true;
    },
    reset(): void { decoder = new TextDecoder(); scan = controlScanner(); },
  });
}

export interface RetainedOutput {
  readonly data: string | Uint8Array;
  /** Raw prefix whose questions were either sent to xterm or deferred for startup. */
  sent: number;
}

export interface DeferredQuestions {
  readonly data: string;
  readonly isCurrent: () => boolean;
}

export const currentQuestions = (deferred: readonly DeferredQuestions[]): string =>
  deferred.filter(({ isCurrent }) => isCurrent()).map(({ data }) => data).join("");

/** Rebuild the screen without repeating clipboard writes or sending replies twice. */
export function fallbackOutput(chunks: readonly RetainedOutput[], questions = ""): string {
  const decoder = new TextDecoder();
  const segments: string[] = [];
  const ranges: { readonly start: number; readonly end: number }[] = [];
  let sentThrough = 0;
  let total = 0;
  const scan = controlScanner((kind, start, end) => {
    if (kind === "clipboard" || end <= sentThrough) ranges.push({ start, end });
  });
  for (const { data, sent } of chunks) {
    const prefix = data.slice(0, sent);
    const suffix = data.slice(sent);
    const seen = typeof prefix === "string" ? prefix : decoder.decode(prefix, { stream: true });
    const unseen = typeof suffix === "string" ? suffix : decoder.decode(suffix, { stream: true });
    sentThrough = total + seen.length;
    segments.push(seen, unseen);
    scan(seen + unseen);
    total += seen.length + unseen.length;
  }
  const text = segments.join("");
  const output: string[] = [];
  let from = 0;
  for (const { start, end } of ranges) {
    output.push(text.slice(from, start));
    from = end;
  }
  const pending = scan.pending();
  if (pending) {
    // Put the questions before a partial sequence so they cannot cancel it. A partial
    // clipboard payload must remain nonprinting, but must not reach a clipboard handler.
    const tail = pending.clipboard ? "\x1b]9999;" + (pending.escaped ? "\x1b" : "") : text.slice(pending.start);
    output.push(text.slice(from, pending.start), questions, tail);
  } else output.push(text.slice(from), questions);
  return output.join("");
}
