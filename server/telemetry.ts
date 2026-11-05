/**
 * Anonymous install and update counts (shared/telemetry.ts). One event when an install first
 * runs, one when it runs a new version; nothing in between. Plus one active message per UTC day
 * a browser visits, naming the kinds of coding agents running then and the day's usage (the
 * kinds of screen and ways in of its visits, and its prompt answers and pane alerts counted by
 * `tally`, both only once the current notice was shown); a later visit that day resends it when a
 * new kind of agent appeared, or the usage changed and USAGE_RESEND_MS passed since it last went
 * (an earlier resend carries the usage already sent). No event or message goes out before the app has
 * shown its notice once, while the switch is off, or where the environment says not to.
 * Events include the latest browser's schema-validated settings snapshot; free-form strings and
 * account identifiers are summarized or omitted by the browser's projection.
 * Only the real entrypoint (index.ts) makes one of these, so tests and a remote PC's bridge
 * send nothing.
 */
import { randomUUID } from "node:crypto";
import { accessSync, constants, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ACTIVE_LATE_DAYS, emptyUsage, harnessOf, NOTICE_VERSION, sameUsage, TELEMETRY_COUNT_MAX, telemetryHarnesses, telemetrySettings, telemetrySurface, telemetryUsage, type InstallMethod, type TelemetryActive, type TelemetryChange, type TelemetryEvent, type TelemetryHarness, type TelemetryIngress, type TelemetryRuntime, type TelemetrySettings, type TelemetryStatus, type TelemetrySurface, type TelemetryUsage, type TelemetryUsageCount } from "../shared/telemetry.ts";
import { badRequest, errorResponse, isJsonObject, jsonResponse } from "./http.ts";
import { updateRequestAllowed } from "./update-api.ts";

export const TELEMETRY_URL = "https://herdr-web-ui-telemetry.devswha.workers.dev/v1/events";
export const ACTIVE_URL = "https://herdr-web-ui-telemetry.devswha.workers.dev/v1/active";
const FILE = "telemetry.json";
/**
 * The switch turned off, as a file of its own beside FILE that only the switch writes or removes. Every other
 * write saves the whole of FILE as it was read, so a server on the same state directory that read the switch on
 * a moment before it was turned off would write it back on; none of them touches this file, so off holds.
 */
const OFF_FILE = "telemetry-off";
const SEND_TIMEOUT_MS = 10_000;
/** after a start, long enough for the supervisor to have told what the update replaced */
const START_DELAY_MS = 15_000;
/** after the notice was shown, time to read it and press Turn off before the first event goes */
export const NOTICE_GRACE_MS = 10 * 60_000;
const TELEMETRY_CHANGE_KEYS = new Set(["enabled", "notice_seen", "notice_version", "settings", "alert_opened"]);
const DAY = /^\d{4}-\d{2}-\d{2}$/;
/** today's usage (its kinds of screen and ways in as much as its counts) changes on the wire at most this often, and only with a
 * visit: a resend for a new kind of agent in between carries the usage already sent, so no message tells when a count changed */
export const USAGE_RESEND_MS = 60 * 60_000;
/** a change is a few small fields and at most one settings snapshot, which the receiver takes only under 8 KiB with the rest of its event */
const MAX_CHANGE_BYTES = 16 * 1024;

interface ActiveDay {
  /** the UTC date of the browser visit */
  day: string;
  /** every harness seen on that day's visits */
  harnesses: TelemetryHarness[];
  /** the set last delivered for that day; null before one was */
  sent: TelemetryHarness[] | null;
  /** a browser opened the app that day. A count made on a day without one (an alert at night) waits
   * for a visit that day and is never sent alone: the active row is a day the app was used */
  visited: boolean;
  /** the day's use so far */
  usage: TelemetryUsage;
  /** the usage last delivered for that day (the receiver answered); null before one was */
  sent_usage: TelemetryUsage | null;
  /** the usage last put on the wire for that day, answered or not: a retry within the hour carries it again, since
   * a receiver may have read a message whose answer was lost; null before one went */
  wire_usage: TelemetryUsage | null;
  /** when the day's usage as it stood last went on the wire, in ms, answered or not; null before it did */
  sent_at: number | null;
}

/** `list` with `item` added, sorted, without repeats */
function withKind<T extends string>(list: readonly T[], item: T | null | undefined): T[] {
  return item ? [...new Set([...list, item])].sort() : [...list];
}

interface Timer { clear(): void }

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
    // a file from before usage was counted: its days were visits, and what was sent for them is settled
    const usage = telemetryUsage(item["usage"]) ?? emptyUsage();
    const sentUsage = item["sent_usage"] === undefined ? (sent === null ? null : usage) : telemetryUsage(item["sent_usage"]);
    const wireUsage = item["wire_usage"] === undefined ? sentUsage : telemetryUsage(item["wire_usage"]);
    const sentAt = typeof item["sent_at"] === "number" && Number.isFinite(item["sent_at"]) ? item["sent_at"] : null;
    days.push({ day: item["day"], harnesses, sent, visited: item["visited"] !== false, usage, sent_usage: sentUsage, wire_usage: wireUsage, sent_at: sentAt });
  }
  return days.sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
}

/**
 * The days with no usage counted: a day that only had counts (no visit) goes, and a delivered day keeps
 * its delivery without the usage, so dropping it sends nothing.
 */
function withoutUsage(days: ActiveDay[]): ActiveDay[] {
  return days.filter((entry) => entry.visited).map((entry) => ({ ...entry, usage: emptyUsage(), sent_usage: entry.sent_usage === null ? null : emptyUsage(), wire_usage: entry.wire_usage === null ? null : emptyUsage() }));
}

interface Saved {
  install_id: string;
  enabled: boolean;
  /** when the current notice (notice_version) was shown; null before, and for a file that saw only an older notice */
  notice_seen_at: string | null;
  notice_version: number;
  /** the version the last delivered event was for; null before the first one */
  reported_version: string | null;
  /** the last browser's complete, allowlisted settings snapshot; null before one has */
  settings: TelemetrySettings | null;
  /** the recorded visit days, ascending, no older than ACTIVE_LATE_DAYS before today */
  active: ActiveDay[];
  /** the usage in `active` was counted only after the current notice. A file without it (an older build's) may hold usage
   * counted before the notice, so its usage is dropped when read; so is any usage while the current notice is unseen */
  usage_after_notice: true;
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
      }
    }
    if (clean.notice_seen === true && clean.notice_version !== NOTICE_VERSION) return null;
    return clean;
  } catch {
    return null;
  }
}

/**
 * Whether OFF_FILE marks the counts off. It fails closed: only a name that is not there, in a state directory this
 * process can read, counts as no mark. Anything at the name (a dangling link too) or any failure to tell is off.
 */
function offMarked(offFile: string): boolean {
  try {
    lstatSync(offFile);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") return true;
  }
  try {
    accessSync(dirname(offFile), constants.R_OK | constants.X_OK);
    return false;
  } catch { return true; }
}

function readSaved(file: string, offFile: string): Saved | null {
  try {
    const value: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (!isJsonObject(value) || typeof value["install_id"] !== "string" || value["install_id"] === "") return null;
    // a switch an older build turned off is copied into OFF_FILE whenever it is read, so no late write of FILE can turn it
    // on; a read that cannot write it now still reads off, and the next read tries again
    if (value["enabled"] === false && !offMarked(offFile)) {
      try { writeFileSync(offFile, "", { mode: 0o600 }); } catch { /* read-only for now: still off, marked at a later read */ }
    }
    // a notice from before it said what is sent now does not count: it is shown again first
    const noticeSeenAt = value["notice_version"] === NOTICE_VERSION && typeof value["notice_seen_at"] === "string" ? value["notice_seen_at"] : null;
    const active = readActive(value["active"]);
    return {
      install_id: value["install_id"],
      enabled: value["enabled"] !== false && !offMarked(offFile),
      notice_seen_at: noticeSeenAt,
      notice_version: NOTICE_VERSION,
      reported_version: typeof value["reported_version"] === "string" ? value["reported_version"] : null,
      settings: telemetrySettings(value["settings"]),
      active: noticeSeenAt !== null && value["usage_after_notice"] === true ? active : withoutUsage(active),
      usage_after_notice: true,
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
  /** the flush asked for while one ran came from a visit */
  private activeAgainVisit = false;
  private activeAbort?: AbortController;
  private activeTimer?: Timer;
  private readonly file: string;
  private readonly offFile: string;
  /** false when the state file could not be written: then nothing is sent (it could not be remembered) */
  private writable = true;

  constructor(private readonly options: {
    stateDir: string;
    version: string;
    env: Env;
    fetch: typeof fetch;
    url?: string;
    activeUrl?: string;
    platform?: string;
    arch?: string;
    /** the version the running release replaced, as the supervisor told it; null when none did */
    previousVersion?: () => string | null;
    /** the terminal runtime this server serves; herdr when unset */
    runtime?: TelemetryRuntime;
    /** tests move the clock; the notice's grace is measured with it */
    now?: () => number;
    noticeGraceMs?: number;
    /** arms the grace-period retry of the active message; tests capture the callback */
    setTimer?: (fn: () => void, ms: number) => Timer;
  }) {
    this.file = join(options.stateDir, FILE);
    this.offFile = join(options.stateDir, OFF_FILE);
    // a first run's state directory is made before the mark is looked for: one that is not there reads off (offMarked)
    try { mkdirSync(options.stateDir, { recursive: true, mode: 0o700 }); } catch { /* not made: offMarked reads off */ }
    const saved = readSaved(this.file, this.offFile);
    this.saved = saved ?? { install_id: randomUUID(), enabled: !offMarked(this.offFile), notice_seen_at: null, notice_version: NOTICE_VERSION, reported_version: null, settings: null, active: [], usage_after_notice: true };
    if (!saved) {
      try { this.persist(); } catch (error) {
        // the app still starts; telemetry just stays silent
        this.writable = false;
        console.error(`telemetry: ${this.file} could not be written, so nothing will be sent (${error instanceof Error ? error.message : String(error)})`);
      }
    }
  }

  private now(): number { return this.options.now?.() ?? Date.now(); }

  /** another server on the same state directory may have changed the switch: its file wins */
  private refresh(): void {
    const latest = readSaved(this.file, this.offFile);
    if (latest) this.saved = latest;
    // the file could not be read: what is known of it stays, but an off, or no way to tell, wins
    else if (offMarked(this.offFile)) this.saved.enabled = false;
  }

  private markOff(): void {
    mkdirSync(this.options.stateDir, { recursive: true, mode: 0o700 });
    writeFileSync(this.offFile, "", { mode: 0o600 });
  }

  private persist(): void {
    mkdirSync(this.options.stateDir, { recursive: true, mode: 0o700 });
    const temp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(temp, JSON.stringify(this.saved), { mode: 0o600 });
    renameSync(temp, this.file);
    this.writable = true;
  }

  private schedule(ms: number): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.report(), ms);
    this.timer.unref?.();
  }

  private blocked(): boolean { return telemetryBlocked(this.options.env); }

  /** drops visit days a late delivery may no longer name; true when it dropped any */
  private prune(): boolean {
    const today = new Date(this.now());
    const cutoff = utcDay(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - ACTIVE_LATE_DAYS));
    const kept = this.saved.active.filter((entry) => entry.day >= cutoff);
    if (kept.length === this.saved.active.length) return false;
    this.saved.active = kept;
    return true;
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

  /** the event this version still owes, whether or not it may be sent now */
  private pending(): TelemetryEvent | null {
    const { version } = this.options;
    const reported = this.saved.reported_version;
    if (reported === version) return null;
    const replaced = reported ?? this.options.previousVersion?.() ?? null;
    const update = replaced !== null && replaced !== version;
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
    this.refresh();
    return {
      enabled: this.saved.enabled,
      blocked_by_env: this.blocked(),
      notice_seen: this.saved.notice_seen_at !== null,
      next: this.pending(),
      active: this.activeMessage(this.saved.active.find((entry) => entry.day === utcDay(this.now()))),
    };
  }

  change(patch: TelemetryChange): TelemetryStatus {
    const clean = telemetryChange(patch);
    if (!clean) throw new TypeError("Invalid telemetry change");
    // turned off while an event is on its way: stop it before anything is read or written (a read may write the mark), and
    // even if OFF_FILE cannot be written
    if (clean.enabled === false) { this.abort?.abort(); this.activeAbort?.abort(); }
    this.refresh();
    // off is marked before FILE is written, whatever another server writes to FILE meanwhile
    if (clean.enabled === false) this.markOff();
    if (clean.enabled !== undefined) this.saved.enabled = clean.enabled;
    // kept for the next install/update event; telling it sends nothing by itself
    if (clean.settings !== undefined) this.saved.settings = clean.settings;
    if (clean.notice_seen && this.saved.notice_seen_at === null) this.saved.notice_seen_at = new Date(this.now()).toISOString();
    this.persist();
    // and again after: an on from another server between the two writes cannot leave this off without its mark
    if (clean.enabled === false) this.markOff();
    // on removes the mark only once FILE says on, so no read in between finds FILE off and no mark (readSaved would mark it)
    if (clean.enabled === true) rmSync(this.offFile, { force: true });
    if (clean.alert_opened) {
      this.tally("alerts_opened");
      // a tap alone sends nothing: the day's next visit carries it, so no message tells when it was
      if (Object.keys(clean).length === 1) return this.status();
    }
    void this.report();
    // visits already recorded but held back by the notice, the switch or a failure
    void this.flushActive();
    return this.status();
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
  tally(kind: TelemetryUsageCount): void {
    if (!this.countingUsage()) return;
    const day = utcDay(this.now());
    this.prune();
    if (!this.saved.active.some((entry) => entry.day === day)) {
      this.saved.active = readActive([...this.saved.active, { day, harnesses: [], sent: null, visited: false, usage: emptyUsage(), sent_usage: null, wire_usage: null, sent_at: null }]);
    }
    const entry = this.saved.active.find((known) => known.day === day);
    if (!entry || entry.usage[kind] >= TELEMETRY_COUNT_MAX) return;
    entry.usage = { ...entry.usage, [kind]: entry.usage[kind] + 1 };
    try { this.persist(); } catch (error) {
      console.error(`telemetry: the ${kind} count could not be recorded (${message(error)})`);
    }
  }

  start(): void { this.schedule(START_DELAY_MS); }
  stop(): void { clearTimeout(this.timer); this.abort?.abort(); this.activeTimer?.clear(); this.activeAbort?.abort(); }

  /**
   * A browser visit: records today (the day of this call, even when the agents arrive after
   * midnight) with the harness kinds of the given pane agents, and the kind of screen and the way
   * in the visit came by, then delivers what is owed. A pane read that fails still counts the
   * visit with the kinds known so far.
   */
  active(agents: readonly (string | null | undefined)[] | Promise<readonly (string | null | undefined)[]>, visit: { surface?: TelemetrySurface | null; ingress?: TelemetryIngress | null } = {}): Promise<void> {
    // a visit made while off is not kept for when the switch is turned on again
    if (!this.counting()) {
      Promise.resolve(agents).catch(() => {});
      return Promise.resolve();
    }
    const day = utcDay(this.now());
    const pruned = this.prune();
    let changed = false;
    if (!this.saved.active.some((entry) => entry.day === day)) {
      this.saved.active = readActive([...this.saved.active, { day, harnesses: [], sent: null, visited: true, usage: emptyUsage(), sent_usage: null, wire_usage: null, sent_at: null }]);
      changed = true;
    }
    const today = this.saved.active.find((entry) => entry.day === day);
    if (today) {
      // before the current notice a visit is a day of use, nothing more (countingUsage)
      const usageCounted = this.saved.notice_seen_at !== null;
      const surfaces = withKind(today.usage.surfaces, usageCounted ? visit.surface : null);
      const ingress = withKind(today.usage.ingress, usageCounted ? visit.ingress : null);
      if (!today.visited || surfaces.join() !== today.usage.surfaces.join() || ingress.join() !== today.usage.ingress.join()) {
        today.visited = true;
        today.usage = { ...today.usage, surfaces, ingress };
        changed = true;
      }
    }
    if (changed || pruned) {
      try { this.persist(); } catch (error) {
        console.error(`telemetry: the visit could not be recorded (${message(error)})`);
        return Promise.resolve();
      }
    }
    return (async () => {
      let found: readonly (string | null | undefined)[];
      try { found = await agents; } catch (error) {
        console.error(`telemetry: the panes could not be read (${message(error)})`);
        found = [];
      }
      // turned off while the panes were read: the visit stays recorded, what was read is not kept
      if (!this.counting()) return;
      const entry = this.saved.active.find((known) => known.day === day);
      if (entry) {
        const merged = [...new Set([...entry.harnesses, ...found.map(harnessOf).filter((harness) => harness !== null)])].sort();
        if (!sameHarnesses(merged, entry.harnesses)) {
          entry.harnesses = merged;
          try { this.persist(); } catch (error) {
            console.error(`telemetry: the visit could not be recorded (${message(error)})`);
            return;
          }
        }
      }
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
    this.refresh();
    if (this.prune()) {
      try { this.persist(); } catch (error) {
        console.error(`telemetry: ${this.file} could not be written (${message(error)})`);
        return Promise.resolve();
      }
    }
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
      // a new kind of agent goes at once, as it did before usage
      || !sameHarnesses(entry.sent, entry.harnesses)
      // usage not yet answered for: changed and due, or the same again after a lost answer
      || !sameUsage(entry.sent_usage, carried(entry)));
    if (!this.activeSending && !this.saved.active.some(owed)) return Promise.resolve();
    const wait = seen + (this.options.noticeGraceMs ?? NOTICE_GRACE_MS) - this.now();
    if (wait > 0) {
      this.activeTimer?.clear();
      const setTimer = this.options.setTimer ?? ((fn: () => void, ms: number): Timer => {
        const timer = setTimeout(fn, ms);
        timer.unref?.();
        return { clear: () => clearTimeout(timer) };
      });
      this.activeTimer = setTimer(() => void this.flushActive(), wait);
      return Promise.resolve();
    }
    if (this.activeSending) { this.activeAgain = true; this.activeAgainVisit ||= visit; return this.activeSending; }
    const due = this.saved.active.filter(owed).map((entry) => ({ active: this.activeMessage({ ...entry, usage: carried(entry) }), fresh: usageDue(entry) }));
    const abort = new AbortController();
    this.activeAbort = abort;
    this.activeSending = (async () => {
      try {
        for (const { active, fresh } of due) {
          if (abort.signal.aborted) return;
          // kept before it goes: a receiver may read it even when its answer never comes back, so the hour counts from here
          const going = this.saved.active.find((known) => known.day === active.day);
          if (going) {
            going.wire_usage = active.usage;
            if (fresh) going.sent_at = this.now();
            this.persist();
          }
          // last, right before it goes: turned off here or by another server on the same state directory meanwhile
          if (offMarked(this.offFile)) return;
          try {
            const response = await this.options.fetch(this.options.activeUrl ?? ACTIVE_URL, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(active),
              signal: AbortSignal.any([abort.signal, AbortSignal.timeout(SEND_TIMEOUT_MS)]),
            });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
          } catch (error) {
            if (!abort.signal.aborted) console.error(`telemetry: the active message was not delivered (${message(error)})`);
            return;
          }
          this.refresh();
          const entry = this.saved.active.find((known) => known.day === active.day);
          if (entry) {
            entry.sent = active.harnesses;
            entry.sent_usage = active.usage;
            this.persist();
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
    const abort = new AbortController();
    this.abort = abort;
    this.sending = (async () => {
      try {
        // right before it goes: turned off by another server on the same state directory since the read above
        if (offMarked(this.offFile)) return;
        const response = await this.options.fetch(this.options.url ?? TELEMETRY_URL, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(event),
          signal: AbortSignal.any([abort.signal, AbortSignal.timeout(SEND_TIMEOUT_MS)]),
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        this.refresh();
        this.saved.reported_version = event.version;
        this.persist();
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
  if (!change) return badRequest("invalid_body", "Send enabled, settings, or the current notice acknowledgement");
  try { return reply(telemetry.change(change)); }
  catch (error) { return errorResponse(error); }
}
