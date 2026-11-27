/**
 * The parser hooks of a terminal libghostty alone parses (terminal.ts), shaped as xterm.js's `term.parser`, which the
 * mount registers on: a hook sees a CSI, DCS or OSC sequence when the stream reaches it, in parse order, and one that
 * answers true takes the sequence, which the engine then never sees (a query left unanswered, a copy the mount made
 * itself, a hyperlink not drawn). The rest of the stream goes to the engine as it comes: only a sequence some hook
 * may take is held until it ends, so a long picture (an APC, or a DCS no hook names) is never gathered here.
 */

export interface HookDisposable { dispose(): void }
export type HookParams = (number | number[])[];
/** xterm's function identifier: an optional private prefix (`?`, `>`, `<`, `=`), intermediates, and the final byte */
export interface SequenceId { readonly prefix?: string; readonly intermediates?: string; readonly final: string }

/** The current OSC identifier and whether its payload has started. */
export interface OscStringState { readonly open: boolean; readonly idComplete: boolean; readonly id: number }

/** a hooked payload past this is dropped unread, as xterm's OSC and DCS parsers drop one past their limit */
const PAYLOAD_MAX = 10_000_000;

const GROUND = 0, ESC = 1, CSI = 2, OSC = 3, DCS_HEAD = 4, DCS = 5, STRING = 6, CSI_IGNORE = 7;
/** C1 introducers, which begin a sequence anywhere: one inside another ends that one, as in xterm's parser */
const C1_INTRODUCERS = new Set([0x90, 0x98, 0x9b, 0x9d, 0x9e, 0x9f]);

const idKey = (id: SequenceId): string => `${id.prefix ?? ""}|${id.intermediates ?? ""}|${id.final}`;

/** xterm's params: `;` separates, `:` makes sub-params of the one before; an empty one is 0 */
export function parseParams(text: string): HookParams {
  if (text === "") return [0];
  return text.split(";").map((param) => {
    const parts = param.split(":").map((part) => (part === "" ? 0 : Math.min(Number.parseInt(part, 10) || 0, 0x7fffffff)));
    return parts.length === 1 ? parts[0]! : parts;
  });
}

export class ParserHooks {
  private readonly csi = new Map<string, ((params: HookParams) => boolean)[]>();
  private readonly dcs = new Map<string, ((data: string, params: HookParams) => boolean)[]>();
  private readonly osc = new Map<number, ((data: string) => boolean)[]>();

  registerCsiHandler(id: SequenceId, handler: (params: HookParams) => boolean): HookDisposable {
    return add(this.csi, idKey(id), handler);
  }

  registerDcsHandler(id: SequenceId, handler: (data: string, params: HookParams) => boolean): HookDisposable {
    return add(this.dcs, idKey(id), handler);
  }

  registerOscHandler(ident: number, handler: (data: string) => boolean): HookDisposable {
    return add(this.osc, ident, handler);
  }

  hasCsi(key: string): boolean { return (this.csi.get(key)?.length ?? 0) > 0; }
  hasDcs(key: string): boolean { return (this.dcs.get(key)?.length ?? 0) > 0; }
  hasOsc(id: number): boolean { return (this.osc.get(id)?.length ?? 0) > 0; }

  /** the newest handler first, as xterm calls them: the first that answers true takes the sequence */
  runCsi(key: string, params: HookParams): boolean { return run(this.csi.get(key), (handler) => handler(params)); }
  runDcs(key: string, data: string, params: HookParams): boolean { return run(this.dcs.get(key), (handler) => handler(data, params)); }
  runOsc(id: number, data: string): boolean { return run(this.osc.get(id), (handler) => handler(data)); }
}

function add<K, H>(map: Map<K, H[]>, key: K, handler: H): HookDisposable {
  const list = map.get(key) ?? [];
  list.push(handler);
  map.set(key, list);
  return {
    dispose: () => {
      const index = list.indexOf(handler);
      if (index >= 0) list.splice(index, 1);
    },
  };
}

function run<H>(handlers: H[] | undefined, call: (handler: H) => boolean): boolean {
  if (!handlers) return false;
  for (let index = handlers.length - 1; index >= 0; index--) if (call(handlers[index]!)) return true;
  return false;
}

const INTRODUCERS = new Set([0x1b, 0x90, 0x98, 0x9b, 0x9d, 0x9e, 0x9f]);

/**
 * The stream between the mount and the engine: `write` takes decoded text and hands `engine` every piece no hook
 * takes, in order, once a call. C1 introducers (U+009B CSI, U+009D OSC, U+0090 DCS, U+0098/9E/9F strings) reach the
 * engine in their 7-bit form, the only one libghostty reads. A string (OSC, DCS, APC, PM, SOS) ended by an ESC that
 * begins another sequence reaches the engine ended with ST, as xterm dispatches it at that ESC.
 */
export function hookedStream(hooks: ParserHooks, engine: (text: string) => void) {
  let state = GROUND;
  /** the ESC that ended a string was read: a backslash right after it completes that ST and is dropped */
  let stringEsc = false;
  let held = "";
  let prefix = "";
  let params = "";
  let intermediates = "";
  let oscId = -1;
  let oscIdComplete = false;
  let oscAborted = false;
  let hooked = false;
  let payload = "";
  let payloadOver = false;
  let dcsKey = "";
  let out = "";
  /** what came before a sequence reaches the engine before any hook sees the sequence, as in xterm's one parse */
  const flush = (): void => {
    if (out) engine(out);
    out = "";
  };

  const clear = (): void => {
    held = prefix = params = intermediates = payload = dcsKey = "";
    payloadOver = false;
    hooked = false;
    stringEsc = false;
  };
  const begin = (next: number, intro: string): void => {
    clear();
    state = next;
    held = intro;
    oscId = -1;
    oscIdComplete = false;
    oscAborted = false;
  };
  const take = (ch: string): void => {
    if (payload.length < PAYLOAD_MAX) payload += ch;
    else payloadOver = true;
  };
  /** the string ends: a hooked one goes to its hooks, and to the engine only when none takes it */
  const endString = (): void => {
    if (!hooked) out += "\x1b\\";
    else {
      flush();
      const taken = !payloadOver && (state === OSC ? hooks.runOsc(oscId, payload) : hooks.runDcs(dcsKey, payload, parseParams(params)));
      if (!taken) out += held + payload + "\x1b\\";
    }
    state = GROUND;
    oscIdComplete = false;
    oscId = -1;
    clear();
  };

  /** an ESC ends a string at once, as xterm dispatches it there (a copy is not left waiting for the next write) */
  const escInString = (): void => {
    endString();
    begin(ESC, "\x1b");
    stringEsc = true;
  };
  const step = (ch: string, code: number): boolean => {
    if (stringEsc) {
      stringEsc = false;
      // ESC \ was the ST, which the string's end already gave the engine
      if (state === ESC && ch === "\\") { state = GROUND; clear(); return true; }
    }
    if (state !== GROUND && (code === 0x18 || code === 0x1a)) {
      // CAN and SUB cancel the sequence: what is held is dropped, and the engine is given them to drop what it was given
      out += ch;
      state = GROUND;
      oscIdComplete = false;
      clear();
      return true;
    }
    if (state !== GROUND && C1_INTRODUCERS.has(code)) {
      // a string ends there (an OSC is dispatched, as xterm's parser dispatches it); an unfinished CSI or DCS header is dropped
      if (state === OSC || state === DCS || state === STRING) {
        if (state === STRING) { out += "\x1b\\"; state = GROUND; clear(); }
        else endString();
      } else { state = GROUND; clear(); }
      return false;
    }
    switch (state) {
      case CSI_IGNORE:
        // a malformed CSI is read to its final byte and dropped, as xterm's parser ignores it
        if (code >= 0x40 && code <= 0x7e) { state = GROUND; clear(); }
        else if (code < 0x20 && code !== 0x1b) out += ch;
        else if (code === 0x1b) begin(ESC, ch);
        return true;
      case GROUND:
        if (code === 0x1b) begin(ESC, ch);
        else if (code === 0x9b) begin(CSI, "\x1b[");
        else if (code === 0x9d) begin(OSC, "\x1b]");
        else if (code === 0x90) begin(DCS_HEAD, "\x1bP");
        else { begin(STRING, ""); out += code === 0x98 ? "\x1bX" : code === 0x9e ? "\x1b^" : "\x1b_"; }
        return true;
      case ESC:
        if (ch === "[") begin(CSI, "\x1b[");
        else if (ch === "]") begin(OSC, "\x1b]");
        else if (ch === "P") begin(DCS_HEAD, "\x1bP");
        else if (ch === "_" || ch === "^" || ch === "X") { out += "\x1b" + ch; begin(STRING, ""); }
        else if (code === 0x1b) out += held;
        else {
          out += held + ch;
          // an intermediate (ESC ( B) keeps the sequence going: its final byte follows
          if (code >= 0x20 && code <= 0x2f) held = "";
          else { state = GROUND; clear(); }
        }
        return true;
      case CSI:
        // an ESC cancels the sequence and begins the next one
        if (code === 0x1b) { begin(ESC, ch); return true; }
        if (code < 0x20 || code === 0x7f) { out += ch; return true; }
        held += ch;
        if (code >= 0x3c && code <= 0x3f) {
          // a private marker only leads the sequence; anywhere else it makes the sequence malformed
          if (held.length === 3) prefix = ch;
          else { state = CSI_IGNORE; clear(); }
        } else if ((code >= 0x30 && code <= 0x39) || code === 0x3b || code === 0x3a) {
          if (intermediates) { state = CSI_IGNORE; clear(); } else params += ch;
        } else if (code >= 0x20 && code <= 0x2f) intermediates += ch;
        else if (code >= 0x40 && code <= 0x7e) {
          const key = `${prefix}|${intermediates}|${ch}`;
          let taken = false;
          if (hooks.hasCsi(key)) {
            flush();
            taken = hooks.runCsi(key, parseParams(params));
          }
          if (!taken) out += held;
          state = GROUND;
          clear();
        }
        return true;
      case OSC:
        if (code === 0x07 || code === 0x9c) {
          if (!oscIdComplete) {
            oscIdComplete = true;
            hooked = oscId >= 0 && !oscAborted && hooks.hasOsc(oscId);
            if (!hooked) out += held;
          }
          if (hooked) {
            flush();
            const taken = !payloadOver && hooks.runOsc(oscId, payload);
            if (!taken) out += held + payload + (code === 0x07 ? "\x07" : "\x1b\\");
          } else out += code === 0x07 ? "\x07" : "\x1b\\";
          state = GROUND;
          oscIdComplete = false;
          oscId = -1;
          clear();
          return true;
        }
        if (code === 0x1b) {
          if (!oscIdComplete) {
            oscIdComplete = true;
            hooked = oscId >= 0 && !oscAborted && hooks.hasOsc(oscId);
            if (!hooked) out += held;
          }
          escInString();
          return true;
        }
        // xterm's parser ignores the other C0 controls inside an OSC: neither its id nor its payload takes them
        if (code < 0x20) {
          if (oscIdComplete && !hooked) out += ch;
          return true;
        }
        if (!oscIdComplete) {
          held += ch;
          if (ch === ";") {
            oscIdComplete = true;
            hooked = oscId >= 0 && !oscAborted && hooks.hasOsc(oscId);
            // no hook names it: what was held goes, and the rest streams through
            if (!hooked) { out += held; held = ""; }
          } else if (code >= 0x30 && code <= 0x39 && !oscAborted) oscId = Math.max(0, oscId) * 10 + code - 0x30;
          // xterm aborts an OSC whose identifier holds anything but digits: its id stays what was read
          else oscAborted = true;
        } else if (hooked) take(ch);
        else out += ch;
        return true;
      case DCS_HEAD:
        if (code === 0x1b) { begin(ESC, ch); return true; }
        held += ch;
        if (code >= 0x3c && code <= 0x3f && held.length === 3) prefix = ch;
        else if ((code >= 0x30 && code <= 0x39) || code === 0x3b || code === 0x3a) params += ch;
        else if (code >= 0x20 && code <= 0x2f) intermediates += ch;
        else if (code >= 0x40 && code <= 0x7e) {
          dcsKey = `${prefix}|${intermediates}|${ch}`;
          hooked = hooks.hasDcs(dcsKey);
          if (!hooked) { out += held; held = ""; }
          state = DCS;
        }
        return true;
      case DCS:
      case STRING:
        if (code === 0x1b) { escInString(); return true; }
        if (code === 0x9c || (state === STRING && code === 0x07)) {
          if (state === STRING) { out += code === 0x07 ? "\x07" : "\x1b\\"; state = GROUND; clear(); }
          else endString();
          return true;
        }
        if (hooked) take(ch);
        else out += ch;
        return true;
    }
    return true;
  };

  const write = (text: string): void => {
    let at = 0;
    const length = text.length;
    while (at < length) {
      if (state === GROUND) {
        let next = at;
        while (next < length && !INTRODUCERS.has(text.charCodeAt(next))) next++;
        if (next > at) out += text.slice(at, next);
        at = next;
        if (at >= length) break;
      }
      // a character that ended a string and began the next sequence is read again in that sequence
      if (step(text.charAt(at), text.charCodeAt(at))) at++;
    }
    const piece = out;
    out = "";
    if (piece) engine(piece);
  };
  return Object.assign(write, {
    /** between sequences: something written to the engine now starts no sequence of the program's halfway */
    idle: (): boolean => state === GROUND,
    oscStringState: (): OscStringState => ({ open: state === OSC, idComplete: oscIdComplete && !oscAborted, id: oscId }),
    reset: (): void => {
      state = GROUND;
      oscIdComplete = false;
      oscId = -1;
      clear();
      out = "";
    },
  });
}
