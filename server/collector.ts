import type { AgentStatus, HerdrPane } from "../shared/protocol.ts";
import { focusFromMove, HerdrError, sessionSnapshot, subscribeEvents, type EventFrame, type Subscription } from "./herdr/client.ts";

/**
 * herdr's subscription surface (verified against protocol 22):
 * - `pane.agent_status_changed` REQUIRES a pane_id, but one connection carries any
 *   number of per-pane subscriptions, so all panes share a single status connection.
 * - A second `events.subscribe` request on an already-open connection is silently
 *   ignored: when the pane set changes the status connection must be re-opened with
 *   the full set (see `reconcile`).
 * - Workspace, tab, pane and layout lifecycle events subscribe globally (no pane_id)
 *   and coalesce structure broadcasts and authoritative pane-set reconciliation.
 *   `pane.moved` changes pane IDs without emitting close/create events.
 * - `pane.focused` subscribes globally too, and fires for a tab or workspace brought to the
 *   front as well (`{event:"pane_focused", data:{type, pane_id, workspace_id}}`).
 *
 * - herdr (0.9.2+) closes a subscription that fell behind, after an `events_lost` error
 *   that never arrives when the socket's buffer is full (seen on 0.9.3): every connection
 *   here reopens itself on the close alone, and whatever it missed is read back from a
 *   snapshot taken once the new subscription has started (herdr's documented order).
 *
 * - A status that changed while no subscription was listening for the pane is never sent
 *   again: the pane set changed (a pane opened or closed elsewhere) and the status connection
 *   was being reopened with the new set, herdr refused a batch for a pane that had gone, or
 *   the server had only just started. A finish in that gap cost its done alert (#245: with
 *   panes opening and closing beside it, a pane's one status change was lost in 5 of 10
 *   runs). Such a gap is short and known, so the first snapshot after the new subscription
 *   started is measured against each pane's status as last told (by an event, or by an
 *   earlier replay), and a difference is told as that event (`replay`). Nothing else is,
 *   and no other snapshot moves what a pane was last told as: a snapshot at any other time
 *   may differ from the last event for reasons that are no change (herdr reads a finish
 *   nobody saw as `done` here and `idle` there), or be ahead of an event still on its way,
 *   and what was missed over an outage of unknown length (`events_lost`, a herdr that could
 *   not be reached) is corrected without alerts (`onResync`).
 *   The snapshot that shows the pane set changed is such evidence too: the connection is
 *   closed on its account, and an event herdr had sent but this side had not read yet goes
 *   with it (traced: the snapshot already showed `unknown`, the event for it never came).
 *
 * - A pane created while this listens has no status subscription until a snapshot shows it: a question it asked or a
 *   finish in that time is the snapshot's first reading, which takes it silently. Its creation frame carries the status
 *   it began with, kept apart from what a pane was last told as (`born`): that baseline stays the snapshot's, as for any
 *   pane, and only web push is handed the creation status, to alert a first change from (`onBaseline`'s `created`).
 *
 * Status frames are flat (`{event:"pane.agent_status_changed", data:{pane_id, agent_status, ...}}`)
 * while structure frames carry a snake_case `data.type` - both shapes below parse only
 * what the live server actually sends.
 */

const RECONNECT_MIN_MS = 250;
const RECONNECT_MAX_MS = 5_000;
const BACKSTOP_INTERVAL_MS = 60_000;
const RECONCILE_DEBOUNCE_MS = 500;
const SNAPSHOT_RETRY_MS = 5_000;
/**
 * A snapshot is answered on its own connection and can overtake events herdr sent before it
 * (working, then idle, both still unread when the snapshot already said idle). What a
 * snapshot is about to replay waits this long first, and an event that came in meanwhile wins.
 */
const REPLAY_SETTLE_MS = 150;

export interface StatusCollectorHandlers {
  /** `replay.askedAt`: when the snapshot the replayed status was read from was asked for (`Date.now()`) */
  onStatus: (paneId: string, status: AgentStatus, agent: string | null, replay?: { before: AgentStatus; agent: string | null; askedAt?: number }) => void;
  /**
   * `newer`: panes with an event or an exit since the snapshot was asked for, whose reading here is older than that.
   * `askedAt`: when it was asked for (`Date.now()`).
   * `created`: the status each pane this snapshot reads first began with, from its creation frame, for web push alone
   * (the panes' baseline is this snapshot's, as for any pane)
   */
  onBaseline: (panes: readonly HerdrPane[], newer: ReadonlySet<string>, askedAt: number, created: ReadonlyMap<string, AgentStatus>) => void;
  onResync?: (panes: readonly HerdrPane[], newer: ReadonlySet<string>, askedAt: number) => void;
  onReconciled?: (panes: readonly HerdrPane[]) => void;
  onPaneEnded: (paneId: string) => void;
  /**
   * A pane closed with no exit frame (herdr's `pane.close`, hc's `terminal.kill`): what it held goes,
   * but nothing ended by itself, so no "terminal ended" alert. It can follow `onPaneEnded` for a
   * program that ended and whose pane then closed.
   */
  onPaneClosed?: (paneId: string) => void;
  onPaneMoved?: (previousPaneId: string, paneId: string) => void;
  onStructureChange: () => void;
  /**
   * A herdr that died closes it, while its socket file can stay behind; a file replaced meanwhile names none.
   */
  herdrLive?: { identity: () => string | null; onChange: (identity: string | null) => void };
  onFocus?: (paneId: string, passing: boolean) => void;
}

export interface StatusCollectorDeps {
  subscribe: typeof subscribeEvents;
  snapshot: () => Promise<{ panes: HerdrPane[] }>;
  reconnectMinMs: number;
  reconnectMaxMs: number;
  backstopMs: number;
  debounceMs: number;
  snapshotRetryMs: number;
  replaySettleMs: number;
}

const DEFAULT_DEPS: StatusCollectorDeps = {
  subscribe: subscribeEvents,
  snapshot: () => sessionSnapshot(),
  reconnectMinMs: RECONNECT_MIN_MS,
  reconnectMaxMs: RECONNECT_MAX_MS,
  backstopMs: BACKSTOP_INTERVAL_MS,
  debounceMs: RECONCILE_DEBOUNCE_MS,
  snapshotRetryMs: SNAPSHOT_RETRY_MS,
  replaySettleMs: REPLAY_SETTLE_MS,
};

export interface StatusCollector {
  ready: Promise<void>;
  structureReady: Promise<void>;
  focusReady: Promise<void>;
  trackPane: (paneId: string) => void;
  refresh: () => void;
  stop: () => void;
}

/**
 * `displayAgent` is the line a plugin reports for the agent (`report-metadata --display-agent`), absent from the frame when none is.
 */
export function parseStatusFrame(frame: EventFrame): { paneId: string; status: AgentStatus; agent: string | null; displayAgent: string | null } | null {
  if (frame.event !== "pane.agent_status_changed") return null;
  const data = frame.data as { pane_id?: unknown; agent_status?: unknown; agent?: unknown; display_agent?: unknown } | undefined;
  if (typeof data?.pane_id !== "string" || typeof data.agent_status !== "string") return null;
  return { paneId: data.pane_id, status: data.agent_status as AgentStatus, agent: typeof data.agent === "string" ? data.agent : null, displayAgent: typeof data.display_agent === "string" ? data.display_agent : null };
}

export type StructureEvent =
  | { kind: "pane-ended"; paneId: string }
  | { kind: "structure-changed"; closed?: string; moved?: { previousPaneId: string; paneId: string; status: AgentStatus; agent: string | null }; created?: { paneId: string; status: AgentStatus }; scopedClose?: true };

export function parseFocusFrame(frame: EventFrame): string | null {
  const data = frame.data as { type?: unknown; pane_id?: unknown } | undefined;
  return data?.type === "pane_focused" && typeof data.pane_id === "string" ? data.pane_id : null;
}

export function parseStructureFrame(frame: EventFrame): StructureEvent | null {
  const data = frame.data as { type?: unknown; pane_id?: unknown; previous_pane_id?: unknown; pane?: { pane_id?: unknown; agent_status?: unknown; agent?: unknown } } | undefined;
  switch (data?.type) {
    case "pane_exited":
      return typeof data.pane_id === "string" ? { kind: "pane-ended", paneId: data.pane_id } : null;
    case "pane_closed":
      return typeof data.pane_id === "string" ? { kind: "structure-changed", closed: data.pane_id } : { kind: "structure-changed" };
    case "pane_moved":
      return typeof data.previous_pane_id === "string" && typeof data.pane?.pane_id === "string" && typeof data.pane.agent_status === "string"
        ? { kind: "structure-changed", moved: { previousPaneId: data.previous_pane_id, paneId: data.pane.pane_id, status: data.pane.agent_status as AgentStatus, agent: typeof data.pane.agent === "string" ? data.pane.agent : null } }
        : { kind: "structure-changed" };
    case "pane_created":
      // herdr's frame carries the pane; herdr-core's names only its ID, nothing of its status
      return typeof data.pane?.pane_id === "string" && typeof data.pane.agent_status === "string"
        ? { kind: "structure-changed", created: { paneId: data.pane.pane_id, status: data.pane.agent_status as AgentStatus } }
        : { kind: "structure-changed" };
    case "pane_updated":
    case "workspace_created":
    case "workspace_updated":
    case "workspace_metadata_updated":
    case "workspace_renamed":
    case "workspace_moved":
    case "workspace_reordered":
    case "worktree_created":
    case "worktree_opened":
    case "tab_created":
    case "tab_renamed":
    case "tab_moved":
    case "layout_updated":
      return { kind: "structure-changed" };
    case "workspace_closed":
    case "worktree_removed":
    case "tab_closed":
      return { kind: "structure-changed", scopedClose: true };
    default:
      return null;
  }
}

function resilientSubscription(
  deps: StatusCollectorDeps,
  subscriptions: Parameters<typeof subscribeEvents>[0],
  onEvent: (frame: EventFrame) => void,
  onRestart: () => void,
  isStopped: () => boolean,
  onFirstStart?: () => void,
  liveness?: { identity: () => string | null; onChange: (identity: string | null) => void },
  onLost?: () => void,
): { close: () => void } {
  let subscription: Subscription | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let delay = deps.reconnectMinMs;
  let attempted = false;

  const open = (): void => {
    retryTimer = null;
    if (isStopped()) return;
    const retry = attempted;
    attempted = true;
    const attemptedTo = liveness?.identity() ?? null;
    subscription = deps.subscribe(subscriptions, {
      onEvent,
      onStarted: () => {
        delay = deps.reconnectMinMs;
        if (liveness) {
          const now = liveness.identity();
          liveness.onChange(attemptedTo !== null && now === attemptedTo ? now : null);
        }
        if (retry) onRestart();
        else onFirstStart?.();
      },
      onError: logSubscriptionError,
      onClose: () => {
        subscription = null;
        liveness?.onChange(null);
        onLost?.();
        if (isStopped()) return;
        retryTimer = setTimeout(open, delay);
        delay = Math.min(delay * 2, deps.reconnectMaxMs);
      },
    });
  };
  open();

  return {
    close() {
      if (retryTimer !== null) clearTimeout(retryTimer);
      retryTimer = null;
      const current = subscription;
      subscription = null;
      current?.close();
      liveness?.onChange(null);
    },
  };
}

function logSubscriptionError(error: Error): void {
  const code = error instanceof HerdrError ? error.code : "error";
  if (code === "connect_failed" || code === "socket_error") return;
  console.error(`herdr events: ${code}: ${error.message}`);
}

export function startStatusCollector(handlers: StatusCollectorHandlers, overrides: Partial<StatusCollectorDeps> = {}): StatusCollector {
  const deps: StatusCollectorDeps = { ...DEFAULT_DEPS, ...overrides };
  const ready = Promise.withResolvers<void>();
  const structureStarted = Promise.withResolvers<void>();
  const focusStarted = Promise.withResolvers<void>();
  let stopped = false;
  let statusSubscription: Subscription | null = null;
  let subscribedPaneIds = new Set<string>();
  let reconciling = false;
  let reconcilePending = false;
  let reconcileTimer: ReturnType<typeof setTimeout> | null = null;
  let structureTimer: ReturnType<typeof setTimeout> | null = null;
  let backstopTimer: ReturnType<typeof setInterval> | null = null;
  let lifecycleSubscription: { close: () => void } | null = null;
  let focusSubscription: { close: () => void } | null = null;
  let recovering = false;
  let statusGeneration = 0;
  let resyncFor: number | null = null;
  let statusEvents = 0;
  const lastEventOf = new Map<string, number>();
  const heard = new Map<string, { status: AgentStatus; agent: string | null }>();
  const actedOn = new Map<string, number>();
  const trackedPanes = new Map<string, number>();
  const exitedAt = new Map<string, number>();
  const focusedAt = new Map<string, number>();
  /** what each pane created while this listens began as, and when its frame was read, until a snapshot reads it */
  const born = new Map<string, { status: AgentStatus; seq: number }>();
  /**
   * when a pane may last have gone with no frame naming it: a workspace, worktree or tab closed (such a close names none
   * of its panes), or the lifecycle connection was lost
   */
  let unnamedCloseAt = 0;
  let gap = false;
  let replayFor: number | null = null;
  let statusStarted = false;
  /**
   * each pane's `display_agent` as last heard. A plugin's new line for an agent comes only as a
   * status event, of the same status (live, herdr 0.9.3), and no lifecycle event says it
   */
  const displayAgents = new Map<string, string | null>();

  const STRUCTURE_SUBSCRIPTIONS = [
    { type: "workspace.created" },
    { type: "workspace.updated" },
    { type: "workspace.metadata_updated" },
    { type: "workspace.renamed" },
    { type: "workspace.moved" },
    { type: "workspace.reordered" },
    { type: "workspace.closed" },
    { type: "worktree.created" },
    { type: "worktree.opened" },
    { type: "worktree.removed" },
    { type: "tab.created" },
    { type: "tab.closed" },
    { type: "tab.renamed" },
    { type: "tab.moved" },
    { type: "pane.created" },
    { type: "pane.closed" },
    { type: "pane.exited" },
    { type: "pane.updated" },
    { type: "pane.moved" },
    { type: "layout.updated" },
  ] as const;

  function closeStatusSubscription(): void {
    statusStarted = false;
    subscribedPaneIds = new Set();
    statusSubscription?.close();
    statusSubscription = null;
  }

  function openStatusSubscription(paneIds: readonly string[]): void {
    if (stopped || paneIds.length === 0) return;
    subscribedPaneIds = new Set(paneIds);
    const generation = ++statusGeneration;
    let started = false;
    let refused = false;
    gap = true;
    const subscription = deps.subscribe(
      paneIds.map((paneId) => ({ type: "pane.agent_status_changed", pane_id: paneId })),
      {
        onEvent: (frame) => {
          const parsed = parseStatusFrame(frame);
          if (!parsed) return;
          lastEventOf.set(parsed.paneId, ++statusEvents);
          heard.set(parsed.paneId, { status: parsed.status, agent: parsed.agent });
          born.delete(parsed.paneId);
          handlers.onStatus(parsed.paneId, parsed.status, parsed.agent);
          const shown = displayAgents.get(parsed.paneId);
          displayAgents.set(parsed.paneId, parsed.displayAgent);
          if (shown !== undefined && shown !== parsed.displayAgent) scheduleStructureChange();
        },
        // herdr's contract: subscribe, wait until it started, then snapshot. The snapshot
        // that chose these panes came before: one more closes the gap it leaves.
        onStarted: () => {
          started = true;
          if (statusSubscription !== subscription) return;
          statusStarted = true;
          if (recovering) resyncFor = generation;
          else if (gap) replayFor = generation;
          void reconcile();
        },
        onError: (error) => {
          const code = error instanceof HerdrError ? error.code : "error";
          refused = code !== "connect_failed" && code !== "socket_error" && code !== "timeout" && code !== "error";
          logSubscriptionError(error);
        },
        // herdr answers a bad batch (e.g. a pane that vanished between snapshot and
        // subscribe) with an error frame and closes the socket, and closes a subscriber
        // that fell behind (`events_lost`): the whole set is re-subscribed from a fresh
        // snapshot, now rather than after the debounce, and what was missed is resynced.
        // One herdr refused before it started lost no events of its own: the gap it leaves
        // is the short one between two subscriptions. One that could not connect says
        // nothing of how long nobody listened, and recovers like a lost one
        onClose: () => {
          if (statusSubscription !== subscription || stopped) return;
          closeStatusSubscription();
          if (started || !refused) recovering = true;
          void reconcile();
        },
      },
    );
    statusSubscription = subscription;
  }

  async function reconcile(): Promise<void> {
    if (stopped) return;
    if (reconciling) {
      reconcilePending = true;
      return;
    }
    reconciling = true;
    const resync = resyncFor;
    resyncFor = null;
    const replay = replayFor;
    replayFor = null;
    const askedAt = statusEvents;
    const askedTime = Date.now();
    try {
      const snapshot = await deps.snapshot();
      if (stopped) return;
      // an exit since the snapshot was asked for is newer than it too. A focus is not: work that
      // ended during a loss is still to be settled, or it would read as going on for good
      const newer = new Set([...lastEventOf, ...actedOn].filter(([, seq]) => seq > askedAt).map(([paneId]) => paneId));
      const paneIds = snapshot.panes.map((pane) => pane.pane_id);
      // a snapshot asked for before then may list a new pane that went (or, after a herdr started again, another pane
      // under its ID), and the snapshot asked for after may come after the alert's wait: it tells no first change, as for
      // any pane
      const closedSince = unnamedCloseAt > askedAt;
      const created = new Map<string, AgentStatus>();
      for (const paneId of paneIds) {
        const began = born.get(paneId);
        if (began === undefined || newer.has(paneId)) continue;
        if (!closedSince) created.set(paneId, began.status);
        born.delete(paneId);
      }
      for (const [paneId, began] of born) if (began.seq <= askedAt && !paneIds.includes(paneId)) born.delete(paneId);
      handlers.onBaseline(snapshot.panes, newer, askedTime, created);
      for (const pane of snapshot.panes) if (!displayAgents.has(pane.pane_id)) displayAgents.set(pane.pane_id, pane.display_agent ?? null);
      const resynced = resync !== null && resync === statusGeneration && statusSubscription !== null;
      if (resynced) {
        recovering = false;
        handlers.onResync?.(snapshot.panes, newer, askedTime);
        for (const pane of snapshot.panes) if (!newer.has(pane.pane_id)) displayAgents.set(pane.pane_id, pane.display_agent ?? null);
        handlers.onStructureChange();
      }
      for (const [paneId, seq] of trackedPanes) {
        if (seq <= askedAt && !paneIds.includes(paneId)) {
          trackedPanes.delete(paneId);
          actedOn.set(paneId, ++statusEvents);
          heard.delete(paneId);
          handlers.onPaneEnded(paneId);
        }
      }
      const sameSet =
        paneIds.length === subscribedPaneIds.size && paneIds.every((id) => subscribedPaneIds.has(id));
      const leaving = !sameSet && statusStarted && !recovering && !resynced;
      const afterGap = !resynced && !recovering && replay !== null && replay === statusGeneration && statusSubscription !== null;
      const replaying = afterGap || leaving;
      if (resynced || afterGap) gap = false;
      const newerThan = (paneId: string, seq: number): boolean => Math.max(lastEventOf.get(paneId) ?? 0, actedOn.get(paneId) ?? 0, focusedAt.get(paneId) ?? 0) > seq;
      const replays: HerdrPane[] = [];
      for (const pane of snapshot.panes) {
        const focusOnly = resynced && Math.max(lastEventOf.get(pane.pane_id) ?? 0, actedOn.get(pane.pane_id) ?? 0) <= askedAt;
        if (newerThan(pane.pane_id, askedAt) && !focusOnly) continue;
        const before = heard.get(pane.pane_id);
        if (before === undefined || resynced) heard.set(pane.pane_id, { status: pane.agent_status, agent: pane.agent ?? null });
        else if (replaying && before.status !== pane.agent_status) replays.push(pane);
      }
      if (replays.length > 0 || leaving) {
        const generation = statusGeneration;
        await new Promise((resolve) => setTimeout(resolve, deps.replaySettleMs));
        if (stopped) return;
        const still = !recovering && generation === statusGeneration && statusSubscription !== null;
        for (const pane of still ? replays : []) {
          const before = heard.get(pane.pane_id);
          if (newerThan(pane.pane_id, askedAt) || before === undefined || before.status === pane.agent_status) continue;
          const agent = pane.agent ?? null;
          heard.set(pane.pane_id, { status: pane.agent_status, agent });
          handlers.onStatus(pane.pane_id, pane.agent_status, agent, { before: before.status, agent: before.agent, askedAt: askedTime });
        }
      }
      handlers.onReconciled?.(snapshot.panes.filter((pane) => !newerThan(pane.pane_id, askedAt)));
      for (const [paneId, seq] of lastEventOf) if (seq <= askedAt && !paneIds.includes(paneId)) lastEventOf.delete(paneId);
      for (const paneId of [...heard.keys()]) if (!paneIds.includes(paneId) && (lastEventOf.get(paneId) ?? 0) <= askedAt) heard.delete(paneId);
      for (const [paneId, seq] of actedOn) if (seq <= askedAt && !paneIds.includes(paneId)) actedOn.delete(paneId);
      for (const [paneId, seq] of exitedAt) if (seq <= askedAt && paneIds.includes(paneId)) exitedAt.delete(paneId);
      for (const [paneId, seq] of focusedAt) if (seq <= askedAt && !paneIds.includes(paneId)) focusedAt.delete(paneId);
      for (const paneId of [...displayAgents.keys()]) if (!paneIds.includes(paneId) && (lastEventOf.get(paneId) ?? 0) <= askedAt) displayAgents.delete(paneId);
      if (sameSet) {
        if (statusStarted || paneIds.length === 0) ready.resolve();
        return;
      }
      closeStatusSubscription();
      openStatusSubscription(paneIds);
      if (paneIds.length === 0) gap = false;
    } catch {
      if (resync !== null && resyncFor === null) resyncFor = resync;
      if (replay !== null && replayFor === null) replayFor = replay;
      if (gap && !recovering) {
        recovering = true;
        replayFor = null;
        if (statusStarted) resyncFor = statusGeneration;
      }
      if (!stopped && reconcileTimer === null) {
        reconcileTimer = setTimeout(() => {
          reconcileTimer = null;
          void reconcile();
        }, deps.snapshotRetryMs);
      }
    } finally {
      reconciling = false;
      if (reconcilePending && !stopped) {
        reconcilePending = false;
        void reconcile();
      }
    }
  }

  function scheduleStructureChange(): void {
    // Separate from snapshot retry timers: an unreachable herdr must not delay
    // the browser's invalidation, and a continuous burst must not starve it.
    if (stopped || structureTimer !== null) return;
    structureTimer = setTimeout(() => {
      structureTimer = null;
      handlers.onStructureChange();
      void reconcile();
    }, deps.debounceMs);
  }

  lifecycleSubscription = resilientSubscription(
    deps,
    [...STRUCTURE_SUBSCRIPTIONS],
    (frame) => {
      const parsed = parseStructureFrame(frame);
      if (!parsed) return;
      if (parsed.kind === "pane-ended") {
        trackedPanes.delete(parsed.paneId);
        actedOn.set(parsed.paneId, ++statusEvents);
        exitedAt.set(parsed.paneId, statusEvents);
        heard.delete(parsed.paneId);
        born.delete(parsed.paneId);
        handlers.onPaneEnded(parsed.paneId);
      }
      else {
        // a move inside one workspace keeps the pane ID: its subscription and status history stay as they are
        if (parsed.moved !== undefined && parsed.moved.previousPaneId !== parsed.moved.paneId) {
          const { previousPaneId, paneId, status, agent } = parsed.moved;
          // The lifecycle connection can overtake a queued working/blocked event
          // on the old status connection. The move's active payload advances a
          // resting baseline; a resting payload must not erase unfinished work.
          const before = heard.get(previousPaneId);
          heard.delete(previousPaneId);
          heard.set(paneId, before === undefined || status === "working" || status === "blocked" ? { status, agent } : before);
          // a new pane moved before a snapshot read it is handled from here as any pane is
          born.delete(previousPaneId);
          actedOn.set(previousPaneId, ++statusEvents);
          lastEventOf.set(paneId, statusEvents);
          handlers.onPaneMoved?.(previousPaneId, paneId);
        }
        if (parsed.closed !== undefined) {
          const exited = exitedAt.get(parsed.closed);
          exitedAt.delete(parsed.closed);
          const cleaned = exited !== undefined && Math.max(lastEventOf.get(parsed.closed) ?? 0, trackedPanes.get(parsed.closed) ?? 0) < exited;
          trackedPanes.delete(parsed.closed);
          actedOn.set(parsed.closed, ++statusEvents);
          heard.delete(parsed.closed);
          born.delete(parsed.closed);
          if (!cleaned) handlers.onPaneClosed?.(parsed.closed);
        }
        // a frame read after a snapshot or a subscription already had the pane is older than what they told
        if (parsed.created !== undefined && !heard.has(parsed.created.paneId) && !subscribedPaneIds.has(parsed.created.paneId)) {
          born.set(parsed.created.paneId, { status: parsed.created.status, seq: ++statusEvents });
        }
        if (parsed.scopedClose) unnamedCloseAt = ++statusEvents;
      }
      scheduleStructureChange();
    },
    () => {
      structureStarted.resolve();
      handlers.onStructureChange();
      void reconcile();
    },
    () => stopped,
    () => {
      structureStarted.resolve();
      if (trackedPanes.size > 0) void reconcile();
    },
    handlers.herdrLive,
    // a close or an exit may have gone unheard meanwhile, and a herdr started again reuses pane IDs: no creation frame
    // read before can be told which pane a later snapshot lists under its ID
    () => {
      born.clear();
      unnamedCloseAt = ++statusEvents;
    },
  );

  // Its own connection: a focus type an older herdr refuses must not cost pane exits.
  const onFocus = handlers.onFocus;
  if (onFocus !== undefined) {
    focusSubscription = resilientSubscription(
      deps,
      [{ type: "pane.focused" }],
      (frame) => {
        const paneId = parseFocusFrame(frame);
        if (paneId === null) return;
        const passing = focusFromMove(paneId);
        if (!passing) {
          focusedAt.set(paneId, ++statusEvents);
          const told = heard.get(paneId);
          if (told !== undefined && told.status !== "working" && told.status !== "blocked") heard.delete(paneId);
        }
        onFocus(paneId, passing);
      },
      () => focusStarted.resolve(),
      () => stopped,
      () => focusStarted.resolve(),
    );
  } else focusStarted.resolve();

  void reconcile();
  backstopTimer = setInterval(() => void reconcile(), deps.backstopMs);

  return {
    ready: ready.promise,
    structureReady: structureStarted.promise,
    focusReady: focusStarted.promise,
    trackPane(paneId) {
      trackedPanes.set(paneId, ++statusEvents);
      void reconcile();
    },
    refresh() { void reconcile(); },
    stop() {
      stopped = true;
      if (reconcileTimer !== null) clearTimeout(reconcileTimer);
      if (structureTimer !== null) clearTimeout(structureTimer);
      if (backstopTimer !== null) clearInterval(backstopTimer);
      lifecycleSubscription?.close();
      focusSubscription?.close();
      closeStatusSubscription();
    },
  };
}
