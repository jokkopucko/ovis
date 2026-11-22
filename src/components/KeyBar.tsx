import { useCallback, useId, useLayoutEffect, useMemo, useRef, useSyncExternalStore, type MouseEvent, type PointerEvent, type ReactNode } from "react";
import { ChevronDown, ChevronUp, ClipboardPaste, Ellipsis, Keyboard, PanelBottomClose, PanelBottomOpen, Paperclip } from "lucide-react";

import "./KeyBar.css";

import type { KeyBarKey, StickyModifiers } from "../lib/keys.ts";
import { KEY_BAR_SECOND_ROW, keyBarItemId, keyBarItemLabel, keyBarRowItems, type KeyBarItem, type KeyBarKeyItem } from "../lib/keyBar.ts";
import { createKeyRepeat, isRepeatableKeyBarItem, type KeyRepeat } from "../lib/keyRepeat.ts";
import { keyboardUp } from "../lib/keyboard.ts";
import { keyboardControl } from "../lib/keyboardControl.ts";
import { useT } from "../lib/i18n.ts";

export type { KeyBarKey };

export interface KeyBarProps {
  disabled?: boolean;
  holdScope?: string;
  onKey: (item: KeyBarKeyItem, repeat: boolean) => void;
  onKeyHoldEnd?: () => void;
  modifiers: StickyModifiers;
  lockedModifiers?: StickyModifiers;
  onToggleModifier: (modifier: keyof StickyModifiers) => void;
  items: readonly KeyBarItem[];
  expanded?: boolean;
  onToggleExpanded?: () => void;
  directTyping?: boolean;
  onToggleDirect?: () => void;
  directDisabled?: boolean;
  /** on a touch screen: pastes the clipboard into the terminal's input line (never into the grid), from this tap */
  onPaste?: () => void;
  pasteDisabled?: boolean;
  note?: string | null;
  onNoteDismiss?: () => void;
  onToggleKeyboard?: () => void;
  keyboardOwner?: string;
  keyboardDisabled?: boolean;
  keyboardRefused?: boolean;
  onAttach?: () => ((files: File[]) => void) | null;
}

/**
 * Cancelling pointerdown AND mousedown keeps focus, and with it the soft
 * keyboard, on xterm's textarea; the click still fires.
 */
function keepFocus(event: PointerEvent<HTMLButtonElement> | MouseEvent<HTMLButtonElement>): void {
  event.preventDefault();
}

/**
 * Android's Back puts the soft keyboard away but leaves the field focused, and Chrome raises the
 * keyboard again on any tap while a text field has the focus, a key's tap too (#3274). For the touch
 * of a key that leaves the focus where it is (a key, a modifier, More keys) while the keyboard is
 * down, the focused field asks for no keyboard (inputmode=none); it gets its own inputmode back once
 * the tap's click is handled, at the next press anywhere, or when it loses the focus. With the
 * keyboard up nothing is touched: switching a focused field to inputmode=none makes Android's IME
 * hide the keyboard that is showing.
 */
let keyboardHold: (() => void) | null = null;
function releaseKeyboardHold(): void {
  const release = keyboardHold;
  keyboardHold = null;
  release?.();
}
function holdKeyboardForTap(): void {
  releaseKeyboardHold();
  if (keyboardUp()) return;
  const field = document.activeElement;
  if (!(field instanceof HTMLElement) || !(field.matches("textarea, input") || field.isContentEditable)) return;
  const previous = field.getAttribute("inputmode");
  if (previous === "none") return;
  field.setAttribute("inputmode", "none");
  keyboardHold = (): void => {
    document.removeEventListener("pointerdown", releaseKeyboardHold, true);
    field.removeEventListener("blur", releaseKeyboardHold);
    if (field.getAttribute("inputmode") !== "none") return;
    if (previous === null) field.removeAttribute("inputmode");
    else field.setAttribute("inputmode", previous);
  };
  // added while this press is dispatched, past the document's capture phase: the next press ends it
  document.addEventListener("pointerdown", releaseKeyboardHold, true);
  field.addEventListener("blur", releaseKeyboardHold);
}

interface KeyProps {
  disabled?: boolean;
  /**
   * live, so a press still keeps the focus where it is, but doing nothing (aria-disabled): a
   * disabled button would let the press move the focus, and end the composition it was guarding
   */
  refused?: boolean;
  command?: boolean;
  describedBy?: string;
  holdsKeyboard?: boolean;
  dataKey: string;
  label?: string;
  pressed?: boolean;
  latch?: "once" | "locked";
  expanded?: boolean;
  onPress: (repeat: boolean) => void;
  onHoldEnd?: () => void;
  repeatable?: boolean;
  holdScope?: string;
  children: ReactNode;
}

function Key({ dataKey, label, pressed, latch, expanded, onPress, onHoldEnd, children, disabled, refused, command, describedBy, holdsKeyboard, repeatable, holdScope }: KeyProps) {
  const onPressRef = useRef(onPress);
  onPressRef.current = onPress;
  const onHoldEndRef = useRef(onHoldEnd);
  onHoldEndRef.current = onHoldEnd;
  const disabledRef = useRef(disabled);
  disabledRef.current = disabled;
  const pointerRef = useRef({ id: null as number | null, pendingClick: false, cancelClick: false });
  const repeatRef = useRef<KeyRepeat | null>(null);
  if (repeatable && repeatRef.current === null) {
    repeatRef.current = createKeyRepeat(() => {
      if (!disabledRef.current) onPressRef.current(true);
    });
  }

  const cancelHold = useCallback(() => {
    const pointer = pointerRef.current;
    if (pointer.pendingClick) pointer.cancelClick = true;
    pointer.id = null;
    if (repeatRef.current?.cancel()) onHoldEndRef.current?.();
  }, []);

  useLayoutEffect(() => {
    if (!repeatable || disabled) {
      cancelHold();
      return;
    }
    const onVisibilityChange = (): void => {
      if (document.hidden) cancelHold();
    };
    window.addEventListener("blur", cancelHold);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      cancelHold();
      window.removeEventListener("blur", cancelHold);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [cancelHold, disabled, holdScope, repeatable]);

  const cancelPointer = (event: PointerEvent<HTMLButtonElement>): void => {
    if (pointerRef.current.id === event.pointerId) cancelHold();
  };
  return (
    <button
      type="button"
      disabled={disabled}
      className={`key${pressed ? " is-armed" : ""}${latch === "locked" ? " is-locked" : ""}`}
      data-key={dataKey}
      data-latch={latch}
      aria-label={label}
      aria-describedby={describedBy}
      aria-pressed={pressed}
      aria-expanded={expanded}
      aria-disabled={refused || undefined}
      title={command ? label : undefined}
      tabIndex={command ? 0 : -1}
      onPointerDown={(event) => {
        keepFocus(event);
        if (event.pointerType === "touch" && holdsKeyboard) holdKeyboardForTap();
        if (!repeatable || disabled || event.button !== 0 || !event.isPrimary || pointerRef.current.id !== null) return;
        const pointer = pointerRef.current;
        pointer.id = event.pointerId;
        pointer.pendingClick = true;
        pointer.cancelClick = false;
        repeatRef.current?.press(event.clientX, event.clientY);
        // Capture keeps release/move visible outside the key; browser panning can still cancel it.
        try { event.currentTarget.setPointerCapture(event.pointerId); } catch {}
      }}
      onPointerMove={repeatable ? (event) => {
        if (pointerRef.current.id !== event.pointerId) return;
        if (repeatRef.current?.move(event.clientX, event.clientY)) pointerRef.current.cancelClick = true;
      } : undefined}
      onPointerUp={repeatable ? (event) => {
        if (pointerRef.current.id !== event.pointerId) return;
        if (repeatRef.current?.release()) onHoldEndRef.current?.();
        // Ignore the lost capture that follows release, preserving the click gate.
        pointerRef.current.id = null;
      } : undefined}
      onPointerCancel={(event) => {
        // a touch that turned into the row's scroll brings no click
        releaseKeyboardHold();
        if (repeatable) cancelPointer(event);
      }}
      onLostPointerCapture={repeatable ? cancelPointer : undefined}
      onMouseDown={keepFocus}
      onContextMenu={keepFocus}
      onClick={() => {
        // Chrome raises the keyboard right after the tap's click: the field asks for none until then
        if (keyboardHold !== null) window.setTimeout(releaseKeyboardHold, 0);
        if (refused) return;
        if (!repeatable) {
          onPress(false);
          return;
        }
        const pointer = pointerRef.current;
        const allowed = repeatRef.current?.takeClick() ?? true;
        const cancelled = pointer.cancelClick;
        pointer.pendingClick = false;
        pointer.cancelClick = false;
        if (allowed && !cancelled && !disabled) onPress(false);
      }}
    >
      {children}
    </button>
  );
}

export function LineKeysButton({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  const t = useT();
  return <button type="button" className="terminal-input-action terminal-input-keys" aria-label={t("Terminal keys")} title={t("Terminal keys")} aria-pressed={open}
    onPointerDown={keepFocus} onMouseDown={keepFocus} onClick={onToggle}>
    <span className="terminal-input-face"><Ellipsis aria-hidden="true" /></span>
  </button>;
}

type Direction = "up" | "down" | "left" | "right";

const CHEVRON: Record<Direction, string> = {
  up: "M5 12.5l5-5 5 5",
  down: "M5 7.5l5 5 5-5",
  left: "M12.5 5l-5 5 5 5",
  right: "M7.5 5l5 5-5 5",
};

function Chevron({ direction }: { direction: Direction }) {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={CHEVRON[direction]} />
    </svg>
  );
}

export const ARROWS: ReadonlyArray<{ key: KeyBarKey; label: string; direction: Direction }> = [
  { key: "ArrowUp", label: "Up", direction: "up" },
  { key: "ArrowDown", label: "Down", direction: "down" },
  { key: "ArrowLeft", label: "Left", direction: "left" },
  { key: "ArrowRight", label: "Right", direction: "right" },
];

export const KEY_SPOKEN_NAMES: ReadonlyArray<{ key: string; label: string }> = [
  { key: "Escape", label: "Escape" },
  { key: "BackTab", label: "Shift Tab" },
  { key: "Backspace", label: "Backspace" },
  { key: "Delete", label: "Delete" },
  { key: "Insert", label: "Insert" },
  { key: "PageUp", label: "Page up" },
  { key: "PageDown", label: "Page down" },
  { key: "ctrl-c", label: "Control C" },
  { key: "ctrl-d", label: "Control D" },
  { key: "ctrl-z", label: "Control Z" },
  { key: "pipe", label: "Pipe" },
  { key: "tilde", label: "Tilde" },
  { key: "slash", label: "Slash" },
  { key: "-", label: "Minus" },
];

/**
 * Keys are tabIndex -1 on purpose: they exist for touch, a hardware keyboard already has all of
 * them. Hence role="group", not toolbar: a toolbar promises arrow-key navigation between items,
 * which these skip.
 */
export function KeyBar({ onKey, onKeyHoldEnd, modifiers, lockedModifiers, onToggleModifier, items, expanded = false, onToggleExpanded, directTyping, onToggleDirect, directDisabled, onPaste, pasteDisabled, note, onNoteDismiss, onToggleKeyboard, keyboardOwner = "", keyboardDisabled, keyboardRefused, onAttach, disabled, holdScope }: KeyBarProps) {
  const t = useT();
  const noteId = useId();
  const keyboardView = useCallback(() => keyboardControl.view(keyboardOwner), [keyboardOwner]);
  const keyboard = useSyncExternalStore(keyboardControl.subscribe, keyboardView, keyboardView);
  const barRef = useRef<HTMLDivElement | null>(null);
  const rowRef = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    const bar = barRef.current;
    if (!bar) return;
    const place = (): void => {
      // measured without the room the class adds, which would otherwise keep itself
      bar.classList.remove("is-at-screen-bottom");
      bar.classList.toggle("is-at-screen-bottom", bar.getBoundingClientRect().bottom >= window.innerHeight - 1);
    };
    place();
    const observer = new ResizeObserver(place);
    for (let node: HTMLElement | null = bar.parentElement; node; node = node.parentElement) observer.observe(node);
    window.addEventListener("resize", place);
    return () => { observer.disconnect(); window.removeEventListener("resize", place); };
  }, []);
  const rowItems = useMemo(() => keyBarRowItems(items, expanded), [items, expanded]);
  const hasDirectToggle = onToggleDirect !== undefined;
  const hasPaste = onPaste !== undefined;
  const hasKeyboardToggle = onToggleKeyboard !== undefined;
  const hasAttach = onAttach !== undefined;
  const picker = useRef<HTMLInputElement | null>(null);
  const attachTo = useRef<((files: File[]) => void) | null>(null);
  useLayoutEffect(() => {
    const bar = barRef.current;
    const row = rowRef.current;
    if (!bar || !row) return;
    let frame = 0;
    const measure = (): void => {
      frame = 0;
      const scroller = getComputedStyle(row).display === "contents" ? bar : row;
      for (const node of [bar, row]) {
        const hidden = node.scrollWidth - node.clientWidth;
        node.toggleAttribute("data-overflow-start", node === scroller && node.scrollLeft >= 1);
        node.toggleAttribute("data-overflow-end", node === scroller && hidden - node.scrollLeft >= 1);
      }
    };
    const schedule = (): void => {
      if (frame === 0) frame = requestAnimationFrame(measure);
    };
    measure();
    bar.addEventListener("scroll", schedule, { passive: true });
    row.addEventListener("scroll", schedule, { passive: true });
    const observer = new ResizeObserver(schedule);
    observer.observe(bar);
    observer.observe(row);
    for (const key of row.children) observer.observe(key);
    return () => {
      cancelAnimationFrame(frame);
      bar.removeEventListener("scroll", schedule);
      row.removeEventListener("scroll", schedule);
      observer.disconnect();
    };
  }, [rowItems, hasDirectToggle, hasPaste, hasKeyboardToggle, hasAttach, note, expanded]);
  const spokenKey = (item: KeyBarKeyItem): string => {
    const spoken = ARROWS.find((candidate) => candidate.key === item.key)?.label ?? KEY_SPOKEN_NAMES.find((candidate) => candidate.key === item.key)?.label;
    return spoken === undefined ? keyBarItemLabel({ type: "key", key: item.key }) : t(spoken);
  };
  const renderKey = (item: KeyBarKeyItem) => {
    const arrow = ARROWS.find((candidate) => candidate.key === item.key);
    const spoken = spokenKey(item);
    const label = item.modifiers !== undefined
      ? t("Press {key}", { key: [item.modifiers.ctrl && "Ctrl", item.modifiers.alt && "Alt", item.modifiers.shift && "Shift", spoken].filter(Boolean).join("+") })
      : spoken === keyBarItemLabel(item) ? undefined : spoken;
    return <Key key={keyBarItemId(item)} disabled={disabled} holdsKeyboard dataKey={item.modifiers === undefined ? item.key : keyBarItemId(item)} label={label} onPress={(repeat) => { onNoteDismiss?.(); onKey(item, repeat); }}
      onHoldEnd={item.modifiers === undefined ? onKeyHoldEnd : undefined} repeatable={isRepeatableKeyBarItem(item)} holdScope={holdScope}>
      {arrow && item.modifiers === undefined ? <Chevron direction={arrow.direction} /> : keyBarItemLabel(item)}
    </Key>;
  };
  const renderModifier = (modifier: keyof StickyModifiers) => {
    const cap = { ctrl: "Ctrl", alt: "Alt", shift: "Shift" }[modifier];
    const dataKey = { ctrl: "Control", alt: "Alt", shift: "Shift" }[modifier];
    const latch = !modifiers[modifier] ? undefined : lockedModifiers?.[modifier] ? "locked" : "once";
    const name = modifier === "ctrl" ? t("Control") : cap;
    const label = latch === "locked" ? t("{key}, locked", { key: name }) : modifier === "ctrl" ? name : undefined;
    return <Key key={`modifier:${modifier}`} disabled={disabled} holdsKeyboard dataKey={dataKey} label={label} pressed={modifiers[modifier]} latch={latch} onPress={() => { onNoteDismiss?.(); onToggleModifier(modifier); }}>{cap}</Key>;
  };
  return (
    <div className={`key-bar${expanded ? " is-expanded" : ""}`} ref={barRef} role="group" aria-label={t("Terminal keys")}>
      {expanded && <div className="key-bar-second-row">
        {KEY_BAR_SECOND_ROW.map((key) => renderKey({ type: "key", key }))}
      </div>}
      <div className="key-bar-row" ref={rowRef}>
        {onToggleDirect && (
          <Key disabled={disabled || directDisabled} command describedBy={note ? noteId : undefined} dataKey="direct" label={t("Input line")} pressed={!directTyping} onPress={onToggleDirect}>
            <Keyboard aria-hidden="true" />
          </Key>
        )}
        {/* beside the mode toggle it belongs with: a tap, never a hold (a repeat would read the clipboard again) */}
        {onPaste && (
          <Key disabled={disabled || pasteDisabled} command describedBy={note ? noteId : undefined} dataKey="paste" label={t("Paste into the input line")} onPress={onPaste}>
            <ClipboardPaste aria-hidden="true" />
          </Key>
        )}
        {onToggleKeyboard && (
          <Key disabled={keyboardDisabled} refused={keyboardRefused} command dataKey="keyboard" label={t(keyboard.direction === "hide" ? "Hide keyboard" : "Show keyboard")} pressed={keyboard.direction === "hide"} onPress={onToggleKeyboard}>
            {keyboard.direction === "hide" ? <PanelBottomClose aria-hidden="true" /> : <PanelBottomOpen aria-hidden="true" />}
          </Key>
        )}
        {onAttach && (
          <Key disabled={disabled} command dataKey="attach" label={t("Attach files")} onPress={() => {
            attachTo.current = onAttach();
            if (attachTo.current !== null) picker.current?.click();
          }}>
            <Paperclip aria-hidden="true" />
          </Key>
        )}
        {note && <p id={noteId} className="key-bar-note" role="status">{note}</p>}
        {rowItems.map((item) => item.type === "modifier" ? renderModifier(item.modifier) : renderKey(item))}
      </div>
      {expanded && <div className="key-bar-arrow-pad">
        {(["ArrowUp", "ArrowLeft", "ArrowDown", "ArrowRight"] as const).map((key) => renderKey({ type: "key", key }))}
      </div>}
      {onAttach && <input ref={picker} type="file" multiple hidden onChange={(event) => {
        const picked = Array.from(event.currentTarget.files ?? []);
        event.currentTarget.value = "";
        const attach = attachTo.current;
        attachTo.current = null;
        if (picked.length > 0 && attach !== null) attach(picked);
      }} />}
      {onToggleExpanded && (
        <Key command holdsKeyboard dataKey="more" label={t(expanded ? "Fewer keys" : "More keys")} expanded={expanded} onPress={onToggleExpanded}>
          {expanded ? <ChevronDown aria-hidden="true" /> : <ChevronUp aria-hidden="true" />}
        </Key>
      )}
    </div>
  );
}
