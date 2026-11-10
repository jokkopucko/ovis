import { expect, it, spyOn } from "bun:test";
import { Database } from "bun:sqlite";
import * as fs from "node:fs";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, truncateSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { AgyUnavailable, agyCatalog, agyDatabasePath, parseAgyTranscript, withAgyHistory } from "./agy.ts";

/** Writes a WAL catalog from a process that then dies without closing it, as agy does when killed:
 * nothing checkpoints, and no handle stays open, so a test may delete side files on any platform. */
async function abandonedWal(dbPath: string, sql: string): Promise<void> {
  const writer = Bun.spawn([process.execPath, "-e", `
    import { Database } from "bun:sqlite";
    new Database(${JSON.stringify(dbPath)}).exec(${JSON.stringify(sql)});
    process.kill(process.pid, "SIGKILL");
  `], { stdout: "ignore", stderr: "pipe" });
  const [stderr] = await Promise.all([new Response(writer.stderr).text(), writer.exited]);
  expect(stderr).toBe("");
  expect([existsSync(`${dbPath}-wal`), existsSync(`${dbPath}-shm`)]).toEqual([true, true]);
}

it("copies a live WAL catalog for a history read on a file thread, not the server's (#2706)", async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "agy-thread-")));
  try {
    const transcript = join(dir, "brain", "session", ".system_generated", "logs", "transcript_full.jsonl");
    const dbPath = agyDatabasePath(transcript);
    mkdirSync(dirname(dbPath), { recursive: true });
    mkdirSync(dirname(transcript), { recursive: true });
    await abandonedWal(dbPath, "PRAGMA journal_mode=WAL; CREATE TABLE steps(idx INTEGER PRIMARY KEY); PRAGMA wal_checkpoint(TRUNCATE); INSERT INTO steps VALUES (0);");
    fs.writeFileSync(transcript, `${JSON.stringify({ step_index: 0, type: "USER_INPUT", status: "DONE", content: "one" })}\n`);
    // the private copy is written with writeFileSync: a file thread's calls are not this thread's
    const writes = spyOn(fs, "writeFileSync");
    try {
      expect(await withAgyHistory(transcript, (projection) => projection.indices)).toEqual([0]);
      expect(writes).not.toHaveBeenCalled();
    } finally { writes.mockRestore(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

it("reads a stable rollback-journal catalog without creating side files", () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "agy-rollback-")));
  try {
    const transcript = join(dir, "brain", "session", ".system_generated", "logs", "transcript_full.jsonl");
    const dbPath = agyDatabasePath(transcript);
    mkdirSync(dirname(dbPath), { recursive: true });
    const writer = new Database(dbPath);
    try {
      writer.exec("CREATE TABLE steps(idx INTEGER PRIMARY KEY); INSERT INTO steps VALUES (0);");
    } finally { writer.close(); }

    const catalog = agyCatalog(transcript);

    expect([...catalog]).toEqual([0]);
    expect(existsSync(`${dbPath}-wal`)).toBe(false);
    expect(existsSync(`${dbPath}-shm`)).toBe(false);
    expect(existsSync(`${dbPath}-journal`)).toBe(false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

it("reads a checkpointed WAL catalog without recreating missing side files", () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "agy-wal-")));
  try {
    const transcript = join(dir, "brain", "session", ".system_generated", "logs", "transcript_full.jsonl");
    const dbPath = agyDatabasePath(transcript);
    mkdirSync(dirname(dbPath), { recursive: true });
    const writer = new Database(dbPath);
    try {
      writer.exec("PRAGMA journal_mode=WAL; CREATE TABLE steps(idx INTEGER PRIMARY KEY); INSERT INTO steps VALUES (0); PRAGMA wal_checkpoint(TRUNCATE);");
    } finally { writer.close(); }
    rmSync(`${dbPath}-wal`, { force: true });
    rmSync(`${dbPath}-shm`, { force: true });
    expect([...readFileSync(dbPath).subarray(18, 20)]).toEqual([2, 2]);

    const catalog = agyCatalog(transcript);

    expect([...catalog]).toEqual([0]);
    expect(existsSync(`${dbPath}-wal`)).toBe(false);
    expect(existsSync(`${dbPath}-shm`)).toBe(false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

it.each([
  ["database", 64 * 1024 * 1024 + 1, 0],
  ["WAL", 8192, 64 * 1024 * 1024 + 1],
  ["combined", 32 * 1024 * 1024, 32 * 1024 * 1024 + 1],
] as const)("rejects an oversized %s before copying the catalog", (_name, dbBytes, walBytes) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "agy-catalog-limit-")));
  try {
    const transcript = join(dir, "brain", "session", ".system_generated", "logs", "transcript_full.jsonl");
    const dbPath = agyDatabasePath(transcript);
    mkdirSync(dirname(dbPath), { recursive: true });
    const writer = new Database(dbPath);
    try {
      writer.exec("PRAGMA journal_mode=WAL; CREATE TABLE steps(idx INTEGER PRIMARY KEY); INSERT INTO steps VALUES (0); PRAGMA wal_checkpoint(TRUNCATE);");
      truncateSync(dbPath, dbBytes);
      truncateSync(`${dbPath}-wal`, walBytes);
      const reads = spyOn(fs, "readSync");
      // A regression fails on its first write instead of materializing the sparse files.
      const writes = spyOn(fs, "writeFileSync").mockImplementation(() => { throw new Error("unexpected snapshot write"); });
      try {
        expect(() => agyCatalog(transcript)).toThrow(AgyUnavailable);
        expect(reads).toHaveBeenCalledTimes(1);
        expect(reads.mock.calls[0]?.[1].byteLength).toBe(20);
        expect(writes).not.toHaveBeenCalled();
      } finally { writes.mockRestore(); reads.mockRestore(); }
    } finally { writer.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

it.each(["wal", "shm", null] as const)("reads a WAL catalog with %s missing without changing side files", async (missing) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "agy-wal-pair-")));
  try {
    const transcript = join(dir, "brain", "session", ".system_generated", "logs", "transcript_full.jsonl");
    const dbPath = agyDatabasePath(transcript);
    mkdirSync(dirname(dbPath), { recursive: true });
    await abandonedWal(dbPath, "PRAGMA journal_mode=WAL; CREATE TABLE steps(idx INTEGER PRIMARY KEY); INSERT INTO steps VALUES (0); PRAGMA wal_checkpoint(TRUNCATE); INSERT INTO steps VALUES (1);");
    if (missing !== null) rmSync(`${dbPath}-${missing}`);
    const before = [existsSync(`${dbPath}-wal`), existsSync(`${dbPath}-shm`)];
    expect(before).toEqual([missing !== "wal", missing !== "shm"]);

    // A separate process avoids sharing the writer's in-process SQLite state.
    const reader = Bun.spawn([process.execPath, "-e", `
      import { agyCatalog } from ${JSON.stringify(new URL("./agy.ts", import.meta.url).href)};
      console.log(JSON.stringify([...agyCatalog(${JSON.stringify(transcript)})]));
    `], { stdout: "pipe", stderr: "pipe" });
    const [exitCode, stdout, stderr] = await Promise.all([
      reader.exited, new Response(reader.stdout).text(), new Response(reader.stderr).text(),
    ]);

    expect([existsSync(`${dbPath}-wal`), existsSync(`${dbPath}-shm`)]).toEqual(before);
    expect(stderr).toBe("");
    expect(exitCode).toBe(0);
    // Incomplete pairs read only the checkpointed main file, as session-history does.
    expect(JSON.parse(stdout)).toEqual(missing === null ? [0, 1] : [0]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

it("reads a long session's live WAL catalog past 32 MiB and copies it again only when it changes", async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "agy-wal-large-")));
  try {
    const transcript = join(dir, "brain", "session", ".system_generated", "logs", "transcript_full.jsonl");
    const dbPath = agyDatabasePath(transcript);
    mkdirSync(dirname(dbPath), { recursive: true });
    // 24 MiB checkpointed plus about 10 MiB of WAL, the shape of a long turn (#2618).
    const rows = (from: number, to: number) => Array.from({ length: to - from }, (_, at) => `INSERT INTO steps VALUES (${from + at}, randomblob(1048576));`).join("");
    await abandonedWal(dbPath, `PRAGMA journal_mode=WAL; CREATE TABLE steps(idx INTEGER PRIMARY KEY, payload BLOB); ${rows(0, 24)} PRAGMA wal_checkpoint(TRUNCATE); ${rows(24, 34)}`);
    expect(fs.statSync(dbPath).size + fs.statSync(`${dbPath}-wal`).size).toBeGreaterThan(32 * 1024 * 1024);

    const changed = () => Math.max(...[dbPath, `${dbPath}-wal`].flatMap((file) => [fs.statSync(file).mtimeMs, fs.statSync(file).ctimeMs]));
    let now = changed() + 100;
    const clock = spyOn(Date, "now").mockImplementation(() => now);
    const writes = spyOn(fs, "writeFileSync");
    try {
      expect(agyCatalog(transcript).size).toBe(34);
      // Files changed just before a copy may yet be rewritten under the same times: copy again.
      writes.mockClear();
      expect(agyCatalog(transcript).size).toBe(34);
      expect(writes).toHaveBeenCalled();
      // Copied once they had settled, a catalog is reused for as long as it does not change.
      now += 2500;
      expect(agyCatalog(transcript).size).toBe(34);
      now += 60_000;
      writes.mockClear();
      expect(agyCatalog(transcript).size).toBe(34);
      expect(writes).not.toHaveBeenCalled();
      await abandonedWal(dbPath, "INSERT INTO steps VALUES (34, NULL);");
      now = changed() + 100;
      expect(agyCatalog(transcript).has(34)).toBe(true);
      expect(writes).toHaveBeenCalled();
      await abandonedWal(dbPath, "INSERT INTO steps VALUES (35, NULL);");
      now = changed() + 2500;
      expect(agyCatalog(transcript).has(35)).toBe(true);
      // A reused catalog still requires the path to name the pinned database.
      writes.mockClear();
      expect(() => agyCatalog(transcript, () => {
        fs.renameSync(dbPath, `${dbPath}.old`);
        fs.copyFileSync(`${dbPath}.old`, dbPath);
      })).toThrow(AgyUnavailable);
      expect(writes).not.toHaveBeenCalled();
      // ...and unchanged pinned files through the read, as a fresh copy does.
      fs.rmSync(dbPath);
      fs.renameSync(`${dbPath}.old`, dbPath);
      now = changed() + 2500;
      expect(agyCatalog(transcript).size).toBe(36);
      writes.mockClear();
      expect(() => agyCatalog(transcript, () => fs.truncateSync(dbPath, 0))).toThrow(AgyUnavailable);
      expect(writes).not.toHaveBeenCalled();
    } finally { writes.mockRestore(); clock.mockRestore(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

it("does not recreate a live WAL pair unlinked between its check and open", async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "agy-wal-unlink-")));
  try {
    const transcript = join(dir, "brain", "session", ".system_generated", "logs", "transcript_full.jsonl");
    const dbPath = agyDatabasePath(transcript);
    mkdirSync(dirname(dbPath), { recursive: true });
    await abandonedWal(dbPath, "PRAGMA journal_mode=WAL; CREATE TABLE steps(idx INTEGER PRIMARY KEY); INSERT INTO steps VALUES (0); PRAGMA wal_checkpoint(TRUNCATE);");
    const reader = Bun.spawn([process.execPath, "-e", `
      import { agyCatalog, AgyUnavailable } from ${JSON.stringify(new URL("./agy.ts", import.meta.url).href)};
      import { existsSync, rmSync } from "node:fs";
      const path = ${JSON.stringify(dbPath)};
      let removed = false;
      let rows = null;
      try {
        rows = [...agyCatalog(${JSON.stringify(transcript)}, () => {
          if (!existsSync(path + "-wal") || !existsSync(path + "-shm")) throw new Error("pair missing before hook");
          rmSync(path + "-wal");
          rmSync(path + "-shm");
          removed = true;
        })];
      } catch (error) {
        if (!(error instanceof AgyUnavailable)) throw error;
      }
      console.log(JSON.stringify({ removed, rows }));
    `], { stdout: "pipe", stderr: "pipe" });
    const [exitCode, stdout, stderr] = await Promise.all([
      reader.exited, new Response(reader.stdout).text(), new Response(reader.stderr).text(),
    ]);

    expect([existsSync(`${dbPath}-wal`), existsSync(`${dbPath}-shm`)]).toEqual([false, false]);
    expect(stderr).toBe("");
    expect(exitCode).toBe(0);
    const result = JSON.parse(stdout);
    expect(result.removed).toBe(true);
    expect([null, [0]]).toContainEqual(result.rows);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

it("keeps the recorded skill invocation without its expanded metadata", () => {
  const fixture = readFileSync(new URL("./fixtures/skill-invocations/agy.jsonl", import.meta.url), "utf8");
  const turns = parseAgyTranscript(fixture);
  expect(turns.filter(({ role }) => role === "user").map(({ parts }) => parts)).toEqual([
    [{ kind: "text", text: "/probe-skill hello" }, { kind: "skill", skill: { name: "probe-skill", evidence: "instructions", status: "loaded" } }],
  ]);
});

it("keeps a tool result that follows a wake notice with no planner step in the reply that asked for it", () => {
  const step = (step_index: number, type: string, created_at: string, content = "", extra: Record<string, unknown> = {}) =>
    JSON.stringify({ step_index, type, status: "DONE", created_at, content, ...extra });
  const turns = parseAgyTranscript([
    step(0, "USER_INPUT", "2026-11-09T11:36:17Z", "Run it"),
    step(1, "PLANNER_RESPONSE", "2026-11-09T11:36:25Z", "Done."),
    // a hook's injected notice: no planner step answers it
    step(2, "SYSTEM_MESSAGE", "2026-11-09T11:39:00Z", "<SYSTEM_MESSAGE>note</SYSTEM_MESSAGE>"),
    step(3, "GENERIC", "2026-11-09T11:40:00Z", "late tool output"),
  ].join("\n"));
  expect(turns.map(({ role, end_ts, parts }) => ({ role, end_ts, kinds: parts.map((part) => part.kind) }))).toEqual([
    { role: "user", end_ts: undefined, kinds: ["text"] },
    // no wordless third turn, and the reply still ends when it was said
    { role: "assistant", end_ts: "2026-11-09T11:36:25Z", kinds: ["text", "tool"] },
  ]);
});

it("keeps raw input when it is not a complete recognized envelope", () => {
  const content = "<USER_REQUEST>\n/probe-skill hello\n</USER_REQUEST>\n<OTHER>raw</OTHER>";
  const turns = parseAgyTranscript(JSON.stringify({ step_index: 0, type: "USER_INPUT", status: "DONE", content }));
  expect(turns[0]?.parts).toEqual([{ kind: "text", text: content }]);
});

it("starts a new assistant turn when a SYSTEM_MESSAGE wakes the planner after a completed reply, while keeping mid-turn wakeups in the active turn", () => {
  const step = (step_index: number, type: string, created_at: string, content = "", extra: Record<string, unknown> = {}) =>
    JSON.stringify({ step_index, type, status: "DONE", created_at, content, ...extra });
  const turns = parseAgyTranscript([
    step(0, "USER_INPUT", "2026-11-09T11:36:17Z", "Run background job"),
    step(1, "PLANNER_RESPONSE", "2026-11-09T11:36:25Z", "Starting job.", { tool_calls: [{ name: "run_command", args: { CommandLine: "run-job" } }] }),
    step(2, "GENERIC", "2026-11-09T11:36:30Z", "Tool is running as a background task"),
    // A SYSTEM_MESSAGE arriving while tools are still active stays in the same assistant turn.
    step(3, "SYSTEM_MESSAGE", "2026-11-09T11:36:35Z", "<SYSTEM_MESSAGE>early notice</SYSTEM_MESSAGE>"),
    step(4, "PLANNER_RESPONSE", "2026-11-09T11:36:40Z", "Waiting for it to finish."),
    // A late GENERIC result after a completed reply preserves the reply's completion timestamp and idle state.
    step(5, "GENERIC", "2026-11-09T11:36:45Z", "late tool output"),
    // Once a tool-free answer ends the sub-turn, a later SYSTEM_MESSAGE wakeup opens a new assistant turn with its own timestamps.
    step(6, "SYSTEM_MESSAGE", "2026-11-09T13:09:40Z", "<SYSTEM_MESSAGE>task finished</SYSTEM_MESSAGE>"),
    step(7, "PLANNER_RESPONSE", "2026-11-09T13:09:41Z", "Checking results.", { tool_calls: [{ name: "read_file", args: { AbsolutePath: "/out.log" } }] }),
    step(8, "GENERIC", "2026-11-09T13:09:50Z", "ok"),
    step(9, "PLANNER_RESPONSE", "2026-11-09T13:10:05Z", "All done."),
  ].join("\n"));
  expect(turns.map(({ role, ts, end_ts, parts }) => ({
    role,
    ts,
    end_ts,
    texts: parts.filter((part): part is Extract<typeof part, { kind: "text" }> => part.kind === "text").map((part) => part.text),
  }))).toEqual([
    { role: "user", ts: "2026-11-09T11:36:17Z", end_ts: undefined, texts: ["Run background job"] },
    { role: "assistant", ts: "2026-11-09T11:36:25Z", end_ts: "2026-11-09T11:36:40Z", texts: ["Starting job.", "Waiting for it to finish."] },
    { role: "assistant", ts: "2026-11-09T13:09:41Z", end_ts: "2026-11-09T13:10:05Z", texts: ["Checking results.", "All done."] },
  ]);
});
