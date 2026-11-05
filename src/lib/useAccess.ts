
import { useCallback, useEffect, useRef, useState } from "react";
import type { AccessRefusal, HealthAuth, SecuritySummary } from "../../shared/protocol.ts";
import { fetchBridgeHealth, pairDevice } from "./api.ts";
import { deviceLabel, takePairCode } from "./phone.ts";
import { canSignOut as authEndsHere } from "./signOut.ts";
import { sameData } from "./useMachineRoster.ts";

/** What Settings → Phone & devices shows of the server's access facts: `absent` is an older server that sends none. */
export type SecurityFacts = { state: "loading" } | { state: "error" } | { state: "absent" } | { state: "known"; summary: SecuritySummary };

export function useAccessState() {
  // null until the server has said whether it wants a token: the shell, and with it
  // the WebSocket, never mounts before that is known
  const [locked, setLocked] = useState<boolean | null>(null);
  const [lockReason, setLockReason] = useState<AccessRefusal | null>(null);
  /** the code a scanned QR brought along (`?pair=CODE`), taken off the address at once */
  const [pairCode, setPairCode] = useState(() => takePairCode());
  const pairCodeConsumed = useRef(false);
  // both the gate and an already-open browser claim the same single-use address code
  // the ref also stops a second claim before React renders the cleared state
  const consumePairCode = useCallback(() => {
    if (pairCodeConsumed.current) return "";
    pairCodeConsumed.current = true;
    setPairCode("");
    return pairCode;
  }, [pairCode]);
  const [pairingSucceeded, setPairingSucceeded] = useState(false);
  const onPaired = useCallback(() => setPairingSucceeded(true), []);
  const pairingUnconfirmed = locked === true && pairingSucceeded;
  const [auth, setAuth] = useState<HealthAuth | null>(null);
  const [security, setSecurity] = useState<SecurityFacts>({ state: "loading" });
  // a token a proxy sends with every request comes back right after signing out: signing out is the proxy's
  const canSignOut = authEndsHere(auth);
  // the newest read to settle, answer or failure, decides the facts: an older one that lands after
  // it changes nothing, and a failure clears them even while a newer read is still out
  const started = useRef(0);
  const settled = useRef(0);
  const readBridgeHealth = useCallback(async () => {
    const read = ++started.current;
    const newest = () => { if (read < settled.current) return false; settled.current = read; return true; };
    try {
      const next = await fetchBridgeHealth(); setLocked(next.auth.required && !next.auth.authenticated); setLockReason(next.auth.reason ?? null); setAuth(next.auth);
      if (next.auth.authenticated) setPairingSucceeded(false);
      // the bridge scope answers without herdr; a server that sends no facts is older, never "fine"
      const summary = next.security;
      if (newest()) setSecurity((previous) => summary === undefined ? (previous.state === "absent" ? previous : { state: "absent" })
        : previous.state === "known" && sameData(previous.summary, summary) ? previous : { state: "known", summary });
    }
    // retain the gate while the connection server restarts, but not the facts it last reported
    catch { if (newest()) setSecurity((previous) => previous.state === "error" ? previous : { state: "error" }); }
  }, []);
  return { locked, setLocked, lockReason, setLockReason, pairCode, consumePairCode, pairingUnconfirmed, onPaired, auth, setAuth, canSignOut, security, readBridgeHealth };
}

/** an already-open browser still pairs from a QR address, using the same claim as the gate */
export function usePairFromAddress({ locked, pairCode, auth, consumePairCode, onPaired, loadHealth }: {
  locked: boolean | null;
  pairCode: string;
  auth: HealthAuth | null;
  consumePairCode: () => string;
  onPaired: () => void;
  loadHealth: () => Promise<void>;
}) {
  useEffect(() => {
    if (locked !== false || pairCode === "" || auth?.via === "device") return;
    const code = consumePairCode();
    if (code === "") return;
    pairDevice(code, deviceLabel(navigator.userAgent, navigator.maxTouchPoints ?? 0)).then(() => { onPaired(); return loadHealth(); }).catch(() => { /* the gate, if any, reports it */ });
  }, [locked, pairCode, auth, consumePairCode, onPaired, loadHealth]);
}

export function useLockedRef({ locked }: { locked: boolean | null }) {
  const lockedRef = useRef(locked);
  lockedRef.current = locked;
  return { lockedRef };
}
