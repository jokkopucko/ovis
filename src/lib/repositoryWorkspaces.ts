/**
 * Which workspaces a worktree can start from, as the sidebar's row menu and the palette offer New
 * worktree and Open worktree…: a repository's main checkout. herdr marks only a workspace it opened
 * as a worktree. One made on a repository's folder has no `worktree`, and it is where the first
 * worktree starts: each is asked once whether git answers for it. A refusal (4xx) is an answer and
 * is kept; a failure to ask is not, so that workspace keeps what was known of it and is asked again
 * when the set changes (its order is no change) or the PC comes back. The answers are per PC and
 * shared by every reader of that PC (the sidebar, the palette, App), so each asks git once and all
 * offer the same items. They are one herdr's: a snapshot of another reads none of them.
 */
import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";

import type { SessionSnapshot, WorkspaceInfo } from "../../shared/protocol.ts";
import { ApiError } from "./api.ts";

const answers = new Map<string, Map<string, boolean>>();
const asking = new Map<string, Promise<void>>();
/** bumped as a PC's answers are dropped: an answer to a question asked before then is not kept */
const rounds = new Map<string, number>();
const listeners = new Set<() => void>();
/** the herdr each PC's answers came from (the snapshot's `herdr_lifetime`): another may give a workspace id to another folder */
const lifetimes = new Map<string, string | undefined>();
/** herdr's connection failing mid-call, which the bridge answers as a 404 (server/http.ts): no refusal, so asked again */
const NOT_ANSWERED = new Set(["closed", "socket_error", "bad_frame", "cancelled"]);
/** the mounted readers of each PC: its answers go with the last one, and the next asks again */
const readers = new Map<string, number>();
/**
 * The questions of each PC's round that failed, and the set of workspaces they were asked in: none
 * is put again while that set stands, whichever reader's effect runs (the palette mounting beside
 * the sidebar). Gone with the answers, so the PC coming back or another herdr is asked them again.
 */
const unanswered = new Map<string, { asked: string; ids: Set<string> }>();
/** what a reader shows before it has read any answer */
const NONE: ReadonlySet<string> = new Set();

function told(): void {
  for (const listener of [...listeners]) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

function answersOf(machineId: string): Map<string, boolean> {
  let known = answers.get(machineId);
  if (!known) answers.set(machineId, known = new Map());
  return known;
}

/**
 * What the herdr of `lifetime` answered for the PC. A snapshot of another herdr reads nothing, from
 * the render that first has it: the effect that drops the old answers runs only after that render.
 */
function answersFrom(machineId: string, lifetime: string | undefined): ReadonlyMap<string, boolean> | undefined {
  return lifetimes.get(machineId) === lifetime ? answers.get(machineId) : undefined;
}

/**
 * A repository's main checkout: herdr's own mark, else git's answer for an unmarked workspace.
 * `lifetime` is the `herdr_lifetime` of the snapshot the workspace is of.
 */
export function worktreesStartHere(machineId: string, workspace: WorkspaceInfo, lifetime: string | undefined): boolean {
  if (workspace.worktree) return !workspace.worktree.is_linked_worktree;
  return answersFrom(machineId, lifetime)?.get(workspace.workspace_id) === true;
}

function dropAnswers(machineId: string): void {
  answers.delete(machineId);
  unanswered.delete(machineId);
  rounds.set(machineId, (rounds.get(machineId) ?? 0) + 1);
}

/** one question per workspace and round: a question of a dropped round answers nobody, so the next round asks its own */
function ask(machineId: string, workspaceId: string, listWorktrees: (workspace: string) => Promise<unknown>): Promise<void> {
  const round = rounds.get(machineId) ?? 0;
  const key = `${machineId}\n${round}\n${workspaceId}`;
  const running = asking.get(key);
  if (running) return running;
  const current = (): boolean => (rounds.get(machineId) ?? 0) === round;
  const kept = (answer: boolean): void => { if (current()) answersOf(machineId).set(workspaceId, answer); };
  const question = listWorktrees(workspaceId).then(
    () => kept(true),
    (error: unknown) => {
      if (error instanceof ApiError && error.status < 500 && !NOT_ANSWERED.has(error.code ?? "")) kept(false);
      // a failure of a dropped round is not the next round's: that one asks its own question
      else if (current()) unanswered.get(machineId)?.ids.add(workspaceId);
    },
  ).finally(() => { if (asking.get(key) === question) asking.delete(key); });
  asking.set(key, question);
  return question;
}

/**
 * The PC's unmarked workspaces git answered for, asked while the PC is online and offers worktrees
 * to this device (a watching device is refused the listing, #2250; a PC the Herdr app lays out has
 * none). `notCheckout` keeps a later refusal (a folder that stopped being a checkout, #2726).
 */
export function useRepositoryWorkspaces({ machineId, snapshot, online, watching, offered, listWorktrees }: {
  machineId: string;
  snapshot: SessionSnapshot | null | undefined;
  online: boolean;
  watching: boolean;
  offered: boolean;
  listWorktrees: (workspace: string) => Promise<unknown>;
}): { repositoryWorkspaces: ReadonlySet<string>; notCheckout: (workspaceId: string) => void } {
  // sorted: the same workspaces in another order are the same set, and nothing is asked for it again.
  // Each id once: the set drawn is compared with this list by its length
  const unmarked = [...new Set((snapshot?.workspaces ?? []).filter((workspace) => !workspace.worktree).map((workspace) => workspace.workspace_id))].sort().join("\n");
  const asked = !online || unmarked === "" || watching || !offered ? null : unmarked;
  const lifetime = snapshot?.herdr_lifetime;
  // read as each render runs, not from a copy an effect refreshes: the render that first has another
  // herdr's snapshot already shows none of the last one's answers. The set object stays while its
  // ids do, for the readers that depend on it.
  const shown = useRef(NONE);
  const read = useCallback((): ReadonlySet<string> => {
    const known = answersFrom(machineId, lifetime);
    const next = asked === null || !known ? [] : asked.split("\n").filter((id) => known.get(id) === true);
    if (next.length !== shown.current.size || !next.every((id) => shown.current.has(id))) shown.current = new Set(next);
    return shown.current;
  }, [machineId, asked, lifetime]);
  const repositoryWorkspaces = useSyncExternalStore(subscribe, read, read);
  useEffect(() => {
    readers.set(machineId, (readers.get(machineId) ?? 0) + 1);
    return () => {
      const left = (readers.get(machineId) ?? 1) - 1;
      if (left > 0) { readers.set(machineId, left); return; }
      readers.delete(machineId);
      lifetimes.delete(machineId);
      dropAnswers(machineId);
    };
  }, [machineId]);
  useEffect(() => {
    if (asked === null) {
      // what was known, and every question still out, is dropped: the PC is asked afresh when it comes back
      dropAnswers(machineId);
      told();
      return;
    }
    // another herdr: what the last one answered, and its questions still out, are for its workspaces
    if (lifetimes.has(machineId) && lifetimes.get(machineId) !== lifetime) dropAnswers(machineId);
    lifetimes.set(machineId, lifetime);
    const known = answersOf(machineId);
    const ids = asked.split("\n");
    for (const id of [...known.keys()]) if (!ids.includes(id)) known.delete(id);
    // a question that failed waits for another set of workspaces: this run may be another reader's mount
    let record = unanswered.get(machineId);
    if (record?.asked !== asked) unanswered.set(machineId, record = { asked, ids: new Set() });
    const failed = record.ids;
    told();
    // each answer is shown as it comes: one slow question holds back none of the others
    for (const id of ids.filter((id) => !known.has(id) && !failed.has(id))) void ask(machineId, id, listWorktrees).then(told);
  }, [machineId, asked, lifetime, listWorktrees]);
  const notCheckout = useCallback((workspaceId: string) => {
    answersOf(machineId).set(workspaceId, false);
    told();
  }, [machineId]);
  return { repositoryWorkspaces, notCheckout };
}
