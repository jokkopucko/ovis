/**
 * Anonymous install and update counts (shared/telemetry.ts). One event when an install first
 * runs, one when it runs a new version; nothing in between. Plus one active message per UTC day
 * a browser visits, naming the kinds of coding agents running then and the day's usage (the
 * kinds of screen and ways in of its visits, and its prompt answers and pane alerts counted by
 * `tally`, both only once the current notice was shown); a later visit that day resends it when a
 * new kind of agent appeared, or the usage changed and USAGE_RESEND_MS passed since it last went
 * (an earlier resend carries the usage already sent). Once a day has ended, its counts message (the fixed
 * controls a browser said it used that day, `tallyCounts`) goes once, as buckets; a day's exact numbers stay
 * here, and they are dropped when the switch is turned off. No event or message goes out before the app has
 * shown its notice once, while the switch is off, or where the environment says not to.
 * Events include the latest browser's schema-validated settings snapshot; free-form strings and
 * account identifiers are summarized or omitted by the browser's projection.
 * Only the real entrypoint (index.ts) makes one of these, so tests and a remote PC's bridge
 * send nothing.
 */
import { createHash, randomUUID } from "node:crypto";
import { accessSync, closeSync, constants, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, writeSync, type Stats } from "node:fs";
import { dirname, join } from "node:path";
import { ACTIVE_LATE_DAYS, countBucket, COUNTS_LATE_DAYS, emptyUsage, harnessOf, sameUsage, TELEMETRY_ANSWER_WAYS, telemetryAgentVersion, TELEMETRY_VERSIONS_MAX, type TelemetryAgentDay, type TelemetryAnswerWay, TELEMETRY_COUNT_MAX, TELEMETRY_COUNTERS, TELEMETRY_SHOWN, telemetryCountsChange, telemetryHarnesses, telemetrySettings, telemetrySurface, telemetryUsage, type InstallMethod, type TelemetryActive, type TelemetryBucket, type TelemetryChange, type TelemetryCounter, type TelemetryCounts, type TelemetryCountsChange, type TelemetryEvent, type TelemetryHarness, type TelemetryIngress, type TelemetryRuntime, type TelemetrySettings, type TelemetryShown, type TelemetryStatus, type TelemetrySurface, type TelemetryUsage, type TelemetryUsageCount, type TelemetryWidthCounts } from "../shared/telemetry.ts";
import { COUNTS_ON, NOTICE_VERSION } from "../shared/telemetry-notice.ts";
import { badRequest, errorResponse, isJsonObject, jsonResponse } from "./http.ts";
import { FileBusyError } from "./file-pool.ts";
import { updateRequestAllowed } from "./update-api.ts";

export const TELEMETRY_URL = "https://herdr-web-ui-telemetry.devswha.workers.dev/v1/events";
export const ACTIVE_URL = "https://herdr-web-ui-telemetry.devswha.workers.dev/v1/active";
export const COUNTS_URL = "https://herdr-web-ui-telemetry.devswha.workers.dev/v1/counts";
const FILE = "telemetry.json";
/** Each off replaces this mark. An on acknowledges the mark it saw without removing it. */
const OFF_FILE = "telemetry-off";
/** A mark written for an off an older build kept in FILE alone: no off happened then, so an on asked before it still goes. */
const MIGRATED_MARK = "migrated:";
const LOCK_FILE = "telemetry.lock";
/** how long a server waits for another's lock before it skips its write (an off is not skipped: it is marked before this wait, and goes without the lock after it) */
const LOCK_WAIT_MS = 200;
const LOCK_STALE_MS = 5_000;
/** a section holds the lock for well under a millisecond: one held this long, by anyone, was left behind */
const LOCK_MAX_HOLD_MS = 5 * 60_000;
const heldLocks = new Set<string>();
const CHANGE_BUSY = "Another Ovis server on this PC is changing the usage counts; try again";

function sleepSync(ms: number): void { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }

/**
 * whether the lock file was left by a server that is gone: its pid no longer runs, or it is this process's pid and this
 * process does not hold it (an earlier run with the same pid), or it never got a pid written and is older than
 * LOCK_STALE_MS (a lock being made has no pid for a moment), or anyone has held it past LOCK_MAX_HOLD_MS (a section takes
 * well under a millisecond; this also ends a lock whose pid another process reuses)
 */
function staleLock(file: string): boolean {
  try {
    const [pid = NaN] = readFileSync(file, "utf8").split(" ").map(Number);
    const age = Date.now() - statSync(file).mtimeMs;
    if (age > LOCK_MAX_HOLD_MS) return true;
    if (!Number.isSafeInteger(pid) || pid <= 0) return age > LOCK_STALE_MS;
    // this process's pid on a lock it does not hold: an earlier run with the same pid (a container's) stopped inside a section
    if (pid === process.pid) return !heldLocks.has(file);
    try { process.kill(pid, 0); return false; } catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    try { return Date.now() - statSync(file).mtimeMs > LOCK_STALE_MS; } catch { return false; }
  }
}
const SEND_TIMEOUT_MS = 10_000;
/** A claim outlives a POST's timeout but can be reclaimed after a crash or a skipped completion write. */
const SEND_CLAIM_MS = 2 * SEND_TIMEOUT_MS;
const START_DELAY_MS = 15_000;
/** after the notice was shown, time to read it and press Turn off before the first event goes */
export const NOTICE_GRACE_MS = 10 * 60_000;
/** the first notices that named the settings snapshot (3) and the daily visit with the agent kinds (4): shared/telemetry-notice.ts */
const SETTINGS_NOTICE_VERSION = 3;
const VISITS_NOTICE_VERSION = 4;
/**
 * how long after its UTC midnight a day's counts wait before they go: longer than a page holds a batch (FLUSH_MS in
 * src/lib/usageCounters.ts), so what was pressed in the day's last minute has arrived when the day is sent
 */
export const COUNTS_SETTLE_MS = 5 * 60_000;
const TELEMETRY_CHANGE_KEYS = new Set(["enabled", "notice_seen", "notice_version", "settings", "alert_opened", "counts", "generation"]);
const DAY = /^\d{4}-\d{2}-\d{2}$/;
/** today's usage (its kinds of screen and ways in as much as its counts) changes on the wire at most this often, and only with a
 * visit: a resend for a new kind of agent in between carries the usage already sent, so no message tells when a count changed */
export const USAGE_RESEND_MS = 60 * 60_000;
/** a change is a few small fields and at most one settings snapshot, which the receiver takes only under 8 KiB with the rest of its event */
const MAX_CHANGE_BYTES = 16 * 1024;

interface SendClaim {
  readonly id: string;
  readonly until: number;
}

function readClaim(value: unknown): SendClaim | undefined {
  if (!isJsonObject(value) || typeof value["id"] !== "string" || typeof value["until"] !== "number" || !Number.isFinite(value["until"])) return undefined;
  return { id: value["id"], until: value["until"] };
}

function claimSend(entry: { claim?: SendClaim }): SendClaim | null {
  const now = Date.now();
  if (entry.claim && entry.claim.until > now) return null;
  const claim = { id: randomUUID(), until: now + SEND_CLAIM_MS };
  entry.claim = claim;
  return claim;
}

interface ActiveDay {
  day: string;
  harnesses: TelemetryHarness[];
  sent: TelemetryHarness[] | null;
  /** a browser opened the app that day. A count made on a day without one (an alert at night) waits
   * for a visit that day and is never sent alone: the active row is a day the app was used */
  visited: boolean;
  usage: TelemetryUsage;
  sent_usage: TelemetryUsage | null;
  /** the usage last put on the wire for that day, answered or not: a retry within the hour carries it again, since
   * a receiver may have read a message whose answer was lost; null before one went */
  wire_usage: TelemetryUsage | null;
  sent_at: number | null;
  claim?: SendClaim;
  /** the day's answers per way, exactly: `usage.answers` sends only their buckets */
  answer_counts: Partial<Record<TelemetryAnswerWay, number>>;
}

/** What a visit saw of one pane: its agent, whether an Ovis server started it (launched-agents.ts), and the version its session names. */
export interface VisitPane {
  agent: string | null | undefined;
  ovis?: boolean;
  version?: string | null;
}

/** `agents` with what one visit saw added: per kind, the most panes of each origin at one visit, and the versions named. */
function withPanes(agents: Partial<Record<TelemetryHarness, TelemetryAgentDay>>, panes: readonly VisitPane[]): Partial<Record<TelemetryHarness, TelemetryAgentDay>> {
  const seen = new Map<TelemetryHarness, { ovis: number; other: number; versions: Set<string> }>();
  for (const pane of panes) {
    const kind = harnessOf(pane.agent);
    if (kind === null) continue;
    const day = seen.get(kind) ?? { ovis: 0, other: 0, versions: new Set<string>() };
    if (pane.ovis) day.ovis += 1; else day.other += 1;
    const version = telemetryAgentVersion(pane.version);
    if (version !== null) day.versions.add(version);
    seen.set(kind, day);
  }
  const next = { ...agents };
  for (const [kind, now] of seen) {
    const before = agents[kind];
    next[kind] = {
      ovis: Math.min(Math.max(before?.ovis ?? 0, now.ovis), TELEMETRY_COUNT_MAX),
      other: Math.min(Math.max(before?.other ?? 0, now.other), TELEMETRY_COUNT_MAX),
      versions: [...new Set([...(before?.versions ?? []), ...now.versions])].sort().slice(0, TELEMETRY_VERSIONS_MAX),
    };
  }
  return next;
}

function readAnswerCounts(value: unknown): Partial<Record<TelemetryAnswerWay, number>> {
  const counts: Partial<Record<TelemetryAnswerWay, number>> = {};
  if (!isJsonObject(value)) return counts;
  for (const way of TELEMETRY_ANSWER_WAYS) {
    const count = value[way];
    if (typeof count === "number" && Number.isInteger(count) && count > 0) counts[way] = Math.min(count, TELEMETRY_COUNT_MAX);
  }
  return counts;
}

function withKind<T extends string>(list: readonly T[], item: T | null | undefined): T[] {
  return item ? [...new Set([...list, item])].sort() : [...list];
}

interface Timer { clear(): void }

/**
 * a pane's agent waiting for its user: whether an answer from Ovis was delivered to it, whether it is over (and waits only
 * for the pane's answers under way), and the counting generation it began under (null: begun while nothing was counted)
 */
interface PaneWait { answered: boolean; ended: boolean; generation: number | null }
/** the most waits kept: one per pane, so more are of panes long closed */
const MAX_WAITS = 256;

function utcDay(ms: number): string { return new Date(ms).toISOString().slice(0, 10); }

function sameHarnesses(a: readonly TelemetryHarness[], b: readonly TelemetryHarness[]): boolean {
  return a.length === b.length && a.every((harness, index) => harness === b[index]);
}

function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }

function readActive(value: unknown): ActiveDay[] {
  if (!Array.isArray(value)) return [];
  const days: ActiveDay[] = [];
  for (const item of value) {
    if (!isJsonObject(item) || typeof item["day"] !== "string" || !DAY.test(item["day"])) continue;
    const harnesses = telemetryHarnesses(item["harnesses"]);
    const sent = item["sent"] === null ? null : telemetryHarnesses(item["sent"]);
    if (!harnesses || (item["sent"] !== null && !sent)) continue;
    if (days.some((known) => known.day === item["day"])) continue;
    const kept = telemetryUsage(item["usage"]);
    // a day an older build kept has no agents or answers yet: counted from here on
    const usage = kept === null ? emptyUsage() : { ...emptyUsage(), ...kept };
    const sentUsage = item["sent_usage"] === undefined ? (sent === null ? null : kept ?? emptyUsage()) : telemetryUsage(item["sent_usage"]);
    const wireUsage = item["wire_usage"] === undefined ? sentUsage : telemetryUsage(item["wire_usage"]);
    const sentAt = typeof item["sent_at"] === "number" && Number.isFinite(item["sent_at"]) ? item["sent_at"] : null;
    days.push({ day: item["day"], harnesses, sent, visited: item["visited"] !== false, usage, sent_usage: sentUsage, wire_usage: wireUsage, sent_at: sentAt, claim: readClaim(item["claim"]), answer_counts: readAnswerCounts(item["answer_counts"]) });
  }
  return days.sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
}

/**
 * The days with no usage counted: a day that only had counts (no visit) goes, and a delivered day keeps
 * its delivery without the usage, so dropping it sends nothing.
 */
function withoutUsage(days: ActiveDay[]): ActiveDay[] {
  return days.filter((entry) => entry.visited).map((entry) => ({ ...entry, usage: emptyUsage(), sent_usage: entry.sent_usage === null ? null : emptyUsage(), wire_usage: entry.wire_usage === null ? null : emptyUsage(), answer_counts: {} }));
}

interface WidthTally {
  counts: Partial<Record<TelemetryCounter, number>>;
  shown: TelemetryShown[];
}

interface CountDay {
  day: string;
  version: string;
  narrow: WidthTally | null;
  wide: WidthTally | null;
  claim?: SendClaim;
}

function readTally(value: unknown): WidthTally | null {
  if (!isJsonObject(value) || !isJsonObject(value["counts"]) || !Array.isArray(value["shown"])) return null;
  const counts: Partial<Record<TelemetryCounter, number>> = {};
  for (const [name, count] of Object.entries(value["counts"])) {
    if ((TELEMETRY_COUNTERS as readonly string[]).includes(name) && typeof count === "number" && Number.isInteger(count) && count >= 1) counts[name as TelemetryCounter] = Math.min(count, TELEMETRY_COUNT_MAX);
  }
  const shown = [...new Set(value["shown"].filter((name): name is TelemetryShown => typeof name === "string" && (TELEMETRY_SHOWN as readonly string[]).includes(name)))].sort();
  return { counts, shown };
}

function readCountDays(value: unknown): CountDay[] {
  if (!Array.isArray(value)) return [];
  const days: CountDay[] = [];
  for (const item of value) {
    if (!isJsonObject(item) || typeof item["day"] !== "string" || !DAY.test(item["day"]) || typeof item["version"] !== "string") continue;
    if (days.some((known) => known.day === item["day"])) continue;
    const narrow = item["narrow"] === null ? null : readTally(item["narrow"]);
    const wide = item["wide"] === null ? null : readTally(item["wide"]);
    if (narrow === null && wide === null) continue;
    days.push({ day: item["day"], version: item["version"], narrow, wide, claim: readClaim(item["claim"]) });
  }
  return days.sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
}

/** A width's day as it leaves this PC: each counter used as its bucket, in name order, and the shown controls. */
function widthCounts(tally: WidthTally | null): TelemetryWidthCounts | null {
  if (tally === null) return null;
  const counts: Partial<Record<TelemetryCounter, TelemetryBucket>> = {};
  for (const name of (Object.keys(tally.counts) as TelemetryCounter[]).sort()) {
    const bucket = countBucket(tally.counts[name] ?? 0);
    if (bucket !== 0) counts[name] = bucket;
  }
  return { counts, shown: [...tally.shown] };
}

interface Saved {
  install_id: string;
  enabled: boolean;
  enabled_mark: string | null;
  /** when the current notice (notice_version) was shown; null before, and for a file that saw only an older notice */
  notice_seen_at: string | null;
  notice_version: number;
  reported_version: string | null;
  /** an off came since the last delivered event: the version an update replaced was known before it, so the next
   * install or update event names none */
  replaced_forgotten: boolean;
  /**
   * how many offs have deleted what was not sent: a visit, a send or a browser batch begun before one does not write or
   * send after it. The browser hears it as TelemetryStatus.counts_generation and names it in each batch
   */
  forgotten: number;
  /** the visit days in `active` were recorded only after the current notice. A file without it (an older build's) may
   * hold a day recorded before the notice, so its days not yet delivered are dropped when read */
  visits_after_notice: true;
  /** the last browser's complete, allowlisted settings snapshot; null before one has */
  settings: TelemetrySettings | null;
  active: ActiveDay[];
  /** the usage in `active` was counted only after the current notice. A file without it (an older build's) may hold usage
   * counted before the notice, so its usage is dropped when read; so is any usage while the current notice is unseen */
  usage_after_notice: true;
  /** days whose counts were not delivered yet, ascending, no older than COUNTS_LATE_DAYS; counted only after the current notice */
  counts: CountDay[];
}

type Env = Record<string, string | undefined>;

export function telemetryBlocked(env: Env): boolean {
  const own = env["OVIS_TELEMETRY"]?.trim().toLowerCase();
  if (own && ["0", "false", "off", "no"].includes(own)) return true;
  const dnt = env["DO_NOT_TRACK"]?.trim();
  if (dnt && dnt !== "0") return true;
  return Boolean(env["CI"] || env["HERDR_TEST_MODE"] || env["HERDR_TEST_SESSION"]);
}

/**
 * What a visit's `/ws?surface=` gives the day's usage: a known kind of screen; null when the page named none (a page
 * from before surfaces: the visit still counts its way in); or false for any other value, whose connection then counts
 * no usage at all, neither a screen nor its way in. The connection itself is never refused for it.
 */
export function visitSurface(asked: string | null): TelemetrySurface | null | false {
  return asked === null ? null : telemetrySurface(asked) ?? false;
}

export function installMethod(env: Env): InstallMethod {
  if (env["HERDR_PLUGIN_ROOT"]) return "plugin";
  return env["OVIS_MANAGED"] === "1" ? "managed" : "source";
}

function telemetryChange(value: unknown): TelemetryChange | null {
  try {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return null;

    const keys = Reflect.ownKeys(value);
    if (keys.some((key) => typeof key !== "string" || !TELEMETRY_CHANGE_KEYS.has(key))) return null;

    const clean: TelemetryChange = {};
    for (const key of keys as string[]) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) return null;
      switch (key) {
        case "enabled":
          if (typeof descriptor.value !== "boolean") return null;
          clean.enabled = descriptor.value;
          break;
        case "notice_seen":
          if (descriptor.value !== true) return null;
          clean.notice_seen = true;
          break;
        case "notice_version":
          if (descriptor.value !== NOTICE_VERSION) return null;
          clean.notice_version = NOTICE_VERSION;
          break;
        case "settings": {
          const settings = telemetrySettings(descriptor.value);
          if (!settings) return null;
          clean.settings = settings;
          break;
        }
        case "alert_opened":
          if (descriptor.value !== true) return null;
          clean.alert_opened = true;
          break;
        case "generation":
          if (typeof descriptor.value !== "number" || !Number.isSafeInteger(descriptor.value) || descriptor.value < 0) return null;
          clean.generation = descriptor.value;
          break;
        case "counts": {
          const counts = telemetryCountsChange(descriptor.value);
          if (!counts) return null;
          clean.counts = counts;
          break;
        }
      }
    }
    if (clean.notice_seen === true && clean.notice_version !== NOTICE_VERSION) return null;
    return clean;
  } catch {
    return null;
  }
}

/** Null is a missing mark; undefined means the mark could not be read and the counts stay off. */
function offMark(offFile: string): string | null | undefined {
  let stat: Stats;
  try {
    stat = lstatSync(offFile);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") return undefined;
    try {
      accessSync(dirname(offFile), constants.R_OK | constants.X_OK);
      return null;
    } catch { return undefined; }
  }
  if (!stat.isFile()) return undefined;
  try {
    // Older versions wrote an empty file.
    return readFileSync(offFile, "utf8") || `legacy:${stat.ino}:${stat.mtimeMs}:${stat.ctimeMs}`;
  } catch { return undefined; }
}

/** the bits of a page's counting generation below the counter: they name the off mark */
const MARK_BITS = 24;

/**
 * The counting generation a page hears (TelemetryStatus.counts_generation) and names with its settings and batches: the
 * counter of offs, and below it a hash of the off mark. Every off writes a new mark, and a mark never comes back once
 * replaced, so a generation heard before an off is not the one after it, even when the off's server went before it raised
 * the counter (#4213). It still grows with every off that does raise it, which a page's counts rely on.
 */
function pageGeneration(forgotten: number, mark: string | null | undefined): number {
  const tag = typeof mark === "string" ? createHash("sha256").update(mark).digest().readUIntBE(0, MARK_BITS / 8) : 0;
  return Math.min(forgotten, Math.floor(Number.MAX_SAFE_INTEGER / 2 ** MARK_BITS)) * 2 ** MARK_BITS + tag;
}

/** Whether FILE itself says on, whatever the mark says; false when it cannot be read. */
function fileSaysOn(file: string): boolean {
  try {
    const value: unknown = JSON.parse(readFileSync(file, "utf8"));
    return isJsonObject(value) && value["enabled"] !== false;
  } catch { return false; }
}

function keptDiffers(file: string, saved: Saved): boolean {
  try {
    const value = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    if (value["visits_after_notice"] !== true) return true;
    return JSON.stringify([value["active"] ?? [], value["counts"] ?? [], value["settings"] ?? null]) !== JSON.stringify([saved.active, saved.counts, saved.settings]);
  } catch { return false; }
}

function readSaved(file: string, offFile: string): Saved | null {
  try {
    const value: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (!isJsonObject(value) || typeof value["install_id"] !== "string" || value["install_id"] === "") return null;
    // a switch an older build turned off is copied into OFF_FILE whenever it is read, so no late write of FILE can turn it
    // on; a read that cannot write it now still reads off, and the next read tries again
    const mark = offMark(offFile);
    if (value["enabled"] === false && mark === null) {
      try { writeFileSync(offFile, `${MIGRATED_MARK}${randomUUID()}`, { flag: "wx", mode: 0o600 }); } catch { /* already marked or read-only: still off */ }
    }
    // a notice from before it said what is sent now does not count: it is shown again first
    const noticeSeenAt = value["notice_version"] === NOTICE_VERSION && typeof value["notice_seen_at"] === "string" ? value["notice_seen_at"] : null;
    // the notice that was seen, if any: what was kept under it stays only as far as it said so
    const seenVersion = typeof value["notice_seen_at"] === "string" && typeof value["notice_version"] === "number" ? value["notice_version"] : 0;
    // days an older build kept may have been recorded before the notice: only the ones it delivered stay, so none is sent again
    // and a delivered one is cut back to what was delivered of it: what was added since may be from before an off
    const active = seenVersion < VISITS_NOTICE_VERSION ? [] : value["visits_after_notice"] === true ? readActive(value["active"]) : readActive(value["active"]).flatMap((entry) => entry.sent === null ? [] : [{ ...entry, harnesses: [...entry.sent], usage: entry.sent_usage ?? emptyUsage(), sent_usage: entry.sent_usage ?? emptyUsage(), wire_usage: entry.sent_usage ?? emptyUsage() }]);
    // a file that is off keeps nothing to send: an older build, or a write that failed, may have left rows in it
    const enabledMark = typeof value["enabled_mark"] === "string" ? value["enabled_mark"] : null;
    const on = value["enabled"] !== false && mark === enabledMark;
    return {
      install_id: value["install_id"],
      enabled: on,
      enabled_mark: enabledMark,
      notice_seen_at: noticeSeenAt,
      notice_version: NOTICE_VERSION,
      reported_version: typeof value["reported_version"] === "string" ? value["reported_version"] : null,
      replaced_forgotten: value["replaced_forgotten"] === true,
      forgotten: typeof value["forgotten"] === "number" && Number.isSafeInteger(value["forgotten"]) && value["forgotten"] >= 0 ? value["forgotten"] : 0,
      visits_after_notice: true,
      // an older build kept a snapshot told before its notice too: one from a file without the mark waits for a page to tell it again
      settings: on && seenVersion >= SETTINGS_NOTICE_VERSION && value["visits_after_notice"] === true ? telemetrySettings(value["settings"]) : null,
      active: !on ? [] : noticeSeenAt !== null && value["usage_after_notice"] === true ? active : withoutUsage(active),
      usage_after_notice: true,
      // counted only once the current notice was shown: a file whose notice is older keeps none
      counts: noticeSeenAt === null || !on ? [] : readCountDays(value["counts"]),
    };
  } catch { return null; }
}

export class Telemetry {
  private saved: Saved;
  private sending: Promise<void> | null = null;
  private abort?: AbortController;
  private timer?: ReturnType<typeof setTimeout>;
  private activeSending: Promise<void> | null = null;
  private activeAgain = false;
  private activeAgainVisit = false;
  private activeAbort?: AbortController;
  private activeTimer?: Timer;
  private countsSending: Promise<void> | null = null;
  private readonly countsDelivered = new Map<string, number>();
  private countsAbort?: AbortController;
  /** how deep this server is in a lock section: one inside another takes no second lock, so a server never waits on itself */
  private lockDepth = 0;
  private lockStamp: string | null = null;
  private countsTimer?: Timer;
  private readonly file: string;
  private readonly offFile: string;
  /** false when the state file could not be written: then nothing is sent (it could not be remembered) */
  private writable = true;
  /** each pane whose agent waits for its user (`paneStatus`), in memory only */
  private readonly waits = new Map<string, PaneWait>();
  /** each pane's answers from Ovis under way (`answering`) */
  private readonly inFlight = new Map<string, number>();

  constructor(private readonly options: {
    stateDir: string;
    version: string;
    env: Env;
    fetch: typeof fetch;
    url?: string;
    activeUrl?: string;
    countsUrl?: string;
    /** whether buttons are counted; COUNTS_ON (this build's notice says so) when unset. Tests turn it on */
    countsOn?: boolean;
    platform?: string;
    arch?: string;
    previousVersion?: () => string | null;
    runtime?: TelemetryRuntime;
    now?: () => number;
    noticeGraceMs?: number;
    setTimer?: (fn: () => void, ms: number) => Timer;
  }) {
    this.file = join(options.stateDir, FILE);
    this.offFile = join(options.stateDir, OFF_FILE);
    // a first run's state directory is made before the mark is looked for: one that is not there reads off
    try { mkdirSync(options.stateDir, { recursive: true, mode: 0o700 }); } catch { /* not made: offMark reads off */ }
    const saved = readSaved(this.file, this.offFile);
    // a state made fresh names no version an update replaced: the updater's record of it is from before this file (one a
    // purge removed, or one that never was)
    this.saved = saved ?? { install_id: randomUUID(), enabled: offMark(this.offFile) === null, enabled_mark: null, notice_seen_at: null, notice_version: NOTICE_VERSION, reported_version: null, replaced_forgotten: true, forgotten: 0, visits_after_notice: true, settings: null, active: [], usage_after_notice: true, counts: [] };
    // what was read and not kept (an older build's rows, an off file's) is written away once, so it does not stay on disk
    if (saved) {
      this.locked(() => {
        this.refresh();
        if (!keptDiffers(this.file, this.saved)) return;
        try { this.persist(); } catch (error) {
          console.error(`telemetry: ${this.file} could not be written (${error instanceof Error ? error.message : String(error)})`);
        }
      }, () => this.skipped("the start's cleaned state"));
    } else {
      this.locked(() => {
        const made = readSaved(this.file, this.offFile);
        if (made) { this.saved = made; return; }
        try { this.persist(); } catch (error) {
          this.writable = false;
          console.error(`telemetry: ${this.file} could not be written, so nothing will be sent (${error instanceof Error ? error.message : String(error)})`);
        }
      }, () => { this.skipped("a new state"); this.refresh(); });
    }
    // the environment forbids sending: as an off, whatever was kept and not sent is deleted, so none of it goes once the
    // variable is removed; like an off it goes without the lock when another server holds it
    if (this.blocked() && this.writable) {
      const purge = () => {
        this.refresh();
        this.forgetUnsent();
        try { this.persist(); } catch (error) {
          // the deletion could not be written: the old file would send what it holds once the variable is gone, so the file
          // goes instead (a removal usually still works on a full disk; the next start makes a new install ID)
          console.error(`telemetry: ${this.file} could not be written, so it is removed (${error instanceof Error ? error.message : String(error)})`);
          try { rmSync(this.file, { force: true }); } catch (removal) {
            console.error(`telemetry: ${this.file} could not be removed either (${removal instanceof Error ? removal.message : String(removal)})`);
          }
        }
      };
      this.locked(purge, purge);
    }
  }

  private now(): number { return this.options.now?.() ?? Date.now(); }

  /** another server on the same state directory may have changed the switch: its file wins */
  private refresh(): void {
    const latest = readSaved(this.file, this.offFile);
    if (latest) this.saved = latest;
    // the file could not be read: what is known of it stays, but an off, or no way to tell, wins
    else if (offMark(this.offFile) !== this.saved.enabled_mark) this.saved.enabled = false;
  }

  private markOff(): void {
    mkdirSync(this.options.stateDir, { recursive: true, mode: 0o700 });
    const mark = randomUUID();
    const temp = `${this.offFile}.${mark}.tmp`;
    writeFileSync(temp, mark, { mode: 0o600 });
    try { renameSync(temp, this.offFile); } catch (error) {
      rmSync(temp, { force: true });
      throw error;
    }
  }

  private persist(): boolean {
    mkdirSync(this.options.stateDir, { recursive: true, mode: 0o700 });
    // an off another server wrote since this one read the file: what this one holds is from before it, so it is not
    // written back, and the counter is never lowered
    const onDisk = readSaved(this.file, this.offFile);
    if (onDisk && onDisk.forgotten > this.saved.forgotten) {
      this.saved.forgotten = onDisk.forgotten;
      this.saved.active = [];
      this.saved.counts = [];
      this.saved.settings = null;
      this.saved.replaced_forgotten = true;
    }
    const temp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(temp, JSON.stringify(this.saved), { mode: 0o600 });
    // inside a section, right before the rename: a lock that no longer holds this section's stamp was taken over (this
    // server stalled past LOCK_MAX_HOLD_MS), so another server may have written since, and this state is not put back
    if (this.lockStamp !== null) {
      let still = false;
      try { still = readFileSync(join(this.options.stateDir, LOCK_FILE), "utf8") === this.lockStamp; } catch {}
      if (!still) {
        rmSync(temp, { force: true });
        console.error(`telemetry: ${this.file} was not written: this server's lock was taken over while it held it`);
        return false;
      }
    }
    renameSync(temp, this.file);
    this.writable = true;
    return true;
  }

  private schedule(ms: number): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => { void this.report(); void this.flushCounts(); }, ms);
    this.timer.unref?.();
  }

  private blocked(): boolean { return telemetryBlocked(this.options.env); }

  private prune(): boolean {
    const today = new Date(this.now());
    const cutoff = utcDay(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - ACTIVE_LATE_DAYS));
    const kept = this.saved.active.filter((entry) => entry.day >= cutoff);
    const countsCutoff = utcDay(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - COUNTS_LATE_DAYS));
    const counts = this.saved.counts.filter((entry) => entry.day >= countsCutoff);
    if (kept.length === this.saved.active.length && counts.length === this.saved.counts.length) return false;
    this.saved.active = kept;
    this.saved.counts = counts;
    return true;
  }

  private countsMessage(day: string): TelemetryCounts {
    const entry = this.saved.counts.find((known) => known.day === day);
    return { event: "counts", day, install_id: this.saved.install_id, version: entry?.version ?? this.options.version, narrow: widthCounts(entry?.narrow ?? null), wide: widthCounts(entry?.wide ?? null) };
  }

  private activeMessage(entry?: { day: string; harnesses: TelemetryHarness[]; usage: TelemetryUsage }): TelemetryActive {
    return {
      event: "active",
      day: entry?.day ?? utcDay(this.now()),
      install_id: this.saved.install_id,
      version: this.options.version,
      os: this.options.platform ?? process.platform,
      arch: this.options.arch ?? process.arch,
      install_method: installMethod(this.options.env),
      harnesses: [...(entry?.harnesses ?? [])],
      usage: entry ? { ...entry.usage, surfaces: [...entry.usage.surfaces], ingress: [...entry.usage.ingress] } : emptyUsage(),
      runtime: this.options.runtime ?? "herdr",
    };
  }

  private pending(): TelemetryEvent | null {
    const { version } = this.options;
    const reported = this.saved.reported_version;
    if (reported === version) return null;
    const known = reported ?? this.options.previousVersion?.() ?? null;
    const update = known !== null && known !== version;
    // after an off the version it replaced is a fact from before it: an update that names none, as one from before telemetry
    const replaced = this.saved.replaced_forgotten ? null : known;
    return {
      event: update ? "update" : "install",
      install_id: this.saved.install_id,
      version,
      previous_version: update ? replaced : null,
      os: this.options.platform ?? process.platform,
      arch: this.options.arch ?? process.arch,
      install_method: installMethod(this.options.env),
      settings: this.saved.settings === null ? null : telemetrySettings(this.saved.settings),
      runtime: this.options.runtime ?? "herdr",
    };
  }

  status(): TelemetryStatus {
    // read before the refresh: the generation never names an off the state told with it did not see
    const mark = offMark(this.offFile);
    this.refresh();
    return {
      enabled: this.saved.enabled,
      blocked_by_env: this.blocked(),
      notice_seen: this.saved.notice_seen_at !== null,
      next: this.pending(),
      active: this.activeMessage(this.saved.active.find((entry) => entry.day === utcDay(this.now()))),
      ...(this.countsOn() ? { counts: this.countsMessage(utcDay(this.now())), counts_generation: pageGeneration(this.saved.forgotten, mark) } : {}),
    };
  }

  change(patch: TelemetryChange): TelemetryStatus {
    const clean = telemetryChange(patch);
    if (!clean) throw new TypeError("Invalid telemetry change");
    // turned off while an event is on its way: stop it before anything is read or written (a read may write the mark), and
    // even if OFF_FILE cannot be written
    if (clean.enabled === false) {
      this.abort?.abort(); this.activeAbort?.abort(); this.countsAbort?.abort();
      // marked before the lock is even asked for: another server's send checks the mark right before it goes, so an off
      // stops it at once, whatever the wait for the lock
      this.markOff();
    }
    // the off mark an on was asked against: an off marked after it, even one done before this server gets the lock, wins
    const markAsked = clean.enabled === true ? offMark(this.offFile) : null;
    const apply = () => this.locked((): "applied" | "superseded" => {
      let markAtStart = offMark(this.offFile);
      if (clean.enabled === true && markAtStart !== markAsked && !(markAsked === null && markAtStart?.startsWith(MIGRATED_MARK))) return "superseded";
      this.refresh();
      // the read just now marked an older build's off: that mark is the one this change found
      if (markAtStart === null) {
        const migrated = offMark(this.offFile);
        if (migrated?.startsWith(MIGRATED_MARK)) markAtStart = migrated;
      }
      // the generation as the request found it: settings told with the one the page heard last are from now
      const heard = pageGeneration(this.saved.forgotten, markAtStart);
      // an off another server marked and has not written yet: no page heard it, so settings told now may be from before it
      const offUnwritten = !this.saved.enabled && fileSaysOn(this.file);
      // off is marked before FILE is written, whatever another server writes to FILE meanwhile
      if (clean.enabled === false) this.markOff();
      // nothing kept before an off is sent after it: the off, and an on after an off (one another server marked), drop every
      // visit day and count day not yet delivered
      if (clean.enabled === false || (clean.enabled === true && !this.saved.enabled)) this.forgetUnsent();
      if (clean.enabled === true) {
        if (markAtStart === undefined) return "superseded";
        this.saved.enabled_mark = markAtStart;
      }
      if (clean.enabled !== undefined) this.saved.enabled = clean.enabled;
      // on again with nothing owed: the version running now is what a later update replaces, known at the on
      if (clean.enabled === true && this.saved.reported_version === this.options.version) this.saved.replaced_forgotten = false;
      if (clean.notice_seen && this.saved.notice_seen_at === null) this.saved.notice_seen_at = new Date(this.now()).toISOString();
      // kept for the next install/update event, only once the notice that names it was seen (the page sends it with its
      // acknowledgement) and while the counts are on; telling it sends nothing by itself
      // a request that names no generation, or one from before an off the page had not heard, keeps none: they may be from
      // before it (a request delayed while another page turned the counts off and on)
      if (clean.settings !== undefined && clean.generation === heard && !offUnwritten && this.saved.notice_seen_at !== null && this.saved.enabled && !this.blocked()) this.saved.settings = clean.settings;
      if (clean.enabled !== false && offMark(this.offFile) !== markAtStart) return "superseded";
      if (!this.persist()) throw new FileBusyError(CHANGE_BUSY);
      // and again after: an on from another server between the two writes cannot leave this off without its mark
      if (clean.enabled === false) this.markOff();
      return "applied";
    }, (): "applied" | "superseded" | "busy" => {
      // another server holds the lock: an off still goes, with its mark and without what was not sent; anything else waits
      if (clean.enabled !== false) return "busy";
      this.markOff();
      this.refresh();
      this.forgetUnsent();
      this.saved.enabled = false;
      try { this.persist(); } catch (error) { console.error(`telemetry: ${this.file} could not be written (${message(error)})`); }
      this.markOff();
      return "applied";
    });
    let applied = apply();
    if (applied === "busy") applied = apply();
    if (applied === "busy") throw new FileBusyError(CHANGE_BUSY);
    if (applied === "superseded") return this.status();
    if (clean.alert_opened) {
      if (this.tally("alerts_opened") === false) throw new FileBusyError(CHANGE_BUSY);
      // a tap alone sends nothing: the day's next visit carries it, so no message tells when it was
      if (Object.keys(clean).length === 1) return this.status();
    }
    if (clean.counts) {
      if (this.tallyCounts(clean.counts) === false) throw new FileBusyError(CHANGE_BUSY);
      // a browser's counts alone send nothing: a finished day goes at a start or a visit, so no message tells when a button was pressed
      if (Object.keys(clean).length === 1) return this.status();
    }
    void this.report();
    void this.flushActive();
    void this.flushCounts();
    return this.status();
  }

  /**
   * Everything captured and not delivered yet, gone: visit days, count days and the settings snapshot. This version's
   * install or update event may still go once the counts are on, built from what holds then: no settings until a page
   * tells them again, and no version it replaced (known only from before the off).
   */
  private forgetUnsent(): void {
    this.saved.active = [];
    this.saved.counts = [];
    this.saved.settings = null;
    this.saved.replaced_forgotten = true;
    this.saved.forgotten += 1;
  }

  /** Whether a browser visit is recorded at all: never while the switch is off or the environment forbids sending. */
  counting(): boolean {
    if (!this.writable) return false;
    this.refresh();
    return this.saved.enabled && !this.blocked();
  }

  /** Whether the day's usage is counted: as visits are, and only once the current notice, which names it, was shown. */
  private countingUsage(): boolean {
    return this.counting() && this.saved.notice_seen_at !== null;
  }

  /**
   * Counts one prompt answer, alert delivered or alert tapped in today's usage; never while usage
   * is not counted. It sends nothing by itself: the day's next visit (or a later day's) carries it.
   */
  tally(kind: TelemetryUsageCount): boolean | undefined {
    return this.countToday(`the ${kind} count`, (entry) => {
      if (entry.usage[kind] >= TELEMETRY_COUNT_MAX) return false;
      entry.usage = { ...entry.usage, [kind]: entry.usage[kind] + 1 };
      return true;
    });
  }

  /** Changes today's row as `change` says (false: nothing changed) and records it; never while usage is not counted. */
  private countToday(what: string, change: (entry: ActiveDay) => boolean): boolean | undefined { return this.locked(() => {
      if (!this.countingUsage()) return;
      const day = utcDay(this.now());
      this.prune();
      if (!this.saved.active.some((entry) => entry.day === day)) {
        this.saved.active = readActive([...this.saved.active, { day, harnesses: [], sent: null, visited: false, usage: emptyUsage(), sent_usage: null, wire_usage: null, sent_at: null, answer_counts: {} }]);
      }
      const entry = this.saved.active.find((known) => known.day === day);
      if (!entry || !change(entry)) return;
      try { return this.persist(); } catch (error) {
        console.error(`telemetry: ${what} could not be recorded (${message(error)})`);
      }
    }, () => { this.skipped(what); return false; });
  }

  /** the counting generation now, or null while nothing is counted: what began under another is not counted when it ends */
  private generation(): number | null { return this.countingUsage() ? this.saved.forgotten : null; }

  /** One answer that went the given way: counted under its way, and as a prompt answer when it went from Ovis. */
  private tallyAnswer(way: TelemetryAnswerWay, generation: number | null): void {
    if (generation === null || generation !== this.saved.forgotten) return;
    this.countToday(`the ${way} answer count`, (entry) => {
      const count = Math.min((entry.answer_counts[way] ?? 0) + 1, TELEMETRY_COUNT_MAX);
      entry.answer_counts = { ...entry.answer_counts, [way]: count };
      const bucket = countBucket(count) as TelemetryBucket;
      const fromOvis = way !== "terminal" && entry.usage.prompt_answers < TELEMETRY_COUNT_MAX;
      entry.usage = { ...entry.usage, answers: { ...entry.usage.answers, [way]: bucket }, ...(fromOvis ? { prompt_answers: entry.usage.prompt_answers + 1 } : {}) };
      return true;
    });
  }

  /**
   * Told as an answer from a card begins on a pane; what it gives back is told once that answer ended, with the way it
   * went (TelemetryAnswerWay) when it was delivered, else null. An answer delivered while the pane's agent waited
   * (`paneStatus`) is that wait's: a wait that ends with none counts as answered at the `terminal`.
   */
  answering(paneId: string): (way: Exclude<TelemetryAnswerWay, "terminal"> | null) => void {
    const generation = this.generation();
    this.inFlight.set(paneId, (this.inFlight.get(paneId) ?? 0) + 1);
    return (way) => {
      const left = (this.inFlight.get(paneId) ?? 1) - 1;
      if (left > 0) this.inFlight.set(paneId, left); else this.inFlight.delete(paneId);
      if (way !== null) this.tallyAnswer(way, generation);
      // the pane's wait now, whenever it began: a blocked report can arrive after the answer did
      const wait = this.waits.get(paneId);
      if (!wait) return;
      if (way !== null) wait.answered = true;
      if (wait.ended && left === 0) this.waitEnded(paneId, wait);
    };
  }

  /**
   * The status a pane's agent reported. `blocked` begins a wait for its user; any other status ends it (once an answer
   * under way has ended), as answered at the terminal when no answer from Ovis was delivered to it.
   */
  paneStatus(paneId: string, status: string): void {
    const wait = this.waits.get(paneId);
    if (status === "blocked") {
      if (wait && !wait.ended) return;
      // a wait that ended while an answer was under way is that answer's, which is not known to have missed it: no terminal
      if (wait) this.waits.delete(paneId);
      if (this.waits.size >= MAX_WAITS) this.waits.delete(this.waits.keys().next().value!);
      this.waits.set(paneId, { answered: false, ended: false, generation: this.generation() });
      return;
    }
    if (!wait || wait.ended) return;
    wait.ended = true;
    if (!this.inFlight.get(paneId)) this.waitEnded(paneId, wait);
  }

  private waitEnded(paneId: string, wait: PaneWait): void {
    if (this.waits.get(paneId) === wait) this.waits.delete(paneId);
    if (!wait.answered) this.tallyAnswer("terminal", wait.generation);
  }

  /**
   * Adds what a browser used in one width to today's counts (each to TELEMETRY_COUNT_MAX) under the running
   * version; never while usage is not counted (off, blocked, or the current notice not shown), so nothing
   * pressed before the notice is kept. It sends nothing by itself.
   */
  tallyCounts(change: TelemetryCountsChange): false | undefined { return this.locked(() => {
      if (!this.countsOn() || !this.countingUsage()) return;
      // counted under another generation (before an off, in a tab that did not hear it), or by a page that names none
      if (change.generation !== pageGeneration(this.saved.forgotten, offMark(this.offFile))) return;
      const today = utcDay(this.now());
      const yesterday = utcDay(this.now() - 86_400_000);
      const day = change.day ?? today;
      if (day !== today && day !== yesterday) return;
      this.prune();
      let entry = this.saved.counts.find((known) => known.day === day);
      if (!entry) {
        entry = { day, version: this.options.version, narrow: null, wide: null };
        this.saved.counts = [...this.saved.counts, entry].sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
      }
      entry.version = this.options.version;
      const tally = entry[change.width] ?? { counts: {}, shown: [] };
      for (const [name, add] of Object.entries(change.add) as [TelemetryCounter, number][]) {
        tally.counts[name] = Math.min((tally.counts[name] ?? 0) + add, TELEMETRY_COUNT_MAX);
      }
      tally.shown = [...new Set([...tally.shown, ...change.shown])].sort();
      entry[change.width] = tally;
      try { if (!this.persist()) return false; } catch (error) {
        console.error(`telemetry: the counts could not be recorded (${message(error)})`);
      }
      if (day !== today) this.settleLater();
    }, () => { this.skipped("a browser's counts"); return false; });
  }

  private countsOn(): boolean { return this.options.countsOn ?? COUNTS_ON; }

  /** whether a browser's counts are taken at all: not while this build's notice does not say so, where they are refused as before */
  takesCounts(): boolean { return this.countsOn(); }

  /**
   * Delivers each recorded day that has ended, oldest first, once: a delivered day is forgotten. No sooner than
   * COUNTS_SETTLE_MS after the day's end, nor NOTICE_GRACE_MS after the notice; a failure is logged and tried again at the next start or visit. A day the
   * receiver took is also remembered in this process, so one whose removal could not be written is not sent twice
   * while it runs; after a restart such a day is in the file and goes again (the receiver keeps the first message).
   */
  private flushCounts(): Promise<void> {
    if (!this.countsOn()) return Promise.resolve();
    if (this.countsSending) return this.countsSending;
    if (!this.writable) return Promise.resolve();
    this.refresh();
    const seen = this.saved.notice_seen_at === null ? NaN : Date.parse(this.saved.notice_seen_at);
    if (!this.saved.enabled || Number.isNaN(seen) || this.blocked()) return Promise.resolve();
    if (this.now() < seen + (this.options.noticeGraceMs ?? NOTICE_GRACE_MS)) return Promise.resolve();
    const pruned = this.locked(() => {
      this.refresh();
      try { return !this.prune() || this.persist(); } catch (error) {
        console.error(`telemetry: ${this.file} could not be written (${message(error)})`);
        return false;
      }
    }, () => { this.skipped("the counts to send"); return false; });
    if (!pruned) return Promise.resolve();
    // a day goes once it has ended and COUNTS_SETTLE_MS more have passed, for the batches still on their way
    const settled = utcDay(this.now() - COUNTS_SETTLE_MS);
    const generation = this.saved.forgotten;
    const due = this.saved.counts.filter((entry) => entry.day < settled && this.countsDelivered.get(entry.day) !== generation).map((entry) => entry.day);
    this.settleLater();
    if (due.length === 0) return Promise.resolve();
    const abort = new AbortController();
    this.countsAbort = abort;
    this.countsSending = (async () => {
      try {
        for (const day of due) {
          const next = this.locked(() => {
            this.refresh();
            if (abort.signal.aborted || !this.saved.enabled || this.saved.forgotten !== generation) return "stop";
            const entry = this.saved.counts.find((known) => known.day === day);
            const claim = entry && claimSend(entry);
            if (!claim) return "skip";
            return this.persist() ? { claim, counts: this.countsMessage(day) } : "stop";
          }, () => { this.skipped("a counts message about to go"); return "stop" as const; });
          if (next === "stop") return;
          if (next === "skip") continue;
          let delivered = false;
          try {
            this.refresh();
            if (abort.signal.aborted || !this.saved.enabled || this.saved.forgotten !== generation
              || !this.saved.counts.some((entry) => entry.day === day && entry.claim?.id === next.claim.id)) return;
            // last, the statement before the POST: an off marked since the reads above
            if (offMark(this.offFile) !== this.saved.enabled_mark) return;
            const response = await this.options.fetch(this.options.countsUrl ?? COUNTS_URL, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(next.counts),
              signal: AbortSignal.any([abort.signal, AbortSignal.timeout(SEND_TIMEOUT_MS)]),
            });
            delivered = response.ok;
            if (!delivered) throw new Error(`HTTP ${response.status}`);
          } catch (error) {
            if (!abort.signal.aborted) console.error(`telemetry: the counts message was not delivered (${message(error)})`);
            return;
          } finally {
            if (delivered) this.countsDelivered.set(day, generation);
            this.locked(() => {
              this.refresh();
              // A completion from before an off cannot touch the new generation.
              if (this.saved.forgotten !== generation) return;
              const entry = this.saved.counts.find((known) => known.day === day);
              if (entry?.claim?.id !== next.claim.id) return;
              if (delivered) this.saved.counts = this.saved.counts.filter((known) => known.day !== day);
              else delete entry.claim;
              this.persist();
            }, () => this.skipped("a counts day's delivery"));
          }
        }
      } catch (error) {
        console.error(`telemetry: ${this.file} could not be written (${message(error)})`);
      }
    })().finally(() => {
      this.countsSending = null;
      this.countsAbort = undefined;
    });
    return this.countsSending;
  }

  /**
   * A day that has ended but is still settling: one flush at the end of the settle time, which checks everything again
   * (on, notice, generation), so the day does not wait for a start or visit that may not come before it is too old.
   */
  private settleLater(): void {
    const today = utcDay(this.now());
    const settled = utcDay(this.now() - COUNTS_SETTLE_MS);
    if (settled === today || !this.saved.counts.some((entry) => entry.day === settled && this.countsDelivered.get(entry.day) !== this.saved.forgotten)) return;
    this.countsTimer?.clear();
    this.countsTimer = this.arm(() => void this.flushCounts(), Date.parse(`${today}T00:00:00Z`) + COUNTS_SETTLE_MS - this.now());
  }

  private locked<T>(section: () => T, busy: () => T): T {
    if (this.lockDepth > 0) {
      this.lockDepth += 1;
      try { return section(); } finally { this.lockDepth -= 1; }
    }
    const lock = join(this.options.stateDir, LOCK_FILE);
    const deadline = Date.now() + LOCK_WAIT_MS;
    const stamp = `${process.pid} ${Date.now()} ${randomUUID()}`;
    for (;;) {
      try {
        const fd = openSync(lock, "wx", 0o600);
        try { writeSync(fd, stamp); } finally { closeSync(fd); }
        heldLocks.add(lock);
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") return busy();
        if (staleLock(lock)) { rmSync(lock, { force: true }); continue; }
        if (Date.now() >= deadline) return busy();
        sleepSync(5);
      }
    }
    this.lockDepth = 1;
    this.lockStamp = stamp;
    try { return section(); } finally {
      this.lockDepth = 0;
      this.lockStamp = null;
      heldLocks.delete(lock);
      try { if (readFileSync(lock, "utf8") === stamp) rmSync(lock, { force: true }); } catch {}
    }
  }

  private skipped(what: string): void { console.error(`telemetry: ${what} was not recorded: another server held ${LOCK_FILE}`); }

  private arm(fn: () => void, ms: number): Timer {
    if (this.options.setTimer) return this.options.setTimer(fn, ms);
    const timer = setTimeout(fn, ms);
    timer.unref?.();
    return { clear: () => clearTimeout(timer) };
  }

  start(): void { this.schedule(START_DELAY_MS); }
  stop(): void { clearTimeout(this.timer); this.abort?.abort(); this.activeTimer?.clear(); this.activeAbort?.abort(); this.countsTimer?.clear(); this.countsAbort?.abort(); }

  active(agents: readonly VisitPane[] | Promise<readonly VisitPane[]>, visit: { surface?: TelemetrySurface | null; ingress?: TelemetryIngress | null } = {}): Promise<void> {
    const day = utcDay(this.now());
    // the counter the visit is recorded under, or null when it is not kept: while off, before the current notice, when its
    // write failed, or when another server held the lock
    const forgotten = this.locked((): number | null => {
      // a visit made while off, or before the current notice was seen, is not kept for later
      if (!this.countingUsage()) return null;
      const counter = this.saved.forgotten;
      const pruned = this.prune();
      let changed = false;
      if (!this.saved.active.some((entry) => entry.day === day)) {
        this.saved.active = readActive([...this.saved.active, { day, harnesses: [], sent: null, visited: true, usage: emptyUsage(), sent_usage: null, wire_usage: null, sent_at: null, answer_counts: {} }]);
        changed = true;
      }
      const today = this.saved.active.find((entry) => entry.day === day);
      if (today) {
        const surfaces = withKind(today.usage.surfaces, visit.surface);
        const ingress = withKind(today.usage.ingress, visit.ingress);
        if (!today.visited || surfaces.join() !== today.usage.surfaces.join() || ingress.join() !== today.usage.ingress.join()) {
          today.visited = true;
          today.usage = { ...today.usage, surfaces, ingress };
          changed = true;
        }
      }

      if (changed || pruned) {
        try { if (!this.persist()) return null; } catch (error) {
          console.error(`telemetry: the visit could not be recorded (${message(error)})`);
          return null;
        }
      }
      return counter;
    }, () => { this.skipped("a visit"); return null; });
    if (forgotten === null) {
      Promise.resolve(agents).catch(() => {});
      return Promise.resolve();
    }
    return (async () => {
      let found: readonly VisitPane[];
      try { found = await agents; } catch (error) {
        console.error(`telemetry: the panes could not be read (${message(error)})`);
        found = [];
      }
      const go = this.locked(() => {
        // turned off while the panes were read: the off dropped the visit, and what was read is not kept, even when the
        // counts are on again and a later visit recorded the day anew
        if (!this.countingUsage() || this.saved.forgotten !== forgotten) return false;
        const entry = this.saved.active.find((known) => known.day === day);
        if (entry) {
          const merged = [...new Set([...entry.harnesses, ...found.map((pane) => harnessOf(pane.agent)).filter((harness) => harness !== null)])].sort();
          const usage = { ...entry.usage, agents: withPanes(entry.usage.agents ?? {}, found) };
          if (!sameHarnesses(merged, entry.harnesses) || !sameUsage(usage, entry.usage)) {
            entry.harnesses = merged;
            entry.usage = usage;
            try { if (!this.persist()) return false; } catch (error) {
              console.error(`telemetry: the visit could not be recorded (${message(error)})`);
              return false;
            }
          }
        }
        return true;
      }, () => { this.skipped("a visit's kinds of agents"); return false; });
      if (!go) return;
      void this.flushCounts();
      return this.flushActive(true);
    })();
  }

  /**
   * Delivers every recorded day whose harnesses were not delivered yet, oldest first, no sooner
   * than NOTICE_GRACE_MS after the notice; never records a day. A failure is logged and tried
   * again at the next visit or change. Today's usage as it stands goes only with its first message or
   * from a `visit`, USAGE_RESEND_MS after it last went on the wire; any other message carries what went.
   */
  private flushActive(visit = false): Promise<void> {
    if (!this.writable) return Promise.resolve();
    const pruned = this.locked(() => {
      this.refresh();
      try { return !this.prune() || this.persist(); } catch (error) {
        console.error(`telemetry: ${this.file} could not be written (${message(error)})`);
        return false;
      }
    }, () => { this.skipped("the visit days to send"); return false; });
    if (!pruned) return Promise.resolve();
    const seen = this.saved.notice_seen_at === null ? NaN : Date.parse(this.saved.notice_seen_at);
    if (!this.saved.enabled || Number.isNaN(seen) || this.blocked()) return Promise.resolve();
    const today = utcDay(this.now());
    // the day's usage as it stands may go before it ever went, else only USAGE_RESEND_MS after it last went: with a visit
    // for today, with any flush for a day already over. Midnight is no exception: a message at 23:59:59 and another for the
    // same day at 00:00:00 would tell what happened in that second
    const usageDue = (entry: ActiveDay) => entry.sent_at === null
      || ((visit || entry.day < today) && this.now() - entry.sent_at >= USAGE_RESEND_MS);
    // what a message for the day carries: the usage as it stands when due, else what last went on the wire
    const carried = (entry: ActiveDay) => usageDue(entry) ? entry.usage : entry.wire_usage ?? entry.sent_usage ?? entry.usage;
    const owed = (entry: ActiveDay) => entry.visited && (entry.sent === null || entry.sent_usage === null
      || !sameHarnesses(entry.sent, entry.harnesses)
      || !sameUsage(entry.sent_usage, carried(entry)));
    if (!this.activeSending && !this.saved.active.some(owed)) return Promise.resolve();
    const wait = seen + (this.options.noticeGraceMs ?? NOTICE_GRACE_MS) - this.now();
    if (wait > 0) {
      this.activeTimer?.clear();
      this.activeTimer = this.arm(() => void this.flushActive(), wait);
      return Promise.resolve();
    }
    if (this.activeSending) { this.activeAgain = true; this.activeAgainVisit ||= visit; return this.activeSending; }
    const due = this.saved.active.filter(owed).map((entry) => entry.day);
    const forgotten = this.saved.forgotten;
    const abort = new AbortController();
    this.activeAbort = abort;
    this.activeSending = (async () => {
      try {
        for (const day of due) {
          if (abort.signal.aborted) return;
          const next = this.locked(() => {
            this.refresh();
            if (!this.saved.enabled || this.saved.forgotten !== forgotten) return "stop";
            const going = this.saved.active.find((known) => known.day === day);
            if (!going || !owed(going)) return "skip";
            const claim = claimSend(going);
            if (!claim) return "skip";
            const fresh = usageDue(going);
            const active = this.activeMessage({ ...going, usage: carried(going) });
            // Keep the sample even if the receiver's answer is lost; a retry within the hour carries it again.
            going.wire_usage = active.usage;
            if (fresh) going.sent_at = this.now();
            return this.persist() ? { claim, active } : "stop";
          }, () => { this.skipped("an active message about to go"); return "stop" as const; });
          if (next === "stop") return;
          if (next === "skip") continue;
          const { active, claim } = next;
          let delivered = false;
          try {
            if (offMark(this.offFile) !== this.saved.enabled_mark) return;
            const current = this.locked(() => {
              this.refresh();
              return this.saved.enabled && this.saved.forgotten === forgotten
                && this.saved.active.some((entry) => entry.day === day && entry.claim?.id === claim.id);
            }, () => false);
            // last, after the lock is let go and right before the POST: an off marked meanwhile
            if (!current || abort.signal.aborted || offMark(this.offFile) !== this.saved.enabled_mark) return;
            const response = await this.options.fetch(this.options.activeUrl ?? ACTIVE_URL, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(active),
              signal: AbortSignal.any([abort.signal, AbortSignal.timeout(SEND_TIMEOUT_MS)]),
            });
            delivered = response.ok;
            if (!delivered) throw new Error(`HTTP ${response.status}`);
          } catch (error) {
            if (!abort.signal.aborted) console.error(`telemetry: the active message was not delivered (${message(error)})`);
            return;
          } finally {
            this.locked(() => {
              this.refresh();
              if (this.saved.forgotten !== forgotten) return;
              const entry = this.saved.active.find((known) => known.day === day);
              if (entry?.claim?.id !== claim.id) return;
              if (delivered) {
                entry.sent = active.harnesses;
                entry.sent_usage = active.usage;
              }
              delete entry.claim;
              this.persist();
            }, () => this.skipped("an active message's delivery"));
          }
        }
      } catch (error) {
        console.error(`telemetry: ${this.file} could not be written (${message(error)})`);
      }
    })().finally(() => {
      // after the assignment, even when the first write failed before any await: else the failed
      // run would stand as in flight and hold every later delivery behind it
      this.activeSending = null;
      this.activeAbort = undefined;
      if (this.activeAgain) {
        const again = this.activeAgainVisit;
        this.activeAgain = false;
        this.activeAgainVisit = false;
        void this.flushActive(again);
      }
    });
    return this.activeSending;
  }

  /**
   * Sends the owed event once, no sooner than NOTICE_GRACE_MS after the notice was shown; a
   * failure is logged and tried again at the next start or change.
   */
  report(): Promise<void> {
    if (this.sending) return this.sending;
    if (!this.writable) return Promise.resolve();
    this.refresh();
    const event = this.pending();
    const seen = this.saved.notice_seen_at === null ? NaN : Date.parse(this.saved.notice_seen_at);
    if (!event || !this.saved.enabled || Number.isNaN(seen) || this.blocked()) return Promise.resolve();
    const wait = seen + (this.options.noticeGraceMs ?? NOTICE_GRACE_MS) - this.now();
    if (wait > 0) { this.schedule(wait); return Promise.resolve(); }
    const forgotten = this.saved.forgotten;
    const abort = new AbortController();
    this.abort = abort;
    this.sending = (async () => {
      try {
        // turned off by another server on the same state directory since the read above
        if (offMark(this.offFile) !== this.saved.enabled_mark) return;
        const current = this.locked(() => {
          this.refresh();
          return this.saved.enabled && this.saved.forgotten === forgotten;
        }, () => false);
        // right before it goes, after the lock is let go: turned off by another server on the same state directory meanwhile
        if (!current || abort.signal.aborted || offMark(this.offFile) !== this.saved.enabled_mark) return;
        const response = await this.options.fetch(this.options.url ?? TELEMETRY_URL, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(event),
          signal: AbortSignal.any([abort.signal, AbortSignal.timeout(SEND_TIMEOUT_MS)]),
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        this.locked(() => {
          this.refresh();
          // an off since it was built: the event is from before it, and what it reported is not taken as the boundary
          if (this.saved.forgotten !== forgotten) return;
          this.saved.reported_version = event.version;
          this.saved.replaced_forgotten = false;
          this.persist();
        }, () => this.skipped(`the ${event.event} event's delivery`));
      } catch (error) {
        if (!abort.signal.aborted) console.error(`telemetry: the ${event.event} event was not delivered (${error instanceof Error ? error.message : String(error)})`);
      }
    })().finally(() => {
      // after the assignment, even when the off check returned before any await: else the finished send would stand as
      // in flight and the owed event would wait for a restart
      this.sending = null;
      this.abort = undefined;
    });
    return this.sending;
  }
}

export async function handleTelemetryRequest(request: Request, telemetry?: Telemetry): Promise<Response> {
  const reply = (body: unknown, status = 200) => jsonResponse(body, status, { "cache-control": "no-store" });
  if (!telemetry) return reply({ error: { code: "not_found", message: "This server sends no telemetry" } }, 404);
  if (request.method === "GET") return reply(telemetry.status());
  if (request.method !== "POST") return reply({ error: { code: "method_not_allowed", message: "Use GET or POST /api/telemetry" } }, 405);
  if (!updateRequestAllowed(request)) return reply({ error: { code: "invalid_telemetry_request", message: "Use the controls from this app." } }, 403);
  // a body announced over the limit is refused unread; one that lies about its length is measured. Nothing is counted
  const tooLarge = () => reply({ error: { code: "too_large", message: "The telemetry change is too large" } }, 413);
  const announced = Number(request.headers.get("content-length"));
  if (Number.isFinite(announced) && announced > MAX_CHANGE_BYTES) return tooLarge();
  const text = await request.text();
  if (Buffer.byteLength(text) > MAX_CHANGE_BYTES) return tooLarge();
  let body: unknown;
  try { body = JSON.parse(text); } catch { return badRequest("invalid_json", "The body is not JSON"); }
  if (!isJsonObject(body)) return badRequest("invalid_body", "Send an object");
  const change = telemetryChange(body);
  // a counts change is refused as any unknown key was before, while this build counts nothing
  if (!change || (change.counts !== undefined && !telemetry.takesCounts())) return badRequest("invalid_body", "Send enabled, settings, or the current notice acknowledgement");
  try { return reply(telemetry.change(change)); }
  catch (error) { return errorResponse(error); }
}
