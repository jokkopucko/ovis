import { useEffect, useRef, useState } from "react";

/**
 * A server restart (an update, a preview following main) drops every socket and the client is back within about 4 s (ws.ts backs off 0.25, 0.5, 1, 2 s): saying
 * Reconnecting for each of those would be noise, as messengers show a status only for a drop that lasts.
 */
export const RECONNECT_GRACE_MS = 4_000;

export function useReconnectGrace(connected: boolean, connectedBefore: boolean, urgent: boolean, lostAt: number | null = null): boolean {
  const dropped = !connected && connectedBefore;
  const seenAt = useRef<number | null>(null);
  if (!dropped) seenAt.current = null;
  else if (seenAt.current === null) seenAt.current = Date.now();
  const since = dropped ? lostAt ?? seenAt.current : null;
  const [expiredFor, setExpiredFor] = useState<number | null>(null);
  useEffect(() => {
    if (since === null) return;
    const timer = setTimeout(() => setExpiredFor(since), Math.max(0, since + RECONNECT_GRACE_MS - Date.now()));
    return () => clearTimeout(timer);
  }, [since]);
  if (connected) return true;
  if (since === null || urgent) return false;
  return expiredFor !== since && Date.now() - since < RECONNECT_GRACE_MS;
}
