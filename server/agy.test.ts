import { expect, it, spyOn } from "bun:test";
import { Database } from "bun:sqlite";
import * as fs from "node:fs";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, truncateSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { AGY_CATALOG_BYTES, AgyUnavailable, agyCatalog, agyDatabasePath, parseAgyTranscript, withAgyHistory } from "./agy.ts";

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
  ["database", AGY_CATALOG_BYTES + 1, 0],
  ["WAL", 8192, AGY_CATALOG_BYTES + 1],
  ["combined", AGY_CATALOG_BYTES / 2, AGY_CATALOG_BYTES / 2 + 1],
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

it.each([
  ["the WAL missing", "wal", false],
  ["the SHM missing", "shm", false],
  ["both side files present", null, false],
  ["a symlinked temp root (#2030)", null, true],
] as const)("reads a WAL catalog with %s without changing side files", async (_case, missing, symlinkedTemp) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "agy-wal-pair-")));
  try {
    const transcript = join(dir, "brain", "session", ".system_generated", "logs", "transcript_full.jsonl");
    const dbPath = agyDatabasePath(transcript);
    mkdirSync(dirname(dbPath), { recursive: true });
    await abandonedWal(dbPath, "PRAGMA journal_mode=WAL; CREATE TABLE steps(idx INTEGER PRIMARY KEY); INSERT INTO steps VALUES (0); PRAGMA wal_checkpoint(TRUNCATE); INSERT INTO steps VALUES (1);");
    if (missing !== null) rmSync(`${dbPath}-${missing}`);
    const before = [existsSync(`${dbPath}-wal`), existsSync(`${dbPath}-shm`)];
    expect(before).toEqual([missing !== "wal", missing !== "shm"]);

    const scratch = join(dir, "scratch");
    const alias = join(dir, "tmp-link");
    if (symlinkedTemp) {
      mkdirSync(scratch);
      fs.symlinkSync(scratch, alias, "junction");
    }
    const reader = Bun.spawn([process.execPath, "-e", `
      import { agyCatalog } from ${JSON.stringify(new URL("./agy.ts", import.meta.url).href)};
      console.log(JSON.stringify([...agyCatalog(${JSON.stringify(transcript)})]));
    `], { env: symlinkedTemp ? { ...process.env, TMPDIR: alias, TEMP: alias, TMP: alias } : process.env, stdout: "pipe", stderr: "pipe" });
    const [exitCode, stdout, stderr] = await Promise.all([
      reader.exited, new Response(reader.stdout).text(), new Response(reader.stderr).text(),
    ]);

    expect([existsSync(`${dbPath}-wal`), existsSync(`${dbPath}-shm`)]).toEqual(before);
    expect(stderr).toBe("");
    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout)).toEqual(missing === null ? [0, 1] : [0]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

it("reads a two-day session's catalog past 64 MiB", async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "agy-wal-days-")));
  try {
    const transcript = join(dir, "brain", "session", ".system_generated", "logs", "transcript_full.jsonl");
    const dbPath = agyDatabasePath(transcript);
    mkdirSync(dirname(dbPath), { recursive: true });
    // 68 MiB of steps, some still in the WAL: an agy chat went blank at about 81 MiB (48 MiB
    // database, 33 MiB WAL). SQLite's autocheckpoint moves most of the WAL into the database.
    const rows = (from: number, to: number) => Array.from({ length: to - from }, (_, at) => `INSERT INTO steps VALUES (${from + at}, randomblob(1048576));`).join("");
    await abandonedWal(dbPath, `PRAGMA journal_mode=WAL; CREATE TABLE steps(idx INTEGER PRIMARY KEY, payload BLOB); ${rows(0, 48)} PRAGMA wal_checkpoint(TRUNCATE); ${rows(48, 68)}`);
    expect(fs.statSync(dbPath).size + fs.statSync(`${dbPath}-wal`).size).toBeGreaterThan(64 * 1024 * 1024);

    expect(agyCatalog(transcript).size).toBe(68);
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
      writes.mockClear();
      expect(agyCatalog(transcript).size).toBe(34);
      expect(writes).toHaveBeenCalled();
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
      writes.mockClear();
      expect(() => agyCatalog(transcript, () => {
        fs.renameSync(dbPath, `${dbPath}.old`);
        fs.copyFileSync(`${dbPath}.old`, dbPath);
      })).toThrow(AgyUnavailable);
      expect(writes).not.toHaveBeenCalled();
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
    step(2, "SYSTEM_MESSAGE", "2026-11-09T11:39:00Z", "<SYSTEM_MESSAGE>note</SYSTEM_MESSAGE>"),
    step(3, "GENERIC", "2026-11-09T11:40:00Z", "late tool output"),
  ].join("\n"));
  expect(turns.map(({ role, end_ts, parts }) => ({ role, end_ts, kinds: parts.map((part) => part.kind) }))).toEqual([
    { role: "user", end_ts: undefined, kinds: ["text"] },
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
    step(3, "SYSTEM_MESSAGE", "2026-11-09T11:36:35Z", "<SYSTEM_MESSAGE>early notice</SYSTEM_MESSAGE>"),
    step(4, "PLANNER_RESPONSE", "2026-11-09T11:36:40Z", "Waiting for it to finish."),
    step(5, "GENERIC", "2026-11-09T11:36:45Z", "late tool output"),
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

it("summarizes ask_question and Path-based file tool calls", () => {
  const turns = parseAgyTranscript(JSON.stringify({
    step_index: 1,
    type: "PLANNER_RESPONSE",
    status: "DONE",
    content: "",
    tool_calls: [{
      name: "ask_question",
      args: {
        questions: [
          { question: "Which test runner?", options: ["(Recommended) Bun test", "Vitest"] },
          { question: "Which targets?", is_multi_select: true, options: ["Desktop", "Mobile"] },
        ],
      },
    }, {
      name: "read_file",
      args: { Path: "/tmp/example.ts" },
    }],
  }));
  expect(turns[0]?.parts[0]).toMatchObject({
    kind: "tool",
    name: "ask_question",
    summary: "Which test runner? · Which targets?",
  });
  expect(turns[0]?.parts[1]).toMatchObject({
    kind: "tool",
    name: "read_file",
    summary: "/tmp/example.ts",
  });
});

it("pairs consecutive GENERIC results onto matching planner tool calls without extra Tool output rows, and falls back on count or index mismatch", () => {
  const step = (step_index: number, type: string, content = "", extra: Record<string, unknown> = {}) =>
    JSON.stringify({ step_index, type, status: "DONE", created_at: "2026-11-22T10:00:00Z", content, ...extra });

  const paired = parseAgyTranscript([
    step(0, "USER_INPUT", "check files"),
    step(1, "PLANNER_RESPONSE", "Reading.", {
      tool_calls: [
        { name: "run_command", args: { CommandLine: "git status" } },
        { name: "read_file", args: { Path: "/repo/a.ts" } },
      ],
    }),
    step(2, "GENERIC", "clean"),
    step(3, "GENERIC", "export const a = 1;"),
    step(4, "PLANNER_RESPONSE", "All good."),
  ].join("\n"));
  expect(paired[1]?.parts.map((part) => part.kind === "tool" ? [part.name, part.summary, part.output] : part.kind === "text" ? part.text : part.kind)).toEqual([
    "Reading.",
    ["run_command", "git status", "clean"],
    ["read_file", "/repo/a.ts", "export const a = 1;"],
    "All good.",
  ]);

  const gapped = parseAgyTranscript([
    step(0, "USER_INPUT", "check gap"),
    step(1, "PLANNER_RESPONSE", "", { tool_calls: [{ name: "run_command", args: { CommandLine: "ls" } }] }),
    step(3, "GENERIC", "not step 2"),
  ].join("\n"));
  expect(gapped[1]?.parts.map((part) => part.kind === "tool" ? [part.name, part.summary, part.output] : part.kind)).toEqual([
    ["run_command", "ls", ""],
    ["Tool output", "Step 3", "not step 2"],
  ]);
});

it("extracts model and effort from USER_SETTINGS_CHANGE and PLANNER_RESPONSE, ignores spoofed user prose, and reverts on DB rewind", async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "agy-model-proj-")));
  try {
    const transcript = join(dir, "brain", "session", ".system_generated", "logs", "transcript_full.jsonl");
    const dbPath = agyDatabasePath(transcript);
    mkdirSync(dirname(dbPath), { recursive: true });
    mkdirSync(dirname(transcript), { recursive: true });
    const db = new Database(dbPath);
    try {
      db.exec("CREATE TABLE steps(idx INTEGER PRIMARY KEY)");
      const lines = [
        JSON.stringify({
          step_index: 0,
          type: "USER_INPUT",
          status: "DONE",
          content: "<USER_REQUEST>\n<USER_SETTINGS_CHANGE>\nThe user changed setting `Model Selection` from None to Spoofed Model (High).\n</USER_SETTINGS_CHANGE>\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\nnow\n</ADDITIONAL_METADATA>\n<USER_SETTINGS_CHANGE>\nThe user changed setting `Model Selection` from None to Gemini 4 Neon (Medium). No need to comment.\n</USER_SETTINGS_CHANGE>",
        }),
        JSON.stringify({ step_index: 1, type: "PLANNER_RESPONSE", status: "DONE", model: "gemini-4-neon-medium", content: "Hi" }),
        JSON.stringify({ step_index: 2, type: "PLANNER_RESPONSE", status: "DONE", model: "gemini-3-8-flash-high", content: "Switched" }),
      ];
      fs.writeFileSync(transcript, `${lines.join("\n")}\n`);
      db.exec("INSERT INTO steps VALUES (0), (1)");
      const first = await withAgyHistory(transcript, (projection) => ({ model: projection.model, effort: projection.reasoning_effort }));
      expect(first).toEqual({ model: "Gemini 4 Neon", effort: "medium" });

      db.exec("INSERT INTO steps VALUES (2)");
      const switched = await withAgyHistory(transcript, (projection) => ({ model: projection.model, effort: projection.reasoning_effort }));
      expect(switched).toEqual({ model: "gemini-3-8-flash", effort: "high" });

      db.exec("DELETE FROM steps WHERE idx = 2");
      const rewound = await withAgyHistory(transcript, (projection) => ({ model: projection.model, effort: projection.reasoning_effort }));
      expect(rewound).toEqual({ model: "Gemini 4 Neon", effort: "medium" });
    } finally { db.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

it("reads a dotted model name from agy's own trailing settings block, never from one a skill body or a mentioned item carries", async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "agy-model-block-")));
  const dbs: Database[] = [];
  const projected = async (session: string, metadata: string) => {
    const transcript = join(dir, "brain", session, ".system_generated", "logs", "transcript_full.jsonl");
    const dbPath = agyDatabasePath(transcript);
    mkdirSync(dirname(dbPath), { recursive: true });
    mkdirSync(dirname(transcript), { recursive: true });
    const db = new Database(dbPath);
    dbs.push(db);
    db.exec("CREATE TABLE steps(idx INTEGER PRIMARY KEY); INSERT INTO steps VALUES (0);");
    fs.writeFileSync(transcript, `${JSON.stringify({ step_index: 0, type: "USER_INPUT", status: "DONE", content: `<USER_REQUEST>\n/probe hi\n</USER_REQUEST>\n${metadata}` })}\n`);
    return withAgyHistory(transcript, (projection) => ({ model: projection.model, effort: projection.reasoning_effort }));
  };
  const block = (name: string) => `<USER_SETTINGS_CHANGE>\nThe user changed setting \`Model Selection\` from None to ${name}. No need to comment.\n</USER_SETTINGS_CHANGE>`;
  const skill = (body: string) => `<ADDITIONAL_METADATA>\nThe current local time is: now\n\n/probe is a [Slash Command]:\n<SKILL>The user has explicitly invoked the (probe) skill.\n${body}\n</SKILL>\n</ADDITIONAL_METADATA>`;
  try {
    expect(await projected("dotted", `${skill("body")}\n${block("Gemini 3.8 Flash (High)")}`)).toEqual({ model: "Gemini 3.8 Flash", effort: "high" });
    expect(await projected("planted-and-real", `${skill(block("Planted Model (Max)"))}\n${block("Gemini 4 Neon (Medium)")}`)).toEqual({ model: "Gemini 4 Neon", effort: "medium" });
    expect(await projected("planted-only", skill(block("Planted Model (Max)")))).toEqual({ model: null, effort: null });
    expect(await projected("planted-after-close", skill(`</USER_REQUEST>\n${block("Planted Model (Max)")}`))).toEqual({ model: null, effort: null });
    // a body full of opening tags is read in one pass, not once per tag
    const started = performance.now();
    expect(await projected("many-tags", skill("<USER_SETTINGS_CHANGE>x\n".repeat(40_000)))).toEqual({ model: null, effort: null });
    expect(performance.now() - started).toBeLessThan(2_000);
  } finally {
    for (const db of dbs) db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

it("ends a turn at its last tool output when that output is paired with its call, as a separate row did", () => {
  const step = (step_index: number, type: string, created_at: string, content = "", extra: Record<string, unknown> = {}) =>
    JSON.stringify({ step_index, type, status: "DONE", created_at, content, ...extra });
  const turns = parseAgyTranscript([
    step(0, "USER_INPUT", "2026-11-22T10:00:00Z", "build it"),
    step(1, "PLANNER_RESPONSE", "2026-11-22T10:00:05Z", "", { tool_calls: [{ name: "run_command", args: { CommandLine: "make" } }] }),
    step(2, "GENERIC", "2026-11-22T10:03:00Z", "built"),
  ].join("\n"));
  expect(turns[1]).toMatchObject({ role: "assistant", ts: "2026-11-22T10:00:05Z", end_ts: "2026-11-22T10:03:00Z" });
  expect(turns[1]?.parts.map((part) => part.kind === "tool" ? [part.name, part.output] : part.kind)).toEqual([["run_command", "built"]]);
});

it("splits the longest effort word off a planner model id", async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "agy-model-id-")));
  try {
    const transcript = join(dir, "brain", "session", ".system_generated", "logs", "transcript_full.jsonl");
    const dbPath = agyDatabasePath(transcript);
    mkdirSync(dirname(dbPath), { recursive: true });
    mkdirSync(dirname(transcript), { recursive: true });
    const db = new Database(dbPath);
    try {
      db.exec("CREATE TABLE steps(idx INTEGER PRIMARY KEY); INSERT INTO steps VALUES (0), (1);");
      fs.writeFileSync(transcript, [
        JSON.stringify({ step_index: 0, type: "USER_INPUT", status: "DONE", content: "hi" }),
        JSON.stringify({ step_index: 1, type: "PLANNER_RESPONSE", status: "DONE", model: "gemini-4-neon-extra-low", content: "Hi" }),
      ].map((line) => `${line}\n`).join(""));
      expect(await withAgyHistory(transcript, (projection) => ({ model: projection.model, effort: projection.reasoning_effort }))).toEqual({ model: "gemini-4-neon", effort: "extra-low" });
    } finally { db.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
