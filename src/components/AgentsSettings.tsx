import { Fragment, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { CalendarClock, Check, ChevronDown, ChevronRight, ChevronUp, Compass, Cpu, Eye, EyeOff, Gauge, Globe, History, KeyRound, Network, Plus, RotateCw, Shield, ShieldCheck, SquareTerminal, Users, Zap } from "lucide-react";

import type { AgentCatalogRow } from "../../shared/agent-catalog.ts";
import { BROWSER_TOOL_IDS, BROWSER_TOOLS, browserToolCommand, isBrowserToolAgent, type BrowserToolAgent, type BrowserToolId } from "../../shared/browser-tools.ts";
import type { AgentIntegration, CLIProxyStatus, ProviderUsage, UsageProviderId } from "../../shared/protocol.ts";
import type { UsageLoginRequest } from "../../shared/usage-login.ts";

type FollowedSignIn = Extract<UsageLoginRequest, { provider: "claude" | "codex" }>;
import { agentsPage, signInState, type AgentsPageRow } from "../lib/agentsPage.ts";
import { CLAUDE_EFFORTS, CLAUDE_LAUNCH_MODES, CODEX_EFFORTS, CODEX_LAUNCH_MODES, launchChoiceFault, modelDraftAfterSync, modelSuggestions, type ClaudeLaunchMode, type CodexLaunchMode } from "../lib/agentLaunchMode.ts";
import { ApiError, cliProxyRequest, fetchAgentCatalog } from "../lib/api.ts";
import { copyText } from "../lib/clipboard.ts";
import { useT } from "../lib/i18n.ts";
import { loadIntegrations, outcomeFor, type IntegrationsResult } from "../lib/integrations.ts";
import { lastSeen } from "../lib/lastSeen.ts";
import { useMachineApi, useMachineId } from "../lib/machineContext.tsx";
import { useSettings } from "../lib/settings.ts";
import { openSetupGuide } from "../lib/setupGuide.ts";
import { canSignInAgain, glanceWindow, isHubAccount, isSignIn, meterText, moveInOrder, orderProviders, PROVIDER_MARK, PROVIDER_NAME, recordedBy, recordedNote, usageName, useStatuslineSwitch, useUsage, windowLabel } from "../lib/usage.ts";
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
  onLocalLogin: (paneId: string) => void;
  onOpenPane: (machineId: string, paneId: string) => void;
  onOpenGuide: () => void;
}

function claudeModeName(mode: ClaudeLaunchMode, t: Translate): string {
  return mode === "acceptEdits" ? t("Accept edits") : mode === "auto" ? t("Auto") : mode === "plan" ? t("Plan")
    : mode === "dontAsk" ? t("Don't ask") : mode === "bypassPermissions" ? t("Bypass permissions") : t("Agent default");
}
function codexModeName(mode: CodexLaunchMode, t: Translate): string {
  return mode === "readOnly" ? t("Read only") : mode === "auto" ? t("Auto") : mode === "fullAccess" ? t("Full access") : t("Agent default");
}

function LaunchDefaultRows({ agent, model, effort, efforts, onModel, onEffort }: { agent: "claude" | "codex"; model: string; effort: string; efforts: readonly string[]; onModel: (model: string) => void; onEffort: (effort: string) => void }) {
  const t = useT();
  const [draft, setDraft] = useState(model);
  useEffect(() => { setDraft((current) => modelDraftAfterSync(agent, current, model)); }, [agent, model]);
  const invalid = launchChoiceFault(agent, { model: draft }) === "model";
  const suggestions = modelSuggestions(agent);
  const modelId = `settings-${agent}-launch-model`;
  const effortId = `settings-${agent}-launch-effort`;
  return <>
    <SettingsRow icon={Cpu} label={t("Model")} htmlFor={modelId} wide reset={agent === "claude" ? ["claudeLaunchModel"] : ["codexLaunchModel"]} resetAlso={{ changed: false, restore: () => setDraft("") }}
      description={t("The model a new agent starts with: New workspace and New tab fill it in, still changeable there, and New worktree uses it as is. Empty leaves the choice to the agent, and an agent already running is not changed.")}
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
    <SettingsRow icon={Zap} label={t("Effort")} htmlFor={effortId} reset={agent === "claude" ? ["claudeLaunchEffort"] : ["codexLaunchEffort"]} description={t("How much effort a new agent puts into reasoning, filled in the same way as Model. Agent default leaves it to the agent; which levels work depends on the model.")}>
      <SettingsSelect id={effortId} value={effort} onChange={(event) => onEffort(event.target.value)}>
        <option value="">{t("Agent default")}</option>
        {efforts.map((level) => <option key={level} value={level}>{level}</option>)}
      </SettingsSelect>
    </SettingsRow>
  </>;
}

/**
 * The browser tool this PC's server adds when it starts the agent (shared/browser-tools.ts). The choice is kept on
 * the PC whose page this is, so another PC's agents are not offered it here.
 */
function BrowserToolRow({ agent }: { agent: BrowserToolAgent }) {
  const { settings, update } = useSettings();
  const t = useT();
  const local = useMachineId() === "local";
  if (!local) return null;
  const tool = settings.agentBrowserTools[agent];
  const id = `settings-${agent}-browser-tool`;
  const choose = (next: BrowserToolId | ""): void => {
    const { [agent]: _was, ...rest } = settings.agentBrowserTools;
    update({ agentBrowserTools: next === "" ? rest : { ...rest, [agent]: next } });
  };
  return (
    <SettingsRow icon={Globe} label={t("Browser tool")} htmlFor={id} wide
      description={t("A browser the agent can drive: Ovis adds an MCP server at a fixed version when it starts this agent. That browser uses a profile of its own, without your sign-ins, and Ovis does not watch or limit it. Applies from the next start; an agent started from a terminal is not changed.")}
      condition={tool === undefined ? undefined : <code className="settings-integration-command">{browserToolCommand(tool, "").join(" ")}</code>}>
      <SettingsSelect id={id} value={tool ?? ""} onChange={(event) => choose(BROWSER_TOOL_IDS.find((known) => known === event.target.value) ?? "")}>
        <option value="">{t("None")}</option>
        {BROWSER_TOOL_IDS.map((known) => <option key={known} value={known}>{BROWSER_TOOLS[known].name}</option>)}
      </SettingsSelect>
    </SettingsRow>
  );
}

function AgentOwnRows({ agentId }: { agentId: string }) {
  const { settings, update } = useSettings();
  const t = useT();
  switch (agentId) {
    case "claude": return <>
      <SettingsRow icon={ShieldCheck} label={t("Permission mode")} description={t("The permission mode a new Claude Code starts in when you open it from New workspace, New tab or New worktree. Agent default leaves it to Claude Code's own settings, and a running agent is not changed.")} htmlFor="settings-claude-launch-mode" reset={["claudeLaunchMode"]}>
        <SettingsSelect id="settings-claude-launch-mode" value={settings.claudeLaunchMode} onChange={(event) => update({ claudeLaunchMode: event.target.value as ClaudeLaunchMode })}>
          {CLAUDE_LAUNCH_MODES.map((mode) => <option key={mode} value={mode}>{claudeModeName(mode, t)}</option>)}
        </SettingsSelect>
      </SettingsRow>
      <LaunchDefaultRows agent="claude" model={settings.claudeLaunchModel} effort={settings.claudeLaunchEffort} efforts={CLAUDE_EFFORTS}
        onModel={(claudeLaunchModel) => update({ claudeLaunchModel })} onEffort={(effort) => update({ claudeLaunchEffort: CLAUDE_EFFORTS.find((level) => level === effort) ?? "" })} />
      <BrowserToolRow agent="claude" />
    </>;
    case "codex": return <>
      <SettingsRow icon={Shield} label={t("Sandbox and approvals")} description={t("The sandbox and approval preset a new Codex starts with when you open it from New workspace, New tab or New worktree. Agent default leaves it to Codex's own settings, and a running agent is not changed.")} htmlFor="settings-codex-launch-mode" reset={["codexLaunchMode"]}>
        <SettingsSelect id="settings-codex-launch-mode" value={settings.codexLaunchMode} onChange={(event) => update({ codexLaunchMode: event.target.value as CodexLaunchMode })}>
          {CODEX_LAUNCH_MODES.map((mode) => <option key={mode} value={mode}>{codexModeName(mode, t)}</option>)}
        </SettingsSelect>
      </SettingsRow>
      <LaunchDefaultRows agent="codex" model={settings.codexLaunchModel} effort={settings.codexLaunchEffort} efforts={CODEX_EFFORTS}
        onModel={(codexLaunchModel) => update({ codexLaunchModel })} onEffort={(effort) => update({ codexLaunchEffort: CODEX_EFFORTS.find((level) => level === effort) ?? "" })} />
      <BrowserToolRow agent="codex" />
    </>;
    case "copilot": return <BrowserToolRow agent="copilot" />;
    default: return null;
  }
}

const OWN_NAMES: Readonly<Record<string, string>> = { claude: "Claude Code", codex: "Codex" };
const OWN_ROWS = new Set(Object.keys(OWN_NAMES));

/**
 * herdr's integration for one agent (`integration.list`), read only: installing one writes into the
 * agent's hooks or settings, which this app leaves to the user, so it shows the command to run.
 */
function IntegrationRow({ integration, label }: { integration: AgentIntegration; label: string }) {
  const t = useT();
  const commandRef = useRef<HTMLElement>(null);
  const [copied, setCopied] = useState(false);
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
    <SettingsRow icon={History} label={label} description={t("herdr's own integration for resuming this agent's session. Installing it changes the agent's settings, so Ovis shows the command to run and does not install it itself.")} keywords={state} wide condition={<span className="settings-condition">{state}</span>}>
      <span className="settings-integration-action">
        <code ref={commandRef} className="settings-integration-command">{command}</code>
        <button type="button" className="btn" aria-label={t("Copy the command for {name}", { name })} onClick={() => void copy()}>{t(copied ? "Copied" : "Copy")}</button>
      </span>
    </SettingsRow>
  );
}

function ProviderAccounts({ id, providers, removed, onLocalLogin, onFollow }: { readonly id: UsageProviderId; readonly providers: readonly ProviderUsage[]; readonly removed: readonly ProviderUsage[]; readonly onLocalLogin: ((paneId: string) => void) | undefined; readonly onFollow: (request: FollowedSignIn) => void }) {
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
      // another tool's record is no sign-in Ovis holds: its row names that tool, and its status says how long ago it
      // read, as an old record once the tool stopped.
      const recordOnly = !isSignIn(usage);
      const age = usage.recorded ? [...(usage.recorded.stale ? [t("Old record")] : []), lastSeen(usage.checked_at)] : [];
      const status = recordOnly ? age.join(" · ") : usage.problem === null ? t("Signed in") : {
        expired: t("Expired"), failed: t("Failed"), rate_limited: t("Failed"), locked: t("Failed"),
      }[usage.problem];
      const limit = glanceWindow(usage, settings.usageGlance);
      const facts = [
        recordedBy(usage) ?? (isHubAccount(usage) ? t("Hub") : t("This PC")),
        ...(recordOnly ? [] : age),
        usage.plan,
        limit ? `${windowLabel(limit)} ${meterText(limit, settings.usageCount)}` : null,
      ].filter((fact): fact is string => Boolean(fact));
      return <li key={usage.key} className={`usage-accounts-row${hidden ? " is-hidden" : ""}`}>
        <div className="usage-account-identity">
          <span className="usage-accounts-account" title={usage.account ?? undefined}>{usage.account ?? PROVIDER_NAME[id]}</span>
          <span className="usage-account-meta">
            <span>{facts.map((fact, nth) => <Fragment key={nth}>{nth > 0 && " "}<span className="usage-account-fact">{fact}{nth < facts.length - 1 && " ·"}</span></Fragment>)}</span>
            <span className={`usage-account-status${usage.problem ? " has-problem" : ""}${recordOnly ? " is-recorded" : ""}`} title={recordedNote(usage, Date.now())?.join("\n")}>{status}</span>
          </span>
          {onLocalLogin && canSignInAgain(usage) && <UsageSignInAgain usage={usage} onStarted={onLocalLogin} onFollow={onFollow} />}
        </div>
        <span className="usage-accounts-actions">
          <button type="button" className="icon-button" aria-label={t("Move {name} up", { name })} title={t("Move {name} up", { name })} disabled={index === 0} onClick={() => move(usage.key, -1)}><ChevronUp aria-hidden="true" /></button>
          <button type="button" className="icon-button" aria-label={t("Move {name} down", { name })} title={t("Move {name} down", { name })} disabled={index === ordered.length - 1} onClick={() => move(usage.key, 1)}><ChevronDown aria-hidden="true" /></button>
          <button type="button" className="icon-button usage-accounts-visibility" role="switch" aria-checked={!hidden} aria-label={t("Show {name}", { name })} title={t("Show {name}", { name })}
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
  allProviders: readonly ProviderUsage[];
  removed: readonly ProviderUsage[];
  read: boolean;
  limitsOn: boolean;
  local: boolean;
  watching: boolean;
  integrationsRead: boolean;
  onLocalLogin: (paneId: string) => void;
  onAddAccount: (provider: UsageProviderId) => void;
  onFollow: (request: FollowedSignIn) => void;
}) {
  const t = useT();
  const { agent, provider, accounts } = entry;
  const line = stateLine(entry, read, t);
  const again = read && !watching ? accounts.filter(canSignInAgain) : [];
  // an account another tool recorded is listed here, but the agent itself is still to be signed in
  const signedIn = accounts.filter(isSignIn);
  const detailsId = `agents-details-${agent.id}`;
  const action = open || watching || !read || provider === null || (entry.missing !== null && signedIn.length === 0) ? null
    : again.length === 1 ? <UsageSignInAgain usage={again[0]!} onStarted={onLocalLogin} onFollow={onFollow} />
      : signedIn.length === 0 ? <button type="button" className="btn agents-row-action" aria-label={t("Sign in to {agent}", { agent: agent.name })} onClick={() => provider === "claude" || provider === "codex" ? onFollow({ provider, default: true }) : onAddAccount(provider)}><KeyRound aria-hidden="true" /><span className="agents-row-action-label">{t("Sign in")}</span></button>
        : null;
  const signIn = agent.sign_in;
  const { settings } = useSettings();
  const launch = agent.id === "claude" ? [settings.claudeLaunchModel, settings.claudeLaunchEffort] : agent.id === "codex" ? [settings.codexLaunchModel, settings.codexLaunchEffort] : null;
  const defaults = launch === null ? null : launch.some((value) => value !== "") ? launch.map((value) => value || t("Agent default")).join(" · ") : t("Agent default");
  return (
    <li className="agents-item" data-agent={agent.id} data-section={provider === null ? undefined : `accounts-${provider}`} tabIndex={provider === null ? undefined : -1}>
      <div className="agents-summary">
        <button type="button" className="agents-toggle" aria-expanded={open} aria-controls={open ? detailsId : undefined} onClick={onToggle}>
          <AgentMark agent={agent.id} size={22} />
          <span className="agents-summary-text">
            <span className="agents-summary-name"><span className="settings-label">{agent.name}</span>{agent.state.version !== null && <span className="agents-version">{agent.state.version}</span>}</span>
            <span className={`agents-state is-${line.tone}`}>{line.text}</span>
          </span>
          {defaults !== null && <span className="agents-defaults" title={defaults}>{defaults}</span>}
          <ChevronDown className="agents-chevron" aria-hidden="true" />
        </button>
        {action}
      </div>
      {open && <div className="agents-details" id={detailsId}>
        {agent.state.meets_min_version === false && agent.min_version !== null && <p className="agents-detail-note settings-condition">{t("Ovis needs {version} or later.", { version: agent.min_version.version })}</p>}
        {provider !== null && (read ? <>
          {entry.missing !== null && <p className="agents-detail-note settings-condition" role="status">{t("Ovis reads {agent}'s sign-in from the desktop keyring with {command}, which this PC does not have. Install it (the libsecret-tools package on Debian and Ubuntu, libsecret on Fedora and Arch), then open this page again.", { agent: agent.name, command: entry.missing })}</p>}
          <div className="agents-detail-head">
            <span>{t("Accounts")} <span className="usage-account-count">{accounts.length}</span></span>
            {!watching && <button type="button" className="btn btn-ghost" onClick={() => onAddAccount(provider)}><Plus aria-hidden="true" />{t("Add account")}</button>}
          </div>
          {(entry.missing === null || accounts.length > 0) && <ProviderAccounts id={provider} providers={allProviders} removed={removed} onLocalLogin={watching ? undefined : onLocalLogin} onFollow={onFollow} />}
        </> : <p className="agents-detail-note" role="status">{limitsOn ? t("Loading…") : t("Turn on plan limits to see accounts.")}</p>)}
        {provider === null && signIn !== null && (local && signIn.provider === null
          ? <p className="agents-detail-note">{signIn.in_agent !== null ? t("{agent} signs in inside the agent ({how}). Ovis cannot read that sign-in, so it shows none here.", { agent: agent.name, how: signIn.in_agent }) : t("Ovis cannot read {agent}'s sign-in, so it shows none here.", { agent: agent.name })}</p>
          : !local && signIn.provider !== null ? <p className="agents-detail-note">{t("Accounts are read on the PC Ovis runs on: they are under Other accounts.")}</p> : null)}
        {(OWN_ROWS.has(agent.id) || (isBrowserToolAgent(agent.id) && local)) && <div className="settings-card agents-detail-card"><AgentOwnRows agentId={agent.id} /></div>}
        {entry.integration !== null
          ? <div className="settings-card agents-detail-card"><IntegrationRow integration={entry.integration} label={t("Session resume")} /></div>
          : integrationsRead && <p className="agents-detail-note">{t("herdr has no session resume for {agent}.", { agent: agent.name })}</p>}
      </div>}
    </li>
  );
}

/** The status-line switch is Claude's, for networks that refuse its usage API. */
function PlanLimits({ watching }: { watching: boolean }) {
  const { settings, update } = useSettings();
  const t = useT();
  const statusline = useStatuslineSwitch(settings.showUsage);
  return (
    <SettingsGroup section="plan-limits" className="agents-limits">
      <SettingsRow icon={Gauge} label={t("Plan limits")} description={t("Meters of your plans' limits, on every device: Used shows the share already spent, Remaining what is left, and Off hides them.")}
        condition={<span className="settings-condition">{t("Shows plan usage beside Settings. Sign-ins are sent to each provider's usage API; never refreshed here.")}</span>} keywords={`${t("Plan limits")} ${t("Show plan limits")} ${t("Meters show")} ${t("Shows plan usage beside Settings. Sign-ins are sent to each provider's usage API; never refreshed here.")}`} wide reset={settings.showUsage ? ["showUsage", "usageCount"] : ["showUsage"]}>
        <Segmented label={t("Plan limits")} value={settings.showUsage ? settings.usageCount : "off"} onChange={(shown) => update(shown === "off" ? { showUsage: false } : { showUsage: true, usageCount: shown })} options={[{ value: "off", label: t("Off") }, { value: "used", label: t("Used") }, { value: "left", label: t("Remaining") }] as const} />
      </SettingsRow>
      {settings.showUsage && <>
        <SettingsRow icon={CalendarClock} label={t("Limit shown")} description={t("Which limit the meter shows first: the week's or the 5-hour session's. An account without that limit shows the one closest to running out.")} wide reset={["usageGlance"]}>
          <Segmented label={t("Limit shown")} value={settings.usageGlance} onChange={(usageGlance) => update({ usageGlance })} options={[{ value: "week", label: t("Weekly") }, { value: "session", label: t("Session") }]} />
        </SettingsRow>
        {statusline.state?.supported && <SettingsRow icon={SquareTerminal} label={t("Read Claude's limits from its status line")}
          description={t("For networks that block Claude's usage service. It wraps Claude Code's status line on this PC to read the limits Claude shows there; your own status line keeps drawing as before, and turning this off puts Claude's settings back.")}>
          <Toggle label={t("Read Claude's limits from its status line")} checked={statusline.state.installed} disabled={statusline.busy || watching}
            onChange={(enabled) => void statusline.set(enabled)} />
        </SettingsRow>}
        {statusline.error && <p className="settings-hint account-error" role="alert">{statusline.error}</p>}
      </>}
    </SettingsGroup>
  );
}

function SectionHead({ children }: { children?: ReactNode }) {
  return <div className="agents-head">{children}</div>;
}

export function AgentsSettings({ watching, onLocalLogin, onOpenPane, onOpenGuide }: AgentsSettingsProps) {
  const t = useT();
  const { settings } = useSettings();
  const searching = useContext(SettingsQuery).length > 0;
  const api = useMachineApi();
  const machineId = useMachineId();
  const local = machineId === "local";

  const [catalog, setCatalog] = useState<{ machineId: string; agents: AgentCatalogRow[]; pathProblem: string | null } | null>(null);
  const [catalogError, setCatalogError] = useState<UserError | null>(null);
  const [reads, setReads] = useState(0);
  const [checking, setChecking] = useState(false);
  const [failures, setFailures] = useState<Readonly<Record<string, string>>>({});
  const checkAgain = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const abort = new AbortController();
    setCatalogError(null);
    setChecking(true);
    fetchAgentCatalog(machineId, abort.signal, reads > 0).then(
      (answer) => setCatalog({ machineId, agents: answer.agents, pathProblem: answer.path_problem ?? null }),
      (reason: unknown) => {
        if (abort.signal.aborted) return;
        setCatalogError(reason instanceof ApiError && reason.status === 404 ? { message: t("This PC's Ovis cannot install agents yet. Update it, then try again."), detail: null } : userErrorMessage(reason));
      },
    ).finally(() => { if (!abort.signal.aborted) setChecking(false); });
    return () => abort.abort();
  }, [machineId, reads, t]);
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
        <SettingsRow icon={Compass} label={t("Setup guide")} description={t("Opens the first-run guide again, from its first step, to install coding agents on this PC and connect them. What was set up before stays as it is.")}>
          <button type="button" className="btn" onClick={() => { onOpenGuide(); openSetupGuide(); }}>{t("Open setup guide")}</button>
        </SettingsRow>
      </SettingsGroup>}

      <section className="settings-section" data-section="agents-installed" tabIndex={-1} aria-label={t("On this PC")}>
        <SectionHead>
          {/* aria-disabled, not disabled: a press keeps the focus it had instead of dropping it to the page */}
          <button type="button" ref={checkAgain} className="btn btn-ghost agents-check-again" aria-disabled={checking || undefined} aria-busy={checking || undefined} onClick={() => { if (!checking) setReads((count) => count + 1); }}><RotateCw aria-hidden="true" />{t(checking ? "Checking…" : "Check again")}</button>
        </SectionHead>
        {catalog !== null && catalog.machineId === machineId && catalog.pathProblem !== null && <p className="settings-hint agents-note" role="status">{t("An agent your shell's startup file (.zshrc) puts on PATH may be missing here: Ovis could not read that PATH. Check again reads it once more.")}<br /><code>{catalog.pathProblem}</code></p>}
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

      <SettingsBare.Provider value="rows">
        {ownGroups.map((id) => <SettingsGroup key={id} title={OWN_NAMES[id]!} section={`agent-${id}`}>
          <AgentOwnRows agentId={id} />
        </SettingsGroup>)}
      </SettingsBare.Provider>

      {otherIntegrations.length > 0 && <details className="settings-section agents-more" data-section="integrations" tabIndex={-1} open={searching || undefined}>
        <summary className="agents-more-toggle"><ChevronRight className="agents-more-chevron" aria-hidden="true" />{t("Other agents herdr knows ({count})", { count: otherIntegrations.length })}</summary>
        {[otherIntegrations.filter((integration) => integration.available), otherIntegrations.filter((integration) => !integration.available)].map((rows, index) => rows.length > 0 &&
          <div key={index} className="settings-card agents-integrations" data-section={index === 1 ? "integrations-missing" : undefined} tabIndex={index === 1 ? -1 : undefined}>
            {rows.map((integration) => <IntegrationRow key={integration.target} integration={integration} label={integration.label} />)}
          </div>)}
      </details>}

      <section className="settings-section" data-section="other-accounts" tabIndex={-1} aria-label={t("Other accounts")}>
        <SettingsGroup>
          <SettingsRow icon={Users} label={t("Other accounts")} description={t("Accounts of providers that none of the agents listed above signs in to, such as Cursor or an agent this PC does not have.")}
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
