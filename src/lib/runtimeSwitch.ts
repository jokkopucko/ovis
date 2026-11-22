/**
 * Each ask is bounded too, so one request that never settles cannot hold the deadline off.
 */
import type { RuntimeName } from "../../shared/machines.ts";

export interface FollowRestartOptions {
  from: string | null;
  boot: () => Promise<{ id: string; accepted: boolean } | null>;
  onBack: () => void;
  onLost: () => void;
  pollMs?: number;
  waitMs?: number;
  askMs?: number;
  now?: () => number;
  schedule?: (run: () => void, ms: number) => void;
  limit?: (ms: number) => Promise<null>;
}

export const RESTART_POLL_MS = 1000;
export const RESTART_WAIT_MS = 90_000;
const RESTART_ASK_MS = 5000;

export function followRestart(options: FollowRestartOptions): void {
  const now = options.now ?? Date.now;
  const schedule = options.schedule ?? ((run, ms) => { setTimeout(run, ms); });
  const limit = options.limit ?? ((ms) => new Promise<null>((resolve) => { setTimeout(() => resolve(null), ms); }));
  const deadline = now() + (options.waitMs ?? RESTART_WAIT_MS);
  const ask = async (): Promise<void> => {
    const bound = Math.max(0, Math.min(options.askMs ?? RESTART_ASK_MS, deadline - now()));
    const boot = await Promise.race([options.boot().catch(() => null), limit(bound)]);
    if (boot !== null && boot.id !== options.from && boot.accepted) { options.onBack(); return; }
    if (now() > deadline) { options.onLost(); return; }
    schedule(() => void ask(), options.pollMs ?? RESTART_POLL_MS);
  };
  void ask();
}

export type RestartState = { to: RuntimeName; lost: boolean } | null;

let state: RestartState = null;
const listeners = new Set<() => void>();
const set = (next: RestartState) => { state = next; for (const listener of listeners) listener(); };

export function restartState(): RestartState {
  return state;
}

export function subscribeRestart(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function awaitRestart(to: RuntimeName, options: Omit<FollowRestartOptions, "onLost">): void {
  set({ to, lost: false });
  followRestart({
    ...options,
    onBack: () => { set(null); options.onBack(); },
    onLost: () => set({ to, lost: true }),
  });
}
