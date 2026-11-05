import { useCallback, useEffect, useLayoutEffect, useRef, useState, type Dispatch, type RefObject, type SetStateAction } from "react";
import { paneStorageId, type Machine } from "../../shared/machines.ts";
import { fetchSession } from "./api.ts";
import { fileFromLink, resolveLink, type AppLink, type LinkNote } from "./deepLink.ts";
import { machineGone, notificationLanding, notificationTargetFromSearch, sameLink, onNotificationTarget, type NotificationTarget } from "./notificationTarget.ts";
import { pageSearch } from "./pageQuery.ts";
import type { TerminalPeek } from "./terminalPeek.ts";
import { markSelection, type SelectionMark } from "./selectionMark.ts";
import type { PaneView } from "./actions.ts";
import type { Translate } from "./i18n.ts";
import { storedSelection, storeSelection } from "./useSplitView.ts";

type SelectionHint = { machine: string; pane: string; workspace: string } | null;
type SelectTarget = (machineId: string, paneId: string | null, view?: PaneView) => void;

/** Whether the address the app opened with picks the pane, rather than this tab's last selection. */
export function linkSelects(initialLink: AppLink | null): boolean {
  return initialLink !== null && Boolean(initialLink.pane || initialLink.workspace || fileFromLink(initialLink));
}

export function useSelectedMachine({ initialLink, machines }: { initialLink: AppLink | null; machines: Machine[] }) {
  const [selectedMachineId, setSelectedMachineId] = useState(() => {
    if (linkSelects(initialLink) && initialLink) return initialLink.machine;
    return storedSelection()?.machine_id ?? "local";
  });
  const selectedMachine = machines.find((m) => m.id === selectedMachineId);
  const snapshot = selectedMachine?.snapshot ?? null;
  return { selectedMachineId, setSelectedMachineId, selectedMachine, snapshot };
}

export function useSelectionState({ initialLink }: { initialLink: AppLink | null }) {
  const [selectedPaneId, setSelectedPaneId] = useState<string | null>(() => {
    if (initialLink?.pane) return initialLink.pane;
    // a link to a workspace opens the pane its row opens, once the roster is in (below)
    if (initialLink && (initialLink.workspace || fileFromLink(initialLink))) return null;
    return storedSelection()?.pane_id ?? null;
  });
  const [notificationViewTarget, setNotificationViewTarget] = useState<NotificationTarget | null>(
    () => notificationTargetFromSearch(pageSearch()),
  );
  // a terminal command's peek (lib/terminalPeek.ts): the selected pane's terminal over its chat, this
  // browser's alone and never stored. Whatever clears the lens drawn over the pane's own clears it too
  const [terminalPeek, setTerminalPeek] = useState<TerminalPeek | null>(null);
  // a late end (a Back to Chat after the peek was replaced) leaves the newer peek alone
  const endPeek = useCallback((peek?: TerminalPeek) => {
    setTerminalPeek((current) => peek === undefined || current === peek ? null : current);
  }, []);
  // the place a link named, settled against the PC's roster once it is in (lib/deepLink.ts resolveLink)
  const pendingLink = useRef<AppLink | null>(initialLink && (initialLink.pane || initialLink.workspace || fileFromLink(initialLink)) ? initialLink : null);
  // state, not only the ref: what waits on the link landing (the address, its file) runs again when it does
  const [linkLanded, setLinkLanded] = useState(() => pendingLink.current === null);
  // A PC is gone only by a roster the server sent after it was named (lib/notificationTarget.ts
  // machineGone): the count of rosters in, and the count when the pending link and the selection
  // were made (a remembered selection: 0, so the first roster checks it)
  const rosterSeq = useRef(0);
  const linkSince = useRef(0);
  const selectionSince = useRef(0);
  // the checks run again on a roster that came in while a link waits (the same list, kept as it
  // was, changes nothing they watch), and on a link a tap set (its pane may be the one selected)
  const [rosterTick, setRosterTick] = useState(0);
  const [linkTick, setLinkTick] = useState(0);
  return { selectedPaneId, setSelectedPaneId, notificationViewTarget, setNotificationViewTarget, terminalPeek, setTerminalPeek, endPeek, pendingLink, linkLanded, setLinkLanded, rosterSeq, linkSince, selectionSince, rosterTick, setRosterTick, linkTick, setLinkTick };
}

export function useLinkLanding({ initialLink, otherRecheck, setOtherRosterTick, pendingLink, rosterSeq, setRosterTick, linkLanded, t }: {
  initialLink: AppLink | null;
  otherRecheck: RefObject<boolean>;
  setOtherRosterTick: Dispatch<SetStateAction<number>>;
  pendingLink: RefObject<AppLink | null>;
  rosterSeq: RefObject<number>;
  setRosterTick: Dispatch<SetStateAction<number>>;
  linkLanded: boolean;
  t: Translate;
}) {
  const rosterIn = useCallback((): void => {
    rosterSeq.current += 1;
    if (pendingLink.current !== null) setRosterTick(rosterSeq.current);
    if (otherRecheck.current) { otherRecheck.current = false; setOtherRosterTick(rosterSeq.current); }
  }, []);
  // the file a link named, opened over its pane once that pane is shown
  const pendingFile = useRef<string | null>(initialLink ? fileFromLink(initialLink) : null);
  // the workspace a tapped alert named for the pane it selected at once: a roster in hand may
  // still list a pane that has ended (a phone resumed from the background), and when the next
  // one drops it, that workspace opens with a word, as a link's does. Any other pick clears it.
  const selectionHint = useRef<{ machine: string; pane: string; workspace: string } | null>(null);
  // a short word in the header: a link that could not open what it named, or a link copied
  const [headerNote, setHeaderNote] = useState<LinkNote | "copied" | null>(null);
  useEffect(() => {
    if (headerNote === null) return;
    const timer = window.setTimeout(() => setHeaderNote(null), headerNote === "copied" ? 1600 : 8000);
    return () => window.clearTimeout(timer);
  }, [headerNote]);
  // the note that stands where the title does: a link that could not open what it named or was
  // copied, or a link waiting for its PC's roster before it can open what it named (HeaderNote)
  const note = headerNote
    ? t(headerNote === "copied" ? "Link copied" : headerNote === "pane-closed" ? "That agent has closed: its workspace is open" : headerNote === "machine-missing" ? "That link's PC is not set up here" : "That link's workspace is closed")
    : !linkLanded ? t("Opening link…") : null;
  // App picked the selected pane itself because the one selected closed: it must not raise a
  // phone's keyboard (over the drawer the close was tapped in) until the user picks a pane or lens
  const [autoSelected, setAutoSelected] = useState(false);
  return { rosterIn, pendingFile, selectionHint, headerNote, setHeaderNote, note, autoSelected, setAutoSelected };
}

export function useSelectionMark({ selectedMachineId, selectedPaneId }: { selectedMachineId: string; selectedPaneId: string | null }) {
  // with a generation (lib/selectionMark.ts): a call that answers after the user opened another pane or PC leaves
  // the selection alone. Marked at commit, not in render: a render React throws away (Strict Mode, a replay)
  // must not move the generation on, and every reader runs from an event or a reply, after the commit
  const selectionRef = useRef<SelectionMark>({ machineId: selectedMachineId, paneId: selectedPaneId, generation: 0 });
  useLayoutEffect(() => {
    selectionRef.current = markSelection(selectionRef.current, selectedMachineId, selectedPaneId);
  }, [selectedMachineId, selectedPaneId]);
  // panes a tab move has on its way to another workspace (paneStorageId): herdr can drop the old ID
  // from a roster before the move answers with the new one, and until it does neither the selection
  // nor the split's other half falls back from it
  const movingPanes = useRef(new Set<string>());
  return { selectionRef, movingPanes };
}

export function useSelectTarget({ selectedMachineId, setConnected, setConnectedBefore, setSelectedMachineId, setSelectedPaneId, setAutoSelected, setDrawerOpen, setOutputStopped, setNotificationViewTarget, setTerminalPeek, pendingLink, pendingFile, setLinkLanded, selectionHint, selectionSince, rosterSeq, snapshot, selectedMachine, selectedPaneId, setHeaderNote, linkTick, movingPanes, onPick }: {
  selectedMachineId: string;
  setConnected: Dispatch<SetStateAction<boolean>>;
  setConnectedBefore: Dispatch<SetStateAction<boolean>>;
  setSelectedMachineId: Dispatch<SetStateAction<string>>;
  setSelectedPaneId: Dispatch<SetStateAction<string | null>>;
  setAutoSelected: Dispatch<SetStateAction<boolean>>;
  setDrawerOpen: Dispatch<SetStateAction<boolean>>;
  setOutputStopped: Dispatch<SetStateAction<boolean>>;
  setNotificationViewTarget: Dispatch<SetStateAction<NotificationTarget | null>>;
  setTerminalPeek: Dispatch<SetStateAction<TerminalPeek | null>>;
  pendingLink: RefObject<AppLink | null>;
  pendingFile: RefObject<string | null>;
  setLinkLanded: Dispatch<SetStateAction<boolean>>;
  selectionHint: RefObject<SelectionHint>;
  selectionSince: RefObject<number>;
  rosterSeq: RefObject<number>;
  snapshot: Machine["snapshot"];
  selectedMachine: Machine | undefined;
  selectedPaneId: string | null;
  setHeaderNote: Dispatch<SetStateAction<LinkNote | "copied" | null>>;
  linkTick: number;
  /** panes a tab move has on its way to another workspace (paneStorageId): their selection waits for the move */
  movingPanes: RefObject<Set<string>>;
  /** told of every pick (a row, the palette, a link, an alert, a new pane), never of the app's own fallback */
  onPick?: () => void;
}) {
  const onPickRef = useRef(onPick); onPickRef.current = onPick;
  const selectedMachineRef = useRef(selectedMachineId);
  selectedMachineRef.current = selectedMachineId;
  /** how many picks were made since the tab opened: a link, an alert, the user (lib/hiddenMachines.ts reads it) */
  const picks = useRef(0);
  const selectTarget = useCallback((machineId: string, paneId: string | null, view?: PaneView) => {
    picks.current += 1;
    onPickRef.current?.();
    // Only another PC mounts a new terminal (and socket), which reports its own state. A pane
    // on the same PC keeps the connected socket, which never reports again: resetting here
    // left the header on "reconnecting" after every pane switch.
    if (machineId !== selectedMachineRef.current) { setConnected(false); setConnectedBefore(false); }
    // the active half alone takes the pick, whatever the other half shows (lib/split.ts)
    setSelectedMachineId(machineId); setSelectedPaneId(paneId); setAutoSelected(false); setDrawerOpen(false);
    setOutputStopped(false);
    setNotificationViewTarget(view && paneId !== null ? { machine_id: machineId, pane_id: paneId, view } : null);
    setTerminalPeek(null);
    // this browser's choice only: herdr's focus, its TUI and every other device stay where they are
    storeSelection(machineId, paneId);
    // a pane picked (a tapped notification, the sidebar, Back) before a link landed supersedes the link
    pendingLink.current = null; pendingFile.current = null; setLinkLanded(true);
    selectionHint.current = null;
    // a PC picked now (Open PC, before load() brings it) is checked against a roster sent after this
    selectionSince.current = rosterSeq.current;
  }, []);
  const selectTargetRef = useRef(selectTarget); selectTargetRef.current = selectTarget;
  useEffect(() => {
    // An offline PC's cached roster cannot invalidate a selection. Once connected,
    // a closed pane (including one remembered across reloads) must release its selection.
    if (!snapshot || selectedMachine?.state !== "connected") return;
    // a link lands once its PC's roster is in: its pane, the pane its workspace's row opens, or,
    // when nothing it named is open, the usual fallback below with a word in the header
    const fallback = (current: typeof snapshot) => current.panes.find((pane) => pane.pane_id === current.focused_pane_id)?.pane_id ?? current.panes[0]?.pane_id ?? null;
    const linked = pendingLink.current;
    if (linked && linked.machine === selectedMachineId) {
      const land = (landed: ReturnType<typeof resolveLink>): boolean => {
        pendingLink.current = null;
        setLinkLanded(true);
        if (landed.note) setHeaderNote(landed.note);
        if (landed.pane) {
          if (landed.pane !== selectedPaneId) {
            setSelectedPaneId(landed.pane);
            // the link's lens was for its own pane: the one opened instead keeps its own
            setNotificationViewTarget(landed.pane === linked.pane && linked.view ? { machine_id: linked.machine, pane_id: landed.pane, view: linked.view } : null);
          }
          if (landed.pane !== linked.pane) pendingFile.current = null;
          return true;
        }
        if (linked.pane || linked.workspace) pendingFile.current = null;
        return false;
      };
      const landed = resolveLink(snapshot, linked);
      if (!landed.note) {
        if (land(landed)) return;
      } else {
        // The combined roster is cached: a pane made just before the link opened can be missing
        // from it. Ask this PC before saying the link's place has closed.
        let cancelled = false;
        void fetchSession(selectedMachineId).then((current) => ({ current, confirmed: resolveLink(current, linked) }), () => null).then((read) => {
          if (cancelled || pendingLink.current !== linked) return;
          // a failed read is not evidence that anything closed: the link settles without a word
          if (read === null) { land({ pane: null, workspace: null, note: null }); return; }
          const { current, confirmed } = read;
          if (land(confirmed)) return;
          // as below: nothing selected takes the fallback, a selection that has gone takes it as auto-selected
          if (current.panes.some((pane) => pane.pane_id === selectedPaneId)) return;
          setSelectedPaneId(fallback(current));
          if (selectedPaneId !== null) setAutoSelected(true);
        });
        return () => { cancelled = true; };
      }
    }
    if (snapshot.panes.some((pane) => pane.pane_id === selectedPaneId)) return;
    if (selectedPaneId === null) { setSelectedPaneId(fallback(snapshot)); return; }
    const moving = (): boolean => movingPanes.current.has(paneStorageId(selectedMachineId, selectedPaneId));
    if (moving()) return;
    // The combined roster is cached: a newly created pane can be selected before it
    // appears there. Confirm absence against this PC before discarding the selection.
    let cancelled = false;
    void fetchSession(selectedMachineId).then((current) => {
      if (cancelled || moving() || current.panes.some((pane) => pane.pane_id === selectedPaneId)) return;
      // a pane a tapped alert selected: the workspace the alert named opens, and says so
      const hint = selectionHint.current;
      selectionHint.current = null;
      if (hint && hint.machine === selectedMachineId && hint.pane === selectedPaneId) {
        const landed = resolveLink(current, { workspace: hint.workspace, workspaceSlug: null, pane: hint.pane });
        if (landed.note) setHeaderNote(landed.note);
        setNotificationViewTarget(null); setTerminalPeek(null);
        setSelectedPaneId(landed.pane ?? fallback(current));
        setAutoSelected(true);
        return;
      }
      setSelectedPaneId(fallback(current));
      setAutoSelected(true);
    }).catch(() => { /* a failed read is not evidence that the pane disappeared */ });
    return () => { cancelled = true; };
  }, [snapshot, selectedPaneId, selectedMachineId, selectedMachine?.state, linkTick]);
  useEffect(() => {
    storeSelection(selectedMachineId, selectedPaneId);
  }, [selectedMachineId, selectedPaneId]);
  return { selectedMachineRef, selectTarget, selectTargetRef, picks };
}

export function useSelectPane({ pendingLink, pendingFile, setLinkLanded, selectionHint, setSelectedPaneId, setNotificationViewTarget, setTerminalPeek, setAutoSelected, setDrawerOpen, onPick }: {
  pendingLink: RefObject<AppLink | null>;
  pendingFile: RefObject<string | null>;
  setLinkLanded: Dispatch<SetStateAction<boolean>>;
  selectionHint: RefObject<SelectionHint>;
  setSelectedPaneId: Dispatch<SetStateAction<string | null>>;
  setNotificationViewTarget: Dispatch<SetStateAction<NotificationTarget | null>>;
  setTerminalPeek: Dispatch<SetStateAction<TerminalPeek | null>>;
  setAutoSelected: Dispatch<SetStateAction<boolean>>;
  setDrawerOpen: Dispatch<SetStateAction<boolean>>;
  /** told of a pane the user picked (focusInput), as selectTarget's onPick is; never of the app's own fallback */
  onPick?: () => void;
}) {
  const onPickRef = useRef(onPick); onPickRef.current = onPick;
  const selectPane = useCallback((paneId: string, focusInput = true) => {
    if (focusInput) onPickRef.current?.();
    pendingLink.current = null; pendingFile.current = null; setLinkLanded(true);
    selectionHint.current = null;
    setSelectedPaneId(paneId);
    setNotificationViewTarget(null); setTerminalPeek(null);
    setAutoSelected(!focusInput);
    setDrawerOpen(false);
  }, []);
  return { selectPane };
}

export function useNotificationTargets({ machinesRef, selectTargetRef, selectionHint, pendingLink, pendingFile, setLinkLanded, linkSince, rosterSeq, setLinkTick, load }: {
  machinesRef: RefObject<Machine[]>;
  selectTargetRef: RefObject<SelectTarget>;
  selectionHint: RefObject<SelectionHint>;
  pendingLink: RefObject<AppLink | null>;
  pendingFile: RefObject<string | null>;
  setLinkLanded: Dispatch<SetStateAction<boolean>>;
  linkSince: RefObject<number>;
  rosterSeq: RefObject<number>;
  setLinkTick: Dispatch<SetStateAction<number>>;
  load: () => Promise<void>;
}) {
  // a tapped notification focuses this window and names the pane (public/sw.js). A pane not known
  // yet waits as a link does (this also keeps a cold start's link, which the worker names again
  // once the page is up), and so does one on a PC this roster lacks: a roster asked for now says
  // whether it was removed (the [machines] effect below) or set up since this one was read
  const takeNotificationTarget = useCallback((target: NotificationTarget): void => {
    const landing = notificationLanding(machinesRef.current, target);
    if (landing.kind === "select") {
      selectTargetRef.current(target.machine_id, target.pane_id, target.view);
      if (target.workspace_id) selectionHint.current = { machine: target.machine_id, pane: target.pane_id, workspace: target.workspace_id };
      return;
    }
    // the worker names one tap twice, before and after focus: the second leaves the first's lookup be
    if (sameLink(pendingLink.current, landing.link)) return;
    selectTargetRef.current(target.machine_id, target.pane_id, target.view);
    pendingLink.current = landing.link; pendingFile.current = null; setLinkLanded(false);
    linkSince.current = rosterSeq.current;
    setLinkTick((tick) => tick + 1);
    if (landing.stale) void load();
  }, [load]);
  // the tab's own alerts shown without a worker (lib/notifications.ts) land the same way
  const takeNotificationTargetRef = useRef(takeNotificationTarget); takeNotificationTargetRef.current = takeNotificationTarget;
  useEffect(() => onNotificationTarget(takeNotificationTarget), [takeNotificationTarget]);
  return { takeNotificationTarget, takeNotificationTargetRef };
}

export function useSelectedPane({ snapshot, selectedPaneId }: { snapshot: Machine["snapshot"]; selectedPaneId: string | null }) {
  const selectedPane = snapshot?.panes.find((pane) => pane.pane_id === selectedPaneId) ?? null;
  return { selectedPane };
}

export function useSelectedLayout({ selectedPane, snapshot, drawerOpen, selectedMachineId, selectedPaneId, setSelectedPaneId, setAutoSelected }: {
  selectedPane: ReturnType<typeof useSelectedPane>["selectedPane"];
  snapshot: Machine["snapshot"];
  drawerOpen: boolean;
  selectedMachineId: string;
  selectedPaneId: string | null;
  setSelectedPaneId: Dispatch<SetStateAction<string | null>>;
  setAutoSelected: Dispatch<SetStateAction<boolean>>;
}) {
  const selectedWorkspace = selectedPane
    ? (snapshot?.workspaces.find((workspace) => workspace.workspace_id === selectedPane.workspace_id) ?? null)
    : null;
  const selectedLayout = snapshot?.layouts.find((layout) => layout.tab_id === selectedPane?.tab_id);
  // Selection can precede rendering: in a zoomed tab the layout effect below redirects it,
  // but the sidebar's passive effect can still see that first selection. Only the selected
  // pane the canvas actually draws counts; panePresence checks coverage at acknowledgement time.
  const presentedPaneId = !drawerOpen && selectedPane && !selectedPane.restore_error
    && (!selectedLayout?.panes.length || selectedLayout.panes.some((pane) => pane.pane_id === selectedPane.pane_id))
    && (!selectedLayout?.zoomed || selectedLayout.focused_pane_id === selectedPane.pane_id)
    ? selectedPane.pane_id : null;
  useLayoutEffect(() => {
    if (selectedLayout?.zoomed && selectedLayout.focused_pane_id !== selectedPaneId
      && snapshot?.panes.some((pane) => pane.pane_id === selectedLayout.focused_pane_id)) {
      setSelectedPaneId(selectedLayout.focused_pane_id);
      setAutoSelected(true);
    }
    // a pick of another pane of a zoomed tab lands on herdr's zoomed one too: herdr shows only it
  }, [selectedMachineId, selectedPaneId, selectedLayout?.zoomed, selectedLayout?.focused_pane_id]);
  return { selectedWorkspace, selectedLayout, presentedPaneId };
}

export function useMachineGone({ machines, pendingLink, pendingFile, selectedMachineRef, linkSince, selectionSince, rosterSeq, setLinkLanded, setHeaderNote, selectTargetRef, rosterTick, linkTick }: {
  machines: Machine[];
  pendingLink: RefObject<AppLink | null>;
  pendingFile: RefObject<string | null>;
  selectedMachineRef: RefObject<string>;
  linkSince: RefObject<number>;
  selectionSince: RefObject<number>;
  rosterSeq: RefObject<number>;
  setLinkLanded: Dispatch<SetStateAction<boolean>>;
  setHeaderNote: Dispatch<SetStateAction<LinkNote | "copied" | null>>;
  selectTargetRef: RefObject<SelectTarget>;
  rosterTick: number;
  linkTick: number;
}) {
  // a link to a PC this app does not have lands on this PC instead, and says so: the roster lists
  // every configured PC, connected or not, so one missing from it is not set up here. So does a
  // selection of a PC removed since (a reload, a new window), here or on another device. Only a
  // roster the server sent after the PC was named decides (lib/notificationTarget.ts machineGone)
  useEffect(() => {
    const linked = pendingLink.current;
    const machineId = linked ? linked.machine : selectedMachineRef.current;
    const since = linked ? linkSince.current : selectionSince.current;
    if (!machineGone(machines, rosterSeq.current, since, machineId)) return;
    pendingLink.current = null; pendingFile.current = null;
    setLinkLanded(true);
    setHeaderNote("machine-missing");
    // no pane: the link's pane id means nothing on another PC, so the pane herdr has in front opens
    selectTargetRef.current("local", null);
  }, [machines, rosterTick, linkTick]);
}
