import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { Database } from "bun:sqlite";
import * as fs from "node:fs";
import { appendFileSync, closeSync, mkdirSync, mkdtempSync, openSync, rmSync, statSync, symlinkSync, truncateSync, utimesSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { asCodexTitle, codexOpenRollout, codexTranscriptPath, limitCodexHistoryForTests } from "./codex.ts";
import * as processStart from "./process-start.ts";
import { processStartedAt } from "./process-start.ts";
import * as kiro from "./kiro-terminal.ts";
import { paneTranscript } from "./conversation.ts";
import type { SessionSnapshot } from "../shared/protocol.ts";

// Native stores and the real RPC client; only herdr's foreground metadata is synthetic.
// In particular, a real process supplies /proc/cmdline when that metadata omits argv.
const thread = "01a0c7a1-56d9-7e20-9f08-f7a2d973bc01";
const answer = "This specific native conversation belongs to the selected Codex process, not whichever session was updated last.";
let root: string;
let home: string;
let path: string;
let screen: string;
let peerScreens: Map<string, string | Error>;
let foreground: { pid: number; name?: string; argv?: string[] }[];
/** A pane's own foreground, where it is not [foreground]. */
let foregrounds: Map<string, { pid: number; name?: string; argv?: string[] }[]>;
let listener: ReturnType<typeof Bun.listen>;
let socketBefore: string | undefined;
/** The terminal title herdr reports for the pane (Codex's [tui].terminal_title), null for none. */
let title: string | null;
let unlabelled: boolean;
/** The pane's folders herdr reports. */
let agentFolders: { cwd?: string; foreground_cwd?: string };
/** The session herdr reports for the pane (agent.get), null for none. */
let reportedSession: { source: string; agent: string; kind: string; value: string } | null;
/** herdr's shell_pid for the pane, when a test says it (a Kiro wrapper is the shell herdr started). */
let shellPid: number | undefined;
/** The answers to the pane's next process reads, in order (null: herdr gives no process_info); [foreground] once used up. */
let processReads: ({ pid: number; name?: string; argv?: string[] }[] | null)[];
/** Which of the pane's own process reads (1 for the first) herdr answers with an error. */
let failedReads: Set<number>;
let ownReads: number;
const children: ReturnType<typeof Bun.spawn>[] = [];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ovis-codex-processes-"));
  home = join(root, "codex");
  mkdirSync(join(home, "sessions"), { recursive: true });
  path = join(home, "sessions", `rollout-${thread}.jsonl`);
  writeFileSync(path, [
    { type: "session_meta", payload: { id: thread, cwd: root } },
    { type: "event_msg", payload: { type: "agent_message", message: answer } },
  ].map((entry) => JSON.stringify(entry)).join("\n"));
  const db = new Database(join(home, "state_5.sqlite"));
  db.exec("CREATE TABLE threads (id TEXT, rollout_path TEXT, cwd TEXT, archived INTEGER, agent_role TEXT, created_at INTEGER, updated_at INTEGER, source TEXT)");
  db.query("INSERT INTO threads VALUES (?, ?, ?, 0, NULL, 1, 1, 'cli')").run(thread, path, root);
  db.close();
  screen = "";
  title = null;
  unlabelled = false;
  agentFolders = {};
  reportedSession = null;
  processReads = [];
  failedReads = new Set();
  ownReads = 0;
  shellPid = undefined;
  peerScreens = new Map();
  foreground = [];
  foregrounds = new Map();
  socketBefore = process.env["HERDR_SOCKET"];
  const socket = join(root, "herdr.sock");
  process.env["HERDR_SOCKET"] = socket;
  listener = Bun.listen<{ buffer: string }>({
    unix: socket,
    socket: {
      open(socket) { socket.data = { buffer: "" }; },
      data(socket, chunk) {
        socket.data.buffer += chunk.toString();
        if (!socket.data.buffer.includes("\n")) return;
        const request = JSON.parse(socket.data.buffer) as { id: string; method: string; params?: { pane_id?: string } };
        const peerScreen = peerScreens.get(request.params?.pane_id ?? "");
        if (request.method === "agent.get" && unlabelled) {
          socket.end(`${JSON.stringify({ id: request.id, error: { code: "agent_not_found", message: "outer shell" } })}\n`);
          return;
        }
        if (request.method === "pane.read" && peerScreen instanceof Error) {
          socket.end(`${JSON.stringify({ id: request.id, error: { code: "pane_not_found", message: peerScreen.message } })}\n`);
          return;
        }
        if (request.method === "pane.process_info" && request.params?.pane_id === root && failedReads.has(++ownReads)) {
          socket.end(`${JSON.stringify({ id: request.id, error: { code: "internal", message: "fixture failure" } })}\n`);
          return;
        }
        const own = request.method === "pane.process_info" && request.params?.pane_id === root && processReads.length > 0 ? processReads.shift() : undefined;
        const result = request.method === "pane.get" ? { pane: { pane_id: root, cwd: root } }
          : request.method === "agent.get" ? { agent: { ...agentFolders, ...(title === null ? {} : { terminal_title: title, terminal_title_stripped: title }), ...(reportedSession === null ? {} : { agent_session: reportedSession }) } }
          : request.method === "pane.process_info" ? (own === null ? {} : { process_info: { ...(shellPid === undefined || request.params?.pane_id !== root ? {} : { shell_pid: shellPid }), foreground_processes: own ?? foregrounds.get(request.params?.pane_id ?? "") ?? foreground } })
          : request.method === "pane.read" ? { read: { text: peerScreen ?? screen } }
          // the session as a background reader asks for it: this pane alone
          : request.method === "session.snapshot" ? { snapshot: { panes: [{ pane_id: root, workspace_id: root, tab_id: root, terminal_id: root, agent: "codex", agent_status: "working", cwd: root, focused: false, revision: 0 }], workspaces: [], tabs: [], layouts: [], agents: [] } }
          : null;
        if (result === null) throw new Error(`unexpected RPC ${request.method}`);
        socket.end(`${JSON.stringify({ id: request.id, result })}\n`);
      },
    },
  });
});

afterEach(async () => {
  for (const child of children.splice(0)) {
    child.kill();
    await child.exited;
  }
  listener.stop(true);
  if (socketBefore === undefined) delete process.env["HERDR_SOCKET"];
  else process.env["HERDR_SOCKET"] = socketBefore;
  rmSync(root, { recursive: true, force: true });
});

const resolve = () => codexTranscriptPath(root, root, home, [{
  pane_id: root, workspace_id: root, tab_id: root, terminal_id: root,
  agent: "codex", agent_status: "working", cwd: root, focused: false, revision: 0,
}]);

/** Kiro's wrapper checks as on macOS, where its Codex is proven: the real checks, with the platform pinned. */
function asOnMac() {
  const wrapper = kiro.kiroWrapper, nestedPane = kiro.kiroNested;
  const spies = [
    spyOn(kiro, "kiroWrapper").mockImplementation((info) => wrapper(info, "darwin")),
    spyOn(kiro, "kiroNested").mockImplementation((info, labelled) => nestedPane(info, labelled, "darwin")),
  ];
  return { mockRestore: () => { for (const spy of spies) spy.mockRestore(); } };
}

// A Chat poll hands its own process read to the lookup (#1879). The pane can change in between: what decides the
// store and the Kiro guard is the read made now (#2774).
const labelledSnapshot = () => ({ panes: [{
  pane_id: root, workspace_id: root, tab_id: root, terminal_id: root,
  agent: "codex", cwd: root, agent_status: "working", focused: false, revision: 0,
}], workspaces: [], tabs: [], agents: [], layouts: [], protocol: 1, version: "test" } satisfies SessionSnapshot);

it.skipIf(process.platform !== "linux")("shows no conversation of the store an earlier read's Codex keeps once another Codex runs there", async () => {
  // Given Codex A writing to this fixture's store, gone by the lookup, and Codex B started since with a store of its own
  const other = join(root, "other-store");
  mkdirSync(other, { recursive: true });
  const start = async (codexHome: string) => {
    const child = Bun.spawn(["/bin/bash", "-c", "echo READY; exec -a codex sleep 600"], { env: { ...process.env, CODEX_HOME: codexHome }, stdout: "pipe", stderr: "ignore" });
    children.push(child);
    expect(await firstLine(child.stdout)).toBe("READY\n");
    return child.pid;
  };
  const before = await start(home);
  foreground = [{ pid: await start(other), argv: ["codex"] }];
  agentFolders = { cwd: root };
  screen = answer;
  const defaultBefore = process.env["CODEX_HOME"];
  process.env["CODEX_HOME"] = join(root, "default-store");
  try {
    // When the poll's read named A
    const known = { foreground_processes: [{ pid: before, argv: ["codex"] }] };
    // Then B is not shown A's conversation, which its screen still matches
    await expect(paneTranscript(root, undefined, labelledSnapshot(), undefined, undefined, undefined, undefined, undefined, known as never)).rejects.toMatchObject({ message: "no_session_path" });
    // and a read that names B's store's Codex itself still resolves from that store
    foreground = [{ pid: before, argv: ["codex"] }];
    expect(await paneTranscript(root, undefined, labelledSnapshot(), undefined, undefined, undefined, undefined, undefined, known as never)).toMatchObject({ source: "codex-transcript", path });
  } finally {
    if (defaultBefore === undefined) delete process.env["CODEX_HOME"]; else process.env["CODEX_HOME"] = defaultBefore;
  }
});

it.skipIf(process.platform !== "linux")("shows no conversation of the store the lookup's first read chose once another Codex runs there", async () => {
  // Given the reads up to the one that chooses the store (omo's check, then paneCodexHomePlaced's) naming Codex A
  // (this fixture's store), and the reads after them Codex B
  const other = join(root, "other-store");
  mkdirSync(other, { recursive: true });
  const start = async (codexHome: string) => {
    const child = Bun.spawn(["/bin/bash", "-c", "echo READY; exec -a codex sleep 600"], { env: { ...process.env, CODEX_HOME: codexHome }, stdout: "pipe", stderr: "ignore" });
    children.push(child);
    expect(await firstLine(child.stdout)).toBe("READY\n");
    return child.pid;
  };
  const before = await start(home);
  processReads = [[{ pid: before, argv: ["codex"] }], [{ pid: before, argv: ["codex"] }]];
  foreground = [{ pid: await start(other), argv: ["codex"] }];
  agentFolders = { cwd: root };
  screen = answer;
  const defaultBefore = process.env["CODEX_HOME"];
  process.env["CODEX_HOME"] = join(root, "default-store");
  try {
    // Then B is not shown A's conversation, though no caller handed a read down
    await expect(paneTranscript(root, undefined, labelledSnapshot())).rejects.toMatchObject({ message: "no_session_path" });
  } finally {
    if (defaultBefore === undefined) delete process.env["CODEX_HOME"]; else process.env["CODEX_HOME"] = defaultBefore;
  }
});

it("reads no conversation when the read that decides the Kiro guard fails and a later one shows the wrapper", async () => {
  // herdr labels the pane's agent Codex: with no process facts it is then taken for a plain pane
  agentFolders = { cwd: root, agent: "codex" } as typeof agentFolders;
  const replies = ["The first fixture is ready for careful inspection.", "The second fixture check is now fully complete."];
  writeFileSync(path, [
    { type: "session_meta", payload: { id: thread, cwd: root } },
    ...replies.flatMap((message, index) => [
      { type: "event_msg", payload: { type: "user_message", message: `Fixture request ${index}` } },
      { type: "event_msg", payload: { type: "agent_message", message } },
    ]),
  ].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
  screen = "OpenAI Codex (v0.165.0)\n" + replies.map((reply, index) => `› Fixture request ${index}\n\n• ${reply}\n\n`).join("") + "› ";
  foreground = [{ pid: 2147483647, argv: ["zsh (kiro-cli-term)"] }];
  shellPid = 2147483647;
  // as a Chat poll looks: its own read (the wrapper) decides omo's check and the store, so the lookup's first read is
  // agent.get's; herdr fails it, and answers the ones after
  failedReads = new Set([1]);
  const known = { shell_pid: 2147483647, foreground_processes: [{ pid: 2147483647, argv: ["zsh (kiro-cli-term)"] }] };
  const nested = spyOn(kiro, "kiroCodexProcess").mockResolvedValue({ pid: 2147483646, argv: ["codex"], identity: "10:1,20:1,2147483646:1" });
  const mac = asOnMac();
  try {
    await expect(paneTranscript(root, home, labelledSnapshot(), undefined, undefined, undefined, undefined, undefined, known as never)).rejects.toMatchObject({ message: "no_session_path" });
  } finally { nested.mockRestore(); mac.mockRestore(); }
});

it("asks again when herdr answers the lookup's own read without process facts, and resolves the nested Codex then", async () => {
  // Given a Kiro pane showing its conversation's own long answer: omo's check sees the wrapper, agent.get's read
  // comes back without process facts, and the read after it shows the wrapper again
  agentFolders = { cwd: root };
  screen = answer;
  foreground = [{ pid: 2147483647, argv: ["zsh (kiro-cli-term)"] }];
  shellPid = 2147483647;
  processReads = [foreground, null];
  // the probe proves the nested Codex from the wrapper herdr names, and nothing from an answer without process facts
  const nested = spyOn(kiro, "kiroCodexProcess").mockImplementation(async (info) => info === undefined ? null : { pid: 2147483646, argv: ["codex"], identity: "10:1,20:1,2147483646:1" });
  const mac = asOnMac();
  try {
    // Then the conversation is read from the next answer, as before the lookup reused its read
    expect(await paneTranscript(root, home, labelledSnapshot())).toMatchObject({ source: "codex-transcript", path });
  } finally { nested.mockRestore(); mac.mockRestore(); }
});

it("keeps the Kiro guard when the pane became a Kiro wrapper after an earlier read saw a plain Codex", async () => {
  // Given a pane showing its cwd thread's own prompts and short answers, which only a plain Codex may be read by
  agentFolders = { cwd: root };
  const replies = ["The first fixture is ready for careful inspection.", "The second fixture check is now fully complete."];
  writeFileSync(path, [
    { type: "session_meta", payload: { id: thread, cwd: root } },
    ...replies.flatMap((message, index) => [
      { type: "event_msg", payload: { type: "user_message", message: `Fixture request ${index}` } },
      { type: "event_msg", payload: { type: "agent_message", message } },
    ]),
  ].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
  screen = "OpenAI Codex (v0.165.0)\n" + replies.map((reply, index) => `› Fixture request ${index}\n\n• ${reply}\n\n`).join("") + "› ";
  // and herdr now showing Kiro's wrapper around a nested Codex
  foreground = [{ pid: 2147483647, argv: ["zsh (kiro-cli-term)"] }];
  shellPid = 2147483647;
  const nested = spyOn(kiro, "kiroCodexProcess").mockResolvedValue({ pid: 2147483646, argv: ["codex"], identity: "10:1,20:1,2147483646:1" });
  const mac = asOnMac();
  try {
    // When the poll's read, made before, saw a plain Codex
    const known = { foreground_processes: [{ pid: 2147483646, argv: ["codex"] }] };
    // Then the pane keeps its nested guard: no weak match, the terminal stands in
    await expect(paneTranscript(root, home, labelledSnapshot(), undefined, undefined, undefined, undefined, undefined, known as never)).rejects.toMatchObject({ message: "no_session_path" });
  } finally { nested.mockRestore(); mac.mockRestore(); }
});

it("reads an unlabelled pane only when the Kiro foreground check proves its nested Codex", async () => {
  unlabelled = true;
  foreground = [{ pid: 2147483647, argv: ["zsh (kiro-cli-term)"] }];
  shellPid = 2147483647;
  const mac = asOnMac();
  screen = answer;
  const nested = spyOn(kiro, "kiroCodexProcess").mockResolvedValue({ pid: 2147483646, argv: ["codex"], identity: "10:1,20:1,2147483646:1" });
  const snapshot = { panes: [{ pane_id: root, cwd: root, agent_status: "unknown" }] } as SessionSnapshot;
  try {
    expect(await paneTranscript(root, home, snapshot)).toMatchObject({ source: "codex-transcript", path });
    // Without a substantial answer, do not fall through to weaker short-exchange heuristics.
    foreground = [{ pid: 2147483645, argv: ["zsh (kiro-cli-term)"] }];
    shellPid = 2147483645;
    nested.mockResolvedValue({ pid: 2147483644, argv: ["codex"], identity: "10:1,20:1,2147483644:1" });
    screen = "OpenAI Codex (v0.165.0)\n› hello\n• Hello!\n› ";
    await expect(paneTranscript(root, home, snapshot)).rejects.toMatchObject({ message: "no_session_path" });
    nested.mockResolvedValue(null);
    await expect(paneTranscript(root, home, snapshot)).rejects.toMatchObject({ message: "no_recognized_transcript" });
  } finally { nested.mockRestore(); mac.mockRestore(); }
});

for (const agentFound of [true, false]) {
  it(`rejects another nested pane's short answers when agent.get ${agentFound ? "succeeds without a session" : "reports agent_not_found"}`, async () => {
    // Given two unlabelled nested panes with identical short answers but different prompts.
    unlabelled = !agentFound;
    agentFolders = { cwd: root };
    foreground = [{ pid: 2147483647, argv: ["zsh (kiro-cli-term)"] }];
    shellPid = 2147483647;
    const mac = asOnMac();
    const otherThread = "01a0c7a1-56d9-7e20-9f08-f7a2d973bc02";
    const otherCwd = join(root, "elsewhere");
    const otherPath = join(home, "sessions", `rollout-${otherThread}.jsonl`);
    const replies = ["The first fixture is ready for careful inspection.", "The second fixture check is now fully complete."];
    for (const [id, file, cwd, owner] of [[thread, path, root, "Peer A"], [otherThread, otherPath, otherCwd, "Selected B"]] as const) {
      writeFileSync(file, [
        { type: "session_meta", payload: { id, cwd } },
        ...replies.flatMap((message, index) => [
          { type: "event_msg", payload: { type: "user_message", message: `${owner} request ${index}` } },
          { type: "event_msg", payload: { type: "agent_message", message } },
        ]),
      ].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
    }
    const db = new Database(join(home, "state_5.sqlite"));
    db.query("INSERT INTO threads VALUES (?, ?, ?, 0, NULL, 1, 1, 'cli')").run(otherThread, otherPath, otherCwd);
    db.close();
    screen = "OpenAI Codex (v0.165.0)\n"
      + replies.map((reply, index) => `› Selected B request ${index}\n\n• ${reply}\n\n`).join("") + "› ";
    const snapshot = { panes: [root, "peer-A"].map((pane_id) => ({
      pane_id, workspace_id: root, tab_id: root, terminal_id: pane_id,
      cwd: root, agent_status: "unknown", focused: false, revision: 0,
    })), workspaces: [], tabs: [], agents: [], layouts: [], protocol: 1, version: "test" } satisfies SessionSnapshot;
    const nested = spyOn(kiro, "kiroCodexProcess").mockResolvedValue({
      pid: 2147483646, argv: ["codex"], identity: "10:1,20:1,2147483646:1",
    });
    try {
      // When resolving selected B, then neither the cwd nor shared answers prove ownership of A.
      await expect(paneTranscript(root, home, snapshot)).rejects.toMatchObject({ message: "no_session_path" });
    } finally { nested.mockRestore(); mac.mockRestore(); }
  });
}

it("keeps a nested pane's guard when one Kiro probe in the middle cannot prove Codex (live, null, live)", async () => {
  // Given an unlabelled Kiro pane whose agent.get succeeds without a session, showing its cwd thread's
  // own prompts and short answers: the weak short-answer reading must stay off for a nested pane
  agentFolders = { cwd: root };
  foreground = [{ pid: 2147483647, argv: ["zsh (kiro-cli-term)"] }];
  shellPid = 2147483647;
  const replies = ["The first fixture is ready for careful inspection.", "The second fixture check is now fully complete."];
  writeFileSync(path, [
    { type: "session_meta", payload: { id: thread, cwd: root } },
    ...replies.flatMap((message, index) => [
      { type: "event_msg", payload: { type: "user_message", message: `Fixture request ${index}` } },
      { type: "event_msg", payload: { type: "agent_message", message } },
    ]),
  ].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
  screen = "OpenAI Codex (v0.165.0)\n" + replies.map((reply, index) => `› Fixture request ${index}\n\n• ${reply}\n\n`).join("") + "› ";
  const snapshot = { panes: [{
    pane_id: root, workspace_id: root, tab_id: root, terminal_id: root,
    cwd: root, agent_status: "unknown", focused: false, revision: 0,
  }], workspaces: [], tabs: [], agents: [], layouts: [], protocol: 1, version: "test" } satisfies SessionSnapshot;
  const live = { pid: 2147483646, argv: ["codex"], identity: "10:1,20:1,2147483646:1" };
  let probes = 0;
  // When the second probe proves nothing (on the PR's own code, agent.get's; it now rests on herdr's
  // wrapper fact, so the second probe is the process lookup), with probes before and after it that do
  const nested = spyOn(kiro, "kiroCodexProcess").mockImplementation(async () => ++probes === 2 ? null : live);
  const mac = asOnMac();
  try {
    // Then the pane keeps its nested provenance: no weak match, the terminal stands in
    await expect(paneTranscript(root, home, snapshot)).rejects.toMatchObject({ message: "no_session_path" });
  } finally { nested.mockRestore(); mac.mockRestore(); }
});

it("takes no thread herdr reports for a nested pane on the report alone, however fresh it looks", async () => {
  // Given a Kiro pane whose agent.get reports a thread begun after its nested Codex started, and an
  // empty screen: an unlabelled nested peer could have begun it, and nothing here tells them apart
  agentFolders = { cwd: root };
  foreground = [{ pid: 2147483647, argv: ["zsh (kiro-cli-term)"] }];
  shellPid = 2147483647;
  screen = "";
  const db = new Database(join(home, "state_5.sqlite"));
  db.query("UPDATE threads SET created_at = 1001").run();
  db.close();
  const snapshot = { panes: [{
    pane_id: root, workspace_id: root, tab_id: root, terminal_id: root,
    cwd: root, agent_status: "unknown", focused: false, revision: 0,
  }], workspaces: [], tabs: [], agents: [], layouts: [], protocol: 1, version: "test" } satisfies SessionSnapshot;
  const nested = spyOn(kiro, "kiroCodexProcess").mockResolvedValue({ pid: 2147483646, argv: ["codex"], identity: "10:1,20:1,2147483646:1" });
  const lower = spyOn(processStart, "processStartLowerBound").mockReturnValue(1_000_000);
  const upper = spyOn(processStart, "processStartUpperBound").mockReturnValue(1_000_000);
  const mac = asOnMac();
  try {
    for (const kind of ["path", "id"] as const) {
      reportedSession = { source: "herdr:codex", agent: "codex", kind, value: kind === "path" ? path : thread };
      // Then the terminal stands in, in the chat and for a background reader
      await expect(paneTranscript(root, home, snapshot)).rejects.toMatchObject({ message: "no_session_path" });
      expect(await codexOpenRollout(root, root, home)).toBeNull();
    }
  } finally { nested.mockRestore(); lower.mockRestore(); upper.mockRestore(); mac.mockRestore(); }
});

it("takes no long answer a nested pane only quotes in a prompt or a queued message", async () => {
  agentFolders = { cwd: root };
  foreground = [{ pid: 2147483647, argv: ["zsh (kiro-cli-term)"] }];
  shellPid = 2147483647;
  const snapshot = { panes: [{
    pane_id: root, workspace_id: root, tab_id: root, terminal_id: root,
    cwd: root, agent_status: "unknown", focused: false, revision: 0,
  }], workspaces: [], tabs: [], agents: [], layouts: [], protocol: 1, version: "test" } satisfies SessionSnapshot;
  const nested = spyOn(kiro, "kiroCodexProcess").mockResolvedValue({ pid: 2147483646, argv: ["codex"], identity: "10:1,20:1,2147483646:1" });
  const mac = asOnMac();
  try {
    for (const quoted of [
      `OpenAI Codex (v0.165.0)\n\n› Explain this quoted answer: ${answer}\n\n• Working (2s • esc to interrupt)\n\n› `,
      `OpenAI Codex (v0.165.0)\n\n• Working (2s • esc to interrupt)\n  ↳ Explain this quoted answer: ${answer}\n\n› `,
    ]) {
      screen = quoted;
      await expect(paneTranscript(root, home, snapshot)).rejects.toMatchObject({ message: "no_session_path" });
    }
    // its own answer shown as one still tells
    screen = `OpenAI Codex (v0.165.0)\n\n› Explain the selection\n\n• ${answer}\n\n› `;
    expect(await paneTranscript(root, home, snapshot)).toMatchObject({ source: "codex-transcript", path });
  } finally { nested.mockRestore(); mac.mockRestore(); }
});

it("keeps a nested pane's guard when herdr's process facts are missing for agent.get's read", async () => {
  // Given an unlabelled Kiro pane routed to Codex, whose agent.get succeeds without a label, showing its
  // cwd thread's own prompts and short answers
  agentFolders = { cwd: root };
  foreground = [{ pid: 2147483647, argv: ["zsh (kiro-cli-term)"] }];
  shellPid = 2147483647;
  const replies = ["The first fixture is ready for careful inspection.", "The second fixture check is now fully complete."];
  writeFileSync(path, [
    { type: "session_meta", payload: { id: thread, cwd: root } },
    ...replies.flatMap((message, index) => [
      { type: "event_msg", payload: { type: "user_message", message: `Fixture request ${index}` } },
      { type: "event_msg", payload: { type: "agent_message", message } },
    ]),
  ].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
  screen = "OpenAI Codex (v0.165.0)\n" + replies.map((reply, index) => `› Fixture request ${index}\n\n• ${reply}\n\n`).join("") + "› ";
  const snapshot = { panes: [{
    pane_id: root, workspace_id: root, tab_id: root, terminal_id: root,
    cwd: root, agent_status: "unknown", focused: false, revision: 0,
  }], workspaces: [], tabs: [], agents: [], layouts: [], protocol: 1, version: "test" } satisfies SessionSnapshot;
  // When herdr's process_info is missing for agent.get's read (the third: routing reads it twice first),
  // and every probe proves Codex
  processReads = [foreground, foreground, null];
  const nested = spyOn(kiro, "kiroCodexProcess").mockResolvedValue({ pid: 2147483646, argv: ["codex"], identity: "10:1,20:1,2147483646:1" });
  const mac = asOnMac();
  try {
    // Then the pane stays nested: an inferred Codex without its process facts gets no weak reading
    await expect(paneTranscript(root, home, snapshot)).rejects.toMatchObject({ message: "no_session_path" });
  } finally { nested.mockRestore(); mac.mockRestore(); }
});

it.skipIf(process.platform !== "linux")("reads no conversation from the default store chosen while the pane's Codex was not proven", async () => {
  // Given a nested Codex that writes to a store of its own, and the server's default store (this
  // fixture's) holding a conversation the pane's screen shows
  const own = join(root, "own-store");
  mkdirSync(own, { recursive: true });
  // READY once the shell runs with its own environment (/proc shows it from then on), then it becomes `codex`
  const child = Bun.spawn(["/bin/bash", "-c", "echo READY; exec -a codex sleep 600"], { env: { ...process.env, CODEX_HOME: own }, stdout: "pipe", stderr: "ignore" });
  children.push(child);
  expect(await firstLine(child.stdout)).toBe("READY\n");
  const defaultBefore = process.env["CODEX_HOME"];
  process.env["CODEX_HOME"] = home;
  agentFolders = { cwd: root };
  foreground = [{ pid: 2147483647, argv: ["zsh (kiro-cli-term)"] }];
  shellPid = 2147483647;
  screen = answer;
  const snapshot = { panes: [{
    pane_id: root, workspace_id: root, tab_id: root, terminal_id: root,
    cwd: root, agent_status: "unknown", focused: false, revision: 0,
  }], workspaces: [], tabs: [], agents: [], layouts: [], protocol: 1, version: "test" } satisfies SessionSnapshot;
  const live = { pid: child.pid, argv: ["codex"], identity: `10:1,20:1,${child.pid}:1` };
  let probes = 0;
  const nested = spyOn(kiro, "kiroCodexProcess");
  const mac = asOnMac();
  try {
    // When the probe that chooses the store (the second, paneCodexHome's) fails to prove the Codex, and
    // the lookup's after it proves it; and when every probe after the lookup's fails as well
    for (const failed of [(probe: number) => probe === 2, (probe: number) => probe === 2 || probe >= 4]) {
      probes = 0;
      nested.mockImplementation(async () => failed(++probes) ? null : live);
      // Then the conversation found in the default store is not taken for the pane's
      await expect(paneTranscript(root, undefined, snapshot)).rejects.toMatchObject({ message: "no_session_path" });
    }
  } finally {
    nested.mockRestore(); mac.mockRestore();
    if (defaultBefore === undefined) delete process.env["CODEX_HOME"]; else process.env["CODEX_HOME"] = defaultBefore;
  }
});

it("reads no conversation from a fallback store when the Codex proven since cannot say where it writes", async () => {
  // Given the default store holding the conversation the screen shows, and a nested Codex whose
  // environment cannot be read (another user's process, or one gone)
  const defaultBefore = process.env["CODEX_HOME"];
  process.env["CODEX_HOME"] = home;
  agentFolders = { cwd: root };
  foreground = [{ pid: 2147483647, argv: ["zsh (kiro-cli-term)"] }];
  shellPid = 2147483647;
  screen = answer;
  const snapshot = { panes: [{
    pane_id: root, workspace_id: root, tab_id: root, terminal_id: root,
    cwd: root, agent_status: "unknown", focused: false, revision: 0,
  }], workspaces: [], tabs: [], agents: [], layouts: [], protocol: 1, version: "test" } satisfies SessionSnapshot;
  let probes = 0;
  // When the probe that chooses the store fails and the lookup's proves the Codex
  const nested = spyOn(kiro, "kiroCodexProcess").mockImplementation(async () => ++probes === 2 ? null : { pid: 2147483646, argv: ["codex"], identity: "10:1,20:1,2147483646:1" });
  const mac = asOnMac();
  try {
    // Then the default store is not taken for its own: nothing says the Codex writes there
    await expect(paneTranscript(root, undefined, snapshot)).rejects.toMatchObject({ message: "no_session_path" });
  } finally {
    nested.mockRestore(); mac.mockRestore();
    if (defaultBefore === undefined) delete process.env["CODEX_HOME"]; else process.env["CODEX_HOME"] = defaultBefore;
  }
});

it("takes no long answer the screen shows only as a tool's output", async () => {
  foreground = [{ pid: 2147483647, argv: ["/usr/bin/codex"] }];
  // Given a pane still working, whose `cat` printed another conversation's long answer
  screen = `OpenAI Codex (v0.165.0)\n\n› Show the notes\n\n• Ran cat notes.txt\n  └ ${answer}\n    (2 more lines)\n\n• Working (3s • esc to interrupt)\n\n› `;
  expect(await resolve()).toBeNull();
  // nor below a call whose line wraps above its output
  screen = `OpenAI Codex (v0.165.0)\n\n› Show the notes\n\n• Ran cat /home/user/projects/a-rather-long/path/to/the/notes/that/wraps\n  /notes.txt\n  └ ${answer}\n\n› `;
  expect(await resolve()).toBeNull();
  // its own answer shown as one still tells
  screen = `OpenAI Codex (v0.165.0)\n\n› Show the notes\n\n• ${answer}\n\n› `;
  expect(await resolve()).toBe(path);
});

it("does not reuse a nested conversation binding after a process birth changes with the same PIDs", async () => {
  unlabelled = true;
  foreground = [{ pid: 2147483647, argv: ["zsh (kiro-cli-term)"] }];
  shellPid = 2147483647;
  const mac = asOnMac();
  const original = { pid: 2147483646, argv: ["codex"], identity: "10:1,20:1,2147483646:1" };
  const nested = spyOn(kiro, "kiroCodexProcess").mockResolvedValue(original);
  try {
    for (const identity of ["10:2,20:1,2147483646:1", "10:1,20:2,2147483646:1", "10:1,20:1,2147483646:2"]) {
      nested.mockResolvedValue(original);
      screen = answer;
      expect(await resolve()).toBe(path);
      screen = "";
      expect(await resolve()).toBe(path);
      expect(await codexOpenRollout(root, root, home)).toBe(path);
      // Resuming an existing thread need not create a newer database row or change the PID.
      nested.mockResolvedValue({ ...original, identity });
      expect(await codexOpenRollout(root, root, home)).toBeNull();
      expect(await resolve()).toBeNull();
      screen = answer;
      expect(await resolve()).toBe(path);
    }
  } finally { nested.mockRestore(); mac.mockRestore(); }
});

it("chooses no native chat when the final Kiro process probe cannot prove Codex", async () => {
  unlabelled = true;
  foreground = [{ pid: 2147483647, argv: ["zsh (kiro-cli-term)"] }];
  shellPid = 2147483647;
  const mac = asOnMac();
  screen = answer;
  // routing proves the Codex; the final process lookup does not (agent_not_found is decided by herdr's
  // wrapper fact now, without a probe of its own, so the lookup is the second probe)
  const nested = spyOn(kiro, "kiroCodexProcess")
    .mockResolvedValueOnce({ pid: 2147483646, argv: ["codex"], identity: "10:1,20:1,2147483646:1" })
    .mockResolvedValue(null);
  const snapshot = { panes: [{
    pane_id: root, workspace_id: root, tab_id: root, terminal_id: root,
    cwd: root, agent_status: "unknown", focused: false, revision: 0,
  }], workspaces: [], tabs: [], agents: [], layouts: [], protocol: 1, version: "test" } satisfies SessionSnapshot;
  try {
    await expect(paneTranscript(root, home, snapshot)).rejects.toMatchObject({ message: "no_session_path" });
  } finally { nested.mockRestore(); mac.mockRestore(); }
});

/** A fixture's first line, whole: a busy pipe can hand "READY" and its newline over in two reads. */
async function firstLine(stdout: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stdout.getReader();
  const decoder = new TextDecoder();
  let text = "";
  try {
    while (!text.includes("\n")) {
      const { value, done } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
  } finally { reader.releaseLock(); }
  return text;
}

/** A ready, owned process with Codex's argv[0], no rollout descriptor and no timer. */
async function runningCodex(resume = false): Promise<ReturnType<typeof Bun.spawn>> {
  const node = Bun.which("node");
  if (node === null) throw new Error("node is required for the Codex process fixture");
  const child = Bun.spawn([
    "/bin/bash", "-c", 'exec -a "$1" "$2" -e \'process.stdout.write("READY\\n"); process.stdin.resume()\' "${@:3}"',
    "fixture", join(root, "codex"), node, ...(resume ? ["resume", thread] : []),
  ], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  children.push(child);
  expect(await firstLine(child.stdout)).toBe("READY\n");
  return child;
}

it.skipIf(process.platform !== "linux")("selects the resumed rollout when Linux foreground metadata omits argv", async () => {
  const child = await runningCodex(true);
  foreground = [{ pid: child.pid, name: "codex" }];
  expect(await resolve()).toBe(path);
});

it("selects the resumed rollout for the observed native executable alias", async () => {
  foreground = [{ pid: 2147483647, argv: ["/home/user/.local/bin/codex.opencodex-real", "resume", thread] }];
  expect(await resolve()).toBe(path);
});

it("binds a conversation with a spaced local file link and keeps it when its screen no longer tells", async () => {
  foreground = [{ pid: 2147483647, argv: ["/usr/bin/codex"] }];
  const linked = `${answer} [Daily report](</home/user/My Project/Daily notes/report.md>)`;
  writeFileSync(path, [
    { type: "session_meta", payload: { id: thread, cwd: root } },
    { type: "event_msg", payload: { type: "agent_message", message: linked } },
  ].map((entry) => JSON.stringify(entry)).join("\n"));
  screen = `• ${answer} Daily report (Daily notes/report.md)`;
  expect(await resolve()).toBe(path);
  screen = "";
  expect(await resolve()).toBe(path);
});

it.skipIf(process.platform !== "linux")("keeps the screen binding with recovered argv while the same process runs", async () => {
  const child = await runningCodex();
  foreground = [{ pid: child.pid, name: "codex" }];
  screen = answer;
  expect(await resolve()).toBe(path);
  screen = "";
  expect(await resolve()).toBe(path);
});

it.skipIf(process.platform !== "linux")("drops the recovered binding when its process has exited", async () => {
  const child = await runningCodex();
  foreground = [{ pid: child.pid, name: "codex" }];
  screen = answer;
  expect(await resolve()).toBe(path);
  child.kill();
  await child.exited;
  screen = "";
  expect(await resolve()).toBeNull();
});

it("finds the threads of a Windows cwd that Codex stored with the \\\\?\\ prefix (#518)", async () => {
  const cwd = "D:\\work\\app";
  // a running Codex in the pane: a screen with none proves nothing
  foreground = [{ pid: 2147483647, argv: ["/usr/bin/codex"] }];
  const db = new Database(join(home, "state_5.sqlite"));
  db.query("UPDATE threads SET cwd = ?").run(`\\\\?\\${cwd}`);
  db.close();
  screen = answer;
  expect(await codexTranscriptPath(root, cwd, home, [{
    pane_id: root, workspace_id: root, tab_id: root, terminal_id: root,
    agent: "codex", agent_status: "working", cwd, focused: false, revision: 0,
  }])).toBe(path);
});

it("gives a background reader the chat's binding only while no newer thread may have replaced it, and binds nothing itself", async () => {
  foreground = [{ pid: 2147483647, argv: ["/usr/bin/codex"] }];
  expect(await codexOpenRollout(root, root, home)).toBeNull();
  screen = answer;
  expect(await codexOpenRollout(root, root, home)).toBeNull();
  expect(await resolve()).toBe(path);
  screen = "";
  expect(await codexOpenRollout(root, root, home)).toBe(path);
  const db = new Database(join(home, "state_5.sqlite"));
  const now = Math.floor(Date.now() / 1000);
  db.query("INSERT INTO threads VALUES (?, ?, ?, 0, NULL, ?, ?, 'cli')").run(
    "01a0c7a1-56d9-7e20-9f08-f7a2d973bc02", join(home, "sessions", "missing.jsonl"), root, now, now,
  );
  db.close();
  expect(await codexOpenRollout(root, root, home)).toBeNull();
});

/** A thread of another folder, as `codex resume` (the picker) can open from this one (#896). */
const other = "01a16b22-7e1f-7072-8897-d5e46a0d5f1f";
const otherAnswer = "An answer of the other folder's conversation, which this pane resumed through the picker.";
function otherFolderThread(messages: { type: string; message: string }[] = [{ type: "agent_message", message: otherAnswer }]): string {
  const elsewhere = join(root, "elsewhere");
  mkdirSync(elsewhere, { recursive: true });
  const rollout = join(home, "sessions", `rollout-${other}.jsonl`);
  writeFileSync(rollout, [
    { type: "session_meta", payload: { id: other, cwd: elsewhere } },
    ...messages.map((payload) => ({ type: "event_msg", payload })),
  ].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
  const db = new Database(join(home, "state_5.sqlite"));
  db.query("INSERT INTO threads (id, rollout_path, cwd, archived, agent_role, created_at, updated_at, source) VALUES (?, ?, ?, 0, NULL, 2, 2, 'cli')").run(other, rollout, elsewhere);
  db.close();
  return rollout;
}

/** The title Codex 0.163.0 sets with its thread-id item: the id shortened to 29 characters. */
const shortened = `Use the other folder | elsewhere | ${other.slice(0, 29)}...`;
const picker = [{ pid: 2147483647, argv: ["codex", "resume", "--all"] }];

it("cleans title text as Codex 0.163.0 does (tui/src/terminal_title.rs, its own test cases)", () => {
  expect(asCodexTitle("  Project\t|\nWorking\x1b\x07\u009D\u009C |  Thread  ")).toBe("Project | Working | Thread");
  expect(asCodexTitle("Pro\u202Ej\u2066e\u200Fc\u061Ct\u200B \uFEFFT\u2060itle")).toBe("Project Title");
  const mixed = " \u25cf \u2807 | \u011b[31m thread \u202e\x07| \u65e5\u672c\u8a9e \u0107af\u00e9  ";
  expect(asCodexTitle(mixed, true)).toBe("* | | ?[31m thread | ??? ?af?");
  expect(asCodexTitle(mixed)).toBe("\u25cf \u2807 | \u011b[31m thread | \u65e5\u672c\u8a9e \u0107af\u00e9");
  expect(asCodexTitle("\u65e5\u672c\u8a9e", true)).toBe("???");
  expect(asCodexTitle("\x07\x1b\u202E\uFEFF", true)).toBe("");
});

describe("the thread id a Codex pane's terminal title shows, from another folder (#896)", () => {
  it("is matched on screen like the pane's own threads, and the match then serves a background reader", async () => {
    const rollout = otherFolderThread();
    foreground = picker;
    title = shortened;
    screen = otherAnswer;
    expect(await resolve()).toBe(rollout);
    expect(await codexOpenRollout(root, root, home)).toBe(rollout);
  });

  it("is never taken on the title alone: a name that only looks like the id leaves the screen to decide", async () => {
    otherFolderThread();
    foreground = picker;
    title = `Working | ${other}`;
    expect(await resolve()).toBeNull();
    expect(await codexOpenRollout(root, root, home)).toBeNull();
    screen = answer;
    expect(await resolve()).toBe(path);
  });

  it("follows the title's thread over the one the command line resumed, as after /new", async () => {
    const rollout = otherFolderThread();
    foreground = [{ pid: 2147483647, argv: ["codex", "resume", thread] }];
    title = `\u280b ${other} | elsewhere`;
    screen = otherAnswer;
    expect(await resolve()).toBe(rollout);
  });

  /** `count` more exchanges of this folder's conversation, two turns each */
  const later = (from: number, count: number) => `\n${Array.from({ length: count }, (_, index) => [
    { type: "user_message", message: `Question ${from + index}` },
    { type: "agent_message", message: `Later answer number ${from + index} of this folder's own conversation.` },
  ].map((payload) => JSON.stringify({ type: "event_msg", payload })).join("\n")).join("\n")}`;

  it("takes no answer this folder's conversation gave too, however long ago", async () => {
    otherFolderThread([{ type: "agent_message", message: answer }]);
    foreground = picker;
    title = `Working | ${other}`;
    screen = answer;
    // past its last eight answers, then past the last hundred turns a chat shows
    for (const [from, count] of [[0, 8], [8, 60]] as const) {
      appendFileSync(path, later(from, count));
      expect(await resolve()).toBeNull();
      expect(await codexOpenRollout(root, root, home)).toBeNull();
    }
  });

  it("leaves an answer both conversations gave lately undecided, rather than this folder's by elimination", async () => {
    otherFolderThread([{ type: "agent_message", message: answer }]);
    foreground = picker;
    title = `Working | ${other}`;
    screen = answer;
    expect(await resolve()).toBeNull();
  });

  it("takes no id that a folder or a thread's name could have put in the title (R1)", async () => {
    // the pane really runs C, resumed from a folder named after B's id, with no thread-id title item:
    // the title's project name is B's id, and C and B gave the same answer
    otherFolderThread([{ type: "agent_message", message: answer }]);
    const named = join(root, `project-${other}`);
    mkdirSync(named, { recursive: true });
    const actual = "01a16b22-7e1f-7072-8897-cccccccccccc";
    const rollout = join(home, "sessions", `rollout-${actual}.jsonl`);
    writeFileSync(rollout, [
      { type: "session_meta", payload: { id: actual, cwd: named } },
      { type: "event_msg", payload: { type: "agent_message", message: answer } },
    ].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
    const db = new Database(join(home, "state_5.sqlite"));
    db.query("INSERT INTO threads (id, rollout_path, cwd, archived, agent_role, created_at, updated_at, source) VALUES (?, ?, ?, 0, NULL, 2, 2, 'cli')").run(actual, rollout, named);
    db.close();
    writeFileSync(path, [
      { type: "session_meta", payload: { id: thread, cwd: root } },
      { type: "event_msg", payload: { type: "agent_message", message: "This folder's own conversation answered something else entirely, long enough to count." } },
    ].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
    foreground = picker;
    screen = answer;
    title = `Ask about the project | ${other}`;
    expect(await resolve()).toBeNull();
    expect(await codexOpenRollout(root, root, home)).toBeNull();
  });

  it("compares names as Codex writes them into the title, without the characters it drops (R2)", async () => {
    // C's name (then its folder) is B's id with invisible characters Codex strips from its title
    otherFolderThread([{ type: "agent_message", message: answer }]);
    const actual = "01a16b22-7e1f-7072-8897-cccccccccccc";
    const folder = join(root, "project");
    mkdirSync(folder, { recursive: true });
    const rollout = join(home, "sessions", `rollout-${actual}.jsonl`);
    writeFileSync(rollout, [
      { type: "session_meta", payload: { id: actual, cwd: folder } },
      { type: "event_msg", payload: { type: "agent_message", message: answer } },
    ].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
    const db = new Database(join(home, "state_5.sqlite"));
    db.exec("ALTER TABLE threads ADD COLUMN name TEXT");
    db.query("INSERT INTO threads (id, rollout_path, cwd, archived, agent_role, created_at, updated_at, source) VALUES (?, ?, ?, 0, NULL, 2, 2, 'cli')")
      .run(actual, rollout, folder);
    db.close();
    writeFileSync(path, [
      { type: "session_meta", payload: { id: thread, cwd: root } },
      { type: "event_msg", payload: { type: "agent_message", message: "This folder's own conversation answered something else entirely, long enough to count." } },
    ].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
    foreground = picker;
    screen = answer;
    title = `${other} | project`;
    const found: [string, string | null, string | null][] = [];
    for (const name of [
      `${other.slice(0, 8)}\u200b${other.slice(8, 20)}\u2061\ufeff${other.slice(20)}`,
      // a NUL, which SQLite's text functions stop at
      `${other.slice(0, 8)}\u0000${other.slice(8)}`,
      // what Codex writes as "-" under GNU Screen (STY)
      `${other.slice(0, 8)}\u2839${other.slice(9, 13)}\u2826${other.slice(14)}`,
      // a space Codex drops when the name reaches its 240-character title cap
      `${other.slice(0, 35)} ${other.slice(35)}`,
    ]) {
      const named = new Database(join(home, "state_5.sqlite"));
      named.query("UPDATE threads SET name = ? WHERE id = ?").run(name, actual);
      named.close();
      found.push([JSON.stringify(name), await resolve(), await codexOpenRollout(root, root, home)]);
    }
    expect(found.filter(([, chat, reader]) => chat !== null || reader !== null).map(([name]) => name)).toEqual([]);
  });

  it("compares the pane's folders as Codex writes them into the title too (R2)", async () => {
    otherFolderThread();
    foreground = picker;
    screen = otherAnswer;
    title = `Working | ${other}`;
    agentFolders = { cwd: join(root, `${other.slice(0, 13)}\u00ad${other.slice(13)}`), foreground_cwd: root };
    expect(await resolve()).toBeNull();
  });

  it("counts an answer another conversation split into parts as given there too", async () => {
    otherFolderThread([{ type: "agent_message", message: answer }]);
    const half = answer.indexOf(" ", answer.length / 2);
    writeFileSync(path, [
      { type: "session_meta", payload: { id: thread, cwd: root } },
      { type: "event_msg", payload: { type: "agent_message", message: answer.slice(0, half) } },
      { type: "event_msg", payload: { type: "agent_message", message: answer.slice(half) } },
    ].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
    foreground = picker;
    title = shortened;
    screen = answer;
    expect(await resolve()).toBeNull();
  });

  it("drops a binding the title made once the title names another thread", async () => {
    const rollout = otherFolderThread();
    foreground = picker;
    title = shortened;
    screen = otherAnswer;
    expect(await resolve()).toBe(rollout);
    // the same Codex resumed another folder's thread through the picker; none of its answers shows yet
    const next = "01a16b22-7e1f-7072-8897-eeeeeeeeeeee";
    const nextRollout = join(home, "sessions", `rollout-${next}.jsonl`);
    writeFileSync(nextRollout, `${JSON.stringify({ type: "session_meta", payload: { id: next, cwd: join(root, "elsewhere") } })}\n`);
    const db = new Database(join(home, "state_5.sqlite"));
    db.query("INSERT INTO threads (id, rollout_path, cwd, archived, agent_role, created_at, updated_at, source) VALUES (?, ?, ?, 0, NULL, 3, 3, 'cli')").run(next, nextRollout, join(root, "elsewhere"));
    db.close();
    title = `Another one | elsewhere | ${next.slice(0, 29)}...`;
    screen = "";
    expect(await codexOpenRollout(root, root, home)).toBeNull();
    expect(await resolve()).toBeNull();
    title = shortened;
    expect(await codexOpenRollout(root, root, home)).toBeNull();
  });

  it("offers nothing from another folder without the id in the title, without a Codex process, or for an id the store does not hold", async () => {
    otherFolderThread();
    screen = otherAnswer;
    foreground = picker;
    title = "Use the other folder | elsewhere";
    expect(await resolve()).toBeNull();
    title = shortened;
    foreground = [{ pid: 2147483647, argv: ["bash"] }];
    expect(await resolve()).toBeNull();
    foreground = [];
    expect(await resolve()).toBeNull();
    foreground = picker;
    title = "Use the other folder | elsewhere | 01a16b22-7e1f-7072-8897-ffffffffffff";
    expect(await resolve()).toBeNull();
    // an id inside other text, or cut anywhere but where Codex cuts it, is no thread-id item
    for (const named of [`Use the other folder | proj-${other}`, `Use the other folder | ${other.slice(0, 30)}...`, `${other} | ${other.slice(0, 29)}...`]) {
      title = named;
      expect(await resolve()).toBeNull();
    }
  });
});

/**
 * Codex's writer locks, as the app-server daemon holds them while threads are loaded
 * (codex-rs rollout/src/writer_lock.rs): one process with each `thread-writer-locks/<id>.lock` open and
 * an exclusive flock on it, through Python's fcntl.flock (flock(2) on Linux and macOS alike).
 */
async function loaded(...ids: string[]): Promise<ReturnType<typeof Bun.spawn>> {
  return holding(ids, "readable");
}

/** As loaded, by a process whose open files no other process may list (not dumpable), as another user's. */
const loadedUnreadably = (...ids: string[]) => holding(ids, "unreadable");

/**
 * As loaded, by a `codex exec` run, which holds its thread's lock in its own process: Python locks
 * it, then becomes Codex's binary running exec, in name (cat, reading an empty file `exec` and then
 * stdin). Not Python itself: on macOS it re-executes itself under another name.
 */
async function loadedByExec(id: string): Promise<ReturnType<typeof Bun.spawn>> {
  const folder = join(home, "thread-writer-locks");
  mkdirSync(folder, { recursive: true });
  const bin = mkdtempSync(join(root, "exec-run-"));
  writeFileSync(join(bin, "exec"), "");
  const child = Bun.spawn(["python3", "-c", [
    "import fcntl, os, sys",
    "lock = os.open(sys.argv[1], os.O_WRONLY | os.O_APPEND | os.O_CREAT)",
    "fcntl.flock(lock, fcntl.LOCK_EX)",
    "os.set_inheritable(lock, True)",
    "os.execv('/bin/cat', [os.path.join(sys.argv[2], 'codex'), 'exec', '-'])",
  ].join("\n"), join(folder, `${id}.lock`), bin], { cwd: bin, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  children.push(child);
  // only cat, once Python has become it, echoes what it reads
  child.stdin.write("READY\n");
  await child.stdin.flush();
  expect(await firstLine(child.stdout)).toBe("READY\n");
  return child;
}

async function holding(ids: string[], kind: "readable" | "unreadable"): Promise<ReturnType<typeof Bun.spawn>> {
  const folder = join(home, "thread-writer-locks");
  mkdirSync(folder, { recursive: true });
  const child = Bun.spawn(["python3", "-c", [
    "import ctypes, fcntl, sys",
    "files = [open(path, 'a+') for path in sys.argv[2:]]",
    "for file in files: fcntl.flock(file, fcntl.LOCK_EX)",
    // PR_SET_DUMPABLE 0: /proc/<pid>/fd then answers EACCES to anyone but root
    "if sys.argv[1] == 'unreadable': ctypes.CDLL(None).prctl(4, 0, 0, 0, 0)",
    "print('READY', flush=True)",
    "sys.stdin.read()",
  ].join("\n"), kind, ...ids.map((id) => join(folder, `${id}.lock`))], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  children.push(child);
  expect(await firstLine(child.stdout)).toBe("READY\n");
  return child;
}

/** A thread of another folder with these records (answers, as text), as otherFolderThread, under its own id. */
function elsewhereThread(id: string, records: (string | { type: string; payload: Record<string, unknown> })[], source = "cli"): string {
  const folder = join(root, `elsewhere-${id.slice(-4)}`);
  mkdirSync(folder, { recursive: true });
  const rollout = join(home, "sessions", `rollout-${id}.jsonl`);
  writeFileSync(rollout, [
    { type: "session_meta", payload: { id, cwd: folder, source } },
    ...records.map((entry) => typeof entry === "string" ? { type: "event_msg", payload: { type: "agent_message", message: entry } } : entry),
  ].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
  const db = new Database(join(home, "state_5.sqlite"));
  db.query("INSERT INTO threads (id, rollout_path, cwd, archived, agent_role, created_at, updated_at, source) VALUES (?, ?, ?, 0, NULL, 2, 2, ?)").run(id, rollout, folder, source);
  db.close();
  return rollout;
}

/** This folder's own conversation (the fixture's thread), with these records instead. */
function ownThread(records: { type: string; payload: Record<string, unknown> }[]): void {
  writeFileSync(path, [{ type: "session_meta", payload: { id: thread, cwd: root } }, ...records].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
}
const said = (type: "user_message" | "agent_message", message: string) => ({ type: "event_msg", payload: { type, message } });

/** Real locks and stores, several of them: a budget for a busy machine, not a wait. */
const heldIt = (name: string, test: () => Promise<void>) => it.skipIf(process.platform !== "linux" && process.platform !== "darwin")(name, test, 20_000);

describe("a thread of another folder Codex has loaded, as a resume through the picker leaves it (#896)", () => {
  heldIt("is matched on screen while its answer shows there, with Codex's default title, and never remembered", async () => {
    const rollout = otherFolderThread();
    foreground = picker;
    screen = `• ${otherAnswer}`;
    // a lock file nobody holds is a thread Codex unloaded (or a crash left behind)
    mkdirSync(join(home, "thread-writer-locks"), { recursive: true });
    writeFileSync(join(home, "thread-writer-locks", `${other}.lock`), "");
    expect(await resolve()).toBeNull();
    await loaded(other);
    expect(await resolve()).toBe(rollout);
    // a line with a time in parentheses below it is no status row (and the answer counts only whole)
    screen = `• ${otherAnswer}\n• All tests passed (38s).`;
    expect(await resolve()).toBe(rollout);
    // nothing binds: a background reader is not told, and the screen is asked again each time,
    // as after /resume of another, older conversation in the same TUI (the old one stays loaded)
    expect(await codexOpenRollout(root, root, home)).toBeNull();
    screen = `• ${otherAnswer}\nOpenAI Codex (v0.164.0)\n\n› hello\n\n• Ready.\n\n› `;
    expect(await resolve()).toBeNull();
    screen = "";
    expect(await resolve()).toBeNull();
  });

  heldIt("offers nothing while a loaded thread cannot be weighed: no row, no rollout, or a non-interactive one with the same answer", async () => {
    const rollout = otherFolderThread();
    const ghost = "01a16b22-7e1f-7072-8897-999999999999";
    foreground = picker;
    screen = `• ${otherAnswer}`;
    await loaded(other, ghost);
    expect(await resolve()).toBeNull();
    const db = new Database(join(home, "state_5.sqlite"));
    db.query("INSERT INTO threads (id, rollout_path, cwd, archived, agent_role, created_at, updated_at, source) VALUES (?, ?, ?, 0, NULL, 2, 2, 'cli')").run(ghost, join(home, "sessions", "missing.jsonl"), root);
    db.close();
    expect(await resolve()).toBeNull();
    // a codex exec run is never what a pane shows, but what it said still counts against the others
    const deleted = new Database(join(home, "state_5.sqlite"));
    deleted.query("DELETE FROM threads WHERE id = ?").run(ghost);
    deleted.close();
    const exec = elsewhereThread(ghost, [otherAnswer], "exec");
    expect(await resolve()).toBeNull();
    writeFileSync(exec, `${JSON.stringify({ type: "session_meta", payload: { id: ghost, cwd: root, source: "exec" } })}\n`);
    expect(await resolve()).toBe(rollout);
  });

  it.skipIf(process.platform !== "linux")("offers nothing while a process holding a thread's lock cannot be read", async () => {
    otherFolderThread();
    // a conversation that gave the same answer, loaded by a process whose open files cannot be listed
    // (as root they can: then only that answer counting against the other is tested)
    const peer = "01a16b22-7e1f-7072-8897-eeeeeeeeeeee";
    elsewhereThread(peer, [otherAnswer]);
    foreground = picker;
    screen = `• ${otherAnswer}`;
    await loaded(other);
    await loadedUnreadably(peer);
    expect(await resolve()).toBeNull();
  }, 20_000);

  heldIt("offers nothing while a loaded conversation continues an earlier rollout that is gone", async () => {
    const rollout = otherFolderThread();
    // a fork whose parent's rollout is gone: what it said before the fork cannot be weighed
    const fork = "01a16b22-7e1f-7072-8897-bbbbbbbbbbbb";
    const forked = elsewhereThread(fork, []);
    writeFileSync(forked, [
      { type: "session_meta", payload: { id: fork, cwd: join(root, "elsewhere-bbbb"), source: "cli", history_base: { thread_id: "01a16b22-7e1f-7072-8897-cccccccccccd", end_ordinal_exclusive: 3, end_byte_offset: 400 } } },
      said("agent_message", "Something the fork said after it was made."),
    ].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
    foreground = picker;
    screen = `• ${otherAnswer}`;
    const both = await loaded(other, fork);
    expect(await resolve()).toBeNull();
    both.kill();
    await both.exited;
    await loaded(other);
    expect(await resolve()).toBe(rollout);
  });

  heldIt("takes no answer another loaded conversation gave, however long ago", async () => {
    otherFolderThread();
    elsewhereThread("01a16b22-7e1f-7072-8897-aaaaaaaaaaaa", [otherAnswer, ...Array.from({ length: 20 }, (_, index) => `Later answer number ${index}.`)]);
    foreground = picker;
    screen = `• ${otherAnswer}`;
    await loaded(other, "01a16b22-7e1f-7072-8897-aaaaaaaaaaaa");
    expect(await resolve()).toBeNull();
  });

  heldIt("takes no tool output from the screen, however far back another loaded conversation wrote it", async () => {
    otherFolderThread();
    // the pane shows this one: its output of the other's answer is now past a later, larger one
    const peer = "01a16b22-7e1f-7072-8897-dddddddddddd";
    elsewhereThread(peer, [
      { type: "response_item", payload: { type: "function_call_output", call_id: "first", output: `${"x".repeat(5000)}\n${otherAnswer}` } },
      { type: "response_item", payload: { type: "function_call_output", call_id: "second", output: "y".repeat(1_100_000) } },
    ]);
    foreground = picker;
    screen = `  >_ OpenAI Codex (v0.164.0)\n\n• Ran cat diagnostic.log\n  └ ${otherAnswer}\n\n• Ran cat big.log\n  └ yyyyyyyy\n    … +1 lines\n\n› `;
    await loaded(other, peer);
    expect(await resolve()).toBeNull();
  });

  heldIt("weighs what another loaded conversation's tool calls hold, a command over several lines long ago too", async () => {
    otherFolderThread();
    // the pane shows this one, which ran a command that holds the other's answer, cut into lines,
    // and whose output then pushed it past the last 1 MiB
    const half = otherAnswer.indexOf(" ", otherAnswer.length / 2);
    const peer = "01a16b22-7e1f-7072-8897-dddddddddddd";
    elsewhereThread(peer, [
      { type: "response_item", payload: { type: "function_call", name: "exec_command", call_id: "call",
        arguments: JSON.stringify({ cmd: `cat <<'EOF'\n${otherAnswer.slice(0, half)}\n${otherAnswer.slice(half + 1)}\nEOF` }) } },
      { type: "response_item", payload: { type: "function_call_output", call_id: "call", output: "y".repeat(1_100_000) } },
    ]);
    foreground = picker;
    screen = `  >_ OpenAI Codex (v0.164.0)\n\n• Ran cat <<'EOF'\n  │ ${otherAnswer.slice(0, half)}\n  │ ${otherAnswer.slice(half + 1)}\n  │ EOF\n\n› `;
    await loaded(other, peer);
    expect(await resolve()).toBeNull();
  });

  heldIt("weighs the command another loaded conversation ran in code mode, long ago too", async () => {
    otherFolderThread();
    // code mode keeps the command it ran only in the completed item; the call holds the script
    const peer = "01a16b22-7e1f-7072-8897-dddddddddddd";
    elsewhereThread(peer, [
      { type: "response_item", payload: { type: "custom_tool_call", name: "exec", call_id: "call", input: "await run(atob(\"cHJpbnRm\"))" } },
      { type: "event_msg", payload: { type: "item_completed", item: { type: "CommandExecution", id: "call", command: `printf '%s' '${otherAnswer}'`, aggregated_output: "done" } } },
      { type: "response_item", payload: { type: "custom_tool_call_output", call_id: "call", output: "y".repeat(1_100_000) } },
    ]);
    foreground = picker;
    screen = `  >_ OpenAI Codex (v0.164.0)\n\n• Ran printf '%s' '${otherAnswer}'\n  └ done\n\n› `;
    await loaded(other, peer);
    expect(await resolve()).toBeNull();
  });

  heldIt("weighs what another loaded conversation reasoned, long ago too", async () => {
    otherFolderThread();
    // the pane shows this one's summary of its reasoning, since pushed past the last 1 MiB
    const peer = "01a16b22-7e1f-7072-8897-dddddddddddd";
    elsewhereThread(peer, [
      { type: "response_item", payload: { type: "reasoning", summary: [{ type: "summary_text", text: otherAnswer }], encrypted_content: "gAAAA" } },
      { type: "response_item", payload: { type: "function_call_output", call_id: "call", output: "y".repeat(1_100_000) } },
    ]);
    foreground = picker;
    screen = `• ${otherAnswer}`;
    await loaded(other, peer);
    expect(await resolve()).toBeNull();
  });

  heldIt("weighs every record of another loaded conversation's last 1 MiB, of a kind its history is not read for", async () => {
    otherFolderThread();
    const peer = "01a16b22-7e1f-7072-8897-dddddddddddd";
    elsewhereThread(peer, [{ type: "response_item", payload: { type: "summary_card", text: otherAnswer } }]);
    foreground = picker;
    screen = `• ${otherAnswer}`;
    await loaded(other, peer);
    expect(await resolve()).toBeNull();
  });

  heldIt("weighs another loaded conversation's answer in any layout Codex shows it in: a link by its target, a table, an escape decoded", async () => {
    // this one answered with a label and a path, as plain text; another, with a link to that path
    const target = "docs/investigations/codex-resume-picker-cross-folder-session-identification-verification-results-896.md";
    const shown = `Verification results (${target}:12), as the run left them.`;
    const rollout = otherFolderThread([{ type: "agent_message", message: shown }]);
    foreground = picker;
    // Codex shows a link as its label and its target relative to the folder, a `#L12` as `:12`: the
    // other one's screen
    screen = `• ${shown}`;
    const alone = await loaded(other);
    expect(await resolve()).toBe(rollout);
    alone.kill();
    await alone.exited;
    // in each form Codex shows so: a path in its folder, a file URL, percent-encoded, a <destination>
    // with a title, references, a path through a symlink to its folder (which the store keeps
    // resolved while the TUI shows it relative to the folder as it was given), escapes it decodes,
    // and a table, whose cells it may show as records in another order
    const forms = [
      (folder: string) => `[Verification results](${join(folder, target)}:12), as the run left them.`,
      (folder: string) => `[Verification results](file://${join(folder, target)}#L12), as the run left them.`,
      (folder: string) => `[Verification results](${join(folder, target).replaceAll("-", "%2D")}:12), as the run left them.`,
      (folder: string) => `[Verification results](<${join(folder, target)}#L12> "the results"), as the run left them.`,
      (folder: string) => `[Verification results][results], as the run left them.\n\n[results]: ${join(folder, target)}:12`,
      (folder: string) => `[Verification results][], as the run left them.\n\n[verification  results]: ${join(folder, target)}:12`,
      (folder: string) => `[Verification results], as the run left them.\n\n[Verification Results]: <${join(folder, target)}#L12>`,
      (folder: string) => {
        symlinkSync(folder, `${folder}-link`);
        return `[Verification results](${join(`${folder}-link`, target)}#L12), as the run left them.`;
      },
      (folder: string) => `[Verification results][report], as the run left them.\n\n[report]: ${join(folder, target)}:12\n[report]: /unrelated/no-evidence.txt`,
      (folder: string) => `[Verification results][report], as the run left them.\n\n> [report]:\n>   ${join(folder, target)}:12`,
      (folder: string) => `[Verification results](${join(folder, target).replace("resume-picker", "resume&#45;picker")}:12), as the run l&#101;ft them.`,
      (folder: string) => `[Verification results](${join(folder, target).replace("picker", "pick%65r")}:12), as the run left them.`,
      (folder: string) => `[Verification results](${join(folder, target)}:12 "An \\"escaped\\" title"), as the run left them.`,
      (folder: string) => `[Verification results](file://${join(folder, target)}?download=yes#L12), as the run left them.`,
      (folder: string) => `| Item | Link |\n| --- | --- |\n| Verification | [results](${join(folder, target)}:12) |\n\nThat is as the run left them.`,
      (folder: string) => `[Verification results](${join(folder, target)}#L1C2), as the run left them.`,
    ];
    for (const [index, form] of forms.entries()) {
      const peer = `01a16b22-7e1f-7072-8897-dddddddd${String(index).padStart(4, "0")}`;
      elsewhereThread(peer, [form(join(root, `elsewhere-${peer.slice(-4)}`))]);
      const both = await loaded(other, peer);
      expect({ index, found: await resolve() }).toEqual({ index, found: null });
      both.kill();
      await both.exited;
    }
  });

  heldIt("weighs an autolink another loaded conversation answered with, which Codex shows with its address after it", async () => {
    const url = "https://example.com/investigations/codex-resume-picker-cross-folder-results-896";
    const shown = `See ${url} (${url}), as the run left them.`;
    const rollout = otherFolderThread([{ type: "agent_message", message: shown }]);
    foreground = picker;
    screen = `• ${shown}`;
    const alone = await loaded(other);
    expect(await resolve()).toBe(rollout);
    alone.kill();
    await alone.exited;
    const peer = "01a16b22-7e1f-7072-8897-dddddddd0100";
    elsewhereThread(peer, [`See <${url}>, as the run left them.`]);
    await loaded(other, peer);
    expect(await resolve()).toBeNull();
  });

  heldIt("weighs another loaded conversation's answer in a script without spaces, a reference link inside a word", async () => {
    const paragraph = (guide: string) => `这次修改已经完成并通过验证。请参阅${guide}了解配置方式和注意事项，确认当前工作目录以及会话恢复结果。测试覆盖了正常启动和断线恢复流程，所有检查均已通过。`;
    const rollout = otherFolderThread([{ type: "agent_message", message: paragraph("使用指南") }]);
    foreground = picker;
    screen = `• ${paragraph("使用指南")}`;
    const alone = await loaded(other);
    expect(await resolve()).toBe(rollout);
    alone.kill();
    await alone.exited;
    // shown as the label alone where the terminal links it
    const peer = "01a16b22-7e1f-7072-8897-dddddddd0400";
    elsewhereThread(peer, [`${paragraph("[使用指南][guide]")}\n\n[guide]: https://example.com/guide`]);
    await loaded(other, peer);
    expect(await resolve()).toBeNull();
  });

  heldIt("weighs the words an answer ends with, the first only as far as the screen's match of it goes", async () => {
    const target = "docs/investigations/codex-resume-picker-cross-folder-session-identification-verification-results-896.md";
    const word = "abcdefghijklmnopqrstuvwxyz0123456789";
    // its last 160 letters and digits begin inside its first word, after 8 of the 20 q's
    const shown = `${"q".repeat(20)}${word} results (${target}:12), as the run left them.`;
    const rollout = otherFolderThread([{ type: "agent_message", message: shown }]);
    foreground = picker;
    screen = `• ${shown}`;
    const alone = await loaded(other);
    expect(await resolve()).toBe(rollout);
    alone.kill();
    await alone.exited;
    // another conversation's link whose label begins otherwise, before what the screen matched
    const peer = "01a16b22-7e1f-7072-8897-dddddddd0300";
    elsewhereThread(peer, [`[${"q".repeat(9)}${word} results](${join(root, "elsewhere-0300", target)}:12), as the run left them.`]);
    await loaded(other, peer);
    expect(await resolve()).toBeNull();
  });

  heldIt("takes no answer the screen shows only across another conversation's answers, side by side", async () => {
    const sentences = ["The database migration completed successfully.", "All configuration checks passed verification.", "The remaining workspace changes are committed."];
    const rollout = otherFolderThread([{ type: "agent_message", message: sentences.join(" ") }]);
    // the other conversation said them one answer each, as Codex writes an answer: an item and an event
    const peer = "01a16b22-7e1f-7072-8897-dddddddd0500";
    elsewhereThread(peer, sentences.flatMap((sentence) => [
      { type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: sentence }] } },
      { type: "event_msg", payload: { type: "agent_message", message: sentence } },
    ]));
    foreground = picker;
    await loaded(other, peer);
    // this one's answer, one block
    screen = `• ${sentences.join(" ")}`;
    expect(await resolve()).toBe(rollout);
    // the other's three, a block each
    screen = sentences.map((sentence) => `• ${sentence}`).join("\n\n");
    expect(await resolve()).toBeNull();
  });

  heldIt("weighs a named entity another loaded conversation wrote as the letter Codex shows", async () => {
    // in the longest word, which the check starts from
    const answer = (word: string) => `The ${word} verification completed successfully, and every remaining check passed as expected.`;
    const rollout = otherFolderThread([{ type: "agent_message", message: answer("réexaminations") }]);
    foreground = picker;
    screen = `• ${answer("réexaminations")}`;
    const alone = await loaded(other);
    expect(await resolve()).toBe(rollout);
    alone.kill();
    await alone.exited;
    const peer = "01a16b22-7e1f-7072-8897-dddddddd0600";
    elsewhereThread(peer, [answer("r&eacute;examinations")]);
    await loaded(other, peer);
    expect(await resolve()).toBeNull();
  });

  heldIt("offers nothing while weighing another loaded conversation's named entities would take too long", async () => {
    const rollout = otherFolderThread();
    foreground = picker;
    screen = `• ${otherAnswer}`;
    const alone = await loaded(other);
    expect(await resolve()).toBe(rollout);
    alone.kill();
    await alone.exited;
    // a record with this one's longest words, and a hundred thousand entities to weigh the rest through
    const peer = "01a16b22-7e1f-7072-8897-dddddddd0900";
    elsewhereThread(peer, [`Another conversation resumed through ${"z&shy;".repeat(100_000)}`]);
    await loaded(other, peer);
    expect(await resolve()).toBeNull();
  });

  heldIt("offers nothing while the loaded conversations' histories are larger than is read", async () => {
    const rollout = otherFolderThread();
    foreground = picker;
    screen = `• ${otherAnswer}`;
    const alone = await loaded(other);
    expect(await resolve()).toBe(rollout);
    alone.kill();
    await alone.exited;
    // another loaded conversation's history past 128 MiB (sparse: no disk is used)
    const peer = "01a16b22-7e1f-7072-8897-dddddddd0700";
    truncateSync(elsewhereThread(peer, ["Something else entirely."]), 129 * 1024 * 1024);
    await loaded(other, peer);
    expect(await resolve()).toBeNull();
  });

  heldIt("offers nothing while one loaded conversation's history keeps more text than all may", async () => {
    const rollout = otherFolderThread();
    const peer = "01a16b22-7e1f-7072-8897-dddddddd0a00";
    elsewhereThread(peer, Array.from({ length: 40 }, (_, index) => `Another answer, number ${index}, about something else entirely.`));
    foreground = picker;
    screen = `• ${otherAnswer}`;
    await loaded(other, peer);
    expect(await resolve()).toBe(rollout);
    // the same history, past a limit that is lower here: read again or kept, it is not weighed
    limitCodexHistoryForTests(128 * 1024 * 1024, 1024);
    try {
      expect(await resolve()).toBeNull();
    } finally {
      limitCodexHistoryForTests();
    }
    expect(await resolve()).toBe(rollout);
  });

  heldIt("offers nothing for an answer only a codex exec run or a subagent gave", async () => {
    const rollout = otherFolderThread();
    const answerOf = (who: string) => `An answer only the ${who} gave, about the loaded threads and the picker, in its own words.`;
    const exec = "01a16b22-7e1f-7072-8897-dddddddd0800";
    elsewhereThread(exec, [answerOf("exec run")], "exec");
    const subagent = "01a16b22-7e1f-7072-8897-dddddddd0801";
    elsewhereThread(subagent, [answerOf("subagent")]);
    const db = new Database(join(home, "state_5.sqlite"));
    db.query("UPDATE threads SET agent_role = 'worker' WHERE id = ?").run(subagent);
    db.close();
    foreground = picker;
    await loaded(other, exec, subagent);
    for (const who of ["exec run", "subagent"]) {
      screen = `• ${answerOf(who)}`;
      expect({ who, found: await resolve() }).toEqual({ who, found: null });
    }
    screen = `• ${otherAnswer}`;
    expect(await resolve()).toBe(rollout);
  });

  heldIt("offers nothing while weighing another loaded conversation's words would take too long", async () => {
    // another conversation that says this one's longest words (conversation, resumed, through) in
    // more records than are weighed
    const rollout = otherFolderThread();
    foreground = picker;
    screen = `• ${otherAnswer}`;
    const few = "01a16b22-7e1f-7072-8897-dddddddd0200";
    elsewhereThread(few, Array.from({ length: 100 }, (_, index) => `Another conversation resumed through number ${index}.`));
    const some = await loaded(other, few);
    expect(await resolve()).toBe(rollout);
    some.kill();
    await some.exited;
    const many = "01a16b22-7e1f-7072-8897-dddddddd0201";
    elsewhereThread(many, Array.from({ length: 2100 }, (_, index) => `Another conversation resumed through number ${index}.`));
    const each = await loaded(other, many);
    expect(await resolve()).toBeNull();
    each.kill();
    await each.exited;
    // or in one record longer than is weighed
    const long = "01a16b22-7e1f-7072-8897-dddddddd0202";
    elsewhereThread(long, [`Another conversation resumed through ${"x".repeat(8_500_000)}`]);
    await loaded(other, long);
    expect(await resolve()).toBeNull();
  });

  heldIt("weighs a loaded conversation's whole history, past the last 1 MiB of it", async () => {
    // the pane really shows this folder's conversation; its answer is now 1.1 MB of tool output back
    otherFolderThread();
    ownThread([said("agent_message", otherAnswer), { type: "response_item", payload: { type: "function_call_output", call_id: "call", output: "x".repeat(1_100_000) } }]);
    foreground = picker;
    screen = `• ${otherAnswer}`;
    await loaded(other, thread);
    expect(await resolve()).toBeNull();
  });

  heldIt("leaves a match among this folder's threads as it was, whatever else is loaded", async () => {
    // a fork elsewhere shares the answer this folder's conversation shows: this folder's match comes
    // first, and the loaded threads are not read at all
    otherFolderThread([{ type: "agent_message", message: answer }]);
    foreground = picker;
    screen = answer;
    await loaded(other, thread);
    expect(await resolve()).toBe(path);
  });

  heldIt("leaves this folder's conversations to this folder's lookup, loaded or not", async () => {
    // two of this folder's conversations gave the answer on screen; only one of them is loaded
    const twin = join(home, "sessions", "rollout-01a0c7a1-56d9-7e20-9f08-f7a2d973bc03.jsonl");
    writeFileSync(twin, [
      { type: "session_meta", payload: { id: "01a0c7a1-56d9-7e20-9f08-f7a2d973bc03", cwd: root } },
      said("agent_message", answer),
    ].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
    const db = new Database(join(home, "state_5.sqlite"));
    db.query("INSERT INTO threads VALUES (?, ?, ?, 0, NULL, 1, 1, 'cli')").run("01a0c7a1-56d9-7e20-9f08-f7a2d973bc03", twin, root);
    db.close();
    // beside another folder's conversation, which says something else
    otherFolderThread();
    foreground = picker;
    screen = `• ${answer}`;
    await loaded(thread, other);
    expect(await resolve()).toBeNull();
  });

  heldIt("leaves this folder's short answers first, below a prompt that quotes another conversation", async () => {
    otherFolderThread();
    const quote = `Quote: ${otherAnswer}`;
    const first = "The fixture is ready for careful inspection.";
    const second = "All requested configuration checks have completed.";
    ownThread([said("user_message", quote), said("agent_message", first), said("user_message", "next"), said("agent_message", second)]);
    foreground = picker;
    screen = `OpenAI Codex (v1.0)\n\n› ${quote}\n\n• ${first}\n\n› next\n\n• ${second}\n\n› `;
    await loaded(other, thread);
    expect(await resolve()).toBe(path);
  });

  heldIt("takes no answer the pane's own conversation quoted, or its input box holds", async () => {
    otherFolderThread();
    const quote = `Quote: ${otherAnswer}`;
    ownThread([said("user_message", quote)]);
    foreground = picker;
    screen = `OpenAI Codex (v1.0)\n\n› ${quote}\n\n› `;
    await loaded(other, thread);
    expect(await resolve()).toBeNull();
    // the other conversation's answer pasted into the input box, not sent
    ownThread([said("user_message", "hi"), said("agent_message", "Hello.")]);
    screen = `OpenAI Codex (v1.0)\n\n› hi\n\n• Hello.\n\n› ${otherAnswer}`;
    expect(await resolve()).toBeNull();
  });

  heldIt("takes nothing but answers from the screen: no picker row, no prompt of a conversation not saved yet, no queued message or status", async () => {
    otherFolderThread();
    foreground = picker;
    await loaded(other);
    // the picker lists conversations by their first prompt, one of which quotes the loaded one
    screen = `  Resume a previous session\n\n  Updated     Branch  Conversation\n> 2 minutes  main    Quote: ${otherAnswer}\n  3 days      main    Something else`;
    expect(await resolve()).toBeNull();
    // a fresh TUI's first prompt quotes it before its own thread is loaded or stored
    screen = `  >_ OpenAI Codex (v0.164.0)\n\n› Quote: ${otherAnswer}\n\n• Working (2s • esc to interrupt)\n\n› `;
    expect(await resolve()).toBeNull();
    // a message queued while a turn runs, which no rollout holds until it is sent
    screen = `  >_ OpenAI Codex (v0.164.0)\n\n› hi\n\n• Working (2s • esc to interrupt)\n\n• Queued follow-up inputs\n  ↳ Quote: ${otherAnswer}\n    ⇧← edit last queued message\n\n› `;
    expect(await resolve()).toBeNull();
    // the status row's headline, a summary of reasoning no rollout holds yet, however the row ends
    for (const row of [`${otherAnswer} (1m 05s • esc to interrupt)`, `${otherAnswer} (0s) · Reconnecting`, `${otherAnswer} and the rest of a long headl…  `]) {
      screen = `  >_ OpenAI Codex (v0.164.0)\n\n› Inspect the repository.\n\n• ${row}\n\n› `;
      expect(await resolve()).toBeNull();
    }
    // a tool's output whose first row is empty (herdr trims the marker's trailing space)
    screen = `  >_ OpenAI Codex (v0.164.0)\n\n• Running python3 emit-log.py\n  └\n    ${otherAnswer}\n\n› `;
    expect(await resolve()).toBeNull();
    // what the user answered a question with
    screen = `  >_ OpenAI Codex (v0.164.0)\n\n• Questions 1/1 answered\n  • Which text?\n    answer: ${otherAnswer}\n\n› `;
    expect(await resolve()).toBeNull();
    screen = `  >_ OpenAI Codex (v0.164.0)\n\n• Questions 1/1 answered\n  • Which text?\n    note: ${otherAnswer}\n\n› `;
    expect(await resolve()).toBeNull();
  });

  heldIt("offers nothing while another loaded conversation may show an answer it has not written", async () => {
    const rollout = otherFolderThread();
    // Codex writes an answer once it is complete: this one's turn may be streaming on this screen
    const peer = "01a16b22-7e1f-7072-8897-ffffffffffff";
    const event = (payload: Record<string, unknown>, timestamp = new Date().toISOString()) => `${JSON.stringify({ timestamp, type: "event_msg", payload })}\n`;
    const prompt = { type: "item_completed", item: { type: "UserMessage", id: "prompt", content: [{ type: "text", text: "go" }] } };
    const running = elsewhereThread(peer, []);
    // interrupted before it was loaded: what it streamed then is on no screen
    appendFileSync(running, event({ type: "task_started" }, "2026-01-01T00:00:00Z") + event(prompt, "2026-01-01T00:00:01Z") + event({ type: "turn_aborted" }, "2026-01-01T00:00:02Z"));
    foreground = picker;
    screen = `  >_ OpenAI Codex (v0.164.0)\n\n› go\n\n• ${otherAnswer}\n\n› `;
    await loaded(other, peer);
    expect(await resolve()).toBe(rollout);
    appendFileSync(running, event({ type: "task_started" }) + event(prompt));
    expect(await resolve()).toBeNull();
    // once the turn is complete, what it answered is written
    appendFileSync(running, event({ type: "task_complete" }));
    expect(await resolve()).toBe(rollout);
    // one interrupted while it streamed never writes it, though its screen keeps it, after later turns too
    appendFileSync(running, event({ type: "task_started" }) + event(prompt) + event({ type: "turn_aborted" }));
    expect(await resolve()).toBeNull();
    appendFileSync(running, event({ type: "task_started" }) + event(prompt) + event({ type: "agent_message", message: "Understood." }) + event({ type: "task_complete" }));
    expect(await resolve()).toBeNull();
  });

  heldIt("offers nothing while another loaded conversation had a turn fail since it was loaded, as its screen keeps what it streamed", async () => {
    const rollout = otherFolderThread();
    const peer = "01a16b22-7e1f-7072-8897-ffffffffffff";
    const event = (payload: Record<string, unknown>, timestamp = new Date().toISOString()) => `${JSON.stringify({ timestamp, type: "event_msg", payload })}\n`;
    // Codex ends a failed turn as a completed one, with its error (core/src/tasks/mod.rs)
    const failed = (timestamp?: string) => event({ type: "task_complete", turn_id: "failed", last_agent_message: null, error: { message: "stream disconnected before completion" } }, timestamp);
    const failing = elsewhereThread(peer, []);
    // failed before it was loaded: what it streamed then is on no screen
    appendFileSync(failing, event({ type: "task_started" }, "2026-01-01T00:00:00Z") + failed("2026-01-01T00:00:02Z"));
    foreground = picker;
    screen = `• ${otherAnswer}`;
    await loaded(other, peer);
    expect(await resolve()).toBe(rollout);
    appendFileSync(failing, event({ type: "task_started" }) + failed());
    expect(await resolve()).toBeNull();
    // a later turn that completes leaves what the failed one streamed on its screen
    appendFileSync(failing, event({ type: "task_started" }) + event({ type: "agent_message", message: "Understood." })
      + event({ type: "task_complete", turn_id: "next", last_agent_message: "Understood." }));
    expect(await resolve()).toBeNull();
  });

  heldIt("leaves out the turn of a thread a codex exec run holds, as it shows an answer only once written", async () => {
    const rollout = otherFolderThread();
    const exec = "01a16b22-7e1f-7072-8897-ffffffffffff";
    elsewhereThread(exec, [{ type: "event_msg", payload: { type: "task_started" } }], "exec");
    foreground = picker;
    screen = `• ${otherAnswer}`;
    await loaded(other);
    const run = await loadedByExec(exec);
    expect(await resolve()).toBe(rollout);
    // the same thread resumed in a TUI (the picker lists exec runs too): its row still says exec
    run.kill();
    await run.exited;
    await loaded(exec);
    expect(await resolve()).toBeNull();
  });

  heldIt("offers nothing to a TUI of a remote app server, or without a Codex process", async () => {
    otherFolderThread();
    screen = `• ${otherAnswer}`;
    await loaded(other);
    foreground = [{ pid: 2147483647, argv: ["codex", "resume", "--remote", "ws://host:4500"] }];
    expect(await resolve()).toBeNull();
    foreground = [];
    expect(await resolve()).toBeNull();
  });

  heldIt("offers none of them past 32 loaded threads", async () => {
    otherFolderThread();
    screen = `• ${otherAnswer}`;
    foreground = picker;
    const many = Array.from({ length: 32 }, (_, index) => `01a16b22-7e1f-7072-8897-${String(index).padStart(12, "0")}`);
    const db = new Database(join(home, "state_5.sqlite"));
    db.transaction(() => {
      for (const id of many) {
        const rollout = join(home, "sessions", `rollout-${id}.jsonl`);
        writeFileSync(rollout, `${JSON.stringify({ type: "session_meta", payload: { id, cwd: join(root, "elsewhere") } })}\n`);
        db.query("INSERT INTO threads VALUES (?, ?, ?, 0, NULL, 2, 2, 'cli')").run(id, rollout, join(root, "elsewhere"));
      }
    })();
    db.close();
    await loaded(other, ...many);
    expect(await resolve()).toBeNull();
  });

  it.skipIf(process.platform !== "linux")("counts a loaded thread one read of the kernel's lock table left out", async () => {
    // the kernel hands /proc/locks out a page at a time, and a lock another process takes or drops
    // between two pages moves the lines after it: a read may leave a held lock out (#2046, #1965)
    const rollout = otherFolderThread();
    foreground = picker;
    screen = `• ${otherAnswer}`;
    // a conversation that gave the same answer: while it counts as loaded, none is offered
    const peer = "01a16b22-7e1f-7072-8897-dddddddd0b00";
    elsewhereThread(peer, [otherAnswer]);
    const holder = await loaded(other, peer);
    // the table as the kernel has it for these two locks, built here: a real read may tear too
    const line = (index: number, id: string) => {
      const ino = statSync(join(home, "thread-writer-locks", `${id}.lock`), { bigint: true }).ino.toString();
      return `${index}: FLOCK  ADVISORY  WRITE ${holder.pid} 00:00:${ino} 0 EOF`;
    };
    const whole = `${line(1, other)}\n${line(2, peer)}\n`;
    const withoutPeer = `${line(1, other)}\n`;
    const readFile = fs.readFileSync;
    /** /proc/locks without the peer's lock line in its first `torn` reads, and the reads made */
    const tearing = async (torn: number): Promise<{ found: string | null; reads: number }> => {
      let reads = 0;
      const spy = spyOn(fs, "readFileSync").mockImplementation(((file: string, options: "utf8") => {
        if (file !== "/proc/locks") return readFile(file, options);
        reads += 1;
        return reads > torn ? whole : withoutPeer;
      }) as typeof fs.readFileSync);
      try {
        return { found: await resolve(), reads };
      } finally { spy.mockRestore(); }
    };
    expect(await tearing(0)).toEqual({ found: null, reads: 1 });
    // left out of every read, the peer is not loaded, and the other is offered alone
    expect(await tearing(Infinity)).toEqual({ found: rollout, reads: 3 });
    // left out of one read, or two, it is found in the next
    expect(await tearing(1)).toEqual({ found: null, reads: 2 });
    expect(await tearing(2)).toEqual({ found: null, reads: 3 });
    // the holder opened the peer's lock between two reads: its open files are listed again
    const readDirectory = fs.readdirSync;
    let listings = 0;
    const late = spyOn(fs, "readdirSync").mockImplementation(((directory: string, ...rest: unknown[]) => {
      const names = (readDirectory as (path: string, ...more: unknown[]) => string[])(directory, ...rest);
      if (directory !== `/proc/${holder.pid}/fd` || ++listings > 1) return names;
      return names.filter((descriptor) => {
        try { return !fs.readlinkSync(`${directory}/${descriptor}`).endsWith(`${peer}.lock`); } catch { return true; }
      });
    }) as typeof fs.readdirSync);
    try {
      expect(await tearing(1)).toEqual({ found: null, reads: 2 });
    } finally { late.mockRestore(); }
  }, 20_000);
});

it("does not guess a session when argv and proc data are unavailable", async () => {
  foreground = [{ pid: 2147483647, name: "codex" }];
  expect(await resolve()).toBeNull();
});

it("does not trust the Codex name when recovered argv belongs to another executable", async () => {
  foreground = [{ pid: process.pid, name: "codex" }];
  expect(await resolve()).toBeNull();
});

it("does not use an alias resume after a newer interactive thread starts", async () => {
  foreground = [{ pid: 2147483647, argv: ["/usr/bin/codex.opencodex-real", "resume", thread] }];
  expect(await resolve()).toBe(path);
  const db = new Database(join(home, "state_5.sqlite"));
  db.query("INSERT INTO threads VALUES (?, ?, ?, 0, NULL, 2, 2, 'cli')").run(
    "01a0c7a1-56d9-7e20-9f08-f7a2d973bc02", join(home, "sessions", "missing.jsonl"), root,
  );
  db.close();
  expect(await resolve()).toBeNull();
});

const shortPrompt = "Check fixture";
const shortAnswer = "The fixture is ready for inspection.";
const shortScreen = `OpenAI Codex (v1.0)\n\n› ${shortPrompt}\n\n• ${shortAnswer}\n\n› `;
const shortIt = it.skipIf(process.platform !== "linux" && process.platform !== "darwin");

function shortRollout(file: string, prompt = shortPrompt, reply = shortAnswer): void {
  writeFileSync(file, [
    { type: "session_meta", payload: { id: thread, cwd: root } },
    { type: "event_msg", payload: { type: "user_message", message: prompt } },
    { type: "event_msg", payload: { type: "agent_message", message: reply } },
  ].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
}

/** Owned process and temporary native store; no Codex or paid model is invoked. */
async function shortSession(milliseconds = true, cwd = root): Promise<number> {
  const child = await runningCodex();
  foreground = [{ pid: child.pid, argv: [join(root, "codex")] }];
  const started = processStartedAt(child.pid);
  if (started === null) throw new Error("fixture process start is unavailable");
  // Keep both timestamp schemas beyond the conservative one-second start threshold.
  const created = Math.max(
    Math.ceil(Date.now() / 1000) * 1000,
    Math.ceil((started + 1000) / 1000) * 1000 + 1000,
  );
  const db = new Database(join(home, "state_5.sqlite"));
  db.exec("ALTER TABLE threads ADD COLUMN first_user_message TEXT");
  if (milliseconds) db.exec("ALTER TABLE threads ADD COLUMN created_at_ms INTEGER");
  db.query("UPDATE threads SET cwd = ?, created_at = ?, first_user_message = ?")
    .run(cwd, Math.floor(created / 1000), shortPrompt);
  if (milliseconds) db.query("UPDATE threads SET created_at_ms = ?").run(created);
  db.close();
  shortRollout(path);
  screen = shortScreen;
  return created;
}

function addShortThread(id: string, file: string, created: number, prompt = "Other fixture", source = "cli", role: string | null = null, archived = 0): void {
  const db = new Database(join(home, "state_5.sqlite"));
  db.query("INSERT INTO threads VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run(id, file, root, archived, role, Math.floor(created / 1000), 2, source, prompt, created);
  db.close();
}

const fixturePane = (id: string, cwd = root) => ({
  pane_id: id, workspace_id: root, tab_id: root, terminal_id: id,
  agent: "codex" as const, agent_status: "working" as const, cwd, focused: false, revision: 0,
});

shortIt("resolves one submitted short exchange without keeping a screenless binding", async () => {
  await shortSession();
  expect(await resolve()).toBe(path);
  screen = "• The fixture is ready for inspection.";
  expect(await resolve()).toBeNull();
});

shortIt("resolves a submitted hello and short reply without requiring a longer answer", async () => {
  await shortSession();
  const db = new Database(join(home, "state_5.sqlite"));
  db.query("UPDATE threads SET first_user_message = 'hello'").run();
  db.close();
  shortRollout(path, "hello");
  screen = shortScreen.replace(shortPrompt, "hello");
  expect(await resolve()).toBe(path);
});

shortIt("resolves its exact first exchange beside a different same-directory conversation", async () => {
  const created = await shortSession();
  const other = join(home, "sessions", "other.jsonl");
  shortRollout(other, "Other fixture", "A different short reply.");
  addShortThread("other", other, created - 60_000, "Other fixture");
  peerScreens.set("peer", "OpenAI Codex (v1.0)\n› Other fixture\n• A different short reply.\n› ");
  expect(await codexTranscriptPath(root, root, home, [fixturePane(root), fixturePane("peer")])).toBe(path);
});

shortIt("rejects unknown or matching peer screens when a header has scrolled away", async () => {
  await shortSession();
  for (const peer of [shortScreen.replace("OpenAI Codex (v1.0)\n", ""), "", "Working…", new Error("fixture pane disappeared")]) {
    peerScreens.set("peer", peer);
    expect(await codexTranscriptPath(root, root, home, [fixturePane(root), fixturePane("peer")])).toBeNull();
  }
});

shortIt("accepts a headerless peer only with a substantial match to a different conversation", async () => {
  const created = await shortSession();
  const other = join(home, "sessions", "other.jsonl");
  shortRollout(other, "Other fixture", answer);
  addShortThread("other", other, created - 60_000, "Other fixture");
  peerScreens.set("peer", `› Other fixture\n• ${answer}\n› `);
  expect(await codexTranscriptPath(root, root, home, [fixturePane(root), fixturePane("peer")])).toBe(path);
  // A recognizable answer must not override an overlapping short exchange.
  for (const mixed of [
    `${shortScreen}\n• ${answer}`,
    `${shortScreen.replace("OpenAI Codex (v1.0)\n", "")}\n• ${answer}`,
    `• ${answer}\n${shortScreen.replace("OpenAI Codex (v1.0)\n", "")}`,
  ]) {
    peerScreens.set("peer", mixed);
    expect(await codexTranscriptPath(root, root, home, [fixturePane(root), fixturePane("peer")])).toBeNull();
  }
});

shortIt("leaves a short first exchange undecided while the title offers another folder's conversation with the same one (#896)", async () => {
  await shortSession();
  expect(await resolve()).toBe(path);
  otherFolderThread([{ type: "user_message", message: shortPrompt }, { type: "agent_message", message: shortAnswer }]);
  title = `${shortPrompt} | elsewhere | ${other}`;
  expect(await resolve()).toBeNull();
});

shortIt("resolves a seconds-only schema when creation is provably after process start", async () => {
  await shortSession(false);
  expect(await resolve()).toBe(path);
});

shortIt("rejects a thread made before its process could have started, and takes one made as it starts", async () => {
  await shortSession();
  // Put the start at a second boundary, independently of btime/ps rounding or fixture setup time.
  const started = 1_001_000;
  const bound = spyOn(processStart, "processStartLowerBound").mockReturnValue(started);
  const setCreated = (created: number) => {
    const db = new Database(join(home, "state_5.sqlite"));
    db.query("UPDATE threads SET created_at = ?, created_at_ms = ?").run(Math.floor(created / 1000), created);
    db.close();
  };
  try {
    setCreated(started - 1);
    expect(await resolve()).toBeNull();
    setCreated(started);
    expect(await resolve()).toBe(path);
  } finally { bound.mockRestore(); }
});

shortIt("takes a seconds-only thread made in its process's second", async () => {
  await shortSession(false);
  const bound = spyOn(processStart, "processStartLowerBound");
  try {
    // The same stored second must work at its first and last millisecond, but not the next second.
    const db = new Database(join(home, "state_5.sqlite"));
    db.query("UPDATE threads SET created_at = 1000").run();
    db.close();
    for (const started of [1_000_000, 1_000_999]) {
      bound.mockReturnValue(started);
      expect(await resolve()).toBe(path);
    }
    bound.mockReturnValue(1_001_000);
    expect(await resolve()).toBeNull();
  } finally { bound.mockRestore(); }
});

// --- after another pane's /new, this pane's one-word exchange still tells ---

const peerThread = "01a0c7a1-56d9-7e20-9f08-f7a2d973bc09";
const peerPrompt = "explain the cache layer";
const peerAnswer = "The cache layer keeps each rendered page for ten minutes, keyed by its route and the user's locale, and evicts the oldest first.";

/** The other pane's thread, begun after this pane's Codex started (its /new), answered [reply]. */
function peerNewThread(created: number, reply = peerAnswer): string {
  const file = join(home, "sessions", `rollout-${peerThread}.jsonl`);
  writeFileSync(file, [
    { type: "session_meta", payload: { id: peerThread, cwd: root } },
    { type: "event_msg", payload: { type: "user_message", message: peerPrompt } },
    { type: "event_msg", payload: { type: "agent_message", message: reply } },
  ].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
  addShortThread(peerThread, file, created, peerPrompt);
  return file;
}

const peerScreenOf = (reply: string) => `OpenAI Codex (v1.0)\n\n› ${peerPrompt}\n\n• ${reply}\n\n› `;

shortIt("leaves out a thread another pane shows a long answer of below its first prompt, and keeps it theirs", async () => {
  const created = await shortSession();
  peerNewThread(created + 1000);
  peerScreens.set("peer", peerScreenOf(peerAnswer));
  const panes = [fixturePane(root), fixturePane("peer")];
  expect(await codexTranscriptPath(root, root, home, panes)).toBe(path);
  // looked at again within seconds the other pane is not read again: it is bound to that thread now
  expect(await codexTranscriptPath(root, root, home, panes)).toBe(path);
});

shortIt("leaves out the rollout herdr reports for another pane", async () => {
  const created = await shortSession();
  const theirs = peerNewThread(created + 1000, "ok");
  peerScreens.set("peer", peerScreenOf("ok"));
  const peer = { ...fixturePane("peer"), agent_session: { source: "herdr:codex", agent: "codex", kind: "path", value: theirs } };
  expect(await codexTranscriptPath(root, root, home, [fixturePane(root), peer])).toBe(path);
});

shortIt("leaves out its only new thread when herdr reports it for another pane", async () => {
  await shortSession();
  // the other pane shows another exchange now; herdr says the thread is that pane's conversation
  peerScreens.set("peer", "OpenAI Codex (v1.0)\n› Other fixture\n• A different short reply.\n› ");
  const peer = { ...fixturePane("peer"), agent_session: { source: "herdr:codex", agent: "codex", kind: "path", value: path } };
  expect(await codexTranscriptPath(root, root, home, [fixturePane(root), peer])).toBeNull();
  // reported for nobody, the same screens tell it is this pane's
  expect(await codexTranscriptPath(root, root, home, [fixturePane(root), fixturePane("peer")])).toBe(path);
});

shortIt("still cannot tell when nothing ties the other thread to another pane", async () => {
  const created = await shortSession();
  // a one-word answer there too, nothing reported: either pane might have begun it
  peerNewThread(created + 1000, "ok");
  peerScreens.set("peer", peerScreenOf("ok"));
  expect(await codexTranscriptPath(root, root, home, [fixturePane(root), fixturePane("peer")])).toBeNull();
});

// --- the pane that started first, beside a later pane's short first exchange ---

it("tells the first-started pane's thread once the later pane shows its own first exchange", async () => {
  // A's Codex started at 1000 s and began its thread at 1001.3; B's started at 1005 and began
  // its own at 1006.7: both began after A started, so A tells only once B shows its own
  const starts = new Map([[900001, 1_000_000], [900002, 1_005_000]]);
  const bound = spyOn(processStart, "processStartLowerBound").mockImplementation((pid) => starts.has(pid) ? starts.get(pid)! : null);
  try {
    const db = new Database(join(home, "state_5.sqlite"));
    db.exec("ALTER TABLE threads ADD COLUMN first_user_message TEXT");
    db.exec("ALTER TABLE threads ADD COLUMN created_at_ms INTEGER");
    db.query("UPDATE threads SET created_at = 1001, created_at_ms = 1001300, first_user_message = ?").run(shortPrompt);
    db.close();
    shortRollout(path);
    const theirs = join(home, "sessions", "rollout-bravo.jsonl");
    writeFileSync(theirs, [
      { type: "session_meta", payload: { id: "bravo", cwd: root } },
      { type: "event_msg", payload: { type: "user_message", message: "Reply with exactly one word: bravo" } },
      { type: "event_msg", payload: { type: "agent_message", message: "bravo" } },
    ].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
    addShortThread("bravo", theirs, 1_006_700, "Reply with exactly one word: bravo");
    foregrounds.set(root, [{ pid: 900001, argv: [join(root, "codex")] }]);
    foregrounds.set("peer", [{ pid: 900002, argv: [join(root, "codex")] }]);
    screen = shortScreen;
    const bravo = "OpenAI Codex (v1.0)\n\n› Reply with exactly one word: bravo\n\n• bravo\n\n› ";
    peerScreens.set("peer", bravo);
    const panes = [fixturePane(root), fixturePane("peer")];
    expect(await codexTranscriptPath(root, root, home, panes)).toBe(path);
    expect(await codexTranscriptPath("peer", root, home, panes)).toBe(theirs);

    // unsure stays unavailable: B's start unknown, B scrolled past its header, or this
    // pane showing B's exchange as well
    starts.delete(900002);
    expect(await codexTranscriptPath(root, root, home, panes)).toBeNull();
    starts.set(900002, 1_005_000);
    peerScreens.set("peer", "› Reply with exactly one word: bravo\n\n• bravo\n\n› ");
    expect(await codexTranscriptPath(root, root, home, panes)).toBeNull();
    peerScreens.set("peer", bravo);
    screen = bravo;
    expect(await codexTranscriptPath(root, root, home, panes)).toBeNull();
    // a later exchange of this pane's own is no claim on B's: its first exchange is still its own
    screen = `${shortScreen}Reply with exactly one word: bravo\n\n• bravo\n\n› `;
    expect(await codexTranscriptPath(root, root, home, panes)).toBe(path);
  } finally { bound.mockRestore(); }
});

shortIt("claims nothing for a long answer another pane shows under some other prompt (pasted, quoted)", async () => {
  const created = await shortSession();
  peerNewThread(created + 1000);
  peerScreens.set("peer", `OpenAI Codex (v1.0)\n\n› what did the other pane say?\n\n• ${peerAnswer}\n\n› `);
  expect(await codexTranscriptPath(root, root, home, [fixturePane(root), fixturePane("peer")])).toBeNull();
});

shortIt("handles a Windows stored cwd prefix using a Linux fixture process", async () => {
  const cwd = "D:\\fixture\\app";
  await shortSession(true, `\\\\?\\${cwd}`);
  expect(await codexTranscriptPath(root, cwd, home, [fixturePane(root, cwd)])).toBe(path);
});

shortIt("requires a submitted first prompt and exact answer, not a composer or quote (control)", async () => {
  await shortSession();
  for (const shown of [
    `OpenAI Codex (v1.0)\n› ${shortPrompt}`,
    shortScreen.replace(`› ${shortPrompt}`, `    › ${shortPrompt}`),
    shortScreen.replace(shortPrompt, "Check-fixture"),
    shortScreen.replace(shortPrompt, "Check fixture again"),
    shortScreen.replace(`› ${shortPrompt}`, `› Earlier request\n• Earlier answer\n› ${shortPrompt}`),
    shortScreen.replace(shortAnswer, "Ready"),
  ]) {
    screen = shown;
    expect(await resolve()).toBeNull();
  }
  shortRollout(path, shortPrompt, "Ready");
  screen = shortScreen.replace(shortAnswer, "Ready");
  expect(await resolve()).toBe(path); // regression: a tiny but exact answer is sufficient
  shortRollout(path, shortPrompt, "");
  screen = shortScreen.replace(shortAnswer, "");
  expect(await resolve()).toBeNull(); // control: no answer is not a submitted exchange
});

shortIt("retains older resumed later turns as competitors to a new first prompt", async () => {
  const created = await shortSession();
  const old = join(home, "sessions", "old.jsonl");
  shortRollout(old, "Original request", "Original answer");
  appendFileSync(old, [
    { type: "event_msg", payload: { type: "user_message", message: shortPrompt } },
    { type: "event_msg", payload: { type: "agent_message", message: shortAnswer } },
  ].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
  addShortThread("old", old, created - 60_000, "Original request");
  expect(await resolve()).toBeNull();
});

shortIt("allows a readable older thread whose exchange cannot explain the screen", async () => {
  const created = await shortSession();
  const old = join(home, "sessions", "old.jsonl");
  shortRollout(old, "Original request", "An unrelated original answer.");
  addShortThread("old", old, created - 60_000, "Original request");
  expect(await resolve()).toBe(path);
});

shortIt("checks every exchange in a tool-heavy older thread instead of rejecting its file size", async () => {
  const created = await shortSession();
  const old = join(home, "sessions", "tool-heavy.jsonl");
  shortRollout(old, "Original request", "An unrelated original answer.");
  const output = JSON.stringify({ type: "response_item", payload: { type: "function_call_output", call_id: "tool", output: "x".repeat(64 * 1024) } }) + "\n";
  appendFileSync(old, output.repeat(20));
  addShortThread("old", old, created - 60_000, "Original request");
  expect(await resolve()).toBe(path);
  appendFileSync(old, [
    { type: "event_msg", payload: { type: "user_message", message: shortPrompt } },
    { type: "event_msg", payload: { type: "agent_message", message: shortAnswer } },
  ].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
  expect(await resolve()).toBeNull();
});

shortIt("reads an older rollout once, then only what is appended to it", async () => {
  const created = await shortSession();
  const old = join(home, "sessions", "tool-heavy.jsonl");
  shortRollout(old, "Original request", "An unrelated original answer.");
  const output = JSON.stringify({ type: "response_item", payload: { type: "function_call_output", call_id: "tool", output: "x".repeat(64 * 1024) } }) + "\n";
  appendFileSync(old, output.repeat(20));
  addShortThread("old", old, created - 60_000, "Original request");
  utimesSync(old, 1_700_000_000, 1_700_000_000);
  expect(await resolve()).toBe(path);
  // Same inode, size and mtime: a second read would hit this broken line and give up.
  const fd = openSync(old, "r+");
  writeSync(fd, "\"", statSync(old).size - 100);
  closeSync(fd);
  utimesSync(old, 1_700_000_000, 1_700_000_000);
  expect(await resolve()).toBe(path);
  // Grown: only the appended lines are read, so the broken line above stays unread.
  appendFileSync(old, output);
  expect(await resolve()).toBe(path);
  appendFileSync(old, [
    { type: "event_msg", payload: { type: "user_message", message: shortPrompt } },
    { type: "event_msg", payload: { type: "agent_message", message: shortAnswer } },
  ].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
  expect(await resolve()).toBeNull();
});

shortIt("rejects cumulative retained messages over the short matching limit", async () => {
  const created = await shortSession();
  const other = join(home, "sessions", "other.jsonl");
  shortRollout(other, "Other fixture", "A different short reply.");
  addShortThread("other", other, created - 60_000, "Other fixture");
  const message = JSON.stringify({ type: "event_msg", payload: { type: "agent_message", message: "x".repeat(64 * 1024) } }) + "\n";
  appendFileSync(other, message.repeat(15));
  expect(await resolve()).toBe(path);
  appendFileSync(other, message.repeat(2));
  expect(await resolve()).toBeNull();
});

shortIt("does not erase unreadable older or new threads to manufacture uniqueness", async () => {
  const created = await shortSession();
  const missing = join(home, "sessions", "missing.jsonl");
  addShortThread("missing", missing, created - 60_000);
  expect(await resolve()).toBeNull();
  const db = new Database(join(home, "state_5.sqlite"));
  db.query("UPDATE threads SET created_at_ms = ? WHERE id = 'missing'").run(created);
  db.close();
  expect(await resolve()).toBeNull();
});

shortIt("rejects two new readable threads even when only one exchange matches", async () => {
  const created = await shortSession();
  const other = join(home, "sessions", "other.jsonl");
  shortRollout(other, "Other fixture", "Another unrelated answer.");
  addShortThread("other", other, created);
  expect(await resolve()).toBeNull();
});

shortIt("rejects candidate overflow instead of hiding ambiguity past the limit", async () => {
  const created = await shortSession();
  for (let index = 0; index < 34; index++) {
    addShortThread(`other-${index}`, join(home, "sessions", `missing-${index}.jsonl`), created);
  }
  expect(await resolve()).toBeNull();
});

shortIt("excludes exec, subagent and archived rows from interactive uniqueness", async () => {
  const created = await shortSession();
  for (const [source, role, archived] of [["exec", null, 0], ["cli", "worker", 0], ["cli", null, 1]] as const) {
    addShortThread(`excluded-${source}-${role}-${archived}`, join(home, "sessions", "missing.jsonl"), created, shortPrompt, source, role, archived);
  }
  expect(await resolve()).toBe(path);
});

shortIt("rejects unsafe, incomplete, malformed and history-derived rollouts", async () => {
  await shortSession();
  const outside = join(root, "outside.jsonl");
  shortRollout(outside);
  rmSync(path);
  symlinkSync(outside, path);
  expect(await resolve()).toBeNull();
  rmSync(path);
  shortRollout(path);
  appendFileSync(path, '{"type":');
  expect(await resolve()).toBeNull();
  shortRollout(path);
  appendFileSync(path, "not json\n");
  expect(await resolve()).toBeNull();
  shortRollout(path);
  appendFileSync(path, " ".repeat(1024 * 1024));
  expect(await resolve()).toBeNull();
  writeFileSync(path, JSON.stringify({ type: "session_meta", payload: { id: thread, history_base: { path: outside } } }) + "\n");
  expect(await resolve()).toBeNull();
});

shortIt("does not borrow another same-directory pane's thread, even without a binding", async () => {
  await shortSession();
  const panes = [fixturePane(root), fixturePane("peer")];
  expect(await codexTranscriptPath(root, root, home, panes)).toBeNull();
  expect(await codexTranscriptPath("peer", root, home, panes)).toBeNull();
});

shortIt("rejects a thread already bound to another pane outside this directory", async () => {
  await shortSession();
  const panes = [fixturePane(root), fixturePane("peer", join(root, "elsewhere"))];
  // A long answer establishes the existing strong binding; then use short evidence.
  shortRollout(path, shortPrompt, answer);
  screen = answer;
  expect(await codexTranscriptPath("peer", root, home, panes)).toBe(path);
  shortRollout(path);
  screen = shortScreen;
  expect(await codexTranscriptPath(root, root, home, panes)).toBeNull();
});

shortIt("rejects unavailable process starts and timestamps before the process could have started", async () => {
  const created = await shortSession();
  const started = processStartedAt(foreground[0]!.pid)!;
  const db = new Database(join(home, "state_5.sqlite"));
  // below the start's lower bound on every platform (a tick on Linux, ps's second on macOS)
  db.query("UPDATE threads SET created_at_ms = ?").run(started - 2500);
  db.close();
  expect(await resolve()).toBeNull();
  const restored = new Database(join(home, "state_5.sqlite"));
  restored.query("UPDATE threads SET created_at_ms = ?").run(created);
  restored.close();
  foreground = [{ pid: 2147483647, argv: [join(root, "codex")] }];
  expect(await resolve()).toBeNull();
});

for (const argv of [
  ["echo", "/usr/bin/codex", "resume", thread],
  ["node", "-e", "/usr/bin/codex", "resume", thread],
  ["python", "/usr/bin/codex.js", "resume", thread],
  ["/bin/sh", "-c", "/usr/bin/codex", "resume", thread],
  ["node", "--eval", "/usr/bin/codex", "resume", thread],
  ["node", "--require", "/usr/bin/codex", "resume", thread],
  ["node", "--no-warnings", "-e", "/usr/bin/codex", "resume", thread],
  ["node", "--eval=setInterval(()=>{},1000)", "/usr/bin/codex", "resume", thread],
  ["node", "--title", "/usr/bin/codex", "--eval=setInterval(()=>{},1000)", "resume", thread],
  ["node", "--import=./hook.mjs", "/usr/bin/codex", "resume", thread],
  ["/usr/bin/not-codex", "resume", thread],
]) {
  it(`ignores unrelated executable or command arguments: ${argv.slice(0, 3).join(" ")}`, async () => {
    foreground = [{ pid: 2147483647, argv }];
    expect(await resolve()).toBeNull();
  });
}

for (const executable of [
  ["/usr/bin/codex"],
  ["node", "/usr/lib/codex.js"],
  ["/bin/sh", "/usr/bin/codex"],
  ["bun", "/usr/lib/codex.js"],
  ["node", "--no-warnings", "/usr/bin/codex"],
  ["bash", "--", "/usr/bin/codex"],
  ["zsh", "/usr/bin/codex"],
  ["node", "--max-old-space-size=4096", "--no-warnings", "/usr/lib/codex.js"],
  ["node", "--title=codex", "--enable-source-maps", "/usr/lib/codex.js"],
  ["C:\\tools\\codex.exe"],
  ["C:\\tools\\node.exe", "C:\\tools\\codex.js"],
]) {
  it(`preserves resume selection for ${executable.join(" ")}`, async () => {
    foreground = [{ pid: 2147483647, argv: [...executable, "resume", thread] }];
    expect(await resolve()).toBe(path);
  });
}

shortIt("finds a profile's short conversation after native completion footers", async () => {
  await shortSession();
  const db = new Database(join(home, "state_5.sqlite"));
  db.query("UPDATE threads SET source = 'vscode', first_user_message = 'hi'").run();
  db.close();
  shortRollout(path, "hi", "Hi! What would you like to work on?");
  appendFileSync(path, [
    { type: "event_msg", payload: { type: "user_message", message: "hi" } },
    { type: "event_msg", payload: { type: "agent_message", message: "Hi again! How can I help?" } },
  ].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
  screen = "OpenAI Codex (v0.163.0)\n• Model changed to gpt-6-luna medium\n\n"
    + "› hi\n\n• Hi! What would you like to work on?\n\n  Worked for 1s • 11:11 AM\n\n"
    + "› hi\n\n• Hi again! How can I help?\n\n  Worked for 2s • 11:11 AM\n\n› Ask Codex to do anything";
  expect(await resolve()).toBe(path);
});

// --- what is not this pane's conversation: another conversation's prompts, a herdr report alone, a quote ---

describe("another session's conversation is never shown for a plain Codex pane", () => {
  const live = [{ pid: 2147483647, argv: ["/usr/bin/codex"] }];
  const shortReplies = ["The build finished without errors this time.", "All checks on the feature branch pass again."];
  /** This folder's thread (another pane's, A) and one of another folder this pane shows (B): the same short answers to other prompts. */
  function sameAnswersOtherPrompts(): string {
    writeFileSync(path, [
      { type: "session_meta", payload: { id: thread, cwd: root } },
      { type: "event_msg", payload: { type: "user_message", message: "Build the release for the first fixture" } },
      { type: "event_msg", payload: { type: "agent_message", message: shortReplies[0] } },
      { type: "event_msg", payload: { type: "user_message", message: "Now check the first fixture's branch" } },
      { type: "event_msg", payload: { type: "agent_message", message: shortReplies[1] } },
    ].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
    otherFolderThread([
      { type: "user_message", message: "Build the second fixture elsewhere" },
      { type: "agent_message", message: shortReplies[0]! },
      { type: "user_message", message: "And check that second fixture's branch" },
      { type: "agent_message", message: shortReplies[1]! },
    ]);
    return `OpenAI Codex (v0.165.0)\n\n› Build the second fixture elsewhere\n\n• ${shortReplies[0]}\n\n› And check that second fixture's branch\n\n• ${shortReplies[1]}\n\n› `;
  }

  // the pane's process read live, absent, or absent between two live reads (#2420's review, H1)
  for (const [name, reads] of [["live", [live]], ["absent", [null]], ["live, absent, live", [live, null, live]]] as const) {
    it(`takes no short answers another conversation gave to the prompts the screen shows (process reads: ${name})`, async () => {
      screen = sameAnswersOtherPrompts();
      foreground = live;
      processReads = [...reads];
      expect(await resolve()).toBeNull();
    });
  }

  it("takes no short answers given to prompts that differ from the shown ones only in punctuation", async () => {
    const replies = ["The condition evaluates to true in this example.", "All checks on the feature branch pass again."];
    writeFileSync(path, [
      { type: "session_meta", payload: { id: thread, cwd: root } },
      { type: "event_msg", payload: { type: "user_message", message: "Check whether a < b for these inputs" } },
      { type: "event_msg", payload: { type: "agent_message", message: replies[0] } },
      { type: "event_msg", payload: { type: "user_message", message: "Check the branch named feature-one" } },
      { type: "event_msg", payload: { type: "agent_message", message: replies[1] } },
    ].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
    otherFolderThread([
      { type: "user_message", message: "Check whether a > b for these inputs" },
      { type: "agent_message", message: replies[0]! },
      { type: "user_message", message: "Check the branch named feature_one" },
      { type: "agent_message", message: replies[1]! },
    ]);
    foreground = live;
    screen = `OpenAI Codex (v0.165.0)\n\n› Check whether a > b for these inputs\n\n• ${replies[0]}\n\n› Check the branch named feature_one\n\n• ${replies[1]}\n\n› `;
    expect(await resolve()).toBeNull();
  });

  it("still takes short answers below the prompts they answered", async () => {
    foreground = live;
    sameAnswersOtherPrompts();
    screen = `OpenAI Codex (v0.165.0)\n\n› Build the release for the first fixture\n\n• ${shortReplies[0]}\n\n› Now check the first fixture's branch\n\n• ${shortReplies[1]}\n\n› `;
    // B, of another folder, is no candidate here: only this folder's threads are weighed
    expect(await resolve()).toBe(path);
  });

  // a herdr report may be stale or the shared daemon's (#2420's review, H2)
  for (const kind of ["path", "id"] as const) {
    it(`binds nothing by a reported ${kind} alone that began before this pane's Codex, while another Codex pane here may run it`, async () => {
      // this pane's Codex started long after the reported thread began: a report an earlier Codex left, or another pane's
      const started = spyOn(processStart, "processStartLowerBound").mockReturnValue(1_000_000);
      const upper = spyOn(processStart, "processStartUpperBound").mockReturnValue(1_000_000);
      try { await reportedAlone(kind); } finally { started.mockRestore(); upper.mockRestore(); }
    });
  }

  async function reportedAlone(kind: "path" | "id"): Promise<void> {
    {
      foreground = live;
      reportedSession = { source: "herdr:codex", agent: "codex", kind, value: kind === "path" ? path : thread };
      peerScreens.set("peer", "");
      const panes = [fixturePane(root), fixturePane("peer")];
      expect(await codexTranscriptPath(root, root, home, panes)).toBeNull();
      expect(await codexOpenRollout(root, root, home)).toBeNull();
      // its answer on this pane's screen tells, as for any pane
      screen = `• ${answer}`;
      expect(await codexTranscriptPath(root, root, home, panes)).toBe(path);
    }
  }

  it("takes the reported thread as the pane's fresh conversation only when nothing else could have begun it", async () => {
    // this pane's Codex started at 1000 s; a peer's at 990 s or 1005 s
    const starts = new Map([[900001, 1_000_000], [900002, 990_000], [900003, 1_005_000]]);
    // the start read from below (peers) and from above (this pane) alike: the same instant here
    const bound = spyOn(processStart, "processStartLowerBound").mockImplementation((pid) => starts.get(pid) ?? null);
    const upper = spyOn(processStart, "processStartUpperBound").mockImplementation((pid) => starts.get(pid) ?? null);
    const setCreated = (seconds: number) => {
      const db = new Database(join(home, "state_5.sqlite"));
      db.query("UPDATE threads SET created_at = ?").run(seconds);
      db.close();
    };
    try {
      foreground = [{ pid: 900001, argv: ["/usr/bin/codex"] }];
      reportedSession = { source: "herdr:codex", agent: "codex", kind: "id", value: thread };
      // begun as this Codex started, its first answer not on screen yet: the chat and the background reader take it
      setCreated(1001);
      expect(await resolve()).toBe(path);
      expect(await codexOpenRollout(root, root, home)).toBe(path);
      // begun before this Codex started: a report an earlier one left
      setCreated(999);
      expect(await resolve()).toBeNull();
      expect(await codexOpenRollout(root, root, home)).toBeNull();
      setCreated(1001);
      // another Codex of this cwd was running when it began: it may be that pane's, reported here by the daemon
      foregrounds.set("peer", [{ pid: 900002, argv: ["/usr/bin/codex"] }]);
      peerScreens.set("peer", "");
      expect(await codexTranscriptPath(root, root, home, [fixturePane(root), fixturePane("peer")])).toBeNull();
      // nor one started in the very second it began, which a store of whole seconds cannot tell apart
      starts.set(900005, 1_001_290);
      foregrounds.set("peer", [{ pid: 900005, argv: ["/usr/bin/codex"] }]);
      expect(await codexTranscriptPath(root, root, home, [fixturePane(root), fixturePane("peer")])).toBeNull();
      // one started after it began did not
      foregrounds.set("peer", [{ pid: 900003, argv: ["/usr/bin/codex"] }]);
      expect(await codexTranscriptPath(root, root, home, [fixturePane(root), fixturePane("peer")])).toBe(path);
      // another Codex pane in another folder, running when it began: `codex -C` or a resume opens a thread of this one
      foregrounds.set("peer", [{ pid: 900002, argv: ["/usr/bin/codex"] }]);
      expect(await codexTranscriptPath(root, root, home, [fixturePane(root), fixturePane("peer", join(root, "elsewhere"))])).toBeNull();
      // begun after the earliest this Codex may have started, but maybe before it did: an earlier Codex's
      starts.set(900004, 1_000_500);
      foreground = [{ pid: 900004, argv: ["/usr/bin/codex"] }];
      upper.mockImplementation((pid) => pid === 900004 ? 1_001_500 : starts.get(pid) ?? null);
      expect(await resolve()).toBeNull();
      foreground = [{ pid: 900001, argv: ["/usr/bin/codex"] }];
      upper.mockImplementation((pid) => starts.get(pid) ?? null);
      // nor after a newer thread of the cwd began (a /new)
      const db = new Database(join(home, "state_5.sqlite"));
      db.query("INSERT INTO threads VALUES (?, ?, ?, 0, NULL, 1002, 1002, 'cli')").run("01a0c7a1-56d9-7e20-9f08-f7a2d973bc02", join(home, "sessions", "missing.jsonl"), root);
      db.close();
      expect(await resolve()).toBeNull();
    } finally { bound.mockRestore(); upper.mockRestore(); }
  });

  it("reads nothing from a screen once the pane's last process lookup finds no Codex", async () => {
    // Given a pane showing this cwd thread's long answer, as an earlier occupant left it on screen
    screen = `OpenAI Codex (v0.165.0)\n\n› Explain the selection\n\n• ${answer}\n\n› `;
    // When herdr's process facts for the lookup show no Codex any more
    foreground = live;
    // every read of herdr's process facts this lookup makes (agent.get's and the process lookup's)
    processReads = [[], []];
    // Then nothing ties the screen to a running Codex: the terminal stands in
    expect(await resolve()).toBeNull();
  });

  it("takes no long answer that differs from the shown one in its punctuation", async () => {
    const answers = [
      ["After carefully reviewing the requested configuration, the decisive result is a < b and all remaining verification steps completed successfully.",
        "After carefully reviewing the requested configuration, the decisive result is a > b and all remaining verification steps completed successfully."],
      ["After carefully reviewing the requested configuration, the decisive result is a != b and all remaining verification steps completed successfully.",
        "After carefully reviewing the requested configuration, the decisive result is a = b and all remaining verification steps completed successfully."],
      ["After carefully reviewing the requested configuration, the branch to release is feature-one and all remaining verification steps completed successfully.",
        "After carefully reviewing the requested configuration, the branch to release is feature_one and all remaining verification steps completed successfully."],
    ] as const;
    for (const [index, [said, shown]] of answers.entries()) {
      // a Codex process of its own each time: a pane a match bound keeps that rollout while its screen says nothing new
      foreground = [{ pid: 2147483640 - index, argv: ["/usr/bin/codex"] }];
      // Given this cwd's thread said one answer, and the pane shows its own conversation's other one
      writeFileSync(path, [
        { type: "session_meta", payload: { id: thread, cwd: root } },
        { type: "event_msg", payload: { type: "user_message", message: "Review the configuration" } },
        { type: "event_msg", payload: { type: "agent_message", message: said } },
      ].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
      screen = `OpenAI Codex (v0.165.0)\n\n› Check the release configuration\n\n• ${shown}\n\n› `;
      expect(await resolve()).toBeNull();
      // and the same answer, as said, still tells
      screen = `OpenAI Codex (v0.165.0)\n\n› Review the configuration\n\n• ${said}\n\n› `;
      expect(await resolve()).toBe(path);
    }
  });

  it("reads no long answer whose markdown Codex renders its own way: the terminal stands in rather than a guess", async () => {
    const raw = "The **migration** now rewrites `legacy_records` in place, as _the important result_ shows; see [the plan](docs/plan.md) and:\n- every check passes, including a < b";
    writeFileSync(path, [
      { type: "session_meta", payload: { id: thread, cwd: root } },
      { type: "event_msg", payload: { type: "user_message", message: "Summarize the migration" } },
      { type: "event_msg", payload: { type: "agent_message", message: raw } },
    ].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
    foreground = live;
    screen = "OpenAI Codex (v0.165.0)\n\n› Summarize the migration\n\n• The migration now rewrites legacy_records in place, as the important result shows; see the plan\n  (docs/plan.md) and:\n  - every check passes, including a < b\n\n› ";
    expect(await resolve()).toBeNull();
  });

  it("still reads a long answer however the screen wraps it, and no answer starting like a tool call or with markdown", async () => {
    const cases = [
      // a wrap before a spaced dash, a year, a plus
      ["The release notes list every change since the last tag - including the migration of the legacy records and the new reports.", "The release notes list every change since the last tag\n  - including the migration of the legacy records and the new reports."],
      ["The migration of the legacy records finished early in 2026. After that every report used the new schema and passed its checks.", "The migration of the legacy records finished early in\n  2026. After that every report used the new schema and passed its checks."],
      ["The two configurations differ in one setting + the timeout, which the new release raises for every slow report it builds.", "The two configurations differ in one setting\n  + the timeout, which the new release raises for every slow report it builds."],
    ] as const;
    for (const [index, [said, shown]] of cases.entries()) {
      foreground = [{ pid: 2147483630 - index, argv: ["/usr/bin/codex"] }];
      writeFileSync(path, [
        { type: "session_meta", payload: { id: thread, cwd: root } },
        { type: "event_msg", payload: { type: "user_message", message: "Summarize the release" } },
        { type: "event_msg", payload: { type: "agent_message", message: said } },
      ].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
      screen = `OpenAI Codex (v0.165.0)\n\n› Summarize the release\n\n• ${shown}\n\n› `;
      expect([index, await resolve()]).toEqual([index, path]);
    }
    // an answer that starts like a tool call, or ends in markdown Codex renders its own way: the terminal stands in
    const fallbacks = [
      // an answer that starts with a word a tool call also starts with
      ["Running the full suite again showed every check passing, so the migration of the legacy records is complete and safe.", "Running the full suite again showed every check passing, so the migration of the legacy records is complete and safe."],
      ["Ran the full test suite and verified that all checks pass successfully across the migrated legacy records and reports.", "Ran the full test suite and verified that all checks pass successfully across the migrated legacy records and reports."],
      // an autolink, which Codex shows without its brackets
      ["The migration guide is published at <https://example.com/migration> and covers every legacy record the reports still read.", "The migration guide is published at https://example.com/migration and covers every legacy record the reports still read."],
    ] as const;
    for (const [index, [said, shown]] of fallbacks.entries()) {
      foreground = [{ pid: 2147483600 - index, argv: ["/usr/bin/codex"] }];
      writeFileSync(path, [
        { type: "session_meta", payload: { id: thread, cwd: root } },
        { type: "event_msg", payload: { type: "user_message", message: "Summarize the release" } },
        { type: "event_msg", payload: { type: "agent_message", message: said } },
      ].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
      screen = `OpenAI Codex (v0.165.0)\n\n› Summarize the release\n\n• ${shown}\n\n› `;
      expect([index, await resolve()]).toEqual([index, null]);
    }
  });

  it("takes no answer the screen shows with more at either end (#2430's review, H3)", async () => {
    const said = "After carefully reviewing the requested configuration, the decisive offset is base and all remaining verification steps completed";
    writeFileSync(path, [
      { type: "session_meta", payload: { id: thread, cwd: root } },
      { type: "event_msg", payload: { type: "user_message", message: "Review the configuration" } },
      { type: "event_msg", payload: { type: "agent_message", message: said } },
    ].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
    for (const [index, shown] of [`${said}.`, `Briefly: ${said}`].entries()) {
      foreground = [{ pid: 2147483580 - index, argv: ["/usr/bin/codex"] }];
      screen = `OpenAI Codex (v0.165.0)\n\n› Check the configuration\n\n• ${shown}\n\n› `;
      expect([shown, await resolve()]).toEqual([shown, null]);
    }
    foreground = [{ pid: 2147483578, argv: ["/usr/bin/codex"] }];
    screen = `OpenAI Codex (v0.165.0)\n\n› Review the configuration\n\n• ${said}\n\n› `;
    expect(await resolve()).toBe(path);
  });

  it("takes no answer differing in a number or an operator, nor one quoted by consecutive running calls (#2430's review)", async () => {
    const said = "After carefully reviewing the requested configuration, the decisive offset is base + 1 and all remaining verification steps completed.";
    writeFileSync(path, [
      { type: "session_meta", payload: { id: thread, cwd: root } },
      { type: "event_msg", payload: { type: "user_message", message: "Review the configuration" } },
      { type: "event_msg", payload: { type: "agent_message", message: said } },
    ].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
    foreground = [{ pid: 2147483590, argv: ["/usr/bin/codex"] }];
    screen = `OpenAI Codex (v0.165.0)\n\n› Check the configuration\n\n• ${said.replace("base + 1", "base - 1")}\n\n› `;
    expect(await resolve()).toBeNull();
    foreground = [{ pid: 2147483591, argv: ["/usr/bin/codex"] }];
    screen = `OpenAI Codex (v0.165.0)\n\n› Run both\n\n• Running printf "${said}"\n\n• Running sleep 5\n\n• Working (3s • esc to interrupt)\n\n› `;
    expect(await resolve()).toBeNull();
  });

  it("knows Codex by its release binary's name and a Windows file name in any case", async () => {
    screen = `OpenAI Codex (v0.165.0)\n\n› Explain the selection\n\n• ${answer}\n\n› `;
    for (const [index, executable] of ["/opt/codex/codex-x86_64-unknown-linux-musl", "C:\\Tools\\Codex.exe"].entries()) {
      foreground = [{ pid: 2147483620 - index, argv: [executable] }];
      expect([executable, await resolve()]).toEqual([executable, path]);
    }
  });

  it("takes no long answer a tool call's command quotes", async () => {
    foreground = live;
    for (const shown of [
      `• Ran printf "${answer}"\n  └ command is still running`,
      `• Running printf "${answer}"`,
      // a heredoc Codex shows with "│" lines, and no output yet
      `• Ran cat <<'EOF'\n  │ ${answer}\n  │ EOF`,
      // a shell command the user ran from the composer
      `• You ran printf "${answer}"\n  └ (no output)`,
    ]) {
      screen = `OpenAI Codex (v0.165.0)\n\n› Execute the diagnostic\n\n${shown}\n\n• Working (3s • esc to interrupt)\n\n› `;
      expect(await resolve()).toBeNull();
    }
  });

  it("takes no long answer the pane only quotes in a prompt (#2420's review, H3)", async () => {
    foreground = live;
    screen = `OpenAI Codex (v0.165.0)\n\n› Explain this quoted answer: ${answer}\n\n• Working (2s • esc to interrupt)\n\n› `;
    expect(await resolve()).toBeNull();
    // nor one typed into the input box
    screen = `OpenAI Codex (v0.165.0)\n\n› ${answer}`;
    expect(await resolve()).toBeNull();
    // nor one in a message queued to be sent
    screen = `OpenAI Codex (v0.165.0)\n\n• Working (2s • esc to interrupt)\n  ↳ Explain this quoted answer: ${answer}\n\n› `;
    expect(await resolve()).toBeNull();
  });
});
