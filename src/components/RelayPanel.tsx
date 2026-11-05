import { useEffect, useRef, useState } from "react";
import { RefreshCw } from "lucide-react";

import "./RelayPanel.css";

import { ApiError, requestRelayOffer, startPairing, type RelayOffer } from "../lib/api.ts";
import { useT } from "../lib/i18n.ts";
import { callNative, hasNativePlugin } from "../lib/nativeApp.ts";
import { announcePairingCode, PAIRING_CODE_EVENT } from "../lib/useRelay.ts";
import type { PairingCode, RelayStatus } from "../../shared/protocol.ts";
import { decodeOffer } from "../../shared/relay-offer.ts";
import { QrReveal, ShareLink } from "./PhonePanel.tsx";
import { KeyId } from "./KeyId.tsx";
import { QrCode } from "./QrCode.tsx";

export const failureText = (error: unknown): string => error instanceof ApiError ? error.detail : error instanceof Error ? error.message : String(error);

export function statusText(t: ReturnType<typeof useT>, status: RelayStatus): string {
  if (status.blocked === "serve_only") return t("Blocked: OVIS_TAILSCALE_SERVE_ONLY says tailscale serve is the only way in. Unset it on this PC and restart the app.");
  if (status.blocked === "identity_unreadable") return t("Blocked: this PC's relay identity cannot be read. Reset it in Connect a phone to use the relay again.");
  switch (status.phase) {
    case "off": return t("Off. Nothing goes through the relay.");
    case "connecting": return t("Connecting…");
    case "online":
      return status.sessions === 0 ? t("Online. No phone connected.") : status.sessions === 1 ? t("Online. 1 phone connected.") : t("Online. {n} phones connected.", { n: status.sessions });
    default: return t("Error: {message}", { message: status.error ?? t("Could not reach the relay.") });
  }
}

/**
 * Pairs the phone this page runs on through the relay: its own offer opens here, as its QR code
 * would on a phone that scanned it. In the app it opens as one more PC of the app's list
 * (HerdrShell.open, labelled with the offer's name); in a browser this tab goes to the hosted
 * shell, which pairs the phone and keeps its key there.
 */
export async function openOwnOffer(url: string): Promise<void> {
  if (hasNativePlugin("HerdrShell")) {
    const offer = decodeOffer(url);
    if (offer === null) throw new Error("The relay's offer carries no pairing.");
    const scope = url.slice(0, url.indexOf("#"));
    await callNative("HerdrShell", "open", { url, scope, ...(offer.name === undefined ? {} : { name: offer.name }) });
    return;
  }
  window.location.assign(url);
}

// a code announced by a relay QR (announceFromRelay), not by the Devices group
let relayAnnouncing = false;
function announceFromRelay(code: PairingCode): void {
  relayAnnouncing = true;
  try { announcePairingCode(code); } finally { relayAnnouncing = false; }
}

/**
 * The QR code of the pending pairing offer, counted down to its expiry. An offer is asked for when
 * this opens with the relay online, when the Devices group starts a new code (the server keeps one
 * pending code, so both show the same), when the code ran out, and on New code, which starts a
 * new code first; never on a timer or a render. The setup guide's and Settings' relay QR codes can be
 * up at once: a code another one announces is the one this shows already, or this asks for the offer
 * again without announcing it (the server's offer reuses its pending code), so the two never keep
 * answering each other.
 */
export function RelayPairing({ phone = false }: { phone?: boolean }) {
  const t = useT();
  const [offer, setOffer] = useState<RelayOffer | null>(null);
  const [left, setLeft] = useState("");
  const [state, setState] = useState<"minting" | "live" | "expired" | "failed">("minting");
  const [failure, setFailure] = useState<string | null>(null);
  // the effect below asks for an offer once per value
  const [generation, setGeneration] = useState(0);
  // this panel's own announcement must not make it ask twice
  const announcing = useRef(false);
  // the code on screen, and an ask for the offer that is not announced (another relay QR's code)
  const shown = useRef<string | null>(null);
  const quiet = useRef(false);
  const again = () => setGeneration((value) => value + 1);

  useEffect(() => {
    let cancelled = false;
    const silent = quiet.current;
    quiet.current = false;
    setState("minting");
    requestRelayOffer().then((next) => {
      if (cancelled) return;
      setOffer(next);
      setState("live");
      // the server made this offer's code, maybe with no New code pressed: the page watches it like any other
      // (the Devices group re-reads its list while a code is out and closes the dialog once the phone is in)
      const code = decodeOffer(next.url)?.code;
      shown.current = code ?? null;
      if (code !== undefined && !silent) {
        announcing.current = true;
        try { announceFromRelay({ code, expires_at: next.expires_at }); } finally { announcing.current = false; }
      }
    }, (reason: unknown) => {
      if (cancelled) return;
      setOffer(null);
      setFailure(failureText(reason));
      setState("failed");
    });
    return () => { cancelled = true; };
  }, [generation]);

  useEffect(() => {
    const onCode = (event: Event) => {
      if (announcing.current) return;
      const code = (event as CustomEvent<PairingCode | undefined>).detail?.code;
      if (relayAnnouncing) {
        if (code === undefined || code !== shown.current) { quiet.current = true; again(); }
        return;
      }
      again();
    };
    window.addEventListener(PAIRING_CODE_EVENT, onCode);
    return () => window.removeEventListener(PAIRING_CODE_EVENT, onCode);
  }, []);

  useEffect(() => {
    if (offer === null) return;
    let wasLive = false;
    const tick = () => {
      const ms = Date.parse(offer.expires_at) - Date.now();
      if (ms <= 0) {
        setOffer(null);
        // a code that ran out while shown is replaced by itself; one that arrived already expired
        // (the PC's clock and this one apart) is not, or the asking would never end
        if (wasLive) again(); else setState("expired");
        return;
      }
      wasLive = true;
      setLeft(`${Math.floor(ms / 60_000)}:${String(Math.floor((ms % 60_000) / 1000)).padStart(2, "0")}`);
    };
    tick();
    const timer = window.setInterval(tick, 1000);
    return () => window.clearInterval(timer);
  }, [offer]);

  const renew = async () => {
    setState("minting");
    try {
      const code = await startPairing();
      announcing.current = true;
      try { announceFromRelay(code); } finally { announcing.current = false; }
      again();
    } catch (reason) {
      setOffer(null);
      setFailure(failureText(reason));
      setState("failed");
    }
  };

  const countdown = (
    <>
      {state === "live" && t("Expires in {time}.", { time: left })}
      {state === "expired" && t("This code expired.")}
      {state === "minting" && t("Getting a code…")}
    </>
  );
  // the id a phone shows when a link carries another key: compared here, on the PC itself
  const serverId = offer !== null ? decodeOffer(offer.url)?.server_id ?? null : null;
  const pcId = serverId !== null && (
    <div className="relay-pairing-id">
      <p className="settings-description">{t("This PC's ID")}</p>
      <KeyId id={serverId} label={t("This PC's ID")} />
    </div>
  );
  const newCode = <button type="button" className="btn" disabled={state === "minting"} onClick={() => void renew()}><RefreshCw aria-hidden="true" />{t("New code")}</button>;
  // on the phone itself: the link to send to the other device, and its QR code only once asked for
  if (phone) return (
    <div className="relay-pairing-phone" role="status">
      <p className="settings-label">{t("Connect another device")}</p>
      <p className="settings-description">{t("Send it this link, or show it the QR code. It opens Ovis there and pairs it with this PC.")} {countdown}</p>
      {state === "failed" && failure !== null && <p className="settings-hint relay-error" role="alert">{failure}</p>}
      {offer !== null && <ShareLink url={offer.url} copyLabel={t("Copy link")}>{newCode}</ShareLink>}
      {offer === null && <div className="phone-actions">{newCode}</div>}
      {offer !== null && <QrReveal value={offer.url} label={t("QR code that pairs a phone through the relay")} hint={t("Scan it with the other device's camera.")} />}
      {pcId}
    </div>
  );
  return (
    <div className="settings-item relay-pairing" role="status">
      {offer !== null && <QrCode value={offer.url} label={t("QR code that pairs a phone through the relay")} />}
      <div className="relay-pairing-text">
        <p className="settings-label">{t("Scan it with the phone's camera")}</p>
        <p className="settings-description">
          {t("It opens Ovis on the phone and pairs it with this PC.")}{" "}
          {state === "live" && t("Expires in {time}.", { time: left })}
          {state === "expired" && t("This code expired.")}
          {state === "minting" && t("Getting a code…")}
        </p>
        {state === "failed" && failure !== null && <p className="settings-hint relay-error" role="alert">{failure}</p>}
        <div className="phone-actions">
          <button type="button" className="btn" disabled={state === "minting"} onClick={() => void renew()}><RefreshCw aria-hidden="true" />{t("New code")}</button>
        </div>
        {pcId}
      </div>
    </div>
  );
}
