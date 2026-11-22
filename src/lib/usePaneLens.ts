import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type Dispatch, type SetStateAction } from "react";
import type { HerdrPane } from "../../shared/protocol.ts";
import { paneStorageId } from "../../shared/machines.ts";
import { prefetchPaneConversation } from "./api.ts";
import { PaneLenses } from "./paneLens.ts";
import { paneLifetimes } from "./paneLifetime.ts";
import type { PaneView } from "./actions.ts";
import { notificationViewForPane, type NotificationTarget } from "./notificationTarget.ts";
import type { TerminalPeek } from "./terminalPeek.ts";
import { HISTORY_PROMPTS, type Settings } from "./settings.ts";
import type { TelemetryViewSource } from "../../shared/telemetry.ts";
import { tally, usageCounters, type UsageCounters } from "./usageCounters.ts";

/**
 * The lens a pane opens in: the one picked for it by hand, remembered per pane, else its default
 * (lib/paneLens.ts), kept for the page once the pane is known so an agent starting or exiting in
 * it does not switch the lens under the user. A PC whose herdr has no terminal attach and no
 * mirror either (an older Windows bridge) always opens its chat: its terminal lens is only a
 * notice, so a remembered choice there is not worth keeping. A mirrored PC counts as having a
 * terminal.
 */
/**
 * Whose a lens is in this page: the pane under the herdr its PC is drawn under (lib/paneLifetime.ts),
 * so a pane ID a new herdr gave out again keeps no lens picked or settled for the last one's pane.
 */
export function lensOwner(machineId: string, paneId: string): string {
  const lifetime = paneLifetimes.generation(machineId);
  const pane = paneStorageId(machineId, paneId);
  return typeof lifetime === "string" ? `${lifetime}\u0000${pane}` : pane;
}

/** `hasAgent`: herdr leaves `agent` out for a shell, so callers compare with `!= null`; `keep` false only asks (a press, not a pick) */
export function storedView(lenses: PaneLenses, picks: ReadonlyMap<string, PaneView>, paneId: string, machineId: string, hasAgent: boolean | null, terminalAttach: boolean, keep = true): PaneView {
  if (!terminalAttach) return "chat";
  const key = lensOwner(machineId, paneId);
  const picked = picks.get(key);
  if (picked !== undefined) return picked;
  try {
    const stored = paneLifetimes.paneStorage.getItem(`ovis:view:${paneStorageId(machineId, paneId)}`);
    if (stored === "chat" || stored === "terminal") return stored;
  } catch {
  }
  const coarse = window.matchMedia?.("(pointer: coarse)").matches === true;
  return keep ? lenses.of(key, hasAgent, coarse) : lenses.peek(key, hasAgent, coarse);
}

export function usePaneLensState() {
  const [lens, setLens] = useState<{ key: string; view: PaneView }>({ key: "", view: "terminal" });
  const [viewPicks, setViewPicks] = useState<ReadonlyMap<string, PaneView>>(() => new Map());
  return { lens, setLens, viewPicks, setViewPicks };
}

export function usePaneLens({ settings, selectedPaneId, selectedMachineId, selectedPane, selectedAgent, terminalAttach, attachOn, notificationViewTarget, setNotificationViewTarget, lens, setLens, viewPicks, terminalPeek, setTerminalPeek }: {
  settings: Settings;
  selectedPaneId: string | null;
  selectedMachineId: string;
  selectedPane: HerdrPane | null;
  selectedAgent: HerdrPane["agent"] | null;
  terminalAttach: boolean;
  attachOn: (machineId: string) => boolean;
  notificationViewTarget: NotificationTarget | null;
  setNotificationViewTarget: Dispatch<SetStateAction<NotificationTarget | null>>;
  lens: { key: string; view: PaneView };
  setLens: Dispatch<SetStateAction<{ key: string; view: PaneView }>>;
  viewPicks: ReadonlyMap<string, PaneView>;
  terminalPeek: TerminalPeek | null;
  setTerminalPeek: Dispatch<SetStateAction<TerminalPeek | null>>;
}) {
  // the lens follows the selected pane: each pane remembers its own. It is settled in the render
  // that selects the pane, not in an effect after it: the pane's terminal attaches in that render's
  // layout effect, and an attach in the previous pane's lens resized a pane whose lens is chat
  const lenses = useMemo(() => new PaneLenses(settings.defaultView), [settings.defaultView]);
  const lifetime = useSyncExternalStore(paneLifetimes.subscribe, () => paneLifetimes.generation(selectedMachineId));
  const lensKey = JSON.stringify([selectedPaneId, selectedMachineId, lifetime ?? null, selectedPane !== null, selectedAgent !== null, terminalAttach, settings.defaultView]);
  // a link's or an alert's lens was for the pane it named under the herdr then: a pane ID another
  // herdr gave out again is not that pane, so the lens it named goes with that herdr
  const drawnUnder = useRef({ machineId: selectedMachineId, lifetime });
  const replaced = drawnUnder.current.machineId === selectedMachineId && typeof drawnUnder.current.lifetime === "string"
    && typeof lifetime === "string" && drawnUnder.current.lifetime !== lifetime;
  useEffect(() => {
    if (replaced) setNotificationViewTarget(null);
    if (drawnUnder.current.machineId !== selectedMachineId || typeof lifetime === "string") drawnUnder.current = { machineId: selectedMachineId, lifetime };
  }, [replaced, selectedMachineId, lifetime, setNotificationViewTarget]);
  const notificationView = replaced ? null : notificationViewForPane(notificationViewTarget, selectedMachineId, selectedPaneId);
  let view = lens.view;
  if (lens.key !== lensKey) {
    if (selectedPaneId !== null) view = storedView(lenses, viewPicks, selectedPaneId, selectedMachineId, selectedPane ? selectedAgent !== null : null, terminalAttach);
    setLens({ key: lensKey, view });
    if (terminalPeek !== null) setTerminalPeek(null);
  }
  if (notificationView !== null && !(notificationView === "chat" && selectedPane !== null && selectedAgent === null)) view = notificationView;
  const pressPane = (machineId: string, paneId: string): void => {
    if (storedView(lenses, viewPicks, paneId, machineId, true, attachOn(machineId), false) === "chat") prefetchPaneConversation(paneId, machineId, HISTORY_PROMPTS);
  };
  return { lenses, view, pressPane };
}

export function usePaneViewPicks({ setViewPicks, setNotificationViewTarget, setTerminalPeek, setLens, setAutoSelected, selectedPaneId, selectedMachineId, view, agentOf, counters = usageCounters }: {
  setViewPicks: Dispatch<SetStateAction<ReadonlyMap<string, PaneView>>>;
  setNotificationViewTarget: Dispatch<SetStateAction<NotificationTarget | null>>;
  setTerminalPeek: Dispatch<SetStateAction<TerminalPeek | null>>;
  setLens: Dispatch<SetStateAction<{ key: string; view: PaneView }>>;
  setAutoSelected: Dispatch<SetStateAction<boolean>>;
  selectedPaneId: string | null;
  selectedMachineId: string;
  view: PaneView;
  agentOf: (machineId: string, paneId: string) => string | null | undefined;
  counters?: Pick<UsageCounters, "viewSwitch">;
}) {
  const agentOfRef = useRef(agentOf);
  agentOfRef.current = agentOf;
  const remember = useCallback((machineId: string, paneId: string, next: PaneView) => {
    const key = lensOwner(machineId, paneId);
    setViewPicks((current) => current.get(key) === next ? current : new Map(current).set(key, next));
    try {
      paneLifetimes.paneStorage.setItem(`ovis:view:${paneStorageId(machineId, paneId)}`, next);
    } catch {
    }
  }, []);

  const pickView = useCallback((machineId: string, paneId: string, next: PaneView, source: TelemetryViewSource | null) => {
    tally(() => counters.viewSwitch(next, agentOfRef.current(machineId, paneId), source, machineId));
    remember(machineId, paneId, next);
  }, [counters, remember]);

  const setView = useCallback(
    (next: PaneView, source: TelemetryViewSource | null) => {
      setNotificationViewTarget(null); setTerminalPeek(null);
      setLens((current) => ({ ...current, view: next }));
      setAutoSelected(false);
      if (selectedPaneId === null) return;
      if (next !== view) tally(() => counters.viewSwitch(next, agentOfRef.current(selectedMachineId, selectedPaneId), source, selectedMachineId));
      remember(selectedMachineId, selectedPaneId, next);
    },
    [counters, selectedPaneId, selectedMachineId, remember, view],
  );
  return { pickView, setView };
}
