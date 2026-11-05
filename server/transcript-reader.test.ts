import { afterEach, expect, it, setSystemTime, spyOn } from "bun:test";
import * as fs from "node:fs";
import { mkdtempSync, renameSync, rmSync, writeFileSync, type Stats } from "node:fs";
import * as fsp from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { transcriptVersion, TranscriptBusyError, TranscriptReader, type TranscriptHandle, type TranscriptIO } from "./transcript-reader.ts";

const roots: string[] = [];
const restores: (() => void)[] = [];
afterEach(() => {
  for (const restore of restores.splice(0).reverse()) restore();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const deferred = <T = void>() => {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const stat = { dev: 1, ino: 2, size: 4, mtimeMs: 1, isFile: () => true } as Stats;
function backend() {
  const opened: string[] = [], closed: string[] = [], reads: string[] = [];
  const opening = new Map<string, ReturnType<typeof deferred<void>>>();
  const reading = new Map<string, ReturnType<typeof deferred<void>>>();
  const closing = new Map<string, ReturnType<typeof deferred<void>>>();
  const io: TranscriptIO = {
    async stat() { return stat; },
    async open(path) {
      opened.push(path);
      await opening.get(path)?.promise;
      return {
        async stat() { return stat; },
        async read(buffer, offset, length, position) {
          reads.push(path);
          await reading.get(path)?.promise;
          const value = Buffer.from("abcd").subarray(position, position + length);
          value.copy(buffer, offset);
          return { bytesRead: value.length };
        },
        async close() { closed.push(path); await closing.get(path)?.promise; },
      };
    },
  };
  return { io, opened, closed, reads, opening, reading, closing };
}

it("bounds physical work and lets a healthy path pass one held path", async () => {
  const b = backend(); const reader = new TranscriptReader(b.io);
  const held = deferred(); b.reading.set("held", held);
  const first = reader.read("held", (file) => file.read(0, 4));
  await tick();
  expect(await reader.read("healthy", (file) => file.read(1, 2))).toEqual(Buffer.from("bc"));
  const second = reader.read("held", (file) => file.read(0, 1));
  await tick();
  expect(b.opened).toEqual(["held", "healthy"]);
  expect(reader.size()).toEqual({ active: 1, waiting: 1, paths: 1 });
  held.resolve();
  expect(await first).toEqual(Buffer.from("abcd"));
  expect(await second).toEqual(Buffer.from("a"));
  expect(reader.size().active).toBe(0);
});

it("admits an immediately runnable healthy path when one held path fills the metadata queue", async () => {
  const b = backend(); const reader = new TranscriptReader(b.io, 2, 2);
  const gate = deferred(); b.reading.set("held", gate);
  const first = reader.read("held", (file) => file.read(0, 4));
  const queued = [reader.read("held", (file) => file.read(0, 1)), reader.read("held", (file) => file.read(0, 1))];
  await expect(reader.read("held", (file) => file.read(0, 1))).rejects.toBeInstanceOf(TranscriptBusyError);
  expect(await reader.read("healthy", (file) => file.read(1, 2))).toEqual(Buffer.from("bc"));
  expect(reader.size()).toEqual({ active: 1, waiting: 2, paths: 1 });
  expect(b.opened).toEqual(["held", "healthy"]);
  gate.resolve(); await first; await Promise.all(queued);
});

it("retains both physical leases through cancellation, reset and pending close", async () => {
  const b = backend(); const reader = new TranscriptReader(b.io, 2, 2);
  const gate = deferred(), close = deferred();
  b.reading.set("a", gate); b.reading.set("b", gate); b.closing.set("a", close);
  const a = reader.read("a", (file) => file.read(0, 4)).catch((e) => e);
  const bb = reader.read("b", (file) => file.read(0, 4)).catch((e) => e);
  await tick(); reader.reset();
  expect(await a).toBeInstanceOf(TranscriptBusyError); expect(await bb).toBeInstanceOf(TranscriptBusyError);
  const next = reader.read("a", (file) => file.read(0, 4));
  const healthy = reader.read("c", (file) => file.read(0, 4));
  await expect(reader.read("d", (file) => file.read(0, 4))).rejects.toBeInstanceOf(TranscriptBusyError);
  expect(b.opened).toEqual(["a", "b"]);
  gate.resolve();
  expect(await healthy).toEqual(Buffer.from("abcd"));
  expect(b.opened).toEqual(["a", "b", "c"]);
  expect(reader.size()).toEqual({ active: 1, waiting: 1, paths: 1 });
  close.resolve();
  expect(await next).toEqual(Buffer.from("abcd"));
  expect(b.opened).toEqual(["a", "b", "c", "a"]);
});

it("closes a late open after abort without starting a read or admitting its replacement", async () => {
  const b = backend(); const reader = new TranscriptReader(b.io, 1);
  const gate = deferred(), close = deferred(); b.opening.set("a", gate); b.closing.set("a", close);
  const abort = new AbortController();
  const first = reader.read("a", (file) => file.read(0, 4), { signal: abort.signal }).catch((e) => e);
  abort.abort(); expect(await first).toBeInstanceOf(TranscriptBusyError);
  const next = reader.read("b", (file) => file.read(0, 4));
  gate.resolve(); await tick();
  expect(b.closed).toEqual(["a"]); expect(b.reads).toEqual([]); expect(b.opened).toEqual(["a"]);
  close.resolve(); expect(await next).toEqual(Buffer.from("abcd"));
});

it("never opens cancelled queued work and bounds a wait by its deadline", async () => {
  const b = backend(); const reader = new TranscriptReader(b.io, 1);
  const gate = deferred(); b.reading.set("a", gate);
  const first = reader.read("a", (file) => file.read(0, 4));
  const abort = new AbortController();
  const queued = reader.read("b", (file) => file.read(0, 4), { signal: abort.signal }).catch((e) => e);
  abort.abort(); expect(await queued).toBeInstanceOf(TranscriptBusyError);
  await expect(reader.read("c", (file) => file.read(0, 4), { deadline: Date.now() + 10 })).rejects.toBeInstanceOf(TranscriptBusyError);
  expect(b.opened).toEqual(["a"]); gate.resolve(); await first;
});

it.each(["open", "stat", "read", "close"] as const)("releases a settled %s failure and serves the next path", async (method) => {
  const b = backend(); const base = b.io.open;
  b.io.open = async (path) => {
    if (path === "bad" && method === "open") throw new Error("synthetic open");
    const handle = await base(path);
    if (path === "bad") (handle[method as keyof TranscriptHandle] as unknown) = async () => { throw new Error(`synthetic ${method}`); };
    return handle;
  };
  const reader = new TranscriptReader(b.io, 1);
  await expect(reader.read("bad", (file) => file.read(0, 4))).rejects.toThrow(`synthetic ${method}`);
  expect(await reader.read("good", (file) => file.read(0, 4))).toEqual(Buffer.from("abcd"));
  expect(reader.size().active).toBe(0);
});

it("reads owned explicit-position windows and identifies replacement after the lease closes", async () => {
  const root = mkdtempSync(join(tmpdir(), "ovis-transcript-reader-")); roots.push(root);
  const path = join(root, "session.jsonl"), next = join(root, "replacement");
  writeFileSync(path, "first line\nsecond line\n"); writeFileSync(next, "replacement\n");
  const reader = new TranscriptReader();
  const before = await reader.read(path, async (file) => {
    const before = await file.stat();
    const second = await file.read(11, 12);
    expect(second.toString()).toBe("second line\n");
    expect((await file.read(0, 5)).toString()).toBe("first");
    expect(second.toString()).toBe("second line\n");
    expect((await file.pathVersion())!.id).toBe(before.id);
    expect((await file.read(0, 5)).toString()).toBe("first");
    return before;
  });
  // Windows may reject replacement of an open destination. Native replacement is tested
  // after actual close; the deterministic test below changes named identity during a lease.
  renameSync(next, path);
  expect((await reader.read(path, async (file) => file.initial)).id).not.toBe(before.id);
  expect(await reader.read(path, (file) => file.read(0, 100))).toEqual(Buffer.from("replacement\n"));
});

it("keeps pinned bytes distinct from a changed named identity and rejects mismatched admission", async () => {
  const b = backend(); const reader = new TranscriptReader(b.io);
  const replacement = { ...stat, ino: 3 } as Stats;
  let named = stat;
  b.io.stat = async () => named;
  await reader.read("file", async (file) => {
    const before = file.initial;
    expect((await file.read(0, 4)).toString()).toBe("abcd");
    named = replacement;
    expect((await file.pathVersion())!.id).not.toBe(before.id);
    expect((await file.stat()).id).toBe(before.id);
    expect((await file.read(1, 2)).toString()).toBe("bc");
  });
  let called = false;
  await expect(reader.read("file", async () => { called = true; })).rejects.toThrow("the transcript was replaced");
  expect(called).toBe(false);
  expect(b.closed).toEqual(["file", "file"]);
  expect(reader.size()).toEqual({ active: 0, waiting: 0, paths: 0 });
});

it("exposes the metadata checked at admission without another stat", async () => {
  const b = backend(); let metadata = 0, fdStats = 0;
  const base = b.io.open;
  b.io.stat = async () => { metadata++; return stat; };
  b.io.open = async (path) => { const handle = await base(path); return { ...handle, stat: async () => { fdStats++; return stat; } }; };
  const reader = new TranscriptReader(b.io);
  await reader.read("file", async (file) => { expect(file.initial).toEqual(transcriptVersion(stat)!); return file.read(0, 4); });
  expect(fdStats).toBe(1); expect(metadata).toBe(1); expect(b.closed).toEqual(["file"]);
});

it("enforces the absolute deadline before a late callback can publish ahead of its timer", async () => {
  const b = backend(); const reader = new TranscriptReader(b.io);
  const now = Date.now(), deadline = now + 10;
  restores.push(() => setSystemTime());
  setSystemTime(new Date(now));
  await expect(reader.read("a", async () => {
    // the clock passes the deadline within the callback's turn: the timer has not run when it returns
    setSystemTime(new Date(deadline + 1));
    return "late";
  }, { deadline })).rejects.toBeInstanceOf(TranscriptBusyError);
  await reader.settled(); expect(b.closed).toEqual(["a"]);
});


it("rejects an undefined callback error rather than publishing undefined success", async () => {
  const b = backend(); const reader = new TranscriptReader(b.io); let rejected = false;
  await reader.read("a", async () => { throw undefined; }).then(() => { throw new Error("undefined failure was published"); }, (error) => { rejected = true; expect(error).toBeUndefined(); });
  expect(rejected).toBe(true); expect(b.closed).toEqual(["a"]);
});

it("checks the absolute deadline after a pending close settles before the timer can run", async () => {
  const b = backend(); const reader = new TranscriptReader(b.io); const gate = deferred(); b.closing.set("a", gate);
  const now = Date.now(), deadline = now + 10;
  restores.push(() => setSystemTime());
  setSystemTime(new Date(now));
  const pending = reader.read("a", async () => "late", { deadline });
  await tick(); expect(b.closed).toEqual(["a"]);
  // the clock passes the deadline while the close is pending, before its timer runs
  setSystemTime(new Date(deadline + 1));
  gate.resolve(); await expect(pending).rejects.toBeInstanceOf(TranscriptBusyError);
  expect(reader.size().active).toBe(0);
});


it("hands a window's buffer to another lease only once every read into it has settled", async () => {
  const b = backend(); const reader = new TranscriptReader(b.io);
  const buffers: ArrayBufferLike[] = [];
  const base = b.io.open;
  b.io.open = async (path) => { const handle = await base(path); return { ...handle, read: (buffer, ...rest) => { buffers.push(buffer.buffer); return handle.read(buffer, ...rest); } }; };
  const held = deferred(); b.reading.set("held", held);
  const abort = new AbortController();
  const cancelled = reader.read("held", (file) => file.window(0, 4), { signal: abort.signal }).catch((e) => e);
  await tick(); abort.abort();
  expect(await cancelled).toBeInstanceOf(TranscriptBusyError);
  // the cancelled lease's read may still write into its buffer: the next lease gets another
  expect(await reader.read("next", async (file) => (await file.window(1, 2)).toString())).toBe("bc");
  expect(buffers[1]).not.toBe(buffers[0]);
  held.resolve(); await reader.settled();
  await reader.read("last", (file) => file.window(0, 4));
  expect([buffers[0], buffers[1]]).toContain(buffers[2]);
  // a reset lets the spare buffers go
  reader.reset();
  await reader.read("after", (file) => file.window(0, 4));
  expect(buffers.slice(0, 3)).not.toContain(buffers[3]);
});

it("never keeps the process alive for a read's deadline alone", async () => {
  const b = backend(); const reader = new TranscriptReader(b.io);
  const timers = spyOn(globalThis, "setTimeout");
  try {
    // looked at while the read goes on: once it settles, its timer is cleared
    const kept = await reader.read("a", async () => (timers.mock.results.at(-1)!.value as ReturnType<typeof setTimeout>).hasRef(), { deadline: Date.now() + 60_000 });
    expect(timers).toHaveBeenCalled();
    expect(kept).toBe(false);
  } finally { timers.mockRestore(); }
});

/** A backend whose reads at `held` positions wait for that position's gate; `log` has each read's start and end. */
function heldReads(held: Map<number, Promise<void>>) {
  const b = backend(); const base = b.io.open;
  const log: string[] = [], buffers: ArrayBufferLike[] = [];
  b.io.open = async (path) => {
    const handle = await base(path);
    return { ...handle, read: async (buffer, offset, length, position) => {
      log.push(`read ${position}`); buffers.push(buffer.buffer);
      await held.get(position);
      const result = await handle.read(buffer, offset, length, position);
      log.push(`done ${position}`);
      return result;
    } };
  };
  return { ...b, log, buffers };
}

it("reads ahead while the lease awaits a stat, and hands the bytes to the window that asks for them", async () => {
  const gate = deferred(); const b = heldReads(new Map([[2, gate.promise]])); const reader = new TranscriptReader(b.io);
  await reader.read("file", async (file) => {
    const first = await file.window(0, 2);
    file.ahead(2, 2);
    // the stat is answered while the read ahead is still on its way
    await file.stat();
    expect(b.log).toEqual(["read 0", "done 0", "read 2"]);
    gate.resolve(); await tick();
    // filled in the lease's other buffer: the last window's bytes are as they were
    expect(b.log).toEqual(["read 0", "done 0", "read 2", "done 2"]);
    expect(first.toString()).toBe("ab");
    const second = await file.window(2, 2);
    expect(second.toString()).toBe("cd");
    // the next read ahead fills the buffer the first window was in, not this one
    file.ahead(0, 2);
    await file.stat(); await tick();
    expect(b.log.at(-1)).toBe("done 0");
    expect(second.toString()).toBe("cd");
  });
  // the window read ahead is not read again
  expect(b.reads).toEqual(["file", "file", "file"]);
  expect(b.buffers[1]).not.toBe(b.buffers[0]);
});

it("lets a read ahead settle before a window that asks for other bytes", async () => {
  const gate = deferred(); const b = heldReads(new Map([[2, gate.promise]])); const reader = new TranscriptReader(b.io);
  await reader.read("file", async (file) => {
    await file.window(0, 2);
    file.ahead(2, 2);
    const other = file.window(1, 2);
    await tick();
    // its read waits: the buffer it reads into may be the one the read ahead fills next time
    expect(b.log).toEqual(["read 0", "done 0", "read 2"]);
    gate.resolve();
    expect((await other).toString()).toBe("bc");
    expect(b.log).toEqual(["read 0", "done 0", "read 2", "done 2", "read 1", "done 1"]);
  });
});

it("closes a lease and gives its buffers to another only once a read ahead nobody asked for settled", async () => {
  const gate = deferred(); const b = heldReads(new Map([[2, gate.promise]])); const reader = new TranscriptReader(b.io);
  const pending = reader.read("file", async (file) => { await file.window(0, 2); file.ahead(2, 2); return "done"; });
  await tick(); await tick();
  expect(b.closed).toEqual([]);
  // a lease that starts meanwhile reads into a buffer of its own
  await reader.read("other", (file) => file.window(0, 4));
  expect(b.buffers.slice(0, 2)).not.toContain(b.buffers[2]);
  gate.resolve();
  expect(await pending).toBe("done");
  expect(b.closed).toEqual(["other", "file"]);
  await reader.read("last", (file) => file.window(0, 4));
  expect(b.buffers.slice(0, 2)).toContain(b.buffers[3]!);
});

it("ends a cancelled lease's read ahead without an unhandled rejection", async () => {
  const gate = deferred(); const b = heldReads(new Map([[2, gate.promise]])); const reader = new TranscriptReader(b.io);
  const unhandled: unknown[] = [];
  const hear = (error: unknown) => { unhandled.push(error); };
  process.on("unhandledRejection", hear);
  try {
    const abort = new AbortController();
    const pending = reader.read("file", async (file) => { await file.window(0, 2); file.ahead(2, 2); }, { signal: abort.signal }).catch((e) => e);
    await tick(); await tick();
    abort.abort();
    expect(await pending).toBeInstanceOf(TranscriptBusyError);
    gate.resolve(); await reader.settled(); await tick();
    expect(b.closed).toEqual(["file"]);
    expect(unhandled).toEqual([]);
  } finally { process.off("unhandledRejection", hear); }
});

/**
 * A synthetic transcript of `bytes` whose directory's filesystem is of `type` (statfs f_type),
 * known once `known` settles.
 */
function onFilesystem(type: number, bytes = "abcdefgh\n", known: Promise<void> = Promise.resolve()) {
  const root = mkdtempSync(join(tmpdir(), "ovis-transcript-reader-")); roots.push(root);
  const path = join(root, "session.jsonl");
  writeFileSync(path, bytes);
  const real = fsp.statfs;
  const statfs = spyOn(fsp, "statfs").mockImplementation((async (directory: string) => { await known; return { ...(await real(directory)), type }; }) as typeof real);
  restores.push(() => statfs.mockRestore());
  return path;
}
/**
 * A clock (performance.now) that moves only as the test moves it, so a call preempted on a busy
 * host takes no time on it. Returns the move.
 */
function stillClock() {
  const base = performance.now();
  let moved = 0;
  const spy = spyOn(performance, "now").mockImplementation(() => base + moved);
  restores.push(() => spy.mockRestore());
  return (ms: number) => { moved += ms; };
}
/** Counts the transcripts opened through the thread pool. */
function opensAsync() {
  const real = fsp.open;
  let count = 0;
  const spy = spyOn(fsp, "open").mockImplementation(((...args: Parameters<typeof real>) => { count++; return real(...args); }) as typeof real);
  restores.push(() => spy.mockRestore());
  return () => count;
}
/** Counts the reads made on the event loop. */
function readsNow(during: (count: number) => void = () => {}) {
  const real = fs.readSync;
  let count = 0;
  const spy = spyOn(fs, "readSync").mockImplementation(((...args: Parameters<typeof real>) => { count++; during(count); return real(...args); }) as typeof real);
  restores.push(() => spy.mockRestore());
  return () => count;
}

it.skipIf(process.platform !== "linux")("reads a transcript on a local filesystem on the event loop, and one on any other through the thread pool", async () => {
  // btrfs, ext4 and tmpfs; NFS, FUSE (sshfs) and 9p (WSL's Windows drives)
  for (const [type, local] of [[0x9123683e, true], [0xef53, true], [0x01021994, true], [0x6969, false], [0x65735546, false], [0x01021997, false]] as const) {
    const path = onFilesystem(type);
    stillClock();
    const now = readsNow();
    const reader = new TranscriptReader();
    expect((await reader.read(path, async (file) => { await file.stat(); return file.window(2, 4); })).toString()).toBe("cdef");
    expect(now() > 0).toBe(local);
    for (const restore of restores.splice(0).reverse()) restore();
  }
});

it.skipIf(process.platform !== "linux")("reads through the thread pool for a second once a read on the event loop was slow, then tries the event loop again", async () => {
  const path = onFilesystem(0x9123683e);
  // the first read on the event loop takes 3 ms of the clock: the disk answered it, not the page cache
  const advance = stillClock();
  const reads = readsNow((count) => { if (count === 1) advance(3); });
  const reader = new TranscriptReader();
  const read = (from: number) => reader.read(path, async (file) => (await file.window(from, 2)).toString() + (await file.window(from + 2, 2)).toString());
  // the rest of that lease, and the next lease within the second, through the thread pool
  expect(await read(0)).toBe("abcd");
  expect(await read(2)).toBe("cdef");
  expect(reads()).toBe(1);
  // a second later, the first lease tries the event loop again
  const later = Date.now() + 1000;
  restores.push(() => setSystemTime());
  setSystemTime(new Date(later));
  expect(await read(4)).toBe("efgh");
  expect(reads()).toBe(3);
});

it.skipIf(process.platform !== "linux")("gives up a read on the event loop between windows once cancelled", async () => {
  const path = onFilesystem(0x9123683e);
  stillClock();
  const now = readsNow();
  const reader = new TranscriptReader();
  const abort = new AbortController();
  let windows = 0;
  const read = reader.read(path, async (file) => {
    // a parser that reads on and on, never waiting for anything but its reads
    while (windows < 100) { await file.window(0, 4); if (++windows === 3) abort.abort(); }
    return "read on past the cancel";
  }, { signal: abort.signal }).catch((error) => error);
  expect(await read).toBeInstanceOf(TranscriptBusyError);
  await reader.settled();
  // the lease ended at the next window, before its read: no window was read after the cancel
  expect(windows).toBe(3);
  expect(now()).toBe(3);
  expect(reader.size()).toEqual({ active: 0, waiting: 0, paths: 0 });
});

it.skipIf(process.platform !== "linux")("opens a transcript while its filesystem is looked up, and reads it on the event loop once that says local", async () => {
  // a lookup as slow as one on a network filesystem (several round trips)
  const lookup = deferred();
  const path = onFilesystem(0x9123683e, "abcdefgh\n", lookup.promise);
  stillClock();
  const opens = opensAsync();
  const now = readsNow();
  const reader = new TranscriptReader();
  const read = reader.read(path, async (file) => (await file.window(0, 4)).toString());
  // the open is not held back for the lookup
  for (let turn = 0; turn < 100 && opens() === 0; turn++) await tick();
  expect(opens()).toBe(1);
  expect(now()).toBe(0);
  lookup.resolve();
  expect(await read).toBe("abcd");
  // the lease that opened through the thread pool reads on the event loop once its filesystem is known to be local
  expect(now()).toBe(1);
});

it.skipIf(process.platform !== "linux")("tells the work whether the event loop ran while the lease waited", async () => {
  // let in at once on a local filesystem: nothing waited, before a call or after one
  const local = onFilesystem(0x9123683e);
  stillClock();
  readsNow();
  const reader = new TranscriptReader(undefined, 1);
  expect(await reader.read(local, async (file) => [file.waited(), (await file.window(0, 4), file.waited())])).toEqual([false, false]);
  // let in after another lease ended: it waited for its turn, though its calls do not
  const held = deferred();
  const first = reader.read(local, async () => { await held.promise; });
  const second = reader.read(local, async (file) => [file.waited(), (await file.window(0, 4), file.waited())]);
  held.resolve();
  await first;
  expect(await second).toEqual([true, false]);
  for (const restore of restores.splice(0).reverse()) restore();
  // on a network filesystem every call goes through the thread pool
  const network = onFilesystem(0x6969);
  stillClock();
  expect(await new TranscriptReader().read(network, async (file) => [file.waited(), (await file.window(0, 4), file.waited())])).toEqual([true, true]);
  for (const restore of restores.splice(0).reverse()) restore();
  // a read on the event loop the disk answered (3 ms of the clock): the calls after it go through the thread pool
  const slow = onFilesystem(0x9123683e);
  const advance = stillClock();
  readsNow(() => advance(3));
  expect(await new TranscriptReader().read(slow, async (file) => [(await file.window(0, 4), file.waited()), (await file.stat(), file.waited())])).toEqual([false, true]);
});

/** Takes `ms` of the clock in each call to `name` (on the event loop), or throws once `fails` is set. */
function slowCalls(name: "openSync" | "closeSync", advance: (ms: number) => void) {
  const real = (fs as any)[name] as (...args: unknown[]) => unknown;
  const state = { ms: 0, fails: false };
  const fail = () => { state.fails = false; return Object.assign(new Error(`${name} failed`), { code: "EIO" }); };
  const spy = spyOn(fs, name).mockImplementation(((...args: unknown[]) => {
    advance(state.ms);
    // an open that fails opens nothing; a close that fails has closed the descriptor all the same
    if (state.fails && name === "openSync") throw fail();
    const value = real(...args);
    if (state.fails) throw fail();
    return value;
  }) as any);
  restores.push(() => spy.mockRestore());
  return state;
}

for (const name of ["openSync", "closeSync"] as const) {
  it.skipIf(process.platform !== "linux")(`reads through the thread pool for a second once ${name === "openSync" ? "an open" : "a close"} on the event loop was slow or threw`, async () => {
    const path = onFilesystem(0x9123683e);
    const advance = stillClock();
    const calls = slowCalls(name, advance);
    const opens = opensAsync();
    const reads = readsNow();
    const reader = new TranscriptReader();
    const read = () => reader.read(path, async (file) => (await file.window(0, 4)).toString());
    // the first lease looks the filesystem up, and opens through the thread pool meanwhile
    expect(await read()).toBe("abcd");
    expect([opens(), reads()]).toEqual([1, 1]);
    // the next opens and closes on the event loop
    expect(await read()).toBe("abcd");
    expect([opens(), reads()]).toEqual([1, 2]);
    // one that takes 3 ms of the clock: the disk answered it, not the page cache
    calls.ms = 3;
    expect(await read()).toBe("abcd");
    calls.ms = 0;
    // after a slow open, the rest of that lease went through the thread pool
    if (name === "openSync") expect(reads()).toBe(2);
    // the next lease, within the second, goes through the thread pool
    expect(await read()).toBe("abcd");
    expect(opens()).toBe(2);
    // a second later the event loop again, and a call there that throws
    restores.push(() => setSystemTime());
    setSystemTime(new Date(Date.now() + 1000));
    calls.fails = true;
    await read().then(() => {}, () => {});
    expect(opens()).toBe(2);
    expect(await read()).toBe("abcd");
    expect(opens()).toBe(3);
  });
}

it.skipIf(process.platform !== "linux")("reads a transcript on another device than its local directory through the thread pool", async () => {
  // a file mounted into the directory from another filesystem (NFS, say): its device is not the directory's
  const path = onFilesystem(0x9123683e);
  const real = fsp.stat;
  const other = spyOn(fsp, "stat").mockImplementation((async (...args: Parameters<typeof real>) => {
    const found = await real(...args);
    return Object.assign(Object.create(Object.getPrototypeOf(found)), found, { dev: Number(found.dev) + 1 });
  }) as typeof real);
  restores.push(() => other.mockRestore());
  stillClock();
  const opens = opensAsync();
  const reads = readsNow();
  const reader = new TranscriptReader();
  const read = () => reader.read(path, async (file) => (await file.window(0, 4)).toString());
  // its first stat, before any read, finds the other device: the read goes through the thread pool
  expect(await read()).toBe("abcd");
  expect(reads()).toBe(0);
  // and so does the next lease's, open included
  expect(await read()).toBe("abcd");
  expect([opens(), reads()]).toEqual([2, 0]);
});

it.skipIf(process.platform !== "linux")("reads through the thread pool for a second once a read on the event loop threw", async () => {
  const path = onFilesystem(0x9123683e);
  stillClock();
  const opens = opensAsync();
  const real = fs.readSync;
  let fails = true;
  const reads = spyOn(fs, "readSync").mockImplementation(((...args: Parameters<typeof real>) => {
    if (fails) { fails = false; throw Object.assign(new Error("readSync failed"), { code: "EIO" }); }
    return real(...args);
  }) as typeof real);
  restores.push(() => reads.mockRestore());
  const reader = new TranscriptReader();
  const read = () => reader.read(path, async (file) => (await file.window(0, 4)).toString());
  await expect(read()).rejects.toThrow("readSync failed");
  // the next lease, within the second, opens and reads through the thread pool
  expect(await read()).toBe("abcd");
  expect([opens(), reads.mock.calls.length]).toEqual([2, 1]);
});
