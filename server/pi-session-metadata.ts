/**
 * Pi-only streaming metadata reader. Completed clipped labels are cached by checked path and
 * descriptor identity/size/timestamps. Unfinished scans retain only a bounded parser and offset,
 * never transcript content or an open descriptor, and resume only while the stat key is unchanged.
 *
 * Transcript reads/stats are asynchronous on the checked descriptor, never a reopened path.
 * At most two readers run and 32 wait. Headers have a one-chunk-per-open bound and a shared ten-second
 * deadline; longer headers retain progress too. Label scans share a two-second deadline, including
 * header and queue time, but always keep a quarter of it after the header pass. Calls already in
 * the filesystem retain their descriptor/slot until they return, then close it, never mid-read.
 *
 * Reads use 64 KiB chunks and a bounded JSON projection, not whole-line/transcript buffers. The
 * deadline bounds label work rather than a fixed transcript cutoff. A changed file or failed label
 * read never publishes a torn label; the listing keeps the established row. Header failures keep
 * checked rows, or return retryable busy when none could be checked. There is no background scan.
 */
import { closeSync, fstat, read, type BigIntStats } from "node:fs";

import { PiLabelParser, type PiLabel } from "./pi-session-label.ts";

export const PI_CHUNK_BYTES = 64 * 1024;
export const PI_READ_DEADLINE_MS = 2000;
export const PI_HEADER_DEADLINE_MS = 10_000;
export const PI_READERS = 2;
const WAITING = 32;
export const PI_CACHE_ENTRIES = 256;

export class PiMetadataBusy extends Error {
  constructor(readonly reason: "read" | "queue" | "stopped" = "read") { super("Pi sessions could not be read right now. Try again."); }
}

/** Deadline detail for keeping established rows while an unfinished scan stays private. */
export class PiMetadataDeadline extends PiMetadataBusy {
  constructor(readonly partial: PiLabel | null) { super(); }
}

const descriptorStat = (fd: number): Promise<BigIntStats> => new Promise((done, fail) => {
  fstat(fd, { bigint: true }, (error, stat) => error ? fail(error) : done(stat));
});
const descriptorRead = (fd: number, buffer: Buffer, length: number, position: number): Promise<number> => new Promise((done, fail) => {
  read(fd, buffer, 0, length, position, (error, bytes) => error ? fail(error) : done(bytes));
});

interface Task {
  /** Check each asynchronous step; null explicitly refuses a path/descriptor identity. */
  open: (checkActive: () => void) => number | null | Promise<number | null>;
  deadline: number;
  done: (label: PiLabel | null) => void;
  fail: (error: unknown) => void;
  timer?: ReturnType<typeof setTimeout>;
  mode: "labels" | "header";
  expired: boolean;
  partial: PiLabel | null;
  cache: {
    path: string;
    scope: string;
    acceptHeader?: (header: NonNullable<PiLabel["header"]>) => boolean;
    /** A retained completed headerless result still occupies a cache slot. */
    headerless?: () => void;
  } | null;
}

interface ReaderOptions {
  /** Descriptor-only seam for counting I/O and holding a read in tests. */
  read?: typeof descriptorRead;
  /** A listing's deadline: PI_READ_DEADLINE_MS. A test that checks what is read, not how fast, sets a longer one. */
  deadlineMs?: number;
}

interface Cached {
  key: string;
  scope: string;
  label: PiLabel | null;
  progress?: { parser: PiLabelParser; position: number };
}

export class PiSessionReader {
  private tasks = new Set<Task>();
  private queue: Task[] = [];
  private active = 0;
  private working = new Set<Promise<void>>();
  private stopped = false;
  private labels = new Map<string, Cached>();
  constructor(private readonly options: ReaderOptions = {}) {}
  /** How long one listing may scan labels, header and queue time included. */
  get listingDeadlineMs(): number { return this.options.deadlineMs ?? PI_READ_DEADLINE_MS; }

  /** In-flight scans stay independent; a cached parser is taken by just one checked reader. */
  read(open: Task["open"], deadline: number, cache: Task["cache"] = null, mode: Task["mode"] = "labels"): Promise<PiLabel | null> {
    if (this.stopped) return Promise.reject(new PiMetadataBusy("stopped"));
    if (this.active >= PI_READERS && this.queue.length >= WAITING) return Promise.reject(new PiMetadataBusy("queue"));
    if (performance.now() >= deadline) return Promise.reject(new PiMetadataDeadline(null));
    const { promise, resolve, reject } = Promise.withResolvers<PiLabel | null>();
    const task: Task = {
      open, deadline, cache, mode, done: resolve, fail: reject, expired: false, partial: null,
    };
    if (Number.isFinite(deadline)) {
      task.timer = setTimeout(() => {
        task.expired = true;
        task.fail(new PiMetadataDeadline(task.partial));
        const at = this.queue.indexOf(task);
        if (at >= 0) { this.queue.splice(at, 1); this.tasks.delete(task); }
      }, Math.max(0, deadline - performance.now()));
    }
    this.tasks.add(task);
    if (this.active < PI_READERS) this.start(task);
    else this.queue.push(task);
    return promise;
  }

  private start(task: Task): void {
    this.active++;
    const finish = () => {
      clearTimeout(task.timer);
      this.tasks.delete(task);
      this.active--;
      const next = this.queue.shift();
      if (next) this.start(next);
    };
    const work = this.scan(task).then(
      (label) => { finish(); task.done(label); },
      (error: unknown) => { finish(); task.fail(error); },
    );
    this.working.add(work);
    void work.then(() => this.working.delete(work));
  }

  private async scan(task: Task): Promise<PiLabel | null> {
    let fd: number | undefined;
    let key = "";
    let parser = new PiLabelParser();
    let position = 0;
    const checkActive = () => {
      if (this.stopped) throw new PiMetadataBusy("stopped");
      if (task.expired || performance.now() >= task.deadline) throw new PiMetadataDeadline(task.partial);
    };
    const accepted = (label: PiLabel | null) => !label?.header || !task.cache?.acceptHeader || task.cache.acceptHeader(label.header);
    try {
      checkActive();
      // The opener owns its descriptor until validation succeeds; cancellation closes it there.
      fd = (await task.open(checkActive)) ?? undefined;
      checkActive();
      if (fd === undefined) return null;
      const before = await descriptorStat(fd);
      checkActive();
      const unchanged = (after: BigIntStats) => before.size === after.size
        && before.mtimeNs === after.mtimeNs && before.ctimeNs === after.ctimeNs;
      // Nanoseconds strengthen the requested millisecond key on filesystems that expose them.
      key = [before.dev, before.ino, before.size, before.mtimeMs, before.ctimeMs, before.mtimeNs, before.ctimeNs].join(":");
      const cached = task.cache === null ? undefined : this.labels.get(task.cache.path);
      if (task.cache !== null) this.labels.delete(task.cache.path);
      if (cached?.key === key && task.cache !== null) {
        if (!accepted(cached.progress?.parser.partial() ?? cached.label)) return null;
        if (cached.progress === undefined) {
          this.labels.set(task.cache.path, { ...cached, scope: task.cache.scope });
          if (cached.label === null) task.cache.headerless?.();
          return cached.label;
        }
        ({ parser, position } = cached.progress);
        // The unchanged descriptor key validates the prefix retained at the previous deadline.
        task.partial = parser.partial();
        if (task.mode === "header" && task.partial.header !== null) {
          this.labels.set(task.cache.path, { ...cached, scope: task.cache.scope });
          return task.partial;
        }
      }
      const buffer = Buffer.alloc(PI_CHUNK_BYTES);
      const end = Number(before.size);
      while (position < end) {
        checkActive();
        const length = Math.min(buffer.length, end - position);
        const count = await (this.options.read ?? descriptorRead)(fd, buffer, length, position);
        if (count <= 0 || count > length) throw new PiMetadataBusy();
        // Keep the chunk already read even if it used the rest of the budget. No next read starts.
        parser.feed(buffer.subarray(0, count));
        position += count;
        checkActive();
        if (task.mode === "header") break;
        if (task.partial === null && parser.partial().header !== null) {
          if (!unchanged(await descriptorStat(fd))) throw new PiMetadataBusy();
          task.partial = parser.partial();
          checkActive();
        }
      }
      checkActive();
      const after = await descriptorStat(fd);
      checkActive();
      if (!unchanged(after)) throw new PiMetadataBusy();
      if (task.mode === "header" && position < end) {
        const label = parser.partial();
        if (!accepted(label)) return null;
        this.remember(task, { key, scope: task.cache?.scope ?? "", label, progress: { parser, position } });
        return label;
      }
      const finished = parser.finish();
      const label = finished.header === null ? null : finished;
      if (!accepted(label)) return null;
      // One-chunk headerless files are cheap and stay free; longer files must not restart
      // their completed scan on every open and consume unfinished-header slots forever.
      if (label === null && end <= PI_CHUNK_BYTES) return null;
      this.remember(task, { key, scope: task.cache?.scope ?? "", label });
      if (label === null) task.cache?.headerless?.();
      return label;
    } catch (error) {
      if (error instanceof PiMetadataDeadline) {
        // No new I/O after expiry. This parser is private until the next opener checks its key;
        // only the header already validated before expiry may identify a row now.
        if (key !== "" && position > 0) this.remember(task, {
          key, scope: task.cache?.scope ?? "", label: task.partial, progress: { parser, position },
        });
        throw error;
      }
      // An opener can reject after expiry too: stop this listing instead of trying older files.
      checkActive();
      if (error instanceof PiMetadataBusy) throw error;
      // A discovered file whose header could not be checked is not proof of an empty store.
      if (fd !== undefined || task.mode === "header") throw new PiMetadataBusy();
      return null;
    } finally { if (fd !== undefined) closeSync(fd); }
  }

  private remember(task: Task, entry: Cached): void {
    if (task.cache === null || this.stopped) return;
    const existing = this.labels.get(task.cache.path);
    // An independent concurrent scan may already have completed or advanced farther.
    if (existing?.key === entry.key && (existing.progress === undefined
      || (entry.progress !== undefined && existing.progress.position > entry.progress.position))) return;
    this.labels.delete(task.cache.path);
    this.labels.set(task.cache.path, entry);
    if (this.labels.size > PI_CACHE_ENTRIES) {
      const oldest = this.labels.keys().next().value;
      if (oldest !== undefined) this.labels.delete(oldest);
    }
  }

  /** Refuse queued/in-flight requests now; each active descriptor closes once its filesystem call ends. */
  close(): void {
    this.stopped = true;
    this.labels.clear();
    for (const task of this.tasks) {
      task.expired = true;
      clearTimeout(task.timer);
      task.fail(new PiMetadataBusy("stopped"));
    }
    for (const task of this.queue) this.tasks.delete(task);
    this.queue = [];
  }

  /** Wait until actual filesystem calls/descriptor cleanup finish, even after callers were refused. */
  async idle(): Promise<void> { await Promise.all([...this.working]); }

  /** Drop labels no longer discovered in these listing folders; other stores keep their own entries. */
  retain(scope: string, paths: readonly string[]): void {
    const listed = new Set(paths);
    for (const [path, entry] of this.labels) {
      if (entry.scope === scope && !listed.has(path)) this.labels.delete(path);
    }
  }

  /** Cache count only, never the retained labels or paths (regression instrumentation). */
  cacheSize(): number { return this.labels.size; }

  /** Resource counts only, never names/prompts/paths (regression instrumentation). */
  size(): { active: number; waiting: number } {
    return { active: this.active, waiting: this.queue.length };
  }
}

/** Direct callers share admission and clipped labels; createServer owns its reader and cache. */
export const defaultPiSessionReader = new PiSessionReader();
