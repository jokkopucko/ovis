import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode, type RefObject } from "react";
import { ArrowLeft, Bell, Check, ChevronRight, Gauge, Info, Keyboard, MessageSquare, Mic, Monitor, Palette, Plug, Plus, Search, Smartphone, SquareTerminal, Star, X, type LucideIcon } from "lucide-react";

import "./SettingsDialog.css";

import type { AppActions } from "../lib/actions.ts";
import { useInstallPrompt } from "../lib/install.ts";
import { changePc, inNativeApp } from "../lib/nativeApp.ts";
import { SHORTCUTS, bindingDisplayKeys, formatKeys, isMacPlatform, setShortcutRecording, shortcutDisplayKeys, shortcutKeys, shortcutConflict, type ShortcutId } from "../lib/shortcuts.ts";
import { MENU_SHORTCUT_KEYS, recordShortcut, shortcutMatchesQuery } from "../lib/shortcutRecorder.ts";
import { exactChordRisk, isReservedShortcutKey, parseExactChord } from "../lib/shortcutBindings.ts";
import { WEB_LINK_TARGETS } from "../lib/webPanel.ts";
import { FILE_OPEN_TARGETS } from "../lib/filePresentation.ts";
import { CLAUDE_LAUNCH_MODES, CODEX_LAUNCH_MODES, type ClaudeLaunchMode, type CodexLaunchMode } from "../lib/agentLaunchMode.ts";
import { CHAT_FONT_MAX, CHAT_FONT_MIN, CHAT_WIDTHS, chatFontSize, HISTORY_PROMPTS, DEFAULT_SETTINGS, DIFF_STYLES, MARKDOWN_WIDTHS, QUICK_REPLIES_MAX, QUICK_REPLY_MAX_CHARS, TERMINAL_FONT_MAX, TERMINAL_FONT_MIN, TERMINAL_WHEEL_SPEED_MAX, TERMINAL_WHEEL_SPEED_MIN, DICTATION_LANGUAGES, VOICE_BUTTONS, useSettings, forgetPaneViews, uiFontSize, type DictationLanguage, type VoiceButton } from "../lib/settings.ts";
import { pickTheme, rowFor, THEME_IDS, type Mode, type ThemeId } from "../lib/themes.ts";
import { LANGUAGE_NAMES, LANGUAGE_SETTINGS, useLocale, useT } from "../lib/i18n.ts";
import { useFocusTrap } from "../lib/useFocusTrap.ts";
import { KeyBarSettings } from "./KeyBarSettings.tsx";
import { onSettingsHistory, recordSettings, settingsEntry, settingsLevels, type SettingsLevel } from "../lib/settingsHistory.ts";
import { Segmented, SettingsGroup, SettingsRow, SettingsSelect, Stepper, Toggle } from "./SettingsControls.tsx";
import { FONT_FAMILY_MAX_CHARS, sanitizeFontFamily } from "../lib/fontFamily.ts";
import { UI_FONT_MAX, UI_FONT_MIN, UI_FONT_PRESET_FAMILY, uiFontPreset, type UiFontPreset } from "../lib/typography.ts";
import { canListInstalledFonts, filterFamilies, isMonospaceFamily, queryInstalledFonts } from "../lib/installedFonts.ts";
import type { UpdatesModel } from "../lib/updates.ts";
import type { UserError } from "../lib/userError.ts";
import type { Machine, MachineSettings } from "../../shared/machines.ts";
import { canHideMachine, isMachineShown, setHiddenMachines, useHiddenMachines, withMachineHidden } from "../lib/hiddenMachines.ts";
import { fetchRemoteAccess, fetchVoiceStatus, machineRequest, saveVoiceConfig } from "../lib/api.ts";
import { isLoopbackHost, phonePlan } from "../lib/phone.ts";
import type { PushActionResult } from "../lib/pushHealth.ts";
import type { AgentIntegration, HealthAuth, PluginActions, RemoteAccess } from "../../shared/protocol.ts";
import type { SecurityFacts } from "../lib/useAccess.ts";
import { useMachineApi, useMachineId } from "../lib/machineContext.tsx";
import { loadIntegrations, outcomeFor, type IntegrationsResult } from "../lib/integrations.ts";
import type { VoiceStatus } from "../../shared/voice.ts";
import { dictationLocale, VOICE_CONFIG_EVENT } from "../lib/voice.ts";
import { DevicesPanel } from "./DevicesPanel.tsx";
import { ConfirmDialog } from "./ConfirmDialog.tsx";
import { PhonePanel } from "./PhonePanel.tsx";
import { PortalPanel } from "./PortalPanel.tsx";
import { copyText } from "../lib/clipboard.ts";
import { PushTestControls } from "./PushTestControls.tsx";
import { previewAlertSound, unlockAlertSound } from "../lib/alertSound.ts";
import { HerdrUpdateControls, UpdateControls } from "./UpdateControls.tsx";
import { TelemetryControls } from "./TelemetryControls.tsx";
import { UsageSettings } from "./UsageSettings.tsx";
import { useSheetSwipe } from "../lib/sheets.ts";
import { useMediaQuery } from "../lib/useMediaQuery.ts";
import { CrashProbe, RegionCrash } from "./AppCrash.tsx";
import { RenderBoundary } from "./RenderBoundary.tsx";
import { requestedSettingsPage, requestSettingsPage, type SettingsPageId } from "../lib/paletteSettings.ts";

export interface SettingsDialogProps {
  open: boolean;
  /** the section to open on, for a button that points at it; the top otherwise */
  section?: "updates" | null;
  /** the page a link to Settings names (`?settings=`, lib/deepLink.ts), for this opening alone */
  linkPage?: string | null;
  /** the group on that page a link names (`&section=`): it is scrolled to and focused, as Updates is */
  linkSection?: string | null;
  /** the page shown, for the address; null while a phone shows its list of pages */
  onPage?: (page: string | null) => void;
  onClose: () => void;
  /** Account login runs on this server's PC, even while another PC is selected. */
  onUsageLogin: (paneId: string) => void;
  actions: AppActions;
  updates: UpdatesModel;
  /** how this browser got in, from the last health check */
  auth: HealthAuth | null;
  /** the herdr this app's server talks to, from the last health check */
  herdrVersion: string | null;
  /** what protects this server, from the last bridge health check: never an earlier answer once one fails */
  security: SecurityFacts;
  onEnableNotifications: () => Promise<PushActionResult>;
  /** the last change the server refused to save (lib/preferencesSync.ts); null once a save lands */
  saveError: UserError | null;
  /** three saves failed in a row: nothing is sent until Retry, a reconnect or a longer wait */
  savePaused: boolean;
  /** a Retry of that save is waiting for its answer */
  saveRetrying: boolean;
  onRetrySave: () => void;
  /** a file preview is open beneath: the dialog is drawn above it */
  overPreview?: boolean;
  /** every PC of the roster, the hidden ones too: Remote PCs lists them with their Show in sidebar switch */
  machines?: readonly Machine[];
}

/**
 * The access facts as the app last heard them: `absent` is a server that answered without them
 * (an older one), `error` one that did not answer. Neither is ever filled in from `auth` or from
 * the missing LAN warning.
 */

function compactKeys(keys: readonly string[]): string {
  return formatKeys(keys).map((key) => ({ Shift: "⇧", ArrowUp: "↑", ArrowDown: "↓", ArrowLeft: "←", ArrowRight: "→" }[key] ?? (key.length === 1 ? key.toUpperCase() : key))).join("+");
}

const FONT_LIST_LIMIT = 150;
const FONT_FAMILY_PLACEHOLDER = 'D2Coding, "Cascadia Mono"';
const UI_FONT_PLACEHOLDER = '"Noto Sans JP", "Segoe UI"';

/**
 * A font family list, saved when the field is left, on Enter or when the dialog closes: saving
 * every keystroke would sanitize away the comma or space being typed, and each change of the
 * terminal's font refits the grid and resizes the pane.
 */
function FontFamilyInput({ value, label, onCommit, placeholder = FONT_FAMILY_PLACEHOLDER, fixedWidthFor = null }: { value: string; label: string; onCommit: (family: string) => void; placeholder?: string; /** the surface that needs every glyph on one advance: a proportional pick from the list is refused in its name */ fixedWidthFor?: "terminal" | null }) {
  const t = useT();
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const commit = (): void => {
    const next = sanitizeFontFamily(draft);
    setDraft(next);
    if (next !== value) onCommit(next);
  };
  // closing the dialog with Escape unmounts the field without a blur
  const commitRef = useRef(commit);
  commitRef.current = commit;
  useEffect(() => () => commitRef.current(), []);
  const [families, setFamilies] = useState<string[] | null>(null);
  const [browsing, setBrowsing] = useState(false);
  const [query, setQuery] = useState("");
  const [refused, setRefused] = useState("");
  const [unavailable, setUnavailable] = useState(false);
  // the click is the gesture the permission prompt needs; where the API is missing there is no button
  const browse = async (): Promise<void> => {
    if (browsing) {
      setBrowsing(false);
      return;
    }
    setRefused("");
    setQuery("");
    if (families === null) {
      const result = await queryInstalledFonts();
      if (result.status !== "granted") {
        setUnavailable(true);
        return;
      }
      setUnavailable(false);
      setFamilies(result.families);
    }
    setBrowsing(true);
  };
  const matches = useMemo(() => filterFamilies(families ?? [], query), [families, query]);
  const pick = (family: string): void => {
    if (fixedWidthFor !== null && !isMonospaceFamily(family)) {
      setRefused(family);
      return;
    }
    const next = sanitizeFontFamily(family);
    setDraft(next);
    setBrowsing(false);
    if (next !== value) onCommit(next);
  };
  return (
    <div className="settings-font-field">
      <div className="settings-font-line">
        <input
          className="input settings-font-input"
          value={draft}
          placeholder={placeholder}
          maxLength={FONT_FAMILY_MAX_CHARS}
          aria-label={label}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            // an IME keeps its Enter, including the committing one WebKit can send after compositionend as key code 229
            if (event.key !== "Enter" || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
            event.preventDefault();
            commit();
          }}
        />
        {canListInstalledFonts() && (
          <button type="button" className="btn settings-font-browse" aria-expanded={browsing} aria-label={t("Browse installed fonts for {label}", { label })} onClick={() => void browse()}>
            <Search aria-hidden="true" />
            {t("Browse")}
          </button>
        )}
      </div>
      {unavailable && <p className="settings-font-note" role="status">{t("Installed fonts could not be listed. Type the name instead.")}</p>}
      {browsing && families !== null && (
        <div className="settings-font-picker">
          <input
            className="input settings-font-search"
            type="search"
            value={query}
            placeholder={t("Search fonts")}
            aria-label={t("Search fonts")}
            spellCheck={false}
            autoFocus
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape" && !event.nativeEvent.isComposing) {
                // closes the list, not the dialog behind it
                event.stopPropagation();
                setBrowsing(false);
              }
            }}
          />
          {refused !== "" && <p className="settings-font-note" role="status">{t("{font} is not monospace. The terminal needs a fixed-width font, so the current font was kept.", { font: refused })}</p>}
          <ul className="settings-font-list" aria-label={t("Installed fonts")}>
            {matches.slice(0, FONT_LIST_LIMIT).map((family) => (
              <li key={family}>
                <button type="button" className="settings-font-option" style={{ fontFamily: `"${family}", var(--font-ui)` }} onClick={() => pick(family)}>
                  {family}
                </button>
              </li>
            ))}
            {matches.length === 0 && <li className="settings-font-empty">{t("No fonts found")}</li>}
          </ul>
          {matches.length > FONT_LIST_LIMIT && <p className="settings-font-note">{t("Showing the first {count} fonts. Search to narrow the list.", { count: FONT_LIST_LIMIT })}</p>}
        </div>
      )}
    </div>
  );
}


type SettingsPage = SettingsPageId;

/** The pages in the order the list shows them: what is looked at first, then what is set once. */
export const PAGES: readonly { id: SettingsPage; icon: LucideIcon }[] = [
  { id: "appearance", icon: Palette },
  { id: "chat", icon: MessageSquare },
  { id: "terminal", icon: SquareTerminal },
  { id: "alerts", icon: Bell },
  { id: "voice", icon: Mic },
  { id: "usage", icon: Gauge },
  { id: "shortcuts", icon: Keyboard },
  { id: "devices", icon: Smartphone },
  { id: "remote", icon: Monitor },
  { id: "integrations", icon: Plug },
  { id: "about", icon: Info },
];

/** The sheet's own breakpoint (`.modal`, styles.css): under it the list and a page take turns. */
const NARROW_QUERY = "(max-width: 640px)";

function useNarrow(): boolean {
  const [narrow, setNarrow] = useState(() => window.matchMedia?.(NARROW_QUERY).matches === true);
  useEffect(() => {
    const media = window.matchMedia?.(NARROW_QUERY);
    if (!media) return;
    const refresh = () => setNarrow(media.matches);
    refresh();
    media.addEventListener("change", refresh);
    return () => media.removeEventListener("change", refresh);
  }, []);
  return narrow;
}

/** What a Settings entry of the history shows, when it names a page this version has. */
function shownBy(entry: SettingsLevel | null): { page: SettingsPage | null; keyBar: boolean } | null {
  if (entry === null) return null;
  const page = PAGES.find(({ id }) => id === entry.page)?.id ?? null;
  return page === null && entry.page !== null ? null : { page, keyBar: entry.keyBar && page === "terminal" };
}

/** What each theme is called: the color words are translated, the brand names stay as their projects write them. */
const THEME_NAMES: Record<ThemeId, string> = {
  amber: "Amber",
  charcoal: "Charcoal",
  codex: "Codex",
  catppuccin: "Catppuccin",
  "catppuccin-latte": "Catppuccin Latte",
  "tokyo-night": "Tokyo Night",
  "black": "Black",
  "tokyo-night-day": "Tokyo Night Day",
  gruvbox: "Gruvbox",
  "gruvbox-light": "Gruvbox Light",
  "one-dark": "One Dark",
  "one-light": "One Light",
  solarized: "Solarized",
  "solarized-light": "Solarized Light",
  kanagawa: "Kanagawa",
  "kanagawa-lotus": "Kanagawa Lotus",
  "rose-pine": "Rosé Pine",
  "rose-pine-dawn": "Rosé Pine Dawn",
  dracula: "Dracula",
  nord: "Nord",
  vesper: "Vesper",
};

/**
 * Every theme, grouped by the kind of the row `side` draws it with - a both-mode theme by the
 * side's own kind, a single-kind theme by its only one - the side's own kind first. The other
 * kind is offered too: a dark theme chosen for light mode draws dark, as it does in herdr.
 */
function themeGroups(side: Mode): { kind: Mode; ids: ThemeId[] }[] {
  const other: Mode = side === "dark" ? "light" : "dark";
  return [side, other].map((kind) => ({ kind, ids: THEME_IDS.filter((id) => rowFor(id, side).mode === kind) }));
}

/** The theme of one side. Picking a paired theme also fills the other side with its sibling while that side is still untouched (pickTheme). */
function ThemeSelect({ side }: { side: Mode }) {
  const { settings, update } = useSettings();
  const t = useT();
  return (
    <SettingsSelect id={`settings-theme-${side}`} value={side === "dark" ? settings.darkTheme : settings.lightTheme} onChange={(event) => update(pickTheme(settings, side, event.target.value as ThemeId))}>
      {themeGroups(side).map(({ kind, ids }) => (
        <optgroup key={kind} label={kind === "dark" ? t("Dark") : t("Light")}>
          {ids.map((id) => <option key={id} value={id}>{t(THEME_NAMES[id])}</option>)}
        </optgroup>
      ))}
    </SettingsSelect>
  );
}

/**
 * Settings → Appearance → Interface font: the built-in stack, the device's own interface font, Noto Sans, or a
 * list typed like the chat's. Custom opens the field and keeps what is drawn until a list is typed.
 */
function InterfaceFontRows() {
  const { settings, update } = useSettings();
  const t = useT();
  const preset = uiFontPreset(settings.uiFontFamily);
  const [customOpen, setCustomOpen] = useState(preset === "custom");
  const custom = customOpen || preset === "custom";
  const choose = (next: UiFontPreset | "custom"): void => {
    setCustomOpen(next === "custom");
    if (next !== "custom") update({ uiFontFamily: UI_FONT_PRESET_FAMILY[next] });
  };
  return (
    <>
      <SettingsRow label={t("Interface font")} description={t("Menus, lists, dialogs and the sidebar; the chat's text follows it until it has a font of its own. The terminal and code keep theirs. System is this device's own interface font.")} htmlFor="settings-ui-font">
        <SettingsSelect id="settings-ui-font" value={custom ? "custom" : preset} onChange={(event) => choose(event.target.value as UiFontPreset | "custom")}>
          <option value="default">{t("Default")}</option>
          <option value="system">{t("System")}</option>
          <option value="noto">Noto Sans</option>
          <option value="custom">{t("Custom")}</option>
        </SettingsSelect>
      </SettingsRow>
      {custom && (
        <SettingsRow label={t("Custom interface font")} description={t("Comma-separated, tried in order, in front of the default. A font this device does not have falls back to the default.")} wide>
          <FontFamilyInput value={settings.uiFontFamily} label={t("Custom interface font")} placeholder={UI_FONT_PLACEHOLDER} onCommit={(uiFontFamily) => update({ uiFontFamily })} />
        </SettingsRow>
      )}
    </>
  );
}

function AppearancePage() {
  const { settings, update } = useSettings();
  const t = useT();
  return (
    <>
    <SettingsGroup>
      <SettingsRow label={t("Theme")} wide>
        <Segmented label={t("Theme")} value={settings.theme} onChange={(theme) => update({ theme })} options={[{ value: "dark", label: t("Dark") }, { value: "light", label: t("Light") }, { value: "system", label: t("System") }]} />
      </SettingsRow>
      <SettingsRow label={t("Dark theme")} description={t("Shown in dark mode")} htmlFor="settings-theme-dark" wide>
        <ThemeSelect side="dark" />
      </SettingsRow>
      <SettingsRow label={t("Light theme")} description={t("Shown in light mode")} htmlFor="settings-theme-light" wide>
        <ThemeSelect side="light" />
      </SettingsRow>
      <SettingsRow label={t("Density")}>
        <Segmented label={t("Density")} value={settings.density} onChange={(density) => update({ density })} options={[{ value: "comfortable", label: t("Comfortable") }, { value: "compact", label: t("Compact") }]} />
      </SettingsRow>
      <SettingsRow label={t("Language")} description={t("Follows the browser unless you choose one")} htmlFor="settings-language">
        <SettingsSelect id="settings-language" value={settings.language} onChange={(event) => update({ language: event.target.value as typeof settings.language })}>
          {LANGUAGE_SETTINGS.map((language) => <option key={language} value={language}>{language === "system" ? t("System") : LANGUAGE_NAMES[language]}</option>)}
        </SettingsSelect>
      </SettingsRow>
      <SettingsRow label={t("Sidebar rows")} description={t("Name each workspace on one line, or show what its agent is doing with the workspace under it")} wide>
        <Segmented label={t("Sidebar rows")} value={settings.sidebarRows} onChange={(sidebarRows) => update({ sidebarRows })} options={[{ value: "one", label: t("One line") }, { value: "two", label: t("Two lines") }]} />
      </SettingsRow>
      <SettingsRow label={t("Sidebar filter")} description={t("Show the Filter field above the sidebar's lists on this device. When off, Filter workspaces and agents in the command palette opens it.")}>
        <Toggle label={t("Sidebar filter")} checked={settings.sidebarFilter} onChange={(sidebarFilter) => update({ sidebarFilter })} />
      </SettingsRow>
      <SettingsRow label={t("Agents order")} description={t("Activity keeps a waiting agent on top, then the one that changed last; herdr's own order is not changed")} wide>
        <Segmented label={t("Agents order")} value={settings.agentOrder} onChange={(agentOrder) => update({ agentOrder })} options={[{ value: "workspace", label: t("Workspaces") }, { value: "activity", label: t("Activity") }]} />
      </SettingsRow>
      <SettingsRow label={t("Agent logos")} description={t("Draw each agent's logo in its brand colors, or without color")} wide>
        <Segmented label={t("Agent logos")} value={settings.agentMarks} onChange={(agentMarks) => update({ agentMarks })} options={[{ value: "color", label: t("Color") }, { value: "mono", label: t("Mono") }]} />
      </SettingsRow>
      <SettingsRow label={t("Status indicators")} description={t("Classic marks only the states that ask for a look; Dots and Symbols draw every state as herdr's TUI does")} wide>
        <Segmented label={t("Status indicators")} value={settings.statusIndicators} onChange={(statusIndicators) => update({ statusIndicators })} options={[{ value: "classic", label: t("Classic") }, { value: "dots", label: t("Dots") }, { value: "symbols", label: t("Symbols") }]} />
      </SettingsRow>
    </SettingsGroup>

    <SettingsGroup title={t("Typography")} section="typography">
      <SettingsRow label={t("Interface font size")} description={t("Menus, lists, dialogs and the sidebar. The chat follows it until it has a size of its own; the terminal keeps its own.")}>
        <Stepper label={t("Interface font size")} value={uiFontSize(settings)} text={`${uiFontSize(settings)}px`} min={UI_FONT_MIN} max={UI_FONT_MAX} decreaseLabel={t("Decrease interface font size")} increaseLabel={t("Increase interface font size")} onChange={(size) => update({ uiFontSize: size })} />
      </SettingsRow>
      <InterfaceFontRows />
    </SettingsGroup>
    </>
  );
}

function ChatPage() {
  const { settings, update } = useSettings();
  const t = useT();
  const touch = useMediaQuery("(pointer: coarse)");
  // the same query Composer.tsx hides the New tab button by
  const compactComposer = useMediaQuery("(max-width: 640px), (pointer: coarse)");
  return (
    <>
      <SettingsGroup>
        <SettingsRow label={t("Panes open in")} description={t("Every pane on this device. Switching a pane's lens keeps it there until this changes. Auto: chat for an agent on a touch screen, else the terminal.")} wide>
          <Segmented label={t("Panes open in")} value={settings.defaultView} options={[{ value: "auto", label: t("Auto") }, { value: "chat", label: t("Chat") }, { value: "terminal", label: t("Terminal") }]} onChange={(defaultView) => {
            if (settings.defaultView === defaultView) return;
            // one choice for every pane: what each one remembered gives way to it
            forgetPaneViews();
            update({ defaultView });
          }} />
        </SettingsRow>
        <SettingsRow label={t("Show thinking")} description={t("Include the agent's reasoning blocks")}>
          <Toggle label={t("Show thinking")} checked={settings.showThinking} onChange={(showThinking) => update({ showThinking })} />
        </SettingsRow>
        <SettingsRow label={t("Chat width")} description={t("How wide the conversation and the message box run on a large screen")} wide>
          <Segmented label={t("Chat width")} value={settings.chatWidth} onChange={(chatWidth) => update({ chatWidth })} options={CHAT_WIDTHS.map((chatWidth) => ({ value: chatWidth, label: t(chatWidth === "narrow" ? "Narrow" : chatWidth === "wide" ? "Wide" : chatWidth === "full" ? "Full" : "Default") }))} />
        </SettingsRow>
        <SettingsRow label={t("Chat font size")} description={t("Messages, code, prompt cards and the message box in the chat view")}>
          <Stepper label={t("Chat font size")} value={chatFontSize(settings)} text={`${chatFontSize(settings)}px`} min={CHAT_FONT_MIN} max={CHAT_FONT_MAX} decreaseLabel={t("Decrease chat font size")} increaseLabel={t("Increase chat font size")} onChange={(size) => update({ chatFontSize: size })} />
        </SettingsRow>
        <SettingsRow label={t("Chat font")} description={t("Message text; code stays monospace. Comma-separated, tried in order. A font this device does not have falls back to the default.")} wide>
          <FontFamilyInput value={settings.chatFontFamily} label={t("Chat font")} onCommit={(chatFontFamily) => update({ chatFontFamily })} />
        </SettingsRow>
        <SettingsRow label={t("History page size")} description={t("Prompts per page; older turns load a page at a time as you scroll up. Hermes keeps its own page of messages")} wide>
          <Segmented label={t("History page size")} value={String(settings.historyPrompts)} onChange={(value) => update({ historyPrompts: Number(value) })} options={HISTORY_PROMPTS.map((prompts) => ({ value: String(prompts), label: String(prompts) }))} />
        </SettingsRow>
      </SettingsGroup>

      <SettingsGroup title={t("Composer")} section="composer">
        <SettingsRow label={touch ? t("Return inserts a new line") : t("Enter sends")} description={touch ? t("When on, use Send or hardware Mod+Enter to send.") : t("When off, Mod+Enter sends")}>
          <Toggle label={touch ? t("Return inserts a new line") : t("Enter sends")} checked={touch ? !settings.enterSends : settings.enterSends} onChange={(checked) => update({ enterSends: touch ? !checked : checked })} />
        </SettingsRow>
        <SettingsRow label={t("Send queued messages automatically")} description={t("A message sent while the agent works goes by itself when the turn ends. When off, it waits until you press Send now.")}>
          <Toggle label={t("Send queued messages automatically")} checked={settings.autoSendQueued} onChange={(autoSendQueued) => update({ autoSendQueued })} />
        </SettingsRow>
        {/* the button is drawn in a wide, mouse-driven window only (Composer.tsx), so it is offered only there */}
        {!compactComposer && (
          <SettingsRow label={t("New tab button")} description={t("A button in the message box opens New tab with an agent… on the pane's workspace. The tab menu offers it either way.")}>
            <Toggle label={t("New tab button")} checked={settings.composerNewTabButton} onChange={(composerNewTabButton) => update({ composerNewTabButton })} />
          </SettingsRow>
        )}
        {touch && (
          <SettingsRow label={t("Suggestion chip")} description={t("A chip above the message box puts the prompt Claude Code suggests next into the box. With a keyboard, Tab does it.")}>
            <Toggle label={t("Suggestion chip")} checked={settings.suggestionChip} onChange={(suggestionChip) => update({ suggestionChip })} />
          </SettingsRow>
        )}
      </SettingsGroup>

      <SettingsGroup title={t("Quick replies")} section="quick-replies">
        <SettingsRow label={t("Show above the message box")} description={t("One-tap messages above the message box, on this device. Each is sent as if typed: queued while the agent works, an answer when a question is open.")}>
          <Toggle label={t("Show above the message box")} checked={settings.showQuickReplies} onChange={(showQuickReplies) => update({ showQuickReplies })} />
        </SettingsRow>
        <div className="settings-item">
          <ol className="quick-replies-list">
            {settings.quickReplies.map((reply, index) => (
              <li key={index}>
                <input
                  className="input"
                  value={reply}
                  maxLength={QUICK_REPLY_MAX_CHARS}
                  aria-label={t("Quick reply {number}", { number: index + 1 })}
                  spellCheck={false}
                  autoCapitalize="off"
                  autoCorrect="off"
                  onChange={(event) => update({ quickReplies: settings.quickReplies.map((current, at) => at === index ? event.target.value : current) })}
                />
                <button type="button" className="icon-button" aria-label={t("Remove quick reply {number}", { number: index + 1 })} onClick={() => update({ quickReplies: settings.quickReplies.filter((_, at) => at !== index) })}>
                  <X aria-hidden="true" />
                </button>
              </li>
            ))}
          </ol>
          <div className="settings-actions">
            <button type="button" className="btn" disabled={settings.quickReplies.length >= QUICK_REPLIES_MAX} onClick={() => update({ quickReplies: [...settings.quickReplies, ""] })}><Plus aria-hidden="true" />{t("Add reply")}</button>
            <button type="button" className="btn btn-ghost" onClick={() => update({ quickReplies: [...DEFAULT_SETTINGS.quickReplies] })}>{t("Restore defaults")}</button>
          </div>
        </div>
      </SettingsGroup>

      <SettingsGroup title={t("File viewer")}>
        <SettingsRow label={t("Wrap long lines")}>
          <Toggle label={t("Wrap long lines")} checked={settings.wrapCode} onChange={(wrapCode) => update({ wrapCode })} />
        </SettingsRow>
        <SettingsRow label={t("Markdown width")}>
          {/* literal keys, so the i18n check finds them */}
          <Segmented label={t("Markdown width")} value={settings.markdownWidth} onChange={(markdownWidth) => update({ markdownWidth })} options={MARKDOWN_WIDTHS.map((markdownWidth) => ({ value: markdownWidth, label: markdownWidth === "full" ? t("Full width") : t("Default") }))} />
        </SettingsRow>
        <SettingsRow label={t("Diff layout")} description={t("A phone shows one column either way.")}>
          <Segmented label={t("Diff layout")} value={settings.diffStyle} onChange={(diffStyle) => update({ diffStyle })} options={DIFF_STYLES.map((diffStyle) => ({ value: diffStyle, label: diffStyle === "split" ? t("Split") : t("Unified") }))} />
        </SettingsRow>
        <SettingsRow label={t("Open files")} description={t("On a wide window, text and code can open beside the pane. Media, PDFs and folders always open in a popup, and the viewer's header button moves the file open now.")}>
          <Segmented label={t("Open files")} value={settings.fileOpen} onChange={(fileOpen) => update({ fileOpen })} options={FILE_OPEN_TARGETS.map((fileOpen) => ({ value: fileOpen, label: fileOpen === "panel" ? t("Beside the pane") : t("In a popup") }))} />
        </SettingsRow>
        <SettingsRow label={t("Web links")} description={t("Only a page this PC serves, such as a dev server on localhost, opens beside the pane. Shift-click opens it the other way.")}>
          <Segmented label={t("Web links")} value={settings.webLinks} onChange={(webLinks) => update({ webLinks })} options={WEB_LINK_TARGETS.map((webLinks) => ({ value: webLinks, label: webLinks === "panel" ? t("Beside the pane") : t("In a new tab") }))} />
        </SettingsRow>
        <SettingsRow label={t("Reuse tab for external links")} description={t("External links reuse one browser tab instead of opening a new tab each time.")}>
          <Toggle label={t("Reuse tab for external links")} checked={settings.reuseExternalLinkTab} onChange={(reuseExternalLinkTab) => update({ reuseExternalLinkTab })} />
        </SettingsRow>
      </SettingsGroup>
    </>
  );
}

function TerminalPage({ keyBarButtonRef, onEditKeyBar }: { keyBarButtonRef: RefObject<HTMLButtonElement | null>; onEditKeyBar: () => void }) {
  const { settings, update } = useSettings();
  const t = useT();
  return (
    <SettingsGroup>
      <SettingsRow label={t("Terminal font size")} description={t("Applied to every terminal pane")}>
        <Stepper label={t("Terminal font size")} value={settings.terminalFontSize} text={`${settings.terminalFontSize}px`} min={TERMINAL_FONT_MIN} max={TERMINAL_FONT_MAX} decreaseLabel={t("Decrease terminal font size")} increaseLabel={t("Increase terminal font size")} onChange={(terminalFontSize) => update({ terminalFontSize })} />
      </SettingsRow>
      <SettingsRow label={t("Terminal font")} description={t("Comma-separated, tried in order. A font this device does not have falls back to the default.")} wide>
        <FontFamilyInput value={settings.terminalFontFamily} label={t("Terminal font")} fixedWidthFor="terminal" onCommit={(terminalFontFamily) => update({ terminalFontFamily })} />
      </SettingsRow>
      <SettingsRow label={t("Wheel scroll speed")} description={t("How far one turn of the wheel scrolls the terminal")}>
        <Stepper label={t("Wheel scroll speed")} value={settings.terminalWheelSpeed} text={`${settings.terminalWheelSpeed}×`} min={TERMINAL_WHEEL_SPEED_MIN} max={TERMINAL_WHEEL_SPEED_MAX} decreaseLabel={t("Slower wheel scrolling")} increaseLabel={t("Faster wheel scrolling")} onChange={(terminalWheelSpeed) => update({ terminalWheelSpeed })} />
      </SettingsRow>
      <SettingsRow label={t("Terminal input mode")} htmlFor="terminal-input-mode">
        {/* "auto", the stored default, types straight into the grid on every device: it reads as Direct typing */}
        <SettingsSelect id="terminal-input-mode" value={settings.terminalInputMode === "line" ? "line" : "direct"} onChange={(event) => update({ terminalInputMode: event.target.value as "line" | "direct" })}>
          <option value="direct">{t("Direct typing")}</option><option value="line">{t("Input line")}</option>
        </SettingsSelect>
      </SettingsRow>
      <SettingsRow label={t("Key bar")} description={t("Keys, order and custom combinations for the terminal.")}>
        <button type="button" ref={keyBarButtonRef} className="btn" onClick={onEditKeyBar}>{t("Edit key bar")}</button>
      </SettingsRow>
      <SettingsRow label={t("Clipboard from a pane")} description={t("A program in a pane that copies (vim, tmux, Claude Code) puts its text on this device's clipboard, as a copy you made yourself would. Turn it off if a pane runs output you do not trust: it could replace what you paste next.")}>
        <Toggle label={t("Clipboard from a pane")} checked={settings.paneClipboard} onChange={(paneClipboard) => update({ paneClipboard })} />
      </SettingsRow>
      <SettingsRow label={t("Use alongside herdr's own window")} description={t("Turn this on if herdr is also open in a terminal window, on this PC or another. A second after you switch to another window, or after 10 seconds without typing or clicking in a terminal you type straight into, this tab only watches the pane, so herdr's window keeps the pane at its own size instead of this window's. Type or click in the terminal to type again: what you type goes in once it is back. While it watches, the pane is drawn at herdr's size and may not fill this window.")}>
        <Toggle label={t("Use alongside herdr's own window")} checked={settings.releasePaneAway} onChange={(releasePaneAway) => update({ releasePaneAway })} />
      </SettingsRow>
      <SettingsRow label={t("Follow herdr's focus")} description={t("When herdr moves to another pane, by a click in its window, a herdr command or a script, this device opens that pane too. Only on the PC open here, and only on this device. A PC on Ovis older than 0.4.13 does not report herdr's focus: update it first.")}>
        <Toggle label={t("Follow herdr's focus")} checked={settings.followHerdrFocus} onChange={(followHerdrFocus) => update({ followHerdrFocus })} />
      </SettingsRow>
    </SettingsGroup>
  );
}

function AlertsPage({ onEnableNotifications }: { onEnableNotifications: () => Promise<PushActionResult> }) {
  const { settings, update } = useSettings();
  const t = useT();
  // the Sound switch as last set: the preview waits for the audio, and must not play once it is off
  const alertSoundWanted = useRef(settings.alertSound);
  return (
    <SettingsGroup note={t("For this device. An alert waits a little first, and none comes when the pane changes meanwhile, as when you answer at the PC.")}>
      <PushTestControls onEnable={onEnableNotifications} />
      <SettingsRow label={t("Needs input")} description={t("An agent waits for an answer or a permission")}>
        <Toggle label={t("Needs input")} checked={settings.alertInput} onChange={(alertInput) => update({ alertInput })} />
      </SettingsRow>
      <SettingsRow label={t("Finished")} description={t("Long turns: only work that took a minute or more")} wide>
        <Segmented label={t("Finished")} value={settings.alertDone} onChange={(alertDone) => update({ alertDone })} options={[{ value: "off", label: t("Off") }, { value: "long", label: t("Long turns") }, { value: "always", label: t("Every turn") }]} />
      </SettingsRow>
      <SettingsRow label={t("In the app")} description={t("While the app is open, these drop in from the top of the screen at once. Tap one to open its pane.")}>
        <Toggle label={t("In the app")} checked={settings.alertInApp} onChange={(alertInApp) => update({ alertInApp })} />
      </SettingsRow>
      <SettingsRow label={t("Sound")} description={t("While a tab of the app is open, it chimes for these alerts, also when a Focus or Do Not Disturb silences notifications.")}>
        <Toggle label={t("Sound")} checked={settings.alertSound} onChange={(alertSound) => {
          update({ alertSound });
          alertSoundWanted.current = alertSound;
          // this tap is the gesture the page needs to play audio; the chime is the preview,
          // unless the switch went off again while the audio was getting ready
          if (alertSound) void unlockAlertSound().then((ready) => { if (ready && alertSoundWanted.current) previewAlertSound(); });
        }} />
      </SettingsRow>
    </SettingsGroup>
  );
}

/** A language tag's name in the UI language (`hu-HU` is "Hungarian (Hungary)"), or the tag where the browser cannot name it. */
function languageName(names: Intl.DisplayNames | null, tag: string): string {
  try { return names?.of(tag) ?? tag; } catch { return tag; }
}

function DictationLanguageSelect() {
  const { settings, resolvedLanguage, update } = useSettings();
  const t = useT();
  const locale = useLocale();
  const names = useMemo(() => { try { return new Intl.DisplayNames([locale], { type: "language" }); } catch { return null; } }, [locale]);
  const auto = languageName(names, dictationLocale("auto", settings.language, resolvedLanguage, navigator.languages));
  const choices = useMemo(() => DICTATION_LANGUAGES.map((tag) => ({ tag, name: languageName(names, tag) })).sort((a, b) => a.name.localeCompare(b.name, locale)), [names, locale]);
  return (
    <SettingsSelect id="settings-voice-language" value={settings.voiceLanguage} onChange={(event) => update({ voiceLanguage: event.target.value as DictationLanguage })}>
      <option value="auto">{t("Auto ({language})", { language: auto })}</option>
      {choices.map(({ tag, name }) => <option key={tag} value={tag}>{name}</option>)}
    </SettingsSelect>
  );
}

function VoicePage() {
  const { settings, update } = useSettings();
  const t = useT();
  // the server only says whether it holds a key; the key typed here is never kept past a save
  const [voice, setVoice] = useState<VoiceStatus | null>(null);
  const [voiceKey, setVoiceKey] = useState("");
  const [voiceBusy, setVoiceBusy] = useState(false);
  const [voiceError, setVoiceError] = useState<string | null>(null);
  const [micDenied, setMicDenied] = useState(false);
  useEffect(() => { fetchVoiceStatus().then(setVoice, () => setVoice(null)); }, []);
  /** On asks now, so the first dictation does not stop at the browser's permission prompt */
  const chooseVoiceInput = async (voiceInput: VoiceButton) => {
    update({ voiceInput });
    setMicDenied(false);
    if (voiceInput !== "on" || !window.isSecureContext || !navigator.mediaDevices?.getUserMedia) return;
    try { (await navigator.mediaDevices.getUserMedia({ audio: true })).getTracks().forEach((track) => track.stop()); }
    catch { setMicDenied(true); }
  };
  const changeVoiceKey = async (api_key: string | null) => {
    setVoiceBusy(true);
    try {
      // the save answers the new status itself: no second request that could fail after it
      const saved = await saveVoiceConfig({ api_key });
      setVoiceKey("");
      setVoiceError(null);
      setVoice(saved);
      window.dispatchEvent(new Event(VOICE_CONFIG_EVENT));
    } catch (e) { setVoiceError(e instanceof Error ? e.message : String(e)); }
    finally { setVoiceBusy(false); }
  };
  const micProblem = settings.voiceInput === "off" ? null : !window.isSecureContext ? t("Voice input needs HTTPS") : micDenied ? t("Microphone permission was denied") : null;
  return (
    <>
      <SettingsGroup>
        <SettingsRow label={t("Microphone button")} description={<>{t("Auto: in the chat on a desktop, where dictation can work. On: on a phone and in the terminal input line too.")}{micProblem !== null && <span className="voice-error">{micProblem}</span>}</>} wide>
          <Segmented label={t("Microphone button")} value={settings.voiceInput} onChange={(voiceInput) => void chooseVoiceInput(voiceInput)} options={VOICE_BUTTONS.map((voiceInput) => ({ value: voiceInput, label: t(voiceInput === "auto" ? "Auto" : voiceInput === "on" ? "On" : "Off") }))} />
        </SettingsRow>
        {settings.voiceInput !== "off" && (
          <SettingsRow label={t("Dictation language")} description={t("Auto listens for the app's language, or for the browser's when the app is not translated into it")} htmlFor="settings-voice-language">
            <DictationLanguageSelect />
          </SettingsRow>
        )}
      </SettingsGroup>

      {settings.voiceInput !== "off" && (
        <SettingsGroup title={t("Tidy dictated text")} section="tidy-dictation">
          <SettingsRow label={t("In chat")} description={t("Drops fillers and fixes spacing; code and paths stay as spoken")}>
            <Toggle label={t("Tidy dictated text in chat")} checked={settings.voicePolishChat} onChange={(voicePolishChat) => update({ voicePolishChat })} />
          </SettingsRow>
          <SettingsRow label={t("In the terminal")} description={t("Off keeps a command exactly as transcribed")}>
            <Toggle label={t("Tidy dictated text in the terminal")} checked={settings.voicePolishTerminal} onChange={(voicePolishTerminal) => update({ voicePolishTerminal })} />
          </SettingsRow>
        </SettingsGroup>
      )}

      <SettingsGroup title={t("OpenAI API key")} section="openai-key">
        <div className="settings-item">
          {voice && (
            <p className="settings-label voice-status">
              {voice.configured ? t(voice.source === "env" ? "OpenAI key set by OVIS_OPENAI_API_KEY" : "OpenAI key saved on this PC") : t("No OpenAI key: the browser's speech recognition is used")}
            </p>
          )}
          {voice && voice.source !== "env" && (
            <form className="voice-key" onSubmit={(event) => { event.preventDefault(); if (voiceKey.trim()) void changeVoiceKey(voiceKey.trim()); }}>
              <input
                className="input voice-key-input"
                type="password"
                value={voiceKey}
                placeholder="sk-..."
                aria-label={t("OpenAI API key")}
                autoComplete="off"
                spellCheck={false}
                autoCapitalize="off"
                autoCorrect="off"
                onChange={(event) => setVoiceKey(event.target.value)}
              />
              <button type="submit" className="btn voice-key-save" disabled={voiceBusy || !voiceKey.trim()}>{t("Save key")}</button>
              <button type="button" className="btn btn-ghost voice-key-remove" disabled={voiceBusy || !voice.configured} onClick={() => void changeVoiceKey(null)}>{t("Remove key")}</button>
            </form>
          )}
          {voiceError && <p className="settings-hint voice-error" role="alert">{voiceError}</p>}
          <p className="settings-hint voice-privacy">
            {voice && !voice.configured
              ? t("Without a key the browser recognizes the speech: Chrome and Edge send the audio to Google or Microsoft. Nothing is recorded until you press the mic.")
              : t("Audio is sent to OpenAI with your key. Nothing is recorded until you press the mic.")}
          </p>
        </div>
      </SettingsGroup>
    </>
  );
}

/**
 * herdr's own integrations (`integration.list`), read only: installing one writes into an agent's
 * hooks or settings, which this app leaves to the user, so a row shows the command to run instead.
 */
function IntegrationsPage() {
  return (
    <>
      <LaunchModesGroup />
      <IntegrationsList />
    </>
  );
}

function claudeModeName(mode: ClaudeLaunchMode, t: ReturnType<typeof useT>): string {
  return mode === "acceptEdits" ? t("Accept edits") : mode === "auto" ? t("Auto") : mode === "plan" ? t("Plan")
    : mode === "dontAsk" ? t("Don't ask") : mode === "bypassPermissions" ? t("Bypass permissions") : t("Agent default");
}
function codexModeName(mode: CodexLaunchMode, t: ReturnType<typeof useT>): string {
  return mode === "readOnly" ? t("Read only") : mode === "auto" ? t("Auto") : mode === "fullAccess" ? t("Full access") : t("Agent default");
}

/** The mode the new workspace, tab and worktree dialogs start Claude Code and Codex in (lib/agentLaunchMode.ts). */
function LaunchModesGroup() {
  const { settings, update } = useSettings();
  const t = useT();
  return (
    <SettingsGroup title={t("New agents")} section="launch-modes" note={t("Applies to agents started from New workspace, New tab and New worktree. Agent default adds no flag, so the agent's own configuration decides.")}>
      <SettingsRow label="Claude Code" description={t("Permission mode")} htmlFor="settings-claude-launch-mode">
        <SettingsSelect id="settings-claude-launch-mode" value={settings.claudeLaunchMode} onChange={(event) => update({ claudeLaunchMode: event.target.value as ClaudeLaunchMode })}>
          {CLAUDE_LAUNCH_MODES.map((mode) => <option key={mode} value={mode}>{claudeModeName(mode, t)}</option>)}
        </SettingsSelect>
      </SettingsRow>
      <SettingsRow label="Codex" description={t("Sandbox and approvals")} htmlFor="settings-codex-launch-mode">
        <SettingsSelect id="settings-codex-launch-mode" value={settings.codexLaunchMode} onChange={(event) => update({ codexLaunchMode: event.target.value as CodexLaunchMode })}>
          {CODEX_LAUNCH_MODES.map((mode) => <option key={mode} value={mode}>{codexModeName(mode, t)}</option>)}
        </SettingsSelect>
      </SettingsRow>
    </SettingsGroup>
  );
}

function IntegrationsList() {
  const t = useT();
  const api = useMachineApi();
  const machineId = useMachineId();
  const [result, setResult] = useState<IntegrationsResult | null>(null);
  useEffect(() => {
    let live = true;
    void loadIntegrations(api.fetchIntegrations).then((outcome) => { if (live) setResult({ machineId, outcome }); });
    return () => { live = false; };
  }, [api, machineId]);
  const outcome = outcomeFor(result, machineId);
  const note = t("herdr's integrations let it resume each agent's session after a restart. This page only reads them: run a command in a terminal on the PC herdr runs on, then reopen this page.");
  if (outcome === null) return <SettingsGroup note={note}><p className="settings-item settings-hint" role="status">{t("Loading…")}</p></SettingsGroup>;
  if (outcome.kind === "unsupported") return <SettingsGroup><p className="settings-item settings-hint" role="status">{t("This PC's bridge does not offer agent integrations yet. It will after its next runtime update.")}</p></SettingsGroup>;
  if (outcome.kind === "error") return <SettingsGroup note={note}><p className="settings-item settings-hint" role="alert">{outcome.message}</p></SettingsGroup>;
  const { integrations } = outcome;
  // agents on the PC's PATH first, in herdr's order: the rest can wait until one is installed
  const groups = [
    { title: undefined, rows: integrations.filter((integration) => integration.available) },
    { title: t("Not found on this PC"), rows: integrations.filter((integration) => !integration.available) },
  ].filter((group) => group.rows.length > 0);
  return (
    <>
      {groups.map((group, index) => (
        <SettingsGroup key={group.title ?? "found"} title={group.title} note={index === 0 ? note : undefined}>
          {group.rows.map((integration) => <IntegrationRow key={integration.target} integration={integration} />)}
        </SettingsGroup>
      ))}
    </>
  );
}

function IntegrationRow({ integration }: { integration: AgentIntegration }) {
  const t = useT();
  const commandRef = useRef<HTMLElement>(null);
  const [copied, setCopied] = useState(false);
  // the latest Copy owns the label: an earlier press's timer must not clear it early
  const copiedTimer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(copiedTimer.current), []);
  const name = integration.label;
  if (integration.state === "current") {
    return (
      <SettingsRow label={name} description={t("Installed")}>
        <Check className="settings-integration-check" aria-hidden="true" />
      </SettingsRow>
    );
  }
  // the label is the name `herdr integration install` takes (antigravity_cli is antigravity-cli)
  const command = `herdr integration install ${name}`;
  const copy = async (): Promise<void> => {
    if (!(await copyText(command, commandRef.current))) return;
    setCopied(true);
    window.clearTimeout(copiedTimer.current);
    copiedTimer.current = window.setTimeout(() => setCopied(false), 1600);
  };
  const state = integration.state === "outdated" ? t("Installed, but older than this herdr: run this to update it") : t("Not installed");
  return (
    <SettingsRow label={name} description={<>{state}<code ref={commandRef} className="settings-integration-command">{command}</code></>}>
      <button type="button" className="btn" aria-label={t("Copy the command for {name}", { name })} onClick={() => void copy()}>{t(copied ? "Copied" : "Copy")}</button>
    </SettingsRow>
  );
}

function ShortcutsPage() {
  const { settings, update } = useSettings();
  const t = useT();
  const platformIsMac = isMacPlatform();
  const [query, setQuery] = useState("");
  const [recording, setRecording] = useState<{ id: ShortcutId; problem: string | null } | null>(null);
  // a recorded chord the terminal or the browser also uses waits here for Save anyway or Cancel
  const [pending, setPending] = useState<{ id: ShortcutId; value: string; risk: "terminal" | "browser" } | null>(null);
  // Save anyway and Cancel leave with the prompt: focus goes back to the row's Record button
  const recordButtons = useRef(new Map<ShortcutId, HTMLButtonElement>());
  const settlePending = (id: ShortcutId): void => {
    setPending(null);
    recordButtons.current.get(id)?.focus();
  };
  const recordingId = recording?.id ?? null;
  const riskText = (risk: "terminal" | "browser", keys: string): string => risk === "terminal"
    ? t("{keys} is a terminal key: shells, editors and agents use it. Once saved, it no longer reaches the pane.", { keys })
    : t("Your browser or operating system may intercept {keys}.", { keys });
  // while a row records, the chord pressed is read here and the app's own dispatcher stands down
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
      if (result.kind === "exact" && result.risk !== null) return setPending({ id: recordingId, value, risk: result.risk });
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
      <input
        type="search"
        className="input settings-shortcut-search"
        value={query}
        placeholder={t("Search shortcuts")}
        aria-label={t("Search shortcuts")}
        autoComplete="off"
        spellCheck={false}
        onChange={(event) => setQuery(event.target.value)}
      />
      {visible.length === 0 && <p className="settings-hint" role="status">{t("No shortcuts match.")}</p>}
      <SettingsGroup className="settings-shortcuts" section="shortcuts" note={<>{t("Bindings apply to this browser and device. Mod+Shift chords leave the terminal its keys; Record also takes other chords with Ctrl, Alt or (on a Mac) ⌘, exactly as pressed.")} {t("Text selection in focused fields stays native; Tab/list keys are UI-local, not global shortcuts.")} {t("The mobile key bar sends terminal keys, not app actions.")}</>}>
        {visible.map((shortcut) => {
          const displayedKeys = shortcutDisplayKeys(shortcut.id, settings.shortcutOverrides);
          const selectedKey = displayedKeys[displayedKeys.length - 1];
          const override = Object.hasOwn(settings.shortcutOverrides, shortcut.id) ? settings.shortcutOverrides[shortcut.id] : null;
          const exact = override ? parseExactChord(override) : null;
          const selectedRisk = exact ? exactChordRisk(exact, platformIsMac) : selectedKey !== undefined && isReservedShortcutKey(selectedKey, platformIsMac) ? "browser" : null;
          const confirming = pending?.id === shortcut.id ? pending : null;
          const defaultKeys = shortcutDisplayKeys(shortcut.id, {});
          const defaultKey = defaultKeys[defaultKeys.length - 1];
          const defaultReserved = defaultKey !== undefined && isReservedShortcutKey(defaultKey, platformIsMac);
          // a binding without a default key is off by default: its Default row reads Off, with no second Off
          const unbound = defaultKeys.length === 0;
          const rowText = recording?.id === shortcut.id ? (recording.problem ?? t("Press the new shortcut, or Escape to cancel.")) : confirming ? riskText(confirming.risk, compactKeys(bindingDisplayKeys(confirming.value))) : selectedRisk ? riskText(selectedRisk, compactKeys(displayedKeys)) : undefined;
          return (
            <SettingsRow key={shortcut.id} label={t(shortcut.label)} wide={shortcut.id !== "voice"} description={rowText === undefined ? undefined : <span role="status">{rowText}</span>}>
              {shortcut.id === "voice" ? <span className="settings-keys">{formatKeys(shortcut.keys).map((key) => <kbd className="kbd" key={key}>{key}</kbd>)}</span> : (
                <span className="settings-shortcut-control">
                <button type="button" className="btn settings-shortcut-record" ref={(button) => { if (button) recordButtons.current.set(shortcut.id, button); else recordButtons.current.delete(shortcut.id); }} aria-pressed={recording?.id === shortcut.id} aria-label={t("Record shortcut for {name}", { name: t(shortcut.label) })} onClick={() => { setPending(null); setRecording(recording?.id === shortcut.id ? null : { id: shortcut.id, problem: null }); }}>{recording?.id === shortcut.id ? t("Press keys…") : t("Record")}</button>
                {confirming ? <>
                  <button type="button" className="btn settings-shortcut-confirm" onClick={() => {
                    settlePending(confirming.id);
                    update({ shortcutOverrides: { ...settings.shortcutOverrides, [confirming.id]: confirming.value } });
                  }}>{t("Save anyway")}</button>
                  <button type="button" className="btn" onClick={() => settlePending(confirming.id)}>{t("Cancel")}</button>
                </> : <SettingsSelect className="settings-shortcut-select" aria-label={t(shortcut.label)} value={Object.hasOwn(settings.shortcutOverrides, shortcut.id) ? settings.shortcutOverrides[shortcut.id] ?? (unbound ? "default" : "off") : "default"} onChange={(event) => {
                  const next = { ...settings.shortcutOverrides };
                  if (event.target.value === "default") delete next[shortcut.id];
                  else next[shortcut.id] = event.target.value === "off" ? null : event.target.value;
                  update({ shortcutOverrides: next });
                }}>
                  <option value="default" title={t("Default")} disabled={shortcutConflict(shortcut.id, shortcutKeys(shortcut.id, {}), settings.shortcutOverrides)}>{unbound ? t("Off") : compactKeys(defaultKeys)}{defaultReserved ? ` — ${t("Reserved")}` : ""}</option>
                  {!unbound && <option value="off" title={t("Send keys to terminal")}>{t("Off")}</option>}
                  {/* a recorded chord the list below does not offer (exact modifiers, Home, End, punctuation) is listed as itself */}
                  {override && (exact || !MENU_SHORTCUT_KEYS.includes(override)) && <option value={override}>{compactKeys(displayedKeys)}</option>}
                  {MENU_SHORTCUT_KEYS.map((key) => {
                    const conflict = shortcutConflict(shortcut.id, [key], settings.shortcutOverrides);
                    const reserved = isReservedShortcutKey(key, platformIsMac);
                    return <option key={key} value={key} disabled={conflict}>{compactKeys(["Mod", "Shift", key])}{reserved ? ` — ${t("Reserved")}` : ""}{conflict ? " — " + t("Already assigned") : ""}</option>;
                  })}
                </SettingsSelect>}
                </span>
              )}
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
    </>
  );
}

/**
 * Read-only: each fact on its own line and none of them a verdict. Public reachability stays
 * unknown unless this request proved it, since a proxy or router in front can expose any bind.
 */
function AccessFacts({ facts }: { facts: SecurityFacts }) {
  const t = useT();
  const fact = (label: string, value: string, description: string) => (
    <SettingsRow key={label} label={label} description={description}><span className="settings-fact">{value}</span></SettingsRow>
  );
  if (facts.state !== "known") {
    const text = facts.state === "loading" ? t("Loading…")
      : facts.state === "error" ? t("The server did not answer, so these facts are unavailable. Nothing from an earlier check is shown. This page asks again by itself; if this message stays, check that the server is running and that this device can reach it.")
      : t("This server does not report these facts. Updating it adds them.");
    return (
      <SettingsGroup title={t("Access")} section="access">
        <p className="settings-item settings-description" role="status">{text}</p>
      </SettingsGroup>
    );
  }
  const { summary } = facts;
  const gate = summary.pairing_gate;
  const bind = summary.bind_scope;
  const ingress = summary.observed_ingress;
  return (
    <SettingsGroup title={t("Access")} section="access" note={t("What this server reports about how it is reached. Each line is one fact, not a safety rating.")}>
      {fact(t("Access token"), summary.token_configured ? t("Set") : t("Not set"), t("Whether the server has a token configured. Its value is never shown."))}
      {fact(t("Pairing gate"), gate === "open" ? t("Not yet closed") : gate === "closed" ? t("Closed") : t("Unavailable"),
        gate === "open" ? t("No device has been paired yet, so no pairing code is asked for.")
          : gate === "closed" ? t("A new browser needs a pairing code or the token.")
          : t("The device list cannot be read, so no new device can pair. This PC, the token and Tailscale sign-in still work."))}
      {fact(t("Listens on"), bind === "loopback" ? t("Loopback") : bind === "tailnet" ? t("Tailscale address") : t("Other address"),
        bind === "other" ? t("A network address, every interface or a host name: other devices on that network may reach it.")
          : t("The address the server listens on. A proxy on this PC can still forward other traffic to it."))}
      {fact(t("This connection"), ingress === "direct" ? t("No proxy seen") : ingress === "proxy" ? t("Through a proxy") : ingress === "tailscale" ? t("Through Tailscale") : ingress === "funnel" ? t("Through Tailscale Funnel") : t("Unknown"),
        ingress === "direct" ? t("No proxy said it forwarded this browser's request. One that adds nothing, such as an SSH tunnel, looks the same.")
          : t("How this browser's request arrived, not how every device reaches the server."))}
      {fact(t("Public internet"), summary.public_exposure === "observed" ? t("Reachable") : t("Unknown"),
        summary.public_exposure === "observed" ? t("This request came through Tailscale Funnel, which is open to the public internet.")
          : t("The server cannot see whether a proxy, tunnel or router makes it reachable from the internet."))}
    </SettingsGroup>
  );
}

function DevicesPage({ auth, security, onSignOut, onRevokedAll }: { auth: HealthAuth | null; security: SecurityFacts; onSignOut: (() => Promise<void>) | null; onRevokedAll: () => void }) {
  const { settings, update } = useSettings();
  const t = useT();
  const installPrompt = useInstallPrompt();
  // the iOS app (app/) holds this page: its way back to the app's list of PCs
  const nativeApp = inNativeApp();
  // the server says what Tailscale on its PC already serves
  const [access, setAccess] = useState<RemoteAccess | null | undefined>(undefined);
  const loadAccess = useCallback(() => {
    setAccess(undefined);
    fetchRemoteAccess().then(setAccess, () => setAccess(null));
  }, []);
  useEffect(() => { loadAccess(); }, [loadAccess]);
  const plan = phonePlan({ protocol: window.location.protocol, hostname: window.location.hostname, origin: window.location.origin, secure: window.isSecureContext }, access ?? null);
  // where a phone can open this app now, for the pairing QR code: the served address, else this one when it is not loopback
  const pairUrl = plan.kind === "here" || plan.kind === "served" ? plan.url : isLoopbackHost(window.location.hostname) ? null : window.location.origin;
  const [confirmSignOut, setConfirmSignOut] = useState(false);
  // what keeps the switch from working here, only while it does (lib/wakeLock.ts asks for the same two)
  const wakeLockProblem = !window.isSecureContext ? t("Needs HTTPS or localhost.") : !("wakeLock" in navigator) ? t("This browser can't keep the screen on.") : null;
  return (
    <>
      <SettingsGroup title={t("Phone")} section="phone">
        {nativeApp && (
          <SettingsRow label={t("Change PC")} description={window.location.protocol === "capacitor:" ? t("This is the demo. Go back to the app's list of PCs to open yours.") : t("This app shows {address}. Go back to its list of PCs to open another.", { address: window.location.host })}>
            <button type="button" className="btn" onClick={() => void changePc()}>{t("Change PC")}</button>
          </SettingsRow>
        )}
        <div className="settings-item"><PhonePanel plan={plan} loading={access === undefined} onRefresh={loadAccess} /></div>
        <SettingsRow label={t("Keep screen on")} description={<>{t("While a terminal or chat pane is open.")}{wakeLockProblem !== null && <span className="settings-condition">{wakeLockProblem}</span>}</>}>
          <Toggle label={t("Keep screen on")} checked={settings.keepScreenOn} onChange={(keepScreenOn) => update({ keepScreenOn })} />
        </SettingsRow>
        <SettingsRow label={t("Install")} description={installPrompt.installed ? t("Installed") : installPrompt.canInstall ? undefined : installPrompt.help}>
          {!installPrompt.installed && installPrompt.canInstall && <button type="button" className="btn btn-primary" onClick={() => void installPrompt.install()}>{t("Install app")}</button>}
        </SettingsRow>
      </SettingsGroup>

      <PortalPanel readOnly={auth?.role === "watch"} />

      <SettingsGroup title={t("Devices")} section="devices">
        <div className="settings-item"><DevicesPanel pairUrl={pairUrl} auth={auth} onRevokedAll={onRevokedAll} /></div>
        {onSignOut && (
          <SettingsRow label={t("Sign out")} description={t("Forget this browser's sign-in. Getting back in takes the access token or a pairing code.")}>
            <button type="button" className="btn" onClick={() => setConfirmSignOut(true)}>{t("Sign out")}</button>
          </SettingsRow>
        )}
        {onSignOut && confirmSignOut && (
          <ConfirmDialog title={t("Sign out of this browser?")}
            body={t("Getting back in takes the access token, or a pairing code from the PC: Settings → Phone & devices there, or the pair command in its terminal.")}
            confirmLabel={t("Sign out")} onClose={() => setConfirmSignOut(false)} onConfirm={onSignOut} />
        )}
      </SettingsGroup>

      <AccessFacts facts={security} />
    </>
  );
}

/**
 * Which PCs this device shows in its sidebar, Agents list and command palette, the Host first. The
 * choice stays in this browser; the last PC shown cannot be hidden (lib/hiddenMachines.ts).
 */
function SidebarPcsGroup({ machines }: { machines: readonly Machine[] }) {
  const t = useT();
  const hidden = useHiddenMachines();
  if (machines.length < 2) return null;
  const listed = [...machines].sort((a, b) => Number(b.kind === "local") - Number(a.kind === "local"));
  return (
    <SettingsGroup title={t("Show in sidebar")} section="sidebar-pcs" note={t("Only on this device. A hidden PC stays connected, and a link or an alert still opens its panes. One PC is always shown.")}>
      {listed.map((machine) => {
        const shown = isMachineShown(machines, hidden, machine.id);
        return (
          <SettingsRow key={machine.id} label={machine.name} description={machine.kind === "local" ? t("The Host: the computer this app runs on") : undefined}>
            <Toggle label={t("Show {name} in sidebar", { name: machine.name })} checked={shown} disabled={shown && !canHideMachine(machines, hidden, machine.id)} onChange={(show) => setHiddenMachines(withMachineHidden(machines, hidden, machine.id, !show))} />
          </SettingsRow>
        );
      })}
    </SettingsGroup>
  );
}

/** a set-aside copy of machines.json (the PCs added in this app), not of herdr-profile-state.json */
const heldAddedPcs = (name: string): boolean => name.startsWith("machines.json.");

function RemotePcsPage({ actions, machines, pcSettings, pcSettingsError, onPcSettings }: { actions: AppActions; machines: readonly Machine[]; pcSettings: MachineSettings | null; pcSettingsError: string | null; onPcSettings: (patch: Partial<MachineSettings>) => void }) {
  const t = useT();
  return (
    <>
    <SettingsGroup>
      <SettingsRow label={t("Add PC")} description={t("Connect another PC over an SSH alias or user@host. Its workspaces join the sidebar.")}>
        <button type="button" className="btn" onClick={actions.openAddPc}><Monitor aria-hidden="true" />{t("Add PC")}</button>
      </SettingsRow>
      {/* the switch is the server's and waits for its answer; Add PC never does */}
      {pcSettings && (
        <SettingsRow label={t("Update PC bridges automatically")} description={t("When an app update needs a newer bridge, PCs that connect with their saved key are updated in the background. PCs that need a password ask first.")}>
          <Toggle label={t("Update PC bridges automatically")} checked={pcSettings.auto_update_bridges} onChange={(auto_update_bridges) => onPcSettings({ auto_update_bridges })} />
        </SettingsRow>
      )}
      {/* a crash can leave the saved PCs unreadable: the server set the file aside and started without them.
          machines.json held the PCs added here; herdr-profile-state.json only the permission to connect to herdr's own */}
      {pcSettings?.set_aside?.some(heldAddedPcs) && <p className="settings-item settings-hint">
        {t("Saved PC data was damaged and could not be read when the app started. It was set aside as {files}; add any missing PC again.", { files: pcSettings.set_aside.filter(heldAddedPcs).join(", ") })}
      </p>}
      {pcSettings?.set_aside?.some((name) => !heldAddedPcs(name)) && <p className="settings-item settings-hint">
        {t("The permission to connect to the PCs saved in herdr was damaged and could not be read when the app started. It was set aside as {files}; choose Connect on those PCs again.", { files: pcSettings.set_aside.filter((name) => !heldAddedPcs(name)).join(", ") })}
      </p>}
      {pcSettingsError && <p className="settings-item settings-hint" role="alert">{pcSettingsError}</p>}
    </SettingsGroup>
    <SidebarPcsGroup machines={machines} />
    </>
  );
}

/**
 * The herdr plugins of the PC on screen and what each can do, to read only: installing, enabling
 * and removing a plugin stay with herdr. Nothing is drawn where there is none to list.
 */
function PluginsGroup() {
  const t = useT();
  const api = useMachineApi();
  const [plugins, setPlugins] = useState<PluginActions[]>([]);
  useEffect(() => {
    let current = true;
    void api.fetchPluginActions().then((list) => { if (current) setPlugins(list); }, () => { if (current) setPlugins([]); });
    return () => { current = false; };
  }, [api]);
  if (plugins.length === 0) return null;
  return (
    <SettingsGroup title={t("herdr plugins")} note={t("The command palette and its plugin actions are not available in the phone touch UI. Use a wider screen or a keyboard's command palette shortcut.")} className="settings-plugins">
      {plugins.map((plugin) => (
        <SettingsRow key={plugin.plugin_id} label={`${plugin.name} ${plugin.version}`} description={plugin.actions.length > 0 ? plugin.actions.map((action) => action.title).join(" · ") : t("No actions")}>
          <span className="settings-hint">{plugin.enabled ? t("Enabled") : t("Disabled")}</span>
        </SettingsRow>
      ))}
    </SettingsGroup>
  );
}

function AboutPage({ updates, herdrVersion, bridgesFollow }: { updates: UpdatesModel; herdrVersion: string | null; bridgesFollow: boolean }) {
  const t = useT();
  return (
    <>
      <UpdateControls updates={updates} bridgesFollow={bridgesFollow} />
      <HerdrUpdateControls enabled herdrVersion={herdrVersion} />
      <PluginsGroup />
      <TelemetryControls />
      <SettingsGroup title={t("About")} className="settings-about" section="about">
        <div className="settings-row">
          <div className="settings-row-text">
            <span className="settings-label">Ovis</span>
            <a className="settings-link" href="https://ovis.sh/" target="_blank" rel="noreferrer">ovis.sh</a>
          </div>
          <a className="btn" href="https://github.com/devswha/ovis" target="_blank" rel="noreferrer"><Star aria-hidden="true" />{t("Star on GitHub")}</a>
        </div>
      </SettingsGroup>
    </>
  );
}

export function SettingsDialog(props: SettingsDialogProps) {
  // mounted per opening: every opening starts on the list, with nothing left from the last one
  // a page that cannot be drawn closes to the app instead of blanking it; the next opening tries again
  return props.open ? <RenderBoundary resetKey={null} fallback={() => <SettingsCrash onClose={props.onClose} overPreview={props.overPreview ?? false} />}>
    <CrashProbe region="settings" />
    <OpenSettingsDialog {...props} />
  </RenderBoundary> : null;
}

/**
 * Still a modal: Escape, the swipe down on a phone, the system Back button and the kept focus
 * close it as they close Settings, and it sits over a file preview as Settings does.
 */
function SettingsCrash({ onClose, overPreview }: { onClose: () => void; overPreview: boolean }) {
  const t = useT();
  // one entry of the history, whatever the crashed dialog had recorded: Back takes it off and the
  // app closes Settings (lib/settingsHistory.ts). Not settingsLevels: a wide dialog's list is none
  useEffect(() => { recordSettings([{ page: null, keyBar: false }]); }, []);
  const closeRef = useRef<HTMLButtonElement>(null);
  const surface = useFocusTrap<HTMLDivElement>(true, { initialFocus: closeRef });
  useSheetSwipe(surface, onClose);
  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key !== "Escape" || event.isComposing || event.keyCode === 229) return;
      event.preventDefault();
      onClose();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [onClose]);
  return (
    <div className={overPreview ? "modal-scrim settings-over-preview" : "modal-scrim"} onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div ref={surface} className="modal" role="dialog" aria-modal="true" aria-label={t("Settings")} tabIndex={-1}>
        <RegionCrash message={t("Settings can't be shown.")} retry={onClose} retryLabel={t("Close")} buttonRef={closeRef} />
      </div>
    </div>
  );
}

/**
 * A change the server refused to save, on whichever page is open: the plain sentence (lib/userError.ts),
 * the server's own words behind Details, and where the change is now with the Retry that sends it.
 * It stays until a save lands; the change is sent again every few seconds meanwhile, and after three
 * failures on Retry, a reconnect or once a longer wait ends (lib/preferencesSync.ts). Only this page
 * holds the change until then: a reload takes the server's values again.
 */
function SaveFailure({ error, paused, retrying, onRetry }: { error: UserError; paused: boolean; retrying: boolean; onRetry: () => void }) {
  const t = useT();
  return <div className="settings-save-error" role="alert" data-paused={paused || undefined}>
    {error.detail === null ? <p>{error.message}</p> : <details className="settings-details">
      <summary>{error.message}<span className="settings-details-toggle">{t("Details")}</span></summary>
      <code>{error.detail}</code>
    </details>}
    <div className="settings-save-local">
      <p>{retrying ? t("Sending the change to the server…") : t("Not saved on the server yet; reloading or closing this page can undo the change.")}</p>
      <button type="button" className="btn" disabled={retrying} aria-busy={retrying} onClick={onRetry}>{t("Retry")}</button>
    </div>
  </div>;
}

function OpenSettingsDialog({ section = null, linkPage = null, linkSection = null, onPage, onClose, onUsageLogin, actions, updates, auth, herdrVersion, security, onEnableNotifications, saveError, savePaused, saveRetrying, onRetrySave, overPreview = false, machines = [] }: SettingsDialogProps) {
  const t = useT();
  const narrow = useNarrow();
  // opened by Forward, the dialog shows what that entry of the history showed
  const [restored] = useState(() => shownBy(settingsEntry(window.history.state)));
  // a phone opens on the list of pages; a wider dialog shows the list beside the first page. A
  // button that points at Updates opens on About whatever an entry still landing would restore
  const linked = PAGES.find((candidate) => candidate.id === linkPage)?.id ?? null;
  // a page the command palette named opens first, on the group it named; the request is read, not
  // taken, so a remount in development finds it again
  const [asked] = useState(requestedSettingsPage);
  useEffect(() => requestSettingsPage(null), []);
  const [chosen, setChosen] = useState<SettingsPage | null>(section === "updates" ? "about" : asked?.page ?? (restored ? restored.page : linked));
  const page = chosen ?? (narrow ? null : PAGES[0]!.id);
  const [keyBarOpen, setKeyBarOpen] = useState(section === "updates" ? false : restored?.keyBar ?? false);
  // every step in is an entry of the history, so the system Back button takes one step out
  // (lib/settingsHistory.ts); the Back control, the X and Escape take the same entries off
  useEffect(() => { recordSettings(settingsLevels(narrow, page, keyBarOpen)); }, [narrow, page, keyBarOpen]);
  useEffect(() => { onPage?.(page); }, [onPage, page]);
  useEffect(() => onSettingsHistory((entry, own) => {
    const view = own ? null : shownBy(entry);
    if (view === null) return;
    setChosen(view.page);
    setKeyBarOpen(view.keyBar);
  }), []);
  const keyBarButtonRef = useRef<HTMLButtonElement>(null);
  const backRef = useRef<HTMLButtonElement>(null);
  const tabsRef = useRef<HTMLDivElement>(null);
  const settingsBodyRef = useRef<HTMLDivElement>(null);
  const settingsScrollRef = useRef(0);
  // Tab stays inside the dialog, and the focus returns to whatever opened it
  const surface = useFocusTrap<HTMLElement>(true, { initialFocus: backRef });
  useSheetSwipe(surface, onClose);
  const shown = useRef<{ page: SettingsPage | null; keyBar: boolean } | null>(null);
  // the group a landing named, followed into view until the reader moves the page
  const following = useRef<{ group: HTMLElement; page: SettingsPage | null } | null>(null);
  const label = (id: SettingsPage): string => t(id === "appearance" ? "Appearance" : id === "chat" ? "Chat" : id === "terminal" ? "Terminal" : id === "alerts" ? "Alerts" : id === "voice" ? "Voice input"
    : id === "usage" ? "Subscription usage" : id === "shortcuts" ? "Shortcuts" : id === "devices" ? "Phone & devices" : id === "remote" ? "Remote PCs" : id === "integrations" ? "Agent integrations" : "About");
  const openPage = (id: SettingsPage): void => { setKeyBarOpen(false); setChosen(id); };
  const openKeyBar = (): void => {
    settingsScrollRef.current = settingsBodyRef.current?.scrollTop ?? 0;
    setKeyBarOpen(true);
  };
  const goBack = (): void => {
    if (keyBarOpen) setKeyBarOpen(false);
    else setChosen(null);
  };
  const tab = (id: SettingsPage | null): HTMLElement | null => tabsRef.current?.querySelector<HTMLElement>(id === null ? '[role="tab"]' : `[data-settings-page="${id}"]`) ?? null;
  useLayoutEffect(() => {
    const before = shown.current;
    shown.current = { page, keyBar: keyBarOpen };
    if (keyBarOpen) backRef.current?.focus();
    else if (before?.keyBar && before.page === page) {
      if (settingsBodyRef.current) settingsBodyRef.current.scrollTop = settingsScrollRef.current;
      keyBarButtonRef.current?.focus({ preventScroll: true });
    } else if (before === null) {
      // a button that points at Updates opens on it, and the focus goes there too; so does a link
      // to a group, and a group the palette named
      const named = section === "updates" ? "updates" : asked?.section ?? (linked && linkSection ? linkSection : null);
      const pointed = named ? settingsBodyRef.current?.querySelector<HTMLElement>(`[data-section="${CSS.escape(named)}"]`) : null;
      if (pointed) {
        pointed.focus({ preventScroll: true });
        pointed.scrollIntoView();
        following.current = { group: pointed, page };
      } else tab(page)?.focus();
    } else if (before.page !== page && narrow) {
      // a phone shows one of the two: the focus follows into the page, and back onto its row
      if (page !== null) backRef.current?.focus();
      else tab(before.page)?.focus();
    }
    // a group filled in after it opens (the OpenAI key's form waits for the server's answer) grows
    // past the fold: it is brought back into view until the reader moves the page or leaves it.
    // The subscription is made again whenever this runs, so development's replay of the effect
    // keeps following; the reader's move or another page ends it for good
    const follow = following.current;
    if (follow === null || follow.page !== page || keyBarOpen) { following.current = null; return; }
    const body = settingsBodyRef.current;
    const observer = new ResizeObserver(() => follow.group.scrollIntoView());
    const moves = ["wheel", "touchstart", "pointerdown", "keydown"] as const;
    const unsubscribe = (): void => {
      observer.disconnect();
      for (const move of moves) body?.removeEventListener(move, stop);
    };
    const stop = (): void => { following.current = null; unsubscribe(); };
    observer.observe(follow.group);
    for (const move of moves) body?.addEventListener(move, stop, { passive: true });
    return unsubscribe;
  }, [page, keyBarOpen, narrow, section]);
  // server-side: the web server updates PC bridges, so it keeps this choice
  const [pcSettings, setPcSettings] = useState<MachineSettings | null>(null);
  const [pcSettingsError, setPcSettingsError] = useState<string | null>(null);
  // asked when a page that shows them opens, so a request that failed earlier is made again
  useEffect(() => {
    if (page !== "remote" && page !== "about") return;
    let live = true;
    machineRequest<MachineSettings>("/settings").then((settings) => { if (live) setPcSettings(settings); }, () => { if (live) setPcSettings(null); });
    return () => { live = false; };
  }, [page]);
  const updatePcSettings = async (patch: Partial<MachineSettings>) => {
    try { setPcSettings(await machineRequest<MachineSettings>("/settings", "PATCH", patch)); setPcSettingsError(null); }
    catch (e) { setPcSettingsError(e instanceof Error ? e.message : String(e)); }
  };

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent): void => {
      // an Escape that cancels an IME composition (the editor's Character field) is the IME's
      if (event.key !== "Escape" || event.isComposing || event.keyCode === 229) return;
      event.preventDefault();
      // out of the key bar editor first; from any page, a phone's included, it closes the dialog
      if (keyBarOpen) setKeyBarOpen(false);
      else onClose();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [onClose, keyBarOpen]);

  /** the list is one Tab stop: the arrows walk it, and beside an open page they turn the page too */
  const onTabKey = (event: ReactKeyboardEvent<HTMLButtonElement>, index: number): void => {
    const to = event.key === "ArrowDown" ? index + 1 : event.key === "ArrowUp" ? index - 1 : event.key === "Home" ? 0 : event.key === "End" ? PAGES.length - 1 : null;
    if (to === null) return;
    event.preventDefault();
    const next = PAGES[(to + PAGES.length) % PAGES.length]!.id;
    tab(next)?.focus();
    if (!narrow) openPage(next);
  };

  const body = (): ReactNode => {
    switch (page) {
      case "appearance": return <AppearancePage />;
      case "chat": return <ChatPage />;
      case "terminal": return <TerminalPage keyBarButtonRef={keyBarButtonRef} onEditKeyBar={openKeyBar} />;
      case "alerts": return <AlertsPage onEnableNotifications={onEnableNotifications} />;
      case "voice": return <VoicePage />;
      case "usage": return <UsageSettings onLocalLogin={onUsageLogin} watching={auth?.role === "watch"} />;
      case "shortcuts": return <ShortcutsPage />;
      // after every device went, its own pairing included, a browser asks the server where it stands: the roster answers, or the gate does
      case "devices": return <DevicesPage auth={auth} security={security} onSignOut={actions.lock} onRevokedAll={actions.refresh} />;
      case "remote": return <RemotePcsPage actions={actions} machines={machines} pcSettings={pcSettings} pcSettingsError={pcSettingsError} onPcSettings={(patch) => void updatePcSettings(patch)} />;
      case "integrations": return <IntegrationsPage />;
      case "about": return <AboutPage updates={updates} herdrVersion={herdrVersion} bridgesFollow={pcSettings?.auto_update_bridges === true} />;
      default: return null;
    }
  };
  const listShown = !narrow || (page === null && !keyBarOpen);
  const focusable = page ?? PAGES[0]!.id;

  return (
    <div className={overPreview ? "modal-scrim settings-over-preview" : "modal-scrim"} onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      {/* named Settings on every page: the page's own name is the visible title */}
      <section ref={surface} className="modal settings-dialog" role="dialog" aria-modal="true" aria-label={keyBarOpen ? t("Key bar") : t("Settings")} tabIndex={-1}>
        <header className="modal-header settings-header">
          {(keyBarOpen || (narrow && page !== null)) && <button type="button" ref={backRef} className="icon-button" aria-label={t("Back to settings")} onClick={goBack}><ArrowLeft aria-hidden="true" /></button>}
          <h2 className="modal-title">{keyBarOpen ? t("Key bar") : page === null ? t("Settings") : label(page)}</h2>
          <button type="button" className="icon-button" aria-label={t("Close settings")} onClick={onClose}><X aria-hidden="true" /></button>
        </header>
        {listShown && (
          <nav className="settings-nav" aria-label={t("Settings")}>
            <p className="settings-nav-title" aria-hidden="true">{t("Settings")}</p>
            <div ref={tabsRef} className="settings-tabs" role="tablist" aria-orientation="vertical">
              {PAGES.map(({ id, icon: Icon }, index) => (
                <button key={id} type="button" role="tab" className="settings-tab" data-settings-page={id} aria-selected={page === id} aria-controls={page === id ? "settings-panel" : undefined} tabIndex={focusable === id ? 0 : -1} onClick={() => openPage(id)} onKeyDown={(event) => onTabKey(event, index)}>
                  <Icon aria-hidden="true" />
                  <span>{label(id)}</span>
                  <ChevronRight className="settings-tab-chevron" aria-hidden="true" />
                </button>
              ))}
            </div>
          </nav>
        )}
        {page !== null && <div key={page} ref={settingsBodyRef} id="settings-panel" className="modal-body settings-body" role="tabpanel" aria-label={label(page)} hidden={keyBarOpen}>{saveError !== null && <SaveFailure error={saveError} paused={savePaused} retrying={saveRetrying} onRetry={onRetrySave} />}{body()}</div>}
        {keyBarOpen && <div className="modal-body settings-key-bar-body"><KeyBarSettings /></div>}
      </section>
    </div>
  );
}
