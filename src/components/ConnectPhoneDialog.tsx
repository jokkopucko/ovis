import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type Dispatch, type FormEvent, type MutableRefObject, type ReactNode, type SetStateAction } from "react";
import { createPortal } from "react-dom";
import { Check, RefreshCw, Smartphone, X } from "lucide-react";

import "./ConnectPhoneDialog.css";
import "./DevicesPanel.css";

import { ADDRESS_PC_FAILURES, type AddressPcFailure, type Machine } from "../../shared/machines.ts";
import type { AddPcPreset } from "../lib/actions.ts";
import { indexedAccountStore, type AccountProvider, type AccountSession } from "../lib/account/store.ts";
import { pcAccountStatus, type PcAccountStatus } from "../lib/account/join.ts";
import { listOfferedPc } from "../lib/account/addThisPc.ts";
import { decodeOffer } from "../../shared/relay-offer.ts";
import { AccountService } from "../lib/account/service.ts";
import type { AddConnectionTab } from "../lib/addConnectionRequest.ts";
import { ACCOUNT_QR_ALONE_MS, ACCOUNT_QR_POLL_MS, ACCOUNT_QR_WATCH_EVENT, accountQrFindings, accountQrNoticeWaiting, accountQrPending, addedBy, holdAccountQrNotice, resetAccountQrWatch, stopAccountQrWatch, takeAccountQrNotice, watchEndedAccountQr, type AccountQrBaseline, type AccountQrStray } from "../lib/accountQrWatch.ts";
import { addAddressPc, ApiError, endPairing, fetchDevices, fetchListAccount, fetchRemoteAccess, findSshCandidates, findTailnetPcs, openTailscaleApp, requestRelayOffer, revokeAllDevices, revokeDevice, serveOnTailscale, startPairing, type RelayOffer, type SshCandidate } from "../lib/api.ts";
import { apiFetch } from "../lib/api-request-id.ts";
import { copyText } from "../lib/clipboard.ts";
import { useT } from "../lib/i18n.ts";
import { tailscalePlan, type PhonePlan } from "../lib/phone.ts";
import { reachablePcs, reachableState, savedAt, type ReachableFacts, type ReachablePc, type ReachableState } from "../lib/reachablePcs.ts";
import { useMediaQuery } from "../lib/useMediaQuery.ts";
import { usePhoneSheetBack } from "../lib/sheetHistory.ts";
import { useSheetSwipe } from "../lib/sheets.ts";
import { nativeModalOver, useFocusTrap } from "../lib/useFocusTrap.ts";
import { announcePairingCode, announceQrCodeEnded, DEVICES_CHANGED_EVENT, inRelayShell, PAIRING_CODE_EVENT, tellOtherWindowsQrCodeEnded, type AnnouncedCode, type RelayState } from "../lib/useRelay.ts";
import type { PairedDevice, PairingCode, PortalStatus, RemoteAccess } from "../../shared/protocol.ts";
import { ConfirmDialog } from "./ConfirmDialog.tsx";
import { PROVIDER_NAMES } from "./AccountPcs.tsx";
import { AddThisPc, useSignInAgainHere, type SignedInHere } from "./AccountSection.tsx";
import { PhonePanel, QrReveal, ShareLink } from "./PhonePanel.tsx";
import { QrCode } from "./QrCode.tsx";
import { failureText, openOwnOffer, RelayPairing, statusText } from "./RelayPanel.tsx";
import { RelaySignIn } from "./RelaySignIn.tsx";
import { atDots } from "./RelayAddPc.tsx";
import { SettingsQuery, Toggle } from "./SettingsControls.tsx";
import { PortalPanel } from "./PortalPanel.tsx";
import { usePortal } from "../lib/portal.ts";
import { CompactPair } from "./CompactPair.tsx";
import { ExternalLink } from "../lib/externalLink.ts";

/**
 * The ways to connect are the tabs (the relay, Tailscale, a typed address): each adds a PC its own way, and under that
 * shows the QR code a phone scans to connect that same way (PhoneScan).
 */
export type ConnectTab = AddConnectionTab;

const TAILSCALE_DOWNLOAD = "https://tailscale.com/download";
/** Tailscale's download page for the platform this PC's server reports (RemoteAccess.platform) */
const TAILSCALE_DOWNLOADS: Readonly<Record<string, string>> = { darwin: `${TAILSCALE_DOWNLOAD}/mac`, win32: `${TAILSCALE_DOWNLOAD}/windows`, linux: `${TAILSCALE_DOWNLOAD}/linux` };
/** how often an open Tailscale step reads this PC's Tailscale again, so it moves on by itself once Tailscale is on */
export const TAILSCALE_POLL_MS = 3000;
/** the command that lets this Linux user run `tailscale serve` without root, shown only after Tailscale refused it for want of it */
const TAILSCALE_OPERATOR = "sudo tailscale set --operator=$USER";

/** an address the SSH tab takes for another PC's Ovis rather than SSH: any http(s) scheme, as a browser reads `https:host` too */
const OVIS_ADDRESS = /^https?:/i;

const PHONE_QUERY = "(pointer: coarse), (max-width: 768px)";

/**
 * The label of a device paired through the relay under this phone's own name, for a quiet hint.
 * A name is no proof (two iPhones share one, and any device can be renamed), so it never stands in
 * for the phone's pairing: the relay key is the hosted shell's, out of this page's reach.
 */
export function sameNameRelayDevice(devices: readonly PairedDevice[], label: string): string | null {
  return devices.find((device) => device.via_relay === true && !device.current && device.label === label)?.label ?? null;
}

export const relayOffered = (relay: RelayState): boolean => !relay.unsupported && relay.status !== null && !inRelayShell();

/**
 * the relay's first state is still on its way on a page that may offer it: the tab may come, so nothing is drawn in its
 * stead. A read that failed is no longer pending, so a relay that never answers leaves the account card in place.
 */
export const relayPending = (relay: RelayState): boolean => !relay.unsupported && relay.status === null && !relay.readFailed && !inRelayShell();

/**
 * The QR code of a PC in an account: this PC's page in the hosted app (the Ovis app opens it), which signs in with
 * `provider` (this page's own sign-in, when it is that account's) and then joins the PC as a device of the account.
 * No code, key or token: whoever scans it still needs that account, and the PC's approval.
 */
export function signInLink(app: string, serverId: string, provider: AccountProvider | null): string {
  return `${new URL(app).origin}/s/${serverId}/${provider === null ? "" : `#sign-in=${provider}`}`;
}

const relayOn = (relay: RelayState): boolean => relay.status !== null && relay.status.blocked === null && relay.status.phase !== "off";

/**
 * The relay's tab is the owner's on a direct page of a PC that has the relay; Tailscale and SSH (an SSH login, or another
 * PC's Ovis by its https address) add a PC from here, the owner's on a page of this PC (not the hosted shell, not a
 * device that only watches).
 */
export function connectTabs({ sshOffered, relay, readOnly }: { sshOffered: boolean; relay: RelayState; readOnly: boolean }): ConnectTab[] {
  return [...(relayOffered(relay) && !readOnly ? ["relay" as const] : []), ...(sshOffered ? ["tailscale" as const, "ssh" as const] : [])];
}

/**
 * The tab the dialog shows until one is picked: the relay, but only where the page has the Ovis account. Without it the
 * relay tab is the relay's own pairing, so the window opens on the first way that adds a PC instead. Null with no tab:
 * the window then shows what a phone scans alone (a phone's page, the hosted shell, a device that only watches).
 */
export function openingTab({ tabs, noticeWaiting, hasAccount, asked = null }: { tabs: readonly ConnectTab[]; noticeWaiting: boolean; hasAccount: boolean; asked?: ConnectTab | null }): ConnectTab | null {
  // the setup checklist's Connect your phone asks for the relay, which needs no Tailscale
  if (asked !== null && tabs.includes(asked)) return asked;
  if (noticeWaiting && hasAccount && tabs.includes("relay")) return "relay";
  return tabs.find((way) => way !== "relay" || hasAccount) ?? tabs[0] ?? null;
}

export interface RelayAccount {
  service: string;
  onOpen: () => void;
  /** `home`: the sign-in is to the account this PC is already in, with its relay on, so nothing is left to do here
   * (closedBySignIn); with the relay off the tab stays, with the relay's switch */
  onSignedIn: (home: boolean) => void;
  /** this PC's step-2 switch, as Settings reads it: only then does Add this PC try the one press */
  opensAll?: () => boolean;
}

/**
 * What a sign-in on the relay tab closes. One with nothing left to do here (`home`) closes the sheet, and Settings stays
 * open on the page that now shows the account and its PCs; a sheet the setup checklist's Connect your phone opened
 * (`asked`) goes on to the main screen, where that step began.
 */
export function closedBySignIn(home: boolean, asked: ConnectTab | null): "nothing" | "sheet" | "settings" {
  if (!home) return "nothing";
  return asked === null ? "sheet" : "settings";
}

export interface ConnectPhoneDialogProps {
  /** the tab it was asked to open on (the setup checklist's Connect your phone: the relay), until another is picked */
  asked?: ConnectTab | null;
  pcAddFromAccount?: PcAccountStatus["pcAddFromAccount"];
  onAccountSetup?: () => void;
  plan: PhonePlan;
  /** what Tailscale alone offers a phone (tailscalePlan), for the Tailscale tab; `plan` when omitted */
  tailscale?: PhonePlan;
  /** the platform this PC's server reports (RemoteAccess.platform): which Tailscale download and app this PC takes */
  platform?: string | undefined;
  pairUrl: string | null;
  relay: RelayState;
  /** a watching device or a Portal visitor: it reads, and starts nothing */
  readOnly: boolean;
  /** turning the relay on closes the open device gate */
  closesGate: boolean;
  /** a Portal visitor may not start pairing codes (the server refuses it) */
  canPair: boolean;
  signedIn: boolean;
  accountId?: string | null;
  /** how this page is signed in: the relay tab's QR code for a PC in this account opens that sign-in on the phone */
  provider?: AccountProvider | null;
  /**
   * Signed in, with this PC in that account and its relay on: a new device joins by signing in to the
   * same account, and a device already in it approves it once by picking the matching number
   * (AccountApprovals, docs/account.md "Who may admit a device").
   */
  joinBySignIn: boolean;
  account: RelayAccount | null;
  onAddPc: ((preset?: AddPcPreset) => void) | null;
  machines: readonly Machine[];
  onConnectMachine: (machine: Machine) => void;
  /**
   * Add PC over SSH adds a PC to the account here (this PC's own window, signed in to the account this PC is in:
   * sshAddOffered): the relay tab then lists the PCs this PC can reach, each with Add (ReachablePcList)
   */
  addsOverSsh?: boolean;
  /** the relay IDs of the account's PCs, so the relay tab's list says which are in it already */
  accountPcs?: readonly string[];
  /**
   * The relay tab's QR code may put this PC in an account, and the dialog then says which and by which device, and asks
   * about a device nobody vouched for: while that can still come, or is on screen, a device that pairs does not close
   * the dialog (`held`).
   */
  onPairingHeld?: (held: boolean) => void;
  onRevokedAll?: () => void;
  onClose: () => void;
}

export function ConnectPhoneDialog({ asked = null, plan: givenPlan, tailscale: givenTailscale = givenPlan, platform: givenPlatform, pairUrl, relay, readOnly, closesGate, canPair, signedIn, accountId = null, provider = null, joinBySignIn, account, onAddPc, machines, onConnectMachine, addsOverSsh = false, accountPcs, pcAddFromAccount, onAccountSetup, onPairingHeld, onRevokedAll, onClose }: ConnectPhoneDialogProps) {
  const t = useT();
  const id = useId();
  const surface = useFocusTrap<HTMLDivElement>(true);
  useSheetSwipe(surface, onClose);
  usePhoneSheetBack(() => { onClose(); }, true, true);
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (surface.current === null) return;
      if (event.key !== "Escape" || event.isComposing || nativeModalOver(surface.current)) return;
      if (document.querySelector('[role="alertdialog"]') !== null) return;
      event.stopPropagation();
      event.preventDefault();
      onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose, surface]);

  const phone = useMediaQuery(PHONE_QUERY);
  // what this PC's Tailscale says now, read again while a Tailscale step is up (useTailscaleWatch) or after a serve
  const [fresh, setFresh] = useState<RemoteAccess | null>(null);
  const plan = fresh !== null && tailscaleStepKind(givenPlan) ? tailscalePlan(fresh) : givenPlan;
  const tailscale = fresh !== null && tailscaleStepKind(givenTailscale) ? tailscalePlan(fresh) : givenTailscale;
  const platform = fresh?.platform ?? givenPlatform;
  const tabs = connectTabs({ sshOffered: onAddPc !== null && !readOnly && !inRelayShell(), relay, readOnly });
  const hasAccount = account !== null;
  // until a tab is picked, the opening one follows the tabs as they arrive (the relay's state comes a moment later)
  const [chosen, setChosen] = useState<ConnectTab | null>(() => asked ?? (accountQrNoticeWaiting() && hasAccount ? "relay" : null));
  const found = useFoundPcs(machines, tabs.includes("tailscale"));
  const inAccount = useMemo(() => new Set(accountPcs), [accountPcs]);
  useEffect(() => {
    if (!hasAccount) return;
    const onWatch = (event: Event) => { if ((event as CustomEvent<{ notice: boolean }>).detail.notice) setChosen("relay"); };
    window.addEventListener(ACCOUNT_QR_WATCH_EVENT, onWatch);
    return () => window.removeEventListener(ACCOUNT_QR_WATCH_EVENT, onWatch);
  }, [hasAccount]);
  const tab = chosen !== null && tabs.includes(chosen) ? chosen : openingTab({ tabs, noticeWaiting: false, hasAccount, asked });
  // until the relay's state comes, which tab opens is not known: nothing is mounted, so no pairing code is made unasked
  const waiting = !readOnly && relayPending(relay);
  const opened = useRef(new Set<ConnectTab>());
  if (tab !== null && !waiting) opened.current.add(tab);
  const label: Record<ConnectTab, string> = { relay: t("Ovis relay"), tailscale: "Tailscale", ssh: "SSH" };
  const { status: portal } = usePortal();
  const local = localWays({ plan, readOnly, canPair, portal });
  const tailnet = localWays({ plan: tailscale, readOnly, canPair, portal: null });
  // one pairing code for both tabs that show one: the PC keeps one pending code, so a second would end the first
  const sharedCode = useRef<SharedCode>({ code: null, asking: false, waiting: new Set(), wanted: false, views: new Set() });
  // the six-digit code a device types where it opens this PC's Ovis: under the relay tab, else under SSH. Where the
  // relay tab's top offers it beside the account QR code (AccountQr `pairHere`: online, this PC's relay ID known), that
  // is its one place
  const codeTab: ConnectTab = tabs.includes("relay") ? "relay" : "ssh";
  const codeOnTop = addsOverSsh && tabs.includes("tailscale") && relay.status?.phase === "online" && relay.status.blocked === null
    && machines.some((machine) => machine.kind === "local" && machine.server_id !== undefined);
  const pairByCode = local.code && <PairByCode shared={sharedCode} phone={phone} />;
  useTailscaleWatch(!waiting && ((tab === "tailscale" && tailnet.tailscaleStep !== null) || (tab === null && local.tailscaleStep !== null)), setFresh);

  return createPortal(
    <SettingsQuery.Provider value={[]}>
    <div className="modal-scrim" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div ref={surface} className="modal connect-phone-dialog" role="dialog" aria-modal="true" aria-labelledby={`${id}-title`} tabIndex={-1}>
        <header className="modal-header">
          <h1 className="modal-title" id={`${id}-title`} tabIndex={-1}>{t("Add a connection")}</h1>
          <button type="button" className="icon-button" aria-label={t("Close")} onClick={onClose}><X aria-hidden="true" /></button>
        </header>
        {/* the tabs stay put above the body, which scrolls: a long tab (many PCs) never hides its phone part below the window */}
        {tabs.length > 0 && (
          <div className="connect-tabs-bar">
            <div className="segmented connect-tabs" role="group" aria-label={t("How to connect")}>
              {tabs.map((way) => <button key={way} type="button" aria-pressed={tab === way} data-tab={way} onClick={() => setChosen(way)}>{label[way]}</button>)}
            </div>
          </div>
        )}
        <div className="modal-body connect-phone-body">
          {waiting && <p className="settings-hint" role="status" data-testid="connect-pending">{t("Loading…")}</p>}
          {tab === null && !waiting && <LocalWay plan={plan} pairUrl={pairUrl} readOnly={readOnly} local={local} phone={phone} platform={platform} onAccess={setFresh} />}
          {opened.current.has("tailscale") && tabs.includes("tailscale") && (
            <div className="connect-tab" data-tab-panel="tailscale" hidden={tab !== "tailscale"}>
              {/* the phone's QR code and code first: the list of tailnet PCs can be long */}
              <PhoneScan>
                {tailnet.address !== null ? (
                  tailnet.code ? <CodeRoute pairUrl={tailnet.address} startAtOnce={tab === "tailscale"} shared={sharedCode} phone={phone} compact /> : <PhonePanel url={tailnet.address} phone={phone} />
                ) : tailnet.tailscaleStep !== null ? <TailscaleStep step={tailnet.tailscaleStep} platform={platform} onAccess={setFresh} /> : null}
                {(tailscale.kind === "served" || tailnet.tailscaleStep !== null) && <p className="settings-hint">{t("The phone needs the Tailscale app turned on too.")}</p>}
              </PhoneScan>
              <TailscaleTab found={found} onAddPc={onAddPc!} onConnectMachine={onConnectMachine} />
            </div>
          )}
          {opened.current.has("ssh") && tabs.includes("ssh") && (
            <div className="connect-tab" data-tab-panel="ssh" hidden={tab !== "ssh"}>
              <SshTab found={found} machines={machines} onAddPc={onAddPc!} onConnectMachine={onConnectMachine} />
              {codeTab === "ssh" && pairByCode}
              {portal?.supported === true && <PortalRow readOnly={readOnly} status={portal} />}
            </div>
          )}
          {opened.current.has("relay") && tabs.includes("relay") && (
            <div className="connect-tab" data-tab-panel="relay" hidden={tab !== "relay"}>
              <RelayTab relay={relay} closesGate={closesGate} signedIn={signedIn} accountId={accountId} provider={provider} joinBySignIn={joinBySignIn} account={account} phone={phone}
                pcAddFromAccount={pcAddFromAccount} onAccountSetup={onAccountSetup}
                active={tab === "relay"} onPairingHeld={onPairingHeld} onRevokedAll={onRevokedAll} machines={machines} onConnectMachine={onConnectMachine} addsOverSsh={addsOverSsh && tabs.includes("tailscale")} pairShared={sharedCode} />
              {codeTab === "relay" && !codeOnTop && pairByCode}
              {addsOverSsh && tabs.includes("tailscale") && <ReachablePcList found={found} accountPcs={inAccount} onAddPc={onAddPc!} />}
            </div>
          )}
        </div>
      </div>
    </div>
    </SettingsQuery.Provider>,
    document.body,
  );
}

/**
 * The PCs this PC's server could reach over SSH (its ssh config, its Tailscale login), for the Tailscale and SSH
 * tabs. A window the server will not tell (owner_only, read_only) gets an empty list that says nothing of the PC
 * (`unread`); one refused as owner_only is told where the list can be seen, so an empty tab is not taken for a PC that
 * knows none.
 */
export type FoundPcs = ReturnType<typeof useFoundPcs>;

/** read once per dialog, for both tabs, so their lists, version rules and retry agree; `enabled` false reads nothing */
export function useFoundPcs(machines: readonly Machine[], enabled = true) {
  const [found, setFound] = useState<SshCandidate[] | null>(null);
  const [failed, setFailed] = useState(false);
  // refused or failed: the empty list is not the PC's answer
  const [unread, setUnread] = useState(false);
  // the server keeps its list from this window (owner_only): one line above the field says where it can be seen
  const [withheld, setWithheld] = useState(false);
  const [reads, setReads] = useState(0);
  // what each PC of the Tailscale login says of itself, by its MagicDNS name: its Ovis's age and its relay ID
  const [tailnet, setTailnet] = useState<ReachableFacts["tailnet"]["pcs"]>(new Map());
  const [tailnetRead, setTailnetRead] = useState(false);
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    setTailnetRead(false);
    findTailnetPcs().then(({ pcs }) => {
      if (live) setTailnet(new Map(pcs.map((pc) => [new URL(pc.url).hostname.toLowerCase(), { outdated: pc.outdated, server_id: pc.server_id ?? null }])));
    }, () => undefined).finally(() => { if (live) setTailnetRead(true); });
    return () => { live = false; };
  }, [reads, enabled]);
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    setFailed(false);
    setUnread(false);
    setWithheld(false);
    findSshCandidates().then(({ pcs }) => { if (live) setFound(pcs); }, (error: unknown) => {
      const refused = error instanceof ApiError && (error.code === "owner_only" || error.code === "read_only");
      if (!refused) console.warn("Ovis: the PCs to add over SSH could not be read", error instanceof Error ? error.name : error);
      if (!live) return;
      setFound([]);
      setUnread(true);
      setFailed(!refused);
      // a watching device (read_only) adds no PC: it is told nothing new
      setWithheld(error instanceof ApiError && error.code === "owner_only");
    });
    return () => { live = false; };
  }, [reads, enabled]);
  const rows = useMemo(() => found === null ? null : reachablePcs(found), [found]);
  // until the Tailscale PCs' Ovis is known (it asks each PC, a few seconds), one of them waits, so an older one is not added
  const facts = { machines, tailnet: { read: tailnetRead, pcs: tailnet } };
  const rowState = (row: ReachablePc, accountPcs?: ReadonlySet<string>): ReachableState => reachableState(row, accountPcs === undefined ? facts : { ...facts, accountPcs });
  const stateOf = (pc: SshCandidate): ReachableState => rowState(reachablePcs([pc])[0]!);
  const retry = () => { setFound(null); setReads((count) => count + 1); };
  const saved = (row: ReachablePc): Machine | undefined => savedAt(row, machines);
  return { found, rows, unread, failed, withheld, stateOf, rowState, saved, retry };
}

/** The found list's failure with Try again, or where a list this window is refused can be seen. */
function FoundPcsTrouble({ failed, withheld, retry }: { failed: boolean; withheld: boolean; retry: () => void }) {
  const t = useT();
  return (
    <>
      {failed && (
        <div className="connect-found-failed" role="alert">
          <p className="settings-hint">{t("The PCs this PC knows could not be read.")}</p>
          <button type="button" className="btn" onClick={retry}><RefreshCw aria-hidden="true" />{t("Try again")}</button>
        </div>
      )}
      {withheld && <p className="settings-hint" role="status">{t("See the PCs this PC knows on this PC itself, or from a device paired with it directly.")}</p>}
    </>
  );
}

/**
 * Tailscale: the PCs of this PC's Tailscale login, one row a machine as Tailscale's own machine list has them (the ssh
 * config aliases that reach one are that row, reachablePcs), then a field for a PC not in the list, connected as the
 * SSH tab connects a typed one.
 */
export function TailscaleTab({ found: { rows, unread, failed, withheld, rowState, retry }, onAddPc, onConnectMachine }: {
  found: FoundPcs; onAddPc: (preset?: AddPcPreset) => void; onConnectMachine: (machine: Machine) => void;
}) {
  const t = useT();
  const pcs = rows?.filter((pc) => pc.way === "tailscale") ?? null;
  return (
    <>
      <p className="settings-description">{t("The PCs of this Tailscale login. Connect goes over SSH, with nothing to install there.")}</p>
      {pcs === null ? <p className="settings-hint" role="status">{t("Looking for PCs…")}</p>
        : pcs.length > 0 ? (
          <div className="connect-found">
            <ul className="connect-found-list connect-reach-list">
              {pcs.map((pc) => {
                const state = rowState(pc);
                return (
                  <li key={pc.key} className="connect-found-row">
                    <span className="connect-found-name">{pc.name}</span>
                    <span className="connect-found-detail">{atDots(pc.address)}</span>
                    {state === "added" ? <span className="connect-found-added"><Check aria-hidden="true" />{t("Added")}</span>
                      : state === "outdated" ? <span className="settings-hint">{t("Update Ovis on that PC to 0.5 first.")}</span>
                      : <button type="button" className="btn" disabled={state === "waiting"} aria-label={`${t("Connect")} ${pc.name}`} onClick={() => onAddPc({ destination: pc.destination, name: pc.name })}>{t("Connect")}</button>}
                  </li>
                );
              })}
            </ul>
          </div>
        ) : !unread && <p className="settings-hint" role="status">{t("No other PC of this Tailscale login was found.")}</p>}
      <FoundPcsTrouble failed={failed} withheld={withheld} retry={retry} />
      <TypedPcForm label={t("A PC not in the list")} placeholder={t("user@host or address")} onAddPc={onAddPc} onConnectMachine={onConnectMachine} />
    </>
  );
}

/**
 * The relay tab's other PCs, where Add PC over SSH adds a PC to the account (this PC's own window, signed in to the
 * account this PC is in): the Tailscale login's PCs and the ssh config's hosts in one list, the Tailscale tab's rows
 * with their way. Add, and a PC typed at the foot, open Add PC with that host filled in and Add it to my account
 * ticked, which reaches that PC's own Ovis over SSH, offers to install it, and adds it to the account
 * (docs/account.md "Adding a PC over SSH"). A PC in the account, here already or with an older Ovis says so instead.
 */
export function ReachablePcList({ found: { rows, failed, withheld, rowState, saved, retry }, accountPcs, onAddPc }: {
  found: FoundPcs; accountPcs: ReadonlySet<string>; onAddPc: (preset?: AddPcPreset) => void;
}) {
  const t = useT();
  const id = useId();
  const [typed, setTyped] = useState("");
  // another PC's https address is no SSH address: the add over SSH cannot take it (the SSH tab's Add by address can)
  const [notSsh, setNotSsh] = useState(false);
  const host = typed.trim();
  const way: Record<ReachablePc["way"], string> = { tailscale: "Tailscale", ssh_config: t("SSH config") };
  const add = (event: FormEvent) => {
    event.preventDefault();
    if (host === "") return;
    if (OVIS_ADDRESS.test(host)) { setNotSsh(true); return; }
    onAddPc({ destination: host });
  };
  return (
    <section className="connect-reachable">
      <p className="settings-description">{t("Other PCs this PC can reach. Add goes in over SSH, installs Ovis there if it is missing, and adds it to your account.")}</p>
      {rows === null ? <p className="settings-hint" role="status">{t("Looking for PCs…")}</p>
        : rows.length > 0 && (
          <ul className="connect-found-list connect-reach-list">
            {rows.map((pc) => {
              const state = rowState(pc, accountPcs);
              // a PC saved here that is not in the account is added on that same PC, never as a second one
              const here = state === "open" ? saved(pc) : undefined;
              return (
                <li key={pc.key} className="connect-found-row" data-reachable-state={state}>
                  <span className="connect-found-name">{pc.name}</span>
                  <span className="connect-found-detail">{way[pc.way]} · {atDots(pc.address)}</span>
                  {state === "in-account" ? <span className="connect-found-added"><Check aria-hidden="true" />{t("In your account")}</span>
                    : state === "added" ? <span className="connect-found-added"><Check aria-hidden="true" />{t("Added")}</span>
                    : state === "outdated" ? <span className="settings-hint">{t("Update Ovis on that PC to 0.5 first.")}</span>
                    : <button type="button" className="btn" disabled={state === "waiting"} aria-label={`${t("Add")} ${pc.name}`} onClick={() => onAddPc({ destination: pc.destination, name: pc.name, ...(here === undefined ? {} : { machine_id: here.id }) })}>{t("Add")}</button>}
                </li>
              );
            })}
          </ul>
        )}
      <FoundPcsTrouble failed={failed} withheld={withheld} retry={retry} />
      <form className="connect-ssh-form" onSubmit={add}>
        <label className="settings-label" htmlFor={`${id}-host`}>{t("A PC not in the list")}</label>
        <div className="connect-ssh-field">
          <input id={`${id}-host`} className="input" type="text" value={typed} placeholder="user@host" autoComplete="off" spellCheck={false} autoCapitalize="off" autoCorrect="off" aria-invalid={notSsh || undefined} aria-describedby={notSsh ? `${id}-not-ssh` : undefined} onChange={(event) => { setNotSsh(false); setTyped(event.target.value); }} />
          <button type="submit" className="btn" disabled={host === ""}>{t("Add")}</button>
        </div>
        {notSsh && <p className="settings-hint" id={`${id}-not-ssh`} role="alert">{t("Enter an SSH address, such as user@host.")}</p>}
      </form>
    </section>
  );
}

function addressFailureText(t: ReturnType<typeof useT>, error: unknown): string {
  const code = error instanceof ApiError && typeof error.code === "string" && error.code.startsWith("address_pc_") ? error.code.slice("address_pc_".length) : null;
  const failure: AddressPcFailure | undefined = ADDRESS_PC_FAILURES.find((known) => known === code);
  switch (failure) {
    case "address": return t("Enter only that PC's Ovis address, starting with https://");
    case "target": return t("That address cannot be another PC's Ovis.");
    case "code": return t("Type the six-digit code that PC shows.");
    case "wrong_code": return t("That code is wrong, spent or expired. Show a new code on that PC and type it.");
    case "waiting": return t("That PC refuses codes for a while after wrong ones. Wait a minute, then try again.");
    case "unreachable": return t("No PC answered at that address. Check it, and that Ovis runs there.");
    case "not_ovis": return t("No Ovis that pairs devices answered at that address. Update Ovis there, or check the address.");
    case "added": return t("That PC is already added.");
    case "self": return t("That address is this PC's own Ovis.");
    default: return t("That PC could not be added. Try again.");
  }
}

/**
 * A PC typed in, the SSH and Tailscale tabs' one connect for it: an SSH alias, user@host or a tailnet name opens Add PC
 * with it (the host's fingerprint first); another PC's https address opens AddressPcForm with it, where the code that PC
 * shows is typed. `byAddressLink`: Add by address, a text link under the field, opens that form empty.
 */
function TypedPcForm({ label, placeholder, byAddressLink = false, onAddPc, onConnectMachine }: {
  label: string; placeholder: string; byAddressLink?: boolean; onAddPc: (preset?: AddPcPreset) => void; onConnectMachine: (machine: Machine) => void;
}) {
  const t = useT();
  const id = useId();
  const [typed, setTyped] = useState("");
  // the address form, once opened: with the address it opens on (an https address typed in the field moves there)
  const [byAddress, setByAddress] = useState<string | null>(null);
  const address = typed.trim();
  const add = (event: FormEvent) => {
    event.preventDefault();
    if (address === "") return;
    if (OVIS_ADDRESS.test(address)) { setByAddress(address); setTyped(""); return; }
    onAddPc({ destination: address });
  };
  return (
    <>
      <form className="connect-ssh-form" onSubmit={add}>
        <label className="settings-label" htmlFor={`${id}-address`}>{label}</label>
        <div className="connect-ssh-field">
          <input id={`${id}-address`} className="input" type="text" value={typed} placeholder={placeholder} autoComplete="off" spellCheck={false} autoCapitalize="off" autoCorrect="off" aria-describedby={address === "" ? undefined : `${id}-kind`} onChange={(event) => setTyped(event.target.value)} />
          <button type="submit" className="btn" disabled={address === ""}>{t("Connect")}</button>
        </div>
        {address !== "" && !OVIS_ADDRESS.test(address) && <p className="settings-hint" id={`${id}-kind`} role="status" data-address-kind="ssh">{t("An SSH address: Connect checks that PC's fingerprint first.")}</p>}
      </form>
      {byAddressLink && <button type="button" className="connect-address-link" aria-expanded={byAddress !== null} aria-controls={`${id}-by-address`} onClick={() => setByAddress((open) => open === null ? "" : null)}>{t("Add by address")}</button>}
      {byAddress !== null && <AddressPcForm key={byAddress} id={`${id}-by-address`} initial={byAddress} onConnectMachine={onConnectMachine} />}
    </>
  );
}

/**
 * SSH: its one field (TypedPcForm) takes an SSH alias, user@host or a tailnet name, or another PC's Ovis by its https
 * address and the code that PC shows. Under it the hosts of this PC's ssh config and the PCs saved in herdr, one press each.
 */
export function SshTab({ found: { found, failed, withheld, stateOf, retry }, machines, onAddPc, onConnectMachine }: { found: FoundPcs; machines: readonly Machine[]; onAddPc: (preset?: AddPcPreset) => void; onConnectMachine: (machine: Machine) => void }) {
  const t = useT();
  const saved = machines.filter((machine) => machine.herdr_profile_id !== undefined && machine.action_required === "connect");
  const hosts = (found?.filter((pc) => pc.source === "ssh_config") ?? []).map((pc) => ({ pc, state: stateOf(pc) }));
  const outdated = hosts.filter(({ state }) => state === "outdated").map(({ pc }) => pc.name);
  return (
    <>
      <TypedPcForm label={t("Add another PC from this one")} placeholder="user@host" byAddressLink onAddPc={onAddPc} onConnectMachine={onConnectMachine} />
      {(saved.length > 0 || hosts.length > 0) && (
        <section className="connect-picks" aria-label="ssh config">
          <p className="settings-label">ssh config</p>
          <div className="connect-picks-list">
            {saved.map((machine) => <button key={`herdr:${machine.id}`} type="button" className="btn" title={machine.target?.destination} onClick={() => onConnectMachine(machine)}>{machine.name}</button>)}
            {hosts.map(({ pc, state }) => state === "added"
              ? <span key={pc.destination} className="connect-found-added" data-pick-state={state}><Check aria-hidden="true" />{pc.name} · {t("Added")}</span>
              : <button key={pc.destination} type="button" className="btn" disabled={state !== "open"} data-pick-state={state} title={pc.detail ?? undefined}
                  onClick={() => onAddPc({ destination: pc.destination, name: pc.name })}>{pc.name}</button>)}
          </div>
          {outdated.length > 0 && <p className="settings-hint">{outdated.join(", ")}: {t("Update Ovis on that PC to 0.5 first.")}</p>}
        </section>
      )}
      {found === null && <p className="settings-hint" role="status">{t("Looking for PCs…")}</p>}
      <FoundPcsTrouble failed={failed} withheld={withheld} retry={retry} />
    </>
  );
}

/**
 * Add by address: another PC's Ovis by its https address takes the six-digit code that PC shows and opens it in this
 * window once this PC's server paired with it (server/address-pc.ts); the code stays in its input alone.
 */
function AddressPcForm({ id, initial, onConnectMachine }: { id: string; initial: string; onConnectMachine: (machine: Machine) => void }) {
  const t = useT();
  const [typed, setTyped] = useState(initial);
  const [adding, setAdding] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const codeRef = useRef<HTMLInputElement>(null);
  // a second press before the first one's render would spend the same code twice
  const pairing = useRef(false);
  // what the pairing in flight was asked for: its answer is dropped once the address changes or the tab closes
  const asked = useRef<string | null>(null);
  useEffect(() => () => { asked.current = null; }, []);
  // the code admits whoever holds it: it is typed only where it cannot cross the network in clear (as an SSH password)
  const secretAllowed = window.isSecureContext;
  const address = typed.trim();
  const add = (event: FormEvent) => {
    event.preventDefault();
    const code = codeRef.current;
    if (address === "" || code === null || pairing.current || !secretAllowed) return;
    pairing.current = true;
    asked.current = address;
    setAdding(true);
    setFailure(null);
    const current = () => asked.current === address;
    void addAddressPc(address, code.value.replace(/\s/g, "")).then(({ machine }) => {
      if (!current()) return;
      code.value = "";
      if (machine && typeof machine.id === "string") onConnectMachine(machine); else setFailure(t("That PC could not be added. Try again."));
    }, (error: unknown) => { if (current()) setFailure(addressFailureText(t, error)); })
      .finally(() => { pairing.current = false; setAdding(false); });
  };
  return (
    <form id={id} className="connect-ssh-form connect-address-form" onSubmit={add}>
      <label className="settings-label" htmlFor={`${id}-input`}>{t("PC address")}</label>
      <input id={`${id}-input`} className="input" type="url" inputMode="url" value={typed} placeholder="https://my-pc.example.com" autoComplete="off" spellCheck={false} autoCapitalize="off" autoCorrect="off" autoFocus onChange={(event) => {
        // a code typed for one PC is never sent to another
        if (codeRef.current) codeRef.current.value = "";
        asked.current = null;
        setFailure(null);
        setTyped(event.target.value);
      }} />
      <label className="settings-label" htmlFor={`${id}-code`}>{t("Pairing code")}</label>
      <div className="connect-ssh-field">
        <input ref={codeRef} id={`${id}-code`} className="input connect-address-code" type="text" inputMode="numeric" autoComplete="one-time-code" maxLength={7} placeholder="000000" required pattern="\d{3} ?\d{3}" spellCheck={false} disabled={adding || !secretAllowed} />
        <button type="submit" className="btn" disabled={address === "" || adding || !secretAllowed}>{t("Connect")}</button>
      </div>
      <p className="settings-hint" data-address-kind="ovis">{t("The code is on that PC under Pair with a code.")}</p>
      {!secretAllowed && <p className="settings-hint">{t("Needs HTTPS or localhost.")}</p>}
      {failure !== null && <p className="settings-hint" role="alert">{failure}</p>}
    </form>
  );
}

/** What pairing a device without signing in can offer on this page; `any` is false when it offers nothing. */
export interface LocalWays {
  /** the address a phone opens, as a QR code */
  address: string | null;
  /** this PC's Tailscale is one step from giving a phone an address: the step to show (owner's page of this PC only) */
  tailscaleStep: Extract<PhonePlan, { kind: "missing" | "stopped" | "command" }> | null;
  /**
   * a six-digit code: with a QR code where the page knows an address a phone opens, else typed where this PC's Ovis is
   * open another way (Portal, a proxy, another PC adding it by its address)
   */
  code: boolean;
  portal: boolean;
  any: boolean;
}

/**
 * The ways to pair a device without signing in: an address a phone opens, the pairing code, Portal, and with no
 * address the one Tailscale step that would make one.
 */
export function localWays({ plan, readOnly, canPair, portal }: { plan: PhonePlan; readOnly: boolean; canPair: boolean; portal: PortalStatus | null }): LocalWays {
  const shell = inRelayShell();
  const address = plan.kind === "here" || plan.kind === "served" ? plan.url : null;
  const tailscaleStep = address === null && !readOnly && !shell && (plan.kind === "missing" || plan.kind === "stopped" || plan.kind === "command") ? plan : null;
  const code = canPair && !readOnly;
  const portalShown = portal?.supported === true && (portal.phase !== "idle" || (portal.usable && portal.blocked === null));
  return { address, tailscaleStep, code, portal: portalShown, any: address !== null || tailscaleStep !== null || code || portalShown };
}

/** What a phone scans on each way's tab, under that way's own part: the QR code and the code it carries, or the step that gives this PC an address a phone opens. */
function PhoneScan({ children }: { children: ReactNode }) {
  const t = useT();
  return (
    <section className="connect-phone-scan" aria-label={t("Phone")} data-testid="connect-phone-scan">
      <p className="settings-label connect-phone-scan-title"><Smartphone aria-hidden="true" />{t("Scan it with the Ovis app on your phone")}</p>
      {children}
    </section>
  );
}

/**
 * Pair with a code: the six-digit code a device types where it opens this PC's Ovis (Portal, a proxy, another PC adding
 * this one by its https address). Made on a press, as the relay tab opens by itself; one the Tailscale tab made shows here.
 */
function PairByCode({ shared, phone }: { shared: MutableRefObject<SharedCode>; phone: boolean }) {
  const t = useT();
  return (
    <section className="connect-section" aria-label={t("Pair with a code")} data-testid="pair-with-code">
      <p className="settings-label">{t("Pair with a code")}</p>
      <CodeRoute pairUrl={null} startAtOnce={false} shared={shared} phone={phone} compact />
    </section>
  );
}

/** where the guide says how to install Portal and run it with a token (docs/guide.md) */
const PORTAL_HELP = "https://github.com/devswha/ovis/blob/main/docs/guide.md#behind-a-reverse-proxy";

/**
 * Portal at the foot of the SSH tab, always: one row. Where it can run, its controls (PortalPanel) behind Settings; where it
 * cannot (not installed, too old, or no token here), one line why and the guide's way to it, and nothing to press.
 */
function PortalRow({ readOnly, status }: { readOnly: boolean; status: PortalStatus }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const id = useId();
  const ready = status.phase !== "idle" || (status.usable && status.blocked === null);
  if (!ready) {
    const [line, link] = !status.usable
      ? [status.version === null ? t("Portal is not installed on this PC.") : t("Update Portal on this PC to {version} or later.", { version: status.min_version }), t("How to install")]
      : [status.blocked === "serve_only" ? t("Portal is off while only tailscale serve may reach this PC.") : t("Portal needs an access token on this PC."), t("How to set up")];
    return (
      <section className="connect-section connect-portal" aria-label="Portal" data-testid="portal-row">
        <div className="connect-portal-row">
          <span className="settings-label">Portal</span>
          <span className="settings-hint connect-portal-state">{line}</span>
          <ExternalLink kind="link" className="settings-link connect-portal-help" href={PORTAL_HELP}>{link}</ExternalLink>
        </div>
      </section>
    );
  }
  return (
    <section className="connect-section connect-portal" aria-label="Portal" data-testid="portal-row">
      <div className="connect-portal-row">
        <span className="settings-label">Portal</span>
        <span className="settings-hint connect-portal-state">{status.url ?? (status.phase === "idle" ? t("Not running") : t("Starting…"))}</span>
        <button type="button" className="btn" aria-expanded={open} aria-controls={id} onClick={() => setOpen((shown) => !shown)}>{t("Settings")}</button>
      </div>
      {open && <div id={id}><PortalPanel readOnly={readOnly} /></div>}
    </section>
  );
}

/** With no way to add a PC on this page (a phone's page, the hosted shell, a device that only watches), what pairs a device without signing in. */
function LocalWay({ plan, pairUrl, readOnly, local, phone, platform, onAccess }: { plan: PhonePlan; pairUrl: string | null; readOnly: boolean; local: LocalWays; phone: boolean; platform: string | undefined; onAccess: (access: RemoteAccess) => void }) {
  const t = useT();
  if (!local.any) return <p className="settings-description">{t("Open Ovis on the PC itself to add a connection.")}</p>;
  const needsTailscale = <p className="settings-hint">{t("The phone needs the Tailscale app turned on too.")}</p>;
  // the hosted shell's page is no address of this PC: its code is typed, as before
  const codeUrl = inRelayShell() ? null : pairUrl;
  return (
    <>
      {local.address !== null && (
        <section className="connect-section" aria-label="Tailscale">
          <p className="settings-label">Tailscale</p>
          <PhonePanel url={local.address} phone={phone} />
          {plan.kind === "served" && needsTailscale}
        </section>
      )}
      {local.tailscaleStep !== null && (
        <section className="connect-section" aria-label="Tailscale" data-tailscale={local.tailscaleStep.kind}>
          <p className="settings-label">Tailscale</p>
          <TailscaleStep step={local.tailscaleStep} platform={platform} onAccess={onAccess} />
          {needsTailscale}
        </section>
      )}
      {local.code && (
        <section className="connect-section" aria-label={t("Pairing code")}>
          <p className="settings-label">{t("Pairing code")}</p>
          {codeUrl === null && <p className="settings-description">{t("Type it on the other device where it opens this PC's Ovis: at its Portal address, through a proxy, or from another PC adding this one by its address.")}</p>}
          {/* the hosted shell makes its code on a press: opening the sheet there asks the PC for nothing */}
          <CodeRoute pairUrl={codeUrl} startAtOnce={!inRelayShell()} phone={phone} compact />
        </section>
      )}
      {local.portal && (
        <section className="connect-section" aria-label="Portal">
          {/* the hosted shell is no local window of this PC: Portal's controls are local only (account-row-rights.ts) */}
          <PortalPanel readOnly={readOnly || inRelayShell()} />
        </section>
      )}
    </>
  );
}

const tailscaleStepKind = (plan: PhonePlan): boolean => plan.kind === "missing" || plan.kind === "stopped" || plan.kind === "command";

/**
 * While `active` (a Tailscale step is on screen), reads this PC's Tailscale again every TAILSCALE_POLL_MS and whenever
 * the window comes back to the front, so turning Tailscale on or signing in moves the step on with nothing else to do.
 * It stops when the step is gone or the dialog closes.
 */
function useTailscaleWatch(active: boolean, onAccess: (access: RemoteAccess) => void) {
  useEffect(() => {
    if (!active) return;
    let live = true;
    const read = () => { fetchRemoteAccess().then((access) => { if (live) onAccess(access); }, () => undefined); };
    const timer = window.setInterval(read, TAILSCALE_POLL_MS);
    window.addEventListener("focus", read);
    return () => { live = false; window.clearInterval(timer); window.removeEventListener("focus", read); };
  }, [active, onAccess]);
}

/**
 * The one Tailscale step that would give a phone an address, each one press with no terminal: get Tailscale (its
 * download for this PC's platform), open the Tailscale app to turn it on and sign in (macOS and Windows; Linux has no
 * app, so one line says so), or have this PC's server serve Ovis on the tailnet. Only a serve Tailscale refused shows
 * the command, as the way left.
 */
function TailscaleStep({ step, platform, onAccess }: { step: NonNullable<LocalWays["tailscaleStep"]>; platform: string | undefined; onAccess: (access: RemoteAccess) => void }) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const [refused, setRefused] = useState<{ operator: boolean; ownerUnknown: boolean } | null>(null);
  const [noApp, setNoApp] = useState(false);
  if (step.kind === "missing") return (
    <>
      <p className="settings-description">{t("Tailscale isn't installed.")}</p>
      <div className="phone-actions"><ExternalLink kind="link" className="btn" href={TAILSCALE_DOWNLOADS[platform ?? ""] ?? TAILSCALE_DOWNLOAD}>{t("Get Tailscale")}</ExternalLink></div>
    </>
  );
  if (step.kind === "stopped") {
    if (noApp || (platform !== "darwin" && platform !== "win32")) return <p className="settings-description">{t("Turn on Tailscale and sign in.")}</p>;
    const open = () => {
      setBusy(true);
      void openTailscaleApp().catch(() => false).then((opened) => { setBusy(false); if (!opened) setNoApp(true); });
    };
    return (
      <>
        <p className="settings-description">{t("Tailscale on this PC is off or not signed in.")}</p>
        <div className="phone-actions"><button type="button" className="btn" disabled={busy} onClick={open}>{t("Open Tailscale")}</button></div>
      </>
    );
  }
  const serve = () => {
    setBusy(true);
    setRefused(null);
    void serveOnTailscale().catch(() => ({ ok: false as const, code: null, operator: false })).then((answer) => {
      setBusy(false);
      if (answer.ok) onAccess(answer.access);
      else setRefused({ operator: answer.operator, ownerUnknown: answer.code === "tailscale_owner_unknown" });
    });
  };
  return (
    <>
      <p className="settings-description">{t("Tailscale is on, but Ovis is not open at a Tailscale address yet.")}</p>
      <div className="phone-actions">
        <button type="button" className="btn" disabled={busy} aria-busy={busy} onClick={serve}>{busy ? t("Opening…") : t("Open with Tailscale")}</button>
      </div>
      {/* this PC's Tailscale login is not known: no serve, and no command that would serve it anyway */}
      {refused?.ownerUnknown === true && <p className="settings-description" role="status" data-testid="tailscale-owner-unknown">{t("This PC's Tailscale login can't be confirmed, so it can't be opened. Check the sign-in in the Tailscale app.")}</p>}
      {refused !== null && !refused.ownerUnknown && (
        <div data-testid="tailscale-serve-refused">
          <p className="settings-description" role="status">{t("Tailscale didn't allow it. Run this once on this PC:")}</p>
          <CommandToCopy command={step.command} />
          {refused.operator && (
            <>
              <p className="settings-hint">{t("Or allow it once, then press Open with Tailscale again:")}</p>
              <CommandToCopy command={TAILSCALE_OPERATOR} />
            </>
          )}
        </div>
      )}
    </>
  );
}

function CommandToCopy({ command }: { command: string }) {
  const t = useT();
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1600);
    return () => window.clearTimeout(timer);
  }, [copied]);
  return (
    <div className="connect-command">
      <code>{command}</code>
      <button type="button" className="btn btn-ghost" onClick={() => void copyText(command).then((ok) => { if (ok) setCopied(true); })}>{t(copied ? "Copied" : "Copy")}</button>
    </div>
  );
}

/**
 * The Ovis relay, the owner's on a direct page. With an account, either state ends in AccountQr: the relay's QR code
 * behind a press for a PC in no account, and for a PC that is in one a QR code that opens this PC's page in the Ovis
 * app, which signs in to that account and joins it there (no code, key or token in it).
 */
export function RelayTab({ relay, closesGate, signedIn, accountId = null, provider = null, joinBySignIn, account, phone, active = true, onPairingHeld, onRevokedAll, machines = [], onConnectMachine, pcAddFromAccount, onAccountSetup, addsOverSsh = false, pairShared }: {
  pcAddFromAccount?: PcAccountStatus["pcAddFromAccount"]; onAccountSetup?: (() => void) | undefined;
  /** this PC's own window, signed in to the account this PC is in (ConnectPhoneDialog `addsOverSsh`): the top is laid out as the Tailscale tab's (AccountQr `pairHere`) */
  addsOverSsh?: boolean;
  /** the dialog's one pending six-digit code, which that top's Pair with a code shares */
  pairShared?: MutableRefObject<SharedCode>;
  relay: RelayState; closesGate: boolean; signedIn: boolean; joinBySignIn: boolean; account: RelayAccount | null; phone: boolean;
  accountId?: string | null;
  provider?: AccountProvider | null;
  active?: boolean;
  onPairingHeld?: (held: boolean) => void;
  onRevokedAll?: () => void;
  machines?: readonly Machine[]; onConnectMachine?: (machine: Machine) => void;
}) {
  const t = useT();
  // signed in to the PC's own account, the tab is the signed-in line and the phone's QR code (the account's PCs are in
  // the sidebar); signed in to another, the prompt opens the account. A window signed out of a PC in an account gets the sign-in alone (below), not this prompt beside it
  const accountAdd = pcAddFromAccount === true && onConnectMachine && !(signedIn && joinBySignIn) ? (
      <div className="connect-found" data-testid="pc-add-source-bound">
        <p className="settings-hint">{t("This PC is in an account. Add PCs from your account.")}</p>
        <button type="button" className="btn btn-secondary" onClick={() => { (onAccountSetup ?? account?.onOpen)?.(); }}>{t("Add from account")}</button>
      </div>
  ) : null;
  const [switchError, setSwitchError] = useState<string | null>(null);
  const [signedInProvider, setSignedInProvider] = useState<AccountSession["provider"] | null>(null);
  const [pcAccount, setPcAccount] = useState<string | null | undefined>(undefined);
  const signInView = useRef<HTMLDivElement>(null);
  /** the sign-in that just finished on this tab, handed once to Add this PC below, which offers its one press at once */
  const signedInHere = useRef<SignedInHere | null>(null);
  const takeSignedInHere = useCallback((): SignedInHere | null => { const fresh = signedInHere.current; signedInHere.current = null; return fresh; }, []);
  // a sheet opened already signed in gets the same next step as one signed in just now: the relay's own button when it is off
  const mineNow = signedIn ? accountId : null;
  const takeSignedInNow = useCallback((): SignedInHere | null => takeSignedInHere() ?? (mineNow === null ? null : { account: mineNow, adds: false }), [takeSignedInHere, mineNow]);
  /** signed in, the tab has no sign-in of its own: Add this PC's one sign-in again is this page's own */
  const signInAgain = useSignInAgainHere();
  useLayoutEffect(() => {
    const view = signInView.current;
    if (!signedIn || signedInProvider === null || view === null || view.closest("[hidden]") !== null) return;
    // the add button comes a moment after the sign-in (it reads the PC first): until then the sheet's own title holds the focus
    const dialog = view.closest('[role="dialog"]');
    const next = view.querySelector<HTMLElement>("button:not(:disabled), a[href]")
      ?? dialog?.querySelector<HTMLElement>("h2") ?? dialog?.querySelector<HTMLElement>(".modal-title");
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
  const connecting = on && relay.status?.phase !== "online";
  const relaySwitch = switchable && (
    <div className="connect-relay-switch" aria-busy={connecting || undefined} title={closesGate && !on ? t("Turning on the relay closes the device gate: a new browser then needs a pairing code or the access token.") : undefined}>
      <span className="settings-label">{t("Let this PC be reached from anywhere")}{connecting && <span className="connect-relay-state" role="status"> · {statusText(t, relay.status!)}</span>}</span>
      <Toggle label={t("Ovis relay")} checked={on} onChange={(next) => { if (!relay.pending) void switchRelay(next); }} />
    </div>
  );
  const switchFailure = switchError !== null && <p className="settings-hint relay-error" role="alert">{switchError}</p>;
  if (pcAddFromAccount === "unavailable") return (
    <>
      <p className="settings-hint" role="status">{t("Can't add a PC right now. Try again in a moment.")}</p>
      {relaySwitch}
      {switchFailure}
    </>
  );
  if (account === null) return (
    <>
      {accountAdd}
      {relaySwitch}
      {switchFailure}
      <RelayRoute relay={relay} readOnly={false} phone={phone} compact />
    </>
  );
  const startFailure = switchError === null && startError !== null && <p className="settings-hint relay-error" role="alert">{t("The relay did not start: {message}", { message: startError })}</p>;
  const pcIn = pcAccount !== undefined ? pcAccount : joinBySignIn ? (signedIn ? accountId : null) : null;
  // a sign-in to another account than the one this PC is in (a way in that account does not have makes a new account)
  // is no sign-in to this PC: the tab stays its sign-in buttons, so the right one can be picked (owner #25)
  const inThisAccount = signedIn && !(accountId !== null && pcIn !== null && accountId !== pcIn);
  const mine = signedIn ? accountId : null;
  const bare = inThisAccount && pcIn !== null && relay.status?.phase === "online";
  const qr = (ownSwitch: boolean) => (
    <AccountQr relay={relay} phone={phone} active={active} signedIn={signedIn} accountId={mine} provider={provider} serverId={machines.find((machine) => machine.kind === "local")?.server_id ?? null}
      pcAccount={pcIn} onPcAccount={setPcAccount} onPairingHeld={onPairingHeld} onRevokedAll={onRevokedAll}
      first={bare} pairHere={addsOverSsh} {...(pairShared === undefined ? {} : { pairShared })} relayControls={ownSwitch ? <>{relaySwitch}{switchFailure}{startFailure}</> : null} />
  );
  // signed out the tab is its sign-in buttons: the relay's own switch stays in More settings. Keyed by the account, so
  // a sign-in that ended in another account shows the buttons again
  if (!inThisAccount) return (
    <>
      <div ref={signInView} className="connect-signin" data-testid="connect-signin">
        {signInStatus}
        <RelaySignIn key={accountId ?? ""} service={account.service} onSignedIn={(session) => { signedInHere.current = { account: session.account, adds: false }; setSignedInProvider(session.provider); account.onSignedIn(on && pcIn !== null && session.account === pcIn); }} />
      </div>
      {qr(false)}
    </>
  );
  return (
    <>
      <div ref={signInView} className="connect-signin" data-testid="connect-signin" data-bare={bare || undefined}>
        {signInStatus}
        {accountAdd}
        {pcIn !== null ? (
          !bare && <>{relaySwitch}{switchFailure}{startFailure}</>
        ) : (
          <>
            {/* one button: with the relay off, it turns the relay on as it adds the PC */}
            {startFailure}
            <AddThisPc relayOn={on} gateNote={false} signedInHere={takeSignedInNow} signInAgain={signInAgain} {...(account.opensAll === undefined ? {} : { opensAll: account.opensAll })} />
          </>
        )}
        {pcIn !== null && <InviteElsewhere account={pcIn} />}
      </div>
      {qr(false)}
    </>
  );
}

/**
 * Where an invite for another PC is made, said on the page of a PC that follows the signed list of `account`, the
 * account signed in to here (docs/account-list.md, "Invites"). Only a device in that list signs one, in the phone apps
 * or the hosted app (ConnectStart's AccountRelayPanel): a PC's page holds no copy of the list, and the PC signs none.
 * An account with no list has no invites, so nothing is said of them there.
 */
function InviteElsewhere({ account }: { readonly account: string }) {
  const t = useT();
  const [follows, setFollows] = useState(false);
  useEffect(() => {
    let live = true;
    fetchListAccount().then((listed) => { if (live) setFollows(listed === account); }, (error: unknown) => {
      console.warn("Ovis: whether this PC follows its account's list could not be read", error instanceof Error ? error.name : error);
    });
    return () => { live = false; };
  }, [account]);
  return follows ? <p className="settings-hint" data-testid="invite-elsewhere">{t("To give an agent an invite that adds a PC, make one in the Ovis phone app or at app.ovis.sh: Add PC → Ovis relay → Invite a PC.")}</p> : null;
}

export const ACCOUNT_QR_MAX_MS = 30 * 60_000;
export const ACCOUNT_QR_HIDDEN_MS = 60_000;

/**
 * Takes a QR code that is no longer shown out of use: the six-digit code it carried (`code`, when its offer came) is
 * ended on the PC, only if it is still the one pending, and the typed code bound to it goes with it (server/devices.ts
 * `endPairing`). A code that was not pending any more (used up, or replaced by another window's) ends nothing: the
 * typed code showing on the PC then is not this QR code's.
 * Before the offer came there is nothing to end: this QR code makes no typed code, and the typed code the PC may hold
 * is another place's (the setup guide's), which stays. True when the PC answered: from then on nothing this QR code
 * showed pairs.
 */
async function endShownCode(code: string | null): Promise<boolean> {
  if (code === null) return true;
  try {
    if ((await endPairing(code)).cancelled) announceQrCodeEnded(code);
    return true;
  } catch {
    // the six-digit code runs out by itself within ten minutes
    return false;
  }
}

type AccountQrView =
  | { kind: "idle" }
  | { kind: "starting" }
  | { kind: "shown" }
  | { kind: "alone"; strays: readonly AccountQrStray[]; checking: readonly AccountQrStray[] }
  | { kind: "joined"; account: string; device: string | null; strays: readonly AccountQrStray[]; checking: readonly AccountQrStray[] };

const sameView = (a: AccountQrView, b: AccountQrView): boolean => JSON.stringify(a) === JSON.stringify(b);
const names = (strays: readonly AccountQrStray[]): string => strays.map((stray) => stray.label).join(", ");

/**
 * The relay tab's part under the sign-in, where the page has an Ovis account.
 *
 * On a PC in no account, the relay's QR code behind a press: a signed-in device that scans it is paired with its
 * account key and then links itself and adds the PC (lib/relay/accountController.ts), so the PC joins the scanning
 * device's account with nothing typed and no approval here (docs/account.md, "Adding a PC"). A code admits whoever
 * holds it, so:
 * - nothing is asked of the PC until Phone QR code is pressed, and the code is ended when the QR code comes down:
 *   as the dialog closes or another tab opens, as the page goes (a reload, a closed tab), once the page was hidden
 *   for a minute, and 30 minutes after the press;
 * - the QR code is shown alone: no code to type is made, which could be read off the screen and typed elsewhere;
 * - when the PC goes from no account to one, the QR code gives way to which account, told apart as the one this
 *   browser is signed in to, another one, or one it cannot tell (`accountId`), and to the device that added it: only a
 *   member of that account is named. "Not me: revoke every device" undoes it, and comes first unless the account is
 *   this browser's own;
 * - every device that came since the press and is no member of the PC's account is named and asked about, "Not me:
 *   remove it" first, whether or not the PC joined an account. Which code let it in the page cannot know;
 * - a notice goes only by one of its buttons, and only once nobody is left unanswered, a device still in its ten
 *   seconds included: Done reads the PC once more first. One the dialog closed over waits for the next opening;
 * - a device that took the code just before it was ended links only afterwards: the PC is watched on after the QR
 *   code came down, outside this component (lib/accountQrWatch.ts), and what that finds is shown here.
 *
 * On a PC that is in an account there is no QR code, and no code is asked of the PC for one: whoever scanned it
 * would be paired with a PC that has members, with nobody approving. In its place the part says which account the
 * PC is in and that a device is added by signing in to that account on it. The PC refuses the code too (409
 * `in_account`), and takes back one that is out when it joins an account, so a page that read the PC a moment too
 * early shows none either.
 *
 * On a PC that no account was named for there is no QR code yet either, and no button for one: the PC takes the
 * device that scans it into the account named for it alone, and makes no code before one is named (409
 * `no_account_named`). It says so in its relay state (`account_named`), and in the button's place the part says what
 * names one: a sign-in above for a browser that is signed out, adding the PC to the account for one that is signed in.
 * A press made while the page's relay state said otherwise (it is read every 15 seconds) is refused by the PC: the QR
 * code comes down with no failure to read, and the relay's state is read again, which brings that sentence.
 */
export function AccountQr({ relay, phone, active, signedIn, accountId = null, provider = null, serverId = null, pcAccount, onPcAccount, first = false, pairHere = false, pairShared, relayControls, onPairingHeld, onRevokedAll }: {
  relay: RelayState; phone: boolean; active: boolean; signedIn: boolean;
  first?: boolean;
  /**
   * In this PC's own window, signed in to the account this PC is in: the phone part is laid out as the Tailscale tab's
   * top, the QR code that opens this PC's page beside the six digits of Pair with a code (CodeRoute), which only a press
   * here makes, sharing the dialog's one pending code (`pairShared`); this account's line goes under it. Nothing that
   * admits a device by itself is made as the tab opens: the QR code asks for the account's own approval
   */
  pairHere?: boolean;
  pairShared?: MutableRefObject<SharedCode>;
  accountId?: string | null;
  /** how this page is signed in, and this PC's relay ID: the QR code of a PC in an account (signInLink) */
  provider?: AccountProvider | null;
  serverId?: string | null;
  pcAccount: string | null;
  onPcAccount: Dispatch<SetStateAction<string | null | undefined>>;
  relayControls: ReactNode;
  onPairingHeld?: (held: boolean) => void;
  onRevokedAll?: () => void;
}) {
  const t = useT();
  const id = useId();
  const [view, setView] = useState<AccountQrView>({ kind: "idle" });
  const drawn = useRef(view);
  drawn.current = view;
  const [again, setAgain] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [settling, setSettling] = useState(false);
  const [late, setLate] = useState(accountQrPending);
  /** the PC is in an account whose first member has not finished enrolling it: it does not read as done */
  const [enrolling, setEnrolling] = useState(false);
  useEffect(() => {
    if (!enrolling) return;
    let live = true;
    const timer = setInterval(() => {
      pcAccountStatus(apiFetch).then((status) => {
        if (!live) return;
        // the PC's account as read now: one that left it while enrolling is in no account again, and offers the add once more
        onPcAccount(status.account);
        setEnrolling(status.account !== null && status.enrolling === true);
      }, () => undefined);
    }, ACCOUNT_QR_POLL_MS);
    return () => { live = false; clearInterval(timer); };
  }, [enrolling, onPcAccount]);
  const before = useRef<AccountQrBaseline | null>(null);
  const run = useRef(0);
  /** the account this tab showed when Phone QR code was pressed: its codes' PC is listed there or nowhere */
  const pressedAs = useRef<string | null>(null);
  /** the last take-down's requests: the next press waits for them, so it never ends the code it is about to get */
  const ending = useRef<Promise<boolean>>(Promise.resolve(true));
  const showButton = useRef<HTMLButtonElement>(null);
  const heading = useRef<HTMLParagraphElement>(null);
  const [refocus, setRefocus] = useState(0);
  useLayoutEffect(() => { if (refocus > 0) (showButton.current ?? heading.current)?.focus(); }, [refocus]);

  useEffect(() => {
    let live = true;
    pcAccountStatus(apiFetch).then((status) => { if (live) { onPcAccount((known) => known === undefined ? status.account : known); setEnrolling(status.account !== null && status.enrolling === true); } }, () => undefined);
    return () => {
      live = false;
      run.current++;
      const left = drawn.current;
      const known = before.current;
      if (known === null) return;
      if (left.kind === "alone") holdAccountQrNotice({ kind: "alone", strays: left.strays, checking: left.checking, known });
      else if (left.kind === "joined") holdAccountQrNotice({ kind: "joined", account: left.account, device: left.device, strays: left.strays, checking: left.checking, known });
    };
  }, [onPcAccount]);

  useEffect(() => {
    const adopt = () => {
      setLate(accountQrPending());
      const kind = drawn.current.kind;
      if (kind === "shown" || kind === "starting") return;
      const found = takeAccountQrNotice();
      if (found === null) return;
      run.current++;
      setNote(null);
      setError(null);
      setAgain(true);
      stopAccountQrWatch();
      before.current = found.known;
      if (found.kind === "joined") {
        onPcAccount(found.account);
        setView({ kind: "joined", account: found.account, device: found.device, strays: found.strays, checking: found.checking });
        return;
      }
      setView({ kind: "alone", strays: found.strays, checking: found.checking });
    };
    adopt();
    window.addEventListener(ACCOUNT_QR_WATCH_EVENT, adopt);
    return () => window.removeEventListener(ACCOUNT_QR_WATCH_EVENT, adopt);
  }, [onPcAccount]);

  const takeDown = useCallback(() => {
    run.current++;
    setView({ kind: "idle" });
    setAgain(true);
  }, []);

  const show = async () => {
    const mine = ++run.current;
    pressedAs.current = signedIn ? accountId : null;
    setError(null);
    setNote(null);
    setView({ kind: "starting" });
    try {
      await ending.current;
      const [status, devices] = await Promise.all([pcAccountStatus(apiFetch), fetchDevices()]);
      if (mine !== run.current) return;
      const found = takeAccountQrNotice();
      const earlier = found?.known ?? stopAccountQrWatch();
      stopAccountQrWatch();
      onPcAccount(status.account);
      if (earlier !== null) {
        const { due, checking } = accountQrFindings(devices, status.account, earlier, Date.now());
        // a device got in, or the PC joined an account: that is told, and no new code is made over it
        if (status.account !== null || due.length + checking.length > 0) {
          run.current++;
          before.current = earlier;
          setAgain(true);
          setView(status.account !== null
            ? { kind: "joined", account: status.account, device: addedBy(devices, earlier.ids, status.account)?.label ?? null, strays: due, checking }
            : { kind: "alone", strays: due, checking });
          return;
        }
      }
      // in an account by now, however it got there: no QR code, and no code is asked of the PC, which would make none
      if (status.account !== null) { setView({ kind: "idle" }); return; }
      before.current = earlier ?? { ids: new Set(devices.map((device) => device.id)), seen: new Map() };
      setView({ kind: "shown" });
    } catch (reason) {
      if (mine !== run.current) return;
      setError(failureText(reason));
      setView({ kind: "idle" });
    }
  };

  const look = useCallback(async (mine: number): Promise<{ account: string | null; unanswered: number } | null> => {
    const [status, devices] = await Promise.all([pcAccountStatus(apiFetch), fetchDevices()]);
    const known = before.current;
    if (mine !== run.current || known === null) return null;
    onPcAccount(status.account);
    const { due, checking } = accountQrFindings(devices, status.account, known, Date.now());
    const up = drawn.current.kind === "shown";
    const next: AccountQrView | null = status.account !== null ? { kind: "joined", account: status.account, device: addedBy(devices, known.ids, status.account)?.label ?? null, strays: due, checking }
      // under a QR code that is up, a device in its ten seconds leaves it up: it may be the owner's, about to add the PC
      : due.length > 0 || (!up && checking.length > 0) ? { kind: "alone", strays: due, checking }
      : null;
    if (next !== null) setView((current) => sameView(current, next) ? current : next);
    else if (!up) takeDown();
    return { account: status.account, unanswered: due.length + checking.length };
  }, [onPcAccount, takeDown]);

  const online = relay.status?.phase === "online" && relay.status.blocked === null;
  const shown = view.kind === "shown";
  useEffect(() => {
    if ((view.kind === "shown" || view.kind === "starting") && (!active || !online)) takeDown();
  }, [active, online, view.kind, takeDown]);

  // the six-digit code the QR code carries, as its offers announce it; ended when the QR code goes, however it goes
  useEffect(() => {
    if (!shown) return;
    let code: string | null = null;
    let ended = false;
    const onCode = (event: Event) => { code = (event as CustomEvent<PairingCode | undefined>).detail?.code ?? code; };
    // the page goes (a reload, a closed tab or window, another address): no cleanup runs then, and nothing after an
    // answer would, so the one request that ends this QR code's own code is sent to outlive the page
    const onPageHide = () => {
      if (ended) return;
      ended = true;
      ending.current = code === null ? Promise.resolve(true) : endPairing(code, true).then(() => true, () => false);
      if (code !== null) tellOtherWindowsQrCodeEnded(code);
      // a page kept for Back comes back without its QR code
      takeDown();
    };
    window.addEventListener(PAIRING_CODE_EVENT, onCode);
    window.addEventListener("pagehide", onPageHide);
    return () => {
      window.removeEventListener(PAIRING_CODE_EVENT, onCode);
      window.removeEventListener("pagehide", onPageHide);
      if (!ended) ending.current = endShownCode(code);
      // a device may have taken the code a moment ago and link only now: unless this already says who came (a notice
      // took the QR code's place), the PC is watched on, also once this component is gone
      const next = drawn.current.kind;
      const known = before.current;
      if (known !== null && next !== "joined" && next !== "alone") watchEndedAccountQr(known, ending.current);
    };
  }, [shown, takeDown]);

  const watching = shown || view.kind === "alone" || view.kind === "joined";
  useEffect(() => {
    if (!watching) return;
    const mine = run.current;
    let asking = false;
    let hidden: number | undefined;
    let hiddenAt = 0;
    const waited = new Set<string>();
    const waits: number[] = [];
    const until = Date.now() + ACCOUNT_QR_MAX_MS;
    const up = () => drawn.current.kind === "shown";
    /** either limit passed by the clock: a device that slept ran no timer, and may wake with the page still in sight */
    const overdue = () => Date.now() >= until || (hidden !== undefined && Date.now() - hiddenAt >= ACCOUNT_QR_HIDDEN_MS);
    const ask = async () => {
      if (up() && overdue()) { takeDown(); return; }
      if (asking) return;
      asking = true;
      try {
        await look(mine);
        for (const [device, at] of before.current?.seen ?? []) {
          const left = at + ACCOUNT_QR_ALONE_MS - Date.now();
          if (left <= 0 || waited.has(device)) continue;
          waited.add(device);
          waits.push(window.setTimeout(() => void ask(), left));
        }
      } catch {  } finally { asking = false; }
    };
    const poll = window.setInterval(() => void ask(), ACCOUNT_QR_POLL_MS);
    const cap = window.setTimeout(() => { if (up()) takeDown(); }, ACCOUNT_QR_MAX_MS);
    const onVisibility = () => {
      if (document.hidden) {
        if (hidden === undefined) { hiddenAt = Date.now(); hidden = window.setTimeout(() => { if (up()) takeDown(); }, ACCOUNT_QR_HIDDEN_MS); }
        return;
      }
      if (up() && overdue()) takeDown();
      window.clearTimeout(hidden);
      hidden = undefined;
    };
    onVisibility();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.clearInterval(poll);
      window.clearTimeout(cap);
      for (const wait of waits) window.clearTimeout(wait);
      window.clearTimeout(hidden);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [watching, takeDown, look]);

  const { reread } = relay;
  /**
   * Signed in, the PC a QR code names is listed in the account this view shows, beside the code and never before it:
   * the code is a plain one (no mark), which a scanning device pairs with whether the PC is
   * listed or not, so an account service that is slow or down holds no pairing up. Best-effort, and only a PC the
   * account does not list yet is written (listOfferedPc). The account is the one the tab showed at the press, and only
   * when the PC says, in the very answer that carries this code, that it made the code for that account: a PC named
   * for another account by now, or a server that does not say, is listed nowhere. When the stored sign-in is another
   * one by the time the offer comes (another tab switched), nothing is listed anywhere either.
   */
  const listBeside = useCallback((offer: RelayOffer): void => {
    const named = decodeOffer(offer.url);
    const as = pressedAs.current;
    if (as === null || named === null || offer.account !== as) return;
    listOfferedPc(new AccountService({ store: indexedAccountStore }), named, as).catch((reason: unknown) => {
      console.warn("Ovis: this PC was not listed in the account", reason instanceof Error ? reason.name : reason);
    });
  }, []);

  const refusedForAccount = useCallback(() => {
    const mine = run.current;
    const down = () => { if (mine === run.current) takeDown(); };
    reread();
    void look(mine).then((left) => { if (left !== null && left.account === null) down(); }, down);
  }, [look, takeDown, reread]);

  // a device that pairs normally closes the dialog (Settings' device list); not while this may still have to say
  // which account the PC joined, or says it
  const held = shown || late || view.kind === "alone" || view.kind === "joined" || confirming;
  useEffect(() => { onPairingHeld?.(held); }, [held, onPairingHeld]);
  useEffect(() => () => onPairingHeld?.(false), [onPairingHeld]);

  const dismiss = () => {
    takeDown();
    setRefocus((count) => count + 1);
  };
  const told = view.kind === "alone" || view.kind === "joined";
  const strays = told ? view.strays : [];
  const checking = told ? view.checking : [];
  /** Keep: the person vouches for those devices, which count as known from here on. */
  const keepStrays = () => {
    const known = before.current;
    if (known === null || !told) return;
    setError(null);
    before.current = { ids: new Set([...known.ids, ...strays.map((stray) => stray.id)]), seen: known.seen };
    if (view.kind === "joined" || checking.length > 0) { setView({ ...view, strays: [] }); return; }
    watchEndedAccountQr(before.current, Promise.resolve(true), true);
    dismiss();
  };
  /** Not me: each device asked about is revoked on the PC; one that is gone already was. */
  const removeStrays = async () => {
    const known = before.current;
    const alone = view.kind === "alone";
    setError(null);
    setRemoving(true);
    try {
      try {
        for (const stray of strays) {
          try { await revokeDevice(stray.id); } catch (reason) { if (!(reason instanceof ApiError && reason.status === 404)) throw reason; }
        }
      } catch (reason) {
        setError(t("Could not remove it: {message} Revoke it in the device list.", { message: failureText(reason) }));
        return;
      }
      window.dispatchEvent(new Event(DEVICES_CHANGED_EVENT));
      // whoever else the code let in since the last look is asked about before this notice goes
      let left: Awaited<ReturnType<typeof look>>;
      try { left = await look(run.current); } catch {
        if (!alone || known === null) return;
        watchEndedAccountQr(known, Promise.resolve(true));
        left = { account: null, unanswered: 0 };
      }
      if (!alone || left === null || left.account !== null || left.unanswered > 0) return;
      if (!accountQrPending()) before.current = null;
      setNote(t("Removed: {devices}.", { devices: names(strays) }));
      dismiss();
    } finally { setRemoving(false); }
  };
  /** Done, or Keep it on an account: the notice goes once nobody the code let in is unanswered, as the PC says now. */
  const finish = async () => {
    if (before.current === null) { dismiss(); return; }
    setError(null);
    setSettling(true);
    try {
      // the QR code's code was ended as it came down: a read begun after that answer sees everyone it let in
      await ending.current;
      const left = await look(run.current);
      if (left === null || left.unanswered > 0) return;
    } catch (reason) {
      setError(t("This PC's devices could not be read: {message}", { message: failureText(reason) }));
      return;
    } finally { setSettling(false); }
    dismiss();
  };
  const revokeAll = async () => {
    await revokeAllDevices();
    before.current = null;
    resetAccountQrWatch();
    setConfirming(false);
    onPcAccount(null);
    setNote(t("Every paired device was revoked, and the Tailscale devices this PC has seen are kept out. The access token and this PC get in as before."));
    dismiss();
    onRevokedAll?.();
  };

  const pass = relay.status?.pass;
  // Ovis's relay refused this PC for its pass: it gets one through an account (docs/relay.md, "Relay pass")
  const needsAccount = !signedIn && relay.status?.phase === "error" && pass?.refused === true && pass.state !== "ok";
  // no account was named for this PC, as it says itself (an older PC says nothing, and is offered the button as
  // before): it makes no code for this QR code until one is named, by adding the PC to an account here or by `ovis add`
  const unnamed = relay.status?.account_named === false;
  const connecting = relay.status !== null && relay.status.blocked === null && relay.status.phase === "connecting";
  const whoseIs = (account: string) => accountId === null ? "unknown" : accountId === account ? "mine" : "other";
  const whose = view.kind === "joined" ? whoseIs(view.account) : null;
  const standing = pcAccount !== null && !told && !shown;
  const here = standing ? whoseIs(pcAccount) : null;
  const one = strays.length === 1;
  const relayStrays = strays.filter((stray) => stray.relay);
  const addressStrays = strays.filter((stray) => !stray.relay);
  const strayButtons = strays.length > 0 && (
    <>
      <button type="button" className="btn btn-danger" disabled={removing} aria-busy={removing || undefined} onClick={() => void removeStrays()}>{one ? t("Not me: remove it") : t("Not me: remove them")}</button>
      <button type="button" className="btn" disabled={removing} onClick={keepStrays}>{one ? t("Keep it") : t("Keep them")}</button>
    </>
  );
  const checkingLine = checking.length > 0 && <p className="settings-description" data-testid="connect-account-checking">{t("Checking a device that just paired: {devices}.", { devices: names(checking) })}</p>;
  const revokeEvery = <button type="button" className="btn btn-danger" onClick={() => setConfirming(true)}>{t("Not me: revoke every device")}</button>;
  const relayState = relay.status !== null && !(connecting && relayControls !== null) && <p className="settings-hint" role="status">{statusText(t, relay.status)}</p>;
  // standing in another account than this page's, nothing is said: the tab above is its sign-in buttons (owner #25)
  const standingLabel = standing && signedIn && here !== "other";
  const phoneLink = standing && online && serverId !== null && relay.status !== null ? signInLink(relay.status.app, serverId, here === "mine" ? provider : null) : null;
  const labelled = standing ? standingLabel : told || shown;
  return (
    <section className="connect-account-qr" aria-labelledby={labelled ? id : undefined} data-testid="connect-account-qr" data-account={here ?? undefined} data-first={first || undefined}>
      {standing && pairHere && here === "mine" && phoneLink !== null ? (
        <>
          <PhoneScan>
            <div className="compact-pair">
              <QrCode value={phoneLink} label={t("QR code that opens this PC in the Ovis app")} size={132} />
              <CodeRoute pairUrl={null} startAtOnce={false} {...(pairShared === undefined ? {} : { shared: pairShared })} phone={phone} compact />
            </div>
          </PhoneScan>
          <p ref={heading} className="settings-label" id={id} tabIndex={-1}>{t("This PC is in your account.")}</p>
          {enrolling && <p className="settings-description connect-account-qr-warning" role="status">{t("Not finished yet: the device that added this PC is still setting it up. If it stopped, open this PC on that device and choose Try again.")}</p>}
        </>
      ) : standing ? (
        <>
          {standingLabel && <p ref={heading} className="settings-label" id={id} tabIndex={-1}>{here === "mine" ? t("This PC is in your account.") : t("Sign in to this PC's account.")}</p>}
          {here === "mine" && enrolling && <p className="settings-description connect-account-qr-warning" role="status">{t("Not finished yet: the device that added this PC is still setting it up. If it stopped, open this PC on that device and choose Try again.")}</p>}
          {!online && <>{relayControls}{relayState}</>}
          {phoneLink !== null && <PhoneScan><QrCode value={phoneLink} label={t("QR code that opens this PC in the Ovis app")} size={132} /></PhoneScan>}
        </>
      ) : labelled && <p className="settings-label" id={id}>{t("Add with a QR code")}</p>}
      {standing ? null : view.kind === "joined" ? (
        <div className="connect-account-qr-notice" role="status" data-testid="connect-account-joined" data-account={whose}>
          <p className="settings-label">{whose === "mine" ? t("This PC is in your account.") : whose === "other" ? t("This PC joined a different account.") : t("Sign in to this PC's account.")}</p>
          {view.device !== null && <p className="settings-description">{t("Added by {device}.", { device: view.device })}</p>}
          {whose === "other" && <p className="settings-description connect-account-qr-warning">{t("If that was not you, revoke every device: this PC then leaves that account.")}</p>}
          {whose === "unknown" && <p className="settings-description connect-account-qr-warning">{t("If your own device did not just say that it added this PC, this was not you: revoke every device, and this PC leaves that account.")}</p>}
          {strays.length > 0 && <p className="settings-description connect-account-qr-warning" data-testid="connect-account-strays">{t("Paired with this PC while its QR code was up, and not in that account: {devices}.", { devices: names(strays) })}</p>}
          {checkingLine}
          <div className="phone-actions">
            {strayButtons}
            {/* Not me comes first unless the account is this browser's own: whoever scanned may be a stranger */}
            {whose !== "mine" && revokeEvery}
            {/* the notice goes only once every device that came is answered, one still in its ten seconds included */}
            {strays.length === 0 && checking.length === 0 && <button type="button" className={whose === "mine" ? "btn btn-primary" : "btn"} disabled={settling} aria-busy={settling || undefined} onClick={() => void finish()}>{whose === "mine" ? t("Done") : t("Keep it")}</button>}
            {whose === "mine" && revokeEvery}
          </div>
        </div>
      ) : view.kind === "alone" ? (
        <div className="connect-account-qr-notice" role="status" data-testid="connect-account-alone">
          {relayStrays.length > 0 && (
            <>
              <p className="settings-description connect-account-qr-warning">{t("Paired with this PC but not signed in to an Ovis account, so this PC is in no account yet: {devices}.", { devices: names(relayStrays) })}</p>
              <p className="settings-description">{relayStrays.length === 1 ? t("If that is your device, keep it and sign in on it to add this PC to your account.") : t("If those are your devices, keep them and sign in on one to add this PC to your account.")}</p>
            </>
          )}
          {addressStrays.length > 0 && <p className="settings-description connect-account-qr-warning">{t("Paired with this PC at its own address while its QR code was up, not through the relay: {devices}.", { devices: names(addressStrays) })}</p>}
          {checkingLine}
          {strays.length > 0 && <div className="phone-actions">{strayButtons}</div>}
        </div>
      ) : !online ? (
        <>
          {relayControls}
          {/* a relay that is merely off says nothing here: the button above turns it on as it adds this PC */}
          {needsAccount ? <p className="settings-hint">{t("Sign in above first; then this PC can show its QR code.")}</p> : relay.status?.phase !== "off" && relayState}
        </>
      ) : shown ? <RelayRoute relay={relay} readOnly={false} phone={phone} compact qrOnly onInAccount={refusedForAccount} onOffer={listBeside} />
        // no account named for this PC yet: it makes no QR code, and the sign-in or Add this PC above names one
        : unnamed ? null : (
        <button ref={showButton} type="button" className="connect-qr-link" disabled={view.kind === "starting"} aria-busy={view.kind === "starting" || undefined} onClick={() => void show()}>{again ? t("Show a new code") : t("Phone QR code")}</button>
      )}
      {note !== null && view.kind === "idle" && <p className="settings-hint" role="status">{note}</p>}
      {error !== null && <p className="settings-hint relay-error" role="alert">{error}</p>}
      {confirming && (
        <ConfirmDialog title={t("Revoke every paired device?")}
          body={t("Every paired device loses its access to this PC, and this PC leaves that account. The Tailscale devices this PC has seen are kept out too. The access token and this PC still get in.")}
          confirmLabel={t("Revoke all")} onClose={() => setConfirming(false)} onConfirm={revokeAll} />
      )}
    </section>
  );
}

export function RelayRoute({ relay, readOnly, phone = false, pairHere = false, sameName = null, compact = false, qrOnly = false, onInAccount, onOffer }: {
  relay: RelayState;
  qrOnly?: boolean;
  onInAccount?: () => void;
  /** told of each QR code's offer as it is drawn (RelayPairing `onOffer`) */
  onOffer?: (offer: RelayOffer) => void;
  compact?: boolean;
  readOnly: boolean;
  phone?: boolean;
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
      {status.phase === "online" && !readOnly && <RelayPairing phone={phone} compact={compact} qrOnly={qrOnly} onInAccount={onInAccount} {...(onOffer ? { onOffer } : {})} />}
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
            window.requestAnimationFrame(() => resetButton.current?.focus());
          }} />
      )}
    </div>
  );
}

/**
 * the code views of one dialog share (CodeRoute `shared`): the last one made or announced, whether one is being asked
 * for, the views waiting on that ask, told when it ends with no code so one of them asks itself, and whether a view of
 * this dialog has asked for one (`wanted`: a press, or a tab that shows one as it opens). Until then no view shows digits
 * another place of the page made (the setup guide's relay QR code, Settings' Devices group)
 */
interface SharedCode { code: PairingCode | null; asking: boolean; readonly waiting: Set<() => void>; wanted: boolean; readonly views: Set<(code: PairingCode) => void> }

/**
 * The ask in `shared` ended: with `code`, its announcement reaches the waiting views; with none, the first waiting view
 * asks itself, and the others wait on that ask (two asks would end each other's code).
 */
function askEnded(shared: MutableRefObject<SharedCode>, code: PairingCode | null): void {
  shared.current = { ...shared.current, ...(code === null ? {} : { code }), asking: false };
  if (code !== null) { shared.current.waiting.clear(); return; }
  const [first] = shared.current.waiting;
  if (first === undefined) return;
  shared.current.waiting.delete(first);
  first();
}

/** the newest code request of any opening: the server keeps one pending code, so an older answer is a dead code */
let latestPairRequest = 0;

/**
 * `shared`: the code another view of this dialog shows already. A view that starts takes it while it is good instead of
 * asking for another, which would end it (the PC keeps one pending code) after it was copied or scanned there.
 */
export function CodeRoute({ pairUrl, startAtOnce, shared, phone = false, compact = false }: { pairUrl: string | null; startAtOnce: boolean; shared?: MutableRefObject<SharedCode>; phone?: boolean; compact?: boolean }) {
  const t = useT();
  /** this view asked for a code: its press, or its tab opening with one (`startAtOnce`) */
  const wanted = useRef(false);
  const want = (): void => { wanted.current = true; if (shared) shared.current = { ...shared.current, wanted: true }; };
  // a view made on a press shows the code another view of the dialog shows already, while it is good
  const [code, setCode] = useState<PairingCode | null>(() => {
    const held = shared?.current.code;
    return !startAtOnce && shared?.current.wanted === true && held && Date.parse(held.expires_at) > Date.now() ? held : null;
  });
  const [left, setLeft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const requesting = useRef(false);
  const linkRef = useRef<HTMLAnchorElement>(null);
  const announcing = useRef(false);

  // the dialog's other views, told when one of them takes the PC's pending code as its tab opens: that code is wanted now
  useEffect(() => {
    if (!shared) return;
    const views = shared.current.views;
    views.add(setCode);
    return () => { views.delete(setCode); };
  }, [shared]);

  useEffect(() => {
    const onCode = (event: Event) => {
      if (announcing.current) return;
      const detail = (event as CustomEvent<AnnouncedCode>).detail;
      // a QR code shown alone (the relay tab's) is never shown here as digits; the PC's one pending code is now that
      // one, so the code this showed is gone
      const next = detail.qrOnly === true ? null : detail;
      // read before the shared code is written: digits this dialog never asked for stay off it, whoever made them
      const asked = wanted.current || shared?.current.wanted === true;
      if (shared) { shared.current.waiting.clear(); shared.current = { ...shared.current, code: next, asking: false }; }
      setCode(asked ? next : null);
    };
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
    want();
    requesting.current = true;
    setBusy(true);
    setError(null);
    const request = ++latestPairRequest;
    if (shared) shared.current = { ...shared.current, asking: true };
    try {
      const fresh = await startPairing();
      // a dialog closed and opened again asked after this one: its answer is the code that pairs, not this one
      if (request !== latestPairRequest) return;
      if (shared) askEnded(shared, fresh);
      setCode(fresh);
      announcing.current = true;
      try { announcePairingCode(fresh); } finally { announcing.current = false; }
    } catch (reason) {
      setError(failureText(reason));
      // the views waiting on this ask get no announcement: told, one of them asks for its own code
      if (shared) askEnded(shared, null);
    }
    finally {
      requesting.current = false;
      setBusy(false);
    }
  };

  const started = useRef(false);
  useEffect(() => {
    if (!startAtOnce || started.current) return;
    started.current = true;
    const held = shared?.current;
    // another view's code is good, or on its way (its announcement brings it here): no second code ends it. If that ask
    // fails, this view asks itself
    if (held?.asking) {
      const ask = (): void => { void pair(); };
      held.waiting.add(ask);
      // a view that goes before the ask ends asks nothing; one whose effect runs again waits again
      return () => { held.waiting.delete(ask); started.current = false; };
    }
    if (held?.code && Date.parse(held.code.expires_at) > Date.now()) {
      want();
      setCode(held.code);
      // no announcement: no code was made, and the relay QR codes on the page already show this one
      for (const show of held.views) show(held.code);
      return;
    }
    void pair();
  }, [startAtOnce, shared]);

  const spaced = code ? `${code.code.slice(0, 3)} ${code.code.slice(3)}` : "";
  const qrValue = code && pairUrl ? `${pairUrl.replace(/\/$/, "")}/?pair=${code.code}` : null;
  const newCode = <button type="button" className="btn" disabled={busy} aria-busy={busy || undefined} onClick={() => void pair()}><RefreshCw aria-hidden="true" />{t("New code")}</button>;
  if (compact && code === null && !busy && !started.current) return (
    <div className="connect-phone-code">
      <div className="phone-actions"><button type="button" className="btn" onClick={() => { started.current = true; void pair(); }}>{t("Get a pairing code")}</button></div>
      {error !== null && <p className="settings-hint" role="alert">{error}</p>}
    </div>
  );
  if (compact) return (
    <div className="connect-phone-code" role="status">
      <CompactPair qr={qrValue} qrLabel={code === null ? t("Pairing code") : t("QR code that pairs a phone with code {code}", { code: code.code })}
        code={code?.code ?? null} shown={code === null ? null : spaced} codeLabel={t("Pairing code")} busy={busy}
        qrNote={busy || code !== null ? undefined : t("This code expired.")}
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
