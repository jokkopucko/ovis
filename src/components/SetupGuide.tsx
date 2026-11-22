import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type KeyboardEvent as ReactKeyboardEvent, type MutableRefObject, type ReactNode } from "react";
import { ArrowRight, Bell, BellRing, Check, ChevronLeft, Circle, CircleCheck, Copy, ExternalLink as ExternalLinkIcon, TriangleAlert, Folder, Gauge, Globe, Info, KeyRound, LoaderCircle, Network, Play, RefreshCw, RotateCw, Smartphone, Wifi, X } from "lucide-react";

import type { AgentCatalogEntry, AgentCatalogRow } from "../../shared/agent-catalog.ts";
import type { HealthAuth, PairingCode, RemoteAccess } from "../../shared/protocol.ts";
import type { SecurityFacts } from "../lib/useAccess.ts";
import { ApiError, createWorkspace, fetchAgentCatalog, fetchDevices, fetchRemoteAccess, fetchUsage, startPairing } from "../lib/api.ts";
import { useT, type Translate } from "../lib/i18n.ts";
import { useMachineId } from "../lib/machineContext.tsx";
import { createRequest, newSessionLaunch } from "../lib/newSession.ts";
import { pairThisBrowser, UnconfirmedPairing } from "../lib/pairing.ts";
import { isLoopbackHost, phonePlan } from "../lib/phone.ts";
import { recentDirectories } from "../lib/recent-directories.ts";
import { useSettings, type Settings } from "../lib/settings.ts";
import { useAlertFilters } from "../lib/alertFilters.ts";
import { alertMeWhenChips } from "./AlertChips.tsx";
import { pageNotifications, showTestNotification, type NotificationState } from "../lib/notifications.ts";
import { refreshPushHealth, usePushHealth, type PushActionResult } from "../lib/pushHealth.ts";
import { pickTheme, rowFor, THEME_IDS, type Mode, type ThemeId } from "../lib/themes.ts";
import { useMediaQuery } from "../lib/useMediaQuery.ts";
import { agentRows, checkList, foundAgents, installedHere, phoneBoxMode, phoneBoxOpensFirst, phoneBoxStays, phoneWay, openInFolder, preferredAgent, relayOnlyPc, relayStep, settleDelay, setupView, signedInAgents, turnsUsageOn, type CheckStatus, type GuideEvent, type GuideState, type PcCheck, type PhoneBoxOpening } from "../lib/setupGuideFlow.ts";
import { focusInOtherModal, nativeModalOver, useFocusTrap } from "../lib/useFocusTrap.ts";
import { usePhoneSheetBack } from "../lib/sheetHistory.ts";
import { inRelayShell, useRelay, type RelayState } from "../lib/useRelay.ts";
import { browserStorage, USAGE_ARMED_KEY, usageReadAllowed } from "../lib/firstHints.ts";
import { useOtherDevice, useSignedInUsage } from "../lib/useSetupGuide.ts";
import { userErrorMessage, userFailure } from "../lib/userError.ts";
import { AgentMark } from "./AgentMark.tsx";
import { AgentTile } from "./AgentTile.tsx";
import { OvisMark } from "./OvisMark.tsx";
import { ChipToggles, Segmented } from "./SettingsControls.tsx";
import { ThemeCard, THEME_NAMES } from "./ThemeCard.tsx";
import { themeLabel } from "./ThemeFiles.tsx";
import { repairFailureText } from "./PushHealthNotice.tsx";
import { inNativeApp } from "../lib/nativeApp.ts";
import { desktopUpdateBridge } from "../lib/desktopUpdate.ts";
import { alertsFailed, alertsHere, alertsSurfaces, type AlertsHere as AlertsAnswer } from "../lib/setupGuideFlow.ts";
import { pushSupported, registeredPushEndpoint } from "../lib/push.ts";
import { confirmation } from "../lib/pushConfirm.ts";
import { AlertsChecking, ALERTS_CHECK_GIVE_UP_MS, useLongerThan } from "./AlertsChecking.tsx";
import { chosenTheme } from "../lib/customThemes.ts";
import { TelemetryNotice } from "./TelemetryControls.tsx";
import { UsageSignInDialog } from "./UsageSignInDialog.tsx";
import { QrCode } from "./QrCode.tsx";
import { copyText } from "../lib/clipboard.ts";
import { ExternalLink } from "../lib/externalLink.ts";
import { failureText, RelayPairing, statusText } from "./RelayPanel.tsx";
import "./SetupGuide.css";
import { RelayOnlyWarning } from "./RelayOnlyWarning.tsx";

type KnownAgent = Pick<AgentCatalogEntry, "id" | "name" | "kind">;
const HOME = "~";

export interface SetupGuideProps {
  state: GuideState;
  hidden?: boolean;
  dispatch: (event: GuideEvent) => void;
  onClose: () => void;
  onOpenTerminal: (paneId: string) => void;
  onOpenSettings: (page: "devices") => void;
  onOpenTelemetry: () => void;
  /** how this browser got in: one in only because nothing is paired yet pairs itself first (Connect your phone) */
  auth: HealthAuth | null;
  /** the server's access facts: whether turning the relay on closes the open device gate (Connect your phone) */
  security: SecurityFacts;
  onPaired: () => void;
  onEnableAlerts: () => Promise<PushActionResult>;
  settingsOpen?: boolean;
  pushOn?: boolean;
  /** the server's shared settings were read (lib/preferencesSync.ts `known`): plan usage this browser saw on may be off by now */
  sharedSettingsKnown?: boolean;
  notifications: NotificationState;
  onStarting?: () => void;
  onOpened: (paneId: string, agentStarted: boolean) => void;
  /** this PC lists account-opens-all/1: the relay box warns a relay-only PC (RelayOnlyWarning) */
  opensAll?: boolean;
}

export function SetupGuide(props: SetupGuideProps) {
  const { state, onClose, hidden = false } = props;
  const t = useT();
  const machineId = useMachineId();
  const [catalog, setCatalog] = useState<AgentCatalogRow[] | null>(null);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [known, setKnown] = useState<readonly KnownAgent[]>([]);
  const [ready, setReady] = useState<readonly string[]>([]);
  const [phoneClosed, setPhoneClosed] = useState(false);
  const [announced, setAnnounced] = useState("");
  const asked = useRef(0);
  const settle = useRef<number | undefined>(undefined);
  const loadCatalog = (): void => {
    const ask = ++asked.current;
    const startedAt = Date.now();
    window.clearTimeout(settle.current);
    setCatalog(null);
    setCatalogError(null);
    setReady([]);
    setAnnounced("");
    setChecking(true);
    import("../../shared/agent-catalog.ts").then((module) => setKnown(module.AGENT_CATALOG), () => {});
    fetchAgentCatalog(machineId).then((answer) => {
      if (ask !== asked.current) return;
      setCatalog(answer.agents);
      settle.current = window.setTimeout(() => {
        if (ask !== asked.current) return;
        setChecking(false);
        setAnnounced(foundAgents(answer.agents).length > 0 ? t("Pick an agent") : t("Install an agent"));
      }, settleDelay(startedAt, Date.now()));
    }, (error: unknown) => {
      if (ask !== asked.current) return;
      setCatalogError(userFailure(error).kind === "unknown" ? t("Couldn't load the agents.") : userErrorMessage(error).message);
      setChecking(false);
    });
  };
  const agentInstalled = (agent: string): void => {
    if (ready.includes(agent)) return;
    setReady((list) => list.includes(agent) ? list : [...list, agent]);
    setAnnounced(t("{agent} is ready", { agent: catalog?.find((row) => row.id === agent)?.name ?? agent }));
    const ask = ++asked.current;
    fetchAgentCatalog(machineId).then((answer) => { if (ask === asked.current) setCatalog(answer.agents); }, () => { /* Start works without the version */ });
  };
  useEffect(() => {
    loadCatalog();
    return () => { asked.current += 1; window.clearTimeout(settle.current); };
  }, [machineId]); // eslint-disable-line react-hooks/exhaustive-deps
  const check: PcCheck = { checking, catalog, failed: catalogError !== null };
  const [page, setPage] = useState<GuidePage>(state.at ?? "agent");
  useEffect(() => { if (state.at !== undefined && page !== state.at) props.dispatch({ type: "moved" }); }, [page]); // eslint-disable-line react-hooks/exhaustive-deps
  const view = setupView(check);

  const firstFocus = useRef<HTMLElement | null>(null);
  const surface = useFocusTrap<HTMLElement>(!hidden, { initialFocus: firstFocus });
  usePhoneSheetBack(onClose, !hidden);
  useEffect(() => {
    if (hidden) return;
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key !== "Escape" || event.isComposing || event.keyCode === 229 || event.defaultPrevented) return;
      if (focusInOtherModal(surface.current) || nativeModalOver(surface.current)) return;
      event.preventDefault();
      onClose();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [hidden, onClose, surface]);
  const stepBefore = useRef(state.step);
  useEffect(() => {
    if (stepBefore.current === state.step) return;
    stepBefore.current = state.step;
    if (!hidden) firstFocus.current?.focus({ preventScroll: true });
  }, [state.step, hidden]);
  const viewBefore = useRef(view);
  const headHanded = useRef(false);
  useEffect(() => {
    if (viewBefore.current === view) return;
    viewBefore.current = view;
    // a dialog over the guide (Settings, a sign-in) keeps the keyboard: Escape there must not close the guide
    if (focusInOtherModal(surface.current)) return;
    const active = document.activeElement;
    const inHead = active !== null && active.closest(".setup-head") !== null;
    if (!hidden && (active === null || active === document.body || !surface.current?.contains(active) || (inHead && !headHanded.current))) document.getElementById("setup-step-title")?.focus({ preventScroll: true });
    headHanded.current = true;
  }, [view, hidden, surface]);

  const notice = <TelemetryNotice inline enabled={!hidden} onOpen={props.onOpenTelemetry} />;
  let body: ReactNode;
  if (view === "agents" && catalog !== null) body = <Steps page={page} setPage={setPage} onEnableAlerts={props.onEnableAlerts} notifications={props.notifications} settingsOpen={props.settingsOpen} pushOn={props.pushOn} sharedSettingsKnown={props.sharedSettingsKnown} catalog={catalog} ready={ready} machineId={machineId} onClose={onClose} onInstalled={agentInstalled} onLookAgain={loadCatalog} onOpenTerminal={props.onOpenTerminal} onOpened={props.onOpened} onOpenSettings={props.onOpenSettings} auth={props.auth} security={props.security} opensAll={props.opensAll} onStarting={props.onStarting} onPaired={props.onPaired} usageOn={turnsUsageOn(props.state)} phoneFirst={!phoneClosed && phoneBoxOpensFirst(props.state, isLoopbackHost(window.location.hostname))} onPhoneClosed={() => setPhoneClosed(true)} notice={notice} firstFocus={firstFocus} />;
  else body = <CheckStep onClose={onClose} notice={notice} firstFocus={firstFocus}>{view === "failed" ? <CheckFailed error={catalogError} onLookAgain={loadCatalog} /> : <Checking known={known} catalog={catalog} />}</CheckStep>;

  return (
    <div className="modal-scrim setup-scrim" hidden={hidden}>
      {/* stepped aside (hidden) it is no dialog: the app's checks for an open modal (typing, the drawer, Escape) must not
          find it, as the drawer and the docked WebPanel drop theirs */}
      <section ref={surface} className="modal setup-dialog" role={hidden ? undefined : "dialog"} aria-modal={hidden ? undefined : true} aria-labelledby={hidden ? undefined : "setup-dialog-name"} tabIndex={-1}>
        <header className="modal-header setup-head">
          <span className="setup-brand" id="setup-dialog-name"><OvisMark width={24} height={24} />{t("Set up Ovis")}</span>
          {/* the steps' list sits here once the guide has more than one step */}
          {<StepList page={page} agent={catalog !== null && agentRows(catalog, ready).some((row) => installedHere(row, ready))} />}
          <button type="button" className="icon-button" aria-label={t("Close setup")} title={t("Close setup")} onClick={onClose}><X aria-hidden="true" /></button>
        </header>
        <p className="visually-hidden" role="status">{announced}</p>
        {body}
      </section>
    </div>
  );
}

type FirstFocus = MutableRefObject<HTMLElement | null>;

function StepTitle({ children, firstFocus }: { children: ReactNode; firstFocus: FirstFocus }) {
  const ref = useCallback((node: HTMLHeadingElement | null) => { firstFocus.current = node; }, [firstFocus]);
  return <h2 ref={ref} id="setup-step-title" className="setup-title" tabIndex={-1}>{children}</h2>;
}

function CheckStep({ onClose, notice, firstFocus, children }: { onClose: () => void; notice: ReactNode; firstFocus: FirstFocus; children: ReactNode }) {
  const t = useT();
  return (
    <>
      <div className="modal-body setup-body setup-body-single">
        <div className="setup-main">
          {children}
          {notice}
        </div>
      </div>
      <footer className="modal-footer setup-foot">
        <button type="button" className="btn btn-ghost setup-later" title={t("Reopen it in Settings → Agents.")} onClick={onClose}>{t("Set up later")}</button>
        <button type="button" className="btn btn-primary" disabled>{t("Continue")}<ArrowRight aria-hidden="true" /></button>
      </footer>
      {/* the title lives in the children; the check's own heading takes the focus */}
      <FocusTitle firstFocus={firstFocus} />
    </>
  );
}

function FocusTitle({ firstFocus }: { firstFocus: FirstFocus }) {
  useLayoutEffect(() => { firstFocus.current = document.getElementById("setup-step-title"); });
  return null;
}

function checkLine(t: Translate, status: CheckStatus): ReactNode {
  switch (status.kind) {
    case "looking": return <><LoaderCircle aria-hidden="true" className="setup-spin" /><span className="visually-hidden">{t("Looking")}</span></>;
    case "installed": return <><Check aria-hidden="true" />{status.version === null ? t("Installed") : t("Installed · v{version}", { version: status.version })}</>;
    case "missing": return t("Not installed");
    case "unknown": return t("Can't tell");
  }
}

function Checking({ known, catalog }: { known: readonly KnownAgent[]; catalog: readonly AgentCatalogRow[] | null }) {
  const t = useT();
  const lines = checkList(known, catalog);
  return (
    <>
      <h2 id="setup-step-title" className="setup-title" tabIndex={-1}>{t("Looking for agents…")}</h2>
      {lines.length > 0 && (
        <ul className="setup-check" aria-busy={catalog === null}>
          {lines.map((line) => (
            <li key={line.id} data-status={line.status.kind}>
              <AgentMark agent={line.id} size={18} />
              <span className="setup-check-name">{line.name}</span>
              <span className="setup-check-status">{checkLine(t, line.status)}</span>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

function CheckFailed({ error, onLookAgain }: { error: string | null; onLookAgain: () => void }) {
  const t = useT();
  return (
    <>
      <h2 id="setup-step-title" className="setup-title" tabIndex={-1}>{t("Couldn't look for agents")}</h2>
      {error !== null && <p className="setup-error" role="alert">{error}</p>}
      <div className="setup-actions">
        <button type="button" className="btn btn-primary" onClick={onLookAgain}><RotateCw aria-hidden="true" />{t("Look again")}</button>
      </div>
    </>
  );
}

interface StepsProps extends Pick<StepState, "page" | "setPage">, Pick<SetupGuideProps, "onEnableAlerts" | "notifications" | "settingsOpen" | "pushOn" | "sharedSettingsKnown" | "onOpenTerminal" | "onOpened" | "onOpenSettings" | "auth" | "security" | "onStarting" | "onPaired" | "onClose" | "opensAll"> {
  notice: ReactNode;
  usageOn: boolean;
  phoneFirst: boolean;
  onPhoneClosed: () => void;
  catalog: readonly AgentCatalogRow[];
  ready: readonly string[];
  machineId: string;
  onInstalled: (agent: string) => void;
  onLookAgain: () => void;
  firstFocus: FirstFocus;
}

function Steps({ page, setPage, onEnableAlerts, notifications, settingsOpen = false, pushOn = false, sharedSettingsKnown = false, catalog, ready, machineId, notice, onClose, onInstalled, onLookAgain, onOpenTerminal, onOpened, onOpenSettings, auth, security, onStarting, onPaired, usageOn, phoneFirst, onPhoneClosed, firstFocus, opensAll = false }: StepsProps) {
  const t = useT();
  const { settings, update } = useSettings();
  const agents = agentRows(catalog, ready);
  const installed = agents.filter((agent) => installedHere(agent, ready));
  const [picked, setPicked] = useState<string | null>(null);
  const chosen = installed.find((agent) => agent.id === picked) ?? preferredAgent(installed, ready.at(-1) ?? null);
  const pageBefore = useRef(page);
  useEffect(() => { if (page === "done" && chosen === null) setPage("agent"); }, [page, chosen]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (pageBefore.current === page) return;
    pageBefore.current = page;
    document.getElementById("setup-step-title")?.focus({ preventScroll: true });
  }, [page]);
  // plan usage: nothing is read from the PC's sign-ins, nor turned on, before the user's own press on the agent step
  // (Continue); Set up later from the first step reads nothing
  // (usageReadAllowed: once usage is on, the guide reads it only while it stays on, as the server's settings say)
  const [usageArmed, setUsageArmed] = useState(() => browserStorage()?.getItem(USAGE_ARMED_KEY) ?? null);
  useEffect(() => { if (settings.showUsage && usageArmed === "1") setUsageArmed("on"); }, [settings.showUsage, usageArmed]);
  const armUsage = (): void => {
    const armed = settings.showUsage ? "on" : "1";
    setUsageArmed(armed);
    try { browserStorage()?.setItem(USAGE_ARMED_KEY, armed); } catch { /* not kept: the next press arms it again */ }
  };
  const signedIn = useSignedInUsage(ready, (refresh) => fetchUsage(refresh).then((report) => signedInAgents(report.providers)), settings.showUsage || !usageOn, () => update({ showUsage: true }), usageReadAllowed(usageArmed, settings.showUsage, sharedSettingsKnown));
  // Accounts are read on the server's PC, so only its own guide offers it, and a
  // watching device signs in to nothing
  const [signedHere, setSignedHere] = useState<readonly string[]>([]);
  const unsigned = machineId === "local" && auth?.role !== "watch" && signedIn !== null ? installed.filter((agent) => (agent.id === "claude" || agent.id === "codex") && !signedIn.includes(agent.id) && !signedHere.includes(agent.id)) : [];
  const [signingIn, setSigningIn] = useState<{ provider: "claude" | "codex"; default: true } | null>(null);
  // the tiles whose install runs: Look again waits for them (a fresh read would end their watch);
  // Start does not: an install runs on in its tab whatever the guide does
  const [installing, setInstalling] = useState<readonly string[]>([]);
  const busy = installing.length > 0;
  const onRunning = useCallback((id: string, running: boolean): void => setInstalling((list) => running ? (list.includes(id) ? list : [...list, id]) : list.filter((one) => one !== id)), []);
  const [installErrors, setInstallErrors] = useState<Readonly<Record<string, string>>>({});
  const onInstallError = useCallback((id: string, message: string | null): void => setInstallErrors((errors) => {
    if ((errors[id] ?? null) === message) return errors;
    const next = { ...errors };
    if (message === null) delete next[id]; else next[id] = message;
    return next;
  }), []);
  // a missing agent has its Install (the user's tap is the consent: the official installer runs in a terminal tab while a ring turns on the tile)
  const installedFromTile = (id: string): void => { onInstalled(id); setPicked(id); };
  const [moreShown, setMoreShown] = useState(false);
  const others = agents.filter((agent) => !installedHere(agent, ready));
  const listed = installed.length === 0 || moreShown ? agents : agents.filter((agent) => installedHere(agent, ready) || installing.includes(agent.id) || agent.id in installErrors);
  const tilesRef = useRef<HTMLUListElement>(null);
  useEffect(() => {
    if (moreShown) tilesRef.current?.querySelector<HTMLElement>(".setup-tile[data-missing] button:not(:disabled)")?.focus({ preventScroll: true });
  }, [moreShown]); // eslint-disable-line react-hooks/exhaustive-deps
  const folder = recentDirectories.read("local")[0] ?? HOME;
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [madeWithout, setMadeWithout] = useState<string | null>(null);

  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const start = async (): Promise<void> => {
    if (madeWithout !== null) { onOpened(madeWithout, false); return; }
    if (opening || chosen === null) return;
    onStarting?.();
    setOpening(true);
    setError(null);
    const launch = newSessionLaunch({ agent: chosen.id, model: "", effort: "", prompt: "" }, settings);
    if ("fault" in launch) { setOpening(false); setError(t("{agent} can't start here. Use the sidebar.", { agent: chosen.name })); return; }
    try {
      const result = await openInFolder((directory) => createWorkspace(createRequest({ tab: null, directory, name: "" }, launch, null)), folder, HOME, (reason) => alive.current && reason instanceof ApiError && reason.code === "invalid_cwd");
      if (!alive.current) return;
      if (result.agent_started === false) {
        setOpening(false);
        setMadeWithout(result.pane_id);
        setError(t("{agent} didn't start. Its terminal shows why.", { agent: chosen.name }) + (result.error?.message ? ` (${result.error.message})` : ""));
        return;
      }
      onOpened(result.pane_id, true);
    } catch (reason: unknown) {
      if (!alive.current) return;
      setOpening(false);
      setError(userFailure(reason).kind === "unknown" ? t("Couldn't open the workspace.") : userErrorMessage(reason).message);
    }
  };

  const locked = opening || madeWithout !== null;
  const [phone, setPhoneState] = useState<PhoneBoxOpening | null>(phoneFirst ? "first-run" : null);
  const setPhone = (next: PhoneBoxOpening | null): void => { setPhoneState(next); if (next === null) onPhoneClosed(); };
  const startLabel = madeWithout !== null ? t("Open the workspace") : t("Start");
  const version = chosen?.state.installed === true ? chosen.state.version : null;
  const signInChosen = chosen !== null && unsigned.some((agent) => agent.id === chosen.id);
  const systemDark = useMediaQuery("(prefers-color-scheme: dark)");
  const drawnSide: Mode = settings.theme === "system" ? (systemDark ? "dark" : "light") : settings.theme;
  const themeSummary = [t(settings.theme === "system" ? "System" : settings.theme === "dark" ? "Dark" : "Light"), drawnThemeName(t, settings, drawnSide)].filter(Boolean).join(" · ");
  const pairedBefore = useOtherDevice((page === "phone" || page === "done") && !settingsOpen, page);
  const [alertsFailure, setAlertsFailure] = useState<string | null>(null);
  const [pairedNow, setPairedNow] = useState<string | null>(null);
  const settingsBefore = useRef(settingsOpen);
  useEffect(() => {
    if (settingsBefore.current && !settingsOpen) setPairedNow(null);
    settingsBefore.current = settingsOpen;
  }, [settingsOpen]);
  const phoneName = pairedNow ?? pairedBefore;
  const alertFilters = useAlertFilters();
  const alertKinds = alertMeWhenChips(t, settings, alertFilters, update, true).filter((chip) => chip.on && !(settings.alertDone === "always" && chip.label === t("Long turn finished"))).map((chip) => chip.label);
  const { health, checked, delivered } = usePushHealth();
  const alerts = alertsHere({ alertsOn: settings.alertsOn, notifications, desktop: desktopUpdateBridge() !== null, pushSupported: pushSupported(), pushOn, push: { checked, problem: health.problem, delivered }, confirmed: confirmation(registeredPushEndpoint()) });
  const uncheckable = useLongerThan(alerts === "checking", ALERTS_CHECK_GIVE_UP_MS);
  const alertsDone = alertsSurfaces(alerts).done;
  const alertsSummary = alertsDone === "done" && alertKinds.length > 0 ? alertKinds.join(", ") : null;
  const usageNote = signedIn !== null && signedIn.length > 0 && (settings.showUsage || usageOn) && <p className="setup-note"><Gauge aria-hidden="true" />{t("Your plan usage shows in the sidebar.")}</p>;
  const errorLine = error !== null && <p className="setup-error" role="alert">{error}</p>;
  const signInDialog = signingIn && <UsageSignInDialog request={signingIn} onOpenTerminal={(paneId) => { setSigningIn(null); onOpenTerminal(paneId); }} onSignedIn={() => setSignedHere((done) => [...done, signingIn.provider])} onClose={() => setSigningIn(null)} />;

  if (page === "theme") return (
    <>
      <ThemeStep firstFocus={firstFocus}>{errorLine}{notice}</ThemeStep>
      <footer className="modal-footer setup-foot">
        <button type="button" className="btn btn-ghost setup-later" title={t("Reopen it in Settings → Agents.")} onClick={onClose}>{t("Set up later")}</button>
        <button type="button" className="btn" disabled={locked} onClick={() => setPage("agent")}><ChevronLeft aria-hidden="true" />{t("Back")}</button>
        {madeWithout !== null
          ? <button type="button" className="btn btn-primary" onClick={() => void start()}><Play aria-hidden="true" />{t("Open the workspace")}</button>
          : <button type="button" className="btn btn-primary" disabled={locked} onClick={() => setPage("phone")}>{t("Continue")}<ArrowRight aria-hidden="true" /></button>}
      </footer>
    </>
  );

  if (page === "phone") return (
    <>
      <div className="modal-body setup-body">
        <div className="setup-main">
          <StepTitle firstFocus={firstFocus}>{t("Stay in touch")}</StepTitle>
          <AlertsPicture alerts={alerts} phoneName={phoneName} />
          <AlertsHere onEnable={onEnableAlerts} notifications={notifications} alerts={alerts} uncheckable={uncheckable} failure={alertsFailure} onFailure={setAlertsFailure} />
          {errorLine}
          {notice}
        </div>
        <aside className="setup-side setup-side-phone" aria-labelledby="setup-phone-label">
          <span className="setup-label" id="setup-phone-label">{t("On your phone")}</span>
          {phoneName !== null && <p className="setup-paired"><CircleCheck aria-hidden="true" />{t("{name} is connected.", { name: phoneName })}</p>}
          <PhonePanel auth={auth} security={security} opensAll={opensAll} onOpenSettings={() => onOpenSettings("devices")} onPaired={onPaired} onPhonePaired={setPairedNow} />
        </aside>
      </div>
      <footer className="modal-footer setup-foot">
        <button type="button" className="btn btn-ghost setup-later" title={t("Reopen it in Settings → Agents.")} onClick={onClose}>{t("Set up later")}</button>
        <button type="button" className="btn" disabled={locked} onClick={() => setPage("theme")}><ChevronLeft aria-hidden="true" />{t("Back")}</button>
        {madeWithout !== null
          ? <button type="button" className="btn btn-primary" onClick={() => void start()}><Play aria-hidden="true" />{t("Open the workspace")}</button>
          : chosen === null
            ? <button type="button" className="btn btn-primary" onClick={onClose}>{t("Done")}</button>
            : <button type="button" className="btn btn-primary" disabled={locked} onClick={() => setPage("done")}>{t("Continue")}<ArrowRight aria-hidden="true" /></button>}
      </footer>
    </>
  );

  if (page === "done" && chosen !== null) return (
    <>
      <div className="modal-body setup-body setup-body-single">
        <div className="setup-main">
          <StepTitle firstFocus={firstFocus}>{t("Ovis is ready")}</StepTitle>
          <p className="setup-lead">{folder === HOME
            ? t("{agent} starts in your home folder.", { agent: chosen.name })
            : t("{agent} starts in {folder}.", { folder, agent: chosen.name })}</p>
          <ul className="setup-list setup-summary">
            <li className="setup-item is-done"><CircleCheck role="img" aria-label={t("Done")} /><span className="setup-summary-row"><span className="setup-summary-name">{t("Agent")}</span><span>{version === null ? chosen.name : `${chosen.name} ${version}`}</span></span></li>
            <li className="setup-item is-done"><CircleCheck role="img" aria-label={t("Done")} /><span className="setup-summary-row"><span className="setup-summary-name">{t("Theme")}</span><span>{themeSummary}</span></span></li>
            <li className={phoneName !== null ? "setup-item is-done" : "setup-item"}>{phoneName !== null ? <CircleCheck role="img" aria-label={t("Done")} /> : <Circle role="img" aria-label={t("Not yet")} />}<span className="setup-summary-row"><span className="setup-summary-name">{t("Phone")}</span>
              {phoneName !== null ? <span>{phoneName}</span> : <span>{t("Later")} <button type="button" className="setup-link" disabled={locked} onClick={() => setPage("phone")}>{t("Connect now")}</button></span>}</span></li>
            <li className={alertsSummary === null ? "setup-item" : "setup-item is-done"}>{alertsSummary === null ? <Circle role="img" aria-label={t("Not yet")} /> : <CircleCheck role="img" aria-label={t("Done")} />}<span className="setup-summary-row"><span className="setup-summary-name">{t("Alerts")}</span><span>{alertsSummary ?? (alertsDone === "checking" ? (uncheckable ? t("Couldn't check alerts.") : t("Checking…")) : alertsDone === "unavailable" ? t("This address can't get alerts.") : t("Alerts off"))}</span></span></li>
          </ul>
          {usageNote}
          {errorLine}
          {notice}
        </div>
      </div>
      <footer className="modal-footer setup-foot">
        <button type="button" className="btn" disabled={locked} onClick={() => setPage("phone")}><ChevronLeft aria-hidden="true" />{t("Back")}</button>
        <button type="button" className="btn btn-primary" disabled={opening} onClick={() => void start()}><Play aria-hidden="true" />{startLabel}</button>
      </footer>
    </>
  );

  return (
    <>
      <div className="modal-body setup-body">
        <div className="setup-main">
          {installed.length > 0 ? (
            <>
              <StepTitle firstFocus={firstFocus}>{t("Pick an agent")}</StepTitle>
              <p className="setup-lead">{t("Found on this PC.")}</p>
            </>
          ) : (
            <>
              <StepTitle firstFocus={firstFocus}>{t("Install an agent")}</StepTitle>
              <p className="setup-lead">{t("Nothing installs until you press Install.")}</p>
            </>
          )}
          <ul ref={tilesRef} className="setup-found" aria-label={t("Agents")}>
            {listed.map((agent) => (
              <AgentTile key={agent.id} agent={agent} has={installedHere(agent, ready)} picked={chosen?.id === agent.id} locked={locked} machineId={machineId}
                onPick={setPicked} onOpenTerminal={onOpenTerminal} onRunning={onRunning} onInstalled={installedFromTile} onError={onInstallError} />
            ))}
          </ul>
          {Object.values(installErrors).map((message) => <p key={message} className="setup-error" role="alert">{message}</p>)}
          {((installed.length > 0 && others.length > 0 && !moreShown) || (!busy && !locked)) && (
            <p className="setup-muted setup-again">
              {installed.length > 0 && others.length > 0 && !moreShown && <button type="button" className="setup-link" onClick={() => setMoreShown(true)}>{t("{count} more agents", { count: others.length })}</button>}
              {!busy && !locked && <span>{t("Installed one already?")} <button type="button" className="setup-link" onClick={onLookAgain}>{t("Look again")}</button></span>}
            </p>
          )}
          {errorLine}
          {notice}
        </div>
        <aside className="setup-side" aria-label={chosen !== null ? chosen.name : t("Agents")}>
          {chosen !== null ? (
            <>
              <div className="setup-agent-head"><AgentMark agent={chosen.id} size={24} /><strong>{chosen.name}</strong></div>
              <ul className="setup-list">
                <li className="setup-item is-done"><CircleCheck aria-hidden="true" /><span>{version === null ? t("Installed") : t("Installed · v{version}", { version })}</span></li>
                {signInChosen && (
                  <li className="setup-item"><KeyRound aria-hidden="true" /><span>{t("{agent} needs a sign-in.", { agent: chosen.name })}{" "}
                    <button type="button" className="setup-link" disabled={locked} onClick={() => setSigningIn({ provider: chosen.id as "claude" | "codex", default: true })}>{t("Sign in to {agent}", { agent: chosen.name })}</button></span></li>
                )}
                <li className="setup-item"><Folder aria-hidden="true" /><span>{folder === HOME ? t("Starts in your home folder.") : t("Starts in {folder}.", { folder })}</span></li>
              </ul>
              {usageNote}
            </>
          ) : (
            <>
              <p className="setup-muted">{t("Install one to begin.")}</p>
              {/* with nothing installed there is no Done yet: the phone can be connected from here meanwhile */}
              <span className="setup-label" id="setup-phone-label">{t("On your phone")}</span>
              <div className="setup-actions">
                <button type="button" className="btn" aria-expanded={phone !== null} onClick={() => setPhone(phone === null ? "tap" : null)}><Smartphone aria-hidden="true" />{t("Connect your phone")}</button>
              </div>
              {phone !== null && <PhoneBox opening={phone} auth={auth} security={security} opensAll={opensAll} onOpenSettings={() => { setPhone(null); onOpenSettings("devices"); }} onPaired={onPaired} onPhonePaired={setPairedNow} onWithdraw={() => setPhone(null)} />}
            </>
          )}
        </aside>
      </div>
      <footer className="modal-footer setup-foot">
        <button type="button" className="btn btn-ghost setup-later" title={t("Reopen it in Settings → Agents.")} onClick={onClose}>{t("Set up later")}</button>
        {madeWithout !== null
          ? <button type="button" className="btn btn-primary" onClick={() => void start()}><Play aria-hidden="true" />{t("Open the workspace")}</button>
          : <button type="button" className="btn btn-primary" disabled={chosen === null || locked || busy} onClick={() => { armUsage(); setPage("theme"); }}>{t("Continue")}<ArrowRight aria-hidden="true" /></button>}
      </footer>
      {signInDialog}
    </>
  );
}

type GuidePage = "agent" | "theme" | "phone" | "done";
interface StepState { page: GuidePage; setPage: (page: GuidePage) => void }
const STEPS: readonly Exclude<GuidePage, "done">[] = ["agent", "theme", "phone"];

function StepList({ page, agent }: { page: GuidePage; agent: boolean }) {
  const t = useT();
  const pages: readonly GuidePage[] = agent ? [...STEPS, "done"] : STEPS;
  const at = Math.max(0, pages.indexOf(page));
  const done = (step: GuidePage, index: number): boolean => index < at && (step !== "agent" || agent);
  const labels: Record<GuidePage, string> = { agent: t("Agent"), theme: t("Theme"), phone: t("Phone and alerts"), done: t("Done") };
  return (
    <div className="setup-steps-bar">
      <ol className="setup-steps" aria-label={t("Steps")}>
        {pages.map((step, index) => (
          <li key={step} className={done(step, index) ? "is-done" : index === at ? "is-current" : undefined} aria-current={index === at ? "step" : undefined}>
            <span className="visually-hidden">{labels[step]}</span>
          </li>
        ))}
      </ol>
      <span className="setup-steps-count" aria-hidden="true">{at + 1} / {pages.length}</span>
    </div>
  );
}

function ThemePreview() {
  const t = useT();
  const rows = [
    { agent: "claude", name: "checkout-api", status: "blocked" },
    { agent: "codex", name: "web-dashboard", status: "working" },
    { agent: "opencode", name: "docs-site", status: "done" },
  ] as const;
  return (
    <div className="setup-preview" aria-hidden="true" inert>
      <div className="setup-preview-side">
        {rows.map((row, index) => (
          <div key={row.name} className={index === 0 ? "setup-preview-row is-selected" : "setup-preview-row"}>
            <AgentMark agent={row.agent} size={14} />
            <span className="setup-preview-name">{row.name}</span>
            <span className={`badge badge-${row.status} sidebar-status`} data-status={row.status}>
              {row.status === "blocked" ? <span className="sidebar-status-mark">?</span> : <span className="sidebar-status-dot" />}
            </span>
          </div>
        ))}
      </div>
      <div className="setup-preview-pane">
        <div className="setup-preview-head">
          <span className="setup-preview-title"><AgentMark agent="claude" size={14} />{t("Idempotent payments")}</span>
          <span className="setup-preview-lens"><span className="is-on">{t("Chat")}</span><span>{t("Terminal")}</span></span>
        </div>
        <div className="setup-preview-chat">
          <p className="setup-preview-user">{t("Nice. Now add a metric for replayed requests.")}</p>
          <p>{t("Adding a counter next to the existing request metrics.")}</p>
          <pre className="setup-preview-code"><span className="is-keyword">const</span> replays = <span className="is-function">counter</span>(<span className="is-string">"replays_total"</span>);{"\n"}replays.<span className="is-function">inc</span>({"{ route }"});</pre>
        </div>
        <pre className="setup-preview-term"><span className="is-dim">$</span> bun test metrics{"\n"}<span className="is-pass">12 pass</span> · 0 fail</pre>
      </div>
    </div>
  );
}

/**
 * The test is the page's own notification, as an open tab of Ovis shows its alerts, so it works in the
 * desktop app too, where web push does not reach; Settings → Alerts' test goes through the push service.
 */
function AlertsHere({ onEnable, notifications: state, alerts, uncheckable, failure, onFailure }: { onEnable: () => Promise<PushActionResult>; notifications: NotificationState; alerts: AlertsAnswer; uncheckable: boolean; failure: string | null; onFailure: (text: string | null) => void }) {
  const t = useT();
  const { settings, update } = useSettings();
  const filters = useAlertFilters();
  const [busy, setBusy] = useState<"enable" | "test" | null>(null);
  const [line, setLine] = useState<"sent" | "failed" | null>(null);
  const enable = async (): Promise<void> => {
    setBusy("enable");
    onFailure(null);
    try {
      const result = await onEnable();
      if (alertsFailed(result, desktopUpdateBridge() !== null) === false) { onFailure(null); return; }
      onFailure(alertsFailureText(t, result));
    } finally { setBusy(null); }
  };
  const test = async (): Promise<void> => {
    setBusy("test");
    setLine(null);
    try { setLine(await showTestNotification(t("Test alert"), t("This is how alerts look.")) ? "sent" : "failed"); } finally { setBusy(null); }
  };
  const shown = alertsSurfaces(alerts).step;
  const on = shown === "send-test";
  return (
    <div className="setup-field setup-alerts">
      {shown === "note" ? <p className="setup-note"><Info aria-hidden="true" />{t("This address can't get alerts.")}</p>
        : state === "denied" ? (
          <>
            <p className="setup-note setup-note-blocked"><TriangleAlert aria-hidden="true" /><span><strong>{t("Alerts are blocked.")}</strong> {inNativeApp() ? t("Allow them in the phone's Settings.") : t("Allow them in your browser settings.")}</span></p>
            {/* the try again: the browser's answer is read anew */}
            <div className="setup-actions">
              <button type="button" className="btn" disabled={busy !== null} onClick={() => void enable()}><Bell aria-hidden="true" />{busy === "enable" ? t("Turning alerts on…") : t("Try again")}</button>
            </div>
          </>
        ) : shown === "checking" ? <AlertsChecking uncheckable={uncheckable} onRetry={() => void refreshPushHealth(true)} />
        : !on && (
          <div className="setup-actions">
            <button type="button" className="btn" disabled={busy !== null} onClick={() => void enable()}><Bell aria-hidden="true" />{busy === "enable" ? t("Turning alerts on…") : t("Turn on alerts")}</button>
          </div>
        )}
      {/* Settings → Alerts' own chips, but Stopped on an error, which stays there */}
      <ChipToggles label={t("Alert me when")} chips={alertMeWhenChips(t, settings, filters, update, false)} />
      {on && pageNotifications() && (
        <div className="setup-actions">
          <button type="button" className="btn" disabled={busy !== null} onClick={() => void test()}><BellRing aria-hidden="true" />{busy === "test" ? t("Sending…") : t("Send test")}</button>
        </div>
      )}
      {/* always in the document, empty until there is something to say: a live region */}
      <p className="setup-muted" role="status">{failure !== null ? failure : line === "sent" ? t("Sent. Check your screen.") : line === "failed" ? t("Couldn't send the test.") : null}</p>
    </div>
  );
}

const THEMES_FIRST = 6;

function alertsFailureText(t: Translate, result: PushActionResult): string | null {
  if (result === "sent") return null;
  if (result === "permission") return inNativeApp() ? t("Allow them in the phone's Settings.") : t("Allow them in your browser settings.");
  if (result === "gone") return t("Alerts stopped here. Turn them on again.");
  if (result === "failed") return t("Couldn't send the test.");
  if (result === "unsupported") return t("This address can't get alerts.");
  return repairFailureText(t, result) ?? t("Couldn't send the test.");
}

function drawnThemeName(t: Translate, settings: Settings, side: Mode): string | null {
  if (settings.customThemes[side] === null) return t(THEME_NAMES[side === "dark" ? settings.darkTheme : settings.lightTheme]);
  const imported = chosenTheme(settings.customThemes, side);
  return imported === undefined ? null : themeLabel(t, imported, settings.customThemes.themes);
}

function ThemeStep({ firstFocus, children }: { firstFocus: FirstFocus; children: ReactNode }) {
  const t = useT();
  const { settings, update } = useSettings();
  const systemDark = useMediaQuery("(prefers-color-scheme: dark)");
  const side: Mode = settings.theme === "system" ? (systemDark ? "dark" : "light") : settings.theme;
  const [all, setAll] = useState(false);
  const cards = useRef<HTMLDivElement>(null);
  const current: ThemeId | null = settings.customThemes[side] === null ? (side === "dark" ? settings.darkTheme : settings.lightTheme) : null;
  const own = THEME_IDS.filter((id) => rowFor(id, side).mode === side);
  const others = THEME_IDS.filter((id) => rowFor(id, side).mode !== side);
  const keptBySide = useRef(new Map<Mode, Set<ThemeId>>());
  const kept = keptBySide.current.get(side) ?? new Set<ThemeId>();
  keptBySide.current.set(side, kept);
  if (current !== null && !own.slice(0, THEMES_FIRST).includes(current)) kept.add(current);
  const shown = all ? [...own, ...others] : own.slice(0, THEMES_FIRST).concat([...own.slice(THEMES_FIRST), ...others].filter((id) => kept.has(id)));
  const pick = (id: ThemeId): void => update((latest) => ({ ...pickTheme(latest, side, id), customThemes: { ...latest.customThemes, [side]: null } }));
  const step = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    const delta = event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 0;
    if (delta === 0 && event.key !== "Home" && event.key !== "End") return;
    const list = [...(cards.current?.querySelectorAll<HTMLElement>("[data-theme-card]") ?? [])];
    const at = list.indexOf(document.activeElement as HTMLElement);
    const next = event.key === "Home" ? 0 : event.key === "End" ? shown.length - 1 : (at + delta + shown.length) % shown.length;
    event.preventDefault();
    const id = shown[next];
    if (id !== undefined) pick(id);
    list[next]?.focus();
  };
  const allBefore = useRef(all);
  useEffect(() => {
    if (allBefore.current === all) return;
    allBefore.current = all;
    const first = shown.find((id) => !own.slice(0, THEMES_FIRST).includes(id) && id !== current);
    if (first !== undefined) cards.current?.querySelector<HTMLElement>(`[data-theme-card="${first}"]`)?.focus({ preventScroll: false });
  }, [all]); // eslint-disable-line react-hooks/exhaustive-deps
  const cardsHadFocus = useRef(false);
  const sideBefore = useRef(side);
  useLayoutEffect(() => {
    if (sideBefore.current === side) return;
    sideBefore.current = side;
    const group = cards.current;
    if (!cardsHadFocus.current || group === null || group.contains(document.activeElement)) return;
    (group.querySelector<HTMLElement>("[aria-checked='true']") ?? group.querySelector<HTMLElement>("[data-theme-card]"))?.focus();
  }, [side]);
  const sideLabel = t(side === "dark" ? "Dark theme" : "Light theme");
  return (
    <div className="modal-body setup-body">
      <div className="setup-main">
        <StepTitle firstFocus={firstFocus}>{t("Pick a look")}</StepTitle>
        <p className="setup-lead">{t("Change it later in Settings.")}</p>
        <div className="setup-field">
          <span className="setup-label" aria-hidden="true">{t("Theme")}</span>
          <Segmented label={t("Theme")} value={settings.theme} onChange={(theme) => update({ theme })} options={[{ value: "system", label: t("System") }, { value: "light", label: t("Light") }, { value: "dark", label: t("Dark") }]} />
          <p className="setup-muted">{settings.theme === "system" ? t(side === "dark" ? "Follows this computer. It is dark now." : "Follows this computer. It is light now.") : t("Every device gets this theme.")}</p>
        </div>
        <div className="setup-field">
          <span className="setup-label" aria-hidden="true">{sideLabel}</span>
          <div ref={cards} className="setup-theme-cards" role="radiogroup" aria-label={sideLabel} onKeyDown={step} onFocus={() => { cardsHadFocus.current = true; }} onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null) && event.relatedTarget !== null) cardsHadFocus.current = false; }}>
            {shown.map((id, index) => <ThemeCard key={id} card={id} name={t(THEME_NAMES[id])} row={rowFor(id, side)} side={side} checked={current === id} focusable={current === null ? index === 0 : current === id} onPick={() => pick(id)} />)}
          </div>
          {!all && <button type="button" className="setup-link" onClick={() => setAll(true)}>{t("Show all themes")}</button>}
        </div>
        {children}
      </div>
      <aside className="setup-side" aria-labelledby="setup-theme-preview">
        <span className="setup-label" id="setup-theme-preview">{t("Preview")}</span>
        <ThemePreview />
        <p className="setup-text">{[t(side === "dark" ? "Dark" : "Light"), drawnThemeName(t, settings, side)].filter(Boolean).join(" · ")}</p>
      </aside>
    </div>
  );
}

const PAIRING_POLL_MS = 3000;
let pairedHere = false;

// the guide's code request, while it is out: a box closed and opened again joins it instead of
// sending a second one (each new code replaces the server's pending one)
let pairingOut: Promise<PairingCode> | null = null;
const guidePairingCode = (): Promise<PairingCode> => pairingOut ??= startPairing().finally(() => { pairingOut = null; });

// the relay's start, while it is out, kept here too: Back or Continue mounts the phone step afresh, and its tabs
// must still wait for a start a box since gone sent
let relayStartOut = false;
const relayStartWatchers = new Set<() => void>();
const watchRelayStart = (watch: () => void): (() => void) => { relayStartWatchers.add(watch); return () => { relayStartWatchers.delete(watch); }; };
const relayStarting = (): boolean => relayStartOut;
const setRelayStartOut = (out: boolean): void => { relayStartOut = out; for (const watch of relayStartWatchers) watch(); };
const useRelayStarting = (): boolean => useSyncExternalStore(watchRelayStart, relayStarting);

interface PhoneBoxProps {
  opening: PhoneBoxOpening;
  onWithdraw: () => void;
  auth: HealthAuth | null;
  security: SecurityFacts;
  onOpenSettings: () => void;
  onPaired: () => void;
  onPhonePaired: (name: string) => void;
  opensAll: boolean;
}

function PhoneBox({ opening, onWithdraw, auth, security, onOpenSettings, onPaired, onPhonePaired, opensAll }: PhoneBoxProps) {
  const t = useT();
  const relay = useRelay();
  const [other, setOther] = useState(false);
  const way = other ? "other" : phoneWay(relay, inRelayShell(), auth);
  const starting = useRelayStarting();
  const led = useRef(false);
  if (way === "relay") led.current = true;
  const stays = phoneBoxStays(other ? "tap" : opening, way, led.current);
  useEffect(() => { if (!stays) onWithdraw(); }, [stays]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!stays) return null;
  if (way === "wait") return (
    <div className="setup-phone-relay">
      <p className="setup-muted"><LoaderCircle aria-hidden="true" className="setup-spin" /></p>
      <button type="button" className="setup-link setup-phone-other" disabled={starting} onClick={() => setOther(true)}>{t("Use Tailscale or Wi-Fi instead")}</button>
    </div>
  );
  if (way === "other") return <PhoneQr auth={auth} onOpenSettings={onOpenSettings} onPaired={onPaired} onPhonePaired={onPhonePaired} />;
  // as Settings → Phone works it out: the relay closes a gate still open with no token set (server/relay/service.ts)
  const closesGate = security.state === "known" && security.summary.pairing_gate === "open" && !security.summary.token_configured;
  return <RelayBox relay={relay} auth={auth} closesGate={closesGate} opensAll={opensAll} relayOnly={security.state === "known" && relayOnlyPc(security.summary)} onPaired={onPaired} onPhonePaired={onPhonePaired} onOther={() => setOther(true)} />;
}

/**
 * The user's tap on the relay's button is the consent. Turning it on closes a device
 * gate still open, which would shut out a browser in only because nothing is paired yet (auth via
 * "open": a LAN or tailnet address, never the PC's loopback), so that browser pairs itself first.
 */
function RelayBox({ relay, auth, closesGate, opensAll, relayOnly, onPaired, onPhonePaired, onOther, tight = false }: { relay: RelayState; auth: HealthAuth | null; closesGate: boolean; opensAll: boolean; relayOnly: boolean; onPaired: () => void; onPhonePaired: (name: string) => void; onOther?: () => void; tight?: boolean }) {
  const t = useT();
  const { status, pending, request, reread } = relay;
  const [error, setError] = useState<string | null>(null);
  const [pairedSelf, setPairedSelf] = useState(false);
  const startOut = useRelayStarting();
  // a start this box did not send (a box since gone did) answered only that box: read the relay again
  const startWasOut = useRef(startOut);
  useEffect(() => {
    if (startWasOut.current && !startOut) reread();
    startWasOut.current = startOut;
  }, [startOut, reread]);
  if (status === null) return null;
  const step = relayStep(status);
  const busy = pending || startOut;
  const start = async (): Promise<void> => {
    if (busy) return;
    setRelayStartOut(true);
    setError(null);
    try {
      if (auth?.via === "open" && !pairedHere) {
        // not bounded here: a second pairing beside one still out could leave its void cookie in place of the good one
        // (pairing.ts), so the ways wait for it as they wait for the start; Set up later, Back and Escape still work
        await pairThisBrowser();
        pairedHere = true;
        setPairedSelf(true);
        onPaired();
      }
      // bounded by requestRelay itself: the ways wait as long as the start is out
      await request("start");
    } catch (reason: unknown) {
      setError(reason instanceof UnconfirmedPairing ? t("Couldn't connect this browser. Turn on cookies.") : failureText(reason));
    } finally { setRelayStartOut(false); }
  };
  return (
    <div className="setup-phone-relay">
      {step === "off" && (
        <>
          {!tight && <p className="setup-phone-relay-lead">{t("Reach this PC from anywhere.")}</p>}
          {closesGate && <p className="setup-muted">{t("New browsers will then need a code.")}</p>}
          <div className="setup-actions">
            <button type="button" className="btn" disabled={busy} onClick={() => void start()}><Smartphone aria-hidden="true" />{t("Turn on")}</button>
          </div>
        </>
      )}
      {step === "starting" && <p className="setup-muted setup-phone-relay-state" role="status">{status.phase === "connecting" && <LoaderCircle aria-hidden="true" className="setup-spin" />}{statusText(t, status)}</p>}
      {step === "not-started" && (
        <>
          <p className="setup-error" role="alert">{t("Couldn't turn it on: {message}", { message: status.error ?? "" })}</p>
          <div className="setup-actions">
            <button type="button" className="btn" disabled={busy} onClick={() => void start()}><RotateCw aria-hidden="true" />{t("Try again")}</button>
          </div>
        </>
      )}
      {step === "online" && (tight ? <TightRelayQr onPhonePaired={onPhonePaired} /> : <RelayQr onPhonePaired={onPhonePaired} />)}
      <RelayOnlyWarning opensAll={opensAll} relayOnly={relayOnly} />
      {pairedSelf && <span className="setup-paired" role="status"><Check aria-hidden="true" />{t("This browser is connected first.")}</span>}
      {/* a failed start's reason shows once, in its own line, when the relay says it did not start; any other failure (a retry's own pairing) shows here */}
      {error !== null && (step !== "not-started" || error !== status.error) && <p className="setup-error" role="alert">{error}</p>}
      {/* not while the relay starts: its start closes the gate, which would spend the other way's pairing code */}
      {onOther !== undefined && <button type="button" className="setup-link setup-phone-other" disabled={busy} onClick={onOther}>{t("Use Tailscale or Wi-Fi instead")}</button>}
    </div>
  );
}

/** The relay's pairing code is single-use, so once a new device is listed the QR gives way to Paired and New code. */
function RelayQr({ onPhonePaired }: { onPhonePaired: (name: string) => void }) {
  const t = useT();
  const [paired, setPaired] = useState<string | null>(null);
  const [round, setRound] = useState(0);
  useEffect(() => {
    if (paired !== null) return;
    let live = true;
    let asked = false;
    let known: ReadonlySet<string> | null = null;
    const look = (): void => {
      if (asked) return;
      asked = true;
      void fetchDevices().then((devices) => {
        if (!live) return;
        if (known === null) { known = new Set(devices.map((device) => device.id)); return; }
        const fresh = devices.find((device) => !known!.has(device.id));
        if (fresh !== undefined) { setPaired(fresh.label); onPhonePaired(fresh.label); }
      }, () => { /* asked again on the next turn */ }).finally(() => { asked = false; });
    };
    look();
    const poll = window.setInterval(look, PAIRING_POLL_MS);
    return () => { live = false; window.clearInterval(poll); };
  }, [paired]); // eslint-disable-line react-hooks/exhaustive-deps
  if (paired !== null) return (
    <p className="setup-phone-relay-state">
      <span className="setup-paired" role="status"><Check aria-hidden="true" />{t("Paired: {name}.", { name: paired })}</span>{" "}
      <button type="button" className="setup-link" onClick={() => { setPaired(null); setRound((count) => count + 1); }}>{t("New code")}</button>
    </p>
  );
  return <RelayPairing key={round} />;
}

/**
 * A browser in only because nothing is paired yet pairs itself first, as Settings → Phone's Pair this
 * device now does, so the phone paired next does not shut it out.
 */
function PhoneQr({ auth, onOpenSettings, onPaired, onPhonePaired, given, large = false, shown = true }: { auth: HealthAuth | null; onOpenSettings: () => void; onPaired: () => void; onPhonePaired: (name: string) => void; given?: string; large?: boolean; shown?: boolean }) {
  const t = useT();
  const [access, setAccess] = useState<RemoteAccess | null | undefined>(undefined);
  useEffect(() => {
    let live = true;
    fetchRemoteAccess().then((answer) => { if (live) setAccess(answer); }, () => { if (live) setAccess(null); });
    return () => { live = false; };
  }, []);
  const plan = phonePlan({ protocol: window.location.protocol, hostname: window.location.hostname, origin: window.location.origin, secure: window.isSecureContext, shell: inRelayShell() }, access ?? null);
  const address = given ?? (access === undefined ? undefined : plan.kind === "here" || plan.kind === "served" ? plan.url : isLoopbackHost(window.location.hostname) ? null : window.location.origin);
  const mode = phoneBoxMode(address, pairedHere && auth?.via === "open" ? { ...auth, via: "device" } : auth);
  useEffect(() => { if (mode === "settings") onOpenSettings(); }, [mode]); // eslint-disable-line react-hooks/exhaustive-deps
  // a pairing code for the QR, asked for by the user each time (opening the box, New code): never
  // renewed behind their back, where it would replace a code Settings → Phone shows. Used by a phone
  // (a device paired since) or run out, it is gone.
  const [code, setCode] = useState<PairingCode | null>(null);
  const [paired, setPaired] = useState<string | null>(null);
  const [asking, setAsking] = useState(0);
  // a code request out: New code waits for it (a second one could replace the code the first shows)
  const [requesting, setRequesting] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [agreed, setAgreed] = useState(false);
  // hidden behind another way's tab: the PC keeps one pairing code at a time, and that way (or Settings) may replace
  // this one, so its code goes, and its device check with it; back in view, New code asks for one on a press
  // a phone that paired while it was hidden is said once it is shown again (one read of the devices)
  const dropped = useRef(false);
  const shownNow = useRef(shown);
  shownNow.current = shown;
  useEffect(() => {
    if (!shown) { if (code !== null) dropped.current = true; setCode(null); return; }
    if (!dropped.current) return;
    dropped.current = false;
    let live = true;
    fetchDevices().then((devices) => {
      const fresh = devices.find((device) => !(before.current?.has(device.id) ?? true));
      if (live && fresh !== undefined) { setPaired(fresh.label); onPhonePaired(fresh.label); }
    }, () => { /* unknown: New code stays offered */ });
    return () => { live = false; };
  }, [shown]); // eslint-disable-line react-hooks/exhaustive-deps
  const ready = mode === "qr" || (mode === "pair-self" && (!large || pairedHere || agreed));
  const before = useRef<ReadonlySet<string> | null>(null);
  useEffect(() => {
    if (!ready) return;
    let live = true;
    setRequesting(true);
    setFailure(null);
    // read before the code and right after it: a device that paired in between used an older code
    // (one Settings showed); one missed this way only goes unconfirmed, never claimed wrongly
    void (async () => {
      if (mode === "pair-self" && !pairedHere) {
        await pairThisBrowser();
        pairedHere = true;
        onPaired();
      }
      const first = await fetchDevices();
      if (!live) return;
      const fresh = await guidePairingCode();
      const after = await fetchDevices();
      // hidden meanwhile: another way may take a newer code, so this answer is not shown later (#3970)
      if (!live || !shownNow.current) return;
      before.current = new Set([...first, ...after].map((device) => device.id));
      setCode(fresh);
    })().catch((error: unknown) => { if (live) { setCode(null); setFailure(error instanceof UnconfirmedPairing ? t("Couldn't connect this browser. Turn on cookies.") : userFailure(error).kind === "unknown" ? t("Couldn't make a code. Try again.") : userErrorMessage(error).message); } }).finally(() => { if (live) setRequesting(false); });
    return () => { live = false; };
  }, [ready, asking]);
  useEffect(() => {
    if (code === null) return;
    let live = true;
    let asked = false;
    const expiry = window.setTimeout(() => { if (live) setCode(null); }, Math.max(0, Date.parse(code.expires_at) - Date.now()));
    const look = (): void => {
      if (asked) return;
      asked = true;
      void fetchDevices().then((devices) => {
        if (!live) return;
        const fresh = devices.find((device) => !(before.current?.has(device.id) ?? true));
        if (fresh !== undefined) { setPaired(fresh.label); setCode(null); onPhonePaired(fresh.label); }
      }, () => { /* asked again on the next turn */ }).finally(() => { asked = false; });
    };
    look();
    const poll = window.setInterval(look, PAIRING_POLL_MS);
    return () => { live = false; window.clearTimeout(expiry); window.clearInterval(poll); };
  }, [code]); // eslint-disable-line react-hooks/exhaustive-deps
  if (large && mode === "pair-self" && !pairedHere && !agreed) return (
    <div className="setup-method-step">
      <p className="setup-text">{t("New browsers will then need a code.")}</p>
      <div><button type="button" className="btn" onClick={() => setAgreed(true)}>{t("Show QR code")}</button></div>
    </div>
  );
  if (!ready || typeof address !== "string") return <p className="setup-muted"><LoaderCircle aria-hidden="true" className="setup-spin" /></p>;
  const value = code === null ? address : `${address.replace(/\/$/, "")}/?pair=${code.code}`;
  if (large) return (
    <QrPanel value={value} label={code === null ? t("Open this address on your phone") : t("QR code that pairs a phone with code {code}", { code: code.code })} address={address}>
      {paired !== null && <span className="setup-paired" role="status"><Check aria-hidden="true" />{t("Paired: {name}.", { name: paired })}</span>}
      {pairedHere && <span className="setup-paired" role="status"><Check aria-hidden="true" />{t("This browser is connected first.")}</span>}
      {failure !== null && <span className="setup-error" role="alert">{failure}</span>}
      {code === null && <button type="button" className="btn" aria-disabled={requesting || undefined} onClick={() => { if (requesting) return; setPaired(null); setAsking((count) => count + 1); }}><RefreshCw aria-hidden="true" />{failure !== null ? t("Try again") : t("New code")}</button>}
    </QrPanel>
  );
  return (
    <div className="setup-phone-qr">
      <QrCode value={value} label={code === null ? t("Open this address on your phone") : t("QR code that pairs a phone with code {code}", { code: code.code })} size={136} />
      <div className="setup-phone-qr-text">
        {paired !== null && <span className="setup-paired" role="status"><Check aria-hidden="true" />{t("Paired: {name}.", { name: paired })}</span>}
        {pairedHere && <span className="setup-paired" role="status"><Check aria-hidden="true" />{t("This browser is connected first.")}</span>}
        {failure !== null && <span className="setup-error" role="alert">{failure}</span>}
        <span>{t("Open this address on your phone")}</span>
        <code>{address}</code>
        {code !== null ? <span>{t("Pairing code")} <strong>{code.code}</strong></span>
          : <button type="button" className="setup-link" aria-disabled={requesting || undefined} onClick={() => { if (requesting) return; setPaired(null); setAsking((count) => count + 1); }}>{t("New code")}</button>}
      </div>
    </div>
  );
}

export function SetupGuideResume({ onResume }: { onResume: () => void }) {
  const t = useT();
  return (
    <p className="setup-resume" role="status">
      <span>{t("Setup isn't finished.")}</span>
      <button type="button" className="btn btn-ghost" onClick={onResume}>{t("Back to setup")}</button>
    </p>
  );
}


const STORES = {
  "app-store": { url: "https://apps.apple.com/app/id6824664162", badge: `${import.meta.env.BASE_URL}store-badges/app-store-en.svg`, width: 120, height: 40 },
  "google-play": { url: "https://play.google.com/store/apps/details?id=sh.ovis.app", badge: "google-play", width: 135, height: 52 },
} as const;
type Store = keyof typeof STORES;
type PhoneMethod = "relay" | "wifi" | "tailscale";

function badgeSrc(store: Store, language: string): string {
  if (store === "app-store") return STORES["app-store"].badge;
  const lang = language.startsWith("ko") ? "ko" : language.startsWith("ja") ? "ja" : language.startsWith("zh") ? "zh-cn" : "en";
  return `${import.meta.env.BASE_URL}store-badges/google-play-${lang}.png`;
}

/**
 * Deliberately narrow: an IPv6 link-local address needs a zone a phone's browser cannot type, and a bare machine
 * name may not resolve on a phone; those pages keep the line that sends the user to another way.
 */
function wifiAddress(): string | null {
  const host = window.location.hostname;
  const lan = /^10\./.test(host) || /^192\.168\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host) || host.endsWith(".local");
  return lan ? window.location.origin : null;
}

function QrPanel({ value, label, address, scanLine, children }: { value: string; label: string; address: string; scanLine?: string; children?: ReactNode }) {
  const t = useT();
  const [copied, setCopied] = useState<boolean | null>(null);
  return (
    <div className="setup-qr-panel">
      <QrCode value={value} label={label} size={168} />
      <div className="setup-qr-panel-text">
        <p className="setup-qr-scan">{scanLine ?? t("Scan with your phone's camera.")}</p>
        <div className="setup-qr-address">
          <code>{address}</code>
          <button type="button" className="icon-button" aria-label={t("Copy address")} title={t("Copy address")} onClick={() => void copyText(address).then(setCopied)}><Copy aria-hidden="true" /></button>
        </div>
        {children}
        <span className="setup-muted" role="status">{copied === true ? t("Copied") : null}</span>
      </div>
    </div>
  );
}

function TightRelayQr({ onPhonePaired }: { onPhonePaired: (name: string) => void }) {
  const t = useT();
  const [more, setMore] = useState(false);
  return (
    <div className={more ? "setup-relay-tight is-more" : "setup-relay-tight"}>
      <RelayQr onPhonePaired={onPhonePaired} />
      <button type="button" className="setup-link setup-relay-more" aria-expanded={more} onClick={() => setMore(!more)}>{more ? t("Back to QR") : t("Other ways")}</button>
    </div>
  );
}

function StoreQr({ store }: { store: Store }) {
  const t = useT();
  const { url } = STORES[store];
  const name = store === "app-store" ? "App Store" : "Google Play";
  return (
    <QrPanel value={url} label={t("QR code that opens {store}", { store: name })} address={url} scanLine={t("Scan to open {store}.", { store: name })}>
      <ExternalLink kind="link" className="setup-link" href={url}>{t("Open {store}", { store: name })} <ExternalLinkIcon aria-hidden="true" /></ExternalLink>
    </QrPanel>
  );
}

function StoreBadges({ shown, onShow }: { shown: Store | null; onShow: (store: Store) => void }) {
  const t = useT();
  const { settings } = useSettings();
  const language = settings.language === "system" ? navigator.language : settings.language;
  return (
    <div className="setup-stores">
      {(["app-store", "google-play"] as const).map((store) => (
        <button key={store} type="button" className="setup-store" aria-pressed={shown === store} onClick={() => onShow(store)}>
          <img src={badgeSrc(store, language)} alt={store === "app-store" ? t("Download on the App Store") : t("Get it on Google Play")} width={STORES[store].width} height={STORES[store].height} />
        </button>
      ))}
    </div>
  );
}

interface MethodProps {
  auth: HealthAuth | null;
  security: SecurityFacts;
  onOpenSettings: () => void;
  onPaired: () => void;
  onPhonePaired: (name: string) => void;
  opensAll: boolean;
}

function MethodPanel({ method, shown = true, ...props }: MethodProps & { method: PhoneMethod; shown?: boolean }) {
  const t = useT();
  const relay = useRelay();
  // each return into view after another way was shown: the PC keeps one pairing code, which that way may have
  // replaced, so the relay's box is drawn afresh and asks for an offer carrying the PC's current code
  const [returns, setReturns] = useState(0);
  const wasShown = useRef(shown);
  useEffect(() => {
    if (shown && !wasShown.current) setReturns((count) => count + 1);
    wasShown.current = shown;
  }, [shown]);
  if (method === "relay") {
    if (phoneWay(relay, inRelayShell(), props.auth) === "other") return <p className="setup-note"><Info aria-hidden="true" />{t("Not available on this PC.")}</p>;
    if (relay.status === null) return <p className="setup-muted"><LoaderCircle aria-hidden="true" className="setup-spin" /></p>;
    const closesGate = props.security.state === "known" && props.security.summary.pairing_gate === "open" && !props.security.summary.token_configured;
    return <RelayBox key={returns} tight relay={relay} auth={props.auth} closesGate={closesGate} opensAll={props.opensAll} relayOnly={props.security.state === "known" && relayOnlyPc(props.security.summary)} onPaired={props.onPaired} onPhonePaired={props.onPhonePaired} />;
  }
  if (method === "wifi") {
    const address = wifiAddress();
    if (address === null) return <p className="setup-note"><Info aria-hidden="true" />{t("No Wi-Fi address to show here. Use Anywhere instead.")}</p>;
    return <PhoneQr given={address} large shown={shown} auth={props.auth} onOpenSettings={props.onOpenSettings} onPaired={props.onPaired} onPhonePaired={props.onPhonePaired} />;
  }
  return <TailscaleMethod shown={shown} {...props} />;
}

function TailscaleMethod(props: MethodProps & { shown?: boolean }) {
  const t = useT();
  const [access, setAccess] = useState<RemoteAccess | null | undefined>(undefined);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    let live = true;
    fetchRemoteAccess().then((answer) => { if (live) setAccess(answer); }, () => { if (live) setAccess(null); });
    return () => { live = false; };
  }, []);
  if (access === undefined) return <p className="setup-muted"><LoaderCircle aria-hidden="true" className="setup-spin" /></p>;
  // Tailscale's own address, never the page's: `shell: true` skips phonePlan's "this page itself" answer (an HTTPS page,
  // the relay app), which Settings → Phone gives and this tab must not
  const plan = phonePlan({ protocol: window.location.protocol, hostname: window.location.hostname, origin: window.location.origin, secure: window.isSecureContext, shell: true }, access);
  if (plan.kind === "here" || plan.kind === "served") return <PhoneQr given={plan.url} large shown={props.shown ?? true} auth={props.auth} onOpenSettings={props.onOpenSettings} onPaired={props.onPaired} onPhonePaired={props.onPhonePaired} />;
  if (plan.kind === "command") return (
    <div className="setup-method-step">
      <p className="setup-text">{t("Run this once on this PC.")}</p>
      <div className="setup-qr-address">
        <code>{plan.command}</code>
        <button type="button" className="icon-button" aria-label={t("Copy")} title={t("Copy")} onClick={() => void copyText(plan.command).then(setCopied)}><Copy aria-hidden="true" /></button>
      </div>
      <span className="setup-muted" role="status">{copied ? t("Copied") : null}</span>
    </div>
  );
  return <p className="setup-note"><Info aria-hidden="true" />{plan.kind === "stopped" ? t("Tailscale isn't running.") : plan.kind === "missing" ? t("Tailscale isn't installed.") : t("Couldn't check for Tailscale.")}</p>;
}

function methodFacts(t: Translate): { id: PhoneMethod; icon: ReactNode; name: string; when: string; recommended?: true }[] {
  return [
    { id: "relay", icon: <Globe aria-hidden="true" />, name: t("Anywhere"), when: t("Works away from home too."), recommended: true },
    { id: "wifi", icon: <Wifi aria-hidden="true" />, name: t("Same Wi-Fi"), when: t("At home or at work.") },
    { id: "tailscale", icon: <Network aria-hidden="true" />, name: "Tailscale", when: t("If you use Tailscale.") },
  ];
}

function useShownInView(area: React.RefObject<HTMLElement | null>, shown: unknown): void {
  const narrow = useMediaQuery("(max-width: 640px)");
  const first = useRef(true);
  useEffect(() => {
    if (first.current) { first.current = false; return; }
    const panel = area.current;
    if (shown === null || !narrow || panel === null) return;
    const step = panel.closest("li") ?? panel;
    const align = (): void => step.scrollIntoView({ block: "start" });
    align();
    const grows = new ResizeObserver(align);
    grows.observe(panel);
    const sheet = panel.closest(".setup-body");
    const stop = (): void => grows.disconnect();
    for (const kind of ["touchstart", "wheel", "pointerdown", "keydown"] as const) sheet?.addEventListener(kind, stop, { once: true, passive: true });
    return () => { grows.disconnect(); for (const kind of ["touchstart", "wheel", "pointerdown", "keydown"] as const) sheet?.removeEventListener(kind, stop); };
  }, [shown]); // eslint-disable-line react-hooks/exhaustive-deps
}

function PhonePanel(props: MethodProps) {
  const t = useT();
  const [method, setMethod] = useState<PhoneMethod>("relay");
  const [store, setStore] = useState<Store | null>(null);
  const facts = methodFacts(t);
  const tabs = useRef<(HTMLButtonElement | null)[]>([]);
  const area = useRef<HTMLDivElement>(null);
  useShownInView(area, store ?? method);
  const [opened, setOpened] = useState<readonly PhoneMethod[]>([method]);
  useEffect(() => { setOpened((list) => list.includes(method) ? list : [...list, method]); }, [method]);
  // while the relay starts, no other way is picked (#3962 CodeRabbit): its start could close the gate and spend that way's code
  const relayBusy = useRelayStarting();
  const pick = (next: PhoneMethod): void => { if (relayBusy && next !== method) return; setStore(null); setMethod(next); };
  const onKey = (event: ReactKeyboardEvent, index: number): void => {
    const next = event.key === "ArrowRight" ? (index + 1) % facts.length : event.key === "ArrowLeft" ? (index + facts.length - 1) % facts.length : null;
    if (next === null || relayBusy) return;
    event.preventDefault();
    pick(facts[next]!.id);
    tabs.current[next]?.focus();
  };
  return (
    <ol className="setup-path">
      <li className="setup-path-row">
        <span className="setup-path-head"><span className="setup-path-num" aria-hidden="true">1</span>{t("Get the app")}<span className="setup-muted setup-path-optional">{t("Optional")}</span></span>
        <StoreBadges shown={store} onShow={setStore} />
      </li>
      <li>
        <span className="setup-path-head" id="setup-path-ways"><span className="setup-path-num" aria-hidden="true">2</span>{t("Pick how to connect")}</span>
        <div className="setup-path-tabs" role="tablist" aria-labelledby="setup-path-ways">
          {facts.map((fact, index) => (
            <button key={fact.id} ref={(node) => { tabs.current[index] = node; }} type="button" role="tab" aria-disabled={relayBusy && fact.id !== method ? true : undefined} id={`setup-path-tab-${fact.id}`} aria-selected={store === null && method === fact.id} aria-controls="setup-path-panel" tabIndex={method === fact.id ? 0 : -1} className="setup-path-tab" onClick={() => pick(fact.id)} onKeyDown={(event) => onKey(event, index)}>
              {fact.icon}<span>{fact.name}</span>{fact.recommended && <span className="setup-badge">{t("Recommended")}</span>}
            </button>
          ))}
        </div>
        {store === null && <p className="setup-muted setup-path-hint">{facts.find((fact) => fact.id === method)!.when}</p>}
      </li>
      <li>
        <span className="setup-path-head"><span className="setup-path-num" aria-hidden="true">3</span>{t("Scan with your phone")}</span>
        <div id="setup-path-panel" role="tabpanel" aria-labelledby={`setup-path-tab-${method}`} className="setup-method-area" ref={area}>
          {store !== null && <StoreQr store={store} />}
          {/* a way once opened stays mounted while hidden: going back to it asks for no new code (one only on New code) */}
          {opened.map((way) => <div key={way} hidden={store !== null || way !== method}><MethodPanel method={way} shown={way === method} {...props} /></div>)}
        </div>
      </li>
    </ol>
  );
}

function AlertsPicture({ alerts, phoneName }: { alerts: AlertsAnswer; phoneName: string | null }) {
  const t = useT();
  return (
    <>
      <div className="setup-alert-sample" role="img" aria-label={t("A sample alert: Claude Code needs your input")}>
        <OvisMark width={28} height={28} />
        <span className="setup-alert-sample-text">
          <span className="setup-alert-sample-title">Claude Code · api-server</span>
          <span>{t("Needs your input")}</span>
        </span>
        <span className="setup-alert-sample-time">{t("now")}</span>
      </div>
      <ul className="setup-alert-where">
        <li><span className="setup-label">{t("This computer")}</span>{alerts === "on" ? t("Alerts are on.") : alerts === "checking" ? t("Checking…") : alerts === "unavailable" ? t("This address can't get alerts.") : t("Alerts are off.")}</li>
        <li><span className="setup-label">{t("Phone")}</span>{phoneName === null ? t("Alerts reach it once connected.") : t("Alerts reach {name} when it allows them.", { name: phoneName })}</li>
      </ul>
    </>
  );
}
