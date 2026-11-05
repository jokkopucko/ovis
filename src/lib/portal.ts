import { useCallback, useEffect, useRef, useState } from "react";
import type { PortalAuth, PortalStatus } from "../../shared/protocol.ts";
import { fetchPortal, requestPortal } from "./api.ts";
import { usePageVisible } from "./visibility.ts";

/** the address comes or goes with these, so they are followed closely */
const SETTLING: ReadonlySet<PortalStatus["phase"]> = new Set(["starting", "recovering", "stopping"]);

/**
 * Portal's public address, which the server opens with the `portal` on its PC (server/portal.ts).
 * Asked while Settings → Phone & devices is open.
 */
export function usePortal() {
  const [status, setStatus] = useState<PortalStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [refresh, setRefresh] = useState(0);
  // the component's own lifetime, not the poll's: a page hidden while the request is on its way must still get the answer
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  const visible = usePageVisible();
  useEffect(() => {
    if (!visible) return;
    let timer: ReturnType<typeof setTimeout>;
    let stopped = false;
    async function poll() {
      let delay = 15_000;
      try {
        const next = await fetchPortal();
        if (!stopped) setStatus((previous) => JSON.stringify(previous) === JSON.stringify(next) ? previous : next);
        if (SETTLING.has(next.phase)) delay = 1_500;
      } catch { /* an older server has no such route, and a restart must not erase the last answer */ }
      if (!stopped) timer = setTimeout(() => void poll(), delay);
    }
    void poll();
    return () => { stopped = true; clearTimeout(timer); };
  }, [refresh, visible]);

  const request = useCallback(async (action: "start" | "stop", relay?: string, auth?: PortalAuth) => {
    setPending(true); setError(null);
    try {
      await requestPortal(action, relay, auth);
      if (mounted.current) {
        // the server is already on it: the controls follow at once, not at the next answer
        setStatus((previous) => previous ? { ...previous, phase: action === "start" ? "starting" : "stopping", error: null, ...(action === "stop" ? { url: null } : { auth: auth ?? previous.auth }) } : previous);
        setRefresh((value) => value + 1);
      }
    } catch (err) {
      if (mounted.current) setError(err instanceof Error ? err.message : String(err));
    } finally { if (mounted.current) setPending(false); }
  }, []);
  const busy = pending || (status !== null && SETTLING.has(status.phase));
  return { status, error, pending, busy, request };
}
