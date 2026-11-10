/**
 * The Agents list's rows in the order it draws them: the pinned card first, in pin order, then
 * every PC's agents in the roster's order, or in Activity order across PCs when Settings asks
 * for it. A row is its PC and its pane: two PCs may reuse a pane id.
 */
import type { Machine } from "../../shared/machines.ts";
import { isBackgroundRole, ROLE_TOKEN } from "../../shared/pane-tokens.ts";
import { sidebarAgents, type SidebarAgent } from "./sidebarAgents.ts";
import type { AgentStatus } from "../../shared/protocol.ts";
import type { AgentGroupSort } from "./settings.ts";
import { activityOrder } from "./sidebarOrder.ts";
import { knownStatus } from "./status.ts";
import { sidebarPinKey, splitPinnedRows } from "./sidebarPins.ts";

export interface AgentRow { machine: Machine; entry: SidebarAgent }

export interface AgentRosterOptions {
  /** Settings → Agents order: Activity sorts all PCs' rows together. */
  byActivity: boolean;
  /** a PC's state-change counters, as lib/sidebarActivity.tsx keeps them */
  seqs(machineId: string): ReadonlyMap<string, number>;
  /** Observed cross-PC recency, keyed by sidebarPinKey; native counters are PC-local. */
  recent: ReadonlyMap<string, number>;
  /** the pinned rows' keys (lib/sidebarPins.ts), in pin order */
  pinned: readonly string[];
}

/**
 * A PC's rows with each helper right under the agent that started it (herdr-core's `parent_pane_id`),
 * after that agent's earlier helpers. An agent and its helpers stand together where the first of
 * them stands in the given order, so in Activity order a blocked helper brings its agent up with it.
 * A row whose parent is not a row stays where it is.
 */
export function nestHelpers(entries: readonly SidebarAgent[]): SidebarAgent[] {
  return nestRows(entries, (entry) => entry.pane.pane_id, (entry) => entry.pane.parent_pane_id);
}

/** nestHelpers for rows of any shape, told apart by `idOf` and naming their agent's row by `parentIdOf` */
function nestRows<T>(entries: readonly T[], idOf: (entry: T) => string, parentIdOf: (entry: T) => string | undefined): T[] {
  const byId = new Map(entries.map((entry) => [idOf(entry), entry]));
  const parentOf = (entry: T): T | undefined => {
    const parent = parentIdOf(entry);
    return parent === undefined || parent === idOf(entry) ? undefined : byId.get(parent);
  };
  const helpers = new Map<T, T[]>();
  for (const entry of entries) {
    const parent = parentOf(entry);
    if (parent) helpers.set(parent, [...(helpers.get(parent) ?? []), entry]);
  }
  /** the agent at the top of a row's helpers chain; in a loop (no top), the row itself */
  const rootOf = (entry: T): T => {
    const passed = new Set<T>([entry]);
    let root = entry;
    for (let up = parentOf(root); up; up = parentOf(up)) {
      if (passed.has(up)) return entry;
      passed.add(up);
      root = up;
    }
    return root;
  };
  const ordered: T[] = [];
  const seen = new Set<T>();
  const add = (entry: T): void => {
    if (seen.has(entry)) return;
    seen.add(entry);
    ordered.push(entry);
    for (const helper of helpers.get(entry) ?? []) add(helper);
  };
  for (const entry of entries) add(rootOf(entry));
  // a loop's rows not reached from the row that stood for it keep their place
  for (const entry of entries) add(entry);
  return ordered;
}

/**
 * Agent rows as the list draws them: pinned first, then workspace or cross-PC Activity order. The
 * cross-PC sort is nested again, so an agent's helpers stay right under it.
 */
export function agentRoster(machines: readonly Machine[], options: AgentRosterOptions): { pinned: AgentRow[]; rest: AgentRow[] } {
  const rows = machines.flatMap((machine) => {
    const agents = sidebarAgents(machine.snapshot);
    return nestHelpers(options.byActivity ? activityOrder(agents, (entry) => entry.pane, options.seqs(machine.id)) : agents).map((entry): AgentRow => ({ machine, entry }));
  });
  const keyOf = ({ machine, entry }: AgentRow): string => sidebarPinKey(machine.id, entry.pane.pane_id);
  const ordered = options.byActivity ? nestRows(activityOrder(rows, (row) => ({
    pane_id: keyOf(row), agent_status: row.entry.pane.agent_status,
  }), options.recent), keyOf, ({ machine, entry }) => entry.pane.parent_pane_id === undefined ? undefined : sidebarPinKey(machine.id, entry.pane.parent_pane_id)) : rows;
  return splitPinnedRows(ordered, options.pinned, ({ machine, entry }) => sidebarPinKey(machine.id, entry.pane.pane_id));
}

/**
 * Whether a launcher tagged the pane as a background agent: `herdr pane report-metadata <pane>
 * --token role=background` (any case, spaces around it ignored). Nothing is guessed: a pane
 * without the token is one a person drives.
 */
export function isBackgroundAgent({ pane, agent }: SidebarAgent): boolean {
  return isBackgroundRole((pane.tokens ?? agent?.tokens)?.[ROLE_TOKEN]);
}

/**
 * The list's unpinned rows split into the agents a person drives and the background ones (workers,
 * subagents), each in the order given. A background row is one tagged `role=background`, or a
 * helper started (herdr-core's `parent_pane_id`) by one, looked up in `all` (the whole roster); a
 * blocked one stays with the people's rows, so a question is never folded away.
 */
export function splitBackgroundRows(rows: readonly AgentRow[], status: (row: AgentRow) => AgentStatus | undefined, all: readonly AgentRow[] = rows): { people: AgentRow[]; background: AgentRow[] } {
  // a helper's agent is looked up among every row, pinned or filtered out ones too
  const byKey = new Map(all.map((row) => [sidebarPinKey(row.machine.id, row.entry.pane.pane_id), row]));
  const tagged = (row: AgentRow): boolean => {
    // up the helpers chain to the first tagged row; a loop ends the walk
    const passed = new Set<AgentRow>();
    for (let up: AgentRow | undefined = row; up && !passed.has(up); up = up.entry.pane.parent_pane_id === undefined ? undefined : byKey.get(sidebarPinKey(up.machine.id, up.entry.pane.parent_pane_id))) {
      if (isBackgroundAgent(up.entry)) return true;
      passed.add(up);
    }
    return false;
  };
  const people: AgentRow[] = [];
  const background: AgentRow[] = [];
  for (const row of rows) (tagged(row) && knownStatus(status(row)) !== "blocked" ? background : people).push(row);
  // each part is laid out anew: a helper whose agent went to the other part stands as a root, not under another row
  const keyOf = ({ machine, entry }: AgentRow): string => sidebarPinKey(machine.id, entry.pane.pane_id);
  const nest = (part: AgentRow[]): AgentRow[] => nestRows(part, keyOf, ({ machine, entry }) => entry.pane.parent_pane_id === undefined ? undefined : sidebarPinKey(machine.id, entry.pane.parent_pane_id));
  return { people: nest(people), background: nest(background) };
}

/** Settings → Group agents by state: the groups, in the order the list draws them */
export const AGENT_GROUPS = ["blocked", "working", "done", "idle"] as const;
export type AgentGroup = (typeof AGENT_GROUPS)[number];

/** The group a row's shown state files it under: BG works, a finish already read is ready, and a state nobody knows rests. */
export function agentGroup(status: AgentStatus | undefined): AgentGroup {
  const known = knownStatus(status);
  return known === "blocked" || known === "done" ? known : known === "working" || known === "waiting" ? "working" : "idle";
}

export interface AgentGroupOptions {
  /** Settings → Within a state */
  sort: AgentGroupSort;
  /** the state the row draws (lib/sidebarActivity.tsx), undefined for a PC that is away */
  status(row: AgentRow): AgentStatus | undefined;
  /** the row's title, for the Name order */
  name(row: AgentRow): string;
  /** a PC's state-change counters, as lib/sidebarActivity.tsx keeps them */
  seqs(machineId: string): ReadonlyMap<string, number>;
}

/**
 * The rows (the list's unpinned ones) in groups by state, each group in the chosen order. A PC's
 * counters only compare with its own, so Longest wait and Recent order each PC's rows within a
 * group, the PCs in their list order; Name orders all of them. An agent and its helpers stand
 * together, in the group of the one of them that needs the reader most (a blocked helper brings
 * its agent up into Needs you). A group with no row is left out.
 */
export function groupAgentRows(rows: readonly AgentRow[], options: AgentGroupOptions): { group: AgentGroup; rows: AgentRow[] }[] {
  const machineIndex = new Map<string, number>();
  for (const { machine } of rows) if (!machineIndex.has(machine.id)) machineIndex.set(machine.id, machineIndex.size);
  const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
  const keyOf = ({ machine, entry }: AgentRow): string => sidebarPinKey(machine.id, entry.pane.pane_id);
  const keyed = rows.map((row, index) => {
    const seq = options.seqs(row.machine.id).get(row.entry.pane.pane_id);
    return { row, index, rank: AGENT_GROUPS.indexOf(agentGroup(options.status(row))), pc: machineIndex.get(row.machine.id)!, seq, name: options.sort === "name" ? options.name(row) : "" };
  });
  // a row with no counter yet sorts after the dated ones, in either direction
  const bySeq = (a: number | undefined, b: number | undefined, sign: 1 | -1): number =>
    a === undefined || b === undefined ? (a === undefined ? 1 : 0) - (b === undefined ? 1 : 0) : (a - b) * sign;
  keyed.sort((a, b) => a.rank - b.rank
    || (options.sort === "name" ? collator.compare(a.name, b.name) || a.pc - b.pc : a.pc - b.pc || bySeq(a.seq, b.seq, options.sort === "wait" ? 1 : -1))
    || a.index - b.index);
  const rank = new Map(keyed.map((entry) => [entry.row, entry.rank]));
  const nested = nestRows(keyed.map((entry) => entry.row), keyOf, ({ machine, entry }) => entry.pane.parent_pane_id === undefined ? undefined : sidebarPinKey(machine.id, entry.pane.parent_pane_id));
  // the first row of a family is where its most urgent member stood: the family takes that row's group
  const byKey = new Map(nested.map((row) => [keyOf(row), row]));
  const groups: { group: AgentGroup; rows: AgentRow[] }[] = [];
  let familyRank = -1;
  const placed = new Set<AgentRow>();
  for (const row of nested) {
    const parentId = row.entry.pane.parent_pane_id;
    const parent = parentId === undefined || parentId === row.entry.pane.pane_id ? undefined : byKey.get(sidebarPinKey(row.machine.id, parentId));
    // a helper follows the row it is nested under; any other row opens a family
    if (parent === undefined || !placed.has(parent)) familyRank = Math.min(...familyRows(nested, row, byKey).map((member) => rank.get(member)!));
    placed.add(row);
    const group = AGENT_GROUPS[familyRank]!;
    const last = groups.at(-1);
    if (last?.group === group) last.rows.push(row);
    else groups.push({ group, rows: [row] });
  }
  return groups;
}

/** a family's rows as nestRows laid them: the row and the rows after it nested under it */
function familyRows(nested: readonly AgentRow[], start: AgentRow, byKey: ReadonlyMap<string, AgentRow>): AgentRow[] {
  const members = new Set<AgentRow>([start]);
  for (let index = nested.indexOf(start) + 1; index < nested.length; index++) {
    const row = nested[index]!;
    const parentId = row.entry.pane.parent_pane_id;
    const parent = parentId === undefined ? undefined : byKey.get(sidebarPinKey(row.machine.id, parentId));
    if (parent === undefined || !members.has(parent)) break;
    members.add(row);
  }
  return [...members];
}
