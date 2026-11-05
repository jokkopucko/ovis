/**
 * The disconnected-input draft: while the socket is down, typed text is held for the
 * user to review and send after reconnect instead of being queued and fired blindly.
 * Pure logic, DOM-free, so the policy is unit-testable (see draft.test.ts).
 */

export interface InputDraft {
  readonly text: string;
  /** text was typed or pasted that the draft had no room for: what is held is not all of it */
  readonly truncated: boolean;
  /** an Enter or a line break was typed or pasted: it is never held, so it is not replayed by Send */
  readonly leftOut: boolean;
}

export const EMPTY_DRAFT: InputDraft = { text: "", truncated: false, leftOut: false };

const MAX_DRAFT_CHARS = 1024;

/**
 * How long held input stays in the browser profile once it has been written there. The draft is
 * kept so a reload in the middle of a disconnect does not lose what the user typed; a day is far
 * longer than that, and short enough that text typed at a password prompt is not left lying
 * about afterwards. A record without a timestamp was written before the TTL existed: it is kept,
 * so an update in the middle of a disconnect loses nothing, and it is dated as it is restored.
 */
export const DRAFT_TTL_MS = 24 * 60 * 60 * 1000;

/** What a stored draft record holds: the draft, and when it was written. */
interface StoredDraft extends InputDraft { at: number }

/**
 * The draft a stored record restores, or the empty one: malformed and expired records read as
 * nothing held, so a hand-edited or stale entry cannot put text back on screen.
 * A record written by an earlier version counts the keys it left out instead of flagging them:
 * only its text is kept, and a record that held nothing but a count reads as empty.
 */
export function restoreDraft(raw: string | null, now: number): InputDraft {
  if (raw === null) return EMPTY_DRAFT;
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return EMPTY_DRAFT; }
  if (typeof value !== "object" || value === null) return EMPTY_DRAFT;
  const { text, truncated, leftOut, at } = value as Partial<StoredDraft>;
  if (typeof text !== "string") return EMPTY_DRAFT;
  if (at !== undefined && (typeof at !== "number" || !Number.isFinite(at) || now - at > DRAFT_TTL_MS)) return EMPTY_DRAFT;
  return { text, truncated: truncated === true, leftOut: leftOut === true };
}

/** An IME commit can contain several code points. Never preserve terminal control sequences. */
function isPrintableChar(data: string): boolean {
  return data.length > 0 && !/[\x00-\x1f\x7f-\x9f]/u.test(data);
}

/** xterm's bracketed paste: the pasted text between the frames, which is what the user gave. */
const BRACKETED_PASTE = /^\x1b\[200~([\s\S]*)\x1b\[201~$/;

/** Backspace as the terminal sends it: DEL, or BS for Ctrl+H. */
const ERASE = /^[\x7f\b]+/;

/** A typed Enter, or the line breaks of a paste: CRLF, CR or LF, a run of them read as one. */
const LINE_BREAKS = /[\r\n]+/g;

/**
 * Folds one onData chunk into the draft: printable text accumulates, a paste by the text
 * inside its bracketed-paste frames, a tab in it held as a space so Send never completes.
 * Backspace deletes the last code point held, so the draft matches what was typed, and erasing
 * all of it clears the draft, left-out break included; once text was left out for want of room, Backspace may be meant for that text, so it no longer edits the
 * draft. An Enter or a line break is never held, because Send must never run a command: the text
 * on either side is kept, a space where the break was, and the draft says that a break was left
 * out. A break with no text to separate (Enter on an empty draft) changes nothing. A chunk with
 * other controls is left out and not told: arrows and the answers xterm gives a program by itself
 * (cursor position, focus, mouse) are not text the user typed, and neither is a typed chunk with
 * ESC in it even when it ends in CR (Shift+Enter, Alt+Enter); a paste or a multi-line chunk with
 * other controls is told as left out. Text the draft has no room for is left out whole, never cut in the middle of what was
 * typed, and the draft says so.
 */
export function applyToDraft(draft: InputDraft, data: string): InputDraft {
  const pasted = BRACKETED_PASTE.exec(data)?.[1];
  // a typed Tab is completion, not text; one in pasted text is held as the space it shows as
  let text = pasted?.replace(/\t/g, " ") ?? data;
  let next = draft;
  const erase = pasted === undefined ? ERASE.exec(text)?.[0].length ?? 0 : 0;
  if (erase > 0) {
    // after a loss the draft cannot tell which text a Backspace was meant for: it keeps what it holds
    // code points, not UTF-16 units: one Backspace never leaves half of an emoji behind
    if (!draft.truncated) {
      const kept = Array.from(draft.text).slice(0, -erase).join("");
      // erased to nothing: a line break left out between text that is gone separates nothing either
      next = kept.length === 0 ? EMPTY_DRAFT : { ...draft, text: kept };
    }
    text = text.slice(erase);
    if (text.length === 0) return next.text === draft.text && next.leftOut === draft.leftOut ? draft : next;
  }
  // a typed chunk with ESC is a key sequence (Shift+Enter or Alt+Enter is ESC CR), not text: never held, never told
  if (pasted === undefined && text.includes("\x1b")) return next;
  if (/[\r\n]/.test(text)) {
    let joined = text.replace(LINE_BREAKS, " ");
    if (next.text.length === 0 || next.text.endsWith(" ")) joined = joined.replace(/^ /, "");
    // Enter with nothing held separates nothing: there is nothing to tell
    if (joined.length === 0 && next.text.length === 0) return next;
    const flagged = next.leftOut ? next : { ...next, leftOut: true };
    if (joined.length === 0) return flagged;
    // a line break among other controls is still something the user typed: told, and its text too
    if (!isPrintableChar(joined)) return flagged.truncated ? flagged : { ...flagged, truncated: true };
    return append(flagged, joined);
  }
  if (!isPrintableChar(text)) {
    // a paste is text the user gave: one with controls in it is told as left out, never lost in silence
    if (pasted === undefined || text.length === 0 || next.truncated) return next;
    return { ...next, truncated: true };
  }
  return append(next, text);
}

/**
 * Typing a connection ended with before the server confirmed it (#2587), held ahead of `draft`, which
 * holds only what was typed after it: each chunk is folded as it was typed, so what is held reads in
 * the order it was typed.
 */
export function holdBefore(chunks: readonly string[], draft: InputDraft): InputDraft {
  const lost = chunks.reduce((held, chunk) => applyToDraft(held, chunk), EMPTY_DRAFT);
  if (draftIsEmpty(lost)) return draft;
  if (draftIsEmpty(draft)) return lost;
  return append({ text: lost.text, truncated: lost.truncated || draft.truncated, leftOut: lost.leftOut || draft.leftOut }, draft.text);
}

function append(draft: InputDraft, text: string): InputDraft {
  if (draft.text.length + text.length > MAX_DRAFT_CHARS) return draft.truncated ? draft : { ...draft, truncated: true };
  return { ...draft, text: draft.text + text };
}

/** Nothing held and nothing to tell. A draft that only lost text is not empty: its loss is still to be told. */
export function draftIsEmpty(draft: InputDraft): boolean {
  return draft.text.length === 0 && !draft.truncated && !draft.leftOut;
}
