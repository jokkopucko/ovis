/**
 * Anonymous install and update counts (server/telemetry.ts). On by default after a one-time
 * notice in the app; nothing is sent before that notice was shown (and a grace period after it,
 * server/telemetry.ts NOTICE_GRACE_MS), and nothing between an install and an update. An event
 * also carries the browser's latest allowlisted settings snapshot; no raw user-entered values or
 * account identifiers are included. Once per UTC day a browser visits, a separate active message
 * (POST /v1/active on the receiver) names the install and the kinds of coding agents running, from
 * TELEMETRY_HARNESSES only, and the day's usage (TelemetryUsage): kinds of screen, ways in, and counts.
 *
 *  GET  /api/telemetry  -> TelemetryStatus, no-store
 *  POST /api/telemetry  { enabled?: boolean, notice_seen?: true, notice_version?: number, settings?: TelemetrySettings } -> TelemetryStatus
 *       (same-origin, `x-herdr-update: 1`)
 *       The server accepts notice_seen only with notice_version === NOTICE_VERSION.
 *
 * A server that sends nothing (tests, a remote PC's bridge, an older server) answers 404 to
 * both, and the app shows neither the notice nor the switch.
 */

export type TelemetryEventName = "install" | "update";

/**
 * The notice's wording as a number: an install that saw an older one sees the notice again, and
 * sends nothing until it has (3: events now carry an allowlisted settings snapshot; 4: a daily
 * active message with the harness kinds; 5: that message also counts the day's usage, TelemetryUsage).
 */
export const NOTICE_VERSION = 5;

/**
 * Every theme id a snapshot may name: the three original palettes, the app's Codex theme and
 * herdr's canonical theme names. A literal list, not an import, so the Worker's copy only changes with a deploy.
 */
export const TELEMETRY_THEME_IDS = [
  "amber", "charcoal", "codex", "catppuccin", "catppuccin-latte", "tokyo-night", "black", "tokyo-night-day", "dracula", "nord",
  "gruvbox", "gruvbox-light", "one-dark", "one-light", "solarized", "solarized-light", "kanagawa",
  "kanagawa-lotus", "rose-pine", "rose-pine-dawn", "vesper",
] as const;
export type TelemetryThemeId = typeof TELEMETRY_THEME_IDS[number];

/**
 * Current setting values safe to report. Only finite enums, booleans and bounded numbers are
 * represented; user-entered strings and account identifiers are summarized or omitted by the
 * browser producer in src/lib/settings.ts.
 */
export interface TelemetrySettings {
  terminalInputMode: "auto" | "line" | "direct";
  theme: "dark" | "light" | "system";
  density: "compact" | "comfortable";
  sidebarRows: "one" | "two";
  agentOrder: "workspace" | "activity";
  agentMarks: "color" | "mono";
  statusIndicators: "classic" | "dots" | "symbols";
  palette: TelemetryThemeId;
  /** the pair System mode switches between */
  paletteLight: TelemetryThemeId;
  paletteDark: TelemetryThemeId;
  /** the theme for each side; a snapshot carries both or neither (apps before them send neither) */
  darkTheme?: TelemetryThemeId;
  lightTheme?: TelemetryThemeId;
  terminalFontSize: number;
  terminalWheelSpeed: number;
  paneClipboard: boolean;
  releasePaneAway: boolean;
  chatFontSize: number | null;
  /** null: the size the screen chose */
  uiFontSize: number | null;
  chatWidth: "narrow" | "default" | "wide" | "full";
  enterSends: boolean;
  autoSendQueued: boolean;
  suggestionChip: boolean;
  showThinking: boolean;
  keepScreenOn: boolean;
  language: "system" | "en" | "zh" | "ja" | "ko";
  alertsOn: boolean;
  alertInput: boolean;
  alertDone: "off" | "long" | "always";
  alertInApp: boolean;
  alertSound: boolean;
  showQuickReplies: boolean;
  showUsage: boolean;
  usageCount: "used" | "left";
  usageGlance: "week" | "session";
  defaultView: "auto" | "chat" | "terminal";
  voiceInput: "auto" | "on" | "off";
  voiceLanguage: "auto" | "ar-SA" | "cs-CZ" | "da-DK" | "de-DE" | "el-GR" | "en-GB" | "en-US" | "es-ES" | "fi-FI" | "fr-FR" | "he-IL" | "hi-IN" | "hu-HU" | "id-ID" | "it-IT" | "ja-JP" | "ko-KR" | "nb-NO" | "nl-NL" | "pl-PL" | "pt-BR" | "pt-PT" | "ro-RO" | "ru-RU" | "sk-SK" | "sv-SE" | "th-TH" | "tr-TR" | "uk-UA" | "vi-VN" | "zh-CN" | "zh-TW";
  voicePolishChat: boolean;
  voicePolishTerminal: boolean;
  wrapCode: boolean;
  markdownWidth: "readable" | "full";
  diffStyle: "unified" | "split";
  terminalFontCustom: boolean;
  chatFontCustom: boolean;
  shortcutsCustom: boolean;
  keyBarCustom: boolean;
  quickRepliesCustom: boolean;
  quickReplyCount: number;
  usageHiddenCount: number;
  /** the usage meters' accounts were put in an order of the user's own */
  usageOrderCustom: boolean;
}

/** The browser's full, non-sensitive snapshot. */
export interface TelemetryChange {
  enabled?: boolean;
  notice_seen?: true;
  notice_version?: number;
  settings?: TelemetrySettings;
  /** a pane alert was tapped (public/sw.js): counted in today's `alerts_opened`, and nothing else */
  alert_opened?: true;
}

const oneOf = <const T extends readonly string[]>(choices: T) => (value: unknown): boolean =>
  typeof value === "string" && (choices as readonly string[]).includes(value);
const booleanValue = (value: unknown): boolean => typeof value === "boolean";
const integerBetween = (min: number, max: number) => (value: unknown): boolean =>
  typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;
const nullableIntegerBetween = (min: number, max: number) => (value: unknown): boolean =>
  value === null || integerBetween(min, max)(value);

// This explicit shared schema must track the producer without importing frontend code at runtime.
type TelemetryThemeSideKey = "darkTheme" | "lightTheme";
const TELEMETRY_SETTINGS_VALIDATORS = {
  terminalInputMode: oneOf(["auto", "line", "direct"]),
  theme: oneOf(["dark", "light", "system"]),
  density: oneOf(["compact", "comfortable"]),
  sidebarRows: oneOf(["one", "two"]),
  agentOrder: oneOf(["workspace", "activity"]),
  agentMarks: oneOf(["color", "mono"]),
  statusIndicators: oneOf(["classic", "dots", "symbols"]),
  palette: oneOf(TELEMETRY_THEME_IDS),
  paletteLight: oneOf(TELEMETRY_THEME_IDS),
  paletteDark: oneOf(TELEMETRY_THEME_IDS),
  terminalFontSize: integerBetween(10, 22),
  terminalWheelSpeed: integerBetween(1, 10),
  paneClipboard: booleanValue,
  releasePaneAway: booleanValue,
  chatFontSize: nullableIntegerBetween(11, 24),
  uiFontSize: nullableIntegerBetween(11, 20),
  chatWidth: oneOf(["narrow", "default", "wide", "full"]),
  enterSends: booleanValue,
  autoSendQueued: booleanValue,
  suggestionChip: booleanValue,
  showThinking: booleanValue,
  keepScreenOn: booleanValue,
  language: oneOf(["system", "en", "zh", "ja", "ko"]),
  alertsOn: booleanValue,
  alertInput: booleanValue,
  alertDone: oneOf(["off", "long", "always"]),
  alertInApp: booleanValue,
  alertSound: booleanValue,
  showQuickReplies: booleanValue,
  showUsage: booleanValue,
  usageCount: oneOf(["used", "left"]),
  usageGlance: oneOf(["week", "session"]),
  defaultView: oneOf(["auto", "chat", "terminal"]),
  voiceInput: oneOf(["auto", "on", "off"]),
  voiceLanguage: oneOf(["auto", "ar-SA", "cs-CZ", "da-DK", "de-DE", "el-GR", "en-GB", "en-US", "es-ES", "fi-FI", "fr-FR", "he-IL", "hi-IN", "hu-HU", "id-ID", "it-IT", "ja-JP", "ko-KR", "nb-NO", "nl-NL", "pl-PL", "pt-BR", "pt-PT", "ro-RO", "ru-RU", "sk-SK", "sv-SE", "th-TH", "tr-TR", "uk-UA", "vi-VN", "zh-CN", "zh-TW"]),
  voicePolishChat: booleanValue,
  voicePolishTerminal: booleanValue,
  wrapCode: booleanValue,
  markdownWidth: oneOf(["readable", "full"]),
  diffStyle: oneOf(["unified", "split"]),
  terminalFontCustom: booleanValue,
  chatFontCustom: booleanValue,
  shortcutsCustom: booleanValue,
  keyBarCustom: booleanValue,
  quickRepliesCustom: booleanValue,
  quickReplyCount: integerBetween(0, 12),
  usageHiddenCount: integerBetween(0, 64),
  usageOrderCustom: booleanValue,
} satisfies Record<Exclude<keyof TelemetrySettings, TelemetryThemeSideKey>, (value: unknown) => boolean>;
const THEME_SIDE_VALIDATORS = {
  darkTheme: oneOf(TELEMETRY_THEME_IDS),
  lightTheme: oneOf(TELEMETRY_THEME_IDS),
} satisfies Record<TelemetryThemeSideKey, (value: unknown) => boolean>;

/** Every key the Worker (telemetry/worker.ts) requires in a snapshot. */
export const TELEMETRY_SETTINGS_KEYS = Object.keys(TELEMETRY_SETTINGS_VALIDATORS) as (keyof TelemetrySettings)[];
/** The keys the Worker also accepts, only together: a snapshot is exactly TELEMETRY_SETTINGS_KEYS, or those and both of these. */
export const TELEMETRY_THEME_SIDE_KEYS = Object.keys(THEME_SIDE_VALIDATORS) as TelemetryThemeSideKey[];

const VALIDATORS: Record<string, (value: unknown) => boolean> = { ...TELEMETRY_SETTINGS_VALIDATORS, ...THEME_SIDE_VALIDATORS };
/** the two key sets a snapshot may have: the original one, which older apps keep sending, and it with both theme sides */
const ACCEPTED_KEY_SETS: readonly (readonly string[])[] = [TELEMETRY_SETTINGS_KEYS, [...TELEMETRY_SETTINGS_KEYS, ...TELEMETRY_THEME_SIDE_KEYS]];

/** Validate the complete snapshot and return a fresh object containing only schema keys. */
export function telemetrySettings(value: unknown): TelemetrySettings | null {
  try {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return null;

    const keys = Reflect.ownKeys(value);
    const expected = ACCEPTED_KEY_SETS.find((set) => set.length === keys.length);
    if (!expected || keys.some((key) => typeof key !== "string" || !expected.includes(key))) return null;

    const clean: Record<string, unknown> = {};
    for (const key of expected) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !descriptor.enumerable || !("value" in descriptor) || !VALIDATORS[key]!(descriptor.value)) return null;
      clean[key] = descriptor.value;
    }
    return clean as unknown as TelemetrySettings;
  } catch {
    return null;
  }
}
export type InstallMethod = "plugin" | "managed" | "source";
/** The terminal runtime the server serves (server/herdr-core/runtime.ts): herdr's TUI server, or herdr-core. */
export type TelemetryRuntime = "herdr" | "herdr-core";

/** Harness kinds an active message may name: the supported agents (shared/supported-agents.ts) and "other". A literal list, not an import, so the Worker's copy only changes with a deploy. */
export const TELEMETRY_HARNESSES = ["agy", "claude", "codex", "devin", "gjc", "grok", "hermes", "omo", "omp", "opencode", "other", "pi"] as const;
export type TelemetryHarness = typeof TELEMETRY_HARNESSES[number];

/** The harness a pane's herdr agent counts as: null for no agent, "other" for one not in the list. */
export function harnessOf(agent: string | null | undefined): TelemetryHarness | null {
  if (!agent) return null;
  return agent !== "other" && (TELEMETRY_HARNESSES as readonly string[]).includes(agent) ? agent as TelemetryHarness : "other";
}

/** A sorted, duplicate-free array of TELEMETRY_HARNESSES values, or null. Empty is valid. */
export function telemetryHarnesses(value: unknown): TelemetryHarness[] | null {
  if (!Array.isArray(value)) return null;
  const clean: TelemetryHarness[] = [];
  for (const [index, item] of value.entries()) {
    if (typeof item !== "string" || !(TELEMETRY_HARNESSES as readonly string[]).includes(item)) return null;
    if (index > 0 && !(value[index - 1] < item)) return null;
    clean.push(item as TelemetryHarness);
  }
  return clean;
}

/**
 * The kind of screen a visit opened the app on (src/lib/telemetrySurface.ts): the iOS, Android and
 * Mac apps, an installed web app on a phone or a computer, or a browser tab on either.
 */
export const TELEMETRY_SURFACES = ["android-app", "browser", "ios-app", "mac-app", "mobile-browser", "mobile-pwa", "pwa"] as const;
export type TelemetrySurface = typeof TELEMETRY_SURFACES[number];

/**
 * How a visit reached this server: server/access.ts `observedIngress`, with an unforwarded request
 * split into one from this PC itself (`local`) and one from another device (`lan`).
 */
export const TELEMETRY_INGRESS = ["funnel", "lan", "local", "proxy", "tailscale", "unknown"] as const;
export type TelemetryIngress = typeof TELEMETRY_INGRESS[number];

/** The most a usage count says: a busier day is reported as this many. */
export const TELEMETRY_COUNT_MAX = 9999;

/**
 * One day's use of the app on this install: which kinds of screen opened it and how they reached
 * the server (sorted, no repeats), how many prompt answers went from it to an agent, how many pane
 * alerts reached a device, and how many of those were tapped. Counts only: never which pane, agent,
 * device or time.
 */
export interface TelemetryUsage {
  surfaces: TelemetrySurface[];
  ingress: TelemetryIngress[];
  prompt_answers: number;
  alerts_delivered: number;
  alerts_opened: number;
}

export type TelemetryUsageCount = "prompt_answers" | "alerts_delivered" | "alerts_opened";

export function emptyUsage(): TelemetryUsage {
  return { surfaces: [], ingress: [], prompt_answers: 0, alerts_delivered: 0, alerts_opened: 0 };
}

/** A sorted, duplicate-free array of `choices` values, or null. Empty is valid. */
function sortedChoices<const T extends readonly string[]>(choices: T, value: unknown): T[number][] | null {
  if (!Array.isArray(value)) return null;
  const clean: T[number][] = [];
  for (const [index, item] of value.entries()) {
    if (typeof item !== "string" || !(choices as readonly string[]).includes(item)) return null;
    if (index > 0 && !(value[index - 1] < item)) return null;
    clean.push(item);
  }
  return clean;
}

export function telemetrySurface(value: unknown): TelemetrySurface | null {
  return typeof value === "string" && (TELEMETRY_SURFACES as readonly string[]).includes(value) ? value as TelemetrySurface : null;
}

const USAGE_KEYS = ["surfaces", "ingress", "prompt_answers", "alerts_delivered", "alerts_opened"];

/** The usage exactly as TelemetryUsage allows it, as a fresh object, or null. */
export function telemetryUsage(value: unknown): TelemetryUsage | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return null;
  const keys = Reflect.ownKeys(value);
  if (keys.length !== USAGE_KEYS.length || keys.some((key) => typeof key !== "string" || !USAGE_KEYS.includes(key))) return null;
  const record = value as Record<string, unknown>;
  const surfaces = sortedChoices(TELEMETRY_SURFACES, record["surfaces"]);
  const ingress = sortedChoices(TELEMETRY_INGRESS, record["ingress"]);
  const count = integerBetween(0, TELEMETRY_COUNT_MAX);
  if (!surfaces || !ingress) return null;
  if (!count(record["prompt_answers"]) || !count(record["alerts_delivered"]) || !count(record["alerts_opened"])) return null;
  return { surfaces, ingress, prompt_answers: record["prompt_answers"] as number, alerts_delivered: record["alerts_delivered"] as number, alerts_opened: record["alerts_opened"] as number };
}

export function sameUsage(a: TelemetryUsage, b: TelemetryUsage): boolean {
  return a.prompt_answers === b.prompt_answers && a.alerts_delivered === b.alerts_delivered && a.alerts_opened === b.alerts_opened
    && a.surfaces.join() === b.surfaces.join() && a.ingress.join() === b.ingress.join();
}

/** One install's activity for one UTC day, exactly as sent to /v1/active. `day` is the UTC date (YYYY-MM-DD) of the browser visit, not of delivery. */
export interface TelemetryActive {
  event: "active";
  day: string;
  install_id: string;
  version: string;
  os: string;
  arch: string;
  install_method: InstallMethod;
  harnesses: TelemetryHarness[];
  /** the day's use so far; a receiver deployed before it existed refuses it, so the Worker goes out first (telemetry/README.md) */
  usage: TelemetryUsage;
  /** the terminal runtime the server serves; a receiver deployed before it existed refuses it, so the Worker goes out first */
  runtime: TelemetryRuntime;
}

/** How many days back a late delivery may still name: the visit day and the two before the receiver's today. */
export const ACTIVE_LATE_DAYS = 2;

/**
 * One event, exactly as it is sent. The receiver keeps these fields, the day and the country the
 * request came from (two characters, worked out by its host); no IP, no address.
 */
export interface TelemetryEvent {
  event: TelemetryEventName;
  /** random, made on this PC the first time; says nothing about the user */
  install_id: string;
  /** the running app's version, without the v */
  version: string;
  /** the version an update replaced; null for an install, or an update from before telemetry */
  previous_version: string | null;
  /** Node's `process.platform` and `process.arch` */
  os: string;
  arch: string;
  install_method: InstallMethod;
  /** the latest browser's allowlisted settings snapshot; null before one has told */
  settings: TelemetrySettings | null;
  /** the terminal runtime the server serves; a receiver deployed before it existed refuses it, so the Worker goes out first */
  runtime: TelemetryRuntime;
}

export interface TelemetryStatus {
  /** the switch in Settings */
  enabled: boolean;
  /** HERDR_WEB_TELEMETRY=0, DO_NOT_TRACK or a CI/test environment: nothing is sent whatever the switch says */
  blocked_by_env: boolean;
  /** the app has shown its current notice (NOTICE_VERSION) once; no event goes out before that */
  notice_seen: boolean;
  /** what the next event would be, as it would be sent; null when there is nothing left to send for this version */
  next: TelemetryEvent | null;
  /** the active message today's visits send, as it would be sent; harnesses seen so far today (empty and day = today before a visit) */
  active: TelemetryActive;
}
