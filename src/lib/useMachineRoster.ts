import { useCallback, useEffect, useRef, useState, type Dispatch, type RefObject, type SetStateAction } from "react";
import type { DevicePairedEvent, Machine, MachineEvent } from "../../shared/machines.ts";
import { ApiError, authenticate, fetchMachines, observePaneSessions, paneSessionEvents, paneSessionsMoving, verifySourceBoot } from "./api.ts";
import { passingFolder, recentDirectories } from "./recent-directories.ts";
import { keepMachineEvents } from "./machineEventStream.ts";
import { MachineSessionRegistry } from "./machineSession.ts";
import { receiveSeen } from "./seenFinishes.ts";
import { withPairedNotice } from "./pairedNotices.ts";
import { takeAuthTokenFromUrl } from "./authLink.ts";
import { applyPaneStatus } from "./snapshot.ts";
import { setAgentRowTokens } from "./agentRowTokens.ts";
import { SnapshotRequests } from "./snapshotRequests.ts";
import { ReorderCoordinator } from "./workspaceOrder.ts";
import type { AppLink } from "./deepLink.ts";
import type { TerminalPeek } from "./terminalPeek.ts";
import type { NotificationTarget } from "./notificationTarget.ts";
import type { SelectionMark } from "./selectionMark.ts";
import type { SplitState } from "./split.ts";
import { deviceInUse, followsHerdrFocus, movingHerdrFocusOn } from "./followFocus.ts";
import { paneLifetimes } from "./paneLifetime.ts";
import { displayPaneTitle } from "../components/Sidebar.tsx";
import type { usePreferencesSync } from "./preferencesSync.ts";
import type { useAlertSignals } from "./useAlertSignals.ts";

const POLL_MS = 5000;

/**
 * Polls and the event stream hand over fresh objects every few seconds even when nothing
 * changed; storing them re-rendered the whole app (the chat transcript included) each time.
 */
export function sameData(a: unknown, b: unknown): boolean {
  return a === b || JSON.stringify(a) === JSON.stringify(b);
}
/** trailing debounce for push-triggered refetches: bursts of events become one fetch */
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
  // New workspace's recent folders also know where a PC's panes are: kept behind the folders started in
  useEffect(() => {
    for (const machine of machines) {
      if (machine.state !== "connected" || !machine.snapshot) continue;
      // a worktree's checkout or a temporary folder is no project to start a workspace in
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

export function useRosterLoader({ rosterIn, setMachines, setMachineRosterLoaded, setError, setLocked, loadHealth, lockedRef, refetchTimer }: {
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
  // every PC's dragged workspace order, held until a roster read after its moves comes
  // (lib/workspaceOrder.ts): App's, so a Sidebar remount or PC switch cannot lose it. A roster load
  // once the moves settle may bring that roster sooner; it proves nothing by itself.
  const loadRef = useRef<() => Promise<void>>(async () => {});
  const [reorderCoordinator] = useState(() => new ReorderCoordinator({ verify: verifySourceBoot, onSettled: () => void loadRef.current() }));
  const load = useCallback(async () => {
    const started = reorderCoordinator.loadStarted();
    // the PC events this read starts after: a roster read later names its panes' sessions as they are now
    const readAfter = paneSessionEvents();
    try {
      await snapshotRequests.current.read(fetchMachines, (next) => {
        // a PC whose herdr was replaced leaves its panes' drafts and lenses before they are drawn
        paneLifetimes.observe(next, displayPaneTitle);
        // a pane's conversation answers stand for the session it was on: the chats read this roster's
        observePaneSessions(next, readAfter);
        reorderCoordinator.roster(next, { kind: "load", started });
        setMachines((previous) => sameData(previous, next) ? previous : next);
        rosterIn();
        setMachineRosterLoaded(true);
        setError(null); setLocked(false);
      });
    }
    catch (err) {
      if (err instanceof ApiError && err.status === 401) { setLocked(true); return; }
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [rosterIn, reorderCoordinator]);
  loadRef.current = load;

  useEffect(() => {
    const tick = (): void => {
      // a hidden tab (or a phone app in the background) polls nothing; it catches up on return
      if (document.visibilityState === "hidden") return;
      void loadHealth();
      // a locked tab only watches health, so a token entered in another tab still unlocks it
      if (lockedRef.current !== true) void load();
    };
    let timer = 0;
    let disposed = false;
    void (async (): Promise<void> => {
      // a bookmarked `#auth=<token>` link unlocks without typing; the fragment is
      // stripped before anything renders, and a stale token falls through to the
      // gate the first health check mounts
      const linkToken = takeAuthTokenFromUrl();
      if (linkToken !== null) await authenticate(linkToken).catch(() => undefined);
      if (disposed) return;
      tick();
      timer = window.setInterval(tick, POLL_MS);
    })();
    const onVisible = (): void => {
      if (document.visibilityState === "visible" && !disposed) tick();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      disposed = true;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [load, loadHealth]);

  // push-triggered refetches are debounced so an event burst becomes one fetch
  const scheduleRefetch = useCallback(() => {
    if (refetchTimer.current !== null) return;
    refetchTimer.current = window.setTimeout(() => {
      refetchTimer.current = null;
      if (lockedRef.current !== true) void load();
    }, REFETCH_DEBOUNCE_MS);
  }, [load]);

  useEffect(() => () => {
    if (refetchTimer.current !== null) window.clearTimeout(refetchTimer.current);
  }, []);
  return { snapshotRequests, reorderCoordinator, load, scheduleRefetch };
}

export function useRosterEvents({ onPaneMoved, machineSessions, locked, receivePreferencesRef, snapshotRequests, onRoster, reorderCoordinator, setMachines, rosterIn, setMachineRosterLoaded, machinesRef, onPaneStatus, onPaneExited, followFocusRef, selectionRef, splitShownRef, splitRef, pendingLink, selectionHint, setSelectedPaneId, setNotificationViewTarget, setTerminalPeek, setAutoSelected, scheduleRefetch, preferencesResubscribedRef, preferencesDisconnectedRef, preferencesClosedRef, dropIn, chime, setPairedNotices, getTakeNotificationTargetRef }: {
  machineSessions: MachineSessionRegistry;
  locked: boolean | null;
  receivePreferencesRef: RefObject<ReturnType<typeof usePreferencesSync>["receive"]>;
  snapshotRequests: RefObject<SnapshotRequests>;
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
  scheduleRefetch: () => void;
  preferencesResubscribedRef: RefObject<ReturnType<typeof usePreferencesSync>["resubscribed"]>;
  preferencesDisconnectedRef: RefObject<ReturnType<typeof usePreferencesSync>["disconnected"]>;
  preferencesClosedRef: RefObject<ReturnType<typeof usePreferencesSync>["closed"]>;
  dropIn: ReturnType<typeof useAlertSignals>["dropIn"];
  chime: ReturnType<typeof useAlertSignals>["chime"];
  setPairedNotices: Dispatch<SetStateAction<readonly DevicePairedEvent[]>>;
  getTakeNotificationTargetRef: () => RefObject<(target: NotificationTarget) => void>;
}) {
  useCloseSessionsWhenLocked(machineSessions, locked);
  // The local socket watches every PC, even when no terminal is selected; older servers use SSE.
  useEffect(() => {
    if (locked !== false) return;
    const onMessage = (payload: MachineEvent) => {
      const takeNotificationTargetRef = getTakeNotificationTargetRef();
      if (payload.type === "preferences") { receivePreferencesRef.current(payload.preferences); return; }
      if (payload.type === "herdr-sidebar") { setAgentRowTokens(payload.agents); return; }
      if (payload.type === "seen") { receiveSeen(payload.finishes); return; }
      // a device paired with this server: told once per enrollment, kept until read, the oldest giving way
      if (payload.type === "device-paired") { setPairedNotices((list) => withPairedNotice(list, payload)); return; }
      // A poll started before this event can carry an older roster or pane status.
      snapshotRequests.current.invalidate();
      if (payload.type === "machines") {
        paneLifetimes.observe(payload.machines, displayPaneTitle);
        observePaneSessions(payload.machines);
        onRoster(payload.machines);
        reorderCoordinator.roster(payload.machines, { kind: "event" });
        setMachines((previous) => sameData(previous, payload.machines) ? previous : payload.machines);
        rosterIn();
        setMachineRosterLoaded(true);
        return;
      }
      const machine = machinesRef.current.find((m) => m.id === payload.machine_id);
      if (!machine) return;
      const message = payload.message;
      if (message.type === "pane-status") {
        onPaneStatus(machine, message, takeNotificationTargetRef);
        setMachines((list) => {
          let changed = false;
          const next = list.map((m) => {
            if (m.id !== machine.id || !m.snapshot) return m;
            const snapshot = applyPaneStatus(m.snapshot, message.pane_id, message.agent_status, message.background_tasks, message.background_wait === true, message.plan, message.finish_id, message.finish_epoch);
            if (snapshot === m.snapshot) return m;
            changed = true;
            return { ...m, snapshot };
          });
          return changed ? next : list;
        });
      }
      if (message.type === "pane-exited") {
        if (machine.id === "local") window.dispatchEvent(new Event("herdr-usage-changed"));
        onPaneExited(machine, message, takeNotificationTargetRef);
      }
      // herdr's own window moved to another pane: this device follows it when asked to. As an
      // automatic pick it raises no keyboard and adds no Back entry; a pane too new for the roster
      // is confirmed with its PC first, as a pane made here is (the selection effect below)
      if (message.type === "pane-focused" && followsHerdrFocus({
        enabled: followFocusRef.current, machineId: machine.id, paneId: message.pane_id, selection: selectionRef.current,
        splitOther: splitShownRef.current ? splitRef.current?.other ?? null : null, linkPending: pendingLink.current !== null,
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
        // until the roster after it comes, the panes' sessions are not known: no press read of the old one is taken
        paneSessionsMoving(machine.id);
        scheduleRefetch();
      }
    };
    return keepMachineEvents(machineSessions.get("local").socket, {
      // opened or reopened: a shared-settings save paused by failures gets a new round
      opened: () => preferencesResubscribedRef.current(),
      // lost (the browser reconnects by itself): a shared-settings save waits for that instead of retrying
      lost: () => preferencesDisconnectedRef.current(),
      // the browser gave up on it (a proxy's 502 during a restart): a save nobody refused stops waiting for
      // it while a new one is opened, and a refused one waits for that one's opening document (after a 401
      // the next poll locks the app, which ends this effect and its wait)
      closed: () => preferencesClosedRef.current(),
      message: onMessage,
    });
  }, [machineSessions, locked, scheduleRefetch, dropIn, chime, reorderCoordinator]);
}
