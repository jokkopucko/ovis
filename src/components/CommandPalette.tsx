import { useAppLayout, MachineContext, useMachineApi, useMachineId } from "../lib/machineContext.tsx";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ComponentType, type FocusEvent as ReactFocusEvent, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent } from "react";
import { Bell, Columns2, CornerLeftUp, Folder, FolderInput, FolderOpen, FolderSearch, History, ListFilter, LoaderCircle, Maximize2, MessageSquarePlus, Minimize2, Monitor, PanelLeft, Pencil, Pin, Plus, Puzzle, RefreshCw, Rows2, Settings, SunMoon, SwitchCamera, X } from "lucide-react";

import "./CommandPalette.css";

import type { DirectoryListing, HerdrPane, PluginActions, SessionSnapshot, TabInfo } from "../../shared/protocol.ts";
import type { Machine } from "../../shared/machines.ts";
import { ApiError } from "../lib/api.ts";
import { paneStatus, STATUS_WORD } from "../lib/status.ts";
import { zoomMode } from "../lib/layoutMap.ts";
import type { AppActions, PaneView } from "../lib/actions.ts";
import { FILTER_KEYS, offeredPluginActions, parseQuery, STATUS_FILTERS, statusCounts, type OfferedPluginAction, type PaletteStatusFilter } from "../lib/paletteSearch.ts";
import { actionAliases, rankByTitle, requestSettingsPage, settingsPageEntries } from "../lib/paletteSettings.ts";
import { Ownership, runPluginActionToEnd } from "../lib/pluginRun.ts";
import { shortcutDisplayKeys, formatKeys, type ShortcutId } from "../lib/shortcuts.ts";
import { useSettings } from "../lib/settings.ts";
import { AgentMark } from "./AgentMark.tsx";
import { displayPaneTitle, StatusBadge } from "./Sidebar.tsx";
import { PAGES } from "./SettingsDialog.tsx";
import { folderName, placeLine } from "../lib/paneName.ts";
import { agentTabName } from "../lib/sidebarAgents.ts";
import { autoTabLabel, tabLabel } from "../lib/tabName.ts";
import { shownTabLabels, subscribeTabLabels } from "../lib/tabLabels.ts";
import { useT } from "../lib/i18n.ts";
import { useFocusTrap } from "../lib/useFocusTrap.ts";
import { useSheetSwipe } from "../lib/sheets.ts";
import { usePhoneSheetBack } from "../lib/sheetHistory.ts";
import { useMediaQuery } from "../lib/useMediaQuery.ts";
import { useWorktreeBranches } from "../lib/useWorktreeBranches.ts";
import { worktreeLabel } from "../lib/worktreeName.ts";
import { browseEntries, folderQuery, folderQueryFor, homeRelative, matchFolders, pinnedFolders, requestFilesFolder } from "../lib/paletteFolders.ts";
import { currentSidebarPins, subscribeSidebarPins } from "../lib/sidebarPins.ts";
import { recentDirectories } from "../lib/recent-directories.ts";

import { availableTarget, groupMachinePanes, loadRecentTargets, rankMachinePanes, recentTargets, rememberTarget, targetKey, RECENT_KEY, type MachineBranches, type MachinePane, type RecentPane } from "../lib/machinePalette.ts";
import { worktreeWorkspaceSignature, type WorkspaceBranch } from "../lib/worktreeBranches.ts";
const RECENT_SHOWN = 3;
/** pinned and recent folders offered as jumps, each */
const FOLDERS_SHOWN = 5;

interface CommandPaletteProps {
  open: boolean;
  /** the search text it opens with; blank from the shortcut */
  initialQuery?: string;
  onClose: () => void;
  machines: readonly Machine[];
  onSelect(machineId: string, paneId: string): void;
  snapshot: SessionSnapshot | null;
  online: boolean;
  selectedPaneId: string | null;
  view: PaneView;
  actions: AppActions;
  /** this device may only watch: the PCs refuse it their checkouts, so no branch is read (#2250) */
  watching?: boolean;
}

interface PaletteAction {
  id: string;
  label: string;
  icon: ComponentType;
  shortcut?: ShortcutId;
  /** a second line under the label: the Settings page a group of it is on */
  detail?: string;
  /** the palette stays open after it: it changes the palette's own list */
  keepOpen?: boolean;
  run: () => void;
}

interface PaneRow extends MachinePane { kind: "pane" }
interface ActionRow { kind: "action"; action: PaletteAction }
interface PluginRow { kind: "plugin"; offered: OfferedPluginAction }
/** a folder of the selected PC: picking it lists it in the palette */
interface FolderRow { kind: "folder"; id: string; label: string; path: string; detail: string | null; icon: ComponentType }
type PaletteRow = PaneRow | ActionRow | PluginRow | FolderRow;

/** what went wrong listing a folder, said in the empty list */
type BrowseError = "invalid" | "failed";
interface FolderBrowse { directory: string; listing: DirectoryListing | null; error: BrowseError | null }

interface PaletteSectionView {
  id: string;
  heading: string;
  machineName?: string;
  workspaceId?: string;
  machineId?: string;
  branch: string | null;
  placeNamesWorkspace: boolean;
  rows: PaletteRow[];
}

/**
 * The picked row, by what it is (its section and its pane or action) and by where it stood. A
 * roster change that moves the row (a pane before it left the filter) carries the pick with it
 * and tells its place again; one that takes the row away leaves the pick on the row now at its
 * place, among the rows that stayed, so the keyboard loses nothing.
 */
interface PaletteSelection {
  key: string | null;
  index: number;
}

const NO_SELECTION: PaletteSelection = { key: null, index: 0 };

/** `<plugin_id>.<action_id>`: the row's identity, and the name of the run under way. */
function pluginActionKey({ plugin, action }: OfferedPluginAction): string {
  return `${plugin.plugin_id}.${action.action_id}`;
}

function rowKey(sectionId: string, row: PaletteRow): string {
  return `${sectionId}:${row.kind === "pane" ? targetKey(row) : row.kind === "action" ? row.action.id : row.kind === "folder" ? row.id : pluginActionKey(row.offered)}`;
}

function lastSegment(path: string): string {
  return path.replace(/[\\/]+$/u, "").split(/[\\/]/u).pop() || path;
}

function childPath(parent: string, name: string): string {
  return parent.endsWith("/") ? `${parent}${name}` : `${parent}/${name}`;
}

function storeRecent(recent: RecentPane[]): RecentPane[] {
  try { window.localStorage.setItem(RECENT_KEY, JSON.stringify(recent)); } catch { /* private mode: keep this page's history */ }
  return recent;
}

interface BranchInventory { signature: string; branches: ReadonlyMap<string, WorkspaceBranch> }
/** One owner-bound hook per PC. Closed/offline palettes never poll inventories. */
function PaletteBranchReader({ machine, onChange }: { machine: Machine; onChange(machineId: string, inventory: BranchInventory): void }) {
  const { branches } = useWorktreeBranches(machine.snapshot, machine.state === "connected");
  const signature = worktreeWorkspaceSignature(machine.snapshot?.workspaces ?? []);
  useEffect(() => { onChange(machine.id, { signature, branches }); }, [machine.id, signature, branches, onChange]);
  return null;
}

function panePath(pane: HerdrPane): string {
  return pane.foreground_cwd ?? pane.cwd ?? "";
}

/** A linked worktree's branch, when the workspace's name does not already say it (as the sidebar shows it). */
function branchBeside(label: string, branch: string | null | undefined): string | null {
  if (!branch || branch === label || worktreeLabel(branch) === label) return null;
  return branch;
}

function ShortcutHint({ shortcutId }: { shortcutId?: ShortcutId }) {
  const { settings } = useSettings();
  if (!shortcutId) return null;
  const keys = formatKeys(shortcutDisplayKeys(shortcutId, settings.shortcutOverrides));
  if (keys.length === 0) return null;
  return <span className="palette-shortcut" aria-label={keys.join(" + ")}>{keys.map((key) => <kbd className="kbd" key={key}>{key}</kbd>)}</span>;
}

export function CommandPalette({ open, initialQuery = "", onClose, machines, onSelect, snapshot, online, selectedPaneId, view, actions, watching = false }: CommandPaletteProps) {
  const t = useT();
  const { settings } = useSettings();
  const firstLines = useSyncExternalStore(subscribeTabLabels, shownTabLabels, shownTabLabels);
  const machineId = useMachineId();
  const api = useMachineApi();
  const touch = useMediaQuery("(pointer: coarse)");
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<PaletteStatusFilter>("all");
  const [selection, setSelection] = useState<PaletteSelection>(NO_SELECTION);
  const [plugins, setPlugins] = useState<PluginActions[]>([]);
  /** `<plugin_id>.<action_id>` of the plugin action under way; the palette stays open until it answers */
  const [running, setRunning] = useState<string | null>(null);
  const [pluginError, setPluginError] = useState<string | null>(null);
  /** one claim per opening: an answer that arrives after the palette closed, or left for another PC, belongs to no one */
  const owner = useRef<Ownership | null>(null);
  owner.current ??= new Ownership();
  const loadRecent = () => loadRecentTargets((key) => window.localStorage.getItem(key), [machineId, ...machines.map((machine) => machine.id).filter((id) => id !== machineId)]);
  const [recentPaneIds, setRecentPaneIds] = useState<RecentPane[]>(loadRecent);
  // folder browsing (a query that starts as a path does): the folder listed, the PC's home once
  // one listing told it, the PC's recent folders and the folders of the pinned agents
  const [browse, setBrowse] = useState<FolderBrowse>({ directory: "", listing: null, error: null });
  const [home, setHome] = useState<string | null>(null);
  const [recentFolders, setRecentFolders] = useState<string[]>([]);
  const pins = useSyncExternalStore(subscribeSidebarPins, currentSidebarPins);
  const inputRef = useRef<HTMLInputElement>(null);
  // a pane picked here is where the keyboard goes: giving it back to the opener (a sibling pane
  // still mounted in the split) would select that pane again (PaneCanvas onFocusCapture)
  const navigated = useRef(false);
  useLayoutEffect(() => { if (open) navigated.current = false; }, [open]);
  const surface = useFocusTrap<HTMLElement>(open, { initialFocus: inputRef, shouldRestore: () => !navigated.current });
  // a plugin action under way keeps the palette open for its answer: no drag closes it meanwhile
  useSheetSwipe(surface, running !== null ? null : onClose);
  usePhoneSheetBack(() => { if (running !== null) return false; onClose(); }, open);
  const resultsRef = useRef<HTMLDivElement>(null);
  // a filter letter pressed over the list keeps the keyboard in the list: the first row takes the
  // focus once the filter is drawn, also when the letter named the filter already shown
  const [rowFocusRequest, setRowFocusRequest] = useState(0);
  // the row the focus is on, told from one the focus left, for a roster change that takes it out of the list
  const focusedRow = useRef<HTMLElement | null>(null);
  // the rows as the last roster listed them: where a row that left stood among the rows that stayed
  const previousRowKeys = useRef<readonly string[]>([]);
  const [inventories, setInventories] = useState<ReadonlyMap<string, BranchInventory>>(new Map());
  const onInventory = useCallback((id: string, inventory: BranchInventory): void => {
    setInventories((previous) => {
      const before = previous.get(id);
      if (before?.signature === inventory.signature && JSON.stringify([...before.branches]) === JSON.stringify([...inventory.branches])) return previous;
      return new Map(previous).set(id, inventory);
    });
  }, []);
  // the palette stays mounted while closed: what it read while driving is dropped when the device turns to watching
  useEffect(() => { if (watching) setInventories((previous) => previous.size === 0 ? previous : new Map()); }, [watching]);
  const branches = useMemo<MachineBranches>(() => watching ? new Map() : new Map(machines.flatMap((machine) => {
    const inventory = inventories.get(machine.id);
    return inventory?.signature === worktreeWorkspaceSignature(machine.snapshot?.workspaces ?? []) ? [[machine.id, inventory.branches] as const] : [];
  })), [inventories, machines, watching]);

  // Terminal attachment can move focus after the palette opens. Escape belongs to
  // this modal even then, and must not leak through to the underlying terminal.
  useLayoutEffect(() => {
    if (!open) return;
    const dismiss = (event: KeyboardEvent): void => {
      if (event.key !== "Escape" || event.isComposing || event.keyCode === 229) return;
      event.preventDefault();
      event.stopPropagation();
      onClose();
    };
    window.addEventListener("keydown", dismiss, true);
    return () => window.removeEventListener("keydown", dismiss, true);
  }, [open, onClose]);

  // In the opening commit: a passive effect leaves a render of the last search's results until a later
  // task, where a quick Tab focuses a row at an index the full list then gives to another row (#608).
  useLayoutEffect(() => {
    if (!open) return;
    setQuery(initialQuery);
    setFilter("all");
    setSelection(NO_SELECTION);
    focusedRow.current = null;
    requestSettingsPage(null);
    setRecentPaneIds(loadRecent());
    setRecentFolders(recentDirectories.read(machineId));
  }, [open]);

  // The folder a path-like query names, read from the selected PC as the query crosses a `/`: the
  // last segment only filters what is listed. A dot starting it asks for the hidden folders too.
  const folder = open ? folderQuery(query) : null;
  const folderDirectory = folder?.directory ?? null;
  const folderHidden = folder?.filter.startsWith(".") ?? false;
  // Try again after a failed listing asks for the same folder once more
  const [browseAttempt, setBrowseAttempt] = useState(0);
  useEffect(() => {
    if (folderDirectory === null || !online) return;
    let alive = true;
    setBrowse((current) => current.directory === folderDirectory ? { ...current, error: null } : { directory: folderDirectory, listing: null, error: null });
    api.fetchDirectories(folderDirectory, folderHidden).then(
      (listing) => {
        if (!alive) return;
        setHome(listing.home);
        setBrowse({ directory: folderDirectory, listing, error: null });
      },
      (reason: unknown) => {
        if (alive) setBrowse({ directory: folderDirectory, listing: null, error: reason instanceof ApiError && reason.code === "invalid_cwd" ? "invalid" : "failed" });
      },
    );
    return () => { alive = false; };
  }, [folderDirectory, folderHidden, online, api, browseAttempt]);
  const browseTo = useCallback((path: string): void => {
    setQuery(folderQueryFor(path, home));
    setSelection(NO_SELECTION);
    inputRef.current?.focus();
  }, [home]);

  // The PC's plugin actions, read on each opening. A herdr with no plugins, an older bridge
  // without the route and an unreachable herdr all leave the group out. A layout effect: the
  // rows of the last opening are drawn again at once, and a tap on one must find this opening's
  // state, not a run left over from the last one nor a claim this effect is about to end.
  useLayoutEffect(() => {
    const claims = owner.current!;
    claims.end();
    setRunning(null);
    setPluginError(null);
    if (!open || !online) { setPlugins([]); return; }
    const alive = claims.claim();
    void api.fetchPluginActions().then(
      (list) => { if (alive()) setPlugins(list); },
      () => { if (alive()) setPlugins([]); },
    );
    // also on unmount: App keys the palette by PC, and the answer of the PC left behind must
    // not select its pane ID on the PC now shown, nor close that PC's palette
    return () => claims.end();
  }, [open, online, api]);

  const recentMachineIds = JSON.stringify(machines.map((machine) => machine.id));
  const selectedAvailable = selectedPaneId !== null && availableTarget(machines, { machineId, paneId: selectedPaneId }) !== null;
  useEffect(() => {
    if (selectedPaneId === null || !selectedAvailable) return;
    // The first render may precede the roster. Load legacy histories once their PC IDs are known,
    // before creating a global record that would otherwise mask their migration.
    setRecentPaneIds(storeRecent(rememberTarget({ machineId, paneId: selectedPaneId }, loadRecent())));
  }, [selectedPaneId, machineId, recentMachineIds, selectedAvailable]);

  // the selected pane's tab, for herdr's layout actions: a zoom means something only among several panes
  const selectedTab = snapshot?.panes.find((pane) => pane.pane_id === selectedPaneId)?.tab_id ?? null;
  const tabPanes = selectedTab === null ? 0 : (snapshot?.panes.filter((pane) => pane.tab_id === selectedTab).length ?? 0);
  const tabLayout = selectedTab === null ? undefined : snapshot?.layouts?.find((layout) => layout.tab_id === selectedTab);
  // the mode the zoom item names, never a toggle (lib/layoutMap.ts): herdr focuses the pane and
  // then sets the tab's flag, so a toggle on a pane other than the one shown alone would unzoom the tab
  const zoom = tabLayout !== undefined && selectedPaneId !== null ? zoomMode(tabLayout, selectedPaneId) : null;
  // a tab's name and workspace change only where the PC's herdr answers it (lib/machineContext.tsx); App
  // already gives no split or zoom where it does not (lib/layoutActions.ts)
  const { rename: renameOffered, move: moveOffered } = useAppLayout();
  const splitPane = actions.splitPane;
  const zoomPane = actions.zoomPane;
  // browsing starts in the selected pane's folder, home without one
  const selectedPane = snapshot?.panes.find((pane) => pane.pane_id === selectedPaneId);
  const browseStart = selectedPane && panePath(selectedPane) ? panePath(selectedPane) : null;
  // Rename tab opens the tab strip's name field, or, where the strip is left out (a lone tab on a
  // cramped screen), the dialog that stands in for it (PaneCanvas)
  const tabShown = selectedPane !== undefined;

  const paletteActions = useMemo<PaletteAction[]>(() => [
    { id: "new", label: t("New workspace"), icon: MessageSquarePlus, shortcut: "new-session", run: actions.openNewSession },
    // in the selected pane's workspace: nothing to add a tab to without one
    ...(selectedPaneId !== null ? [{ id: "new-tab", label: t("New tab"), icon: Plus, shortcut: "new-tab", run: () => actions.openNewTab() }] satisfies PaletteAction[] : []),
    ...(selectedPaneId !== null && tabShown && renameOffered ? [{ id: "rename-tab", label: t("Rename tab"), icon: Pencil, shortcut: "rename-tab", run: actions.renameTab }] satisfies PaletteAction[] : []),
    // herdr's prefix+v and prefix+-: the new pane is opened here only when asked, as herdr's --focus
    ...(splitPane ? [
      { id: "split-right", label: t("Split pane right"), icon: Columns2, shortcut: "split-right", run: () => splitPane("right") },
      { id: "split-down", label: t("Split pane down"), icon: Rows2, shortcut: "split-down", run: () => splitPane("down") },
      { id: "split-right-open", label: t("Split pane right and open it"), icon: Columns2, run: () => splitPane("right", true) },
      { id: "split-down-open", label: t("Split pane down and open it"), icon: Rows2, run: () => splitPane("down", true) },
    ] satisfies PaletteAction[] : []),
    ...(zoomPane && zoom && tabPanes > 1 ? [{ id: "zoom", label: t(zoom === "off" ? "Unzoom pane" : "Zoom pane"), icon: zoom === "off" ? Minimize2 : Maximize2, run: () => zoomPane(zoom) }] : []),
    { id: "view", label: t(view === "chat" ? "Switch to terminal" : "Switch to chat"), icon: SwitchCamera, shortcut: "toggle-view", run: actions.toggleView },
    { id: "sidebar", label: t("Toggle sidebar"), icon: PanelLeft, shortcut: "toggle-sidebar", run: actions.toggleSidebar },
    // the sidebar's Filter field, also where Settings → Appearance → Sidebar filter leaves it out
    { id: "filter-sidebar", label: t("Filter workspaces and agents"), icon: ListFilter, run: actions.openSidebarFilter },
    { id: "theme", label: t("Toggle theme"), icon: SunMoon, run: actions.toggleTheme },
    { id: "settings", label: t("Settings"), icon: Settings, shortcut: "settings", run: actions.openSettings },
    { id: "add-pc", label: t("Add PC"), icon: Monitor, run: actions.openAddPc },
    ...(actions.enableNotifications ? [{ id: "notifications", label: t("Enable notifications"), icon: Bell, run: actions.enableNotifications }] : []),
    ...(actions.openFiles ? [{ id: "files", label: t("Browse files"), icon: FolderOpen, run: actions.openFiles }] : []),
    ...(online ? [{ id: "browse-folders", label: t("Browse folders"), icon: FolderSearch, keepOpen: true, run: () => browseTo(browseStart ?? home ?? "~") }] : []),
    { id: "refresh", label: t("Refresh"), icon: RefreshCw, run: actions.refresh },
  ], [actions, splitPane, zoomPane, tabPanes, zoom, view, t, selectedPaneId, tabShown, renameOffered, online, browseTo, browseStart, home]);

  // Settings pages and groups are found by a query only, and open on the page itself, a group's
  // scrolled to and focused: the dialog reads the request as it mounts
  const settingsActions = useMemo(() => {
    const icons = new Map(PAGES.map(({ id, icon }) => [id, icon]));
    const entries = settingsPageEntries(t);
    const pageLabel = new Map(entries.filter((entry) => entry.section === undefined).map((entry) => [entry.id, entry.label]));
    return entries.map(({ id, section, label, aliases }) => ({ action: {
      id: section === undefined ? `settings-${id}` : `settings-${id}-${section}`,
      label,
      detail: section === undefined ? undefined : pageLabel.get(id),
      icon: icons.get(id) ?? Settings,
      run: () => { requestSettingsPage({ page: id, section }); actions.openSettings(); },
    } satisfies PaletteAction, aliases }));
  }, [actions, t]);
  const aliasesByAction = useMemo(() => actionAliases(t), [t]);
  // the selected one-pane tab to another workspace of its PC, one row each, found by a query only as Settings pages are
  const selectedWorkspace = selectedPane?.workspace_id ?? null;
  const moveActions = useMemo<PaletteAction[]>(() => selectedTab === null || tabPanes !== 1 || !moveOffered ? [] : (snapshot?.workspaces ?? [])
    .filter((entry) => entry.workspace_id !== selectedWorkspace)
    .map((entry) => ({ id: `move-tab-${entry.workspace_id}`, label: t("Move tab to {workspace}", { workspace: entry.label }), icon: FolderInput,
      // a refusal is said over the pane (App): the palette has closed by then
      run: () => { void actions.moveTabToWorkspace({ machineId, tabId: selectedTab, workspaceId: entry.workspace_id, notice: true }).catch(() => undefined); } })),
  [actions, moveOffered, machineId, selectedTab, selectedWorkspace, snapshot?.workspaces, t, tabPanes]);

  const allPanes = useMemo(() => machines.flatMap((machine) => machine.state === "connected" ? machine.snapshot?.panes ?? [] : []), [machines]);
  const multiMachine = machines.length > 1;
  const selectedMachineName = machines.find((machine) => machine.id === machineId)?.name;
  const counts = useMemo(() => statusCounts(allPanes), [allPanes]);
  const { actionsOnly, text } = parseQuery(query);

  // herdr's Goto picker: a row per pane under its workspace; `>` keeps the actions alone (T3 Code's
  // palette); a status filter is about panes, so it leaves the actions out, the plugins' with them;
  // the panes went to last lead an unsearched, unfiltered list
  const sections = useMemo<PaletteSectionView[]>(() => {
    const list: PaletteSectionView[] = [];
    // a path lists the selected PC's folders (T3 Code's browse mode): where it is, with Open in
    // Files and the way up, then the pinned and recent folders it leads to, then its folders
    if (folder !== null) {
      const listing = browse.directory === folder.directory ? browse.listing : null;
      const machineName = multiMachine ? selectedMachineName : undefined;
      const jump = (path: string, prefix: string, icon: ComponentType): FolderRow => ({ kind: "folder", id: `${prefix}:${path}`, label: lastSegment(path), path, detail: home === null ? path : homeRelative(path, home), icon });
      if (listing && folder.filter === "") {
        const { openFiles } = actions;
        const here: PaletteRow[] = [
          ...(openFiles ? [{ kind: "action" as const, action: { id: "open-folder", label: t("Open in Files"), icon: FolderOpen, run: () => { requestFilesFolder(listing.path); openFiles(); } } }] : []),
          ...(listing.parent !== null ? [{ kind: "folder" as const, id: "up", label: "..", path: listing.parent, detail: null, icon: CornerLeftUp }] : []),
        ];
        if (here.length > 0) list.push({ id: "folder-here", heading: folderQueryFor(listing.path, listing.home), machineName, branch: null, placeNamesWorkspace: false, rows: here });
      }
      const pinned = pinnedFolders(pins, machineId, snapshot?.panes ?? []);
      const pinnedRows = matchFolders(pinned, query, home, FOLDERS_SHOWN).map((path) => jump(path, "pin", Pin));
      if (pinnedRows.length > 0) list.push({ id: "pinned-folders", heading: t("Pinned folders"), machineName, branch: null, placeNamesWorkspace: false, rows: pinnedRows });
      const recentRows = matchFolders(recentFolders.filter((path) => !pinned.includes(path)), query, home, FOLDERS_SHOWN).map((path) => jump(path, "recent", History));
      if (recentRows.length > 0) list.push({ id: "recent-folders", heading: t("Recent folders"), machineName, branch: null, placeNamesWorkspace: false, rows: recentRows });
      const names = listing ? browseEntries(listing.directories, folder.filter) : [];
      if (listing && names.length > 0) list.push({ id: "folder-list", heading: t("Folders"), machineName, branch: null, placeNamesWorkspace: false, rows: names.map((name) => ({ kind: "folder", id: `dir:${name}`, label: name, path: childPath(listing.path, name), detail: null, icon: Folder })) });
      return list;
    }
    if (!actionsOnly) {
      const panes = rankMachinePanes(text, machines, filter, branches, t);
      if (text === "" && filter === "all") {
        const recent = recentTargets(panes, recentPaneIds, selectedPaneId === null ? null : { machineId, paneId: selectedPaneId }, RECENT_SHOWN);
        if (recent.length > 0) list.push({ id: "recent", heading: t("Recent"), branch: null, placeNamesWorkspace: true, rows: recent.map((entry) => ({ kind: "pane", ...entry })) });
      }
      for (const group of groupMachinePanes(panes, machines, text !== "")) {
        const heading = group.workspace?.label ?? t("Unknown workspace");
        list.push({ id: group.id, workspaceId: group.workspaceId, machineId: group.machine.id, machineName: multiMachine ? group.machine.name : undefined, heading, branch: branchBeside(heading, branches.get(group.machine.id)?.get(group.workspaceId)?.branch), placeNamesWorkspace: false, rows: group.panes.map((entry) => ({ kind: "pane", ...entry })) });
      }
    }
    if (actionsOnly || filter === "all") {
      // a name found only through an alias comes after the titles that hold the query
      const visible = rankByTitle(text, [...paletteActions, ...(text === "" ? [] : moveActions)].map((action) => ({ item: action, title: action.label, aliases: aliasesByAction[action.id] })));
      if (visible.length > 0) list.push({ id: "actions", heading: t("Actions"), machineName: multiMachine ? selectedMachineName : undefined, branch: null, placeNamesWorkspace: false, rows: visible.map((action) => ({ kind: "action", action })) });
      const pages = text === "" ? [] : rankByTitle(text, settingsActions.map(({ action, aliases }) => ({ item: action, title: action.label, aliases })));
      if (pages.length > 0) list.push({ id: "settings-pages", heading: t("Settings"), machineName: multiMachine ? selectedMachineName : undefined, branch: null, placeNamesWorkspace: false, rows: pages.map((action) => ({ kind: "action", action })) });
      const offered = offeredPluginActions(plugins, selectedPaneId !== null, text);
      if (offered.length > 0) list.push({ id: "plugins", heading: t("Plugin actions"), machineName: multiMachine ? selectedMachineName : undefined, branch: null, placeNamesWorkspace: false, rows: offered.map((item) => ({ kind: "plugin", offered: item })) });
    }
    return list;
  }, [actionsOnly, text, filter, machines, multiMachine, selectedMachineName, machineId, branches, recentPaneIds, selectedPaneId, paletteActions, moveActions, aliasesByAction, settingsActions, plugins, t, folder?.directory, folder?.filter, query, browse, home, pins, recentFolders, snapshot, actions]);

  const rows = useMemo(() => sections.flatMap((section) => section.rows), [sections]);
  const rowKeys = useMemo(() => sections.flatMap((section) => section.rows.map((row) => rowKey(section.id, row))), [sections]);
  const sectionStarts = useMemo(() => {
    const starts: number[] = [];
    let index = 0;
    for (const section of sections) { starts.push(index); index += section.rows.length; }
    return starts;
  }, [sections]);
  const itemCount = rows.length;
  // the picked row where it stands now, else the row at the pick's place (the last one when the list shrank under it)
  const pickedAt = selection.key === null ? -1 : rowKeys.indexOf(selection.key);
  const activeIndex = pickedAt >= 0 ? pickedAt : Math.min(selection.index, Math.max(0, itemCount - 1));

  // Arrow navigation keeps focus in the search field: aria-activedescendant alone does not
  // scroll its option into view, including when an arrow wraps to the other end of the list.
  // Rows take hover from mousemove, not mouseenter: a scroll under a resting pointer sends the
  // row now under it a mouseenter, which would replace the option the arrow picked.
  useLayoutEffect(() => {
    if (!open) return;
    resultsRef.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
  }, [open, activeIndex, query, itemCount]);

  // The first row's focus event tells the pick only when the focus moves: a letter pressed on the
  // first row itself fires none, and a pick left on no row would go by its place to a pane that
  // enters before that row while the keyboard stays on it. So the pick is told here.
  useLayoutEffect(() => {
    if (!open || rowFocusRequest === 0) return;
    const first = document.getElementById("palette-item-0");
    if (!first) {
      inputRef.current?.focus();
      return;
    }
    const key = rowKeys[0] ?? null;
    setSelection((current) => (current.key === key && current.index === 0 ? current : { key, index: 0 }));
    first.focus();
  }, [rowFocusRequest]);

  // The roster changed under the pick. A picked row that stayed tells its place again; one that
  // left hands the pick to the row now at its place, counted over the rows before it that stayed
  // (its old place would be one row too low once a row before it had left earlier, or left with
  // it). A row that leaves the list while the focus is on it (its pane's status changed under a
  // filter) would leave the focus on the page body, where no palette key reaches: the row at the
  // pick's place takes it, the search when none is left. A row that stays keeps its element, and
  // with it the focus, by its key.
  useLayoutEffect(() => {
    const before = previousRowKeys.current;
    previousRowKeys.current = rowKeys;
    if (!open) return;
    let index = activeIndex;
    if (selection.key !== null) {
      const wasAt = pickedAt < 0 ? before.indexOf(selection.key) : -1;
      if (wasAt >= 0) {
        const stayed = new Set(rowKeys);
        index = Math.min(before.slice(0, wasAt).filter((key) => stayed.has(key)).length, Math.max(0, itemCount - 1));
      }
      const key = rowKeys[index] ?? null;
      if (key !== selection.key || index !== selection.index) setSelection({ key, index });
    }
    const row = focusedRow.current;
    if (!row || row.isConnected) return;
    focusedRow.current = null;
    (document.getElementById(`palette-item-${index}`) ?? inputRef.current)?.focus();
  }, [rowKeys]);

  if (!open) return null;

  const select = (index: number): void => {
    const key = rowKeys[index] ?? null;
    setSelection((current) => (current.key === key && current.index === index ? current : { key, index }));
  };
  const runPane = (target: MachinePane): void => {
    if (!availableTarget(machines, target)) return;
    setRecentPaneIds((current) => storeRecent(rememberTarget({ machineId: target.machineId, paneId: target.paneId }, current)));
    navigated.current = true;
    onSelect(target.machineId, target.paneId);
    onClose();
  };
  const runAction = (action: PaletteAction): void => {
    action.run();
    if (!action.keepOpen) onClose();
  };
  const runPluginAction = async ({ plugin, action }: OfferedPluginAction): Promise<void> => {
    if (running !== null) return;
    const alive = owner.current!.claim();
    setRunning(pluginActionKey({ plugin, action }));
    setPluginError(null);
    try {
      // stays Running… past the server's own wait: a command that fails late is still said
      const result = await runPluginActionToEnd(api, { plugin_id: plugin.plugin_id, action_id: action.action_id, ...(selectedPaneId === null ? {} : { pane_id: selectedPaneId }) }, alive);
      if (result === null) return;
      if (result.status === "failed") {
        setPluginError(result.output !== null
          ? t("{action} failed: {detail}", { action: action.title, detail: result.output })
          : t("{action} failed (exit code {code})", { action: action.title, code: result.exit_code ?? "?" }));
        return;
      }
      if (result.opened_pane_id !== null) {
        // the pane may be newer than the snapshot on screen
        actions.refresh();
        navigated.current = true;
        actions.selectPane(result.opened_pane_id);
      }
      onClose();
    } catch (error) {
      if (!alive()) return;
      setPluginError(t("{action} failed: {detail}", { action: action.title, detail: error instanceof ApiError ? error.detail : error instanceof Error ? error.message : String(error) }));
    } finally {
      if (alive()) setRunning(null);
    }
  };
  const activate = (index: number): void => {
    const row = rows[index];
    if (!row) return;
    if (row.kind === "pane") runPane(row);
    else if (row.kind === "action") runAction(row.action);
    else if (row.kind === "folder") browseTo(row.path);
    else void runPluginAction(row.offered);
  };
  const adjacentSectionStart = (index: number, direction: -1 | 1): number => {
    let current = 0;
    for (let section = 0; section < sectionStarts.length; section += 1) if (sectionStarts[section]! <= index) current = section;
    return sectionStarts[(current + direction + sectionStarts.length) % sectionStarts.length] ?? 0;
  };
  const applyFilter = (next: PaletteStatusFilter): void => {
    setFilter(next);
    setSelection(NO_SELECTION);
  };
  const onInputKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>): void => {
    // Candidate navigation and the committing Enter belong to the IME. WebKit can report
    // the latter after compositionend with isComposing false and key code 229.
    if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
    if (event.key === "ArrowDown" && itemCount > 0) {
      event.preventDefault();
      select((activeIndex + 1) % itemCount);
    } else if (event.key === "ArrowUp" && itemCount > 0) {
      event.preventDefault();
      select((activeIndex - 1 + itemCount) % itemCount);
    } else if ((event.key === "ArrowLeft" || event.key === "ArrowRight") && sectionStarts.length > 1) {
      // a caret inside the text keeps its own Left and Right; at the text's edge they walk the sections
      const input = event.currentTarget;
      const collapsed = input.selectionStart === input.selectionEnd;
      const atEdge = event.key === "ArrowLeft" ? input.selectionStart === 0 : input.selectionEnd === input.value.length;
      if (!collapsed || !atEdge) return;
      event.preventDefault();
      select(adjacentSectionStart(activeIndex, event.key === "ArrowLeft" ? -1 : 1));
    } else if (event.key === "Enter" && itemCount > 0) {
      event.preventDefault();
      activate(activeIndex);
    }
  };
  // herdr's picker keys, over the list and the chips but never in the search field: b, w, i, d and a
  // set the filter, `/` goes back to the search; arrows walk the rows and the sections by focus
  const onSurfaceKeyDown = (event: ReactKeyboardEvent<HTMLElement>): void => {
    const target = event.target as HTMLElement;
    if (event.defaultPrevented || target === inputRef.current || event.ctrlKey || event.metaKey || event.altKey) return;
    const filterKey = FILTER_KEYS[event.key];
    if (filterKey) {
      event.preventDefault();
      applyFilter(filterKey);
      setRowFocusRequest((count) => count + 1);
      return;
    }
    if (event.key === "/") {
      event.preventDefault();
      inputRef.current?.focus();
      return;
    }
    const row = target.closest<HTMLElement>("[role=\"option\"]");
    if (!row || itemCount === 0) return;
    const index = Number(row.id.slice("palette-item-".length));
    const next = event.key === "ArrowDown" ? (index + 1) % itemCount
      : event.key === "ArrowUp" ? (index - 1 + itemCount) % itemCount
      : event.key === "ArrowRight" ? adjacentSectionStart(index, 1)
      : event.key === "ArrowLeft" ? adjacentSectionStart(index, -1)
      : null;
    if (next === null) return;
    event.preventDefault();
    document.getElementById(`palette-item-${next}`)?.focus();
  };
  const onChipsKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const at = STATUS_FILTERS.indexOf(filter);
    const next = STATUS_FILTERS[(at + (event.key === "ArrowRight" ? 1 : -1) + STATUS_FILTERS.length) % STATUS_FILTERS.length]!;
    applyFilter(next);
    event.currentTarget.querySelector<HTMLElement>(`[data-status="${next}"]`)?.focus();
  };
  const onChipClick = (event: ReactMouseEvent<HTMLButtonElement>, next: PaletteStatusFilter): void => {
    applyFilter(next);
    // a mouse goes back to typing; a finger would open the keyboard
    if (event.detail > 0 && !touch) inputRef.current?.focus();
  };

  // a tab is named as the tab strip names it: by its given name, else "Tab n" by its place. A row's
  // subtitle says it only where it tells panes apart (as the sidebar's agent rows do); the footer's
  // location always says it
  const tabOf = ({ pane, machine }: MachinePane): { tab: TabInfo | undefined; place: number; all: TabInfo[] } => {
    const all = (machine.snapshot?.tabs ?? []).filter((tab) => tab.workspace_id === pane.workspace_id);
    const tab = all.find((item) => item.tab_id === pane.tab_id);
    return { tab, place: tab ? all.indexOf(tab) + 1 : 0, all };
  };
  const tabName = (row: MachinePane): string | null => {
    const { tab, all } = tabOf(row);
    return agentTabName(tab, all, t);
  };
  // the footer names a tab as the strip draws it, a label from its first message included (lib/tabName.ts)
  const placeTabName = ({ machine }: MachinePane, tab: TabInfo, place: number): string => (settings.autoTabNames
    ? autoTabLabel(tab, machine.snapshot?.panes.filter((pane) => pane.tab_id === tab.tab_id) ?? [], machine.id, firstLines, place) : null)
    ?? tabLabel(tab, t, place);
  const activeRow = rows[activeIndex];
  const activeWorkspace = activeRow?.kind === "pane" ? activeRow.machine.snapshot?.workspaces.find((workspace) => workspace.workspace_id === activeRow.pane.workspace_id) : undefined;
  const activeTab = activeRow?.kind === "pane" ? tabOf(activeRow) : undefined;
  const footerPlace = activeRow?.kind === "pane"
    ? [multiMachine ? activeRow.machine.name : null, activeWorkspace?.label ?? t("Unknown workspace"), activeTab?.tab ? placeTabName(activeRow, activeTab.tab, activeTab.place) : null].filter(Boolean).join(" › ")
    : activeRow?.kind === "action" ? activeRow.action.label
    : activeRow?.kind === "folder" ? activeRow.label
    : activeRow?.offered.action.title ?? "";
  const footerPath = activeRow?.kind === "pane" ? panePath(activeRow.pane) : activeRow?.kind === "folder" ? activeRow.path : "";
  const browseListing = folder !== null && browse.directory === folder.directory ? browse : null;
  const listingFailed = online && browseListing?.error === "failed";
  const emptyText = folder === null ? t("No matching panes or actions")
    : browseListing?.error === "invalid" ? t("This folder cannot be opened.")
    : browseListing?.error === "failed" || !online ? t("Folders could not be loaded.")
    : browseListing?.listing ? t("No matching folders") : t("Loading…");

  const onSurfaceFocus = (event: ReactFocusEvent<HTMLElement>): void => {
    focusedRow.current = (event.target as HTMLElement).closest<HTMLElement>("[role=\"option\"]");
  };

  let rowIndex = 0;
  return (
    <div className="modal-scrim palette-scrim" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      {!watching && machines.filter((machine) => machine.state === "connected").map((machine) => <MachineContext.Provider key={machine.id} value={machine.id}><PaletteBranchReader machine={machine} onChange={onInventory} /></MachineContext.Provider>)}
      <section ref={surface} className="menu command-palette" role="dialog" aria-modal="true" aria-label={t("Command palette")} onKeyDown={onSurfaceKeyDown} onFocus={onSurfaceFocus}>
        <div className="palette-search">
          <input ref={inputRef} className="input" type="search" value={query} placeholder={t("Search panes and actions…")} aria-label={t("Search panes and actions")} aria-controls="palette-results" aria-activedescendant={itemCount ? `palette-item-${activeIndex}` : undefined} onKeyDown={onInputKeyDown} onChange={(event) => { setQuery(event.target.value); setSelection(NO_SELECTION); }} />
          <button type="button" className="icon-button" aria-label={t("Close command palette")} onClick={onClose}><X /></button>
        </div>
        {!actionsOnly && folder === null && (
          <div className="palette-filters" role="radiogroup" aria-label={t("Filter panes by status")} onKeyDown={onChipsKeyDown}>
            {STATUS_FILTERS.map((status) => (
              <button key={status} type="button" role="radio" className="palette-filter" data-status={status} aria-checked={filter === status} tabIndex={filter === status ? 0 : -1} data-empty={counts[status] === 0 || undefined} onClick={(event) => onChipClick(event, status)}>
                <span className="palette-filter-word">{status === "all" ? t("All") : t(STATUS_WORD[status])}</span>
                <span className="palette-filter-count">{counts[status]}</span>
              </button>
            ))}
          </div>
        )}
        {pluginError !== null && <p className="palette-error" role="alert">{pluginError}</p>}
        <div ref={resultsRef} className="palette-results" id="palette-results" role="listbox">
          {sections.map((section) => (
            <div key={section.id} className="palette-section" data-section={section.workspaceId ?? section.id} data-machine={section.machineId}>
              <div className="menu-heading palette-section-heading">
                {section.machineName && <span className="palette-section-machine">{section.machineName}</span>}
                <span className="palette-section-name">{section.heading}</span>
                {section.branch && <span className="palette-section-branch">{section.branch}</span>}
                <span className="palette-section-count">{section.rows.length}</span>
              </div>
              {section.rows.map((row) => {
                const index = rowIndex;
                rowIndex += 1;
                if (row.kind === "plugin") {
                  const { offered } = row;
                  const key = pluginActionKey(offered);
                  const busy = running === key;
                  return (
                    <button key={key} id={`palette-item-${index}`} type="button" role="option" className={busy ? "menu-item palette-plugin-action is-running" : "menu-item palette-plugin-action"} title={offered.action.description ?? undefined} aria-selected={activeIndex === index} aria-busy={busy} aria-disabled={running !== null} onFocus={() => select(index)} onMouseMove={() => select(index)} onClick={() => void runPluginAction(offered)}>
                      {busy ? <LoaderCircle aria-hidden="true" /> : <Puzzle aria-hidden="true" />}
                      <span className="menu-item-main"><span className="palette-row-title">{offered.action.title}</span><span className="palette-row-subtitle">{busy ? t("Running…") : offered.plugin.name}</span></span>
                    </button>
                  );
                }
                if (row.kind === "folder") {
                  const Icon = row.icon;
                  return (
                    <button key={row.id} id={`palette-item-${index}`} type="button" role="option" className="menu-item palette-folder" title={row.path} aria-selected={activeIndex === index} onFocus={() => select(index)} onMouseMove={() => select(index)} onClick={() => browseTo(row.path)}>
                      <Icon aria-hidden="true" />
                      <span className="menu-item-main"><span className="palette-row-title">{row.label}</span>{row.detail !== null && <span className="palette-row-subtitle">{row.detail}</span>}</span>
                    </button>
                  );
                }
                if (row.kind === "action") {
                  const Icon = row.action.icon;
                  return <button key={row.action.id} id={`palette-item-${index}`} type="button" role="option" className="menu-item" aria-selected={activeIndex === index} onFocus={() => select(index)} onMouseMove={() => select(index)} onClick={() => runAction(row.action)}><Icon />{row.action.detail === undefined ? <span className="menu-item-main">{row.action.label}</span> : <span className="menu-item-main"><span className="palette-row-title">{row.action.label}</span><span className="palette-row-subtitle">{row.action.detail}</span></span>}<ShortcutHint shortcutId={row.action.shortcut} /></button>;
                }
                const { pane } = row;
                const workspace = row.machine.snapshot?.workspaces.find((item) => item.workspace_id === pane.workspace_id);
                const folder = folderName(panePath(pane));
                const panePlace = section.placeNamesWorkspace
                  ? placeLine(workspace?.label ?? t("Unknown workspace"), folder)
                  : placeLine(tabName(row) ?? "", folder);
                const place = multiMachine && section.placeNamesWorkspace ? `${row.machine.name} › ${panePlace}` : panePlace;
                const selected = row.machineId === machineId && pane.pane_id === selectedPaneId;
                return (
                  <button key={targetKey(row)} data-machine={row.machineId} data-pane={pane.pane_id} id={`palette-item-${index}`} type="button" role="option" className="menu-item palette-pane" aria-selected={activeIndex === index} aria-current={selected ? "true" : undefined} onFocus={() => select(index)} onMouseMove={() => select(index)} onClick={() => runPane(row)}>
                    <span className="palette-mark"><AgentMark agent={pane.agent ?? "shell"} /></span>
                    <span className="menu-item-main"><span className="palette-row-title">{displayPaneTitle(pane)}{selected && <span className="palette-selected">{t("Selected")}</span>}</span><span className="palette-row-subtitle">{place}</span></span>
                    <StatusBadge status={paneStatus(pane)} />
                  </button>
                );
              })}
            </div>
          ))}
          {(itemCount === 0 || listingFailed) && <p className="palette-empty" role="status">{emptyText}</p>}
          {listingFailed && (
            <p className="palette-empty">
              <button type="button" className="btn" onClick={(event) => {
                setBrowseAttempt((attempt) => attempt + 1);
                // the button goes while the listing is asked again: a key or a mouse goes back to the search, a finger keeps its keyboard down
                if (event.detail === 0 || !touch) inputRef.current?.focus();
              }}>{t("Try again")}</button>
            </p>
          )}
        </div>
        <footer className="palette-footer">
          <div className="palette-footer-where" aria-live="polite">
            {footerPlace && <span className="palette-footer-place">{footerPlace}</span>}
            {footerPath && <span className="palette-footer-path" title={footerPath}>{footerPath}</span>}
          </div>
          <div className="palette-footer-keys" aria-hidden="true">
            <span className="palette-footer-key"><kbd className="kbd">←</kbd><kbd className="kbd">→</kbd>{t("Workspace")}</span>
            <span className="palette-footer-key"><kbd className="kbd">&gt;</kbd>{t("Actions")}</span>
          </div>
        </footer>
      </section>
    </div>
  );
}
