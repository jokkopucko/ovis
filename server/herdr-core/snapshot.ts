import type { AgentInfo, AgentSessionInfo, AgentStatus, PaneInfo, PaneLayoutSnapshot, PaneProcessInfo, SessionSnapshot, TabInfo, WorkspaceInfo } from "../../shared/herdr-api.generated.ts";
import { HC_OTHER_WORKSPACE_ID } from "../../shared/machines.ts";
import type { HerdrPane } from "../../shared/protocol.ts";
import type { Foreground, Status, Terminal } from "./hc-api.generated.ts";
import { clampRatio, type Grouping, type LayoutNode, LAYOUT_AREA, parseOvisLayout, place, reconcile, sideBySide } from "./layout-doc.ts";
import { worktreeOfLabels } from "./worktrees.ts";
import { paneAgent, type ProgramPlatform, reportedAgent, reportedStatus } from "../agent-identity.ts";
import { catalogPlatform, type CatalogPlatform } from "../../shared/agent-catalog.ts";
import type { JobProcess } from "../foreground-job.ts";
import { shownStatusOfWord } from "../../shared/attention.ts";

/**
 * hc has no workspaces, tabs or panes. The Herdr desktop app keeps its own (spaces, tabs and split
 * trees) in the core's `herdr-app` document, and labels each terminal it starts with its space and
 * tab (`herdr.space`, `herdr.tab`).
 *
 * A pane's id is its terminal's address (`t7`): it lasts as long as the terminal does, as a herdr
 * pane id does, and a tab that gets a new terminal in the same block gets a new pane.
 */

export const HERDR_PROTOCOL = 22;
export const OTHER_WORKSPACE_ID = HC_OTHER_WORKSPACE_ID;
export const LAYOUT_DOC = "herdr-app";
/** The labels the Herdr app groups its terminals by (herdr-app src/window.rs): a terminal it has not placed is adopted there. */
export const SPACE_LABEL = "herdr.space";
export const TAB_LABEL = "herdr.tab";
/** The names a person gave a workspace or tab Ovis made: names live in the app's document, which Ovis never writes. */
export const WORKSPACE_NAME_LABEL = "ovis.workspace";
export const TAB_NAME_LABEL = "ovis.tab";
export const PANE_NAME_LABEL = "ovis.pane";
export { SEEN_LABEL, seenTurnOf } from "../../shared/attention.ts";

/**
 * One OSC 7501 report (hc's `Status`): the program's own words. `kind` (permission, question, auth)
 * comes with `blocked` only, `progress` (0 to 100) with `working` or `blocked`, each only when the
 * program said.
 */
export type HcStatus = Pick<Status, "state"> & Partial<Pick<Status, "app" | "title" | "msg" | "kind" | "progress">>;
export type HcForeground = Pick<Foreground, "pid" | "name"> & Partial<Pick<Foreground, "argv" | "cwd">>;

/** hc's `parent` is the terminal that started it (`t3`), set once at its start. */
export type HcTerminal = Pick<Terminal, "address" | "cols" | "rows" | "cwd" | "state"> &
  Partial<Pick<Terminal, "argv" | "pid" | "name" | "title" | "labels" | "turn" | "parent" | "records">> &
  { status?: HcStatus | null; foreground?: HcForeground | null };

/**
 * A terminal on another machine the core reaches (`hc machine add vps`): hc lists and reports it
 * under that machine's name (`vps/t14`), where this PC's own are bare (`t7`). Each such machine is
 * a PC of its own (machine-scope.ts), so none of their terminals is this PC's: no workspace, tab, pane or event.
 */
export function onOtherMachine(address: string): boolean {
  return address.includes("/");
}

/** The one object guard of server/herdr-core/: hc's records and the app's document come from outside. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function agentStatusOf(status: HcStatus | null | undefined): AgentStatus {
  return reportedStatus(status?.state);
}

/** The status a terminal shows (shared/attention.ts `shownStatusOfWord`), from its program's report. */
export function shownStatusOf(status: HcStatus | null | undefined, turn: number | undefined, labels: Readonly<Record<string, string>> | undefined, firstTurn?: number): AgentStatus {
  const word = agentStatusOf(status);
  return shownStatusOfWord(word, turn, labels, firstTurn);
}

export function agentOfStatus(status: HcStatus | null | undefined): string | null {
  return reportedAgent(status?.app);
}

export type CoreHost = CatalogPlatform | null | "elsewhere";

export function coreHost(otherMachine: boolean | undefined, platform: NodeJS.Platform = process.platform): CoreHost {
  return otherMachine ? "elsewhere" : catalogPlatform(platform);
}

/**
 * The platform a terminal's programs run on. A terminal of this PC's core runs on this PC. hc names
 * no platform, so another machine's is read off a folder's shape: a drive letter or a `\\` share
 * is Windows, a `/` path is Linux's or macOS's (WSL's `/mnt/c` too: its shell is Linux). A missing
 * or relative folder tells nothing, nor does `//server/share`, a share to Windows and a root to POSIX.
 */
export function terminalPlatform(cwd: string | undefined, host: CoreHost): ProgramPlatform {
  if (host !== "elsewhere") return host;
  if (cwd === undefined || cwd.startsWith("//")) return null;
  if (windowsPath(cwd)) return "windows";
  return cwd.startsWith("/") ? "posix" : null;
}

export function agentOf(terminal: Pick<HcTerminal, "status" | "foreground"> & { cwd?: string | undefined; argv?: readonly string[] | undefined; pid?: number | null }, host: CoreHost): string | null {
  const front = terminal.foreground;
  const platform = terminalPlatform(front?.cwd || terminal.cwd, host);
  return paneAgent({ reported: terminal.status?.app, foreground: front?.argv?.length ? front.argv : front?.name ? [front.name] : null, foregroundPid: front?.pid ?? null, launcher: terminal.argv?.length ? { argv: terminal.argv, pid: terminal.pid ?? null } : null }, platform);
}

/** hc's record of the process in front of a terminal (a record's `foreground`, a `foreground` event's data); null for none or another shape. */
export function foregroundOf(value: unknown): HcForeground | null {
  if (!isRecord(value) || typeof value["pid"] !== "number" || typeof value["name"] !== "string") return null;
  const argv = value["argv"];
  const cwd = value["cwd"];
  return { pid: value["pid"], name: value["name"], ...(Array.isArray(argv) && argv.every((word) => typeof word === "string") ? { argv } : {}), ...(typeof cwd === "string" ? { cwd } : {}) };
}

/**
 * The sessions an OpenCode TUI reports as pending (its `program-status.ts`): one OSC 7501 record per
 * open tab's session that works or waits, under the session's id, cleared once it rests. A record
 * says nothing of which tab is on screen, and hc names a resting session nowhere: the sessions a
 * terminal ever named are only candidates for the one it shows (adapter.ts `sessionOf`).
 */
export function opencodeRecords(records: unknown): string[] {
  if (!isRecord(records)) return [];
  return Object.keys(records).filter((id) => {
    const record = records[id];
    return isRecord(record) && record["app"] === "opencode";
  });
}


export type SessionOf = (terminal: HcTerminal) => AgentSessionInfo | null;

const STATUS_RANK: Record<string, number> = { blocked: 4, working: 3, done: 2, idle: 1 };

/** A group's status is its most pressing pane's, as herdr's sidebar rolls it up. */
function rollUp(statuses: readonly AgentStatus[]): AgentStatus {
  let best: AgentStatus = "unknown";
  for (const status of statuses) if ((STATUS_RANK[status] ?? 0) > (STATUS_RANK[best] ?? 0)) best = status;
  return best;
}

/** A size the Herdr app gives a node (herdr-app src/layout.rs `Size`): pixels, or a weight that shares its row; none weighs 1. */
type Size = { px: number } | { weight: number };

function sizeOf(node: Record<string, unknown>): Size {
  const size = node["size"];
  const positive = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value > 0;
  if (isRecord(size) && positive(size["px"])) return { px: size["px"] };
  return { weight: isRecord(size) && positive(size["weight"]) ? size["weight"] : 1 };
}

function weights(sizes: readonly Size[], length: number): number[] {
  const free = sizes.reduce((sum, size) => sum + ("weight" in size ? size.weight : 0), 0);
  const fixed = sizes.reduce((sum, size) => sum + ("px" in size ? size.px / length : 0), 0);
  const scale = free > 0 ? free / Math.max(1 - fixed, 0.1) : 1;
  return sizes.map((size) => "px" in size ? size.px / length * scale : size.weight);
}

type AppNode = { leaf: string } | { direction: "right" | "down"; parts: { node: AppNode; size: Size }[] };
type Extent = { width: number; height: number };

function resolve(node: AppNode, extent: Extent): LayoutNode {
  return "leaf" in node ? node : chain(node.parts, node.direction, extent);
}

function chain(parts: readonly { node: AppNode; size: Size }[], direction: "right" | "down", extent: Extent): LayoutNode {
  if (parts.length === 1) return resolve(parts[0]!.node, extent);
  const shares = weights(parts.map(({ size }) => size), direction === "down" ? extent.height : extent.width);
  const ratio = clampRatio(shares[0]! / shares.reduce((sum, share) => sum + share, 0));
  const cut = (share: number): Extent => direction === "down" ? { width: extent.width, height: extent.height * share } : { width: extent.width * share, height: extent.height };
  return { split: direction, ratio, first: resolve(parts[0]!.node, cut(ratio)), second: chain(parts.slice(1), direction, cut(1 - ratio)) };
}

/**
 * A tab's tree in the app's document (never trusted to have a shape: herdr-app src/layout.rs
 * `Node`) as a tree over the live terminals, which `resolve` lays out top down like Ovis's own: a
 * `column` stacks its children, anything else sets them side by side: a \`stack\` and a hidden node
 * too, which Ovis cannot switch or show, so each terminal stays in reach and closes with its tab.
 */
function appTree(node: unknown, take: (address: string) => HcTerminal | null, held: HcTerminal[]): AppNode | null {
  if (!isRecord(node)) return null;
  const content = node["content"];
  if (isRecord(content) && typeof content["terminal"] === "string") {
    const terminal = take(content["terminal"]);
    if (!terminal) return null;
    held.push(terminal);
    return { leaf: terminal.address };
  }
  const children = node["children"];
  if (!Array.isArray(children)) return null;
  const parts = children.flatMap((child) => {
    const tree = appTree(child, take, held);
    return tree && isRecord(child) ? [{ node: tree, size: sizeOf(child) }] : [];
  });
  return parts.length === 0 ? null : { direction: node["type"] === "column" ? "down" : "right", parts };
}

function windowsPath(path: string): boolean {
  return /^(?:[A-Za-z]:[\\/]|\\\\)/.test(path);
}

/**
 * A folder's last name. A Windows path (a drive letter or a UNC prefix) splits at either slash and
 * any other at `/` only, by the path's shape and not this host's platform: a server can show
 * another machine's terminals (machine-scope.ts). A drive root has no folder: it stays as written,
 * as the client's `folderName` keeps it, so it still reads as a place.
 */
function basename(path: string): string {
  if (/^(?:\\\\[?.]\\)?[A-Za-z]:[\\/]+$/.test(path)) return path;
  const parts = path.split(windowsPath(path) ? /[\\/]/ : "/").filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

interface ShownTab { id: string; label: string; terminals: HcTerminal[]; root: LayoutNode | null; kept: boolean }
interface Group { id: string; label: string; folder?: string; tabs: ShownTab[] }

function besides(root: LayoutNode | null, count: number, address: string): LayoutNode | null {
  return root && { split: "right", ratio: clampRatio(count / (count + 1)), first: root, second: { leaf: address } };
}

// the Herdr app labels its terminals `where`: `<space> / <tab>`
function groups(terminals: readonly HcTerminal[], layout: unknown): Group[] {
  const own = layout === null || layout === undefined;
  const live = new Map(terminals.filter((terminal) => terminal.state === "live" && !onOtherMachine(terminal.address)).map((terminal) => [terminal.address, terminal]));
  const placed = new Set<string>();
  const take = (address: string): HcTerminal | null => {
    const terminal = live.get(address);
    if (!terminal || placed.has(address)) return null;
    placed.add(address);
    return terminal;
  };
  const ids = new Set<string>([OTHER_WORKSPACE_ID]);
  const fresh = (id: unknown): id is string => typeof id === "string" && id !== "" && !ids.has(id);
  const result: Group[] = [];
  const spaces = isRecord(layout) && Array.isArray(layout["spaces"]) ? layout["spaces"] : [];
  for (const space of spaces) {
    if (!isRecord(space) || !fresh(space["id"]) || !Array.isArray(space["tabs"])) continue;
    ids.add(space["id"]);
    const group: Group = { id: space["id"], label: "", tabs: [] };
    for (const [index, tab] of space["tabs"].entries()) {
      if (!isRecord(tab) || !fresh(tab["id"])) continue;
      ids.add(tab["id"]);
      const held: HcTerminal[] = [];
      const tree = appTree(tab["root"], take, held);
      const tabName = tab["name"];
      if (held.length === 0) { group.tabs.push({ id: tab["id"], label: typeof tabName === "string" ? tabName : "", terminals: [], root: null, kept: false }); continue; }
      const first = held[0]!;
      const where = first.labels?.["where"]?.split(" / ").map((part) => part.trim());
      group.tabs.push({ id: tab["id"], label: typeof tabName === "string" && tabName ? tabName : where?.[1] || first.labels?.[TAB_NAME_LABEL] || String(index + 1), terminals: held, root: tree && resolve(tree, LAYOUT_AREA), kept: false });
      if (!group.label) {
        const spaceName = space["name"];
        const folder = space["folder"];
        group.label = typeof spaceName === "string" && spaceName ? spaceName
          : where?.[0] || first.labels?.[WORKSPACE_NAME_LABEL] || (typeof folder === "string" && folder ? basename(folder) : basename(first.foreground?.cwd ?? first.cwd));
      }
    }
    if (!group.label && typeof space["name"] === "string") group.label = space["name"];
    if (typeof space["folder"] === "string" && space["folder"]) group.folder = space["folder"];
    result.push(group);
  }
  // a terminal the app has not placed yet, labeled with its space (and tab) the way the app labels
  // its own (an agent's worker, a terminal Ovis started): in that space, as the app will adopt it
  const rest: HcTerminal[] = [];
  for (const terminal of [...live.values()].filter((candidate) => !placed.has(candidate.address))) {
    const where = terminal.labels?.["where"]?.split(" / ").map((part) => part.trim());
    const spaceId = terminal.labels?.[SPACE_LABEL];
    let group = spaceId ? result.find((candidate) => candidate.id === spaceId) : undefined;
    if (!spaceId || (!group && ids.has(spaceId))) { rest.push(terminal); continue; }
    if (!group) {
      group = { id: spaceId, label: where?.[0] || terminal.labels?.[WORKSPACE_NAME_LABEL] || basename(terminal.foreground?.cwd ?? terminal.cwd), tabs: [] };
      ids.add(spaceId);
      result.push(group);
    }
    if (!group.label) group.label = where?.[0] || terminal.labels?.[WORKSPACE_NAME_LABEL] || basename(group.folder ?? terminal.foreground?.cwd ?? terminal.cwd);
    const labeled = terminal.labels?.[TAB_LABEL];
    // a tab id the app uses in another space would make one tab of two: this terminal gets its own
    // (an id of its own taken by a space or tab of the app's gets a number after it)
    let tabId = labeled && !(ids.has(labeled) && !group.tabs.some((candidate) => candidate.id === labeled)) ? labeled : `${spaceId}:${terminal.address}`;
    for (let n = 2; tabId !== labeled && ids.has(tabId) && !group.tabs.some((candidate) => candidate.id === tabId); n++) tabId = `${spaceId}:${terminal.address}:${n}`;
    const tab = group.tabs.find((candidate) => candidate.id === tabId);
    if (tab && !tab.label) tab.label = where?.[1] || terminal.labels?.[TAB_NAME_LABEL] || String(group.tabs.indexOf(tab) + 1);
    if (tab) {
      tab.root = besides(tab.root, tab.terminals.length, terminal.address);
      tab.terminals.push(terminal);
    } else {
      ids.add(tabId);
      group.tabs.push({ id: tabId, label: where?.[1] || terminal.labels?.[TAB_NAME_LABEL] || String(group.tabs.length + 1), terminals: [terminal], root: null, kept: own && tabId === labeled });
    }
  }
  const tabOf = new Map<string, { group: Group; tab: Group["tabs"][number] }>();
  for (const group of result) for (const tab of group.tabs) for (const terminal of tab.terminals) tabOf.set(terminal.address, { group, tab });
  const under = new Map<Group["tabs"][number], Group["tabs"][number]>();
  const below = (tab: Group["tabs"][number], ancestor: Group["tabs"][number]): boolean => {
    for (let at = under.get(tab); at; at = under.get(at)) if (at === ancestor) return true;
    return false;
  };
  let waiting = rest;
  for (let moved = true; moved;) {
    moved = false;
    const still: HcTerminal[] = [];
    for (const terminal of waiting) {
      const home = terminal.parent ? tabOf.get(terminal.parent) : undefined;
      if (!home) { still.push(terminal); continue; }
      let tabId = `${home.group.id}:${terminal.address}`;
      for (let n = 2; ids.has(tabId); n++) tabId = `${home.group.id}:${terminal.address}:${n}`;
      ids.add(tabId);
      const tab: ShownTab = { id: tabId, label: terminal.labels?.[TAB_NAME_LABEL] || terminal.name || terminal.address, terminals: [terminal], root: null, kept: false };
      let at = home.group.tabs.indexOf(home.tab) + 1;
      while (at < home.group.tabs.length && below(home.group.tabs[at]!, home.tab)) at++;
      home.group.tabs.splice(at, 0, tab);
      under.set(tab, home.tab);
      tabOf.set(terminal.address, { group: home.group, tab });
      moved = true;
    }
    waiting = still;
  }
  rest.length = 0;
  const left = new Set(waiting.map((terminal) => terminal.address));
  const helpersOf = new Map<string, HcTerminal[]>();
  for (const terminal of waiting) {
    if (terminal.parent && terminal.parent !== terminal.address && left.has(terminal.parent)) helpersOf.set(terminal.parent, [...(helpersOf.get(terminal.parent) ?? []), terminal]);
  }
  const added = new Set<string>();
  const add = (terminal: HcTerminal): void => {
    if (added.has(terminal.address)) return;
    added.add(terminal.address);
    rest.push(terminal);
    for (const helper of helpersOf.get(terminal.address) ?? []) add(helper);
  };
  for (const terminal of waiting) if (!terminal.parent || !left.has(terminal.parent)) add(terminal);
  for (const terminal of waiting) add(terminal);
  const shown = result.map((group) => ({ ...group, tabs: group.tabs.filter((tab) => tab.terminals.length > 0) })).filter((group) => group.tabs.length > 0);
  if (rest.length > 0) {
    shown.push({
      id: OTHER_WORKSPACE_ID,
      label: "Other terminals",
      tabs: rest.map((terminal) => ({ id: `${OTHER_WORKSPACE_ID}:${terminal.address}`, label: terminal.labels?.[TAB_NAME_LABEL] || terminal.name || terminal.address, terminals: [terminal], root: null, kept: false })),
    });
  }
  return shown;
}

export type FirstTurn = (terminal: Pick<HcTerminal, "address" | "turn">) => number;

export function reportedFacts(status: HcStatus | null | undefined): Pick<HerdrPane, "agent_kind" | "agent_message" | "agent_progress"> {
  if (!status) return {};
  const { kind, msg, progress } = status;
  return {
    ...(status.state === "blocked" && typeof kind === "string" && kind !== "" ? { agent_kind: kind } : {}),
    ...(status.state === "blocked" && typeof msg === "string" && msg.trim() !== "" ? { agent_message: msg } : {}),
    ...((status.state === "working" || status.state === "blocked") && typeof progress === "number" && Number.isInteger(progress) && progress >= 0 && progress <= 100 ? { agent_progress: progress } : {}),
  };
}

function paneOf(terminal: HcTerminal, workspaceId: string, tabId: string, shown: ReadonlySet<string>, host: CoreHost, firstTurn?: FirstTurn, sessionOf?: SessionOf): HerdrPane {
  const cwd = terminal.foreground?.cwd ?? terminal.cwd;
  const session = sessionOf?.(terminal) ?? null;
  return {
    ...(session ? { agent_session: session } : {}),
    ...(terminal.parent && terminal.parent !== terminal.address && shown.has(terminal.parent) ? { parent_pane_id: terminal.parent } : {}),
    ...(terminal.labels?.[SPACE_LABEL] === workspaceId && terminal.labels?.[TAB_LABEL] === tabId ? {} : { own_tab: true as const }),
    ...reportedFacts(terminal.status),
    pane_id: terminal.address,
    terminal_id: terminal.address,
    grid: { cols: terminal.cols, rows: terminal.rows },
    workspace_id: workspaceId,
    tab_id: tabId,
    agent: agentOf(terminal, host),
    agent_status: shownStatusOf(terminal.status, terminal.turn, terminal.labels, firstTurn?.(terminal)),
    cwd,
    foreground_cwd: cwd,
    title: terminal.title ?? null,
    terminal_title: terminal.title ?? null,
    label: terminal.labels?.[PANE_NAME_LABEL] || terminal.name || null,
    focused: false,
    revision: terminal.turn ?? 0,
  };
}

export function agentInfoOf(pane: PaneInfo): AgentInfo {
  return {
    pane_id: pane.pane_id,
    terminal_id: pane.terminal_id,
    workspace_id: pane.workspace_id,
    tab_id: pane.tab_id,
    agent: pane.agent ?? null,
    ...(pane.agent_session ? { agent_session: pane.agent_session } : {}),
    agent_status: pane.agent_status,
    cwd: pane.cwd ?? null,
    foreground_cwd: pane.foreground_cwd ?? null,
    title: pane.title ?? null,
    terminal_title: pane.terminal_title ?? null,
    focused: false,
    revision: pane.revision,
  };
}

function keptGrouping(placed: readonly Group[]): Grouping[] {
  return placed.filter((group) => group.id !== OTHER_WORKSPACE_ID && group.tabs.some((tab) => tab.kept))
    .map((group) => ({ id: group.id, tabs: group.tabs.filter((tab) => tab.kept).map((tab) => ({ id: tab.id, panes: tab.terminals.map((terminal) => terminal.address) })) }));
}

export function keptLayout(terminals: readonly HcTerminal[], ovisDoc: unknown) {
  return reconcile(parseOvisLayout(ovisDoc), keptGrouping(groups(terminals, null)));
}

function arranged(placed: Group[], ovisDoc: unknown): { groups: Group[]; zoomed: Map<string, string> } {
  const zoomed = new Map<string, string>();
  const layout = reconcile(parseOvisLayout(ovisDoc), keptGrouping(placed));
  const byId = new Map(placed.map((group) => [group.id, group]));
  const ordered = [...layout.workspaces.map((workspace) => byId.get(workspace.id)!), ...placed.filter((group) => !layout.workspaces.some((workspace) => workspace.id === group.id))];
  ordered.sort((a, b) => Number(a.id === OTHER_WORKSPACE_ID) - Number(b.id === OTHER_WORKSPACE_ID));
  for (const workspace of layout.workspaces) {
    const group = byId.get(workspace.id)!;
    const lead: ShownTab[] = [];
    const runs = new Map<string, ShownTab[]>();
    let run = lead;
    for (const tab of group.tabs) {
      if (tab.kept) runs.set(tab.id, run = []);
      run.push(tab);
    }
    group.tabs = [...lead, ...workspace.tabs.flatMap((tab) => runs.get(tab.id) ?? [])];
    for (const tab of workspace.tabs) {
      const shown = group.tabs.find((candidate) => candidate.id === tab.id);
      if (!shown) continue;
      shown.root = tab.root;
      if (tab.zoomed) zoomed.set(tab.id, tab.zoomed);
    }
  }
  return { groups: ordered, zoomed };
}

/**
 * Nothing has herdr's focus: the app keeps its own focus per window, and no pane is in front of
 * anyone the way a herdr TUI's is. Each tab is the fixed LAYOUT_AREA cut top down by its tree (the
 * app's, or Ovis's own document `ovisDoc` where no Herdr app arranges the core), never by its
 * terminals' grids: a viewer sizes a terminal to its pane's cell, and a grid read back as the pane
 * made panes shrink each other (#2812).
 */
export function buildSnapshot(terminals: readonly HcTerminal[], layout: unknown, version: string, firstTurn?: FirstTurn, ovisDoc?: unknown, sessionOf?: SessionOf, host: CoreHost = coreHost(false)): SessionSnapshot {
  const workspaces: WorkspaceInfo[] = [];
  const tabs: TabInfo[] = [];
  const panes: PaneInfo[] = [];
  const layouts: PaneLayoutSnapshot[] = [];
  const own = layout === null || layout === undefined;
  const grouped = groups(terminals, layout);
  const { groups: placed, zoomed } = own ? arranged(grouped, ovisDoc) : { groups: grouped, zoomed: new Map<string, string>() };
  const shown = new Set(placed.flatMap((group) => group.tabs.flatMap((tab) => tab.terminals.map((terminal) => terminal.address))));
  for (const [index, group] of placed.entries()) {
    const groupPanes: PaneInfo[] = [];
    for (const [tabIndex, tab] of group.tabs.entries()) {
      const byAddress = new Map(tab.terminals.map((terminal) => [terminal.address, terminal]));
      const cut = place(tab.root ?? sideBySide(tab.terminals.map((terminal) => terminal.address)));
      const tabPanes = cut.panes.map(({ pane_id }) => paneOf(byAddress.get(pane_id)!, group.id, tab.id, shown, host, firstTurn, sessionOf));
      groupPanes.push(...tabPanes);
      const alone = zoomed.get(tab.id);
      const focused = alone ?? tabPanes[0]!.pane_id;
      tabs.push({ tab_id: tab.id, workspace_id: group.id, label: tab.label, number: tabIndex + 1, agent_status: rollUp(tabPanes.map((pane) => pane.agent_status)), focused: false, pane_count: tabPanes.length });
      layouts.push({
        workspace_id: group.id,
        tab_id: tab.id,
        area: { ...LAYOUT_AREA },
        focused_pane_id: focused,
        panes: cut.panes.map(({ pane_id, rect }) => ({ pane_id, focused: pane_id === focused, rect })),
        splits: cut.splits,
        zoomed: alone !== undefined,
      });
    }
    panes.push(...groupPanes);
    const worktree = !own || group.id === OTHER_WORKSPACE_ID ? null : group.tabs.flatMap((tab) => tab.terminals).map((terminal) => worktreeOfLabels(terminal.labels)).find((facts) => facts !== null) ?? null;
    workspaces.push({
      ...(worktree ? { worktree } : {}),
      workspace_id: group.id,
      label: group.label,
      number: index + 1,
      active_tab_id: group.tabs[0]!.id,
      agent_status: rollUp(groupPanes.map((pane) => pane.agent_status)),
      focused: false,
      pane_count: groupPanes.length,
      tab_count: group.tabs.length,
    });
  }
  return {
    version,
    protocol: HERDR_PROTOCOL,
    workspaces,
    tabs,
    panes,
    layouts,
    agents: panes.filter((pane) => pane.agent).map(agentInfoOf),
    focused_workspace_id: null,
    focused_tab_id: null,
    focused_pane_id: null,
  };
}

/**
 * A shell running a command string (`sh -c "codex …"`): how hc runs a template's `command:` line. dash
 * stays in front under its own pid and runs the program as its child, so hc names only the shell (#4052).
 */
export function runsCommandString(foreground: HcForeground | null | undefined): foreground is HcForeground {
  const [program, flags] = foreground?.argv ?? [];
  return /(?:^|\/)(?:sh|bash|dash|zsh)$/.test(program ?? "") && /^-[a-z]*c[a-z]*$/.test(flags ?? "");
}

/**
 * herdr's `pane.process_info` for a terminal: its shell and what runs in front of it. `job`: the
 * processes below the one in front, in its job (foreground-job.ts), named after it as herdr names
 * every process of the job; the adapter reads them only for a shell running a command string.
 */
export function processInfoOf(terminal: HcTerminal, job: readonly JobProcess[] | null = null): PaneProcessInfo {
  const foreground = terminal.foreground;
  return {
    pane_id: terminal.address,
    shell_pid: terminal.pid ?? null,
    foreground_process_group_id: foreground?.pid ?? null,
    foreground_processes: foreground
      ? [
        { name: foreground.name, pid: foreground.pid, argv: foreground.argv ?? null, argv0: foreground.argv?.[0] ?? null, cmdline: foreground.argv?.join(" ") ?? null, cwd: foreground.cwd ?? null },
        ...(job ?? []).map(({ pid, name, argv }) => ({ name, pid, argv, argv0: argv[0] ?? null, cmdline: argv.join(" "), cwd: null })),
      ]
      : [],
  };
}

/** The characters hc's `terminal.keys` has a key for (herdr-core crates/herdr-core/src/keys.rs). */
const HC_KEY_CHARACTER = /^[a-z0-9`\\[\],=\-.';/]$/;

function printable(text: string): boolean {
  return [...text].length === 1 && text >= " " && text !== "\x7f";
}

/**
 * Unmodified keys whose bytes no keyboard mode a program sets changes (kitty's disambiguate mode,
 * which agents enable, keeps them too). Typed directly: hc's `terminal.keys` holds a key until
 * nobody has typed for ~3 s, which would hold every Enter after a paste.
 */
const STABLE_KEYS: Record<string, string> = { enter: "\r", return: "\r", tab: "\t", backspace: "\x7f" };

/**
 * What a herdr key types, for keys hc's `terminal.keys` is not needed for: one printable
 * character (`x`, `한`, `A`) as itself, Enter, Tab and Backspace, and Alt or Shift on a character
 * hc has no key for (`alt+|`, `shift+plus`) as a terminal sends it, ESC before the character for
 * Alt. null for a key or chord hc encodes in the program's current keyboard modes (`esc`,
 * `ctrl+c`, `alt+x`, `up`).
 */
export function keyBytes(key: string): string | null {
  if (printable(key)) return key;
  const name = key.toLowerCase();
  if (Object.hasOwn(STABLE_KEYS, name)) return STABLE_KEYS[name]!;
  const parts = key.split("+");
  const last = parts.at(-1)!;
  const character = last === "plus" ? "+" : last;
  const mods = parts.slice(0, -1).map((mod) => mod.toLowerCase());
  if (!printable(character) || HC_KEY_CHARACTER.test(character.toLowerCase())) return null;
  if (!mods.every((mod) => mod === "alt" || mod === "shift")) return null;
  return `${mods.includes("alt") ? "\x1b" : ""}${character}`;
}

/** herdr's key name as hc's `terminal.keys` names it: lowercase, and `ctrl+` for herdr's `c-`. */
export function hcKeyName(key: string): string {
  return key.toLowerCase().replace(/^c-/, "ctrl+");
}
