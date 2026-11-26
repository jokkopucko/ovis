import { afterEach, describe, expect, it } from "bun:test";
import { act, createElement } from "react";
import { openPage, type Page } from "./page.fixture.ts";
import type { ConversationPart, ConversationTurn } from "../../shared/protocol.ts";
import { publishSessionStats, sessionStats, useSessionStats, type SessionStats } from "./sessionStats.ts";

const user = (ts: string): ConversationTurn => ({ role: "user", ts, parts: [{ kind: "text", text: "ask" }] });
const agent = (ts: string | null, end: string | undefined, parts: ConversationPart[] = [{ kind: "text", text: "answer" }]): ConversationTurn =>
  ({ role: "assistant", ts, ...(end === undefined ? {} : { end_ts: end }), parts });
const goalCall = (name: string, goal: unknown): ConversationPart =>
  ({ kind: "tool", name, summary: name, input: "{}", output: JSON.stringify({ goal }) });
const goal = (objective: string, status: string) => ({ objective, status, tokensUsed: 1200, timeUsedSeconds: 90 });

describe("sessionStats", () => {
  it("adds up the agent turns' recorded durations, skipping a turn whose span is unknown or backwards", () => {
    const stats = sessionStats([
      user("2026-10-26T10:00:00Z"), agent("2026-10-26T10:00:01Z", "2026-10-26T10:01:01Z"),
      user("2026-10-26T11:00:00Z"), agent("2026-10-26T11:00:00Z", "2026-10-26T11:30:00Z"),
      agent(null, "2026-10-26T12:00:00Z"), agent("2026-10-26T13:00:00Z", "2026-10-26T12:00:00Z"), agent("2026-10-26T14:00:00Z", undefined),
    ], true, null);
    expect(stats.workedSeconds).toBe(60 + 30 * 60);
  });

  it("says a sum that leaves out a settled turn's unknown span is not the whole session's, but not for the running last turn", () => {
    const timed = agent("2026-10-26T10:00:00Z", "2026-10-26T10:01:00Z");
    const running = agent("2026-10-26T11:00:00Z", undefined);
    expect(sessionStats([agent(null, "2026-10-26T09:00:00Z"), timed], true, null).complete).toBe(false);
    expect(sessionStats([timed, user("2026-10-26T10:59:00Z"), running], true, null).complete).toBe(true);
  });

  it("knows no work time before any agent turn has a span", () => {
    expect(sessionStats([user("2026-10-26T10:00:00Z"), agent("2026-10-26T10:00:01Z", undefined)], true, 10).workedSeconds).toBeNull();
  });

  it("passes on whether the turns reach back to the conversation's beginning, and the transcript's size", () => {
    const stats = sessionStats([agent("2026-10-26T10:00:00Z", "2026-10-26T10:00:05Z")], false, 2048);
    expect(stats.complete).toBe(false);
    expect(stats.bytes).toBe(2048);
  });

  it("keeps the goal the latest goal call left, across turns, and drops it when a later call says there is none", () => {
    const set = agent("2026-10-26T10:00:00Z", "2026-10-26T10:00:05Z", [goalCall("create_goal", goal("Ship the metric", "active"))]);
    const later = agent("2026-10-26T11:00:00Z", "2026-10-26T11:00:05Z");
    const updated = agent("2026-10-26T12:00:00Z", "2026-10-26T12:00:05Z", [goalCall("update_goal", goal("Ship the metric", "complete"))]);
    const cleared = agent("2026-10-26T13:00:00Z", "2026-10-26T13:00:05Z", [goalCall("get_goal", null)]);
    expect(sessionStats([set, later], true, null).goal).toMatchObject({ objective: "Ship the metric", status: "active", tokensUsed: 1200, timeUsedSeconds: 90 });
    expect(sessionStats([set, later, updated], true, null).goal?.status).toBe("complete");
    expect(sessionStats([set, later, updated, cleared], true, null).goal).toBeNull();
  });
});

describe("useSessionStats", () => {
  let page: Page;
  afterEach(async () => { await page.close(); });

  it("keeps a pane's totals while another view of the same pane still shows them", async () => {
    page = openPage();
    const seen: Array<SessionStats | null> = [];
    const Probe = () => { seen.push(useSessionStats("local", "w1:p1")); return null; };
    const left = Symbol("left"), right = Symbol("right");
    const stats = (bytes: number) => sessionStats([], true, bytes);
    await page.render(createElement(Probe));
    await act(async () => { publishSessionStats("local", "w1:p1", left, stats(10)); publishSessionStats("local", "w1:p1", right, stats(20)); });
    expect(seen.at(-1)?.bytes).toBe(20);
    await act(async () => { publishSessionStats("local", "w1:p1", right, null); });
    expect(seen.at(-1)?.bytes).toBe(10);
    await act(async () => { publishSessionStats("local", "w1:p1", left, null); });
    expect(seen.at(-1)).toBeNull();
  });
});
