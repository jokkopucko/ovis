import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { forgetTranscriptState, paneConversation, paneTranscript, transcriptPage, transcriptToolOutput } from "./conversation.ts";
import { ConversationUnavailable } from "./conversation-shared.ts";
import * as herdr from "./herdr/client.ts";
import { LettaUnavailable, lettaToolOutput, parseLettaTranscript } from "./letta.ts";
import * as lettaStore from "./letta-store.ts";
import { isLettaProcess, type LettaProcess, lettaBinding, lettaInStartFolder, lettaLocalOwner, lettaLocalSettings, lettaRecordOwned, lettaOpenedSessions, lettaSessionOf, lettaTranscriptFor, lettaTranscriptHeld, lettaTranscriptPath, parseEnviron } from "./letta-store.ts";
import type { HerdrPane, SessionSnapshot } from "../shared/protocol.ts";

// Recorded from letta-code 0.34.27 in an isolated herdr session (local backend, herdr's Letta
// integration installed): two turns in the default conversation, then `/new` and two more.
const fixture = (name: string): string => readFileSync(join(import.meta.dir, "fixtures", "letta", name), "utf8");
const defaultLog = fixture("transcript-default-0.34.27.jsonl");
const newLog = fixture("transcript-conversation-0.34.27.jsonl");
const settingsAfterNew = fixture("settings.local-0.34.27.json");
const localConversation = fixture("local-conversation-0.34.27.json");
const AGENT = "agent-local-97f4bceb-2f0d-4a16-8b9f-abb2f3d4a72c";

const pane = (id: string, value: string | null, cwd: string): HerdrPane => ({
  pane_id: id, workspace_id: "w1", tab_id: "w1:t1", focused: false, cwd, foreground_cwd: cwd, agent: "letta", agent_status: "idle",
  ...(value === null ? {} : { agent_session: { agent: "letta", kind: "id", source: "herdr:letta", value } }),
} as HerdrPane);

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "letta-")); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); forgetTranscriptState(); });

describe("Letta transcript", () => {
  test("reads the prompts, tool calls with their results and answers Letta 0.34.27 recorded", () => {
    const turns = parseLettaTranscript(defaultLog);
    expect(turns.map((turn) => turn.role)).toEqual(["user", "assistant", "user", "assistant"]);
    expect(turns[0]).toEqual({ role: "user", ts: "2026-10-29T01:53:05.293Z", parts: [{ kind: "text", text: "Use your shell tool to run: echo fixture-ok && ls. Then reply in one short sentence." }] });
    const [bash, answer] = turns[1]!.parts;
    expect(bash).toMatchObject({ kind: "tool", name: "Bash", input: '{"command":"echo fixture-ok && ls","description":"Run test command to check fixture and list files"}', output: "fixture-ok\n" });
    expect(bash).not.toHaveProperty("error");
    expect(answer).toEqual({ kind: "text", text: "I have successfully run the command and verified the environment." });
    expect(turns[3]!.parts[0]).toMatchObject({ kind: "tool", name: "Read", output: "1\talpha\n2\tbeta\n3\t" });
    expect(turns[3]!.end_ts).toBe("2026-10-29T01:55:05.021Z");
  });

  test("a call Letta recorded as failed is marked so", () => {
    const turns = parseLettaTranscript(newLog);
    expect(turns.map((turn) => turn.role)).toEqual(["user", "assistant", "user", "assistant"]);
    expect(turns[3]!.parts[0]).toMatchObject({ kind: "tool", name: "Bash", error: true, output: "Exit code: 1\ncat: missing-file.txt: No such file or directory\n" });
  });

  test("reasoning and errors keep their own kinds", () => {
    const line = (entry: object): string => `${JSON.stringify({ captured_at: "2026-10-29T01:00:00.000Z", source_line_id: "x", ...entry })}\n`;
    const turns = parseLettaTranscript(line({ kind: "user", text: "hi" }) + line({ kind: "reasoning", text: "thinking" }) + line({ kind: "error", text: "rate limited" }));
    expect(turns[1]!.parts).toEqual([{ kind: "thinking", text: "thinking" }, { kind: "notice", text: "rate limited", source: "error" }]);
  });

  test("a transcript in a shape the reader does not know is refused, so the pane uses Terminal", () => {
    expect(() => parseLettaTranscript(`${JSON.stringify({ kind: "summary", text: "x", captured_at: "t" })}\n`)).toThrow(LettaUnavailable);
    expect(() => parseLettaTranscript(`{"kind":"user"\n${defaultLog}`)).toThrow(LettaUnavailable);
    // the last line can be one Letta is still writing
    expect(parseLettaTranscript(`${defaultLog}{"kind":"user","te`)).toHaveLength(4);
    const path = join(root, "transcript.jsonl");
    writeFileSync(path, `${defaultLog}${JSON.stringify({ kind: "tool_call", name: 3, captured_at: "t" })}\n`);
    expect(() => transcriptPage("letta-transcript", path)).toThrow(ConversationUnavailable);
  });

  test("pages at prompts and follows appends as a cold read does", () => {
    const path = join(root, "transcript.jsonl");
    writeFileSync(path, defaultLog);
    const first = transcriptPage("letta-transcript", path);
    expect(first.turns).toHaveLength(4);
    expect(first.metadata).toEqual({ model: null, reasoning_effort: null });
    appendFileSync(path, newLog);
    const live = transcriptPage("letta-transcript", path);
    expect(live.turns).toHaveLength(8);
    expect(live.history_id).toBe(first.history_id);
    forgetTranscriptState();
    expect(transcriptPage("letta-transcript", path).turns).toEqual(live.turns);
  });

  test("the whole output of a call is read by the ref its part carries", () => {
    const path = join(root, "transcript.jsonl");
    const long = "y".repeat(200_000);
    writeFileSync(path, `${JSON.stringify({ kind: "user", text: "go", captured_at: "2026-10-29T01:00:00.000Z", source_line_id: "user-1" })}\n${JSON.stringify({ kind: "tool_call", name: "Bash", argsText: "{}", resultText: long, resultOk: true, captured_at: "2026-10-29T01:00:00.000Z", source_line_id: "Bash-1-1" })}\n`);
    const tool = transcriptPage("letta-transcript", path).turns[1]!.parts[0]!;
    expect(tool).toMatchObject({ kind: "tool", output_ref: "Bash-1-1", output_size: long.length });
    expect(lettaToolOutput(path, "Bash-1-1")).toBe(long);
    expect(transcriptToolOutput("letta-transcript", path, "Bash-1-1")?.startsWith("yyy")).toBe(true);
    expect(lettaToolOutput(path, "Bash-9-9")).toBeNull();
  });

  test("a field the reader does not know falls back, and a ref the output route refuses is not offered", () => {
    const entry = (fields: object): string => `${JSON.stringify({ kind: "tool_call", name: "Bash", argsText: "{}", captured_at: "2026-10-29T01:00:00.000Z", ...fields })}\n`;
    expect(() => parseLettaTranscript(entry({ result: { text: "must not drop" } }))).toThrow(LettaUnavailable);
    const [part] = parseLettaTranscript(entry({ resultText: "z".repeat(10_000), source_line_id: "x".repeat(154) }))[0]!.parts;
    expect(part).toMatchObject({ kind: "tool" });
    expect(part).not.toHaveProperty("output_ref");
  });
});

describe("Letta conversation binding", () => {
  const opened = lettaOpenedSessions(settingsAfterNew)!;
  /** A project whose Letta record is `settings`, written `at`, and the pane's letta process started `started`. */
  const setup = (settings: string | null, at: number, started: number, env: Record<string, string> = {}): LettaProcess => {
    const cwd = join(root, "proj");
    mkdirSync(join(cwd, ".letta"), { recursive: true });
    if (settings !== null) {
      writeFileSync(join(cwd, ".letta", "settings.local.json"), settings);
      utimesSync(join(cwd, ".letta", "settings.local.json"), at / 1000, at / 1000);
    }
    return { pid: 4242, cwd, startedAt: started, env: { HOME: root, ...env } };
  };
  const now = Date.now();

  test("reads herdr's report, Letta's record and a letta process as they were recorded", () => {
    expect(lettaSessionOf(pane("w1:p1", `default:${AGENT}`, root))).toEqual({ reported: `default:${AGENT}`, agent: AGENT, conversation: "default" });
    expect(lettaSessionOf(pane("w1:p1", "local-conv-1", root))).toEqual({ reported: "local-conv-1", agent: null, conversation: "local-conv-1" });
    expect(opened).toEqual([{ agent: AGENT, conversation: "local-conv-1" }]);
    expect(isLettaProcess(["node", "/home/user/.npm-global/bin/letta", "-m", "openai-compatible/gemini-3.1-flash-lite"])).toBe(true);
    expect(isLettaProcess(["letta"])).toBe(true);
    expect(isLettaProcess(["node", "/srv/app.js"])).toBe(false);
    expect(parseEnviron("HOME=/h\0LETTA_CONFIG_DIR=/c=d\0")).toEqual({ HOME: "/h", LETTA_CONFIG_DIR: "/c=d" });
  });

  test("binds the conversation both name, taking its agent from Letta's record", () => {
    expect(lettaBinding(lettaSessionOf(pane("w1:p1", "local-conv-1", root))!, opened)).toEqual({ agent: AGENT, conversation: "local-conv-1" });
  });

  test("a report /new left behind binds nothing: herdr kept default while Letta moved to local-conv-1", () => {
    expect(lettaBinding(lettaSessionOf(pane("w1:p1", `default:${AGENT}`, root))!, opened)).toBeNull();
  });

  test("a conversation id two agents' records name, or no record names, binds nothing", () => {
    const session = lettaSessionOf(pane("w1:p1", "local-conv-1", root))!;
    expect(lettaBinding(session, [...opened, { agent: "agent-local-other", conversation: "local-conv-1" }])).toBeNull();
    expect(lettaBinding(session, [])).toBeNull();
    expect(lettaBinding(session, [{ agent: AGENT, conversation: "local-conv-2" }])).toBeNull();
  });

  test("reports of another source, agent or shape are not Letta's", () => {
    const base = pane("w1:p1", "local-conv-1", root);
    for (const agent_session of [
      { agent: "letta", kind: "id", source: "herdr:opencode", value: "local-conv-1" },
      { agent: "claude", kind: "id", source: "herdr:letta", value: "local-conv-1" },
      { agent: "letta", kind: "path", source: "herdr:letta", value: "local-conv-1" },
      { agent: "letta", kind: "id", source: "herdr:letta", value: "../../etc" },
      { agent: "letta", kind: "id", source: "herdr:letta", value: ".." },
      { agent: "letta", kind: "id", source: "herdr:letta", value: "default:.." },
      { agent: "letta", kind: "id", source: "herdr:letta", value: "default:" },
      { agent: "letta", kind: "id", source: "herdr:letta", value: "default" },
    ]) expect(lettaSessionOf({ ...base, agent_session } as HerdrPane)).toBeNull();
    expect(lettaSessionOf(pane("w1:p1", null, root))).toBeNull();
  });

  test("Letta's record speaks for the pane's process only when it is older than that process", () => {
    const reported = (cwd: string) => pane("w1:p1", "local-conv-1", cwd);
    const path = lettaTranscriptPath(join(root, ".letta", "transcripts"), AGENT, "local-conv-1");
    // the process resumed the conversation the record names, so it wrote nothing
    let owner = setup(settingsAfterNew, now - 60_000, now);
    expect(lettaTranscriptFor(reported(owner.cwd), [reported(owner.cwd)], owner)).toEqual({ path, session: "local-conv-1", agent: AGENT, conversation: "local-conv-1" });
    // any write since: its own start on another conversation, its /new, or another letta
    // a file system that keeps whole seconds (HFS+) or two (FAT) puts a write just after the start up to two seconds before it
    for (const at of [now - 1_999, now - 999, now, now + 1, now + 2_000, now + 600_000]) {
      owner = setup(settingsAfterNew, at, now);
      expect(lettaTranscriptFor(reported(owner.cwd), [reported(owner.cwd)], owner)).toBeNull();
    }
  });

  test("a record Letta cannot rewrite binds nothing: its switch would fail and leave the old one standing", () => {
    const owner = setup(settingsAfterNew, now - 60_000, now);
    const target = pane("w1:p1", "local-conv-1", owner.cwd);
    expect(lettaTranscriptFor(target, [target], owner)).not.toBeNull();
    chmodSync(join(owner.cwd, ".letta", "settings.local.json"), 0o444);
    expect(lettaTranscriptFor(target, [target], owner)).toBeNull();
  });

  test("a letta process is bound only in the folder it started in, and never again once seen elsewhere", () => {
    const start = join(root, "project1");
    const other = join(root, "project2");
    mkdirSync(start); mkdirSync(other);
    symlinkSync(start, join(root, "link1"));
    const at = (pid: number, cwd: string, env: Record<string, string>): LettaProcess => ({ pid, cwd, startedAt: now, env });
    expect(lettaInStartFolder(at(101, start, { PWD: start }))).toBe(true);
    expect(lettaInStartFolder(at(102, start, { PWD: join(root, "link1") }))).toBe(true);
    // no start folder to compare: its shell set no PWD
    expect(lettaInStartFolder(at(103, start, {}))).toBe(false);
    expect(lettaInStartFolder(at(104, start, { PWD: "relative" }))).toBe(false);
    // SetWorkingDirectory moved it into project2; a later move back does not make project1's record its own again
    expect(lettaInStartFolder(at(105, other, { PWD: start }))).toBe(false);
    expect(lettaInStartFolder(at(105, start, { PWD: start }))).toBe(false);
  });

  test("a closed peer of the same agent that reopened the pane's old conversation binds nothing", () => {
    // A started on local-conv-1 (herdr keeps that report), switched to local-conv-2; B opened local-conv-1 and closed.
    // Every write was A's own or B's after A started, and the record names local-conv-1 again.
    const owner = setup(JSON.stringify({ sessionsByServer: { local: { agentId: AGENT, conversationId: "local-conv-1" } } }), now + 4_000, now);
    const store = join(root, ".letta", "lc-local-backend");
    const folder = join(store, "conversations", Buffer.from("conversation:local-conv-1").toString("base64url"));
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, "conversation.json"), localConversation);
    expect(lettaLocalOwner(store, AGENT, "local-conv-1")).toBe(true);
    const a = pane("w1:p1", "local-conv-1", owner.cwd);
    expect(lettaRecordOwned(a, [a], owner)).toBe(true);
    expect(lettaTranscriptFor(a, [a], owner)).toBeNull();
  });

  test("a missing, malformed or partly unreadable project record binds nothing, whatever the global settings say", () => {
    mkdirSync(join(root, ".letta"), { recursive: true });
    writeFileSync(join(root, ".letta", "settings.json"), settingsAfterNew);
    for (const settings of [null, "{", "[]", JSON.stringify({ sessionsByServer: { a: { agentId: AGENT, conversationId: "local-conv-1" }, b: { agentId: 3 } } })]) {
      rmSync(join(root, "proj"), { recursive: true, force: true });
      const owner = setup(settings, now - 60_000, now);
      expect(lettaTranscriptFor(pane("w1:p1", "local-conv-1", owner.cwd), [], owner)).toBeNull();
    }
  });

  test("the transcript is where the pane's process keeps it, never where this server would", () => {
    const own = setup(settingsAfterNew, now - 60_000, now, { LETTA_TRANSCRIPT_ROOT: join(root, "elsewhere") });
    const target = pane("w1:p1", "local-conv-1", own.cwd);
    expect(lettaTranscriptFor(target, [target], own)?.path).toBe(lettaTranscriptPath(join(root, "elsewhere"), AGENT, "local-conv-1"));
    expect(lettaTranscriptFor(target, [target], { ...own, env: { HOME: root, LETTA_CONFIG_DIR: join(root, "cfg") } })?.path).toBe(lettaTranscriptPath(join(root, "cfg", "transcripts"), AGENT, "local-conv-1"));
    expect(lettaTranscriptFor(target, [target], { ...own, env: { LETTA_TRANSCRIPT_ROOT: "relative" } })).toBeNull();
    expect(lettaTranscriptFor(target, [target], { ...own, env: {} })).toBeNull();
    expect(lettaTranscriptFor(target, [target, pane("w2:p1", "local-conv-1", own.cwd)], own)).toBeNull();
  });

  test("the record speaks for nobody in the home folder, or while another pane runs Letta in the same folder", () => {
    const owner = setup(settingsAfterNew, now - 60_000, now);
    const target = pane("w1:p1", "local-conv-1", owner.cwd);
    expect(lettaRecordOwned(target, [target], owner)).toBe(true);
    // Letta with LETTA_CONFIG_DIR never rewrites ~/.letta/settings.local.json: an old one there is no record of this process
    expect(lettaRecordOwned(target, [target], { ...owner, cwd: root, env: { HOME: root, LETTA_CONFIG_DIR: join(root, "cfg") } })).toBe(false);
    expect(lettaRecordOwned(target, [target], { ...owner, cwd: root })).toBe(false);
    expect(lettaRecordOwned(target, [target], { ...owner, env: {} })).toBe(false);
    // pane B reported default:agent-b, then /new wrote its own local-conv-1 into the shared record
    symlinkSync(owner.cwd, join(root, "link"));
    const peer = { ...pane("w2:p1", "default:agent-local-b", join(root, "link")), cwd: join(root, "elsewhere") } as HerdrPane;
    expect(lettaRecordOwned(target, [target, peer], owner)).toBe(false);
    expect(lettaRecordOwned(target, [target, { ...peer, agent: "letta", agent_session: undefined } as HerdrPane], owner)).toBe(false);
    expect(lettaRecordOwned(target, [target, { ...peer, agent: "claude", agent_session: undefined } as HerdrPane], owner)).toBe(true);
    expect(lettaRecordOwned(target, [target, pane("w3:p1", "conv-x", root)], owner)).toBe(true);
  });

  test("a local conversation binds only to the agent the process's own store names for it", () => {
    const store = join(root, "store");
    const folder = join(store, "conversations", Buffer.from("conversation:local-conv-1").toString("base64url"));
    expect(lettaLocalOwner(store, AGENT, "local-conv-1")).toBe(false);
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, "conversation.json"), localConversation);
    expect(lettaLocalOwner(store, AGENT, "local-conv-1")).toBe(true);
    // pane B's agent ran /new and left its own record naming local-conv-1: the store says whose it is
    expect(lettaLocalOwner(store, "agent-local-b", "local-conv-1")).toBe(false);
    writeFileSync(join(folder, "conversation.json"), "{");
    expect(lettaLocalOwner(store, AGENT, "local-conv-1")).toBe(false);
    expect(lettaLocalOwner(store, AGENT, "conv-0d9d5c5e-3c3a-4a51-9d0c-1f5f2c1b7a11")).toBe(true);
    expect(lettaLocalOwner(store, AGENT, "default")).toBe(true);
  });

  test("a local conversation's model and effort are its own, else its agent's, as Letta runs the turn", () => {
    const store = join(root, "store");
    const record = (key: string, body: unknown): void => {
      const folder = join(store, "conversations", Buffer.from(key).toString("base64url"));
      mkdirSync(folder, { recursive: true });
      writeFileSync(join(folder, "conversation.json"), JSON.stringify(body));
    };
    // the shapes letta-code 0.34.31's local backend writes: an agent record, and a conversation
    // whose `model` / `model_settings` are set only once `/model` changes them in that conversation
    mkdirSync(join(store, "agents"), { recursive: true });
    writeFileSync(join(store, "agents", `${Buffer.from(AGENT).toString("base64url")}.json`), JSON.stringify({
      id: AGENT, name: "Protos", model: "claude-mimosa/claude-opus-5-5",
      model_settings: { provider_type: "claude-mimosa", reasoning: { reasoning_effort: "high" }, context_window_limit: 1000000 },
    }));
    expect(lettaLocalSettings(store, AGENT, "local-conv-1")).toBeNull();

    // no override: the agent's model and effort
    record("conversation:local-conv-1", JSON.parse(localConversation));
    expect(lettaLocalSettings(store, AGENT, "local-conv-1")).toEqual({ model: "claude-mimosa/claude-opus-5-5", reasoning_effort: "high" });
    // /model in this conversation: its own model and settings win
    record("conversation:local-conv-1", { ...JSON.parse(localConversation), model: "claude-ing/claude-sonnet-5-5",
      model_settings: { provider_type: "claude-ing", reasoning: { reasoning_effort: "medium" }, reasoning_effort: "medium" } });
    expect(lettaLocalSettings(store, AGENT, "local-conv-1")).toEqual({ model: "claude-ing/claude-sonnet-5-5", reasoning_effort: "medium" });
    // an effort set alone keeps the agent's model
    record("conversation:local-conv-1", { ...JSON.parse(localConversation), model_settings: { reasoning: { reasoning_effort: "low" } } });
    expect(lettaLocalSettings(store, AGENT, "local-conv-1")).toEqual({ model: "claude-mimosa/claude-opus-5-5", reasoning_effort: "low" });
    // Letta reads the nested effort first (reasoningForSettings): a top-level one beside it changes nothing
    record("conversation:local-conv-1", { ...JSON.parse(localConversation), model_settings: { reasoning_effort: "low" } });
    expect(lettaLocalSettings(store, AGENT, "local-conv-1")).toEqual({ model: "claude-mimosa/claude-opus-5-5", reasoning_effort: "high" });
    // the default conversation is keyed with its agent
    record(`default:${AGENT}`, { id: "default", agent_id: AGENT });
    expect(lettaLocalSettings(store, AGENT, "default")).toEqual({ model: "claude-mimosa/claude-opus-5-5", reasoning_effort: "high" });

    // a cloud conversation's settings are on the server; a record of another agent or a broken one names nothing
    expect(lettaLocalSettings(store, AGENT, "conv-0d9d5c5e-3c3a-4a51-9d0c-1f5f2c1b7a11")).toBeNull();
    expect(lettaLocalSettings(store, "agent-local-b", "local-conv-1")).toBeNull();
    writeFileSync(join(store, "conversations", Buffer.from("conversation:local-conv-1").toString("base64url"), "conversation.json"), "{");
    expect(lettaLocalSettings(store, AGENT, "local-conv-1")).toBeNull();
  });

  /** Letta's local store under `root`: an agent record and conversation records, by the keys Letta derives. */
  const store = () => join(root, "store");
  const agentRecord = (body: unknown): string => {
    mkdirSync(join(store(), "agents"), { recursive: true });
    const path = join(store(), "agents", `${Buffer.from(AGENT).toString("base64url")}.json`);
    if (body !== null) writeFileSync(path, JSON.stringify(body));
    return path;
  };
  const conversationRecord = (key: string, body: unknown): string => {
    const folder = join(store(), "conversations", Buffer.from(key).toString("base64url"));
    mkdirSync(folder, { recursive: true });
    if (body !== null) writeFileSync(join(folder, "conversation.json"), JSON.stringify(body));
    return join(folder, "conversation.json");
  };

  test("an Anthropic or Bedrock agent's effort is read from `effort`, where Letta writes it, before `reasoning_effort`", () => {
    // buildModelSettings in letta-code 0.34.23 for an anthropic/ handle
    agentRecord({ id: AGENT, model: "anthropic/claude-sonnet-4-5", model_settings: { provider_type: "anthropic", effort: "high" } });
    conversationRecord("conversation:local-conv-1", JSON.parse(localConversation));
    expect(lettaLocalSettings(store(), AGENT, "local-conv-1")).toEqual({ model: "anthropic/claude-sonnet-4-5", reasoning_effort: "high" });
    conversationRecord("conversation:local-conv-1", { ...JSON.parse(localConversation), model_settings: { reasoning_effort: "low" } });
    expect(lettaLocalSettings(store(), AGENT, "local-conv-1")).toEqual({ model: "anthropic/claude-sonnet-4-5", reasoning_effort: "high" });
  });

  test("a local conversation's settings come only from the record whose own id it is", () => {
    agentRecord({ id: AGENT, model: "base-model" });
    conversationRecord("conversation:local-conv-1", { ...JSON.parse(localConversation), id: "local-conv-9", model: "other" });
    expect(lettaLocalSettings(store(), AGENT, "local-conv-1")).toBeNull();
    conversationRecord("conversation:local-conv-1", { ...JSON.parse(localConversation), model: "own" });
    expect(lettaLocalSettings(store(), AGENT, "local-conv-1")).toEqual({ model: "own", reasoning_effort: null });
  });

  test("a store record reached through a link is not read", () => {
    writeFileSync(join(root, "outside.json"), JSON.stringify({ id: AGENT, model: "from-outside" }));
    symlinkSync(join(root, "outside.json"), agentRecord(null));
    const own = conversationRecord("conversation:local-conv-1", JSON.parse(localConversation));
    expect(lettaLocalSettings(store(), AGENT, "local-conv-1")).toBeNull();
    rmSync(agentRecord(null));
    agentRecord({ id: AGENT, model: "base-model" });
    // the default conversation's record linked to another conversation's
    symlinkSync(own, conversationRecord(`default:${AGENT}`, null));
    expect(lettaLocalSettings(store(), AGENT, "default")).toBeNull();
    writeFileSync(join(root, "conversation.json"), localConversation);
    rmSync(own);
    symlinkSync(join(root, "conversation.json"), own);
    expect(lettaLocalOwner(store(), AGENT, "local-conv-1")).toBe(false);
    expect(lettaLocalSettings(store(), AGENT, "local-conv-1")).toBeNull();
  });

  test.skipIf(process.platform === "win32")("a FIFO where Letta keeps a record is not waited on", () => {
    const own = conversationRecord("conversation:local-conv-1", JSON.parse(localConversation));
    const base = agentRecord(null);
    // a FIFO with no writer blocks a plain open: the reads run in a child, so a hang fails this test, not the run
    const probe = (): unknown => {
      const module = JSON.stringify(join(import.meta.dir, "letta-store.ts"));
      const child = spawnSync(process.execPath, ["-e", `import { lettaLocalOwner, lettaLocalSettings } from ${module};
        console.log(JSON.stringify([lettaLocalOwner(${JSON.stringify(store())}, ${JSON.stringify(AGENT)}, "local-conv-1"), lettaLocalSettings(${JSON.stringify(store())}, ${JSON.stringify(AGENT)}, "local-conv-1")]));`],
      { encoding: "utf8", timeout: 5000 });
      expect(child.signal).toBeNull();
      return JSON.parse(child.stdout);
    };
    expect(spawnSync("mkfifo", [base]).status).toBe(0);
    expect(probe()).toEqual([true, null]);
    rmSync(own);
    expect(spawnSync("mkfifo", [own]).status).toBe(0);
    expect(probe()).toEqual([false, null]);
  }, 15_000);

  test("a Letta pane's chat shows the store's model and effort, and its ETag follows them with no append", async () => {
    const path = join(root, "transcript.jsonl");
    writeFileSync(path, newLog);
    agentRecord({ id: AGENT, model: "anthropic/claude-sonnet-4-5", model_settings: { provider_type: "anthropic", effort: "high" } });
    const own = conversationRecord("conversation:local-conv-1", JSON.parse(localConversation));
    const target = pane("w1:p1", "local-conv-1", root);
    const resolution = spyOn(lettaStore, "resolveLettaTranscript").mockResolvedValue({ path, session: "local-conv-1", agent: AGENT, conversation: "local-conv-1", store: store() });
    const snapshot = spyOn(herdr, "sessionSnapshot").mockResolvedValue({ panes: [target], agents: [], workspaces: [], tabs: [], layouts: [], version: "fixture", protocol: 22 } as never);
    const info = spyOn(herdr, "paneProcessInfo").mockResolvedValue({ pane_id: target.pane_id, foreground_processes: [] } as never);
    const rpc = spyOn(herdr, "herdrRpc").mockImplementation(async () => ({}) as never);
    try {
      const cached = transcriptPage("letta-transcript", path);
      const first = await paneConversation(target.pane_id);
      expect(first.metadata).toMatchObject({ model: "anthropic/claude-sonnet-4-5", reasoning_effort: "high" });
      expect((await paneConversation(target.pane_id)).version).toBe(first.version);
      // /model in the conversation writes its record, not the transcript
      conversationRecord("conversation:local-conv-1", { ...JSON.parse(localConversation), model: "anthropic/claude-opus-4-5", model_settings: { effort: "low" } });
      const second = await paneConversation(target.pane_id);
      expect(second.metadata).toMatchObject({ model: "anthropic/claude-opus-4-5", reasoning_effort: "low" });
      expect(second.version).not.toBe(first.version);
      expect(first.metadata).toMatchObject({ model: "anthropic/claude-sonnet-4-5", reasoning_effort: "high" });
      // the shared transcript page is never enriched
      expect(cached.metadata).toMatchObject({ model: null, reasoning_effort: null });
      expect(transcriptPage("letta-transcript", path)).toEqual(cached);
      // a record that does not read leaves the transcript's own answer
      writeFileSync(own, "{");
      const third = await paneConversation(target.pane_id);
      expect(third.metadata).toMatchObject({ model: null, reasoning_effort: null });
      expect(new Set([first.version, second.version, third.version]).size).toBe(3);
    } finally {
      rpc.mockRestore();
      info.mockRestore();
      snapshot.mockRestore();
      resolution.mockRestore();
    }
  });

  test("only a regular file at the path Letta derives is read, never one reached through a link", () => {
    const transcripts = join(root, "transcripts");
    const path = lettaTranscriptPath(transcripts, AGENT, "local-conv-1");
    expect(lettaTranscriptHeld(path, transcripts)).toBe(false);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(join(root, "other.jsonl"), defaultLog);
    symlinkSync(join(root, "other.jsonl"), path);
    expect(lettaTranscriptHeld(path, transcripts)).toBe(false);
    rmSync(path);
    symlinkSync(join(root, "loop"), join(root, "loop"));
    symlinkSync(join(root, "loop"), path);
    expect(lettaTranscriptHeld(path, transcripts)).toBe(false);
    rmSync(path);
    writeFileSync(path, newLog);
    expect(lettaTranscriptHeld(path, transcripts)).toBe(true);
    rmSync(join(transcripts, AGENT), { recursive: true });
    mkdirSync(join(root, "real", "local-conv-1"), { recursive: true });
    writeFileSync(join(root, "real", "local-conv-1", "transcript.jsonl"), newLog);
    symlinkSync(join(root, "real"), join(transcripts, AGENT));
    expect(lettaTranscriptHeld(path, transcripts)).toBe(false);
  });

  test("a bound pane reads the transcript its letta process keeps; without one, or unbound, it uses Terminal", async () => {
    const project = join(root, "proj");
    mkdirSync(join(project, ".letta"), { recursive: true });
    writeFileSync(join(project, ".letta", "settings.local.json"), settingsAfterNew);
    // written before the pane's letta started, as Letta leaves it when it resumes that conversation
    utimesSync(join(project, ".letta", "settings.local.json"), (Date.now() - 60_000) / 1000, (Date.now() - 60_000) / 1000);
    const config = join(root, "config");
    // a real process whose own environment names the store, as the pane's letta would
    const child = Bun.spawn(["sleep", "300"], { env: { HOME: root, PWD: project, LETTA_CONFIG_DIR: config, PATH: process.env["PATH"] ?? "" }, cwd: project });
    // the same process after SetWorkingDirectory moved it from project1 into this project: its environment keeps project1
    mkdirSync(join(root, "project1"));
    const movedIn = Bun.spawn(["sleep", "300"], { env: { HOME: root, PWD: join(root, "project1"), LETTA_CONFIG_DIR: config, PATH: process.env["PATH"] ?? "" }, cwd: project });
    let foreground = child.pid;
    const info = spyOn(herdr, "paneProcessInfo").mockImplementation(async () => ({
      pane_id: "w1:p1", foreground_processes: [{ pid: foreground, argv: ["node", "/opt/letta/bin/letta"], cwd: project }],
    }) as never);
    const rpc = spyOn(herdr, "herdrRpc").mockImplementation(async () => ({}) as never);
    const resolve = (target: HerdrPane) => paneTranscript(target.pane_id, undefined, { panes: [target] } as SessionSnapshot);
    try {
      const bound = pane("w1:p1", "local-conv-1", project);
      const path = lettaTranscriptPath(join(config, "transcripts"), AGENT, "local-conv-1");
      // a conversation with no file here may have turns elsewhere: the terminal shows them
      await expect(resolve(bound)).rejects.toThrow("no_session_path");
      mkdirSync(join(path, ".."), { recursive: true });
      writeFileSync(path, newLog);
      // the store has no record that local-conv-1 is this agent's
      await expect(resolve(bound)).rejects.toThrow("no_session_path");
      const record = join(config, "lc-local-backend", "conversations", Buffer.from("conversation:local-conv-1").toString("base64url"));
      mkdirSync(record, { recursive: true });
      writeFileSync(join(record, "conversation.json"), localConversation);
      expect(await resolve(bound)).toEqual({ source: "letta-transcript", path,
        letta: { store: join(config, "lc-local-backend"), agent: AGENT, conversation: "local-conv-1" } });
      await expect(resolve(pane("w1:p1", `default:${AGENT}`, project))).rejects.toThrow("no_session_path");
      await expect(resolve(pane("w1:p1", null, project))).rejects.toThrow("no_session_path");
      // another pane running Letta in the folder writes the same record
      // project1 -> /new -> moved into this project, whose older record names the conversation it left
      foreground = movedIn.pid;
      await expect(resolve(bound)).rejects.toThrow("no_session_path");
      foreground = child.pid;
      expect(await resolve(bound)).toEqual({ source: "letta-transcript", path,
        letta: { store: join(config, "lc-local-backend"), agent: AGENT, conversation: "local-conv-1" } });
      const peer = pane("w2:p1", "default:agent-local-b", project);
      await expect(paneTranscript(bound.pane_id, undefined, { panes: [bound, peer] } as SessionSnapshot)).rejects.toThrow("no_session_path");
    } finally {
      info.mockRestore();
      rpc.mockRestore();
      child.kill();
      movedIn.kill();
      await Promise.all([child.exited, movedIn.exited]);
    }
  });
});
