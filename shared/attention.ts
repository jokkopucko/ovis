/**
 * The rules that say which agent needs a look: the state a pane shows, one state for several panes,
 * the Agents list's groups and the orders inside them. Pure code, so the browser (src/lib/status.ts,
 * src/lib/agentRoster.ts, src/lib/sidebarOrder.ts), the server (server/herdr-core/snapshot.ts) and a
 * terminal screen draw the same rows in the same order.
 */
import type { AgentStatus, HerdrPane, PaneInfo, SessionSnapshot } from "./protocol.ts";

export type KnownStatus = "idle" | "working" | "blocked" | "done" | "waiting" | "unknown";

const KNOWN: Readonly<Record<string, KnownStatus>> = { idle: "idle", working: "working", blocked: "blocked", done: "done", waiting: "waiting" };

/** herdr's AgentStatus is open-ended; the UI knows its states and files the rest under unknown. */
export function knownStatus(status?: AgentStatus): KnownStatus {
  return (status !== undefined && KNOWN[status]) || "unknown";
}

/**
 * herdr's roll-up order, on its server (workspace aggregate) and in its sidebar: a blocked agent
 * colours the whole workspace, then one that finished and was not looked at yet, then a working one,
 * then one waiting on its turn's background work (working in all but name).
 */
const ROLLUP: readonly KnownStatus[] = ["blocked", "done", "working", "waiting", "idle"];

/**
 * One state for a row that stands for several panes, as herdr rolls a workspace's agents up:
 * blocked wins, then done, then working, then waiting on background work, then ready; unknown only
 * when no pane says more.
 */
export function rollupStatus(statuses: ReadonlyArray<AgentStatus | undefined>): KnownStatus {
  const known = statuses.map((status) => knownStatus(status));
  return ROLLUP.find((state) => known.includes(state)) ?? "unknown";
}

/**
 * The last turn a person looked at, shared by every Herdr client (herdr-app docs/labels.md): an
 * agent at rest whose turn is past it is done, one at or below it idle. Missing, the program's own
 * word stands, as it did before.
 */
export const SEEN_LABEL = "herdr.seen";

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
export function shownStatusOfWord(word: AgentStatus, turn: number | undefined, labels: Readonly<Record<string, string>> | undefined, firstTurn?: number): AgentStatus {
  if (word !== "idle" && word !== "done") return word;
  const seen = seenTurnOf(labels);
  if (seen !== null) return (turn ?? 0) > seen ? "done" : "idle";
  return firstTurn !== undefined && (turn ?? 0) > firstTurn ? "done" : word;
}

export function stateSeqs(snapshot: Pick<SessionSnapshot, "agents"> | null | undefined): Map<string, number> {
  const seqs = new Map<string, number>();
  for (const agent of snapshot?.agents ?? []) {
    const seq = agent.state_change_seq;
    if (seq !== undefined && Number.isFinite(seq)) seqs.set(agent.pane_id, seq);
  }
  return seqs;
}

/** Stand-ins date pushed statuses for ordering only. They never identify a finish. */
export interface SeqMemory { status: Map<string, unknown>; bumped: Map<string, number>; real: Map<string, number> }
export const newSeqMemory = (): SeqMemory => ({ status: new Map(), bumped: new Map(), real: new Map() });

export function liveSeqs(snapshot: Pick<SessionSnapshot, "agents" | "panes"> | null | undefined, memory: SeqMemory): Map<string, number> {
  const seqs = stateSeqs(snapshot);
  const panes = snapshot?.panes ?? [];
  // Recency only: legacy bridges have no finish_epoch, but a rollback invalidates stand-ins.
  // This never changes acknowledgement records or identifies a finish.
  if ([...seqs].some(([id, seq]) => seq < (memory.real.get(id) ?? seq))) memory.bumped.clear();
  let top = Math.max(0, ...seqs.values(), ...memory.bumped.values());
  for (const pane of panes) {
    const changed = memory.status.has(pane.pane_id) && memory.status.get(pane.pane_id) !== pane.agent_status;
    const real = seqs.get(pane.pane_id);
    const before = memory.real.get(pane.pane_id);
    if (changed && real !== undefined) {
      if (before !== undefined && real <= before) memory.bumped.set(pane.pane_id, top += 0.001);
      else memory.bumped.delete(pane.pane_id);
    }
    memory.status.set(pane.pane_id, pane.agent_status);
  }
  memory.real = new Map(seqs);
  const open = new Set(panes.map((pane) => pane.pane_id));
  if (panes.length > 0) for (const id of memory.status.keys()) if (!open.has(id)) memory.status.delete(id);
  for (const [id, bump] of memory.bumped) {
    const real = seqs.get(id);
    if (real === undefined || real > bump) memory.bumped.delete(id);
    else seqs.set(id, bump);
  }
  return seqs;
}

/** Blocked first, then herdr's latest state change, then the order given. */
export function activityOrder<T>(rows: readonly T[], paneOf: (row: T) => Pick<PaneInfo, "pane_id" | "agent_status">, seqs: ReadonlyMap<string, number>): T[] {
  return rows
    .map((row, index) => {
      const pane = paneOf(row);
      return { row, index, rank: knownStatus(pane.agent_status) === "blocked" ? 0 : 1, recent: seqs.get(pane.pane_id) ?? -1 };
    })
    .sort((a, b) => a.rank - b.rank || b.recent - a.recent || a.index - b.index)
    .map((entry) => entry.row);
}

export function sidebarPinKey(machineId: string, paneId: string): string {
  return `${machineId}:${paneId}`;
}

/** nestHelpers for rows of any shape, told apart by `idOf` and naming their agent's row by `parentIdOf` */
export function nestRows<T>(entries: readonly T[], idOf: (entry: T) => string, parentIdOf: (entry: T) => string | undefined): T[] {
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

/** Settings → Within a state: how each state group of the Agents list is ordered (lib/agentRoster.ts) */
export const AGENT_GROUP_SORTS = ["wait", "recent", "name"] as const;
export type AgentGroupSort = (typeof AGENT_GROUP_SORTS)[number];

/** A row the groups sort: its PC, by id, and its pane. */
export interface AttentionRow { machine: { id: string }; entry: { pane: Pick<HerdrPane, "pane_id" | "parent_pane_id"> } }

/** Settings → Group agents by state: the groups, in the order the list draws them */
export const AGENT_GROUPS = ["blocked", "working", "done", "idle"] as const;
export type AgentGroup = (typeof AGENT_GROUPS)[number];

/** The group a row's shown state files it under: BG works, a finish already read is ready, and a state nobody knows rests. */
export function agentGroup(status: AgentStatus | undefined): AgentGroup {
  const known = knownStatus(status);
  return known === "blocked" || known === "done" ? known : known === "working" || known === "waiting" ? "working" : "idle";
}

export interface AgentGroupOptions<R extends AttentionRow> {
  /** Settings → Within a state */
  sort: AgentGroupSort;
  /** the state the row draws (lib/sidebarActivity.tsx), undefined for a PC that is away */
  status(row: R): AgentStatus | undefined;
  /** the row's title, for the Name order */
  name(row: R): string;
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
export function groupAgentRows<R extends AttentionRow>(rows: readonly R[], options: AgentGroupOptions<R>): { group: AgentGroup; rows: R[] }[] {
  const machineIndex = new Map<string, number>();
  for (const { machine } of rows) if (!machineIndex.has(machine.id)) machineIndex.set(machine.id, machineIndex.size);
  const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
  const keyOf = ({ machine, entry }: R): string => sidebarPinKey(machine.id, entry.pane.pane_id);
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
  const groups: { group: AgentGroup; rows: R[] }[] = [];
  let familyRank = -1;
  const placed = new Set<R>();
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
function familyRows<R extends AttentionRow>(nested: readonly R[], start: R, byKey: ReadonlyMap<string, R>): R[] {
  const members = new Set<R>([start]);
  for (let index = nested.indexOf(start) + 1; index < nested.length; index++) {
    const row = nested[index]!;
    const parentId = row.entry.pane.parent_pane_id;
    const parent = parentId === undefined ? undefined : byKey.get(sidebarPinKey(row.machine.id, parentId));
    if (parent === undefined || !members.has(parent)) break;
    members.add(row);
  }
  return [...members];
}
