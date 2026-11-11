import { afterEach, expect, it, mock, spyOn } from "bun:test";
import * as herdr from "../herdr/client.ts";
import * as processStart from "../process-start.ts";
import { createSubmitText } from "./composer.ts";
import { connectionData } from "./connections.ts";
import { createPendingDelivery, FIRST_MESSAGE_OWNER } from "./pending.ts";

/** each fixture's end: its pane ends, and with it any wait still on, before the next test's stand-ins are in place */
const ends: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const end of ends.splice(0)) await end();
  mock.restore();
});

type Frame = { type: string; [key: string]: unknown };
type Row = { id: string; state: string; text?: string; error?: { code: string }; waiting?: string };
const SHELL = 41000, OMP = 41001;
/** an omp that loads herdr's omp integration by its own arguments (ompLoadsIntegration): nothing is read from disk */
const INTEGRATED = ["omp", "-e", "/opt/herdr/herdr-omp-agent-state.ts"];
/** the session herdr's omp integration reports from omp's `session_start`, once omp takes an Enter */
const SESSION = { agent: "omp", kind: "path", source: "herdr:omp", value: "/fixture/session.jsonl" };
const PASTE = "\u001b[200~first words\u001b[201~";
const GONE = { code: "pane_not_found", message: "The pane ended; its pending messages were not sent" };

/**
 * An omp pane herdr shows at rest, as it does once omp has drawn its input box and before omp takes an Enter
 * (composer.ts untilOmpReported). `calls`: each look the wait takes at the pane, then what was written. The
 * clock is this fixture's: `advance` moves it, so a wait runs out or a deadline passes without that time passing.
 */
function omp(setup: { startedAgo?: number; argv?: readonly string[]; reported?: boolean; /** the immediate send is the real one, not a stand-in */ realSubmit?: boolean } = {}) {
  const calls: string[] = [], frames: Frame[] = [];
  const pane: Record<string, unknown> = { pane_id: "p", terminal_id: "p", workspace_id: "w", tab_id: "t", agent: "omp", agent_status: "idle", focused: false, revision: 0,
    ...(setup.reported ? { agent_session: SESSION } : {}) };
  /** called at each look of the wait and at each read of the pane's screen, with how many there were */
  const hooks: { look?: (looks: number) => void; read?: (reads: number) => void | Promise<void>;
    /** what herdr answers a read of the pane's processes: nothing ("fail"), no process ("empty"), or what runs there. `start`: the read is the look at omp's start */
    processes?: (start: boolean) => "fail" | "empty" | undefined } = {};
  let looks = 0, reads = 0, asked = 0, allowed = true, skew = 0, typedCount = 0;
  /** herdr answers no snapshot for now; the pane is gone from herdr */
  const herdrNow = { silent: false, paneGone: false };
  const realNow = Date.now.bind(Date);
  spyOn(Date, "now").mockImplementation(() => realNow() + skew);
  // the omp started when it is first asked about, so that its half minute is counted from inside the wait
  let started: number | undefined;
  spyOn(processStart, "processStartedAt").mockImplementation(() => started ??= Date.now() - (setup.startedAgo ?? 0));
  spyOn(processStart, "processStartedAtAsync").mockResolvedValue(1000);
  spyOn(herdr, "paneProcessInfo").mockImplementation(async () => {
    asked += 1;
    // which read this is, by who asked: how many reads the queue's other checks make is theirs to change
    const answer = hooks.processes?.((new Error().stack ?? "").includes("startingOmp"));
    if (answer === "fail") throw new herdr.HerdrError("herdr_unavailable", "herdr did not answer");
    return { pane_id: "p", shell_pid: SHELL,
      foreground_processes: answer === "empty" ? [] : pane["agent"] === "omp" ? [{ pid: OMP, name: "omp", argv: setup.argv ?? INTEGRATED }] : [{ pid: SHELL, name: "bash", argv: ["bash"] }] } as Awaited<ReturnType<typeof herdr.paneProcessInfo>>;
  });
  spyOn(herdr, "paneGet").mockImplementation(async () => {
    looks += 1; hooks.look?.(looks); calls.push("look");
    if (herdrNow.paneGone) throw new herdr.HerdrError("pane_not_found", "pane p not found");
    return { ...pane } as unknown as Awaited<ReturnType<typeof herdr.paneGet>>;
  });
  spyOn(herdr, "paneRead").mockImplementation(async () => { reads += 1; await hooks.read?.(reads); return { text: "" } as Awaited<ReturnType<typeof herdr.paneRead>>; });
  spyOn(herdr, "paneSendText").mockImplementation(async (_pane, text) => { calls.push(text); });
  spyOn(herdr, "paneSendKeys").mockImplementation(async (_pane, keys) => { calls.push(keys.join(",")); });
  const owner = { data: connectionData({ deviceId: undefined, readOnly: false }), getBufferedAmount: () => 0, send: (value: string) => { frames.push(JSON.parse(value) as Frame); return 1; } };
  owner.data.attached.set("p", { keepSize: false });
  const facts = { attached: true, origin: true, sameAttachment: true, samePty: true, sameClaim: true, claimed: true, member: true, ready: true, held: false, currentHeld: false, mirror: false, cols: 80 };
  // the pane's lane: what is typed into the pane waits its turn in it, behind a send that is under way
  let tail: Promise<unknown> = Promise.resolve();
  const serialize = <T,>(_pane: string, run: () => T | Promise<T>): Promise<T> => { const next = tail.catch(() => {}).then(run); tail = next; return next; };
  const clients = new Set<unknown>([owner]);
  const delivery = createPendingDelivery({
    options: { submitDelayMs: 0, ompReportPollMs: 1 },
    clients, attachments: new Map(), sight: (() => ({ facts: () => facts, write: () => {} })), serialize,
    lastTyped: new Map(), typedInto: () => typedCount,
    submitText: setup.realSubmit
      ? createSubmitText({ options: { submitDelayMs: 0 }, lastTyped: new Map(), attachments: new Map(), terminalAttach: async () => true, SUBMIT_DEADLINE_MS: 45_000, TYPED_SETTLE_MS: 0, DRAFT_CLEAR_WAIT_MS: 0, DRAFT_CLEAR_POLL_MS: 1, SUBMIT_DELAY_MS: 0 })
      : async () => { calls.push("immediate"); },
    authorizeSocket: () => { if (!allowed) throw new herdr.HerdrError("read_only", "this device may only watch"); },
    clientSnapshot: async () => {
      if (herdrNow.silent) throw new herdr.HerdrError("herdr_unavailable", "herdr did not answer");
      return { panes: herdrNow.paneGone ? [] : [pane] };
    },
    omo: { sessionOf: () => null }, SUBMIT_DEADLINE_MS: 45_000, SUBMIT_DELAY_MS: 0, TYPED_SETTLE_MS: 0,
  } as unknown as Parameters<typeof createPendingDelivery>[0]);
  const result = (type: string, id: number) => frames.find((frame) => frame.type === type && frame.id === id);
  /** the pane's queue as its page was last told it */
  const listed = () => (frames.filter((frame) => frame.type === "pending-messages").at(-1)?.["messages"] ?? []) as Row[];
  /** every send and drain under way has run, and so has what each started in turn */
  const settled = async () => {
    for (let turn = 0; turn < 20; turn++) {
      for (let before: unknown; before !== tail;) { before = tail; await tail.catch(() => {}); }
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  };
  /** `done` came true, by the real clock: the queue's own wait for omp is no part of the lane */
  const eventually = async (what: string, done: () => boolean) => {
    for (const deadline = performance.now() + 4_000; !done();) {
      if (performance.now() > deadline) throw new Error(`timed out waiting for ${what}; calls ${JSON.stringify(calls)}`);
      await Bun.sleep(1);
    }
    await settled();
  };
  /** a pane event at rest: the queue is drained */
  const rest = async () => { delivery.pending.status("p", "idle"); delivery.drainPending("p"); await settled(); };
  /** `queued`: run once the message is queued, before the pane comes to rest */
  const first = async (queued?: () => void): Promise<Row> => {
    const message = await delivery.queueFirstMessage("p", "first words", "omp", owner.data.connectionId, OMP);
    queued?.();
    await rest();
    return message as unknown as Row;
  };
  const ways = {
    /** a queue request that finds the pane at rest is typed at once */
    "a queue request typed at once": async (): Promise<Frame | undefined> => {
      await delivery.pendingFrames.submit(owner as never, { type: "submit", id: 1, pane_id: "p", text: "first words", payload: "unused", delivery: "queue" } as never);
      await settled();
      return result("submit-result", 1);
    },
    /** a message kept for the user, then sent with its Send now */
    "Send now of a held message": async (): Promise<Frame | undefined> => {
      await delivery.pendingFrames.submit(owner as never, { type: "submit", id: 1, pane_id: "p", text: "first words", payload: "unused", delivery: "hold" } as never);
      const held = result("submit-result", 1) as unknown as { pending: { id: string } };
      await delivery.pendingFrames["pending-action"](owner as never, { type: "pending-action", id: 2, pane_id: "p", pending_id: held.pending.id, action: "steer" } as never);
      await settled();
      return result("pending-result", 2);
    },
    /** a new pane's first message, which the queue sends by itself once the pane is at rest: `until` says when it is through */
    "a new pane's first message": async (until: () => boolean = () => calls.includes("Enter"), queued?: () => void): Promise<Frame | undefined> => {
      await first(queued);
      await eventually("the first message's send", until);
      return undefined;
    },
  };
  const typed = () => calls.filter((call) => call !== "look");
  /** a person types into the pane's terminal: counted by the input lane as it is written, in the pane's turn */
  const type = () => serialize("p", () => { typedCount += 1; calls.push("typed in the terminal"); });
  ends.push(async () => { paneEnds(); await settled(); });
  /** the pane ended, as the status hub tells the queue (status.ts paneGone) */
  const paneEnds = () => { delivery.holdPendingPane("p", GONE); delivery.pending.forget("p"); };
  return { calls, typed, looks: () => looks, asked: () => asked, pane, facts, hooks, ways, first, listed, rest, settled, eventually, serialize, delivery, owner, result, paneEnds, clients, herdrNow, type, frames,
    report: () => { pane["agent_session"] = SESSION; }, revoke: () => { allowed = false; }, advance: (ms: number) => { skew += ms; } };
}
type Way = "a queue request typed at once" | "Send now of a held message" | "a new pane's first message";
const WAYS: Way[] = ["a queue request typed at once", "Send now of a held message", "a new pane's first message"];
/** the sends a person makes: they wait for omp as part of the send, as the immediate send does */
const BY_HAND: Way[] = ["a queue request typed at once", "Send now of a held message"];

// omp draws its input box, and herdr shows it at rest, seconds before it takes an Enter: a message typed meanwhile stays
// in the box and never runs, while its row says sent. The immediate send waits for herdr's omp integration to report
// the session; so does every send the queue makes
it.each(WAYS)("types %s into an omp still starting only once its session is reported", async (way) => {
  const d = omp();
  d.hooks.look = (looks) => {
    if (looks !== 3) return;
    expect(d.typed(), "nothing is typed before omp takes an Enter").toEqual([]);
    d.report();
  };
  const answer = await d.ways[way]();
  expect(d.calls).toEqual(["look", "look", "look", PASTE, "Enter"]);
  if (answer) expect(answer).toMatchObject({ ok: true });
  expect(d.listed().filter((message) => message.state !== "sending")).toEqual([]);
});

it.each(WAYS)("types %s at once into an omp whose session is reported, with no look at its start", async (way) => {
  const d = omp({ reported: true });
  await d.ways[way]();
  expect(d.calls).toEqual([PASTE, "Enter"]);
});

it.each([
  ["that started half a minute ago: it takes input, reported or not", { startedAgo: 31_000 }],
  ["that loads no integration: nothing would report it", { argv: ["omp", "--no-extensions"] }],
] as const)("types a queued message at once into an omp %s", async (_case, setup) => {
  const d = omp(setup);
  await d.ways["a new pane's first message"]();
  expect(d.calls).toEqual([PASTE, "Enter"]);
});

it.each(WAYS)("types %s once the wait for an omp that never reports runs out, and says so in the server log", async (way) => {
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  const d = omp();
  // half a minute after omp started, with no report
  d.hooks.look = (looks) => { if (looks === 3) d.advance(30_001); };
  await d.ways[way]();
  expect(d.calls).toEqual(["look", "look", "look", PASTE, "Enter"]);
  expect(warn.mock.calls.flat().join(" ")).toContain("reported no session");
});

it.each(BY_HAND)("types nothing of %s when the omp it waited for quits while it starts, and says the pane changed", async (way) => {
  const d = omp();
  // omp ended: herdr names no agent in the pane, and its shell is in front
  d.hooks.look = (looks) => { if (looks === 2) d.pane["agent"] = null; };
  expect(await d.ways[way]()).toMatchObject({ ok: false, code: "pending_target_changed" });
  expect(d.calls).toEqual(["look", "look"]);
  // the queue request was never accepted, so its text is still the composer's; the held message keeps its row
  if (way === "Send now of a held message") expect(d.listed().map((message) => [message.state, message.error?.code])).toEqual([["held", "pending_target_changed"]]);
});

it("holds a new pane's first message when the omp started for it quits while it starts, with that reason", async () => {
  const d = omp();
  d.hooks.look = (looks) => { if (looks === 2) d.pane["agent"] = null; };
  await d.ways["a new pane's first message"](() => d.listed()[0]?.state === "held");
  expect(d.typed()).toEqual([]);
  expect(d.listed().map((message) => [message.state, message.error?.code])).toEqual([["held", "first_message_launch_ended"]]);
});

it.each(BY_HAND.flatMap((way) => [[way, "its device may no longer type"], [way, "its page no longer has the pane ready"]] as const))(
  "stops waiting to type %s once %s, and types nothing", async (way, loss) => {
    const d = omp();
    d.hooks.look = (looks) => {
      if (looks !== 2) return;
      if (loss === "its device may no longer type") d.revoke(); else d.facts.ready = false;
    };
    expect(await d.ways[way]()).toMatchObject({ ok: false });
    // no third look: the wait ended with the sender's leave to type, not with omp's report or its half minute
    expect(d.calls).toEqual(["look", "look"]);
  });

it("leaves a new pane's first message queued for its page when that page may no longer type by omp's report", async () => {
  const d = omp();
  d.hooks.look = (looks) => { if (looks === 2) d.revoke(); else if (looks === 3) d.report(); };
  await d.ways["a new pane's first message"](() => d.looks() >= 3);
  expect(d.calls).toEqual(["look", "look", "look"]);
  expect(d.listed().map((message) => message.state)).toEqual(["queued"]);
});

it("types nothing of a message a person sends that waited for a starting omp past its deadline, counted from when it was asked for", async () => {
  // the deadline passes during the wait
  const during = omp();
  during.hooks.look = (looks) => { if (looks === 2) during.advance(45_001); };
  expect(await during.ways["a queue request typed at once"]()).toMatchObject({ ok: false, code: "submit_timeout" });
  expect(during.calls).toEqual(["look", "look"]);
  mock.restore();
  // and one that had passed before the wait began (the request waited its turn behind other input): not one look
  const before = omp();
  before.hooks.read = (reads) => { if (reads === 2) before.advance(45_001); };
  expect(await before.ways["a queue request typed at once"]()).toMatchObject({ ok: false, code: "submit_timeout" });
  expect(before.calls).toEqual([]);
});

it("queues a queue request whose omp is at work by its report, and types it at that turn's end", async () => {
  const d = omp();
  // the pane was at rest when the request came; omp reports, already at work (it was started with a prompt of its own)
  d.hooks.look = (looks) => { if (looks === 2) { d.report(); d.pane["agent_status"] = "working"; } };
  expect(await d.ways["a queue request typed at once"]()).toMatchObject({ ok: true, pending: { state: "queued" } });
  expect(d.typed()).toEqual([]);
  d.pane["agent_status"] = "idle";
  await d.rest();
  expect(d.typed()).toEqual([PASTE, "Enter"]);
});

it("types a new pane's first message that waited for a starting omp only while the pane is still at rest", async () => {
  const d = omp();
  // omp reported, and by then it works on something else (a message typed in the terminal): the queue waits its turn
  d.hooks.look = (looks) => { if (looks === 2) { d.report(); d.pane["agent_status"] = "working"; } };
  await d.ways["a new pane's first message"](() => d.looks() >= 2);
  expect(d.typed()).toEqual([]);
  expect(d.listed().map((message) => message.state)).toEqual(["queued"]);
  // its turn ends: the message goes, with no further wait
  d.pane["agent_status"] = "idle";
  await d.rest();
  expect(d.calls).toEqual(["look", "look", PASTE, "Enter"]);
});

// what the queue sends by itself waits for omp with nothing claimed: the pane and the message are as free as before it
it("lets what is typed into the pane through while its first message waits for omp, and holds the message for it", async () => {
  const d = omp();
  d.hooks.look = (looks) => { if (looks === 2) void d.type(); };
  await d.ways["a new pane's first message"](() => d.listed()[0]?.state === "held");
  // it went while the wait was still on, with the pane's lane free
  expect(d.calls).toEqual(["look", "look", "typed in the terminal"]);
  // and the message is not pasted behind it: what was typed may sit in omp's input box, which nothing here reads,
  // and the message's Enter would send both as one. It waits for its sender, with that reason, and the wait is over
  expect(d.listed().map((message) => [message.state, message.error?.code, message.waiting])).toEqual([["held", "typed_while_waiting", undefined]]);
  d.report();
  await d.rest();
  expect(d.typed()).toEqual(["typed in the terminal"]);
  // sent by hand, it goes
  await d.delivery.pendingFrames["pending-action"](d.owner as never, { type: "pending-action", id: 9, pane_id: "p", pending_id: d.listed()[0]!.id, action: "steer" } as never);
  await d.settled();
  expect(d.typed()).toEqual(["typed in the terminal", PASTE, "Enter"]);
});

it("holds every message that waits behind a starting omp once something is typed there, and none when nothing is", async () => {
  const d = omp();
  await d.first();
  await d.eventually("the wait for omp", () => d.looks() >= 2);
  // another message joins the queue behind the first
  await d.delivery.pendingFrames.submit(d.owner as never, { type: "submit", id: 4, pane_id: "p", text: "second words", payload: "unused", delivery: "queue" } as never);
  await d.type();
  // the first message is the bridge's to list and the second its connection's own
  const rows = () => [...d.delivery.pending.list(FIRST_MESSAGE_OWNER, "p"), ...d.delivery.pending.list(d.owner as never, "p")];
  await d.eventually("the hold", () => rows().every((message) => message.state === "held"));
  expect(rows().map((message) => [message.text, message.error?.code])).toEqual([["first words", "typed_while_waiting"], ["second words", "typed_while_waiting"]]);
  expect(d.typed()).toEqual(["typed in the terminal"]);
});

it("shows a new pane's first message as queued and waiting for omp, not as being sent, and takes the note away with the wait", async () => {
  const d = omp();
  let shown: Array<[string, string | undefined]> | undefined;
  d.hooks.look = (looks) => { if (looks === 2) shown = d.listed().map((message) => [message.state, message.waiting]); else if (looks === 3) d.report(); };
  await d.ways["a new pane's first message"]();
  expect(shown).toEqual([["queued", "omp_starting"]]);
  // every row the page was told of after the wait is without it
  const rows = d.frames.filter((frame) => frame.type === "pending-messages").map((frame) => (frame["messages"] as Row[]).map((message) => `${message.state}${message.waiting ? " waiting" : ""}`).join());
  expect(rows).toEqual(["queued", "queued waiting", "queued", "sending", ""]);
});

it("says on the row of a Send now that it waits for omp, for as long as it does", async () => {
  const d = omp();
  d.hooks.look = (looks) => { if (looks === 3) d.report(); };
  expect(await d.ways["Send now of a held message"]()).toMatchObject({ ok: true });
  const rows = d.frames.filter((frame) => frame.type === "pending-messages").map((frame) => (frame["messages"] as Row[]).map((message) => `${message.state}${message.waiting ? " waiting" : ""}`).join());
  expect(rows).toEqual(["held", "sending", "sending waiting", "sending", ""]);
});

it("says nothing of a wait on a row sent to an omp that takes input", async () => {
  const d = omp({ reported: true });
  await d.ways["a new pane's first message"]();
  expect(d.frames.filter((frame) => frame.type === "pending-messages").flatMap((frame) => (frame["messages"] as Row[]).map((message) => message.waiting))).toEqual([undefined, undefined]);
});

it("takes a first message with its pane when the pane ends while the message waits for omp", async () => {
  const d = omp();
  d.hooks.look = (looks) => { if (looks === 2) d.paneEnds(); };
  await d.first();
  await d.eventually("the pane's end", () => d.looks() >= 2);
  // nothing is left under the pane's id for the pane herdr gives it to next, and the wait is over
  expect([d.typed(), d.listed(), d.delivery.pending.holds("p")]).toEqual([[], [], false]);
  const looks = d.looks();
  await d.settled();
  expect(d.looks()).toBe(looks);
});

// a first message has no connection whose end would expire it: one on its way when its pane ends cannot go with the pane
// then, and went back to the queue under the dead pane's id, where the next pane herdr gives that id found it
it("takes a first message with its pane once its send has ended, when the pane ended while the queue was sending it", async () => {
  const d = omp({ reported: true });
  // the pane ends during the send's own reads of it
  d.hooks.read = (reads) => { if (reads === 1) d.paneEnds(); };
  await d.first();
  expect([d.typed(), d.listed(), d.delivery.pending.holds("p")]).toEqual([[], [], false]);
  // the id is free for a new pane's own first message
  expect((await d.delivery.queueFirstMessage("p", "another", "omp", d.owner.data.connectionId, OMP)).state).toBe("queued");
});

it("takes a first message with its pane once its Send now has ended, when the pane ended while that waited for omp", async () => {
  const d = omp();
  const message = await d.first();
  await d.eventually("the wait for omp", () => d.looks() >= 2);
  let ended = false;
  // the pane ends at the first look Send now's own wait takes
  d.hooks.look = () => { if (!ended && d.delivery.pending.get(FIRST_MESSAGE_OWNER, "p", message.id)?.inFlight) { ended = true; d.paneEnds(); } };
  await d.delivery.pendingFrames["pending-action"](d.owner as never, { type: "pending-action", id: 9, pane_id: "p", pending_id: message.id, action: "steer" } as never);
  await d.settled();
  expect(ended).toBe(true);
  expect(d.result("pending-result", 9)).toMatchObject({ ok: false });
  expect([d.typed(), d.listed(), d.delivery.pending.holds("p")]).toEqual([[], [], false]);
});

it.each(["steer", "discard"] as const)("lets Send now or Discard take a first message that waits for omp: %s", async (action) => {
  const d = omp();
  const message = await d.first();
  await d.eventually("the wait for omp", () => d.looks() >= 2);
  // from the look after the action's own, omp has reported
  d.hooks.look = () => { d.report(); };
  await d.delivery.pendingFrames["pending-action"](d.owner as never, { type: "pending-action", id: 9, pane_id: "p", pending_id: message.id, action } as never);
  await d.settled();
  expect(d.result("pending-result", 9)).toMatchObject({ ok: true });
  // sent once, by the hand that asked, or not at all; and the wait is over
  expect(d.typed()).toEqual(action === "steer" ? [PASTE, "Enter"] : []);
  const looks = d.looks();
  await d.settled();
  expect(d.looks()).toBe(looks);
});

it("leaves a pane's first message queued when only an earlier pane of that id ended", async () => {
  const d = omp({ reported: true });
  // herdr gave the id of a pane that ended to this one
  d.paneEnds();
  d.advance(5);
  // its page loses the pane during the send: nothing is typed, and the message waits for the page, as before
  d.hooks.read = (reads) => { if (reads === 1) d.facts.ready = false; };
  await d.first();
  expect([d.typed(), d.listed().map((message) => message.state), d.delivery.pending.holds("p")]).toEqual([[], ["queued"], true]);
});

it("goes on waiting for omp while herdr does not answer, and sends the first message at the report", async () => {
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  const d = omp();
  // herdr fails for a moment while the queue waits (a slow start under load is when its calls time out): the wait is
  // no send that could fail, and nothing else would drain the pane again once omp has reported
  d.hooks.look = (looks) => {
    d.herdrNow.silent = looks === 2 || looks === 3;
    if (d.herdrNow.silent) throw new herdr.HerdrError("herdr_unavailable", "herdr did not answer");
    if (looks === 5) d.report();
  };
  await d.ways["a new pane's first message"]();
  expect([d.looks(), d.typed()]).toEqual([5, [PASTE, "Enter"]]);
  expect(warn.mock.calls).toEqual([]);
});

it("ends the queue's wait for omp when the pane is gone", async () => {
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  const d = omp();
  d.hooks.look = (looks) => { if (looks === 2) d.herdrNow.paneGone = true; };
  await d.first();
  await d.eventually("the look that finds no pane", () => d.looks() >= 2);
  const looks = d.looks();
  await d.settled();
  expect([d.looks(), d.typed()]).toEqual([looks, []]);
  expect(warn.mock.calls.flat().join(" ")).toContain("pane_not_found");
});

it("never holds the pane's lane for a send of the queue's own: one that finds omp starting after all goes back to the queue", async () => {
  const d = omp();
  d.hooks.look = (looks) => {
    if (looks === 2) void d.serialize("p", () => { d.calls.push("typed in the terminal"); });
    if (looks === 5) d.report();
  };
  // herdr lists no process in the pane at the queue's look at omp's start (omp is between two of its own), so the send
  // is taken up as for an omp that takes input
  let missed = 0;
  d.hooks.processes = (start) => start && missed === 0 && ++missed > 0 ? "empty" : undefined;
  await d.ways["a new pane's first message"]();
  expect(missed).toBe(1);
  // the send found omp starting and gave the message back: what was typed in the terminal went ahead of it
  expect(d.typed()).toEqual(["typed in the terminal", PASTE, "Enter"]);
  expect(d.calls.indexOf("typed in the terminal")).toBeLessThan(d.calls.lastIndexOf("look"));
});

it("keeps a connection's own message for it when its pane ends while the queue is sending it", async () => {
  const d = omp({ reported: true });
  // a message queued behind a turn, sent by the queue at the turn's end
  d.pane["agent_status"] = "working";
  expect(await d.ways["a queue request typed at once"]()).toMatchObject({ ok: true, pending: { state: "queued" } });
  d.hooks.read = () => { d.paneEnds(); d.hooks.read = undefined; };
  d.pane["agent_status"] = "idle";
  await d.rest();
  // held for its owner with its reason, not removed: only a first message has no connection to end with
  expect([d.typed(), d.listed().map((message) => message.state), d.delivery.pending.holds("p")]).toEqual([[], ["held"], true]);
});

it("types a queue request at once into an omp that is at work by the send's own read, when nothing was waited for: as before", async () => {
  const d = omp({ reported: true });
  // at rest when the request came, at work a moment later: only a wait for omp makes the send look again
  d.hooks.read = (reads) => { if (reads === 2) d.pane["agent_status"] = "working"; };
  expect(await d.ways["a queue request typed at once"]()).toMatchObject({ ok: true, typed_now: true });
  expect(d.typed()).toEqual([PASTE, "Enter"]);
});

it("leaves nothing of a first message taken with its pane for the next pane of that id", async () => {
  const d = omp({ reported: true });
  d.hooks.read = (reads) => { if (reads === 1) d.paneEnds(); };
  await d.first();
  // a page that attaches the pane herdr gave the id to is told of no message of the old one's
  const told: Frame[] = [];
  const page = { data: connectionData({ deviceId: undefined, readOnly: false }), getBufferedAmount: () => 0, send: (value: string) => { told.push(JSON.parse(value) as Frame); return 1; } };
  page.data.attached.set("p", { keepSize: false });
  d.clients.add(page);
  d.delivery.attached(page as never, "p");
  expect(told.filter((frame) => frame.type === "pending-messages" && ((frame["messages"] as unknown[]).length > 0 || frame["removed"] !== undefined))).toEqual([]);
});

// (the composer sends at once whenever the pane shows its agent at rest, as a starting omp is shown)
it("queues a chat message sent at once behind a first message that waits for omp, and sends them in that order", async () => {
  const d = omp();
  await d.first();
  await d.eventually("the wait for omp", () => d.looks() >= 2);
  await d.delivery.pendingFrames.submit(d.owner as never, { type: "submit", id: 5, pane_id: "p", text: "second words", payload: "second words", delivery: "immediate" } as never);
  await d.settled();
  // accepted as a row of the queue, not typed: sent at once it would wait for the same report with the pane's lane
  // held, and go ahead of the first message
  expect(d.result("submit-result", 5)).toMatchObject({ ok: true, pending: { state: "queued", text: "second words" } });
  expect(d.result("submit-result", 5)?.["typed_now"]).toBeUndefined();
  expect(d.calls).not.toContain("immediate");
  d.report();
  await d.eventually("the first message's send", () => d.calls.includes("Enter"));
  expect(d.typed()).toEqual([PASTE, "Enter"]);
  // omp works on the first message, then rests: the second goes at that turn's end
  d.pane["agent_status"] = "working"; d.delivery.pending.status("p", "working"); d.delivery.drainPending("p"); await d.settled();
  d.pane["agent_status"] = "idle";
  await d.rest();
  expect(d.typed()).toEqual([PASTE, "Enter", "\u001b[200~second words\u001b[201~", "Enter"]);
});

it("sends a message sent at once as before with no message waiting for omp", async () => {
  const d = omp({ reported: true });
  await d.delivery.pendingFrames.submit(d.owner as never, { type: "submit", id: 5, pane_id: "p", text: "second words", payload: "second words", delivery: "immediate" } as never);
  await d.settled();
  expect(d.result("submit-result", 5)).toMatchObject({ ok: true });
  expect(d.result("submit-result", 5)?.["pending"]).toBeUndefined();
  expect(d.calls).toEqual(["immediate"]);
});

// The other ways words reach omp's input box while a message waits for it to take input. Each was found by a review
// as the same merge through another door: the waiting message pasted behind them, and its Enter sending both as one
it("holds what waits for a starting omp once a line is sent from the terminal's input line, which goes as typed", async () => {
  const d = omp({ realSubmit: true });
  await d.first();
  await d.eventually("the wait for omp", () => d.looks() >= 2);
  // the terminal's input line is the keyboard: its line and its Enter go at once, into an omp that takes no Enter yet
  await d.delivery.pendingFrames.submit(d.owner as never, { type: "submit", id: 5, pane_id: "p", text: "manual words", payload: "manual words", typed: true, delivery: "immediate" } as never);
  expect(d.result("submit-result", 5)).toMatchObject({ ok: true });
  expect(d.typed()).toEqual(["manual words", "Enter"]);
  await d.eventually("the hold", () => d.listed()[0]?.state === "held");
  expect(d.listed().map((message) => message.error?.code)).toEqual(["typed_while_waiting"]);
  d.report();
  await d.rest();
  expect(d.typed()).toEqual(["manual words", "Enter"]);
});

it("holds a chat message sent at once whose admission the hold overtook: typed into the terminal, then sent", async () => {
  const d = omp();
  await d.first();
  await d.eventually("the wait for omp", () => d.looks() >= 2);
  await d.type();
  // the chat message's own read of the pane takes a while: meanwhile the wait sees the typing, holds the first
  // message and ends
  // (not d.eventually: it waits for the lane, which this read is part of)
  d.hooks.read = async () => {
    d.hooks.read = undefined;
    const deadline = performance.now() + 4_000;
    while (d.listed()[0]?.state !== "held" && performance.now() < deadline) await Bun.sleep(1);
  };
  await d.delivery.pendingFrames.submit(d.owner as never, { type: "submit", id: 5, pane_id: "p", text: "second words", payload: "second words", delivery: "immediate" } as never);
  // accepted, and held as the first was: nothing goes behind what was typed without its sender saying so
  expect(d.result("submit-result", 5)).toMatchObject({ ok: true, pending: { state: "held", error: { code: "typed_while_waiting" } } });
  d.report();
  await d.rest();
  expect(d.typed()).toEqual(["typed in the terminal"]);
});

it.each([
  ["a chat message sent at once", { delivery: "immediate", payload: "second words" }],
  ["a queue request, which a pane at rest would have typed at once", { delivery: "queue", payload: "unused" }],
] as const)("holds %s after the terminal was typed into during omp's start, though no wait is on any more", async (_case, extra) => {
  const d = omp();
  await d.first();
  await d.eventually("the wait for omp", () => d.looks() >= 2);
  await d.type();
  await d.eventually("the hold", () => d.listed()[0]?.state === "held");
  const looks = d.looks();
  await d.delivery.pendingFrames.submit(d.owner as never, { type: "submit", id: 5, pane_id: "p", text: "second words", ...extra } as never);
  await d.settled();
  expect(d.result("submit-result", 5)).toMatchObject({ ok: true, pending: { state: "held", error: { code: "typed_while_waiting" } } });
  d.report();
  await d.rest();
  // neither waited for omp with the pane's lane held, nor went at its report
  expect([d.looks(), d.typed()]).toEqual([looks, ["typed in the terminal"]]);
});

it("sends a held message by its Send now though the terminal was typed into during omp's start: its sender says so", async () => {
  const d = omp();
  const message = await d.first();
  await d.eventually("the wait for omp", () => d.looks() >= 2);
  await d.type();
  await d.eventually("the hold", () => d.listed()[0]?.state === "held");
  d.report();
  await d.delivery.pendingFrames["pending-action"](d.owner as never, { type: "pending-action", id: 9, pane_id: "p", pending_id: message.id, action: "steer" } as never);
  await d.settled();
  expect(d.result("pending-result", 9)).toMatchObject({ ok: true });
  expect(d.typed()).toEqual(["typed in the terminal", PASTE, "Enter"]);
});

it("holds nothing for what is typed into the terminal once omp took input with nothing typed meanwhile", async () => {
  const d = omp();
  d.hooks.look = (looks) => { if (looks === 3) d.report(); };
  await d.ways["a new pane's first message"]();
  d.hooks.look = undefined;
  // omp works on the first message; the user types in the terminal, and a follow-up is queued behind the turn
  d.pane["agent_status"] = "working"; d.delivery.pending.status("p", "working");
  await d.type();
  await d.delivery.pendingFrames.submit(d.owner as never, { type: "submit", id: 5, pane_id: "p", text: "second words", payload: "unused", delivery: "queue" } as never);
  expect(d.result("submit-result", 5)).toMatchObject({ ok: true, pending: { state: "queued" } });
  d.pane["agent_status"] = "idle";
  await d.rest();
  expect(d.typed()).toEqual([PASTE, "Enter", "typed in the terminal", "\u001b[200~second words\u001b[201~", "Enter"]);
});

it("holds nothing for what is typed once omp's start is waited for no more, half a minute after it began", async () => {
  const d = omp();
  await d.first();
  await d.eventually("the wait for omp", () => d.looks() >= 2);
  await d.type();
  await d.eventually("the hold", () => d.listed()[0]?.state === "held");
  // omp has long taken input: a message sent at once goes as before
  d.report();
  d.advance(30_001);
  await d.delivery.pendingFrames.submit(d.owner as never, { type: "submit", id: 5, pane_id: "p", text: "second words", payload: "second words", delivery: "immediate" } as never);
  await d.settled();
  expect(d.result("submit-result", 5)?.["pending"]).toBeUndefined();
  expect(d.typed()).toEqual(["typed in the terminal", "immediate"]);
});

it("types nothing of a Send now whose Discard comes while it waits for omp, and answers both truly", async () => {
  const d = omp();
  await d.delivery.pendingFrames.submit(d.owner as never, { type: "submit", id: 1, pane_id: "p", text: "first words", payload: "unused", delivery: "hold" } as never);
  const held = d.result("submit-result", 1) as unknown as { pending: { id: string } };
  let discard: Promise<void> | undefined;
  d.hooks.look = (looks) => {
    // the row shows as being sent, and its Discard is pressed; omp reports a moment later
    if (looks === 2) discard = d.delivery.pendingFrames["pending-action"](d.owner as never, { type: "pending-action", id: 3, pane_id: "p", pending_id: held.pending.id, action: "discard" } as never);
    if (looks === 4) d.report();
  };
  await d.delivery.pendingFrames["pending-action"](d.owner as never, { type: "pending-action", id: 2, pane_id: "p", pending_id: held.pending.id, action: "steer" } as never);
  await discard;
  await d.settled();
  // the send ended at its next look: no third one, and nothing typed
  expect(d.calls).toEqual(["look", "look"]);
  // the message went as discarded, never as sent, and both actions are answered as settled
  const removed = d.frames.filter((frame) => frame.type === "pending-messages").flatMap((frame) => (frame["removed"] as Array<{ outcome: string }> | undefined) ?? []).map((entry) => entry.outcome);
  expect(removed.filter((outcome) => outcome === "sent")).toEqual([]);
  expect(removed).toContain("discarded");
  expect([d.result("pending-result", 2), d.result("pending-result", 3)]).toMatchObject([{ ok: true }, { ok: true }]);
  expect(d.listed()).toEqual([]);
});

// herdr not answering whether omp is starting says nothing either way: not known is not "takes input"
it("types nothing into an omp while herdr does not say whether it is starting, and sends the first message at its report", async () => {
  const d = omp();
  // the queue's look at omp's start is not answered, twice in a row; the third is
  let failed = 0;
  d.hooks.processes = (start) => start && failed < 2 && ++failed > 0 ? "fail" : undefined;
  d.hooks.look = (looks) => { if (looks === 3) d.report(); };
  await d.ways["a new pane's first message"]();
  expect(failed).toBe(2);
  expect(d.calls).toEqual(["look", "look", "look", PASTE, "Enter"]);
});

it("asks again a moment later when herdr's snapshot is not read for a queued message's look at omp's start", async () => {
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  const d = omp();
  // a connection's own message, queued behind a turn; the turn ends
  d.pane["agent_status"] = "working";
  expect(await d.ways["a queue request typed at once"]()).toMatchObject({ ok: true, pending: { state: "queued" } });
  d.pane["agent_status"] = "idle";
  // herdr answers no snapshot for the drain's look at omp's start: left at that, the message would stay queued with
  // nothing to drain it once herdr answers again
  d.herdrNow.silent = true;
  d.hooks.look = (looks) => { if (looks === 2) d.report(); };
  await d.rest();
  expect(d.typed()).toEqual([]);
  d.herdrNow.silent = false;
  await d.eventually("the message's send", () => d.calls.includes("Enter"));
  expect(d.typed()).toEqual([PASTE, "Enter"]);
  expect(warn.mock.calls).toEqual([]);
});

it.each(BY_HAND)("types nothing of %s when herdr does not say whether its omp is starting, and says so", async (way) => {
  const d = omp();
  // the send's own look at omp's start is not answered
  let failed = 0;
  d.hooks.processes = (start) => start && failed === 0 && ++failed > 0 ? "fail" : undefined;
  const answer = await d.ways[way]();
  expect(failed).toBe(1);
  expect(answer).toMatchObject({ ok: false, code: "herdr_unavailable" });
  expect(d.typed()).toEqual([]);
});

it("holds a first message with herdr's own word once herdr has not said for half a minute whether omp is starting", async () => {
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  const d = omp();
  // no look at omp's start is answered
  let unanswered = 0;
  d.hooks.processes = (start) => start && ++unanswered > 0 ? "fail" : undefined;
  await d.first();
  await d.eventually("a few looks that are not answered", () => unanswered >= 3);
  // asked again and again, the message still queued and nothing typed
  expect([d.typed(), d.listed().map((message) => message.state)]).toEqual([[], ["queued"]]);
  // half a minute of that: an omp that was starting then takes input by now, so the send is taken up, and its own
  // look, not answered either, holds the message with the reason rather than type it unseen
  d.advance(30_001);
  await d.eventually("the hold", () => d.listed()[0]?.state === "held");
  expect([d.typed(), d.listed().map((message) => message.error?.code)]).toEqual([[], ["herdr_unavailable"]]);
  void warn;
});

it.each(["steer", "discard"] as const)("holds nothing typed after a first message left the queue by its %s while omp started with nothing typed", async (action) => {
  const d = omp();
  const message = await d.first();
  await d.eventually("the wait for omp", () => d.looks() >= 2);
  d.hooks.look = () => { d.hooks.look = undefined; d.report(); };
  await d.delivery.pendingFrames["pending-action"](d.owner as never, { type: "pending-action", id: 9, pane_id: "p", pending_id: message.id, action } as never);
  await d.settled();
  await d.eventually("the queue's wait", () => d.listed().length === 0);
  // omp took input: typing into it now is its ordinary use, and a chat message goes at once as on main
  await d.type();
  await d.delivery.pendingFrames.submit(d.owner as never, { type: "submit", id: 5, pane_id: "p", text: "second words", payload: "second words", delivery: "immediate" } as never);
  await d.settled();
  expect(d.result("submit-result", 5)?.["pending"]).toBeUndefined();
  expect(d.calls.at(-1)).toBe("immediate");
});

it("holds nothing typed after a first message held from the start went by its Send now once omp took input", async () => {
  const d = omp();
  // no page to type it: held at once, and the queue never waits for omp
  const message = await d.delivery.queueFirstMessage("p", "first words", "omp", null, OMP) as unknown as Row;
  await d.rest();
  expect(d.listed()[0]?.state).toBe("held");
  d.hooks.look = () => { d.hooks.look = undefined; d.report(); };
  await d.delivery.pendingFrames["pending-action"](d.owner as never, { type: "pending-action", id: 9, pane_id: "p", pending_id: message.id, action: "steer" } as never);
  await d.settled();
  expect(d.result("pending-result", 9)).toMatchObject({ ok: true });
  await d.type();
  await d.delivery.pendingFrames.submit(d.owner as never, { type: "submit", id: 5, pane_id: "p", text: "second words", payload: "second words", delivery: "immediate" } as never);
  await d.settled();
  expect(d.result("submit-result", 5)?.["pending"]).toBeUndefined();
  expect(d.calls.at(-1)).toBe("immediate");
});

it.each(["immediate", "queue"] as const)("sends a %s message as before once a first message held for typing went by its Send now to the reported omp", async (delivery) => {
  const d = omp();
  const message = await d.first();
  await d.eventually("the wait for omp", () => d.looks() >= 2);
  await d.type();
  await d.eventually("the hold", () => d.listed()[0]?.state === "held");
  d.report();
  await d.delivery.pendingFrames["pending-action"](d.owner as never, { type: "pending-action", id: 9, pane_id: "p", pending_id: message.id, action: "steer" } as never);
  await d.settled();
  expect(d.typed()).toEqual(["typed in the terminal", PASTE, "Enter"]);
  // its Enter submitted omp's box, typed words and all, as its sender chose: what comes next goes as on main
  d.advance(5_000);
  await d.delivery.pendingFrames.submit(d.owner as never, { type: "submit", id: 5, pane_id: "p", text: "second words", payload: delivery === "immediate" ? "second words" : "unused", delivery } as never);
  await d.settled();
  expect(d.result("submit-result", 5)?.["pending"]).toBeUndefined();
  expect(d.typed().length).toBeGreaterThan(3);
});

it.each(["a screen read before the paste", "the paste's write"] as const)("types nothing behind the typed words after a Send now to the reported omp failed at %s: the start is not over", async (failAt) => {
  const d = omp();
  const message = await d.first();
  await d.eventually("the wait for omp", () => d.looks() >= 2);
  await d.type();
  await d.eventually("the hold", () => d.listed()[0]?.state === "held");
  d.report();
  // herdr does not answer the Send now's third read of the screen, or does not write its paste
  let reads = 0;
  if (failAt === "a screen read before the paste") d.hooks.read = () => { if (++reads >= 3) throw new herdr.HerdrError("herdr_unavailable", "herdr did not answer"); };
  const write = spyOn(herdr, "paneSendText");
  const written = write.getMockImplementation()!;
  if (failAt === "the paste's write") write.mockImplementation(async () => { throw new herdr.HerdrError("herdr_unavailable", "herdr did not answer"); });
  await d.delivery.pendingFrames["pending-action"](d.owner as never, { type: "pending-action", id: 9, pane_id: "p", pending_id: message.id, action: "steer" } as never);
  await d.settled();
  expect(d.result("pending-result", 9)).toMatchObject({ ok: false });
  d.hooks.read = undefined;
  write.mockImplementation(written);
  // the typed words are still in omp's box: a queue request is not pasted and entered behind them
  await d.delivery.pendingFrames.submit(d.owner as never, { type: "submit", id: 11, pane_id: "p", text: "second words", payload: "unused", delivery: "queue" } as never);
  await d.settled();
  expect(d.result("submit-result", 11)?.["typed_now"]).toBeUndefined();
  expect(d.typed().filter((call) => call.includes("second words"))).toEqual([]);
});

it("holds a first message for what was typed just before omp's start is given up on, at the wait's look past it", async () => {
  const d = omp();
  await d.first();
  await d.eventually("the wait for omp", () => d.looks() >= 2);
  await d.type();
  d.advance(30_001);
  await d.eventually("the hold or the send", () => d.listed()[0]?.state === "held" || d.calls.includes("Enter"));
  expect(d.typed()).toEqual(["typed in the terminal"]);
  expect(d.listed()[0]).toMatchObject({ state: "held", error: { code: "typed_while_waiting" } });
});

it("holds a first message for what was typed just before omp's start is given up on, though a chat message comes before the wait's next look", async () => {
  const d = omp();
  await d.first();
  await d.eventually("the wait for omp", () => d.looks() >= 2);
  await d.type();
  d.advance(30_001);
  await d.delivery.pendingFrames.submit(d.owner as never, { type: "submit", id: 5, pane_id: "p", text: "second words", payload: "second words", delivery: "immediate" } as never);
  /** the first message as the page was last told it */
  const firstRow = () => d.frames.filter((frame) => frame.type === "pending-messages").flatMap((frame) => (frame["messages"] ?? []) as Row[])
    .filter((row) => row.text === "first words").at(-1);
  await d.eventually("the hold or the send", () => firstRow()?.state === "held" || d.calls.includes("Enter"));
  expect(d.typed()).toEqual(["typed in the terminal"]);
  expect([firstRow()?.error?.code, (d.result("submit-result", 5)?.["pending"] as Row | undefined)?.error?.code]).toEqual(["typed_while_waiting", "typed_while_waiting"]);
});

it("holds a queued message for what was typed while herdr did not say whether its omp is starting", async () => {
  const d = omp();
  d.pane["agent_status"] = "working";
  expect(await d.ways["a queue request typed at once"]()).toMatchObject({ ok: true, pending: { state: "queued" } });
  d.pane["agent_status"] = "idle";
  d.herdrNow.silent = true;
  await d.rest();
  await d.type();
  d.herdrNow.silent = false;
  d.hooks.look = (looks) => { if (looks === 2) d.report(); };
  await d.eventually("the hold or the send", () => d.listed()[0]?.state === "held" || d.calls.includes("Enter"));
  expect(d.typed()).toEqual(["typed in the terminal"]);
  expect(d.listed()[0]).toMatchObject({ state: "held", error: { code: "typed_while_waiting" } });
});

it("holds a new pane's first message when its terminal was typed into before the pane first came to rest", async () => {
  const d = omp();
  // typed while herdr still read the pane as unknown, before any wait: the message was already queued for this omp
  await d.ways["a new pane's first message"](() => d.listed()[0]?.state === "held", () => { void d.type(); });
  expect([d.calls, d.listed().map((message) => message.error?.code)]).toEqual([["typed in the terminal"], ["typed_while_waiting"]]);
  d.report();
  await d.rest();
  expect(d.typed()).toEqual(["typed in the terminal"]);
});
