import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { ChevronRight, RefreshCw, X } from "lucide-react";

import "./ConnectPhoneDialog.css";
import "./DevicesPanel.css";

import { requestRelayOffer, startPairing } from "../lib/api.ts";
import { copyText } from "../lib/clipboard.ts";
import { useT } from "../lib/i18n.ts";
import type { PhonePlan } from "../lib/phone.ts";
import { useMediaQuery } from "../lib/useMediaQuery.ts";
import { usePhoneSheetBack } from "../lib/sheetHistory.ts";
import { useSheetSwipe } from "../lib/sheets.ts";
import { nativeModalOver, useFocusTrap } from "../lib/useFocusTrap.ts";
import { announcePairingCode, inRelayShell, PAIRING_CODE_EVENT, type RelayState } from "../lib/useRelay.ts";
import type { PairedDevice, PairingCode } from "../../shared/protocol.ts";
import { ConfirmDialog } from "./ConfirmDialog.tsx";
import { PhonePanel, QrReveal, ShareLink } from "./PhonePanel.tsx";
import { QrCode } from "./QrCode.tsx";
import { failureText, openOwnOffer, RelayPairing, statusText } from "./RelayPanel.tsx";
import { SettingsQuery, Toggle } from "./SettingsControls.tsx";
import { AddRelayPc } from "./AddRelayPc.tsx";
import { TailnetPcs } from "./TailnetPcs.tsx";
import { PortalPanel } from "./PortalPanel.tsx";
import { usePortal } from "../lib/portal.ts";
import { CompactPair } from "./CompactPair.tsx";

export type ConnectRoute = "relay" | "tailscale" | "code";

/** the dialog open on a phone: a touch screen, or a window as narrow as one */
const PHONE_QUERY = "(pointer: coarse), (max-width: 768px)";

/**
 * The label of a device paired through the relay under this phone's own name, for a quiet hint.
 * A name is no proof (two iPhones share one, and any device can be renamed), so it never stands in
 * for the phone's pairing: the relay key is the hosted shell's, out of this page's reach.
 */
export function sameNameRelayDevice(devices: readonly PairedDevice[], label: string): string | null {
  return devices.find((device) => device.via_relay === true && !device.current && device.label === label)?.label ?? null;
}

/** whether the relay can be offered here at all: a server with the route, a direct page, not the hosted shell */
export const relayOffered = (relay: RelayState): boolean => !relay.unsupported && relay.status !== null && !inRelayShell();

/** Tailscale already gives a phone an address for this PC */
const tailscaleWorks = (plan: PhonePlan): boolean => plan.kind === "here" || plan.kind === "served";

/** the relay is on: connecting or online, nothing blocking it */
const relayOn = (relay: RelayState): boolean => relay.status !== null && relay.status.blocked === null && relay.status.phase !== "off";

/**
 * The way the dialog opens on: the relay whenever it is offered, since it needs nothing installed,
 * except when it is off and Tailscale already works; then Tailscale, with the relay's switch on its
 * choice so it can be turned on right there.
 */
export function defaultRoute(plan: PhonePlan, relay: RelayState): ConnectRoute {
  // in the hosted shell the phone is on the relay already: its card says so and points to the pairing code
  if (inRelayShell() && !relay.unsupported && relay.status !== null) return "relay";
  if (!relayOffered(relay)) return "tailscale";
  return !relayOn(relay) && tailscaleWorks(plan) ? "tailscale" : "relay";
}

export interface ConnectPhoneDialogProps {
  plan: PhonePlan;
  loading: boolean;
  onRefresh: () => void;
  /** an address a phone can open now, for the pairing code's QR code; null shows the code alone */
  pairUrl: string | null;
  relay: RelayState;
  /** a watching device or a Portal visitor: it reads, and starts nothing */
  readOnly: boolean;
  /** turning the relay on closes the open device gate */
  closesGate: boolean;
  /** a Portal visitor may not start pairing codes (the server refuses it) */
  canPair: boolean;
  /**
   * Signed in, with this PC in that account and its relay on: a new device joins by signing in to the
   * same account, and a device already in it approves it once by picking the matching number
   * (AccountApprovals, docs/account.md "Who may admit a device"). No code is shown until asked for.
   */
  joinBySignIn: boolean;
  /** signed out where the account is offered: a line that says signing in skips the code, and its button */
  onSignIn: (() => void) | null;
  /** SSH, for a PC without Ovis: the Add PC dialog */
  onAddPcSsh: (() => void) | null;
  onClose: () => void;
}

type OtherWay = "wifi" | "tailscale" | "portal" | "typed";

/**
 * Settings → Devices and PCs → Connect a device, as WhatsApp's Link a device: one way first, the rest folded.
 * Signed in (`joinBySignIn`), the new device signs in to the same account and is approved once on a device
 * already in it, so no code shows until Connect with a code. Otherwise the Ovis relay's QR code and the code
 * to type sit side by side with Refresh and Copy; a PC's own Ovis or a phone takes either, and which one typed
 * it decides what it becomes (a PC shows its workspaces on both, a phone or browser uses this PC). Other ways
 * holds the rest, one line each: the same Wi-Fi's six-digit code, Tailscale, SSH for a PC without Ovis, Portal.
 * A code another device shows is typed here too (Enter a code from another device). This PC's ID is not
 * shown here: it is atop My devices, where the device that typed a code is told to compare it.
 */
export function ConnectPhoneDialog({ plan, loading, onRefresh, pairUrl, relay, readOnly, closesGate, canPair, joinBySignIn, onSignIn, onAddPcSsh, onClose }: ConnectPhoneDialogProps) {
  const t = useT();
  const id = useId();
  const surface = useFocusTrap<HTMLDivElement>(true);
  useSheetSwipe(surface, onClose);
  // it stays up under the relay identity's confirmation, which Back or its own close then leaves for it
  usePhoneSheetBack(() => { onClose(); }, true, true);
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      // gone from the page (a pairing closed it): its listener goes a moment later, and the key is Settings'
      if (surface.current === null) return;
      if (event.key !== "Escape" || event.isComposing || nativeModalOver(surface.current)) return;
      // an approval or a confirmation opened over this dialog takes its own Escape
      if (document.querySelector('[role="alertdialog"]') !== null) return;
      event.stopPropagation();
      event.preventDefault();
      onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose, surface]);

  const phone = useMediaQuery(PHONE_QUERY);
  const offered = relayOffered(relay);
  // a phone on the relay keeps the relay's card: it says where relay links come from, and points to the pairing code
  const onRelay = inRelayShell() && !relay.unsupported && relay.status !== null;
  const [withCode, setWithCode] = useState(false);
  const signInFirst = joinBySignIn && !withCode;
  const [open, setOpen] = useState<OtherWay | null>(null);
  // a way once opened stays mounted while the dialog is: opening Same Wi-Fi again keeps its code, not a new one
  const opened = useRef(new Set<OtherWay>());
  if (open !== null) opened.current.add(open);
  const toggle = (way: OtherWay) => setOpen((current) => (current === way ? null : way));
  // the relay's one switch, for the PC's owner where nothing blocks it, while it is not online
  const switchable = offered && !readOnly && relay.status?.blocked === null;
  const [switchError, setSwitchError] = useState<string | null>(null);
  const on = relayOn(relay);
  useEffect(() => { if (on) setSwitchError(null); }, [on]);
  const switchRelay = async (next: boolean) => {
    setSwitchError(null);
    try { await relay.request(next ? "start" : "stop"); } catch (reason) { setSwitchError(failureText(reason)); }
  };
  const { status: portal } = usePortal();
  // without the relay the same Wi-Fi's code is the first way, not one of the others
  const wifiFirst = !offered && !onRelay && canPair && !readOnly;

  const otherWays: { way: OtherWay; label: string; body: ReactNode }[] = [
    ...(canPair && !readOnly && !wifiFirst ? [{ way: "wifi" as const, label: t("Same Wi-Fi"), body: <CodeRoute pairUrl={inRelayShell() ? null : pairUrl} startAtOnce phone={phone} compact /> }] : []),
    { way: "tailscale", label: "Tailscale", body: <PhonePanel plan={plan} loading={loading} onRefresh={onRefresh} phone={phone} /> },
    ...(portal?.supported ? [{ way: "portal" as const, label: "Portal", body: <PortalPanel readOnly={readOnly} /> }] : []),
  ];

  return createPortal(
    // a Settings search hides no row in here
    <SettingsQuery.Provider value={[]}>
    <div className="modal-scrim" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div ref={surface} className="modal connect-phone-dialog" role="dialog" aria-modal="true" aria-labelledby={`${id}-title`} tabIndex={-1}>
        <header className="modal-header">
          <h2 className="modal-title" id={`${id}-title`}>{t("Connect a device")}</h2>
          <button type="button" className="icon-button" aria-label={t("Close")} onClick={onClose}><X aria-hidden="true" /></button>
        </header>
        <div className="modal-body connect-phone-body">
          {signInFirst ? (
            <div className="connect-signin" data-testid="connect-signin">
              <p className="connect-signin-lead">{t("On the new device, open Ovis and sign in with GitHub.")}</p>
              <p className="settings-hint">{t("Then approve it once on a device already in your account.")}</p>
              <button type="button" className="btn btn-ghost connect-link" onClick={() => setWithCode(true)}>{t("Connect with a code (no sign-in)")}</button>
            </div>
          ) : (
            <>
              {joinBySignIn && <button type="button" className="btn btn-ghost connect-link" onClick={() => setWithCode(false)}>{t("Connect by signing in")}</button>}
              {!joinBySignIn && onSignIn !== null && !readOnly && (
                <div className="connect-signin-nudge">
                  <span>{t("Sign in with GitHub to connect without a code.")}</span>
                  <button type="button" className="btn" onClick={onSignIn}>{t("Sign in")}</button>
                </div>
              )}
              {switchable && !on && (
                <div className="connect-relay-switch">
                  <span className="settings-label">{t("Ovis relay")}</span>
                  <Toggle label={t("Ovis relay")} checked={on} describedBy={closesGate ? `${id}-gate` : undefined} onChange={(next) => { if (!relay.pending) void switchRelay(next); }} />
                </div>
              )}
              {switchable && !on && closesGate && <p className="settings-condition connect-phone-gate" id={`${id}-gate`}>{t("Turning on the relay closes the device gate: a new browser then needs a pairing code or the access token.")}</p>}
              {switchError !== null && <p className="settings-hint relay-error" role="alert">{switchError}</p>}
              {(offered || onRelay) && <RelayRoute relay={relay} readOnly={readOnly} phone={phone} onUseCode={canPair && !readOnly ? () => setOpen("wifi") : undefined} compact />}
              {wifiFirst && <CodeRoute pairUrl={pairUrl} startAtOnce phone={phone} compact />}
              {!offered && !onRelay && (!canPair || readOnly) && <PhonePanel plan={plan} loading={loading} onRefresh={onRefresh} phone={phone} />}
            </>
          )}
          {!readOnly && !inRelayShell() && (
            <div className="connect-way-item">
              <button type="button" className="btn btn-ghost connect-link" aria-expanded={open === "typed"} onClick={() => toggle("typed")}>{t("Enter a code from another device")}</button>
              {open === "typed" && <div className="settings-card connect-typed"><AddRelayPc /></div>}
            </div>
          )}
          {!readOnly && !inRelayShell() && <TailnetPcs />}
          <details className="settings-details connect-other" open={open !== null && open !== "typed" ? true : undefined}>
            <summary><span className="settings-details-toggle">{t("Other ways to connect")}</span></summary>
            <div className="connect-ways">
              {otherWays.map(({ way, label, body }) => (
                <div key={way} className="connect-way-item">
                  <button type="button" className="connect-way" aria-expanded={open === way} onClick={() => toggle(way)}>
                    <span>{label}</span><ChevronRight className="connect-way-chevron" aria-hidden="true" />
                  </button>
                  {opened.current.has(way) && <div className="connect-way-body" hidden={open !== way}>{body}</div>}
                </div>
              ))}
              {onAddPcSsh !== null && !readOnly && (
                <div className="connect-way-item">
                  <button type="button" className="connect-way" onClick={onAddPcSsh}><span>{t("Add a PC over SSH")}</span><ChevronRight className="connect-way-chevron" aria-hidden="true" /></button>
                </div>
              )}
            </div>
          </details>
        </div>
      </div>
    </div>
    </SettingsQuery.Provider>,
    document.body,
  );
}

/**
 * The relay's way: its state (Blocked says why), a start that failed with Try again, the pairing QR
 * code once it is online, and the identity reset as a quiet last action. The switch is on its card.
 * On a phone, online, the phone pairs itself through its own offer in one tap, and the offer for
 * another device is a link to send, its QR code behind Show QR code. A device on the relay is told
 * that relay links come from the PC or a direct connection (the server refuses them over the relay)
 * and pointed to the pairing code.
 */
export function RelayRoute({ relay, readOnly, phone = false, pairHere = false, sameName = null, onUseCode, compact = false }: {
  relay: RelayState;
  /** Connect a device: the state only while it is not online, the QR code beside the code to type, no reset (More settings has it) */
  compact?: boolean;
  readOnly: boolean;
  phone?: boolean;
  /** a touch phone: Use the relay on this phone */
  pairHere?: boolean;
  /** a relay device under this phone's name: a hint, never proof that this phone is paired */
  sameName?: string | null;
  onUseCode?: () => void;
}) {
  const t = useT();
  const { status, pending, request } = relay;
  const [error, setError] = useState<string | null>(null);
  const [confirmingReset, setConfirmingReset] = useState(false);
  const [opening, setOpening] = useState(false);
  const resetButton = useRef<HTMLButtonElement>(null);
  if (status === null) return null;
  if (inRelayShell()) return (
    <div className="connect-phone-relay">
      <p className="relay-status" role="status">{t("This device reaches the PC through the relay now. Relay links are made on the PC or from a direct connection to it.")}</p>
      {onUseCode !== undefined && (
        <>
          <p className="settings-description">{t("To connect another device from here, give it a pairing code.")}</p>
          <div className="phone-actions"><button type="button" className="btn btn-primary" onClick={onUseCode}>{t("Use a pairing code")}</button></div>
        </>
      )}
    </div>
  );
  const pairThisPhone = async () => {
    setError(null);
    setOpening(true);
    try { await openOwnOffer((await requestRelayOffer()).url); } catch (reason) { setError(failureText(reason)); } finally { setOpening(false); }
  };
  // a start that failed before the link existed: the relay is off and nothing retries it (server/relay/service.ts)
  const notStarted = status.blocked === null && status.phase === "off" && status.error !== null;
  const start = async () => {
    setError(null);
    try { await request("start"); } catch (reason) { setError(failureText(reason)); }
  };
  return (
    <div className="connect-phone-relay">
      {!(compact && status.phase === "online") && <p className="relay-status" role="status">{statusText(t, status)}</p>}
      {readOnly && <p className="settings-condition" data-testid="relay-owner-help">{t("Only the PC's owner can control the relay, using a direct connection. Open Ovis on the PC or at its direct address.")}</p>}
      {notStarted && <p className="settings-hint relay-error" role="alert">{t("The relay did not start: {message}", { message: status.error })}</p>}
      {notStarted && !readOnly && (
        <div className="phone-actions">
          <button type="button" className="btn" disabled={pending} onClick={() => void start()}><RefreshCw aria-hidden="true" />{t("Try again")}</button>
        </div>
      )}
      {pairHere && !readOnly && status.blocked === null && status.phase === "off" && !notStarted && <p className="settings-description">{t("Turn it on with the switch above, then this phone can use it in one tap.")}</p>}
      {pairHere && status.phase === "online" && !readOnly && (
        <div className="connect-phone-self">
          <p className="settings-description">{t("Pairs this phone through the relay, so Ovis keeps working away from home.")}</p>
          {sameName !== null && <p className="settings-hint">{t("A device with this phone's name ({name}) is already paired through the relay.", { name: sameName })}</p>}
          <div className="phone-actions"><button type="button" className="btn btn-primary" disabled={opening} onClick={pairThisPhone}>{t("Use the relay on this phone")}</button></div>
        </div>
      )}
      {error !== null && <p className="settings-hint relay-error" role="alert">{error}</p>}
      {status.phase === "online" && !readOnly && <RelayPairing phone={phone} compact={compact} />}
      {/* a serve-only install refuses the reset too; an unreadable identity is what the reset mends */}
      {!compact && !readOnly && status.blocked !== "serve_only" && (
        <div className="phone-actions connect-phone-reset">
          <button ref={resetButton} type="button" className="btn btn-ghost" disabled={pending} onClick={() => setConfirmingReset(true)}>{t("Reset relay identity")}</button>
        </div>
      )}
      {confirmingReset && (
        <ConfirmDialog title={t("Reset the relay identity?")} body={t("Phones paired through the relay will need to scan a new code.")}
          confirmLabel={t("Reset")} onClose={() => setConfirmingReset(false)} onConfirm={async () => {
            await request("reset-identity");
            setConfirmingReset(false);
            // the confirmation hands focus back only when it is dismissed: after the reset it goes back here
            window.requestAnimationFrame(() => resetButton.current?.focus());
          }} />
      )}
    </div>
  );
}

/**
 * A pairing code for a phone that can already open this address, with the QR code that opens it
 * with the code filled in. The server keeps one pending code: a code started here is announced, so
 * the Devices group watches for the phone it lets in (and closes the dialog once it is in), and the
 * relay's offer carries the same code.
 */
export function CodeRoute({ pairUrl, startAtOnce, phone = false, compact = false }: { pairUrl: string | null; startAtOnce: boolean; phone?: boolean; compact?: boolean }) {
  const t = useT();
  const [code, setCode] = useState<PairingCode | null>(null);
  const [left, setLeft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const linkRef = useRef<HTMLAnchorElement>(null);
  const announcing = useRef(false);

  useEffect(() => {
    const onCode = (event: Event) => { if (!announcing.current) setCode((event as CustomEvent<PairingCode>).detail); };
    window.addEventListener(PAIRING_CODE_EVENT, onCode);
    return () => window.removeEventListener(PAIRING_CODE_EVENT, onCode);
  }, []);

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

  const pair = async () => {
    setError(null);
    try {
      const fresh = await startPairing();
      setCode(fresh);
      announcing.current = true;
      try { announcePairingCode(fresh); } finally { announcing.current = false; }
    } catch (reason) { setError(failureText(reason)); }
  };

  // once per opening from Pair a device; switching back to this route later waits for the button
  const started = useRef(false);
  useEffect(() => {
    if (!startAtOnce || started.current) return;
    started.current = true;
    void pair();
  }, [startAtOnce]);

  const spaced = code ? `${code.code.slice(0, 3)} ${code.code.slice(3)}` : "";
  const qrValue = code && pairUrl ? `${pairUrl.replace(/\/$/, "")}/?pair=${code.code}` : null;
  const newCode = <button type="button" className="btn" onClick={() => void pair()}><RefreshCw aria-hidden="true" />{t("New code")}</button>;
  // Connect a device: the QR code and the code side by side, Refresh and Copy; a code that ran out leaves Refresh
  if (compact) return (
    <div className="connect-phone-code" role="status">
      <CompactPair qr={qrValue} qrLabel={code === null ? t("Pairing code") : t("QR code that pairs a phone with code {code}", { code: code.code })}
        code={code?.code ?? null} shown={code === null ? null : spaced} codeLabel={t("Pairing code")} onRefresh={() => void pair()} />
      {error !== null && <p className="settings-hint" role="alert">{error}</p>}
    </div>
  );
  return (
    <div className="connect-phone-code">
      {code === null ? (
        <>
          <p className="settings-description">{t("For a phone that can already open this address: on the same Wi-Fi, or through a tunnel or proxy.")}</p>
          <div className="phone-actions"><button type="button" className="btn btn-primary" onClick={() => void pair()}>{t("Get a pairing code")}</button></div>
        </>
      ) : phone ? (
        // on the phone itself the code is read off its screen and typed on the other device; its QR code waits behind Show QR code
        <div className="devices-pairing devices-pairing-phone" role="status">
          <p className="settings-label">{t("On the other device, enter this code")}</p>
          <p className="devices-code devices-code-large">{spaced}</p>
          <p className="settings-description">{t("Open the app's address on that device and enter it.")} {t("Expires in {time}.", { time: left })}</p>
          {qrValue !== null ? <ShareLink url={qrValue} copyLabel={t("Copy link")}>{newCode}</ShareLink> : <div className="phone-actions">{newCode}</div>}
          {qrValue !== null && <QrReveal value={qrValue} label={t("QR code that pairs a phone with code {code}", { code: code.code })} hint={t("Scan it with the other device's camera.")} />}
        </div>
      ) : (
        <div className="devices-pairing" role="status">
          {qrValue !== null && <QrCode value={qrValue} label={t("QR code that pairs a phone with code {code}", { code: code.code })} />}
          <div>
            <p className="settings-label">{t("On the other device, enter this code")}</p>
            <p className="devices-code">{spaced}</p>
            <p className="settings-description">
              {t(qrValue !== null ? "Or scan the QR code: it opens the app with the code filled in." : "Open the app's address on that device and enter it.")} {t("Expires in {time}.", { time: left })}
            </p>
            {qrValue !== null && (
              <p className="devices-link">
                <span className="settings-description">{t("Or send this link to it:")}</span>
                <a ref={linkRef} href={qrValue}>{qrValue}</a>
                <button type="button" className="btn btn-ghost" onClick={() => void copyText(qrValue, linkRef.current).then((ok) => { if (ok) { setCopied(true); window.setTimeout(() => setCopied(false), 1600); } })}>{t(copied ? "Copied" : "Copy")}</button>
              </p>
            )}
            <div className="phone-actions">
              <button type="button" className="btn" onClick={() => void pair()}><RefreshCw aria-hidden="true" />{t("New code")}</button>
            </div>
          </div>
        </div>
      )}
      {error !== null && <p className="settings-hint" role="alert">{error}</p>}
    </div>
  );
}
