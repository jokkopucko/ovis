import { afterAll, describe, expect, it, spyOn } from "bun:test";
import { Database, type SQLQueryBindings } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { HerdrPane } from "../shared/protocol.ts";
import { handleTasksRequest } from "./tasks-routes.ts";
import { opencodeSubagentState, OpencodeSubagentStatus, pagedState, readSubagents, RUNNING_LIMIT, SUBAGENT_PAGE } from "./opencode-subagents.ts";
import { withStore } from "./opencode.ts";

const root = mkdtempSync(join(tmpdir(), "herdr-opencode-subagents-"));
const opened: Database[] = [];
afterAll(() => { for (const db of opened) db.close(); rmSync(root, { recursive: true, force: true }); });

// The columns OpenCode 2.0.32 gives a session and the ones this reader asks of it.
const SCHEMA = `
CREATE TABLE session_v2 (
  id text PRIMARY KEY, project_id text NOT NULL, parent_id text, slug text NOT NULL, directory text NOT NULL,
  title text, version text NOT NULL, revert text, agent text, model text,
  time_created integer NOT NULL, time_updated integer NOT NULL, time_archived integer
);
CREATE TABLE session_message (
  id text PRIMARY KEY, session_id text NOT NULL, type text NOT NULL, seq integer NOT NULL,
  time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL
);
CREATE UNIQUE INDEX session_message_session_seq_idx ON session_message (session_id, seq);
CREATE INDEX session_v2_parent_idx ON session_v2 (parent_id);
`;

const NOW = Date.parse("2026-10-24T12:00:00Z");
const MIN = 60_000;
let stores = 0;
let rows = 0;
/**
 * A row id as OpenCode names it (Identifier.ascending in @opencode/schema): "msg_", the low 48 bits of the ms it was
 * named at times 4096 plus a counter, in 12 hex digits, then 14 random characters.
 */
const opencodeId = (ms: number): string => `msg_${((BigInt(ms) * 0x1000n + BigInt(++rows)) & 0xffffffffffffn).toString(16).padStart(12, "0")}AbCdEfGhIjKlMn`;

function store(parent = "ses_parent", ids: "plain" | "opencode" = "plain") {
  const path = join(root, `opencode-${++stores}.db`);
  const db = new Database(path, { create: true });
  opened.push(db);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = OFF");
  db.exec(SCHEMA);
  const session = (id: string, at: number, extra: { parent?: string | null; title?: string | null; agent?: string; model?: string; archived?: number } = {}) =>
    db.query("INSERT INTO session_v2 (id, project_id, parent_id, slug, directory, title, version, agent, model, time_created, time_updated, time_archived) VALUES (?, 'global', ?, 'slug', ?, ?, '2.0.32', ?, ?, ?, ?, ?)")
      .run(id, extra.parent === undefined ? parent : extra.parent, root, extra.title === undefined ? `task ${id}` : extra.title, extra.agent ?? "explore", extra.model ?? JSON.stringify({ id: "session-model", providerID: "p" }), at, at, extra.archived ?? null);
  session(parent, NOW - 60 * MIN, { parent: null, title: "Parent", agent: "build" });
  const seqs = new Map<string, number>();
  const add = (sessionId: string, type: string, at: number, data: Record<string, unknown>, named = at) => {
    const seq = (seqs.get(sessionId) ?? 0) + 2;
    seqs.set(sessionId, seq);
    db.query("INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(ids === "opencode" ? opencodeId(named) : `msg_${(++rows).toString().padStart(6, "0")}`, sessionId, type, seq, at, at, JSON.stringify(data));
  };
  const prompt = (sessionId: string, at: number) => add(sessionId, "user", at, { time: { created: at }, text: "do it" });
  const step = (sessionId: string, at: number, extra: Record<string, unknown> = {}) => add(sessionId, "assistant", at, {
    time: { created: at, completed: at + 1000 }, model: { id: "child-model", providerID: "p" }, finish: "tool-calls",
    content: [{ type: "text", text: "working" }, { type: "tool", name: "read", state: { status: "completed", input: {}, content: [] } }],
    tokens: { input: 100, output: 20, reasoning: 5, cache: { read: 1000, write: 0 } }, ...extra,
  });
  const idle = (sessionId: string, at: number, outcome = "succeeded") => add(sessionId, "idle", at, { time: { created: at }, outcome });
  /**
   * The parent's step that calls the `subagent` tool for `child`, as OpenCode 2 writes it: running (named by the
   * progress metadata), answered (`completed`, a background call with `metadata.status: "running"`) or failed.
   */
  const callData = (child: string, at: number, state: "running" | "completed" | "background" | "error" | "aborted" | "cancelled", input: Record<string, unknown> = {}) => {
    const done = state !== "running";
    const tool = {
      type: "tool", id: `call_${child}_${at}`, name: "subagent",
      time: { created: at, ...(done ? { ran: at, completed: at + 500 } : { ran: at }) },
      state: state === "running" ? { status: "running", input: { agent: "explore", ...input }, metadata: { sessionID: child, status: "running" } }
        : state === "completed" ? { status: "completed", input: { agent: "explore", ...input }, content: [{ type: "text", text: "done" }], metadata: { sessionID: child, status: "completed" } }
        : state === "background" ? { status: "completed", input: { agent: "explore", background: true, ...input }, content: [{ type: "text", text: "working" }], metadata: { sessionID: child, status: "running" } }
        : { status: "error", input: { agent: "explore", ...input }, metadata: { sessionID: child, status: "running" }, error: state === "aborted" ? { type: "aborted", message: "Aborted" } : { type: "unknown", message: `Subagent ${state === "cancelled" ? "cancelled" : "failed"} (sessionID: ${child})` } },
    };
    return { time: { created: at, ...(done ? { completed: at + 1000 } : {}) }, finish: done ? "tool-calls" : undefined, content: [{ type: "text", text: "calling" }, tool] };
  };
  const call = (...args: Parameters<typeof callData>) => add(parent, "assistant", args[1], callData(...args));
  /** The parent's newest step written again at `updated`, as OpenCode updates a step's row in place when its call is answered. */
  const answer = (updated: number, ...args: Parameters<typeof callData>) => db.query(
    "UPDATE session_message SET data = ?, time_updated = ? WHERE id = (SELECT id FROM session_message WHERE session_id = ? AND type = 'assistant' ORDER BY seq DESC LIMIT 1)",
  ).run(JSON.stringify(callData(...args)), updated, parent);
  /**
   * The parent's notice that a background subagent ended (SubagentCompletion.deliver), written at `at`. Its row's id
   * is the job's notificationID, named when the job went to the background (`named`, Job.markBackground).
   */
  const notice = (child: string, at: number, state: "completed" | "cancelled" | "error", named = at) => add(parent, "synthetic", at, {
    time: { created: at }, description: "task", metadata: { source: "subagent", childID: child, agent: "explore", state },
    text: `<subagent sessionID="${child}" state="${state}" description="task">\ndone\n</subagent>`,
  }, named);
  return { path, db, parent, session, add, prompt, step, idle, call, answer, notice };
}

describe("an OpenCode session's subagents are its child sessions", () => {
  it("lists running ones first, oldest first, then the newest that ended, with what each did", () => {
    const s = store();
    s.prompt(s.parent, NOW - 30 * MIN);
    s.session("ses_working", NOW - 20 * MIN, { title: "index the repo" });
    s.prompt("ses_working", NOW - 20 * MIN);
    s.step("ses_working", NOW - 19 * MIN);
    s.session("ses_continued", NOW - 50 * MIN, { title: "review", agent: "general" });
    s.prompt("ses_continued", NOW - 50 * MIN);
    s.step("ses_continued", NOW - 49 * MIN, { finish: "stop" });
    s.idle("ses_continued", NOW - 48 * MIN);
    s.prompt("ses_continued", NOW - 10 * MIN);
    s.session("ses_done", NOW - 40 * MIN, { title: "find the bug" });
    s.prompt("ses_done", NOW - 40 * MIN);
    s.step("ses_done", NOW - 39 * MIN);
    s.step("ses_done", NOW - 38 * MIN, { finish: "stop", content: [{ type: "text", text: "found it" }] });
    s.idle("ses_done", NOW - 37 * MIN);
    s.session("ses_failed", NOW - 35 * MIN);
    s.prompt("ses_failed", NOW - 35 * MIN);
    s.idle("ses_failed", NOW - 34 * MIN, "failed");
    s.session("ses_stopped", NOW - 33 * MIN);
    s.prompt("ses_stopped", NOW - 33 * MIN);
    s.idle("ses_stopped", NOW - 32 * MIN, "interrupted");
    s.session("ses_unprompted", NOW - 5 * MIN);
    s.session("ses_old", NOW - 30 * 60 * MIN);
    s.prompt("ses_old", NOW - 30 * 60 * MIN);
    s.idle("ses_old", NOW - 26 * 60 * MIN);
    s.session("ses_archived", NOW - 15 * MIN, { archived: NOW - MIN });
    s.prompt("ses_archived", NOW - 15 * MIN);
    s.session("ses_elsewhere", NOW - 15 * MIN, { parent: "ses_other" });
    s.prompt("ses_elsewhere", NOW - 15 * MIN);

    const state = opencodeSubagentState(s.path, s.parent, true, NOW)!;
    expect(state.tasks.map((task) => [task.id, task.status])).toEqual([
      ["ses_continued", "running"], ["ses_working", "running"],
      ["ses_stopped", "cancelled"], ["ses_failed", "failed"], ["ses_done", "completed"],
    ]);
    expect(state.running).toBe(2);
    expect(state.promptAt).toBe(NOW - 30 * MIN);
    expect(state.turnRunning).toBe(2);
    const done = state.tasks.find((task) => task.id === "ses_done")!;
    expect(done).toEqual({
      id: "ses_done", title: "find the bug", category: "explore", model: "child-model", status: "completed",
      started_at: new Date(NOW - 40 * MIN).toISOString(), ended_at: new Date(NOW - 37 * MIN).toISOString(),
      turns: 2, tool_calls: 1, tokens: 1125, detail_kind: "opencode-subagent",
    });
    expect(state.tasks.find((task) => task.id === "ses_failed")!.model).toBe("session-model");
    expect(state.tasks.find((task) => task.id === "ses_continued")!.ended_at).toBeNull();
  });

  it("lists the session's background commands with its subagents, as Claude's are listed", () => {
    const s = store();
    s.prompt(s.parent, NOW - 30 * MIN);
    s.session("ses_working", NOW - 20 * MIN, { title: "index the repo" });
    s.prompt("ses_working", NOW - 20 * MIN);
    s.step("ses_working", NOW - 19 * MIN);
    s.session("ses_done", NOW - 40 * MIN, { title: "find the bug" });
    s.prompt("ses_done", NOW - 40 * MIN);
    s.step("ses_done", NOW - 39 * MIN);
    s.step("ses_done", NOW - 38 * MIN, { finish: "stop", content: [{ type: "text", text: "found it" }] });
    s.idle("ses_done", NOW - 37 * MIN);
    const shell = (at: number, data: Record<string, unknown>) => s.add(s.parent, "shell", at, data);
    shell(NOW - 6 * MIN, { metadata: { background: true }, shellID: "sh_run", command: "sleep 60", status: "running", exit: null, output: null, time: { created: NOW - 6 * MIN } });
    shell(NOW - 8 * MIN, { metadata: { background: true }, shellID: "sh_ok", command: "make build", status: "exited", exit: 0, output: { output: "done", size: 4, truncated: false }, time: { created: NOW - 9 * MIN } });
    shell(NOW - 10 * MIN, { metadata: { background: true }, shellID: "sh_bad", command: "make test", status: "exited", exit: 2, output: null, time: { created: NOW - 12 * MIN } });
    shell(NOW - 4 * MIN, { command: "ls", status: "exited", exit: 0, time: { created: NOW - 4 * MIN } });
    shell(NOW - 3 * MIN, { metadata: { background: false }, shellID: "sh_fg", command: "echo hi", status: "exited", exit: 0, output: null, time: { created: NOW - 3 * MIN } });

    const state = opencodeSubagentState(s.path, s.parent, true, NOW)!;
    expect(state.tasks.map((task) => [task.id, task.status])).toEqual([
      ["ses_working", "running"], ["sh_run", "running"],
      ["sh_ok", "completed"], ["sh_bad", "failed"], ["ses_done", "completed"],
    ]);
    expect(state.running).toBe(2);
    expect(state.turnRunning).toBe(1);
    expect(state.tasks.find((task) => task.id === "sh_run")).toEqual({
      id: "sh_run", title: "sleep 60", category: "shell", model: null, status: "running",
      started_at: new Date(NOW - 6 * MIN).toISOString(), ended_at: null,
      turns: null, tool_calls: null, tokens: null, detail_kind: null,
    });
    expect(state.tasks.find((task) => task.id === "sh_ok")!.ended_at).toBe(new Date(NOW - 8 * MIN).toISOString());
  });

  it("counts an older background command behind more than a thousand ended commands", () => {
    const s = store();
    s.add(s.parent, "shell", NOW - 50 * MIN, { metadata: { background: true }, shellID: "sh_early", status: "running" });
    for (let n = 0; n < 1010; n++) {
      s.add(s.parent, "shell", NOW - 30 * MIN + n, { metadata: { background: true }, shellID: `sh_done${n}`, status: "exited", exit: 0 });
    }

    const state = opencodeSubagentState(s.path, s.parent, true, NOW);

    expect(state?.running).toBe(1);
    expect(state?.unlisted).toBe(0);
    expect(state?.tasks.map((task) => task.id)).toEqual(["sh_early", ...Array.from({ length: 10 }, (_, n) => `sh_done${1009 - n}`)]);
  });

  it("counts every running background command beyond the display limit", () => {
    const s = store();
    for (let n = 0; n < 1015; n++) {
      s.add(s.parent, "shell", NOW - 30 * MIN + n, { metadata: { background: true }, shellID: `sh_run${n}`, status: "running" });
    }

    const state = opencodeSubagentState(s.path, s.parent, true, NOW);

    expect(state?.running).toBe(1015);
    expect(state?.unlisted).toBe(15);
    expect(state?.turnRunning).toBe(0);
    expect(state?.tasks).toHaveLength(1000);
    expect(state?.tasks.map((task) => task.id)).toEqual(Array.from({ length: 1000 }, (_, n) => `sh_run${n + 15}`));
  });

  it.each([true, false])("bounds materialized running shell rows with detail %s while counting every command", (detail) => {
    const s = store();
    for (let n = 0; n < 1015; n++) {
      s.add(s.parent, "shell", NOW - MIN + n, { metadata: { background: true }, shellID: `sh_run${n}`, status: "running" });
    }
    let runningRows = 0;
    const reads: { mockRestore(): void }[] = [];
    const query = s.db.query.bind(s.db);
    const spied = new WeakSet<object>();
    reads.push(spyOn(s.db, "query").mockImplementation(function <Result, Bindings extends SQLQueryBindings | SQLQueryBindings[]>(sql: string) {
      const statement = query<Result, Bindings>(sql);
      if (spied.has(statement)) return statement;
      spied.add(statement);
      const all = statement.all.bind(statement);
      reads.push(spyOn(statement, "all").mockImplementation((...bindings) => {
        const result = all(...bindings);
        runningRows += result.filter((row) => row !== null && typeof row === "object" && "status" in row && row.status === "running").length;
        return result;
      }));
      return statement;
    }));
    try {
      const state = readSubagents(s.db, s.parent, true, NOW, null, detail);

      expect(state.running).toBe(1015);
      expect(state.unlisted).toBe(15);
      expect(state.tasks).toHaveLength(RUNNING_LIMIT);
      expect(runningRows).toBe(RUNNING_LIMIT);
    } finally {
      for (const read of reads) read.mockRestore();
    }
  });

  it.each([null, NOW])("keeps an overflow of stale running commands bounded with service start %s", (serviceStart) => {
    const s = store();
    for (let n = 0; n < 1015; n++) {
      s.add(s.parent, "shell", NOW - MIN + n, { metadata: { background: true }, shellID: `sh_lost${n}`, status: "running" });
    }

    const state = readSubagents(s.db, s.parent, serviceStart !== null, NOW, serviceStart, false);

    expect(state.running).toBe(0);
    expect(state.unlisted).toBe(0);
    expect(state.tasks.map((task) => [task.id, task.status])).toEqual(Array.from({ length: 10 }, (_, n) => [`sh_lost${1014 - n}`, "lost"]));
  });

  it.each([null, undefined])("marks an exited background command with exit %s as failed", (exit) => {
    const s = store();
    s.add(s.parent, "shell", NOW - MIN, { metadata: { background: true }, shellID: "sh_unknown", status: "exited", exit });

    const state = opencodeSubagentState(s.path, s.parent, true, NOW);

    expect(state?.tasks.map((task) => [task.id, task.status])).toEqual([["sh_unknown", "failed"]]);
  });

  it("leaves a running background command lost once its session is left, and lists only the recently ended", () => {
    const s = store();
    const shell = (at: number, data: Record<string, unknown>) => s.add(s.parent, "shell", at, data);
    shell(NOW - 6 * MIN, { metadata: { background: true }, shellID: "sh_run", command: "sleep 60", status: "running", exit: null, output: null, time: { created: NOW - 6 * MIN } });
    shell(NOW - 2 * MIN, { metadata: { background: true }, shellID: "sh_new", command: "make build", status: "exited", exit: 0, output: null, time: { created: NOW - 5 * MIN } });
    shell(NOW - 26 * 60 * MIN, { metadata: { background: true }, shellID: "sh_old", command: "make old", status: "exited", exit: 0, output: null, time: { created: NOW - 30 * 60 * MIN } });

    const live = opencodeSubagentState(s.path, s.parent, true, NOW)!;
    expect(live.tasks.map((task) => [task.id, task.status])).toEqual([
      ["sh_run", "running"], ["sh_new", "completed"],
    ]);
    expect(live.running).toBe(1);
    const gone = opencodeSubagentState(s.path, s.parent, false, NOW)!;
    expect(gone.tasks.map((task) => [task.id, task.status])).toEqual([
      ["sh_new", "completed"], ["sh_run", "lost"],
    ]);
    expect(gone.running).toBe(0);
  });

  it("counts for the turn only what that turn started, and reads nothing for the list when only counting", () => {    const s = store();
    s.session("ses_before", NOW - 20 * MIN);
    s.prompt("ses_before", NOW - 20 * MIN);
    s.prompt(s.parent, NOW - 10 * MIN);
    s.session("ses_after", NOW - 5 * MIN);
    s.prompt("ses_after", NOW - 5 * MIN);
    const state = opencodeSubagentState(s.path, s.parent, true, NOW, null, false)!;
    expect([state.running, state.turnRunning, state.promptAt]).toEqual([2, 1, NOW - 10 * MIN]);
    expect(state.tasks.map((task) => [task.turns, task.tool_calls, task.tokens])).toEqual([[null, null, null], [null, null, null]]);
  });

  it("leaves what ran as lost once the pane no longer runs the session, ended when last heard of", () => {
    const s = store();
    s.session("ses_working", NOW - 20 * MIN);
    s.prompt("ses_working", NOW - 20 * MIN);
    s.step("ses_working", NOW - 19 * MIN);
    s.session("ses_done", NOW - 30 * MIN);
    s.prompt("ses_done", NOW - 30 * MIN);
    s.idle("ses_done", NOW - 29 * MIN);
    const state = opencodeSubagentState(s.path, s.parent, false, NOW)!;
    expect(state.tasks.map((task) => [task.id, task.status, task.ended_at])).toEqual([
      ["ses_working", "lost", new Date(NOW - 19 * MIN + 1000).toISOString()],
      ["ses_done", "completed", new Date(NOW - 29 * MIN).toISOString()],
    ]);
    expect(state.running).toBe(0);
  });

  it("ends a run OpenCode 1.x recorded, which has no idle row, at its answered, failed or stopped step", () => {
    const s = store();
    for (const [id, extra] of [
      ["ses_answered", { finish: "stop" }],
      ["ses_errored", { finish: undefined, error: { name: "APIError", message: "boom" } }],
      ["ses_aborted", { finish: undefined, error: { type: "aborted", message: "Aborted" } }],
      ["ses_calling", {}],
    ] as const) {
      s.session(id, NOW - 10 * MIN);
      s.prompt(id, NOW - 10 * MIN);
      s.step(id, NOW - 9 * MIN, extra);
    }
    expect(opencodeSubagentState(s.path, s.parent, true, NOW)!.tasks.map((task) => [task.id, task.status])).toEqual([
      ["ses_calling", "running"], ["ses_answered", "completed"], ["ses_errored", "failed"], ["ses_aborted", "cancelled"],
    ]);
  });

  it("leaves a run from before OpenCode's service started as lost: that service took it along", () => {
    const s = store();
    s.session("ses_orphan", NOW - 20 * MIN);
    s.prompt("ses_orphan", NOW - 20 * MIN);
    s.step("ses_orphan", NOW - 19 * MIN);
    s.session("ses_fresh", NOW - 2 * MIN);
    s.prompt("ses_fresh", NOW - 2 * MIN);
    const state = opencodeSubagentState(s.path, s.parent, true, NOW, NOW - 5 * MIN)!;
    expect(state.tasks.map((task) => [task.id, task.status])).toEqual([["ses_fresh", "running"], ["ses_orphan", "lost"]]);
    expect(state.running).toBe(1);
    expect(opencodeSubagentState(s.path, s.parent, true, NOW, NOW - 19 * MIN + 1000 + 3000)!.running).toBe(2);
  });

  it("counts a run however many newer children ended since, and lists only the newest ten that did", () => {
    const s = store();
    s.session("ses_early", NOW - 50 * MIN);
    s.prompt("ses_early", NOW - 50 * MIN);
    const ended = 1030;
    for (let n = 0; n < ended; n++) {
      s.session(`ses_done${n}`, NOW - 40 * MIN + n * 1000);
      s.prompt(`ses_done${n}`, NOW - 40 * MIN + n * 1000);
      s.idle(`ses_done${n}`, NOW - 30 * MIN + n * 1000);
    }
    const state = opencodeSubagentState(s.path, s.parent, true, NOW, null, false)!;
    expect(state.running).toBe(1);
    expect(state.tasks.map((task) => task.id)).toEqual(["ses_early", ...Array.from({ length: 10 }, (_, n) => `ses_done${ended - 1 - n}`)]);
    s.idle("ses_early", NOW - MIN);
    const after = opencodeSubagentState(s.path, s.parent, true, NOW, null, false)!;
    expect(after.running).toBe(0);
    expect(after.tasks.map((task) => [task.id, task.status]).slice(0, 2)).toEqual([["ses_early", "completed"], [`ses_done${ended - 1}`, "completed"]]);
  });

  it("reads a session with more children than a page a page at a time, and tells a poll's count once its last page is in", async () => {
    const s = store();
    for (let n = 0; n < SUBAGENT_PAGE + 5; n++) {
      s.session(`ses_done${n}`, NOW - 40 * MIN + n);
      s.prompt(`ses_done${n}`, NOW - 40 * MIN + n);
      s.idle(`ses_done${n}`, NOW - 30 * MIN + n);
    }
    s.prompt(s.parent, NOW - 10 * MIN);
    s.session("ses_last", NOW - 5 * MIN);
    s.prompt("ses_last", NOW - 5 * MIN);
    expect((await pagedState(s.path, s.parent, true, NOW, null, false))?.running).toBe(1);
    const changes: unknown[] = [];
    const tracker = new OpencodeSubagentStatus({ store: () => s.path, now: () => NOW, onChange: (...args) => changes.push(args) });
    const reading = tracker.refresh([{ pane_id: "w1:p1", agent: "opencode", agent_status: "idle", agent_session: { agent: "opencode", source: "herdr:opencode", kind: "id", value: s.parent } } as HerdrPane]);
    expect(tracker.countOf("w1:p1")).toBe(0);
    await reading;
    expect(changes).toEqual([["w1:p1", 1, 1, NOW - 10 * MIN, false]]);
  });

  it("reads every other child when one's newest row is not JSON", () => {
    const s = store();
    s.session("ses_broken", NOW - 10 * MIN);
    s.add("ses_broken", "user", NOW - 10 * MIN, {});
    s.db.query("UPDATE session_message SET data = '{not json' WHERE session_id = 'ses_broken'").run();
    s.session("ses_working", NOW - 5 * MIN);
    s.prompt("ses_working", NOW - 5 * MIN);
    expect(opencodeSubagentState(s.path, s.parent, true, NOW, null, false)?.tasks.map((task) => [task.id, task.status])).toEqual([["ses_broken", "running"], ["ses_working", "running"]]);
  });

  it("keeps a subagent running while its parent waits on it, though the child went idle (anomalyco/opencode#57418)", () => {
    const s = store();
    s.prompt(s.parent, NOW - 30 * MIN);
    s.session("ses_fg", NOW - 20 * MIN);
    s.call("ses_fg", NOW - 20 * MIN, "running");
    s.prompt("ses_fg", NOW - 20 * MIN);
    s.step("ses_fg", NOW - 19 * MIN, { finish: "stop" });
    s.idle("ses_fg", NOW - 18 * MIN);
    s.session("ses_bg", NOW - 15 * MIN);
    s.call("ses_bg", NOW - 15 * MIN, "background");
    s.prompt("ses_bg", NOW - 15 * MIN);
    s.idle("ses_bg", NOW - 14 * MIN);

    const state = opencodeSubagentState(s.path, s.parent, true, NOW, null, true, true)!;

    expect(state.tasks.map((task) => [task.id, task.status])).toEqual([["ses_fg", "running"], ["ses_bg", "running"]]);
    expect([state.running, state.turnRunning]).toEqual([2, 2]);
    expect(opencodeSubagentState(s.path, s.parent, true, NOW)!.running).toBe(0);
  });

  it("ends a subagent where its parent's record says it ended, however its child's rows read", () => {
    const s = store();
    s.prompt(s.parent, NOW - 60 * MIN);
    for (const [id, state, at] of [["ses_done", "completed", 40], ["ses_failed", "error", 38], ["ses_stopped", "aborted", 36], ["ses_job_cancelled", "cancelled", 34]] as const) {
      s.session(id, NOW - 50 * MIN);
      s.call(id, NOW - 50 * MIN, "running");
      s.prompt(id, NOW - 50 * MIN);
      s.idle(id, NOW - 45 * MIN);
      s.call(id, NOW - at * MIN, state);
    }
    for (const [id, state, at] of [["ses_bg_done", "completed", 30], ["ses_bg_failed", "error", 28], ["ses_bg_cancelled", "cancelled", 26]] as const) {
      s.session(id, NOW - 50 * MIN);
      s.call(id, NOW - 50 * MIN, "background");
      s.prompt(id, NOW - 50 * MIN);
      s.step(id, NOW - 49 * MIN);
      s.notice(id, NOW - at * MIN, state);
    }

    const state = opencodeSubagentState(s.path, s.parent, true, NOW, null, true, true)!;

    expect(state.tasks.map((task) => [task.id, task.status, task.ended_at])).toEqual([
      ["ses_bg_cancelled", "cancelled", new Date(NOW - 26 * MIN).toISOString()],
      ["ses_bg_failed", "failed", new Date(NOW - 28 * MIN).toISOString()],
      ["ses_bg_done", "completed", new Date(NOW - 30 * MIN).toISOString()],
      ["ses_job_cancelled", "cancelled", new Date(NOW - 34 * MIN + 500).toISOString()],
      ["ses_stopped", "cancelled", new Date(NOW - 36 * MIN + 500).toISOString()],
      ["ses_failed", "failed", new Date(NOW - 38 * MIN + 500).toISOString()],
      ["ses_done", "completed", new Date(NOW - 40 * MIN + 500).toISOString()],
    ]);
    expect(state.running).toBe(0);
  });

  it("runs a subagent again for a newer call that resumes it, or by its own rows once woken after its end", () => {
    const s = store();
    s.prompt(s.parent, NOW - 60 * MIN);
    s.session("ses_resumed", NOW - 50 * MIN);
    s.call("ses_resumed", NOW - 50 * MIN, "background");
    s.prompt("ses_resumed", NOW - 50 * MIN);
    s.idle("ses_resumed", NOW - 45 * MIN);
    s.notice("ses_resumed", NOW - 44 * MIN, "completed");
    s.call("ses_resumed", NOW - 10 * MIN, "running", { sessionID: "ses_resumed" });
    s.prompt("ses_resumed", NOW - 10 * MIN);
    s.idle("ses_resumed", NOW - 9 * MIN);
    s.session("ses_woken", NOW - 50 * MIN);
    s.call("ses_woken", NOW - 50 * MIN, "running");
    s.prompt("ses_woken", NOW - 50 * MIN);
    s.idle("ses_woken", NOW - 45 * MIN);
    s.call("ses_woken", NOW - 44 * MIN, "completed");
    s.add("ses_woken", "synthetic", NOW - 5 * MIN, { time: { created: NOW - 5 * MIN }, metadata: { source: "shell", jobID: "job_1" }, text: "finished" });
    s.session("ses_unnamed", NOW - 30 * MIN);
    s.prompt("ses_unnamed", NOW - 30 * MIN);
    s.idle("ses_unnamed", NOW - 29 * MIN);

    const state = opencodeSubagentState(s.path, s.parent, true, NOW, null, true, true)!;
    expect(state.tasks.map((task) => [task.id, task.status])).toEqual([
      ["ses_resumed", "running"], ["ses_woken", "running"], ["ses_unnamed", "completed"],
    ]);
    s.idle("ses_woken", NOW - 4 * MIN);
    s.call("ses_resumed", NOW - 3 * MIN, "completed");
    expect(opencodeSubagentState(s.path, s.parent, true, NOW, null, true, true)!.tasks.map((task) => [task.id, task.status, task.ended_at])).toEqual([
      ["ses_resumed", "completed", new Date(NOW - 3 * MIN + 500).toISOString()],
      ["ses_woken", "completed", new Date(NOW - 4 * MIN).toISOString()],
      ["ses_unnamed", "completed", new Date(NOW - 29 * MIN).toISOString()],
    ]);
  });

  it("lets a child's own rows tell once its parent's run left a foreground call unanswered (a crash, a stop)", () => {
    const s = store();
    s.prompt(s.parent, NOW - 30 * MIN);
    s.session("ses_left", NOW - 20 * MIN);
    s.call("ses_left", NOW - 20 * MIN, "running");
    s.prompt("ses_left", NOW - 20 * MIN);
    s.idle("ses_left", NOW - 19 * MIN);
    s.idle(s.parent, NOW - 18 * MIN, "interrupted");

    expect(opencodeSubagentState(s.path, s.parent, true, NOW, null, true, true)!.tasks.map((task) => [task.id, task.status])).toEqual([["ses_left", "completed"]]);
  });

  it.each(["running", "background"] as const)("lets a child's own rows tell once the service that ran its %s call is gone, the restarted one having woken it", (call) => {
    const s = store();
    s.prompt(s.parent, NOW - 90_000);
    s.session("ses_child", NOW - 80_000);
    s.call("ses_child", NOW - 80_000, call);
    s.prompt("ses_child", NOW - 79_000);
    s.idle("ses_child", NOW - 70_000);
    s.add("ses_child", "synthetic", NOW - 20_000, { time: { created: NOW - 20_000 }, metadata: { source: "shell" } });
    s.idle("ses_child", NOW - 10_000);

    expect(opencodeSubagentState(s.path, s.parent, true, NOW, NOW - 30_000, true, true)!.tasks.map((task) => [task.id, task.status])).toEqual([["ses_child", "completed"]]);
  });

  it("takes nothing from a call a staged /undo hides, as the chat shows nothing of it", () => {
    const s = store();
    s.prompt(s.parent, NOW - 30 * MIN);
    s.session("ses_hidden", NOW - 20 * MIN);
    s.call("ses_hidden", NOW - 20 * MIN, "background");
    s.prompt("ses_hidden", NOW - 20 * MIN);
    s.idle("ses_hidden", NOW - 19 * MIN);
    expect(opencodeSubagentState(s.path, s.parent, true, NOW, null, true, true)!.tasks.map((task) => task.status)).toEqual(["running"]);
    const call = s.db.query<{ id: string }, [string]>("SELECT id FROM session_message WHERE session_id = ? AND type = 'assistant'").get(s.parent)!;
    s.db.query("UPDATE session_v2 SET revert = ? WHERE id = ?").run(JSON.stringify({ messageID: call.id }), s.parent);

    expect(opencodeSubagentState(s.path, s.parent, true, NOW, null, true, true)!.tasks.map((task) => [task.id, task.status])).toEqual([["ses_hidden", "completed"]]);
  });

  it("ends no newer call to a child with a background notice that answers an older one, landed late", () => {
    const s = store("ses_parent", "opencode");
    s.prompt(s.parent, NOW - 30 * MIN);
    s.session("ses_child", NOW - 20 * MIN);
    s.call("ses_child", NOW - 20 * MIN, "background");
    s.prompt("ses_child", NOW - 20 * MIN);
    s.idle("ses_child", NOW - 15 * MIN);
    s.call("ses_child", NOW - 10 * MIN, "running", { sessionID: "ses_child" });
    s.prompt("ses_child", NOW - 10 * MIN);
    s.idle("ses_child", NOW - 9 * MIN);
    s.notice("ses_child", NOW - 8 * MIN, "completed", NOW - 20 * MIN);
    const read = () => opencodeSubagentState(s.path, s.parent, true, NOW, null, true, true)!.tasks.map((task) => [task.id, task.status]);
    expect(read()).toEqual([["ses_child", "running"]]);
    s.call("ses_child", NOW - 5 * MIN, "completed");
    expect(read()).toEqual([["ses_child", "completed"]]);
  });

  it("ends a newer call that joined a child's background job with that job's notice, named before it", () => {
    const s = store("ses_parent", "opencode");
    s.prompt(s.parent, NOW - 30 * MIN);
    s.session("ses_child", NOW - 20 * MIN);
    s.call("ses_child", NOW - 20 * MIN, "background");
    s.prompt("ses_child", NOW - 20 * MIN);
    // called again while that job runs in the background: the call joins it and is answered at once (subagent.ts)
    s.call("ses_child", NOW - 10 * MIN, "background", { sessionID: "ses_child" });
    s.prompt("ses_child", NOW - 10 * MIN);
    s.idle("ses_child", NOW - 9 * MIN);
    s.notice("ses_child", NOW - 8 * MIN, "completed", NOW - 20 * MIN);

    expect(opencodeSubagentState(s.path, s.parent, true, NOW, null, true, true)!.tasks.map((task) => [task.id, task.status])).toEqual([["ses_child", "completed"]]);
  });

  it("lets an older call tell once a staged /undo hides a newer one to the same child", () => {
    const s = store();
    s.prompt(s.parent, NOW - 30 * MIN);
    s.session("ses_child", NOW - 20 * MIN);
    s.call("ses_child", NOW - 20 * MIN, "background");
    s.prompt("ses_child", NOW - 20 * MIN);
    s.idle("ses_child", NOW - 19 * MIN);
    s.call("ses_child", NOW - 10 * MIN, "completed", { sessionID: "ses_child" });
    const hidden = s.db.query<{ id: string }, [string]>("SELECT id FROM session_message WHERE session_id = ? AND type = 'assistant' ORDER BY seq DESC LIMIT 1").get(s.parent)!;
    s.db.query("UPDATE session_v2 SET revert = ? WHERE id = ?").run(JSON.stringify({ messageID: hidden.id }), s.parent);

    expect(opencodeSubagentState(s.path, s.parent, true, NOW, null, true, true)!.tasks.map((task) => [task.id, task.status])).toEqual([["ses_child", "running"]]);
  });

  it("takes a child woken in the same millisecond its parent was told it ended as woken", () => {
    const s = store();
    s.prompt(s.parent, NOW - 30 * MIN);
    s.session("ses_child", NOW - 20 * MIN);
    s.call("ses_child", NOW - 20 * MIN, "running");
    s.prompt("ses_child", NOW - 20 * MIN);
    s.idle("ses_child", NOW - 19 * MIN);
    s.call("ses_child", NOW - 10 * MIN, "completed");
    s.add("ses_child", "synthetic", NOW - 10 * MIN + 500, { time: { created: NOW - 10 * MIN + 500 }, metadata: { source: "shell" }, text: "finished" });

    expect(opencodeSubagentState(s.path, s.parent, true, NOW, null, true, true)!.tasks.map((task) => [task.id, task.status])).toEqual([["ses_child", "running"]]);
  });

  it("finds no subagents in a store without child sessions, and says nothing of one it cannot read", () => {
    const path = join(root, "v1.db");
    const v1 = new Database(path, { create: true });
    opened.push(v1);
    v1.exec("CREATE TABLE session (id text PRIMARY KEY, title text); CREATE TABLE message (id text PRIMARY KEY, session_id text, data text);");
    expect(opencodeSubagentState(path, "ses_parent", true, NOW)).toEqual({ tasks: [], running: 0, turnRunning: 0, promptAt: null, unlisted: 0 });
    const garbage = join(root, "garbage.db");
    writeFileSync(garbage, "not a database at all, just text");
    expect(opencodeSubagentState(garbage, "ses_parent", true, NOW)).toBeNull();
    expect(opencodeSubagentState(join(root, "missing.db"), "ses_parent", true, NOW)).toBeNull();
  });
});

describe("the OpenCode subagent tracker", () => {
  const pane = (session: string | null, agent = "opencode"): HerdrPane => ({
    pane_id: "w1:p1", agent, agent_status: "idle",
    ...(session === null ? {} : { agent_session: { agent: "opencode", source: "herdr:opencode", kind: "id", value: session } }),
  } as HerdrPane);

  it("counts a pane's running subagents and tells each change once; a pane that leaves OpenCode counts none", async () => {
    const s = store();
    const changes: unknown[] = [];
    const resets: string[] = [];
    const tracker = new OpencodeSubagentStatus({ store: () => s.path, now: () => NOW, onChange: (...args) => changes.push(args), onReset: (paneId) => resets.push(paneId) });
    tracker.refresh([pane(s.parent)]);
    expect(resets).toEqual([]);
    expect(changes).toEqual([]);
    s.prompt(s.parent, NOW - 10 * MIN);
    s.session("ses_working", NOW - 5 * MIN);
    s.prompt("ses_working", NOW - 5 * MIN);
    tracker.poll();
    expect(changes).toEqual([["w1:p1", 1, 1, NOW - 10 * MIN, false]]);
    expect(tracker.countOf("w1:p1")).toBe(1);
    tracker.poll();
    expect(changes).toHaveLength(1);
    s.idle("ses_working", NOW - MIN);
    tracker.poll("w1:p1");
    expect(changes.at(-1)).toEqual(["w1:p1", 0, 0, NOW - 10 * MIN, false]);
    s.prompt("ses_working", NOW - 30_000);
    tracker.poll();
    expect(tracker.countOf("w1:p1")).toBe(1);
    tracker.refresh([pane(null)]);
    expect(tracker.countOf("w1:p1")).toBe(0);
    expect(changes.at(-1)).toEqual(["w1:p1", 0, 0, null, false]);
    expect(tracker.sessionOf("w1:p1")).toEqual({ path: s.path, session: s.parent, live: false });
    expect((await tracker.tasksOf("w1:p1"))?.tasks.map((task) => [task.id, task.status])).toEqual([["ses_working", "lost"]]);
    tracker.refresh([pane(s.parent)]);
    expect(tracker.countOf("w1:p1")).toBe(1);
    expect(resets).toEqual(["w1:p1"]);
    tracker.refresh([pane(null, "shell")]);
    expect(tracker.countOf("w1:p1")).toBe(0);
    expect(changes.at(-1)).toEqual(["w1:p1", 0, 0, null, false]);
    expect(tracker.sessionOf("w1:p1")).toEqual({ path: s.path, session: s.parent, live: false });
    expect(resets).toHaveLength(1);
    tracker.refresh([pane("ses_next")]);
    expect(resets).toHaveLength(2);
    expect(tracker.sessionOf("w1:p1")?.session).toBe("ses_next");
    tracker.refresh([]);
    expect(tracker.sessionOf("w1:p1")).toBeNull();
  });

  it("drops another agent's wait when a pane first runs a session after it, never what the pane's own OpenCode turn was seen do", () => {
    const s = store();
    const resets: [string, boolean][] = [];
    const tracker = new OpencodeSubagentStatus({ store: () => s.path, now: () => NOW, onChange: () => undefined, onReset: (paneId, first) => resets.push([paneId, first]) });
    tracker.refresh([{ pane_id: "w1:p1", agent: null, agent_status: "idle" } as HerdrPane]);
    tracker.refresh([pane(null)]);
    tracker.refresh([pane(s.parent)]);
    expect(resets).toEqual([]);
    tracker.refresh([{ ...pane(null, "claude"), pane_id: "w1:p2" }]);
    tracker.refresh([{ ...pane(s.parent), pane_id: "w1:p2" }]);
    expect(resets).toEqual([["w1:p2", true]]);
    tracker.refresh([{ ...pane("ses_next"), pane_id: "w1:p2" }]);
    expect(resets).toEqual([["w1:p2", true], ["w1:p2", false]]);
  });

  it("reads a session of a page of children at once, and counts every one that runs when more than a page do", async () => {
    const s = store();
    s.prompt(s.parent, NOW - 10 * MIN);
    for (let n = 0; n < SUBAGENT_PAGE - 1; n++) {
      s.session(`ses_done${n}`, NOW - 40 * MIN + n);
      s.idle(`ses_done${n}`, NOW - 30 * MIN + n);
    }
    s.session("ses_working", NOW - 5 * MIN);
    s.prompt("ses_working", NOW - 5 * MIN);
    const tracker = new OpencodeSubagentStatus({ store: () => s.path, now: () => NOW, onChange: () => undefined });
    void tracker.refresh([pane(s.parent)]);
    expect(tracker.countOf("w1:p1")).toBe(1);
    const busy = store();
    for (let n = 0; n < SUBAGENT_PAGE + 5; n++) {
      busy.session(`ses_run${n}`, NOW - 5 * MIN + n);
      busy.prompt(`ses_run${n}`, NOW - 5 * MIN + n);
    }
    const all = opencodeSubagentState(busy.path, busy.parent, true, NOW, null, false)!;
    expect(all.running).toBe(SUBAGENT_PAGE + 5);
    expect(all.unlisted).toBe(SUBAGENT_PAGE + 5 - RUNNING_LIMIT);
    expect(all.tasks).toHaveLength(RUNNING_LIMIT);
    expect(all.tasks[0]!.id).toBe(`ses_run${SUBAGENT_PAGE + 5 - RUNNING_LIMIT}`);
    const many = new OpencodeSubagentStatus({ store: () => busy.path, now: () => NOW, onChange: () => undefined });
    await many.refresh([pane(busy.parent)]);
    expect(many.countOf("w1:p1")).toBe(SUBAGENT_PAGE + 5);
  });

  it("tells a pane that leaves its session while a read of it goes on at once, and drops what that read finds", async () => {
    const s = store();
    for (let n = 0; n < SUBAGENT_PAGE + 5; n++) {
      s.session(`ses_done${n}`, NOW - 40 * MIN + n);
      s.idle(`ses_done${n}`, NOW - 30 * MIN + n);
    }
    s.session("ses_working", NOW - 5 * MIN);
    s.prompt("ses_working", NOW - 5 * MIN);
    const changes: unknown[] = [];
    const tracker = new OpencodeSubagentStatus({ store: () => s.path, now: () => NOW, onChange: (...args) => changes.push(args) });
    await tracker.refresh([pane(s.parent)]);
    expect(tracker.countOf("w1:p1")).toBe(1);
    const reading = tracker.poll();
    void tracker.refresh([pane(null)]);
    expect(tracker.countOf("w1:p1")).toBe(0);
    await reading;
    expect(tracker.countOf("w1:p1")).toBe(0);
    expect(changes.at(-1)).toEqual(["w1:p1", 0, 0, null, false]);
    await tracker.refresh([pane(s.parent)]);
    for (const id of ["ses_other_a", "ses_other_b"]) {
      s.session(id, NOW - 2 * MIN, { parent: "ses_other" });
      s.prompt(id, NOW - 2 * MIN);
    }
    const again = tracker.poll();
    void tracker.refresh([pane("ses_other")]);
    expect(tracker.countOf("w1:p1")).toBe(2);
    await again;
    expect(tracker.countOf("w1:p1")).toBe(2);
  });

  it("reads a page of rows that failed part way again whole, and counts no child twice", async () => {
    const s = store();
    for (const id of ["ses_a", "ses_b"]) {
      s.session(id, NOW - 5 * MIN);
      s.prompt(id, NOW - 5 * MIN);
    }
    let held = true;
    const flaky: typeof withStore = (path, read, busyMs) => withStore(path, (db) => read(new Proxy(db, {
      get(target, key) {
        if (key === "transaction") return target.transaction.bind(target);
        if (key !== "query") return Reflect.get(target, key, target);
        return (sql: string) => {
          const statement = target.query(sql);
          if (!held || !sql.includes("AS dispatched")) return statement;
          let rows = 0;
          return new Proxy(statement, {
            get(inner, name) {
              if (name !== "get") return Reflect.get(inner, name, inner);
              return (...args: [string]) => {
                if (++rows === 2) { held = false; throw Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" }); }
                return inner.get(...args);
              };
            },
          });
        };
      },
    })), busyMs);
    const state = await pagedState(s.path, s.parent, true, NOW, null, false, flaky);
    expect(held).toBe(false);
    expect(state?.running).toBe(2);
    expect(state?.tasks.map((task) => task.id)).toEqual(["ses_a", "ses_b"]);
  });

  it("answers the route for the session the pane runs when the answer is given", async () => {
    const s = store();
    for (let n = 0; n < SUBAGENT_PAGE + 5; n++) {
      s.session(`ses_done${n}`, NOW - 40 * MIN + n);
      s.idle(`ses_done${n}`, NOW - 30 * MIN + n);
    }
    s.session("ses_working", NOW - 5 * MIN);
    s.prompt("ses_working", NOW - 5 * MIN);
    s.session("ses_other_child", NOW - 2 * MIN, { parent: "ses_other" });
    s.prompt("ses_other_child", NOW - 2 * MIN);
    const tracker = new OpencodeSubagentStatus({ store: () => s.path, now: () => NOW, onChange: () => undefined });
    await tracker.refresh([pane(s.parent)]);
    const asked = tracker.tasksOf("w1:p1");
    void tracker.refresh([pane("ses_other")]);
    expect((await asked)?.tasks.map((task) => [task.id, task.status])).toEqual([["ses_other_child", "running"]]);
  });

  it("never takes a read of a pane begun before one it already took", () => {
    const s = store();
    s.session("ses_working", NOW - 5 * MIN);
    s.prompt("ses_working", NOW - 5 * MIN);
    const resets: [string, boolean][] = [];
    const tracker = new OpencodeSubagentStatus({ store: () => s.path, now: () => NOW, onChange: () => undefined, onReset: (paneId, first) => resets.push([paneId, first]) });
    const stale = tracker.beginRead();
    tracker.ensure(pane(s.parent));
    tracker.poll();
    tracker.refresh([pane(null)], stale);
    tracker.refresh([], stale);
    expect(tracker.sessionOf("w1:p1")?.live).toBe(true);
    expect(tracker.countOf("w1:p1")).toBe(1);
    tracker.refresh([pane(s.parent)]);
    expect(resets).toEqual([]);
  });

  it("holds a pane's count while its parent waits on a child that went idle, and drops it at the parent's answer", () => {
    const s = store();
    const changes: unknown[] = [];
    const tracker = new OpencodeSubagentStatus({ store: () => s.path, now: () => NOW, parentEnds: () => true, onChange: (...args) => changes.push(args) });
    s.prompt(s.parent, NOW - 10 * MIN);
    s.session("ses_fg", NOW - 5 * MIN);
    s.call("ses_fg", NOW - 5 * MIN, "running");
    s.prompt("ses_fg", NOW - 5 * MIN);
    tracker.refresh([pane(s.parent)]);
    expect(tracker.countOf("w1:p1")).toBe(1);
    s.idle("ses_fg", NOW - 4 * MIN);
    tracker.poll();
    expect(tracker.countOf("w1:p1")).toBe(1);
    s.answer(NOW - 2 * MIN, "ses_fg", NOW - 5 * MIN, "completed");
    tracker.poll();
    expect(changes).toEqual([["w1:p1", 1, 1, NOW - 10 * MIN, false], ["w1:p1", 0, 0, NOW - 10 * MIN, false]]);
  });

  it("reads a parent row taken out and another put at its seq, and does not keep what the old one said", () => {
    const s = store();
    const tracker = new OpencodeSubagentStatus({ store: () => s.path, now: () => NOW, parentEnds: () => true, onChange: () => undefined });
    s.prompt(s.parent, NOW - 10 * MIN);
    s.session("ses_child", NOW - 5 * MIN);
    s.call("ses_child", NOW - 5 * MIN, "completed");
    s.prompt("ses_child", NOW - 5 * MIN);
    s.step("ses_child", NOW - 4 * MIN);
    tracker.refresh([pane(s.parent)]);
    expect(tracker.countOf("w1:p1")).toBe(0);
    const { id, seq } = s.db.query<{ id: string; seq: number }, [string]>("SELECT id, seq FROM session_message WHERE session_id = ? AND type = 'assistant'").get(s.parent)!;
    s.db.query("DELETE FROM session_message WHERE id = ?").run(id);
    s.prompt(s.parent, NOW - 6 * MIN);
    s.db.query("UPDATE session_message SET seq = ? WHERE session_id = ? AND seq = (SELECT max(seq) FROM session_message WHERE session_id = ?)").run(seq, s.parent, s.parent);
    tracker.poll();
    expect(tracker.countOf("w1:p1")).toBe(1);
  });

  it("counts a turn's subagent in the frame that ends it however long the parent's history, once read before", async () => {
    const s = store();
    for (let n = 0; n < 2 * SUBAGENT_PAGE + 5; n++) s.step(s.parent, NOW - 30 * MIN + n);
    const tracker = new OpencodeSubagentStatus({ store: () => s.path, now: () => NOW, parentEnds: () => true, onChange: () => undefined });
    await tracker.refresh([pane(s.parent)]);
    s.prompt(s.parent, NOW - 5 * MIN);
    s.session("ses_fg", NOW - 4 * MIN);
    s.call("ses_fg", NOW - 4 * MIN, "running");
    s.prompt("ses_fg", NOW - 4 * MIN);
    s.idle("ses_fg", NOW - 3 * MIN);
    void tracker.poll("w1:p1");
    expect(tracker.countOf("w1:p1")).toBe(1);
  });

  it("counts a running child in the frame that ends a turn while a long parent history is first read", async () => {
    const s = store();
    for (let n = 0; n < 2 * SUBAGENT_PAGE + 5; n++) s.step(s.parent, NOW - 30 * MIN + n);
    s.prompt(s.parent, NOW - 5 * MIN);
    s.session("ses_working", NOW - 4 * MIN);
    s.prompt("ses_working", NOW - 4 * MIN);
    const tracker = new OpencodeSubagentStatus({ store: () => s.path, now: () => NOW, parentEnds: () => true, onChange: () => undefined });
    const read = tracker.refresh([pane(s.parent)]);
    expect(tracker.countOf("w1:p1")).toBe(1);
    await read;
    expect(tracker.countOf("w1:p1")).toBe(1);
  });

  it("reads again a call answered in place at an older time than the read before saw (a clock set back)", () => {
    const s = store();
    const tracker = new OpencodeSubagentStatus({ store: () => s.path, now: () => NOW, parentEnds: () => true, onChange: () => undefined });
    s.prompt(s.parent, NOW - 10 * MIN);
    s.session("ses_fg", NOW - 5 * MIN);
    s.call("ses_fg", NOW - 5 * MIN, "running");
    s.prompt("ses_fg", NOW - 5 * MIN);
    s.idle("ses_fg", NOW - 4 * MIN);
    tracker.refresh([pane(s.parent)]);
    expect(tracker.countOf("w1:p1")).toBe(1);
    s.answer(NOW - 30 * MIN, "ses_fg", NOW - 5 * MIN, "completed");
    tracker.poll();
    expect(tracker.countOf("w1:p1")).toBe(0);
  });

  it("says a count that fell only because Settings -> Read OpenCode subagent ends from their session was turned off ended nothing", () => {
    const s = store();
    let parentEnds = true;
    const changes: unknown[] = [];
    const tracker = new OpencodeSubagentStatus({ store: () => s.path, now: () => NOW, parentEnds: () => parentEnds, onChange: (...args) => changes.push(args) });
    s.prompt(s.parent, NOW - 10 * MIN);
    s.session("ses_fg", NOW - 5 * MIN);
    s.call("ses_fg", NOW - 5 * MIN, "running");
    s.prompt("ses_fg", NOW - 5 * MIN);
    s.idle("ses_fg", NOW - 4 * MIN);
    tracker.refresh([pane(s.parent)]);
    parentEnds = false;
    tracker.poll();
    expect(changes).toEqual([["w1:p1", 1, 1, NOW - 10 * MIN, false], ["w1:p1", 0, 0, NOW - 10 * MIN, true]]);
  });

  it("takes a notice set aside for a waited call once that call is answered as having joined the notice's job", async () => {
    const s = store("ses_parent", "opencode");
    const tracker = new OpencodeSubagentStatus({ store: () => s.path, now: () => NOW, parentEnds: () => true, onChange: () => undefined });
    s.prompt(s.parent, NOW - 30 * MIN);
    s.session("ses_child", NOW - 20 * MIN);
    s.call("ses_child", NOW - 20 * MIN, "background");
    s.prompt("ses_child", NOW - 20 * MIN);
    s.call("ses_child", NOW - 10 * MIN, "running", { sessionID: "ses_child" });
    s.prompt("ses_child", NOW - 10 * MIN);
    s.idle("ses_child", NOW - 9 * MIN);
    s.notice("ses_child", NOW - 8 * MIN, "completed", NOW - 20 * MIN);
    s.prompt(s.parent, NOW - 7 * MIN);
    await tracker.refresh([pane(s.parent)]);
    expect(tracker.countOf("w1:p1")).toBe(1);
    s.answer(NOW - 6 * MIN, "ses_child", NOW - 10 * MIN, "background", { sessionID: "ses_child" });
    await tracker.poll();
    expect(tracker.countOf("w1:p1")).toBe(0);
  });

  it("keeps the count while the store cannot be read", () => {
    const s = store();
    let path = s.path;
    const changes: unknown[] = [];
    const tracker = new OpencodeSubagentStatus({ store: () => path, now: () => NOW, onChange: (...args) => changes.push(args) });
    s.session("ses_working", NOW - 5 * MIN);
    s.prompt("ses_working", NOW - 5 * MIN);
    tracker.refresh([pane(s.parent)]);
    expect(tracker.countOf("w1:p1")).toBe(1);
    path = join(root, "missing.db");
    tracker.poll();
    expect(tracker.countOf("w1:p1")).toBe(1);
    expect(changes).toHaveLength(1);
  });

  it("answers the background tasks route with the pane's subagents, the live session's before a Claude one gone", async () => {
    const s = store();
    const now = Date.now();
    s.session("ses_working", now - 5 * MIN);
    s.prompt("ses_working", now - 5 * MIN);
    const listOf = async (session: string, live: boolean) => {
      const state = await pagedState(s.path, session, live);
      return state === null ? null : { tasks: state.tasks, unlisted: state.unlisted, read: { path: s.path, session, live } };
    };
    const request = () => [new Request("http://localhost/api/pane/omo-tasks?pane_id=w1:p1"), new URL("http://localhost/api/pane/omo-tasks?pane_id=w1:p1"), "/api/pane/omo-tasks"] as const;
    const ask = (live: boolean, claudeLive: boolean | null) => handleTasksRequest(...request(), {
      omo: { sessionOf: () => null },
      claudeAgents: { sessionOf: () => claudeLive === null ? null : { path: join(root, "absent.jsonl"), live: claudeLive, startedAt: null }, ensure: async () => undefined },
      opencodeAgents: { sessionOf: () => ({ path: s.path, session: s.parent, live }), ensure: () => false, beginRead: () => 0, tasksOf: () => listOf(s.parent, live) },
    });
    const tasks = async (response: Response | null) => ((await response!.json()) as { tasks: { id: string; status: string }[] }).tasks.map((task) => [task.id, task.status]);
    expect(await tasks(await ask(true, null))).toEqual([["ses_working", "running"]]);
    expect(await tasks(await ask(false, false))).toEqual([["ses_working", "lost"]]);
    expect(await tasks(await ask(false, true))).toEqual([]);
    let claudeNow = false;
    let reads = 0;
    const moving = await handleTasksRequest(...request(), {
      omo: { sessionOf: () => null },
      claudeAgents: { sessionOf: () => claudeNow ? { path: join(root, "absent.jsonl"), live: true, startedAt: null } : null, ensure: async () => undefined },
      opencodeAgents: {
        sessionOf: () => ({ path: s.path, session: s.parent, live: !claudeNow }), ensure: () => false, beginRead: () => 0,
        tasksOf: async () => { reads++; const read = await listOf(s.parent, true); claudeNow = true; return read; },
      },
    });
    expect(await tasks(moving)).toEqual([]);
    expect(reads).toBe(1);
    s.session("ses_moved_child", now - MIN, { parent: "ses_moved" });
    s.prompt("ses_moved_child", now - MIN);
    let moved = false;
    const swapped = await handleTasksRequest(...request(), {
      omo: { sessionOf: () => null },
      claudeAgents: { sessionOf: () => null, ensure: async () => undefined },
      opencodeAgents: {
        sessionOf: () => ({ path: s.path, session: moved ? "ses_moved" : s.parent, live: true }), ensure: () => false, beginRead: () => 0,
        tasksOf: async () => { const read = await listOf(moved ? "ses_moved" : s.parent, true); moved = true; return read; },
      },
    });
    expect(await tasks(swapped)).toEqual([["ses_moved_child", "running"]]);
    const omoCwd = join(root, "omo-folder");
    mkdirSync(join(omoCwd, ".omo", "senpi-task", "tasks"), { recursive: true });
    writeFileSync(join(omoCwd, ".omo", "senpi-task", "tasks", "st_1.json"), JSON.stringify({ task_id: "st_1", parent_session_id: "omo-session", host_pid: process.pid, status: "running", task_summary: "index the repo", started_at: new Date(now - MIN).toISOString() }));
    let omoNow = false;
    const toOmo = await handleTasksRequest(...request(), {
      omo: { sessionOf: () => omoNow ? { cwd: omoCwd, sessionId: "omo-session" } : null },
      claudeAgents: { sessionOf: () => null, ensure: async () => undefined },
      opencodeAgents: {
        sessionOf: () => ({ path: s.path, session: s.parent, live: true }), ensure: () => false, beginRead: () => 0,
        tasksOf: async () => { const read = await listOf(s.parent, true); omoNow = true; return read; },
      },
    });
    expect(await tasks(toOmo)).toEqual([["st_1", "running"]]);
    let flips = 0;
    const restless = await handleTasksRequest(...request(), {
      omo: { sessionOf: () => null },
      claudeAgents: { sessionOf: () => null, ensure: async () => undefined },
      opencodeAgents: {
        sessionOf: () => ({ path: s.path, session: flips === 0 ? s.parent : `ses_flip${flips}`, live: true }), ensure: () => false, beginRead: () => 0,
        tasksOf: async () => { const read = await listOf(flips === 0 ? s.parent : `ses_flip${flips}`, true); flips++; return read; },
      },
    });
    expect(await tasks(restless)).toEqual([]);
    expect(flips).toBe(3);
  });
});
