/**
 * A git worktree from a workspace's row menu, as herdr's own prefix+shift+g makes one. "create"
 * asks for the branch and checks it out under herdr's worktree folder, with a branch and a name
 * already filled in the way herdr's own form fills them, and the agent to start in the checkout
 * (the one the last creation dialog started; Shell starts none); "open" lists the repository's checkouts. Either way the checkout becomes a workspace grouped with this one,
 * and its pane is selected. Escape and the scrim close the dialog, Tab stays inside it, and
 * focus goes back to the ⋯ afterwards. A checkout git has lost (prunable) is listed but not offered.
 */
import { useEffect, useId, useLayoutEffect, useRef, useState, type FormEvent, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent } from "react";
import { createPortal } from "react-dom";
import { GitBranch, X } from "lucide-react";

import "./WorktreeDialog.css";

import type { AgentKind, WorkspaceInfo, WorktreeEntry, WorktreeOpened } from "../../shared/protocol.ts";
import { MAX_LABEL_CHARS } from "../../shared/labels.ts";
import { ApiError } from "../lib/api.ts";
import { AddAgentPanel } from "./AddAgentPanel.tsx";
import { AgentPicker, rememberAgent, rememberedAgent } from "./AgentPicker.tsx";
import { useMachineApi } from "../lib/machineContext.tsx";
import { useT } from "../lib/i18n.ts";
import { latestRead, READ_AGAIN_MS, READ_AGAIN_TIMES, readAgainUntil } from "../lib/latestRead.ts";
import { useSettings } from "../lib/settings.ts";
import { launchAgent } from "../lib/agentLaunchMode.ts";
import { suggestWorktreeBranch, worktreeLabel } from "../lib/worktreeName.ts";
import { useSheetSwipe } from "../lib/sheets.ts";
import { usePhoneSheetBack } from "../lib/sheetHistory.ts";

export type WorktreeDialogMode = "create" | "open";

interface Props {
  mode: WorktreeDialogMode;
  workspace: WorkspaceInfo;
  onClose: () => void;
  onOpened: (opened: WorktreeOpened) => void;
  /** shows a pane of this PC in its terminal: an agent's install or sign-in tab, from Add another agent */
  onOpenPane?: (paneId: string) => void;
}

/** herdr's own words about a refused worktree (a branch that exists, a folder that is no repository) */
const said = (reason: unknown): string => reason instanceof ApiError ? reason.detail : reason instanceof Error ? reason.message : String(reason);

export function WorktreeDialog({ mode, workspace, onClose, onOpened, onOpenPane }: Props) {
  const t = useT();
  const { settings } = useSettings();
  const id = useId();
  const { createWorktree, fetchAgentKinds, listWorktrees, openWorktree } = useMachineApi();
  const [agents, setAgents] = useState<AgentKind[]>([]);
  const [agentKind, setAgentKind] = useState(rememberedAgent);
  // the checkout whose agent did not start: it is there, and the button opens it
  const [made, setMade] = useState<WorktreeOpened | null>(null);
  const [branch, setBranch] = useState(suggestWorktreeBranch);
  const [base, setBase] = useState("");
  // null: the name is the branch's until it is typed over
  const [typedLabel, setTypedLabel] = useState<string | null>(null);
  const label = typedLabel ?? worktreeLabel(branch);
  const [entries, setEntries] = useState<WorktreeEntry[] | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Add another agent shows in place of the fields, which keep what was typed
  const [adding, setAdding] = useState(false);
  // the PC's agents read again after a setup: nothing is created until the picker shows the result
  const [refreshing, setRefreshing] = useState(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const first = useRef<HTMLInputElement>(null);
  const surface = useRef<HTMLFormElement>(null);
  const picker = useRef<HTMLButtonElement>(null);
  useSheetSwipe(surface, pending ? null : onClose);
  usePhoneSheetBack(() => { if (pending) return false; onClose(); });
  const opener = useRef<HTMLElement | null>(null);

  useLayoutEffect(() => {
    opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    return () => { if (opener.current?.isConnected) opener.current.focus({ preventScroll: true }); };
  }, []);
  useEffect(() => {
    window.requestAnimationFrame(() => {
      (first.current ?? surface.current?.querySelector<HTMLElement>(".worktree-row, .btn"))?.focus();
      // the suggested branch is selected, so typing a branch replaces it
      first.current?.select();
    });
  }, [mode, entries]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      // another overlay (the palette) over this one owns the keyboard, and Escape, until it goes
      const active = document.activeElement;
      if (active && active !== document.body && !surface.current?.contains(active)) return;
      // the agent picker's open list takes this Escape, wherever the focus is: it closes the list, not the dialog
      if (picker.current?.getAttribute("aria-expanded") === "true") return;
      event.stopPropagation();
      event.preventDefault();
      if (!pending) onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose, pending]);
  useEffect(() => {
    if (mode !== "create") return;
    let cancelled = false;
    const latest = agentReads.current();
    fetchAgentKinds().then(
      (next) => {
        if (cancelled || !latest()) return;
        setAgents(next);
        // a remembered agent this PC cannot start falls back to a shell
        setAgentKind((kind) => (kind && !next.some((agent) => agent.kind === kind) ? "" : kind));
      },
      (reason: unknown) => { if (!cancelled && latest()) setError(said(reason)); },
    );
    return () => { cancelled = true; };
  }, [mode, fetchAgentKinds]);
  useEffect(() => {
    if (mode !== "open") return;
    let cancelled = false;
    listWorktrees(workspace.workspace_id).then(
      (listing) => { if (!cancelled) setEntries(listing.worktrees); },
      (reason: unknown) => { if (!cancelled) setError(said(reason)); },
    );
    return () => { cancelled = true; };
  }, [mode, workspace.workspace_id, listWorktrees]);

  // back from Add another agent, the focus returns to the picker it was opened from
  const wasAdding = useRef(false);
  // (after a setup, once the refreshed picker is enabled again)
  useEffect(() => {
    if (adding) { wasAdding.current = true; return; }
    if (wasAdding.current && !refreshing) { wasAdding.current = false; picker.current?.focus(); }
  }, [adding, refreshing]);
  // the agent list as read last: the read as the dialog opened may answer after the one an install asked for
  const agentReads = useRef(latestRead());
  // the installed agent is offered once the PC lists it: picked then. Its installer may still be
  // editing the shell profile: until then the dialog says why and reads again (lib/latestRead.ts)
  const readingAgain = useRef<() => void>(() => undefined);
  useEffect(() => () => readingAgain.current(), []);
  const addedAgent = (kind: string): void => {
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
        if (!mounted.current) return true;
        if (outcome.kind === "answer") {
          setAgents(outcome.value);
          if (outcome.value.some((agent) => agent.kind === kind)) { setAgentKind(kind); setError(null); setRefreshing(false); return true; }
        }
        if (!last) { setError(t("It is installed. Waiting for this PC to offer it here…")); return false; }
        if (outcome.kind === "failed") setError(said(outcome.reason));
        else setError(t("It is installed, but this PC does not offer it here yet. Restart Ovis on the PC, or start it in a terminal tab."));
        setRefreshing(false);
        return true;
      },
    });
  };

  const run = async (status: string, request: () => Promise<WorktreeOpened>): Promise<void> => {
    if (pending) return;
    setPending(status);
    setError(null);
    try {
      const result = await request();
      if (result.agent_started === false && result.error) {
        setMade(result);
        setError(result.error.message);
        setPending(null);
        return;
      }
      onOpened(result);
    } catch (reason: unknown) {
      setError(reason instanceof ApiError && reason.code === "repository_without_commits" ? t("This repository has no commits yet. Make its first commit, then a worktree.") : said(reason));
      setPending(null);
    }
  };
  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (made) { onOpened(made); return; }
    if (refreshing) return;
    const name = branch.trim();
    if (!name) return;
    void run(t("Creating the checkout…"), async () => {
      const result = await createWorktree({ workspace_id: workspace.workspace_id, branch: name, base: base.trim() || null, label: label.trim() || null, agent: launchAgent(agentKind, settings) });
      // the default follows what actually started: Shell after a plain checkout, an agent only once it runs
      if (!agentKind || result.agent_started === true) rememberAgent(agentKind);
      return result;
    });
  };
  const open = (entry: WorktreeEntry): void => {
    void run(t("Opening…"), () => openWorktree({ workspace_id: workspace.workspace_id, path: entry.path }));
  };
  const closeFromScrim = (event: MouseEvent<HTMLDivElement>): void => {
    if (!pending && event.target === event.currentTarget) onClose();
  };
  // modal: Tab and Shift+Tab stay among the dialog's own fields and buttons
  const onKeyDown = (event: ReactKeyboardEvent<HTMLFormElement>): void => {
    if (event.key !== "Tab" || !surface.current) return;
    const stops = [...surface.current.querySelectorAll<HTMLElement>("input:not(:disabled), button:not(:disabled)")];
    if (stops.length === 0) return;
    const index = stops.indexOf(document.activeElement as HTMLElement);
    const next = event.shiftKey ? (index <= 0 ? stops.length - 1 : index - 1) : (index < 0 || index === stops.length - 1 ? 0 : index + 1);
    event.preventDefault();
    stops[next]?.focus();
  };

  const locked = pending !== null || made !== null || refreshing;
  const title = mode === "create" ? t("New worktree · {name}", { name: workspace.label }) : t("Open worktree · {name}", { name: workspace.label });
  // the repository's own checkout is this workspace: the list is the other ones
  const others = entries?.filter((entry) => entry.open_workspace_id !== workspace.workspace_id) ?? null;

  return createPortal(
    <div className="modal-scrim" onMouseDown={closeFromScrim}>
      <form ref={surface} className="modal worktree-modal" role="dialog" aria-modal="true" aria-labelledby={`${id}-title`} onSubmit={submit} onKeyDown={onKeyDown}>
        <header className="modal-header">
          <h2 className="modal-title" id={`${id}-title`}>{title}</h2>
          <button type="button" className="icon-button" aria-label={t("Close worktree dialog")} disabled={pending !== null} onClick={onClose}>
            <X aria-hidden="true" />
          </button>
        </header>
        {adding ? <div className="modal-body">
          <AddAgentPanel onReady={addedAgent} onOpenTerminal={(paneId) => { if (onOpenPane) onOpenPane(paneId); else onClose(); }} onBack={() => setAdding(false)} />
        </div> : <><div className="modal-body">
          {mode === "create" ? (
            <>
              <p className="worktree-lead">{t("A git worktree of this repository, checked out under herdr's worktree folder and opened as a workspace next to this one.")}</p>
              <label className="field">
                <span className="field-label">{t("Branch")}</span>
                <input ref={first} className="input" value={branch} disabled={locked} required autoComplete="off" spellCheck={false} onChange={(event) => setBranch(event.target.value)} />
                <span className="field-hint">{t("A new branch, or an existing one to check out")}</span>
              </label>
              <label className="field">
                <span className="field-label">{t("Start from")}</span>
                <input className="input" value={base} disabled={locked} autoComplete="off" spellCheck={false} placeholder="HEAD" onChange={(event) => setBase(event.target.value)} />
                <span className="field-hint">{t("A branch, tag or commit; HEAD when empty. Ignored when the branch exists.")}</span>
              </label>
              <label className="field">
                <span className="field-label">{t("Name")}</span>
                <input className="input" value={label} maxLength={MAX_LABEL_CHARS} disabled={locked} autoComplete="off" onChange={(event) => setTypedLabel(event.target.value)} />
                <span className="field-hint">{t("Workspace label; follows the branch until you change it")}</span>
              </label>
              <div className="field">
                <span className="field-label" id={`${id}-agent`}>{t("Agent")}</span>
                <AgentPicker ref={picker} agents={agents} value={agentKind} disabled={locked} labelledBy={`${id}-agent`} addAgent={{ label: t("Add another agent…"), onSelect: () => setAdding(true) }} onChange={setAgentKind} />
              </div>
            </>
          ) : others === null && !error ? (
            <p className="field-hint" role="status">{t("Reading worktrees…")}</p>
          ) : others && others.length === 0 ? (
            <p className="field-hint worktree-empty">{t("No other worktrees of this repository.")}</p>
          ) : others && (
            <ul className="worktree-list">
              {others.map((entry) => (
                <li key={entry.path}>
                  <button type="button" className="worktree-row" disabled={pending !== null || entry.is_prunable} onClick={() => open(entry)}>
                    <GitBranch aria-hidden="true" />
                    <span className="worktree-copy">
                      <span className="worktree-branch">{entry.branch ?? (entry.is_detached ? t("Detached HEAD") : entry.label)}</span>
                      <span className="worktree-path">{entry.path}</span>
                    </span>
                    {entry.open_workspace_id ? <span className="pill">{t("Already open")}</span> : entry.is_prunable && <span className="pill">{t("Checkout missing")}</span>}
                  </button>
                </li>
              ))}
            </ul>
          )}
          {pending && <p className="field-hint" role="status">{pending}</p>}
          {error && <p className="field-hint worktree-error" role="alert">{error}</p>}
        </div>
        <footer className="modal-footer">
          <button type="button" className="btn btn-ghost" disabled={pending !== null} onClick={onClose}>{t("Cancel")}</button>
          {mode === "create" && <button type="submit" className="btn btn-primary" disabled={pending !== null || refreshing || (!made && !branch.trim())}>{t(made ? "Open" : "Create worktree")}</button>}
        </footer></>}
      </form>
    </div>,
    document.body,
  );
}
