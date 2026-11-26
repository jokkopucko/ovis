import { useEffect, useRef, useState } from "react";
import { Keyboard, Link2, RefreshCw } from "lucide-react";

import "./RelayPanel.css";

import { copyText } from "../lib/clipboard.ts";
import { ApiError, cancelRelayCode, endPairing, requestRelayCode, requestRelayLink, requestRelayOffer, startPairing, type RelayCode, type RelayOffer } from "../lib/api.ts";
import { t, useT } from "../lib/i18n.ts";
import { callNative, hasNativePlugin } from "../lib/nativeApp.ts";
import { announcePairingCode, PAIRING_CODE_EVENT, QR_CODE_ENDED_CHANNEL, tellOtherWindowsQrCodeEnded, type AnnouncedCode, type RelayState } from "../lib/useRelay.ts";
import type { RelayStatus } from "../../shared/protocol.ts";
import { decodeOffer } from "../../shared/relay-offer.ts";
import { QrReveal, ShareLink } from "./PhonePanel.tsx";
import { KeyId } from "./KeyId.tsx";
import { QrCode } from "./QrCode.tsx";
import { CompactPair } from "./CompactPair.tsx";
import { SettingsRow, Toggle } from "./SettingsControls.tsx";

export const failureText = (error: unknown): string => error instanceof ApiError
  // a machine pairs no device by a code that names no account
  ? error.code === "machine_profile" ? t("Run ovis add on this machine, then scan its QR code with a signed-in device.") : error.detail
  : error instanceof Error ? error.message : String(error);

export function statusText(t: ReturnType<typeof useT>, status: RelayStatus): string {
  if (status.blocked === "serve_only") return t("Blocked: OVIS_TAILSCALE_SERVE_ONLY says tailscale serve is the only way in. Unset it on this PC and restart the app.");
  if (status.blocked === "identity_unreadable") return t("Blocked: this PC's relay identity cannot be read. Reset it under More settings in Devices and PCs to use the relay again.");
  const pass = status.pass;
  if (pass?.refused && status.phase === "error" && pass.state !== "ok") return pass.state === "not_listed"
    ? t("Add this PC to your Ovis account to use the Ovis relay, or connect over the same Wi-Fi or Tailscale.")
    : pass.state === "limit"
    ? t("This account has as many PCs on the Ovis relay as it may. Remove one from your account to add this one.")
    : pass.state === "unavailable"
      ? t("Cannot reach the Ovis account service for a relay pass. Retrying.")
      : t("The Ovis relay needs an Ovis account. Sign in, or connect over the same Wi-Fi or Tailscale.");
  if (pass && status.phase === "online" && pass.state !== "ok" && pass.relay !== null && pass.relay !== "ok" && pass.enforce_at !== null) {
    return t("Online. Sign in to keep using the Ovis relay after {date}. Same Wi-Fi, Tailscale and your own relay keep working without an account.", { date: new Date(pass.enforce_at).toLocaleDateString() });
  }
  switch (status.phase) {
    case "off": return t("Off. Nothing goes through the relay.");
    case "connecting": return t("Connecting…");
    case "online":
      return status.sessions === 0 ? t("Online. No phone connected.") : status.sessions === 1 ? t("Online. 1 phone connected.") : t("Online. {n} phones connected.", { n: status.sessions });
    default: return t("Error: {message}", { message: status.error ?? t("Could not reach the relay.") });
  }
}

/**
 * In the app it opens as one more PC of the app's list (HerdrShell.open, labelled with the offer's
 * name); in a browser this tab goes to the hosted shell, which pairs the phone and keeps its key there.
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

/**
 * Settings → Devices and PCs → More settings → Devices and access, in sight while the relay is on: whether a device on
 * the relay moves to a direct carrier, on this PC's home network or Tailscale address (docs/relay.md, "Direct on the
 * same network"); off unless turned on, so a relay connection stays on the relay. Its line says on is a listener on
 * those addresses; it is found by the networks' names whichever line shows. The switch only where the relay can be
 * changed from (a direct connection by someone who drives this PC).
 */
export function RelayDirectRow({ relay, readOnly }: { relay: RelayState; readOnly: boolean }) {
  const t = useT();
  const [failure, setFailure] = useState<string | null>(null);
  const direct = relay.status?.direct;
  if (direct === undefined || relay.status?.phase === "off") return null;
  const change = (on: boolean) => {
    setFailure(null);
    relay.request({ direct: on }).catch((reason: unknown) => setFailure(failureText(reason)));
  };
  return (
    <SettingsRow label={t("Direct connection")} keywords={`Wi-Fi Tailscale LAN ${t("Same Wi-Fi, home network, local network")}`} description={<>
      {direct.on ? t("The Ovis app on a phone that reaches this PC on the same Wi-Fi or over Tailscale moves to a direct connection: faster, and this PC listens for it on those addresses.")
        : t("Relay connections stay on the relay.")}
      {failure !== null && <span className="settings-hint relay-error" role="alert">{failure}</span>}
    </>}>
      {!readOnly && <Toggle label={t("Direct connection")} checked={direct.on} disabled={relay.pending} onChange={change} />}
    </SettingsRow>
  );
}

let relayAnnouncing = false;

/**
 * The relay tab's QR codes on this page (RelayPairing `qrOnly`), each as what it does when another relay QR code has
 * a code: it asks for its own again. They are called with the code of an offer that is not the relay tab's whenever
 * that code will not be announced: its QR code came down for the relay tab's code (the code it showed, or one that
 * reaches it afterwards), is gone, or has asked again since. The PC may have started that code after the relay
 * tab's, which it then ended, whatever order the answers came in. Only the PC knows, and the relay tab's offer,
 * asked for again, carries the code the PC has: the same one, or a new one.
 */
const relayTabQrCodes = new Set<(code: string | undefined) => void>();
function askRelayTabQrCodes(code: string | undefined): void {
  for (const askAgain of [...relayTabQrCodes]) askAgain(code);
}
function announceFromRelay(code: AnnouncedCode): void {
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
 * answering each other. The code of a QR code shown alone (`qrOnly`) is the exception: no other offer
 * carries it, so when one is announced this QR code comes down (This code expired, New code) instead
 * of asking again.
 * `qrOnly`: the QR code alone, with New code. No code to type is asked for (`POST /api/relay/code` is never sent), so
 * nothing on the screen can be read and typed on another device: the relay tab's account QR code, which puts a PC in
 * the account of whoever redeems it (ConnectPhoneDialog `AccountQr`). Its offer says so to the PC
 * (`x-ovis-no-account-only`), which makes it only while it is in no account, with a code of its own that no other
 * place started; New code ends that code and asks again. `onInAccount`: the PC refused the offer for its account: it is
 * in one by now, or none is named for it.
 */
export function RelayPairing({ phone = false, compact = false, qrOnly = false, onInAccount, onOffer }: { phone?: boolean; compact?: boolean; qrOnly?: boolean; onInAccount?: () => void; onOffer?: (offer: RelayOffer) => void }) {
  const t = useT();
  const [offer, setOffer] = useState<RelayOffer | null>(null);
  const [left, setLeft] = useState("");
  const [state, setState] = useState<"minting" | "live" | "expired" | "failed">("minting");
  const [failure, setFailure] = useState<string | null>(null);
  const [generation, setGeneration] = useState(0);
  const announcing = useRef(false);
  const shown = useRef<string | null>(null);
  const quiet = useRef(false);
  const heard = useRef<string | null>(null);
  // how often the relay tab's code was announced to this QR code, which is not the relay tab's: each time took it
  // down, and an offer asked for at one count and answered at another was overtaken by the relay tab's code
  const taken = useRef(0);
  const again = () => setGeneration((value) => value + 1);
  const refused = useRef(onInAccount);
  refused.current = onInAccount;
  const drawn = useRef(onOffer);
  drawn.current = onOffer;
  // a six-digit code started anywhere else ends the typed code on the PC (server/relay/pair-code.ts): its words go too
  const [typedReset, setTypedReset] = useState(0);
  const [typedId, setTypedId] = useState<string | null>(null);
  const dropTyped = () => setTypedReset((value) => value + 1);

  useEffect(() => {
    // Asked for together, a new six-digit code the offer starts ends the code being minted on the PC.
    if (compact && !qrOnly && generation === 0) return;
    let cancelled = false;
    let finishing: number | undefined;
    const asked = taken.current;
    const silent = quiet.current;
    quiet.current = false;
    setState("minting");
    requestRelayOffer({ noAccountOnly: qrOnly }).then((next) => {
      // An answer nobody waits for (this QR code is gone, or has asked again since), or one the relay tab's code
      // overtook by taking this QR code down while the offer was out: it shows nothing and changes nothing here. An
      // offer that is not the relay tab's may have ended the relay tab's code on the PC all the same, so the relay
      // tab's QR codes on the page ask for their own again (relayTabQrCodes). The relay tab's own offer never ends
      // the relay tab's code, and asking for it again on each such answer would never end
      if (cancelled || asked !== taken.current) {
        if (!qrOnly) askRelayTabQrCodes(decodeOffer(next.url)?.code);
        return;
      }
      setOffer(next);
      drawn.current?.(next);
      setState("live");
      const code = decodeOffer(next.url)?.code;
      const differs = qrOnly && code !== heard.current;
      shown.current = code ?? null;
      if (code !== undefined && (!silent || differs)) {
        announcing.current = true;
        try { announceFromRelay({ code, expires_at: next.expires_at, ...(qrOnly ? { qrOnly: true } : {}) }); } finally { announcing.current = false; }
      }
    }, (reason: unknown) => {
      // nobody waits for it, or it was overtaken, as above: nothing to show
      if (cancelled || asked !== taken.current) return;
      setOffer(null);
      // a device that paired with the code as it ran out may still link, and a new code would end its pairing: this QR
      // code goes on getting one, and asks again once the time the PC named is over
      if (qrOnly && reason instanceof ApiError && reason.code === "pairing_finishing") {
        // fixed wait: the device's time to link, as the PC named it (retry-after)
        finishing = window.setTimeout(again, reason.retryAfterMs ?? 1000);
        return;
      }
      if (reason instanceof ApiError && (reason.code === "in_account" || reason.code === "no_account_named") && refused.current !== undefined) {
        refused.current();
        return;
      }
      setFailure(failureText(reason));
      setState("failed");
    });
    return () => { cancelled = true; window.clearTimeout(finishing); };
  }, [generation, qrOnly]);

  // a window of this browser ended the code this QR code shows (they share the PC's one pending code): a new one
  useEffect(() => {
    if (!qrOnly || typeof BroadcastChannel === "undefined") return;
    const channel = new BroadcastChannel(QR_CODE_ENDED_CHANNEL);
    channel.onmessage = (event: MessageEvent<unknown>) => {
      if (event.data !== shown.current) return;
      shown.current = null;
      setOffer(null);
      again();
    };
    return () => channel.close();
  }, [qrOnly]);

  useEffect(() => {
    // another relay QR code has the code `code`: this one asks for the offer again, quietly, unless it shows that code
    const follow = (code: string | undefined) => {
      heard.current = code ?? null;
      if (code === undefined || code !== shown.current) { quiet.current = true; again(); }
    };
    const onCode = (event: Event) => {
      if (announcing.current) return;
      dropTyped();
      const announced = (event as CustomEvent<AnnouncedCode | undefined>).detail;
      if (relayAnnouncing) {
        // the relay tab's QR code has a code of its own, which replaced the PC's one pending code: the code this QR
        // code showed is gone, and an offer asked for now would start another code, which ends the relay tab's. So
        // it comes down, as the digits do (ConnectPhoneDialog CodeRoute), until New code asks for one. An offer it
        // has out is overtaken with it (`taken`), and for a code it showed the relay tab's QR code asks again
        if (!qrOnly && announced?.qrOnly === true) {
          const had = shown.current;
          taken.current += 1;
          shown.current = null;
          setOffer(null);
          setState("expired");
          if (had !== null) askRelayTabQrCodes(had);
          return;
        }
        follow(announced?.code);
        return;
      }
      again();
    };
    window.addEventListener(PAIRING_CODE_EVENT, onCode);
    if (qrOnly) relayTabQrCodes.add(follow);
    return () => {
      window.removeEventListener(PAIRING_CODE_EVENT, onCode);
      relayTabQrCodes.delete(follow);
    };
  }, [qrOnly]);

  useEffect(() => {
    if (offer === null) return;
    let wasLive = false;
    const tick = () => {
      const ms = Date.parse(offer.expires_at) - Date.now();
      if (ms <= 0) {
        setOffer(null);
        // a code that ran out while shown is replaced by itself; one that arrived already expired
        // (the PC's clock and this one apart) is not, or the asking would never end
        if (wasLive) { if (!compact || qrOnly) again(); } else setState("expired");
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
    dropTyped();
    if (qrOnly) {
      // the PC keeps this QR code's own code until it ends: ended here, the offer asked for next carries a new one.
      // No code is started the way the Devices group starts one, which the PC would make on a PC in an account too
      try {
        const ended = shown.current;
        if (ended !== null && (await endPairing(ended)).cancelled) tellOtherWindowsQrCodeEnded(ended);
        again();
      } catch (reason) {
        setOffer(null);
        setFailure(t("The old code could not be ended, so it may still work until it runs out: {message} New code tries again.", { message: failureText(reason) }));
        setState("failed");
      }
      return;
    }
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

  if (qrOnly) return (
    <div className="relay-pairing-compact relay-pairing-qr-only" role="status">
      <div className="compact-pair">
        {offer !== null ? <QrCode value={offer.url} label={t("QR code that pairs a phone through the relay")} size={132} /> : <div className="compact-pair-qr-empty" role="status">{state === "minting" ? t("Getting a code…") : ""}</div>}
        <div className="compact-pair-side">
          <p className="settings-description">
            {state === "live" && t("Expires in {time}.", { time: left })}
            {state === "expired" && t("This code expired.")}
          </p>
          <div className="compact-pair-actions">
            <button type="button" className="btn" disabled={state === "minting"} aria-busy={state === "minting" || undefined} onClick={() => void renew()}><RefreshCw aria-hidden="true" />{t("New code")}</button>
          </div>
        </div>
      </div>
      {state === "failed" && failure !== null && <p className="settings-hint relay-error" role="alert">{failure}</p>}
    </div>
  );
  if (compact) return <CompactRelay qr={offer?.url ?? null} qrExpires={offer?.expires_at ?? null} failure={state === "failed" ? failure : null} reset={typedReset} onMinted={again} />;
  const countdown = (
    <>
      {state === "live" && t("Expires in {time}.", { time: left })}
      {state === "expired" && t("This code expired.")}
      {state === "minting" && t("Getting a code…")}
    </>
  );
  // the id a phone shows when a link carries another key: compared here, on the PC itself
  // the typed code names the PC too, so its ID stays to compare with while the QR offer is being fetched again
  const offerId = offer === null ? undefined : decodeOffer(offer.url)?.server_id;
  const serverId = offerId ?? typedId;
  const pcId = serverId !== null && <ThisPcId id={serverId} />;
  const newCode = <button type="button" className="btn" disabled={state === "minting"} onClick={() => void renew()}><RefreshCw aria-hidden="true" />{t("New code")}</button>;
  if (phone) return (
    <div className="relay-pairing-phone" role="status">
      <p className="settings-label">{t("Connect another device")}</p>
      <p className="settings-description">{t("Send it this link, or show it the QR code. It opens Ovis there and pairs it with this PC.")} {countdown}</p>
      {state === "failed" && failure !== null && <p className="settings-hint relay-error" role="alert">{failure}</p>}
      {offer !== null && <ShareLink url={offer.url} copyLabel={t("Copy link")}>{newCode}</ShareLink>}
      {offer === null && <div className="phone-actions">{newCode}</div>}
      {offer !== null && <QrReveal value={offer.url} label={t("QR code that pairs a phone through the relay")} hint={t("Scan it with the other device's camera.")} />}
      <TypedCode reset={typedReset} onMinted={(minted) => { setTypedId(minted.server_id); again(); }} />
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
        <CodelessLink />
        <TypedCode reset={typedReset} onMinted={(minted) => { setTypedId(minted.server_id); again(); }} />
        {pcId}
      </div>
    </div>
  );
}

/**
 * The relay's two ways in Connect a device: its QR code (`qr`, the pending offer) and a code to type on the
 * other device, asked for as the dialog opens, again on Refresh, and again when either runs out while shown:
 * one renewal for both, the code first. Asking for one starts a new six-digit code, so the offer is asked for
 * only after it (`onMinted`), never beside it. A code is never kept for the next opening: one looked up by a
 * device is spent even when its person cancels at the ID comparison, and nothing here would know. A six-digit code started anywhere
 * else ends this one on the PC (`reset`): it goes, and Refresh asks for another, never on its own, or the two
 * would keep ending each other.
 */
export function CompactRelay({ qr, qrExpires, failure, reset, onMinted }: { qr: string | null; qrExpires: string | null; failure: string | null; reset: number; onMinted: () => void }) {
  const t = useT();
  const [code, setCode] = useState<RelayCode | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const request = useRef(0);
  const mint = async () => {
    const mine = ++request.current;
    setBusy(true);
    setError(null);
    try {
      const minted = await requestRelayCode();
      if (mine !== request.current) return;
      setCode(minted);
    } catch (reason) {
      if (mine === request.current) { setCode(null); setError(failureText(reason)); }
    } finally {
      if (mine === request.current) {
        setBusy(false);
        onMinted();
      }
    }
  };
  const opened = useRef(false);
  useEffect(() => {
    if (opened.current) return;
    opened.current = true;
    void mint();
  });
  const lastReset = useRef(reset);
  useEffect(() => {
    if (lastReset.current === reset) return;
    lastReset.current = reset;
    request.current++;
    setCode(null);
    setBusy(false);
  }, [reset]);
  const deadline = code !== null ? code.expires_at : qrExpires;
  useEffect(() => {
    if (deadline === null) return;
    const ms = Date.parse(deadline) - Date.now();
    // one that arrived already expired (the PC's clock and this one apart) says so and waits for Refresh,
    // rather than asking again and again; one that ran out while shown is renewed
    if (ms <= 0) {
      if (code !== null) { setCode(null); setError(t("This code expired.")); }
      return;
    }
    const timer = window.setTimeout(() => void mint(), ms);
    return () => window.clearTimeout(timer);
  }, [code, deadline]);
  // Refresh can return a new code while the QR still carries the previous identity.
  const serverId = code?.server_id ?? (qr === null ? undefined : decodeOffer(qr)?.server_id) ?? null;
  return (
    <div className="relay-pairing-compact" role="status">
      <CompactPair qr={qr} qrLabel={t("QR code that pairs a phone through the relay")} code={code?.code ?? null} codeLabel={t("Code to type")} busy={busy} onRefresh={() => void mint()} />
      {serverId !== null && <ThisPcId id={serverId} />}
      {(error ?? failure) !== null && <p className="settings-hint relay-error" role="alert">{error ?? failure}</p>}
    </div>
  );
}

function ThisPcId({ id }: { id: string }) {
  const t = useT();
  return (
    <div className="relay-pairing-id">
      <p className="settings-description">{t("This PC's ID")}</p>
      <KeyId id={id} label={t("This PC's ID")} />
    </div>
  );
}

/**
 * It starts a new six-digit code, so the QR code above is asked for again (`onMinted`). The other
 * device then shows this PC's ID to compare with the one below.
 */
function TypedCode({ reset, onMinted }: { reset: number; onMinted: (code: RelayCode) => void }) {
  const t = useT();
  const [code, setCode] = useState<RelayCode | null>(null);
  const request = useRef(0);
  // one Show or Hide at a time: their requests could reach the PC out of order
  const [busy, setBusy] = useState(false);
  useEffect(() => { request.current++; setCode(null); }, [reset]);
  const [failure, setFailure] = useState<string | null>(null);
  const [left, setLeft] = useState("");
  useEffect(() => {
    if (code === null) return;
    const tick = () => {
      const ms = Date.parse(code.expires_at) - Date.now();
      if (ms <= 0) { setCode(null); return; }
      setLeft(`${Math.floor(ms / 60_000)}:${String(Math.floor((ms % 60_000) / 1000)).padStart(2, "0")}`);
    };
    tick();
    const timer = window.setInterval(tick, 1000);
    return () => window.clearInterval(timer);
  }, [code]);
  const show = async () => {
    const mine = ++request.current;
    setFailure(null);
    setBusy(true);
    try {
      const minted = await requestRelayCode();
      if (mine !== request.current) return;
      setCode(minted);
      onMinted(minted);
    } catch (reason) {
      if (mine !== request.current) return;
      setCode(null);
      setFailure(failureText(reason));
    } finally { setBusy(false); }
  };
  const hide = async () => {
    const mine = ++request.current;
    setFailure(null);
    setBusy(true);
    try {
      await cancelRelayCode();
      if (mine === request.current) setCode(null);
    } catch (reason) {
      // the code may still work on the relay: it stays on screen, with why it did not go
      if (mine === request.current) setFailure(failureText(reason));
    } finally { setBusy(false); }
  };
  return (
    <>
      <div className="phone-actions">
        <button type="button" className="btn" disabled={busy} onClick={() => void show()}><Keyboard aria-hidden="true" />{code === null ? t("Show a code to type") : t("New code to type")}</button>
        {code !== null && <button type="button" className="btn" disabled={busy} onClick={() => void hide()}>{t("Hide the code")}</button>}
      </div>
      {code !== null && (
        <div className="relay-typed-code" role="status">
          <p className="relay-typed-code-value" aria-label={t("Code to type")}>{code.code}</p>
          <p className="settings-hint">{t("On the other device, open app.ovis.sh, choose Pair with a code and type it. Expires in {time}. It works once.", { time: left })}</p>
          <p className="settings-hint">{t("That device then shows an ID: pair only if it matches this PC's ID below, every group.")}</p>
        </div>
      )}
      {failure !== null && <p className="settings-hint relay-error" role="alert">{failure}</p>}
    </>
  );
}

/**
 * No camera: a link without a code, sent to the phone any way at all. It holds nothing secret, so
 * the phone that opens it and this PC show six digits to compare, and the owner approves the
 * phone here (RelayPairingPrompt).
 */
function CodelessLink() {
  const t = useT();
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [link, setLink] = useState<{ url: string; select: boolean } | null>(null);
  const linkRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (link?.select && linkRef.current) window.getSelection()?.selectAllChildren(linkRef.current);
  }, [link]);
  const copy = async () => {
    const initiator = document.activeElement;
    try {
      const { url } = await requestRelayLink();
      // where the browser refuses the clipboard (plain http on the LAN), the link stays on screen, selected once drawn
      if (await copyText(url)) { setLink(null); setNote({ ok: true, text: t("Copied. Open it on the phone within 10 minutes: both screens show six digits to compare, and you approve the phone here.") }); }
      else { setLink({ url, select: document.activeElement === initiator }); setNote(null); }
    } catch (reason) { setNote({ ok: false, text: failureText(reason) }); }
  };
  return (
    <>
      <div className="phone-actions">
        <button type="button" className="btn" onClick={() => void copy()}><Link2 aria-hidden="true" />{t("Copy a link without a code")}</button>
      </div>
      {link !== null && <code className="settings-hint relay-codeless-link" ref={linkRef}>{link.url}</code>}
      {note !== null && <p className={note.ok ? "settings-hint" : "settings-hint relay-error"} role={note.ok ? "status" : "alert"}>{note.text}</p>}
    </>
  );
}
