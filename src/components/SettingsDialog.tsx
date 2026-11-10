import { useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent as ReactKeyboardEvent, type ReactNode, type RefObject } from "react";
import { ALargeSmall, AppWindow, ArrowDownUp, ArrowLeft, AudioLines, Bell, Bot, Box, Brain, CheckCheck, ChevronLeft, ChevronRight, CircleDot, ClipboardCopy, ClipboardPaste, Command, CornerDownLeft, ExternalLink, FileClock, FilePen, Filter, FlaskConical, Gauge, Globe, Image as ImageIcon, Info, Keyboard, Languages, Layers, ListCollapse, ListTree, Lock, MessageCircleQuestionMark, MessageSquare, MessageSquareReply, MessagesSquare, Mic, Monitor, Mouse, MousePointer2, MoveHorizontal, OctagonX, Palette, PanelLeft, PanelRight, Plus, Puzzle, Rows3, Search, Send, Server, Shapes, ShieldAlert, Smartphone, Sparkles, SquareTerminal, Star, SunMoon, Tag, Tags, TextCursorInput, Timer, Trash2, Type, Volume2, WandSparkles, WrapText, X, type LucideIcon } from "lucide-react";

import "./SettingsDialog.css";

import type { AddPcPreset, AppActions } from "../lib/actions.ts";
import { useInstallPrompt } from "../lib/install.ts";
import { changePc, inNativeApp } from "../lib/nativeApp.ts";
import { canReuseExternalLinkTab } from "../lib/terminalFileLinks.ts";
import { loadRelayShell } from "../lib/relay.ts";
import { inRelayShell, useRelay, type RelayState } from "../lib/useRelay.ts";
import { serverIdOfPath, shellMode } from "../lib/shellMode.ts";
import { SHORTCUTS, bindingDisplayKeys, formatKeys, isMacPlatform, listedOnly, setShortcutRecording, shortcutDisplayKeys, shortcutKeys, shortcutConflict, type ShortcutId } from "../lib/shortcuts.ts";
import { MENU_SHORTCUT_KEYS, recordShortcut, shortcutMatchesQuery } from "../lib/shortcutRecorder.ts";
import { exactChordRisk, isReservedShortcutKey, parseExactChord } from "../lib/shortcutBindings.ts";
import { compileHerdrKeys } from "../lib/herdrKeys.ts";
import { herdrKeys, loadHerdrUi } from "../lib/herdrUi.ts";
import { HERDR_PREFIX_ACTIONS, type HerdrKeys, type HerdrPrefixAction } from "../../shared/herdr-keys.ts";
import { WEB_LINK_TARGETS } from "../lib/webPanel.ts";
import { FILE_OPEN_TARGETS } from "../lib/filePresentation.ts";
import { CHAT_FONT_MAX, CHAT_FONT_MIN, CHAT_WIDTHS, chatFontSize, DEFAULT_SETTINGS, QUICK_REPLIES_MAX, QUICK_REPLY_MAX_CHARS, TERMINAL_FONT_MAX, TERMINAL_FONT_MIN, TERMINAL_WHEEL_SPEED_MAX, TERMINAL_WHEEL_SPEED_MIN, DICTATION_LANGUAGES, VOICE_BUTTONS, VOICE_ENGINES, enterSendsOn, useSettings, forgetPaneViews, uiFontSize, type DictationLanguage, type VoiceButton } from "../lib/settings.ts";
import { isThemeId, pickTheme, rowFor, THEME_IDS, type DrawnTheme, type Mode, type ThemeId } from "../lib/themes.ts";
import { chosenTheme, customRow, customRowId, type CustomTheme } from "../lib/customThemes.ts";
import { LANGUAGE_NAMES, LANGUAGE_SETTINGS, useLocale, useT, type Translate } from "../lib/i18n.ts";
import { focusInOtherModal, useFocusTrap } from "../lib/useFocusTrap.ts";
import { awaitRestart, restartState, subscribeRestart } from "../lib/runtimeSwitch.ts";
import { paneLifetimes } from "../lib/paneLifetime.ts";
import { KeyBarSettings, KeyBarToggles } from "./KeyBarSettings.tsx";
import { FileTextSizeRow } from "./FileTextSizeRow.tsx";
import { FoldHelpersRow } from "./FoldHelpersRow.tsx";
import { FilesPanelRow } from "./FilesPanelRow.tsx";
import { onSettingsHistory, recordSettings, settingsEntry, settingsLevels, type SettingsLevel } from "../lib/settingsHistory.ts";
import { ThemeFiles, themeLabel } from "./ThemeFiles.tsx";
import { ChipToggles, SettingsBare, Segmented, SettingsFold, SettingsGroup, SettingsQuery, SettingsRow, SettingsSelect, Stepper, Toggle, settingsQueryWords } from "./SettingsControls.tsx";
import { PcLoadSetting } from "./MachineStats.tsx";
import { FONT_FAMILY_MAX_CHARS, sanitizeFontFamily } from "../lib/fontFamily.ts";
import { UI_FONT_MAX, UI_FONT_MIN, UI_FONT_PRESET_FAMILY, uiFontPreset, type UiFontPreset } from "../lib/typography.ts";
import { canListInstalledFonts, filterFamilies, isMonospaceFamily, queryInstalledFonts } from "../lib/installedFonts.ts";
import type { UpdatesModel } from "../lib/updates.ts";
import type { UserError } from "../lib/userError.ts";
import { LOCAL_MACHINE, pcAlertKey, type HerdrCoreFacts, type HerdrRuntimeFacts, type Machine, type MachineSettings } from "../../shared/machines.ts";
import { canHideMachine, isMachineShown, setHiddenMachines, useHiddenMachines, withMachineHidden } from "../lib/hiddenMachines.ts";
import { alertFiltersChanged, updateAlertFilters, useAlertFilters } from "../lib/alertFilters.ts";
import { fetchMachines, fetchRemoteAccess, requestRelayOffer, fetchVoiceStatus, machineRequest, saveVoiceConfig, switchRuntime, fetchBridgeHealth } from "../lib/api.ts";
import { isLoopbackHost, phonePlan } from "../lib/phone.ts";
import type { PushActionResult } from "../lib/pushHealth.ts";
import type { HealthAuth, PluginActions, RemoteAccess } from "../../shared/protocol.ts";
import type { SecurityFacts } from "../lib/useAccess.ts";
import { useMachineApi } from "../lib/machineContext.tsx";
import type { VoiceStatus } from "../../shared/voice.ts";
import { dictationLocale, VOICE_CONFIG_EVENT } from "../lib/voice.ts";
import { DevicesPanel } from "./DevicesPanel.tsx";
import { ConfirmDialog } from "./ConfirmDialog.tsx";
import { RuntimeMove } from "./RuntimeMove.tsx";
import { SignOutRow } from "./SignOutRow.tsx";
import { failureText, openOwnOffer, RelayDirectRow, statusText } from "./RelayPanel.tsx";
import { AccountSection, accountServiceHere, type AccountState } from "./AccountSection.tsx";
import { listedPcStateText } from "./AccountPcs.tsx";
import { STATE_WORD } from "./MachineSidebar.tsx";
import { pcAccountStatus } from "../lib/account/join.ts";
import { apiFetch } from "../lib/api-request-id.ts";
import type { MyPc } from "../lib/account/myPcs.ts";
import { ConnectPhoneDialog, relayOffered } from "./ConnectPhoneDialog.tsx";
import { PushTestControls } from "./PushTestControls.tsx";
import { AlertWebhookGroup } from "./AlertWebhookGroup.tsx";
import { previewAlertSound, unlockAlertSound } from "../lib/alertSound.ts";
import { HerdrUpdateControls, UpdateControls } from "./UpdateControls.tsx";
import { TelemetryControls } from "./TelemetryControls.tsx";
import { AgentsSettings } from "./AgentsSettings.tsx";
import { AgentGroupNames } from "./AgentGroupNames.tsx";
import { useSheetSwipe } from "../lib/sheets.ts";
import { useMediaQuery } from "../lib/useMediaQuery.ts";
import { FILE_PANEL_DOCK_QUERY } from "../lib/filePanelWidth.ts";
import { CrashProbe, RegionCrash } from "./AppCrash.tsx";
import { RenderBoundary } from "./RenderBoundary.tsx";
import { requestedSettingsPage, requestSettingsPage, type SettingsPageId } from "../lib/paletteSettings.ts";
import { currentSettingsPage } from "../lib/deepLink.ts";
import { HERDR_WINDOW_CHOICES, type HerdrWindowChoice } from "../lib/herdrWindow.ts";

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
  /** shows a pane of `machineId` in its terminal: an agent's install or sign-in tab, from Agent integrations */
  onOpenPane: (machineId: string, paneId: string) => void;
  actions: AppActions;
  updates: UpdatesModel;
  /** how this browser got in, from the last health check */
  auth: HealthAuth | null;
  /** the herdr this app's server talks to, from the last health check */
  herdrVersion: string | null;
  /** which runtime that is (herdr's TUI server, or herdr-core: the Herdr app's), from the same check; null before one answered */
  herdrRuntime?: "herdr" | "herdr-core" | null;
  /** what the server's PC has of herdr-core, from the same check; null when it did not say */
  herdrCore?: HerdrCoreFacts | null;
  /** which runtime the server serves and what Settings may switch it to, from the same check */
  herdrRuntimeFacts?: HerdrRuntimeFacts | null;
  /** the PC shown now passes pictures (herdr-core, its panes attached): what Pictures in the terminal does there until a device chooses */
  picturesByDefault?: boolean;
  /** the server's boot id from the same check: a new one after a switch is the restarted server */
  bootId?: string | null;
  /** a runtime switch's restarted server answers: the app reads its facts and terminals again */
  onServerRestarted?: () => void;
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
  // typed and not yet saved: only that is saved when the field goes, never a value put back meanwhile (a row's ↺)
  const typed = useRef(false);
  const commit = (): void => {
    typed.current = false;
    const next = sanitizeFontFamily(draft);
    setDraft(next);
    if (next !== value) onCommit(next);
  };
  // closing the dialog with Escape unmounts the field without a blur
  const commitRef = useRef(commit);
  commitRef.current = commit;
  useEffect(() => () => { if (typed.current) commitRef.current(); }, []);
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
          onChange={(event) => { typed.current = true; setDraft(event.target.value); }}
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

/** A group a link or the palette lands on may sit in a page's folded part (SettingsFold): it is opened first. */
function openFolds(group: HTMLElement): void {
  for (let fold = group.closest("details"); fold !== null; fold = fold.parentElement?.closest("details") ?? null) fold.open = true;
}

/** how to show the Herdr app's terminals here: the steps About's runtime line leaves out (G-101) */
const RUNTIME_HELP = "https://github.com/devswha/ovis/blob/main/docs/guide.md#herdr-app-terminals";

/** The pages in the order the list shows them: what is looked at first, then what is set once. */
export const PAGES: readonly { id: SettingsPage; icon: LucideIcon }[] = [
  { id: "appearance", icon: Palette },
  { id: "chat", icon: MessageSquare },
  { id: "terminal", icon: SquareTerminal },
  { id: "alerts", icon: Bell },
  { id: "agents", icon: Bot },
  { id: "shortcuts", icon: Keyboard },
  { id: "devices", icon: Smartphone },
  { id: "experimental", icon: FlaskConical },
  { id: "about", icon: Info },
];

/**
 * The one dim line under a page's title: what the page holds (G-173). About has none: it is a page of
 * facts without sentences on purpose. Literal `t()` calls, so the dictionaries' checks find each key.
 */
function pageNote(t: Translate, page: SettingsPage): string | null {
  switch (page) {
    case "appearance": return t("Theme, fonts and the sidebar on this device.");
    case "chat": return t("How conversations look and what the message box offers.");
    case "terminal": return t("How terminal panes look and take input.");
    case "alerts": return t("When this device alerts you, and where else alerts go.");
    case "agents": return t("Coding agents on this PC, their accounts and plan limits.");
    case "shortcuts": return t("Keyboard shortcuts, and herdr's prefix keys.");
    case "devices": return t("Phones, browsers and PCs that reach this Ovis.");
    case "experimental": return t("Features still being shaped; they may change.");
    default: return null;
  }
}

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
  const page = PAGES.find(({ id }) => id === (entry.page === null ? null : currentSettingsPage(entry.page)))?.id ?? null;
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
 * One theme as a small picture of the app in its own colours, a sidebar beside a pane, its name under it (the cards T3 Code
 * and herdr-app show). `row` is what the theme draws on `side`: a built-in theme's row, or an imported theme's (lib/customThemes.ts).
 */
function ThemeCard({ card, name, row, side, checked, onPick }: { card: string; name: string; row: DrawnTheme; side: Mode; checked: boolean; onPick: () => void }) {
  const t = useT();
  const c = row.preview;
  // a theme of the other kind says so: it draws that way on this side; every card's tooltip carries its
  // whole name, as the name under the picture may be cut (G-204)
  const kind = row.mode === side ? undefined : `${name} · ${t(row.mode === "dark" ? "Dark" : "Light")}`;
  return (
    <button type="button" role="radio" aria-checked={checked} aria-label={kind} title={kind ?? name} tabIndex={checked ? 0 : -1} className="theme-card" data-theme-card={card} onClick={onPick}>
      <span className="theme-card-art" aria-hidden="true" style={{ background: row.bg, borderColor: c.border }}>
        <span className="theme-card-side" style={{ background: row.bgPanel, borderColor: c.border }}>
          <i style={{ background: c.accent }} /><i style={{ background: c.textDim }} /><i style={{ background: c.textDim }} />
        </span>
        <span className="theme-card-pane" style={{ background: c.elevated, borderColor: c.border }}>
          <i style={{ background: c.text }} /><i style={{ background: c.textDim }} /><b style={{ background: c.primary }} />
        </span>
      </span>
      <span className="theme-card-name">{name}</span>
    </button>
  );
}

/** Sidebar rows, drawn: a workspace on one line, or its agent's line above it */
function SidebarRowsPreview({ rows }: { rows: "one" | "two" }) {
  return (
    <span className={rows === "two" ? "sidebar-rows-preview is-two" : "sidebar-rows-preview"}>
      {[0, 1].map((item) => <span key={item} className="sidebar-rows-preview-item"><i />{rows === "two" && <i />}</span>)}
    </span>
  );
}

/**
 * The themes of one side in one row of cards that scrolls sideways (a trackpad, Shift and the wheel, a
 * swipe, or the arrows at its ends), the chosen one brought into view: the row stays one card tall
 * however many themes there are. The side drawn now opens first; Dark and Light switch it. The side's
 * own kind comes first, then after a rule the other kind, which that side draws as it is (a dark theme
 * chosen for light mode draws dark, as in herdr). The themes imported from a file come before both, and one
 * of them chosen for a side is drawn in place of that side's built-in theme, which stays as it was under it.
 * Arrow keys, Home and End pick along the row, as a radio group's do.
 */
function ThemePicker() {
  const { settings, update } = useSettings();
  const t = useT();
  const systemDark = useMediaQuery("(prefers-color-scheme: dark)");
  const drawn: Mode = settings.theme === "system" ? (systemDark ? "dark" : "light") : settings.theme;
  // the side drawn now, until Dark or Light here is chosen
  const [picked, setPicked] = useState<Mode | null>(null);
  const side = picked ?? drawn;
  const strip = useRef<HTMLDivElement>(null);
  const [ends, setEnds] = useState({ start: true, end: true });
  const custom = settings.customThemes;
  const imported = chosenTheme(custom, side);
  // the card that is checked: the imported theme drawn on this side, else the side's built-in theme
  const current = imported ? customRowId(imported.id) : side === "dark" ? settings.darkTheme : settings.lightTheme;
  const other: Mode = side === "dark" ? "light" : "dark";
  const own = THEME_IDS.filter((id) => rowFor(id, side).mode === side);
  const others = THEME_IDS.filter((id) => rowFor(id, side).mode === other);
  const label = t(side === "dark" ? "Dark theme" : "Light theme");
  const measure = useCallback(() => {
    const el = strip.current;
    if (el) setEnds({ start: el.scrollLeft <= 1, end: el.scrollLeft + el.clientWidth >= el.scrollWidth - 1 });
  }, []);
  // the chosen card in view when it is not (a side switched, a reset), by the row's own scroll so the
  // page stays put; a pick already in view leaves the row where it is
  useLayoutEffect(() => {
    const el = strip.current;
    const card = el?.querySelector<HTMLElement>(`[data-theme-card="${current}"]`);
    const shown = el && card && card.offsetLeft >= el.scrollLeft && card.offsetLeft + card.offsetWidth <= el.scrollLeft + el.clientWidth;
    if (el && card && !shown) el.scrollLeft = card.offsetLeft - (el.clientWidth - card.offsetWidth) / 2;
    measure();
  }, [side, current, measure]);
  useEffect(() => {
    const el = strip.current;
    if (!el) return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [measure]);
  // onto the settings as they are now: another tab may have imported or removed a theme since this was drawn
  const pick = (id: ThemeId): void => update((latest) => ({ ...pickTheme(latest, side, id), customThemes: { ...latest.customThemes, [side]: null } }));
  const pickImported = (id: string): void => update((latest) => latest.customThemes.themes.some((entry) => entry.id === id) ? { customThemes: { ...latest.customThemes, [side]: id } } : {});
  const card = (id: ThemeId) => <ThemeCard key={id} card={id} name={t(THEME_NAMES[id])} row={rowFor(id, side)} side={side} checked={current === id} onPick={() => pick(id)} />;
  // two imported themes of one name (a dark file and a light file nobody renamed) say which sides each has (themeLabel)
  const importedCard = (theme: CustomTheme) => <ThemeCard key={theme.id} card={customRowId(theme.id)} name={themeLabel(t, theme, custom.themes)} row={customRow(theme, side)} side={side} checked={current === customRowId(theme.id)} onPick={() => pickImported(theme.id)} />;
  const step = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight" && event.key !== "Home" && event.key !== "End") return;
    const cards = [...(strip.current?.querySelectorAll<HTMLElement>("[data-theme-card]") ?? [])];
    const at = cards.indexOf(document.activeElement as HTMLElement);
    const next = event.key === "Home" ? 0 : event.key === "End" ? cards.length - 1 : (at + (event.key === "ArrowRight" ? 1 : -1) + cards.length) % cards.length;
    event.preventDefault();
    // a radio group's arrows pick as they move
    const id = cards[next]?.dataset["themeCard"];
    const theme = custom.themes.find((entry) => customRowId(entry.id) === id);
    if (theme) pickImported(theme.id);
    else if (id && isThemeId(id)) pick(id);
    cards[next]?.focus();
    cards[next]?.scrollIntoView({ block: "nearest", inline: "nearest" });
  };
  const scroll = (direction: 1 | -1): void => strip.current?.scrollBy({ left: direction * strip.current.clientWidth * 0.8, behavior: "smooth" });
  return (
    <>
      <SettingsRow icon={Palette} label={label} keywords={`${t("Dark theme")} ${t("Light theme")} ${t("Shown in dark mode")} ${t("Shown in light mode")}`} reset={[side === "dark" ? "darkTheme" : "lightTheme"]}
        resetAlso={{ changed: custom[side] !== null, restore: () => update((latest) => ({ customThemes: { ...latest.customThemes, [side]: null } })) }}>
        <Segmented label={`${t("Dark theme")} · ${t("Light theme")}`} value={side} onChange={setPicked} options={[{ value: "dark", label: t("Dark"), name: t("Show dark themes") }, { value: "light", label: t("Light"), name: t("Show light themes") }]} />
      </SettingsRow>
      <div className="settings-item theme-strip">
        <div className="theme-strip-frame">
          <div ref={strip} className="theme-cards" role="radiogroup" aria-label={label} onScroll={measure} onKeyDown={step}>
            {custom.themes.map(importedCard)}
            {custom.themes.length > 0 && <span className="theme-cards-rule" aria-hidden="true" />}
            {own.map(card)}
            {others.length > 0 && <span className="theme-cards-rule" aria-hidden="true" />}
            {others.map(card)}
          </div>
          {!ends.start && <button type="button" className="icon-button theme-strip-arrow is-start" aria-label={t("Earlier themes")} title={t("Earlier themes")} tabIndex={-1} onClick={() => scroll(-1)}><ChevronLeft aria-hidden="true" /></button>}
          {!ends.end && <button type="button" className="icon-button theme-strip-arrow is-end" aria-label={t("Later themes")} title={t("Later themes")} tabIndex={-1} onClick={() => scroll(1)}><ChevronRight aria-hidden="true" /></button>}
        </div>
      </div>
      {/* the side drawn now when the theme has it, so the change shows; its only side otherwise */}
      <ThemeFiles onImported={(sides) => setPicked(sides.includes(drawn) ? drawn : sides[0]!)} />
    </>
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
  // a family put back from elsewhere (the row's ↺) closes the custom field it was typed in
  useEffect(() => { if (settings.uiFontFamily === DEFAULT_SETTINGS.uiFontFamily) setCustomOpen(false); }, [settings.uiFontFamily]);
  const custom = customOpen || preset === "custom";
  const interfaceFontDescription = t("Menus, lists, dialogs and the sidebar; the chat's text follows it until it has a font of its own. The terminal and code keep theirs. System is this device's own interface font.");
  const choose = (next: UiFontPreset | "custom"): void => {
    setCustomOpen(next === "custom");
    if (next !== "custom") update({ uiFontFamily: UI_FONT_PRESET_FAMILY[next] });
  };
  return (
    <>
      <SettingsRow icon={Type} label={t("Interface font")} description={interfaceFontDescription} htmlFor="settings-ui-font" reset={["uiFontFamily"]}>
        <SettingsSelect id="settings-ui-font" value={custom ? "custom" : preset} onChange={(event) => choose(event.target.value as UiFontPreset | "custom")}>
          <option value="default">{t("Default")}</option>
          <option value="system">{t("System")}</option>
          <option value="noto">Noto Sans</option>
          <option value="custom">{t("Custom")}</option>
        </SettingsSelect>
      </SettingsRow>
      {custom && (
        <SettingsRow icon={Type} label={t("Custom interface font")} description={t("Comma-separated, tried in order, in front of the default. A font this device does not have falls back to the default.")} keywords={`${t("Interface font")} ${interfaceFontDescription}`} wide>
          <FontFamilyInput value={settings.uiFontFamily} label={t("Custom interface font")} placeholder={UI_FONT_PLACEHOLDER} onCommit={(uiFontFamily) => update({ uiFontFamily })} />
        </SettingsRow>
      )}
    </>
  );
}

function AppearancePage() {
  const { settings, update } = useSettings();
  const t = useT();
  // herdr-app's Look page: theme, then size and fonts (the terminal's and the chat's too), each row a label and its control
  return (
    <SettingsBare.Provider value={true}>
    <SettingsGroup>
      <SettingsRow icon={SunMoon} label={t("Theme")} wide reset={["theme"]}>
        <Segmented label={t("Theme")} value={settings.theme} onChange={(theme) => update({ theme })} options={[{ value: "dark", label: t("Dark") }, { value: "light", label: t("Light") }, { value: "system", label: t("System") }]} />
      </SettingsRow>
      <ThemePicker />
    </SettingsGroup>

    <SettingsGroup title={t("Typography")} section="typography">
      <SettingsRow icon={ALargeSmall} label={t("Interface font size")} description={t("Menus, lists, dialogs and the sidebar. The chat follows it until it has a size of its own; the terminal keeps its own.")} reset={["uiFontSize"]}>
        <Stepper label={t("Interface font size")} value={uiFontSize(settings)} text={`${uiFontSize(settings)}px`} min={UI_FONT_MIN} max={UI_FONT_MAX} decreaseLabel={t("Decrease interface font size")} increaseLabel={t("Increase interface font size")} onChange={(size) => update({ uiFontSize: size })} />
      </SettingsRow>
      <InterfaceFontRows />
      <SettingsRow icon={SquareTerminal} label={t("Terminal font")} description={t("Comma-separated, tried in order. A font this device does not have falls back to the default.")} keywords={`${t("Terminal font size")} ${t("Applied to every terminal pane")}`} wide reset={["terminalFontFamily", "terminalFontSize"]}>
        <span className="settings-font-size">
          <FontFamilyInput value={settings.terminalFontFamily} label={t("Terminal font")} fixedWidthFor="terminal" onCommit={(terminalFontFamily) => update({ terminalFontFamily })} />
          <Stepper label={t("Terminal font size")} value={settings.terminalFontSize} text={`${settings.terminalFontSize}px`} min={TERMINAL_FONT_MIN} max={TERMINAL_FONT_MAX} decreaseLabel={t("Decrease terminal font size")} increaseLabel={t("Increase terminal font size")} onChange={(terminalFontSize) => update({ terminalFontSize })} unit="px" range={t("Enter {min}–{max}px", { min: TERMINAL_FONT_MIN, max: TERMINAL_FONT_MAX })} />
        </span>
      </SettingsRow>
      <SettingsRow icon={MessageSquare} label={t("Chat font")} description={t("Message text; code stays monospace. Comma-separated, tried in order. A font this device does not have falls back to the default.")} keywords={`${t("Chat font size")} ${t("Messages, code, prompt cards and the message box in the chat view")}`} wide reset={["chatFontFamily", "chatFontSize"]}>
        <span className="settings-font-size">
          <FontFamilyInput value={settings.chatFontFamily} label={t("Chat font")} onCommit={(chatFontFamily) => update({ chatFontFamily })} />
          <Stepper label={t("Chat font size")} value={chatFontSize(settings)} text={`${chatFontSize(settings)}px`} min={CHAT_FONT_MIN} max={CHAT_FONT_MAX} decreaseLabel={t("Decrease chat font size")} increaseLabel={t("Increase chat font size")} onChange={(size) => update({ chatFontSize: size })} unit="px" range={t("Enter {min}–{max}px", { min: CHAT_FONT_MIN, max: CHAT_FONT_MAX })} />
        </span>
      </SettingsRow>
    </SettingsGroup>

    <SettingsGroup>
      <SettingsRow icon={Rows3} label={t("Density")} wide reset={["density"]}>
        <Segmented label={t("Density")} value={settings.density} onChange={(density) => update({ density })} options={[{ value: "comfortable", label: t("Comfortable") }, { value: "compact", label: t("Compact") }]} />
      </SettingsRow>
      <SettingsRow icon={Languages} label={t("Language")} description={t("Follows the browser unless you choose one")} htmlFor="settings-language" reset={["language"]}>
        <SettingsSelect id="settings-language" value={settings.language} onChange={(event) => update({ language: event.target.value as typeof settings.language })}>
          {LANGUAGE_SETTINGS.map((language) => <option key={language} value={language}>{language === "system" ? t("System") : LANGUAGE_NAMES[language]}</option>)}
        </SettingsSelect>
      </SettingsRow>
    </SettingsGroup>

    <SettingsGroup title={t("Sidebar")} section="sidebar">
      <SettingsRow icon={PanelLeft} preview={<SidebarRowsPreview rows={settings.sidebarRows} />} label={t("Sidebar rows")} description={t("Name each workspace on one line, or show what its agent is doing with the workspace under it")} wide reset={["sidebarRows"]}>
        <Segmented label={t("Sidebar rows")} value={settings.sidebarRows} onChange={(sidebarRows) => update({ sidebarRows })} options={[{ value: "one", label: t("One line") }, { value: "two", label: t("Two lines") }]} />
      </SettingsRow>
      {/* the scope differs within the one control: said on the row, where the sentences are not (G-097) */}
      <SettingsRow icon={ArrowDownUp} label={t("Agents order")} description={t("Waiting first keeps herdr's order with the agents that need you on top, and folds the resting ones under one line. Activity keeps a waiting agent on top, then the one that changed last. By state lists the agents above the workspaces on this device: the ones that need you first, then working, done and idle. herdr's own order is not changed.")} condition={<span className="settings-condition">{t("By state applies to this device; the other orders to every browser.")}</span>} wide reset={["agentOrder", "agentGroups"]}>
        {/* By state is this device's grouping (agentGroups); Workspaces and Activity are every browser's order (agentOrder), the grouping off */}
        <Segmented label={t("Agents order")} value={settings.agentGroups ? "state" : settings.agentOrder} onChange={(order) => update(order === "state" ? { agentGroups: true } : { agentOrder: order, agentGroups: false })} options={[{ value: "waiting", label: t("Waiting first") }, { value: "workspace", label: t("Workspaces") }, { value: "activity", label: t("Activity") }, { value: "state", label: t("By state") }] as const} />
      </SettingsRow>
      {settings.agentGroups && <SettingsRow icon={ArrowDownUp} label={t("Within a state")} wide>
        <Segmented label={t("Within a state")} value={settings.agentGroupSort} onChange={(agentGroupSort) => update({ agentGroupSort })} options={[{ value: "wait", label: t("Longest wait") }, { value: "recent", label: t("Recent") }, { value: "name", label: t("Name") }]} />
      </SettingsRow>}
    </SettingsGroup>

    <SettingsFold kind="more" keys={["autoTabNames", "sidebarFilter", "sidebarPeek", "sidebarBackgroundWorkspaces", "sidebarContext", "sidebarAgentTree", "foldHelpers", "agentMarks", "statusIndicators", "fileFontSize"]}>
      <SettingsGroup title={t("Sidebar")} section="sidebar-more">
        <SettingsRow icon={Tag} label={t("Name tabs from the first message")} description={t("A tab still named by its number shows a few words of the first message sent to it, in every browser. A name you gave a tab is kept, and herdr's own tab names do not change. Only those words are kept, on this server, until the tab closes; turning this off deletes them.")}
          condition={<span className="settings-condition">{t("Only those words are kept, on this server, until the tab closes; turning this off deletes them.")}</span>} reset={["autoTabNames"]}>
          <Toggle label={t("Name tabs from the first message")} checked={settings.autoTabNames} onChange={(autoTabNames) => update({ autoTabNames })} />
        </SettingsRow>
        <SettingsRow icon={Filter} label={t("Sidebar filter")} description={t("Show the Filter field above the sidebar's lists on this device. When off, Filter workspaces and agents in the command palette opens it.")}>
          <Toggle label={t("Sidebar filter")} checked={settings.sidebarFilter} onChange={(sidebarFilter) => update({ sidebarFilter })} />
        </SettingsRow>
        <SettingsRow icon={MousePointer2} label={t("Show the sidebar on hover")} description={t("On this device, while the sidebar is hidden, resting the mouse on its button shows it over the pane until the mouse leaves. Click the button to keep it open.")}>
          <Toggle label={t("Show the sidebar on hover")} checked={settings.sidebarPeek} onChange={(sidebarPeek) => update({ sidebarPeek })} />
        </SettingsRow>
        <SettingsRow icon={Layers} label={t("Background workspaces apart")} description={t("On this device, workspaces a tool tagged role=background (herdr workspace report-metadata --token role=background) stand after the others under a folded Background workspaces heading. The open one, and one whose agent asks a question, stay in sight.")}>
          <Toggle label={t("Background workspaces apart")} checked={settings.sidebarBackgroundWorkspaces} onChange={(sidebarBackgroundWorkspaces) => update({ sidebarBackgroundWorkspaces })} />
        </SettingsRow>
        <SettingsRow icon={Gauge} label={t("Context left on agent rows")} description={t("On this device, show the context ring from the chat's composer on each agent row, for the agents whose context window is known (Claude Code and Codex). It turns red at 20% left or less.")}>
          <Toggle label={t("Context left on agent rows")} checked={settings.sidebarContext} onChange={(sidebarContext) => update({ sidebarContext })} />
        </SettingsRow>
        <SettingsRow icon={ListTree} label={t("Agents under workspaces")} description={t("On this device, list each workspace's agents under it in the PCs list, so every PC shows its workspaces and the agents running in them. The Agents list stays as it is.")}>
          <Toggle label={t("Agents under workspaces")} checked={settings.sidebarAgentTree} onChange={(sidebarAgentTree) => update({ sidebarAgentTree })} />
        </SettingsRow>
        <FoldHelpersRow />
        <SettingsRow icon={Shapes} label={t("Agent logos")} description={t("Draw each agent's logo in its brand colors, or without color")} wide>
          <Segmented label={t("Agent logos")} value={settings.agentMarks} onChange={(agentMarks) => update({ agentMarks })} options={[{ value: "color", label: t("Color") }, { value: "mono", label: t("Mono") }]} />
        </SettingsRow>
        <SettingsRow icon={CircleDot} label={t("Status indicators")} description={t("Classic marks only the states that ask for a look; Dots and Symbols draw every state as herdr's TUI does")} wide>
          <Segmented label={t("Status indicators")} value={settings.statusIndicators} onChange={(statusIndicators) => update({ statusIndicators })} options={[{ value: "classic", label: t("Classic") }, { value: "dots", label: t("Dots") }, { value: "symbols", label: t("Symbols") }]} />
        </SettingsRow>
      </SettingsGroup>
      <SettingsGroup title={t("Typography")} section="typography-more">
        <FileTextSizeRow />
      </SettingsGroup>
    </SettingsFold>
    </SettingsBare.Provider>
  );
}

/** Wrap long lines, drawn: one long line of code wrapped onto the next, or running past the edge. */
function WrapPreview({ wrap }: { wrap: boolean }) {
  return <span className={wrap ? "settings-wrap-preview is-wrapped" : "settings-wrap-preview"}><code>{WRAP_PREVIEW_CODE}</code></span>;
}
const WRAP_PREVIEW_CODE = "const total = items.reduce(sum, 0);";

function ChatPage() {
  const { settings, update } = useSettings();
  const t = useT();
  const touch = useMediaQuery("(pointer: coarse)");
  const filePanelAvailable = useMediaQuery(FILE_PANEL_DOCK_QUERY);
  const chip = (Icon: LucideIcon, label: string, on: boolean, change: (on: boolean) => void) => <button type="button" className="settings-chip" aria-pressed={on} onClick={() => change(!on)}><Icon aria-hidden="true" />{label}</button>;
  // herdr-app rows (a label and its control) under short group headings; the sentences stay for search only
  return (
    <SettingsBare.Provider value="rows">
      <SettingsGroup title={t("Conversation")} section="conversation">
        <SettingsRow icon={AppWindow} label={t("Panes open in")} description={t("Every pane on this device. Switching a pane's lens keeps it there until this changes. Auto: chat for an agent on a touch screen, else the terminal.")} condition={<span className="settings-condition">{t("Auto: the chat on a touch screen, the terminal elsewhere.")}</span>} wide reset={["defaultView"]} resetAlso={{ changed: false, restore: forgetPaneViews }}>
          <Segmented label={t("Panes open in")} value={settings.defaultView} options={[{ value: "auto", label: t("Auto") }, { value: "chat", label: t("Chat") }, { value: "terminal", label: t("Terminal") }]} onChange={(defaultView) => {
            if (settings.defaultView === defaultView) return;
            // one choice for every pane: what each one remembered gives way to it
            forgetPaneViews();
            update({ defaultView });
          }} />
        </SettingsRow>
        {/* showThinking is every browser's, whether reasoning starts open (expandThinking) this device's */}
        <SettingsRow icon={Brain} label={t("Show thinking")} description={t("The agent's reasoning blocks: left out, folded to one line, or open. One you open or fold stays that way for its message.")} wide reset={["showThinking", "expandThinking"]}>
          <Segmented label={t("Show thinking")} value={!settings.showThinking ? "hidden" : settings.expandThinking ? "expanded" : "folded"} onChange={(shown) => update(shown === "hidden" ? { showThinking: false } : { showThinking: true, expandThinking: shown === "expanded" })} options={[{ value: "hidden", label: t("Hidden") }, { value: "folded", label: t("Folded") }, { value: "expanded", label: t("Expanded") }] as const} />
        </SettingsRow>
        <SettingsRow icon={MoveHorizontal} label={t("Chat width")} description={t("How wide the conversation and the message box run on a large screen")} wide reset={["chatWidth"]}>
          <Segmented label={t("Chat width")} value={settings.chatWidth} onChange={(chatWidth) => update({ chatWidth })} options={CHAT_WIDTHS.map((chatWidth) => ({ value: chatWidth, label: t(chatWidth === "narrow" ? "Narrow" : chatWidth === "wide" ? "Wide" : chatWidth === "full" ? "Full" : "Default") }))} />
        </SettingsRow>
        <SettingsRow icon={ListCollapse} label={t("Collapse work")} description={t("A turn's work starts folded to one line, also while the agent works, unless it needs you. One you open or fold stays that way for its message")} reset={["foldWork"]}>
          <Toggle label={t("Collapse work")} checked={settings.foldWork} onChange={(foldWork) => update({ foldWork })} />
        </SettingsRow>
      </SettingsGroup>

      <SettingsGroup title={t("Composer")} section="composer">
        <SettingsRow icon={CornerDownLeft} label={touch ? t("Return inserts a new line") : t("Enter sends")} description={touch ? t("When on, use Send or hardware Mod+Enter to send.") : t("When off, Mod+Enter sends")} reset={["enterSends"]}>
          <Toggle label={touch ? t("Return inserts a new line") : t("Enter sends")} checked={touch ? !enterSendsOn(settings, touch) : enterSendsOn(settings, touch)} onChange={(checked) => update({ enterSends: touch ? !checked : checked })} />
        </SettingsRow>
        {/* the message box's optional buttons and chips, each off by default; the suggestion chip is drawn on a touch screen only (Composer.tsx) */}
        <SettingsRow icon={TextCursorInput} label={t("Composer buttons")} wide reset={touch ? ["composerPasteSend", "composerArtifacts", "suggestionChip"] : ["composerPasteSend", "composerArtifacts"]}
          keywords={[t("Paste and send button"), t("A button in the empty message box sends the text copied on this device as a message."), t("Artifacts chip"), t("A chip in a Claude Code pane's message box lists the pages its session published with the Artifact tool."), ...(touch ? [t("Suggestion chip"), t("A chip above the message box puts the prompt Claude Code suggests next into the box. With a keyboard, Tab does it.")] : [])].join(" ")}>
          <span className="settings-chips">
            {chip(ClipboardPaste, t("Paste and send"), settings.composerPasteSend, (composerPasteSend) => update({ composerPasteSend }))}
            {chip(Layers, t("Artifacts (Claude Code)"), settings.composerArtifacts, (composerArtifacts) => update({ composerArtifacts }))}
            {touch && chip(Sparkles, t("Suggestion (Claude Code)"), settings.suggestionChip, (suggestionChip) => update({ suggestionChip }))}
          </span>
        </SettingsRow>
      </SettingsGroup>

      <SettingsGroup title={t("Quick replies")} section="quick-replies">
        {/* the row names what it shows (G-097); the palette still finds it by the old words, which the dictionary keeps for it */}
        <SettingsRow icon={MessageSquareReply} label={t("Show above the message box|quick replies switch")} keywords={t("Show above the message box")} description={t("One-tap messages above the message box, on this device. Each is sent as if typed: queued while the agent works, an answer when a question is open.")} reset={["showQuickReplies"]}>
          <Toggle label={t("Show above the message box|quick replies switch")} checked={settings.showQuickReplies} onChange={(showQuickReplies) => update({ showQuickReplies })} />
        </SettingsRow>
        {settings.showQuickReplies && <div className="settings-item">
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
                <button type="button" className="icon-button" aria-label={t("Remove quick reply {number}", { number: index + 1 })} title={t("Remove quick reply {number}", { number: index + 1 })} onClick={() => update({ quickReplies: settings.quickReplies.filter((_, at) => at !== index) })}>
                  <X aria-hidden="true" />
                </button>
              </li>
            ))}
          </ol>
          <div className="settings-actions">
            <button type="button" className="btn" disabled={settings.quickReplies.length >= QUICK_REPLIES_MAX} onClick={() => update({ quickReplies: [...settings.quickReplies, ""] })}><Plus aria-hidden="true" />{t("Add reply")}</button>
            <button type="button" className="btn btn-ghost" onClick={() => update({ quickReplies: [...DEFAULT_SETTINGS.quickReplies] })}>{t("Restore defaults")}</button>
          </div>
        </div>}
      </SettingsGroup>

      <SettingsGroup title={t("Files")} section="file-viewer">
        {/* a narrow screen cannot open a file beside the pane: the row says so, so the choice does not look ignored (G-097) */}
        <SettingsRow icon={PanelRight} label={t("Open files")} description={t("On a wide window, text and code can open beside the pane. Media, PDFs and folders always open in a popup, and the viewer's header button moves the file open now.")} condition={filePanelAvailable ? undefined : <span className="settings-condition">{t("Beside the pane needs a wide window; on this screen a file opens in a popup.")}</span>} wide reset={["fileOpen"]}>
          <Segmented label={t("Open files")} value={settings.fileOpen} onChange={(fileOpen) => update({ fileOpen })} options={FILE_OPEN_TARGETS.map((fileOpen) => ({ value: fileOpen, label: fileOpen === "panel" ? t("Beside the pane") : t("In a popup") }))} />
        </SettingsRow>
        <SettingsRow icon={Globe} label={t("Web links")} description={t(filePanelAvailable ? "Only a page this PC serves, such as a dev server on localhost, opens beside the pane. Shift-click opens it the other way." : "Pages this PC serves, such as Tailscale reports, can open in the app. Shift-click opens the other way.")} wide reset={["webLinks"]}>
          <Segmented label={t("Web links")} value={settings.webLinks} onChange={(webLinks) => update({ webLinks })} options={WEB_LINK_TARGETS.map((webLinks) => ({ value: webLinks, label: webLinks === "panel" ? t(filePanelAvailable ? "Beside the pane" : "In the app") : t("In a new tab") }))} />
        </SettingsRow>
      </SettingsGroup>

      <VoiceMain />

      <SettingsFold kind="more" keys={["autoSendQueued", "wrapCode", "editTextFiles", "reopenFileOnReturn", "filesPanel", "reuseExternalLinkTab", ...(settings.voiceInput === "off" ? [] : ["voiceLanguage", "voiceEngine", "voicePolishChat", "voicePolishTerminal"] as const)]}>
        <SettingsGroup title={t("Composer")} section="composer-more">
          <SettingsRow icon={Send} label={t("Send queued messages automatically")} description={t("A message sent while the agent works goes by itself when the turn ends. When off, it waits until you press Send now.")} reset={["autoSendQueued"]}>
            <Toggle label={t("Send queued messages automatically")} checked={settings.autoSendQueued} onChange={(autoSendQueued) => update({ autoSendQueued })} />
          </SettingsRow>
        </SettingsGroup>
        <SettingsGroup title={t("Files")} section="file-viewer-more">
          <SettingsRow icon={WrapText} label={t("Wrap long lines")} reset={["wrapCode"]} preview={<WrapPreview wrap={settings.wrapCode} />}>
            <Toggle label={t("Wrap long lines")} checked={settings.wrapCode} onChange={(wrapCode) => update({ wrapCode })} />
          </SettingsRow>
          <SettingsRow icon={FilePen} label={t("Edit text files")} description={t("Adds Edit to the file viewer for a text file in the pane's folder. Saving asks first, and stops if the file changed since you opened it.")} reset={["editTextFiles"]}>
            <Toggle label={t("Edit text files")} checked={settings.editTextFiles} onChange={(editTextFiles) => update({ editTextFiles })} />
          </SettingsRow>
          <SettingsRow icon={FileClock} label={t("Reopen files on return")} description={t("A file open when you switch to another tab shows again when you come back to that tab. Back to the tab shows it too.")} reset={["reopenFileOnReturn"]}>
            <Toggle label={t("Reopen files on return")} checked={settings.reopenFileOnReturn} onChange={(reopenFileOnReturn) => update({ reopenFileOnReturn })} />
          </SettingsRow>
          <FilesPanelRow />
          {canReuseExternalLinkTab() && <SettingsRow icon={ExternalLink} label={t("Reuse tab for external links")} description={t("External links reuse one browser tab instead of opening a new tab each time. The site in that tab can see and navigate this Ovis tab, so this is off by default.")} reset={["reuseExternalLinkTab"]}
            condition={<span className="settings-condition">{t("The site in that tab can see and navigate this Ovis tab.")}</span>}>
            <Toggle label={t("Reuse tab for external links")} checked={settings.reuseExternalLinkTab} onChange={(reuseExternalLinkTab) => update({ reuseExternalLinkTab })} />
          </SettingsRow>}
        </SettingsGroup>
        <VoiceMore />
      </SettingsFold>
    </SettingsBare.Provider>
  );
}

function TerminalPage({ keyBarButtonRef, onEditKeyBar, picturesByDefault }: { keyBarButtonRef: RefObject<HTMLButtonElement | null>; onEditKeyBar: () => void; picturesByDefault: boolean }) {
  const { settings, update } = useSettings();
  const t = useT();
  const searching = useContext(SettingsQuery).length > 0;
  const herdrWindow: HerdrWindowChoice = settings.followHerdrFocus ? "follow" : settings.releasePaneAway ? "alongside" : "separate";
  return (
    <SettingsBare.Provider value={true}>
    <SettingsGroup>
      <SettingsRow label={t("Terminal input mode")} icon={TextCursorInput} htmlFor="terminal-input-mode" reset={["terminalInputMode"]}>
        {/* "auto", the stored default, types straight into the grid on every device: it reads as Direct typing */}
        <SettingsSelect id="terminal-input-mode" value={settings.terminalInputMode === "line" ? "line" : "direct"} onChange={(event) => update({ terminalInputMode: event.target.value as "line" | "direct" })}>
          <option value="direct">{t("Direct typing")}</option><option value="line">{t("Input line")}</option>
        </SettingsSelect>
      </SettingsRow>
      <SettingsRow label={t("Wheel scroll speed")} icon={Mouse} reset={["terminalWheelSpeed"]}>
        <Stepper label={t("Wheel scroll speed")} value={settings.terminalWheelSpeed} text={`${settings.terminalWheelSpeed}×`} min={TERMINAL_WHEEL_SPEED_MIN} max={TERMINAL_WHEEL_SPEED_MAX} decreaseLabel={t("Slower wheel scrolling")} increaseLabel={t("Faster wheel scrolling")} onChange={(terminalWheelSpeed) => update({ terminalWheelSpeed })} />
      </SettingsRow>
      <SettingsRow label={t("Key bar")} icon={Keyboard} reset={["terminalKeyboardOnRequest", "terminalFoldKeyBar", "terminalAttachButton"]}>
        <button type="button" ref={keyBarButtonRef} className="btn" onClick={onEditKeyBar}>{t("Edit key bar")}</button>
      </SettingsRow>
      {/* the three choices fold two settings: each choice's effect is said on the row (G-095) */}
      <SettingsRow label={t("herdr window")} icon={AppWindow} wide reset={["releasePaneAway", "followHerdrFocus"]} keywords={`${t("Use alongside herdr's own window")} ${t("Follow herdr's focus")}`}
        condition={<span className="settings-condition">{t(HERDR_WINDOW_CHOICES[herdrWindow].descriptionKey)}</span>}>
        <Segmented<HerdrWindowChoice> label={t("herdr window")} value={herdrWindow} onChange={(choice) => {
          if (choice !== herdrWindow) {
            const { releasePaneAway, followHerdrFocus } = HERDR_WINDOW_CHOICES[choice];
            update({ releasePaneAway, followHerdrFocus });
          }
        }} options={[{ value: "separate", label: t("Separate") }, { value: "alongside", label: t("Use alongside") }, { value: "follow", label: t("Follow its focus") }]} />
      </SettingsRow>
    </SettingsGroup>
    {/* the key bar's own rows live in its editor; a search here still finds them */}
    {searching && <KeyBarToggles />}
    <SettingsFold kind="more" keys={["paneClipboard", "terminalImages"]}>
      <SettingsGroup section="terminal-more">
        <SettingsRow label={t("Clipboard from a pane")} icon={ClipboardCopy} reset={["paneClipboard"]}>
          <Toggle label={t("Clipboard from a pane")} checked={settings.paneClipboard} onChange={(paneClipboard) => update({ paneClipboard })} />
        </SettingsRow>
        <SettingsRow label={t("Show pictures in the terminal")} icon={ImageIcon} reset={["terminalImages"]}>
          <Toggle label={t("Show pictures in the terminal")} checked={settings.terminalImages ?? picturesByDefault} onChange={(terminalImages) => update({ terminalImages })} />
        </SettingsRow>
      </SettingsGroup>
    </SettingsFold>
    </SettingsBare.Provider>
  );
}

function AlertsPage({ onEnableNotifications, machines }: { onEnableNotifications: () => Promise<PushActionResult>; machines: readonly Machine[] }) {
  const { settings, update } = useSettings();
  const t = useT();
  const filters = useAlertFilters();
  // the Sound switch as last set: the preview waits for the audio, and must not play once it is off
  const alertSoundWanted = useRef(settings.alertSound);
  const permission = filters.permission ?? settings.alertInput;
  // herdr-app's rows: each a name and its control. Which alerts come is one decision, so one line of chips
  return (
    <SettingsBare.Provider value={true}>
    <SettingsGroup note={t("For this device. An alert waits a little first, and none comes when the pane changes meanwhile, as when you answer at the PC.")}>
      <PushTestControls onEnable={onEnableNotifications} />
      {/* the rows these chips replaced are still found by their words */}
      <SettingsRow label={t("Alert me when")} icon={Bell} wide
        resetAlso={{ changed: alertFiltersChanged(filters, settings.alertInput) > 0, restore: () => updateAlertFilters({ permission: undefined, error: undefined }) }}
        keywords={[t("Long turn finished"), t("Any turn finished"), t("Needs input"), t("An agent asks you something"), t("Needs permission"), t("An agent asks before it runs a command or changes a file. One that does not say so alerts as Needs input."), t("Finished"), t("Long turns: only work that took a minute or more"), t("Stopped on an error"), t("A turn that ended on an error, as OmO and GJC report it")].join(" ")}
        condition={<span className="settings-condition">{t("Long turns: only work that took a minute or more")} {t("Any turn finished takes in the long ones.")}</span>}
        reset={["alertInput", "alertDone"]}>
        <ChipToggles label={t("Alert me when")} chips={[
          { label: t("Needs input"), title: t("An agent asks you something"), icon: MessageCircleQuestionMark, on: settings.alertInput, onChange: (alertInput) => update({ alertInput }) },
          { label: t("Needs permission"), title: t("An agent asks before it runs a command or changes a file. One that does not say so alerts as Needs input."), icon: ShieldAlert, on: permission, onChange: (on) => updateAlertFilters({ permission: on }) },
          // the two Finished chips are the one setting's two levels, and every turn takes in the long ones:
          // Any on lights Long too, Any off keeps Long, Long off turns both off. The minute and the
          // inclusion are on the chips' tooltips and the row's line (G-096)
          { label: t("Long turn finished"), title: t("Long turns: only work that took a minute or more"), icon: Timer, on: settings.alertDone !== "off", onChange: (on) => update({ alertDone: on ? "long" : "off" }) },
          { label: t("Any turn finished"), title: t("Any turn finished takes in the long ones."), icon: CheckCheck, on: settings.alertDone === "always", onChange: (on) => update({ alertDone: on ? "always" : "long" }) },
          { label: t("Stopped on an error"), icon: OctagonX, on: filters.error === true, onChange: (error) => updateAlertFilters({ error }) },
        ]} />
      </SettingsRow>
      {/* a sighted reader sees where the chime plays, which the hidden sentence alone did not say (G-097) */}
      <SettingsRow label={t("Play sounds")} icon={Volume2} condition={<span className="settings-condition">{t("While a tab of the app is open, it chimes for these alerts, also when a Focus or Do Not Disturb silences notifications.")}</span>} reset={["alertSound"]}>
        <Toggle label={t("Play sounds")} checked={settings.alertSound} onChange={(alertSound) => {
          update({ alertSound });
          alertSoundWanted.current = alertSound;
          // this tap is the gesture the page needs to play audio; the chime is the preview,
          // unless the switch went off again while the audio was getting ready
          if (alertSound) void unlockAlertSound().then((ready) => { if (ready && alertSoundWanted.current) previewAlertSound(); });
        }} />
      </SettingsRow>
    </SettingsGroup>
    <AlertPcsGroup machines={machines} />
    {/* a destination's last failed post is said in its group, so the group stays in sight */}
    <AlertWebhookGroup />
    </SettingsBare.Provider>
  );
}

/** The switches still being shaped, on a page of their own as herdr-app and T3 Code keep them. */
function ExperimentalPage() {
  const { settings, update } = useSettings();
  const t = useT();
  return (
    <SettingsBare.Provider value={true}>
    {/* each row names what the reader gets, and one line says what changes: the long sentences stay for search (G-098) */}
    <SettingsGroup>
      <SettingsRow label={t("Named agent groups")} icon={Tags} description={t("Split the Agents list into groups you name, such as Agents, Replies or Tasks. New workspace and New tab offer them, and an agent's menu moves it. Every browser shares them.")} condition={<span className="settings-condition">{t("Groups you name in the Agents list, in every browser.")}</span>} reset={["agentNamedGroups"]}>
        <Toggle label={t("Named agent groups")} checked={settings.agentNamedGroups} onChange={(agentNamedGroups) => update({ agentNamedGroups })} />
      </SettingsRow>
      {settings.agentNamedGroups && <AgentGroupNames />}
      <SettingsRow label={t("Lock pinned agents")} icon={Lock} description={t("A pinned agent's menu in the Agents list offers Lock agent. This app then offers no way to close a locked agent's pane, tab or workspace, in every browser. Closing from herdr itself or a script still works.")} condition={<span className="settings-condition">{t("Each lock is turned on from the pinned agent's own menu.")}</span>} reset={["agentLocks"]}>
        <Toggle label={t("Lock pinned agents")} checked={settings.agentLocks} onChange={(agentLocks) => update({ agentLocks })} />
      </SettingsRow>
        <SettingsRow label={t("Codex panes: let Codex select and scroll")} icon={MousePointer2} reset={["codexDrag"]} description={t("On this device, a drag in a Codex pane goes to Codex, which selects through its whole history and scrolls it while the drag is held past the top or bottom edge. Ctrl+C or Enter copies it, but on herdr that copy does not reach this device's clipboard: Shift+drag (Option+drag on a Mac) still selects, copies and quotes in Ovis, up to the screen's edge.")} condition={<span className="settings-condition">{t("A drag in a Codex pane selects through its whole history; Shift+drag still copies in Ovis.")}</span>}>
          <Toggle label={t("Codex panes: let Codex select and scroll")} checked={settings.codexDrag} onChange={(codexDrag) => update({ codexDrag })} />
        </SettingsRow>
    </SettingsGroup>
    {/* one agent's own experiments, moved here from its row on Agents */}
    <SettingsGroup title={t("Agents")} section="experimental-agents" heading>
      <SettingsRow label={t("OMP: side conversations chip")} icon={MessagesSquare} description={t("A chip in an OMP pane's message box lists the side conversations its session saved with /btw.")} condition={<span className="settings-condition">{t("Opens the side conversations an OMP session saved with /btw.")}</span>} reset={["composerBtw"]}>
        <Toggle label={t("OMP: side conversations chip")} checked={settings.composerBtw} onChange={(composerBtw) => update({ composerBtw })} />
      </SettingsRow>
      <SettingsRow label={t("OpenCode: subagent ends from their session")} icon={Bot} description={t("An OpenCode subagent counts as running, and holds its turn's BG wait, until the session that started it is told it ended, not as soon as the subagent goes idle. Its own background work may still run then. When off, the subagent's own rows tell.")} condition={<span className="settings-condition">{t("A subagent counts as running until the session that started it is told it ended.")}</span>} reset={["opencodeParentEnds"]}>
        <Toggle label={t("OpenCode: subagent ends from their session")} checked={settings.opencodeParentEnds} onChange={(opencodeParentEnds) => update({ opencodeParentEnds })} />
      </SettingsRow>
      <SettingsRow label={t("OMP on macOS herdr-core: chat from the session it holds open")} icon={MessageSquare} description={t("On a Mac running herdr-core, an OMP pane's chat comes from the session file its omp holds open, read with lsof, so omp -c and resumed sessions show their chat. When off, the chat there falls back to the terminal.")} reset={["ompHeldFiles"]}>
        <Toggle label={t("OMP on macOS herdr-core: chat from the session it holds open")} checked={settings.ompHeldFiles} onChange={(ompHeldFiles) => update({ ompHeldFiles })} />
      </SettingsRow>
    </SettingsGroup>
    <SettingsGroup title={t("PCs")} section="experimental-pcs" heading>
      <SettingsRow label={t("Start a replaced server again")} icon={Server} description={t("When installing Ovis over SSH in place of one started by hand fails or is cancelled, start that one again as it was. When off, it stays stopped, as before.")} reset={["restoreReplacedServer"]}>
        <Toggle label={t("Start a replaced server again")} checked={settings.restoreReplacedServer} onChange={(restoreReplacedServer) => update({ restoreReplacedServer })} />
      </SettingsRow>
    </SettingsGroup>
    </SettingsBare.Provider>
  );
}

/**
 * Which PCs alert this device, the Host first: one turned off here sends it nothing, on any channel.
 * Shown with two PCs or more; kept by the PC's relay ID where it has one, else its name (shared/machines.ts
 * pcAlertKey), and a PC an earlier version turned off by name stays off until turned on again.
 */
function AlertPcsGroup({ machines }: { machines: readonly Machine[] }) {
  const t = useT();
  const { pcsOff } = useAlertFilters();
  if (machines.length < 2) return null;
  const listed = [...machines].sort((a, b) => Number(b.kind === "local") - Number(a.kind === "local"));
  return (
    <SettingsGroup title={t("Alerts from")} section="alert-pcs" heading>
      {listed.map((machine) => {
        const key = pcAlertKey(machine);
        return (
          <SettingsRow key={machine.id} label={machine.name} icon={Monitor}>
            <Toggle label={t("Alerts from {name}", { name: machine.name })} checked={!pcsOff.includes(key) && !pcsOff.includes(machine.name)}
              onChange={(on) => updateAlertFilters({ pcsOff: on ? pcsOff.filter((item) => item !== key && item !== machine.name) : [...pcsOff, key] })} />
          </SettingsRow>
        );
      })}
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

/** Settings → Chat → Voice input: whether the microphone button shows; the language it listens for is in Chat's folded part (VoiceMore). */
function VoiceMain() {
  const { settings, update } = useSettings();
  const t = useT();
  const [micDenied, setMicDenied] = useState(false);
  /**
   * On asks now, so the first dictation does not stop at the browser's permission prompt. Not in an
   * iPhone home-screen app, which this request closed or reloaded (#2343): there the first tap of the mic asks.
   */
  const chooseVoiceInput = async (voiceInput: VoiceButton) => {
    update({ voiceInput });
    setMicDenied(false);
    const homeScreenApp = (navigator as Navigator & { standalone?: boolean }).standalone === true;
    if (voiceInput !== "on" || homeScreenApp || !window.isSecureContext || !navigator.mediaDevices?.getUserMedia) return;
    try { (await navigator.mediaDevices.getUserMedia({ audio: true })).getTracks().forEach((track) => track.stop()); }
    catch { setMicDenied(true); }
  };
  const micProblem = settings.voiceInput === "off" ? null : !window.isSecureContext ? t("Voice input needs HTTPS") : micDenied ? t("Microphone permission was denied") : null;
  return (
    <SettingsGroup title={t("Voice input")} section="voice">
      {/* Auto's reach is said on the row, where the sentences are not (G-097) */}
      <SettingsRow icon={Mic} label={t("Microphone button")} description={t("Auto: in the chat on a desktop, where dictation can work. On: on a phone and in the terminal input line too.")} condition={micProblem !== null ? <span className="voice-error">{micProblem}</span> : <span className="settings-condition">{t("Auto: on a desktop's chat only, where dictation can work.")}</span>} wide>
        <Segmented label={t("Microphone button")} value={settings.voiceInput} onChange={(voiceInput) => void chooseVoiceInput(voiceInput)} options={VOICE_BUTTONS.map((voiceInput) => ({ value: voiceInput, label: t(voiceInput === "auto" ? "Auto" : voiceInput === "on" ? "On" : "Off") }))} />
      </SettingsRow>
    </SettingsGroup>
  );
}

/** Chat's folded part for voice input: the dictation language, the speech recognition, tidying dictated text, and the OpenAI key. */
function VoiceMore() {
  const { settings, update } = useSettings();
  const t = useT();
  // the server only says whether it holds a key; the key typed here lives in its field alone, read at
  // Save and cleared once saved, never in state (src/AGENTS.md, G-108). Save is offered once the field has text.
  const [voice, setVoice] = useState<VoiceStatus | null>(null);
  const voiceKeyRef = useRef<HTMLInputElement>(null);
  const [voiceKeyTyped, setVoiceKeyTyped] = useState(false);
  // the field drawn again (a search hid its group, then found it) comes back empty: Save waits for a key typed again
  const voiceKeyField = useCallback((field: HTMLInputElement | null) => {
    voiceKeyRef.current = field;
    return () => { voiceKeyRef.current = null; setVoiceKeyTyped(false); };
  }, []);
  const [voiceBusy, setVoiceBusy] = useState(false);
  const [voiceError, setVoiceError] = useState<string | null>(null);
  useEffect(() => { fetchVoiceStatus().then(setVoice, () => setVoice(null)); }, []);
  const changeVoiceKey = async (api_key: string | null) => {
    setVoiceBusy(true);
    try {
      // the save answers the new status itself: no second request that could fail after it
      const saved = await saveVoiceConfig({ api_key });
      if (voiceKeyRef.current) voiceKeyRef.current.value = "";
      setVoiceKeyTyped(false);
      setVoiceError(null);
      setVoice(saved);
      window.dispatchEvent(new Event(VOICE_CONFIG_EVENT));
    } catch (e) { setVoiceError(e instanceof Error ? e.message : String(e)); }
    finally { setVoiceBusy(false); }
  };
  return (
    <>
      {settings.voiceInput !== "off" && <>
        <SettingsGroup title={t("Voice input")} section="voice-more">
          <SettingsRow icon={Languages} label={t("Dictation language")} description={t("Auto listens for the app's language, or for the browser's when the app is not translated into it")} htmlFor="settings-voice-language" wide>
            <DictationLanguageSelect />
          </SettingsRow>
          <SettingsRow icon={AudioLines} label={t("Speech recognition")} description={<>{t(settings.voiceEngine === "auto" ? "Auto uses the API key when one is saved, else the browser" : settings.voiceEngine === "browser" ? "The browser recognizes the speech, even with a key saved" : "Only the API key below transcribes")}</>} condition={settings.voiceEngine === "server" && voice && !voice.configured ? <span className="voice-error">{t("Save an API key to use the mic")}</span> : undefined} wide>
            <Segmented label={t("Speech recognition")} value={settings.voiceEngine} onChange={(voiceEngine) => update({ voiceEngine })} options={VOICE_ENGINES.map((voiceEngine) => ({ value: voiceEngine, label: t(voiceEngine === "auto" ? "Auto" : voiceEngine === "browser" ? "Browser" : "API key") }))} />
          </SettingsRow>
        </SettingsGroup>
        {settings.voiceEngine !== "browser" && (
          <SettingsGroup section="tidy-dictation">
            <SettingsRow icon={WandSparkles} label={t("Tidy dictated text")} description={t("Drops fillers and fixes spacing; code and paths stay as spoken. Where it is off, the text stays exactly as transcribed.")} wide>
              <Segmented label={t("Tidy dictated text")} value={settings.voicePolishChat ? (settings.voicePolishTerminal ? "both" : "chat") : settings.voicePolishTerminal ? "terminal" : "off"} onChange={(where) => update({ voicePolishChat: where === "chat" || where === "both", voicePolishTerminal: where === "terminal" || where === "both" })} options={[{ value: "off", label: t("Off") }, { value: "chat", label: t("Chat") }, { value: "terminal", label: t("Terminal") }, { value: "both", label: t("Both") }] as const} />
            </SettingsRow>
          </SettingsGroup>
        )}
      </>}
      <SettingsGroup title={t("OpenAI API key")} section="openai-key">
        <div className="settings-item">
          {voice && (
            <p className="settings-label voice-status">
              {voice.configured ? t(voice.source === "env" ? "OpenAI key set by OVIS_OPENAI_API_KEY" : "OpenAI key saved on this PC") : t(settings.voiceEngine === "server" ? "No OpenAI key saved" : "No OpenAI key: the browser's speech recognition is used")}
            </p>
          )}
          {voice && voice.source !== "env" && (
            <form className="voice-key" onSubmit={(event) => { event.preventDefault(); const typed = voiceKeyRef.current?.value.trim() ?? ""; if (typed) void changeVoiceKey(typed); }}>
              <input
                ref={voiceKeyField}
                className="input voice-key-input"
                type="password"
                placeholder="sk-..."
                aria-label={t("OpenAI API key")}
                autoComplete="off"
                spellCheck={false}
                autoCapitalize="off"
                autoCorrect="off"
                onChange={(event) => setVoiceKeyTyped(event.target.value.trim() !== "")}
              />
              <button type="submit" className="btn voice-key-save" disabled={voiceBusy || !voiceKeyTyped}>{t("Save key")}</button>
              <button type="button" className="btn btn-ghost voice-key-remove" disabled={voiceBusy || !voice.configured} onClick={() => void changeVoiceKey(null)}>{t("Remove key")}</button>
            </form>
          )}
          {voiceError && <p className="settings-hint voice-error" role="alert">{voiceError}</p>}
          <p className="settings-hint voice-privacy">
            {settings.voiceEngine === "browser" || (voice && !voice.configured && settings.voiceEngine === "auto")
              ? t("Without a key the browser recognizes the speech: Chrome and Edge send the audio to Google or Microsoft. Nothing is recorded until you press the mic.")
              : t("Audio is sent to OpenAI with your key. Nothing is recorded until you press the mic.")}
          </p>
        </div>
      </SettingsGroup>
    </>
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
          const selectedRisk = exact ? exactChordRisk(exact, platformIsMac) : selectedKey !== undefined && isReservedShortcutKey(selectedKey, platformIsMac) ? "browser" : null;
          const confirming = pending?.id === shortcut.id ? pending : null;
          const defaultKeys = shortcutDisplayKeys(shortcut.id, {});
          const defaultKey = defaultKeys[defaultKeys.length - 1];
          const defaultReserved = defaultKey !== undefined && isReservedShortcutKey(defaultKey, platformIsMac);
          // a binding without a default key is off by default: its Default row reads Off, with no second Off
          const unbound = defaultKeys.length === 0;
          // a chord the browser or the terminal also uses says so on its row, a default one too: the list's
          // " — Reserved" alone did not say whose it is (G-112)
          const rowText = recording?.id === shortcut.id ? (recording.problem ?? t("Press the new shortcut, or Escape to cancel.")) : confirming ? riskText(confirming.risk, compactKeys(bindingDisplayKeys(confirming.value))) : selectedRisk ? riskText(selectedRisk, compactKeys(displayedKeys)) : undefined;
          const resetShortcut = (): void => {
            const next = { ...settings.shortcutOverrides };
            delete next[shortcut.id];
            update({ shortcutOverrides: next });
          };
          return (
            <SettingsRow key={shortcut.id} label={t(shortcut.label)} onReset={Object.hasOwn(settings.shortcutOverrides, shortcut.id) && !shortcutConflict(shortcut.id, shortcutKeys(shortcut.id, {}), settings.shortcutOverrides) ? resetShortcut : undefined} held={recording?.id === shortcut.id || confirming !== null} wide={!listedOnly(shortcut.id)} description={rowText === undefined ? undefined : <span role="status">{rowText}</span>}>
              {listedOnly(shortcut.id) ? <span className="settings-keys">{formatKeys(shortcut.keys).map((key) => <kbd className="kbd" key={key}>{key}</kbd>)}</span> : (
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
      <SettingsFold kind="more" keys={["herdrPrefixKeys"]}>
        <HerdrPrefixKeys />
      </SettingsFold>
    </>
  );
}

/** What each herdr action runs here (lib/herdrKeys.ts runHerdrAction), named as the app names it. */
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

/** The opt-in to herdr's prefix keys, and the bindings it read from this PC's herdr config while on. */
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
      <SettingsRow label={t("Use herdr's prefix keys")} icon={Command} description={t("herdr's prefix, then a key herdr's config.toml on this PC binds, runs that action here: the ones listed below. The prefix no longer reaches the pane: press it twice to send it. Fields, dialogs and IME input keep their keys.")}>
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
      {fact(t("This connection"), ingress === "direct" ? t("No proxy seen") : ingress === "proxy" ? t("Through a proxy") : ingress === "tailscale" ? t("Through Tailscale") : ingress === "funnel" ? t("Through Tailscale Funnel") : ingress === "relay" ? t("Through the Ovis relay") : ingress === "portal" ? t("Through Portal") : t("Unknown"),
        ingress === "direct" ? t("No proxy said it forwarded this browser's request. One that adds nothing, such as an SSH tunnel, looks the same.")
          : ingress === "relay" ? t("This browser's request came from a phone paired through the Ovis relay, end-to-end encrypted: the relay could not read it.")
          : t("How this browser's request arrived, not how every device reaches the server."))}
      {fact(t("Public internet"), summary.public_exposure === "observed" ? t("Reachable") : t("Unknown"),
        summary.public_exposure === "observed" ? t("This request came through Tailscale Funnel, which is open to the public internet.")
          : t("The server cannot see whether a proxy, tunnel or router makes it reachable from the internet."))}
    </SettingsGroup>
  );
}

/**
 * Groups of Devices and PCs that merged into My devices (Connect a device holds the ways in, Portal among them),
 * by their old link names (`?settings=devices&section=…`).
 */
const MOVED_GROUPS: Readonly<Record<string, string>> = { phone: "devices", remote: "devices", portal: "devices", "chat-more": "conversation" };

/**
 * What a paired device is, read from the label the app first gave it (lib/phone.ts deviceLabel, "iPhone · Safari");
 * a device renamed since says nothing of what it is, so its row carries no pill rather than a guess.
 */
function deviceKind(label: string, t: ReturnType<typeof useT>): string | null {
  const named = /^(iPhone|iPad|Android|Mac|Windows|Chromebook|Linux|Device)( · (Edge|Firefox|Chrome|Safari))?$/.exec(label);
  if (named === null) return null;
  if (named[1] === "iPhone" || named[1] === "Android") return t("Phone");
  if (named[1] === "iPad") return t("Tablet");
  return t("Browser");
}

/** a relay ID in groups of four, as KeyId draws it, on one line */
const groupedId = (id: string): string => id.match(/.{1,4}/g)?.join(" ") ?? id;

/**
 * Settings → Devices and PCs, as WhatsApp's Linked devices: the account on top, then one list of everything
 * that uses or joins this PC (this PC with its ID, the other PCs shown here and, signed in, the account's,
 * then the paired phones and browsers), with one Connect a device whose dialog holds every way in. What few
 * people change waits in More settings.
 */
function DevicesPage({ auth, security, onSignOut, onRevokedAll, machines, pcSettings, pcSettingsError, onPcSettings, openAddPc, connectPc }: {
  auth: HealthAuth | null; security: SecurityFacts; onSignOut: (() => Promise<void>) | null; onRevokedAll: () => void;
  machines: readonly Machine[]; pcSettings: MachineSettings | null; pcSettingsError: string | null; onPcSettings: (patch: Partial<MachineSettings>) => void; openAddPc: (preset?: AddPcPreset) => void; connectPc: (machine: Machine) => void;
}) {
  const { settings, update } = useSettings();
  const t = useT();
  const installPrompt = useInstallPrompt();
  // the iOS app (app/) holds this page: its way back to the app's list of PCs
  const nativeApp = inNativeApp();
  // the hosted shell (app.ovis.sh) shows one PC per page: its front page lists the others, and the
  // phone's key for this PC can be forgotten here (lib/relay/shell.tsx)
  const relayPc = shellMode() === "relay" ? serverIdOfPath(window.location.pathname) : null;
  const [confirmForget, setConfirmForget] = useState(false);
  // the server says what Tailscale on its PC already serves
  const [access, setAccess] = useState<RemoteAccess | null | undefined>(undefined);
  const loadAccess = useCallback(() => {
    setAccess(undefined);
    fetchRemoteAccess().then(setAccess, () => setAccess(null));
  }, []);
  useEffect(() => { loadAccess(); }, [loadAccess]);
  const plan = phonePlan({ protocol: window.location.protocol, hostname: window.location.hostname, origin: window.location.origin, secure: window.isSecureContext, shell: inRelayShell() }, access ?? null);
  // where a phone can open this app now, for the pairing QR code: the served address, else this one when it is not loopback
  const pairUrl = plan.kind === "here" || plan.kind === "served" ? plan.url : isLoopbackHost(window.location.hostname) ? null : window.location.origin;
  // what keeps the switch from working here, only while it does (lib/wakeLock.ts asks for the same two)
  const wakeLockProblem = !window.isSecureContext ? t("Needs HTTPS or localhost.") : !("wakeLock" in navigator) ? t("This browser can't keep the screen on.") : null;
  const relay = useRelay();
  const relayReadOnly = auth?.role === "watch" || auth?.via === "portal";
  const closesGate = security.state === "known" && security.summary.pairing_gate === "open" && !security.summary.token_configured;
  const [connecting, setConnecting] = useState(false);
  // each opening of Add a connection asks the account service again, so a service back from an outage signs in there,
  // and a sign-in its relay tab finished is read again
  const [accountChecks, setAccountChecks] = useState(0);
  const searching = useContext(SettingsQuery).length > 0;
  /** More settings' place for the device list's notes and Revoke every device (DevicesPanel `more`) */
  const [devicesMore, setDevicesMore] = useState<HTMLDivElement | null>(null);
  /** the end of this PC's own row, for the device list's Check now (DevicesPanel `checkSlot`) */
  const [devicesCheck, setDevicesCheck] = useState<HTMLDivElement | null>(null);
  const closeConnect = useCallback(() => setConnecting(false), []);
  // a reset relay identity is a new ID for this PC: My devices reads it again
  const [identityResets, setIdentityResets] = useState(0);
  // the account as AccountSection reads it: signed in or not, and the account's PCs for the list
  const [account, setAccount] = useState<AccountState>({ signedIn: false, account: null, pcs: null, reachable: true });
  // a new device joins by signing in only to a PC in the account this browser is signed in to (docs/account.md
  // "Joining through the account"): read again each time the dialog opens, since this PC may have joined meanwhile
  const [pcAccount, setPcAccount] = useState<string | null>(null);
  useEffect(() => {
    if (account.account === null) { setPcAccount(null); return; }
    let live = true;
    pcAccountStatus(apiFetch).then((status) => { if (live) setPcAccount(status.account); }, () => { if (live) setPcAccount(null); });
    return () => { live = false; };
  }, [account.account, connecting]);
  const joinBySignIn = account.account !== null && pcAccount === account.account && relay.status?.phase === "online";
  const openAccount = useCallback(() => {
    setConnecting(false);
    // the account's own group, at the top of this page: Add this PC is there
    const group = document.querySelector<HTMLElement>('.settings-dialog [data-section="account"]');
    // the account waits in More settings: opened first, so the sign-in shows
    const fold = group?.closest("details");
    if (fold) fold.open = true;
    group?.scrollIntoView({ block: "start" });
    group?.querySelector<HTMLElement>("button")?.focus();
  }, []);
  const accountService = accountServiceHere();
  const readAccountAgain = useCallback(() => setAccountChecks((count) => count + 1), []);
  // a touch phone on this PC's own address pairs itself through the relay in one tap: beside its own row
  const touchPhone = useMediaQuery("(pointer: coarse)");
  const selfRelay = touchPhone && relayOffered(relay) && relay.status?.phase === "online" && !relayReadOnly ? <UseRelayHere /> : null;
  return (
    <>
      {/* what is connected to this PC: its name atop one list of the other PCs, phones and browsers, the one in use first */}
      <SettingsGroup section="devices">
        <div className="settings-item my-devices">
          <MyPcRows machines={machines} accountPcs={account.pcs} watching={auth?.role === "watch"} relayKey={`${relay.status?.phase ?? ""}:${identityResets}`} selfAction={setDevicesCheck}>
            <DevicesPanel onDevicePaired={closeConnect} auth={auth} onRevokedAll={onRevokedAll} kindOf={(label) => deviceKind(label, t)} currentAction={selfRelay} more={devicesMore} checkSlot={devicesCheck} />
          </MyPcRows>
        </div>
        {/* how anything else gets connected: one button, its sheet picks the way; a search finds it as a row by every way it holds */}
        {searching ? (
          <SettingsRow label={t("Add a connection")} keywords={t("phone browser PC pair pairing code QR relay Tailscale Wi-Fi SSH Portal add PC remote PCs")}>
            <button type="button" className="btn btn-primary" onClick={() => { setConnecting(true); setAccountChecks((count) => count + 1); }}><Plus aria-hidden="true" />{t("Add a connection")}</button>
          </SettingsRow>
        ) : (
          <div className="settings-item devices-add">
            <button type="button" className="btn btn-primary" onClick={() => { setConnecting(true); setAccountChecks((count) => count + 1); }}><Plus aria-hidden="true" />{t("Add a connection")}</button>
          </div>
        )}
        <DamagedPcFiles pcSettings={pcSettings} />
      </SettingsGroup>

      <SettingsFold kind="more" keys={["keepScreenOn", "pcLoad"]}>
        {(nativeApp || relayPc !== null) && (
          <SettingsGroup title={t("This app")} section="this-app">
            {nativeApp && (
              <SettingsRow label={t("Change PC")} description={window.location.protocol === "capacitor:" ? t("This is the demo. Go back to the app's list of PCs to open yours.") : t("This app shows {address}. Go back to its list of PCs to open another.", { address: window.location.host })}>
                <button type="button" className="btn" onClick={() => void changePc()}>{t("Change PC")}</button>
              </SettingsRow>
            )}
            {relayPc !== null && (
              <>
                <SettingsRow label={t("Change PC")} description={t("This page shows one PC. The front page lists every PC this phone is paired with.")}>
                  <button type="button" className="btn" onClick={() => window.location.assign("/")}>{t("Change PC")}</button>
                </SettingsRow>
                <SettingsRow label={t("Forget this PC")} description={t("Deletes this phone's key for this PC. Pairing again takes a new QR code from the PC.")}>
                  <button type="button" className="btn" onClick={() => setConfirmForget(true)}>{t("Forget this PC")}</button>
                </SettingsRow>
                {confirmForget && (
                  <ConfirmDialog title={t("Forget this PC?")}
                    body={t("This phone's key for it is deleted here, and the PC keeps listing this phone until it is revoked there. Pairing again takes a new QR code from the PC.")}
                    confirmLabel={t("Forget")} onClose={() => setConfirmForget(false)}
                    onConfirm={async () => { await (await loadRelayShell()).forgetSavedPc(relayPc); window.location.assign("/"); }} />
                )}
              </>
            )}
          </SettingsGroup>
        )}

        <AccountSection onAccount={setAccount} recheck={accountChecks} />
        <SettingsGroup title={t("Devices and access")} section="devices-more">
          {/* in the hosted shell too (a phone reaching this PC through the relay or directly), there without the switch */}
          {(relayOffered(relay) || inRelayShell()) && <RelayDirectRow relay={relay} readOnly={relayReadOnly || inRelayShell()} />}
          <div className="settings-item" ref={setDevicesMore} />
          {onSignOut && <SignOutRow viaPortal={auth?.via === "portal"} oidc={auth?.portal?.method === "oidc"} onSignOut={onSignOut} label={t("Sign out of this PC")} />}
        </SettingsGroup>
        <SettingsGroup title={t("This device")} section="phone-more">
          <SettingsRow label={t("Keep screen on")} description={<>{t("While a terminal or chat pane is open.")}{wakeLockProblem !== null && <span className="settings-condition">{wakeLockProblem}</span>}</>}>
            <Toggle label={t("Keep screen on")} checked={settings.keepScreenOn} onChange={(keepScreenOn) => update({ keepScreenOn })} />
          </SettingsRow>
          {/* the steps where the browser holds no prompt (Safari has none): the only way to learn how to install */}
          <SettingsRow label={t("Install")} description={installPrompt.installed ? t("Installed") : installPrompt.canInstall ? undefined : installPrompt.help}>
            {!installPrompt.installed && installPrompt.canInstall && <button type="button" className="btn btn-primary" onClick={() => void installPrompt.install()}>{t("Install app")}</button>}
          </SettingsRow>
        </SettingsGroup>
        {relayOffered(relay) && !relayReadOnly && <RelayControls relay={relay} closesGate={closesGate} onReset={() => setIdentityResets((count) => count + 1)} />}
        <SidebarPcsGroup machines={machines} />
        <AccessFacts facts={security} />
        <RemotePcsMore machines={machines} pcSettings={pcSettings} pcSettingsError={pcSettingsError} onPcSettings={onPcSettings} />
      </SettingsFold>

      {connecting && (
        <ConnectPhoneDialog plan={plan} pairUrl={pairUrl}
          relay={relay} readOnly={relayReadOnly} closesGate={closesGate} canPair={auth?.via !== "portal"}
          signedIn={account.signedIn} joinBySignIn={joinBySignIn}
          account={accountService !== null && account.reachable ? { service: accountService, onOpen: openAccount, onSignedIn: readAccountAgain } : null}
          onAddPc={(preset) => { setConnecting(false); openAddPc(preset); }} machines={machines}
          onConnectMachine={(machine) => { setConnecting(false); connectPc(machine); }} onClose={closeConnect} />
      )}
    </>
  );
}

/** This phone through the relay, from its own row: its offer opens here as a QR code would on a phone that scanned it. */
function UseRelayHere() {
  const t = useT();
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <>
      <button type="button" className="btn" disabled={opening} title={t("Pairs this phone through the relay, so Ovis keeps working away from home.")} onClick={() => {
        setError(null);
        setOpening(true);
        requestRelayOffer().then((offer) => openOwnOffer(offer.url)).catch((reason: unknown) => setError(failureText(reason))).finally(() => setOpening(false));
      }}>{t("Use the relay")}</button>
      {error !== null && <span className="settings-hint relay-error" role="alert">{error}</span>}
    </>
  );
}

/** The relay's switch and its identity reset: rarely touched once it is on, so in More settings (Connect a device turns it on). */
function RelayControls({ relay, closesGate, onReset }: { relay: RelayState; closesGate: boolean; onReset: () => void }) {
  const t = useT();
  // the switch says what it does, not the service's name (G-140); the English name stays the one the scripts know
  const switchLabel = t("Ovis relay|relay switch");
  const { status, pending, request } = relay;
  const [error, setError] = useState<string | null>(null);
  const [confirmingReset, setConfirmingReset] = useState(false);
  const resetButton = useRef<HTMLButtonElement>(null);
  if (status === null) return null;
  const on = status.blocked === null && status.phase !== "off";
  const run = async (action: "start" | "stop") => {
    setError(null);
    try { await request(action); } catch (reason) { setError(failureText(reason)); }
  };
  return (
    <SettingsGroup title={t("Ovis relay")} section="relay">
      <SettingsRow label={switchLabel} keywords={t("Ovis relay")} description={statusText(t, status)}>
        {status.blocked === null && <Toggle label={switchLabel} checked={on} onChange={(next) => { if (!pending) void run(next ? "start" : "stop"); }} />}
      </SettingsRow>
      {closesGate && !on && status.blocked === null && <p className="settings-item settings-condition">{t("Turning on the relay closes the device gate: a new browser then needs a pairing code or the access token.")}</p>}
      {error !== null && <p className="settings-item settings-hint relay-error" role="alert">{error}</p>}
      {/* a serve-only install refuses the reset too; an unreadable identity is what the reset mends */}
      {status.blocked !== "serve_only" && (
        <SettingsRow label={t("Reset relay identity")}>
          <button ref={resetButton} type="button" className="btn" title={t("Reset relay identity")} disabled={pending} onClick={() => setConfirmingReset(true)}>{t("Reset")}</button>
        </SettingsRow>
      )}
      {confirmingReset && (
        <ConfirmDialog title={t("Reset the relay identity?")} body={t("Phones paired through the relay will need to scan a new code.")}
          confirmLabel={t("Reset")} onClose={() => setConfirmingReset(false)} onConfirm={async () => {
            await request("reset-identity");
            setConfirmingReset(false);
            onReset();
            // the confirmation hands focus back only when it is dismissed: after the reset it goes back here
            window.requestAnimationFrame(() => resetButton.current?.focus());
          }} />
      )}
    </SettingsGroup>
  );
}

/** a PC this app added (over SSH or the relay) that is not connected now: removable from the list; herdr's and herdr-core's own are managed there */
const removablePc = (machine: Machine): boolean => machine.state !== "connected" && machine.herdr_profile_id === undefined && (machine.kind === "ssh" || machine.kind === "relay");

/**
 * The PCs at the top of My devices: this PC with its relay ID (what a device that typed this PC's code compares,
 * AddRelayPc and the hosted app's code screen), the PCs this app shows (SSH, relay, herdr-core machines), and,
 * signed in, the account's other PCs. One PC is one row: an account PC this app already shows is not listed twice.
 * The ID is read again whenever the relay's state or identity changes (`relayKey`): turning the relay on can make
 * this PC's first ID, and a reset makes a new one, before the roster's next read would say so; a new ID in the roster
 * (a reset in another window) is read again too. Removing a PC stays
 * in the sidebar's PC menu, which moves the selection off it first and knows the PCs herdr manages.
 */
function MyPcRows({ machines, accountPcs, relayKey, watching, selfAction, children }: { machines: readonly Machine[]; accountPcs: readonly MyPc[] | null; relayKey: string;
  /** a watching device: the server refuses it the removal, so it is not offered */
  watching: boolean;
  /** takes the end of this PC's own row, where the device list puts its Check now */
  selfAction?: (slot: HTMLDivElement | null) => void;
  /** the paired phones and browsers, the one in use first: right under this PC, above the other PCs */
  children?: ReactNode }) {
  const t = useT();
  // a PC that is not connected, offered for removal from its own row (the sidebar's PC menu removes it too)
  const [removing, setRemoving] = useState<Machine | null>(null);
  const local = machines.find((machine) => machine.kind === "local");
  const [ownId, setOwnId] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    fetchMachines().then((list) => { if (live) setOwnId(list.find((machine) => machine.kind === "local")?.server_id ?? null); }, () => undefined);
    return () => { live = false; };
  }, [relayKey, local?.server_id]);
  const id = ownId ?? local?.server_id;
  const others = machines.filter((machine) => machine.kind !== "local");
  const shown = new Set<string>([id, local?.server_id, ...others.map((machine) => machine.server_id ?? machine.relay?.server_id)].filter((id): id is string => id !== undefined));
  const fromAccount = (accountPcs ?? []).filter((pc) => !shown.has(pc.server_id));
  return (
    <>
    {local !== undefined && (
      <ul className="devices-list my-pc-self">
        <li className="devices-row my-device-self" data-testid="this-pc">
          <div className="devices-name">
            <span className="settings-label">{local.name}<span className="devices-kind is-self">{t("This PC")}</span></span>
            {id !== undefined && <span className="settings-description my-device-id">{t("ID {id}", { id: groupedId(id) })}</span>}
          </div>
          <div className="devices-actions my-device-check" ref={selfAction} />
        </li>
      </ul>
    )}
    {children}
    <ul className="devices-list my-pcs">
      {others.map((machine) => (
        <li key={machine.id} className={machine.state === "connected" ? "devices-row" : "devices-row is-away"}>
          <div className="devices-name">
            <span className="settings-label">{machine.name}<span className="devices-kind">PC</span></span>
            <span className="settings-description">{t(STATE_WORD[machine.state])}</span>
          </div>
          {!watching && removablePc(machine) && (
            <div className="devices-actions">
              <button type="button" className="icon-button" aria-label={t("Remove PC {name}", { name: machine.name })} title={t("Remove PC {name}", { name: machine.name })} onClick={() => setRemoving(machine)}><Trash2 aria-hidden="true" /></button>
            </div>
          )}
        </li>
      ))}
      {fromAccount.map((pc) => (
        <li key={pc.server_id} className={pc.state === "paired" || pc.state === "needs-approval" ? "devices-row" : "devices-row is-away"} data-pc-state={pc.state}>
          <div className="devices-name">
            <span className="settings-label">{pc.name}<span className="devices-kind">PC</span></span>
            <span className="settings-description">{listedPcStateText(pc, t)}</span>
          </div>
        </li>
      ))}
    </ul>
    {removing !== null && <ConfirmDialog title={t("Remove PC {name}?", { name: removing.name })} body={t(removing.kind === "relay" ? "Removes this PC here. To end its access too, revoke it under Phone & devices on that PC." : "Removes this registration. Remote sessions keep running.")} confirmLabel={t("Remove PC")}
      onConfirm={async () => { await machineRequest(`/${encodeURIComponent(removing.id)}`, "DELETE"); setRemoving(null); }} onClose={() => setRemoving(null)} />}
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

/** A crash can leave the saved PCs unreadable: the server set the file aside and started without them. */
function DamagedPcFiles({ pcSettings }: { pcSettings: MachineSettings | null }) {
  const t = useT();
  // machines.json held the PCs added here; herdr-profile-state.json only the permission to connect to herdr's own
  return (
    <>
      {pcSettings?.set_aside?.some(heldAddedPcs) && <p className="settings-item settings-hint">
        {t("Saved PC data was damaged and could not be read when the app started. It was set aside as {files}; add any missing PC again.", { files: pcSettings.set_aside.filter(heldAddedPcs).join(", ") })}
      </p>}
      {pcSettings?.set_aside?.some((name) => !heldAddedPcs(name)) && <p className="settings-item settings-hint">
        {t("The permission to connect to the PCs saved in herdr was damaged and could not be read when the app started. It was set aside as {files}; choose Connect on those PCs again.", { files: pcSettings.set_aside.filter((name) => !heldAddedPcs(name)).join(", ") })}
      </p>}
    </>
  );
}

/** The PCs' rarely changed rows, in the page's More settings fold: the server's bridge updates and the load line. */
function RemotePcsMore({ machines, pcSettings, pcSettingsError, onPcSettings }: { machines: readonly Machine[]; pcSettings: MachineSettings | null; pcSettingsError: string | null; onPcSettings: (patch: Partial<MachineSettings>) => void }) {
  const t = useT();
  return (
    <SettingsGroup section="remote-more">
      {/* the switch is the server's and waits for its answer; Add PC never does */}
      {pcSettings && (
        <SettingsRow label={t("Update PC bridges automatically")} description={t("When an app update needs a newer bridge, PCs that connect with their saved key are updated in the background. PCs that need a password ask first.")}>
          <Toggle label={t("Update PC bridges automatically")} checked={pcSettings.auto_update_bridges} onChange={(auto_update_bridges) => onPcSettings({ auto_update_bridges })} />
        </SettingsRow>
      )}
      {/* a refused change of the switch above, beside it: in a search too */}
      {pcSettingsError && <p className="settings-item settings-hint" role="alert">{pcSettingsError}</p>}
      <PcLoadSetting machines={machines} />
    </SettingsGroup>
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
  const bare = useContext(SettingsBare);
  if (plugins.length === 0) return null;
  // one line: the plugins by name, a disabled one marked
  if (bare) return (
    <SettingsGroup className="settings-plugins">
      <SettingsRow label={t("herdr plugins")} icon={Puzzle}>
        <span className="settings-fact">{plugins.map((plugin) => `${plugin.name} ${plugin.version}${plugin.enabled ? "" : ` (${t("Disabled")})`}`).join(", ")}</span>
      </SettingsRow>
    </SettingsGroup>
  );
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

/**
 * Which runtime this PC's terminals come from, and the switch between herdr's TUI and the Herdr
 * app when this PC has both and nothing else decides it. A switch asks first, saves the choice and
 * restarts Ovis on it; once a new server answers, the app reads it again in place (no reload). Where the switch cannot run,
 * one quiet line says why, or how to switch by hand. The move of the whole herdr session to herdr-core
 * (RuntimeMove) is one more row, whose dialog outlives the restart its own switch starts.
 */
function RuntimeFacts({ version, runtime, core, facts: healthFacts, bootId, onServerRestarted, onOpenPane }: { version: string | null; runtime: "herdr" | "herdr-core" | null; core: HerdrCoreFacts | null; facts: HerdrRuntimeFacts | null; bootId: string | null; onServerRestarted?: () => void; onOpenPane: (machineId: string, paneId: string) => void }) {
  const t = useT();
  const [confirming, setConfirming] = useState(false);
  // the wait for the restarted server outlives this page of Settings (lib/runtimeSwitch.ts)
  const restarting = useSyncExternalStore(subscribeRestart, restartState);
  // the bridge's own answer needs no herdr: with herdr's TUI stopped it still says what to switch back to
  const [bridgeFacts, setBridgeFacts] = useState<HerdrRuntimeFacts | null>(null);
  useEffect(() => {
    if (restarting !== null) return;
    let live = true;
    // unanswered: the whole health answer's facts stand, as they did before this read. Read again while
    // About is open: the server's first look for hc may end later, and with herdr stopped nothing else tells
    const read = () => fetchBridgeHealth().then((health) => { if (live) setBridgeFacts(health.herdr_runtime ?? null); }, () => {});
    void read();
    const timer = setInterval(() => void read(), 10_000);
    return () => { live = false; clearInterval(timer); };
  }, [restarting, bootId]);
  const facts = bridgeFacts ?? healthFacts;
  // the runtime the bridge serves now; the last health answer's version only when it was about that runtime
  const served = facts?.serving ?? runtime;
  const known = served === runtime ? version : null;
  // the move's row goes with the rows while the page waits for the restarted server; its dialog stays:
  // the key keeps the one element across both lists below
  const move = <RuntimeMove key="move" bootId={bootId} hidden={restarting !== null} onServerRestarted={onServerRestarted} onOpenPane={onOpenPane} />;
  if (restarting !== null) {
    return (
      <SettingsGroup title={t("Terminals")} section="runtime">
        <p className="settings-item settings-hint" role="status">{restarting.lost ? t("Ovis has not answered since the restart. Reload this page in a moment; if it stays away, start Ovis again on this PC.")
          : restarting.to === "herdr-core" ? t("Restarting Ovis on the Herdr app…") : t("Restarting Ovis on herdr TUI…")}</p>
        {move}
      </SettingsGroup>
    );
  }
  if (served === null || (known === null && facts === null)) return null;
  const onCore = served === "herdr-core";
  const target = facts?.switch_to ?? null;
  // under the fact, not beside it: the fact keeps its one line on a phone
  const hint = facts?.fallback === "no_herdr_core" ? t("The Herdr app was chosen here, but no herdr-core answered, so herdr TUI is shown.")
    : facts?.locked === "env" ? t("OVIS_RUNTIME in Ovis's environment decides which terminals this PC shows; change it there to switch.")
    // where the OS does not serve herdr-core, setting OVIS_RUNTIME=herdr-core would stop Ovis: no how-to
    : target !== null || onCore || !core?.version || facts?.locked === "platform" ? null
    // what it switches, in one line; the steps are in the guide (G-101)
    : <span>{t("The Herdr app's core (hc {version}) is on this PC too. Ovis can show its terminals instead of herdr's.", { version: core.version })} <a className="settings-link" href={RUNTIME_HELP} target="_blank" rel="noreferrer">{t("How to switch")}</a></span>;
  const toCore = target === "herdr-core";
  // what this PC's server reports, never guessed: the runtime it serves with its version, then the
  // others it found installed. With two installed the choice between them is right on the first line.
  const coreInstalled = core?.version != null;
  const tuiInstalled = facts?.tui.installed ?? !onCore;
  const name = (runtime: "herdr" | "herdr-core") => (runtime === "herdr-core" ? "herdr-core" : "herdr");
  const versionOf = (runtime: "herdr" | "herdr-core") => (runtime === served ? known ?? (onCore ? core?.version ?? null : null) : runtime === "herdr-core" ? core?.version ?? null : null);
  const titled = (runtime: "herdr" | "herdr-core") => [name(runtime), versionOf(runtime)].filter(Boolean).join(" ");
  // the switch names both runtimes with their versions; another one installed gets its own line only when there is no switch
  const others = (["herdr", "herdr-core"] as const).filter((runtime) => runtime !== served && runtime !== target && (runtime === "herdr-core" ? coreInstalled : tuiInstalled));
  return (
    <SettingsGroup title={t("Terminals")} section="runtime">
      <SettingsRow label={t("In use")} icon={SquareTerminal} wide={target !== null}
        condition={!onCore && facts?.tui.running === false ? <span className="settings-hint">{t("herdr's TUI server is not running.")}</span> : undefined}>
        {target !== null
          ? <Segmented label={t("In use")} value={served} onChange={(runtime) => { if (runtime === target) setConfirming(true); }}
            options={[served, target].sort().map((runtime) => ({ value: runtime, label: titled(runtime) }))} />
          : <span className="settings-fact">{titled(served)}</span>}
      </SettingsRow>
      {others.map((runtime) => (
        <SettingsRow key={runtime} label={name(runtime)} icon={Box}>
          <span className="settings-fact">{versionOf(runtime) ?? t("Installed")}</span>
        </SettingsRow>
      ))}
      {hint && <p className="settings-item settings-hint">{hint}</p>}
      {move}
      {confirming && target !== null && (
        <ConfirmDialog
          title={toCore ? t("Show the Herdr app's terminals?") : t("Show herdr TUI's terminals?")}
          body={toCore
            ? t("Ovis restarts and shows the Herdr app's terminals instead of herdr TUI's; this page reconnects by itself. herdr's panes keep running.")
            : `${t("Ovis restarts and shows herdr TUI's terminals instead of the Herdr app's; this page reconnects by itself. The app's terminals keep running.")}${facts?.tui.running === false ? ` ${t("herdr's TUI server is not running: start herdr after the switch.")}` : ""}`}
          confirmLabel={t("Switch and restart")}
          onConfirm={async () => {
            // the bridge answering now (its boot id needs no herdr): any other one after the switch is the restarted server
            const from = await fetchBridgeHealth().then((health) => health.web_ui?.boot_id ?? bootId, () => bootId);
            await switchRuntime(target);
            // this PC's panes come from the other runtime next, which may be one the page drew before
            paneLifetimes.runtimeSwitched(LOCAL_MACHINE);
            setConfirming(false);
            awaitRestart(target, {
              from,
              // the bridge's own answer needs no herdr, and says whether the launcher took it as its own
              boot: () => fetchBridgeHealth().then((health) => health.web_ui ? { id: health.web_ui.boot_id, accepted: health.accepted === true } : null),
              onBack: () => { paneLifetimes.runtimeSwitched(LOCAL_MACHINE); onServerRestarted?.(); },
            });
          }}
          onClose={() => setConfirming(false)}
        />
      )}
    </SettingsGroup>
  );
}

function AboutPage({ updates, herdrVersion, herdrRuntime, herdrCore, herdrRuntimeFacts, bootId, onServerRestarted, onOpenPane, bridgesFollow }: { updates: UpdatesModel; herdrVersion: string | null; herdrRuntime: "herdr" | "herdr-core" | null; herdrCore: HerdrCoreFacts | null; herdrRuntimeFacts: HerdrRuntimeFacts | null; bootId: string | null; onServerRestarted?: () => void; onOpenPane: (machineId: string, paneId: string) => void; bridgesFollow: boolean }) {
  const t = useT();
  // herdr-app's About: each line a name and its value or action, no group captions or sentences
  return (
    <SettingsBare.Provider value={true}>
      {/* the facts read as one list, as herdr-app's About */}
      <div className="settings-joined">
      <RuntimeFacts version={herdrVersion} runtime={herdrRuntime} core={herdrCore} facts={herdrRuntimeFacts} bootId={bootId} onServerRestarted={onServerRestarted} onOpenPane={onOpenPane} />
      <UpdateControls updates={updates} bridgesFollow={bridgesFollow} />
      {/* herdr's own version and update: on herdr-core there is no herdr TUI here, and Terminals names the core */}
      {herdrRuntime !== "herdr-core" && <HerdrUpdateControls enabled herdrVersion={herdrVersion} showVersion={(herdrRuntimeFacts?.serving ?? herdrRuntime) === null} />}
      <PluginsGroup />
      <TelemetryControls />
      </div>
      <SettingsGroup title={t("About")} className="settings-about" section="about">
        <div className="settings-row">
          <div className="settings-row-text">
            <span className="settings-label-line"><Globe className="settings-row-icon" aria-hidden="true" /><a className="settings-link" href="https://ovis.sh/" target="_blank" rel="noreferrer">ovis.sh</a></span>
          </div>
          <a className="btn" href="https://github.com/devswha/ovis" target="_blank" rel="noreferrer"><Star aria-hidden="true" />{t("Star on GitHub")}</a>
        </div>
      </SettingsGroup>
    </SettingsBare.Provider>
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

/**
 * The groups a search result page shows a matched row in, their `data-section` names: a group that
 * holds every word of the query first, so the page lands on the row the words name, then the rest
 * in page order. A group drawn with no row of its own (its rows all filtered out) is not one.
 */
function matchedGroups(result: Element | null, words: readonly string[]): string[] {
  if (!result) return [];
  const groups = [...result.querySelectorAll<HTMLElement>("[data-section]")].filter((group) => group.querySelector(".settings-row, .settings-item") !== null);
  const holdsAll = (group: HTMLElement) => { const text = (group.textContent ?? "").toLowerCase(); return words.every((word) => text.includes(word.toLowerCase())); };
  return [...groups.filter(holdsAll), ...groups.filter((group) => !holdsAll(group))].map((group) => group.dataset["section"]).filter((name): name is string => name !== undefined);
}

function OpenSettingsDialog({ section = null, linkPage = null, linkSection = null, onPage, onClose, onUsageLogin, onOpenPane, actions, updates, auth, herdrVersion, herdrRuntime = null, herdrCore = null, herdrRuntimeFacts = null, picturesByDefault = false, bootId = null, onServerRestarted, security, onEnableNotifications, saveError, savePaused, saveRetrying, onRetrySave, overPreview = false, machines = [] }: SettingsDialogProps) {
  const t = useT();
  const narrow = useNarrow();
  // opened by Forward, the dialog shows what that entry of the history showed
  const [restored] = useState(() => shownBy(settingsEntry(window.history.state)));
  // a phone opens on the list of pages; a wider dialog shows the list beside the first page. A
  // button that points at Updates opens on About whatever an entry still landing would restore
  const linked = PAGES.find((candidate) => candidate.id === currentSettingsPage(linkPage))?.id ?? null;
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
  // the group a landing named that was not drawn yet, waited for until the reader moves the page
  const awaited = useRef<{ named: string; page: SettingsPage | null } | null>(null);
  const label = (id: SettingsPage): string => t(id === "appearance" ? "Appearance" : id === "chat" ? "Chat" : id === "terminal" ? "Terminal" : id === "alerts" ? "Alerts" : id === "agents" ? "Agents" : id === "shortcuts" ? "Shortcuts" : id === "devices" ? "Devices and PCs" : id === "experimental" ? "Experimental" : "About");
  const openPage = (id: SettingsPage): void => { setKeyBarOpen(false); setChosen(id); };
  // Settings' search: every page's rows that hold all the words typed, each where it can be changed
  // at once, under its page's name, as Zed's and VS Code's settings searches show them
  const [query, setQuery] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  const words = useMemo(() => settingsQueryWords(query), [query]);
  const searching = words.length > 0 && !keyBarOpen && (!narrow || page === null);
  // where a search result leads: the page, and the groups that matched on it. The page opens every
  // fold that holds one, scrolls the first into view and puts the focus on it, so no row found hides
  // again and the focus does not fall to the body (G-110)
  const landing = useRef<{ page: SettingsPage; sections: string[] } | null>(null);
  const openFromSearch = (id: SettingsPage, groups: string[] = []): void => {
    // a press on the page already open changes nothing to land: a landing kept for it would take a later Back's focus
    if (id === page && !searching && !keyBarOpen) return;
    landing.current = { page: id, sections: groups }; setQuery(""); openPage(id);
  };
  const openKeyBar = (): void => {
    settingsScrollRef.current = settingsBodyRef.current?.scrollTop ?? 0;
    // from a search, the editor opens over its own page, so Back steps out to that page as from there
    if (query !== "") {
      setQuery("");
      setChosen("terminal");
      settingsScrollRef.current = 0;
    }
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
    const landed = landing.current;
    if (keyBarOpen) backRef.current?.focus();
    else if (!searching && landed !== null && landed.page === page) {
      landing.current = null;
      const groups = landed.sections.map((name) => settingsBodyRef.current?.querySelector<HTMLElement>(`[data-section="${CSS.escape(name)}"]`) ?? null).filter((group): group is HTMLElement => group !== null);
      for (const group of groups) openFolds(group);
      const first = groups[0];
      if (first) {
        first.focus({ preventScroll: true });
        first.scrollIntoView({ block: "start" });
        following.current = { group: first, page };
      } else {
        if (narrow) backRef.current?.focus();
        else tab(page)?.focus();
        // a group drawn only once the server answers (Also send to) is landed on when it comes
        const named = landed.sections[0];
        if (named !== undefined) awaited.current = { named, page };
      }
    } else if (before?.keyBar && before.page === page) {
      if (settingsBodyRef.current) settingsBodyRef.current.scrollTop = settingsScrollRef.current;
      keyBarButtonRef.current?.focus({ preventScroll: true });
    } else if (before === null) {
      // a button that points at Updates opens on it, and the focus goes there too; so does a link
      // to a group, and a group the palette named
      const asName = section === "updates" ? "updates" : asked?.section ?? (linked && linkSection ? linkSection : null);
      // a group that moved keeps its old links: they land where its rows went
      const named = asName === null ? null : MOVED_GROUPS[asName] ?? asName;
      const pointed = named ? settingsBodyRef.current?.querySelector<HTMLElement>(`[data-section="${CSS.escape(named)}"]`) : null;
      if (pointed) {
        openFolds(pointed);
        pointed.focus({ preventScroll: true });
        pointed.scrollIntoView();
        following.current = { group: pointed, page };
      } else {
        tab(page)?.focus();
        // a group drawn only once the server answers (Anonymous usage counts) is landed on when it comes
        if (named) awaited.current = { named, page };
      }
    } else if (before.page !== page && narrow) {
      // a phone shows one of the two: the focus follows into the page, and back onto its row
      if (page !== null) backRef.current?.focus();
      else tab(before.page)?.focus();
    }
    // a group filled in after it opens (the OpenAI key's form waits for the server's answer) grows
    // past the fold: it is brought back into view until the reader moves the page or leaves it.
    // The subscription is made again whenever this runs, so development's replay of the effect
    // keeps following; the reader's move or another page ends it for good
    const body = settingsBodyRef.current;
    const wait = awaited.current;
    if (wait !== null && (wait.page !== page || keyBarOpen)) awaited.current = null;
    else if (wait !== null && body) {
      const moves = ["wheel", "touchstart", "pointerdown", "keydown"] as const;
      const unsubscribe = (): void => {
        observer.disconnect();
        for (const move of moves) body.removeEventListener(move, stop);
      };
      const stop = (): void => { awaited.current = null; unsubscribe(); };
      const observer = new MutationObserver(() => {
        const group = body.querySelector<HTMLElement>(`[data-section="${CSS.escape(wait.named)}"]`);
        if (!group) return;
        stop();
        openFolds(group);
        group.focus({ preventScroll: true });
        group.scrollIntoView();
      });
      observer.observe(body, { childList: true, subtree: true });
      for (const move of moves) body.addEventListener(move, stop, { passive: true });
      return unsubscribe;
    }
    const follow = following.current;
    if (follow === null || follow.page !== page || keyBarOpen) { following.current = null; return; }
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
  }, [page, keyBarOpen, narrow, section, searching]);
  // server-side: the web server updates PC bridges, so it keeps this choice
  const [pcSettings, setPcSettings] = useState<MachineSettings | null>(null);
  const [pcSettingsError, setPcSettingsError] = useState<string | null>(null);
  // asked when a page that shows them opens, so a request that failed earlier is made again
  useEffect(() => {
    if (page !== "devices" && page !== "about" && !searching) return;
    let live = true;
    machineRequest<MachineSettings>("/settings").then((settings) => { if (live) setPcSettings(settings); }, () => { if (live) setPcSettings(null); });
    return () => { live = false; };
  }, [page, searching]);
  const updatePcSettings = async (patch: Partial<MachineSettings>) => {
    try { setPcSettings(await machineRequest<MachineSettings>("/settings", "PATCH", patch)); setPcSettingsError(null); }
    catch (e) { setPcSettingsError(e instanceof Error ? e.message : String(e)); }
  };

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent): void => {
      // an Escape that cancels an IME composition (the editor's Character field) is the IME's, and one that
      // closed Files drawn over Settings (focused by a click) is spent: one Escape closes one dialog
      if (event.key !== "Escape" || event.isComposing || event.keyCode === 229 || event.defaultPrevented) return;
      // Files opened from the palette over Settings holds the focus: its Escape, though this listener runs first.
      // A preview under Settings (a file opened from that Files) waits for Settings to close, focused or not
      if (!overPreview && focusInOtherModal(surface.current)) return;
      event.preventDefault();
      // out of the key bar editor first, then out of a search, wherever the focus is in it; from
      // any page, a phone's included, it closes the dialog
      if (keyBarOpen) setKeyBarOpen(false);
      else if (query !== "") {
        setQuery("");
        // the result that held the focus goes with the search: the field keeps it
        searchRef.current?.focus();
      } else onClose();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [onClose, keyBarOpen, overPreview, query]);

  /** the list is one Tab stop: the arrows walk it, and beside an open page they turn the page too */
  const onTabKey = (event: ReactKeyboardEvent<HTMLButtonElement>, index: number): void => {
    const to = event.key === "ArrowDown" ? index + 1 : event.key === "ArrowUp" ? index - 1 : event.key === "Home" ? 0 : event.key === "End" ? PAGES.length - 1 : null;
    if (to === null) return;
    event.preventDefault();
    const next = PAGES[(to + PAGES.length) % PAGES.length]!.id;
    tab(next)?.focus();
    if (!narrow) openFromSearch(next);
  };

  const body = (page: SettingsPage): ReactNode => {
    switch (page) {
      case "appearance": return <AppearancePage />;
      case "chat": return <ChatPage />;
      case "terminal": return <TerminalPage keyBarButtonRef={keyBarButtonRef} onEditKeyBar={openKeyBar} picturesByDefault={picturesByDefault} />;
      case "alerts": return <AlertsPage onEnableNotifications={onEnableNotifications} machines={machines} />;
      case "agents": return <AgentsSettings watching={auth?.role === "watch"} onLocalLogin={onUsageLogin} onOpenPane={onOpenPane} onOpenGuide={onClose} />;
      case "shortcuts": return <ShortcutsPage />;
      // after every device went, its own pairing included, a browser asks the server where it stands: the roster answers, or the gate does
      case "devices": return <DevicesPage auth={auth} security={security} onSignOut={actions.lock} onRevokedAll={actions.refresh} openAddPc={actions.openAddPc} connectPc={actions.connectPc}
        machines={machines} pcSettings={pcSettings} pcSettingsError={pcSettingsError} onPcSettings={(patch) => void updatePcSettings(patch)} />;
      case "experimental": return <ExperimentalPage />;
      case "about": return <AboutPage updates={updates} herdrVersion={herdrVersion} herdrRuntime={herdrRuntime} herdrCore={herdrCore} herdrRuntimeFacts={herdrRuntimeFacts} bootId={bootId} onServerRestarted={onServerRestarted} onOpenPane={onOpenPane} bridgesFollow={pcSettings?.auto_update_bridges === true} />;
      default: return null;
    }
  };
  const listShown = !narrow || (page === null && !keyBarOpen);
  const focusable = page ?? PAGES[0]!.id;

  return (
    <div className={overPreview ? "modal-scrim settings-over-preview" : "modal-scrim"} onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      {/* named Settings on every page: the page's own name is the visible title */}
      <section ref={surface} className={searching ? "modal settings-dialog is-searching" : "modal settings-dialog"} role="dialog" aria-modal="true" aria-label={keyBarOpen ? t("Key bar") : t("Settings")} tabIndex={-1}>
        <header className="modal-header settings-header">
          {(keyBarOpen || (narrow && page !== null)) && <button type="button" ref={backRef} className="icon-button" aria-label={t("Back to settings")} title={t("Back to settings")} onClick={goBack}><ArrowLeft aria-hidden="true" /></button>}
          <h2 className="modal-title">{keyBarOpen ? t("Key bar") : searching && !narrow ? t("Search results") : page === null ? t("Settings") : label(page)}</h2>
          <button type="button" className="icon-button" aria-label={t("Close settings")} title={t("Close settings")} onClick={onClose}><X aria-hidden="true" /></button>
        </header>
        {listShown && (
          <nav className="settings-nav" aria-label={t("Settings")}>
            <p className="settings-nav-title" aria-hidden="true">{t("Settings")}</p>
            <div className="settings-search">
              <Search aria-hidden="true" />
              <input
                ref={searchRef}
                type="search"
                className="input settings-search-input"
                value={query}
                placeholder={t("Search settings")}
                aria-label={t("Search settings")}
                aria-controls={searching ? "settings-search-results" : undefined}
                autoComplete="off"
                spellCheck={false}
                onChange={(event) => setQuery(event.target.value)}
              />
            </div>
            <div ref={tabsRef} className="settings-tabs" role="tablist" aria-orientation="vertical" hidden={searching && narrow}>
              {PAGES.map(({ id, icon: Icon }, index) => (
                <button key={id} type="button" role="tab" className="settings-tab" data-settings-page={id} aria-selected={!searching && page === id} aria-controls={!searching && page === id ? "settings-panel" : undefined} tabIndex={focusable === id ? 0 : -1} onClick={() => openFromSearch(id)} onKeyDown={(event) => onTabKey(event, index)}>
                  <Icon aria-hidden="true" />
                  <span>{label(id)}</span>
                  <ChevronRight className="settings-tab-chevron" aria-hidden="true" />
                </button>
              ))}
            </div>
          </nav>
        )}
        {searching ? (
          <div id="settings-search-results" className="modal-body settings-body settings-search-results" role="region" aria-label={t("Search results")}>
            {saveError !== null && <SaveFailure error={saveError} paused={savePaused} retrying={saveRetrying} onRetry={onRetrySave} />}
            <p className="settings-search-empty" role="status">{t("No settings match.")}</p>
            <SettingsQuery.Provider value={words}>
              {PAGES.map(({ id }) => (
                <section key={id} className="settings-search-page" aria-label={label(id)}>
                  <button type="button" className="settings-search-page-title" aria-label={t("Open {page}", { page: label(id) })} title={t("Open {page}", { page: label(id) })}
                  onClick={(event) => openFromSearch(id, matchedGroups(event.currentTarget.closest(".settings-search-page"), words))}>
                    <span>{label(id)}</span>
                    <ChevronRight aria-hidden="true" />
                  </button>
                  {body(id)}
                </section>
              ))}
            </SettingsQuery.Provider>
          </div>
        ) : page !== null && <div key={page} ref={settingsBodyRef} id="settings-panel" className="modal-body settings-body" role="tabpanel" aria-label={label(page)} hidden={keyBarOpen}>{saveError !== null && <SaveFailure error={saveError} paused={savePaused} retrying={saveRetrying} onRetry={onRetrySave} />}{pageNote(t, page) !== null && <p className="settings-page-note">{pageNote(t, page)}</p>}{body(page)}</div>}
        {keyBarOpen && <div className="modal-body settings-key-bar-body"><KeyBarSettings /></div>}
      </section>
    </div>
  );
}
