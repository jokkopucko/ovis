import { basename } from "node:path";
import { closeSync, fstatSync, lstatSync, openSync, readSync } from "node:fs";
import { commandTerminals } from "./claude-subagents.ts";
import { TranscriptBusyError, transcriptReader, type TranscriptFile } from "./transcript-reader.ts";

/** Terminal metadata only: historical reads never replay prompt/turn evidence. */
export interface CommandEnd { id: string; at: number; status: "completed" | "failed" | "cancelled"; /** the Bash call the notice names (`<tool-use-id>`), when it names one */ call: string | null }
export interface HistoryVersion { id: string; size: number; mtimeMs: number }
/**
 * How the commands told of in a transcript's first `through` bytes ended. `complete`: nothing more
 * is to come below the limit asked for: every byte up to it was read, and found unchanged by one
 * check of them all since (or the read gave up after failing again and again). An end is told only
 * when the line it came from is as it was read in the transcript as it is now: a check of every byte
 * read at this very version says so, or else that line read again (after a rewrite that also grew
 * the transcript, an end no longer written there is not told, and its command stays running). A record too large
 * to read or not JSON is passed over: it proves nothing, and a command it may have ended stays as
 * the window alone tells it.
 */
export interface HistoryEvidence { version: HistoryVersion; through: number; complete: boolean; ends: HistoryEnd[] }
/** An end, and the line it was read from: where it starts and ends (past its newline) in the transcript, and a digest of it. */
export type HistoryEnd = CommandEnd & { from: number; to: number; digest: bigint };

interface Entry {
  path: string;
  /** the session the transcript is (its name): a row naming another session ends none of its commands */
  session: string;
  /** the transcript as last seen */
  version: HistoryVersion;
  limit: number;
  /** read up to here, in a record too large to read (`skipping`), or waiting for the record there to be written whole (`cutAt`: the size it was cut at) */
  offset: number;
  skipping: boolean;
  cutAt: number | null;
  /** a digest of each run of bytes read, in order: each ends at `end` and starts where the one before ended */
  spans: { end: number; digest: bigint }[];
  /** every span was found unchanged at this version, up to `checkedThrough`, by reading begun at `checkedFrom` (`checkedTick` on the monotonic clock) */
  checked: HistoryVersion | null;
  checkedThrough: number;
  checkedFrom: number;
  checkedTick: number;
  /** a check of every span under way: the next span to check, at the version and times it began at */
  check: { next: number; version: HistoryVersion; at: number; tick: number } | null;
  /** when the last check began, how many began, and the most a waiter wants begun (one begun after it came) */
  checkedAt: number;
  checks: number;
  wanted: number;
  waiters: number;
  ends: HistoryEnd[];
  queued: boolean;
  listeners: Set<() => void>;
  failures: number;
  retryAt: number;
  timer: ReturnType<typeof setTimeout> | null;
  /** turns its slices took inside held leases: a slice that takes them is reading, not stuck */
  turns: number;
  /** times it started over (restart): a request can start it over while a slice waits for the disk */
  restarts: number;
}

const MAX_SESSIONS = 16;
const MAX_ENDS = 5000;
/** A read takes at most this much of a file at once, so a record longer than it is passed over. */
const CHUNK = 1024 * 1024;
/** A session lets the next one have its turn after about this much work (the event loop gets one at every read too). */
const SLICE_MS = 4;
/**
 * A read that has not answered in this long is given up for now (TranscriptBusyError) and tried
 * again a second later. A busy reader is no failure of the transcript, so one whose reads keep
 * running out of time is tried every second for as long as it is watched, with no longer backoff.
 */
const READ_MS = 10_000;
/** A transcript that changed after a check is checked again this long after, at the soonest, unless a request waits for it. */
const CHECK_INTERVAL_MS = 5000;
/**
 * A same-size rewrite within one filesystem timestamp tick keeps the version (on Windows it often
 * does: two writes a millisecond apart share mtime and ctime). A check vouches for a version it saw
 * without reading again only when it began at least this long after that version's mtime.
 */
const RACY_MS = 3000;
/** A read that fails is tried again after a second, then twice as long each time up to this, and given up after MAX_FAILURES in a row. */
const RETRY_MAX_MS = 30_000;
const MAX_FAILURES = 5;
/** Only a line holding one of these can end a command (commandTerminals): every other line is passed over unread. */
const NEWLINE = Buffer.from("\n");
const MARKERS = ["<task-notification>", '"task_id"', '"shell_id"'].map((marker) => Buffer.from(marker));

const entries = new Map<string, Entry>();
const queue: Entry[] = [];
let draining = false;
/** Slices under way, at most the reader's capacity, and the transcripts they read: one slice a transcript. */
let slices = 0;
const running = new Set<string>();
/** Called once no drain and no slice runs (commandHistorySettled). */
const idle = new Set<() => void>();
/** Moved on by every reset: a request waiting from before it gives up. */
let generation = 0;
/** Aborted by every reset: the reads of slices begun before it give up, and no drain waits for them. */
let cancel = new AbortController();
let holders = 0;
let buffer: Buffer | null = null;

export function historyVersion(path: string): HistoryVersion | null {
  try {
    const stat = lstatSync(path);
    return stat.isFile() ? { id: `${stat.dev}:${stat.ino}`, size: stat.size, mtimeMs: stat.mtimeMs } : null;
  } catch { return null; }
}
export function sameHistory(older: HistoryVersion, newer: HistoryVersion): boolean {
  return older.id === newer.id && newer.size >= older.size && (newer.size !== older.size || newer.mtimeMs === older.mtimeMs);
}
const sameVersion = (a: HistoryVersion, b: HistoryVersion): boolean => a.id === b.id && a.size === b.size && a.mtimeMs === b.mtimeMs;
/** What was checked at this version is still so: the version is unchanged, and was already old enough when the reading began that a rewrite since would show in it. */
const checkedNow = (entry: Entry): boolean => entry.checked !== null && sameVersion(entry.checked, entry.version)
  && entry.checkedFrom - entry.checked.mtimeMs >= RACY_MS && Date.now() >= entry.checkedFrom;

/**
 * What the history read of `path` knows so far, read on (when `schedule`) on the main thread a slice
 * at a time. `needed`: the ids whose ends are wanted (all when left out); only theirs are told.
 */
export function commandHistory(path: string, limit: number, schedule = true, needed?: ReadonlySet<string>, since = Infinity): HistoryEvidence | null {
  const version = historyVersion(path);
  if (version === null) return null;
  let entry = entries.get(path);
  if (entry && !sameHistory(entry.version, version)) { discard(entry); entry = undefined; }
  if (entry) entries.delete(path);
  else {
    if (entries.size >= MAX_SESSIONS) {
      // the least recently used one nobody watches or waits for; none such: this one is not read
      const old = [...entries.values()].find((value) => value.listeners.size === 0);
      if (!old) return null;
      discard(old);
    }
    entry = {
      path, session: basename(path, ".jsonl"), version, limit, offset: 0, skipping: false, cutAt: null, spans: [], checked: null, checkedThrough: 0, checkedFrom: -Infinity, checkedTick: -Infinity, check: null,
      checkedAt: -Infinity, checks: 0, wanted: 0, waiters: 0, ends: [], queued: false, listeners: new Set(), failures: 0, retryAt: 0, timer: null, turns: 0, restarts: 0,
    };
  }
  entries.set(path, entry);
  entry.version = version;
  entry.limit = Math.max(entry.limit, limit);
  const found = evidence(entry, limit, needed, since);
  if (schedule) enqueue(entry);
  return found;
}

/** `since`: when a request began (performance.now()); a check begun after it vouches for what it read, to that request. */
function evidence(entry: Entry, limit: number, needed: ReadonlySet<string> | undefined, since: number): HistoryEvidence {
  const wanted = needed === undefined ? entry.ends : entry.ends.filter((end) => needed.has(end.id));
  const checked = entry.checked !== null && entry.checkedThrough >= entry.offset;
  // a rewrite that also grew the transcript passes sameHistory, and a same-size one within a
  // timestamp tick keeps the version: only a check of the bytes as they are now vouches for an end,
  // of them all at this version (once its tick was past, or for the request it was begun after) or
  // of the end's own line
  const vouched = checked && sameVersion(entry.checked!, entry.version) && (checkedNow(entry) || entry.checkedTick > since);
  const told = vouched ? wanted : vouchLines(entry.path, entry.version.id, wanted);
  if (told === "rewritten") {
    // a line read is no longer as it was: everything learnt goes, and the read starts again
    restart(entry);
    notify(entry);
    return { version: entry.version, through: 0, complete: false, ends: [] };
  }
  const complete = entry.failures >= MAX_FAILURES || (entry.offset >= limit && checked && told !== null && told.length === wanted.length);
  return { version: entry.version, through: entry.offset, complete, ends: told ?? [] };
}

/** The most bytes of lines one call reads again (vouchedEnds): past it, what they told is unknown. */
const VOUCH_BYTES = 4 * 1024 * 1024;

/** Lines this close together are read at once (vouchLines). */
const VOUCH_GAP = 64 * 1024;

/**
 * `ends` when every line they came from (newline and all) reads as it did in the transcript `id` as
 * it is now, and nothing changed it while they were read; else null: a command they end may still run.
 */
export function vouchedEnds(path: string, id: string, ends: HistoryEnd[]): HistoryEnd[] | null {
  const told = vouchLines(path, id, ends);
  return Array.isArray(told) && told.length === ends.length ? told : null;
}

/**
 * The `ends` whose lines read as they did in the transcript `id` as it is now, the newest lines
 * first, each run of lines close together in one read, as far as VOUCH_BYTES of reading goes. "rewritten": a line
 * reads otherwise, and nothing changed the transcript while it was read. null: it changed meanwhile,
 * or could not be read.
 */
function vouchLines(path: string, id: string, ends: HistoryEnd[]): HistoryEnd[] | "rewritten" | null {
  if (ends.length === 0) return ends;
  const byLine = new Map<number, HistoryEnd>();
  for (const end of ends) byLine.set(end.from, end);
  // a command still unresolved more likely ended late than early; the bytes between lines read at once count too
  const newest = [...byLine.values()].sort((a, b) => b.from - a.from);
  const runs: { from: number; to: number; lines: HistoryEnd[] }[] = [];
  let kept = 0;
  for (let bytes = 0; kept < newest.length; kept++) {
    const line = newest[kept]!;
    const run = runs.at(-1);
    const joins = run !== undefined && run.from - line.to <= VOUCH_GAP && run.to - line.from <= CHUNK;
    const cost = joins ? run.from - line.from : line.to - line.from;
    if (bytes + cost > VOUCH_BYTES) break;
    bytes += cost;
    if (joins) { run.from = line.from; run.lines.push(line); } else runs.push({ from: line.from, to: line.to, lines: [line] });
  }
  if (kept === 0) return [];
  let fd: number | null = null;
  try {
    fd = openSync(path, "r");
    const before = fstatSync(fd);
    if (`${before.dev}:${before.ino}` !== id) return null;
    buffer ??= Buffer.allocUnsafe(CHUNK);
    let rewritten = false;
    for (const run of runs) {
      const got = readSync(fd, buffer, 0, run.to - run.from, run.from);
      for (const line of run.lines) {
        rewritten = line.to - run.from > got || BigInt(Bun.hash.xxHash3(buffer.subarray(line.from - run.from, line.to - run.from))) !== line.digest;
        if (rewritten) break;
      }
      if (rewritten) break;
    }
    // written to while it read, or replaced: what it read may be gone already
    const after = fstatSync(fd);
    const now = historyVersion(path);
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || now === null || now.id !== id || now.size !== before.size || now.mtimeMs !== before.mtimeMs) return null;
    if (rewritten) return "rewritten";
    const read = new Set(runs.flatMap((run) => run.lines.map((line) => line.from)));
    return kept === newest.length ? ends : ends.filter((end) => read.has(end.from));
  } catch { return null; } finally { if (fd !== null) closeSync(fd); }
}

/** Calls `changed` when the read of `path` learns something, starts over, ends or stops; null when `path` has no read. */
export function watchCommandHistory(path: string, changed: () => void): (() => void) | null {
  const entry = entries.get(path);
  if (!entry) return null;
  entry.listeners.add(changed);
  // work held back while nobody watched (a recheck once the version's tick is past) is timed now
  enqueue(entry);
  return () => unlisten(entry, changed);
}

function unlisten(entry: Entry, listener: () => void): void {
  entry.listeners.delete(listener);
  if (entry.listeners.size > 0) return;
  // nobody wants it read on: it waits for the next call
  if (entry.queued) { queue.splice(queue.indexOf(entry), 1); entry.queued = false; }
  if (entry.timer !== null) { clearTimeout(entry.timer); entry.timer = null; }
}

/**
 * The history of `path` read through `limit` and checked, as far as it gets in `ms`. It answers as
 * soon as the read stops: it is done, it waits for a record to be written whole, or it failed. A
 * transcript replaced meanwhile is read anew within the same time.
 */
export async function waitCommandHistory(path: string, limit: number, ms = 10_000, signal?: AbortSignal): Promise<HistoryEvidence | null> {
  const deadline = Date.now() + ms;
  const since = performance.now();
  const epoch = generation;
  for (;;) {
    if (signal?.aborted || Date.now() >= deadline) return commandHistory(path, limit, false, undefined, since);
    const found = commandHistory(path, limit, false, undefined, since);
    const entry = entries.get(path);
    if (found === null || entry === undefined) return found;
    // a check begun before this request may have read the bytes before a rewrite: it waits for one begun after
    entry.wanted = entry.checks + 1;
    entry.waiters++;
    enqueue(entry);
    const again = !entry.queued ? false : await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => finish(false), Math.max(0, deadline - Date.now()));
      const abort = () => finish(false);
      const changed = () => {
        if (generation !== epoch) finish(false);
        else if (entries.get(path) !== entry) finish(true);
        else if (!entry.queued) finish(false);
      };
      function finish(replaced: boolean) {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        unlisten(entry!, changed);
        resolve(replaced);
      }
      signal?.addEventListener("abort", abort, { once: true });
      entry.listeners.add(changed);
    });
    entry.waiters--;
    if (generation !== epoch) return null;
    if (!again) return commandHistory(path, limit, false, undefined, since);
    // the replacement is read as far as it goes now, not to the length its predecessor had
    limit = Math.min(limit, historyVersion(path)?.size ?? limit);
  }
}

function discard(entry: Entry): void {
  if (entries.get(entry.path) === entry) entries.delete(entry.path);
  if (entry.queued) { queue.splice(queue.indexOf(entry), 1); entry.queued = false; }
  if (entry.timer !== null) { clearTimeout(entry.timer); entry.timer = null; }
  notify(entry);
}

/** What `entry` has to do next: read on, check what it read, nothing until a time, or nothing. */
function due(entry: Entry, now: number): "scan" | "check" | number | null {
  if (entry.failures >= MAX_FAILURES) return null;
  if (now < entry.retryAt) return entry.retryAt;
  if (entry.check !== null) return "check";
  if (entry.offset < entry.limit) return entry.cutAt !== null && entry.version.size <= entry.cutAt ? null : "scan";
  if (entry.checked !== null && entry.checkedThrough >= entry.offset && sameVersion(entry.checked, entry.version)) {
    if (checkedNow(entry)) return null;
    // checked within the version's tick: checked once more when the tick is past, for every waiter and
    // watcher alike (until then each answer reads its ends' lines again, evidence), a watcher's not
    // sooner than the interval; never later than the interval: an mtime far ahead of the clock would
    // otherwise hold it back for good
    const waited = entry.waiters > 0 && entry.checks < entry.wanted;
    const tickPast = entry.checked.mtimeMs + RACY_MS;
    const at = Math.min(waited ? tickPast : Math.max(entry.checkedAt + CHECK_INTERVAL_MS, tickPast), Math.max(entry.checkedAt, entry.checkedFrom) + CHECK_INTERVAL_MS);
    return now >= at ? "check" : at;
  }
  // read through but never checked whole, or a request waits: now; else not more often than the interval
  if (entry.checkedThrough < entry.offset || (entry.waiters > 0 && entry.checks < entry.wanted)) return "check";
  return now >= entry.checkedAt + CHECK_INTERVAL_MS ? "check" : entry.checkedAt + CHECK_INTERVAL_MS;
}

function enqueue(entry: Entry): void {
  if (entry.queued) return;
  const work = due(entry, Date.now());
  if (typeof work === "number") later(entry, work);
  if (work !== "scan" && work !== "check") return;
  entry.queued = true;
  queue.push(entry);
  pump();
}

/** Work held back to `at` is taken up then, for as long as somebody watches. */
function later(entry: Entry, at: number): void {
  if (entry.timer !== null || entry.listeners.size === 0) return;
  entry.timer = setTimeout(() => {
    entry.timer = null;
    if (entries.get(entry.path) === entry) enqueue(entry);
  }, Math.max(0, at - Date.now()));
  entry.timer.unref?.();
}

/**
 * A slice that has neither ended nor taken a turn in this long while another session waits is taken
 * as stuck on its disk. A healthy lease's open and its checks on remote storage, several round
 * trips, can outlast it too, and the next slice then starts beside it.
 */
const STALL_MS = 50;

/** A session waiting whose transcript no slice reads: it can have a slice now. */
const runnable = (entry: Entry): boolean => !running.has(entry.path);

function pump(): void {
  if (draining || slices >= transcriptReader.capacity || !queue.some(runnable)) return;
  draining = true;
  // the first slice waits for the event loop too: whoever asked (a status poll) never runs one
  setImmediate(() => void drain().finally(() => { draining = false; pump(); settle(); }));
}

function settle(): void {
  if (draining || slices > 0) return;
  for (const resolve of idle) resolve();
  idle.clear();
}

/**
 * The first session waiting that can have a slice, taken off the queue. Only the drain takes one:
 * a session taken off it before its slice starts would answer its waiter at once.
 */
function next(): Entry | undefined {
  if (slices >= transcriptReader.capacity) return undefined;
  const index = queue.findIndex(runnable);
  if (index < 0) return undefined;
  const [entry] = queue.splice(index, 1);
  entry!.queued = false;
  return entry;
}

/**
 * One slice of one session at a time, each behind every other session waiting. A slice that has
 * taken no turn for STALL_MS while another session waits is left to end by itself, and the next
 * slice starts beside it, up to the reader's capacity: a transcript stuck on its disk holds up
 * only its own history. One that takes turns lets go by itself at the end of the next.
 */
async function drain(): Promise<void> {
  for (let entry = next(); entry !== undefined; entry = next()) {
    const path = entry.path;
    running.add(path);
    slices++;
    let done = false;
    const slice = step(entry).finally(() => { done = true; running.delete(path); slices--; pump(); settle(); });
    for (let seen = entry.turns; !done; seen = entry.turns) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([slice, new Promise<void>((resolve) => { timer = setTimeout(resolve, STALL_MS); })]);
      clearTimeout(timer);
      if (!done && entry.turns === seen && slices < transcriptReader.capacity && queue.some(runnable)) break;
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

/** One slice: the transcript's bytes are read without holding the event loop while they come. */
async function step(entry: Entry): Promise<void> {
  if (entries.get(entry.path) !== entry) return;
  const before = entry.ends.length;
  let restarted = false;
  // the transcript as known when the stat now on its way was asked for
  let known = entry.version;
  const deadline = Date.now() + READ_MS;
  // the transcript is let go of well inside the read's deadline, however long the read waited to begin
  const held = deadline - READ_MS / 2;
  const signal = cancel.signal;
  // a slice on the event loop counts from here, as main's does: its open and checks hold the loop too
  const began = performance.now();
  try {
    await transcriptReader.read(entry.path, async (file) => {
      let stop = (file.waited() ? performance.now() : began) + SLICE_MS;
      // the whole lines of the last window that a slice ended before taking in, and the stat taken after they were read
      let rest: { from: number; to: number; bytes: Buffer; version: HistoryVersion } | null = null;
      for (let now = file.initial; ;) {
        // let go of (discarded) while it waited for the disk: nothing more is read for it
        if (entries.get(entry.path) !== entry) return;
        if (!seen(entry, known, now)) return;
        const work = due(entry, Date.now());
        let after: HistoryVersion | null = null;
        if (work === "scan") {
          const restarts = entry.restarts;
          if (entry.offset === 0 && entry.spans.length === 0) { entry.checked = now; entry.checkedThrough = 0; entry.checkedFrom = Date.now(); entry.checkedTick = performance.now(); }
          const extends_ = entry.checked !== null && sameVersion(entry.checked, now) && entry.checkedThrough === entry.offset;
          // a record cut at the limit is read whole: past the limit, as far as the transcript goes
          const end = Math.max(entry.limit, entry.version.size);
          let bytes: Buffer;
          if (rest !== null && rest.version === now && entry.offset > rest.from && entry.offset < rest.to) {
            // read already, and no stat since the one after them: neither a read nor a stat is needed
            bytes = rest.bytes.subarray(entry.offset - rest.from, rest.to - rest.from);
            after = now;
          } else {
            const position = entry.offset;
            bytes = await file.window(position, Math.min(CHUNK, end - position));
            known = entry.version;
            // the next window, from the last whole line of this one, is read while the stat is on its
            // way and this one is taken in. Not when nobody listens: the read ends with this slice, and
            // a read ahead left over holds up its close. Nor when this window reached the end
            // already: there is nothing past it to read yet
            const last = bytes.lastIndexOf(10);
            const linesEnd = position + last + 1;
            if (last >= 0 && position + bytes.length < end && entry.listeners.size > 0) file.ahead(linesEnd, Math.min(CHUNK, end - linesEnd));
            after = await file.stat();
            if (entries.get(entry.path) !== entry) return;
            rest = last >= 0 ? { from: position, to: linesEnd, bytes, version: after } : null;
          }
          // taken in only now, all at once: a request in between sees the read as it was, never
          // bytes read but not yet known unchanged; bytes that came within the turn are taken in
          // until it ends, and bytes that came after it (slow storage) get a turn of their own. Not
          // bytes read on the event loop: the loop had no turn while they were read
          const arrived = performance.now();
          if (entry.restarts !== restarts) {
            // started over while it read (a request found a line it read rewritten, evidence): the
            // window is from where the read was, not from where it starts again
            rest = null;
          } else {
            scan(entry, bytes, arrived < stop || !file.waited() ? stop : arrived + SLICE_MS);
            // nothing was written while it read: what it read is as checked as what came before
            if (extends_ && sameVersion(after, now)) entry.checkedThrough = entry.offset;
          }
        } else if (work === "check") {
          // a check reads into the window those lines were in
          rest = null;
          if (!await check(entry, file, now, stop)) { restart(entry); restarted = true; }
        } else break;
        if (performance.now() >= stop) {
          // the turn ends the read when nobody wants it read on, another session that can have a slice
          // or another reader waits, it started over, or a watcher has an end to hear
          if (Date.now() >= held || entry.listeners.size === 0 || queue.some((other) => other !== entry && runnable(other))
            || transcriptReader.size().waiting > 0 || restarted || (entry.ends.length !== before && entry.listeners.size > entry.waiters)) break;
          // nobody else waits: the event loop has its turn, and the read goes on with the transcript
          // still open (an open and its check cost several round trips on remote storage). Two
          // immediates: one set while an I/O callback runs comes before the timers already due, so
          // with one, a slice that needs no read (the rest of a window) could follow this one first
          entry.turns++;
          await new Promise<void>((resolve) => setImmediate(() => setImmediate(resolve)));
          stop = performance.now() + SLICE_MS;
        }
        // the stat after a read is as new as one taken now: one disk round trip fewer
        if (after === null) { known = entry.version; after = await file.stat(); }
        now = after;
      }
    }, { deadline, signal });
    if (entries.get(entry.path) !== entry) return;
    entry.failures = 0;
    entry.retryAt = 0;
  } catch (error) {
    if (entries.get(entry.path) !== entry) return;
    // replaced before the read was let in (the reader refuses a path that names another file):
    // read anew, as a stat that found it would
    const named = historyVersion(entry.path);
    if (named !== null && !sameHistory(entry.version, named)) { discard(entry); return; }
    // the reader busy or a read too slow: no failure of this transcript, so it is never given up for it
    if (!(error instanceof TranscriptBusyError)) entry.failures++;
    entry.retryAt = Date.now() + Math.min(RETRY_MAX_MS, 1000 * 2 ** (Math.max(1, entry.failures) - 1));
  }
  if (entries.get(entry.path) !== entry) return;
  const work = due(entry, Date.now());
  // asked for again while it read (enqueue): it waits in the queue already
  if (!entry.queued && (work === "scan" || work === "check") && entry.listeners.size > 0) { entry.queued = true; queue.push(entry); }
  else if (!entry.queued && typeof work === "number") later(entry, work);
  // a waiter hears when the read stops; a watcher when it learns an end or starts over too
  if (restarted || entry.ends.length !== before || !entry.queued) notify(entry);
}

/**
 * Takes in `now`, a stat of the transcript asked for when it was known as `known`: false when it
 * was changed other than by growing, and the read is let go of. A status poll may have seen the
 * transcript newer while the stat was on its way: that stat is no news, though not a shrink of what
 * was known when it was asked for.
 */
function seen(entry: Entry, known: HistoryVersion, now: HistoryVersion): boolean {
  if (sameHistory(known, now) && (sameHistory(entry.version, now) || sameHistory(now, entry.version))) {
    if (sameHistory(entry.version, now)) entry.version = now;
    return true;
  }
  discard(entry);
  return false;
}

function notify(entry: Entry): void {
  // a listener let go of before its turn comes (a tracker stopped) hears nothing
  for (const listener of [...entry.listeners]) queueMicrotask(() => { if (entry.listeners.has(listener)) listener(); });
}

/** The bytes read were changed: everything learnt from them goes, and the read starts again. */
function restart(entry: Entry): void {
  entry.offset = 0;
  entry.skipping = false;
  entry.cutAt = null;
  entry.spans = [];
  entry.checked = null;
  entry.checkedThrough = 0;
  entry.checkedFrom = -Infinity;
  entry.checkedTick = -Infinity;
  entry.check = null;
  entry.ends = [];
  entry.restarts++;
}

/** Takes in `bytes`, read from `entry.offset` (a chunk at most), and keeps the ends of the whole lines in them. */
function scan(entry: Entry, bytes: Buffer, stop: number): void {
  entry.cutAt = null;
  let from = 0;
  if (entry.skipping) {
    const newline = bytes.indexOf(10);
    from = newline < 0 ? bytes.length : newline + 1;
    entry.skipping = newline < 0;
  }
  let to = from;
  if (!entry.skipping) {
    const last = bytes.lastIndexOf(10);
    if (last >= from) to = last + 1;
    // a record longer than a chunk is passed over: it proves nothing
    else if (from === 0 && bytes.length === CHUNK) { to = CHUNK; entry.skipping = true; }
  }
  const read = terminals(entry, bytes, from, to, stop);
  // the newest are kept: a command still unresolved more likely ended late than early
  if (entry.ends.length > MAX_ENDS) entry.ends.splice(0, entry.ends.length - MAX_ENDS);
  // read to the transcript's end (a record not written whole, or a limit past it): read on once it grows
  if (read === to && entry.offset + bytes.length >= entry.version.size) entry.cutAt = entry.version.size;
  to = read;
  if (to === 0) return;
  entry.spans.push({ end: entry.offset + to, digest: BigInt(Bun.hash.xxHash3(bytes.subarray(0, to))) });
  entry.offset += to;
}

/** The ends told by the lines from `from` to `to` (whole lines), as far as the slice lasts: where it stopped. */
function terminals(entry: Entry, bytes: Buffer, from: number, to: number, stop: number): number {
  const next = MARKERS.map((marker) => bytes.indexOf(marker, from));
  for (;;) {
    let hit = -1;
    for (const at of next) if (at >= 0 && at < to && (hit < 0 || at < hit)) hit = at;
    if (hit < 0) return to;
    const start = bytes.lastIndexOf(10, hit) + 1;
    const end = bytes.indexOf(10, hit);
    // the newlines on both sides too: they keep the record whole (a line begun at a chunk's start
    // follows the newline the last read stopped after)
    const lead = entry.offset + start > 0 ? 1 : 0;
    const line = start >= lead ? bytes.subarray(start - lead, end + 1) : Buffer.concat([NEWLINE, bytes.subarray(start, end + 1)]);
    const digest = BigInt(Bun.hash.xxHash3(line));
    for (const terminal of commandTerminals(bytes.toString("utf8", start, end), entry.session)) entry.ends.push({ ...terminal, from: entry.offset + start - lead, to: entry.offset + end + 1, digest });
    for (let index = 0; index < next.length; index++) if (next[index]! >= 0 && next[index]! <= end) next[index] = bytes.indexOf(MARKERS[index]!, end + 1);
    if (performance.now() >= stop) return end + 1;
  }
}

/** Checks the spans read against their digests, as far as the slice lasts; false when one changed. */
async function check(entry: Entry, file: TranscriptFile, now: HistoryVersion, stop: number): Promise<boolean> {
  if (entry.check === null) { entry.checkedAt = Date.now(); entry.check = { next: 0, version: now, at: entry.checkedAt, tick: performance.now() }; entry.checks++; }
  const pass = entry.check;
  while (pass.next < entry.spans.length) {
    const start = pass.next === 0 ? 0 : entry.spans[pass.next - 1]!.end;
    const span = entry.spans[pass.next]!;
    const bytes = await file.window(start, span.end - start);
    // started over while it read (evidence): the spans it checks are gone, and so is the check
    if (entry.check !== pass) return true;
    // the next span is read while this one's digest is taken
    const following = entry.spans[pass.next + 1];
    if (following !== undefined && entry.listeners.size > 0) file.ahead(span.end, following.end - span.end);
    if (bytes.length !== span.end - start || BigInt(Bun.hash.xxHash3(bytes)) !== span.digest) return false;
    pass.next++;
    if (performance.now() >= stop) break;
  }
  if (pass.next >= entry.spans.length) {
    entry.check = null;
    entry.checked = pass.version;
    entry.checkedThrough = entry.offset;
    entry.checkedFrom = pass.at;
    entry.checkedTick = pass.tick;
  }
  return true;
}

export function resetCommandHistory(): void {
  generation++;
  cancel.abort();
  cancel = new AbortController();
  for (const entry of [...entries.values()]) discard(entry);
  queue.length = 0;
}
export function holdCommandHistory(): () => void {
  holders++;
  let released = false;
  return () => { if (!released) { released = true; if (--holders === 0) resetCommandHistory(); } };
}
export function commandHistorySize(): { waiting: number; sessions: number; draining: boolean; timers: number } {
  return { waiting: queue.length, sessions: entries.size, draining: draining || slices > 0, timers: [...entries.values()].filter((entry) => entry.timer !== null).length };
}
/** Resolves once no slice runs and none waits to start. */
export function commandHistorySettled(): Promise<void> {
  return draining || slices > 0 ? new Promise((resolve) => idle.add(resolve)) : Promise.resolve();
}
