import { afterAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MovePlan } from "../shared/runtime-move.ts";
import { readJournal, runMove, settleJournal, type MoveDestination, type MoveSource } from "./runtime-move-run.ts";

const root = mkdtempSync(join(tmpdir(), "ovis-runtime-move-run-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
let dirs = 0;
const stateDir = () => mkdtempSync(join(root, `state-${++dirs}-`));
const PORT = 7421;

const plan: MovePlan = {
  ready: true,
  revision: "r1",
  workspaces: [{ workspace_id: "w1", name: "ovis", tabs: [
    { tab_id: "w1:t1", name: "main", root: { split: "right", ratio: 0.6, first: { pane: "a" }, second: { pane: "b" } } },
    { tab_id: "w1:t2", name: "logs", root: { pane: "c" } },
  ] }],
  panes: [
    { pane_id: "a", cwd: "/a", name: "lead", verdict: { kind: "resume", agent: "claude", session_id: "s1", argv: ["claude", "--resume", "s1"], ended: false } },
    { pane_id: "b", cwd: "/b", name: null, verdict: { kind: "shell" } },
    { pane_id: "c", cwd: "/c", name: null, verdict: { kind: "fresh", agent: "codex" } },
  ],
};

interface World { herdr: Map<string, { agent: string | null; status: string; session: string | null; shellInFront: boolean | null }>; core: Set<string>; calls: string[] }

/**
 * herdr and herdr-core as the move sees them. An agent typed its exit command ends, unless
 * `turnsBusy` names it (it took the command as work instead).
 */
function fakes(options: { turnsBusy?: string; failStart?: string; refuseSwitch?: boolean; notResumed?: string } = {}) {
  const world: World = {
    herdr: new Map([["a", { agent: "claude", status: "idle", session: "s1", shellInFront: false }], ["b", { agent: null, status: "unknown", session: null, shellInFront: true }], ["c", { agent: "codex", status: "idle", session: null, shellInFront: false }]]),
    core: new Set(),
    calls: [],
  };
  let next = 0;
  const made = () => { const id = `P${++next}`; world.core.add(id); return id; };
  const source: MoveSource = {
    pane: async (id) => world.herdr.get(id) ?? null,
    holdsPending: () => false,
    inputEmpty: async () => true,
    sendExit: async (id, _agent, command) => {
      world.calls.push(`herdr exit ${id} ${command}`);
      const pane = world.herdr.get(id)!;
      world.herdr.set(id, id === options.turnsBusy ? { ...pane, status: "working" } : { ...pane, agent: null, status: "unknown", shellInFront: true });
    },
    runsConversation: async (agent, session) => [...world.herdr.values()].some((pane) => pane.agent === agent && pane.session === session),
    start: async (id, argv) => { world.calls.push(`herdr start ${id} ${argv.join(" ")}`); world.herdr.set(id, { agent: argv[0]!, status: "idle", session: null, shellInFront: false }); },
  };
  const destination: MoveDestination = {
    appArranged: async () => false,
    createWorkspace: async (_move, cwd, name) => { const pane = made(); world.calls.push(`core workspace ${name} ${cwd}`); return { workspaceId: "W", tabId: `T-${pane}`, paneId: pane }; },
    createTab: async (_move, _w, cwd, name) => { const pane = made(); world.calls.push(`core tab ${name} ${cwd}`); return { tabId: `T-${pane}`, paneId: pane }; },
    renameTab: async () => undefined,
    split: async (_move, pane, direction, cwd) => { world.calls.push(`core split ${pane} ${direction} ${cwd}`); return made(); },
    setRatio: async () => undefined,
    renamePane: async () => undefined,
    start: async (pane, argv) => {
      if (argv[0] === options.failStart) throw new Error("agent refused");
      world.calls.push(`core start ${pane} ${argv.join(" ")}`);
    },
    confirmResumed: async (pane, session) => { world.calls.push(`core confirm ${pane} ${session}`); return session !== options.notResumed; },
    endMove: async () => { world.calls.push(`core end ${world.core.size}`); world.core.clear(); },
  };
  const switchRuntime = () => { world.calls.push("switch"); return options.refuseSwitch ? "locked" : null; };
  return { world, source, destination, options: { switchRuntime, exitMs: 1_000, settleMs: 50, pause: async () => undefined } };
}

describe("runMove", () => {
  it("ends each idle agent, builds everything on herdr-core, starts the agents there, then switches", async () => {
    const dir = stateDir();
    const { world, source, destination, options } = fakes();
    const journal = await runMove(dir, PORT, "m1", plan, source, destination, options);
    expect(journal.state).toBe("committed");
    expect(world.calls).toEqual([
      "herdr exit a /exit", "herdr exit c /quit",
      "core workspace ovis /a", "core split P1 right /b", "core tab logs /c",
      "core start P1 claude --resume s1", "core confirm P1 s1", "core start P3 codex",
      "switch",
    ]);
    expect(readJournal(dir, PORT)?.state).toBe("committed");
  });

  it("types nothing more into an agent that took the exit as work, and puts every other one back", async () => {
    const dir = stateDir();
    const { world, source, destination, options } = fakes({ turnsBusy: "c" });
    const journal = await runMove(dir, PORT, "m1", plan, source, destination, options);
    expect([journal.state, journal.reason]).toEqual(["rolled_back", "agent_busy"]);
    expect(world.calls).toEqual(["herdr exit a /exit", "herdr exit c /quit", "core end 0", "herdr start a claude --resume s1"]);
    expect(journal.left).toEqual([{ pane_id: "c", agent: "codex", why: "agent_still_there" }]);
  });

  it("ends everything it started on herdr-core before reopening the agents in herdr", async () => {
    const dir = stateDir();
    const { world, source, destination, options } = fakes({ failStart: "codex" });
    const journal = await runMove(dir, PORT, "m1", plan, source, destination, options);
    expect(journal.state).toBe("rolled_back");
    const end = world.calls.indexOf("core end 3");
    expect(end).toBeGreaterThan(world.calls.indexOf("core start P1 claude --resume s1"));
    expect(world.calls.slice(end + 1)).toEqual(["herdr start a claude --resume s1", "herdr start c codex"]);
    expect(world.core.size).toBe(0);
  });

  it("rolls back when the launcher refuses the switch", async () => {
    const { world, source, destination, options } = fakes({ refuseSwitch: true });
    const journal = await runMove(stateDir(), PORT, "m1", plan, source, destination, options);
    expect([journal.state, journal.reason]).toEqual(["rolled_back", "switch_refused: locked"]);
    expect(world.core.size).toBe(0);
    expect(world.herdr.get("a")?.agent).toBe("claude");
  });
});

describe("runMove, a conversation that does not reopen", () => {
  it("does not switch when a started agent is not running its conversation, and puts herdr back", async () => {
    const { world, source, destination, options } = fakes({ notResumed: "s1" });
    const journal = await runMove(stateDir(), PORT, "m1", plan, source, destination, options);
    expect([journal.state, journal.reason]).toEqual(["rolled_back", "resume_unconfirmed"]);
    expect(world.calls).not.toContain("switch");
    expect(world.calls).toContain("herdr start a claude --resume s1");
  });
});

describe("runMove, an agent the person ended", () => {
  it("types nothing into it, reopens it on herdr-core, and leaves it ended on a rollback", async () => {
    const { world, source, destination, options } = fakes({ refuseSwitch: true });
    world.herdr.set("a", { agent: null, status: "unknown", session: "s1", shellInFront: true });
    const ended: MovePlan = { ...plan, panes: plan.panes.map((pane) => pane.pane_id === "a" && pane.verdict.kind === "resume" ? { ...pane, verdict: { ...pane.verdict, ended: true } } : pane) };
    const journal = await runMove(stateDir(), PORT, "m1", ended, source, destination, options);
    expect(world.calls.filter((call) => call.includes(" a ") || call.endsWith(" a"))).toEqual([]);
    expect(world.calls).toContain("core start P1 claude --resume s1");
    expect(journal.state).toBe("rolled_back");
    expect(world.calls.some((call) => call.startsWith("herdr start a"))).toBe(false);
  });
});

describe("runMove, before anything is ended", () => {
  it("types nothing into an agent that took work since the plan, and ends no other", async () => {
    const { world, source, destination, options } = fakes();
    // the plan saw it idle; a message from another client started a turn before the exit
    world.herdr.set("a", { agent: "claude", status: "working", session: "s1", shellInFront: false });
    const journal = await runMove(stateDir(), PORT, "m1", plan, source, destination, options);
    expect([journal.state, journal.reason]).toEqual(["rolled_back", "agent_busy"]);
    expect(world.calls.filter((call) => call.startsWith("herdr exit"))).toEqual([]);
  });

  it("ends nothing when the pane now shows another conversation than the one shown", async () => {
    const { world, source, destination, options } = fakes();
    world.herdr.set("a", { agent: "claude", status: "idle", session: "s9", shellInFront: false });
    const journal = await runMove(stateDir(), PORT, "m1", plan, source, destination, options);
    expect([journal.state, journal.reason]).toEqual(["rolled_back", "plan_changed"]);
    expect(world.calls.filter((call) => call.startsWith("herdr exit"))).toEqual([]);
  });

  it("waits for the shell to be in front before it counts an agent as ended", async () => {
    const { world, source, destination, options } = fakes();
    // herdr stops naming the agent while its process still holds the terminal
    source.sendExit = async (id) => { world.calls.push(`herdr exit ${id}`); world.herdr.set(id, { ...world.herdr.get(id)!, agent: null, status: "unknown", shellInFront: false }); };
    const journal = await runMove(stateDir(), PORT, "m1", plan, source, destination, { ...options, exitMs: 50, settleMs: 0 });
    expect([journal.state, journal.reason]).toEqual(["rolled_back", "agent_did_not_exit"]);
    expect(journal.left).toEqual([{ pane_id: "a", agent: "claude", why: "agent_still_there" }]);
    expect(world.calls.some((call) => call.startsWith("core start") || call.startsWith("herdr start"))).toBe(false);
  });

  it("restarts in herdr an agent whose shell comes back while the rollback looks", async () => {
    const { world, source, destination, options } = fakes();
    // herdr drops the agent at once; its shell is back only after the exit wait gave up
    let shellBackAt = Infinity;
    source.sendExit = async (id) => { world.calls.push(`herdr exit ${id}`); shellBackAt = Date.now() + 80; world.herdr.set(id, { ...world.herdr.get(id)!, agent: null, status: "unknown", shellInFront: false }); };
    const plain = source.pane;
    source.pane = async (id) => { const pane = await plain(id); if (pane && pane.agent === null && Date.now() >= shellBackAt) pane.shellInFront = true; return pane; };
    const journal = await runMove(stateDir(), PORT, "m1", plan, source, destination, { ...options, exitMs: 30, settleMs: 5_000 });
    expect(journal.reason).toBe("agent_did_not_exit");
    expect(world.calls).toContain("herdr start a claude --resume s1");
  });
});

describe("settleJournal", () => {
  it("sets a finished move aside once the PC serves herdr again, so another can go", async () => {
    const dir = stateDir();
    const { source, destination, options } = fakes();
    await runMove(dir, PORT, "m1", plan, source, destination, options);
    expect(settleJournal(dir, PORT, "herdr-core")?.state).toBe("done");
    expect(settleJournal(dir, PORT, "herdr")).toBeNull();
    expect(readJournal(dir, PORT)).toBeNull();
  });

  it("counts a move whose switch was asked for as done on the herdr-core it switched to", async () => {
    const dir = stateDir();
    const { source, destination, options } = fakes();
    // the server stops right after asking for the switch, before it could write `committed`
    await runMove(dir, PORT, "m1", plan, source, destination, { ...options, switchRuntime: () => { throw new Error("stopped"); } });
    const journal = readJournal(dir, PORT)!;
    journal.state = "switching";
    await Bun.write(join(dir, `runtime-move-${PORT}.json`), JSON.stringify(journal));
    expect(settleJournal(dir, PORT, "herdr-core")?.state).toBe("done");
  });

  it("never retries a move another server left mid-way, and names the agents it had ended", async () => {
    const dir = stateDir();
    const { source, destination, options } = fakes();
    // the server stops while it builds on herdr-core
    const stopping = { ...destination, createWorkspace: () => new Promise<never>(() => undefined) };
    void runMove(dir, PORT, "m1", plan, source, stopping, options);
    for (let tries = 0; readJournal(dir, PORT)?.state !== "building" && tries < 100; tries++) await Promise.resolve();
    const journal = settleJournal(dir, PORT, "herdr");
    expect(journal?.state).toBe("interrupted");
    expect(journal?.left.map((entry) => entry.pane_id)).toEqual(["a", "c"]);
  });
});
