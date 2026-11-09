/**
 * Pane status as clients and web push see it: the completion tracker, OmO's, GJC's and Claude's
 * own status, background waits, plans, the machine roster and the one collector that feeds them.
 */
import type { TailnetPcsOptions } from "../tailnet-pcs.ts";
import type { SshCandidatesOptions } from "../ssh-candidates.ts";
import { createAlertWebhook } from "../alert-webhook.ts";
import { basename, join } from "node:path";
import type { RelaySocket } from "../../shared/relay-channel.ts";
import type { AgentStatus, HerdrPane, PaneContext, PlanSummary, ServerMessage, SessionSnapshot } from "../../shared/protocol.ts";
import { alertStatus, paneAlertsMuted, pushPaneTitle } from "../../shared/notify-policy.ts";
import { AgentTaskStatus, isTaskAgent } from "../agent-tasks.ts";
import { resolveAgyStore } from "../agy-store.ts";
import { BackgroundWait } from "../background-wait.ts";
import { busyPanes, DESKTOP_ACTIVITY_FILE, trackDesktopActivity } from "../desktop-activity.ts";
import { ClaudeSubagentStatus } from "../claude-subagents.ts";
import { codexOpenRollout, paneCodexHome } from "../codex.ts";
import { startStatusCollector } from "../collector.ts";
import { CompletionTracker, type OmoRest } from "../completion.ts";
import { listHcMachines, startMachineBridge } from "../herdr-core/machine-bridge.ts";
import { coreConnection, servingCore } from "../herdr-core/runtime.ts";
import { Finishes, herdrLifetime } from "../finishes.ts";
import { claudePanePid, claudePaneSession, forgetPaneTranscriptState } from "../conversation.ts";
import { openCodeNativeState, openCodeVerificationCheckpoint, releaseOpenCodePane, trackVerifiedOpenCodePanes } from "../opencode-native.ts";
import { opencodeDatabasePath } from "../opencode.ts";
import { OpencodeSubagentStatus } from "../opencode-subagents.ts";
import { openCodeServiceOptions, readOpenCodeService } from "../opencode-service.ts";
import { processStartUpperBoundAsync } from "../process-start.ts";
import type { DeviceStore } from "../devices.ts";
import { createGjcStatus, gjcPanes, readOmoSnapshot, reconcileProviderStatus } from "../gjc-status.ts";
import { resolveGrokStore } from "../grok-store.ts";
import { createLettaStatus, lettaPanes, lettaTitleStatus } from "../letta-status.ts";
import type { HerdrMachineProfile } from "../herdr-profiles.ts";
import { paneGet, paneProcessInfo, sessionSnapshot } from "../herdr/client.ts";
import { resolveAgent } from "../pane-context.ts";
import { launchedAgents } from "../launched-agents.ts";
import { bridgeAgentNews, MachineManager } from "../machines.ts";
import { omoPanes } from "../omo.ts";
import { OMO_ALIASES, OmoStatus } from "../omo-status.ts";
import type { OrderSequence } from "../order-sequence.ts";
import type { PendingInputs } from "../pending-input.ts";
import type { PreferenceStore } from "../preferences.ts";
import { currentPrompt, onChatSubmitted, promptWaitEnded, type OpenCodePromptState } from "../prompt.ts";
import { type AlertTiming, createPushService, defaultStateDir } from "../push.ts";
import { SessionPlans } from "../session-plan.ts";
import { readStatuslineContext } from "../statusline.ts";
import { userHome } from "../user-home.ts";
import type { Telemetry } from "../telemetry.ts";
import type { UsageLoginService } from "../usage-login.ts";
import type { UsageService } from "../usage.ts";
import { type Client, send } from "./connections.ts";
import type { TelemetryIngress, TelemetrySurface } from "../../shared/telemetry.ts";

/** a focus or reconnect re-reads the panes for the daily active message at most this often */
const VISIT_READ_MS = 10 * 60_000;

export function createStatusHub<Owner, Lease>({ options, devices, preferences, clients, present, pending, drainPending, holdPendingPane, paneMoved, usage, usageLogin }: {
  options: {
    stateDir?: string;
    codexHome?: string;
    telemetry?: Telemetry;
    machines?: boolean;
    /** how PCs added through the relay reach it; tests point it at a local relay */
    relayPcSocket?: (url: string) => RelaySocket;
    /** how they dial those PCs' direct carriers; tests point it at a local listener */
    relayPcDirectSocket?: (url: string) => RelaySocket;
    /** how often another PC's own update is looked at while it runs; tests shorten it */
    pcUpdateTimings?: { pollMs?: number; startMs?: number; checkMs?: number; offerMs?: number };
    /** how other PCs on this PC's Tailscale are found (server/tailnet-pcs.ts); tests give their own status and addresses */
    tailnetPcs?: TailnetPcsOptions;
    sshCandidates?: SshCandidatesOptions;
    herdrProfiles?: () => Promise<HerdrMachineProfile[]>;
    alertTiming?: Partial<AlertTiming>;
    /** this PC's relay ID, where it has one (server/relay/service.ts serverId): devices turn its alerts off by it */
    serverId?: () => string | undefined;
    pushLoopbackHttp?: boolean;
    backgroundWait?: { grace: number; limit: number };
    statusNow?: () => number;
    /** keep desktop-activity.json for the desktop app (server/desktop-activity.ts) */
    desktopActivity?: boolean;
    openCodeState?: OpenCodePromptState;
    /** herdr's identity behind finish epochs and `herdr_lifetime` (server/finishes.ts); tests give their own */
    herdrIdentity?: () => string | null;
    /** OpenCode's store, when the server is told where it is (createServer's `opencodeDb`) */
    opencodeDb?: string;
    /** OpenCode's state dir, where its service.json is (createServer's `openCodeStateDir`) */
    openCodeStateDir?: string;
    /** this server's workspace-order counter (server/order-sequence.ts); createServer makes the one there is */
    orderSequence?: OrderSequence;
    /** herdr moved a pane of this PC under a new ID: the finishes read there go with it, numbered as counted there (server/seen.ts moved) */
    seenMoved?: (from: string, to: string, renumber: (id: number) => number) => void;
  };
  devices: DeviceStore;
  /** the preferences every browser shares (server/preferences.ts): web push reads the muted panes from it */
  preferences: PreferenceStore;
  clients: Set<Client>;
  present: Set<Client>;
  /** the pending messages' status and lifetime calls, whoever owns them (a connection, or the bridge for a first message) */
  pending: PendingInputs<Owner, Lease>;
  drainPending: (paneId: string) => void;
  holdPendingPane: (paneId: string, fault: { code: string; message: string }) => void;
  /** herdr moved a pane under a new ID: what the server keeps under the old one follows it (pending messages, the terminal) */
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
    // the persisted list, read as each alert is scheduled and again as it goes out
    muted: (machineId, paneId) => paneAlertsMuted(preferences.get().muted_panes, machineId, paneId),
    // on herdr-core the pane carries what a blocked agent waits for (server/herdr-core/snapshot.ts reportedFacts)
    lookupPane: async (paneId) => {
      const pane: Pick<HerdrPane, "agent_kind"> & Parameters<typeof pushPaneTitle>[0] = await paneGet(paneId);
      return { title: pushPaneTitle(pane), ...(pane.agent_kind ? { agent_kind: pane.agent_kind } : {}) };
    },
    // each pane alert that reached a device, for the daily active message's usage
    onAlertDelivered: () => options.telemetry?.tally("alerts_delivered"),
  });
  // a mute made while an alert waits calls it off, so an unmute cannot resurrect an old finish
  const stopMutes = preferences.subscribe(() => push.mutesChanged());

  /** `done` for agents herdr loses track of (server/completion.ts), kept across restarts */
  // on herdr-core every status is the program's own report (completion.ts reportedOnly)
  const completions = new CompletionTracker(join(options.stateDir ?? defaultStateDir(), "completions.json"), undefined, servingCore);
  const finishes = new Finishes(options.herdrIdentity);
  /** the herdr identity that answered the lifecycle subscription, bound to that connection; null while it is closed (currentHerdrLifetime) */
  let liveHerdr: string | null = null;
  /** OmO panes get their status from OmO's session files: herdr reports none for them (server/omo-status.ts) */
  const omo = new OmoStatus({
    discover: (panes) => omoPanes(panes),
    snapshot: sessionSnapshot,
    onChange: (paneId, derived, background, turn, rest) => omoChanged(paneId, derived, background, turn, rest),
    // herdr called it `claude` or `pi` until now: what it finished under that name is its own
    // a wait another agent left is not OmO's; one OmO held before it was missed a while goes on
    onFound: (paneId, again) => { completions.adopt(paneId, "omo", OMO_ALIASES); if (!again) waits.forget(paneId); },
  });
  const omoSnapshot = () => readOmoSnapshot(sessionSnapshot, omo);
  /** GJC panes get their status from gjc's own transcript: herdr's `working` can be a provider child's (server/gjc-status.ts) */
  const gjc = createGjcStatus({
    discover: (panes) => gjcPanes(panes),
    snapshot: omoSnapshot,
    onChange: (paneId, derived, _background, turn, rest) => gjcChanged(paneId, derived, turn, rest),
    onFound: (paneId) => completions.adopt(paneId, "gjc", []),
  }, omo);
  /** each Letta pane's status as its own title last said it, where nothing else gave one (letta-status.ts lettaTitleStatus) */
  const lettaTitled = new Map<string, AgentStatus>();
  /** why a Letta pane came to rest while its title said it waited for approval, told when the wait ends */
  const lettaRests = new Map<string, OmoRest>();
  /** snapshot reads in the order they began, and the newest whose titles were applied: an older read finishing late tells no turn */
  let titleReads = 0;
  let titleApplied = 0;
  /** Letta panes no report gives a status get it from Letta's own local messages (server/letta-status.ts) */
  const letta = createLettaStatus({
    // on herdr's TUI herdr gives Letta panes their status itself: only herdr-core's are Ovis's to tell
    discover: (panes) => servingCore() ? lettaPanes(panes) : Promise.resolve(new Map()),
    snapshot: omoSnapshot,
    // Letta's title says it waits for the user's approval: an answer the file reads after that was written before it
    // (an aborted or errored answer written meanwhile is kept, so that the wait's end is told as the failed rest it is)
    onChange: (paneId, derived, _background, turn, rest) => {
      if (lettaTitled.get(paneId) !== "blocked") { gjcChanged(paneId, derived, turn, rest, "letta"); return; }
      // each turn the file tells replaces the last: a later good answer leaves no earlier failure standing
      if (turn && rest !== undefined && derived !== "working") lettaRests.set(paneId, rest); else if (turn) lettaRests.delete(paneId);
    },
    onFound: (paneId) => completions.adopt(paneId, "letta", []),
  });
  /** Claude panes whose turn ended while work it started runs in the background (server/background-wait.ts) */
  const waits = new BackgroundWait(options.statusNow ?? Date.now, options.backgroundWait);
  /** the pane whose status event is reading its background work now: that event sends the one frame and alert of it */
  let settling: string | null = null;
  /** each pane's agent as the newest snapshot or status event has it, a snapshot's set before either subagent tracker reads it (owns) */
  const agentNow = new Map<string, string | null>();
  /** the read (opencodeAgents.beginRead) each pane's agentNow came from: a snapshot read before a newer word never undoes it */
  const agentRead = new Map<string, number>();
  /** each pane's agent as its status events have it, and since when: the rests from then on are that agent's (newLifetime) */
  const eventAgent = new Map<string, { agent: string | null; since: number }>();
  const statusNow = options.statusNow ?? Date.now;
  /**
   * A new lifetime in the pane: what came before is not its own. `keep`: the agent whose rests from its first status
   * event on stay, as it was seen rest before its tracker knew its session; null keeps none.
   */
  function newLifetime(paneId: string, keep: string | null): void {
    const held = waits.waiting(paneId);
    const seen = eventAgent.get(paneId);
    if (keep !== null && seen?.agent === keep) waits.resetBefore(paneId, seen.since); else waits.reset(paneId);
    claudeAgentsChanged(paneId, 0, 0, null, held);
  }
  /** OpenCode's service and when it started, looked up once per service process, off the event loop */
  let service: { pid: number; started: number | null } | null = null;
  /** Claude panes count the subagents and commands they run as background tasks, read from the session's own files (server/claude-subagents.ts) */
  const claudeAgents = new ClaudeSubagentStatus({
    resolve: claudePaneSession,
    pid: claudePanePid,
    // a pane that left Claude Code for another agent keeps what that agent was seen do there since
    onReset: (paneId) => {
      const agent = agentNow.get(paneId) ?? null;
      if (owns(paneId, "claude")) newLifetime(paneId, agent === "claude" ? null : agent);
    },
    onChange: (paneId, running, turnRunning, promptAt) => {
      if (agentNow.get(paneId) !== "claude" || !owns(paneId, "claude")) return;
      claudeAgentsChanged(paneId, running, turnRunning, promptAt, false, "claude");
      // the queue's hold came or went with the pane's status unchanged: its queued input is told now
      const status = completions.current(paneId);
      if (status !== undefined && paneId !== settling && pending.current(paneId) !== queueStatus(paneId, status)) { pending.status(paneId, queueStatus(paneId, status)); drainPending(paneId); }
    },
  });
  /** herdr's last word on each Claude pane, before restingClaude took it for a rest */
  const heard = new Map<string, AgentStatus>();
  /**
   * herdr's status for a pane, as the session's own transcript has it: Claude keeps its busy title
   * up while a background subagent works after its turn ended, and herdr reads `working` (#2069).
   * That pane rests, and background-wait.ts holds it as waiting on that work.
   */
  function restingClaude(paneId: string, agent: string | null | undefined, status: AgentStatus): AgentStatus {
    if (agent !== "claude" || agentNow.get(paneId) !== "claude") return status;
    if (status !== "working" || omo.runs(paneId) || gjc.runs(paneId)) return status;
    return claudeAgents.restsOn(paneId) ? "idle" : status;
  }
  /**
   * herdr's raw word on a Claude pane; a projection or a tracker callback never is. Its working
   * event may be a turn the transcript does not show yet (ClaudeSubagentStatus.busy), even with no
   * idle before it: the subagents' spinner keeps herdr at working across turns. A snapshot or a
   * replay says so only when it moves a pane heard before to working: the first one heard of is
   * at work since before it was looked at, as its transcript says.
   */
  function hearClaude(paneId: string, agent: string | null | undefined, status: AgentStatus, event: boolean): void {
    if (agent !== "claude") { heard.delete(paneId); return; }
    const before = heard.get(paneId);
    heard.set(paneId, status);
    if (status === "working" && (event || (before !== undefined && before !== "working"))) claudeAgents.busy(paneId, "herdr");
    else if (status !== "working") claudeAgents.quiet(paneId, event);
  }
  /**
   * The status the pane's queued input goes by: a Claude pane shown at rest while a busy signal
   * whose turn was never written holds it (ClaudeSubagentStatus.holdsQueue) is not ready for it.
   */
  function queueStatus(paneId: string, status: AgentStatus): AgentStatus {
    return heard.get(paneId) === "working" && agentNow.get(paneId) === "claude" && claudeAgents.holdsQueue(paneId) && (status === "idle" || status === "done") ? "working" : status;
  }
  // a prompt the chat sent may be a turn the transcript does not show yet. Not so a slash command,
  // which can run with no turn (`/model`), nor a message Claude Code may hold: what they start is
  // told by the transcript. The status stays herdr's: a pane it reads idle is not made working
  const stopSubmitted = onChatSubmitted((paneId, prompt, sentAt) => {
    if (!prompt || agentNow.get(paneId) !== "claude" || omo.runs(paneId) || gjc.runs(paneId)) return;
    claudeAgents.busy(paneId, "chat", sentAt);
  });
  /** OpenCode panes count their subagents too: child sessions in OpenCode's store (server/opencode-subagents.ts) */
  const opencodeAgents = new OpencodeSubagentStatus({
    store: () => options.opencodeDb ?? opencodeDatabasePath(),
    // Settings -> Read OpenCode subagent ends from their session (experimental)
    parentEnds: () => preferences.get().settings.opencodeParentEnds === true,
    // the runs are its service's: one that started since took what ran before it
    serviceStart: () => {
      const found = readOpenCodeService(options.openCodeStateDir ?? openCodeServiceOptions.stateDir);
      if (found === null) return null;
      if (service?.pid !== found.pid) {
        // until the lookup answers no run is taken for one the service before took along; then the store is read again
        // at once. A lookup with no answer is asked again
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
    // a count that fell only because that setting was turned off ended no work: no grace is held for it
    onChange: (paneId, running, turnRunning, promptAt, toggled) => { if (owns(paneId, "opencode")) claudeAgentsChanged(paneId, running, turnRunning, promptAt, false, null, toggled); },
  });
  /** agy and grok panes count their sessions' background tasks and timers (server/agent-tasks.ts) */
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
  /**
   * Whether a subagent tracker's word on a pane's count and wait stands: not once OmO runs there, nor
   * the other tracker's agent on a session that tracker holds, whose count and wait the pane's are now
   * (a tracker left behind says 0 as it lets go, and that must not end the new agent's wait). Which
   * agent runs there is the newest snapshot's word, not the other tracker's: that one may not have
   * read the snapshot yet, and would keep the wait of the agent it ran for from being dropped.
   */
  function owns(paneId: string, tracker: "claude" | "opencode"): boolean {
    if (omo.runs(paneId)) return false;
    const agent = agentNow.get(paneId);
    const other = tracker === "claude" ? "opencode" : "claude";
    if (agent !== undefined && agent !== other) return true;
    return (tracker === "claude" ? opencodeAgents : claudeAgents).sessionOf(paneId)?.live !== true;
  }
  /** the plan each Claude Code, Codex and OmO pane keeps, and the context each Claude Code and Codex pane filled, for the sidebar (server/session-plan.ts) */
  const plans = new SessionPlans({
    claudePath: (paneId) => claudeAgents.sessionOf(paneId)?.path ?? null,
    omoPath: (paneId) => omo.pathOf(paneId),
    // only what is certain without reading the screen: the chat's own matching stays the chat's
    codexPath: async (pane) => codexOpenRollout(pane.pane_id, pane.cwd, await paneCodexHome(pane.pane_id, options.codexHome)),
    onChange: (paneId, summary) => planChanged(paneId, summary),
    onContext: (paneId, context) => contextChanged(paneId, context),
    // the window the chat's ring takes for a Claude session (conversation.ts)
    claudeWindow: (path, model) => readStatuslineContext(userHome(), basename(path, ".jsonl"), model, path),
  });
  /** herdr's snapshot with OmO's and GJC's own status in it: what the completion tracker and web push are given */
  const rawSnapshot = async (): Promise<SessionSnapshot> => {
    const titleRead = ++titleReads;
    const promptCheckpoint = options.openCodeState?.checkpoint();
    const read = opencodeAgents.beginRead();
    const snapshot = await omoSnapshot();
    await gjc.refresh(snapshot.panes);
    // a report or another agent takes a pane back from Letta's own files
    for (const pane of snapshot.panes) if (letta.runs(pane.pane_id) && (pane.agent !== "letta" || pane.agent_status !== "unknown")) letta.ended(pane.pane_id);
    await letta.refresh(snapshot.panes);
    const named = letta.apply(gjc.apply(omo.apply(snapshot)));
    // reads overlap (the collector's, each client's): only one newer than every read applied before tells title turns
    const newest = titleRead > titleApplied;
    if (newest) titleApplied = titleRead;
    if (servingCore()) for (const { paneId, status } of lettaTitleStatus(named, (paneId) => letta.tracks(paneId), lettaTitled, newest)) {
      const rest = status === "idle" ? lettaRests.get(paneId) : undefined;
      if (status !== "blocked") lettaRests.delete(paneId);
      gjcChanged(paneId, status, true, rest, "letta");
    }
    const ids = new Set(named.panes.map((pane) => pane.pane_id));
    for (const paneId of [...agentNow.keys()]) {
      if (ids.has(paneId) || (agentRead.get(paneId) ?? 0) > read) continue;
      agentNow.delete(paneId);
      agentRead.delete(paneId);
      eventAgent.delete(paneId);
      heard.delete(paneId);
    }
    for (const pane of named.panes) {
      if ((agentRead.get(pane.pane_id) ?? 0) > read) continue;
      agentNow.set(pane.pane_id, pane.agent ?? null);
      agentRead.set(pane.pane_id, read);
      hearClaude(pane.pane_id, pane.agent, pane.agent_status, false);
    }
    // not waited for: finding a transcript costs process calls, and a snapshot must not wait on them.
    // The plans come after: a Claude pane's transcript is the one the subagent tracker found
    void claudeAgents.refresh(named.panes).catch(() => undefined).then(() => plans.refresh(named.panes)).catch(() => undefined);
    void opencodeAgents.refresh(named.panes, read);
    void taskAgents.refresh(named.panes).catch(() => undefined);
    // an agent this server started has had no turn yet: its start screen is no work (launched-agents.ts)
    for (const pane of named.panes) {
      pane.agent_status = launchedAgents.settle(pane.pane_id, pane.agent_status);
      // Snapshot discovery announces through the same callback as a timer poll. The collector
      // receives raw status, so its later replay cannot overwrite herdr's working evidence.
      if (pane.agent === "claude" && agentNow.get(pane.pane_id) === "claude") claudeAgents.poll(pane.pane_id);
    }
    options.openCodeState?.reconcile(named.panes, promptCheckpoint);
    return named;
  };
  const backgroundOf = (paneId: string): number => omo.backgroundOf(paneId) || claudeAgents.countOf(paneId) || opencodeAgents.countOf(paneId) || taskAgents.countOf(paneId);
  /** the snapshot clients get: finishes settled, OmO panes named, background tasks, waits, plan progress and context */
  const clientSnapshot = async (): Promise<SessionSnapshot> => {
    // the order this read can show is the one of the moves confirmed before it starts: taken before any wait,
    // and again by a read started afresh below
    const order = options.orderSequence?.read();
    const epoch = finishes.epoch;
    const identity = finishes.herdrIdentity();
    const snapshot = await completions.readSnapshot(async () => {
      const raw = await rawSnapshot();
      return { ...raw, panes: raw.panes.map((pane) => ({ ...pane, agent_status: restingClaude(pane.pane_id, pane.agent, pane.agent_status) })) };
    });
    // A read spanning a proven daemon replacement belongs to neither generation. Read afresh.
    if (epoch !== finishes.epoch) return clientSnapshot();
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
        const context = plans.contextOf(pane.pane_id);
        return background > 0 || waiting || plan !== null || context !== null ? { ...pane, ...(background > 0 ? { background_tasks: background } : {}), ...(waiting ? { background_wait: true as const } : {}), ...(plan !== null ? { plan } : {}), ...(context !== null ? { context } : {}) } : pane;
      }),
    }, completions);
    return order ? { ...settled, ...order } : settled;
  };
  /**
   * A browser visit for the daily active message: the call is made now so the visit's day is the
   * trigger's, the panes are read after. Nothing is read while telemetry cannot send; a socket open
   * passes the snapshot it fetches anyway, and other visits read the panes at most every
   * VISIT_READ_MS (in between they still count the day, with the kinds already known).
   */
  let visitReadAt = -Infinity;
  function countVisit(snapshot?: ReturnType<typeof clientSnapshot>, visit: { surface?: TelemetrySurface; ingress?: TelemetryIngress } = {}): void {
    const telemetry = options.telemetry;
    if (!telemetry?.counting()) return;
    let agents: Promise<(string | null)[]> | (string | null)[] = [];
    if (snapshot || Date.now() - visitReadAt >= VISIT_READ_MS) {
      visitReadAt = Date.now();
      agents = (snapshot ?? clientSnapshot()).then((read) => read.panes.map((pane) => resolveAgent(pane).agent));
    }
    void telemetry.active(agents, visit)
      .catch((error) => console.error(`telemetry: the visit was not counted (${error instanceof Error ? error.message : String(error)})`));
  }
  /** A pane's status frame: every one says whether the pane waits on its turn's background work. */
  const paneStatus = (paneId: string, status: AgentStatus, about: { background_tasks?: number; plan?: PlanSummary | null; context?: PaneContext | null } = {}): ServerMessage =>
    ({ type: "pane-status", pane_id: paneId, agent_status: status, ...finishes.status(paneId, status), ...about, ...(waits.waiting(paneId) ? { background_wait: true as const } : {}) });
  const machines = options.machines === false ? null : new MachineManager(options.stateDir ?? defaultStateDir(), push, completions, clientSnapshot, { restoreReplaced: () => preferences.get().settings.restoreReplacedServer === true, bootId: options.orderSequence?.epoch, localFinishEpoch: () => finishes.epoch, relaySocket: options.relayPcSocket, relayDirectSocket: options.relayPcDirectSocket, serverId: options.serverId, tailnet: options.tailnetPcs, sshCandidates: options.sshCandidates, ...(options.pcUpdateTimings ? { ownUpdate: options.pcUpdateTimings } : {}) });
  if (machines && options.herdrProfiles) machines.watchHerdrProfiles(options.herdrProfiles);
  // on herdr-core, the core's other machines are PCs too, each reached through this PC's core
  if (machines && servingCore()) machines.watchHcMachines(() => listHcMachines(coreConnection()), (machine) => startMachineBridge(machine, options.stateDir ?? defaultStateDir()));

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

  /** Status of EVERY pane, attached or not: one collector feeds all connected clients and web push. */
  function omoChanged(paneId: string, derived: AgentStatus, background: number, turn: boolean, rest: OmoRest | undefined): void {
    // OmO's own turn, which herdr's status never shows: back at work, its form has had its answer
    if (turn && derived === "working") promptWaitEnded(paneId);
    // a background task starting or ending is no turn: the status stands, and nothing is alerted.
    // A turn that ended in an error is at rest, not finished; an answer after it is a finish (#687)
    const status = turn ? completions.observe(paneId, derived, "omo", rest) : completions.current(paneId) ?? completions.observe(paneId, derived, "omo");
    if (turn) { pending.status(paneId, status); drainPending(paneId); }
    // a turn that ended while tasks its session started still run waits on them, as a Claude
    // pane's does (background-wait.ts): BG, not DONE, and a finish alerted once the work is over.
    // The count first: a turn that ends in the same read as its tasks were counted is held at once.
    // No time limit: the count drops a task whose host died, and a task's end wakes OmO
    const held = waits.waiting(paneId);
    waits.running(paneId, background, null, false);
    if (turn) waits.status(paneId, status);
    broadcastAll(paneStatus(paneId, status, { background_tasks: background }));
    if (turn || waits.waiting(paneId) !== held) push.onStatus(paneId, alertStatus(status, waits.waiting(paneId))).catch(logPushError);
    // after the status: its change calls off what was waiting, and this error is what the rest says
    if (turn && rest === "failed" && status === "idle") push.onFailed(paneId).catch(logPushError);
  }

  /**
   * A GJC pane's own turn, which herdr's provider-child status never shows: back at work, its
   * form has had its answer. gjc keeps no background records to count, so a change is always a
   * turn, and an idle read after work is the finish — one ended in an error is not (#687).
   */
  function gjcChanged(paneId: string, derived: AgentStatus, turn: boolean, rest: OmoRest | undefined, agent: "gjc" | "letta" = "gjc"): void {
    if (turn && derived === "working") promptWaitEnded(paneId);
    const status = turn ? completions.observe(paneId, derived, agent, rest) : completions.current(paneId) ?? completions.observe(paneId, derived, agent);
    if (turn) { pending.status(paneId, status); drainPending(paneId); }
    broadcastAll(paneStatus(paneId, status));
    if (turn) push.onStatus(paneId, status).catch(logPushError);
    if (turn && rest === "failed" && status === "idle") push.onFailed(paneId).catch(logPushError);
  }

  /**
   * A Claude pane's subagents or background commands, or an OpenCode pane's subagents, started or
   * ended: no turn, so the status stands. Nothing is alerted unless the pane began or stopped waiting on its turn's work at rest:
   * the alerts took it for working meanwhile, so a wait that ends with no turn after it is that
   * turn's finish, told then.
   */
  function claudeAgentsChanged(paneId: string, running: number, turnRunning: number, promptAt: number | null, resetHold = false, agent: string | null = null, settled = false, capped = true): void {
    const changed = waits.running(paneId, turnRunning, promptAt, capped, settled) || resetHold;
    if (paneId === settling) return;
    // a pane herdr reads as working: its session's turn came to rest under its subagents' spinner, or moved on again
    if (agent === "claude" && agentNow.get(paneId) === "claude" && !gjc.runs(paneId) && heard.get(paneId) === "working" && (completions.current(paneId) === "working") === claudeAgents.restsOn(paneId)) {
      reportStatus(paneId, restingClaude(paneId, agent, "working"), agent);
      return;
    }
    const status = completions.current(paneId);
    // a pane never reported here carries its count in the next snapshot
    if (status === undefined) return;
    broadcastAll(paneStatus(paneId, status, { background_tasks: running }));
    if (changed) push.onStatus(paneId, alertStatus(status, waits.waiting(paneId))).catch(logPushError);
  }

  /** A wait ran out (its work ended and no turn followed, or it was held as long as one is): the status it stood for. */
  function waitsRanOut(): void {
    for (const paneId of waits.tick()) {
      const status = completions.current(paneId);
      if (status === undefined) continue;
      broadcastAll(paneStatus(paneId, status));
      push.onStatus(paneId, alertStatus(status, waits.waiting(paneId))).catch(logPushError);
    }
  }

  /** A pane's plan moved on: keep its current status and background wait, and alert nothing. */
  function planChanged(paneId: string, plan: PlanSummary | null): void {
    const status = completions.current(paneId);
    if (status !== undefined) broadcastAll(paneStatus(paneId, status, { plan }));
  }

  function contextChanged(paneId: string, context: PaneContext | null): void {
    const status = completions.current(paneId);
    if (status !== undefined) broadcastAll(paneStatus(paneId, status, { context }));
  }

  // a bridge (no roster of its own) tells its connection server instead (#555)
  const bridgeAgents = machines ? null : bridgeAgentNews(() => broadcastAll({ type: "session-changed" }));

  /** A status herdr reported for a pane, or one read back from a snapshot around a gap (`replay`). */
  function onStatus(paneId: string, read: AgentStatus, agent: string | null, replay?: { before: AgentStatus; agent: string | null }): void {
    if (agent !== "opencode" && (!replay || agent || read !== "unknown")) {
      options.openCodeState?.forget(paneId);
      // Snapshot replays release in onReconciled, with the snapshot's verification checkpoint.
      if (!replay) releaseOpenCodePane(paneId);
    }
    // The agent identity precedes the poll: a delayed Claude callback cannot finish its successor.
    agentNow.set(paneId, agent);
    const was = settling;
    settling = paneId;
    try {
      hearClaude(paneId, agent, read, replay === undefined);
      if (agent === "claude") claudeAgents.poll(paneId);
    } finally { settling = was; }
    // a live report makes what the title said before it stale
    if (agent === "letta" && read !== "unknown" && replay === undefined) lettaTitled.delete(paneId);
    // an unreported Letta pane on herdr-core has no word of herdr's: what its own title last said stands for it
    const titled = agent === "letta" && read === "unknown" && servingCore() && !letta.tracks(paneId) ? lettaTitled.get(paneId) : undefined;
    const raw = restingClaude(paneId, agent, launchedAgents.settle(paneId, titled ?? read));
    gjc.poll();
    // a report or another agent takes the pane back from Letta's own files
    // a replay around a gap carries Ovis's own projected status, not herdr's word: only another agent hands the pane back then
    if (letta.runs(paneId) && (agent !== "letta" || (replay === undefined && read !== "unknown"))) letta.ended(paneId);
    letta.poll();
    // read back from a snapshot around a gap between subscriptions. An OmO pane's status there
    // is OmO's own or herdr's by turns (server/omo-status.ts), and a difference is no change;
    // a GJC pane's may be a provider child's while gjc's own transcript is tracked
    if (replay && (omo.runs(paneId) || gjc.tracks(paneId) || letta.tracks(paneId) || !completions.replayed(paneId, raw, replay))) return;
    // Native OmO discovery owns the pane even when herdr names its provider child.
    if (reconcileProviderStatus(omo, gjc, { pane_id: paneId, agent })) completions.forget(paneId);
    // the frame below names no agent: one herdr names anew is read into the roster now. An OmO
    // pane is `omo` in every snapshot, whatever herdr calls it in an event
    const named = [{ pane_id: paneId, agent: omo.runs(paneId) ? "omo" : gjc.runs(paneId) ? "gjc" : agent }];
    if (machines) machines.localAgents(named); else bridgeAgents!.status(named);
    // newer than the last snapshot: a route that looks the pane's session up before the next one reads it so
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
    reportStatus(paneId, raw, agent);
  }

  /** Publish an effective status without treating a transcript projection as a new herdr event. */
  function reportStatus(paneId: string, raw: AgentStatus, agent: string | null): void {
    // back at work, the agent has had its answer, maybe from a terminal: the same prompt on
    // its screen after this is another asking, which an answer to the old card must not take.
    // Only for a status that counts: a replay that changed nothing and herdr's word on an OmO
    // pane (omoChanged has OmO's own) end no asking
    if (raw === "working") promptWaitEnded(paneId);
    // an agent herdr lost on the way still works and finishes as such (server/completion.ts);
    // an OmO pane whose session is not known keeps herdr's status, under its own name
    const status = completions.observe(paneId, raw, omo.runs(paneId) ? "omo" : gjc.runs(paneId) ? "gjc" : agent);
    pending.status(paneId, queueStatus(paneId, status)); drainPending(paneId);
    // a Claude turn that ended holds on its background work: what it started is read now, while
    // the pane is still taken for the status before (work that ended before the turn did holds
    // nothing), and this frame says all of it, so none says the pane finished first
    // so does an OpenCode turn on the subagents it started, and an agy or grok one on its tasks
    const tracker = omo.runs(paneId) ? null : agent === "claude" ? claudeAgents : agent === "opencode" ? opencodeAgents : isTaskAgent(agent) ? taskAgents : null;
    if (tracker !== null) {
      settling = paneId;
      try { void tracker.poll(paneId); } finally { settling = null; }
      waits.status(paneId, status);
    } else waits.forget(paneId);
    broadcastAll(paneStatus(paneId, status, tracker !== null ? { background_tasks: tracker.countOf(paneId) } : {}));
    push.onStatus(paneId, alertStatus(status, waits.waiting(paneId))).catch(logPushError);
    // an OpenCode turn whose session is not known yet: its pane is looked up now, not at the next snapshot, so a
    // turn that ended on its subagents is held while the finish alert still waits (and is called off)
    if (tracker === opencodeAgents && opencodeAgents.sessionOf(paneId)?.live !== true) {
      const begun = opencodeAgents.beginRead();
      void paneGet(paneId).then((pane) => { if (opencodeAgents.ensure(pane, begun)) void opencodeAgents.poll(paneId); }).catch(() => undefined);
    }
    // so is an agy or grok one, or one whose session was looked up a while ago: the agent may have restarted there
    if (tracker === taskAgents && taskAgents.stale(paneId)) void paneGet(paneId).then((pane) => taskAgents.track(pane)).catch(() => undefined);
  }

  // Process proof belongs to this exact snapshot, so the collector's newer-event guards
  // cover the process read too. Never turn an unknown handover snapshot into an agent exit.
  const shellSnapshots = new WeakSet<HerdrPane>();
  const snapshotVerifications = new WeakMap<HerdrPane, number>();
  // what a pane that is gone held, whether it ended by itself or was closed; safe to run twice
  // (a program that ended and whose pane then closed)
  function paneGone(paneId: string): void {
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
    agentNow.delete(paneId);
    agentRead.set(paneId, opencodeAgents.beginRead());
    eventAgent.delete(paneId);
    // the terminal is gone, so is whatever its chat parsed (server/conversation.ts)
    forgetPaneTranscriptState(paneId);
    bridgeAgents?.ended(paneId);
  }
  const collector = startStatusCollector({
    onStatus,
    // the herdr this server's lifecycle subscription was answered by, while that subscription is open
    herdrLive: { identity: () => finishes.herdrIdentity(), onChange: (identity) => { liveHerdr = identity; } },
    // a finish reported as done, now in front at herdr's terminal: seen, idle again
    onFocus: (paneId, passing) => {
      // The split canvas follows herdr's focused pane (also the sole visible pane while zoomed).
      broadcastAll({ type: "session-changed" });
      // a pane herdr's focus passed over while a move took the focused pane out and back: nobody looked at it
      if (passing) return;
      // a browser set to follow herdr's focus opens the pane (#311)
      broadcastAll({ type: "pane-focused", pane_id: paneId });
      if (!completions.seen(paneId)) return;
      pending.status(paneId, queueStatus(paneId, "idle")); drainPending(paneId);
      broadcastAll(paneStatus(paneId, "idle"));
      push.onStatus(paneId, alertStatus("idle", waits.waiting(paneId))).catch(logPushError);
    },
    onBaseline: (panes) => {
      const projected = panes.map((pane) => ({ ...pane, agent_status: restingClaude(pane.pane_id, pane.agent, pane.agent_status) }));
      // A resting baseline never reholds old work after a bridge restart.
      for (const pane of projected) if (pane.agent === "claude" || pane.agent === "opencode" || isTaskAgent(pane.agent)) waits.seed(pane.pane_id, pane.agent_status);
      push.seed(projected.map((pane) => ({ ...pane, agent_status: alertStatus(pane.agent_status, waits.waiting(pane.pane_id)) })));
      for (const pane of projected) {
        // A fast mirrored client may queue before the collector's first baseline. A
        // known ready baseline can schedule a fresh guarded check even when the tracker
        // still remembers working; an unknown baseline never supplies that permission.
        const status = pane.agent_status === "idle" || pane.agent_status === "done" ? pane.agent_status : completions.current(pane.pane_id) ?? pane.agent_status;
        pending.status(pane.pane_id, queueStatus(pane.pane_id, status)); drainPending(pane.pane_id);
      }
    },
    // a pane created a moment ago got its agent after the roster's own read of it. After the
    // snapshot's replays: a roster read before them could show a finish ahead of its status frame
    onReconciled: (panes) => {
      // only a verified pane holds the stream: a verification still in flight settles for itself, and
      // a snapshot read before it started must not cancel it
      const verified = new Set(openCodeNativeState().panes);
      for (const pane of panes) {
        if (!verified.has(pane.pane_id) || pane.agent === "opencode") continue;
        if (pane.agent || pane.agent_status !== "unknown" || shellSnapshots.has(pane)) releaseOpenCodePane(pane.pane_id, snapshotVerifications.get(pane));
      }
      if (machines) machines.localAgents(panes); else bridgeAgents!.reconciled(panes);
    },
    // the tracker first: what it makes of each pane (a finish after work is done, not idle) is
    // what the alerts are measured against from here, or the next event would alert of it
    onResync: (panes, newer) => {
      const projected = panes.map((pane) => ({ ...pane, agent_status: restingClaude(pane.pane_id, pane.agent, pane.agent_status) }));
      finishes.resync(completions, projected, newer);
      const settled = (pane: HerdrPane): AgentStatus => completions.current(pane.pane_id) ?? pane.agent_status;
      for (const pane of panes) { pending.status(pane.pane_id, queueStatus(pane.pane_id, settled(pane))); drainPending(pane.pane_id); }
      for (const pane of panes) if (!newer.has(pane.pane_id) && (pane.agent === "claude" || pane.agent === "opencode" || isTaskAgent(pane.agent))) waits.status(pane.pane_id, settled(pane));
      push.resync(panes.map((pane) => ({ ...pane, agent_status: alertStatus(settled(pane), waits.waiting(pane.pane_id)) })), newer);
    },
    onPaneEnded: (paneId) => {
      paneGone(paneId);
      broadcastAll({ type: "pane-exited", pane_id: paneId });
      push.onEnded(paneId).catch(logPushError);
    },
    // closed, not ended by itself: the same cleanup with no "terminal ended" alert
    onPaneClosed: (paneId) => paneGone(paneId),
    // told first, so a client remaps the pane before the pty-exit and pending lists of the old ID reach it,
    // and before the structure change's roster no longer has that ID (#1503)
    onPaneMoved: (from, to) => {
      // its finishes go on counting under the new ID, and what was read of them is read there (server/seen.ts)
      const renumber = finishes.moved(from, to);
      // a read record that cannot be written costs that record, never the rest of the move
      try { options.seenMoved?.(from, to, renumber); }
      catch (error) { console.warn(`seen: could not carry the reads of ${from} to ${to}:`, error); }
      broadcastAll({ type: "pane-moved", from, to });
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
      await Promise.all(snapshot.panes.map(async (pane) => {
        if (pane.agent || pane.agent_status !== "unknown" || !verified.has(pane.pane_id)) return;
        const info = await paneProcessInfo(pane.pane_id).catch(() => undefined);
        const front = info?.foreground_processes?.[0];
        // `exec opencode` keeps the shell's pid, but not its process identity.
        const shell = /(?:^|\/)-?(?:sh|bash|dash|zsh|fish|ksh|mksh|csh|tcsh|ash|nu)$/u;
        if (info?.shell_pid != null && info.foreground_processes?.length === 1 && front?.pid === info.shell_pid
          && shell.test(front.name) && shell.test(front.argv?.[0] ?? front.argv0 ?? front.name)) shellSnapshots.add(pane);
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
  const waitTimer = setInterval(waitsRanOut, 1000);
  waitTimer.unref?.();
  plans.start();

  // a verified OpenCode pane is tracked like a usage-login pane: its end or close reaches paneGone above
  const untrackOpenCode = trackVerifiedOpenCodePanes((paneId) => collector.trackPane(paneId));
  const tracked = { ...collector, stop() { untrackOpenCode(); stopMutes(); stopSubmitted(); desktopActivity?.stop(); taskAgents.stop(); collector.stop(); } };

  const queueHeld = (paneId: string): boolean => queueStatus(paneId, "idle") === "working";
  /**
   * The herdr this server reads now, as a snapshot names it, known without asking herdr anything: only the
   * one whose lifecycle subscription is open, under the same socket. A socket file alone proves nothing: a
   * herdr that died can leave its file behind. undefined proves none.
   */
  const currentHerdrLifetime = (): string | undefined => {
    const identity = finishes.herdrIdentity();
    return identity === null || identity !== liveHerdr ? undefined : herdrLifetime(identity);
  };
  return { push, alertWebhook, omo, gjc, letta, claudeAgents, opencodeAgents, taskAgents, plans, clientSnapshot, currentHerdrLifetime, queueHeld, countVisit, machines, broadcastAll, logPushError, collector: tracked, waitTimer };
}
