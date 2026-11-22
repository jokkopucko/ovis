/**
 * The iOS keyboard repeats a held ⌫ only while the focused field has text: in an empty field it
 * sends one keydown and stops. xterm's helper textarea is empty almost all the time:
 * a typed key is sent on keydown and cancelled, and xterm empties the field after Backspace,
 * Enter, ^C and blur. So a held ⌫ deleted one character and stopped (#862). Leaving one
 * character in the empty field keeps the repeat going: each repeat is a keydown xterm sends as
 * DEL and cancels, so the character itself is never deleted and never reaches the pty.
 * The field must also wrap: with xterm's `white-space: nowrap` the iOS 27 keyboard sent one ⌫
 * and stopped even with text in it (measured in the simulator's Safari).
 */
export const DELETE_REPEAT_TEXT = " ";

export interface DeleteRepeatEnvironment {
  userAgent: string;
  /** iPadOS reports a Mac user agent; touch points tell the two apart */
  maxTouchPoints: number;
}

/** iPhone and iPad, whatever the browser: they all use WebKit and the system keyboard. */
export function keyboardNeedsText(env: DeleteRepeatEnvironment): boolean {
  return /iPhone|iPad|iPod/.test(env.userAgent) || (/Macintosh/.test(env.userAgent) && env.maxTouchPoints > 1);
}

/**
 * Only an empty field is touched:
 * a composition's preedit and the text an IME is working on stay as they are.
 */
export function keepDeleteRepeatText(field: Pick<HTMLTextAreaElement, "value" | "setSelectionRange">): boolean {
  if (field.value !== "") return false;
  field.value = DELETE_REPEAT_TEXT;
  field.setSelectionRange(DELETE_REPEAT_TEXT.length, DELETE_REPEAT_TEXT.length);
  return true;
}

/** Before the next edit, keep the placeholder outside the range xterm will commit. */
export function restoreDeleteRepeatCaret(field: Pick<HTMLTextAreaElement, "value" | "selectionStart" | "selectionEnd" | "setSelectionRange">): boolean {
  if (field.value !== DELETE_REPEAT_TEXT
    || (field.selectionStart === DELETE_REPEAT_TEXT.length && field.selectionEnd === DELETE_REPEAT_TEXT.length)) return false;
  field.setSelectionRange(DELETE_REPEAT_TEXT.length, DELETE_REPEAT_TEXT.length);
  return true;
}
