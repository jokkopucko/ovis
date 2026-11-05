/**
 * The text an `insert` frame may carry (ClientMessage `insert`, feature "terminal-insert"): the
 * terminal draft typed into the pane without Enter. The server and the demo check a frame with
 * this before anything is typed, so a refusal is the same everywhere.
 *
 * An Insert types one line. Several lines would be safe only as one bracketed paste into a program
 * that turned bracketed paste on, and nothing here can tell that it did: herdr's API reports no
 * terminal modes, and `herdr terminal attach` opens its stream with its own ESC[?2004h whatever the
 * program in the pane set (measured on herdr 0.9.5: a program that wrote ESC[?2004l got the same
 * preamble as one that wrote ESC[?2004h). A shell would run each bare line, and an Insert never
 * presses Enter, so a line break is refused (`unsafe_multiline`) rather than a mode inferred; the
 * paste markers themselves are escapes, refused with every other control byte.
 */

/** UTF-16 code units of the text, the terminal draft's own cap (src/lib/terminalDraft.ts). */
export const INSERT_MAX_UNITS = 32_768;
/** UTF-8 bytes of the text: one `pane.send_text` RPC, well under herdr's frame limit. */
export const INSERT_MAX_BYTES = 131_072;

/** Why an insert is refused, as the insert-result says it. */
export interface InsertRefusal { code: string; message: string }

/** Every control is refused, Tab included: a shell takes Tab as completion, so the prompt would not show the line as written; ESC is a paste marker or a key sequence. A lone surrogate would reach the pty as U+FFFD. */
const CONTROL = /[\u0000-\u0009\u000b\u000c\u000e-\u001f\u007f-\u009f]/;
const LINE_BREAK = /[\r\n]/;
// no lookbehind (shared/lookbehind.ts): a low half after anything but a high half
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?:^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/** The refusal `text` earns before any pane is looked at, or null when it may be typed as it is. */
export function insertTextProblem(text: unknown): InsertRefusal | null {
  if (typeof text !== "string") return { code: "invalid_insert_text", message: "text must be a string" };
  if (text.length === 0) return { code: "invalid_insert_text", message: "nothing to insert" };
  if (LINE_BREAK.test(text)) return { code: "unsafe_multiline", message: "Insert types one line: the pane's program is not known to take several as one paste, and a shell would run each; nothing was typed" };
  if (LONE_SURROGATE.test(text)) return { code: "invalid_insert_text", message: "the text ends in half a character" };
  if (CONTROL.test(text)) return { code: "invalid_insert_text", message: "the text holds a control character" };
  if (text.length > INSERT_MAX_UNITS || new TextEncoder().encode(text).length > INSERT_MAX_BYTES) {
    return { code: "insert_too_long", message: `the text is longer than ${INSERT_MAX_UNITS} characters or ${INSERT_MAX_BYTES} bytes` };
  }
  return null;
}
