import { Fragment, useEffect, useId, useLayoutEffect, useRef, type FocusEvent, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Check, type LucideIcon } from "lucide-react";

import "./RowMenu.css";

import { useT } from "../lib/i18n.ts";
import { useMediaQuery } from "../lib/useMediaQuery.ts";
import { SHEET_QUERY, useSheetSwipe } from "../lib/sheets.ts";
import { BACK_QUERY, useSheetHistory } from "../lib/sheetHistory.ts";
import { typeAheadFocused } from "../lib/typeAhead.ts";
import { useRowMenuPosition } from "./useRowMenuPosition.ts";

export interface RowMenuItem {
  id: string;
  label: string;
  hint?: string;
  title?: string;
  icon: LucideIcon;
  glyph?: ReactNode;
  divider?: boolean;
  danger?: boolean;
  current?: boolean;
  checked?: boolean;
  /** shown with its state but not runnable here (a watching device and a shared switch): it keeps its place in the keyboard order, and a press on it leaves the menu open */
  disabled?: boolean;
  run: () => void;
  aside?: { label: string; icon: LucideIcon; run: () => void };
}

interface Props {
  anchor: HTMLElement;
  point?: { x: number; y: number };
  restoreFocusTo?: HTMLElement | null;
  title: string;
  subtitle?: string;
  alert?: string;
  detail?: string;
  header?: ReactNode;
  items: RowMenuItem[];
  align?: "start" | "end";
  onClose: () => void;
  variant?: "paths";
  choice?: boolean;
}

const TYPE_AHEAD_MS = 500;
const POPOVER_ITEMS = '[role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"]';
const SHEET_ITEMS = '.row-sheet-item, .row-sheet-aside, .row-sheet-cancel';
const CHOSEN = '.row-sheet-item[aria-checked="true"]';

const anchors = new WeakMap<Element, HTMLElement>();
export function rowMenuAnchor(node: Element): HTMLElement | null {
  const surface = node.closest(".row-menu, .row-sheet");
  return surface === null ? null : anchors.get(surface) ?? null;
}

export function RowMenu({ anchor, point, restoreFocusTo, title, subtitle, alert, detail, header, items, align = "end", onClose, variant, choice = false }: Props) {
  const t = useT();
  const sheet = useMediaQuery(SHEET_QUERY);
  const surface = useRef<HTMLDivElement>(null);
  const alertId = useId();
  const typed = useRef<{ text: string; at: number }>({ text: "", at: 0 });
  useSheetSwipe(surface, sheet ? onClose : null);
  useSheetHistory(useMediaQuery(BACK_QUERY), onClose);
  const place = useRowMenuPosition({ anchor, surface, point, align, sheet, onClose });
  // The press keeps the focus in the sheet: its blur would close it on the mousedown, and the mouseup
  // after it would land on what lies behind
  const pressedScrim = useRef(false);

  useLayoutEffect(() => {
    const node = surface.current;
    if (node === null) return;
    anchors.set(node, anchor);
    return () => { anchors.delete(node); };
  }, [anchor, sheet]);

  useLayoutEffect(() => () => {
    if (typeAheadFocused()) return;
    const target = restoreFocusTo === undefined ? anchor : restoreFocusTo;
    if (target?.isConnected) target.focus({ preventScroll: true });
  }, [anchor, restoreFocusTo]);

  useEffect(() => {
    const first = (sheet && choice ? surface.current?.querySelector<HTMLElement>(CHOSEN) : null) ?? surface.current?.querySelector<HTMLElement>(sheet ? SHEET_ITEMS : POPOVER_ITEMS);
    window.requestAnimationFrame(() => first?.focus());
  }, [sheet]);
  useLayoutEffect(() => {
    const node = surface.current;
    if (!sheet || !node || (document.activeElement !== null && document.activeElement !== document.body)) return;
    node.querySelector<HTMLElement>(SHEET_ITEMS)?.focus({ preventScroll: true });
  });

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      event.preventDefault();
      onClose();
    };
    const onPointer = (event: PointerEvent): void => {
      const target = event.target as Node;
      if (surface.current?.contains(target) || (!point && anchor.contains(target))) return;
      onClose();
    };
    window.addEventListener("keydown", onKey, true);
    // the popover goes on a press outside, which goes on to what was pressed. The sheet is modal and goes on its
    // scrim's click (below): closed on the press, its scrim would let the rest of that tap (the touch's end, the
    // mouse events and the click a browser sends after it) through to the row or the pane behind it
    if (!sheet) window.addEventListener("pointerdown", onPointer, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("pointerdown", onPointer, true);
    };
  }, [anchor, onClose, point, sheet]);

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    const stops = [...(surface.current?.querySelectorAll<HTMLElement>(sheet ? SHEET_ITEMS : POPOVER_ITEMS) ?? [])];
    const focused = document.activeElement as HTMLElement;
    const choices = sheet && choice ? stops.filter((button) => button.getAttribute("role") === "menuitemradio") : [];
    const inChoice = choices.includes(focused);
    const buttons = inChoice && event.key !== "Tab" ? choices : stops;
    const index = buttons.indexOf(focused);
    const move = (next: number): void => {
      event.preventDefault();
      buttons[point ? Math.max(0, Math.min(buttons.length - 1, next)) : (next + buttons.length) % buttons.length]?.focus();
    };
    if (event.key === "ArrowDown") move(index + 1);
    else if (event.key === "ArrowUp") move(index - 1);
    else if (event.key === "Home") move(0);
    else if (event.key === "End") move(buttons.length - 1);
    else if (event.key === "Tab" && sheet && choices.length > 0) {
      const stop = inChoice ? focused : choices.find((button) => button.getAttribute("aria-checked") === "true") ?? choices[0]!;
      const ring = stops.filter((button) => !choices.includes(button) || button === stop);
      event.preventDefault();
      ring[(ring.indexOf(inChoice ? stop : focused) + (event.shiftKey ? -1 : 1) + ring.length) % ring.length]?.focus();
    } else if (event.key === "Tab" && sheet) move(index + (event.shiftKey ? -1 : 1));
    else if (event.key === "Tab") { event.preventDefault(); onClose(); }
    else if (event.key.length === 1 && event.key !== " " && !event.ctrlKey && !event.metaKey && !event.altKey) {
      const now = event.timeStamp;
      const last = typed.current;
      const text = now - last.at <= TYPE_AHEAD_MS ? last.text + event.key : event.key;
      typed.current = { text, at: now };
      const wanted = (text.length > 1 && [...text].every((letter) => letter === text[0]) ? text[0]! : text).toLocaleLowerCase();
      const words = (button: HTMLElement): string => (button.getAttribute("aria-label") ?? button.textContent ?? "").trim().toLocaleLowerCase();
      const from = wanted === text.toLocaleLowerCase() && text.length > 1 ? index : index + 1;
      const found = buttons.map((_, offset) => buttons[(from + offset + buttons.length) % buttons.length]!).find((button) => words(button).startsWith(wanted));
      if (found) { event.preventDefault(); found.focus(); }
    }
  };

  const onBlur = (event: FocusEvent<HTMLDivElement>): void => {
    const next = event.relatedTarget as Node | null;
    if (next && (surface.current?.contains(next) || anchor.contains(next))) return;
    onClose();
  };
  // Safari on a Mac does not focus a clicked button, so the press would blur the focused item
  // with no relatedTarget, close the menu, and the click would land on nothing: the press keeps
  // the focus where it is, and the click still comes
  const keepFocus = (event: ReactMouseEvent<HTMLButtonElement>): void => event.preventDefault();

  const overModal = anchor.closest('[aria-modal="true"]') !== null;

  const run = (item: RowMenuItem): void => {
    if (item.disabled) return;
    onClose();
    item.run();
  };
  const runAside = (aside: NonNullable<RowMenuItem["aside"]>): void => {
    onClose();
    aside.run();
  };

  if (sheet) {
    return createPortal(
      <div className={`modal-scrim${overModal ? " is-over-modal" : ""}`} onPointerDown={(event) => { pressedScrim.current = event.target === event.currentTarget; }} onMouseDown={(event) => { if (event.target === event.currentTarget) event.preventDefault(); }} onClick={(event) => { if (event.target === event.currentTarget && pressedScrim.current) onClose(); }}>
        <div ref={surface} className="modal row-sheet" role="dialog" aria-modal="true" aria-label={title} onKeyDown={onKeyDown} onBlur={onBlur}>
          <span className="row-sheet-grip" aria-hidden="true" />
          {header ? <div className="row-sheet-head">{header}{alert && <span className="row-sheet-alert">{alert}</span>}{detail && <span className="row-sheet-detail">{detail}</span>}</div> : (
            <div className="row-sheet-head">
              <span className="row-sheet-title">{title}</span>
              {subtitle && <span className="row-sheet-subtitle">{subtitle}</span>}
              {alert && <span className="row-sheet-alert">{alert}</span>}
              {detail && <span className="row-sheet-detail">{detail}</span>}
            </div>
          )}
          <div className="row-sheet-items" role={choice ? "menu" : undefined} aria-label={choice ? title : undefined}>
            {items.map((item) => {
              const button = (
                <button key={item.id} type="button" data-item={item.id} className={`row-sheet-item${item.danger ? " is-danger" : ""}${item.divider && !item.aside ? " has-divider" : ""}${item.disabled ? " is-disabled" : ""}`} aria-current={item.current ? "true" : undefined} role={choice ? "menuitemradio" : undefined} aria-checked={choice ? item.checked === true : undefined} aria-pressed={choice ? undefined : item.checked} aria-disabled={item.disabled || undefined} title={item.title} onMouseDown={keepFocus} onMouseEnter={point ? (event) => event.currentTarget.focus({ preventScroll: true }) : undefined} onClick={() => run(item)}>
                  {item.glyph ?? <item.icon aria-hidden="true" />}
                  <span className="row-sheet-label">{item.label}</span>
                  {item.hint && <span className="row-sheet-hint">{item.hint}</span>}
                  {item.checked && <Check className="row-sheet-check" aria-hidden="true" />}
                </button>
              );
              if (!item.aside) return button;
              const { aside } = item;
              return (
                <div key={item.id} className={`row-sheet-line${item.divider ? " has-divider" : ""}${item.current ? " is-current" : ""}`}>
                  {button}
                  <button type="button" className="row-sheet-aside" aria-label={aside.label} title={aside.label} onMouseDown={keepFocus} onClick={() => runAside(aside)}>
                    <aside.icon aria-hidden="true" />
                  </button>
                </div>
              );
            })}
          </div>
          <button type="button" className="btn row-sheet-cancel" onMouseDown={keepFocus} onClick={onClose}>{t("Cancel")}</button>
        </div>
      </div>,
      document.body,
    );
  }

  return createPortal(
    <div ref={surface} className={`menu row-menu${overModal ? " is-over-modal" : ""}${variant === "paths" ? " row-menu-paths" : ""}`} role="menu" aria-label={title} aria-describedby={alert ? alertId : undefined} style={place ?? { visibility: "hidden" }} onKeyDown={onKeyDown} onBlur={onBlur}>
      {/* the reason describes the menu: a screen reader inside a menu reads its items, and nothing that stands between them */}
      {(header || alert) && <div className="row-menu-header" role="presentation">{header}{alert && <span id={alertId} className="row-menu-alert">{alert}</span>}</div>}
      {items.map((item) => (
        <Fragment key={item.id}>
          {item.divider && <span className="row-menu-divider" role="separator" />}
          <button type="button" data-item={item.id} role={choice ? "menuitemradio" : item.checked === undefined ? "menuitem" : "menuitemcheckbox"} aria-checked={choice ? item.checked === true : item.checked} className={`menu-item${item.danger ? " is-danger" : ""}${item.disabled ? " is-disabled" : ""}`} aria-current={item.current ? "true" : undefined} aria-disabled={item.disabled || undefined} title={item.title} onMouseDown={keepFocus} onMouseEnter={point ? (event) => event.currentTarget.focus({ preventScroll: true }) : undefined} onClick={() => run(item)}>
            {item.glyph ?? <item.icon aria-hidden="true" />}
            <span className="menu-item-main">{item.label}</span>
            {item.hint && <span className="menu-item-hint">{item.hint}</span>}
            {item.checked && <Check className="menu-item-check" aria-hidden="true" />}
          </button>
          {item.aside && <button type="button" role="menuitem" className="menu-item row-menu-aside" aria-label={item.aside.label} title={item.aside.label} onMouseDown={keepFocus} onClick={() => runAside(item.aside!)}>
            <item.aside.icon aria-hidden="true" />
            <span className="menu-item-main">{item.aside.label}</span>
          </button>}
        </Fragment>
      ))}
    </div>,
    document.body,
  );
}
