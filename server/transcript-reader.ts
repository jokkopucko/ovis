import { closeSync, constants, fstat, fstatSync, lstatSync, openSync, read, readSync, statSync, type Stats } from "node:fs";
import { lstat, open, stat, statfs } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * A transcript's identity, length and clock, in the form `lstatSync` gives (historyVersion), so the
 * two compare. `dev` and `ino` are numbers there, not bigints: on a filesystem whose numbers pass
 * 2^53, two files may share an identity.
 */
export interface TranscriptVersion { id: string; size: number; mtimeMs: number }
export const transcriptVersion = (stat: Stats): TranscriptVersion | null => stat.isFile() ? { id: `${stat.dev}:${stat.ino}`, size: stat.size, mtimeMs: stat.mtimeMs } : null;

export class TranscriptBusyError extends Error {
  constructor(message = "the transcript reader is busy") { super(message); this.name = "TranscriptBusyError"; }
}

export interface TranscriptHandle {
  stat(): Promise<Stats>;
  read(buffer: Buffer, offset: number, length: number, position: number): Promise<{ bytesRead: number }>;
  close(): Promise<void>;
  readNow?(buffer: Buffer, offset: number, length: number, position: number): number;
  statNow?(): Stats;
}
export interface TranscriptHandleNow extends TranscriptHandle {
  readNow(buffer: Buffer, offset: number, length: number, position: number): number;
  statNow(): Stats;
}
const hasNow = (handle: TranscriptHandle): handle is TranscriptHandleNow => handle.readNow !== undefined && handle.statNow !== undefined;
export interface TranscriptIO {
  open(path: string): Promise<TranscriptHandle>;
  /** The path's own entry (lstat), or with `follow` the file a link there names (stat). */
  stat(path: string, follow?: boolean): Promise<Stats>;
  /**
   * Whether `directory` is on a local filesystem, where a read the page cache answers costs less
   * on the event loop than a round trip through the thread pool, and its device: a transcript on
   * another device (a file mounted into the directory) is not known to be local.
   */
  filesystem?(directory: string): Promise<{ local: boolean; dev: number }>;
  openNow?(path: string): TranscriptHandleNow;
  statNow?(path: string, follow?: boolean): Stats;
}
const FLAGS = constants.O_RDONLY | (constants.O_NONBLOCK ?? 0);
/**
 * Linux filesystems on a local block device or in memory (statfs f_type): ext2/3/4, btrfs, xfs,
 * tmpfs, zfs, f2fs, bcachefs. Not FUSE (sshfs, virtiofs), NFS, SMB, 9p (WSL's Windows drives) or
 * any other: a read there may wait on the network, so it is never made on the event loop. Other
 * platforms' statfs types mean other things: there every read is async.
 */
const LOCAL = new Set([0xef53, 0x9123683e, 0x58465342, 0x01021994, 0x2fc12fc1, 0xf2f52010, 0xca451a4e]);
const nativeIO: TranscriptIO = {
  open: async (path) => {
    const handle = await open(path, FLAGS);
    return {
      stat: () => handle.stat(), read: (buffer, offset, length, position) => handle.read(buffer, offset, length, position), close: () => handle.close(),
      readNow: (buffer, offset, length, position) => readSync(handle.fd, buffer, offset, length, position),
      statNow: () => fstatSync(handle.fd),
    };
  },
  stat: (path, follow) => follow ? stat(path) : lstat(path),
  ...(process.platform === "linux" ? {
    filesystem: async (directory: string) => {
      const [found, named] = await Promise.all([statfs(directory), stat(directory)]);
      return { local: LOCAL.has(found.type), dev: named.dev };
    },
    openNow: (path: string): TranscriptHandleNow => {
      const fd = openSync(path, FLAGS);
      return {
        readNow: (buffer, offset, length, position) => readSync(fd, buffer, offset, length, position),
        statNow: () => fstatSync(fd),
        read: (buffer, offset, length, position) => new Promise((resolve, reject) => read(fd, buffer, offset, length, position, (error, bytesRead) => error ? reject(error) : resolve({ bytesRead }))),
        stat: () => new Promise((resolve, reject) => fstat(fd, (error, stats) => error ? reject(error) : resolve(stats))),
        close: async () => closeSync(fd),
      };
    },
    statNow: (path: string, follow?: boolean) => follow ? statSync(path) : lstatSync(path),
  } : {}),
};
const WINDOW_BYTES = 1024 * 1024;
/** A call on the event loop slower than this was answered by the disk, not the page cache. */
const SLOW_MS = 2;
const SLOW_FOR_MS = 1000;
const FILESYSTEM_MS = 60_000;

export interface TranscriptFile {
  readonly initial: TranscriptVersion;
  readonly deadline: number;
  stat(): Promise<TranscriptVersion>;
  stats(): Promise<Stats>;
  pathVersion(): Promise<TranscriptVersion | null>;
  pathStats(): Promise<Stats>;
  read(position: number, length: number, into?: Buffer): Promise<Buffer>;
  /** The same bytes in a buffer the lease keeps for them, so no window is allocated: they hold only until the next `window` or the lease's end. */
  window(position: number, length: number): Promise<Buffer>;
  ahead(position: number, length: number): void;
  waited(): boolean;
}
interface Request {
  path: string;
  live: boolean;
  started: boolean;
  run(): Promise<void>;
  cancel(): void;
}

/**
 * Cancellation ends only the caller's wait. Native async FS uses Bun's shared runtime pool; this
 * bound does not reserve runtime capacity or interrupt a stuck syscall.
 *
 * Known limits:
 * - A local disk that stops answering inside a call on the event loop blocks the loop, as a
 *   synchronous read would. The fallback notices a slow call only once it returns.
 * - A native operation that never settles (a read ahead or any other) keeps its lease, so two of
 *   them on two paths keep every lease, and every later read waits out its deadline (one with a
 *   budget alone waits until its signal aborts).
 * - A cancelled lease keeps its path too, until its operations settle: a new read of that
 *   transcript waits behind it.
 */
export class TranscriptReader {
  private readonly queue: Request[] = [];
  private readonly active = new Set<Request>();
  private readonly paths = new Set<string>();
  private resetting = false;
  private readonly idle = new Set<() => void>();
  private readonly spare: Buffer[] = [];
  private readonly filesystems = new Map<string, { dev: number | null; until: number }>();
  private readonly slow = new Map<string, number>();
  private admitting: Request | null = null;
  constructor(private readonly io: TranscriptIO = nativeIO, readonly capacity = 2, private readonly waiting = 32) {}

  /** `follow`: the path may be a link to the transcript (it is opened through one anyway), and is checked by the file it names. */
  read<T>(path: string, work: (file: TranscriptFile) => Promise<T>, options: { signal?: AbortSignal; deadline?: number; budget?: number; follow?: boolean } = {}): Promise<T> {
    const { signal, budget, follow = false } = options;
    let { deadline } = options;
    if (signal?.aborted || (deadline !== undefined && deadline <= Date.now())) return Promise.reject(new TranscriptBusyError("the transcript read was cancelled"));
    if (this.queue.length >= this.waiting && (this.active.size >= this.capacity || this.paths.has(path))) return Promise.reject(new TranscriptBusyError());
    return new Promise<T>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const cleanup = () => { signal?.removeEventListener("abort", request.cancel); clearTimeout(timer); };
      const arm = () => {
        if (deadline === undefined) return;
        clearTimeout(timer);
        timer = setTimeout(request.cancel, Math.max(0, deadline - Date.now()));
        timer.unref?.();
      };
      const current = () => {
        if (request.live && deadline !== undefined && Date.now() >= deadline) request.cancel();
        if (!request.live) throw new TranscriptBusyError("the transcript read was cancelled");
      };
      const request: Request = {
        path, live: true, started: false,
        cancel: () => {
          if (!request.live) return;
          request.live = false;
          cleanup();
          reject(new TranscriptBusyError("the transcript read was cancelled"));
          if (!request.started) {
            const index = this.queue.indexOf(request);
            if (index >= 0) this.queue.splice(index, 1);
          }
          this.pump();
        },
        run: async () => {
          if (budget !== undefined) { deadline = Math.min(deadline ?? Infinity, Date.now() + budget); arm(); }
          const immediate = this.admitting === request;
          let handle: Awaited<ReturnType<TranscriptIO["open"]>> | undefined;
          let closeNow = false;
          const operations = new Set<Promise<unknown>>();
          let accepting = true;
          let value: T | undefined;
          let error: unknown;
          let failed = false;
          let front: Buffer | undefined;
          let back: Buffer | undefined;
          let readAhead: { position: number; length: number; bytes: Promise<Buffer> } | null = null;
          try {
            // on a local filesystem the transcript is read on the event loop while the page cache
            // answers: a call through the thread pool costs a wake of its thread, a copy on another
            // core and a wake of the event loop, more than the read itself
            const near = this.near(path);
            let direct: TranscriptHandleNow | null = null;
            let device: number | null;
            let slowOpen = false;
            if (!(near instanceof Promise)) {
              device = near;
              if (device !== null) {
                const started = performance.now();
                try { direct = this.io.openNow!(path); } catch (caught) { this.slowed(path); throw caught; }
                closeNow = true;
                if (performance.now() - started > SLOW_MS) { slowOpen = true; this.slowed(path); }
              }
              handle = direct ?? await this.io.open(path);
            } else {
              // the filesystem is looked up while the transcript opens, not before: on a network
              // filesystem the lookup costs round trips of its own
              const [found, opened] = await Promise.all([near, this.io.open(path)]);
              handle = opened;
              device = found;
              direct = device !== null && hasNow(opened) ? opened : null;
            }
            current();
            const pinned = handle;
            let busy = false;
            // One slow call alone may be the process's pause (a garbage collection of a few ms lands
            // inside a call now and then); a disk that does not have the transcript cached is slow again
            // on the next.
            let now = direct !== null && !slowOpen;
            let slowBefore = false;
            let waited = true;
            // Only a fast read ends a run of slow calls: a scan stats its file each window, and a stat the
            // inode cache answers says nothing of the disk
            const timed = <V>(call: (direct: TranscriptHandleNow) => V, read = false): Promise<V> => {
              try {
                current();
                if (!accepting) throw new Error("the transcript lease is closed");
                const started = performance.now();
                let value: V;
                try { value = call(direct!); } catch (caught) { now = false; this.slowed(path); throw caught; }
                waited = false;
                const slow = performance.now() - started > SLOW_MS;
                if (slow && slowBefore) { now = false; this.slowed(path); }
                if (slow || read) slowBefore = slow;
                current();
                return Promise.resolve(value);
              } catch (caught) { return Promise.reject(caught); }
            };
            const operation = <V>(call: () => Promise<V>, beside = false): Promise<V> => {
              const pending = (async () => {
                current();
                if (!accepting) throw new Error("the transcript lease is closed");
                if (beside) { const result = await call(); current(); return result; }
                if (busy) throw new Error("transcript operations must be awaited in order");
                busy = true;
                waited = true;
                try { const result = await call(); current(); return result; }
                finally { busy = false; }
              })();
              operations.add(pending);
              void pending.then(() => operations.delete(pending), () => operations.delete(pending));
              return pending;
            };
            const valid = (position: number, length: number) => {
              if (!Number.isSafeInteger(position) || position < 0 || !Number.isSafeInteger(length) || length < 0 || length > WINDOW_BYTES) throw new RangeError("invalid transcript window");
            };
            const fill = async (position: number, length: number, bytes: Buffer) => {
              current();
              valid(position, length);
              let offset = 0;
              while (offset < length) {
                const { bytesRead } = await pinned.read(bytes, offset, length - offset, position + offset);
                current();
                if (bytesRead === 0) break;
                offset += bytesRead;
              }
              return bytes.subarray(0, offset);
            };
            const fillNow = (direct: TranscriptHandleNow, position: number, length: number, bytes: Buffer) => {
              valid(position, length);
              let offset = 0;
              while (offset < length) {
                const bytesRead = direct.readNow(bytes, offset, length - offset, position + offset);
                if (bytesRead === 0) break;
                offset += bytesRead;
              }
              return bytes.subarray(0, offset);
            };
            const spareWindow = () => this.spare.pop() ?? Buffer.allocUnsafe(WINDOW_BYTES);
            const plain = (version: TranscriptVersion | null) => {
              if (version === null) throw new Error("the transcript is not a plain file");
              return version;
            };
            let initial: TranscriptVersion | undefined;
            const file: TranscriptFile = {
              get initial() { return initial!; },
              deadline: deadline ?? Infinity,
              stat: () => now ? timed((direct) => {
                const stats = direct.statNow();
                // a transcript on another device than its directory (mounted into it) is not known to be
                // local: the stat before any read finds it, and the rest goes through the thread pool
                if (stats.dev !== device) { now = false; this.slowed(path, FILESYSTEM_MS); }
                return plain(transcriptVersion(stats));
              }) : operation(async () => {
                current();
                const version = transcriptVersion(await pinned.stat());
                current();
                return plain(version);
              }),
              stats: () => now ? timed((direct) => direct.statNow()) : operation(async () => {
                current();
                const stats = await pinned.stat();
                current();
                return stats;
              }),
              pathVersion: () => now ? timed(() => transcriptVersion(this.io.statNow!(path, follow))) : operation(async () => {
                current();
                const version = transcriptVersion(await this.io.stat(path, follow));
                current();
                return version;
              }),
              pathStats: () => now ? timed(() => this.io.statNow!(path, follow)) : operation(async () => {
                current();
                const stats = await this.io.stat(path, follow);
                current();
                return stats;
              }),
              read: (position, length, into) => now ? timed((direct) => fillNow(direct, position, length, into ?? Buffer.allocUnsafe(length)), true)
                : operation(() => fill(position, length, into ?? Buffer.allocUnsafe(length))),
              window: (position, length) => now ? timed((direct) => fillNow(direct, position, length, front ??= spareWindow()), true) : operation(async () => {
                const read = readAhead;
                readAhead = null;
                if (read !== null) {
                  if (read.position === position && read.length === length) {
                    const bytes = await read.bytes;
                    [front, back] = [back, front];
                    return bytes;
                  }
                  // let settle first: its buffer is the next read ahead's, and the lease keeps to two native operations
                  await read.bytes.catch(() => {});
                }
                return fill(position, length, front ??= spareWindow());
              }),
              ahead: (position, length) => {
                if (now || readAhead !== null || !accepting) return;
                valid(position, length);
                const bytes = operation(() => fill(position, length, back ??= spareWindow()), true);
                bytes.catch(() => {});
                readAhead = { position, length, bytes };
              },
              waited: () => waited,
            };
            const before = await file.stat();
            initial = before;
            const named = await file.pathVersion();
            if (named === null || named.id !== before.id) throw new Error("the transcript was replaced");
            waited = !immediate || !now;
            value = await work(file);
            current();
          } catch (caught) { error = caught; failed = true; }
          finally {
            accepting = false;
            await Promise.allSettled([...operations]);
            // Even an open that answered after cancellation must close; neither its path nor the
            // physical allowance is available to a replacement until this await has settled.
            try {
              const started = performance.now();
              const closing = handle?.close();
              if (closeNow && performance.now() - started > SLOW_MS) this.slowed(path);
              await closing;
            } catch (caught) {
              if (closeNow) this.slowed(path);
              if (!failed) error = caught;
              failed = true;
            }
            if (front !== undefined) this.spare.push(front);
            if (back !== undefined) this.spare.push(back);
            if (request.live && deadline !== undefined && Date.now() >= deadline) request.cancel();
            this.active.delete(request);
            this.paths.delete(path);
            if (request.live) {
              request.live = false;
              cleanup();
              if (failed) reject(error); else resolve(value as T);
            }
            this.pump();
          }
        },
      };
      signal?.addEventListener("abort", request.cancel, { once: true });
      arm();
      this.queue.push(request);
      this.admitting = request;
      try { this.pump(); } finally { this.admitting = null; }
    });
  }

  private pump(): void {
    if (this.resetting) return;
    if (this.active.size === 0 && this.queue.length === 0) { for (const resolve of this.idle) resolve(); this.idle.clear(); }
    while (this.active.size < this.capacity) {
      const index = this.queue.findIndex((request) => !this.paths.has(request.path));
      if (index < 0) return;
      const request = this.queue.splice(index, 1)[0]!;
      request.started = true;
      this.active.add(request);
      this.paths.add(request.path);
      void request.run();
    }
  }

  private near(path: string): number | null | Promise<number | null> {
    if (this.io.filesystem === undefined || this.io.openNow === undefined || this.io.statNow === undefined) return null;
    const until = this.slow.get(path);
    if (until !== undefined) { if (Date.now() < until) return null; this.slow.delete(path); }
    const directory = dirname(path);
    const known = this.filesystems.get(directory);
    if (known !== undefined && Date.now() < known.until) return known.dev;
    return this.io.filesystem(directory).then(({ local, dev }) => local ? dev : null, () => null).then((dev) => {
      if (this.filesystems.size >= 256) this.filesystems.clear();
      this.filesystems.set(directory, { dev, until: Date.now() + FILESYSTEM_MS });
      return dev;
    });
  }
  private slowed(path: string, ms = SLOW_FOR_MS): void {
    if (this.slow.size >= 256) this.slow.clear();
    this.slow.set(path, Date.now() + ms);
  }

  reset(): void {
    this.spare.length = 0;
    this.filesystems.clear();
    this.slow.clear();
    this.resetting = true;
    try { for (const request of [...this.queue, ...this.active]) request.cancel(); }
    finally { this.resetting = false; this.pump(); }
  }
  settled(): Promise<void> { return this.active.size === 0 && this.queue.length === 0 ? Promise.resolve() : new Promise((resolve) => this.idle.add(resolve)); }
  size(): { active: number; waiting: number; paths: number } { return { active: this.active.size, waiting: this.queue.length, paths: this.paths.size }; }
}

export const transcriptReader = new TranscriptReader();
