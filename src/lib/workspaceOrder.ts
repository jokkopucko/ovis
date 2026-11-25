import type { WorkspaceMoved } from "../../shared/protocol.ts";
import { isBackgroundRole, ROLE_TOKEN } from "../../shared/pane-tokens.ts";
import { movedTabOrder } from "./tabOrder.ts";
export { worktreeGroups } from "../../shared/worktree-groups.ts";

/**
 * One herdr `workspace.move`. Like `tab.move`, its `insert_index` counts insertion boundaries
 * before the workspace is taken out, and it moves only the workspace it names: a repository's
 * worktree workspaces stay where they were (live-verified, herdr 0.9.3).
 */
export interface WorkspaceMove {
  workspaceId: string;
  insertIndex: number;
}

export function workspaceMoves(current: readonly string[], next: readonly string[]): WorkspaceMove[] {
  const position = new Map(current.map((id, index) => [id, index]));
  const ranks = next.map((id) => position.get(id) ?? -1);
  const runLength = ranks.map(() => 1);
  const before = ranks.map(() => -1);
  let end = -1;
  for (let i = 0; i < ranks.length; i++) {
    for (let j = 0; j < i; j++) {
      if (ranks[j]! < ranks[i]! && runLength[j]! + 1 > runLength[i]!) { runLength[i] = runLength[j]! + 1; before[i] = j; }
    }
    if (end < 0 || runLength[i]! > runLength[end]!) end = i;
  }
  const kept = new Set<string>();
  for (let i = end; i >= 0; i = before[i]!) kept.add(next[i]!);
  let order = [...current];
  const moves: WorkspaceMove[] = [];
  next.forEach((id, index) => {
    if (kept.has(id)) return;
    const insertIndex = index === 0 ? 0 : order.indexOf(next[index - 1]!) + 1;
    const moved = movedTabOrder(order, id, insertIndex);
    if (!moved) return;
    moves.push({ workspaceId: id, insertIndex });
    order = moved;
  });
  return moves;
}

/**
 * A workspace a launcher tagged `role=background` (`herdr workspace report-metadata --token`, any case),
 * as a pane is tagged for the Agents list's background part (shared/pane-tokens.ts). herdr's fact, never a guess.
 */
export function isBackgroundWorkspace(workspace: { tokens?: Record<string, unknown> }): boolean {
  return isBackgroundRole(workspace.tokens?.[ROLE_TOKEN]);
}

export function splitBackgroundGroups<G extends { workspace: { workspace_id: string; tokens?: Record<string, unknown> } }>(groups: readonly G[], worktreeIds: ReadonlySet<string> = new Set()): { people: G[]; background: G[] } {
  const background = (group: G): boolean => isBackgroundWorkspace(group.workspace) && !worktreeIds.has(group.workspace.workspace_id);
  return { people: groups.filter((group) => !background(group)), background: groups.filter(background) };
}

export function mergeOrder(base: readonly string[], ids: readonly string[]): string[] {
  const live = new Set(ids);
  const kept = base.filter((id) => live.has(id));
  const known = new Set(kept);
  return [...kept, ...ids.filter((id) => !known.has(id))];
}

export interface OrderRosterEntry {
  id: string;
  snapshot: { workspaces: readonly { workspace_id: string }[]; order_epoch?: string; read_seq?: number } | null;
}
export type RosterSource = { kind: "load"; started: number } | { kind: "event" };
export type SourceProofQuery = (machineId: string, signal: AbortSignal) => Promise<{ machines: OrderRosterEntry[]; boot_id: string } | null>;

interface Evidence { epoch: string; seq: number }
interface OrderRead { ids: string[]; evidence: Evidence | null }
const evidenceOf = (snapshot: OrderRosterEntry["snapshot"]): Evidence | null =>
  snapshot && typeof snapshot.order_epoch === "string" && snapshot.order_epoch !== "" && Number.isSafeInteger(snapshot.read_seq) && snapshot.read_seq! >= 0
    ? { epoch: snapshot.order_epoch, seq: snapshot.read_seq! } : null;

interface Hold {
  epoch: string | null;
  receipts: number;
  legacy: boolean;
  settleMark: number | null;
  /** the last roster's evidence when the newest move with a receipt since the hold last settled was sent; undefined until one */
  sent?: Evidence | null;
  inFlight?: Evidence | null;
  /** Keep a possible restart read even if the old boot sends another roster before recovery. */
  restart?: OrderRead;
  /** A recovered batch can have a different set of workspaces from what later drags saw. */
  rebased?: string[];
}
interface PcOrder {
  shown: string[] | null;
  last: OrderRead | null;
  generation: number;
  pending: Set<number>;
  desired: string[] | null;
  hold: Hold | null;
  floors: Map<string, number>;
  protectedEpoch: string | null;
  guard: { epoch: string; version: number } | null;
  retired: Set<string>;
  receipts: number;
  chain: Promise<void>;
  failed: boolean;
  waiters: { generation: number; resolve: (ids: string[]) => void; reject: (error: Error) => void }[];
  gone: boolean;
  check: { key: string; abort: AbortController; candidate: OrderRead | null; updated: boolean } | null;
  /** the server lifetime the last answered verification was asked about: asking again would spend the PC's interval for nothing */
  answered: string | null;
}

export class ReorderCoordinator {
  private pcs = new Map<string, PcOrder>();
  private listeners = new Set<() => void>();
  private changes = 0;
  private loads = 0;

  constructor(private options: { verify?: SourceProofQuery; onSettled?: (machineId: string) => void } = {}) {}

  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  version = (): number => this.changes;
  private notify(): void { this.changes++; for (const listener of this.listeners) listener(); }
  private pc(id: string): PcOrder {
    let pc = this.pcs.get(id);
    if (!pc) {
      pc = { shown: null, last: null, generation: 0, pending: new Set(), desired: null, hold: null, floors: new Map(), protectedEpoch: null, guard: null, retired: new Set(), receipts: 0, chain: Promise.resolve(), failed: false, waiters: [], gone: false, check: null, answered: null };
      this.pcs.set(id, pc);
    }
    return pc;
  }

  loadStarted(): number { return ++this.loads; }

  order(machineId: string, ids: readonly string[]): string[] {
    const pc = this.pcs.get(machineId);
    const base = pc?.hold ? pc.desired ?? pc.shown : pc?.shown;
    return base ? mergeOrder(base, ids) : [...ids];
  }

  state(machineId: string) {
    const pc = this.pcs.get(machineId);
    return { pending: pc?.pending.size ?? 0, held: !!pc?.hold, floors: Object.fromEntries(pc?.floors ?? []), guard: pc?.guard ?? null, retired: [...pc?.retired ?? []], checking: !!pc?.check };
  }

  roster(entries: readonly OrderRosterEntry[], source: RosterSource): void {
    const listed = new Set(entries.map((entry) => entry.id));
    for (const [id, pc] of this.pcs) {
      if (listed.has(id)) pc.gone = false;
      else this.depart(pc);
    }
    for (const entry of entries) if (entry.snapshot) this.full(entry.id, entry.snapshot, source);
    this.notify();
  }

  private depart(pc: PcOrder): void {
    if (pc.gone) return;
    pc.gone = true;
    this.invalidateCheck(pc);
    if (pc.hold) pc.hold.restart = undefined;
    for (const waiter of pc.waiters.splice(0)) { pc.pending.delete(waiter.generation); waiter.reject(new Error("This PC was removed")); }
    if (pc.pending.size === 0) { pc.hold = null; pc.desired = null; }
  }

  private qualifies(pc: PcOrder, evidence: Evidence | null): boolean {
    if (pc.protectedEpoch === null) return true;
    return !!evidence && evidence.epoch === pc.protectedEpoch && evidence.seq >= (pc.floors.get(evidence.epoch) ?? 0);
  }

  private full(id: string, snapshot: NonNullable<OrderRosterEntry["snapshot"]>, source: RosterSource): void {
    const pc = this.pc(id);
    const ids = snapshot.workspaces.map((workspace) => workspace.workspace_id);
    const evidence = evidenceOf(snapshot);
    if (evidence && pc.retired.has(evidence.epoch)) return;
    if (evidence && pc.last?.evidence?.epoch === evidence.epoch && pc.last.evidence.seq > evidence.seq) return;
    const read = { ids, evidence };
    pc.last = read;
    const hold = pc.hold;
    if (hold && pc.pending.size > 0 && evidence && evidence.epoch !== (pc.protectedEpoch ?? hold.inFlight?.epoch)
      && (pc.protectedEpoch !== null || hold.inFlight !== undefined)) {
      const previous = hold.restart?.evidence;
      if (previous?.epoch !== evidence.epoch || previous.seq <= evidence.seq) hold.restart = read;
    }
    if (!pc.check && this.qualifies(pc, evidence)) for (const waiter of pc.waiters.splice(0)) waiter.resolve(ids);
    if (pc.pending.size > 0 || pc.hold) {
      if (pc.pending.size === 0 && this.releases(pc, evidence, source)) { pc.hold = null; pc.desired = null; pc.shown = ids; return; }
      if (this.qualifies(pc, evidence)) pc.shown = ids;
      else this.mismatch(id, pc, read);
      return;
    }
    if (pc.protectedEpoch === null || (evidence && evidence.epoch === pc.protectedEpoch)) {
      if (this.qualifies(pc, evidence)) pc.shown = ids;
      return;
    }
    this.mismatch(id, pc, read);
  }

  private releases(pc: PcOrder, evidence: Evidence | null, source: RosterSource): boolean {
    const hold = pc.hold!;
    if (hold.epoch === null && !hold.legacy) return false;
    if (hold.epoch !== null && !(evidence && evidence.epoch === hold.epoch && evidence.seq >= pc.floors.get(hold.epoch)!)) return false;
    return !hold.legacy || (hold.settleMark !== null && source.kind === "load" && source.started > hold.settleMark
      && (pc.protectedEpoch === null || this.qualifies(pc, evidence)));
  }

  private mismatch(id: string, pc: PcOrder, read: OrderRead): void {
    const { evidence } = read;
    const verify = this.options.verify;
    if (!verify || !evidence || pc.protectedEpoch === null || evidence.epoch === pc.protectedEpoch) return;
    const key = `${pc.receipts}:${pc.guard?.version ?? 0}:${pc.protectedEpoch}`;
    if (pc.check?.key === key) {
      const previous = pc.check.candidate?.evidence;
      if (previous?.epoch === evidence.epoch && evidence.seq >= previous.seq) {
        pc.check.candidate = read;
        pc.check.updated = true;
      }
      return;
    }
    pc.check?.abort.abort();
    const check = { key, abort: new AbortController(), candidate: read, updated: false };
    pc.check = check;
    const finish = (answer: Awaited<ReturnType<SourceProofQuery>>) => {
      if (pc.check !== check) return;
      pc.check = null;
      if (answer && !check.abort.signal.aborted) {
        pc.answered = evidence.epoch;
        this.proved(id, pc, answer, check.candidate, check.updated);
      }
      const cached = pc.last;
      for (const waiter of pc.waiters.splice(0)) {
        if (cached && this.qualifies(pc, cached.evidence)) waiter.resolve(cached.ids);
        else waiter.reject(new Error("Could not confirm the PC's workspace order"));
      }
    };
    void verify(id, check.abort.signal).then(finish, () => finish(null));
  }

  private invalidateCheck(pc: PcOrder): void {
    pc.check?.abort.abort();
    pc.check = null;
  }

  private proved(id: string, pc: PcOrder, answer: { machines: OrderRosterEntry[]; boot_id: string }, candidate: OrderRead | null, updated: boolean): void {
    const boot = answer.boot_id;
    const old = pc.protectedEpoch;
    if (old === null || pc.retired.has(boot)) return;
    if (boot !== old) {
      pc.retired.add(old);
      pc.floors.delete(old);
      if (pc.hold?.epoch === old) {
        if (pc.pending.size === 0) { pc.shown = pc.desired ?? pc.shown; pc.hold = null; pc.desired = null; }
        else pc.hold.epoch = null;
      }
      pc.guard = { epoch: boot, version: (pc.guard?.version ?? 0) + 1 };
      pc.protectedEpoch = boot;
    }
    const snapshot = answer.machines.find((machine) => machine.id === id)?.snapshot;
    const evidence = snapshot ? evidenceOf(snapshot) : null;
    const cached = pc.last?.evidence?.epoch === boot && (candidate?.evidence?.epoch !== boot || pc.last.evidence.seq > candidate.evidence.seq) ? pc.last : candidate;
    let chosen: OrderRead | null = snapshot && evidence?.epoch === boot
      ? { ids: snapshot.workspaces.map((workspace) => workspace.workspace_id), evidence } : null;
    if (cached?.evidence?.epoch === boot && (chosen
      ? (cached.evidence.seq > (evidence?.seq ?? -1) || (updated && cached.evidence.seq === evidence?.seq))
      : pc.waiters.length > 0)) chosen = cached;
    if (chosen && this.qualifies(pc, chosen.evidence)) {
      pc.shown = chosen.ids;
      pc.last = chosen;
      for (const waiter of pc.waiters.splice(0)) waiter.resolve(chosen.ids);
    }
    this.notify();
  }

  reorder(machineId: string, current: readonly string[], next: readonly string[], move: (step: WorkspaceMove) => Promise<WorkspaceMoved | void>): Promise<void> {
    if (workspaceMoves(current, next).length === 0) return Promise.resolve();
    const pc = this.pc(machineId);
    const generation = ++pc.generation;
    pc.pending.add(generation);
    pc.desired = [...next];
    if (pc.shown === null) pc.shown = [...current];
    if (pc.hold) pc.hold.settleMark = null;
    else pc.hold = { epoch: null, receipts: 0, legacy: false, settleMark: null };
    // A drag behind a parked batch cannot send a move until that batch has its recovery proof.
    if (pc.waiters.length === 0) {
      pc.receipts++;
      this.invalidateCheck(pc);
    }
    this.notify();
    const run = pc.chain.then(async () => {
      const recover = pc.failed || pc.hold?.rebased !== undefined;
      const base = pc.failed ? await this.qualifiedBase(machineId, pc, generation) : pc.hold?.rebased ?? [...current];
      pc.failed = false;
      const target = mergeOrder(next, base);
      for (const step of workspaceMoves(base, target)) {
        const sent = pc.last?.evidence ?? null;
        const hold = pc.hold;
        if (hold) hold.inFlight = sent;
        try {
          this.acknowledge(pc, await move(step), sent);
        } finally {
          if (hold) hold.inFlight = undefined;
        }
      }
      if (recover && pc.hold) pc.hold.rebased = target;
    });
    pc.chain = run.catch(() => { pc.failed = true; });
    return run.then(() => this.settle(machineId, pc, generation, null), (error: unknown) => this.settle(machineId, pc, generation, error));
  }

  private qualifiedBase(machineId: string, pc: PcOrder, generation: number): Promise<string[]> {
    if (pc.gone) return Promise.reject(new Error("This PC was removed"));
    const sent = pc.hold?.sent;
    if (sent !== undefined) this.recheck(machineId, pc, sent);
    if (!pc.check && pc.last && this.qualifies(pc, pc.last.evidence)) return Promise.resolve(pc.last.ids);
    return new Promise((resolve, reject) => {
      pc.waiters.push({ generation, resolve, reject });
    });
  }

  private acknowledge(pc: PcOrder, receipt: WorkspaceMoved | void, sent: Evidence | null): void {
    pc.receipts++;
    this.invalidateCheck(pc);
    const hold = pc.hold!;
    hold.receipts++;
    const epoch = receipt?.order_epoch;
    const seq = receipt?.moved_seq;
    if (typeof epoch !== "string" || epoch === "" || !Number.isSafeInteger(seq) || seq! < 1) { hold.legacy = true; return; }
    if (pc.retired.has(epoch)) return;
    pc.floors.set(epoch, Math.max(pc.floors.get(epoch) ?? 0, seq!));
    pc.protectedEpoch = epoch;
    hold.epoch = epoch;
    hold.sent = sent;
  }

  private settle(machineId: string, pc: PcOrder, generation: number, error: unknown): void {
    pc.pending.delete(generation);
    const latest = generation === pc.generation;
    if (error !== null && latest) pc.desired = null;
    const hold = pc.hold;
    if (pc.pending.size === 0 && hold) hold.rebased = undefined;
    if (pc.pending.size === 0 && hold && pc.gone) { pc.hold = null; pc.desired = null; }
    else if (pc.pending.size === 0 && hold) {
      if (hold.receipts === 0 || (hold.epoch === null && !hold.legacy)) {
        if (pc.desired) pc.shown = pc.desired;
        pc.hold = null; pc.desired = null;
      } else {
        hold.settleMark = this.loads;
        this.options.onSettled?.(machineId);
        const sent = hold.sent;
        hold.sent = undefined;
        if (sent !== undefined) this.recheck(machineId, pc, sent);
        hold.restart = undefined;
      }
    }
    this.notify();
    if (error !== null && latest) throw error;
  }

  /**
   * A roster that arrived while the moves were on their way was let through or had its check cut short by a later receipt.
   * Once they settle it is checked as one arriving now would be: one of another server lifetime may come from a restart
   * after a move. Not when it is of the server lifetime read when the newest move with a receipt was sent (no restart
   * since; also a repeated or delayed older read), nor of one a verification already answered about.
   */
  private recheck(machineId: string, pc: PcOrder, sent: Evidence | null): void {
    if (pc.check) return;
    const eligible = (read: OrderRead | null | undefined): read is OrderRead => {
      const evidence = read?.evidence;
      return !!evidence && !pc.retired.has(evidence.epoch) && evidence.epoch !== pc.protectedEpoch
        && evidence.epoch !== sent?.epoch && evidence.epoch !== pc.answered;
    };
    const restart = pc.hold?.restart;
    if (eligible(restart)) this.mismatch(machineId, pc, restart);
    else if (eligible(pc.last)) this.mismatch(machineId, pc, pc.last);
  }
}

export function placeBlock(order: readonly string[], block: readonly string[], around: readonly string[], side: "before" | "after"): string[] {
  const rest = order.filter((id) => !block.includes(id));
  const at = around.map((id) => rest.indexOf(id)).filter((index) => index >= 0);
  if (at.length === 0) return [...order];
  const edge = side === "before" ? Math.min(...at) : Math.max(...at) + 1;
  return [...rest.slice(0, edge), ...block, ...rest.slice(edge)];
}
