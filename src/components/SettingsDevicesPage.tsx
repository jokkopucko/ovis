import { useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Plus, Trash2 } from "lucide-react";

import type { AddPcPreset } from "../lib/actions.ts";
import { useInstallPrompt } from "../lib/install.ts";
import { changePc, inNativeApp } from "../lib/nativeApp.ts";
import { demoBuild } from "../lib/demo.ts";
import { loadRelayShell } from "../lib/relay.ts";
import { inRelayShell, useRelay, type RelayState } from "../lib/useRelay.ts";
import { serverIdOfPath, shellMode } from "../lib/shellMode.ts";
import { useSettings } from "../lib/settings.ts";
import { useT, type Translate } from "../lib/i18n.ts";
import { OwnJoins } from "./OwnJoins.tsx";
import { ListReason } from "./ListReason.tsx";
import { SettingsFold, SettingsGroup, SettingsQuery, SettingsRow, Toggle } from "./SettingsControls.tsx";
import { PcLoadSetting } from "./MachineStats.tsx";
import { pairedPc, type Machine, type MachineSettings } from "../../shared/machines.ts";
import { canHideMachine, isMachineShown, setHiddenMachines, useHiddenMachines, withMachineHidden } from "../lib/hiddenMachines.ts";
import { fetchMachines, fetchRemoteAccess, requestRelayOffer, machineRequest } from "../lib/api.ts";
import { isLoopbackHost, labelDevice, phonePlan, tailnetHost, tailscalePlan } from "../lib/phone.ts";
import type { HealthAuth, RemoteAccess } from "../../shared/protocol.ts";
import type { SecurityFacts } from "../lib/useAccess.ts";
import { DevicesPanel } from "./DevicesPanel.tsx";
import { StrictModeSection } from "./StrictModePanel.tsx";
import { useMachineSessions } from "../lib/machineSessionContext.tsx";
import { ConfirmDialog } from "./ConfirmDialog.tsx";
import { SignOutRow } from "./SignOutRow.tsx";
import { failureText, openOwnOffer, RelayDirectRow, statusText } from "./RelayPanel.tsx";
import { AccountSection, type AccountState } from "./AccountSection.tsx";
import { HostedAccountGroup } from "./AccountHead.tsx";
import { useHostedSignIn } from "../lib/account/hostedSignIn.ts";
import { AccountPcRows, NoAccountPcHint } from "./AccountPcs.tsx";
import { removablePc, STATE_WORD } from "./MachineSidebar.tsx";
import { AccountPcError, pcAccountStatus, type PcAccountStatus } from "../lib/account/join.ts";
import { accountServiceHere } from "../lib/account/ownWindow.ts";
import { sshAddListed } from "../lib/account/sshAdd.ts";
import { apiFetch } from "../lib/api-request-id.ts";
import type { MyPc } from "../lib/account/myPcs.ts";
import { closedBySignIn, ConnectPhoneDialog, relayOffered, relayPending } from "./ConnectPhoneDialog.tsx";
import { ACCOUNT_QR_WATCH_EVENT, accountQrNoticeWaiting } from "../lib/accountQrWatch.ts";
import { ADD_CONNECTION_EVENT, takeAddConnection, type AddConnectionTab } from "../lib/addConnectionRequest.ts";
import { useMediaQuery } from "../lib/useMediaQuery.ts";

/** Public reachability stays unknown unless this request proved it, since a proxy or router in front can expose any bind. */
function AccessFacts({ facts }: { facts: SecurityFacts }) {
  const t = useT();
  const fact = (label: string, value: string, description: string) => (
    <SettingsRow key={label} label={label} description={description}><span className="settings-fact">{value}</span></SettingsRow>
  );
  if (facts.state !== "known") {
    const text = facts.state === "loading" ? t("Loading…")
      : facts.state === "error" ? t("The server did not answer, so these facts are unavailable. Nothing from an earlier check is shown. This page asks again by itself; if this message stays, check that the server is running and that this device can reach it.")
      : t("This server does not report these facts. Updating it adds them.");
    return (
      <SettingsGroup title={t("Access")} section="access">
        <p className="settings-item settings-description" role="status">{text}</p>
      </SettingsGroup>
    );
  }
  const { summary } = facts;
  const gate = summary.pairing_gate;
  const bind = summary.bind_scope;
  const ingress = summary.observed_ingress;
  return (
    <SettingsGroup title={t("Access")} section="access" note={t("What this server reports about how it is reached. Each line is one fact, not a safety rating.")}>
      {fact(t("Access token"), summary.token_configured ? t("Set") : t("Not set"), t("Whether the server has a token configured. Its value is never shown."))}
      {fact(t("Pairing gate"), gate === "open" ? t("Not yet closed") : gate === "closed" ? t("Closed") : t("Unavailable"),
        gate === "open" ? t("No device has been paired yet, so no pairing code is asked for.")
          : gate === "closed" ? t("A new browser needs a pairing code or the token.")
          : t("The device list cannot be read, so no new device can pair. This PC, the token and Tailscale sign-in still work."))}
      {fact(t("Listens on"), bind === "loopback" ? t("Loopback") : bind === "tailnet" ? t("Tailscale address") : t("Other address"),
        bind === "other" ? t("A network address, every interface or a host name: other devices on that network may reach it.")
          : t("The address the server listens on. A proxy on this PC can still forward other traffic to it."))}
      {fact(t("This connection"), ingress === "direct" ? t("No proxy seen") : ingress === "proxy" ? t("Through a proxy") : ingress === "tailscale" ? t("Through Tailscale") : ingress === "funnel" ? t("Through Tailscale Funnel") : ingress === "relay" ? t("Through the Ovis relay") : ingress === "portal" ? t("Through Portal") : t("Unknown"),
        ingress === "direct" ? t("No proxy said it forwarded this browser's request. One that adds nothing, such as an SSH tunnel, looks the same.")
          : ingress === "relay" ? t("This browser's request came from a phone paired through the Ovis relay, end-to-end encrypted: the relay could not read it.")
          : t("How this browser's request arrived, not how every device reaches the server."))}
      {fact(t("Public internet"), summary.public_exposure === "observed" ? t("Reachable") : t("Unknown"),
        summary.public_exposure === "observed" ? t("This request came through Tailscale Funnel, which is open to the public internet.")
          : t("The server cannot see whether a proxy, tunnel or router makes it reachable from the internet."))}
    </SettingsGroup>
  );
}

function deviceKind(label: string, t: ReturnType<typeof useT>): string | null {
  const device = labelDevice(label);
  if (device === null) return null;
  if (device === "iPhone" || device === "Android") return t("Phone");
  if (device === "iPad") return t("Tablet");
  return t("Browser");
}

/** What the app's Change PC row says of this page: the demo only where the demo build marked it (lib/demo.ts) */
export function changePcDescription(t: Translate, demo: boolean, host: string): string {
  return demo ? t("This is the demo. Go back to the app's list of PCs to open yours.") : t("This app shows {address}. Go back to its list of PCs to open another.", { address: host });
}

export function DevicesPage({ auth, security, onSignOut, onRevokedAll, machines, pcSettings, pcSettingsError, onPcSettings, openAddPc, connectPc, onHome, opensAll, withdrawn }: {
  /** closes Settings onto the main screen, after a sign-in in the sheet the setup checklist opened (closedBySignIn) */
  onHome: () => void;
  opensAll?: (() => boolean) | undefined;
  withdrawn?: (() => boolean) | undefined;
  auth: HealthAuth | null; security: SecurityFacts; onSignOut: (() => Promise<void>) | null; onRevokedAll: () => void;
  machines: readonly Machine[]; pcSettings: MachineSettings | null; pcSettingsError: string | null; onPcSettings: (patch: Partial<MachineSettings>) => void; openAddPc: (preset?: AddPcPreset) => void; connectPc: (machine: Machine) => void;
}) {
  const sessions = useMachineSessions();
  const { settings, update } = useSettings();
  const t = useT();
  const installPrompt = useInstallPrompt();
  const nativeApp = inNativeApp();
  const relayPc = shellMode() === "relay" ? serverIdOfPath(window.location.pathname) : null;
  const [confirmForget, setConfirmForget] = useState(false);
  const [access, setAccess] = useState<RemoteAccess | null | undefined>(undefined);
  const loadAccess = useCallback(() => {
    setAccess(undefined);
    fetchRemoteAccess().then(setAccess, () => setAccess(null));
  }, []);
  useEffect(() => { loadAccess(); }, [loadAccess]);
  const plan = phonePlan({ protocol: window.location.protocol, hostname: window.location.hostname, origin: window.location.origin, secure: window.isSecureContext, shell: inRelayShell() }, access ?? null);
  const pairUrl = plan.kind === "here" || plan.kind === "served" ? plan.url : isLoopbackHost(window.location.hostname) ? null : window.location.origin;
  // the Tailscale tab's own address: this page's where it is open at one, else what Tailscale serves, never a proxy's
  const tailscale = plan.kind === "here" && tailnetHost(window.location.hostname) ? plan : tailscalePlan(access ?? null);
  const wakeLockProblem = !window.isSecureContext ? t("Needs HTTPS or localhost.") : !("wakeLock" in navigator) ? t("This browser can't keep the screen on.") : null;
  const relay = useRelay();
  const relayReadOnly = auth?.role === "watch" || auth?.via === "portal";
  const closesGate = security.state === "known" && security.summary.pairing_gate === "open" && !security.summary.token_configured;
  const [connecting, setConnecting] = useState(false);
  const [connectAsked, setConnectAsked] = useState<AddConnectionTab | null>(null);
  const [accountChecks, setAccountChecks] = useState(0);
  // the setup checklist's Connect your phone: Add a connection, on the tab it asked for, as soon as this page is up
  useEffect(() => {
    const open = (): void => {
      const tab = takeAddConnection();
      if (tab === null) return;
      setConnectAsked(tab);
      setConnecting(true);
      setAccountChecks((count) => count + 1);
    };
    open();
    window.addEventListener(ADD_CONNECTION_EVENT, open);
    return () => window.removeEventListener(ADD_CONNECTION_EVENT, open);
  }, []);
  const searching = useContext(SettingsQuery).length > 0;
  const [devicesMore, setDevicesMore] = useState<HTMLDivElement | null>(null);
  const [devicesCheck, setDevicesCheck] = useState<HTMLDivElement | null>(null);
  const closeConnect = useCallback(() => setConnecting(false), []);
  const pairingHeld = useRef(false);
  const holdPairing = useCallback((held: boolean) => { pairingHeld.current = held; }, []);
  const closeConnectOnPair = useCallback(() => { if (!pairingHeld.current) setConnecting(false); }, []);
  const accountService = accountServiceHere();
  const hostedSignIn = useHostedSignIn();
  const [identityResets, setIdentityResets] = useState(0);
  const [account, setAccount] = useState<AccountState>({ signedIn: false, account: null, pcs: null, provider: null, noPcs: false, reachable: true });
  const tellsQrNotice = accountService !== null && account.reachable && relayOffered(relay) && !relayReadOnly;
  useEffect(() => {
    if (!tellsQrNotice) return;
    const open = () => { if (accountQrNoticeWaiting()) setConnecting(true); };
    open();
    window.addEventListener(ACCOUNT_QR_WATCH_EVENT, open);
    return () => window.removeEventListener(ACCOUNT_QR_WATCH_EVENT, open);
  }, [tellsQrNotice]);
  // a new device joins by signing in only to a PC in the account this browser is signed in to (docs/account.md
  // "Joining through the account")
  const [pcAccount, setPcAccount] = useState<string | null>(null);
  const [pcAddFromAccount, setPcAddFromAccount] = useState<PcAccountStatus["pcAddFromAccount"]>();
  useEffect(() => {
    if (!connecting && account.account === null) { setPcAccount(null); setPcAddFromAccount(undefined); return; }
    let live = true;
    pcAccountStatus(apiFetch).then((status) => {
      if (live) { setPcAccount(status.account); setPcAddFromAccount(status.pcAddFromAccount); }
    }, (error: unknown) => {
      if (live) { setPcAccount(null); setPcAddFromAccount(error instanceof AccountPcError && error.code === "strict" ? "unavailable" : undefined); }
    });
    return () => { live = false; };
  }, [account.account, connecting]);
  const joinBySignIn = account.account !== null && pcAccount === account.account && relay.status?.phase === "online";
  // where Add PC over SSH adds the PC to the account (MachineDialog asks the same), the relay tab lists the PCs to add
  const addsOverSsh = sshAddListed({ pcAddFromAccount, auth, signedInAccount: account.signedIn ? account.account : null, pcAccount });
  // the PCs in the account, which the relay tab's list says so of: one only listed or admitted is still offered Add
  const accountPcs = useMemo(() => account.pcs?.filter((pc) => pc.listed && pc.joined === true).map((pc) => pc.server_id) ?? [], [account.pcs]);
  const openAccount = useCallback(() => {
    setConnecting(false);
    const group = document.querySelector<HTMLElement>('.settings-dialog [data-section="account"]');
    group?.scrollIntoView({ block: "start" });
    group?.querySelector<HTMLElement>("button")?.focus();
  }, []);
  const readAccountAgain = useCallback(() => setAccountChecks((count) => count + 1), []);
  const touchPhone = useMediaQuery("(pointer: coarse)");
  const selfRelay = touchPhone && relayOffered(relay) && relay.status?.phase === "online" && !relayReadOnly ? <UseRelayHere /> : null;
  return (
    <>
      {/* the account first: the sign-in the relay depends on is not left in More settings */}
      {/* a PC page the hosted app opened has no PC sign-in of its own: the hosted one, with its Sign out and Manage account */}
      {accountService === null && <HostedAccountGroup signIn={hostedSignIn} watching={auth?.role === "watch"} />}
      <AccountSection watching={auth?.role === "watch"} onAccount={setAccount} recheck={accountChecks} signInElsewhere={(relayOffered(relay) || relayPending(relay)) && !relayReadOnly} {...(opensAll === undefined ? {} : { opensAll })} {...(withdrawn === undefined ? {} : { withdrawn })} />

      {/* what is connected to this PC: its name atop one list of the other PCs, phones and browsers, the one in use first */}
      <SettingsGroup section="devices">
        <ListReason />
        <OwnJoins />
        <div className="settings-item my-devices">
          <MyPcRows machines={machines} account={account.account} accountPcs={account.pcs} onAccountChanged={readAccountAgain} watching={auth?.role === "watch"} relayKey={`${relay.status?.phase ?? ""}:${identityResets}`} selfAction={setDevicesCheck}>
            <DevicesPanel onDevicePaired={closeConnectOnPair} auth={auth} onRevokedAll={onRevokedAll} kindOf={(label) => deviceKind(label, t)} currentAction={selfRelay} more={devicesMore} checkSlot={devicesCheck} />
          </MyPcRows>
          {account.noPcs && account.provider !== null && <NoAccountPcHint provider={account.provider} />}
        </div>
        {/* how anything else gets connected: one button, its sheet picks the way; a search finds it as a row by every way it holds */}
        {searching ? (
          <SettingsRow label={t("Add a connection")} keywords={t("phone browser PC pair pairing code QR relay Tailscale Wi-Fi SSH Portal add PC remote PCs")}>
            <button type="button" className="btn btn-primary" onClick={() => { setConnectAsked(null); setConnecting(true); setAccountChecks((count) => count + 1); }}><Plus aria-hidden="true" />{t("Add a connection")}</button>
          </SettingsRow>
        ) : (
          <div className="settings-item devices-add">
            <button type="button" className="btn btn-primary" onClick={() => { setConnectAsked(null); setConnecting(true); setAccountChecks((count) => count + 1); }}><Plus aria-hidden="true" />{t("Add a connection")}</button>
          </div>
        )}
        <DamagedPcFiles pcSettings={pcSettings} />
      </SettingsGroup>

      <SettingsFold kind="more" keys={["keepScreenOn", "pcLoad"]}>
        {(nativeApp || relayPc !== null) && (
          <SettingsGroup title={t("This app")} section="this-app">
            {nativeApp && (
              <SettingsRow label={t("Change PC")} description={changePcDescription(t, demoBuild(), window.location.host)}>
                <button type="button" className="btn" onClick={() => void changePc()}>{t("Change PC")}</button>
              </SettingsRow>
            )}
            {relayPc !== null && (
              <>
                <SettingsRow label={t("Forget this PC")} description={t("Deletes this phone's key for this PC. Pairing again takes a new QR code from the PC.")}>
                  <button type="button" className="btn" onClick={() => setConfirmForget(true)}>{t("Forget this PC")}</button>
                </SettingsRow>
                {confirmForget && (
                  <ConfirmDialog title={t("Forget this PC?")}
                    body={t("This phone's key for it is deleted here, and the PC keeps listing this phone until it is revoked there. Pairing again takes a new QR code from the PC.")}
                    confirmLabel={t("Forget")} onClose={() => setConfirmForget(false)}
                    onConfirm={async () => { await (await loadRelayShell()).forgetSavedPc(relayPc); window.location.assign("/"); }} />
                )}
              </>
            )}
          </SettingsGroup>
        )}

        <SettingsGroup title={t("Devices and access")} section="devices-more">
          {/* in the hosted shell too (a phone reaching this PC through the relay or directly), there without the switch */}
          {(relayOffered(relay) || inRelayShell()) && <RelayDirectRow relay={relay} readOnly={relayReadOnly || inRelayShell()} />}
          {/* strict mode: one row with its switch; what it ends is said when it is turned on */}
          <StrictModeSection offered={sessions?.peek("local")?.socket.accountOpensAll() === true} auth={auth} />
          <div className="settings-item" ref={setDevicesMore} />
          {onSignOut && <SignOutRow viaPortal={auth?.via === "portal"} oidc={auth?.portal?.method === "oidc"} onSignOut={onSignOut} label={t("Sign out of this PC")} />}
        </SettingsGroup>
        <SettingsGroup title={t("This device")} section="phone-more">
          <SettingsRow label={t("Keep screen on")} description={<>{t("Keeps this device's screen from turning off while a terminal or chat pane is open and the app is in front.")}{wakeLockProblem !== null && <span className="settings-condition">{wakeLockProblem}</span>}</>}>
            <Toggle label={t("Keep screen on")} checked={settings.keepScreenOn} onChange={(keepScreenOn) => update({ keepScreenOn })} />
          </SettingsRow>
          {/* the steps where the browser holds no prompt (Safari has none): the only way to learn how to install */}
          <SettingsRow label={t("Install")} description={installPrompt.installed ? t("Installed") : installPrompt.canInstall ? undefined : installPrompt.help}>
            {!installPrompt.installed && installPrompt.canInstall && <button type="button" className="btn btn-primary" onClick={() => void installPrompt.install()}>{t("Install app")}</button>}
          </SettingsRow>
        </SettingsGroup>
        {relayOffered(relay) && !relayReadOnly && <RelayControls relay={relay} closesGate={closesGate} onReset={() => setIdentityResets((count) => count + 1)} />}
        <SidebarPcsGroup machines={machines} />
        <AccessFacts facts={security} />
        <RemotePcsMore machines={machines} pcSettings={pcSettings} pcSettingsError={pcSettingsError} onPcSettings={onPcSettings} />
      </SettingsFold>

      {connecting && (
        <ConnectPhoneDialog asked={connectAsked} plan={plan} tailscale={tailscale} platform={access?.platform} pairUrl={pairUrl}
          relay={relay} readOnly={relayReadOnly} closesGate={closesGate} canPair={auth?.via !== "portal"}
          signedIn={account.signedIn} accountId={account.account} provider={account.provider} joinBySignIn={joinBySignIn}
          pcAddFromAccount={pcAddFromAccount} onAccountSetup={openAccount}
          account={accountService !== null && account.reachable ? { service: accountService, onOpen: openAccount, onSignedIn: (home) => {
            readAccountAgain();
            const closed = closedBySignIn(home, connectAsked);
            if (closed !== "nothing") setConnecting(false);
            if (closed === "settings") onHome();
          }, ...(opensAll === undefined ? {} : { opensAll }) } : null}
          onAddPc={(preset) => { setConnecting(false); openAddPc(preset); }} machines={machines} addsOverSsh={addsOverSsh} accountPcs={accountPcs}
          onConnectMachine={(machine) => { setConnecting(false); connectPc(machine); }}
          onPairingHeld={holdPairing} onRevokedAll={onRevokedAll} onClose={closeConnect} />
      )}
    </>
  );
}

function UseRelayHere() {
  const t = useT();
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <>
      <button type="button" className="btn" disabled={opening} title={t("Pairs this phone through the relay, so Ovis keeps working away from home.")} onClick={() => {
        setError(null);
        setOpening(true);
        requestRelayOffer().then((offer) => openOwnOffer(offer.url)).catch((reason: unknown) => setError(failureText(reason))).finally(() => setOpening(false));
      }}>{t("Use the relay")}</button>
      {error !== null && <span className="settings-hint relay-error" role="alert">{error}</span>}
    </>
  );
}

function RelayControls({ relay, closesGate, onReset }: { relay: RelayState; closesGate: boolean; onReset: () => void }) {
  const t = useT();
  // the English name stays the one the scripts know
  const switchLabel = t("Ovis relay|relay switch");
  const { status, pending, request } = relay;
  const [error, setError] = useState<string | null>(null);
  const [confirmingReset, setConfirmingReset] = useState(false);
  const resetButton = useRef<HTMLButtonElement>(null);
  if (status === null) return null;
  const on = status.blocked === null && status.phase !== "off";
  const run = async (action: "start" | "stop") => {
    setError(null);
    try { await request(action); } catch (reason) { setError(failureText(reason)); }
  };
  return (
    <SettingsGroup title={t("Ovis relay")} section="relay">
      <SettingsRow label={switchLabel} keywords={t("Ovis relay")} description={statusText(t, status)}>
        {status.blocked === null && <Toggle label={switchLabel} checked={on} onChange={(next) => { if (!pending) void run(next ? "start" : "stop"); }} />}
      </SettingsRow>
      {closesGate && !on && status.blocked === null && <p className="settings-item settings-condition">{t("Turning on the relay closes the device gate: a new browser then needs a pairing code or the access token.")}</p>}
      {error !== null && <p className="settings-item settings-hint relay-error" role="alert">{error}</p>}
      {/* a serve-only install refuses the reset too; an unreadable identity is what the reset mends */}
      {status.blocked !== "serve_only" && (
        <SettingsRow label={t("Reset relay identity")} description={t("Gives this PC a new identity on the relay. Phones paired through the relay will then need to scan a new code.")}>
          <button ref={resetButton} type="button" className="btn" title={t("Reset relay identity")} disabled={pending} onClick={() => setConfirmingReset(true)}>{t("Reset")}</button>
        </SettingsRow>
      )}
      {confirmingReset && (
        <ConfirmDialog title={t("Reset the relay identity?")} body={t("Phones paired through the relay will need to scan a new code.")}
          confirmLabel={t("Reset")} onClose={() => setConfirmingReset(false)} onConfirm={async () => {
            await request("reset-identity");
            setConfirmingReset(false);
            onReset();
            window.requestAnimationFrame(() => resetButton.current?.focus());
          }} />
      )}
    </SettingsGroup>
  );
}

function MyPcRows({ machines, account, accountPcs, onAccountChanged, relayKey, watching, selfAction, children }: { machines: readonly Machine[]; accountPcs: readonly MyPc[] | null; relayKey: string;
  account: string | null;
  onAccountChanged: () => void;
  /** a watching device: the server refuses it the removal, so it is not offered */
  watching: boolean;
  selfAction?: (slot: HTMLDivElement | null) => void;
  children?: ReactNode }) {
  const t = useT();
  const [removing, setRemoving] = useState<Machine | null>(null);
  const local = machines.find((machine) => machine.kind === "local");
  const [ownId, setOwnId] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    fetchMachines().then((list) => { if (live) setOwnId(list.find((machine) => machine.kind === "local")?.server_id ?? null); }, () => undefined);
    return () => { live = false; };
  }, [relayKey, local?.server_id]);
  const id = ownId ?? local?.server_id;
  const others = machines.filter((machine) => machine.kind !== "local");
  const shown = new Set<string>([id, local?.server_id, ...others.map((machine) => machine.server_id ?? machine.relay?.server_id)].filter((id): id is string => id !== undefined));
  const fromAccount = (accountPcs ?? []).filter((pc) => !shown.has(pc.server_id));
  return (
    <>
    {local !== undefined && (
      <ul className="devices-list my-pc-self">
        <li className="devices-row my-device-self" data-testid="this-pc">
          <div className="devices-name">
            <span className="settings-label">{local.name}<span className="devices-kind is-self">{t("This PC")}</span></span>
          </div>
          <div className="devices-actions my-device-check" ref={selfAction} />
        </li>
      </ul>
    )}
    {children}
    <ul className="devices-list my-pcs">
      {others.map((machine) => (
        <li key={machine.id} className={machine.state === "connected" ? "devices-row" : "devices-row is-away"}>
          <div className="devices-name">
            <span className="settings-label">{machine.name}<span className="devices-kind">PC</span></span>
            <span className="settings-description">{t(STATE_WORD[machine.state])}</span>
          </div>
          {!watching && removablePc(machine) && (
            <div className="devices-actions">
              <button type="button" className="icon-button" aria-label={t("Remove PC {name}", { name: machine.name })} title={t("Remove PC {name}", { name: machine.name })} onClick={() => setRemoving(machine)}><Trash2 aria-hidden="true" /></button>
            </div>
          )}
        </li>
      ))}
      {account !== null && <AccountPcRows pcs={fromAccount} onChanged={onAccountChanged} />}
    </ul>
    {removing !== null && <ConfirmDialog title={t("Remove PC {name}?", { name: removing.name })} body={t(pairedPc(removing) ? "Removes this PC here. To end its access too, revoke it under Phone & devices on that PC." : "Removes this registration. Remote sessions keep running.")} confirmLabel={t("Remove PC")}
      onConfirm={async () => { await machineRequest(`/${encodeURIComponent(removing.id)}`, "DELETE"); setRemoving(null); }} onClose={() => setRemoving(null)} />}
    </>
  );
}

function SidebarPcsGroup({ machines }: { machines: readonly Machine[] }) {
  const t = useT();
  const hidden = useHiddenMachines();
  if (machines.length < 2) return null;
  const listed = [...machines].sort((a, b) => Number(b.kind === "local") - Number(a.kind === "local"));
  return (
    <SettingsGroup title={t("Show in sidebar")} section="sidebar-pcs" note={t("Only on this device. A hidden PC stays connected, and a link or an alert still opens its panes. One PC is always shown.")}>
      {listed.map((machine) => {
        const shown = isMachineShown(machines, hidden, machine.id);
        return (
          <SettingsRow key={machine.id} label={machine.name} description={machine.kind === "local" ? t("The Host: the computer this app runs on") : undefined}>
            <Toggle label={t("Show {name} in sidebar", { name: machine.name })} checked={shown} disabled={shown && !canHideMachine(machines, hidden, machine.id)} onChange={(show) => setHiddenMachines(withMachineHidden(machines, hidden, machine.id, !show))} />
          </SettingsRow>
        );
      })}
    </SettingsGroup>
  );
}

const heldAddedPcs = (name: string): boolean => name.startsWith("machines.json.");

function DamagedPcFiles({ pcSettings }: { pcSettings: MachineSettings | null }) {
  const t = useT();
  return (
    <>
      {pcSettings?.set_aside?.some(heldAddedPcs) && <p className="settings-item settings-hint">
        {t("Saved PC data was damaged and could not be read when the app started. It was set aside as {files}; add any missing PC again.", { files: pcSettings.set_aside.filter(heldAddedPcs).join(", ") })}
      </p>}
      {pcSettings?.set_aside?.some((name) => !heldAddedPcs(name)) && <p className="settings-item settings-hint">
        {t("The permission to connect to the PCs saved in herdr was damaged and could not be read when the app started. It was set aside as {files}; choose Connect on those PCs again.", { files: pcSettings.set_aside.filter((name) => !heldAddedPcs(name)).join(", ") })}
      </p>}
    </>
  );
}

function RemotePcsMore({ machines, pcSettings, pcSettingsError, onPcSettings }: { machines: readonly Machine[]; pcSettings: MachineSettings | null; pcSettingsError: string | null; onPcSettings: (patch: Partial<MachineSettings>) => void }) {
  const t = useT();
  return (
    <SettingsGroup section="remote-more">
      {/* the switch is the server's and waits for its answer; Add PC never does */}
      {pcSettings && (
        <SettingsRow label={t("Update PC bridges automatically")} description={t("When an app update needs a newer bridge, PCs that connect with their saved key are updated in the background. PCs that need a password ask first.")}>
          <Toggle label={t("Update PC bridges automatically")} checked={pcSettings.auto_update_bridges} onChange={(auto_update_bridges) => onPcSettings({ auto_update_bridges })} />
        </SettingsRow>
      )}
      {/* a refused change of the switch above, beside it: in a search too */}
      {pcSettingsError && <p className="settings-item settings-hint" role="alert">{pcSettingsError}</p>}
      <PcLoadSetting machines={machines} />
    </SettingsGroup>
  );
}