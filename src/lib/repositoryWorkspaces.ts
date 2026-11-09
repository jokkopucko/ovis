/**
 * Which workspaces a worktree can start from, as the sidebar's row menu and the palette offer New
 * worktree and Open worktree…: a repository's main checkout. herdr marks only a workspace it opened
 * as a worktree. One made on a repository's folder has no `worktree`, and it is where the first
 * worktree starts: each is asked once whether git answers for it. A refusal (4xx) is an answer and
 * is kept; a failure to ask is not, so that workspace keeps what was known of it and is asked again
 * when the set changes or the PC comes back. The answers are per PC and shared by every reader of
 * that PC (the sidebar, the palette, App), so each asks git once and all offer the same items.
 */
import { useCallback, useEffect, useState } from "react";

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

function told(): void {
  for (const listener of [...listeners]) listener();
}

function answersOf(machineId: string): Map<string, boolean> {
  let known = answers.get(machineId);
  if (!known) answers.set(machineId, known = new Map());
  return known;
}

/** a repository's main checkout: herdr's own mark, else git's answer for an unmarked workspace */
export function worktreesStartHere(machineId: string, workspace: WorkspaceInfo): boolean {
  if (workspace.worktree) return !workspace.worktree.is_linked_worktree;
  return answers.get(machineId)?.get(workspace.workspace_id) === true;
}

function dropAnswers(machineId: string): void {
  answers.delete(machineId);
  rounds.set(machineId, (rounds.get(machineId) ?? 0) + 1);
}

/** one question per workspace and round: a question of a dropped round answers nobody, so the next round asks its own */
function ask(machineId: string, workspaceId: string, listWorktrees: (workspace: string) => Promise<unknown>): Promise<void> {
  const round = rounds.get(machineId) ?? 0;
  const key = `${machineId}\n${round}\n${workspaceId}`;
  const running = asking.get(key);
  if (running) return running;
  const kept = (answer: boolean): void => { if ((rounds.get(machineId) ?? 0) === round) answersOf(machineId).set(workspaceId, answer); };
  const question = listWorktrees(workspaceId).then(
    () => kept(true),
    (error: unknown) => { if (error instanceof ApiError && error.status < 500 && !NOT_ANSWERED.has(error.code ?? "")) kept(false); },
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
  const unmarked = (snapshot?.workspaces ?? []).filter((workspace) => !workspace.worktree).map((workspace) => workspace.workspace_id).join("\n");
  const asked = !online || unmarked === "" || watching || !offered ? null : unmarked;
  const lifetime = snapshot?.herdr_lifetime;
  const read = useCallback((): ReadonlySet<string> => {
    const known = answers.get(machineId);
    return new Set(asked === null || !known ? [] : asked.split("\n").filter((id) => known.get(id) === true));
  }, [machineId, asked]);
  const [repositoryWorkspaces, setRepositoryWorkspaces] = useState<ReadonlySet<string>>(() => new Set());
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
    const publish = (): void => setRepositoryWorkspaces((current) => {
      const next = read();
      return next.size === current.size && [...next].every((id) => current.has(id)) ? current : next;
    });
    listeners.add(publish);
    return () => { listeners.delete(publish); };
  }, [read]);
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
    told();
    // each answer is shown as it comes: one slow question holds back none of the others
    for (const id of ids.filter((id) => !known.has(id))) void ask(machineId, id, listWorktrees).then(told);
  }, [machineId, asked, lifetime, listWorktrees]);
  const notCheckout = useCallback((workspaceId: string) => {
    answersOf(machineId).set(workspaceId, false);
    told();
  }, [machineId]);
  return { repositoryWorkspaces, notCheckout };
}
