import { describe, expect, it } from "bun:test";
import type { HerdrPane, SessionHistoryRow } from "../../shared/protocol.ts";
import { formatChatTimestamp } from "./chatTimestamp.ts";
import type { Translate } from "./i18n.ts";
import { claudeResumeRequest, inFlightGuard, observeRecentResume, paneShowingRow, paneShowingSession, RECENT_RESUME_MS, recentlyResumedPane, recentResumeEnded, resumeTabRequest, rowKey, sessionHistoryAgent, sessionHistoryListAgent, sessionHistorySourcePane, sessionRowTime, standingResume, type RecentResume } from "./sessionHistory.ts";

const pane = (overrides: Partial<HerdrPane>): HerdrPane => ({
  pane_id: "p1", tab_id: "t1", terminal_id: "term1", workspace_id: "w1", agent: "codex", agent_status: "idle", focused: false, revision: 1, ...overrides,
}) as HerdrPane;
const row = (overrides: Partial<SessionHistoryRow> = {}): SessionHistoryRow => ({
  id: "00000000-0000-4000-8000-000000000002", title: "Retry budget", firstMessage: "Cap the retries", startedAt: null, updatedAt: "2026-09-25T09:09:00.000Z",
  resume: { argv: ["codex", "resume", "00000000-0000-4000-8000-000000000002"] }, ...overrides,
});

describe("sessionHistoryListAgent", () => {
  it("lists a pane's own agent, and nothing for a pane whose agent keeps no store the route reads", () => {
    expect(sessionHistoryListAgent({ agent: "codex", scope: "pane" }, "claude", ["claude"])).toBe("codex");
    expect(sessionHistoryListAgent({ agent: "copilot", scope: "pane" }, "claude", ["claude", "codex"])).toBeNull();
    expect(sessionHistoryListAgent({ agent: null, scope: "pane" }, "claude", ["claude"])).toBeNull();
  });
  it("lists a workspace's named agent, else the front pane's, else any of the workspace's, else Claude's", () => {
    expect(sessionHistoryListAgent({ agent: "omp" }, "claude", ["codex"])).toBe("omp");
    expect(sessionHistoryListAgent({ agent: "copilot" }, "codex", ["claude"])).toBe("codex");
    expect(sessionHistoryListAgent({ agent: null }, null, ["copilot", null, "pi"])).toBe("pi");
    expect(sessionHistoryListAgent(undefined, undefined, [])).toBe("claude");
  });
});

describe("sessionHistorySourcePane", () => {
  const shell = pane({ pane_id: "shell", agent: null });
  const codex = pane({ pane_id: "codex" });
  const claude = pane({ pane_id: "claude", agent: "claude" });
  const another = pane({ pane_id: "another", agent: "claude" });
  const panes = [shell, codex, claude, another];

  it.each(["shell", "codex"])("prefers a Claude pane when the selected pane is %s", (selectedPaneId) => {
    expect(sessionHistorySourcePane("claude", panes, { workspaceId: "w1", selectedPaneId })).toBe("claude");
  });
  it("prefers Claude when a Codex pane asks with the picker on Claude", () => {
    expect(sessionHistorySourcePane("claude", panes, { workspaceId: "w1", askingPaneId: "codex", selectedPaneId: "shell" })).toBe("claude");
  });
  it.each([
    { askingPaneId: "another", selectedPaneId: "claude", expected: "another" },
    { askingPaneId: "codex", selectedPaneId: "another", expected: "another" },
  ])("prefers the asking Claude, then the selected Claude: $expected", ({ expected, ...request }) => {
    expect(sessionHistorySourcePane("claude", panes, { workspaceId: "w1", ...request })).toBe(expected);
  });
  it.each([
    { askingPaneId: "codex", selectedPaneId: "shell", expected: "codex" },
    { askingPaneId: "closed", selectedPaneId: "codex", expected: "codex" },
    { askingPaneId: "closed", selectedPaneId: "elsewhere", expected: "shell" },
  ])("falls back within the workspace when no Claude runs: $expected", ({ expected, ...request }) => {
    const roster = [pane({ pane_id: "elsewhere", workspace_id: "w2", agent: "claude" }), shell, codex];
    expect(sessionHistorySourcePane("claude", roster, { workspaceId: "w1", ...request })).toBe(expected);
  });
  it("has no source when the workspace has no panes", () => {
    expect(sessionHistorySourcePane("claude", panes, { workspaceId: "empty", askingPaneId: "claude" })).toBeNull();
  });
  it("keeps the asking pane for other agents even when Claude runs", () => {
    expect(sessionHistorySourcePane("codex", panes, { workspaceId: "w1", askingPaneId: "shell", selectedPaneId: "claude" })).toBe("shell");
  });
});

describe("sessionRowTime", () => {
  const t: Translate = (key, vars) => JSON.stringify({ key, vars });
  const now = Date.parse("2026-10-01T12:00:00.000Z");
  const updated = formatChatTimestamp(row().updatedAt, now, "en-US", t)!;
  it("labels the row by when it was last touched and names both its start and its last touch in the tooltip", () => {
    const startedAt = "2026-09-24T08:00:00.000Z";
    const time = sessionRowTime(row({ startedAt }), now, "en-US", t)!;
    expect(time.label).toBe(updated.label);
    expect((JSON.parse(time.title) as { vars: unknown }).vars).toEqual({ started: formatChatTimestamp(startedAt, now, "en-US", t)!.full, updated: updated.full });
  });
  it("keeps the last touch alone when the store records no start, and has no time without a readable last touch", () => {
    expect(sessionRowTime(row({ startedAt: null }), now, "en-US", t)).toEqual({ label: updated.label, title: updated.full });
    expect(sessionRowTime(row({ startedAt: "not a time" }), now, "en-US", t)).toEqual({ label: updated.label, title: updated.full });
    expect(sessionRowTime(row({ updatedAt: "not a time" }), now, "en-US", t)).toBeNull();
  });
});

describe("paneShowingSession", () => {
  const id = "00000000-0000-4000-8000-000000000002";
  it("finds the pane whose reported session id is the row's, in the workspace, for the agent", () => {
    const shown = pane({ pane_id: "p2", agent_session: { agent: "codex", kind: "id", source: "herdr:codex", value: id } });
    const panes = [pane({ pane_id: "p1" }), shown, pane({ pane_id: "p3", workspace_id: "w2", agent_session: { agent: "codex", kind: "id", source: "herdr:codex", value: id } })];
    expect(paneShowingSession(panes, "w1", "codex", id)?.pane_id).toBe("p2");
  });
  it("reads a session reported as a path by its file name: the id, or the id after a separator", () => {
    const panes = [
      pane({ pane_id: "claude", agent: "claude", agent_session: { agent: "claude", kind: "path", source: "herdr:claude", value: `/home/u/.claude/projects/-home-u-work/${id}.jsonl` } }),
      pane({ pane_id: "codex", agent_session: { agent: "codex", kind: "path", source: "herdr:codex", value: `/home/u/.codex/sessions/2026/09/25/rollout-2026-09-25T09-09-00-${id}.jsonl` } }),
      pane({ pane_id: "omp", agent: "omp", agent_session: { agent: "omp", kind: "path", source: "herdr:omp", value: `C:\\Users\\u\\.omp\\agent\\sessions\\-work\\2026-09-25T09-09-00_${id}.jsonl` } }),
    ];
    expect(paneShowingSession(panes, "w1", "claude", id)?.pane_id).toBe("claude");
    expect(paneShowingSession(panes, "w1", "codex", id)?.pane_id).toBe("codex");
    expect(paneShowingSession(panes, "w1", "omp", id)?.pane_id).toBe("omp");
    expect(paneShowingSession([pane({ agent_session: { agent: "codex", kind: "path", source: "herdr:codex", value: `/s/x${id}.jsonl` } })], "w1", "codex", id)).toBeUndefined();
  });
  it("never matches another agent's session, another workspace's pane or a pane that reports none", () => {
    const panes = [
      pane({ pane_id: "other-agent", agent: "claude", agent_session: { agent: "claude", kind: "id", source: "hook", value: id } }),
      pane({ pane_id: "other-workspace", workspace_id: "w2", agent_session: { agent: "codex", kind: "id", source: "herdr:codex", value: id } }),
      pane({ pane_id: "silent", agent_session: null }),
      pane({ pane_id: "empty", agent_session: { agent: "codex", kind: "id", source: "herdr:codex", value: "" } }),
    ];
    expect(paneShowingSession(panes, "w1", "codex", id)).toBeUndefined();
    expect(paneShowingSession(panes, "w1", "codex", "")).toBeUndefined();
  });
});

describe("resumeTabRequest", () => {
  it("starts the row's argv as the agent of a new tab in the workspace, in the listed folder", () => {
    expect(resumeTabRequest(row(), "w1", "/home/u/work")).toEqual({
      workspace_id: "w1", cwd: "/home/u/work", label: null, agent: { kind: "codex", args: ["resume", "00000000-0000-4000-8000-000000000002"] },
    });
  });
  it("has nothing to start for a row without a verified resume, or with an empty argv", () => {
    expect(resumeTabRequest(row({ resume: null }), "w1", "/home/u/work")).toBeNull();
    expect(resumeTabRequest(row({ resume: { argv: [] } }), "w1", "/home/u/work")).toBeNull();
  });
});

describe("a Claude row bound to its store", () => {
  const id = "00000000-0000-4000-8000-000000000002";
  const ALTERNATE = "a".repeat(24);
  const DEFAULT = "d".repeat(24);
  const claudeRow = (store: string | null, paneId = "p1") => row({ resume: { argv: ["claude", "--resume", id], ...(store === null ? {} : { source: { pane_id: paneId, store_key: store } }) } });
  const reporting = (paneId: string) => pane({ pane_id: paneId, agent: "claude", agent_session: { agent: "claude", kind: "id", source: "herdr:claude", value: id } });

  it("same UUID in another store is not Open", () => {
    // p2 reports the id, but the list was read from p1's store: p2 may be another account's session
    const panes = [pane({ pane_id: "p1", agent: "claude" }), reporting("p2")];
    expect(paneShowingSession(panes, "w1", "claude", id)?.pane_id).toBe("p2");
    expect(paneShowingRow(panes, "w1", "claude", claudeRow(ALTERNATE, "p1"))).toBeUndefined();
    expect(paneShowingRow([reporting("p1")], "w1", "claude", claudeRow(ALTERNATE, "p1"))?.pane_id).toBe("p1");
    expect(paneShowingRow([reporting("p2"), reporting("p1")], "w1", "claude", claudeRow(ALTERNATE, "p1"))?.pane_id).toBe("p1");
    expect(paneShowingRow([reporting("p1")], "w1", "claude", claudeRow(null))).toBeUndefined();
    expect(paneShowingRow([pane({ agent_session: { agent: "codex", kind: "id", source: "herdr:codex", value: id } })], "w1", "codex", row())?.pane_id).toBe("p1");
  });

  it("resumes through the store-bound route only, never the argv-only tab request", () => {
    expect(claudeResumeRequest(claudeRow(ALTERNATE), "w1")).toEqual({ workspace_id: "w1", pane_id: "p1", agent: "claude", session_id: id, store_key: ALTERNATE });
    // an older bridge's row (no source) has no Resume at all: neither route
    expect(claudeResumeRequest(claudeRow(null), "w1")).toBeNull();
    expect(resumeTabRequest(claudeRow(null), "w1", "/home/u/work")).toBeNull();
    expect(resumeTabRequest(claudeRow(ALTERNATE), "w1", "/home/u/work")).toBeNull();
    expect(claudeResumeRequest(row(), "w1")).toBeNull();
  });

  it("recent resumes include store identity", () => {
    const record: RecentResume = { machineId: "local", workspaceId: "w1", agent: "claude", id, store: ALTERNATE, paneId: "p-new", at: 1_000, seen: true };
    const panes = [pane({ pane_id: "p-new", agent: "claude", agent_session: null })];
    expect(standingResume([record], panes, "local", "w1", "claude", id, 2_000, ALTERNATE)).toBe(record);
    expect(standingResume([record], panes, "local", "w1", "claude", id, 2_000, DEFAULT)).toBeUndefined();
    expect(recentlyResumedPane([record], panes, "local", "w1", "claude", id, 2_000, DEFAULT)).toBeUndefined();
    expect(recentlyResumedPane([record], panes, "local", "w1", "claude", id, 2_000, ALTERNATE)?.pane_id).toBe("p-new");
    expect(rowKey(claudeRow(ALTERNATE))).not.toBe(rowKey(claudeRow(DEFAULT)));
    expect(rowKey(row())).toBe(`:${row().id}`);
  });
});

describe("inFlightGuard", () => {
  it("runs one task at a time: a second call while the first is in flight is refused", async () => {
    const guard = inFlightGuard();
    let settle!: (value: string) => void;
    const first = guard.run(() => new Promise<string>((resolve) => { settle = resolve; }));
    expect(first).not.toBeNull();
    expect(guard.busy()).toBe(true);
    expect(guard.run(() => Promise.resolve("second"))).toBeNull();
    settle("first");
    expect(await first).toBe("first");
    expect(guard.busy()).toBe(false);
    expect(await guard.run(() => Promise.resolve("third"))).toBe("third");
  });
  it("is free again after a task fails", async () => {
    const guard = inFlightGuard();
    const failed = guard.run(() => Promise.reject(new Error("refused")));
    await expect(failed).rejects.toThrow("refused");
    expect(guard.busy()).toBe(false);
    expect(await guard.run(() => Promise.resolve("again"))).toBe("again");
  });
});

describe("a session resumed a moment ago (the reopen window)", () => {
  const id = "00000000-0000-4000-8000-000000000002";
  const record: RecentResume = { machineId: "local", workspaceId: "w1", agent: "codex", id, paneId: "p-new", at: 1_000, seen: true };
  const fresh = pane({ pane_id: "p-new", agent_session: null });
  it("counts the new pane as showing the session while it has reported none: Open, not Resume", () => {
    expect(recentlyResumedPane([record], [pane({ pane_id: "p1" }), fresh], "local", "w1", "codex", id, 2_000)?.pane_id).toBe("p-new");
    expect(recentResumeEnded(record, [fresh], 2_000)).toBe(false);
  });
  it("keys the record by PC, workspace, agent and session", () => {
    const panes = [fresh];
    expect(recentlyResumedPane([record], panes, "remote-pc", "w1", "codex", id, 2_000)).toBeUndefined();
    expect(recentlyResumedPane([record], panes, "local", "w2", "codex", id, 2_000)).toBeUndefined();
    expect(recentlyResumedPane([record], panes, "local", "w1", "claude", id, 2_000)).toBeUndefined();
    expect(recentlyResumedPane([record], panes, "local", "w1", "codex", "other", 2_000)).toBeUndefined();
  });
  it("ends only on evidence: herdr reports the pane's session (whichever it is), or the pane it saw is gone", () => {
    expect(recentResumeEnded(record, [pane({ pane_id: "p-new", agent_session: { agent: "codex", kind: "id", source: "herdr:codex", value: id } })], 2_000)).toBe(true);
    expect(recentResumeEnded(record, [pane({ pane_id: "p-new", agent_session: { agent: "codex", kind: "id", source: "herdr:codex", value: "another" } })], 2_000)).toBe(true);
    expect(recentResumeEnded(record, [pane({ pane_id: "p1" })], 2_000)).toBe(true);
  });
  it("ends once a pane seen running the resumed agent no longer runs it: back at its shell, or another agent in it", () => {
    const later = 1_000 + 10 * RECENT_RESUME_MS;
    const ran = { ...record, ran: true };
    expect(recentResumeEnded(ran, [pane({ pane_id: "p-new", agent: null, agent_session: null })], 2_000)).toBe(true);
    expect(recentResumeEnded(ran, [pane({ pane_id: "p-new", agent: "claude", agent_session: null })], later)).toBe(true);
    expect(standingResume([ran], [pane({ pane_id: "p-new", agent: null, agent_session: null })], "local", "w1", "codex", id, 2_000)).toBeUndefined();
  });
  it("holds through the new pane's startup: no agent yet, or another agent's name for a moment", () => {
    // herdr has not labelled the new pane yet, or an omo pane shows as pi or claude while it starts
    for (const agent of [null, "pi", "claude"]) {
      const starting = [pane({ pane_id: "p-new", agent, agent_session: null })];
      expect([agent, recentResumeEnded(record, starting, 2_000)]).toEqual([agent, false]);
      expect(standingResume([record], starting, "local", "w1", "codex", id, 2_000)).toBe(record);
    }
  });
  it("follows a pane through startup, its agent, and back to its shell", () => {
    const omo: RecentResume = { ...record, agent: "omo", seen: false };
    let current = omo;
    const step = (agent: string | null): boolean => {
      const panes = [pane({ pane_id: "p-new", agent, agent_session: null })];
      current = observeRecentResume(current, panes);
      return recentResumeEnded(current, panes, 2_000);
    };
    expect([null, "pi", "claude", "omo", "omo"].map(step)).toEqual([false, false, false, false, false]);
    expect(current.seen && current.ran).toBe(true);
    expect(step(null)).toBe(true);
  });
  it("keeps Open, never Resume, for a pane still listed without a session however long ago: at +121 s and beyond", () => {
    const later = 1_000 + 121_000;
    expect(recentResumeEnded(record, [fresh], later)).toBe(false);
    expect(recentlyResumedPane([record], [fresh], "local", "w1", "codex", id, later)?.pane_id).toBe("p-new");
    expect(recentResumeEnded(record, [fresh], 1_000 + 10 * RECENT_RESUME_MS)).toBe(false);
    expect(recentResumeEnded({ ...record, seen: false }, [fresh], 1_000 + 10 * RECENT_RESUME_MS)).toBe(false);
  });
  it("ends a record whose pane the roster never listed once the bound has passed, and not before", () => {
    const unseen = { ...record, seen: false };
    const absent = [pane({ pane_id: "p1" })];
    expect(recentResumeEnded(unseen, absent, 1_000 + RECENT_RESUME_MS)).toBe(false);
    expect(standingResume([unseen], absent, "local", "w1", "codex", id, 1_000 + RECENT_RESUME_MS)).toBe(unseen);
    expect(recentResumeEnded(unseen, absent, 1_000 + RECENT_RESUME_MS + 1)).toBe(true);
    expect(standingResume([unseen], absent, "local", "w1", "codex", id, 1_000 + RECENT_RESUME_MS + 1)).toBeUndefined();
    expect(recentResumeEnded(unseen, undefined, 1_000 + RECENT_RESUME_MS + 1)).toBe(false);
  });
  it("stands for a pane the roster has not shown yet (no Resume, no pane to open either), and for a roster not known", () => {
    const unseen = { ...record, seen: false };
    expect(recentResumeEnded(unseen, [pane({ pane_id: "p1" })], 2_000)).toBe(false);
    expect(recentResumeEnded(record, undefined, 2_000)).toBe(false);
    expect(standingResume([unseen], [pane({ pane_id: "p1" })], "local", "w1", "codex", id, 2_000)).toBe(unseen);
    expect(recentlyResumedPane([unseen], [pane({ pane_id: "p1" })], "local", "w1", "codex", id, 2_000)).toBeUndefined();
  });
});

describe("sessionHistoryAgent", () => {
  it("names the agents whose stores the route lists, and no other pane program", () => {
    expect(sessionHistoryAgent("codex")).toBe("codex");
    expect(sessionHistoryAgent("agy")).toBe("agy");
    expect(sessionHistoryAgent("bash")).toBeNull();
    expect(sessionHistoryAgent(null)).toBeNull();
    expect(sessionHistoryAgent(undefined)).toBeNull();
  });
});
