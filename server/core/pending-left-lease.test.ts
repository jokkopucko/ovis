import { afterEach, expect, it, mock, spyOn } from "bun:test";
import * as herdr from "../herdr/client.ts";
import * as processStart from "../process-start.ts";
import { connectionData } from "./connections.ts";
import { createPendingDelivery, FIRST_MESSAGE_OWNER } from "./pending.ts";

afterEach(() => { mock.restore(); });

type Row = { id: string; state: string; error?: { code: string } };
/** a process the launch named that herdr does not show in front yet: its start is read on its own */
const LAUNCHED = 41999;

/**
 * A pane with Codex in front and one page; `hold()` makes the next snapshot read wait, as a herdr call under way does.
 * `leaves()` is what terminals.ts detach() does for a page that leaves the pane.
 */
function pane() {
  const typed: string[] = [];
  const now = { status: "working", member: true };
  let waiting: { reached: () => void; release: Promise<void> } | null = null;
  let starting: { reached: () => void; release: Promise<void> } | null = null;
  spyOn(processStart, "processStartedAtAsync").mockImplementation(async (pid) => {
    const held = pid === LAUNCHED ? starting : null;
    if (held) { starting = null; held.reached(); await held.release; }
    return 1000;
  });
  spyOn(herdr, "paneProcessInfo").mockImplementation(async () => ({ pane_id: "p", shell_pid: 41000, foreground_processes: [{ pid: 41001, name: "codex", argv: ["codex"] }] }) as Awaited<ReturnType<typeof herdr.paneProcessInfo>>);
  spyOn(herdr, "paneRead").mockImplementation(async () => ({ text: "" }) as Awaited<ReturnType<typeof herdr.paneRead>>);
  spyOn(herdr, "paneSendText").mockImplementation(async (_pane, text) => { typed.push(text); });
  spyOn(herdr, "paneSendKeys").mockImplementation(async (_pane, keys) => { typed.push(keys.join(",")); });
  const frames: Array<{ type: string; messages?: Row[] }> = [];
  const told: { then?: () => void } = {};
  const page = { data: connectionData({ deviceId: undefined, readOnly: false }), getBufferedAmount: () => 0,
    send: (value: string) => { frames.push(JSON.parse(value) as { type: string; messages?: Row[] }); told.then?.(); return 1; } };
  let tail: Promise<unknown> = Promise.resolve();
  const serialize = <T,>(_pane: string, run: () => T | Promise<T>): Promise<T> => { const next = tail.catch(() => {}).then(run); tail = next; return next; };
  const delivery = createPendingDelivery({
    options: { submitDelayMs: 0 }, clients: new Set<unknown>([page]), attachments: new Map(), serialize, lastTyped: new Map(),
    sight: () => {
      const origin = now.member;
      return { facts: () => ({ attached: true, origin, sameAttachment: true, samePty: true, sameClaim: true, claimed: now.member, member: now.member,
        ready: true, held: false, currentHeld: false, mirror: false, cols: 80 }), write: () => {} };
    },
    submitText: async () => { typed.push("immediate"); },
    authorizeSocket: () => {},
    clientSnapshot: async () => {
      const held = waiting;
      if (held) { waiting = null; held.reached(); await held.release; }
      return { panes: [{ pane_id: "p", terminal_id: "p", workspace_id: "w", tab_id: "t", agent: "codex", agent_status: now.status, focused: false, revision: 0 }] };
    },
    omo: { sessionOf: () => null }, SUBMIT_DEADLINE_MS: 45_000, SUBMIT_DELAY_MS: 0, TYPED_SETTLE_MS: 0,
  } as unknown as Parameters<typeof createPendingDelivery>[0]);
  const settled = async () => {
    for (let turn = 0; turn < 20; turn++) {
      for (let before: unknown; before !== tail;) { before = tail; await tail.catch(() => {}); }
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  };
  const hold = () => {
    const reached = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
    waiting = { reached: reached.resolve, release: release.promise };
    return { reached: reached.promise, release: release.resolve };
  };
  const holdStart = () => {
    const reached = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
    starting = { reached: reached.resolve, release: release.promise };
    return { reached: reached.promise, release: release.resolve };
  };
  const opens = () => { page.data.attached.set("p", { keepSize: false }); now.member = true; };
  const leaves = () => { page.data.attached.delete("p"); delivery.holdPending(page as never, "p"); now.member = false; };
  const rests = async () => { now.status = "idle"; delivery.pending.status("p", "idle"); delivery.drainPending("p"); await settled(); };
  return { delivery, page: page as never, typed, frames, told, now, settled, hold, holdStart, opens, leaves, rests };
}

it("holds a queued message whose sender left the pane during its automatic send, also when the agent only put that send off", async () => {
  const d = pane();
  d.opens();
  await d.delivery.pendingFrames.submit(d.page, { type: "submit", id: 1, pane_id: "p", text: "queued words", payload: "queued words", delivery: "queue" } as never);
  const row = () => d.delivery.pending.list(d.page, "p")[0] as Row;
  expect(row()).toMatchObject({ state: "queued" });

  // the turn ends and the automatic send's checks wait on herdr, which will answer that the agent waits for an answer
  const check = d.hold();
  d.now.status = "blocked";
  d.delivery.pending.status("p", "idle");
  d.delivery.drainPending("p");
  await check.reached;
  expect(row()).toMatchObject({ state: "sending" });

  d.leaves();
  check.release();
  await d.settled();
  expect(row(), "queued again, the row would say it still waits for the agent's turn").toMatchObject({ state: "held", error: { code: "pending_lease_lost" } });

  d.opens();
  await d.rests();
  expect(row()).toMatchObject({ state: "held", error: { code: "pending_lease_lost" } });
  expect(d.typed).toEqual([]);
});

const RESTARTING = { code: "input_not_ready", message: "The pane's attachment is restarting; review pending messages before sending them" };
const GONE = { code: "pane_not_found", message: "The pane ended; its pending messages were not sent" };
type Pane = ReturnType<typeof pane>;
const connection = (d: Pane): string => (d.page as { data: { connectionId: string } }).data.connectionId;
// what the code calls for each: socket.ts `role` holdPending(client), terminals.ts detach() holdPending(client, pane),
// terminal-process.ts ended() holdPendingPane(pane, fault). Nothing is listed yet for any of them to hold
const BEFORE_LISTED: Array<[string, (d: Pane) => void, string]> = [
  ["its page switched to watching and back", (d) => { d.delivery.holdPending(d.page); }, "first_message_unattended"],
  ["its page opened the pane and left it", (d) => { d.opens(); d.leaves(); }, "first_message_unattended"],
  ["its pane's terminal restarted under its page", (d) => { d.opens(); d.delivery.holdPendingPane("p", RESTARTING); }, "input_not_ready"],
];

it.each(BEFORE_LISTED)("holds a first message when %s while herdr was asked, before the message was listed", async (_what, happens, reason) => {
  const d = pane();
  d.now.member = false;
  d.now.status = "idle";
  const lookup = d.hold();
  const asked = d.delivery.queueFirstMessage("p", "first words", "codex", connection(d));
  await lookup.reached;
  happens(d);
  lookup.release();
  expect(await asked).toMatchObject({ state: "held", error: { code: reason } });

  d.opens();
  await d.rests();
  expect(d.delivery.pending.list(FIRST_MESSAGE_OWNER, "p")).toMatchObject([{ state: "held", error: { code: reason } }]);
  expect(d.typed).toEqual([]);
});

it.each(BEFORE_LISTED)("holds a first message when %s while its agent was launched, before herdr was even asked", async (_what, happens, reason) => {
  const d = pane();
  d.now.member = false;
  d.now.status = "idle";
  // the create route takes the request first, names the pane once herdr made it, and queues after the launch
  const request = d.delivery.askFirstMessage(connection(d));
  request.at("p");
  happens(d);
  expect(await d.delivery.queueFirstMessage("p", "first words", "codex", request)).toMatchObject({ state: "held", error: { code: reason } });

  d.opens();
  await d.rests();
  expect(d.typed).toEqual([]);
});

it.each(BEFORE_LISTED.slice(1))("holds a first message when %s before the create route knew which pane herdr had made", async (_what, happens, reason) => {
  const d = pane();
  d.now.member = false;
  d.now.status = "idle";
  const request = d.delivery.askFirstMessage(connection(d));
  // herdr's events may tell the page of the pane before its create call answers the route
  happens(d);
  request.at("p");
  expect(await d.delivery.queueFirstMessage("p", "first words", "codex", request)).toMatchObject({ state: "held", error: { code: reason } });

  d.opens();
  await d.rests();
  expect(d.typed).toEqual([]);
});

it("holds a first message whose page switched to watching and back before its pane was even made", async () => {
  const d = pane();
  d.now.member = false;
  d.now.status = "idle";
  const request = d.delivery.askFirstMessage(connection(d));
  d.delivery.holdPending(d.page);
  request.at("p");
  expect(await d.delivery.queueFirstMessage("p", "first words", "codex", request)).toMatchObject({ state: "held", error: { code: "first_message_unattended" } });
});

it("lists a first message that nobody will type as held from its first listing, never as queued for a moment", async () => {
  const d = pane();
  d.now.status = "idle";
  d.opens();
  expect(await d.delivery.queueFirstMessage("p", "first words", "codex", null)).toMatchObject({ state: "held", error: { code: "first_message_unattended" } });
  const told = d.frames.filter((frame) => frame.type === "pending-messages").flatMap((frame) => frame.messages ?? []);
  expect(told.length).toBeGreaterThan(0);
  expect(told.map((row) => row.state), "an attached page was told it waits for the agent's turn before it was told it is held").not.toContain("queued");
});

it("holds a first message whose page leaves as it is told of the message's first listing", async () => {
  const d = pane();
  d.now.status = "idle";
  d.opens();
  // a send to a page can end it then and there (a relay page past its output budget): it has left before it is registered
  d.told.then = () => { d.told.then = undefined; d.leaves(); };
  expect(await d.delivery.queueFirstMessage("p", "first words", "codex", connection(d))).toMatchObject({ state: "held", error: { code: "first_message_unattended" } });

  d.opens();
  await d.rests();
  expect(d.typed).toEqual([]);
});

it("lists no first message for a pane that ended while its agent was launched", async () => {
  const d = pane();
  d.now.status = "idle";
  const request = d.delivery.askFirstMessage(connection(d));
  request.at("p");
  d.delivery.holdPendingPane("p", GONE);
  // what its terminal reports after does not bring the pane back
  d.delivery.holdPendingPane("p", RESTARTING);
  await expect(d.delivery.queueFirstMessage("p", "first words", "codex", request)).rejects.toMatchObject({ code: "pane_not_found" });
  expect(d.delivery.pending.list(FIRST_MESSAGE_OWNER, "p")).toEqual([]);
});

it("lists no first message for a pane that ended while the launched process's start was read, the last thing awaited", async () => {
  const d = pane();
  d.now.status = "idle";
  const start = d.holdStart();
  const asked = d.delivery.queueFirstMessage("p", "first words", "codex", connection(d), LAUNCHED);
  asked.catch(() => {});
  await start.reached;
  d.delivery.holdPendingPane("p", GONE);
  start.release();
  await expect(asked).rejects.toMatchObject({ code: "pane_not_found" });
  expect(d.delivery.pending.list(FIRST_MESSAGE_OWNER, "p")).toEqual([]);
});

it.each([
  ["its page left another pane", (d: Pane) => { d.delivery.holdPending(d.page, "another pane"); }],
  ["another request of its page was ended", (d: Pane) => { d.delivery.askFirstMessage(connection(d)).end(); }],
  ["its page left another pane before its own was made", (d: Pane) => { const other = d.delivery.askFirstMessage(connection(d)); d.delivery.holdPending(d.page, "another pane"); other.at("p2"); other.end(); }],
  ["another page switched to watching", (d: Pane) => { d.delivery.holdPending({ data: {} } as never); }],
])("still types a first message when %s before the message was listed", async (_what, happens) => {
  const d = pane();
  d.now.member = false;
  d.now.status = "idle";
  const request = d.delivery.askFirstMessage(connection(d));
  request.at("p");
  happens(d);
  expect(await d.delivery.queueFirstMessage("p", "first words", "codex", request)).toMatchObject({ state: "queued" });

  d.opens();
  await d.rests();
  expect(d.typed).toEqual(["\u001b[200~first words\u001b[201~", "Enter"]);
});
