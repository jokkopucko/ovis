import { afterEach, describe, expect, it, spyOn } from "bun:test";
import * as herdr from "../herdr/client.ts";
import * as service from "../opencode-service.ts";
import * as prompt from "../prompt.ts";
import { handlePromptRequest, OpenCodePromptState } from "../prompt.ts";
import * as served from "../runtime/capabilities.ts";
import { HERDR, HERDR_CORE } from "../runtime/capabilities.ts";
import { handlers, hub } from "./status.fake.ts";
import type { CardRead } from "../card-waits.ts";
import { shouldNotifyStatus } from "../../shared/notify-policy.ts";
import type { AgentStatus, InteractivePrompt } from "../../shared/protocol.ts";

const spies: { mockRestore(): void }[] = [];
afterEach(() => { for (const spy of spies.splice(0)) spy.mockRestore(); });
/** the server serves herdr-core (or herdr's TUI, `false`) */
const serving = (core: boolean) => { spies.push(spyOn(served, "capabilities").mockReturnValue(core ? HERDR_CORE : HERDR)); };
/** what the dialog readers find on the pane's screen from now on, and the panes read */
function screen(initial: CardRead) {
  const read: string[] = [];
  let shows: CardRead = initial;
  spies.push(spyOn(prompt, "waitingCard").mockImplementation(async (pane) => { read.push(pane.pane_id); return shows; }));
  return { read, show: (next: CardRead) => { shows = next; } };
}
const question = { kind: "question" as const, id: "q1" };
const pane = (agent: string | null, agent_status: string, extra: Record<string, unknown> = {}) => ({ pane_id: "t1", workspace_id: "w1", tab_id: "w1:t1", agent, agent_status, cwd: "/tmp", ...extra });
/** an answer from the card the pane waits on now was delivered */
const answered = (h: { status: { cards: { answer(paneId: string, generation: number): void; generation(paneId: string): number | undefined } } }): void => {
  h.status.cards.answer("t1", h.status.cards.generation("t1")!);
};
/** the waiting alerts web push would schedule: it takes a status equal to the last one as no change (push.ts onStatus) */
const waitingAlerts = (alerts: string[]) => alerts.filter((status, at) => status === "blocked" && alerts[at - 1] !== "blocked").length;
/** A hub that knows the pane as herdr and its agent's own reports tell it, its snapshot read once (what the card reads go over). */
async function started(shown: ReturnType<typeof pane>, reported: string | null = shown.agent_status) {
  const h = hub();
  h.herdrSays(shown);
  handlers.onBaseline([shown]);
  if (reported !== null) handlers.onStatus("t1", reported as never, shown.agent);
  await h.snapshot();
  return h;
}
/**
 * What web push hears of the pane from now on, in order: each status (`alerts`) and each status it is told to take as the
 * last one heard where it heard nothing (push.assume, marked `?`). Returns the waiting alerts push sends for it: a
 * blocked that is news after the last status (shouldNotifyStatus), an assumed status alerting nothing.
 */
function pushHears(h: Awaited<ReturnType<typeof started>>): () => number {
  spies.push(spyOn(h.status.push, "assume").mockImplementation((_paneId: string, status: string) => { h.alerts.push(`?${status}`); }));
  return () => {
    let last: AgentStatus | undefined;
    let sent = 0;
    for (const told of h.alerts) {
      if (told.startsWith("?")) { last ??= told.slice(1) as AgentStatus; continue; }
      if (told === "blocked" && shouldNotifyStatus(last, "blocked")) sent++;
      last = told as AgentStatus;
    }
    return sent;
  };
}

describe("a herdr-core pane whose agent asks on screen what it did not report", () => {
  it("waits for its user while Codex keeps reporting working over its question, with one waiting alert", async () => {
    serving(true);
    const h = await started(pane("codex", "working"));
    screen(question);
    await h.status.cardTick();
    expect(h.last().status).toBe("blocked");
    // the inbox's Needs you and the Agents list go by this status (src/lib/agentInbox.ts inboxStatus)
    expect((await h.snapshot()).panes[0]).toMatchObject({ agent_status: "blocked", agent_kind: "question" });
    handlers.onStatus("t1", "working", "codex");
    expect(h.last().status).toBe("blocked");
    expect(waitingAlerts(h.alerts)).toBe(1);
  });

  it("raises one waiting alert for the same card redrawn five times", async () => {
    serving(true);
    const h = await started(pane("codex", "working"));
    screen(question);
    for (let redraw = 0; redraw < 6; redraw++) await h.status.cardTick();
    expect(waitingAlerts(h.alerts)).toBe(1);
  });

  it("works again at once when the card is answered, the agent's own status back and no alert after it", async () => {
    serving(true);
    const h = await started(pane("codex", "working"));
    const shown = screen(question);
    await h.status.cardTick();
    answered(h);
    shown.show(null);
    await h.status.cardTick();
    expect(h.last().status).toBe("working");
    expect(h.alerts.at(-1)).toBe("working");
    expect(waitingAlerts(h.alerts)).toBe(1);
    expect((await h.snapshot()).panes[0]).not.toHaveProperty("agent_kind");
  });

  it("gives a send the agent's own status, so a card left the screen refuses nothing", async () => {
    serving(true);
    const h = await started(pane("codex", "working"));
    const shown = screen(question);
    await h.status.cardTick();
    // answered in the terminal itself: one read finds no card, and the wait holds for the next
    shown.show(null);
    await h.status.cardTick();
    expect((await h.snapshot()).panes[0]!.agent_status).toBe("blocked");
    // a send checks the screen itself (server/core/pending.ts): blocked only where the agent says so
    expect((await h.status.deliverySnapshot()).panes[0]!.agent_status).toBe("working");
  });

  it("waits at Claude Code's folder trust, where Claude reports nothing yet", async () => {
    serving(true);
    const h = await started(pane("claude", "unknown"), null);
    screen({ kind: null, id: "trust" });
    await h.status.cardTick();
    expect(h.last().status).toBe("blocked");
    expect((await h.snapshot()).panes[0]).toMatchObject({ agent_status: "blocked" });
  });

  it("shows nothing for a program that reports nothing and runs no agent", async () => {
    serving(true);
    const h = await started(pane(null, "unknown"), null);
    const shown = screen(question);
    await h.status.cardTick();
    expect(shown.read).toEqual([]);
    expect(h.last().status).toBeUndefined();
    expect((await h.snapshot()).panes[0]).toMatchObject({ agent_status: "unknown" });
    expect(h.alerts).toEqual([]);
  });

  it("changes nothing where the agent already reports blocked: its own kind and words stand, no second alert", async () => {
    serving(true);
    const h = await started(pane("claude", "blocked", { agent_kind: "permission", agent_message: "approve Write" }));
    const before = [...h.alerts];
    screen(question);
    await h.status.cardTick();
    expect(h.alerts).toEqual(before);
    expect((await h.snapshot()).panes[0]).toMatchObject({ agent_status: "blocked", agent_kind: "permission", agent_message: "approve Write" });
  });

  it("leaves classic herdr's statuses, rows and alerts exactly as they were", async () => {
    serving(false);
    const h = await started(pane("codex", "working"));
    const plain = JSON.stringify(await h.snapshot());
    const alerts = [...h.alerts];
    const shown = screen(question);
    await h.status.cardTick();
    expect(shown.read).toEqual([]);
    expect(JSON.stringify(await h.snapshot())).toBe(plain);
    expect(h.alerts).toEqual(alerts);
  });
});

describe("how often the cards are read", () => {
  it("reads a terminal no page in use shows on every third tick, and one a page in use shows on every tick", async () => {
    serving(true);
    const h = hub();
    const panes = [pane("codex", "working"), pane("codex", "working", { pane_id: "t2" })];
    h.herdrSays(...panes);
    handlers.onBaseline(panes);
    for (const shown of panes) handlers.onStatus(shown.pane_id, "working", "codex");
    await h.snapshot();
    const shown = screen(null);
    const readsIn = async (ticks: number) => {
      shown.read.splice(0);
      for (let tick = 0; tick < ticks; tick++) await h.tickCards();
      return { t1: shown.read.filter((id) => id === "t1").length, t2: shown.read.filter((id) => id === "t2").length };
    };
    // nobody watching
    expect(await readsIn(6)).toEqual({ t1: 2, t2: 2 });
    // a page shows t2 but is not in use (hidden, or out of focus)
    h.client.data.attached.set("t2", { keepSize: false });
    expect(await readsIn(6)).toEqual({ t1: 2, t2: 2 });
    // the page is in use: t2 is read on every tick, t1, which it does not show, still on every third
    h.present.add(h.client);
    expect(await readsIn(6)).toEqual({ t1: 2, t2: 6 });
  });

  it("skips the read of every terminal that falls due while the last one is still under way", async () => {
    serving(true);
    const h = await started(pane("codex", "working"));
    const read: string[] = [];
    const held = Promise.withResolvers<CardRead>();
    spies.push(spyOn(prompt, "waitingCard").mockImplementation(async (shown) => { read.push(shown.pane_id); return read.length === 1 ? held.promise : null; }));
    // the first read hangs across the next three ticks, the third of which is due a read of every terminal
    const first = h.tickCards();
    for (let tick = 0; tick < 3; tick++) void h.tickCards();
    held.resolve(null);
    await first;
    // the two ticks after it are not due: the turn that fell due meanwhile was taken by the read under way
    await h.tickCards();
    await h.tickCards();
    expect(read).toEqual(["t1"]);
    await h.tickCards();
    expect(read).toEqual(["t1", "t1"]);
  });
});

describe("what ends a card's wait, and what it leaves", () => {
  it("ends the wait when the agent exits at its card: the shell pane is not waiting, and its exit is not made blocked", async () => {
    serving(true);
    const h = await started(pane("codex", "working"));
    screen(question);
    await h.status.cardTick();
    expect(h.last().status).toBe("blocked");
    // Ctrl-C at Codex's question (or Claude's folder trust answered "No, exit"): the shell is back, no agent runs there
    h.herdrSays(pane(null, "unknown"));
    handlers.onStatus("t1", "unknown", null);
    expect(h.last().status).toBe("unknown");
    expect((await h.snapshot()).panes[0]).toMatchObject({ agent: null, agent_status: "unknown" });
    expect(h.status.cards.waiting("t1")).toBe(false);
  });

  it("ends the wait at the next read when the pane's agent is gone without a status of its own", async () => {
    serving(true);
    const h = await started(pane("codex", "working"));
    screen(question);
    await h.status.cardTick();
    // the agent is gone by the snapshot alone, no status event saying so: the next read finds none in front and ends the wait
    h.herdrSays(pane(null, "working"));
    await h.snapshot();
    await h.status.cardTick();
    expect(h.status.cards.waiting("t1")).toBe(false);
    expect((await h.snapshot()).panes[0]!.agent_status).not.toBe("blocked");
  });

  it("keeps the finish of a turn that ended while a card's wait was on (an agent other than Codex)", async () => {
    serving(true);
    // Hermes: no tracker of its own decides its turns, only what it reports
    const h = await started(pane("hermes", "working"));
    const shown = screen(question);
    await h.status.cardTick();
    expect(h.last().status).toBe("blocked");
    // the turn ends while the card is still drawn: still waiting, and the finish is kept for after
    handlers.onStatus("t1", "idle", "hermes");
    expect(h.last().status).toBe("blocked");
    answered(h);
    shown.show(null);
    await h.status.cardTick();
    expect(h.last().status).toBe("done");
    expect(h.alerts.at(-1)).toBe("done");
  });

  /** a screen read that answers when the test says, its pane read once begun */
  function heldRead() {
    const begun = Promise.withResolvers<void>();
    const answer = Promise.withResolvers<CardRead>();
    spies.push(spyOn(prompt, "waitingCard").mockImplementation(() => { begun.resolve(); return answer.promise; }));
    return { begun: begun.promise, answer: answer.resolve };
  }

  it("starts no wait on a terminal closed while its screen was being read", async () => {
    serving(true);
    const h = await started(pane("codex", "working"));
    const read = heldRead();
    const tick = h.status.cardTick();
    await read.begun;
    handlers.onPaneEnded("t1");
    read.answer(question);
    await tick;
    expect(h.status.cards.waiting("t1")).toBe(false);
    expect(h.alerts).not.toContain("blocked");
  });

  it("starts no wait for an agent that exits while its screen is being read", async () => {
    serving(true);
    const h = await started(pane("codex", "working"));
    const read = heldRead();
    const tick = h.status.cardTick();
    await read.begun;
    h.herdrSays(pane(null, "unknown"));
    handlers.onStatus("t1", "unknown", null);
    read.answer(question);
    await tick;
    expect(h.status.cards.waiting("t1")).toBe(false);
    expect(h.alerts).not.toContain("blocked");
  });

  it("reads no agent that exited at its card before the next snapshot, the card left on screen", async () => {
    serving(true);
    const h = await started(pane("codex", "working"));
    const sent = pushHears(h);
    const shown = screen(question);
    await h.status.cardTick();
    const reads = shown.read.length;
    // Codex killed: the shell's event names no agent, and no snapshot is taken (no page is open to ask for one)
    h.herdrSays(pane(null, "unknown"));
    handlers.onStatus("t1", "unknown", null);
    for (let tick = 0; tick < 3; tick++) await h.status.cardTick();
    expect(shown.read.length).toBe(reads);
    expect(h.status.cards.waiting("t1")).toBe(false);
    expect(sent()).toBe(1);
  });

  it("reads no agent from a snapshot begun before it exited at its card, the card left on screen", async () => {
    serving(true);
    const h = await started(pane("codex", "working"));
    const sent = pushHears(h);
    const shown = screen(question);
    await h.status.cardTick();
    const reads = shown.read.length;
    // a snapshot read begins while Codex still runs, and lands after its exit was told
    const land = await h.heldSnapshot();
    h.herdrSays(pane(null, "unknown"));
    handlers.onStatus("t1", "unknown", null);
    await land();
    for (let tick = 0; tick < 3; tick++) await h.status.cardTick();
    expect(shown.read.length).toBe(reads);
    expect(h.status.cards.waiting("t1")).toBe(false);
    expect(sent()).toBe(1);
  });

  it("keeps a wait through an older snapshot that lands late without its pane", async () => {
    serving(true);
    const h = hub();
    handlers.onBaseline([]);
    await h.snapshot();
    // a snapshot read begins before the terminal exists, and lands after a newer one that lists it
    const land = await h.heldSnapshot();
    h.herdrSays(pane("codex", "working"));
    handlers.onStatus("t1", "working", "codex");
    await h.snapshot();
    const sent = pushHears(h);
    screen(question);
    await h.status.cardTick();
    expect(h.status.cards.waiting("t1")).toBe(true);
    await land();
    for (let tick = 0; tick < 3; tick++) await h.status.cardTick();
    expect(h.status.cards.waiting("t1")).toBe(true);
    expect(sent()).toBe(1);
  });

  it("falls back to the newest report, never to an older snapshot's status", async () => {
    serving(true);
    const h = await started(pane("codex", "working"));
    const shown = screen(question);
    await h.status.cardTick();
    // the agent reports idle; herdr's last snapshot still says working
    handlers.onStatus("t1", "idle", "codex");
    answered(h);
    shown.show(null);
    await h.status.cardTick();
    expect(h.last().status).not.toBe("working");
    expect(h.last().status).not.toBe("blocked");
  });

  it("alerts again for another card that takes the place of the one waited on", async () => {
    serving(true);
    const h = await started(pane("codex", "working"));
    const sent = pushHears(h);
    const shown = screen(question);
    await h.status.cardTick();
    answered(h);
    // the answer brought Codex's next asking, a command to approve, before any read found the screen without a card
    shown.show({ kind: "permission", id: "p1" });
    await h.status.cardTick();
    expect(sent()).toBe(2);
    expect((await h.snapshot()).panes[0]).toMatchObject({ agent_status: "blocked", agent_kind: "permission" });
  });

  const codexSession = (value: string) => pane("codex", "working", { agent_session: { agent: "codex", kind: "id", source: "test", value } });
  it.each([
    ["another agent and back, told by status events", [pane("codex", "working"), pane("claude", "working"), pane("codex", "working")], true],
    ["another agent and back, told by snapshots alone", [pane("codex", "working"), pane("claude", "working"), pane("codex", "working")], false],
    ["another session of its agent and back", [codexSession("one"), codexSession("two"), codexSession("one")], false],
  ] as const)("starts no wait from a read begun before the pane changed hands and back: %s", async (_how, [began, between, again], events) => {
    serving(true);
    const h = await started(began);
    const read = heldRead();
    const tick = h.status.cardTick();
    await read.begun;
    for (const now of [between, again]) {
      h.herdrSays(now);
      if (events) handlers.onStatus("t1", "working", now.agent);
      await h.snapshot();
    }
    read.answer(question);
    await tick;
    expect(h.status.cards.waiting("t1")).toBe(false);
    expect(h.alerts).not.toContain("blocked");
  });

  it("starts no wait for an agent from the read of the one it replaced in the pane", async () => {
    serving(true);
    const h = await started(pane("codex", "working"));
    const read = heldRead();
    const tick = h.status.cardTick();
    await read.begun;
    // Codex left and Claude Code runs in the pane, by its status event and by the snapshot
    h.herdrSays(pane("claude", "working"));
    handlers.onStatus("t1", "working", "claude");
    await h.snapshot();
    read.answer(question);
    await tick;
    expect(h.status.cards.waiting("t1")).toBe(false);
    expect(h.alerts).not.toContain("blocked");
  });

  it("reads no agent only its status events had named, from a snapshot begun before it exited at its card", async () => {
    serving(true);
    // the shell, in the snapshot; Codex is known from its own status event alone
    const h = await started(pane(null, "unknown"), null);
    handlers.onStatus("t1", "working", "codex");
    const sent = pushHears(h);
    const shown = screen(question);
    await h.status.cardTick();
    expect(sent()).toBe(1);
    // a snapshot read begins while Codex still runs, and lands after its exit was told
    h.herdrSays(pane("codex", "working"));
    const land = await h.heldSnapshot();
    h.herdrSays(pane(null, "unknown"));
    handlers.onStatus("t1", "unknown", null);
    await land();
    const reads = shown.read.length;
    for (let tick = 0; tick < 3; tick++) await h.status.cardTick();
    expect(shown.read.length).toBe(reads);
    expect(h.status.cards.waiting("t1")).toBe(false);
    expect(sent()).toBe(1);
  });

  it("starts no wait and alerts nobody from a read that returns after the hub stopped", async () => {
    serving(true);
    const h = await started(pane("codex", "working"));
    const read = heldRead();
    const tick = h.status.cardTick();
    await read.begun;
    h.status.collector.stop();
    read.answer(question);
    await tick;
    expect(h.status.cards.waiting("t1")).toBe(false);
    expect(h.alerts).not.toContain("blocked");
  });

  it("reads no pane closed after the snapshot that lists it was asked for", async () => {
    serving(true);
    const h = await started(pane("codex", "working"));
    const shown = screen(question);
    const land = await h.heldSnapshot();
    handlers.onPaneEnded("t1");
    await land();
    await h.status.cardTick();
    expect(shown.read).toEqual([]);
    expect(h.status.cards.waiting("t1")).toBe(false);
  });

  it("does not read a pane a tracker of its own took while it waited behind the panes read before it", async () => {
    serving(true);
    const h = hub();
    const panes = ["t1", "t2", "t3", "t4", "t5"].map((pane_id) => pane("codex", "working", { pane_id }));
    h.herdrSays(...panes);
    handlers.onBaseline(panes);
    for (const shown of panes) handlers.onStatus(shown.pane_id, "working", "codex");
    await h.snapshot();
    const read: string[] = [];
    const held = Promise.withResolvers<CardRead>();
    spies.push(spyOn(prompt, "waitingCard").mockImplementation((shown) => { read.push(shown.pane_id); return held.promise; }));
    const tick = h.status.cardTick();
    // OmO is found in the fifth pane while the first four are read
    spies.push(spyOn(h.status.omo, "runs").mockImplementation((paneId: string) => paneId === "t5"));
    held.resolve(null);
    await tick;
    expect(read).toEqual(["t1", "t2", "t3", "t4"]);
  });

  it("ends a wait once OmO is found in the pane, whose own status shows from then on, and reads it no more", async () => {
    serving(true);
    const h = await started(pane("claude", "working"));
    const shown = screen(question);
    await h.status.cardTick();
    expect(h.last().status).toBe("blocked");
    const reads = shown.read.length;
    spies.push(spyOn(h.status.omo, "runs").mockReturnValue(true));
    for (let tick = 0; tick < 3; tick++) await h.status.cardTick();
    expect(h.status.cards.waiting("t1")).toBe(false);
    expect(h.last().status).toBe("working");
    expect(shown.read.length).toBe(reads);
  });
});

describe("an answer from a card, and the wait it ends", () => {
  const asking = pane("opencode", "working", { agent_session: { agent: "opencode", kind: "id", source: "herdr:opencode", value: "ses_fixture" } });
  const field = (key: string, label: string) => ({ key, type: "select", required: true, options: [{ value: label.toLowerCase(), label }] });
  /** OpenCode's service asking with a form of these fields, until a reply to it is in; `reply` holds that reply back */
  function openCodeAsks(fields: ReturnType<typeof field>[], reply: Promise<void> = Promise.resolve()) {
    let asked = true;
    const sent = Promise.withResolvers<void>();
    spies.push(
      spyOn(service, "openCodeService").mockResolvedValue({ config: { baseUrl: "http://127.0.0.1:1234", port: 1234, pid: 123, password: "fixture" }, version: "2.0.32" }),
      spyOn(service, "listPendingQuestionForms").mockImplementation(async () => asked ? [{ id: "form_fixture", sessionID: "ses_fixture", title: "Fixture question", metadata: { kind: "question" }, fields }] : []),
      spyOn(service, "replyOpenCodeForm").mockImplementation(async () => { sent.resolve(); await reply; asked = false; return { ok: true, status: 200 }; }),
      // with no form, OpenCode's screen is read for a question of its older versions: an empty one
      spyOn(herdr, "paneRead").mockResolvedValue({ text: "" } as never),
    );
    return { sent: sent.promise };
  }
  const page = new OpenCodePromptState();
  /** the card the page shows for the pane, and its first option answered from it: the answer's HTTP status */
  async function answerShown(): Promise<number> {
    const shown = new URL("http://127.0.0.1/api/pane/prompt?pane_id=t1");
    const card = ((await (await handlePromptRequest(new Request(shown), shown, { openCodeState: page }))!.json()) as { prompt: InteractivePrompt }).prompt;
    const url = new URL("http://127.0.0.1/api/pane/prompt/answer");
    return (await handlePromptRequest(new Request(url, { method: "POST", body: JSON.stringify({ pane_id: "t1", prompt_id: card.id, option_index: 0 }) }), url, { openCodeState: page }))!.status;
  }

  it("ends the wait on a form answered field by field at the first read after its last field was sent", async () => {
    serving(true);
    const h = await started(asking);
    openCodeAsks([field("first", "Yes"), field("last", "Red")]);
    await h.status.cardTick();
    expect(h.status.cards.waiting("t1")).toBe(true);
    expect(await answerShown()).toBe(200);
    // a read of the pane is under way as the last field is sent, and looks at the form only once that is done
    const looks = Promise.withResolvers<void>();
    const reader = prompt.waitingCard;
    spies.push(spyOn(prompt, "waitingCard").mockImplementation(async (...read) => { await looks.promise; return reader(...read); }));
    const read = h.status.cardTick();
    expect(await answerShown()).toBe(200);
    looks.resolve();
    await read;
    expect(h.status.cards.waiting("t1")).toBe(false);
  });

  it("does not end the wait on a new asking in the same words for an answer to the one before it", async () => {
    serving(true);
    const h = await started(asking);
    const held = Promise.withResolvers<void>();
    const reply = openCodeAsks([field("only", "Yes")], held.promise);
    // what a wait on this asking goes by: the next one, in the same words, goes by the same
    const same = await prompt.waitingCard(asking as never, [asking as never], { openCodeState: new OpenCodePromptState(), ompLookups: new Map() });
    const shown = screen(same);
    await h.status.cardTick();
    const answer = answerShown();
    await reply.sent;
    // its reply is still on its way when the asking is gone from the pane, and the agent asks the same again
    shown.show(null);
    await h.status.cardTick();
    await h.status.cardTick();
    expect(h.status.cards.waiting("t1")).toBe(false);
    shown.show(same);
    await h.status.cardTick();
    held.resolve();
    expect(await answer).toBe(200);
    // the read the answer set off, if it is still under way, sees the new asking; then one repaint without it
    await h.status.cardTick();
    shown.show(null);
    await h.status.cardTick();
    expect(h.status.cards.waiting("t1")).toBe(true);
  });
});

describe("a card's first sighting, and which panes are read", () => {
  it("tells web push the agent's own status before the card's wait, so a wait first heard as blocked still alerts", async () => {
    serving(true);
    // push heard nothing of the pane before: Claude at its folder trust reports nothing
    const h = await started(pane("claude", "unknown"), null);
    const assumed: [string, string][] = [];
    spies.push(spyOn(h.status.push, "assume").mockImplementation((paneId: string, status: string) => { assumed.push([paneId, status]); }));
    screen({ kind: null, id: "trust" });
    await h.status.cardTick();
    expect(assumed).toEqual([["t1", "unknown"]]);
    expect(h.alerts.at(-1)).toBe("blocked");
  });

  it("reads a pane whose first status event named no agent, once the snapshot names one", async () => {
    serving(true);
    // the shell's status event came before Claude was in front; Claude then reports nothing
    const h = await started(pane("claude", "unknown"), null);
    handlers.onStatus("t1", "unknown", null);
    await h.snapshot();
    const shown = screen({ kind: null, id: "trust" });
    await h.status.cardTick();
    expect(shown.read).toEqual(["t1"]);
    expect(h.last().status).toBe("blocked");
  });

  it("reads the agent the snapshot names when the status event newer than it named none", async () => {
    serving(true);
    // the shell, before Claude started
    const h = await started(pane(null, "unknown"), null);
    h.herdrSays(pane("claude", "unknown"));
    // a snapshot read begins and will name Claude; the shell's status event, newer than that read, names no agent
    const open = await h.heldSnapshot();
    handlers.onStatus("t1", "unknown", null);
    await open();
    const shown = screen({ kind: null, id: "trust" });
    await h.status.cardTick();
    expect(shown.read).toEqual(["t1"]);
    expect(h.last().status).toBe("blocked");
  });

  it("reads the agent the newest status event names before any snapshot names it", async () => {
    serving(true);
    const h = await started(pane(null, "unknown"), null);
    handlers.onStatus("t1", "working", "codex");
    const shown = screen(question);
    await h.status.cardTick();
    expect(shown.read).toEqual(["t1"]);
  });

  it("reads an agent that works or has reported nothing, never one at rest", async () => {
    serving(true);
    const h = await started(pane("codex", "idle"));
    const shown = screen(question);
    await h.status.cardTick();
    expect(shown.read).toEqual([]);
    handlers.onStatus("t1", "working", "codex");
    await h.status.cardTick();
    expect(shown.read).toEqual(["t1"]);
  });
});

describe("a card's wait across a resync of herdr's events, and across an exit", () => {
  it("keeps the wait, with no second alert, through a resync that names the same agent", async () => {
    serving(true);
    const h = await started(pane("codex", "working"));
    const sent = pushHears(h);
    screen(question);
    await h.status.cardTick();
    expect(sent()).toBe(1);
    // the event stream closed and is opened again, resynced from a snapshot that names the same agent, whose reports go on naming it
    handlers.onResync([pane("codex", "working")] as never, new Set(), Date.now());
    handlers.onStatus("t1", "working", "codex");
    for (let tick = 0; tick < 3; tick++) await h.status.cardTick();
    expect(h.status.cards.waiting("t1")).toBe(true);
    expect(h.last().status).toBe("blocked");
    expect(sent()).toBe(1);
  });

  /** `answered`: through its card; `left`: the card stays drawn on the screen after it */
  const exits: { exit: string; agent: string; card: CardRead; reported: string | null; answered: boolean; left: boolean }[] = [
    { exit: "Ctrl-C at Codex's question", agent: "codex", card: question, reported: "working", answered: false, left: false },
    { exit: "Claude's folder trust answered \"No, exit\"", agent: "claude", card: { kind: null, id: "trust" }, reported: null, answered: true, left: false },
    { exit: "Codex killed with its card left whole on screen", agent: "codex", card: question, reported: "working", answered: false, left: true },
  ];
  it.each(exits)("still ends the wait for good when the agent exits at its card: $exit", async ({ agent, card, reported, answered: byCard, left }) => {
    serving(true);
    const h = await started(pane(agent, reported ?? "unknown"), reported);
    const sent = pushHears(h);
    const shown = screen(card);
    await h.status.cardTick();
    expect(sent()).toBe(1);
    if (byCard) answered(h);
    if (!left) shown.show(null);
    const reads = shown.read.length;
    // the shell is back: its event names no agent, and the core's next snapshot names none either
    h.herdrSays(pane(null, "unknown"));
    handlers.onStatus("t1", "unknown", null);
    await h.snapshot();
    for (let tick = 0; tick < 3; tick++) await h.status.cardTick();
    expect(shown.read.length).toBe(reads);
    expect(h.status.cards.waiting("t1")).toBe(false);
    expect(h.last().status).not.toBe("blocked");
    expect((await h.snapshot()).panes[0]!.agent_status).not.toBe("blocked");
    expect(sent()).toBe(1);
  });

  it.each(exits)("alerts again for the same card asked anew once the agent exits at it and is started again: $exit", async ({ agent, card, reported, answered: byCard, left }) => {
    serving(true);
    const h = await started(pane(agent, reported ?? "unknown"), reported);
    const sent = pushHears(h);
    const shown = screen(card);
    await h.status.cardTick();
    if (byCard) answered(h);
    if (!left) shown.show(null);
    h.herdrSays(pane(null, "unknown"));
    handlers.onStatus("t1", "unknown", null);
    await h.snapshot();
    for (let tick = 0; tick < 3; tick++) await h.status.cardTick();
    expect(sent()).toBe(1);
    // the same agent started again in that terminal shows the same card: a new asking
    h.herdrSays(pane(agent, reported ?? "unknown"));
    handlers.onStatus("t1", (reported ?? "unknown") as never, agent);
    await h.snapshot();
    shown.show(card);
    await h.status.cardTick();
    expect(h.last().status).toBe("blocked");
    expect(sent()).toBe(2);
  });
});
