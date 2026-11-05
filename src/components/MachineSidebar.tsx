import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type FocusEvent, type KeyboardEvent } from "react";
import { ArrowLeftRight, ChevronDown, ChevronRight, Monitor, Plus, Settings, SlidersHorizontal, X } from "lucide-react";
import { OWN_UPDATE_OFFER, type Machine, type MachineState, type MachineUpdate, type RemoteOvis } from "../../shared/machines.ts";
import { copyText } from "../lib/clipboard.ts";
import { AppLayoutContext, FULL_LAYOUT, MachineContext, type LayoutOffer } from "../lib/machineContext.tsx";
import { answerMachineSetup, machineRequest } from "../lib/api.ts";
import { describeProgress } from "../lib/bridgeProgress.ts";
import { keepDismissed, noticeKey, readDismissed, waitingMachines, writeDismissed } from "../lib/machineNotice.ts";
import type { AppActions } from "../lib/actions.ts";
import { Sidebar } from "./Sidebar.tsx";
import { AgentSidebar } from "./AgentSidebar.tsx";
import { SidebarActivityProvider, type SidebarActivity } from "../lib/sidebarActivity.tsx";
import { filterSuggestions, machineFilter, sidebarFilter, type SidebarBranchLabels } from "../lib/sidebarFilter.ts";
import { SidebarFilterProvider, useSidebarFilter } from "../lib/sidebarFilterContext.ts";
import { UsageMeters } from "./UsageMeters.tsx";
import { rowMenuAnchor } from "./RowMenu.tsx";
import "./Machines.css";
import { useT } from "../lib/i18n.ts";
import { useSettings } from "../lib/settings.ts";
import { requestSettingsPage } from "../lib/paletteSettings.ts";
import { useAnnouncedText } from "../lib/useAnnouncedText.ts";
import { machineErrorText, saysHerdrAway } from "../lib/userError.ts";
import { changePc, inNativeApp } from "../lib/nativeApp.ts";
import { serverIdOfPath, shellMode } from "../lib/shellMode.ts";

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
export const STATE_WORD: Readonly<Record<MachineState, string>> = {
  connecting: "Connecting…",
  connected: "Connected",
  reconnecting: "Reconnecting…",
  disconnected: "Disconnected",
  error: "Connection error",
};

/** `activity`: App's live counters per PC and finishes looked at here; both sidebar lists draw from it.
 *  `machines` are the PCs this device shows; `hiddenCount` says how many it keeps out (Settings → Remote PCs) */
interface Props { machines: Machine[]; hiddenCount?: number; selectedMachineId: string; selectedPaneId: string | null; activity: SidebarActivity; actions: AppActions; watching?: boolean; /** whether the Herdr app's window owns a PC's workspaces (lib/machineContext.tsx AppLayoutContext); none without it */ appLayout?: (machineId: string) => LayoutOffer; /** a phone's drawer is out: closing it clears the filter */ drawerOpen?: boolean; /** counts the command palette's Filter workspaces and agents: each new count shows the field and focuses it */ filterRequest?: number; onSelect(machineId: string, paneId: string | null): void; onNew(machineId: string): void; onSetup(machine: Machine, update?: boolean): void; /** a sign-in tab the usage popover opened */ onUsageLogin(paneId: string): void }
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
      for (const back of [opener, ...rows]) {
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
  const hiddenCount = props.hiddenCount ?? 0;
  useEffect(() => { if (!drawerOpen) { setQuery(""); setFilterAsked(false); } }, [drawerOpen]);
  // the roster's wait is a live region that is in the list from its first render, clipped while empty (never
  // display: none), and its words land a frame after it (lib/useAnnouncedText.ts)
  const loadingWords = useAnnouncedText(props.machines.length === 0 ? t("Loading PCs…") : null);
  // a PC whose roster has not come was not searched: the line says the answer is only of the PCs that answered
  const unanswered = props.machines.some((machine) => machine.snapshot === null);
  const noMatchWords = useAnnouncedText(filter.active && filter.matches === 0 && props.machines.length > 0 ? `${t(unanswered ? "No workspaces or agents match on the PCs that answered" : "No workspaces or agents match")}\n${t("Try other words, or clear the filter.")}` : null);
  // no top bar: a workspace starts from its PC's header (the lone Host's New workspace row), and Add PC lives in
  // Settings → Remote PCs. The filter above the lists is a row of the same grid, one field and its clear, never
  // taller than a row.
  return <SidebarActivityProvider value={activity}><SidebarFilterProvider value={filterView}><div ref={shell} className="sidebar-shell" onBlur={onSidebarBlur}>
    {filterShown && <div className="sidebar-filter" role="search" aria-label={t("Filter workspaces and agents")}>
      <label className="sidebar-filter-label" htmlFor={filterId}>{t("Filter")}</label>
      <input ref={filterInput} id={filterId} className="input sidebar-filter-input" type="search" value={query} aria-label={t("Filter workspaces and agents")} placeholder={t("Workspaces and agents")} list={suggestionsId} autoComplete="off" autoCorrect="off" autoCapitalize="off" spellCheck={false} enterKeyHint="search" onChange={(event) => setQuery(event.target.value)} onKeyDown={onFilterKeyDown} />
      <datalist id={suggestionsId}>{suggestions.map((label) => <option key={label} value={label} />)}</datalist>
      {query !== "" ? <button type="button" className="sidebar-filter-clear" aria-label={t("Clear filter")} title={t("Clear filter")} onClick={clearFilter}><X aria-hidden="true" /></button>
        : closable && <button type="button" className="sidebar-filter-clear" aria-label={t("Close filter")} title={t("Close filter")} onClick={closeFilter}><X aria-hidden="true" /></button>}
    </div>}
    <div className="machine-list" aria-label={t("PCs and workspaces")}>
      <p className={noMatchWords === null ? "visually-hidden" : "tree-state sidebar-filter-empty"} role="status">{noMatchWords}</p>
      {props.machines.map((machine) => <MachineGroup key={machine.id} {...props} machine={machine} headerless={machine.id === loneHost} />)}
      <p className={loadingWords === null ? "visually-hidden" : "tree-state"} role="status">{loadingWords}</p>
      {/* a PC kept out on this device is said, with the way to show it again */}
      {hiddenCount > 0 && <button type="button" className="machine-hidden-note" title={t("Choose the PCs this device shows")} onClick={() => { requestSettingsPage({ page: "remote", section: "sidebar-pcs" }); props.actions.openSettings(); }}>{hiddenCount === 1 ? t("1 PC hidden on this device") : t("{n} PCs hidden on this device", { n: hiddenCount })}</button>}
    </div>
    <AgentSidebar machines={props.machines} selectedMachineId={props.selectedMachineId} selectedPaneId={props.selectedPaneId} stateWord={(machine) => t(STATE_WORD[machine.state])} watching={props.watching} onSelect={props.onSelect} />
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

/** `headerless`: the sidebar's lone Host, drawn without its header. What the header held is elsewhere: the state
 *  and its notice are lines of their own, the + is the New workspace row under the workspaces, and nothing is
 *  folded with no caret to open it. A Host has no manage panel; Add PC is in Settings and the palette. */
function MachineGroup({ machine, headerless = false, ...props }: Props & { machine: Machine; headerless?: boolean }) {
  const t = useT();
  const [collapsed, setCollapsed] = useState(() => { try { return localStorage.getItem(`ovis:pc-collapsed:${machine.id}`) === "1"; } catch { return false; } });
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(machine.name);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const online = machine.state === "connected";
  // a PC that waits on the user, or is updating, shows its notice in the state line's place
  const noticed = Boolean(machine.action_required || machine.updating);
  // the state line under the name is a live region in the group from its first render, kept through the
  // notice (clipped and empty while it shows): its word lands a frame after the line (lib/useAnnouncedText.ts),
  // and every later state change, or the notice clearing, at once
  const stateWord = useAnnouncedText(noticed ? null : t(STATE_WORD[machine.state]));
  // the Host's herdr is away (the server's words name the socket it tried): the step to take is on
  // that PC, not in this browser, so it follows the words
  const nextStep = !noticed && machine.kind === "local" && machine.error !== null && saysHerdrAway(machine.error) ? t("Start herdr on this PC, or check HERDR_SOCKET.") : null;
  // one request at a time: a double-clicked Disconnect/Connect can otherwise race and leave this
  // UI's idea of the state opposite the server's until the next refetch. The method in flight is
  // kept so only a removal marks Remove PC busy (Machines.css dims that one less)
  const [busy, setBusy] = useState<string | null>(null);
  // the state disables the buttons; the ref refuses a second click that lands before that render
  const inFlight = useRef(false);
  const mutate = async (method: string, body?: unknown) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(method);
    // The selected PC moves to this one before it is removed: the server tells every tab the
    // roster without it before it answers, and a selection on a PC the roster has dropped reads
    // as one removed elsewhere ("That link's PC is not set up here"). A failure puts it back.
    const leaving = method === "DELETE" && props.selectedMachineId === machine.id ? { pane: props.selectedPaneId } : null;
    if (leaving) props.onSelect("local", null);
    try { await machineRequest(`/${machine.id}`, method, body); setError(null); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); if (leaving) props.onSelect(machine.id, leaving.pane); }
    finally { inFlight.current = false; setBusy(null); }
  };
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
  // the PC's name is the head of its workspaces, and the caret beside its + the one fold over them
  return <section className={`machine-group${props.selectedMachineId === machine.id ? " is-current" : ""}${online ? "" : " is-offline"}${context ? " is-filter-context" : ""}${headerless ? " is-headerless" : ""}`} hidden={hidden} aria-label={t("PC {name}", { name: machine.name })}>
    {!headerless && <header className="machine-header">
      <div className="machine-title">
        <span className="sidebar-mark" aria-hidden="true"><Monitor /></span>
        <span className="machine-name">{machine.name}</span>
        {/* the computer this app's server runs on; on a phone "this PC" read as the phone */}
        {machine.kind === "local" && <span className="machine-kind" title={t("The computer this app runs on")}>{t("Host")}</span>}
        <span className={`machine-dot is-${machine.action_required === "setup" ? "setup" : machine.state}`} title={machine.action_required === "setup" ? t("Setup needed") : t(STATE_WORD[machine.state])} aria-hidden="true" />
      </div>
      {machine.kind !== "local" && <button className="sidebar-row-action machine-manage" aria-label={t("Manage {name}", { name: machine.name })} title={t("Manage PC")} aria-expanded={editing} onClick={() => { setEditing(!editing); setConfirmDelete(false); }}><SlidersHorizontal aria-hidden="true" /></button>}
      {/* the fold over this PC's workspaces sits beside the + */}
      <button className="sidebar-row-action machine-toggle" aria-expanded={!folded} aria-label={folded ? t("Expand {name}", { name: machine.name }) : t("Collapse {name}", { name: machine.name })} title={folded ? t("Expand {name}", { name: machine.name }) : t("Collapse {name}", { name: machine.name })} onClick={toggle}>{folded ? <ChevronRight aria-hidden="true" /> : <ChevronDown aria-hidden="true" />}</button>
      <button className="sidebar-row-action machine-new" disabled={!online} aria-label={t("New workspace on {name}", { name: machine.name })} title={t("New workspace")} onClick={() => props.onNew(machine.id)}><Plus aria-hidden="true" /></button>
    </header>}
    {/* connected is the norm and says nothing new; every other state is spelled out */}
    {noticed && <MachineActionNotice machine={machine} onSetup={props.onSetup} />}
    <p className={`machine-state is-${machine.state}${online || stateWord === null ? " visually-hidden" : ""}`} role="status" title={noticed || machine.error === null ? undefined : machineErrorText(machine.error, t)}>
      <span className="machine-state-word">{stateWord}</span>
      {!noticed && machine.error && <span className="machine-state-detail">{machineErrorText(machine.error, t)}</span>}
      {nextStep !== null && <span className="machine-state-next">{nextStep}</span>}
    </p>
    {editing && <div className="machine-controls">
      {machine.herdr_profile_id ? <p className="field-hint">{t("Managed by herdr. Rename, disable or remove it there.")}</p> : <form onSubmit={(e) => { e.preventDefault(); void mutate("PATCH", { name }); }}><label className="field"><span className="field-label">{t("PC name")}</span><input className="input" value={name} maxLength={100} onChange={(e) => setName(e.target.value)} /></label><button className="btn" type="submit" disabled={busy !== null}>{t("Rename")}</button></form>}
      {/* The first removal click only arms the action; the second is destructive. */}
      <div className="machine-control-buttons">
        {!machine.herdr_profile_id && <button className="btn" disabled={busy !== null} onClick={() => void mutate("PATCH", { enabled: !machine.enabled })}>{t(machine.enabled ? "Disconnect" : "Connect")}</button>}
        {machine.kind === "ssh" && !["setup", "connect"].includes(machine.action_required ?? "") && <button className="btn" disabled={!machine.enabled || !machine.target} onClick={() => props.onSetup(machine)}>{t("Reconnect / setup")}</button>}
        {machine.kind === "ssh" && machine.action_required !== "connect" && <button className="btn" disabled={!machine.enabled || !machine.target} onClick={() => props.onSetup(machine, true)}>{t("Update bridge…")}</button>}
        {!machine.herdr_profile_id && <button className="btn btn-danger" disabled={busy !== null} aria-busy={busy === "DELETE" || undefined} onClick={() => { if (confirmDelete) void mutate("DELETE"); else setConfirmDelete(true); }}>{t(confirmDelete ? "Confirm remove PC" : "Remove PC")}</button>}
      </div>
      {confirmDelete && <p className="field-hint">{t(machine.kind === "relay" ? "Removes this PC here. To end its access too, revoke it under Phone & devices on that PC." : "Removes this registration. Remote sessions keep running.")}</p>}
    </div>}
    {error && <p className="machine-error" role="alert">{error}</p>}
    {/* under a filter a folded PC's roster is mounted, hidden, so the branches it reads can be found */}
    {(!folded || filtered !== null) && <div className={online ? "" : "machine-offline"} inert={!online} hidden={folded}>
      {!online && !machine.snapshot ? <p className="tree-state machine-empty" role="status">{t("No saved sessions")}</p> : <MachineContext.Provider value={machine.id}><AppLayoutContext.Provider value={props.appLayout?.(machine.id) ?? FULL_LAYOUT}><Sidebar snapshot={machine.snapshot} online={online} selectedPaneId={props.selectedMachineId === machine.id ? props.selectedPaneId : null} actions={actions} watching={props.watching} /></AppLayoutContext.Provider></MachineContext.Provider>}
    </div>}
    {/* the header's +, as the list's last row, also while the roster loads: an empty roster has its own New
        workspace, and a filtered list shows only what was looked for */}
    {headerless && online && machine.snapshot?.workspaces.length !== 0 && !filter.active && <button type="button" className="machine-new-row" onClick={() => props.onNew(machine.id)}><span className="sidebar-mark" aria-hidden="true"><Plus /></span><span className="machine-new-row-label">{t("New workspace")}</span></button>}
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
      <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void run(() => machineRequest(`/${encodeURIComponent(machine.id)}/update-bridge`, "POST").catch((e) => { if (!machine.herdr_profile_id) throw e; onSetup(machine, true); }))}>{own.latest_version ? t("Update this PC's Ovis to v{version}", { version: own.latest_version }) : t("Update this PC's Ovis")}</button>
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
      <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void run(() => machineRequest(`/${encodeURIComponent(machine.id)}/update-bridge`, "POST").catch((e) => { if (!machine.herdr_profile_id) throw e; onSetup(machine, true); }))}>{t("Update bridge")}</button>
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
  const others = waiting.length > 1 ? t(" (+{n} more)", { n: waiting.length - 1 }) : "";
  const own = ownOvisAction(first);
  // a failed update of it says so here; the PC's card says why
  const failure = ownUpdateFailure(first);
  return <div className="update-notice" role="status">
    <span title={failure === null ? undefined : machineErrorText(failure, t)}>{own ? t(failure ? "Updating {name}'s own Ovis failed{others}." : own.updatable ? "{name}'s own Ovis needs an update to reconnect{others}." : "{name}'s own Ovis needs an update on that PC{others}.", { name: first.name, others }) : t(startupFailed ? "Windows desktop startup failed on {name}{others}." : login ? "{name} is waiting for Windows sign-in{others}." : conflict ? "{name} has a bridge connection conflict{others}." : update ? "{name} needs a bridge update to reconnect{others}." : "{name} needs web access setup{others}.", { name: first.name, others })}</span>
    <button type="button" className="btn" onClick={() => update ? void machineRequest(`/${encodeURIComponent(first.id)}/update-bridge`, "POST").catch(() => onSetup(first, true)) : onSetup(first, false)}>{own ? t(own.updatable ? "Update this PC's Ovis" : "Reconnect") : t(login || startupFailed ? "Review startup options" : conflict ? "Reconnect" : update ? "Update bridge" : "Set up web access")}</button>
    <button type="button" className="icon-button update-notice-dismiss" aria-label={t("Dismiss")} title={t("Dismiss")} onClick={() => { const next = [...dismissed, ...waiting.map(noticeKey)]; setDismissed(next); writeDismissed(next); }}><X /></button>
  </div>;
}
