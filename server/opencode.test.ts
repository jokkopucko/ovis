import { afterAll, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import * as herdr from "./herdr/client.ts";
import { forgetOpencodeRead, forgetOpencodeState, OPENCODE_ROW_SIZE, opencodeConversation, opencodeDatabasePath, opencodeFreshSession, opencodeImage, opencodeReadKey, opencodeRecord, opencodeSessionId, opencodeSessionsTitled, opencodeToolOutput, opencodeTurns, pageStart, type OpencodeAnswer, type RowMeta } from "./opencode.ts";
import type { ConversationPart, ConversationTurn } from "../shared/protocol.ts";

const root = mkdtempSync(join(tmpdir(), "herdr-opencode-store-"));
const opened: Database[] = [];
// Windows refuses to delete a file a handle still holds
afterAll(() => { for (const db of opened) db.close(); rmSync(root, { recursive: true, force: true }); });
beforeEach(() => forgetOpencodeState());

// The tables OpenCode 2.0.24 reads a conversation from, as it creates them (columns the reader
// never touches left out).
const SCHEMA = `
CREATE TABLE session_v2 (
  id text PRIMARY KEY, project_id text NOT NULL, parent_id text, slug text NOT NULL, directory text NOT NULL,
  title text, version text NOT NULL, revert text, time_created integer NOT NULL, time_updated integer NOT NULL
);
CREATE TABLE session_message (
  id text PRIMARY KEY, session_id text NOT NULL, type text NOT NULL, seq integer NOT NULL,
  time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL,
  CONSTRAINT fk_session_message_session_id_session_v2_id_fk FOREIGN KEY (session_id) REFERENCES session_v2(id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX session_message_session_seq_idx ON session_message (session_id, seq);
CREATE INDEX session_message_session_type_seq_idx ON session_message (session_id, type, seq);
`;

let stores = 0;
let ids = 0;
const T0 = Date.parse("2026-10-07T09:00:00Z");

function store(session = "ses_test1") {
  const path = join(root, `opencode-${++stores}.db`);
  const db = new Database(path, { create: true });
  opened.push(db);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = OFF");
  db.exec(SCHEMA);
  db.query("INSERT INTO session_v2 (id, project_id, slug, directory, title, version, time_created, time_updated) VALUES (?, 'global', 'slug', ?, 'Test', '2.0.24', ?, ?)").run(session, root, T0, T0);
  let seq = 3;
  const add = (type: string, data: Record<string, unknown>, options: { id?: string; session?: string } = {}): string => {
    const id = options.id ?? `msg_${(++ids).toString().padStart(6, "0")}TEST`;
    seq += 1 + (ids % 3);
    db.query("INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(id, options.session ?? session, type, seq, T0 + seq, T0 + seq, JSON.stringify(data));
    return id;
  };
  const prompt = (text: string) => add("user", { time: { created: T0 }, text, files: [], agents: [] });
  const answer = (text: string, extra: Record<string, unknown> = {}) => add("assistant", {
    time: { created: T0 + 1, completed: T0 + 2 }, agent: "build", model: { id: "deepseek-v4.1-flash", providerID: "opencode-go", variant: "default" },
    content: [{ type: "text", text }], finish: "stop", tokens: { input: 10, output: 5, reasoning: 1, cache: { read: 100, write: 0 } }, ...extra,
  });
  const idle = () => add("idle", { time: { created: T0 + 3 }, outcome: "succeeded" });
  return { path, db, session, add, prompt, answer, idle };
}

function storeV24() {
  const s = store();
  s.db.exec(`
    UPDATE session_v2 SET version = '2.4.1';
    CREATE TABLE session_part (
      message_id text NOT NULL, session_id text NOT NULL, ordinal integer NOT NULL,
      type text NOT NULL, call_id text, time_created integer NOT NULL, time_updated integer NOT NULL,
      data text NOT NULL, PRIMARY KEY (message_id, ordinal)
    );
    CREATE INDEX session_part_session_message_idx ON session_part (session_id, message_id, ordinal);
  `);
  const part = (messageId: string, ordinal: number, data: Record<string, unknown>, updated = T0) => {
    s.db.query("INSERT OR REPLACE INTO session_part (message_id, session_id, ordinal, type, call_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(messageId, s.session, ordinal, String(data.type), typeof data.id === "string" ? data.id : null, T0, updated, JSON.stringify(data));
  };
  return { ...s, part };
}

// OpenCode 1.x's own tables, as its service creates them (columns the reader never touches left out):
// one `message` row per user prompt or assistant step, its blocks in `part` rows, ordered by time.
const SCHEMA_V1 = `
CREATE TABLE session (
  id text PRIMARY KEY, project_id text NOT NULL, slug text NOT NULL, directory text NOT NULL,
  title text NOT NULL, version text NOT NULL, revert text, model text,
  time_created integer NOT NULL, time_updated integer NOT NULL
);
CREATE TABLE message (
  id text PRIMARY KEY, session_id text NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL
);
CREATE INDEX message_session_time_created_id_idx ON message (session_id, time_created, id);
CREATE TABLE part (
  id text PRIMARY KEY, message_id text NOT NULL, session_id text NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL
);
CREATE INDEX part_message_id_id_idx ON part (message_id, id);
CREATE INDEX part_session_idx ON part (session_id);
`;

function storeV1(session = "ses_old1") {
  const path = join(root, `opencode-v1-${++stores}.db`);
  const db = new Database(path, { create: true });
  opened.push(db);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = OFF");
  db.exec(SCHEMA_V1);
  db.query("INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated) VALUES (?, 'global', 'slug', ?, 'Old', '1.18.32', ?, ?)").run(session, root, T0, T0);
  let clock = T0;
  let parts = 0;
  const message = (role: string, data: Record<string, unknown>): string => {
    const id = `msg_${(++ids).toString().padStart(6, "0")}V1`;
    clock += 1;
    db.query("INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)")
      .run(id, session, clock, clock, JSON.stringify({ role, time: { created: clock }, ...data }));
    return id;
  };
  const part = (messageId: string, data: Record<string, unknown>): void => {
    clock += 1;
    db.query("INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)")
      .run(`prt_${(++parts).toString().padStart(6, "0")}V1`, messageId, session, clock, clock, JSON.stringify(data));
  };
  const user = (text: string): string => {
    const id = message("user", { agent: "build", model: { modelID: "deepseek-v4.1-flash", providerID: "opencode-go" }, summary: { diffs: [] } });
    part(id, { type: "text", text });
    return id;
  };
  const assistant = (blocks: Record<string, unknown>[], extra: Record<string, unknown> = {}): string => {
    const id = message("assistant", { modelID: "deepseek-v4.1-flash", providerID: "opencode-go", ...extra });
    for (const block of blocks) part(id, block);
    return id;
  };
  return { path, db, session, message, part, user, assistant };
}

const page = (answer: OpencodeAnswer) => {
  if (answer.kind !== "page") throw new Error(`expected a page, got ${JSON.stringify(answer)}`);
  return answer;
};

const tool = (name: string, state: Record<string, unknown>, id = "call_1") => ({ type: "tool", id, name, executed: false, state, time: { created: T0, completed: T0 } });
const record = (type: string, data: Record<string, unknown>, id = "msg_row1") => opencodeRecord(id, type, data);
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

describe("where OpenCode keeps its store", () => {
  it("follows the paths OpenCode resolves for itself, the same on every platform", () => {
    const home = join(root, "home");
    const data = join(root, "data");
    // OpenCode has no per-platform data dir: macOS and Windows use ~/.local/share too
    expect(opencodeDatabasePath({}, home)).toBe(join(home, ".local", "share", "opencode", "opencode.db"));
    expect(opencodeDatabasePath({ XDG_DATA_HOME: data }, home)).toBe(join(data, "opencode", "opencode.db"));
    // OPENCODE_DB names a file relative to the data dir, or anywhere
    expect(opencodeDatabasePath({ OPENCODE_DB: "other.db" }, home)).toBe(join(home, ".local", "share", "opencode", "other.db"));
    const elsewhere = join(root, "elsewhere", "x.db");
    expect(opencodeDatabasePath({ OPENCODE_DB: elsewhere, XDG_DATA_HOME: data }, home)).toBe(resolve(elsewhere));
    expect(opencodeDatabasePath({ OPENCODE_DB: ":memory:" }, home)).toBeNull();
  });

  it("binds a pane by the session herdr's OpenCode integration reported, and nothing else", () => {
    const session = (value: string, agent = "opencode", kind = "id") => ({ agent_session: { agent, kind, source: "herdr:opencode", value } });
    expect(opencodeSessionId(session("ses_eea6b0be2ffef1CA3bgZXhfSW2"))).toBe("ses_eea6b0be2ffef1CA3bgZXhfSW2");
    expect(opencodeSessionId(session("ses_eea6b0be2ffef1CA3bgZXhfSW2", "pi"))).toBeNull();
    expect(opencodeSessionId(session("/home/u/session.jsonl", "opencode", "path"))).toBeNull();
    expect(opencodeSessionId({ agent_session: { agent: "opencode", kind: "id", source: "something-else", value: "ses_abc" } })).toBeNull();
    for (const value of ["ses_", "ses_../x", "ses_a b", "msg_abc", "ses_a'; DROP TABLE x"]) expect(opencodeSessionId(session(value))).toBeNull();
    expect(opencodeSessionId({ agent_session: null })).toBeNull();
    expect(opencodeSessionId({})).toBeNull();
  });
});

describe("OpenCode's rows as a conversation", () => {
  it("folds a prompt's steps, with their thinking, tools and outputs, into one answer", () => {
    const turns = opencodeTurns([
      record("user", { time: { created: T0 }, text: "Create hello.txt", files: [], agents: [] }),
      record("assistant", {
        time: { created: T0 + 10, completed: T0 + 20 }, model: { id: "m" },
        content: [
          { type: "reasoning", text: "Write it, then read it." },
          tool("write", { status: "completed", input: { path: "hello.txt", content: "hi\n" }, content: [{ type: "text", text: "Created file successfully: hello.txt" }] }),
        ],
        finish: "tool-calls",
      }),
      record("assistant", {
        time: { created: T0 + 30, completed: T0 + 40 },
        content: [tool("shell", { status: "completed", input: { command: "cat hello.txt" }, content: [{ type: "text", text: "hi\n" }], metadata: { exit: 0 } })],
        finish: "tool-calls",
      }),
      record("assistant", { time: { created: T0 + 50, streamed: T0 + 55, completed: T0 + 60 }, content: [{ type: "text", text: "It says hi." }], finish: "stop" }),
      record("idle", { time: { created: T0 + 61 }, outcome: "succeeded" }),
    ]);
    expect(turns).toEqual([
      { role: "user", ts: new Date(T0).toISOString(), parts: [{ kind: "text", text: "Create hello.txt" }] },
      {
        role: "assistant", ts: new Date(T0 + 10).toISOString(), end_ts: new Date(T0 + 60).toISOString(), parts: [
          { kind: "thinking", text: "Write it, then read it." },
          { kind: "tool", name: "write", call_id: "call_1", summary: "hello.txt", input: JSON.stringify({ path: "hello.txt", content: "hi\n" }, null, 2), output: "Created file successfully: hello.txt", state: "ok" },
          { kind: "tool", name: "shell", call_id: "call_1", summary: "cat hello.txt", input: JSON.stringify({ command: "cat hello.txt" }, null, 2), output: "hi\n", state: "ok" },
          { kind: "text", text: "It says hi.", phase: "final_answer" },
        ],
      },
    ]);
  });

  it("shows a prompt as typed, with its pasted images and the skills it mentions", () => {
    const user = record("user", {
      time: { created: T0 }, text: "expanded prompt", metadata: { displayText: "look at [Image 1] @review" },
      files: [
        { data: PNG.toString("base64"), mime: "image/png", source: { type: "inline" }, name: "clipboard" },
        // a file attached by path is never read from disk, and only image types are shown
        { mime: "image/png", source: { type: "file", path: "/etc/shot.png" }, name: "shot.png" },
        { data: "PGh0bWw+", mime: "text/html", source: { type: "inline" } },
      ],
      skills: [{ id: "review", name: "review", text: "<skill_content>…</skill_content>" }, { id: "bad\nname", name: "bad\nname" }],
      agents: [],
    }, "msg_user1");
    expect(user).toEqual({ role: "user", ts: new Date(T0).toISOString(), parts: [
      { kind: "image", media_type: "image/png", ref: "opencode:msg_user1:0" },
      { kind: "text", text: "look at [Image 1] @review" },
      { kind: "skill", skill: { name: "review", evidence: "instructions", status: "loaded" } },
    ] });
  });

  it("marks failed tools, names skills and searches, and cuts a long output with a way to fetch it", () => {
    const step = record("assistant", {
      time: { created: T0 }, finish: "tool-calls",
      content: [
        tool("webfetch", { status: "error", input: { url: "https://example.com/" }, error: { type: "unknown", message: "401 GET https://example.com/" } }),
        tool("shell", { status: "completed", input: { command: "false" }, content: [{ type: "text", text: "" }], metadata: { exit: 1 } }),
        tool("skill", { status: "completed", input: { id: "opencode" }, content: [{ type: "text", text: "<skill_content name=\"OpenCode\">…" }] }),
        tool("websearch", { status: "completed", input: { query: "Ovis" }, content: [{ type: "text", text: "results" }] }),
        tool("read", { status: "completed", input: { path: "big.log" }, content: [{ type: "text", text: "x".repeat(5000) }] }),
      ],
    }, "msg_step1");
    const parts = step !== null && step.role === "assistant" ? step.parts as Extract<ConversationPart, { kind: "tool" }>[] : [];
    expect(parts.map((part) => [part.name, part.summary, part.error ?? false])).toEqual([
      ["webfetch", "https://example.com/", true],
      ["shell", "false", true],
      ["skill", "opencode", false],
      ["websearch", "Ovis", false],
      ["read", "big.log", false],
    ]);
    expect(parts[0]!.output).toBe("401 GET https://example.com/");
    expect(parts[2]!.skill).toEqual({ name: "opencode", evidence: "invocation", status: "loaded" });
    expect(parts[4]!.output_ref).toBe("msg_step1:4");
    expect(parts[4]!.output_size).toBe(5000);
  });

  it("records each call's outcome as OpenCode does: waiting or running, completed, failed", () => {
    const todos = (done: number) => ({ todos: ["a", "b"].map((content, index) => ({ content, status: index < done ? "completed" : "pending", priority: "medium" })) });
    const step = record("assistant", {
      time: { created: T0 }, finish: "tool-calls",
      content: [
        tool("todowrite", { status: "completed", input: todos(1), content: [{ type: "text", text: "[]" }] }, "call_a"),
        tool("todowrite", { status: "running", input: todos(2), content: [] }, "call_b"),
        tool("todowrite", { status: "pending", input: {}, content: [] }, "call_c"),
        tool("todowrite", { status: "error", input: todos(2), error: { type: "unknown", message: "invalid" } }, "call_d"),
      ],
    });
    const parts = step !== null && step.role === "assistant" ? step.parts as Extract<ConversationPart, { kind: "tool" }>[] : [];
    expect(parts.map((part) => part.state)).toEqual(["ok", "pending", "pending", "error"]);
  });

  it("reads a call whose input OpenCode 2 is still streaming as not answered yet, so it never stands for the list", () => {
    // as opencode 2.2.2 stored a held session: a completed `todowrite`, then the next one while the model still wrote it
    const step = record("assistant", {
      time: { created: T0 }, finish: "tool-calls",
      content: [
        tool("todowrite", { status: "completed", input: { todos: [{ content: "a", status: "in_progress" }] }, content: [{ type: "text", text: "Todos updated: 0/1 completed, 1 in progress." }] }, "call_todo_0"),
        { type: "tool", id: "call_todo_1", name: "todowrite", state: { status: "streaming", input: "" }, time: { created: T0 } },
      ],
    });
    const parts = step !== null && step.role === "assistant" ? step.parts as Extract<ConversationPart, { kind: "tool" }>[] : [];
    expect(parts.map((part) => part.state)).toEqual(["ok", "pending"]);
  });

  it("offers a tool's pictures by their place among the message's images", () => {
    const step = record("assistant", {
      time: { created: T0 }, finish: "tool-calls",
      content: [
        tool("read", { status: "completed", input: { path: "a.png" }, content: [{ type: "text", text: "Image read successfully" }, { type: "file", uri: `data:image/png;base64,${PNG.toString("base64")}`, mime: "image/png" }] }),
        tool("read", { status: "completed", input: { path: "b.txt" }, content: [{ type: "file", uri: "data:text/plain;base64,aGk=", mime: "text/plain" }] }),
        tool("read", { status: "completed", input: { path: "c.webp" }, content: [{ type: "file", uri: "data:image/webp;base64,UklGRg==", mime: "image/webp" }] }),
      ],
    }, "msg_pics");
    const parts = step !== null && step.role === "assistant" ? step.parts as Extract<ConversationPart, { kind: "tool" }>[] : [];
    expect(parts.map((part) => part.images)).toEqual([
      [{ media_type: "image/png", ref: "opencode:msg_pics:0" }],
      undefined,
      [{ media_type: "image/webp", ref: "opencode:msg_pics:1" }],
    ]);
  });

  it("says why a step failed, but not that Esc interrupted it", () => {
    const failed = record("assistant", { time: { created: T0 }, content: [], finish: "error", error: { type: "api", message: "Rate limited" } });
    const aborted = record("assistant", { time: { created: T0 }, content: [{ type: "text", text: "partial" }], finish: "error", error: { type: "aborted", message: "Step interrupted" } });
    expect(failed !== null && failed.role === "assistant" && failed.parts).toEqual([{ kind: "text", text: "Error: Rate limited" }]);
    expect(aborted !== null && aborted.role === "assistant" && aborted.parts).toEqual([{ kind: "text", text: "partial" }]);
  });

  it("puts what woke the model in the user's seat, and keeps a finished answer apart from the work after it", () => {
    const turns = opencodeTurns([
      record("user", { time: { created: T0 }, text: "run it in the background" }),
      record("assistant", { time: { created: T0 + 1 }, content: [{ type: "text", text: "Started." }], finish: "stop" }),
      record("idle", { time: { created: T0 + 2 }, outcome: "succeeded" }),
      record("synthetic", {
        metadata: { source: "shell", shellID: "sh_1", jobID: "sh_1", state: "completed", exit: 0 }, time: { created: T0 + 3 },
        text: "<shell id=\"sh_1\" state=\"completed\" command=\"sleep 30 && echo ok\">\nok\n\n</shell>", description: "sleep 30 && echo ok",
      }),
      record("assistant", { time: { created: T0 + 4 }, content: [{ type: "text", text: "It printed ok." }], finish: "stop" }),
      record("synthetic", {
        metadata: { source: "subagent", childID: "ses_child", agent: "web-search", state: "completed" }, time: { created: T0 + 5 },
        text: "<subagent sessionID=\"ses_child\" state=\"completed\" description=\"Find sources\">\nThree sources.\n</subagent>", description: "Find sources",
      }),
      record("assistant", { time: { created: T0 + 6 }, content: [{ type: "text", text: "The subagent found three." }], finish: "stop" }),
    ]);
    expect(turns.map((turn) => [turn.role, turn.parts])).toEqual([
      ["user", [{ kind: "text", text: "run it in the background" }]],
      ["assistant", [{ kind: "text", text: "Started.", phase: "final_answer" }]],
      ["user", [{ kind: "notice", text: "sleep 30 && echo ok\nok", source: "shell" }]],
      ["assistant", [{ kind: "text", text: "It printed ok.", phase: "final_answer" }]],
      ["user", [{ kind: "task_result", tasks: [{
        id: "ses_child", title: "Find sources", agent: "web-search", model: null, status: "completed",
        duration_ms: null, turns: null, tool_calls: null, tokens: null, result: "Three sources.",
      }] }]],
      ["assistant", [{ kind: "text", text: "The subagent found three.", phase: "final_answer" }]],
    ]);
  });

  it("draws a subagent that failed or was cancelled as such, and a foreground one's answer without OpenCode's tag", () => {
    const wake = (state: string, body: string) => opencodeRecord("msg_wake", "synthetic", {
      metadata: { source: "subagent", childID: "ses_child", agent: "explore", state }, time: { created: T0 },
      text: `<subagent sessionID="ses_child" state="${state}" description="Scan">\n${body}\n</subagent>`, description: "Scan",
    });
    const card = (state: string, body: string) => {
      const found = wake(state, body);
      const part = found?.role === "user" ? found.parts[0] : undefined;
      return part?.kind === "task_result" ? part.tasks[0] : undefined;
    };
    expect([card("error", "provider failed")?.status, card("error", "provider failed")?.result]).toEqual(["failed", "provider failed"]);
    expect(card("cancelled", "Subagent cancelled")?.status).toBe("cancelled");
    const long = card("completed", "x".repeat(20_000));
    expect([long?.result.length, long?.result_cut]).toEqual([16_000, true]);
    const step = opencodeRecord("msg_call", "assistant", {
      time: { created: T0, completed: T0 + 1 }, finish: "tool-calls",
      content: [{ type: "tool", name: "subagent", state: { status: "completed", input: { agent: "explore", description: "Scan", prompt: "scan it" },
        content: [{ type: "text", text: "<subagent sessionID=\"ses_child\" state=\"completed\">\nAll clear.\n</subagent>" }], metadata: { sessionID: "ses_child", status: "completed" } } }],
    });
    const tool = step?.role === "assistant" ? step.parts[0] : undefined;
    expect(tool?.kind === "tool" ? [tool.summary, tool.output] : null).toEqual(["Scan", "All clear."]);
  });

  it("shows a command the user ran once, with its output, and leaves instructions and switches out", () => {
    const turns = opencodeTurns([
      record("shell", { metadata: { background: true }, time: { created: T0 }, shellID: "sh_2", command: "git diff", status: "exited", exit: 0, output: { output: "diff --git a/x b/x\n", size: 19, truncated: false } }),
      record("synthetic", { metadata: { source: "shell", shellID: "sh_2", state: "completed", exit: 0 }, time: { created: T0 + 1 }, text: "The following shell command was executed by the user:\n<shell id=\"sh_2\">\ndiff\n</shell>" }),
      record("system", { metadata: { notice: "instructions" }, time: { created: T0 + 2 }, text: "New instructions apply from: AGENTS.md", description: "Instructions updated" }),
      record("agent-switched", { time: { created: T0 + 3 }, agent: "plan", previous: "build" }),
      record("model-switched", { time: { created: T0 + 4 }, model: { id: "other" }, previous: { id: "m" } }),
      record("user", { time: { created: T0 + 5 }, text: "commit it" }),
    ]);
    expect(turns.map((turn) => turn.parts)).toEqual([
      [{ kind: "notice", text: "$ git diff\ndiff --git a/x b/x", source: "shell" }],
      [{ kind: "text", text: "commit it" }],
    ]);
    // a Windows shell ends its lines with \r\n
    const windows = record("shell", { time: { created: T0 }, command: "dir", output: { output: "a.txt\r\nb.txt\r\n" } });
    expect(windows !== null && windows.role === "user" && windows.parts).toEqual([{ kind: "notice", text: "$ dir\na.txt\r\nb.txt", source: "shell" }]);
  });

  it("marks where the conversation was compacted", () => {
    expect(opencodeTurns([
      record("compaction", { time: { created: T0 }, status: "completed", reason: "manual", summary: "## Objective\n- tests" }),
      record("compaction", { time: { created: T0 + 1 }, status: "failed", reason: "auto" }),
    ])).toEqual([{ role: "user", ts: new Date(T0).toISOString(), parts: [{ kind: "compact", text: "## Objective\n- tests" }] }]);
  });
});

describe("a page of an OpenCode session", () => {
  it("reads a short session whole, with the settings OpenCode's footer shows", () => {
    const s = store();
    s.prompt("hello");
    s.answer("hi");
    s.idle();
    const answer = page(opencodeConversation(s.path, s.session));
    expect(answer.cursor).toBeNull();
    expect(answer.history_id).toBe("opencode-ses_test1");
    expect(answer.turns.map((turn) => turn.parts)).toEqual([[{ kind: "text", text: "hello" }], [{ kind: "text", text: "hi", phase: "final_answer" }]]);
    // input + output + reasoning + both cache tiers, as the footer counts them; no window is stated
    expect(answer.metadata).toEqual({ model: "deepseek-v4.1-flash", reasoning_effort: null, context: { used: 116, window: null } });
  });

  it("follows a model switch and a reasoning variant, and drops the usage a compaction made stale", () => {
    const s = store();
    s.prompt("one");
    s.answer("a", { model: { id: "deepseek-v4.1-flash", providerID: "opencode-go", variant: "max" } });
    expect(page(opencodeConversation(s.path, s.session)).metadata).toEqual({ model: "deepseek-v4.1-flash", reasoning_effort: "max", context: { used: 116, window: null } });
    s.add("model-switched", { time: { created: T0 }, model: { id: "glm-5.3", providerID: "opencode-go", variant: "high" } });
    expect(page(opencodeConversation(s.path, s.session)).metadata).toEqual({ model: "glm-5.3", reasoning_effort: "high", context: { used: 116, window: null } });
    s.add("compaction", { time: { created: T0 }, status: "completed", summary: "folded" });
    expect(page(opencodeConversation(s.path, s.session)).metadata).toEqual({ model: "glm-5.3", reasoning_effort: "high" });
  });

  it("pages a long session by prompt, and the pages meet exactly", () => {
    const s = store();
    for (let n = 0; n < 120; n++) { s.prompt(`p${n}`); s.answer(`a${n}`); s.idle(); }
    const newest = page(opencodeConversation(s.path, s.session));
    expect(newest.turns.length).toBe(100);
    expect(newest.turns[0]!.parts).toEqual([{ kind: "text", text: "p70" }]);
    expect(newest.cursor).toMatch(/^opencode-ses_test1:\d+$/);
    const middle = page(opencodeConversation(s.path, s.session, { before: newest.cursor! }));
    expect(middle.turns[0]!.parts).toEqual([{ kind: "text", text: "p20" }]);
    const oldest = page(opencodeConversation(s.path, s.session, { before: middle.cursor! }));
    expect(oldest.cursor).toBeNull();
    const all = [...oldest.turns, ...middle.turns, ...newest.turns].filter((turn) => turn.role === "user").map((turn) => (turn.parts[0] as { text: string }).text);
    expect(all).toEqual(Array.from({ length: 120 }, (_, n) => `p${n}`));
    const since = page(opencodeConversation(s.path, s.session, { before: newest.cursor!, since: middle.cursor! }));
    expect(since.turns).toEqual(middle.turns);
    expect(since.cursor).toBe(middle.cursor);
  });

  it("pages at the size the chat asks for, and those pages meet exactly too", () => {
    const s = store();
    for (let n = 0; n < 120; n++) { s.prompt(`p${n}`); s.answer(`a${n}`); s.idle(); }
    const prompts = (turns: { role: string; parts: unknown[] }[]) => turns.filter((turn) => turn.role === "user").map((turn) => (turn.parts[0] as { text: string }).text);
    const newest = page(opencodeConversation(s.path, s.session, { prompts: 10 }));
    expect(prompts(newest.turns)).toEqual(Array.from({ length: 10 }, (_, n) => `p${110 + n}`));
    const older = page(opencodeConversation(s.path, s.session, { before: newest.cursor!, prompts: 10 }));
    expect(prompts(older.turns)).toEqual(Array.from({ length: 10 }, (_, n) => `p${100 + n}`));
    expect(page(opencodeConversation(s.path, s.session)).turns.length).toBe(100);
  });

  it("holds a chat's start while it is inside the newest page", () => {
    const s = store();
    for (let n = 0; n < 60; n++) { s.prompt(`p${n}`); s.answer(`a${n}`); s.idle(); }
    const newest = page(opencodeConversation(s.path, s.session));
    const held = page(opencodeConversation(s.path, s.session, { from: newest.cursor! }));
    expect(held.cursor).toBe(newest.cursor);
    s.prompt("p60"); s.answer("a60"); s.idle();
    const moved = page(opencodeConversation(s.path, s.session, { from: newest.cursor! }));
    expect(moved.cursor).not.toBe(newest.cursor);
    const between = page(opencodeConversation(s.path, s.session, { before: moved.cursor!, since: newest.cursor! }));
    expect(between.turns.map((turn) => turn.parts)).toEqual([[{ kind: "text", text: "p10" }], [{ kind: "text", text: "a10", phase: "final_answer" }]]);
  });

  it("refuses a cursor from another history", () => {
    const s = store();
    for (let n = 0; n < 60; n++) { s.prompt(`p${n}`); s.answer(`a${n}`); }
    const newest = page(opencodeConversation(s.path, s.session));
    const [, offset] = newest.cursor!.split(":");
    for (const cursor of [`opencode-ses_other:${offset}`, `${newest.history_id}:999999`, `${newest.history_id}:-1`, "garbage"]) {
      expect(opencodeConversation(s.path, s.session, { before: cursor })).toEqual({ kind: "history_changed" });
      expect(opencodeConversation(s.path, s.session, { from: cursor })).toEqual({ kind: "history_changed" });
    }
  });

  it("hides what an /undo took back, and refuses a cursor into the turns it deleted", () => {
    const s = store();
    for (let n = 0; n < 60; n++) { s.prompt(`p${n}`); s.answer(`a${n}`); s.idle(); }
    const undone = s.prompt("undo me");
    s.answer("undone"); s.idle();
    const before = page(opencodeConversation(s.path, s.session));
    s.db.query("UPDATE session_v2 SET revert = ? WHERE id = ?").run(JSON.stringify({ messageID: undone }), s.session);
    const staged = page(opencodeConversation(s.path, s.session));
    expect(staged.turns.at(-1)!.parts).toEqual([{ kind: "text", text: "a59", phase: "final_answer" }]);
    expect(staged.history_id).not.toBe(before.history_id);
    const { seq } = s.db.query<{ seq: number }, [string]>("SELECT seq FROM session_message WHERE id = ?").get(undone)!;
    s.db.query("DELETE FROM session_message WHERE session_id = ? AND seq >= ?").run(s.session, seq);
    s.db.query("UPDATE session_v2 SET revert = NULL WHERE id = ?").run(s.session);
    s.prompt("instead");
    const committed = page(opencodeConversation(s.path, s.session));
    expect(committed.turns.at(-1)!.parts).toEqual([{ kind: "text", text: "instead" }]);
    expect(committed.history_id).toBe(before.history_id);
    expect(page(opencodeConversation(s.path, s.session, { from: before.cursor! })).cursor).toBe(before.cursor);

    const held = page(opencodeConversation(s.path, s.session, { from: before.cursor! })).cursor!;
    const deeper = Number(held.split(":").at(-1)) - 1;
    s.db.query("DELETE FROM session_message WHERE session_id = ? AND seq >= ?").run(s.session, deeper);
    s.prompt("again");
    forgetOpencodeState();
    expect(opencodeConversation(s.path, s.session, { from: held })).toEqual({ kind: "history_changed" });
    expect(opencodeConversation(s.path, s.session, { before: held })).toEqual({ kind: "history_changed" });
    expect(page(opencodeConversation(s.path, s.session)).turns.at(-1)!.parts).toEqual([{ kind: "text", text: "again" }]);
  });

  it("sees a row rewritten twice in one millisecond once anything else is written", () => {
    // every update moves a row's time_updated, to the millisecond: a second write in the same one
    // leaves it where it was, and only the row's size says the row changed
    const s = store();
    s.prompt("go");
    const step = s.answer("work", { finish: undefined });
    const first = page(opencodeConversation(s.path, s.session));
    s.db.query("UPDATE session_message SET data = ? WHERE id = ?")
      .run(JSON.stringify({ time: { created: T0, completed: T0 + 9 }, content: [{ type: "text", text: "work, rewritten" }], finish: "stop" }), step);
    s.idle();
    const second = page(opencodeConversation(s.path, s.session));
    expect(second.signature).not.toBe(first.signature);
    expect(second.turns[1]!.parts).toEqual([{ kind: "text", text: "work, rewritten", phase: "final_answer" }]);
  });

  it("keeps the page it showed while the store is held, and the terminal before it showed one", () => {
    // OpenCode runs its store in WAL, where a reader waits only while it recovers; a store in
    // rollback-journal mode is held by any writer, which is the case reproduced here
    const s = store();
    s.prompt("hello"); s.answer("hi"); s.idle();
    s.db.exec("PRAGMA journal_mode = DELETE");
    const shown = page(opencodeConversation(s.path, s.session));
    const writer = new Database(s.path);
    opened.push(writer);
    writer.exec("BEGIN EXCLUSIVE");
    try {
      expect(opencodeConversation(s.path, s.session)).toBe(shown);
      forgetOpencodeState();
      expect(opencodeConversation(s.path, s.session)).toEqual({ kind: "unavailable", reason: "store_busy" });
    } finally {
      writer.exec("ROLLBACK");
    }
    expect(page(opencodeConversation(s.path, s.session)).turns).toEqual(shown.turns);
  });

  it("lets go of a session's cached pages when its last pane closes, and only that session's", () => {
    const a = store("ses_paneA");
    a.prompt("a"); a.answer("one");
    const b = store("ses_paneB");
    b.prompt("b"); b.answer("two");
    const first = page(opencodeConversation(a.path, a.session));
    const other = page(opencodeConversation(b.path, b.session));
    forgetOpencodeRead(opencodeReadKey(a.path, a.session));
    const again = page(opencodeConversation(a.path, a.session));
    expect(again).not.toBe(first);
    expect(again.turns).toEqual(first.turns);
    expect(page(opencodeConversation(b.path, b.session))).toBe(other);
  });

  it("answers an unchanged session from memory, and a step streaming in place anew", () => {
    const s = store();
    s.prompt("go");
    const step = s.answer("work", { finish: undefined, time: { created: T0 } });
    const first = page(opencodeConversation(s.path, s.session));
    expect(page(opencodeConversation(s.path, s.session))).toBe(first);
    s.db.query("UPDATE session_message SET data = ?, time_updated = time_updated + 1 WHERE id = ?")
      .run(JSON.stringify({ time: { created: T0, completed: T0 + 9 }, content: [{ type: "text", text: "work done" }], finish: "stop" }), step);
    const second = page(opencodeConversation(s.path, s.session));
    expect(second.history_id).toBe(first.history_id);
    expect(second.signature).not.toBe(first.signature);
    expect(second.turns[1]!.parts).toEqual([{ kind: "text", text: "work done", phase: "final_answer" }]);
  });

  it("keeps the terminal for a session it does not hold, a store whose tables are missing and a missing one, and creates nothing", () => {
    const s = store();
    expect(opencodeConversation(s.path, "ses_missing")).toEqual({ kind: "unavailable", reason: "session_not_found" });
    expect(opencodeConversation(s.path, "../etc")).toEqual({ kind: "unavailable", reason: "no_session_id" });
    const v1 = join(root, "v1.db");
    const old = new Database(v1, { create: true });
    opened.push(old);
    old.exec("CREATE TABLE session (id text PRIMARY KEY); CREATE TABLE message (id text PRIMARY KEY, session_id text, data text)");
    old.close();
    expect(opencodeConversation(v1, "ses_test1")).toEqual({ kind: "unavailable", reason: "transcript_missing" });
    const missing = join(root, "nothing-here.db");
    expect(opencodeConversation(missing, "ses_test1")).toEqual({ kind: "unavailable", reason: "transcript_missing" });
    expect(existsSync(missing)).toBe(false);
    const text = join(root, "not-sqlite.db");
    writeFileSync(text, "not a database");
    expect(opencodeConversation(text, "ses_test1")).toEqual({ kind: "unavailable", reason: "transcript_missing" });
  });
});

describe("OpenCode 2.4 split assistant content", () => {
  it("reads old inline content and new ordered parts, including their tool output and images", () => {
    const s = storeV24();
    s.prompt("Check the log");
    const step = s.answer("", { content: [] });
    const output = "y".repeat(6000);
    s.part(step, 2, { type: "text", text: "Checked" });
    s.part(step, 1, tool("read", {
      status: "completed",
      input: { path: "a.log" },
      content: [{ type: "text", text: output }, { type: "file", uri: `data:image/png;base64,${PNG.toString("base64")}` }],
    }));
    s.part(step, 0, { type: "reasoning", text: "Read the log first" });
    s.idle();
    s.prompt("Old turn in the same store");
    s.answer("Inline");

    const newest = page(opencodeConversation(s.path, s.session, { prompts: 1 }));
    expect(newest.turns[1]?.parts).toEqual([{ kind: "text", text: "Inline", phase: "final_answer" }]);
    const older = page(opencodeConversation(s.path, s.session, { before: newest.cursor! }));
    expect(older.turns[1]?.parts).toEqual([
      { kind: "thinking", text: "Read the log first" },
      expect.objectContaining({ kind: "tool", name: "read", call_id: "call_1", state: "ok", output_ref: `${step}:1` }),
      { kind: "text", text: "Checked", phase: "final_answer" },
    ]);
    expect(opencodeToolOutput(s.path, s.session, `${step}:1`)).toBe(output);
    expect(opencodeImage(s.path, s.session, `opencode:${step}:0`)?.bytes).toEqual(new Uint8Array(PNG));
  });

  it("omits the call ID when a split tool has no usable ID", () => {
    const s = storeV24();
    s.prompt("Check the log");
    const step = s.answer("", { content: [] });
    const state = { status: "completed", input: { path: "a.log" } };
    s.part(step, 0, { type: "tool", name: "read", state });
    s.part(step, 1, tool("read", state, ""));

    const parts = page(opencodeConversation(s.path, s.session)).turns[1]?.parts;
    expect(parts).toHaveLength(2);
    for (const part of parts ?? []) {
      expect(part.kind).toBe("tool");
      expect(part).not.toHaveProperty("call_id");
    }
  });

  it("keeps inline blocks after split blocks when a message has both", () => {
    const s = storeV24();
    s.prompt("Go");
    const step = s.answer("Inline");
    s.part(step, 0, { type: "text", text: "Split" });
    expect(page(opencodeConversation(s.path, s.session)).turns[1]?.parts).toEqual([
      { kind: "text", text: "Split" },
      { kind: "text", text: "Inline", phase: "final_answer" },
    ]);
  });

  it("refreshes the newest page when only a part changes", () => {
    const s = storeV24();
    s.prompt("Go");
    const step = s.answer("", { content: [] });
    s.part(step, 0, { type: "text", text: "First" });
    s.part(step, 1, { type: "text", text: "Last" }, T0 + 2);
    const first = page(opencodeConversation(s.path, s.session));
    expect(first.turns[1]?.parts).toEqual([
      { kind: "text", text: "First" },
      { kind: "text", text: "Last", phase: "final_answer" },
    ]);
    expect(opencodeConversation(s.path, s.session)).toBe(first);

    s.part(step, 0, { type: "text", text: "Ready" }, T0 + 1);
    const second = page(opencodeConversation(s.path, s.session));
    expect(second.history_id).toBe(first.history_id);
    expect(second.signature).not.toBe(first.signature);
    expect(second.turns[1]?.parts).toEqual([
      { kind: "text", text: "Ready" },
      { kind: "text", text: "Last", phase: "final_answer" },
    ]);
  });

  it("counts part bytes when choosing which prompts to read", () => {
    const s = storeV24();
    s.prompt("Earlier prompt");
    const earlier = s.answer("", { content: [] });
    s.part(earlier, 0, { type: "text", text: "é".repeat(5_000_000) });
    s.prompt("Newest prompt");
    const latest = s.answer("", { content: [] });
    s.part(latest, 0, { type: "text", text: "é".repeat(5_000_000) });
    for (const rowSize of Object.values(OPENCODE_ROW_SIZE)) {
      forgetOpencodeState();
      const newest = page(opencodeConversation(s.path, s.session, {}, rowSize));
      expect(newest.turns.filter((turn) => turn.role === "user").flatMap((turn) => turn.parts)).toEqual([{ kind: "text", text: "Newest prompt" }]);
    }
  });

  it("invalidates page and parsed-record caches on same-millisecond growing and equal-length part rewrites", () => {
    const s = storeV24();
    s.db.exec("CREATE TABLE event_sequence (aggregate_id text PRIMARY KEY, seq integer NOT NULL);");
    const bumpRevision = (seq: number) => {
      s.db.query("INSERT OR REPLACE INTO event_sequence (aggregate_id, seq) VALUES (?, ?)").run(s.session, seq);
    };
    s.prompt("Go");
    const step = s.answer("", { content: [] });
    s.part(step, 0, { type: "text", text: "A" }, T0 + 3);
    bumpRevision(1);
    const first = page(opencodeConversation(s.path, s.session));
    expect(first.turns[1]?.parts).toEqual([{ kind: "text", text: "A", phase: "final_answer" }]);

    // Growing write in the same millisecond (even without moving time_updated)
    s.part(step, 0, { type: "text", text: "AB" }, T0 + 3);
    bumpRevision(2);
    const grown = page(opencodeConversation(s.path, s.session));
    expect(grown.signature).not.toBe(first.signature);
    expect(grown.turns[1]?.parts).toEqual([{ kind: "text", text: "AB", phase: "final_answer" }]);

    // Equal-length rewrite in the same millisecond
    s.part(step, 0, { type: "text", text: "CD" }, T0 + 3);
    bumpRevision(3);
    const rewritten = page(opencodeConversation(s.path, s.session));
    expect(rewritten.signature).not.toBe(grown.signature);
    expect(rewritten.turns[1]?.parts).toEqual([{ kind: "text", text: "CD", phase: "final_answer" }]);

    // Equal-length rewrite on an older split row when a newer split row exists & event_sequence advances
    s.prompt("Second");
    const step2 = s.answer("", { content: [] });
    s.part(step2, 0, { type: "text", text: "Newer" }, T0 + 10);
    bumpRevision(4);
    const withTwo = page(opencodeConversation(s.path, s.session));
    expect(withTwo.turns[1]?.parts).toEqual([{ kind: "text", text: "CD", phase: "final_answer" }]);
    s.part(step, 0, { type: "text", text: "EF" }, T0 + 3);
    bumpRevision(5);
    const olderRewritten = page(opencodeConversation(s.path, s.session));
    expect(olderRewritten.turns[1]?.parts).toEqual([{ kind: "text", text: "EF", phase: "final_answer" }]);

    // Also without event_sequence: growing write, equal-length UTF-8 byte expansion (AA -> éé), and equal-length write followed by idle row
    const noSeq = storeV24();
    noSeq.prompt("Go");
    const noSeqStep = noSeq.answer("", { content: [] });
    noSeq.part(noSeqStep, 0, { type: "text", text: "AA" }, T0 + 3);
    const n1 = page(opencodeConversation(noSeq.path, noSeq.session, {}, OPENCODE_ROW_SIZE.bytes));
    noSeq.part(noSeqStep, 0, { type: "text", text: "éé" }, T0 + 3);
    const nUtf8 = page(opencodeConversation(noSeq.path, noSeq.session, {}, OPENCODE_ROW_SIZE.bytes));
    expect(nUtf8.signature).not.toBe(n1.signature);
    expect(nUtf8.turns[1]?.parts).toEqual([{ kind: "text", text: "éé", phase: "final_answer" }]);
    noSeq.part(noSeqStep, 0, { type: "text", text: "ABC" }, T0 + 3);
    const n2 = page(opencodeConversation(noSeq.path, noSeq.session));
    expect(n2.signature).not.toBe(nUtf8.signature);
    expect(n2.turns[1]?.parts).toEqual([{ kind: "text", text: "ABC", phase: "final_answer" }]);
    noSeq.part(noSeqStep, 0, { type: "text", text: "CDE" }, T0 + 3);
    noSeq.idle();
    const n3 = page(opencodeConversation(noSeq.path, noSeq.session));
    expect(n3.turns[1]?.parts).toEqual([{ kind: "text", text: "CDE", phase: "final_answer" }]);
  });

  it("reads tool images stored as media:<sha256> blobs scoped by session and message blob_ref", () => {
    const s = storeV24();
    s.db.exec(`
      CREATE TABLE blob (hash text PRIMARY KEY, mime text NOT NULL, bytes integer NOT NULL, width integer, height integer, data blob NOT NULL, time_created integer NOT NULL);
      CREATE TABLE blob_ref (session_id text NOT NULL, message_id text NOT NULL, hash text NOT NULL, seq integer NOT NULL, PRIMARY KEY (session_id, message_id, hash));
    `);
    const hash = "a".repeat(64);
    const otherHash = "b".repeat(64);
    s.db.query("INSERT INTO blob VALUES (?, 'image/png', ?, 1, 1, ?, ?)").run(hash, PNG.length, PNG, T0);
    s.db.query("INSERT INTO blob VALUES (?, 'image/png', ?, 1, 1, ?, ?)").run(otherHash, PNG.length, PNG, T0);
    s.prompt("Show chart");
    const step = s.answer("", { content: [] });
    s.db.query("INSERT INTO blob_ref VALUES (?, ?, ?, 2)").run(s.session, step, hash);
    s.db.query("INSERT INTO blob_ref VALUES ('ses_other', 'msg_other', ?, 2)").run(otherHash);
    s.part(step, 0, tool("read", {
      status: "completed",
      input: { path: "chart.png" },
      content: [
        { type: "file", uri: `media:${hash}`, mime: "image/png" },
        { type: "file", uri: `media:${otherHash}`, mime: "image/png" },
      ],
    }, "call_blob"));

    const conv = page(opencodeConversation(s.path, s.session));
    const toolPart = conv.turns[1]?.parts.find((p) => p.kind === "tool");
    expect(toolPart && toolPart.kind === "tool" ? toolPart.images : []).toEqual([
      { media_type: "image/png", ref: `opencode:${step}:0` },
    ]);
    expect(opencodeImage(s.path, s.session, `opencode:${step}:0`)?.bytes).toEqual(new Uint8Array(PNG));
    expect(opencodeImage(s.path, s.session, `opencode:${step}:1`)).toBeNull();
  });

  it("does not overflow SQLite integer sum on extreme session_part timestamps", () => {
    const s = storeV24();
    s.prompt("Huge timestamps");
    const step = s.answer("", { content: [] });
    // Two values whose direct SUM overflows SQLite 64-bit signed integer (2^63 - 1 = 9223372036854775807)
    const huge = 5_000_000_000_000_000_000;
    s.part(step, 0, { type: "text", text: "One" }, huge);
    s.part(step, 1, { type: "text", text: "Two" }, huge + 1);
    const conv = page(opencodeConversation(s.path, s.session));
    expect(conv.turns[1]?.parts).toEqual([
      { kind: "text", text: "One" },
      { kind: "text", text: "Two", phase: "final_answer" },
    ]);
  });

  it("serves tool output and images for forked message IDs with numeric suffixes", () => {
    const s = storeV24();
    s.prompt("Forked turn");
    const forkedId = "msg_event_2";
    const longOutput = `${"forked-line\n".repeat(400)}tail`;
    s.add("assistant", {
      time: { created: T0 + 1, completed: T0 + 2 },
      content: [],
      finish: "stop",
    }, { id: forkedId });
    s.part(forkedId, 0, tool("read", {
      status: "completed",
      input: { path: "fork.png" },
      content: [
        { type: "text", text: longOutput },
        { type: "file", uri: `data:image/png;base64,${PNG.toString("base64")}`, mime: "image/png" },
      ],
    }, "call_fork"));

    const conv = page(opencodeConversation(s.path, s.session));
    const toolPart = conv.turns[1]?.parts.find((p) => p.kind === "tool");
    expect(toolPart && toolPart.kind === "tool" ? toolPart.output_ref : null).toBe(`${forkedId}:0`);
    expect(toolPart && toolPart.kind === "tool" ? toolPart.images : []).toEqual([
      { media_type: "image/png", ref: `opencode:${forkedId}:0` },
    ]);
    expect(opencodeToolOutput(s.path, s.session, `${forkedId}:0`)).toBe(longOutput);
    expect(opencodeImage(s.path, s.session, `opencode:${forkedId}:0`)?.bytes).toEqual(new Uint8Array(PNG));
  });
});

describe("where a page starts", () => {
  it("pages a store the same way through the fallback that measures rows without octet_length", () => {
    const s = store();
    s.prompt("big");
    for (let n = 0; n < 3; n++) s.add("assistant", { time: { created: T0 }, content: [{ type: "text", text: `${n}${"é".repeat(3_000_000)}` }] });
    const read = (rowSize: (typeof OPENCODE_ROW_SIZE)[keyof typeof OPENCODE_ROW_SIZE]) => {
      forgetOpencodeState();
      const newest = page(opencodeConversation(s.path, s.session, {}, rowSize));
      const older = page(opencodeConversation(s.path, s.session, { before: newest.cursor! }, rowSize));
      return { newest: [newest.cursor, newest.turns.length], older: [older.cursor, older.turns.map((turn) => turn.role)] };
    };
    const bytes = read(OPENCODE_ROW_SIZE.bytes);
    expect(bytes.newest[0]).not.toBeNull();
    expect(bytes).toEqual(read(OPENCODE_ROW_SIZE.octets));
  });

  it("measures a row in bytes without octet_length too", () => {
    // macOS's own SQLite, which Bun uses there, can predate octet_length (3.43): the fallback must count bytes
    const s = store();
    s.prompt("ascii");
    s.prompt("multibyte: é ü 한국어 🦀");
    s.add("assistant", { time: { created: T0 }, content: [{ type: "text", text: "x".repeat(70_000) }] });
    const sizes = s.db.query<{ data: string; bytes: number }, [string]>(
      "SELECT data, length(CAST(data AS BLOB)) AS bytes FROM session_message WHERE session_id = ?",
    ).all(s.session);
    expect(sizes.length).toBe(3);
    for (const size of sizes) expect(size.bytes).toBe(Buffer.byteLength(size.data, "utf8"));
  });

  const rows = (...spec: [string, number][]): RowMeta[] => spec.map(([type, size], index) => ({ id: `msg_${index}`, seq: (spec.length - index) * 2, type, updated: 0, size }));

  it("starts at the earliest prompt inside the window, or at the floor it reaches", () => {
    expect(pageStart(rows(["assistant", 10], ["user", 10], ["assistant", 10], ["user", 10], ["assistant", 10]), 0, false, 100)).toBe(0);
    expect(pageStart(rows(["assistant", 40], ["user", 40], ["assistant", 40], ["user", 10], ["assistant", 10]), 0, false, 100)).toBe(8);
  });

  it("starts the newest page mid-turn when the window holds no prompt", () => {
    expect(pageStart(rows(["assistant", 60], ["assistant", 60], ["user", 10]), 0, false, 100)).toBe(6);
    expect(pageStart(rows(["assistant", 500], ["user", 10]), 0, false, 100)).toBe(4);
  });

  it("reaches further back for an older page's prompt, up to four windows", () => {
    expect(pageStart(rows(["assistant", 60], ["assistant", 60], ["user", 10], ["assistant", 10]), 0, true, 100)).toBe(4);
    expect(pageStart(rows(["assistant", 300], ["assistant", 300], ["user", 10]), 0, true, 100)).toBe(6);
  });
});

describe("what a page refers to", () => {
  it("serves a tool's whole output and its pictures by ref, and only from the pane's session", () => {
    const s = store();
    s.prompt("look");
    const step = s.add("assistant", {
      time: { created: T0 }, finish: "tool-calls",
      content: [
        { type: "text", text: "reading" },
        tool("read", { status: "completed", input: { path: "big.log" }, content: [{ type: "text", text: "y".repeat(6000) }, { type: "file", uri: `data:image/png;base64,${PNG.toString("base64")}`, mime: "image/png" }] }),
      ],
    });
    const pasted = s.add("user", { time: { created: T0 }, text: "and this", files: [{ data: PNG.toString("base64"), mime: "image/png", source: { type: "inline" } }] });
    const turns: ConversationTurn[] = page(opencodeConversation(s.path, s.session)).turns;
    const read = turns.flatMap((turn) => turn.parts).find((part): part is Extract<ConversationPart, { kind: "tool" }> => part.kind === "tool")!;
    expect(read.output_ref).toBe(`${step}:1`);
    expect(opencodeToolOutput(s.path, s.session, read.output_ref!)).toBe("y".repeat(6000));
    expect(opencodeToolOutput(s.path, s.session, `${step}:0`)).toBeNull();
    expect(opencodeToolOutput(s.path, s.session, `${step}:9`)).toBeNull();
    expect(opencodeToolOutput(s.path, "ses_other", read.output_ref!)).toBeNull();

    const shot = opencodeImage(s.path, s.session, read.images![0]!.ref);
    expect(shot?.mediaType).toBe("image/png");
    expect(Buffer.from(shot!.bytes).equals(PNG)).toBe(true);
    expect(opencodeImage(s.path, s.session, `opencode:${pasted}:0`)?.mediaType).toBe("image/png");
    expect(opencodeImage(s.path, s.session, `opencode:${pasted}:1`)).toBeNull();
    expect(opencodeImage(s.path, s.session, `${pasted}:0`)).toBeNull();

    s.db.query("INSERT INTO session_v2 (id, project_id, slug, directory, version, time_created, time_updated) VALUES ('ses_other', 'global', 's', '/', '2.0.24', 0, 0)").run();
    const foreign = s.add("user", { time: { created: T0 }, text: "x", files: [{ data: PNG.toString("base64"), mime: "image/png", source: { type: "inline" } }] }, { session: "ses_other" });
    expect(opencodeImage(s.path, s.session, `opencode:${foreign}:0`)).toBeNull();

    s.db.query("UPDATE session_v2 SET revert = ? WHERE id = ?").run(JSON.stringify({ messageID: step }), s.session);
    expect(opencodeToolOutput(s.path, s.session, read.output_ref!)).toBeNull();
    expect(opencodeImage(s.path, s.session, `opencode:${pasted}:0`)).toBeNull();
  });

  it("answers nothing for an output or a picture while the store is held, rather than failing", () => {
    // as for the page itself: rollback-journal mode is held by any writer, WAL only while it recovers
    const s = store();
    s.prompt("look");
    const step = s.add("assistant", {
      time: { created: T0 }, finish: "tool-calls",
      content: [tool("read", { status: "completed", input: { path: "big.log" }, content: [{ type: "text", text: "y".repeat(6000) }, { type: "file", uri: `data:image/png;base64,${PNG.toString("base64")}`, mime: "image/png" }] })],
    });
    s.db.exec("PRAGMA journal_mode = DELETE");
    const writer = new Database(s.path);
    opened.push(writer);
    writer.exec("BEGIN EXCLUSIVE");
    try {
      expect(opencodeToolOutput(s.path, s.session, `${step}:0`)).toBeNull();
      expect(opencodeImage(s.path, s.session, `opencode:${step}:0`)).toBeNull();
    } finally {
      writer.exec("ROLLBACK");
    }
    expect(opencodeToolOutput(s.path, s.session, `${step}:0`)).toBe("y".repeat(6000));
    expect(opencodeImage(s.path, s.session, `opencode:${step}:0`)?.mediaType).toBe("image/png");
  });
});

describe("an OpenCode 1.x session (session/message/part)", () => {
  it("reads a 1.x store, folding a prompt's steps into one answer, and names its model and usage", () => {
    const s = storeV1();
    s.user("first prompt");
    s.assistant([
      { type: "reasoning", text: "think it through" },
      { type: "tool", tool: "bash", callID: "call_1", state: { status: "completed", input: { command: "echo hi" }, output: "hi", metadata: { exit: 0 } } },
    ], { finish: "tool-calls" });
    s.assistant([{ type: "text", text: "done" }], { finish: "stop", tokens: { input: 10, output: 5, reasoning: 1, cache: { read: 100, write: 0 } } });
    const answer = page(opencodeConversation(s.path, s.session));
    expect(answer.cursor).toBeNull();
    expect(answer.history_id).toBe(`opencode-${s.session}`);
    expect(answer.turns.map((turn) => turn.role)).toEqual(["user", "assistant"]);
    expect(answer.turns[0]!.parts).toEqual([{ kind: "text", text: "first prompt" }]);
    expect(answer.turns[1]!.parts).toEqual([
      { kind: "thinking", text: "think it through" },
      { kind: "tool", name: "bash", summary: "echo hi", input: JSON.stringify({ command: "echo hi" }, null, 2), output: "hi", state: "ok" },
      { kind: "text", text: "done", phase: "final_answer" },
    ]);
    expect(answer.metadata).toEqual({ model: "deepseek-v4.1-flash", reasoning_effort: null, context: { used: 116, window: null } });
  });

  it("keeps a picture pasted in a 1.x prompt, and serves it by the ref the page gave it", () => {
    const s = storeV1();
    const id = s.message("user", { agent: "build" });
    s.part(id, { type: "text", text: "look at this" });
    s.part(id, { type: "file", mime: "image/png", url: `data:image/png;base64,${PNG.toString("base64")}` });
    const parts = page(opencodeConversation(s.path, s.session)).turns[0]!.parts;
    expect(parts).toEqual([
      { kind: "image", media_type: "image/png", ref: `opencode:${id}:0` },
      { kind: "text", text: "look at this" },
    ]);
    expect(Buffer.from(opencodeImage(s.path, s.session, `opencode:${id}:0`)!.bytes).equals(PNG)).toBe(true);
  });

  it("serves a 1.x tool's cut output and its picture by the refs the page gave them", () => {
    const s = storeV1();
    s.user("read it");
    const step = s.assistant([
      { type: "text", text: "reading" },
      { type: "tool", tool: "read", callID: "call_1", state: {
        status: "completed", input: { filePath: "big.log" }, output: "y".repeat(5000),
        attachments: [{ type: "file", mime: "image/png", url: `data:image/png;base64,${PNG.toString("base64")}` }],
      } },
    ], { finish: "stop" });
    const tool = page(opencodeConversation(s.path, s.session)).turns
      .flatMap((turn) => turn.parts).find((part): part is Extract<ConversationPart, { kind: "tool" }> => part.kind === "tool")!;
    expect(tool.output_ref).toBe(`${step}:1`);
    expect(tool.output_size).toBe(5000);
    expect(opencodeToolOutput(s.path, s.session, tool.output_ref!)).toBe("y".repeat(5000));
    expect(opencodeToolOutput(s.path, s.session, `${step}:0`)).toBeNull();
    expect(opencodeImage(s.path, s.session, tool.images![0]!.ref)?.mediaType).toBe("image/png");
    expect(Buffer.from(opencodeImage(s.path, s.session, tool.images![0]!.ref)!.bytes).equals(PNG)).toBe(true);
  });

  it("shows a 1.x step's error and keeps the terminal for a session the store does not hold", () => {
    const s = storeV1();
    s.user("go");
    s.assistant([
      { type: "tool", tool: "edit", callID: "call_1", state: { status: "error", input: { filePath: "x" }, error: "No changes to apply: oldString and newString are identical." } },
    ], { finish: "stop", error: { name: "ProviderError", data: { message: "Rate limited" } } });
    const answer = page(opencodeConversation(s.path, s.session));
    const parts = answer.turns[1]!.parts as Extract<ConversationPart, { kind: "tool" }>[];
    expect(parts[0]!.error).toBe(true);
    expect(parts[0]!.output).toBe("No changes to apply: oldString and newString are identical.");
    expect(answer.turns[1]!.parts).toContainEqual({ kind: "text", text: "Error: Rate limited", phase: "final_answer" });
    expect(opencodeConversation(s.path, "ses_missing")).toEqual({ kind: "unavailable", reason: "session_not_found" });
  });

  it("pages a 1.x session by prompt, and the pages meet exactly", () => {
    const s = storeV1();
    for (let n = 0; n < 120; n++) { s.user(`p${n}`); s.assistant([{ type: "text", text: `a${n}` }], { finish: "stop" }); }
    const newest = page(opencodeConversation(s.path, s.session));
    expect(newest.turns.length).toBe(100);
    expect(newest.turns[0]!.parts).toEqual([{ kind: "text", text: "p70" }]);
    expect(newest.cursor).toMatch(/^opencode-ses_old1:\d+$/);
    const middle = page(opencodeConversation(s.path, s.session, { before: newest.cursor! }));
    const all = [...middle.turns, ...newest.turns].filter((turn) => turn.role === "user").map((turn) => (turn.parts[0] as { text: string }).text);
    expect(all).toEqual(Array.from({ length: 100 }, (_, n) => `p${n + 20}`));
    expect(opencodeConversation(s.path, s.session, { before: `opencode-ses_other:${newest.cursor!.split(":")[1]}` })).toEqual({ kind: "history_changed" });
  });

  it("hides a reverted 1.x suffix from the pages and from the row references", () => {
    const s = storeV1();
    for (let n = 0; n < 51; n++) { s.user(`p${n}`); s.assistant([{ type: "text", text: `a${n}` }], { finish: "stop" }); }
    const step = s.assistant([
      { type: "text", text: "reading" },
      { type: "tool", tool: "read", callID: "call_1", state: {
        status: "completed", input: { filePath: "big.log" }, output: "y".repeat(5000),
        attachments: [{ type: "file", mime: "image/png", url: `data:image/png;base64,${PNG.toString("base64")}` }],
      } },
    ], { finish: "stop" });
    const later = s.user("after undo");
    s.part(later, { type: "file", mime: "image/png", url: `data:image/png;base64,${PNG.toString("base64")}` });

    const tool = page(opencodeConversation(s.path, s.session)).turns.flatMap((turn) => turn.parts)
      .find((part): part is Extract<ConversationPart, { kind: "tool" }> => part.kind === "tool")!;
    expect(tool.output_ref).toBe(`${step}:1`);
    expect(opencodeToolOutput(s.path, s.session, tool.output_ref!)).toBe("y".repeat(5000));
    expect(opencodeImage(s.path, s.session, tool.images![0]!.ref)).not.toBeNull();

    s.db.query("UPDATE session SET revert = ? WHERE id = ?").run(JSON.stringify({ messageID: step }), s.session);

    const newest = page(opencodeConversation(s.path, s.session));
    expect(newest.cursor).not.toBeNull();
    const older = page(opencodeConversation(s.path, s.session, { before: newest.cursor! }));
    const parts = [...older.turns, ...newest.turns].flatMap((turn) => turn.parts);
    expect(parts.some((part) => part.kind === "tool")).toBe(false);
    expect(parts.some((part) => part.kind === "text" && part.text === "after undo")).toBe(false);
    expect(parts.some((part) => part.kind === "image" && part.ref === `opencode:${later}:0`)).toBe(false);
    expect(opencodeToolOutput(s.path, s.session, tool.output_ref!)).toBeNull();
    expect(opencodeImage(s.path, s.session, tool.images![0]!.ref)).toBeNull();
  });

  it("leaves an oversized 1.x session to the terminal instead of loading it whole", () => {
    const s = storeV1();
    s.db.transaction(() => { for (let n = 0; n < 5001; n++) s.user(`p${n}`); })();
    expect(opencodeConversation(s.path, s.session)).toEqual({ kind: "unavailable", reason: "transcript_missing" });
  });
});

it("finds every session whose terminal title OpenCode would make this one, as it cuts a long title, in a 2.x or 1.x store", () => {
  const v2 = store("ses_titled1");
  const add = (id: string, title: string) => v2.db.query("INSERT INTO session_v2 (id, project_id, slug, directory, title, version, time_created, time_updated) VALUES (?, 'global', 'slug', ?, ?, '2.0.24', ?, ?)").run(id, root, title, T0, T0);
  add("ses_long1", "Review the long pull request about the relay");
  add("ses_long2", "Review the long pull request about the release");
  add("ses_short1", "Review the long pull request about th");
  expect(opencodeSessionsTitled(v2.path, "OC | Test")).toEqual(["ses_titled1"]);
  expect(opencodeSessionsTitled(v2.path, "OC | Review the long pull request about th").sort()).toEqual(["ses_short1"]);
  expect(opencodeSessionsTitled(v2.path, "OC | Review the long pull request about th\u2026").sort()).toEqual(["ses_long1", "ses_long2"]);
  expect(opencodeSessionsTitled(v2.path, "OpenCode")).toEqual([]);
  expect(opencodeSessionsTitled(storeV1("ses_old2").path, "OC | Old")).toEqual(["ses_old2"]);
  expect(opencodeSessionsTitled(join(root, "absent.db"), "OC | Test")).toEqual([]);
  expect(opencodeSessionsTitled(null, "OC | Test")).toEqual([]);
});

describe("an OpenCode at its home screen, before its first prompt (#3600)", () => {
  const HOME = readFileSync(join(import.meta.dir, "fixtures", "opencode-home-2.2.2-wide.txt"), "utf8");
  const pane = { pane_id: "oc-pane", cwd: root };
  function answers(...asks: (readonly string[] | number)[]) {
    const queue = [...asks];
    const spy = spyOn(herdr, "paneProcessInfo").mockImplementation(async () => {
      const next = queue.shift();
      if (next === undefined) throw new Error("fixture: herdr was asked more often than it answers");
      const [pid, argv] = typeof next === "number" ? [next, ["opencode"]] : [process.pid, [...next]];
      return { pane_id: pane.pane_id, foreground_processes: [{ pid, name: "opencode", argv, cwd: root }] };
    });
    return { asked: () => spy.mock.calls.length, restore: () => spy.mockRestore() };
  }
  const greet = async (store: string | null, ...asks: (readonly string[] | number)[]) => {
    const herdrAnswers = answers(...asks);
    try { return { id: await opencodeFreshSession(pane, HOME, store), asked: herdrAnswers.asked() }; }
    finally { herdrAnswers.restore(); }
  };
  const fresh = `unwritten:opencode:oc-pane:${process.pid}:`;

  it.skipIf(process.platform === "win32")("greets it only while no session can be the one it shows", async () => {
    expect((await greet(join(root, "absent.db"), ["opencode"], ["opencode"])).id).toStartWith(fresh);
    const { path, db } = store("ses_older");
    expect((await greet(path, ["opencode"], ["opencode"])).id).toStartWith(fresh);
    for (const argv of [["opencode", "--standalone"], ["opencode", "--log-level", "debug", root], ["sh", "/usr/local/bin/opencode", "--auto"]]) {
      expect((await greet(path, argv, argv)).id).toStartWith(fresh);
    }
    const made = (id: string, directory: string) => db.query("INSERT INTO session_v2 (id, project_id, slug, directory, title, version, time_created, time_updated) VALUES (?, 'global', 'slug', ?, 'New', '2.2.2', ?, ?)").run(id, directory, Date.now(), Date.now());
    made("ses_elsewhere", join(root, "elsewhere"));
    expect((await greet(path, ["opencode"], ["opencode"])).id).toStartWith(fresh);
    made("ses_begun", root);
    expect(await greet(path, ["opencode"], ["opencode"])).toEqual({ id: null, asked: 1 });
  });

  it.skipIf(process.platform === "win32")("says nothing for one started on a session, a screen that is not home, or a store it cannot read", async () => {
    const { path } = store("ses_older");
    mkdirSync(join(root, "project"), { recursive: true });
    mkdirSync(join(root, "--continue"), { recursive: true });
    for (const argv of [["opencode", "-c"], ["opencode", "--continue"], ["opencode", "-s", "ses_x"], ["opencode", "--session=ses_x"], ["opencode", "--prompt", "hi"],
      ["opencode", "--server", "http://127.0.0.1:4096"], ["opencode", "run", "hi"], ["opencode", "not-a-folder"], ["opencode", "project", "project"], ["node", "cli.js"]]) {
      expect(await greet(path, argv)).toEqual({ id: null, asked: 1 });
    }
    const session = readFileSync(join(import.meta.dir, "fixtures", "opencode-session-2.2.2.txt"), "utf8");
    const herdrAnswers = answers(["opencode"]);
    try {
      expect(await opencodeFreshSession(pane, session, path)).toBeNull();
      expect(herdrAnswers.asked()).toBe(0);
    } finally { herdrAnswers.restore(); }
    expect((await greet(null, ["opencode"])).id).toBeNull();
    const garbage = join(root, "not-a-store.db");
    writeFileSync(garbage, "not sqlite");
    expect((await greet(garbage, ["opencode"], ["opencode"])).id).toBeNull();
    expect(await greet(path, ["opencode"], process.pid + 1)).toEqual({ id: null, asked: 2 });
    expect(await greet(path, ["opencode"], ["opencode", "-c"])).toEqual({ id: null, asked: 2 });
  });
});
