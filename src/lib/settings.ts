/**
 * User preferences: one localStorage record, one React context, applied to the
 * document as `data-theme` / `data-density` / `data-chat-width` attributes that src/styles.css keys
 * its token overrides on. xterm reads no CSS, so `terminalTheme()` mirrors the
 * `--term-*` tokens of each theme for PaneTerminal's theme object.
 */

import type { TelemetrySettings } from "../../shared/telemetry.ts";
import { MAX_PINS, mirrorPalette, SHARED_SETTING_KEYS, type SharedSettingKey } from "../../shared/preferences.ts";
import { createContext, createElement, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { DEFAULT_THEME, terminalColors, themeColor as themeTableColor, type DrawnTheme, type ThemeId } from "./themes.ts";
import { bootRows, drawnTheme, NO_CUSTOM_THEMES, sanitizeCustomThemes, type CustomThemes } from "./customThemes.ts";
import { LANGUAGE_SETTINGS, LOCALE_TAGS, resolveLanguage, setCurrentLanguage, type Language, type LanguageSetting } from "./i18n.ts";
import type { AlertPrefs, DoneAlerts } from "../../shared/notify-policy.ts";
import { chatFontStack, sanitizeFontFamily } from "./fontFamily.ts";
import { fontScale, sanitizeUiFontSize, uiFontStack } from "./typography.ts";
import { sanitizeKeyBarExtras, type KeyBarExtra } from "./keys.ts";
import { DEFAULT_KEY_BAR_ITEMS, migrateKeyBarItems, sanitizeKeyBarItems, type KeyBarItem } from "./keyBar.ts";
import { applyThemeEntry, CUSTOM_ROWS_STORAGE_KEY, CUSTOM_THEMES_STORAGE_KEY, DARK_QUERY, defaultThemeSetting, readStoredAppearance, resolveTheme, sanitizeAppearance, SETTINGS_STORAGE_KEY, THEMES_STORAGE_KEY, type ResolvedTheme, type ThemeSetting } from "./themeBoot.ts";

export { resolveTheme };
export type { ResolvedTheme, ThemeSetting };
export type Density = "compact" | "comfortable";
/** One line names the workspace; two lines say what its pane is doing, with the workspace under it. */
export type SidebarRows = "one" | "two";
/** the Agents list's order: herdr's workspace order, or a waiting agent first and then the latest change */
export type AgentOrder = "waiting" | "workspace" | "activity";
/** Settings → Within a state: how each state group of the Agents list is ordered (lib/agentRoster.ts) */
export const AGENT_GROUP_SORTS = ["wait", "recent", "name"] as const;
export type AgentGroupSort = (typeof AGENT_GROUP_SORTS)[number];
/** how agent logos are drawn: in their brand colors, or without color: Claude's in the text color, the others in grey (data-marks on <html>) */
export type AgentMarks = "color" | "mono";
/** what the plan meters count: the share of a limit used, or what is left of it */
export type UsageCount = "used" | "left";
/** the limit a plan meter shows: the plan's week, or its short session (5 hours on Claude and Codex) */
export type UsageGlance = "week" | "session";
/** amber: the herdr look (the default before codex); charcoal: neutral Ghostty-style dark;
 *  catppuccin: Catppuccin Mocha in dark, Latte in light. A record naming a palette that was removed
 *  (report, lilac, forest) loads as amber. */
export type Palette = ThemeId;
/** the chat lane's widest: the transcript, the composer column and the held list share it (--chat-w in src/styles.css).
 *  narrow: 820px; default: follows the pane, up to 60rem (chatLaneWidth); wide: 72rem; full: the pane, less the gutters */
export type ChatWidth = "narrow" | "default" | "wide" | "full";
export const CHAT_WIDTHS: readonly ChatWidth[] = ["narrow", "default", "wide", "full"];
/** the microphone button. auto: in the chat composer off a phone, and only where dictation can work;
 *  on: there, on a phone and in the terminal input line, disabled with its reason where it cannot work; off: nowhere */
export type VoiceButton = "auto" | "on" | "off";
export const VOICE_BUTTONS: readonly VoiceButton[] = ["auto", "on", "off"];
/** what turns speech into text. auto: the server's API key when one is saved, else the browser's
 *  speech recognition; browser and server hold to the one chosen, and the mic says why when it cannot */
export type VoiceEngineChoice = "auto" | "browser" | "server";
export const VOICE_ENGINES: readonly VoiceEngineChoice[] = ["auto", "browser", "server"];
/**
 * The languages dictation can be set to, as BCP 47 tags (SpeechRecognition.lang; the transcribe
 * route takes the first subtag). Auto can also use a browser language outside this list when
 * its primary subtag is two letters and the UI is not translated into it.
 */
export const DICTATION_LANGUAGES = [
  "ar-SA", "cs-CZ", "da-DK", "de-DE", "el-GR", "en-GB", "en-US", "es-ES", "fi-FI", "fr-FR", "he-IL", "hi-IN",
  "hu-HU", "id-ID", "it-IT", "ja-JP", "ko-KR", "nb-NO", "nl-NL", "pl-PL", "pt-BR", "pt-PT", "ro-RO", "ru-RU",
  "sk-SK", "sv-SE", "th-TH", "tr-TR", "uk-UA", "vi-VN", "zh-CN", "zh-TW",
] as const;
export type DictationLanguage = "auto" | (typeof DICTATION_LANGUAGES)[number];
/** the lens a pane opens in until it is switched there: auto is chat for an agent on a touch screen, else terminal */
export type DefaultView = "auto" | "chat" | "terminal";
/** Where a chosen file text size started: the chat's and the interface's sizes when it was chosen, with the size they
 *  were recorded for, so a size written without them (an older tab) is never paired with them. */
export interface FileFontBase { size: number; chat: number; ui: number }
import { sanitizeShortcutOverrides, type ShortcutOverrides } from "./shortcutBindings.ts";
import type { StatusIndicators } from "./status.ts";
import { sanitizeGroupNames, sanitizeGroupOf } from "./namedAgentGroups.ts";
import { WEB_LINK_TARGETS, type WebLinkTarget } from "./webPanel.ts";
import { FILE_OPEN_TARGETS, type FilePresentation } from "./filePresentation.ts";
import { CLAUDE_EFFORTS, CLAUDE_LAUNCH_MODES, CODEX_EFFORTS, CODEX_LAUNCH_MODES, launchChoiceFault, type ClaudeLaunchMode, type CodexLaunchMode } from "./agentLaunchMode.ts";

export interface Settings {
  terminalInputMode: "auto" | "line" | "direct";
  /** Kept for migration of the old fixed-order bar. New layouts use keyBarItems. */
  keyBarExtras: KeyBarExtra[];
  /** This device's terminal keys, sticky modifiers and exact chords, in display order. */
  keyBarItems: KeyBarItem[];
  /** the touch key bar's second row (Esc, Tab, | ~ / -) and its arrow pad, opened from the bar's own toggle */
  keyBarExpanded: boolean;
  shortcutOverrides: ShortcutOverrides;
  /** herdr's prefix, then a key its config.toml binds, runs the app's action for it (lib/herdrKeys.ts); off until chosen,
   *  since the prefix (Ctrl+B by default) then no longer reaches the pane */
  herdrPrefixKeys: boolean;
  theme: ThemeSetting;
  density: Density;
  /** How much a workspace row says: its name, or its pane's title over its place. */
  sidebarRows: SidebarRows;
  /** the Filter field above the sidebar's lists (components/MachineSidebar.tsx), off until chosen; off, the command palette's
   *  Filter workspaces and agents still opens it for the time it holds words or the focus */
  sidebarFilter: boolean;
  /** the composer's context ring on each agent row of the sidebar (components/Sidebar.tsx ContextBadge); off until chosen */
  sidebarContext: boolean;
  /** an agent's helpers folded under its row in the Agents list (components/AgentSidebar.tsx); off until chosen */
  foldHelpers: boolean;
  /** each workspace's agents listed under its row in the PCs list (components/Sidebar.tsx), a PC > workspace > agent tree; off until chosen */
  sidebarAgentTree: boolean;
  /** the selected PC's CPU, memory and fullest disk in the status bar (components/MachineStats.tsx PcLoadStatus); null until
   *  chosen on this device, which keeps it off (pcLoadOn) */
  pcLoad: boolean | null;
  /** The Agents list's order. Activity is display-only: herdr's own order never changes. */
  agentOrder: AgentOrder;
  /** this device lists the agents above the workspaces, in groups by state (lib/agentRoster.ts groupAgentRows); off, the list is as agentOrder says */
  agentGroups: boolean;
  /** the order within each state group while agentGroups is on */
  agentGroupSort: AgentGroupSort;
  /** Agent logos: brand colors, or without color, so a list of one agent is not a stripe of tiles */
  agentMarks: AgentMarks;
  /** Settings -> Lock pinned agents (experimental): the Agents list offers Lock agent, and the locks below hold; off, none does */
  agentLocks: boolean;
  /** Settings -> Experimental -> OpenCode: subagent ends from their session: the server ends an OpenCode subagent where its parent session's record does (server/opencode-subagents.ts); off, by its own rows */
  opencodeParentEnds: boolean;
  /** Settings -> Experimental -> OMP on macOS herdr-core: the server reads an omp pane's chat from the session its omp holds open, through lsof (server/omp.ts ompHeldOpen); off, the chat there falls back to the terminal */
  ompHeldFiles: boolean;
  /** Settings -> Experimental -> PCs: start a replaced server again: an install over SSH that replaced a server started by hand, and failed or was cancelled, starts that one again as it was (server/pc-install.ts); off, it stays stopped */
  restoreReplacedServer: boolean;
  /** pinned agent rows this app does not close (lib/paneLocks.ts), by their pin key; a lock holds only while its row is pinned */
  lockedAgents: string[];
  /** Settings -> Named agent groups: the Agents list splits into the groups below, which New workspace and New tab offer (lib/namedAgentGroups.ts); off, none is drawn or offered */
  agentNamedGroups: boolean;
  /** the groups' names, in the order the list draws them */
  agentGroupNames: string[];
  /** each grouped agent row's group, by its pin key */
  agentGroupOf: Record<string, string>;
  /** the sidebar's state marks: this app's own, or herdr's dots or symbols, as its `[ui] status_indicators` (lib/status.ts) */
  statusIndicators: StatusIndicators;
  /** the chrome color family, keyed as data-palette in src/styles.css */
  palette: Palette;
  /** Legacy mirrors for older app versions. */
  paletteLight: Palette;
  paletteDark: Palette;
  darkTheme: ThemeId;
  lightTheme: ThemeId;
  /** the themes imported from a file, and the one drawn on either side in place of that side's theme above (lib/customThemes.ts) */
  customThemes: CustomThemes;
  /** xterm font size in px */
  terminalFontSize: number;
  /** mouse reports sent to herdr per wheel event in the terminal: 1 is what xterm sends by itself */
  terminalWheelSpeed: number;
  /** fonts tried before the built-in terminal stack, as a CSS font-family list; "" keeps the built-in one */
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
  /** on a touch screen, an Attach files button in the terminal's input line and a key in the key bar while typing
   *  straight into the grid pick files to store beside the pane (POST /api/pane/image); off by default */
  terminalAttachButton: boolean;
  /** on a touch screen, the soft keyboard comes up for the terminal only from the key bar's keyboard control:
   *  while it is down, the input line and xterm's field carry inputmode="none" (#1635). Off by default. */
  terminalKeyboardOnRequest: boolean;
  /** on a touch screen in Input line mode, the key bar's row stays folded under the line until its Terminal keys
   *  button opens it, and the Input line / Direct typing key sits in the line (#1531). Off by default. */
  terminalFoldKeyBar: boolean;
  /** a pane whose grid this device does not size and is wider than this screen (a mirrored pane: a Windows
   *  PC, no terminal attach; an attached pane it only watches, or holds under the keyboard, at the grid
   *  another device gave the pty) is drawn folded to the screen's width (lib/terminalFold.ts); false draws
   *  the grid at its original width, panned sideways. Chosen from the pane menu, for this device; null
   *  until then: folded on a narrow screen (MIRROR_WRAP_QUERY), the original width elsewhere. The name and
   *  its `ovis:mirror-wrap` key are kept from when only mirrors folded, so a choice made then still holds. */
  terminalMirrorWrap: boolean | null;
  /** a desktop tab out of use for a moment detaches its pane (PaneTerminal's release) and only watches it, so herdr's own
   *  window keeps the pane at its size; paused where the server cannot watch. Off: the tab keeps the pane and its size. */
  releasePaneAway: boolean;
  /** a plain drag in a Codex pane is Codex's, which selects and scrolls its own history (lib/useTerminalMount.ts);
   *  off: Ovis's selection, which stops at the screen's edge but copies on every device */
  codexDrag: boolean;
  /** this device opens the pane herdr's own focus moves to (a `pane-focused` frame from the selected PC), as
   *  herdr's window does after `herdr tab focus` or a click there; off: only this device's own picks move it */
  followHerdrFocus: boolean;
  /** a mouse resting on the collapsed sidebar's toggle shows the sidebar over the pane for a moment (lib/sidebarPeek.ts, #2588) */
  sidebarPeek: boolean;
  /** workspaces a launcher tagged `role=background` stand after the others under a folded heading (components/Sidebar.tsx); off until chosen */
  sidebarBackgroundWorkspaces: boolean;
  /** chat text size in px (its body text; the rest scales with it); null follows the interface size */
  chatFontSize: number | null;
  /** fonts tried before the UI font in the chat's prose (code stays mono), as a CSS font-family list; "" keeps the UI font */
  chatFontFamily: string;
  /** a file's text size in px in the file viewer and reader (a Markdown preview's body text, the source scaled with it);
   *  null follows the chat's size, and leaves the source at the interface's */
  fileFontSize: number | null;
  /** the chat's and the interface's sizes when fileFontSize was chosen: the source scales by fileFontSize over the chat's
   *  and by the interface's then over now, so a step moves it with the preview and a later chat or interface size leaves
   *  it be; null, or one recorded for another size (none chosen, an older tab's size), reads the sizes of now */
  fileFontBase: FileFontBase | null;
  /** the interface's body size in px (--fs-md; every other --fs-* scales with it as --ui-scale); null follows the density.
   *  The chat follows it until it has a size of its own; the terminal keeps terminalFontSize */
  uiFontSize: number | null;
  /** fonts tried before the built-in interface stack (--font-ui, lib/typography.ts), as a CSS font-family list; "" keeps
   *  the built-in one. Everything set in --font-ui follows, the chat's prose included until it has a font of its own */
  uiFontFamily: string;
  /** how wide the chat lane may run on a large screen, keyed as data-chat-width in src/styles.css; default follows the pane
   *  (chatLaneWidth, written by lib/chatLane.ts); a narrower pane is never affected */
  chatWidth: ChatWidth;
  /** true: Enter sends in the composer, Shift+Enter breaks the line; false: Ctrl/Cmd+Enter sends. Chosen in
   *  Settings for this device; null until then: Return breaks the line on a touch screen, as in the ChatGPT and
   *  Claude apps, and Enter sends elsewhere (enterSendsOn). Kept in a key of its own (ENTER_SENDS_STORAGE_KEY) */
  enterSends: boolean | null;
  /** true: a message sent while the agent works goes by itself when the turn ends; false: it waits for Send now */
  autoSendQueued: boolean;
  /** true: a tab herdr still names by its number shows a few words of its first message (lib/tabLabels.ts); false keeps tabs as they are */
  autoTabNames: boolean;
  /** the Artifacts chip in a Claude Code pane's composer, listing the pages its session published; off until chosen,
   *  so the composer's row stays minimal */
  composerArtifacts: boolean;
  /** a Paste and send button in the chat's composer, sending this device's clipboard text as a message (#2493); off until
   *  chosen, so the composer's row stays minimal */
  composerPasteSend: boolean;
  /** the Side conversations chip in an OMP pane's composer, listing what was asked and answered with `/btw`; off until
   *  chosen, so the composer's row stays minimal */
  composerBtw: boolean;
  /** on a touch screen, a chip above the message box offers the prompt the agent suggests next.
   * Not `showSuggestionChip`: that key was on by default until 0.4.9 and is still stored on phones */
  suggestionChip: boolean;
  /** show the agent's folded reasoning blocks in the chat view */
  showThinking: boolean;
  /** the reasoning showThinking shows starts open instead of folded (#2346); a row the reader opens or folds stays so for its message */
  expandThinking: boolean;
  /** a turn's work blocks start folded to their head line, the running one included, but the one that waits on the user (#2228);
   *  a block the reader opens or folds stays so for its message */
  foldWork: boolean;
  /** request a screen wake lock while a pane is open in this visible tab */
  keepScreenOn: boolean;
  /** UI language; `system` follows the browser (src/lib/i18n.ts) */
  language: LanguageSetting;
  /** alerts on this device at all: the bell turns them off (push subscription dropped) and on */
  alertsOn: boolean;
  /** alert this device when an agent waits on the user (shared/notify-policy.ts AlertPrefs) */
  alertInput: boolean;
  /** alert this device when a turn finishes: never, after a long one, or every one */
  alertDone: DoneAlerts;
  /** an open tab chimes for the same alerts (lib/alertSound.ts), heard also when a Focus silences notifications; off until chosen */
  alertSound: boolean;
  /** one-tap replies above the composer, in order; blank ones are kept while being typed, never shown */
  quickReplies: string[];
  /** whether the quick replies show above the composer at all */
  showQuickReplies: boolean;
  /** the plan meters beside Settings in the sidebar (GET /api/usage); off until chosen, as it sends this PC's sign-ins out */
  showUsage: boolean;
  usageCount: UsageCount;
  usageGlance: UsageGlance;
  /** every pane's lens until switched in that pane; changing it puts every pane back on it */
  defaultView: DefaultView;
  /** the plan meters' order by ProviderUsage.key; accounts not in it follow as the server lists them */
  usageOrder: string[];
  /** accounts left out of the plan meters, strip and popover alike, by ProviderUsage.key */
  usageHidden: string[];
  /** the microphone button in the composer and the terminal input line; nothing is recorded until it is pressed */
  voiceInput: VoiceButton;
  /** the language dictation listens for; auto: the UI language's, or the browser's the UI lacks (src/lib/voice.ts dictationLocale) */
  voiceLanguage: DictationLanguage;
  voiceEngine: VoiceEngineChoice;
  voicePolishChat: boolean;
  /** off by default: a terminal line is usually a command, kept as spoken */
  voicePolishTerminal: boolean;
  /** the file viewer wraps long lines instead of scrolling sideways */
  wrapCode: boolean;
  /** off by default: the file viewer offers Edit for a text file in the pane's folder, saved after a confirm (#771) */
  editTextFiles: boolean;
  /** off by default: a file a tab switch leaves behind shows again when an in-app switch comes back to its tab (#3179) */
  reopenFileOnReturn: boolean;
  /** a repository diff as one column of old and new lines, or the two side by side (a phone shows one column either way) */
  diffStyle: DiffStyle;
  /** where a file opens from the chat, terminal or Files: the popup, or beside the pane on a wide window (lib/filePresentation.ts) */
  fileOpen: FilePresentation;
  /** off by default: on a wide window, Files opens as a panel beside the pane (right) instead of a dialog */
  filesPanel: boolean;
  /** where a click on a web address opens it: a new tab, or the panel beside the pane (lib/webPanel.ts); Shift opens the other one */
  webLinks: WebLinkTarget;
  /** when a web address opens outside Ovis, replace one tab instead of opening another tab each time */
  reuseExternalLinkTab: boolean;
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
}

export const DIFF_STYLES = ["unified", "split"] as const;
export type DiffStyle = (typeof DIFF_STYLES)[number];

/** Raw custom text, key combinations and account keys are never copied. Requiring every other
 * Settings field in the projection makes a new field require an explicit collection decision.
 * keyBarExpanded, herdrPrefixKeys, agentLocks, lockedAgents, opencodeParentEnds, ompHeldFiles, restoreReplacedServer, the named agent groups, fileOpen, reopenFileOnReturn, webLinks, reuseExternalLinkTab, the launch modes, followHerdrFocus, sidebarPeek, sidebarBackgroundWorkspaces, codexDrag, autoTabNames, composerArtifacts, composerPasteSend, composerBtw, terminalMirrorWrap, terminalImages, terminalAttachButton, terminalKeyboardOnRequest, terminalFoldKeyBar, sidebarFilter, sidebarContext, sidebarAgentTree, foldHelpers, pcLoad, voiceEngine, the agent groups, the
 * interface font, the file text size and the folds its blocks start in are not collected: the telemetry schema
 * (shared/telemetry.ts) does not carry them. */
type TelemetrySourceSettings = Omit<Settings,
  "keyBarExtras" | "keyBarItems" | "keyBarExpanded" | "shortcutOverrides" | "herdrPrefixKeys" | "terminalFontFamily" | "chatFontFamily" | "uiFontFamily"
  | "quickReplies" | "agentLocks" | "lockedAgents" | "opencodeParentEnds" | "ompHeldFiles" | "restoreReplacedServer" | "agentNamedGroups" | "agentGroupNames" | "agentGroupOf" | "usageOrder" | "usageHidden" | "fileOpen" | "filesPanel" | "webLinks" | "reuseExternalLinkTab" | "claudeLaunchMode" | "codexLaunchMode"
  | "claudeLaunchModel" | "claudeLaunchEffort" | "codexLaunchModel" | "codexLaunchEffort"
  | "followHerdrFocus" | "sidebarPeek" | "sidebarBackgroundWorkspaces" | "codexDrag" | "composerArtifacts" | "composerPasteSend" | "composerBtw" | "terminalMirrorWrap" | "sidebarFilter" | "sidebarContext" | "sidebarAgentTree" | "foldHelpers" | "pcLoad"
  | "expandThinking" | "foldWork" | "customThemes" | "autoTabNames" | "voiceEngine" | "agentGroups" | "agentGroupSort" | "terminalImages" | "terminalAttachButton"
  | "terminalKeyboardOnRequest" | "terminalFoldKeyBar" | "fileFontSize" | "fileFontBase" | "editTextFiles" | "reopenFileOnReturn">;

/** Compare structured custom settings by content against this app's built-in defaults. */
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
    // Settings no longer has an In the app row: in-app alerts always drop in, and telemetry keeps the field
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
    // Settings no longer offers the width (the preview is the chat's readable lane); the schema keeps the field
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

/**
 * Which settings every browser of this server shares (shared/preferences.ts, lib/preferencesSync.ts)
 * and which stay this device's: its screen, keyboard, terminal, alerts and microphone. A new setting
 * must be placed here, or the build fails; when in doubt it is the device's.
 */
export const SETTING_SCOPE = {
  theme: "shared", palette: "shared", darkTheme: "shared", lightTheme: "shared", language: "shared", sidebarRows: "shared", agentOrder: "shared",
  agentMarks: "shared", agentLocks: "shared", lockedAgents: "shared", opencodeParentEnds: "shared", ompHeldFiles: "shared", restoreReplacedServer: "shared", agentNamedGroups: "shared", agentGroupNames: "shared", agentGroupOf: "shared", autoSendQueued: "shared", autoTabNames: "shared", showThinking: "shared", quickReplies: "shared",
  showQuickReplies: "shared", showUsage: "shared", usageCount: "shared",
  usageGlance: "shared", usageOrder: "shared", usageHidden: "shared", defaultView: "device", suggestionChip: "device",
  terminalInputMode: "device", keyBarExtras: "device", keyBarItems: "device", keyBarExpanded: "device", shortcutOverrides: "device", herdrPrefixKeys: "device", density: "device",
  terminalFontSize: "device",
  terminalWheelSpeed: "device", terminalFontFamily: "device", paneClipboard: "device", releasePaneAway: "device",
  // a phone has less memory for decoded pictures than a desk
  terminalImages: "device",
  // a phone's picker, not a desk's drop
  terminalAttachButton: "device",
  // a phone's soft keyboard is no desk's
  terminalKeyboardOnRequest: "device",
  // a phone's key row, as the keyboard above
  terminalFoldKeyBar: "device",
  // a phone folds a wide mirror, a desk's window may draw it whole
  terminalMirrorWrap: "device",
  // a desk that follows herdr's focus must not move a phone open on another pane
  followHerdrFocus: "device",
  // a desk's mouse, where Codex's copy reaches or not
  codexDrag: "device",
  // a desk's mouse, which a phone has not
  sidebarPeek: "device",
  // a phone's short list may set the workers apart while a desk keeps herdr's order, as with the filter
  sidebarBackgroundWorkspaces: "device",
  chatFontSize: "device", chatFontFamily: "device", fileFontSize: "device", fileFontBase: "device", uiFontSize: "device", uiFontFamily: "device", chatWidth: "device", enterSends: "device",
  // the chat's starting folds are this screen's, as its width: a phone may fold the work a desk keeps open
  expandThinking: "device", foldWork: "device",
  // a desk's composer button: a phone never shows it
  // the composer's row is this screen's: a phone may keep it bare while a desk shows the chip
  composerArtifacts: "device",
  composerPasteSend: "device",
  composerBtw: "device",
  // a desk with a keyboard may do without the field a phone keeps, as with the PCs it shows (lib/hiddenMachines.ts)
  sidebarFilter: "device",
  // a phone's narrow rows may do without the ring a desk shows, as with the filter
  sidebarContext: "device",
  // a phone's short list may fold the helpers a desk lists, as with the ring
  foldHelpers: "device",
  // a phone's short drawer may keep the flat list a desk trades for the tree, as with the ring
  sidebarAgentTree: "device",
  // a phone's narrow sidebar may do without the line a desk keeps, as with the filter
  pcLoad: "device",
  // a phone may group its agents by state while a desk keeps herdr's order, as with the filter
  agentGroups: "device", agentGroupSort: "device",
  keepScreenOn: "device", alertsOn: "device", alertInput: "device", alertDone: "device", alertSound: "device",
  paletteLight: "device", paletteDark: "device", statusIndicators: "device",
  voiceInput: "device", voiceLanguage: "device", voiceEngine: "device", voicePolishChat: "device", voicePolishTerminal: "device",
  // Viewer layout follows this screen, as chatWidth does.
  wrapCode: "device", editTextFiles: "device", reopenFileOnReturn: "device", diffStyle: "device", fileOpen: "device", filesPanel: "device", webLinks: "device", reuseExternalLinkTab: "device",
  // a new agent starts the same way whichever device opened it
  claudeLaunchMode: "shared", codexLaunchMode: "shared",
  claudeLaunchModel: "shared", claudeLaunchEffort: "shared", codexLaunchModel: "shared", codexLaunchEffort: "shared",
  // a theme imported on one device is there to pick on the others, as the side's theme is
  customThemes: "shared",
} as const satisfies Record<keyof Settings, "shared" | "device">;

/** The shared part of `settings`, by the names shared/preferences.ts lists. */
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
  // the startup default (themeBoot.ts defaultThemeSetting): Reset puts back what a fresh device is drawn in
  theme: "system",
  density: "comfortable",
  sidebarRows: "one",
  sidebarFilter: false,
  sidebarContext: false,
  foldHelpers: false,
  sidebarAgentTree: false,
  pcLoad: null,
  // the Agents list's order (the workspace list keeps herdr's): the agents that need you first, the resting ones folded
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
  voiceInput: "auto",
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
  claudeLaunchMode: "default",
  codexLaunchMode: "default",
  claudeLaunchModel: "",
  claudeLaunchEffort: "",
  codexLaunchModel: "",
  codexLaunchEffort: "",
};

export const QUICK_REPLIES_MAX = 12;
/** accounts the usage order and hiding remember; more are a hand-edited record */
export const USAGE_KEYS_MAX = 64;

/** A new agent's model from Settings > Agents: one name its `--model` takes, trimmed, or "" for its own. */
function launchModel(kind: "claude" | "codex", value: unknown): string {
  const model = typeof value === "string" ? value.trim() : "";
  return launchChoiceFault(kind, { model }) === null ? model : "";
}

/** A list of usage keys: strings only, each once, bounded. */
function usageKeys(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((key): key is string => typeof key === "string" && key.length > 0 && key.length <= 512))].slice(0, USAGE_KEYS_MAX);
}
export const QUICK_REPLY_MAX_CHARS = 200;

/**
 * A record from before the button had a place of its own holds a boolean: on stays on. Its off
 * was also what a device that never chose held, so it follows the default.
 */
function voiceButton(value: unknown): VoiceButton {
  if (value === true) return "on";
  return VOICE_BUTTONS.includes(value as VoiceButton) ? value as VoiceButton : DEFAULT_SETTINGS.voiceInput;
}

/** Whether an input asks for dictation at all: auto leaves the terminal input line and a phone's composer alone. */
export function wantsVoiceInput(setting: VoiceButton, mode: "chat" | "terminal", phone: boolean): boolean {
  return setting === "on" || (setting === "auto" && mode === "chat" && !phone);
}

/** The replies worth a button: what the list holds, without the blank ones still being written. */
export function quickReplyButtons(settings: Settings): string[] {
  return settings.quickReplies.filter((reply) => reply.trim() !== "");
}

/** This device's alert choices, as the server keeps them with its push subscription. */
export function alertPrefs(settings: Settings): AlertPrefs {
  return { input: settings.alertInput, done: settings.alertDone };
}

export const TERMINAL_FONT_MIN = 10;
export const TERMINAL_FONT_MAX = 22;
export const TERMINAL_WHEEL_SPEED_MIN = 1;
export const TERMINAL_WHEEL_SPEED_MAX = 10;

export const CHAT_FONT_MIN = 11;
/** The chat's history page size, in prompts (one user turn and its answer each): older turns load a page at a time. */
export const HISTORY_PROMPTS = 10;

export const CHAT_FONT_MAX = 24;
/** each density's body size, --fs-md in src/styles.css: the interface's size when none is chosen, and through it the chat's */
const BODY_FONT: Record<Density, number> = { comfortable: 14, compact: 13 };

function clampFont(size: number): number {
  return Math.min(TERMINAL_FONT_MAX, Math.max(TERMINAL_FONT_MIN, Math.round(size)));
}

/** The interface's body text size in px: the chosen one, or the density's. */
export function uiFontSize(settings: Settings): number {
  return settings.uiFontSize ?? BODY_FONT[settings.density];
}

/** The chat's body text size in px: the chosen one, or the interface's. */
export function chatFontSize(settings: Settings): number {
  return settings.chatFontSize ?? uiFontSize(settings);
}

/** A file's text size in px in the file viewer: the chosen one, or the chat's. */
export function fileFontSize(settings: Settings): number {
  return settings.fileFontSize ?? chatFontSize(settings);
}

/** The Default chat lane never runs narrower than this, in px: --content-w, the Narrow step. */
export const CHAT_LANE_MIN = 820;
/** ...or wider than this, in rem: 960px at a 16px root. In rem because Wide is (72rem, styles.css),
 *  so Default stays the narrower of the two at a root font of 11.39px and up; under that the
 *  820px floor wins and is itself wider than Wide (see chatLaneLength). */
export const CHAT_LANE_MAX_REM = 60;
/** The share of its pane the Default chat lane takes between the two. */
export const CHAT_LANE_RATIO = 0.7143;
/** The root font size chatLaneWidth resolves the rem ceiling with when none is given. */
export const ROOT_FONT_PX = 16;

/** The Default lane's pane-following part in whole px, before the rem ceiling: 71.43% of the pane, min 820px. */
function chatLaneFollow(paneWidth: number): number {
  if (!Number.isFinite(paneWidth)) return CHAT_LANE_MIN;
  return Math.max(CHAT_LANE_MIN, Math.round(paneWidth * CHAT_LANE_RATIO));
}

/**
 * The Default chat lane for a pane this wide, as the CSS length lib/chatLane.ts writes to --chat-w:
 * 71.43% of the pane, min 820px, max 60rem.
 * A length with no percentage in it: the lane's columns sit in boxes of different widths (the
 * transcript and the composer column inside a gutter, the held list and the menus outside it),
 * and one length is what keeps them equal. A pane narrower than the result is unaffected:
 * every column is min(100%, lane).
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

/** What chatLaneLength resolves to at this root font size, in px (960 at most at 16px): the rule in numbers. */
export function chatLaneWidth(paneWidth: number, rootFontPx: number = ROOT_FONT_PX): number {
  const root = Number.isFinite(rootFontPx) && rootFontPx > 0 ? rootFontPx : ROOT_FONT_PX;
  return Math.min(Math.max(CHAT_LANE_MIN, CHAT_LANE_MAX_REM * root), chatLaneFollow(paneWidth));
}

/** Only known keys with the right type survive: a stale or hand-edited record never breaks the UI. */
export function sanitizeSettings(raw: unknown): Settings {
  const record = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  // the same reading the page's boot script draws its first frame with (themeBoot.ts)
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
    statusIndicators: record["statusIndicators"] === "classic" || record["statusIndicators"] === "dots" || record["statusIndicators"] === "symbols" ? record["statusIndicators"] : DEFAULT_SETTINGS.statusIndicators,
    darkTheme,
    lightTheme,
    customThemes: sanitizeCustomThemes(record["customThemes"]),
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
    // kept as typed (a trailing space is the next word being started), only bounded
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
    claudeLaunchMode: CLAUDE_LAUNCH_MODES.find((mode) => mode === record["claudeLaunchMode"]) ?? DEFAULT_SETTINGS.claudeLaunchMode,
    codexLaunchMode: CODEX_LAUNCH_MODES.find((mode) => mode === record["codexLaunchMode"]) ?? DEFAULT_SETTINGS.codexLaunchMode,
    // only a name the agent's launch takes: anything else would start it on a flag nobody chose
    claudeLaunchModel: launchModel("claude", record["claudeLaunchModel"]),
    claudeLaunchEffort: CLAUDE_EFFORTS.find((level) => level === record["claudeLaunchEffort"]) ?? DEFAULT_SETTINGS.claudeLaunchEffort,
    codexLaunchModel: launchModel("codex", record["codexLaunchModel"]),
    codexLaunchEffort: CODEX_EFFORTS.find((level) => level === record["codexLaunchEffort"]) ?? DEFAULT_SETTINGS.codexLaunchEffort,
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

/** The pane menu's Wrap to screen / Original width, kept in a key of its own for the same reason: null until chosen. */
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

/** Settings → Appearance → Sidebar filter, kept in a key of its own for the same reason: out until chosen on. A new key:
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

/** Settings → Devices and PCs → PC load in the sidebar, kept in a key of its own for the same reason; null until chosen. */
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

/** Settings → File text size, kept in a key of its own for the same reason. */
export const FILE_FONT_SIZE_STORAGE_KEY = "ovis:file-font-size";

/** fileFontBase, beside it for the same reason; it names the size it was recorded for, read only beside that size. */
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

/** The file text size and its base, the base only where it was recorded for that size. */
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

/** Settings > Chat > Composer > Artifacts chip, kept in a key of its own for the same reason: off until chosen. */
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

/** Settings > Chat > Expand thinking and Collapse work, each kept in a key of its own for the same reason: off until chosen. */
export const EXPAND_THINKING_STORAGE_KEY = "ovis:expand-thinking";
export const FOLD_WORK_STORAGE_KEY = "ovis:fold-work";
/** Settings > Terminal > Pictures in the terminal, in a key of its own for the same reason: off until chosen. */
/** Pictures in the terminal, chosen on this device. Its own key: up to 0.5.0 every save wrote "ovis:terminal-images",
 *  false included, so a false there was not a choice; a true there was, and is still read. */
export const TERMINAL_IMAGES_STORAGE_KEY = "ovis:terminal-pictures";
const LEGACY_TERMINAL_IMAGES_STORAGE_KEY = "ovis:terminal-images";
/** Settings > Terminal > Attach files button, in a key of its own for the same reason: off until chosen. */
export const TERMINAL_ATTACH_BUTTON_STORAGE_KEY = "ovis:terminal-attach-button";
/** Settings > Terminal > Keyboard only from the key bar, in a key of its own for the same reason: off until chosen. */
export const TERMINAL_KEYBOARD_ON_REQUEST_STORAGE_KEY = "ovis:terminal-keyboard-on-request";
/** Settings > Terminal > Fold the key bar, in a key of its own for the same reason: off until chosen. */
export const TERMINAL_FOLD_KEY_BAR_STORAGE_KEY = "ovis:terminal-fold-key-bar";
/** Settings > Chat > Reuse tab for external links, kept in a key of its own for the same reason: off until chosen. */
export const REUSE_EXTERNAL_LINK_TAB_STORAGE_KEY = "ovis:reuse-external-link-tab";
/** Settings > Chat > Files beside the pane, kept in a key of its own for the same reason: off until chosen. */
export const FILES_PANEL_STORAGE_KEY = "ovis:files-panel";
/** Settings > Chat > Composer > Paste and send button, kept in a key of its own for the same reason: off until chosen. */
export const COMPOSER_PASTE_SEND_STORAGE_KEY = "ovis:composer-paste-send";
/** Settings > Chat > Composer > Side conversations chip, kept in a key of its own for the same reason: off until chosen. */
export const COMPOSER_BTW_STORAGE_KEY = "ovis:composer-btw";
/** Settings > Appearance > Context left on agent rows, kept in a key of its own for the same reason: off until chosen. */
export const SIDEBAR_CONTEXT_STORAGE_KEY = "ovis:sidebar-context";
/** Settings > Appearance > Fold helpers under their agent, kept in a key of its own for the same reason: off until chosen. */
export const FOLD_HELPERS_STORAGE_KEY = "ovis:fold-helpers";
/** Settings > Appearance > Agents under workspaces, kept in a key of its own for the same reason: off until chosen. */
export const SIDEBAR_AGENT_TREE_STORAGE_KEY = "ovis:sidebar-agent-tree";

/** a device's own on or off in its own key; null where it chose neither */
function readChosen(key: string): boolean | null {
  try {
    const raw = window.localStorage.getItem(key);
    const value: unknown = raw === null ? null : JSON.parse(raw);
    return typeof value === "boolean" ? value : null;
  } catch {
    return null;
  }
}

/** The imported themes, from their own key (themeBoot.ts): none where the record is missing, damaged or cannot be read. */
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
 * Settings > Chat > Enter sends (Return inserts a new line on a touch screen): whether it was chosen is kept in a
 * key of its own. Settings are saved whole, so `enterSends: true` in ovis:settings was written by any change at all,
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
    /* unreadable: the record's choice, if any */
  }
  return record === false ? false : null;
}

/** Whether this device's primary pointer is a finger: a phone or a tablet, with or without a hardware keyboard. */
function coarsePointer(): boolean {
  return typeof window !== "undefined" && window.matchMedia?.("(pointer: coarse)").matches === true;
}

/** Whether the status bar shows the selected PC's load: as chosen on this device, else off. */
export function pcLoadOn(settings: Pick<Settings, "pcLoad">, _machines: readonly { state: string }[]): boolean {
  // off until chosen in Settings: the owner judged each PC's CPU, memory and disk line not needed by default
  return settings.pcLoad ?? false;
}

/** Whether Enter (Return) sends from the composer: the device's choice, else not on a touch screen. */
export function enterSendsOn(settings: Pick<Settings, "enterSends">, touch: boolean): boolean {
  return settings.enterSends ?? !touch;
}

export function loadSettings(): Settings {
  // read as the page's boot script reads them (themeBoot.ts), so React starts on the row the first frame showed
  const stored = readStoredAppearance(() => window.localStorage);
  // no main record: the same theme the boot script draws (the hosted shell follows the system)
  const settings = stored.main === null ? { ...DEFAULT_SETTINGS, theme: defaultThemeSetting() } : sanitizeSettings(stored.main.value);
  const merged = stored.themes === null ? settings : sanitizeSettings({ ...settings, ...stored.themes });
  return { ...merged, enterSends: readEnterSends(merged.enterSends), uiFontFamily: readUiFontFamily(), terminalMirrorWrap: readMirrorWrap(), sidebarFilter: readSidebarFilter(), pcLoad: readPcLoad(), voiceEngine: readVoiceEngine(), ...readAgentGroups(), ...readFileFont(), composerArtifacts: readComposerArtifacts(),
    expandThinking: readChatFold(EXPAND_THINKING_STORAGE_KEY, DEFAULT_SETTINGS.expandThinking), foldWork: readChatFold(FOLD_WORK_STORAGE_KEY, DEFAULT_SETTINGS.foldWork),
    reuseExternalLinkTab: readChatFold(REUSE_EXTERNAL_LINK_TAB_STORAGE_KEY, DEFAULT_SETTINGS.reuseExternalLinkTab),
    filesPanel: readChatFold(FILES_PANEL_STORAGE_KEY, DEFAULT_SETTINGS.filesPanel),
    composerPasteSend: readChatFold(COMPOSER_PASTE_SEND_STORAGE_KEY, DEFAULT_SETTINGS.composerPasteSend),
    composerBtw: readChatFold(COMPOSER_BTW_STORAGE_KEY, DEFAULT_SETTINGS.composerBtw),
    sidebarContext: readChatFold(SIDEBAR_CONTEXT_STORAGE_KEY, DEFAULT_SETTINGS.sidebarContext),
    foldHelpers: readChatFold(FOLD_HELPERS_STORAGE_KEY, DEFAULT_SETTINGS.foldHelpers),
    sidebarAgentTree: readChatFold(SIDEBAR_AGENT_TREE_STORAGE_KEY, DEFAULT_SETTINGS.sidebarAgentTree),
    terminalImages: readChosen(TERMINAL_IMAGES_STORAGE_KEY) ?? (readChosen(LEGACY_TERMINAL_IMAGES_STORAGE_KEY) === true ? true : null),
    terminalAttachButton: readChatFold(TERMINAL_ATTACH_BUTTON_STORAGE_KEY, DEFAULT_SETTINGS.terminalAttachButton),
    terminalKeyboardOnRequest: readChatFold(TERMINAL_KEYBOARD_ON_REQUEST_STORAGE_KEY, DEFAULT_SETTINGS.terminalKeyboardOnRequest),
    terminalFoldKeyBar: readChatFold(TERMINAL_FOLD_KEY_BAR_STORAGE_KEY, DEFAULT_SETTINGS.terminalFoldKeyBar),
    customThemes: readCustomThemes() };
}

/** false where storage refused the write (private mode, a full quota) */
export function saveSettings(settings: Settings): boolean {
  const mirrored = sanitizeSettings(settings);
  try {
    window.localStorage.setItem(THEMES_STORAGE_KEY, JSON.stringify({
      darkTheme: mirrored.darkTheme, lightTheme: mirrored.lightTheme,
      mirror: { palette: mirrored.palette, paletteDark: mirrored.paletteDark, paletteLight: mirrored.paletteLight },
    }));
    const { uiFontFamily, terminalMirrorWrap, sidebarFilter, sidebarContext, sidebarAgentTree, foldHelpers, pcLoad, voiceEngine, agentGroups, agentGroupSort, fileFontSize, fileFontBase, composerArtifacts, composerPasteSend, composerBtw, expandThinking, foldWork, reuseExternalLinkTab, filesPanel, terminalImages, terminalAttachButton, terminalKeyboardOnRequest, terminalFoldKeyBar, customThemes, ...main } = mirrored;
    window.localStorage.setItem(CUSTOM_THEMES_STORAGE_KEY, JSON.stringify(customThemes));
    window.localStorage.setItem(VOICE_ENGINE_STORAGE_KEY, JSON.stringify(voiceEngine));
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

/**
 * Keeps the rows of the imported themes chosen for either side where the page's boot script reads
 * them (themeBoot.ts savedThemeEntry), so a cold launch opens in those colours; no record while no
 * side draws one. Storage that refuses the write leaves the first frame to the built-in theme.
 */
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
  // src/components/AgentMark.css keys the mono logos on it
  root.dataset["marks"] = settings.agentMarks;
  // src/styles.css multiplies every --fs-* token but --fs-input by this: the interface's body size over the density's
  const uiPx = uiFontSize(settings);
  root.style.setProperty("--ui-scale", String(fontScale(uiPx, BODY_FONT[settings.density])));
  // ChatView.css scales its type tokens by this (the chat's and a Markdown preview's): the chat's size over the
  // interface's, so a chosen chat size is drawn as itself whatever the interface size, and an unchosen one follows it
  root.style.setProperty("--chat-scale", String(fontScale(chatFontSize(settings), uiPx)));
  // ChatView.css gives a file viewer's preview this scale in place of the chat's, the same until a file size is chosen;
  // FileViewer.css scales the source by the second one, which only a chosen size writes (the interface's size till then):
  // the chosen size over the chat's when it was chosen (where the stepper started), so choosing that size changes nothing,
  // a step moves the source the way it moves the preview, and a later chat size leaves it be; times the interface's size
  // then over now, as the source is --fs-xs, which moves with the interface's
  root.style.setProperty("--file-scale", String(fontScale(fileFontSize(settings), uiPx)));
  if (settings.fileFontSize === null) root.style.removeProperty("--file-source-scale");
  else {
    const base = settings.fileFontBase?.size === settings.fileFontSize ? settings.fileFontBase : null;
    const scale = base === null ? fontScale(settings.fileFontSize, chatFontSize(settings)) : fontScale(settings.fileFontSize, base.chat) * fontScale(base.ui, uiPx);
    root.style.setProperty("--file-source-scale", String(scale));
  }
  // Settings → Appearance → Interface font, written as the token itself: the chosen list in front of the built-in stack
  const uiFont = uiFontStack(settings.uiFontFamily, language);
  if (uiFont === null) root.style.removeProperty("--font-ui");
  else root.style.setProperty("--font-ui", uiFont);
  // ChatView.css sets the transcript's and a Markdown preview's prose in this, and falls back to --font-ui without it
  const chatFont = chatFontStack(settings.chatFontFamily);
  if (chatFont === null) root.style.removeProperty("--font-chat");
  else root.style.setProperty("--font-chat", chatFont);
}

interface SettingsContextValue {
  settings: Settings;
  /** the theme after resolving `system` against the OS preference */
  resolvedTheme: ResolvedTheme;
  /** The actual rendered row, whose mode may differ from the selected side. */
  resolvedEntry: DrawnTheme;
  /** the language after resolving `system` against the browser's */
  resolvedLanguage: Language;
  /**
   * a change, or one made from the settings as this save would store them: storage's copy (another tab of this browser
   * may have saved since this one heard), with this tab's own changes not yet stored over it (a blocked storage holds
   * none of them, #2977)
   */
  update: (patch: Partial<Settings> | ((current: Settings) => Partial<Settings>)) => void;
}

const SettingsContext = createContext<SettingsContextValue | null>(null);

export function SettingsProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState<Settings>(loadSettings);
  // this tab's whole state at its last load or successful save: a value that differs from it is this tab's own, not yet stored
  const stored = useRef<Settings>(settings);
  const [systemDark, setSystemDark] = useState(() => resolveTheme("system") === "dark");

  useEffect(() => {
    const onStorage = (event: StorageEvent): void => {
      if (event.storageArea !== window.localStorage || (event.key !== SETTINGS_STORAGE_KEY && event.key !== ENTER_SENDS_STORAGE_KEY && event.key !== VOICE_ENGINE_STORAGE_KEY && event.key !== null)) return;
      // the recognition another tab chose: audio must not keep going where this tab last sent it
      const { shortcutOverrides, enterSends, voiceEngine } = loadSettings();
      stored.current = { ...stored.current, shortcutOverrides, enterSends, voiceEngine };
      setSettings((current) => ({ ...current, shortcutOverrides, enterSends, voiceEngine }));
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  useEffect(() => {
    const query = window.matchMedia?.(DARK_QUERY);
    if (!query) return;
    const onChange = (event: MediaQueryListEvent): void => setSystemDark(event.matches);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);

  const resolvedTheme: ResolvedTheme = settings.theme === "system" ? (systemDark ? "dark" : "light") : settings.theme;

  const resolvedEntry = drawnTheme(settings, resolvedTheme);
  // the rows the page's boot script draws an imported theme from, as this build derives them: written when the
  // themes or the choice change, not at every other setting's change (the list is a new object after each)
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
    // StrictMode runs the updater twice on the same state: the first run's save must not change what the second one reads
    let made: Partial<Settings> | undefined;
    setSettings((current) => {
      const differs = (key: string, value: unknown, from: Settings): boolean => JSON.stringify(value) !== JSON.stringify(from[key as keyof Settings]);
      // storage that no longer reads, or holds no record or a broken one, has nothing newer: this tab's own copy stands
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
      const next = sanitizeSettings({ ...current, ...(typeof patch === "function" ? made ??= patch(latest()) : patch) });
      // another tab may have saved since this one loaded (#2485): write only what this tab changed, over what is stored now
      const changed = Object.fromEntries(Object.entries(next).filter(([key, value]) => differs(key, value, current) || differs(key, value, stored.current)));
      if (saveSettings(sanitizeSettings({ ...loadSettings(), ...changed }))) stored.current = next;
      return next;
    });
  }, []);

  const value = useMemo(() => ({ settings, resolvedTheme, resolvedEntry, resolvedLanguage, update }), [settings, resolvedTheme, resolvedEntry, resolvedLanguage, update]);
  return createElement(SettingsContext.Provider, { value }, children);
}

export function useSettings(): SettingsContextValue {
  const value = useContext(SettingsContext);
  if (value === null) throw new Error("useSettings needs a SettingsProvider above it");
  return value;
}

export const PANE_VIEW_KEY_PREFIX = "ovis:view:";

/** Forgets every pane's own lens on this device, so each opens in the default one again. */
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
