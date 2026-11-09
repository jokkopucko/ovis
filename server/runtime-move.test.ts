import { describe, expect, it } from "bun:test";
import type { PaneInfo, PaneLayoutSnapshot, SessionSnapshot } from "../shared/herdr-api.generated.ts";
import { moveUnavailable, planMove, tabTree, type MoveFacts } from "./runtime-move.ts";

// herdr 0.9.5's answer for a tab split right, then its right pane split down (isolated test session)
const layout: PaneLayoutSnapshot = {
  workspace_id: "w1", tab_id: "w1:t1", focused_pane_id: "w1:p1", zoomed: false,
  area: { x: 0, y: 0, width: 120, height: 40 },
  splits: [
    { id: "split_0_root", direction: "right", ratio: 0.5, rect: { x: 0, y: 0, width: 120, height: 40 } },
    { id: "split_1_1", direction: "down", ratio: 0.5, rect: { x: 60, y: 0, width: 60, height: 40 } },
  ],
  panes: [
    { pane_id: "w1:p1", focused: true, rect: { x: 0, y: 0, width: 60, height: 40 } },
    { pane_id: "w1:p2", focused: false, rect: { x: 60, y: 0, width: 60, height: 20 } },
    { pane_id: "w1:p3", focused: false, rect: { x: 60, y: 20, width: 60, height: 20 } },
  ],
};

describe("moveUnavailable", () => {
  it("offers no move on Windows, where Settings still switches to herdr-core", () => {
    const facts = { serving: "herdr", source: "detected", tui: { installed: true, running: true }, app_installed: false, switch_to: "herdr-core", locked: null } as const;
    expect(moveUnavailable("herdr", facts, "linux")).toBeNull();
    // the move ends panes through Unix process groups, and its lock refuses Windows (runtime-move-lock.ts)
    expect(moveUnavailable("herdr", facts, "win32")).toBe("runtime_locked");
  });
});

describe("tabTree", () => {
  it("rebuilds herdr's split tree from its split paths", () => {
    expect(tabTree(layout, ["w1:p1", "w1:p2", "w1:p3"])).toEqual({
      split: "right", ratio: 0.5, first: { pane: "w1:p1" }, second: { split: "down", ratio: 0.5, first: { pane: "w1:p2" }, second: { pane: "w1:p3" } },
    });
  });

  it("lays panes side by side when the splits do not describe the tab", () => {
    expect(tabTree({ ...layout, splits: [] }, ["w1:p1", "w1:p2", "w1:p3"])).toEqual({
      split: "right", ratio: 2 / 3, first: { split: "right", ratio: 0.5, first: { pane: "w1:p1" }, second: { pane: "w1:p2" } }, second: { pane: "w1:p3" },
    });
  });
});

const pane = (id: string, extra: Partial<PaneInfo>): PaneInfo => ({
  pane_id: id, terminal_id: `term-${id}`, workspace_id: "w1", tab_id: "w1:t1", focused: false, cwd: "/work", agent_status: "unknown", revision: 0, ...extra,
});
const session = (agent: string, value: string) => ({ agent, kind: "id", source: `herdr:${agent}`, value });
const snapshot = (panes: PaneInfo[]): SessionSnapshot => ({
  agents: [], layouts: [], panes, protocol: 1, version: "0.9.5",
  tabs: [{ tab_id: "w1:t1", workspace_id: "w1", label: "1", number: 1, pane_count: panes.length, focused: false, agent_status: "unknown" }],
  workspaces: [{ workspace_id: "w1", label: "ovis", number: 1, active_tab_id: "w1:t1", focused: false, agent_status: "unknown", pane_count: panes.length, tab_count: 1 }],
});
// a shell in front is its own process group; "vim" runs in front of pane "editing"; "typed" has text in its input line
const facts: MoveFacts = {
  findResume: async (agent, id) => id === "listed" ? [agent, "--resume", id] : null,
  processInfo: async (id) => id === "editing"
    ? { pane_id: id, shell_pid: 10, foreground_process_group_id: 20, foreground_processes: [{ pid: 20, name: "vim" }] }
    : id === "unread" ? undefined : { pane_id: id, shell_pid: 10, foreground_process_group_id: 10 },
  inputEmpty: async (id, agent) => id === "typed" ? false : agent === "claude" ? true : null,
  holdsPending: (id) => id === "queued",
};

describe("planMove", () => {
  it("says what becomes of each pane, without touching any", async () => {
    const plan = await planMove(snapshot([
      pane("claude", { agent: "claude", agent_status: "idle", agent_session: session("claude", "listed") }),
      pane("codex", { agent: "codex", agent_status: "done", agent_session: session("codex", "gone") }),
      pane("shell", {}),
      pane("editing", {}),
      pane("unread", {}),
      pane("working", { agent: "codex", agent_status: "working" }),
      pane("asking", { agent: "claude", agent_status: "blocked" }),
      pane("queued", { agent: "claude", agent_status: "idle" }),
      pane("typed", { agent: "claude", agent_status: "idle" }),
      pane("copilot", { agent: "copilot", agent_status: "idle" }),
      pane("ended", { agent_session: session("pi", "listed") }),
      pane("ended-elsewhere", { agent_session: session("codex", "live") }),
      pane("live", { agent: "codex", agent_status: "working", agent_session: session("codex", "live") }),
    ]), facts);
    expect(Object.fromEntries(plan.panes.map((entry) => [entry.pane_id, entry.verdict]))).toEqual({
      claude: { kind: "resume", agent: "claude", session_id: "listed", argv: ["claude", "--resume", "listed"], ended: false },
      // its input line cannot be read: the exit could send what is typed there
      codex: { kind: "needs_you", agent: "codex" },
      shell: { kind: "shell" },
      editing: { kind: "busy", reason: "command_running", agent: null, command: "vim" },
      unread: { kind: "busy", reason: "command_running", agent: null, command: "?" },
      working: { kind: "busy", reason: "agent_working", agent: "codex", command: null },
      asking: { kind: "busy", reason: "agent_waiting", agent: "claude", command: null },
      queued: { kind: "busy", reason: "agent_working", agent: "claude", command: null },
      typed: { kind: "needs_you", agent: "claude" },
      copilot: { kind: "needs_you", agent: "copilot" },
      // ended by the person: reopened, nothing typed
      ended: { kind: "resume", agent: "pi", session_id: "listed", argv: ["pi", "--resume", "listed"], ended: true },
      "ended-elsewhere": { kind: "shell" },
      live: { kind: "busy", reason: "agent_working", agent: "codex", command: null },
    });
    expect(plan.ready).toBe(false);
  });

  it("starts a pane whose folder is gone in the home folder, not in a folder that cannot be entered", async () => {
    // herdr names a deleted folder "<path> (deleted)"; a shell started there fails, and with it the whole move
    const plan = await planMove(snapshot([pane("gone", { cwd: "/no/such/folder (deleted)" }), pane("here", { cwd: process.cwd() })]), facts);
    expect(plan.panes.map((entry) => [entry.pane_id, entry.cwd])).toEqual([["gone", null], ["here", process.cwd()]]);
  });

  it("reopens one conversation in one pane only", async () => {
    const plan = await planMove(snapshot([
      pane("first", { agent: "claude", agent_status: "idle", agent_session: session("claude", "listed") }),
      pane("second", { agent: "claude", agent_status: "idle", agent_session: session("claude", "listed") }),
    ]), facts);
    expect(plan.panes.map((entry) => entry.verdict.kind)).toEqual(["resume", "fresh"]);
    expect(plan.ready).toBe(true);
  });

  it("names a new revision when a pane changes", async () => {
    const before = await planMove(snapshot([pane("a", { agent: "codex", agent_status: "working" })]), facts);
    const after = await planMove(snapshot([pane("a", { agent: "codex", agent_status: "idle" })]), facts);
    expect(after.revision).not.toBe(before.revision);
  });
});
