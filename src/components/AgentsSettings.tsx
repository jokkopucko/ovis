/**
 * Settings → Agents: the coding agents of the PC open here, one row each (its version, its sign-in
 * as the usage accounts show it, the accounts with their plan limits, how New workspace starts it
 * and herdr's session resume for it), the accounts no agent here signs in to, the agents it can
 * install, and how the plan limits are shown. It took the place of Subscription usage and Agent
 * integrations: every control of those two pages is here.
 */
import { useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { CalendarClock, Check, ChevronDown, ChevronRight, ChevronUp, Compass, Cpu, Eye, EyeOff, Gauge, History, KeyRound, Network, Plus, RotateCw, Shield, ShieldCheck, SquareTerminal, Users, Zap } from "lucide-react";

import type { AgentCatalogRow } from "../../shared/agent-catalog.ts";
import type { AgentIntegration, CLIProxyStatus, ProviderUsage, UsageProviderId } from "../../shared/protocol.ts";
import type { UsageLoginRequest } from "../../shared/usage-login.ts";

/** A sign-in the page follows in its own dialog, hosted at the page's root so no row or list it came from can take it away. */
type FollowedSignIn = Extract<UsageLoginRequest, { provider: "claude" | "codex" }>;
import { agentsPage, signInState, type AgentsPageRow } from "../lib/agentsPage.ts";
import { CLAUDE_EFFORTS, CLAUDE_LAUNCH_MODES, CODEX_EFFORTS, CODEX_LAUNCH_MODES, launchChoiceFault, modelDraftAfterSync, modelSuggestions, type ClaudeLaunchMode, type CodexLaunchMode } from "../lib/agentLaunchMode.ts";
import { ApiError, cliProxyRequest, fetchAgentCatalog } from "../lib/api.ts";
import { copyText } from "../lib/clipboard.ts";
import { useT } from "../lib/i18n.ts";
import { loadIntegrations, outcomeFor, type IntegrationsResult } from "../lib/integrations.ts";
import { useMachineApi, useMachineId } from "../lib/machineContext.tsx";
import { useSettings } from "../lib/settings.ts";
import { openSetupGuide } from "../lib/setupGuide.ts";
import { canSignInAgain, glanceWindow, isHubAccount, meterText, moveInOrder, orderProviders, PROVIDER_MARK, PROVIDER_NAME, usageName, useStatuslineSwitch, useUsage, windowLabel } from "../lib/usage.ts";
import { userErrorMessage, type UserError } from "../lib/userError.ts";
import { AgentMark } from "./AgentMark.tsx";
import { AgentTile } from "./AgentTile.tsx";
import { ConfirmDialog } from "./ConfirmDialog.tsx";
import { Segmented, SettingsBare, SettingsGroup, SettingsQuery, SettingsRow, SettingsSelect, Toggle } from "./SettingsControls.tsx";
import { UsageAccountDialog } from "./UsageAccountDialog.tsx";
import { UsageSignInAgain } from "./UsageLocalLogin.tsx";
import { UsageSignInDialog } from "./UsageSignInDialog.tsx";
import { UsageRemoveAccount, UsageRemovedAccounts } from "./UsageRemoveAccount.tsx";
import "./UsageSettings.css";
import "./AgentsSettings.css";

type Translate = ReturnType<typeof useT>;

export interface AgentsSettingsProps {
  /** a watching device reads the page, but installs, signs in and adds nothing */
  watching: boolean;
  /** an account's sign-in tab opened, on the server's PC */
  onLocalLogin: (paneId: string) => void;
  /** shows a pane of `machineId` in its terminal: the tab an install runs in */
  onOpenPane: (machineId: string, paneId: string) => void;
  /** Settings closes as the setup guide opens */
  onOpenGuide: () => void;
}

function claudeModeName(mode: ClaudeLaunchMode, t: Translate): string {
  return mode === "acceptEdits" ? t("Accept edits") : mode === "auto" ? t("Auto") : mode === "plan" ? t("Plan")
    : mode === "dontAsk" ? t("Don't ask") : mode === "bypassPermissions" ? t("Bypass permissions") : t("Agent default");
}
function codexModeName(mode: CodexLaunchMode, t: Translate): string {
  return mode === "readOnly" ? t("Read only") : mode === "auto" ? t("Auto") : mode === "fullAccess" ? t("Full access") : t("Agent default");
}

/**
 * The model and effort New workspace, New tab and New worktree fill in for a new Claude Code or Codex
 * (lib/agentLaunchMode.ts launchDefaults), each still changeable there. A model is kept once it is a name the
 * agent's `--model` takes; until then the field says why and the last one kept stays.
 */
function LaunchDefaultRows({ agent, model, effort, efforts, onModel, onEffort }: { agent: "claude" | "codex"; model: string; effort: string; efforts: readonly string[]; onModel: (model: string) => void; onEffort: (effort: string) => void }) {
  const t = useT();
  const [draft, setDraft] = useState(model);
  // another device's change shows here, but never over text the reader is still fixing
  useEffect(() => { setDraft((current) => modelDraftAfterSync(agent, current, model)); }, [agent, model]);
  const invalid = launchChoiceFault(agent, { model: draft }) === "model";
  const suggestions = modelSuggestions(agent);
  const modelId = `settings-${agent}-launch-model`;
  const effortId = `settings-${agent}-launch-effort`;
  return <>
    <SettingsRow icon={Cpu} label={t("Model")} htmlFor={modelId} wide reset={agent === "claude" ? ["claudeLaunchModel"] : ["codexLaunchModel"]} resetAlso={{ changed: false, restore: () => setDraft("") }}
      description={t("New workspace and New tab fill it in, still changeable there; New worktree starts the agent on it. Empty: the agent's own model.")}
      condition={invalid ? <span id={`${modelId}-error`} className="settings-condition" role="alert">{t("One model name, without spaces.")}</span> : undefined}>
      <input id={modelId} className="input settings-font-input" value={draft} placeholder={t("Agent default")}
        list={suggestions.length > 0 ? `${modelId}-list` : undefined} aria-invalid={invalid || undefined} aria-describedby={invalid ? `${modelId}-error` : undefined}
        spellCheck={false} autoCapitalize="off" autoCorrect="off" autoComplete="off"
        onChange={(event) => {
          const next = event.target.value;
          setDraft(next);
          if (launchChoiceFault(agent, { model: next }) === null && next.trim() !== model) onModel(next.trim());
        }} />
      {suggestions.length > 0 && <datalist id={`${modelId}-list`}>{suggestions.map((alias) => <option key={alias} value={alias} />)}</datalist>}
    </SettingsRow>
    <SettingsRow icon={Zap} label={t("Effort")} htmlFor={effortId} reset={agent === "claude" ? ["claudeLaunchEffort"] : ["codexLaunchEffort"]} description={t("Filled in the same way. Agent default adds no flag; the levels a model takes depend on the model.")}>
      <SettingsSelect id={effortId} value={effort} onChange={(event) => onEffort(event.target.value)}>
        <option value="">{t("Agent default")}</option>
        {efforts.map((level) => <option key={level} value={level}>{level}</option>)}
      </SettingsSelect>
    </SettingsRow>
  </>;
}

/**
 * The settings that belong to one agent, in its row on this page (and in its own group while Settings is
 * searched): the mode New workspace, New tab and New worktree start Claude Code or Codex in
 * (lib/agentLaunchMode.ts), and the chips its chat's message box can carry. Nothing here writes the agent's
 * own configuration. An agent with none of them shows none.
 */
function AgentOwnRows({ agentId }: { agentId: string }) {
  const { settings, update } = useSettings();
  const t = useT();
  const launch = t("Applies to agents started from New workspace, New tab and New worktree. Agent default adds no flag, so the agent's own configuration decides.");
  switch (agentId) {
    case "claude": return <>
      <SettingsRow icon={ShieldCheck} label={t("Permission mode")} description={launch} htmlFor="settings-claude-launch-mode" reset={["claudeLaunchMode"]}>
        <SettingsSelect id="settings-claude-launch-mode" value={settings.claudeLaunchMode} onChange={(event) => update({ claudeLaunchMode: event.target.value as ClaudeLaunchMode })}>
          {CLAUDE_LAUNCH_MODES.map((mode) => <option key={mode} value={mode}>{claudeModeName(mode, t)}</option>)}
        </SettingsSelect>
      </SettingsRow>
      <LaunchDefaultRows agent="claude" model={settings.claudeLaunchModel} effort={settings.claudeLaunchEffort} efforts={CLAUDE_EFFORTS}
        onModel={(claudeLaunchModel) => update({ claudeLaunchModel })} onEffort={(effort) => update({ claudeLaunchEffort: CLAUDE_EFFORTS.find((level) => level === effort) ?? "" })} />
    </>;
    case "codex": return <>
      <SettingsRow icon={Shield} label={t("Sandbox and approvals")} description={launch} htmlFor="settings-codex-launch-mode" reset={["codexLaunchMode"]}>
        <SettingsSelect id="settings-codex-launch-mode" value={settings.codexLaunchMode} onChange={(event) => update({ codexLaunchMode: event.target.value as CodexLaunchMode })}>
          {CODEX_LAUNCH_MODES.map((mode) => <option key={mode} value={mode}>{codexModeName(mode, t)}</option>)}
        </SettingsSelect>
      </SettingsRow>
      <LaunchDefaultRows agent="codex" model={settings.codexLaunchModel} effort={settings.codexLaunchEffort} efforts={CODEX_EFFORTS}
        onModel={(codexLaunchModel) => update({ codexLaunchModel })} onEffort={(effort) => update({ codexLaunchEffort: CODEX_EFFORTS.find((level) => level === effort) ?? "" })} />
    </>;
    default: return null;
  }
}

/** The agents that have settings of their own, and their names where the PC has no row for them. */
const OWN_NAMES: Readonly<Record<string, string>> = { claude: "Claude Code", codex: "Codex" };
const OWN_ROWS = new Set(Object.keys(OWN_NAMES));

/**
 * herdr's integration for one agent (`integration.list`), read only: installing one writes into the
 * agent's hooks or settings, which this app leaves to the user, so it shows the command to run.
 */
function IntegrationRow({ integration, label }: { integration: AgentIntegration; /** the row's label: the integration's own name, or Session resume inside an agent's row */ label: string }) {
  const t = useT();
  const commandRef = useRef<HTMLElement>(null);
  const [copied, setCopied] = useState(false);
  // the latest Copy owns the label: an earlier press's timer must not clear it early
  const copiedTimer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(copiedTimer.current), []);
  const name = integration.label;
  if (integration.state === "current") {
    return (
      <SettingsRow icon={History} label={label} description={t("Installed")}>
        <Check className="settings-integration-check" aria-hidden="true" />
      </SettingsRow>
    );
  }
  // the label is the name `herdr integration install` takes (antigravity_cli is antigravity-cli)
  const command = `herdr integration install ${name}`;
  const copy = async (): Promise<void> => {
    if (!(await copyText(command, commandRef.current))) return;
    setCopied(true);
    window.clearTimeout(copiedTimer.current);
    copiedTimer.current = window.setTimeout(() => setCopied(false), 1600);
  };
  const state = integration.state === "outdated" ? t("Installed, but older than this herdr: run this to update it") : t("Not installed");
  return (
    <SettingsRow icon={History} label={label} keywords={state} wide condition={<span className="settings-condition">{state}</span>}>
      {/* the command stays in sight on a page without sentences: it is what Copy copies */}
      <span className="settings-integration-action">
        <code ref={commandRef} className="settings-integration-command">{command}</code>
        <button type="button" className="btn" aria-label={t("Copy the command for {name}", { name })} onClick={() => void copy()}>{t(copied ? "Copied" : "Copy")}</button>
      </span>
    </SettingsRow>
  );
}

/** One provider's accounts: whose, where from, its plan limit, its state; moved, hidden, or signed in again. */
function ProviderAccounts({ id, providers, removed, onLocalLogin, onFollow }: { readonly id: UsageProviderId; readonly providers: readonly ProviderUsage[]; /** every provider's accounts removed from Ovis */ readonly removed: readonly ProviderUsage[]; readonly onLocalLogin: ((paneId: string) => void) | undefined; readonly onFollow: (request: FollowedSignIn) => void }) {
  const { settings, update } = useSettings();
  const t = useT();
  const all = orderProviders(providers, settings.usageOrder);
  const ordered = all.filter((usage) => usage.id === id);
  const move = (key: string, by: -1 | 1) => {
    const group = moveInOrder(ordered.map((usage) => usage.key), [], key, by);
    let index = 0;
    const keys = all.map((usage) => usage.id === id ? group[index++] ?? usage.key : usage.key);
    update({ usageOrder: [...keys, ...settings.usageOrder.filter((known) => !keys.includes(known))] });
  };
  const restorable = onLocalLogin ? removed.filter((usage) => usage.id === id) : [];
  return <>{ordered.length === 0 ? <p className="settings-item settings-hint">{t("No accounts signed in")}</p> : <ol className="agents-accounts" aria-label={PROVIDER_NAME[id]}>
    {ordered.map((usage, index) => {
      const name = usageName(usage);
      const hidden = settings.usageHidden.includes(usage.key);
      const status = usage.problem === null ? t("Signed in") : {
        expired: t("Expired"), failed: t("Failed"), rate_limited: t("Failed"), locked: t("Failed"),
      }[usage.problem];
      const limit = glanceWindow(usage, settings.usageGlance);
      return <li key={usage.key} className={`usage-accounts-row${hidden ? " is-hidden" : ""}`}>
        <div className="usage-account-identity">
          <span className="usage-accounts-account" title={usage.account ?? undefined}>{usage.account ?? PROVIDER_NAME[id]}</span>
          <span className="usage-account-meta">
            <span>{isHubAccount(usage) ? t("Hub") : t("This PC")}{usage.plan ? ` · ${usage.plan}` : ""}{limit ? ` · ${windowLabel(limit)} ${meterText(limit, settings.usageCount)}` : ""}</span>
            <span className={`usage-account-status${usage.problem ? " has-problem" : ""}`}>{status}</span>
          </span>
          {onLocalLogin && canSignInAgain(usage) && <UsageSignInAgain usage={usage} onStarted={onLocalLogin} onFollow={onFollow} />}
        </div>
        <span className="usage-accounts-actions">
          <button type="button" className="icon-button" aria-label={t("Move {name} up", { name })} disabled={index === 0} onClick={() => move(usage.key, -1)}><ChevronUp aria-hidden="true" /></button>
          <button type="button" className="icon-button" aria-label={t("Move {name} down", { name })} disabled={index === ordered.length - 1} onClick={() => move(usage.key, 1)}><ChevronDown aria-hidden="true" /></button>
          <button type="button" className="icon-button usage-accounts-visibility" role="switch" aria-checked={!hidden} aria-label={t("Show {name}", { name })}
            onClick={() => update({ usageHidden: hidden ? settings.usageHidden.filter((key) => key !== usage.key) : [...settings.usageHidden, usage.key] })}>
            {hidden ? <EyeOff aria-hidden="true" /> : <Eye aria-hidden="true" />}
          </button>
          {onLocalLogin && !isHubAccount(usage) && <UsageRemoveAccount usage={usage} />}
        </span>
      </li>;
    })}
  </ol>}
  <UsageRemovedAccounts removed={restorable} />
  </>;
}

/** The line under an agent's name: its sign-in as the accounts show it, or only that it is there. */
function stateLine(entry: AgentsPageRow, read: boolean, t: Translate): { text: string; tone: "ok" | "warn" | "none" | "dim" } {
  const state = signInState(entry.provider, entry.accounts, read, entry.missing);
  switch (state.kind) {
    case "unknown": return { text: t("Installed"), tone: "dim" };
    case "none": return { text: t("Not signed in"), tone: "none" };
    case "unreadable": return { text: t("Sign-in unreadable: {command} is not installed", { command: state.command }), tone: "warn" };
    case "signed-in": return { text: state.count > 1 ? t("Signed in · {count} accounts", { count: state.count }) : state.account ? t("Signed in · {account}", { account: state.account }) : t("Signed in"), tone: "ok" };
    case "problem": return { text: state.count === 1 ? t("Its account needs attention") : t("{count} accounts · {problems} need attention", { count: state.count, problems: state.problems }), tone: "warn" };
    default: { const unexpected: never = state; throw new Error(String(unexpected)); }
  }
}

function AgentItem({ entry, open, onToggle, allProviders, removed, read, limitsOn, local, watching, integrationsRead, onLocalLogin, onAddAccount, onFollow }: {
  entry: AgentsPageRow;
  open: boolean;
  onToggle: () => void;
  /** every provider's accounts: a move within this row keeps the others' places in the saved order */
  allProviders: readonly ProviderUsage[];
  /** the accounts removed from Ovis, for Restore */
  removed: readonly ProviderUsage[];
  /** plan limits are on and a usage report arrived: the accounts were read */
  read: boolean;
  /** plan limits are on: a report is coming */
  limitsOn: boolean;
  /** the PC shown is the server's, where the accounts are read */
  local: boolean;
  watching: boolean;
  /** herdr's integrations were read for this PC: a row without one has none */
  integrationsRead: boolean;
  onLocalLogin: (paneId: string) => void;
  onAddAccount: (provider: UsageProviderId) => void;
  /** a sign-in followed in the browser: Claude Code's or Codex's first one, or signing an account in again */
  onFollow: (request: FollowedSignIn) => void;
}) {
  const t = useT();
  const { agent, provider, accounts } = entry;
  const line = stateLine(entry, read, t);
  const again = read && !watching ? accounts.filter(canSignInAgain) : [];
  const detailsId = `agents-details-${agent.id}`;
  // the one sign-in it lacks is a tap away while the row is shut; open, the list below has its own
  // without the command it is read with, a sign-in would not show here either: the note says what to install instead
  const action = open || watching || !read || provider === null || (entry.missing !== null && accounts.length === 0) ? null
    : again.length === 1 ? <UsageSignInAgain usage={again[0]!} onStarted={onLocalLogin} onFollow={onFollow} />
      : accounts.length === 0 ? <button type="button" className="btn agents-row-action" aria-label={t("Sign in to {agent}", { agent: agent.name })} onClick={() => provider === "claude" || provider === "codex" ? onFollow({ provider, default: true }) : onAddAccount(provider)}><KeyRound aria-hidden="true" /><span className="agents-row-action-label">{t("Sign in")}</span></button>
        : null;
  const signIn = agent.sign_in;
  const { settings } = useSettings();
  // T3 Code's provider row: what New tab starts it with, on the row itself
  const launch = agent.id === "claude" ? [settings.claudeLaunchModel, settings.claudeLaunchEffort] : agent.id === "codex" ? [settings.codexLaunchModel, settings.codexLaunchEffort] : null;
  const defaults = launch === null ? null : launch.some((value) => value !== "") ? launch.map((value) => value || t("Agent default")).join(" · ") : t("Agent default");
  return (
    <li className="agents-item" data-agent={agent.id} data-section={provider === null ? undefined : `accounts-${provider}`} tabIndex={provider === null ? undefined : -1}>
      <div className="agents-summary" onClick={(event) => { if (!(event.target as Element).closest(".agents-row-action, .usage-sign-in-again, .agents-toggle")) onToggle(); }}>
        <button type="button" className="agents-toggle" aria-expanded={open} aria-controls={open ? detailsId : undefined} onClick={onToggle}>
          <AgentMark agent={agent.id} size={22} />
          <span className="agents-summary-text">
            <span className="agents-summary-name"><span className="settings-label">{agent.name}</span>{agent.state.version !== null && <span className="agents-version">{agent.state.version}</span>}</span>
            <span className={`agents-state is-${line.tone}`}>{line.text}</span>
          </span>
        </button>
        {defaults !== null && <span className="agents-defaults">{defaults}</span>}
        {action}
        <ChevronDown className="agents-chevron" aria-hidden="true" />
      </div>
      {open && <div className="agents-details" id={detailsId}>
        {agent.state.meets_min_version === false && agent.min_version !== null && <p className="agents-detail-note settings-condition">{t("Ovis needs {version} or later.", { version: agent.min_version.version })}</p>}
        {provider !== null && (read ? <>
          {entry.missing !== null && <p className="agents-detail-note settings-condition" role="status">{t("Ovis reads {agent}'s sign-in from the desktop keyring with {command}, which this PC does not have. Install it (the libsecret-tools package on Debian and Ubuntu, libsecret on Fedora and Arch), then open this page again.", { agent: agent.name, command: entry.missing })}</p>}
          <div className="agents-detail-head">
            <span>{t("Accounts")} <span className="usage-account-count">{accounts.length}</span></span>
            {!watching && <button type="button" className="btn btn-ghost" onClick={() => onAddAccount(provider)}><Plus aria-hidden="true" />{t("Add account")}</button>}
          </div>
          {/* with the sign-in unreadable, "No accounts signed in" would be the guess the note replaces */}
          {(entry.missing === null || accounts.length > 0) && <ProviderAccounts id={provider} providers={allProviders} removed={removed} onLocalLogin={watching ? undefined : onLocalLogin} onFollow={onFollow} />}
        </> : <p className="agents-detail-note" role="status">{limitsOn ? t("Loading…") : t("Turn on plan limits to see accounts.")}</p>)}
        {provider === null && signIn !== null && (local && signIn.provider === null
          ? <p className="agents-detail-note">{signIn.in_agent !== null ? t("{agent} signs in inside the agent ({how}). Ovis cannot read that sign-in, so it shows none here.", { agent: agent.name, how: signIn.in_agent }) : t("Ovis cannot read {agent}'s sign-in, so it shows none here.", { agent: agent.name })}</p>
          : !local && signIn.provider !== null ? <p className="agents-detail-note">{t("Accounts are read on the PC Ovis runs on: they are under Other accounts.")}</p> : null)}
        {OWN_ROWS.has(agent.id) && <div className="settings-card agents-detail-card"><AgentOwnRows agentId={agent.id} /></div>}
        {entry.integration !== null
          ? <div className="settings-card agents-detail-card"><IntegrationRow integration={entry.integration} label={t("Session resume")} /></div>
          : integrationsRead && <p className="agents-detail-note">{t("herdr has no session resume for {agent}.", { agent: agent.name })}</p>}
      </div>}
    </li>
  );
}

/** Plan limits: whether they are shown, and how. The status-line switch is Claude's, for networks that refuse its usage API. */
function PlanLimits({ watching }: { watching: boolean }) {
  const { settings, update } = useSettings();
  const t = useT();
  const statusline = useStatuslineSwitch(settings.showUsage);
  // one row: off, or on and counted one way
  return (
    <SettingsGroup section="plan-limits" className="agents-limits">
      <SettingsRow icon={Gauge} label={t("Plan limits")}
        condition={<span className="settings-condition">{t("Shows plan usage beside Settings. Sign-ins are sent to each provider's usage API; never refreshed here.")}</span>} keywords={`${t("Show plan limits")} ${t("Meters show")} ${t("Shows plan usage beside Settings. Sign-ins are sent to each provider's usage API; never refreshed here.")}`} wide reset={settings.showUsage ? ["showUsage", "usageCount"] : ["showUsage"]}>
        <Segmented label={t("Plan limits")} value={settings.showUsage ? settings.usageCount : "off"} onChange={(shown) => update(shown === "off" ? { showUsage: false } : { showUsage: true, usageCount: shown })} options={[{ value: "off", label: t("Off") }, { value: "used", label: t("Used") }, { value: "left", label: t("Remaining") }] as const} />
      </SettingsRow>
      {settings.showUsage && <>
        <SettingsRow icon={CalendarClock} label={t("Limit shown")} description={t("Session is the 5-hour limit. Without it, the closest limit is shown.")} wide reset={["usageGlance"]}>
          <Segmented label={t("Limit shown")} value={settings.usageGlance} onChange={(usageGlance) => update({ usageGlance })} options={[{ value: "week", label: t("Weekly") }, { value: "session", label: t("Session") }]} />
        </SettingsRow>
        {statusline.state?.supported && <SettingsRow icon={SquareTerminal} label={t("Read Claude's limits from its status line")}
          description={t("For networks where Claude's usage API is refused. Wraps Claude Code's status line on this PC and keeps only the limits; turning it off puts Claude's settings back.")}>
          <Toggle label={t("Read Claude's limits from its status line")} checked={statusline.state.installed} disabled={statusline.busy || watching}
            onChange={(enabled) => void statusline.set(enabled)} />
        </SettingsRow>}
        {statusline.error && <p className="settings-hint account-error" role="alert">{statusline.error}</p>}
      </>}
    </SettingsGroup>
  );
}

/** A section's actions, at its top right: the page has no group captions (SettingsBare). */
function SectionHead({ children }: { children?: ReactNode }) {
  return <div className="agents-head">{children}</div>;
}

export function AgentsSettings({ watching, onLocalLogin, onOpenPane, onOpenGuide }: AgentsSettingsProps) {
  const t = useT();
  const { settings } = useSettings();
  // a search finds an agent's own settings in a group of its own, as its row is shut
  const searching = useContext(SettingsQuery).length > 0;
  const api = useMachineApi();
  const machineId = useMachineId();
  // the accounts are read on the PC Ovis's server runs on: they are this PC's only when it is shown
  const local = machineId === "local";

  // the PC's catalog: each Check again, and each install that finished, reads it again
  const [catalog, setCatalog] = useState<{ machineId: string; agents: AgentCatalogRow[] } | null>(null);
  const [catalogError, setCatalogError] = useState<UserError | null>(null);
  const [reads, setReads] = useState(0);
  // why a tile's install did not finish, by agent; a tile that runs again or is done clears its own
  const [failures, setFailures] = useState<Readonly<Record<string, string>>>({});
  const checkAgain = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const abort = new AbortController();
    setCatalogError(null);
    fetchAgentCatalog(machineId, abort.signal).then(
      (answer) => setCatalog({ machineId, agents: answer.agents }),
      (reason: unknown) => {
        if (abort.signal.aborted) return;
        // a PC on an Ovis from before the catalog answers 404 for it
        setCatalogError(reason instanceof ApiError && reason.status === 404 ? { message: t("This PC's Ovis cannot install agents yet. Update it, then try again."), detail: null } : userErrorMessage(reason));
      },
    );
    return () => abort.abort();
  }, [machineId, reads, t]);
  // an install that finished moves its agent up to On this PC: the focus its own tile had goes to Check again
  const finished = (agent: string): void => {
    const at = document.activeElement;
    const lost = at === null || at === document.body || at.closest("li")?.querySelector(`[data-agent="${CSS.escape(agent)}"]`) != null;
    setReads((count) => count + 1);
    if (lost) checkAgain.current?.focus();
  };

  const [integrations, setIntegrations] = useState<IntegrationsResult | null>(null);
  useEffect(() => {
    let live = true;
    void loadIntegrations(api.fetchIntegrations).then((outcome) => { if (live) setIntegrations({ machineId, outcome }); });
    return () => { live = false; };
  }, [api, machineId]);
  const integrationOutcome = outcomeFor(integrations, machineId);

  // the existing switch still decides whether sign-ins are sent to usage endpoints
  const usage = useUsage(settings.showUsage);
  const [hub, setHub] = useState<CLIProxyStatus | null>(null);
  const [hubError, setHubError] = useState<string | null>(null);
  const [dialog, setDialog] = useState<{ kind: "add"; provider: UsageProviderId | null } | { kind: "hub" } | null>(null);
  const [confirmRemoval, setConfirmRemoval] = useState(false);
  const [signingIn, setSigningIn] = useState<FollowedSignIn | null>(null);
  const addButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const controller = new AbortController();
    void cliProxyRequest<CLIProxyStatus>("", { signal: controller.signal }).then(setHub)
      .catch((cause: unknown) => { if (!controller.signal.aborted) setHubError(cause instanceof Error ? cause.message : t("Hub request failed")); });
    return () => controller.abort();
  }, [t]);
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const toggle = (id: string): void => setOpen((current) => {
    const next = new Set(current);
    if (!next.delete(id)) next.add(id);
    return next;
  });

  const agents = catalog !== null && catalog.machineId === machineId ? catalog.agents : null;
  const providers = settings.showUsage ? usage.report?.providers ?? [] : [];
  const page = agents === null && catalogError === null ? null : agentsPage({ agents: agents ?? [], providers, missing: settings.showUsage ? usage.report?.missing_commands ?? [] : [], integrations: integrationOutcome?.kind === "list" ? integrationOutcome.integrations : [], accountsHere: local });
  const removed = settings.showUsage ? usage.report?.removed ?? [] : [];
  const ownGroups = searching ? [...OWN_ROWS]
    : page === null ? (catalogError === null ? [] : [...OWN_ROWS])
      : [...OWN_ROWS].filter((id) => !page.rows.some((entry) => entry.agent.id === id));
  // a provider whose every account was removed keeps its group, for Restore
  const otherProviders = [...new Set([...(page?.otherProviders ?? providers.map((entry) => entry.id)),
    ...removed.map((entry) => entry.id).filter((id) => !page?.rows.some((row) => row.provider === id))])];
  const failed = Object.values(failures);
  const integrationNote = integrationOutcome === null ? null
    : integrationOutcome.kind === "unsupported" ? <p className="settings-hint agents-note" role="status">{t("This PC's bridge does not offer agent integrations yet. It will after its next runtime update.")}</p>
      : integrationOutcome.kind === "error" ? <p className="settings-hint agents-note" role="alert">{integrationOutcome.message}</p> : null;

  const otherIntegrations = page?.otherIntegrations ?? [];
  return (
    <SettingsBare.Provider value={true}>
      {/* the first-run guide again (lib/setupGuide.ts): it sets up this PC, and a watching device is never shown it */}
      {!watching && local && <SettingsGroup section="guide">
        <SettingsRow icon={Compass} label={t("Setup guide")}>
          <button type="button" className="btn" onClick={() => { onOpenGuide(); openSetupGuide(); }}>{t("Open setup guide")}</button>
        </SettingsRow>
      </SettingsGroup>}

      <section className="settings-section" data-section="agents-installed" tabIndex={-1} aria-label={t("On this PC")}>
        <SectionHead>
          <button type="button" ref={checkAgain} className="btn btn-ghost" onClick={() => setReads((count) => count + 1)}><RotateCw aria-hidden="true" />{t("Check again")}</button>
        </SectionHead>
        {/* a failed read, the first or a Check again: the rows the last good one gave stay, with the error beside them */}
        {catalogError !== null && <p className="settings-hint agents-note" role="alert">{catalogError.message}{catalogError.detail !== null && <><br /><code>{catalogError.detail}</code></>}</p>}
        {agents === null ? catalogError === null && <div className="settings-card"><p className="settings-item settings-hint" role="status">{t("Loading…")}</p></div>
          : page === null ? null
            : page.rows.length === 0 ? <div className="settings-card"><p className="settings-item settings-hint">{page.installsUnknown ? t("Ovis cannot tell which agents this PC has. Install them from a terminal on it.") : t("None on this PC yet.")}</p></div>
              : <ul className="settings-card agents-card">
                {page.rows.map((entry) => <AgentItem key={entry.agent.id} entry={entry} open={open.has(entry.agent.id)} onToggle={() => toggle(entry.agent.id)}
                  allProviders={providers} removed={removed} read={settings.showUsage && usage.report !== null} limitsOn={settings.showUsage} local={local} watching={watching} integrationsRead={integrationOutcome?.kind === "list"}
                  onLocalLogin={onLocalLogin} onAddAccount={(provider) => setDialog({ kind: "add", provider })} onFollow={setSigningIn} />)}
              </ul>}
        {integrationNote}
      </section>

      {/* the settings live on this device and start the agent on any PC: one the PC shown has no row for (not
          installed, or its catalog unread) keeps its own group, and a search finds every one in a group */}
      {/* outside an agent's row, its rows need its name over them: Model and Effort are alike for every agent */}
      <SettingsBare.Provider value="rows">
        {ownGroups.map((id) => <SettingsGroup key={id} title={OWN_NAMES[id]!} section={`agent-${id}`}>
          <AgentOwnRows agentId={id} />
        </SettingsGroup>)}
      </SettingsBare.Provider>

      {/* herdr's integrations for agents without a row above, read only: found ones first, then the ones this PC lacks (each a link's section) */}
      {otherIntegrations.length > 0 && <details className="settings-section agents-more" data-section="integrations" tabIndex={-1} open={searching || undefined}>
        <summary className="agents-more-toggle"><ChevronRight className="agents-more-chevron" aria-hidden="true" />{t("Other agents herdr knows ({count})", { count: otherIntegrations.length })}</summary>
        {[otherIntegrations.filter((integration) => integration.available), otherIntegrations.filter((integration) => !integration.available)].map((rows, index) => rows.length > 0 &&
          <div key={index} className="settings-card agents-integrations" data-section={index === 1 ? "integrations-missing" : undefined} tabIndex={index === 1 ? -1 : undefined}>
            {rows.map((integration) => <IntegrationRow key={integration.target} integration={integration} label={integration.label} />)}
          </div>)}
      </details>}

      <section className="settings-section" data-section="other-accounts" tabIndex={-1} aria-label={t("Other accounts")}>
        <SettingsGroup>
          <SettingsRow icon={Users} label={t("Other accounts")}
            condition={!settings.showUsage ? <span className="settings-condition">{t("Turn on plan limits to see accounts.")}</span> : !local ? <span className="settings-condition">{t("Accounts are read on the PC Ovis runs on.")}</span> : undefined}>
            {!watching ? <button ref={addButton} className="btn btn-ghost" type="button" onClick={() => setDialog({ kind: "add", provider: null })}><Plus aria-hidden="true" />{t("Add account")}</button> : <span />}
          </SettingsRow>
        </SettingsGroup>
        {settings.showUsage && otherProviders.map((id) => <SettingsGroup key={id} className="usage-accounts usage-provider" section={page === null ? undefined : `accounts-${id}`}>
          <div className="settings-item usage-provider-heading">
            <AgentMark agent={PROVIDER_MARK[id]} size={20} /><span>{PROVIDER_NAME[id]}</span>
            <span className="usage-account-count">{providers.filter((entry) => entry.id === id).length}</span>
          </div>
          <ProviderAccounts id={id} providers={providers} removed={removed} onLocalLogin={watching ? undefined : onLocalLogin} onFollow={setSigningIn} />
        </SettingsGroup>)}
        {settings.showUsage && providers.length === 0 && <p className="settings-note settings-hint">{usage.loading ? t("Loading…") : t("No accounts yet.")}</p>}
        {hubError && <p className="settings-hint account-error" role="alert">{hubError}</p>}
        {hub?.configured && <SettingsGroup className="usage-connection-card" section="usage-connection">
          <div className="settings-item usage-connection">
            <Network size={20} aria-hidden="true" />
            <div className="usage-connection-info"><span className="settings-label">{t("Hub")}</span><span className="settings-hint" role="status">{hub.url} · {hub.ok ? t("Connected") : hub.problem ?? t("Check the hub connection")}</span></div>
            {!watching && <div className="usage-connection-actions">
              <button className="btn btn-ghost" type="button" onClick={() => setDialog({ kind: "hub" })}>{t("Edit")}</button>
              <button className="btn btn-ghost" type="button" onClick={() => setConfirmRemoval(true)}>{t("Remove")}</button>
            </div>}
          </div>
        </SettingsGroup>}
      </section>

      {!watching && page !== null && page.installable.length > 0 && <details className="settings-section agents-more" data-section="install">
        <summary className="agents-more-toggle"><ChevronRight className="agents-more-chevron" aria-hidden="true" />{t("Install another agent ({count})", { count: page.installable.length })}</summary>
        <ul className="setup-found settings-agent-tiles">
          {page.installable.map((agent) => (
            <AgentTile key={`${machineId}:${agent.id}`} agent={agent} has={false} machineId={machineId}
              onOpenTerminal={(paneId) => onOpenPane(machineId, paneId)}
              onInstalled={finished}
              onError={(id, message) => setFailures((current) => {
                const { [id]: _gone, ...rest } = current;
                return message === null ? rest : { ...rest, [id]: message };
              })} />
          ))}
        </ul>
        {failed.length > 0 && <p className="settings-hint settings-agent-error" role="alert">{failed.join(" ")}</p>}
      </details>}

      <PlanLimits watching={watching} />

      {confirmRemoval && <ConfirmDialog title={t("Remove hub?")}
        body={t("Its accounts disappear from this list. The hub itself is not changed.")}
        confirmLabel={t("Remove")} onClose={() => setConfirmRemoval(false)} onConfirm={async () => {
          const status = await cliProxyRequest<CLIProxyStatus>("", { method: "DELETE" });
          setHub(status); setConfirmRemoval(false); usage.refresh();
          requestAnimationFrame(() => addButton.current?.focus());
        }} />}
      {signingIn && <UsageSignInDialog request={signingIn} onOpenTerminal={(paneId) => { setSigningIn(null); onLocalLogin(paneId); }} onSignedIn={usage.refresh} onClose={() => setSigningIn(null)} />}
      {dialog && <UsageAccountDialog editHub={dialog.kind === "hub"} provider={dialog.kind === "add" ? dialog.provider : null} hub={hub} onHubChanged={setHub} onAccountsChanged={usage.refresh} onLocalLogin={onLocalLogin} onClose={() => setDialog(null)} />}
    </SettingsBare.Provider>
  );
}
