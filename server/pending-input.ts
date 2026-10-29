import type { AgentStatus, PendingMessage } from "../shared/protocol.ts";
import { submitNotTyped } from "../shared/submit-outcome.ts";

export interface PendingIdentity {
  agent: string | null;
  terminalId: string;
  session: string | null;
  processPid?: number | null;
  processBirth?: number | null;
  omoSession?: string | null;
  /** the session Claude's PID record names: it changes with /clear and /resume in the same process, hook or not */
  claudeSession?: string | null;
}

/** An identity learned after enqueue is not a replacement; only mutually known parts disagree. */
export function samePendingIdentity(before: PendingIdentity, after: PendingIdentity, platform: NodeJS.Platform = process.platform): boolean {
  const changed = <T>(a: T | null | undefined, b: T | null | undefined) => a != null && b != null && a !== b;
  return before.agent === after.agent && before.terminalId === after.terminalId
    && !changed(before.session, after.session) && !changed(before.omoSession, after.omoSession)
    && !changed(before.claudeSession, after.claudeSession)
    && !changed(before.processPid, after.processPid)
    // macOS allows a second: its birth was once read from `ps`'s whole elapsed seconds, now from the kernel exactly.
    && (before.processBirth == null || after.processBirth == null
      || (platform === "darwin" ? Math.abs(before.processBirth - after.processBirth) <= 1000 : before.processBirth === after.processBirth));
}
export interface PendingRecord<Owner, Lease> {
  owner: Owner;
  paneId: string;
  lease: Lease;
  identity: PendingIdentity;
  message: PendingMessage;
  inFlight: boolean;
}
type Fault = { code: string; message: string };
interface HeldCopyReply { ok: boolean; code?: string; message?: string }
type Removed = { id: string; outcome: "sent" | "discarded" | "dismissed" };
/** `by`: the message whose send opened the gate */
interface TurnGate { by: string; committed: boolean; sawWorking: boolean; completed: boolean; deadline: number | null; restart?: "interruption" | "working" }
const ready = (status: AgentStatus | undefined) => status === "idle" || status === "done";
export const PENDING_START_TIMEOUT_MS = 10_000;
export const MAX_PENDING_PER_OWNER = 32;
/** an owner whose messages are counted per pane (`perPane`): one pane's never fill the list for the others */
export const MAX_PENDING_PER_PANE = 1;
const MAX_PENDING_TOTAL = 256;
const MAX_PENDING_DISPOSITIONS = 1024;
const MAX_PENDING_CHARS = 20_000;
const CLOSED_RETENTION_MS = 60_000;

export class PendingInputError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}

/** One authoritative record per message. Both automatic sends and explicit steering claim it here. */
export class PendingInputs<Owner, Lease> {
  private readonly records = new Map<string, PendingRecord<Owner, Lease>>();
  private readonly statuses = new Map<string, AgentStatus>();
  /** how many status events each pane has had: orders a snapshot read against them (mark, observe) */
  private readonly events = new Map<string, number>();
  private readonly gates = new Map<string, TurnGate>();
  private readonly closed = new Map<Owner, number>();
  private readonly removed = new Map<string, { owner: Owner; paneId: string; outcome: Removed["outcome"]; at: number }>();
  private readonly resends = new Map<string, { id: string; paneId: string; fingerprint: string; reply: Promise<HeldCopyReply>; settledAt: number | null; uncertain: boolean }>();

  constructor(
    private readonly changed: (owner: Owner, paneId: string, messages: PendingMessage[], removed?: Removed[]) => void,
    private readonly now: () => number = Date.now,
    private readonly startTimeoutMs = PENDING_START_TIMEOUT_MS,
    private readonly newId: () => string = () => crypto.randomUUID(),
    /** an owner that may hold MAX_PENDING_PER_PANE messages in each pane rather than MAX_PENDING_PER_OWNER in all */
    private readonly perPane: (owner: Owner) => boolean = () => false,
  ) {}

  /**
   * Cross-connection held copies share one outcome; never evict an in-flight send.
   * `ambiguous`: which failed reply may have typed input. A saved copy's resend from another
   * connection only has the client's conservative list; the owner's own Send now knows the
   * dispatch's real answer, where only `submit_changed` means input may have arrived.
   */
  resend(paneId: string, id: string, fingerprint: string, task: () => Promise<HeldCopyReply>, generation = 0,
    ambiguous: (code: string) => boolean = (code) => !submitNotTyped(code)): Promise<HeldCopyReply> {
    const key = JSON.stringify([paneId, id, generation]);
    this.expireResends();
    // Withdrawal covers the stable ID, not just one retry generation, while its
    // bounded disposition is retained. After eviction or a bridge restart, a saved
    // copy that missed the removal can be resent: offline recovery deliberately
    // remains available rather than refusing every unknown ID.
    const outcome = this.removed.get(id);
    if (outcome?.paneId === paneId && outcome.outcome === "discarded") {
      return Promise.resolve({ ok: false, code: "pending_discarded", message: "This pending message was withdrawn" });
    }
    const previous = this.resends.get(key);
    if (previous) {
      if (previous.fingerprint !== fingerprint) throw new PendingInputError("invalid_submit_id", "This resend id already belongs to another message");
    }
    if (outcome?.paneId === paneId && outcome.outcome === "dismissed"
      || this.records.get(id)?.paneId === paneId && this.records.get(id)?.message.state === "uncertain"
      || [...this.resends.values()].some((entry) => entry.id === id && entry.paneId === paneId && entry.uncertain)) {
      return Promise.resolve({ ok: false, code: "pending_uncertain", message: "Check the terminal before sending this message again" });
    }
    if (outcome?.paneId === paneId) return Promise.resolve({ ok: true });
    if (previous) return previous.reply;
    if (this.resends.size >= MAX_PENDING_TOTAL) throw new PendingInputError("pending_limit", "Too many held-copy sends are still retained; try again later");
    const entry: { id: string; paneId: string; fingerprint: string; settledAt: number | null; uncertain: boolean; reply: Promise<HeldCopyReply> } = {
      id, paneId, fingerprint, settledAt: null, uncertain: false,
      reply: Promise.resolve().then(task).then((reply) => {
        entry.uncertain = !reply.ok && ambiguous(reply.code ?? ""); entry.settledAt = this.now();
        const item = this.records.get(id);
        if (reply.ok && item?.paneId === paneId) this.finish(item, "sent");
        else if (entry.uncertain && item?.paneId === paneId) {
          // Another connection may have committed input. An Edit already waiting
          // on its discard must see this uncertainty before it can withdraw.
          item.message.state = "uncertain";
          item.message.error = { code: reply.code ?? "pending_uncertain", message: reply.message ?? "Check the terminal before sending this message again" };
          this.gates.delete(paneId);
          this.holdPane(paneId, item.message.error);
          this.publish(item.owner, paneId);
        }
        return reply;
      }, (error) => { entry.settledAt = this.now(); throw error; }),
    };
    this.resends.set(key, entry);
    return entry.reply;
  }

  private expireResends(): void {
    for (const [key, entry] of this.resends) {
      if (entry.settledAt !== null && !(entry.uncertain && this.records.has(entry.id)) && this.now() - entry.settledAt >= CLOSED_RETENTION_MS) this.resends.delete(key);
    }
  }

  list(owner: Owner, paneId: string): PendingMessage[] {
    return [...this.records.values()].filter((item) => item.owner === owner && item.paneId === paneId).map((item) => ({ ...item.message, ...(item.message.error ? { error: { ...item.message.error } } : {}) }));
  }

  private publish(owner: Owner, paneId: string, removed?: Removed[]): void { this.changed(owner, paneId, this.list(owner, paneId), removed); }

  private finish(item: PendingRecord<Owner, Lease>, outcome: Removed["outcome"]): void {
    this.records.delete(item.message.id);
    this.removed.set(item.message.id, { owner: item.owner, paneId: item.paneId, outcome, at: this.now() });
    this.publish(item.owner, item.paneId, [{ id: item.message.id, outcome }]);
  }

  outcome(owner: Owner, paneId: string, id: string): Removed["outcome"] | undefined {
    const receipt = this.removed.get(id);
    return receipt?.owner === owner && receipt.paneId === paneId ? receipt.outcome : undefined;
  }

  /** `held`: the message waits for an explicit send; `next` never offers it to automatic delivery. */
  /** `agentOnly`: for an agent alone (shared/protocol.ts submit `agent_only`); the caller has seen an agent in `identity` */
  enqueue(owner: Owner, paneId: string, requestId: number, text: string, lease: Lease, identity: PendingIdentity, held = false, agentOnly = false): PendingRecord<Owner, Lease> {
    const previous = [...this.records.values()].find((item) => item.owner === owner && item.message.request_id === requestId);
    if (previous) {
      if (previous.paneId !== paneId || previous.message.text !== text) throw new PendingInputError("invalid_submit_id", "This submit id already belongs to another message");
      return previous;
    }
    if (!text.trim() || text.length > MAX_PENDING_CHARS) throw new PendingInputError("invalid_submit_text", "A pending message must contain text and be at most 20000 characters");
    const perPane = this.perPane(owner);
    const own = [...this.records.values()].filter((item) => item.owner === owner && (!perPane || item.paneId === paneId)).length;
    if (this.records.size >= MAX_PENDING_TOTAL || own >= (perPane ? MAX_PENDING_PER_PANE : MAX_PENDING_PER_OWNER)) {
      throw new PendingInputError("pending_limit", "The pending-message list is full; send or discard a message first");
    }
    // Reserve the eventual disposition before accepting text. Recent withdrawals
    // live at least as long as resend receipts, even under cap pressure; settling
    // an accepted message can never run out of room or evict a recent withdrawal.
    for (const [id, receipt] of this.removed) {
      if (this.records.size + this.removed.size < MAX_PENDING_DISPOSITIONS) break;
      if (this.now() - receipt.at >= CLOSED_RETENTION_MS) this.removed.delete(id);
    }
    if (this.records.size + this.removed.size >= MAX_PENDING_DISPOSITIONS) {
      throw new PendingInputError("pending_limit", "Too many recent pending-message outcomes are retained; try again later");
    }
    if ([...this.records.values()].some((item) => item.paneId === paneId && item.message.state === "uncertain")) throw new PendingInputError("pending_uncertain", "Check the terminal before sending more pending messages");
    const item: PendingRecord<Owner, Lease> = {
      owner, paneId, lease, identity, inFlight: false,
      message: { id: this.newId(), request_id: requestId, text, state: held ? "held" : "queued", created_at: new Date(this.now()).toISOString(), ...(agentOnly ? { agent_only: true as const } : {}) },
    };
    this.records.set(item.message.id, item);
    this.publish(owner, paneId);
    return item;
  }

  get(owner: Owner, paneId: string, id: string): PendingRecord<Owner, Lease> | undefined {
    const item = this.records.get(id);
    return item?.owner === owner && item.paneId === paneId ? item : undefined;
  }

  retains(owner: Owner, id: string): boolean { return this.records.get(id)?.owner === owner; }

  /** The pending message `id`, still held here, was accepted for an agent alone: a saved copy's resend keeps that whatever it says. */
  agentOnly(paneId: string, id: string): boolean { const item = this.records.get(id); return item?.paneId === paneId && item.message.agent_only === true; }

  next(paneId: string): PendingRecord<Owner, Lease> | null {
    if (!ready(this.statuses.get(paneId)) || this.gates.has(paneId)
      || [...this.records.values()].some((item) => item.paneId === paneId && (item.inFlight || item.message.state === "uncertain"))) return null;
    return [...this.records.values()].find((item) => item.paneId === paneId && item.message.state === "queued") ?? null;
  }

  claim(item: PendingRecord<Owner, Lease>, automatic: boolean): boolean {
    if (this.records.get(item.message.id) !== item || item.inFlight || item.message.state === "uncertain"
      || [...this.records.values()].some((other) => other.paneId === item.paneId && other.inFlight)
      || (automatic ? this.next(item.paneId) !== item : !["queued", "held"].includes(item.message.state))) return false;
    item.message.state = "sending"; delete item.message.error; item.inFlight = true;
    // An explicit send can start while an earlier send's turn is not confirmed yet. That gate keeps
    // watching the turn until this message commits its own key: a refusal before it frees nothing.
    if (!this.gates.get(item.paneId)?.committed) this.gates.set(item.paneId, { by: item.message.id, committed: false, sawWorking: false, completed: false, deadline: null });
    this.publish(item.owner, item.paneId);
    return true;
  }

  /** Status cycles before the committing key belong to earlier work, never this submission. */
  committing(item: PendingRecord<Owner, Lease>, steeringWorkingTurn = false, restartingWorkingTurn = false): void {
    if (this.records.get(item.message.id) !== item || !item.inFlight) return;
    this.gates.set(item.paneId, { by: item.message.id, committed: true, sawWorking: steeringWorkingTurn && !restartingWorkingTurn, completed: false,
      deadline: steeringWorkingTurn && !restartingWorkingTurn ? null : this.now() + this.startTimeoutMs,
      ...(restartingWorkingTurn ? { restart: "interruption" as const } : {}),
    });
  }

  settle(item: PendingRecord<Owner, Lease>, fault?: Fault, uncertain = false, retryWhenReady = false): void {
    if (this.records.get(item.message.id) !== item || !item.inFlight) return;
    item.inFlight = false;
    if (!fault) {
      this.finish(item, "sent");
      const gate = this.gates.get(item.paneId);
      if (gate?.completed || (gate?.by === item.message.id && !gate.committed)) this.gates.delete(item.paneId);
      return;
    }
    item.message.state = uncertain ? "uncertain" : retryWhenReady ? "queued" : "held";
    if (retryWhenReady && !uncertain) delete item.message.error; else item.message.error = fault;
    const gate = this.gates.get(item.paneId);
    if (uncertain || gate?.by === item.message.id || gate?.completed) this.gates.delete(item.paneId);
    if (uncertain) this.holdPane(item.paneId, fault);
    this.publish(item.owner, item.paneId);
  }

  discard(item: PendingRecord<Owner, Lease>, withdrawalOnly = false): boolean {
    if (this.records.get(item.message.id) !== item || item.inFlight
      || withdrawalOnly && item.message.state !== "queued" && item.message.state !== "held"
      || [...this.resends.values()].some((entry) => entry.id === item.message.id && entry.settledAt === null)) return false;
    // Dismissing potentially delivered text is not proof of withdrawal. In
    // particular, a racing Edit listener must never restore it into the draft.
    this.finish(item, item.message.state === "uncertain" ? "dismissed" : "discarded");
    return true;
  }

  /** The pane's status events so far. A snapshot read after this point is applied with it (observe). */
  mark(paneId: string): number { return this.events.get(paneId) ?? 0; }

  /** The pane's last applied status, from an event or an observed snapshot. */
  current(paneId: string): AgentStatus | undefined { return this.statuses.get(paneId); }

  /** A status event from the collector. */
  status(paneId: string, status: AgentStatus): void {
    this.events.set(paneId, this.mark(paneId) + 1);
    this.apply(paneId, status);
  }

  /** A status read from a snapshot taken after `mark`: an event that came since is newer, and stands. */
  observe(paneId: string, status: AgentStatus, mark: number): void {
    if (this.mark(paneId) === mark) this.apply(paneId, status);
  }

  /** Whether a message of any connection still waits its turn on the pane. */
  waiting(paneId: string): boolean {
    return [...this.records.values()].some((item) => item.paneId === paneId && (item.inFlight || item.message.state === "queued"));
  }

  /** The pane ended: its held messages stay with their owners, its status and turn gate go. */
  forget(paneId: string): void { this.statuses.delete(paneId); this.events.delete(paneId); this.gates.delete(paneId); }

  private apply(paneId: string, status: AgentStatus): void {
    this.statuses.set(paneId, status);
    const gate = this.gates.get(paneId);
    if (!gate?.committed) return;
    // Escape may expose ready before the submitted steering starts its replacement turn.
    // Neither that readiness nor another old-working snapshot can drain the next message.
    if (gate.restart === "interruption") {
      if (ready(status)) gate.restart = "working";
      return;
    }
    if (gate.restart === "working") {
      if (status !== "working") return;
      delete gate.restart;
    }
    if (status === "working") { gate.sawWorking = true; gate.deadline = null; }
    if (ready(status) && gate.sawWorking) {
      gate.completed = true;
      if (![...this.records.values()].some((item) => item.paneId === paneId && item.inFlight)) this.gates.delete(paneId);
    }
  }

  hold(owner: Owner, paneId?: string, fault: Fault = { code: "pending_lease_lost", message: "The pane connection changed; send this message explicitly after reviewing it" }): void {
    const panes = new Set<string>();
    for (const item of this.records.values()) {
      if (item.owner !== owner || (paneId !== undefined && item.paneId !== paneId)) continue;
      if (item.message.state === "queued" || item.inFlight) {
        item.message.state = item.inFlight ? "uncertain" : "held"; item.message.error = fault;
        panes.add(item.paneId);
      }
    }
    for (const pane of panes) this.publish(owner, pane);
  }

  /** One waiting message held for an explicit send; one on its way is left to its send's own end. */
  holdItem(item: PendingRecord<Owner, Lease>, fault: Fault): void {
    if (this.records.get(item.message.id) !== item || item.inFlight || item.message.state !== "queued") return;
    item.message.state = "held"; item.message.error = fault;
    this.publish(item.owner, item.paneId);
  }

  /** A held message's reason, told anew when what holds it changed; a message not held is left alone. */
  rehold(item: PendingRecord<Owner, Lease>, fault: Fault): void {
    if (this.records.get(item.message.id) !== item || item.inFlight || item.message.state !== "held" || item.message.error?.code === fault.code) return;
    item.message.error = fault;
    this.publish(item.owner, item.paneId);
  }

  holdPane(paneId: string, fault: Fault): void {
    for (const owner of new Set([...this.records.values()].filter((item) => item.paneId === paneId).map((item) => item.owner))) this.hold(owner, paneId, fault);
  }

  close(owner: Owner): void { this.hold(owner); this.closed.set(owner, this.now()); }

  expire(): void {
    this.expireResends();
    for (const [paneId, gate] of this.gates) {
      if (gate.deadline !== null && this.now() >= gate.deadline && ![...this.records.values()].some((item) => item.paneId === paneId && item.inFlight)) {
        this.holdPane(paneId, { code: "pending_turn_unconfirmed", message: "The next turn did not start in time; review and send the remaining messages explicitly" });
        this.gates.delete(paneId);
      }
    }
    for (const [owner, closedAt] of this.closed) if (this.now() - closedAt >= CLOSED_RETENTION_MS) {
      for (const [id, item] of this.records) if (item.owner === owner && !item.inFlight) {
        if (item.message.state === "uncertain") this.finish(item, "dismissed");
        else this.records.delete(id);
      }
      if (![...this.records.values()].some((item) => item.owner === owner)) {
        this.closed.delete(owner);
        // Keep the bounded disposition history after its owner closes too: another
        // connection may still carry this ID in a saved held copy.
      }
    }
  }
}
