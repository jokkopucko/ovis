import { closeSync, constants, fstat, fstatSync, lstatSync, openSync, read, readSync, type Stats } from "node:fs";
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

/** The small native surface also lets lifecycle tests hold actual operation settlement. */
export interface TranscriptHandle {
  stat(): Promise<Stats>;
  read(buffer: Buffer, offset: number, length: number, position: number): Promise<{ bytesRead: number }>;
  close(): Promise<void>;
  /** The same calls on the event loop, if the handle has them (used on a local filesystem only). */
  readNow?(buffer: Buffer, offset: number, length: number, position: number): number;
  statNow?(): Stats;
}
/** A handle whose calls also run on the event loop, for a transcript on a local filesystem. */
export interface TranscriptHandleNow extends TranscriptHandle {
  readNow(buffer: Buffer, offset: number, length: number, position: number): number;
  statNow(): Stats;
}
const hasNow = (handle: TranscriptHandle): handle is TranscriptHandleNow => handle.readNow !== undefined && handle.statNow !== undefined;
export interface TranscriptIO {
  open(path: string): Promise<TranscriptHandle>;
  stat(path: string): Promise<Stats>;
  /**
   * Whether `directory` is on a local filesystem, where a read the page cache answers costs less
   * on the event loop than a round trip through the thread pool, and its device: a transcript on
   * another device (a file mounted into the directory) is not known to be local. Left out: every
   * read is async.
   */
  filesystem?(directory: string): Promise<{ local: boolean; dev: number }>;
  openNow?(path: string): TranscriptHandleNow;
  statNow?(path: string): Stats;
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
  stat: (path) => lstat(path),
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
        // the same descriptor through the thread pool, once a read on the event loop was slow
        read: (buffer, offset, length, position) => new Promise((resolve, reject) => read(fd, buffer, offset, length, position, (error, bytesRead) => error ? reject(error) : resolve({ bytesRead }))),
        stat: () => new Promise((resolve, reject) => fstat(fd, (error, stats) => error ? reject(error) : resolve(stats))),
        close: async () => closeSync(fd),
      };
    },
    statNow: (path: string) => lstatSync(path),
  } : {}),
};
const WINDOW_BYTES = 1024 * 1024;
/** A call on the event loop slower than this was answered by the disk, not the page cache. */
const SLOW_MS = 2;
/** After one (or a call that threw), a transcript's reads go through the thread pool this long; the first lease after tries again. */
const SLOW_FOR_MS = 1000;
/** How long a directory's filesystem is taken as known. */
const FILESYSTEM_MS = 60_000;

export interface TranscriptFile {
  /** Identity already checked when this handle was opened, without another metadata round trip. */
  readonly initial: TranscriptVersion;
  stat(): Promise<TranscriptVersion>;
  pathVersion(): Promise<TranscriptVersion | null>;
  /** Owned bytes, at an explicit position, at most one MiB. Short reads are completed up to EOF. */
  read(position: number, length: number): Promise<Buffer>;
  /** The same bytes in a buffer the lease keeps for them, so no window is allocated: they hold only until the next `window` or the lease's end. */
  window(position: number, length: number): Promise<Buffer>;
  /**
   * Starts reading the window a later `window(position, length)` will ask for, into the lease's
   * other buffer, so the read goes on while the lease awaits its other operations (a stat). The
   * bytes the last `window` returned stay as they are. A `window` that asks for anything else
   * waits for this read to settle first, and one read ahead at a time is kept.
   */
  ahead(position: number, length: number): void;
  /**
   * Whether the event loop ran other work while the last call waited (it went through the thread
   * pool). Before the work's first call: whether the lease waited for its turn in the reader, or
   * reads through the thread pool. False while calls are answered on the event loop: then nothing
   * else ran since the work's caller last let the loop go.
   */
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
 * One main-process reader. A lease owns its path, handle and native-operation allowance until
 * close actually settles. Cancellation ends only the caller's wait. Native async FS uses Bun's
 * shared runtime pool; this bound does not reserve runtime capacity or interrupt a stuck syscall.
 * A lease has at most two native operations in flight, the one it awaits and a read ahead, so the
 * reader has at most twice its capacity of them.
 *
 * On a local Linux filesystem (LOCAL) a lease opens, stats, reads and closes on the event loop
 * instead, with no read ahead, while each call is fast. A lease that has to look up its
 * directory's filesystem (once a minute) opens through the thread pool meanwhile. The first slower than SLOW_MS sends the
 * rest of the lease through the thread pool, and the transcript's leases for SLOW_FOR_MS. Every
 * other filesystem and platform reads through the thread pool only.
 *
 * Known limits:
 * - A local disk that stops answering inside a call on the event loop blocks the loop, as a
 *   synchronous read would. The fallback notices a slow call only once it returns.
 * - A native operation that never settles (a read ahead or any other) keeps its lease, so two of
 *   them on two paths keep every lease, and every later read waits out its deadline.
 * - A cancelled lease keeps its path too, until its operations settle: a new read of that
 *   transcript waits behind it.
 */
export class TranscriptReader {
  private readonly queue: Request[] = [];
  private readonly active = new Set<Request>();
  private readonly paths = new Set<string>();
  private resetting = false;
  private readonly idle = new Set<() => void>();
  /** `window` buffers of leases that ended, every native operation on them settled */
  private readonly spare: Buffer[] = [];
  /** Directories known to be on a local filesystem (with its device) or not (null), until a time */
  private readonly filesystems = new Map<string, { dev: number | null; until: number }>();
  /** Transcripts whose reads go through the thread pool until a time: one on the event loop was slow */
  private readonly slow = new Map<string, number>();
  /** The request `read` is admitting: a lease it starts at once waited for nothing. */
  private admitting: Request | null = null;
  constructor(private readonly io: TranscriptIO = nativeIO, readonly capacity = 2, private readonly waiting = 32) {}

  read<T>(path: string, work: (file: TranscriptFile) => Promise<T>, options: { signal?: AbortSignal; deadline?: number } = {}): Promise<T> {
    const { signal, deadline } = options;
    if (signal?.aborted || (deadline !== undefined && deadline <= Date.now())) return Promise.reject(new TranscriptBusyError("the transcript read was cancelled"));
    if (this.queue.length >= this.waiting && (this.active.size >= this.capacity || this.paths.has(path))) return Promise.reject(new TranscriptBusyError());
    return new Promise<T>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const cleanup = () => { signal?.removeEventListener("abort", request.cancel); clearTimeout(timer); };
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
          const immediate = this.admitting === request;
          let handle: Awaited<ReturnType<TranscriptIO["open"]>> | undefined;
          // the handle was opened on the event loop, and closes there
          let closeNow = false;
          const operations = new Set<Promise<unknown>>();
          let accepting = true;
          let value: T | undefined;
          let error: unknown;
          let failed = false;
          // the buffer the last window was returned in, and the one a read ahead fills
          let front: Buffer | undefined;
          let back: Buffer | undefined;
          let readAhead: { position: number; length: number; bytes: Promise<Buffer> } | null = null;
          try {
            // on a local filesystem the transcript is read on the event loop while the page cache
            // answers: a call through the thread pool costs a wake of its thread, a copy on another
            // core and a wake of the event loop, more than the read itself
            const near = this.near(path);
            let direct: TranscriptHandleNow | null = null;
            // the device of the directory's local filesystem: a transcript on another goes through the thread pool
            let device: number | null;
            let slowOpen = false;
            if (!(near instanceof Promise)) {
              device = near;
              if (device !== null) {
                // an open on the event loop is timed like any call there: slow, or one that throws,
                // and the transcript goes through the thread pool
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
            // reads on the event loop until one is slow or throws: then through the thread pool, for the rest of the lease
            let now = direct !== null && !slowOpen;
            let waited = true;
            const timed = <V>(call: (direct: TranscriptHandleNow) => V): Promise<V> => {
              try {
                current();
                if (!accepting) throw new Error("the transcript lease is closed");
                const started = performance.now();
                let value: V;
                try { value = call(direct!); } catch (caught) { now = false; this.slowed(path); throw caught; }
                waited = false;
                if (performance.now() - started > SLOW_MS) { now = false; this.slowed(path); }
                current();
                return Promise.resolve(value);
              } catch (caught) { return Promise.reject(caught); }
            };
            // a read ahead (`beside`) runs next to the one operation the work awaits at a time
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
            // a window read whole (short reads completed, up to EOF)
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
            // the same on the event loop
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
              pathVersion: () => now ? timed(() => transcriptVersion(this.io.statNow!(path))) : operation(async () => {
                current();
                const version = transcriptVersion(await this.io.stat(path));
                current();
                return version;
              }),
              read: (position, length) => now ? timed((direct) => fillNow(direct, position, length, Buffer.allocUnsafe(length)))
                : operation(() => fill(position, length, Buffer.allocUnsafe(length))),
              // no read ahead is started while reads are on the event loop
              window: (position, length) => now ? timed((direct) => fillNow(direct, position, length, front ??= spareWindow())) : operation(async () => {
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
                // a read ahead nobody asks for is let go of: its failure is no failure of the lease
                bytes.catch(() => {});
                readAhead = { position, length, bytes };
              },
              waited: () => waited,
            };
            const before = await file.stat();
            initial = before;
            const named = await file.pathVersion();
            if (named === null || named.id !== before.id) throw new Error("the transcript was replaced");
            // a lease let in at once that reads on the event loop: the loop has not run anything else
            // since `read` was called (a lookup or open it waited for is no wait for the storage)
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
              // a close on the event loop is timed too: slow, or one that throws, and the transcript goes through the thread pool
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
      if (deadline !== undefined) { timer = setTimeout(request.cancel, Math.max(0, deadline - Date.now())); timer.unref?.(); }
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

  /**
   * Whether `path` is read on the event loop: the device of its directory's local filesystem
   * (known, or found out), which the transcript has to be on too; null for the thread pool (another
   * filesystem, or a call on it slow lately).
   */
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
  /** `path` is read through the thread pool for `ms`: a call on the event loop was slow or threw, or it is on another device than its directory. */
  private slowed(path: string, ms = SLOW_FOR_MS): void {
    if (this.slow.size >= 256) this.slow.clear();
    this.slow.set(path, Date.now() + ms);
  }

  reset(): void {
    // a lease still open puts its buffer back once it ends
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

/** The server's one reader. */
export const transcriptReader = new TranscriptReader();
