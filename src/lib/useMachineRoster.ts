import { useCallback, useEffect, useRef, useState, type Dispatch, type RefObject, type SetStateAction } from "react";
import { pcHeld } from "./relay/newPcHere.ts";
import type { DevicePairedEvent, DeviceRemovedEvent, Machine, MachineEvent, PendingKey, RelayPairingRequest, RemotePairingRequest } from "../../shared/machines.ts";
import type { ServerMessage } from "../../shared/protocol.ts";
import { ApiError, authenticate, fetchMachines, observePaneSessions, paneSessionEvents, paneSessionsMoving, verifySourceBoot } from "./api.ts";
import { passingFolder, recentDirectories } from "./recent-directories.ts";
import { keepMachineEvents } from "./machineEventStream.ts";
import { MachineSessionRegistry } from "./machineSession.ts";
import { receiveSeen } from "./seenFinishes.ts";
import { withPairedNotice } from "./pairedNotices.ts";
import { takeAuthTokenFromUrl } from "./authLink.ts";
import { applyPaneStatus } from "./snapshot.ts";
import { setAgentRowTokens } from "./agentRowTokens.ts";
import { stateWatch } from "./agentStateWatch.ts";
import { SnapshotRequests } from "./snapshotRequests.ts";
import { ReorderCoordinator } from "./workspaceOrder.ts";
import type { AppLink } from "./deepLink.ts";
import type { TerminalPeek } from "./terminalPeek.ts";
import type { NotificationTarget } from "./notificationTarget.ts";
import type { SelectionMark } from "./selectionMark.ts";
import { otherTargets, type SplitState } from "./split.ts";
import { deviceInUse, followsHerdrFocus, movingHerdrFocusOn } from "./followFocus.ts";
import { pruneWaitingSends } from "./sentWaiting.ts";
import { paneLifetimes } from "./paneLifetime.ts";
import { displayPaneTitle } from "../components/Sidebar.tsx";
import { useHeaderConnection, type HeaderConnection } from "./headerConnection.ts";
import { CarrierDownError } from "./transport.ts";
import { t } from "./i18n.ts";
import type { usePreferencesSync } from "./preferencesSync.ts";
import type { useAlertSignals } from "./useAlertSignals.ts";

const POLL_MS = 5000;
/** A roster read that failed only because the relay carrier is reconnecting stays quiet this long before the card. */
export const CARRIER_GRACE_MS = 10_000;
const STREAM_BACKSTOP_MS = 30_000;
type RosterStreamUpdate = "opened" | "lost" | "closed" | Machine[];

export interface RosterLink { open: boolean; before: boolean }

export function rosterLinkAfter(link: RosterLink, update: RosterStreamUpdate): RosterLink {
  if (Array.isArray(update)) return link;
  if (update === "opened") return link.open ? link : { open: true, before: true };
  return link.open ? { open: false, before: link.before } : link;
}

const sortedKeys = (_key: string, value: unknown): unknown => value !== null && typeof value === "object" && !Array.isArray(value)
  ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, (value as Record<string, unknown>)[key]]))
  : value;

export function sameData(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  // Sorting every object's keys costs about ten times as much, and runs for any two
  // encodings of the same length: equal data in another key order (a row restored from a compact one beside
  // a full read), and a change that keeps the length (working to blocked, idle to done, a counter's digits).
  const plain = JSON.stringify(a);
  const other = JSON.stringify(b);
  return plain === other || (plain?.length === other?.length && JSON.stringify(a, sortedKeys) === JSON.stringify(b, sortedKeys));
}
type PaneStatus = Extract<ServerMessage, { type: "pane-status" }>;

function withPaneStatus(machine: Machine, message: PaneStatus): Machine {
  if (!machine.snapshot) return machine;
  const snapshot = applyPaneStatus(machine.snapshot, message.pane_id, message.agent_status, message.background_tasks, message.background_wait === true, message.plan, message.finish_id, message.finish_epoch, message.context, message.changed_at);
  return snapshot === machine.snapshot ? machine : { ...machine, snapshot };
}

const RECOVERY_DROPS = 2;
const RECOVERY_HELD = 64;
interface Recovering { entered: number; dropped: number; held: { told: number; message: PaneStatus }[] }

const REFETCH_DEBOUNCE_MS = 500;

export function useRosterState() {
  const [machineSessions] = useState(() => new MachineSessionRegistry());
  useEffect(() => () => machineSessions.closeAll(), [machineSessions]);
  const [machines, setMachines] = useState<Machine[]>([]);
  const [machineRosterLoaded, setMachineRosterLoaded] = useState(false);
  return { machineSessions, machines, setMachines, machineRosterLoaded, setMachineRosterLoaded };
}

/**
 * Signing out closes every socket, as unmounting the sessions provider did: one kept open would
 * carry its old authority behind the sign-in gate and be reused by the next sign-in.
 */
export function useCloseSessionsWhenLocked(machineSessions: Pick<MachineSessionRegistry, "closeAll">, locked: boolean | null): void {
  useEffect(() => { if (locked) machineSessions.closeAll(); }, [machineSessions, locked]);
}

export function useRecentFolderMemory({ machines }: { machines: Machine[] }) {
  useEffect(() => {
    for (const machine of machines) {
      if (machine.state !== "connected" || !machine.snapshot) continue;
      const linked = machine.snapshot.workspaces.filter((workspace) => workspace.worktree?.is_linked_worktree);
      const inLinked = new Set(linked.map((workspace) => workspace.workspace_id));
      const worktrees = linked.map((workspace) => workspace.worktree!.checkout_path);
      recentDirectories.remember(machine.id, machine.snapshot.panes
        .filter((pane) => !pane.restore_error && !inLinked.has(pane.workspace_id) && !(pane.cwd && passingFolder(pane.cwd, worktrees)))
        .map((pane) => pane.cwd).reverse());
    }
  }, [machines]);
}

export function useMachinesRef({ machines }: { machines: Machine[] }) {
  const machinesRef = useRef(machines); machinesRef.current = machines;
  return { machinesRef };
}

export function useRosterError() {
  const [error, setError] = useState<string | null>(null);
  return { error, setError };
}

export function useRefetchTimer() {
  const refetchTimer = useRef<number | null>(null);
  return { refetchTimer };
}

const localConnectedIn = (machines: readonly Machine[]): boolean => machines.some((machine) => machine.id === "local" && machine.state === "connected");

export function useRosterLoader({ locked, healthFailing, rosterIn, setMachines, setMachineRosterLoaded, setError, setLocked, loadHealth, lockedRef, refetchTimer }: {
  locked: boolean | null;
  healthFailing: boolean;
  rosterIn: () => void;
  setMachines: Dispatch<SetStateAction<Machine[]>>;
  setMachineRosterLoaded: Dispatch<SetStateAction<boolean>>;
  setError: Dispatch<SetStateAction<string | null>>;
  setLocked: Dispatch<SetStateAction<boolean | null>>;
  loadHealth: () => Promise<void>;
  lockedRef: RefObject<boolean | null>;
  refetchTimer: RefObject<number | null>;
}) {
  const snapshotRequests = useRef(new SnapshotRequests());
  const stream = useRef({ open: false, localConnected: false });
  const polling = useRef<((readNow: boolean) => void) | null>(null);
  const [link, setLink] = useState<RosterLink>({ open: false, before: false });
  // reads failed on a reconnecting carrier: the header says Reconnecting, and the card waits CARRIER_GRACE_MS from
  // the first of them (`timer` null once the card is shown); the carrier's return reads again at once
  const carrierDown = useRef<{ timer: number | null } | null>(null);
  const carrierBack = useCallback(() => {
    if (carrierDown.current?.timer != null) window.clearTimeout(carrierDown.current.timer);
    carrierDown.current = null;
  }, []);
  const rosterConnection: HeaderConnection = useHeaderConnection({ scope: "roster", reportedBy: "roster", connected: link.open, connectedBefore: link.before, outputStopped: false });
  const onRosterStream = useCallback((update: RosterStreamUpdate) => {
    setLink((previous) => rosterLinkAfter(previous, update));
    if (Array.isArray(update)) stateWatch.pushed();
    else stateWatch.subscription(update);
    const previous = stream.current.open && stream.current.localConnected;
    if (Array.isArray(update)) stream.current.localConnected = localConnectedIn(update);
    // Every opening, a switch from SSE to the terminal socket included, waits for its own first
    // roster (each subscription sends one at once) rather than trusting the last transport's.
    else if (update === "opened") stream.current = { open: true, localConnected: false };
    else stream.current = { open: false, localConnected: false };
    const slow = stream.current.open && stream.current.localConnected;
    const reread = update === "opened" && carrierDown.current !== null;
    // Repeated pushed rosters must not postpone the backstop.
    if (previous !== slow || reread) polling.current?.((!slow || reread) && lockedRef.current !== true);
  }, []);
  const healthFailingRef = useRef(healthFailing);
  useEffect(() => {
    if (healthFailingRef.current === healthFailing) return;
    healthFailingRef.current = healthFailing;
    polling.current?.(false);
  }, [healthFailing]);
  useEffect(() => {
    if (locked !== true) return;
    stream.current = { open: false, localConnected: false };
    polling.current?.(true);
  }, [locked]);
  const loadRef = useRef<() => Promise<void>>(async () => {});
  const [reorderCoordinator] = useState(() => new ReorderCoordinator({ verify: verifySourceBoot, onSettled: () => void loadRef.current() }));
  const recovery = useRef({ machines: new Map<string, Recovering>(), told: new Map<string, number>() });
  const read = useCallback(async (full: boolean) => {
    const started = reorderCoordinator.loadStarted();
    const asked = stateWatch.asked();
    const readAfter = paneSessionEvents();
    const toldBefore = new Map(recovery.current.told);
    try {
      await snapshotRequests.current.read(() => fetchMachines(undefined, full), (next) => {
        paneLifetimes.observe(next, displayPaneTitle);
        pruneWaitingSends(next);
        observePaneSessions(next, readAfter);
        if (stream.current.localConnected && !localConnectedIn(next)) {
          stream.current.localConnected = false;
          polling.current?.(false);
        }
        reorderCoordinator.roster(next, { kind: "load", started });
        for (const machine of next) recovery.current.machines.delete(machine.id);
        setMachines((previous) => sameData(previous, next) ? previous : next);
        rosterIn();
        stateWatch.read(asked);
        setMachineRosterLoaded(true);
        carrierBack();
        setError(null); setLocked(false);
      }, full ? (next) => {
        // A PC whose own messages keep overtaking its reads would never recover: after RECOVERY_DROPS such
        // reads, the next one begun in this recovery is applied anyway, with the pane statuses that came while
        // it was out on top
        const { machines: waiting, told } = recovery.current;
        const recovered = next.flatMap((machine) => {
          const recovering = waiting.get(machine.id);
          if (!recovering) return [];
          const before = toldBefore.get(machine.id) ?? 0;
          if ((told.get(machine.id) ?? 0) !== before && (recovering.dropped < RECOVERY_DROPS || before < recovering.entered)) {
            recovering.dropped++;
            return [];
          }
          waiting.delete(machine.id);
          return [recovering.held.filter((held) => held.told > before).reduce((shown, held) => withPaneStatus(shown, held.message), machine)];
        });
        if (recovered.length === 0) return;
        paneLifetimes.observe(recovered, displayPaneTitle);
        pruneWaitingSends(recovered);
        observePaneSessions(recovered, readAfter);
        setMachines((previous) => previous.map((machine) => recovered.find((read) => read.id === machine.id) ?? machine));
      } : undefined);
    }
    catch (err) {
      if (err instanceof ApiError && err.status === 401) { setLocked(true); return; }
      // an account-joined device on a PC from before it answered this read: the roster comes over the socket alone
      if (err instanceof ApiError && err.status === 403 && err.code === "local_only") { carrierBack(); setError(null); return; }
      if (err instanceof CarrierDownError) {
        carrierDown.current ??= { timer: window.setTimeout(() => {
          if (carrierDown.current) carrierDown.current.timer = null;
          setError(t("Can't reach the PC. Check your connection, then try again."));
        }, CARRIER_GRACE_MS) };
        return;
      }
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [rosterIn, reorderCoordinator, carrierBack]);
  const load = useCallback(() => read(false), [read]);
  loadRef.current = load;

  useEffect(() => {
    const tick = (): void => {
      if (document.visibilityState === "hidden") return;
      void loadHealth();
      // a locked tab only watches health, so a token entered in another tab still unlocks it
      if (lockedRef.current !== true) void load();
    };
    let timer = 0;
    let disposed = false;
    const schedule = (readNow: boolean): void => {
      window.clearInterval(timer);
      if (readNow) tick();
      const slow = lockedRef.current !== true && !healthFailingRef.current && stream.current.open && stream.current.localConnected;
      timer = window.setInterval(tick, slow ? STREAM_BACKSTOP_MS : POLL_MS);
    };
    void (async (): Promise<void> => {
      // a bookmarked `#auth=<token>` link unlocks without typing; the fragment is
      // stripped before anything renders, and a stale token falls through to the
      // gate the first health check mounts
      const linkToken = takeAuthTokenFromUrl();
      if (linkToken !== null) await authenticate(linkToken).catch(() => undefined);
      if (disposed) return;
      polling.current = schedule;
      schedule(true);
    })();
    const onVisible = (): void => {
      if (document.visibilityState === "visible" && !disposed) schedule(true);
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      disposed = true;
      polling.current = null;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [load, loadHealth]);

  const refetchWanted = useRef({ full: false, plain: false });
  const scheduleRefetch = useCallback((full = false) => {
    refetchWanted.current[full ? "full" : "plain"] = true;
    if (refetchTimer.current !== null) return;
    refetchTimer.current = window.setTimeout(() => {
      refetchTimer.current = null;
      const wanted = refetchWanted.current;
      refetchWanted.current = { full: false, plain: false };
      const fullRead = wanted.full && recovery.current.machines.size > 0;
      if (lockedRef.current !== true && (fullRead || wanted.plain)) void read(fullRead);
    }, REFETCH_DEBOUNCE_MS);
  }, [read]);

  useEffect(() => () => {
    if (refetchTimer.current !== null) window.clearTimeout(refetchTimer.current);
    carrierBack();
  }, [carrierBack]);
  return { snapshotRequests, recovery, reorderCoordinator, load, scheduleRefetch, onRosterStream, rosterConnection };
}

export function useRosterEvents({ onPaneMoved, machineSessions, locked, onRosterStream, receivePreferencesRef, snapshotRequests, recovery, onRoster, reorderCoordinator, setMachines, rosterIn, setMachineRosterLoaded, machinesRef, onPaneStatus, onPaneExited, followFocusRef, selectionRef, splitShownRef, splitRef, pendingLink, selectionHint, setSelectedPaneId, setNotificationViewTarget, setTerminalPeek, setAutoSelected, scheduleRefetch, preferencesResubscribedRef, preferencesDisconnectedRef, preferencesClosedRef, dropIn, chime, setPairedNotices, setRelayPairings, setRemotePairings, setRemovedNotices, setPendingKeys, getTakeNotificationTargetRef }: {
  machineSessions: MachineSessionRegistry;
  locked: boolean | null;
  onRosterStream: (update: RosterStreamUpdate) => void;
  receivePreferencesRef: RefObject<ReturnType<typeof usePreferencesSync>["receive"]>;
  snapshotRequests: RefObject<SnapshotRequests>;
  recovery: RefObject<{ machines: Map<string, Recovering>; told: Map<string, number> }>;
  onRoster: ReturnType<typeof useAlertSignals>["onRoster"];
  reorderCoordinator: ReorderCoordinator;
  setMachines: Dispatch<SetStateAction<Machine[]>>;
  rosterIn: () => void;
  setMachineRosterLoaded: Dispatch<SetStateAction<boolean>>;
  machinesRef: RefObject<Machine[]>;
  onPaneStatus: ReturnType<typeof useAlertSignals>["onPaneStatus"];
  onPaneExited: ReturnType<typeof useAlertSignals>["onPaneExited"];
  /** herdr moved a pane of a PC under a new ID (the server's pane-moved, #1503) */
  onPaneMoved: (machineId: string, from: string, to: string) => void;
  followFocusRef: RefObject<boolean>;
  selectionRef: RefObject<SelectionMark>;
  splitShownRef: RefObject<boolean>;
  splitRef: RefObject<SplitState | null>;
  pendingLink: RefObject<AppLink | null>;
  selectionHint: RefObject<{ machine: string; pane: string; workspace: string } | null>;
  setSelectedPaneId: Dispatch<SetStateAction<string | null>>;
  setNotificationViewTarget: Dispatch<SetStateAction<NotificationTarget | null>>;
  setTerminalPeek: Dispatch<SetStateAction<TerminalPeek | null>>;
  setAutoSelected: Dispatch<SetStateAction<boolean>>;
  scheduleRefetch: (full?: boolean) => void;
  preferencesResubscribedRef: RefObject<ReturnType<typeof usePreferencesSync>["resubscribed"]>;
  preferencesDisconnectedRef: RefObject<ReturnType<typeof usePreferencesSync>["disconnected"]>;
  preferencesClosedRef: RefObject<ReturnType<typeof usePreferencesSync>["closed"]>;
  dropIn: ReturnType<typeof useAlertSignals>["dropIn"];
  chime: ReturnType<typeof useAlertSignals>["chime"];
  setPairedNotices: Dispatch<SetStateAction<readonly DevicePairedEvent[]>>;
  /** the devices waiting for this PC's screen (S2-34), as the PC lists them after each change */
  setPendingKeys: (pending: readonly PendingKey[]) => void;
  setRelayPairings: Dispatch<SetStateAction<readonly RelayPairingRequest[]>>;
  setRemotePairings: Dispatch<SetStateAction<readonly RemotePairingRequest[]>>;
  setRemovedNotices: Dispatch<SetStateAction<readonly DeviceRemovedEvent[]>>;
  getTakeNotificationTargetRef: () => RefObject<(target: NotificationTarget) => void>;
}) {
  useCloseSessionsWhenLocked(machineSessions, locked);
  // The local socket watches every PC, even when no terminal is selected; older servers use SSE.
  useEffect(() => {
    if (locked !== false) return;
    const onMessage = (payload: MachineEvent, kept: ReadonlySet<string>) => {
      stateWatch.heard();
      const takeNotificationTargetRef = getTakeNotificationTargetRef();
      if (payload.type === "preferences") { receivePreferencesRef.current(payload.preferences); return; }
      if (payload.type === "herdr-sidebar") { setAgentRowTokens(payload.agents); return; }
      if (payload.type === "seen") { receiveSeen(payload.finishes); return; }
      if (payload.type === "device-paired") { setPairedNotices((list) => withPairedNotice(list, payload)); return; }
      // another window of this PC saw it
      if (payload.type === "device-paired-seen") { setPairedNotices((list) => list.filter((item) => item.event_id !== payload.event_id)); return; }
      if (payload.type === "relay-pairings") { setRelayPairings(payload.pairings); return; }
      if (payload.type === "remote-pairings") { setRemotePairings(payload.pairings); return; }
      if (payload.type === "device-removed") { setRemovedNotices((list) => withPairedNotice(list, payload)); return; }
      if (payload.type === "pending-redemptions") { setPendingKeys(payload.pending); return; }
      const fresh = payload.type === "machines" ? payload.machines.filter((machine) => !kept.has(machine.id)) : [];
      const vouches = payload.type !== "machines" || kept.size === 0 || fresh.length > 0;
      if (vouches) snapshotRequests.current.invalidate();
      const tell = (machineId: string) => { const { told } = recovery.current; told.set(machineId, (told.get(machineId) ?? 0) + 1); };
      if (payload.type === "machines") {
        for (const machine of fresh) { tell(machine.id); recovery.current.machines.delete(machine.id); }
        if (vouches) onRosterStream(payload.machines);
        paneLifetimes.observe(payload.machines, displayPaneTitle);
        pruneWaitingSends(payload.machines);
        observePaneSessions(fresh);
        onRoster(payload.machines);
        reorderCoordinator.roster(payload.machines, { kind: "event" });
        setMachines((previous) => sameData(previous, payload.machines) ? previous : payload.machines);
        rosterIn();
        setMachineRosterLoaded(true);
        return;
      }
      tell(payload.machine_id);
      const recovering = recovery.current.machines.get(payload.machine_id);
      if (recovering) {
        if (payload.message.type === "pane-status") {
          recovering.held.push({ told: recovery.current.told.get(payload.machine_id)!, message: payload.message });
          if (recovering.held.length > RECOVERY_HELD) recovering.held.shift();
        }
        scheduleRefetch(true);
      }
      const machine = machinesRef.current.find((m) => m.id === payload.machine_id);
      if (!machine) return;
      const message = payload.message;
      if (message.type === "pane-status") {
        onPaneStatus(machine, message, takeNotificationTargetRef);
        setMachines((list) => {
          let changed = false;
          const next = list.map((m) => {
            if (m.id !== machine.id) return m;
            const shown = withPaneStatus(m, message);
            if (shown !== m) changed = true;
            return shown;
          });
          return changed ? next : list;
        });
      }
      if (message.type === "pane-exited") {
        if (machine.id === "local") window.dispatchEvent(new Event("herdr-usage-changed"));
        onPaneExited(machine, message, takeNotificationTargetRef);
      }
      // C3 pin 1 (#16): herdr's focus selects nothing of a PC new in the account here
      if (message.type === "pane-focused" && !(machine.id === "local" && pcHeld()) && followsHerdrFocus({
        enabled: followFocusRef.current, machineId: machine.id, paneId: message.pane_id, selection: selectionRef.current,
        splitOthers: splitShownRef.current ? otherTargets(splitRef.current) : [], linkPending: pendingLink.current !== null,
        busy: deviceInUse(selectionRef.current), ownMove: movingHerdrFocusOn(machine.id),
      })) {
        selectionHint.current = null;
        setSelectedPaneId(message.pane_id);
        setNotificationViewTarget(null); setTerminalPeek(null);
        setAutoSelected(true);
      }
      // told before the structure change of the move: the pane's state and view go to the new ID first
      if (message.type === "pane-moved") onPaneMoved(machine.id, message.from, message.to);
      if (message.type === "session-changed" || message.type === "pane-exited") {
        paneSessionsMoving(machine.id);
        scheduleRefetch();
      }
    };
    const stop = keepMachineEvents(machineSessions.get("local").socket, {
      opened: () => { onRosterStream("opened"); preferencesResubscribedRef.current(); },
      // lost (the browser reconnects by itself): a shared-settings save waits for that instead of retrying
      lost: () => { onRosterStream("lost"); preferencesDisconnectedRef.current(); },
      // the browser gave up on it (a proxy's 502 during a restart): a save nobody refused stops waiting for
      // it while a new one is opened, and a refused one waits for that one's opening document (after a 401
      // the next poll locks the app, which ends this effect and its wait)
      closed: () => { onRosterStream("closed"); preferencesClosedRef.current(); },
      message: onMessage,
      previous: (machineId) => machinesRef.current.find((machine) => machine.id === machineId),
      unreadable: (machineIds) => {
        const { machines: waiting, told } = recovery.current;
        for (const id of machineIds) if (!waiting.has(id)) waiting.set(id, { entered: told.get(id) ?? 0, dropped: 0, held: [] });
        scheduleRefetch(true);
      },
    });
    return () => { stop(); onRosterStream("closed"); };
  }, [machineSessions, locked, scheduleRefetch, dropIn, chime, reorderCoordinator, onRosterStream]);
}
