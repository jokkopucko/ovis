import { Children, cloneElement, createContext, Fragment, isValidElement, useContext, useEffect, useId, useLayoutEffect, useRef, useState, type ComponentProps, type CSSProperties, type FocusEvent as ReactFocusEvent, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { ChevronDown, ChevronRight, Minus, Plus, RotateCcw, type LucideIcon } from "lucide-react";

import { DEFAULT_SETTINGS, useSettings, type Settings } from "../lib/settings.ts";
import { useT } from "../lib/i18n.ts";
import { focusInOtherModal } from "../lib/useFocusTrap.ts";

import "./SettingsControls.css";

export const SettingsQuery = createContext<readonly string[]>([]);

export const SettingsBare = createContext<boolean | "rows">(false);

const folded = (text: string): string => text.normalize("NFKC").toLocaleLowerCase();

export function settingsQueryWords(query: string): string[] {
  return folded(query).split(/\s+/).filter((word) => word !== "");
}

function textOf(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join(" ");
  if (isValidElement<{ children?: ReactNode; "aria-label"?: unknown; placeholder?: unknown; title?: unknown }>(node)) {
    const { children, "aria-label": ariaLabel, placeholder, title } = node.props;
    return [textOf(children), ariaLabel, placeholder, title].filter((part): part is string => typeof part === "string" && part !== "").join(" ");
  }
  return "";
}

export function matchesSettingsQuery(words: readonly string[], ...texts: ReactNode[]): boolean {
  const shown = folded(texts.map(textOf).join(" "));
  return words.every((word) => shown.includes(word));
}

/** Native details, so the browser's find-in-page opens it too. */
export function SettingsFold({ kind, keys, elsewhere = 0, children }: { kind: "more" | "experimental"; keys: readonly (keyof Settings)[]; elsewhere?: number; children: ReactNode }) {
  const t = useT();
  const words = useContext(SettingsQuery);
  const { settings } = useSettings();
  if (words.length > 0) return <>{children}</>;
  const changed = keys.filter((key) => JSON.stringify(settings[key]) !== JSON.stringify(DEFAULT_SETTINGS[key])).length + elsewhere;
  return (
    <details className="settings-fold" data-fold={kind}>
      <summary>
        <ChevronRight className="settings-fold-chevron" aria-hidden="true" />
        <span className="settings-fold-title">{kind === "more" ? t("More settings") : t("Experimental")}</span>
        {changed > 0 && <span className="settings-fold-changed">{t("{count} changed", { count: changed })}</span>}
      </summary>
      <div className="settings-fold-body">{children}</div>
    </details>
  );
}

export function SettingsGroup({ title, note, className, section, heading = false, keepNote = false, children }: { title?: string; note?: ReactNode; className?: string; section?: string; heading?: boolean; keepNote?: boolean; children: ReactNode }) {
  const words = useContext(SettingsQuery);
  const bare = useContext(SettingsBare);
  const titled = words.length > 0 && title !== undefined && matchesSettingsQuery(words, title);
  return (
    <section className={className ? `settings-section ${className}` : "settings-section"} data-section={section} data-found={titled ? "" : undefined} tabIndex={section ? -1 : undefined}>
      {(bare !== true || heading) && title !== undefined && <h3>{title}</h3>}
      {(!bare || keepNote) && note !== undefined && <p className="settings-description settings-note">{note}</p>}
      <div className="settings-card">{titled ? <SettingsQuery.Provider value={[]}>{children}</SettingsQuery.Provider> : children}</div>
    </section>
  );
}

const SettingsRowSentence = createContext<string | undefined>(undefined);

export function useSettingsRowSentence(): string | undefined {
  return useContext(SettingsRowSentence);
}

const describedByAll = (...ids: (string | undefined)[]): string | undefined => ids.filter((id) => id !== undefined && id !== "").join(" ") || undefined;

export interface ScreenBox { left: number; top: number; right: number; bottom: number }

const SENTENCE_EDGE = 8;
const SENTENCE_GAP = 4;
const SENTENCE_MIN_WIDTH = 224;

export function sentenceRoom(tip: ScreenBox, controls: readonly ScreenBox[]): number | null {
  const over = controls.filter((control) => control.left < tip.right && control.right > tip.left && control.top < tip.bottom && control.bottom > tip.top);
  if (over.length === 0) return null;
  const room = Math.min(...over.map((control) => control.left)) - SENTENCE_GAP * 2 - tip.left;
  return room >= SENTENCE_MIN_WIDTH ? room : null;
}

export function sentenceHoles(tip: ScreenBox, controls: readonly ScreenBox[]): ScreenBox[] {
  return controls.filter((control) => control.left < tip.right && control.right > tip.left && control.top < tip.bottom && control.bottom > tip.top)
    .map((control) => ({ left: Math.max(control.left, tip.left) - tip.left, top: Math.max(control.top, tip.top) - tip.top, right: Math.min(control.right, tip.right) - tip.left, bottom: Math.min(control.bottom, tip.bottom) - tip.top }));
}

function sentenceControls(row: HTMLElement): HTMLElement[] {
  const rowControls = [...(row.closest(".modal-body") ?? document).querySelectorAll<HTMLElement>(".settings-row")].filter((other) => other !== row)
    .flatMap((other) => [...other.children].filter((child): child is HTMLElement => child instanceof HTMLElement && !child.classList.contains("settings-row-text")));
  const others = [...(row.closest("[role='dialog']") ?? row.closest(".modal-body") ?? document).querySelectorAll<HTMLElement>("button, a[href], input, select, textarea, summary")]
    .filter((control) => !row.contains(control) && control.closest(".settings-help, .settings-help-copy") === null
      && (control.closest(".settings-row") === null || control.closest(".settings-row > .settings-row-text") !== null));
  return [...rowControls, ...others];
}

export function placeSentence(row: ScreenBox, name: ScreenBox, clear: number, under: number, size: { width: number; height: number }, screen: { width: number; height: number }): { left: number; top: number; side: "above" | "below" } {
  const left = Math.max(SENTENCE_EDGE, Math.min(name.left, row.right - size.width, screen.width - size.width - SENTENCE_EDGE));
  const above = clear - SENTENCE_GAP - size.height;
  if (above >= SENTENCE_EDGE) return { left, top: above, side: "above" };
  return { left, top: Math.max(SENTENCE_EDGE, Math.min(under + SENTENCE_GAP, screen.height - size.height - SENTENCE_EDGE)), side: "below" };
}

const SENTENCE_REST_MS = 450;
const SENTENCE_FOLLOW_MS = 400;
let closeSentence: (() => void) | null = null;
let sentenceClosedAt = Number.NEGATIVE_INFINITY;
let sentencesOpened = 0;

const FOCUS_KEYS = new Set(["Tab", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End"]);

function movesFocus(key: string): boolean {
  return FOCUS_KEYS.has(key);
}

/**
 * A click or a tap that puts the focus in a field is a pointer's (though `:focus-visible` matches
 * there), and the focus the app gives back after Escape or Enter (a closed editor, a confirmed dialog) is the app's:
 * a sentence there would take the next Escape from Settings.
 */
let keyboardMovedFocus = false;

export function inputWas(input: { key: string } | "pointer"): void {
  keyboardMovedFocus = input !== "pointer" && movesFocus(input.key);
}

if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
  window.addEventListener("keydown", (event) => inputWas({ key: event.key }), true);
  window.addEventListener("pointerdown", () => inputWas("pointer"), true);
}

/**
 * Whose Escape it is while a row's sentence is shown: the sentence's alone; the sentence's and the text field's it is
 * typed in; or not the sentence's at all, when an IME takes it to drop its composition, when nothing is drawn (its row
 * is outside the page's view), or when a dialog opened over Settings (Files, the palette) has the keyboard.
 */
function escapeFor(state: { composing: boolean; drawn: boolean; textField: boolean; otherModal: boolean }): "sentence" | "both" | "other" {
  if (state.composing || !state.drawn || state.otherModal) return "other";
  return state.textField ? "both" : "sentence";
}

function inPageView(row: Element | null): boolean {
  if (row === null) return false;
  const box = row.getBoundingClientRect();
  const page = row.closest(".modal-body")?.getBoundingClientRect();
  return page === undefined || (box.bottom > page.top && box.top < page.bottom);
}

function inTextField(): boolean {
  const active = document.activeElement;
  if (active instanceof HTMLTextAreaElement) return true;
  if (active instanceof HTMLInputElement) return !["button", "checkbox", "radio", "range", "submit", "reset", "file", "color", "image"].includes(active.type);
  return active instanceof HTMLElement && active.isContentEditable;
}

export function useRowSentence(on: boolean): {
  row: RefObject<HTMLDivElement | null>;
  shown: "hover" | "focus" | null;
  drawn: RefObject<boolean>;
  opened: boolean;
  forget: () => void;
  rowEvents: { onPointerEnter?: (event: ReactPointerEvent) => void; onPointerLeave?: () => void; onPointerDown?: (event: ReactPointerEvent) => void; onFocus?: (event: ReactFocusEvent) => void; onBlur?: (event: ReactFocusEvent) => void; onInput?: () => void; onClick?: (event: ReactMouseEvent) => void };
} {
  const row = useRef<HTMLDivElement>(null);
  const [shown, setShown] = useState<"hover" | "focus" | null>(null);
  const [opened, setOpened] = useState(false);
  const rest = useRef<number | undefined>(undefined);
  const dismissed = useRef(false);
  const finger = useRef(false);
  const drawn = useRef(false);
  useEffect(() => () => { if (rest.current !== undefined) window.clearTimeout(rest.current); }, []);
  useEffect(() => {
    if (shown === null) return;
    sentencesOpened += 1;
    closeSentence?.();
    const close = (): void => setShown(null);
    closeSentence = close;
    return () => {
      if (closeSentence === close) closeSentence = null;
      sentenceClosedAt = performance.now();
    };
  }, [shown]);
  const closable = shown !== null || opened;
  useEffect(() => {
    if (!closable) return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      const otherModal = focusInOtherModal(row.current?.closest<HTMLElement>("[aria-modal='true']") ?? null);
      // key code 229: the Escape WebKit can still send for a composition after compositionend
      const whose = escapeFor({ composing: event.isComposing || event.keyCode === 229, drawn: opened ? inPageView(row.current) : drawn.current, textField: inTextField(), otherModal });
      if (whose === "other") {
        if (otherModal) setShown(null);
        return;
      }
      if (whose === "sentence") {
        event.preventDefault();
        event.stopPropagation();
      }
      dismissed.current = true;
      setShown(null);
      setOpened(false);
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [closable, opened]);
  const forget = (): void => {
    if (rest.current !== undefined) window.clearTimeout(rest.current);
    dismissed.current = false;
    setShown(null);
    setOpened(false);
  };
  // a row whose sentence goes away (a description that comes and goes) keeps none marked as showing or opened:
  // an Escape taken for a sentence nobody sees would be lost
  const forgetRef = useRef(forget);
  forgetRef.current = forget;
  useEffect(() => { if (!on) forgetRef.current(); }, [on]);
  if (!on) return { row, shown: null, drawn, opened: false, forget, rowEvents: {} };
  return {
    row, shown: opened ? null : shown, drawn, opened, forget,
    rowEvents: {
      onPointerEnter: (event) => {
        if (event.pointerType === "touch" || opened) return;
        window.clearTimeout(rest.current);
        dismissed.current = false;
        if (shown !== null) return;
        const asked = sentencesOpened;
        rest.current = window.setTimeout(() => { if (sentencesOpened === asked) setShown("hover"); }, performance.now() - sentenceClosedAt < SENTENCE_FOLLOW_MS ? 0 : SENTENCE_REST_MS);
      },
      onPointerLeave: () => {
        window.clearTimeout(rest.current);
        dismissed.current = false;
        if (shown === "hover") setShown(null);
      },
      onPointerDown: (event) => {
        finger.current = event.pointerType !== "mouse";
        if ((event.target as Element).closest(".settings-help")) return;
        window.clearTimeout(rest.current);
        if (shown === "hover") setShown(null);
      },
      onFocus: () => {
        if (opened || dismissed.current || !keyboardMovedFocus) return;
        window.clearTimeout(rest.current);
        setShown("focus");
      },
      onBlur: (event) => {
        if (row.current?.contains(event.relatedTarget)) return;
        dismissed.current = false;
        if (shown === "focus") setShown(null);
      },
      onInput: () => {
        if (shown === null) return;
        dismissed.current = true;
        setShown(null);
      },
      onClick: (event) => {
        const target = event.target as Element;
        if (shown === "focus" && target.closest("button, a, input, select, textarea") !== null && target.closest(".settings-help") === null) {
          dismissed.current = true;
          setShown(null);
        }
        if (!finger.current) return;
        if (target !== event.currentTarget && target.closest(".settings-row-text") === null) return;
        if (target.closest("button, a, input, select, textarea")) return;
        if (target.closest("label")) event.preventDefault();
        setOpened((was) => !was);
      },
    },
  };
}

/**
 * The sentence is cut out in exactly those parts (sentenceHoles, a clip-path, which cuts the pointer's reach with
 * what is drawn), so a press there reaches the control itself, and a copy under it, which takes no pointer, draws
 * what was cut.
 */
function RowSentence({ row, drawn, children }: { row: HTMLElement; drawn: RefObject<boolean>; children: ReactNode }) {
  const box = useRef<HTMLDivElement>(null);
  const copy = useRef<HTMLDivElement>(null);
  const [at, setAt] = useState<{ left: number; top: number; maxWidth: string; width: number; height: number; holes: readonly ScreenBox[] } | null>(null);
  useLayoutEffect(() => {
    const place = (): void => {
      const tip = box.current;
      if (!tip) return;
      const rowBox = row.getBoundingClientRect();
      if (!inPageView(row)) {
        drawn.current = false;
        setAt(null);
        return;
      }
      drawn.current = true;
      const text = row.querySelector(":scope > .settings-row-text");
      const name = (row.querySelector(".settings-label") ?? row).getBoundingClientRect();
      const line = row.querySelector(":scope > .settings-row-text > .settings-label-line")?.getBoundingClientRect();
      const beside = [...row.children].filter((child) => child !== text).map((child) => child.getBoundingClientRect()).filter((side) => side.height > 0);
      const clear = Math.min(name.top, line?.top ?? name.top, ...beside.map((side) => side.top));
      const under = Math.max(text?.getBoundingClientRect().bottom ?? rowBox.bottom, ...beside.map((side) => side.bottom));
      const screen = { width: window.innerWidth, height: window.innerHeight };
      const controls = sentenceControls(row).map((child) => child.getBoundingClientRect()).filter((side) => side.height > 0);
      const measure = () => placeSentence(rowBox, name, clear, under, { width: tip.offsetWidth, height: tip.offsetHeight }, screen);
      let maxWidth = "";
      tip.style.maxWidth = maxWidth;
      let next = measure();
      for (let pass = 0; pass < 2; pass++) {
        const lies = { left: next.left, top: next.top, right: next.left + tip.offsetWidth, bottom: next.top + tip.offsetHeight };
        const room = sentenceRoom(lies, controls);
        if (room !== null && room < tip.offsetWidth) maxWidth = `${room}px`;
        else if (room === null && pass > 0 && controls.some((control) => control.left < lies.right && control.right > lies.left && control.top < lies.bottom && control.bottom > lies.top)) maxWidth = "";
        else break;
        tip.style.maxWidth = maxWidth;
        next = measure();
      }
      const lies = { left: next.left, top: next.top, right: next.left + tip.offsetWidth, bottom: next.top + tip.offsetHeight };
      const placed = { left: next.left, top: next.top, maxWidth, width: tip.offsetWidth, height: tip.offsetHeight, holes: sentenceHoles(lies, controls) };
      setAt((was) => was !== null && JSON.stringify(was) === JSON.stringify(placed) ? was : placed);
    };
    place();
    window.addEventListener("scroll", place, { capture: true, passive: true });
    window.addEventListener("resize", place);
    return () => {
      drawn.current = false;
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
    };
  }, [row, drawn]);
  const cut = at === null || at.holes.length === 0 ? undefined
    : `path(evenodd, "M0 0H${at.width}V${at.height}H0Z${at.holes.map((hole) => ` M${hole.left} ${hole.top}H${hole.right}V${hole.bottom}H${hole.left}Z`).join("")}")`;
  return createPortal(
    <>
      {at !== null && cut !== undefined && <div ref={copy} className="settings-help-copy" aria-hidden="true" style={{ left: at.left, top: at.top, width: at.width, height: at.height }}>{children}</div>}
      <div ref={box} className="settings-help" aria-hidden="true" onScroll={(event) => { if (copy.current) copy.current.scrollTop = event.currentTarget.scrollTop; }}
        style={at === null ? { visibility: "hidden" } : { left: at.left, top: at.top, maxWidth: at.maxWidth === "" ? undefined : at.maxWidth, clipPath: cut }}>{children}</div>
    </>,
    row.closest<HTMLElement>(".modal-scrim") ?? document.body,
  );
}

const DESCRIBED_ELEMENTS = new Set(["button", "input", "select", "textarea"]);

/**
 * A row without a sentence goes through it too, unchanged: a row whose sentence comes and goes (a shortcut being
 * recorded) keeps one shape, so its controls are never drawn anew and keep the focus.
 */
function describedByRow(children: ReactNode, sentence: string | undefined): ReactNode {
  return Children.map(children, (child) => {
    if (!isValidElement<{ children?: ReactNode; "aria-describedby"?: string }>(child)) return child;
    if (typeof child.type === "string" && DESCRIBED_ELEMENTS.has(child.type)) return sentence !== undefined && child.props["aria-describedby"] === undefined ? cloneElement(child, { "aria-describedby": sentence }) : child;
    if ((typeof child.type !== "string" && child.type !== Fragment) || child.props.children === undefined) return child;
    return cloneElement(child, undefined, describedByRow(child.props.children, sentence));
  });
}

export function SettingsRow({ label, description, keywords, held = false, htmlFor, wide = false, reset, onReset, resetAlso, icon: Icon, preview, condition, children }: { label: string; description?: ReactNode; keywords?: string; held?: boolean; htmlFor?: string; wide?: boolean; reset?: readonly (keyof Settings)[];
  onReset?: () => void;
  resetAlso?: { changed: boolean; restore: () => void };
  icon?: LucideIcon;
  preview?: ReactNode;
  condition?: ReactNode;
  children: ReactNode }) {
  const words = useContext(SettingsQuery);
  const bare = useContext(SettingsBare);
  const { settings, update } = useSettings();
  const t = useT();
  const sentenceId = useId();
  const sentence = useRowSentence(description !== undefined && bare !== false);
  const filteredOut = !held && words.length > 0 && !matchesSettingsQuery(words, label, description, keywords, condition, children);
  const forgetSentence = sentence.forget;
  useEffect(() => { if (filteredOut) forgetSentence(); }, [filteredOut]);
  if (filteredOut) return null;
  const changed = onReset !== undefined || (reset !== undefined && reset.some((key) => JSON.stringify(settings[key]) !== JSON.stringify(DEFAULT_SETTINGS[key]))) || resetAlso?.changed === true;
  const restore = () => {
    if (onReset) return onReset();
    if (reset !== undefined) update(Object.fromEntries(reset.map((key) => [key, DEFAULT_SETTINGS[key]])) as Partial<Settings>);
    resetAlso?.restore();
  };
  const label_ = htmlFor !== undefined ? <label className="settings-label" htmlFor={htmlFor}>{label}</label> : <span className="settings-label">{label}</span>;
  return (
    <div ref={sentence.row} className={`settings-row${wide ? " is-wide" : ""}${sentence.opened ? " is-explained" : ""}`} data-setting="" {...sentence.rowEvents}>
      <div className={`settings-row-text${Icon !== undefined ? " has-icon" : ""}`}>
        {changed || Icon !== undefined ? (
          <span className="settings-label-line">
            {Icon !== undefined && <Icon className="settings-row-icon" aria-hidden="true" />}
            {label_}
            {changed && <button type="button" className="settings-reset" title={t("Restore defaults")} aria-label={`${t("Restore defaults")}: ${label}`} onClick={(event) => {
              event.currentTarget.closest(".settings-row")?.querySelector<HTMLElement>("input:not(:disabled), select:not(:disabled), [role='radio'], button:not(.settings-reset):not(:disabled)")?.focus();
              restore();
            }}>
              <RotateCcw aria-hidden="true" />
            </button>}
          </span>
        ) : label_}
        {/* a page without sentences still has them read out, and found by search */}
        {description !== undefined && !sentence.opened && <span id={sentenceId} className={bare === false ? "settings-description" : "visually-hidden"}>{description}</span>}
        {condition}
      </div>
      {preview !== undefined && <span className="settings-row-preview" aria-hidden="true">{preview}</span>}
      <SettingsRowSentence.Provider value={description !== undefined ? sentenceId : undefined}>{describedByRow(children, description !== undefined ? sentenceId : undefined)}</SettingsRowSentence.Provider>
      {/* opened by a tap: under the name and the control, as wide as the row */}
      {sentence.opened && <span id={sentenceId} className="settings-description settings-row-sentence">{description}</span>}
      {sentence.shown !== null && sentence.row.current !== null && <RowSentence row={sentence.row.current} drawn={sentence.drawn}>{description}</RowSentence>}
    </div>
  );
}

export function Toggle({ checked, label, onChange, disabled, id, describedBy }: { checked: boolean; label: string; onChange: (checked: boolean) => void; disabled?: boolean; id?: string; describedBy?: string }) {
  const sentence = useContext(SettingsRowSentence);
  return (
    <button type="button" id={id} className="settings-toggle" role="switch" aria-checked={checked} aria-label={label} aria-describedby={describedByAll(describedBy, sentence)} disabled={disabled} onClick={() => onChange(!checked)}>
      <span className="settings-toggle-thumb" />
    </button>
  );
}

export function SettingsSelect({ className, children, ...props }: ComponentProps<"select">) {
  const sentence = useContext(SettingsRowSentence);
  return (
    <span className={className ? `settings-select-wrap ${className}` : "settings-select-wrap"}>
      <select {...props} aria-describedby={describedByAll(props["aria-describedby"], sentence)} className="select settings-select">{children}</select>
      <ChevronDown aria-hidden="true" />
    </span>
  );
}

export interface SegmentedOption<T extends string> { value: T; label: string; name?: string }

export function Segmented<T extends string>({ label, value, options, onChange, disabled }: { label: string; value: T; options: readonly SegmentedOption<T>[]; onChange: (value: T) => void; disabled?: boolean }) {
  const sentence = useContext(SettingsRowSentence);
  const track = useRef<HTMLDivElement>(null);
  const labels = options.map((option) => option.label).join("\n");
  // The labels keep their size whatever the track does with it, so the measuring never feeds itself
  useLayoutEffect(() => {
    const node = track.current;
    if (node === null) return;
    const widths = new Map<Element, number>();
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) widths.set(entry.target, entry.borderBoxSize[0]?.inlineSize ?? entry.contentRect.width);
      node.style.setProperty("--segmented-widest", `${Math.max(0, ...widths.values())}px`);
    });
    for (const face of node.querySelectorAll(":scope > button > span")) observer.observe(face);
    return () => observer.disconnect();
  }, [labels]);
  return (
    <div ref={track} className="segmented settings-segmented" role="group" aria-label={label} aria-describedby={sentence} style={{ "--segmented-count": options.length } as CSSProperties}>
      {options.map((option) => (
        <button key={option.value} type="button" aria-pressed={value === option.value} aria-label={option.name} disabled={disabled} onClick={() => onChange(option.value)}><span data-label={option.label}>{option.label}</span></button>
      ))}
    </div>
  );
}

export function ChipToggles({ label, chips }: { label: string; chips: readonly { label: string; title?: string; icon?: LucideIcon; on: boolean; onChange: (on: boolean) => void }[] }) {
  const sentence = useContext(SettingsRowSentence);
  return (
    <div className="settings-chips" role="group" aria-label={label} aria-describedby={sentence}>
      {chips.map((chip) => (
        <button key={chip.label} type="button" className="settings-chip" aria-pressed={chip.on} title={chip.title} onClick={() => chip.onChange(!chip.on)}>{chip.icon && <chip.icon aria-hidden="true" />}{chip.label}</button>
      ))}
    </div>
  );
}

/**
 * The full-width digits a Japanese, Korean or Chinese IME types (１６) count as their plain ones. Only here, where the draft is
 * read: the field's own text is left alone while it is edited, so an IME's composition is never rewritten under it.
 */
export function typedStep(draft: string, min: number, max: number): number | null {
  const digits = draft.trim().replace(/[\uFF10-\uFF19]/g, (digit) => String(digit.charCodeAt(0) - 0xff10));
  if (!/^\d+$/.test(digits)) return null;
  const value = Number(digits);
  return value >= min && value <= max ? value : null;
}

/**
 * A valid number still in the field is kept when the field goes without a blur (a swipe or Back closing Settings),
 * and the -/+ buttons step from it (G-179).
 */
export function Stepper({ label, value, text, min, max, decreaseLabel, increaseLabel, onChange, unit, range }: { label: string; value: number; text: string; min: number; max: number; decreaseLabel: string; increaseLabel: string; onChange: (value: number) => void; unit?: string; range?: string }) {
  const [draft, setDraft] = useState<string | null>(null);
  const [refused, setRefused] = useState(false);
  const rangeId = useId();
  const sentence = useContext(SettingsRowSentence);
  const shown = draft ?? String(value);
  const typed = draft === null ? null : typedStep(draft, min, max);
  const current = typed ?? value;
  const commit = () => {
    if (typed !== null && typed !== value) onChange(typed);
    setRefused(draft !== null && typed === null);
    setDraft(null);
  };
  const step = (by: number) => {
    setDraft(null);
    setRefused(false);
    const next = Math.min(max, Math.max(min, current + by));
    if (next !== value) onChange(next);
  };
  // the field can go without a blur (Settings closed by a swipe or Back): a valid size still in it is kept
  const pending = useRef<() => void>(() => {});
  pending.current = () => { if (typed !== null && typed !== value) onChange(typed); };
  useEffect(() => () => pending.current(), []);
  const stepper = (
    // aria-disabled at an end, not disabled: a press keeps the focus on the button instead of dropping it to the page
    <div className="settings-stepper" role="group" aria-label={label} aria-describedby={sentence}>
      <button type="button" className="icon-button" aria-label={decreaseLabel} title={decreaseLabel} aria-disabled={current <= min || undefined} onClick={() => { if (current > min) step(-1); }}><Minus aria-hidden="true" /></button>
      {unit === undefined ? <output aria-live="polite">{text}</output> : <span className="settings-stepper-field">
        <input className="settings-stepper-value" type="text" inputMode="numeric" aria-label={label} title={range} value={shown}
          aria-describedby={range === undefined ? undefined : rangeId}
          aria-invalid={refused || (draft !== null && typed === null) ? true : undefined} autoComplete="off" spellCheck={false}
          onChange={(event) => { setRefused(false); setDraft(event.target.value); }} onBlur={commit}
          onKeyDown={(event) => {
            // an IME's own Enter and Escape finish or drop its composition, not the draft
            if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
            if (event.key === "Enter") commit(); else if (event.key === "Escape" && draft !== null) { event.stopPropagation(); setRefused(false); setDraft(null); }
          }} />
        <span aria-hidden="true">{unit}</span>
        {/* the field is not announced as it changes: the size the -/+ buttons or a typed number set is */}
        <output className="visually-hidden" aria-live="polite">{text}</output>
      </span>}
      <button type="button" className="icon-button" aria-label={increaseLabel} title={increaseLabel} aria-disabled={current >= max || undefined} onClick={() => { if (current < max) step(1); }}><Plus aria-hidden="true" /></button>
    </div>
  );
  if (unit === undefined || range === undefined) return stepper;
  return <>{stepper}<span id={rangeId} className={refused ? "settings-stepper-range" : "visually-hidden"}>{range}</span></>;
}
