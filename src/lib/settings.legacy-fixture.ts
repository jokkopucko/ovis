/** Pinned from 82d556b9 src/lib/settings.ts for old-tab migration tests. Never used by the app. */
import { DEFAULT_KEY_BAR_ITEMS, migrateKeyBarItems, sanitizeKeyBarItems } from "./keyBar.ts";
import { sanitizeShortcutOverrides } from "./shortcutBindings.ts";
import { sanitizeFontFamily } from "./fontFamily.ts";
import { sanitizeUiFontSize } from "./typography.ts";
import { sanitizeKeyBarExtras } from "./keys.ts";
import { LANGUAGE_SETTINGS, type LanguageSetting } from "./i18n.ts";
import { CHAT_WIDTHS, DICTATION_LANGUAGES, DIFF_STYLES, VOICE_BUTTONS,
  QUICK_REPLIES_MAX, QUICK_REPLY_MAX_CHARS, USAGE_KEYS_MAX, TERMINAL_FONT_MIN, TERMINAL_FONT_MAX,
  TERMINAL_WHEEL_SPEED_MIN, TERMINAL_WHEEL_SPEED_MAX, CHAT_FONT_MIN, CHAT_FONT_MAX,
  type Settings as CurrentSettings, type ChatWidth, type DictationLanguage, type VoiceButton } from "./settings.ts";
type Settings = Omit<CurrentSettings, "opencodeParentEnds" | "keyBarExpanded" | "herdrPrefixKeys" | "darkTheme" | "lightTheme" | "fileOpen" | "filesPanel" | "filesDocuments" | "webLinks" | "reuseExternalLinkTab" | "claudeLaunchMode" | "codexLaunchMode" | "claudeLaunchModel" | "claudeLaunchEffort" | "codexLaunchModel" | "codexLaunchEffort" | "followHerdrFocus" | "sidebarPeek" | "sidebarBackgroundWorkspaces" | "codexDrag" | "composerNewTabButton" | "composerArtifacts" | "composerPasteSend" | "composerBtw" | "uiFontFamily" | "terminalMirrorWrap" | "sidebarFilter" | "sidebarContext" | "sidebarAgentTree" | "foldHelpers" | "pcLoad" | "historyPrompts" | "expandThinking" | "foldWork" | "chatRequestDetails" | "autoTabNames" | "voiceEngine" | "agentGroups" | "agentGroupSort" | "terminalImages" | "terminalAttachButton" | "agentLocks" | "lockedAgents" | "terminalKeyboardOnRequest" | "terminalFoldKeyBar" | "markdownOutline" | "fileFontSize" | "fileFontBase" | "agentNamedGroups" | "agentGroupNames" | "agentGroupOf" | "editTextFiles"> & {
  /** Settings → Chat → Markdown width, which this pinned version still kept (removed from Settings since) */
  markdownWidth: "readable" | "full";
  /** Settings → Alerts → In the app, which this pinned version still kept (removed from Settings since) */
  alertInApp: boolean;
};
const MARKDOWN_WIDTHS = ["readable", "full"] as const;
type Palette = "amber" | "charcoal" | "catppuccin";
const PALETTES: readonly Palette[] = ["amber", "charcoal", "catppuccin"];
const STORAGE_KEY = "ovis:settings";
export const DEFAULT_SETTINGS: Settings = {
  terminalInputMode: "auto",
  keyBarExtras: ["alt"],
  keyBarItems: DEFAULT_KEY_BAR_ITEMS,
  shortcutOverrides: {},
  theme: "dark",
  density: "comfortable",
  sidebarRows: "two",
  agentOrder: "workspace",
  agentMarks: "color",
  statusIndicators: "classic",
  palette: "amber",
  paletteLight: "amber",
  paletteDark: "amber",
  terminalFontSize: 13,
  terminalWheelSpeed: 1,
  terminalFontFamily: "",
  paneClipboard: true,
  releasePaneAway: false,
  chatFontSize: null,
  chatFontFamily: "",
  uiFontSize: null,
  chatWidth: "default",
  enterSends: true,
  autoSendQueued: true,
  suggestionChip: false,
  showThinking: false,
  keepScreenOn: false,
  language: "system",
  alertsOn: true,
  alertInput: true,
  alertDone: "long",
  alertInApp: true,
  alertSound: false,
  quickReplies: ["continue", "yes", "no", "commit and push", "retry"],
  showQuickReplies: false,
  showUsage: false,
  usageCount: "used",
  usageGlance: "week",
  defaultView: "auto",
  usageOrder: [],
  usageHidden: [],
  voiceInput: "auto",
  voiceLanguage: "auto",
  voicePolishChat: true,
  voicePolishTerminal: false,
  wrapCode: false,
  markdownWidth: "readable",
  diffStyle: "unified",
};
function usageKeys(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((key): key is string => typeof key === "string" && key.length > 0 && key.length <= 512))].slice(0, USAGE_KEYS_MAX);
}
function voiceButton(value: unknown): VoiceButton {
  if (value === true) return "on";
  return VOICE_BUTTONS.includes(value as VoiceButton) ? value as VoiceButton : DEFAULT_SETTINGS.voiceInput;
}
function clampFont(size: number): number {
  return Math.min(TERMINAL_FONT_MAX, Math.max(TERMINAL_FONT_MIN, Math.round(size)));
}
export function sanitizeSettings(raw: unknown): Settings {
  const record = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  const theme = record["theme"];
  const palette = PALETTES.find((name) => name === record["palette"]) ?? DEFAULT_SETTINGS.palette;
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
    shortcutOverrides: sanitizeShortcutOverrides(record["shortcutOverrides"]),
    theme: theme === "dark" || theme === "light" || theme === "system" ? theme : DEFAULT_SETTINGS.theme,
    density: density === "compact" || density === "comfortable" ? density : DEFAULT_SETTINGS.density,
    sidebarRows: record["sidebarRows"] === "one" || record["sidebarRows"] === "two" ? record["sidebarRows"] : DEFAULT_SETTINGS.sidebarRows,
    agentOrder: record["agentOrder"] === "workspace" || record["agentOrder"] === "activity" ? record["agentOrder"] : DEFAULT_SETTINGS.agentOrder,
    agentMarks: record["agentMarks"] === "color" || record["agentMarks"] === "mono" ? record["agentMarks"] : DEFAULT_SETTINGS.agentMarks,
    statusIndicators: record["statusIndicators"] === "classic" || record["statusIndicators"] === "dots" || record["statusIndicators"] === "symbols" ? record["statusIndicators"] : DEFAULT_SETTINGS.statusIndicators,
    palette,
    // a record from before the pair starts both from its one palette, so System mode looks as it did
    paletteLight: PALETTES.find((name) => name === record["paletteLight"]) ?? palette,
    paletteDark: PALETTES.find((name) => name === record["paletteDark"]) ?? palette,
    terminalFontSize: typeof font === "number" && Number.isFinite(font) ? clampFont(font) : DEFAULT_SETTINGS.terminalFontSize,
    terminalWheelSpeed: typeof record["terminalWheelSpeed"] === "number" && Number.isFinite(record["terminalWheelSpeed"])
      ? Math.min(TERMINAL_WHEEL_SPEED_MAX, Math.max(TERMINAL_WHEEL_SPEED_MIN, Math.round(record["terminalWheelSpeed"])))
      : DEFAULT_SETTINGS.terminalWheelSpeed,
    chatFontSize: typeof chatFont === "number" && Number.isFinite(chatFont)
      ? Math.min(CHAT_FONT_MAX, Math.max(CHAT_FONT_MIN, Math.round(chatFont)))
      : DEFAULT_SETTINGS.chatFontSize,
    terminalFontFamily: sanitizeFontFamily(record["terminalFontFamily"]),
    uiFontSize: sanitizeUiFontSize(record["uiFontSize"]),
    paneClipboard: typeof record["paneClipboard"] === "boolean" ? record["paneClipboard"] : DEFAULT_SETTINGS.paneClipboard,
    releasePaneAway: typeof record["releasePaneAway"] === "boolean" ? record["releasePaneAway"] : DEFAULT_SETTINGS.releasePaneAway,
    chatFontFamily: sanitizeFontFamily(record["chatFontFamily"]),
    chatWidth: CHAT_WIDTHS.includes(record["chatWidth"] as ChatWidth) ? record["chatWidth"] as ChatWidth : DEFAULT_SETTINGS.chatWidth,
    enterSends: typeof record["enterSends"] === "boolean" ? record["enterSends"] : DEFAULT_SETTINGS.enterSends,
    autoSendQueued: typeof record["autoSendQueued"] === "boolean" ? record["autoSendQueued"] : DEFAULT_SETTINGS.autoSendQueued,
    suggestionChip: typeof record["suggestionChip"] === "boolean" ? record["suggestionChip"] : DEFAULT_SETTINGS.suggestionChip,
    showThinking: typeof record["showThinking"] === "boolean" ? record["showThinking"] : DEFAULT_SETTINGS.showThinking,
    keepScreenOn: typeof record["keepScreenOn"] === "boolean" ? record["keepScreenOn"] : DEFAULT_SETTINGS.keepScreenOn,
    language: LANGUAGE_SETTINGS.includes(record["language"] as LanguageSetting) ? record["language"] as LanguageSetting : DEFAULT_SETTINGS.language,
    alertsOn: typeof record["alertsOn"] === "boolean" ? record["alertsOn"] : DEFAULT_SETTINGS.alertsOn,
    alertInput: typeof record["alertInput"] === "boolean" ? record["alertInput"] : DEFAULT_SETTINGS.alertInput,
    alertDone: record["alertDone"] === "off" || record["alertDone"] === "long" || record["alertDone"] === "always" ? record["alertDone"] : DEFAULT_SETTINGS.alertDone,
    alertInApp: typeof record["alertInApp"] === "boolean" ? record["alertInApp"] : DEFAULT_SETTINGS.alertInApp,
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
    voicePolishChat: typeof record["voicePolishChat"] === "boolean" ? record["voicePolishChat"] : DEFAULT_SETTINGS.voicePolishChat,
    voicePolishTerminal: typeof record["voicePolishTerminal"] === "boolean" ? record["voicePolishTerminal"] : DEFAULT_SETTINGS.voicePolishTerminal,
    wrapCode: typeof record["wrapCode"] === "boolean" ? record["wrapCode"] : DEFAULT_SETTINGS.wrapCode,
    markdownWidth: MARKDOWN_WIDTHS.find((width) => width === record["markdownWidth"]) ?? DEFAULT_SETTINGS.markdownWidth,
    diffStyle: DIFF_STYLES.find((style) => style === record["diffStyle"]) ?? DEFAULT_SETTINGS.diffStyle,
  };
}
export function saveSettings(settings: Settings): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    /* private mode: preferences last for the session */
  }
}
