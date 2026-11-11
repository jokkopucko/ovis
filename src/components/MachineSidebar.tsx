import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type FocusEvent, type KeyboardEvent } from "react";
import { ArrowLeftRight, ChevronDown, ChevronRight, Download, EyeOff, Monitor, Pencil, Plug, Plus, RefreshCw, Search, Settings, SlidersHorizontal, Trash2, Unplug, X } from "lucide-react";
import { OWN_UPDATE_OFFER, type Machine, type MachineState, type MachineUpdate, type RemoteOvis } from "../../shared/machines.ts";
import { copyText } from "../lib/clipboard.ts";
import { AppLayoutContext, FULL_LAYOUT, MachineContext, type LayoutOffer } from "../lib/machineContext.tsx";
import { answerMachineSetup, machineRequest } from "../lib/api.ts";
import { describeProgress } from "../lib/bridgeProgress.ts";
import { keepDismissed, noticeKey, readDismissed, waitingMachines, writeDismissed } from "../lib/machineNotice.ts";
import type { AppActions } from "../lib/actions.ts";
import { Sidebar } from "./Sidebar.tsx";
import { AgentSidebar } from "./AgentSidebar.tsx";
import { SidebarSplit } from "./SidebarSplit.tsx";
import { storedSidebarSplit, storeSidebarSplit, type SplitFold, type SplitOrder } from "../lib/sidebarSplit.ts";
import { SidebarActivityProvider, type SidebarActivity } from "../lib/sidebarActivity.tsx";
import { filterSuggestions, machineFilter, sidebarFilter, type SidebarBranchLabels } from "../lib/sidebarFilter.ts";
import { SidebarFilterProvider, useSidebarFilter } from "../lib/sidebarFilterContext.ts";
import { UsageMeters } from "./UsageMeters.tsx";
import { RowMenu, rowMenuAnchor, type RowMenuItem } from "./RowMenu.tsx";
import { ConfirmDialog } from "./ConfirmDialog.tsx";
import { sidebarAgents } from "../lib/sidebarAgents.ts";
import { useEdgeFades } from "../lib/useEdgeFades.ts";
import "./Machines.css";
import "./SidebarSections.css";
import { useT } from "../lib/i18n.ts";
import { asksChoice, FoundHerdrChoices } from "./FoundHerdrChoices.tsx";
import { useSettings } from "../lib/settings.ts";
import { useAnnouncedText } from "../lib/useAnnouncedText.ts";
import { machineErrorText, saysHerdrAway, sshFailure } from "../lib/userError.ts";
import { useMediaQuery } from "../lib/useMediaQuery.ts";
import { SHEET_QUERY } from "../lib/sheets.ts";
import { changePc, inNativeApp } from "../lib/nativeApp.ts";
import { serverIdOfPath, shellMode } from "../lib/shellMode.ts";
import { canHideMachine, HIDDEN_MACHINES_MAX, setHiddenMachines, useHiddenMachines, withMachineHidden } from "../lib/hiddenMachines.ts";

/** the release a PC's own Ovis offers as its card shows it: an update installs only that one (docs/remote-pcs.md) */
const shownRevision = (machine: Machine) => machine.ovis_update?.revision ? { revision: machine.ovis_update.revision } : undefined;

/**
 * Which list of PCs this page goes back to, when it shows one PC of a phone's list: the phone app's
 * own list ("app"), or the hosted shell's front page on a PC's page there ("shell"). Null in a PC's
 * own app, whose sidebar lists its PCs itself.
 */
export function pcListExit(page: { nativeApp: boolean; relayShell: boolean; pathname: string }): "app" | "shell" | null {
  // the phone app first: its own list holds every PC it opens, those it reaches through the relay included
  if (page.nativeApp) return "app";
  if (page.relayShell && serverIdOfPath(page.pathname) !== null) return "shell";
  return null;
}

/** The PC header's state word; "connected" is the quiet default and shows as a dot alone, every other state also writes its word under the name. */
/** The PC waits on a fresh choice of what to connect to: the card's own rule (FoundHerdrChoices), so the dot, the menu
 *  line and the line under the header never call a question an error, nor what was chosen and is gone a question */
function asksWhatToConnect(machine: Machine): boolean {
  return machine.action_required === "choose_herdr" && asksChoice(machine.error, machine.found_herdr_sessions ?? [], machine.found_ovis ?? []);
}

export const STATE_WORD: Readonly<Record<MachineState, string>> = {
  connecting: "Connecting…",
  connected: "Connected",
  reconnecting: "Reconnecting…",
  disconnected: "Disconnected",
  error: "Connection error",
};

/** `activity`: App's live counters per PC and finishes looked at here; both sidebar lists draw from it.
 *  `machines` are the PCs this device shows (Settings → Devices and PCs chooses them) */
interface Props { machines: Machine[]; /** every PC of the roster, the hidden ones too: Manage PC's Hide on this device keeps those hidden (lib/hiddenMachines.ts) */ allMachines?: Machine[]; selectedMachineId: string; selectedPaneId: string | null; activity: SidebarActivity; actions: AppActions; watching?: boolean; /** whether the Herdr app's window owns a PC's workspaces (lib/machineContext.tsx AppLayoutContext); none without it */ appLayout?: (machineId: string) => LayoutOffer; /** a phone's drawer is out: closing it clears the filter */ drawerOpen?: boolean; /** counts the command palette's Filter workspaces and agents: each new count shows the field and focuses it */ filterRequest?: number; onSelect(machineId: string, paneId: string | null): void; onNew(machineId: string): void; onSetup(machine: Machine, update?: boolean): void; /** a sign-in tab the usage popover opened */ onUsageLogin(paneId: string): void }
export function MachineSidebar(props: Props) {
  const t = useT();
  const activity = props.activity;
  // the filter's query lives here and nowhere else: not in storage, not in the address, not past this
  // mount (lib/sidebarFilter.ts). The branch each roster row says comes up from the rosters, which read it.
  const [query, setQuery] = useState("");
  const filterId = useId();
  const suggestionsId = useId();
  const filterInput = useRef<HTMLInputElement>(null);
  const [branchLabels, setBranchLabels] = useState<SidebarBranchLabels>(() => new Map());
  const reportBranches = useCallback((machineId: string, branches: ReadonlyMap<string, string>) => setBranchLabels((current) => {
    const before = current.get(machineId);
    if (before !== undefined && before.size === branches.size && [...branches].every(([id, branch]) => before.get(id) === branch)) return current;
    if (before === undefined && branches.size === 0) return current;
    const next = new Map(current);
    if (branches.size === 0) next.delete(machineId); else next.set(machineId, branches);
    return next;
  }), []);
  // one PC shown, and it is the Host: there is no other PC to tell it from, so its group is drawn without its
  // header (MachineGroup), and its name, which no row then shows, is not searched
  const loneHost = props.machines.length === 1 && props.machines[0]!.kind === "local" ? props.machines[0]!.id : null;
  const unnamed = useMemo(() => new Set(loneHost === null ? [] : [loneHost]), [loneHost]);
  const exitToPcs = useMemo(() => pcListExit({ nativeApp: inNativeApp(), relayShell: shellMode() === "relay", pathname: window.location.pathname }), []);
  const leaveForPcs = () => { if (exitToPcs === "app") void changePc(); else window.location.assign("/"); };
  const loneHostName = loneHost === null ? null : props.machines[0]!.name || null;
  const filter = useMemo(() => sidebarFilter(query, props.machines, { machineId: props.selectedMachineId, paneId: props.selectedPaneId }, t, branchLabels, unnamed), [query, props.machines, props.selectedMachineId, props.selectedPaneId, t, branchLabels, unnamed]);
  const filterView = useMemo(() => ({ filter, reportBranches }), [filter, reportBranches]);
  // the field offers the labels the rows show, as the browser's own suggestions: nothing typed is kept
  const suggestions = useMemo(() => filterSuggestions(props.machines, branchLabels, unnamed), [props.machines, branchLabels, unnamed]);
  // Settings → Appearance → Sidebar filter off leaves the field out until the palette's Filter workspaces and
  // agents asks for it (`filterRequest`); it stays while it holds words, and goes on its close, Escape in it
  // empty, the focus leaving the sidebar while it is empty, or the phone's drawer closing
  const { settings } = useSettings();
  const shell = useRef<HTMLDivElement>(null);
  const [filterAsked, setFilterAsked] = useState(false);
  const closable = !settings.sidebarFilter && filterAsked;
  const filterShown = settings.sidebarFilter || filterAsked || query !== "";
  const filterRequest = props.filterRequest ?? 0;
  const lastFilterRequest = useRef(filterRequest);
  const focusFilter = useRef(false);
  // turning the setting off keeps a field that holds words, as one the palette opened, so its clear does not take it
  // away from under the focus; an empty one goes
  useEffect(() => { setFilterAsked(query !== ""); }, [settings.sidebarFilter]);
  useEffect(() => {
    if (filterRequest === lastFilterRequest.current) return;
    lastFilterRequest.current = filterRequest;
    focusFilter.current = true;
    setFilterAsked(true);
  }, [filterRequest]);
  // the focus lands once the field is drawn
  useEffect(() => {
    if (!focusFilter.current || !filterShown) return;
    focusFilter.current = false;
    filterInput.current?.focus();
  });
  const closeFilter = () => { setQuery(""); setFilterAsked(false); };
  const clearFilter = () => { setQuery(""); filterInput.current?.focus(); };
  // a field the palette opened that goes while it holds the focus gives it back, as useFocusReturn does
  // (lib/useFocusTrap.ts): to what had it when the field came, else to the sidebar's first row that takes it. What
  // had it may be gone (Settings' switch), and a row's first control may not be drawn (a desktop's ⋯): each is
  // tried until the focus lands
  useLayoutEffect(() => {
    if (!closable) return;
    const opener = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null;
    const sidebar = shell.current;
    return () => {
      const active = document.activeElement;
      if (active !== null && active !== document.body) return;
      const rows = sidebar?.querySelectorAll<HTMLElement>('.machine-list :is(button:not([disabled]), [role="button"][tabindex="0"])') ?? [];
      // no row may take it (a lone offline Host's roster is inert): the Settings gear, still the sidebar's
      const gear = sidebar?.querySelector<HTMLElement>(".sidebar-footer-settings") ?? null;
      for (const back of [opener, ...rows, gear]) {
        if (back === null || !back.isConnected || back.closest(".sidebar-filter, [inert]") !== null || back.getClientRects().length === 0) continue;
        back.focus({ preventScroll: true });
        if (document.activeElement === back) return;
      }
    };
  }, [closable]);
  // Escape in the field clears it; an empty field's Escape closes a field the palette opened, and is left to the
  // page otherwise (a phone's drawer closes on it first, lib/useSidebarLayout.ts)
  const onFilterKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== "Escape" || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
    if (query === "" && !closable) return;
    event.preventDefault();
    event.stopPropagation();
    if (query === "") closeFilter(); else setQuery("");
  };
  // leaving the sidebar takes an empty field the palette opened with it: a press outside it, or the keyboard's focus
  // going out from the field or any row. A press inside keeps it, also when what it picked takes the focus to its
  // pane (a row would move under the pointer), until a key is pressed. A row's menu is drawn outside the sidebar
  // (RowMenu) and is still inside it; a tab's menu is not. A move with no destination (another window taking the focus) is decided once
  // the focus settles, on the field as it is then
  const pressedInside = useRef(false);
  const emptyField = useRef(true);
  emptyField.current = query === "";
  const insideSidebar = (node: EventTarget | null): boolean => {
    if (!(node instanceof Node)) return false;
    if (shell.current?.contains(node) === true) return true;
    const element = node instanceof Element ? node : node.parentElement;
    const anchor = element === null ? null : rowMenuAnchor(element);
    return anchor !== null && shell.current?.contains(anchor) === true;
  };
  const settleFrame = useRef(0);
  useEffect(() => {
    if (!closable) return;
    // a press from before the field came (its last close) says nothing about this one
    pressedInside.current = false;
    const onPointerDown = (event: PointerEvent): void => {
      pressedInside.current = insideSidebar(event.target);
      if (!pressedInside.current && emptyField.current) closeFilter();
    };
    const onKeyDown = (): void => { pressedInside.current = false; };
    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("keydown", onKeyDown, true);
      cancelAnimationFrame(settleFrame.current);
    };
  }, [closable]);
  const onSidebarBlur = (event: FocusEvent<HTMLDivElement>) => {
    if (!closable || query !== "" || pressedInside.current) return;
    const next = event.relatedTarget;
    if (insideSidebar(next)) return;
    if (next !== null) { closeFilter(); return; }
    cancelAnimationFrame(settleFrame.current);
    settleFrame.current = requestAnimationFrame(() => { if (emptyField.current && !insideSidebar(document.activeElement)) closeFilter(); });
  };
  const drawerOpen = props.drawerOpen === true;
  // ↑/↓ step between the sidebar's rows, workspaces and agents alike, as a list does (Alt+↑/↓ still moves a workspace)
  const stepRows = (event: KeyboardEvent<HTMLDivElement>) => {
    if ((event.key !== "ArrowUp" && event.key !== "ArrowDown") || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    const target = event.target as HTMLElement;
    if (!target.matches(".workspace-select, .agent-select")) return;
    const rows = [...(shell.current?.querySelectorAll<HTMLElement>(".workspace-select, .agent-select:not([disabled])") ?? [])].filter((row) => row.getClientRects().length > 0);
    const next = rows[rows.indexOf(target) + (event.key === "ArrowDown" ? 1 : -1)];
    if (!next) return;
    event.preventDefault();
    next.focus();
  };
  // The PCs this device keeps out are chosen in Settings → Devices and PCs → Show in sidebar
  // (lib/hiddenMachines.ts); the list has no head of its own, so it starts right under the logo.
  const hiddenIds = useHiddenMachines();
  const roster = props.allMachines ?? props.machines;
  const listId = useId();
  // the list fades at an edge only while rows lie past it (lib/useEdgeFades.ts)
  const machineList = useRef<HTMLDivElement>(null);
  useEdgeFades(machineList);
  // the line between the lists (SidebarSplit.tsx): the PCs' height when dragged, kept on this device, and
  // the folds a drag or a key asks of either section, the same folds as their carets
  // the list on top: Agents while Settings → Group agents by state is on, the PCs otherwise; each order keeps
  // its own height for the list on top, so a height chosen for one list never sizes the other
  const order: SplitOrder = settings.agentGroups ? "agents" : "pcs";
  const [splits, setSplits] = useState(() => ({ pcs: storedSidebarSplit("pcs"), agents: storedSidebarSplit("agents") }));
  const [agentsFold, setAgentsFold] = useState<{ folded: boolean; seq: number } | null>(null);
  const agentsListId = useId();
  const changeSplit = useCallback((height: number | null) => { setSplits((last) => ({ ...last, [order]: height })); storeSidebarSplit(order, height); }, [order]);
  // the PCs have no head to fold to (SidebarSplit.tsx never snaps them), so only Agents folds
  const foldSections = (sections: readonly SplitFold[]) => {
    setAgentsFold((last) => ({ folded: sections.includes("agents"), seq: (last?.seq ?? 0) + 1 }));
  };
  // Manage PC's Hide on this device is Settings → Devices and PCs → Show in sidebar turned off, with its rules: the last
  // PC shown is not offered, and App moves a selection off the PC. The PC's header goes with it, so the focus goes
  // to the list's first row that takes it (one a filter or an offline PC's inert roster leaves out is skipped), else
  // the Settings gear, rather than falling to the page
  const focusListAfterHide = useRef(false);
  useEffect(() => {
    if (!focusListAfterHide.current) return;
    focusListAfterHide.current = false;
    const rows = machineList.current?.querySelectorAll<HTMLElement>(':is(button:not([disabled]), [role="button"][tabindex="0"])') ?? [];
    const gear = shell.current?.querySelector<HTMLElement>(".sidebar-footer-settings") ?? null;
    for (const target of [...rows, gear]) {
      if (target === null || target.closest("[inert], [hidden]") !== null || target.getClientRects().length === 0) continue;
      target.focus({ preventScroll: true });
      if (document.activeElement === target) return;
    }
  });
  const hideMachine = (id: string) => {
    const next = withMachineHidden(roster, hiddenIds, id, true);
    // a hide the stored list's cap drops changes nothing: no render follows, so no focus is asked for either
    focusListAfterHide.current = next.indexOf(id) < HIDDEN_MACHINES_MAX;
    setHiddenMachines(next);
  };
  useEffect(() => { if (!drawerOpen) { setQuery(""); setFilterAsked(false); } }, [drawerOpen]);
  // the roster's wait is a live region that is in the list from its first render, clipped while empty (never
  // display: none), and its words land a frame after it (lib/useAnnouncedText.ts)
  const loadingWords = useAnnouncedText(props.machines.length === 0 ? t("Loading PCs…") : null);
  // a PC whose roster has not come was not searched: the line says the answer is only of the PCs that answered
  const unanswered = props.machines.some((machine) => machine.snapshot === null);
  const noMatchWords = useAnnouncedText(filter.active && filter.matches === 0 && props.machines.length > 0 ? `${t(unanswered ? "No workspaces or agents match on the PCs that answered" : "No workspaces or agents match")}\n${t("Try other words, or clear the filter.")}` : null);
  // no top bar: a workspace starts from its PC's header (the lone Host's New workspace row), and Add PC lives in
  // Settings → Devices and PCs. The filter above the lists is a row of the same grid, one field and its clear, never
  // taller than a row.
  const agentList = <AgentSidebar key="agents" foldRequest={agentsFold} listId={agentsListId} machines={props.machines} selectedMachineId={props.selectedMachineId} selectedPaneId={props.selectedPaneId} stateWord={(machine) => t(STATE_WORD[machine.state])} watching={props.watching} onSelect={props.onSelect} />;
  return <SidebarActivityProvider value={activity}><SidebarFilterProvider value={filterView}><div ref={shell} className={`sidebar-shell${order === "agents" ? " is-agents-first" : ""}`} onBlur={onSidebarBlur} onKeyDown={stepRows}>
    {filterShown && <div className="sidebar-filter" role="search" aria-label={t("Filter workspaces and agents")}>
      {/* a glass in the field says what it is, as VS Code's and macOS's search fields do: no word beside it */}
      <Search className="sidebar-filter-glass" aria-hidden="true" />
      <input ref={filterInput} id={filterId} className="input sidebar-filter-input" type="search" value={query} aria-label={t("Filter workspaces and agents")} placeholder={t("Filter workspaces and agents")} list={suggestionsId} autoComplete="off" autoCorrect="off" autoCapitalize="off" spellCheck={false} enterKeyHint="search" onChange={(event) => setQuery(event.target.value)} onKeyDown={onFilterKeyDown} />
      <datalist id={suggestionsId}>{suggestions.map((label) => <option key={label} value={label} />)}</datalist>
      {query !== "" ? <button type="button" className="sidebar-filter-clear" aria-label={t("Clear filter")} title={t("Clear filter")} onClick={clearFilter}><X aria-hidden="true" /></button>
        : closable && <button type="button" className="sidebar-filter-clear" aria-label={t("Close filter")} title={t("Close filter")} onClick={closeFilter}><X aria-hidden="true" /></button>}
    </div>}
    {/* Settings → Group agents by state: the agents come first on this device, the PCs under them */}
    {settings.agentGroups && agentList}
    {settings.agentGroups && <SidebarSplit shell={shell} order={order} split={splits[order]} controls={agentsListId} onSplit={changeSplit} onFold={foldSections} />}
    {/* the PCs' list has no head: it starts right under the logo, and with several PCs each PC's own header
        names it (MachineGroup); a lone Host is drawn without one */}
    <section className="pcs-sidebar" aria-label={t("PCs")}>
      <div ref={machineList} className="machine-list" id={listId} aria-label={t("PCs and workspaces")}>
        <p className={noMatchWords === null ? "visually-hidden" : "tree-state sidebar-filter-empty"} role="status">{noMatchWords}</p>
        {props.machines.map((machine) => <MachineGroup key={machine.id} {...props} machine={machine} headerless={machine.id === loneHost} canHide={canHideMachine(roster, hiddenIds, machine.id)} onHide={() => hideMachine(machine.id)} />)}
        <p className={loadingWords === null ? "visually-hidden" : "tree-state"} role="status">{loadingWords}</p>
      </div>
    </section>
    {!settings.agentGroups && <SidebarSplit shell={shell} order={order} split={splits[order]} controls={listId} onSplit={changeSplit} onFold={foldSections} />}
    {!settings.agentGroups && agentList}
    <footer className="sidebar-footer">
      {/* one PC of the phone's several: which one, and back to the list in one tap, as a team switcher at a
          sidebar's foot does (Slack, Discord); Settings → Phone & devices keeps its Change PC row too */}
      {exitToPcs !== null && (
        <button type="button" className="btn btn-ghost sidebar-footer-action sidebar-footer-pc" onClick={leaveForPcs}>
          <Monitor aria-hidden="true" />
          <span className="sidebar-footer-pc-name">{loneHostName ?? t("Change PC")}</span>
          {loneHostName !== null && <span className="sidebar-footer-pc-action">{t("Change PC")}</span>}
          <ArrowLeftRight aria-hidden="true" />
        </button>
      )}
      {/* no Install app here: a page knows it is installed only in the app's own window, so a row kept
          showing in every tab. Settings → Phone & devices → Install offers it (SettingsDialog). */}
      <div className="sidebar-footer-row">
        <button className="btn btn-ghost sidebar-footer-action sidebar-footer-settings" aria-label={t("Settings")} title={t("Settings (⌘⇧,)")} onClick={props.actions.openSettings}><Settings aria-hidden="true" /></button>
        <UsageMeters watching={props.watching} onLocalLogin={props.watching ? undefined : props.onUsageLogin} />
      </div>
    </footer>
  </div></SidebarFilterProvider></SidebarActivityProvider>;
}

/** A count in a head's trailing cell: the number in view, its words for a screen reader and, where a pointer
 *  can rest on it, a tooltip, so a bare number is never all that is said. `tooltip={false}` for a count a
 *  pointer never reaches. */
function SidebarCount({ className, n, words, tooltip = true }: { className: string; n: number; words: string; tooltip?: boolean }) {
  return <span className={className} title={tooltip ? words : undefined}><span aria-hidden="true">{n}</span><span className="visually-hidden">{words}</span></span>;
}

/** What Manage PC offers, in its menu's order. */
export type ManageAction = "rename" | "toggle" | "setup" | "update" | "hide" | "remove";

/**
 * Manage PC's items for `machine`, and which of them wait. Setup and the bridge update are an SSH PC's alone. A PC
 * herdr manages is renamed, disconnected and removed in herdr, and a machine of herdr-core with hc machine or in the
 * Herdr app, so only what is still theirs here is offered: an SSH PC's setup and bridge update, and its place in this
 * sidebar. Setup and the bridge update need the PC enabled and its address; a rename, a connect or disconnect, Hide
 * and a removal wait while one of them runs (`busy`): Hide drops the row, and with it the guard on that request. `canHide`: another PC stays shown (lib/hiddenMachines.ts
 * canHideMachine).
 */
export function manageActions(machine: Pick<Machine, "kind" | "herdr_profile_id" | "enabled" | "target" | "action_required">, { busy, canHide }: { busy: boolean; canHide: boolean }): { id: ManageAction; disabled: boolean }[] {
  const own = !machine.herdr_profile_id && machine.kind !== "hc";
  const reachable = machine.enabled && Boolean(machine.target);
  const actions: { id: ManageAction; disabled: boolean }[] = [];
  if (own) actions.push({ id: "rename", disabled: busy }, { id: "toggle", disabled: busy });
  // a PC reached through the relay has no SSH setup and no bridge of ours to update
  if (machine.kind === "ssh") {
    if (machine.action_required !== "setup" && machine.action_required !== "connect") actions.push({ id: "setup", disabled: !reachable });
    if (machine.action_required !== "connect") actions.push({ id: "update", disabled: !reachable });
  }
  if (canHide) actions.push({ id: "hide", disabled: busy });
  if (own) actions.push({ id: "remove", disabled: busy });
  return actions;
}

/** `headerless`: the sidebar's lone Host, drawn without its header. What the header held is elsewhere: the state
 *  and its notice are lines of their own, the + is the New workspace row under the workspaces, and nothing is
 *  folded with no caret to open it. A Host has no Manage PC menu; Add PC is in Settings and the palette.
 *  `canHide`/`onHide`: the menu's Hide on this device, under MachineSidebar's rules. */
function MachineGroup({ machine, headerless = false, canHide, onHide, ...props }: Props & { machine: Machine; headerless?: boolean; canHide: boolean; onHide(): void }) {
  const t = useT();
  // the compact rows (Settings → Sidebar rows → One line, the default) draw New workspace as its + alone
  const compact = useSettings().settings.sidebarRows === "one";
  // Manage PC opens a sheet at a phone's width and a popover above it (RowMenu): the button says which (G-037)
  const sheet = useMediaQuery(SHEET_QUERY);
  const [collapsed, setCollapsed] = useState(() => { try { return localStorage.getItem(`ovis:pc-collapsed:${machine.id}`) === "1"; } catch { return false; } });
  // Manage PC is a row menu (RowMenu: a popover, a sheet on a phone), as a workspace's ⋯ is. Rename… swaps the
  // name for a field in the header; Remove PC… asks in the dialog a workspace's Close asks in
  const [menu, setMenu] = useState<HTMLElement | null>(null);
  const manageButton = useRef<HTMLButtonElement>(null);
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(machine.name);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const online = machine.state === "connected";
  // a PC that waits on the user, or is updating, shows its notice in the state line's place
  const noticed = Boolean(machine.action_required || machine.updating);
  // the state line under the name is a live region in the group from its first render, kept through the
  // notice (clipped and empty while it shows): its word lands a frame after the line (lib/useAnnouncedText.ts),
  // and every later state change, or the notice clearing, at once
  const stateWord = useAnnouncedText(noticed ? null : t(STATE_WORD[machine.state]));
  // an SSH failure ssh itself named (lib/userError.ts sshFailure): said in plain words with the host and port it
  // tried, ssh's own line kept under it to select and copy (G-031); the way back is the PC's Manage menu (G-032)
  const ssh = !noticed && machine.kind === "ssh" && machine.error !== null ? sshFailure(machine.error) : null;
  const sshWords = ssh === null ? null : (() => {
    const where = ssh.host === null ? machine.name : ssh.port === null ? ssh.host : `${ssh.host}:${ssh.port}`;
    switch (ssh.reason) {
      case "refused": return t("{where} refused the SSH connection: the PC may be off, or nothing answers on that port.", { where });
      case "unknown-host": return t("{where} is not a name this web server can look up: check the address.", { where });
      case "timeout": return t("{where} did not answer in time: check that the PC is on and reachable.", { where });
      case "unreachable": return t("{where} cannot be reached from this web server: check the network.", { where });
      case "auth": return t("{where} did not accept this web server's SSH key or password.", { where });
    }
  })();
  // the Host's herdr is away (the server's words name the socket it tried): the step to take is on
  // that PC, not in this browser, so it follows the words
  const nextStep = !noticed && machine.kind === "local" && machine.error !== null && saysHerdrAway(machine.error) ? t("Start herdr on this PC, or check HERDR_SOCKET.")
    : ssh !== null ? t("Reconnect or change its address from Manage PC, the sliders beside its name.") : null;
  // one request at a time: a double-clicked Disconnect/Connect can otherwise race and leave this
  // UI's idea of the state opposite the server's until the next refetch
  const [busy, setBusy] = useState(false);
  // the state disables the items; the ref refuses a second request that lands before that render
  const inFlight = useRef(false);
  // `inDialog`: Remove PC's confirm runs the request and shows its failure itself (ConfirmDialog), so it is thrown
  // there instead of written under the header
  const mutate = async (method: string, body?: unknown, inDialog = false) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    // The selected PC moves to this one before it is removed: the server tells every tab the
    // roster without it before it answers, and a selection on a PC the roster has dropped reads
    // as one removed elsewhere ("That link's PC is not set up here"). A failure puts it back.
    const leaving = method === "DELETE" && props.selectedMachineId === machine.id ? { pane: props.selectedPaneId } : null;
    if (leaving) props.onSelect("local", null);
    try { await machineRequest(`/${machine.id}`, method, body); setError(null); }
    catch (e) {
      if (leaving) props.onSelect(machine.id, leaving.pane);
      if (inDialog) throw e;
      setError(e instanceof Error ? e.message : String(e));
    }
    finally { inFlight.current = false; setBusy(false); }
  };
  const closeMenu = useCallback(() => setMenu(null), []);
  // Enter saves a name that changed, Escape and a click away keep the old one; the server trims it and refuses an
  // empty one, so an empty field keeps the old name too. Enter and Escape give the focus back to the manage button
  const endRename = (save: boolean) => {
    setRenaming(false);
    const typed = name.trim();
    if (save && typed !== "" && typed !== machine.name) void mutate("PATCH", { name: typed });
  };
  // how the PC is reached follows its state word; a machine of herdr-core says where it is managed instead
  // a PC waiting on a choice (choose_herdr) or a setup waits on the user: neither is told as a connection error
  const stateWords = machine.action_required === "setup" ? t("Setup needed") : asksWhatToConnect(machine) ? t("Choose what to connect to") : t(STATE_WORD[machine.state]);
  const stateLine = machine.kind === "hc" ? stateWords : `${stateWords} · ${machine.kind === "relay" ? t("through the relay") : t("over SSH")}`;
  const manageNote = machine.kind === "hc" ? t("A machine of herdr-core. Add, rename or remove it with hc machine or in the Herdr app.") : machine.herdr_profile_id ? t("Managed by herdr. Rename, disable or remove it there.") : null;
  const manageItems = (): RowMenuItem[] => manageActions(machine, { busy, canHide }).map(({ id, disabled }): RowMenuItem => {
    switch (id) {
      case "rename": return { id, disabled, label: t("Rename…"), icon: Pencil, run: () => { setName(machine.name); setRenaming(true); } };
      case "toggle": return { id, disabled, label: t(machine.enabled ? "Disconnect" : "Connect"), icon: machine.enabled ? Unplug : Plug, run: () => void mutate("PATCH", { enabled: !machine.enabled }) };
      case "setup": return { id, disabled, label: t("Reconnect / setup"), icon: RefreshCw, run: () => props.onSetup(machine) };
      case "update": return { id, disabled, label: t("Update bridge…"), icon: Download, run: () => props.onSetup(machine, true) };
      case "hide": return { id, disabled, label: t("Hide on this device"), icon: EyeOff, run: onHide };
      case "remove": return { id, disabled, label: t("Remove PC…"), icon: Trash2, danger: true, divider: true, run: () => setConfirmRemove(true) };
    }
  });
  const actions: AppActions = { ...props.actions, selectPane: (id) => props.onSelect(machine.id, id), openNewSession: () => props.onNew(machine.id) };
  // the filter (lib/sidebarFilter.ts): a PC with nothing kept is hidden, its roster still mounted so the
  // branches it reads stay findable; a folded PC with a match or the selection in it is shown open, its saved
  // fold untouched; a PC kept for the selection alone is drawn as context
  const { filter } = useSidebarFilter();
  const filtered = machineFilter(filter, machine.id);
  // while a filter is on, the caret folds and opens the PC for the filter's time only: the saved fold is
  // written by an unfiltered list alone, and comes back as it was when the query is cleared
  const [filterFold, setFilterFold] = useState<boolean | null>(null);
  useEffect(() => { if (!filter.active) setFilterFold(null); }, [filter.active]);
  const hidden = filtered !== null && !filtered.shown;
  const matched = filtered !== null && (filtered.matched || filtered.matchedWorkspaces.size > 0 || filtered.matchedPanes.size > 0);
  const kept = filtered !== null && (matched || filtered.workspaces.size > 0 || filtered.panes.size > 0);
  const folded = headerless ? false : filtered === null ? collapsed : filterFold ?? (collapsed && !kept);
  const context = filtered !== null && !matched;
  const toggle = () => {
    if (filtered !== null) { setFilterFold(!folded); return; }
    setCollapsed(!collapsed);
    try { localStorage.setItem(`ovis:pc-collapsed:${machine.id}`, collapsed ? "0" : "1"); } catch {}
  };
  // what the header says at rest, in the +'s cell that a hover or the focus gives its actions: how many agents
  // the Agents list holds for this PC, whatever they are doing (G-018: a resting agent is not "running")
  const agentCount = useMemo(() => sidebarAgents(machine.snapshot).length, [machine.snapshot]);
  const current = props.selectedMachineId === machine.id;
  // a watching device is refused a new workspace (G-040): the + stays where it is, disabled, and says why
  const canCreate = online && !props.watching;
  const createTitle = props.watching ? `${t("New workspace")} · ${t("View only")}` : t("New workspace");
  const foldLabel = folded ? t("Expand {name}", { name: machine.name }) : t("Collapse {name}", { name: machine.name });
  // the name and its state dot: the whole title folds the PC, as a button (G-036), so the keyboard and a screen
  // reader reach it as one control; the caret beside the + draws the same fold and is not a second stop. While the
  // name is a field (Rename…), the title is a plain box and a press in it places the caret instead
  const titleBody = <>
    <span className="sidebar-mark" aria-hidden="true"><Monitor /></span>
    {renaming ? <input
          className="input machine-rename-input"
          aria-label={t("PC name")}
          data-own-escape=""
          autoFocus
          maxLength={100}
          value={name}
          onFocus={(event) => event.currentTarget.select()}
          onChange={(event) => setName(event.target.value)}
          onBlur={() => setRenaming(false)}
          onKeyDown={(event) => {
            event.stopPropagation();
            if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
            if (event.key !== "Enter" && event.key !== "Escape") return;
            event.preventDefault();
            endRename(event.key === "Enter");
            manageButton.current?.focus({ preventScroll: true });
          }}
    /> : <span className="machine-name" title={machine.name}>{machine.name}</span>}
    {/* the computer this app's server runs on; on a phone "this PC" read as the phone */}
    {machine.kind === "local" && <span className="machine-kind" title={t("The computer this app runs on")}>{t("Host")}</span>}
    <span className={`machine-dot is-${machine.action_required === "setup" || asksWhatToConnect(machine) ? "setup" : machine.state}`} title={stateWords} aria-hidden="true" />
  </>;
  // the PC's name is the head of its workspaces, and the caret beside its + the one fold over them
  return <section className={`machine-group${current ? " is-current" : ""}${online ? "" : " is-offline"}${context ? " is-filter-context" : ""}${headerless ? " is-headerless" : ""}${folded ? " is-folded" : ""}${compact ? "" : " is-two-line"}`} hidden={hidden} aria-label={t("PC {name}", { name: machine.name })}>
    {!headerless && <header className={`machine-header${compact ? " is-compact" : ""}`}>
      {renaming
        ? <div className="machine-title">{titleBody}</div>
        : <button type="button" className={`machine-title${current ? " is-current" : ""}`} aria-expanded={!folded} aria-label={foldLabel} title={machine.name} aria-current={current ? "true" : undefined} onClick={toggle}>{titleBody}</button>}
      {/* only a connected PC counts: a disconnected one keeps its last snapshot, whose agents may long be gone; no
          tooltip, as a pointer never reaches the count (SidebarSections.css) */}
      {online && agentCount > 0 && <SidebarCount className="machine-agent-count" n={agentCount} words={agentCount === 1 ? t("1 agent") : t("{n} agents", { n: agentCount })} tooltip={false} />}
      {machine.kind !== "local" && <button ref={manageButton} type="button" className="sidebar-row-action machine-manage" aria-label={t("Manage {name}", { name: machine.name })} title={t("Manage PC")} aria-haspopup={sheet ? "dialog" : "menu"} aria-expanded={menu !== null} onClick={(event) => setMenu(menu === null ? event.currentTarget : null)}><SlidersHorizontal aria-hidden="true" /></button>}
      {/* the fold's caret beside the +: it draws the title button's state and presses as it does, out of the keyboard's
          and a screen reader's way, since the title is the one fold control (G-036) */}
      <button className="sidebar-row-action machine-toggle" tabIndex={-1} aria-hidden="true" aria-expanded={!folded} aria-label={foldLabel} title={foldLabel} onClick={toggle}>{folded ? <ChevronRight aria-hidden="true" /> : <ChevronDown aria-hidden="true" />}</button>
      <button className="sidebar-row-action machine-new" disabled={!canCreate} aria-label={t("New workspace on {name}", { name: machine.name })} title={createTitle} onClick={() => props.onNew(machine.id)}><Plus aria-hidden="true" /></button>
    </header>}
    {/* connected is the norm and says nothing new; every other state is spelled out. A failure is an alert, a
        connection in progress a status (G-044): one live region, its role following the state */}
    {noticed && <MachineActionNotice machine={machine} onSetup={props.onSetup} />}
    <p className={`machine-state is-${machine.state}${online || stateWord === null ? " visually-hidden" : ""}`} role={machine.state === "error" ? "alert" : "status"} title={noticed || machine.error === null ? undefined : machineErrorText(machine.error, t)}>
      <span className="machine-state-word">{stateWord}</span>
      {!noticed && machine.error && <span className="machine-state-detail">{sshWords ?? machineErrorText(machine.error, t)}</span>}
      {/* ssh's own words, whole, to select and copy (G-030, G-031) */}
      {sshWords !== null && <code className="machine-state-raw">{machine.error}</code>}
      {nextStep !== null && <span className="machine-state-next">{nextStep}</span>}
    </p>
    {/* the menu's head names the PC and how it is reached; a PC herdr or herdr-core manages says where the rest is done */}
    {menu && <RowMenu anchor={menu} title={machine.name} items={manageItems()} onClose={closeMenu} header={<span className="machine-menu-head">
      <span className="machine-menu-name">{machine.name}</span>
      <span className="machine-menu-state">{stateLine}</span>
      {machine.runtime && <span className="machine-menu-note">{t("Runtime: {runtime}", { runtime: machine.runtime })}</span>}
      {manageNote !== null && <span className="machine-menu-note">{manageNote}</span>}
    </span>} />}
    {confirmRemove && <ConfirmDialog title={t("Remove PC {name}?", { name: machine.name })} body={t(machine.kind === "relay" ? "Removes this PC here. To end its access too, revoke it under Phone & devices on that PC." : "Removes this registration. Remote sessions keep running.")} confirmLabel={t("Remove PC")}
      onConfirm={async () => { await mutate("DELETE", undefined, true); setConfirmRemove(false); }} onClose={() => setConfirmRemove(false)} />}
    {error && <p className="machine-error" role="alert">{error}</p>}
    {/* a PC that is away with nothing saved of it: the line says so once the wait is over (disconnected, or
        failed), never beside "Connecting…" (G-150), and outside the faded roster, at full contrast (G-029) */}
    {!folded && !online && !machine.snapshot && (machine.state === "disconnected" || machine.state === "error") && <p className="tree-state machine-empty" role="status">{t("No saved sessions")}</p>}
    {/* under a filter a folded PC's roster is mounted, hidden, so the branches it reads can be found; a connected PC whose
        roster has not come yet draws the roster too, which says it is loading */}
    {(!folded || filtered !== null) && (machine.snapshot !== null || online) && <div className={online ? "" : "machine-offline"} inert={!online} hidden={folded}>
      <MachineContext.Provider value={machine.id}><AppLayoutContext.Provider value={props.appLayout?.(machine.id) ?? FULL_LAYOUT}><Sidebar snapshot={machine.snapshot} online={online} selectedPaneId={props.selectedMachineId === machine.id ? props.selectedPaneId : null} actions={actions} watching={props.watching} /></AppLayoutContext.Provider></MachineContext.Provider>
    </div>}
    {/* the header's +, as the list's last row, also while the roster loads: an empty roster has its own New
        workspace, and a filtered list shows only what was looked for; a watching device sees it disabled (G-040) */}
    {headerless && !compact && online && machine.snapshot?.workspaces.length !== 0 && !filter.active && <button type="button" className={`machine-new-row${compact ? " is-compact" : ""}`} disabled={!canCreate} aria-label={compact ? t("New workspace") : undefined} title={compact || props.watching ? createTitle : undefined} onClick={() => props.onNew(machine.id)}><span className="sidebar-mark" aria-hidden="true"><Plus /></span>{!compact && <span className="machine-new-row-label">{t("New workspace")}</span>}</button>}
  </section>;
}

/** Seconds since the stage began, ticking on this device: install and restart have no bytes to show. */
function useStageSeconds(update: MachineUpdate): number {
  const key = `${update.job_id}:${update.progress?.stage ?? ""}`;
  const [start, setStart] = useState(() => ({ key, at: Date.now() - (update.progress?.elapsed_ms ?? 0) }));
  const [now, setNow] = useState(Date.now());
  useEffect(() => { if (start.key !== key) setStart({ key, at: Date.now() - (update.progress?.elapsed_ms ?? 0) }); }, [key]);
  useEffect(() => { const timer = window.setInterval(() => setNow(Date.now()), 1000); return () => window.clearInterval(timer); }, []);
  return Math.max(0, Math.round((now - start.at) / 1000));
}

/** A bridge install in words and a bar: the step, the bytes, and roughly how long is left. */
export function BridgeUpdateProgress({ update }: { update: MachineUpdate }) {
  const view = describeProgress(update.progress);
  const seconds = useStageSeconds(update);
  if (!view) return <p className="bridge-progress-step">{update.step}</p>;
  return <div className="bridge-progress">
    <p className="bridge-progress-step"><span>{view.label}</span><span className="bridge-progress-count">{view.step}</span></p>
    <div className="bridge-progress-bar" role="progressbar" aria-label={view.label} aria-valuemin={0} aria-valuemax={100} {...(view.percent === null ? {} : { "aria-valuenow": view.percent })}>
      <span className={view.percent === null ? "is-indeterminate" : ""} style={view.percent === null ? undefined : { width: `${view.percent}%` }} />
    </div>
    <p className="bridge-progress-detail">{view.detail ?? `${seconds} s`}</p>
  </div>;
}

/** Retrying can't reconnect this PC: say what the user has to do, with the button that does it. */
function MachineActionNotice({ machine, onSetup }: { machine: Machine; onSetup(machine: Machine, update?: boolean): void }) {
  const t = useT();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const run = async (request: () => Promise<unknown>) => {
    setBusy(true); setError(null);
    try { await request(); } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  };
  if (machine.updating && machine.action_required !== "windows_login" && machine.action_required !== "windows_start_failed") {
    const updating = machine.updating;
    return <div className="machine-action is-updating" role="status">
      <p className="machine-action-text"><strong>{t(updating.ovis ? "Updating this PC's Ovis" : "Updating the bridge")}</strong><span>{t("You can keep using the app; this PC reconnects when it is done.")}</span></p>
      <BridgeUpdateProgress update={updating} />
      <button type="button" className="btn" disabled={busy} onClick={() => void run(() => answerMachineSetup(updating.job_id, { action: "cancel" }))}>{t("Cancel update")}</button>
      {error && <p className="machine-error" role="alert">{error}</p>}
    </div>;
  }
  if (machine.action_required === "connect") return <div className="machine-action is-setup" role="status">
    <p className="machine-action-text"><strong>{t("Saved in herdr")}</strong><span>{t("Connect once to enable automatic reconnection. Installation and startup need separate approval.")}</span></p>
    <button type="button" className="btn btn-primary" onClick={() => onSetup(machine, false)}>{t("Connect")}</button>
  </div>;
  if (machine.action_required === "windows_login" || machine.action_required === "windows_start_failed") return <div className="machine-action" role="status">
    <p className="machine-action-text"><strong>{t(machine.action_required === "windows_start_failed" ? "Windows desktop startup failed" : "Waiting for Windows sign-in")}</strong>{machine.action_required === "windows_login" && <span>{t("Sign in to Windows on this PC; Ovis will reconnect automatically.")}</span>}</p>
    {machine.error && machine.error !== "Waiting for Windows sign-in on this PC." && <p className="machine-action-reason">{machineErrorText(machine.error, t)}</p>}
    <p className="field-hint">{t("Signing out of Windows ends herdr and its panes; lock the PC instead.")}</p>
    <button type="button" className="btn" onClick={() => onSetup(machine, false)}>{t("Review startup options")}</button>
  </div>;
  // another app's bridge runs on this PC: neither an update from here nor an approval fixes that,
  // so it is named as what it is, with the server's reason and a plain reconnect
  if (machine.action_required === "choose_herdr" && (machine.found_herdr_sessions || machine.found_ovis) && machine.target) return <FoundHerdrChoices sessions={machine.found_herdr_sessions ?? []} ownOvis={machine.found_ovis} error={machine.error} busy={busy || !machine.enabled} onChoose={(choice) => onSetup({ ...machine, target: { ...machine.target!, ...choice, ...(machine.herdr_profile_id ? { session: machine.target?.session } : {}) } }, false)} />;
  if (machine.action_required === "bridge_conflict") return <div className="machine-action" role="alert">
    <p className="machine-action-text"><strong>{t("Bridge connection conflict")}</strong><span>{t("Update the apps connected to this PC to the same version, or disconnect the other app, then reconnect here. Sessions keep running.")}</span>{machine.error && <span className="machine-action-reason">{machineErrorText(machine.error, t)}</span>}</p>
    <button type="button" className="btn btn-primary" onClick={() => onSetup(machine, false)}>{t("Reconnect")}</button>
  </div>;
  // the PC's own Ovis, older than this app: it updates itself when asked, or the card says why it cannot. An
  // update of it that failed is offered again, with why it failed
  const own = ownOvisAction(machine);
  const failure = ownUpdateFailure(machine);
  if (own?.updatable) return <div className="machine-action" role="alert">
    <p className="machine-action-text">
      <strong>{t(failure ? "Updating this PC's Ovis failed" : "This PC's Ovis is older than this app")}</strong>
      <span>{t("It updates itself through its own updater, then this PC reconnects; herdr sessions keep running.")}</span>
      {failure && <span className="machine-action-reason">{machineErrorText(failure, t)}</span>}
    </p>
    <div className="machine-action-buttons">
      <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void run(() => machineRequest(`/${encodeURIComponent(machine.id)}/update-bridge`, "POST", shownRevision(machine)).catch((e) => { if (!machine.herdr_profile_id) throw e; onSetup(machine, true); }))}>{own.latest_version ? t("Update this PC's Ovis to v{version}", { version: own.latest_version }) : t("Update this PC's Ovis")}</button>
      <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => onSetup(machine, true)}>{t("Sign in and update…")}</button>
    </div>
    {error && <p className="machine-error" role="alert">{error}</p>}
  </div>;
  if (own) return <div className="machine-action is-setup" role="status">
    <p className="machine-action-text">
      <strong>{t("Update this PC's Ovis on that PC")}</strong>
      <span>{t("It is older than this app and runs on its own, so it cannot be updated from here.")}</span>
      {own.reason && <span className="machine-action-reason">{machineErrorText(own.reason, t)}</span>}
    </p>
    <OwnOvisAddress own={own} />
    <button type="button" className="btn" onClick={() => onSetup(machine, false)}>{t("Reconnect")}</button>
  </div>;
  const update = machine.action_required === "update_bridge";
  return <div className={`machine-action${update ? "" : " is-setup"}`} role={update ? "alert" : "status"}>
    <p className="machine-action-text">
      <strong>{t(update ? "Bridge update needed" : "Setup needed")}</strong>
      <span>{t(update ? "This PC runs a bridge from a different version of Ovis. Update it to reconnect; herdr sessions keep running." : "Browser access uses a bridge on this PC. Review any installation or startup changes before connecting.")}</span>
      {/* the two generic reasons only repeat the sentence above */}
      {machine.error && !/different version|setup needs approval/.test(machine.error) && <span className="machine-action-reason">{machineErrorText(machine.error, t)}</span>}
    </p>
    {update ? <div className="machine-action-buttons">
      {/* a PC saved in herdr that has not connected yet is refused a direct update: its dialog connects first */}
      <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void run(() => machineRequest(`/${encodeURIComponent(machine.id)}/update-bridge`, "POST", shownRevision(machine)).catch((e) => { if (!machine.herdr_profile_id) throw e; onSetup(machine, true); }))}>{t("Update bridge")}</button>
      {/* a PC that needs a password or a new host key goes through its dialog */}
      <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => onSetup(machine, true)}>{t("Sign in and update…")}</button>
    </div> : <button type="button" className="btn btn-primary" onClick={() => onSetup(machine, false)}>{t("Set up web access")}</button>}
    {error && <p className="machine-error" role="alert">{error}</p>}
  </div>;
}

/**
 * Where a PC's own Ovis answers, to open it there: an address the PC gave as a link (an https one
 * only), else its host and port as text to copy, since nothing here proves that address opens from
 * this device (a server bound to that PC's loopback answers only there or through its own tailnet).
 */
export function OwnOvisAddress({ own }: { own: Pick<RemoteOvis, "address" | "url"> }) {
  const t = useT();
  const [copied, setCopied] = useState(false);
  const field = useRef<HTMLElement>(null);
  // the host it named is shown with the link: an address that PC chose, which the link text alone would hide
  if (own.url) return <p className="machine-own-address"><a href={own.url} target="_blank" rel="noopener noreferrer">{t("Open that PC's Ovis")}</a><code>{urlHost(own.url)}</code></p>;
  return <div className="machine-own-address">
    <span>{t("Open it on that PC or through its own tailnet address:")}</span>
    <span className="machine-own-address-row">
      <code ref={field}>{own.address}</code>
      <button type="button" className="btn btn-ghost" onClick={() => void copyText(own.address, field.current).then(setCopied)}>{t(copied ? "Copied" : "Copy address")}</button>
    </span>
  </div>;
}

/**
 * The PC's own Ovis, when what it said matches what the PC waits for: an update it can run itself,
 * or a setup because it cannot. Anything else (an update of it that ended in another refusal) is
 * told the usual way, so the card and the line under the header never offer an action the PC is not
 * waiting for.
 */
export function ownOvisAction(machine: Pick<Machine, "remote_ovis" | "action_required">): RemoteOvis | null {
  const own = machine.remote_ovis;
  if (!own) return null;
  return (machine.action_required === "update_bridge" && own.updatable) || (machine.action_required === "setup" && !own.updatable) ? own : null;
}

/**
 * Why the last update of a PC's own Ovis failed, when the PC offers it again after one: its error then holds that
 * failure instead of the offer's own sentence (shared/machines.ts OWN_UPDATE_OFFER). Null otherwise.
 */
export function ownUpdateFailure(machine: Pick<Machine, "remote_ovis" | "action_required" | "error">): string | null {
  return ownOvisAction(machine)?.updatable && machine.error && !machine.error.startsWith(OWN_UPDATE_OFFER) ? machine.error : null;
}

function urlHost(url: string): string {
  try { return new URL(url).host; } catch { return url; }
}

/** The app-wide line for PCs that wait on the user, so a closed drawer on a phone still says so. */
export function MachineActionBanner({ machines, onSetup }: { machines: Machine[]; onSetup(machine: Machine, update?: boolean): void }) {
  const t = useT();
  // a PC that cannot be updated right now would hold this line open for good: it can be closed,
  // and the PC's own row in the sidebar keeps saying what it needs
  const [dismissed, setDismissed] = useState(readDismissed);
  useEffect(() => {
    const kept = keepDismissed(dismissed, machines);
    if (kept.length !== dismissed.length) { setDismissed(kept); writeDismissed(kept); }
  }, [machines, dismissed]);
  const running = machines.find((machine) => machine.updating && machine.action_required !== "windows_login" && machine.action_required !== "windows_start_failed");
  if (running?.updating) {
    const view = describeProgress(running.updating.progress);
    return <div className="update-notice" role="status">
      <span>{t(running.updating.ovis ? "Updating {name}'s own Ovis" : "Updating the bridge on {name}", { name: running.name })}{view ? ` · ${t(view.label)}${view.percent === null ? "" : ` ${view.percent}%`}` : "…"}</span>
    </div>;
  }
  const waiting = waitingMachines(machines, dismissed);
  const first = waiting[0];
  if (!first) return null;
  const conflict = first.action_required === "bridge_conflict";
  const update = first.action_required === "update_bridge";
  const login = first.action_required === "windows_login";
  const startupFailed = first.action_required === "windows_start_failed";
  const choosing = asksWhatToConnect(first);
  const others = waiting.length > 1 ? t(" (+{n} more)", { n: waiting.length - 1 }) : "";
  const own = ownOvisAction(first);
  // a failed update of it says so here; the PC's card says why
  const failure = ownUpdateFailure(first);
  return <div className="update-notice" role="status">
    <span title={failure === null ? undefined : machineErrorText(failure, t)}>{own ? t(failure ? "Updating {name}'s own Ovis failed{others}." : own.updatable ? "{name}'s own Ovis needs an update to reconnect{others}." : "{name}'s own Ovis needs an update on that PC{others}.", { name: first.name, others }) : t(startupFailed ? "Windows desktop startup failed on {name}{others}." : login ? "{name} is waiting for Windows sign-in{others}." : conflict ? "{name} has a bridge connection conflict{others}." : update ? "{name} needs a bridge update to reconnect{others}." : choosing ? "Choose what {name} connects to{others}." : "{name} needs web access setup{others}.", { name: first.name, others })}</span>
    <button type="button" className="btn" onClick={() => update ? void machineRequest(`/${encodeURIComponent(first.id)}/update-bridge`, "POST", shownRevision(first)).catch(() => onSetup(first, true)) : onSetup(first, false)}>{own ? t(own.updatable ? "Update this PC's Ovis" : "Reconnect") : t(login || startupFailed ? "Review startup options" : conflict ? "Reconnect" : update ? "Update bridge" : choosing ? "Choose" : "Set up web access")}</button>
    <button type="button" className="icon-button update-notice-dismiss" aria-label={t("Dismiss")} title={t("Dismiss")} onClick={() => { const next = [...dismissed, ...waiting.map(noticeKey)]; setDismissed(next); writeDismissed(next); }}><X /></button>
  </div>;
}
