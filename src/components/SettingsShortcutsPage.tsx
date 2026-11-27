import { useEffect, useRef, useState } from "react";
import { Command, Search } from "lucide-react";

import { SHORTCUTS, bindingDisplayKeys, fixedShortcut, formatKeys, isMacPlatform, setShortcutRecording, shortcutDisplayKeys, shortcutKeys, shortcutConflict, type ShortcutId } from "../lib/shortcuts.ts";
import { MENU_SHORTCUT_KEYS, recordShortcut, shortcutMatchesQuery } from "../lib/shortcutRecorder.ts";
import { exactChordRisk, isReservedShortcutKey, parseExactChord } from "../lib/shortcutBindings.ts";
import { compileHerdrKeys } from "../lib/herdrKeys.ts";
import { herdrKeys, loadHerdrUi } from "../lib/herdrUi.ts";
import { HERDR_PREFIX_ACTIONS, type HerdrKeys, type HerdrPrefixAction } from "../../shared/herdr-keys.ts";
import { useSettings } from "../lib/settings.ts";
import { useT } from "../lib/i18n.ts";
import { SettingsFold, SettingsGroup, SettingsRow, SettingsSelect, Toggle } from "./SettingsControls.tsx";

function compactKeys(keys: readonly string[]): string {
  return formatKeys(keys).map((key) => ({ Shift: "⇧", ArrowUp: "↑", ArrowDown: "↓", ArrowLeft: "←", ArrowRight: "→" }[key] ?? (key.length === 1 ? key.toUpperCase() : key))).join("+");
}

export function ShortcutsPage() {
  const { settings, update } = useSettings();
  const t = useT();
  const platformIsMac = isMacPlatform();
  const [query, setQuery] = useState("");
  const [recording, setRecording] = useState<{ id: ShortcutId; problem: string | null } | null>(null);
  const [pending, setPending] = useState<{ id: ShortcutId; value: string; risk: "terminal" | "browser" } | null>(null);
  const recordButtons = useRef(new Map<ShortcutId, HTMLButtonElement>());
  const settlePending = (id: ShortcutId): void => {
    setPending(null);
    recordButtons.current.get(id)?.focus();
  };
  const recordingId = recording?.id ?? null;
  const riskText = (risk: "terminal" | "browser", keys: string): string => risk === "terminal"
    ? t("{keys} is a terminal key: shells, editors and agents use it. Once saved, it no longer reaches the pane.", { keys })
    : t("Your browser or operating system may intercept {keys}.", { keys });
  useEffect(() => {
    if (recordingId === null) return;
    setShortcutRecording(true);
    const onKeyDown = (event: KeyboardEvent): void => {
      const result = recordShortcut(event, platformIsMac);
      if (result.kind === "ignore") return;
      event.preventDefault();
      event.stopPropagation();
      if (result.kind === "cancel") return setRecording(null);
      if (result.kind === "invalid") {
        const problem = result.reason === "chord"
          ? (platformIsMac ? t("Hold ⌘, Ctrl or ⌥, with or without Shift, and press a key.") : t("Hold Ctrl or Alt, with or without Shift, and press a key."))
          : result.reason === "key" ? t("That key cannot be a shortcut.") : t("Your browser or operating system keeps that shortcut.");
        return setRecording({ id: recordingId, problem });
      }
      const value = result.kind === "key" ? result.key : result.value;
      if (shortcutConflict(recordingId, [value], settings.shortcutOverrides, platformIsMac)) return setRecording({ id: recordingId, problem: t("Already assigned") });
      setRecording(null);
      if (result.kind === "exact" && result.risk !== null && (result.risk !== "terminal" || recordingId !== "quote-chat")) return setPending({ id: recordingId, value, risk: result.risk });
      update({ shortcutOverrides: { ...settings.shortcutOverrides, [recordingId]: value } });
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      setShortcutRecording(false);
    };
  }, [recordingId, platformIsMac, settings.shortcutOverrides, update, t]);
  const visible = SHORTCUTS.filter((shortcut) => {
    const keys = shortcutDisplayKeys(shortcut.id, settings.shortcutOverrides);
    return shortcutMatchesQuery(t(shortcut.label), `${formatKeys(keys).join(" ")} ${compactKeys(keys)}`, query);
  });
  return (
    <>
      {/* the same glass as Settings' own search (G-178) */}
      <div className="settings-search">
        <Search aria-hidden="true" />
        <input
          type="search"
          className="input settings-search-input settings-shortcut-search"
          value={query}
          placeholder={t("Search shortcuts")}
          aria-label={t("Search shortcuts")}
          autoComplete="off"
          spellCheck={false}
          onChange={(event) => setQuery(event.target.value)}
        />
      </div>
      {visible.length === 0 && <p className="settings-hint" role="status">{t("No shortcuts match.")}</p>}
      <SettingsGroup className="settings-shortcuts" section="shortcuts">
        {visible.map((shortcut) => {
          const displayedKeys = shortcutDisplayKeys(shortcut.id, settings.shortcutOverrides);
          const selectedKey = displayedKeys[displayedKeys.length - 1];
          const override = Object.hasOwn(settings.shortcutOverrides, shortcut.id) ? settings.shortcutOverrides[shortcut.id] : null;
          const exact = override ? parseExactChord(override) : null;
          const risk = exact ? exactChordRisk(exact, platformIsMac) : selectedKey !== undefined && isReservedShortcutKey(selectedKey, platformIsMac) ? "browser" : null;
          const selectedRisk = risk === "terminal" && shortcut.id === "quote-chat" ? null : risk;
          const confirming = pending?.id === shortcut.id ? pending : null;
          const defaultKeys = shortcutDisplayKeys(shortcut.id, {});
          const defaultKey = defaultKeys[defaultKeys.length - 1];
          const defaultReserved = defaultKey !== undefined && isReservedShortcutKey(defaultKey, platformIsMac);
          const unbound = defaultKeys.length === 0;
          const fixed = fixedShortcut(shortcut.id);
          const rowText = recording?.id === shortcut.id ? (recording.problem ?? t("Press the new shortcut, or Escape to cancel.")) : confirming ? riskText(confirming.risk, compactKeys(bindingDisplayKeys(confirming.value))) : selectedRisk ? riskText(selectedRisk, compactKeys(displayedKeys)) : undefined;
          // a terminal app's close key is the browser's tab close, which Record refuses (exactChordRefusal); and
          // the two closes differ: the tab's leaves the pane running, the pane's ends it
          const help = shortcut.id === "close-pane" ? t("{key} closes the browser tab, so it cannot be used here: record another key. Closing a browser tab only disconnects this view; Close pane stops what runs in the pane.", { key: platformIsMac ? "⌘W" : "Ctrl+W" })
            : shortcut.id === "close-tab" ? t("{key} closes the browser tab, so it cannot be used here: record another key. Closing a browser tab only disconnects this view; Close tab stops what runs in the tab.", { key: platformIsMac ? "⌘W" : "Ctrl+W" }) : undefined;
          const resetShortcut = (): void => {
            const next = { ...settings.shortcutOverrides };
            delete next[shortcut.id];
            update({ shortcutOverrides: next });
          };
          return (
            <SettingsRow key={shortcut.id} label={t(shortcut.label)} onReset={Object.hasOwn(settings.shortcutOverrides, shortcut.id) && !shortcutConflict(shortcut.id, shortcutKeys(shortcut.id, {}), settings.shortcutOverrides) ? resetShortcut : undefined} held={recording?.id === shortcut.id || confirming !== null} wide description={rowText === undefined ? help : <span role="status">{rowText}</span>}>
                <span className="settings-shortcut-control">
                {!fixed && <button type="button" className="btn settings-shortcut-record" ref={(button) => { if (button) recordButtons.current.set(shortcut.id, button); else recordButtons.current.delete(shortcut.id); }} aria-pressed={recording?.id === shortcut.id} aria-label={t("Record shortcut for {name}", { name: t(shortcut.label) })} onClick={() => { setPending(null); setRecording(recording?.id === shortcut.id ? null : { id: shortcut.id, problem: null }); }}>{recording?.id === shortcut.id ? t("Press keys…") : t("Record")}</button>}
                {confirming ? <>
                  <button type="button" className="btn settings-shortcut-confirm" onClick={() => {
                    settlePending(confirming.id);
                    update({ shortcutOverrides: { ...settings.shortcutOverrides, [confirming.id]: confirming.value } });
                  }}>{t("Save anyway")}</button>
                  <button type="button" className="btn" onClick={() => settlePending(confirming.id)}>{t("Cancel")}</button>
                </> : <SettingsSelect className="settings-shortcut-select" aria-label={t(shortcut.label)} value={override ?? (unbound || displayedKeys.length > 0 ? "default" : "off")} onChange={(event) => {
                  const next = { ...settings.shortcutOverrides };
                  if (event.target.value === "default") delete next[shortcut.id];
                  else next[shortcut.id] = event.target.value === "off" ? null : event.target.value;
                  update({ shortcutOverrides: next });
                }}>
                  <option value="default" title={t("Default")} disabled={shortcutConflict(shortcut.id, shortcutKeys(shortcut.id, {}), settings.shortcutOverrides)}>{unbound ? t("Off") : compactKeys(defaultKeys)}{defaultReserved ? ` — ${t("Reserved")}` : ""}</option>
                  {!unbound && <option value="off" title={fixed ? undefined : t("Send keys to terminal")}>{t("Off")}</option>}
                  {/* a recorded chord the list below does not offer (exact modifiers, Home, End, punctuation) is listed as itself */}
                  {override && (exact || !MENU_SHORTCUT_KEYS.includes(override)) && <option value={override}>{compactKeys(displayedKeys)}</option>}
                  {!fixed && MENU_SHORTCUT_KEYS.map((key) => {
                    const conflict = shortcutConflict(shortcut.id, [key], settings.shortcutOverrides);
                    const reserved = isReservedShortcutKey(key, platformIsMac);
                    return <option key={key} value={key} disabled={conflict}>{compactKeys(["Mod", "Shift", key])}{reserved ? ` — ${t("Reserved")}` : ""}{conflict ? " — " + t("Already assigned") : ""}</option>;
                  })}
                </SettingsSelect>}
                </span>
            </SettingsRow>
          );
        })}
      </SettingsGroup>
      <div className="settings-actions">
        <button type="button" className="btn" onClick={() => {
          setPending(null);
          setRecording(null);
          update({ shortcutOverrides: {} });
        }}>{t("Reset shortcuts")}</button>
      </div>
      <SettingsFold kind="more" keys={["herdrPrefixKeys"]}>
        <HerdrPrefixKeys />
      </SettingsFold>
    </>
  );
}

const HERDR_ACTION_LABELS: Readonly<Record<HerdrPrefixAction, string>> = {
  help: "Command palette",
  settings: "Settings",
  workspace_picker: "Command palette",
  goto: "Command palette",
  new_workspace: "New workspace",
  previous_workspace: "Previous workspace",
  next_workspace: "Next workspace",
  new_tab: "New terminal",
  rename_tab: "Rename tab",
  previous_tab: "Previous tab",
  next_tab: "Next tab",
  switch_tab: "Go to tab 1-9",
  split_vertical: "Split pane right",
  split_horizontal: "Split pane down",
  zoom: "Zoom or unzoom pane",
  toggle_sidebar: "Toggle sidebar",
};

function HerdrPrefixKeys() {
  const { settings, update } = useSettings();
  const t = useT();
  const on = settings.herdrPrefixKeys;
  const [keys, setKeys] = useState<{ read: HerdrKeys | null } | null>(null);
  useEffect(() => {
    if (!on) return;
    let live = true;
    void loadHerdrUi().then(() => { if (live) setKeys({ read: herdrKeys() }); });
    return () => { live = false; };
  }, [on]);
  const read = keys?.read ?? null;
  const map = read ? compileHerdrKeys(read) : null;
  const bound = read === null || map === null ? [] : HERDR_PREFIX_ACTIONS.filter((action) => read.bindings[action].length > 0);
  const rows = [...new Set(bound.map((action) => HERDR_ACTION_LABELS[action]))]
    .map((label) => ({ label, keys: bound.filter((action) => HERDR_ACTION_LABELS[action] === label).flatMap((action) => read?.bindings[action] ?? []) }));
  const status = !on || keys === null ? null
    : read === null ? t("This PC's server does not report herdr's keys yet.")
    : map === null ? t("herdr's prefix in its config.toml cannot be used here, so no key is taken.")
    : null;
  return (
    <SettingsGroup title={t("herdr prefix keys")} section="herdr-keys">
      <SettingsRow label={t("Use herdr's prefix keys")} icon={Command} description={t("herdr's prefix, then a key that herdr's config.toml on this PC binds, runs that action here; the actions are listed below. The prefix then no longer reaches the pane (press it twice to send it), while fields, dialogs and IME input keep their keys.")}>
        <Toggle label={t("Use herdr's prefix keys")} checked={on} onChange={(herdrPrefixKeys) => update({ herdrPrefixKeys })} />
      </SettingsRow>
      {status !== null && <p className="settings-item settings-description" role="status">{status}</p>}
      {on && read !== null && map !== null && <>
        <SettingsRow label={t("Prefix")}>
          <span className="settings-keys">{read.prefixes.map((prefix) => <kbd className="kbd" key={prefix}>{prefix}</kbd>)}</span>
        </SettingsRow>
        {rows.map((row) => (
          <SettingsRow key={row.label} label={t(row.label)}>
            <span className="settings-keys">{row.keys.map((key) => <kbd className="kbd" key={key}>{key}</kbd>)}</span>
          </SettingsRow>
        ))}
      </>}
    </SettingsGroup>
  );
}