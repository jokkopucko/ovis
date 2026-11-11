import { useEffect, useId, useLayoutEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Check, RefreshCw, X } from "lucide-react";

import "./ConnectPhoneDialog.css";
import "./DevicesPanel.css";

import type { Machine } from "../../shared/machines.ts";
import type { AddPcPreset } from "../lib/actions.ts";
import type { AccountSession } from "../lib/account/store.ts";
import { ApiError, findSshCandidates, findTailnetPcs, requestRelayOffer, startPairing, type SshCandidate } from "../lib/api.ts";
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
import { PROVIDER_NAMES } from "./AccountPcs.tsx";
import { PhonePanel, QrReveal, ShareLink } from "./PhonePanel.tsx";
import { QrCode } from "./QrCode.tsx";
import { failureText, openOwnOffer, RelayPairing, statusText } from "./RelayPanel.tsx";
import { RelaySignIn } from "./RelaySignIn.tsx";
import { SettingsQuery, Toggle } from "./SettingsControls.tsx";
import { PortalPanel } from "./PortalPanel.tsx";
import { usePortal } from "../lib/portal.ts";
import { CompactPair } from "./CompactPair.tsx";

/** the sheet's ways, one tab each: PCs over SSH, phones and browsers on this PC's address, and the Ovis relay through the account */
export type ConnectTab = "ssh" | "devices" | "relay";

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

/** the relay is on: connecting or online, nothing blocking it */
const relayOn = (relay: RelayState): boolean => relay.status !== null && relay.status.blocked === null && relay.status.phase !== "off";

/**
 * The tabs this window gets, in their order: only the ways it can use. SSH is the owner's, on a page of this PC (not
 * the hosted shell, not a device that only watches); the relay's tab is the owner's on a direct page of a PC that has
 * the relay. Phones and devices is always there.
 */
export function connectTabs({ sshOffered, relay, readOnly }: { sshOffered: boolean; relay: RelayState; readOnly: boolean }): ConnectTab[] {
  return [...(sshOffered ? ["ssh" as const] : []), "devices", ...(relayOffered(relay) && !readOnly ? ["relay" as const] : [])];
}

/** The Ovis account as the relay tab uses it: signed out, its sign-in on the link page; signed in, the account in Settings. */
export interface RelayAccount {
  /** the account service this page signs in with */
  service: string;
  /** the account's place in Settings, where this PC is added to it */
  onOpen: () => void;
  /** a sign-in from the relay tab finished: the page reads the account again */
  onSignedIn: () => void;
}

export interface ConnectPhoneDialogProps {
  plan: PhonePlan;
  /** an address a phone can open now, for the pairing code's QR code; null shows the code alone */
  pairUrl: string | null;
  relay: RelayState;
  /** a watching device or a Portal visitor: it reads, and starts nothing */
  readOnly: boolean;
  /** turning the relay on closes the open device gate */
  closesGate: boolean;
  /** a Portal visitor may not start pairing codes (the server refuses it) */
  canPair: boolean;
  /** this browser is signed in to the Ovis account */
  signedIn: boolean;
  /**
   * Signed in, with this PC in that account and its relay on: a new device joins by signing in to the
   * same account, and a device already in it approves it once by picking the matching number
   * (AccountApprovals, docs/account.md "Who may admit a device").
   */
  joinBySignIn: boolean;
  /** the Ovis account, where this page offers it: the relay is used through it */
  account: RelayAccount | null;
  /** the Add PC dialog, its address filled in when a found PC was picked; null where PCs are not added from here */
  onAddPc: ((preset?: AddPcPreset) => void) | null;
  /** the roster: which found PCs are added already, and the PCs saved in herdr that wait for Connect */
  machines: readonly Machine[];
  /** Connect on a PC saved in herdr: its own setup dialog */
  onConnectMachine: (machine: Machine) => void;
  onClose: () => void;
}

/**
 * Settings → Devices and PCs → Add a connection, as herdr's Add a machine: one tab per way, the PCs each way
 * finds listed with Add, and a field to type one. SSH lists the PCs saved in herdr, the hosts of this PC's ssh
 * config and its Tailscale login's other PCs, each opening Add PC with its address. Phones and devices holds
 * what a phone or browser opens this PC with: its Tailscale address, a pairing code, and Portal where installed.
 * The Ovis relay is used through the Ovis account, so its tab is the sign-in, or once signed in how a new device
 * joins. The relay and Tailscale stay apart: nothing on the SSH tab goes through the relay.
 */
export function ConnectPhoneDialog({ plan, pairUrl, relay, readOnly, closesGate, canPair, signedIn, joinBySignIn, account, onAddPc, machines, onConnectMachine, onClose }: ConnectPhoneDialogProps) {
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
  const tabs = connectTabs({ sshOffered: onAddPc !== null && !readOnly && !inRelayShell(), relay, readOnly });
  // a phone mostly connects itself; a PC's window opens on the PCs
  const [chosen, setChosen] = useState<ConnectTab>(() => (phone && tabs.includes("devices") ? "devices" : tabs[0]!));
  const tab = tabs.includes(chosen) ? chosen : tabs[0]!;
  // a tab once opened stays mounted while the dialog is: going back to Phones and devices keeps its code, not a new one
  const opened = useRef(new Set<ConnectTab>());
  opened.current.add(tab);
  const label: Record<ConnectTab, string> = { ssh: "SSH", devices: t("Phones and devices"), relay: t("Ovis relay") };

  return createPortal(
    // a Settings search hides no row in here
    <SettingsQuery.Provider value={[]}>
    <div className="modal-scrim" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div ref={surface} className="modal connect-phone-dialog" role="dialog" aria-modal="true" aria-labelledby={`${id}-title`} tabIndex={-1}>
        <header className="modal-header">
          <h1 className="modal-title" id={`${id}-title`} tabIndex={-1}>{t("Add a connection")}</h1>
          <button type="button" className="icon-button" aria-label={t("Close")} onClick={onClose}><X aria-hidden="true" /></button>
        </header>
        <div className="modal-body connect-phone-body">
          {tabs.length > 1 && (
            <div className="segmented connect-tabs" role="group" aria-label={t("How to connect")}>
              {tabs.map((way) => <button key={way} type="button" aria-pressed={tab === way} data-tab={way} onClick={() => setChosen(way)}>{label[way]}</button>)}
            </div>
          )}
          {opened.current.has("ssh") && tabs.includes("ssh") && (
            <div className="connect-tab" data-tab-panel="ssh" hidden={tab !== "ssh"}>
              <SshTab machines={machines} onAddPc={onAddPc!} onConnectMachine={onConnectMachine} />
            </div>
          )}
          {opened.current.has("devices") && (
            <div className="connect-tab" data-tab-panel="devices" hidden={tab !== "devices"}>
              <DevicesTab plan={plan} pairUrl={pairUrl} readOnly={readOnly} canPair={canPair} phone={phone} />
            </div>
          )}
          {opened.current.has("relay") && tabs.includes("relay") && (
            <div className="connect-tab" data-tab-panel="relay" hidden={tab !== "relay"}>
              <RelayTab relay={relay} closesGate={closesGate} signedIn={signedIn} joinBySignIn={joinBySignIn} account={account} phone={phone} />
            </div>
          )}
        </div>
      </div>
    </div>
    </SettingsQuery.Provider>,
    document.body,
  );
}

/** how a found PC is known here: saved in herdr, a host of the ssh config, or a PC of the Tailscale login */
type FoundSource = "herdr" | SshCandidate["source"];
const SOURCE_LABEL: Record<FoundSource, string> = { herdr: "herdr", ssh_config: "ssh config", tailscale: "Tailscale" };

/**
 * SSH: the PCs found, each with Connect (saved in herdr, its own dialog), Add (Add PC with its address) or Added,
 * then a field for any other address. A window the server will not tell (an open LAN window, Portal, the relay)
 * gets the field; one refused as owner_only (an open LAN window: the relay shell and a Portal visitor show no SSH tab)
 * is told where the list can be seen, so an empty tab is not taken for a PC that knows none.
 */
export function SshTab({ machines, onAddPc, onConnectMachine }: { machines: readonly Machine[]; onAddPc: (preset?: AddPcPreset) => void; onConnectMachine: (machine: Machine) => void }) {
  const t = useT();
  const [found, setFound] = useState<SshCandidate[] | null>(null);
  const [failed, setFailed] = useState(false);
  // the server keeps its list from this window (owner_only): one line above the field says where it can be seen
  const [withheld, setWithheld] = useState(false);
  const [reads, setReads] = useState(0);
  const [typed, setTyped] = useState("");
  // the Tailscale PCs whose Ovis is older than 0.5 (#3253), by MagicDNS name: told to update it there instead of Add
  const [outdated, setOutdated] = useState<ReadonlySet<string>>(new Set());
  // until that answer is in (it asks each PC, a few seconds), a Tailscale PC's Add waits (its own row, or the config
  // host that names it), so an older one is not added
  const [tailnetRead, setTailnetRead] = useState(false);
  useEffect(() => {
    let live = true;
    setTailnetRead(false);
    findTailnetPcs().then(({ pcs }) => {
      if (live) setOutdated(new Set(pcs.filter((pc) => pc.outdated).map((pc) => new URL(pc.url).hostname.toLowerCase())));
    }, () => undefined).finally(() => { if (live) setTailnetRead(true); });
    return () => { live = false; };
  }, [reads]);
  useEffect(() => {
    let live = true;
    setFailed(false);
    setWithheld(false);
    findSshCandidates().then(({ pcs }) => { if (live) setFound(pcs); }, (error: unknown) => {
      // a window the server will not tell (owner_only, read_only) gets the field; anything else says so, with Try again
      const refused = error instanceof ApiError && (error.code === "owner_only" || error.code === "read_only");
      if (!refused) console.warn("Ovis: the PCs to add over SSH could not be read", error instanceof Error ? error.name : error);
      if (!live) return;
      setFound([]);
      setFailed(!refused);
      // a watching device (read_only) adds no PC: it is told nothing new
      setWithheld(error instanceof ApiError && error.code === "owner_only");
    });
    return () => { live = false; };
  }, [reads]);
  const saved = machines.filter((machine) => machine.herdr_profile_id !== undefined && machine.action_required === "connect");
  // a found PC is Added only as Add would add it: its own address, on ssh's default port and herdr's default session
  const added = (destination: string) => machines.some(({ target }) => target?.destination === destination && (target.port ?? 22) === 22 && target.session === undefined);
  const add = (event: FormEvent) => {
    event.preventDefault();
    const destination = typed.trim();
    if (destination !== "") onAddPc({ destination });
  };
  const row = (key: string, name: string, detail: string | null, source: FoundSource, action: ReactNode) => (
    <li key={key} className="connect-found-row">
      <span className="connect-found-name">{name}</span>
      {detail !== null && <span className="connect-found-detail">{detail}</span>}
      <span className="connect-found-source">{SOURCE_LABEL[source]}</span>
      {action}
    </li>
  );
  return (
    <>
      <p className="settings-description">{t("Add another PC over SSH.")}</p>
      {found === null ? <p className="settings-hint" role="status">{t("Looking for PCs…")}</p> : (saved.length > 0 || found.length > 0) && (
        <div className="connect-found">
          <ul className="connect-found-list">
            {saved.map((machine) => row(`herdr:${machine.id}`, machine.name, machine.target?.destination ?? null, "herdr",
              <button type="button" className="btn" onClick={() => onConnectMachine(machine)}>{t("Connect")}</button>))}
            {found.map((pc) => row(`${pc.source}:${pc.destination}`, pc.name, pc.detail, pc.source, added(pc.destination)
              ? <span className="connect-found-added"><Check aria-hidden="true" />{t("Added")}</span>
              : pc.tailnet !== undefined && outdated.has(pc.tailnet.toLowerCase())
              ? <span className="settings-hint">{t("Update Ovis on that PC to 0.5 first.")}</span>
              : <button type="button" className="btn" disabled={pc.tailnet !== undefined && !tailnetRead} aria-label={t("Add {name}", { name: pc.name })} onClick={() => onAddPc({ destination: pc.destination, name: pc.name })}>{t("Add")}</button>))}
          </ul>
        </div>
      )}
      {failed && (
        <div className="connect-found-failed" role="alert">
          <p className="settings-hint">{t("The PCs this PC knows could not be read.")}</p>
          <button type="button" className="btn" onClick={() => { setFound(null); setReads((count) => count + 1); }}><RefreshCw aria-hidden="true" />{t("Try again")}</button>
        </div>
      )}
      {withheld && <p className="settings-hint" role="status">{t("See the PCs this PC knows on this PC itself, or from a device paired with it directly.")}</p>}
      <form className="connect-ssh-form" onSubmit={add}>
        <label className="settings-label" htmlFor="connect-ssh-address">{t("Or type an SSH address")}</label>
        <div className="connect-ssh-field">
          <input id="connect-ssh-address" className="input" type="text" value={typed} placeholder="user@host" autoComplete="off" spellCheck={false} autoCapitalize="off" autoCorrect="off" onChange={(event) => setTyped(event.target.value)} />
          <button type="submit" className="btn" disabled={typed.trim() === ""}>{t("Add")}</button>
        </div>
      </form>
    </>
  );
}

/**
 * Phones and devices: this PC's Tailscale address once it has one, a pairing code, and Portal where it can run. A way
 * this PC or window cannot use is left out, not explained.
 */
function DevicesTab({ plan, pairUrl, readOnly, canPair, phone }: { plan: PhonePlan; pairUrl: string | null; readOnly: boolean; canPair: boolean; phone: boolean }) {
  const t = useT();
  const { status: portal } = usePortal();
  const address = plan.kind === "here" || plan.kind === "served";
  const pairs = canPair && !readOnly;
  const portalShown = portal?.supported === true && (portal.phase !== "idle" || (portal.usable && portal.blocked === null));
  // nothing this window can use: one line on where it can be done, never an empty sheet
  if (!address && !pairs && !portalShown) return <p className="settings-description">{t("Open Ovis on the PC itself to add a connection.")}</p>;
  return (
    <>
      {address && (
        <section className="connect-section" aria-label="Tailscale">
          <p className="settings-label">Tailscale</p>
          <PhonePanel url={plan.url} phone={phone} />
        </section>
      )}
      {pairs && (
        <section className="connect-section" aria-label={t("Pairing code")}>
          <p className="settings-label">{t("Pairing code")}</p>
          <CodeRoute pairUrl={inRelayShell() ? null : pairUrl} startAtOnce phone={phone} compact />
        </section>
      )}
      {portalShown && (
        <section className="connect-section" aria-label="Portal">
          <PortalPanel readOnly={readOnly} />
        </section>
      )}
    </>
  );
}

/**
 * The Ovis relay, the owner's on a direct page. Signed out of the Ovis account, the sign-in; signed in, how a new
 * device joins, or the relay's switch while that cannot happen yet. Where the page has no account (none offered, or
 * its service cannot be reached), the relay's own pairing as before the account: its switch, its QR code and code to
 * type. One short line at most: what a blocked relay or the device gate means stays in More settings, or in the
 * switch's tooltip.
 */
export function RelayTab({ relay, closesGate, signedIn, joinBySignIn, account, phone }: {
  relay: RelayState; closesGate: boolean; signedIn: boolean; joinBySignIn: boolean; account: RelayAccount | null; phone: boolean;
}) {
  const t = useT();
  const [switchError, setSwitchError] = useState<string | null>(null);
  const [signedInProvider, setSignedInProvider] = useState<AccountSession["provider"] | null>(null);
  const signInView = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const view = signInView.current;
    // A completed sign-in leaves the next control ready, unless the person switched tabs.
    if (!signedIn || signedInProvider === null || view === null || view.closest("[hidden]") !== null) return;
    const next = view.querySelector<HTMLElement>("button:not(:disabled), a[href]")
      ?? view.closest('[role="dialog"]')?.querySelector<HTMLElement>("h2");
    next?.focus();
  }, [signedIn, signedInProvider, joinBySignIn]);
  const signInStatus = <p key="sign-in-status" className="visually-hidden" role="status" aria-live="polite">{signedInProvider === null ? null : t("Signed in with {provider}", { provider: PROVIDER_NAMES[signedInProvider] })}</p>;
  const on = relayOn(relay);
  useEffect(() => { if (on) setSwitchError(null); }, [on]);
  const switchable = relay.status?.blocked === null;
  const startError = relay.status !== null && relay.status.blocked === null && relay.status.phase === "off" ? relay.status.error : null;
  const switchRelay = async (next: boolean) => {
    setSwitchError(null);
    try { await relay.request(next ? "start" : "stop"); } catch (reason) { setSwitchError(failureText(reason)); }
  };
  // the switch's own name stays Ovis relay (the tab's, and what a screen reader hears); its visible label says
  // what turning it on does, and while the relay connects the same line says so, so on is not taken for online
  const connecting = on && relay.status?.phase !== "online";
  const relaySwitch = switchable && (
    <div className="connect-relay-switch" aria-busy={connecting || undefined} title={closesGate && !on ? t("Turning on the relay closes the device gate: a new browser then needs a pairing code or the access token.") : undefined}>
      <span className="settings-label">{t("Let this PC be reached from anywhere")}{connecting && <span className="connect-relay-state" role="status"> · {statusText(t, relay.status!)}</span>}</span>
      <Toggle label={t("Ovis relay")} checked={on} onChange={(next) => { if (!relay.pending) void switchRelay(next); }} />
    </div>
  );
  const switchFailure = switchError !== null && <p className="settings-hint relay-error" role="alert">{switchError}</p>;
  if (account === null) return (
    <>
      {relaySwitch}
      {switchFailure}
      <RelayRoute relay={relay} readOnly={false} phone={phone} compact />
    </>
  );
  if (!signedIn) return (
    <div ref={signInView} className="connect-signin" data-testid="connect-signin">
      {signInStatus}
      <RelaySignIn service={account.service} onOpenAccount={account.onOpen} onSignedIn={(session) => { setSignedInProvider(session.provider); account.onSignedIn(); }} />
    </div>
  );
  return (
    <div ref={signInView} className="connect-signin" data-testid="connect-signin">
      {signInStatus}
      {joinBySignIn ? <p className="connect-signin-lead">{t("On the new device, sign in to the same Ovis account.")}</p> : (
        <>
          {switchable && <p className="settings-description">{t("Turn on the relay, then add this PC to your account.")}</p>}
          {relaySwitch}
          {switchFailure}
          {/* a start that failed before the link existed: the server answers phase off with its reason, and nothing retries it */}
          {switchError === null && startError !== null && <p className="settings-hint relay-error" role="alert">{t("The relay did not start: {message}", { message: startError })}</p>}
          <button type="button" className="btn connect-signin-button" onClick={account.onOpen}>{t("Open the account")}</button>
        </>
      )}
    </div>
  );
}

/**
 * The relay's way: its state (Blocked says why), a start that failed with Try again, the pairing QR
 * code once it is online, and the identity reset as a quiet last action. The switch is on its card.
 * On a phone, online, the phone pairs itself through its own offer in one tap, and the offer for
 * another device is a link to send, its QR code behind Show QR code.
 */
export function RelayRoute({ relay, readOnly, phone = false, pairHere = false, sameName = null, compact = false }: {
  relay: RelayState;
  /** Add a connection: no state line (the switch above says it), the QR code beside the code to type, no reset (More settings has it) */
  compact?: boolean;
  readOnly: boolean;
  phone?: boolean;
  /** a touch phone: Use the relay on this phone */
  pairHere?: boolean;
  /** a relay device under this phone's name: a hint, never proof that this phone is paired */
  sameName?: string | null;
}) {
  const t = useT();
  const { status, pending, request } = relay;
  const [error, setError] = useState<string | null>(null);
  const [confirmingReset, setConfirmingReset] = useState(false);
  const [opening, setOpening] = useState(false);
  const resetButton = useRef<HTMLButtonElement>(null);
  if (status === null) return null;
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
      {!compact && <p className="relay-status" role="status">{statusText(t, status)}</p>}
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

/** the newest code request of any opening: the server keeps one pending code, so an older answer is a dead code */
let latestPairRequest = 0;

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
  // a code request out: the buttons that would start another wait for it, so a second tap sends no second request
  const [busy, setBusy] = useState(false);
  const requesting = useRef(false);
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
    if (requesting.current) return;
    requesting.current = true;
    setBusy(true);
    setError(null);
    const request = ++latestPairRequest;
    try {
      const fresh = await startPairing();
      // a dialog closed and opened again asked after this one: its answer is the code that pairs, not this one
      if (request !== latestPairRequest) return;
      setCode(fresh);
      announcing.current = true;
      try { announcePairingCode(fresh); } finally { announcing.current = false; }
    } catch (reason) { setError(failureText(reason)); }
    finally {
      requesting.current = false;
      setBusy(false);
    }
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
  const newCode = <button type="button" className="btn" disabled={busy} aria-busy={busy || undefined} onClick={() => void pair()}><RefreshCw aria-hidden="true" />{t("New code")}</button>;
  // Connect a device: the QR code and the code side by side, Refresh and Copy; a code that ran out leaves Refresh
  if (compact) return (
    <div className="connect-phone-code" role="status">
      <CompactPair qr={qrValue} qrLabel={code === null ? t("Pairing code") : t("QR code that pairs a phone with code {code}", { code: code.code })}
        code={code?.code ?? null} shown={code === null ? null : spaced} codeLabel={t("Pairing code")} busy={busy}
        qrNote={busy ? undefined : code === null ? t("This code expired.") : pairUrl === null ? t("No address a phone can open: type the code instead.") : undefined}
        onRefresh={() => void pair()} />
      {error !== null && <p className="settings-hint" role="alert">{error}</p>}
    </div>
  );
  return (
    <div className="connect-phone-code">
      {code === null ? (
        <>
          <p className="settings-description">{t("For a phone that can already open this address: on the same Wi-Fi, or through a tunnel or proxy.")}</p>
          <div className="phone-actions"><button type="button" className="btn btn-primary" disabled={busy} aria-busy={busy || undefined} onClick={() => void pair()}>{t("Get a pairing code")}</button></div>
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
            <div className="phone-actions">{newCode}</div>
          </div>
        </div>
      )}
      {error !== null && <p className="settings-hint" role="alert">{error}</p>}
    </div>
  );
}
