/**
 * herdr's prefix keys in the app (Settings → Shortcuts → Use herdr's prefix keys, off by default):
 * herdr's prefix (Ctrl+B unless its config.toml says otherwise), then a key herdr binds to one of
 * the actions in shared/herdr-keys.ts runs the app's own action for it.
 */
import { tally } from "./usageCounters.ts";
import type { TelemetryAction } from "../../shared/telemetry.ts";
import { useEffect, useState } from "react";
import { bindingChords, parseHerdrBinding, type HerdrChord, type HerdrKeys, type HerdrPrefixAction } from "../../shared/herdr-keys.ts";
import type { AppActions } from "./actions.ts";
import { ApiError } from "./api.ts";
import { herdrKeys, loadHerdrUi } from "./herdrUi.ts";
import { useT } from "./i18n.ts";
import { useSettings } from "./settings.ts";
import { isAppShortcut, isRecordingShortcut, shortcutEventKey, type ShortcutEventLike } from "./shortcuts.ts";

/**
 * Letters and digits are read by position where the layout types something else (shortcutEventKey: a
 * Korean or Cyrillic letter, a digit with Shift); punctuation by the character typed, so `?` is
 * Shift+/ on a US keyboard and whatever types it elsewhere.
 */
export function chordMatches(chord: HerdrChord, event: ShortcutEventLike): boolean {
  if (chord.hyper || event.ctrlKey !== chord.ctrl || event.altKey !== chord.alt || event.metaKey !== chord.meta) return false;
  if (/^[a-z0-9]$/.test(chord.key)) return event.shiftKey === chord.shift && shortcutEventKey(event) === chord.key;
  if ([...chord.key].length === 1 && chord.key !== " ") return event.key === chord.key && (!chord.shift || event.shiftKey);
  return event.key === chord.key && event.shiftKey === chord.shift;
}

export interface HerdrKeyMap {
  readonly prefixes: readonly HerdrChord[];
  readonly bindings: readonly { readonly action: HerdrPrefixAction; readonly chord: HerdrChord; readonly index: number | null }[];
}

export function compileHerdrKeys(keys: HerdrKeys): HerdrKeyMap | null {
  const prefixes = keys.prefixes.flatMap((text) => {
    const prefix = parseHerdrBinding(text);
    return prefix === null || prefix.prefixed || prefix.range ? [] : [prefix.chord];
  });
  if (prefixes.length === 0) return null;
  const bindings = Object.entries(keys.bindings).flatMap(([action, texts]) => texts.flatMap((text) => {
    const binding = parseHerdrBinding(text);
    return binding?.prefixed ? bindingChords(binding, action).map((item) => ({ action: action as HerdrPrefixAction, ...item })) : [];
  }));
  return bindings.length === 0 ? null : { prefixes, bindings };
}

export type HerdrKeyStep =
  | { readonly kind: "ignore" }
  | { readonly kind: "pass" }
  | { readonly kind: "arm" }
  | { readonly kind: "hold" }
  | { readonly kind: "escape" }
  | { readonly kind: "run"; readonly action: HerdrPrefixAction; readonly index: number | null };

const MODIFIER_KEYS = new Set(["Shift", "Control", "Alt", "Meta", "AltGraph", "CapsLock", "Fn", "OS"]);

export function herdrKeyStep(map: HerdrKeyMap, armed: boolean, event: ShortcutEventLike & { readonly repeat?: boolean }): HerdrKeyStep {
  if (MODIFIER_KEYS.has(event.key)) return { kind: "ignore" };
  const isPrefix = map.prefixes.some((prefix) => chordMatches(prefix, event));
  if (armed && event.repeat === true && isPrefix) return { kind: "hold" };
  if (event.isComposing || event.keyCode === 229) return { kind: "pass" };
  if (!armed) return isPrefix ? { kind: "arm" } : { kind: "pass" };
  const binding = map.bindings.find((candidate) => chordMatches(candidate.chord, event));
  if (binding !== undefined) return { kind: "run", action: binding.action, index: binding.index };
  return event.key === "Escape" ? { kind: "escape" } : { kind: "pass" };
}

const HERDR_KEY_ACTIONS: Partial<Record<HerdrPrefixAction, TelemetryAction>> = {
  settings: "settings", new_workspace: "new_workspace", new_tab: "new_tab", split_vertical: "split", split_horizontal: "split", toggle_sidebar: "sidebar",
};

export function runHerdrAction(actions: AppActions, action: HerdrPrefixAction, index: number | null, tabRefused: (reason: unknown) => void): void {
  const counted = HERDR_KEY_ACTIONS[action];
  if (counted) tally(() => actions.counted?.(counted, "shortcut"));
  switch (action) {
    case "help":
    case "workspace_picker":
    case "goto":
      actions.openPalette();
      return;
    case "settings":
      actions.openSettings();
      return;
    case "new_workspace":
      actions.openNewSession();
      return;
    case "previous_workspace":
      actions.selectAdjacentWorkspace(-1);
      return;
    case "next_workspace":
      actions.selectAdjacentWorkspace(1);
      return;
    case "new_tab":
      actions.openTerminalTab().catch(tabRefused);
      return;
    case "rename_tab":
      actions.renameTab();
      return;
    case "previous_tab":
      actions.selectAdjacentTab(-1);
      return;
    case "next_tab":
      actions.selectAdjacentTab(1);
      return;
    case "switch_tab":
      if (index !== null) actions.selectTabNumber(index);
      return;
    case "split_vertical":
      actions.splitPane?.("right");
      return;
    case "split_horizontal":
      actions.splitPane?.("down");
      return;
    case "zoom":
      actions.toggleZoom?.();
      return;
    case "toggle_sidebar":
      actions.toggleSidebar();
      return;
  }
}

function keepsKeys(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  if (target.classList.contains("xterm-helper-textarea")) return false;
  return target.closest("input, textarea, select, [contenteditable]:not([contenteditable='false']), dialog, [role='dialog'], [role='alertdialog'], [role='menu'], [role='listbox']") !== null;
}

export function useHerdrPrefixKeys(actions: AppActions, enabled: boolean, notice: (text: string) => void): boolean {
  const { settings } = useSettings();
  const t = useT();
  const on = enabled && settings.herdrPrefixKeys;
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    setArmed(false);
    if (!on) return;
    void loadHerdrUi();
    let waiting = false;
    const disarm = (): void => { waiting = false; setArmed(false); };
    const onKeyDown = (event: KeyboardEvent): void => {
      const keys = herdrKeys();
      const map = keys === null ? null : compileHerdrKeys(keys);
      if (map === null || isRecordingShortcut()) return;
      if (keepsKeys(event.target) || isAppShortcut(event, settings.shortcutOverrides)) { if (waiting) disarm(); return; }
      const step = herdrKeyStep(map, waiting, event);
      if (step.kind === "ignore") return;
      if (step.kind === "pass") { if (waiting) disarm(); return; }
      event.preventDefault();
      event.stopPropagation();
      if (step.kind === "hold") return;
      if (step.kind === "arm") { waiting = true; setArmed(true); return; }
      disarm();
      if (step.kind === "run") runHerdrAction(actions, step.action, step.index, (reason) => notice(t("New terminal failed: {reason}", { reason: reason instanceof ApiError ? reason.detail : reason instanceof Error ? reason.message : String(reason) })));
    };
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("blur", disarm);
    window.addEventListener("pointerdown", disarm, true);
    document.addEventListener("visibilitychange", disarm);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("blur", disarm);
      window.removeEventListener("pointerdown", disarm, true);
      document.removeEventListener("visibilitychange", disarm);
    };
  }, [on, actions, notice, t, settings.shortcutOverrides]);
  return armed;
}
