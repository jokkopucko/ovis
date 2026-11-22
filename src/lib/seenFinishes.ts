import type { SeenFinish } from "../../shared/seen.ts";
import type { SeenRecord } from "./sidebarOrder.ts";

export const SEEN_PREFIX = "ovis:finish:";
const OLD_PREFIX = "ovis:seen:";
export const SEEN_LIMIT = 2000;
const scope = (pc: string, epoch: string) => `${SEEN_PREFIX}${encodeURIComponent(pc)}:${encodeURIComponent(epoch)}:`;
export const seenKey = (pc: string, epoch: string, pane: string): string => scope(pc, epoch) + encodeURIComponent(pane);

interface StoredFinish { id: number; at: number; answer?: string }
interface CachedFinish extends StoredFinish { key: string; pc: string; epoch: string; pane: string; stored: boolean }
export interface SeenChange { pc: string; epoch: string }
type SeenListener = (changes: readonly SeenChange[]) => void;

function parse(raw: string | null): StoredFinish | null {
  try {
    const value: unknown = JSON.parse(raw ?? "null");
    if (value && typeof value === "object" && "id" in value && "at" in value
      && typeof value.id === "number" && Number.isSafeInteger(value.id) && value.id > 0
      && typeof value.at === "number" && Number.isFinite(value.at)) return { id: value.id, at: value.at,
        ...("answer" in value && typeof value.answer === "string" ? { answer: value.answer } : {}) };
  } catch {}
  return null;
}

function finishParts(key: string): { pc: string; epoch: string; pane: string } | null {
  if (!key.startsWith(SEEN_PREFIX)) return null;
  const parts = key.slice(SEEN_PREFIX.length).split(":");
  if (parts.length !== 3) return null;
  try {
    const [pc, epoch, pane] = parts.map(decodeURIComponent);
    return pc && epoch && pane ? { pc, epoch, pane } : null;
  } catch { return null; }
}

const emptyRecord: SeenRecord = {};
const records = new Map<string, CachedFinish>();
const scopeRecords = new Map<string, SeenRecord>();
const listeners = new Set<SeenListener>();
let storageIdentity: Storage | null | undefined;
let hydrated = false;
let refreshSnapshot = false;
let listeningWindow: Window | null = null;

const recordScope = (pc: string, epoch: string): string => JSON.stringify([pc, epoch]);

function storageNow(): Storage | null {
  let current: Storage | null = null;
  try { if (typeof localStorage !== "undefined") current = localStorage; } catch {}
  if (current === storageIdentity) return current;
  const previous = storageIdentity;
  storageIdentity = current;
  if (current === null) {
    if (previous !== undefined && previous !== null) {
      hydrated = false;
      refreshSnapshot = true;
      scopeRecords.clear();
    }
    return null;
  }
  if (previous === null) {
    hydrated = false;
    refreshSnapshot = true;
    scopeRecords.clear();
  } else {
    records.clear();
    scopeRecords.clear();
    hydrated = false;
    refreshSnapshot = false;
  }
  return current;
}

function cacheChange(entry: CachedFinish, changes?: SeenChange[]): void {
  const previous = records.get(entry.key);
  let next = entry;
  if (previous) {
    if (previous.id > entry.id) next = { ...previous, stored: entry.stored };
    else if (previous.id === entry.id) next = { ...previous,
      answer: entry.stored && entry.answer !== undefined ? entry.answer : previous.answer ?? entry.answer, stored: entry.stored };
  }
  records.set(entry.key, next);
  if ((previous?.id ?? 0) !== next.id) {
    scopeRecords.delete(recordScope(entry.pc, entry.epoch));
    changes?.push({ pc: entry.pc, epoch: entry.epoch });
  }
}

function oldestRecord(): CachedFinish | undefined {
  let oldest: CachedFinish | undefined;
  for (const entry of records.values()) {
    if (!oldest || entry.at < oldest.at || (entry.at === oldest.at && entry.key.localeCompare(oldest.key) < 0)) oldest = entry;
  }
  return oldest;
}

function trimRecords(storage: Storage | null, changes?: SeenChange[]): void {
  while (records.size > SEEN_LIMIT) {
    const oldest = oldestRecord();
    if (!oldest) return;
    records.delete(oldest.key);
    scopeRecords.delete(recordScope(oldest.pc, oldest.epoch));
    if (oldest.stored) {
      try { storage?.removeItem(oldest.key); } catch {}
    }
    changes?.push({ pc: oldest.pc, epoch: oldest.epoch });
  }
}

function hydrate(): void {
  const storage = storageNow();
  if (hydrated) return;
  hydrated = true;
  const refreshing = refreshSnapshot;
  scopeRecords.clear();
  if (!storage) { refreshSnapshot = false; return; }

  const seenDuringRefresh = refreshing ? new Set<string>() : null;
  let complete = true;
  try {
    // Walk backwards so removing an old/evicted key never shifts an unvisited key index.
    for (let index = storage.length - 1; index >= 0; index--) {
      const key = storage.key(index);
      if (!key) continue;
      if (key.startsWith(OLD_PREFIX)) {
        storage.removeItem(key);
        continue;
      }
      if (!key.startsWith(SEEN_PREFIX)) continue;
      seenDuringRefresh?.add(key);
      const parts = finishParts(key);
      if (!parts) {
        storage.removeItem(key);
        continue;
      }
      const saved = parse(storage.getItem(key));
      const entry: CachedFinish = { key, ...parts, id: saved?.id ?? 0, at: saved?.at ?? 0,
        ...(saved?.answer === undefined ? {} : { answer: saved.answer }), stored: true };
      const previous = records.get(key);
      cacheChange(entry);
      const kept = records.get(key);
      if (kept && previous && (kept.id > entry.id || (kept.id === entry.id && kept.answer !== undefined && entry.answer === undefined))) {
        try { storage.setItem(key, JSON.stringify({ id: kept.id, at: kept.at, ...(kept.answer === undefined ? {} : { answer: kept.answer }) })); }
        catch { kept.stored = false; }
      }
      trimRecords(storage);
    }
  } catch {
    complete = false;
  }
  if (refreshing && complete && seenDuringRefresh) {
    const changes: SeenChange[] = [];
    for (const [key, entry] of records) {
      if (!entry.stored || seenDuringRefresh.has(key)) continue;
      records.delete(key);
      scopeRecords.delete(recordScope(entry.pc, entry.epoch));
      changes.push({ pc: entry.pc, epoch: entry.epoch });
    }
    notify(changes);
  }
  refreshSnapshot = false;
}

function recordFor(pc: string, epoch: string): SeenRecord {
  hydrate();
  const cacheKey = recordScope(pc, epoch);
  const cached = scopeRecords.get(cacheKey);
  if (cached) return cached;
  const record: Record<string, number> = {};
  let hasFinish = false;
  for (const entry of records.values()) {
    if (entry.pc === pc && entry.epoch === epoch && entry.id > 0) {
      record[entry.pane] = entry.id;
      hasFinish = true;
    }
  }
  const result = hasFinish ? record : emptyRecord;
  scopeRecords.set(cacheKey, result);
  return result;
}

function notify(changes: readonly SeenChange[]): void {
  if (changes.length === 0 || listeners.size === 0) return;
  const unique = new Map<string, SeenChange>();
  for (const change of changes) unique.set(recordScope(change.pc, change.epoch), change);
  const batch = [...unique.values()];
  for (const listener of [...listeners]) listener(batch);
}

function handleStorage(event: StorageEvent): void {
  const storage = storageNow();
  if (!storage || (event.storageArea && event.storageArea !== storage)) return;
  if (event.key === null) {
    const changes: SeenChange[] = [];
    for (const entry of records.values()) changes.push({ pc: entry.pc, epoch: entry.epoch });
    records.clear();
    scopeRecords.clear();
    // The clear event can arrive after this page persisted another finish. Read what
    // storage contains now instead of discarding a newer acknowledgement with the old one.
    hydrated = false;
    refreshSnapshot = false;
    hydrate();
    for (const entry of records.values()) changes.push({ pc: entry.pc, epoch: entry.epoch });
    notify(changes);
    return;
  }
  const key = event.key;
  if (!key.startsWith(SEEN_PREFIX)) return;
  const parts = finishParts(key);
  if (!parts) return;

  let currentRaw: string | null;
  try { currentRaw = storage.getItem(key); } catch { return; }
  const held = records.get(key);
  if (currentRaw === null) {
    if (held) {
      records.delete(key);
      scopeRecords.delete(recordScope(held.pc, held.epoch));
      notify([{ pc: held.pc, epoch: held.epoch }]);
    }
    return; // A queued write event must not resurrect a deleted key.
  }
  const current = parse(currentRaw);
  if (!current) return;
  const incoming = parse(event.newValue);
  const id = Math.max(current.id, incoming?.id ?? 0, held?.id ?? 0);
  const answer = (current.id === id ? current.answer : undefined) ?? (held?.id === id ? held.answer : undefined)
    ?? (incoming?.id === id ? incoming.answer : undefined);
  const at = current.id === id ? current.at : held?.id === id ? held.at : incoming?.at ?? current.at;
  const merged: StoredFinish = { id, at, ...(answer === undefined ? {} : { answer }) };
  let stored = current.id === id && (current.answer !== undefined || answer === undefined);
  if (!stored) {
    try { storage?.setItem(key, JSON.stringify(merged)); stored = true; }
    catch {}
  }
  const changes: SeenChange[] = [];
  cacheChange({ key, ...parts, ...merged, stored }, changes);
  trimRecords(storage, changes);
  notify(changes);
}

function startStorageListener(): void {
  try {
    if (typeof window === "undefined") return;
    listeningWindow = window;
    listeningWindow.addEventListener("storage", handleStorage);
  } catch { listeningWindow = null; }
}

function stopStorageListener(): void {
  if (!listeningWindow) return;
  listeningWindow.removeEventListener("storage", handleStorage);
  listeningWindow = null;
}

export function readSeenFinish(key: string): StoredFinish | null {
  try { return parse(localStorage.getItem(key)); } catch { return null; }
}

export function loadSeen(pc: string, epoch: string): SeenRecord {
  return recordFor(pc, epoch);
}

function write(pc: string, epoch: string, pane: string, id: number, answer?: string): { id: number; changes: SeenChange[] } {
  hydrate();
  const key = seenKey(pc, epoch, pane);
  const held = records.get(key);
  const storage = storageNow();
  if (held?.stored && (held.id > id || (held.id === id && (held.answer !== undefined || answer === undefined)))) {
    if (listeningWindow !== null || !storage) return { id: held.id, changes: [] };
    let current: StoredFinish | null = null;
    try { current = parse(storage.getItem(key)); } catch { return { id: held.id, changes: [] }; }
    if (current !== null && current.id >= held.id) return { id: held.id, changes: [] };
  }

  let saved: StoredFinish | null = null;
  let read = false;
  try {
    if (storage) { saved = parse(storage.getItem(key)); read = true; }
  } catch {}
  const latestId = Math.max(id, held?.id ?? 0, saved?.id ?? 0);
  const latestAnswer = (saved?.id === latestId ? saved.answer : undefined)
    ?? (held?.id === latestId ? held.answer : undefined)
    ?? (id === latestId ? answer : undefined);
  const at = saved?.id === latestId ? saved.at : held?.id === latestId ? held.at : Date.now();
  const merged: StoredFinish = { id: latestId, at, ...(latestAnswer === undefined ? {} : { answer: latestAnswer }) };
  let stored = false;
  const needsWrite = !saved || saved.id < latestId || (saved.id === latestId && saved.answer === undefined && latestAnswer !== undefined);
  if (read && storage) {
    try {
      if (needsWrite) storage.setItem(key, JSON.stringify(merged));
      stored = true;
    } catch {}
  }

  const changes: SeenChange[] = [];
  cacheChange({ key, pc, epoch, pane, ...merged, stored }, changes);
  trimRecords(storage, changes);
  return { id: records.get(key)?.id ?? latestId, changes };
}

export function saveSeen(pc: string, epoch: string, pane: string, id: number, answer?: string): number {
  const saved = write(pc, epoch, pane, id, answer);
  notify(saved.changes);
  return saved.id;
}

export function subscribeSeen(listener: SeenListener): () => void {
  storageNow();
  if (listeners.size === 0) {
    if (hydrated) {
      hydrated = false;
      refreshSnapshot = true;
      scopeRecords.clear();
    }
    startStorageListener();
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      stopStorageListener();
      records.clear();
      scopeRecords.clear();
      hydrated = false;
      refreshSnapshot = false;
    }
  };
}

export function receiveSeen(finishes: readonly SeenFinish[]): void {
  hydrate();
  const changes: SeenChange[] = [];
  for (const finish of finishes) changes.push(...write(finish.pc, finish.epoch, finish.pane, finish.id, finish.answer).changes);
  notify(changes);
}

/**
 * Only an epoch this tab actually left is known to be obsolete. An arbitrary other epoch might
 * belong to a newer tab than this tab's initial roster, so it is capped, not guessed to be old.
 * Never prune from a pane/PC roster. Old-format records cannot identify finishes and are removed.
 */
export function cleanSeen(retired: readonly { pc: string; epoch: string }[]): void {
  hydrate();
  const storage = storageNow();
  const retiredScopes = new Set(retired.map(({ pc, epoch }) => recordScope(pc, epoch)));
  for (const scope of retiredScopes) scopeRecords.delete(scope);
  const changes: SeenChange[] = [];
  for (const [key, entry] of records) {
    if (!retiredScopes.has(recordScope(entry.pc, entry.epoch))) continue;
    if (entry.stored) {
      try { storage?.removeItem(key); } catch {}
    }
    records.delete(key);
    scopeRecords.delete(recordScope(entry.pc, entry.epoch));
    changes.push({ pc: entry.pc, epoch: entry.epoch });
  }
  trimRecords(storage, changes);
  notify(changes);
}
