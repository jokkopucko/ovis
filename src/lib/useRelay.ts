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
 * panel's QR offer carry. A panel that started a new one says so on `window`, with the code as
 * `detail`, and the other panel shows that code instead of the one it had.
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

/** the code of a QR code shown alone ended: this window's places that show it, and other windows' QR codes, are told */
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

/**
 * The PC's device list changed behind the app: the relay shell linked this client's pairing to the
 * account (relay/shell.tsx) and the session that signed in again is up, so a Devices panel read
 * before the link lists this client as no member yet and reads the list again.
 */
export const DEVICES_CHANGED_EVENT = "ovis:devices-changed";

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

  /** Start, stop, reset or the direct switch: the answer is the relay's state after it, or the failure's words. */
  const request = useCallback(async (action: "start" | "stop" | "reset-identity" | { direct: boolean }): Promise<RelayStatus> => {
    setPending(true);
    try {
      const next = typeof action === "string" ? await requestRelay(action) : await requestRelayDirect(action.direct);
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
