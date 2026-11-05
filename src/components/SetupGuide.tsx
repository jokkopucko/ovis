/**
 * The first-run setup guide (lib/setupGuideFlow.ts): a welcome, then one screen. It checks the PC
 * for coding agents, then shows every one as a tile whatever it found: an installed one is picked by
 * a tap, a missing one has its Install (the user's tap is the consent: the official installer runs in
 * a terminal tab while a ring turns on the tile), and Start opens the first workspace with the one
 * picked; the agent asks for its own sign-in when it first starts. Plan usage is turned on for
 * accounts already signed in; Connect your phone beside Start leads with the Ovis relay where it can
 * (lib/setupGuideFlow.ts phoneWay): a tap turns it on, then its pairing QR code shows right there, and
 * a browser in only because nothing is paired yet pairs itself first, as turning the relay on closes
 * the device gate. Use Tailscale or Wi-Fi instead, or a page where the relay cannot lead, shows the
 * page's own QR code and address (that browser pairs itself first too, as Settings → Phone's Pair this
 * device now does; Settings → Phone where the page has no phone-reachable address). It adds no server
 * route. Its layout follows the Claude and Codex apps' first runs: one screen in the main
 * area, the app's sidebar left in place.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { ArrowRight, Check, ChevronRight, Gauge, Info, KeyRound, LoaderCircle, Play, RotateCw, Smartphone, Sparkles } from "lucide-react";

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
import { useSettings } from "../lib/settings.ts";
import { agentRows, checkList, foundAgents, installedHere, phoneBoxMode, phoneBoxOpensFirst, phoneBoxStays, phoneWay, openInFolder, preferredAgent, relayStep, settleDelay, setupView, signedInAgents, turnsUsageOn, type CheckStatus, type GuideEvent, type GuideState, type PcCheck, type PhoneBoxOpening } from "../lib/setupGuideFlow.ts";
import { inRelayShell, useRelay, type RelayState } from "../lib/useRelay.ts";
import { useSignedInUsage } from "../lib/useSetupGuide.ts";
import { userErrorMessage } from "../lib/userError.ts";
import { AgentMark } from "./AgentMark.tsx";
import { AgentTile } from "./AgentTile.tsx";
import { UsageSignInDialog } from "./UsageSignInDialog.tsx";
import { QrCode } from "./QrCode.tsx";
import { failureText, RelayPairing, statusText } from "./RelayPanel.tsx";
import "./SetupGuide.css";

/** the catalog's agents, named in the check's lines before the PC answers */
type KnownAgent = Pick<AgentCatalogEntry, "id" | "name" | "kind">;
/** where Start opens the first workspace when this browser has no recent folder: the server's home */
const HOME = "~";

export interface SetupGuideProps {
  state: GuideState;
  /** stepped aside for a pane the user went to: kept mounted, so what runs goes on */
  hidden?: boolean;
  dispatch: (event: GuideEvent) => void;
  /** I've used Ovis before, Skip setup, or the first workspace opened */
  onClose: () => void;
  /** shows the tab an install or sign-in runs in */
  onOpenTerminal: (paneId: string) => void;
  /** Connect your phone where the guide cannot show its QR code: the Settings page that pairs it */
  onOpenSettings: (page: "devices") => void;
  /** how this browser got in: one in only because nothing is paired yet pairs itself first (Connect your phone) */
  auth: HealthAuth | null;
  /** the server's access facts: whether turning the relay on closes the open device gate (Connect your phone) */
  security: SecurityFacts;
  /** this browser paired itself (Connect your phone): the app reads its access again */
  onPaired: () => void;
  /** Start pressed: a tab the guide asked to show before it is not shown over what Start opens */
  onStarting?: () => void;
  /** the first workspace opened: its pane, and whether the agent started in it */
  onOpened: (paneId: string, agentStarted: boolean) => void;
}

export function SetupGuide(props: SetupGuideProps) {
  const { state, onClose, hidden = false } = props;
  const t = useT();
  const machineId = useMachineId();
  // the PC check: GET /api/agent-catalog for the PC being set up, run once the guide is begun and on Look again
  const [catalog, setCatalog] = useState<AgentCatalogRow[] | null>(null);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [known, setKnown] = useState<readonly KnownAgent[]>([]);
  // the agents installed from the tiles: installed, before the PC is read again
  const [ready, setReady] = useState<readonly string[]>([]);
  // Connect your phone's box closed once (a tap, or withdrawn): the agents screen made anew (Look again) leaves it closed
  const [phoneClosed, setPhoneClosed] = useState(false);
  // said to a screen reader once the screen settles; its heading changes without focus
  const [announced, setAnnounced] = useState("");
  const asked = useRef(0);
  const settle = useRef<number | undefined>(undefined);
  const loadCatalog = (): void => {
    const ask = ++asked.current;
    const startedAt = Date.now();
    window.clearTimeout(settle.current);
    setCatalog(null);
    setCatalogError(null);
    // a check asked for again is the truth: an agent installed here earlier counts only if it still answers
    setReady([]);
    setAnnounced("");
    setChecking(true);
    // the catalog's names, kept out of the app's main bundle; without them the lines come with the answer
    import("../../shared/agent-catalog.ts").then((module) => setKnown(module.AGENT_CATALOG), () => {});
    fetchAgentCatalog(machineId).then((answer) => {
      if (ask !== asked.current) return;
      setCatalog(answer.agents);
      settle.current = window.setTimeout(() => {
        if (ask !== asked.current) return;
        setChecking(false);
        setAnnounced(foundAgents(answer.agents).length > 0 ? t("You're set up") : t("Pick an AI coding helper"));
      }, settleDelay(startedAt, Date.now()));
    }, (error: unknown) => {
      if (ask !== asked.current) return;
      setCatalogError(userErrorMessage(error).message);
      setChecking(false);
    });
  };
  // an agent installed from its tile: installed from now on, the PC read again for its version, and said
  const agentInstalled = (agent: string): void => {
    if (ready.includes(agent)) return;
    setReady((list) => list.includes(agent) ? list : [...list, agent]);
    setAnnounced(t("{agent} is ready", { agent: catalog?.find((row) => row.id === agent)?.name ?? agent }));
    const ask = ++asked.current;
    fetchAgentCatalog(machineId).then((answer) => { if (ask === asked.current) setCatalog(answer.agents); }, () => { /* Start works without the version */ });
  };
  const begun = state.step !== "welcome";
  useEffect(() => {
    if (begun) loadCatalog();
    return () => { asked.current += 1; window.clearTimeout(settle.current); };
  }, [begun, machineId]); // eslint-disable-line react-hooks/exhaustive-deps
  const check: PcCheck = { checking, catalog, failed: catalogError !== null };
  const view = setupView(check);

  useEffect(() => {
    if (begun && !hidden) document.getElementById("setup-step-title")?.focus({ preventScroll: true });
  }, [begun, hidden]);
  const viewBefore = useRef(view);
  useEffect(() => {
    if (viewBefore.current === view) return;
    viewBefore.current = view;
    // the control that had focus went with the view it was in: the new view's heading takes it
    if (!hidden && (document.activeElement === null || document.activeElement === document.body)) document.getElementById("setup-step-title")?.focus({ preventScroll: true });
  }, [view, hidden]);

  if (state.step === "welcome") return <Welcome dispatch={props.dispatch} onClose={onClose} hidden={hidden} />;
  return (
    <div className="setup-guide" role="region" aria-label={t("Setup guide")} hidden={hidden}>
      <div className="setup-guide-inner">
        <div className="setup-head">
          <span>{t("Set up Ovis")}</span>
          <button type="button" className="setup-link" onClick={onClose}>{t("Skip setup")}</button>
        </div>
        <p className="visually-hidden" role="status">{announced}</p>
        {view === "checking" && <Checking known={known} catalog={catalog} />}
        {view === "agents" && catalog !== null && <AgentsScreen catalog={catalog} ready={ready} machineId={machineId} onInstalled={agentInstalled} onLookAgain={loadCatalog} onOpenTerminal={props.onOpenTerminal} onOpened={props.onOpened} onOpenSettings={props.onOpenSettings} auth={props.auth} security={props.security} onStarting={props.onStarting} onPaired={props.onPaired} usageOn={turnsUsageOn(props.state)} phoneFirst={!phoneClosed && phoneBoxOpensFirst(props.state, isLoopbackHost(window.location.hostname))} onPhoneClosed={() => setPhoneClosed(true)} />}
        {view === "failed" && <CheckFailed error={catalogError} onLookAgain={loadCatalog} />}
      </div>
    </div>
  );
}

function Welcome({ dispatch, onClose, hidden }: Pick<SetupGuideProps, "dispatch" | "onClose" | "hidden">) {
  const t = useT();
  return (
    <div className="setup-guide" role="region" aria-label={t("Setup guide")} hidden={hidden}>
      <div className="setup-guide-inner setup-welcome">
        <img src="/icons/icon-192.png?v=sheep1" alt="" width="72" height="72" className="setup-welcome-mark" />
        <h2>{t("Welcome to Ovis")}</h2>
        <p className="setup-lead">{t("Is this your first time using Ovis?")}</p>
        <div className="setup-choices">
          <button type="button" className="setup-choice" onClick={() => dispatch({ type: "begin" })}>
            <span className="setup-choice-icon"><Sparkles aria-hidden="true" /></span>
            <span className="setup-choice-text"><strong>{t("I'm new to Ovis")}</strong><span>{t("Ovis finds or installs an AI coding helper and opens your first project.")}</span></span>
            <ChevronRight aria-hidden="true" />
          </button>
          <button type="button" className="setup-choice" onClick={onClose}>
            <span className="setup-choice-icon"><ArrowRight aria-hidden="true" /></span>
            <span className="setup-choice-text"><strong>{t("I've used Ovis before")}</strong><span>{t("Skip the setup and go straight in")}</span></span>
            <ChevronRight aria-hidden="true" />
          </button>
        </div>
        <p className="setup-note"><Info aria-hidden="true" />{t("You can open this again any time from Settings → Agents.")}</p>
      </div>
    </div>
  );
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
    <section className="setup-step" aria-labelledby="setup-step-title">
      <h2 id="setup-step-title" tabIndex={-1}>{t("Checking this PC…")}</h2>
      <p className="setup-lead">{t("Looking for AI coding helpers that are already installed.")}</p>
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
    </section>
  );
}

function CheckFailed({ error, onLookAgain }: { error: string | null; onLookAgain: () => void }) {
  const t = useT();
  return (
    <section className="setup-step" aria-labelledby="setup-step-title">
      <h2 id="setup-step-title" tabIndex={-1}>{t("Couldn't check this PC")}</h2>
      {error !== null && <p className="setup-error" role="alert">{error}</p>}
      <div className="setup-actions">
        <button type="button" className="btn btn-primary" onClick={onLookAgain}><RotateCw aria-hidden="true" />{t("Look again")}</button>
      </div>
    </section>
  );
}

interface AgentsScreenProps extends Pick<SetupGuideProps, "onOpenTerminal" | "onOpened" | "onOpenSettings" | "auth" | "security" | "onStarting" | "onPaired"> {
  /** a first run turns plan usage on for a signed-in account; a reopened guide leaves the setting alone */
  usageOn: boolean;
  /** a first run on the PC itself: Connect your phone's box is open from the start (phoneBoxOpensFirst) */
  phoneFirst: boolean;
  /** the box closed: Look again does not open it by itself again */
  onPhoneClosed: () => void;
  catalog: readonly AgentCatalogRow[];
  ready: readonly string[];
  machineId: string;
  /** an agent installed from its tile: installed from now on, before the PC is read again */
  onInstalled: (agent: string) => void;
  onLookAgain: () => void;
}

function AgentsScreen({ catalog, ready, machineId, onInstalled, onLookAgain, onOpenTerminal, onOpened, onOpenSettings, auth, security, onStarting, onPaired, usageOn, phoneFirst, onPhoneClosed }: AgentsScreenProps) {
  const t = useT();
  const { settings, update } = useSettings();
  const agents = agentRows(catalog, ready);
  const installed = agents.filter((agent) => installedHere(agent, ready));
  const [picked, setPicked] = useState<string | null>(null);
  const chosen = installed.find((agent) => agent.id === picked) ?? preferredAgent(installed, ready.at(-1) ?? null);
  // the agents already signed in here: their plan usage is turned on as soon as they are seen, without a question
  const signedIn = useSignedInUsage(ready, (refresh) => fetchUsage(refresh).then((report) => signedInAgents(report.providers)), settings.showUsage || !usageOn, () => update({ showUsage: true }));
  // Claude Code and Codex, installed here and not signed in yet: signed in from the guide, in the browser
  // (UsageSignInDialog). Accounts are read on the server's PC, so only its own guide offers it, and a
  // watching device signs in to nothing
  // signed in from here: the usage read that would say so may not come again while the guide is open
  const [signedHere, setSignedHere] = useState<readonly string[]>([]);
  const unsigned = machineId === "local" && auth?.role !== "watch" ? installed.filter((agent) => (agent.id === "claude" || agent.id === "codex") && !signedIn.includes(agent.id) && !signedHere.includes(agent.id)) : [];
  const [signingIn, setSigningIn] = useState<{ provider: "claude" | "codex"; default: true } | null>(null);
  // the tiles whose install runs: Look again waits for them (a fresh read would end their watch);
  // Start does not: an install runs on in its tab whatever the guide does
  const [installing, setInstalling] = useState<readonly string[]>([]);
  const busy = installing.length > 0;
  const onRunning = useCallback((id: string, running: boolean): void => setInstalling((list) => running ? (list.includes(id) ? list : [...list, id]) : list.filter((one) => one !== id)), []);
  // why an install did not finish, per agent: one tile's news never clears another's
  const [installErrors, setInstallErrors] = useState<Readonly<Record<string, string>>>({});
  const onInstallError = useCallback((id: string, message: string | null): void => setInstallErrors((errors) => {
    if ((errors[id] ?? null) === message) return errors;
    const next = { ...errors };
    if (message === null) delete next[id]; else next[id] = message;
    return next;
  }), []);
  const installedFromTile = (id: string): void => { onInstalled(id); setPicked(id); };
  // the first workspace opens in the folder this browser used last, else the server's home
  const folder = recentDirectories.read("local")[0] ?? HOME;
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // the workspace made, when the agent did not start in it: opening it shows why, in its terminal
  const [madeWithout, setMadeWithout] = useState<string | null>(null);

  // a reply after the screen is gone (Skip setup, the guide closed in another tab) opens nothing
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const start = async (): Promise<void> => {
    if (madeWithout !== null) { onOpened(madeWithout, false); return; }
    if (opening || chosen === null) return;
    onStarting?.();
    setOpening(true);
    setError(null);
    const launch = newSessionLaunch({ agent: chosen.id, model: "", effort: "", prompt: "" }, settings);
    if ("fault" in launch) { setOpening(false); setError(t("{agent} can't start from here. Open a workspace from the sidebar instead.", { agent: chosen.name })); return; }
    try {
      const result = await openInFolder((directory) => createWorkspace(createRequest({ tab: null, directory, name: "" }, launch, null)), folder, HOME, (reason) => alive.current && reason instanceof ApiError && reason.code === "invalid_cwd");
      if (!alive.current) return;
      if (result.agent_started === false) {
        setOpening(false);
        setMadeWithout(result.pane_id);
        setError(t("The workspace opened, but {agent} did not start. Open it to see why in its terminal.", { agent: chosen.name }) + (result.error?.message ? ` (${result.error.message})` : ""));
        return;
      }
      onOpened(result.pane_id, true);
    } catch (reason: unknown) {
      if (!alive.current) return;
      setOpening(false);
      setError(userErrorMessage(reason).message);
    }
  };

  const locked = opening || madeWithout !== null;
  // Connect your phone: the relay's QR code, or the page's own and its address, right here
  // open from the start on a first run on the PC, where a phone is the next device to add
  const [phone, setPhoneState] = useState<PhoneBoxOpening | null>(phoneFirst ? "first-run" : null);
  const setPhone = (next: PhoneBoxOpening | null): void => { setPhoneState(next); if (next === null) onPhoneClosed(); };
  return (
    <section className="setup-step" aria-labelledby="setup-step-title">
      {installed.length > 0 ? (
        <div className="setup-done-head">
          <Check aria-hidden="true" />
          <div>
            <h2 id="setup-step-title" tabIndex={-1}>{t("You're set up")}</h2>
            <p className="setup-lead">{t("Ovis found these on this PC. Start opens your first project with the one picked.")}</p>
          </div>
        </div>
      ) : (
        <>
          <h2 id="setup-step-title" tabIndex={-1}>{t("Pick an AI coding helper")}</h2>
          <p className="setup-lead">{t("Nothing is installed until you tap Install.")}</p>
        </>
      )}
      <ul className="setup-found" aria-label={t("AI coding helpers")}>
        {agents.map((agent) => (
          <AgentTile key={agent.id} agent={agent} has={installedHere(agent, ready)} picked={chosen?.id === agent.id} locked={locked} machineId={machineId}
            onPick={setPicked} onOpenTerminal={onOpenTerminal} onRunning={onRunning} onInstalled={installedFromTile} onError={onInstallError} />
        ))}
      </ul>
      {Object.values(installErrors).map((message) => <p key={message} className="setup-error" role="alert">{message}</p>)}
      {unsigned.map((agent) => (
        <p key={agent.id} className="setup-note setup-sign-in"><KeyRound aria-hidden="true" />{t("{agent} is not signed in yet.", { agent: agent.name })}{" "}
          <button type="button" className="setup-link" disabled={locked} onClick={() => setSigningIn({ provider: agent.id as "claude" | "codex", default: true })}>{t("Sign in to {agent}", { agent: agent.name })}</button></p>
      ))}
      {signingIn && <UsageSignInDialog request={signingIn} onOpenTerminal={(paneId) => { setSigningIn(null); onOpenTerminal(paneId); }} onSignedIn={() => setSignedHere((done) => [...done, signingIn.provider])} onClose={() => setSigningIn(null)} />}
      {/* said only where usage shows: a reopened guide leaves a switched-off setting off */}
      {signedIn.length > 0 && (settings.showUsage || usageOn) && <p className="setup-note"><Gauge aria-hidden="true" />{t("Plan usage will show in the sidebar for your signed-in accounts.")}</p>}
      {error !== null && <p className="setup-error" role="alert">{error}</p>}
      <div className="setup-actions">
        <button type="button" className="btn btn-primary" disabled={opening || (chosen === null && madeWithout === null)} onClick={() => void start()}>
          <Play aria-hidden="true" />{madeWithout !== null ? t("Open the workspace") : chosen !== null ? t("Start with {agent}", { agent: chosen.name }) : t("Start")}
        </button>
        <button type="button" className="btn" disabled={opening} aria-expanded={phone !== null} onClick={() => setPhone(phone === null ? "tap" : null)}><Smartphone aria-hidden="true" />{t("Connect your phone")}</button>
      </div>
      {phone !== null && <PhoneBox opening={phone} auth={auth} security={security} onOpenSettings={() => { setPhone(null); onOpenSettings("devices"); }} onPaired={onPaired} onWithdraw={() => setPhone(null)} />}
      {!busy && !locked && (
        <p className="setup-muted setup-again">{t("Already installed one?")} <button type="button" className="setup-link" onClick={onLookAgain}>{t("Look again")}</button></p>
      )}
    </section>
  );
}

/** how often the guide looks for a phone that paired with the code it shows */
const PAIRING_POLL_MS = 3000;
// this browser paired itself from the guide on this page: a box opened again shows the QR (and says
// so) even before the app's access facts catch up
let pairedHere = false;

// the guide's code request, while it is out: a box closed and opened again joins it instead of
// sending a second one (each new code replaces the server's pending one)
let pairingOut: Promise<PairingCode> | null = null;
const guidePairingCode = (): Promise<PairingCode> => pairingOut ??= startPairing().finally(() => { pairingOut = null; });

interface PhoneBoxProps {
  /** a tap, or by itself on a first run on the PC (phoneBoxStays) */
  opening: PhoneBoxOpening;
  /** a box that came open by itself where the relay cannot lead: it closes again */
  onWithdraw: () => void;
  auth: HealthAuth | null;
  security: SecurityFacts;
  onOpenSettings: () => void;
  onPaired: () => void;
}

/**
 * Connect your phone: the Ovis relay first where it can lead here (phoneWay), with a quiet way to the
 * page's own QR code and address (PhoneQr), which is all the box shows where the relay cannot lead.
 * The relay is asked about only while the box is open.
 */
function PhoneBox({ opening, onWithdraw, auth, security, onOpenSettings, onPaired }: PhoneBoxProps) {
  const t = useT();
  const relay = useRelay();
  // Use Tailscale or Wi-Fi instead: the other ways, until the box is closed (a tap of its own)
  const [other, setOther] = useState(false);
  const way = other ? "other" : phoneWay(relay, inRelayShell(), auth);
  // the relay led in this box once (phoneBoxStays)
  const led = useRef(false);
  if (way === "relay") led.current = true;
  const stays = phoneBoxStays(other ? "tap" : opening, way, led.current);
  useEffect(() => { if (!stays) onWithdraw(); }, [stays]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!stays) return null;
  // the relay's first answer may never come (it keeps failing): the other ways stay one tap away meanwhile
  if (way === "wait") return (
    <div className="setup-phone-relay">
      <p className="setup-muted"><LoaderCircle aria-hidden="true" className="setup-spin" /></p>
      <button type="button" className="setup-link setup-phone-other" onClick={() => setOther(true)}>{t("Use Tailscale or Wi-Fi instead")}</button>
    </div>
  );
  if (way === "other") return <PhoneQr auth={auth} onOpenSettings={onOpenSettings} onPaired={onPaired} />;
  // as Settings → Phone works it out: the relay closes a gate still open with no token set (server/relay/service.ts)
  const closesGate = security.state === "known" && security.summary.pairing_gate === "open" && !security.summary.token_configured;
  return <RelayBox relay={relay} auth={auth} closesGate={closesGate} onPaired={onPaired} onOther={() => setOther(true)} />;
}

/**
 * The relay's part of Connect your phone: one line on what it does and the button that turns it on (the
 * user's tap is the consent), its state while it connects, a start that failed with Try again, and its
 * pairing QR code once it is online (RelayPairing, as Settings shows it). Turning it on closes a device
 * gate still open, which would shut out a browser in only because nothing is paired yet (auth via
 * "open": a LAN or tailnet address, never the PC's loopback), so that browser pairs itself first.
 */
function RelayBox({ relay, auth, closesGate, onPaired, onOther }: { relay: RelayState; auth: HealthAuth | null; closesGate: boolean; onPaired: () => void; onOther: () => void }) {
  const t = useT();
  const { status, pending, request } = relay;
  const [turning, setTurning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pairedSelf, setPairedSelf] = useState(false);
  if (status === null) return null;
  const step = relayStep(status);
  const busy = pending || turning;
  const start = async (): Promise<void> => {
    if (busy) return;
    setTurning(true);
    setError(null);
    try {
      if (auth?.via === "open" && !pairedHere) {
        await pairThisBrowser();
        pairedHere = true;
        setPairedSelf(true);
        onPaired();
      }
      await request("start");
    } catch (reason: unknown) {
      setError(reason instanceof UnconfirmedPairing ? t("Could not confirm this browser is paired. Check that cookies are enabled, then try again.") : failureText(reason));
    } finally { setTurning(false); }
  };
  return (
    <div className="setup-phone-relay">
      {step === "off" && (
        <>
          <p className="setup-phone-relay-lead">{t("Your phone's camera scans a QR code and reaches this PC from anywhere. End-to-end encrypted, nothing to install.")}</p>
          {closesGate && <p className="setup-muted">{t("Turning on the relay closes the device gate: a new browser then needs a pairing code or the access token.")}</p>}
          <div className="setup-actions">
            <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void start()}><Smartphone aria-hidden="true" />{t("Turn on the Ovis relay")}</button>
          </div>
        </>
      )}
      {step === "starting" && <p className="setup-muted setup-phone-relay-state" role="status">{status.phase === "connecting" && <LoaderCircle aria-hidden="true" className="setup-spin" />}{statusText(t, status)}</p>}
      {step === "not-started" && (
        <>
          <p className="setup-error" role="alert">{t("The relay did not start: {message}", { message: status.error ?? "" })}</p>
          <div className="setup-actions">
            <button type="button" className="btn" disabled={busy} onClick={() => void start()}><RotateCw aria-hidden="true" />{t("Try again")}</button>
          </div>
        </>
      )}
      {step === "online" && <RelayQr />}
      {pairedSelf && <span className="setup-paired" role="status"><Check aria-hidden="true" />{t("This browser is paired first: other browsers now need pairing too.")}</span>}
      {/* a failed start's reason shows once, in its own line, when the relay says it did not start; any other failure (a retry's own pairing) shows here */}
      {error !== null && (step !== "not-started" || error !== status.error) && <p className="setup-error" role="alert">{error}</p>}
      {/* not while the relay starts: its start closes the gate, which would spend the other way's pairing code */}
      <button type="button" className="setup-link setup-phone-other" disabled={busy} onClick={onOther}>{t("Use Tailscale or Wi-Fi instead")}</button>
    </div>
  );
}

/**
 * The relay's pairing QR code in the guide (RelayPairing, as Settings shows it), and the phone that
 * used it: its code is single-use, so once a new device is listed the QR gives way to Paired and New
 * code, as the address QR does (PhoneQr). Devices listed when it opened are the ones before it.
 */
function RelayQr() {
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
        if (fresh !== undefined) setPaired(fresh.label);
      }, () => { /* asked again on the next turn */ }).finally(() => { asked = false; });
    };
    look();
    const poll = window.setInterval(look, PAIRING_POLL_MS);
    return () => { live = false; window.clearInterval(poll); };
  }, [paired]);
  if (paired !== null) return (
    <p className="setup-phone-relay-state">
      <span className="setup-paired" role="status"><Check aria-hidden="true" />{t("Paired: {name}.", { name: paired })}</span>{" "}
      <button type="button" className="setup-link" onClick={() => { setPaired(null); setRound((count) => count + 1); }}>{t("New code")}</button>
    </p>
  );
  return <RelayPairing key={round} />;
}

/**
 * Connect your phone, right in the guide: a QR code that opens this app on the phone with a fresh
 * pairing code filled in, and the address beside it (phoneBoxMode). A browser in only because nothing
 * is paired yet pairs itself first, as Settings → Phone's Pair this device now does, so the phone
 * paired next does not shut it out. Settings → Phone takes over where this page has no address a
 * phone can open (the PC's own loopback) or the server does not say how this browser got in.
 */
function PhoneQr({ auth, onOpenSettings, onPaired }: { auth: HealthAuth | null; onOpenSettings: () => void; onPaired: () => void }) {
  const t = useT();
  const [access, setAccess] = useState<RemoteAccess | null | undefined>(undefined);
  useEffect(() => {
    let live = true;
    fetchRemoteAccess().then((answer) => { if (live) setAccess(answer); }, () => { if (live) setAccess(null); });
    return () => { live = false; };
  }, []);
  const plan = phonePlan({ protocol: window.location.protocol, hostname: window.location.hostname, origin: window.location.origin, secure: window.isSecureContext }, access ?? null);
  // where a phone can open this app now, as Settings → Phone works it out
  const address = access === undefined ? undefined : plan.kind === "here" || plan.kind === "served" ? plan.url : isLoopbackHost(window.location.hostname) ? null : window.location.origin;
  // the QR, this browser paired first, or Settings → Phone (phoneBoxMode); once paired here, the QR
  // even before the app reads its access again
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
  // this browser paired itself first (it was in only because nothing was paired yet)
  const ready = mode === "qr" || mode === "pair-self";
  // the devices paired before this code: a new id among them later is the phone that used it
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
      // closed or asked again meanwhile: no code requested for a box nobody sees
      if (!live) return;
      const fresh = await guidePairingCode();
      const after = await fetchDevices();
      if (!live) return;
      before.current = new Set([...first, ...after].map((device) => device.id));
      setCode(fresh);
    })().catch((error: unknown) => { if (live) { setCode(null); setFailure(error instanceof UnconfirmedPairing ? t("Could not confirm this browser is paired. Check that cookies are enabled, then try again.") : userErrorMessage(error).message); } }).finally(() => { if (live) setRequesting(false); });
    return () => { live = false; };
  }, [ready, asking]);
  useEffect(() => {
    if (code === null) return;
    let live = true;
    let asked = false;
    const expiry = window.setTimeout(() => { if (live) setCode(null); }, Math.max(0, Date.parse(code.expires_at) - Date.now()));
    // a phone that paired with it: said, and the code is spent (one read at a time)
    const look = (): void => {
      if (asked) return;
      asked = true;
      void fetchDevices().then((devices) => {
        if (!live) return;
        const fresh = devices.find((device) => !(before.current?.has(device.id) ?? true));
        if (fresh !== undefined) { setPaired(fresh.label); setCode(null); }
      }, () => { /* asked again on the next turn */ }).finally(() => { asked = false; });
    };
    look();
    const poll = window.setInterval(look, PAIRING_POLL_MS);
    return () => { live = false; window.clearTimeout(expiry); window.clearInterval(poll); };
  }, [code]);
  if (!ready || typeof address !== "string") return <p className="setup-muted"><LoaderCircle aria-hidden="true" className="setup-spin" /></p>;
  // the line under the address: the paired phone, this browser paired first, or what failed
  const value = code === null ? address : `${address.replace(/\/$/, "")}/?pair=${code.code}`;
  return (
    <div className="setup-phone-qr">
      <QrCode value={value} label={code === null ? t("Open this address on your phone") : t("QR code that pairs a phone with code {code}", { code: code.code })} size={136} />
      <div className="setup-phone-qr-text">
        {paired !== null && <span className="setup-paired" role="status"><Check aria-hidden="true" />{t("Paired: {name}.", { name: paired })}</span>}
        {pairedHere && <span className="setup-paired" role="status"><Check aria-hidden="true" />{t("This browser is paired first: other browsers now need pairing too.")}</span>}
        {failure !== null && <span className="setup-error" role="alert">{failure}</span>}
        <span>{t("Open this address on your phone")}</span>
        <code>{address}</code>
        {code !== null ? <span>{t("Pairing code")} <strong>{code.code}</strong></span>
          : <button type="button" className="setup-link" aria-disabled={requesting || undefined} onClick={() => { if (requesting) return; setPaired(null); setAsking((count) => count + 1); }}>{t("New code")}</button>}
      </div>
    </div>
  );
}

/** Over the pane while the guide stands aside for a tab the user opened from it. */
export function SetupGuideResume({ onResume }: { onResume: () => void }) {
  const t = useT();
  return (
    <p className="setup-resume" role="status">
      <span>{t("The setup guide is waiting for you.")}</span>
      <button type="button" className="btn btn-ghost" onClick={onResume}>{t("Back to setup")}</button>
    </p>
  );
}
