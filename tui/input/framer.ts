import { ESC_WAIT_MS, ESC_WAIT_SLOW_MS, PASTE_LIMIT_BYTES, REPLY_WAIT_MS, SEQUENCE_DROP_MS, SEQUENCE_LIMIT_BYTES } from "../model/deadlines.ts";
import { decodeControl, decodeCsi, decodeLinuxFunction, decodeSs3, decodeString, typedKey, withAlt, type InputEvent, type Unstamped } from "./decode.ts";

/** What the host terminal was set up with, as far as it changes how its bytes are cut. */
interface HostModes {
  /** mouse reporting is on */
  mouse: boolean;
  /** the host answered that the kitty keyboard flag is on: its `CSI u` keys are kitty's */
  kitty: boolean;
  /** the tty's erase character is ^H, so 0x08 is Backspace rather than ctrl+h */
  eraseIsCtrlH: boolean;
}

type State = "ground" | "esc" | "csi" | "ss3" | "string" | "paste" | "utf8";

const ESC = 0x1b;
const PASTE_START = "200";
const PASTE_END = Uint8Array.from("\x1b[201~", (char) => char.charCodeAt(0));
const STRING_KINDS: Readonly<Record<number, "osc" | "dcs" | "apc">> = { 0x5d: "osc", 0x50: "dcs", 0x5f: "apc" };
/** the bytes of an X10 mouse report after `CSI M` */
const X10_REPORT_BYTES = 3;

const latin1 = (bytes: readonly number[]): string => String.fromCharCode(...bytes);
// U+FEFF is a character someone typed or pasted: a host terminal's input starts with no byte order mark
const utf8 = new TextDecoder("utf-8", { ignoreBOM: true });

/** A bracketed paste read so far: its chunks, their size, whether it is refused, and how much of the end mark matched. */
const emptyPaste = () => ({ chunks: [] as Uint8Array[], size: 0, refused: false, endMatched: 0 });

/** How many continuation bytes a UTF-8 lead byte announces; 0 for a byte no character starts with. */
function continuationCount(lead: number): number {
  if (lead >= 0xc2 && lead <= 0xdf) return 1;
  if (lead >= 0xe0 && lead <= 0xef) return 2;
  if (lead >= 0xf0 && lead <= 0xf4) return 3;
  return 0;
}

/** The range the first continuation byte must fall in, which rules out overlong forms, surrogates and code points past U+10FFFF. */
function firstContinuation(lead: number): [number, number] {
  if (lead === 0xe0) return [0xa0, 0xbf];
  if (lead === 0xed) return [0x80, 0x9f];
  if (lead === 0xf0) return [0x90, 0xbf];
  if (lead === 0xf4) return [0x80, 0x8f];
  return [0x80, 0xbf];
}

/**
 * Cuts the bytes the host terminal sends into input events. It owns every wait of host input but reads
 * no clock: the caller passes its time with each read (`feed`), asks when the next wait ends
 * (`deadline`) and calls `tick` then. A read may end anywhere, inside a character or a sequence; the
 * events are the same however the bytes were cut, as long as no wait passes between the reads.
 * - A read that ends in a lone ESC or in an introducer alone (`ESC [`, `ESC O`, or `ESC ]`, `ESC P` or `ESC _`, which
 *   start a string) waits ESC_WAIT_MS (ESC_WAIT_SLOW_MS while the host reports the mouse or has the kitty flag on) for
 *   the rest, then gives Escape or the Alt key that sends those bytes: Alt+[, Alt+O, Alt+], Alt+P or Alt+_.
 * - A longer unfinished sequence never becomes a key: it is dropped as `unknown` SEQUENCE_DROP_MS after
 *   its first byte. An ESC read last inside an unfinished string is not dropped with it: it keeps its
 *   stamp and goes on as an ESC of its own.
 * - An unfinished UTF-8 character waits for the next read, however late, and is never split.
 * - A bracketed paste is one event; no wait ends it. Once it passes PASTE_LIMIT_BYTES it is refused whole
 *   at once, and the rest of it is swallowed up to its end mark; if that mark never comes, `reset` ends it.
 * - A reply's shape gives a `reply` only while the start probe waits (`expectReplies`), else `unknown`.
 */
export class Framer {
  private modes: HostModes = { mouse: false, kitty: false, eraseIsCtrlH: false };
  private state: State = "ground";
  private out: InputEvent[] = [];
  /** the next wait of a sequence in progress, an ESC or a longer one */
  private pending: number | undefined;
  private replyUntil: number | undefined;
  /** the bytes of the sequence in progress, at most SEQUENCE_LIMIT_BYTES of them */
  private seq: number[] = [];
  /** the sequence in progress outgrew SEQUENCE_LIMIT_BYTES, so its bytes are not all kept */
  private cutShort = false;
  private seqAt = 0;
  private stringKind: "osc" | "dcs" | "apc" = "osc";
  /** an ESC inside a string, which ends it when a backslash follows */
  private stringEscAt: number | undefined;
  /** bytes still to come after a CSI that a fixed number of raw bytes follow: an X10 mouse report, a Linux console key */
  private trailLeft = 0;
  private trailKind: "x10" | "linux" = "x10";
  private text: number[] = [];
  private textAt = 0;
  private char: number[] = [];
  private charAt = 0;
  private charNeed = 0;
  private charAlt = false;
  private paste = emptyPaste();

  setModes(modes: Partial<HostModes>): void {
    this.modes = { ...this.modes, ...modes };
  }

  /**
   * Drops what is in progress (a paste, a sequence, a cut character) and its wait, for a caller that
   * must get the keyboard back, such as after a paste whose end mark never came. Host modes and the
   * probe's wait stay.
   */
  reset(): void {
    this.ground();
    this.paste = emptyPaste();
    this.pending = undefined;
  }

  /** The start probe was sent at `now`: replies are read until its DA1 reply comes or REPLY_WAIT_MS pass. */
  expectReplies(now: number): void {
    this.replyUntil = now + REPLY_WAIT_MS;
  }

  /** When `tick` must next be called; undefined when no wait runs. */
  deadline(): number | undefined {
    if (this.pending === undefined) return this.replyUntil;
    if (this.replyUntil === undefined) return this.pending;
    return Math.min(this.pending, this.replyUntil);
  }

  /** The events of one read made at `now`, after those of any wait that ended by then. */
  feed(bytes: Uint8Array, now: number): InputEvent[] {
    this.expire(now);
    for (let i = 0; i < bytes.length;) {
      if (this.state === "paste") i = this.pasteBytes(bytes, i);
      else this.step(bytes[i++]!, now);
    }
    this.flushText();
    this.arm(now);
    return this.take();
  }

  tick(now: number): InputEvent[] {
    this.expire(now);
    return this.take();
  }

  private take(): InputEvent[] {
    const events = this.out;
    this.out = [];
    return events;
  }

  private emit(event: Unstamped, at: number): void {
    this.flushText();
    this.out.push({ ...event, at } as InputEvent);
    if (event.type === "reply" && event.kind === "deviceAttributes") this.replyUntil = undefined;
  }

  private emitUnknown(bytes: readonly number[], at: number): void {
    this.emit({ type: "unknown", raw: latin1(bytes) }, at);
  }

  private flushText(): void {
    if (!this.text.length) return;
    this.out.push({ type: "text", text: utf8.decode(Uint8Array.from(this.text)), at: this.textAt });
    this.text = [];
  }

  private pushText(bytes: readonly number[], at: number): void {
    if (!this.text.length) this.textAt = at;
    this.text.push(...bytes);
  }

  private begin(state: State, bytes: number[], at: number): void {
    this.state = state;
    this.seq = bytes;
    this.seqAt = at;
    this.cutShort = false;
  }

  private keep(byte: number): void {
    if (this.seq.length < SEQUENCE_LIMIT_BYTES) this.seq.push(byte);
    else this.cutShort = true;
  }

  private ground(): void {
    this.state = "ground";
    this.seq = [];
    this.cutShort = false;
    this.stringEscAt = undefined;
    this.trailLeft = 0;
  }

  /** One byte outside a paste. A handler that answers false ended its sequence in ground, where the byte is read again. */
  private step(byte: number, now: number): void {
    switch (this.state) {
      case "esc": return this.onEsc(byte, now);
      case "utf8": if (this.onUtf8(byte)) return; break;
      case "csi": if (this.onCsi(byte)) return; break;
      case "ss3": if (this.onSs3(byte)) return; break;
      case "string": if (this.onString(byte, now)) return; break;
    }
    this.onGround(byte, now);
  }

  private onGround(byte: number, now: number): void {
    if (byte >= 0x20 && byte < 0x7f) this.pushText([byte], now);
    else if (byte === ESC) this.begin("esc", [byte], now);
    else if (byte < 0x80) this.emit(decodeControl(byte, this.modes.eraseIsCtrlH), now);
    else if (continuationCount(byte)) this.beginChar(byte, now, false);
    else this.emitUnknown([byte], now);
  }

  private beginChar(lead: number, at: number, alt: boolean): void {
    this.state = "utf8";
    this.char = [lead];
    this.charAt = at;
    this.charNeed = continuationCount(lead);
    this.charAlt = alt;
  }

  private onEsc(byte: number, now: number): void {
    const at = this.seqAt;
    const kind = STRING_KINDS[byte];
    if (byte === ESC) {
      this.emit(typedEscape, at);
      this.begin("esc", [byte], now);
    } else if (byte === 0x5b) {
      this.keep(byte);
      this.state = "csi";
    } else if (byte === 0x4f) {
      this.keep(byte);
      this.state = "ss3";
    } else if (kind) {
      this.keep(byte);
      this.state = "string";
      this.stringKind = kind;
    } else if (byte >= 0x20 && byte < 0x7f) {
      this.ground();
      this.emit(typedKey(String.fromCharCode(byte), { alt: true }), at);
    } else if (byte < 0x80) {
      this.ground();
      this.emit(withAlt(decodeControl(byte, this.modes.eraseIsCtrlH)), at);
    } else if (continuationCount(byte)) {
      this.seq = [];
      this.beginChar(byte, at, true);
    } else {
      this.ground();
      this.emitUnknown([ESC, byte], at);
    }
  }

  /** Returns false when `byte` cut the character short and must be read again in ground. */
  private onUtf8(byte: number): boolean {
    const [low, high] = this.char.length === 1 ? firstContinuation(this.char[0]!) : [0x80, 0xbf];
    const prefix = this.charAlt ? [ESC] : [];
    if (byte < low || byte > high) {
      this.ground();
      this.emitUnknown([...prefix, ...this.char], this.charAt);
      return false;
    }
    this.char.push(byte);
    if (this.char.length <= this.charNeed) return true;
    this.ground();
    if (this.charAlt) this.emit(typedKey(utf8.decode(Uint8Array.from(this.char)), { alt: true }), this.charAt);
    else this.pushText(this.char, this.charAt);
    return true;
  }

  private onCsi(byte: number): boolean {
    if (this.trailLeft > 0) return this.onTrailing(byte);
    // rxvt ends a shifted `CSI n ~` key with `$`, which ECMA-48 counts as an intermediate byte
    if (byte === 0x24 && !this.cutShort && /^\d+$/.test(latin1(this.seq.slice(2)))) {
      const body = latin1(this.seq.slice(2));
      this.keep(byte);
      this.finish(decodeCsi(body, "$", this.replyUntil !== undefined, this.modes.kitty));
      return true;
    }
    if (byte >= 0x20 && byte <= 0x3f) {
      this.keep(byte);
      return true;
    }
    if (byte < 0x40 || byte > 0x7e) {
      this.finish(undefined);
      return false;
    }
    this.keep(byte);
    const body = latin1(this.seq.slice(2, -1));
    const final = String.fromCharCode(byte);
    if (this.cutShort) this.finish(undefined);
    else if (body === "" && final === "M") this.trail("x10", X10_REPORT_BYTES);
    else if (body === "" && final === "[") this.trail("linux", 1);
    else if (body === PASTE_START && final === "~") this.beginPaste();
    else this.finish(decodeCsi(body, final, this.replyUntil !== undefined, this.modes.kitty));
    return true;
  }

  private trail(kind: "x10" | "linux", count: number): void {
    this.trailKind = kind;
    this.trailLeft = count;
  }

  /** The raw bytes after `CSI M` (any three) or the Linux console's `CSI [` (one final byte); a key never turns into text. */
  private onTrailing(byte: number): boolean {
    if (this.trailKind === "x10") {
      this.keep(byte);
      if (--this.trailLeft === 0) this.finish(undefined);
      return true;
    }
    if (byte < 0x40 || byte > 0x7e) {
      this.finish(undefined);
      return false;
    }
    this.keep(byte);
    this.finish(decodeLinuxFunction(String.fromCharCode(byte)));
    return true;
  }

  private onSs3(byte: number): boolean {
    if (byte < 0x40 || byte > 0x7e) {
      this.finish(undefined);
      return false;
    }
    this.keep(byte);
    this.finish(decodeSs3(String.fromCharCode(byte)));
    return true;
  }

  private onString(byte: number, now: number): boolean {
    if (this.stringEscAt !== undefined) {
      const escAt = this.stringEscAt;
      if (byte === 0x5c) {
        this.keep(ESC);
        this.keep(byte);
        this.finishString(2);
        return true;
      }
      this.finish(undefined);
      this.begin("esc", [ESC], escAt);
      this.onEsc(byte, now);
      return true;
    }
    if (byte === ESC) {
      this.stringEscAt = now;
      return true;
    }
    this.keep(byte);
    if (byte === 0x07) this.finishString(1);
    return true;
  }

  private finishString(terminator: number): void {
    const body = latin1(this.seq.slice(2, this.seq.length - terminator));
    this.finish(this.cutShort ? undefined : decodeString(this.stringKind, body, this.replyUntil !== undefined));
  }

  private finish(event: Unstamped | undefined): void {
    const bytes = this.seq, at = this.seqAt;
    this.ground();
    if (event) this.emit(event, at);
    else this.emitUnknown(bytes, at);
  }

  private beginPaste(): void {
    this.state = "paste";
    this.seq = [];
    this.paste = emptyPaste();
  }

  /** Reads paste bytes from `i` on and returns where it stopped: at the end of the read or after the end mark. */
  private pasteBytes(bytes: Uint8Array, i: number): number {
    const paste = this.paste;
    while (i < bytes.length) {
      if (paste.endMatched > 0) {
        if (bytes[i] === PASTE_END[paste.endMatched]) {
          i++;
          if (++paste.endMatched === PASTE_END.length) {
            this.endPaste();
            return i;
          }
          continue;
        }
        // not the end mark after all: what looked like its start was data
        this.pasteData(PASTE_END.subarray(0, paste.endMatched));
        paste.endMatched = 0;
      }
      const esc = bytes.indexOf(ESC, i);
      const stop = esc === -1 ? bytes.length : esc;
      if (stop > i) this.pasteData(bytes.subarray(i, stop));
      if (esc === -1) return bytes.length;
      paste.endMatched = 1;
      i = esc + 1;
    }
    return i;
  }

  private pasteData(data: Uint8Array): void {
    const paste = this.paste;
    if (paste.refused) return;
    paste.size += data.length;
    if (paste.size <= PASTE_LIMIT_BYTES) {
      // a copy: the caller may reuse its buffer once feed returns, and a Buffer's slice() shares it
      paste.chunks.push(new Uint8Array(data));
      return;
    }
    paste.refused = true;
    paste.chunks = [];
    this.emit({ type: "paste", text: "", complete: false }, this.seqAt);
  }

  private endPaste(): void {
    const { chunks, refused } = this.paste;
    const at = this.seqAt;
    this.paste = emptyPaste();
    this.ground();
    if (!refused) this.emit({ type: "paste", text: utf8.decode(Buffer.concat(chunks)), complete: true }, at);
  }

  /** Only the introducer of a CSI, an SS3 or a string is read, nothing after it: the bytes a lone Alt key also sends. */
  private introducerOnly(): boolean {
    if (this.seq.length !== 2) return false;
    return this.state === "csi" || this.state === "ss3" || (this.state === "string" && this.stringEscAt === undefined);
  }

  private escWait(): number {
    return this.modes.mouse || this.modes.kitty ? ESC_WAIT_SLOW_MS : ESC_WAIT_MS;
  }

  /** Sets the wait a read leaves behind: the Esc wait after a lone ESC, `ESC [` or `ESC O`, the drop wait inside a longer sequence. */
  private arm(now: number): void {
    const introducerOnly = this.state === "esc" || this.introducerOnly();
    if (introducerOnly) this.pending = now + this.escWait();
    else if (this.state === "csi" || this.state === "string") this.pending = this.seqAt + SEQUENCE_DROP_MS;
    else this.pending = undefined;
  }

  /** Ends every wait that ran out by `now`, the earlier first. */
  private expire(now: number): void {
    for (;;) {
      const pending = this.pending !== undefined && this.pending <= now ? this.pending : undefined;
      const replies = this.replyUntil !== undefined && this.replyUntil <= now ? this.replyUntil : undefined;
      if (pending !== undefined && (replies === undefined || pending <= replies)) {
        this.pending = undefined;
        this.flushSequence();
      } else if (replies !== undefined) {
        this.replyUntil = undefined;
        this.emit({ type: "reply", kind: "timeout", data: "" }, replies);
      } else return;
    }
  }

  /**
   * A sequence its wait ended: an introducer alone is a key, anything longer is dropped. The ESC a read
   * ended in inside a string is not part of the string: it keeps its stamp and waits as a lone ESC does,
   * from that read, so what follows it is read with it.
   */
  private flushSequence(): void {
    const at = this.seqAt;
    if (this.state === "esc") {
      this.ground();
      this.emit(typedEscape, at);
    } else if (this.introducerOnly()) {
      const char = String.fromCharCode(this.seq[1]!);
      this.ground();
      this.emit(typedKey(char, { alt: true }), at);
    } else if (this.state === "string" && this.stringEscAt !== undefined) {
      const escAt = this.stringEscAt;
      this.finish(undefined);
      this.begin("esc", [ESC], escAt);
      this.pending = escAt + this.escWait();
    } else if (this.state === "csi" || this.state === "string") {
      this.finish(undefined);
    }
  }
}

const typedEscape: Unstamped = { type: "key", key: "ESCAPE", mods: {}, action: "press" };
