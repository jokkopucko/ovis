import { useEffect, useRef, useState } from "react";
import type { SystemReport } from "../../shared/system.ts";
import { LOCAL_MACHINE } from "../../shared/machines.ts";
import { ApiError, fetchSystem } from "./api.ts";
import { usePageVisible } from "./visibility.ts";

/** the pause between one answer and the next ask for a PC that is on screen; the server shares one reading between asks closer than 1.5 s */
export const SYSTEM_POLL_MS = 5000;
export const SYSTEM_ASK_TIMEOUT_MS = 4000;
export const SYSTEM_STALE_MS = 60_000;
/**
 * This PC cannot say, and asking again will not change that until its bridge does. A bridge from
 * before the route answers 404; one that has a browser token set refuses what its allowlist does
 * not know with 401 or 403. For the PC this browser talks to itself, 401 means signed out, which
 * is not a reason to stop asking.
 */
export function systemUnavailable(error: unknown, machineId: string): boolean {
  if (!(error instanceof ApiError)) return false;
  if (error.status === 404 || error.status === 405) return true;
  return machineId !== LOCAL_MACHINE && (error.status === 401 || error.status === 403);
}

export interface SystemState {
  report: SystemReport | null;
  unavailable: boolean;
}

export function useSystemStats(machineId: string, enabled: boolean, retryKey: string): SystemState {
  const [state, setState] = useState<SystemState>({ report: null, unavailable: false });
  const visible = usePageVisible();
  const missing = useRef<string | null>(null);
  const answeredAt = useRef(0);

  useEffect(() => {
    if (!enabled || !visible || missing.current === retryKey) return;
    if (Date.now() - answeredAt.current > SYSTEM_STALE_MS) setState((last) => last.report === null ? last : { report: null, unavailable: false });
    const abort = new AbortController();
    let timer: number | undefined;
    const load = async () => {
      try {
        const report = await fetchSystem(machineId, AbortSignal.any([abort.signal, AbortSignal.timeout(SYSTEM_ASK_TIMEOUT_MS)]));
        if (abort.signal.aborted) return;
        missing.current = null;
        answeredAt.current = Date.now();
        setState({ report, unavailable: false });
      } catch (error) {
        if (abort.signal.aborted) return;
        if (systemUnavailable(error, machineId)) {
          missing.current = retryKey;
          setState({ report: null, unavailable: true });
          return;
        }
        if (Date.now() - answeredAt.current > SYSTEM_STALE_MS) setState((last) => last.report === null ? last : { report: null, unavailable: false });
      }
      timer = window.setTimeout(() => void load(), SYSTEM_POLL_MS);
    };
    void load();
    return () => { abort.abort(); window.clearTimeout(timer); };
  }, [machineId, enabled, visible, retryKey]);

  return state;
}
