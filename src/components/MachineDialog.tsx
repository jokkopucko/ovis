import { useEffect, useRef, useState } from "react";
import { Monitor, X } from "lucide-react";
import type { Machine, SetupAction, SetupJob } from "../../shared/machines.ts";
import type { AddPcPreset } from "../lib/actions.ts";
import { answerMachineSetup, fetchMachineSetup, startMachineSetup } from "../lib/api.ts";
import { hostKeyFingerprints } from "../lib/hostKey.ts";
import { sshOutputParts } from "../lib/sshOutput.ts";
import { useAnnouncedText } from "../lib/useAnnouncedText.ts";
import { machineErrorText } from "../lib/userError.ts";
import { BridgeUpdateProgress, OwnOvisAddress, ownOvisAction } from "./MachineSidebar.tsx";
import "./Machines.css";
import { useT } from "../lib/i18n.ts";
import { asksChoice, FoundHerdrChoices, type HerdrChoice } from "./FoundHerdrChoices.tsx";

export function MachineDialog({ machine, preset, updateRemote = false, onClose, onConnected }: { machine?: Machine; /** a new PC's address and name, picked under Add a connection → SSH */ preset?: AddPcPreset; updateRemote?: boolean; onClose(): void; onConnected(id: string): void }) {
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
  const [job, setJob] = useState<SetupJob | null>(null);
  const mounted = useRef(true);
  const jobRef = useRef(job); jobRef.current = job;
  // the identity the form shows now: an answer sent for another one never offers its choices here
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
  // the setup stopped on a fresh choice only the user can make: it asks it, it is not told as a failed connection. A
  // choice offered because what was chosen failed stays a failure, its card saying why
  const choosing = job?.action_required === "choose_herdr" && asksChoice(job.error, job.found_herdr_sessions ?? [], job.found_ovis ?? []);
  const choiceAfterFailure = job?.action_required === "choose_herdr" && !choosing;
  const keepOpen = job?.windows_startup === true;
  // the PC's own Ovis, older than this app: the update asks it to update itself, or it cannot be from here
  const own = job?.remote_ovis ?? (job || !machine ? null : ownOvisAction(machine));
  const ownUpdate = own?.updatable === true;

  // closing cancels a job that still waits on this dialog (a question, an approval); an
  // approved install keeps going on the server and shows in the sidebar
  // React's autoFocus runs at mount, while the dialog is still closed; showModal() then moves focus
  // to the first focusable element (Close), so the field is focused again once the dialog is open
  useEffect(() => { mounted.current = true; dialog.current?.showModal(); destinationField.current?.focus(); return () => { mounted.current = false; const current = jobRef.current; if (current && !["connected", "failed", "cancelled"].includes(current.phase) && (current.windows_startup || !["installing", "starting"].includes(current.phase))) void answerMachineSetup(current.id, { action: "cancel" }).catch(() => {}); }; }, []);
  const running = !!job && ["installing", "starting"].includes(job.phase);
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

  const begin = async (choice?: HerdrChoice) => {
    if (pending) return;
    setError(null); setPending(true);
    if (choice && machine?.herdr_profile_id) choice = { ...choice, session: machine.target?.session };
    // a PC saved in herdr keeps its catalog name, which the server does not read from here
    if (choice) { if ("session" in choice) setSession(choice.session ?? ""); setHerdrSocket(choice.herdr_socket ?? ""); setStartNewHerdr(choice.start_new_herdr === true); setOwnOvis(choice.own_ovis ?? ""); }
    const sentFor = [destination.trim(), port, choice && "session" in choice ? choice.session ?? "" : session].join("\0");
    try { const next = await startMachineSetup({ destination: destination.trim(), ...(name.trim() && !machine?.herdr_profile_id ? { name: name.trim() } : {}), ...(port ? { port: Number(port) } : {}), ...(key.trim() ? { identity_file: key.trim() } : {}), ...(session.trim() ? { session: session.trim() } : {}), ...(herdrSocket ? { herdr_socket: herdrSocket } : {}), ...(startNewHerdr ? { start_new_herdr: true } : {}), ...(ownOvis ? { own_ovis: ownOvis } : {}), ...choice, ...(machine ? { machine_id: machine.id } : {}), ...(needsBridgeUpdate || updateRemote ? { update_remote: true } : {}) });
      // the address, port or session edited while it was in flight: that PC's sessions are never offered for this one
      if (mounted.current) setJob(next.action_required === "choose_herdr" && sentFor !== identityRef.current ? { ...next, action_required: null, found_herdr_sessions: undefined } : next);
      else if (!["connected", "failed", "cancelled"].includes(next.phase) && (next.windows_startup || !["installing", "starting"].includes(next.phase))) await answerMachineSetup(next.id, { action: "cancel" });
    }
    catch (e) { if (mounted.current) setError(e instanceof Error ? e.message : String(e)); }
    finally { if (mounted.current) setPending(false); }
  };
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
        <details><summary>{t("Advanced settings")}</summary><div className="machine-advanced">
          <label className="field"><span className="field-label">{t("SSH port")}</span><input className="input" type="number" min="1" max="65535" placeholder={t("From SSH config (default 22)")} value={port} onChange={(e) => editIdentity("port", e.target.value)} /></label>
          <label className="field"><span className="field-label">{t("Private key path on this web server")}</span><input className="input" value={key} placeholder="~/.ssh/id_ed25519" onChange={(e) => setKey(e.target.value)} /></label>
          <label className="field"><span className="field-label">{t("herdr session name")}</span><input className="input" value={session} placeholder={t("Default session")} onChange={(e) => editIdentity("session", e.target.value)} /></label>
        </div></details>
        <p className="field-hint">{t("Uses the web server account’s SSH config and ssh-agent. Agent CLI tools and logins use the environment on the target PC.")}</p>
        </>}
      </form>}
      {job && job.challenge?.kind !== "host_key" && <div className="machine-progress" role="status">{waitingForLogin ? <strong>{t(startupFailed ? "Windows desktop startup failed" : "Waiting for Windows sign-in")}</strong> : running && job.progress ? <BridgeUpdateProgress update={{ job_id: job.id, step: job.step, progress: job.progress }} /> : <strong>{choosing && job.error ? machineErrorText(job.error, t) : job.step === "Starting without Windows sign-in…" ? t("Starting without Windows sign-in…") : job.step}</strong>}{waitingForLogin && job.step !== "Waiting for Windows sign-in on this PC." && <p>{machineErrorText(job.step, t)}</p>}{job.error && !choosing && !choiceAfterFailure && <p>{machineErrorText(job.error, t)}</p>}{job.ssh_output && <SshOutput text={job.ssh_output} />}</div>}
      {job?.action_required === "choose_herdr" && (job.found_herdr_sessions || job.found_ovis) && <FoundHerdrChoices sessions={job.found_herdr_sessions ?? []} ownOvis={job.found_ovis} error={job.error} busy={pending} onChoose={(choice) => void begin(choice)} />}
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
      {error && <p className="machine-error" role="alert">{error}</p>}
    </div>
    <footer className="modal-footer">
      {job && !finished && <button className="btn" disabled={pending} onClick={() => void act({ action: "cancel" })}>{t(running && !waitingForLogin ? "Cancel install" : "Cancel connection")}</button>}
      {waitingForLogin && <button className="btn" disabled={pending} onClick={() => void act({ action: "start_headless" })}>{t("Start without Windows sign-in")}</button>}
      {running && !keepOpen && <button className="btn btn-primary" onClick={onClose}>{t("Continue in background")}</button>}
      {job?.challenge?.kind === "host_key" && <><button className="btn" disabled={pending} onClick={() => void act({ action: "answer", challenge_id: job.challenge!.id, answer: "no" })}>{t("Reject")}</button><button className="btn btn-primary" disabled={pending} onClick={() => void act({ action: "answer", challenge_id: job.challenge!.id, answer: "yes" })}>{t("Trust fingerprint")}</button></>}
      {job?.phase === "approval" && <button className="btn btn-primary" disabled={pending} onClick={() => void act({ action: "approve" })}>{t("Install and connect")}</button>}
      {job?.phase === "connected" ? <button className="btn btn-primary" onClick={() => onConnected(job.machine_id)}>{t("Open PC")}</button> : (!job || finished) && <button className={choosing && job?.found_ovis?.length ? "btn" : "btn btn-primary"} form="machine-connect-form" type="submit" disabled={pending}>{t(pending ? "Connecting…" : needsBridgeUpdate && ownUpdate ? "Update this PC's Ovis and connect" : needsBridgeUpdate ? "Update bridge and connect" : job ? "Retry connection" : "Connect")}</button>}
    </footer>
  </dialog>;
}

function SshOutput({ text }: { text: string }) {
  const t = useT();
  return <pre className="machine-ssh-output" aria-label={t("SSH output")}>{sshOutputParts(text).map((part, i) => part.type === "link" ? <a key={i} href={part.href} target="_blank" rel="noopener noreferrer">{part.value}</a> : part.value)}</pre>;
}

/**
 * The host-key decision: the fingerprint to compare and one sentence; ssh's own words wait behind
 * a fold. No status box above it: the question is the state. The sentence is the announcement of
 * that state, so its words land a frame after the box (lib/useAnnouncedText.ts).
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
