import { useEffect, useRef, useState } from "react";
import { Monitor, X } from "lucide-react";
import type { Machine, PcInstallJob, SetupAction, SetupJob, SetupPhase } from "../../shared/machines.ts";
import type { AddPcPreset } from "../lib/actions.ts";
import { answerMachineSetup, fetchHealth, fetchMachineSetup, fetchPcInstall, startMachineSetup, startPcInstall } from "../lib/api.ts";
import { apiFetch } from "../lib/api-request-id.ts";
import { pcAccountStatus } from "../lib/account/join.ts";
import { accountServiceHere } from "../lib/account/ownWindow.ts";
import { AccountService } from "../lib/account/service.ts";
import { addOverSsh, sshAddListed, type SshAddOutcome } from "../lib/account/sshAdd.ts";
import { indexedAccountStore, type AccountSession } from "../lib/account/store.ts";
import { hostKeyFingerprints } from "../lib/hostKey.ts";
import { sshOutputParts } from "../lib/sshOutput.ts";
import { useAnnouncedText } from "../lib/useAnnouncedText.ts";
import { usePhoneSheetBack } from "../lib/sheetHistory.ts";
import { machineErrorText, previewVersion, setupErrorLines, setupStepText } from "../lib/userError.ts";
import { describeProgress } from "../lib/bridgeProgress.ts";
import { OwnOvisAddress, ownOvisAction } from "./MachineSidebar.tsx";
import "./Machines.css";
import { useT } from "../lib/i18n.ts";
import { ExternalLink } from "../lib/externalLink.ts";
import { asksChoice, FoundHerdrChoices, HerdrSessionChoices, type HerdrChoice } from "./FoundHerdrChoices.tsx";
import { useSignInAgainHere } from "./AccountSection.tsx";
import { ProgressBar, StageProgress } from "./ProgressBar.tsx";

/** A setup's stage among the four it may pass (connect, check, install, start), for its bar; none once it ended. */
const SETUP_STAGES = 4;
const SETUP_STAGE: Partial<Record<SetupPhase, number>> = { connecting: 1, authentication: 1, checking: 2, approval: 3, installing: 3, starting: 4 };
/** An install over SSH's stage among its five (connect, check, put Ovis there, start it, connect to it) in its own words; null once it ended. */
const INSTALL_STAGES = 5;
function installStage(phase: PcInstallJob["phase"], t: ReturnType<typeof useT>): { stage: number; label: string } | null {
  switch (phase) {
    case "connecting": return { stage: 1, label: t("Connecting to that PC…") };
    case "checking": return { stage: 2, label: t("Checking that PC…") };
    case "stopping": return { stage: 3, label: t("Stopping that PC's Ovis…") };
    case "installing": return { stage: 3, label: t("Running the official installer…") };
    case "starting": return { stage: 4, label: t("Starting Ovis there…") };
    case "connecting_pc": return { stage: 5, label: t("Connecting to that PC's Ovis…") };
    default: return null;
  }
}

export function MachineDialog({ machine, preset, updateRemote = false, onClose, onConnected }: { machine?: Machine; preset?: AddPcPreset; updateRemote?: boolean; onClose(): void; onConnected(id: string): void }) {
  const t = useT();
  const dialog = useRef<HTMLDialogElement>(null);
  const destinationField = useRef<HTMLInputElement>(null);
  const [destination, setDestination] = useState(machine?.target?.destination ?? preset?.destination ?? "");
  const [name, setName] = useState(machine?.name ?? (preset?.name !== undefined && preset.name !== preset.destination ? preset.name : ""));
  const [port, setPort] = useState(String(machine?.target?.port ?? ""));
  const [key, setKey] = useState(machine?.target?.identity_file ?? "");
  const [session, setSession] = useState(machine?.target?.session ?? "");
  const [herdrSocket, setHerdrSocket] = useState(machine?.target?.herdr_socket ?? "");
  const [ownOvis, setOwnOvis] = useState(machine?.target?.own_ovis ?? "");
  const [startNewHerdr, setStartNewHerdr] = useState(machine?.target?.start_new_herdr === true);
  // Advanced settings' own choice: kept through edits of the address, unlike a choice answered for one address
  const [herdrInstead, setHerdrInstead] = useState(false);
  const [job, setJob] = useState<SetupJob | null>(null);
  const mounted = useRef(true);
  const jobRef = useRef(job); jobRef.current = job;
  // Back closes the dialog as its Escape does (the dialog's cancel), where the browser does not send it one
  const closeRef = useRef(onClose); closeRef.current = onClose;
  usePhoneSheetBack(() => { closeRef.current(); });
  const identityRef = useRef(""); identityRef.current = [destination.trim(), port, session].join("\0");
  // the password lives in its field alone (src/AGENTS.md): read once on submit, then cleared, never in state
  const secretField = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const finished = !!job && ["failed", "cancelled", "connected"].includes(job.phase);
  const secretAllowed = window.isSecureContext;
  const needsBridgeUpdate = job?.phase === "failed" && job.action_required === "update_bridge";
  const startupFailed = job?.phase === "starting" && job.action_required === "windows_start_failed";
  const waitingForLogin = job?.phase === "starting" && (job.action_required === "windows_login" || startupFailed);
  const choosing = job?.action_required === "choose_herdr" && asksChoice(job.error, job.found_herdr_sessions ?? [], job.found_ovis ?? []);
  const choiceAfterFailure = job?.action_required === "choose_herdr" && !choosing;
  const besideOvis = job?.action_required === "choose_herdr" && !!job.found_ovis?.length;
  const keepOpen = job?.windows_startup === true;
  const own = job?.remote_ovis ?? (job || !machine ? null : ownOvisAction(machine));
  const ownUpdate = own?.updatable === true;
  // Add another PC to this PC's account over SSH (docs/account.md, "Adding a PC over SSH"): offered for a new PC only, in
  // this PC's own window signed in to the account this PC is in; nobody else gets the option
  const [accountAdd, setAccountAdd] = useState<string | null>(null);
  const [vouch, setVouch] = useState(true);
  // `other-pc`: a connection made again for the add reached another PC than the one it was for, so nothing was added
  const [added, setAdded] = useState<SshAddOutcome | "adding" | "other-pc" | null>(null);
  const addedFor = useRef<string | null>(null);
  // the PC a connection made again for the add must reach: the one the first inspect read
  const addingPc = useRef<string | null>(null);
  // a sign-in the account service refused as too old: this page's own sign-in again, offered in place (`from`: the sign-in
  // stored when it was refused), then under way (`link`: the page to open where the browser would not open it itself)
  const signInAgain = useSignInAgainHere();
  const [again, setAgain] = useState<{ readonly step: "offered"; readonly from: AccountSession } | { readonly step: "signing-in"; readonly from: AccountSession; readonly link: string | null } | null>(null);
  const againRun = useRef<AbortController | null>(null);
  // an update asked with "Add it to my account": the server takes the add as its own setup, run once the update connects
  const addAfterUpdate = useRef<string | null>(null);
  const [install, setInstall] = useState<PcInstallJob | null>(null);
  const installing = install !== null && !["connected", "failed", "cancelled"].includes(install.phase);
  useEffect(() => {
    if (machine) return;
    let live = true;
    void (async () => {
      const [health, status] = await Promise.all([fetchHealth(), pcAccountStatus(apiFetch)]);
      // this PC's own page signs in with the PC's account service (the PC's own meta, or the desktop app's), never the hosted shell's
      const session = accountServiceHere() === null ? undefined : await new AccountService({ store: indexedAccountStore }).session();
      if (live && sshAddListed({ pcAddFromAccount: status.pcAddFromAccount, auth: health.auth, signedInAccount: session?.account ?? null, pcAccount: status.account })) setAccountAdd(status.account);
    })().catch(() => { /* not offered: the plain SSH add stays */ });
    return () => { live = false; };
  }, []);

  // closing cancels a job that still waits on this dialog (a question, an approval); an
  // approved install keeps going on the server and shows in the sidebar
  // React's autoFocus runs at mount, while the dialog is still closed; showModal() then moves focus
  // to the first focusable element (Close), so the field is focused again once the dialog is open
  useEffect(() => { mounted.current = true; dialog.current?.showModal(); destinationField.current?.focus(); return () => { mounted.current = false; againRun.current?.abort(); const current = jobRef.current; if (current && !["connected", "failed", "cancelled"].includes(current.phase) && (current.windows_startup || !["installing", "starting"].includes(current.phase))) void answerMachineSetup(current.id, { action: "cancel" }).catch(() => {}); }; }, []);
  const running = !!job && ["installing", "starting"].includes(job.phase);
  // the setup's stage stays the bar while a bundle travels, whose own steps are told under it; none while ssh asks for a password
  const stage = job && !choosing && !job.challenge ? SETUP_STAGE[job.phase] : undefined;
  const transfer = running ? describeProgress(job?.progress) : null;
  const installAt = install === null ? null : installStage(install.phase, t);
  useEffect(() => {
    if (!job || finished) return;
    let cancelled = false;
    let timer = 0;
    const poll = async () => {
      try {
        const next = await fetchMachineSetup(job.id);
        const sentFor = [next.target.destination.trim(), String(next.target.port ?? ""), next.target.session ?? ""].join("\0");
        if (!cancelled) { setJob(next.action_required === "choose_herdr" && sentFor !== identityRef.current ? { ...next, action_required: null, found_herdr_sessions: undefined } : next); setError(null); }
      }
      catch (e) { if (!cancelled) setError(e instanceof Error ? e.message : String(e)); }
      if (!cancelled) timer = window.setTimeout(poll, 750);
    };
    timer = window.setTimeout(poll, 750);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [job?.id, finished]);
  const clearSecret = () => { if (secretField.current) secretField.current.value = ""; };
  useEffect(clearSecret, [job?.challenge?.id]);
  const editIdentity = (field: "destination" | "port" | "session", value: string) => {
    setHerdrSocket(""); setStartNewHerdr(false); setOwnOvis("");
    // A result from the old address must not offer its choices for the edited address.
    setJob((current) => current?.action_required === "choose_herdr" ? { ...current, action_required: null, found_herdr_sessions: undefined } : current);
    if (field === "destination") setDestination(value);
    else if (field === "port") setPort(value);
    else setSession(value);
  };

  const begin = async (choice?: HerdrChoice, installedId?: string, samePc?: string) => {
    if (pending) return;
    addedFor.current = null; setAdded(null); addAfterUpdate.current = null; addingPc.current = samePc ?? null;
    againRun.current?.abort(); againRun.current = null; setAgain(null);
    const updating = needsBridgeUpdate || updateRemote;
    const asAccountAdd = accountAdd !== null && vouch && !updating;
    setError(null); setPending(true);
    if (choice && machine?.herdr_profile_id) choice = { ...choice, session: machine.target?.session };
    if (choice) { if ("session" in choice) setSession(choice.session ?? ""); setHerdrSocket(choice.herdr_socket ?? ""); setStartNewHerdr(choice.start_new_herdr === true); setOwnOvis(choice.own_ovis ?? ""); }
    const sentFor = [destination.trim(), port, choice && "session" in choice ? choice.session ?? "" : session].join("\0");
    try { const next = await startMachineSetup({ destination: destination.trim(), ...(name.trim() && !machine?.herdr_profile_id ? { name: name.trim() } : {}), ...(port ? { port: Number(port) } : {}), ...(key.trim() ? { identity_file: key.trim() } : {}), ...(session.trim() ? { session: session.trim() } : {}), ...(herdrSocket ? { herdr_socket: herdrSocket } : {}), ...(startNewHerdr || herdrInstead && !herdrSocket && !ownOvis ? { start_new_herdr: true } : {}), ...(ownOvis ? { own_ovis: ownOvis } : {}), ...choice, ...(machine ? { machine_id: machine.id } : installedId ? { machine_id: installedId } : preset?.machine_id ? { machine_id: preset.machine_id } : {}), ...(updating ? { update_remote: true } : {}), ...(asAccountAdd ? { account_add: true } : {}) });
      if (updating && accountAdd !== null && vouch) addAfterUpdate.current = next.id;
      // the address, port or session edited while it was in flight: that PC's sessions are never offered for this one
      if (mounted.current) setJob(next.action_required === "choose_herdr" && sentFor !== identityRef.current ? { ...next, action_required: null, found_herdr_sessions: undefined } : next);
      else if (!["connected", "failed", "cancelled"].includes(next.phase) && (next.windows_startup || !["installing", "starting"].includes(next.phase))) await answerMachineSetup(next.id, { action: "cancel" });
    }
    catch (e) { if (mounted.current) setError(e instanceof Error ? e.message : String(e)); }
    finally { if (mounted.current) setPending(false); }
  };
  /**
   * A connected account add: this window lists and admits that PC with its own sign-in (`signIn`: one just made again
   * here), then this PC hands it the account. A refusal of the sign-in itself offers this page's sign-in again; that SSH
   * connection gone by the time the fresh sign-in is made, the same PC is connected again and its add goes on by itself.
   */
  const addOn = (current: SetupJob, signIn?: AccountSession): void => {
    if (current.phase !== "connected" || !current.account_add || accountAdd === null) return;
    const id = current.id;
    const service = new AccountService({ store: indexedAccountStore });
    addedFor.current = id;
    setAdded("adding");
    void addOverSsh(service, { id, account_add: current.account_add }, { account: accountAdd, running: () => mounted.current && jobRef.current?.id === id, ...(signIn === undefined ? {} : { signIn }) })
      .catch((error: unknown): SshAddOutcome => {
        console.warn("Ovis: the add over SSH stopped", error instanceof Error ? error.name : error);
        return "refused";
      })
      .then(async (outcome) => {
        if (!mounted.current || addedFor.current !== id) return;
        if (outcome === "disconnected" && signIn !== undefined) { void begin(undefined, current.machine_id, current.account_add!.server_id); return; }
        const from = outcome === "sign-in-again" && signInAgain !== undefined ? await service.session().catch(() => undefined) : undefined;
        if (!mounted.current || addedFor.current !== id) return;
        setAdded(outcome);
        if (from?.account === accountAdd) setAgain({ step: "offered", from });
      });
  };
  useEffect(() => {
    if (!job || job.phase !== "connected" || !job.account_add || accountAdd === null || addedFor.current === job.id) return;
    // that address answers for another PC now: the add was for the one read first, and nothing is listed for this one
    if (addingPc.current !== null && job.account_add.server_id !== addingPc.current) { addedFor.current = job.id; setAdded("other-pc"); return; }
    addOn(job);
  }, [job?.id, job?.phase]);
  /**
   * Signs in again with this page's own sign-in (in the press itself, so no popup blocker takes its page), stored in the
   * refused one's place for the same account only; the add then goes on with exactly that sign-in. Cancel, a sign-in that
   * did not finish, or one not stored (another account's) leaves the offer.
   */
  const signInAndAdd = (from: AccountSession): void => {
    const current = jobRef.current;
    if (signInAgain === undefined || current === null) return;
    const controller = new AbortController();
    againRun.current = controller;
    const running = (): boolean => !controller.signal.aborted && mounted.current && jobRef.current?.id === current.id;
    setError(null);
    setAgain({ step: "signing-in", from, link: null });
    signInAgain(from, { signal: controller.signal, wanted: running, blocked: (link) => { if (running()) setAgain({ step: "signing-in", from, link }); } }).then((session) => {
      if (againRun.current === controller) againRun.current = null;
      if (!running()) return;
      if (session === null) { setAgain({ step: "offered", from }); return; }
      setAgain(null);
      addOn(current, session);
    }, (failure: unknown) => {
      if (againRun.current === controller) againRun.current = null;
      if (!running()) return;
      console.warn("Ovis: the sign-in did not finish", failure instanceof Error ? failure.name : failure);
      setAgain({ step: "offered", from });
      setError(t("The sign-in did not finish. Try again."));
    });
  };
  const cancelAgain = (): void => {
    againRun.current?.abort();
    againRun.current = null;
    setAgain((now) => now === null ? null : { step: "offered", from: now.from });
  };
  useEffect(() => {
    if (!job || job.phase !== "connected" || addAfterUpdate.current !== job.id) return;
    addAfterUpdate.current = null;
    void begin(undefined, job.machine_id);
  }, [job?.id, job?.phase]);
  // Ovis installed there with the official installer, then the account add again on the PC it added
  const installOvis = async () => {
    if (pending) return;
    setPending(true); setError(null);
    try { setInstall(await startPcInstall({ destination: destination.trim(), ...(port ? { port: Number(port) } : {}), ...(key.trim() ? { identity_file: key.trim() } : {}), ...(name.trim() ? { name: name.trim() } : {}) })); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setPending(false); }
  };
  useEffect(() => {
    if (!install || !installing) return;
    let cancelled = false;
    let timer = 0;
    const poll = async () => {
      try {
        const next = await fetchPcInstall(install.id);
        if (cancelled) return;
        // the add again on the PC the install's connection added (its setup job names it), never as a second PC; looked
        // up before the install shows as done, as that re-render ends this poll
        if (next.phase === "connected") {
          const added = next.connect_job ? await fetchMachineSetup(next.connect_job) : null;
          if (cancelled) return;
          setInstall(next);
          void begin(undefined, added?.machine_id ?? next.machine_id ?? undefined);
          return;
        }
        setInstall(next);
        if (["failed", "cancelled"].includes(next.phase)) return;
      } catch (e) { if (!cancelled) setError(e instanceof Error ? e.message : String(e)); }
      if (!cancelled) timer = window.setTimeout(poll, 750);
    };
    timer = window.setTimeout(poll, 750);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [install?.id, installing]);
  const inheritedStarted = useRef(false);
  useEffect(() => {
    if ((!machine?.herdr_profile_id && machine?.action_required !== "choose_herdr" && machine?.action_required !== "windows_login" && machine?.action_required !== "windows_start_failed") || inheritedStarted.current) return;
    inheritedStarted.current = true;
    void begin();
  }, []);
  const act = async (action: SetupAction) => {
    if (!job || pending) return;
    setPending(true); setError(null); clearSecret();
    try { setJob(await answerMachineSetup(job.id, action)); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setPending(false); }
  };
  return <dialog ref={dialog} className="modal machine-dialog" aria-labelledby="machine-dialog-title" onCancel={(e) => { e.preventDefault(); onClose(); }}>
    <header className="modal-header"><h2 id="machine-dialog-title" className="modal-title"><Monitor size={18} /> {t(updateRemote && ownUpdate ? "Update this PC's Ovis" : updateRemote ? "Update remote bridge" : machine?.action_required === "connect" ? "Connect" : machine?.action_required === "setup" ? "Set up web access" : machine ? "Reconnect PC" : "Add PC")}</h2><button className="icon-button" aria-label={t("Close PC setup")} onClick={onClose}><X /></button></header>
    <div className="modal-body">
      {(!job || finished && job.phase !== "connected") && <form id="machine-connect-form" onSubmit={(e) => { e.preventDefault(); void begin(); }}>
        {machine?.herdr_profile_id ? <p className="field-hint">{machine.name} — {destination} / {session}</p> : <>
        <label className="field"><span className="field-label">{t("SSH alias or user@address")}</span><input ref={destinationField} autoFocus className="input" required autoComplete="off" value={destination} onChange={(e) => editIdentity("destination", e.target.value)} placeholder="devbox or user@192.168.1.20" /></label>
        <label className="field"><span className="field-label">{t("PC name")}</span><input className="input" maxLength={100} value={name} placeholder={destination || t("Filled from the SSH address")} onChange={(e) => setName(e.target.value)} /></label>
        {accountAdd !== null && <label className="machine-check"><input type="checkbox" checked={vouch} onChange={(e) => setVouch(e.target.checked)} />{t("Add it to my account")}</label>}
        <details><summary>{t("Advanced settings")}</summary><div className="machine-advanced">
          <label className="field"><span className="field-label">{t("SSH port")}</span><input className="input" type="number" min="1" max="65535" placeholder={t("From SSH config (default 22)")} value={port} onChange={(e) => editIdentity("port", e.target.value)} /></label>
          <label className="field"><span className="field-label">{t("Private key path on this web server")}</span><input className="input" value={key} placeholder={t("From SSH config")} onChange={(e) => setKey(e.target.value)} /></label>
          <label className="field"><span className="field-label">{t("herdr session name")}</span><input className="input" value={session} placeholder={t("Default session")} onChange={(e) => editIdentity("session", e.target.value)} /></label>
          <label className="machine-check"><input type="checkbox" checked={herdrInstead} onChange={(e) => { setHerdrInstead(e.target.checked); if (e.target.checked) { setOwnOvis(""); setHerdrSocket(""); } }} />{t("Use the default herdr session instead of Ovis")}</label>
          {besideOvis && <HerdrSessionChoices sessions={job?.found_herdr_sessions ?? []} busy={pending} onChoose={(choice) => void begin(choice)} />}
          <p className="field-hint">{t("Uses the web server account’s SSH config and ssh-agent. Agent CLI tools and logins use the environment on the target PC.")}</p>
        </div></details>
        </>}
      </form>}
      {job && job.challenge?.kind !== "host_key" && <div className="machine-progress" role="status">{waitingForLogin ? <strong>{t(startupFailed ? "Windows desktop startup failed" : "Waiting for Windows sign-in")}</strong> : stage !== undefined ? <StageProgress label={transfer ? t(transfer.label) : setupStepText(job, t)} stage={stage} total={SETUP_STAGES}>{transfer?.detail != null && <p className="bridge-progress-detail">{transfer.detail}</p>}</StageProgress> : <strong>{choosing && job.error ? machineErrorText(job.error, t) : setupStepText(job, t)}</strong>}{waitingForLogin && job.step !== "Waiting for Windows sign-in on this PC." && <p>{machineErrorText(job.step, t)}</p>}{!choosing && !choiceAfterFailure && setupErrorLines(job, t).map((line) => <p key={line}>{line}</p>)}{job.ssh_output && <SshOutput text={job.ssh_output} />}</div>}
      {job?.action_required === "choose_herdr" && (job.found_herdr_sessions || job.found_ovis) && <FoundHerdrChoices sessions={job.found_herdr_sessions ?? []} ownOvis={job.found_ovis} error={job.error} busy={pending} onChoose={(choice) => void begin(choice)} foldedAbove={!machine?.herdr_profile_id} />}
      {waitingForLogin && <p className="field-hint">{t("Starting without Windows sign-in can break Codex sandbox commands, and desktop-control tools may be unavailable. This choice applies to one start.")}</p>}
      {waitingForLogin && <p className="field-hint">{t("Signing out of Windows ends herdr and its panes; lock the PC instead.")}</p>}
      {needsBridgeUpdate && <p className="field-hint">{t(ownUpdate ? "It updates itself through its own updater, then this PC reconnects; herdr sessions keep running." : "This PC runs a bridge from a different version of Ovis. Update it to reconnect; herdr sessions keep running.")}</p>}
      {job?.phase === "failed" && own && !own.updatable && <OwnOvisAddress own={own} />}
      {running && keepOpen && <p className="field-hint">{t("Keep this dialog open until the PC connects.")}</p>}
      {running && !waitingForLogin && !keepOpen && <p className="field-hint">{t("You can close this; the install keeps going and the sidebar shows it.")}</p>}
      {job?.phase === "approval" && <><ul className="machine-install-list">{job.installations.map((item) => <li key={item}>{item}</li>)}</ul><p className="field-hint">{t(ownUpdate ? "That PC's own updater installs it there. Existing herdr sessions keep running." : "Installs into your home directory. Existing herdr sessions keep running.")}</p></>}
      {job?.challenge && <div className="machine-challenge">{job.challenge.kind === "host_key" ? <HostKeyQuestion prompt={job.challenge.prompt} host={job.target.destination} sshOutput={job.ssh_output} /> : <><pre>{job.challenge.prompt}</pre><form onSubmit={(e) => {
        e.preventDefault();
        const answer = secretField.current?.value ?? "";
        if (answer === "") { secretField.current?.focus(); return; }
        void act({ action: "answer", challenge_id: job.challenge!.id, answer });
      }}>
        <label className="field"><span className="field-label">{t("Password or key passphrase")}</span><input ref={secretField} autoFocus className="input" type="password" autoComplete="off" disabled={!secretAllowed || pending} /></label>
        {!secretAllowed && <p className="field-hint">{t("Open this app over HTTPS or localhost to enter a password.")}</p>}
        <button type="submit" className="btn btn-primary" disabled={!secretAllowed || pending}>{t("Continue")}</button>
      </form></>}</div>}
      {added !== null && <p className="field-hint" role="status">{again?.step === "signing-in" ? t("Finish signing in in your browser.") : again?.step === "offered" ? t("Sign in again now to add it right away.") : addedWords(added, t)}</p>}
      {added === "adding" && again === null && <ProgressBar label={t("Adding it to your account…")} percent={null} />}
      {install !== null && <div className="machine-progress" role="status"><strong>{install.phase === "failed" ? t("Ovis was not installed on that PC") : t("Installing Ovis on that PC…")}</strong>{install.error !== null ? <p>{install.error}</p> : installAt !== null ? <StageProgress label={installAt.label} stage={installAt.stage} total={INSTALL_STAGES}><p className="bridge-progress-detail">{install.step}</p></StageProgress> : <p>{install.step}</p>}</div>}
      {error && <p className="machine-error" role="alert">{error}</p>}
    </div>
    <footer className="modal-footer">
      {job && !finished && <button className="btn" disabled={pending} onClick={() => void act({ action: "cancel" })}>{t(running && !waitingForLogin ? "Cancel install" : "Cancel connection")}</button>}
      {waitingForLogin && <button className="btn" disabled={pending} onClick={() => void act({ action: "start_headless" })}>{t("Start without Windows sign-in")}</button>}
      {running && !keepOpen && <button className="btn btn-primary" onClick={onClose}>{t("Continue in background")}</button>}
      {job?.challenge?.kind === "host_key" && <><button className="btn" disabled={pending} onClick={() => void act({ action: "answer", challenge_id: job.challenge!.id, answer: "no" })}>{t("Reject")}</button><button className="btn btn-primary" disabled={pending} onClick={() => void act({ action: "answer", challenge_id: job.challenge!.id, answer: "yes" })}>{t("Trust fingerprint")}</button></>}
      {job?.phase === "approval" && <button className="btn btn-primary" disabled={pending} onClick={() => void act({ action: "approve" })}>{t("Install and connect")}</button>}
      {job?.phase === "failed" && job.action_required === "install_ovis" && accountAdd !== null && !installing && install?.phase !== "connected" && <button className="btn btn-primary" disabled={pending} onClick={() => void installOvis()}>{t("Install Ovis there")}</button>}
      {again?.step === "offered" && <button className="btn btn-primary" onClick={() => signInAndAdd(again.from)}>{t("Sign in again")}</button>}
      {again?.step === "signing-in" && <>
        {again.link !== null && <ExternalLink kind="sign-in" className="btn btn-primary" href={again.link}>{t("Open the sign-in page")}</ExternalLink>}
        <button className="btn" onClick={cancelAgain}>{t("Cancel")}</button>
      </>}
      {job?.phase === "connected" ? <button className={again === null ? "btn btn-primary" : "btn"} onClick={() => onConnected(job.machine_id)}>{t("Open PC")}</button> : (!job || finished) && <button className={choosing && job?.found_ovis?.length ? "btn" : "btn btn-primary"} form="machine-connect-form" type="submit" disabled={pending}>{t(pending ? "Connecting…" : needsBridgeUpdate && ownUpdate ? (previewVersion(own?.latest_version) ? "Update this PC's Ovis to the preview and connect" : "Update this PC's Ovis and connect") : needsBridgeUpdate ? "Update bridge and connect" : job ? "Retry connection" : "Connect")}</button>}
    </footer>
  </dialog>;
}

/** What the account add over SSH came to; only `added` says that PC is in the account */
function addedWords(outcome: SshAddOutcome | "adding" | "other-pc", t: ReturnType<typeof useT>): string {
  switch (outcome) {
    case "adding": return t("Adding it to your account…");
    case "added": return t("Added to your account.");
    case "already": return t("It is already in your account.");
    case "added-unchecked": return `${t("Added to your account.")} ${t("Update Ovis on that PC to check its relay.")}`;
    case "already-unchecked": return `${t("It is already in your account.")} ${t("Update Ovis on that PC to check its relay.")}`;
    case "added-unanswered": return `${t("Added to your account.")} ${t("Connect again to check its relay.")}`;
    case "already-unanswered": return `${t("It is already in your account.")} ${t("Connect again to check its relay.")}`;
    case "not-online": return t("It is in your account, but its relay is not online yet, so your devices cannot open it. Run ovis status on that PC to see why.");
    case "relay-off": return `${t("It is already in your account.")} ${t("Its relay is turned off on that PC.")}`;
    case "maybe": return t("It may have been added. Connect again to check.");
    case "other-pc": return t("That address now reaches another PC. Nothing was added.");
    case "other-account": return t("That PC is in another account.");
    case "number": return t("Add it with the number on the server's Ovis page.");
    case "sign-in-again": return t("Sign in again on this PC, then add it again.");
    case "list-cannot-add": return t("This PC cannot add PCs to your account's list. On that PC, run ovis add and add it with the number it shows.");
    case "update-that-pc": return t("Update Ovis on that PC, then add it again: its Ovis cannot join your account's list.");
    case "list-not-added": return t("That PC was not put in your account's list. Add it again.");
    case "list-placed": return t("That PC is in your account's list, and has not taken it yet. Add it again to finish.");
    case "list-later": return t("Your account's list takes no more PCs for now. Add that PC again later.");
    case "list-removed": return t("That PC was removed from your account. It comes back only as a new PC: run ovis add on it and type yes when it asks to add it as a new PC.");
    case "account-changed": return t("This PC's account changed while that PC was being added. Look for that PC in the account you added it to.");
    case "pc-error": return t("That PC could not answer. Try again.");
    case "refused": case "disconnected": return t("It was not added to your account. Try again.");
  }
}

function SshOutput({ text }: { text: string }) {
  const t = useT();
  return <pre className="machine-ssh-output" aria-label={t("SSH output")}>{sshOutputParts(text).map((part, i) => part.type === "link" ? <ExternalLink kind="link" key={i} href={part.href}>{part.value}</ExternalLink> : part.value)}</pre>;
}

/**
 * The host-key decision: the fingerprint to compare and one sentence; ssh's own words wait behind
 * a fold.
 */
function HostKeyQuestion({ prompt, host, sshOutput }: { prompt: string; host: string; sshOutput: string | null }) {
  const t = useT();
  const fingerprints = hostKeyFingerprints(prompt);
  const sentence = useAnnouncedText(t("Trust it only if it matches the fingerprint shown on the PC."));
  return <>
    {fingerprints.length > 0 ? <>
      <p className="machine-fingerprint-label">{t("Fingerprint of {host}", { host })}</p>
      {fingerprints.map((fingerprint) => <p key={fingerprint} className="machine-fingerprint">{fingerprint}</p>)}
    </> : <pre>{prompt}</pre>}
    <p className="field-hint" role="status">{sentence}</p>
    {(fingerprints.length > 0 || sshOutput !== null) && <details className="machine-ssh-fold">
      <summary>{t("Show SSH output")}</summary>
      {fingerprints.length > 0 && <pre>{prompt}</pre>}
      {sshOutput !== null && <SshOutput text={sshOutput} />}
    </details>}
  </>;
}
