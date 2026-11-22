import { afterEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { HerdrPane, PaneBackgroundAgentDetail } from "../shared/protocol.ts";
import { handleBackgroundAgentRequest, type BackgroundAgentDeps } from "./background-agent.ts";
import { ClaudeSubagentStatus, DETAIL_LIMITS, backgroundAgentDetail, forgetSubagents } from "./claude-subagents.ts";
import { OpencodeSubagentStatus } from "./opencode-subagents.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  forgetSubagents();
});

const FIRST = "11111111-1111-4111-8111-111111111111";
const SECOND = "22222222-2222-4222-8222-222222222222";
const json = (value: unknown): string => `${JSON.stringify(value)}\n`;

function store(): { root: string; transcript: (session: string) => string } {
  const root = mkdtempSync(join(tmpdir(), "herdr-background-agent-"));
  roots.push(root);
  for (const session of [FIRST, SECOND]) {
    const dir = join(root, "projects", "p", session, "subagents");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(root, "projects", "p", `${session}.jsonl`), json({ type: "user", timestamp: "2026-10-06T11:00:00.000Z", message: { role: "user", content: "go" } }));
    writeFileSync(join(dir, "agent-a1.meta.json"), JSON.stringify({ agentType: "reviewer", description: `agent of ${session}`, toolUseId: "toolu_a1" }));
    writeFileSync(join(dir, "agent-a1.jsonl"), json({ isSidechain: true, sessionId: session, agentId: "a1", type: "user", timestamp: "2026-10-06T11:01:00.000Z", message: { role: "user", content: `prompt of ${session}` } }));
  }
  return { root, transcript: (session) => join(root, "projects", "p", `${session}.jsonl`) };
}

function command(transcript: string, id: string): void {
  appendFileSync(transcript, json({ type: "assistant", timestamp: "2026-10-06T11:02:00.000Z", message: { role: "assistant", content: [{ type: "tool_use", id: `toolu_${id}`, name: "Bash", input: { command: "bun test", run_in_background: true } }] } }));
  appendFileSync(transcript, json({ type: "user", timestamp: "2026-10-06T11:02:01.000Z", message: { role: "user", content: [{ type: "tool_result", tool_use_id: `toolu_${id}`, content: `Command running in background with ID: ${id}.` }] }, toolUseResult: { stdout: "", stderr: "", interrupted: false, isImage: false, backgroundTaskId: id } }));
}

const pane = (session: string, agent = "claude"): HerdrPane => ({ pane_id: "w0:p0", workspace_id: "w0", agent, agent_status: "working", agent_session: { kind: "id", value: session } } as unknown as HerdrPane);

function harness(sessions: string[], agent = "claude", read?: BackgroundAgentDeps["read"]) {
  const files = store();
  const claudeAgents = new ClaudeSubagentStatus({ resolve: async (seen) => ({ path: files.transcript(seen.agent_session?.value ?? ""), startedAt: null, pid: null }), onChange: () => {} });
  const asked: string[] = [];
  const request = (query: string) => handleBackgroundAgentRequest(new Request(`http://local/api/pane/background-agent?${query}`), new URL(`http://local/api/pane/background-agent?${query}`), {
    paneGet: async () => { asked.push("pane"); return pane(sessions[Math.min(asked.length, sessions.length) - 1]!, agent); },
    omoPane: () => false,
    claudeAgents,
    read,
    now: () => Date.parse("2026-10-06T12:00:00.000Z"),
  });
  return { request, asked, files };
}

describe("handleBackgroundAgentRequest", () => {
  it("answers the selected pane's session, looked up before the read and after it", async () => {
    const { request, asked } = harness([FIRST]);
    const response = await request("pane_id=w0:p0&agent_id=a1");
    expect(response.status).toBe(200);
    const body: PaneBackgroundAgentDetail = await response.json();
    expect(body).toMatchObject({ agent_id: "a1", session_id: FIRST, title: `agent of ${FIRST}`, agent: "reviewer", prompt: `prompt of ${FIRST}`, events: [], truncated: false, incomplete: false, server_time: "2026-10-06T12:00:00.000Z" });
    expect(asked).toEqual(["pane", "pane"]);
  });

  it("tells a pane that moved to another session during the read, rather than answering either session's agent", async () => {
    const { request } = harness([FIRST, SECOND]);
    const response = await request("pane_id=w0:p0&agent_id=a1");
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: "background_target_changed" } });
    const settled = await request("pane_id=w0:p0&agent_id=a1");
    expect(settled.status).toBe(200);
    expect(((await settled.json()) as PaneBackgroundAgentDetail).session_id).toBe(SECOND);
  });

  it("refuses an id that is not a plain word before anything is looked up", async () => {
    const { request, asked } = harness([FIRST]);
    for (const id of ["..", "a/b", "%2Fetc%2Fpasswd", "a%00b", "x".repeat(129)]) {
      const response = await request(`pane_id=w0:p0&agent_id=${id}`);
      expect([id.slice(0, 12), response.status, ((await response.json()) as { error: { code: string } }).error.code]).toEqual([id.slice(0, 12), 400, "invalid_agent_id"]);
    }
    expect((await request("pane_id=w0:p0")).status).toBe(400);
    expect((await request("agent_id=a1")).status).toBe(400);
    expect((await request("pane_id=w0:p0&agent_id=a1", )).status).toBe(200);
    expect(asked).toEqual(["pane", "pane"]);
  });

  it("has no detail for another agent's pane, an OmO pane, or an agent the session does not have", async () => {
    const codex = harness([FIRST], "codex");
    const other = await codex.request("pane_id=w0:p0&agent_id=a1");
    expect([other.status, ((await other.json()) as { error: { code: string } }).error.code]).toEqual([501, "background_detail_unsupported"]);
    const omo = await handleBackgroundAgentRequest(new Request("http://local/api/pane/background-agent?pane_id=w0:p0&agent_id=a1"), new URL("http://local/api/pane/background-agent?pane_id=w0:p0&agent_id=a1"), {
      paneGet: async () => { throw new Error("not asked"); }, omoPane: () => true, claudeAgents: { ensure: async () => {}, sessionOf: () => null },
    });
    expect(omo.status).toBe(501);
    const { request } = harness([FIRST]);
    const missing = await request("pane_id=w0:p0&agent_id=nobody");
    expect([missing.status, ((await missing.json()) as { error: { code: string } }).error.code]).toEqual([404, "background_agent_not_found"]);
  });

  it("has no detail for a background command, though files bear its id", async () => {
    const { request, files } = harness([FIRST]);
    command(files.transcript(FIRST), "a1");
    const response = await request("pane_id=w0:p0&agent_id=a1");
    const text = await response.text();
    expect([response.status, (JSON.parse(text) as { error: { code: string } }).error.code]).toEqual([501, "background_detail_unsupported"]);
    expect(text).not.toContain("prompt of");
  });

  it("tells a pane whose session changed while the read was out, and answers nothing of the read", async () => {
    let entered!: () => void;
    const held = new Promise<void>((resolve) => { entered = resolve; });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const sessions = [FIRST];
    const { request } = harness(sessions, "claude", async (path, id) => { const read = backgroundAgentDetail(path, id); entered(); await gate; return read; });
    const answer = request("pane_id=w0:p0&agent_id=a1");
    await held;
    sessions.push(SECOND);
    release();
    const response = await answer;
    const text = await response.text();
    expect([response.status, (JSON.parse(text) as { error: { code: string } }).error.code]).toEqual([409, "background_target_changed"]);
    expect(text).not.toContain("prompt of");
  });
});

// OpenCode 2.0.32's two tables, as far as the detail reads them (server/opencode-subagents.test.ts has the whole schema)
const OPENCODE_SCHEMA = `
CREATE TABLE session_v2 (id text PRIMARY KEY, parent_id text, title text, agent text, revert text, time_created integer NOT NULL);
CREATE TABLE session_message (
  id text PRIMARY KEY, session_id text NOT NULL, type text NOT NULL, seq integer NOT NULL,
  time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL
);
`;
const PARENT_A = "ses_parentA";
const PARENT_B = "ses_parentB";
const AT = Date.parse("2026-10-06T11:00:00.000Z");

function opencodeStore() {
  const root = mkdtempSync(join(tmpdir(), "herdr-background-agent-opencode-"));
  roots.push(root);
  const path = join(root, "opencode.db");
  const db = new Database(path, { create: true });
  db.exec(OPENCODE_SCHEMA);
  let seq = 0;
  const add = (session: string, type: string, data: Record<string, unknown>, at = AT + seq * 1000) =>
    db.query("INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(`msg_${++seq}`, session, type, seq, at, at, JSON.stringify(data));
  const child = (parent: string, id: string) => {
    db.query("INSERT INTO session_v2 (id, parent_id, title, agent, time_created) VALUES (?, ?, ?, 'explore', ?)").run(id, parent, `task of ${parent}`, AT);
    add(id, "user", { time: { created: AT }, text: `prompt of ${parent}` });
    add(id, "assistant", { time: { created: AT + 1000 }, content: [{ type: "reasoning", text: "thinking it over" }, { type: "text", text: "looking" }, { type: "tool", name: "read", state: { status: "completed", input: { filePath: "a.ts" }, content: [{ type: "text", text: "file contents" }] } }] });
  };
  for (const parent of [PARENT_A, PARENT_B]) {
    db.query("INSERT INTO session_v2 (id, parent_id, title, agent, time_created) VALUES (?, NULL, 'parent', 'build', ?)").run(parent, AT);
    child(parent, `ses_child${parent.at(-1)}`);
  }
  add(PARENT_A, "shell", { shellID: "shl_build", command: "bun test", status: "running", metadata: { background: true } });
  return { path, db, add, child };
}

const opencodePane = (session: string): HerdrPane => ({ pane_id: "w0:p0", workspace_id: "w0", agent: "opencode", agent_status: "working", agent_session: { agent: "opencode", source: "herdr:opencode", kind: "id", value: session } } as unknown as HerdrPane);

function opencodeHarness(sessions: string[]) {
  const files = opencodeStore();
  const opencodeAgents = new OpencodeSubagentStatus({ store: () => files.path, onChange: () => {} });
  const asked: string[] = [];
  const request = (query: string) => handleBackgroundAgentRequest(new Request(`http://local/api/pane/background-agent?${query}`), new URL(`http://local/api/pane/background-agent?${query}`), {
    paneGet: async () => { asked.push("pane"); return opencodePane(sessions[Math.min(asked.length, sessions.length) - 1]!); },
    omoPane: () => false,
    claudeAgents: { ensure: async () => { throw new Error("not a Claude pane"); }, sessionOf: () => null },
    opencodeAgents,
    now: () => Date.parse("2026-10-06T12:00:00.000Z"),
  });
  return { request, asked, files };
}

const code = async (response: Response): Promise<[number, string]> => [response.status, ((await response.json()) as { error: { code: string } }).error.code];

describe("handleBackgroundAgentRequest on an OpenCode pane", () => {
  it("answers a child session of the pane's session: its dispatch prompt, then its prose and tool calls", async () => {
    const { request, asked } = opencodeHarness([PARENT_A]);
    const response = await request("pane_id=w0:p0&agent_id=ses_childA");
    expect(response.status).toBe(200);
    const body: PaneBackgroundAgentDetail = await response.json();
    expect(body).toEqual({
      agent_id: "ses_childA", session_id: PARENT_A, title: `task of ${PARENT_A}`, agent: "explore", prompt: `prompt of ${PARENT_A}`,
      events: [
        { kind: "text", text: "looking", at: new Date(AT + 1000).toISOString() },
        { kind: "tool", text: 'read {"filePath":"a.ts"}', at: new Date(AT + 1000).toISOString() },
      ],
      truncated: false, incomplete: false, limits: DETAIL_LIMITS, server_time: "2026-10-06T12:00:00.000Z",
    });
    expect(asked).toEqual(["pane", "pane"]);
  });

  it("answers no other session's child, and no background command", async () => {
    const { request } = opencodeHarness([PARENT_A]);
    expect(await code(await request("pane_id=w0:p0&agent_id=ses_childB"))).toEqual([404, "background_agent_not_found"]);
    expect(await code(await request("pane_id=w0:p0&agent_id=ses_nobody"))).toEqual([404, "background_agent_not_found"]);
    expect(await code(await request("pane_id=w0:p0&agent_id=shl_build"))).toEqual([501, "background_detail_unsupported"]);
  });

  it("tells a pane that moved to another session during the read, then follows it", async () => {
    const { request } = opencodeHarness([PARENT_A, PARENT_B]);
    const moved = await request("pane_id=w0:p0&agent_id=ses_childA");
    const text = await moved.text();
    expect([moved.status, (JSON.parse(text) as { error: { code: string } }).error.code]).toEqual([409, "background_target_changed"]);
    expect(text).not.toContain("prompt of");
    const settled = await request("pane_id=w0:p0&agent_id=ses_childB");
    expect(((await settled.json()) as PaneBackgroundAgentDetail).session_id).toBe(PARENT_B);
  });

  it("is bounded: the newest work within the limits, the prompt kept, and what was left out said", async () => {
    const { request, files } = opencodeHarness([PARENT_A]);
    for (let step = 0; step < DETAIL_LIMITS.max_events + 20; step++) files.add("ses_childA", "assistant", { content: [{ type: "text", text: `step ${step} ${"x".repeat(2000)}` }] });
    files.add("ses_childA", "assistant", { content: [{ type: "text", text: "y".repeat(70 * 1024) }] });
    files.add("ses_childA", "assistant", { content: [{ type: "text", text: "newest" }] });
    const body: PaneBackgroundAgentDetail = await (await request("pane_id=w0:p0&agent_id=ses_childA")).json();
    expect([body.prompt, body.truncated, body.incomplete, body.events.at(-1)?.text]).toEqual([`prompt of ${PARENT_A}`, true, true, "newest"]);
    expect(body.events.length).toBeLessThanOrEqual(DETAIL_LIMITS.max_events);
    expect(body.events.some((event) => event.text.startsWith("y"))).toBe(false);
    const bytes = body.events.reduce((sum, event) => sum + Buffer.byteLength(event.text), Buffer.byteLength(body.prompt ?? ""));
    expect(bytes).toBeLessThanOrEqual(DETAIL_LIMITS.max_output_bytes);
  });

  it("answers a continued child's current run: its newest prompt and the work since, not the earlier task's", async () => {
    const { request, files } = opencodeHarness([PARENT_A]);
    files.add("ses_childA", "user", { text: "the second task" });
    files.add("ses_childA", "assistant", { content: [{ type: "text", text: "on the second task" }] });
    const body: PaneBackgroundAgentDetail = await (await request("pane_id=w0:p0&agent_id=ses_childA")).json();
    expect([body.prompt, body.events.map((event) => event.text)]).toEqual(["the second task", ["on the second task"]]);
  });

  it("shows a step whose tools' output is large: its text and tool calls, not the output", async () => {
    const { request, files } = opencodeHarness([PARENT_A]);
    const output = (file: string) => ({ status: "completed", input: { filePath: file }, content: [{ type: "text", text: "z".repeat(40 * 1024) }] });
    files.add("ses_childA", "assistant", { content: [{ type: "text", text: "reading both" }, { type: "tool", name: "read", state: output("b.ts") }, { type: "tool", name: "read", state: output("c.ts") }] });
    const body: PaneBackgroundAgentDetail = await (await request("pane_id=w0:p0&agent_id=ses_childA")).json();
    expect([body.incomplete, body.events.slice(-3).map((event) => event.text)]).toEqual([false, ["reading both", 'read {"filePath":"b.ts"}', 'read {"filePath":"c.ts"}']]);
    expect(JSON.stringify(body)).not.toContain("zzz");
  });

  it("hides what a staged /undo took back, as the chat does", async () => {
    const { request, files } = opencodeHarness([PARENT_A]);
    files.add("ses_childA", "assistant", { content: [{ type: "text", text: "undone words" }] });
    const undone = files.db.query<{ id: string }, []>("SELECT id FROM session_message ORDER BY seq DESC LIMIT 1").get()!.id;
    files.db.query("UPDATE session_v2 SET revert = ? WHERE id = 'ses_childA'").run(JSON.stringify({ messageID: undone }));
    const body: PaneBackgroundAgentDetail = await (await request("pane_id=w0:p0&agent_id=ses_childA")).json();
    expect(body.events.map((event) => event.text)).toEqual(["looking", 'read {"filePath":"a.ts"}']);
  });

  it("is unavailable while the store cannot be read", async () => {
    const { request, files } = opencodeHarness([PARENT_A]);
    files.db.close();
    rmSync(files.path);
    expect(await code(await request("pane_id=w0:p0&agent_id=ses_childA"))).toEqual([503, "background_store_unavailable"]);
  });
});
