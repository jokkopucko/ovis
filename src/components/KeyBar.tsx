import { useCallback, useLayoutEffect, useRef, useSyncExternalStore, type MouseEvent, type PointerEvent, type ReactNode } from "react";
import { ClipboardPaste, Keyboard, PanelBottomClose, PanelBottomOpen } from "lucide-react";

import "./KeyBar.css";

import type { KeyBarKey, StickyModifiers } from "../lib/keys.ts";
import { keyBarItemId, keyBarItemLabel, type KeyBarItem, type KeyBarKeyItem } from "../lib/keyBar.ts";
import { createKeyRepeat, isRepeatableKeyBarItem, type KeyRepeat } from "../lib/keyRepeat.ts";
import { keyboardControl } from "../lib/keyboardControl.ts";
import { useT } from "../lib/i18n.ts";

export type { KeyBarKey };

export interface KeyBarProps {
  disabled?: boolean;
  /** Changing the terminal target or lens cancels any held arrow. */
  holdScope?: string;
  /** Modifier buttons toggle; other keys go to the terminal. */
  onKey: (item: KeyBarKeyItem) => void;
  modifiers: StickyModifiers;
  onToggleModifier: (modifier: keyof StickyModifiers) => void;
  items: readonly KeyBarItem[];
  /** on a touch screen: whether the keyboard types straight into the terminal (else the input line) */
  directTyping?: boolean;
  onToggleDirect?: () => void;
  /** greys out only the direct-typing toggle (an input-line composition is in progress) */
  directDisabled?: boolean;
  /** on a touch screen: pastes the clipboard into the terminal's input line (never into the grid), from this tap */
  onPaste?: () => void;
  /** greys out only Paste (a paste of the line's still waits on the clipboard) */
  pasteDisabled?: boolean;
  /** a word about Paste, said in the bar's own row after its fixed controls (the mode toggle, Paste
   * and the keyboard control), in place of the other keys until it is dismissed (a tap on it); never
   * painted over the terminal */
  note?: string | null;
  onNoteDismiss?: () => void;
  /**
   * on a touch screen: shows or hides the soft keyboard for the current input mode, without a key,
   * a mode change or a resize; the control says its tap's word (lib/keyboardControl.ts)
   */
  onToggleKeyboard?: () => void;
  /** the pane the control belongs to: a tap in flight is its own pane's word (lib/keyboardControl.ts) */
  keyboardOwner?: string;
  /** greys out only the keyboard control: no field it may focus (offline, held, ended, not ready) */
  keyboardDisabled?: boolean;
  /** the keyboard control refuses its tap, keeping the focus and the composition a blur would end,
   * and while a paste reads the clipboard (the paste's own focus would bring a hidden keyboard back) */
  keyboardRefused?: boolean;
}

/**
 * Cancelling pointerdown AND mousedown keeps focus, and with it the soft
 * keyboard, on xterm's textarea; the click still fires.
 */
function keepFocus(event: PointerEvent<HTMLButtonElement> | MouseEvent<HTMLButtonElement>): void {
  event.preventDefault();
}

interface KeyProps {
  disabled?: boolean;
  /**
   * live, so a press still keeps the focus where it is, but doing nothing (aria-disabled): a
   * disabled button would let the press move the focus, and end the composition it was guarding
   */
  refused?: boolean;
  /**
   * a command no hardware keyboard has (the keyboard control): a Tab stop, with its name as the
   * tooltip, where a key is neither. A press still keeps the focus where it is (keepFocus)
   */
  command?: boolean;
  dataKey: string;
  label?: string;
  pressed?: boolean;
  onPress: () => void;
  repeatable?: boolean;
  holdScope?: string;
  children: ReactNode;
}

function Key({ dataKey, label, pressed, onPress, children, disabled, refused, command, repeatable, holdScope }: KeyProps) {
  const onPressRef = useRef(onPress);
  onPressRef.current = onPress;
  const disabledRef = useRef(disabled);
  disabledRef.current = disabled;
  const pointerRef = useRef({ id: null as number | null, pendingClick: false, cancelClick: false });
  const repeatRef = useRef<KeyRepeat | null>(null);
  if (repeatable && repeatRef.current === null) {
    repeatRef.current = createKeyRepeat(() => {
      if (!disabledRef.current) onPressRef.current();
    });
  }

  const cancelHold = useCallback(() => {
    const pointer = pointerRef.current;
    if (pointer.pendingClick) pointer.cancelClick = true;
    pointer.id = null;
    repeatRef.current?.cancel();
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
      className={`key${pressed ? " is-armed" : ""}`}
      data-key={dataKey}
      aria-label={label}
      aria-pressed={pressed}
      aria-disabled={refused || undefined}
      title={command ? label : undefined}
      tabIndex={command ? 0 : -1}
      onPointerDown={(event) => {
        keepFocus(event);
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
        repeatRef.current?.release();
        // Ignore the lost capture that follows release, preserving the click gate.
        pointerRef.current.id = null;
      } : undefined}
      onPointerCancel={repeatable ? cancelPointer : undefined}
      onLostPointerCapture={repeatable ? cancelPointer : undefined}
      onMouseDown={keepFocus}
      onContextMenu={keepFocus}
      onClick={() => {
        if (refused) return;
        if (!repeatable) {
          onPress();
          return;
        }
        const pointer = pointerRef.current;
        const allowed = repeatRef.current?.takeClick() ?? true;
        const cancelled = pointer.cancelClick;
        pointer.pendingClick = false;
        pointer.cancelClick = false;
        if (allowed && !cancelled && !disabled) onPress();
      }}
    >
      {children}
    </button>
  );
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

/**
 * Spoken names for the keys whose cap (lib/keyBar.ts CAPS) is a symbol or an abbreviation a
 * screen reader would spell out; a cap that is a word (Tab, Enter, Home, End, Space, F1) is its
 * own name. The arrows' names are in ARROWS.
 */
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
];

/**
 * Touch key bar under the terminal. Keys are tabIndex -1 on purpose: they exist
 * for touch, a hardware keyboard already has all of them. Hence role="group", not
 * toolbar: a toolbar promises arrow-key navigation between items, which these skip.
 * The keyboard control is no key a hardware keyboard has, so it is a Tab stop.
 */
export function KeyBar({ onKey, modifiers, onToggleModifier, items, directTyping, onToggleDirect, directDisabled, onPaste, pasteDisabled, note, onNoteDismiss, onToggleKeyboard, keyboardOwner = "", keyboardDisabled, keyboardRefused, disabled, holdScope }: KeyBarProps) {
  const t = useT();
  // the control says what its next tap does, not what a mid-animation keyboard measures
  const keyboardView = useCallback(() => keyboardControl.view(keyboardOwner), [keyboardOwner]);
  const keyboard = useSyncExternalStore(keyboardControl.subscribe, keyboardView, keyboardView);
  // only a bar that reaches the bottom of the screen keeps clear of the home indicator: a pane
  // stacked over another one has the other pane under its bar, not the indicator
  const barRef = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    const bar = barRef.current;
    if (!bar) return;
    const place = (): void => {
      // measured without the room the class adds, which would otherwise keep itself
      bar.classList.remove("is-at-screen-bottom");
      bar.classList.toggle("is-at-screen-bottom", bar.getBoundingClientRect().bottom >= window.innerHeight - 1);
    };
    place();
    // the pane's own frame and what holds it change size on a split or zoom with the page unchanged
    const observer = new ResizeObserver(place);
    for (let node: HTMLElement | null = bar.parentElement; node; node = node.parentElement) observer.observe(node);
    window.addEventListener("resize", place);
    return () => { observer.disconnect(); window.removeEventListener("resize", place); };
  }, []);
  // the edge with keys out of view fades (KeyBar.css reads the attributes): measured before the
  // first paint, then on scroll and whenever the bar or a key changes size, at most once a frame
  const hasDirectToggle = onToggleDirect !== undefined;
  const hasPaste = onPaste !== undefined;
  const hasKeyboardToggle = onToggleKeyboard !== undefined;
  useLayoutEffect(() => {
    const bar = barRef.current;
    if (!bar) return;
    let frame = 0;
    const measure = (): void => {
      frame = 0;
      const hidden = bar.scrollWidth - bar.clientWidth;
      bar.toggleAttribute("data-overflow-start", bar.scrollLeft >= 1);
      bar.toggleAttribute("data-overflow-end", hidden - bar.scrollLeft >= 1);
    };
    const schedule = (): void => {
      if (frame === 0) frame = requestAnimationFrame(measure);
    };
    measure();
    bar.addEventListener("scroll", schedule, { passive: true });
    const observer = new ResizeObserver(schedule);
    observer.observe(bar);
    for (const key of bar.children) observer.observe(key);
    return () => {
      cancelAnimationFrame(frame);
      bar.removeEventListener("scroll", schedule);
      observer.disconnect();
    };
  }, [items, hasDirectToggle, hasPaste, hasKeyboardToggle, note]);
  /** The key's name as it is said: its spoken name where its cap is notation, else its cap. */
  const spokenKey = (item: KeyBarKeyItem): string => {
    const spoken = ARROWS.find((candidate) => candidate.key === item.key)?.label ?? KEY_SPOKEN_NAMES.find((candidate) => candidate.key === item.key)?.label;
    return spoken === undefined ? keyBarItemLabel({ type: "key", key: item.key }) : t(spoken);
  };
  return (
    <div className="key-bar" ref={barRef} role="group" aria-label={t("Terminal keys")}>
      {/* first: on a narrow cover screen the row scrolls, and the keyboard controls must not be the keys cut off */}
      {onToggleDirect && (
        <Key disabled={disabled || directDisabled} dataKey="direct" label={t("Input line")} pressed={!directTyping} onPress={onToggleDirect}>
          <Keyboard aria-hidden="true" />
        </Key>
      )}
      {/* beside the mode toggle it belongs with: a tap, never a hold (a repeat would read the clipboard again) */}
      {onPaste && (
        <Key disabled={disabled || pasteDisabled} dataKey="paste" label={t("Paste into the input line")} onPress={onPaste}>
          <ClipboardPaste aria-hidden="true" />
        </Key>
      )}
      {/* after the mode switch and Paste, and unlike the switch: this one moves the keyboard, not the
          typing. Its glyph is the panel at the screen's bottom with the way it goes next, its name says
          the same, and its pressed state is the tap's word (lib/keyboardControl.ts) */}
      {onToggleKeyboard && (
        <Key disabled={keyboardDisabled} refused={keyboardRefused} command dataKey="keyboard" label={t(keyboard.direction === "hide" ? "Hide keyboard" : "Show keyboard")} pressed={keyboard.direction === "hide"} onPress={onToggleKeyboard}>
          {keyboard.direction === "hide" ? <PanelBottomClose aria-hidden="true" /> : <PanelBottomOpen aria-hidden="true" />}
        </Key>
      )}
      {note ? <p className="key-bar-note" role="status" onClick={onNoteDismiss}>{note}</p> : items.map((item) => {
        if (item.type === "modifier") {
          const cap = { ctrl: "Ctrl", alt: "Alt", shift: "Shift" }[item.modifier];
          const dataKey = { ctrl: "Control", alt: "Alt", shift: "Shift" }[item.modifier];
          // Alt and Shift are said as written; Ctrl is not
          const label = item.modifier === "ctrl" ? t("Control") : undefined;
          return <Key key={keyBarItemId(item)} disabled={disabled} dataKey={dataKey} label={label} pressed={modifiers[item.modifier]} onPress={() => onToggleModifier(item.modifier)}>{cap}</Key>;
        }
        const arrow = ARROWS.find((candidate) => candidate.key === item.key);
        const spoken = spokenKey(item);
        // a chord keeps the notation Settings writes it in (Ctrl+Alt+Shift+key), its base key said
        const label = item.modifiers !== undefined
          ? t("Press {key}", { key: [item.modifiers.ctrl && "Ctrl", item.modifiers.alt && "Alt", item.modifiers.shift && "Shift", spoken].filter(Boolean).join("+") })
          : spoken === keyBarItemLabel(item) ? undefined : spoken;
        return <Key key={keyBarItemId(item)} disabled={disabled} dataKey={item.modifiers === undefined ? item.key : keyBarItemId(item)} label={label} onPress={() => onKey(item)}
          repeatable={isRepeatableKeyBarItem(item)} holdScope={holdScope}>
          {arrow && item.modifiers === undefined ? <Chevron direction={arrow.direction} /> : keyBarItemLabel(item)}
        </Key>;
      })}
    </div>
  );
}
