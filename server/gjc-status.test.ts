import { afterAll, describe, expect, it, spyOn } from "bun:test";
import * as darwinProcess from "./darwin-process.ts";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AgentStatus, HerdrPane, SessionSnapshot } from "../shared/protocol.ts";
import { CompletionTracker, type OmoRest } from "./completion.ts";
import { Finishes } from "./finishes.ts";
import { createGjcStatus, gjcPanes, gjcTurnAfter, readOmoSnapshot, reconcileProviderStatus } from "./gjc-status.ts";
import { noTurn, OMO_ALIASES, OmoStatus, type OmoLine, type OmoPane, type OmoTurn } from "./omo-status.ts";

// records as gjc's native transcript writes them: a message envelope with the pi family's roles
const message = (role: string, stopReason?: string, at = "2026-10-02T00:00:10.000Z", text = "") => JSON.stringify({ type: "message", id: "x", parentId: null, timestamp: at, message: { role, content: [{ type: "text", text }], ...(stopReason ? { stopReason } : {}) } });
// a finished background job's wake, which gjc does not always display
const asyncResult = (display = false) => JSON.stringify({ type: "custom_message", customType: "async-result", display, content: "…", timestamp: "2026-10-02T00:00:20.000Z" });
const bookkeeping = (customType: string) => JSON.stringify({ type: "custom", customType });
const lines = (...entries: string[]) => entries.join("\n") + "\n";
const status = (turn: OmoTurn, entry: string) => gjcTurnAfter(turn, { text: entry });

const root = mkdtempSync(join(tmpdir(), "herdr-gjc-status-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("a GJC turn, read from its transcript", () => {
  it("runs from a prompt through its tool calls, and is over at an answer that stopped for good", () => {
    const reduce = (...entries: string[]) => entries.reduce(status, noTurn());
    expect(reduce(message("user")).status).toBe("working");
    expect(reduce(message("user"), message("assistant", "toolUse")).status).toBe("working");
    expect(reduce(message("user"), message("assistant", "toolUse"), message("toolResult")).status).toBe("working");
    expect(reduce(message("user"), message("assistant", "toolUse"), message("toolResult"), message("assistant", "stop")).status).toBe("idle");
    expect(reduce(message("user"), message("assistant", "length")).status).toBe("idle");
    expect(reduce(message("user", undefined, "2026-10-02T00:01:00.000Z")).at).toBe(Date.parse("2026-10-02T00:01:00.000Z"));
  });

  it("is at rest after an error or an abort: no finish (#687)", () => {
    const reduce = (...entries: string[]) => entries.reduce(status, noTurn());
    expect(reduce(message("user"), message("assistant", "error"))).toMatchObject({ status: "idle", failed: true });
    expect(reduce(message("user"), message("assistant", "aborted"))).toMatchObject({ status: "idle", failed: true });
    const answered = reduce(message("user"), message("assistant", "error"), message("assistant", "stop"));
    expect([answered.status, answered.failed ?? null]).toEqual(["idle", null]);
    expect(reduce(message("user"), message("assistant", "error"), message("assistant", "toolUse")).status).toBe("working");
  });

  it("keeps the turn an assistant message with a missing or unknown stopReason cannot decide", () => {
    const reduce = (turn: OmoTurn, ...entries: string[]) => entries.reduce(status, turn);
    const unknown = JSON.stringify({ type: "message", timestamp: "2026-10-02T00:00:30.000Z", message: { role: "assistant", content: [], stopReason: "suspended" } });
    const bare = JSON.stringify({ type: "message", timestamp: "2026-10-02T00:00:30.000Z", message: { role: "assistant", content: [] } });
    expect(reduce(noTurn(), unknown, bare).status).toBeNull();
    expect(reduce({ status: "working", at: null, asks: [] }, unknown, bare).status).toBe("working");
    expect(reduce({ status: "idle", at: null, asks: [] }, unknown, bare).status).toBe("idle");
  });

  it("starts a turn on a background job's result, displayed or not, and on no other custom record", () => {
    const reduce = (...entries: string[]) => entries.reduce(status, noTurn());
    const rested = [message("user"), message("assistant", "stop")];
    expect(reduce(...rested, asyncResult()).status).toBe("working");
    expect(reduce(...rested, asyncResult(true)).status).toBe("working");
    for (const note of [bookkeeping("gjc.model_change"), bookkeeping("senpi.hooks.stop-state"),
      JSON.stringify({ type: "custom_message", customType: "omo-senpi:wake", display: false }),
      JSON.stringify({ type: "custom_message", customType: "async-task", display: true }),
      JSON.stringify({ type: "custom_message", content: "no type named" }),
      JSON.stringify({ type: "session", cwd: "/work" }), "not json"]) {
      expect(reduce(...rested, note).status).toBe("idle");
    }
    expect(reduce(bookkeeping("x"), "not json").status).toBeNull();
  });

  it("starts a turn on the monitor's and the timer's hidden wakes too, and on no text that names them", () => {
    const reduce = (...entries: string[]) => entries.reduce(status, noTurn());
    const rested = [message("user"), message("assistant", "stop")];
    const wake = (customType: string) => JSON.stringify({ type: "custom_message", customType, display: false, triggerTurn: true, deliverAs: "followUp", content: "…", timestamp: "2026-10-02T00:00:20.000Z" });
    for (const customType of ["async-result", "task-notification", "cron-fire"]) {
      expect(reduce(...rested, wake(customType)).status).toBe("working");
    }
    expect(reduce(...rested, message("assistant", "stop", "2026-10-02T00:00:30.000Z", "the async-result arrived")).status).toBe("idle");
    expect(reduce(...rested, bookkeeping("task-notification")).status).toBe("idle");
    expect(reduce(...rested, JSON.stringify({ type: "custom_message", customType: "task-notificationed" })).status).toBe("idle");
  });

  it("rejects a record that is not an object, and never throws on one", () => {
    for (const entry of ["null", "[null]", `[${message("user")}]`, "42", "\"async-result\"", "not json", "{"]) {
      expect(() => gjcTurnAfter(noTurn(), { text: entry })).not.toThrow();
      expect(gjcTurnAfter(noTurn(), { text: entry }).status).toBeNull();
      expect(gjcTurnAfter({ status: "working", at: 1, asks: [] }, { text: entry })).toMatchObject({ status: "working", at: 1 });
    }
  });

  it("holds a question the agent asked open until its result, an error result too", () => {
    const asking = (id: string, extra: Record<string, unknown> = {}) => JSON.stringify({ type: "message", timestamp: "2026-10-02T00:00:30.000Z", message: { role: "assistant", stopReason: "toolUse", content: [{ type: "toolCall", id, name: "ask", arguments: { question: "Which way?" }, ...extra }] } });
    const result = (id: string, isError = false) => JSON.stringify({ type: "message", timestamp: "2026-10-02T00:00:40.000Z", message: { role: "toolResult", toolCallId: id, toolName: "ask", content: [], isError } });
    const reduce = (...entries: string[]) => entries.reduce(status, noTurn());
    const asked = reduce(message("user"), asking("q1"));
    expect(asked).toMatchObject({ status: "working" });
    expect(asked.asks.map((call) => call.id)).toEqual(["q1"]);
    expect(reduce(message("user"), asking("q1"), message("assistant", "toolUse", "2026-10-02T00:00:35.000Z", "thinking")).asks).toHaveLength(1);
    expect(reduce(message("user"), asking("q1"), result("other")).asks).toHaveLength(1);
    expect(reduce(message("user"), asking("q1"), result("q1")).asks).toEqual([]);
    expect(reduce(message("user"), asking("q2"), result("q2", true)).asks).toEqual([]);
    expect(reduce(message("user"), asking(""), asking("q3", { incomplete: true })).asks).toEqual([]);
    for (const stopped of ["stop", "error", "aborted"]) {
      expect(reduce(message("user"), asking("unexecuted").replace('"stopReason":"toolUse"', `"stopReason":"${stopped}"`)).asks).toEqual([]);
    }
  });

  it("reads a record of any size by its projected JSON, and only whole lines", () => {
    const big = "x".repeat(200_000);
    const long = message("assistant", "toolUse").replace('"content":[', `"content":[{"type":"thinking","thinking":"${big}"},`);
    const ends: OmoLine = { head: long.slice(0, 4096), tail: long.slice(-4096), record: long };
    expect(gjcTurnAfter(noTurn(), ends).status).toBe("working");
    const projected = JSON.parse(long.replace(big, big.slice(0, 64 * 1024)));
    expect(gjcTurnAfter(noTurn(), { head: "", tail: "", record: JSON.stringify(projected) }).status).toBe("working");
    expect(gjcTurnAfter(noTurn(), { head: long.slice(0, 4096), tail: long.slice(-4096) }).status).toBeNull();
    expect(gjcTurnAfter({ status: "working", at: null, asks: [] }, { head: message("assistant", "stop").slice(0, 40), tail: message("assistant", "stop").slice(-40) }).status).toBe("working");
  });
});

describe("a GJC pane's status in place of herdr's provider-child status", () => {
  const pane = (id: string, agent: string | null, status: AgentStatus): HerdrPane => ({ pane_id: id, agent, agent_status: status, cwd: "/work" } as unknown as HerdrPane);
  const snapshotOf = (...panes: HerdrPane[]): SessionSnapshot => ({ panes, agents: panes.map((p) => ({ pane_id: p.pane_id, agent: p.agent, agent_status: p.agent_status })) } as unknown as SessionSnapshot);
  /** herdr follows the provider child: gjc's parent turn can be over while the pane reads working */
  const herdr = () => snapshotOf(pane("gjc", "gjc", "working"), pane("lost", "gjc", "working"), pane("shell", null, "unknown"));
  const FILE = "/s/gjc-session.jsonl";

  function setup(initial = lines(message("user"), message("assistant", "stop"))) {
    const files: Record<string, string> = { [FILE]: initial };
    const ids: Record<string, string> = {};
    const told: ([string, AgentStatus, number, boolean] | [string, AgentStatus, number, boolean, OmoRest])[] = [];
    const found: string[] = [];
    const state = { discovered: new Map<string, OmoPane>([["gjc", { path: FILE, startedAt: null }], ["lost", { path: null, startedAt: null }]]), lookups: 0, clock: 0, failing: false, during: () => {} };
    const gjc = createGjcStatus({
      discover: async () => { state.lookups += 1; state.during(); return new Map(state.discovered); },
      snapshot: async () => herdr(),
      onChange: (id, status, count, turn, rest) => told.push(rest ? [id, status, count, turn, rest] : [id, status, count, turn]),
      onFound: (id) => found.push(id),
      file: {
        stat: (path) => path in files ? { size: Buffer.byteLength(files[path]!), id: ids[path] ?? "1" } : null,
        lines: (path, from, size, each) => { if (state.failing) return from; const text = Buffer.from(files[path]!).subarray(from, size).toString("utf8"); const whole = text.slice(0, text.lastIndexOf("\n") + 1); for (const line of whole.split("\n").slice(0, -1)) each({ text: line }); return from + Buffer.byteLength(whole); },
      },
      now: () => state.clock,
    });
    const append = (...entries: string[]) => { files[FILE] += lines(...entries); };
    const replace = (...entries: string[]) => { files[FILE] = lines(...entries); ids[FILE] = `${Number(ids[FILE] ?? 1) + 1}`; };
    return { gjc, told, found, append, replace, state, files };
  }
  const statuses = (snapshot: SessionSnapshot) => Object.fromEntries(snapshot.panes.map((p) => [p.pane_id, `${p.agent}/${p.agent_status}`]));

  it("identifies native DONE transitions while herdr keeps the provider working at one seq", async () => {
    const { gjc, append } = setup(lines(message("user")));
    const completions = new CompletionTracker();
    const finishes = new Finishes(() => "daemon-a");
    const served = async () => finishes.snapshot(await completions.readSnapshot(async () => {
      const raw = herdr();
      for (const agent of raw.agents) agent.state_change_seq = 5;
      await gjc.refresh(raw.panes);
      return gjc.apply(raw);
    }), completions);
    expect((await served()).panes[0]).toMatchObject({ agent_status: "working", finish_id: 0 });
    append(message("assistant", "stop"));
    gjc.poll();
    const done = await served();
    expect(done.panes[0]).toMatchObject({ agent_status: "done", finish_id: 1 });
    expect(done.agents[0]?.state_change_seq).toBe(5);
    append(asyncResult());
    gjc.poll();
    await served();
    append(message("assistant", "stop", "2026-10-02T00:02:00.000Z"));
    gjc.poll();
    expect((await served()).panes[0]).toMatchObject({ agent_status: "done", finish_id: 2 });
  });

  it("reads READY where herdr's provider child still reads working, and no finish from a first idle baseline", async () => {
    const { gjc, told, found, state } = setup();
    const completions = new CompletionTracker(null);
    const raw = herdr();
    await gjc.refresh(raw.panes);
    expect(statuses(gjc.apply(raw))).toEqual({ gjc: "gjc/idle", lost: "gjc/working", shell: "null/unknown" });
    expect([gjc.tracks("gjc"), gjc.tracks("lost"), gjc.runs("lost"), gjc.runs("shell")]).toEqual([true, false, true, false]);
    expect(found.sort()).toEqual(["gjc", "lost"]);
    for (const paneId of found) completions.adopt(paneId, "gjc", []);
    expect(told).toEqual([]);
    expect(statuses(completions.present(gjc.apply(raw)))["gjc"]).toBe("gjc/idle");
    expect(statuses(completions.present(gjc.apply(raw)))["lost"]).toBe("gjc/working");
    state.discovered.set("gjc", { path: null, startedAt: null });
    state.clock += 10_000;
    await gjc.refresh(raw.panes);
    state.discovered.set("gjc", { path: FILE, startedAt: null });
    state.clock += 10_000;
    await gjc.refresh(raw.panes);
    expect(told).toEqual([["gjc", "idle", 0, true]]);
  });

  it("reads RUN while a turn runs and DONE when it ends, in events and in every snapshot", async () => {
    const { gjc, told, append, state } = setup();
    const completions = new CompletionTracker(null);
    const served = () => completions.readSnapshot(async () => { const raw = herdr(); await gjc.refresh(raw.panes); return gjc.apply(raw); });
    await served();
    append(message("user"));
    gjc.poll();
    expect(told).toEqual([["gjc", "working", 0, true]]);
    expect(completions.observe("gjc", "working", "gjc")).toBe("working");
    for (let i = 0; i < 3; i++) { state.clock += 10_000; expect(statuses(await served())["gjc"]).toBe("gjc/working"); }
    append(message("assistant", "toolUse"), message("toolResult"));
    gjc.poll();
    expect(told).toHaveLength(1);
    append(message("assistant", "stop"));
    gjc.poll();
    expect(told.at(-1)).toEqual(["gjc", "idle", 0, true]);
    expect(completions.observe("gjc", "idle", "gjc")).toBe("done");
    for (let i = 0; i < 3; i++) { state.clock += 10_000; expect(statuses(await served())["gjc"]).toBe("gjc/done"); }
    append(asyncResult());
    gjc.poll();
    expect(completions.observe("gjc", told.at(-1)![1], "gjc")).toBe("working");
    expect(statuses(await served())["gjc"]).toBe("gjc/working");
  });

  it("reads READY not DONE for a turn that ended in an error or an abort, and DONE once a retry answers", async () => {
    const { gjc, told, append, state } = setup(lines(message("user"), message("assistant", "toolUse"), message("toolResult")));
    const completions = new CompletionTracker(null);
    const served = () => completions.readSnapshot(async () => { const raw = herdr(); await gjc.refresh(raw.panes); return gjc.apply(raw); });
    await served();
    const shown: AgentStatus[] = [];
    const settle = () => { for (const [id, status, , turn, rest] of told.splice(0)) if (id === "gjc" && turn) shown.push(completions.observe(id, status, "gjc", rest)); };
    append(message("assistant", "error", "2026-10-02T00:01:00.000Z"));
    gjc.poll(); settle();
    expect(shown).toEqual(["working", "idle"]);
    for (let i = 0; i < 3; i++) { state.clock += 10_000; expect(statuses(await served())["gjc"]).toBe("gjc/idle"); }
    append(message("assistant", "stop", "2026-10-02T00:02:00.000Z"));
    gjc.poll(); settle();
    expect(shown.slice(2)).toEqual(["done"]);
    append(message("user"), message("assistant", "aborted", "2026-10-02T00:03:00.000Z"));
    gjc.poll(); settle();
    expect(shown.slice(3)).toEqual(["idle"]);
    expect(statuses(await served())["gjc"]).toBe("gjc/idle");
  });

  it("leaves herdr's word alone while the transcript is missing, unreadable or holds no turn record", async () => {
    const { gjc, files } = setup();
    const raw = herdr();
    await gjc.refresh(raw.panes);
    expect(gjc.tracks("gjc")).toBe(true);
    delete files[FILE];
    gjc.poll();
    expect(gjc.tracks("gjc")).toBe(false);
    expect(statuses(gjc.apply(raw))["gjc"]).toBe("gjc/working");
    const { gjc: blind, told: blindTold, state: blindState } = setup(lines("not json", bookkeeping("gjc.model_change")));
    blindState.discovered.set("gjc", { path: "/s/elsewhere.jsonl", startedAt: null });
    await blind.refresh(raw.panes);
    expect([blind.tracks("gjc"), blind.runs("gjc")]).toEqual([false, true]);
    expect(statuses(blind.apply(raw))["gjc"]).toBe("gjc/working");
    expect(blindTold).toEqual([]);
    blindState.discovered.set("gjc", { path: FILE, startedAt: null });
    blindState.failing = true;
    blindState.clock += 10_000;
    await blind.refresh(raw.panes);
    expect(blind.tracks("gjc")).toBe(false);
    expect(statuses(blind.apply(raw))["gjc"]).toBe("gjc/working");
    expect(blindTold).toEqual([]);
    const { gjc: empty, state: emptyState } = setup("");
    emptyState.discovered.set("gjc", { path: FILE, startedAt: null });
    await empty.refresh(raw.panes);
    expect(empty.tracks("gjc")).toBe(false);
    expect(statuses(empty.apply(raw))["gjc"]).toBe("gjc/working");
  });

  it("does not take an unfinished turn of a process that is gone for a running one", async () => {
    const { gjc, told, state, append } = setup(lines(message("user", undefined, "2026-10-02T00:00:10.000Z"), message("assistant", "toolUse", "2026-10-02T00:00:12.000Z")));
    state.discovered.set("gjc", { path: FILE, startedAt: Date.parse("2026-10-02T00:05:00.000Z") });
    const raw = herdr();
    await gjc.refresh(raw.panes);
    expect(statuses(gjc.apply(raw))["gjc"]).toBe("gjc/idle");
    state.discovered.set("gjc", { path: FILE, startedAt: null });
    state.clock += 10_000;
    await gjc.refresh(raw.panes);
    expect(statuses(gjc.apply(raw))["gjc"]).toBe("gjc/idle");
    expect(told).toEqual([["gjc", "idle", 0, true, "failed-before"]]);
    append(message("user", undefined, "2026-10-02T00:06:00.000Z"));
    gjc.poll();
    expect(told).toEqual([["gjc", "idle", 0, true, "failed-before"], ["gjc", "working", 0, true]]);
  });

  it("reads a session the pane switched to from its own start, and lets go when another agent is named", async () => {
    const { gjc, told, files, state } = setup(lines(message("user")));
    const raw = herdr();
    await gjc.refresh(raw.panes);
    expect(told).toEqual([["gjc", "working", 0, true]]);
    const other = "/s/gjc-other.jsonl";
    files[other] = lines(message("user"), message("assistant", "error", "2026-10-02T00:02:00.000Z"));
    state.discovered.set("gjc", { path: other, startedAt: null });
    state.clock += 10_000;
    await gjc.refresh(raw.panes);
    expect(told.at(-1)).toEqual(["gjc", "idle", 0, true, "failed-before"]);
    expect(statuses(gjc.apply(raw))["gjc"]).toBe("gjc/idle");
    expect(gjc.named("gjc", "codex")).toBe(true);
    expect(gjc.named("gjc", "codex")).toBe(false);
    expect([gjc.tracks("gjc"), gjc.runs("gjc")]).toEqual([false, false]);
    expect(statuses(gjc.apply(raw))["gjc"]).toBe("gjc/working");
    for (const name of [null, "gjc"]) expect(gjc.named("lost", name)).toBe(false);
  });

  it("reads again what a failed read left, and only whole lines of a record still being written", async () => {
    const { gjc, told, append, files, state } = setup(lines(message("user")));
    await gjc.refresh(herdr().panes);
    expect(told).toEqual([["gjc", "working", 0, true]]);
    state.failing = true;
    append(message("assistant", "toolUse"));
    gjc.poll();
    expect(told).toHaveLength(1);
    state.failing = false;
    gjc.poll();
    expect(told).toHaveLength(2);
    const stop = message("assistant", "stop", "2026-10-02T00:02:00.000Z");
    files[FILE] += stop.slice(0, 60);
    gjc.poll();
    expect(told).toHaveLength(2);
    files[FILE] += stop.slice(60) + "\n";
    gjc.poll();
    expect(told.at(-1)).toEqual(["gjc", "idle", 0, true]);
  });

  it("reads INPUT while the agent's question waits on the user, and RUN again once its result arrives", async () => {
    const ask = JSON.stringify({ type: "message", timestamp: "2026-10-02T00:00:30.000Z", message: { role: "assistant", stopReason: "toolUse", content: [{ type: "toolCall", id: "q1", name: "ask", arguments: { question: "Which way?" } }] } });
    const answer = JSON.stringify({ type: "message", timestamp: "2026-10-02T00:00:40.000Z", message: { role: "toolResult", toolCallId: "q1", toolName: "ask", content: [] } });
    const { gjc, told, append } = setup(lines(message("user")));
    const raw = herdr();
    await gjc.refresh(raw.panes);
    append(ask);
    gjc.poll();
    expect(told.at(-1)).toEqual(["gjc", "blocked", 0, true]);
    expect(statuses(gjc.apply(raw))["gjc"]).toBe("gjc/blocked");
    append(message("assistant", "toolUse", "2026-10-02T00:00:35.000Z", "thinking"));
    gjc.poll();
    expect(told).toHaveLength(2);
    expect(statuses(gjc.apply(raw))["gjc"]).toBe("gjc/blocked");
    append(answer);
    gjc.poll();
    expect(told.at(-1)).toEqual(["gjc", "working", 0, true]);
    append(message("assistant", "stop"));
    gjc.poll();
    expect(told.at(-1)).toEqual(["gjc", "idle", 0, true]);
    const resumed = setup(lines(ask));
    await resumed.gjc.refresh(raw.panes);
    resumed.state.discovered.set("gjc", { path: FILE, startedAt: Date.parse("2026-10-02T00:05:00Z") });
    resumed.state.clock += 10_000;
    await resumed.gjc.refresh(raw.panes);
    expect(resumed.told.at(-1)).toEqual(["gjc", "idle", 0, true, "failed"]);
    resumed.append(message("user", undefined, "2026-10-02T00:06:00Z"));
    resumed.gjc.poll();
    expect(statuses(resumed.gjc.apply(raw))["gjc"]).toBe("gjc/working");
  });

  it("tells the pane's own rest once its transcript first answers, so herdr's word does not stand", async () => {
    const { gjc, told, append } = setup("");
    const completions = new CompletionTracker(null);
    const raw = herdr();
    expect(completions.observe("gjc", "working", "gjc")).toBe("working");
    await gjc.refresh(raw.panes);
    expect(gjc.tracks("gjc")).toBe(false);
    expect(statuses(gjc.apply(raw))["gjc"]).toBe("gjc/working");
    expect(told).toEqual([]);
    append(message("user"), message("assistant", "stop"));
    gjc.poll();
    expect(told).toEqual([["gjc", "idle", 0, true]]);
    expect(completions.observe("gjc", "idle", "gjc")).toBe("done");
  });

  it("hands the pane back to herdr's word when the transcript cannot be read whole, and takes it back whole", async () => {
    const { gjc, told, append, files, state } = setup(lines(message("user"), message("assistant", "stop")));
    const raw = herdr();
    await gjc.refresh(raw.panes);
    expect(gjc.tracks("gjc")).toBe(true);
    expect(statuses(gjc.apply(raw))["gjc"]).toBe("gjc/idle");
    delete files[FILE];
    gjc.poll();
    expect(gjc.tracks("gjc")).toBe(false);
    expect(statuses(gjc.apply(raw))["gjc"]).toBe("gjc/working");
    const prompt = message("user", undefined, "2026-10-02T00:03:00.000Z") + "\n";
    files[FILE] = lines(message("user"), message("assistant", "stop")) + prompt.slice(0, 50);
    state.failing = true;
    gjc.poll();
    expect(gjc.tracks("gjc")).toBe(false);
    expect(statuses(gjc.apply(raw))["gjc"]).toBe("gjc/working");
    state.failing = false;
    gjc.poll();
    expect(gjc.tracks("gjc")).toBe(false);
    files[FILE] += prompt.slice(50);
    gjc.poll();
    expect(told).toEqual([["gjc", "working", 0, true]]);
    expect(gjc.tracks("gjc")).toBe(true);
    append(message("assistant", "stop", "2026-10-02T00:04:00.000Z"));
    gjc.poll();
    expect(told.at(-1)).toEqual(["gjc", "idle", 0, true]);
    expect(statuses(gjc.apply(raw))["gjc"]).toBe("gjc/idle");
  });

  it("tells a turn the process now holding the session could not have run as an interruption, never a finish", async () => {
    const { gjc, told, state } = setup(lines(message("user", undefined, "2026-10-02T00:00:10.000Z"), message("assistant", "toolUse", "2026-10-02T00:00:12.000Z")));
    state.discovered.set("gjc", { path: FILE, startedAt: Date.parse("2026-10-02T00:00:00.000Z") });
    const completions = new CompletionTracker(null);
    const raw = herdr();
    await gjc.refresh(raw.panes);
    const settle = () => told.splice(0).map(([id, status, , , rest]) => completions.observe(id, status, "gjc", rest));
    expect(settle()).toEqual(["working"]);
    expect(statuses(completions.present(gjc.apply(raw)))["gjc"]).toBe("gjc/working");
    state.discovered.set("gjc", { path: FILE, startedAt: Date.parse("2026-10-02T00:05:00.000Z") });
    state.clock += 10_000;
    await gjc.refresh(raw.panes);
    expect(settle()).toEqual(["idle"]);
    expect(statuses(completions.present(gjc.apply(raw)))["gjc"]).toBe("gjc/idle");
    expect(completions.current("gjc")).toBe("idle");
  });

  it("reads a real transcript file, whole lines at a time and again from where it stopped", async () => {
    const path = join(root, "gjc-session.jsonl");
    writeFileSync(path, lines(message("user"), message("assistant", "toolUse", "2026-10-02T00:00:12.000Z", "x".repeat(200_000))));
    const told: [string, AgentStatus][] = [];
    const gjc = createGjcStatus({
      discover: async () => new Map<string, OmoPane>([["gjc", { path, startedAt: null }]]),
      snapshot: async () => herdr(),
      onChange: (id, status) => told.push([id, status]),
    });
    const raw = herdr();
    await gjc.refresh(raw.panes);
    expect(statuses(gjc.apply(raw))["gjc"]).toBe("gjc/working");
    appendFileSync(path, lines(message("toolResult"), asyncResult(true), message("assistant", "stop", "2026-10-02T00:02:00.000Z")));
    gjc.poll();
    expect(told).toEqual([["gjc", "working"], ["gjc", "idle"]]);
    expect(statuses(gjc.apply(raw))["gjc"]).toBe("gjc/idle");
  });

  it("keeps the shared tracker's OmO behavior when no GJC options are given", async () => {
    const omoFiles: Record<string, string> = { [FILE]: "" };
    const told: [string, AgentStatus][] = [];
    const omo = new OmoStatus({
      discover: async () => new Map<string, OmoPane>([["gjc", { path: FILE, startedAt: null }]]),
      snapshot: async () => herdr(),
      onChange: (id, status) => told.push([id, status]),
      file: {
        stat: (path) => path in omoFiles ? { size: Buffer.byteLength(omoFiles[path]!), id: "1" } : null,
        lines: (_path, from) => from,
      },
    });
    const raw = snapshotOf(pane("gjc", "claude", "idle"));
    await omo.refresh(raw.panes);
    expect(omo.tracks("gjc")).toBe(true);
    expect(statuses(omo.apply(raw))["gjc"]).toBe("omo/idle");
    expect(omo.named("gjc", "claude")).toBe(false);
    expect(omo.named("gjc", "codex")).toBe(true);
    expect(told).toEqual([]);
  });
});

describe("native OmO ownership alongside GJC", () => {
  function setup(native = true) {
    const cwd = mkdtempSync(join(root, "ownership-"));
    const omoPath = join(cwd, "2026-10-02_native-omo-session.jsonl");
    const gjcPath = join(cwd, "gjc.jsonl");
    writeFileSync(omoPath, lines(message("user")));
    writeFileSync(gjcPath, lines(message("user"), message("assistant", "stop")));
    const state = { native, known: true, clock: 0, duringOmo: async () => {}, duringGjc: async () => {} };
    const pane = (paneId: string): HerdrPane => ({ pane_id: paneId, agent: "gjc", agent_status: "working", cwd, focused: false, revision: 0, tab_id: "t", terminal_id: paneId, workspace_id: "w" });
    const raw: SessionSnapshot = { panes: [pane("wrapped"), pane("standalone")], agents: [pane("wrapped"), pane("standalone")], layouts: [], tabs: [], workspaces: [], protocol: 22, version: "test" };
    const completions = new CompletionTracker(null);
    const adopted: string[] = [];
    const turns: [string, AgentStatus][] = [];
    const candidates: string[][] = [];
    const omo = new OmoStatus({
      discover: async () => { await state.duringOmo(); return state.native ? new Map([["wrapped", { path: state.known ? omoPath : null, startedAt: null }]]) : new Map(); },
      snapshot: async () => raw,
      onFound: (id) => completions.adopt(id, "omo", OMO_ALIASES),
      onChange: (id, status, _background, turn, rest) => { if (turn) completions.observe(id, status, "omo", rest); },
      background: () => new Map([["native-omo-session", 3]]),
      now: () => state.clock,
    });
    const snapshot = () => readOmoSnapshot(async () => raw, omo);
    const gjc = createGjcStatus({
      snapshot,
      discover: async (panes) => {
        candidates.push(panes.map((pane) => pane.pane_id));
        const found = await gjcPanes(panes, { processInfo: async () => null, transcript: async () => gjcPath, underShell: async () => null });
        await state.duringGjc();
        return found;
      },
      onFound: (id) => { adopted.push(id); completions.adopt(id, "gjc", []); },
      onChange: (id, status, _background, turn, rest) => { turns.push([id, status]); if (turn) completions.observe(id, status, "gjc", rest); },
      now: () => state.clock,
    }, omo);
    const served = () => completions.readSnapshot(async () => {
      const named = await snapshot();
      await gjc.refresh(named.panes);
      return gjc.apply(omo.apply(named));
    });
    return { omo, gjc, state, raw, snapshot, served, adopted, turns, candidates, completions, omoPath, gjcPath };
  }

  it("preserves native status and background work when the raw pane is gjc", async () => {
    const f = setup();
    const shown = await f.served();
    expect(shown.panes.find((pane) => pane.pane_id === "wrapped")).toMatchObject({ agent: "omo", agent_status: "working" });
    expect(shown.agents.find((pane) => pane.pane_id === "wrapped")).toMatchObject({ agent: "omo", agent_status: "working" });
    expect(f.omo.backgroundOf("wrapped")).toBe(3);
    expect(f.gjc.runs("wrapped")).toBe(false);
    expect(f.adopted).toEqual(["standalone"]);
    expect(f.turns).toEqual([]);
    expect(shown.panes.find((pane) => pane.pane_id === "standalone")).toMatchObject({ agent: "gjc", agent_status: "idle" });
    expect(f.gjc.tracks("standalone")).toBe(true);
  });

  it("uses native ownership when periodic discovery invokes the shared snapshot dependency", async () => {
    const f = setup();
    let release = () => {};
    let entered = () => {};
    const discovered = new Promise<void>((resolve) => { release = resolve; });
    const discovering = new Promise<void>((resolve) => { entered = resolve; });
    f.state.duringOmo = async () => { entered(); await discovered; };
    const periodic = f.snapshot().then((snapshot) => f.gjc.refresh(snapshot.panes));
    await discovering;
    await Promise.resolve();
    expect(f.candidates).toEqual([]);
    release();
    await periodic;
    expect(f.candidates).toEqual([["standalone"]]);
    expect(f.adopted).toEqual(["standalone"]);
    expect(f.turns).toEqual([]);
    expect(f.omo.runs("wrapped")).toBe(true);
    expect(f.omo.backgroundOf("wrapped")).toBe(3);
  });

  it("hands ownership back to GJC when native discovery loses OmO", async () => {
    const f = setup();
    await f.served();
    f.state.native = false;
    f.state.clock += 10_000;
    const shown = await f.served();
    expect(f.omo.runs("wrapped")).toBe(false);
    expect(f.gjc.tracks("wrapped")).toBe(true);
    expect(f.adopted).toEqual(["standalone", "wrapped"]);
    expect(shown.panes.find((pane) => pane.pane_id === "wrapped")).toMatchObject({ agent: "gjc", agent_status: "idle" });
    appendFileSync(f.gjcPath, lines(message("user")));
    f.gjc.poll();
    expect(f.turns).toContainEqual(["wrapped", "working"]);
  });

  it("keeps the new GJC turn when a raw event clears inactive OmO history", async () => {
    const f = setup();
    await f.served();
    f.state.native = false;
    f.state.clock += 10_000;
    await f.served();
    appendFileSync(f.gjcPath, lines(message("user")));
    f.gjc.poll();
    if (reconcileProviderStatus(f.omo, f.gjc, { pane_id: "wrapped", agent: "gjc" })) f.completions.forget("wrapped");
    expect(f.gjc.tracks("wrapped")).toBe(true);
    expect(f.completions.current("wrapped")).toBe("working");
  });

  it("rejects a stale discovery result when native OmO is found during the GJC lookup", async () => {
    const f = setup(false);
    f.state.duringGjc = async () => { f.state.native = true; await f.omo.refresh(f.raw.panes); };
    await f.gjc.refresh(f.raw.panes);
    expect(f.adopted).toEqual(["standalone"]);
    expect(f.turns).toEqual([]);
    expect(f.completions.current("wrapped")).toBe("working");
    expect(f.gjc.runs("wrapped")).toBe(false);
    expect(f.omo.backgroundOf("wrapped")).toBe(3);
  });

  it("suppresses a stale GJC poll after native OmO takes its pane", async () => {
    const f = setup(false);
    await f.served();
    f.state.native = true;
    f.state.clock += 10_000;
    await f.omo.refresh(f.raw.panes);
    appendFileSync(f.omoPath, lines(message("assistant", "stop")));
    f.omo.poll();
    appendFileSync(f.gjcPath, lines(message("user")));
    f.gjc.poll();
    expect(f.turns).toEqual([["standalone", "working"]]);
    expect(f.completions.current("wrapped")).toBe("done");
    expect(f.omo.backgroundOf("wrapped")).toBe(3);
  });

  it.each(["gjc", "codex", "devin", "unknown", null])("preserves native ownership when a stale %s provider event arrives", async (agent) => {
    const f = setup(false);
    await f.served();
    f.state.native = true;
    f.state.clock += 10_000;
    await f.omo.refresh(f.raw.panes);
    appendFileSync(f.omoPath, lines(message("assistant", "stop")));
    f.omo.poll();
    if (reconcileProviderStatus(f.omo, f.gjc, { pane_id: "wrapped", agent })) f.completions.forget("wrapped");
    expect(f.omo.runs("wrapped")).toBe(true);
    expect(f.gjc.runs("wrapped")).toBe(false);
    expect(f.completions.current("wrapped")).toBe("done");
    expect(f.omo.backgroundOf("wrapped")).toBe(3);
  });

  it("keeps native ownership with an unknown session while raw status remains authoritative", async () => {
    const f = setup();
    f.state.known = false;
    await f.served();
    if (reconcileProviderStatus(f.omo, f.gjc, { pane_id: "wrapped", agent: "codex" })) f.completions.forget("wrapped");
    const shown = await f.served();
    expect(f.omo.runs("wrapped")).toBe(true);
    expect(f.omo.tracks("wrapped")).toBe(false);
    expect(f.adopted).toEqual(["standalone"]);
    expect(shown.panes.find((pane) => pane.pane_id === "wrapped")).toMatchObject({ agent: "omo", agent_status: "working" });
  });

  it("releases standalone GJC when another provider is named", async () => {
    const f = setup();
    await f.served();
    expect(reconcileProviderStatus(f.omo, f.gjc, { pane_id: "standalone", agent: "codex" })).toBe(true);
    expect(f.gjc.runs("standalone")).toBe(false);
  });

  it("returns to raw unknown status when native OmO disappears without another agent", async () => {
    const f = setup();
    await f.served();
    f.state.native = false;
    f.state.clock += 10_000;
    for (const pane of [...f.raw.panes, ...f.raw.agents]) {
      if (pane.pane_id === "wrapped") { pane.agent = null; pane.agent_status = "unknown"; }
    }
    const shown = await f.served();
    expect(f.omo.runs("wrapped")).toBe(false);
    expect(f.gjc.runs("wrapped")).toBe(false);
    expect(shown.panes.find((pane) => pane.pane_id === "wrapped")).toMatchObject({ agent: null, agent_status: "unknown" });
  });
});

describe("the gjc process a pane's transcript and start are read from", () => {
  const gjcPane = (id: string, extra: Record<string, unknown> = {}): HerdrPane =>
    ({ pane_id: id, agent: "gjc", agent_status: "working", cwd: "/work", ...extra } as unknown as HerdrPane);
  const transcript = async (id: string, _cwd: string) => `/t/${id}.jsonl`;

  it("binds the pane's current runtime cwd, not where it started", async () => {
    const asked: string[] = [];
    const panes = await gjcPanes([gjcPane("p", { foreground_cwd: "/work/now" }), gjcPane("q")], {
      processInfo: async () => null,
      transcript: async (_id, cwd) => { asked.push(cwd); return null; },
      underShell: async () => null,
    });
    expect(asked.sort()).toEqual(["/work", "/work/now"]);
    expect([...panes.values()]).toEqual([{ path: null, startedAt: null }, { path: null, startedAt: null }]);
  });

  it("takes the native start from the gjc in the foreground, and only there", async () => {
    const seen: number[] = [];
    const panes = await gjcPanes([gjcPane("p")], {
      processInfo: async () => ({ process_info: { foreground_processes: [
        { pid: 11, argv: ["node", "/home/u/.gjc/gjc"] },
        { pid: 12, argv: ["/usr/bin/claude", "--session", "abc"] },
      ] } }),
      transcript,
      startedAt: (pid) => { seen.push(pid); return pid === 11 ? 1_000 : 2_000; },
      underShell: async () => null,
    });
    expect(seen).toEqual([11]);
    expect(panes.get("p")).toEqual({ path: "/t/p.jsonl", startedAt: 1_000 });
  });

  it("takes the gjc under the pane's shell on Windows, with the start the table read for it", async () => {
    const panes = await gjcPanes([gjcPane("p")], {
      platform: "win32",
      processInfo: async () => ({ process_info: { shell_pid: 50, foreground_processes: [{ pid: 50, argv: ["pwsh.exe"] }] } }),
      transcript,
      underShell: async (shellPid) => shellPid === 50 ? { pid: 77, started: 4_242 } : null,
    });
    expect(panes.get("p")).toEqual({ path: "/t/p.jsonl", startedAt: 4_242 });
  });

  it("says nothing of a start when the process table could not be read at all", async () => {
    const panes = await gjcPanes([gjcPane("p")], {
      processInfo: async () => null,
      transcript,
      underShell: async () => undefined,
    });
    expect(panes.get("p")).toEqual({ path: "/t/p.jsonl", startedAt: null });
  });

  it("takes no start from the provider child herdr follows", async () => {
    const panes = await gjcPanes([gjcPane("p")], {
      processInfo: async () => ({ process_info: { foreground_processes: [{ pid: 88, argv: ["/usr/bin/claude"] }] } }),
      transcript,
      startedAt: () => 9_999,
      underShell: async () => null,
    });
    expect(panes.get("p")).toEqual({ path: "/t/p.jsonl", startedAt: null });
  });
});

async function onDarwinKernel<T>(startedMs: number, run: (spawned: { mock: { calls: unknown[] } }, blocking: { mock: { calls: unknown[] } }) => Promise<T>): Promise<T> {
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { value: "darwin" });
  const kernel = spyOn(darwinProcess, "darwinStartTime").mockReturnValue(BigInt(startedMs) * 1000n);
  const blocking = spyOn(Bun, "spawnSync");
  const spawned = spyOn(Bun, "spawn");
  try { return await run(spawned, blocking); } finally {
    spawned.mockRestore();
    blocking.mockRestore();
    kernel.mockRestore();
    Object.defineProperty(process, "platform", platform);
  }
}

it("reads a GJC pane's process start from the kernel on macOS, with no ps child", async () => {
  const clock = spyOn(Date, "now").mockReturnValue(61_000);
  const pane = { pane_id: "gjc-darwin", workspace_id: "w", tab_id: "t", terminal_id: "term", focused: false, revision: 0,
    agent: "gjc", agent_status: "idle", cwd: root } as HerdrPane;
  try {
    await onDarwinKernel(1_000, async (spawned, blocking) => {
      const found = await gjcPanes([pane], {
        platform: "darwin",
        processInfo: async () => ({ process_info: { pane_id: pane.pane_id, foreground_processes: [{ pid: 300, name: "gjc", argv: ["/usr/bin/gjc"] }] } }),
        transcript: async () => null,
      });
      expect(found.get(pane.pane_id)).toEqual({ path: null, startedAt: 1_000 });
      expect(spawned.mock.calls).toHaveLength(0);
      expect(blocking.mock.calls).toHaveLength(0);
    });
  } finally { clock.mockRestore(); }
});
