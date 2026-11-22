import { existsSync, readFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import type { RuntimeName } from "../shared/machines.ts";
import type { MoveNode, MovePane, MovePlan, MoveStatus } from "../shared/runtime-move.ts";
import { writePrivateState } from "./private-state.ts";
import { EXIT_COMMANDS } from "./runtime-move.ts";

export interface MoveSource {
  pane: (paneId: string) => Promise<{ agent: string | null; status: string; session: string | null; shellInFront: boolean | null } | null>;
  holdsPending: (paneId: string) => boolean;
  inputEmpty: (paneId: string, agent: string) => Promise<boolean | null>;
  /** sends the command as a message to the agent (herdr's agent.prompt: pasted, then Enter) */
  /** Types the exit, or answers why it typed nothing. It throws only when it cannot say whether the keys went out. */
  sendExit: (paneId: string, agent: string, session: string | null, command: string) => Promise<"sent" | "agent_busy" | "input_left" | "plan_changed" | `failed: ${string}`>;
  runsConversation: (agent: string, session: string) => Promise<boolean>;
  start: (paneId: string, argv: readonly string[]) => Promise<void>;
}

export interface MoveDestination {
  appArranged: () => Promise<boolean>;
  createWorkspace: (move: string, cwd: string | undefined, name: string) => Promise<{ workspaceId: string; tabId: string; paneId: string }>;
  createTab: (move: string, workspaceId: string, cwd: string | undefined, name: string) => Promise<{ tabId: string; paneId: string }>;
  renameTab: (tabId: string, name: string) => Promise<void>;
  split: (move: string, paneId: string, direction: "right" | "down", cwd: string | undefined) => Promise<string>;
  setRatio: (tabId: string, path: boolean[], ratio: number) => Promise<void>;
  renamePane: (paneId: string, name: string) => Promise<void>;
  start: (paneId: string, argv: readonly string[]) => Promise<void>;
  confirmResumed: (paneId: string, sessionId: string) => Promise<boolean>;
  endMove: (move: string) => Promise<void>;
}

export interface MoveRunOptions {
  switchRuntime: () => string | null;
  exitMs?: number;
  settleMs?: number;
  pause?: (ms: number) => Promise<void>;
  onStep?: (status: MoveStatus) => void;
}

type Phase = "ending" | "building" | "starting" | "switching" | "rolling_back";
export interface MoveJournal {
  id: string;
  state: Phase | "committed" | "done" | "rolled_back" | "interrupted";
  reason?: string;
  ended: { pane_id: string; agent: string; argv: string[]; session: string | null }[];
  left: { pane_id: string; agent: string; why: string }[];
}

export const journalPath = (stateDir: string, port: number): string => join(stateDir, `runtime-move-${port}.json`);

export function readJournal(stateDir: string, port: number): MoveJournal | null {
  const path = journalPath(stateDir, port);
  if (!existsSync(path)) return null;
  try {
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    return value !== null && typeof value === "object" && typeof (value as MoveJournal).id === "string" && Array.isArray((value as MoveJournal).ended) ? value as MoveJournal : null;
  } catch {
    return null;
  }
}

export function switchedMove(stateDir: string, port: number): boolean {
  const state = readJournal(stateDir, port)?.state;
  return state === "switching" || state === "committed";
}

export function setAsideJournal(stateDir: string, port: number): void {
  const journal = readJournal(stateDir, port);
  if (journal) renameSync(journalPath(stateDir, port), join(stateDir, `runtime-move-${port}.${journal.id}.json`));
}

class MoveAbort extends Error {}

const firstPane = (node: MoveNode): string => "pane" in node ? node.pane : firstPane(node.first);

export function journalStatus(journal: MoveJournal | null): MoveStatus | null {
  if (!journal) return null;
  if (journal.state === "done" || journal.state === "committed") return { state: "done" };
  if (journal.state === "rolled_back" || journal.state === "interrupted") return { state: journal.state, reason: journal.reason ?? "", left: journal.left };
  return null;
}

export function settleJournal(stateDir: string, port: number, serving: RuntimeName): MoveJournal | null {
  const journal = readJournal(stateDir, port);
  if (!journal) return null;
  if (journal.state === "done" && serving === "herdr") { setAsideJournal(stateDir, port); return null; }
  if (journal.state === "committed" || journal.state === "switching") {
    journal.state = serving === "herdr-core" ? "done" : "interrupted";
    if (serving === "herdr") {
      journal.reason = "switch_not_started";
      journal.left = journal.ended.map((entry) => ({ pane_id: entry.pane_id, agent: entry.agent, why: "running_on_herdr_core" }));
    }
  } else if (journal.state !== "done" && journal.state !== "rolled_back" && journal.state !== "interrupted") {
    journal.left = journal.ended.map((entry) => ({ pane_id: entry.pane_id, agent: entry.agent, why: "server_stopped" }));
    journal.reason = "server_stopped";
    journal.state = "interrupted";
  } else {
    return journal;
  }
  writePrivateState(journalPath(stateDir, port), journal);
  return journal;
}

export async function runMove(stateDir: string, port: number, id: string, plan: MovePlan, source: MoveSource, destination: MoveDestination, options: MoveRunOptions): Promise<MoveJournal> {
  const journal: MoveJournal = { id, state: "ending", ended: [], left: [] };
  const save = () => writePrivateState(journalPath(stateDir, port), journal);
  const pause = options.pause ?? Bun.sleep;
  const exitMs = options.exitMs ?? 10_000;
  const starts = plan.panes.filter((pane): pane is MovePane & { verdict: { kind: "resume" | "fresh" } } => pane.verdict.kind === "resume" || pane.verdict.kind === "fresh");
  const agents = starts.filter((pane) => !(pane.verdict.kind === "resume" && pane.verdict.ended));
  const step = (name: Extract<MoveStatus, { state: "moving" }>["step"], done: number, total: number) => options.onStep?.({ state: "moving", step: name, done, total });
  const placed = new Map<string, string>();
  save();
  try {
    if (!plan.ready) throw new MoveAbort("not_ready");
    if (await destination.appArranged()) throw new MoveAbort("herdr_app");
    for (const [index, pane] of agents.entries()) {
      step("ending_agents", index, agents.length);
      const verdict = pane.verdict;
      const now = await source.pane(pane.pane_id);
      // an agent that took work since the plan is not typed into; sendExit reads the agent, its
      // conversation and its input box once more as the last thing before the keys
      if (!now || now.agent !== verdict.agent || (now.status !== "idle" && now.status !== "done") || source.holdsPending(pane.pane_id)) throw new MoveAbort("agent_busy");
      // the conversation shown is the one ended: one switched to since would be reopened as the wrong one
      if (verdict.kind === "resume" && now.session !== verdict.session_id) throw new MoveAbort("plan_changed");
      // only into an input box read empty: unreadable is not empty
      if (await source.inputEmpty(pane.pane_id, verdict.agent) !== true) throw new MoveAbort("input_left");
      const command = EXIT_COMMANDS[verdict.agent];
      if (command === undefined) throw new MoveAbort("no_exit_command");
      journal.ended.push({ pane_id: pane.pane_id, agent: verdict.agent, argv: verdict.kind === "resume" ? verdict.argv : [verdict.agent], session: verdict.kind === "resume" ? verdict.session_id : null });
      save();
      const exit = await source.sendExit(pane.pane_id, verdict.agent, verdict.kind === "resume" ? verdict.session_id : null, command);
      // refused, so nothing was typed: it was not ended and a rollback has nothing to put back there
      if (exit !== "sent") { journal.ended.pop(); throw new MoveAbort(exit); }
      let gone = false;
      for (const deadline = Date.now() + exitMs; Date.now() < deadline;) {
        const after = await source.pane(pane.pane_id);
        // ended only once herdr names no agent AND the shell is in front again: a report lost while the
        // process still runs would otherwise let one conversation run twice
        if (after && after.agent === null && after.shellInFront === true) { gone = true; break; }
        // it took the command as work, or turned to a question: nothing more is typed into it
        // only while herdr still names it: a pane with no agent reports `unknown`, which is no work
        if (after && after.agent !== null && after.status !== "idle" && after.status !== "done") throw new MoveAbort("agent_busy");
        await pause(200);
      }
      if (!gone) throw new MoveAbort("agent_did_not_exit");
    }
    journal.state = "building";
    save();
    const cwdOf = new Map(plan.panes.map((pane) => [pane.pane_id, pane.cwd ?? undefined]));
    const tabs = plan.workspaces.reduce((count, workspace) => count + workspace.tabs.length, 0);
    let built = 0;
    const grow = async (node: MoveNode, paneId: string, tabId: string, path: boolean[]): Promise<void> => {
      if ("pane" in node) { placed.set(node.pane, paneId); return; }
      const second = await destination.split(id, paneId, node.split, cwdOf.get(firstPane(node.second)));
      await grow(node.first, paneId, tabId, [...path, false]);
      await grow(node.second, second, tabId, [...path, true]);
      await destination.setRatio(tabId, path, node.ratio);
    };
    for (const workspace of plan.workspaces) {
      let workspaceId = "";
      for (const [index, tab] of workspace.tabs.entries()) {
        step("building", built++, tabs);
        const cwd = cwdOf.get(firstPane(tab.root));
        let made: { tabId: string; paneId: string };
        if (index === 0) {
          const created = await destination.createWorkspace(id, cwd, workspace.name);
          workspaceId = created.workspaceId;
          made = created;
          await destination.renameTab(made.tabId, tab.name);
        } else {
          made = await destination.createTab(id, workspaceId, cwd, tab.name);
        }
        await grow(tab.root, made.paneId, made.tabId, []);
      }
    }
    for (const pane of plan.panes) {
      const placedId = placed.get(pane.pane_id);
      if (placedId === undefined) throw new MoveAbort("plan_changed");
      if (pane.name) await destination.renamePane(placedId, pane.name);
    }
    journal.state = "starting";
    save();
    for (const [index, pane] of starts.entries()) {
      step("starting_agents", index, starts.length);
      const target = placed.get(pane.pane_id)!;
      await destination.start(target, pane.verdict.kind === "resume" ? pane.verdict.argv : [pane.verdict.agent]);
      // a process that came up is not yet the conversation: it may have refused the id and quit
      if (pane.verdict.kind === "resume" && !(await destination.confirmResumed(target, pane.verdict.session_id))) throw new MoveAbort("resume_unconfirmed");
    }
    journal.state = "switching";
    save();
    step("switching", 0, 1);
    const refused = options.switchRuntime();
    if (refused !== null) throw new MoveAbort(`switch_refused: ${refused}`);
  } catch (error) {
    journal.reason = error instanceof MoveAbort ? error.message : `failed: ${error instanceof Error ? error.message : String(error)}`;
    journal.state = "rolling_back";
    // a journal that cannot be written (the reason we are here, maybe) never stops the rollback
    try { save(); } catch {}
    await rollBack(journal, source, destination, id, pause, options.settleMs ?? 5_000);
    journal.state = "rolled_back";
    try { save(); } catch {}
    return journal;
  }
  journal.state = "committed";
  try { save(); } catch {}
  return journal;
}

async function rollBack(journal: MoveJournal, source: MoveSource, destination: MoveDestination, id: string, pause: (ms: number) => Promise<unknown>, settleMs: number): Promise<void> {
  let destinationClear = true;
  try { await destination.endMove(id); } catch { destinationClear = false; }
  for (const entry of journal.ended) {
    // a copy on herdr-core not proven gone, an agent back in the pane, or the conversation running in
    // another pane: starting it again could run one conversation twice, so it is left to the person
    if (!destinationClear) { journal.left.push({ pane_id: entry.pane_id, agent: entry.agent, why: "herdr_core_not_cleared" }); continue; }
    try {
      let now = await source.pane(entry.pane_id);
      for (const deadline = Date.now() + settleMs; now && !(now.agent === null && now.shellInFront === true) && Date.now() < deadline;) {
        await pause(200);
        now = await source.pane(entry.pane_id);
      }
      if (!now) { journal.left.push({ pane_id: entry.pane_id, agent: entry.agent, why: "pane_gone" }); continue; }
      if (now.agent !== null || now.shellInFront !== true) { journal.left.push({ pane_id: entry.pane_id, agent: entry.agent, why: "agent_still_there" }); continue; }
      if (entry.session !== null && await source.runsConversation(entry.agent, entry.session)) { journal.left.push({ pane_id: entry.pane_id, agent: entry.agent, why: "conversation_open_elsewhere" }); continue; }
      await source.start(entry.pane_id, entry.argv);
    } catch (error) {
      journal.left.push({ pane_id: entry.pane_id, agent: entry.agent, why: `start_failed: ${error instanceof Error ? error.message : String(error)}` });
    }
  }
}

