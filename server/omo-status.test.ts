import { afterAll, describe, expect, it } from "bun:test";
import { appendFileSync, chmodSync, closeSync, mkdirSync, mkdtempSync, openSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AgentStatus, HerdrPane, SessionSnapshot } from "../shared/protocol.ts";
import { CompletionTracker, type OmoRest } from "./completion.ts";
import { Finishes } from "./finishes.ts";
import { createGjcStatus } from "./gjc-status.ts";
import { createServer } from "./index.ts";
import { paneAfterStatus } from "./machines.ts";
import { earliestStart, holderStartedAt } from "./omo.ts";
import { projectStateKey } from "./omo-state-dir.ts";
import { noTurn, OMO_ALIASES, omoBackgroundTasks, omoSessionId, OmoStatus, omoTurnAfter, omoTurnStatus, readLines, type OmoLine, type OmoPane } from "./omo-status.ts";

const root = mkdtempSync(join(tmpdir(), "herdr-omo-status-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

// records as OmO 5.1.7 writes them
const message = (role: string, stopReason?: string, at = "2026-10-02T00:00:10.000Z", text = "") => JSON.stringify({ type: "message", id: "x", parentId: null, timestamp: at, message: { role, content: [{ type: "text", text }], ...(stopReason ? { stopReason } : {}) } });
const runtime = (customType: string) => JSON.stringify({ type: "custom_message", customType, display: false, content: "…", timestamp: "2026-10-02T00:00:20.000Z" });
const bookkeeping = (customType: string) => JSON.stringify({ type: "custom", customType });
const lines = (...entries: string[]) => entries.join("\n") + "\n";
// an answer written after the failures below
const LATER = "2026-10-02T00:02:00.000Z";
// the answer OmO records for a request the provider gave up on (OmO 5.1.28)
const failure = (text: string) => JSON.stringify({ type: "message", timestamp: "2026-10-02T00:01:00.000Z", message: { role: "assistant", content: [], stopReason: "error", errorMessage: text } });
// a question for the user, as OmO 5.1.19 records it: the call, the result of one asked without waiting, its settlement
const asking = (id: string, waitForAnswer: boolean) => JSON.stringify({ type: "message", timestamp: "2026-10-02T00:00:30.000Z", message: { role: "assistant", stopReason: "toolUse", content: [{ type: "toolCall", id, name: "ask_user_question", arguments: { questions: [{ header: "Place", question: "Where?", multiSelect: false, options: [{ label: "a" }, { label: "b" }] }], waitForAnswer } }] } });
const result = (id: string, details: Record<string, unknown> = {}, isError = false) => JSON.stringify({ type: "message", timestamp: "2026-10-02T00:00:40.000Z", message: { role: "toolResult", toolCallId: id, toolName: "ask_user_question", content: [], details, isError } });
const acceptedResult = (id: string) => result(id, { accepted: true, status: "pending" });
const settled = (id: string) => JSON.stringify({ type: "custom", customType: "ask-user:settlement", data: { requestId: id, status: "answered" } });
const openAsks = (...entries: string[]) => entries.reduce((turn, entry) => omoTurnAfter(turn, { text: entry }), noTurn()).asks.map((call) => call.id);

describe("an OmO turn, read from its session file", () => {
  it("runs from a prompt through its tool calls, and is over at an answer that stopped for good", () => {
    expect(omoTurnStatus(lines(message("user")))).toBe("working");
    expect(omoTurnStatus(lines(message("user"), bookkeeping("claude-sdk-oauth-binding"), message("assistant", "toolUse")))).toBe("working");
    expect(omoTurnStatus(lines(message("user"), message("assistant", "toolUse"), message("toolResult")))).toBe("working");
    expect(omoTurnStatus(lines(message("user"), message("assistant", "toolUse"), message("toolResult"), message("assistant", "stop")))).toBe("idle");
    expect(omoTurnStatus(lines(message("user"), message("assistant", "aborted")))).toBe("idle");
  });

  it("is over at an answer that ended in an error, and runs again when a retry answers", () => {
    // seen in real files: an error, OmO's stop record 2 ms later, then a retry 2 to 16 s later all the same
    expect(omoTurnStatus(lines(message("user"), message("assistant", "error")))).toBe("idle");
    expect(omoTurnStatus(lines(message("user"), message("assistant", "error"), bookkeeping("senpi.hooks.stop-state"), message("assistant", "error")))).toBe("idle");
    expect(omoTurnStatus(lines(message("user"), message("assistant", "error"), message("assistant", "toolUse")))).toBe("working");
    expect(omoTurnStatus(lines(message("user"), message("assistant", "error"), bookkeeping("senpi.hooks.stop-state"), runtime("goal-continuation")))).toBe("working");
    // OmO's stop record says nothing of the turn: it is held back while a background task runs
    expect(omoTurnStatus(lines(message("user"), message("assistant", "toolUse"), bookkeeping("senpi.hooks.stop-state")))).toBe("working");
  });

  it("holds a question for the user open until it has its answer", () => {
    // one that waits: until its result, or a newer answer of the agent's
    expect(openAsks(message("user"), asking("q1", true))).toEqual(["q1"]);
    expect(openAsks(message("user"), asking("q1", true), result("q1"))).toEqual([]);
    // one that does not wait: accepted at once, the turn goes on and ends, and it stays open until settled
    const asked = [message("user"), asking("q2", false), acceptedResult("q2"), message("assistant", "stop")];
    expect(openAsks(...asked)).toEqual(["q2"]);
    expect(openAsks(...asked, settled("q2"))).toEqual([]);
    expect(openAsks(...asked, JSON.stringify({ type: "message", message: { role: "user", content: [{ type: "text", text: "[Answer to question q2]\nPlace: a" }] } }))).toEqual([]);
    // refused (a malformed call): closed by its error
    expect(openAsks(asking("q3", false), result("q3", {}, true))).toEqual([]);
    // a record too long to hold, read by its ends
    const long = asking("q4", false).replace('"content":[', `"content":[{"type":"thinking","thinking":"${"x".repeat(200_000)}"},`);
    const ends = { head: long.slice(0, 4096), tail: long.slice(-4096), record: long };
    expect(omoTurnAfter(noTurn(), ends).asks.map((call) => [call.id, call.wait])).toEqual([["q4", false]]);
  });

  it("starts with one of the runtime's own messages, nobody typing", () => {
    const rested = [message("user"), message("assistant", "stop"), bookkeeping("senpi.hooks.stop-state")];
    for (const start of ["omo-senpi:wake", "senpi-monitor:notification", "senpi-terminal:notification", "goal-continuation", "senpi.todo-owed", "senpi-codemode:notification", "omo-init-deep-advisor:run", "omo-onboarding:bootstrap", "ttsr-injection"]) {
      expect(omoTurnStatus(lines(...rested, runtime(start)))).toBe("working");
    }
    // what OmO notes down after a finished answer starts nothing
    for (const note of ["omo-memory:notice", "omo-kibitzer:recall", "senpi-task.usage", "environment-context"]) expect(omoTurnStatus(lines(...rested, runtime(note)))).toBe("idle");
    expect(omoTurnStatus(lines(...rested, bookkeeping("goal-cache-warmup"), bookkeeping("omo-memory:accepted-turns")))).toBe("idle");
    expect(omoTurnStatus(lines(bookkeeping("pi-rules.scan"), "not json"))).toBeNull();
  });

  it("reads a record of any size by its ends, and only whole lines", () => {
    const path = join(root, "2026-10-02T00-00-00-000Z_01a0f88b-481c-7139-8125-c9cd453b9e17.jsonl");
    const big = "x".repeat(400_000);
    // a prompt and an answer each far longer than a read holds
    writeFileSync(path, lines(message("assistant", "stop"), message("user", undefined, "2026-10-02T00:01:00.000Z", big)));
    const read = (from = 0) => {
      const seen: OmoLine[] = [];
      const fd = openSync(path, "r");
      try { return { offset: readLines(fd, from, statSync(path).size, (line) => seen.push(line)), seen }; } finally { closeSync(fd); }
    };
    let { seen, offset } = read();
    expect(seen.map((line) => "text" in line ? "whole" : "ends")).toEqual(["whole", "ends"]);
    expect(seen.reduce(omoTurnAfter, noTurn())).toMatchObject({ status: "working", at: Date.parse("2026-10-02T00:01:00.000Z") });
    expect(offset).toBe(statSync(path).size);
    writeFileSync(path, lines(message("user"), message("assistant", "stop", "2026-10-02T00:02:00.000Z", big)));
    expect(read().seen.reduce(omoTurnAfter, noTurn()).status).toBe("idle");
    writeFileSync(path, lines(message("user"), message("assistant", "toolUse", "2026-10-02T00:02:00.000Z", big)));
    expect(read().seen.reduce(omoTurnAfter, noTurn()).status).toBe("working");
    // a last line still being written waits for its newline
    writeFileSync(path, lines(message("user")) + message("assistant", "stop").slice(0, 40));
    ({ seen, offset } = read());
    expect(seen).toHaveLength(1);
    expect(offset).toBe(Buffer.byteLength(lines(message("user"))));
    expect(omoSessionId(path)).toBe("01a0f88b-481c-7139-8125-c9cd453b9e17");
  });

  it("counts each session's running background tasks, not a dead host's", () => {
    const cwd = join(root, "project");
    const tasks = join(cwd, ".omo", "senpi-task", "tasks");
    mkdirSync(tasks, { recursive: true });
    const task = (name: string, record: Record<string, unknown>) => writeFileSync(join(tasks, name), JSON.stringify(record));
    task("st_1.json", { task_id: "st_1", status: "running", parent_session_id: "mine", host_pid: 10 });
    task("st_2.json", { task_id: "st_2", status: "completed", parent_session_id: "mine", host_pid: 10 });
    task("st_3.json", { task_id: "st_3", status: "running", parent_session_id: "other", host_pid: 10 });
    task("st_4.json", { task_id: "st_4", status: "running", parent_session_id: "mine", host_pid: 99 });
    task("st_5.json", { task_id: "st_5", status: "pending", parent_session_id: "mine" });
    writeFileSync(join(tasks, "st_6.json"), "{half");
    expect(Object.fromEntries(omoBackgroundTasks(cwd, (pid) => pid === 10))).toEqual({ mine: 2, other: 1 });
    expect(omoBackgroundTasks(join(root, "nowhere"), () => true, { env: {}, home: root }).size).toBe(0);
  });

  it("counts pending and running external tasks, with legacy records taking precedence", () => {
    const cwd = join(root, "external-project");
    const agentDir = join(root, "agent");
    const options = { env: { OMO_CODING_AGENT_DIR: agentDir }, home: root };
    const tasks = join(agentDir, "projects", projectStateKey(cwd), "senpi-task", "tasks");
    mkdirSync(tasks, { recursive: true });
    for (const [index, status] of ["pending", "running", "error", "interrupted"].entries()) {
      writeFileSync(join(tasks, `st_${index}.json`), JSON.stringify({ status, parent_session_id: "mine", host_pid: 10 }));
    }
    expect(Object.fromEntries(omoBackgroundTasks(cwd, () => true, options))).toEqual({ mine: 2 });
    expect(omoBackgroundTasks(cwd, () => false, options).size).toBe(0);
    const legacy = join(cwd, ".omo", "senpi-task", "tasks");
    mkdirSync(legacy, { recursive: true });
    writeFileSync(join(legacy, "st_old.json"), JSON.stringify({ status: "pending", parent_session_id: "legacy" }));
    expect(Object.fromEntries(omoBackgroundTasks(cwd, () => true, options))).toEqual({ legacy: 1 });
  });
});

describe("OmO panes' status in place of herdr's", () => {
  const pane = (id: string, agent: string | null, status: AgentStatus): HerdrPane => ({ pane_id: id, agent, agent_status: status, cwd: "/work" } as unknown as HerdrPane);
  const snapshotOf = (...panes: HerdrPane[]): SessionSnapshot => ({ panes, agents: panes.map((p) => ({ pane_id: p.pane_id, agent: p.agent, agent_status: p.agent_status })) } as unknown as SessionSnapshot);
  /** herdr as #286 saw it: an OmO pane reads claude/idle whatever it does */
  const herdr = () => snapshotOf(pane("omo", "claude", "idle"), pane("lost", "claude", "idle"), pane("claude", "claude", "working"), pane("shell", null, "unknown"));
  const FILE = "/s/2026_01a0f88b-481c-7139-8125-c9cd453b9e17.jsonl";

  function setup(initial = lines(message("user"), message("assistant", "stop"))) {
    const files: Record<string, string> = { [FILE]: initial };
    const ids: Record<string, string> = {};
    const told: ([string, AgentStatus, number, boolean] | [string, AgentStatus, number, boolean, OmoRest])[] = [];
    const found: string[] = [];
    const again: boolean[] = [];
    const backgroundCwds: string[] = [];
    const state = { background: 0, discovered: new Map<string, OmoPane>([["omo", { path: FILE, startedAt: null }], ["lost", { path: null, startedAt: null }]]), lookups: 0, clock: 0, failing: false, during: () => {} };
    const omo = new OmoStatus({
      // the session of `lost` cannot be told (two OmO panes in one folder without /proc)
      discover: async () => { state.lookups += 1; state.during(); return new Map(state.discovered); },
      snapshot: async () => herdr(),
      onChange: (id, status, count, turn, rest) => told.push(rest ? [id, status, count, turn, rest] : [id, status, count, turn]),
      onFound: (id, held) => { found.push(id); again.push(held); },
      file: {
        stat: (path) => path in files ? { size: Buffer.byteLength(files[path]!), id: ids[path] ?? "1" } : null,
        lines: (path, from, size, each) => { if (state.failing) return from; const text = Buffer.from(files[path]!).subarray(from, size).toString("utf8"); const whole = text.slice(0, text.lastIndexOf("\n") + 1); for (const line of whole.split("\n").slice(0, -1)) each({ text: line }); return from + Buffer.byteLength(whole); },
      },
      background: (cwd) => { backgroundCwds.push(cwd); return new Map([["01a0f88b-481c-7139-8125-c9cd453b9e17", state.background]]); },
      now: () => state.clock,
    });
    const append = (...entries: string[]) => { files[FILE] += lines(...entries); };
    /** the file put anew in place of the old one, as a rewrite does */
    const replace = (...entries: string[]) => { files[FILE] = lines(...entries); ids[FILE] = `${Number(ids[FILE] ?? 1) + 1}`; };
    return { omo, told, found, again, append, replace, state, files, backgroundCwds };
  }
  const statuses = (snapshot: SessionSnapshot) => Object.fromEntries(snapshot.panes.map((p) => [p.pane_id, `${p.agent}/${p.agent_status}`]));

  it("identifies successive native finishes even when herdr's status and seq never change", async () => {
    const { omo, append } = setup(lines(message("user")));
    const completions = new CompletionTracker();
    const finishes = new Finishes(() => "daemon-a");
    const served = async () => finishes.snapshot(await completions.readSnapshot(async () => {
      const raw = herdr();
      for (const agent of raw.agents) agent.state_change_seq = 5;
      await omo.refresh(raw.panes);
      return omo.apply(raw);
    }), completions);
    expect((await served()).panes.find((pane) => pane.pane_id === "omo")).toMatchObject({ agent_status: "working", finish_id: 0 });
    append(message("assistant", "stop", LATER));
    omo.poll();
    const first = await served();
    expect(first.panes.find((pane) => pane.pane_id === "omo")).toMatchObject({ agent_status: "done", finish_id: 1 });
    expect(first.agents.find((agent) => agent.pane_id === "omo")?.state_change_seq).toBe(5);
    append(runtime("omo-senpi:wake"));
    omo.poll();
    await served();
    append(message("assistant", "stop", "2026-10-02T00:03:00.000Z"));
    omo.poll();
    expect((await served()).panes.find((pane) => pane.pane_id === "omo")).toMatchObject({ agent_status: "done", finish_id: 2 });
  });

  const detached = (id = "cell-one", at = "2026-10-02T00:00:40.000Z", queued = false) => JSON.stringify({
    type: "message", timestamp: at, message: { role: "toolResult", toolName: "eval", content: [{
      type: "text", text: queued ? `Eval cell ${id} is queued behind cell-one in the js kernel and detached; it runs after cell-one and completes as one notification.`
        : `Eval cell ${id} detached and is running in the js kernel (0 other live cells).`,
    }] },
  });
  const cellEnded = (id: string, outcome = "completed") => JSON.stringify({
    type: "custom_message", customType: "senpi-codemode:notification",
    timestamp: "2026-10-02T00:01:00.000Z",
    content: `<system-reminder>Detached eval cell ${id} (js) ${outcome}.\n(no output)</system-reminder>`,
  });

  it("reports background work when a detached eval cell outlives the turn", async () => {
    // Given a running turn and an independent task.
    const { omo, append, told, state } = setup(lines(message("user")));
    state.background = 1;
    await omo.refresh(herdr().panes);
    // When the eval detaches and the assistant stops.
    append(detached(), message("assistant", "stop", LATER));
    omo.poll();
    // Then both kinds of background work hold the turn's finish.
    expect(told.at(-1)).toEqual(["omo", "idle", 2, true]);
    expect(omo.backgroundOf("omo")).toBe(2);
  });

  for (const outcome of ["completed", "failed", "cancelled", "was killed at the 300s hard limit", "was killed after exhausting its 200s run budget (own execution time; host tool calls excluded)"]) {
    it(`clears a detached eval cell when its notification says ${outcome}`, async () => {
      // Given a detached cell and a turn already at rest.
      const { omo, append, told } = setup(lines(message("user"), detached(), message("assistant", "stop")));
      await omo.refresh(herdr().panes);
      expect(omo.backgroundOf("omo")).toBe(1);
      // When the terminal notification starts a turn and its answer stops.
      append(cellEnded("cell-one", outcome));
      omo.poll();
      append(message("assistant", "stop", LATER));
      omo.poll();
      // Then the count is zero and that turn can finish.
      expect(told.slice(-2)).toEqual([["omo", "working", 0, true], ["omo", "idle", 0, true]]);
      expect(omo.backgroundOf("omo")).toBe(0);
    });
  }

  it("counts queued detached cells independently when one finishes", async () => {
    // Given two cells, one queued behind the other.
    const { omo, append, told } = setup(lines(message("user")));
    await omo.refresh(herdr().panes);
    append(detached(), detached("cell-two", undefined, true), detached(), message("assistant", "stop"));
    omo.poll();
    expect(omo.backgroundOf("omo")).toBe(2);
    // When the first finishes and the notification turn stops.
    append(cellEnded("cell-one"), message("assistant", "stop", LATER));
    omo.poll();
    // Then the queued cell still holds the finish.
    expect(told.at(-1)).toEqual(["omo", "idle", 1, false]);
  });

  it("tracks a cell that detached while waiting for its kernel or queued behind an empty list", () => {
    // Given the runtime's other detach wordings.
    const waiting = JSON.stringify({ type: "message", timestamp: "2026-10-02T00:00:40.000Z", message: { role: "toolResult", toolName: "eval", content: [
      { type: "text", text: "Eval cell cell-wait is detached and waiting for the js kernel to be ready; it runs first once the kernel is ready and completes as one notification." },
    ] } });
    const queuedEmpty = JSON.stringify({ type: "message", timestamp: "2026-10-02T00:00:41.000Z", message: { role: "toolResult", toolName: "eval", content: [
      { type: "text", text: "Eval cell cell-q is queued behind  in the py kernel and detached; it runs after them and completes as one notification." },
    ] } });
    // When both are read.
    const turn = [waiting, queuedEmpty].reduce((current, text) => omoTurnAfter(current, { text }), noTurn());
    // Then both cells hold the finish.
    expect(turn.detached?.map((cell) => cell.id)).toEqual(["cell-wait", "cell-q"]);
  });

  it("settles every cell a combined or image-carrying notification reports", () => {
    // Given three detached cells.
    const open = ["cell-one", "cell-two", "cell-three"].map((id) => detached(id));
    const start = open.reduce((current, text) => omoTurnAfter(current, { text }), noTurn());
    // When one notice ends two cells together and another carries an image beside its text.
    const combined = JSON.stringify({ type: "custom_message", customType: "senpi-codemode:notification", timestamp: "2026-10-02T00:01:00.000Z",
      content: "<system-reminder>Detached eval cell cell-one (js) cancelled.\n(no output)</system-reminder>\n\n<system-reminder>Detached eval cell cell-two (js) cancelled.\n(no output)</system-reminder>" });
    const withImage = JSON.stringify({ type: "custom_message", customType: "senpi-codemode:notification", timestamp: "2026-10-02T00:01:01.000Z",
      content: [{ type: "text", text: "<system-reminder>Detached eval cell cell-three (js) completed.</system-reminder>" }, { type: "image", data: "AAAA", mimeType: "image/png" }] });
    // Then all three are settled.
    expect(omoTurnAfter(start, { text: combined }).detached?.map((cell) => cell.id)).toEqual(["cell-three"]);
    expect(omoTurnAfter(omoTurnAfter(start, { text: combined }), { text: withImage }).detached).toEqual([]);
  });

  it("ignores detached cells from before the process holding the session", async () => {
    // Given an old cell followed by a recent answer in a resumed session.
    const { omo, state } = setup(lines(detached(), message("assistant", "stop", LATER)));
    state.discovered.set("omo", { path: FILE, startedAt: Date.parse("2026-10-02T00:00:40.001Z") });
    // When the current process is discovered.
    await omo.refresh(herdr().panes);
    // Then the old kernel's cell cannot hold this process's finish.
    expect(omo.backgroundOf("omo")).toBe(0);
  });

  it("ignores monitors and quoted detach notices when a plain turn stops", async () => {
    // Given a running turn with no eval work.
    const { omo, append, told } = setup(lines(message("user")));
    await omo.refresh(herdr().panes);
    // When unrelated tool output and user text mention cells before the answer stops.
    append(
      message("user", undefined, undefined, "Eval cell fake detached and is running in the js kernel"),
      JSON.stringify({ type: "message", message: { role: "toolResult", toolName: "monitor", content: [
        { type: "text", text: "Eval cell fake detached and is running in the js kernel" },
      ] } }),
      runtime("senpi-monitor:notification"), message("assistant", "stop"),
    );
    omo.poll();
    // Then the plain stop has no background hold.
    expect(told.at(-1)).toEqual(["omo", "idle", 0, true]);
  });

  it("replays detached cells when a session file is replaced", async () => {
    // Given a tracked cell whose old session file held it open.
    const { omo, replace } = setup(lines(message("user"), detached(), message("assistant", "stop")));
    await omo.refresh(herdr().panes);
    expect(omo.backgroundOf("omo")).toBe(1);
    // When compaction replaces the file with its settled history.
    replace(message("user"), detached(), cellEnded("cell-one"), message("assistant", "stop", LATER));
    omo.poll();
    // Then replay reconstructs the settled state, rather than retaining the old cell.
    expect(omo.backgroundOf("omo")).toBe(0);
  });

  it("retains detached cell lifecycle through projected long records", () => {
    // Given a tool result and notification larger than the reader holds whole.
    const path = join(root, "detached-long.jsonl");
    writeFileSync(path, lines(detached().replace("(0 other live cells).", "(0 other live cells)." + "x".repeat(200_000)),
      cellEnded("cell-one").replace("(no output)", "x".repeat(200_000))));
    const fd = openSync(path, "r");
    const turns = [noTurn()];
    try { readLines(fd, 0, statSync(path).size, (line) => {
      // When the file reader projects each complete record.
      turns.push(omoTurnAfter(turns.at(-1) ?? noTurn(), line));
    }); } finally { closeSync(fd); }
    // Then both the detach and its settlement survive projection.
    expect(turns.map((turn) => turn.detached?.length ?? 0)).toEqual([0, 1, 0]);
  });

  it("uses the session header cwd for counts and lists, falling back to the pane cwd", async () => {
    const { omo, replace, backgroundCwds } = setup(lines(JSON.stringify({ type: "session", cwd: "/session-project" }), message("assistant", "stop")));
    await omo.refresh(herdr().panes);
    expect(omo.sessionOf("omo")?.cwd).toBe("/session-project");
    expect(backgroundCwds.at(-1)).toBe("/session-project");
    replace(JSON.stringify({ type: "session", cwd: "/another-project" }), message("assistant", "stop"));
    omo.poll();
    expect(omo.sessionOf("omo")?.cwd).toBe("/another-project");
    expect(backgroundCwds.at(-1)).toBe("/another-project");
    for (const header of ["{torn", JSON.stringify({ type: "session", cwd: 42 }), JSON.stringify({ type: "session", cwd: "" })]) {
      replace(header, message("assistant", "stop"));
      omo.poll();
      expect(omo.sessionOf("omo")?.cwd).toBe("/work");
      expect(backgroundCwds.at(-1)).toBe("/work");
    }
  });

  it("tells a pane found again after a missed lookup from one found for the first time", async () => {
    const { omo, found, again, state } = setup();
    await omo.refresh(herdr().panes);
    state.discovered.delete("omo");
    state.clock += 10_000;
    await omo.refresh(herdr().panes);
    state.discovered.set("omo", { path: FILE, startedAt: null });
    state.clock += 10_000;
    await omo.refresh(herdr().panes);
    expect(found.filter((id) => id === "omo")).toEqual(["omo", "omo"]);
    expect(again.slice(found.indexOf("omo"), found.indexOf("omo") + 1)).toEqual([false]);
    expect(again[found.lastIndexOf("omo")]).toBe(true);
  });

  it("counts nothing for a folder that cannot be resolved, rather than throwing from the poll", () => {
    const parent = mkdtempSync(join(tmpdir(), "omo-locked-"));
    const cwd = join(parent, "project");
    mkdirSync(cwd);
    chmodSync(parent, 0o000);
    try {
      expect(omoBackgroundTasks(cwd, () => true, { env: { HOME: parent } })).toEqual(new Map());
    } finally {
      chmodSync(parent, 0o700);
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it("reads a session header that was incomplete when the pane was discovered", async () => {
    const { omo, append, backgroundCwds } = setup('{"type":"session","cwd":');
    await omo.refresh(herdr().panes);
    expect(omo.sessionOf("omo")?.cwd).toBe("/work");
    append('"/session-project"}', message("assistant", "stop"));
    omo.poll();
    expect(omo.sessionOf("omo")?.cwd).toBe("/session-project");
    expect(backgroundCwds.at(-1)).toBe("/session-project");
  });

  it("reads RUN while a turn runs and DONE when it ends, in events and in every snapshot", async () => {
    const { omo, told, append, state } = setup();
    const completions = new CompletionTracker(null);
    const served = () => completions.readSnapshot(async () => { const raw = herdr(); await omo.refresh(raw.panes); return omo.apply(raw); });
    // at rest: nothing worked, so READY; every OmO pane is `omo`, and the other panes are herdr's own
    expect(statuses(await served())).toEqual({ omo: "omo/idle", lost: "omo/idle", claude: "claude/working", shell: "null/unknown" });
    expect([omo.tracks("omo"), omo.tracks("lost"), omo.runs("lost"), omo.runs("claude")]).toEqual([true, false, true, false]);
    // a turn starts: told once, and herdr's claude/idle no longer undoes it at the next snapshot
    append(message("user"));
    omo.poll();
    expect(told).toEqual([["omo", "working", 0, true]]);
    expect(completions.observe("omo", "working", "omo")).toBe("working");
    for (let i = 0; i < 3; i++) { state.clock += 10_000; expect(statuses(await served())["omo"]).toBe("omo/working"); }
    append(message("assistant", "toolUse"), message("toolResult"));
    omo.poll();
    expect(told).toHaveLength(1);
    // it ends: DONE, and it stays DONE in the snapshots after, across refreshes
    append(message("assistant", "stop"));
    omo.poll();
    expect(told.at(-1)).toEqual(["omo", "idle", 0, true]);
    expect(completions.observe("omo", "idle", "omo")).toBe("done");
    for (let i = 0; i < 3; i++) { state.clock += 10_000; expect(statuses(await served())["omo"]).toBe("omo/done"); }
    // a finished background task wakes the session: a turn of its own
    append(runtime("omo-senpi:wake"));
    omo.poll();
    expect(completions.observe("omo", told.at(-1)![1], "omo")).toBe("working");
    expect(statuses(await served())["omo"]).toBe("omo/working");
  });

  it("reads no DONE for a turn that ended on a model error, and DONE once a retry answers it (#687)", async () => {
    const { omo, told, append, state } = setup();
    const completions = new CompletionTracker(null);
    const served = () => completions.readSnapshot(async () => { const raw = herdr(); await omo.refresh(raw.panes); return omo.apply(raw); });
    await served();
    /** what the pane reads after each change OmO tells, as index.ts settles it */
    const shown: AgentStatus[] = [];
    const settle = () => { for (const [id, status, , turn, rest] of told.splice(0)) if (id === "omo" && turn) shown.push(completions.observe(id, status, "omo", rest)); };
    const fallback = JSON.stringify({ type: "model_change", timestamp: "2026-10-02T00:01:00.050Z", provider: "eons", modelId: "GLM-5.3", reason: "fallback", originalModelId: "DeepSeek-V4.1-Flash" });
    append(message("user"), message("assistant", "toolUse"), message("toolResult"));
    omo.poll(); settle();
    // the issue's screen: no answer after 5 retries, a fallback model takes the turn on, the original model comes back and times out
    append(failure("The model provider could not complete the request after 5 retries. Try again or choose another model with /model."), bookkeeping("senpi.hooks.stop-state"), fallback);
    omo.poll(); settle();
    append(message("assistant", "toolUse"), message("toolResult"));
    omo.poll(); settle();
    append(failure("Request timed out."), bookkeeping("senpi.hooks.stop-state"));
    omo.poll(); settle();
    // back at the prompt: READY, never DONE, so nothing alerts a finish; not in events and not in any snapshot
    expect(shown).toEqual(["working", "idle", "working", "idle"]);
    for (let i = 0; i < 3; i++) { state.clock += 10_000; expect(statuses(await served())["omo"]).toBe("omo/idle"); }
    expect(completions.current("omo")).toBe("idle");
    // a retry that gets an answer ends the turn after all: that is a finish, alerted as one. It
    // goes straight to DONE: a RUN told just before would make it a turn of no length, which the
    // default alerts (a finish after a long turn) leave untold; a turn whose start was not seen is told
    append(message("assistant", "stop", LATER));
    omo.poll(); settle();
    expect(shown.slice(4)).toEqual(["done"]);
    expect(statuses(await served())["omo"]).toBe("omo/done");
    // and a turn that ends well, as before
    append(message("user"));
    omo.poll(); settle();
    append(message("assistant", "stop"));
    omo.poll(); settle();
    expect(shown.slice(5)).toEqual(["working", "done"]);
  });

  it("drops a DONE kept from before when the turn after it ended on a model error (#687)", async () => {
    // the pane finished a turn, and nobody has seen it yet (or the server restarted with it kept as DONE)
    const { omo, told, append } = setup(lines(message("user")));
    const completions = new CompletionTracker(null);
    await omo.refresh(herdr().panes);
    append(message("assistant", "stop"));
    omo.poll();
    const settle = () => told.splice(0).filter(([id, , , turn]) => id === "omo" && turn).map(([id, status, , , rest]) => completions.observe(id, status, "omo", rest));
    expect(settle()).toEqual(["working", "done"]);
    // a new prompt and its failure land between two reads: the DONE was the turn before's, and this one did not finish
    append(message("user"), failure("Request timed out."));
    omo.poll();
    expect(settle()).toEqual(["idle"]);
    expect(completions.present(herdr()).panes.find((p) => p.pane_id === "omo")!.agent_status).toBe("idle");
  });

  it("finishes a retry that answered while the pane's session could not be told (#687)", async () => {
    const { omo, told, append, state } = setup(lines(message("user"), failure("Request timed out.")));
    const completions = new CompletionTracker(null);
    await omo.refresh(herdr().panes);
    const settle = () => told.splice(0).filter(([id, , , turn]) => id === "omo" && turn).map(([id, status, , , rest]) => completions.observe(id, status, "omo", rest));
    expect(settle()).toEqual(["idle"]);
    // the session cannot be told for a while, and the retry's answer lands meanwhile
    state.discovered.set("omo", { path: null, startedAt: null });
    state.clock += 10_000;
    await omo.refresh(herdr().panes);
    append(message("assistant", "stop", LATER));
    state.discovered.set("omo", { path: FILE, startedAt: null });
    state.clock += 10_000;
    await omo.refresh(herdr().panes);
    expect(settle()).toEqual(["done"]);
  });

  it("takes no finish from another session's history after a model error (#687)", async () => {
    const { omo, told, files, state } = setup(lines(message("user"), failure("Request timed out.")));
    const completions = new CompletionTracker(null);
    await omo.refresh(herdr().panes);
    const settle = () => told.splice(0).filter(([id, , , turn]) => id === "omo" && turn).map(([id, status, , , rest]) => completions.observe(id, status, "omo", rest));
    expect(settle()).toEqual(["idle"]);
    // /resume puts a session that finished long ago in the pane: its last answer is no new work
    const other = "/s/2026_01a0f88b-0000-7139-8125-c9cd453b9e17.jsonl";
    files[other] = lines(message("user"), message("assistant", "stop", LATER));
    state.discovered.set("omo", { path: other, startedAt: null });
    state.clock += 10_000;
    await omo.refresh(herdr().panes);
    expect(settle()).not.toContain("done");
    expect(completions.current("omo")).toBe("idle");
  });

  it("does not finish a retry twice when herdr's word told it while the session could not be (#687)", async () => {
    const { omo, told, append, state } = setup(lines(message("user"), failure("Request timed out.")));
    const completions = new CompletionTracker(null);
    await omo.refresh(herdr().panes);
    const settle = () => told.splice(0).filter(([id, , , turn]) => id === "omo" && turn).map(([id, status, , , rest]) => completions.observe(id, status, "omo", rest));
    expect(settle()).toEqual(["idle"]);
    state.discovered.set("omo", { path: null, startedAt: null });
    state.clock += 10_000;
    await omo.refresh(herdr().panes);
    // meanwhile herdr's status stands for the pane: the retry runs and finishes there, alerted, and is seen
    expect(completions.observe("omo", "working", "omo")).toBe("working");
    expect(completions.observe("omo", "idle", "omo")).toBe("done");
    expect(completions.seen("omo")).toBe(true);
    append(message("assistant", "stop", LATER));
    state.discovered.set("omo", { path: FILE, startedAt: null });
    state.clock += 10_000;
    await omo.refresh(herdr().panes);
    expect(settle()).not.toContain("done");
    expect(completions.current("omo")).toBe("idle");
  });

  it("keeps another turn's DONE when a session found anew ends in an old error (#687)", async () => {
    // the server restarts with the pane's last finish kept unseen, and the pane now holds an older session that failed
    const completions = new CompletionTracker(null);
    expect(completions.observe("omo", "working", "omo")).toBe("working");
    expect(completions.observe("omo", "idle", "omo")).toBe("done");
    const { omo, told } = setup(lines(message("user"), failure("Request timed out.")));
    await omo.refresh(herdr().panes);
    const shown = told.splice(0).filter(([id, , , turn]) => id === "omo" && turn).map(([id, status, , , rest]) => completions.observe(id, status, "omo", rest));
    expect(shown).not.toContain("idle");
    expect(completions.current("omo")).toBe("done");
  });

  it("restores INPUT when an unanswered call predates the last megabyte at startup", async () => {
    const { omo } = setup(lines(asking("old", false), acceptedResult("old"), message("toolResult", undefined, undefined, "x".repeat(1_200_000)), message("assistant", "stop")));
    await omo.refresh(herdr().panes);
    expect(statuses(omo.apply(herdr()))["omo"]).toBe("omo/blocked");
  });

  it("serves a concurrent request before a large initial replay publishes its status", async () => {
    const path = join(root, "responsive_01a0f88b-481c-7139-8125-c9cd453b9e17.jsonl");
    writeFileSync(path, lines(message("user"), asking("old", false), acceptedResult("old"), message("toolResult", undefined, undefined, "x".repeat(16 * 1024 * 1024)), message("assistant", "stop")));
    const started = Promise.withResolvers<void>();
    const told: AgentStatus[] = [];
    let finished = false;
    const omo = new OmoStatus({
      discover: async () => new Map([["omo", { path, startedAt: null }]]),
      snapshot: async () => herdr(),
      background: () => new Map(),
      onChange: (_id, status) => told.push(status),
      turnAfter: (turn, line) => { started.resolve(); return omoTurnAfter(turn, line); },
    });
    const server = createServer({ hostname: "127.0.0.1", port: 0, stateDir: mkdtempSync(join(root, "server-")), token: "", machines: false, sidecar: false, tailscaleOwner: null });
    const health = () => fetch(`http://127.0.0.1:${server.port}/api/health?scope=bridge`, { signal: AbortSignal.timeout(5000) });
    expect((await health()).status).toBe(200);
    const replay = omo.refresh(herdr().panes).then(() => { finished = true; });
    try {
      await started.promise;
      const response = await health();
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ ok: true });
      expect(finished).toBe(false);
      expect(told).toEqual([]);
      await replay;
      expect(told).toEqual(["blocked"]);
      expect(statuses(omo.apply(herdr()))["omo"]).toBe("omo/blocked");
    } finally {
      omo.stop();
      await replay;
      server.stop();
    }
  });

  for (const agent of ["omo", "gjc"] as const) {
    it(`publishes one ${agent} baseline and coalesces polls during a large replay`, async () => {
      const path = join(root, `${agent}-baseline.jsonl`);
      writeFileSync(path, lines(message("user"), message("assistant", "stop", undefined, "x".repeat(2 * 1024 * 1024))));
      const started = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const told: AgentStatus[] = [];
      let reads = 0;
      const deps = {
        discover: async () => new Map([["omo", { path, startedAt: null }]]),
        snapshot: async () => herdr(),
        onChange: (_id: string, status: AgentStatus) => told.push(status),
        background: () => new Map<string, number>(),
        file: {
          stat: () => ({ size: statSync(path).size, id: "1" }),
          // Hold the I/O boundary, not the reducer or status logic.
          lines: async (_path: string, from: number, size: number, each: (line: OmoLine) => void) => {
            reads++;
            started.resolve();
            await release.promise;
            const fd = openSync(path, "r");
            try { return readLines(fd, from, size, each); } finally { closeSync(fd); }
          },
        },
      };
      const tracker = agent === "omo" ? new OmoStatus(deps) : createGjcStatus(deps);
      const replay = tracker.refresh(herdr().panes);
      try {
        await started.promise;
        const poll = tracker.poll();
        expect(reads).toBe(1);
        expect(told).toEqual([]);
        if (agent === "gjc") expect(tracker.tracks("omo")).toBe(false);
        release.resolve();
        await Promise.all([replay, poll]);
        expect(told).toEqual([]);
        expect(tracker.tracks("omo")).toBe(true);
        appendFileSync(path, lines(message("user")));
        const append = tracker.poll();
        if (agent === "gjc") {
          expect(tracker.tracks("omo")).toBe(false);
          expect(tracker.apply(snapshotOf(pane("omo", "gjc", "working"))).panes[0]?.agent_status).toBe("working");
        }
        await append;
        expect(told).toEqual(["working"]);
      } finally {
        tracker.stop();
        release.resolve();
        await replay;
      }
    });
  }

  it("does not start replay when stopped during discovery", async () => {
    const discovery = Promise.withResolvers<Map<string, OmoPane>>();
    const told: AgentStatus[] = [];
    const omo = new OmoStatus({
      discover: () => discovery.promise,
      snapshot: async () => herdr(),
      onChange: (_id, status) => told.push(status),
      background: () => new Map(),
    });
    const refresh = omo.refresh(herdr().panes);
    omo.stop();
    discovery.resolve(new Map([["omo", { path: FILE, startedAt: null }]]));
    await refresh;
    expect(omo.runs("omo")).toBe(false);
    expect(told).toEqual([]);
  });

  for (const change of ["session", "removed", "agent", "stop", "replace", "truncate", "peer"] as const) {
    it(`handles ${change} during an in-flight replay without stale publication`, async () => {
      const path = join(root, `${change}_01a0f88b-481c-7139-8125-c9cd453b9e17.jsonl`);
      const other = join(root, `${change}-other.jsonl`);
      writeFileSync(path, lines(message("user"), message("toolResult", undefined, undefined, "x".repeat(2 * 1024 * 1024))));
      writeFileSync(other, lines(message("assistant", "stop")));
      const started = Promise.withResolvers<void>();
      const told: AgentStatus[] = [];
      let reduced = 0;
      const found = new Map<string, OmoPane>([["omo", { path, startedAt: null }]]);
      if (change === "peer") found.set("peer", { path: null, startedAt: null });
      const omo = new OmoStatus({
        discover: async () => new Map(found),
        snapshot: async () => herdr(),
        onChange: (_id, status) => told.push(status),
        background: () => new Map(),
        refreshMs: 0,
        turnAfter: (turn, line) => { reduced++; started.resolve(); return omoTurnAfter(turn, line); },
      });
      const replay = omo.refresh(herdr().panes);
      try {
        await started.promise;
        switch (change) {
          case "session":
            found.set("omo", { path: other, startedAt: null });
            await omo.refresh(herdr().panes);
            break;
          case "removed":
            found.clear();
            await omo.refresh(herdr().panes);
            break;
          case "agent": omo.named("omo", "codex"); break;
          case "peer": omo.named("peer", "codex"); break;
          case "stop": omo.stop(); break;
          case "replace": renameSync(other, path); break;
          case "truncate": writeFileSync(path, lines(message("assistant", "stop"))); break;
        }
        await replay;
        expect(told).toEqual(change === "peer" ? ["working"] : []);
        if (change === "session") {
          expect(omo.pathOf("omo")).toBe(other);
          expect(reduced).toBe(2); // one old record, one new record; the old tail was canceled
        }
        if (change === "removed" || change === "agent") expect(omo.runs("omo")).toBe(false);
        if (change === "stop") expect(reduced).toBe(1);
        if (change === "replace" || change === "truncate") {
          expect(reduced).toBe(1);
          await omo.poll();
          expect(told).toEqual([]);
          expect(statuses(omo.apply(herdr()))["omo"]).toBe("omo/idle");
        }
      } finally {
        omo.stop();
        await replay;
      }
    });
  }

  it("replays a truncated append from zero even when it is longer than the old offset", async () => {
    const path = join(root, "truncated-append.jsonl");
    writeFileSync(path, lines(message("assistant", "stop")));
    const started = Promise.withResolvers<void>();
    const told: AgentStatus[] = [];
    let appended = false;
    const omo = new OmoStatus({
      discover: async () => new Map([["omo", { path, startedAt: null }]]),
      snapshot: async () => herdr(),
      onChange: (_id, status) => told.push(status),
      background: () => new Map(),
      turnAfter: (turn, line) => { if (appended) started.resolve(); return omoTurnAfter(turn, line); },
    });
    await omo.refresh(herdr().panes);
    appendFileSync(path, lines(message("user"), message("toolResult", undefined, undefined, "x".repeat(2 * 1024 * 1024))));
    appended = true;
    const replay = omo.poll();
    try {
      await started.promise;
      writeFileSync(path, lines(asking("replacement", false), bookkeeping("x".repeat(1024))));
      await replay;
      expect(told).toEqual([]);
      await omo.poll();
      expect(told).toEqual(["blocked"]);
    } finally {
      omo.stop();
      await replay;
    }
  });

  it("reads INPUT while a question waits on the user, whether OmO waits for it or goes on", async () => {
    const { omo, told, append } = setup();
    await omo.refresh(herdr().panes);
    append(message("user"), asking("q1", true));
    omo.poll();
    expect(told.at(-1)).toEqual(["omo", "blocked", 0, true]);
    expect(statuses(omo.apply(herdr()))["omo"]).toBe("omo/blocked");
    // answered: back at work
    append(result("q1"));
    omo.poll();
    expect(told.at(-1)).toEqual(["omo", "working", 0, true]);
    // asked without waiting: INPUT through the rest of the turn and after it ends, until settled
    append(asking("q2", false), acceptedResult("q2"), message("assistant", "stop"));
    omo.poll();
    expect(told.at(-1)).toEqual(["omo", "blocked", 0, true]);
    append(settled("q2"));
    omo.poll();
    expect(told.at(-1)).toEqual(["omo", "idle", 0, true]);
  });

  it("tells a turn that ended while the panes were being looked up again", async () => {
    const { omo, told, append, state } = setup(lines(message("user")));
    await omo.refresh(herdr().panes);
    expect(told).toEqual([["omo", "working", 0, true]]);
    // the answer lands during the lookup of the next refresh: it is told, not swallowed
    state.clock += 10_000;
    state.during = () => append(message("assistant", "stop"));
    await omo.refresh(herdr().panes);
    expect(told.slice(1)).toEqual([["omo", "idle", 0, true]]);
  });

  it("tells a turn that ended while the pane's OmO could not be told, or in another session", async () => {
    const { omo, told, append, replace, state } = setup(lines(message("user")));
    await omo.refresh(herdr().panes);
    // one lookup misses the pane (its process list could not be read); the answer lands meanwhile
    state.discovered.delete("omo");
    state.clock += 10_000;
    await omo.refresh(herdr().panes);
    append(message("assistant", "stop"));
    state.discovered.set("omo", { path: FILE, startedAt: null });
    state.clock += 10_000;
    await omo.refresh(herdr().panes);
    expect(told).toEqual([["omo", "working", 0, true], ["omo", "idle", 0, true]]);
    // nor is it lost when only the session could not be told for a while
    append(message("user"));
    omo.poll();
    state.discovered.set("omo", { path: null, startedAt: null });
    state.clock += 10_000;
    await omo.refresh(herdr().panes);
    append(message("assistant", "stop"));
    state.discovered.set("omo", { path: FILE, startedAt: null });
    state.clock += 10_000;
    await omo.refresh(herdr().panes);
    expect(told.slice(2)).toEqual([["omo", "working", 0, true], ["omo", "idle", 0, true]]);
    // the file is rewritten whole, a turn running in it: read again from its start, not from where the old one was read to
    replace(message("user"), message("assistant", "stop"), message("user"), message("assistant", "toolUse"));
    omo.poll();
    expect(told.at(-1)).toEqual(["omo", "working", 0, true]);
    replace(message("user"), message("assistant", "stop"), message("user"), message("assistant", "toolUse"), message("toolResult"), message("assistant", "stop"));
    omo.poll();
    expect(told.at(-1)).toEqual(["omo", "idle", 0, true]);
  });

  it("makes a finish of a turn found running by the watch alone, no snapshot served", async () => {
    const { omo, told, append } = setup(lines(message("user")));
    const completions = new CompletionTracker(null);
    const settled = () => told.map(([id, status]) => completions.observe(id, status, "omo"));
    await omo.refresh(herdr().panes);
    append(message("assistant", "stop"));
    omo.poll();
    expect(settled()).toEqual(["working", "done"]);
  });

  it("finds a turn already running when the server starts, and takes over what herdr's name finished", async () => {
    const { omo, told, found } = setup(lines(message("user")));
    const completions = new CompletionTracker(null);
    // before: herdr's own events, under its name for the pane
    completions.observe("omo", "working", "claude");
    expect(completions.observe("omo", "idle", "claude")).toBe("done");
    const raw = herdr();
    await omo.refresh(raw.panes);
    // what Codex finished in a pane before OmO was started there is not OmO's finish
    completions.observe("lost", "working", "codex");
    expect(completions.observe("lost", "unknown", "codex")).toBe("done");
    for (const paneId of found) completions.adopt(paneId, "omo", OMO_ALIASES);
    expect(found.sort()).toEqual(["lost", "omo"]);
    expect(completions.current("lost")).toBeUndefined();
    expect(completions.observe("lost", "idle", "omo")).toBe("idle");
    expect(told).toEqual([["omo", "working", 0, true]]);
    expect(statuses(completions.present(omo.apply(raw)))["omo"]).toBe("omo/working");
    // a pane whose session is lost and found again keeps its DONE: its identity never changed
    completions.observe("lost", "working", "omo");
    expect(completions.observe("lost", "idle", "omo")).toBe("done");
    expect(statuses(completions.present(omo.apply(herdr())))["lost"]).toBe("omo/done");
  });

  it("does not take an unfinished turn of a process that is gone for a running one", async () => {
    // killed after a tool call, then resumed by a new process without a prompt
    const { omo, state, append, told } = setup(lines(message("user", undefined, "2026-10-02T00:00:10.000Z"), message("assistant", "toolUse", "2026-10-02T00:00:12.000Z")));
    state.discovered.set("omo", { path: FILE, startedAt: Date.parse("2026-10-02T00:05:00.000Z") });
    const raw = herdr();
    await omo.refresh(raw.panes);
    expect(statuses(omo.apply(raw))["omo"]).toBe("omo/idle");
    // a later lookup that cannot read the start keeps the one read before
    state.discovered.set("omo", { path: FILE, startedAt: null });
    state.clock += 10_000;
    await omo.refresh(raw.panes);
    expect(statuses(omo.apply(raw))["omo"]).toBe("omo/idle");
    expect(told).toEqual([]);
    // nor does a lookup that misses the pane lose it
    state.discovered.delete("omo");
    state.clock += 10_000;
    await omo.refresh(raw.panes);
    state.discovered.set("omo", { path: FILE, startedAt: null });
    state.clock += 10_000;
    await omo.refresh(raw.panes);
    expect(statuses(omo.apply(raw))["omo"]).toBe("omo/idle");
    expect(told).toEqual([]);
    // a prompt to the new process is a turn
    append(message("user", undefined, "2026-10-02T00:06:00.000Z"));
    omo.poll();
    expect(told).toEqual([["omo", "working", 0, true]]);
  });

  it("lets go of a pane at once when herdr names another agent in it", async () => {
    const { omo, state } = setup();
    await omo.refresh(herdr().panes);
    // herdr's names for OmO itself change nothing
    for (const name of [null, "claude", "pi", "omo"]) expect(omo.named("omo", name)).toBe(false);
    expect(omo.tracks("omo")).toBe(true);
    // Codex started in the pane: its events are no longer swallowed, and the panes are looked up again
    expect(omo.named("omo", "codex")).toBe(true);
    expect(omo.named("omo", "codex")).toBe(false);
    expect([omo.tracks("omo"), omo.runs("omo")]).toEqual([false, false]);
    state.discovered.delete("omo");
    await omo.refresh(herdr().panes);
    expect(state.lookups).toBe(2);
  });

  it("does not take a pane back from a lookup that began before another agent was named in it", async () => {
    const { omo, told, state } = setup(lines(message("user")));
    await omo.refresh(herdr().panes);
    state.clock += 10_000;
    // the lookup still sees OmO; Codex's event arrives while it runs
    state.during = () => { omo.named("omo", "codex"); };
    await omo.refresh(herdr().panes);
    expect(omo.runs("omo")).toBe(false);
    expect(told).toEqual([["omo", "working", 0, true]]);
    // a pane only remembered (its lookup missed) is let go the same way
    state.during = () => {};
    await omo.refresh(herdr().panes);
    state.discovered.delete("omo");
    state.clock += 10_000;
    await omo.refresh(herdr().panes);
    expect(omo.named("omo", "codex")).toBe(true);
  });

  it("tells a turn still running anew once herdr's status stood for the pane a while", async () => {
    const { omo, told, state } = setup(lines(message("user")));
    const completions = new CompletionTracker(null);
    const settle = () => { const [id, status] = told.at(-1)!; return completions.observe(id, status, "omo"); };
    await omo.refresh(herdr().panes);
    expect(settle()).toBe("working");
    // the session cannot be told: herdr's claude/idle counts, and reads as a finish
    state.discovered.set("omo", { path: null, startedAt: null });
    state.clock += 10_000;
    await omo.refresh(herdr().panes);
    expect(completions.observe("omo", "idle", "omo")).toBe("done");
    // told again, the turn still runs: RUN is said anew, so its real end is a finish
    state.discovered.set("omo", { path: FILE, startedAt: null });
    state.clock += 10_000;
    await omo.refresh(herdr().panes);
    expect(told).toHaveLength(2);
    expect(settle()).toBe("working");
  });

  it("keeps another agent's status out of a snapshot being read when OmO takes the pane", async () => {
    const completions = new CompletionTracker(null);
    let release = (_: SessionSnapshot) => {};
    const reading = completions.readSnapshot(() => new Promise<SessionSnapshot>((resolve) => { release = resolve; }));
    completions.observe("omo", "blocked", "codex");
    completions.adopt("omo", "omo", OMO_ALIASES);
    release(snapshotOf(pane("omo", "omo", "idle")));
    expect(statuses(await reading)["omo"]).toBe("omo/idle");
    // herdr's own done for Codex is not OmO's either
    completions.observe("omo", "done", "codex");
    completions.adopt("omo", "omo", OMO_ALIASES);
    expect(completions.current("omo")).toBeUndefined();
  });

  it("reads again what a failed read left", async () => {
    const { omo, told, append, replace, state } = setup();
    await omo.refresh(herdr().panes);
    state.failing = true;
    append(message("user"));
    omo.poll();
    expect(told).toEqual([]);
    state.failing = false;
    omo.poll();
    expect(told).toEqual([["omo", "working", 0, true]]);
    // a rewritten file that cannot be read is no finished turn: one RUN, one DONE
    state.failing = true;
    replace(message("user"));
    omo.poll();
    state.failing = false;
    omo.poll();
    expect(told).toHaveLength(1);
    append(message("assistant", "stop"));
    omo.poll();
    expect(told.slice(1)).toEqual([["omo", "idle", 0, true]]);
  });

  it("keeps the start of a process known before its session was", async () => {
    const { omo, told, state } = setup(lines(message("user", undefined, "2026-10-02T00:00:10.000Z"), message("assistant", "toolUse", "2026-10-02T00:00:12.000Z")));
    state.discovered.set("omo", { path: null, startedAt: Date.parse("2026-10-02T00:05:00.000Z") });
    await omo.refresh(herdr().panes);
    state.discovered.set("omo", { path: FILE, startedAt: null });
    state.clock += 10_000;
    await omo.refresh(herdr().panes);
    expect(statuses(omo.apply(herdr()))["omo"]).toBe("omo/idle");
    expect(told).toEqual([]);
  });

  it("tells a change in background tasks as that, not as a turn", async () => {
    const { omo, told, state } = setup();
    await omo.refresh(herdr().panes);
    state.background = 2;
    omo.poll();
    expect(told).toEqual([["omo", "idle", 2, false]]);
    expect(omo.backgroundOf("omo")).toBe(2);
    state.background = 0;
    omo.poll();
    expect(told.at(-1)).toEqual(["omo", "idle", 0, false]);
  });

  it("reads a process's start from the record OmO keeps of it, where the system tells none", () => {
    const dir = join(root, "sessions");
    mkdirSync(join(dir, "session-holders", "01a0f88b"), { recursive: true });
    writeFileSync(join(dir, "session-holders", "01a0f88b", "4242.json"), JSON.stringify({ pid: 4242, processStartedAtMs: 1_790_000_000_000 }));
    expect(holderStartedAt(dir, 4242)).toBe(1_790_000_000_000);
    expect(holderStartedAt(dir, 4243)).toBeNull();
    expect(holderStartedAt(join(root, "nowhere"), 4242)).toBeNull();
    // a helper process with no record does not undo the engine's
    expect(earliestStart([1_790_000_000_000, null])).toBe(1_790_000_000_000);
    expect(earliestStart([5, 3])).toBe(3);
    expect(earliestStart([null])).toBeNull();
  });

  it("keeps a remote PC's count of background tasks as its frames say", () => {
    const frame = (background_tasks?: number) => ({ type: "pane-status" as const, pane_id: "omo", agent_status: "working" as const, ...(background_tasks === undefined ? {} : { background_tasks }) });
    const two = paneAfterStatus(pane("omo", "omo", "idle"), frame(2));
    expect(two).toMatchObject({ agent_status: "working", background_tasks: 2 });
    expect(paneAfterStatus(two, frame())).toMatchObject({ background_tasks: 2 });
    expect("background_tasks" in paneAfterStatus(two, frame(0))).toBe(false);
  });

  it("takes whether a remote pane waits on its turn's background work from every frame", () => {
    const waiting = paneAfterStatus(pane("omo", "claude", "working"), { type: "pane-status", pane_id: "omo", agent_status: "done", background_tasks: 1, background_wait: true });
    expect(waiting).toMatchObject({ agent_status: "done", background_tasks: 1, background_wait: true });
    // a frame about the count alone still says it: one that does not name the wait ended it
    const over = paneAfterStatus(waiting, { type: "pane-status", pane_id: "omo", agent_status: "done", background_tasks: 1 });
    expect(["background_wait" in over, over.background_tasks]).toEqual([false, 1]);
  });

  it("looks the panes up once per refresh, and not again while nothing changed", async () => {
    const { omo, state } = setup();
    await omo.refresh(herdr().panes);
    await omo.refresh(herdr().panes);
    expect(state.lookups).toBe(1);
    state.clock += 6000;
    await omo.refresh(herdr().panes);
    expect(state.lookups).toBe(2);
  });
});
