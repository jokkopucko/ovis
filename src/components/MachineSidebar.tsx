import { tally } from "../lib/usageCounters.ts";
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type FocusEvent, type KeyboardEvent, type ReactNode } from "react";
import { Download, EyeOff, Inbox, Pencil, Plug, Plus, RefreshCw, Search, Settings, SlidersHorizontal, Trash2, Unplug, X } from "lucide-react";
import { OWN_UPDATE_OFFER, pairedPc, type Machine, type MachineState, type MachineUpdate, type RemoteOvis } from "../../shared/machines.ts";
import { copyText } from "../lib/clipboard.ts";
import { AppLayoutContext, FULL_LAYOUT, MachineContext, type LayoutOffer } from "../lib/machineContext.tsx";
import { answerMachineSetup, askMachineRetry, machineRequest } from "../lib/api.ts";
import { describeProgress } from "../lib/bridgeProgress.ts";
import { keepDismissed, noticeKey, readDismissed, waitingMachines, writeDismissed } from "../lib/machineNotice.ts";
import type { AppActions } from "../lib/actions.ts";
import { Sidebar } from "./Sidebar.tsx";
import { MachineHeader, useMachineFold } from "./MachineHeader.tsx";
import { AgentSidebar } from "./AgentSidebar.tsx";
import { SidebarSplit } from "./SidebarSplit.tsx";
import { storedSidebarSplit, storeSidebarSplit, type SplitFold, type SplitOrder } from "../lib/sidebarSplit.ts";
import { SidebarActivityProvider, type SidebarActivity } from "../lib/sidebarActivity.tsx";
import { filterSuggestions, machineFilter, sidebarFilter, type SidebarBranchLabels } from "../lib/sidebarFilter.ts";
import { SidebarFilterProvider, useSidebarFilter } from "../lib/sidebarFilterContext.ts";
import { UsageMeters } from "./UsageMeters.tsx";
import { SidebarAccountPcs } from "./SidebarAccountPcs.tsx";
import { ShellPcs, unlistedShellPcs, useShellPcs } from "./ShellPcs.tsx";
import { NewPcRowTag } from "./NewPcRowTag.tsx";
import { RowMenu, rowMenuAnchor, type RowMenuItem } from "./RowMenu.tsx";
import { ConfirmDialog } from "./ConfirmDialog.tsx";
import { sidebarAgents } from "../lib/sidebarAgents.ts";
import { useEdgeFades } from "../lib/useEdgeFades.ts";
import "./Machines.css";
import "./SidebarSections.css";
import { t, useT } from "../lib/i18n.ts";
import { asksChoice, FoundHerdrChoices } from "./FoundHerdrChoices.tsx";
import { useSettings } from "../lib/settings.ts";
import { useAnnouncedText } from "../lib/useAnnouncedText.ts";
import { machineErrorText, saysHerdrAway, sshFailure } from "../lib/userError.ts";
import { useMediaQuery } from "../lib/useMediaQuery.ts";
import { SHEET_QUERY } from "../lib/sheets.ts";
import { leavePageFromSheet } from "../lib/sheetHistory.ts";
import { chooseAnotherPc, inNativeApp } from "../lib/nativeApp.ts";
import { serverIdOfPath, shellMode } from "../lib/shellMode.ts";
import { canHideMachine, HIDDEN_MACHINES_MAX, setHiddenMachines, useHiddenMachines, withMachineHidden } from "../lib/hiddenMachines.ts";
import { ExternalLink } from "../lib/externalLink.ts";
import { MachineOffLine, useRecheck } from "./MachineOffLine.tsx";
import { outOfReachReason } from "./relayPcState.tsx";

export const DRAWER_QUERY = "(max-width: 768px)";

const shownRevision = (machine: Machine) => machine.ovis_update?.revision ? { revision: machine.ovis_update.revision } : undefined;

export function pcListExit(page: { nativeApp: boolean; relayShell: boolean; pathname: string }): "app" | "shell" | null {
  if (page.nativeApp) return "app";
  if (page.relayShell && serverIdOfPath(page.pathname) !== null) return "shell";
  return null;
}

/**
 * Where a phone's More → Connect a PC leads (relay step 1): a PC page of the hosted app, in a browser or inside the phone
 * app (which opens it there), goes to the hosted app's My PCs ("shell"); a PC the phone app opened by its address
 * goes back to the app's own screens ("app"); anywhere else there is none. Unlike pcListExit, the phone app does not
 * come first: a hosted PC page inside it adds a PC on the hosted side, where its pairings are.
 */
export function addPcExit(page: { nativeApp: boolean; relayShell: boolean; pathname: string }): "app" | "shell" | null {
  return pcListExit({ ...page, nativeApp: false }) ?? (page.nativeApp ? "app" : null);
}

/** The hosted app's My PCs, opened from a PC's More: its Back comes back here (RelayShell's `addEntry`). */
export const ADD_PC_FROM_KEY = "ovis-add-pc-from";

/**
 * A phone's More item to another PC or way (relay step 1), named as its screen is, Connect a PC: a phone connects to
 * PCs. None on a desktop, which adds a PC from Settings → Devices and PCs.
 */
export function addPcMoreItem(exit: "app" | "shell" | null, sheetWidth: boolean): RowMenuItem | null {
  return exit !== null && sheetWidth ? { id: "add-pc", label: t("Connect a PC"), icon: Plus, run: () => void openAddPc(exit) } : null;
}

/**
 * Opens Connect a PC where `exit` (addPcExit) leads: the phone app's connect tabs keep this PC open until another is picked;
 * the hosted app's loads once More's step off its entry has landed, which would otherwise cancel it or bring this page back.
 */
export async function openAddPc(exit: "app" | "shell"): Promise<void> {
  if (exit === "app") { await chooseAnotherPc(); return; }
  try { sessionStorage.setItem(ADD_PC_FROM_KEY, window.location.pathname); } catch { /* no storage: Back drops #add and stays */ }
  leavePageFromSheet("/#add");
}

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

interface Props { machines: Machine[]; footerStart?: ReactNode; inbox?: { waiting: number; open(): void } | null; afterPcs?: ReactNode; allMachines?: Machine[]; selectedMachineId: string; selectedPaneId: string | null; activity: SidebarActivity; actions: AppActions; watching?: boolean; appLayout?: (machineId: string) => LayoutOffer; drawerOpen?: boolean; filterRequest?: number; onSelect(machineId: string, paneId: string | null): void; onNew(machineId: string): void; onSetup(machine: Machine, update?: boolean): void; onUsageLogin(paneId: string): void }
export function MachineSidebar(props: Props) {
  const t = useT();
  const activity = props.activity;
  // the filter's query lives here and nowhere else: not in storage, not in the address, not past this
  // mount (lib/sidebarFilter.ts).
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
  const loneHost = props.machines.length === 1 && props.machines[0]!.kind === "local" ? props.machines[0]!.id : null;

  const exitToPcs = useMemo(() => pcListExit({ nativeApp: inNativeApp(), relayShell: shellMode() === "relay", pathname: window.location.pathname }), []);
  const drawerWidth = useMediaQuery(DRAWER_QUERY);
  const pagePcs = useShellPcs(exitToPcs === "shell", drawerWidth ? props.drawerOpen === true : true);
  const listedPcs = props.allMachines ?? props.machines;
  const [accountRows, setAccountRows] = useState<readonly string[]>([]);
  const shellPcs = useMemo(() => ({ ...pagePcs, pcs: unlistedShellPcs(pagePcs.pcs, listedPcs, accountRows) }), [pagePcs, listedPcs, accountRows]);
  // the account's rows stand in for this device's own links while those PCs are added: they open them as the links do
  const ownLinks = useMemo(() => new Set(pagePcs.pcs.map((pc) => pc.server_id)), [pagePcs.pcs]);
  // the lone host goes unnamed only while it is drawn without its header: beside other PCs its name is shown, and found
  const headerless = loneHost !== null && shellPcs.pcs.length === 0;
  const unnamed = useMemo(() => new Set(headerless ? [loneHost] : []), [headerless, loneHost]);
  const filter = useMemo(() => sidebarFilter(query, props.machines, { machineId: props.selectedMachineId, paneId: props.selectedPaneId }, t, branchLabels, unnamed), [query, props.machines, props.selectedMachineId, props.selectedPaneId, t, branchLabels, unnamed]);
  const filterView = useMemo(() => ({ filter, reportBranches }), [filter, reportBranches]);
  // the field offers the labels the rows show, as the browser's own suggestions: nothing typed is kept
  const suggestions = useMemo(() => filterSuggestions(props.machines, branchLabels, unnamed), [props.machines, branchLabels, unnamed]);
  const { settings } = useSettings();
  const shell = useRef<HTMLDivElement>(null);
  const [filterAsked, setFilterAsked] = useState(false);
  const closable = !settings.sidebarFilter && filterAsked;
  const filterShown = settings.sidebarFilter || filterAsked || query !== "";
  const filterRequest = props.filterRequest ?? 0;
  const lastFilterRequest = useRef(filterRequest);
  const focusFilter = useRef(false);
  useEffect(() => { setFilterAsked(query !== ""); }, [settings.sidebarFilter]);
  useEffect(() => {
    if (filterRequest === lastFilterRequest.current) return;
    lastFilterRequest.current = filterRequest;
    focusFilter.current = true;
    setFilterAsked(true);
  }, [filterRequest]);
  useEffect(() => {
    if (!focusFilter.current || !filterShown) return;
    focusFilter.current = false;
    filterInput.current?.focus();
  });
  const closeFilter = () => { setQuery(""); setFilterAsked(false); };
  const clearFilter = () => { setQuery(""); filterInput.current?.focus(); };
  useLayoutEffect(() => {
    if (!closable) return;
    const opener = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null;
    const sidebar = shell.current;
    return () => {
      const active = document.activeElement;
      if (active !== null && active !== document.body) return;
      const rows = sidebar?.querySelectorAll<HTMLElement>('.machine-list :is(button:not([disabled]), [role="button"][tabindex="0"])') ?? [];
      const gear = sidebar?.querySelector<HTMLElement>(".sidebar-footer-settings") ?? null;
      for (const back of [opener, ...rows, gear]) {
        if (back === null || !back.isConnected || back.closest(".sidebar-filter, [inert]") !== null || back.getClientRects().length === 0) continue;
        back.focus({ preventScroll: true });
        if (document.activeElement === back) return;
      }
    };
  }, [closable]);
  const onFilterKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== "Escape" || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
    if (query === "" && !closable) return;
    event.preventDefault();
    event.stopPropagation();
    if (query === "") closeFilter(); else setQuery("");
  };
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
  const hiddenIds = useHiddenMachines();
  const roster = props.allMachines ?? props.machines;
  const listId = useId();
  const machineList = useRef<HTMLDivElement>(null);
  useEdgeFades(machineList);
  const order: SplitOrder = settings.agentGroups ? "agents" : "pcs";
  const [splits, setSplits] = useState(() => ({ pcs: storedSidebarSplit("pcs"), agents: storedSidebarSplit("agents") }));
  const [agentsFold, setAgentsFold] = useState<{ folded: boolean; seq: number } | null>(null);
  const agentsListId = useId();
  const changeSplit = useCallback((height: number | null) => { setSplits((last) => ({ ...last, [order]: height })); storeSidebarSplit(order, height); }, [order]);
  const foldSections = (sections: readonly SplitFold[]) => {
    setAgentsFold((last) => ({ folded: sections.includes("agents"), seq: (last?.seq ?? 0) + 1 }));
  };
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
    focusListAfterHide.current = next.indexOf(id) < HIDDEN_MACHINES_MAX;
    setHiddenMachines(next);
  };
  useEffect(() => { if (!drawerOpen) { setQuery(""); setFilterAsked(false); } }, [drawerOpen]);
  const loadingWords = useAnnouncedText(props.machines.length === 0 ? t("Loading PCs…") : null);
  const unanswered = props.machines.some((machine) => machine.snapshot === null);
  const noMatchWords = useAnnouncedText(filter.active && filter.matches === 0 && props.machines.length > 0 ? `${t(unanswered ? "No workspaces or agents match on the PCs that answered" : "No workspaces or agents match")}\n${t("Try other words, or clear the filter.")}` : null);
  const agentList = <AgentSidebar key="agents" foldRequest={agentsFold} listId={agentsListId} machines={props.machines} selectedMachineId={props.selectedMachineId} selectedPaneId={props.selectedPaneId} stateWord={(machine) => t(STATE_WORD[machine.state])} watching={props.watching} onSelect={props.onSelect} />;
  return <SidebarActivityProvider value={activity}><SidebarFilterProvider value={filterView}><div ref={shell} className={`sidebar-shell${order === "agents" ? " is-agents-first" : ""}`} onBlur={onSidebarBlur} onKeyDown={stepRows}>
    {filterShown && <div className="sidebar-filter" role="search" aria-label={t("Filter workspaces and agents")}>
      <Search className="sidebar-filter-glass" aria-hidden="true" />
      <input ref={filterInput} id={filterId} className="input sidebar-filter-input" type="search" value={query} aria-label={t("Filter workspaces and agents")} placeholder={t("Filter workspaces and agents")} list={suggestionsId} autoComplete="off" autoCorrect="off" autoCapitalize="off" spellCheck={false} enterKeyHint="search" onChange={(event) => setQuery(event.target.value)} onKeyDown={onFilterKeyDown} />
      <datalist id={suggestionsId}>{suggestions.map((label) => <option key={label} value={label} />)}</datalist>
      {query !== "" ? <button type="button" className="sidebar-filter-clear" aria-label={t("Clear filter")} title={t("Clear filter")} onClick={clearFilter}><X aria-hidden="true" /></button>
        : closable && <button type="button" className="sidebar-filter-clear" aria-label={t("Close filter")} title={t("Close filter")} onClick={closeFilter}><X aria-hidden="true" /></button>}
    </div>}
    {settings.agentGroups && agentList}
    {settings.agentGroups && <SidebarSplit shell={shell} order={order} split={splits[order]} controls={agentsListId} onSplit={changeSplit} onFold={foldSections} />}
    <section className="pcs-sidebar" aria-label={t("PCs")}>
      <div ref={machineList} className="machine-list" id={listId} aria-label={t("PCs and workspaces")}>
        <p className={noMatchWords === null ? "visually-hidden" : "tree-state sidebar-filter-empty"} role="status">{noMatchWords}</p>
        {props.machines.map((machine) => <MachineGroup key={machine.id} {...props} watching={props.watching || machine.view_only === true} machine={machine} headerless={headerless && machine.id === loneHost} canHide={canHideMachine(roster, hiddenIds, machine.id)} onHide={() => hideMachine(machine.id)} />)}
        {/* a driving window on any PC, the phone app and the hosted shell too: the account's PCs this PC does not list yet, added to it one by one */}
        {!props.watching && <SidebarAccountPcs machines={roster} hidden={filter.active} onAdded={props.actions.connectPc} onListed={setAccountRows} openable={ownLinks} />}
        <p className={loadingWords === null ? "visually-hidden" : "tree-state"} role="status">{loadingWords}</p>
        {/* the hosted app on a PC's page: the other PCs this device opens, a tap away (ShellPcs.tsx) */}
        {exitToPcs === "shell" && <ShellPcs {...shellPcs} />}
      </div>
      {/* part of the PC section, so the split below measures it with the PCs (SidebarSplit.tsx) */}
      {props.afterPcs}
    </section>
    {!settings.agentGroups && <SidebarSplit shell={shell} order={order} split={splits[order]} controls={listId} onSplit={changeSplit} onFold={foldSections} />}
    {!settings.agentGroups && agentList}
    <footer className="sidebar-footer">
      {props.footerStart}
      {/* no Install app here: a page knows it is installed only in the app's own window, so a row kept
          showing in every tab. */}
      <div className="sidebar-footer-row">
        <button className="btn btn-ghost sidebar-footer-action sidebar-footer-settings" aria-label={t("Settings")} title={t("Settings (⌘⇧,)")} onClick={() => { tally(() => props.actions.counted?.("settings", "button")); props.actions.openSettings(); }}><Settings aria-hidden="true" /></button>
        {props.inbox && <InboxEntry {...props.inbox} />}
        <UsageMeters watching={props.watching} onLocalLogin={props.watching ? undefined : props.onUsageLogin} />
      </div>
    </footer>
  </div></SidebarFilterProvider></SidebarActivityProvider>;
}

/** the way into the agent inbox, beside the gear; its badge counts the sessions waiting for you, as More's dot does */
function InboxEntry({ waiting, open }: { waiting: number; open(): void }) {
  const t = useT();
  const label = waiting > 0 ? `${t("Inbox")} · ${t("{count} waiting for you", { count: waiting })}` : t("Inbox");
  return (
    <button type="button" className="btn btn-ghost sidebar-footer-action sidebar-footer-inbox" aria-label={label} title={t("Inbox")} onClick={open}>
      <Inbox aria-hidden="true" />
      {waiting > 0 && <span className="header-more-dot is-waiting" data-count={String(waiting)} aria-hidden="true" />}
    </button>
  );
}

// the server's words for a relay PC's failed connection (shared/relay-channel.ts, server/relay-pc.ts)
const RELAY_UNREACHABLE = /^(The relay (could not be reached|connection failed|closed the connection|did not answer)|Relay carrier lost during admission)/;
const RELAY_PC_SILENT = /^The PC did not answer through the relay/;

export type MachineAway = "off" | "unreachable" | "refused" | "unresponsive";

/**
 * Whether a PC this server added keeps failing to connect for a reason a later try may clear (it retries on its
 * own: `reconnecting` with the last failure), and which: the relay had nobody for it (`off`, as #4230's PCs list
 * says it), the relay or ssh could not reach it (`unreachable`: ssh's refusal or silence does not prove it off),
 * the relay turned this server away (`refused`), or it answered and did not finish connecting (`unresponsive`).
 * Null for a failure that does not say which (a lost connection, until the next try's), anything a later try cannot
 * clear (a refusal for good, a sign-in, a setup, an update), and a PC herdr or herdr-core manages.
 */
export function machineAway(machine: Pick<Machine, "kind" | "enabled" | "state" | "error" | "action_required" | "updating" | "herdr_profile_id">): MachineAway | null {
  if (!machine.enabled || machine.state !== "reconnecting" || machine.error === null || machine.action_required || machine.updating || machine.herdr_profile_id) return null;
  if (machine.kind === "relay") {
    if (machine.error.startsWith("The relay turned this device away")) return "refused";
    if (machine.error.startsWith("The PC did not finish the connection")) return "unresponsive";
    if (RELAY_UNREACHABLE.test(machine.error)) return "unreachable";
    return RELAY_PC_SILENT.test(machine.error) ? "off" : null;
  }
  if (machine.kind !== "ssh" || !/connect to host/i.test(machine.error)) return null;
  const reason = sshFailure(machine.error)?.reason;
  return reason === "refused" || reason === "timeout" || reason === "unreachable" ? "unreachable" : null;
}

export function machineDotState(machine: Machine): string {
  if (machine.action_required === "setup" || asksWhatToConnect(machine)) return "setup";
  return machineAway(machine) !== null ? "disconnected" : machine.state;
}

export type ManageAction = "rename" | "toggle" | "setup" | "update" | "hide" | "remove";

/** Settings → Devices and PCs offers Remove for a PC added here that is not connected (herdr's own and herdr-core's stay). */
export function removablePc(machine: Pick<Machine, "kind" | "state" | "herdr_profile_id">): boolean {
  return machine.state !== "connected" && machine.herdr_profile_id === undefined && (machine.kind === "ssh" || pairedPc(machine));
}

export function manageActions(machine: Pick<Machine, "kind" | "herdr_profile_id" | "enabled" | "target" | "action_required">, { busy, canHide }: { busy: boolean; canHide: boolean }): { id: ManageAction; disabled: boolean }[] {
  const own = !machine.herdr_profile_id && machine.kind !== "hc";
  const reachable = machine.enabled && Boolean(machine.target);
  const actions: { id: ManageAction; disabled: boolean }[] = [];
  if (own) actions.push({ id: "rename", disabled: busy }, { id: "toggle", disabled: busy });
  if (machine.kind === "ssh") {
    if (machine.action_required !== "setup" && machine.action_required !== "connect") actions.push({ id: "setup", disabled: !reachable });
    if (machine.action_required !== "connect") actions.push({ id: "update", disabled: !reachable });
  }
  if (canHide) actions.push({ id: "hide", disabled: busy });
  if (own) actions.push({ id: "remove", disabled: busy });
  return actions;
}

function MachineGroup({ machine, headerless = false, canHide, onHide, ...props }: Props & { machine: Machine; headerless?: boolean; canHide: boolean; onHide(): void }) {
  const t = useT();
  const compact = useSettings().settings.sidebarRows === "one";
  const drawer = useMediaQuery(DRAWER_QUERY);
  const sheet = useMediaQuery(SHEET_QUERY);
  const [collapsed, toggleCollapsed] = useMachineFold(machine.id);
  const [menu, setMenu] = useState<HTMLElement | null>(null);
  const manageButton = useRef<HTMLButtonElement>(null);
  const titleButton = useRef<HTMLButtonElement>(null);
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(machine.name);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const online = machine.state === "connected";
  const noticed = Boolean(machine.action_required || machine.updating);
  const stateWord = useAnnouncedText(noticed ? null : t(STATE_WORD[machine.state]));
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
  const away = machineAway(machine);
  const awayReason = away === null ? null
    : machine.kind === "ssh" ? sshWords
    : away === "unresponsive" ? t("{name} answered but did not finish connecting in time. It may be busy or restarting. Try again; if it keeps happening, restart Ovis on {name}.", { name: machine.name })
    : away === "off" ? outOfReachReason({ displayState: "offline", last_seen_at: null }, t)
    // the relay's own words: #4230's reasons for it name the viewing device's network, and this is this server's
    : machineErrorText(machine.error!, t);
  const nextStep = !noticed && machine.kind === "local" && machine.error !== null && saysHerdrAway(machine.error) ? t("Start herdr on this PC, or check HERDR_SOCKET.")
    : ssh !== null ? t("Reconnect or change its address from Manage PC, the sliders beside its name.") : null;
  // one request at a time: a double-clicked Disconnect/Connect can otherwise race and leave this
  // UI's idea of the state opposite the server's until the next refetch
  const [busy, setBusy] = useState(false);
  // the state disables the items; the ref refuses a second request that lands before that render
  const inFlight = useRef(false);
  const mutate = async (method: string, body?: unknown, inDialog = false) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    // The selected PC moves to this one before it is removed: the server tells every tab the
    // roster without it before it answers, and a selection on a PC the roster has dropped reads
    // as one removed elsewhere ("That link's PC is not set up here").
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
  const recheck = useRecheck(machine.id, () => askMachineRetry(machine.id), away !== null);
  // a PC of the relay (one of the account's) says where it is by the dot beside its name alone, its words a tooltip:
  // the server keeps trying it, so there is nothing to read or press under it
  const quiet = machine.kind === "relay" && !noticed;
  const dotWords = away === "off" ? t("Can't reach the PC: it may be off") : away !== null ? awayReason ?? machineErrorText(machine.error!, t) : t(STATE_WORD[machine.state]);
  const closeMenu = useCallback(() => setMenu(null), []);
  const endRename = (save: boolean) => {
    setRenaming(false);
    const typed = name.trim();
    if (save && typed !== "" && typed !== machine.name) void mutate("PATCH", { name: typed });
  };
  const stateWords = machine.action_required === "setup" ? t("Setup needed") : asksWhatToConnect(machine) ? t("Choose what to connect to") : t(STATE_WORD[machine.state]);
  const stateLine = machine.kind === "hc" ? stateWords : `${stateWords} · ${machine.kind === "relay" ? t("through the relay") : machine.kind === "address" ? t("by its address") : t("over SSH")}`;
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
  const { filter } = useSidebarFilter();
  const filtered = machineFilter(filter, machine.id);
  const [filterFold, setFilterFold] = useState<boolean | null>(null);
  useEffect(() => { if (!filter.active) setFilterFold(null); }, [filter.active]);
  const hidden = filtered !== null && !filtered.shown;
  const matched = filtered !== null && (filtered.matched || filtered.matchedWorkspaces.size > 0 || filtered.matchedPanes.size > 0);
  const kept = filtered !== null && (matched || filtered.workspaces.size > 0 || filtered.panes.size > 0);
  const folded = headerless ? false : filtered === null ? collapsed : filterFold ?? (collapsed && !kept);
  const context = filtered !== null && !matched;
  const toggle = () => {
    if (filtered !== null) { setFilterFold(!folded); return; }
    toggleCollapsed();
  };
  const agentCount = useMemo(() => sidebarAgents(machine.snapshot).length, [machine.snapshot]);
  const current = props.selectedMachineId === machine.id;
  // a watching device is refused a new workspace (G-040): the + stays where it is, disabled, and says why
  const canCreate = online && !props.watching;
  const createTitle = props.watching ? `${t("New workspace")} · ${t("View only")}` : t("New workspace");
  const renameField = renaming ? <input
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
    /> : undefined;
  return <section className={`machine-group${current ? " is-current" : ""}${online ? "" : " is-offline"}${context ? " is-filter-context" : ""}${headerless ? " is-headerless" : ""}${folded ? " is-folded" : ""}${compact ? "" : " is-two-line"}`} hidden={hidden} aria-label={t("PC {name}", { name: machine.name })}>
    {!headerless && <MachineHeader machine={machine} folded={folded} onToggle={toggle} compact={compact} current={current} name={renameField} titleRef={titleButton}
      agents={online && agentCount > 0 ? { count: agentCount, words: agentCount === 1 ? t("1 agent") : t("{n} agents", { n: agentCount }) } : null}
      dot={online ? null : { state: machineDotState(machine), title: quiet ? dotWords : stateWords }}
      actions={machine.kind !== "local" && <button ref={manageButton} type="button" className="sidebar-row-action machine-manage" aria-label={t("Manage {name}", { name: machine.name })} title={t("Manage PC")} aria-haspopup={sheet ? "dialog" : "menu"} aria-expanded={menu !== null} onClick={(event) => setMenu(menu === null ? event.currentTarget : null)}><SlidersHorizontal aria-hidden="true" /></button>}
      end={<button className="sidebar-row-action machine-new" disabled={!canCreate} aria-label={t("New workspace on {name}", { name: machine.name })} title={createTitle} onClick={() => props.onNew(machine.id)}><Plus aria-hidden="true" /></button>} />}
    {/* C3 pin 2 (#16): the hosted app's own PC, new in the account: its tag and one-tap removal on the row itself */}
    {machine.kind === "local" && <NewPcRowTag serverId={machine.server_id ?? undefined} />}
    {noticed && <MachineActionNotice machine={machine} onSetup={props.onSetup} />}
    {away !== null && !quiet ? <MachineOffLine state={away === "off" ? "off" : "unreachable"} reason={awayReason} title={awayReason ?? machineErrorText(machine.error!, t)} checking={recheck.checking} failure={recheck.failure} onCheck={props.watching || machine.kind === "relay" ? undefined : recheck.check} returnFocus={() => titleButton.current} />
    : quiet ? <p className="machine-state visually-hidden" role="status">{online ? null : dotWords}</p>
    : <p className={`machine-state is-${machine.state}${online || stateWord === null ? " visually-hidden" : ""}`} role={machine.state === "error" ? "alert" : "status"} title={noticed || machine.error === null ? undefined : machineErrorText(machine.error, t)}>
      <span className="machine-state-word">{stateWord}</span>
      {!noticed && machine.error && <span className="machine-state-detail">{sshWords ?? machineErrorText(machine.error, t)}</span>}
      {sshWords !== null && <code className="machine-state-raw">{machine.error}</code>}
      {nextStep !== null && <span className="machine-state-next">{nextStep}</span>}
    </p>}
    {menu && <RowMenu anchor={menu} title={machine.name} items={manageItems()} onClose={closeMenu} header={<span className="machine-menu-head">
      <span className="machine-menu-name">{machine.name}</span>
      <span className="machine-menu-state">{stateLine}</span>
      {machine.runtime && <span className="machine-menu-note">{t("Runtime: {runtime}", { runtime: machine.runtime })}</span>}
      {manageNote !== null && <span className="machine-menu-note">{manageNote}</span>}
    </span>} />}
    {confirmRemove && <ConfirmDialog title={t("Remove PC {name}?", { name: machine.name })} body={t(pairedPc(machine) ? "Removes this PC here. To end its access too, revoke it under Phone & devices on that PC." : "Removes this registration. Remote sessions keep running.")} confirmLabel={t("Remove PC")}
      onConfirm={async () => { await mutate("DELETE", undefined, true); setConfirmRemove(false); }} onClose={() => setConfirmRemove(false)} />}
    {error && <p className="machine-error" role="alert">{error}</p>}
    {!quiet && !folded && !online && !machine.snapshot && (machine.state === "disconnected" || machine.state === "error") && <p className="tree-state machine-empty" role="status">{t("No saved sessions")}</p>}
    {(!folded || filtered !== null) && (machine.snapshot !== null || online) && <div className={online ? "" : "machine-offline"} inert={!online} hidden={folded}>
      <MachineContext.Provider value={machine.id}><AppLayoutContext.Provider value={props.appLayout?.(machine.id) ?? FULL_LAYOUT}><Sidebar snapshot={machine.snapshot} online={online} selectedPaneId={props.selectedMachineId === machine.id ? props.selectedPaneId : null} actions={actions} watching={props.watching} /></AppLayoutContext.Provider></MachineContext.Provider>
    </div>}
    {headerless && (!compact || drawer) && online && machine.snapshot?.workspaces.length !== 0 && !filter.active && <button type="button" className="machine-new-row" disabled={!canCreate} title={props.watching ? createTitle : undefined} onClick={() => props.onNew(machine.id)}><span className="sidebar-mark" aria-hidden="true"><Plus /></span><span className="machine-new-row-label">{t("New workspace")}</span></button>}
  </section>;
}

function useStageSeconds(update: MachineUpdate): number {
  const key = `${update.job_id}:${update.progress?.stage ?? ""}`;
  const [start, setStart] = useState(() => ({ key, at: Date.now() - (update.progress?.elapsed_ms ?? 0) }));
  const [now, setNow] = useState(Date.now());
  useEffect(() => { if (start.key !== key) setStart({ key, at: Date.now() - (update.progress?.elapsed_ms ?? 0) }); }, [key]);
  useEffect(() => { const timer = window.setInterval(() => setNow(Date.now()), 1000); return () => window.clearInterval(timer); }, []);
  return Math.max(0, Math.round((now - start.at) / 1000));
}

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
  if (machine.action_required === "choose_herdr" && (machine.found_herdr_sessions || machine.found_ovis) && machine.target) return <FoundHerdrChoices sessions={machine.found_herdr_sessions ?? []} ownOvis={machine.found_ovis} error={machine.error} busy={busy || !machine.enabled} onChoose={(choice) => onSetup({ ...machine, target: { ...machine.target!, ...choice, ...(machine.herdr_profile_id ? { session: machine.target?.session } : {}) } }, false)} />;
  if (machine.action_required === "bridge_conflict") return <div className="machine-action" role="alert">
    <p className="machine-action-text"><strong>{t("Bridge connection conflict")}</strong><span>{t("Update the apps connected to this PC to the same version, or disconnect the other app, then reconnect here. Sessions keep running.")}</span>{machine.error && <span className="machine-action-reason">{machineErrorText(machine.error, t)}</span>}</p>
    <button type="button" className="btn btn-primary" onClick={() => onSetup(machine, false)}>{t("Reconnect")}</button>
  </div>;
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
      {machine.error && !/different version|setup needs approval/.test(machine.error) && <span className="machine-action-reason">{machineErrorText(machine.error, t)}</span>}
    </p>
    {update ? <div className="machine-action-buttons">
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
  if (own.url) return <p className="machine-own-address"><ExternalLink kind="ovis" href={own.url}>{t("Open that PC's Ovis")}</ExternalLink><code>{urlHost(own.url)}</code></p>;
  return <div className="machine-own-address">
    <span>{t("Open it on that PC or through its own tailnet address:")}</span>
    <span className="machine-own-address-row">
      <code ref={field}>{own.address}</code>
      <button type="button" className="btn btn-ghost" onClick={() => void copyText(own.address, field.current).then(setCopied)}>{t(copied ? "Copied" : "Copy address")}</button>
    </span>
  </div>;
}

export function ownOvisAction(machine: Pick<Machine, "remote_ovis" | "action_required">): RemoteOvis | null {
  const own = machine.remote_ovis;
  if (!own) return null;
  return (machine.action_required === "update_bridge" && own.updatable) || (machine.action_required === "setup" && !own.updatable) ? own : null;
}

export function ownUpdateFailure(machine: Pick<Machine, "remote_ovis" | "action_required" | "error">): string | null {
  return ownOvisAction(machine)?.updatable && machine.error && !machine.error.startsWith(OWN_UPDATE_OFFER) ? machine.error : null;
}

function urlHost(url: string): string {
  try { return new URL(url).host; } catch { return url; }
}

export function MachineActionBanner({ machines, onSetup }: { machines: Machine[]; onSetup(machine: Machine, update?: boolean): void }) {
  const t = useT();
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
  const failure = ownUpdateFailure(first);
  return <div className="update-notice" role="status">
    <span title={failure === null ? undefined : machineErrorText(failure, t)}>{own ? t(failure ? "Updating {name}'s own Ovis failed{others}." : own.updatable ? "{name}'s own Ovis needs an update to reconnect{others}." : "{name}'s own Ovis needs an update on that PC{others}.", { name: first.name, others }) : t(startupFailed ? "Windows desktop startup failed on {name}{others}." : login ? "{name} is waiting for Windows sign-in{others}." : conflict ? "{name} has a bridge connection conflict{others}." : update ? "{name} needs a bridge update to reconnect{others}." : choosing ? "Choose what {name} connects to{others}." : "{name} needs web access setup{others}.", { name: first.name, others })}</span>
    <button type="button" className="btn" onClick={() => update ? void machineRequest(`/${encodeURIComponent(first.id)}/update-bridge`, "POST", shownRevision(first)).catch(() => onSetup(first, true)) : onSetup(first, false)}>{own ? t(own.updatable ? "Update this PC's Ovis" : "Reconnect") : t(login || startupFailed ? "Review startup options" : conflict ? "Reconnect" : update ? "Update bridge" : choosing ? "Choose" : "Set up web access")}</button>
    <button type="button" className="icon-button update-notice-dismiss" aria-label={t("Dismiss")} title={t("Dismiss")} onClick={() => { const next = [...dismissed, ...waiting.map(noticeKey)]; setDismissed(next); writeDismissed(next); }}><X /></button>
  </div>;
}
