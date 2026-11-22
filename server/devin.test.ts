import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DevinHistoryChanged, DevinHistoryUnavailable, devinConversation, forgetDevinState } from "./devin.ts";

const dirs: string[] = [];
const databases: Database[] = [];
afterEach(() => {
  forgetDevinState();
  for (const db of databases.splice(0)) { try { db.close(); } catch {} }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "devin-test-"));
  dirs.push(dir);
  const dbPath = join(dir, "sessions.db");
  const db = new Database(dbPath);
  databases.push(db);
  db.exec("PRAGMA journal_mode=WAL; CREATE TABLE sessions(id TEXT, working_directory TEXT, main_chain_id INTEGER, hidden INTEGER, model TEXT); CREATE TABLE message_nodes(session_id TEXT,node_id INTEGER,parent_node_id INTEGER,chat_message TEXT,created_at INTEGER); CREATE TABLE tool_call_state(session_id TEXT,tool_call_id TEXT,tool_call_json TEXT,tool_call_update_json TEXT)");
  const cwd = "/synthetic/work";
  db.query("INSERT INTO sessions VALUES (?, ?, ?, 0, NULL)").run("one", cwd, null);
  const node = (id: number, parent: number | null, message: unknown, session = "one") => {
    db.query("INSERT INTO message_nodes VALUES (?, ?, ?, ?, ?)").run(session, id, parent, typeof message === "string" ? message : JSON.stringify(message), 1_700_000_000 + id);
    db.query("UPDATE sessions SET main_chain_id = ? WHERE id = ?").run(id, session);
  };
  return { db, dbPath, cwd, node, pageFor: (session: string, options: Parameters<typeof devinConversation>[2] = {}) => devinConversation(session, cwd, options, dbPath), page: (options: Parameters<typeof devinConversation>[2] = {}) => devinConversation("one", cwd, options, dbPath) };
}

test("reads only the exact visible session in its working directory", () => {
  const f = fixture();
  f.db.query("INSERT INTO sessions VALUES ('two', ?, NULL, 0, NULL)").run(f.cwd);
  f.db.query("INSERT INTO sessions VALUES ('hidden', ?, NULL, 1, NULL)").run(f.cwd);
  expect(f.page().turns).toEqual([]);
  expect(f.page().cursor).toBeNull();
  expect(() => devinConversation("one' OR 1=1 --", f.cwd, {}, f.dbPath)).toThrow();
  expect(() => devinConversation("hidden", f.cwd, {}, f.dbPath)).toThrow();
  expect(() => devinConversation("two", "/other", {}, f.dbPath)).toThrow();
});

test("reads WAL tool states and results while excluding abandoned branches", () => {
  const f = fixture();
  f.node(1, null, { role: "user", content: "synthetic question" });
  f.node(2, 1, { role: "assistant", content: "synthetic answer", thinking: "synthetic reasoning", metadata: { generation_model: "synthetic-model" }, tool_calls: [{ id: "call-1", name: "synthetic_tool", arguments: { n: 1 } }] });
  f.node(3, 2, { role: "tool", tool_call_id: "call-1", content: "synthetic result", is_error: true });
  f.node(4, 1, { role: "assistant", content: "abandoned" });
  f.db.query("UPDATE sessions SET main_chain_id = 3 WHERE id = 'one'").run();
  f.db.query("INSERT INTO tool_call_state VALUES ('one', 'call-1', '{}', ?)").run(JSON.stringify({ status: "error", content: "synthetic updated result" }));
  const first = f.page();
  expect(first.source).toBe("devin-transcript");
  expect(first.turns.map((turn) => turn.role)).toEqual(["user", "assistant"]);
  expect(first.turns[1]!.parts).toEqual([
    { kind: "thinking", text: "synthetic reasoning" },
    { kind: "text", text: "synthetic answer" },
    { kind: "tool", name: "synthetic_tool", summary: "synthetic_tool", input: "{\"n\":1}", output: "synthetic result", error: true },
  ]);
  expect(first.metadata.model).toBe("synthetic-model");
  expect(first.turns[0]!.ts).toBe("2023-11-14T22:13:21.000Z");
  f.db.query("UPDATE tool_call_state SET tool_call_update_json = ? WHERE tool_call_id = 'call-1'").run(JSON.stringify({ status: "failed", content: "changed" }));
  expect(f.page().version).not.toBe(first.version);
});

test("pages by the prompts a chat asks for, each page starting at a prompt", () => {
  const f = fixture();
  ["one", "two", "three", "four", "five", "six"].forEach((content, index) => f.node(index + 1, index === 0 ? null : index, { role: index % 2 === 0 ? "user" : "assistant", content }));
  const texts = (page: ReturnType<typeof f.page>) => page.turns.map((turn) => (turn.parts[0] as { text: string }).text);
  const newest = f.page({ prompts: 1 });
  expect(texts(newest)).toEqual(["five", "six"]);
  const older = f.page({ before: newest.cursor!, prompts: 2 });
  expect(texts(older)).toEqual(["one", "two", "three", "four"]);
  expect(older.cursor).toBeNull();
  expect(texts(f.page())).toEqual(["one", "two", "three", "four", "five", "six"]);
});

test("pagination, grouping, append and branch replacement", () => {
  const f = fixture();
  f.node(1, null, { role: "user", content: "one" });
  f.node(2, 1, { role: "assistant", content: "two" });
  f.node(3, 2, { role: "assistant", content: "continuation" });
  f.node(4, 3, { role: "user", content: "three" });
  const latest = f.page({ limit: 2 });
  expect(latest.turns.map((turn) => turn.role)).toEqual(["assistant", "user"]);
  expect(latest.turns[0]!.parts).toHaveLength(2);
  expect(f.page({ before: latest.cursor!, limit: 2 }).turns[0]!.parts).toEqual([{ kind: "text", text: "one" }]);
  expect(f.page({ from: latest.cursor! }).turns.length).toBe(2);
  f.node(5, 4, { role: "assistant", content: "four" });
  expect(f.page().history_id).toBe(latest.history_id);
  expect(JSON.parse(f.page({ from: latest.cursor!, limit: 1 }).cursor!)).toEqual(["one", expect.any(String), 0, 5]);
  expect(() => f.page({ before: JSON.stringify(["foreign", 0, 2]) })).toThrow(DevinHistoryChanged);
  f.db.query("UPDATE sessions SET main_chain_id = 1 WHERE id = 'one'").run();
  expect(f.page().history_id).not.toBe(latest.history_id);
  expect(() => f.page({ before: latest.cursor! })).toThrow(DevinHistoryChanged);
});

test("malformed content and prelude do not create empty pages", () => {
  const f = fixture();
  f.node(1, null, { role: "system", content: "setup" });
  f.node(2, 1, "{malformed");
  f.node(3, 2, { role: "unknown", content: "ignored" });
  f.node(4, 3, { role: "assistant", content: "valid" });
  expect(f.page().turns.map((turn) => turn.parts)).toEqual([[{ kind: "text", text: "valid" }]]);
  expect(f.page().cursor).toBeNull();
  f.db.query("UPDATE sessions SET main_chain_id = 999 WHERE id = 'one'").run();
  expect(() => f.page()).toThrow(DevinHistoryUnavailable);
});

test("invalid native timestamps do not abort the conversation", () => {
  const f = fixture();
  f.node(1, null, { role: "user", content: "synthetic" });
  f.db.query("UPDATE message_nodes SET created_at = ? WHERE node_id = 1").run(1e20);
  expect(f.page().turns[0]?.ts).toBeNull();
});

test("long ancestry excludes unrelated branches and bounds excessive chains", () => {
  const f = fixture();
  f.db.exec("CREATE INDEX node_identity ON message_nodes(session_id, node_id)");
  const insert = f.db.query("INSERT INTO message_nodes VALUES ('one', ?, ?, ?, 1700000000)");
  f.db.exec("BEGIN");
  for (let i = 1; i <= 1200; i++) insert.run(i, i === 1 ? null : i - 1, JSON.stringify({ role: "user", content: `active ${i}` }));
  for (let i = 1201; i <= 2400; i++) insert.run(i, i === 1201 ? 1 : i - 1, JSON.stringify({ role: "assistant", content: "unrelated" }));
  f.db.query("UPDATE sessions SET main_chain_id = 1200 WHERE id = 'one'").run();
  f.db.exec("COMMIT");
  const active = f.page({ limit: 2 });
  expect(active.turns.map((turn) => turn.parts[0])).toEqual([{ kind: "text", text: "active 1199" }, { kind: "text", text: "active 1200" }]);
  insert.run(2401, 2400, JSON.stringify({ role: "user", content: "another abandoned node" }));
  expect(f.page({ limit: 2 }).version).toBe(active.version);
  f.db.query("UPDATE sessions SET main_chain_id = 2400 WHERE id = 'one'").run();
  expect(f.page().history_id).not.toBe(active.history_id);
  f.db.query("UPDATE sessions SET main_chain_id = 5001 WHERE id = 'one'").run();
  expect(() => f.page()).toThrow(DevinHistoryUnavailable);
});

test("groups assistant continuations across tool nodes and ignores unknown content", () => {
  const f = fixture();
  f.node(1, null, { role: "user", content: { unsupported: true } });
  f.node(2, 1, { role: "assistant", tool_calls: [{ id: "call", name: "check", arguments: {} }] });
  f.node(3, 2, { role: "tool", tool_call_id: "call", content: "synthetic output" });
  f.node(4, 3, { role: "assistant", content: "synthetic answer" });
  expect(f.page().turns).toMatchObject([{ role: "assistant", parts: [
    { kind: "tool", output: "synthetic output" }, { kind: "text", text: "synthetic answer" },
  ] }]);
});

test("returns a dedicated unavailable error for a chain longer than the bounded reader window", () => {
  const f = fixture();
  f.db.exec("CREATE INDEX node_identity ON message_nodes(session_id, node_id); BEGIN");
  const insert = f.db.query("INSERT INTO message_nodes VALUES ('one', ?, ?, '{\"role\":\"user\",\"content\":\"synthetic\"}', 1700000000)");
  for (let i = 1; i <= 5001; i++) insert.run(i, i === 1 ? null : i - 1);
  f.db.query("UPDATE sessions SET main_chain_id = 5001 WHERE id = 'one'").run();
  f.db.exec("COMMIT");
  expect(() => f.page()).toThrow(DevinHistoryUnavailable);
});

test("accepts exactly 5000 ancestry nodes and exactly 8 MiB of UTF-8 history", () => {
  const f = fixture();
  f.db.exec("CREATE INDEX node_identity ON message_nodes(session_id, node_id); BEGIN");
  const insert = f.db.query("INSERT INTO message_nodes VALUES ('one', ?, ?, '{\"role\":\"user\",\"content\":\"x\"}', 1700000000)");
  for (let id = 1; id <= 5000; id++) insert.run(id, id === 1 ? null : id - 1);
  f.db.query("UPDATE sessions SET main_chain_id = 5000 WHERE id = 'one'").run();
  f.db.exec("COMMIT");
  expect(f.page().turns).toHaveLength(100);

  forgetDevinState();
  const exact = fixture();
  const prefix = '{"role":"user","content":"';
  const suffix = '"}';
  const payload = prefix + "x".repeat(8 * 1024 * 1024 - Buffer.byteLength(prefix) - Buffer.byteLength(suffix)) + suffix;
  expect(Buffer.byteLength(payload)).toBe(8 * 1024 * 1024);
  exact.node(1, null, payload);
  expect(exact.page().turns).toHaveLength(1);
});

test("rejects histories over the byte limit even when SQLite character length is smaller", () => {
  const f = fixture();
  const prefix = '{"role":"user","content":"';
  const suffix = '"}';
  const content = "한".repeat(Math.ceil((8 * 1024 * 1024 - Buffer.byteLength(prefix) - Buffer.byteLength(suffix) + 1) / 3));
  const payload = prefix + content + suffix;
  expect(Buffer.byteLength(payload)).toBeGreaterThan(8 * 1024 * 1024);
  expect(payload.length).toBeLessThan(8 * 1024 * 1024);
  f.node(1, null, payload);
  expect(() => f.page()).toThrow(DevinHistoryUnavailable);
});

test("maps unreadable, malformed and locked stores to a dedicated unavailable error", () => {
  const f = fixture();
  f.node(1, null, { role: "user", content: "synthetic" });
  expect(() => devinConversation("one", f.cwd, {}, join(f.dbPath, "missing.db"))).toThrow(DevinHistoryUnavailable);
  f.db.exec("DROP TABLE message_nodes");
  expect(() => f.page()).toThrow(DevinHistoryUnavailable);
  f.db.exec("CREATE TABLE message_nodes(session_id TEXT,node_id INTEGER,parent_node_id INTEGER,chat_message TEXT,created_at INTEGER)");
  f.node(1, null, { role: "user", content: "synthetic" });
  f.db.exec("PRAGMA journal_mode=DELETE; BEGIN EXCLUSIVE");
  try { expect(() => f.page()).toThrow(DevinHistoryUnavailable); }
  finally { f.db.exec("ROLLBACK"); }
});

test("touches sessions in the LRU so another insertion does not evict a recently read history", () => {
  const f = fixture();
  f.node(1, null, { role: "user", content: "original branch" });
  f.node(2, 1, { role: "assistant", content: "answer" });
  const original = f.page({ limit: 1 });
  expect(original.cursor).not.toBeNull();
  for (let index = 1; index <= 63; index++) {
    const session = `other-${index}`;
    f.db.query("INSERT INTO sessions VALUES (?, ?, NULL, 0, NULL)").run(session, f.cwd);
    f.pageFor(session);
  }
  expect(f.page().history_id).toBe(original.history_id);
  const next = "other-64";
  f.db.query("INSERT INTO sessions VALUES (?, ?, NULL, 0, NULL)").run(next, f.cwd);
  f.pageFor(next);
  expect(f.page().history_id).toBe(original.history_id);
  expect(f.page({ before: original.cursor!, limit: 1 }).turns[0]?.parts[0]).toEqual({ kind: "text", text: "original branch" });
});

test("rejects stale cursors after explicit cache reset and LRU eviction", () => {
  const f = fixture();
  f.node(1, null, { role: "user", content: "first" });
  f.node(2, 1, { role: "assistant", content: "second" });
  const first = f.page({ limit: 1 });
  expect(first.cursor).not.toBeNull();
  forgetDevinState("one", f.cwd, f.dbPath);
  expect(f.page().history_id).not.toBe(first.history_id);
  expect(() => f.page({ before: first.cursor!, limit: 1 })).toThrow(DevinHistoryChanged);

  forgetDevinState();
  const eviction = f.page({ limit: 1 });
  for (let index = 1; index <= 64; index++) {
    const session = `eviction-${index}`;
    f.db.query("INSERT INTO sessions VALUES (?, ?, NULL, 0, NULL)").run(session, f.cwd);
    f.pageFor(session);
  }
  expect(f.page().history_id).not.toBe(eviction.history_id);
  expect(() => f.page({ before: eviction.cursor!, limit: 1 })).toThrow(DevinHistoryChanged);
});

test("reads complete serialized tool-state JSON before trimming displayed output", () => {
  const f = fixture();
  const output = "x".repeat(100 * 1024);
  f.node(1, null, { role: "user", content: "run a tool" });
  f.node(2, 1, { role: "assistant", tool_calls: [{ id: "call", name: "synthetic_tool", arguments: {} }] });
  f.db.query("INSERT INTO tool_call_state VALUES ('one', 'call', '{}', ?)").run(JSON.stringify({ status: "completed", content: output }));
  const part = f.page().turns[1]?.parts[0];
  expect(part?.kind === "tool" ? part.output : null).toBe(`${"x".repeat(64 * 1024)}\n… trimmed`);
});

test("preflights and rejects tool-state data larger than its byte bound", () => {
  const f = fixture();
  f.node(1, null, { role: "user", content: "run a tool" });
  f.node(2, 1, { role: "assistant", tool_calls: [{ id: "call", name: "synthetic_tool", arguments: {} }] });
  f.db.query("INSERT INTO tool_call_state VALUES ('one', 'call', '{}', ?)").run(JSON.stringify({ status: "completed", content: "x".repeat(8 * 1024 * 1024) }));
  expect(() => f.page()).toThrow(DevinHistoryUnavailable);
});

test("includes session-model changes in the response version", () => {
  const f = fixture();
  f.node(1, null, { role: "user", content: "question" });
  const original = f.page();
  f.db.query("UPDATE sessions SET model = 'changed-model' WHERE id = 'one'").run();
  const changed = f.page();
  expect(changed.history_id).toBe(original.history_id);
  expect(changed.version).not.toBe(original.version);
});

test("replacing history after an LRU touch keeps its original generation until replacement", () => {
  const f = fixture();
  f.node(1, null, { role: "user", content: "original branch" });
  const original = f.page();
  for (let index = 1; index <= 63; index++) {
    const session = `replacement-${index}`;
    f.db.query("INSERT INTO sessions VALUES (?, ?, NULL, 0, NULL)").run(session, f.cwd);
    f.pageFor(session);
  }
  expect(f.page().history_id).toBe(original.history_id);
  f.node(2, null, { role: "user", content: "replacement branch" });
  expect(f.page().history_id).not.toBe(original.history_id);
});

test("renders a tool call id listed many times once, so one stored output is not multiplied", () => {
  const f = fixture();
  f.node(1, null, { role: "user", content: "synthetic question" });
  f.node(2, 1, { role: "assistant", content: "", tool_calls: Array.from({ length: 2000 }, () => ({ id: "call-1", name: "synthetic_tool", arguments: {} })) });
  f.db.query("INSERT INTO tool_call_state VALUES ('one', 'call-1', '{}', ?)").run(JSON.stringify({ content: "x".repeat(64 * 1024) }));
  const page = f.page();
  expect(page.turns[1]!.parts.length).toBe(1);
  expect(JSON.stringify(page).length).toBeLessThan(128 * 1024);
});

test("refuses node ids SQLite holds exactly and JavaScript would round to a sibling", () => {
  const f = fixture();
  const insert = f.db.query("INSERT INTO message_nodes VALUES ('one', CAST(? AS INTEGER), NULL, ?, 1700000000)");
  insert.run("9007199254740992", JSON.stringify({ role: "user", content: "sibling branch" }));
  insert.run("9007199254740993", JSON.stringify({ role: "user", content: "selected branch" }));
  f.db.exec("UPDATE sessions SET main_chain_id = 9007199254740993 WHERE id = 'one'");
  expect(() => f.page()).toThrow(DevinHistoryUnavailable);
});

/** The rows a real Devin CLI 3000.11.3 session wrote, in its own column layout (server/fixtures). */
function realSession() {
  const rows = JSON.parse(readFileSync(join(import.meta.dir, "fixtures", "devin-3000.11.3-session.json"), "utf8")) as Record<"sessions" | "message_nodes" | "tool_call_state", Record<string, unknown>[]>;
  const dir = mkdtempSync(join(tmpdir(), "devin-real-"));
  dirs.push(dir);
  const dbPath = join(dir, "sessions.db");
  const db = new Database(dbPath);
  databases.push(db);
  db.exec("PRAGMA journal_mode=WAL");
  db.transaction(() => {
    for (const table of ["sessions", "message_nodes", "tool_call_state"] as const) {
      const columns = Object.keys(rows[table][0]!);
      db.exec(`CREATE TABLE ${table}(${columns.join(",")})`);
      const insert = db.query(`INSERT INTO ${table} VALUES (${columns.map(() => "?").join(",")})`);
      for (const row of rows[table]) insert.run(...columns.map((column) => row[column] as string | number | null));
    }
  })();
  return devinConversation("rift-gallimimus", "/work/project", {}, dbPath);
}

test("reads a real Devin CLI session: the resumed main chain, its tool call and output, no abandoned copies", () => {
  const page = realSession();
  expect(page.turns.map((turn) => turn.role)).toEqual(["user", "assistant", "user", "assistant", "user", "assistant"]);
  const texts = page.turns.map((turn) => turn.parts.filter((part) => part.kind === "text").map((part) => part.kind === "text" ? part.text : ""));
  expect(texts).toEqual([
    ["Run ls in this directory and tell me the file names, nothing else."], ["alpha.txt\nbeta.txt"],
    ["Thanks. Now reply with just the word done."], ["done"],
    ["Reply with just ok."], ["ok"],
  ]);
  const tools = page.turns.flatMap((turn) => turn.parts.filter((part) => part.kind === "tool"));
  expect(tools).toHaveLength(1);
  expect(tools[0]).toMatchObject({ kind: "tool", name: "exec", input: "{\"command\":\"ls\"}" });
  expect(tools[0]!.kind === "tool" && tools[0]!.output).toContain("alpha.txt\nbeta.txt");
  expect(page.metadata.model).toBe("swe-1-6-slow");
});

test("shows a real Devin session's reasoning, which it stores as an object", () => {
  const page = realSession();
  expect(page.turns[1]!.parts.map((part) => part.kind)).toEqual(["thinking", "tool", "thinking", "text"]);
  const first = page.turns[1]!.parts[0]!;
  expect(first.kind === "thinking" && first.text).toStartWith("The user wants me to run `ls`");
});

test("takes a message time only as a zoned ISO time, read as milliseconds", () => {
  const f = fixture();
  f.node(1, null, { role: "user", content: "old", metadata: { created_at: "1971-01-01T00:00:00Z" } });
  f.node(2, 1, { role: "assistant", content: "no zone", metadata: { created_at: "2026-10-08T12:28:40.410481575" } });
  f.node(3, 2, { role: "user", content: "not a time", metadata: { created_at: "-1" } });
  f.node(4, 3, { role: "assistant", content: "offset", metadata: { created_at: "2026-10-08T21:28:40.410481575+09:00" } });
  expect(f.page().turns.map((turn) => turn.ts)).toEqual([
    "1971-01-01T00:00:00.000Z", "2023-11-14T22:13:22.000Z", "2023-11-14T22:13:23.000Z", "2026-10-08T12:28:40.410Z",
  ]);
});

test("labels a real Devin tool call with the title Devin shows for it", () => {
  const tool = realSession().turns[1]!.parts.find((part) => part.kind === "tool");
  expect(tool).toMatchObject({ name: "exec", summary: "Listed ./" });
});

test("dates a real Devin turn by its message, not by the save that rewrote every row", () => {
  const page = realSession();
  expect(page.turns.map((turn) => [turn.ts, turn.end_ts ?? null])).toEqual([
    ["2026-10-08T12:28:40.410Z", null], ["2026-10-08T12:28:42.873Z", "2026-10-08T12:28:44.463Z"],
    ["2026-10-08T12:29:19.031Z", null], ["2026-10-08T12:29:20.560Z", null],
    ["2026-10-08T12:30:21.694Z", null], ["2026-10-08T12:30:23.515Z", null],
  ]);
});
