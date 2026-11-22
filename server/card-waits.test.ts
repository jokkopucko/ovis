import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CardWaits, type CardRead, type Roster } from "./card-waits.ts";
import { codexQueuedPrompt } from "./codex-queue.ts";
import { finishPrompt, publicPrompt } from "./dialogs/shared.ts";
import * as service from "./opencode-service.ts";
import { OpenCodePromptState, parseInteractivePrompt, waitingCard, waitingKindOf } from "./prompt.ts";
import type { HerdrPane, SessionSnapshot } from "../shared/protocol.ts";

// screens drawn by the real programs on a herdr-core test core (todo 67): Claude Code 2.1.321, Codex 0.167.0
const fixture = (name: string) => readFileSync(join(import.meta.dir, "fixtures", "herdr-core-cards", name), "utf8");

const pane = (agent: string | null, agent_status: HerdrPane["agent_status"] = "working", extra: Partial<HerdrPane> = {}) =>
  ({ pane_id: "t1", workspace_id: "w1", tab_id: "w1:t1", agent, agent_status, ...extra }) as HerdrPane;

afterEach(() => mock.restore());

/** CardWaits over reads the test hands out one at a time, and every change it told. */
function waits(reads: CardRead[]) {
  const told: [string, boolean][] = [];
  const read: string[] = [];
  const cards = new CardWaits(async (seen) => { read.push(seen.pane_id); return reads.shift(); }, (paneId, waiting) => { told.push([paneId, waiting]); });
  return { cards, told, read };
}
/** every pane with an agent is read */
const all = () => true;
/** the panes as they are each time they are asked for, each in the lifetime `lifetime` tells */
const listed = (panes: () => HerdrPane[], lifetime: (paneId: string) => number = () => 0): Roster =>
  ({ all: panes, pane: (paneId) => panes().find((pane) => pane.pane_id === paneId), lifetime });
const card = (kind: "permission" | "question" | null, id = "c1") => ({ kind, id });

describe("which cards are an agent waiting for its user", () => {
  it("reads Claude Code's folder trust as waiting, with no kind of its own", () => {
    const card = parseInteractivePrompt("claude", fixture("claude-folder-trust-2.1.321.txt"));
    expect(card).toMatchObject({ kind: "menu", title: "Accessing workspace" });
    expect(waitingKindOf(card!)).toBeNull();
  });

  it("reads Codex's collapsed question as waiting on a question", () => {
    const card = codexQueuedPrompt(fixture("codex-question-queued-0.167.0.txt"), [{ key: "k1", title: "Which color?", options: ["red", "blue"] }]);
    expect(card).toMatchObject({ kind: "question", question: "Which color?", queued: "collapsed" });
    expect(waitingKindOf(card!)).toBe("question");
  });

  it("reads Codex's update menu at its start as waiting, with no kind of its own", () => {
    const card = parseInteractivePrompt("codex", fixture("codex-update-menu-0.167.0.txt"));
    expect(card).toMatchObject({ kind: "menu", title: "Codex" });
    expect(waitingKindOf(card!)).toBeNull();
  });

  it("does not read a picker the user opened, nor a fallback card, as waiting", () => {
    const picker = publicPrompt(finishPrompt("codex", { kind: "menu", title: "Select Model and Effort", question: "Pick a model", body: null, options: [{ label: "a", description: null }, { label: "b", description: null }], multi_select: false, custom_option_index: null },
      { responder: "codex-model", menuLabels: ["a", "b"], selectedIndex: 0, checkedOptionIndices: [], customMenuIndex: null, rejectWithEscapeIndex: null }));
    expect(waitingKindOf(picker)).toBeUndefined();
    const fallback = publicPrompt(finishPrompt("amp", { kind: "menu", title: "", question: "Continue?", body: null, options: [{ label: "Yes", description: null }, { label: "No", description: null }], multi_select: false, custom_option_index: null },
      { responder: "fallback-menu", menuLabels: ["Yes", "No"], selectedIndex: 0, checkedOptionIndices: [], customMenuIndex: null, rejectWithEscapeIndex: null }));
    expect(waitingKindOf(fallback)).toBeUndefined();
  });

  it("takes OpenCode's question for no read once the lookup of its form stops answering", async () => {
    const asking = { pane_id: "t1", workspace_id: "w1", tab_id: "w1:t1", agent: "opencode", agent_status: "working",
      agent_session: { agent: "opencode", kind: "id", source: "herdr:opencode", value: "ses_fixture" } } as HerdrPane;
    spyOn(service, "openCodeService").mockResolvedValue({ config: { baseUrl: "http://127.0.0.1:1234", port: 1234, pid: 123, password: "fixture" }, version: "2.0.32" });
    const forms = spyOn(service, "listPendingQuestionForms").mockResolvedValue([{
      id: "form_fixture", sessionID: "ses_fixture", title: "Fixture question", metadata: { kind: "question" },
      fields: [{ key: "choice", type: "select", required: true, options: [{ value: "yes", label: "Fixture option" }] }],
    }]);
    const state = { openCodeState: new OpenCodePromptState(), ompLookups: new Map() };
    expect(await waitingCard(asking, [asking], state)).toMatchObject({ kind: "question" });
    // OpenCode's service is gone: the form listed last is kept for its card, and says nothing of what is asked now
    forms.mockResolvedValue(null);
    expect(await waitingCard(asking, [asking], state)).toBeUndefined();
  });
});

describe("a wait on a card", () => {
  it("begins once, and the same card redrawn five times is the same wait", async () => {
    const { cards, told } = waits([card("question"), card("question"), card("question"), card("question"), card("question"), card("question")]);
    for (let read = 0; read < 6; read++) await cards.tick(listed(() => [pane("codex")]), all);
    expect(told).toEqual([["t1", true]]);
    expect(cards.kindOf("t1")).toBe("question");
  });

  it("survives one read caught mid-repaint and ends at the second read without a card", async () => {
    const { cards, told } = waits([card("permission"), null, card("permission"), null, null]);
    for (let read = 0; read < 3; read++) await cards.tick(listed(() => [pane("claude")]), all);
    expect(told).toEqual([["t1", true]]);
    await cards.tick(listed(() => [pane("claude")]), all);
    expect(cards.waiting("t1")).toBe(true);
    await cards.tick(listed(() => [pane("claude")]), all);
    expect(told).toEqual([["t1", true], ["t1", false]]);
  });

  it("ends at the first read without a card after an answer from a card", async () => {
    const { cards, told } = waits([card("question"), card("question"), null]);
    await cards.tick(listed(() => [pane("codex")]), all);
    cards.answer("t1", cards.generation("t1")!);
    // the answered card can still be drawn for a moment
    await cards.tick(listed(() => [pane("codex")]), all);
    expect(cards.waiting("t1")).toBe(true);
    await cards.tick(listed(() => [pane("codex")]), all);
    expect(told).toEqual([["t1", true], ["t1", false]]);
  });

  it("keeps a wait through reads that say nothing, and ends it after ten in a row rather than stay stuck", async () => {
    const { cards, told } = waits([card("question"), ...Array<CardRead>(9).fill(undefined), card("question"), ...Array<CardRead>(10).fill(undefined)]);
    for (let read = 0; read < 11; read++) await cards.tick(listed(() => [pane("codex")]), all);
    expect(told).toEqual([["t1", true]]);
    for (let read = 0; read < 10; read++) await cards.tick(listed(() => [pane("codex")]), all);
    expect(told).toEqual([["t1", true], ["t1", false]]);
  });

  it("is another wait for another card in its place: told anew, and an answer to the first does not end it", async () => {
    const { cards, told } = waits([card("question", "asked"), card("permission", "next"), null, null]);
    await cards.tick(listed(() => [pane("codex")]), all);
    cards.answer("t1", cards.generation("t1")!);
    // the answer brought Codex's next asking before any read found the screen without a card
    await cards.tick(listed(() => [pane("codex")]), all);
    expect(told).toEqual([["t1", true], ["t1", false], ["t1", true]]);
    expect(cards.kindOf("t1")).toBe("permission");
    await cards.tick(listed(() => [pane("codex")]), all);
    expect(cards.waiting("t1")).toBe(true);
    await cards.tick(listed(() => [pane("codex")]), all);
    expect(cards.waiting("t1")).toBe(false);
  });

  const session = (agent: string, value: string) => ({ agent_session: { agent, kind: "id", source: "test", value } });
  it.each([
    ["another agent", [pane("codex"), pane("claude")], false],
    ["another session of the agent", [pane("codex", "working", session("codex", "one")), pane("codex", "working", session("codex", "two"))], false],
    ["the same agent, its session now known", [pane("codex"), pane("codex", "working", session("codex", "one"))], true],
    ["the same agent, its session known later and then another", [pane("codex"), pane("codex", "working", session("codex", "one")), pane("codex", "working", session("codex", "two"))], false],
    ["the same agent, the session left over from the one before it", [pane("codex"), pane("codex", "working", session("claude", "one"))], true],
  ] as const)("keeps a wait only for the agent it began with: %s", async (_who, told, kept) => {
    const seen: [string, boolean][] = [];
    // the card shows throughout: only whose pane it is changes
    const cards = new CardWaits(async () => card("question"), (paneId, waiting) => { if (!waiting || seen.length === 0) seen.push([paneId, waiting]); });
    for (const shown of told) await cards.tick(listed(() => [shown]), all);
    expect(seen).toEqual(kept ? [["t1", true]] : [["t1", true], ["t1", false]]);
  });

  it("drops a read under way once the pane is listed with another agent, whatever is counted of it", async () => {
    const held = Promise.withResolvers<CardRead>();
    const seen: [string, boolean][] = [];
    const cards = new CardWaits(() => held.promise, (paneId, waiting) => { seen.push([paneId, waiting]); });
    let runs = pane("codex");
    const tick = cards.tick(listed(() => [runs]), all);
    runs = pane("claude");
    held.resolve(card("question"));
    await tick;
    expect(seen).toEqual([]);
  });

  it("ends a wait, and drops a read under way, once the pane changed hands, also back to the agent it began with", async () => {
    const held = Promise.withResolvers<CardRead>();
    const seen: [string, boolean][] = [];
    let lifetime = 0;
    let reads = 0;
    const cards = new CardWaits(() => ++reads === 2 ? held.promise : Promise.resolve(card("question")), (paneId, waiting) => { seen.push([paneId, waiting]); });
    const roster = listed(() => [pane("codex")], () => lifetime);
    await cards.tick(roster, all);
    // Codex left for another agent and was started again: the pane names Codex as before, in another lifetime
    lifetime = 2;
    const tick = cards.tick(roster, all);
    lifetime = 4;
    held.resolve(card("question"));
    await tick;
    expect(seen).toEqual([["t1", true], ["t1", false]]);
  });

  it("never reads a terminal no agent runs in, nor one another tracker tells", async () => {
    const { cards, told, read } = waits([card("question"), card("question")]);
    await cards.tick(listed(() => [pane(null, "unknown")]), all);
    await cards.tick(listed(() => [pane("omo")]), all, () => true);
    expect(read).toEqual([]);
    expect(told).toEqual([]);
  });

  it("ends a wait begun before a tracker of its own took the pane, without reading it again", async () => {
    const { cards, told, read } = waits([card("question"), card("question")]);
    await cards.tick(listed(() => [pane("claude")]), all);
    // OmO is found in the pane: its own status stands from now on
    await cards.tick(listed(() => [pane("claude")]), all, () => true);
    expect(told).toEqual([["t1", true], ["t1", false]]);
    expect(read).toEqual(["t1"]);
  });

  it("starts no wait from a read under way when a tracker of its own took the pane", async () => {
    const held = Promise.withResolvers<CardRead>();
    const told: [string, boolean][] = [];
    const cards = new CardWaits(() => held.promise, (paneId, waiting) => { told.push([paneId, waiting]); });
    let owned = false;
    const tick = cards.tick(listed(() => [pane("claude")]), all, () => owned);
    owned = true;
    held.resolve(card("question"));
    await tick;
    expect(told).toEqual([]);
    expect(cards.waiting("t1")).toBe(false);
  });

  it("forgets a pane no longer listed, telling nobody", async () => {
    const { cards, told } = waits([card("question")]);
    await cards.tick(listed(() => [pane("codex")]), all);
    await cards.tick(listed(() => []), all);
    expect(cards.waiting("t1")).toBe(false);
    expect(told).toEqual([["t1", true]]);
  });

  it("shows a waiting pane blocked with the card's kind, and leaves the agent's own blocked and its words alone", async () => {
    const { cards } = waits([card("question")]);
    await cards.tick(listed(() => [pane("codex")]), all);
    expect(cards.status("t1", "working")).toBe("blocked");
    const snapshot = (panes: HerdrPane[]) => ({ panes, agents: panes.map(({ pane_id, agent, agent_status }) => ({ pane_id, agent, agent_status })) }) as unknown as SessionSnapshot;
    expect(cards.apply(snapshot([pane("codex", "working")])).panes[0]).toMatchObject({ agent_status: "blocked", agent_kind: "question" });
    expect(cards.apply(snapshot([pane("codex", "working")])).agents[0]).toMatchObject({ agent_status: "blocked" });
    const own = pane("codex", "blocked", { agent_kind: "permission", agent_message: "approve rm" });
    expect(cards.apply(snapshot([own])).panes[0]).toEqual(own);
  });

  it("ends a wait at once when the pane's agent is gone, without reading it", async () => {
    const { cards, told, read } = waits([card("question"), card("question")]);
    await cards.tick(listed(() => [pane("codex")]), all);
    // Ctrl-C at its question, or its folder trust answered "No, exit": a shell is back, no agent runs there
    await cards.tick(listed(() => [pane(null, "unknown")]), all);
    expect(told).toEqual([["t1", true], ["t1", false]]);
    expect(read).toEqual(["t1"]);
    expect(cards.status("t1", "unknown")).toBe("unknown");
  });

  it("reads no pane forgotten while it waits its turn behind the panes read before it", async () => {
    const first = Promise.withResolvers<void>();
    const read: string[] = [];
    const told: string[] = [];
    const cards = new CardWaits(async (seen) => { read.push(seen.pane_id); if (read.length <= 4) await first.promise; return card("question"); }, (paneId) => { told.push(paneId); });
    const five = ["t1", "t2", "t3", "t4", "t5"].map((pane_id) => pane("codex", "working", { pane_id }));
    const tick = cards.tick(listed(() => five), all);
    // the fifth pane's agent exits while the first four are read
    cards.forget("t5");
    first.resolve();
    await tick;
    expect(read).toEqual(["t1", "t2", "t3", "t4"]);
    expect(cards.waiting("t5")).toBe(false);
    expect(told).toEqual(["t1", "t2", "t3", "t4"]);
  });

  it("reads only the panes the rule picks, and every pane that waits", async () => {
    const { cards, read } = waits([card("question"), null, null]);
    const atRest = (seen: HerdrPane) => seen.agent_status === "working" || seen.agent_status === "unknown";
    await cards.tick(listed(() => [pane("codex", "idle")]), atRest);
    expect(read).toEqual([]);
    await cards.tick(listed(() => [pane("codex", "working")]), atRest);
    // a pane that waits is read whatever its agent says now, so that its wait can end
    await cards.tick(listed(() => [pane("codex", "idle")]), atRest);
    expect(read).toEqual(["t1", "t1"]);
  });
});
