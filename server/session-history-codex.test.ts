import { expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HEAD_BYTES, listSessions } from "./session-history.ts";

function codexFixture() {
  const home = mkdtempSync(join(tmpdir(), "ovis-codex-resume-"));
  const codexHome = join(home, "codex-profile");
  const cwd = join(home, "project");
  const day = join(codexHome, "sessions", "2026", "10", "20");
  mkdirSync(day, { recursive: true });
  mkdirSync(cwd);
  const startedAt = "2026-10-20T09:00:00.000Z";
  return {
    codexHome,
    cwd,
    startedAt,
    rollout(id: string, message: string | null, folder = cwd, modified = Date.parse(startedAt)) {
      const header = { type: "session_meta", payload: { id, cwd: folder, source: "cli", timestamp: startedAt } };
      const path = join(day, `rollout-2026-10-20T09-00-00-${id.toLowerCase()}.jsonl`);
      const event = { type: "event_msg", payload: { type: "user_message", message } };
      writeFileSync(path, [header, ...(message === null ? [] : [event])].map((record) => JSON.stringify(record)).join("\n") + "\n");
      utimesSync(path, new Date(modified), new Date(modified));
    },
    db() { return new Database(join(codexHome, "state_5.sqlite")); },
    rows() { return listSessions("codex", cwd, { home, codexHome, env: {}, platform: "linux" }); },
    [Symbol.dispose]() { rmSync(home, { recursive: true, force: true }); },
  };
}

const threadId = (value: number) => `00000000-0000-4000-8000-${value.toString(16).padStart(12, "0")}`;
const indexLine = (id: string, thread_name: string) => `${JSON.stringify({ id, thread_name, updated_at: "2026-10-20T09:01:00Z" })}\n`;

it("finds a matching rollout behind 394 newer sessions from another folder", () => {
  using fixture = codexFixture();
  const wanted = threadId(1);
  fixture.rollout(wanted, "Wanted prompt");
  const newer = Date.parse(fixture.startedAt) + 60_000;
  for (let n = 2; n <= 395; n++) fixture.rollout(threadId(n), null, join(fixture.cwd, "other"), newer);

  expect(fixture.rows().map(({ id }) => id)).toEqual([wanted]);
});

it.each([true, false])("does not duplicate a prompt stored in title (name column: %s)", (hasName) => {
  using fixture = codexFixture();
  const id = threadId(1);
  const prompt = "Explain the failing check";
  fixture.rollout(id, null);
  {
    using db = fixture.db();
    db.exec("CREATE TABLE threads (id TEXT PRIMARY KEY, title TEXT, first_user_message TEXT)");
    if (hasName) db.exec("ALTER TABLE threads ADD COLUMN name TEXT");
    db.query("INSERT INTO threads (id, title, first_user_message) VALUES (?, ?, ?)").run(id, prompt, prompt);
  }

  expect(fixture.rows().map(({ title, firstMessage }) => [title, firstMessage])).toEqual([[null, prompt]]);
});

it("reads names within the last 64 KiB, including the line at the window boundary", () => {
  using fixture = codexFixture();
  const outside = threadId(1);
  const boundary = threadId(2);
  fixture.rollout(outside, null);
  fixture.rollout(boundary, null);
  const atBoundary = indexLine(boundary, "Name at the window boundary");
  const tail = atBoundary + " ".repeat(HEAD_BYTES - Buffer.byteLength(atBoundary) - 1) + "\n";
  writeFileSync(join(fixture.codexHome, "session_index.jsonl"), indexLine(outside, "Name before the window") + tail);

  expect(Object.fromEntries(fixture.rows().map(({ id, title }) => [id, title]))).toEqual({
    [outside]: null,
    [boundary]: "Name at the window boundary",
  });
});

it.each([["a blob", Uint8Array.of(255)], ["a number", 73]] as const)("keeps the session list and ignores %s stored as the first message", (_, stored) => {
  using fixture = codexFixture();
  const id = threadId(1);
  fixture.rollout(id, null);
  {
    using db = fixture.db();
    // an untyped column keeps a number as a number (a TEXT column would store "73")
    db.exec("CREATE TABLE threads (id TEXT PRIMARY KEY, title TEXT, first_user_message)");
    db.query("INSERT INTO threads VALUES (?, ?, ?)").run(id, "Still a valid title", stored);
  }

  expect(fixture.rows().map(({ title, firstMessage }) => [title, firstMessage])).toEqual([["Still a valid title", null]]);
});

it("matches Codex UUIDs across letter case in both metadata stores", () => {
  using fixture = codexFixture();
  const sqlite = threadId(0xabc);
  const index = threadId(0xdef);
  fixture.rollout(sqlite, null);
  fixture.rollout(index, null);
  {
    using db = fixture.db();
    db.exec("CREATE TABLE threads (id TEXT PRIMARY KEY, name TEXT)");
    db.query("INSERT INTO threads VALUES (?, ?)").run(sqlite.replace("abc", "AbC"), "SQLite name");
  }
  writeFileSync(join(fixture.codexHome, "session_index.jsonl"), indexLine(index.toUpperCase(), "Index name"));

  expect(Object.fromEntries(fixture.rows().map(({ id, title }) => [id, title]))).toEqual({
    [sqlite]: "SQLite name",
    [index]: "Index name",
  });
});

it("lists saved Codex names and first messages when available (#4799)", () => {
  const home = mkdtempSync(join(tmpdir(), "ovis-codex-resume-"));
  try {
    const codexHome = join(home, "codex-profile");
    const cwd = join(home, "project");
    const day = join(codexHome, "sessions", "2026", "10", "20");
    mkdirSync(day, { recursive: true });
    mkdirSync(cwd);
    const startedAt = "2026-10-20T09:00:00.000Z";
    const sqlite = "00000000-0000-4000-8000-000000000001";
    const index = "00000000-0000-4000-8000-000000000002";
    const prompt = "00000000-0000-4000-8000-000000000003";
    const unlabeled = "00000000-0000-4000-8000-000000000004";
    for (const [id, message] of [[sqlite, null], [index, "First draft"], [prompt, "Explain the failing check"], [unlabeled, null]]) {
      const records = [{ type: "session_meta", payload: { id, cwd, source: "cli", timestamp: startedAt } }];
      const path = join(day, `rollout-2026-10-20T09-00-00-${id}.jsonl`);
      const event = { type: "event_msg", payload: { type: "user_message", message } };
      writeFileSync(path, [...records, ...(message === null ? [] : [event])].map((record) => JSON.stringify(record)).join("\n") + "\n");
      utimesSync(path, new Date(startedAt), new Date(startedAt));
    }
    {
      using db = new Database(join(codexHome, "state_5.sqlite"));
      db.exec("CREATE TABLE threads (id TEXT PRIMARY KEY, title TEXT NOT NULL, first_user_message TEXT NOT NULL)");
      db.query("INSERT INTO threads VALUES (?, ?, ?)").run(sqlite, "Review release notes", "Prompt beyond the rollout head");
      db.query("INSERT INTO threads VALUES (?, ?, ?)").run(index, "Old database label", "");
      db.query("INSERT INTO threads VALUES (?, ?, ?)").run(prompt, " ", "");
    }
    writeFileSync(join(codexHome, "session_index.jsonl"), [
      { id: index, thread_name: "Original name", updated_at: "2026-10-20T09:01:00Z" },
      { id: index, thread_name: "Compare rollout formats", updated_at: "2026-10-20T09:02:00Z" },
    ].map((record) => JSON.stringify(record)).join("\n") + "\n");

    const rows = listSessions("codex", cwd, { home, codexHome, env: {} });

    expect(Object.fromEntries(rows.map((row) => [row.id, [row.title, row.firstMessage, row.startedAt]]))).toEqual({
      [sqlite]: ["Review release notes", "Prompt beyond the rollout head", startedAt],
      [index]: ["Compare rollout formats", "First draft", startedAt],
      [prompt]: [null, "Explain the failing check", startedAt],
      [unlabeled]: [null, null, startedAt],
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
