import { useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronUp, GripVertical, Plus, X } from "lucide-react";

import "./KeyBarSettings.css";

import { DEFAULT_KEY_BAR_ITEMS, KEY_BAR_ITEMS_MAX, KEY_BAR_KEYS, keyBarInputSequence, keyBarItemId, keyBarItemLabel, type KeyBarItem } from "../lib/keyBar.ts";
import { NO_STICKY_MODIFIERS, type StickyModifiers } from "../lib/keys.ts";
import { useSettings } from "../lib/settings.ts";
import { useT } from "../lib/i18n.ts";
import { edgeScrollStep, rowAt } from "../lib/touchReorder.ts";

const MODIFIERS: readonly (keyof StickyModifiers)[] = ["ctrl", "alt", "shift"];
const MODIFIER_CAPS: Record<keyof StickyModifiers, string> = { ctrl: "Ctrl", alt: "Alt", shift: "Shift" };
const CHARACTER_KEY = "character";

/** The phone's key row: handles are a shortcut; buttons keep editing possible without dragging. */
export function KeyBarSettings() {
  const t = useT();
  const { settings, update } = useSettings();
  const items = settings.keyBarItems;
  const ids = new Set(items.map(keyBarItemId));
  const available = KEY_BAR_KEYS.filter((key) => !ids.has(keyBarItemId({ type: "key", key })));
  const [chosenKey, setChosenKey] = useState<string>(available[0] ?? "");
  // The combo editor names a base key; shortcuts such as ^C already include a modifier.
  const comboKeys = KEY_BAR_KEYS.filter((key) => !key.startsWith("ctrl-") && key !== "BackTab" && !["pipe", "tilde", "slash"].includes(key));
  const [comboKey, setComboKey] = useState<string>("ArrowLeft");
  const [character, setCharacter] = useState("");
  const [comboModifiers, setComboModifiers] = useState<StickyModifiers>(NO_STICKY_MODIFIERS);
  const full = items.length >= KEY_BAR_ITEMS_MAX;
  const listRef = useRef<HTMLOListElement>(null);
  const [drag, setDrag] = useState<{ from: number; to: number } | null>(null);

  useEffect(() => {
    const list = listRef.current;
    const scroller = list?.closest<HTMLElement>(".settings-key-bar-body");
    if (!list || !scroller) return;
    let lifted: { handle: HTMLElement; pointer: number; from: number; to: number; y: number } | null = null;
    let frame = 0;

    const place = (): void => {
      if (!lifted) return;
      const rows = Array.from(list.children, (row, index) => {
        const box = row.getBoundingClientRect();
        return { id: String(index), top: box.top, bottom: box.bottom };
      });
      const over = rowAt(lifted.y, rows);
      if (over === null) return;
      const to = Number(over);
      if (to !== lifted.to) {
        lifted.to = to;
        setDrag({ from: lifted.from, to });
      }
    };
    const scroll = (): void => {
      if (!lifted) return;
      const box = scroller.getBoundingClientRect();
      scroller.scrollTop += edgeScrollStep(lifted.y, box.top, box.bottom);
      place();
      frame = window.requestAnimationFrame(scroll);
    };
    const finish = (save: boolean): void => {
      if (!lifted) return;
      const { handle, pointer, from, to } = lifted;
      lifted = null;
      window.cancelAnimationFrame(frame);
      if (handle.hasPointerCapture(pointer)) handle.releasePointerCapture(pointer);
      setDrag(null);
      if (save && from !== to) {
        const next = [...items];
        next.splice(to, 0, next.splice(from, 1)[0]!);
        update({ keyBarItems: next });
      }
    };
    const down = (event: PointerEvent): void => {
      const handle = (event.target as Element).closest<HTMLElement>(".key-bar-settings-handle");
      if (!handle || !event.isPrimary || event.button !== 0 || lifted) return;
      event.preventDefault();
      const from = Array.prototype.indexOf.call(list.children, handle.parentElement) as number;
      handle.setPointerCapture(event.pointerId);
      lifted = { handle, pointer: event.pointerId, from, to: from, y: event.clientY };
      setDrag({ from, to: from });
      frame = window.requestAnimationFrame(scroll);
    };
    const move = (event: PointerEvent): void => {
      if (!lifted || event.pointerId !== lifted.pointer) return;
      event.preventDefault();
      lifted.y = event.clientY;
      place();
    };
    const up = (event: PointerEvent): void => {
      if (!lifted || event.pointerId !== lifted.pointer) return;
      lifted.y = event.clientY;
      place();
      finish(true);
    };
    const cancel = (event: PointerEvent): void => {
      if (event.pointerId === lifted?.pointer) finish(false);
    };
    const escape = (event: KeyboardEvent): void => {
      if (!lifted || event.key !== "Escape" || event.isComposing) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      finish(false);
    };
    list.addEventListener("pointerdown", down);
    list.addEventListener("pointermove", move);
    list.addEventListener("pointerup", up);
    list.addEventListener("pointercancel", cancel);
    list.addEventListener("lostpointercapture", cancel);
    window.addEventListener("keydown", escape, true);
    return () => {
      finish(false);
      list.removeEventListener("pointerdown", down);
      list.removeEventListener("pointermove", move);
      list.removeEventListener("pointerup", up);
      list.removeEventListener("pointercancel", cancel);
      list.removeEventListener("lostpointercapture", cancel);
      window.removeEventListener("keydown", escape, true);
    };
  }, [items, update]);

  useEffect(() => {
    if (!available.includes(chosenKey)) setChosenKey(available[0] ?? "");
  }, [chosenKey, items]);

  const remove = (index: number): void => update({ keyBarItems: items.filter((_, at) => at !== index) });
  const move = (index: number, by: -1 | 1): void => {
    const target = index + by;
    if (target < 0 || target >= items.length) return;
    const next = [...items];
    [next[index], next[target]] = [next[target]!, next[index]!];
    update({ keyBarItems: next });
  };
  const add = (item: KeyBarItem): void => {
    if (full || ids.has(keyBarItemId(item))) return;
    update({ keyBarItems: [...items, item] });
  };

  const base = comboKey === CHARACTER_KEY ? character : comboKey;
  const characterValid = comboKey !== CHARACTER_KEY || ([...character].length === 1 && keyBarInputSequence(character, false) !== null);
  const combo: KeyBarItem = { type: "key", key: base, modifiers: comboModifiers };
  const comboExists = characterValid && ids.has(keyBarItemId(combo));

  return (
    <div className="key-bar-settings">
      <p className="settings-hint">{t("Choose the keys and their order under the terminal. The keyboard mode button stays first.")}</p>
      <ol ref={listRef} className="key-bar-settings-list" aria-label={t("Key bar keys")}>
        {items.map((item, index) => {
          const name = keyBarItemLabel(item);
          return (
            <li className={`key-bar-settings-row${drag?.from === index ? " is-dragging" : ""}${drag?.to === index && drag.from !== index ? drag.from > index ? " drop-before" : " drop-after" : ""}`} key={keyBarItemId(item)}>
              <span className="key-bar-settings-handle" aria-hidden="true" title={t("Drag to reorder")}><GripVertical aria-hidden="true" /></span>
              <span className="key-bar-settings-cap" title={name}>{name}</span>
              <span className="key-bar-settings-kind">{item.type === "modifier" ? t("Held modifier") : item.modifiers ? t("Saved combination") : null}</span>
              <span className="key-bar-settings-actions">
                <button type="button" className="icon-button" disabled={index === 0} aria-label={t("Move {name} up", { name })} title={t("Move {name} up", { name })} onClick={() => move(index, -1)}><ChevronUp aria-hidden="true" /></button>
                <button type="button" className="icon-button" disabled={index === items.length - 1} aria-label={t("Move {name} down", { name })} title={t("Move {name} down", { name })} onClick={() => move(index, 1)}><ChevronDown aria-hidden="true" /></button>
                <button type="button" className="icon-button" aria-label={t("Remove {name}", { name })} title={t("Remove {name}", { name })} onClick={() => remove(index)}><X aria-hidden="true" /></button>
              </span>
            </li>
          );
        })}
      </ol>
      {items.length === 0 && <p className="settings-hint">{t("No keys selected.")}</p>}
      <div className="key-bar-settings-add">
        <label className="key-bar-settings-field">
          <span className="settings-label">{t("Add key")}</span>
          <select className="input" value={chosenKey} disabled={full || available.length === 0} onChange={(event) => setChosenKey(event.target.value)}>
            {available.length === 0 && <option value="">{t("All keys added")}</option>}
            {available.map((key) => <option value={key} key={key}>{keyBarItemLabel({ type: "key", key })}</option>)}
          </select>
        </label>
        <button type="button" className="btn" disabled={full || chosenKey === ""} onClick={() => add({ type: "key", key: chosenKey })}><Plus aria-hidden="true" />{t("Add key")}</button>
      </div>
      <div className="key-bar-settings-modifiers" role="group" aria-label={t("Held modifiers")}>
        <span className="settings-label key-bar-settings-modifier-label">{t("Held modifiers")}</span>
        {MODIFIERS.map((modifier) => {
          const item: KeyBarItem = { type: "modifier", modifier };
          const present = ids.has(keyBarItemId(item));
          return <button type="button" className="key-bar-settings-modifier" key={modifier} aria-pressed={present} disabled={full && !present} onClick={() => present ? update({ keyBarItems: items.filter((current) => keyBarItemId(current) !== keyBarItemId(item)) }) : add(item)}>{MODIFIER_CAPS[modifier]}</button>;
        })}
      </div>
      <div className="key-bar-settings-combo">
        <span className="settings-label">{t("Custom combination")}</span>
        <p className="settings-hint">{t("Saved combinations use only the selected modifiers. Other keys use held modifiers.")}</p>
        <div className="key-bar-settings-combo-key">
          <label className="key-bar-settings-field">
            <span className="settings-label">{t("Base key")}</span>
            <select className="input" value={comboKey} onChange={(event) => setComboKey(event.target.value)}>
              {comboKeys.map((key) => <option value={key} key={key}>{keyBarItemLabel({ type: "key", key })}</option>)}
              <option value={CHARACTER_KEY}>{t("Single character")}</option>
            </select>
          </label>
          {comboKey === CHARACTER_KEY && <label className="key-bar-settings-field">
            <span className="settings-label">{t("Character")}</span>
            <input className="input" value={character} maxLength={2} autoCapitalize="off" autoCorrect="off" spellCheck={false} onChange={(event) => setCharacter(event.target.value)} />
          </label>}
        </div>
        <div className="key-bar-settings-modifiers" role="group" aria-label={t("Combination modifiers")}>
          {MODIFIERS.map((modifier) => <button type="button" className="key-bar-settings-modifier" key={modifier} aria-pressed={comboModifiers[modifier]} onClick={() => setComboModifiers((current) => ({ ...current, [modifier]: !current[modifier] }))}>{MODIFIER_CAPS[modifier]}</button>)}
        </div>
        <div className="key-bar-settings-combo-actions">
          <span className="key-bar-settings-preview" aria-live="polite">{characterValid ? keyBarItemLabel(combo) : t("Enter one character.")}</span>
          <button type="button" className="btn" disabled={full || !characterValid || base === "" || comboExists} onClick={() => add(combo)}><Plus aria-hidden="true" />{t("Add combination")}</button>
        </div>
        {comboExists && <p className="settings-hint">{t("Already added")}</p>}
      </div>
      <button type="button" className="btn btn-ghost key-bar-settings-restore" onClick={() => update({ keyBarItems: [...DEFAULT_KEY_BAR_ITEMS] })}>{t("Restore defaults")}</button>
    </div>
  );
}
