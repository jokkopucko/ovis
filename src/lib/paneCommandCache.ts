import { paneStorageId } from "../../shared/machines.ts";
import type { SlashCommand } from "../../shared/protocol.ts";
import { paneCommandScope, paneScopesMoving } from "./api.ts";

const COMMAND_CACHE_MS = 60_000;
const cache = new Map<string, { loadedAt: number; commands: SlashCommand[] }>();
/** per pane, how many times its lists were invalidated: a read begun before one is answered but not kept */
const generations = new Map<string, number>();
/** the read on its way per list and invalidation: the pane's terminal, chat and composer mount together and share it */
const reading = new Map<string, Promise<SlashCommand[]>>();
const listeners = new Set<(paneId: string, machineId: string) => void>();

/**
 * A pane's slash commands, asked for at most once a minute per PC, pane and agent: the composer's
 * menu and the chat's skill chips read the same answer, and a pane whose agent changed (a shell
 * that started one, an agent replaced by another) or that runs it in another session or folder
 * (paneCommandScope) asks again for that list. A call while
 * a read of the same list is on its way gets that read's answer, unless the pane was invalidated
 * since it began; a failed read is forgotten, so the next call asks again.
 */
export async function cachedPaneCommands(paneId: string, machineId: string, agent: string | null | undefined, fetchCommands: (pane: string) => Promise<SlashCommand[]>): Promise<SlashCommand[]> {
  // no agent named: the server lists no commands for a shell. A new tab's chat mounts before the roster names its
  // agent, and that read only added herdr calls beside the roster's own; the named agent's read follows
  if (!agent) return [];
  const pane = paneStorageId(machineId, paneId);
  const list = `${pane}:${agent}\u0000`;
  const scope = paneCommandScope(paneId, machineId);
  const key = `${list}${scope}`;
  const cached = cache.get(key);
  if (cached && Date.now() - cached.loadedAt < COMMAND_CACHE_MS) return cached.commands;
  const generation = generations.get(pane) ?? 0;
  const moving = paneScopesMoving(machineId);
  const flight = `${key}\0${generation}\0${moving ?? ""}`;
  const shared = reading.get(flight);
  if (shared) return shared;
  const read = fetchCommands(paneId).then((commands) => {
    // invalidated while on its way: answered but never kept, so the read begun after it is what the pane keeps
    // or read for a session or folder the pane has left since: answered, but the pane keeps the list of the one it is on
    // or begun or answered while the PC's panes were changing (paneScopesMoving): of a session the roster has not named
    if ((generations.get(pane) ?? 0) === generation && paneCommandScope(paneId, machineId) === scope && moving === undefined && paneScopesMoving(machineId) === undefined) {
      // the list of a session or folder the pane has left is not drawn again
      for (const other of cache.keys()) if (other.startsWith(list) && other !== key) cache.delete(other);
      cache.set(key, { loadedAt: Date.now(), commands });
    }
    return commands;
  }).finally(() => { reading.delete(flight); });
  reading.set(flight, read);
  return read;
}

/**
 * The list the last read answered for this PC, pane and agent, at once, however old; null: none has,
 * or it was invalidated since. A component whose own read is still on its way draws with it (a chat
 * opened again draws its skill chips and terminal command rows in the first frame); that read's
 * answer replaces it.
 */
export function paneCommandsNow(paneId: string, machineId: string, agent: string | null | undefined): SlashCommand[] | null {
  return cache.get(`${paneStorageId(machineId, paneId)}:${agent ?? ""}\u0000${paneCommandScope(paneId, machineId)}`)?.commands ?? null;
}

/**
 * Forgets a pane's lists, whatever agent they were read for, and tells the listeners: a command
 * that changed the agent's catalog (an outcome's `catalog_changed`) is followed by a fresh read
 * where the pane's menu is open.
 */
export function invalidatePaneCommands(paneId: string, machineId: string): void {
  const pane = paneStorageId(machineId, paneId);
  for (const key of cache.keys()) if (key.startsWith(`${pane}:`)) cache.delete(key);
  generations.set(pane, (generations.get(pane) ?? 0) + 1);
  for (const listener of listeners) listener(paneId, machineId);
}

/** Called with the pane each invalidation names; the returned function stops the calls. */
export function onPaneCommandsInvalidated(listener: (paneId: string, machineId: string) => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
