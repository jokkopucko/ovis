import { useCallback, useEffect, useRef, useState } from "react";
import type { PairingCode, RelayStatus } from "../../shared/protocol.ts";
import { ApiError, fetchRelay, requestRelay, requestRelayDirect } from "./api.ts";
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
 * panel's QR offer carry.
 */
export const PAIRING_CODE_EVENT = "ovis:pairing-code";

/** `qrOnly`: the code of a QR code shown alone (RelayPairing `qrOnly`), which no place shows as digits */
export interface AnnouncedCode extends PairingCode {
  readonly qrOnly?: true;
}

export function announcePairingCode(code: AnnouncedCode): void {
  window.dispatchEvent(new CustomEvent<AnnouncedCode>(PAIRING_CODE_EVENT, { detail: code }));
}

/**
 * The relay tab's QR codes in this browser's other windows share the PC's one pending code (server/devices.ts
 * `pairingForNoAccount`): one that ends it says so on this channel, with the code as the message, and one still
 * showing that code asks for a new one (RelayPairing `qrOnly`).
 */
export const QR_CODE_ENDED_CHANNEL = "ovis:qr-code-ended";

export function announceQrCodeEnded(code: string): void {
  announcePairingCode({ code, expires_at: new Date(0).toISOString(), qrOnly: true });
  tellOtherWindowsQrCodeEnded(code);
}

export function tellOtherWindowsQrCodeEnded(code: string): void {
  if (typeof BroadcastChannel === "undefined") return;
  const channel = new BroadcastChannel(QR_CODE_ENDED_CHANNEL);
  channel.postMessage(code);
  channel.close();
}

export const DEVICES_CHANGED_EVENT = "ovis:devices-changed";

function pollDelay(status: RelayStatus): number {
  if (status.phase === "connecting") return 1_500;
  if (status.phase === "error" && status.blocked === null) return 5_000;
  return 15_000;
}

export function useRelay() {
  const [status, setStatus] = useState<RelayStatus | null>(null);
  /** the last read of the relay's state failed (not a missing route): no state may be on its way */
  const [readFailed, setReadFailed] = useState(false);
  const [unsupported, setUnsupported] = useState(false);
  const [pending, setPending] = useState(false);
  const [refresh, setRefresh] = useState(0);
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
        setReadFailed(false);
        delay = pollDelay(next);
      } catch (error) {
        // the route is missing on an older server; a restart or a dropped answer must not erase the last state
        if (!stopped && error instanceof ApiError && error.status === 404) { setUnsupported(true); return; }
        if (!stopped) setReadFailed(true);
      }
      if (!stopped) timer = setTimeout(() => void poll(), delay);
    }
    void poll();
    return () => { stopped = true; clearTimeout(timer); };
  }, [refresh, visible, unsupported]);

  const request = useCallback(async (action: "start" | "stop" | "reset-identity" | { direct: boolean }): Promise<RelayStatus> => {
    setPending(true);
    try {
      const next = typeof action === "string" ? await requestRelay(action) : await requestRelayDirect(action.direct);
      if (mounted.current) {
        setStatus(next);
        setRefresh((value) => value + 1);
      }
      return next;
    } finally { if (mounted.current) setPending(false); }
  }, []);
  /** Asks for the relay's state again now, without waiting for the poll's next round. */
  const reread = useCallback(() => setRefresh((value) => value + 1), []);
  return { status, unsupported, readFailed, pending, request, reread };
}

export type RelayState = ReturnType<typeof useRelay>;
