import { randomUUID } from "node:crypto";
import { chmodSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { HerdrRuntimeFacts } from "../shared/machines.ts";
import type { MovePlan, MovePlanResponse, MoveStatus } from "../shared/runtime-move.ts";
import { agentLaunch } from "./agent-launch.ts";
import { freeAgentName } from "./agent-name.ts";
import { agentPrompt, agentStart, HerdrError, layoutSetSplitRatio, paneGet, paneProcessInfo, paneRename, paneSplitForMove, sessionSnapshot, tabCreate, tabRename, workspaceCreate } from "./herdr/client.ts";
import { MOVE_LABEL, startHerdrCoreAdapter } from "./herdr-core/adapter.ts";
import { HcConnection, spawnHcConnect } from "./herdr-core/connection.ts";
import { findHc } from "./herdr-core/discovery.ts";
import { hcEnv } from "./herdr-core/runtime.ts";
import { LAYOUT_DOC } from "./herdr-core/snapshot.ts";
import { moveUnavailable, planMove, storeResume, type MoveFacts } from "./runtime-move.ts";
import { journalStatus, runMove, setAsideJournal, settleJournal, switchedMove, type MoveDestination, type MoveSource } from "./runtime-move-run.ts";
import type { SessionHistoryOptions } from "./session-history.ts";

/** How often a waiting move looks whether every pane is done. */
const WAIT_LOOK_MS = 2_000;

export interface MoveServiceOptions {
  stateDir: string;
  port: number;
  serving: () => "herdr" | "herdr-core";
  facts: () => HerdrRuntimeFacts | undefined;
  stores: SessionHistoryOptions;
  holdsPending: (paneId: string) => boolean;
  /** the pane's input lane (core/input.ts `serialize`): the exit takes its place in it */
  lane: InputLane;
  /** true: the agent's input line reads empty; false: something is typed; null: unreadable for this agent (the core's) */
  inputEmpty: (paneId: string, agent: string) => Promise<boolean | null>;
  /** asks the launcher to switch to herdr-core; an error message when it refuses */
  switchRuntime: () => string | null;
  /** the launcher took this server past its startup check: until then it may still roll back to herdr */
  accepted: () => boolean;
  /** a runtime switch was asked for (Settings) and the server restarts for it: no agent is ended meanwhile */
  switching: () => boolean;
}

export interface MoveService {
  read: () => Promise<MovePlanResponse>;
  /** starts the move, or waits for every pane to be done first; an error code when it cannot */
  start: (revision: string) => Promise<"plan_changed" | "unavailable" | "already_moving" | "runtime_switching" | null>;
  cancel: () => void;
  /** a move waits or runs: no other runtime switch meanwhile */
  busy: () => boolean;
  stop: () => void;
}

/** herdr, through the server's own HERDR_SOCKET (a herdr-mode server's is herdr's). */
/** The pane's input lane every Ovis send and keystroke takes (core/input.ts `serialize`). */
export type InputLane = <T>(paneId: string, task: () => T | Promise<T>) => Promise<T>;

export function herdrSource(holdsPending: (paneId: string) => boolean, inputEmpty: MoveSource["inputEmpty"], lane: InputLane, prompt: (paneId: string, text: string) => Promise<void> = agentPrompt): MoveSource {
  return {
    pane: async (paneId) => {
      try {
        const pane = await paneGet(paneId);
        const info = await paneProcessInfo(paneId).catch(() => undefined);
        const shellInFront = info?.shell_pid == null || info.foreground_process_group_id == null ? null : info.foreground_process_group_id === info.shell_pid;
        return { agent: pane.agent ?? null, status: pane.agent_status, session: pane.agent_session?.value ?? null, shellInFront };
      } catch { return null; }
    },
    holdsPending,
    inputEmpty,
    // in the pane's input lane, behind anything typed or sent through Ovis before it and ahead of anything
    // after, checked again there: a message queued or text typed meanwhile stops it. herdr then pastes it
    // and its Enter, and refuses while the agent waits for an answer
    sendExit: (paneId, agent, command) => lane(paneId, async () => {
      if (holdsPending(paneId)) throw new Error("a message waits for the pane");
      if (await inputEmpty(paneId, agent) !== true) throw new Error("text is in the input box");
      await prompt(paneId, command);
    }),
    runsConversation: async (agent, session) => (await sessionSnapshot()).panes.some((pane) => pane.agent === agent && pane.agent_session?.value === session),
    start: async (paneId, argv) => {
      const started = await agentLaunch(paneId, { kind: argv[0]!, args: argv.slice(1) });
      if (!started.agent_started) throw new Error(started.error.message);
    },
  };
}

/**
 * herdr-core through an adapter of the move's own, on a socket in the state folder: herdr's API as a
 * herdr-core server answers it, while this server still serves herdr. Every call names that socket.
 */
export async function coreDestination(stateDir: string, id: string): Promise<MoveDestination & { close: () => void }> {
  // the core the server reaches once it serves herdr-core: the hc startRuntime finds, run in hcEnv (runtime.ts)
  const env = hcEnv();
  const found = await findHc();
  if (found === null) throw new Error("no herdr-core found");
  const hc = new HcConnection(() => spawnHcConnect(found.bin, env));
  const socket = join(stateDir, `move-${id.slice(0, 8)}.sock`);
  const adapter = await startHerdrCoreAdapter(hc, socket);
  if (process.platform !== "win32") chmodSync(socket, 0o600);
  return {
    appArranged: async () => { const doc = await hc.call("doc.get", { name: LAYOUT_DOC }); return doc.value !== null && doc.value !== undefined; },
    createWorkspace: async (move, cwd, name) => {
      // a pane whose folder is gone starts home: never in another pane's folder, which hc would hand down
      const made = await workspaceCreate({ cwd: cwd ?? homedir(), label: name, move }, socket);
      return { workspaceId: made.workspace.workspace_id, tabId: made.tab.tab_id, paneId: made.root_pane.pane_id };
    },
    createTab: async (move, workspaceId, cwd, name) => {
      const made = await tabCreate({ workspaceId, cwd: cwd ?? homedir(), label: name, move }, socket);
      return { tabId: made.tab.tab_id, paneId: made.root_pane.pane_id };
    },
    renameTab: (tabId, name) => tabRename(tabId, name, socket),
    split: async (move, paneId, direction, cwd) => (await paneSplitForMove(paneId, direction, { cwd: cwd ?? homedir(), move }, socket)).pane_id,
    setRatio: (tabId, path, ratio) => layoutSetSplitRatio(tabId, path, ratio, socket),
    renamePane: (paneId, name) => paneRename(paneId, name, socket),
    start: async (paneId, argv) => {
      // a shell started a moment ago may not be up yet (`agent_pane_busy`), as agent-launch.ts waits for it
      for (const deadline = Date.now() + 10_000; ;) {
        const names = (await sessionSnapshot(socket)).agents.map((agent) => agent.name);
        try {
          await agentStart({ name: freeAgentName(argv[0]!, names), kind: argv[0]!, paneId, args: argv.slice(1), timeoutMs: 60_000 }, socket);
          return;
        } catch (error) {
          if (!(error instanceof HerdrError && error.code === "agent_pane_busy" && Date.now() < deadline)) throw error;
          await Bun.sleep(250);
        }
      }
    },
    confirmResumed: async (paneId, sessionId) => {
      // the process naming the conversation in its arguments, the same one still up 3 s later: an agent that
      // refuses an id (gone, another store) quits within that once it has come up
      let seen: { pid: number; at: number } | null = null;
      for (const deadline = Date.now() + 20_000; Date.now() < deadline;) {
        const info = await paneProcessInfo(paneId, socket).catch(() => undefined);
        const runs = info?.foreground_processes?.find((entry) => (entry.argv ?? []).includes(sessionId));
        if (!runs) {
          if (seen !== null) return false;
        } else if (seen === null || seen.pid !== runs.pid) {
          seen = { pid: runs.pid, at: Date.now() };
        } else if (Date.now() - seen.at >= 3_000) {
          return true;
        }
        await Bun.sleep(250);
      }
      return false;
    },
    endMove: async (move) => {
      // a killed terminal may take a moment to be listed as finished: look again until none is live
      for (const deadline = Date.now() + 10_000; ;) {
        const { terminals } = await hc.call("terminal.list", { labels: { [MOVE_LABEL]: move }, all: true });
        const live = terminals.filter((terminal) => terminal.state === "live");
        if (live.length === 0) return;
        if (Date.now() > deadline) throw new Error("terminals of the move are still running on herdr-core");
        await Promise.all(live.map((terminal) => hc.call("terminal.kill", { terminal: terminal.address }).catch(() => undefined)));
        await Bun.sleep(200);
      }
    },
    close: () => { adapter.stop(); hc.close(); },
  };
}

/**
 * The move of herdr's whole session to herdr-core (runtime-move-run.ts), one at a time per server:
 * started now when every pane is done, else waiting and looking every WAIT_LOOK_MS until it is (or
 * the wait is cancelled). The plan it runs is read afresh at that moment.
 */
export function moveService(options: MoveServiceOptions): MoveService {
  // a move that switched is done only once the launcher keeps the herdr-core server it switched to
  const settle = (): MoveStatus => options.serving() === "herdr-core" && !options.accepted() && switchedMove(options.stateDir, options.port)
    ? { state: "moving", step: "switching", done: 0, total: 1 }
    : journalStatus(settleJournal(options.stateDir, options.port, options.serving())) ?? { state: "idle" };
  let status: MoveStatus = settle();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let running = false;
  /** a start between its first check and its plan: a second one, or a runtime switch, waits for none */
  let starting = false;
  /** each wait's own: a look a cancelled wait left behind does nothing */
  let generation = 0;
  /** what the person was shown when they asked to wait */
  let confirmed: MovePlan | null = null;
  const facts: MoveFacts = {
    findResume: storeResume(options.stores),
    processInfo: async (paneId) => { try { return await paneProcessInfo(paneId); } catch { return undefined; } },
    inputEmpty: options.inputEmpty,
    holdsPending: options.holdsPending,
  };
  const plan = async (): Promise<MovePlan> => planMove(await sessionSnapshot(), facts);
  const go = async (current: MovePlan): Promise<void> => {
    running = true;
    const id = randomUUID();
    let destination: Awaited<ReturnType<typeof coreDestination>> | null = null;
    try {
      status = { state: "moving", step: "ending_agents", done: 0, total: 0 };
      destination = await coreDestination(options.stateDir, id);
      if (options.switching()) { status = { state: "rolled_back", reason: "runtime_switching", left: [] }; return; }
      // read again right before the first exit: anything changed while herdr-core was reached stops it
      if ((await plan()).revision !== current.revision) { status = { state: "rolled_back", reason: "plan_changed", left: [] }; return; }
      const journal = await runMove(options.stateDir, options.port, id, current, herdrSource(options.holdsPending, options.inputEmpty, options.lane), destination, {
        switchRuntime: options.switchRuntime,
        onStep: (step) => { status = step; },
      });
      status = journalStatus(journal) ?? { state: "idle" };
    } catch (error) {
      status = { state: "rolled_back", reason: `failed: ${error instanceof Error ? error.message : String(error)}`, left: [] };
    } finally {
      destination?.close();
      running = false;
    }
  };
  const look = async (wait: number): Promise<void> => {
    timer = null;
    if (wait !== generation || status.state !== "waiting") return;
    try {
      // the PC may have lost herdr-core, or got the Herdr app, while it waited
      if (moveUnavailable(options.serving(), options.facts()) !== null || options.switching()) { status = { state: "idle" }; return; }
      const current = await plan();
      if (wait !== generation || status.state !== "waiting") return;
      if (current.ready) {
        // only what was shown moves: a pane, tab or conversation that is new or changed asks again
        if (confirmed && !sameShape(confirmed, current)) { status = { state: "rolled_back", reason: "plan_changed", left: [] }; return; }
        await go(current);
        return;
      }
    } catch { /* herdr did not answer this look: the next one asks again */ }
    if (wait === generation && status.state === "waiting") timer = setTimeout(() => void look(wait), WAIT_LOOK_MS);
  };
  return {
    read: async () => {
      if (status.state === "moving" && status.step === "switching" && !running) status = settle();
      const reason = moveUnavailable(options.serving(), options.facts());
      if (reason !== null) return { available: false, reason, status };
      return { available: true, plan: await plan(), status };
    },
    start: async (revision) => {
      if (moveUnavailable(options.serving(), options.facts()) !== null) return "unavailable";
      if (options.switching()) return "runtime_switching";
      if (starting || running || status.state === "moving" || status.state === "waiting") return "already_moving";
      starting = true;
      try {
        // a new start after a move a stopped server left: the person has seen it; it is set aside, never deleted
        if (status.state === "interrupted" || status.state === "rolled_back") { setAsideJournal(options.stateDir, options.port); status = { state: "idle" }; }
        const current = await plan();
        if (current.revision !== revision) return "plan_changed";
        if (current.ready) { void go(current); return null; }
        confirmed = current;
        const wait = ++generation;
        status = { state: "waiting", revision };
        timer = setTimeout(() => void look(wait), WAIT_LOOK_MS);
        return null;
      } finally {
        starting = false;
      }
    },
    cancel: () => {
      if (status.state === "interrupted") {
        // set aside, never deleted: it names the agents and terminals the person may still want back
        setAsideJournal(options.stateDir, options.port);
        status = { state: "idle" };
        return;
      }
      if (status.state !== "waiting") return;
      generation++;
      if (timer) clearTimeout(timer);
      timer = null;
      confirmed = null;
      status = { state: "idle" };
    },
    busy: () => starting || running || status.state === "waiting" || status.state === "moving",
    stop: () => { if (timer) clearTimeout(timer); timer = null; },
  };
}

/**
 * The same workspaces, tabs, panes, splits, folders and names as shown, and each pane as it was shown:
 * one that was busy or waited for the person may only have become what its own agent (or shell) becomes.
 */
export function sameShape(shown: MovePlan, now: MovePlan): boolean {
  if (JSON.stringify(shown.workspaces) !== JSON.stringify(now.workspaces)) return false;
  const before = new Map(shown.panes.map((pane) => [pane.pane_id, pane]));
  return now.panes.length === shown.panes.length && now.panes.every((pane) => {
    const was = before.get(pane.pane_id);
    if (!was || was.cwd !== pane.cwd || was.name !== pane.name) return false;
    const agentOf = (verdict: typeof pane.verdict): string | null => verdict.kind === "shell" ? null : verdict.kind === "busy" ? verdict.agent : verdict.agent;
    // one that was busy or waited for the person may be done now: its own agent (or shell) again, or a
    // shell because the person ended it
    if (was.verdict.kind === "busy" || was.verdict.kind === "needs_you") return pane.verdict.kind === "shell" || agentOf(was.verdict) === agentOf(pane.verdict);
    return JSON.stringify(was.verdict) === JSON.stringify(pane.verdict);
  });
}
