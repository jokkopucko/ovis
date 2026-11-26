/**
 * Copyright (c) 2016 The xterm.js authors. All rights reserved.
 * @license MIT
 * Adapted for Ovis.
 */

import { C0 } from "./controls.ts";
import type { TerminalInputHost, TextAreaViewportBounds } from "./input.ts";
import type { InputPlatform } from "./platform.ts";

/** Hangul jamo and syllables: a key or an edit that a Korean input method composes. */
const HANGUL_KEY = /^[ᄀ-ᇿ㄰-㆏가-힯]$/;
const HANGUL_TEXT = /^[ᄀ-ᇿ㄰-㆏가-힯]+$/;

interface IPosition {
  start: number;
  end: number;
}

/**
 * Encapsulates the logic for handling compositionstart, compositionupdate and compositionend
 * events, displaying the in-progress composition to the UI and forwarding the final composition
 * to the handler.
 */
export class CompositionHelper {
  /**
   * Whether input composition is currently happening, eg. via a mobile keyboard, speech input or
   * IME. This variable determines whether the compositionText should be displayed on the UI.
   */
  private _isComposing: boolean;
  public get isComposing(): boolean { return this._isComposing; }

  /**
   * The position within the input textarea's value of the current composition.
   */
  private _compositionPosition: IPosition;

  /** Finished compositions may overlap before their deferred sends run (#6089). */
  private readonly _pendingSends: (() => void)[] = [];
  private _sentUpTo = 0;
  private _generation = 0;
  /** macOS Safari can replace Hangul in the editor without any composition events. */
  private _replacementComposition = false;
  /** A replacement edit arrived with no keydown yet; Safari 26 sends that keydown after it. */
  private _editAwaitingKey = false;
  /** Text whose insertion ended a replacement after its keydown was held back (keydown 229). */
  private _commitInsert: string | undefined;
  /** The preedit is dictation's hypothesis, replaced in place with no key of its own. */
  private _dictation = false;
  private _inputViewportBounds: TextAreaViewportBounds | undefined;

  /**
   * Data already sent due to keydown event.
   */
  private _dataAlreadySent: string;

  /** The 229 fallback's deferred textarea diff, until it runs or a following key flushes it. */
  private _pendingTextareaChange: (() => void) | undefined;

  constructor(
    private readonly _textarea: HTMLTextAreaElement,
    private readonly _compositionView: HTMLElement,
    private readonly host: TerminalInputHost,
    private readonly platform: InputPlatform,
    private readonly send: (data: string) => void,
    private readonly stdinDisabled: () => boolean,
  ) {
    this._isComposing = false;
    this._compositionPosition = { start: 0, end: 0 };
    this._dataAlreadySent = '';
  }

  /** A reset/disposal must not forward an old pane's deferred input into its replacement. */
  public reset(): void {
    this._generation++;
    this._replacementComposition = false;
    this._dictation = false;
    this._editAwaitingKey = false;
    this._commitInsert = undefined;
    this._pendingSends.length = 0;
    this._pendingTextareaChange = undefined;
    this._isComposing = false;
    this._sentUpTo = 0;
    this._dataAlreadySent = '';
    this._compositionPosition = { start: 0, end: 0 };
    this._textarea.value = '';
    this._compositionView.textContent = '';
    this._compositionView.classList.remove('active');
    this._compositionView.style.display = 'none';
  }

  public setInputViewport(bounds: TextAreaViewportBounds | undefined): void {
    this._inputViewportBounds = bounds;
    this.updateTextareaPosition();
    this.updateCompositionElements(true);
  }

  public updateTextareaPosition(): void {
    const position = this.host.cursor();
    if (this._isComposing || !position) return;
    const cell = this.host.cell();
    const x = Math.min(position.x, this.host.cols() - 1);
    const cursor = this._cursorPosition(x, position.y, cell);
    const width = cell.width * this.host.cellWidth(x, position.y);
    const bounds = this._inputViewportBounds;
    this._textarea.style.left = cursor.left + 'px';
    this._textarea.style.top = cursor.top + 'px';
    this._textarea.style.width = Math.max(1, bounds ? Math.min(width, bounds.right - cursor.left) : width) + 'px';
    this._textarea.style.height = cell.height + 'px';
    this._textarea.style.lineHeight = cell.height + 'px';
  }

  private _cursorPosition(x: number, y: number, cell: { width: number; height: number }): { left: number; top: number; offscreen: boolean } {
    const cursorLeft = x * cell.width;
    const cursorTop = y * cell.height;
    const bounds = this._inputViewportBounds;
    if (!bounds || bounds.right <= bounds.left || bounds.bottom <= bounds.top) {
      return { left: cursorLeft, top: cursorTop, offscreen: false };
    }
    const offscreen = cursorLeft < bounds.left || cursorLeft + cell.width > bounds.right
      || cursorTop < bounds.top || cursorTop + cell.height > bounds.bottom;
    if (!offscreen) return { left: cursorLeft, top: cursorTop, offscreen: false };
    return {
      left: Math.min(Math.max(cursorLeft, bounds.left), Math.max(bounds.left, bounds.right - cell.width)),
      top: Math.min(Math.max(cursorTop, bounds.top), Math.max(bounds.top, bounds.bottom - cell.height)),
      offscreen: true
    };
  }

  /** Safari #432: beforeinput supplies the pre-edit range; keydown 229 arrives AFTER input. */
  public beforeinput(ev: InputEvent, keyDownSeen = false): void {
    if (!this._replacementComposition) this._editAwaitingKey = false;
    if (!this.platform.isAppleWebKit || ev.isComposing || this.host.screenReaderMode?.()
      || (this._isComposing && !this._replacementComposition)) return;
    if (this._replacementComposition && (ev.inputType === 'insertReplacementText'
      || ev.inputType === 'deleteContentBackward' || ev.inputType === 'deleteContentForward')) return;
    // keydown() held back this key while the syllable was pending, so Terminal will treat
    // its insertion as already handled by keydown. Mark it to be forwarded once.
    const commitInsert = this._replacementComposition && keyDownSeen && ev.inputType === 'insertText' ? ev.data ?? undefined : undefined;
    // Not finishReplacement(): this event precedes the edit a pending 229 diff waits for.
    this._finishReplacementComposition();
    this._commitInsert = commitInsert;
    // Only a Hangul preedit or a dictation hypothesis starts this path. Paste, emoji and browsers
    // emitting real composition events retain their existing input handling. iPadOS puts two
    // syllables back at once when a final consonant moves on (\ub9dd + \u314f: \ub9c8\uc544).
    // Dictation replaces its hypothesis in place (thi, this, this is): sending each one put
    // every provisional word in the pane, so the corrected text is sent once, at the commit.
    // A replacement of text before the caret (already sent) keeps its existing handling, and a
    // terminal that takes no input (view only) holds no phrase to send once input returns.
    const dictation = ev.inputType === 'insertReplacementText' && !!ev.data
      && this._textarea.selectionStart === this._textarea.value.length
      && !this.stdinDisabled();
    if ((ev.inputType === 'insertText' && ev.data && HANGUL_TEXT.test(ev.data)) || dictation) {
      this._commitInsert = undefined;
      this.compositionstart();
      this._replacementComposition = true;
      this._dictation = dictation;
    }
  }

  /**
   * iPadOS Safari with a hardware keyboard and the iPhone's on-screen keyboard report each Hangul
   * jamo as a printable keydown (its own keyCode on an iPad, 0 on an iPhone, never 229) and then
   * compose in the editor with deleteContentBackward and insertText, never with composition
   * events. Sending the key on keydown cancels that edit, so every jamo reached the PTY on its own
   * (한 as ㅎㅏㄴ). Such a key is left to the editor: beforeinput takes its insertion as a
   * replacement preedit, which the next other key, paste or blur commits.
   */
  public passHangulKey(ev: KeyboardEvent): boolean {
    if (!this.platform.isAppleWebKit || ev.keyCode === 229 || ev.isComposing || ev.ctrlKey || ev.altKey || ev.metaKey
      || this.host.screenReaderMode?.() || (this._isComposing && !this._replacementComposition)
      || !HANGUL_KEY.test(ev.key)) return false;
    this._editAwaitingKey = false;
    this._commitInsert = undefined;
    return true;
  }

  /** Whether this insertion ended a replacement and still has to be forwarded (see beforeinput). */
  public takeCommitInsert(ev: InputEvent): boolean {
    if (this._commitInsert === undefined || ev.inputType !== 'insertText' || ev.data !== this._commitInsert) return false;
    this._commitInsert = undefined;
    return true;
  }

  /** Keep Safari's provisional DOM edits out of Terminal._inputEvent and its 229 fallback. */
  public input(_ev: InputEvent, keyDownSeen = false): boolean {
    if (!this._replacementComposition) return false;
    const start = this._compositionPosition.start;
    const before = this._compositionView.textContent;
    this._compositionPosition.end = Math.max(start, this._textarea.selectionEnd ?? this._textarea.value.length);
    this._compositionView.textContent = this._textarea.value.substring(start, this._compositionPosition.end);
    // An unchanged replacement is the input method committing the preedit, not an applied key:
    // Safari 27 then passes Backspace on (keyCode 8) to delete the last jamo, which must happen.
    // Dictation has no key of its own to wait for: a Backspace after it is the user's.
    if (!keyDownSeen && !this._dictation && this._compositionView.textContent !== before) this._editAwaitingKey = true;
    this.updateCompositionElements();
    if (this._compositionPosition.end === start) {
      // Backspace removed the entire preedit. Nothing has reached the PTY to delete.
      this._replacementComposition = false;
      this._dictation = false;
      this._isComposing = false;
      this._compositionView.classList.remove('active');
      this._compositionView.style.display = 'none';
    }
    return true;
  }

  /** Commit the corrected DOM range before a following key, paste, syllable or blur. */
  public finishReplacement(): void {
    // A paste, blur or embedder key clears or extends the textarea: diff the 229 edit first.
    this._pendingTextareaChange?.();
    this._finishReplacementComposition();
  }

  private _finishReplacementComposition(): void {
    if (this._replacementComposition) {
      this._editAwaitingKey = false;
      this._finalizeComposition(false);
    }
  }

  /**
   * Input that bypasses the textarea (the embedder's: a key bar's arrow, Tab or Esc) can move the
   * shell cursor off the end of the textarea's text, where the 229 fallback sends its DELs: a
   * Gboard replacement then deleted text the user never edited (#2836). Empty it as Enter does.
   * A composition in progress, or one whose deferred send has yet to read it, keeps its text:
   * sending that here would put the commit first, under the label the embedder gave its own
   * input (a key bar key, the Stop).
   */
  public clearTextarea(): void {
    this.finishReplacement();
    if (this._isComposing || this._pendingSends.length > 0) return;
    this._textarea.value = '';
  }

  /**
   * Handles the compositionstart event, activating the composition view.
   */
  public compositionstart(): void {
    this.finishReplacement();
    this._isComposing = true;
    this._compositionPosition = { start: this._textarea.value.length, end: this._textarea.value.length };
    this._sentUpTo = Math.min(this._sentUpTo, this._compositionPosition.start);
    this._compositionView.textContent = '';
    this._dataAlreadySent = '';
    this._compositionView.classList.add('active');
    this._compositionView.style.display = 'flex';
  }

  /**
   * Handles the compositionupdate event, updating the composition view.
   * @param ev The event.
   */
  public compositionupdate(ev: Pick<CompositionEvent, 'data'>): void {
    if (!this._isComposing) return;
    this._compositionView.textContent = ev.data;
    this.updateCompositionElements();
    const generation = this._generation;
    setTimeout(() => {
      if (generation !== this._generation) return;
      this._compositionPosition.end = this._textarea.value.length;
    }, 0);
  }

  /**
   * Handles the compositionend event, hiding the composition view and sending the composition to
   * the handler.
   */
  public compositionend(): void {
    if (!this._isComposing) return;
    this._finalizeComposition(true);
  }

  /**
   * Handles the keydown event, routing any necessary events to the CompositionHelper functions.
   * @param ev The keydown event.
   * @returns Whether the Terminal should continue processing the keydown event.
   */
  public keydown(ev: KeyboardEvent): boolean {
    // Enter, Ctrl+C and Backspace clear the textarea: send the earlier 229 edit before that.
    this._pendingTextareaChange?.();
    const editBefore = this._editAwaitingKey;
    this._editAwaitingKey = false;
    this._commitInsert = undefined;
    const deleteKey = (ev.keyCode === 8 || ev.keyCode === 46) && !ev.ctrlKey && !ev.altKey && !ev.metaKey;
    if (editBefore && deleteKey) {
      // Safari already applied this Backspace/Delete to the pending syllable (and may have
      // emptied it). Sending DEL would delete text that reached the PTY earlier.
      ev.preventDefault();
      return false;
    }
    if (this._replacementComposition) {
      // Switching layouts and holding modifiers do not commit a provisional syllable.
      if ([229, 16, 17, 18, 20, 91, 93, 129].includes(ev.keyCode)) return false;
      // Backspace/Delete edit the pending syllable; input() tracks the DOM edit that follows.
      if (deleteKey) return false;
      this.finishReplacement();
    }
    if (this._isComposing || this._pendingSends.length > 0) {
      if (ev.keyCode === 20 || ev.keyCode === 229) {
        // 20 is CapsLock, 229 is Enter
        // Continue composing if the keyCode is the "composition character"
        return false;
      }
      if (ev.keyCode === 16 || ev.keyCode === 17 || ev.keyCode === 18) {
        // Continue composing if the keyCode is a modifier key
        return false;
      }
      // Finish composition immediately. This is mainly here for the case where enter is
      // pressed and the handler needs to be triggered before the command is executed.
      this._finalizeComposition(false);
    }

    if (ev.keyCode === 229) {
      // If the "composition character" is used but gets to this point it means a non-composition
      // character (eg. numbers and punctuation) was pressed when the IME was active.
      this._handleAnyTextareaChanges();
      return false;
    }

    return true;
  }

  /**
   * Finalizes the composition, resuming regular input actions. This is called when a composition
   * is ending.
   * @param waitForPropagation Whether to wait for events to propagate before sending
   *   the input. This should be false if a non-composition keystroke is entered before the
   *   compositionend event is triggered, such as enter, so that the composition is sent before
   *   the command is executed.
   */
  private _finalizeComposition(waitForPropagation: boolean): void {
    this._replacementComposition = false;
    this._dictation = false;
    this._compositionView.classList.remove('active');
    this._compositionView.style.display = 'none';
    this._isComposing = false;

    if (!waitForPropagation) {
      // Drain older commits before the key that interrupts the current composition.
      for (const send of this._pendingSends.splice(0)) send();
      const end = Math.max(this._compositionPosition.end, this._textarea.selectionEnd ?? 0);
      const input = this._sliceUnsent(this._compositionPosition.start, end);
      if (input) this.send(input);
    } else {
      const start = this._compositionPosition.start;
      // Read the textarea after DOM edits propagate. compositionend.data can still contain
      // the previous final consonant when Korean moves it to the following syllable.
      const send = (): void => {
        const from = start + this._dataAlreadySent.length;
        const end = this._compositionPosition.start > from
          ? this._compositionPosition.start : this._textarea.value.length;
        const input = this._sliceUnsent(from, end);
        if (input) this.send(input);
      };
      this._pendingSends.push(send);
      setTimeout(() => {
        const index = this._pendingSends.indexOf(send);
        if (index !== -1) {
          this._pendingSends.splice(index, 1);
          send();
        }
      }, 0);
    }
  }

  private _sliceUnsent(start: number, end: number): string {
    const from = Math.max(start, this._sentUpTo);
    const to = Math.max(from, end);
    this._sentUpTo = Math.max(this._sentUpTo, to);
    return this._textarea.value.substring(from, to);
  }

  /**
   * Apply any changes made to the textarea after the current event chain is allowed to complete.
   * This should be called when not currently composing but a keydown event with the "composition
   * character" (229) is triggered, in order to allow non-composition text to be entered when an
   * IME is active.
   */
  private _handleAnyTextareaChanges(): void {
    const oldValue = this._textarea.value;
    const caret = this._textarea.selectionEnd ?? oldValue.length;
    const change = (): void => {
      if (this._pendingTextareaChange !== change) return;
      this._pendingTextareaChange = undefined;
      // Ignore if a composition has started since the timeout
      if (this._isComposing) return;
      const newValue = this._textarea.value;
      let input: string;
      if (caret < oldValue.length) {
        // An edit before the end of what was sent: the PTY cursor is not at the caret, so DEL
        // would erase other text. Forward only a plain insertion at the caret.
        const head = oldValue.substring(0, caret);
        const tail = oldValue.substring(caret);
        input = newValue.length > oldValue.length && newValue.startsWith(head) && newValue.endsWith(tail)
          ? newValue.substring(caret, newValue.length - tail.length) : '';
        this._dataAlreadySent = input;
      } else {
        // Gboard can replace a trailing space with ". ". The old value is then no
        // longer a substring: replace(oldValue, '') would resend the whole line.
        // Keep the shared prefix and replace only the edited suffix. Compare code
        // points so an emoji is never split into two surrogate halves.
        const before = Array.from(oldValue);
        const after = Array.from(newValue);
        let prefix = 0;
        while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix++;
        const inserted = after.slice(prefix).join('');
        this._dataAlreadySent = inserted;
        input = C0.DEL.repeat(before.length - prefix) + inserted;
      }
      if (input) this.send(input);
    };
    this._pendingTextareaChange = change;
    setTimeout(change, 0);
  }

  /**
   * Positions the composition view on top of the cursor and the textarea just below it (so the
   * IME helper dialog is positioned correctly).
   * @param dontRecurse Whether to use setTimeout to recursively trigger another update, this is
   *   necessary as the IME events across browsers are not consistently triggered.
   */
  public updateCompositionElements(dontRecurse?: boolean): void {
    if (!this._isComposing) {
      return;
    }

    const position = this.host.cursor();
    if (position) {
      const cell = this.host.cell();
      const cursor = this._cursorPosition(Math.min(position.x, this.host.cols() - 1), position.y, cell);
      const bounds = this._inputViewportBounds;
      const cellHeight = cell.height;
      const font = this.host.font();
      let compositionLeft = cursor.left;

      this._compositionView.style.left = compositionLeft + 'px';
      this._compositionView.style.top = cursor.top + 'px';
      this._compositionView.style.height = cellHeight + 'px';
      this._compositionView.style.lineHeight = cellHeight + 'px';
      this._compositionView.style.fontFamily = font.family;
      this._compositionView.style.fontSize = font.size + 'px';
      this._compositionView.style.maxWidth = '';
      this._compositionView.style.overflow = '';
      this._compositionView.style.transform = '';
      // Sync the textarea to the exact position of the composition view so the IME knows where the
      // text is.
      const compositionViewBounds = this._compositionView.getBoundingClientRect();
      let compositionWidth = Math.max(compositionViewBounds.width, 1);
      if (bounds && bounds.right > bounds.left && bounds.bottom > bounds.top) {
        if (cursor.offscreen) {
          compositionWidth = Math.max(1, Math.min(compositionWidth, bounds.right - bounds.left));
          compositionLeft = Math.max(bounds.left, Math.min(cursor.left, bounds.right - compositionWidth));
        } else {
          compositionWidth = Math.max(1, Math.min(compositionWidth, bounds.right - compositionLeft));
        }
        this._compositionView.style.left = compositionLeft + 'px';
        // A composition too long for the room right of the cursor moves left instead of losing its
        // newest characters at the edge, and one wider than the bounds shows its end (flex-end in
        // xterm.css), as a single-line field keeps its caret in view. 100% is the width drawn, which
        // an embedder may still change after the measure above (a font fitted to the row).
        this._compositionView.style.maxWidth = (bounds.right - bounds.left) + 'px';
        this._compositionView.style.overflow = 'hidden';
        this._compositionView.style.transform = `translateX(min(0px, calc(${bounds.right - compositionLeft}px - 100%)))`;
      }
      this._textarea.style.left = compositionLeft + 'px';
      this._textarea.style.top = cursor.top + 'px';
      // Ensure the text area is at least 1x1, otherwise certain IMEs may break
      this._textarea.style.width = compositionWidth + 'px';
      this._textarea.style.height = Math.max(compositionViewBounds.height, 1) + 'px';
      this._textarea.style.lineHeight = compositionViewBounds.height + 'px';
      // Firefox places the IME's candidate window as if the text in this narrow nowrap textarea were
      // never scrolled: the text typed before the preedit pushed it out of the box, and the window
      // opened that far left of the cursor (#2936). The box grows left by that overflow instead, so
      // nothing scrolls and the preedit stays where it is drawn.
      if (this.platform.isFirefox) {
        const overflow = this._textarea.scrollWidth - this._textarea.clientWidth;
        if (overflow > 0) {
          this._textarea.style.left = (compositionLeft - overflow) + 'px';
          this._textarea.style.width = (compositionWidth + overflow) + 'px';
        }
      }
    }

    if (!dontRecurse) {
      const generation = this._generation;
      setTimeout(() => { if (generation === this._generation) this.updateCompositionElements(true); }, 0);
    }
  }
}
