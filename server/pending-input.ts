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
  /** Pi's extension-verified file when the backend does not report the session. */
  piSession?: { readonly path: string; readonly fileIdentity: string | null };
}

/** Whether two reads of a process's start name the same process. macOS allows a second: its birth was once read from
 * `ps`'s whole elapsed seconds, now from the kernel exactly. */
export function sameProcessBirth(before: number, after: number, platform: NodeJS.Platform = process.platform): boolean {
  return platform === "darwin" ? Math.abs(before - after) <= 1000 : before === after;
}

/**
 * An identity learned after enqueue is not a replacement; only mutually known parts disagree. A known start of the same
 * PID that can no longer be read is no match either: the process may have ended and another taken its PID.
 */
export function samePendingIdentity(before: PendingIdentity, after: PendingIdentity, platform: NodeJS.Platform = process.platform): boolean {
  const changed = <T>(a: T | null | undefined, b: T | null | undefined) => a != null && b != null && a !== b;
  return before.agent === after.agent && before.terminalId === after.terminalId
    && !changed(before.session, after.session) && !changed(before.omoSession, after.omoSession)
    && !changed(before.claudeSession, after.claudeSession)
    && !changed(before.processPid, after.processPid)
    && (before.processBirth == null
      || (after.processBirth == null ? before.processPid == null || before.processPid !== after.processPid : sameProcessBirth(before.processBirth, after.processBirth, platform)));
}
/**
 * A create request's first message from the request on, while its workspace is made, its agent launched and herdr
 * asked before the message is listed (server/core/pending.ts askFirstMessage). `at` names the pane once it is known,
 * `end` ends the request.
 */
export interface FirstMessageAsk { at(paneId: string): void; end(): void }

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
type Removed = { id: string; outcome: "sent" | "discarded" | "consumed" | "dismissed" };
/**
 * `joined`: until then a ready status may be the end of the turn a Send now's Enter joined, or of one that ended just
 * before that Enter landed and started a turn of its own. `lenient`: such a ready came, and the wait is for that own
 * turn's start; one that never shows ends the wait without holding the queue, as the Enter joined the turn that ended.
 * `since`: when the Enter was committed.
 */
interface TurnGate { by: string; committed: boolean; sawWorking: boolean; completed: boolean; deadline: number | null; restart?: "interruption" | "working"; joined?: number; lenient?: true; since?: number }
const ready = (status: AgentStatus | undefined) => status === "idle" || status === "done";
export const PENDING_START_TIMEOUT_MS = 10_000;
export const MAX_PENDING_PER_OWNER = 32;
export const MAX_PENDING_PER_PANE = 1;
const MAX_PENDING_TOTAL = 256;
const MAX_PENDING_DISPOSITIONS = 1024;
const MAX_PENDING_CHARS = 20_000;
const CLOSED_RETENTION_MS = 60_000;

export class PendingInputError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}

const BEHIND_PASTE = { code: "pending_held", message: "An earlier message is in the terminal's input line; send this one after it is cleared or sent" };

export class PendingInputs<Owner, Lease> {
  private readonly records = new Map<string, PendingRecord<Owner, Lease>>();
  private readonly statuses = new Map<string, AgentStatus>();
  private readonly events = new Map<string, number>();
  private readonly gates = new Map<string, TurnGate>();
  /**
   * The panes whose queue waits for a turn's end the agent itself tells (awaitTurn), each with that turn's wait: nothing
   * herdr reads of the pane ends it.
   */
  private readonly turns = new Map<string, { gate: TurnGate }>();
  /** when a status of the pane was last taken, from an event or a read */
  private readonly readAt = new Map<string, number>();
  /**
   * what took the pane's last reading. A collector snapshot that ties it in the same millisecond is newer than an event
   * (the collector tells no snapshot with an event since it was asked) and than its own first pass, but not than a read
   * of the pane, whose order against it cannot be told
   */
  private readonly readBy = new Map<string, "event" | "read" | "snapshot">();
  private readonly waits = new Map<string, NonNullable<PendingMessage["waiting"]>>();
  private readonly closed = new Map<Owner, number>();
  private readonly movedInFlight = new WeakSet<PendingRecord<Owner, Lease>>();
  private readonly reviewOnly = new WeakSet<PendingRecord<Owner, Lease>>();
  private readonly removed = new Map<string, { owner: Owner; paneId: string; outcome: Removed["outcome"]; at: number }>();
  private readonly resends = new Map<string, { id: string; paneId: string; fingerprint: string; reply: Promise<HeldCopyReply>; settledAt: number | null; uncertain: boolean }>();

  constructor(
    private readonly changed: (owner: Owner, paneId: string, messages: PendingMessage[], removed?: Removed[]) => void,
    private readonly now: () => number = Date.now,
    private readonly startTimeoutMs = PENDING_START_TIMEOUT_MS,
    private readonly newId: () => string = () => crypto.randomUUID(),
    private readonly perPane: (owner: Owner) => boolean = () => false,
    elapsed?: () => number,
  ) {
    // How long a record is kept (a resend's, a withdrawal's, a closed owner's) runs on a clock that only moves
    // forward: the PC's clock set forward must not end a guard early, and set back must not stretch it. A caller
    // that gives a clock of its own (a test) times both by it.
    this.elapsed = elapsed ?? (now === Date.now ? () => performance.now() : now);
  }
  private readonly elapsed: () => number;

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
    if (outcome?.paneId === paneId && outcome.outcome === "consumed") return Promise.resolve({ ok: true });
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
        entry.uncertain = !reply.ok && ambiguous(reply.code ?? ""); entry.settledAt = this.elapsed();
        const item = this.records.get(id);
        const paneId = entry.paneId;
        if (reply.ok && item?.paneId === paneId) this.finish(item, "sent");
        else if (entry.uncertain && item?.paneId === paneId && !this.reviewOnly.has(item)) {
          // Another connection may have committed input. An Edit already waiting
          // on its discard must see this uncertainty before it can withdraw.
          item.message.state = "uncertain";
          item.message.error = { code: reply.code ?? "pending_uncertain", message: reply.message ?? "Check the terminal before sending this message again" };
          if (this.gates.get(paneId)?.completed) this.gates.delete(paneId);
          this.holdPane(paneId, item.message.error);
          this.publish(item.owner, paneId);
        }
        return reply;
      }, (error) => { entry.settledAt = this.elapsed(); throw error; }),
    };
    this.resends.set(key, entry);
    return entry.reply;
  }

  private expireResends(): void {
    for (const [key, entry] of this.resends) {
      if (entry.settledAt !== null && !(entry.uncertain && this.records.has(entry.id)) && this.elapsed() - entry.settledAt >= CLOSED_RETENTION_MS) this.resends.delete(key);
    }
  }

  list(owner: Owner, paneId: string): PendingMessage[] {
    const waiting = this.waits.get(paneId);
    return [...this.records.values()].filter((item) => item.owner === owner && item.paneId === paneId).map((item) => ({ ...item.message, ...(item.message.error ? { error: { ...item.message.error } } : {}),
      ...(waiting !== undefined && item.message.state === "queued" ? { waiting } : {}) }));
  }

  waitingFor(paneId: string, waiting: PendingMessage["waiting"]): void {
    if (this.waits.get(paneId) === waiting) return;
    if (waiting === undefined) this.waits.delete(paneId); else this.waits.set(paneId, waiting);
    for (const owner of new Set([...this.records.values()].filter((item) => item.paneId === paneId && item.message.state === "queued").map((item) => item.owner))) this.publish(owner, paneId);
  }

  sendingWaitsFor(item: PendingRecord<Owner, Lease>, waiting: PendingMessage["waiting"]): void {
    if (this.records.get(item.message.id) !== item || item.message.waiting === waiting) return;
    if (waiting === undefined) delete item.message.waiting; else item.message.waiting = waiting;
    this.publish(item.owner, item.paneId);
  }

  holdQueued(paneId: string, fault: Fault): void {
    const owners = new Set<Owner>();
    for (const item of this.records.values()) {
      if (item.paneId !== paneId || item.inFlight || item.message.state !== "queued") continue;
      item.message.state = "held"; item.message.error = fault;
      owners.add(item.owner);
    }
    for (const owner of owners) this.publish(owner, paneId);
  }

  private publish(owner: Owner, paneId: string, removed?: Removed[]): void { this.changed(owner, paneId, this.list(owner, paneId), removed); }

  private finish(item: PendingRecord<Owner, Lease>, outcome: Removed["outcome"]): void {
    this.records.delete(item.message.id);
    this.removed.set(item.message.id, { owner: item.owner, paneId: item.paneId, outcome, at: this.elapsed() });
    this.publish(item.owner, item.paneId, [{ id: item.message.id, outcome }]);
  }

  outcome(owner: Owner, paneId: string, id: string): Removed["outcome"] | undefined {
    const receipt = this.removed.get(id);
    return receipt?.owner === owner && receipt.paneId === paneId ? receipt.outcome : undefined;
  }

  /** `held`: the message waits for an explicit send; `next` never offers it to automatic delivery. */
  /** `agentOnly`: for an agent alone (shared/protocol.ts submit `agent_only`); the caller has seen an agent in `identity` */
  /** `fault`: held from the start for this reason, told with the message's first listing */
  enqueue(owner: Owner, paneId: string, requestId: number, text: string, lease: Lease, identity: PendingIdentity, held = false, agentOnly = false, fault?: Fault): PendingRecord<Owner, Lease> {
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
      if (this.elapsed() - receipt.at >= CLOSED_RETENTION_MS) this.removed.delete(id);
    }
    if (this.records.size + this.removed.size >= MAX_PENDING_DISPOSITIONS) {
      throw new PendingInputError("pending_limit", "Too many recent pending-message outcomes are retained; try again later");
    }
    if ([...this.records.values()].some((item) => item.paneId === paneId && this.blocksQueue(item))) throw new PendingInputError("pending_uncertain", "Check the terminal before sending more pending messages");
    if (this.closed.has(owner)) fault ??= { code: "input_not_ready", message: "The sending connection closed; review the saved message before sending it" };
    const item: PendingRecord<Owner, Lease> = {
      owner, paneId, lease, identity, inFlight: false,
      message: { id: this.newId(), request_id: requestId, text, state: held || fault ? "held" : "queued", created_at: new Date(this.now()).toISOString(), ...(agentOnly ? { agent_only: true as const } : {}),
        ...(fault ? { error: fault } : {}) },
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

  holds(paneId: string): boolean { return [...this.records.values()].some((item) => item.paneId === paneId); }

  private blocksQueue(item: PendingRecord<Owner, Lease>): boolean {
    return item.message.state === "uncertain" && !this.reviewOnly.has(item);
  }

  next(paneId: string): PendingRecord<Owner, Lease> | null {
    if (!ready(this.statuses.get(paneId)) || this.gates.has(paneId) || this.turns.has(paneId)
      || [...this.records.values()].some((item) => item.paneId === paneId && (item.inFlight || this.blocksQueue(item)))) return null;
    return [...this.records.values()].find((item) => item.paneId === paneId && item.message.state === "queued") ?? null;
  }

  claim(item: PendingRecord<Owner, Lease>, automatic: boolean): boolean {
    if (this.records.get(item.message.id) !== item || item.inFlight || item.message.state === "uncertain"
      || [...this.records.values()].some((other) => other.paneId === item.paneId && other.inFlight)
      || (automatic ? this.next(item.paneId) !== item : !["queued", "held"].includes(item.message.state))) return false;
    item.message.state = "sending"; delete item.message.error; item.inFlight = true;
    // before anything is typed: the row's turn is written after this on this PC's clock (src/lib/sentWaiting.ts)
    item.message.sending_at = new Date(this.now()).toISOString();
    if (!this.gates.get(item.paneId)?.committed) this.gates.set(item.paneId, { by: item.message.id, committed: false, sawWorking: false, completed: false, deadline: null });
    this.publish(item.owner, item.paneId);
    return true;
  }

  /** `readMark`: `mark()` as the caller's last read before this Enter began; no status came since it when it still is */
  committing(item: PendingRecord<Owner, Lease>, steeringWorkingTurn = false, restartingWorkingTurn = false, readMark?: number): void {
    if (this.records.get(item.message.id) !== item || !item.inFlight) return;
    const by = item.message.id, now = this.now();
    const earlier = this.gates.get(item.paneId);
    // an earlier Send now's Codex restart not yet seen to start keeps its wait: a working read before it is the turn Escape ends.
    // A steering read at work made after its ready was seen (no status came since it) is the restarted turn itself, which this
    // Enter joins
    const joinsRestart = steeringWorkingTurn && earlier?.restart === "working" && readMark === this.mark(item.paneId);
    const restarting = earlier?.committed && !earlier.completed && earlier.by !== by && earlier.restart !== undefined && !joinsRestart ? earlier : undefined;
    let gate: TurnGate;
    if (restartingWorkingTurn) gate = { by, committed: true, sawWorking: false, completed: false, deadline: now + this.startTimeoutMs, restart: "interruption", since: now };
    // its own start timeout: the earlier one's, maybe passed already, would end this Enter's wait before its turn could show.
    // Read at rest before this Enter, after the earlier one's Escape: that is the ready the interruption waits for
    else if (restarting) gate = { ...restarting, by, since: now, deadline: now + this.startTimeoutMs,
      ...(!steeringWorkingTurn && restarting.restart === "interruption" ? { restart: "working" as const } : {}) };
    else if (steeringWorkingTurn) gate = { by, committed: true, sawWorking: true, completed: false, deadline: null, joined: now + this.startTimeoutMs, since: now };
    else gate = { by, committed: true, sawWorking: false, completed: false, deadline: now + this.startTimeoutMs, since: now };
    this.gates.set(item.paneId, gate);
  }

  /**
   * A message sent to the queue and typed at once, with no row of its own (the pane read at rest and nothing waited): its
   * Enter's turn is waited for as a queued message's is, so the next one sent to the queue goes behind it.
   */
  typedAtOnce(paneId: string, steeringWorkingTurn: boolean): void {
    if (this.gates.get(paneId)?.committed) return;
    const now = this.now();
    this.gates.set(paneId, steeringWorkingTurn
      ? { by: "", committed: true, sawWorking: true, completed: false, deadline: null, joined: now + this.startTimeoutMs, since: now }
      : { by: "", committed: true, sawWorking: false, completed: false, deadline: now + this.startTimeoutMs, since: now });
  }

  /**
   * The agent itself tells the end of the turn the pane runs (a Codex on the server Ovis started for it: that turn's
   * turn/completed). Until `turnOver` takes the wait this gives, the queue gives out no message of the pane, whatever
   * herdr reads of it, and no start timeout decides anything for it (expire). The turn's wait is that of the Enter
   * committed for it, or one made here for a turn the queue did not start: herdr may have read that one at work already,
   * and its next ready reading is then that turn's end.
   */
  awaitTurn(paneId: string): object {
    const committed = this.gates.get(paneId);
    const gate: TurnGate = committed?.committed ? committed : { by: "", committed: true, sawWorking: this.statuses.get(paneId) === "working", completed: false, deadline: null, since: this.now() };
    this.gates.set(paneId, gate);
    const turn = { gate };
    this.turns.set(paneId, turn);
    return turn;
  }

  /**
   * The turn `wait` (awaitTurn) was for ended, as the agent `told`, or its end can no longer be told. Told, the turn's
   * wait is over. Not told, it is as any committed Enter's again: by the statuses that came since, with a start timeout
   * from now for a turn none of them showed to start. An Enter committed since has a wait of its own, which stays.
   */
  turnOver(paneId: string, wait: object, told: boolean): void {
    const turn = this.turns.get(paneId);
    if (turn !== wait) return;
    this.turns.delete(paneId);
    if (this.gates.get(paneId) !== turn.gate) return;
    if (told) this.finished(paneId, turn.gate);
    else if (!turn.gate.sawWorking) turn.gate.deadline = this.now() + this.startTimeoutMs;
  }

  /** The turn `gate` waits for was seen or told to finish: the wait ends once no send of the pane is on its way. */
  private finished(paneId: string, gate: TurnGate): void {
    gate.completed = true;
    if (![...this.records.values()].some((item) => item.paneId === paneId && item.inFlight)) this.gates.delete(paneId);
  }

  settle(item: PendingRecord<Owner, Lease>, fault?: Fault, uncertain: boolean | "preserve-turn" = false, retryWhenReady = false): void {
    if (this.records.get(item.message.id) !== item || !item.inFlight) return;
    item.inFlight = false;
    // a send the pane's move overtook is never tried again by itself under the new ID: it waits for its Send
    const moved = this.movedInFlight.delete(item);
    if (moved) retryWhenReady = false;
    if (!fault) {
      this.finish(item, "sent");
      const gate = this.gates.get(item.paneId);
      if (gate?.completed || (gate?.by === item.message.id && !gate.committed)) this.gates.delete(item.paneId);
      return;
    }
    item.message.state = uncertain ? "uncertain" : retryWhenReady ? "queued" : "held";
    if (!uncertain) delete item.message.sending_at;
    if (retryWhenReady && !uncertain) delete item.message.error; else item.message.error = fault;
    const gate = this.gates.get(item.paneId);
    if (uncertain === "preserve-turn" && !moved) {
      // Enter reached the terminal: keep its normal turn ordering while only this row waits for review.
      this.reviewOnly.add(item);
      if (gate?.completed) this.gates.delete(item.paneId);
    } else {
      // an uncertain send's committed Enter keeps its wait: its turn is still to be seen to start and finish
      if ((!uncertain && gate?.by === item.message.id) || (gate?.by === item.message.id && !gate.committed) || gate?.completed) this.gates.delete(item.paneId);
      if (uncertain) this.holdPane(item.paneId, fault.code === "pasted_not_sent" ? BEHIND_PASTE : fault);
    }
    this.publish(item.owner, item.paneId);
  }

  /** Native transcript evidence settles only this uncertain ID; held followers stay held. */
  confirmRecorded(item: PendingRecord<Owner, Lease>, remember: () => boolean): boolean {
    if (this.records.get(item.message.id) !== item || item.inFlight || item.message.state !== "uncertain" || !remember()) return false;
    this.finish(item, "consumed");
    return true;
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

  mark(paneId: string): number { return this.events.get(paneId) ?? 0; }

  current(paneId: string): AgentStatus | undefined { return this.statuses.get(paneId); }

  status(paneId: string, status: AgentStatus): void {
    this.events.set(paneId, this.mark(paneId) + 1);
    this.readAt.set(paneId, this.now());
    this.readBy.set(paneId, "event");
    this.apply(paneId, status);
  }

  /**
   * A collector snapshot of a pane with no event since it was asked for, at `askedAt` (status.ts: a reconcile's baseline,
   * a resync, a replay). A snapshot, not an event: asked for after the Enter whose turn is awaited it is read as a submit's
   * read is (`observe`); asked for before it, it may be older than that turn, and is only the pane's status. Its reading is
   * dated when it was asked: the same snapshot told again (a resync or a replay after its baseline, with a status only the
   * replay can tell, such as a Codex finish) is no older than itself.
   */
  baseline(paneId: string, status: AgentStatus, askedAt: number): void {
    const since = this.gates.get(paneId)?.since;
    const read = this.readAt.get(paneId) ?? -Infinity;
    // asked before a reading already taken, it is older than that reading and tells nothing, not even the status
    const fresh = askedAt > read || (askedAt === read && this.readBy.get(paneId) !== "read");
    if (!fresh) return;
    if (since === undefined || askedAt > since) this.read(paneId, status, askedAt);
    else this.statuses.set(paneId, status);
    this.readAt.set(paneId, askedAt);
    this.readBy.set(paneId, "snapshot");
    // a submit's read under way across it is older than this status, as across an event
    this.events.set(paneId, this.mark(paneId) + 1);
  }

  /**
   * A snapshot's reading of the pane, taken when nothing newer than `mark` was told. herdr's events can trail it (#4118
   * case B): an event older than the reading still counts as the turn's evidence, as no event carries herdr's order.
   */
  observe(paneId: string, status: AgentStatus, mark: number): void {
    if (this.mark(paneId) !== mark) return;
    this.readBy.set(paneId, "read");
    this.read(paneId, status, this.now());
  }

  /** `at`: when the reading was taken (a collector snapshot's is when it was asked for) */
  private read(paneId: string, status: AgentStatus, at: number): void {
    this.readAt.set(paneId, at);
    this.apply(paneId, status, at);
  }

  /** A message of the pane waits, or a turn has not been seen or told to finish: one sent now goes behind it. */
  waiting(paneId: string): boolean {
    return this.gates.get(paneId)?.committed === true || this.turns.has(paneId)
      || [...this.records.values()].some((item) => item.paneId === paneId && (item.inFlight || item.message.state === "queued" || this.blocksQueue(item)));
  }

  forget(paneId: string): void { this.statuses.delete(paneId); this.events.delete(paneId); this.gates.delete(paneId); this.turns.delete(paneId); this.waits.delete(paneId); this.readAt.delete(paneId); this.readBy.delete(paneId); }

  /** `at`: when the status was read; a Send now's `joined` window is judged by it, not by when it reached the queue */
  private apply(paneId: string, status: AgentStatus, at = this.now()): void {
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
    if (status === "working") { gate.sawWorking = true; gate.deadline = null; delete gate.lenient; }
    if (ready(status) && gate.sawWorking) {
      if (gate.joined !== undefined && at < gate.joined) {
        delete gate.joined;
        Object.assign(gate, { sawWorking: false, deadline: this.now() + this.startTimeoutMs, lenient: true });
        return;
      }
      this.finished(paneId, gate);
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

  holdItem(item: PendingRecord<Owner, Lease>, fault: Fault): void {
    if (this.records.get(item.message.id) !== item || item.inFlight || item.message.state !== "queued") return;
    item.message.state = "held"; item.message.error = fault;
    this.publish(item.owner, item.paneId);
  }

  rehold(item: PendingRecord<Owner, Lease>, fault: Fault): void {
    if (this.records.get(item.message.id) !== item || item.inFlight || item.message.state !== "held" || item.message.error?.code === fault.code) return;
    item.message.error = fault;
    this.publish(item.owner, item.paneId);
  }

  holdPane(paneId: string, fault: Fault): void {
    for (const owner of new Set([...this.records.values()].filter((item) => item.paneId === paneId).map((item) => item.owner))) this.hold(owner, paneId, fault);
  }

  /**
   * herdr moved the pane under a new ID: its messages, their outcomes and held-copy sends follow it, each
   * held for an explicit send (one on its way, uncertain), and every owner is told both IDs' lists.
   */
  move(from: string, to: string, fault: Fault): void {
    if (from === to) return;
    this.holdPane(from, fault);
    const owners = new Set<Owner>();
    for (const item of this.records.values()) if (item.paneId === from) {
      item.paneId = to;
      owners.add(item.owner);
      if (item.inFlight) this.movedInFlight.add(item);
    }
    for (const receipt of this.removed.values()) if (receipt.paneId === from) receipt.paneId = to;
    for (const [key, entry] of [...this.resends]) {
      if (entry.paneId !== from) continue;
      const [, id, generation] = JSON.parse(key) as [string, string, number];
      entry.paneId = to;
      this.resends.delete(key);
      this.resends.set(JSON.stringify([to, id, generation]), entry);
    }
    this.forget(from);
    for (const owner of owners) { this.publish(owner, from); this.publish(owner, to); }
  }

  close(owner: Owner): void {
    const held = new Set([...this.records.values()].filter((item) => item.owner === owner && item.message.state === "held" && !item.inFlight).map((item) => item.paneId));
    this.hold(owner);
    for (const pane of held) this.publish(owner, pane);
    this.closed.set(owner, this.elapsed());
  }

  /** @returns the panes whose wait ended without holding their queue, which may go on now */
  expire(): string[] {
    this.expireResends();
    const released: string[] = [];
    for (const [paneId, gate] of this.gates) {
      // while the agent itself is to tell a turn's end, the queue is held by that turn: an Enter's start timeout that
      // passed meanwhile is judged once that wait is over, so what was queued behind it since is held with the rest
      if (gate.deadline !== null && this.now() >= gate.deadline && !this.turns.has(paneId)
        && ![...this.records.values()].some((item) => item.paneId === paneId && item.inFlight)) {
        // a Send now still waiting for review may not have started its turn yet: its pane's queue waits for the user
        const reviewing = [...this.records.values()].some((item) => item.paneId === paneId && this.reviewOnly.has(item) && item.message.state === "uncertain");
        if (gate.lenient && !reviewing) released.push(paneId);
        else this.holdPane(paneId, { code: "pending_turn_unconfirmed", message: "The next turn did not start in time; review and send the remaining messages explicitly" });
        this.gates.delete(paneId);
      }
    }
    for (const [owner, closedAt] of this.closed) if (this.elapsed() - closedAt >= CLOSED_RETENTION_MS) {
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
    return released;
  }
}
