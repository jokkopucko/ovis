import type { TailnetPcsOptions } from "../tailnet-pcs.ts";
import type { SshCandidatesOptions } from "../ssh-candidates.ts";
import { createAlertWebhook } from "../alert-webhook.ts";
import { closeSync, openSync, readSync } from "node:fs";
import { stat } from "node:fs/promises";
import { basename, join } from "node:path";
import type { RelaySocket } from "../../shared/relay-channel.ts";
import type { AgentStatus, HerdrPane, PaneContext, PlanSummary, ServerMessage, SessionSnapshot } from "../../shared/protocol.ts";
import { alertStatus, paneAlertsMuted, pushPaneTitle } from "../../shared/notify-policy.ts";
import { AgentTaskStatus, isTaskAgent } from "../agent-tasks.ts";
import { resolveAgyStore } from "../agy-store.ts";
import { BackgroundWait } from "../background-wait.ts";
import { CardWaits, changedHands, type Roster } from "../card-waits.ts";
import { busyPanes, DESKTOP_ACTIVITY_FILE, trackDesktopActivity } from "../desktop-activity.ts";
import { ClaudeSubagentStatus, plain } from "../claude-subagents.ts";
import { claudeLastTurnEnd, claudeTranscriptStart, type ClaudeTurnEnd } from "../claude-transcript.ts";
import { codexLastTurnEnd, codexOpenRollout, paneCodexHome } from "../codex.ts";
import { onServedStatus, servedStatus, servedTurnEnd } from "../approvals/codex.ts";
import { startStatusCollector } from "../collector.ts";
import type { TurnEvent } from "../approvals/hub.ts";
import { CompletionTracker, type OmoRest } from "../completion.ts";
import { CopilotActivity } from "../copilot-activity.ts";
import { listHcMachines, startMachineBridge } from "../herdr-core/machine-bridge.ts";
import { coreConnection } from "../herdr-core/runtime.ts";
import { capabilities } from "../runtime/capabilities.ts";
import { Finishes, herdrLifetime } from "../finishes.ts";
import { claudePanePid, claudePaneSession, forgetPaneTranscriptState, paneTranscript, stoppedAgentJob } from "../conversation.ts";
import { openCodeNativeState, openCodePanePid, openCodeVerificationCheckpoint, releaseOpenCodePane, trackVerifiedOpenCodePanes } from "../opencode-native.ts";
import { opencodeDatabasePath } from "../opencode.ts";
import { OpencodeSubagentStatus } from "../opencode-subagents.ts";
import { openCodeServiceOptions, readOpenCodeService } from "../opencode-service.ts";
import { processStartUpperBoundAsync } from "../process-start.ts";
import type { DeviceStore } from "../devices.ts";
import { createGjcStatus, gjcPanes, readOmoSnapshot, reconcileProviderStatus } from "../gjc-status.ts";
import { resolveGrokStore } from "../grok-store.ts";
import { createLettaStatus, lettaPanes, lettaTitleName, lettaTitleStatus } from "../letta-status.ts";
import type { HerdrMachineProfile } from "../herdr-profiles.ts";
import { paneGet, paneProcessInfo, sessionSnapshot } from "../herdr/client.ts";
import { resolveAgent, versionSourceOf } from "../pane-context.ts";
import { storeAgentVersion } from "../agent-version.ts";
import { launchedAgents } from "../launched-agents.ts";
import { bridgeAgentNews, MachineManager } from "../machines.ts";
import { omoPanes } from "../omo.ts";
import { OMO_ALIASES, OmoStatus } from "../omo-status.ts";
import type { OrderSequence } from "../order-sequence.ts";
import type { PendingInputs } from "../pending-input.ts";
import type { PreferenceStore } from "../preferences.ts";
import { currentPrompt, type OmpLookups, onChatSubmitted, onPromptAnswering, promptWaitEnded, waitingCard } from "../prompt.ts";
import { OpenCodePromptState } from "../opencode-prompt.ts";
import { type AlertTiming, createPushService, defaultStateDir } from "../push.ts";
import { SessionPlans } from "../session-plan.ts";
import { readStatuslineContext } from "../statusline.ts";
import { userHome } from "../user-home.ts";
import { notePaneFolders } from "../windows-share.ts";
import type { Telemetry, VisitPane } from "../telemetry.ts";
import type { UsageLoginService } from "../usage-login.ts";
import type { UsageService } from "../usage.ts";
import { type Client, send } from "./connections.ts";
import type { TelemetryIngress, TelemetrySurface } from "../../shared/telemetry.ts";

const VISIT_READ_MS = 10 * 60_000;
/** how long a pane whose session named no version waits before it is read again for the usage counts */
const VERSION_RETRY_MS = 60 * 60_000;
/**
 * How often a herdr-core server reads its agents' screens for an asking they did not report (server/card-waits.ts).
 * One read of one terminal costs four hc requests, not one: a `terminal.read`, plus the `terminal.list` and two
 * `doc.get` the prompt readers make (measured with 30 working agents for 60 s: 600 reads came with 596 lists and
 * 1192 doc reads more than at rest). So 30 working agents read every 3 s are about 40 hc requests a second, and read
 * every second about 120.
 *
 * Hence two paces. A terminal a page in use shows is read on every tick: someone is looking at it, and its card
 * should show within a second. Every other one is read on every third tick only: its card counts as waiting within
 * 3 s, and its alert waits for push's short wait (10 s) after that anyway, so a faster read would only cost requests.
 * No device is alerted while a page is in use (push.ts `inUse`), so an open page that shows other terminals speeds
 * nothing up for this one.
 */
const CARD_READ_MS = 1000;
const CARD_UNWATCHED_EVERY = 3;

export function createStatusHub<Owner, Lease>({ options, devices, preferences, clients, present, pending, drainPending, holdPendingPane, paneMoved, usage, usageLogin }: {
  options: {
    stateDir?: string;
    codexHome?: string;
    telemetry?: Telemetry;
    machines?: boolean;
    relayPcSocket?: (url: string) => RelaySocket;
    relayPcDirectSocket?: (url: string) => RelaySocket;
    pcUpdateTimings?: { pollMs?: number; startMs?: number; checkMs?: number; offerMs?: number };
    tailnetPcs?: TailnetPcsOptions;
    sshCandidates?: SshCandidatesOptions;
    herdrProfiles?: () => Promise<HerdrMachineProfile[]>;
    alertTiming?: Partial<AlertTiming>;
    serverId?: () => string | undefined;
    pushLoopbackHttp?: boolean;
    backgroundWait?: { grace: number; limit: number };
    statusNow?: () => number;
    desktopActivity?: boolean;
    openCodeState?: OpenCodePromptState;
    herdrIdentity?: () => string | null;
    opencodeDb?: string;
    openCodeStateDir?: string;
    orderSequence?: OrderSequence;
    seenMoved?: (from: string, to: string, renumber: (id: number) => number) => void;
    /** a pane that ended, closed or moved to another ID: what was kept under its ID is no longer that pane's */
    paneVacated?: (paneId: string) => void;
    /** context the agent's launch extension last reported, for this pane's agent kind */
    hookContextOf?: (paneId: string, kind: string | null | undefined) => PaneContext | null | undefined;
    /** what herdr sees in front, so a launch cannot keep reporting after the pane changes hands */
    observeHookAgent?: (paneId: string, kind: string | null) => void;
    /** runs each tick of the card reads (CARD_READ_MS) and returns how to stop them; tests tick by hand */
    cardTimer?: (tick: () => Promise<void>) => () => void;
  };
  devices: DeviceStore;
  preferences: PreferenceStore;
  clients: Set<Client>;
  present: Set<Client>;
  pending: PendingInputs<Owner, Lease>;
  drainPending: (paneId: string) => void;
  holdPendingPane: (paneId: string, fault: { code: string; message: string }) => void;
  paneMoved?: (from: string, to: string) => void;
  usage: UsageService;
  usageLogin: UsageLoginService;
}) {
  const canDeliver = (id: string | null | undefined): boolean => id === null || (id === undefined ? !devices.gated : devices.has(id));
  const alertWebhook = createAlertWebhook({ stateDir: options.stateDir ?? defaultStateDir(), canDeliver });
  const push = createPushService({
    stateDir: options.stateDir ?? defaultStateDir(),
    webhook: alertWebhook,
    serverId: options.serverId,
    timing: options.alertTiming,
    now: options.statusNow,
    loopbackHttp: options.pushLoopbackHttp === true,
    canDeliver,
    // a device paired to watch gets the alert, never its answer buttons
    canAnswer: (id) => id === null || (id === undefined ? !devices.gated : devices.canDrive(id)),
    lookupPrompt: (paneId, signal) => currentPrompt(paneId, { codexHome: options.codexHome, openCodeStateDir: options.openCodeStateDir, openCodeState: options.openCodeState, signal }),
    inUse: () => present.size > 0,
    muted: (machineId, paneId) => paneAlertsMuted(preferences.get().muted_panes, machineId, paneId),
    lookupPane: async (paneId) => {
      const pane: Pick<HerdrPane, "agent_kind"> & Parameters<typeof pushPaneTitle>[0] = await paneGet(paneId);
      // or what the card it waits on asks, where the agent itself did not say (server/card-waits.ts)
      const kind = pane.agent_kind ?? cards.kindOf(paneId) ?? undefined;
      return { title: pushPaneTitle(pane), ...(kind ? { agent_kind: kind } : {}) };
    },
    onAlertDelivered: () => options.telemetry?.tally("alerts_delivered"),
  });
  const stopMutes = preferences.subscribe(() => push.mutesChanged());

  // on herdr-core every status is the program's own report (completion.ts reportedOnly)
  const completions = new CompletionTracker(join(options.stateDir ?? defaultStateDir(), "completions.json"), undefined, () => capabilities().agents === "reported");
  const finishes = new Finishes(options.herdrIdentity);
  let liveHerdr: string | null = null;
  const omo = new OmoStatus({
    discover: (panes) => omoPanes(panes),
    snapshot: sessionSnapshot,
    onChange: (paneId, derived, background, turn, rest) => omoChanged(paneId, derived, background, turn, rest),
    onFound: (paneId, again) => { completions.adopt(paneId, "omo", OMO_ALIASES); if (!again) waits.forget(paneId); },
  });
  const omoSnapshot = () => readOmoSnapshot(sessionSnapshot, omo);
  const gjc = createGjcStatus({
    discover: (panes) => gjcPanes(panes),
    snapshot: omoSnapshot,
    onChange: (paneId, derived, _background, turn, rest) => gjcChanged(paneId, derived, turn, rest),
    onFound: (paneId) => completions.adopt(paneId, "gjc", []),
  }, omo);
  const lettaTitled = new Map<string, AgentStatus>();
  const lettaRests = new Map<string, { path: string; title: string; rest: OmoRest }>();
  const sameLettaApproval = (paneId: string, saved: { path: string; title: string }): boolean => {
    const path = letta.pathOf(paneId);
    // A peer can make the transcript temporarily ambiguous without ending the title's approval.
    return lettaTitleName(lastPanes?.get(paneId)) === saved.title && (path === null || path === saved.path);
  };
  let titleReads = 0;
  let titleApplied = 0;
  const letta = createLettaStatus({
    discover: (panes) => capabilities().agents === "reported" ? lettaPanes(panes) : Promise.resolve(new Map()),
    snapshot: omoSnapshot,
    onChange: (paneId, derived, _background, turn, rest) => {
      if (lettaTitled.get(paneId) !== "blocked") { gjcChanged(paneId, derived, turn, rest, "letta"); return; }
      if (turn) {
        const path = letta.pathOf(paneId);
        if (path !== null && rest !== undefined && derived !== "working") {
          lettaRests.set(paneId, { path, title: lettaTitleName(lastPanes?.get(paneId)), rest });
        }
        else lettaRests.delete(paneId);
      }
    },
    onFound: (paneId) => completions.adopt(paneId, "letta", []),
  });
  const waits = new BackgroundWait(options.statusNow ?? Date.now, options.backgroundWait);
  /** herdr-core panes whose agent asks on screen what it did not report (server/card-waits.ts); read with state of their own, as a prompt watch is */
  const cardOpenCode = new OpenCodePromptState();
  const cardOmp: OmpLookups = new Map();
  const cards = new CardWaits(
    (pane, panes) => waitingCard(pane, panes, { codexHome: options.codexHome, openCodeStateDir: options.openCodeStateDir, openCodeState: cardOpenCode, ompLookups: cardOmp }),
    (paneId, waiting) => cardChanged(paneId, waiting),
  );
  const alert = (paneId: string, status: AgentStatus): void => { push.onStatus(paneId, cards.status(paneId, displayStatus(paneId, status))).catch(logPushError); };
  let lastPanes: Map<string, HerdrPane> | null = null;
  let settling: string | null = null;
  const agentNow = new Map<string, string | null>();
  const agentRead = new Map<string, number>();
  /** when (opencodeAgents.beginRead) each pane's agent was last told gone: a snapshot read begun before then names it to no card read */
  const agentExited = new Map<string, number>();
  /** when each pane closed, until a snapshot read begun after it is in: one begun before lists it to no card read */
  const paneClosed = new Map<string, number>();
  /**
   * How many times each pane's agent, or its session, was told to be another, by an event or a snapshot, a change back
   * to the one before counted too: a card read begun under an earlier count is of an agent that left (server/card-waits.ts)
   */
  const agentLifetime = new Map<string, number>();
  const copilotActivity = new CopilotActivity();
  const handsChanged = (paneId: string): void => { copilotActivity.forget(paneId); agentLifetime.set(paneId, (agentLifetime.get(paneId) ?? 0) + 1); };
  const eventAgent = new Map<string, { agent: string | null; since: number }>();
  const statusNow = options.statusNow ?? Date.now;
  function newLifetime(paneId: string, keep: string | null): void {
    const held = waits.waiting(paneId);
    const seen = eventAgent.get(paneId);
    if (keep !== null && seen?.agent === keep) waits.resetBefore(paneId, seen.since); else waits.reset(paneId);
    claudeAgentsChanged(paneId, 0, 0, null, held);
  }
  let service: { pid: number; started: number | null } | null = null;
  const claudeAgents = new ClaudeSubagentStatus({
    resolve: claudePaneSession,
    pid: claudePanePid,
    onReset: (paneId) => {
      const agent = agentNow.get(paneId) ?? null;
      if (owns(paneId, "claude")) newLifetime(paneId, agent === "claude" ? null : agent);
    },
    onChange: (paneId, running, turnRunning, promptAt) => {
      if (agentNow.get(paneId) !== "claude" || !owns(paneId, "claude")) return;
      claudeAgentsChanged(paneId, running, turnRunning, promptAt, false, "claude");
      if (paneId !== settling) tellQueue(paneId);
    },
  });
  function tellQueue(paneId: string): void {
    const status = completions.current(paneId);
    if (status !== undefined && pending.current(paneId) !== queueStatus(paneId, status)) { pending.status(paneId, queueStatus(paneId, status)); drainPending(paneId); }
  }
  const heard = new Map<string, AgentStatus>();
  /**
   * Claude panes a snapshot read at rest on the transcript's word alone, herdr reading them at work, until herdr's word
   * is rest, by an event or a read: each told only by the newest word on the pane (agentRead)
   */
  const restedOnTranscript = new Set<string>();
  /**
   * Claude panes whose turn the Stop hook of a Claude this server started told ended (server/approvals/claude.ts), herdr
   * still reading them at work, with where the session's transcript ended at that Stop: at rest on the hook's word until
   * herdr reads the rest, or a working it tells anew, or the UserPromptSubmit hook tells a turn began, or Claude answers
   * again in the transcript (another Stop hook, the user's or a plugin's, kept the turn going: hookTurnWentOn).
   */
  const stoppedOnHook = new Map<string, { path: string; id: string; size: number }>();
  /**
   * The prompts each Claude pane's UserPromptSubmit hook told of whose turn no Stop has ended yet, oldest first, since
   * herdr last told the pane at rest: Claude tells a prompt typed under a turn as it is queued, before that turn's Stop
   * (2.1.330), and a turn may take it in and end once for both. A Stop ends its own prompt and those before it; only one
   * that leaves none open is the rest, and one for a prompt not open (late, after herdr's rest) tells nothing.
   */
  const hookPrompts = new Map<string, (string | null)[]>();
  /** the prompts herdr's rest dropped from hookPrompts with no Stop: their Stop, if it comes, is late and ends nothing */
  const droppedPrompts = new Map<string, Set<string>>();
  /** Only the latest prompt from this rest can still supply a failure for it. Older IDs remain Stop tombstones. */
  const lateClaudeFailure = new Map<string, string>();
  const dropPrompts = (paneId: string, ready: boolean): void => {
    const open = (hookPrompts.get(paneId) ?? []).filter((prompt): prompt is string => prompt !== null);
    hookPrompts.delete(paneId);
    const last = open.at(-1);
    if (ready && last !== undefined) lateClaudeFailure.set(paneId, last);
    else if (!ready) lateClaudeFailure.delete(paneId);
    if (open.length > 0) droppedPrompts.set(paneId, new Set([...(droppedPrompts.get(paneId) ?? []), ...open].slice(-16)));
  };
  /**
   * Claude keeps its busy title up while a background subagent works after its turn ended, and herdr reads `working` (#2069).
   * Nor is a turn its Stop hook ended still at work.
   */
  function restingClaude(paneId: string, agent: string | null | undefined, status: AgentStatus): AgentStatus {
    if (agent !== "claude" || agentNow.get(paneId) !== "claude") return status;
    if (status !== "working" || omo.runs(paneId) || gjc.runs(paneId)) return status;
    return claudeAgents.restsOn(paneId) || stoppedOnHook.has(paneId) ? "idle" : status;
  }
  /**
   * Its working event may be a turn the transcript does not show yet (ClaudeSubagentStatus.busy), even with no
   * idle before it: the subagents' spinner keeps herdr at working across turns.
   */
  function hearClaude(paneId: string, agent: string | null | undefined, status: AgentStatus, event: boolean): void {
    if (agent !== "claude" || status !== "working") restedOnTranscript.delete(paneId);
    if (agent !== "claude" || status !== "working" || event) stoppedOnHook.delete(paneId);
    if (agent !== "claude") { hookPrompts.delete(paneId); droppedPrompts.delete(paneId); }
    if (agent !== "claude" || (event && status === "working")) lateClaudeFailure.delete(paneId);
    else if (event && status !== "working") dropPrompts(paneId, atRest(status));
    if (agent !== "claude") { heard.delete(paneId); return; }
    const before = heard.get(paneId);
    heard.set(paneId, status);
    if (status === "working" && (event || (before !== undefined && before !== "working"))) claudeAgents.busy(paneId, "herdr");
    else if (status !== "working") claudeAgents.quiet(paneId, event);
  }
  /**
   * The status the pane's queued input goes by: a Claude pane shown at rest while a busy signal
   * whose turn was never written holds it (ClaudeSubagentStatus.holdsQueue) is not ready for it.
   * Nor is one whose turn Claude resumed by itself (a /loop wakeup, a scheduled task, a background
   * task's notice) and no rest was written since, which herdr may still read at rest, or at rest
   * again (loopHolds, #3494): that hold is the transcript's alone, so no word of herdr's begins or
   * ends it.
   */
  function queueStatus(paneId: string, status: AgentStatus): AgentStatus {
    if (agentNow.get(paneId) !== "claude" || (status !== "idle" && status !== "done")) return status;
    // nor one at rest on its Stop hook's word alone: another Stop hook may keep the turn going (hookTurnWentOn), and a
    // queued message typed into it would be taken in mid-turn. herdr's own rest releases it
    if (stoppedOnHook.has(paneId)) return "working";
    return (heard.get(paneId) === "working" && claudeAgents.holdsQueue(paneId)) || claudeAgents.loopHolds(paneId) ? "working" : status;
  }
  const stopSubmitted = onChatSubmitted((paneId, prompt, sentAt) => {
    if (!prompt || agentNow.get(paneId) !== "claude" || omo.runs(paneId) || gjc.runs(paneId)) return;
    claudeAgents.busy(paneId, "chat", sentAt);
  });
  const opencodeAgents = new OpencodeSubagentStatus({
    store: () => options.opencodeDb ?? opencodeDatabasePath(),
    parentEnds: () => preferences.get().settings.opencodeParentEnds === true,
    serviceStart: () => {
      const found = readOpenCodeService(options.openCodeStateDir ?? openCodeServiceOptions.stateDir);
      if (found === null) return null;
      if (service?.pid !== found.pid) {
        const looked: { pid: number; started: number | null } = service = { pid: found.pid, started: null };
        void processStartUpperBoundAsync(found.pid).then((at) => {
          if (service !== looked) return;
          if (at === null) { service = null; return; }
          looked.started = at;
          void opencodeAgents.poll();
        }, () => { if (service === looked) service = null; });
      }
      return service.started;
    },
    onReset: (paneId, first) => { if (owns(paneId, "opencode")) newLifetime(paneId, first ? "opencode" : null); },
    onChange: (paneId, running, turnRunning, promptAt, toggled) => { if (owns(paneId, "opencode")) claudeAgentsChanged(paneId, running, turnRunning, promptAt, false, null, toggled); },
  });
  const taskAgents = new AgentTaskStatus({
    resolve: async (pane) => {
      if (pane.agent === "grok") {
        const path = await resolveGrokStore(pane);
        return path === null ? null : { path, started: null, owner: null };
      }
      const store = await resolveAgyStore(pane);
      return store === null ? null : { path: store.path, started: await processStartUpperBoundAsync(store.pid), owner: `${store.pid}:${store.started}` };
    },
    onReset: (paneId) => { if (isTaskAgent(agentNow.get(paneId))) newLifetime(paneId, null); },
    onChange: (paneId, count) => {
      if (isTaskAgent(agentNow.get(paneId)) && !omo.runs(paneId)) claudeAgentsChanged(paneId, count.running, count.turnRunning, count.promptAt, false, null, false, count.capped);
    },
  });
  function owns(paneId: string, tracker: "claude" | "opencode"): boolean {
    if (omo.runs(paneId)) return false;
    const agent = agentNow.get(paneId);
    const other = tracker === "claude" ? "opencode" : "claude";
    if (agent !== undefined && agent !== other) return true;
    return (tracker === "claude" ? opencodeAgents : claudeAgents).sessionOf(paneId)?.live !== true;
  }
  const plans = new SessionPlans({
    claudePath: (paneId) => claudeAgents.sessionOf(paneId)?.path ?? null,
    omoPath: (paneId) => omo.pathOf(paneId),
    codexPath: async (pane) => codexOpenRollout(pane.pane_id, pane.cwd, await paneCodexHome(pane.pane_id, options.codexHome)),
    codexServed: servedStatus,
    onChange: (paneId, summary) => planChanged(paneId, summary),
    onContext: (paneId, context) => contextChanged(paneId, context),
    claudeWindow: (path, model) => readStatuslineContext(userHome(), basename(path, ".jsonl"), model, path),
  });
  // Hook/app-server failures are an overlay for clients and alerts only. The completion tracker also feeds delivery.
  const toldFailures = new Map<string, { agent: "claude" | "codex"; thread?: string; rested: boolean; notified: boolean }>();
  const toldClaudePrompts = new Map<string, Set<string>>();
  const codexAlertTurn = new Map<string, { prompt: string | null; thread: string | undefined; failed: boolean; afterFailure: boolean }>();
  const displayStatus = (paneId: string, status: AgentStatus): AgentStatus =>
    status !== "blocked" && toldFailures.has(paneId) ? "idle" : status;
  function broadcastDisplayStatus(paneId: string, status: AgentStatus): void {
    broadcastAll({ type: "pane-status", pane_id: paneId, agent_status: cards.status(paneId, displayStatus(paneId, status)),
      ...(waits.waiting(paneId) ? { background_wait: true as const } : {}) });
  }
  function tellFailure(paneId: string, agent: "claude" | "codex"): void {
    const thread = agent === "codex" ? servedStatus(paneId)?.threadId : undefined;
    const status = completions.current(paneId);
    toldFailures.set(paneId, { agent, ...(thread === undefined ? {} : { thread }), rested: status === "idle" || status === "done", notified: false });
    broadcastDisplayStatus(paneId, status ?? "idle");
    notifyToldFailure(paneId);
  }
  function notifyToldFailure(paneId: string): void {
    const failure = toldFailures.get(paneId);
    if (failure === undefined || failure.notified || waits.waiting(paneId)
      || completions.current(paneId) === "blocked" || cards.status(paneId, "idle") === "blocked") return;
    failure.notified = true;
    alert(paneId, "idle");
    push.onFailed(paneId).catch(logPushError);
  }
  const stopServed = onServedStatus((paneId) => {
    const thread = servedStatus(paneId)?.threadId;
    const failure = toldFailures.get(paneId);
    if (failure?.agent === "codex" && failure.thread !== thread) toldFailures.delete(paneId);
    if (codexAlertTurn.get(paneId)?.thread !== thread) codexAlertTurn.delete(paneId);
    plans.servedChanged(paneId);
  });
  const CODEX_LOOK_MS = 1000;
  const CODEX_RETRY_MS = 2000;
  const codexFailed = new Set<string>();
  const codexLooked = new Map<string, { path: string; size: number; pending: boolean } | null>();
  const codexLooking = new Map<string, { turn: number; done: Promise<void> }>();
  const codexRetryAt = new Map<string, number>();
  const codexTurns = new Map<string, number>();
  const codexSessions = new Map<string, string>();
  let codexTurn = 0;
  let codexReads = 0;
  const codexFailedAt = new Map<string, number>();
  const codexWorking = (paneId: string, began: boolean): void => {
    codexFailed.delete(paneId);
    codexFailedAt.delete(paneId);
    codexLooked.delete(paneId);
    codexRetryAt.delete(paneId);
    codexSessions.delete(paneId);
    if (began) codexTurns.set(paneId, ++codexTurn); else codexTurns.delete(paneId);
  };
  function noteCodexSession(pane: HerdrPane): void {
    const session = pane.agent_session;
    if (session?.agent !== "codex" || !codexTurns.has(pane.pane_id)) return;
    const before = codexSessions.get(pane.pane_id);
    if (before !== undefined && before !== session.value) codexWorking(pane.pane_id, false);
    else codexSessions.set(pane.pane_id, session.value);
  }
  /** herdr calls a Codex at rest DONE, idle or `unknown` (codex/unknown at rest, server/completion.ts) */
  const atRest = (status: AgentStatus): boolean => status === "done" || status === "idle" || status === "unknown";
  const claudeFailed = new Set<string>();
  type ClaudeMark = { path: string; id: string; from: number; read: number } | { path: null; since: number; rested: number | null; looked: string | null };
  const claudeLooked = new Map<string, ClaudeMark>();
  /** how long before the working event that a turn began the transcript it writes may be: the prompt is written first */
  const CLAUDE_START_SLACK_MS = 5000;
  const claudeRested = new Map<string, number>();
  const claudeFailHeld = new Map<string, number | null>();
  const claudeWorking = (paneId: string, began: boolean): void => {
    claudeFailed.delete(paneId);
    claudeFailHeld.delete(paneId);
    if (began) claudeLooked.set(paneId, claudeMark(paneId)); else { claudeLooked.delete(paneId); claudeRested.delete(paneId); }
  };
  function claudeMark(paneId: string): ClaudeMark {
    const session = claudeAgents.sessionOf(paneId);
    const file = session?.live === true ? plain(session.path) : null;
    return session === null || file === null
      ? { path: null, since: statusNow(), rested: claudeRested.get(paneId) ?? null, looked: null }
      : { path: session.path, id: file.id, from: file.size, read: file.size };
  }
  function claudeFailedAlert(paneId: string): void {
    if (waits.waiting(paneId)) { claudeFailHeld.set(paneId, waits.promptAt(paneId)); return; }
    claudeFailHeld.delete(paneId);
    push.onFailed(paneId).catch(logPushError);
  }
  function claudeFailHeldEnds(paneId: string): void {
    notifyToldFailure(paneId);
    if (!claudeFailHeld.has(paneId) || waits.waiting(paneId) || !claudeFailed.has(paneId) || completions.current(paneId) !== "idle") return;
    claudeFailedAlert(paneId);
  }
  function claudeRest(paneId: string): ClaudeTurnEnd {
    let mark = claudeLooked.get(paneId);
    if (mark === undefined || omo.runs(paneId) || gjc.runs(paneId)) return null;
    const session = claudeAgents.sessionOf(paneId);
    if (session?.live !== true) return null;
    if (mark.path === null) {
      const found = basename(session.path, ".jsonl") === claudeAgents.sessionIdOf(paneId) ? plain(session.path) : null;
      const looked = found === null ? null : `${session.path}\0${found.id}\0${found.size}`;
      if (found === null || looked === mark.looked) return null;
      const began = claudeTranscriptStart(session.path, found);
      if (began === null || began < mark.since - CLAUDE_START_SLACK_MS || (mark.rested !== null && began <= mark.rested)) { mark.looked = looked; return null; }
      mark = { path: session.path, id: found.id, from: 0, read: 0 };
      claudeLooked.set(paneId, mark);
    }
    const file = session.path === mark.path ? plain(mark.path) : null;
    if (file === null || file.id !== mark.id || file.size <= mark.read) return null;
    const end = claudeLastTurnEnd(mark.path, file, mark.from);
    mark.read = file.size;
    return end;
  }
  function claudeLate(paneId: string): void {
    const told = completions.current(paneId);
    if (told === undefined || told === "working" || told === "blocked") return;
    const end = claudeRest(paneId);
    if (end === "answered") claudeLooked.delete(paneId);
    if (end === "answered" && claudeFailed.delete(paneId)) {
      claudeFailHeld.delete(paneId);
      const status = completions.observe(paneId, "idle", "claude", "answered");
      pending.status(paneId, queueStatus(paneId, status)); drainPending(paneId);
      waits.status(paneId, status);
      broadcastAll(paneStatus(paneId, status));
      alert(paneId, alertStatus(status, waits.waiting(paneId)));
      return;
    }
    if (end !== "failed" || claudeFailed.has(paneId)) return;
    claudeFailed.add(paneId);
    const status = completions.observe(paneId, "idle", "claude", "failed");
    pending.status(paneId, queueStatus(paneId, status)); drainPending(paneId);
    waits.status(paneId, status);
    broadcastAll(paneStatus(paneId, status));
    alert(paneId, alertStatus(status, waits.waiting(paneId)));
    if (!toldFailures.has(paneId)) claudeFailedAlert(paneId);
  }
  /** herdr calls such a pane's rest DONE as it calls any finish it did not see, or `unknown`: it is at rest, and READY */
  const failedRests = (snapshot: SessionSnapshot): SessionSnapshot => {
    if (codexFailed.size === 0 && claudeFailed.size === 0) return snapshot;
    const failed = (pane: { pane_id: string; agent?: string | null }) => (pane.agent === "codex" && codexFailed.has(pane.pane_id)) || (pane.agent === "claude" && claudeFailed.has(pane.pane_id));
    const rest = (pane: { pane_id: string; agent?: string | null; agent_status: AgentStatus }) => failed(pane) && (pane.agent_status === "done" || pane.agent_status === "unknown");
    return { ...snapshot, panes: snapshot.panes.map((pane) => rest(pane) ? { ...pane, agent_status: "idle" } : pane), agents: snapshot.agents.map((agent) => rest(agent) ? { ...agent, agent_status: "idle" } : agent) };
  };
  const rawSnapshot = async (): Promise<SessionSnapshot> => {
    const titleRead = ++titleReads;
    const codexRead = ++codexReads;
    const promptCheckpoint = options.openCodeState?.checkpoint();
    const read = opencodeAgents.beginRead();
    const snapshot = await omoSnapshot();
    await gjc.refresh(snapshot.panes);
    for (const pane of snapshot.panes) if (letta.runs(pane.pane_id) && (pane.agent !== "letta" || pane.agent_status !== "unknown")) letta.ended(pane.pane_id);
    await letta.refresh(snapshot.panes);
    for (const pane of snapshot.panes) {
      if ((agentRead.get(pane.pane_id) ?? 0) > read || (paneClosed.get(pane.pane_id) ?? 0) >= read) continue;
      if (pane.agent !== "codex") {
        if (codexTurns.has(pane.pane_id)) codexWorking(pane.pane_id, false);
        continue;
      }
      if (pane.agent_status === "working" && (codexFailedAt.get(pane.pane_id) ?? -1) < codexRead) codexWorking(pane.pane_id, true);
      noteCodexSession(pane);
      if (atRest(pane.agent_status) && (pane.agent_status === "done" || codexFailed.has(pane.pane_id)
        || ((codexLooked.get(pane.pane_id)?.pending || codexRetryAt.has(pane.pane_id)) && completions.current(pane.pane_id) === "done"))
        && !omo.runs(pane.pane_id) && !gjc.runs(pane.pane_id)) void codexRest(pane.pane_id, snapshot);
    }
    for (const pane of snapshot.panes) if (pane.agent === "claude" && atRest(pane.agent_status) && claudeLooked.has(pane.pane_id)) claudeLate(pane.pane_id);
    const named = failedRests(letta.apply(gjc.apply(omo.apply(snapshot))));
    const newest = titleRead > titleApplied;
    if (newest) titleApplied = titleRead;
    const told = lastPanes;
    const ids = new Set(named.panes.map((pane) => pane.pane_id));
    // the newest read also gives the card reads their panes, without a pane closed, or an agent whose exit was told,
    // after this read began
    if (newest) {
      lastPanes = new Map(named.panes.filter((pane) => (paneClosed.get(pane.pane_id) ?? 0) < read)
        .map((pane) => [pane.pane_id, (agentExited.get(pane.pane_id) ?? 0) > read ? { ...pane, agent: null } : pane]));
      for (const [paneId, closed] of paneClosed) {
        if (closed > read) continue;
        paneClosed.delete(paneId);
        if (!ids.has(paneId)) agentLifetime.delete(paneId);
      }
    }
    if (newest) notePaneFolders(named.panes.flatMap((pane) => [pane.cwd, pane.foreground_cwd]));
    if (capabilities().agents === "reported") for (const { paneId, status } of lettaTitleStatus(named, (paneId) => letta.tracks(paneId), lettaTitled, newest)) {
      const saved = lettaRests.get(paneId);
      const rest = status === "idle" && saved && sameLettaApproval(paneId, saved) ? saved.rest : undefined;
      if (status !== "blocked") lettaRests.delete(paneId);
      gjcChanged(paneId, status, true, rest, "letta");
    }
    if (newest) for (const [paneId, saved] of lettaRests) {
      if (lettaTitled.get(paneId) !== "blocked" || !sameLettaApproval(paneId, saved)) lettaRests.delete(paneId);
    }
    for (const paneId of [...agentNow.keys()]) {
      if (ids.has(paneId) || (agentRead.get(paneId) ?? 0) > read) continue;
      if (codexTurns.has(paneId)) codexWorking(paneId, false);
      agentNow.delete(paneId);
      agentRead.delete(paneId);
      agentExited.delete(paneId);
      agentLifetime.delete(paneId);
      eventAgent.delete(paneId);
      heard.delete(paneId);
      restedOnTranscript.delete(paneId);
      stoppedOnHook.delete(paneId);
      hookPrompts.delete(paneId);
      droppedPrompts.delete(paneId);
      lateClaudeFailure.delete(paneId);
      toldClaudePrompts.delete(paneId);
      toldFailures.delete(paneId);
      codexAlertTurn.delete(paneId);
    }
    for (const pane of named.panes) {
      if ((agentRead.get(pane.pane_id) ?? 0) > read) continue;
      options.observeHookAgent?.(pane.pane_id, pane.agent ?? null);
      if (changedHands({ agent: agentNow.get(pane.pane_id), agent_session: told?.get(pane.pane_id)?.agent_session }, pane)) handsChanged(pane.pane_id);
      agentNow.set(pane.pane_id, pane.agent ?? null);
      agentRead.set(pane.pane_id, read);
      hearClaude(pane.pane_id, pane.agent, pane.agent_status, false);
    }
    void claudeAgents.refresh(named.panes).catch(() => undefined).then(() => plans.refresh(named.panes)).catch(() => undefined);
    void opencodeAgents.refresh(named.panes, read);
    void taskAgents.refresh(named.panes).catch(() => undefined);
    for (const pane of named.panes) {
      pane.agent_status = launchedAgents.settle(pane.pane_id, pane.agent_status);
      if (pane.agent === "claude" && agentNow.get(pane.pane_id) === "claude") claudeAgents.poll(pane.pane_id);
      if (agentRead.get(pane.pane_id) === read && pane.agent_status === "working" && restingClaude(pane.pane_id, pane.agent, "working") !== "working") restedOnTranscript.add(pane.pane_id);
    }
    options.openCodeState?.reconcile(named.panes, promptCheckpoint);
    return named;
  };
  const backgroundOf = (paneId: string): number => omo.backgroundOf(paneId) || claudeAgents.countOf(paneId) || opencodeAgents.countOf(paneId) || taskAgents.countOf(paneId);
  /**
   * The snapshot a send is checked against, each status as its agent reported it. A card's wait is not in it: the send
   * reads the screen itself (server/core/pending.ts), and a wait outlives its card by a read or more.
   */
  const deliverySnapshot = async (): Promise<SessionSnapshot> => {
    const order = options.orderSequence?.read();
    const epoch = finishes.epoch;
    const identity = finishes.herdrIdentity();
    const snapshot = await completions.readSnapshot(async () => {
      const raw = await rawSnapshot();
      return { ...raw, panes: raw.panes.map((pane) => ({ ...pane, agent_status: restingClaude(pane.pane_id, pane.agent, pane.agent_status) })) };
    });
    if (epoch !== finishes.epoch) return deliverySnapshot();
    // the same herdr before and after the read: its panes are that herdr's. Without that proof the
    // snapshot names none, rather than give one herdr's pane IDs to another's drafts
    const lifetime = identity !== null && identity === finishes.herdrIdentity() ? herdrLifetime(identity) : undefined;
    const settled = finishes.snapshot({
      ...snapshot,
      ...(lifetime === undefined ? {} : { herdr_lifetime: lifetime }),
      panes: snapshot.panes.map((pane) => {
        const background = backgroundOf(pane.pane_id);
        const waiting = waits.waiting(pane.pane_id);
        const plan = plans.summaryOf(pane.pane_id);
        const context = options.hookContextOf?.(pane.pane_id, pane.agent) ?? plans.contextOf(pane.pane_id);
        return background > 0 || waiting || plan !== null || context !== null ? { ...pane, ...(background > 0 ? { background_tasks: background } : {}), ...(waiting ? { background_wait: true as const } : {}), ...(plan !== null ? { plan } : {}), ...(context !== null ? { context } : {}) } : pane;
      }),
    }, completions);
    return order ? { ...settled, ...order } : settled;
  };
  // clients see a card a pane waits on over what its agent reported, which the finishes and the turns were read from
  const clientSnapshot = async (): Promise<SessionSnapshot> => {
    const snapshot = copilotActivity.apply(await deliverySnapshot());
    if (toldFailures.size === 0) return cards.apply(snapshot);
    const display = <T extends { pane_id: string; agent?: string | null; agent_status: AgentStatus }>(pane: T): T =>
      toldFailures.get(pane.pane_id)?.agent === pane.agent ? { ...pane, agent_status: displayStatus(pane.pane_id, pane.agent_status) } : pane;
    return cards.apply({ ...snapshot, panes: snapshot.panes.map(display), agents: snapshot.agents.map(display) });
  };
  let visitReadAt = -Infinity;
  function countVisit(snapshot?: ReturnType<typeof clientSnapshot>, visit: { surface?: TelemetrySurface; ingress?: TelemetryIngress } = {}): void {
    const telemetry = options.telemetry;
    if (!telemetry?.counting()) return;
    let agents: Promise<VisitPane[]> | VisitPane[] = [];
    if (snapshot || Date.now() - visitReadAt >= VISIT_READ_MS) {
      visitReadAt = Date.now();
      agents = (snapshot ?? clientSnapshot()).then(visitPanes);
    }
    void telemetry.active(agents, visit)
      .catch((error) => console.error(`telemetry: the visit was not counted (${error instanceof Error ? error.message : String(error)})`));
  }
  /**
   * each pane's agent version as its session names it, by the agent and session it was read for; a read that found none
   * is tried again only after VERSION_RETRY_MS, and a pane seen with no agent forgets it
   */
  const visitVersions = new Map<string, { session: string; version: string | null; at: number }>();
  async function visitVersion(pane: HerdrPane, agent: string | null, read: SessionSnapshot): Promise<string | null> {
    if (agent !== "claude" && agent !== "codex" && agent !== "opencode") return null;
    const session = `${agent}\0${JSON.stringify(pane.agent_session ?? null)}`;
    const known = visitVersions.get(pane.pane_id);
    if (known?.session === session && (known.version !== null || Date.now() - known.at < VERSION_RETRY_MS)) return known.version;
    const source = await paneTranscript(pane.pane_id, options.codexHome, read, undefined, options.opencodeDb).then(versionSourceOf, () => null);
    const version = storeAgentVersion(agent, source);
    visitVersions.set(pane.pane_id, { session, version, at: Date.now() });
    return version;
  }
  /** what a visit tells the usage counts of each pane: its agent, whether this server started it, and its version */
  async function visitPanes(read: SessionSnapshot): Promise<VisitPane[]> {
    const agents = read.panes.map((pane) => ({ pane_id: pane.pane_id, agent: resolveAgent(pane).agent }));
    for (const paneId of visitVersions.keys()) if (!agents.some((pane) => pane.pane_id === paneId && pane.agent)) visitVersions.delete(paneId);
    const started = launchedAgents.startedPanes(agents, { omo: OMO_ALIASES });
    return Promise.all(read.panes.map(async (pane, index) => {
      const agent = agents[index]!.agent;
      return { agent, ovis: started.has(pane.pane_id), version: await visitVersion(pane, agent, read).catch(() => null) };
    }));
  }
  const paneStatus = (paneId: string, status: AgentStatus, about: { background_tasks?: number; plan?: PlanSummary | null; context?: PaneContext | null } = {}): ServerMessage =>
    ({ type: "pane-status", pane_id: paneId, agent_status: cards.status(paneId, displayStatus(paneId, status)), ...finishes.status(paneId, status), ...about, ...(waits.waiting(paneId) ? { background_wait: true as const } : {}) });
  const machines = options.machines === false ? null : new MachineManager(options.stateDir ?? defaultStateDir(), push, completions, clientSnapshot, { restoreReplaced: () => preferences.get().settings.restoreReplacedServer === true, bootId: options.orderSequence?.epoch, localFinishEpoch: () => finishes.epoch, relaySocket: options.relayPcSocket, relayDirectSocket: options.relayPcDirectSocket, serverId: options.serverId, tailnet: options.tailnetPcs, sshCandidates: options.sshCandidates, previewProfile: process.env["OVIS_PREVIEW_PROFILE"] === "1", ...(options.pcUpdateTimings ? { ownUpdate: options.pcUpdateTimings } : {}) });
  if (machines && options.herdrProfiles) machines.watchHerdrProfiles(options.herdrProfiles);
  if (machines && capabilities().machines) machines.watchHcMachines(() => listHcMachines(coreConnection()), (machine, signal) => startMachineBridge(machine, options.stateDir ?? defaultStateDir(), signal));

  const desktopActivity = options.desktopActivity === true ? trackDesktopActivity({
    path: join(options.stateDir ?? defaultStateDir(), DESKTOP_ACTIVITY_FILE),
    working: async () => busyPanes((await clientSnapshot()).panes),
  }) : null;

  function broadcastAll(message: ServerMessage): void {
    if (message.type === "pane-status" || message.type === "pane-exited" || message.type === "session-changed") desktopActivity?.changed();
    machines?.localMessage(message);
    for (const client of clients) send(client, message);
  }
  /** A broken state file must cost the alert, never the server (an unhandled rejection would). */
  const logPushError = (error: unknown): void => {
    console.error(`web push: ${error instanceof Error ? error.message : String(error)}`);
  };
  // a device durably enrolled: every other device with alerts on hears of it at once (server/devices.ts announces
  // only after the registry write succeeded, so nothing is told of a pairing that did not happen)
  // nor is the browser that paired, by its stream keys, whatever access its subscriptions came through
  devices.onPaired((event, origin) => { push.devicePaired(event, origin).catch(logPushError); });

  function omoChanged(paneId: string, derived: AgentStatus, background: number, turn: boolean, rest: OmoRest | undefined): void {
    if (turn && derived === "working") promptWaitEnded(paneId);
    if (turn) options.telemetry?.paneStatus(paneId, derived);
    const status = turn ? completions.observe(paneId, derived, "omo", rest) : completions.current(paneId) ?? completions.observe(paneId, derived, "omo");
    if (turn) { pending.status(paneId, status); drainPending(paneId); }
    const held = waits.waiting(paneId);
    waits.running(paneId, background, null, false);
    if (turn) waits.status(paneId, status);
    broadcastAll(paneStatus(paneId, status, { background_tasks: background }));
    if (turn || waits.waiting(paneId) !== held) alert(paneId, alertStatus(status, waits.waiting(paneId)));
    if (turn && rest === "failed" && status === "idle") push.onFailed(paneId).catch(logPushError);
  }

  function gjcChanged(paneId: string, derived: AgentStatus, turn: boolean, rest: OmoRest | undefined, agent: "gjc" | "letta" = "gjc"): void {
    if (turn && derived === "working") promptWaitEnded(paneId);
    if (turn) options.telemetry?.paneStatus(paneId, derived);
    const status = turn ? completions.observe(paneId, derived, agent, rest) : completions.current(paneId) ?? completions.observe(paneId, derived, agent);
    if (turn) { pending.status(paneId, status); drainPending(paneId); }
    broadcastAll(paneStatus(paneId, status));
    if (turn) alert(paneId, status);
    if (turn && rest === "failed" && status === "idle") push.onFailed(paneId).catch(logPushError);
  }

  function claudeAgentsChanged(paneId: string, running: number, turnRunning: number, promptAt: number | null, resetHold = false, agent: string | null = null, settled = false, capped = true): void {
    const changed = waits.running(paneId, turnRunning, promptAt, capped, settled) || resetHold;
    const held = claudeFailHeld.get(paneId);
    if (held !== undefined && promptAt !== null && (held === null || promptAt > held)) claudeFailHeld.delete(paneId);
    if (paneId === settling) return;
    if (agent === "claude" && agentNow.get(paneId) === "claude" && !gjc.runs(paneId) && heard.get(paneId) === "working" && (completions.current(paneId) === "working") === (restingClaude(paneId, agent, "working") !== "working")) {
      reportStatus(paneId, restingClaude(paneId, agent, "working"), agent);
      return;
    }
    const status = completions.current(paneId);
    if (status === undefined) return;
    broadcastAll(paneStatus(paneId, status, { background_tasks: running }));
    if (changed) alert(paneId, alertStatus(status, waits.waiting(paneId)));
    if (changed) claudeFailHeldEnds(paneId);
  }

  function waitsRanOut(): void {
    for (const paneId of waits.tick()) {
      const status = completions.current(paneId);
      if (status === undefined) continue;
      broadcastAll(paneStatus(paneId, status));
      alert(paneId, alertStatus(status, waits.waiting(paneId)));
      claudeFailHeldEnds(paneId);
    }
  }

  function planChanged(paneId: string, plan: PlanSummary | null): void {
    const status = completions.current(paneId);
    if (status !== undefined) broadcastAll(paneStatus(paneId, status, { plan }));
  }

  function contextChanged(paneId: string, context: PaneContext | null): void {
    const status = completions.current(paneId);
    if (status !== undefined) broadcastAll(paneStatus(paneId, status, { context }));
  }

  const bridgeAgents = machines ? null : bridgeAgentNews(() => broadcastAll({ type: "session-changed" }));

  function onStatus(paneId: string, read: AgentStatus, agent: string | null, replay?: { before: AgentStatus; agent: string | null; askedAt?: number }): void {
    // Provider aliases of a recognized OmO are not a change of agent; a shell or another kind is.
    options.observeHookAgent?.(paneId, agent !== null && OMO_ALIASES.includes(agent) && omo.runs(paneId) ? "omo" : agent);
    if (agent !== "opencode" && (!replay || agent || read !== "unknown")) {
      options.openCodeState?.forget(paneId);
      if (!replay) releaseOpenCodePane(paneId);
    }
    const ran = agentNow.get(paneId);
    if (agent !== "copilot") copilotActivity.forget(paneId);
    agentNow.set(paneId, agent);
    // its agent is gone (it exited at its card): the wait goes with it, so does a read of its screen under way, and the
    // status reported now is what shows. The card reads take no agent for it from a snapshot read begun before this,
    // whether a snapshot or only its own status events had named that agent
    if (agent === null) {
      const waited = cards.waiting(paneId);
      cards.forget(paneId);
      const last = lastPanes?.get(paneId);
      if (ran || last?.agent) agentExited.set(paneId, opencodeAgents.beginRead());
      if (last?.agent) lastPanes!.set(paneId, { ...last, agent: null });
      if (waited) broadcastAll({ type: "session-changed" });
    }
    const was = settling;
    settling = paneId;
    const resumed = claudeAgents.loopTold(paneId);
    try {
      hearClaude(paneId, agent, read, replay === undefined);
      if (agent === "claude") claudeAgents.poll(paneId);
    } finally { settling = was; }
    if (replay === undefined && (agent !== "letta" || read !== "unknown")) {
      lettaTitled.delete(paneId);
      lettaRests.delete(paneId);
    }
    const titled = agent === "letta" && read === "unknown" && capabilities().agents === "reported" && !letta.tracks(paneId) ? lettaTitled.get(paneId) : undefined;
    const raw = restingClaude(paneId, agent, launchedAgents.settle(paneId, titled ?? read));
    gjc.poll();
    if (letta.runs(paneId) && (agent !== "letta" || (replay === undefined && read !== "unknown"))) letta.ended(paneId);
    letta.poll();
    if (replay && (omo.runs(paneId) || gjc.tracks(paneId) || letta.tracks(paneId) || !completions.replayed(paneId, raw, replay))) {
      if (claudeAgents.loopTold(paneId) !== resumed) tellQueue(paneId);
      return;
    }
    // A sample taken (or begun) before Herdr reported new work cannot describe that turn.
    if (agent === "copilot" && read === "working") copilotActivity.forget(paneId);
    if (reconcileProviderStatus(omo, gjc, { pane_id: paneId, agent })) completions.forget(paneId);
    const named = [{ pane_id: paneId, agent: omo.runs(paneId) ? "omo" : gjc.runs(paneId) ? "gjc" : agent }];
    if (machines) machines.localAgents(named); else bridgeAgents!.status(named);
    if (named[0]!.agent && changedHands({ agent: ran }, named[0]!)) handsChanged(paneId);
    agentNow.set(paneId, named[0]!.agent ?? null);
    agentRead.set(paneId, opencodeAgents.beginRead());
    if (eventAgent.get(paneId)?.agent !== (named[0]!.agent ?? null)) eventAgent.set(paneId, { agent: named[0]!.agent ?? null, since: statusNow() });
    // herdr says `claude/idle` for an OmO pane whatever it does, and a provider child's work for
    // a GJC one while its transcript is tracked: their own status stands, and no Claude turn waits there
    // (an OmO pane's wait on its background tasks is omoChanged's)
    if (omo.tracks(paneId)) return;
    if (gjc.tracks(paneId) || letta.tracks(paneId)) {
      waits.forget(paneId);
      return;
    }
    reportStatus(paneId, raw, agent, replay?.askedAt);
  }

  /**
   * A herdr-core pane began or stopped waiting on a card its agent did not report: shown and alerted as blocked, then
   * as what the agent's reports make it (the turn, its finish included, is counted from those alone). A pane whose agent
   * reports blocked itself is left as it said. Web push hears the status before the wait first, so the wait is news and
   * alerts, not a first sighting. Another card in a waited one's place comes as that wait's end and a new beginning: push
   * hears the agent's own status between the two, so the new card alerts as any other.
   */
  function cardChanged(paneId: string, waiting: boolean): void {
    const status = completions.current(paneId) ?? lastPanes?.get(paneId)?.agent_status ?? "unknown";
    if (status === "blocked") return;
    const told = alertStatus(status, waits.waiting(paneId));
    if (waiting) push.assume(paneId, told);
    broadcastAll(paneStatus(paneId, status));
    alert(paneId, told);
    // the rows say what it waits on from the next snapshot
    broadcastAll({ type: "session-changed" });
  }
  /** never two reads at once: a slow read skips a tick rather than pile up */
  let cardReading: Promise<void> | null = null;
  /** the hub stopped: no read starts, and one under way finds no pane, so it shows and alerts nothing */
  let cardsStopped = false;
  const cardPane = (pane: HerdrPane): HerdrPane => ({
    ...pane,
    // a status event told before the program in front was known names no agent: the snapshot's then stands
    agent: agentNow.get(pane.pane_id) ?? pane.agent ?? null,
    agent_status: completions.current(pane.pane_id) ?? pane.agent_status,
  });
  /** each pane asked for anew around its own read (server/card-waits.ts): an agent that left, or was replaced, while a screen was read is not read as itself */
  const cardRoster: Roster = {
    all: () => [...(lastPanes?.values() ?? [])].map(cardPane),
    pane: (paneId) => { const pane = cardsStopped ? undefined : lastPanes?.get(paneId); return pane && cardPane(pane); },
    lifetime: (paneId) => agentLifetime.get(paneId) ?? 0,
  };
  /**
   * Read: a pane whose agent works or has reported nothing (Codex's question, Claude Code's folder trust), and one that
   * waits; never an agent at rest or one that reports blocked itself. The panes are the newest snapshot's, with each
   * agent and status as its own reports made them since, so no snapshot is taken for a read.
   */
  function cardTick(only?: ReadonlySet<string>): Promise<void> {
    if (cardsStopped || capabilities().agents !== "reported" || lastPanes === null) return Promise.resolve();
    // OmO, GJC and Letta panes have trackers of their own, whose status stands: none is read, and a wait begun before
    // its tracker found the pane ends there
    cardReading ??= cards.tick(cardRoster, (pane) => pane.agent_status === "working" || pane.agent_status === "unknown", (paneId) => omo.runs(paneId) || gjc.tracks(paneId) || letta.tracks(paneId), only)
      .catch(() => undefined).finally(() => { cardReading = null; });
    return cardReading;
  }
  // an answer from a card is its wait's, the one the pane is in as the answer begins: once it was delivered to a card the
  // agent waits on the pane is read, and where that wait is still on, its first read without a card ends it
  const stopAnswered = onPromptAnswering((paneId) => {
    const wait = cards.generation(paneId);
    return (delivered) => {
      if (!delivered) return;
      if (wait !== undefined) cards.answer(paneId, wait);
      void cardTick(new Set([paneId]));
    };
  });

  /** `askedAt`: a status replayed from a snapshot asked for then, which the queue takes as that snapshot (`pending.baseline`) */
  function reportStatus(paneId: string, raw: AgentStatus, agent: string | null, askedAt?: number): void {
    const told = toldFailures.get(paneId);
    if (told !== undefined) {
      if (told.agent !== agent || (told.rested && raw === "working")) toldFailures.delete(paneId);
      else if (atRest(raw)) told.rested = true;
    }
    // back at work, the agent has had its answer, maybe from a terminal: the same prompt on
    // its screen after this is another asking, which an answer to the old card must not take.
    if (raw === "working") promptWaitEnded(paneId);
    options.telemetry?.paneStatus(paneId, raw);
    if (raw === "working" || agent !== "codex") codexWorking(paneId, raw === "working" && agent === "codex");
    if (raw === "working" || agent !== "claude") claudeWorking(paneId, raw === "working" && agent === "claude");
    const claudeEnd = agent === "claude" && raw !== "blocked" && raw !== "working" ? claudeRest(paneId) : null;
    if (agent === "claude" && raw !== "blocked" && raw !== "working") claudeRested.set(paneId, statusNow());
    const claudeFailedNow = claudeEnd === "failed" && !claudeFailed.has(paneId);
    if (claudeFailedNow) claudeFailed.add(paneId);
    const claudeAnswered = claudeEnd === "answered" && claudeFailed.delete(paneId);
    const failedRest = (codexFailed.has(paneId) || (agent === "claude" && claudeFailed.has(paneId))) && raw !== "blocked";
    const status = completions.observe(paneId, failedRest || claudeAnswered ? "idle" : raw, omo.runs(paneId) ? "omo" : gjc.runs(paneId) ? "gjc" : agent, failedRest ? "failed" : claudeAnswered ? "answered" : undefined);
    if (askedAt === undefined) pending.status(paneId, queueStatus(paneId, status)); else pending.baseline(paneId, queueStatus(paneId, status), askedAt);
    drainPending(paneId);
    const tracker = omo.runs(paneId) ? null : agent === "claude" ? claudeAgents : agent === "opencode" ? opencodeAgents : isTaskAgent(agent) ? taskAgents : null;
    if (tracker !== null) {
      const resumed = claudeAgents.loopTold(paneId);
      settling = paneId;
      try { void tracker.poll(paneId); } finally { settling = null; }
      if (claudeAgents.loopTold(paneId) !== resumed) tellQueue(paneId);
      waits.status(paneId, status);
    } else waits.forget(paneId);
    const tell = (): void => {
      broadcastAll(paneStatus(paneId, status, tracker !== null ? { background_tasks: tracker.countOf(paneId) } : {}));
      alert(paneId, alertStatus(status, waits.waiting(paneId)));
      notifyToldFailure(paneId);
    };
    if (agent === "codex" && status === "done" && !omo.runs(paneId) && !gjc.runs(paneId) && (codexTurns.get(paneId) ?? 0) > 0) {
      const turn = codexTurns.get(paneId);
      let timer: ReturnType<typeof setTimeout> | undefined;
      void Promise.race([codexRest(paneId), new Promise<void>((resolve) => { timer = setTimeout(resolve, CODEX_LOOK_MS); })])
        .then(() => { clearTimeout(timer); if (codexTurns.get(paneId) === turn && completions.current(paneId) === status) tell(); });
    } else tell();
    if (claudeFailedNow && status === "idle" && !toldFailures.has(paneId)) claudeFailedAlert(paneId);
    if (claudeEnd === "answered") claudeLooked.delete(paneId);
    if (tracker === opencodeAgents && opencodeAgents.sessionOf(paneId)?.live !== true) {
      const begun = opencodeAgents.beginRead();
      void paneGet(paneId).then((pane) => { if (opencodeAgents.ensure(pane, begun)) void opencodeAgents.poll(paneId); }).catch(() => undefined);
    }
    if (tracker === taskAgents && taskAgents.stale(paneId)) void paneGet(paneId).then((pane) => taskAgents.track(pane)).catch(() => undefined);
  }

  /**
   * A turn of an agent this server started, as its hook or app server told. Claude's Stop ends its prompt before herdr
   * reads the rest. StopFailure tells it failed, without waiting for the transcript. Either is a rest only once no
   * newer prompt is open. UserPromptSubmit ends the hook's rest, and herdr's reading stands again.
   *
   * OmO's extension tells its runs instead (server/approvals/omo.ts): its session file stays the status's source, which
   * holds the rest it reads while a run told began has not ended (omo-status.ts), and is read again at once when one does.
   */
  function hookTurn(paneId: string, kind: string, event: TurnEvent): void {
    const { turn, prompt } = event;
    if (kind === "omo") {
      omo.told(paneId, turn);
      if (turn === "ended") void omo.poll();
      return;
    }
    if (kind === "codex") {
      if (agentNow.get(paneId) !== "codex" || omo.runs(paneId) || gjc.runs(paneId)) return;
      const previous = codexAlertTurn.get(paneId);
      const thread = servedStatus(paneId)?.threadId;
      if (turn === "began") {
        const afterFailure = codexFailed.has(paneId);
        codexAlertTurn.set(paneId, { prompt, thread, failed: false, afterFailure });
        if (toldFailures.delete(paneId)) {
          const next = completions.current(paneId) === "blocked" ? "blocked" : "working";
          broadcastDisplayStatus(paneId, next);
          alert(paneId, next);
        }
        return;
      }
      if (!event.failed || (previous?.prompt != null && prompt !== previous.prompt) || previous?.failed) return;
      codexAlertTurn.set(paneId, { prompt, thread, failed: true, afterFailure: false });
      if (!codexFailed.has(paneId) || previous?.afterFailure) tellFailure(paneId, "codex");
      return;
    }
    if (kind !== "claude" || agentNow.get(paneId) !== "claude" || omo.runs(paneId) || gjc.runs(paneId)) return;
    const open = hookPrompts.get(paneId) ?? [];
    if (turn === "began") {
      lateClaudeFailure.delete(paneId);
      toldFailures.delete(paneId);
      hookPrompts.set(paneId, [...open, prompt]);
      hookRestEnds(paneId);
      return;
    }
    const at = open.indexOf(prompt);
    if (event.failed) {
      if (prompt !== null) {
        if (at < 0 && (open.length > 0 || lateClaudeFailure.get(paneId) !== prompt)) return;
        const seen = toldClaudePrompts.get(paneId) ?? new Set<string>();
        if (seen.has(prompt)) return;
        toldClaudePrompts.set(paneId, new Set([...seen, prompt].slice(-16)));
      } else if (toldFailures.has(paneId)) return;
      if (at >= 0 && at < open.length - 1) push.onFailed(paneId, undefined, true).catch(logPushError);
      else if (!claudeFailed.has(paneId) || at >= 0) tellFailure(paneId, "claude");
      return;
    }
    // the Stop of a prompt herdr's rest already dropped: late, while another turn may run (a repeated Stop of a prompt
    // that ended, after another Stop hook blocked the first, is still the rest)
    if (at < 0 && prompt !== null && droppedPrompts.get(paneId)?.delete(prompt)) return;
    const left = at >= 0 ? open.slice(at + 1) : open;
    if (left.length > 0) { hookPrompts.set(paneId, left); return; }
    hookPrompts.delete(paneId);
    // what the transcript holds at this Stop: an answer written after it is the turn going on. None known, no early rest
    const session = claudeAgents.sessionOf(paneId);
    const file = session?.live === true ? plain(session.path) : null;
    if (completions.current(paneId) !== "working" || session === null || file === null) return;
    stoppedOnHook.set(paneId, { path: session.path, id: file.id, size: file.size });
    reportStatus(paneId, "idle", "claude");
  }

  /** The hook's rest of `paneId` is over: what herdr reads stands again. */
  function hookRestEnds(paneId: string): void {
    if (stoppedOnHook.delete(paneId) && heard.get(paneId) === "working") reportStatus(paneId, restingClaude(paneId, "claude", "working"), "claude");
  }

  /** The most of a transcript read past a Stop: Claude's next answer comes in its first entries. */
  const WENT_ON_READ = 256 * 1024;
  /**
   * Whether Claude answered again after the Stop its hook told (another Stop hook blocked that stop, and the turn goes
   * on with no prompt and, to herdr, no change). Read on the wait timer's tick, so a DONE told in error is taken back
   * within a second or two, before push's short wait sends its alert.
   */
  function hookTurnWentOn(): void {
    for (const [paneId, mark] of stoppedOnHook) {
      const file = plain(mark.path);
      if (file === null || file.id !== mark.id || file.size <= mark.size) continue;
      const length = Math.min(file.size - mark.size, WENT_ON_READ);
      const bytes = Buffer.alloc(length);
      let fd: number | undefined;
      try {
        fd = openSync(mark.path, "r");
        readSync(fd, bytes, 0, length, mark.size);
      } catch { continue; } finally { if (fd !== undefined) closeSync(fd); }
      const text = bytes.toString("utf8");
      const whole = text.slice(0, text.lastIndexOf("\n") + 1);
      // one entry longer than a read, written after the Stop: the turn went on
      if (whole === "" && length === WENT_ON_READ) { hookRestEnds(paneId); continue; }
      const answered = whole.split("\n").some((line) => {
        try { return (JSON.parse(line) as { type?: unknown }).type === "assistant"; } catch { return false; }
      });
      if (answered) hookRestEnds(paneId);
      // the lines read whole are not read again
      else mark.size += Buffer.byteLength(whole);
    }
  }

  function codexRest(paneId: string, snapshot?: SessionSnapshot): Promise<void> {
    const known = codexLooked.get(paneId);
    const turn = codexTurns.get(paneId) ?? 0;
    // a Codex Ovis started on its own app server says how its turn ended (server/approvals/codex.ts): no transcript is read
    const served = turn === 0 ? null : servedTurnEnd(paneId);
    if (served === "answered" || served === "failed") {
      codexEnded(paneId, served);
      return Promise.resolve();
    }
    if (turn === 0 || known === null || (codexRetryAt.get(paneId) ?? 0) > Date.now()) return Promise.resolve();
    const looking = codexLooking.get(paneId);
    if (looking?.turn === turn) return looking.done;
    const current = (): boolean => codexTurns.get(paneId) === turn;
    const unavailable = (): null => {
      if (!current()) return null;
      // Give a first lookup one more chance, but don't switch rollouts mid-check.
      if (known !== undefined || codexRetryAt.has(paneId)) {
        codexLooked.set(paneId, null);
        codexRetryAt.delete(paneId);
      } else codexRetryAt.set(paneId, Date.now() + CODEX_RETRY_MS);
      return null;
    };
    const done = (async () => {
      let path = known?.path;
      let size = path === undefined ? -1 : await stat(path).then((file) => file.size, () => -1);
      if (path !== undefined && size < 0) return unavailable();
      if (path === undefined) {
        const seen = snapshot ?? await sessionSnapshot().catch(() => undefined);
        if (!current()) return null;
        if (seen === undefined) return unavailable();
        const pane = seen.panes.find((pane) => pane.pane_id === paneId);
        if (pane?.agent === "codex") noteCodexSession(pane);
        if (!current()) return null;
        const transcript = await paneTranscript(paneId, options.codexHome, seen).catch(() => undefined);
        if (transcript === undefined) return unavailable();
        if (transcript.source !== "codex-transcript") {
          if (current()) { codexLooked.set(paneId, null); codexRetryAt.delete(paneId); }
          return null;
        }
        path = transcript.path;
        size = await stat(path).then((file) => file.size, () => -1);
        if (size < 0) return unavailable();
      } else if (known?.size === size) return null;
      if (!current()) return null;
      codexRetryAt.delete(paneId);
      const end = await codexLastTurnEnd(path);
      // A bounded tail can lose the start marker before the end reaches disk.
      if (current()) codexLooked.set(paneId, { path, size, pending: end === "running" || (end === null && (known?.pending ?? true)) });
      return end;
    })().then((end) => {
      // the server's word on this turn stands over a rollout read begun before it came
      if (end !== null && end !== "running" && current() && servedTurnEnd(paneId) !== "failed") codexEnded(paneId, end);
    }, () => undefined).finally(() => {
      if (codexLooking.get(paneId)?.turn === turn) codexLooking.delete(paneId);
    });
    codexLooking.set(paneId, { turn, done });
    return done;
  }

  /** What a Codex turn's end tells: a failure alerts once, and an answer after one clears it. */
  function codexEnded(paneId: string, end: "answered" | "failed"): void {
    if (end === "answered") {
      if (!codexFailed.has(paneId)) return;
      codexFailed.delete(paneId); codexFailedAt.delete(paneId);
      const status = completions.observe(paneId, "idle", "codex", "answered");
      pending.status(paneId, queueStatus(paneId, status)); drainPending(paneId);
      waits.status(paneId, status);
      broadcastAll(paneStatus(paneId, status));
      alert(paneId, status);
      return;
    }
    const now = completions.current(paneId);
    if (now === "working" || now === "blocked" || codexFailed.has(paneId)) return;
    codexFailed.add(paneId);
    codexFailedAt.set(paneId, codexReads);
    const told = codexAlertTurn.get(paneId);
    if (told !== undefined) told.afterFailure = false;
    const status = completions.observe(paneId, "idle", "codex", "failed");
    pending.status(paneId, queueStatus(paneId, status)); drainPending(paneId);
    waits.status(paneId, status);
    broadcastAll(paneStatus(paneId, status));
    alert(paneId, status);
    if (toldFailures.has(paneId)) notifyToldFailure(paneId);
    else push.onFailed(paneId).catch(logPushError);
  }

  const shellSnapshots = new WeakSet<HerdrPane>();
  const snapshotVerifications = new WeakMap<HerdrPane, number>();
  function paneGone(paneId: string): void {
    copilotActivity.forget(paneId);
    cards.forget(paneId);
    lastPanes?.delete(paneId);
    paneClosed.set(paneId, opencodeAgents.beginRead());
    codexWorking(paneId, false);
    claudeWorking(paneId, false);
    omo.ended(paneId);
    gjc.ended(paneId);
    letta.ended(paneId);
    lettaRests.delete(paneId);
    options.openCodeState?.forget(paneId);
    releaseOpenCodePane(paneId);
    finishes.ended(paneId);
    const signedIn = usageLogin.ended(paneId);
    if (signedIn) usage.invalidate(signedIn);
    holdPendingPane(paneId, { code: "pane_not_found", message: "The pane ended; its pending messages were not sent" });
    pending.forget(paneId);
    waits.forget(paneId);
    taskAgents.forget(paneId);
    completions.forget(paneId);
    heard.delete(paneId);
    restedOnTranscript.delete(paneId);
    stoppedOnHook.delete(paneId);
    hookPrompts.delete(paneId);
    droppedPrompts.delete(paneId);
    lateClaudeFailure.delete(paneId);
    toldClaudePrompts.delete(paneId);
    toldFailures.delete(paneId);
    codexAlertTurn.delete(paneId);
    agentNow.delete(paneId);
    agentRead.set(paneId, opencodeAgents.beginRead());
    agentExited.delete(paneId);
    eventAgent.delete(paneId);
    forgetPaneTranscriptState(paneId);
    bridgeAgents?.ended(paneId);
  }
  let alertRoster = new Map<string, string | null>();
  const collector = startStatusCollector({
    onStatus,
    herdrLive: { identity: () => finishes.herdrIdentity(), onChange: (identity) => { liveHerdr = identity; } },
    onFocus: (paneId, passing) => {
      broadcastAll({ type: "session-changed" });
      if (passing) return;
      broadcastAll({ type: "pane-focused", pane_id: paneId });
      if (!completions.seen(paneId)) return;
      pending.status(paneId, queueStatus(paneId, "idle")); drainPending(paneId);
      broadcastAll(paneStatus(paneId, "idle"));
      alert(paneId, alertStatus("idle", waits.waiting(paneId)));
    },
    onBaseline: (panes, newer = new Set(), askedAt = Date.now(), created = new Map()) => {
      const projected = panes.map((pane) => ({ ...pane, agent_status: restingClaude(pane.pane_id, pane.agent, pane.agent_status) }));
      for (const pane of projected) if (pane.agent === "claude" || pane.agent === "opencode" || isTaskAgent(pane.agent)) waits.seed(pane.pane_id, pane.agent_status);
      const alerted = projected.map((pane) => ({ ...pane, agent_status: cards.status(pane.pane_id, alertStatus(pane.agent_status, waits.waiting(pane.pane_id))) }));
      // web push alone hears a new pane's first reading as a change from its creation; everything else takes the
      // snapshot as for any pane, the queue below included
      for (const pane of alerted) {
        const began = created.get(pane.pane_id);
        if (began !== undefined) push.firstStatus(pane.pane_id, began, pane.agent_status).catch(logPushError);
      }
      // A roster may already show a terminal under its new pane ID while its move event is in transit.
      const roster = new Map<string, string | null>();
      const present = new Set(alerted.map((pane) => pane.pane_id));
      for (const pane of alerted) {
        if (pane.terminal_id) roster.set(pane.terminal_id, roster.has(pane.terminal_id) ? null : pane.pane_id);
      }
      for (const pane of alerted) {
        const before = alertRoster.get(pane.terminal_id);
        // The roster gives us the terminal's identity; push checks the latest question at its source,
        // including one heard while this roster was in flight.
        if (pane.agent_status === "blocked" && before && roster.get(pane.terminal_id) === pane.pane_id
          && !present.has(before)) push.movedQuestion(before, pane.pane_id, newer.has(pane.pane_id));
      }
      alertRoster = roster;
      push.seed(alerted);
      // a tab, workspace or worktree that closed names none of its panes: the snapshot without them says they went
      push.gone(projected, newer);
      for (const pane of projected) {
        // herdr told the pane's status after this snapshot was read: the queue has the newer reading
        if (newer.has(pane.pane_id)) continue;
        // a pane already waiting for its user when the server started (or reconnected) begins its wait for the usage counts
        if (!(omo.tracks(pane.pane_id) || gjc.tracks(pane.pane_id) || letta.tracks(pane.pane_id))) options.telemetry?.paneStatus(pane.pane_id, pane.agent_status);
        // A fast mirrored client may queue before the collector's first baseline. A
        // known ready baseline can schedule a fresh guarded check even when the tracker
        // still remembers working; an unknown baseline never supplies that permission.
        // A snapshot reading the agent at work says so itself: the tracker's older ready is no turn evidence. Not for a pane
        // whose own status an OmO, GJC or Letta tracker keeps: herdr reads its provider child, at work after the turn ended
        const owned = omo.tracks(pane.pane_id) || gjc.tracks(pane.pane_id) || letta.tracks(pane.pane_id);
        const read = pane.agent_status === "idle" || pane.agent_status === "done" || (pane.agent_status === "working" && !owned);
        const status = read ? pane.agent_status : completions.current(pane.pane_id) ?? pane.agent_status;
        // the tracker's remembered working is what its events already told the queue, and no reading of a new turn
        if (read || status !== "working") pending.baseline(pane.pane_id, queueStatus(pane.pane_id, status), askedAt);
        drainPending(pane.pane_id);
      }
    },
    onReconciled: (panes) => {
      const verified = new Set(openCodeNativeState().panes);
      // herdr can keep calling a pane OpenCode after it left (0.9.3 on a loaded host): the shell alone in front says it did
      for (const pane of panes) {
        if (!verified.has(pane.pane_id)) continue;
        const left = pane.agent === "opencode" ? shellSnapshots.has(pane) : pane.agent || pane.agent_status !== "unknown" || shellSnapshots.has(pane);
        if (left) releaseOpenCodePane(pane.pane_id, snapshotVerifications.get(pane));
      }
      if (machines) machines.localAgents(panes); else bridgeAgents!.reconciled(panes);
    },
    onResync: (panes, newer, askedAt = Date.now()) => {
      const projected = panes.map((pane) => ({ ...pane, agent_status: restingClaude(pane.pane_id, pane.agent, pane.agent_status) }));
      finishes.resync(completions, projected, newer);
      const settled = (pane: HerdrPane): AgentStatus => completions.current(pane.pane_id) ?? pane.agent_status;
      // read from a snapshot: one asked for before an Enter says nothing of its turn. A pane with an event since has it already
      for (const pane of panes) {
        if (!newer.has(pane.pane_id)) pending.baseline(pane.pane_id, queueStatus(pane.pane_id, settled(pane)), askedAt);
        drainPending(pane.pane_id);
      }
      for (const pane of panes) if (!newer.has(pane.pane_id) && (pane.agent === "claude" || pane.agent === "opencode" || isTaskAgent(pane.agent))) waits.status(pane.pane_id, settled(pane));
      push.resync(panes.map((pane) => ({ ...pane, agent_status: cards.status(pane.pane_id, alertStatus(settled(pane), waits.waiting(pane.pane_id))) })), newer);
    },
    onPaneEnded: (paneId) => {
      paneGone(paneId);
      options.paneVacated?.(paneId);
      broadcastAll({ type: "pane-exited", pane_id: paneId });
      push.onEnded(paneId).catch(logPushError);
    },
    onPaneClosed: (paneId) => {
      paneGone(paneId);
      options.paneVacated?.(paneId);
      push.closed(paneId);
    },
    onPaneMoved: (from, to, status) => {
      options.paneVacated?.(from);
      const renumber = finishes.moved(from, to);
      for (const state of [codexFailedAt, codexTurns, codexLooked, codexSessions, codexRetryAt] as Map<string, unknown>[]) if (state.has(from)) { state.set(to, state.get(from)); state.delete(from); }
      if (codexFailed.delete(from)) codexFailed.add(to);
      if (codexAlertTurn.has(from)) { codexAlertTurn.set(to, codexAlertTurn.get(from)!); codexAlertTurn.delete(from); }
      if (toldFailures.has(from)) { toldFailures.set(to, toldFailures.get(from)!); toldFailures.delete(from); }
      if (toldClaudePrompts.has(from)) { toldClaudePrompts.set(to, toldClaudePrompts.get(from)!); toldClaudePrompts.delete(from); }
      if (claudeLooked.has(from)) { claudeLooked.set(to, claudeLooked.get(from)!); claudeLooked.delete(from); }
      if (claudeFailed.delete(from)) claudeFailed.add(to);
      if (stoppedOnHook.has(from)) { stoppedOnHook.set(to, stoppedOnHook.get(from)!); stoppedOnHook.delete(from); }
      if (hookPrompts.has(from)) { hookPrompts.set(to, hookPrompts.get(from)!); hookPrompts.delete(from); }
      if (droppedPrompts.has(from)) { droppedPrompts.set(to, droppedPrompts.get(from)!); droppedPrompts.delete(from); }
      const late = lateClaudeFailure.get(from);
      if (late !== undefined) { lateClaudeFailure.set(to, late); lateClaudeFailure.delete(from); }
      if (claudeFailHeld.has(from)) { claudeFailHeld.set(to, claudeFailHeld.get(from) ?? null); claudeFailHeld.delete(from); }
      if (claudeRested.has(from)) { claudeRested.set(to, claudeRested.get(from)!); claudeRested.delete(from); }
      try { options.seenMoved?.(from, to, renumber); }
      catch (error) { console.warn(`seen: could not carry the reads of ${from} to ${to}:`, error); }
      broadcastAll({ type: "pane-moved", from, to });
      // A provider's work is not a tracked agent resuming, nor does it answer a card managed here.
      const ownsQuestion = omo.tracks(from) || gjc.tracks(from) || letta.tracks(from) || cards.waiting(from);
      push.moved(from, to, ownsQuestion ? "unknown" : status);
      paneMoved?.(from, to);
    },
    onStructureChange: () => broadcastAll({ type: "session-changed" }),
  }, { snapshot: async () => {
    const checkpoint = openCodeVerificationCheckpoint();
    const snapshot = await rawSnapshot();
    for (const pane of snapshot.panes) snapshotVerifications.set(pane, checkpoint);
    // Windows reports only the shell even while its agent runs; it supplies no foreground proof.
    if (process.platform !== "win32") {
      const verified = new Set(openCodeNativeState().panes);
      // `exec opencode` keeps the shell's pid, but not its process identity.
      const shell = /(?:^|\/)-?(?:sh|bash|dash|zsh|fish|ksh|mksh|csh|tcsh|ash|nu)$/u;
      const shellAlone = (info: Awaited<ReturnType<typeof paneProcessInfo>>): info is NonNullable<typeof info> & { shell_pid: number } => {
        const front = info?.foreground_processes?.[0];
        return info?.shell_pid != null && info.foreground_processes?.length === 1 && front?.pid === info.shell_pid
          && shell.test(front.name) && shell.test(front.argv?.[0] ?? front.argv0 ?? front.name);
      };
      await Promise.all(snapshot.panes.map(async (pane) => {
        if (!verified.has(pane.pane_id) || (pane.agent ? pane.agent !== "opencode" : pane.agent_status !== "unknown")) return;
        const info = await paneProcessInfo(pane.pane_id).catch(() => undefined);
        // OpenCode stopped with Ctrl+Z leaves the shell alone in front too, and herdr's label stays: it has not left.
        if (!shellAlone(info) || await stoppedAgentJob(info.shell_pid, "opencode", { pid: openCodePanePid(pane.pane_id) })) return;
        const again = await paneProcessInfo(pane.pane_id).catch(() => undefined);
        if (shellAlone(again) && again.shell_pid === info.shell_pid) shellSnapshots.add(pane);
      }));
    }
    return snapshot;
  } });
  omo.start();
  gjc.start();
  letta.start();
  claudeAgents.start();
  opencodeAgents.start();
  taskAgents.start();
  const waitTimer = setInterval(() => { waitsRanOut(); hookTurnWentOn(); }, 1000);
  waitTimer.unref?.();
  /** the panes a page in use shows: its terminal attached (the chat lens's too), or its chat or prompt followed without one */
  const shownPanes = (): Set<string> => {
    const shown = new Set<string>();
    for (const client of present) for (const panes of [client.data.attached.keys(), client.data.conversationWatches, client.data.promptWatches]) for (const paneId of panes) shown.add(paneId);
    return shown;
  };
  let cardTicks = 0;
  /** every terminal is due a read: kept past a read of fewer panes in flight, so a page's reads never starve the rest */
  let cardsDue = false;
  let readingAll: Promise<void> | null = null;
  const cardPace = (): Promise<void> => {
    if (cardTicks++ % CARD_UNWATCHED_EVERY === 0) cardsDue = true;
    if (cardReading !== null) {
      // a read of every terminal still under way takes the turn that falls due meanwhile: none follows it at once.
      // (read back to back while a core restarted, cards already alerted were alerted again)
      if (cardReading === readingAll) cardsDue = false;
      return cardReading;
    }
    if (cardsDue) { cardsDue = false; return readingAll = cardTick(); }
    const shown = shownPanes();
    return shown.size > 0 ? cardTick(shown) : Promise.resolve();
  };
  const stopCardTimer = (options.cardTimer ?? ((tick) => {
    const timer = setInterval(() => { void tick(); }, CARD_READ_MS);
    timer.unref?.();
    return () => clearInterval(timer);
  }))(cardPace);
  const copilotRoster = { ...cardRoster, herdrLifetime: () => currentHerdrLifetime() };
  const activityTimer = setInterval(() => {
    // Remote bridges already poll snapshots. Refresh the local roster without announcing a session replacement.
    void copilotActivity.tick(copilotRoster, () => { void machines?.refreshLocal(); }, clients.size > 0 || machines?.rosterWatched === true);
  }, 3000);
  activityTimer.unref?.();
  plans.start();

  const untrackOpenCode = trackVerifiedOpenCodePanes((paneId) => collector.trackPane(paneId), () => collector.refresh());
  const tracked = { ...collector, stop() { cardsStopped = true; clearInterval(activityTimer); copilotActivity.stop(); untrackOpenCode(); stopMutes(); stopSubmitted(); stopAnswered(); stopCardTimer(); desktopActivity?.stop(); taskAgents.stop(); stopServed(); collector.stop(); } };

  /**
   * `fresh` is asked of every caller: a wiring that dropped it would make delivery's last checks read an answer up
   * to a poll old, with every test still passing. Read fresh, a rest the queue has on the transcript's word alone,
   * herdr reading the pane at work (restingClaude), ends with a turn begun since the last read, also one a poll read
   * first. A turn herdr tells is not this: a message typed at once still commits into it.
   */
  const queueHeld = (paneId: string, fresh: boolean): boolean => {
    if (!fresh) return queueStatus(paneId, "idle") === "working";
    if (agentNow.get(paneId) !== "claude") return false;
    if (claudeAgents.loopHoldsNow(paneId)) return true;
    return (restedOnTranscript.has(paneId) || restingClaude(paneId, "claude", "working") !== "working") && !claudeAgents.restsOnNow(paneId);
  };
  /** A socket file alone proves nothing: a herdr that died can leave its file behind. */
  const currentHerdrLifetime = (): string | undefined => {
    const identity = finishes.herdrIdentity();
    return identity === null || identity !== liveHerdr ? undefined : herdrLifetime(identity);
  };
  return { push, alertWebhook, omo, gjc, letta, claudeAgents, opencodeAgents, taskAgents, plans, cards, cardTick, clientSnapshot, deliverySnapshot, currentHerdrLifetime, queueHeld, countVisit, machines, broadcastAll, logPushError, collector: tracked, waitTimer, hookTurn, contextChanged };
}
