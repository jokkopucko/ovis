// The queue's turn gate (#4118): once the queue has typed a message and its Enter, it types no further message of the
// pane until statuses that came after that Enter have shown the turn to start and to finish. A pane with Codex in
// front and one page, as in pending-left-lease.test.ts: the real createPendingDelivery, PendingInputs and
// interruptCodexSteering, with herdr's client faked. `on.keys` is what herdr and the agent do as a key lands.
import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { StatusCollectorDeps } from "../collector.ts";
import * as gjc from "../gjc-status.ts";
import * as herdr from "../herdr/client.ts";
import type { HerdrPane } from "../../shared/protocol.ts";
import { PendingInputs } from "../pending-input.ts";
import * as processStart from "../process-start.ts";
import { connectionData } from "./connections.ts";
import { createPendingDelivery } from "./pending.ts";
import { claude, handlers, hub, originalCollector, root } from "./status.fake.ts";

afterEach(() => { mock.restore(); });

type Row = { id: string; state: string; text: string; error?: { code: string } };
const steeringPanel = (entry: string) => `• Working (2s • esc to interrupt)\n• Messages to be submitted after next tool call (press esc to interrupt and send immediately)\n  ↳ ${entry}\n› Ask Codex to do anything\n  gpt-6.1 default · /workspace\n`;

function pane() {
  const typed: string[] = [];
  const now = { status: "working", screen: "" };
  const on: { keys?: (keys: string[]) => void; read?: (count: number) => void } = {};
  let reads = 0;
  spyOn(processStart, "processStartedAtAsync").mockImplementation(async () => 1000);
  spyOn(herdr, "paneProcessInfo").mockImplementation(async () => ({ pane_id: "p", shell_pid: 41000, foreground_processes: [{ pid: 41001, name: "codex", argv: ["codex"] }] }) as Awaited<ReturnType<typeof herdr.paneProcessInfo>>);
  spyOn(herdr, "paneRead").mockImplementation(async () => { on.read?.(++reads); return { text: now.screen } as Awaited<ReturnType<typeof herdr.paneRead>>; });
  // as herdrRpc does: the guard is asked right before the write, and a refused write sends nothing
  const refused = (guard?: () => boolean): void => { if (guard && !guard()) throw new herdr.HerdrError("cancelled", "the write was withheld"); };
  spyOn(herdr, "paneSendText").mockImplementation(async (_pane, text, _socket, guard) => { refused(guard); typed.push(text.replace("\u001b[200~", "paste:").replace("\u001b[201~", "")); });
  spyOn(herdr, "paneSendKeys").mockImplementation(async (_pane, keys, _socket, guard) => { refused(guard); typed.push(keys.join(",")); on.keys?.(keys); });
  const page = { data: connectionData({ deviceId: undefined, readOnly: false }), getBufferedAmount: () => 0, send: () => 1 };
  let tail: Promise<unknown> = Promise.resolve();
  const serialize = <T,>(_pane: string, run: () => T | Promise<T>): Promise<T> => { const next = tail.catch(() => {}).then(run); tail = next; return next; };
  const delivery = createPendingDelivery({
    options: { submitDelayMs: 0 }, clients: new Set<unknown>([page]), attachments: new Map(), serialize, lastTyped: new Map(),
    sight: () => ({ facts: () => ({ attached: true, origin: true, sameAttachment: true, samePty: true, sameClaim: true, claimed: true, member: true,
      ready: true, held: false, currentHeld: false, mirror: false, cols: 80 }), write: () => {} }),
    submitText: async () => { typed.push("immediate"); },
    authorizeSocket: () => {},
    clientSnapshot: async () => ({ panes: [{ pane_id: "p", terminal_id: "p", workspace_id: "w", tab_id: "t", agent: "codex", agent_status: now.status, focused: false, revision: 0 }] }),
    omo: { sessionOf: () => null }, SUBMIT_DEADLINE_MS: 45_000, SUBMIT_DELAY_MS: 0, TYPED_SETTLE_MS: 0,
  } as unknown as Parameters<typeof createPendingDelivery>[0]);
  const settled = async () => {
    for (let turn = 0; turn < 20; turn++) {
      for (let before: unknown; before !== tail;) { before = tail; await tail.catch(() => {}); }
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  };
  page.data.attached.set("p", { keepSize: false });
  /** what status.ts does with a status event of herdr's: pending.status, then drainPending */
  const event = (status: "working" | "idle"): void => { delivery.pending.status("p", status); delivery.drainPending("p"); };
  let id = 0;
  /** a chat message sent while the agent works: pendingFrames.submit with delivery "queue" */
  const queue = async (text: string): Promise<void> => { await delivery.pendingFrames.submit(page as never, { type: "submit", id: ++id, pane_id: "p", text, payload: text, delivery: "queue" } as never); };
  const rows = (): string[] => (delivery.pending.list(page as never, "p") as Row[]).map((row) => `${row.text} ${row.state}`);
  /** Send now on a pending row: pendingFrames["pending-action"], action "steer" */
  const sendNow = (text: string): Promise<void> => {
    const row = (delivery.pending.list(page as never, "p") as Row[]).find((candidate) => candidate.text === text);
    if (!row) throw new Error(`no row ${text}`);
    return delivery.pendingFrames["pending-action"](page as never, { type: "pending-action", id: ++id, pane_id: "p", pending_id: row.id, action: "steer" } as never);
  };
  /** herdr reads the turn the queue's last Enter started, and its end: the queue goes on */
  const turnSeen = async (): Promise<void> => {
    on.keys = undefined;
    now.status = "working"; event("working");
    now.status = "idle"; event("idle");
    await settled();
  };
  return { delivery, typed, now, on, settled, event, queue, rows, sendNow, turnSeen };
}

describe("the queue's turn gate (#4118)", () => {
  it("A: types nothing behind a Send now whose Enter landed as the turn ended, until that Enter's own turn is seen", async () => {
    const d = pane();
    d.event("working");
    await d.queue("X");
    await d.queue("Y");
    // every read of X's send says working; its Enter lands as the turn ends, and that turn's idle is applied right after
    d.on.keys = (keys) => {
      if (!keys.includes("Enter") || d.typed.filter((key) => key === "Enter").length !== 1) return;
      d.now.status = "idle";
      d.event("idle");
    };
    await d.sendNow("X");
    await d.settled();
    expect(d.typed).toEqual(["paste:X", "Enter"]);
    expect(d.rows()).toEqual(["Y queued"]);
    await d.turnSeen();
    expect(d.typed).toEqual(["paste:X", "Enter", "paste:Y", "Enter"]);
  });

  it("A': a ready told just before a Send now's Enter makes that Enter a turn of its own, which a later submit's idle reading does not end", async () => {
    const d = pane();
    d.event("working");
    await d.queue("X");
    await d.queue("Y");
    // the 6th screen read of a Send now is the last before its Enter (noMaskedPrompt), after the read that said working
    d.on.read = (count) => { if (count === 6) { d.now.status = "idle"; d.delivery.pending.status("p", "idle"); } };
    await d.sendNow("X");
    await d.settled();
    expect(d.typed).toEqual(["paste:X", "Enter"]);
    expect(d.delivery.pending.current("p")).toBe("idle");
    // herdr still reads idle (X's turn has begun, herdr has not said so); the user queues Z
    await d.queue("Z");
    await d.settled();
    expect(d.typed).toEqual(["paste:X", "Enter"]);
    expect(d.rows()).toEqual(["Y queued", "Z queued"]);
  });

  // B stays open (#4118): no herdr event carries its order against a snapshot, and every rule that takes an event as older
  // than a snapshot held the queue when herdr never sent the event a snapshot's reading was waiting for (#4158)
  it("B (open, #4118): status events that a snapshot overtook still pass for the turn the queue's Enter started", async () => {
    const d = pane();
    // herdr's working event is still on its way when X is queued from a snapshot that says working
    await d.queue("X");
    // the turn ends, and the snapshot of Y's submit says so before the events do: the queue takes up X
    d.now.status = "idle";
    // as X's Enter is written, the two events of the old turn are applied
    d.on.keys = (keys) => {
      if (!keys.includes("Enter") || d.typed.filter((key) => key === "Enter").length !== 1) return;
      d.event("working");
      d.event("idle");
    };
    await d.queue("Y");
    await d.settled();
    // once fixed: ["paste:X", "Enter"], with Y queued until X's own turn is seen
    expect(d.typed).toEqual(["paste:X", "Enter", "paste:Y", "Enter"]);
  });

  it("C: a second Send now during a Codex restart keeps waiting for the restarted turn to start", async () => {
    const d = pane();
    d.event("working");
    await d.queue("X");
    await d.queue("Y");
    await d.queue("Z");
    // Send now on X: after its Enter Codex shows it in the steering panel, and Escape is pressed
    d.on.keys = (keys) => {
      if (keys.includes("Enter")) d.now.screen = steeringPanel("X");
      if (keys.includes("Escape")) d.now.screen = "";
    };
    await d.sendNow("X");
    await d.settled();
    expect(d.typed).toEqual(["paste:X", "Enter", "Escape"]);
    // Send now on Y while herdr still reads working; herdr's idle for the interruption is applied after Y's Enter
    d.on.keys = (keys) => {
      if (!keys.includes("Enter")) return;
      d.now.status = "idle";
      d.event("idle");
    };
    await d.sendNow("Y");
    await d.settled();
    expect(d.typed).toEqual(["paste:X", "Enter", "Escape", "paste:Y", "Enter"]);
    expect(d.rows()).toEqual(["Z queued"]);
    await d.turnSeen();
    expect(d.typed).toEqual(["paste:X", "Enter", "Escape", "paste:Y", "Enter", "paste:Z", "Enter"]);
  });

  it("C control: without the second Send now, the interruption's idle types nothing", async () => {
    const d = pane();
    d.event("working");
    await d.queue("X");
    await d.queue("Y");
    d.on.keys = (keys) => {
      if (keys.includes("Enter")) d.now.screen = steeringPanel("X");
      if (keys.includes("Escape")) d.now.screen = "";
    };
    await d.sendNow("X");
    await d.settled();
    d.now.status = "idle";
    d.event("idle");
    await d.settled();
    expect(d.typed).toEqual(["paste:X", "Enter", "Escape"]);
    expect(d.rows()).toEqual(["Y queued"]);
  });

  it("E: a message sent to the queue right behind the queue's Enter waits behind that Enter's turn", async () => {
    const d = pane();
    d.event("working");
    await d.queue("X");
    // the turn ends and the queue types X; herdr has not read X's turn yet
    d.now.status = "idle";
    d.event("idle");
    await d.settled();
    expect(d.typed).toEqual(["paste:X", "Enter"]);
    await d.queue("Y");
    await d.settled();
    expect(d.typed).toEqual(["paste:X", "Enter"]);
    expect(d.rows()).toEqual(["Y queued"]);
    await d.turnSeen();
    expect(d.typed).toEqual(["paste:X", "Enter", "paste:Y", "Enter"]);
  });

  it("E': a message sent to the queue right behind one the queue typed at once on a pane at rest waits behind its turn", async () => {
    const d = pane();
    d.now.status = "idle";
    d.event("idle");
    await d.queue("X");
    await d.settled();
    expect(d.typed).toEqual(["paste:X", "Enter"]);
    await d.queue("Y");
    await d.settled();
    expect(d.typed).toEqual(["paste:X", "Enter"]);
    expect(d.rows()).toEqual(["Y queued"]);
    await d.turnSeen();
    expect(d.typed).toEqual(["paste:X", "Enter", "paste:Y", "Enter"]);
  });

  it("D: a reconcile's older idle snapshot, told after the working event of the turn just started, does not end that turn's wait", async () => {
    const PANE = "w1:p1";
    const shown = (status: string) => ({ pane_id: PANE, workspace_id: "w1", tab_id: "w1:t1", agent: "pi", agent_status: status, cwd: root });
    const pending = new PendingInputs<string, null>(() => {});
    const h = hub(undefined, pending);
    // the real collector, with herdr's two channels faked: the status subscription, and a snapshot that can be held
    type Callbacks = Parameters<StatusCollectorDeps["subscribe"]>[1];
    const subscriptions: { types: string[]; callbacks: Callbacks }[] = [];
    let panes = [shown("working")];
    let held: Promise<void> | null = null;
    let released = false;
    const asked = Promise.withResolvers<void>(), reconciled = Promise.withResolvers<void>();
    const collector = originalCollector({ ...handlers, onReconciled: (read: readonly HerdrPane[]) => { handlers.onReconciled(read); if (released) reconciled.resolve(); } } as never, {
      reconnectMinMs: 5, reconnectMaxMs: 40, backstopMs: 60_000, debounceMs: 5, snapshotRetryMs: 5, replaySettleMs: 5,
      subscribe: (subs, callbacks) => { subscriptions.push({ types: subs.map((sub) => sub.type), callbacks }); queueMicrotask(() => callbacks.onStarted?.()); return { close() {} }; },
      snapshot: async () => { const read = { panes: structuredClone(panes) }; if (held) { asked.resolve(); await held; } return read as never; },
    });
    const emit = (status: string) => subscriptions.filter((sub) => sub.types.includes("pane.agent_status_changed")).at(-1)?.callbacks.onEvent({ event: "pane.agent_status_changed", data: { pane_id: PANE, agent_status: status, agent: "pi" } });
    try {
      h.herdrSays(shown("working"));
      await collector.ready;
      emit("working");
      const x = pending.enqueue("a", PANE, 1, "X", null, { agent: "pi", terminalId: PANE, session: null });
      const y = pending.enqueue("a", PANE, 2, "Y", null, { agent: "pi", terminalId: PANE, session: null });
      // the turn ends; the queue types X, as drainPending and dispatchPending do with the class
      panes = [shown("idle")]; h.herdrSays(shown("idle"));
      emit("idle");
      expect(pending.next(PANE)).toBe(x);
      expect(pending.claim(x, true)).toBe(true);
      pending.committing(x);
      pending.settle(x);
      // a reconcile reads its snapshot while herdr still reads the pane at rest, and the read takes a while
      const release = Promise.withResolvers<void>();
      held = release.promise;
      collector.refresh();
      await asked.promise;
      // herdr reads X's turn; then the reconcile goes on with the snapshot it read before that event
      emit("working");
      held = null;
      released = true;
      release.resolve();
      await reconciled.promise;
      expect(pending.next(PANE)).toBeNull();
      emit("idle");
      expect(pending.next(PANE)).toBe(y);
    } finally { collector.stop(); }
  });

  it("keeps the queue behind a running turn, held by nothing, when a reconcile reads that turn however long it runs", () => {
    let clock = 0;
    const pending = new PendingInputs<string, null>(() => {}, () => clock, 10);
    const identity = { agent: "codex", terminalId: "p", session: null };
    pending.status("p", "working");
    const x = pending.enqueue("a", "p", 1, "X", null, identity);
    const y = pending.enqueue("a", "p", 2, "Y", null, identity);
    pending.status("p", "idle");
    expect(pending.claim(x, true)).toBe(true);
    pending.committing(x);
    pending.settle(x);
    pending.status("p", "working");
    clock = 5;
    pending.baseline("p", "working", 5);
    clock = 60;
    expect(pending.expire()).toEqual([]);
    expect(y.message.state).toBe("queued");
    pending.status("p", "idle");
    expect(pending.next("p")).toBe(y);
  });

  it("B (open, #4118): the older events a reconcile's ready duplicates still pass for the turn of the Enter before it", () => {
    let clock = 0;
    const pending = new PendingInputs<string, null>(() => {}, () => clock, 10);
    const identity = { agent: "codex", terminalId: "p", session: null };
    const x = pending.enqueue("a", "p", 1, "X", null, identity);
    pending.enqueue("a", "p", 2, "Y", null, identity);
    pending.observe("p", "working", pending.mark("p"));
    pending.observe("p", "idle", pending.mark("p"));
    expect(pending.claim(x, true)).toBe(true);
    pending.committing(x);
    pending.settle(x);
    clock = 1;
    pending.baseline("p", "idle", 1);
    pending.status("p", "working");
    pending.status("p", "idle");
    // once fixed: null, until X's own turn is seen
    expect(pending.next("p")?.message.text).toBe("Y");
  });

  it("gives a Send now over a Codex restart whose start timeout passed a start timeout of its own", () => {
    let clock = 0;
    const pending = new PendingInputs<string, null>(() => {}, () => clock, 10);
    const identity = { agent: "codex", terminalId: "p", session: null };
    pending.status("p", "working");
    const x = pending.enqueue("a", "p", 1, "X", null, identity);
    const y = pending.enqueue("a", "p", 2, "Y", null, identity);
    expect(pending.claim(x, false)).toBe(true);
    pending.committing(x, true, true);
    clock = 10;
    expect(pending.expire()).toEqual([]);
    pending.settle(x);
    expect(pending.claim(y, false)).toBe(true);
    pending.committing(y);
    pending.settle(y);
    expect(pending.expire()).toEqual([]);
    pending.enqueue("a", "p", 3, "Z", null, identity);
    pending.status("p", "idle");
    expect(pending.next("p")).toBeNull();
  });

  it("takes a Send now's read at rest after a Codex restart's Escape as that restart's ready, so the turn after it ends the wait", () => {
    let clock = 0;
    const pending = new PendingInputs<string, null>(() => {}, () => clock, 10);
    const identity = { agent: "codex", terminalId: "p", session: null };
    pending.status("p", "working");
    const x = pending.enqueue("a", "p", 1, "X", null, identity);
    const y = pending.enqueue("a", "p", 2, "Y", null, identity);
    const z = pending.enqueue("a", "p", 3, "Z", null, identity);
    expect(pending.claim(x, false)).toBe(true);
    pending.committing(x, true, true);
    pending.settle(x);
    expect(pending.claim(y, false)).toBe(true);
    pending.committing(y);
    pending.settle(y);
    pending.status("p", "working");
    clock = 10;
    expect(pending.expire()).toEqual([]);
    expect(z.message.state).toBe("queued");
    pending.status("p", "idle");
    expect(pending.next("p")).toBe(z);
  });

  it("takes a Send now's read at work after a Codex restart's ready as the restarted turn it joins, and waits for that turn's end", () => {
    let clock = 0;
    const pending = new PendingInputs<string, null>(() => {}, () => clock, 10);
    const identity = { agent: "codex", terminalId: "p", session: null };
    pending.status("p", "working");
    const x = pending.enqueue("a", "p", 1, "X", null, identity);
    const y = pending.enqueue("a", "p", 2, "Y", null, identity);
    const z = pending.enqueue("a", "p", 3, "Z", null, identity);
    expect(pending.claim(x, false)).toBe(true);
    pending.committing(x, true, true);
    pending.settle(x);
    pending.status("p", "idle");
    expect(pending.claim(y, false)).toBe(true);
    // read at work after that ready, with no status since
    pending.committing(y, true, false, pending.mark("p"));
    pending.settle(y);
    clock = 10;
    expect(pending.expire()).toEqual([]);
    expect(z.message.state).toBe("queued");
    pending.status("p", "working");
    pending.status("p", "idle");
    expect(pending.next("p")).toBe(z);
  });

  it("takes a Send now's read at work made before a Codex restart's ready as the turn Escape ended, not the restarted one", () => {
    let clock = 0;
    const pending = new PendingInputs<string, null>(() => {}, () => clock, 10);
    const identity = { agent: "codex", terminalId: "p", session: null };
    pending.status("p", "working");
    const x = pending.enqueue("a", "p", 1, "X", null, identity);
    const y = pending.enqueue("a", "p", 2, "Y", null, identity);
    pending.enqueue("a", "p", 3, "Z", null, identity);
    expect(pending.claim(x, false)).toBe(true);
    pending.committing(x, true, true);
    pending.settle(x);
    expect(pending.claim(y, false)).toBe(true);
    // Y's read at work begins; the interruption's ready comes before its Enter
    const readMark = pending.mark("p");
    pending.status("p", "idle");
    pending.committing(y, true, false, readMark);
    pending.settle(y);
    // a ready well after Y's Enter, the restarted turn never seen
    clock = 11;
    pending.status("p", "idle");
    expect(pending.next("p")).toBeNull();
  });

  it("takes a reconcile's ready asked for after the Enter but before a later reading of the turn as no end of that turn", () => {
    let clock = 0;
    const pending = new PendingInputs<string, null>(() => {}, () => clock, 10);
    const identity = { agent: "codex", terminalId: "p", session: null };
    pending.status("p", "idle");
    const x = pending.enqueue("a", "p", 1, "X", null, identity);
    pending.enqueue("a", "p", 2, "Y", null, identity);
    expect(pending.claim(x, true)).toBe(true);
    pending.committing(x);
    pending.settle(x);
    clock = 2;
    pending.observe("p", "working", pending.mark("p"));
    pending.baseline("p", "idle", 1);
    expect(pending.next("p")).toBeNull();
  });

  it("takes the status events after a first baseline asked before a submit's read, and opens the queue at the turn's end", () => {
    let clock = 0;
    const pending = new PendingInputs<string, null>(() => {}, () => clock, 10);
    const identity = { agent: "claude", terminalId: "p", session: null };
    // a send to the queue reads the agent at work before the collector's first baseline; that baseline was asked before it
    clock = 2;
    pending.observe("p", "working", pending.mark("p"));
    const x = pending.enqueue("a", "p", 1, "X", null, identity);
    const y = pending.enqueue("a", "p", 2, "Y", null, identity);
    pending.baseline("p", "working", 1);
    // the turn at work ends: the queue types X, and herdr reads X's turn start and end
    pending.status("p", "idle");
    expect(pending.next("p")).toBe(x);
    expect(pending.claim(x, true)).toBe(true);
    pending.committing(x);
    pending.settle(x);
    pending.status("p", "working");
    pending.status("p", "idle");
    expect(pending.next("p")).toBe(y);
  });

  it("leaves the pane's status alone for a reconcile's baseline asked before a reading already taken", () => {
    let clock = 0;
    const pending = new PendingInputs<string, null>(() => {}, () => clock, 10);
    pending.status("p", "idle");
    clock = 2;
    pending.observe("p", "working", pending.mark("p"));
    pending.baseline("p", "idle", 1);
    expect(pending.current("p")).toBe("working");
  });

  it("ends a Send now's wait without holding the queue when no turn of its own starts after the ready that came right behind it", () => {
    let clock = 0;
    const pending = new PendingInputs<string, null>(() => {}, () => clock, 10);
    const identity = { agent: "codex", terminalId: "p", session: null };
    pending.status("p", "working");
    const x = pending.enqueue("a", "p", 1, "X", null, identity);
    const y = pending.enqueue("a", "p", 2, "Y", null, identity);
    expect(pending.claim(x, false)).toBe(true);
    pending.committing(x, true);
    pending.status("p", "idle");
    pending.settle(x);
    expect(pending.next("p")).toBeNull();
    clock = 10;
    expect(pending.expire()).toEqual(["p"]);
    expect(pending.next("p")).toBe(y);
    expect(y.message.state).toBe("queued");
  });
});

// herdr's status subscription lost or replaced: what the collector reads back from its snapshot is a snapshot, and one asked for
// before the queue's Enter says nothing of that Enter's turn. The real collector and status hub, with herdr's channels faked.
const reconnectPane = "w1:p1";
const shownAt = (status: string, agent: string | null = "pi") => ({ pane_id: reconnectPane, workspace_id: "w1", tab_id: "w1:t1", agent, agent_status: status, cwd: root }) as HerdrPane;

function reconnectQueue(now: () => number) {
  const pending = new PendingInputs<string, null>(() => {}, now, 10);
  const identity = { agent: "pi", terminalId: reconnectPane, session: null };
  const first = pending.enqueue("a", reconnectPane, 1, "X", null, identity);
  const followup = pending.enqueue("a", reconnectPane, 2, "Y", null, identity);
  const enter = () => {
    expect(pending.next(reconnectPane)).toBe(first);
    expect(pending.claim(first, true)).toBe(true);
    pending.committing(first);
    pending.settle(first);
  };
  return { pending, followup, enter };
}

it("a resync after lost events takes a snapshot asked for before the Enter as no start of its turn (#4118)", async () => {
  let clock = Date.now();
  const { pending, enter } = reconnectQueue(() => clock);
  const status = hub(undefined, pending);
  let panes = [shownAt("idle")];
  let held: Promise<void> | undefined;
  const asked = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const resynced = Promise.withResolvers<void>();
  type Callbacks = Parameters<StatusCollectorDeps["subscribe"]>[1];
  let statusCallbacks: Callbacks | undefined;
  let subscriptions = 0;
  const collector = originalCollector({ ...handlers, onResync: (read: readonly HerdrPane[], newer: ReadonlySet<string>, askedAt: number) => {
    handlers.onResync(read, newer, askedAt);
    resynced.resolve();
  } } as never, {
    reconnectMinMs: 5, reconnectMaxMs: 40, backstopMs: 60_000, debounceMs: 5, snapshotRetryMs: 5, replaySettleMs: 5,
    subscribe: (subs, callbacks) => {
      if (subs.some(sub => sub.type === "pane.agent_status_changed")) {
        statusCallbacks = callbacks;
        if (++subscriptions === 2) {
          panes = [shownAt("working")];
          held = release.promise;
        }
        queueMicrotask(() => callbacks.onStarted?.());
      }
      return { close() {} };
    },
    snapshot: async () => {
      const read = { panes: structuredClone(panes) };
      if (held) { asked.resolve(); await held; }
      return read;
    },
  });
  try {
    status.herdrSays(shownAt("idle"));
    await collector.ready;
    statusCallbacks!.onClose?.();
    await asked.promise;
    expect(subscriptions).toBe(2);
    clock = Date.now() + 1;
    panes = [shownAt("idle")];
    enter();
    held = undefined;
    release.resolve();
    await resynced.promise;
    expect(pending.next(reconnectPane)).toBeNull();
    statusCallbacks!.onEvent({ event: "pane.agent_status_changed", data: { pane_id: reconnectPane, agent: "pi", agent_status: "idle" } });
    expect(pending.next(reconnectPane)).toBeNull();
  } finally { release.resolve(); collector.stop(); }
});

it("a replay when the subscription is replaced takes a status read before the Enter as no start of its turn (#4118)", async () => {
  let clock = Date.now();
  const { pending, enter } = reconnectQueue(() => clock);
  const status = hub(undefined, pending);
  let panes = [shownAt("idle")];
  let held: Promise<void> | undefined;
  const asked = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const replaced = Promise.withResolvers<void>();
  const replayed: string[] = [];
  type Callbacks = Parameters<StatusCollectorDeps["subscribe"]>[1];
  let statusCallbacks: Callbacks | undefined;
  let subscriptions = 0;
  const collector = originalCollector({ ...handlers, onStatus: (...args: Parameters<typeof handlers.onStatus>) => {
    const [id, phase, , replay] = args;
    handlers.onStatus(...args);
    if (replay) replayed.push(`${id}:${phase}`);
  } } as never, {
    backstopMs: 60_000, debounceMs: 1, replaySettleMs: 1,
    subscribe: (subs, callbacks) => {
      if (subs.some(sub => sub.type === "pane.agent_status_changed")) {
        statusCallbacks = callbacks;
        if (++subscriptions === 1) queueMicrotask(() => callbacks.onStarted?.());
        else replaced.resolve();
      } else queueMicrotask(() => callbacks.onStarted?.());
      return { close() {} };
    },
    snapshot: async () => {
      const read = { panes: structuredClone(panes) };
      if (held) { asked.resolve(); await held; }
      return read;
    },
  });
  try {
    status.herdrSays(shownAt("idle"));
    await collector.ready;
    panes = [shownAt("working"), { ...shownAt("idle"), pane_id: "w1:p2" }];
    held = release.promise;
    collector.refresh();
    await asked.promise;
    clock = Date.now() + 1;
    enter();
    held = undefined;
    release.resolve();
    await replaced.promise;
    expect(replayed).toEqual([`${reconnectPane}:working`]);
    expect(pending.next(reconnectPane)).toBeNull();
    panes = [shownAt("idle"), panes[1]!];
    statusCallbacks!.onStarted?.();
    statusCallbacks!.onEvent({ event: "pane.agent_status_changed", data: { pane_id: reconnectPane, agent: "pi", agent_status: "idle" } });
    expect(pending.next(reconnectPane)).toBeNull();
  } finally { release.resolve(); collector.stop(); }
});

// a status only the collector's second pass of a snapshot tells (a Codex finish, codex/unknown at rest) reaches the queue:
// the reading the baseline of that snapshot took is no newer than the snapshot itself (#4158's stalled Codex finish)
describe("a snapshot told twice", () => {
  const PANE = "w1:p1";
  const shown = (id: string, status: string) => ({ pane_id: id, workspace_id: "w1", tab_id: "w1:t1", agent: "codex", agent_status: status, cwd: root });
  type Callbacks = Parameters<StatusCollectorDeps["subscribe"]>[1];
  const start = (onPass: (kind: "replay" | "resync") => void) => {
    const pending = new PendingInputs<string, null>(() => {});
    const h = hub(undefined, pending);
    const subscribed = [Promise.withResolvers<Callbacks>(), Promise.withResolvers<Callbacks>()] as const;
    let count = 0;
    const read = { panes: [shown(PANE, "working")] };
    const collector = originalCollector({ ...handlers,
      onResync: (...args: Parameters<typeof handlers.onResync>) => { handlers.onResync(...args); onPass("resync"); },
      onStatus: (...args: Parameters<typeof handlers.onStatus>) => { handlers.onStatus(...args); if (args[3]) onPass("replay"); },
    } as never, {
      reconnectMinMs: 5, reconnectMaxMs: 40, backstopMs: 60_000, debounceMs: 5, snapshotRetryMs: 5, replaySettleMs: 5,
      subscribe: (types, callbacks) => {
        if (types.some((sub) => sub.type === "pane.agent_status_changed")) subscribed[count++]?.resolve(callbacks);
        else queueMicrotask(() => callbacks.onStarted?.());
        return { close() {} };
      },
      snapshot: async () => structuredClone(read) as never,
    });
    h.herdrSays(read.panes[0]);
    return { pending, collector, subscribed, read };
  };

  it("takes a Codex finish told by the collector's replay after a re-subscription", async () => {
    const replayed = Promise.withResolvers<void>();
    const { pending, collector, subscribed, read } = start((kind) => { if (kind === "replay") replayed.resolve(); });
    try {
      const first = await subscribed[0].promise;
      first.onStarted?.();
      await collector.ready;
      first.onEvent({ event: "pane.agent_status_changed", data: { pane_id: PANE, agent_status: "working", agent: "codex" } });
      const x = pending.enqueue("a", PANE, 1, "X", null, { agent: "codex", terminalId: PANE, session: null });
      expect(pending.next(PANE)).toBeNull();
      // another pane opens and the collector subscribes again; Codex finishes before that subscription starts
      read.panes = [shown(PANE, "working"), shown("w1:p2", "idle")];
      collector.refresh();
      const second = await subscribed[1].promise;
      read.panes = [shown(PANE, "unknown"), shown("w1:p2", "idle")];
      second.onStarted?.();
      await replayed.promise;
      expect(pending.next(PANE)).toBe(x);
    } finally { collector.stop(); }
  });

  it("takes a Codex finish told by the collector's resync after lost events", async () => {
    const resynced = Promise.withResolvers<void>();
    const { pending, collector, subscribed, read } = start((kind) => { if (kind === "resync") resynced.resolve(); });
    try {
      const first = await subscribed[0].promise;
      first.onStarted?.();
      await collector.ready;
      first.onEvent({ event: "pane.agent_status_changed", data: { pane_id: PANE, agent_status: "working", agent: "codex" } });
      const x = pending.enqueue("a", PANE, 1, "X", null, { agent: "codex", terminalId: PANE, session: null });
      expect(pending.next(PANE)).toBeNull();
      // herdr closes the subscriber; Codex finishes while nobody listens
      read.panes = [shown(PANE, "unknown")];
      first.onClose?.();
      (await subscribed[1].promise).onStarted?.();
      await resynced.promise;
      expect(pending.next(PANE)).toBe(x);
    } finally { collector.stop(); }
  });
});

it("keeps a resting GJC pane's queue ready through a reconcile that reads its provider child at work", async () => {
  const pending = new PendingInputs<string, null>(() => {});
  const h = hub(undefined, pending);
  const pane = { ...claude, agent: "gjc", agent_status: "working", agent_session: null, focused: false, revision: 0, terminal_id: "test" } as unknown as HerdrPane;
  const message = (role: string, stopReason?: string) => JSON.stringify({ type: "message", id: "x", parentId: null, timestamp: "2026-10-02T00:00:10.000Z", message: { role, content: [{ type: "text", text: "" }], ...(stopReason ? { stopReason } : {}) } });
  const path = join(root, "gjc-rest.jsonl");
  writeFileSync(path, `${message("user")}\n`);
  spyOn(gjc, "gjcPanes").mockResolvedValue(new Map([[pane.pane_id, { path, startedAt: null }]]));
  h.herdrSays(pane);
  const tracker = h.status.gjc;
  try {
    await tracker.refresh([pane]);
    // GJC's own turn ends; herdr still reads its provider child at work
    writeFileSync(path, `${message("user")}\n${message("assistant", "stop")}\n`);
    await tracker.poll();
    const x = pending.enqueue("a", pane.pane_id, 1, "X", null, { agent: "gjc", terminalId: pane.pane_id, session: null });
    expect(pending.next(pane.pane_id)).toBe(x);
    // a reconcile's baseline, asked after the queue's last reading
    const onBaseline = handlers.onBaseline as (panes: readonly HerdrPane[], newer: ReadonlySet<string>, askedAt: number) => void;
    onBaseline([pane], new Set(), Date.now() + 1);
    expect(pending.next(pane.pane_id)).toBe(x);
  } finally { tracker.stop(); }
});

describe("a collector snapshot is judged by when it was asked", () => {
  const identity = { agent: "codex", terminalId: "p", session: null };
  const setup = () => {
    const clock = { now: 0 };
    const pending = new PendingInputs<string, null>(() => {}, () => clock.now, 10);
    const x = pending.enqueue("a", "p", 1, "X", null, identity);
    const y = pending.enqueue("a", "p", 2, "Y", null, identity);
    return { clock, pending, x, y };
  };

  it("takes no second pass of a snapshot over a reading taken after it", () => {
    const { clock, pending, x } = setup();
    pending.status("p", "idle");
    expect(pending.claim(x, true)).toBe(true);
    clock.now = 1;
    pending.committing(x);
    pending.settle(x);
    // a reconcile asked after the Enter reads the pane at rest, before X's turn starts
    clock.now = 2;
    pending.baseline("p", "idle", 2);
    // a later read sees X's turn at work; then the collector replays that older snapshot
    clock.now = 3;
    pending.observe("p", "working", pending.mark("p"));
    pending.baseline("p", "idle", 2);
    expect(pending.next("p")).toBeNull();
  });

  it("leaves a read under way alone when a snapshot older than the last reading is refused", () => {
    const { clock, pending, x, y } = setup();
    pending.status("p", "idle");
    expect(pending.claim(x, true)).toBe(true);
    clock.now = 1;
    pending.committing(x);
    pending.settle(x);
    clock.now = 3;
    pending.status("p", "working");
    // a submit starts reading the pane; a snapshot asked before X's working is told and refused
    const mark = pending.mark("p");
    pending.baseline("p", "idle", 2);
    clock.now = 4;
    pending.observe("p", "idle", mark);
    expect(pending.next("p")).toBe(y);
  });

  it("judges a Send now's joined window by when the snapshot was asked, not when it came", () => {
    const { clock, pending, x } = setup();
    pending.status("p", "working");
    expect(pending.claim(x, false)).toBe(true);
    pending.committing(x, true);
    pending.settle(x);
    // a snapshot asked inside the window reads the pane at rest between the joined turn and the Send now's own; it
    // reaches the queue after the window
    clock.now = 11;
    pending.baseline("p", "idle", 5);
    expect(pending.next("p")).toBeNull();
  });
});

it("takes no second pass of a snapshot over a read in the same millisecond", () => {
  let clock = 0;
  const pending = new PendingInputs<string, null>(() => {}, () => clock, 10);
  const identity = { agent: "codex", terminalId: "p", session: null };
  const x = pending.enqueue("a", "p", 1, "X", null, identity);
  pending.enqueue("a", "p", 2, "Y", null, identity);
  pending.status("p", "idle");
  expect(pending.claim(x, true)).toBe(true);
  clock = 1;
  pending.committing(x);
  pending.settle(x);
  clock = 2;
  pending.baseline("p", "idle", 2);
  pending.observe("p", "working", pending.mark("p"));
  pending.baseline("p", "idle", 2);
  expect(pending.next("p")).toBeNull();
});

it("takes no tracker's remembered working from a reconcile that reads no status as the start of the queue's turn", () => {
  const pending = new PendingInputs<string, null>(() => {});
  hub(undefined, pending);
  const PANE = "w1:p1";
  const shown = (status: string) => ({ pane_id: PANE, workspace_id: "w1", tab_id: "w1:t1", agent: "codex", agent_status: status, cwd: root }) as unknown as HerdrPane;
  const onBaseline = handlers.onBaseline as (panes: readonly HerdrPane[], newer: ReadonlySet<string>, askedAt: number) => void;
  const now = Date.now();
  handlers.onStatus(PANE, "working", "codex");
  const x = pending.enqueue("a", PANE, 1, "X", null, { agent: "codex", terminalId: PANE, session: null });
  pending.enqueue("a", PANE, 2, "Y", null, { agent: "codex", terminalId: PANE, session: null });
  onBaseline([shown("idle")], new Set(), now + 1000);
  expect(pending.next(PANE)).toBe(x);
  expect(pending.claim(x, true)).toBe(true);
  pending.committing(x);
  pending.settle(x);
  // herdr's snapshot reads no status (codex/unknown): the tracker still remembers the turn before as working
  onBaseline([shown("unknown")], new Set(), now + 2000);
  onBaseline([shown("idle")], new Set(), now + 3000);
  expect(pending.next(PANE)).toBeNull();
});
