import type { AgentInfo, AgentStatus, PaneInfo, PaneLayoutSnapshot, PaneProcessInfo, SessionSnapshot, TabInfo, WorkspaceInfo } from "../../shared/herdr-api.generated.ts";
import type { HerdrPane } from "../../shared/protocol.ts";
import type { Foreground, Status, Terminal } from "./hc-api.generated.ts";

/**
 * How herdr-core's terminals look to the rest of the server: herdr's session snapshot, built from
 * hc's terminal records and the Herdr app's layout document.
 *
 * hc has no workspaces, tabs or panes. The Herdr desktop app keeps its own (spaces, tabs and split
 * trees) in the core's `herdr-app` document, and labels each terminal it starts with its space and
 * tab (`herdr.space`, `herdr.tab`). A space reads as a workspace, a tab as a tab and each terminal
 * block in the tab's tree as a pane, in the app's order. A live terminal no tab holds and no label
 * places gets a tab of its own: right after the tab of the terminal that started it (hc's `parent`:
 * an agent's helper), when that one is shown, and otherwise in one more workspace.
 *
 * A pane's id is its terminal's address (`t7`): it lasts as long as the terminal does, as a herdr
 * pane id does, and a tab that gets a new terminal in the same block gets a new pane.
 */

/** The protocol these answers keep to: herdr's, as `shared/herdr-api.generated.ts` was made from. */
export const HERDR_PROTOCOL = 22;
export const OTHER_WORKSPACE_ID = "hc-other";
export const LAYOUT_DOC = "herdr-app";
/** The labels the Herdr app groups its terminals by (herdr-app src/window.rs): a terminal it has not placed is adopted there. */
export const SPACE_LABEL = "herdr.space";
export const TAB_LABEL = "herdr.tab";
/** The names a person gave a workspace or tab Ovis made: names live in the app's document, which Ovis never writes. */
export const WORKSPACE_NAME_LABEL = "ovis.workspace";
export const TAB_NAME_LABEL = "ovis.tab";
/**
 * The last turn a person looked at, shared by every Herdr client (herdr-app docs/labels.md): an
 * agent at rest whose turn is past it is done, one at or below it idle. Missing, the program's own
 * word stands, as it did before.
 */
export const SEEN_LABEL = "herdr.seen";

/**
 * One OSC 7501 report (hc's `Status`): the program's own words. `kind` (permission, question, auth)
 * comes with `blocked` only, `progress` (0 to 100) with `working` or `blocked`, each only when the
 * program said.
 */
export type HcStatus = Pick<Status, "state"> & Partial<Pick<Status, "app" | "title" | "msg" | "kind" | "progress">>;
export type HcForeground = Pick<Foreground, "pid" | "name"> & Partial<Pick<Foreground, "argv" | "cwd">>;

/** The fields of hc's `Terminal` record this side reads, by hc's own schema; `parent` is the terminal that started it (`t3`), set once at its start. */
export type HcTerminal = Pick<Terminal, "address" | "cols" | "rows" | "cwd" | "state"> &
  Partial<Pick<Terminal, "argv" | "pid" | "name" | "title" | "labels" | "turn" | "parent">> &
  { status?: HcStatus | null; foreground?: HcForeground | null };

/**
 * A terminal on another machine the core reaches (`hc machine add vps`): hc lists and reports it
 * under that machine's name (`vps/t14`), where this PC's own are bare (`t7`). Until those machines
 * show as PCs of their own, none of their terminals is this PC's: no workspace, tab, pane or event.
 */
export function onOtherMachine(address: string): boolean {
  return address.includes("/");
}

/** The one object guard of server/herdr-core/: hc's records and the app's document come from outside. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * hc stores the program's own status word (idle, working, done, blocked, error, …). herdr's
 * vocabulary is narrower: an error says nothing about the turn having finished, so it shows as no
 * status, like a word neither knows.
 */
export function agentStatusOf(status: HcStatus | null | undefined): AgentStatus {
  switch (status?.state) {
    case "working":
    case "blocked":
    case "idle":
    case "done":
      return status.state;
    default:
      return "unknown";
  }
}

/** herdr-core's names for agents herdr names otherwise: the rest of the server knows herdr's (`claude`, `agy`). */
const HERDR_AGENT_NAMES: Record<string, string> = { "claude-code": "claude", antigravity: "agy" };

/** The agent a status names, by herdr's name; a program that never reported one runs none herdr would see. */
/** The turn a terminal's `herdr.seen` names; null when it has none, or none a client wrote as a turn. */
export function seenTurnOf(labels: Readonly<Record<string, string>> | undefined): number | null {
  const value = labels?.[SEEN_LABEL];
  if (value === undefined || !/^\d{1,15}$/.test(value)) return null;
  return Number(value);
}

/**
 * The status a terminal shows: its program's word, except that an agent at rest (`idle`, `done`)
 * whose terminal carries `herdr.seen` is done while a turn ended after the one last looked at, and
 * idle once someone looked, on whichever client. Without the label, Ovis's own rule: a turn that
 * ended since this server first saw the terminal (`firstTurn`) is done, as the program's word is
 * otherwise.
 */
export function shownStatusOf(status: HcStatus | null | undefined, turn: number | undefined, labels: Readonly<Record<string, string>> | undefined, firstTurn?: number): AgentStatus {
  const word = agentStatusOf(status);
  if (word !== "idle" && word !== "done") return word;
  const seen = seenTurnOf(labels);
  if (seen !== null) return (turn ?? 0) > seen ? "done" : "idle";
  return firstTurn !== undefined && (turn ?? 0) > firstTurn ? "done" : word;
}

export function agentOfStatus(status: HcStatus | null | undefined): string | null {
  const app = status?.app;
  if (!app) return null;
  return Object.hasOwn(HERDR_AGENT_NAMES, app) ? HERDR_AGENT_NAMES[app]! : app;
}

export function agentOf(terminal: HcTerminal): string | null {
  return agentOfStatus(terminal.status);
}

const STATUS_RANK: Record<string, number> = { blocked: 4, working: 3, done: 2, idle: 1 };

/** A group's status is its most pressing pane's, as herdr's sidebar rolls it up. */
function rollUp(statuses: readonly AgentStatus[]): AgentStatus {
  let best: AgentStatus = "unknown";
  for (const status of statuses) if ((STATUS_RANK[status] ?? 0) > (STATUS_RANK[best] ?? 0)) best = status;
  return best;
}

/** A terminal in a tab, at its place in the tab's split tree (cells from the tab's top left). */
interface Placed { terminal: HcTerminal; x: number; y: number }

/**
 * Lays a tab's split tree (the app's document: never trusted to have a shape) out in reading order:
 * a `column` stacks its children, anything else sets them side by side, one cell apart as a
 * divider; each terminal takes its own grid. `take` hands over a live terminal not placed yet,
 * so one named twice is placed once.
 */
function tile(node: unknown, x: number, y: number, take: (address: string) => HcTerminal | null, into: Placed[]): { width: number; height: number } {
  if (!isRecord(node)) return { width: 0, height: 0 };
  const content = node["content"];
  if (isRecord(content) && typeof content["terminal"] === "string") {
    const terminal = take(content["terminal"]);
    if (!terminal) return { width: 0, height: 0 };
    into.push({ terminal, x, y });
    return { width: terminal.cols, height: terminal.rows };
  }
  const children = node["children"];
  if (!Array.isArray(children)) return { width: 0, height: 0 };
  const stacked = node["type"] === "column";
  let along = 0;
  let across = 0;
  for (const child of children) {
    const size = stacked ? tile(child, x, y + along, take, into) : tile(child, x + along, y, take, into);
    if (size.width === 0 && size.height === 0) continue;
    along += (stacked ? size.height : size.width) + 1;
    across = Math.max(across, stacked ? size.width : size.height);
  }
  const length = Math.max(0, along - 1);
  return stacked ? { width: across, height: length } : { width: length, height: across };
}

function basename(path: string): string {
  const parts = path.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

interface Group { id: string; label: string; folder?: string; tabs: { id: string; label: string; placed: Placed[] }[] }

/**
 * The app's spaces and tabs over the live terminals. A name the user gave wins; an unnamed space
 * or tab reads as the app labels its terminals (`where`: `<space> / <tab>`), and failing that as
 * its first terminal's folder, or its number. A space or tab id seen before, or empty, is skipped; one
 * with no live terminal stays a place for a labeled terminal and shows only once it holds one.
 */
function groups(terminals: readonly HcTerminal[], layout: unknown): Group[] {
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
      const held: Placed[] = [];
      tile(tab["root"], 0, 0, take, held);
      const tabName = tab["name"];
      // a tab with no live terminal stays a place: a labeled terminal the app will adopt into it keeps its ids
      // (unnamed, it reads as the terminal it gets is labeled, below)
      if (held.length === 0) { group.tabs.push({ id: tab["id"], label: typeof tabName === "string" ? tabName : "", placed: [] }); continue; }
      const first = held[0]!.terminal;
      const where = first.labels?.["where"]?.split(" / ").map((part) => part.trim());
      group.tabs.push({ id: tab["id"], label: typeof tabName === "string" && tabName ? tabName : where?.[1] || first.labels?.[TAB_NAME_LABEL] || String(index + 1), placed: held });
      if (!group.label) {
        const spaceName = space["name"];
        const folder = space["folder"];
        group.label = typeof spaceName === "string" && spaceName ? spaceName
          : where?.[0] || first.labels?.[WORKSPACE_NAME_LABEL] || (typeof folder === "string" && folder ? basename(folder) : basename(first.foreground?.cwd ?? first.cwd));
      }
    }
    // a space with no live terminal: its name, else as the terminal it gets is labeled (below)
    if (!group.label && typeof space["name"] === "string") group.label = space["name"];
    if (typeof space["folder"] === "string" && space["folder"]) group.folder = space["folder"];
    result.push(group);
  }
  // a terminal the app has not placed yet, labeled with its space (and tab) the way the app labels
  // its own (an agent's worker, a terminal Ovis started): in that space, as the app will adopt it
  const rest: HcTerminal[] = [];
  for (const terminal of [...live.values()].filter((candidate) => !placed.has(candidate.address))) {
    // named as a placed terminal is: `where` (`<space> / <tab>`), then Ovis's own labels
    const where = terminal.labels?.["where"]?.split(" / ").map((part) => part.trim());
    const spaceId = terminal.labels?.[SPACE_LABEL];
    let group = spaceId ? result.find((candidate) => candidate.id === spaceId) : undefined;
    // a label naming no space but an id the app's document uses for something else is no space
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
    // beside what the tab already shows, never over it: the app places it when it adopts it
    if (tab) tab.placed.push({ terminal, x: tab.placed.length ? Math.max(...tab.placed.map((held) => held.x + held.terminal.cols + 1)) : 0, y: 0 });
    else {
      ids.add(tabId);
      group.tabs.push({ id: tabId, label: where?.[1] || terminal.labels?.[TAB_NAME_LABEL] || String(group.tabs.length + 1), placed: [{ terminal, x: 0, y: 0 }] });
    }
  }
  // a terminal another one started (an agent's helper, `hc run` from a shell) that nothing above
  // placed: a tab of its own right after its parent's tab and the helpers already there, so it
  // reads under that tab. A parent placed only here goes first, so a helper's helper follows it.
  // With no parent, or one not shown, it stays with the other terminals.
  const tabOf = new Map<string, { group: Group; tab: Group["tabs"][number] }>();
  for (const group of result) for (const tab of group.tabs) for (const { terminal } of tab.placed) tabOf.set(terminal.address, { group, tab });
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
      const tab = { id: tabId, label: terminal.labels?.[TAB_NAME_LABEL] || terminal.name || terminal.address, placed: [{ terminal, x: 0, y: 0 }] };
      let at = home.group.tabs.indexOf(home.tab) + 1;
      while (at < home.group.tabs.length && below(home.group.tabs[at]!, home.tab)) at++;
      home.group.tabs.splice(at, 0, tab);
      under.set(tab, home.tab);
      tabOf.set(terminal.address, { group: home.group, tab });
      moved = true;
    }
    waiting = still;
  }
  // what is left keeps its order, with a helper whose parent is here too right after that parent
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
  // parents that started each other: their own order
  for (const terminal of waiting) add(terminal);
  // a space or tab of the app's with nothing live in it shows nothing
  const shown = result.map((group) => ({ ...group, tabs: group.tabs.filter((tab) => tab.placed.length > 0) })).filter((group) => group.tabs.length > 0);
  if (rest.length > 0) {
    shown.push({
      id: OTHER_WORKSPACE_ID,
      label: "Other terminals",
      tabs: rest.map((terminal) => ({ id: `${OTHER_WORKSPACE_ID}:${terminal.address}`, label: terminal.labels?.[TAB_NAME_LABEL] || terminal.name || terminal.address, placed: [{ terminal, x: 0, y: 0 }] })),
    });
  }
  return shown;
}

/** The turn a terminal had when this server first saw it (adapter.ts): without `herdr.seen`, what ended since is done. */
export type FirstTurn = (terminal: Pick<HcTerminal, "address" | "turn">) => number;

/**
 * What the program itself reported beyond its state, each only when it did and only while it means
 * something: what a blocked agent waits for and its message as written, and the progress of one
 * that works or is blocked, a whole percentage.
 */
export function reportedFacts(status: HcStatus | null | undefined): Pick<HerdrPane, "agent_kind" | "agent_message" | "agent_progress"> {
  if (!status) return {};
  const { kind, msg, progress } = status;
  return {
    ...(status.state === "blocked" && typeof kind === "string" && kind !== "" ? { agent_kind: kind } : {}),
    ...(status.state === "blocked" && typeof msg === "string" && msg.trim() !== "" ? { agent_message: msg } : {}),
    ...((status.state === "working" || status.state === "blocked") && typeof progress === "number" && Number.isInteger(progress) && progress >= 0 && progress <= 100 ? { agent_progress: progress } : {}),
  };
}

function paneOf(terminal: HcTerminal, workspaceId: string, tabId: string, shown: ReadonlySet<string>, firstTurn?: FirstTurn): HerdrPane {
  const cwd = terminal.foreground?.cwd ?? terminal.cwd;
  return {
    ...(terminal.parent && terminal.parent !== terminal.address && shown.has(terminal.parent) ? { parent_pane_id: terminal.parent } : {}),
    ...reportedFacts(terminal.status),
    pane_id: terminal.address,
    terminal_id: terminal.address,
    workspace_id: workspaceId,
    tab_id: tabId,
    agent: agentOf(terminal),
    agent_status: shownStatusOf(terminal.status, terminal.turn, terminal.labels, firstTurn?.(terminal)),
    cwd,
    foreground_cwd: cwd,
    title: terminal.title ?? null,
    terminal_title: terminal.title ?? null,
    label: terminal.name ?? null,
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
    agent_status: pane.agent_status,
    cwd: pane.cwd ?? null,
    foreground_cwd: pane.foreground_cwd ?? null,
    title: pane.title ?? null,
    terminal_title: pane.terminal_title ?? null,
    focused: false,
    revision: pane.revision,
  };
}

/**
 * herdr's session snapshot of the core. Nothing has herdr's focus: the app keeps its own focus per
 * window, and no pane is in front of anyone the way a herdr TUI's is. Each pane's layout rect is
 * its terminal's own grid, the size an observer attaches at, at its place in the tab's splits.
 */
export function buildSnapshot(terminals: readonly HcTerminal[], layout: unknown, version: string, firstTurn?: FirstTurn): SessionSnapshot {
  const workspaces: WorkspaceInfo[] = [];
  const tabs: TabInfo[] = [];
  const panes: PaneInfo[] = [];
  const layouts: PaneLayoutSnapshot[] = [];
  const placed = groups(terminals, layout);
  const shown = new Set(placed.flatMap((group) => group.tabs.flatMap((tab) => tab.placed.map(({ terminal }) => terminal.address))));
  for (const [index, group] of placed.entries()) {
    const groupPanes: PaneInfo[] = [];
    for (const [tabIndex, tab] of group.tabs.entries()) {
      const tabPanes = tab.placed.map(({ terminal }) => paneOf(terminal, group.id, tab.id, shown, firstTurn));
      groupPanes.push(...tabPanes);
      tabs.push({ tab_id: tab.id, workspace_id: group.id, label: tab.label, number: tabIndex + 1, agent_status: rollUp(tabPanes.map((pane) => pane.agent_status)), focused: false, pane_count: tabPanes.length });
      layouts.push({
        workspace_id: group.id,
        tab_id: tab.id,
        area: {
          x: 0,
          y: 0,
          width: Math.max(...tab.placed.map(({ terminal, x }) => x + terminal.cols)),
          height: Math.max(...tab.placed.map(({ terminal, y }) => y + terminal.rows)),
        },
        focused_pane_id: tabPanes[0]!.pane_id,
        panes: tab.placed.map(({ terminal, x, y }, at) => ({ pane_id: terminal.address, focused: at === 0, rect: { x, y, width: terminal.cols, height: terminal.rows } })),
        splits: [],
        zoomed: false,
      });
    }
    panes.push(...groupPanes);
    workspaces.push({
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

/** herdr's `pane.process_info` for a terminal: its shell and what runs in front of it. */
export function processInfoOf(terminal: HcTerminal): PaneProcessInfo {
  const foreground = terminal.foreground;
  return {
    pane_id: terminal.address,
    shell_pid: terminal.pid ?? null,
    foreground_process_group_id: foreground?.pid ?? null,
    foreground_processes: foreground
      ? [{ name: foreground.name, pid: foreground.pid, argv: foreground.argv ?? null, argv0: foreground.argv?.[0] ?? null, cmdline: foreground.argv?.join(" ") ?? null, cwd: foreground.cwd ?? null }]
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
