import { useCallback, useEffect, useRef, useState } from "react";
import type { PairingCode, RelayStatus } from "../../shared/protocol.ts";
import { ApiError, fetchRelay, requestRelay } from "./api.ts";
import { usePageVisible } from "./visibility.ts";

/**
 * The hosted shell names itself in its `index.html`: a phone that reached this PC through the
 * relay cannot control that relay (the server refuses every mutation over a relayed session),
 * so the relay panel stays off it.
 */
export function inRelayShell(): boolean {
  return typeof document !== "undefined" && document.querySelector('meta[name="ovis-shell"]')?.getAttribute("content") === "relay";
}

/**
 * The server keeps one pending pairing code, which both the Devices group's code and the relay
 * panel's QR offer carry. A panel that started a new one says so on `window`, with the code as
 * `detail`, and the other panel shows that code instead of the one it had.
 */
export const PAIRING_CODE_EVENT = "ovis:pairing-code";

export function announcePairingCode(code: PairingCode): void {
  window.dispatchEvent(new CustomEvent<PairingCode>(PAIRING_CODE_EVENT, { detail: code }));
}

/** how often the relay is asked again: closely while it connects or retries, otherwise at rest */
function pollDelay(status: RelayStatus): number {
  if (status.phase === "connecting") return 1_500;
  if (status.phase === "error" && status.blocked === null) return 5_000;
  return 15_000;
}

/**
 * The Ovis relay's state on the server's PC (server/relay/service.ts), asked while Settings →
 * Phone & devices is open, and the actions that change it. An older server has no such route:
 * `unsupported` then, and the panel shows nothing.
 */
export function useRelay() {
  const [status, setStatus] = useState<RelayStatus | null>(null);
  const [unsupported, setUnsupported] = useState(false);
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
    if (!visible || unsupported) return;
    let timer: ReturnType<typeof setTimeout>;
    let stopped = false;
    async function poll() {
      let delay = 15_000;
      try {
        const next = await fetchRelay();
        if (stopped) return;
        setStatus((previous) => JSON.stringify(previous) === JSON.stringify(next) ? previous : next);
        delay = pollDelay(next);
      } catch (error) {
        // the route is missing on an older server; a restart or a dropped answer must not erase the last state
        if (!stopped && error instanceof ApiError && error.status === 404) { setUnsupported(true); return; }
      }
      if (!stopped) timer = setTimeout(() => void poll(), delay);
    }
    void poll();
    return () => { stopped = true; clearTimeout(timer); };
  }, [refresh, visible, unsupported]);

  /** Start, stop or reset: the answer is the relay's state after it, or the failure's words. */
  const request = useCallback(async (action: "start" | "stop" | "reset-identity"): Promise<RelayStatus> => {
    setPending(true);
    try {
      const next = await requestRelay(action);
      if (mounted.current) {
        setStatus(next);
        // a start is still connecting: the next answers follow it closely
        setRefresh((value) => value + 1);
      }
      return next;
    } finally { if (mounted.current) setPending(false); }
  }, []);
  return { status, unsupported, pending, request };
}

export type RelayState = ReturnType<typeof useRelay>;
