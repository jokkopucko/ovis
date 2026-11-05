import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  defaultHermesHome,
  forgetHermesTranscriptState,
  hermesBreadcrumbSession,
  hermesConversationPage,
  hermesDbPath,
  hermesHomeInPsLine,
  hermesToolOutput,
  hermesToolSummary,
  isHermesProcess,
  parseHermesRows,
  processHermesHome,
  type HermesMessageRow,
} from "./hermes.ts";
import { ConversationNotStarted, ConversationUnavailable, HistoryChanged, TRANSCRIPT_WINDOW_BYTES, type RecognizedConversation } from "./conversation.ts";
import type { ConversationPart, ConversationTurn } from "../shared/protocol.ts";
import { toolSummary } from "./transcript-records.ts";

describe("hermes paths", () => {
  it("computes default hermes home and db path", () => {
    expect(defaultHermesHome("/test/home")).toBe("/test/home/.hermes");
    expect(hermesDbPath("/test/home/.hermes")).toBe("/test/home/.hermes/state.db");
  });

  it("finds Windows Hermes where the pinned 0.21.5 keeps it, and an earlier build's root only while it alone holds a store", () => {
    const root = mkdtempSync(join(tmpdir(), "hermes-home-"));
    try {
      const profile = join(root, "profile");
      const local = join(root, "local");
      const env = { LOCALAPPDATA: local };
      const store = (dir: string) => { mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, "state.db"), ""); };
      expect(defaultHermesHome(profile, env, "win32")).toBe(join(local, "hermes"));
      expect(defaultHermesHome(profile, {}, "win32")).toBe(join(profile, "AppData", "Local", "hermes"));
      store(join(profile, ".hermes"));
      expect(defaultHermesHome(profile, env, "win32")).toBe(join(profile, ".hermes"));
      store(join(local, "hermes"));
      expect(hermesDbPath(defaultHermesHome(profile, env, "win32"))).toBe(join(local, "hermes", "state.db"));
      expect(defaultHermesHome(profile, { ...env, HERMES_HOME: join(root, "set") }, "win32")).toBe(join(root, "set"));
      expect(defaultHermesHome(profile, env, "linux")).toBe(join(profile, ".hermes"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("hermes process identification", () => {
  it("recognizes hermes command in process info", () => {
    expect(isHermesProcess({ name: "hermes" })).toBe(true);
    expect(isHermesProcess({ name: "hermes.exe" })).toBe(true);
    expect(isHermesProcess({ argv0: "/home/riki/.local/bin/hermes" })).toBe(true);
    expect(isHermesProcess({ argv: ["C:\\Tools\\Hermes.EXE"] })).toBe(true);
    expect(isHermesProcess({ name: "python", argv: ["python3", "/path/to/hermes", "chat"] })).toBe(true);
    expect(isHermesProcess({ name: "python", argv: ["python", "/home/riki/.hermes/hermes-agent/hermes"] })).toBe(true);
    expect(isHermesProcess({ name: "node", argv0: "node" })).toBe(false);
    expect(isHermesProcess({ name: "claude" })).toBe(false);
    expect(isHermesProcess({ name: "bash" })).toBe(false);
  });
});

describe("a Hermes process's own store", () => {
  it.skipIf(process.platform !== "linux" && process.platform !== "darwin")("reads HERMES_HOME from the process environment and caches it by process identity", async () => {
    const home = mkdtempSync(join(tmpdir(), "hermes-process-home-"));
    const child = Bun.spawn([process.execPath, "-e", "console.log('ready'); for await (const _ of Bun.stdin.stream()) {}"], {
      env: { ...process.env, HERMES_HOME: home },
      stdin: "pipe",
      stdout: "pipe",
    });
    const argv = ["hermes", "--profile", "work"];
    try {
      await child.stdout.getReader().read();
      expect(await processHermesHome(child.pid, argv)).toBe(home);
      child.kill();
      await child.exited;
      expect(await processHermesHome(child.pid, argv)).toBe(home);
    } finally {
      child.kill();
      await child.exited;
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("reads the last HERMES_HOME assignment from a macOS process line", () => {
    expect(hermesHomeInPsLine("python hermes HERMES_HOME=/tmp/arg HOME=/Users/alice HERMES_HOME=/Users/alice/Hermes Profiles/work TERM=xterm"))
      .toBe("/Users/alice/Hermes Profiles/work");
    expect(hermesHomeInPsLine("hermes HOME=/Users/alice TERM=xterm")).toBeNull();
    expect(hermesHomeInPsLine("hermes HERMES_HOME= HOME=/Users/alice")).toBeNull();
  });
});

describe("hermes terminal breadcrumb resolution", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "hermes-crumb-test-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it.skipIf(process.platform === "win32")("accepts only a current-process breadcrumb for the canonical cwd", () => {
    const sessionsDir = join(tempDir, "terminal-sessions");
    const project = join(tempDir, "project");
    const alias = join(tempDir, "project-link");
    mkdirSync(sessionsDir, { recursive: true });
    mkdirSync(project);
    symlinkSync(project, alias, "dir");
    const crumbFile = join(sessionsDir, "tty-dev-pts-9");
    const startedAt = 1_791_449_000_000;
    writeFileSync(crumbFile, JSON.stringify({ session_id: "20261008_120000_abc123", cwd: project, ts: startedAt / 1000 }));

    expect(hermesBreadcrumbSession(tempDir, "tty-dev-pts-9", alias, startedAt)).toBe("20261008_120000_abc123");
    expect(hermesBreadcrumbSession(tempDir, "tty-dev-pts-9", tempDir, startedAt)).toBeNull();
    expect(hermesBreadcrumbSession(tempDir, "tty-dev-pts-8", alias, startedAt)).toBeNull();

    writeFileSync(crumbFile, JSON.stringify({ session_id: "stale", cwd: project, ts: startedAt / 1000 - 2 }));
    expect(hermesBreadcrumbSession(tempDir, "tty-dev-pts-9", alias, startedAt)).toBeNull();
    writeFileSync(crumbFile, JSON.stringify({ session_id: "missing-time", cwd: project }));
    expect(hermesBreadcrumbSession(tempDir, "tty-dev-pts-9", alias, startedAt)).toBeNull();
  });
});

describe("hermes message rows parsing", () => {
  it("shows a recorded 0.21.5 prompt's attached picture as a local Markdown image, and leaves any other hint as text", () => {
    const rows = JSON.parse(readFileSync(new URL("./fixtures/hermes-pictures-0.21.5-rows.json", import.meta.url), "utf8")) as HermesMessageRow[];
    const prompt = "Reply with one word: what color is the attached image? Then use your vision tool to look at ./blue.png and reply with its color in one word.";
    expect(parseHermesRows(rows)[0]!.parts).toEqual([{ kind: "text", text: `![red.png](/tmp/hermes-proj/red.png)\n\n${prompt}` }]);
    const user = (content: string) => parseHermesRows([{ ...rows[0]!, content }])[0]!.parts[0];
    // a path Markdown would read otherwise is written so the file API gets it back exactly
    expect(user("Look\n\n[Image attached at: /tmp/a (1)/b c#2.png]\n[screenshot]")).toEqual({ kind: "text", text: "![b c#2.png](/tmp/a%20%281%29/b%20c%232.png)\n\nLook" });
    expect(user("Look\n\n[Image attached at: /tmp/a[b.png]\n[screenshot]")).toEqual({ kind: "text", text: "![a[b.png](/tmp/a%5Bb.png)\n\nLook" });
    // anything Hermes itself would not read as its hints stays as written
    for (const content of [
      "Look\n\n[Image attached: https://example.com/a.png]\n[screenshot]",
      "Look\n\n[Image attached at: relative/a.png]",
      "Look\n\n[Image attached at: C:\\pics\\a.png]",
      "Look\n\n[Image attached at: /tmp/a.png]\nmore words",
      "Look\n\n[Image attached at: /tmp/a.png]\n[screenshot]\n[screenshot]",
      // words alone attach nothing: Hermes writes a [screenshot] for each picture it attached
      "Look\n\n[Image attached at: /tmp/a.png]",
      "[Image attached at: /tmp/a.png]",
    ]) expect(user(content)).toEqual({ kind: "text", text: content });
    // words with a code fence left open come after the pictures, so they cannot take them in
    expect(user("```js\nLook\n```text\n\n[Image attached at: /tmp/a.png]\n[screenshot]")).toEqual({ kind: "text", text: "![a.png](/tmp/a.png)\n\n```js\nLook\n```text" });
    // a skill invocation keeps its picture: it comes off the stored text before the skill is read
    const skill = readFileSync(new URL("./fixtures/skill-invocations/hermes.txt", import.meta.url), "utf8");
    expect(parseHermesRows([{ ...rows[0]!, content: `${skill}\n\n[Image attached at: /tmp/a.png]\n[screenshot]` }])[0]!.parts[0]).toEqual({ kind: "text", text: "![a.png](/tmp/a.png)\n\n/probe-skill hello" });
  });

  it("uses the first nonblank code line for Hermes code calls, falling back to file and other fields", () => {
    expect(hermesToolSummary("execute_code", { code: "\nprint('hello')\nprint('world')", file_path: "script.py" })).toBe("print('hello')");
    expect(hermesToolSummary("write_file", { code: " \n ", file_path: "example.ts" })).toBe("example.ts");
    expect(hermesToolSummary("custom_tool", { description: "Do something" })).toBe("Do something");
  });

  it("leaves shared toolSummary precedence unchanged for non-Hermes callers", () => {
    expect(toolSummary("execute_code", { code: "print('hello')", file_path: "script.py" })).toBe("script.py");
    expect(toolSummary("write_file", { code: "let x = 1;", path: "test.js" })).toBe("test.js");
  });

  it("sums a call up by what the agent said it is for, and only where that field is a purpose", () => {
    // OmO's eval carries its own one-line summary beside the code
    expect(toolSummary("eval", { language: "js", code: "await check()", summary: "  Run the checks  " })).toBe("Run the checks");
    // Claude describes a Bash command and a subagent's prompt
    expect(toolSummary("Bash", { command: "bun test", description: "Run the unit tests" })).toBe("Run the unit tests");
    expect(toolSummary("Agent", { prompt: "Find the callers", description: "Find callers" })).toBe("Find callers");
    expect(toolSummary("eval", { code: "1", summary: "x".repeat(200) })).toHaveLength(120);
    // a blank purpose falls back to the command; a summary without code is another tool's data
    expect(toolSummary("Bash", { command: "bun test", description: " " })).toBe("bun test");
    expect(toolSummary("mcp__notes__add", { summary: "Weekly notes", path: "notes.md" })).toBe("notes.md");
  });

  it("decodes terminal tool envelopes, marks nonzero exits and errors failed, and preserves invalid/non-terminal JSON", () => {
    const rows: HermesMessageRow[] = [
      {
        id: 1, role: "assistant", content: null, tool_call_id: null,
        tool_calls: JSON.stringify([
          { id: "call-ok", function: { name: "bash", arguments: "{}" } },
          { id: "call-exit", function: { name: "bash", arguments: "{}" } },
          { id: "call-err", function: { name: "terminal", arguments: "{}" } },
          { id: "call-raw", function: { name: "bash", arguments: "{}" } },
          { id: "call-other", function: { name: "web_search", arguments: "{}" } },
        ]),
        tool_name: null, reasoning: null, timestamp: 1700000001,
      },
      { id: 2, role: "tool", content: JSON.stringify({ output: "command succeeded\n", exit_code: 0 }), tool_call_id: "call-ok", tool_calls: null, tool_name: "bash", reasoning: null, timestamp: 1700000002 },
      { id: 3, role: "tool", content: JSON.stringify({ output: "command failed\n", exit_code: 2 }), tool_call_id: "call-exit", tool_calls: null, tool_name: "bash", reasoning: null, timestamp: 1700000003 },
      { id: 4, role: "tool", content: JSON.stringify({ output: "timed out\n", exit_code: 0, error: "process timeout" }), tool_call_id: "call-err", tool_calls: null, tool_name: "terminal", reasoning: null, timestamp: 1700000004 },
      { id: 5, role: "tool", content: "not a json envelope", tool_call_id: "call-raw", tool_calls: null, tool_name: "bash", reasoning: null, timestamp: 1700000005 },
      { id: 6, role: "tool", content: JSON.stringify({ output: "json payload", exit_code: 0 }), tool_call_id: "call-other", tool_calls: null, tool_name: "web_search", reasoning: null, timestamp: 1700000006 },
    ];

    const turns = parseHermesRows(rows);
    const tools = turns[0]!.parts.filter((p): p is Extract<ConversationPart, { kind: "tool" }> => p.kind === "tool");
    expect(tools).toHaveLength(5);

    expect(tools[0]!.output).toBe("command succeeded\n");
    expect(tools[0]!.error).toBeUndefined();

    expect(tools[1]!.output).toBe("command failed\n");
    expect(tools[1]!.error).toBe(true);

    expect(tools[2]!.output).toBe("timed out\n");
    expect(tools[2]!.error).toBe(true);

    expect(tools[3]!.output).toBe("not a json envelope");

    expect(tools[4]!.output).toBe(JSON.stringify({ output: "json payload", exit_code: 0 }));
    expect(tools[4]!.error).toBeUndefined();
  });

  it("maps user, assistant, thinking, tool calls and tool outputs to conversation turns", () => {
    const rows: HermesMessageRow[] = [
      {
        id: 1,
        role: "user",
        content: "Please check git status",
        tool_call_id: null,
        tool_calls: null,
        tool_name: null,
        reasoning: null,
        timestamp: 1700000000,
      },
      {
        id: 2,
        role: "assistant",
        content: "Checking status now.",
        tool_call_id: null,
        tool_calls: JSON.stringify([
          {
            id: "call_1",
            function: { name: "bash", arguments: JSON.stringify({ command: "git status" }) },
          },
        ]),
        tool_name: null,
        reasoning: "User wants repository status. I should run git status.",
        timestamp: 1700000001,
      },
      {
        id: 3,
        role: "tool",
        content: "On branch main\nnothing to commit",
        tool_call_id: "call_1",
        tool_calls: null,
        tool_name: "bash",
        reasoning: null,
        timestamp: 1700000002,
      },
      {
        id: 4,
        role: "assistant",
        content: "Working tree is clean.",
        tool_call_id: null,
        tool_calls: null,
        tool_name: null,
        reasoning: null,
        timestamp: 1700000003,
      },
    ];

    const turns = parseHermesRows(rows);
    expect(turns.length).toBe(2);

    expect(turns[0]!.role).toBe("user");
    expect(turns[0]!.parts).toEqual([{ kind: "text", text: "Please check git status" }]);

    expect(turns[1]!.role).toBe("assistant");
    expect(turns[1]!.parts[0]).toEqual({ kind: "thinking", text: "User wants repository status. I should run git status." });
    expect(turns[1]!.parts[1]).toMatchObject({
      kind: "tool",
      name: "bash",
      summary: "git status",
      input: '{"command":"git status"}',
      output: "On branch main\nnothing to commit",
    });
    expect(turns[1]!.parts[2]).toEqual({ kind: "text", text: "Checking status now." });
    expect(turns[1]!.parts[3]).toEqual({ kind: "text", text: "Working tree is clean." });
  });

  it("handles tool errors properly", () => {
    const rows: HermesMessageRow[] = [
      {
        id: 1,
        role: "assistant",
        content: null,
        tool_call_id: null,
        tool_calls: JSON.stringify([
          { id: "call_bad", function: { name: "bash", arguments: '{"command":"false"}' } },
        ]),
        tool_name: null,
        reasoning: null,
        timestamp: 1700000000,
      },
      {
        id: 2,
        role: "tool",
        content: "Error: command failed with code 1",
        tool_call_id: "call_bad",
        tool_calls: null,
        tool_name: "bash",
        reasoning: null,
        timestamp: 1700000001,
      },
    ];

    const turns = parseHermesRows(rows);
    expect(turns.length).toBe(1);
    const toolPart = turns[0]!.parts[0];
    expect(toolPart?.kind).toBe("tool");
    if (toolPart?.kind === "tool") {
      expect(toolPart.error).toBe(true);
    }
  });
});

describe("hermesConversationPage SQLite integration", () => {
  let tempDir: string;
  let dbPath: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "hermes-sqlite-test-"));
    dbPath = join(tempDir, "state.db");
    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        model TEXT,
        model_config TEXT,
        started_at REAL NOT NULL,
        input_tokens INTEGER DEFAULT 0,
        output_tokens INTEGER DEFAULT 0,
        reasoning_tokens INTEGER DEFAULT 0
      );
      CREATE TABLE messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT,
        tool_call_id TEXT,
        tool_calls TEXT,
        tool_name TEXT,
        reasoning TEXT,
        timestamp REAL NOT NULL,
        active INTEGER NOT NULL DEFAULT 1,
        compacted INTEGER NOT NULL DEFAULT 0
      );
    `);
    db.close();
    forgetHermesTranscriptState();
  });

  afterEach(() => {
    forgetHermesTranscriptState();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("throws ConversationNotStarted when session has no messages", () => {
    const db = new Database(dbPath);
    db.query("INSERT INTO sessions (id, model, started_at) VALUES (?, ?, ?)").run("empty_session", "test-model", 1700000000);
    db.close();

    expect(() => hermesConversationPage("empty_session", dbPath)).toThrow(ConversationNotStarted);
  });

  it("reads structured conversation turns and metadata", () => {
    const db = new Database(dbPath);
    db.query("INSERT INTO sessions (id, model, model_config, started_at, input_tokens, output_tokens) VALUES (?, ?, ?, ?, ?, ?)")
      .run("s1", "claude-3-7-sonnet", JSON.stringify({ reasoning_effort: "high" }), 1700000000, 1500, 300);
    db.query("INSERT INTO messages (session_id, role, content, timestamp) VALUES (?, ?, ?, ?)")
      .run("s1", "user", "Hello Hermes", 1700000001);
    db.query("INSERT INTO messages (session_id, role, content, reasoning, timestamp) VALUES (?, ?, ?, ?, ?)")
      .run("s1", "assistant", "Hello! How can I help you?", "Thinking about greeting.", 1700000002);
    db.close();

    const result = hermesConversationPage("s1", dbPath);
    expect(result.source).toBe("hermes-transcript");
    expect(result.history_id).toStartWith("hermes:s1:");
    expect(result.metadata.model).toBe("claude-3-7-sonnet");
    expect(result.metadata.reasoning_effort).toBe("high");
    expect(result.metadata.context).toBeUndefined();
    expect(result.turns.length).toBe(2);
    expect(result.turns[0]!.role).toBe("user");
    expect(result.turns[1]!.role).toBe("assistant");
    expect(result.turns[1]!.parts[0]).toEqual({ kind: "thinking", text: "Thinking about greeting." });
    expect(result.turns[1]!.parts[1]).toEqual({ kind: "text", text: "Hello! How can I help you?" });
    expect(result.cursor).toBeNull();
  });

  it("pages one long exchange by active rows without gaps or overlap", () => {
    const db = new Database(dbPath);
    try {
      db.query("INSERT INTO sessions (id, model, started_at) VALUES (?, ?, ?)").run("s_page", "m", 1700000000);
      const insert = db.query("INSERT INTO messages (session_id, role, content, tool_call_id, tool_calls, tool_name, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?)");
      db.transaction(() => {
        insert.run("s_page", "user", "Start", null, null, null, 1700000001);
        for (let index = 1; index <= 200; index++) {
          insert.run("s_page", "assistant", null, null, JSON.stringify([
            { id: `call-${index}`, function: { name: "bash", arguments: JSON.stringify({ command: `echo ${index}` }) } },
          ]), null, 1700000000 + index * 2);
          insert.run("s_page", "tool", `result-${index}`, `call-${index}`, null, "bash", 1700000001 + index * 2);
        }
      })();
    } finally { db.close(); }

    const pages = [];
    let page = hermesConversationPage("s_page", dbPath);
    pages.push(page);
    while (page.cursor !== null) {
      page = hermesConversationPage("s_page", dbPath, { before: page.cursor });
      pages.push(page);
    }
    pages.reverse();
    expect(pages.map(item => item.turns.flatMap(turn => turn.parts).filter(part => part.kind === "tool").length))
      .toEqual([0, 50, 50, 50, 50]);
    expect(pages.flatMap(item => item.turns).flatMap(turn => turn.parts).map(part =>
      part.kind === "text" ? part.text : part.kind === "tool" ? `${part.summary}:${part.output}` : part.kind))
      .toEqual(["Start", ...Array.from({ length: 200 }, (_, index) => `echo ${index + 1}:result-${index + 1}`)]);
  });

  it("throws HistoryChanged on invalid cursor", () => {
    const db = new Database(dbPath);
    db.query("INSERT INTO sessions (id, started_at) VALUES (?, ?)").run("s_curs", 1700000000);
    db.query("INSERT INTO messages (session_id, role, content, timestamp) VALUES (?, ?, ?, ?)").run("s_curs", "user", "hi", 1700000001);
    db.close();

    expect(() => hermesConversationPage("s_curs", dbPath, { before: "other:session:10" })).toThrow(HistoryChanged);
  });

  /** Creates alternating turns so a 100-row page starts on a user message. */
  const populate = (count = 150): void => {
    const db = new Database(dbPath);
    try {
      db.query("INSERT INTO sessions (id, model, started_at) VALUES ('s', 'old-model', 1700000000)").run();
      const insert = db.query("INSERT INTO messages (session_id, role, content, timestamp) VALUES ('s', ?, ?, ?)");
      db.transaction(() => {
        for (let id = 1; id <= count; id++) insert.run(id % 2 ? "user" : "assistant", `Message ${id}`, 1700000000 + id);
      })();
    } finally { db.close(); }
  };

  it("keeps the held page unchanged when polling after loading older history", () => {
    populate();
    const newest = hermesConversationPage("s", dbPath);
    hermesConversationPage("s", dbPath, { before: newest.cursor! });
    const polled = hermesConversationPage("s", dbPath, { from: newest.cursor! });
    expect(polled.turns).toEqual(newest.turns);
    expect(polled.cursor).toBe(newest.cursor);
    expect(hermesConversationPage("s", dbPath, { from: newest.cursor! }).version).toBe(polled.version);
  });

  it("returns the newest page after appends and fills the gap back to the held start", () => {
    populate();
    const initial = hermesConversationPage("s", dbPath);
    const db = new Database(dbPath);
    try {
      const insert = db.query("INSERT INTO messages (session_id, role, content, timestamp) VALUES ('s', ?, ?, ?)");
      db.transaction(() => {
        for (let id = 151; id <= 350; id++) insert.run(id % 2 ? "user" : "assistant", `Message ${id}`, 1700000000 + id);
      })();
    } finally { db.close(); }
    const newest = hermesConversationPage("s", dbPath, { from: initial.cursor! });
    expect(newest.turns[0]!.parts).toEqual([{ kind: "text", text: "Message 251" }]);
    expect(newest.turns.at(-1)!.parts).toEqual([{ kind: "text", text: "Message 350" }]);
    const between = hermesConversationPage("s", dbPath, { before: newest.cursor!, since: initial.cursor! });
    const first = hermesConversationPage("s", dbPath, { before: between.cursor!, since: initial.cursor! });
    expect(first.cursor).toBe(initial.cursor);
    expect([...first.turns, ...between.turns, ...newest.turns].flatMap(turn => turn.parts).map(part => part.kind === "text" ? part.text : ""))
      .toEqual(Array.from({ length: 300 }, (_, index) => `Message ${index + 51}`));
  });
  it("accepts every active row cursor and refuses foreign, missing, inactive and reversed positions", () => {
    populate();
    const newest = hermesConversationPage("s", dbPath);
    const prefix = `${newest.history_id}:`;
    expect(hermesConversationPage("s", dbPath, { from: `${prefix}52` }).cursor).toBe(`${prefix}52`);
    expect(hermesConversationPage("s", dbPath, { before: `${prefix}52` }).turns.at(-1)!.parts)
      .toEqual([{ kind: "text", text: "Message 51" }]);
    const db = new Database(dbPath);
    try { db.query("UPDATE messages SET active = 0, compacted = 0 WHERE id = 52").run(); }
    finally { db.close(); }
    for (const page of [
      { before: newest.cursor!, since: "hermes:another-session:1" },
      { from: `${prefix}-1` },
      { from: `${prefix}9999` },
      { from: `${prefix}52` },
      { before: newest.cursor!, since: `${prefix}101` },
      { before: newest.cursor!, since: `${prefix}not-a-number` },
    ]) expect(() => hermesConversationPage("s", dbPath, page)).toThrow(HistoryChanged);
  });

  it("keeps adjacent tool calls and results together at a page boundary", () => {
    populate();
    const db = new Database(dbPath);
    try {
      db.query("UPDATE messages SET role = 'assistant', content = NULL, tool_calls = ? WHERE id = 49").run(JSON.stringify([
        { id: "boundary-a", function: { name: "bash", arguments: '{"command":"echo a"}' } },
        { id: "boundary-b", function: { name: "bash", arguments: '{"command":"echo b"}' } },
      ]));
      db.query("UPDATE messages SET role = 'tool', content = 'a', tool_call_id = 'boundary-a', tool_name = 'bash' WHERE id = 50").run();
      db.query("UPDATE messages SET role = 'tool', content = 'b', tool_call_id = 'boundary-b', tool_name = 'bash' WHERE id = 51").run();
    } finally { db.close(); }
    const newest = hermesConversationPage("s", dbPath);
    const older = hermesConversationPage("s", dbPath, { before: newest.cursor! });
    expect(newest.turns.flatMap(turn => turn.parts).filter(part => part.kind === "tool")).toHaveLength(0);
    expect(newest.turns).toHaveLength(99);
    const tools = older.turns.flatMap(turn => turn.parts).filter(part => part.kind === "tool");
    expect(tools).toHaveLength(2);
    expect(tools.map(tool => ({ summary: tool.summary, output: tool.output }))).toEqual([
      { summary: "echo a", output: "a" },
      { summary: "echo b", output: "b" },
    ]);
  });

  it("splits a tool group that cannot fit without widening the page", () => {
    const db = new Database(dbPath);
    try {
      db.query("INSERT INTO sessions (id, model, started_at) VALUES ('wide', 'm', 1700000000)").run();
      const insert = db.query("INSERT INTO messages (session_id, role, content, tool_call_id, tool_calls, tool_name, timestamp) VALUES ('wide', ?, ?, ?, ?, ?, ?)");
      const calls = Array.from({ length: 100 }, (_, index) => ({
        id: `wide-${index + 1}`,
        function: { name: "bash", arguments: JSON.stringify({ command: `echo ${index + 1}` }) },
      }));
      db.transaction(() => {
        insert.run("user", "Start", null, null, null, 1700000001);
        insert.run("assistant", null, null, JSON.stringify(calls), null, 1700000002);
        for (let index = 1; index <= 100; index++) {
          insert.run("tool", `result-${index}`, `wide-${index}`, null, "bash", 1700000002 + index);
        }
      })();
    } finally { db.close(); }
    const newest = hermesConversationPage("wide", dbPath);
    expect(newest.turns.flatMap(turn => turn.parts).filter(part => part.kind === "tool")).toHaveLength(100);
    const older = hermesConversationPage("wide", dbPath, { before: newest.cursor! });
    expect(older.turns.flatMap(turn => turn.parts).filter(part => part.kind === "tool")).toHaveLength(100);
  });

  it("refreshes metadata and edited messages while a WAL writer stays open", () => {
    populate(2);
    const db = new Database(dbPath);
    try {
      db.exec("PRAGMA journal_mode=WAL; PRAGMA wal_checkpoint(TRUNCATE)");
      const before = hermesConversationPage("s", dbPath);
      const stat = statSync(dbPath);
      db.query("UPDATE sessions SET model = 'new-model' WHERE id = 's'").run();
      const metadata = hermesConversationPage("s", dbPath);
      expect(statSync(dbPath).mtimeMs).toBe(stat.mtimeMs);
      expect(statSync(dbPath).size).toBe(stat.size);
      expect(metadata.metadata.model).toBe("new-model");
      expect(metadata.version).not.toBe(before.version);
      db.query("UPDATE messages SET content = 'Edited response' WHERE id = 2").run();
      const edited = hermesConversationPage("s", dbPath);
      expect(edited.turns[1]!.parts).toEqual([{ kind: "text", text: "Edited response" }]);
      expect(edited.version).not.toBe(metadata.version);
      expect(edited.history_id).toBe(before.history_id);
    } finally { db.close(); }
  });

  it("reads nested reasoning settings and omits cumulative session usage", () => {
    populate(2);
    const db = new Database(dbPath);
    try {
      db.query("UPDATE sessions SET model_config = ?, input_tokens = 1000000, output_tokens = 100000 WHERE id = 's'")
        .run(JSON.stringify({ reasoning_config: { enabled: true, effort: "high" } }));
      expect(hermesConversationPage("s", dbPath).metadata).toEqual({ model: "old-model", reasoning_effort: "high" });
      db.query("UPDATE sessions SET model_config = ? WHERE id = 's'").run(JSON.stringify({ reasoning_config: { enabled: false } }));
      expect(hermesConversationPage("s", dbPath).metadata.reasoning_effort).toBe("off");
    } finally { db.close(); }
  });

  it("loads a whole tool result only from the selected session", () => {
    populate(2);
    const db = new Database(dbPath);
    const output = "tool result ".repeat(500);
    try {
      db.query("INSERT INTO messages (session_id, role, content, tool_call_id, timestamp) VALUES (?, 'tool', ?, 'shared-call', 1700000003)").run("s", output);
      db.query("INSERT INTO messages (session_id, role, content, tool_call_id, timestamp) VALUES (?, 'tool', ?, 'shared-call', 1700000004)").run("another-session", "Another pane's output");
    } finally { db.close(); }
    const page = hermesConversationPage("s", dbPath);
    const tool = page.turns.flatMap(t => t.parts).find((p): p is Extract<ConversationPart, { kind: "tool" }> => p.kind === "tool");
    expect(tool?.output_ref).toBeDefined();
    expect(hermesToolOutput("s", dbPath, tool!.output_ref!, 2_000_000)).toBe(output);
    expect(hermesToolOutput("s", dbPath, "missing-call", 2_000_000)).toBeNull();
    expect(hermesToolOutput("s", dbPath, tool!.output_ref!, 20)).toBe(output.slice(0, 20));
  });

  it("changes history identity and refuses held cursors after database replacement", () => {
    populate();
    const before = hermesConversationPage("s", dbPath);
    const replacement = join(tempDir, "replacement.db");
    copyFileSync(dbPath, replacement);
    renameSync(replacement, dbPath);
    const after = hermesConversationPage("s", dbPath);
    expect(after.history_id).not.toBe(before.history_id);
    expect(() => hermesConversationPage("s", dbPath, { from: before.cursor! })).toThrow(HistoryChanged);
  });

  it("contributes only preview allowance to normal reads and reports true stored output size", () => {
    populate();
    const db = new Database(dbPath);
    const storedOutput = "a".repeat(50_000);
    try {
      db.query("INSERT INTO messages (session_id, role, tool_calls, timestamp) VALUES ('s', 'assistant', ?, 1700000003)").run(
        JSON.stringify([{ id: "tool-preview", function: { name: "bash", arguments: '{"command":"echo"}' } }]),
      );
      db.query("INSERT INTO messages (session_id, role, content, tool_call_id, tool_name, timestamp) VALUES ('s', 'tool', ?, 'tool-preview', 'bash', 1700000004)")
        .run(storedOutput);
    } finally { db.close(); }
    const newest = hermesConversationPage("s", dbPath);
    const tool = newest.turns
      .flatMap(turn => turn.parts)
      .find((part): part is Extract<ConversationPart, { kind: "tool" }> => part.kind === "tool" && part.name === "bash");
    expect(tool).toBeDefined();
    expect(tool?.output_size).toBe(50_000);
    expect(tool?.output).toBe(`${"a".repeat(4000)}\n… trimmed`);
    expect(tool?.output.length).toBeLessThan(4100);
    expect(hermesToolOutput("s", dbPath, tool!.output_ref!, 2_000_000)).toBe(storedOutput);
  });

  it("clips a single oversized non-tool row and marks it trimmed while returning the row", () => {
    const db = new Database(dbPath);
    const hugeText = "X".repeat(17 * 1024 * 1024);
    try {
      db.query("INSERT INTO sessions (id, model, started_at) VALUES ('huge', 'm', 1700000000)").run();
      db.query("INSERT INTO messages (session_id, role, content, timestamp) VALUES ('huge', 'user', 'earlier prompt', 1700000001)").run();
      db.query("INSERT INTO messages (session_id, role, content, timestamp) VALUES ('huge', 'user', ?, 1700000002)").run(hugeText);
    } finally { db.close(); }
    const newest = hermesConversationPage("huge", dbPath);
    expect(newest.turns).toHaveLength(1);
    const part = newest.turns[0]!.parts[0];
    if (part?.kind !== "text") throw new Error("expected text part");
    expect(part.text.endsWith("\n… trimmed")).toBe(true);
    expect(Buffer.byteLength(part.text, "utf8")).toBeLessThanOrEqual(TRANSCRIPT_WINDOW_BYTES);
    expect(newest.cursor).toBeTruthy();
    const older = hermesConversationPage("huge", dbPath, { before: newest.cursor! });
    expect(older.turns[0]!.parts[0]).toEqual({ kind: "text", text: "earlier prompt" });
  });

  it("bounds oversized reasoning and tool-call arguments before reading the row", () => {
    const db = new Database(dbPath);
    try {
      db.query("INSERT INTO sessions (id, model, started_at) VALUES ('large-fields', 'm', 1700000000)").run();
      db.query("INSERT INTO messages (session_id, role, content, timestamp) VALUES ('large-fields', 'user', 'prompt', 1700000001)").run();
      db.query("INSERT INTO messages (session_id, role, content, reasoning, tool_calls, timestamp) VALUES ('large-fields', 'assistant', 'answer', ?, ?, 1700000002)")
        .run("r".repeat(TRANSCRIPT_WINDOW_BYTES + 1), JSON.stringify([{ id: "large-call", function: { name: "bash", arguments: "x".repeat(4 * 1024 * 1024) } }]));
    } finally { db.close(); }

    const newest = hermesConversationPage("large-fields", dbPath);
    expect(newest.turns).toHaveLength(1);
    const thinking = newest.turns[0]!.parts.find((part) => part.kind === "thinking");
    expect(thinking?.kind === "thinking" ? thinking.text.endsWith("\n… trimmed") : false).toBe(true);
    expect(thinking?.kind === "thinking" ? Buffer.byteLength(thinking.text, "utf8") : 0).toBeLessThanOrEqual(TRANSCRIPT_WINDOW_BYTES);
    expect(newest.turns[0]!.parts.find((part) => part.kind === "tool")).toMatchObject({
      kind: "tool", name: "tool", input: "", output: "", arguments_omitted: true,
    });
    expect(hermesConversationPage("large-fields", dbPath, { from: newest.cursor! }).turns[0]!.parts).toEqual(newest.turns[0]!.parts);
  });

  it("stops newest, held, and historical pages at 16 MiB of selected text", () => {
    const db = new Database(dbPath);
    const fiveMb = "M".repeat(5 * 1024 * 1024);
    try {
      db.query("INSERT INTO sessions (id, model, started_at) VALUES ('multi-mb', 'm', 1700000000)").run();
      const insert = db.query("INSERT INTO messages (session_id, role, content, timestamp) VALUES ('multi-mb', 'user', ?, ?)");
      db.transaction(() => {
        for (let i = 1; i <= 5; i++) {
          insert.run(`msg-${i}: ${fiveMb}`, 1700000000 + i);
        }
      })();
    } finally { db.close(); }
    const newest = hermesConversationPage("multi-mb", dbPath);
    expect(newest.turns).toHaveLength(3);
    const older = hermesConversationPage("multi-mb", dbPath, { before: newest.cursor! });
    expect(older.turns).toHaveLength(2);
    const allTexts = [...older.turns, ...newest.turns].map(t => {
      const first = t.parts[0];
      return first?.kind === "text" ? first.text.slice(0, 6) : "";
    });
    expect(allTexts).toEqual(["msg-1:", "msg-2:", "msg-3:", "msg-4:", "msg-5:"]);
  });

  it("keeps an exchange with 2000 tool calls and 50 kB results bounded by rows and bytes across historical walk", () => {
    const db = new Database(dbPath);
    const result50k = "r".repeat(50_000);
    try {
      db.query("INSERT INTO sessions (id, model, started_at) VALUES ('big-ex', 'm', 1700000000)").run();
      const insert = db.query("INSERT INTO messages (session_id, role, content, tool_call_id, tool_calls, tool_name, timestamp) VALUES ('big-ex', ?, ?, ?, ?, ?, ?)");
      db.transaction(() => {
        insert.run("user", "Start big task", null, null, null, 1700000001);
        for (let i = 1; i <= 2000; i++) {
          const callId = `c-${i}`;
          insert.run("assistant", null, null, JSON.stringify([{ id: callId, function: { name: "bash", arguments: "{}" } }]), null, 1700000001 + i * 2);
          insert.run("tool", result50k, callId, null, "bash", 1700000002 + i * 2);
        }
      })();
    } finally { db.close(); }

    const pages: RecognizedConversation[] = [];
    let page = hermesConversationPage("big-ex", dbPath);
    pages.push(page);
    while (page.cursor) {
      page = hermesConversationPage("big-ex", dbPath, { before: page.cursor });
      pages.push(page);
    }

    for (const p of pages) {
      expect(p.turns.length).toBeLessThanOrEqual(100);
      const totalTextBytes = p.turns
        .flatMap((t: ConversationTurn) => t.parts)
        .reduce((sum: number, part: ConversationPart) => {
          if (part.kind === "text" || part.kind === "thinking") return sum + Buffer.byteLength(part.text, "utf8");
          if (part.kind === "tool") return sum + Buffer.byteLength(part.output, "utf8") + Buffer.byteLength(part.input, "utf8");
          return sum;
        }, 0);
      expect(totalTextBytes).toBeLessThanOrEqual(TRANSCRIPT_WINDOW_BYTES);
    }

    const visitedToolRefs = pages.flatMap(p =>
      p.turns
        .flatMap((t: ConversationTurn) => t.parts)
        .filter((prt: ConversationPart): prt is Extract<ConversationPart, { kind: "tool" }> => prt.kind === "tool")
        .map(prt => prt.output_ref),
    );
    expect(visitedToolRefs).toHaveLength(2000);
    expect(new Set(visitedToolRefs).size).toBe(2000);
  });

  it("measures multibyte UTF-8 characters by bytes when bounding pages", () => {
    const db = new Database(dbPath);
    const sixMb = "🦀".repeat(1_500_000);
    try {
      db.query("INSERT INTO sessions (id, model, started_at) VALUES ('utf8-session', 'm', 1700000000)").run();
      const insert = db.query("INSERT INTO messages (session_id, role, content, timestamp) VALUES ('utf8-session', 'user', ?, ?)");
      db.transaction(() => {
        for (let i = 1; i <= 3; i++) insert.run(`msg-${i}: ${sixMb}`, 1700000000 + i);
      })();
    } finally { db.close(); }

    const newest = hermesConversationPage("utf8-session", dbPath);
    expect(newest.turns).toHaveLength(2);
    const older = hermesConversationPage("utf8-session", dbPath, { before: newest.cursor! });
    expect(older.turns).toHaveLength(1);
  });

  it("converts database query, schema, and corruption errors into ConversationUnavailable", () => {
    const corruptDb = join(tempDir, "corrupt.db");
    writeFileSync(corruptDb, "not a sqlite database");
    expect(() => hermesConversationPage("s", corruptDb)).toThrow(ConversationUnavailable);

    const emptyDb = join(tempDir, "empty-schema.db");
    const db = new Database(emptyDb);
    db.exec("CREATE TABLE dummy (id INTEGER)");
    db.close();
    expect(() => hermesConversationPage("s", emptyDb)).toThrow(ConversationUnavailable);
  });

  it("returns null for tool output when database is corrupt or incompatible", () => {
    const corruptDb = join(tempDir, "corrupt-tool.db");
    writeFileSync(corruptDb, "invalid database");
    expect(hermesToolOutput("s", corruptDb, "c1", 1000)).toBeNull();

    const badSchema = join(tempDir, "bad-schema.db");
    const db = new Database(badSchema);
    db.exec("CREATE TABLE dummy (id INTEGER)");
    db.close();
    expect(hermesToolOutput("s", badSchema, "c1", 1000)).toBeNull();
  });

  it("isolates malformed tool arguments without dropping sibling calls", () => {
    const db = new Database(dbPath);
    try {
      db.query("INSERT INTO sessions (id, model, started_at) VALUES ('args-test', 'm', 1700000000)").run();
      const calls = [
        { id: "call-null", function: { name: "bash", arguments: null } },
        { id: "call-array", function: { name: "bash", arguments: [1, 2, 3] } },
        { id: "call-num", function: { name: "bash", arguments: 42 } },
        { id: "call-valid", function: { name: "bash", arguments: JSON.stringify({ command: "echo ok" }) } },
      ];
      db.query("INSERT INTO messages (session_id, role, tool_calls, timestamp) VALUES ('args-test', 'assistant', ?, 1700000001)")
        .run(JSON.stringify(calls));
    } finally { db.close(); }
    const page = hermesConversationPage("args-test", dbPath);
    expect(page.turns).toHaveLength(1);
    const tools = page.turns[0]!.parts.filter((p): p is Extract<ConversationPart, { kind: "tool" }> => p.kind === "tool");
    expect(tools).toHaveLength(4);
    expect(tools.map(t => t.name)).toEqual(["bash", "bash", "bash", "bash"]);
    expect(tools[0]!.input).toBe("null");
    expect(tools[1]!.input).toBe("[1,2,3]");
    expect(tools[2]!.input).toBe("42");
    expect(tools[3]!.summary).toBe("echo ok");
  });

  it("handles malformed tool call items and treats invalid timestamps as unknown", () => {
    const db = new Database(dbPath);
    try {
      db.query("INSERT INTO sessions (id, model, started_at) VALUES ('bad-records', 'm', 1700000000)").run();
      db.query("INSERT INTO messages (session_id, role, content, timestamp) VALUES ('bad-records', 'user', 'hi', ?)").run(1e25);
      const mixedCalls = [null, "bad-item", 123, { id: "c-good", function: { name: "bash", arguments: '{"command":"ls"}' } }];
      db.query("INSERT INTO messages (session_id, role, tool_calls, timestamp) VALUES ('bad-records', 'assistant', ?, 1700000002)")
        .run(JSON.stringify(mixedCalls));
    } finally { db.close(); }
    const page = hermesConversationPage("bad-records", dbPath);
    expect(page.turns).toHaveLength(2);
    expect(page.turns[0]!.ts).toBeNull();
    expect(page.turns[0]!.parts).toEqual([{ kind: "text", text: "hi" }]);
    const tools = page.turns[1]!.parts.filter((p): p is Extract<ConversationPart, { kind: "tool" }> => p.kind === "tool");
    expect(tools).toHaveLength(1);
    expect(tools[0]!.summary).toBe("ls");
  });

  it("scopes full tool output references to transcript generation and rejects cross-session reused IDs", () => {
    const db = new Database(dbPath);
    const outputA = "output-a-".repeat(500);
    const outputB = "output-b-".repeat(500);
    try {
      db.query("INSERT INTO sessions (id, model, started_at) VALUES ('s-a', 'm', 1700000100)").run();
      db.query("INSERT INTO sessions (id, model, started_at) VALUES ('s-b', 'm', 1700000200)").run();
      db.query("INSERT INTO messages (session_id, role, tool_calls, timestamp) VALUES ('s-a', 'assistant', ?, 1700000101)")
        .run(JSON.stringify([{ id: "reused-call", function: { name: "bash", arguments: "{}" } }]));
      db.query("INSERT INTO messages (session_id, role, content, tool_call_id, tool_name, timestamp) VALUES ('s-a', 'tool', ?, 'reused-call', 'bash', 1700000102)").run(outputA);
      db.query("INSERT INTO messages (session_id, role, tool_calls, timestamp) VALUES ('s-b', 'assistant', ?, 1700000201)")
        .run(JSON.stringify([{ id: "reused-call", function: { name: "bash", arguments: "{}" } }]));
      db.query("INSERT INTO messages (session_id, role, content, tool_call_id, tool_name, timestamp) VALUES ('s-b', 'tool', ?, 'reused-call', 'bash', 1700000202)").run(outputB);
    } finally { db.close(); }

    const pageA = hermesConversationPage("s-a", dbPath);
    const pageB = hermesConversationPage("s-b", dbPath);
    const refA = pageA.turns[0]!.parts.find((p): p is Extract<ConversationPart, { kind: "tool" }> => p.kind === "tool")?.output_ref;
    const refB = pageB.turns[0]!.parts.find((p): p is Extract<ConversationPart, { kind: "tool" }> => p.kind === "tool")?.output_ref;

    expect(refA).toBeDefined();
    expect(refB).toBeDefined();
    expect(refA).not.toBe(refB);

    expect(hermesToolOutput("s-a", dbPath, refA!, 2_000_000)).toBe(outputA);
    expect(hermesToolOutput("s-b", dbPath, refB!, 2_000_000)).toBe(outputB);
    expect(hermesToolOutput("s-a", dbPath, refB!, 2_000_000)).toBeNull();
    expect(hermesToolOutput("s-b", dbPath, refA!, 2_000_000)).toBeNull();
    expect(hermesToolOutput("s-a", dbPath, "reused-call", 2_000_000)).toBeNull();
    expect(hermesToolOutput("s-a", dbPath, "malformed:ref:extra", 2_000_000)).toBeNull();
  });
});
