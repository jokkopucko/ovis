import { useCallback, useEffect, useRef, type RefObject } from "react";
import type { AgentStatus, HerdrPane, ServerMessage } from "../../shared/protocol.ts";
import type { AlertPrefs } from "../../shared/notify-policy.ts";
import { paneStorageId, pcAlertKey, type Machine } from "../../shared/machines.ts";
import { keyedAlertPcs, readAlertFilters, updateAlertFilters } from "./alertFilters.ts";
import { alertPaneTitle } from "../components/Sidebar.tsx";
import type { Settings } from "./settings.ts";
import type { SelectionMark } from "./selectionMark.ts";
import { alertPcAllowed, shouldNotifyStatus, alertStatus, alertsAllow, paneAlertsMuted, showPaneEndedNotification, showPaneStatusNotification } from "./notifications.ts";
import { currentPaneMutes, subscribePaneMutes } from "./paneMutes.ts";
import type { NotificationTarget } from "./notificationTarget.ts";
import { dropletAllows, endedTurn, seedStatuses, showDroplet, trackTurn, type DropletKind } from "./droplet.ts";
import { canPlayAlertSound, playAlertSound, recheckAlertSounds, unlockAlertSound, type AlertSoundKind } from "./alertSound.ts";
import { createAlertTurnPlayer } from "./alertTurns.ts";
import { splitShows, type SplitState } from "./split.ts";

type PaneStatusMessage = Extract<ServerMessage, { type: "pane-status" }>;
type PaneExitedMessage = Extract<ServerMessage, { type: "pane-exited" }>;
type TakeNotificationTargetRef = RefObject<(target: NotificationTarget) => unknown>;

// the alerts take a pane waiting on its turn's background work for working (shared/notify-policy.ts)
const alerting = (list: Machine[]) => list.map((machine) => ({
  id: machine.id,
  snapshot: machine.snapshot && { panes: machine.snapshot.panes.map((pane) => ({ pane_id: pane.pane_id, agent_status: alertStatus(pane.agent_status, (pane as HerdrPane).background_wait) })) },
}));

export interface AlertSignalsParams {
  settings: Settings;
  selectionRef: RefObject<SelectionMark>;
  drawerOpenRef: RefObject<boolean>;
  splitRef: RefObject<SplitState | null>;
  splitShownRef: RefObject<boolean>;
  machinesRef: RefObject<Machine[]>;
  alertsRef: RefObject<AlertPrefs>;
  alertsOnRef: RefObject<boolean>;
  pushOnRef: RefObject<boolean>;
  statusRef: RefObject<Map<string, AgentStatus>>;
  turnStartRef: RefObject<Map<string, number>>;
  lastTurnRef: RefObject<Map<string, number>>;
  alertSoundRef: RefObject<boolean>;
}

/** The in-app alert and the alert sound, and what the event stream does with a status change. */
export function useAlertSignals({ settings, selectionRef, drawerOpenRef, splitRef, splitShownRef, machinesRef, alertsRef, alertsOnRef, pushOnRef, statusRef, turnStartRef, lastTurnRef, alertSoundRef }: AlertSignalsParams) {
  // In-app alerts (components/Droplet.tsx): only while the app is on screen - a hidden app has
  // its system notifications - and never for the pane already open in front of the user.
  const dropIn = useCallback((machine: Machine, pane: HerdrPane, kind: DropletKind) => {
    if (!alertsOnRef.current || document.visibilityState !== "visible") return;
    const open = selectionRef.current;
    if (open.machineId === machine.id && open.paneId === pane.pane_id && !drawerOpenRef.current) return;
    if (splitShownRef.current && splitShows(splitRef.current, { machineId: machine.id, paneId: pane.pane_id }) && !drawerOpenRef.current) return;
    showDroplet({
      machineId: machine.id,
      paneId: pane.pane_id,
      agent: pane.agent ?? null,
      title: alertPaneTitle(pane),
      machine: machinesRef.current.length > 1 ? machine.name : null,
      kind,
    });
  }, []);

  // The alert sound (lib/alertSound.ts): heard also while the tab is hidden and a Focus silences
  // system notifications; never for the pane open in front of the user.
  const alertTurns = useRef<ReturnType<typeof createAlertTurnPlayer> | null>(null);
  useEffect(() => {
    const player = createAlertTurnPlayer({
      // a chime waits its turn among the tabs, and then maybe behind another chime: a mute made
      // meanwhile still silences it (asked here, and again on each mute change while it waits)
      play: (kind, key) => {
        const [machineId, paneId] = JSON.parse(key) as [string, string];
        const wanted = () => alertsOnRef.current && alertSoundRef.current && !paneAlertsMuted(currentPaneMutes(), machineId, paneId);
        return wanted() && playAlertSound(kind, wanted);
      },
    });
    alertTurns.current = player;
    const stopMutes = subscribePaneMutes(recheckAlertSounds);
    return () => { stopMutes(); player.dispose(); alertTurns.current = null; };
  }, []);
  const chime = useCallback((machine: Machine, pane: HerdrPane, kind: AlertSoundKind) => {
    if (!alertsOnRef.current || !alertSoundRef.current || !canPlayAlertSound()) return;
    const open = selectionRef.current;
    if (document.visibilityState === "visible" && open.machineId === machine.id && open.paneId === pane.pane_id && !drawerOpenRef.current) return;
    if (document.visibilityState === "visible" && splitShownRef.current && splitShows(splitRef.current, { machineId: machine.id, paneId: pane.pane_id }) && !drawerOpenRef.current) return;
    alertTurns.current?.chime(JSON.stringify([machine.id, pane.pane_id, kind]), kind);
  }, []);

  // a page plays audio only after a tap or key on it: each one lets the next chime play. A mouse
  // activates the page on press, a touch only on release, so both ends of a tap try
  useEffect(() => {
    if (!settings.alertSound) return;
    const unlock = () => { void unlockAlertSound(); };
    const events = ["pointerdown", "pointerup", "keydown"] as const;
    for (const event of events) window.addEventListener(event, unlock, true);
    return () => { for (const event of events) window.removeEventListener(event, unlock, true); };
  }, [settings.alertSound]);
  const onRoster = useCallback((machines: Machine[]) => {
    // a PC turned off by name is turned off by its relay ID too once the roster names it (#2876)
    const { pcsOff } = readAlertFilters();
    const keyed = keyedAlertPcs(pcsOff, machines);
    if (keyed !== pcsOff) updateAlertFilters({ pcsOff: keyed });
    seedStatuses(statusRef.current, alerting(machines), { started: turnStartRef.current, lasted: lastTurnRef.current });
  }, []);
  const onPaneStatus = useCallback((machine: Machine, message: PaneStatusMessage, takeNotificationTargetRef: TakeNotificationTargetRef) => {
    const key = paneStorageId(machine.id, message.pane_id);
    const previous = statusRef.current.get(key);
    const status = alertStatus(message.agent_status, message.background_wait);
    statusRef.current.set(key, status);
    const pane = machine.snapshot?.panes.find((p) => p.pane_id === message.pane_id);
    const worked = trackTurn(turnStartRef.current, key, previous, status, Date.now());
    if (worked !== null) lastTurnRef.current.set(key, worked);
    // a muted pane (lib/paneMutes.ts), or one on a PC this device turned off, is tracked as every other, and told on no channel
    const muted = paneAlertsMuted(currentPaneMutes(), machine.id, message.pane_id) || !alertPcAllowed(alertsRef.current, pcAlertKey(machine), machine.name);
    if (pane && !muted && shouldNotifyStatus(previous, status) && dropletAllows(alertsRef.current, status, worked, pane.agent_kind)) {
      const kind = status === "blocked" ? "blocked" : "done";
      dropIn(machine, pane, kind);
      chime(machine, pane, kind);
    }
    if (pane && !muted && shouldNotifyStatus(previous, status) && alertsOnRef.current && !pushOnRef.current && alertsAllow(alertsRef.current, status, pane.agent_kind)) showPaneStatusNotification(message.pane_id, `${machine.name} · ${alertPaneTitle(pane)}`, status, () => takeNotificationTargetRef.current({ machine_id: machine.id, pane_id: message.pane_id, view: "chat", workspace_id: pane.workspace_id }), machine.id, pane.workspace_id);
  }, []);
  const onPaneExited = useCallback((machine: Machine, message: PaneExitedMessage, takeNotificationTargetRef: TakeNotificationTargetRef) => {
    const pane = machine.snapshot?.panes.find((p) => p.pane_id === message.pane_id);
    const worked = endedTurn(turnStartRef.current, lastTurnRef.current, paneStorageId(machine.id, message.pane_id), Date.now());
    if (!alertPcAllowed(alertsRef.current, pcAlertKey(machine), machine.name)) return;
    if (pane && !paneAlertsMuted(currentPaneMutes(), machine.id, message.pane_id) && dropletAllows(alertsRef.current, "done", worked)) {
      dropIn(machine, pane, "ended");
      chime(machine, pane, "done");
    }
    if (message.type === "pane-exited" && alertsOnRef.current && !pushOnRef.current && alertsRef.current.done !== "off" && !paneAlertsMuted(currentPaneMutes(), machine.id, message.pane_id)) {
      const pane = machine.snapshot?.panes.find((p) => p.pane_id === message.pane_id);
      if (pane) showPaneEndedNotification(message.pane_id, `${machine.name} · ${alertPaneTitle(pane)}`, () => takeNotificationTargetRef.current({ machine_id: machine.id, pane_id: message.pane_id, view: "chat", workspace_id: pane.workspace_id }), machine.id, pane.workspace_id);
    }
  }, []);
  return { dropIn, chime, onRoster, onPaneStatus, onPaneExited };
}
