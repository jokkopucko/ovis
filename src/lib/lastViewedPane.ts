export type ViewedScope = "workspace" | "tab";

const KEY = "ovis:last-viewed-pane";
const LIMIT = 200;

const scopeKey = (scope: ViewedScope, machineId: string, id: string): string => `${scope}:${machineId}:${id}`;

export function parseViewedPanes(raw: string | null): Map<string, string> {
  const parsed = new Map<string, string>();
  if (raw === null) return parsed;
  try {
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value)) return parsed;
    for (const entry of value) {
      if (Array.isArray(entry) && entry.length === 2 && typeof entry[0] === "string" && typeof entry[1] === "string") parsed.set(entry[0], entry[1]);
    }
  } catch {}
  return parsed;
}

export function withViewedPane(current: ReadonlyMap<string, string>, key: string, paneId: string, limit = LIMIT): Map<string, string> {
  const next = new Map(current);
  next.delete(key);
  next.set(key, paneId);
  for (const oldest of next.keys()) {
    if (next.size <= limit) break;
    next.delete(oldest);
  }
  return next;
}

type ViewedStorage = Pick<Storage, "getItem" | "setItem">;

/**
 * Another app tab writes the same key, so a write re-reads storage and applies just its one entry,
 * and `forget` drops the cache when another tab changed it: neither tab overwrites what the other
 * remembered.
 */
export function viewedPanes(storage: () => ViewedStorage) {
  let entries: Map<string, string> | null = null;
  let memoryOnly = false;
  const fresh = (): Map<string, string> => {
    if (memoryOnly && entries) return entries;
    try { entries = parseViewedPanes(storage().getItem(KEY)); } catch { entries ??= new Map(); }
    return entries;
  };
  return {
    get(scope: ViewedScope, machineId: string, id: string): string | undefined {
      return (entries ?? fresh()).get(scopeKey(scope, machineId, id));
    },
    remember(scope: ViewedScope, machineId: string, id: string, paneId: string): void {
      const key = scopeKey(scope, machineId, id);
      const current = fresh();
      if ([...current.keys()].at(-1) === key && current.get(key) === paneId) return;
      entries = withViewedPane(current, key, paneId);
      try { storage().setItem(KEY, JSON.stringify([...entries])); } catch { memoryOnly = true; }
    },
    forget(): void {
      entries = null;
    },
  };
}

const browserPanes = viewedPanes(() => localStorage);
if (typeof window !== "undefined") window.addEventListener("storage", (event) => {
  if (event.key === KEY || event.key === null) browserPanes.forget();
});

export const lastViewedPane = browserPanes.get;
export const rememberViewedPane = browserPanes.remember;
