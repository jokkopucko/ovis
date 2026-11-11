import { randomUUID } from "node:crypto";
import { chmodSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { HerdrRuntimeFacts, RuntimeName } from "../shared/machines.ts";
import type { PaneProcessInfo, SessionSnapshot } from "../shared/herdr-api.generated.ts";
import type { MovePlan, MovePlanResponse, MoveStatus, MoveStopAllOffer } from "../shared/runtime-move.ts";
import { agentLaunch } from "./agent-launch.ts";
import { freeAgentName } from "./agent-name.ts";
import { agentPrompt, agentStart, HerdrError, layoutSetSplitRatio, paneGet, paneProcessInfo, paneRename, paneSendKeys, paneSplitForMove, sessionSnapshot, tabCreate, tabRename, workspaceCreate } from "./herdr/client.ts";
import { MOVE_LABEL, startHerdrCoreAdapter } from "./herdr-core/adapter.ts";
import { HcConnection, spawnHcConnect } from "./herdr-core/connection.ts";
import { findHc } from "./herdr-core/discovery.ts";
import { hcEnv } from "./herdr-core/runtime.ts";
import { LAYOUT_DOC } from "./herdr-core/snapshot.ts";
import { moveUnavailable, planMove, storeResume, type MoveFacts } from "./runtime-move.ts";
import { MoveLockUnsafe, takeMoveLock, type MoveLockHandle } from "./runtime-move-lock.ts";
import { journalStatus, runMove, setAsideJournal, settleJournal, switchedMove, type MoveDestination, type MoveSource } from "./runtime-move-run.ts";
import type { SessionHistoryOptions } from "./session-history.ts";

/** How often a waiting move looks whether every pane is done. */
const WAIT_LOOK_MS = 2_000;
/** How long Ctrl+C has to end a shell's command before the wait offers to force it. */
const FORCE_AFTER_MS = 3_000;

export interface MoveServiceOptions {
  stateDir: string;
  port: number;
  serving: () => RuntimeName;
  facts: () => HerdrRuntimeFacts | undefined;
  stores: SessionHistoryOptions;
  holdsPending: (paneId: string) => boolean;
  /** the pane's input lane (core/input.ts `serialize`): the exit takes its place in it */
  lane: InputLane;
  /** waits until a keystroke typed into the pane's pty can no longer arrive after an RPC key (core/input.ts) */
  settleAfterTyping: (paneId: string) => Promise<void>;
  /** true: the agent's input line reads empty; false: something is typed; null: unreadable for this agent (the core's) */
  inputEmpty: (paneId: string, agent: string) => Promise<boolean | null>;
  /** asks the launcher to switch to herdr-core; an error message when it refuses */
  switchRuntime: () => string | null;
  /** the launcher took this server past its startup check: until then it may still roll back to herdr */
  accepted: () => boolean;
  /** a runtime switch was asked for (Settings) and the server restarts for it: no agent is ended meanwhile */
  switching: () => boolean;
  /**
   * the herdr session's move lock (runtime-move-lock.ts) and this server lifetime's boot id: another Ovis
   * serving the same session (a connection server's bridge, say) cannot move it at the same time
   */
  lock: { path: string };
  /** installs herdr-core where the PC has none (server/herdr-core/install.ts), so the move can be offered */
  installer?: HcInstaller;
  /** what a stop of a busy pane reads and signals; herdr and this PC unless a test stands in */
  stopDeps?: PaneStopDeps;
}

export type StopRefusal = "not_waiting" | "not_running" | "changed" | "not_tried" | "own_server" | "own_group_unknown" | "not_local";

/** a running command End all and move now offered to end, with the group it found in front */
interface StopAllPane { pane_id: string; command: string; shell: number; group: number }

/** herdr and this PC, as a stop of a busy pane reads and signals them */
export interface PaneStopDeps {
  snapshot: () => Promise<SessionSnapshot>;
  processInfo: (paneId: string) => Promise<PaneProcessInfo | undefined>;
  /** `guard` is asked right before herdr writes the keys: false sends nothing */
  sendKeys: (paneId: string, keys: string[], guard: () => boolean) => Promise<void>;
  /** SIGTERM to the process group */
  signalGroup: (group: number) => void;
  /** this server's own process group, or null when the system does not tell */
  ownGroup: () => Promise<number | null>;
  /** the foreground group this PC reports for the shell's terminal, or null when that shell is not a process here */
  terminalGroup: (shell: number) => Promise<number | null>;
}

export interface HcInstaller {
  /** the version Ovis would install, or null: no build for this PC, or herdr-core was not looked for yet or is there */
  offer: () => { version: string } | null;
  /** installs it and looks for herdr-core again; throws, leaving the PC as it was, when it cannot */
  install: () => Promise<void>;
}

export interface MoveService {
  read: () => Promise<MovePlanResponse>;
  /** starts the move, or waits for every pane to be done first; an error code when it cannot */
  /** `locked`: another Ovis server is moving this herdr session; `lock_unsafe`: its lock cannot be taken here, and why (MoveLockUnsafe's own words) */
  start: (revision: string) => Promise<"plan_changed" | "unavailable" | "already_moving" | "locked" | { lock_unsafe: string } | "runtime_switching" | null>;
  cancel: () => void;
  /**
   * Ends the command a shell pane runs while the move waits, as the person would: Ctrl+C in the pane's
   * input lane, or with `force`, only after that Ctrl+C left the same command running FORCE_AFTER_MS,
   * SIGTERM to the pane's foreground process group. `command`, when given, is the one the person was
   * shown: another one running there now is not ended (`changed`); so is another shell or group than
   * `expected` (End all's confirmed list). An error code when it does nothing.
   */
  stopPane: (paneId: string, force: boolean, command?: string, expected?: { shell: number; group: number }) => Promise<StopRefusal | null>;
  /** End all and move now, asked: the running commands it would end, under a token for exactly that list */
  prepareStopAll: () => Promise<"not_waiting" | MoveStopAllOffer>;
  /** End all and move now, confirmed: Ctrl+C to each, only while the list is the one the token was given for */
  stopAll: (token: string) => Promise<"no_offer" | StopRefusal | null>;
  /** installs herdr-core where only that keeps the move from being offered; an error code when it is not offered, throws when the install fails */
  install: () => Promise<"unavailable" | "installing" | null>;
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

/** This server's own process group where the system tells it (Linux /proc), else null. */
function procGroup(): number | null {
  try {
    // after the command name's closing parenthesis: state, ppid, pgrp
    const group = Number(readFileSync("/proc/self/stat", "utf8").replace(/^.*\) /s, "").split(" ")[2]);
    return Number.isSafeInteger(group) && group > 0 ? group : null;
  } catch { return null; }
}

/** A process's group as `ps` reports it (macOS has no /proc), or null when ps cannot tell. */
export async function psProcessGroup(pid: number): Promise<number | null> {
  try {
    const ps = Bun.spawn(["ps", "-o", "pgid=", "-p", String(pid)], { stdout: "pipe", stderr: "ignore" });
    const [out, code] = await Promise.all([new Response(ps.stdout).text(), ps.exited]);
    const group = Number(out.trim());
    return code === 0 && Number.isSafeInteger(group) && group > 0 ? group : null;
  } catch { return null; }
}

/** this server's group never changes: read once it is known */
let knownOwnGroup: number | null = null;
async function ownGroup(): Promise<number | null> {
  knownOwnGroup ??= procGroup() ?? await psProcessGroup(process.pid);
  return knownOwnGroup;
}

const herdrStopDeps: PaneStopDeps = {
  snapshot: () => sessionSnapshot(),
  processInfo: async (paneId) => { try { return await paneProcessInfo(paneId); } catch { return undefined; } },
  sendKeys: (paneId, keys, guard) => paneSendKeys(paneId, keys, undefined, guard),
  signalGroup: (group) => {
    try { process.kill(-group, "SIGTERM"); } catch (error) {
      // the group ended meanwhile: what the force was for
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  },
  ownGroup,
  terminalGroup,
};

/** The name of the command in front, as the move's plan names it (runtime-move.ts commandInFront). */
function commandName(info: PaneProcessInfo | undefined, front: { shell: number }): string {
  return info?.foreground_processes?.find((entry) => entry.pid !== front.shell)?.name ?? "?";
}

/** The foreground process group of a shell's terminal as this PC reports it, or null when that shell is not a process here. */
export async function terminalGroup(shell: number): Promise<number | null> {
  try {
    // after the command name's closing parenthesis: state, ppid, pgrp, session, tty_nr, tpgid
    const group = Number(readFileSync(`/proc/${shell}/stat`, "utf8").replace(/^.*\) /s, "").split(" ")[5]);
    return Number.isSafeInteger(group) && group > 0 ? group : null;
  } catch { /* no /proc (macOS), or no such process: ask ps */ }
  try {
    const ps = Bun.spawn(["ps", "-o", "tpgid=", "-p", String(shell)], { stdout: "pipe", stderr: "ignore" });
    const [out, code] = await Promise.all([new Response(ps.stdout).text(), ps.exited]);
    const group = Number(out.trim());
    return code === 0 && Number.isSafeInteger(group) && group > 0 ? group : null;
  } catch { return null; }
}

/** The shell and the process group in front of it, when that group is a command's and not the shell's own. */
function commandGroup(info: PaneProcessInfo | undefined): { shell: number; group: number } | null {
  const shell = info?.shell_pid;
  const group = info?.foreground_process_group_id;
  if (shell == null || group == null || group === shell || group <= 1) return null;
  return { shell, group };
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
  /** the server stopped: no stop asked for from now on sends or signals anything */
  let stopped = false;
  /** each wait's own: a look a cancelled wait left behind does nothing */
  let generation = 0;
  /** what the person was shown when they asked to wait */
  let confirmed: MovePlan | null = null;
  /** each shell pane this wait sent Ctrl+C to: its shell, the group then in front, and when */
  const tries = new Map<string, { shell: number; group: number; at: number }>();
  const deps = options.stopDeps ?? herdrStopDeps;
  const facts: MoveFacts = {
    findResume: storeResume(options.stores),
    processInfo: deps.processInfo,
    inputEmpty: options.inputEmpty,
    holdsPending: options.holdsPending,
  };
  const plan = async (): Promise<MovePlan> => planMove(await deps.snapshot(), facts);
  /** the lock is held from the start of a wait or a move until it ends, however it ends */
  let held: MoveLockHandle | null = null;
  const release = (): void => { const handle = held; held = null; handle?.release(); };
  const go = async (current: MovePlan): Promise<void> => {
    running = true;
    const id = randomUUID();
    let destination: Awaited<ReturnType<typeof coreDestination>> | null = null;
    try {
      // still this server's move: another Ovis of the session that took the lock meanwhile moves instead, never both
      if (!(await held?.holds())) { status = { state: "rolled_back", reason: "locked", left: [] }; return; }
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
      release();
    }
  };
  const look = async (wait: number): Promise<void> => {
    timer = null;
    if (wait !== generation || status.state !== "waiting") return;
    try {
      // the PC may have lost herdr-core, or got the Herdr app, while it waited
      if (moveUnavailable(options.serving(), options.facts()) !== null || options.switching()) { status = { state: "idle" }; release(); return; }
      const current = await plan();
      if (wait !== generation || status.state !== "waiting") return;
      if (current.ready) {
        // only what was shown moves: a pane, tab or conversation that is new or changed asks again
        if (confirmed && !sameShape(confirmed, current)) { status = { state: "rolled_back", reason: "plan_changed", left: [] }; release(); return; }
        await go(current);
        return;
      }
    } catch { /* herdr did not answer this look: the next one asks again */ }
    if (wait === generation && status.state === "waiting") timer = setTimeout(() => void look(wait), WAIT_LOOK_MS);
  };
  /** the wait this stop belongs to is still the one waiting */
  const stillWaiting = (wait: number): boolean => !stopped && wait === generation && status.state === "waiting";
  const stopPane: MoveService["stopPane"] = async (paneId, force, command, expected) => {
    if (stopped || status.state !== "waiting") return "not_waiting";
    const wait = generation;
    // fail closed: without this server's own group, a signal could reach the server or its launcher
    const own = await deps.ownGroup();
    if (own === null) return "own_group_unknown";
    const verdict = (await plan()).panes.find((pane) => pane.pane_id === paneId)?.verdict;
    if (verdict?.kind !== "busy" || verdict.reason !== "command_running") return "not_running";
    const info = await facts.processInfo(paneId);
    const front = commandGroup(info);
    if (front === null) return "not_running";
    // the command shown and the group ended come from one look: a job started since is not the one shown
    if (command !== undefined && commandName(info, front) !== command) return "changed";
    if (expected !== undefined && (expected.shell !== front.shell || expected.group !== front.group)) return "changed";
    // this server (or the launcher it runs under) in front of that shell: ending it would end the move
    if (front.group === own || info?.foreground_processes?.some((entry) => entry.pid === process.pid || entry.pid === process.ppid)) return "own_server";
    if (!stillWaiting(wait)) return "not_waiting";
    if (!force) {
      // behind anything typed or sent before it, checked again there: the same command still in front
      const sent = await options.lane(paneId, async (): Promise<"not_waiting" | "not_running" | "changed" | null> => {
        // keys typed into the pty just before still on their way: Ctrl+C must not overtake them
        await options.settleAfterTyping(paneId);
        const last = await facts.processInfo(paneId);
        const now = commandGroup(last);
        // after the last await: a cancel that came while herdr answered sends nothing
        if (!stillWaiting(wait)) return "not_waiting";
        if (now === null || now.group !== front.group || now.shell !== front.shell) return "not_running";
        // the same group may run another program by now (exec): only the command shown is interrupted
        if (command !== undefined && commandName(last, now) !== command) return "changed";
        // and herdr asks again right before it writes the keys
        try { await deps.sendKeys(paneId, ["ctrl+c"], () => stillWaiting(wait)); } catch (error) {
          if (error instanceof HerdrError && error.code === "cancelled") return "not_waiting";
          throw error;
        }
        return null;
      });
      if (sent !== null) return sent;
      if (stillWaiting(wait)) tries.set(paneId, { ...front, at: Date.now() });
      return null;
    }
    const tried = tries.get(paneId);
    if (tried && (tried.group !== front.group || tried.shell !== front.shell)) tries.delete(paneId);
    if (!tried || tried.group !== front.group || tried.shell !== front.shell || Date.now() - tried.at < FORCE_AFTER_MS) return "not_tried";
    // herdr's ids must be this PC's: the shell's terminal here must report that group in front, read
    // last, or Ovis and herdr see different pid spaces (a container) and nothing is signalled
    const local = await deps.terminalGroup(front.shell);
    if (local !== front.group) return "not_local";
    if (!stillWaiting(wait)) return "not_waiting";
    // Not atomic: a process group has no pidfd to hold, so between that last look and this kill the
    // group can end and its id be handed to a new group. The gap is the look's return and these few
    // synchronous lines; a reused id would need the PC's pid space to wrap within them.
    deps.signalGroup(front.group);
    return null;
  };
  /** the running commands End all would end now, each with the group it found in front */
  const untriedCommands = async (): Promise<StopAllPane[]> => {
    const panes: StopAllPane[] = [];
    for (const pane of (await plan()).panes) {
      const { verdict } = pane;
      if (verdict.kind !== "busy" || verdict.reason !== "command_running") continue;
      const info = await facts.processInfo(pane.pane_id);
      const front = commandGroup(info);
      if (front === null) continue;
      // a pane is left out only while the command its Ctrl+C went to still runs there
      const tried = tries.get(pane.pane_id);
      if (tried && tried.shell === front.shell && tried.group === front.group) continue;
      panes.push({ pane_id: pane.pane_id, command: commandName(info, front), ...front });
    }
    return panes;
  };
  /** the list End all and move now was confirmed for: one offer at a time, used once */
  let offer: { token: string; wait: number; panes: StopAllPane[] } | null = null;
  const prepareStopAll: MoveService["prepareStopAll"] = async () => {
    if (stopped || status.state !== "waiting") return "not_waiting";
    const wait = generation;
    const panes = await untriedCommands();
    if (!stillWaiting(wait)) return "not_waiting";
    offer = { token: randomUUID(), wait, panes };
    return { token: offer.token, panes: panes.map(({ pane_id, command }) => ({ pane_id, command })) };
  };
  const stopAll: MoveService["stopAll"] = async (token) => {
    const held = offer;
    if (held === null || held.token !== token) return "no_offer";
    offer = null;
    if (!stillWaiting(held.wait)) return "not_waiting";
    // a pane added, gone, or running another command or group since the person confirmed: ask again
    if (JSON.stringify(await untriedCommands()) !== JSON.stringify(held.panes)) return "changed";
    // one at a time, in the plan's order: a refusal stops there, and its pane keeps the move waiting
    for (const pane of held.panes) {
      // another device may have cancelled and started a new wait meanwhile: this confirm was for the old one
      if (!stillWaiting(held.wait)) return "not_waiting";
      const refused = await stopPane(pane.pane_id, false, pane.command, { shell: pane.shell, group: pane.group });
      if (refused !== null) return refused;
    }
    return null;
  };
  let installing = false;
  /** herdr-core is all the move lacks here, and Ovis can install it */
  const installOffer = (): { version: string } | null => {
    const facts = options.facts();
    if (moveUnavailable(options.serving(), facts) !== "no_herdr_core" || facts?.app_installed !== false) return null;
    return options.installer?.offer() ?? null;
  };
  return {
    read: async () => {
      if (status.state === "moving" && status.step === "switching" && !running) status = settle();
      const reason = moveUnavailable(options.serving(), options.facts());
      if (reason !== null) {
        const install = reason === "no_herdr_core" ? installOffer() : null;
        return { available: false, reason, ...(install ? { install } : {}), status };
      }
      const current = await plan();
      if (status.state !== "waiting" || tries.size === 0) return { available: true, plan: current, status };
      // a pane whose command ended, or that runs another group now, is no longer being stopped: it offers End again
      for (const [paneId, tried] of tries) {
        const front = commandGroup(await facts.processInfo(paneId));
        if (front === null || front.group !== tried.group || front.shell !== tried.shell) tries.delete(paneId);
      }
      const stopping = [...tries].filter(([paneId]) => {
        const verdict = current.panes.find((pane) => pane.pane_id === paneId)?.verdict;
        return verdict?.kind === "busy" && verdict.reason === "command_running";
      }).map(([paneId, tried]) => ({ pane_id: paneId, force: Date.now() - tried.at >= FORCE_AFTER_MS }));
      return { available: true, plan: current, status: stopping.length === 0 ? status : { ...status, stopping } };
    },
    stopPane,
    prepareStopAll,
    stopAll,
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
        // the server stopped while the plan was read: nothing is started, and no lock taken
        if (stopped) return "unavailable";
        try {
          held = await takeMoveLock(options.lock.path);
          if (!held) return "locked";
          // the server stopped while the lock was taken: it lets go at once
          if (stopped) { release(); return "unavailable"; }
        } catch (error) {
          if (error instanceof MoveLockUnsafe) return { lock_unsafe: error.message };
          throw error;
        }
        if (current.ready) { void go(current); return null; }
        confirmed = current;
        tries.clear();
        offer = null;
        const wait = ++generation;
        status = { state: "waiting", revision };
        timer = setTimeout(() => void look(wait), WAIT_LOOK_MS);
        return null;
      } finally {
        starting = false;
      }
    },
    install: async () => {
      if (installing) return "installing";
      if (installOffer() === null || options.installer === undefined) return "unavailable";
      installing = true;
      try { await options.installer.install(); } finally { installing = false; }
      return null;
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
      tries.clear();
      offer = null;
      status = { state: "idle" };
      release();
    },
    busy: () => starting || running || status.state === "waiting" || status.state === "moving",
    // the server stops: a stop still on its way is no longer for a wait anyone sees
    // a wait ends with the server; a move under way keeps the lock until it ends, or until its process does
    stop: () => { if (timer) clearTimeout(timer); timer = null; stopped = true; generation++; offer = null; if (!running) release(); },
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
