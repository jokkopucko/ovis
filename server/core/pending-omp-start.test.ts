import { afterEach, expect, it, mock, spyOn } from "bun:test";
import * as herdr from "../herdr/client.ts";
import * as processStart from "../process-start.ts";
import { createSubmitText } from "./composer.ts";
import { connectionData } from "./connections.ts";
import { createPendingDelivery, FIRST_MESSAGE_OWNER } from "./pending.ts";

const ends: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const end of ends.splice(0)) await end();
  mock.restore();
});

type Frame = { type: string; [key: string]: unknown };
type Row = { id: string; state: string; text?: string; error?: { code: string }; waiting?: string };
const SHELL = 41000, OMP = 41001;
const INTEGRATED = ["omp", "-e", "/opt/herdr/herdr-omp-agent-state.ts"];
const SESSION = { agent: "omp", kind: "path", source: "herdr:omp", value: "/fixture/session.jsonl" };
const PASTE = "\u001b[200~first words\u001b[201~";
const GONE = { code: "pane_not_found", message: "The pane ended; its pending messages were not sent" };

function omp(setup: { startedAgo?: number; argv?: readonly string[]; reported?: boolean; realSubmit?: boolean } = {}) {
  const calls: string[] = [], frames: Frame[] = [];
  const pane: Record<string, unknown> = { pane_id: "p", terminal_id: "p", workspace_id: "w", tab_id: "t", agent: "omp", agent_status: "idle", focused: false, revision: 0,
    ...(setup.reported ? { agent_session: SESSION } : {}) };
  const hooks: { look?: (looks: number) => void; read?: (reads: number) => void | Promise<void>; authorize?: () => void;
    processes?: (start: boolean) => "fail" | "empty" | undefined } = {};
  let looks = 0, reads = 0, asked = 0, allowed = true, skew = 0, typedCount = 0;
  const herdrNow = { silent: false, paneGone: false };
  const realNow = Date.now.bind(Date);
  spyOn(Date, "now").mockImplementation(() => realNow() + skew);
  let started: number | undefined;
  spyOn(processStart, "processStartedAt").mockImplementation(() => started ??= Date.now() - (setup.startedAgo ?? 0));
  spyOn(processStart, "processStartedAtAsync").mockResolvedValue(1000);
  spyOn(herdr, "paneProcessInfo").mockImplementation(async () => {
    asked += 1;
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
    authorizeSocket: () => { hooks.authorize?.(); if (!allowed) throw new herdr.HerdrError("read_only", "this device may only watch"); },
    clientSnapshot: async () => {
      if (herdrNow.silent) throw new herdr.HerdrError("herdr_unavailable", "herdr did not answer");
      return { panes: herdrNow.paneGone ? [] : [pane] };
    },
    omo: { sessionOf: () => null }, SUBMIT_DEADLINE_MS: 45_000, SUBMIT_DELAY_MS: 0, TYPED_SETTLE_MS: 0,
  } as unknown as Parameters<typeof createPendingDelivery>[0]);
  const result = (type: string, id: number) => frames.find((frame) => frame.type === type && frame.id === id);
  const listed = () => (frames.filter((frame) => frame.type === "pending-messages").at(-1)?.["messages"] ?? []) as Row[];
  const settled = async () => {
    for (let turn = 0; turn < 20; turn++) {
      for (let before: unknown; before !== tail;) { before = tail; await tail.catch(() => {}); }
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  };
  const eventually = async (what: string, done: () => boolean) => {
    for (const deadline = performance.now() + 4_000; !done();) {
      if (performance.now() > deadline) throw new Error(`timed out waiting for ${what}; calls ${JSON.stringify(calls)}`);
      await Bun.sleep(1);
    }
    await settled();
  };
  const rest = async () => { delivery.pending.status("p", "idle"); delivery.drainPending("p"); await settled(); };
  const first = async (queued?: () => void): Promise<Row> => {
    const message = await delivery.queueFirstMessage("p", "first words", "omp", owner.data.connectionId, OMP);
    queued?.();
    await rest();
    return message as unknown as Row;
  };
  const ways = {
    "a queue request typed at once": async (): Promise<Frame | undefined> => {
      await delivery.pendingFrames.submit(owner as never, { type: "submit", id: 1, pane_id: "p", text: "first words", payload: "unused", delivery: "queue" } as never);
      await settled();
      return result("submit-result", 1);
    },
    "Send now of a held message": async (): Promise<Frame | undefined> => {
      await delivery.pendingFrames.submit(owner as never, { type: "submit", id: 1, pane_id: "p", text: "first words", payload: "unused", delivery: "hold" } as never);
      const held = result("submit-result", 1) as unknown as { pending: { id: string } };
      await delivery.pendingFrames["pending-action"](owner as never, { type: "pending-action", id: 2, pane_id: "p", pending_id: held.pending.id, action: "steer" } as never);
      await settled();
      return result("pending-result", 2);
    },
    "a new pane's first message": async (until: () => boolean = () => calls.includes("Enter"), queued?: () => void): Promise<Frame | undefined> => {
      await first(queued);
      await eventually("the first message's send", until);
      return undefined;
    },
  };
  const typed = () => calls.filter((call) => call !== "look");
  const type = () => serialize("p", () => { typedCount += 1; calls.push("typed in the terminal"); });
  ends.push(async () => { paneEnds(); await settled(); });
  const paneEnds = () => { delivery.holdPendingPane("p", GONE); delivery.pending.forget("p"); };
  return { calls, typed, looks: () => looks, asked: () => asked, pane, facts, hooks, ways, first, listed, rest, settled, eventually, serialize, delivery, owner, result, paneEnds, clients, herdrNow, type, frames,
    report: () => { pane["agent_session"] = SESSION; }, revoke: () => { allowed = false; }, advance: (ms: number) => { skew += ms; } };
}
type Way = "a queue request typed at once" | "Send now of a held message" | "a new pane's first message";
const WAYS: Way[] = ["a queue request typed at once", "Send now of a held message", "a new pane's first message"];
const BY_HAND: Way[] = ["a queue request typed at once", "Send now of a held message"];

// omp draws its input box, and herdr shows it at rest, seconds before it takes an Enter: a message typed meanwhile stays
// in the box and never runs, while its row says sent.
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
  d.hooks.look = (looks) => { if (looks === 3) d.advance(30_001); };
  await d.ways[way]();
  expect(d.calls).toEqual(["look", "look", "look", PASTE, "Enter"]);
  expect(warn.mock.calls.flat().join(" ")).toContain("reported no session");
});

it.each(BY_HAND)("types nothing of %s when the omp it waited for quits while it starts, and says the pane changed", async (way) => {
  const d = omp();
  d.hooks.look = (looks) => { if (looks === 2) d.pane["agent"] = null; };
  expect(await d.ways[way]()).toMatchObject({ ok: false, code: "pending_target_changed" });
  expect(d.calls).toEqual(["look", "look"]);
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
  const during = omp();
  during.hooks.look = (looks) => { if (looks === 2) during.advance(45_001); };
  expect(await during.ways["a queue request typed at once"]()).toMatchObject({ ok: false, code: "submit_timeout" });
  expect(during.calls).toEqual(["look", "look"]);
  mock.restore();
  const before = omp();
  before.hooks.read = (reads) => { if (reads === 2) before.advance(45_001); };
  expect(await before.ways["a queue request typed at once"]()).toMatchObject({ ok: false, code: "submit_timeout" });
  expect(before.calls).toEqual([]);
});

it("queues a queue request whose omp is at work by its report, and types it at that turn's end", async () => {
  const d = omp();
  d.hooks.look = (looks) => { if (looks === 2) { d.report(); d.pane["agent_status"] = "working"; } };
  expect(await d.ways["a queue request typed at once"]()).toMatchObject({ ok: true, pending: { state: "queued" } });
  expect(d.typed()).toEqual([]);
  d.pane["agent_status"] = "idle";
  await d.rest();
  expect(d.typed()).toEqual([PASTE, "Enter"]);
});

it("types a new pane's first message that waited for a starting omp only while the pane is still at rest", async () => {
  const d = omp();
  d.hooks.look = (looks) => { if (looks === 2) { d.report(); d.pane["agent_status"] = "working"; } };
  await d.ways["a new pane's first message"](() => d.looks() >= 2);
  expect(d.typed()).toEqual([]);
  expect(d.listed().map((message) => message.state)).toEqual(["queued"]);
  d.pane["agent_status"] = "idle";
  await d.rest();
  expect(d.calls).toEqual(["look", "look", PASTE, "Enter"]);
});

it("lets what is typed into the pane through while its first message waits for omp, and holds the message for it", async () => {
  const d = omp();
  d.hooks.look = (looks) => { if (looks === 2) void d.type(); };
  await d.ways["a new pane's first message"](() => d.listed()[0]?.state === "held");
  expect(d.calls).toEqual(["look", "look", "typed in the terminal"]);
  expect(d.listed().map((message) => [message.state, message.error?.code, message.waiting])).toEqual([["held", "typed_while_waiting", undefined]]);
  d.report();
  await d.rest();
  expect(d.typed()).toEqual(["typed in the terminal"]);
  await d.delivery.pendingFrames["pending-action"](d.owner as never, { type: "pending-action", id: 9, pane_id: "p", pending_id: d.listed()[0]!.id, action: "steer" } as never);
  await d.settled();
  expect(d.typed()).toEqual(["typed in the terminal", PASTE, "Enter"]);
});

it("holds every message that waits behind a starting omp once something is typed there, and none when nothing is", async () => {
  const d = omp();
  await d.first();
  await d.eventually("the wait for omp", () => d.looks() >= 2);
  await d.delivery.pendingFrames.submit(d.owner as never, { type: "submit", id: 4, pane_id: "p", text: "second words", payload: "unused", delivery: "queue" } as never);
  await d.type();
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
  expect([d.typed(), d.listed(), d.delivery.pending.holds("p")]).toEqual([[], [], false]);
  const looks = d.looks();
  await d.settled();
  expect(d.looks()).toBe(looks);
});

it("takes a first message with its pane once its send has ended, when the pane ended while the queue was sending it", async () => {
  const d = omp({ reported: true });
  d.hooks.read = (reads) => { if (reads === 1) d.paneEnds(); };
  await d.first();
  expect([d.typed(), d.listed(), d.delivery.pending.holds("p")]).toEqual([[], [], false]);
  expect((await d.delivery.queueFirstMessage("p", "another", "omp", d.owner.data.connectionId, OMP)).state).toBe("queued");
});

it("takes a first message with its pane once its Send now has ended, when the pane ended while that waited for omp", async () => {
  const d = omp();
  const message = await d.first();
  await d.eventually("the wait for omp", () => d.looks() >= 2);
  let ended = false;
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
  d.hooks.look = () => { d.report(); };
  await d.delivery.pendingFrames["pending-action"](d.owner as never, { type: "pending-action", id: 9, pane_id: "p", pending_id: message.id, action } as never);
  await d.settled();
  expect(d.result("pending-result", 9)).toMatchObject({ ok: true });
  expect(d.typed()).toEqual(action === "steer" ? [PASTE, "Enter"] : []);
  const looks = d.looks();
  await d.settled();
  expect(d.looks()).toBe(looks);
});

it("leaves a pane's first message queued when only an earlier pane of that id ended", async () => {
  const d = omp({ reported: true });
  d.paneEnds();
  d.advance(5);
  d.hooks.read = (reads) => { if (reads === 1) d.facts.ready = false; };
  await d.first();
  expect([d.typed(), d.listed().map((message) => message.state), d.delivery.pending.holds("p")]).toEqual([[], ["queued"], true]);
});

it("goes on waiting for omp while herdr does not answer, and sends the first message at the report", async () => {
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  const d = omp();
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
  let missed = 0;
  d.hooks.processes = (start) => start && missed === 0 && ++missed > 0 ? "empty" : undefined;
  await d.ways["a new pane's first message"]();
  expect(missed).toBe(1);
  expect(d.typed()).toEqual(["typed in the terminal", PASTE, "Enter"]);
  expect(d.calls.indexOf("typed in the terminal")).toBeLessThan(d.calls.lastIndexOf("look"));
});

it("keeps a connection's own message for it when its pane ends while the queue is sending it", async () => {
  const d = omp({ reported: true });
  d.pane["agent_status"] = "working";
  expect(await d.ways["a queue request typed at once"]()).toMatchObject({ ok: true, pending: { state: "queued" } });
  d.hooks.read = () => { d.paneEnds(); d.hooks.read = undefined; };
  d.pane["agent_status"] = "idle";
  await d.rest();
  expect([d.typed(), d.listed().map((message) => message.state), d.delivery.pending.holds("p")]).toEqual([[], ["held"], true]);
});

it("types a queue request at once into an omp that is at work by the send's own read, when nothing was waited for: as before", async () => {
  const d = omp({ reported: true });
  d.hooks.read = (reads) => { if (reads === 2) d.pane["agent_status"] = "working"; };
  expect(await d.ways["a queue request typed at once"]()).toMatchObject({ ok: true, typed_now: true });
  expect(d.typed()).toEqual([PASTE, "Enter"]);
});

it("leaves nothing of a first message taken with its pane for the next pane of that id", async () => {
  const d = omp({ reported: true });
  d.hooks.read = (reads) => { if (reads === 1) d.paneEnds(); };
  await d.first();
  const told: Frame[] = [];
  const page = { data: connectionData({ deviceId: undefined, readOnly: false }), getBufferedAmount: () => 0, send: (value: string) => { told.push(JSON.parse(value) as Frame); return 1; } };
  page.data.attached.set("p", { keepSize: false });
  d.clients.add(page);
  d.delivery.attached(page as never, "p");
  expect(told.filter((frame) => frame.type === "pending-messages" && ((frame["messages"] as unknown[]).length > 0 || frame["removed"] !== undefined))).toEqual([]);
});

it("queues a chat message sent at once behind a first message that waits for omp, and sends them in that order", async () => {
  const d = omp();
  await d.first();
  await d.eventually("the wait for omp", () => d.looks() >= 2);
  await d.delivery.pendingFrames.submit(d.owner as never, { type: "submit", id: 5, pane_id: "p", text: "second words", payload: "second words", delivery: "immediate" } as never);
  await d.settled();
  expect(d.result("submit-result", 5)).toMatchObject({ ok: true, pending: { state: "queued", text: "second words" } });
  expect(d.result("submit-result", 5)?.["typed_now"]).toBeUndefined();
  expect(d.calls).not.toContain("immediate");
  d.report();
  await d.eventually("the first message's send", () => d.calls.includes("Enter"));
  expect(d.typed()).toEqual([PASTE, "Enter"]);
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

it("holds what waits for a starting omp once a line is sent from the terminal's input line, which goes as typed", async () => {
  const d = omp({ realSubmit: true });
  await d.first();
  await d.eventually("the wait for omp", () => d.looks() >= 2);
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
  d.hooks.read = async () => {
    d.hooks.read = undefined;
    const deadline = performance.now() + 4_000;
    while (d.listed()[0]?.state !== "held" && performance.now() < deadline) await Bun.sleep(1);
  };
  await d.delivery.pendingFrames.submit(d.owner as never, { type: "submit", id: 5, pane_id: "p", text: "second words", payload: "second words", delivery: "immediate" } as never);
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
    if (looks === 2) discard = d.delivery.pendingFrames["pending-action"](d.owner as never, { type: "pending-action", id: 3, pane_id: "p", pending_id: held.pending.id, action: "discard" } as never);
    if (looks === 4) d.report();
  };
  await d.delivery.pendingFrames["pending-action"](d.owner as never, { type: "pending-action", id: 2, pane_id: "p", pending_id: held.pending.id, action: "steer" } as never);
  await discard;
  await d.settled();
  expect(d.calls).toEqual(["look", "look"]);
  const removed = d.frames.filter((frame) => frame.type === "pending-messages").flatMap((frame) => (frame["removed"] as Array<{ outcome: string }> | undefined) ?? []).map((entry) => entry.outcome);
  expect(removed.filter((outcome) => outcome === "sent")).toEqual([]);
  expect(removed).toContain("discarded");
  expect([d.result("pending-result", 2), d.result("pending-result", 3)]).toMatchObject([{ ok: true }, { ok: true }]);
  expect(d.listed()).toEqual([]);
});

it("types nothing into an omp while herdr does not say whether it is starting, and sends the first message at its report", async () => {
  const d = omp();
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
  d.pane["agent_status"] = "working";
  expect(await d.ways["a queue request typed at once"]()).toMatchObject({ ok: true, pending: { state: "queued" } });
  d.pane["agent_status"] = "idle";
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
  let unanswered = 0;
  d.hooks.processes = (start) => start && ++unanswered > 0 ? "fail" : undefined;
  await d.first();
  await d.eventually("a few looks that are not answered", () => unanswered >= 3);
  expect([d.typed(), d.listed().map((message) => message.state)]).toEqual([[], ["queued"]]);
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
  await d.type();
  await d.delivery.pendingFrames.submit(d.owner as never, { type: "submit", id: 5, pane_id: "p", text: "second words", payload: "second words", delivery: "immediate" } as never);
  await d.settled();
  expect(d.result("submit-result", 5)?.["pending"]).toBeUndefined();
  expect(d.calls.at(-1)).toBe("immediate");
});

it("holds nothing typed after a first message held from the start went by its Send now once omp took input", async () => {
  const d = omp();
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
  d.advance(5_000);
  // herdr reads the Send now's turn and its end: a message sent to the queue goes behind no open wait (#4118)
  d.delivery.pending.status("p", "working"); await d.rest();
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
  await d.ways["a new pane's first message"](() => d.listed()[0]?.state === "held", () => { void d.type(); });
  expect([d.calls, d.listed().map((message) => message.error?.code)]).toEqual([["typed in the terminal"], ["typed_while_waiting"]]);
  d.report();
  await d.rest();
  expect(d.typed()).toEqual(["typed in the terminal"]);
});

it.each([
  ["its page left", "pending_lease_lost"],
  ["its deadline passed", "submit_timeout"],
] as const)("refuses a queue request typed at once when %s during the last look of a wait for omp that ran out before its first poll", async (what, code) => {
  const d = omp();
  // the send's own read finds omp at work; its start then runs out between the look at the process and the first
  // poll, so the wait returns the pane it was given after one more process read, during which this happens
  let step: "start" | "ran out" | "last look" | "done" = "start";
  d.hooks.read = (reads) => { if (reads === 2) d.pane["agent_status"] = "working"; };
  d.hooks.processes = (start) => {
    if (start && step === "start") step = "ran out";
    else if (!start && step === "last look") {
      step = "done";
      if (what === "its page left") { d.delivery.holdPending(d.owner as never, "p"); d.facts.member = false; } else d.advance(20_000);
    }
    return undefined;
  };
  d.hooks.authorize = () => { if (step === "ran out") { step = "last look"; d.advance(31_000); } };
  expect(await d.ways["a queue request typed at once"]()).toMatchObject({ ok: false, code });
  expect(step as string).toBe("done");
  expect(d.delivery.pending.list(d.owner as never, "p"), "queued after all, its row would say it waits for the agent's turn").toEqual([]);
  expect(d.typed()).toEqual([]);
});

const SECOND = "\u001b[200~second words\u001b[201~";
const atOnce = (id = 5) => ({ type: "submit", id, pane_id: "p", text: "second words", payload: "second words", delivery: "immediate" }) as never;

/** a second page on the pane, behind a first message that waits for omp */
async function secondPage() {
  const d = omp();
  await d.first();
  await d.eventually("the wait for omp", () => d.looks() >= 2);
  const told: Frame[] = [];
  const other = { data: connectionData({ deviceId: undefined, readOnly: false }), getBufferedAmount: () => 0, send: (value: string) => { told.push(JSON.parse(value) as Frame); return 1; } };
  other.data.attached.set("p", { keepSize: false });
  d.clients.add(other);
  // the harness's facts are every connection's: a page whose attach is still starting has no ready attachment
  const starting = (yes: boolean): void => { Object.assign(d.facts, { attached: !yes, member: !yes, ready: !yes }); };
  const ahead = Promise.withResolvers<void>();
  void d.serialize("p", () => ahead.promise);
  return { d, other, starting, ahead, answer: () => told.find((frame) => frame.type === "submit-result" && frame.id === 5) };
}
async function firstSentThenTurnEnds(d: ReturnType<typeof omp>): Promise<void> {
  d.report();
  await d.eventually("the first message's send", () => d.calls.includes("Enter"));
  d.pane["agent_status"] = "working"; d.delivery.pending.status("p", "working"); d.delivery.drainPending("p"); await d.settled();
  d.pane["agent_status"] = "idle";
  await d.rest();
}

it.each(["ready", "not ready yet"])("refuses a chat message sent at once that would wait behind a starting omp when its page, %s as the frame came, left the pane and came back while the frame waited its turn", async (as) => {
  const { d, other, starting, ahead, answer } = await secondPage();
  starting(as !== "ready");
  const sent = d.delivery.pendingFrames.submit(other as never, atOnce());
  // what terminals.ts detach() does; its new attach is ready before the frame's turn
  d.delivery.holdPending(other as never, "p");
  starting(false);
  ahead.resolve();
  await sent;
  await d.settled();
  expect(answer()).toMatchObject({ ok: false, code: "pending_lease_lost" });
  expect(d.delivery.pending.list(other as never, "p")).toEqual([]);
  await firstSentThenTurnEnds(d);
  expect(d.typed()).toEqual([PASTE, "Enter"]);
});

it("queues a chat message sent at once behind a starting omp from a page that stayed while its attach became ready, and holds it once the page leaves", async () => {
  const { d, other, starting, ahead, answer } = await secondPage();
  starting(true);
  const sent = d.delivery.pendingFrames.submit(other as never, atOnce());
  starting(false);
  ahead.resolve();
  await sent;
  await d.settled();
  expect(answer()).toMatchObject({ ok: true, pending: { state: "queued", text: "second words" } });
  d.delivery.holdPending(other as never, "p");
  await firstSentThenTurnEnds(d);
  expect(d.delivery.pending.list(other as never, "p").map((row) => [row.state, row.error?.code])).toEqual([["held", "pending_lease_lost"]]);
  expect(d.typed()).toEqual([PASTE, "Enter"]);
});

it("neither lists nor types again a chat message sent at once, queued behind a starting omp and discarded, when its frame comes twice", async () => {
  const d = omp();
  await d.first();
  await d.eventually("the wait for omp", () => d.looks() >= 2);
  await d.delivery.pendingFrames.submit(d.owner as never, atOnce());
  await d.settled();
  const row = d.result("submit-result", 5) as unknown as { pending: { id: string } };
  await d.delivery.pendingFrames["pending-action"](d.owner as never, { type: "pending-action", id: 6, pane_id: "p", pending_id: row.pending.id, action: "discard" } as never);
  expect(d.result("pending-result", 6)).toMatchObject({ ok: true });
  await d.delivery.pendingFrames.submit(d.owner as never, atOnce());
  await d.settled();
  expect(d.frames.filter((frame) => frame.type === "submit-result" && frame.id === 5).at(-1)).toMatchObject({ ok: true });
  expect(d.delivery.pending.list(d.owner as never, "p")).toEqual([]);
  await firstSentThenTurnEnds(d);
  expect(d.typed()).toEqual([PASTE, "Enter"]);
});

it("does not type again a chat message sent at once, queued behind a starting omp and sent at its turn, when its frame comes twice", async () => {
  const d = omp();
  await d.first();
  await d.eventually("the wait for omp", () => d.looks() >= 2);
  await d.delivery.pendingFrames.submit(d.owner as never, atOnce());
  await d.settled();
  await firstSentThenTurnEnds(d);
  expect(d.typed()).toEqual([PASTE, "Enter", SECOND, "Enter"]);
  await d.delivery.pendingFrames.submit(d.owner as never, atOnce());
  await d.settled();
  expect(d.typed()).toEqual([PASTE, "Enter", SECOND, "Enter"]);
});

it("types once a chat message sent at once whose frame comes again before its turn, when omp reports between the two", async () => {
  const d = omp();
  await d.first();
  await d.eventually("the wait for omp", () => d.looks() >= 2);
  const ahead = Promise.withResolvers<void>();
  void d.serialize("p", () => ahead.promise);
  const once = d.delivery.pendingFrames.submit(d.owner as never, atOnce());
  // a task in the lane meanwhile, during which omp reports and the queue's wait for it ends (its poll runs outside the lane)
  void d.serialize("p", async () => {
    d.report();
    for (const deadline = performance.now() + 4_000; d.delivery.pending.waiting("p");) {
      if (performance.now() > deadline) throw new Error("the wait for omp did not end");
      await Bun.sleep(1);
    }
  });
  const again = d.delivery.pendingFrames.submit(d.owner as never, atOnce());
  ahead.resolve();
  await once; await again; await d.settled();
  expect(d.frames.filter((frame) => frame.type === "submit-result" && frame.id === 5)).toMatchObject([{ ok: true }, { ok: true }]);
  await firstSentThenTurnEnds(d);
  expect(d.typed()).toEqual([PASTE, "Enter", SECOND, "Enter"]);
});

it("pastes nothing when the deadline passed while the paste's herdr connection opened", async () => {
  const d = omp({ reported: true });
  // herdrRpc asks the guard once the connection is open, here 46 s after the call
  spyOn(herdr, "paneSendText").mockImplementation(async (_pane, text, _socket, guard) => {
    d.advance(46_000);
    if (guard && !guard()) throw new herdr.HerdrError("cancelled", "herdr pane.send_text was not sent: the sender may no longer send");
    d.calls.push(text);
  });
  const answer = await d.ways["a queue request typed at once"]();
  expect([answer, d.typed()]).toMatchObject([{ ok: false, code: "submit_timeout" }, []]);
});

it("refuses a chat message sent at once that waited past its deadline where it would be queued behind a terminal typed into while omp started", async () => {
  const d = omp();
  const ahead = Promise.withResolvers<void>();
  void d.serialize("p", () => ahead.promise);
  const first = d.delivery.queueFirstMessage("p", "first words", "omp", d.owner.data.connectionId, 41001);
  void d.type();
  const sent = d.delivery.pendingFrames.submit(d.owner as never, atOnce());
  d.advance(46_000);
  ahead.resolve();
  await first; await sent; await d.settled();
  expect(d.result("submit-result", 5)).toMatchObject({ ok: false, code: "submit_timeout" });
  expect(d.delivery.pending.list(d.owner as never, "p")).toEqual([]);
});

it("refuses, and never types, a chat message sent at once that waited past its deadline behind a first message waiting for omp", async () => {
  const d = omp();
  await d.first();
  await d.eventually("the wait for omp", () => d.looks() >= 2);
  const ahead = Promise.withResolvers<void>();
  void d.serialize("p", () => ahead.promise);
  const sent = d.delivery.pendingFrames.submit(d.owner as never, atOnce());
  d.advance(46_000);
  ahead.resolve();
  await sent; await d.settled();
  expect(d.result("submit-result", 5)).toMatchObject({ ok: false, code: "submit_timeout" });
  await firstSentThenTurnEnds(d);
  expect(d.typed()).toEqual([PASTE, "Enter"]);
});
