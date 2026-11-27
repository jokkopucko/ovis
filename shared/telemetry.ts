/**
 * Anonymous install and update counts (server/telemetry.ts). On by default after a one-time
 * notice in the app; nothing is sent before that notice was shown (and a grace period after it,
 * server/telemetry.ts NOTICE_GRACE_MS), and nothing between an install and an update. An event
 * also carries the browser's latest allowlisted settings snapshot; no raw user-entered values or
 * account identifiers are included. Once per UTC day a browser visits, a separate active message
 * (POST /v1/active on the receiver) names the install and the kinds of coding agents running, from
 * TELEMETRY_HARNESSES only, and the day's usage (TelemetryUsage): kinds of screen, ways in, counts, the panes of each kind
 * of agent by who started them with their versions, and the answers by the way they went.
 * Once a UTC day has ended, a counts message (POST /v1/counts on the receiver, TelemetryCounts) says how
 * often that day's fixed controls were used, from TELEMETRY_COUNTERS only, each as a bucket.
 *
 *  GET  /api/telemetry  -> TelemetryStatus, no-store
 *  POST /api/telemetry  { enabled?: boolean, notice_seen?: true, notice_version?: number, settings?: TelemetrySettings } -> TelemetryStatus
 *       (same-origin, `x-herdr-update: 1`)
 *       The server accepts notice_seen only with notice_version === NOTICE_VERSION (shared/telemetry-notice.ts).
 *
 * A server that sends nothing (tests, a remote PC's bridge, an older server) answers 404 to
 * both, and the app shows neither the notice nor the switch.
 */

export type TelemetryEventName = "install" | "update";


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
  /**
   * with `settings`: the counting generation (TelemetryStatus.counts_generation) the page last heard. Settings told
   * from before an off it did not hear are not kept
   */
  generation?: number;
  /** a pane alert was tapped (public/sw.js): counted in today's `alerts_opened`, and nothing else */
  alert_opened?: true;
  /** what a browser used since it last told: added to today's counts (TelemetryCounts). A server before it answers 400 */
  counts?: TelemetryCountsChange;
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
 * How a visit reached this server: the observed ingress /api/health reports (server/dispatch.ts
 * `requestIngress`), with the Ovis relay and Portal, and an unforwarded request split into one from
 * this PC itself (`local`) and one from another device (`lan`). Only the word, never an address,
 * Portal name or relay id.
 */
export const TELEMETRY_INGRESS = ["funnel", "lan", "local", "portal", "proxy", "relay", "tailscale", "unknown"] as const;
export type TelemetryIngress = typeof TELEMETRY_INGRESS[number];

/** The most a usage count says: a busier day is reported as this many. */
export const TELEMETRY_COUNT_MAX = 9999;

/**
 * How an answer to an agent's question or approval got to it: through a channel the agent offers
 * (`native`: its service, extension or bridge, never keys), as keys for a card read from the agent's own
 * session record (`record`), as keys for a card read off the screen (`screen`), or not from Ovis at all
 * (`terminal`: the agent stopped waiting with no answer sent from Ovis, so it was answered at the terminal
 * or another client, or it moved on by itself).
 */
export const TELEMETRY_ANSWER_WAYS = ["native", "record", "screen", "terminal"] as const;
export type TelemetryAnswerWay = typeof TELEMETRY_ANSWER_WAYS[number];

/** The most versions one kind of agent names in a day. */
export const TELEMETRY_VERSIONS_MAX = 4;
const AGENT_VERSION = /^\d{1,4}\.\d{1,4}$/;

/** An agent's version as a day names it: major.minor only, or null when it does not start with one. */
export function telemetryAgentVersion(version: string | null | undefined): string | null {
  const found = typeof version === "string" ? /^(\d{1,4})\.(\d{1,4})(?!\d)/.exec(version) : null;
  return found ? `${Number(found[1])}.${Number(found[2])}` : null;
}

/**
 * One kind of agent on one day: the most of its panes seen at one visit, those an Ovis server started
 * (`ovis`) and the rest (`other`, started by hand, by herdr or by a server that has restarted since), and
 * the major.minor versions its sessions named (sorted, at most TELEMETRY_VERSIONS_MAX; only agents whose
 * session record says its version: Claude, Codex, OpenCode).
 */
export interface TelemetryAgentDay {
  ovis: number;
  other: number;
  versions: string[];
}

/**
 * One day's use of the app on this install: which kinds of screen opened it and how they reached
 * the server (sorted, no repeats), how many prompt answers went from it to an agent, how many pane
 * alerts reached a device, and how many of those were tapped. Counts only: never which pane, agent,
 * device or time. A newer app adds `agents` (each kind of agent seen that day, TelemetryAgentDay) and
 * `answers` (the bucket of the day's answers per TelemetryAnswerWay, a way with none left out), both or
 * neither; an older one sends neither.
 */
export interface TelemetryUsage {
  surfaces: TelemetrySurface[];
  ingress: TelemetryIngress[];
  prompt_answers: number;
  alerts_delivered: number;
  alerts_opened: number;
  agents?: Partial<Record<TelemetryHarness, TelemetryAgentDay>>;
  answers?: Partial<Record<TelemetryAnswerWay, TelemetryBucket>>;
}

export type TelemetryUsageCount = "prompt_answers" | "alerts_delivered" | "alerts_opened";

export function emptyUsage(): TelemetryUsage {
  return { surfaces: [], ingress: [], prompt_answers: 0, alerts_delivered: 0, alerts_opened: 0, agents: {}, answers: {} };
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
const USAGE_KEY_SETS = [USAGE_KEYS, [...USAGE_KEYS, "agents", "answers"]];

/** A plain object whose own keys are all strings from `choices` (none may be left out), or null. */
function choiceRecord(choices: readonly string[], value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return null;
  return Reflect.ownKeys(value).every((key) => typeof key === "string" && choices.includes(key)) ? value as Record<string, unknown> : null;
}

function agentDay(value: unknown): TelemetryAgentDay | null {
  const record = choiceRecord(["ovis", "other", "versions"], value);
  if (!record || Object.keys(record).length !== 3) return null;
  const count = integerBetween(0, TELEMETRY_COUNT_MAX);
  const versions = record["versions"];
  if (!count(record["ovis"]) || !count(record["other"]) || !Array.isArray(versions) || versions.length > TELEMETRY_VERSIONS_MAX) return null;
  for (const [index, version] of versions.entries()) {
    if (typeof version !== "string" || !AGENT_VERSION.test(version) || (index > 0 && !(versions[index - 1] < version))) return null;
  }
  return { ovis: record["ovis"] as number, other: record["other"] as number, versions: [...versions as string[]] };
}

/** The agents and answers exactly as TelemetryUsage allows them, each in its list's order, or null. */
function usageAgents(agentsValue: unknown, answersValue: unknown): Pick<Required<TelemetryUsage>, "agents" | "answers"> | null {
  const agentsRecord = choiceRecord(TELEMETRY_HARNESSES, agentsValue);
  const answersRecord = choiceRecord(TELEMETRY_ANSWER_WAYS, answersValue);
  if (!agentsRecord || !answersRecord) return null;
  const agents: Partial<Record<TelemetryHarness, TelemetryAgentDay>> = {};
  for (const kind of TELEMETRY_HARNESSES) {
    if (!Object.hasOwn(agentsRecord, kind)) continue;
    const day = agentDay(agentsRecord[kind]);
    if (!day) return null;
    agents[kind] = day;
  }
  const answers: Partial<Record<TelemetryAnswerWay, TelemetryBucket>> = {};
  for (const way of TELEMETRY_ANSWER_WAYS) {
    if (!Object.hasOwn(answersRecord, way)) continue;
    const bucket = answersRecord[way];
    if (bucket !== 1 && bucket !== 2 && bucket !== 3 && bucket !== 4) return null;
    answers[way] = bucket;
  }
  return { agents, answers };
}

/** The usage exactly as TelemetryUsage allows it, as a fresh object, or null. */
export function telemetryUsage(value: unknown): TelemetryUsage | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return null;
  const keys = Reflect.ownKeys(value);
  const expected = USAGE_KEY_SETS.find((set) => set.length === keys.length);
  if (!expected || keys.some((key) => typeof key !== "string" || !expected.includes(key))) return null;
  const record = value as Record<string, unknown>;
  const surfaces = sortedChoices(TELEMETRY_SURFACES, record["surfaces"]);
  const ingress = sortedChoices(TELEMETRY_INGRESS, record["ingress"]);
  const count = integerBetween(0, TELEMETRY_COUNT_MAX);
  if (!surfaces || !ingress) return null;
  if (!count(record["prompt_answers"]) || !count(record["alerts_delivered"]) || !count(record["alerts_opened"])) return null;
  const usage: TelemetryUsage = { surfaces, ingress, prompt_answers: record["prompt_answers"] as number, alerts_delivered: record["alerts_delivered"] as number, alerts_opened: record["alerts_opened"] as number };
  if (expected.length === USAGE_KEYS.length) return usage;
  const agents = usageAgents(record["agents"], record["answers"]);
  return agents && { ...usage, ...agents };
}

/** the agents and answers as text in one order, missing ones as none */
const agentsText = (usage: TelemetryUsage): string => JSON.stringify([
  TELEMETRY_HARNESSES.map((kind) => usage.agents?.[kind] ?? null),
  TELEMETRY_ANSWER_WAYS.map((way) => usage.answers?.[way] ?? null),
]);

export function sameUsage(a: TelemetryUsage, b: TelemetryUsage): boolean {
  return a.prompt_answers === b.prompt_answers && a.alerts_delivered === b.alerts_delivered && a.alerts_opened === b.alerts_opened
    && a.surfaces.join() === b.surfaces.join() && a.ingress.join() === b.ingress.join() && agentsText(a) === agentsText(b);
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
 * The kind of pane a chat/terminal switch was made on: the pane's agent (TELEMETRY_HARNESSES), or
 * `shell` for a pane with none.
 */
export const TELEMETRY_VIEW_KINDS = [...TELEMETRY_HARNESSES, "shell"] as const;
export type TelemetryViewKind = typeof TELEMETRY_VIEW_KINDS[number];
/** Where a chat/terminal switch was asked for: the header's Chat/Terminal buttons, a pane's own control (a split half's lens, the chat's Open terminal), the shortcut, or the command palette. */
export const TELEMETRY_VIEW_SOURCES = ["header", "pane", "shortcut", "palette"] as const;
export type TelemetryViewSource = typeof TELEMETRY_VIEW_SOURCES[number];
/** Actions the app offers in more than one way, counted by the way each was taken (TELEMETRY_ACTION_SOURCES). */
export const TELEMETRY_ACTIONS = ["close_pane", "files", "inbox", "new_tab", "new_workspace", "settings", "sidebar", "split"] as const;
export type TelemetryAction = typeof TELEMETRY_ACTIONS[number];
export const TELEMETRY_ACTION_SOURCES = ["button", "menu", "palette", "shortcut"] as const;
export type TelemetryActionSource = typeof TELEMETRY_ACTION_SOURCES[number];

/** Counters with no dimension: a chat send, the composer's buttons and the agent inbox's controls. */
const TELEMETRY_PLAIN_COUNTERS = [
  "chat_send",
  "composer_attach", "composer_hold", "composer_paste_send", "composer_quick_reply", "composer_slash", "composer_stop", "composer_suggestion", "composer_voice",
  "inbox_enter", "inbox_filter", "inbox_leave", "inbox_open", "inbox_rail_alerts", "inbox_rail_inbox", "inbox_rail_pcs", "inbox_rail_settings", "inbox_rail_waiting", "inbox_search",
] as const;

export type TelemetryCounter =
  | typeof TELEMETRY_PLAIN_COUNTERS[number]
  | `view_${"chat" | "terminal"}_${TelemetryViewKind}`
  | `view_${"chat" | "terminal"}_by_${TelemetryViewSource}`
  | `${TelemetryAction}_by_${TelemetryActionSource}`;

/**
 * Every name a day's counts may hold, sorted: fixed words, and the switch names made from
 * TELEMETRY_HARNESSES (a new harness adds two), so the Worker's copy only changes with a deploy; the
 * Worker drops any other name and keeps the rest.
 * A switch is counted twice, once under the pane's kind and once under the way it was asked for,
 * never as their combination.
 */
export const TELEMETRY_COUNTERS: readonly TelemetryCounter[] = ([
  ...TELEMETRY_PLAIN_COUNTERS,
  ...(["chat", "terminal"] as const).flatMap((to) => [
    ...TELEMETRY_VIEW_KINDS.map((kind) => `view_${to}_${kind}` as const),
    ...TELEMETRY_VIEW_SOURCES.map((source) => `view_${to}_by_${source}` as const),
  ]),
  ...TELEMETRY_ACTIONS.flatMap((action) => TELEMETRY_ACTION_SOURCES.map((source) => `${action}_by_${source}` as const)),
] satisfies TelemetryCounter[]).sort();

/**
 * Controls that are not always drawn, each said once a day to have been shown, so a count of zero can
 * be told from a control nobody saw: the composer (with Attach and Send), its Stop, voice, Paste and send,
 * quick replies and suggestion; the header's and a pane's Chat/Terminal switch; and the agent inbox.
 */
export const TELEMETRY_SHOWN = [
  "composer", "composer_paste_send", "composer_quick_reply", "composer_stop", "composer_suggestion", "composer_voice",
  "inbox", "view_switch_header", "view_switch_pane",
] as const;
export type TelemetryShown = typeof TELEMETRY_SHOWN[number];

/**
 * Where the app was used: a window at most 640px wide (src/lib/sheets.ts SHEET_QUERY, where dialogs
 * are bottom sheets) is narrow, any other wide. One definition for every count.
 */
export type TelemetryWidth = "narrow" | "wide";

/**
 * A day's count as it leaves the PC: 1 for 1-2, 2 for 3-9, 3 for 10-29, 4 for 30 or more. A name
 * used 0 times is left out. Exact numbers stay on the PC.
 */
export type TelemetryBucket = 1 | 2 | 3 | 4;

export function countBucket(count: number): TelemetryBucket | 0 {
  if (!(count >= 1)) return 0;
  return count < 3 ? 1 : count < 10 ? 2 : count < 30 ? 3 : 4;
}

/** One width's day: the bucket of each counter used, and the controls shown (both sorted). */
export interface TelemetryWidthCounts {
  counts: Partial<Record<TelemetryCounter, TelemetryBucket>>;
  shown: TelemetryShown[];
}

/**
 * One install's use of the app's controls on one UTC day that has ended, sent once (POST /v1/counts).
 * `version` is the app's version that day. A width the app was not used at that day is null. The
 * kinds of agent, screen and way in of the day are in that day's active row, never in here.
 */
export interface TelemetryCounts {
  event: "counts";
  day: string;
  install_id: string;
  version: string;
  narrow: TelemetryWidthCounts | null;
  wide: TelemetryWidthCounts | null;
}

/** How many days back a counts message may name: it goes once its day has ended, so a PC off for a while still sends it. */
export const COUNTS_LATE_DAYS = 14;

/** What a browser tells the server it used, in one width, since it last told: counts to add and controls shown. */
export interface TelemetryCountsChange {
  width: TelemetryWidth;
  add: Partial<Record<TelemetryCounter, number>>;
  shown: TelemetryShown[];
  /**
   * the counting generation (TelemetryStatus.counts_generation) the page last heard: every off begins a new one,
   * and a batch from an older one (another tab's, from before an off) is dropped
   */
  generation?: number;
  /** the UTC day the batch was counted on (YYYY-MM-DD): a batch sent just after midnight still counts for the day before */
  day?: string;
}

const isCounter = (name: string): name is TelemetryCounter => (TELEMETRY_COUNTERS as readonly string[]).includes(name);
const isShown = (name: string): name is TelemetryShown => (TELEMETRY_SHOWN as readonly string[]).includes(name);

function plainRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null ? value as Record<string, unknown> : null;
}

/** `value`'s names that are TELEMETRY_SHOWN, sorted and without repeats; null when it is not an array of strings. Unknown names (a newer app's) are dropped. */
function shownNames(value: unknown): TelemetryShown[] | null {
  if (!Array.isArray(value) || value.some((name) => typeof name !== "string")) return null;
  return [...new Set((value as string[]).filter(isShown))].sort();
}

/**
 * One width's counts as the receiver keeps them: names it knows with a bucket, and shown controls it
 * knows. A name it does not know (a newer app's) or a value that is not a bucket is dropped, the rest
 * kept; null when the shape is not one at all.
 */
export function telemetryWidthCounts(value: unknown): TelemetryWidthCounts | null {
  const record = plainRecord(value);
  if (!record || Object.keys(record).length !== 2) return null;
  const counts = plainRecord(record["counts"]);
  const shown = shownNames(record["shown"]);
  if (!counts || !shown) return null;
  const clean: Partial<Record<TelemetryCounter, TelemetryBucket>> = {};
  for (const name of Object.keys(counts).sort()) {
    const bucket = counts[name];
    if (isCounter(name) && (bucket === 1 || bucket === 2 || bucket === 3 || bucket === 4)) clean[name] = bucket;
  }
  return { counts: clean, shown };
}

/**
 * A browser's counts change as the server takes it: known names with a whole count of 1 to
 * TELEMETRY_COUNT_MAX, known shown controls. Unknown names (a newer page's) are dropped; null when
 * the shape or the width is not one, or any count is not a whole count in range, known name or not:
 * that is no page's message.
 */
export function telemetryCountsChange(value: unknown): TelemetryCountsChange | null {
  const record = plainRecord(value);
  const keys = record ? Object.keys(record) : [];
  const optional = ["generation", "day"];
  if (!record || keys.filter((key) => !optional.includes(key)).length !== 3) return null;
  const generation = record["generation"];
  if (generation !== undefined && !integerBetween(0, Number.MAX_SAFE_INTEGER)(generation)) return null;
  const day = record["day"];
  if (day !== undefined && (typeof day !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(day))) return null;
  const width = record["width"];
  const add = plainRecord(record["add"]);
  const shown = shownNames(record["shown"]);
  if ((width !== "narrow" && width !== "wide") || !add || !shown) return null;
  const clean: Partial<Record<TelemetryCounter, number>> = {};
  const count = integerBetween(1, TELEMETRY_COUNT_MAX);
  for (const [name, value] of Object.entries(add)) {
    if (!count(value)) return null;
    if (isCounter(name)) clean[name] = value as number;
  }
  return { width, add: clean, shown, ...(generation === undefined ? {} : { generation: generation as number }), ...(day === undefined ? {} : { day: day as string }) };
}

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
  /** today's counts so far as they would be sent once the day has ended; absent from a server before counts */
  counts?: TelemetryCounts;
  /** the counting generation a browser's batches name (TelemetryCountsChange.generation); absent where counts are off */
  counts_generation?: number;
}
