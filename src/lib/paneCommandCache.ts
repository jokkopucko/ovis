import { paneStorageId } from "../../shared/machines.ts";
import type { SlashCommand } from "../../shared/protocol.ts";
import { paneCommandScope, paneScopesMoving } from "./api.ts";

const COMMAND_CACHE_MS = 60_000;
const cache = new Map<string, { loadedAt: number; commands: SlashCommand[] }>();
const generations = new Map<string, number>();
const reading = new Map<string, Promise<SlashCommand[]>>();
const listeners = new Set<(paneId: string, machineId: string) => void>();

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
    if ((generations.get(pane) ?? 0) === generation && paneCommandScope(paneId, machineId) === scope && moving === undefined && paneScopesMoving(machineId) === undefined) {
      for (const other of cache.keys()) if (other.startsWith(list) && other !== key) cache.delete(other);
      cache.set(key, { loadedAt: Date.now(), commands });
    }
    return commands;
  }).finally(() => { reading.delete(flight); });
  reading.set(flight, read);
  return read;
}

export function paneCommandsNow(paneId: string, machineId: string, agent: string | null | undefined): SlashCommand[] | null {
  return cache.get(`${paneStorageId(machineId, paneId)}:${agent ?? ""}\u0000${paneCommandScope(paneId, machineId)}`)?.commands ?? null;
}

export function invalidatePaneCommands(paneId: string, machineId: string): void {
  const pane = paneStorageId(machineId, paneId);
  for (const key of cache.keys()) if (key.startsWith(`${pane}:`)) cache.delete(key);
  generations.set(pane, (generations.get(pane) ?? 0) + 1);
  for (const listener of listeners) listener(paneId, machineId);
}

export function onPaneCommandsInvalidated(listener: (paneId: string, machineId: string) => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
