import { useEffect, useState } from "react";

import type { ListAddState } from "../../shared/machines.ts";
import { ADDED_POLL_MS } from "../components/AccountSection.tsx";
import { ApiError, fetchListAdd } from "./api.ts";
import type { MachineSessionRegistry } from "./machineSession.ts";

/**
 * Where an add of this PC by its account's signed list stands (GET /api/account/list/add), read every ADDED_POLL_MS
 * while `enabled` and the page shows, and at once whenever `again` changes, the page shows again or the local socket
 * opens: each read also takes the adding device's next message, as `ovis add` does. A 403, 404 or 405 is final: a window that is not the PC's own, or a PC that
 * follows no list (or has no such route), is not asked again. Null until it was read.
 */
export function useListAdd(enabled: boolean, again = 0, machineSessions?: MachineSessionRegistry): ListAddState | null {
  const [state, setState] = useState<ListAddState | null>(null);
  useEffect(() => {
    if (!enabled) { setState(null); return; }
    let live = true;
    let refused = false;
    // a read that answers after a newer one was applied is older news
    let issued = 0;
    let applied = 0;
    const read = (): void => {
      if (refused || document.hidden) return;
      const seq = ++issued;
      fetchListAdd().then((next) => {
        if (!live || refused || seq < applied) return;
        applied = seq;
        setState(next);
      }, (error: unknown) => {
        // an older refusal must not shut out a newer read that is still in flight, or clear what it brought
        if (!live || seq !== issued) return;
        if (error instanceof ApiError && (error.status === 403 || error.status === 404 || error.status === 405)) { refused = true; setState(null); }
        else console.warn("Ovis: the add by the account's list could not be read", error instanceof Error ? error.name : error);
      });
    };
    read();
    const timer = setInterval(read, ADDED_POLL_MS);
    const offOpen = machineSessions?.get("local").socket.onBeforeReplay(read);
    document.addEventListener("visibilitychange", read);
    return () => {
      live = false;
      clearInterval(timer);
      offOpen?.();
      document.removeEventListener("visibilitychange", read);
    };
  }, [enabled, again, machineSessions]);
  return state;
}
