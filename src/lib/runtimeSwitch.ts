/**
 * After a runtime switch (Settings → About → Terminals), the server restarts on the chosen runtime.
 * The wait for the restarted one lives here, for the page's lifetime, so neither closing Settings
 * nor anything else the page does stops it: it asks the bridge's boot id until another one answers
 * that its launcher took as its own (past the launcher's check, which rolls back a start that fails
 * it), then tells the app (`onBack`), which reads the new server's facts as after any restart; no reload.
 * A server that has not come back by the deadline is reported once (the `lost` state). Each ask is
 * bounded too, so one request that never settles cannot hold the deadline off.
 */
import type { RuntimeName } from "../../shared/machines.ts";

export interface FollowRestartOptions {
  /** the boot id that answered before the switch: any other one is the restarted server */
  from: string | null;
  /** the bridge's boot id now, and whether its launcher took it as its own; null while none answers */
  boot: () => Promise<{ id: string; accepted: boolean } | null>;
  onBack: () => void;
  onLost: () => void;
  pollMs?: number;
  waitMs?: number;
  /** the longest one ask is waited for */
  askMs?: number;
  now?: () => number;
  schedule?: (run: () => void, ms: number) => void;
  /** settles with null after `ms`: what bounds one ask */
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

/** The switch the page waits on: which runtime, and whether the server stayed away past the deadline. */
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

/** Starts waiting for the server a switch to `to` restarts, for the page's lifetime. */
export function awaitRestart(to: RuntimeName, options: Omit<FollowRestartOptions, "onLost">): void {
  set({ to, lost: false });
  followRestart({
    ...options,
    onBack: () => { set(null); options.onBack(); },
    onLost: () => set({ to, lost: true }),
  });
}
