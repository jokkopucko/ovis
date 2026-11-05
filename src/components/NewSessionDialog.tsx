import { useEffect, useLayoutEffect, useRef, useState, type MouseEvent } from "react";
import { flushSync } from "react-dom";
import { FolderOpen, X } from "lucide-react";

import "./NewSessionDialog.css";

import type { AgentKind, SlashCommand } from "../../shared/protocol.ts";
import { MAX_LABEL_CHARS } from "../../shared/labels.ts";
import { ApiError } from "../lib/api.ts";
import { AddAgentPanel } from "./AddAgentPanel.tsx";
import { AgentPicker, rememberAgent, rememberedAgent } from "./AgentPicker.tsx";
import { DirectoryBrowser, homeRelative } from "./DirectoryBrowser.tsx";
import { RecentFolderChips } from "./RecentFolderChips.tsx";
import { Toggle } from "./SettingsControls.tsx";
import { useMachineApi, useMachineId } from "../lib/machineContext.tsx";
import { useAgentSkills } from "../lib/useAgentSkills.ts";
import { useT } from "../lib/i18n.ts";
import { latestRead, READ_AGAIN_MS, READ_AGAIN_TIMES, readAgainUntil } from "../lib/latestRead.ts";
import { useSettings } from "../lib/settings.ts";
import { learnTabLabel } from "../lib/tabLabels.ts";
import { launchCapabilities, modelSuggestions } from "../lib/agentLaunchMode.ts";
import { MAX_COMPOSER_CHARS } from "../lib/compose.ts";
import { createRequest, dialogLaunch, firstMessageOutcome, startNewSession } from "../lib/newSession.ts";
import { useMachineSessions } from "../lib/machineSessionContext.tsx";
import { composerDrafts } from "../lib/composerDraft.ts";
import { paneStorageId } from "../../shared/machines.ts";
import { inFlightGuard } from "../lib/sessionHistory.ts";
import { userErrorMessage, type UserError } from "../lib/userError.ts";
import { nativeModalOver, useFocusTrap } from "../lib/useFocusTrap.ts";
import { useSheetSwipe } from "../lib/sheets.ts";
import { passingFolder, recentDirectories } from "../lib/recent-directories.ts";

/** The dialog as New tab: the workspace the tab joins, whose folder it uses, and the number herdr will give it. */
export interface NewTabTarget {
  workspaceId: string;
  workspaceLabel: string;
  cwd: string | null;
  number: number;
}

export interface NewSessionDialogProps {
  open: boolean;
  machineName?: string;
  defaultCwd: string | null;
  /** set, the dialog makes a tab in that workspace instead of a workspace */
  tab?: NewTabTarget | null;
  onClose: () => void;
  /**
   * `agentStarted`: the pane runs the agent asked for, so it opens in an agent's lens; `messageWaits`: the
   * bridge queued the first message for the agent's first ready turn, or its text was kept in the chat's
   * message box when it was not queued, so the pane opens in the chat lens, where it shows
   */
  onCreated: (paneId: string, agentStarted: boolean, messageWaits?: boolean) => void;
  /** fields a link fills for this opening (`?new=`, lib/deepLink.ts); an agent herdr does not offer is left out */
  prefill?: DialogFields | null;
  /** what the fields say, a moment after they change, for the address */
  onDraft?: (fields: DialogFields) => void;
  /** the PC's open linked worktree checkouts: no project to offer among the recent folders */
  worktrees?: readonly string[];
  /** shows a pane of this dialog's PC in its terminal: an agent's install or sign-in tab, from Add another agent */
  onOpenPane?: (paneId: string) => void;
  /** this device only watches: a setup types into the PC's terminal, so Add another agent is not offered */
  watching?: boolean;
}

export interface DialogFields {
  cwd: string | null;
  name: string | null;
  /** "" is a shell; null keeps the last agent picked */
  agent: string | null;
}

/** how long the fields rest before the address follows them: Safari refuses a burst of history writes */
const DRAFT_MS = 400;
/** recent folders offered: one row a phone swipes sideways; a wider screen fits what one row holds and lists the rest under "+N" */
const RECENT_FOLDERS_SHOWN = 8;

function directoryBasename(value: string): string {
  const trimmed = value.replace(/\\/g, "/").replace(/\/+$/, "");
  return trimmed.split("/").pop() || value;
}

const skillToken = (skill: SlashCommand): string => `${skill.trigger ?? "/"}${skill.name}`;

/** `token` at `at` in `text`, a space on each side where it meets a word; the caret lands after it. */
export function insertToken(text: string, at: number, token: string): { text: string; caret: number } {
  const before = text.slice(0, at);
  const after = text.slice(at);
  const lead = before !== "" && !/\s$/.test(before) ? " " : "";
  const trail = after === "" || !/^\s/.test(after) ? " " : "";
  const head = `${before}${lead}${token}${trail}`;
  return { text: `${head}${after}`.slice(0, MAX_COMPOSER_CHARS), caret: Math.min(head.length, MAX_COMPOSER_CHARS) };
}

export function NewSessionDialog({ open, defaultCwd, tab = null, onClose, onCreated, machineName, prefill = null, onDraft, worktrees = [], onOpenPane, watching = false }: NewSessionDialogProps) {
  const t = useT();
  const { settings } = useSettings();
  const machineId = useMachineId();
  const { createTab, createWorkspace, fetchAgentKinds, fetchAgentCommands } = useMachineApi();
  const machineSessions = useMachineSessions();
  const [agents, setAgents] = useState<AgentKind[]>([]);
  const [agentKind, setAgentKind] = useState(rememberedAgent);
  const [cwd, setCwd] = useState(defaultCwd ?? "");
  const [name, setName] = useState("");
  const [model, setModel] = useState("");
  const [effort, setEffort] = useState("");
  const [ultracode, setUltracode] = useState(false);
  const [prompt, setPrompt] = useState("");
  // the skills the picked agent would offer in the folder, before any process exists (GET /api/agent/commands)
  const skillFolder = tab ? tab.cwd : cwd.trim() || null;
  const [skills, setSkills] = useAgentSkills(open, agentKind, skillFolder, fetchAgentCommands, t);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<UserError | null>(null);
  const [createdPaneId, setCreatedPaneId] = useState<string | null>(null);
  /** the made pane runs the agent asked for: Open shows it in the agent's lens */
  const [createdStarted, setCreatedStarted] = useState(false);
  /** the first message was not queued and waits in the made pane's chat box: Open shows the chat */
  const [createdKept, setCreatedKept] = useState(false);
  const [browsing, setBrowsing] = useState(false);
  // Add another agent shows in place of the fields, which keep what was typed
  const [adding, setAdding] = useState(false);
  // the PC's agents read again after a setup: nothing is started until the picker shows the result
  const [refreshing, setRefreshing] = useState(false);
  // counts openings and closings, so an answer for an earlier opening changes nothing
  const openings = useRef(0);
  // the agent list as read last: the read as the dialog opened may answer after the one an install asked for
  const agentReads = useRef(latestRead());
  const [recentFolders, setRecentFolders] = useState(() => recentDirectories.read(machineId));
  // folders kept before worktrees and temporary folders were left out are left out here too
  const shownFolders = recentFolders.filter((path) => !passingFolder(path, worktrees)).slice(0, RECENT_FOLDERS_SHOWN);
  const firstFieldRef = useRef<HTMLButtonElement>(null);
  const promptField = useRef<HTMLTextAreaElement>(null);
  // one Start at a time, whatever the fields' disabled state has rendered yet: a double tap sends one create
  const guard = useRef(inFlightGuard());
  // a path longer than its field is shown from its end, where the folder's name is, whenever it is
  // set for the user (the last folder, a pick from Browse or a recent chip) and when the field is
  // left; typing keeps the caret in view by itself
  const cwdField = useRef<HTMLInputElement>(null);
  const showPathEnd = (): void => {
    const field = cwdField.current;
    if (field !== null) field.scrollLeft = field.scrollWidth;
  };
  useLayoutEffect(() => {
    if (open && document.activeElement !== cwdField.current) showPathEnd();
  }, [open, cwd]);
  const surface = useFocusTrap<HTMLFormElement>(open, { initialFocus: firstFieldRef });
  useSheetSwipe(surface, pending ? null : onClose);
  const defaultCwdRef = useRef(defaultCwd);
  defaultCwdRef.current = defaultCwd;
  const prefillRef = useRef(prefill);
  prefillRef.current = prefill;

  // The previous launch may have left disabled fields: reset them before the opening paint.
  useLayoutEffect(() => {
    if (!open) return;
    const filled = prefillRef.current;
    setCwd(filled?.cwd ?? defaultCwdRef.current ?? "");
    setName(filled?.name ?? "");
    setModel("");
    setEffort("");
    setUltracode(false);
    setPrompt("");
    setSkills(null);
    setError(null);
    setPending(false);
    setCreatedPaneId(null);
    setCreatedStarted(false);
    setCreatedKept(false);
    setBrowsing(false);
    setAdding(false);
    setRefreshing(false);
    setRecentFolders(recentDirectories.read(machineId));
    const remembered = rememberedAgent();
    const stored = filled?.agent ?? remembered;
    setAgentKind(stored);
    let cancelled = false;
    const latest = agentReads.current();
    void fetchAgentKinds()
      .then((next) => {
        if (cancelled || !latest()) return;
        setAgents(next);
        // a linked agent herdr does not offer gives way to the last one picked, as an unknown remembered one does to a shell
        if (stored && !next.some((agent) => agent.kind === stored)) {
          const kind = stored !== remembered && next.some((agent) => agent.kind === remembered) ? remembered : "";
          setAgentKind(kind);
          // what was chosen meanwhile for the agent that gave way goes as pickAgent's choices go
          const can = launchCapabilities(kind);
          setModel("");
          setEffort((current) => can.efforts.includes(current) ? current : "");
          if (!can.ultracode) setUltracode(false);
        }
      })
      .catch((reason: unknown) => {
        if (!cancelled && latest()) setError(userErrorMessage(reason));
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  useEffect(() => {
    if (!open || !onDraft) return;
    const timer = window.setTimeout(() => onDraft({ cwd: cwd || null, name: name || null, agent: agentKind }), DRAFT_MS);
    return () => window.clearTimeout(timer);
  }, [open, onDraft, cwd, name, agentKind]);


  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      // a native modal over it (Add PC, from the palette) takes its own Escape
      if (event.key !== "Escape" || nativeModalOver(surface.current)) return;
      event.preventDefault();
      if (!pending) onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open, onClose, pending]);

  useLayoutEffect(() => { openings.current += 1; }, [open]);

  // back from Add another agent, the focus returns to the picker it was opened from
  const wasAdding = useRef(false);
  // (after a setup, once the refreshed picker is enabled again)
  useEffect(() => {
    if (adding) { wasAdding.current = true; return; }
    if (wasAdding.current && !refreshing) { wasAdding.current = false; firstFieldRef.current?.focus(); }
  }, [adding, refreshing]);

  // the read-again loop after Add another agent… installs one (addedAgent below): stopped on close,
  // reopen and unmount
  const readingAgain = useRef<() => void>(() => undefined);
  useEffect(() => () => readingAgain.current(), []);
  useEffect(() => { readingAgain.current(); }, [open]);
  if (!open) return null;

  const selectedAgent = agents.find((agent) => agent.kind === agentKind);
  const agentLabel = selectedAgent?.label ?? agentKind;
  const pendingLabel = selectedAgent ? t("Starting {agent}… up to 60s", { agent: selectedAgent.label }) : t("Starting shell…");
  const fieldsDisabled = pending || refreshing || createdPaneId !== null;
  const can = launchCapabilities(agentKind);
  const launched = dialogLaunch({ agent: agentKind, model, effort, ultracode, prompt }, settings);
  const fault = "fault" in launched ? launched.fault : null;
  const launch = "fault" in launched ? null : launched;
  const suggestions = modelSuggestions(agentKind);
  // what the picker's rows say each launch takes: only the agents whose command line takes a model and a level
  const pickerHints = Object.fromEntries(agents.flatMap((agent) => {
    const takes = launchCapabilities(agent.kind);
    return takes.model && takes.efforts.length > 0 ? [[agent.kind, t("model, effort")]] : [];
  }));

  const pickAgent = (kind: string): void => {
    setAgentKind(kind);
    setSkills(null);
    // a choice the next agent's launch does not take goes back to the agent's own; a model names one agent's models
    const next = launchCapabilities(kind);
    if (!next.model || kind !== agentKind) setModel("");
    if (!next.efforts.includes(effort)) setEffort("");
    if (!next.ultracode) setUltracode(false);
  };

  // the installed agent is offered once the PC lists it: picked then, else said why not
  // the installed agent is offered once the PC lists it: picked then. Its installer may still be
  // editing the shell profile the PC reads the PATH from: until then the dialog says why and reads
  // again, every READ_AGAIN_MS for about a minute (lib/latestRead.ts readAgainUntil)
  const addedAgent = (kind: string): void => {
    const opening = openings.current;
    setAdding(false);
    setRefreshing(true);
    readingAgain.current();
    // the fields stay off while it waits: nothing the user picks or starts meanwhile is overridden; each
    // read's outcome is taken once (a late answer after its deadline is ignored), and the last one,
    // a stalled read included, turns the fields back on
    readingAgain.current = readAgainUntil(() => { agentReads.current(); return fetchAgentKinds(); }, {
      every: READ_AGAIN_MS,
      times: READ_AGAIN_TIMES,
      later: (run, ms) => { const timer = window.setTimeout(run, ms); return () => window.clearTimeout(timer); },
      apply: (outcome, last) => {
        if (openings.current !== opening) return true;
        if (outcome.kind === "answer") {
          setAgents(outcome.value);
          if (outcome.value.some((agent) => agent.kind === kind)) { pickAgent(kind); setError(null); setRefreshing(false); return true; }
        }
        if (!last) { setError({ message: t("It is installed. Waiting for this PC to offer it here…"), detail: null }); return false; }
        if (outcome.kind === "failed") setError(userErrorMessage(outcome.reason));
        else setError({ message: t("It is installed, but this PC does not offer it here yet. Restart Ovis on the PC, or start it in a terminal tab."), detail: null });
        setRefreshing(false);
        return true;
      },
    });
  };

  const insertSkill = (skill: SlashCommand): void => {
    const field = promptField.current;
    const at = field !== null && document.activeElement === field ? field.selectionEnd : prompt.length;
    const next = insertToken(prompt, at, skillToken(skill));
    // committed now and the caret placed in the same task, as the composer's completions are: a
    // placement deferred to the next frame would land behind a key typed right after the tap
    flushSync(() => setPrompt(next.text));
    const box = promptField.current;
    if (box === null) return;
    box.focus();
    box.setSelectionRange(next.caret, next.caret);
  };

  const startWorkspace = async (directory: string): Promise<void> => {
    if (pending || refreshing || guard.current.busy()) return;
    if (createdPaneId !== null) { onCreated(createdPaneId, createdStarted, createdKept); return; }
    // a combination the launch does not take: Start is disabled for it, and an Enter in a field sends nothing
    if (launch === null) return;
    setPending(true);
    setError(null);
    // a tab keeps the workspace's folder, which the dialog shows and does not ask for. The first message of an
    // agent whose command line does not take it rides on this request: the bridge queues it for the agent's first
    // ready turn and types it through this page's connection, so this page never types it itself
    const request = createRequest({ tab, directory, name }, launch, machineSessions?.peek(machineId)?.connection ?? null);
    const started = startNewSession(guard.current, request, async (body) => {
      rememberAgent(agentKind);
      return tab ? await createTab({ ...body, workspace_id: tab.workspaceId }) : await createWorkspace(body);
    });
    if (started === null) { setPending(false); return; }
    try {
      const result = await started;
      if (agentKind && !result.agent_started && result.error?.message) {
        setPending(false);
        // the workspace exists: say so plainly, keep the PC's own words beneath, and Open it rather than make another
        setError({ message: t("The workspace opened, but {agent} did not start. Check that it is installed on the PC, then open it again.", { agent: agentLabel }), detail: result.error.message });
        setCreatedPaneId(result.pane_id);
        return;
      }
      if (!tab && (!agentKind || result.agent_started)) {
        setRecentFolders(recentDirectories.remember(machineId, [directory.trim()], true));
      }
      const outcome = firstMessageOutcome(request, result);
      if (outcome.kind === "not_queued") {
        // the agent runs without its first message: the text waits in the new tab's message box, and the dialog says so
        composerDrafts.set(`ovis:composer-draft:${paneStorageId(machineId, result.pane_id)}`, request.first_message!);
        setPending(false);
        setError({
          message: outcome.error
            ? t("{agent} started, but its first message was not queued. It is in the new tab's message box: open the tab and send it.", { agent: agentLabel })
            : t("{agent} started, but this PC's bridge does not take a first message yet. It is in the new tab's message box: open the tab and send it.", { agent: agentLabel }),
          detail: outcome.error?.message ?? null,
        });
        setCreatedPaneId(result.pane_id);
        setCreatedStarted(true);
        setCreatedKept(true);
        return;
      }
      // the new tab takes its label from the first message, however it reaches the agent (#2019)
      if (settings.autoTabNames && agentKind !== "" && result.agent_started) learnTabLabel(machineId, result.pane_id, prompt);
      const messageWaits = outcome.kind === "queued";
      // the dialog closes on this: left pending, its next opening would start a frame with the
      // fields disabled and Escape ignored, until the open effect's reset has rendered
      setPending(false);
      onCreated(result.pane_id, agentKind !== "" && result.agent_started !== false, messageWaits);
    } catch (reason: unknown) {
      setPending(false);
      if (reason instanceof ApiError && reason.code === "invalid_cwd") setError({ message: t("Directory not found"), detail: null });
      else setError(userErrorMessage(reason));
    }
  };

  const closeFromScrim = (event: MouseEvent<HTMLDivElement>): void => {
    if (!pending && event.target === event.currentTarget) onClose();
  };

  const promptHint = launch?.prompt?.via === "positional" || (prompt.trim() === "" && can.positionalPrompt)
    ? t("Sent to {agent} as it starts.", { agent: agentLabel })
    : t("Queued for {agent}'s first turn: sent once it is ready, shown as a pending message until then.", { agent: agentLabel });

  return (
    <div className="modal-scrim new-session-scrim" onMouseDown={closeFromScrim}>
      <form ref={surface} className="modal new-session-modal" role="dialog" aria-modal="true" aria-labelledby="new-session-title" tabIndex={-1} onSubmit={(event) => { event.preventDefault(); void startWorkspace(cwd); }}>
        <header className="modal-header">
          <h2 className="modal-title" id="new-session-title">{tab ? `${t("New tab")} · ${tab.workspaceLabel}` : `${t("New workspace")} · ${machineName ?? machineId}`}</h2>
          <button type="button" className="icon-button" aria-label={t("Close dialog")} disabled={pending} onClick={onClose}>
            <X aria-hidden="true" />
          </button>
        </header>
        {adding && !watching ? <div className="modal-body">
          <AddAgentPanel onReady={addedAgent} onOpenTerminal={(paneId) => { if (onOpenPane) onOpenPane(paneId); else onClose(); }} onBack={() => setAdding(false)} />
        </div> : <><div className="modal-body">
          <div className="field">
            <span className="field-label" id="new-session-agent">{t("Agent")}</span>
            <AgentPicker ref={firstFieldRef} agents={agents} value={agentKind} disabled={fieldsDisabled} labelledBy="new-session-agent" hints={pickerHints} addAgent={watching ? undefined : { label: t("Add another agent…"), onSelect: () => setAdding(true) }} onChange={pickAgent} />
          </div>
          {tab ? (
            <div className="field">
              <span className="field-label">{t("Directory")}</span>
              <div className="new-session-folder">
                <FolderOpen aria-hidden="true" />
                <span>{tab.cwd ?? tab.workspaceLabel}</span>
              </div>
              <span className="field-hint">{t("Uses the workspace's folder")}</span>
            </div>
          ) : (
            <div className="field">
              <label className="field-label" htmlFor="new-session-cwd">{t("Directory")}</label>
              <div className="new-session-cwd">
                <input ref={cwdField} id="new-session-cwd" className="input" value={cwd} placeholder="~/projects/app" disabled={fieldsDisabled} autoComplete="off" onChange={(event) => setCwd(event.target.value)} onBlur={showPathEnd} />
                <button type="button" className="btn" aria-expanded={browsing} disabled={fieldsDisabled} onClick={() => setBrowsing((open) => !open)}>
                  <FolderOpen aria-hidden="true" />
                  {t("Browse")}
                </button>
              </div>
              {/* Browse updates Directory as you open folders, so Start uses what the path bar shows
                  even when Use this folder was never pressed (issue #1162); a folder under home
                  keeps the `~/…` form typed or picked, rather than turning absolute on opening Browse. */}
              {browsing && <DirectoryBrowser start={cwd} onPick={(picked) => { setCwd(picked); setBrowsing(false); }} onFolder={(path, home) => setCwd(homeRelative(path, home))} />}
              <span className="field-hint">{t("absolute path or ~/…")}</span>
            </div>
          )}
          {!tab && shownFolders.length > 0 && <div className="field new-session-recents">
            <span className="field-label" id="new-session-recents">{t("Recent folders")}</span>
            <RecentFolderChips folders={shownFolders} disabled={fieldsDisabled} labelledBy="new-session-recents" basename={directoryBasename}
              onPick={(path) => { setCwd(path); setBrowsing(false); }} />
          </div>}
          <label className="field">
            <span className="field-label">{t("Name")}</span>
            <input
              className="input"
              value={name}
              maxLength={MAX_LABEL_CHARS}
              disabled={fieldsDisabled}
              autoComplete="off"
              placeholder={tab ? String(tab.number) : directoryBasename(cwd)}
              onChange={(event) => setName(event.target.value)}
            />
            <span className="field-hint">{t(tab ? "Tab name (optional)" : "Optional workspace label")}</span>
          </label>
          {/* the launch's own choices, only where the agent's command line takes them (lib/agentLaunchMode.ts) */}
          {(can.model || can.efforts.length > 0) && <div className="new-session-launch">
            {can.model && <div className="field">
              <label className="field-label" htmlFor="new-session-model">{t("Model")}</label>
              <input
                id="new-session-model"
                className="input"
                value={model}
                list={suggestions.length > 0 ? "new-session-models" : undefined}
                disabled={fieldsDisabled}
                autoComplete="off"
                autoCapitalize="off"
                spellCheck={false}
                placeholder={t("Agent default")}
                aria-invalid={fault === "model" || undefined}
                aria-describedby="new-session-model-hint"
                onChange={(event) => setModel(event.target.value)}
              />
              {suggestions.length > 0 && <datalist id="new-session-models">{suggestions.map((alias) => <option key={alias} value={alias} />)}</datalist>}
              <span id="new-session-model-hint" className={`field-hint${fault === "model" ? " new-session-error" : ""}`} role={fault === "model" ? "alert" : undefined}>
                {fault === "model" ? t("One model name, without spaces.") : t("Empty: the agent's own model.")}
              </span>
            </div>}
            {can.efforts.length > 0 && <div className="field">
              <label className="field-label" htmlFor="new-session-effort">{t("Effort")}</label>
              <select id="new-session-effort" className="select" value={effort} disabled={fieldsDisabled} aria-describedby="new-session-effort-hint" onChange={(event) => setEffort(event.target.value)}>
                <option value="">{t("Agent default")}</option>
                {can.efforts.map((level) => <option key={level} value={level}>{level}</option>)}
              </select>
              <span id="new-session-effort-hint" className="field-hint">{t("Levels depend on the model.")}</span>
            </div>}
          </div>}
          {/* Claude Code's own term, a setting beside the level rather than one of them, on one line under Model and
              Effort; the whole sentence is the switch's description and the line's tooltip; off adds nothing */}
          {can.ultracode && <div className="new-session-ultracode" title={t("Dynamic workflows at any effort level. Needs Claude Code 2.1.284 or later.")}>
            <Toggle id="new-session-ultracode" checked={ultracode} label={t("Ultracode")} disabled={fieldsDisabled} describedBy="new-session-ultracode-hint" onChange={setUltracode} />
            <label className="new-session-ultracode-label" htmlFor="new-session-ultracode">{t("Ultracode")}</label>
            <span className="new-session-ultracode-note" aria-hidden="true">{t("Claude Code 2.1.284 or later")}</span>
            <span id="new-session-ultracode-hint" className="visually-hidden">{t("Dynamic workflows at any effort level. Needs Claude Code 2.1.284 or later.")}</span>
          </div>}
          {agentKind !== "" && <div className="field">
            <label className="field-label" htmlFor="new-session-prompt">{t("First message")}</label>
            <textarea
              ref={promptField}
              id="new-session-prompt"
              className="input new-session-prompt"
              value={prompt}
              rows={3}
              maxLength={MAX_COMPOSER_CHARS}
              disabled={fieldsDisabled}
              placeholder={t("Optional")}
              aria-describedby="new-session-prompt-hint"
              onChange={(event) => setPrompt(event.target.value)}
            />
            <span id="new-session-prompt-hint" className="field-hint">{promptHint}</span>
            {/* the agent's skills in the folder, before it runs: a tap puts the skill's token in the message */}
            {skills !== null && (skills.rows.length > 0 || skills.note !== null) && <div className="new-session-skills-field">
              <span className="field-label" id="new-session-skills">{t("Skills")}</span>
              {skills.rows.length > 0 && <div className="new-session-skills" role="group" aria-labelledby="new-session-skills">
                {skills.rows.map((skill) => (
                  <button
                    type="button"
                    key={skillToken(skill)}
                    className="btn new-session-skill-chip"
                    disabled={fieldsDisabled}
                    title={skill.description}
                    aria-label={t("Add {skill} to the message", { skill: skillToken(skill) })}
                    onClick={() => insertSkill(skill)}
                  >
                    {skillToken(skill)}
                  </button>
                ))}
              </div>}
              {skills.note !== null && <span className="field-hint">{skills.note}</span>}
            </div>}
            {skills !== null && skills.rows.length === 0 && skills.note === null && <span className="field-hint">{t("No skills for {agent} in this folder.", { agent: agentLabel })}</span>}
          </div>}
          {pending && <p className="new-session-note" role="status">{pendingLabel}</p>}
          {error && <p className="field-hint new-session-error" role="alert">{error.message}{error.detail !== null && <><br /><code>{error.detail}</code></>}</p>}
        </div>
        <footer className="modal-footer">
          <button type="button" className="btn btn-ghost" disabled={pending} onClick={onClose}>{t("Cancel")}</button>
          <button type="submit" className="btn btn-primary" disabled={pending || refreshing || fault !== null}>{t(pending ? "Starting…" : createdPaneId !== null ? "Open" : "Start")}</button>
        </footer></>}
      </form>
    </div>
  );
}
