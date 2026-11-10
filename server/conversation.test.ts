import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as darwinProcess from "./darwin-process.ts";
import { Database } from "bun:sqlite";
import { appendFileSync, copyFileSync, linkSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { basename, join, win32 } from "node:path";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as cmd from "./cmd.ts";
import * as piTree from "./pi-tree.ts";
import type { HerdrPane, SessionSnapshot } from "../shared/protocol.ts";
import { MAX_TURNS, parseOmpTranscript } from "./transcript-records.ts";
import { turnStarts } from "./transcript-turns.ts";
import { claudeImageType } from "./claude-transcript.ts";
import { toolVerb } from "../src/lib/toolVerbs.ts";
import { continuesHistory } from "../src/lib/chatRows.ts";
import type { ConversationTurn } from "../shared/protocol.ts";
import { agyCatalog, agyToolOutput, parseAgyTranscript } from "./agy.ts";
import * as filePool from "./file-pool.ts";
import { agyStoreFromLocks } from "./agy-store.ts";
import * as agyStore from "./agy-store.ts";
import * as herdr from "./herdr/client.ts";
import { forgetHistoryChains } from "./codex.ts";
import { DevinHistoryChanged } from "./devin.ts";
import * as devinSession from "./devin-session.ts";
import * as omo from "./omo.ts";
import * as gjcRuntime from "./gjc-runtime.ts";
import * as runtime from "./herdr-core/runtime.ts";
import * as served from "./runtime/capabilities.ts";
import { HERDR_CORE } from "./runtime/capabilities.ts";
import { claudeProjectDir } from "./claude-store.ts";
import { launchedAgents } from "./launched-agents.ts";
import { agyTranscriptPage, claudePanePid, claudePaneSession, ConversationReadPending, ConversationUnavailable, devinSessionForPane, forgetPaneTranscriptState, forgetTranscriptState, gjcTranscriptPath, HistoryChanged, isDevinProcess, isOmoProcess, ompSessionStore, paneConversation, paneProcessRoots, paneTranscript, parseClaudeTranscript, unwrapPastes, toolOutput, transcriptImage, transcriptImageAsync, transcriptPage, transcriptToolOutput, TRANSCRIPT_WINDOW_BYTES } from "./conversation.ts";

it("labels only Claude's explicit end_turn text as final-answer evidence", () => {
  const entry = (stop_reason: string | null) => JSON.stringify({ type: "assistant", message: { role: "assistant", stop_reason, content: [{ type: "text", text: "Answer" }] } });
  expect(parseClaudeTranscript(entry(null))[0]?.parts).toEqual([{ kind: "text", text: "Answer" }]);
  expect(parseClaudeTranscript(entry("tool_use"))[0]?.parts).toEqual([{ kind: "text", text: "Answer" }]);
  expect(parseClaudeTranscript(entry("end_turn"))[0]?.parts).toEqual([{ kind: "text", text: "Answer", phase: "final_answer" }]);
});

it("keeps a cached pre-final Claude page distinct from its appended final answer", () => {
  const dir = mkdtempSync(join(tmpdir(), "claude-finish-proof-"));
  const file = join(dir, "session.jsonl");
  const record = (stop_reason: string | null, text: string) => JSON.stringify({
    type: "assistant", timestamp: "2026-10-19T01:00:00Z",
    message: { role: "assistant", stop_reason, content: [{ type: "text", text }] },
  }) + "\n";
  try {
    writeFileSync(file, record(null, "Partial answer"));
    const before = transcriptPage("claude-transcript", file);
    expect(before.turns.at(-1)?.parts.at(-1)).toEqual({ kind: "text", text: "Partial answer" });
    expect(transcriptPage("claude-transcript", file).turns).toEqual(before.turns);
    appendFileSync(file, record("end_turn", "Final answer"));
    expect(transcriptPage("claude-transcript", file).turns.at(-1)?.parts.at(-1))
      .toEqual({ kind: "text", text: "Final answer", phase: "final_answer" });
    expect(before.turns.at(-1)?.parts.at(-1)).toEqual({ kind: "text", text: "Partial answer" });
  } finally { forgetTranscriptState(); rmSync(dir, { recursive: true, force: true }); }
});

it("says the transcript file's size on the newest page only, and again once it grows", () => {
  const dir = mkdtempSync(join(tmpdir(), "transcript-bytes-"));
  const file = join(dir, "session.jsonl");
  const record = (type: "user" | "assistant", text: string) => JSON.stringify({
    type, timestamp: "2026-10-19T01:00:00Z", message: { role: type, content: [{ type: "text", text }] },
  }) + "\n";
  try {
    writeFileSync(file, record("user", "first ask") + record("assistant", "x".repeat(TRANSCRIPT_WINDOW_BYTES)) + record("user", "next ask"));
    const newest = transcriptPage("claude-transcript", file);
    expect(newest.transcript_bytes).toBe(fs.statSync(file).size);
    appendFileSync(file, record("assistant", "next answer"));
    expect(transcriptPage("claude-transcript", file).transcript_bytes).toBe(fs.statSync(file).size);
    expect(newest.cursor).not.toBeNull();
    expect(transcriptPage("claude-transcript", file, { before: newest.cursor! }).transcript_bytes).toBeUndefined();
  } finally { forgetTranscriptState(); rmSync(dir, { recursive: true, force: true }); }
});

describe("omo skill roots", () => {
  it("finds the bundled plugin from a Windows canonical launcher path", async () => {
    const canonical = win32.join("C:\\Users\\demo", "node_modules", "omo-ai", "dist", "cli.js");
    const directory = fs.statSync(import.meta.dir);
    const rpc = spyOn(herdr, "herdrRpc").mockResolvedValue({
      process_info: { foreground_processes: [{ pid: -1, argv: ["node", "/install/omo-ai/dist/cli.js"] }] },
    });
    const realpath = spyOn(fs, "realpathSync").mockReturnValue(canonical);
    const stat = spyOn(fs, "statSync").mockReturnValue(directory);
    try {
      const roots = await paneProcessRoots("omo-windows-fixture", "pi");
      expect(roots.omo?.pluginDir).toBe(win32.join(win32.dirname(win32.dirname(canonical)), "plugin"));
    } finally {
      stat.mockRestore();
      realpath.mockRestore();
      rpc.mockRestore();
    }
  });

  it("keeps the agent directory already resolved by process identity when cwd is missing", async () => {
    const agentDir = import.meta.dir;
    const rpc = spyOn(herdr, "herdrRpc").mockResolvedValue({
      process_info: { foreground_processes: [{ pid: -1, argv: ["omo"] }] },
    });
    const identity = spyOn(omo, "omoProcessIdentity").mockReturnValue({ agentDir, heldIds: [], custom: false, held: false });
    try {
      expect((await paneProcessRoots("omo-cwd-fixture", "omo")).omo?.agentDir).toBe(agentDir);
    } finally {
      identity.mockRestore();
      rpc.mockRestore();
    }
  });
});

describe("pane process roots", () => {
  it("binds an omo pane to the omo process holding a session, not an omo-looking one listed before it", async () => {
    const rpc = spyOn(herdr, "herdrRpc").mockResolvedValue({
      process_info: { foreground_processes: [
        { pid: 301, argv: ["/install/omo-ai/node_modules/claude-sdk/cli.js"], cwd: "/repo" },
        { pid: 302, argv: ["omo"], cwd: "/repo" },
      ] },
    });
    const identity = spyOn(omo, "omoProcessIdentity").mockImplementation((process) =>
      ({ agentDir: "/fixture-agent", heldIds: process.pid === 302 ? ["sess-1"] : [], custom: false, held: process.pid === 302 }));
    const environ = spyOn(omo, "processEnviron").mockReturnValue(null);
    try {
      const roots = await paneProcessRoots("omo-held-fixture", "claude");
      expect(roots.pid).toBe(302);
      expect(roots.omo?.held).toBeTrue();
      // with none held, the first omo process still answers, unheld, as before
      identity.mockImplementation(() => ({ agentDir: "/fixture-agent", heldIds: [], custom: false, held: false }));
      expect(await paneProcessRoots("omo-held-fixture", "claude")).toMatchObject({ pid: 301, omo: { held: false } });
    } finally {
      environ.mockRestore();
      identity.mockRestore();
      rpc.mockRestore();
    }
  });

  for (const agent of ["claude", "codex", "omp", "gjc", "pi", "opencode", "devin", "grok", "hermes", "agy", "letta"]) {
    it(`reads ${agent}'s environment from its foreground executable`, async () => {
      const rpc = spyOn(herdr, "herdrRpc").mockResolvedValue({
        process_info: { foreground_processes: [
          { pid: 101, argv: ["sh", "-c", agent], cwd: "/shell" },
          { pid: 102, argv: [`C:\\tools\\${agent}.exe`], cwd: "/agent" },
        ] },
      });
      const identity = spyOn(omo, "omoProcessIdentity").mockReturnValue(null);
      const environ = spyOn(omo, "processEnviron").mockReturnValue(["AGENT_HOME=/fixture"]);
      try {
        expect(await paneProcessRoots("process-fixture", agent)).toMatchObject({
          omo: null, environ: ["AGENT_HOME=/fixture"], pid: 102, cwd: "/agent",
        });
        expect(rpc).toHaveBeenCalledTimes(1);
        expect(rpc).toHaveBeenCalledWith("pane.process_info", { pane_id: "process-fixture" });
        expect(environ).toHaveBeenCalledWith(102);
      } finally {
        environ.mockRestore();
        identity.mockRestore();
        rpc.mockRestore();
      }
    });
  }

  it("matches a runtime launcher but never an agent name in unrelated arguments", async () => {
    const rpc = spyOn(herdr, "herdrRpc").mockResolvedValue({
      process_info: { foreground_processes: [
        { pid: 101, argv: ["echo", "codex"] },
        { pid: 102, argv: ["node", "/tools/codex.js"], cwd: "/repo" },
      ] },
    });
    const identity = spyOn(omo, "omoProcessIdentity").mockReturnValue(null);
    const environ = spyOn(omo, "processEnviron").mockReturnValue(null);
    try {
      expect((await paneProcessRoots("runtime-fixture", "codex")).pid).toBe(102);
      expect(await paneProcessRoots("runtime-fixture", "claude")).toMatchObject({ omo: null, environ: null, pid: null, cwd: null });
    } finally {
      environ.mockRestore();
      identity.mockRestore();
      rpc.mockRestore();
    }
  });

  it("reads an npm Codex's roots from its native child, not the node launcher listed before it", async () => {
    const rpc = spyOn(herdr, "herdrRpc").mockResolvedValue({
      process_info: { foreground_processes: [
        { pid: 201, argv: ["node", "/tools/bin/codex"], cwd: "/launcher" },
        { pid: 202, argv: ["/tools/vendor/x86_64-unknown-linux-musl/bin/codex"], cwd: "/native" },
      ] },
    });
    const identity = spyOn(omo, "omoProcessIdentity").mockReturnValue(null);
    const environ = spyOn(omo, "processEnviron").mockReturnValue(["CODEX_HOME=/fixture"]);
    try {
      expect(await paneProcessRoots("launcher-fixture", "codex")).toMatchObject({ pid: 202, cwd: "/native", environ: ["CODEX_HOME=/fixture"] });
      expect(environ).toHaveBeenCalledWith(202);
    } finally {
      environ.mockRestore();
      identity.mockRestore();
      rpc.mockRestore();
    }
  });

  it("returns no process roots when the process probe fails", async () => {
    const rpc = spyOn(herdr, "herdrRpc").mockRejectedValue(new Error("fixture unavailable"));
    try {
      expect(await paneProcessRoots("missing-fixture", "pi")).toEqual({ omo: null, environ: null, pid: null, cwd: null });
    } finally { rpc.mockRestore(); }
  });
});

let mockedPanes: HerdrPane[] = [];
let mockedProcesses: { argv?: unknown }[] = [];

describe("Devin pane identity", () => {
  const restores: Array<() => void> = [];
  beforeEach(() => {
    const rpc = spyOn(herdr, "herdrRpc").mockImplementation(async (method: string) => {
      if (method !== "pane.process_info") throw new Error(`unexpected conversation fixture RPC: ${method}`);
      return { process_info: { foreground_processes: mockedProcesses.map((process) => ({ ...process, pid: 2147483647 })) } } as never;
    });
    restores.push(() => rpc.mockRestore());
    const proof = spyOn(devinSession, "devinLockProof").mockImplementation(() => {
      const report = mockedPanes[0]?.agent_session;
      const args = mockedProcesses[0]?.argv;
      const resumed = Array.isArray(args) && typeof args[1] === "string" && args[1].startsWith("--resume=") ? args[1].slice(9) : undefined;
      const id = report?.agent === "devin" && report.kind === "id" && typeof report.value === "string" ? report.value : resumed;
      if (!id) throw new ConversationUnavailable("no_session_id");
      return { session: id, binding: id };
    });
    restores.push(() => proof.mockRestore());
    const snapshot = spyOn(herdr, "sessionSnapshot").mockImplementation(async () => ({ panes: mockedPanes } as SessionSnapshot));
    restores.push(() => snapshot.mockRestore());
  });
  afterEach(() => {
    for (const restore of restores.splice(0)) restore();
    mockedPanes = [];
    mockedProcesses = [];
    forgetTranscriptState();
  });
  const pane = { pane_id: "pane-a", cwd: "/synthetic/work", agent: "devin" } as HerdrPane;
  const shell = { pane_id: "pane-b", cwd: pane.cwd, agent_session: { agent: "devin", kind: "id", value: "stale" } } as HerdrPane;
  const peer = { pane_id: "pane-b", cwd: pane.cwd, agent: "devin" } as HerdrPane;
  const reported = { ...pane, agent_session: { agent: "devin", kind: "id", value: "one" } } as HerdrPane;
  it("never guesses a session from its directory or a stale shell agent_session", () => {
    expect(() => devinSessionForPane(pane, [pane], ["/bin/devin"])).toThrow(ConversationUnavailable);
    expect(() => devinSessionForPane(shell, [shell], ["/bin/devin", "--resume", "stale"])).toThrow(ConversationUnavailable);
  });
  it("names a fresh or continued session with no lock and no reported id as unverified, not a missing id", () => {
    for (const argv of [["/bin/devin"], ["/bin/devin", "--continue"]]) {
      expect(() => devinSessionForPane(pane, [pane, peer], argv)).toThrow(expect.objectContaining({
        message: "no_session_id", diagnostic: "devin_current_session_unverified",
      }));
    }
    expect(() => devinSessionForPane(pane, [pane], ["/bin/devin", "--resume"])).toThrow(expect.objectContaining({ diagnostic: undefined }));
  });
  it("accepts only an exact reported or resumed identity and does not consider shell peers", () => {
    expect(devinSessionForPane(reported, [reported, shell], ["/bin/devin"])).toBe("one");
    expect(devinSessionForPane(pane, [pane, shell], ["/bin/devin", "--resume=two"])).toBe("two");
    expect(() => devinSessionForPane(reported, [reported], ["/bin/devin", "--resume", "two"])).toThrow(ConversationUnavailable);
    expect(() => devinSessionForPane(reported, [reported], ["/bin/devin", "--resume=one", "-r", "two"])).toThrow(ConversationUnavailable);
    expect(() => devinSessionForPane(reported, [reported, { ...peer, agent_session: reported.agent_session }], ["/bin/devin"])).toThrow(ConversationUnavailable);
    expect(() => devinSessionForPane(pane, [pane], ["/bin/devin", "--", "--resume", "one"])).toThrow(ConversationUnavailable);
    expect(() => devinSessionForPane(pane, [pane], ["/bin/devin", "--resume"])).toThrow(ConversationUnavailable);
  });
  it("recognizes only Devin as the executable, not another argument", () => {
    expect(isDevinProcess(["/usr/bin/devin"])).toBeTrue();
    expect(isDevinProcess(["C:\\tools\\devin.exe"])).toBeTrue();
    expect(isDevinProcess(["node", "/tmp/devin"])).toBeFalse();
    expect(isDevinProcess(["sh", "-c", "devin --resume one"])).toBeFalse();
    expect(isDevinProcess(["/usr/bin/not-devin"])).toBeFalse();
  });
  it.skipIf(process.platform !== "linux")("reads a fresh Devin session from its live proof and rejects a session switch during the read", async () => {
    const root = mkdtempSync(join(tmpdir(), "herdr-devin-fresh-"));
    const dbPath = join(root, "sessions.db");
    const cwd = "/synthetic/work";
    const pane = { pane_id: "pane-fresh", cwd, foreground_cwd: cwd, agent: "devin" } as HerdrPane;
    let calls = 0;
    let switchDuringRead = false;
    const proof = spyOn(devinSession, "devinLockProof").mockImplementation((pid, path) => {
      expect(pid).toBe(2147483647);
      expect(path).toBe(dbPath);
      const session = switchDuringRead && calls >= 2 ? "two" : "one";
      calls++;
      return { session, binding: JSON.stringify([pid, session]) };
    });
    try {
      const db = new Database(dbPath);
      try {
        db.exec("CREATE TABLE sessions(id TEXT, working_directory TEXT, main_chain_id INTEGER, hidden INTEGER, model TEXT); CREATE TABLE message_nodes(session_id TEXT,node_id INTEGER,parent_node_id INTEGER,chat_message TEXT,created_at INTEGER); CREATE TABLE tool_call_state(session_id TEXT,tool_call_id TEXT,tool_call_json TEXT,tool_call_update_json TEXT)");
        const insertSession = db.query("INSERT INTO sessions VALUES (?, ?, 2, 0, NULL)");
        const insertNode = db.query("INSERT INTO message_nodes VALUES (?, ?, ?, ?, ?)");
        for (const session of ["one", "two"]) {
          insertSession.run(session, cwd);
          insertNode.run(session, 1, null, JSON.stringify({ role: "user", content: `${session} synthetic question` }), 1700000000);
          insertNode.run(session, 2, 1, JSON.stringify({ role: "assistant", content: `${session} synthetic answer` }), 1700000001);
        }
      } finally { db.close(); }
      mockedPanes = [pane];
      mockedProcesses = [{ argv: ["/usr/local/bin/devin"] }];
      const answer = await paneConversation(pane.pane_id, undefined, {}, dbPath);
      expect(answer.source).toBe("devin-transcript");
      expect(answer.turns.map((turn) => ({ role: turn.role, parts: turn.parts }))).toEqual([
        { role: "user", parts: [{ kind: "text", text: "one synthetic question" }] },
        { role: "assistant", parts: [{ kind: "text", text: "one synthetic answer" }] },
      ]);
      expect(calls).toBe(4);
      calls = 0;
      switchDuringRead = true;
      await expect(paneConversation(pane.pane_id, undefined, {}, dbPath)).rejects.toMatchObject({ name: "ConversationUnavailable", message: "no_session_id" });
      expect(calls).toBe(4);
    } finally {
      proof.mockRestore();
      forgetTranscriptState();
      rmSync(root, { recursive: true, force: true });
    }
  });
  it.skipIf(process.platform !== "linux")("keeps an explicitly named Devin session as chat when its lock cannot be read, and refuses one a read lock contradicts", async () => {
    const root = mkdtempSync(join(tmpdir(), "herdr-devin-explicit-"));
    const dbPath = join(root, "sessions.db");
    const cwd = "/synthetic/work";
    let live: string | null = null;
    const proof = spyOn(devinSession, "devinLockProof").mockImplementation((pid) => {
      if (live === "ambiguous") throw new ConversationUnavailable("no_session_id");
      if (live === null) throw new devinSession.DevinLockMissing();
      return { session: live, binding: JSON.stringify([pid, live]) };
    });
    try {
      const db = new Database(dbPath);
      try {
        db.exec("CREATE TABLE sessions(id TEXT, working_directory TEXT, main_chain_id INTEGER, hidden INTEGER, model TEXT); CREATE TABLE message_nodes(session_id TEXT,node_id INTEGER,parent_node_id INTEGER,chat_message TEXT,created_at INTEGER); CREATE TABLE tool_call_state(session_id TEXT,tool_call_id TEXT,tool_call_json TEXT,tool_call_update_json TEXT)");
        const insertSession = db.query("INSERT INTO sessions VALUES (?, ?, 2, 0, NULL)");
        const insertNode = db.query("INSERT INTO message_nodes VALUES (?, ?, ?, ?, ?)");
        for (const session of ["one", "two"]) {
          insertSession.run(session, cwd);
          insertNode.run(session, 1, null, JSON.stringify({ role: "user", content: `${session} synthetic question` }), 1700000000);
          insertNode.run(session, 2, 1, JSON.stringify({ role: "assistant", content: `${session} synthetic answer` }), 1700000001);
        }
      } finally { db.close(); }
      const firstText = async (paneId: string) => (await paneConversation(paneId, undefined, {}, dbPath)).turns[0]?.parts[0];
      // no lock to read (an older Devin, a symlinked store, no lock taken yet): the named session reads as on main
      const resumed = { pane_id: "pane-resumed", cwd, foreground_cwd: cwd, agent: "devin" } as HerdrPane;
      mockedPanes = [resumed];
      mockedProcesses = [{ argv: ["/usr/local/bin/devin", "--resume=one"] }];
      expect(await firstText(resumed.pane_id)).toEqual({ kind: "text", text: "one synthetic question" });
      const reported = { ...resumed, pane_id: "pane-reported", agent_session: { agent: "devin", kind: "id", value: "two" } } as HerdrPane;
      mockedPanes = [reported];
      mockedProcesses = [{ argv: ["/usr/local/bin/devin"] }];
      expect(await firstText(reported.pane_id)).toEqual({ kind: "text", text: "two synthetic question" });
      // a lock that is read and names another session than --resume refuses: Devin switched inside the app
      live = "two";
      mockedPanes = [resumed];
      mockedProcesses = [{ argv: ["/usr/local/bin/devin", "--resume=one"] }];
      await expect(paneConversation(resumed.pane_id, undefined, {}, dbPath)).rejects.toMatchObject({ name: "ConversationUnavailable", message: "no_session_id" });
      // lock evidence that is read but does not hold up (two locks held) refuses too: no fallback to --resume
      live = "ambiguous";
      await expect(paneConversation(resumed.pane_id, undefined, {}, dbPath)).rejects.toMatchObject({ name: "ConversationUnavailable", message: "no_session_id" });
    } finally {
      proof.mockRestore();
      mockedPanes = [];
      mockedProcesses = [];
      forgetTranscriptState();
      rmSync(root, { recursive: true, force: true });
    }
  });
  it("reads through paneConversation only with live executable and explicit session evidence", async () => {
    const root = mkdtempSync(join(tmpdir(), "herdr-devin-pane-"));
    const dbPath = join(root, "sessions.db");
    const cwd = "/synthetic/work";
    const pane = { pane_id: "pane-a", cwd, foreground_cwd: cwd, agent: "devin", agent_session: { agent: "devin", kind: "id", value: "one" } } as HerdrPane;
    try {
      const db = new Database(dbPath);
      try {
        db.exec("CREATE TABLE sessions(id TEXT, working_directory TEXT, main_chain_id INTEGER, hidden INTEGER, model TEXT); CREATE TABLE message_nodes(session_id TEXT,node_id INTEGER,parent_node_id INTEGER,chat_message TEXT,created_at INTEGER); CREATE TABLE tool_call_state(session_id TEXT,tool_call_id TEXT,tool_call_json TEXT,tool_call_update_json TEXT)");
        db.query("INSERT INTO sessions VALUES ('one', ?, 2, 0, 'synthetic-model')").run(cwd);
        db.query("INSERT INTO message_nodes VALUES ('one', 1, NULL, ?, 1700000000)").run(JSON.stringify({ role: "user", content: "synthetic question" }));
        db.query("INSERT INTO message_nodes VALUES ('one', 2, 1, ?, 1700000001)").run(JSON.stringify({ role: "assistant", content: "synthetic answer" }));
      } finally { db.close(); }
      mockedPanes = [pane];
      mockedProcesses = [{ argv: ["/usr/local/bin/devin"] }];
      const answer = await paneConversation(pane.pane_id, undefined, {}, dbPath);
      expect(answer.source).toBe("devin-transcript");
      expect(answer.turns.map((turn) => turn.parts[0])).toEqual([
        { kind: "text", text: "synthetic question" }, { kind: "text", text: "synthetic answer" },
      ]);
      mockedProcesses = [{ argv: ["/usr/bin/vim", "/usr/local/bin/devin"] }];
      await expect(paneConversation(pane.pane_id, undefined, {}, dbPath)).rejects.toThrow(ConversationUnavailable);
      mockedProcesses = [{ argv: ["/usr/local/bin/devin"] }];
      mockedPanes = [{ ...pane, agent_session: undefined }];
      await expect(paneConversation(pane.pane_id, undefined, {}, dbPath)).rejects.toMatchObject({ name: "ConversationUnavailable", message: "no_session_id" });
      mockedProcesses = [{ argv: ["/usr/local/bin/devin", "--resume=one"] }];
      expect((await paneConversation(pane.pane_id, undefined, {}, dbPath)).turns).toEqual(answer.turns);
      let snapshots = 0;
      const snapshot = spyOn(herdr, "sessionSnapshot").mockImplementation(async () => ({
        panes: [snapshots++ === 0 ? pane : { ...pane, agent_session: { agent: "devin", kind: "id", value: "two" } }],
      } as SessionSnapshot));
      try {
        await expect(paneConversation(pane.pane_id, undefined, {}, dbPath)).rejects.toThrow(ConversationUnavailable);
      } finally { snapshot.mockRestore(); }
    } finally {
      mockedPanes = [];
      mockedProcesses = [];
      rmSync(root, { recursive: true, force: true });
    }
  });
  it("does not render Devin for a shell with a stale Devin session report", async () => {
    const pane = { pane_id: "pane-shell", cwd: "/synthetic/work", agent_session: { agent: "devin", kind: "id", value: "one" } } as HerdrPane;
    mockedPanes = [pane];
    mockedProcesses = [{ argv: ["/usr/local/bin/devin"] }];
    try {
      await expect(paneConversation(pane.pane_id, undefined, {}, "/missing/sessions.db")).rejects.toThrow(ConversationUnavailable);
    } finally {
      mockedPanes = [];
      mockedProcesses = [];
    }
  });
  it("rejects a herdr socket change during process discovery", async () => {
    const saved = process.env.HERDR_SOCKET;
    const pane = { pane_id: "pane-a", cwd: "/synthetic/work", agent: "devin", agent_session: { agent: "devin", kind: "id", value: "one" } } as HerdrPane;
    const rpc = spyOn(herdr, "herdrRpc").mockImplementation(async () => {
      process.env.HERDR_SOCKET = "/synthetic/foreign.sock";
      return { process_info: { foreground_processes: [{ pid: 2147483647, argv: ["devin"] }] } } as never;
    });
    try {
      process.env.HERDR_SOCKET = "/synthetic/first.sock";
      await expect(paneTranscript(pane.pane_id, undefined, { panes: [pane] } as SessionSnapshot)).rejects.toThrow(ConversationUnavailable);
    } finally {
      rpc.mockRestore();
      if (saved === undefined) delete process.env.HERDR_SOCKET; else process.env.HERDR_SOCKET = saved;
    }
  });
  it("falls back when the explicit store is inaccessible or malformed", async () => {
    const root = mkdtempSync(join(tmpdir(), "herdr-devin-unavailable-"));
    const cwd = "/synthetic/work";
    const pane = { pane_id: "pane-a", cwd, agent: "devin", agent_session: { agent: "devin", kind: "id", value: "one" } } as HerdrPane;
    mockedPanes = [pane];
    mockedProcesses = [{ argv: ["/usr/local/bin/devin"] }];
    try {
      await expect(paneConversation(pane.pane_id, undefined, {}, join(root, "missing.db"))).rejects.toThrow(ConversationUnavailable);
      const dbPath = join(root, "malformed.db");
      const db = new Database(dbPath);
      try { db.exec("CREATE TABLE sessions(id TEXT)"); } finally { db.close(); }
      await expect(paneConversation(pane.pane_id, undefined, {}, dbPath)).rejects.toThrow(ConversationUnavailable);

      const oversizedPath = join(root, "oversized.db");
      const oversized = new Database(oversizedPath);
      try {
        oversized.exec("CREATE TABLE sessions(id TEXT, working_directory TEXT, main_chain_id INTEGER, hidden INTEGER, model TEXT); CREATE TABLE message_nodes(session_id TEXT,node_id INTEGER,parent_node_id INTEGER,chat_message TEXT,created_at INTEGER); CREATE TABLE tool_call_state(session_id TEXT,tool_call_id TEXT,tool_call_json TEXT,tool_call_update_json TEXT); CREATE INDEX node_identity ON message_nodes(session_id, node_id); BEGIN");
        oversized.query("INSERT INTO sessions VALUES ('one', ?, 5001, 0, NULL)").run(cwd);
        const insert = oversized.query("INSERT INTO message_nodes VALUES ('one', ?, ?, '{\"role\":\"user\",\"content\":\"synthetic\"}', 1700000000)");
        for (let index = 1; index <= 5001; index++) insert.run(index, index === 1 ? null : index - 1);
        oversized.exec("COMMIT");
      } finally { oversized.close(); }
      await expect(paneConversation(pane.pane_id, undefined, {}, oversizedPath)).rejects.toThrow(ConversationUnavailable);
    } finally {
      mockedPanes = [];
      mockedProcesses = [];
      rmSync(root, { recursive: true, force: true });
    }
  });
  it("reads an omo that runs in a pane herdr still labels devin", async () => {
    const pane = { pane_id: "pane-a", cwd: "/synthetic/work", agent: "devin" } as HerdrPane;
    const session = spyOn(omo, "omoSessionForPane").mockImplementation(async () => ({ path: null, pending: "synthetic-id" }));
    mockedPanes = [pane];
    mockedProcesses = [{ argv: ["node", "/home/u/.nvm/versions/node/v24.18.0/bin/omo"] }];
    try {
      expect(await paneConversation(pane.pane_id, undefined, {}, "/missing/sessions.db")).toMatchObject({ source: "omo-transcript", turns: [], history_id: "unwritten:synthetic-id" });
    } finally {
      session.mockRestore();
      mockedPanes = [];
      mockedProcesses = [];
    }
  });
  it("forgets a pane's Devin history cache on pane teardown and test-suite reset", async () => {
    const root = mkdtempSync(join(tmpdir(), "herdr-devin-reset-"));
    const dbPath = join(root, "sessions.db");
    const cwd = "/synthetic/work";
    const pane = { pane_id: "pane-a", cwd, agent: "devin", agent_session: { agent: "devin", kind: "id", value: "one" } } as HerdrPane;
    const db = new Database(dbPath);
    try {
      // Cache identity needs committed rows, not a durable sync for each fixture node.
      db.exec("PRAGMA synchronous = OFF");
      db.exec("CREATE TABLE sessions(id TEXT, working_directory TEXT, main_chain_id INTEGER, hidden INTEGER, model TEXT); CREATE TABLE message_nodes(session_id TEXT,node_id INTEGER,parent_node_id INTEGER,chat_message TEXT,created_at INTEGER); CREATE TABLE tool_call_state(session_id TEXT,tool_call_id TEXT,tool_call_json TEXT,tool_call_update_json TEXT)");
      // more turns than one page holds, so the newest page carries a cursor
      db.query("INSERT INTO sessions VALUES ('one', ?, 120, 0, NULL)").run(cwd);
      const insert = db.query("INSERT INTO message_nodes VALUES ('one', ?, ?, ?, 1700000000)");
      db.transaction(() => {
        for (let node = 1; node <= 120; node++) insert.run(node, node === 1 ? null : node - 1, JSON.stringify({ role: "user", content: `synthetic ${node}` }));
      })();
      mockedPanes = [pane];
      mockedProcesses = [{ argv: ["/usr/local/bin/devin", "--resume", "one"] }];
      // the store never changes below, so only a forgotten cache can move the identity
      const read = () => paneConversation(pane.pane_id, undefined, {}, dbPath);
      const initial = await read();
      expect(typeof initial.cursor).toBe("string");
      expect((await read()).history_id).toBe(initial.history_id);
      expect((await paneConversation(pane.pane_id, undefined, { before: initial.cursor! }, dbPath)).turns.length).toBe(20);
      forgetPaneTranscriptState(pane.pane_id);
      const paneReset = await read();
      expect(paneReset.history_id).not.toBe(initial.history_id);
      await expect(paneConversation(pane.pane_id, undefined, { before: initial.cursor! }, dbPath)).rejects.toThrow(DevinHistoryChanged);
      forgetTranscriptState();
      const testReset = await read();
      expect(testReset.history_id).not.toBe(paneReset.history_id);
      await expect(paneConversation(pane.pane_id, undefined, { before: paneReset.cursor! }, dbPath)).rejects.toThrow(DevinHistoryChanged);
    } finally {
      db.close();
      mockedPanes = [];
      mockedProcesses = [];
      rmSync(root, { recursive: true, force: true });
    }
  }, 15_000); // Seven awaited pane reads, including three complete ancestry/cache builds.
});

/** Minimal but shape-true slices of a Claude Code session jsonl. */
const lines = [
  JSON.stringify({ type: "user", timestamp: "2026-09-19T08:00:00.000Z", message: { role: "user", content: "리팩터링 시작해줘" } }),
  JSON.stringify({ type: "assistant", timestamp: "2026-09-19T08:00:02.000Z", message: { role: "assistant", content: [
    { type: "text", text: "먼저 상태를 확인하겠습니다." },
    { type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "git status --short", description: "check tree" } },
  ] } }),
  JSON.stringify({ type: "user", timestamp: "2026-09-19T08:00:03.000Z", message: { role: "user", content: [
    { type: "tool_result", tool_use_id: "toolu_1", content: "M src/app.ts" },
  ] } }),
  JSON.stringify({ type: "assistant", timestamp: "2026-09-19T08:00:05.000Z", message: { role: "assistant", content: [
    { type: "thinking", thinking: "internal reasoning stays private" },
    { type: "text", text: "변경된 파일이 하나입니다." },
  ] } }),
  JSON.stringify({ type: "user", timestamp: "2026-09-19T08:01:00.000Z", message: { role: "user", content: "<command-name>/help</command-name>" } }),
].join("\n");

describe("parseClaudeTranscript", () => {
  it("restores the recorded explicit skill invocation while hiding its meta body and compact echo", async () => {
    const fixture = await Bun.file(join(import.meta.dir, "fixtures/skill-invocations/claude.jsonl")).text();
    const compact = JSON.stringify({ type: "user", message: { content: "<command-message>compact</command-message>\n<command-name>/compact</command-name>\n<command-args></command-args>" } });
    const users = parseClaudeTranscript(`${fixture}\n${compact}`).filter(({ role }) => role === "user");
    expect(users).toHaveLength(1);
    expect(users[0]?.parts).toEqual([
      { kind: "text", text: "/probe-skill hello" },
      { kind: "skill", skill: { name: "probe-skill", evidence: "invocation", status: "requested" } },
    ]);
  });
  it("builds user and merged assistant turns with folded tool results", () => {
    const turns = parseClaudeTranscript(lines);
    expect(turns).toEqual([
      { role: "user", ts: "2026-09-19T08:00:00.000Z", parts: [{ kind: "text", text: "리팩터링 시작해줘" }] },
      { role: "assistant", ts: "2026-09-19T08:00:02.000Z", end_ts: "2026-09-19T08:00:05.000Z", parts: [
        { kind: "text", text: "먼저 상태를 확인하겠습니다." },
        // the row says what the agent said the command is for; the command stays in the input
        { kind: "tool", name: "Bash", summary: "check tree", input: expect.stringContaining("git status"), output: "M src/app.ts", call_id: "toolu_1", state: "ok" },
        { kind: "thinking", text: "internal reasoning stays private" },
        { kind: "text", text: "변경된 파일이 하나입니다." },
      ] },
    ]);
  });

  describe("native call id and state", () => {
    const prompt = JSON.stringify({ type: "user", message: { role: "user", content: "plan it" } });
    const use = (id: string, input: object = { todos: [] }) => JSON.stringify({ type: "assistant", message: { role: "assistant", stop_reason: "tool_use", content: [{ type: "tool_use", id, name: "TodoWrite", input }] } });
    const result = (id: string, content: unknown, isError?: boolean) => JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content, ...(isError === undefined ? {} : { is_error: isError }) }] } });
    const tools = (text: string) => parseClaudeTranscript(text).flatMap((turn) => turn.parts).filter((part) => part.kind === "tool");

    it("pending call has native id and pending state", () => {
      expect(tools([prompt, use("toolu_a")].join("\n"))).toMatchObject([{ call_id: "toolu_a", state: "pending", output: "" }]);
    });

    it("empty successful result is ok", () => {
      const [part] = tools([prompt, use("toolu_a"), result("toolu_a", "")].join("\n"));
      expect(part).toMatchObject({ call_id: "toolu_a", state: "ok", output: "" });
      expect(part?.kind === "tool" && part.error).toBeFalsy();
    });

    it("explicit failed result is error", () => {
      expect(tools([prompt, use("toolu_a"), result("toolu_a", "", true)].join("\n"))).toMatchObject([{ call_id: "toolu_a", state: "error", error: true }]);
      // a result that only reads like a failure is still the success the flag says
      expect(tools([prompt, use("toolu_b"), result("toolu_b", "Error: exit code 1", false)].join("\n"))).toMatchObject([{ call_id: "toolu_b", state: "ok" }]);
    });

    it("repeated identical calls retain distinct ids", () => {
      const parts = tools([prompt, use("toolu_a"), result("toolu_a", "same"), use("toolu_b"), result("toolu_b", "same")].join("\n"));
      expect(parts.map((part) => part.kind === "tool" && [part.call_id, part.state, part.input, part.output])).toEqual([
        ["toolu_a", "ok", parts[1]?.kind === "tool" ? parts[1].input : "", "same"],
        ["toolu_b", "ok", parts[0]?.kind === "tool" ? parts[0].input : "", "same"],
      ]);
    });

    it("append and full poll replacement preserve call id and update or omit state", () => {
      const first = [prompt, use("toolu_a"), use("toolu_b")];
      expect(tools(first.join("\n")).map((part) => part.kind === "tool" && [part.call_id, part.state])).toEqual([["toolu_a", "pending"], ["toolu_b", "pending"]]);
      // the next poll reads the file again with both results appended
      const second = [...first, result("toolu_a", ""), result("toolu_b", "denied", true)];
      expect(tools(second.join("\n")).map((part) => part.kind === "tool" && [part.call_id, part.state])).toEqual([["toolu_a", "ok"], ["toolu_b", "error"]]);
      // a cut output keeps the id beside its fetch ref
      const long = tools([prompt, use("toolu_c"), result("toolu_c", "x".repeat(5000))].join("\n"))[0];
      expect(long).toMatchObject({ call_id: "toolu_c", state: "ok", output_ref: "toolu_c", output_size: 5000 });
    });
  });

  it("shows a pasted text without Claude Code's paste wrapper, in string and block prompts", () => {
    const pasted = '\n\n<pasted_content id="6d8b">\n| a | b |\n\nsecond paragraph\n</pasted_content id="6d8b">\n';
    const turns = parseClaudeTranscript([
      JSON.stringify({ type: "user", message: { role: "user", content: pasted } }),
      JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text: `look at this${pasted}` }] } }),
      JSON.stringify({ type: "user", message: { role: "user", content: "typed <\\pasted_content id=\"6d8b\"> stays" } }),
    ].join("\n"));
    expect(turns.map((turn) => turn.parts[0])).toEqual([
      { kind: "text", text: "| a | b |\n\nsecond paragraph" },
      { kind: "text", text: "look at this\n\n| a | b |\n\nsecond paragraph" },
      { kind: "text", text: 'typed <\\pasted_content id="6d8b"> stays' },
    ]);
  });

  it("drops slash-command bookkeeping entries", () => {
    const turns = parseClaudeTranscript(lines);
    expect(turns.some((turn) => turn.parts.some((part) => part.kind === "text" && part.text.includes("/clear")))).toBe(false);
  });

  it("shows what a slash command answered, and leaves its echo and an empty answer out", () => {
    const local = (content: string, ts: string) => JSON.stringify({ type: "system", subtype: "local_command", isMeta: false, timestamp: ts, content });
    const refusal = "/goal can't run while hooks are restricted (disableAllHooks or allowManagedHooksOnly is set in settings or by policy).";
    const turns = parseClaudeTranscript([
      local("<command-name>/goal</command-name>\n<command-message>goal</command-message>\n<command-args>test</command-args>", "2026-10-07T19:00:00.000Z"),
      local(`<local-command-stdout>${refusal}</local-command-stdout>`, "2026-10-07T19:00:01.000Z"),
      local("<local-command-stdout></local-command-stdout>", "2026-10-07T19:00:02.000Z"),
      local("<local-command-stderr>\u001b[31mUnknown command: /gaol\u001b[39m</local-command-stderr>", "2026-10-07T19:00:03.000Z"),
      JSON.stringify({ type: "system", subtype: "turn_duration", content: "<local-command-stdout>not a command's answer</local-command-stdout>" }),
    ].join("\n"));
    expect(turns).toEqual([
      { role: "user", ts: "2026-10-07T19:00:01.000Z", parts: [{ kind: "notice", text: refusal, source: "local-command" }] },
      { role: "user", ts: "2026-10-07T19:00:03.000Z", parts: [{ kind: "notice", text: "Unknown command: /gaol", source: "local-command" }] },
    ]);
  });

  it("shows Claude Code's own notices, an unknown command's lines joined as one", () => {
    // Claude Code 2.1.294: an unknown command and its dropped arguments, 1ms apart, and no user turn
    const info = (content: string, ts: string) => JSON.stringify({ type: "system", subtype: "informational", content, level: "warning", timestamp: ts });
    const turns = parseClaudeTranscript([
      info("Unknown command: /xyzabc", "2026-10-08T08:06:31.117Z"),
      info("Args from unknown skill: hello there", "2026-10-08T08:06:31.118Z"),
      info("Usage limit reached · continuing automatically at 4am · esc to cancel", "2026-10-08T09:00:00.000Z"),
      info("\u001b[2mUsage limit reset · continuing automatically\u001b[22m", "2026-10-08T13:00:00.000Z"),
      info("", "2026-10-08T13:00:01.000Z"),
    ].join("\n"));
    expect(turns).toEqual([
      { role: "user", ts: "2026-10-08T08:06:31.117Z", parts: [{ kind: "notice", text: "Unknown command: /xyzabc\nArgs from unknown skill: hello there", source: "informational" }] },
      { role: "user", ts: "2026-10-08T09:00:00.000Z", parts: [{ kind: "notice", text: "Usage limit reached · continuing automatically at 4am · esc to cancel", source: "informational" }] },
      { role: "user", ts: "2026-10-08T13:00:00.000Z", parts: [{ kind: "notice", text: "Usage limit reset · continuing automatically", source: "informational" }] },
    ]);
  });

  it("keeps a notice joined from long lines within the notice's length", () => {
    const info = (content: string, ts: string) => JSON.stringify({ type: "system", subtype: "informational", content, timestamp: ts });
    const [turn] = parseClaudeTranscript([
      info("a".repeat(4000), "2026-10-08T08:06:31.117Z"),
      info("b".repeat(4000), "2026-10-08T08:06:31.118Z"),
    ].join("\n"));
    const text = (turn!.parts[0] as { text: string }).text;
    expect(turn!.parts).toHaveLength(1);
    expect(text.length).toBe(4001);
    expect(text.endsWith("\u2026")).toBe(true);
  });

  it("keeps a turn whole when Claude Code writes a notice while the agent works", () => {
    // a cross-session notice between a tool's result and the next call: about half of the notices in real transcripts
    const assistant = (block: object, stop: string, ts: string) => JSON.stringify({ type: "assistant", timestamp: ts, message: { role: "assistant", stop_reason: stop, content: [block] } });
    const info = (content: string, ts: string) => JSON.stringify({ type: "system", subtype: "informational", content, level: "warning", timestamp: ts });
    const turns = parseClaudeTranscript([
      JSON.stringify({ type: "user", timestamp: "2026-10-08T08:00:00.000Z", message: { role: "user", content: "run it" } }),
      assistant({ type: "tool_use", id: "t1", name: "Bash", input: { command: "sleep 60" } }, "tool_use", "2026-10-08T08:00:01.000Z"),
      info("Cross-session message held by the receiving session", "2026-10-08T08:00:20.000Z"),
      JSON.stringify({ type: "user", timestamp: "2026-10-08T08:01:01.000Z", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] } }),
      info("Cross-session message expired without approval", "2026-10-08T08:01:02.500Z"),
      assistant({ type: "text", text: "Done." }, "end_turn", "2026-10-08T08:01:03.000Z"),
      info("Unknown command: /xyzabc", "2026-10-08T08:02:00.000Z"),
    ].join("\n"));
    expect(turns.map((turn) => [turn.role, turn.parts.map((part) => part.kind === "notice" ? part.text : part.kind)])).toEqual([
      ["user", ["text"]],
      // written inside the turn: shown before it, and the turn is still the last one while it runs
      ["user", ["Cross-session message held by the receiving session"]],
      ["user", ["Cross-session message expired without approval"]],
      ["assistant", ["tool", "text"]],
      // written after the answer: shown after it
      ["user", ["Unknown command: /xyzabc"]],
    ]);
    expect(turns[3]!.end_ts).toBe("2026-10-08T08:01:03.000Z");
  });

  it("keeps a turn whole around a notice when the tool call's entry names no stop reason", () => {
    const turns = parseClaudeTranscript([
      JSON.stringify({ type: "user", message: { role: "user", content: "run" } }),
      JSON.stringify({ type: "assistant", message: { role: "assistant", stop_reason: null, content: [{ type: "tool_use", id: "t", name: "Bash", input: { command: "sleep 60" } }] } }),
      JSON.stringify({ type: "system", subtype: "informational", content: "Message held" }),
      JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: "ok" }] } }),
      JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Done" }] } }),
      JSON.stringify({ type: "system", subtype: "informational", content: "After the answer" }),
    ].join("\n"));
    expect(turns.map((turn) => [turn.role, turn.parts.map((part) => part.kind === "notice" ? part.text : part.kind)])).toEqual([
      ["user", ["text"]], ["user", ["Message held"]], ["assistant", ["tool", "text"]], ["user", ["After the answer"]],
    ]);
  });

  it("shows a refusal recorded both ways once also while the agent works, and keeps the turn whole", () => {
    const at = "2026-10-08T08:00:10.000Z";
    const info = JSON.stringify({ type: "system", subtype: "informational", timestamp: at, content: "Message held" });
    const local = JSON.stringify({ type: "system", subtype: "local_command", timestamp: at, content: "<local-command-stderr>Message held</local-command-stderr>" });
    const around = (notices: string[]) => parseClaudeTranscript([
      JSON.stringify({ type: "user", timestamp: "2026-10-08T08:00:00.000Z", message: { role: "user", content: "run" } }),
      JSON.stringify({ type: "assistant", timestamp: "2026-10-08T08:00:01.000Z", message: { role: "assistant", stop_reason: "tool_use", content: [{ type: "tool_use", id: "t", name: "Bash", input: { command: "sleep 60" } }] } }),
      ...notices,
      JSON.stringify({ type: "user", timestamp: "2026-10-08T08:01:00.000Z", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: "ok" }] } }),
      JSON.stringify({ type: "assistant", timestamp: "2026-10-08T08:01:01.000Z", message: { role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: "Done" }] } }),
    ].join("\n")).map((turn) => [turn.role, turn.parts.map((part) => part.kind === "notice" ? `${part.source}: ${part.text}` : part.kind)]);
    expect(around([info, local])).toEqual([["user", ["text"]], ["user", ["informational: Message held"]], ["assistant", ["tool", "text"]]]);
    expect(around([local, info])).toEqual([["user", ["text"]], ["user", ["local-command: Message held"]], ["assistant", ["tool", "text"]]]);
  });

  it("shows a refusal once when Claude Code records it both as a command's answer and as a notice", () => {
    const info = (content: string, ts: string) => JSON.stringify({ type: "system", subtype: "informational", content, level: "warning", timestamp: ts });
    const local = (content: string, ts: string) => JSON.stringify({ type: "system", subtype: "local_command", timestamp: ts, content });
    const notices = (lines: string[]) => parseClaudeTranscript(lines.join("\n")).flatMap((turn) => turn.parts).filter((part) => part.kind === "notice").map((part) => (part as { text: string }).text);
    const stderr = "<local-command-stderr>\u001b[31mUnknown command: /gaol\u001b[39m</local-command-stderr>";
    expect(notices([local(stderr, "2026-10-08T08:06:31.117Z"), info("Unknown command: /gaol", "2026-10-08T08:06:31.118Z"), info("Args from unknown skill: x", "2026-10-08T08:06:31.119Z")]))
      .toEqual(["Unknown command: /gaol", "Args from unknown skill: x"]);
    expect(notices([info("Unknown command: /gaol", "2026-10-08T08:06:31.117Z"), info("Args from unknown skill: x", "2026-10-08T08:06:31.118Z"), local(stderr, "2026-10-08T08:06:31.119Z")]))
      .toEqual(["Unknown command: /gaol\nArgs from unknown skill: x"]);
    // the same words a minute later are another answer, and a notice's own repeat is kept
    expect(notices([local(stderr, "2026-10-08T08:06:31.117Z"), info("Unknown command: /gaol", "2026-10-08T08:07:31.118Z")])).toEqual(["Unknown command: /gaol", "Unknown command: /gaol"]);
    expect(notices([info("Message expired", "2026-10-08T08:06:31.117Z"), info("Message expired", "2026-10-08T08:06:31.118Z")])).toEqual(["Message expired\nMessage expired"]);
  });

  it("shows a bash-mode command with what it printed as one turn, which only the command opens", () => {
    const user = (content: string, ts: string) => JSON.stringify({ type: "user", timestamp: ts, message: { role: "user", content } });
    const records = [
      user('<bash-input>echo "Hello"</bash-input>', "2026-10-27T03:00:00.000Z"),
      user("<bash-stdout>  Hello\n    world\n</bash-stdout><bash-stderr></bash-stderr>", "2026-10-27T03:00:00.100Z"),
      user("<bash-input>ls extra</bash-input>", "2026-10-27T03:00:01.000Z"),
      user("<bash-stdout></bash-stdout><bash-stderr>\u001b[31mls: extra: No such file or directory\u001b[39m</bash-stderr>", "2026-10-27T03:00:01.100Z"),
      // a command whose output was not recorded, then a prompt that quotes the tags
      user("<bash-input>sleep 60</bash-input>", "2026-10-27T03:00:02.000Z"),
      user("Why does <bash-input>ls</bash-input> show here?", "2026-10-27T03:00:03.000Z"),
      // only a whole output entry is one: a prompt that starts like one is a prompt
      user("<bash-stdout> is the tag I mean", "2026-10-27T03:00:04.000Z"),
    ];
    expect(parseClaudeTranscript(records.join("\n"))).toEqual([
      { role: "user", ts: "2026-10-27T03:00:00.000Z", parts: [{ kind: "shell", command: 'echo "Hello"', stdout: "  Hello\n    world", stderr: "" }] },
      { role: "user", ts: "2026-10-27T03:00:01.000Z", parts: [{ kind: "shell", command: "ls extra", stdout: "", stderr: "ls: extra: No such file or directory" }] },
      { role: "user", ts: "2026-10-27T03:00:02.000Z", parts: [{ kind: "shell", command: "sleep 60" }] },
      { role: "user", ts: "2026-10-27T03:00:03.000Z", parts: [{ kind: "text", text: "Why does <bash-input>ls</bash-input> show here?" }] },
      { role: "user", ts: "2026-10-27T03:00:04.000Z", parts: [{ kind: "text", text: "<bash-stdout> is the tag I mean" }] },
    ]);
    // a page never starts at an output: it would lose its command
    expect(turnStarts(Buffer.from(records.join("\n")), "claude-transcript")).toHaveLength(5);
    // an output with no command before it is left out
    expect(parseClaudeTranscript(records[1]!)).toEqual([]);
  });

  for (const provenance of [{ origin: { kind: "human" }, permissionMode: "default" }, { permissionMode: "default" }, { origin: { kind: "human" } }]) {
    for (const array of [false, true]) {
      it(`keeps bash tags literal in ${array ? "array" : "string"} prompts with ${Object.keys(provenance).join(" and ")}`, () => {
        for (const text of ["<bash-input>ls</bash-input>", "<bash-stdout>err</bash-stdout>"]) {
          const record = JSON.stringify({ type: "user", ...provenance, message: { role: "user", content: array ? [{ type: "text", text }] : text } });
          expect(parseClaudeTranscript(record)).toEqual([{ role: "user", ts: null, parts: [{ kind: "text", text }] }]);
          expect(turnStarts(Buffer.from(record), "claude-transcript")).toEqual([0]);
        }
      });
    }
  }

  it("keeps bash output tags literal in queued human prompts", () => {
    const text = "<bash-stdout>err</bash-stdout>";
    const record = JSON.stringify({ type: "attachment", attachment: { type: "queued_command", commandMode: "prompt", origin: { kind: "human" }, prompt: text } });
    expect(parseClaudeTranscript(record)).toEqual([{ role: "user", ts: null, parts: [{ kind: "text", text }] }]);
  });

  it("preserves literal stream tags inside bash stdout without fabricating stderr", () => {
    const stdout = "before</bash-stdout><bash-stderr>fake error</bash-stderr><bash-stdout>after";
    const user = (content: string) => JSON.stringify({ type: "user", message: { role: "user", content } });
    const records = [user("<bash-input>printf tags</bash-input>"), user(`<bash-stdout>${stdout}</bash-stdout><bash-stderr></bash-stderr>`)];
    expect(parseClaudeTranscript(records.join("\n"))[0]?.parts).toEqual([{ kind: "shell", command: "printf tags", stdout: `${stdout}</bash-stdout><bash-stderr>`, stderr: "" }]);
    expect(turnStarts(Buffer.from(records.join("\n")), "claude-transcript")).toEqual([0]);
  });

  it("preserves literal stream tags inside bash stderr", () => {
    const stderr = "before</bash-stderr><bash-stderr>after";
    const user = (content: string) => JSON.stringify({ type: "user", message: { role: "user", content } });
    const records = [user("<bash-input>printf tags</bash-input>"), user(`<bash-stdout></bash-stdout><bash-stderr>${stderr}</bash-stderr>`)];
    const parts = parseClaudeTranscript(records.join("\n")).flatMap((turn) => turn.parts);
    expect(parts).toEqual([{ kind: "shell", command: "printf tags", stdout: "", stderr }]);
  });

  for (const [stdout, stderr] of [
    ["", "before</bash-stdout><bash-stderr>after"],
    ["out", "x</bash-stdout>y"],
  ] as const) {
    it(`keeps a printed stdout close inside stderr ${JSON.stringify(stderr)} without adding a turn`, () => {
      const user = (content: string) => JSON.stringify({ type: "user", message: { role: "user", content } });
      const records = [
        user("<bash-input>printf tags</bash-input>"),
        user(`<bash-stdout>${stdout}</bash-stdout><bash-stderr>${stderr}</bash-stderr>`),
      ].join("\n");
      const ambiguous = stderr.includes("</bash-stdout><bash-stderr>");
      expect(parseClaudeTranscript(records)).toEqual([
        { role: "user", ts: null, parts: [{ kind: "shell", command: "printf tags",
          stdout: ambiguous ? `${stdout}</bash-stdout><bash-stderr>${stderr}` : stdout,
          stderr: ambiguous ? "" : stderr }] },
      ]);
      expect(turnStarts(Buffer.from(records), "claude-transcript")).toEqual([0]);
    });
  }

  for (const { name, stdout, stderr, ambiguous } of [
    { name: "N1", stdout: "a</bash-stdout><bash-stderr>b", stderr: "", ambiguous: true },
    { name: "N2", stdout: 'user("<bash-stdout>Hello</bash-stdout><bash-stderr></bash-stderr>", 1)', stderr: "", ambiguous: true },
    {
      name: "N3",
      stdout: `572: user('<bash-input>echo "Hello"</bash-input>')\n573: user("<bash-stdout>  Hello</bash-stdout><bash-stderr></bash-stderr>")\n575: user("<bash-stdout></bash-stdout><bash-stderr>ls: extra</bash-stderr>")`,
      stderr: "", ambiguous: true,
    },
    { name: "N4", stdout: '{"content":"<bash-stdout>x</bash-stdout><bash-stderr></bash-stderr>"}', stderr: "", ambiguous: true },
    { name: "N5", stdout: "o</bash-stdout><bash-stderr>p", stderr: "e", ambiguous: true },
    { name: "N6", stdout: "", stderr: "x</bash-stderr><bash-stdout>y", ambiguous: false },
    { name: "N7", stdout: "o", stderr: "a</bash-stderr><bash-stdout>b</bash-stdout><bash-stderr>c", ambiguous: true },
    { name: "H", stdout: "ok", stderr: "x</bash-stdout><bash-stderr>y", ambiguous: true },
    { name: "Codex R1", stdout: "before</bash-stdout><bash-stderr>after", stderr: "", ambiguous: true },
    { name: "Codex R2", stdout: "", stderr: "before</bash-stderr><bash-stdout>middle</bash-stdout><bash-stderr>after", ambiguous: true },
    { name: "empty-candidate collision", stdout: "x", stderr: "y</bash-stdout><bash-stderr>", ambiguous: true },
    { name: "ambiguous trailing whitespace", stdout: "x</bash-stdout>\n<bash-stderr>y", stderr: "z \n", ambiguous: true },
  ]) {
    it(`keeps deterministic bash output ${name} intact in one shell turn`, () => {
      const user = (content: string) => JSON.stringify({ type: "user", message: { role: "user", content } });
      const records = [
        user("<bash-input>printf tags</bash-input>"),
        user(`<bash-stdout>${stdout}</bash-stdout><bash-stderr>${stderr}</bash-stderr>`),
      ].join("\n");
      const expectedStdout = ambiguous ? `${stdout}</bash-stdout><bash-stderr>${stderr}` : stdout;
      const expectedStderr = ambiguous ? "" : stderr;
      expect(parseClaudeTranscript(records)).toEqual([
        { role: "user", ts: null, parts: [{ kind: "shell", command: "printf tags", stdout: expectedStdout, stderr: expectedStderr }] },
      ]);
      expect(turnStarts(Buffer.from(records), "claude-transcript")).toEqual([0]);
    });
  }

  it("never fabricates stderr or loses payload characters across seeded bash tag pairs", () => {
    const pieces = ["<bash-stdout>", "</bash-stdout>", "<bash-stderr>", "</bash-stderr>", "one", "two"];
    const user = (content: string) => JSON.stringify({ type: "user", message: { role: "user", content } });
    for (const seed of [0x2176, 0xc0de]) {
      let state = seed;
      const next = () => {
        state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
        return state;
      };
      const payload = () => {
        const count = next() % 9;
        let text = "";
        for (let i = 0; i < count; i++) text += pieces[next() % pieces.length];
        return text;
      };
      for (let i = 0; i < 512; i++) {
        const stdout = payload(), stderr = payload();
        const records = [
          user("<bash-input>printf tags</bash-input>"),
          user(`<bash-stdout>${stdout}</bash-stdout><bash-stderr>${stderr}</bash-stderr>`),
        ].join("\n");
        const turns = parseClaudeTranscript(records);
        expect(turns).toHaveLength(1);
        const shell = turns[0]?.parts[0];
        if (shell?.kind !== "shell") throw new Error("Expected one shell card");
        expect(shell.stderr === "" || shell.stderr === stderr).toBe(true);
        const shown = `${shell.stdout ?? ""}${shell.stderr ?? ""}`;
        let at = 0;
        for (const character of stdout + stderr) {
          const found = shown.indexOf(character, at);
          expect(found).toBeGreaterThanOrEqual(at);
          at = found + 1;
        }
        expect(turnStarts(Buffer.from(records), "claude-transcript")).toEqual([0]);
      }
    }
  });

  it("attaches bash output to its shell across an informational notice", () => {
    const user = (content: string) => JSON.stringify({ type: "user", message: { role: "user", content } });
    const records = [
      user("<bash-input>ls</bash-input>"),
      JSON.stringify({ type: "system", subtype: "informational", content: "Something" }),
      user("<bash-stdout>README.md</bash-stdout><bash-stderr></bash-stderr>"),
    ];
    expect(parseClaudeTranscript(records.join("\n")).map((turn) => turn.parts)).toEqual([
      [{ kind: "shell", command: "ls", stdout: "README.md", stderr: "" }],
      [{ kind: "notice", text: "Something", source: "informational" }],
    ]);
  });

  it("shows a slash command's answer only as the whole entry, as text, and not past its length", () => {
    const local = (content: string) => JSON.stringify({ type: "system", subtype: "local_command", timestamp: "2026-10-07T19:00:00.000Z", content });
    const notices = (lines: string[]) => parseClaudeTranscript(lines.join("\n")).flatMap((turn) => turn.parts).filter((part) => part.kind === "notice").map((part) => (part as { text: string }).text);
    // an echo whose arguments quote the tag is still an echo
    expect(notices([local("<command-name>/goal</command-name>\n<command-args>x <local-command-stdout>quoted</local-command-stdout></command-args>")])).toEqual([]);
    // a link keeps its text and drops its hidden address; cursor moves and backspaces go too
    expect(notices([local("<local-command-stdout>\u001b]8;;https://example.test/?token=hidden\u0007open\u001b]8;;\u0007 done\u001b[2K\b</local-command-stdout>")])).toEqual(["open done"]);
    const long = notices([local(`<local-command-stdout>${"x".repeat(10_000)}</local-command-stdout>`)])[0]!;
    expect(long.length).toBe(4001);
    expect(long.endsWith("\u2026")).toBe(true);
  });

  it("strips an unterminated link, a charset switch, and shows both streams of one entry", () => {
    const local = (content: string) => JSON.stringify({ type: "system", subtype: "local_command", timestamp: "2026-10-07T19:00:00.000Z", content });
    const notices = (lines: string[]) => parseClaudeTranscript(lines.join("\n")).flatMap((turn) => turn.parts).filter((part) => part.kind === "notice").map((part) => (part as { text: string }).text);
    // an OSC cut off before its BEL or ST still hides its address
    expect(notices([local("<local-command-stdout>done \u001b]8;;https://example.test/?token=hidden</local-command-stdout>")])).toEqual(["done"]);
    // ESC ( B is one sequence: no stray B
    expect(notices([local("<local-command-stdout>\u001b(Bplain\u001b[m text</local-command-stdout>")])).toEqual(["plain text"]);
    expect(notices([local("<local-command-stdout>out</local-command-stdout>\n<local-command-stderr>err</local-command-stderr>")])).toEqual(["out\nerr"]);
    // a closing tag the output itself prints ends nothing: only one at the end, or before the next stream, does
    expect(notices([local("<local-command-stdout>Use </local-command-stdout> in this example.</local-command-stdout>")])).toEqual(["Use </local-command-stdout> in this example."]);
    expect(notices([local("<local-command-stdout>a </local-command-stdout> b</local-command-stdout>\n<local-command-stderr>err</local-command-stderr>")])).toEqual(["a </local-command-stdout> b\nerr"]);
  });

  it("strips escapes in work linear in a malformed answer's length", () => {
    const local = (n: number, unit: string) => JSON.stringify({ type: "system", subtype: "local_command", timestamp: "2026-10-07T19:00:00.000Z", content: `<local-command-stdout>${unit.repeat(n)}</local-command-stdout>` });
    // Counted, not timed: the parse takes well under a millisecond, and two such timings divide
    // into noise. It reads the answer through these primitives, each charged the characters it
    // touches. A regex's backtracking cannot be counted, so a run is charged its worst case, the
    // square of its input: a regex over one character costs one step, one over the answer fails.
    const work = (line: string): number => {
      let steps = 0;
      const text = String.prototype;
      const { charCodeAt, indexOf, startsWith, slice } = text;
      const { exec } = RegExp.prototype;
      text.charCodeAt = function (this: string, index: number) {
        steps++;
        return charCodeAt.call(this, index);
      };
      text.indexOf = function (this: string, search: string, from = 0) {
        const found = indexOf.call(this, search, from);
        steps += (found === -1 ? this.length : found) - from + search.length;
        return found;
      };
      text.startsWith = function (this: string, search: string, from?: number) {
        steps += search.length;
        return startsWith.call(this, search, from);
      };
      text.slice = function (this: string, start?: number, end?: number) {
        const part = slice.call(this, start, end);
        steps += part.length;
        return part;
      };
      RegExp.prototype.exec = function (this: RegExp, input: string) {
        steps += input.length ** 2;
        return exec.call(this, input);
      };
      try {
        parseClaudeTranscript(line);
      } finally {
        text.charCodeAt = charCodeAt;
        text.indexOf = indexOf;
        text.startsWith = startsWith;
        text.slice = slice;
        RegExp.prototype.exec = exec;
      }
      return steps;
    };
    // unterminated escapes, and closing tags the output prints itself
    for (const unit of ["\u001b]x", "</local-command-stdout> x"]) {
      // doubling the input doubles the work (2.00 measured for both); a rescan from every
      // unterminated opener, or from every closing tag, quadruples it. No work counted at all
      // is NaN here and fails too.
      expect(work(local(40_000, unit)) / work(local(20_000, unit))).toBeLessThan(2.5);
    }
  });

  it("keeps thinking blocks in transcript order", () => {
    const assistant = parseClaudeTranscript(lines)[1];
    expect(assistant?.parts.map((part) => part.kind)).toEqual(["text", "tool", "thinking", "text"]);
  });

  it("reads thinking that Claude Code displays as updates as narration in the work", () => {
    // the shape a recent Claude Code writes: one entry per block, the visible update as thinking
    const entry = (thinkingDisplay: string | undefined, block: object) => JSON.stringify({ type: "assistant", timestamp: "2026-10-14T07:00:00.000Z", ...(thinkingDisplay ? { thinkingDisplay } : {}), message: { role: "assistant", stop_reason: null, content: [block] } });
    const turns = parseClaudeTranscript([
      JSON.stringify({ type: "user", message: { role: "user", content: "measure the padding" } }),
      entry("updates", { type: "thinking", thinking: "", signature: "s" }),
      entry("updates", { type: "thinking", thinking: "The padding stays; measuring it next.", signature: "s" }),
      entry("updates", { type: "tool_use", id: "t", name: "Bash", input: { command: "true" } }),
      entry(undefined, { type: "thinking", thinking: "private reasoning", signature: "s" }),
    ].join("\n"));
    expect(turns[1]?.parts.filter((part) => part.kind !== "tool")).toEqual([
      { kind: "text", text: "The padding stays; measuring it next.", phase: "commentary" },
      { kind: "thinking", text: "private reasoning" },
    ]);
  });

  it("survives a torn tail line while Claude is mid-append", () => {
    expect(parseClaudeTranscript(`${lines}\n{"type":"ass`).length).toBe(2);
  });

  it("trims a huge tool result instead of shipping megabytes to the browser", () => {
    const big = [
      JSON.stringify({ type: "assistant", message: { role: "assistant", content: [
        { type: "tool_use", id: "t", name: "Read", input: { file_path: "/etc/big" } },
      ] } }),
      JSON.stringify({ type: "user", message: { role: "user", content: [
        { type: "tool_result", tool_use_id: "t", content: "x".repeat(10_000) },
      ] } }),
    ].join("\n");
    const turns = parseClaudeTranscript(big);
    const tool = turns[0]?.parts[0];
    expect(tool && tool.kind === "tool" ? tool.output.length : 0).toBeLessThanOrEqual(4100);
  });

  it("sums a NotebookEdit up by its notebook, so the row reads as an edit", () => {
    const turns = parseClaudeTranscript(JSON.stringify({ type: "assistant", message: { role: "assistant", content: [
      { type: "tool_use", id: "n", name: "NotebookEdit", input: { notebook_path: "/repo/analysis.ipynb", cell_id: "c1", new_source: "print(1)", edit_mode: "replace" } },
    ] } }));
    const tool = turns[0]?.parts[0];
    if (tool?.kind !== "tool") throw new Error("expected a tool part");
    expect(tool.summary).toBe("/repo/analysis.ipynb");
    expect(toolVerb(tool, tool.summary)).toBe("Edited");
  });

  it("caps the turn list", () => {
    const many = Array.from({ length: MAX_TURNS + 50 }, (_, i) =>
      JSON.stringify({ type: "user", message: { role: "user", content: `m${i}` } }),
    ).join("\n");
    expect(parseClaudeTranscript(many).length).toBe(MAX_TURNS);
  });

  it("returns nothing for an empty transcript", () => {
    expect(parseClaudeTranscript("")).toEqual([]);
  });

  it("shows a message the person sent while the agent was working", () => {
    const queued = (attachment: Record<string, unknown>) => ({ type: "attachment", timestamp: "2026-10-02T04:00:05.000Z", attachment: { type: "queued_command", timestamp: "2026-10-02T04:00:05.000Z", ...attachment } });
    const transcript = [
      { type: "user", timestamp: "2026-10-02T04:00:00.000Z", message: { role: "user", content: "start" } },
      { type: "assistant", timestamp: "2026-10-02T04:00:02.000Z", message: { role: "assistant", content: [{ type: "text", text: "working" }] } },
      // the queue pair repeats the text; only the attachment becomes a turn
      { type: "queue-operation", operation: "enqueue", timestamp: "2026-10-02T04:00:05.000Z", content: "also fix the tests" },
      { type: "queue-operation", operation: "remove", timestamp: "2026-10-02T04:00:09.000Z", content: "also fix the tests", reason: "absorbed_mid_turn" },
      queued({ prompt: "also fix the tests", commandMode: "prompt", origin: { kind: "human" }, humanTurn: true }),
      // a background task's notice and another agent's message are not the person's words
      queued({ prompt: "<task-notification>\n<status>completed</status>\n</task-notification>", commandMode: "task-notification" }),
      queued({ prompt: "<agent-message from=\"reviewer\">\ndone\n</agent-message>", commandMode: "prompt", origin: { kind: "peer" }, isMeta: true }),
      { type: "assistant", timestamp: "2026-10-02T04:00:10.000Z", message: { role: "assistant", content: [{ type: "text", text: "on it" }] } },
    ].map((entry) => JSON.stringify(entry)).join("\n");
    expect(parseClaudeTranscript(transcript).map((turn) => [turn.role, turn.ts, turn.parts])).toEqual([
      ["user", "2026-10-02T04:00:00.000Z", [{ kind: "text", text: "start" }]],
      ["assistant", "2026-10-02T04:00:02.000Z", [{ kind: "text", text: "working" }]],
      ["user", "2026-10-02T04:00:05.000Z", [{ kind: "text", text: "also fix the tests" }]],
      ["assistant", "2026-10-02T04:00:10.000Z", [{ kind: "text", text: "on it" }]],
    ]);
  });

  it("drops a prompt cancelled before any reply when Claude Code re-sends it from the same parent", () => {
    // Claude Code 2.1.296 on send, Esc before any reply, then a re-send: the cancelled record
    // and the re-send are siblings under one parent, only bookkeeping lines between, and the
    // TUI shows only the re-send
    const turns = parseClaudeTranscript([
      JSON.stringify({ type: "user", uuid: "a35be47b", parentUuid: "07055903", timestamp: "2026-10-10T08:00:00.000Z", message: { role: "user", content: "apple 2-87" } }),
      JSON.stringify({ type: "attachment", attachment: { type: "file-history-snapshot" } }),
      JSON.stringify({ type: "last-prompt" }),
      JSON.stringify({ type: "user", uuid: "7477aa61", parentUuid: "07055903", timestamp: "2026-10-10T08:00:04.000Z", message: { role: "user", content: "cherry 2" } }),
      JSON.stringify({ type: "assistant", timestamp: "2026-10-10T08:00:06.000Z", message: { role: "assistant", content: [{ type: "text", text: "Cherry." }] } }),
    ].join("\n"));
    expect(turns).toEqual([
      { role: "user", ts: "2026-10-10T08:00:04.000Z", parts: [{ kind: "text", text: "cherry 2" }] },
      { role: "assistant", ts: "2026-10-10T08:00:06.000Z", end_ts: "2026-10-10T08:00:06.000Z", parts: [{ kind: "text", text: "Cherry." }] },
    ]);
  });

  it("keeps a prompt re-sent from the same parent when the first one was answered", () => {
    const turns = parseClaudeTranscript([
      JSON.stringify({ type: "user", uuid: "u1", parentUuid: "p", timestamp: "2026-10-10T08:00:00.000Z", message: { role: "user", content: "first" } }),
      JSON.stringify({ type: "assistant", timestamp: "2026-10-10T08:00:02.000Z", message: { role: "assistant", content: [{ type: "text", text: "one answer" }] } }),
      JSON.stringify({ type: "user", uuid: "u2", parentUuid: "p", timestamp: "2026-10-10T08:00:05.000Z", message: { role: "user", content: "second" } }),
    ].join("\n"));
    expect(turns.map((turn) => [turn.role, turn.parts[0]])).toEqual([
      ["user", { kind: "text", text: "first" }],
      ["assistant", { kind: "text", text: "one answer" }],
      ["user", { kind: "text", text: "second" }],
    ]);
  });

  it("keeps an unanswered prompt when the next one hangs from another parent", () => {
    // an ordinary next prompt's parent is the answer before it, not the earlier prompt's
    const turns = parseClaudeTranscript([
      JSON.stringify({ type: "user", uuid: "u1", parentUuid: "p", timestamp: "2026-10-10T08:00:00.000Z", message: { role: "user", content: "first" } }),
      JSON.stringify({ type: "user", uuid: "u2", parentUuid: "q", timestamp: "2026-10-10T08:00:05.000Z", message: { role: "user", content: "second" } }),
    ].join("\n"));
    expect(turns.map((turn) => [turn.role, turn.parts[0]])).toEqual([
      ["user", { kind: "text", text: "first" }],
      ["user", { kind: "text", text: "second" }],
    ]);
  });

  it("sees the cancelled prompt whether it was written as a string or as blocks", () => {
    const turns = parseClaudeTranscript([
      JSON.stringify({ type: "user", uuid: "u1", parentUuid: "p", timestamp: "2026-10-10T08:00:00.000Z", message: { role: "user", content: "string draft" } }),
      JSON.stringify({ type: "user", uuid: "u2", parentUuid: "p", timestamp: "2026-10-10T08:00:03.000Z", message: { role: "user", content: [{ type: "text", text: "block resend" }] } }),
      JSON.stringify({ type: "assistant", timestamp: "2026-10-10T08:00:04.000Z", message: { role: "assistant", content: [{ type: "text", text: "answer" }] } }),
      JSON.stringify({ type: "user", uuid: "u3", parentUuid: "a", timestamp: "2026-10-10T08:01:00.000Z", message: { role: "user", content: [{ type: "text", text: "block draft" }] } }),
      JSON.stringify({ type: "user", uuid: "u4", parentUuid: "a", timestamp: "2026-10-10T08:01:03.000Z", message: { role: "user", content: "string resend" } }),
      JSON.stringify({ type: "assistant", timestamp: "2026-10-10T08:01:05.000Z", message: { role: "assistant", content: [{ type: "text", text: "another" }] } }),
    ].join("\n"));
    expect(turns.map((turn) => [turn.role, turn.parts[0]])).toEqual([
      ["user", { kind: "text", text: "block resend" }],
      ["assistant", { kind: "text", text: "answer" }],
      ["user", { kind: "text", text: "string resend" }],
      ["assistant", { kind: "text", text: "another" }],
    ]);
  });

  it("hides the cancelled prompt on the live page too once its re-send arrives", () => {
    // Live records: user a35be47b parented on 07055903, cancelled before any reply (only
    // attachment/last-prompt bookkeeping after it), then re-send 7477aa61 on the same
    // parent and the answer. The re-send opens no new turn, so the cancelled record stays
    // inside the live tail the sibling rule reparses instead of settling visible.
    const root = mkdtempSync(join(tmpdir(), "herdr-resend-page-"));
    try {
      const path = join(root, "session.jsonl");
      const write = (...entries: unknown[]) => appendFileSync(path, entries.map((entry) => `${JSON.stringify(entry)}\n`).join(""));
      const prompt = (uuid: string, parentUuid: string, text: string, timestamp: string) =>
        ({ type: "user", uuid, parentUuid, timestamp, message: { role: "user", content: text } });
      const answer = (text: string, timestamp: string) =>
        ({ type: "assistant", timestamp, message: { role: "assistant", content: [{ type: "text", text }] } });
      const texts = (turns: ConversationTurn[]) => turns.flatMap((turn) => turn.parts.flatMap((part) => part.kind === "text" ? [part.text] : []));
      write(prompt("u0", "p0", "first ask", "2026-10-10T08:00:00.000Z"), answer("first answer", "2026-10-10T08:00:02.000Z"),
        prompt("a35be47b", "p1", "apple 2-87", "2026-10-10T08:01:00.000Z"),
        { type: "attachment", attachment: { type: "file-history-snapshot" } }, { type: "last-prompt" });
      expect(texts(transcriptPage("claude-transcript", path).turns)).toEqual(["first ask", "first answer", "apple 2-87"]);
      write(prompt("7477aa61", "p1", "cherry 2", "2026-10-10T08:01:04.000Z"), answer("Cherry.", "2026-10-10T08:01:06.000Z"));
      const warm = transcriptPage("claude-transcript", path);
      expect(texts(warm.turns)).toEqual(["first ask", "first answer", "cherry 2", "Cherry."]);
      forgetTranscriptState();
      expect(transcriptPage("claude-transcript", path).turns).toEqual(warm.turns);
      // an ordinary next prompt hangs from another parent and still opens a turn of its own
      write(prompt("u9", "p9", "next ask", "2026-10-10T08:02:00.000Z"));
      expect(texts(transcriptPage("claude-transcript", path).turns)).toEqual(["first ask", "first answer", "cherry 2", "Cherry.", "next ask"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
      forgetTranscriptState();
    }
  });

  describe("a rewound Claude conversation", () => {
    // Claude Code 2.1.304, recorded: apple and banana answered, /rewind to before apple, Restore
    // conversation, then "cherry" sent. Claude keeps the old turns in the file; the new prompt hangs
    // from apple's parent (null), so it opens the branch the session now follows. The attachments
    // keep their chain fields and type only; the request bookkeeping records are left out.
    const recorded = readFileSync(new URL("./fixtures/claude-rewind-2.1.304-fork.jsonl", import.meta.url), "utf8");
    const roots: string[] = [];
    afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); forgetTranscriptState(); });
    const file = (): string => {
      const root = mkdtempSync(join(tmpdir(), "herdr-rewind-"));
      roots.push(root);
      return join(root, "session.jsonl");
    };
    const prompts = (turns: ConversationTurn[]) => turns.filter((turn) => turn.role === "user").flatMap((turn) => turn.parts.flatMap((part) => part.kind === "text" ? [part.text] : []));
    const lines = recorded.split("\n").filter(Boolean);

    it("hides the turns a restore left behind once the next prompt forks", () => {
      const path = file();
      writeFileSync(path, recorded);
      expect(prompts(transcriptPage("claude-transcript", path).turns)).toEqual(["cherry"]);
    });

    it("follows the fork on the live page, and a cold read agrees", () => {
      const path = file();
      const fork = lines.findIndex((line) => line.includes('"content":"cherry"'));
      writeFileSync(path, `${lines.slice(0, fork).join("\n")}\n`);
      expect(prompts(transcriptPage("claude-transcript", path).turns)).toEqual(["apple", "banana"]);
      appendFileSync(path, `${lines.slice(fork).join("\n")}\n`);
      const warm = transcriptPage("claude-transcript", path);
      expect(prompts(warm.turns)).toEqual(["cherry"]);
      forgetTranscriptState();
      expect(transcriptPage("claude-transcript", path).turns).toEqual(warm.turns);
    });

    // the same restore, with a screenshot sent in place of "cherry": a prompt all the same, also
    // when the picture makes its record longer than the branch reader parses whole
    for (const size of [16, 900 * 1024]) it(`hides the turns a restore left behind when the next prompt is only a picture of ${size} bytes`, () => {
      const path = file();
      const png = Buffer.alloc(size);
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png);
      const picture = { type: "image", source: { type: "base64", media_type: "image/png", data: png.toString("base64") } };
      const entries = lines.map((line) => JSON.parse(line) as { message?: { content?: unknown } });
      const fork = entries.findIndex((entry) => entry.message?.content === "cherry");
      const write = (from: number, to: number) => appendFileSync(path, `${entries.slice(from, to).map((entry) => JSON.stringify(entry.message?.content === "cherry" ? { ...entry, message: { ...entry.message, content: [picture] } } : entry)).join("\n")}\n`);
      write(0, fork);
      expect(prompts(transcriptPage("claude-transcript", path).turns)).toEqual(["apple", "banana"]);
      write(fork, entries.length);
      const warm = transcriptPage("claude-transcript", path).turns;
      expect(prompts(warm)).toEqual([]);
      expect(warm[0]?.parts.map((part) => part.kind)).toEqual(["image"]);
      forgetTranscriptState();
      expect(transcriptPage("claude-transcript", path).turns).toEqual(warm);
    });

    it("hides the turns a restore left behind when a screenshot prompt crosses a cold read's window", () => {
      // a long session read cold: the picture's record starts in the first 16 MiB and ends past them
      const path = file();
      const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
      const rows = [JSON.stringify({ type: "user", uuid: id(0), parentUuid: null, message: { role: "user", content: "apple" } })];
      let size = rows[0]!.length + 1;
      let n = 1;
      for (; size < TRANSCRIPT_WINDOW_BYTES - 512 * 1024; n++) {
        rows.push(JSON.stringify({ type: "assistant", uuid: id(n), parentUuid: id(n - 1), message: { content: [{ type: "text", text: "x".repeat(200_000) }] } }));
        size += rows.at(-1)!.length + 1;
      }
      // the turn the restore goes back over, on the newest page
      rows.push(JSON.stringify({ type: "user", uuid: id(800), parentUuid: id(n - 1), message: { role: "user", content: "banana" } }));
      rows.push(JSON.stringify({ type: "assistant", uuid: id(801), parentUuid: id(800), message: { content: [{ type: "text", text: "banana answered" }], stop_reason: "end_turn" } }));
      size += rows.at(-2)!.length + rows.at(-1)!.length + 2;
      const png = Buffer.alloc(2 * 1024 * 1024);
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png);
      rows.push(JSON.stringify({ type: "user", uuid: id(900), parentUuid: null, message: { role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: png.toString("base64") } }] } }));
      expect(size + rows.at(-1)!.length).toBeGreaterThan(TRANSCRIPT_WINDOW_BYTES);
      rows.push(JSON.stringify({ type: "assistant", uuid: id(901), parentUuid: id(900), message: { content: [{ type: "text", text: "cherry answered" }], stop_reason: "end_turn" } }));
      writeFileSync(path, `${rows.join("\n")}\n`);
      forgetTranscriptState();
      const turns = transcriptPage("claude-transcript", path).turns;
      expect(prompts(turns)).toEqual([]);
      expect(turns.map((turn) => turn.parts.map((part) => part.kind === "text" ? part.text : part.kind))).toEqual([["image"], ["cherry answered"]]);
    });

    it("keeps the turns before a message rewound to in the middle", () => {
      // the same records, rewound to before banana instead: the next prompt hangs from apple's answer
      const path = file();
      const entries = lines.map((line) => JSON.parse(line) as { type?: string; uuid?: string; parentUuid?: string | null; message?: { content?: unknown } });
      const appleAnswer = entries.find((entry) => entry.type === "assistant")!.uuid!;
      const shifted = entries.map((entry) => entry.message?.content === "cherry" ? { ...entry, parentUuid: appleAnswer } : entry);
      writeFileSync(path, `${shifted.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
      expect(prompts(transcriptPage("claude-transcript", path).turns)).toEqual(["apple", "cherry"]);
    });

    it("a slash command's echo off the chain hides nothing when the conversation goes on from elsewhere", () => {
      // the echo hangs from q1, past q1's answer, but the next prompt continues from that answer: the
      // answer stays on Claude's active chain, so nothing between q1 and the echo is off the branch
      const path = file();
      const base = { isSidechain: false, userType: "external", cwd: "/p", sessionId: "s", version: "2.1.304", gitBranch: "", timestamp: "2026-10-20T10:00:00.000Z" };
      const answer = (uuid: string, parentUuid: string, text: string) => ({ ...base, parentUuid, type: "assistant", message: { role: "assistant", content: [{ type: "text", text }], stop_reason: "end_turn" }, uuid });
      writeFileSync(path, [
        { ...base, parentUuid: null, type: "user", message: { role: "user", content: "q1" }, uuid: "q1" },
        answer("a1", "q1", "Alpha answered."),
        { ...base, parentUuid: "q1", type: "system", subtype: "local_command", content: "<command-name>/context</command-name>\n            <command-message>context</command-message>\n            <command-args></command-args>", level: "info", uuid: "echo" },
        { ...base, parentUuid: "echo", type: "system", subtype: "local_command", content: "<local-command-stdout>Context Usage</local-command-stdout>", level: "info", uuid: "stdout" },
        { ...base, parentUuid: "a1", type: "user", message: { role: "user", content: "q2" }, uuid: "q2" },
        answer("a2", "q2", "Beta answered."),
      ].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
      const turns = transcriptPage("claude-transcript", path).turns;
      const answers = turns.filter((turn) => turn.role === "assistant").flatMap((turn) => turn.parts.flatMap((part) => part.kind === "text" ? [part.text] : []));
      expect(prompts(turns)).toEqual(["q1", "q2"]);
      expect(answers).toEqual(["Alpha answered.", "Beta answered."]);
    });

    it("follows a terminal restore continued through a slash command and an API error", () => {
      const path = file();
      const fork = lines.findIndex((line) => line.includes('"content":"cherry"'));
      writeFileSync(path, lines.slice(0, fork).join("\n") + "\n");
      expect(prompts(transcriptPage("claude-transcript", path).turns)).toEqual(["apple", "banana"]);
      const appleAnswer = lines.map((line) => JSON.parse(line)).find((entry) => entry.type === "assistant").uuid;
      const base = { isSidechain: false, timestamp: "2026-10-20T10:00:00.000Z" };
      appendFileSync(path, [
        { ...base, parentUuid: appleAnswer, type: "system", subtype: "local_command", content: "<command-name>/context</command-name>", uuid: "echo" },
        { ...base, parentUuid: "echo", type: "system", subtype: "local_command", content: "<local-command-stdout>Context Usage</local-command-stdout>", uuid: "stdout" },
        { ...base, parentUuid: "stdout", type: "user", message: { role: "user", content: "cherry" }, uuid: "cherry" },
        { ...base, parentUuid: "cherry", type: "assistant", isApiErrorMessage: true, message: { role: "assistant", content: [{ type: "text", text: "Invalid API key" }], stop_reason: "stop_sequence" }, uuid: "refused" },
      ].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
      const warm = transcriptPage("claude-transcript", path);
      expect(prompts(warm.turns)).toEqual(["apple", "cherry"]);
      forgetTranscriptState();
      expect(transcriptPage("claude-transcript", path).turns).toEqual(warm.turns);
    });

    it("a record off the chain that opens no turn hides nothing", () => {
      const path = file();
      writeFileSync(path, recorded);
      const first = transcriptPage("claude-transcript", path);
      appendFileSync(path, `${JSON.stringify({ parentUuid: null, isSidechain: false, type: "system", subtype: "informational", content: "x", uuid: "not-on-the-chain" })}\n`);
      expect(prompts(transcriptPage("claude-transcript", path).turns)).toEqual(prompts(first.turns));
    });

    it("a send cancelled before any reply and sent again moves no history", () => {
      // Esc before any reply, then the re-send from the same parent: the cancelled prompt holds no
      // answer, so the cancelled-prompt rule hides it and the history id stays (paging is kept)
      const path = file();
      const base = { isSidechain: false, userType: "external", cwd: "/p", sessionId: "s", version: "2.1.304", gitBranch: "" };
      const user = (uuid: string, parentUuid: string | null, content: string) => JSON.stringify({ parentUuid, ...base, type: "user", message: { role: "user", content }, uuid, timestamp: "2026-10-20T10:00:00.000Z" });
      const answer = (uuid: string, parentUuid: string, text: string) => JSON.stringify({ parentUuid, ...base, type: "assistant", message: { role: "assistant", content: [{ type: "text", text }], stop_reason: "end_turn" }, uuid, timestamp: "2026-10-20T10:00:01.000Z" });
      writeFileSync(path, [user("u1", null, "first"), answer("a1", "u1", "one"), user("u2", "a1", "cancelled"), JSON.stringify({ type: "last-prompt" })].join("\n") + "\n");
      const shown = transcriptPage("claude-transcript", path);
      appendFileSync(path, [user("u3", "a1", "re-sent"), answer("a3", "u3", "two")].join("\n") + "\n");
      const after = transcriptPage("claude-transcript", path);
      expect(after.history_id).toBe(shown.history_id);
      expect(prompts(after.turns)).toEqual(["first", "re-sent"]);
    });
  });

  describe("subagent notifications", () => {
    const roots: string[] = [];
    afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); forgetTranscriptState(); });
    const block = (summary: string, extra = "<result>found two issues</result>") =>
      `<task-notification>\n<task-id>a1</task-id>\n<tool-use-id>toolu_1</tool-use-id>\n<status>completed</status>\n<summary>${summary}</summary>\n${extra}\n</task-notification>`;
    /** the three records one completion is written as */
    const carriers = (content: string, timestamp: string) => [
      { type: "queue-operation", operation: "enqueue", timestamp, content },
      { type: "user", timestamp, message: { role: "user", content } },
      { type: "attachment", timestamp, attachment: { type: "queued_command", commandMode: "task-notification", prompt: content } },
    ];
    const read = (entries: unknown[], subagents?: Parameters<typeof parseClaudeTranscript>[2]) =>
      parseClaudeTranscript(entries.map((entry) => JSON.stringify(entry)).join("\n"), MAX_TURNS, subagents);
    const start = { type: "user", timestamp: "2026-10-05T00:00:00.000Z", message: { role: "user", content: "review it" } };

    it("deduplicates across settled/live boundaries without suppressing resumed completions or later pages", () => {
      const root = mkdtempSync(join(tmpdir(), "herdr-subagent-page-")); roots.push(root);
      const path = join(root, "s1.jsonl");
      const write = (...entries: unknown[]) => appendFileSync(path, entries.map((entry) => JSON.stringify(entry) + "\n").join(""));
      const prompt = (n: number) => ({ ...start, message: { role: "user", content: `prompt ${n}` } });
      const notices = carriers(block('Agent "Review" finished'), "2026-10-05T00:01:00.000Z");
      const cards = (answer: ReturnType<typeof transcriptPage>) => answer.turns.flatMap((turn) => turn.parts).filter((part) => part.kind === "task_result");
      write(prompt(1), notices[0], prompt(2), notices[1]);
      expect(cards(transcriptPage("claude-transcript", path))).toHaveLength(1);
      write(notices[2]);
      expect(cards(transcriptPage("claude-transcript", path))).toHaveLength(1);
      write(prompt(3));
      const warm = transcriptPage("claude-transcript", path);
      forgetTranscriptState();
      expect(transcriptPage("claude-transcript", path).turns).toEqual(warm.turns);
      write(...carriers(block('Agent "Review" finished').replace("toolu_1", "toolu_2"), "2026-10-05T00:02:00.000Z"));
      expect(cards(transcriptPage("claude-transcript", path))).toHaveLength(2);
      // Reparse the live suffix after another append; its dedup set must not persist across polls.
      write({ type: "assistant", message: { content: [{ type: "text", text: "answer" }] } });
      expect(cards(transcriptPage("claude-transcript", path))).toHaveLength(2);
      // Slide the page start past the first carrier. Deduplication belongs to the requested page.
      for (let n = 4; n < MAX_TURNS + 4; n++) write(prompt(n));
      write(notices[1]);
      const newest = transcriptPage("claude-transcript", path);
      expect(cards(newest)).toHaveLength(1);
      const older = transcriptPage("claude-transcript", path, { before: newest.cursor! });
      forgetTranscriptState();
      expect(transcriptPage("claude-transcript", path).turns).toEqual(newest.turns);
      expect(transcriptPage("claude-transcript", path, { before: newest.cursor! }).turns).toEqual(older.turns);
    });

    it("draws a queue-only completion before the active turn, but not its removal", () => {
      const content = block('Agent "Review the parser" finished');
      const turn = { type: "assistant", timestamp: "2026-10-05T00:00:01.000Z", message: { role: "assistant", stop_reason: "tool_use", content: [{ type: "tool_use", id: "toolu_1", name: "Agent", input: {} }] } };
      const queued = { type: "queue-operation", operation: "enqueue", timestamp: "2026-10-05T00:01:00.000Z", content };
      const turns = read([start, turn, queued]);
      expect(turns.map((entry) => entry.parts.map((part) => part.kind).join())).toEqual(["text", "task_result", "tool"]);
      expect(turns[1]?.parts[0]).toMatchObject({ kind: "task_result", tasks: [{ id: "a1", status: "completed", result: "found two issues" }] });
      expect(read([start, turn, { ...queued, operation: "remove" }]).flatMap((entry) => entry.parts).filter((part) => part.kind === "task_result")).toEqual([]);
    });

    it("skips garbled lines and incomplete notification envelopes without a success card", () => {
      const content = block('Agent "Review the parser" finished').replace("</task-notification>", "");
      const transcript = `null\n42\n{garbled\n${JSON.stringify(start)}\n${JSON.stringify({ type: "user", message: { content } })}\n{"type":`;
      expect(parseClaudeTranscript(transcript)).toEqual(read([start]));
    });

    it("becomes one task_result however many records carry it, and starts a turn of its own", () => {
      const turns = read([
        start,
        { type: "assistant", timestamp: "2026-10-05T00:00:01.000Z", message: { role: "assistant", content: [{ type: "text", text: "started a reviewer" }] } },
        ...carriers(block('Agent "Review the parser" finished'), "2026-10-05T00:01:00.000Z"),
        { type: "assistant", timestamp: "2026-10-05T00:01:02.000Z", message: { role: "assistant", content: [{ type: "text", text: "it found two" }] } },
      ], { subagents: new Map([["a1", { title: "Review parser fix", agent: "reviewer" }]]) });
      expect(turns.map((turn) => turn.role)).toEqual(["user", "assistant", "user", "assistant"]);
      expect(turns[2]).toEqual({ role: "user", ts: "2026-10-05T00:01:00.000Z", parts: [{ kind: "task_result", tasks: [{
        id: "a1", title: "Review parser fix", agent: "reviewer", model: null, status: "completed",
        duration_ms: null, turns: null, tool_calls: null, tokens: null, result: "found two issues",
      }] }] });
    });

    it("draws a notice that shares an entry with a tool's result once, before the turn still at work", () => {
      const notice = block('Agent "Review the parser" finished');
      const entries = [
        start,
        { type: "assistant", timestamp: "2026-10-05T00:00:01.000Z", message: { role: "assistant", content: [{ type: "tool_use", id: "toolu_9", name: "Bash", input: { command: "ls" } }] } },
        { type: "user", timestamp: "2026-10-05T00:01:00.000Z", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_9", content: "a.ts" }, { type: "text", text: notice }] } },
        { type: "assistant", timestamp: "2026-10-05T00:01:01.000Z", message: { role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: "finished" }] } },
      ];
      for (const turns of [read(entries), read([...entries, ...carriers(notice, "2026-10-05T00:01:00.000Z")])]) {
        expect(turns.map((turn) => turn.parts.map((part) => part.kind).join())).toEqual(["text", "task_result", "tool,text"]);
        const tool = turns[2]?.parts[0];
        expect(tool?.kind === "tool" ? tool.output : tool).toBe("a.ts");
      }
    });

    it("takes a page's card from the subagent's meta file alone, so it reads the same however the subagent's transcript has grown", () => {
      const root = mkdtempSync(join(tmpdir(), "herdr-subagent-page-")); roots.push(root);
      const path = join(root, "s1.jsonl");
      mkdirSync(join(root, "s1", "subagents"), { recursive: true });
      writeFileSync(join(root, "s1", "subagents", "agent-a1.meta.json"), JSON.stringify({ agentType: "reviewer", description: "Review parser fix", toolUseId: "toolu_1", requestShape: "background" }));
      const work = join(root, "s1", "subagents", "agent-a1.jsonl");
      writeFileSync(work, JSON.stringify({ type: "assistant", timestamp: "2026-10-05T00:00:20.000Z", message: { id: "m1", content: [] } }) + "\n");
      writeFileSync(path, [start, ...carriers(block('Agent "Review the parser" finished'), "2026-10-05T00:01:00.000Z")].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
      const card = () => { forgetTranscriptState(); return transcriptPage("claude-transcript", path).turns.flatMap((turn) => turn.parts).find((candidate) => candidate.kind === "task_result"); };
      const before = card();
      expect(before?.kind === "task_result" ? before.tasks[0] : before).toMatchObject({ title: "Review parser fix", agent: "reviewer", turns: null, tokens: null, duration_ms: null });
      // the agent goes on working: the card does not change with it
      appendFileSync(work, JSON.stringify({ type: "assistant", timestamp: "2026-10-05T00:09:00.000Z", message: { id: "m2", content: [] } }) + "\n");
      expect(card()).toEqual(before);
    });

    it("reads no file for an id that a tool's output quoted with the tag", () => {
      const root = mkdtempSync(join(tmpdir(), "herdr-subagent-page-")); roots.push(root);
      const path = join(root, "s1.jsonl");
      mkdirSync(join(root, "s1", "subagents"), { recursive: true });
      writeFileSync(join(root, "secret.meta.json"), JSON.stringify({ description: "SECRET", agentType: "x" }));
      const quoted = block('Agent "Hostile" finished').replace("<task-id>a1", "<task-id>x/../../secret");
      writeFileSync(path, [start,
        { type: "user", timestamp: "2026-10-05T00:00:30.000Z", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: quoted }] } },
        ...carriers(block('Agent "Real" finished'), "2026-10-05T00:01:00.000Z"),
      ].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
      const cards = transcriptPage("claude-transcript", path).turns.flatMap((turn) => turn.parts).filter((part) => part.kind === "task_result");
      expect(JSON.stringify(cards)).not.toContain("SECRET");
      expect(cards).toHaveLength(1);
    });

    it("falls back to the summary's name and leaves out what no file told", () => {
      const turns = read(carriers(block('Agent "Security review" finished'), "2026-10-05T00:01:00.000Z"));
      expect(turns).toHaveLength(1);
      expect(turns[0]?.parts).toEqual([{ kind: "task_result", tasks: [{ id: "a1", title: "Security review", agent: null, model: null, status: "completed", duration_ms: null, turns: null, tool_calls: null, tokens: null, result: "found two issues" }] }]);
    });

    it("counts a resumed agent's next notification, which carries another tool-use id", () => {
      const again = block('Agent "Review" finished').replace("toolu_1", "toolu_2");
      const turns = read([...carriers(block('Agent "Review" finished'), "2026-10-05T00:01:00.000Z"), ...carriers(again, "2026-10-05T00:05:00.000Z")]);
      expect(turns.map((turn) => turn.ts)).toEqual(["2026-10-05T00:01:00.000Z", "2026-10-05T00:05:00.000Z"]);
    });

    it("cuts a long answer at the same limit as OmO's", () => {
      const turns = read(carriers(block('Agent "Long" finished', `<result>${"x".repeat(16_001)}</result>`), "2026-10-05T00:01:00.000Z"));
      const part = turns[0]?.parts[0];
      expect(part?.kind === "task_result" ? [part.tasks[0]?.result.length, part.tasks[0]?.result_cut] : part).toEqual([16_000, true]);
    });

    it("keeps a failed or stopped agent's status and hides a background command's notice", () => {
      const stopped = block('Agent "Cleanup" was stopped by Claude', "").replace("<status>completed", "<status>killed");
      const turns = read([...carriers(stopped, "2026-10-05T00:01:00.000Z"), ...carriers(block('Background command "sleep 5" completed (exit code 0)', ""), "2026-10-05T00:02:00.000Z")]);
      expect(turns).toHaveLength(1);
      expect(turns[0]?.parts[0]).toMatchObject({ kind: "task_result", tasks: [{ title: "Cleanup", status: "cancelled", result: "" }] });
    });
  });

  it("preserves array user text, including mixed tool results, without exposing bookkeeping", () => {
    const transcript = [
      { type: "assistant", message: { content: [{ type: "tool_use", id: "t", name: "Read", input: {} }] } },
      { type: "user", message: { content: [null, { type: "tool_result", tool_use_id: "t", content: "result" }, { type: "text", text: "Actual request" }] } },
      { type: "user", message: { content: [{ type: "text", text: "<command-name>/clear</command-name>" }] } },
      { type: "user", isMeta: true, message: { content: "internal reminder" } },
      { type: "user", isCompactSummary: true, message: { content: "compacted context" } },
      null,
    ].map((entry) => JSON.stringify(entry)).join("\n");
    const turns = parseClaudeTranscript(transcript);
    // the compaction is no bookkeeping: it marks where the conversation was folded
    expect(turns).toHaveLength(3);
    expect(turns[0]?.parts[0]).toMatchObject({ kind: "tool", output: "result" });
    expect(turns[1]?.parts).toEqual([{ kind: "text", text: "Actual request" }]);
    expect(turns[2]?.parts).toEqual([{ kind: "compact", text: "compacted context" }]);
  });
});

/** Minimal but shape-true slices of an omp session jsonl. */
const ompLines = [
  JSON.stringify({ type: "title", v: 1, title: "프로젝트 불편사항 패치" }),
  JSON.stringify({ type: "session", version: 3, id: "01a0bdf7-b9e3-72bb-bad1-671dde7082f8" }),
  JSON.stringify({ type: "message", timestamp: "2026-09-20T08:39:00.000Z", message: { role: "user", attribution: "user", content: [
    { type: "text", text: "주소좀 줘봐" },
  ] } }),
  JSON.stringify({ type: "message", timestamp: "2026-09-20T08:39:02.000Z", message: { role: "assistant", content: [
    { type: "thinking", text: "internal reasoning stays private" },
    { type: "thinking", thinking: "alternate thinking field" },
    { type: "toolCall", id: "call_1", name: "bash", arguments: { command: "ss -tlnp", i: "Checking ports" }, intent: "Checking ports" },
  ] } }),
  JSON.stringify({ type: "message", timestamp: "2026-09-20T08:39:03.000Z", message: { role: "toolResult", toolCallId: "call_1", toolName: "bash", isError: false, content: [
    { type: "text", text: "LISTEN 0 512 100.123.228.51:7317" },
  ] } }),
  JSON.stringify({ type: "message", timestamp: "2026-09-20T08:39:05.000Z", message: { role: "assistant", content: [
    { type: "text", text: "http://100.123.228.51:7317" },
  ] } }),
  JSON.stringify({ type: "message", timestamp: "2026-09-20T08:40:00.000Z", message: { role: "user", content: [
    { type: "image", blob: "..." },
  ] } }),
].join("\n");

describe("parseOmpTranscript", () => {
  it("builds user and merged assistant turns with folded tool results", () => {
    const turns = parseOmpTranscript(ompLines);
    expect(turns).toEqual([
      { role: "user", ts: "2026-09-20T08:39:00.000Z", parts: [{ kind: "text", text: "주소좀 줘봐" }] },
      { role: "assistant", ts: "2026-09-20T08:39:02.000Z", end_ts: "2026-09-20T08:39:05.000Z", parts: [
        { kind: "thinking", text: "internal reasoning stays private" },
        { kind: "thinking", text: "alternate thinking field" },
        { kind: "tool", name: "bash", summary: "Checking ports", input: expect.stringContaining("ss -tlnp"), output: "LISTEN 0 512 100.123.228.51:7317" },
        { kind: "text", text: "http://100.123.228.51:7317" },
      ] },
    ]);
  });

  it("keeps thinking parts while ignoring title/session headers", () => {
    const rendered = JSON.stringify(parseOmpTranscript(ompLines));
    expect(rendered).toContain("\"kind\":\"thinking\",\"text\":\"internal reasoning stays private\"");
    expect(rendered).toContain("\"kind\":\"thinking\",\"text\":\"alternate thinking field\"");
    expect(rendered).not.toContain("프로젝트 불편사항 패치");
  });

  it("skips an image-only user part instead of an empty turn", () => {
    const turns = parseOmpTranscript(ompLines);
    expect(turns.filter((turn) => turn.role === "user")).toHaveLength(1);
  });

  it("falls back to the first interesting argument when a toolCall has no intent", () => {
    const noIntent = [
      JSON.stringify({ type: "message", message: { role: "assistant", content: [
        { type: "toolCall", id: "c", name: "read", arguments: { file_path: "/tmp/x" } },
      ] } }),
    ].join("\n");
    const tool = parseOmpTranscript(noIntent)[0]?.parts[0];
    expect(tool && tool.kind === "tool" ? tool.summary : "").toBe("/tmp/x");
  });

  it("survives a torn tail line while omp is mid-append", () => {
    expect(parseOmpTranscript(`${ompLines}\n{"type":"mess`).length).toBe(2);
  });

  it("trims a huge tool result and caps the turn list", () => {
    const big = [
      JSON.stringify({ type: "message", message: { role: "assistant", content: [
        { type: "toolCall", id: "t", name: "bash", arguments: { command: "cat /etc/big" } },
      ] } }),
      JSON.stringify({ type: "message", message: { role: "toolResult", toolCallId: "t", content: [
        { type: "text", text: "x".repeat(10_000) },
      ] } }),
    ].join("\n");
    const tool = parseOmpTranscript(big)[0]?.parts[0];
    expect(tool && tool.kind === "tool" ? tool.output.length : 0).toBeLessThanOrEqual(4100);

    const many = Array.from({ length: MAX_TURNS + 50 }, (_, i) =>
      JSON.stringify({ type: "message", message: { role: "user", content: [{ type: "text", text: `m${i}` }] } }),
    ).join("\n");
    expect(parseOmpTranscript(many).length).toBe(MAX_TURNS);
  });
});

describe("omo transcript resolution", () => {
  it("recognizes omo from a pane's foreground processes, not from herdr's label", () => {
    // argv exactly as herdr's pane.process_info reported them for an omo pane
    expect(isOmoProcess(["node", "/home/u/.nvm/versions/node/v24.18.0/bin/omo"])).toBeTrue();
    expect(isOmoProcess(["bun", "/home/u/lib/node_modules/omo-ai/bin/omo.js"])).toBeTrue();
    expect(isOmoProcess(["bun", "/home/u/lib/node_modules/omo-ai/node_modules/@code-yeongyu/senpi/dist/bundle/cli.js", "--extension", "/home/u/lib/node_modules/omo-ai/plugin"])).toBeTrue();
    // the pane herdr labels `claude` because of omo's child still names omo
    expect(isOmoProcess(["/home/u/lib/node_modules/omo-ai/node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude", "--output-format", "stream-json"])).toBeTrue();

    expect(isOmoProcess(["/home/u/.local/bin/claude"])).toBeFalse();
    expect(isOmoProcess(["omp"])).toBeFalse();
    expect(isOmoProcess(["node", "/home/u/omo-tools/watch.js"])).toBeFalse();
    // a shell rc file printing a PATH that has omo-ai's bin directory in it
    expect(isOmoProcess(["printf", "%s\\n", "/home/u/.local/bin:/home/u/lib/node_modules/omo-ai/node_modules/.bin:/usr/bin"])).toBeFalse();
    expect(isOmoProcess(["printf", "%s\\n", "/usr/bin:/home/u/.nvm/versions/node/v24.18.0/bin/omo"])).toBeFalse();
  });
});

describe("omp session store", () => {
  it("accepts the path herdr reports only inside the user's own store", () => {
    const home = "/home/u", store = "/home/u/.omp/agent/sessions";
    expect(ompSessionStore(`${store}/project/session.jsonl`, home)).toBe(store);
    expect(ompSessionStore(`${store}-evil/project/session.jsonl`, home)).toBeNull();
    expect(ompSessionStore(`${store}/../../../../etc/session.jsonl`, home)).toBeNull();
    expect(ompSessionStore(`${store}/project/notes.txt`, home)).toBeNull();
    expect(ompSessionStore(".omp/agent/sessions/project/session.jsonl", home)).toBeNull();
    expect(ompSessionStore(undefined, home)).toBeNull();
  });

  it("accepts an `omp --profile` store, and only its sessions directory", () => {
    const home = "/home/u", profiles = "/home/u/.omp/profiles", store = `${profiles}/personal/agent/sessions`;
    expect(ompSessionStore(`${store}/-project/session.jsonl`, home)).toBe(store);
    expect(ompSessionStore(`${store}/session.jsonl`, home)).toBe(store);
    expect(ompSessionStore(`${profiles}/personal/agent/session.jsonl`, home)).toBeNull();
    expect(ompSessionStore(`${profiles}/personal/agent/logs/x/session.jsonl`, home)).toBeNull();
    expect(ompSessionStore(`${profiles}/personal/session.jsonl`, home)).toBeNull();
    expect(ompSessionStore(`${profiles}/session.jsonl`, home)).toBeNull();
    expect(ompSessionStore(`${profiles}/../agent/sessions-evil/x/session.jsonl`, home)).toBeNull();
    expect(ompSessionStore(`${profiles}/personal/agent/sessions/../../../../../etc/session.jsonl`, home)).toBeNull();
    expect(ompSessionStore(`${profiles}-evil/personal/agent/sessions/x/session.jsonl`, home)).toBeNull();
  });

  it("accepts a Windows PC's native path, and refuses the same ways out", () => {
    const home = "C:\\Users\\u", store = "C:\\Users\\u\\.omp\\agent\\sessions";
    const session = `${store}\\project\\session.jsonl`;
    expect(ompSessionStore(session, home, win32)).toBe(store);
    expect(ompSessionStore(session.replaceAll("\\", "/"), home, win32)).toBe(store);
    expect(ompSessionStore(`${store}-evil\\project\\session.jsonl`, home, win32)).toBeNull();
    expect(ompSessionStore(`${store}\\..\\sessions-evil\\session.jsonl`, home, win32)).toBeNull();
    expect(ompSessionStore(`${store}\\project\\..\\..\\..\\..\\session.jsonl`, home, win32)).toBeNull();
    expect(ompSessionStore(`D:${session.slice(2)}`, home, win32)).toBeNull();
    expect(ompSessionStore(`\\\\server\\share\\.omp\\agent\\sessions\\session.jsonl`, home, win32)).toBeNull();
    expect(ompSessionStore(`${store}\\project\\notes.txt`, home, win32)).toBeNull();
    const profile = "C:\\Users\\u\\.omp\\profiles\\work\\agent\\sessions";
    expect(ompSessionStore(`${profile}\\project\\session.jsonl`, home, win32)).toBe(profile);
    expect(ompSessionStore(`C:\\Users\\u\\.omp\\profiles\\work\\session.jsonl`, home, win32)).toBeNull();
  });
});

describe("gjc sessions", () => {
  const roots: string[] = [];
  afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
  const session = (dir: string, name: string, cwd: string, mtime: string) => {
    mkdirSync(dir, { recursive: true });
    const path = join(dir, name);
    writeFileSync(path, `${JSON.stringify({ type: "session", version: 5, cwd })}\n`);
    utimesSync(path, new Date(mtime), new Date(mtime));
    return path;
  };

  it("does not infer a session from cwd, even if there is only one file", async () => {
    const home = mkdtempSync(join(tmpdir(), "herdr-gjc-")); roots.push(home);
    const dir = join(home, ".gjc", "agent", "sessions", "v2-abc");
    session(dir, "only.jsonl", "/home/u/project", "2026-09-20T00:00:00.000Z");
    writeFileSync(join(dir, ".gjc-managed-session-scope.v2.json"), JSON.stringify({ canonicalPath: "/home/u/project" }));
    await expect(gjcTranscriptPath("w9999:p9999", "/home/u/project", home)).rejects.toThrow(ConversationUnavailable);
  });

  it("carries each tool call's own id, so a rewind that calls the same tool again is no continuation", () => {
    const home = mkdtempSync(join(tmpdir(), "herdr-gjc-ids-")); roots.push(home);
    const path = join(home, "session.jsonl");
    const line = (timestamp: string, message: Record<string, unknown>) => JSON.stringify({ type: "message", timestamp, message });
    const read = (id: string, at: string, file: string, text: string[] = []) => line(at, { role: "assistant", stopReason: "toolUse", content: [
      ...text.map((words) => ({ type: "text", text: words })), { type: "toolCall", id, name: "read", arguments: { path: file } },
    ] });
    const opening = [
      line("2026-10-25T00:00:00.000Z", { role: "user", content: [{ type: "text", text: "Read the files." }] }),
      read("c1", "2026-10-25T00:00:01.000Z", "src/alpha.ts", ["Reading."]),
    ];
    const page = (records: string[]) => { writeFileSync(path, `${records.join("\n")}\n`); forgetTranscriptState(); return transcriptPage("gjc-transcript", path); };
    try {
      const shown = page([...opening, read("c2", "2026-10-25T00:00:02.000Z", "src/beta.ts")]);
      expect(shown.turns.at(-1)!.parts.flatMap((part) => part.kind === "tool" ? [part.call_id] : [])).toEqual(["c1", "c2"]);
      // written again with the same calls (a trim): the chat goes on
      expect(continuesHistory(shown, page([...opening, read("c2", "2026-10-25T00:00:02.000Z", "src/beta.ts")]))).toBe(true);
      // a rewind that read the same file again under another call, later, in the turn that keeps its start
      expect(continuesHistory(shown, page([...opening, read("c3", "2026-10-25T00:00:05.000Z", "src/beta.ts")]))).toBe(false);
    } finally { forgetTranscriptState(); }
  });

  it("shows a failed request's error instead of an empty answer", () => {
    const text = [
      JSON.stringify({ type: "message", timestamp: "2026-09-25T00:00:00.000Z", message: { role: "user", content: [{ type: "text", text: "hi" }] } }),
      JSON.stringify({ type: "message", timestamp: "2026-09-25T00:00:01.000Z", message: { role: "assistant", content: [], stopReason: "error", errorMessage: "401 Authentication Failed" } }),
    ].join("\n");
    expect(parseOmpTranscript(text).at(-1)?.parts).toEqual([{ kind: "text", text: "Error: 401 Authentication Failed", failed: true }]);
  });

  it("keeps each failed request apart from the attempt that followed it in the same turn", () => {
    const failure = (at: string, error: string) => JSON.stringify({ type: "message", timestamp: at, message: { role: "assistant", content: [], stopReason: "error", errorMessage: error } });
    const text = [
      JSON.stringify({ type: "message", timestamp: "2026-09-25T00:00:00.000Z", message: { role: "user", content: [{ type: "text", text: "hi" }] } }),
      failure("2026-09-25T00:00:01.000Z", "503 overloaded"),
      failure("2026-09-25T00:00:05.000Z", "Connection error."),
      JSON.stringify({ type: "message", timestamp: "2026-09-25T00:00:09.000Z", message: { role: "assistant", content: [{ type: "text", text: "hello" }], stopReason: "stop" } }),
    ].join("\n");
    expect(parseOmpTranscript(text).at(-1)?.parts).toEqual([
      { kind: "text", text: "Error: 503 overloaded", failed: true },
      { kind: "text", text: "Error: Connection error.", failed: true },
      { kind: "text", text: "hello", phase: "final_answer" },
    ]);
  });

  it("carries the token counts a compaction record states, and none it does not", () => {
    const compaction = (extra: Record<string, unknown>) => JSON.stringify({ type: "compaction", id: "c1", parentId: "u1", timestamp: "2026-09-25T00:00:02.000Z", summary: "folded", firstKeptEntryId: "u1", ...extra });
    const card = (extra: Record<string, unknown>) => parseOmpTranscript(compaction(extra)).at(-1)?.parts;
    // OmO: the tokens before, and what its structural pass saved (senpi.compaction.summary.v1)
    expect(card({ tokensBefore: 761969, details: { schema: "senpi.compaction.summary.v1", tokenEstimate: 736131, structuralYield: { savedTokens: 493241, savingsRatio: 0.65, tokensBefore: 761969 }, origin: "core-route" }, fromHook: true }))
      .toEqual([{ kind: "compact", text: "folded", tokens_before: 761969, tokens_saved: 493241 }]);
    // omp's handoff records the size after; a zero before is no count
    expect(card({ tokensBefore: 0, tokensAfter: 7189, method: "handoff" })).toEqual([{ kind: "compact", text: "folded", tokens_after: 7189 }]);
    expect(card({ tokensBefore: "many", details: { structuralYield: { savedTokens: -3 } } })).toEqual([{ kind: "compact", text: "folded" }]);
  });

  it("hides agent-attributed IRC deliveries without hiding quoted user text or adding a page boundary", () => {
    const irc = (customType: string, content: string, details: Record<string, string>) => JSON.stringify({
      type: "custom_message", customType, display: true, content, details, attribution: "agent", timestamp: "2026-10-01T00:00:01.000Z",
    });
    const quoted = "I saw these messages in the transcript:\n[IRC `0-WindowsPaths` → you]\nMy bash is restricted...\n[IRC you → `0-WindowsPaths` (auto)]";
    const text = [
      JSON.stringify({ type: "message", timestamp: "2026-10-01T00:00:00.000Z", message: { role: "user", content: [{ type: "text", text: quoted }] } }),
      irc("irc:incoming", "[IRC `0-WindowsPaths` → you]\n\nMy bash is restricted...", { observationId: "incoming-1", from: "0-WindowsPaths", message: "My bash is restricted..." }),
      irc("irc:autoreply", "[IRC you → `0-WindowsPaths` (auto)]\n\nI will handle it.", { observationId: "reply-1", to: "0-WindowsPaths", reply: "I will handle it." }),
      irc("irc:relay", "[IRC `you` → `0-WindowsPaths`]\n\nI will handle it.", { observationId: "relay-1", from: "you", to: "0-WindowsPaths", body: "I will handle it.", kind: "reply" }),
      JSON.stringify({ type: "message", timestamp: "2026-10-01T00:00:02.000Z", message: { role: "assistant", content: [{ type: "text", text: "I will handle it." }] } }),
    ].join("\n");
    const home = mkdtempSync(join(tmpdir(), "herdr-gjc-irc-")); roots.push(home);
    const path = join(home, "session.jsonl");
    writeFileSync(path, `${text}\n`);
    try {
      expect(transcriptPage("gjc-transcript", path).turns).toEqual([
        { role: "user", ts: "2026-10-01T00:00:00.000Z", parts: [{ kind: "text", text: quoted }] },
        { role: "assistant", ts: "2026-10-01T00:00:02.000Z", end_ts: "2026-10-01T00:00:02.000Z", parts: [{ kind: "text", text: "I will handle it." }] },
      ]);
    } finally { forgetTranscriptState(); }
  });

  it("hides IRC deliveries a gjc build older than their attribution wrote (#1541)", () => {
    const delivery = (customType: string, content: string) => JSON.stringify({ type: "custom_message", customType, display: true, content });
    const text = [
      JSON.stringify({ type: "message", timestamp: "2026-10-01T00:00:00.000Z", message: { role: "user", content: [{ type: "text", text: "coordinate with the other pane" }] } }),
      delivery("irc:incoming", "[IRC `0-WindowsPaths` → you]\n\nMy bash is restricted..."),
      delivery("irc:autoreply", "[IRC you → `0-WindowsPaths` (auto)]\n\nI will handle it."),
      delivery("irc:relay", "[IRC `you` → `0-WindowsPaths`]\n\nI will handle it."),
      JSON.stringify({ type: "message", timestamp: "2026-10-01T00:00:02.000Z", message: { role: "assistant", content: [{ type: "text", text: "Done." }] } }),
    ].join("\n");
    expect(parseOmpTranscript(text).map((turn) => turn.parts)).toEqual([
      [{ kind: "text", text: "coordinate with the other pane" }],
      [{ kind: "text", text: "Done." }],
    ]);
  });

  it("keeps user-attributed IRC records and ordinary notices whose text quotes IRC", () => {
    const content = "[IRC `0-WindowsPaths` → you]\n\nA quoted example, not an internal delivery.";
    const text = [
      { type: "custom_message", customType: "irc:incoming", attribution: "user", display: true, content },
      { type: "custom_message", customType: "async-result", attribution: "agent", display: true, content },
    ].map((entry) => JSON.stringify(entry)).join("\n");
    expect(parseOmpTranscript(text).map((turn) => turn.parts)).toEqual([
      [{ kind: "notice", text: content, source: "irc:incoming" }],
      [{ kind: "notice", text: content, source: "async-result" }],
    ]);
  });

  it("ends a turn at a background result gjc delivers, so the answer before it stays the answer", () => {
    const assistant = (ts: string, text: string) => JSON.stringify({ type: "message", timestamp: ts, message: { role: "assistant", content: [{ type: "text", text }] } });
    const text = [
      JSON.stringify({ type: "message", timestamp: "2026-10-01T00:00:00.000Z", message: { role: "user", content: [{ type: "text", text: "run it in the background" }] } }),
      assistant("2026-10-01T00:00:01.000Z", "Started; here is the summary."),
      JSON.stringify({ type: "custom_message", customType: "async-result", display: true, timestamp: "2026-10-01T00:05:00.000Z", content: "<system-notice>\nBackground job bg_1 has completed.\nPASS all\n</system-notice>" }),
      assistant("2026-10-01T00:05:02.000Z", "CI is green."),
      JSON.stringify({ type: "custom_message", customType: "async-result", display: false, timestamp: "2026-10-01T00:06:00.000Z", content: "<system-notice>hidden</system-notice>" }),
      JSON.stringify({ type: "custom", customType: "workflow-intent-diff", data: { route: "direct" } }),
      assistant("2026-10-01T00:06:01.000Z", "Still green."),
    ].join("\n");
    expect(parseOmpTranscript(text)).toEqual([
      { role: "user", ts: "2026-10-01T00:00:00.000Z", parts: [{ kind: "text", text: "run it in the background" }] },
      { role: "assistant", ts: "2026-10-01T00:00:01.000Z", end_ts: "2026-10-01T00:00:01.000Z", parts: [{ kind: "text", text: "Started; here is the summary." }] },
      { role: "user", ts: "2026-10-01T00:05:00.000Z", parts: [{ kind: "notice", text: "Background job bg_1 has completed.\nPASS all", source: "async-result" }] },
      { role: "assistant", ts: "2026-10-01T00:05:02.000Z", end_ts: "2026-10-01T00:06:01.000Z", parts: [{ kind: "text", text: "CI is green." }, { kind: "text", text: "Still green." }] },
    ]);
  });

  it("ends a turn at an answer that stopped, so a hidden wake-up's work does not fold that answer away", () => {
    // omo 5.x: a monitor notification (display:false) wakes the agent after its final answer
    const assistant = (ts: string, stopReason: string, content: unknown[]) => JSON.stringify({ type: "message", timestamp: ts, message: { role: "assistant", content, stopReason } });
    const text = [
      JSON.stringify({ type: "message", timestamp: "2026-10-05T22:09:00.000Z", message: { role: "user", content: [{ type: "text", text: "review #368" }] } }),
      assistant("2026-10-05T22:09:15.000Z", "toolUse", [{ type: "toolCall", id: "c1", name: "read", arguments: { path: "a.ts" } }]),
      JSON.stringify({ type: "message", timestamp: "2026-10-05T22:09:16.000Z", message: { role: "toolResult", toolCallId: "c1", content: [{ type: "text", text: "ok" }] } }),
      assistant("2026-10-05T22:14:54.000Z", "stop", [{ type: "thinking", thinking: "done" }, { type: "text", text: "The full review." }]),
      JSON.stringify({ type: "custom_message", customType: "senpi-monitor:notification", display: false, timestamp: "2026-10-05T22:14:54.500Z", content: "<system-reminder>READY</system-reminder>" }),
      assistant("2026-10-05T22:14:58.000Z", "stop", [{ type: "thinking", thinking: "nothing new" }, { type: "text", text: "Nothing new to do." }]),
    ].join("\n");
    const turns = parseOmpTranscript(text);
    expect(turns.map((turn) => turn.role)).toEqual(["user", "assistant", "assistant"]);
    expect(turns[1]!.parts.at(-1)).toEqual({ kind: "text", text: "The full review.", phase: "final_answer" });
    expect(turns[2]).toEqual({ role: "assistant", ts: "2026-10-05T22:14:58.000Z", end_ts: "2026-10-05T22:14:58.000Z", parts: [{ kind: "thinking", text: "nothing new" }, { kind: "text", text: "Nothing new to do.", phase: "final_answer" }] });
  });

  it("says which kind of notice the runtime delivered, and nothing where the runtime named none", () => {
    const notice = (fields: Record<string, unknown>) => JSON.stringify({ type: "custom_message", display: true, timestamp: "2026-10-01T00:00:00.000Z", ...fields });
    const text = [
      notice({ customType: "omo-model-profile:unavailable", content: "Model profile unavailable\nFalling back to the default." }),
      notice({ content: "<system-notice>unnamed</system-notice>" }),
    ].join("\n");
    expect(parseOmpTranscript(text).map((turn) => turn.parts)).toEqual([
      [{ kind: "notice", text: "Model profile unavailable\nFalling back to the default.", source: "omo-model-profile:unavailable" }],
      [{ kind: "notice", text: "unnamed" }],
    ]);
  });
});

describe("OmO background task results", () => {
  it("draws the background tasks an OmO wake reports as one card in the user's seat, titled by the call that started them", () => {
    const text = [
      omoUser("2026-10-05T00:00:00.000Z", "look into it"),
      omoSpawn("2026-10-05T00:00:01.000Z", "c1", { description: "record location", task_summary: "Find where task records live", subagent_type: "explore", prompt: "TASK: find" }, { task_id: "st_1", task_summary: "Find where task records live" }),
      omoSpawn("2026-10-05T00:00:02.000Z", "c2", { tasks: [{ task_summary: "Read shots 1-7", prompt: "a" }, { description: "shots 8-14", prompt: "b" }] }, { items: [{ task_id: "st_2", task_summary: "Read shots 1-7" }, { task_id: "st_3" }] }),
      omoWake("2026-10-05T00:01:00.000Z", [
        completion({ task_id: "st_1", name: "st_1", status: "completed", agent_type: "explore", resolved_model: { display: "lab/luna" }, model: "lab/luna-raw", duration_ms: 58_350, run_stats: { turns: 6, tool_calls: 14, total_tokens: 210_304 }, final_response: "**Found** it." }),
        completion({ task_id: "st_2", name: "st_2", status: "error", category: "visual-engineering", model: "lab/kimi", duration_ms: 9087, run_stats: { turns: 0, tool_calls: 0 }, final_response: "Invalid native tool call event order" }),
        // the batch result named no summary for it, and its name is its id: the agent it ran as
        completion({ task_id: "st_3", name: "st_3", status: "cancelled", category: "quick" }),
        completion({ task_id: "st_4", name: "named-run", status: "completed", final_response: "x".repeat(16_005) }),
      ]),
      JSON.stringify({ type: "message", timestamp: "2026-10-05T00:01:02.000Z", message: { role: "assistant", content: [{ type: "text", text: "The record lives in .omo." }] } }),
    ].join("\n");
    const turns = parseOmpTranscript(text);
    expect(turns.map((turn) => turn.role)).toEqual(["user", "assistant", "user", "assistant"]);
    expect(turns[2]).toEqual({ role: "user", ts: "2026-10-05T00:01:00.000Z", parts: [{ kind: "task_result", tasks: [
      { id: "st_1", title: "Find where task records live", agent: "explore", model: "lab/luna", status: "completed", duration_ms: 58_350, turns: 6, tool_calls: 14, tokens: 210_304, result: "**Found** it." },
      { id: "st_2", title: "Read shots 1-7", agent: "visual-engineering", model: "lab/kimi", status: "failed", duration_ms: 9087, turns: 0, tool_calls: 0, tokens: null, result: "Invalid native tool call event order" },
      { id: "st_3", title: "quick", agent: "quick", model: null, status: "cancelled", duration_ms: null, turns: null, tool_calls: null, tokens: null, result: "" },
      { id: "st_4", title: "named-run", agent: null, model: null, status: "completed", duration_ms: null, turns: null, tool_calls: null, tokens: null, result: "x".repeat(16_000), result_cut: true },
    ] }] });
    // the row of the call reads the summary it gave, one per task of a batch
    expect(turns[1]!.parts.map((part) => part.kind === "tool" ? part.summary : part.kind)).toEqual(["Find where task records live", "Read shots 1-7 · shots 8-14"]);
  });

  it("leaves a wake that reports no task result to the runtime", () => {
    const text = [
      omoUser("2026-10-05T00:00:00.000Z", "watch the build"),
      JSON.stringify({ type: "custom_message", customType: "omo-senpi:wake", display: false, timestamp: "2026-10-05T00:01:00.000Z", content: "monitor fired", details: [{ customType: "senpi-monitor:notification", details: [{ line: "READY" }] }] }),
      JSON.stringify({ type: "custom_message", customType: "omo-senpi:wake", display: false, timestamp: "2026-10-05T00:01:01.000Z", content: "empty", details: [{ customType: "senpi-task.completion", details: [{ name: "no id", status: "completed" }] }] }),
    ].join("\n");
    expect(parseOmpTranscript(text).map((turn) => turn.parts.map((part) => part.kind))).toEqual([["text"]]);
  });

  it("draws a task reported twice in one wake once, as its later report", () => {
    const text = [
      omoUser("2026-10-05T00:00:00.000Z", "go"),
      omoWake("2026-10-05T00:01:00.000Z", [
        completion({ task_id: "st_1", name: "st_1", status: "completed", agent_type: "explore", final_response: "first" }),
        completion({ task_id: "st_2", name: "st_2", status: "completed", agent_type: "explore", final_response: "other" }),
        completion({ task_id: "st_1", name: "st_1", status: "error", agent_type: "explore", final_response: "again" }),
      ]),
    ].join("\n");
    const ended = parseOmpTranscript(text)[1]?.parts[0];
    expect(ended?.kind === "task_result" ? ended.tasks.map((task) => `${task.id} ${task.status} ${task.result}`) : ended).toEqual(["st_1 failed again", "st_2 completed other"]);
  });
});

describe("OmO goal continuation and waits", () => {
  /** what OmO writes when it continues an active goal on its own (the TUI's "goal continues") */
  const continuation = (ts: string, objective: string) => JSON.stringify({
    type: "custom_message", customType: "goal-continuation", display: false, timestamp: ts, details: { ticketId: "t1" },
    content: `Continue working toward the active thread goal.\n\n<untrusted_objective>\n${objective}\n</untrusted_objective>\n\nUsage so far:\n- Tokens used: 120`,
  });
  const turnStart = (ts: string, cause: string) => JSON.stringify({ type: "custom", customType: "engine-turn-start", data: { customType: cause }, timestamp: ts });
  /** OmO's goal waiting on background work before it continues, and its end */
  const warmup = (ts: string, phase: string, dueAtMs: number) => JSON.stringify({
    type: "custom", customType: "goal-cache-warmup", timestamp: ts,
    data: { phase, goalId: "g1", delayMs: 270_000, dueAtMs, iteration: 1, activeMonitorCount: 3, wakeSources: { "omo-dag": 1, "omo-wake-queue": 4, "senpi-codemode": 0, "senpi-task": 2, "terminal-background-sessions": 1, "terminal-monitors": 3 } },
  });
  const final = (ts: string, text: string) => JSON.stringify({ type: "message", timestamp: ts, message: { role: "assistant", content: [{ type: "text", text }], stopReason: "stop" } });
  const due = Date.parse("2026-10-05T00:06:30.000Z");

  it("draws a turn OmO started to continue its goal as a notice in the user's seat, with the goal's objective", () => {
    const text = [
      omoUser("2026-10-05T00:00:00.000Z", "set a goal"),
      final("2026-10-05T00:01:00.000Z", "Waiting for CI."),
      turnStart("2026-10-05T00:02:00.000Z", "goal-continuation"),
      continuation("2026-10-05T00:02:00.000Z", "Ship the &lt;ver&gt; guard &amp; its test"),
      final("2026-10-05T00:03:00.000Z", "CI is green."),
    ].join("\n");
    const turns = parseOmpTranscript(text);
    expect(turns.map((turn) => turn.role)).toEqual(["user", "assistant", "user", "assistant"]);
    expect(turns[2]).toEqual({ role: "user", ts: "2026-10-05T00:02:00.000Z", parts: [{ kind: "notice", text: "Ship the <ver> guard & its test", source: "goal-continuation" }] });
  });

  it("shows the goal waiting on background work while it is the conversation's last word, with when it resumes and what it waits on", () => {
    const waiting = [omoUser("2026-10-05T00:00:00.000Z", "go"), final("2026-10-05T00:02:00.000Z", "Started the checks."), warmup("2026-10-05T00:02:00.000Z", "scheduled", due)];
    expect(parseOmpTranscript(waiting.join("\n")).at(-1)).toEqual({ role: "user", ts: "2026-10-05T00:02:00.000Z", parts: [{
      kind: "goal_wait", due_at: "2026-10-05T00:06:30.000Z", waiting_on: { tasks: 2, monitors: 3, terminals: 1, dags: 1, cells: 0 },
    }] });
    const kinds = (lines: string[]) => parseOmpTranscript(lines.join("\n")).map((turn) => turn.parts[0]?.kind);
    // it ends when it resumes, when a wake starts a turn, or once anything else is said after it
    expect(kinds([...waiting, warmup("2026-10-05T00:06:30.000Z", "resumed", due)])).toEqual(["text", "text"]);
    expect(kinds([...waiting, turnStart("2026-10-05T00:03:00.000Z", "senpi-monitor:notification")])).toEqual(["text", "text"]);
    expect(kinds([...waiting, final("2026-10-05T00:03:00.000Z", "A check failed.")])).toEqual(["text", "text", "text"]);
    // a record that adds no turn leaves it standing
    const empty = JSON.stringify({ type: "message", timestamp: "2026-10-05T00:03:00.000Z", message: { role: "assistant", content: [] } });
    expect(kinds([...waiting, empty])).toEqual(["text", "text", "goal_wait"]);
    // a later wait takes the earlier one's place
    const again = parseOmpTranscript([...waiting, warmup("2026-10-05T00:03:00.000Z", "scheduled", due + 60_000)].join("\n"));
    expect(again.map((turn) => turn.parts[0]?.kind)).toEqual(["text", "text", "goal_wait"]);
    expect(again.at(-1)?.parts[0]).toMatchObject({ due_at: "2026-10-05T00:07:30.000Z" });
  });
});

const omoUser = (ts: string, text: string) => JSON.stringify({ type: "message", timestamp: ts, message: { role: "user", content: [{ type: "text", text }] } });
/** an OmO `task` call and the result that names the tasks it started */
const omoSpawn = (ts: string, id: string, input: Record<string, unknown>, details: Record<string, unknown>) => [
  JSON.stringify({ type: "message", timestamp: ts, message: { role: "assistant", content: [{ type: "toolCall", id, name: "task", arguments: { run_in_background: true, ...input } }] } }),
  JSON.stringify({ type: "message", timestamp: ts, message: { role: "toolResult", toolCallId: id, toolName: "task", content: [{ type: "text", text: "Started task (running)." }], details: { status: "running", mode: "spawn", ...details } } }),
].join("\n");
const completion = (fields: Record<string, unknown>) => ({ continuation_hint: "Use task_send to continue.", ...fields });
/** how OmO wakes its agent when background tasks end */
const omoWake = (ts: string, tasks: Record<string, unknown>[]) => JSON.stringify({
  type: "custom_message", customType: "omo-senpi:wake", display: false, timestamp: ts,
  content: "task completion …", details: [{ customType: "senpi-task.completion", details: tasks }],
});

describe("transcript pages", () => {
  const roots: string[] = [];
  afterEach(() => {
    forgetTranscriptState();
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });
  const temp = (): string => { const root = mkdtempSync(join(tmpdir(), "herdr-pages-")); roots.push(root); return root; };
  /** a prompt, a tool call and its result: the result answers the turn, never the next page */
  const claudeTurn = (n: number) => [
    { type: "user", timestamp: `2026-09-23T00:00:${String(n % 60).padStart(2, "0")}.000Z`, message: { role: "user", content: `prompt ${n}` } },
    { type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: `t${n}`, name: "Bash", input: { command: `echo ${n}` } }] } },
    { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: `t${n}`, content: `out ${n}` }] } },
    { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: `answer ${n}` }] } },
  ].map((entry) => JSON.stringify(entry)).join("\n");
  const texts = (turns: { parts: { kind: string; text?: string; output?: string }[] }[]) =>
    turns.map((turn) => turn.parts.map((part) => part.kind === "tool" ? `[${part.output}]` : part.text).join(" "));

  it("shows another session's message as its own notice turn, so the work it starts is not appended to the answer before it", () => {
    const path = join(temp(), "peer.jsonl");
    const envelope = (body: string) => `<cross-session-message from="uds:x" from-name="FUSION" from-mode="bypass">\n${body}\n</cross-session-message>`;
    let delivered = 0;
    const origin = (body: string) => ({ kind: "peer", from: "uds:x", msg_id: `m${++delivered}`, name: "FUSION", body });
    const say = (text: string) => ({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text }] } });
    writeFileSync(path, `${[
      { type: "user", timestamp: "2026-10-08T03:04:00.000Z", message: { role: "user", content: "deck status?" } },
      say("the deck is done"),
      // arrives between turns: a meta user entry
      { type: "user", isMeta: true, timestamp: "2026-10-08T03:05:01.000Z", origin: origin("R18 is ready"), message: { role: "user", content: `Another Claude session sent a message:\n${envelope("R18 is ready")}` } },
      say("recorded both decisions"),
      // arrives mid-turn: a queued attachment, its own turn in the order it was taken in
      { type: "attachment", timestamp: "2026-10-08T03:06:00.000Z", attachment: { type: "queued_command", commandMode: "prompt", prompt: envelope("coordinates sent"), origin: origin("coordinates sent") } },
      say("rebuilt slide 4"),
      // a meta entry that is not another session's message stays hidden
      { type: "user", isMeta: true, message: { role: "user", content: "<local-command-caveat>x</local-command-caveat>" } },
    ].map((entry) => JSON.stringify(entry)).join("\n")}\n`);
    const page = transcriptPage("claude-transcript", path);
    expect(page.turns.map((turn) => [turn.role, turn.parts.map((part) => part.kind === "notice" ? `${part.source}|${part.text}` : part.kind === "text" ? part.text : part.kind).join(" ")])).toEqual([
      ["user", "deck status?"],
      ["assistant", "the deck is done"],
      ["user", "peer:FUSION|R18 is ready"],
      ["assistant", "recorded both decisions"],
      ["user", "peer:FUSION|coordinates sent"],
      ["assistant", "rebuilt slide 4"],
    ]);
  });

  it("shows one notice for a delivery Claude recorded twice, and says 'another session' for an unnamed sender", () => {
    const path = join(temp(), "peer-echo.jsonl");
    const origin = { kind: "peer", from: "uds:x", msg_id: "m7", name: "FUSION", body: "R18 is ready" };
    writeFileSync(path, `${[
      { type: "user", timestamp: "2026-10-08T03:04:00.000Z", message: { role: "user", content: "deck status?" } },
      { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "working on it" }] } },
      // queued mid-turn, then echoed as a meta entry once the turn ended: one message
      { type: "attachment", timestamp: "2026-10-08T03:05:00.000Z", attachment: { type: "queued_command", commandMode: "prompt", prompt: "<cross-session-message from-name=\"FUSION\">\nR18 is ready\n</cross-session-message>", origin } },
      { type: "user", isMeta: true, timestamp: "2026-10-08T03:05:01.000Z", origin, message: { role: "user", content: "Another Claude session sent a message:\n<cross-session-message from-name=\"FUSION\">\nR18 is ready\n</cross-session-message>" } },
      { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "noted" }] } },
      // a sender without a name
      { type: "user", isMeta: true, timestamp: "2026-10-08T03:06:00.000Z", origin: { kind: "peer", from: "uds:y", msg_id: "m8", body: "ping" }, message: { role: "user", content: "Another Claude session sent a message:\n<cross-session-message>\nping\n</cross-session-message>" } },
    ].map((entry) => JSON.stringify(entry)).join("\n")}\n`);
    const page = transcriptPage("claude-transcript", path);
    expect(page.turns.map((turn) => turn.parts.map((part) => part.kind === "notice" ? `${part.source}|${part.text}` : part.kind === "text" ? part.text : part.kind).join(" "))).toEqual([
      "deck status?", "working on it", "peer:FUSION|R18 is ready", "noted", "peer:|ping",
    ]);
  });

  it("pages back across other sessions' messages without gaps or overlaps", () => {
    const path = join(temp(), "peer-pages.jsonl");
    const envelope = (n: number) => `<cross-session-message from-name="FUSION">\nreply ${n}\n</cross-session-message>`;
    const origin = (n: number) => ({ kind: "peer", from: "uds:x", msg_id: `m${n}`, name: "FUSION", body: `reply ${n}` });
    // in both forms Claude records them: the meta entry between turns, the queued attachment mid-turn
    const peer = (n: number) => JSON.stringify(n % 2 === 0
      ? { type: "user", isMeta: true, timestamp: "2026-10-08T00:00:00.000Z", origin: origin(n), message: { role: "user", content: `Another Claude session sent a message:\n${envelope(n)}` } }
      : { type: "attachment", timestamp: "2026-10-08T00:00:00.000Z", attachment: { type: "queued_command", commandMode: "prompt", prompt: envelope(n), origin: origin(n) } })
      + "\n" + JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: `handled ${n}` }] } });
    writeFileSync(path, `${Array.from({ length: 120 }, (_, n) => n % 3 === 0 ? peer(n) : claudeTurn(n)).join("\n")}\n`);
    const seen: string[] = [];
    let page = transcriptPage("claude-transcript", path);
    for (let pages = 0; ; pages++) {
      expect(pages).toBeLessThan(20);
      seen.unshift(...texts(page.turns));
      if (!page.cursor) break;
      page = transcriptPage("claude-transcript", path, { before: page.cursor });
    }
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen.filter((text) => text.startsWith("reply ")).length).toBe(40);
    expect(seen.filter((text) => text.startsWith("prompt ")).length).toBe(80);
  });

  it("titles a background task that ends a prompt after the one that started it, live and cold alike", () => {
    const root = temp();
    const path = join(root, "omo.jsonl");
    writeFileSync(path, `${[
      omoUser("2026-10-05T00:00:00.000Z", "start it"),
      omoSpawn("2026-10-05T00:00:01.000Z", "c1", { task_summary: "Survey the repo", subagent_type: "explore", prompt: "go" }, { task_id: "st_1", task_summary: "Survey the repo" }),
    ].join("\n")}\n`);
    // the first read settles nothing yet; the next prompt makes the spawn's turn settled
    expect(transcriptPage("omo-transcript", path).turns).toHaveLength(2);
    appendFileSync(path, `${omoUser("2026-10-05T00:02:00.000Z", "meanwhile, something else")}\n`);
    expect(transcriptPage("omo-transcript", path).turns).toHaveLength(3);
    appendFileSync(path, `${omoWake("2026-10-05T00:03:00.000Z", [completion({ task_id: "st_1", name: "st_1", status: "completed", agent_type: "explore", final_response: "done" })])}\n`);
    const cold = join(root, "cold.jsonl");
    copyFileSync(path, cold);
    for (const page of [transcriptPage("omo-transcript", path), transcriptPage("omo-transcript", cold)]) {
      const ended = page.turns.at(-1)?.parts[0];
      expect(ended?.kind === "task_result" ? ended.tasks.map((task) => task.title) : ended).toEqual(["Survey the repo"]);
    }
  });

  it("keeps OmO's goal wait only while it is the newest page's last turn, live and cold alike", () => {
    const root = temp();
    const path = join(root, "omo.jsonl");
    const wait = JSON.stringify({ type: "custom", customType: "goal-cache-warmup", timestamp: "2026-10-05T00:01:00.000Z", data: { phase: "scheduled", dueAtMs: Date.parse("2026-10-05T00:05:00.000Z"), wakeSources: { "terminal-monitors": 1 } } });
    const answer = JSON.stringify({ type: "message", timestamp: "2026-10-05T00:00:30.000Z", message: { role: "assistant", content: [{ type: "text", text: "watching" }], stopReason: "stop" } });
    writeFileSync(path, `${[omoUser("2026-10-05T00:00:00.000Z", "watch it"), answer, wait].join("\n")}\n`);
    expect(transcriptPage("omo-transcript", path).turns.map((turn) => turn.parts[0]?.kind)).toEqual(["text", "text", "goal_wait"]);
    // the next prompt is a turn start: what came before it is parsed apart from it, and the wait is over
    appendFileSync(path, `${omoUser("2026-10-05T00:02:00.000Z", "something else")}\n`);
    const cold = join(root, "cold.jsonl");
    copyFileSync(path, cold);
    for (const page of [transcriptPage("omo-transcript", path), transcriptPage("omo-transcript", cold)]) {
      expect(page.turns.map((turn) => turn.parts[0]?.kind)).toEqual(["text", "text", "text"]);
    }
  });

  const endedTitles = (page: { turns: ConversationTurn[] }): unknown => {
    const ended = page.turns.at(-1)?.parts[0];
    return ended?.kind === "task_result" ? ended.tasks.map((task) => task.title) : ended;
  };

  const spawning = (taskId: string) => `${[
    omoUser("2026-10-05T00:00:00.000Z", "start it"),
    omoSpawn("2026-10-05T00:00:01.000Z", "c1", { task_summary: "Survey the repo", subagent_type: "explore", prompt: "go" }, { task_id: taskId, task_summary: "Survey the repo" }),
  ].join("\n")}\n`;
  /** polled as it grows until the page start passes the first turn, then st_1 ends */
  const pollPastFirstTurn = (path: string) => {
    // the page start passes the first turn once more prompts than a page holds followed
    for (let n = 0; n < MAX_TURNS / 2 + 2; n += 1) {
      expect(transcriptPage("omo-transcript", path).turns.length).toBeGreaterThan(0);
      appendFileSync(path, `${omoUser(`2026-10-05T00:${String(10 + Math.floor(n / 60)).padStart(2, "0")}:${String(n % 60).padStart(2, "0")}.000Z`, `prompt ${n}`)}\n`);
    }
    expect(transcriptPage("omo-transcript", path).turns[0]?.parts[0]).toEqual({ kind: "text", text: "prompt 2" });
    appendFileSync(path, `${omoWake("2026-10-05T00:20:00.000Z", [completion({ task_id: "st_1", name: "st_1", status: "completed", agent_type: "explore", final_response: "done" })])}\n`);
    return endedTitles(transcriptPage("omo-transcript", path));
  };

  it("keeps a task's title when the newest page moves past the turn that started it, while the file is watched", () => {
    const path = join(temp(), "omo.jsonl");
    writeFileSync(path, spawning("st_1"));
    expect(pollPastFirstTurn(path)).toEqual(["Survey the repo"]);
  });

  it("keeps the last observed task title when many prompts arrive between polls", () => {
    const path = join(temp(), "omo.jsonl");
    writeFileSync(path, spawning("st_1"));
    transcriptPage("omo-transcript", path);
    for (let n = 0; n < MAX_TURNS / 2 + 2; n++) {
      appendFileSync(path, `${omoUser(`2026-10-05T00:10:${String(n % 60).padStart(2, "0")}.000Z`, `prompt ${n}`)}\n`);
    }
    appendFileSync(path, `${omoWake("2026-10-05T00:20:00.000Z", [completion({ task_id: "st_1", name: "st_1", status: "completed", agent_type: "explore", final_response: "done" })])}\n`);
    expect(endedTitles(transcriptPage("omo-transcript", path))).toEqual(["Survey the repo"]);
  });

  it("never titles a task from another file that had the same inode", () => {
    const root = temp();
    const gone = join(root, "gone.jsonl");
    writeFileSync(gone, spawning("st_1"));
    transcriptPage("omo-transcript", gone);
    appendFileSync(gone, `${omoUser("2026-10-05T00:02:00.000Z", "meanwhile, something else")}\n`);
    transcriptPage("omo-transcript", gone);
    // Linux gives a deleted file's inode to the next file; a hard link rewritten in place does so anywhere
    const path = join(root, "omo.jsonl");
    linkSync(gone, path);
    writeFileSync(path, spawning("st_2"));
    expect(pollPastFirstTurn(path)).toEqual(["explore"]);
  });

  it("titles a wake read before the call that names its task as a cold read does, on every poll", () => {
    const root = temp();
    const path = join(root, "omo.jsonl");
    writeFileSync(path, `${[
      omoUser("2026-10-05T00:00:00.000Z", "start it"),
      omoWake("2026-10-05T00:00:01.000Z", [completion({ task_id: "st_1", name: "st_1", status: "completed", agent_type: "explore", final_response: "done" })]),
      omoSpawn("2026-10-05T00:00:02.000Z", "c1", { task_summary: "Survey the repo", subagent_type: "explore", prompt: "go" }, { task_id: "st_1", task_summary: "Survey the repo" }),
    ].join("\n")}\n`);
    const titles = (page: { turns: ConversationTurn[] }) => page.turns.flatMap((turn) => turn.parts.flatMap((part) => part.kind === "task_result" ? part.tasks.map((task) => task.title) : []));
    expect(titles(transcriptPage("omo-transcript", path))).toEqual(["explore"]);
    appendFileSync(path, `${JSON.stringify({ type: "message", timestamp: "2026-10-05T00:00:03.000Z", message: { role: "assistant", content: [{ type: "text", text: "noted" }] } })}\n`);
    const cold = join(root, "cold.jsonl");
    copyFileSync(path, cold);
    expect(titles(transcriptPage("omo-transcript", path))).toEqual(titles(transcriptPage("omo-transcript", cold)));
  });

  it("reads a growing file's newest page incrementally, exactly as a cold read of it", () => {
    const root = temp();
    const path = join(root, "session.jsonl");
    const whole = Buffer.from(`${Array.from({ length: 80 }, (_, n) => claudeTurn(n)).join("\n")}\n`);
    writeFileSync(path, whole.subarray(0, 1000));
    // appends of every size, cut mid-line too, including one that ends the file without a newline
    for (let at = 1000, step = 1; at < whole.length; step = (step * 7) % 997 + 1) {
      appendFileSync(path, whole.subarray(at, at + step * 23));
      at += step * 23;
      const cold = join(root, `cold-${at}.jsonl`);
      copyFileSync(path, cold);
      const live = transcriptPage("claude-transcript", path);
      const reference = transcriptPage("claude-transcript", cold);
      rmSync(cold);
      expect(texts(live.turns)).toEqual(texts(reference.turns));
      expect(live.metadata).toEqual(reference.metadata);
      expect(live.cursor?.split(":").at(-1)).toBe(reference.cursor?.split(":").at(-1));
    }
  });

  it("pages back through a long conversation without gaps, overlaps or split turns", () => {
    const path = join(temp(), "session.jsonl");
    const whole = Array.from({ length: 120 }, (_, n) => claudeTurn(n)).join("\n");
    writeFileSync(path, `${whole}\n`);

    const newest = transcriptPage("claude-transcript", path);
    expect(newest.turns).toHaveLength(MAX_TURNS);
    expect(texts(newest.turns)[0]).toBe("prompt 70");
    expect(newest.cursor).not.toBeNull();
    const middle = transcriptPage("claude-transcript", path, { before: newest.cursor! });
    expect(texts(middle.turns)[0]).toBe("prompt 20");
    const first = transcriptPage("claude-transcript", path, { before: middle.cursor! });
    expect(first.cursor).toBeNull();
    expect(texts([...first.turns, ...middle.turns, ...newest.turns])).toEqual(texts(parseClaudeTranscript(whole, Infinity)));
    expect(texts(middle.turns).at(-1)).toBe("[out 69] answer 69");
  });

  it("keeps a held start while it is inside the newest page, then fills the turns it moved past a page at a time", () => {
    const path = join(temp(), "session.jsonl");
    writeFileSync(path, `${Array.from({ length: 60 }, (_, n) => claudeTurn(n)).join("\n")}\n`);
    const held = transcriptPage("claude-transcript", path).cursor!;
    // while the last turn grows, the held start (prompt 10) is still inside the newest page
    const more = JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "still working" }] } });
    writeFileSync(path, `${Array.from({ length: 60 }, (_, n) => claudeTurn(n)).join("\n")}\n${more}\n`);
    const growing = transcriptPage("claude-transcript", path, { from: held });
    expect(growing.cursor).toBe(held);
    expect(texts(growing.turns).at(-1)).toBe("[out 59] answer 59 still working");
    // appended after it (replacing the record above instead would be a rewrite, and a new history)
    appendFileSync(path, `${Array.from({ length: 10 }, (_, n) => claudeTurn(60 + n)).join("\n")}\n`);
    // the newest page slid past it: the answer is the newest page, never more than a page
    const newest = transcriptPage("claude-transcript", path, { from: held });
    expect(newest.cursor).not.toBe(held);
    expect(texts(newest.turns)[0]).toBe("prompt 20");
    // the turns in between come from `before` the newest page, `since` the held start
    const gap = transcriptPage("claude-transcript", path, { before: newest.cursor!, since: held });
    expect(gap.cursor).toBe(held);
    expect(texts(gap.turns)[0]).toBe("prompt 10");
    expect(texts(gap.turns).at(-1)).toBe("[out 19] answer 19");
    for (const cursor of ["another-file:10", `${held.split(":")[0]}:999999999`, "garbage"]) {
      expect(() => transcriptPage("claude-transcript", path, { before: cursor })).toThrow(HistoryChanged);
    }
    expect(() => transcriptPage("claude-transcript", path, { before: held, since: newest.cursor! })).toThrow(HistoryChanged);
  });

  it("reads one window for the newest page even when no turn starts in it; an older page reaches the turn's start", () => {
    const path = join(temp(), "session.jsonl");
    const prompt = JSON.stringify({ type: "user", message: { role: "user", content: "run the long job" } });
    // one turn of 20MB of tool output: no turn starts in the newest window
    const output = JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "y".repeat(1024 * 1024) }] } });
    writeFileSync(path, `${claudeTurn(0)}\n${prompt}\n${Array.from({ length: 20 }, () => output).join("\n")}\n`);
    const size = Buffer.byteLength(`${claudeTurn(0)}\n${prompt}\n`) + 20 * (Buffer.byteLength(output) + 1);
    const newest = transcriptPage("claude-transcript", path);
    const start = Number(newest.cursor!.split(":").at(-1));
    expect(size - start).toBeLessThanOrEqual(16 * 1024 * 1024);
    expect(newest.turns.every((turn) => turn.role === "assistant")).toBe(true);
    const older = transcriptPage("claude-transcript", path, { before: newest.cursor! });
    expect(texts(older.turns).slice(0, 3)).toEqual(["prompt 0", "[out 0] answer 0", "run the long job"]);
  });

  it("refuses a cursor once the rollouts before the live file change, instead of pointing at other turns", () => {
    const home = join(temp(), "codex");
    const thread = "01a0a337-19e8-7712-92f5-aa0883392afd";
    const task = (n: number) => [
      { type: "event_msg", timestamp: "2026-09-23T00:00:00.000Z", payload: { type: "task_started" } },
      { type: "response_item", timestamp: "2026-09-23T00:00:00.000Z", payload: { type: "message", role: "user", content: [{ type: "input_text", text: `prompt ${n}` }] } },
      { type: "response_item", timestamp: "2026-09-23T00:00:01.000Z", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: `answer ${n}` }] } },
    ].map((entry) => JSON.stringify(entry)).join("\n");
    const meta = (extra = {}) => JSON.stringify({ type: "session_meta", payload: { source: "cli", thread_source: "user", ...extra } });
    mkdirSync(join(home, "sessions", "2026", "09", "15"), { recursive: true });
    mkdirSync(join(home, "sessions", "2026", "09", "23"), { recursive: true });
    const kept = `${meta()}\n${Array.from({ length: 20 }, (_, n) => task(n)).join("\n")}\n`;
    const segment = join(home, "sessions", "2026", "09", "23", `rollout-2026-09-23T10-46-43-${thread}_01a0cbf1-9b0e-7383-a345-80974b279c68.jsonl`);
    writeFileSync(segment, `${meta({ history_base: { thread_id: thread, end_ordinal_exclusive: kept.split("\n").length - 1, end_byte_offset: Buffer.byteLength(kept) } })}\n${Array.from({ length: 60 }, (_, n) => task(20 + n)).join("\n")}\n`);
    // the earlier rollout is not there yet: the chain stops at the segment
    forgetHistoryChains();
    const newest = transcriptPage("codex-transcript", segment, {}, home);
    const older = transcriptPage("codex-transcript", segment, { before: newest.cursor! }, home);
    expect(texts(older.turns)[0]).toBe("prompt 20");
    // it appears: positions now count from its start, and the old cursors name another chain
    writeFileSync(join(home, "sessions", "2026", "09", "15", `rollout-2026-09-15T12-58-12-${thread}.jsonl`), kept);
    forgetHistoryChains();
    expect(() => transcriptPage("codex-transcript", segment, { before: newest.cursor! }, home)).toThrow(HistoryChanged);
    expect(() => transcriptPage("codex-transcript", segment, { from: newest.cursor! }, home)).toThrow(HistoryChanged);
    // read afresh, the pages reach the earlier rollout
    const again = transcriptPage("codex-transcript", segment, {}, home);
    const all = [...transcriptPage("codex-transcript", segment, { before: again.cursor! }, home).turns, ...again.turns];
    expect(texts(all)[0]).toBe("prompt 0");
  });

  it("looks a remembered chain up again once a rollout in it is archived, instead of failing every read", () => {
    const home = join(temp(), "codex");
    const thread = "01a0a337-19e8-7712-92f5-aa0883392afd";
    const task = (n: number) => [
      { type: "event_msg", timestamp: "2026-09-23T00:00:00.000Z", payload: { type: "task_started" } },
      { type: "response_item", timestamp: "2026-09-23T00:00:00.000Z", payload: { type: "message", role: "user", content: [{ type: "input_text", text: `prompt ${n}` }] } },
      { type: "response_item", timestamp: "2026-09-23T00:00:01.000Z", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: `answer ${n}` }] } },
    ].map((entry) => JSON.stringify(entry)).join("\n");
    const meta = (extra = {}) => JSON.stringify({ type: "session_meta", payload: { source: "cli", thread_source: "user", ...extra } });
    mkdirSync(join(home, "sessions", "2026", "09", "15"), { recursive: true });
    mkdirSync(join(home, "sessions", "2026", "09", "23"), { recursive: true });
    mkdirSync(join(home, "archived_sessions"), { recursive: true });
    const kept = `${meta()}\n${Array.from({ length: 80 }, (_, n) => task(n)).join("\n")}\n`;
    const parent = join(home, "sessions", "2026", "09", "15", `rollout-2026-09-15T12-58-12-${thread}.jsonl`);
    writeFileSync(parent, kept);
    // right after a backtrack the live file is small: its newest page reaches into the parent
    const segment = join(home, "sessions", "2026", "09", "23", `rollout-2026-09-23T10-46-43-${thread}_01a0cbf1-9b0e-7383-a345-80974b279c68.jsonl`);
    writeFileSync(segment, `${meta({ history_base: { thread_id: thread, end_ordinal_exclusive: kept.split("\n").length - 1, end_byte_offset: Buffer.byteLength(kept) } })}\n${Array.from({ length: 3 }, (_, n) => task(80 + n)).join("\n")}\n`);
    forgetHistoryChains();
    const before = transcriptPage("codex-transcript", segment, {}, home);
    expect(texts(before.turns)[0]).toBe("prompt 33");
    expect(before.cursor).not.toBeNull();
    // archived while the complete chain is remembered
    renameSync(parent, join(home, "archived_sessions", `rollout-2026-09-15T12-58-12-${thread}.jsonl`));
    const after = transcriptPage("codex-transcript", segment, {}, home);
    expect(texts(after.turns)).toEqual(["prompt 80", "answer 80", "prompt 81", "answer 81", "prompt 82", "answer 82"]);
    // a reader holding a position in the old chain reloads once
    expect(() => transcriptPage("codex-transcript", segment, { before: before.cursor! }, home)).toThrow(HistoryChanged);
  });

  it("answers nothing from another rollout that a folder swap puts at a parent rollout's path around its opens", () => {
    const home = join(temp(), "codex");
    const thread = "01a0a337-19e8-7712-92f5-aa0883392afd";
    // the other conversation's prompts are as long as the pane's, so its rollout fills the same offsets
    const task = (n: number, said = "prompt ") => [
      { type: "event_msg", timestamp: "2026-09-23T00:00:00.000Z", payload: { type: "task_started" } },
      { type: "response_item", timestamp: "2026-09-23T00:00:00.000Z", payload: { type: "message", role: "user", content: [{ type: "input_text", text: `${said}${n}` }] } },
      { type: "response_item", timestamp: "2026-09-23T00:00:01.000Z", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: `answer ${n}` }] } },
    ].map((entry) => JSON.stringify(entry)).join("\n");
    const meta = (extra = {}) => JSON.stringify({ type: "session_meta", payload: { source: "cli", thread_source: "user", ...extra } });
    const day = join(home, "sessions", "2026", "09", "15");
    const elsewhere = join(temp(), "15");
    mkdirSync(day, { recursive: true });
    mkdirSync(elsewhere);
    mkdirSync(join(home, "sessions", "2026", "09", "23"), { recursive: true });
    const name = `rollout-2026-09-15T12-58-12-${thread}.jsonl`;
    const kept = `${meta()}\n${Array.from({ length: 80 }, (_, n) => task(n)).join("\n")}\n`;
    writeFileSync(join(day, name), kept);
    writeFileSync(join(elsewhere, name), `${meta()}\n${Array.from({ length: 80 }, (_, n) => task(n, "FOREIGN")).join("\n")}\n`);
    // right after a backtrack the live file is small: its newest page reaches into the parent
    const segment = join(home, "sessions", "2026", "09", "23", `rollout-2026-09-23T10-46-43-${thread}_01a0cbf1-9b0e-7383-a345-80974b279c68.jsonl`);
    writeFileSync(segment, `${meta({ history_base: { thread_id: thread, end_ordinal_exclusive: kept.split("\n").length - 1, end_byte_offset: Buffer.byteLength(kept) } })}\n${Array.from({ length: 3 }, (_, n) => task(80 + n)).join("\n")}\n`);
    forgetHistoryChains();
    const parent = join(day, name);
    const away = join(temp(), "away");
    let swaps = 0;
    const { openSync } = fs;
    const opens = spyOn(fs, "openSync").mockImplementation(((...args: Parameters<typeof fs.openSync>) => {
      if (args[0] !== parent) return openSync(...args);
      swaps++;
      renameSync(day, away);
      renameSync(elsewhere, day);
      try { return openSync(...args); }
      finally {
        renameSync(day, elsewhere);
        renameSync(away, day);
      }
    }) as typeof fs.openSync);
    let answer: unknown;
    try { answer = transcriptPage("codex-transcript", segment, {}, home); }
    catch (error) { answer = error; }
    finally { opens.mockRestore(); }
    expect(swaps).toBeGreaterThan(0);
    expect(JSON.stringify(answer)).not.toContain("FOREIGN");
    expect(answer).toBeInstanceOf(ConversationReadPending);
  });

  /** A backtracked Codex conversation: a live rollout whose newest page reaches into the parent it continues. */
  const codexChain = () => {
    const home = join(temp(), "codex");
    const thread = "01a0a337-19e8-7712-92f5-aa0883392afd";
    // another conversation's prompts are as long as the pane's, so its rollout holds the same cut
    const task = (n: number, said = "prompt ") => [
      { type: "event_msg", timestamp: "2026-09-23T00:00:00.000Z", payload: { type: "task_started" } },
      { type: "response_item", timestamp: "2026-09-23T00:00:00.000Z", payload: { type: "message", role: "user", content: [{ type: "input_text", text: `${said}${n}` }] } },
      { type: "response_item", timestamp: "2026-09-23T00:00:01.000Z", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: `answer ${n}` }] } },
    ].map((entry) => JSON.stringify(entry)).join("\n");
    const meta = (extra = {}) => JSON.stringify({ type: "session_meta", payload: { source: "cli", thread_source: "user", ...extra } });
    const day = join(home, "sessions", "2026", "09", "15");
    mkdirSync(day, { recursive: true });
    mkdirSync(join(home, "sessions", "2026", "09", "23"), { recursive: true });
    const parent = join(day, `rollout-2026-09-15T12-58-12-${thread}.jsonl`);
    const kept = `${meta()}\n${Array.from({ length: 80 }, (_, n) => task(n)).join("\n")}\n`;
    writeFileSync(parent, kept);
    const live = join(home, "sessions", "2026", "09", "23", `rollout-2026-09-23T10-46-43-${thread}_01a0cbf1-9b0e-7383-a345-80974b279c68.jsonl`);
    writeFileSync(live, `${meta({ history_base: { thread_id: thread, end_ordinal_exclusive: kept.split("\n").length - 1, end_byte_offset: Buffer.byteLength(kept) } })}\n${Array.from({ length: 3 }, (_, n) => task(80 + n)).join("\n")}\n`);
    const foreign = `${meta()}\n${Array.from({ length: 80 }, (_, n) => task(n, "FOREIGN")).join("\n")}\n`;
    forgetHistoryChains();
    return { home, thread, day, parent, live, foreign, task };
  };

  it("never resolves a Codex chain to another conversation's rollout because a folder swap hid the parent around its open", () => {
    const { home, thread, day, parent, live, foreign } = codexChain();
    // another conversation's rollout of the same thread that also holds the cut: with the parent beside it,
    // the chain is ambiguous and shows no parent
    mkdirSync(join(home, "sessions", "2026", "09", "14"));
    writeFileSync(join(home, "sessions", "2026", "09", "14", `rollout-2026-09-14T12-58-12-${thread}.jsonl`), foreign);
    // around each open of the parent, a folder where its name holds no rollout
    const elsewhere = join(temp(), "15");
    const away = join(temp(), "away");
    mkdirSync(elsewhere);
    writeFileSync(join(elsewhere, basename(parent)), "not a rollout\n");
    let swaps = 0;
    const { openSync } = fs;
    const opens = spyOn(fs, "openSync").mockImplementation(((...args: Parameters<typeof fs.openSync>) => {
      if (args[0] !== parent) return openSync(...args);
      swaps++;
      renameSync(day, away);
      renameSync(elsewhere, day);
      try { return openSync(...args); }
      finally {
        renameSync(day, elsewhere);
        renameSync(away, day);
      }
    }) as typeof fs.openSync);
    let answer: unknown;
    try { answer = transcriptPage("codex-transcript", live, {}, home); }
    catch (error) { answer = error; }
    finally { opens.mockRestore(); }
    expect(swaps).toBeGreaterThan(0);
    expect(JSON.stringify(answer)).not.toContain("FOREIGN");
    expect(answer).toBeInstanceOf(ConversationReadPending);
  });

  it("reads no replacement of a Codex parent rollout its remembered chain was resolved without", () => {
    const { home, parent, live, task } = codexChain();
    const before = transcriptPage("codex-transcript", live, {}, home);
    expect(texts(before.turns)[0]).toBe("prompt 33");
    // another file renamed over the parent: no rollout header, so it holds no cut, but turns where the parent's were
    const next = `${parent}.next`;
    writeFileSync(next, `${JSON.stringify({ type: "event_msg", payload: { type: "not_a_rollout" } })}\n${Array.from({ length: 80 }, (_, n) => task(n, "FOREIGN")).join("\n")}\n${"\n".repeat(256)}`);
    renameSync(next, parent);
    let after: unknown;
    try { after = transcriptPage("codex-transcript", live, {}, home); } catch (error) { after = error; }
    expect(JSON.stringify(after)).not.toContain("FOREIGN");
    expect(texts((after as { turns: ConversationTurn[] }).turns)).toEqual(["prompt 80", "answer 80", "prompt 81", "answer 81", "prompt 82", "answer 82"]);
  });

  it("pages across the rollouts a backtracked Codex conversation continues", () => {
    const home = join(temp(), "codex");
    const thread = "01a0a337-19e8-7712-92f5-aa0883392afd";
    const task = (n: number) => [
      { type: "event_msg", timestamp: "2026-09-23T00:00:00.000Z", payload: { type: "task_started" } },
      { type: "response_item", timestamp: "2026-09-23T00:00:00.000Z", payload: { type: "message", role: "user", content: [{ type: "input_text", text: `prompt ${n}` }] } },
      { type: "response_item", timestamp: "2026-09-23T00:00:01.000Z", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: `answer ${n}` }] } },
    ].map((entry) => JSON.stringify(entry)).join("\n");
    const meta = (extra = {}) => JSON.stringify({ type: "session_meta", payload: { source: "cli", thread_source: "user", ...extra } });
    mkdirSync(join(home, "sessions", "2026", "09", "15"), { recursive: true });
    mkdirSync(join(home, "sessions", "2026", "09", "23"), { recursive: true });
    const kept = `${meta()}\n${Array.from({ length: 60 }, (_, n) => task(n)).join("\n")}\n`;
    const keptLines = kept.split("\n").length - 1;
    writeFileSync(join(home, "sessions", "2026", "09", "15", `rollout-2026-09-15T12-58-12-${thread}.jsonl`), `${kept}${task(999)}\n`);
    const segment = join(home, "sessions", "2026", "09", "23", `rollout-2026-09-23T10-46-43-${thread}_01a0cbf1-9b0e-7383-a345-80974b279c68.jsonl`);
    writeFileSync(segment, `${meta({ history_base: { thread_id: thread, end_ordinal_exclusive: keptLines, end_byte_offset: Buffer.byteLength(kept) } })}\n${Array.from({ length: 10 }, (_, n) => task(60 + n)).join("\n")}\n`);

    const newest = transcriptPage("codex-transcript", segment, {}, home);
    expect(texts(newest.turns)[0]).toBe("prompt 20");
    const older = transcriptPage("codex-transcript", segment, { before: newest.cursor! }, home);
    expect(older.cursor).toBeNull();
    const all = texts([...older.turns, ...newest.turns]);
    expect(all).toEqual(Array.from({ length: 70 }, (_, n) => [`prompt ${n}`, `answer ${n}`]).flat());
  });
});

describe("tool calls that failed", () => {
  const lines = (...records: unknown[]) => records.map((record) => JSON.stringify(record)).join("\n");
  it("keeps Claude's is_error and omp's isError on the call they answer", () => {
    const claude = parseClaudeTranscript(lines(
      { type: "assistant", timestamp: "2026-09-27T00:00:00Z", message: { content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "false" } }, { type: "tool_use", id: "t2", name: "Bash", input: { command: "true" } }] } },
      { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "exit 1", is_error: true }, { type: "tool_result", tool_use_id: "t2", content: "" }] } },
    ));
    expect(claude.flatMap((turn) => turn.parts).filter((part) => part.kind === "tool").map((part) => part.error === true)).toEqual([true, false]);
    const omp = parseOmpTranscript(lines(
      { type: "message", timestamp: "2026-09-27T00:00:00Z", message: { role: "assistant", content: [{ type: "toolCall", id: "c1", name: "bash", arguments: { command: "false" } }] } },
      { type: "message", message: { role: "toolResult", toolCallId: "c1", isError: true, content: [{ type: "text", text: "exit 1" }] } },
    ));
    expect(omp.flatMap((turn) => turn.parts).filter((part) => part.kind === "tool").map((part) => part.error === true)).toEqual([true]);
  });
});

describe("images and compactions in a Claude transcript", () => {
  const lines = (...records: unknown[]) => records.map((record) => JSON.stringify(record)).join("\n");
  it("names a pasted image by its entry and block, and never carries its data", () => {
    const turns = parseClaudeTranscript(lines(
      { type: "user", uuid: "11111111-2222-3333-4444-555555555555", timestamp: "2026-09-27T00:00:00Z", message: { content: [
        { type: "image", source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" } },
        { type: "text", text: "what is this?" },
        { type: "image", source: { type: "base64", media_type: "image/svg+xml", data: "PHN2Zz4=" } },
      ] } },
      { type: "user", uuid: "66666666-2222-3333-4444-555555555555", message: { content: [{ type: "image", source: { type: "base64", media_type: "image/jpeg", data: "/9j/" } }] } },
    ));
    expect(turns.map((turn) => turn.parts)).toEqual([
      [{ kind: "image", media_type: "image/png", ref: "11111111-2222-3333-4444-555555555555:0" }, { kind: "text", text: "what is this?" }],
      [{ kind: "image", media_type: "image/jpeg", ref: "66666666-2222-3333-4444-555555555555:0" }],
    ]);
    expect(JSON.stringify(turns)).not.toContain("iVBOR");
  });

  it("names a picture a tool returned by its entry, its result and its place there, and never carries its data", () => {
    const png = "iVBORw0KGgoAAAANSUhEUg==";
    const turns = parseClaudeTranscript(lines(
      { type: "user", uuid: "00000000-2222-3333-4444-555555555555", message: { content: "open both shots" } },
      { type: "assistant", message: { content: [{ type: "tool_use", id: "toolu_a", name: "Read", input: { file_path: "a.txt" } }, { type: "tool_use", id: "toolu_b", name: "Read", input: { file_path: "b.png" } }], stop_reason: "tool_use" } },
      { type: "user", uuid: "77777777-2222-3333-4444-555555555555", message: { content: [
        { type: "tool_result", tool_use_id: "toolu_a", content: "plain text" },
        { type: "tool_result", tool_use_id: "toolu_b", content: [
          { type: "text", text: "read b.png" },
          { type: "image", source: { type: "base64", media_type: "image/png", data: png } },
          // a type the chat never shows, and bytes that are no picture under a type it does
          { type: "image", source: { type: "base64", media_type: "image/svg+xml", data: "PHN2Zz4=" } },
          { type: "image", source: { type: "base64", media_type: "image/png", data: "PHN2Zz4=" } },
        ] },
      ] } },
    ));
    const tools = turns.flatMap((turn) => turn.parts).filter((part) => part.kind === "tool");
    expect(tools.map((tool) => [tool.output, tool.images])).toEqual([
      ["plain text", undefined],
      ["read b.png", [{ media_type: "image/png", ref: "77777777-2222-3333-4444-555555555555:1:1" }]],
    ]);
    expect(JSON.stringify(turns)).not.toContain(png);
  });

  it("opens a turn at a prompt that is only a picture, as at a text one", () => {
    const picture = (data: string) => ({ type: "image", source: { type: "base64", media_type: "image/png", data } });
    const records = [
      { type: "user", uuid: "11111111-2222-3333-4444-555555555555", message: { content: "first" } },
      { type: "assistant", message: { content: [{ type: "text", text: "one" }], stop_reason: "end_turn" } },
      { type: "user", uuid: "22222222-2222-3333-4444-555555555555", message: { content: [picture("iVBORw0KGgoAAAANSUhEUg==")] } },
      { type: "assistant", message: { content: [{ type: "text", text: "two" }], stop_reason: "end_turn" } },
      // what the parser draws no picture for opens nothing either
      { type: "user", uuid: "33333333-2222-3333-4444-555555555555", message: { content: [picture("PHN2Zz4=")] } },
    ].map((record) => JSON.stringify(record));
    const bytes = Buffer.from(records.join("\n"));
    expect(turnStarts(bytes, "claude-transcript")).toEqual([0, records[0]!.length + records[1]!.length + 2]);
  });

  it("keeps a tool's result on the page of its call when a picture shares the result's record", () => {
    const dir = mkdtempSync(join(tmpdir(), "herdr-image-"));
    try {
      const path = join(dir, "session.jsonl");
      const picture = { type: "image", source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgoAAAANSUhEUg==" } };
      const text = lines(
        { type: "user", uuid: "11111111-2222-3333-4444-555555555555", message: { content: "read it" } },
        { type: "assistant", message: { content: [{ type: "tool_use", id: "toolu_r", name: "Read", input: { file_path: "a.png" } }], stop_reason: "tool_use" } },
        { type: "user", uuid: "22222222-2222-3333-4444-555555555555", message: { content: [{ type: "tool_result", tool_use_id: "toolu_r", content: [{ type: "text", text: "Read output" }, picture] }, picture] } },
        { type: "assistant", message: { content: [{ type: "text", text: "done" }], stop_reason: "end_turn" } },
      );
      writeFileSync(path, `${text}\n`);
      const page = transcriptPage("claude-transcript", path).turns;
      expect(page).toEqual(parseClaudeTranscript(text));
      expect(page.flatMap((turn) => turn.parts).find((part) => part.kind === "tool")).toMatchObject({ output: "Read output", images: [{ media_type: "image/png", ref: "22222222-2222-3333-4444-555555555555:0:1" }] });
    } finally { rmSync(dir, { recursive: true, force: true }); forgetTranscriptState(); }
  });

  it("marks where a compaction folded the conversation, with its summary", () => {
    const turns = parseClaudeTranscript(lines(
      { type: "user", timestamp: "2026-09-27T00:00:00Z", message: { content: "before" } },
      { type: "user", isCompactSummary: true, timestamp: "2026-09-27T01:00:00Z", message: { content: "This session is being continued. Summary: X" } },
    ));
    expect(turns.at(-1)).toEqual({ role: "user", ts: "2026-09-27T01:00:00Z", parts: [{ kind: "compact", text: "This session is being continued. Summary: X" }] });
  });
});

describe("transcriptImage", () => {
  it("decodes the image a ref names, and nothing else", () => {
    const dir = mkdtempSync(join(tmpdir(), "herdr-image-"));
    try {
      const path = join(dir, "session.jsonl");
      const uuid = "11111111-2222-3333-4444-555555555555";
      const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      writeFileSync(path, [
        { type: "user", uuid: "99999999-2222-3333-4444-555555555555", message: { content: [{ type: "text", text: "x" }] } },
        { type: "user", uuid, message: { content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: png.toString("base64") } }, { type: "text", text: "what?" }, { type: "image", source: { type: "base64", media_type: "image/svg+xml", data: "PHN2Zz4=" } }] } },
      ].map((entry) => JSON.stringify(entry)).join("\n"));
      const image = transcriptImage(path, `${uuid}:0`);
      expect(image?.mediaType).toBe("image/png");
      expect(Buffer.from(image!.bytes).equals(png)).toBe(true);
      // a text block, a type a page never shows, another entry's index, a ref that is no ref
      expect(transcriptImage(path, `${uuid}:1`)).toBeNull();
      expect(transcriptImage(path, `${uuid}:2`)).toBeNull();
      expect(transcriptImage(path, "99999999-2222-3333-4444-555555555555:0")).toBeNull();
      expect(transcriptImage(path, "../../etc/passwd:0")).toBeNull();
      expect(transcriptImage(join(dir, "missing.jsonl"), `${uuid}:0`)).toBeNull();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("decodes a tool's picture by its place in the result, and only a picture the page would name", () => {
    const dir = mkdtempSync(join(tmpdir(), "herdr-image-"));
    try {
      const path = join(dir, "session.jsonl");
      const uuid = "77777777-2222-3333-4444-555555555555";
      const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
      const image = (media_type: string, data: string) => ({ type: "image", source: { type: "base64", media_type, data } });
      // just past the endpoint's 8 MiB, behind a real PNG signature
      const huge = png.toString("base64") + "A".repeat(Math.ceil(8 * 1024 * 1024 * 4 / 3));
      const records = [
        { type: "assistant", message: { content: [{ type: "tool_use", id: "toolu_b", name: "Read", input: { file_path: "b.png" } }], stop_reason: "tool_use" } },
        { type: "user", uuid, message: { content: [
          { type: "tool_result", tool_use_id: "toolu_a", content: "plain text" },
          { type: "tool_result", tool_use_id: "toolu_b", content: [{ type: "text", text: "read b.png" }, image("image/png", png.toString("base64")), image("image/png", "PHN2Zz4="), image("image/png", huge)] },
        ] } },
      ];
      writeFileSync(path, records.map((entry) => JSON.stringify(entry)).join("\n"));
      const read = transcriptImage(path, `${uuid}:1:1`);
      expect(read?.mediaType).toBe("image/png");
      expect(Buffer.from(read!.bytes).equals(png)).toBe(true);
      // the page names the same one picture the endpoint serves
      const tool = parseClaudeTranscript(readFileSync(path, "utf8")).flatMap((turn) => turn.parts).find((part) => part.kind === "tool");
      expect(tool?.kind === "tool" ? tool.images : null).toEqual([{ media_type: "image/png", ref: `${uuid}:1:1` }]);
      // the result's text, no picture at that place, a result named as if it were the picture,
      // bytes that are no picture, a picture past the endpoint's size, a ref that is no ref
      for (const ref of [`${uuid}:1:0`, `${uuid}:0:0`, `${uuid}:1:9`, `${uuid}:1`, `${uuid}:1:2`, `${uuid}:1:3`, `${uuid}:1:1:0`, `${uuid}:1:x`]) expect(transcriptImage(path, ref)).toBeNull();
      // a /clear puts the pictures before it out of reach, as it does their page
      appendFileSync(path, `\n${JSON.stringify({ type: "user", message: { role: "user", content: "<command-name>/clear</command-name>" } })}\n`);
      expect(transcriptImage(path, `${uuid}:1:1`)).toBeNull();
    } finally { rmSync(dir, { recursive: true, force: true }); forgetTranscriptState(); }
  });

  it("serves only the pictures of the branch the page shows, from the entry it draws", () => {
    const dir = mkdtempSync(join(tmpdir(), "herdr-image-"));
    try {
      const path = join(dir, "session.jsonl");
      const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
      const picture = (data: string) => ({ type: "image", source: { type: "base64", media_type: data.startsWith("R0lG") ? "image/gif" : "image/png", data } });
      const png = "iVBORw0KGgoAAAANSUhEUg==";
      const gif = "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";
      const read = (n: number, parent: number) => ({ type: "assistant", uuid: id(n), parentUuid: id(parent), message: { content: [{ type: "tool_use", id: `toolu_${n}`, name: "Read", input: { file_path: "a.png" } }], stop_reason: "tool_use" } });
      const result = (n: number, parent: number, call: number, data: string, extra = {}) => ({ type: "user", uuid: id(n), parentUuid: id(parent), ...extra, message: { role: "user", content: [{ type: "tool_result", tool_use_id: `toolu_${call}`, content: [{ type: "text", text: "Read output" }, picture(data)] }] } });
      const answer = (n: number, parent: number) => ({ type: "assistant", uuid: id(n), parentUuid: id(parent), message: { content: [{ type: "text", text: `answer ${n}` }], stop_reason: "end_turn" } });
      writeFileSync(path, [
        { type: "user", uuid: id(1), parentUuid: null, message: { role: "user", content: "look at the old shot" } },
        read(2, 1), result(3, 2, 2, png), answer(4, 3),
        // a rewind back to the start, and a prompt that is only a picture
        { type: "user", uuid: id(5), parentUuid: null, message: { role: "user", content: [picture(png)] } },
        read(6, 5),
        // a record the parser hides, under the id of the result it draws
        result(7, 6, 6, gif, { isMeta: true }), result(7, 6, 6, png), answer(8, 7),
      ].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
      const refs = transcriptPage("claude-transcript", path).turns.flatMap((turn) => turn.parts.flatMap((part) => part.kind === "image" ? [part.ref] : part.kind === "tool" ? (part.images ?? []).map((image) => image.ref) : []));
      expect(refs).toEqual([`${id(5)}:0`, `${id(7)}:0:1`]);
      expect(transcriptImage(path, `${id(5)}:0`)?.mediaType).toBe("image/png");
      expect(transcriptImage(path, `${id(7)}:0:1`)?.mediaType).toBe("image/png");
      // the Read the rewind left behind is no picture of this conversation's
      expect(transcriptImage(path, `${id(3)}:0:1`)).toBeNull();
    } finally { rmSync(dir, { recursive: true, force: true }); forgetTranscriptState(); }
  });

  it("serves a tool's picture only from a result the page draws, one that answers a call it shows", () => {
    const dir = mkdtempSync(join(tmpdir(), "herdr-image-"));
    try {
      const path = join(dir, "session.jsonl");
      const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
      const picture = { type: "image", source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgoAAAANSUhEUg==" } };
      const call = (n: number, toolId: string, extra = {}) => ({ type: "assistant", uuid: id(n), ...extra, message: { content: [{ type: "tool_use", id: toolId, name: "Read", input: { file_path: "a.png" } }], stop_reason: "tool_use" } });
      const result = (toolId: string, withPicture = true) => ({ type: "tool_result", tool_use_id: toolId, content: withPicture ? [{ type: "text", text: "Read output" }, picture] : "text only" });
      const user = (n: number, content: unknown[]) => ({ type: "user", uuid: id(n), message: { role: "user", content } });
      writeFileSync(path, [
        { type: "user", uuid: id(1), message: { role: "user", content: "read the shots" } },
        call(2, "toolu_a"), user(3, [result("toolu_a")]),
        // no call made it: an orphan result
        user(4, [result("toolu_none")]),
        // a second answer to a call already answered
        user(5, [result("toolu_a")]),
        // answered by the entry's own first result, then again
        call(6, "toolu_b"), user(7, [result("toolu_b", false), result("toolu_b")]),
        // a call the parser hides
        call(8, "toolu_c", { isMeta: true }), user(9, [result("toolu_c")]),
        { type: "assistant", uuid: id(10), message: { content: [{ type: "text", text: "done" }], stop_reason: "end_turn" } },
      ].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
      const refs = transcriptPage("claude-transcript", path).turns.flatMap((turn) => turn.parts.flatMap((part) => part.kind === "tool" ? (part.images ?? []).map((image) => image.ref) : []));
      expect(refs).toEqual([`${id(3)}:0:1`]);
      expect(transcriptImage(path, `${id(3)}:0:1`)?.mediaType).toBe("image/png");
      for (const ref of [`${id(4)}:0:1`, `${id(5)}:0:1`, `${id(7)}:1:1`, `${id(9)}:0:1`]) expect(transcriptImage(path, ref)).toBeNull();
    } finally { rmSync(dir, { recursive: true, force: true }); forgetTranscriptState(); }
  });

  it("judges a tool's picture by every record the page reads, whatever its size or its call's id", () => {
    const dir = mkdtempSync(join(tmpdir(), "herdr-image-"));
    try {
      const path = join(dir, "session.jsonl");
      const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
      const png = (size: number) => {
        const bytes = Buffer.alloc(size);
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes);
        return { type: "image", source: { type: "base64", media_type: "image/png", data: bytes.toString("base64") } };
      };
      const call = (n: number, toolId: unknown) => ({ type: "assistant", uuid: id(n), message: { content: [{ type: "tool_use", id: toolId, name: "Read", input: { file_path: "a.png" } }], stop_reason: "tool_use" } });
      const user = (n: number, toolId: string, pictures: unknown[]) => ({ type: "user", uuid: id(n), message: { role: "user", content: [{ type: "tool_result", tool_use_id: toolId, content: pictures }] } });
      writeFileSync(path, [
        { type: "user", uuid: id(1), message: { role: "user", content: "read the shots" } },
        // one result holding two 5 MiB pictures: a record past the history scan's carry
        call(2, "toolu_big"), user(3, "toolu_big", [png(5 * 1024 * 1024), png(5 * 1024 * 1024)]),
        // a second answer to it, which the page does not draw
        user(4, "toolu_big", [png(16)]),
        // a call whose id is written as a number, answered by its text, and one whose id JSON escapes
        call(5, 7), user(6, "7", [png(16)]),
        call(7, 'toolu_"x'), user(8, 'toolu_"x', [png(16)]),
        // a call's id and a prompt's uuid written with \u escapes: JSON reads them as the plain ones
        call(11, "toolu_e"), user(12, "toolu_e", [png(16)]),
        { type: "assistant", uuid: id(10), message: { content: [{ type: "text", text: "done" }], stop_reason: "end_turn" } },
        { type: "user", uuid: id(13), message: { role: "user", content: [png(16)] } },
      ].map((entry) => JSON.stringify(entry)).join("\n").replace('"id":"toolu_e"', '"id":"toolu_\\u0065"').replace(`"uuid":"${id(13)}"`, `"uuid":"\\u0030${id(13).slice(1)}"`) + "\n");
      expect(readFileSync(path, "utf8")).toContain('"id":"toolu_\\u0065"');
      const refs = transcriptPage("claude-transcript", path).turns.flatMap((turn) => turn.parts.flatMap((part) => part.kind === "image" ? [part.ref] : part.kind === "tool" ? (part.images ?? []).map((image) => image.ref) : []));
      expect(refs).toEqual([`${id(3)}:0:0`, `${id(3)}:0:1`, `${id(6)}:0:0`, `${id(8)}:0:0`, `${id(12)}:0:0`, `${id(13)}:0`]);
      for (const ref of refs) expect(transcriptImage(path, ref)?.mediaType).toBe("image/png");
      expect(transcriptImage(path, `${id(4)}:0:0`)).toBeNull();
    } finally { rmSync(dir, { recursive: true, force: true }); forgetTranscriptState(); }
  });

  it("reads a picture's record a window at a time, never the transcript whole", () => {
    const dir = mkdtempSync(join(tmpdir(), "herdr-image-"));
    const alloc = spyOn(Buffer, "alloc");
    try {
      const path = join(dir, "session.jsonl");
      const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
      const png = Buffer.alloc(1_200_000);
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png);
      const filler = (n: number, size: number) => JSON.stringify({ type: "assistant", uuid: id(n), message: { content: [{ type: "text", text: "x".repeat(size) }], stop_reason: "end_turn" } });
      const lines: string[] = [JSON.stringify({ type: "user", uuid: id(1), message: { role: "user", content: "read the shot" } })];
      for (let n = 0; n < 20; n += 1) lines.push(filler(100 + n, 1024 * 1024));
      lines.push(JSON.stringify({ type: "assistant", uuid: id(2), message: { content: [{ type: "tool_use", id: "toolu_a", name: "Read", input: { file_path: "a.png" } }], stop_reason: "tool_use" } }));
      // the picture's id ends 3 bytes past a search window's edge, so the edge cuts it in two
      const record = JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_a", content: [{ type: "text", text: "Read output" }, { type: "image", source: { type: "base64", media_type: "image/png", data: png.toString("base64") } }] }] }, uuid: id(3) });
      const before = lines.join("\n").length + 1;
      const idEnd = (pad: number) => before + filler(99, pad).length + 1 + record.indexOf(id(3)) + id(3).length;
      const edge = Math.ceil((idEnd(0) - 3) / (1024 * 1024)) * 1024 * 1024;
      lines.push(filler(99, edge + 3 - idEnd(0)), record);
      const transcript = lines.join("\n") + "\n";
      writeFileSync(path, transcript);
      expect((transcript.indexOf(id(3)) + id(3).length) % (1024 * 1024)).toBe(3);
      expect(transcript.length).toBeGreaterThan(TRANSCRIPT_WINDOW_BYTES + 1024 * 1024);
      alloc.mockClear();
      const image = transcriptImage(path, `${id(3)}:0:1`);
      expect(image?.mediaType).toBe("image/png");
      expect(Buffer.from(image!.bytes).equals(png)).toBe(true);
      // no read took the transcript whole
      expect(Math.max(...alloc.mock.calls.map(([size]) => Number(size)))).toBeLessThan(transcript.length - 1024 * 1024);
    } finally { alloc.mockRestore(); rmSync(dir, { recursive: true, force: true }); forgetTranscriptState(); }
  });

  it("reads a record's cut strings as JSON does: their escapes, their marks, their spelling", () => {
    const dir = mkdtempSync(join(tmpdir(), "herdr-image-"));
    try {
      const path = join(dir, "session.jsonl");
      const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
      const pngBytes = (size: number) => {
        const bytes = Buffer.alloc(size);
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes);
        return bytes;
      };
      const png = (data: string) => ({ type: "image", source: { type: "base64", media_type: "image/png", data } });
      const small = pngBytes(16).toString("base64");
      const pad = "x".repeat(2048);
      const call = (n: number, toolId: unknown) => JSON.stringify({ type: "assistant", uuid: id(n), message: { content: [{ type: "tool_use", id: toolId, name: "Read", input: { file_path: "a.png", pad } }], stop_reason: "tool_use" } });
      const result = (n: number, toolId: string, data = small) => JSON.stringify({ type: "user", uuid: id(n), message: { role: "user", content: [{ type: "tool_result", tool_use_id: toolId, content: [png(data)] }] } });
      // a picture whose every base64 character is written as a \u escape: six times its text
      const escaped = pngBytes(1_500_000);
      const escapedText = [...escaped.toString("base64")].map((char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`).join("");
      writeFileSync(path, [
        JSON.stringify({ type: "user", uuid: id(1), message: { role: "user", content: "read the shots" } }),
        // an escape JSON does not have, past where a string is cut: the page reads no such record
        JSON.stringify({ type: "user", uuid: id(2), message: { role: "user", content: [png(small), { type: "text", text: pad }] } }).replace(pad, `${pad}\\q`),
        // an id that ends as a cut string's mark once did, after a string that is cut
        call(3, "toolu_\u0000cut:0"), result(4, "toolu_\u0000cut:0"),
        call(5, "toolu_esc"), result(6, "toolu_esc").replace(`"data":"${small}"`, `"data":"${escapedText}"`),
        // a line that is JSON but no record, between a call and its result
        call(7, "toolu_n"), "null", result(8, "toolu_n"),
        // a call id written as a number in another spelling than the text it is keyed by
        call(9, 1000).replace('"id":1000', '"id":1e3'), result(10, "1000"),
        call(12, 1000).replace('"id":1000', '"id":1e400'), result(13, "Infinity"),
        // a call id that starts with a BOM is another id than the same text without it
        call(14, `\uFEFF${"a".repeat(1024)}`), result(15, "a".repeat(1024)),
        JSON.stringify({ type: "assistant", uuid: id(11), message: { content: [{ type: "text", text: "done" }], stop_reason: "end_turn" } }),
      ].join("\n") + "\n");
      const refs = transcriptPage("claude-transcript", path).turns.flatMap((turn) => turn.parts.flatMap((part) => part.kind === "image" ? [part.ref] : part.kind === "tool" ? (part.images ?? []).map((image) => image.ref) : []));
      expect(refs).toEqual([`${id(4)}:0:0`, `${id(6)}:0:0`, `${id(8)}:0:0`, `${id(10)}:0:0`, `${id(13)}:0:0`]);
      for (const ref of refs) expect(transcriptImage(path, ref)?.mediaType).toBe("image/png");
      expect(transcriptImage(path, `${id(15)}:0:0`)).toBeNull();
      expect(Buffer.from(transcriptImage(path, `${id(6)}:0:0`)!.bytes).equals(escaped)).toBe(true);
      expect(transcriptImage(path, `${id(2)}:0`)).toBeNull();
    } finally { rmSync(dir, { recursive: true, force: true }); forgetTranscriptState(); }
  });

  it("serves nothing a record it cannot hold could decide, rather than guess", () => {
    const dir = mkdtempSync(join(tmpdir(), "herdr-image-"));
    try {
      const path = join(dir, "session.jsonl");
      const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
      const picture = { type: "image", source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgoAAAANSUhEUg==" } };
      // a result whose shape alone is past what the endpoint holds: thousands of strings under the cut
      const shapeOnly = Array.from({ length: 4200 }, () => "x".repeat(1023));
      writeFileSync(path, [
        { type: "user", uuid: id(1), message: { role: "user", content: "read the shot" } },
        { type: "assistant", uuid: id(2), message: { content: [{ type: "tool_use", id: "toolu_a", name: "Read", input: { file_path: "a.png" } }], stop_reason: "tool_use" } },
        { type: "user", uuid: id(3), message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_a", content: [picture], pad: shapeOnly }] } },
        // a second answer to the call, which the page does not draw
        { type: "user", uuid: id(4), message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_a", content: [picture] }] } },
      ].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
      const refs = transcriptPage("claude-transcript", path).turns.flatMap((turn) => turn.parts.flatMap((part) => part.kind === "tool" ? (part.images ?? []).map((image) => image.ref) : []));
      expect(refs).toEqual([`${id(3)}:0:0`]);
      expect(transcriptImage(path, `${id(4)}:0:0`)).toBeNull();
    } finally { rmSync(dir, { recursive: true, force: true }); forgetTranscriptState(); }
  });

  it("holds a window, a record's shape and the picture, never a record whole however large", () => {
    const dir = mkdtempSync(join(tmpdir(), "herdr-image-"));
    const alloc = spyOn(Buffer, "alloc");
    try {
      const path = join(dir, "session.jsonl");
      const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
      const png = Buffer.alloc(300_000);
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png);
      const pad = "x".repeat(20 * 1024 * 1024);
      writeFileSync(path, [
        { type: "user", uuid: id(1), message: { role: "user", content: "read the shot" } },
        // a call and its result, each padded past the largest picture the chat shows
        { type: "assistant", uuid: id(2), message: { content: [{ type: "tool_use", id: "toolu_a", name: "Read", input: { file_path: "a.png", pad } }], stop_reason: "tool_use" } },
        { type: "user", uuid: id(3), message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_a", content: [{ type: "text", text: pad }, { type: "image", source: { type: "base64", media_type: "image/png", data: png.toString("base64") } }] }] } },
      ].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
      // the first read scans the history once; the endpoint's own reads are what is left
      expect(transcriptImage(path, `${id(3)}:0:1`)?.mediaType).toBe("image/png");
      alloc.mockClear();
      const image = transcriptImage(path, `${id(3)}:0:1`);
      expect(Buffer.from(image!.bytes).equals(png)).toBe(true);
      expect(Math.max(...alloc.mock.calls.map(([size]) => Number(size)))).toBeLessThanOrEqual(1024 * 1024);
    } finally { alloc.mockRestore(); rmSync(dir, { recursive: true, force: true }); forgetTranscriptState(); }
  });

  it("takes a picture up to the endpoint's size exactly, its padding left out", () => {
    const png = (size: number) => {
      const bytes = Buffer.alloc(size);
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes);
      return { type: "image", source: { type: "base64", media_type: "image/png", data: bytes.toString("base64") } };
    };
    expect(claudeImageType(png(8 * 1024 * 1024))).toBe("image/png");
    expect(claudeImageType(png(8 * 1024 * 1024 + 1))).toBeNull();
  });
});

describe("a cut tool output and the whole of it", () => {
  it("keeps the call id of an output cut for the page, and finds the whole one by it", () => {
    const dir = mkdtempSync(join(tmpdir(), "herdr-output-"));
    try {
      const long = "x".repeat(9_000);
      const claude = [
        { type: "assistant", timestamp: "2026-09-27T00:00:00Z", message: { content: [{ type: "tool_use", id: "toolu_long", name: "Bash", input: { command: "big" } }, { type: "tool_use", id: "toolu_short", name: "Bash", input: { command: "small" } }] } },
        { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "toolu_long", content: long }, { type: "tool_result", tool_use_id: "toolu_short", content: "ok" }] } },
      ].map((entry) => JSON.stringify(entry)).join("\n");
      const tools = parseClaudeTranscript(claude).flatMap((turn) => turn.parts).filter((part) => part.kind === "tool");
      expect(tools.map((tool) => [tool.output_ref, tool.output_size])).toEqual([["toolu_long", 9_000], [undefined, undefined]]);
      expect(tools[0]!.output.length).toBeLessThan(4_100);
      const path = join(dir, "claude.jsonl");
      writeFileSync(path, claude);
      expect(transcriptToolOutput("claude-transcript", path, "toolu_long")).toBe(long);
      expect(transcriptToolOutput("claude-transcript", path, "toolu_none")).toBeNull();
      expect(transcriptToolOutput("claude-transcript", path, "../etc")).toBeNull();
      const omp = join(dir, "omp.jsonl");
      writeFileSync(omp, JSON.stringify({ type: "message", message: { role: "toolResult", toolCallId: "call_1", content: [{ type: "text", text: long }] } }));
      expect(transcriptToolOutput("omp-transcript", omp, "call_1")).toBe(long);
      expect(transcriptToolOutput("omo-transcript", omp, "call_1")).toBe(long);
      appendFileSync(omp, `\n${JSON.stringify({ type: "message", message: { role: "toolResult", toolCallId: "call_2", content: [{ type: "text", text: "x".repeat(17 * 1024 * 1024) }] } })}\n`);
      expect(transcriptToolOutput("omo-transcript", omp, "call_2")).toBeNull();
      const codex = join(dir, "codex.jsonl");
      writeFileSync(codex, JSON.stringify({ type: "response_item", payload: { type: "function_call_output", call_id: "call_x", output: long } }));
      expect(transcriptToolOutput("codex-transcript", codex, "call_x")).toBe(long);
      const kimi = join(dir, "kimi.jsonl");
      writeFileSync(kimi, [
        { type: "context.append_loop_event", event: { type: "tool.call", toolCallId: "tool_long", name: "Bash", args: { command: "big" } } },
        { type: "context.append_loop_event", event: { type: "tool.result", toolCallId: "tool_long", result: { output: long } } },
      ].map((entry) => JSON.stringify(entry)).join("\n"));
      expect(transcriptToolOutput("kimi-transcript", kimi, "tool_long")).toBe(long);
      expect(transcriptToolOutput("kimi-transcript", kimi, "tool_none")).toBeNull();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("returns the exact OMO output budget across decoded chunks and content blocks", () => {
    const dir = mkdtempSync(join(tmpdir(), "herdr-omo-output-"));
    const path = join(dir, "session.jsonl");
    const record = (id: string, content: { type: string; text: string }[]) =>
      JSON.stringify({ type: "message", message: { role: "toolResult", toolCallId: id, content } }) + "\n";
    try {
      writeFileSync(path, record("single", [{ type: "text", text: "x".repeat(3_000_000) }]));
      expect(transcriptToolOutput("omo-transcript", path, "single")).toBe(`${"x".repeat(2_000_000)}\n… trimmed`);
      const first = "한\\\n".repeat(300_000);
      const second = "z".repeat(1_500_000);
      const whole = first + second;
      writeFileSync(path, record("large", [{ type: "text", text: first }, { type: "text", text: second }]));
      expect(transcriptToolOutput("omo-transcript", path, "large")).toBe(`${whole.slice(0, 2_000_000)}\n… trimmed`);
      writeFileSync(path, record("exact", [{ type: "text", text: "x".repeat(2_000_000) }]));
      expect(transcriptToolOutput("omo-transcript", path, "exact")).toBe("x".repeat(2_000_000));
      writeFileSync(path, record("over", [{ type: "text", text: "x".repeat(2_000_001) }]));
      expect(transcriptToolOutput("omo-transcript", path, "over")).toBe(`${"x".repeat(2_000_000)}\n… trimmed`);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("ignores records outside the OMO tail and resets output on context clear", () => {
    const dir = mkdtempSync(join(tmpdir(), "herdr-omo-tail-"));
    const path = join(dir, "session.jsonl");
    const record = (id: string, text: string) => JSON.stringify({ type: "message", message: { role: "toolResult", toolCallId: id, content: [{ type: "text", text }] } }) + "\n";
    try {
      writeFileSync(path, record("old", "old output") + record("huge", "x".repeat(17 * 1024 * 1024)) + record("recent", "recent output"));
      expect(transcriptToolOutput("omo-transcript", path, "old")).toBeNull();
      expect(transcriptToolOutput("omo-transcript", path, "huge")).toBeNull();
      expect(transcriptToolOutput("omo-transcript", path, "recent")).toBe("recent output");
      appendFileSync(path, JSON.stringify({ type: "custom", customType: "context_clear" }) + "\n");
      expect(transcriptToolOutput("omo-transcript", path, "recent")).toBeNull();
      appendFileSync(path, record("recent", "after clear"));
      expect(transcriptToolOutput("omo-transcript", path, "recent")).toBe("after clear");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("reads a whole OMO record that starts exactly where the tail window does", () => {
    const dir = mkdtempSync(join(tmpdir(), "herdr-omo-edge-"));
    const path = join(dir, "session.jsonl");
    const record = JSON.stringify({ type: "message", message: { role: "toolResult", toolCallId: "edge", content: [{ type: "text", text: "at the edge" }] } }) + "\n";
    try {
      // the window starts at the first 64 KiB boundary at least 16 MiB before the end; a newline ends the byte before it
      writeFileSync(path, "x".repeat(64 * 1024 - 1) + "\n" + record);
      fs.truncateSync(path, TRANSCRIPT_WINDOW_BYTES + 64 * 1024 - 1);
      appendFileSync(path, "\n");
      expect(transcriptToolOutput("omo-transcript", path, "edge")).toBe("at the edge");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("bounds total OMO output reads to the transcript tail", () => {
    const dir = mkdtempSync(join(tmpdir(), "herdr-omo-io-"));
    const path = join(dir, "session.jsonl");
    const record = (id: string, text: string) => JSON.stringify({ type: "message", message: { role: "toolResult", toolCallId: id, content: [{ type: "text", text }] } }) + "\n";
    try {
      writeFileSync(path, record("old", "outside"));
      fs.truncateSync(path, 128 * 1024 * 1024);
      appendFileSync(path, "\n" + record("recent", "inside"));
      const original = fs.readSync;
      let bytes = 0;
      const reads = spyOn(fs, "readSync").mockImplementation(((...args: Parameters<typeof fs.readSync>) => {
        const got = original(...args); bytes += got; return got;
      }) as typeof fs.readSync);
      try {
        expect(transcriptToolOutput("omo-transcript", path, "recent")).toBe("inside");
        expect(bytes).toBeGreaterThan(0);
        expect(bytes).toBeLessThanOrEqual(2 * TRANSCRIPT_WINDOW_BYTES + 1024);
        bytes = 0;
        expect(transcriptToolOutput("omo-transcript", path, "old")).toBeNull();
        expect(bytes).toBeGreaterThan(0);
        expect(bytes).toBeLessThanOrEqual(2 * TRANSCRIPT_WINDOW_BYTES + 1024);
      } finally { reads.mockRestore(); }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});


it("preserves literal paste lookalikes, partial wrappers and mismatched ids", () => {
  const cases = [
    '<pasted_content id="a">\nverbatim\n</pasted_content id="b">',
    '<pasted_content>\nverbatim\n</pasted_content>',
    '<pasted_content id="a">verbatim</pasted_content id="a">',
    '<pasted_content id="a">\nunfinished',
    '\n\nordinary prompt\n',
  ];
  for (const text of cases) expect(unwrapPastes(text)).toBe(text);
  expect(unwrapPastes('before\n<pasted_content id="a_1">\r\nfirst\r\n</pasted_content id="a_1">\nafter')).toBe("before\nfirst\nafter");
});

it("incrementally reads one growing Codex task across split UTF-8, partial records and a rewrite", () => {
  const root = mkdtempSync(join(tmpdir(), "herdr-codex-growing-"));
  try {
    const path = join(root, "live.jsonl");
    const cold = join(root, "cold.jsonl");
    const records = [
      { type: "event_msg", payload: { type: "task_started" } },
      { type: "event_msg", timestamp: "2026-09-27T00:00:00Z", payload: { type: "user_message", message: "한글 👋" } },
      { type: "turn_context", payload: { model: "model-a", effort: "high" } },
      ...Array.from({ length: 30 }, (_, n) => [
        { type: "response_item", payload: { type: "function_call", name: "exec_command", call_id: `c${n}`, arguments: '{"cmd":"ls"}' } },
        { type: "response_item", payload: { type: "function_call_output", call_id: `c${n}`, output: "x".repeat(5000) } },
      ]).flat(),
      { type: "response_item", payload: { type: "message", role: "assistant", phase: "final_answer", content: [{ type: "output_text", text: "끝났어요" }] } },
    ];
    const whole = Buffer.from(records.map((entry) => JSON.stringify(entry)).join("\n"));
    writeFileSync(path, "");
    for (let at = 0, step = 1; at < whole.length; step = (step * 13) % 571 + 1) {
      const next = whole.subarray(at, at + step * 7);
      appendFileSync(path, next); at += next.length;
      writeFileSync(cold, whole.subarray(0, at));
      const live = transcriptPage("codex-transcript", path);
      const reference = transcriptPage("codex-transcript", cold);
      expect(live.turns).toEqual(reference.turns);
      expect(live.metadata).toEqual(reference.metadata);
    }
    const original = transcriptPage("codex-transcript", path);
    writeFileSync(path, whole.toString("utf8").replace("model-a", "model-b"));
    // Some filesystems coalesce immediate writes into one timestamp tick.
    utimesSync(path, new Date(), new Date(Date.now() + 1000));
    expect(transcriptPage("codex-transcript", path).metadata.model).toBe("model-b");
    expect(original.metadata.model).toBe("model-a");
    writeFileSync(path, records.slice(0, 2).map((entry) => JSON.stringify(entry)).join("\n"));
    expect(transcriptPage("codex-transcript", path).turns).toHaveLength(1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it("keeps a transcript's history_id across a touch that leaves its bytes alone", () => {
  // Claude Code sets its open session's times about hourly without writing a byte: not a rewrite.
  const root = mkdtempSync(join(tmpdir(), "herdr-claude-touch-"));
  try {
    const path = join(root, "session.jsonl");
    const prompt = (n: number, text: string) => `${JSON.stringify({ type: "user", uuid: `u${n}`, parentUuid: n ? `u${n - 1}` : null, timestamp: "2026-11-06T00:00:00.000Z", message: { role: "user", content: text } })}\n`;
    const id = () => transcriptPage("claude-transcript", path).history_id;
    const touch = (seconds: number) => utimesSync(path, new Date(), new Date(Date.now() + seconds * 1000));
    writeFileSync(path, prompt(0, "alpha") + prompt(1, "bravo"));
    const base = id();
    touch(1);
    expect(id()).toBe(base);
    appendFileSync(path, prompt(2, "charlie"));
    expect(id()).toBe(base);
    touch(2);
    expect(id()).toBe(base);
    // the same size with one early byte changed is still a rewrite
    writeFileSync(path, readFileSync(path, "utf8").replace("alpha", "alphA"));
    touch(3);
    const rewritten = id();
    expect(rewritten).not.toBe(base);
    touch(4);
    expect(id()).toBe(rewritten);
    // the generation lives in memory only: a cold read names the file by its identity alone
    forgetTranscriptState();
    expect(id()).toBe(base);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it("keeps a transcript's history_id across a touch after an image lookup saw it grow", async () => {
  // the image lookup reads asynchronously and leaves the digest for the next page read to extend
  const root = mkdtempSync(join(tmpdir(), "herdr-claude-touch-image-"));
  try {
    const path = join(root, "session.jsonl");
    const prompt = (n: number) => `${JSON.stringify({ type: "user", uuid: `u${n}`, parentUuid: n ? `u${n - 1}` : null, timestamp: "2026-11-06T00:00:00.000Z", message: { role: "user", content: `prompt ${n}` } })}\n`;
    const id = () => transcriptPage("claude-transcript", path).history_id;
    writeFileSync(path, prompt(0));
    const base = id();
    appendFileSync(path, prompt(1));
    expect(await transcriptImageAsync(path, "00000000-0000-0000-0000-000000000000:0")).toBeNull();
    utimesSync(path, new Date(), new Date(Date.now() + 1000));
    expect(id()).toBe(base);
  } finally { forgetTranscriptState(); rmSync(root, { recursive: true, force: true }); }
});

it("changes a transcript's history_id when its first bytes are rewritten while it grows", async () => {
  // same inode: the growth is not a plain append, and restoring the old bytes later is a rewrite again
  const root = mkdtempSync(join(tmpdir(), "herdr-claude-grow-rewrite-"));
  try {
    const path = join(root, "session.jsonl");
    const prompt = (n: number, text: string) => `${JSON.stringify({ type: "user", uuid: `u${n}`, parentUuid: n ? `u${n - 1}` : null, timestamp: "2026-11-06T00:00:00.000Z", message: { role: "user", content: text } })}\n`;
    const id = () => transcriptPage("claude-transcript", path).history_id;
    writeFileSync(path, prompt(0, "alpha") + prompt(1, "bravo"));
    const base = id();
    writeFileSync(path, prompt(0, "ALPHA") + prompt(1, "bravo") + prompt(2, "charlie"));
    const grown = id();
    expect(grown).not.toBe(base);
    writeFileSync(path, prompt(0, "alpha") + prompt(1, "bravo") + prompt(2, "charlie"));
    utimesSync(path, new Date(), new Date(Date.now() + 1000));
    const restored = id();
    expect(restored).not.toBe(grown);
    // an image lookup that sees such a growth first leaves the check to the next page read
    writeFileSync(path, prompt(0, "ALPHA") + prompt(1, "bravo") + prompt(2, "charlie") + prompt(3, "delta"));
    expect(await transcriptImageAsync(path, "00000000-0000-0000-0000-000000000000:0")).toBeNull();
    expect(id()).not.toBe(restored);
  } finally { forgetTranscriptState(); rmSync(root, { recursive: true, force: true }); }
});

/**
 * A link can be made here (Windows wants a privilege for one) and an open can refuse it (O_NOFOLLOW,
 * which Windows does not have: there the transcript readers follow links alike).
 */
const linksRefused = fs.constants.O_NOFOLLOW !== undefined && (() => {
  const probe = mkdtempSync(join(tmpdir(), "herdr-link-probe-"));
  try { symlinkSync(probe, join(probe, "link")); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "EPERM") return false; throw error; }
  finally { rmSync(probe, { recursive: true, force: true }); }
})();

it.skipIf(!linksRefused)("never digests a transcript reached through a link, so its touch counts as a rewrite", () => {
  const root = mkdtempSync(join(tmpdir(), "herdr-claude-touch-link-"));
  try {
    const path = join(root, "target.jsonl");
    const link = join(root, "session.jsonl");
    writeFileSync(path, `${JSON.stringify({ type: "user", uuid: "u0", parentUuid: null, timestamp: "2026-11-06T00:00:00.000Z", message: { role: "user", content: "alpha" } })}\n`);
    symlinkSync(path, link);
    const base = transcriptPage("claude-transcript", link).history_id;
    utimesSync(path, new Date(), new Date(Date.now() + 1000));
    expect(transcriptPage("claude-transcript", link).history_id).not.toBe(base);
  } finally { forgetTranscriptState(); rmSync(root, { recursive: true, force: true }); }
});

describe("a page read that settles its transcript's revision off the event loop", () => {
  let root: string;
  let path: string;
  const pane = { pane_id: "cmd-settle", agent: "cmd", agent_status: "idle", cwd: "" } as HerdrPane;
  const restores: { mockRestore(): void }[] = [];
  let snapshots: { mock: { calls: unknown[] } };
  const message = (id: string, parentId: string | null, content: string) => JSON.stringify({ type: "message", id, parentId, message: { role: "user", content } }) + "\n";
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "herdr-settle-"));
    path = join(root, "session.jsonl");
    writeFileSync(path, JSON.stringify({ type: "session", id: "cmd-settle", version: 3 }) + "\n" + message("u1", null, "hello"));
    pane.cwd = root;
    const snapshot = spyOn(herdr, "sessionSnapshot").mockResolvedValue({ panes: [pane], agents: [pane] } as unknown as SessionSnapshot);
    snapshots = snapshot;
    restores.push(
      spyOn(cmd, "cmdTranscriptPath").mockResolvedValue({ path }),
      snapshot,
      spyOn(herdr, "herdrRpc").mockResolvedValue({ process_info: { foreground_processes: [] } } as never),
    );
  });
  afterEach(() => {
    for (const spy of restores.splice(0)) spy.mockRestore();
    forgetTranscriptState();
    rmSync(root, { recursive: true, force: true });
  });
  /** Holds the first stat of the transcript off the event loop (an lstat, or an open handle's), after it is taken, until `release`. */
  const holdFirstStat = () => {
    const { lstat, open } = fsp;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let held!: () => void;
    const holding = new Promise<void>((resolve) => { held = resolve; });
    let first = true;
    const hold = async <T>(stats: T): Promise<T> => {
      if (first) { first = false; held(); await gate; }
      return stats;
    };
    restores.push(
      spyOn(fsp, "lstat").mockImplementation((async (...args: Parameters<typeof fsp.lstat>) => {
        const stats = await lstat(...args);
        return args[0] === path ? hold(stats) : stats;
      }) as typeof fsp.lstat),
      spyOn(fsp, "open").mockImplementation((async (...args: Parameters<typeof fsp.open>) => {
        const handle = await open(...args);
        if (args[0] !== path) return handle;
        const stat = handle.stat.bind(handle);
        handle.stat = (async (...rest: Parameters<typeof stat>) => hold(await stat(...rest))) as typeof handle.stat;
        return handle;
      }) as typeof fsp.open),
    );
    return { holding, release: () => release() };
  };

  it("keeps the newer revision when an older stat of the transcript answers last", async () => {
    const base = await paneConversation(pane.pane_id);
    const stat = holdFirstStat();
    const older = paneConversation(pane.pane_id);
    await stat.holding;
    appendFileSync(path, message("u2", "u1", "again"));
    const newer = await paneConversation(pane.pane_id);
    expect(newer.history_id).toBe(base.history_id);
    stat.release();
    expect((await older).history_id).toBe(base.history_id);
    // the append was read as one: a cursor from the newer read still names the same history
    expect((await paneConversation(pane.pane_id, undefined, { since: newer.cursor! })).history_id).toBe(base.history_id);
  });

  it("records nothing for a pane closed while its transcript settled", async () => {
    const stat = holdFirstStat();
    const read = paneConversation(pane.pane_id);
    await stat.holding;
    forgetPaneTranscriptState(pane.pane_id);
    stat.release();
    await expect(read).rejects.toMatchObject({ name: "ConversationUnavailable", message: "no_session_id" });
  });

  it("records nothing for a pane closed while its transcript settled, however many panes close after it", async () => {
    const stat = holdFirstStat();
    const read = paneConversation(pane.pane_id);
    await stat.holding;
    forgetPaneTranscriptState(pane.pane_id);
    // more panes than are remembered close after it
    for (let other = 0; other < 200; other++) forgetPaneTranscriptState(`cmd-closed-${other}`);
    stat.release();
    await expect(read).rejects.toMatchObject({ name: "ConversationUnavailable", message: "no_session_id" });
  });

  it("answers nothing from a pane bound to another transcript while its transcript settled", async () => {
    const other = join(root, "other.jsonl");
    writeFileSync(other, JSON.stringify({ type: "session", id: "cmd-other", version: 3 }) + "\n" + message("o1", null, "elsewhere"));
    const stat = holdFirstStat();
    const read = paneConversation(pane.pane_id);
    await stat.holding;
    // a new session in the pane: it writes another file now, which another look at the pane sees
    restores.push(spyOn(cmd, "cmdTranscriptPath").mockResolvedValue({ path: other }));
    expect((await paneTranscript(pane.pane_id)).path).toBe(other);
    stat.release();
    await expect(read).rejects.toMatchObject({ name: "ConversationUnavailable", message: "no_session_id" });
  });

  it("answers nothing from a pane rebound while its transcript settled, though nothing in Ovis looked at the pane meanwhile", async () => {
    const other = join(root, "other.jsonl");
    writeFileSync(other, JSON.stringify({ type: "session", id: "cmd-other", version: 3 }) + "\n" + message("o1", null, "elsewhere"));
    const stat = holdFirstStat();
    const read = paneConversation(pane.pane_id);
    await stat.holding;
    // a new session in the pane, which no read resolves before this one settles
    restores.push(spyOn(cmd, "cmdTranscriptPath").mockResolvedValue({ path: other }));
    stat.release();
    await expect(read).rejects.toMatchObject({ name: "ConversationUnavailable", message: "no_session_id" });
  });

  it("asks herdr for the pane twice per read: to resolve it, and again once its transcript settled", async () => {
    await paneConversation(pane.pane_id);
    appendFileSync(path, message("u2", "u1", "again"));
    const before = snapshots.mock.calls.length;
    await paneConversation(pane.pane_id);
    expect(snapshots.mock.calls.length - before).toBe(2);
  });

  it("parses an actively written transcript only once its revision settled", async () => {
    const base = await paneConversation(pane.pane_id);
    const { open } = fsp;
    let writes = 0;
    const parses = spyOn(piTree, "piAbandonedTurns");
    restores.push(
      parses,
      // a settle's last stat of the transcript: an append lands right after it, before the page read, twice
      spyOn(fsp, "open").mockImplementation((async (...args: Parameters<typeof fsp.open>) => {
        const handle = await open(...args);
        if (args[0] !== path) return handle;
        const stat = handle.stat.bind(handle);
        let stats = 0;
        handle.stat = (async (...rest: Parameters<typeof stat>) => {
          const taken = await stat(...rest);
          if (++stats === 2 && writes < 2) { writes++; appendFileSync(path, message(`w${writes}`, writes === 1 ? "u1" : "w1", "more")); }
          return taken;
        }) as typeof handle.stat;
        return handle;
      }) as typeof fsp.open),
    );
    const answer = await paneConversation(pane.pane_id);
    expect(writes).toBe(2);
    expect(answer.history_id).toBe(base.history_id);
    expect(parses).toHaveBeenCalledTimes(1);
  });

  it("never answers the old history for a transcript rewritten in place and grown that keeps growing through every settle", async () => {
    const base = await paneConversation(pane.pane_id);
    // rewritten in place (same inode), its first bytes changed, and longer than before
    writeFileSync(path, JSON.stringify({ type: "session", id: "cmd-settle", version: 3 }) + "\n" + message("u1", null, "HELLO, rewritten"));
    const { open } = fsp;
    let writes = 0;
    restores.push(
      // each settle's last stat of the transcript: an append lands right after it, so no settle records
      spyOn(fsp, "open").mockImplementation((async (...args: Parameters<typeof fsp.open>) => {
        const handle = await open(...args);
        if (args[0] !== path) return handle;
        const stat = handle.stat.bind(handle);
        let stats = 0;
        handle.stat = (async (...rest: Parameters<typeof stat>) => {
          const taken = await stat(...rest);
          if (++stats === 2) { writes++; appendFileSync(path, message(`w${writes}`, writes === 1 ? "u1" : `w${writes - 1}`, "more")); }
          return taken;
        }) as typeof handle.stat;
        return handle;
      }) as typeof fsp.open),
    );
    const answer = await paneConversation(pane.pane_id).catch((error: unknown) => error);
    expect(writes).toBe(3);
    expect(answer).toBeInstanceOf(ConversationReadPending);
    for (const spy of restores.splice(3)) spy.mockRestore();
    // the next poll checks the first bytes and finds the rewrite
    expect((await paneConversation(pane.pane_id)).history_id).not.toBe(base.history_id);
  });

  it("answers a transcript written to through every settle of two polls on the second, under another history", async () => {
    const base = await paneConversation(pane.pane_id);
    const { open } = fsp;
    let writes = 0;
    restores.push(
      // each settle's last stat of the transcript: an append lands right after it, so no settle records
      spyOn(fsp, "open").mockImplementation((async (...args: Parameters<typeof fsp.open>) => {
        const handle = await open(...args);
        if (args[0] !== path) return handle;
        const stat = handle.stat.bind(handle);
        let stats = 0;
        handle.stat = (async (...rest: Parameters<typeof stat>) => {
          const taken = await stat(...rest);
          if (++stats === 2) { writes++; appendFileSync(path, message(`w${writes}`, writes === 1 ? "u1" : `w${writes - 1}`, "more")); }
          return taken;
        }) as typeof handle.stat;
        return handle;
      }) as typeof fsp.open),
    );
    await expect(paneConversation(pane.pane_id)).rejects.toBeInstanceOf(ConversationReadPending);
    // its growth was never checked: another history, not the old one and not pending again
    expect((await paneConversation(pane.pane_id)).history_id).not.toBe(base.history_id);
    expect(writes).toBe(6);
  });

  it("answers a transcript written to through every settle under one history after its first pending poll, and sees a rewrite once writes stop", async () => {
    const base = await paneConversation(pane.pane_id);
    const { open } = fsp;
    let writing = true;
    let writes = 0;
    restores.push(
      // while writing, an append lands right after each settle's last stat of the transcript, so no settle records
      spyOn(fsp, "open").mockImplementation((async (...args: Parameters<typeof fsp.open>) => {
        const handle = await open(...args);
        if (args[0] !== path) return handle;
        const stat = handle.stat.bind(handle);
        let stats = 0;
        handle.stat = (async (...rest: Parameters<typeof stat>) => {
          const taken = await stat(...rest);
          if (++stats === 2 && writing) { writes++; appendFileSync(path, message(`w${writes}`, writes === 1 ? "u1" : `w${writes - 1}`, "more")); }
          return taken;
        }) as typeof handle.stat;
        return handle;
      }) as typeof fsp.open),
    );
    const polls: (string | "pending")[] = [];
    for (let poll = 0; poll < 5; poll++) {
      try { polls.push((await paneConversation(pane.pane_id)).history_id); }
      catch (error) { if (!(error instanceof ConversationReadPending)) throw error; polls.push("pending"); }
    }
    expect(writes).toBe(15);
    const answered = polls.findIndex((poll) => poll !== "pending");
    expect(answered).toBeGreaterThanOrEqual(0);
    expect(answered).toBeLessThanOrEqual(1);
    const history = polls[answered] ?? "";
    expect(history).not.toBe(base.history_id);
    expect(polls.slice(answered)).toEqual(polls.slice(answered).map(() => history));
    // the writes were appends: once they stop, the history stays
    writing = false;
    expect((await paneConversation(pane.pane_id)).history_id).toBe(history);
    // an in-place rewrite that also grew is another history
    writeFileSync(path, JSON.stringify({ type: "session", id: "cmd-settle", version: 3 }) + "\n" + message("u1", null, "HELLO, rewritten") + "x".repeat(4096) + "\n");
    expect((await paneConversation(pane.pane_id)).history_id).not.toBe(history);
  });

  it("never digests another agent's transcript that a folder swapped in after authorization puts at the path", async () => {
    const project = join(root, "project");
    const elsewhere = join(root, "elsewhere");
    const away = join(root, "away");
    mkdirSync(project);
    mkdirSync(elsewhere);
    path = join(project, "session.jsonl");
    writeFileSync(path, JSON.stringify({ type: "session", id: "cmd-settle", version: 3 }) + "\n" + message("u1", null, "hello"));
    writeFileSync(join(elsewhere, "session.jsonl"), JSON.stringify({ type: "session", id: "cmd-foreign", version: 3 }) + "\n" + message("f1", null, "another agent's secret"));
    const foreign = fs.statSync(join(elsewhere, "session.jsonl")).ino;
    restores.push(spyOn(cmd, "cmdTranscriptPath").mockResolvedValue({ path }));
    const base = await paneConversation(pane.pane_id);
    // the first call off the event loop for the path after the pane's transcript was authorized swaps
    // the folder for another agent's; the page read's own stat puts it back
    let swapped = false;
    let swaps = 0;
    const swap = () => {
      if (swaps++ > 0) return;
      renameSync(project, away);
      renameSync(elsewhere, project);
      swapped = true;
    };
    const read: number[] = [];
    const { lstat, open } = fsp;
    const { statSync } = fs;
    restores.push(
      spyOn(fsp, "lstat").mockImplementation((async (...args: Parameters<typeof fsp.lstat>) => {
        if (args[0] === path) swap();
        return lstat(...args);
      }) as typeof fsp.lstat),
      spyOn(fsp, "open").mockImplementation((async (...args: Parameters<typeof fsp.open>) => {
        if (args[0] === path) swap();
        const handle = await open(...args);
        if (args[0] !== path) return handle;
        const { ino } = await handle.stat();
        const reading = handle.read.bind(handle);
        handle.read = ((...rest: Parameters<typeof reading>) => { read.push(ino); return reading(...rest); }) as typeof handle.read;
        return handle;
      }) as typeof fsp.open),
      spyOn(fs, "statSync").mockImplementation(((...args: Parameters<typeof fs.statSync>) => {
        if (swapped && args[0] === path) {
          swapped = false;
          renameSync(project, elsewhere);
          renameSync(away, project);
        }
        return statSync(...args);
      }) as typeof fs.statSync),
    );
    const answer = await paneConversation(pane.pane_id);
    expect(swaps).toBeGreaterThan(0);
    expect(read).not.toContain(foreign);
    expect(answer.history_id).toBe(base.history_id);
    expect(JSON.stringify(answer.turns)).not.toContain("secret");
  });

  it("answers nothing from another agent's transcript that a folder swap puts at the path between the settle and the page read", async () => {
    const project = join(root, "project");
    const elsewhere = join(root, "elsewhere");
    mkdirSync(project);
    mkdirSync(elsewhere);
    path = join(project, "session.jsonl");
    writeFileSync(path, JSON.stringify({ type: "session", id: "cmd-settle", version: 3 }) + "\n" + message("u1", null, "hello"));
    writeFileSync(join(elsewhere, "session.jsonl"), JSON.stringify({ type: "session", id: "cmd-foreign", version: 3 }) + "\n" + message("f1", null, "another agent's secret"));
    restores.push(spyOn(cmd, "cmdTranscriptPath").mockResolvedValue({ path }));
    await paneConversation(pane.pane_id);
    // the settle closes its handle on the pane's transcript, then the folder is swapped for another agent's
    let swaps = 0;
    const { open } = fsp;
    restores.push(spyOn(fsp, "open").mockImplementation((async (...args: Parameters<typeof fsp.open>) => {
      const handle = await open(...args);
      if (args[0] !== path) return handle;
      const close = handle.close.bind(handle);
      handle.close = (async () => {
        await close();
        if (swaps++ > 0) return;
        renameSync(project, join(root, "away"));
        renameSync(elsewhere, project);
      }) as typeof handle.close;
      return handle;
    }) as typeof fsp.open));
    await expect(paneConversation(pane.pane_id)).rejects.toBeInstanceOf(ConversationReadPending);
    expect(swaps).toBe(1);
  });

  it("answers nothing from another agent's transcript that a folder swap puts at the path only while the page read opens it", async () => {
    const project = join(root, "project");
    const elsewhere = join(root, "elsewhere");
    const away = join(root, "away");
    mkdirSync(project);
    mkdirSync(elsewhere);
    path = join(project, "session.jsonl");
    // the same shape and length, so the foreign bytes fill the pane's own offsets
    writeFileSync(path, JSON.stringify({ type: "session", id: "cmd-ownses", version: 3 }) + "\n" + message("u1", null, "the pane's own words"));
    writeFileSync(join(elsewhere, "session.jsonl"), JSON.stringify({ type: "session", id: "cmd-foreig", version: 3 }) + "\n" + message("u1", null, "PI FOREIGN SECRET..."));
    restores.push(spyOn(cmd, "cmdTranscriptPath").mockResolvedValue({ path }));
    // no page of it is cached: every synchronous open of the path is made with the other agent's folder swapped in, put back
    // right after: the identity checks around the page read see only the pane's own
    let swaps = 0;
    const { openSync } = fs;
    restores.push(spyOn(fs, "openSync").mockImplementation(((...args: Parameters<typeof fs.openSync>) => {
      if (args[0] !== path) return openSync(...args);
      swaps++;
      renameSync(project, away);
      renameSync(elsewhere, project);
      try { return openSync(...args); }
      finally {
        renameSync(project, elsewhere);
        renameSync(away, project);
      }
    }) as typeof fs.openSync));
    const answer: unknown = await paneConversation(pane.pane_id).catch((error: unknown) => error);
    expect(swaps).toBeGreaterThan(0);
    expect(JSON.stringify(answer)).not.toContain("FOREIGN");
    expect(answer).toBeInstanceOf(ConversationReadPending);
  });

  /** Another agent's folder beside the pane's, put in place of the pane's around each open of `path` that `swapping` picks. */
  const swapOpens = (swapping: (open: number) => boolean) => {
    const project = join(root, "project");
    const elsewhere = join(root, "elsewhere");
    const away = join(root, "away");
    const counts = { opens: 0, swaps: 0 };
    const { openSync } = fs;
    restores.push(spyOn(fs, "openSync").mockImplementation(((...args: Parameters<typeof fs.openSync>) => {
      if (args[0] !== path || !swapping(counts.opens++)) return openSync(...args);
      counts.swaps++;
      renameSync(project, away);
      renameSync(elsewhere, project);
      try { return openSync(...args); }
      finally {
        renameSync(project, elsewhere);
        renameSync(away, project);
      }
    }) as typeof fs.openSync));
    return counts;
  };
  const folders = (own: string, foreign: string) => {
    mkdirSync(join(root, "project"));
    mkdirSync(join(root, "elsewhere"));
    path = join(root, "project", "session.jsonl");
    writeFileSync(path, own);
    writeFileSync(join(root, "elsewhere", "session.jsonl"), foreign);
    restores.push(spyOn(cmd, "cmdTranscriptPath").mockResolvedValue({ path }));
  };

  it("answers nothing from another agent's branch index that a folder swap puts at the path for an open after the verified one", async () => {
    // the other agent's live path carries pi's summary of a branch; the pane's own file is the longer one
    folders(
      JSON.stringify({ type: "session", id: "cmd-ownses", version: 3 }) + "\n" + message("u1", null, "own words ".repeat(30)),
      JSON.stringify({ type: "session", id: "cmd-foreig", version: 3 }) + "\n"
        + JSON.stringify({ type: "branch_summary", id: "s1", parentId: null, summary: "PI FOREIGN SECRET" }) + "\n" + message("u2", "s1", "hi"),
    );
    // the page's first open of the path is the verified one; every later open meets the other folder
    const counts = swapOpens((open) => open > 0);
    const answer: unknown = await paneConversation(pane.pane_id).catch((error: unknown) => error);
    expect(counts.swaps).toBeGreaterThan(0);
    expect(JSON.stringify(answer)).not.toContain("FOREIGN");
    expect(answer).toBeInstanceOf(ConversationReadPending);
  });

  it.skipIf(process.platform !== "linux")("is pending, never waits, where a folder swap puts a FIFO at the path for an open after the verified one", async () => {
    folders(JSON.stringify({ type: "session", id: "cmd-ownses", version: 3 }) + "\n" + message("u1", null, "own words"), "");
    // the other folder holds a FIFO no one writes: a blocking open of it never returns
    rmSync(join(root, "elsewhere", "session.jsonl"));
    execFileSync("mkfifo", [join(root, "elsewhere", "session.jsonl")]);
    const counts = swapOpens((open) => open > 0);
    await expect(paneConversation(pane.pane_id)).rejects.toBeInstanceOf(ConversationReadPending);
    expect(counts.swaps).toBeGreaterThan(0);
  });

  it("answers no tool output from another agent's transcript that a folder swap puts at the path around the lookup's opens", async () => {
    const result = (id: string, text: string) => JSON.stringify({ type: "session", id, version: 3 }) + "\n"
      + JSON.stringify({ type: "message", id: "a1", parentId: null, message: { role: "toolResult", toolCallId: "call_1", content: [{ type: "text", text }] } }) + "\n";
    folders(result("cmd-ownses", "the pane's own output"), result("cmd-foreig", "PI FOREIGN SECRET...."));
    expect(await toolOutput(pane.pane_id, "call_1")).toBe("the pane's own output");
    const counts = swapOpens(() => true);
    expect(await toolOutput(pane.pane_id, "call_1")).toBeNull();
    expect(counts.swaps).toBeGreaterThan(0);
  });

  it("answers a pending read, not the new file, when the agent replaces its transcript by atomic rename between the settle and the page read", async () => {
    const project = join(root, "project");
    mkdirSync(project);
    path = join(project, "session.jsonl");
    writeFileSync(path, JSON.stringify({ type: "session", id: "cmd-settle", version: 3 }) + "\n" + message("u1", null, "hello"));
    restores.push(spyOn(cmd, "cmdTranscriptPath").mockResolvedValue({ path }));
    await paneConversation(pane.pane_id);
    // the settle closes its handle on the transcript, then the agent writes it anew beside it and renames it over
    let renames = 0;
    const { open } = fsp;
    restores.push(spyOn(fsp, "open").mockImplementation((async (...args: Parameters<typeof fsp.open>) => {
      const handle = await open(...args);
      if (args[0] !== path) return handle;
      const close = handle.close.bind(handle);
      handle.close = (async () => {
        await close();
        if (renames++ > 0) return;
        const next = join(project, "session.jsonl.tmp");
        writeFileSync(next, JSON.stringify({ type: "session", id: "cmd-settle", version: 3 }) + "\n" + message("u1", null, "hello") + message("u2", "u1", "rewritten"));
        renameSync(next, path);
      }) as typeof handle.close;
      return handle;
    }) as typeof fsp.open));
    await expect(paneConversation(pane.pane_id)).rejects.toBeInstanceOf(ConversationReadPending);
    expect(renames).toBe(1);
  });

  it("never answers another session's transcript renamed over the pane's own in its folder between the settle and the page read", async () => {
    const project = join(root, "project");
    mkdirSync(project);
    path = join(project, "session.jsonl");
    const foreign = join(project, "other-session.jsonl");
    writeFileSync(path, JSON.stringify({ type: "session", id: "cmd-settle", version: 3 }) + "\n" + message("u1", null, "hello"));
    writeFileSync(foreign, JSON.stringify({ type: "session", id: "cmd-foreign", version: 3 }) + "\n" + message("f1", null, "another session's secret"));
    restores.push(spyOn(cmd, "cmdTranscriptPath").mockResolvedValue({ path }));
    await paneConversation(pane.pane_id);
    // the settle closes its handle on the pane's transcript, then another session's file is renamed over it
    let renames = 0;
    const { open } = fsp;
    restores.push(spyOn(fsp, "open").mockImplementation((async (...args: Parameters<typeof fsp.open>) => {
      const handle = await open(...args);
      if (args[0] !== path) return handle;
      const close = handle.close.bind(handle);
      handle.close = (async () => {
        await close();
        if (renames++ > 0) return;
        renameSync(foreign, path);
      }) as typeof handle.close;
      return handle;
    }) as typeof fsp.open));
    await expect(paneConversation(pane.pane_id)).rejects.toBeInstanceOf(ConversationReadPending);
    expect(renames).toBe(1);
  });

  it("settles again off the event loop a transcript touched between its settle and its page read", async () => {
    const base = await paneConversation(pane.pane_id);
    const { open } = fsp;
    const { statSync } = fs;
    const order: string[] = [];
    let touched = false;
    let fired!: () => void;
    const timer = new Promise<void>((resolve) => { fired = resolve; });
    restores.push(
      // the page read's stat of the transcript: touched just before it is taken, with a timer due at once
      spyOn(fs, "statSync").mockImplementation(((...args: Parameters<typeof fs.statSync>) => {
        if (!touched && args[0] === path) {
          touched = true;
          utimesSync(path, new Date(), new Date(Date.now() + 1000));
          setTimeout(() => { order.push("timer"); fired(); }, 0);
        }
        return statSync(...args);
      }) as typeof fs.statSync),
      // an open of it off the event loop after the touch goes on once that timer ran
      spyOn(fsp, "open").mockImplementation((async (...args: Parameters<typeof fsp.open>) => {
        if (touched && args[0] === path) await timer;
        return open(...args);
      }) as typeof fsp.open),
    );
    const answer = await paneConversation(pane.pane_id);
    order.push("answered");
    expect(order).toEqual(["timer", "answered"]);
    // a touch alone: the same history
    expect(answer.history_id).toBe(base.history_id);
  });

  it("answers no tool output for an OmO pane closed while its transcript settled", async () => {
    const omoPane = { pane_id: "omo-settle", agent: "pi", agent_status: "idle", cwd: root } as HerdrPane;
    const whole = "x".repeat(9_000);
    writeFileSync(path, JSON.stringify({ type: "message", message: { role: "toolResult", toolCallId: "call_1", content: [{ type: "text", text: whole }] } }) + "\n");
    restores.push(
      spyOn(herdr, "sessionSnapshot").mockResolvedValue({ panes: [omoPane], agents: [omoPane] } as unknown as SessionSnapshot),
      spyOn(herdr, "herdrRpc").mockResolvedValue({ process_info: { foreground_processes: [{ argv: ["node", "/home/u/.nvm/versions/node/v24.18.0/bin/omo"] }] } } as never),
      spyOn(omo, "omoSessionForPane").mockResolvedValue({ path, pending: null }),
    );
    expect(await toolOutput(omoPane.pane_id, "call_1")).toBe(whole);
    const stat = holdFirstStat();
    const output = toolOutput(omoPane.pane_id, "call_1");
    await stat.holding;
    forgetPaneTranscriptState(omoPane.pane_id);
    stat.release();
    expect(await output).toBeNull();
  });

  it("answers no tool output for an OmO pane seen bound to another session while its transcript settled", async () => {
    const omoPane = { pane_id: "omo-rebound", agent: "pi", agent_status: "idle", cwd: root } as HerdrPane;
    const other = join(root, "other.jsonl");
    writeFileSync(path, JSON.stringify({ type: "message", message: { role: "toolResult", toolCallId: "call_1", content: [{ type: "text", text: "old session" }] } }) + "\n");
    writeFileSync(other, JSON.stringify({ type: "message", message: { role: "toolResult", toolCallId: "call_2", content: [{ type: "text", text: "new session" }] } }) + "\n");
    restores.push(
      spyOn(herdr, "sessionSnapshot").mockResolvedValue({ panes: [omoPane], agents: [omoPane] } as unknown as SessionSnapshot),
      spyOn(herdr, "herdrRpc").mockResolvedValue({ process_info: { foreground_processes: [{ argv: ["node", "/home/u/.nvm/versions/node/v24.18.0/bin/omo"] }] } } as never),
      spyOn(omo, "omoSessionForPane").mockResolvedValue({ path, pending: null }),
    );
    expect(await toolOutput(omoPane.pane_id, "call_1")).toBe("old session");
    const stat = holdFirstStat();
    const output = toolOutput(omoPane.pane_id, "call_1");
    await stat.holding;
    // OmO started another session in the pane, and another look at the pane saw it
    restores.push(spyOn(omo, "omoSessionForPane").mockResolvedValue({ path: other, pending: null }));
    expect((await paneTranscript(omoPane.pane_id)).path).toBe(other);
    stat.release();
    expect(await output).toBeNull();
  });

  it("answers no tool output for an OmO pane rebound while its transcript settled, though nothing in Ovis looked at the pane meanwhile", async () => {
    const omoPane = { pane_id: "omo-unseen", agent: "pi", agent_status: "idle", cwd: root } as HerdrPane;
    const other = join(root, "other.jsonl");
    writeFileSync(path, JSON.stringify({ type: "message", message: { role: "toolResult", toolCallId: "call_1", content: [{ type: "text", text: "old session" }] } }) + "\n");
    writeFileSync(other, JSON.stringify({ type: "message", message: { role: "toolResult", toolCallId: "call_2", content: [{ type: "text", text: "new session" }] } }) + "\n");
    restores.push(
      spyOn(herdr, "sessionSnapshot").mockResolvedValue({ panes: [omoPane], agents: [omoPane] } as unknown as SessionSnapshot),
      spyOn(herdr, "herdrRpc").mockResolvedValue({ process_info: { foreground_processes: [{ argv: ["node", "/home/u/.nvm/versions/node/v24.18.0/bin/omo"] }] } } as never),
      spyOn(omo, "omoSessionForPane").mockResolvedValue({ path, pending: null }),
    );
    expect(await toolOutput(omoPane.pane_id, "call_1")).toBe("old session");
    const stat = holdFirstStat();
    const output = toolOutput(omoPane.pane_id, "call_1");
    await stat.holding;
    // OmO started another session in the pane, which no read resolves before this one settles
    restores.push(spyOn(omo, "omoSessionForPane").mockResolvedValue({ path: other, pending: null }));
    stat.release();
    expect(await output).toBeNull();
  });

  it("answers no tool output, not an error, for an OmO transcript replaced by rename while it settled", async () => {
    const omoPane = { pane_id: "omo-replaced", agent: "pi", agent_status: "idle", cwd: root } as HerdrPane;
    writeFileSync(path, JSON.stringify({ type: "message", message: { role: "toolResult", toolCallId: "call_1", content: [{ type: "text", text: "old file" }] } }) + "\n");
    restores.push(
      spyOn(herdr, "sessionSnapshot").mockResolvedValue({ panes: [omoPane], agents: [omoPane] } as unknown as SessionSnapshot),
      spyOn(herdr, "herdrRpc").mockResolvedValue({ process_info: { foreground_processes: [{ argv: ["node", "/home/u/.nvm/versions/node/v24.18.0/bin/omo"] }] } } as never),
      spyOn(omo, "omoSessionForPane").mockResolvedValue({ path, pending: null }),
    );
    expect(await toolOutput(omoPane.pane_id, "call_1")).toBe("old file");
    const stat = holdFirstStat();
    const output = toolOutput(omoPane.pane_id, "call_1");
    await stat.holding;
    writeFileSync(`${path}.next`, JSON.stringify({ type: "message", message: { role: "toolResult", toolCallId: "call_1", content: [{ type: "text", text: "new file" }] } }) + "\n");
    renameSync(`${path}.next`, path);
    stat.release();
    expect(await output).toBeNull();
  });

  it("answers nothing from a herdr session left while its transcript settled", async () => {
    const stat = holdFirstStat();
    const read = paneConversation(pane.pane_id);
    await stat.holding;
    restores.push(spyOn(herdr, "herdrSocketPath").mockReturnValue(join(root, "other-session.sock")));
    stat.release();
    await expect(read).rejects.toMatchObject({ name: "ConversationUnavailable", message: "no_session_id" });
  });

  it.skipIf(!linksRefused)("never opens a transcript reached through a link off the event loop", async () => {
    const target = join(root, "target.jsonl");
    fs.renameSync(path, target);
    symlinkSync(target, path);
    const realOpen = fsp.open;
    const opened: unknown[] = [];
    restores.push(spyOn(fsp, "open").mockImplementation((async (...args: Parameters<typeof fsp.open>) => { opened.push(args[0]); return realOpen(...args); }) as typeof fsp.open));
    const base = (await paneConversation(pane.pane_id)).history_id;
    utimesSync(target, new Date(), new Date(Date.now() + 1000));
    // its digest is never read, so a touch counts as a rewrite
    expect((await paneConversation(pane.pane_id)).history_id).not.toBe(base);
    expect(opened).not.toContain(path);
  });

  it.skipIf(!linksRefused)("settles a transcript reached through a link once per read, not once per settle it may take", async () => {
    // each settle pass checks the path still names the authorized file, before and after its page read
    const { statSync } = fs;
    let checks = 0;
    restores.push(spyOn(fs, "statSync").mockImplementation(((...args: Parameters<typeof fs.statSync>) => {
      if (args[0] === path && new Error().stack?.includes("stillAuthorized")) checks++;
      return statSync(...args);
    }) as typeof fs.statSync));
    const target = join(root, "target.jsonl");
    fs.renameSync(path, target);
    symlinkSync(target, path);
    const linked = await paneConversation(pane.pane_id);
    // a touch: a revision check a settle would be asked for
    utimesSync(target, new Date(), new Date(Date.now() + 1000));
    checks = 0;
    const touched = await paneConversation(pane.pane_id);
    expect(checks).toBe(2);
    // its digest is never read, so the touch is another history
    expect(touched.history_id).not.toBe(linked.history_id);
  });

  it.skipIf(!linksRefused)("never answers a linked transcript's old history once it is rewritten in place and grown", async () => {
    const target = join(root, "target.jsonl");
    fs.renameSync(path, target);
    symlinkSync(target, path);
    const base = await paneConversation(pane.pane_id);
    // the same inode, its first bytes changed, and longer than before
    writeFileSync(target, JSON.stringify({ type: "session", id: "cmd-settle", version: 3 }) + "\n" + message("u1", null, "HELLO, rewritten"));
    expect((await paneConversation(pane.pane_id)).history_id).not.toBe(base.history_id);
  });

  it.skipIf(!linksRefused)("answers a transcript replaced by a link to itself and appended to, under another history", async () => {
    const base = await paneConversation(pane.pane_id);
    const target = join(root, "target.jsonl");
    fs.renameSync(path, target);
    symlinkSync(target, path);
    appendFileSync(target, message("u2", "u1", "again"));
    const answer = await paneConversation(pane.pane_id);
    expect(answer.history_id).not.toBe(base.history_id);
    expect((await paneConversation(pane.pane_id)).history_id).toBe(answer.history_id);
  });
});

it("lets the event loop run while a page read digests a touched transcript", async () => {
  const root = mkdtempSync(join(tmpdir(), "herdr-touch-async-"));
  const path = join(root, "session.jsonl");
  writeFileSync(path, [
    { type: "session", id: "cmd-session", version: 3 },
    { type: "message", id: "u1", parentId: null, message: { role: "user", content: "hello" } },
  ].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
  const pane = { pane_id: "cmd-touch", agent: "cmd", agent_status: "idle", cwd: root } as HerdrPane;
  const resolution = spyOn(cmd, "cmdTranscriptPath").mockResolvedValue({ path });
  const snapshot = spyOn(herdr, "sessionSnapshot").mockResolvedValue({ panes: [pane], agents: [pane] } as unknown as SessionSnapshot);
  const rpc = spyOn(herdr, "herdrRpc").mockResolvedValue({ process_info: { foreground_processes: [] } } as never);
  const realOpen = fsp.open;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let held!: () => void;
  const holding = new Promise<string>((resolve) => { held = () => resolve("held"); });
  let opens: { mockRestore(): void } | undefined;
  try {
    const base = (await paneConversation(pane.pane_id)).history_id;
    utimesSync(path, new Date(), new Date(Date.now() + 1000));
    // the digest's read of the touched transcript waits until the test lets it go
    opens = spyOn(fsp, "open").mockImplementation((async (...args: Parameters<typeof fsp.open>) => {
      if (args[0] === path) { held(); await gate; }
      return realOpen(...args);
    }) as typeof fsp.open);
    let settled = false;
    const pending = paneConversation(pane.pane_id).finally(() => { settled = true; });
    expect(await Promise.race([holding, pending.then(() => "answered", () => "failed")])).toBe("held");
    // a timer scheduled now runs while that read is outstanding: the loop is not held by it
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(settled).toBe(false);
    release();
    expect((await pending).history_id).toBe(base);
  } finally {
    release();
    opens?.mockRestore(); rpc.mockRestore(); snapshot.mockRestore(); resolution.mockRestore();
    forgetTranscriptState(); rmSync(root, { recursive: true, force: true });
  }
});

it("expands inherited Codex tool output without exposing output discarded by a backtrack", () => {
  const home = mkdtempSync(join(tmpdir(), "herdr-tool-history-"));
  try {
    const directory = join(home, "sessions", "2026", "09", "30");
    mkdirSync(directory, { recursive: true });
    const thread = "11111111-1111-4111-8111-111111111111";
    const parent = join(directory, `rollout-2026-09-30T01-00-00-${thread}.jsonl`);
    const leaf = join(directory, `rollout-2026-09-30T01-00-01-${thread}_1.jsonl`);
    const line = (type: string, payload: unknown) => JSON.stringify({ type, payload }) + "\n";
    const meta = (extra = {}) => line("session_meta", { id: thread, source: "cli", thread_source: "user", ...extra });
    const long = "inherited output ".repeat(1000);
    const kept = meta()
      + line("event_msg", { type: "user_message", message: "earlier request" })
      + line("response_item", { type: "function_call", name: "exec_command", call_id: "kept", arguments: "{}" })
      + line("response_item", { type: "function_call_output", call_id: "kept", output: long });
    writeFileSync(parent, kept + line("response_item", { type: "function_call_output", call_id: "discarded", output: "discarded output" }));
    writeFileSync(leaf, meta({ history_base: { thread_id: thread, end_ordinal_exclusive: 4, end_byte_offset: Buffer.byteLength(kept) } })
      + line("response_item", { type: "function_call_output", call_id: "current", output: "current output" }));
    const page = transcriptPage("codex-transcript", leaf, {}, home);
    expect(page.turns.flatMap((turn) => turn.parts).some((part) => part.kind === "tool" && part.output_ref === "kept")).toBe(true);
    expect(transcriptToolOutput("codex-transcript", leaf, "kept", home)).toBe(long);
    expect(transcriptToolOutput("codex-transcript", leaf, "current", home)).toBe("current output");
    expect(transcriptToolOutput("codex-transcript", leaf, "discarded", home)).toBeNull();
    // an inherited rollout that can no longer be read costs its own output, not the leaf's
    // (a directory in its place fails to read even for root, unlike a mode change)
    rmSync(parent);
    mkdirSync(parent);
    expect(transcriptToolOutput("codex-transcript", leaf, "current", home)).toBe("current output");
  } finally { rmSync(home, { recursive: true, force: true }); }
});

describe("Agy native ledger through shared paging", () => {
  let root: string, path: string, db: Database;
  const row = (step_index: number, type: string, content = "", extra = {}) => JSON.stringify({ step_index, type, status: "DONE", created_at: "2026-01-01T00:00:00Z", content, ...extra }) + "\n";
  const add = (index: number, type: string, content = "", extra = {}) => {
    db.query("INSERT OR REPLACE INTO steps VALUES (?)").run(index);
    appendFileSync(path, row(index, type, content, extra));
  };
  const page = () => agyTranscriptPage(path);
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "herdr-agy-unit-"));
    const session = "00000000-0000-4000-8000-000000000001";
    path = join(root, "brain", session, ".system_generated", "logs", "transcript_full.jsonl");
    mkdirSync(join(path, ".."), { recursive: true });
    mkdirSync(join(root, "conversations"));
    db = new Database(join(root, "conversations", `${session}.db`));
    // The ledger tests observe committed DB changes, never recovery after a crash.
    db.exec("PRAGMA synchronous = OFF");
    db.exec("CREATE TABLE steps(idx INTEGER PRIMARY KEY)");
    writeFileSync(path, "");
    forgetTranscriptState();
  });
  afterEach(() => { db.close(); forgetTranscriptState(); rmSync(root, { recursive: true, force: true }); });
  it("tracks native turn boundaries without treating each DONE tool step as completion", async () => {
    expect((await page()).activity).toBe("idle");
    // Agy 1.3.3's captured native sequence: user, context, planner call, result,
    // context, another call/result, then the tool-free final planner answer.
    add(0, "USER_INPUT", "fictional request");
    add(1, "EPHEMERAL_MESSAGE", "hidden context");
    expect((await page()).activity).toBe("working");
    add(2, "PLANNER_RESPONSE", "", { thinking: "saved reasoning", tool_calls: [{ name: "run_command", args: { CommandLine: "echo fiction" } }] });
    add(3, "GENERIC", "fictional output");
    add(4, "EPHEMERAL_MESSAGE", "hidden context");
    expect((await page()).activity).toBe("working");
    expect(JSON.stringify((await page()).turns)).not.toContain("saved reasoning");
    add(5, "PLANNER_RESPONSE", "More work", { tool_calls: [{ name: "view_file", args: { AbsolutePath: "/fiction.txt" } }] });
    add(6, "GENERIC", "another output");
    expect((await page()).activity).toBe("working");
    add(7, "PLANNER_RESPONSE", "Finished", { tool_calls: [] });
    expect((await page()).activity).toBe("idle");
    add(8, "GENERIC", "late result");
    add(9, "EPHEMERAL_MESSAGE", "late context");
    expect((await page()).activity).toBe("idle");
    add(10, "USER_INPUT", "next turn");
    expect((await page()).activity).toBe("working");
    // Rewind the new prompt; completion of the retained turn still clears activity.
    db.exec("DELETE FROM steps WHERE idx >= 10");
    expect((await page()).activity).toBe("idle");
    forgetTranscriptState();
    expect((await page()).activity).toBe("idle");
  });
  it("does not complete activity from a partial, unadmitted or unfinished planner answer", async () => {
    add(0, "USER_INPUT", "one");
    add(1, "PLANNER_RESPONSE", "", { thinking: "saved reasoning" });
    expect((await page()).activity).toBe("working");
    add(2, "PLANNER_RESPONSE", "unfinished", { status: "RUNNING" });
    expect((await page()).activity).toBe("working");
    db.exec("INSERT INTO steps VALUES (3)");
    const final = row(3, "PLANNER_RESPONSE", "complete");
    appendFileSync(path, final.slice(0, -2));
    expect((await page()).activity).toBe("working");
    appendFileSync(path, final.slice(-2));
    expect((await page()).activity).toBe("idle");
    appendFileSync(path, row(4, "USER_INPUT", "export ahead of DB"));
    expect((await page()).activity).toBe("idle");
    db.exec("INSERT INTO steps VALUES (4)");
    expect((await page()).activity).toBe("working");
    forgetTranscriptState();
    expect((await page()).activity).toBe("working");
  });
  it("renders native messages, multiple planner calls and independent results without guessed pairing", async () => {
    add(0, "USER_INPUT", "<USER_REQUEST>Keep <USER_REQUEST>literal</USER_REQUEST> tags</USER_REQUEST>\n<ADDITIONAL_METADATA>hidden</ADDITIONAL_METADATA>");
    add(1, "EPHEMERAL_MESSAGE", "hidden context");
    add(2, "PLANNER_RESPONSE", "Checking", { tool_calls: [{ name: "run_command", args: { CommandLine: "echo fiction" } }, { name: "view_file", args: { AbsolutePath: "/fiction.txt" } }] });
    add(3, "GENERIC", "independent output");
    add(4, "CHECKPOINT", "not a result");
    add(5, "USER_INPUT", "next");
    const turns = (await page()).turns;
    expect(turns[0]!.parts).toEqual([{ kind: "text", text: "Keep <USER_REQUEST>literal</USER_REQUEST> tags" }]);
    expect(turns[1]!.parts.map((p) => p.kind === "tool" ? [p.name, p.summary, p.output] : p.kind === "text" ? p.text : p.kind)).toEqual([
      "Checking", ["run_command", "echo fiction", ""], ["view_file", "/fiction.txt", ""], ["Tool output", "Step 3", "independent output"],
    ]);
    expect(turns[2]!.role).toBe("user");
  });
  it("keeps paging and refs stable on append, then rejects them on a DB-only idle rewind", async () => {
    // One prompt beyond the 50-prompt page boundary, committed as one fixture batch.
    db.transaction(() => { for (let i = 0; i < 51; i++) { add(i * 2, "USER_INPUT", `prompt ${i}`); add(i * 2 + 1, "GENERIC", "x".repeat(5000)); } })();
    const first = (await page());
    expect(first.cursor).not.toBeNull();
    const older = await agyTranscriptPage(path, { before: first.cursor! });
    const tool = first.turns.flatMap((t) => t.parts).find((p) => p.kind === "tool")!;
    if (tool.kind !== "tool") throw new Error("missing result");
    expect(await agyToolOutput(path, tool.output_ref!)).toBe("x".repeat(5000));
    add(102, "USER_INPUT", "append");
    expect((await page()).history_id).toBe(first.history_id);
    expect(await agyTranscriptPage(path, { before: first.cursor! })).toEqual(older);
    db.exec("DELETE FROM steps WHERE idx >= 4");
    const rewound = (await page());
    expect(rewound.turns).toHaveLength(4);
    expect(rewound.history_id).not.toBe(first.history_id);
    expect(await agyTranscriptPage(path, { before: first.cursor! }).catch((error: unknown) => error)).toBeInstanceOf(HistoryChanged);
    expect(await agyToolOutput(path, tool.output_ref!)).toBeNull();
    forgetTranscriptState();
    expect((await page()).turns).toEqual(rewound.turns.map((turn) => ({ ...turn, parts: turn.parts.map((part) => part.kind === "tool" ? { ...part, output_ref: expect.any(String) } : part) })));
  });
  it("replays repeated/backward indices and allows database-only rows", async () => {
    add(0, "USER_INPUT", "one"); add(1, "PLANNER_RESPONSE", "old");
    db.query("INSERT INTO steps VALUES (?)").run(2);
    add(3, "USER_INPUT", "two"); add(4, "PLANNER_RESPONSE", "discard");
    const before = (await page());
    add(3, "USER_INPUT", "replacement");
    expect((await page()).turns.map((t) => t.parts[0])).toEqual([{ kind: "text", text: "one" }, { kind: "text", text: "old" }, { kind: "text", text: "replacement" }]);
    const revision = (await page()).history_id;
    expect(revision).not.toBe(before.history_id);
    add(4, "PLANNER_RESPONSE", "new");
    expect((await page()).history_id).toBe(revision);
    add(3, "USER_INPUT", "equal repeat");
    expect((await page()).history_id).not.toBe(revision);
    const warm = (await page()).turns;
    forgetTranscriptState();
    expect((await page()).turns).toEqual(warm);
  });
  it("ignores an incomplete tail and does not settle a running row", async () => {
    add(0, "USER_INPUT", "one");
    db.query("INSERT INTO steps VALUES (1)").run();
    const text = row(1, "PLANNER_RESPONSE", "complete");
    appendFileSync(path, text.slice(0, -3));
    expect((await page()).turns).toHaveLength(1);
    appendFileSync(path, text.slice(-3));
    expect((await page()).turns).toHaveLength(2);
    add(2, "PLANNER_RESPONSE", "unfinished", { status: "RUNNING" });
    expect(JSON.stringify((await page()).turns)).not.toContain("unfinished");
    add(2, "PLANNER_RESPONSE", "finished");
    expect(JSON.stringify((await page()).turns)).toContain("finished");
  });
  it("admits a ledger tail when the DB catches up without changing older cursors", async () => {
    add(0, "USER_INPUT", "first");
    const initial = (await page());
    appendFileSync(path, row(1, "PLANNER_RESPONSE", "lagged"));
    expect((await page()).turns).toHaveLength(1);
    db.exec("INSERT INTO steps VALUES (1)");
    const caughtUp = (await page());
    expect(caughtUp.history_id).toBe(initial.history_id);
    expect(caughtUp.turns).toHaveLength(2);
    add(2, "PLANNER_RESPONSE", "partial", { status: "RUNNING" });
    const running = (await page());
    add(2, "PLANNER_RESPONSE", "complete");
    expect((await page()).history_id).toBe(running.history_id);
    expect((await agyTranscriptPage(path, { from: `${initial.history_id}:0` })).turns).toHaveLength(2);
  });
  it("never resurrects an observed rewind when replacement DB indices precede their ledger rows", async () => {
    add(0, "USER_INPUT", "kept"); add(1, "GENERIC", "removed".repeat(1000));
    const before = (await page());
    db.exec("DELETE FROM steps WHERE idx=1");
    const cut = (await page());
    db.exec("INSERT INTO steps VALUES (1)");
    expect((await page()).turns).toEqual(cut.turns);
    expect((await page()).history_id).toBe(cut.history_id);
    add(1, "GENERIC", "replacement");
    expect(JSON.stringify((await page()).turns)).toContain("replacement");
    expect(JSON.stringify((await page()).turns)).not.toContain("removed");
    const part = before.turns[1]!.parts[0]!;
    if (part.kind !== "tool") throw new Error("missing tool");
    expect(await agyToolOutput(path, part.output_ref!)).toBeNull();
  });
  it("does not hide later turns behind an unfinished or unknown-status historical row", async () => {
    add(0, "USER_INPUT", "first");
    add(1, "GENERIC", "unfinished", { status: "UNKNOWN" });
    expect((await page()).turns).toHaveLength(1);
    add(2, "USER_INPUT", "later"); add(3, "PLANNER_RESPONSE", "answer");
    expect((await page()).turns.map(t => t.parts[0])).toEqual([
      { kind: "text", text: "first" }, { kind: "text", text: "later" }, { kind: "text", text: "answer" },
    ]);
  });
  it("uses the same assistant boundaries in full and paged replay around a skipped user row", async () => {
    add(0, "USER_INPUT", "first"); add(1, "PLANNER_RESPONSE", "before");
    add(2, "USER_INPUT", "hidden", { status: "UNKNOWN" });
    add(3, "PLANNER_RESPONSE", "after");
    const full = parseAgyTranscript(row(0, "USER_INPUT", "first") + row(1, "PLANNER_RESPONSE", "before")
      + row(2, "USER_INPUT", "hidden", { status: "UNKNOWN" }) + row(3, "PLANNER_RESPONSE", "after"));
    expect((await page()).turns).toEqual(full);
    expect(full).toHaveLength(2);
  });
  it("continues a bounded cold scan on the next poll", async () => {
    add(0, "USER_INPUT", "start");
    for (let i=1; i<=34; i++) add(i, "EPHEMERAL_MESSAGE", "x".repeat(1024 * 1024));
    add(35, "USER_INPUT", "end");
    expect(await page().catch((error: unknown) => error)).toBeInstanceOf(ConversationUnavailable);
    expect((await page()).turns.at(-1)!.parts[0]).toEqual({ kind: "text", text: "end" });
  });
  it("preserves standalone literal user wrapper text", async () => {
    add(0, "USER_INPUT", "<USER_REQUEST>literal</USER_REQUEST>");
    expect((await page()).turns[0]!.parts[0]).toEqual({ kind: "text", text: "<USER_REQUEST>literal</USER_REQUEST>" });
  });
  it.skipIf(process.platform === "win32")("canonicalizes held locks and never chooses among sessions or unheld files", () => {
    const presence = join(root, "presence"); mkdirSync(presence);
    const one = join(presence, "00000000-0000-4000-8000-000000000001.lock");
    const two = join(presence, "00000000-0000-4000-8000-000000000002.lock");
    writeFileSync(one, ""); writeFileSync(two, "");
    expect(agyStoreFromLocks([])).toBeNull();
    expect(agyStoreFromLocks([one, two])).toBeNull();
    expect(agyStoreFromLocks([one])?.path).toBe(path);
    const alias = join(root, "alias"); symlinkSync(presence, alias);
    // Alias a parent of presence, preserving the native held-path shape.
    const link = join(root, "linked-root"); symlinkSync(root, link);
    expect(agyStoreFromLocks([join(link, "presence", one.split("/").at(-1)!)])?.path).toBe(path);
  });
  /** Runs `during` while the read's `call`th catalog read (1: before the page, 2: after it) is under way. */
  const duringCatalog = (call: number, during: () => void) => {
    let calls = 0;
    return spyOn(filePool, "fileTask").mockImplementation(async (task) => {
      if (task.op !== "agy-catalog") throw new Error(`unexpected ${task.op}`);
      calls += 1;
      if (calls === call) during();
      return [...agyCatalog(task.path)] as never;
    });
  };
  it("keeps output refs when the ledger's state is forgotten while its catalog is read", async () => {
    add(0, "USER_INPUT", "one"); add(1, "GENERIC", "x".repeat(5000));
    const spy = duringCatalog(1, () => forgetTranscriptState());
    try {
      const tool = (await page()).turns.flatMap((turn) => turn.parts).find((part) => part.kind === "tool");
      if (tool?.kind !== "tool") throw new Error("missing tool");
      expect(await agyToolOutput(path, tool.output_ref!)).toBe("x".repeat(5000));
    } finally { spy.mockRestore(); }
  });
  it("passes busy file threads through to both Agy routes, so they answer 503 and not a missing output", async () => {
    add(0, "USER_INPUT", "one"); add(1, "GENERIC", "x".repeat(5000));
    const tool = (await page()).turns.flatMap((turn) => turn.parts).find((part) => part.kind === "tool");
    if (tool?.kind !== "tool") throw new Error("missing tool");
    const spy = spyOn(filePool, "fileTask").mockRejectedValue(new filePool.FileBusyError("every file thread is busy"));
    try {
      expect(await page().catch((error: unknown) => error)).toBeInstanceOf(filePool.FileBusyError);
      expect(await agyToolOutput(path, tool.output_ref!).catch((error: unknown) => error)).toBeInstanceOf(filePool.FileBusyError);
    } finally { spy.mockRestore(); }
  });
  it("rejects a page whose ledger is cut while its catalog is read again", async () => {
    add(0, "USER_INPUT", "one");
    const spy = duringCatalog(2, () => writeFileSync(path, ""));
    try { expect(await page().catch((error: unknown) => error)).toBeInstanceOf(ConversationUnavailable); }
    finally { spy.mockRestore(); }
  });
  it("distinguishes unreadable database from verified empty history", async () => {
    add(0, "USER_INPUT", "one");
    (await page());
    db.exec("DROP TABLE steps");
    expect(await page().catch((error: unknown) => error)).toBeInstanceOf(ConversationUnavailable);
  });
  it("falls back when the transcript path cannot be inspected", async () => {
    const loop = join(root, "loop"); symlinkSync(loop, loop);
    const pane = { pane_id: "agy-pane", cwd: root, agent: "agy" } as HerdrPane;
    const store = spyOn(agyStore, "resolveAgyStore").mockResolvedValue({ root, session: "test", path: loop, pid: 2, started: "test" });
    const rpc = spyOn(herdr, "herdrRpc").mockResolvedValue({ process_info: { foreground_processes: [] } } as never);
    try {
      await expect(paneTranscript(pane.pane_id, undefined, { panes: [pane] } as SessionSnapshot)).rejects.toMatchObject({
        name: "ConversationUnavailable", message: "transcript_missing",
      });
    } finally { store.mockRestore(); rpc.mockRestore(); }
  });
  it("keeps the unwritten greeting while Agy works on its first turn before flushing the JSONL ledger", async () => {
    const session = "00000000-0000-4000-8000-000000000001";
    rmSync(path);
    const pane = { pane_id: "agy-first-turn", cwd: root, agent: "agy", agent_status: "working" } as HerdrPane;
    const snapshot = spyOn(herdr, "sessionSnapshot").mockImplementation(async () => ({ panes: [pane], agents: [] }) as unknown as SessionSnapshot);
    const store = spyOn(agyStore, "resolveAgyStore").mockResolvedValue({ root, session, path, pid: 2, started: "test" });
    const rpc = spyOn(herdr, "herdrRpc").mockResolvedValue({ process_info: { foreground_processes: [] } } as never);
    try {
      // 0 steps in DB, JSONL not created yet while working
      expect(await paneConversation(pane.pane_id)).toMatchObject({ source: "agy-transcript", turns: [], history_id: `unwritten:${session}` });
      // step 0 inserted into DB milliseconds before JSONL is created while working
      db.query("INSERT INTO steps VALUES (0)").run();
      expect(await paneConversation(pane.pane_id)).toMatchObject({ source: "agy-transcript", turns: [], history_id: `unwritten:${session}` });
      // once JSONL is flushed and read, a later disappearance of the file fails closed instead of returning unwritten
      writeFileSync(path, row(0, "USER_INPUT", "first prompt"));
      const written = await paneConversation(pane.pane_id);
      expect(written.turns).toHaveLength(1);
      rmSync(path);
      expect(await paneConversation(pane.pane_id).catch((error: unknown) => error)).toMatchObject({ name: "ConversationUnavailable", message: "transcript_missing" });
      // a cold read with more than 1 step in the DB and no JSONL file also fails closed
      forgetTranscriptState();
      db.query("INSERT INTO steps VALUES (1)").run();
      expect(await paneConversation(pane.pane_id).catch((error: unknown) => error)).toMatchObject({ name: "ConversationUnavailable", message: "transcript_missing" });
      // a resumed conversation whose only cataloged step is a later one is not a first turn
      forgetTranscriptState();
      db.exec("DELETE FROM steps");
      db.query("INSERT INTO steps VALUES (500)").run();
      expect(await paneConversation(pane.pane_id).catch((error: unknown) => error)).toMatchObject({ name: "ConversationUnavailable", message: "transcript_missing" });
    } finally { snapshot.mockRestore(); store.mockRestore(); rpc.mockRestore(); }
  });
  it("retries a transient mid-turn catalog race and answers 503 ConversationReadPending instead of dropping chat", async () => {
    const session = "00000000-0000-4000-8000-000000000001";
    add(0, "USER_INPUT", "one");
    add(1, "PLANNER_RESPONSE", "answer");
    const pane = { pane_id: "agy-race", cwd: root, agent: "agy", agent_status: "working" } as HerdrPane;
    const snapshot = spyOn(herdr, "sessionSnapshot").mockImplementation(async () => ({ panes: [pane], agents: [] }) as unknown as SessionSnapshot);
    const store = spyOn(agyStore, "resolveAgyStore").mockResolvedValue({ root, session, path, pid: 2, started: "test" });
    const rpc = spyOn(herdr, "herdrRpc").mockResolvedValue({ process_info: { foreground_processes: [] } } as never);
    let spy: ReturnType<typeof spyOn> | undefined;
    try {
      const initial = await paneConversation(pane.pane_id);
      expect(initial.turns).toHaveLength(2);
      // A single transient catalog failure recovers immediately via the retry in paneConversation.
      let calls = 0;
      spy = spyOn(filePool, "fileTask").mockImplementation(async (task) => {
        if (task.op !== "agy-catalog") throw new Error(`unexpected ${task.op}`);
        if (++calls === 1) throw new Error("transient WAL copy race");
        return [...agyCatalog(task.path)] as never;
      });
      const recovered = await paneConversation(pane.pane_id, undefined, { history_id: initial.history_id });
      expect(recovered.turns).toHaveLength(2);
      spy.mockRestore();
      // A persistent mid-turn write race returns ConversationReadPending (503) when history_id matches,
      // and HistoryChanged (409) when history_id belongs to another conversation.
      spy = spyOn(filePool, "fileTask").mockRejectedValue(new Error("ongoing WAL write"));
      const catalog = join(root, "conversations", `${session}.db`);
      utimesSync(catalog, new Date(), new Date());
      await expect(paneConversation(pane.pane_id, undefined, { history_id: initial.history_id })).rejects.toBeInstanceOf(ConversationReadPending);
      await expect(paneConversation(pane.pane_id, undefined, { history_id: "other-dev-ino-agy-0" })).rejects.toBeInstanceOf(HistoryChanged);
      await expect(paneConversation(pane.pane_id, undefined, { from: "other-dev-ino-agy-0:0" })).rejects.toBeInstanceOf(HistoryChanged);
      // a catalog that keeps failing while nothing writes it is not a race: the chat falls back
      utimesSync(catalog, new Date(Date.now() - 60_000), new Date(Date.now() - 60_000));
      expect(await paneConversation(pane.pane_id, undefined, { history_id: initial.history_id }).catch((error: unknown) => error)).toMatchObject({ name: "ConversationUnavailable", message: "transcript_missing" });
      // nor is one stamped ahead of the clock
      utimesSync(catalog, new Date(Date.now() + 86_400_000), new Date(Date.now() + 86_400_000));
      expect(await paneConversation(pane.pane_id, undefined, { history_id: initial.history_id }).catch((error: unknown) => error)).toMatchObject({ name: "ConversationUnavailable", message: "transcript_missing" });
      spy.mockRestore();
      spy = undefined;
      rmSync(catalog);
      expect(await paneConversation(pane.pane_id, undefined, { history_id: initial.history_id }).catch((error: unknown) => error)).toMatchObject({ name: "ConversationUnavailable", message: "transcript_missing" });
    } finally { spy?.mockRestore(); snapshot.mockRestore(); store.mockRestore(); rpc.mockRestore(); }
  });
  it("never retries a failed catalog race into a ledger renamed over the one it authorized", async () => {
    const session = "00000000-0000-4000-8000-000000000001";
    add(0, "USER_INPUT", "one");
    add(1, "PLANNER_RESPONSE", "answer");
    const pane = { pane_id: "agy-replaced", cwd: root, agent: "agy", agent_status: "working" } as HerdrPane;
    const snapshot = spyOn(herdr, "sessionSnapshot").mockImplementation(async () => ({ panes: [pane], agents: [] }) as unknown as SessionSnapshot);
    const store = spyOn(agyStore, "resolveAgyStore").mockResolvedValue({ root, session, path, pid: 2, started: "test" });
    const rpc = spyOn(herdr, "herdrRpc").mockResolvedValue({ process_info: { foreground_processes: [] } } as never);
    let spy: ReturnType<typeof spyOn> | undefined;
    try {
      const initial = await paneConversation(pane.pane_id);
      expect(initial.turns).toHaveLength(2);
      // the first read's catalog fails, as in a write race, while another ledger is renamed over the authorized one
      const other = `${path}.other`;
      let calls = 0;
      spy = spyOn(filePool, "fileTask").mockImplementation(async (task) => {
        if (task.op !== "agy-catalog") throw new Error(`unexpected ${task.op}`);
        if (++calls === 1) { renameSync(other, path); throw new Error("transient WAL copy race"); }
        return [...agyCatalog(task.path)] as never;
      });
      utimesSync(join(root, "conversations", `${session}.db`), new Date(), new Date());
      writeFileSync(other, row(0, "USER_INPUT", "OTHER SESSION SECRET") + row(1, "PLANNER_RESPONSE", "OTHER SESSION SECRET"));
      // the retry reads no other file: the history the request named is no longer at the path
      const held = await paneConversation(pane.pane_id, undefined, { history_id: initial.history_id }).catch((error: unknown) => error);
      expect(JSON.stringify(held)).not.toContain("OTHER SESSION SECRET");
      expect(held).toBeInstanceOf(HistoryChanged);
      // and a refresh that names no history is pending, for the next read to authorize afresh
      calls = 0;
      writeFileSync(other, row(0, "USER_INPUT", "THIRD SESSION SECRET") + row(1, "PLANNER_RESPONSE", "THIRD SESSION SECRET"));
      const fresh = await paneConversation(pane.pane_id).catch((error: unknown) => error);
      expect(JSON.stringify(fresh)).not.toContain("THIRD SESSION SECRET");
      expect(fresh).toBeInstanceOf(ConversationReadPending);
    } finally { spy?.mockRestore(); snapshot.mockRestore(); store.mockRestore(); rpc.mockRestore(); }
  });
  it.skipIf(process.platform === "win32")("greets an Agy started in the terminal on its unused start screen", async () => {
    const screen = [
      "❯ agy",
      "",
      "       ▄▀▀▄         Antigravity CLI 1.4.4",
      "      ▀▀▀▀▀▀        user@example.test (Demo plan    )",
      "     ▀▀▀▀▀▀▀▀       Gemini 3.8 Flash (High)",
      "    ▄▀▀     ▀▀▄      /tmp/project",
      "   ▄▀▀       ▀▀▄",
      "",
      " ────────────────────────────────────────",
      " >",
      " ────────────────────────────────────────",
      " ? for shortcuts   Gemini 3.8 Flash · high",
    ].join("\n");
    const pane = { pane_id: "agy-greet", cwd: root, foreground_cwd: root, agent: "agy", agent_status: "idle" } as HerdrPane;
    let currentScreen = screen;
    let argv = ["agy"];
    let scrolledUp = 0;
    const snapshot = spyOn(herdr, "sessionSnapshot").mockImplementation(async () => ({ panes: [pane], agents: [] }) as unknown as SessionSnapshot);
    const rpc = spyOn(herdr, "herdrRpc").mockImplementation(async (method: string) => (method === "pane.get"
      ? { pane: { ...pane, scroll: { offset_from_bottom: scrolledUp, max_offset_from_bottom: 10, viewport_rows: 40 } } }
      : { process_info: { foreground_processes: [{ pid: process.pid, name: "agy", argv }] } }) as never);
    const read = spyOn(herdr, "paneRead").mockImplementation(async () => ({ text: currentScreen }) as never);
    try {
      const greeting = await paneConversation(pane.pane_id);
      expect(greeting).toMatchObject({ source: "agy-transcript", turns: [], cursor: null });
      expect(greeting.history_id).toStartWith(`unwritten:agy:${pane.pane_id}:${process.pid}:`);
      // Resumed or prompt-flag invocations, scrolled viewports, or screens with a turn fall back to scrollback.
      argv = ["agy", "--continue"];
      await expect(paneConversation(pane.pane_id)).rejects.toBeInstanceOf(ConversationUnavailable);
      argv = ["agy"];
      scrolledUp = 2;
      await expect(paneConversation(pane.pane_id)).rejects.toBeInstanceOf(ConversationUnavailable);
      scrolledUp = 0;
      currentScreen = screen.replace(" >", " > hello\n\n ✦ Hi there\n\n ────────────────────────────────────────\n >");
      await expect(paneConversation(pane.pane_id)).rejects.toBeInstanceOf(ConversationUnavailable);
    } finally { snapshot.mockRestore(); rpc.mockRestore(); read.mockRestore(); }
  });
});

describe("a Codex pane that reported no session yet", () => {
  // captured live 2026-10-19, Codex 0.163.0-alpha.10.2 started in a terminal, before any message
  const FRESH = [
    "  >_ OpenAI Codex (v0.163.0-alpha.10.2)",
    "     /tmp/project",
    "",
    "› Ask Codex to do anything",
    "",
    "  GPT-6.1-Sol low · /tmp/project",
    "  ? for shortcuts              ⚠ 3 warnings · f2 to view",
  ].join("\n");

  it("stands in with the terminal, carrying the model Codex's own status line states", async () => {
    const root = mkdtempSync(join(tmpdir(), "herdr-codex-fresh-"));
    const pane = { pane_id: "codex-fresh", cwd: root, foreground_cwd: root, agent: "codex", agent_status: "idle" } as HerdrPane;
    let screen = FRESH;
    let scrolledUp = 0;
    const snapshot = spyOn(herdr, "sessionSnapshot").mockResolvedValue({ panes: [pane] } as SessionSnapshot);
    const rpc = spyOn(herdr, "herdrRpc").mockImplementation(async (method: string) => (method === "agent.get" ? { agent: { agent: "codex" } }
      : method === "pane.get" ? { pane: { ...pane, scroll: { offset_from_bottom: scrolledUp, max_offset_from_bottom: 30, viewport_rows: 40 } } }
      : { process_info: { foreground_processes: [{ argv: ["codex"] }] } }) as never);
    const read = spyOn(herdr, "paneRead").mockImplementation(async () => ({ text: screen }) as never);
    try {
      await expect(paneConversation(pane.pane_id, join(root, ".codex"))).rejects.toMatchObject({
        name: "ConversationUnavailable", screen: { model: "gpt-6.1-sol", reasoning_effort: "low" },
      });
      // switched with /model: the status line says the new one
      screen = FRESH.replace("GPT-6.1-Sol low", "GPT-6-Sol high");
      await expect(paneConversation(pane.pane_id, join(root, ".codex"))).rejects.toMatchObject({ screen: { model: "gpt-6-sol", reasoning_effort: "high" } });
      // scrolled up by a device, the viewport is history, perhaps an older frame: no model is named
      scrolledUp = 3;
      const scrolled = await paneConversation(pane.pane_id, join(root, ".codex")).catch((error: unknown) => error);
      expect(scrolled).toBeInstanceOf(ConversationUnavailable);
      expect((scrolled as ConversationUnavailable).screen).toBeUndefined();
      scrolledUp = 0;
      // a picker hiding the footer leaves the model unknown, whatever its options say
      screen = "  >_ OpenAI Codex (v0.163.0)\n  Select Model and Effort\n› 1. GPT-6.1-Sol (default) (current)\n  GPT-6-Sol high · /tmp/project";
      const picker = await paneConversation(pane.pane_id, join(root, ".codex")).catch((error: unknown) => error);
      expect(picker).toBeInstanceOf(ConversationUnavailable);
      expect((picker as ConversationUnavailable).screen).toBeUndefined();
      // a screen that does not say leaves the scrollback as it was, and so does a page of history
      screen = "$ ";
      const unknown = await paneConversation(pane.pane_id, join(root, ".codex")).catch((error: unknown) => error);
      expect(unknown).toBeInstanceOf(ConversationUnavailable);
      expect((unknown as ConversationUnavailable).screen).toBeUndefined();
      screen = FRESH;
      const page = await paneConversation(pane.pane_id, join(root, ".codex"), { before: "x:0" }).catch((error: unknown) => error);
      expect((page as ConversationUnavailable).screen).toBeUndefined();
    } finally { snapshot.mockRestore(); rpc.mockRestore(); read.mockRestore(); forgetTranscriptState(); rmSync(root, { recursive: true, force: true }); }
  });

  // the process's start time is read from the OS: this test's own process stands in for Codex's
  it.skipIf(process.platform === "win32")("greets a Codex started in the terminal on no conversation, and only that one", async () => {
    const root = mkdtempSync(join(tmpdir(), "herdr-codex-greet-"));
    const home = join(root, ".codex");
    mkdirSync(home);
    const pane = { pane_id: "codex-greet", cwd: root, foreground_cwd: root, agent: "codex", agent_status: "done" } as HerdrPane;
    let screen = FRESH;
    let argv = ["codex"];
    // what a detection read of a short screen also reaches up to (never what decides), and the rows a device scrolled up by
    let above = "";
    let scrolledUp = 0;
    const snapshot = spyOn(herdr, "sessionSnapshot").mockImplementation(async () => ({ panes: [pane] }) as SessionSnapshot);
    const rpc = spyOn(herdr, "herdrRpc").mockImplementation(async (method: string) => (method === "agent.get" ? { agent: { agent: "codex" } }
      : method === "pane.get" ? { pane: { ...pane, scroll: { offset_from_bottom: scrolledUp, max_offset_from_bottom: 30, viewport_rows: 40 } } }
      : { process_info: { foreground_processes: [{ pid: process.pid, argv }] } }) as never);
    const read = spyOn(herdr, "paneRead").mockImplementation(async ({ source }) => ({ text: source === "detection" ? `${above}${screen}` : screen }) as never);
    const ask = () => paneConversation(pane.pane_id, home).catch((error: unknown) => error);
    try {
      // no store yet, as for a CODEX_HOME Codex has not written to
      const greeting = await ask() as Awaited<ReturnType<typeof paneConversation>>;
      expect(greeting).toMatchObject({ source: "codex-transcript", turns: [], cursor: null, screen: true, metadata: { model: "gpt-6.1-sol", reasoning_effort: "low" } });
      expect(greeting.history_id).toStartWith("unwritten:codex:");
      // a fresh Codex on a short screen: herdr's detection read reaches up into the history above it,
      // where an earlier program said something (herdr 0.9.5, after a clear); only the live screen counts
      above = "\u2022 old output from a previous program\n";
      expect(await ask()).toMatchObject({ history_id: greeting.history_id });
      above = "";
      // scrolled up by a device, the viewport is history: nothing proves the start screen, the terminal
      // stands in, naming no model until the viewport is back at the bottom
      scrolledUp = 3;
      const scrolled = await ask();
      expect(scrolled).toBeInstanceOf(ConversationUnavailable);
      expect((scrolled as ConversationUnavailable).screen).toBeUndefined();
      scrolledUp = 0;
      // a store whose threads of this folder all ended before this Codex started
      const db = new Database(join(home, "state_5.sqlite"));
      db.exec("CREATE TABLE threads (id TEXT, rollout_path TEXT, cwd TEXT, source TEXT, created_at INTEGER, updated_at INTEGER, archived INTEGER DEFAULT 0, agent_role TEXT)");
      db.query("INSERT INTO threads (id, rollout_path, cwd, source, created_at, updated_at) VALUES ('old', '/nowhere.jsonl', ?, 'cli', 1, 2)").run(root);
      expect(await ask()).toMatchObject({ history_id: greeting.history_id });
      // a resume or a fork on the command line opens a conversation that exists
      argv = ["codex", "resume"];
      expect(await ask()).toBeInstanceOf(ConversationUnavailable);
      argv = ["codex", "fork", "--last"];
      expect(await ask()).toBeInstanceOf(ConversationUnavailable);
      argv = ["codex"];
      // something said on screen, or a first turn at work
      screen = FRESH.replace("\u203a Ask Codex", "\u203a hello\n\n\u2022 Hi there\n\n\u203a Ask Codex");
      expect(await ask()).toBeInstanceOf(ConversationUnavailable);
      screen = FRESH;
      pane.agent_status = "working";
      expect(await ask()).toBeInstanceOf(ConversationUnavailable);
      pane.agent_status = "done";
      // a thread of this folder written since this Codex started: perhaps its own, unread
      const now = Math.floor(Date.now() / 1000);
      db.query("UPDATE threads SET updated_at = ? WHERE id = 'old'").run(now);
      expect(await ask()).toBeInstanceOf(ConversationUnavailable);
      db.query("UPDATE threads SET updated_at = 2").run();
      db.query("INSERT INTO threads (id, rollout_path, cwd, source, created_at, updated_at) VALUES ('new', '/nowhere-2.jsonl', ?, 'cli', ?, ?)").run(root, now, now);
      expect(await ask()).toBeInstanceOf(ConversationUnavailable);
      // one in another folder, a subagent's or a `codex exec` run's says nothing about this one
      db.query("UPDATE threads SET cwd = '/elsewhere' WHERE id = 'new'").run();
      db.query("INSERT INTO threads (id, rollout_path, cwd, source, created_at, updated_at, agent_role) VALUES ('sub', '/sub.jsonl', ?, 'cli', ?, ?, 'worker')").run(root, now, now);
      db.query("INSERT INTO threads (id, rollout_path, cwd, source, created_at, updated_at) VALUES ('exec', '/exec.jsonl', ?, 'exec', ?, ?)").run(root, now, now);
      expect(await ask()).toMatchObject({ history_id: greeting.history_id });
      // a thread with no message yet holds no conversation, whoever made it; one with a message does
      db.exec("ALTER TABLE threads ADD COLUMN first_user_message TEXT");
      db.query("UPDATE threads SET cwd = ?, first_user_message = '' WHERE id = 'new'").run(root);
      expect(await ask()).toMatchObject({ history_id: greeting.history_id });
      db.query("UPDATE threads SET first_user_message = 'hi' WHERE id = 'new'").run();
      expect(await ask()).toBeInstanceOf(ConversationUnavailable);
      // the pane's folder named through a link: Codex stored the folder it resolves to
      const alias = join(tmpdir(), `herdr-codex-greet-alias-${process.pid}`);
      symlinkSync(root, alias);
      try {
        pane.cwd = alias;
        pane.foreground_cwd = alias;
        expect(await ask()).toBeInstanceOf(ConversationUnavailable);
      } finally { pane.cwd = root; pane.foreground_cwd = root; rmSync(alias, { force: true }); }
      // Codex runs in another folder than the pane's shell: that folder's conversations count too
      const elsewhere = mkdtempSync(join(tmpdir(), "herdr-codex-greet-fg-"));
      try {
        db.query("UPDATE threads SET cwd = ? WHERE id = 'new'").run(elsewhere);
        expect(await ask()).toMatchObject({ history_id: greeting.history_id });
        pane.foreground_cwd = elsewhere;
        expect(await ask()).toBeInstanceOf(ConversationUnavailable);
      } finally { pane.foreground_cwd = root; rmSync(elsewhere, { recursive: true, force: true }); }
      db.close();
      // a store that cannot be read tells nothing, nor one that cannot even be looked at
      writeFileSync(join(home, "state_5.sqlite"), "not a database");
      expect(await ask()).toBeInstanceOf(ConversationUnavailable);
      rmSync(join(home, "state_5.sqlite"));
      symlinkSync(join(home, "state_5.sqlite"), join(home, "state_5.sqlite"));
      expect(await ask()).toBeInstanceOf(ConversationUnavailable);
    } finally { snapshot.mockRestore(); rpc.mockRestore(); read.mockRestore(); forgetTranscriptState(); rmSync(root, { recursive: true, force: true }); }
  });

  // each Codex is a child started with the CODEX_HOME under test, whose environment the server reads from
  // the OS: a Bun process, since macOS's ps shows no environment for a system binary such as sleep
  it.skipIf(process.platform === "win32")("greets a terminal Codex only in the store its own environment places for certain", async () => {
    const root = mkdtempSync(join(tmpdir(), "herdr-codex-home-"));
    const own = join(root, "own");
    const fallback = join(root, "fallback");
    mkdirSync(own);
    mkdirSync(fallback);
    const pane = { pane_id: "codex-home", cwd: root, foreground_cwd: root, agent: "codex", agent_status: "done" } as HerdrPane;
    const children: Bun.Subprocess[] = [];
    let codexes: { pid: number; argv: string[] }[] = [];
    // each one says it runs before it is asked about: until its exec, the OS shows the environment it was forked with
    // a string is the CODEX_HOME it starts with; an object sets (or, as undefined, drops) its variables
    const started = async (...homes: (string | Record<string, string | undefined>)[]) => {
      codexes = await Promise.all(homes.map(async (home) => {
        const set = typeof home === "string" ? { CODEX_HOME: home } : home;
        const env = Object.fromEntries(Object.entries({ ...process.env, ...set }).filter((entry): entry is [string, string] => entry[1] !== undefined));
        const child = Bun.spawn([process.execPath, "-e", "console.log('ready'); setTimeout(() => {}, 60_000)"], { cwd: root, env, stdout: "pipe" });
        children.push(child);
        const reader = child.stdout.getReader();
        let said = "";
        while (!said.includes("ready")) {
          const { value, done } = await reader.read();
          if (done) throw new Error("the stand-in Codex exited before it ran");
          said += new TextDecoder().decode(value);
        }
        reader.releaseLock();
        return { pid: child.pid, argv: ["codex"] };
      }));
    };
    const snapshot = spyOn(herdr, "sessionSnapshot").mockImplementation(async () => ({ panes: [pane] }) as SessionSnapshot);
    const rpc = spyOn(herdr, "herdrRpc").mockImplementation(async (method: string) => (method === "agent.get" ? { agent: { agent: "codex" } }
      : method === "pane.get" ? { pane: { ...pane, scroll: { offset_from_bottom: 0, max_offset_from_bottom: 30, viewport_rows: 40 } } }
      : { process_info: { foreground_processes: codexes } }) as never);
    const read = spyOn(herdr, "paneRead").mockImplementation(async () => ({ text: FRESH }) as never);
    // the server's own default store holds nothing: a home it cannot place must not fall back to it
    const serverHome = process.env["CODEX_HOME"];
    process.env["CODEX_HOME"] = fallback;
    const ask = () => paneConversation(pane.pane_id).catch((error: unknown) => error);
    try {
      // a home its environment names, with no store yet: the greeting
      await started(own);
      const greeting = await ask() as Awaited<ReturnType<typeof paneConversation>>;
      expect(greeting).toMatchObject({ source: "codex-transcript", turns: [], cursor: null });
      expect(greeting.history_id).toStartWith("unwritten:codex:");
      // a relative CODEX_HOME: Codex places it under its folder, where a conversation has begun
      const relative = join(root, "rel");
      mkdirSync(relative);
      const begun = (store: string) => {
        const db = new Database(join(store, "state_5.sqlite"));
        const now = Math.floor(Date.now() / 1000);
        db.exec("CREATE TABLE threads (id TEXT, rollout_path TEXT, cwd TEXT, source TEXT, created_at INTEGER, updated_at INTEGER, archived INTEGER DEFAULT 0, agent_role TEXT, first_user_message TEXT)");
        db.query("INSERT INTO threads (id, rollout_path, cwd, source, created_at, updated_at, first_user_message) VALUES ('begun', '/nowhere.jsonl', ?, 'cli', ?, ?, 'hi')").run(root, now, now);
        db.close();
      };
      begun(relative);
      await started("rel");
      expect(await ask()).toBeInstanceOf(ConversationUnavailable);
      // a CODEX_HOME that is no directory, or a second Codex whose home cannot be placed
      await started(join(root, "missing"));
      expect(await ask()).toBeInstanceOf(ConversationUnavailable);
      await started(own, "rel");
      expect(await ask()).toBeInstanceOf(ConversationUnavailable);
      // no CODEX_HOME: the store is .codex in the HOME the Codex runs with, never the server's own
      const user = join(root, "user");
      mkdirSync(join(user, ".codex"), { recursive: true });
      await started({ CODEX_HOME: undefined, HOME: user });
      expect(await ask()).toMatchObject({ history_id: expect.stringMatching(/^unwritten:codex:/) });
      begun(join(user, ".codex"));
      expect(await ask()).toBeInstanceOf(ConversationUnavailable);
      // with no HOME, or a relative one, there is no telling where it is
      await started({ CODEX_HOME: undefined, HOME: undefined });
      expect(await ask()).toBeInstanceOf(ConversationUnavailable);
      await started({ CODEX_HOME: undefined, HOME: "user" });
      expect(await ask()).toBeInstanceOf(ConversationUnavailable);
    } finally {
      if (serverHome === undefined) delete process.env["CODEX_HOME"]; else process.env["CODEX_HOME"] = serverHome;
      for (const child of children) child.kill();
      await Promise.all(children.map((child) => child.exited));
      snapshot.mockRestore(); rpc.mockRestore(); read.mockRestore(); forgetTranscriptState(); rmSync(root, { recursive: true, force: true });
    }
  });
});

// herdr's detection read of a short screen reaches up into the history above it (herdr 0.9.5): what an
// agent drew there before is not what its screen shows now, so it never names the model (#2163 review)
describe("a model drawn only in the history above the live screen", () => {
  const homes = { HOME: process.env["HOME"], CLAUDE_CONFIG_DIR: process.env["CLAUDE_CONFIG_DIR"] };
  let root: string;
  const mocks: { mockRestore(): void }[] = [];
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "herdr-screen-history-"));
    mkdirSync(join(root, ".codex"));
    process.env["HOME"] = root;
    process.env["CLAUDE_CONFIG_DIR"] = join(root, ".claude");
  });
  afterEach(() => {
    for (const mock of mocks.splice(0)) mock.mockRestore();
    for (const agent of ["claude", "codex", "gjc"]) launchedAgents.forget(`screen-history-${agent}`);
    forgetTranscriptState();
    for (const [name, value] of Object.entries(homes)) if (value === undefined) delete process.env[name]; else process.env[name] = value;
    rmSync(root, { recursive: true, force: true });
  });
  /** A pane whose viewport (at the bottom) shows `live`, and whose detection read also reaches `history`;
   * each scroll position herdr reports in turn (offset from the bottom, rows of history; null for none,
   * as herdr's scroll is optional; "fail" for a lookup that fails), the last one from then on. */
  const shown = (agent: string, status: string, history: string, live: string, scrolls: ([number, number] | null | "fail")[] = [[0, 30]]): string => {
    const pane = { pane_id: `screen-history-${agent}`, cwd: root, foreground_cwd: root, agent, agent_status: status } as HerdrPane;
    mocks.push(spyOn(herdr, "sessionSnapshot").mockResolvedValue({ panes: [pane] } as SessionSnapshot));
    mocks.push(spyOn(herdr, "herdrRpc").mockImplementation(async (method: string) => {
      if (method === "agent.get") return { agent: { agent } } as never;
      if (method === "pane.get") {
        const scroll = scrolls.length > 1 ? scrolls.shift()! : scrolls[0]!;
        if (scroll === "fail") throw new herdr.HerdrError("connect_failed", "fixture: pane.get failed");
        return { pane: { ...pane, ...(scroll === null ? {} : { scroll: { offset_from_bottom: scroll[0], max_offset_from_bottom: scroll[1], viewport_rows: 40 } }) } } as never;
      }
      if (method === "pane.process_info") return { process_info: { foreground_processes: [] } } as never;
      throw new Error(`unexpected RPC: ${method}`);
    }));
    mocks.push(spyOn(herdr, "paneRead").mockImplementation(async ({ source }) => ({ text: source === "detection" ? history + live : live }) as never));
    return pane.pane_id;
  };

  it("names no model from an older Claude banner while the live screen asks to trust a folder", async () => {
    const id = shown("claude", "blocked", " \u2590\u259b\u2588\u2588\u2588\u259c\u258c   Claude Code v2.1.296\n\u259d\u259c\u2588\u2588\u2588\u2588\u2588\u259b\u2598  Haiku 5.5 \u00b7 Claude Max\n",
      "Accessing workspace\nIs this a project you created or one you trust?\n\u276f 1. Yes, I trust this folder\n");
    launchedAgents.launched(id, "claude");
    expect((await paneConversation(id, join(root, ".codex"))).metadata?.model).toBeNull();
  });

  it("names no model from an older Codex footer above a cleared live screen", async () => {
    const id = shown("codex", "working", "  >_ OpenAI Codex (v0.163.0)\n\n\u203a Ask Codex to do anything\n\n  GPT-6-Luna medium \u00b7 /tmp/project\n  ? for shortcuts\n", "\n\n\n\n\n\n\n");
    const answer = await paneConversation(id, join(root, ".codex")).catch((error: unknown) => error);
    expect(answer).toBeInstanceOf(ConversationUnavailable);
    expect((answer as ConversationUnavailable).screen).toBeUndefined();
  });

  it("names the model only when the viewport stayed at the bottom, with the same history, around its read", async () => {
    const frame = "  >_ OpenAI Codex (v0.163.0)\n\n\u203a Ask Codex to do anything\n\n  GPT-6.1-Sol low \u00b7 /tmp/project\n  ? for shortcuts\n";
    const named = async (scrolls: ([number, number] | null | "fail")[]) => {
      const id = shown("codex", "working", "", frame, scrolls);
      const answer = await paneConversation(id, join(root, ".codex")).catch((error: unknown) => error);
      for (const mock of mocks.splice(0)) mock.mockRestore();
      return (answer as ConversationUnavailable).screen?.model ?? null;
    };
    expect(await named([[0, 30], [0, 30]])).toBe("gpt-6.1-sol");
    // scrolled up when the read began, scrolled up by its end, or a row pushed into the history meanwhile
    expect(await named([[3, 30], [0, 30]])).toBeNull();
    expect(await named([[0, 30], [3, 30]])).toBeNull();
    expect(await named([[0, 30], [0, 31]])).toBeNull();
    // a scroll known for one read and not the other proves nothing
    expect(await named([null, [0, 30]])).toBeNull();
    expect(await named([[0, 30], null])).toBeNull();
    // nor does a lookup that failed
    expect(await named(["fail", "fail"])).toBeNull();
    expect(await named([[0, 30], "fail"])).toBeNull();
  });

  // herdr's pane.get may report no scroll, and then gives no geometry: a viewport scrolled up into the blank
  // rows under a short screen reads the same as the live one, so nothing proves the screen and none is read
  it("names no model a start screen states when herdr reports no scroll", async () => {
    const codex = "  >_ OpenAI Codex (v0.163.0)\n\n\u203a Ask Codex to do anything\n\n  GPT-6.1-Sol low \u00b7 /tmp/project\n  ? for shortcuts\n";
    const screens = [
      { agent: "claude", frame: " \u2590\u259b\u2588\u2588\u2588\u259c\u258c   Claude Code v2.1.296\n\u259d\u259c\u2588\u2588\u2588\u2588\u2588\u259b\u2598  Haiku 5.5 \u00b7 Claude Max\n\u276f Try a task\n", model: "claude-haiku-5-5", effort: null },
      { agent: "codex", frame: codex, model: "gpt-6.1-sol", effort: "low" },
      { agent: "gjc", frame: " \u2b22 opus-5.5 \u00b7 \u25c9 xhigh \u00b7 1.5% / main / project\n\u2502 > Type your message... \u2502\n", model: "claude-opus-5-5", effort: "xhigh" },
    ];
    for (const { agent, frame, model, effort } of screens) {
      // an agent this server started, before its first message: the same frame names its model with a scroll
      const cases: [[number, number] | null, { model: string | null; reasoning_effort: string | null }][] = [
        [[0, 30], { model, reasoning_effort: effort }], [null, { model: null, reasoning_effort: null }]];
      for (const [scroll, metadata] of cases) {
        const id = shown(agent, "idle", "", frame, [scroll]);
        launchedAgents.launched(id, agent);
        const answer = await paneConversation(id, join(root, ".codex"));
        expect(answer).toMatchObject({ turns: [], screen: true, metadata });
        launchedAgents.forget(id);
        for (const mock of mocks.splice(0)) mock.mockRestore();
      }
    }
    // a Codex started in the terminal: the terminal stands in, naming no model
    const terminal = shown("codex", "working", "", codex, [null]);
    const answer = await paneConversation(terminal, join(root, ".codex")).catch((error: unknown) => error);
    expect(answer).toBeInstanceOf(ConversationUnavailable);
    expect((answer as ConversationUnavailable).screen).toBeUndefined();
  });
});

// herdr-core names only the shell in front on Windows, with no session hook: Claude below it is found in the process table (#2896)
it("finds the Claude below a Windows pane's shell and its session by the PID record", async () => {
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  const home = mkdtempSync(join(tmpdir(), "claude-win32-shell-"));
  const previousHome = process.env["HOME"];
  const previousProfile = process.env["USERPROFILE"];
  const session = "5c7e1f40-2d1b-4f9e-8a3c-6b5d4e3f2a10";
  const cwd = join(home, "work");
  const started = 1_793_000_000_000;
  mkdirSync(join(home, ".claude", "projects", claudeProjectDir(cwd)), { recursive: true });
  writeFileSync(join(home, ".claude", "projects", claudeProjectDir(cwd), `${session}.jsonl`), "");
  mkdirSync(join(home, ".claude", "sessions"), { recursive: true });
  const procStart = String((BigInt(started) + 11_644_473_600_000n) * 10_000n);
  writeFileSync(join(home, ".claude", "sessions", "10108.json"), JSON.stringify({ pid: 10108, kind: "interactive", sessionId: session, procStart }));
  const rpc = spyOn(herdr, "herdrRpc").mockImplementation((async (method: string) => method === "agent.get"
    ? { agent: {} }
    : { process_info: { shell_pid: 3244, foreground_processes: [{ pid: 3244, name: "pwsh.exe", argv: ["C:\\Program Files\\PowerShell\\7\\pwsh.exe"] }] } }) as unknown as typeof herdr.herdrRpc);
  const table = spyOn(gjcRuntime, "recentProcessTable").mockResolvedValue([
    { pid: 3244, parent: 900, path: "C:\\Program Files\\PowerShell\\7\\pwsh.exe", commandLine: "pwsh.exe", started: started - 60_000 },
    { pid: 10108, parent: 3244, path: "C:\\Users\\demo\\.local\\bin\\claude.exe", commandLine: "claude", started },
  ]);
  // Windows reads the home from USERPROFILE first (user-home.ts)
  process.env["HOME"] = home;
  process.env["USERPROFILE"] = home;
  Object.defineProperty(process, "platform", { value: "win32" });
  try {
    const found = await claudePaneSession({ pane_id: "claude-win32", cwd, foreground_cwd: cwd } as HerdrPane);
    expect(found?.path).toBe(join(home, ".claude", "projects", claudeProjectDir(cwd), `${session}.jsonl`));
    expect(found?.pid).toBe(10108);
  } finally {
    Object.defineProperty(process, "platform", platform);
    if (previousHome === undefined) delete process.env["HOME"]; else process.env["HOME"] = previousHome;
    if (previousProfile === undefined) delete process.env["USERPROFILE"]; else process.env["USERPROFILE"] = previousProfile;
    table.mockRestore(); rpc.mockRestore();
    rmSync(home, { recursive: true, force: true });
  }
});

/**
 * Real stand-ins for Claude under one shell (#3009): `count` processes whose argv[0] is `claude`, each
 * printing its pid once it runs under that name, and waiting on the test's stdin. Linux only: Claude's
 * PID record is checked against the process's start in /proc.
 */
async function claudeStandIns(count: number): Promise<{ leader: number; pids: number[]; start: (pid: number) => string; stop: () => void }> {
  // a background job's stdin would be /dev/null: each stand-in reads the test's pipe through fd 3
  const one = "(exec -a claude bash -c 'echo $$; read -r line' <&3)";
  const job = Bun.spawn(["bash", "-c", `exec 3<&0; ${Array.from({ length: count }, () => `${one} &`).join(" ")} wait`], { stdin: "pipe", stdout: "pipe", stderr: "ignore" });
  const reader = job.stdout.getReader();
  let text = "";
  while (text.split("\n").length <= count) {
    const { value, done } = await reader.read();
    if (done) throw new Error(`the stand-ins ended early: ${text}`);
    text += new TextDecoder().decode(value);
  }
  const pids = text.trim().split("\n").map(Number);
  const start = (pid: number) => { const stat = readFileSync(`/proc/${pid}/stat`, "utf8"); return stat.slice(stat.lastIndexOf(") ") + 2).split(" ")[19]!; };
  return { leader: job.pid, pids, start, stop: () => { for (const pid of [...pids, job.pid]) { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } } } };
}

/** A Claude store in a temp home with one session's transcript, and the PID record of `pid` naming it. */
function claudeHome(pid: number, procStart: string): { home: string; cwd: string; transcript: string; restore: () => void } {
  const home = mkdtempSync(join(tmpdir(), "claude-job-"));
  const session = "6d1f2e3a-4b5c-4d6e-8f70-81a2b3c4d5e6";
  const cwd = join(home, "work");
  const transcript = join(home, ".claude", "projects", claudeProjectDir(cwd), `${session}.jsonl`);
  mkdirSync(join(home, ".claude", "projects", claudeProjectDir(cwd)), { recursive: true });
  writeFileSync(transcript, "");
  mkdirSync(join(home, ".claude", "sessions"), { recursive: true });
  writeFileSync(join(home, ".claude", "sessions", `${pid}.json`), JSON.stringify({ pid, kind: "interactive", sessionId: session, procStart }));
  const previousHome = process.env["HOME"];
  const previousDir = process.env["CLAUDE_CONFIG_DIR"];
  process.env["HOME"] = home;
  delete process.env["CLAUDE_CONFIG_DIR"];
  return {
    home, cwd, transcript, restore: () => {
      if (previousHome === undefined) delete process.env["HOME"]; else process.env["HOME"] = previousHome;
      if (previousDir !== undefined) process.env["CLAUDE_CONFIG_DIR"] = previousDir;
      rmSync(home, { recursive: true, force: true });
    },
  };
}

// herdr-core names only the first process of the foreground job: a launcher in front of Claude hid it (#3009)
describe.skipIf(process.platform !== "linux")("a Claude herdr-core does not name in front (#3009)", () => {
  const launcher = (leader: number) => ({ process_info: { pane_id: "t1", shell_pid: 1, foreground_processes: [{ pid: leader, name: "bun", argv: ["bun", "launch.ts"] }] } });

  it("finds the one Claude a launcher runs, and its session by the PID record", async () => {
    const job = await claudeStandIns(1);
    const store = claudeHome(job.pids[0]!, job.start(job.pids[0]!));
    const rpc = spyOn(herdr, "herdrRpc").mockImplementation((async (method: string) => method === "agent.get" ? { agent: {} } : launcher(job.leader)) as unknown as typeof herdr.herdrRpc);
    const serving = spyOn(served, "capabilities").mockReturnValue(HERDR_CORE);
    try {
      const found = await claudePaneSession({ pane_id: "t1", cwd: store.cwd, foreground_cwd: store.cwd } as HerdrPane);
      expect([found?.path, found?.pid]).toEqual([store.transcript, job.pids[0]]);
    } finally { serving.mockRestore(); rpc.mockRestore(); job.stop(); store.restore(); }
  });

  it("binds none when two Claudes run below the foreground: which one the pane shows cannot be told", async () => {
    const job = await claudeStandIns(2);
    const store = claudeHome(job.pids[0]!, job.start(job.pids[0]!));
    const rpc = spyOn(herdr, "herdrRpc").mockImplementation((async (method: string) => method === "agent.get" ? { agent: {} } : launcher(job.leader)) as unknown as typeof herdr.herdrRpc);
    const serving = spyOn(served, "capabilities").mockReturnValue(HERDR_CORE);
    try {
      expect(await claudePaneSession({ pane_id: "t1", cwd: store.cwd, foreground_cwd: store.cwd } as HerdrPane)).toBeNull();
    } finally { serving.mockRestore(); rpc.mockRestore(); job.stop(); store.restore(); }
  });

  /** an `hc attach` client's environment that reaches the core this server serves, at /run/user/1000/herdr-core/default.sock */
  const OWN = { HOME: "/home/u", XDG_RUNTIME_DIR: "/run/user/1000", XDG_CONFIG_HOME: "/nonexistent/config" };

  /**
   * A tab running `hc attach <word>` (t3), its hc client a real process with `clientEnv`; herdr-core's
   * answers for it and for the terminal hc resolves the word to. The client has printed a line before
   * this answers: /proc shows a process just spawned with its parent's environment until its exec, and
   * with none for a moment after it (#3514).
   */
  async function viewer(word: string, resolved: string, claudePid: number, clientEnv: Record<string, string> = OWN) {
    const client = Bun.spawn(["bash", "-c", "echo; read -r line"], { env: { PATH: process.env["PATH"] ?? "", ...clientEnv }, stdin: "pipe", stdout: "pipe", stderr: "ignore" });
    if ((await client.stdout.getReader().read()).done) throw new Error("the hc client stand-in ended early");
    const rpc = (async (method: string, params: { pane_id?: string }) => {
      if (method === "agent.get") return { agent: {} };
      if (params.pane_id === "t3") return { process_info: { pane_id: "t3", shell_pid: 1, foreground_processes: [{ pid: client.pid, name: "hc", argv: ["/usr/local/bin/hc", "attach", word] }] } };
      return { process_info: { pane_id: resolved, shell_pid: 1, foreground_processes: [{ pid: claudePid, name: "claude", argv: ["claude"] }] } };
    }) as unknown as typeof herdr.herdrRpc;
    return { rpc, stop: () => client.kill("SIGKILL") };
  }

  /** what claudePaneSession binds the viewing tab t3 to */
  async function viewed(word: string, resolved: string, clientEnv?: Record<string, string>) {
    const job = await claudeStandIns(1);
    const store = claudeHome(job.pids[0]!, job.start(job.pids[0]!));
    const tab = await viewer(word, resolved, job.pids[0]!, clientEnv).catch((error: unknown) => { job.stop(); store.restore(); throw error; });
    const rpc = spyOn(herdr, "herdrRpc").mockImplementation(tab.rpc);
    const serving = spyOn(served, "capabilities").mockReturnValue(HERDR_CORE);
    const core = spyOn(runtime, "coreSocketPath").mockReturnValue("/run/user/1000/herdr-core/default.sock");
    try {
      const found = await claudePaneSession({ pane_id: "t3", cwd: store.cwd, foreground_cwd: store.cwd } as HerdrPane);
      return { found: found === null ? null : [found.path, found.pid], expected: [store.transcript, job.pids[0]!] };
    } finally { core.mockRestore(); serving.mockRestore(); rpc.mockRestore(); tab.stop(); job.stop(); store.restore(); }
  }

  it("shows the conversation of the local terminal an `hc attach <t>` tab views", async () => {
    const { found, expected } = await viewed("t2", "t2");
    expect(found).toEqual(expected);
  });

  it("follows no `hc attach` word hc resolves to another terminal's address, as a name", async () => {
    expect((await viewed("review", "t2")).found).toBeNull();
  });

  // terminal numbers start at t1 in every core: the same word names another terminal there
  it("follows no `hc attach` whose client reaches another core", async () => {
    expect((await viewed("t2", "t2", { ...OWN, HC_SESSION: "other" })).found).toBeNull();
  });
});

// the native claude.exe the shell started can run the session in a child claude.exe, and only that child writes the PID record
it("finds a Windows pane's session by the child claude.exe holding the PID record, not the one its shell started", async () => {
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  const home = mkdtempSync(join(tmpdir(), "claude-win32-launcher-"));
  const previousHome = process.env["HOME"];
  const previousProfile = process.env["USERPROFILE"];
  // or the lookup reads the developer's own store too
  const previousConfig = process.env["CLAUDE_CONFIG_DIR"];
  delete process.env["CLAUDE_CONFIG_DIR"];
  const session = "7d9f3a52-4e2c-4b1a-9c5d-8e7f6a5b4c32";
  const cwd = join(home, "work");
  const started = 1_793_000_000_000;
  const exe = "C:\\Users\\demo\\.local\\bin\\claude.exe";
  const transcript = join(home, ".claude", "projects", claudeProjectDir(cwd), `${session}.jsonl`);
  const pidRecord = join(home, ".claude", "sessions", "20108.json");
  mkdirSync(join(home, ".claude", "projects", claudeProjectDir(cwd)), { recursive: true });
  writeFileSync(transcript, "");
  mkdirSync(join(home, ".claude", "sessions"), { recursive: true });
  const procStart = String((BigInt(started) + 11_644_473_600_000n) * 10_000n);
  writeFileSync(pidRecord, JSON.stringify({ pid: 20108, kind: "interactive", sessionId: session, procStart }));
  const shellOnly = { shell_pid: 3244, foreground_processes: [{ pid: 3244, name: "pwsh.exe", argv: ["C:\\Program Files\\PowerShell\\7\\pwsh.exe"] }] };
  const rpc = spyOn(herdr, "herdrRpc").mockImplementation((async (method: string) => method === "agent.get" ? { agent: {} } : { process_info: shellOnly }) as unknown as typeof herdr.herdrRpc);
  const table = spyOn(gjcRuntime, "recentProcessTable").mockResolvedValue([
    { pid: 3244, parent: 900, path: "C:\\Program Files\\PowerShell\\7\\pwsh.exe", commandLine: "pwsh.exe", started: started - 60_000 },
    { pid: 20107, parent: 3244, path: exe, commandLine: `"${exe}"`, started: started - 1_000 },
    { pid: 20108, parent: 20107, path: exe, commandLine: `"${exe}" --permission-mode auto`, started },
  ]);
  process.env["HOME"] = home;
  process.env["USERPROFILE"] = home;
  const pane = { pane_id: "claude-win32-launcher", agent: "claude", cwd, foreground_cwd: cwd } as HerdrPane;
  Object.defineProperty(process, "platform", { value: "win32" });
  try {
    const found = await claudePaneSession(pane);
    expect(found?.path).toBe(transcript);
    expect(found?.pid).toBe(20108);
    expect(await claudePanePid(pane)).toBe(20108);
    expect(await paneTranscript(pane.pane_id, undefined, { panes: [pane] } as unknown as SessionSnapshot)).toMatchObject({ source: "claude-transcript", path: transcript });
    // elsewhere herdr names the program in front: a shell alone runs no Claude, and no process table is read
    for (const other of ["linux", "darwin"]) {
      Object.defineProperty(process, "platform", { value: other });
      table.mockClear();
      expect(await claudePaneSession(pane)).toBeNull();
      expect(await claudePanePid(pane)).toBeNull();
      expect(table).not.toHaveBeenCalled();
    }
    // no record written yet: the claude.exe the shell started stands, with no session to read
    Object.defineProperty(process, "platform", { value: "win32" });
    rmSync(pidRecord);
    expect(await claudePaneSession(pane)).toBeNull();
    expect(await claudePanePid(pane)).toBe(20107);
  } finally {
    Object.defineProperty(process, "platform", platform);
    if (previousHome === undefined) delete process.env["HOME"]; else process.env["HOME"] = previousHome;
    if (previousProfile === undefined) delete process.env["USERPROFILE"]; else process.env["USERPROFILE"] = previousProfile;
    if (previousConfig === undefined) delete process.env["CLAUDE_CONFIG_DIR"]; else process.env["CLAUDE_CONFIG_DIR"] = previousConfig;
    table.mockRestore(); rpc.mockRestore();
    forgetTranscriptState();
    rmSync(home, { recursive: true, force: true });
  }
});

// any client snapshot starts the Claude subagent refresh that reads this, also the one a pending message is checked against (#1545)
it("reads a Claude pane's process start from the kernel on macOS, with no ps for it", async () => {
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  const home = mkdtempSync(join(tmpdir(), "claude-darwin-start-"));
  const previousHome = process.env["HOME"];
  const session = "0b9d6a52-7a5e-4f8e-9a51-2f3c4d5e6f70";
  const cwd = join(home, "project");
  mkdirSync(join(home, ".claude", "projects", claudeProjectDir(cwd)), { recursive: true });
  writeFileSync(join(home, ".claude", "projects", claudeProjectDir(cwd), `${session}.jsonl`), "");
  const rpc = spyOn(herdr, "herdrRpc").mockImplementation((async (method: string) => method === "agent.get"
    ? { agent: { agent_session: { value: session } } }
    : { process_info: { foreground_processes: [{ pid: 4242, name: "claude", argv: ["claude"] }] } }) as unknown as typeof herdr.herdrRpc);
  const blocking = spyOn(Bun, "spawnSync");
  // the kernel's process record answers the start; no ps asks it, awaited or not (#1404). Claude's own
  // store may still ask an awaited ps for the process's environment on a real Mac.
  const kernel = spyOn(darwinProcess, "darwinStartTime").mockReturnValue(1_000_000n);
  const awaited = spyOn(Bun, "spawn");
  process.env["HOME"] = home;
  Object.defineProperty(process, "platform", { value: "darwin" });
  try {
    const found = await claudePaneSession({ pane_id: "claude-darwin", cwd } as HerdrPane);
    expect(found?.pid).toBe(4242);
    expect(found?.startedAt).toBe(1_000);
    expect((awaited.mock.calls as unknown as [string[]][]).filter(([argv]) => argv.includes("etime="))).toEqual([]);
    expect(blocking).not.toHaveBeenCalled();
  } finally {
    Object.defineProperty(process, "platform", platform);
    if (previousHome === undefined) delete process.env["HOME"]; else process.env["HOME"] = previousHome;
    awaited.mockRestore(); blocking.mockRestore(); kernel.mockRestore(); rpc.mockRestore();
    rmSync(home, { recursive: true, force: true });
  }
});

it("serves no Claude tool output from another transcript that a folder swap puts at the path around the lookup's open", () => {
  const root = mkdtempSync(join(tmpdir(), "claude-output-swap-"));
  try {
    const folder = join(root, "project");
    const elsewhere = join(root, "elsewhere");
    const away = join(root, "away");
    mkdirSync(folder);
    mkdirSync(elsewhere);
    const path = join(folder, "session.jsonl");
    // the same records and length: only the result's bytes tell the transcripts apart
    const transcript = (result: string) => [
      { type: "assistant", uuid: "a1", parentUuid: null, message: { role: "assistant", content: [{ type: "tool_use", id: "toolu_1", name: "Bash", input: {} }] } },
      { type: "user", uuid: "u1", parentUuid: "a1", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: result }] } },
    ].map((entry) => JSON.stringify(entry)).join("\n") + "\n";
    writeFileSync(path, transcript("the pane's own output"));
    writeFileSync(join(elsewhere, "session.jsonl"), transcript("FOREIGN SECRET OUTPUT"));
    expect(transcriptToolOutput("claude-transcript", path, "toolu_1")).toBe("the pane's own output");
    // the path names the pane's own transcript when the lookup begins; its open, or a read by path, meets the other folder
    let swaps = 0;
    const swapped = <T>(read: () => T): T => {
      swaps++;
      renameSync(folder, away);
      renameSync(elsewhere, folder);
      try { return read(); }
      finally {
        renameSync(folder, elsewhere);
        renameSync(away, folder);
      }
    };
    const { openSync, readFileSync } = fs;
    const opens = spyOn(fs, "openSync").mockImplementation(((...args: Parameters<typeof fs.openSync>) =>
      args[0] === path ? swapped(() => openSync(...args)) : openSync(...args)) as typeof fs.openSync);
    const reads = spyOn(fs, "readFileSync").mockImplementation(((...args: Parameters<typeof fs.readFileSync>) =>
      args[0] === path ? swapped(() => readFileSync(...args)) : readFileSync(...args)) as typeof fs.readFileSync);
    let answered: string | null;
    try { answered = transcriptToolOutput("claude-transcript", path, "toolu_1"); } finally { opens.mockRestore(); reads.mockRestore(); }
    expect(swaps).toBeGreaterThan(0);
    expect(answered).toBeNull();
  } finally { rmSync(root, { recursive: true, force: true }); }
});
