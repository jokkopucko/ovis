import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { forgetTranscriptState, paneConversation, paneTranscript, toolOutput, transcriptPage } from "./conversation.ts";
import { ConversationUnavailable } from "./conversation-shared.ts";
import { FileBusyError, setFilePoolOptions } from "./file-pool.ts";
import { runFileTask } from "./file-tasks.ts";
import * as herdr from "./herdr/client.ts";
import * as letta from "./letta.ts";
import { LettaUnavailable, lettaToolOutput, parseLettaTranscript } from "./letta.ts";
import * as lettaStore from "./letta-store.ts";
import { isLettaProcess, type LettaProcess, lettaBinding, paneLettaProcess, lettaInStartFolder, lettaLocalOwner, lettaLocalSettings, lettaRecordOwned, lettaOpenedSessions, lettaSessionOf, lettaTranscriptFor, lettaTranscriptHeld, lettaTranscriptPath, parseEnviron, resolveLettaTranscript } from "./letta-store.ts";
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
const restores: { mockRestore(): void }[] = [];
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "letta-")); });
afterEach(() => {
  for (const spy of restores.splice(0)) spy.mockRestore();
  // the file threads a test started, or the stand-ins it set
  setFilePoolOptions();
  rmSync(root, { recursive: true, force: true });
  forgetTranscriptState();
});

/** One tool call's line, as Letta 0.34.27 writes it. */
const call = (id: string, resultText: string): string => `${JSON.stringify({ kind: "tool_call", name: "Bash", argsText: "{}", resultText, resultOk: true, captured_at: "2026-10-29T01:00:00.000Z", source_line_id: id })}\n`;

/**
 * A pane herdr labels Letta, whose resolver binds it to the transcript at `path` (restored after the test);
 * `rebind` has it name another transcript, as after a `/new`: from then on, or once it was resolved `after` more times.
 */
const lettaPane = (path: string) => {
  const target = pane("w1:p1", "local-conv-1", root);
  const found = (at: string) => ({ path: at, session: "local-conv-1", agent: AGENT, conversation: "local-conv-1", store: join(root, "lc-local-backend"), startedAt: Date.now() });
  const resolution = spyOn(lettaStore, "resolveLettaTranscript").mockResolvedValue(found(path));
  restores.push(resolution,
    spyOn(herdr, "sessionSnapshot").mockResolvedValue({ panes: [target], agents: [], workspaces: [], tabs: [], layouts: [], version: "fixture", protocol: 22 } as never),
    spyOn(herdr, "paneProcessInfo").mockResolvedValue({ pane_id: target.pane_id, foreground_processes: [] } as never),
    spyOn(herdr, "herdrRpc").mockImplementation(async () => ({}) as never));
  return {
    id: target.pane_id, resolution,
    rebind: (at: string, after = 0) => {
      for (let kept = 0; kept < after; kept += 1) resolution.mockResolvedValueOnce(found(path));
      resolution.mockResolvedValue(found(at));
    },
  };
};

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

  test("the whole output of a call is read by the ref its part carries", async () => {
    const path = join(root, "transcript.jsonl");
    const long = "y".repeat(200_000);
    writeFileSync(path, `${JSON.stringify({ kind: "user", text: "go", captured_at: "2026-10-29T01:00:00.000Z", source_line_id: "user-1" })}\n${call("Bash-1-1", long)}`);
    const tool = transcriptPage("letta-transcript", path).turns[1]!.parts[0]!;
    expect(tool).toMatchObject({ kind: "tool", output_ref: "Bash-1-1", output_size: long.length });
    expect(lettaToolOutput(path, "Bash-1-1")).toBe(long);
    expect(lettaToolOutput(path, "Bash-9-9")).toBeNull();
    // past its time limit a scan reads no further and answers as for a call it did not find: its thread is free again
    expect(lettaToolOutput(path, "Bash-1-1", Date.now() - 1)).toBeNull();
    expect(lettaToolOutput(path, "Bash-1-1", Date.now() + 60_000)).toBe(long);
    // a link put where the transcript was is not followed
    const link = join(root, "linked.jsonl");
    symlinkSync(path, link);
    expect(lettaToolOutput(link, "Bash-1-1")).toBeNull();
    // the pane's route answers the same
    const own = lettaPane(path);
    expect(await toolOutput(own.id, "Bash-1-1")).toBe(long);
    expect(await toolOutput(own.id, "Bash-9-9")).toBeNull();
    // a ref in the shape of another agent's (Copilot's), which the page never offers, names no call of Letta's
    const foreign = `cp0123456789abcdef.Bash-1-1@1@2@${"0".repeat(32)}`;
    appendFileSync(path, call(foreign, "never offered"));
    expect(lettaToolOutput(path, foreign)).toBe("never offered");
    expect(await toolOutput(own.id, foreign)).toBeNull();
  });

  test("scans the transcript on a file thread, never on the server's, however long a line it holds (#3326)", async () => {
    const path = join(root, "transcript.jsonl");
    // a line of several reads, which the server's thread took seconds to join and parse, then the call asked for
    writeFileSync(path, `${call("Bash-0-0", "x".repeat(6 * 1024 * 1024))}${call("Bash-1-1", "the call's output")}`);
    const own = lettaPane(path);
    let opened = 0;
    const { openSync } = fs;
    restores.push(spyOn(fs, "openSync").mockImplementation(((...args: Parameters<typeof fs.openSync>) => {
      if (args[0] === path) opened += 1;
      return openSync(...args);
    }) as typeof fs.openSync));
    expect(await toolOutput(own.id, "Bash-1-1")).toBe("the call's output");
    // the long line's own output crosses to the server's thread cut to a page of output
    expect(await toolOutput(own.id, "Bash-0-0")).toBe(`${"x".repeat(2_000_000)}\n… trimmed`);
    // this thread, which answers every other request and terminal, never opened it to read
    expect(opened).toBe(0);
  });

  test("a line of many reads is joined once, not copied again at each read (#3326)", () => {
    const path = join(root, "transcript.jsonl");
    const big = "x".repeat(8 * 1024 * 1024);
    writeFileSync(path, `${call("Bash-0-0", big)}${call("Bash-1-1", "after the long line")}`);
    let joined = 0;
    const { concat } = Buffer;
    restores.push(spyOn(Buffer, "concat").mockImplementation(((list: readonly Uint8Array[], length?: number) => {
      for (const piece of list) joined += piece.length;
      return concat.call(Buffer, list, length);
    }) as typeof Buffer.concat));
    expect(lettaToolOutput(path, "Bash-1-1")).toBe("after the long line");
    // each byte of the long line once: joining what was read so far again at every read copied 44 MiB here
    expect(joined).toBeLessThan(2 * fs.statSync(path).size);
    expect(lettaToolOutput(path, "Bash-0-0")).toBe(big);
    // a last line Letta is still writing is not a call yet
    writeFileSync(path, `${call("Bash-0-0", big)}${call("Bash-1-1", "unfinished").trimEnd()}`);
    expect(lettaToolOutput(path, "Bash-1-1")).toBeNull();
    expect(lettaToolOutput(path, "Bash-0-0")).toBe(big);
  });

  test("a file thread reads only the file the lookup authorized, and cuts the output to the cap there", async () => {
    const path = join(root, "transcript.jsonl");
    const other = join(root, "other.jsonl");
    const long = "y".repeat(10_000);
    writeFileSync(path, call("Bash-1-1", long));
    writeFileSync(other, call("Bash-1-1", "another conversation's output"));
    const authorized = fs.statSync(path);
    expect(await letta.lettaToolOutputOffThread(path, "Bash-1-1", authorized, 20_000)).toBe(long);
    expect(await letta.lettaToolOutputOffThread(path, "Bash-1-1", authorized, 100)).toBe(`${"y".repeat(100)}\n… trimmed`);
    expect(await letta.lettaToolOutputOffThread(path, "Bash-9-9", authorized, 100)).toBeNull();
    // the path names another file than the one authorized: its thread reads none of it
    expect(await letta.lettaToolOutputOffThread(path, "Bash-1-1", fs.statSync(other), 20_000)).toBeNull();
    expect(await letta.lettaToolOutputOffThread(other, "Bash-1-1", fs.statSync(other, { bigint: true }), 20_000)).toBe("another conversation's output");
  });

  test("serves no tool output from another transcript that a folder swap puts at the path around the lookup's open", async () => {
    const folder = join(root, "own");
    const elsewhere = join(root, "elsewhere");
    const away = join(root, "away");
    mkdirSync(folder);
    mkdirSync(elsewhere);
    const path = join(folder, "transcript.jsonl");
    writeFileSync(path, call("Bash-1-1", "the pane's own output"));
    writeFileSync(join(elsewhere, "transcript.jsonl"), call("Bash-1-1", "FOREIGN SECRET OUTPUT"));
    const own = lettaPane(path);
    // the scan runs on this thread, where the open below is seen
    setFilePoolOptions({ inline: runFileTask });
    expect(await toolOutput(own.id, "Bash-1-1")).toBe("the pane's own output");
    // the path names the pane's own transcript when the lookup begins; its open meets the other folder
    let swaps = 0;
    const real = fs.openSync;
    restores.push(spyOn(fs, "openSync").mockImplementation(((...args: Parameters<typeof fs.openSync>) => {
      if (args[0] !== path) return real(...args);
      swaps++;
      renameSync(folder, away);
      renameSync(elsewhere, folder);
      try { return real(...args); }
      finally {
        renameSync(folder, elsewhere);
        renameSync(away, folder);
      }
    }) as typeof fs.openSync));
    expect(await toolOutput(own.id, "Bash-1-1")).toBeNull();
    expect(swaps).toBeGreaterThan(0);
  });

  test("answers no tool output for a pane bound to another conversation while its transcript was scanned", async () => {
    const path = join(root, "transcript.jsonl");
    const other = join(root, "other.jsonl");
    writeFileSync(path, call("Bash-1-1", "the old conversation"));
    writeFileSync(other, call("Bash-2-2", "the new conversation"));
    const own = lettaPane(path);
    expect(await toolOutput(own.id, "Bash-1-1")).toBe("the old conversation");
    // `/new` in the pane once this lookup resolved it, which no other read sees before the scan answers
    own.rebind(other, 1);
    expect(await toolOutput(own.id, "Bash-1-1")).toBeNull();
  });

  test("refuses at once a pane another read saw bound to another conversation while its transcript was scanned", async () => {
    const path = join(root, "transcript.jsonl");
    const other = join(root, "other.jsonl");
    writeFileSync(path, call("Bash-1-1", "the old conversation"));
    writeFileSync(other, call("Bash-2-2", "the new conversation"));
    const own = lettaPane(path);
    // the scan is held while the pane's letta moves on
    const scan = letta.lettaToolOutputOffThread;
    let release!: () => void;
    const hold = new Promise<void>((resolve) => { release = resolve; });
    let scanning!: () => void;
    const began = new Promise<void>((resolve) => { scanning = resolve; });
    restores.push(spyOn(letta, "lettaToolOutputOffThread").mockImplementation(async (...args: Parameters<typeof scan>) => {
      scanning();
      await hold;
      return scan(...args);
    }));
    const output = toolOutput(own.id, "Bash-1-1");
    await began;
    own.rebind(other);
    expect((await paneTranscript(own.id)).path).toBe(other);
    const resolved = own.resolution.mock.calls.length;
    release();
    expect(await output).toBeNull();
    // the pane was not resolved again for it
    expect(own.resolution.mock.calls.length).toBe(resolved);
  });

  test("answers busy, not missing, when no file thread is free to scan the transcript", async () => {
    const path = join(root, "transcript.jsonl");
    writeFileSync(path, call("Bash-1-1", "the call's output"));
    const own = lettaPane(path);
    // no thread and no waiting place: every file task is refused at once
    setFilePoolOptions({ workers: 0, waiting: 0 });
    await expect(toolOutput(own.id, "Bash-1-1")).rejects.toBeInstanceOf(FileBusyError);
    setFilePoolOptions();
    expect(await toolOutput(own.id, "Bash-1-1")).toBe("the call's output");
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
  /**
   * A project whose Letta record is `settings`, written `at`, and the pane's letta process started `started`.
   * `used`: the process has written the transcripts of the conversations the fixture names since it started.
   */
  const setup = (settings: string | null, at: number, started: number, env: Record<string, string> = {}, used = true): LettaProcess => {
    if (used) for (const conversation of ["local-conv-1", "default"]) {
      const transcript = lettaTranscriptPath(join(root, ".letta", "transcripts"), AGENT, conversation);
      mkdirSync(join(transcript, ".."), { recursive: true });
      writeFileSync(transcript, newLog);
      utimesSync(transcript, (started + 5_000) / 1000, (started + 5_000) / 1000);
    }
    const cwd = join(root, "proj");
    mkdirSync(join(cwd, ".letta"), { recursive: true });
    if (settings !== null) {
      writeFileSync(join(cwd, ".letta", "settings.local.json"), settings);
      utimesSync(join(cwd, ".letta", "settings.local.json"), at / 1000, at / 1000);
    }
    return { pid: 4242, cwd, startedAt: started, startedBy: started, identity: started, env: { HOME: root, ...env }, argv: ["letta"] };
  };
  const now = Date.now();
  /** The ways this host reaches a peer's record: through /proc where Linux has it, and by its path, as macOS and Windows do. */
  const reaches = [...new Set([lettaStore.peerRecordReach.procFd, false])];
  /** A test of how a peer's record is read, run each way this host can reach it. */
  const peerTest = (name: string, body: () => Promise<void>): void => {
    for (const procFd of reaches) test(procFd ? name : `${name} (no /proc)`, async () => {
      const was = lettaStore.peerRecordReach.procFd;
      lettaStore.peerRecordReach.procFd = procFd;
      try { await body(); } finally { lettaStore.peerRecordReach.procFd = was; }
    });
  };

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

  test("Letta's record speaks for the pane's process only when it is older than that process", async () => {
    const reported = (cwd: string) => pane("w1:p1", "local-conv-1", cwd);
    const path = lettaTranscriptPath(join(root, ".letta", "transcripts"), AGENT, "local-conv-1");
    // the process resumed the conversation the record names, so it wrote nothing
    let owner = setup(settingsAfterNew, now - 60_000, now);
    expect(await lettaTranscriptFor(reported(owner.cwd), [reported(owner.cwd)], owner)).toEqual({ path, session: "local-conv-1", agent: AGENT, conversation: "local-conv-1" });
    // any write since: its own start on another conversation, its /new, or another letta
    // a file system that keeps whole seconds (HFS+) or two (FAT) puts a write just after the start up to two seconds before it
    for (const at of [now - 1_999, now - 999, now, now + 1, now + 2_000, now + 600_000]) {
      owner = setup(settingsAfterNew, at, now);
      expect(await lettaTranscriptFor(reported(owner.cwd), [reported(owner.cwd)], owner)).toBeNull();
    }
  });

  // herdr-core sends no report for Letta (hc 0.1.17, letta-code 0.34.44, old-desktop 2026-11-08), nor does herdr without its Letta integration
  test("without a report, Letta's record alone binds the one conversation it names, still only when older than the process", async () => {
    const silent = (cwd: string) => pane("w1:p1", null, cwd);
    let owner = setup(settingsAfterNew, now - 60_000, now);
    expect(await lettaTranscriptFor(silent(owner.cwd), [silent(owner.cwd)], owner)).toEqual({ path: lettaTranscriptPath(join(root, ".letta", "transcripts"), AGENT, "local-conv-1"), session: "local-conv-1", agent: AGENT, conversation: "local-conv-1" });
    owner = setup(JSON.stringify({ sessionsByServer: { local: { agentId: AGENT, conversationId: "default" } } }), now - 60_000, now);
    expect(await lettaTranscriptFor(silent(owner.cwd), [silent(owner.cwd)], owner)).toMatchObject({ session: `default:${AGENT}`, agent: AGENT, conversation: "default" });
    owner = setup(settingsAfterNew, now + 1, now);
    expect(await lettaTranscriptFor(silent(owner.cwd), [silent(owner.cwd)], owner)).toBeNull();
    // two servers' records naming different conversations do not say which one this process opened
    owner = setup(JSON.stringify({ sessionsByServer: { local: { agentId: AGENT, conversationId: "local-conv-1" }, cloud: { agentId: "agent-x", conversationId: "conv-y" } } }), now - 60_000, now);
    expect(await lettaTranscriptFor(silent(owner.cwd), [silent(owner.cwd)], owner)).toBeNull();
    // a report of another form is no absent report
    const other = { ...silent(owner.cwd), agent_session: { agent: "letta", kind: "path", source: "herdr:letta", value: "x" } } as HerdrPane;
    owner = setup(settingsAfterNew, now - 60_000, now);
    expect(await lettaTranscriptFor(other, [other], owner)).toBeNull();
  });

  test("without a report, the conversation must show this process's own use: a transcript written since it started", async () => {
    const owner = setup(settingsAfterNew, now - 60_000, now, {}, false);
    const target = pane("w1:p1", null, owner.cwd);
    const path = lettaTranscriptPath(join(root, ".letta", "transcripts"), AGENT, "local-conv-1");
    // no transcript yet: a process still loading what it opens says nothing
    expect(await lettaTranscriptFor(target, [target], owner)).toBeNull();
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, newLog);
    // an older transcript is the previous process's
    utimesSync(path, (now - 60_000) / 1000, (now - 60_000) / 1000);
    expect(await lettaTranscriptFor(target, [target], owner)).toBeNull();
    // just before the start is still the previous process's
    utimesSync(path, (now - 1_000) / 1000, (now - 1_000) / 1000);
    expect(await lettaTranscriptFor(target, [target], owner)).toBeNull();
    utimesSync(path, (now + 5_000) / 1000, (now + 5_000) / 1000);
    expect((await lettaTranscriptFor(target, [target], owner))?.path).toBe(path);
  });

  test("without a report, a transcript between the start's lower bound and its real start is another letta's", async () => {
    // the start is known only as 4 s to 5 s ago on this read; a write 4.5 s ago may be from before it
    const owner = { ...setup(settingsAfterNew, now - 60_000, now, {}, false), startedAt: now - 5_000, startedBy: now - 4_000 };
    const target = pane("w1:p1", null, owner.cwd);
    const path = lettaTranscriptPath(join(root, ".letta", "transcripts"), AGENT, "local-conv-1");
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, newLog);
    utimesSync(path, (now - 4_500) / 1000, (now - 4_500) / 1000);
    expect(await lettaTranscriptFor(target, [target], owner)).toBeNull();
    utimesSync(path, (now - 3_000) / 1000, (now - 3_000) / 1000);
    expect((await lettaTranscriptFor(target, [target], owner))?.path).toBe(path);
    // a start not known from above binds nothing
    expect(await lettaTranscriptFor(target, [target], { ...owner, startedBy: null })).toBeNull();
  });

  test("a pid whose live command line is not the letta herdr reported is someone else's: its start and environment are not read", async () => {
    // this test's own runtime under a reported letta argv: a reused pid
    expect(await paneLettaProcess("w1:p1", { pane_id: "w1:p1", foreground_processes: [{ pid: process.pid, name: "letta", argv: ["letta"], cwd: root }] } as never)).toBeNull();
  });

  test("without a report, a letta that picked its conversation itself, or saves none, binds nothing", async () => {
    const silent = pane("w1:p1", null, root);
    const owner = setup(settingsAfterNew, now - 60_000, now);
    const at = (argv: string[], env: Record<string, string> = {}) => lettaTranscriptFor({ ...silent, cwd: owner.cwd, foreground_cwd: owner.cwd }, [], { ...owner, argv, env: { ...owner.env, ...env } });
    // plain letta resumes the project's last conversation, the one its record names; the model, backend and tools change nothing of that
    expect(await at(["node", "/x/.bin/letta"])).not.toBeNull();
    expect(await at(["letta", "--backend", "local", "-m", "openai-compatible/claude-haiku-4-5", "--toolset", "auto"])).not.toBeNull();
    for (const argv of [["letta", "--new"], ["letta", "-r"], ["letta", "--resume"], ["letta", "--agent", "agent-x"], ["letta", "-n", "bob"], ["letta", "--conversation", "conv-b"], ["letta", "--new-agent"], ["letta", "--some-future-flag"]]) {
      expect(await at(argv)).toBeNull();
    }
    // Letta then writes no record of what it opened: whatever value it is given, and as a subagent
    for (const value of ["1", "0", ""]) expect(await at(["letta"], { LETTA_DISABLE_SESSION_PERSIST: value })).toBeNull();
    expect(await at(["letta"], { LETTA_CODE_AGENT_ROLE: "subagent" })).toBeNull();
  });

  test("without a report, another Letta pane that reports nothing binds nothing either: it may have moved from a folder with the same record", async () => {
    const owner = setup(settingsAfterNew, now - 60_000, now);
    const target = pane("w1:p1", null, owner.cwd);
    expect(await lettaTranscriptFor(target, [target], owner)).not.toBeNull();
    expect(await lettaTranscriptFor(target, [target, pane("w2:p1", null, join(root, "elsewhere"))], owner)).toBeNull();
    // a peer that reports its own conversation is told apart by its report
    expect(await lettaTranscriptFor(target, [target, pane("w2:p1", "local-conv-7", join(root, "elsewhere"))], owner)).not.toBeNull();
  });

  peerTest("without a report, a conversation another Letta pane's folder record also names binds nothing; with one, it binds", async () => {
    const owner = setup(settingsAfterNew, now - 60_000, now);
    const other = join(root, "other");
    mkdirSync(join(other, ".letta"), { recursive: true });
    writeFileSync(join(other, ".letta", "settings.local.json"), settingsAfterNew);
    const silent = pane("w1:p1", null, owner.cwd);
    expect(await lettaTranscriptFor(silent, [silent], owner)).not.toBeNull();
    // a peer's report may be the first it made, before a /resume: its folder record still counts
    expect(await lettaTranscriptFor(silent, [silent, pane("w2:p1", "local-conv-9", other)], owner)).toBeNull();
    // a record reached through a link is not read as that folder's: it binds nothing either
    const linked = join(root, "linked");
    mkdirSync(linked);
    symlinkSync(join(other, ".letta"), join(linked, ".letta"));
    expect(await lettaTranscriptFor(silent, [silent, pane("w2:p1", "local-conv-9", linked)], owner)).toBeNull();
    // its process may run in a folder other than where the pane started: both folders' records count
    const elsewhere = join(root, "wrapper-dir");
    mkdirSync(elsewhere);
    const split = { ...pane("w2:p1", "local-conv-9", other), foreground_cwd: elsewhere } as HerdrPane;
    expect(await lettaTranscriptFor(silent, [silent, split], owner)).toBeNull();
    // a pane with a report keeps it: another folder's old record is no evidence against it
    const reported = pane("w1:p1", "local-conv-1", owner.cwd);
    expect(await lettaTranscriptFor(reported, [reported, pane("w2:p1", "local-conv-9", other)], owner)).not.toBeNull();
    // a peer whose record names another conversation makes no claim
    writeFileSync(join(other, ".letta", "settings.local.json"), JSON.stringify({ sessionsByServer: { local: { agentId: AGENT, conversationId: "local-conv-9" } } }));
    expect(await lettaTranscriptFor(silent, [silent, pane("w2:p1", "local-conv-9", other)], owner)).not.toBeNull();
  });

  peerTest("another pane's folder record is read off the event loop, and only as the file that folder's own path names", async () => {
    const owner = setup(settingsAfterNew, now - 60_000, now);
    const other = join(root, "other");
    mkdirSync(join(other, ".letta"), { recursive: true });
    writeFileSync(join(other, ".letta", "settings.local.json"), settingsAfterNew);
    const decoy = join(root, "decoy");
    mkdirSync(decoy);
    writeFileSync(join(decoy, "settings.local.json"), JSON.stringify({ sessionsByServer: { local: { agentId: AGENT, conversationId: "local-conv-9" } } }));
    const silent = pane("w1:p1", null, owner.cwd);
    const peer = pane("w2:p1", "local-conv-9", other);
    // the peer's .letta is swapped for a link to a record claiming nothing just as that record is opened, however it is opened
    let swapped = false;
    const swap = (path: unknown): void => {
      if (swapped || !String(path).endsWith("settings.local.json")) return;
      swapped = true;
      renameSync(join(other, ".letta"), join(root, "moved"));
      symlinkSync(decoy, join(other, ".letta"));
    };
    const sync: string[] = [];
    const { openSync, realpathSync } = fs;
    const { open } = fsp;
    const spies = [
      spyOn(fs, "openSync").mockImplementation(((path: fs.PathLike, ...rest: [never]) => { sync.push(String(path)); swap(path); return openSync(path, ...rest); }) as typeof fs.openSync),
      spyOn(fs, "realpathSync").mockImplementation(((path: fs.PathLike) => { sync.push(String(path)); return realpathSync(path); }) as typeof fs.realpathSync),
      spyOn(fsp, "open").mockImplementation(((path: fs.PathLike, ...rest: [never]) => { swap(path); return open(path, ...rest); }) as typeof fsp.open),
    ];
    try {
      expect(await lettaTranscriptFor(silent, [silent, peer], owner)).toBeNull();
    } finally { for (const spy of spies) spy.mockRestore(); }
    expect(swapped).toBe(true);
    // nothing waits on the peer's folder, which may be an unresponsive mount
    expect(sync.filter((path) => path.includes(other))).toEqual([]);
  });

  peerTest("a peer's .letta swapped for a decoy directory while its record is opened, and put back, is still not read as its own", async () => {
    const owner = setup(settingsAfterNew, now - 60_000, now);
    const other = join(root, "other");
    mkdirSync(join(other, ".letta"), { recursive: true });
    writeFileSync(join(other, ".letta", "settings.local.json"), settingsAfterNew);
    // a plain directory, naming another conversation, put where the peer's .letta was
    const decoy = join(root, "decoy");
    mkdirSync(decoy);
    writeFileSync(join(decoy, "settings.local.json"), JSON.stringify({ sessionsByServer: { local: { agentId: AGENT, conversationId: "local-conv-9" } } }));
    const silent = pane("w1:p1", null, owner.cwd);
    const peer = pane("w2:p1", "local-conv-9", other);
    expect(await lettaTranscriptFor(silent, [silent, peer], owner)).toBeNull();
    // the decoy is in place while the record is opened, and the real .letta is back once that record has been stat'ed
    let linked = false;
    let swaps = 0;
    const restore = (): void => {
      if (!linked) return;
      linked = false;
      renameSync(join(other, ".letta"), decoy);
      renameSync(join(root, "moved"), join(other, ".letta"));
    };
    const { open, stat } = fsp;
    const spies = [
      spyOn(fsp, "open").mockImplementation((async (path: fs.PathLike, ...rest: [never]) => {
        const at = String(path);
        if (!linked && swaps === 0 && (at.endsWith(".letta") || at.endsWith("settings.local.json"))) {
          swaps++;
          linked = true;
          renameSync(join(other, ".letta"), join(root, "moved"));
          renameSync(decoy, join(other, ".letta"));
        }
        return open(path, ...rest);
      }) as typeof fsp.open),
      spyOn(fsp, "stat").mockImplementation((async (path: fs.PathLike, ...rest: [never]) => {
        try { return await stat(path, ...rest); } finally { if (String(path).endsWith("settings.local.json")) restore(); }
      }) as typeof fsp.stat),
    ];
    try {
      expect(await lettaTranscriptFor(silent, [silent, peer], owner)).toBeNull();
    } finally { for (const spy of spies) spy.mockRestore(); restore(); }
    expect(swaps).toBe(1);
  });

  peerTest("a peer folder swapped for a link to a decoy while it is resolved, and put back before the record is read, still claims", async () => {
    const owner = setup(settingsAfterNew, now - 60_000, now);
    const other = join(root, "other");
    mkdirSync(join(other, ".letta"), { recursive: true });
    writeFileSync(join(other, ".letta", "settings.local.json"), settingsAfterNew);
    const decoy = join(root, "decoy");
    mkdirSync(join(decoy, ".letta"), { recursive: true });
    writeFileSync(join(decoy, ".letta", "settings.local.json"), JSON.stringify({ sessionsByServer: { local: { agentId: AGENT, conversationId: "local-conv-9" } } }));
    const silent = pane("w1:p1", null, owner.cwd);
    const peer = pane("w2:p1", "local-conv-9", other);
    expect(await lettaTranscriptFor(silent, [silent, peer], owner)).toBeNull();
    // the peer folder is a link to the decoy while it is first resolved, and the real folder is back before it is resolved again
    let swaps = 0;
    const { realpath } = fsp;
    const linking = spyOn(fsp, "realpath").mockImplementation((async (path: fs.PathLike, ...rest: [never]) => {
      if (String(path) !== other || swaps > 0) return realpath(path, ...rest);
      swaps++;
      renameSync(other, join(root, "moved"));
      symlinkSync(decoy, other);
      try { return await realpath(path, ...rest); } finally { rmSync(other); renameSync(join(root, "moved"), other); }
    }) as typeof fsp.realpath);
    try {
      expect(await lettaTranscriptFor(silent, [silent, peer], owner)).toBeNull();
    } finally { linking.mockRestore(); }
    expect(swaps).toBe(1);
  });

  peerTest("a peer folder that cannot be resolved may hide a record, so it claims; one known to be gone claims nothing", async () => {
    const owner = setup(settingsAfterNew, now - 60_000, now);
    const silent = pane("w1:p1", null, owner.cwd);
    const gone = pane("w2:p1", "local-conv-9", join(root, "gone"));
    // a folder that is not there has no record of its own
    expect(await lettaTranscriptFor(silent, [silent, gone], owner)).not.toBeNull();
    // one that cannot be resolved (no permission, an I/O error) may hide one
    const { realpath } = fsp;
    for (const code of ["EACCES", "EIO"]) {
      const failing = spyOn(fsp, "realpath").mockImplementation((async (path: fs.PathLike, ...rest: [never]) => {
        if (String(path) === join(root, "gone")) throw Object.assign(new Error(`${code}: cannot read the peer's folder`), { code });
        return realpath(path, ...rest);
      }) as typeof fsp.realpath);
      try { expect(await lettaTranscriptFor(silent, [silent, gone], owner)).toBeNull(); } finally { failing.mockRestore(); }
    }
  });

  peerTest("a peer folder that never answers is taken for a claim, not waited on", async () => {
    const owner = setup(settingsAfterNew, now - 60_000, now);
    const other = join(root, "other");
    mkdirSync(other);
    const silent = pane("w1:p1", null, owner.cwd);
    const peer = pane("w2:p1", "local-conv-9", other);
    expect(await lettaTranscriptFor(silent, [silent, peer], owner)).not.toBeNull();
    // a peer folder on a mount that never answers: past the deadline its check is a claim, and the pane binds nothing
    const { realpath } = fsp;
    const hanging = spyOn(fsp, "realpath").mockImplementation(((path: fs.PathLike, ...rest: [never]) =>
      String(path) === other ? new Promise<string>(() => {}) : realpath(path, ...rest)) as typeof fsp.realpath);
    const deadline = lettaStore.peerClaimDeadline.ms;
    lettaStore.peerClaimDeadline.ms = 0;
    try { expect(await lettaTranscriptFor(silent, [silent, peer], owner)).toBeNull(); } finally { lettaStore.peerClaimDeadline.ms = deadline; hanging.mockRestore(); }
  });

  test("a peer folder whose earlier check still waits past its deadline claims at once, starting no other check there", async () => {
    const owner = setup(settingsAfterNew, now - 60_000, now);
    const away = join(root, "away");
    mkdirSync(away);
    const target = pane("w1:p1", "local-conv-1", owner.cwd);
    const peer = pane("w2:p1", "local-conv-9", away);
    // a mount that answers only when the test says so: each check left waiting would hold a slot of Bun's fs pool
    const answer = Promise.withResolvers<string>();
    let asked = 0;
    const { realpath } = fsp;
    const hanging = spyOn(fsp, "realpath").mockImplementation(((path: fs.PathLike, ...rest: [never]) => {
      if (String(path) !== away) return realpath(path, ...rest);
      asked++;
      return answer.promise;
    }) as typeof fsp.realpath);
    const deadline = lettaStore.peerClaimDeadline.ms;
    lettaStore.peerClaimDeadline.ms = 0;
    try {
      expect(await lettaRecordOwned(target, [target, peer], owner)).toBe(false);
      expect(await lettaRecordOwned(target, [target, peer], owner)).toBe(false);
      expect(asked).toBe(1);
      // once the mount answers, the folder is checked again
      answer.resolve(away);
      lettaStore.peerClaimDeadline.ms = deadline;
      expect(await lettaRecordOwned(target, [target, peer], owner)).toBe(true);
      expect(asked).toBe(2);
    } finally { lettaStore.peerClaimDeadline.ms = deadline; hanging.mockRestore(); }
  });

  peerTest("a peer record that is not a regular file, or is too large to read, claims", async () => {
    const owner = setup(settingsAfterNew, now - 60_000, now);
    const other = join(root, "other");
    mkdirSync(join(other, ".letta"), { recursive: true });
    const silent = pane("w1:p1", null, owner.cwd);
    const peer = pane("w2:p1", "local-conv-9", other);
    expect(await lettaTranscriptFor(silent, [silent, peer], owner)).not.toBeNull();
    const record = join(other, ".letta", "settings.local.json");
    mkdirSync(record);
    expect(await lettaTranscriptFor(silent, [silent, peer], owner)).toBeNull();
    rmSync(record, { recursive: true });
    writeFileSync(record, " ".repeat(256 * 1024 + 1));
    expect(await lettaTranscriptFor(silent, [silent, peer], owner)).toBeNull();
  });

  peerTest("the pane's own record rewritten while a peer's record is read binds nothing", async () => {
    const owner = setup(settingsAfterNew, now - 60_000, now);
    const other = join(root, "other");
    mkdirSync(join(other, ".letta"), { recursive: true });
    writeFileSync(join(other, ".letta", "settings.local.json"), JSON.stringify({ sessionsByServer: { local: { agentId: AGENT, conversationId: "local-conv-9" } } }));
    const silent = pane("w1:p1", null, owner.cwd);
    const peers = [silent, pane("w2:p1", "local-conv-9", other)];
    expect(await lettaTranscriptFor(silent, peers, owner)).not.toBeNull();
    const reached = Promise.withResolvers<void>();
    const gate = Promise.withResolvers<void>();
    const { open } = fsp;
    const opening = spyOn(fsp, "open").mockImplementation((async (path: fs.PathLike, ...rest: [never]) => {
      if (String(path).endsWith("settings.local.json")) { reached.resolve(); await gate.promise; }
      return open(path, ...rest);
    }) as typeof fsp.open);
    try {
      const result = lettaTranscriptFor(silent, peers, owner);
      await reached.promise;
      // the pane's letta switches conversation (a /new) while the peer's record is still being read
      writeFileSync(join(owner.cwd, ".letta", "settings.local.json"), JSON.stringify({ sessionsByServer: { local: { agentId: AGENT, conversationId: "local-conv-2" } } }));
      gate.resolve();
      expect(await result).toBeNull();
    } finally { opening.mockRestore(); }
  });

  peerTest("a peer's .letta swapped for a decoy just as its record is opened, and put back at once, is still not read as its own", async () => {
    const owner = setup(settingsAfterNew, now - 60_000, now);
    const other = join(root, "other");
    mkdirSync(join(other, ".letta"), { recursive: true });
    writeFileSync(join(other, ".letta", "settings.local.json"), settingsAfterNew);
    const decoy = join(root, "decoy");
    mkdirSync(decoy);
    writeFileSync(join(decoy, "settings.local.json"), JSON.stringify({ sessionsByServer: { local: { agentId: AGENT, conversationId: "local-conv-9" } } }));
    const silent = pane("w1:p1", null, owner.cwd);
    const peer = pane("w2:p1", "local-conv-9", other);
    expect(await lettaTranscriptFor(silent, [silent, peer], owner)).toBeNull();
    // the decoy stands only while the .letta or the record is opened: every folder is the real one again before and after
    let swaps = 0;
    const { open } = fsp;
    const opening = spyOn(fsp, "open").mockImplementation((async (path: fs.PathLike, ...rest: [never]) => {
      const at = String(path);
      if (swaps > 0 || !(at.endsWith(".letta") || at.endsWith("settings.local.json"))) return open(path, ...rest);
      swaps++;
      renameSync(join(other, ".letta"), join(root, "moved"));
      renameSync(decoy, join(other, ".letta"));
      try { return await open(path, ...rest); } finally {
        renameSync(join(other, ".letta"), decoy);
        renameSync(join(root, "moved"), join(other, ".letta"));
      }
    }) as typeof fsp.open);
    try {
      expect(await lettaTranscriptFor(silent, [silent, peer], owner)).toBeNull();
    } finally { opening.mockRestore(); }
    expect(swaps).toBe(1);
  });

  peerTest("a peer's record itself swapped for a decoy just as it is opened, and put back at once, is still not read as its own", async () => {
    const owner = setup(settingsAfterNew, now - 60_000, now);
    const other = join(root, "other");
    const record = join(other, ".letta", "settings.local.json");
    mkdirSync(join(other, ".letta"), { recursive: true });
    writeFileSync(record, settingsAfterNew);
    const decoy = join(other, ".letta", "decoy.json");
    writeFileSync(decoy, JSON.stringify({ sessionsByServer: { local: { agentId: AGENT, conversationId: "local-conv-9" } } }));
    const silent = pane("w1:p1", null, owner.cwd);
    const peer = pane("w2:p1", "local-conv-9", other);
    expect(await lettaTranscriptFor(silent, [silent, peer], owner)).toBeNull();
    // the folders stay the real ones throughout: only the record file stands swapped while it is opened
    let swaps = 0;
    const { open } = fsp;
    const opening = spyOn(fsp, "open").mockImplementation((async (path: fs.PathLike, ...rest: [never]) => {
      if (swaps > 0 || !String(path).endsWith("settings.local.json")) return open(path, ...rest);
      swaps++;
      renameSync(record, join(other, ".letta", "real.json"));
      renameSync(decoy, record);
      try { return await open(path, ...rest); } finally {
        renameSync(record, decoy);
        renameSync(join(other, ".letta", "real.json"), record);
      }
    }) as typeof fsp.open);
    try {
      expect(await lettaTranscriptFor(silent, [silent, peer], owner)).toBeNull();
    } finally { opening.mockRestore(); }
    expect(swaps).toBe(1);
  });

  peerTest("a peer's record swapped for a decoy as it is opened, and gone from its path before it is checked, is still a claim", async () => {
    const owner = setup(settingsAfterNew, now - 60_000, now);
    const other = join(root, "other");
    const record = join(other, ".letta", "settings.local.json");
    mkdirSync(join(other, ".letta"), { recursive: true });
    writeFileSync(record, settingsAfterNew);
    const decoy = join(other, ".letta", "decoy.json");
    writeFileSync(decoy, JSON.stringify({ sessionsByServer: { local: { agentId: AGENT, conversationId: "local-conv-9" } } }));
    const silent = pane("w1:p1", null, owner.cwd);
    const peer = pane("w2:p1", "local-conv-9", other);
    expect(await lettaTranscriptFor(silent, [silent, peer], owner)).toBeNull();
    // the decoy is opened in the record's place, then nothing stands at the record's path when it is checked after the read
    let swaps = 0;
    const { open } = fsp;
    const opening = spyOn(fsp, "open").mockImplementation((async (path: fs.PathLike, ...rest: [never]) => {
      if (swaps > 0 || !String(path).endsWith("settings.local.json")) return open(path, ...rest);
      swaps++;
      renameSync(record, join(other, ".letta", "real.json"));
      renameSync(decoy, record);
      try { return await open(path, ...rest); } finally { renameSync(record, decoy); }
    }) as typeof fsp.open);
    try {
      expect(await lettaTranscriptFor(silent, [silent, peer], owner)).toBeNull();
    } finally { opening.mockRestore(); renameSync(join(other, ".letta", "real.json"), record); }
    expect(swaps).toBe(1);
  });

  peerTest("a peer's .letta gone just as it is opened, or a file in its place, and back at once, is still a claim", async () => {
    const owner = setup(settingsAfterNew, now - 60_000, now);
    const other = join(root, "other");
    mkdirSync(join(other, ".letta"), { recursive: true });
    writeFileSync(join(other, ".letta", "settings.local.json"), settingsAfterNew);
    const silent = pane("w1:p1", null, owner.cwd);
    const peer = pane("w2:p1", "local-conv-9", other);
    expect(await lettaTranscriptFor(silent, [silent, peer], owner)).toBeNull();
    // the open finds nothing (ENOENT), or a file where the folder was (ENOTDIR), and the .letta is back right after it
    for (const stand of ["nothing", "file"] as const) {
      let swaps = 0;
      const { open } = fsp;
      const opening = spyOn(fsp, "open").mockImplementation((async (path: fs.PathLike, ...rest: [never]) => {
        const at = String(path);
        if (swaps > 0 || !(at.endsWith(".letta") || at.endsWith("settings.local.json"))) return open(path, ...rest);
        swaps++;
        renameSync(join(other, ".letta"), join(root, "moved"));
        if (stand === "file") writeFileSync(join(other, ".letta"), "");
        try { return await open(path, ...rest); } finally {
          rmSync(join(other, ".letta"), { force: true });
          renameSync(join(root, "moved"), join(other, ".letta"));
        }
      }) as typeof fsp.open);
      try {
        expect(await lettaTranscriptFor(silent, [silent, peer], owner)).toBeNull();
      } finally { opening.mockRestore(); }
      expect(swaps).toBe(1);
    }
    // one still gone after the open claims nothing
    rmSync(join(other, ".letta"), { recursive: true });
    expect(await lettaTranscriptFor(silent, [silent, peer], owner)).not.toBeNull();
  });

  peerTest("a peer's record rewritten in place while it is read is still a claim: a short read, a new size, a new mtime or new bytes alone", async () => {
    const owner = setup(settingsAfterNew, now - 60_000, now);
    const other = join(root, "other");
    const record = join(other, ".letta", "settings.local.json");
    mkdirSync(join(other, ".letta"), { recursive: true });
    const names = (conversation: string, pad = ""): string => JSON.stringify({ sessionsByServer: { local: { agentId: AGENT, conversationId: conversation } } }) + pad;
    const written = (now - 30_000) / 1000;
    const silent = pane("w1:p1", null, owner.cwd);
    const peer = pane("w2:p1", "local-conv-9", other);
    // the peer's Letta rewrites its record in place (same file) while it is read: what was read is not what it names now
    const rewrites: Record<string, (read: () => Promise<unknown>) => Promise<unknown>> = {
      // read while truncated, then the same bytes and mtime again: only the short read shows it
      short: async (read) => {
        writeFileSync(record, "");
        try { return await read(); } finally { writeFileSync(record, names("local-conv-1")); utimesSync(record, written, written); }
      },
      // the old record read whole, then one naming the conversation, longer, at the same mtime
      size: async (read) => {
        try { return await read(); } finally { writeFileSync(record, names("local-conv-1", " ")); utimesSync(record, written, written); }
      },
      // the old record read whole, then one naming the conversation, as long, at a later mtime
      mtime: async (read) => {
        try { return await read(); } finally { writeFileSync(record, names("local-conv-1")); utimesSync(record, written + 1, written + 1); }
      },
      // the old record read whole, then one naming the conversation, as long, with its mtime put back (or too coarse to move)
      bytes: async (read) => {
        try { return await read(); } finally { writeFileSync(record, names("local-conv-1")); utimesSync(record, written, written); }
      },
    };
    for (const [shape, rewrite] of Object.entries(rewrites)) {
      writeFileSync(record, shape === "short" ? names("local-conv-1") : names("local-conv-9"));
      utimesSync(record, written, written);
      if (shape !== "short") expect(await lettaTranscriptFor(silent, [silent, peer], owner)).not.toBeNull();
      let rewritten = 0;
      const { open } = fsp;
      const opening = spyOn(fsp, "open").mockImplementation((async (path: fs.PathLike, ...rest: [never]) => {
        const handle = await open(path, ...rest);
        if (rewritten > 0 || !String(path).endsWith("settings.local.json")) return handle;
        const read = handle.read.bind(handle) as (...args: unknown[]) => Promise<unknown>;
        // only the first read races the rewrite: a later one reads the record as it stands
        Object.assign(handle, { read: (...args: unknown[]) => rewritten > 0 ? read(...args) : (rewritten++, rewrite(() => read(...args))) });
        return handle;
      }) as typeof fsp.open);
      try {
        expect(await lettaTranscriptFor(silent, [silent, peer], owner)).toBeNull();
      } finally { opening.mockRestore(); }
      expect([shape, rewritten]).toEqual([shape, 1]);
    }
  });

  peerTest("a peer record that does not read as one Letta writes claims: empty, cut short, malformed, another shape, or emptied mid-write", async () => {
    const owner = setup(settingsAfterNew, now - 60_000, now);
    const other = join(root, "other");
    const record = join(other, ".letta", "settings.local.json");
    mkdirSync(join(other, ".letta"), { recursive: true });
    const names = (conversation: string): string => JSON.stringify({ sessionsByServer: { local: { agentId: AGENT, conversationId: conversation } } });
    const silent = pane("w1:p1", null, owner.cwd);
    const peer = pane("w2:p1", "local-conv-9", other);
    writeFileSync(record, names("local-conv-9"));
    expect(await lettaTranscriptFor(silent, [silent, peer], owner)).not.toBeNull();
    const cut = names("local-conv-1").slice(0, 40);
    for (const text of ["", cut, "{not json", JSON.stringify({ sessionsByServer: { local: "local-conv-1" } })]) {
      writeFileSync(record, text);
      expect([text, await lettaTranscriptFor(silent, [silent, peer], owner)]).toEqual([text, null]);
    }
    // the peer's Letta rewrites its record in place: truncated as it is opened, and written whole only after the check
    writeFileSync(record, names("local-conv-9"));
    let emptied = 0;
    const { open } = fsp;
    const opening = spyOn(fsp, "open").mockImplementation((async (path: fs.PathLike, ...rest: [never]) => {
      if (emptied === 0 && String(path).endsWith("settings.local.json")) { emptied++; writeFileSync(record, ""); }
      return open(path, ...rest);
    }) as typeof fsp.open);
    try {
      expect(await lettaTranscriptFor(silent, [silent, peer], owner)).toBeNull();
    } finally { opening.mockRestore(); writeFileSync(record, names("local-conv-1")); }
    expect(emptied).toBe(1);
  });

  peerTest("a peer folder or .letta gone while it is resolved, and back before that failure is seen, is still a claim", async () => {
    const owner = setup(settingsAfterNew, now - 60_000, now);
    const other = join(root, "other");
    mkdirSync(join(other, ".letta"), { recursive: true });
    writeFileSync(join(other, ".letta", "settings.local.json"), settingsAfterNew);
    const silent = pane("w1:p1", null, owner.cwd);
    const peer = pane("w2:p1", "local-conv-9", other);
    expect(await lettaTranscriptFor(silent, [silent, peer], owner)).toBeNull();
    // the folder as it is resolved, then its .letta as the chain of folders is read: each moved away for that one call
    // (a real ENOENT), and back before the call rejects
    const { realpath, lstat } = fsp;
    let fails = 0;
    /** `call` with `away` moved off for its length, the first time the path wanted is asked for. */
    const goneOnce = async <T>(wanted: boolean, away: string, call: () => Promise<T>): Promise<T> => {
      if (fails > 0 || !wanted) return call();
      fails++;
      renameSync(away, join(root, "moved"));
      try { return await call(); } finally { renameSync(join(root, "moved"), away); }
    };
    const stages = {
      realpath: () => spyOn(fsp, "realpath").mockImplementation((async (path: fs.PathLike, ...rest: [never]) =>
        goneOnce(String(path) === other, other, () => realpath(path, ...rest))) as typeof fsp.realpath),
      folderChain: () => spyOn(fsp, "lstat").mockImplementation((async (path: fs.PathLike, ...rest: [never]) =>
        goneOnce(String(path).endsWith(join("other", ".letta")), join(other, ".letta"), () => lstat(path, ...rest))) as typeof fsp.lstat),
    };
    for (const [stage, mock] of Object.entries(stages)) {
      fails = 0;
      const failing = mock();
      try {
        expect(await lettaTranscriptFor(silent, [silent, peer], owner)).toBeNull();
      } finally { failing.mockRestore(); }
      expect([stage, fails]).toEqual([stage, 1]);
    }
  });

  peerTest("a peer record that fails once it is open claims, as does a file standing where a peer folder should be", async () => {
    const owner = setup(settingsAfterNew, now - 60_000, now);
    const other = join(root, "other");
    mkdirSync(join(other, ".letta"), { recursive: true });
    writeFileSync(join(other, ".letta", "settings.local.json"), JSON.stringify({ sessionsByServer: { local: { agentId: AGENT, conversationId: "local-conv-9" } } }));
    const silent = pane("w1:p1", null, owner.cwd);
    const peer = pane("w2:p1", "local-conv-9", other);
    expect(await lettaTranscriptFor(silent, [silent, peer], owner)).not.toBeNull();
    // the record opened, then its .letta removed and the read failing for it: what it held was never read
    let failed = 0;
    const { open } = fsp;
    const opening = spyOn(fsp, "open").mockImplementation((async (path: fs.PathLike, ...rest: [never]) => {
      const handle = await open(path, ...rest);
      if (failed > 0 || !String(path).endsWith("settings.local.json")) return handle;
      Object.assign(handle, { read: async () => {
        failed++;
        rmSync(join(other, ".letta"), { recursive: true });
        throw Object.assign(new Error("ENOENT: the record went away mid-read"), { code: "ENOENT" });
      } });
      return handle;
    }) as typeof fsp.open);
    try {
      expect(await lettaTranscriptFor(silent, [silent, peer], owner)).toBeNull();
    } finally { opening.mockRestore(); }
    expect(failed).toBe(1);
    // a file where the peer's folder, or a folder above it, should be (ENOTDIR) is something there, not absence
    rmSync(other, { recursive: true });
    writeFileSync(other, "");
    for (const cwd of [other, join(other, "sub")]) {
      const standing = pane("w2:p1", "local-conv-9", cwd);
      expect([cwd, await lettaTranscriptFor(silent, [silent, standing], owner)]).toEqual([cwd, null]);
    }
  });

  test("a record Letta cannot rewrite binds nothing: its switch would fail and leave the old one standing", async () => {
    const owner = setup(settingsAfterNew, now - 60_000, now);
    const target = pane("w1:p1", "local-conv-1", owner.cwd);
    expect(await lettaTranscriptFor(target, [target], owner)).not.toBeNull();
    chmodSync(join(owner.cwd, ".letta", "settings.local.json"), 0o444);
    expect(await lettaTranscriptFor(target, [target], owner)).toBeNull();
  });

  test("a letta process is bound only in the folder it started in, and never again once seen elsewhere", () => {
    const start = join(root, "project1");
    const other = join(root, "project2");
    mkdirSync(start); mkdirSync(other);
    symlinkSync(start, join(root, "link1"));
    const at = (pid: number, cwd: string, env: Record<string, string>, startedAt = now): LettaProcess => ({ pid, cwd, startedAt, startedBy: startedAt, identity: now, env, argv: ["letta"] });
    expect(lettaInStartFolder(at(101, start, { PWD: start }))).toBe(true);
    expect(lettaInStartFolder(at(102, start, { PWD: join(root, "link1") }))).toBe(true);
    // no start folder to compare: its shell set no PWD
    expect(lettaInStartFolder(at(103, start, {}))).toBe(false);
    expect(lettaInStartFolder(at(104, start, { PWD: "relative" }))).toBe(false);
    // SetWorkingDirectory moved it into project2; a later move back does not make project1's record its own again
    expect(lettaInStartFolder(at(105, other, { PWD: start }))).toBe(false);
    expect(lettaInStartFolder(at(105, start, { PWD: start }))).toBe(false);
    // the lower bound read differently on its return (a stepped wall clock moves it on Linux): still the same process
    expect(lettaInStartFolder(at(106, other, { PWD: start }))).toBe(false);
    expect(lettaInStartFolder(at(106, start, { PWD: start }, now - 1_000))).toBe(false);
  });

  test("a closed peer of the same agent that reopened the pane's old conversation binds nothing", async () => {
    // A started on local-conv-1 (herdr keeps that report), switched to local-conv-2; B opened local-conv-1 and closed.
    // Every write was A's own or B's after A started, and the record names local-conv-1 again.
    const owner = setup(JSON.stringify({ sessionsByServer: { local: { agentId: AGENT, conversationId: "local-conv-1" } } }), now + 4_000, now);
    const store = join(root, ".letta", "lc-local-backend");
    const folder = join(store, "conversations", Buffer.from("conversation:local-conv-1").toString("base64url"));
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, "conversation.json"), localConversation);
    expect(lettaLocalOwner(store, AGENT, "local-conv-1")).toBe(true);
    const a = pane("w1:p1", "local-conv-1", owner.cwd);
    expect(await lettaRecordOwned(a, [a], owner)).toBe(true);
    expect(await lettaTranscriptFor(a, [a], owner)).toBeNull();
  });

  test("a missing, malformed or partly unreadable project record binds nothing, whatever the global settings say", async () => {
    mkdirSync(join(root, ".letta"), { recursive: true });
    writeFileSync(join(root, ".letta", "settings.json"), settingsAfterNew);
    for (const settings of [null, "{", "[]", JSON.stringify({ sessionsByServer: { a: { agentId: AGENT, conversationId: "local-conv-1" }, b: { agentId: 3 } } })]) {
      rmSync(join(root, "proj"), { recursive: true, force: true });
      const owner = setup(settings, now - 60_000, now);
      expect(await lettaTranscriptFor(pane("w1:p1", "local-conv-1", owner.cwd), [], owner)).toBeNull();
    }
  });

  test("the transcript is where the pane's process keeps it, never where this server would", async () => {
    const own = setup(settingsAfterNew, now - 60_000, now, { LETTA_TRANSCRIPT_ROOT: join(root, "elsewhere") });
    const target = pane("w1:p1", "local-conv-1", own.cwd);
    expect((await lettaTranscriptFor(target, [target], own))?.path).toBe(lettaTranscriptPath(join(root, "elsewhere"), AGENT, "local-conv-1"));
    expect((await lettaTranscriptFor(target, [target], { ...own, env: { HOME: root, LETTA_CONFIG_DIR: join(root, "cfg") } }))?.path).toBe(lettaTranscriptPath(join(root, "cfg", "transcripts"), AGENT, "local-conv-1"));
    expect(await lettaTranscriptFor(target, [target], { ...own, env: { LETTA_TRANSCRIPT_ROOT: "relative" } })).toBeNull();
    expect(await lettaTranscriptFor(target, [target], { ...own, env: {} })).toBeNull();
    expect(await lettaTranscriptFor(target, [target, pane("w2:p1", "local-conv-1", own.cwd)], own)).toBeNull();
  });

  test("the record speaks for nobody in the home folder, or while another pane runs Letta in the same folder", async () => {
    const owner = setup(settingsAfterNew, now - 60_000, now);
    const target = pane("w1:p1", "local-conv-1", owner.cwd);
    expect(await lettaRecordOwned(target, [target], owner)).toBe(true);
    // Letta with LETTA_CONFIG_DIR never rewrites ~/.letta/settings.local.json: an old one there is no record of this process
    expect(await lettaRecordOwned(target, [target], { ...owner, cwd: root, env: { HOME: root, LETTA_CONFIG_DIR: join(root, "cfg") } })).toBe(false);
    expect(await lettaRecordOwned(target, [target], { ...owner, cwd: root })).toBe(false);
    expect(await lettaRecordOwned(target, [target], { ...owner, env: {} })).toBe(false);
    // pane B reported default:agent-b, then /new wrote its own local-conv-1 into the shared record
    symlinkSync(owner.cwd, join(root, "link"));
    const peer = { ...pane("w2:p1", "default:agent-local-b", join(root, "link")), cwd: join(root, "elsewhere") } as HerdrPane;
    expect(await lettaRecordOwned(target, [target, peer], owner)).toBe(false);
    expect(await lettaRecordOwned(target, [target, { ...peer, agent: "letta", agent_session: undefined } as HerdrPane], owner)).toBe(false);
    expect(await lettaRecordOwned(target, [target, { ...peer, agent: "claude", agent_session: undefined } as HerdrPane], owner)).toBe(true);
    expect(await lettaRecordOwned(target, [target, pane("w3:p1", "conv-x", root)], owner)).toBe(true);
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
    const resolution = spyOn(lettaStore, "resolveLettaTranscript").mockResolvedValue({ path, session: "local-conv-1", agent: AGENT, conversation: "local-conv-1", store: store(), startedAt: Date.now() });
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

  peerTest("the pane's letta is asked again once the peer folders answer: exited or moved meanwhile, it binds nothing", async () => {
    const project = join(root, "proj");
    const other = join(root, "other");
    const config = join(root, "config");
    for (const [folder, conversation] of [[project, "local-conv-1"], [other, "local-conv-9"]] as const) {
      mkdirSync(join(folder, ".letta"), { recursive: true });
      writeFileSync(join(folder, ".letta", "settings.local.json"), JSON.stringify({ sessionsByServer: { local: { agentId: AGENT, conversationId: conversation } } }));
      // written before the pane's letta started, as Letta leaves it when it resumes that conversation
      utimesSync(join(folder, ".letta", "settings.local.json"), (now - 60_000) / 1000, (now - 60_000) / 1000);
    }
    // a real process named as Letta's entry: herdr's answer about the pane has a pid whose start and environment are read
    const script = join(root, "bin", "letta");
    mkdirSync(join(root, "bin"));
    writeFileSync(script, "process.stdout.write(\"ready\\n\");\nsetInterval(() => {}, 60_000);\n");
    const argv = [process.execPath, script];
    const child = Bun.spawn(argv, { env: { HOME: root, PWD: project, LETTA_CONFIG_DIR: config, PATH: process.env["PATH"] ?? "" }, cwd: project, stdout: "pipe" });
    // the script runs, so the pid's live command line and environment are its own, not those of the runner it was forked from
    await child.stdout.getReader().read();
    // the store's record of the conversation, and the transcript the process's own use of it proves
    const record = join(config, "lc-local-backend", "conversations", Buffer.from("conversation:local-conv-1").toString("base64url"));
    mkdirSync(record, { recursive: true });
    writeFileSync(join(record, "conversation.json"), localConversation);
    const path = lettaTranscriptPath(join(config, "transcripts"), AGENT, "local-conv-1");
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, newLog);
    utimesSync(path, (Date.now() + 5_000) / 1000, (Date.now() + 5_000) / 1000);
    let reported: { pid: number; cwd: string } | null = { pid: child.pid, cwd: project };
    const info = spyOn(herdr, "paneProcessInfo").mockImplementation((async () => ({
      pane_id: "w1:p1", foreground_processes: reported === null ? [] : [{ pid: reported.pid, argv, cwd: reported.cwd }],
    })) as never);
    const silent = pane("w1:p1", null, project);
    const peer = pane("w2:p1", "local-conv-9", other);
    try {
      expect(await resolveLettaTranscript(silent, [silent, peer])).not.toBeNull();
      // the peer's folder is opened, its record still to be read, while the pane's letta goes: exited, or moved elsewhere
      const during = async (now: { pid: number; cwd: string } | null): Promise<Awaited<ReturnType<typeof resolveLettaTranscript>>> => {
        const reached = Promise.withResolvers<void>();
        const gate = Promise.withResolvers<void>();
        let held = 0;
        reported = { pid: child.pid, cwd: project };
        const { open } = fsp;
        const opening = spyOn(fsp, "open").mockImplementation((async (path: fs.PathLike, ...rest: [never]) => {
          if (held === 0 && String(path).startsWith(other)) { held++; reached.resolve(); await gate.promise; }
          return open(path, ...rest);
        }) as typeof fsp.open);
        try {
          const resolving = resolveLettaTranscript(silent, [silent, peer]);
          await reached.promise;
          reported = now;
          gate.resolve();
          return await resolving;
        } finally { opening.mockRestore(); }
      };
      expect(await during(null)).toBeNull();
      expect(await during({ pid: child.pid, cwd: other })).toBeNull();
    } finally {
      info.mockRestore();
      child.kill();
      await child.exited;
    }
  });

  /**
   * A real process running as the pane's letta in `proj`, with the record, store and transcript it leaves (the
   * transcript written since it started), and herdr's answers about the pane, counted. `stop` ends it.
   */
  const lettaRunning = async (): Promise<{ project: string; asked: () => number; stop: () => Promise<void> }> => {
    const project = join(root, "proj");
    const config = join(root, "config");
    mkdirSync(join(project, ".letta"), { recursive: true });
    writeFileSync(join(project, ".letta", "settings.local.json"), settingsAfterNew);
    utimesSync(join(project, ".letta", "settings.local.json"), (now - 60_000) / 1000, (now - 60_000) / 1000);
    const script = join(root, "bin", "letta");
    mkdirSync(join(root, "bin"));
    writeFileSync(script, "process.stdout.write(\"ready\\n\");\nsetInterval(() => {}, 60_000);\n");
    const argv = [process.execPath, script];
    const child = Bun.spawn(argv, { env: { HOME: root, PWD: project, LETTA_CONFIG_DIR: config, PATH: process.env["PATH"] ?? "" }, cwd: project, stdout: "pipe" });
    // the script runs, so the pid's live command line and environment are its own, not those of the runner it was forked from
    await child.stdout.getReader().read();
    const record = join(config, "lc-local-backend", "conversations", Buffer.from("conversation:local-conv-1").toString("base64url"));
    mkdirSync(record, { recursive: true });
    writeFileSync(join(record, "conversation.json"), localConversation);
    const path = lettaTranscriptPath(join(config, "transcripts"), AGENT, "local-conv-1");
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, newLog);
    utimesSync(path, (Date.now() + 5_000) / 1000, (Date.now() + 5_000) / 1000);
    let asked = 0;
    const info = spyOn(herdr, "paneProcessInfo").mockImplementation((async () => {
      asked++;
      return { pane_id: "w1:p1", foreground_processes: [{ pid: child.pid, argv, cwd: project }] };
    }) as never);
    return { project, asked: () => asked, stop: async () => { info.mockRestore(); child.kill(); await child.exited; } };
  };

  test("a peer folder whose path never resolves leaves the pane unbound once the deadline passes, not waiting on it", async () => {
    const letta = await lettaRunning();
    const away = join(root, "away");
    mkdirSync(away);
    // a reported conversation: only the check that no peer runs Letta in the same folder resolves the peer's path
    const target = pane("w1:p1", "local-conv-1", letta.project);
    const peer = pane("w2:p1", "local-conv-9", away);
    const { realpath } = fsp;
    const deadline = lettaStore.peerClaimDeadline.ms;
    try {
      expect(await resolveLettaTranscript(target, [target, peer])).not.toBeNull();
      // a peer folder on a mount that never answers: it may be this very folder, so past the deadline the record is not this pane's
      const hanging = spyOn(fsp, "realpath").mockImplementation(((path: fs.PathLike, ...rest: [never]) =>
        String(path) === away ? new Promise<string>(() => {}) : realpath(path, ...rest)) as typeof fsp.realpath);
      lettaStore.peerClaimDeadline.ms = 0;
      try { expect(await resolveLettaTranscript(target, [target, peer])).toBeNull(); } finally { hanging.mockRestore(); }
    } finally {
      lettaStore.peerClaimDeadline.ms = deadline;
      await letta.stop();
    }
  });

  test("herdr is asked about the pane's letta again only when peer folders were waited on", async () => {
    const letta = await lettaRunning();
    const silent = pane("w1:p1", null, letta.project);
    const other = join(root, "other");
    mkdirSync(other);
    try {
      expect(await resolveLettaTranscript(silent, [silent])).not.toBeNull();
      expect(letta.asked()).toBe(1);
      expect(await resolveLettaTranscript(silent, [silent, pane("w2:p1", "local-conv-9", other)])).not.toBeNull();
      expect(letta.asked()).toBe(3);
    } finally { await letta.stop(); }
  });

  test("a bound pane reads the transcript its letta process keeps; without one, or unbound, it uses Terminal", async () => {
    const project = join(root, "proj");
    mkdirSync(join(project, ".letta"), { recursive: true });
    writeFileSync(join(project, ".letta", "settings.local.json"), settingsAfterNew);
    // written before the pane's letta started, as Letta leaves it when it resumes that conversation
    utimesSync(join(project, ".letta", "settings.local.json"), (Date.now() - 60_000) / 1000, (Date.now() - 60_000) / 1000);
    const config = join(root, "config");
    // a real process whose own environment names the store, as the pane's letta would
    // a script named as Letta's entry, which the pane's runtime runs as a letta would, so its live command line is the reported one
    const script = join(root, "bin", "letta");
    mkdirSync(join(root, "bin"));
    writeFileSync(script, "setInterval(() => {}, 60_000);\n");
    const lettaArgv = [process.execPath, script];
    const child = Bun.spawn(lettaArgv, { env: { HOME: root, PWD: project, LETTA_CONFIG_DIR: config, PATH: process.env["PATH"] ?? "" }, cwd: project });
    // the same process after SetWorkingDirectory moved it from project1 into this project: its environment keeps project1
    mkdirSync(join(root, "project1"));
    const movedIn = Bun.spawn(lettaArgv, { env: { HOME: root, PWD: join(root, "project1"), LETTA_CONFIG_DIR: config, PATH: process.env["PATH"] ?? "" }, cwd: project });
    let foreground = child.pid;
    const info = spyOn(herdr, "paneProcessInfo").mockImplementation(async () => ({
      pane_id: "w1:p1", foreground_processes: [{ pid: foreground, argv: lettaArgv, cwd: project }],
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
      // no report at all (herdr-core, or herdr without its Letta integration): Letta's record alone, once the
      // process has written its transcript provably after it started (the unit test above covers a write inside the start's uncertainty)
      utimesSync(path, (Date.now() + 2_000) / 1000, (Date.now() + 2_000) / 1000);
      expect(await resolve(pane("w1:p1", null, project))).toEqual({ source: "letta-transcript", path,
        letta: { store: join(config, "lc-local-backend"), agent: AGENT, conversation: "local-conv-1" } });
      // another pane running Letta in the folder writes the same record
      // project1 -> /new -> moved into this project, whose older record names the conversation it left
      foreground = movedIn.pid;
      await expect(resolve(bound)).rejects.toThrow("no_session_path");
      foreground = child.pid;
      expect(await resolve(bound)).toEqual({ source: "letta-transcript", path,
        letta: { store: join(config, "lc-local-backend"), agent: AGENT, conversation: "local-conv-1" } });
      // another Letta pane's folder, which may be on an unresponsive mount, is resolved off the event loop
      const away = join(root, "away");
      mkdirSync(away);
      const sync: string[] = [];
      const { realpathSync } = fs;
      const resolving = spyOn(fs, "realpathSync").mockImplementation(((path: fs.PathLike, ...rest: [never]) => { sync.push(String(path)); return realpathSync(path, ...rest); }) as typeof fs.realpathSync);
      try {
        expect(await paneTranscript(bound.pane_id, undefined, { panes: [bound, pane("w3:p1", "conv-x", away)] } as SessionSnapshot)).toMatchObject({ path });
      } finally { resolving.mockRestore(); }
      expect(sync.filter((at) => at.startsWith(away))).toEqual([]);
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
