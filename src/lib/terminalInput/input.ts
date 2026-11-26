// Copyright (c) The xterm.js authors. MIT License.
// Adapted for Ovis.

import { handlePasteEvent, moveTextAreaUnderMouseCursor, paste, rightClickHandler } from "./clipboard.ts";
import { CompositionHelper } from "./composition.ts";
import { C0 } from "./controls.ts";
import { evaluateKeyboardEvent, KeyboardResultType } from "./keyboard.ts";
import { TerminalMouse } from "./mouse.ts";
import { detectInputPlatform, type InputPlatform } from "./platform.ts";

export interface TerminalInputModes {
  readonly applicationCursorKeys: boolean;
  // xterm tracks this mode, but does not use it to encode browser keypad events.
  readonly applicationKeypad: boolean;
  readonly bracketedPaste: boolean;
  readonly sendFocus: boolean;
  readonly mouseProtocol: "none" | "x10" | "vt200" | "drag" | "any";
  readonly mouseEncoding: "default" | "sgr" | "sgrPixels";
  readonly alternateScreen: boolean;
}

export interface TextAreaViewportBounds {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

export interface TerminalInputHost {
  readonly element: HTMLElement;
  readonly screen: HTMLElement;
  cols(): number;
  rows(): number;
  cell(): { readonly width: number; readonly height: number };
  cursor(): { readonly x: number; readonly y: number } | null;
  cellWidth(x: number, y: number): number;
  modes(): TerminalInputModes;
  font(): { readonly family: string; readonly size: number };
  // The alternate screen always has no scrollback. A normal screen can opt out too.
  hasScrollback?(): boolean;
  screenReaderMode?(): boolean;
  hasSelection?(): boolean;
  selectionText?(): string;
  selectAll?(): void;
  selectWordAt?(event: MouseEvent): void;
  scrollLines?(lines: number): void;
  // The host scrolls to bottom if it follows user input and is scrolled back.
  scrollOnUserInput?(): void;
  readonly macOptionIsMeta?: boolean;
  readonly macOptionClickForcesSelection?: boolean;
  readonly rightClickSelectsWord?: boolean;
  readonly ignoreBracketedPasteMode?: boolean;
  readonly cancelEvents?: boolean;
  readonly scrollSensitivity?: number;
  readonly fastScrollSensitivity?: number;
}

export interface InputSubscription { dispose(): void }
export interface TerminalKeyEvent { readonly key: string; readonly domEvent: KeyboardEvent }

class InputEventEmitter<T> {
  private readonly listeners = new Set<(value: T) => void>();

  public subscribe(listener: (value: T) => void): InputSubscription {
    const entry = (value: T) => listener(value);
    this.listeners.add(entry);
    return { dispose: () => { this.listeners.delete(entry); } };
  }

  public fire(value: T): void {
    for (const listener of [...this.listeners]) if (this.listeners.has(listener)) listener(value);
  }

  public clear(): void { this.listeners.clear(); }
}

export class TerminalInput {
  public readonly textarea: HTMLTextAreaElement;
  private readonly container: HTMLDivElement;
  private readonly platform: InputPlatform;
  private readonly listeners = new AbortController();
  private readonly _composition: CompositionHelper;
  private readonly mouse: TerminalMouse;
  private readonly dataEvent = new InputEventEmitter<string>();
  private readonly binaryEvent = new InputEventEmitter<string>();
  private readonly keyEvent = new InputEventEmitter<TerminalKeyEvent>();
  private readonly userInputEvent = new InputEventEmitter<void>();
  private readonly focusEvent = new InputEventEmitter<void>();
  private readonly blurEvent = new InputEventEmitter<void>();
  private _customKeyEventHandler: ((event: KeyboardEvent) => boolean) | undefined;
  private customWheelHandler: ((event: WheelEvent) => boolean) | undefined;
  private _keyDownHandled = false;
  private _keyDownSeen = false;
  private _keyPressHandled = false;
  private _unprocessedDeadKey = false;
  private _digitAwaitsKeyPress = false;
  private _textKey: { readonly text: string; readonly key: string; readonly event: KeyboardEvent } | undefined;

  constructor(private readonly host: TerminalInputHost) {
    const doc = host.screen.ownerDocument;
    this.platform = detectInputPlatform(doc.defaultView?.navigator);
    this.container = doc.createElement("div");
    Object.assign(this.container.style, { position: "absolute", left: "0", top: "0", zIndex: "5" });

    const textarea = this.textarea = doc.createElement("textarea");
    // xterm's class name, which the page's styles and the browser scripts look the field up by
    textarea.className = "xterm-helper-textarea";
    textarea.setAttribute("aria-label", "Terminal input");
    if (!this.platform.isChromeOS) textarea.setAttribute("aria-multiline", "false");
    textarea.setAttribute("autocorrect", "off");
    textarea.setAttribute("autocapitalize", "off");
    textarea.setAttribute("spellcheck", "false");
    textarea.tabIndex = 0;
    textarea.readOnly = false;
    Object.assign(textarea.style, {
      padding: "0", border: "0", margin: "0", position: "absolute", opacity: "0", left: "-9999em",
      top: "0", width: "0", height: "0", zIndex: "-5", whiteSpace: "nowrap", overflow: "hidden", resize: "none",
    });

    const view = doc.createElement("div");
    view.className = "composition-view";
    Object.assign(view.style, {
      background: "#000", color: "#fff", display: "none", position: "absolute", whiteSpace: "nowrap",
      zIndex: "1", justifyContent: "flex-end",
    });
    this._composition = new CompositionHelper(textarea, view, host, this.platform,
      (text) => this.triggerData(text, true), () => this.disableStdin);
    this.container.append(textarea, view);
    host.screen.append(this.container);
    this.bindEvents();
    this.mouse = new TerminalMouse(host, this.platform, () => this.focus(), (ev, force) => this.cancel(ev, force),
      (text) => this.triggerData(text, true), (text) => this.triggerBinary(text),
      (ev) => this.customWheelHandler?.(ev), this.listeners.signal);
    this.cursorMoved();
  }

  public get disableStdin(): boolean { return this.textarea.readOnly; }
  public set disableStdin(value: boolean) { this.textarea.readOnly = value; }
  public get isComposing(): boolean { return this._composition.isComposing; }

  public onData(cb: (data: string) => void): InputSubscription { return this.dataEvent.subscribe(cb); }
  public onBinary(cb: (data: string) => void): InputSubscription { return this.binaryEvent.subscribe(cb); }
  public onKey(cb: (event: TerminalKeyEvent) => void): InputSubscription { return this.keyEvent.subscribe(cb); }
  public onUserInput(cb: () => void): InputSubscription { return this.userInputEvent.subscribe(cb); }
  public onFocus(cb: () => void): InputSubscription { return this.focusEvent.subscribe(cb); }
  public onBlur(cb: () => void): InputSubscription { return this.blurEvent.subscribe(cb); }

  public focus(): void { this.textarea.focus({ preventScroll: true }); }
  public blur(): void { this.textarea.blur(); }

  public attachCustomKeyEventHandler(handler: (event: KeyboardEvent) => boolean): void {
    this._customKeyEventHandler = handler;
  }

  public attachCustomWheelEventHandler(handler: (event: WheelEvent) => boolean): void {
    this.customWheelHandler = handler;
  }

  public finishComposition(): void { this._composition.finishReplacement(); }

  public setTextAreaViewportBounds(bounds: TextAreaViewportBounds | undefined): void {
    this._composition.setInputViewport(bounds);
  }

  // The host calls this after a cursor move or render, including DEC mode changes.
  public cursorMoved(): void {
    if (this.listeners.signal.aborted) return;
    this.mouse.syncMode();
    if (this._composition.isComposing) this._composition.updateCompositionElements();
    else if (this.host.cursor()) {
      this.textarea.style.zIndex = "-5";
      this._composition.updateTextareaPosition();
    }
  }

  public input(data: string, wasUserInput = true): void {
    this._composition.clearTextarea();
    this.triggerData(data, wasUserInput);
  }

  /**
   * The terminal's own answer to the program (a cursor or device report): data only, as xterm's parser sends its
   * replies. It leaves the textarea and a composition in it alone, which input() would commit and clear.
   */
  public reply(data: string): void {
    this.triggerData(data, false);
  }

  /** the terminal was reset (another pane): a composition or key still pending is dropped, never sent to the new one */
  public reset(): void {
    this._composition.reset();
    this._textKey = undefined;
    this._digitAwaitsKeyPress = false;
    this._keyDownSeen = false;
    this._unprocessedDeadKey = false;
  }

  public paste(text: string): void {
    this._composition.finishReplacement();
    this.pasteText(text);
  }

  public cancel(event: MouseEvent | KeyboardEvent | InputEvent, force?: boolean): false | undefined {
    if (!this.host.cancelEvents && !force) return;
    event.preventDefault();
    event.stopPropagation();
    return false;
  }

  public dispose(): void {
    if (this.listeners.signal.aborted) return;
    this.listeners.abort();
    this.mouse.dispose();
    this._composition.reset();
    this._textKey = undefined;
    this.container.remove();
    this.host.element.classList.remove("focus");
    for (const emitter of [this.dataEvent, this.binaryEvent, this.keyEvent, this.userInputEvent, this.focusEvent, this.blurEvent]) emitter.clear();
  }

  private triggerData(data: string, wasUserInput = false): void {
    if (this.disableStdin || this.listeners.signal.aborted) return;
    if (wasUserInput) {
      this.host.scrollOnUserInput?.();
      this.userInputEvent.fire();
    }
    this.dataEvent.fire(data);
  }

  private triggerBinary(data: string): void {
    if (!this.disableStdin && !this.listeners.signal.aborted) this.binaryEvent.fire(data);
  }

  private bindEvents(): void {
    const { element, screen } = this.host;
    const { textarea } = this;
    const signal = this.listeners.signal;
    const capture = { capture: true, signal };
    textarea.addEventListener("focus", () => {
      if (this.host.modes().sendFocus) this.triggerData(C0.ESC + "[I");
      element.classList.add("focus");
      this.focusEvent.fire();
    }, { signal });
    textarea.addEventListener("blur", () => {
      this._sendTextKey();
      this._digitAwaitsKeyPress = false;
      this._composition.finishReplacement();
      textarea.value = "";
      if (this.host.modes().sendFocus) this.triggerData(C0.ESC + "[O");
      element.classList.remove("focus");
      this.blurEvent.fire();
    }, { signal });
    textarea.addEventListener("keyup", (ev) => this._keyUp(ev), capture);
    textarea.addEventListener("keydown", (ev) => this._keyDown(ev), capture);
    textarea.addEventListener("keypress", (ev) => this._keyPress(ev), capture);
    textarea.addEventListener("compositionstart", () => this._composition.compositionstart(), { signal });
    textarea.addEventListener("compositionupdate", (ev) => this._composition.compositionupdate(ev), { signal });
    textarea.addEventListener("compositionend", () => this._composition.compositionend(), { signal });
    textarea.addEventListener("beforeinput", (ev: InputEvent) => {
      // The matching insertion belongs to a whole-string key, not a preedit.
      if (ev.inputType === "insertText" && ev.data === this._textKey?.text) return;
      this._composition.beforeinput(ev, this._keyDownSeen);
    }, capture);
    textarea.addEventListener("input", (ev: InputEvent) => this._inputEvent(ev), capture);

    element.addEventListener("copy", (ev) => {
      if (!this.host.hasSelection?.() || !this.host.selectionText) return;
      ev.clipboardData?.setData("text/plain", this.host.selectionText());
      ev.preventDefault();
    }, { signal });
    const onPaste = (ev: ClipboardEvent) => {
      this._composition.finishReplacement();
      handlePasteEvent(ev, this.pasteText);
    };
    textarea.addEventListener("paste", onPaste, { signal });
    element.addEventListener("paste", onPaste, { signal });

    const rightClick = (ev: MouseEvent) => rightClickHandler(ev, textarea, screen,
      () => this.host.selectionText?.() ?? "", (event) => {
        if (this.host.rightClickSelectsWord ?? this.platform.isMac) this.host.selectWordAt?.(event);
      });
    if (this.platform.isFirefox) {
      element.addEventListener("mousedown", (ev) => { if (ev.button === 2) rightClick(ev); }, { signal });
    } else {
      element.addEventListener("contextmenu", rightClick, { signal });
    }
    if (this.platform.isLinux) {
      element.addEventListener("auxclick", (ev) => { if (ev.button === 1) moveTextAreaUnderMouseCursor(ev, textarea, screen); }, { signal });
    }
  }

  private pasteText = (text: string): void => {
    paste(text, this.textarea, this.host.modes().bracketedPaste && !this.host.ignoreBracketedPasteMode,
      (data) => this.triggerData(data, true));
  };

  private _keyDown(event: KeyboardEvent): boolean | undefined {
    this._sendTextKey();
    this._keyDownHandled = false;
    this._keyDownSeen = true;
    this._digitAwaitsKeyPress = false;

    if (this._customKeyEventHandler && this._customKeyEventHandler(event) === false) {
      return false;
    }

    // An iPad's or iPhone's Korean input method composes this key in the editor; keypress must not send it either
    if (this._composition.passHangulKey(event)) {
      this._keyDownHandled = true;
      return false;
    }

    // Ignore composing with Alt key on Mac when macOptionIsMeta is enabled
    const shouldIgnoreComposition = this.platform.isMac && this.host.macOptionIsMeta === true && event.altKey;

    const wasComposing = this._composition.isComposing === true;
    if (!shouldIgnoreComposition && !this._composition.keydown(event)) {
      this.host.scrollOnUserInput?.();
      return false;
    }

    if (!shouldIgnoreComposition && (event.key === 'Dead' || event.key === 'AltGraph')) {
      this._unprocessedDeadKey = true;
    }

    const result = evaluateKeyboardEvent(event, this.host.modes().applicationCursorKeys, this.platform.isMac, this.host.macOptionIsMeta === true);

    if (result.type === KeyboardResultType.PAGE_DOWN || result.type === KeyboardResultType.PAGE_UP) {
      const scrollCount = this.host.rows() - 1;
      this.host.scrollLines?.(result.type === KeyboardResultType.PAGE_UP ? -scrollCount : scrollCount);
      return this.cancel(event, true);
    }

    if (result.type === KeyboardResultType.SELECT_ALL) {
      this.host.selectAll?.();
    }

    if (this._isThirdLevelShift(this.platform, event)) {
      return true;
    }

    if (result.cancel) {
      // The event is canceled at the end already, is this necessary?
      this.cancel(event, true);
    }

    if (!result.key) {
      return true;
    }

    // HACK: Process A-Z in the keypress event to fix an issue with macOS IMEs where lower case
    // letters cannot be input while caps lock is on.
    if (event.key && !event.ctrlKey && !event.altKey && !event.metaKey && event.key.length === 1) {
      if (event.key.charCodeAt(0) >= 65 && event.key.charCodeAt(0) <= 90) {
        return true;
      }
    }

    // A Linux input method without in-app preedit picks a candidate with a digit key: the keydown
    // names the digit, and the keypress and input that follow carry the candidate (xterm.js #6036).
    // Send the digit from those events, as Space already is.
    if (this.platform.isLinux && !this.host.screenReaderMode?.() && event.key && !event.ctrlKey && !event.altKey && !event.metaKey && /^[0-9]$/.test(event.key)) {
      this._digitAwaitsKeyPress = true;
      return true;
    }

    if (this._unprocessedDeadKey) {
      this._unprocessedDeadKey = false;
      return true;
    }

    // If ctrl+c or enter is being sent, clear out the textarea. This is done so that screen readers
    // will announce deleted characters. This will not work 100% of the time but it should cover
    // most scenarios.
    // Gboard expects a Backspace to update its editor. We send DEL to the PTY and
    // cancel the DOM edit, so retaining this text leaves its next composition using
    // stale surrounding text (e.g. 한글 becomes ㅎㅏㄴ글 after deleting). Any other
    // control key (an arrow, Home, Tab, Esc, ^A, Alt+B) can move the shell cursor off
    // the end of this text, where the 229 fallback sends its DELs (#2836). Reset the
    // scratch editor only outside composition; screen readers own their DOM edits.
    const controlKey = result.key.charCodeAt(0) < 0x20 || result.key.charCodeAt(0) === 0x7f;
    const clearAfterControlKey = controlKey && !wasComposing && !event.isComposing
      && !this.host.screenReaderMode?.();
    if (result.key === C0.ETX || result.key === C0.CR || clearAfterControlKey) {
      this.textarea.value = '';
    }

    this.keyEvent.fire({ key: result.key, domEvent: event });
    this.triggerData(result.key, true);

    // Cancel events when not in screen reader mode so events don't get bubbled up and handled by
    // other listeners. When screen reader mode is enabled, we don't cancel them (unless ctrl or alt
    // is also depressed) so that the cursor textarea can be updated, which triggers the screen
    // reader to read it.
    if (!this.host.screenReaderMode?.() || event.altKey || event.ctrlKey) {
      return this.cancel(event, true);
    }

    this._keyDownHandled = true;
  }

  private _isThirdLevelShift(browser: InputPlatform, ev: KeyboardEvent): boolean {
    const thirdLevelKey =
      (browser.isMac && !this.host.macOptionIsMeta && ev.altKey && !ev.ctrlKey && !ev.metaKey) ||
      (browser.isWindows && ev.altKey && ev.ctrlKey && !ev.metaKey) ||
      (browser.isWindows && ev.getModifierState('AltGraph'));

    if (ev.type === 'keypress') {
      return thirdLevelKey;
    }

    // Don't invoke for arrows, pageDown, home, backspace, etc. (on non-keypress events)
    return thirdLevelKey && (!ev.keyCode || ev.keyCode > 47);
  }

  private _keyUp(ev: KeyboardEvent): void {
    this._sendTextKey();
    this._keyDownSeen = false;
    this._digitAwaitsKeyPress = false;

    if (this._customKeyEventHandler && this._customKeyEventHandler(ev) === false) {
      return;
    }

    if (!wasModifierKeyOnlyEvent(ev)) {
      this.focus();
    }

    this._keyPressHandled = false;
  }

  /**
   * Handle a keypress event.
   * Key Resources:
   *   - https://developer.mozilla.org/en-US/docs/DOM/KeyboardEvent
   * @param ev The keypress event to be handled.
   */
  private _keyPress(ev: KeyboardEvent): boolean {
    let key;

    this._sendTextKey();

    this._keyPressHandled = false;

    if (this._keyDownHandled) {
      return false;
    }

    if (this._customKeyEventHandler && this._customKeyEventHandler(ev) === false) {
      return false;
    }

    this.cancel(ev);

    if (ev.charCode) {
      key = ev.charCode;
    } else if (ev.which === null || ev.which === undefined) {
      key = ev.keyCode;
    } else if (ev.which !== 0 && ev.charCode !== 0) {
      key = ev.which;
    } else {
      return false;
    }

    if (!key || (
      (ev.altKey || ev.ctrlKey || ev.metaKey) && !this._isThirdLevelShift(this.platform, ev)
    )) {
      return false;
    }

    const charCode = key;
    key = String.fromCharCode(charCode);

    // An iOS keyboard that commits a whole string at once (dictation, a keyboard extension's
    // insertText) names it as the key and its first character as the charCode, then inserts it.
    // Hold that character: the insertion that follows sends the whole string instead (#1488). A key
    // name is never such a string (Enter's charCode is 13, not E). WebKit's charCode is the first
    // code point, which may lie outside the BMP (an emoji, or a CJK extension character).
    if (this._keyDownSeen && ev.key && ev.key.length > 1 && ev.key.codePointAt(0) === charCode && !this.host.screenReaderMode?.()
      && !this._composition.isComposing) {
      this._textKey = { text: ev.key, key: String.fromCodePoint(charCode), event: ev };
      this._keyPressHandled = true;
      this._unprocessedDeadKey = false;
      return true;
    }

    this.keyEvent.fire({ key, domEvent: ev });
    this.triggerData(key, true);

    this._keyPressHandled = true;

    // The key was handled so clear the dead key state, otherwise certain keystrokes like arrow
    // keys could be ignored
    this._unprocessedDeadKey = false;

    return true;
  }

  /**
   * Handle an input event.
   * Key Resources:
   *   - https://developer.mozilla.org/en-US/docs/Web/API/InputEvent
   * @param ev The input event to be handled.
   */
  private _inputEvent(ev: InputEvent): boolean {
    const textKey = this._textKey;
    if (textKey && ev.inputType === 'insertText' && ev.data === textKey.text) {
      this._textKey = undefined;
      this.keyEvent.fire({ key: textKey.text, domEvent: textKey.event });
      this.triggerData(textKey.text, true);
      this.cancel(ev);
      return true;
    }
    this._sendTextKey();
    if (this._composition.input(ev, this._keyDownSeen)) return true;
    // Only support emoji IMEs when screen reader mode is disabled as the event must bubble up to
    // support reading out character input which can doubling up input characters
    // Based on these event traces: https://github.com/xtermjs/xterm.js/issues/3679
    if (ev.data && ev.inputType === 'insertText' && (!ev.composed || !this._keyDownSeen || this._digitAwaitsKeyPress || this._composition.takeCommitInsert(ev)) && !this.host.screenReaderMode?.()) {
      if (this._keyPressHandled) {
        return false;
      }

      // The key was handled so clear the dead key state, otherwise certain keystrokes like arrow
      // keys could be ignored
      this._unprocessedDeadKey = false;

      const text = ev.data;
      this.triggerData(text, true);

      this.cancel(ev);
      return true;
    }

    return false;
  }

  /** No insertion carried the held whole-string key: send its keypress's character, as before. */
  private _sendTextKey(): void {
    const textKey = this._textKey;
    if (!textKey) return;
    this._textKey = undefined;
    this.keyEvent.fire({ key: textKey.key, domEvent: textKey.event });
    this.triggerData(textKey.key, true);
  }
}

function wasModifierKeyOnlyEvent(ev: KeyboardEvent): boolean {
  return ev.keyCode === 16 || ev.keyCode === 17 || ev.keyCode === 18;
}
