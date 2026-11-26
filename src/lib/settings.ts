/**
 * xterm reads no CSS, so `terminalTheme()` mirrors the
 * `--term-*` tokens of each theme for PaneTerminal's theme object.
 */

import type { TelemetrySettings } from "../../shared/telemetry.ts";
import { MAX_PINS, mirrorPalette, SHARED_SETTING_KEYS, type SharedSettingKey } from "../../shared/preferences.ts";
import { browserBlockedSites } from "../../shared/browser-policy.ts";
import { createContext, createElement, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { DEFAULT_THEME, terminalColors, themeColor as themeTableColor, type DrawnTheme, type ThemeId } from "./themes.ts";
import { bootRows, drawnTheme, NO_CUSTOM_THEMES, sanitizeCustomThemes, type CustomThemes } from "./customThemes.ts";
import { LANGUAGE_SETTINGS, LOCALE_TAGS, resolveLanguage, setCurrentLanguage, type Language, type LanguageSetting } from "./i18n.ts";
import type { AlertPrefs, DoneAlerts } from "../../shared/notify-policy.ts";
import { AGENT_GROUP_SORTS, type AgentGroupSort } from "../../shared/attention.ts";
import { chatFontStack, sanitizeFontFamily } from "./fontFamily.ts";
import { fontScale, sanitizeUiFontSize, uiFontStack } from "./typography.ts";
import { sanitizeKeyBarExtras, type KeyBarExtra } from "./keys.ts";
import { DEFAULT_KEY_BAR_ITEMS, migrateKeyBarItems, sanitizeKeyBarItems, type KeyBarItem } from "./keyBar.ts";
import { applyThemeEntry, CUSTOM_ROWS_STORAGE_KEY, CUSTOM_THEMES_STORAGE_KEY, DARK_QUERY, DEFAULT_MARKDOWN_STYLE, defaultThemeSetting, MARKDOWN_STYLE_STORAGE_KEY, MARKDOWN_STYLES, readStoredAppearance, resolveTheme, sanitizeAppearance, sanitizeMarkdownStyle, savedMarkdownStyle, SETTINGS_STORAGE_KEY, THEMES_STORAGE_KEY, type MarkdownStyle, type ResolvedTheme, type ThemeSetting } from "./themeBoot.ts";

export { DEFAULT_MARKDOWN_STYLE, MARKDOWN_STYLE_STORAGE_KEY, MARKDOWN_STYLES, resolveTheme };
export type { MarkdownStyle, ResolvedTheme, ThemeSetting };
export type Density = "compact" | "comfortable";
export type PhoneTabs = "row" | "header";
export type SidebarRows = "one" | "two";
export type AgentOrder = "waiting" | "workspace" | "activity";
export { AGENT_GROUP_SORTS, type AgentGroupSort } from "../../shared/attention.ts";
export type AgentMarks = "color" | "mono";
export type UsageCount = "used" | "left";
/** the limit a plan meter shows: the plan's week, or its short session (5 hours on Claude and Codex) */
export type UsageGlance = "week" | "session";
export type Palette = ThemeId;
export type ChatWidth = "narrow" | "default" | "wide" | "full";
export const CHAT_WIDTHS: readonly ChatWidth[] = ["narrow", "default", "wide", "full"];
export type VoiceButton = "auto" | "on" | "off";
export const VOICE_BUTTONS: readonly VoiceButton[] = ["auto", "on", "off"];
export type VoiceEngineChoice = "auto" | "browser" | "server";
export const VOICE_ENGINES: readonly VoiceEngineChoice[] = ["auto", "browser", "server"];
/**
 * The languages dictation can be set to, as BCP 47 tags (SpeechRecognition.lang; the transcribe
 * route takes the first subtag).
 */
export const DICTATION_LANGUAGES = [
  "ar-SA", "cs-CZ", "da-DK", "de-DE", "el-GR", "en-GB", "en-US", "es-ES", "fi-FI", "fr-FR", "he-IL", "hi-IN",
  "hu-HU", "id-ID", "it-IT", "ja-JP", "ko-KR", "nb-NO", "nl-NL", "pl-PL", "pt-BR", "pt-PT", "ro-RO", "ru-RU",
  "sk-SK", "sv-SE", "th-TH", "tr-TR", "uk-UA", "vi-VN", "zh-CN", "zh-TW",
] as const;
export type DictationLanguage = "auto" | (typeof DICTATION_LANGUAGES)[number];
export type DefaultView = "auto" | "chat" | "terminal";
export interface FileFontBase { size: number; chat: number; ui: number }
import { sanitizeShortcutOverrides, type ShortcutOverrides } from "./shortcutBindings.ts";
import type { StatusIndicators } from "./status.ts";
import { sanitizeGroupNames, sanitizeGroupOf } from "./namedAgentGroups.ts";
import { WEB_LINK_TARGETS, type WebLinkTarget } from "./webPanel.ts";
import { FILE_OPEN_TARGETS, type FilePresentation } from "./filePresentation.ts";
import { browserToolChoices, type BrowserToolChoices } from "../../shared/browser-tools.ts";
import { CLAUDE_EFFORTS, CLAUDE_LAUNCH_MODES, CODEX_EFFORTS, CODEX_LAUNCH_MODES, launchChoiceFault, type ClaudeLaunchMode, type CodexLaunchMode } from "./agentLaunchMode.ts";

export interface Settings {
  terminalInputMode: "auto" | "line" | "direct";
  keyBarExtras: KeyBarExtra[];
  keyBarItems: KeyBarItem[];
  keyBarExpanded: boolean;
  shortcutOverrides: ShortcutOverrides;
  /** herdr's prefix, then a key its config.toml binds, runs the app's action for it (lib/herdrKeys.ts); off until chosen,
   *  since the prefix (Ctrl+B by default) then no longer reaches the pane */
  herdrPrefixKeys: boolean;
  theme: ThemeSetting;
  density: Density;
  phoneTabs: PhoneTabs;
  sidebarRows: SidebarRows;
  sidebarFilter: boolean;
  sidebarContext: boolean;
  foldHelpers: boolean;
  sidebarAgentTree: boolean;
  pcLoad: boolean | null;
  agentOrder: AgentOrder;
  agentGroups: boolean;
  agentGroupSort: AgentGroupSort;
  agentMarks: AgentMarks;
  agentLocks: boolean;
  /** Settings -> Experimental -> OpenCode: subagent ends from their session: the server ends an OpenCode subagent where its parent session's record does (server/opencode-subagents.ts); off, by its own rows */
  opencodeParentEnds: boolean;
  /** Settings -> Experimental -> OMP on macOS herdr-core: the server reads an omp pane's chat from the session its omp holds open, through lsof (server/omp.ts ompHeldOpen); off, the chat there falls back to the terminal */
  ompHeldFiles: boolean;
  restoreReplacedServer: boolean;
  lockedAgents: string[];
  agentNamedGroups: boolean;
  agentGroupNames: string[];
  agentGroupOf: Record<string, string>;
  statusIndicators: StatusIndicators;
  palette: Palette;
  paletteLight: Palette;
  paletteDark: Palette;
  darkTheme: ThemeId;
  lightTheme: ThemeId;
  customThemes: CustomThemes;
  markdownStyle: MarkdownStyle;
  terminalFontSize: number;
  /** mouse reports sent to herdr per wheel event in the terminal: 1 is what xterm sends by itself */
  terminalWheelSpeed: number;
  terminalFontFamily: string;
  /** let a pane's OSC 52 sequence write the clipboard (lib/osc52.ts), as vim, tmux and Claude Code copy;
   *  on unless chosen off, since any process in the pane can then plant text the user pastes elsewhere.
   *  Stored under this key, not 0.4.1's `terminalOsc52`: settings are saved whole, so a `false` there
   *  was written by any change at all, not chosen, and is ignored. */
  paneClipboard: boolean;
  /** draw the pictures a pane program prints as sixel or iTerm2 inline images (lib/terminalImages.ts). Only herdr-core
   *  passes them on: herdr redraws a pane from its own grid, which keeps no pictures. null, not chosen: on where the
   *  pane's server keeps the terminal's history (herdr-core), off on herdr; a choice made on this device stays. */
  terminalImages: boolean | null;
  terminalAttachButton: boolean;
  terminalKeyboardOnRequest: boolean;
  terminalFoldKeyBar: boolean;
  /** a pane whose grid this device does not size and is wider than this screen (a mirrored pane: a Windows
   *  PC, no terminal attach; an attached pane it only watches, or holds under the keyboard, at the grid
   *  another device gave the pty) is drawn folded to the screen's width (lib/terminalFold.ts); false draws
   *  the grid at its original width, panned sideways. The name and its `ovis:mirror-wrap` key are kept from
   *  when only mirrors folded, so a choice made then still holds. */
  terminalMirrorWrap: boolean | null;
  /** a desktop tab out of use for a moment detaches its pane (PaneTerminal's release) and only watches it, so herdr's own
   *  window keeps the pane at its size; paused where the server cannot watch. */
  releasePaneAway: boolean;
  /** a plain drag in a Codex pane is Codex's, which selects and scrolls its own history (lib/useTerminalMount.ts);
   *  off: Ovis's selection, which stops at the screen's edge but copies on every device */
  codexDrag: boolean;
  /** this device opens the pane herdr's own focus moves to (a `pane-focused` frame from the selected PC), as
   *  herdr's window does after `herdr tab focus` or a click there; off: only this device's own picks move it */
  followHerdrFocus: boolean;
  sidebarPeek: boolean;
  phoneInbox: boolean | null;
  sidebarBackgroundWorkspaces: boolean;
  chatFontSize: number | null;
  chatFontFamily: string;
  fileFontSize: number | null;
  fileFontBase: FileFontBase | null;
  uiFontSize: number | null;
  uiFontFamily: string;
  chatWidth: ChatWidth;
  /** true: Enter sends in the composer, Shift+Enter breaks the line; false: Ctrl/Cmd+Enter sends. Chosen in
   *  Settings for this device; null until then: Return breaks the line on a touch screen, as in the ChatGPT and
   *  Claude apps, and Enter sends elsewhere (enterSendsOn). Kept in a key of its own (ENTER_SENDS_STORAGE_KEY) */
  enterSends: boolean | null;
  autoSendQueued: boolean;
  /** true: a tab herdr still names by its number shows a few words of its first message (lib/tabLabels.ts); false keeps tabs as they are */
  autoTabNames: boolean;
  composerArtifacts: boolean;
  composerPasteSend: boolean;
  /** the Side conversations chip in an OMP pane's composer, listing what was asked and answered with `/btw`; off until
   *  chosen, so the composer's row stays minimal */
  composerBtw: boolean;
  /** on a touch screen, a chip above the message box offers the prompt the agent suggests next.
   * Not `showSuggestionChip`: that key was on by default until 0.4.9 and is still stored on phones */
  suggestionChip: boolean;
  showThinking: boolean;
  expandThinking: boolean;
  foldWork: boolean;
  keepScreenOn: boolean;
  language: LanguageSetting;
  alertsOn: boolean;
  alertInput: boolean;
  alertDone: DoneAlerts;
  /** an open tab chimes for the same alerts (lib/alertSound.ts), heard also when a Focus silences notifications; off until chosen */
  alertSound: boolean;
  quickReplies: string[];
  showQuickReplies: boolean;
  /** the plan meters beside Settings in the sidebar (GET /api/usage); off until chosen, as it sends this PC's sign-ins out */
  showUsage: boolean;
  usageCount: UsageCount;
  usageGlance: UsageGlance;
  defaultView: DefaultView;
  usageOrder: string[];
  usageHidden: string[];
  /** the microphone button in the composer and the terminal input line; nothing is recorded until it is pressed */
  voiceInput: VoiceButton;
  voiceLanguage: DictationLanguage;
  voiceEngine: VoiceEngineChoice;
  voicePolishChat: boolean;
  voicePolishTerminal: boolean;
  wrapCode: boolean;
  editTextFiles: boolean;
  reopenFileOnReturn: boolean;
  diffStyle: DiffStyle;
  fileOpen: FilePresentation;
  filesPanel: boolean;
  webLinks: WebLinkTarget;
  reuseExternalLinkTab: boolean;
  /** the desktop app's built-in browser (app/electron/src/browserTabs.ts), which its main process reads from the server's
   *  preferences: off until chosen, and then nothing of it (tabs, profiles, the agents' way in) exists */
  builtInBrowser: boolean;
  /** the sites the built-in browser never loads, with their subdomains, as shared/browser-policy.ts blockedSite keeps them */
  browserBlockedSites: string[];
  /** the mode a Claude Code started from the new workspace, tab and worktree dialogs runs in (lib/agentLaunchMode.ts); default adds no flag */
  claudeLaunchMode: ClaudeLaunchMode;
  /** the same for Codex: a sandbox and approval preset */
  codexLaunchMode: CodexLaunchMode;
  /** the model (`--model`) a Claude Code started from those dialogs is filled in with; "" is its own (lib/agentLaunchMode.ts launchDefaults) */
  claudeLaunchModel: string;
  /** the same for its effort level (`--effort`) */
  claudeLaunchEffort: (typeof CLAUDE_EFFORTS)[number] | "";
  /** the same for Codex's model (`--model`) */
  codexLaunchModel: string;
  /** and Codex's effort (`-c model_reasoning_effort=`) */
  codexLaunchEffort: (typeof CODEX_EFFORTS)[number] | "";
  /** the browser tool each agent this PC's server starts is given (shared/browser-tools.ts); an agent absent gets none */
  agentBrowserTools: BrowserToolChoices;
  agentHarnessTool: HarnessToolSetting;
}

export const DIFF_STYLES = ["unified", "split"] as const;
export type DiffStyle = (typeof DIFF_STYLES)[number];

/** Raw custom text, key combinations and account keys are never copied. Requiring every other
 * Settings field in the projection makes a new field require an explicit collection decision. */
type TelemetrySourceSettings = Omit<Settings,
  "keyBarExtras" | "keyBarItems" | "keyBarExpanded" | "shortcutOverrides" | "herdrPrefixKeys" | "terminalFontFamily" | "chatFontFamily" | "uiFontFamily"
  | "quickReplies" | "agentLocks" | "lockedAgents" | "opencodeParentEnds" | "ompHeldFiles" | "restoreReplacedServer" | "agentNamedGroups" | "agentGroupNames" | "agentGroupOf" | "usageOrder" | "usageHidden" | "fileOpen" | "filesPanel" | "webLinks" | "reuseExternalLinkTab" | "builtInBrowser" | "browserBlockedSites" | "claudeLaunchMode" | "codexLaunchMode"
  | "claudeLaunchModel" | "claudeLaunchEffort" | "codexLaunchModel" | "codexLaunchEffort" | "agentBrowserTools"
  | "agentHarnessTool"
  | "followHerdrFocus" | "sidebarPeek" | "phoneInbox" | "sidebarBackgroundWorkspaces" | "codexDrag" | "composerArtifacts" | "composerPasteSend" | "composerBtw" | "terminalMirrorWrap" | "sidebarFilter" | "sidebarContext" | "sidebarAgentTree" | "foldHelpers" | "pcLoad"
  | "expandThinking" | "foldWork" | "customThemes" | "markdownStyle" | "autoTabNames" | "voiceEngine" | "agentGroups" | "agentGroupSort" | "terminalImages" | "terminalAttachButton"
  | "terminalKeyboardOnRequest" | "terminalFoldKeyBar" | "fileFontSize" | "fileFontBase" | "editTextFiles" | "reopenFileOnReturn" | "phoneTabs">;

function differsFromDefault(value: unknown, defaultValue: unknown): boolean {
  return JSON.stringify(value) !== JSON.stringify(defaultValue);
}

/** Full allowlisted snapshot. Text and account-key values are only used for safe summaries. */
export function telemetrySettingsSnapshot(settings: Settings): TelemetrySettings & TelemetrySourceSettings {
  return {
    terminalInputMode: settings.terminalInputMode,
    theme: settings.theme,
    density: settings.density,
    sidebarRows: settings.sidebarRows,
    // Waiting first is herdr's workspace order with the waiting agents lifted: reported as that order, so the
    // receiver's schema (shared/telemetry.ts, changed only with its deploy) keeps accepting the snapshot
    agentOrder: settings.agentOrder === "waiting" ? "workspace" : settings.agentOrder,
    agentMarks: settings.agentMarks,
    statusIndicators: settings.statusIndicators,
    palette: settings.palette,
    paletteLight: settings.paletteLight,
    paletteDark: settings.paletteDark,
    terminalFontSize: settings.terminalFontSize,
    terminalWheelSpeed: settings.terminalWheelSpeed,
    paneClipboard: settings.paneClipboard,
    releasePaneAway: settings.releasePaneAway,
    chatFontSize: settings.chatFontSize,
    uiFontSize: settings.uiFontSize,
    chatWidth: settings.chatWidth,
    enterSends: enterSendsOn(settings, coarsePointer()),
    autoSendQueued: settings.autoSendQueued,
    suggestionChip: settings.suggestionChip,
    showThinking: settings.showThinking,
    keepScreenOn: settings.keepScreenOn,
    language: settings.language,
    alertsOn: settings.alertsOn,
    alertInput: settings.alertInput,
    alertDone: settings.alertDone,
    alertInApp: true,
    alertSound: settings.alertSound,
    showQuickReplies: settings.showQuickReplies,
    showUsage: settings.showUsage,
    usageCount: settings.usageCount,
    usageGlance: settings.usageGlance,
    defaultView: settings.defaultView,
    voiceInput: settings.voiceInput,
    voiceLanguage: settings.voiceLanguage,
    voicePolishChat: settings.voicePolishChat,
    voicePolishTerminal: settings.voicePolishTerminal,
    wrapCode: settings.wrapCode,
    markdownWidth: "readable",
    diffStyle: settings.diffStyle,
    terminalFontCustom: settings.terminalFontFamily !== DEFAULT_SETTINGS.terminalFontFamily,
    chatFontCustom: settings.chatFontFamily !== DEFAULT_SETTINGS.chatFontFamily,
    shortcutsCustom: differsFromDefault(settings.shortcutOverrides, DEFAULT_SETTINGS.shortcutOverrides),
    keyBarCustom: differsFromDefault(settings.keyBarItems, DEFAULT_SETTINGS.keyBarItems)
      || differsFromDefault(settings.keyBarExtras, DEFAULT_SETTINGS.keyBarExtras),
    quickRepliesCustom: differsFromDefault(settings.quickReplies, DEFAULT_SETTINGS.quickReplies),
    quickReplyCount: settings.quickReplies.length,
    usageHiddenCount: settings.usageHidden.length,
    usageOrderCustom: settings.usageOrder.length > 0,
    darkTheme: settings.darkTheme,
    lightTheme: settings.lightTheme,
  };
}

export const SETTING_SCOPE = {
  theme: "shared", palette: "shared", darkTheme: "shared", lightTheme: "shared", markdownStyle: "shared", language: "shared", sidebarRows: "shared", agentOrder: "shared",
  agentMarks: "shared", agentLocks: "shared", lockedAgents: "shared", opencodeParentEnds: "shared", ompHeldFiles: "shared", restoreReplacedServer: "shared", agentNamedGroups: "shared", agentGroupNames: "shared", agentGroupOf: "shared", autoSendQueued: "shared", autoTabNames: "shared", showThinking: "shared", quickReplies: "shared", builtInBrowser: "shared", browserBlockedSites: "shared",
  showQuickReplies: "shared", showUsage: "shared", usageCount: "shared",
  usageGlance: "shared", usageOrder: "shared", usageHidden: "shared", defaultView: "device", suggestionChip: "device",
  terminalInputMode: "device", keyBarExtras: "device", keyBarItems: "device", keyBarExpanded: "device", shortcutOverrides: "device", herdrPrefixKeys: "device", density: "device", phoneTabs: "device",
  terminalFontSize: "device",
  terminalWheelSpeed: "device", terminalFontFamily: "device", paneClipboard: "device", releasePaneAway: "device",
  terminalImages: "device",
  terminalAttachButton: "device",
  terminalKeyboardOnRequest: "device",
  terminalFoldKeyBar: "device",
  terminalMirrorWrap: "device",
  // a desk that follows herdr's focus must not move a phone open on another pane
  followHerdrFocus: "device",
  codexDrag: "device",
  sidebarPeek: "device",
  phoneInbox: "device",
  sidebarBackgroundWorkspaces: "device",
  chatFontSize: "device", chatFontFamily: "device", fileFontSize: "device", fileFontBase: "device", uiFontSize: "device", uiFontFamily: "device", chatWidth: "device", enterSends: "device",
  expandThinking: "device", foldWork: "device",
  composerArtifacts: "device",
  composerPasteSend: "device",
  composerBtw: "device",
  sidebarFilter: "device",
  sidebarContext: "device",
  foldHelpers: "device",
  sidebarAgentTree: "device",
  pcLoad: "device",
  agentGroups: "device", agentGroupSort: "device",
  keepScreenOn: "device", alertsOn: "device", alertInput: "device", alertDone: "device", alertSound: "device",
  paletteLight: "device", paletteDark: "device", statusIndicators: "device",
  voiceInput: "device", voiceLanguage: "device", voiceEngine: "device", voicePolishChat: "device", voicePolishTerminal: "device",
  wrapCode: "device", editTextFiles: "device", reopenFileOnReturn: "device", diffStyle: "device", fileOpen: "device", filesPanel: "device", webLinks: "device", reuseExternalLinkTab: "device",
  claudeLaunchMode: "shared", codexLaunchMode: "shared",
  claudeLaunchModel: "shared", claudeLaunchEffort: "shared", codexLaunchModel: "shared", codexLaunchEffort: "shared",
  agentBrowserTools: "shared",
  agentHarnessTool: "shared",
  customThemes: "shared",
} as const satisfies Record<keyof Settings, "shared" | "device">;

export function sharedSettings(settings: Settings): Partial<Record<SharedSettingKey, unknown>> {
  return Object.fromEntries(SHARED_SETTING_KEYS.map((key) => [key, settings[key]]));
}

export const DEFAULT_SETTINGS: Settings = {
  terminalInputMode: "auto",
  keyBarExtras: ["alt"],
  keyBarItems: DEFAULT_KEY_BAR_ITEMS,
  keyBarExpanded: false,
  shortcutOverrides: {},
  herdrPrefixKeys: false,
  theme: "system",
  density: "comfortable",
  phoneTabs: "row",
  sidebarRows: "one",
  sidebarFilter: false,
  sidebarContext: false,
  foldHelpers: false,
  sidebarAgentTree: false,
  pcLoad: null,
  agentOrder: "waiting",
  agentGroups: false,
  agentGroupSort: "wait",
  agentMarks: "color",
  agentLocks: false,
  opencodeParentEnds: false,
  ompHeldFiles: false,
  restoreReplacedServer: false,
  lockedAgents: [],
  agentNamedGroups: false,
  agentGroupNames: [],
  agentGroupOf: {},
  statusIndicators: "classic",
  palette: DEFAULT_THEME,
  paletteLight: DEFAULT_THEME,
  paletteDark: DEFAULT_THEME,
  darkTheme: DEFAULT_THEME,
  lightTheme: DEFAULT_THEME,
  customThemes: NO_CUSTOM_THEMES,
  markdownStyle: DEFAULT_MARKDOWN_STYLE,
  terminalFontSize: 13,
  terminalWheelSpeed: 1,
  terminalFontFamily: "",
  paneClipboard: true,
  terminalImages: null,
  terminalAttachButton: false,
  terminalKeyboardOnRequest: false,
  terminalFoldKeyBar: false,
  terminalMirrorWrap: null,
  releasePaneAway: false,
  followHerdrFocus: false,
  codexDrag: false,
  sidebarPeek: false,
  phoneInbox: null,
  sidebarBackgroundWorkspaces: false,
  chatFontSize: null,
  fileFontSize: null,
  fileFontBase: null,
  chatFontFamily: "",
  uiFontSize: null,
  uiFontFamily: "",
  chatWidth: "default",
  enterSends: null,
  autoSendQueued: true,
  autoTabNames: true,
  composerArtifacts: false,
  composerPasteSend: false,
  composerBtw: false,
  suggestionChip: false,
  showThinking: false,
  expandThinking: false,
  foldWork: false,
  keepScreenOn: false,
  language: "system",
  alertsOn: true,
  alertInput: true,
  alertDone: "long",
  alertSound: false,
  quickReplies: ["continue", "yes", "no", "commit and push", "retry"],
  showQuickReplies: false,
  showUsage: false,
  usageCount: "left",
  usageGlance: "session",
  defaultView: "auto",
  usageOrder: [],
  usageHidden: [],
  voiceInput: "off",
  voiceLanguage: "auto",
  voiceEngine: "auto",
  voicePolishChat: true,
  voicePolishTerminal: false,
  wrapCode: false,
  editTextFiles: false,
  reopenFileOnReturn: false,
  diffStyle: "unified",
  fileOpen: "popup",
  filesPanel: false,
  webLinks: "tab",
  reuseExternalLinkTab: false,
  builtInBrowser: false,
  browserBlockedSites: [],
  claudeLaunchMode: "default",
  codexLaunchMode: "default",
  claudeLaunchModel: "",
  claudeLaunchEffort: "",
  codexLaunchModel: "",
  codexLaunchEffort: "",
  agentBrowserTools: {},
  agentHarnessTool: HARNESS_TOOL_DEFAULT,
};

export const QUICK_REPLIES_MAX = 12;
export const USAGE_KEYS_MAX = 64;

function launchModel(kind: "claude" | "codex", value: unknown): string {
  const model = typeof value === "string" ? value.trim() : "";
  return launchChoiceFault(kind, { model }) === null ? model : "";
}

function usageKeys(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((key): key is string => typeof key === "string" && key.length > 0 && key.length <= 512))].slice(0, USAGE_KEYS_MAX);
}
export const QUICK_REPLY_MAX_CHARS = 200;

function voiceButton(value: unknown): VoiceButton {
  if (value === true) return "on";
  // a saved switch from before the three places: off was the switch's default, and Auto took its place (#559)
  if (value === false) return "auto";
  return VOICE_BUTTONS.includes(value as VoiceButton) ? value as VoiceButton : DEFAULT_SETTINGS.voiceInput;
}

export function wantsVoiceInput(setting: VoiceButton, mode: "chat" | "terminal", phone: boolean): boolean {
  return setting === "on" || (setting === "auto" && mode === "chat" && !phone);
}

export function quickReplyButtons(settings: Settings): string[] {
  return settings.quickReplies.filter((reply) => reply.trim() !== "");
}

export function alertPrefs(settings: Settings): AlertPrefs {
  return { input: settings.alertInput, done: settings.alertDone };
}

export const TERMINAL_FONT_MIN = 10;
export const TERMINAL_FONT_MAX = 22;
export const TERMINAL_WHEEL_SPEED_MIN = 1;
export const TERMINAL_WHEEL_SPEED_MAX = 10;

export const CHAT_FONT_MIN = 11;
export const HISTORY_PROMPTS = 10;

export const CHAT_FONT_MAX = 24;
const BODY_FONT: Record<Density, number> = { comfortable: 14, compact: 13 };

function clampFont(size: number): number {
  return Math.min(TERMINAL_FONT_MAX, Math.max(TERMINAL_FONT_MIN, Math.round(size)));
}

export function uiFontSize(settings: Settings): number {
  return settings.uiFontSize ?? BODY_FONT[settings.density];
}

export function chatFontSize(settings: Settings): number {
  return settings.chatFontSize ?? uiFontSize(settings);
}

export function fileFontSize(settings: Settings): number {
  return settings.fileFontSize ?? chatFontSize(settings);
}

export const CHAT_LANE_MIN = 820;
/** ...or wider than this, in rem: 960px at a 16px root. In rem because Wide is (72rem, styles.css),
 *  so Default stays the narrower of the two at a root font of 11.39px and up; under that the
 *  820px floor wins and is itself wider than Wide (see chatLaneLength). */
export const CHAT_LANE_MAX_REM = 60;
export const CHAT_LANE_RATIO = 0.7143;
export const ROOT_FONT_PX = 16;

function chatLaneFollow(paneWidth: number): number {
  if (!Number.isFinite(paneWidth)) return CHAT_LANE_MIN;
  return Math.max(CHAT_LANE_MIN, Math.round(paneWidth * CHAT_LANE_RATIO));
}

/**
 * A length with no percentage in it: the lane's columns sit in boxes of different widths (the
 * transcript and the composer column inside a gutter, the held list and the menus outside it),
 * and one length is what keeps them equal.
 * The ceiling is left to the stylesheet engine as 60rem, not resolved here: Wide's 72rem follows
 * the root font size the moment it changes, and so must this, or Default would be the wider of
 * the two until the pane was next measured.
 * Where the two ends cross (60rem is under 820px below a 13.67px root) the floor wins: Default is
 * then the same lane as Narrow, never narrower than it, and still no wider than Wide down to an
 * 11.39px root, under which Narrow's own 820px is already wider than Wide's 72rem.
 */
export function chatLaneLength(paneWidth: number): string {
  return `min(max(${CHAT_LANE_MIN}px, ${CHAT_LANE_MAX_REM}rem), ${chatLaneFollow(paneWidth)}px)`;
}

export function chatLaneWidth(paneWidth: number, rootFontPx: number = ROOT_FONT_PX): number {
  const root = Number.isFinite(rootFontPx) && rootFontPx > 0 ? rootFontPx : ROOT_FONT_PX;
  return Math.min(Math.max(CHAT_LANE_MIN, CHAT_LANE_MAX_REM * root), chatLaneFollow(paneWidth));
}

export function sanitizeSettings(raw: unknown): Settings {
  const record = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  const { theme, darkTheme, lightTheme } = sanitizeAppearance(record);
  const density = record["density"];
  const font = record["terminalFontSize"];
  const chatFont = record["chatFontSize"];
  const keyBarExtras = sanitizeKeyBarExtras(record["keyBarExtras"], DEFAULT_SETTINGS.keyBarExtras);
  const keyBarFallback = Array.isArray(record["keyBarExtras"])
    ? migrateKeyBarItems(keyBarExtras)
    : DEFAULT_KEY_BAR_ITEMS;
  return {
    terminalInputMode: record["terminalInputMode"] === "line" || record["terminalInputMode"] === "direct" ? record["terminalInputMode"] : "auto",
    keyBarExtras,
    keyBarItems: sanitizeKeyBarItems(record["keyBarItems"], keyBarFallback),
    keyBarExpanded: typeof record["keyBarExpanded"] === "boolean" ? record["keyBarExpanded"] : DEFAULT_SETTINGS.keyBarExpanded,
    shortcutOverrides: sanitizeShortcutOverrides(record["shortcutOverrides"]),
    herdrPrefixKeys: typeof record["herdrPrefixKeys"] === "boolean" ? record["herdrPrefixKeys"] : DEFAULT_SETTINGS.herdrPrefixKeys,
    theme,
    density: density === "compact" || density === "comfortable" ? density : DEFAULT_SETTINGS.density,
    sidebarRows: record["sidebarRows"] === "one" || record["sidebarRows"] === "two" ? record["sidebarRows"] : DEFAULT_SETTINGS.sidebarRows,
    sidebarFilter: typeof record["sidebarFilter"] === "boolean" ? record["sidebarFilter"] : DEFAULT_SETTINGS.sidebarFilter,
    sidebarContext: typeof record["sidebarContext"] === "boolean" ? record["sidebarContext"] : DEFAULT_SETTINGS.sidebarContext,
    foldHelpers: typeof record["foldHelpers"] === "boolean" ? record["foldHelpers"] : DEFAULT_SETTINGS.foldHelpers,
    sidebarAgentTree: typeof record["sidebarAgentTree"] === "boolean" ? record["sidebarAgentTree"] : DEFAULT_SETTINGS.sidebarAgentTree,
    pcLoad: typeof record["pcLoad"] === "boolean" ? record["pcLoad"] : null,
    agentOrder: record["agentOrder"] === "waiting" || record["agentOrder"] === "workspace" || record["agentOrder"] === "activity" ? record["agentOrder"] : DEFAULT_SETTINGS.agentOrder,
    agentGroups: typeof record["agentGroups"] === "boolean" ? record["agentGroups"] : DEFAULT_SETTINGS.agentGroups,
    agentGroupSort: AGENT_GROUP_SORTS.includes(record["agentGroupSort"] as AgentGroupSort) ? record["agentGroupSort"] as AgentGroupSort : DEFAULT_SETTINGS.agentGroupSort,
    agentMarks: record["agentMarks"] === "color" || record["agentMarks"] === "mono" ? record["agentMarks"] : DEFAULT_SETTINGS.agentMarks,
    agentLocks: typeof record["agentLocks"] === "boolean" ? record["agentLocks"] : DEFAULT_SETTINGS.agentLocks,
    opencodeParentEnds: typeof record["opencodeParentEnds"] === "boolean" ? record["opencodeParentEnds"] : DEFAULT_SETTINGS.opencodeParentEnds,
    ompHeldFiles: typeof record["ompHeldFiles"] === "boolean" ? record["ompHeldFiles"] : DEFAULT_SETTINGS.ompHeldFiles,
    restoreReplacedServer: typeof record["restoreReplacedServer"] === "boolean" ? record["restoreReplacedServer"] : DEFAULT_SETTINGS.restoreReplacedServer,
    lockedAgents: Array.isArray(record["lockedAgents"])
      ? [...new Set(record["lockedAgents"].filter((key): key is string => typeof key === "string" && key.length > 0))].slice(0, MAX_PINS)
      : [...DEFAULT_SETTINGS.lockedAgents],
    agentNamedGroups: typeof record["agentNamedGroups"] === "boolean" ? record["agentNamedGroups"] : DEFAULT_SETTINGS.agentNamedGroups,
    agentGroupNames: sanitizeGroupNames(record["agentGroupNames"]),
    agentGroupOf: sanitizeGroupOf(record["agentGroupOf"]),
    phoneTabs: record["phoneTabs"] === "row" || record["phoneTabs"] === "header" ? record["phoneTabs"] : DEFAULT_SETTINGS.phoneTabs,
    statusIndicators: record["statusIndicators"] === "classic" || record["statusIndicators"] === "dots" || record["statusIndicators"] === "symbols" ? record["statusIndicators"] : DEFAULT_SETTINGS.statusIndicators,
    darkTheme,
    lightTheme,
    customThemes: sanitizeCustomThemes(record["customThemes"]),
    markdownStyle: sanitizeMarkdownStyle(record["markdownStyle"]),
    palette: mirrorPalette(theme, darkTheme, lightTheme),
    paletteLight: lightTheme,
    paletteDark: darkTheme,
    terminalFontSize: typeof font === "number" && Number.isFinite(font) ? clampFont(font) : DEFAULT_SETTINGS.terminalFontSize,
    terminalWheelSpeed: typeof record["terminalWheelSpeed"] === "number" && Number.isFinite(record["terminalWheelSpeed"])
      ? Math.min(TERMINAL_WHEEL_SPEED_MAX, Math.max(TERMINAL_WHEEL_SPEED_MIN, Math.round(record["terminalWheelSpeed"])))
      : DEFAULT_SETTINGS.terminalWheelSpeed,
    chatFontSize: typeof chatFont === "number" && Number.isFinite(chatFont)
      ? Math.min(CHAT_FONT_MAX, Math.max(CHAT_FONT_MIN, Math.round(chatFont)))
      : DEFAULT_SETTINGS.chatFontSize,
    fileFontSize: typeof record["fileFontSize"] === "number" && Number.isFinite(record["fileFontSize"])
      ? Math.min(CHAT_FONT_MAX, Math.max(CHAT_FONT_MIN, Math.round(record["fileFontSize"])))
      : DEFAULT_SETTINGS.fileFontSize,
    fileFontBase: sanitizeFileFontBase(record["fileFontBase"]),
    terminalFontFamily: sanitizeFontFamily(record["terminalFontFamily"]),
    uiFontSize: sanitizeUiFontSize(record["uiFontSize"]),
    uiFontFamily: sanitizeFontFamily(record["uiFontFamily"]),
    paneClipboard: typeof record["paneClipboard"] === "boolean" ? record["paneClipboard"] : DEFAULT_SETTINGS.paneClipboard,
    terminalImages: typeof record["terminalImages"] === "boolean" ? record["terminalImages"] : null,
    terminalAttachButton: record["terminalAttachButton"] === true,
    terminalKeyboardOnRequest: record["terminalKeyboardOnRequest"] === true,
    terminalFoldKeyBar: record["terminalFoldKeyBar"] === true,
    terminalMirrorWrap: typeof record["terminalMirrorWrap"] === "boolean" ? record["terminalMirrorWrap"] : null,
    releasePaneAway: typeof record["releasePaneAway"] === "boolean" ? record["releasePaneAway"] : DEFAULT_SETTINGS.releasePaneAway,
    followHerdrFocus: typeof record["followHerdrFocus"] === "boolean" ? record["followHerdrFocus"] : DEFAULT_SETTINGS.followHerdrFocus,
    codexDrag: record["codexDrag"] === true,
    sidebarPeek: record["sidebarPeek"] === true,
    phoneInbox: typeof record["phoneInbox"] === "boolean" ? record["phoneInbox"] : null,
    sidebarBackgroundWorkspaces: record["sidebarBackgroundWorkspaces"] === true,
    chatFontFamily: sanitizeFontFamily(record["chatFontFamily"]),
    chatWidth: CHAT_WIDTHS.includes(record["chatWidth"] as ChatWidth) ? record["chatWidth"] as ChatWidth : DEFAULT_SETTINGS.chatWidth,
    enterSends: typeof record["enterSends"] === "boolean" ? record["enterSends"] : null,
    autoSendQueued: typeof record["autoSendQueued"] === "boolean" ? record["autoSendQueued"] : DEFAULT_SETTINGS.autoSendQueued,
    autoTabNames: typeof record["autoTabNames"] === "boolean" ? record["autoTabNames"] : DEFAULT_SETTINGS.autoTabNames,
    composerArtifacts: typeof record["composerArtifacts"] === "boolean" ? record["composerArtifacts"] : DEFAULT_SETTINGS.composerArtifacts,
    composerPasteSend: typeof record["composerPasteSend"] === "boolean" ? record["composerPasteSend"] : DEFAULT_SETTINGS.composerPasteSend,
    composerBtw: typeof record["composerBtw"] === "boolean" ? record["composerBtw"] : DEFAULT_SETTINGS.composerBtw,
    suggestionChip: typeof record["suggestionChip"] === "boolean" ? record["suggestionChip"] : DEFAULT_SETTINGS.suggestionChip,
    showThinking: typeof record["showThinking"] === "boolean" ? record["showThinking"] : DEFAULT_SETTINGS.showThinking,
    expandThinking: typeof record["expandThinking"] === "boolean" ? record["expandThinking"] : DEFAULT_SETTINGS.expandThinking,
    foldWork: typeof record["foldWork"] === "boolean" ? record["foldWork"] : DEFAULT_SETTINGS.foldWork,
    keepScreenOn: typeof record["keepScreenOn"] === "boolean" ? record["keepScreenOn"] : DEFAULT_SETTINGS.keepScreenOn,
    language: LANGUAGE_SETTINGS.includes(record["language"] as LanguageSetting) ? record["language"] as LanguageSetting : DEFAULT_SETTINGS.language,
    alertsOn: typeof record["alertsOn"] === "boolean" ? record["alertsOn"] : DEFAULT_SETTINGS.alertsOn,
    alertInput: typeof record["alertInput"] === "boolean" ? record["alertInput"] : DEFAULT_SETTINGS.alertInput,
    alertDone: record["alertDone"] === "off" || record["alertDone"] === "long" || record["alertDone"] === "always" ? record["alertDone"] : DEFAULT_SETTINGS.alertDone,
    alertSound: typeof record["alertSound"] === "boolean" ? record["alertSound"] : DEFAULT_SETTINGS.alertSound,
    quickReplies: Array.isArray(record["quickReplies"])
      ? record["quickReplies"].filter((reply): reply is string => typeof reply === "string").slice(0, QUICK_REPLIES_MAX).map((reply) => reply.slice(0, QUICK_REPLY_MAX_CHARS))
      : [...DEFAULT_SETTINGS.quickReplies],
    showQuickReplies: typeof record["showQuickReplies"] === "boolean" ? record["showQuickReplies"] : DEFAULT_SETTINGS.showQuickReplies,
    showUsage: typeof record["showUsage"] === "boolean" ? record["showUsage"] : DEFAULT_SETTINGS.showUsage,
    usageCount: record["usageCount"] === "used" || record["usageCount"] === "left" ? record["usageCount"] : DEFAULT_SETTINGS.usageCount,
    usageGlance: record["usageGlance"] === "week" || record["usageGlance"] === "session" ? record["usageGlance"] : DEFAULT_SETTINGS.usageGlance,
    defaultView: record["defaultView"] === "chat" || record["defaultView"] === "terminal" || record["defaultView"] === "auto" ? record["defaultView"] : DEFAULT_SETTINGS.defaultView,
    usageOrder: usageKeys(record["usageOrder"]),
    usageHidden: usageKeys(record["usageHidden"]),
    voiceInput: voiceButton(record["voiceInput"]),
    voiceLanguage: DICTATION_LANGUAGES.includes(record["voiceLanguage"] as (typeof DICTATION_LANGUAGES)[number]) ? record["voiceLanguage"] as DictationLanguage : DEFAULT_SETTINGS.voiceLanguage,
    voiceEngine: VOICE_ENGINES.includes(record["voiceEngine"] as VoiceEngineChoice) ? record["voiceEngine"] as VoiceEngineChoice : DEFAULT_SETTINGS.voiceEngine,
    voicePolishChat: typeof record["voicePolishChat"] === "boolean" ? record["voicePolishChat"] : DEFAULT_SETTINGS.voicePolishChat,
    voicePolishTerminal: typeof record["voicePolishTerminal"] === "boolean" ? record["voicePolishTerminal"] : DEFAULT_SETTINGS.voicePolishTerminal,
    wrapCode: typeof record["wrapCode"] === "boolean" ? record["wrapCode"] : DEFAULT_SETTINGS.wrapCode,
    editTextFiles: typeof record["editTextFiles"] === "boolean" ? record["editTextFiles"] : DEFAULT_SETTINGS.editTextFiles,
    reopenFileOnReturn: record["reopenFileOnReturn"] === true,
    diffStyle: DIFF_STYLES.find((style) => style === record["diffStyle"]) ?? DEFAULT_SETTINGS.diffStyle,
    fileOpen: FILE_OPEN_TARGETS.find((target) => target === record["fileOpen"]) ?? DEFAULT_SETTINGS.fileOpen,
    filesPanel: typeof record["filesPanel"] === "boolean" ? record["filesPanel"] : DEFAULT_SETTINGS.filesPanel,
    webLinks: WEB_LINK_TARGETS.find((target) => target === record["webLinks"]) ?? DEFAULT_SETTINGS.webLinks,
    reuseExternalLinkTab: typeof record["reuseExternalLinkTab"] === "boolean" ? record["reuseExternalLinkTab"] : DEFAULT_SETTINGS.reuseExternalLinkTab,
    builtInBrowser: record["builtInBrowser"] === true,
    browserBlockedSites: browserBlockedSites(record["browserBlockedSites"]),
    claudeLaunchMode: CLAUDE_LAUNCH_MODES.find((mode) => mode === record["claudeLaunchMode"]) ?? DEFAULT_SETTINGS.claudeLaunchMode,
    codexLaunchMode: CODEX_LAUNCH_MODES.find((mode) => mode === record["codexLaunchMode"]) ?? DEFAULT_SETTINGS.codexLaunchMode,
    // only a name the agent's launch takes: anything else would start it on a flag nobody chose
    claudeLaunchModel: launchModel("claude", record["claudeLaunchModel"]),
    claudeLaunchEffort: CLAUDE_EFFORTS.find((level) => level === record["claudeLaunchEffort"]) ?? DEFAULT_SETTINGS.claudeLaunchEffort,
    codexLaunchModel: launchModel("codex", record["codexLaunchModel"]),
    codexLaunchEffort: CODEX_EFFORTS.find((level) => level === record["codexLaunchEffort"]) ?? DEFAULT_SETTINGS.codexLaunchEffort,
    agentBrowserTools: browserToolChoices(record["agentBrowserTools"]),
    agentHarnessTool: harnessToolSetting(record["agentHarnessTool"]),
  };
}

/**
 * Settings → Appearance → Interface font is kept in a key of its own, not in ovis:settings: a tab
 * still on an older version rewrites that record whole on its next save and would erase a field it
 * does not know (docs/development.md, Stored-format changes).
 */
export const UI_FONT_STORAGE_KEY = "ovis:ui-font";

function readUiFontFamily(): string {
  try {
    const raw = window.localStorage.getItem(UI_FONT_STORAGE_KEY);
    return raw === null ? "" : sanitizeFontFamily(JSON.parse(raw));
  } catch {
    return "";
  }
}

export const MIRROR_WRAP_STORAGE_KEY = "ovis:mirror-wrap";

function readMirrorWrap(): boolean | null {
  try {
    const raw = window.localStorage.getItem(MIRROR_WRAP_STORAGE_KEY);
    const value: unknown = raw === null ? null : JSON.parse(raw);
    return typeof value === "boolean" ? value : null;
  } catch {
    return null;
  }
}

/** A new key:
 *  the earlier `ovis:sidebar-filter` held the old default (on) on every device that saved any setting, which no
 *  choice can be told from, so it is not read. */
export const SIDEBAR_FILTER_STORAGE_KEY = "ovis:sidebar-filter-shown";

function readSidebarFilter(): boolean {
  try {
    const raw = window.localStorage.getItem(SIDEBAR_FILTER_STORAGE_KEY);
    const value: unknown = raw === null ? null : JSON.parse(raw);
    return typeof value === "boolean" ? value : DEFAULT_SETTINGS.sidebarFilter;
  } catch {
    return DEFAULT_SETTINGS.sidebarFilter;
  }
}

export const PC_LOAD_STORAGE_KEY = "ovis:pc-load";

function readPcLoad(): boolean | null {
  try {
    const raw = window.localStorage.getItem(PC_LOAD_STORAGE_KEY);
    const value: unknown = raw === null ? null : JSON.parse(raw);
    return typeof value === "boolean" ? value : null;
  } catch {
    return null;
  }
}

/** Settings → Appearance → Group agents by state and Within a state, kept in keys of their own for the same reason: an old tab's save drops a field it does not know. */
export const AGENT_GROUPS_STORAGE_KEY = "ovis:agent-groups";
export const AGENT_GROUP_SORT_STORAGE_KEY = "ovis:agent-group-sort";

function readAgentGroups(): Pick<Settings, "agentGroups" | "agentGroupSort"> {
  const read = (key: string): unknown => {
    try {
      const raw = window.localStorage.getItem(key);
      return raw === null ? null : JSON.parse(raw);
    } catch {
      return null;
    }
  };
  const { agentGroups, agentGroupSort } = sanitizeSettings({ agentGroups: read(AGENT_GROUPS_STORAGE_KEY), agentGroupSort: read(AGENT_GROUP_SORT_STORAGE_KEY) });
  return { agentGroups, agentGroupSort };
}

export const PHONE_TABS_STORAGE_KEY = "ovis:phone-tabs";

function readPhoneTabs(): PhoneTabs {
  try {
    const raw = window.localStorage.getItem(PHONE_TABS_STORAGE_KEY);
    return sanitizeSettings({ phoneTabs: raw === null ? null : JSON.parse(raw) }).phoneTabs;
  } catch {
    return DEFAULT_SETTINGS.phoneTabs;
  }
}

/** Settings → Voice input → Speech recognition, in a key of its own: an older tab's whole-record save would put it back on Auto. */
export const VOICE_ENGINE_STORAGE_KEY = "ovis:voice-engine";

function readVoiceEngine(): VoiceEngineChoice {
  try {
    const raw = window.localStorage.getItem(VOICE_ENGINE_STORAGE_KEY);
    return sanitizeSettings({ voiceEngine: raw === null ? null : JSON.parse(raw) }).voiceEngine;
  } catch {
    return DEFAULT_SETTINGS.voiceEngine;
  }
}

export const FILE_FONT_SIZE_STORAGE_KEY = "ovis:file-font-size";

export const FILE_FONT_BASE_STORAGE_KEY = "ovis:file-font-base";

function sanitizeFileFontBase(value: unknown): FileFontBase | null {
  if (typeof value !== "object" || value === null) return null;
  const { size, chat, ui } = value as Record<string, unknown>;
  const chatSize = (px: unknown): number | null => typeof px === "number" && Number.isFinite(px) ? Math.min(CHAT_FONT_MAX, Math.max(CHAT_FONT_MIN, Math.round(px))) : null;
  const base = { size: chatSize(size), chat: chatSize(chat), ui: sanitizeUiFontSize(ui) };
  return base.size === null || base.chat === null || base.ui === null ? null : { size: base.size, chat: base.chat, ui: base.ui };
}

function readFileFontBase(size: number | null): FileFontBase | null {
  try {
    const raw = window.localStorage.getItem(FILE_FONT_BASE_STORAGE_KEY);
    const base = sanitizeFileFontBase(raw === null ? null : JSON.parse(raw));
    return base !== null && base.size === size ? base : null;
  } catch {
    return DEFAULT_SETTINGS.fileFontBase;
  }
}

function readFileFont(): Pick<Settings, "fileFontSize" | "fileFontBase"> {
  const fileFontSize = readFileFontSize();
  return { fileFontSize, fileFontBase: readFileFontBase(fileFontSize) };
}

function readFileFontSize(): number | null {
  try {
    const raw = window.localStorage.getItem(FILE_FONT_SIZE_STORAGE_KEY);
    return sanitizeSettings({ fileFontSize: raw === null ? null : JSON.parse(raw) }).fileFontSize;
  } catch {
    return DEFAULT_SETTINGS.fileFontSize;
  }
}

export const COMPOSER_ARTIFACTS_STORAGE_KEY = "ovis:composer-artifacts";

function readComposerArtifacts(): boolean {
  try {
    const raw = window.localStorage.getItem(COMPOSER_ARTIFACTS_STORAGE_KEY);
    const value: unknown = raw === null ? null : JSON.parse(raw);
    return typeof value === "boolean" ? value : DEFAULT_SETTINGS.composerArtifacts;
  } catch {
    return DEFAULT_SETTINGS.composerArtifacts;
  }
}

export const EXPAND_THINKING_STORAGE_KEY = "ovis:expand-thinking";
export const FOLD_WORK_STORAGE_KEY = "ovis:fold-work";
/** Its own key: up to 0.5.0 every save wrote "ovis:terminal-images",
 *  false included, so a false there was not a choice; a true there was, and is still read. */
export const TERMINAL_IMAGES_STORAGE_KEY = "ovis:terminal-pictures";
const LEGACY_TERMINAL_IMAGES_STORAGE_KEY = "ovis:terminal-images";
export const TERMINAL_ATTACH_BUTTON_STORAGE_KEY = "ovis:terminal-attach-button";
export const TERMINAL_KEYBOARD_ON_REQUEST_STORAGE_KEY = "ovis:terminal-keyboard-on-request";
export const TERMINAL_FOLD_KEY_BAR_STORAGE_KEY = "ovis:terminal-fold-key-bar";
export const REUSE_EXTERNAL_LINK_TAB_STORAGE_KEY = "ovis:reuse-external-link-tab";
export const FILES_PANEL_STORAGE_KEY = "ovis:files-panel";
export const COMPOSER_PASTE_SEND_STORAGE_KEY = "ovis:composer-paste-send";
export const COMPOSER_BTW_STORAGE_KEY = "ovis:composer-btw";
export const SIDEBAR_CONTEXT_STORAGE_KEY = "ovis:sidebar-context";
export const FOLD_HELPERS_STORAGE_KEY = "ovis:fold-helpers";
export const SIDEBAR_AGENT_TREE_STORAGE_KEY = "ovis:sidebar-agent-tree";
export const PHONE_INBOX_STORAGE_KEY = "ovis:phone-inbox";

function readChosen(key: string): boolean | null {
  try {
    const raw = window.localStorage.getItem(key);
    const value: unknown = raw === null ? null : JSON.parse(raw);
    return typeof value === "boolean" ? value : null;
  } catch {
    return null;
  }
}

function readCustomThemes(): CustomThemes {
  try {
    return sanitizeCustomThemes(JSON.parse(window.localStorage.getItem(CUSTOM_THEMES_STORAGE_KEY) ?? "null"));
  } catch {
    return NO_CUSTOM_THEMES;
  }
}

function readChatFold(key: string, fallback: boolean): boolean {
  try {
    const raw = window.localStorage.getItem(key);
    const value: unknown = raw === null ? null : JSON.parse(raw);
    return typeof value === "boolean" ? value : fallback;
  } catch {
    return fallback;
  }
}

/**
 * Settings are saved whole, so `enterSends: true` in ovis:settings was written by any change at all,
 * not chosen; only its `false` was a choice (the old default was true), and it counts while this key holds none.
 * The record keeps the boolean an older tab reads and writes (true until chosen), but once this key holds a choice
 * the record never overrides it: a tab still on an older version rewrites the record whole with whatever it loaded,
 * so a value there may be stale, and a choice must not flip back after an unrelated save.
 */
export const ENTER_SENDS_STORAGE_KEY = "ovis:enter-sends";

function readEnterSends(record: boolean | null): boolean | null {
  try {
    const raw = window.localStorage.getItem(ENTER_SENDS_STORAGE_KEY);
    const value: unknown = raw === null ? null : JSON.parse(raw);
    if (typeof value === "boolean") return value;
  } catch {
  }
  return record === false ? false : null;
}

function coarsePointer(): boolean {
  return typeof window !== "undefined" && window.matchMedia?.("(pointer: coarse)").matches === true;
}

export function pcLoadOn(settings: Pick<Settings, "pcLoad">, _machines: readonly { state: string }[]): boolean {
  return settings.pcLoad ?? true;
}

export function phoneInboxOn(settings: Pick<Settings, "phoneInbox">): boolean {
  return settings.phoneInbox ?? false;
}

export function enterSendsOn(settings: Pick<Settings, "enterSends">, touch: boolean): boolean {
  return settings.enterSends ?? !touch;
}

export function loadSettings(): Settings {
  const stored = readStoredAppearance(() => window.localStorage);
  const settings = stored.main === null ? { ...DEFAULT_SETTINGS, theme: defaultThemeSetting() } : sanitizeSettings(stored.main.value);
  const merged = stored.themes === null ? settings : sanitizeSettings({ ...settings, ...stored.themes });
  return { ...merged, enterSends: readEnterSends(merged.enterSends), uiFontFamily: readUiFontFamily(), terminalMirrorWrap: readMirrorWrap(), sidebarFilter: readSidebarFilter(), pcLoad: readPcLoad(), phoneTabs: readPhoneTabs(), voiceEngine: readVoiceEngine(), ...readAgentGroups(), ...readFileFont(), composerArtifacts: readComposerArtifacts(),
    expandThinking: readChatFold(EXPAND_THINKING_STORAGE_KEY, DEFAULT_SETTINGS.expandThinking), foldWork: readChatFold(FOLD_WORK_STORAGE_KEY, DEFAULT_SETTINGS.foldWork),
    reuseExternalLinkTab: readChatFold(REUSE_EXTERNAL_LINK_TAB_STORAGE_KEY, DEFAULT_SETTINGS.reuseExternalLinkTab),
    filesPanel: readChatFold(FILES_PANEL_STORAGE_KEY, DEFAULT_SETTINGS.filesPanel),
    composerPasteSend: readChatFold(COMPOSER_PASTE_SEND_STORAGE_KEY, DEFAULT_SETTINGS.composerPasteSend),
    composerBtw: readChatFold(COMPOSER_BTW_STORAGE_KEY, DEFAULT_SETTINGS.composerBtw),
    sidebarContext: readChatFold(SIDEBAR_CONTEXT_STORAGE_KEY, DEFAULT_SETTINGS.sidebarContext),
    foldHelpers: readChatFold(FOLD_HELPERS_STORAGE_KEY, DEFAULT_SETTINGS.foldHelpers),
    sidebarAgentTree: readChatFold(SIDEBAR_AGENT_TREE_STORAGE_KEY, DEFAULT_SETTINGS.sidebarAgentTree),
    phoneInbox: readChosen(PHONE_INBOX_STORAGE_KEY),
    terminalImages: readChosen(TERMINAL_IMAGES_STORAGE_KEY) ?? (readChosen(LEGACY_TERMINAL_IMAGES_STORAGE_KEY) === true ? true : null),
    terminalAttachButton: readChatFold(TERMINAL_ATTACH_BUTTON_STORAGE_KEY, DEFAULT_SETTINGS.terminalAttachButton),
    terminalKeyboardOnRequest: readChatFold(TERMINAL_KEYBOARD_ON_REQUEST_STORAGE_KEY, DEFAULT_SETTINGS.terminalKeyboardOnRequest),
    terminalFoldKeyBar: readChatFold(TERMINAL_FOLD_KEY_BAR_STORAGE_KEY, DEFAULT_SETTINGS.terminalFoldKeyBar),
    customThemes: readCustomThemes(),
    markdownStyle: savedMarkdownStyle(() => window.localStorage) };
}

/** false where storage refused the write (private mode, a full quota) */
export function saveSettings(settings: Settings): boolean {
  const mirrored = sanitizeSettings(settings);
  try {
    window.localStorage.setItem(THEMES_STORAGE_KEY, JSON.stringify({
      darkTheme: mirrored.darkTheme, lightTheme: mirrored.lightTheme,
      mirror: { palette: mirrored.palette, paletteDark: mirrored.paletteDark, paletteLight: mirrored.paletteLight },
    }));
    const { uiFontFamily, terminalMirrorWrap, sidebarFilter, sidebarContext, sidebarAgentTree, phoneInbox, foldHelpers, pcLoad, voiceEngine, agentGroups, agentGroupSort, fileFontSize, fileFontBase, composerArtifacts, composerPasteSend, composerBtw, expandThinking, foldWork, reuseExternalLinkTab, filesPanel, terminalImages, terminalAttachButton, terminalKeyboardOnRequest, terminalFoldKeyBar, customThemes, markdownStyle, phoneTabs, ...main } = mirrored;
    window.localStorage.setItem(CUSTOM_THEMES_STORAGE_KEY, JSON.stringify(customThemes));
    window.localStorage.setItem(MARKDOWN_STYLE_STORAGE_KEY, JSON.stringify(markdownStyle));
    window.localStorage.setItem(VOICE_ENGINE_STORAGE_KEY, JSON.stringify(voiceEngine));
    window.localStorage.setItem(PHONE_TABS_STORAGE_KEY, JSON.stringify(phoneTabs));
    window.localStorage.setItem(UI_FONT_STORAGE_KEY, JSON.stringify(uiFontFamily));
    window.localStorage.setItem(MIRROR_WRAP_STORAGE_KEY, JSON.stringify(terminalMirrorWrap));
    window.localStorage.setItem(SIDEBAR_FILTER_STORAGE_KEY, JSON.stringify(sidebarFilter));
    window.localStorage.setItem(PC_LOAD_STORAGE_KEY, JSON.stringify(pcLoad));
    window.localStorage.setItem(AGENT_GROUPS_STORAGE_KEY, JSON.stringify(agentGroups));
    window.localStorage.setItem(AGENT_GROUP_SORT_STORAGE_KEY, JSON.stringify(agentGroupSort));
    window.localStorage.setItem(FILE_FONT_SIZE_STORAGE_KEY, JSON.stringify(fileFontSize));
    // only beside the size it was recorded for: a Reset over another tab's base must not leave that base behind
    window.localStorage.setItem(FILE_FONT_BASE_STORAGE_KEY, JSON.stringify(fileFontBase?.size === fileFontSize ? fileFontBase : null));
    window.localStorage.setItem(COMPOSER_ARTIFACTS_STORAGE_KEY, JSON.stringify(composerArtifacts));
    window.localStorage.setItem(EXPAND_THINKING_STORAGE_KEY, JSON.stringify(expandThinking));
    window.localStorage.setItem(FOLD_WORK_STORAGE_KEY, JSON.stringify(foldWork));
    window.localStorage.setItem(REUSE_EXTERNAL_LINK_TAB_STORAGE_KEY, JSON.stringify(reuseExternalLinkTab));
    window.localStorage.setItem(FILES_PANEL_STORAGE_KEY, JSON.stringify(filesPanel));
    window.localStorage.setItem(COMPOSER_PASTE_SEND_STORAGE_KEY, JSON.stringify(composerPasteSend));
    window.localStorage.setItem(COMPOSER_BTW_STORAGE_KEY, JSON.stringify(composerBtw));
    window.localStorage.setItem(SIDEBAR_CONTEXT_STORAGE_KEY, JSON.stringify(sidebarContext));
    window.localStorage.setItem(FOLD_HELPERS_STORAGE_KEY, JSON.stringify(foldHelpers));
    window.localStorage.setItem(SIDEBAR_AGENT_TREE_STORAGE_KEY, JSON.stringify(sidebarAgentTree));
    window.localStorage.setItem(PHONE_INBOX_STORAGE_KEY, JSON.stringify(phoneInbox));
    window.localStorage.setItem(TERMINAL_IMAGES_STORAGE_KEY, JSON.stringify(terminalImages));
    // the earlier key's true would come back under a reset to null
    if (window.localStorage.getItem(LEGACY_TERMINAL_IMAGES_STORAGE_KEY) !== null) window.localStorage.removeItem(LEGACY_TERMINAL_IMAGES_STORAGE_KEY);
    window.localStorage.setItem(TERMINAL_ATTACH_BUTTON_STORAGE_KEY, JSON.stringify(terminalAttachButton));
    window.localStorage.setItem(TERMINAL_KEYBOARD_ON_REQUEST_STORAGE_KEY, JSON.stringify(terminalKeyboardOnRequest));
    window.localStorage.setItem(TERMINAL_FOLD_KEY_BAR_STORAGE_KEY, JSON.stringify(terminalFoldKeyBar));
    window.localStorage.setItem(ENTER_SENDS_STORAGE_KEY, JSON.stringify(mirrored.enterSends));
    window.localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify({ ...main, enterSends: main.enterSends ?? true }));
    return true;
  } catch {
    /* private mode: preferences last for the session */
    return false;
  }
}

type TerminalColors = { background: string; foreground: string; cursor: string; selectionBackground: string };

export function saveBootRows(custom: CustomThemes): void {
  try {
    const rows = bootRows(custom);
    if (Object.keys(rows).length > 0) window.localStorage.setItem(CUSTOM_ROWS_STORAGE_KEY, JSON.stringify(rows));
    else if (window.localStorage.getItem(CUSTOM_ROWS_STORAGE_KEY) !== null) window.localStorage.removeItem(CUSTOM_ROWS_STORAGE_KEY);
  } catch { /* private mode or a full quota */ }
}

export function terminalTheme(theme: ResolvedTheme, palette: Palette = "amber"): TerminalColors {
  return { ...terminalColors(palette, theme) };
}

/** `<meta name="theme-color">` follows the panel surface so the PWA title bar matches. */
export function themeColor(theme: ResolvedTheme, palette: Palette = "amber"): string {
  return themeTableColor(palette, theme);
}

export function applyToDocument(settings: Settings, entry: DrawnTheme, language: Language): void {
  const root = document.documentElement;
  root.lang = LOCALE_TAGS[language];
  applyThemeEntry(root, entry);
  // the boot script's background (src/theme-bootstrap.ts) holds the row's surface until the stylesheet's theme
  // blocks own it; a stylesheet that never loaded leaves the page to it, kept on the row drawn now
  // (an imported row sets --bg itself, so there the stylesheet is told by a token only it sets)
  if (getComputedStyle(root).getPropertyValue(entry.vars === undefined ? "--bg" : "--pdf-page").trim() !== "") root.style.removeProperty("background-color");
  else root.style.backgroundColor = entry.bg;
  root.dataset["density"] = settings.density;
  root.dataset["chatWidth"] = settings.chatWidth;
  root.dataset["marks"] = settings.agentMarks;
  root.dataset["markdownStyle"] = settings.markdownStyle;
  const uiPx = uiFontSize(settings);
  root.style.setProperty("--ui-scale", String(fontScale(uiPx, BODY_FONT[settings.density])));
  root.style.setProperty("--chat-scale", String(fontScale(chatFontSize(settings), uiPx)));
  root.style.setProperty("--file-scale", String(fontScale(fileFontSize(settings), uiPx)));
  if (settings.fileFontSize === null) root.style.removeProperty("--file-source-scale");
  else {
    const base = settings.fileFontBase?.size === settings.fileFontSize ? settings.fileFontBase : null;
    const scale = base === null ? fontScale(settings.fileFontSize, chatFontSize(settings)) : fontScale(settings.fileFontSize, base.chat) * fontScale(base.ui, uiPx);
    root.style.setProperty("--file-source-scale", String(scale));
  }
  const uiFont = uiFontStack(settings.uiFontFamily, language);
  if (uiFont === null) root.style.removeProperty("--font-ui");
  else root.style.setProperty("--font-ui", uiFont);
  const chatFont = chatFontStack(settings.chatFontFamily);
  if (chatFont === null) root.style.removeProperty("--font-chat");
  else root.style.setProperty("--font-chat", chatFont);
}

interface SettingsContextValue {
  settings: Settings;
  resolvedTheme: ResolvedTheme;
  resolvedEntry: DrawnTheme;
  resolvedLanguage: Language;
  /** this tab's settings as of now, a change React has not drawn yet included: what runs outside a render (a document from the server, a save's answer) judges against this, never against the last render */
  own: () => Settings;
  /** `changed` is called at once after each change to this tab's settings, before React draws it; the result stops it */
  watch: (changed: () => void) => () => void;
  /** a function is handed what is stored now (another tab's saved change included) */
  update: (patch: Partial<Settings> | ((current: Settings) => Partial<Settings>)) => void;
}

const SettingsContext = createContext<SettingsContextValue | null>(null);

export function SettingsProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState<Settings>(loadSettings);
  // This tab's settings as of now. `update` and the storage handler advance it at once and then hand it to React to
  // draw: a change is never worked out in an updater, which React runs later, and twice under StrictMode.
  const held = useRef<Settings>(settings);
  const watchers = useRef(new Set<() => void>());
  const advance = useCallback((next: Settings): void => {
    held.current = next;
    setSettings(next);
    for (const changed of [...watchers.current]) changed();
  }, []);
  const stored = useRef<Settings>(settings);
  const [systemDark, setSystemDark] = useState(() => resolveTheme("system") === "dark");

  useEffect(() => {
    const onStorage = (event: StorageEvent): void => {
      if (event.storageArea !== window.localStorage || (event.key !== SETTINGS_STORAGE_KEY && event.key !== ENTER_SENDS_STORAGE_KEY && event.key !== VOICE_ENGINE_STORAGE_KEY && event.key !== PHONE_TABS_STORAGE_KEY && event.key !== null)) return;
      // the recognition another tab chose: audio must not keep going where this tab last sent it; the phone's tab
      // placement is the device's, so a tab still open moves its row with the one that changed it
      const { shortcutOverrides, enterSends, voiceEngine, phoneTabs } = loadSettings();
      stored.current = { ...stored.current, shortcutOverrides, enterSends, voiceEngine, phoneTabs };
      advance({ ...held.current, shortcutOverrides, enterSends, voiceEngine, phoneTabs });
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [advance]);

  useEffect(() => {
    const query = window.matchMedia?.(DARK_QUERY);
    if (!query) return;
    const onChange = (event: MediaQueryListEvent): void => setSystemDark(event.matches);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);

  const resolvedTheme: ResolvedTheme = settings.theme === "system" ? (systemDark ? "dark" : "light") : settings.theme;

  const resolvedEntry = drawnTheme(settings, resolvedTheme);
  const customKey = JSON.stringify(settings.customThemes);
  useEffect(() => saveBootRows(sanitizeCustomThemes(JSON.parse(customKey))), [customKey]);

  const [browserLanguages, setBrowserLanguages] = useState<readonly string[]>(() => (typeof navigator !== "undefined" ? navigator.languages : []));
  useEffect(() => {
    const onChange = (): void => setBrowserLanguages([...navigator.languages]);
    window.addEventListener("languagechange", onChange);
    return () => window.removeEventListener("languagechange", onChange);
  }, []);
  const resolvedLanguage = resolveLanguage(settings.language, browserLanguages);
  // helpers outside React read this during the same render, so it is set before the children render
  setCurrentLanguage(resolvedLanguage);

  useEffect(() => {
    applyToDocument(settings, resolvedEntry, resolvedLanguage);
  }, [settings, resolvedEntry, resolvedLanguage]);

  const update = useCallback((patch: Partial<Settings> | ((current: Settings) => Partial<Settings>)) => {
    const current = held.current;
    const differs = (key: string, value: unknown, from: Settings): boolean => JSON.stringify(value) !== JSON.stringify(from[key as keyof Settings]);
    const readable = (): boolean => {
      try {
        const raw = window.localStorage.getItem(SETTINGS_STORAGE_KEY);
        if (raw === null) return false;
        JSON.parse(raw);
        return true;
      } catch { return false; }
    };
    const latest = (): Settings => !readable() ? current
      : sanitizeSettings({ ...loadSettings(), ...Object.fromEntries(Object.entries(current).filter(([key, value]) => differs(key, value, stored.current))) });
    const next = sanitizeSettings({ ...current, ...(typeof patch === "function" ? patch(latest()) : patch) });
    const changed = Object.fromEntries(Object.entries(next).filter(([key, value]) => differs(key, value, current) || differs(key, value, stored.current)));
    if (saveSettings(sanitizeSettings({ ...loadSettings(), ...changed }))) stored.current = next;
    advance(next);
  }, [advance]);
  const own = useCallback((): Settings => held.current, []);
  const watch = useCallback((changed: () => void): (() => void) => {
    watchers.current.add(changed);
    return () => { watchers.current.delete(changed); };
  }, []);

  const value = useMemo(() => ({ settings, resolvedTheme, resolvedEntry, resolvedLanguage, own, watch, update }), [settings, resolvedTheme, resolvedEntry, resolvedLanguage, own, watch, update]);
  return createElement(SettingsContext.Provider, { value }, children);
}

export function useSettings(): SettingsContextValue {
  const value = useContext(SettingsContext);
  if (value === null) throw new Error("useSettings needs a SettingsProvider above it");
  return value;
}

export const PANE_VIEW_KEY_PREFIX = "ovis:view:";

export function forgetPaneViews(given?: Pick<Storage, "length" | "key" | "removeItem">): number {
  const keys: string[] = [];
  try {
    // inside the try: reading localStorage itself throws where storage is blocked
    const storage = given ?? window.localStorage;
    for (let index = 0; index < storage.length; index++) {
      const key = storage.key(index);
      if (key?.startsWith(PANE_VIEW_KEY_PREFIX)) keys.push(key);
    }
    for (const key of keys) storage.removeItem(key);
  } catch {
    /* private mode: there is nothing remembered to forget */
  }
  return keys.length;
}
import { HARNESS_TOOL_DEFAULT, harnessToolSetting, type HarnessToolSetting } from "../../shared/harness-tool.ts";
