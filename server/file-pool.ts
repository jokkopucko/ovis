import { closeSync } from "node:fs";

import type { FileTask, FileTaskResult } from "./file-tasks.ts";

/**
 * The threads the file routes read the filesystem on (#790): a file's type and size, a folder's
 * names, a page rendered with its own files put into it, a file opened to stream. Each of those
 * calls is synchronous and may wait on the disk for as long as the disk takes (a network share
 * that stalls, a page of tens of megabytes), so each runs on one of a few worker threads
 * (`file-worker.ts`), never on the thread that answers every other request and terminal.
 *
 * At most `workers` threads, each with one task at a time, and at most `waiting` tasks waiting
 * for one; past that a task is refused at once (`FileBusyError`, which the routes answer with 503).
 * A task not answered within its deadline (waiting included) is refused the same way, but the
 * thread it ran on stays taken until the call it is in returns: a thread cannot be stopped inside
 * a system call, and only a thread that answered is known to be free. What that late answer
 * opened is closed, never handed out.
 */

/** What a task may take, waiting for a thread included, before its request is answered 503. */
export const FILE_TASK_DEADLINE_MS = 3_000;
/**
 * A task of many calls rather than one: a page rendered with its own files (work for the processor
 * too), a folder walked for a name (up to its 5,000 entries, each a call to a disk that may be
 * slow), a Claude task list scanned from its agent session's history, an Agy catalog copied (up to
 * 64 MiB), or a Letta transcript scanned for one call's output (up to 256 MiB). It may take longer.
 */
export const FILE_LONG_TASK_DEADLINE_MS = 15_000;
/**
 * An agent's commands scanned (`commands`, #2254): every skill and command folder it reads, which on
 * a slow mount took 10-27 s, and may take minutes on a slower one. Each request waits for it only
 * `COMMANDS_WAIT_MS` (`commands.ts`), and a request asking again waits for the same scan, so it is
 * given this long, waiting for a thread included, before nobody may still be waiting for it.
 */
export const FILE_SCAN_DEADLINE_MS = 5 * 60_000;

/** Every file thread is taken (or a task outlived its deadline): try again in a moment. */
export class FileBusyError extends Error {
  readonly code = "file_busy";
}

interface PoolOptions {
  workers: number;
  waiting: number;
  deadlineMs: number;
  longDeadlineMs: number;
  scanDeadlineMs: number;
  /**
   * At most this many threads run a scan at once, a commands scan or a Claude task list's
   * (`claude-tasks`) alike: a scan can hold its thread for many seconds, and the file routes keep
   * the others. A scan past that waits, and the tasks behind it still take a free thread.
   */
  scans: number;
  /**
   * Of those, at most this many run a Claude task list's scan: a stuck one still leaves commands
   * scans a thread.
   */
  taskScans: number;
  /** the module a thread runs (a stand-in, in tests) */
  worker: URL;
  /** run each task on the calling thread instead (tests that set `pageFileHooks`, which a thread cannot see) */
  inline: ((task: FileTask) => FileTaskResult) | null;
}

const DEFAULTS: PoolOptions = {
  workers: 4,
  waiting: 64,
  deadlineMs: FILE_TASK_DEADLINE_MS,
  longDeadlineMs: FILE_LONG_TASK_DEADLINE_MS,
  scanDeadlineMs: FILE_SCAN_DEADLINE_MS,
  scans: 2,
  taskScans: 1,
  worker: new URL("./file-worker.ts", import.meta.url),
  inline: null,
};
let options = DEFAULTS;

interface Pending { task: FileTask; done: (result: FileTaskResult) => void; fail: (error: Error) => void; timer: ReturnType<typeof setTimeout>; settled: boolean; unlisten?: () => void; onRun?: () => void }
/** Bun's Worker, which the DOM's type does not describe: `unref` lets the process end with the thread idle. */
type BunWorker = Worker & { ref(): void; unref(): void };
/** `orphaned`: the task of a thread ended while it ran, whose descriptor is closed once it is gone; `closed`: once it is gone. */
interface Thread { worker: BunWorker; pending: Pending | null; orphaned: FileTask | null; closed: Promise<void> }

const threads = new Set<Thread>();
const idle: Thread[] = [];
const queue: Pending[] = [];

/**
 * For tests: fewer threads, a shorter deadline, a stand-in thread module, or tasks run inline. No
 * argument restores the defaults. Every thread started before is ended, a busy one too (what it
 * runs fails), so a test's held thread does not outlive it.
 */
export function setFilePoolOptions(next: Partial<PoolOptions> = {}): void {
  options = { ...DEFAULTS, ...next };
  endThreads("the file threads were replaced");
}

/**
 * Every thread ended, a busy one too, and every task under way or waiting failed now. A thread
 * inside a system call (a read on a stalled disk) ends only once that call returns: what it opened
 * is closed when it has ended (its `close`), never under a read still in flight.
 */
function endThreads(reason: string): void {
  idle.length = 0;
  for (const thread of [...threads]) {
    threads.delete(thread);
    orphan(thread, new Error(reason));
    ending.add(thread.closed);
    void thread.closed.then(() => ending.delete(thread.closed));
    void thread.worker.terminate();
  }
  for (const pending of queue.splice(0)) settle(pending, new Error(reason));
}

/** Threads ended and not yet gone. */
const ending = new Set<Promise<void>>();

/** Once every thread ended so far is gone, and what they opened is closed (tests). */
export async function fileThreadsClosed(): Promise<void> {
  await Promise.all([...ending]);
}

/** A thread's task refused now; what it opened is closed once the thread is gone (`start`'s `close`). */
function orphan(thread: Thread, error: Error): void {
  if (thread.pending === null) return;
  settle(thread.pending, error);
  thread.orphaned = thread.pending.task;
  thread.pending = null;
}

let holders = 0;

/**
 * The file threads held by one server (`createServer`): every server in the process shares them,
 * and the last one to stop (the returned release) ends them. A later server starts new ones.
 */
export function holdFilePool(): () => void {
  holders += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    holders -= 1;
    if (holders === 0) endThreads("the server stopped");
  };
}

/** Threads started and not yet ended, busy or idle, and tasks waiting for one (tests). */
export function filePoolSize(): { threads: number; idle: number; waiting: number } {
  return { threads: threads.size, idle: idle.length, waiting: queue.length };
}

/**
 * `task` run on a file thread; rejects with `FileBusyError` when none is free in time, or at once
 * when `signal` aborts (the request went away). Either way a task already on a thread keeps it
 * until its call returns, and what that late answer opened is closed then, never under it.
 * `onRun`: called once the task is handed to a thread (it no longer waits for one).
 */
export function fileTask<T extends FileTaskResult>(task: FileTask, signal?: AbortSignal, onRun?: () => void): Promise<T> {
  const inline = options.inline;
  if (inline !== null) return Promise.resolve().then(() => inline(task) as T);
  if (signal?.aborted) return Promise.reject(new FileBusyError("the request was cancelled"));
  // the thread names the descriptor it opens here at once, so one never answered (a thread that
  // failed or was ended mid-task) can still be closed (`abandon`)
  if (task.op === "open" || task.op === "describe") task = { ...task, opened: openedCell() };
  return new Promise<T>((done, fail) => {
    const deadline = task.op === "commands" ? options.scanDeadlineMs : task.op === "render" || task.op === "walk" || task.op === "documents" || task.op === "claude-tasks" || task.op === "agy-catalog" || task.op === "letta-output" || task.op === "text-read" ? options.longDeadlineMs : options.deadlineMs;
    const pending: Pending = { task, done: done as (result: FileTaskResult) => void, fail, settled: false, timer: setTimeout(() => expire(pending, "the file system did not answer in time"), deadline), ...(onRun ? { onRun } : {}) };
    if (signal !== undefined) {
      const cancel = () => expire(pending, "the request was cancelled");
      signal.addEventListener("abort", cancel, { once: true });
      pending.unlisten = () => signal.removeEventListener("abort", cancel);
    }
    const thread = mayRun(task) ? idle.pop() ?? (threads.size < options.workers ? start() : null) : null;
    if (thread !== null) run(thread, pending);
    else if (queue.length < options.waiting) queue.push(pending);
    else settle(pending, new FileBusyError("every file thread is busy"));
  });
}

/**
 * A scan only while fewer than `scans` threads run a scan of either kind, and a task list's only
 * while fewer than `taskScans` run one of its own kind (a scan past its deadline keeps its thread,
 * and counts, until it returns); a Markdown listing only while no thread runs another, and a Letta
 * transcript's scan likewise; any other task always.
 */
function mayRun(task: FileTask): boolean {
  // a Markdown listing (GET /api/pane/docs) has one thread of its own: a stuck one never holds a commands scan's
  if (task.op === "documents") return ![...threads].some((thread) => thread.pending?.task.op === "documents");
  // a Letta transcript's scan (GET /api/pane/conversation/tool-output) reads up to 256 MiB, and past its
  // deadline keeps its thread until it returns: one at a time, so long ones hold a single thread (#3326).
  // With it the capped kinds can hold every thread of a pool of four at once (two scans, a Markdown
  // listing and this one), where one was always left before: that takes three stalled disks at a time,
  // and this scan stops reading at its own time limit (file-tasks.ts)
  if (task.op === "letta-output") return ![...threads].some((thread) => thread.pending?.task.op === "letta-output");
  if (task.op !== "commands" && task.op !== "claude-tasks") return true;
  let scanning = 0;
  let taskScanning = 0;
  for (const thread of threads) {
    const op = thread.pending?.task.op;
    if (op === "commands" || op === "claude-tasks") scanning += 1;
    if (op === "claude-tasks") taskScanning += 1;
  }
  return scanning < options.scans && (task.op !== "claude-tasks" || taskScanning < options.taskScans);
}

/** The first waiting task that may run now, taken out of the queue. */
function nextWaiting(): Pending | undefined {
  const at = queue.findIndex((pending) => mayRun(pending.task));
  return at < 0 ? undefined : queue.splice(at, 1)[0];
}

function settle(pending: Pending, outcome: FileTaskResult | Error): void {
  if (pending.settled) return;
  pending.settled = true;
  clearTimeout(pending.timer);
  pending.unlisten?.();
  if (outcome instanceof Error) pending.fail(outcome);
  else pending.done(outcome);
}

/** Past its deadline or cancelled: refused, whether it still waits for a thread or runs on one (which stays taken until it answers). */
function expire(pending: Pending, reason: string): void {
  const at = queue.indexOf(pending);
  if (at >= 0) queue.splice(at, 1);
  settle(pending, new FileBusyError(reason));
}

function start(): Thread {
  const worker = new Worker(options.worker) as BunWorker;
  // an idle thread does not keep the server's process alive
  worker.unref();
  let gone = () => {};
  const thread: Thread = { worker, pending: null, orphaned: null, closed: new Promise<void>((done) => { gone = done; }) };
  threads.add(thread);
  worker.addEventListener("message", (event: MessageEvent<{ result?: FileTaskResult; error?: string }>) => {
    const pending = thread.pending;
    thread.pending = null;
    if (pending !== null) {
      if (pending.settled) discard(pending.task, event.data.result);
      else settle(pending, event.data.error !== undefined ? new Error(event.data.error) : event.data.result ?? null);
    }
    next(thread);
  });
  // a thread that failed outside a task (its module would not load) or ended: its task fails, and another thread takes the queue
  const end = (error: Error) => {
    if (!threads.delete(thread)) return;
    const at = idle.indexOf(thread);
    if (at >= 0) idle.splice(at, 1);
    orphan(thread, error);
    const waiting = nextWaiting();
    if (waiting !== undefined) run(start(), waiting);
  };
  worker.addEventListener("error", (event) => { end(new Error(`a file thread failed: ${event.message}`)); void worker.terminate(); });
  // gone: no call of its can still use what it opened (Bun reports it only after a blocked system call returns)
  worker.addEventListener("close", () => {
    end(new Error("a file thread ended"));
    if (thread.orphaned !== null) abandon(thread.orphaned);
    thread.orphaned = null;
    gone();
  });
  return thread;
}

function run(thread: Thread, pending: Pending): void {
  thread.pending = pending;
  thread.worker.ref();
  thread.worker.postMessage(pending.task);
  pending.onRun?.();
}

/** A thread that answered takes the next waiting task, or rests. */
function next(thread: Thread): void {
  // ended by setFilePoolOptions (tests) while it ran
  if (!threads.has(thread)) return;
  const waiting = nextWaiting();
  if (waiting !== undefined) {
    run(thread, waiting);
    return;
  }
  thread.worker.unref();
  idle.push(thread);
}

/** A late answer's descriptor is closed: the request that asked for it was already answered 503. */
function discard(task: FileTask, result: FileTaskResult | undefined): void {
  if (task.op === "open" && result != null && typeof result === "object" && "fd" in result && result.fd !== null) {
    try { closeSync(result.fd); } catch { /* already closed */ }
  }
}

/** A cell a thread names its opened descriptor in (-1: none yet). */
function openedCell(): Int32Array<SharedArrayBuffer> {
  const cell = new Int32Array(new SharedArrayBuffer(4));
  cell[0] = -1;
  return cell;
}

/** The descriptor a task's thread opened and will never hand over (it failed or was ended, and is gone), closed. */
function abandon(task: FileTask): void {
  if ((task.op !== "open" && task.op !== "describe") || task.opened === undefined) return;
  const fd = Atomics.exchange(task.opened, 0, -1);
  if (fd < 0) return;
  try { closeSync(fd); } catch { /* already closed */ }
}
