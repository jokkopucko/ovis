// Explores the real PendingInputs class (server/pending-input.ts): every order of the steps its callers take and
// of the events around them, up to the bounds of a Config. SKILL.md says what is real code here and what is a
// description of the callers and of herdr; the comments below name the code each step stands for.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

export const ROOT = resolve(import.meta.dir, "../../..");
const SOURCE = join(ROOT, "server/pending-input.ts");

export const RULES = ["QueueWaitsForTurnEvidence", "NoAutomaticEnterIntoQueuedTurn"] as const;
export type Rule = (typeof RULES)[number];

type St = "working" | "idle" | "done" | "blocked";
type Fault = { code: string; message: string };
type Reply = { ok: boolean; code?: string; message?: string };
type Resend = { id: string; paneId: string; fingerprint: string; reply: Promise<Reply>; settledAt: number | null; uncertain: boolean };
interface Rec { owner: string; paneId: string; lease: null; identity: object; inFlight: boolean; message: { id: string; request_id: number; text: string; state: string; created_at: string; error?: Fault } }
interface Gate { by: string; committed: boolean; sawWorking: boolean; completed: boolean; deadline: number | null; restart?: "interruption" | "working"; joined?: number; lenient?: true; since?: number }
/** The class under test, with the fields the explorer saves and puts back between steps. */
interface Inst {
  records: Map<string, Rec>; statuses: Map<string, St>; events: Map<string, number>; gates: Map<string, Gate>;
  movedInFlight: WeakSet<Rec>; closed: Map<string, number>; resends: Map<string, Resend>;
  enqueue(owner: string, paneId: string, requestId: number, text: string, lease: null, identity: object, held?: boolean): Rec;
  next(paneId: string): Rec | null;
  claim(item: Rec, automatic: boolean): boolean;
  committing(item: Rec, steeringWorkingTurn?: boolean, restartingWorkingTurn?: boolean, readMark?: number): void;
  settle(item: Rec, fault?: Fault, uncertain?: boolean, retryWhenReady?: boolean): void;
  discard(item: Rec): boolean;
  mark(paneId: string): number;
  current(paneId: string): St | undefined;
  status(paneId: string, status: St): void;
  observe(paneId: string, status: St, mark: number): void;
  baseline(paneId: string, status: St, askedAt: number): void;
  typedAtOnce(paneId: string, steeringWorkingTurn: boolean): void;
  resend(paneId: string, id: string, fingerprint: string, task: () => Promise<Reply>, generation?: number): Promise<Reply>;
  waiting(paneId: string): boolean;
  forget(paneId: string): void;
  hold(owner: string, paneId?: string, fault?: Fault): void;
  holdPane(paneId: string, fault: Fault): void;
  move(from: string, to: string, fault: Fault): void;
  expire(): string[];
}
type InstClass = new (changed: () => void, now: () => number, startTimeoutMs: number, newId: () => string, perPane: () => boolean, elapsed: () => number) => Inst;

export interface Config {
  name: string;
  /** which agent's keys the callers press: only Codex gets the Escape of server/codex-steering.ts */
  agent: "claude" | "codex";
  /** how many messages are sent to the queue in one run */
  messages: number;
  owners: string[];
  /**
   * no description of the agent or of herdr: any status may be applied at any time and any read may say any status.
   * Only QueueWaitsForTurnEvidence can be asked then; the fields below that describe the agent and herdr are not used.
   */
  free: boolean;
  /** what herdr calls the agent at rest: `done` for a finish nobody saw, else `idle` */
  rest: "idle" | "done";
  /** a snapshot may answer ahead of status events herdr sent before it (server/collector.ts REPLAY_SETTLE_MS) */
  overtake: boolean;
  /** an Enter that lands during a turn may wait in the agent's own queue past that turn's end, and run as a turn of its own */
  ownQueue: boolean;
  /** a status event herdr sent may still be on its way at an Enter's `committing`, at the user's next action or when the start timeout passes */
  lateEvents: boolean;
  /** a Send now that read the agent at work may land its Enter after that turn has ended */
  steerPastEnd: boolean;
  /** a Send now may be pressed on another message while an earlier Send now's Codex restart has not been seen to start its turn */
  sendNowDuringRestart: boolean;
  /** a reconcile's snapshot may be told to the queue as its baseline after newer status events (collector.ts reconcile, status.ts onBaseline) */
  baseline: boolean;
  /** a message sent to the queue and typed at once (nothing waits, the agent reads at rest) counts as the queue's Enter while an earlier Enter's wait is open */
  atOnce: boolean;
  /** the agent or herdr may change between an Enter's `committing` and the Enter reaching the agent */
  slowEnter: boolean;
  /** turns something else starts (typing at herdr's terminal, a turn the agent resumes by itself) */
  others: number;
  /** times the agent stops mid-turn to ask */
  blocks: number;
  gone: boolean;
  moves: boolean;
  holds: boolean;
  rules: Rule[];
  /** a patched copy of the class: see VARIANTS */
  variant?: string;
  /**
   * steps the path to the break must take, in this order: the run is about that order, not any other that breaks the
   * rule. The search goes on past a break whose path lacks them
   */
  via?: string[];
  expect: "holds" | Rule;
}

/** Broken copies of server/pending-input.ts: one edit each, of text that must be there exactly once. */
export const VARIANTS: Record<string, { what: string; find: string; put: string }> = {
  "claim-replaces-wait": {
    what: "claim() starts a new gate over a committed one, so a refused Send now ends the wait",
    find: "if (!this.gates.get(item.paneId)?.committed) this.gates.set(",
    put: "this.gates.set(",
  },
  "sent-ends-wait": {
    what: "settle() drops the gate of the message it sent, though its turn has not been seen",
    find: "if (gate?.completed || (gate?.by === item.message.id && !gate.committed)) this.gates.delete(item.paneId);",
    put: "if (gate?.completed || gate?.by === item.message.id) this.gates.delete(item.paneId);",
  },
  "timeout-without-hold": {
    what: "expire() drops a gate whose turn did not start in time without holding the pane's messages",
    find: "        else this.holdPane(paneId, { code: \"pending_turn_unconfirmed\", message: \"The next turn did not start in time; review and send the remaining messages explicitly\" });\n",
    put: "",
  },
  "restart-counts-old-working": {
    what: "apply() takes a working status seen before Escape's interruption as the replacement turn",
    find: "    if (gate.restart === \"interruption\") {\n      if (ready(status)) gate.restart = \"working\";\n      return;\n    }",
    put: "    if (gate.restart === \"interruption\") {\n      if (ready(status)) { gate.restart = \"working\"; return; }\n      if (status !== \"working\") return;\n      delete gate.restart;\n    }",
  },
  "ready-without-working": {
    what: "apply() completes a gate on a ready status though no working status came after the Enter",
    find: "if (ready(status) && gate.sawWorking) {",
    put: "if (ready(status)) {",
  },
  "deadline-at-once": {
    what: "committing() sets a deadline that has already passed, so the wait ends at the next timer tick",
    find: "else gate = { by, committed: true, sawWorking: false, completed: false, deadline: now + this.startTimeoutMs, since: now };",
    put: "else gate = { by, committed: true, sawWorking: false, completed: false, deadline: now, since: now };",
  },
  "observe-ignores-mark": {
    what: "observe() applies a snapshot's status though a status event came after its mark",
    find: "    if (this.mark(paneId) !== mark) return;\n",
    put: "",
  },
};

let scratch: string | null = null;
export function cleanup(): void { if (scratch !== null) rmSync(scratch, { recursive: true, force: true }); scratch = null; }
/** The class as it is in the repo, or a patched copy of it. Nothing is written under the repo. */
export async function loadClass(variant?: string): Promise<InstClass> {
  if (variant === undefined) return ((await import(SOURCE)) as { PendingInputs: InstClass }).PendingInputs;
  const edit = VARIANTS[variant];
  if (!edit) throw new Error(`no variant named ${variant}`);
  const source = readFileSync(SOURCE, "utf8");
  if (source.split(edit.find).length !== 2) throw new Error(`variant ${variant}: its text is not in server/pending-input.ts exactly once. The code changed: bring the variant up to date (SKILL.md, "When you change the covered code on purpose")`);
  if (scratch === null) { mkdirSync(tmpdir(), { recursive: true }); scratch = mkdtempSync(join(tmpdir(), "verify-turn-gate-")); }
  const file = join(scratch, `${variant}.ts`);
  writeFileSync(file, source.replace(edit.find, edit.put).replace(/from "\.\.\/shared\/([^"]*)"/g, (_all, rest: string) => `from ${JSON.stringify(join(ROOT, "shared", rest))}`));
  return ((await import(file)) as { PendingInputs: InstClass }).PendingInputs;
}

// ---- the saved state ----------------------------------------------------------------------------------------

interface Task {
  /** the pane id the task was started for: its lane (server/core/input.ts serialize), and the id its calls name */
  lane: string;
  kind: "auto" | "steer" | "submit";
  id: string;
  owner: string;
  pc: string;
  /** PendingInputs.mark() as taken, and whether a status event came since (the explorer's own count) */
  mark: number; fresh: boolean;
  /** a clientSnapshot is being read; `over` is the status of an event applied during the read, which wins (CompletionTracker.readSnapshot) */
  reading: boolean; over: St | null; ctx: St | null;
  /** when that read was made, on the count of World.seq: for a status an event supplied, when herdr read that status */
  at: number; overAt: number;
  /** its connection's lease or its pane is gone: the next check refuses */
  lost: boolean;
  hold: boolean; steering: boolean; statusAtRead: string;
  /** PendingInputs.mark() as the read before the Enter began */
  enterMark: number;
}
interface World {
  /** how many of the run's `via` steps the path has taken */
  via: number;
  c: { records: { id: string; o: string; p: string; f: boolean; s: string; rq: number; mv: boolean }[]; statuses: [string, St][]; events: [string, number][]; gates: [string, Gate][] };
  /** what the agent does: its turn (`base`: one this queue did not start), and Enters that wait in its own queue */
  turn: null | "base" | "queue"; aq: string[]; blocked: boolean;
  /** herdr's reading of it, and the status events sent and not yet applied: each with when it was read and the pane id it names */
  h: St; q: { s: St; at: number; p: string }[];
  /** a reconcile's snapshot, read and not yet told to the queue as its baseline */
  base: null | { s: St; at: number; p: string; stale?: true }; baselines: number;
  /** counts the readings of the agent and the commits, so that which came first can be told */
  seq: number;
  pane: string; gone: boolean; moved: boolean;
  tasks: Task[];
  used: number; others: number; blocks: number;
  /**
   * the rule's own record: Enters committed whose turn's start and end have not been seen since. `since` is the commit,
   * `last` the reading last counted: a status read before either says nothing of the turn
   */
  waits: { by: string; need: string; timed: boolean; late: boolean; restart: boolean; since: number; last: number }[];
  /** the class's gate had a start deadline when the start timeout passed: its end by the timer is that timeout's */
  expiredGate: boolean;
}
const NAMES = ["X", "Y", "Z", "W"];
const IDENTITY = { agent: "agent", terminalId: "t", session: null };
const TIMEOUT = 10;
const F = (code: string): Fault => ({ code, message: code });

class Violation extends Error { constructor(readonly rule: Rule, readonly why: string) { super(why); } }

export interface Result { config: Config; states: number; ms: number; /** breaks whose path lacked the `via` steps */ passed: number; broken: null | { rule: Rule; why: string; steps: { label: string; after: string }[] } }

export async function explore(config: Config, limit = 60_000_000): Promise<Result> {
  const started = performance.now();
  const Class = await loadClass(config.variant);
  let clock = 0;
  let nextId = "";
  const checks = (rule: Rule): boolean => config.rules.includes(rule);
  if (config.free && checks("NoAutomaticEnterIntoQueuedTurn")) throw new Error(`${config.name}: a free run has no agent to ask NoAutomaticEnterIntoQueuedTurn of`);

  const restore = (c: World["c"]): Inst => {
    clock = 0;
    const inst = new Class(() => {}, () => clock, TIMEOUT, () => nextId, () => false, () => 0);
    for (const r of c.records) {
      const rec: Rec = { owner: r.o, paneId: r.p, lease: null, identity: IDENTITY, inFlight: r.f,
        message: { id: r.id, request_id: r.rq, text: r.id, state: r.s, created_at: "", ...(r.s === "held" || r.s === "uncertain" ? { error: F("x") } : {}) } };
      inst.records.set(r.id, rec);
      if (r.mv) inst.movedInFlight.add(rec);
    }
    for (const [pane, status] of c.statuses) inst.statuses.set(pane, status);
    for (const [pane, count] of c.events) inst.events.set(pane, count);
    for (const [pane, gate] of c.gates) inst.gates.set(pane, { ...gate });
    return inst;
  };
  /** The fields that decide what the class does next. Clock values and event counts are kept only as far as they compare. */
  const save = (inst: Inst, w: World): void => {
    if (inst.closed.size > 0) throw new Error("the explorer does not save closed owners");
    // a held-copy send the class retains is settled by the end of its step, and its row is then gone or uncertain: no
    // later step sends that copy again, so the retained entry decides nothing more and is not saved
    for (const sent of inst.resends.values()) if (sent.settledAt === null) throw new Error("the explorer does not save a held-copy send still under way");
    // a mark is the pane's event count as it was (1), or one that count has left behind for good (-1). A count of 0 is a
    // pane no event was applied to, or one forget() reset: a mark of 0 taken before the reset reads current again, as in the class
    const events: [string, number][] = [];
    for (const task of w.tasks) {
      const count = inst.events.get(task.lane) ?? 0;
      task.mark = task.mark !== count ? -1 : count === 0 ? 0 : 1;
      task.enterMark = task.enterMark !== count ? -1 : count === 0 ? 0 : 1;
    }
    for (const pane of [...inst.events.keys()].sort()) if ((inst.events.get(pane) ?? 0) > 0) events.push([pane, 1]);
    // readings and commits keep their order, not their numbers
    const times = [...new Set([...w.q.map((event) => event.at), ...(w.base ? [w.base.at] : []), ...w.waits.flatMap((wait) => [wait.since, wait.last]), ...w.tasks.flatMap((task) => [task.at, task.overAt])])]
      .filter((time) => time > 0).sort((a, b) => a - b);
    const rank = (time: number): number => (time <= 0 ? 0 : times.indexOf(time) + 1);
    for (const event of w.q) event.at = rank(event.at);
    if (w.base) w.base.at = rank(w.base.at);
    for (const wait of w.waits) { wait.since = rank(wait.since); wait.last = rank(wait.last); }
    for (const task of w.tasks) { task.at = rank(task.at); task.overAt = rank(task.overAt); }
    w.seq = times.length;
    w.c = {
      records: [...inst.records.values()].map((r) => ({ id: r.message.id, o: r.owner, p: r.paneId, f: r.inFlight, s: r.message.state, rq: r.message.request_id, mv: inst.movedInFlight.has(r) })),
      statuses: [...inst.statuses].sort(([a], [b]) => a.localeCompare(b)),
      events,
      gates: [...inst.gates].sort(([a], [b]) => a.localeCompare(b)).map(([pane, gate]) => [pane, {
        by: gate.by, committed: gate.committed, sawWorking: gate.sawWorking, completed: gate.completed,
        deadline: gate.deadline === null ? null : Math.max(0, gate.deadline - clock), ...(gate.restart ? { restart: gate.restart } : {}),
        ...(gate.joined !== undefined ? { joined: Math.max(0, gate.joined - clock) } : {}), ...(gate.lenient ? { lenient: true as const } : {}),
        // when it was committed, only as far as a baseline compares it: every baseline here is told as asked before it
        ...(gate.since !== undefined ? { since: 0 } : {}),
      }]),
    };
  };

  // ---- the rule's own record (it never reads a gate) ------------------------------------------------------
  const resting = (status: St | null): boolean => status === "idle" || status === "done";
  /** The count of readings and commits. A free run has no agent to read: each status is what the agent does as it is applied. */
  const now = (w: World): number => (config.free ? 0 : ++w.seq);
  /**
   * A status of the agent's pane that reached the class, read at `at`. It counts for an Enter only when it was read
   * after that Enter's commit and not before a reading already counted for it.
   */
  const evidence = (w: World, status: St, at: number): void => {
    for (const wait of w.waits) {
      if (!config.free && (at <= wait.since || at < wait.last)) continue;
      if ((wait.need[0] === "W" && status === "working") || (wait.need[0] === "R" && resting(status))) { wait.need = wait.need.slice(1); wait.last = at; }
    }
    w.waits = w.waits.filter((wait) => wait.need.length > 0);
  };
  /**
   * An Enter is about to be typed (PendingInputs.committing). Its caller's last read of the pane, made after every
   * earlier Enter, is evidence for those too: at work for a steering caller, at rest for one that starts a turn.
   */
  const committed = (w: World, task: Task, mode: "start" | "steer" | "restart"): void => {
    evidence(w, mode === "start" ? config.rest : "working", task.at);
    w.waits = w.waits.filter((wait) => wait.by !== task.id);
    const since = now(w);
    w.expiredGate = false;
    w.waits.push({ by: task.id, need: mode === "start" ? "WR" : mode === "steer" ? "R" : "RWR", timed: mode !== "steer", late: false, restart: mode === "restart", since, last: since });
  };
  /** The wait may end without its evidence only where every message that waited is handed to the user. */
  const handOver = (w: World, inst: Inst): void => {
    if (![...inst.records.values()].some((r) => r.paneId === w.pane && r.message.state === "queued")) w.waits = [];
  };
  const inFlight = (inst: Inst, pane: string): boolean => [...inst.records.values()].some((r) => r.paneId === pane && r.inFlight);

  // ---- steps ------------------------------------------------------------------------------------------------
  const STATUSES: St[] = ["working", config.rest, "blocked"];
  const statusOf = (w: World): St => (w.blocked ? "blocked" : w.turn !== null ? "working" : config.rest);
  const item = (inst: Inst, id: string): Rec => inst.records.get(id) ?? { owner: "", paneId: "", lease: null, identity: IDENTITY, inFlight: false, message: { id, request_id: 0, text: id, state: "gone", created_at: "" } };
  const end = (w: World, task: Task): void => { w.tasks = w.tasks.filter((other) => other !== task); };
  /** What the agent does with an Enter (the explorer's description, not Ovis code). */
  const enterLands = (w: World, task: Task | null, inQueue: boolean): void => {
    if (config.free) return;
    if (task?.kind === "auto" && checks("NoAutomaticEnterIntoQueuedTurn") && (w.turn === "queue" || w.aq.length > 0)) {
      throw new Violation("NoAutomaticEnterIntoQueuedTurn", `${task.id}'s Enter was typed by the queue while the agent ${w.turn === "queue" ? "is on" : "has yet to begin"} the turn of a message this queue sent before it`);
    }
    if (w.turn === null && w.aq.length === 0) w.turn = task === null ? "base" : "queue";
    else if (task === null) return;
    else if (w.turn === null || inQueue) w.aq.push(task.id);
    else w.turn = "queue";
  };
  const uncertain = (w: World, inst: Inst, task: Task): void => {
    // pending.ts dispatchPendingText: once `wrote` is set every failure is submit_changed, which dispatchPending settles uncertain
    inst.settle(item(inst, task.id), F("submit_changed"), true, false);
    handOver(w, inst);
    end(w, task);
  };
  const observe = (w: World, inst: Inst, task: Task, status: St): void => {
    inst.observe(task.lane, status, task.mark);
    if (task.fresh && task.lane === w.pane) evidence(w, status, task.at);
  };

  type Step = [label: string, run: (w: World, inst: Inst, task: Task) => void | Promise<void>, task?: number];
  const steps = (w0: World, inst0: Inst): Step[] => {
    const out: Step[] = [];
    const free = (lane: string): boolean => !w0.tasks.some((task) => task.lane === lane);
    const live = !w0.gone;
    // the agent begins a turn it has in its own queue before the user's next action, and well within the start timeout
    const starting = w0.turn === null && w0.aq.length > 0;
    // and so is every status event herdr has sent, unless the run lets events come late
    const told = config.free || config.lateEvents || w0.q.length === 0;
    const fresh = (kind: Task["kind"], id: string, owner: string, pc: string, lane: string): Task =>
      ({ lane, kind, id, owner, pc, mark: 0, fresh: false, reading: false, over: null, ctx: null, at: 0, overAt: 0, lost: false, hold: false, steering: false, statusAtRead: "", enterMark: -2 });

    // a status event names its pane: one sent for the id a pane had before it moved is applied to that id
    const applied = (w: World, inst: Inst, status: St, at: number, pane: string, tracked = true): void => {
      inst.status(pane, status);
      if (pane === w.pane) evidence(w, status, at);
      // collector.ts: a reconcile's baseline is not told for a pane with an event since its snapshot was asked for
      if (tracked && w.base !== null && w.base.p === pane) w.base.stale = true;
      for (const task of w.tasks) if (task.lane === pane) { task.fresh = false; if (task.reading && tracked) { task.over = status; task.overAt = at; } }
    };
    if (config.free) for (const status of STATUSES) out.push([`status event applied: ${status}`, (w, inst) => applied(w, inst, status, 0, w.pane)]);
    // ---- the agent and herdr (described, not Ovis code) ----
    else {
      // nothing more is read of a pane that has ended: only the events already sent still arrive
      if (!w0.gone) {
        if (w0.turn !== null && !w0.blocked && (w0.aq.length === 0 || config.ownQueue)) out.push(["the agent's turn ends", (w) => { w.turn = null; }]);
        if (w0.turn !== null && w0.aq.length > 0) out.push(["the agent takes what waits in its own queue into the turn at work", (w) => { w.turn = "queue"; w.aq = []; }]);
        if (w0.turn === null && w0.aq.length > 0) out.push(["the agent starts a turn with what waits in its own queue", (w) => { w.turn = "queue"; w.aq = []; }]);
        if (w0.turn === null && w0.aq.length === 0 && w0.others < config.others) out.push(["something else starts a turn", (w) => { w.turn = "base"; w.others++; }]);
        if (w0.turn !== null && !w0.blocked && w0.blocks < config.blocks) out.push(["the agent stops to ask", (w) => { w.blocked = true; w.blocks++; }]);
        if (w0.blocked) out.push(["the agent is answered and works on", (w) => { w.blocked = false; }]);
        if (statusOf(w0) !== w0.h && w0.q.length < 4) out.push([`herdr reads the agent ${statusOf(w0)}`, (w) => { w.h = statusOf(w); w.q.push({ s: w.h, at: ++w.seq, p: w.pane }); }]);
        // collector.ts reconcile: a snapshot is read, and whatever came meanwhile, status.ts onBaseline tells the queue a
        // ready reading of it. (One that reads the agent at work re-tells what the tracker last recorded: not described.)
        if (config.baseline && w0.base === null && w0.baselines < 1) out.push([`a reconcile reads the pane ${w0.h}`, (w) => { w.base = { s: w.h, at: ++w.seq, p: w.pane }; w.baselines++; }]);
      }
      // server/core/status.ts reportStatus: pending.status(paneId, ...), then drainPending
      if (w0.q.length > 0) out.push([`status event applied: ${w0.q[0]!.s}`, (w, inst) => { const event = w.q.shift()!; applied(w, inst, event.s, event.at, event.p); }]);
      if (w0.base !== null) out.push([`the reconcile's reading is told to the queue as its baseline: ${w0.base.s}`, (w, inst) => {
        const base = w.base!;
        w.base = null;
        // status.ts onBaseline: PendingInputs.baseline, for a pane with no event since the snapshot was asked for
        // asked for before any commit of the class's clock (gates are saved as committed at 0) and after no reading the class
        // keeps (readAt is not saved): the class takes it as the pane's status under an open wait, and as a snapshot read
        // with none. Its other cases (asked after the Enter, or before a later reading) are the unit tests' of
        // server/core/pending-turn-gate.test.ts
        if (resting(base.s) && !base.stale) inst.baseline(base.p, base.s, -1);
      }]);
    }

    // ---- what ends or moves the pane, or takes a connection's lease ----
    if (config.holds && live) for (const owner of config.owners) {
      if (![...inst0.records.values()].some((r) => r.owner === owner && (r.message.state === "queued" || r.inFlight)) && !w0.tasks.some((task) => task.owner === owner)) continue;
      // pending.ts holdPending: the authority is deleted, so every later authorizePending of that owner throws
      out.push([`${owner}'s page leaves the pane`, (w, inst) => { inst.hold(owner, w.pane); for (const task of w.tasks) if (task.owner === owner) task.lost = true; }]);
    }
    // terminal-process.ts ended(): holdPendingPane alone, which also takes every page's authority over the pane
    if (config.holds && live && ([...inst0.records.values()].some((r) => r.paneId === w0.pane && (r.message.state === "queued" || r.inFlight)) || w0.tasks.length > 0)) {
      out.push(["the pane's terminal restarts under its pages", (w, inst) => { inst.holdPane(w.pane, F("input_not_ready")); for (const task of w.tasks) task.lost = true; }]);
    }
    if (config.gone && live) out.push(["the pane ends", (w, inst) => {
      // status.ts paneGone: holdPendingPane, then pending.forget
      inst.holdPane(w.pane, F("pane_not_found")); inst.forget(w.pane);
      w.gone = true; for (const task of w.tasks) task.lost = true;
      handOver(w, inst);
    }]);
    if (config.moves && live && !w0.moved) out.push(["herdr moves the pane under a new id", (w, inst) => {
      // pending.ts movePendingPane: holdPendingPane(from), then pending.move
      inst.holdPane(w.pane, F("pane_moved")); inst.move(w.pane, "q", F("pane_moved"));
      w.pane = "q"; w.moved = true; for (const task of w.tasks) task.lost = true;
      handOver(w, inst);
    }]);
    // server-core.ts: pending.expire() every 100 ms. A wait whose start timeout passed ends once no send is on its way,
    // and only then: with no time passed since a commit the timer changes nothing
    // The class has one gate, the latest commit's: an earlier Enter's timeout ends nothing once a later one was committed
    const timedOut = (w: World, inst: Inst): void => {
      // an Enter committed over a Codex restart not yet seen to start carries that restart's wait in the class's gate
      const latest = w.waits.at(-1);
      const carried = latest && !latest.restart ? w.waits.slice(0, -1).findLast((wait) => wait.restart && wait.need.includes("W")) : undefined;
      const gate = carried ?? latest;
      if (gate?.late && gate.need.includes("W") && !inFlight(inst, w.pane)) handOver(w, inst);
    };
    if (inst0.gates.size > 0) out.push(["the 100 ms timer runs expire(), no time has passed", (w, inst) => { inst.expire(); timedOut(w, inst); if (w.expiredGate && !inst.gates.has(w.pane)) handOver(w, inst); }]);
    if ([...inst0.gates.values()].some((gate) => gate.deadline !== null && gate.deadline > 0) || w0.waits.some((wait) => wait.timed)) {
      // here the whole start timeout passes at once
      // and herdr reads what the agent does, and its status event is applied, well within it
      if (config.free || (!starting && told && w0.h === statusOf(w0))) out.push(["the start timeout passes", (w, inst) => {
        w.expiredGate = inst.gates.get(w.pane)?.deadline != null;
        clock = TIMEOUT; inst.expire();
        for (const wait of w.waits) if (wait.timed) wait.late = true;
        timedOut(w, inst);
        if (w.expiredGate && !inst.gates.has(w.pane)) handOver(w, inst);
      }]);
    }

    // ---- a submit that waits: pending.ts pendingFrames.submit, the `waits` branch ----
    if (live && !starting && told && free(w0.pane) && w0.used < config.messages) for (const owner of config.owners) for (const hold of [false, true]) {
      out.push([`${owner} sends ${NAMES[w0.used]} to ${hold ? "hold" : "queue"}: the pane is read`, (w, inst) => {
        const task = fresh("submit", NAMES[w.used++]!, owner, "read", w.pane);
        task.hold = hold; task.mark = inst.mark(w.pane); task.fresh = true; task.reading = true;
        w.tasks.push(task);
      }]);
    }
    // ---- the queue takes up the next message: pending.ts drainPending ----
    if (live && free(w0.pane) && inst0.next(w0.pane) !== null) {
      out.push([`the queue takes up ${inst0.next(w0.pane)!.message.id}`, (w, inst) => {
        const next = inst.next(w.pane)!;
        w.tasks.push(fresh("auto", next.message.id, next.owner, "picked", w.pane));
      }]);
    }
    // ---- Send now and Discard: pending.ts pendingFrames["pending-action"] ----
    if (live && !starting && told && free(w0.pane)) for (const r of inst0.records.values()) {
      if (r.paneId !== w0.pane || r.inFlight) continue;
      if ((r.message.state === "queued" || r.message.state === "held") && (config.sendNowDuringRestart || !w0.waits.some((wait) => wait.restart && wait.need.includes("W")))) {
        out.push([`Send now on ${r.message.id}`, (w) => { w.tasks.push(fresh("steer", r.message.id, r.owner, "s0", w.pane)); }]);
      }
      out.push([`Discard ${r.message.id}`, (_w, inst) => { inst.discard(item(inst, r.message.id)); }]);
    }

    const taskSteps = (t0: Task, add: (label: string, run: Step[1]) => void): void => {
      const typist = t0.kind === "auto" ? "the queue" : t0.kind === "steer" ? "Send now" : "the submit";
      if (t0.reading) {
        // a free read says anything, whenever it is made: it is one step with what its caller does next
        if (config.free) for (const status of STATUSES) {
          taskSteps({ ...t0, ctx: status, reading: false, over: null }, (label, run) => add(`${typist} has read the pane ${status}; ${label}`, (w, inst, task) => { task.ctx = status; task.reading = false; task.over = null; return run(w, inst, task); }));
        }
        // status.ts clientSnapshot: herdr's answer, or the status of an event applied during the read
        else if (config.overtake || w0.q.length === 0) add(`${typist} has read the pane ${t0.over ?? w0.h}`, (w, _inst, task) => {
          task.at = task.over !== null ? task.overAt : ++w.seq;
          task.ctx = task.over ?? w.h; task.reading = false; task.over = null; task.overAt = 0;
        });
        return;
      }
      if (t0.kind === "submit" && t0.pc === "read") {
        const accept = (w: World, inst: Inst, task: Task): void => {
          observe(w, inst, task, task.ctx!);
          nextId = task.id;
          try { inst.enqueue(task.owner, task.lane, NAMES.indexOf(task.id) + 1, task.id, null, IDENTITY, task.hold); } catch { /* refused: pending_uncertain */ }
          end(w, task);
        };
        if (t0.lost || t0.ctx === "blocked") {
          add("the submit is refused", (w, _inst, task) => end(w, task));
          // pendingContext: Codex with its question queue collapsed counts as at work, whatever herdr reads
          if (!t0.lost && config.agent === "codex") add(`Codex's questions are collapsed: accepted to ${t0.hold ? "hold" : "queue"} (observe blocked, enqueue)`, accept);
        }
        else if (resting(t0.ctx) && !t0.hold && !inst0.waiting(t0.lane)) add("nothing waits and the agent is at rest: typed at once, its Enter lands", (w, inst, task) => {
          if (config.atOnce && checks("NoAutomaticEnterIntoQueuedTurn") && w.waits.length > 0 && (w.turn === "queue" || w.aq.length > 0)) {
            throw new Violation("NoAutomaticEnterIntoQueuedTurn", `${task.id}, sent to the queue, was typed at once while the agent ${w.turn === "queue" ? "is on" : "has yet to begin"} the turn of ${w.waits[0]!.by}, whose wait is still open`);
          }
          // pending.ts: its committing, as a queued message's: PendingInputs.typedAtOnce
          inst.typedAtOnce(task.lane, false);
          enterLands(w, null, false);
          end(w, task);
        });
        else add(`accepted to ${t0.hold ? "hold" : "queue"} (observe ${t0.ctx}, enqueue)`, accept);
        return;
      }
      if (t0.kind === "auto" && t0.pc === "picked") {
        add("claimed by the queue", (w, inst, task) => {
          if (!inst.claim(item(inst, task.id), true)) { end(w, task); return; }
          if (checks("QueueWaitsForTurnEvidence") && w.waits.length > 0) throw new Violation("QueueWaitsForTurnEvidence", `the queue claimed ${task.id} while ${w.waits[0]!.by}'s turn has not been seen to ${w.waits[0]!.need.includes("W") ? "start" : "finish"}`);
          task.pc = "claimed";
        });
        return;
      }
      if (t0.kind === "auto" && t0.pc === "claimed") {
        add("the queue reads the pane (mark taken)", (_w, inst, task) => { task.mark = inst.mark(task.lane); task.fresh = true; task.reading = true; task.pc = "read1"; });
        return;
      }
      if (t0.kind === "auto" && t0.pc === "read1") {
        // dispatchPending: a refusal that only puts the send off is retried, unless hold() marked the message on its way
        const putOff = (code: string, status: St) => (w: World, inst: Inst, task: Task): void => {
          observe(w, inst, task, status);
          const left = item(inst, task.id).message.state === "uncertain";
          inst.settle(item(inst, task.id), F(left ? "pending_lease_lost" : code), false, !left);
          end(w, task);
        };
        if (t0.lost) add("refused, nothing typed: held", (w, inst, task) => { inst.settle(item(inst, task.id), F("pending_lease_lost"), false, false); end(w, task); });
        else if (t0.ctx === "working") add("the agent works again: put off (observe working)", putOff("pending_wait", "working"));
        else if (t0.ctx === "blocked") add("the agent waits for an answer: put off (observe blocked)", putOff("agent_blocked", "blocked"));
        else {
          add("pasted", (_w, _inst, task) => { task.pc = "pasted"; });
          add("refused before the paste: held", (w, inst, task) => { inst.settle(item(inst, task.id), F("target_changed"), false, false); end(w, task); });
          add("a prompt is on the screen: put off (observe blocked)", putOff("agent_blocked", "blocked"));
          // dispatchPendingText: omp still starting, or a skill to type that found the agent at work: pending_wait with no observe
          add("put off with no status told", (w, inst, task) => {
            const left = item(inst, task.id).message.state === "uncertain";
            inst.settle(item(inst, task.id), F(left ? "pending_lease_lost" : "pending_wait"), false, !left);
            end(w, task);
          });
          // dispatchPending: a screen of Codex's own (`unannounced`) holds the message and, in the same step, what waits behind it
          if (config.agent === "codex") add("a screen of Codex's own has the input: held, with what waits behind it", (w, inst, task) => {
            inst.settle(item(inst, task.id), F("agent_blocked"), false, false);
            inst.holdPane(item(inst, task.id).paneId, F("agent_blocked"));
            end(w, task);
          });
        }
        return;
      }
      if (t0.kind === "steer" && t0.pc === "s0") {
        // refused before its claim: the handler claims and settles it in one stretch
        add("Send now refused before it began", (w, inst, task) => { const it = item(inst, task.id); if (inst.claim(it, false)) inst.settle(it, F("agent_blocked"), false); end(w, task); });
        if (!t0.lost) add("claimed by Send now", (w, inst, task) => { if (inst.claim(item(inst, task.id), false)) task.pc = "sclaimed"; else end(w, task); });
        return;
      }
      if (t0.kind === "steer" && t0.pc === "sclaimed") {
        add("refused, nothing typed: held", (w, inst, task) => { inst.settle(item(inst, task.id), F("agent_blocked"), false, false); end(w, task); });
        if (!t0.lost) add("pasted", (_w, _inst, task) => { task.pc = "pasted"; });
        return;
      }
      if (t0.pc === "pasted") {
        // pending.ts: enterMark, the pane's event count as this read begins
        add(`${typist} reads the pane before its Enter`, (_w, inst, task) => { task.enterMark = inst.mark(task.lane); task.reading = true; task.pc = "read2"; });
        add("refused after the paste: uncertain", uncertain);
        return;
      }
      // where an Enter can land, as the agent is: [what happens, whether it waits in the agent's own queue]
      const landings = (steering: boolean): [string, boolean][] => {
        if (config.free) return [["its Enter lands", false]];
        if (w0.turn === null) return steering && !config.steerPastEnd ? [] : [["its Enter lands: the agent is at rest", false]];
        const own = config.agent === "codex" && steering;
        return [...(own ? [] : [["its Enter lands in the turn at work", false] as [string, boolean]]),
          ...(config.ownQueue || own ? [["its Enter lands and waits in the agent's own queue", true] as [string, boolean]] : [])];
      };
      if (t0.pc === "read2") {
        if (t0.lost || t0.ctx === "blocked" || (t0.kind === "auto" && !resting(t0.ctx))) { add("refused after the paste: uncertain", uncertain); return; }
        if (!config.free && !config.lateEvents && w0.q.length > 0) return;
        const steering = t0.kind === "steer" && t0.ctx === "working";
        const commit = (w: World, inst: Inst, task: Task): void => {
          task.steering = steering;
          inst.committing(item(inst, task.id), steering, false, task.enterMark);
          committed(w, task, steering ? "steer" : "start");
          task.pc = "committed";
        };
        // named apart, for a run to ask for: the commit that takes the place of a Codex restart's gate
        const overRestart = steering && w0.waits.some((wait) => wait.restart && wait.need.includes("W"));
        const named = `committing (${steering ? `steering a turn at work${overRestart ? ", over a restart not yet seen to start" : ""}` : "a turn to start"})`;
        if (config.slowEnter) add(named, commit);
        else {
          for (const [label, inQueue] of landings(steering)) add(`${named}; ${label}`, (w, inst, task) => { commit(w, inst, task); enterLands(w, task, inQueue); task.pc = "entered"; });
          add(`${named}; its Enter is refused or fails: uncertain`, (w, inst, task) => { commit(w, inst, task); uncertain(w, inst, task); });
        }
        return;
      }
      if (t0.pc === "committed") {
        add("its Enter is refused or fails: uncertain", uncertain);
        if (!t0.lost) for (const [label, inQueue] of landings(t0.steering)) add(label, (w, _inst, task) => { enterLands(w, task, inQueue); task.pc = "entered"; });
        return;
      }
      if (t0.pc === "entered" || t0.pc === "escaped") {
        const loops = t0.pc === "entered" && t0.steering && config.agent === "codex";
        if (!loops) add("sent", (w, inst, task) => { inst.settle(item(inst, task.id)); end(w, task); });
        add(loops ? "Codex's immediate delivery is not confirmed in time: uncertain" : "the send's outcome is not known: uncertain", uncertain);
        // codex-steering.ts interruptCodexSteering: read, and Escape once the steering panel shows the message
        if (loops) add("Send now reads the pane for Codex's steering panel", (_w, inst, task) => { task.statusAtRead = inst.current(task.lane) ?? "none"; task.reading = true; task.pc = "loop"; });
        return;
      }
      if (t0.pc === "loop") {
        if (t0.lost || t0.ctx === "blocked") add("refused: uncertain", uncertain);
        else if (t0.ctx !== "working") add("Codex is no longer at work: sent", (w, inst, task) => { inst.settle(item(inst, task.id)); end(w, task); });
        else {
          const shown = config.free ? [true, false] : [w0.turn !== null && w0.aq.includes(t0.id)];
          if (shown.includes(true) && (config.free || config.lateEvents || w0.q.length === 0)) add("the panel shows it: committing (restarting the turn)", (w, inst, task) => {
            inst.committing(item(inst, task.id), true, true);
            committed(w, task, "restart");
            task.pc = "escaping";
          });
          if (shown.includes(false)) add("the panel does not show it yet", (_w, _inst, task) => { task.pc = "entered"; });
        }
        return;
      }
      if (t0.pc === "escaping") {
        add("Escape is refused or fails: uncertain", uncertain);
        // pending.ts: the write is withheld when the pane's status moved since the read
        if (!t0.lost && (inst0.current(t0.lane) ?? "none") === t0.statusAtRead) add("Escape lands", (w, _inst, task) => {
          // Escape interrupts the turn at work; what waits in Codex's own queue then starts as a turn of its own
          if (!config.free) w.turn = null;
          task.pc = "escaped";
        });
      }
    };
    // ---- a held copy sent again: pending.ts pendingFrames.submit with a resend_id, typed with no claim and no commit ----
    if (live && !starting && told && free(w0.pane)) for (const r of inst0.records.values()) {
      if (r.paneId !== w0.pane || r.inFlight || (r.message.state !== "queued" && r.message.state !== "held")) continue;
      const id = r.message.id;
      out.push([`a saved copy of ${id} is sent again: typed`, async (w, inst) => {
        enterLands(w, null, false);
        await inst.resend(w.pane, id, "f", async () => ({ ok: true }));
      }]);
      out.push([`a saved copy of ${id} is sent again: its outcome is not known`, async (w, inst) => {
        await inst.resend(w.pane, id, "f", async () => ({ ok: false, ...F("submit_changed") }));
        handOver(w, inst);
      }]);
    }

    w0.tasks.forEach((t0, at) => taskSteps(t0, (label, run) => { out.push([`${t0.id}: ${label}`, run, at]); }));
    return out;
  };

  // ---- search -----------------------------------------------------------------------------------------------
  const init: World = { c: { records: [], statuses: [], events: [], gates: [] }, via: 0, turn: "base", aq: [], blocked: false, h: config.rest, q: [], base: null, baselines: 0, seq: 0, pane: "p", gone: false, moved: false, tasks: [], used: 0, others: 0, blocks: 0, waits: [], expiredGate: false };
  const take = async (from: string, step: Step): Promise<World> => {
    const next = JSON.parse(from) as World;
    next.via = taken(next.via, step[0]);
    const inst = restore(next.c);
    const waited = step[1](next, inst, step[2] === undefined ? (null as unknown as Task) : next.tasks[step[2]]!);
    if (waited) await waited;
    if (checks("QueueWaitsForTurnEvidence") && next.waits.length > 0) for (const pane of ["p", "q"]) {
      const offered = inst.next(pane);
      if (offered !== null) throw new Violation("QueueWaitsForTurnEvidence", `the queue is offered ${offered.message.id} while ${next.waits[0]!.by}'s turn has not been seen to ${next.waits[0]!.need.includes("W") ? "start" : "finish"}`);
    }
    save(inst, next);
    return next;
  };
  const needles = config.via ?? [];
  const taken = (count: number, label: string): number => (count < needles.length && label.includes(needles[count]!) ? count + 1 : count);
  let passed = 0;
  const stepsOf = (from: string): Step[] => { const w = JSON.parse(from) as World; return steps(w, restore(w.c)); };
  // a state is known by a 64-bit hash of its text; the queue keeps the text until the state has been expanded
  const seen = new Set<number | bigint>();
  const parent: number[] = [];
  const via: string[] = [];
  const queue: string[] = [];
  const start = JSON.stringify(init);
  seen.add(Bun.hash(start)); parent.push(-1); via.push(""); queue.push(start);
  let broken: Result["broken"] = null;
  // VTG_STEPS=1 lists how often each kind of step was taken: a kind that never is has become unreachable
  const kinds = process.env.VTG_STEPS ? new Map<string, number>() : null;
  const describe = (w: World): string => {
    const gate = w.c.gates.find(([pane]) => pane === w.pane)?.[1];
    const rows = w.c.records.filter((r) => r.p === w.pane).map((r) => `${r.id} ${r.f ? "on its way" : r.s}`).join(", ");
    return [
      `agent ${w.blocked ? "asks" : w.turn === null ? "at rest" : w.turn === "queue" ? "on a turn of the queue's" : "on a turn of its own"}${w.aq.length ? `, ${w.aq.join(" ")} in its own queue` : ""}`,
      `herdr reads ${w.h}${w.q.length ? `, events on their way: ${w.q.map((event) => event.s).join(" ")}` : ""}${w.base ? `, a reconcile's reading on its way: ${w.base.s}` : ""}`,
      `queue's status ${w.c.statuses.find(([pane]) => pane === w.pane)?.[1] ?? "none"}`,
      `gate ${gate ? `${gate.by}${gate.committed ? ` committed${gate.restart ? `, restart ${gate.restart}` : ""}${gate.sawWorking ? ", working seen" : ""}${gate.completed ? ", completed" : ""}${gate.deadline !== null ? `, deadline ${gate.deadline > 0 ? "running" : "passed"}` : ""}` : " claimed"}` : "none"}`,
      `rows: ${rows || "none"}`,
    ].join("; ");
  };
  for (let at = 0; at < queue.length && broken === null; at++) {
    const from = queue[at]!;
    queue[at] = "";
    for (const step of stepsOf(from)) {
      let next: World;
      try { next = await take(from, step); }
      catch (error) {
        if (!(error instanceof Violation)) throw error;
        if (taken((JSON.parse(from) as World).via, step[0]) < needles.length) { passed++; continue; }
        const labels: string[] = [step[0]];
        for (let up = at; parent[up]! >= 0; up = parent[up]!) labels.unshift(via[up]!);
        const path: { label: string; after: string }[] = [];
        let state = start;
        for (const label of labels.slice(0, -1)) {
          const after = await take(state, stepsOf(state).find((candidate) => candidate[0] === label)!);
          state = JSON.stringify(after);
          path.push({ label, after: describe(after) });
        }
        path.push({ label: step[0], after: error.why });
        broken = { rule: error.rule, why: error.why, steps: path };
        break;
      }
      if (kinds) { const kind = step[0].replace(/\b[XYZW]\b/g, "M").replace(/\b[ab]\b/g, "page"); kinds.set(kind, (kinds.get(kind) ?? 0) + 1); }
      const text = JSON.stringify(next);
      const hash = Bun.hash(text);
      if (seen.has(hash)) continue;
      seen.add(hash); parent.push(at); via.push(step[0]); queue.push(text);
      if (process.env.VTG_PROGRESS && parent.length % 100_000 === 0) console.error(`${config.name}: ${parent.length} states, ${queue.length - at} to go, ${Math.round((performance.now() - started) / 1000)} s`);
      if (parent.length > limit) throw new Error(`${config.name}: more than ${limit} states; the bounds grew`);
    }
  }
  if (kinds) for (const [kind, count] of [...kinds].sort(([a], [b]) => a.localeCompare(b))) console.error(`${String(count).padStart(9)}  ${kind}`);
  return { config, states: parent.length, ms: Math.round(performance.now() - started), passed, broken };
}
