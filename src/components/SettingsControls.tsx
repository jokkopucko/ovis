import { createContext, isValidElement, useContext, useEffect, useId, useRef, useState, type ComponentProps, type ReactNode } from "react";
import { ChevronDown, ChevronRight, Minus, Plus, RotateCcw, type LucideIcon } from "lucide-react";

import { DEFAULT_SETTINGS, useSettings, type Settings } from "../lib/settings.ts";
import { useT } from "../lib/i18n.ts";

import "./SettingsControls.css";

/**
 * The parts every Settings page is built from: a group is a caption over one card, a card holds
 * rows parted by hairlines, and a row is a label with its one control at the end of the line.
 */
/**
 * The words typed in Settings' search (SettingsDialog.tsx): while it holds any, a row draws only
 * when its label and description hold every one of them, and a group whose title holds them all
 * shows each of its rows. Outside a search it is empty and nothing is filtered.
 */
export const SettingsQuery = createContext<readonly string[]>([]);

/**
 * A page drawn as herdr-app draws its settings: rows are a label and a control, with no sentences and no group captions.
 * `"rows"`: the rows go without sentences, but each group keeps its short heading. A row's sentence still counts for search.
 */
export const SettingsBare = createContext<boolean | "rows">(false);

/** What a search matches by: case and full-width forms folded, so "Font" finds "font". */
const folded = (text: string): string => text.normalize("NFKC").toLocaleLowerCase();

export function settingsQueryWords(query: string): string[] {
  return folded(query).split(/\s+/).filter((word) => word !== "");
}

/**
 * The words a label or description shows, a description built of elements (a sentence and a warning)
 * included, and the names a row's own controls carry (an input's aria-label, placeholder or title), so a
 * search finds a row by the field inside it (G-109).
 */
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

/**
 * The groups a page keeps out of its first view, folded under one line at its end: **More settings**
 * for what few people change, **Experimental** for what is still being shaped. The line counts the
 * `keys` this device has moved off their defaults, and `elsewhere` more choices kept outside the
 * settings record (Alerts' filters), so a choice is never hidden without a trace. A
 * search shows what it finds inside as if unfolded; a link to a group inside opens it
 * (SettingsDialog.tsx). Native details, so the browser's find-in-page opens it too.
 */
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

/** `section`: the group's name in a link to it (`?settings=<page>&section=<name>`, lib/deepLink.ts) */
/**
 * `heading`: the title stays on a bare page too, as the one sub-heading a page like Experimental keeps.
 * `keepNote`: the note stays on a bare page too, for a sentence the reader must see (what leaves this PC).
 */
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

/**
 * One setting. `wide` marks a control that needs the whole line on a phone (three or more
 * segments, a text field): the row stacks there, and stays one line everywhere else. `keywords`:
 * more words a search finds it by, for a row opened by another. `held`: a row in the middle of a
 * step (a recording, a confirmation) stays in a search whatever its words have become.
 */
export function SettingsRow({ label, description, keywords, held = false, htmlFor, wide = false, reset, onReset, resetAlso, icon: Icon, preview, condition, children }: { label: string; description?: ReactNode; keywords?: string; held?: boolean; htmlFor?: string; wide?: boolean; reset?: readonly (keyof Settings)[];
  /** a row whose value lives inside a setting (one shortcut of shortcutOverrides): passed only while it is changed */
  onReset?: () => void;
  /** what the row sets outside Settings (a store of its own): whether it moved off its default, and how ↺ puts it back */
  resetAlso?: { changed: boolean; restore: () => void };
  /** a picture of what the row is about, before its name: shown, not told */
  icon?: LucideIcon;
  /** a tiny drawing of what the choice does, beside the control */
  preview?: ReactNode;
  /** what applies right now (a refusal, a missing key): shown under the name even where sentences are not */
  condition?: ReactNode;
  children: ReactNode }) {
  const words = useContext(SettingsQuery);
  const bare = useContext(SettingsBare);
  const { settings, update } = useSettings();
  const t = useT();
  if (!held && words.length > 0 && !matchesSettingsQuery(words, label, description, keywords, condition, children)) return null;
  // `reset`: the keys this row sets; once any is off its default, a button beside the label puts them back
  const changed = onReset !== undefined || (reset !== undefined && reset.some((key) => JSON.stringify(settings[key]) !== JSON.stringify(DEFAULT_SETTINGS[key]))) || resetAlso?.changed === true;
  const restore = () => {
    if (onReset) return onReset();
    if (reset !== undefined) update(Object.fromEntries(reset.map((key) => [key, DEFAULT_SETTINGS[key]])) as Partial<Settings>);
    resetAlso?.restore();
  };
  const label_ = htmlFor !== undefined ? <label className="settings-label" htmlFor={htmlFor}>{label}</label> : <span className="settings-label">{label}</span>;
  return (
    <div className={wide ? "settings-row is-wide" : "settings-row"} data-setting="">
      <div className="settings-row-text">
        {changed || Icon !== undefined ? (
          <span className="settings-label-line">
            {Icon !== undefined && <Icon className="settings-row-icon" aria-hidden="true" />}
            {label_}
            {changed && <button type="button" className="settings-reset" title={t("Restore defaults")} aria-label={`${t("Restore defaults")}: ${label}`} onClick={(event) => {
              // the button goes once the values are back: the row's own control takes the focus first
              event.currentTarget.closest(".settings-row")?.querySelector<HTMLElement>("input:not(:disabled), select:not(:disabled), [role='radio'], button:not(.settings-reset):not(:disabled)")?.focus();
              restore();
            }}>
              <RotateCcw aria-hidden="true" />
            </button>}
          </span>
        ) : label_}
        {/* a page without sentences still has them read out, and found by search */}
        {description !== undefined && <span className={bare === false ? "settings-description" : "visually-hidden"}>{description}</span>}
        {condition}
      </div>
      {preview !== undefined && <span className="settings-row-preview" aria-hidden="true">{preview}</span>}
      {children}
    </div>
  );
}

/** `id` for a `<label htmlFor>` beside it; `describedBy`: the id of the hint read with it */
export function Toggle({ checked, label, onChange, disabled, id, describedBy }: { checked: boolean; label: string; onChange: (checked: boolean) => void; disabled?: boolean; id?: string; describedBy?: string }) {
  return (
    <button type="button" id={id} className="settings-toggle" role="switch" aria-checked={checked} aria-label={label} aria-describedby={describedBy} disabled={disabled} onClick={() => onChange(!checked)}>
      <span className="settings-toggle-thumb" />
    </button>
  );
}

export function SettingsSelect({ className, children, ...props }: ComponentProps<"select">) {
  return (
    <span className={className ? `settings-select-wrap ${className}` : "settings-select-wrap"}>
      <select {...props} className="select settings-select">{children}</select>
      <ChevronDown aria-hidden="true" />
    </span>
  );
}

/** `name`: what a screen reader and a test call the button when its short label is shared with another control nearby */
export interface SegmentedOption<T extends string> { value: T; label: string; name?: string }

/** One of a few short choices, all in sight. Five or more go in a select instead. */
export function Segmented<T extends string>({ label, value, options, onChange, disabled }: { label: string; value: T; options: readonly SegmentedOption<T>[]; onChange: (value: T) => void; disabled?: boolean }) {
  return (
    <div className="segmented settings-segmented" role="group" aria-label={label}>
      {options.map((option) => (
        <button key={option.value} type="button" aria-pressed={value === option.value} aria-label={option.name} disabled={disabled} onClick={() => onChange(option.value)}>{option.label}</button>
      ))}
    </div>
  );
}

/**
 * Several on/off choices of one decision on one line, each a chip that is pressed while on. `title`: what the
 * chip means in full, shown as its tooltip (the one-minute rule of Long turn finished, G-096).
 */
export function ChipToggles({ label, chips }: { label: string; chips: readonly { label: string; title?: string; icon?: LucideIcon; on: boolean; onChange: (on: boolean) => void }[] }) {
  return (
    <div className="settings-chips" role="group" aria-label={label}>
      {chips.map((chip) => (
        <button key={chip.label} type="button" className="settings-chip" aria-pressed={chip.on} title={chip.title} onClick={() => chip.onChange(!chip.on)}>{chip.icon && <chip.icon aria-hidden="true" />}{chip.label}</button>
      ))}
    </div>
  );
}

/**
 * The whole number `draft` holds when it lies within `min`..`max`; null for anything else, which is refused, never clamped (G-179).
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
 * A number moved one step at a time between its limits, shown as `text`. The glyph buttons carry their names as tooltips too (G-167).
 * `unit`: the number can be typed in its place too, followed by this unit. The whole draft is read (a pasted 200 is not cut to 20);
 * a number out of range is refused and the field goes back, and `range` (the limits in words) shows under it until the next edit;
 * it describes the field all along. A valid number still in the field is kept when the field goes without a blur (a swipe or Back
 * closing Settings), and the -/+ buttons step from it (G-179).
 */
export function Stepper({ label, value, text, min, max, decreaseLabel, increaseLabel, onChange, unit, range }: { label: string; value: number; text: string; min: number; max: number; decreaseLabel: string; increaseLabel: string; onChange: (value: number) => void; unit?: string; range?: string }) {
  const [draft, setDraft] = useState<string | null>(null);
  const [refused, setRefused] = useState(false);
  const rangeId = useId();
  const shown = draft ?? String(value);
  const typed = draft === null ? null : typedStep(draft, min, max);
  // what the buttons step from: the size in the field when it is one, else the saved one
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
    <div className="settings-stepper" role="group" aria-label={label}>
      <button type="button" className="icon-button" aria-label={decreaseLabel} title={decreaseLabel} disabled={current <= min} onClick={() => step(-1)}><Minus aria-hidden="true" /></button>
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
      <button type="button" className="icon-button" aria-label={increaseLabel} title={increaseLabel} disabled={current >= max} onClick={() => step(1)}><Plus aria-hidden="true" /></button>
    </div>
  );
  if (unit === undefined || range === undefined) return stepper;
  // the range is read with the field all along, and seen under it only after a refused size, until the next edit
  return <>{stepper}<span id={rangeId} className={refused ? "settings-stepper-range" : "visually-hidden"}>{range}</span></>;
}
