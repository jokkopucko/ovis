import { afterEach, describe, expect, it } from "bun:test";
import { closeSync, constants as fsConstants, fstatSync, mkdirSync, mkdtempSync, openSync, rmSync, statSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { FileInfo, SlashCommand } from "../shared/protocol.ts";
import { commandScansSettled, scanPaneCommands, setCommandsWait, setUnclaimedLimits } from "./commands.ts";
import { FileBusyError, filePoolSize, fileTask, fileThreadsClosed, holdFilePool, setFilePoolOptions } from "./file-pool.ts";
import type { FileTask, OpenedFile } from "./file-tasks.ts";

const fake = new URL("./file-worker.fake.ts", import.meta.url);
/** Bun's Atomics.waitAsync (ES2024), which this project's library types predate. */
const waitAsync = (Atomics as unknown as { waitAsync: (cells: Int32Array, index: number, value: number, timeout: number) => { async: boolean; value: Promise<string> | string } }).waitAsync;

const gate = () => {
  const cells = new Int32Array(new SharedArrayBuffer(12));
  cells[1] = -1;
  cells[2] = -1;
  return {
    buffer: cells.buffer as SharedArrayBuffer,
    release: () => { Atomics.store(cells, 0, 1); Atomics.notify(cells, 0); },
    async ran(): Promise<number> {
      const waited = waitAsync(cells, 1, -1, 10_000);
      if ((waited.async ? await waited.value : waited.value) === "timed-out") throw new Error("the held thread never ran its task");
      return cells[1]!;
    },
    closeFifo: () => {
      const fd = Atomics.exchange(cells, 2, -1);
      if (fd >= 0) closeSync(fd);
    },
  };
};
const held = (task: FileTask, buffer: SharedArrayBuffer): FileTask & { gate: SharedArrayBuffer } => ({ ...task, gate: buffer });
const whole = { range: null, ifRange: false };

describe("file threads", () => {
  let root: string;
  let file: string;
  let big: string;
  const setUp = (options: Parameters<typeof setFilePoolOptions>[0]) => {
    root = mkdtempSync(join(tmpdir(), "ovis-file-pool-"));
    file = join(root, "notes.txt");
    writeFileSync(file, "hello");
    big = join(root, "big.bin");
    writeFileSync(big, Buffer.alloc(300 * 1024, 1));
    setFilePoolOptions({ worker: fake, ...options });
  };
  afterEach(() => {
    setFilePoolOptions();
    rmSync(root, { recursive: true, force: true });
  });

  it("refuses at once past its threads and its waiting places, and runs the rest once threads answer", async () => {
    setUp({ workers: 2, waiting: 1, deadlineMs: 30_000 });
    const hold = gate();
    const running = [fileTask<FileInfo | null>(held({ op: "info", path: file }, hold.buffer)), fileTask<FileInfo | null>(held({ op: "info", path: file }, hold.buffer))];
    const waiting = fileTask<FileInfo | null>({ op: "info", path: file });
    expect(filePoolSize()).toEqual({ threads: 2, idle: 0, waiting: 1 });
    await expect(fileTask({ op: "info", path: file })).rejects.toBeInstanceOf(FileBusyError);
    hold.release();
    for (const answer of await Promise.all([...running, waiting])) expect(answer).toMatchObject({ name: "notes.txt", size: 5 });
    expect(filePoolSize()).toEqual({ threads: 2, idle: 2, waiting: 0 });
  });

  it("refuses a task at its deadline, and keeps its thread taken until the call returns", async () => {
    // the task after the release is a folder walk, with the long deadline: one with the short one
    // would race the thread's answer and its own turn on it against 200 ms
    setUp({ workers: 1, waiting: 1, deadlineMs: 200, longDeadlineMs: 30_000 });
    const hold = gate();
    await expect(fileTask(held({ op: "info", path: file }, hold.buffer))).rejects.toBeInstanceOf(FileBusyError);
    await expect(fileTask({ op: "info", path: file })).rejects.toBeInstanceOf(FileBusyError);
    expect(filePoolSize()).toEqual({ threads: 1, idle: 0, waiting: 0 });
    const next = fileTask<string[]>({ op: "walk", cwd: root });
    hold.release();
    expect([...await next].sort()).toEqual(["big.bin", "notes.txt"]);
    expect(filePoolSize()).toEqual({ threads: 1, idle: 1, waiting: 0 });
  });

  it("closes a descriptor a late answer opened, and frees its thread for the next task", async () => {
    // only the held task has the short deadline; the next one, a folder walk, has the long one
    setUp({ workers: 1, waiting: 1, deadlineMs: 300, longDeadlineMs: 30_000 });
    const hold = gate();
    await expect(fileTask<OpenedFile | null>(held({ op: "open", path: big, get: whole, fastDiskMs: -1 }, hold.buffer))).rejects.toBeInstanceOf(FileBusyError);
    const fd = await hold.ran();
    expect(fd).toBeGreaterThanOrEqual(0);
    const next = fileTask<string[]>({ op: "walk", cwd: root });
    hold.release();
    expect([...await next].sort()).toEqual(["big.bin", "notes.txt"]);
    expect(() => fstatSync(fd)).toThrow();
  });

  it("refuses at once when its request goes away, and closes what the thread opened only once it answers", async () => {
    setUp({ workers: 1, waiting: 1, deadlineMs: 30_000 });
    const hold = gate();
    const abort = new AbortController();
    const opening = fileTask<OpenedFile | null>(held({ op: "open", path: big, get: whole, fastDiskMs: -1 }, hold.buffer), abort.signal);
    const fd = await hold.ran();
    abort.abort();
    await expect(opening).rejects.toThrow("cancelled");
    expect(fstatSync(fd).size).toBe(300 * 1024);
    expect(filePoolSize()).toEqual({ threads: 1, idle: 0, waiting: 0 });
    const queued = new AbortController();
    const waiting = fileTask({ op: "info", path: file }, queued.signal);
    expect(filePoolSize().waiting).toBe(1);
    queued.abort();
    await expect(waiting).rejects.toThrow("cancelled");
    expect(filePoolSize().waiting).toBe(0);
    const next = fileTask<FileInfo | null>({ op: "info", path: file });
    hold.release();
    expect(await next).toMatchObject({ size: 5 });
    expect(() => fstatSync(fd)).toThrow();
    await expect(fileTask({ op: "info", path: file }, AbortSignal.abort())).rejects.toThrow("cancelled");
  });

  it("reads a body of one read on its thread, inside the deadline, and hands over only a larger one", async () => {
    setUp({ workers: 1, waiting: 0, deadlineMs: 30_000 });
    const small = await fileTask<OpenedFile | null>({ op: "open", path: file, get: whole });
    expect(small).toMatchObject({ size: 5, range: null, fd: null });
    expect(new TextDecoder().decode(small!.bytes!)).toBe("hello");
    const part = await fileTask<OpenedFile | null>({ op: "open", path: big, get: { range: "bytes=10-19", ifRange: false } });
    expect(part).toMatchObject({ size: 300 * 1024, range: [10, 19], fd: null });
    expect(part!.bytes!.length).toBe(10);
    expect(await fileTask({ op: "open", path: big, get: { range: `bytes=${300 * 1024}-`, ifRange: false } })).toMatchObject({ range: "unsatisfiable", bytes: null, fd: null });
    expect(await fileTask({ op: "open", path: big, get: null })).toMatchObject({ size: 300 * 1024, bytes: null, fd: null });
    expect(await fileTask({ op: "open", path: big, get: whole })).toMatchObject({ size: 300 * 1024, range: null, bytes: null, fd: null, fast: true });
    const stream = await fileTask<OpenedFile | null>({ op: "open", path: big, get: whole, fastDiskMs: -1 });
    expect(stream).toMatchObject({ range: null, bytes: null, fast: false });
    expect(fstatSync(stream!.fd!).size).toBe(300 * 1024);
    closeSync(stream!.fd!);
  });

  it("gives a folder walk, many calls rather than one, the longer deadline", async () => {
    setUp({ workers: 2, waiting: 0, deadlineMs: 150, longDeadlineMs: 30_000 });
    const hold = gate();
    const walk = fileTask<string[]>(held({ op: "walk", cwd: root }, hold.buffer));
    await expect(fileTask(held({ op: "info", path: file }, hold.buffer))).rejects.toBeInstanceOf(FileBusyError);
    hold.release();
    expect([...await walk].sort()).toEqual(["big.bin", "notes.txt"]);
  });

  const scan = (): FileTask => ({ op: "commands", agent: "claude", cwd: root, home: root, roots: {}, version: null, serverEnv: {} });
  const names = (commands: SlashCommand[]): string[] => commands.map((command) => command.name);

  it("runs at most `scans` commands scans at once, and file tasks take the threads left (#2254)", async () => {
    setUp({ workers: 3, waiting: 4, deadlineMs: 30_000, scanDeadlineMs: 30_000, scans: 2 });
    mkdirSync(join(root, ".claude", "skills", "listed"), { recursive: true });
    writeFileSync(join(root, ".claude", "skills", "listed", "SKILL.md"), "---\nname: listed\ndescription: A skill in the scanned home.\n---\n");
    const hold = gate();
    const scans = [fileTask<SlashCommand[]>(held(scan(), hold.buffer)), fileTask<SlashCommand[]>(held(scan(), hold.buffer))];
    const third = fileTask<SlashCommand[]>(scan());
    expect(filePoolSize()).toEqual({ threads: 2, idle: 0, waiting: 1 });
    expect(await fileTask<FileInfo | null>({ op: "info", path: file })).toMatchObject({ size: 5 });
    expect(filePoolSize()).toEqual({ threads: 3, idle: 1, waiting: 1 });
    hold.release();
    for (const commands of await Promise.all([...scans, third])) expect(names(commands)).toContain("listed");
  });

  const tasks = (): FileTask => ({ op: "claude-tasks", path: join(root, "session.jsonl"), live: true, since: null });

  it("runs one Claude task-list scan at a time, and a stuck one leaves commands scans a thread", async () => {
    setUp({ workers: 4, waiting: 4, deadlineMs: 30_000, longDeadlineMs: 30_000, scanDeadlineMs: 30_000, scans: 2, taskScans: 1 });
    const hold = gate();
    const stuck = fileTask(held(tasks(), hold.buffer));
    const second = fileTask(tasks());
    expect(filePoolSize()).toEqual({ threads: 1, idle: 0, waiting: 1 });
    const commands = fileTask(held(scan(), hold.buffer));
    expect(filePoolSize()).toEqual({ threads: 2, idle: 0, waiting: 1 });
    hold.release();
    await Promise.all([stuck, second, commands]);
  });

  it("counts scans of both kinds against `scans` together, so file tasks always keep two of four threads", async () => {
    setUp({ workers: 4, waiting: 4, deadlineMs: 30_000, longDeadlineMs: 30_000, scanDeadlineMs: 30_000, scans: 2, taskScans: 1 });
    const hold = gate();
    const running = [fileTask(held(scan(), hold.buffer)), fileTask(held(scan(), hold.buffer))];
    const waiting = [fileTask(tasks()), fileTask(scan())];
    expect(filePoolSize()).toEqual({ threads: 2, idle: 0, waiting: 2 });
    await Promise.all([fileTask({ op: "info", path: file }), fileTask({ op: "info", path: file })]);
    expect(filePoolSize()).toEqual({ threads: 4, idle: 2, waiting: 2 });
    hold.release();
    await Promise.all([...running, ...waiting]);
  });

  it("runs one Markdown listing at a time, and a stuck one leaves commands scans both their threads", async () => {
    setUp({ workers: 4, waiting: 4, deadlineMs: 30_000, longDeadlineMs: 30_000, scanDeadlineMs: 30_000, scans: 2, taskScans: 1 });
    const hold = gate();
    const listing = (): FileTask => ({ op: "documents", cwd: root, paths: null });
    const stuck = fileTask(held(listing(), hold.buffer));
    const second = fileTask(listing());
    expect(filePoolSize()).toEqual({ threads: 1, idle: 0, waiting: 1 });
    const commands = [fileTask(held(scan(), hold.buffer)), fileTask(held(scan(), hold.buffer))];
    expect(filePoolSize()).toEqual({ threads: 3, idle: 0, waiting: 1 });
    await fileTask({ op: "info", path: file });
    expect(filePoolSize()).toEqual({ threads: 4, idle: 1, waiting: 1 });
    hold.release();
    await Promise.all([stuck, second, ...commands]);
  });

  it("runs one Letta transcript scan at a time with the longer deadline, so a long one holds a single thread (#3326)", async () => {
    setUp({ workers: 4, waiting: 4, deadlineMs: 150, longDeadlineMs: 30_000, scanDeadlineMs: 30_000 });
    const transcript = join(root, "transcript.jsonl");
    writeFileSync(transcript, `${JSON.stringify({ kind: "tool_call", resultText: "the call's output", captured_at: "2026-10-29T01:00:00.000Z", source_line_id: "Bash-1-1" })}\n`);
    const { dev, ino } = statSync(transcript);
    const output = (): FileTask => ({ op: "letta-output", path: transcript, ref: "Bash-1-1", file: { dev, ino }, max: 2_000_000 });
    const hold = gate();
    const stuck = fileTask<string | null>(held(output(), hold.buffer));
    const second = fileTask<string | null>(output());
    expect(filePoolSize()).toEqual({ threads: 1, idle: 0, waiting: 1 });
    await expect(fileTask(held({ op: "info", path: file }, hold.buffer))).rejects.toBeInstanceOf(FileBusyError);
    expect(filePoolSize()).toEqual({ threads: 2, idle: 0, waiting: 1 });
    hold.release();
    expect(await Promise.all([stuck, second])).toEqual(["the call's output", "the call's output"]);
  });

  it("gives a commands scan a deadline of its own, longer than a folder walk's", async () => {
    setUp({ workers: 2, waiting: 0, deadlineMs: 150, longDeadlineMs: 150, scanDeadlineMs: 30_000 });
    const hold = gate();
    const scanning = fileTask<SlashCommand[]>(held(scan(), hold.buffer));
    await expect(fileTask(held({ op: "walk", cwd: root }, hold.buffer))).rejects.toBeInstanceOf(FileBusyError);
    hold.release();
    expect(names(await scanning)).toContain("clear");
  });

  it("hands a scan the server's environment, which its thread does not see", async () => {
    setUp({ workers: 1, waiting: 0, deadlineMs: 30_000 });
    const agentDir = join(root, "pi-agent");
    mkdirSync(join(agentDir, "prompts"), { recursive: true });
    writeFileSync(join(agentDir, "prompts", "from-server-env.md"), "A prompt pi finds through the server's PI_CODING_AGENT_DIR.\n");
    const before = process.env["PI_CODING_AGENT_DIR"];
    process.env["PI_CODING_AGENT_DIR"] = agentDir;
    try {
      expect(names(await scanPaneCommands("pi", root))).toContain("from-server-env");
    } finally {
      if (before === undefined) delete process.env["PI_CODING_AGENT_DIR"];
      else process.env["PI_CODING_AGENT_DIR"] = before;
    }
  });

  it("counts a request's wait from when it began, and drops a scan still waiting for a thread once nobody waits for it (#2254)", async () => {
    setUp({ workers: 1, waiting: 1, deadlineMs: 30_000 });
    setCommandsWait(30_000);
    try {
      const hold = gate();
      const busy = fileTask<FileInfo | null>(held({ op: "info", path: file }, hold.buffer));
      await expect(scanPaneCommands("claude", root, {}, null, undefined, performance.now() - 30_000)).rejects.toBeInstanceOf(FileBusyError);
      expect(filePoolSize().waiting).toBe(0);
      const next = fileTask<FileInfo | null>({ op: "info", path: file });
      hold.release();
      expect(await busy).toMatchObject({ size: 5 });
      expect(await next).toMatchObject({ size: 5 });
    } finally { setCommandsWait(); }
  });

  it("keeps a bounded number of unclaimed scan answers, the oldest dropped first (#2254)", async () => {
    setUp({ workers: 4, waiting: 0, deadlineMs: 30_000 });
    const before = process.env["HOME"];
    process.env["HOME"] = join(root, "home");
    const skill = (folder: string, name: string) => {
      mkdirSync(join(root, folder, ".claude", "skills", name), { recursive: true });
      writeFileSync(join(root, folder, ".claude", "skills", name, "SKILL.md"), `---\nname: ${name}\ndescription: A skill of ${folder}.\n---\n`);
    };
    const abandoned = async (folder: string) => {
      const leaving = new AbortController();
      const scan = scanPaneCommands("claude", join(root, folder), {}, null, leaving.signal);
      leaving.abort();
      await expect(scan).rejects.toBeInstanceOf(FileBusyError);
      await commandScansSettled();
    };
    try {
      setUnclaimedLimits({ entries: 2 });
      for (const folder of ["one", "two", "three"]) {
        skill(folder, `${folder}-before`);
        await abandoned(folder);
      }
      await commandScansSettled();
      for (const folder of ["one", "two", "three"]) skill(folder, `${folder}-after`);
      expect(names(await scanPaneCommands("claude", join(root, "one")))).toContain("one-after");
      expect(names(await scanPaneCommands("claude", join(root, "three")))).not.toContain("three-after");
      setUnclaimedLimits({ chars: 1 });
      await abandoned("two");
      await commandScansSettled();
      skill("two", "two-later");
      expect(names(await scanPaneCommands("claude", join(root, "two")))).toContain("two-later");
    } finally {
      setUnclaimedLimits();
      if (before === undefined) delete process.env["HOME"];
      else process.env["HOME"] = before;
    }
  });

  it("closes a descriptor whose thread is ended before it answers", async () => {
    setUp({ workers: 1, waiting: 0, deadlineMs: 30_000 });
    const hold = gate();
    const opening = fileTask<OpenedFile | null>(held({ op: "open", path: big, get: whole, fastDiskMs: -1 }, hold.buffer));
    const fd = await hold.ran();
    expect(fstatSync(fd).size).toBe(300 * 1024);
    setFilePoolOptions();
    await expect(opening).rejects.toThrow("replaced");
    await fileThreadsClosed();
    expect(() => fstatSync(fd)).toThrow();
  });

  it("closes a descriptor a scratch file's description opened, when its thread is ended mid-check", async () => {
    setUp({ workers: 1, waiting: 0, deadlineMs: 30_000 });
    const fifo = join(root, "stall");
    expect(Bun.spawnSync(["mkfifo", fifo]).exitCode).toBe(0);
    const hold = gate();
    const describing = fileTask({ op: "describe", path: file, folder: root, authorizeGate: { cells: hold.buffer, fifo } } as FileTask);
    // the thread holds the file open inside its check, blocked in a system call ending it cannot cut short
    const fd = await hold.ran();
    expect(fstatSync(fd).size).toBe(5);
    setFilePoolOptions();
    await expect(describing).rejects.toThrow("replaced");
    // the call returns (a write that never waits: the thread opened the FIFO before it said it ran), the thread is gone, and what it opened is closed
    const writer = openSync(fifo, fsConstants.O_WRONLY | fsConstants.O_NONBLOCK);
    writeSync(writer, "x");
    closeSync(writer);
    await fileThreadsClosed();
    expect(() => fstatSync(fd)).toThrow();
    hold.closeFifo();
  });

  it("keeps a descriptor its thread is reading open until that thread is gone, when the last server stops", async () => {
    setUp({ workers: 1, waiting: 0, deadlineMs: 30_000 });
    const fifo = join(root, "stall");
    expect(Bun.spawnSync(["mkfifo", fifo]).exitCode).toBe(0);
    const release = holdFilePool();
    const hold = gate();
    const reading = fileTask<OpenedFile | null>({ op: "open", path: file, get: whole, readGate: { cells: hold.buffer, fifo } } as FileTask);
    // the thread is inside the read of `file`, blocked in a system call ending it cannot cut short
    const fd = await hold.ran();
    release();
    await expect(reading).rejects.toThrow("stopped");
    // the request is answered, but the read still uses the descriptor: it stays open, and its number is not handed out again
    expect(fstatSync(fd).size).toBe(5);
    const other = openSync(big, "r");
    expect(other).not.toBe(fd);
    closeSync(other);
    // the read returns (a write that never waits: the thread opened the FIFO before it said it ran), the thread is gone, and only then is its descriptor closed
    const writer = openSync(fifo, fsConstants.O_WRONLY | fsConstants.O_NONBLOCK);
    writeSync(writer, "x");
    closeSync(writer);
    await fileThreadsClosed();
    expect(() => fstatSync(fd)).toThrow();
    hold.closeFifo();
  });

  it("ends its threads, a busy one too, when the last server holding them stops", async () => {
    setUp({ workers: 2, waiting: 0, deadlineMs: 30_000 });
    const [first, second] = [holdFilePool(), holdFilePool()];
    const hold = gate();
    const opening = fileTask<OpenedFile | null>(held({ op: "open", path: big, get: whole, fastDiskMs: -1 }, hold.buffer));
    const fd = await hold.ran();
    expect(await fileTask({ op: "info", path: file })).toMatchObject({ size: 5 });
    expect(filePoolSize().threads).toBe(2);
    first();
    first();
    expect(filePoolSize().threads).toBe(2);
    second();
    expect(filePoolSize()).toEqual({ threads: 0, idle: 0, waiting: 0 });
    await expect(opening).rejects.toThrow("stopped");
    await fileThreadsClosed();
    expect(() => fstatSync(fd)).toThrow();
    const later = holdFilePool();
    expect(await fileTask({ op: "info", path: file })).toMatchObject({ size: 5 });
    later();
  });

  it("refuses a task waiting for a thread at its deadline", async () => {
    setUp({ workers: 1, waiting: 1, deadlineMs: 200 });
    const [stuck, waiting] = await Promise.allSettled([fileTask({ op: "info", path: join(root, "stuck") }), fileTask({ op: "info", path: file })]);
    expect(stuck.status === "rejected" && stuck.reason).toBeInstanceOf(FileBusyError);
    expect(waiting.status === "rejected" && waiting.reason).toBeInstanceOf(FileBusyError);
    expect(filePoolSize()).toEqual({ threads: 1, idle: 0, waiting: 0 });
  });

  it("runs every task on a real thread and answers as the calling thread would", async () => {
    setFilePoolOptions();
    root = mkdtempSync(join(tmpdir(), "ovis-file-pool-"));
    writeFileSync(join(root, "a.log"), "line\n");
    expect(await fileTask<FileInfo | null>({ op: "info", path: join(root, "a.log") })).toMatchObject({ name: "a.log", kind: "text", size: 5 });
    expect(await fileTask({ op: "info", path: root })).toBeNull();
    expect(await fileTask({ op: "walk", cwd: root })).toEqual(["a.log"]);
    const opened = await fileTask<OpenedFile | null>({ op: "open", path: join(root, "a.log"), get: whole });
    expect(opened).toMatchObject({ size: 5, fd: null });
    expect(new TextDecoder().decode(opened!.bytes!)).toBe("line\n");
  });
});
