import { expect, it, spyOn } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Terminal } from "@xterm/xterm";
import { readFileSync } from "node:fs";
import { claudeMainAtRest } from "./compose.ts";
import { inputRowState, readScreen, readScreenLines } from "./inputRow.ts";
import { matchHerdrWidths } from "./terminalWidths.ts";
import { paneStorageId } from "../../shared/machines.ts";
import { PendingMessageStore, pendingMessages } from "./pendingMessages.ts";
import { paneLifetimes } from "./paneLifetime.ts";
import { composerDrafts } from "./composerDraft.ts";
import { useComposerSends, type ComposerSendsDeps } from "./useComposerSends.ts";
import type { HerdrSocket, SubmitDelivery, SubmitResult } from "./ws.ts";
import { currentWaitingSends, forgetWaitingSends, settleWaitingSends, waitingKey } from "./sentWaiting.ts";
import type { InteractivePrompt } from "../../shared/protocol.ts";

function savedStorage() {
  const data = new Map<string, string>(), storage = paneLifetimes.paneStorage;
  const spies = [
    spyOn(storage, "getItem").mockImplementation((key) => data.get(key) ?? null),
    spyOn(storage, "setItem").mockImplementation((key, value) => { data.set(key, value); }),
    spyOn(storage, "removeItem").mockImplementation((key) => { data.delete(key); }),
  ];
  return { storage, restore: () => { for (const spy of spies) spy.mockRestore(); } };
}

function sends(pane: string, answer: SubmitResult, shown: string[], extra: Partial<ComposerSendsDeps> = {}) {
  let actions!: ReturnType<typeof useComposerSends>;
  function Composer() {
    const deps: Partial<ComposerSendsDeps> = {
      agent: "claude", paneId: pane, paneRef: { current: pane }, machineId: "local", queueOwner: paneStorageId("local", pane),
      socketRef: { current: { connected: true } as HerdrSocket }, sessionRef: { current: null }, pendingScopeRef: { current: "scope" },
      heldRef: { current: false }, secretRef: { current: null }, observeRef: { current: false }, draftHeldForRef: { current: null },
      stillOpenRef: { current: null }, stillOpenNotedRef: { current: false }, chatNavigation: { current: 0 }, setChatLocalSend: () => {},
      ended: false, heldByOpenQueue: false, answering: null, answerPending: false, pendingAnswer: null, settings: { autoSendQueued: false },
      knownOutcomes: () => [], inputRowNow: () => "ready", showSentCommand: (_pane, text) => { shown.push(text); },
      submitComposerMessage: () => Promise.resolve(answer),
      ...extra,
    };
    actions = useComposerSends(deps as ComposerSendsDeps);
    return null;
  }
  renderToStaticMarkup(createElement(Composer));
  return actions;
}

it("an offline uncertain display dismissal sends no pending action, submit or draft restore", async () => {
  const connected = false;
  const saved = savedStorage();
  const pane = `dismiss-${connected}`, owner = paneStorageId("local", pane);
  const wire: unknown[] = [], shown: string[] = [];
  const socket = { connected, pendingAction: (...args: unknown[]) => { wire.push(args); throw new Error("an offline dismissal must never call the backend"); } } as unknown as HerdrSocket;
  const key = `ovis:composer-draft:${owner}`;
  composerDrafts.set(key, "keep my existing draft");
  const pending = { id: `display-${connected}`, request_id: 7, text: "/thinking high", state: "uncertain" as const, created_at: "2026-11-17T00:00:00Z" };
  pendingMessages.accept(owner, pending, "scope");
  expect(pendingMessages.read(owner)[0]!.serverOwned).toBe(true);
  try {
    const actions = sends(pane, { ok: true }, shown, { agent: "pi", socketRef: { current: socket }, submitComposerMessage: (...args) => { wire.push(args); return Promise.resolve({ ok: true }); } });
    await actions.actOnPending(pending.id, "dismiss");
    await actions.actOnPending(pending.id, "steer");
    expect(wire).toEqual([]); expect(shown).toEqual([]);
    expect(composerDrafts.read(key).text).toBe("keep my existing draft");
    expect(pendingMessages.read(owner)).toEqual([]);
    expect(new PendingMessageStore(() => saved.storage).read(owner)).toEqual([]);
    // a connection that lists the ID again holds the bridge's record: only the bridge can settle it
    pendingMessages.publish(owner, [pending], [], "next-scope");
    expect(pendingMessages.read(owner)).toMatchObject([{ id: pending.id, serverOwned: true }]);
  } finally { composerDrafts.set(key, ""); saved.restore(); }
});

it("a live owner's uncertain dismissal asks the bridge to dismiss it, never as a withdrawal, a submit or a draft restore", async () => {
  const saved = savedStorage(), pane = "dismiss-live", owner = paneStorageId("local", pane), key = `ovis:composer-draft:${owner}`;
  const wire: unknown[] = [], shown: string[] = [];
  const pending = { id: "live-uncertain", request_id: 9, text: "/thinking high", state: "uncertain" as const, created_at: "2026-11-17T00:00:00Z" };
  composerDrafts.set(key, "keep my existing draft");
  pendingMessages.accept(owner, pending, "scope");
  // The bridge's discard of an uncertain record is its "dismissed" outcome, which also frees the pane's queue.
  const socket = { connected: true, on: () => () => {}, pendingAction: (...args: unknown[]) => {
    wire.push(args);
    pendingMessages.publish(owner, [], [{ id: pending.id, outcome: "dismissed" }], "scope");
    return Promise.resolve({ ok: true });
  } } as unknown as HerdrSocket;
  try {
    const actions = sends(pane, { ok: true }, shown, { socketRef: { current: socket }, submitComposerMessage: (...args) => { wire.push(args); return Promise.resolve({ ok: true }); } });
    await actions.actOnPending(pending.id, "dismiss");
    expect(wire).toEqual([[pane, pending.id, "discard", 0, false]]); expect(shown).toEqual([]);
    expect(composerDrafts.read(key).text).toBe("keep my existing draft");
    expect(pendingMessages.read(owner)).toEqual([]);
  } finally { composerDrafts.set(key, ""); saved.restore(); }
});

it.each(["pending_uncertain", "pending_not_found"])("a live owner's dismissal the bridge refuses with %s hides the copy until the bridge lists that record again", async (code) => {
  const saved = savedStorage(), pane = `dismiss-refused-${code}`, owner = paneStorageId("local", pane), wire: unknown[] = [];
  const pending = { id: `refused-${code}`, request_id: 10, text: "question", state: "uncertain" as const, created_at: "2026-11-17T00:00:00Z" };
  pendingMessages.accept(owner, pending, "scope");
  const socket = { connected: true, on: () => () => {}, pendingAction: (...args: unknown[]) => { wire.push(args); return Promise.resolve({ ok: false, code, message: "refused" }); } } as unknown as HerdrSocket;
  try {
    await sends(pane, { ok: true }, [], { socketRef: { current: socket } }).actOnPending(pending.id, "dismiss");
    expect(wire).toEqual([[pane, pending.id, "discard", 0, false]]);
    expect(pendingMessages.read(owner)).toEqual([]);
    expect(new PendingMessageStore(() => saved.storage).read(owner)).toEqual([]);
    pendingMessages.publish(owner, [pending], [], "scope");
    expect(pendingMessages.read(owner)).toMatchObject([{ id: pending.id, serverOwned: true }]);
  } finally { saved.restore(); }
});

it.each(["disconnected", "not_transmitted"])("a live owner's dismissal whose connection ends before the bridge answers (%s) hides only this page's copy", async (code) => {
  const saved = savedStorage(), pane = `dismiss-dropped-${code}`, owner = paneStorageId("local", pane), wire: unknown[] = [];
  const pending = { id: `dropped-${code}`, request_id: 11, text: "question", state: "uncertain" as const, created_at: "2026-11-17T00:00:00Z" };
  pendingMessages.accept(owner, pending, "scope");
  const socket = { connected: true, on: () => () => {}, pendingAction: (...args: unknown[]) => {
    wire.push(args);
    pendingMessages.suspend(owner, "scope");
    return Promise.resolve({ ok: false, code, message: "the connection dropped" });
  } } as unknown as HerdrSocket;
  try {
    await sends(pane, { ok: true }, [], { socketRef: { current: socket } }).actOnPending(pending.id, "dismiss");
    expect(wire).toEqual([[pane, pending.id, "discard", 0, false]]);
    expect(pendingMessages.read(owner)).toEqual([]);
    expect(new PendingMessageStore(() => saved.storage).read(owner)).toEqual([]);
  } finally { saved.restore(); }
});

it("a dismissal whose pane moved while it waited, and whose connection then ended, hides the copy under the pane's new ID", async () => {
  const saved = savedStorage(), pane = "dismiss-moved", owner = paneStorageId("local", pane), moved = paneStorageId("local", "dismiss-moved-to"), wire: unknown[] = [];
  const pending = { id: "moved-uncertain", request_id: 13, text: "question", state: "uncertain" as const, created_at: "2026-11-17T00:00:00Z" };
  pendingMessages.accept(owner, pending, "scope");
  const socket = { connected: true, on: () => () => {}, pendingAction: (...args: unknown[]) => {
    wire.push(args);
    pendingMessages.move(owner, moved);
    pendingMessages.suspend(owner, "scope");
    return Promise.resolve({ ok: false, code: "disconnected", message: "the connection dropped" });
  } } as unknown as HerdrSocket;
  try {
    await sends(pane, { ok: true }, [], { socketRef: { current: socket } }).actOnPending(pending.id, "dismiss");
    expect(wire).toEqual([[pane, pending.id, "discard", 0, false]]);
    expect(pendingMessages.read(owner)).toEqual([]);
    expect(pendingMessages.read(moved)).toEqual([]);
    expect(new PendingMessageStore(() => saved.storage).read(moved)).toEqual([]);
  } finally { saved.restore(); }
});

it("another tab's dismissal of its uncertain copy leaves this tab's live row with Edit, Send now and Discard, and its updates", async () => {
  const saved = savedStorage(), pane = "dismiss-other-tab", owner = paneStorageId("local", pane), wire: unknown[] = [];
  const live = { id: "live-queued", request_id: 12, text: "run the tests", state: "queued" as const, created_at: "2026-11-17T00:00:00Z" };
  pendingMessages.publish(owner, [live], [], "scope");
  const otherTab = new PendingMessageStore(() => paneLifetimes.paneStorage);
  expect(otherTab.read(owner).map((row) => row.state)).toEqual(["uncertain"]);
  expect(otherTab.dismissCopy(owner, live.id)).toBe(true);
  expect(otherTab.read(owner)).toEqual([]);
  pendingMessages.refresh(owner);
  const socket = { connected: true, on: () => () => {}, pendingAction: (...args: unknown[]) => { wire.push(args); return Promise.resolve({ ok: true }); } } as unknown as HerdrSocket;
  try {
    expect(pendingMessages.read(owner)).toMatchObject([{ id: live.id, state: "queued", serverOwned: true }]);
    const actions = sends(pane, { ok: true }, [], { socketRef: { current: socket } });
    for (const action of ["edit", "steer", "discard"] as const) await actions.actOnPending(live.id, action);
    expect(wire).toEqual([[pane, live.id, "discard", 0, true], [pane, live.id, "steer", 0, false, expect.any(Function)], [pane, live.id, "discard", 0, false]]);
    pendingMessages.publish(owner, [{ ...live, state: "held", error: { code: "agent_blocked", message: "waits for Send now" } }], [], "scope");
    expect(pendingMessages.read(owner)).toMatchObject([{ id: live.id, state: "held", serverOwned: true }]);
    otherTab.refresh(owner);
    expect(otherTab.read(owner)).toEqual([]);
  } finally { pendingMessages.publish(owner, [], [{ id: live.id, outcome: "discarded" }], "scope"); saved.restore(); }
});

it("display-only intent never turns into a queue discard after an uncertain row changes", async () => {
  const saved = savedStorage(), pane = "dismiss-race", owner = paneStorageId("local", pane), wire: unknown[] = [];
  const pending = { id: "changed-row", request_id: 8, text: "question", state: "uncertain" as const, created_at: "2026-11-17T00:00:00Z" };
  pendingMessages.accept(owner, pending, "scope");
  // The user's click came from an uncertain display; a publish arrived before its handler.
  pendingMessages.accept(owner, { ...pending, state: "queued" }, "scope");
  const socket = { connected: true, pendingAction: (...args: unknown[]) => { wire.push(args); return Promise.resolve({ ok: true }); } } as unknown as HerdrSocket;
  try {
    await sends(pane, { ok: true }, [], { socketRef: { current: socket } }).actOnPending(pending.id, "dismiss");
    expect(wire).toEqual([]);
    expect(pendingMessages.read(owner)).toMatchObject([{ id: pending.id, state: "queued" }]);
  } finally { pendingMessages.publish(owner, [], [{ id: pending.id, outcome: "discarded" }], "scope"); saved.restore(); }
});

const waiting = "Waiting for 2 background agents to finish";
const idleBox = ["─".repeat(40), "❯", "─".repeat(40)];
const closedClaude = readFileSync(new URL("../../server/fixtures/claude-rewind-2.1.304-closed-40.txt", import.meta.url), "utf8");

it("refuses composer choices and confirmation while the answered card waits for its next read", async () => {
  const prompt: InteractivePrompt = {
    id: "answered", agent: "claude", kind: "question", title: "Question", question: "Which store?",
    body: null, options: [{ label: "Redis", description: null }], multi_select: false, custom_option_index: null,
  };
  const answers: unknown[] = [], picks: unknown[] = [], messages: string[] = [];
  const actions = sends("answered-pane", { ok: true }, [], {
    answering: prompt, answerPending: true,
    pendingAnswer: { pane: "answered-pane", promptId: prompt.id, answer: { option_index: 0 } },
    answerPanePrompt: async (answer) => { answers.push(answer); },
    setPendingAnswer: (pick) => { picks.push(pick); },
    submitComposerMessage: (text) => { messages.push(text); return Promise.resolve({ ok: true }); },
    t: (key) => key,
  });
  expect(await actions.composerSend("1")).not.toBe(true);
  expect(actions.waitingAnswer).toBeNull();
  expect(answers).toEqual([]);
  expect(picks).toEqual([]);
  expect(messages).toEqual([]);
});

for (const autoSendQueued of [false, true]) {
  it.each([
    ["wrapped running turn", [
      "✻ Investigating the authentication flow further… (3m 35s · ↓ 4.8k tokens) · esc to interrupt",
      waiting, ...idleBox,
    ], false],
    ["spinner above thirteen agents", [
      "✻ Investigating… (3m 35s · ↓ 4.8k tokens)",
      ...Array.from({ length: 13 }, (_, index) => `◯ background-agent-${index}`),
      waiting, ...idleBox,
    ], false],
    ["short duration", ["✻ Investigating… (3s)", waiting, ...idleBox], false],
    ["duration without ellipsis", ["✻ Investigating (3s)", waiting, ...idleBox], false],
    ["compaction", ["✻ Compacting conversation… (3s)", waiting, ...idleBox], false],
    ["idle footer", [waiting, ...closedClaude.trimEnd().split("\n")], true],
    ["plain idle", [waiting, ...idleBox], true],
    ["idle without waiting evidence", [...idleBox], false],
    ["permission dialog", [waiting, "Do you want to proceed?", "❯ 1. Yes", "  2. No", "esc to cancel"], false],
  ] as const)(`Claude %s chooses safe delivery with autoSendQueued=${autoSendQueued}`, async (_name, rows, immediate) => {
    const term = new Terminal({ cols: 40, rows: 60, scrollback: 0, allowProposedApi: true });
    matchHerdrWidths(term);
    try {
      await new Promise<void>((resolve) => term.write(rows.join("\r\n"), resolve));
      const shown: string[] = [], deliveries: SubmitDelivery[] = [];
      const actions = sends("claude-at-rest", { ok: true }, shown, {
        agentStatus: "working",
        settings: { autoSendQueued },
        inputAtRest: () => {
          const screen = readScreen(term.buffer.active, term.cols, term.rows);
          return claudeMainAtRest(inputRowState("claude", screen), readScreenLines(term.buffer.active, term.rows) ?? []);
        },
        submitComposerMessage: (_text, delivery) => {
          deliveries.push(delivery);
          return Promise.resolve({ ok: true });
        },
      });
      expect(await actions.composerSend("follow up")).toBe(true);
      expect(deliveries).toEqual([immediate ? "immediate" : autoSendQueued ? "queue" : "hold"]);
    } finally {
      term.dispose();
    }
  });
}

it.each([
  ["unconfirmed", { ok: true, unconfirmed: true } as const],
  ["confirmed", { ok: true } as const],
])("a composer send the bridge answered %s keeps its text only while nothing confirmed it", async (kind, answer) => {
  const saved = savedStorage();
  const pane = `legacy-send-${kind}`, owner = paneStorageId("local", pane), shown: string[] = [];
  try {
    const result = await sends(pane, answer, shown).composerSend("deploy the fix");
    expect(result).toBe(true);
    if (kind === "unconfirmed") {
      expect(pendingMessages.read(owner)).toMatchObject([{ text: "deploy the fix", state: "uncertain", serverOwned: false, error: { code: "submit_unconfirmed" } }]);
      expect(new PendingMessageStore(() => saved.storage).read(owner)).toMatchObject([{ text: "deploy the fix", state: "uncertain" }]);
      expect(shown).toEqual([]);
    } else {
      expect(pendingMessages.read(owner)).toEqual([]);
      expect(shown).toEqual(["deploy the fix"]);
    }
  } finally {
    for (const message of pendingMessages.read(owner)) pendingMessages.removeCopy(owner, message.id);
    saved.restore();
  }
});

it.each([
  ["unconfirmed", { ok: true, unconfirmed: true } as const],
  ["confirmed", { ok: true, typedNow: true } as const],
  ["replayed", { ok: true } as const],
])("Send now of a held copy the bridge answered %s removes its recovery row only on a receipt", async (kind, answer) => {
  const saved = savedStorage();
  const pane = `legacy-held-${kind}`, owner = paneStorageId("local", pane), key = waitingKey("local", pane), shown: string[] = [];
  const message = { id: `held-${kind}`, request_id: 1, text: "held follow-up", state: "held" as const, created_at: "2026-10-28T00:00:00Z" };
  try {
    new PendingMessageStore(() => saved.storage).accept(owner, message, "earlier");
    // the bridge's held receipt proves it untyped for this page: only then is a saved held copy sent again
    pendingMessages.publish(owner, [], [{ id: message.id, outcome: "held", resumed: true, until: Date.now() + 60_000 }], "receipt");
    expect(pendingMessages.read(owner)).toMatchObject([{ id: message.id, state: "held", serverOwned: false }]);
    await sends(pane, answer, shown, { pendingScopeRef: { current: "now" } }).actOnPending(message.id, "steer");
    if (kind === "unconfirmed") {
      expect(pendingMessages.read(owner)).toMatchObject([{ id: message.id, text: "held follow-up", state: "uncertain", error: { code: "submit_unconfirmed" } }]);
      expect(new PendingMessageStore(() => saved.storage).read(owner)).toMatchObject([{ id: message.id, state: "uncertain" }]);
      expect(shown).toEqual([]);
      expect(currentWaitingSends(key)).toEqual([]);
    } else {
      expect(pendingMessages.read(owner)).toEqual([]);
      expect(shown).toEqual(["held follow-up"]);
      if (kind === "confirmed") expect(currentWaitingSends(key)).toMatchObject([{ text: "held follow-up" }]);
      else expect(currentWaitingSends(key)).toEqual([]);
    }
  } finally {
    forgetWaitingSends(key);
    pendingMessages.removeCopy(owner, message.id);
    saved.restore();
  }
});

it.each(["refusal", "rejection"] as const)("a connection %s leaves no waiting line", async (kind) => {
  const pane = `closed-${kind}`, key = waitingKey("local", pane);
  const error = new Error("herdr closed the connection before answering agent.prompt");
  const actions = sends(pane, { ok: false, code: "closed", message: error.message }, [], {
    setPromptRefresh: () => {},
    submitComposerMessage: () => kind === "rejection" ? Promise.reject(error) : Promise.resolve({ ok: false, code: "closed", message: error.message }),
  });
  try {
    if (kind === "rejection") await expect(actions.composerSend("not typed yet")).rejects.toBe(error);
    else expect(await actions.composerSend("not typed yet")).not.toBe(true);
    expect(currentWaitingSends(key)).toEqual([]);
  } finally { forgetWaitingSends(key); }
});

it("records a confirmed send for its original pane after navigation without following the new pane", async () => {
  const pane = "receipt-original", key = waitingKey("local", pane), paneRef = { current: pane };
  let follow = 0;
  const { promise: receipt, resolve: release } = Promise.withResolvers<SubmitResult>();
  const actions = sends(pane, { ok: true }, [], { paneRef, setChatLocalSend: () => { follow++; }, submitComposerMessage: () => receipt });
  const result = actions.composerSend("from original pane");
  paneRef.current = "another-pane";
  release({ ok: true });
  try {
    expect(await result).toBe(true);
    expect(currentWaitingSends(key)).toMatchObject([{ text: "from original pane" }]);
    expect(follow).toBe(0);
  } finally { forgetWaitingSends(key); }
});

it("a queued follow-up the bridge typed at once waits in the chat and follows it, as a send at once", async () => {
  const pane = "queued-typed-at-once", key = waitingKey("local", pane), shown: string[] = [];
  let follows = 0;
  const actions = sends(pane, { ok: true, typedNow: true }, shown, {
    agentStatus: "working", inputAtRest: () => false, settings: { autoSendQueued: true },
    setChatLocalSend: () => { follows++; },
    submitComposerMessage: (_text, delivery) => { expect(delivery).toBe("queue"); return Promise.resolve({ ok: true, typedNow: true }); },
  });
  try {
    expect(await actions.composerSend("then list the tests")).toBe(true);
    expect(currentWaitingSends(key)).toMatchObject([{ text: "then list the tests" }]);
    expect(follows).toBe(1);
    expect(shown).toEqual(["then list the tests"]);
  } finally { forgetWaitingSends(key); }
});

it("a queued follow-up answered ok with no row and no typed-now mark is no waiting message", async () => {
  const pane = "queued-replayed", key = waitingKey("local", pane), shown: string[] = [];
  let follows = 0;
  const actions = sends(pane, { ok: true }, shown, {
    agentStatus: "working", inputAtRest: () => false, settings: { autoSendQueued: true },
    setChatLocalSend: () => { follows++; },
  });
  try {
    expect(await actions.composerSend("discarded follow-up")).toBe(true);
    expect(currentWaitingSends(key)).toEqual([]);
    expect(follows).toBe(0);
    expect(shown).toEqual([]);
  } finally { forgetWaitingSends(key); }
});

it("timestamps a send before the receipt so a turn written during the request settles it", async () => {
  const pane = "receipt-time", key = waitingKey("local", pane);
  const clock = spyOn(Date, "now").mockReturnValue(1000);
  const { promise, resolve } = Promise.withResolvers<SubmitResult>();
  try {
    const result = sends(pane, { ok: true }, [], { submitComposerMessage: () => promise }).composerSend("written before receipt");
    clock.mockReturnValue(3000);
    resolve({ ok: true });
    expect(await result).toBe(true);
    expect(currentWaitingSends(key)[0]?.at).toBe(1000);
    settleWaitingSends(key, [{ role: "user", ts: new Date(2000).toISOString(), parts: [{ kind: "text", text: "written before receipt" }] }]);
    expect(currentWaitingSends(key)).toEqual([]);
  } finally { clock.mockRestore(); forgetWaitingSends(key); }
});

it("Send it sends the named draft over itself, only at once and never as an answer", async () => {
  const calls: Array<[string, SubmitDelivery, string | undefined]> = [], shown: string[] = [];
  const t = (text: string) => text;
  const submitComposerMessage = (text: string, delivery: SubmitDelivery, clearDraft?: string) => {
    calls.push([text, delivery, clearDraft]);
    return Promise.resolve({ ok: true } as const);
  };
  const prompt: InteractivePrompt = {
    id: "menu", agent: "claude", kind: "question", title: "Question", question: "?", body: null,
    options: [{ label: "Yes", description: null }], multi_select: false, custom_option_index: null,
  };
  expect(await sends("send-it", { ok: true }, shown, { t, agentStatus: "idle", submitComposerMessage }).composerSend("fix the tests", "fix the tests")).toBe(true);
  expect(calls).toEqual([["fix the tests", "immediate", "fix the tests"]]);
  const working = await sends("send-it", { ok: true }, shown, { t, agentStatus: "working", inputAtRest: () => false, submitComposerMessage })
    .composerSend("fix the tests", "fix the tests");
  expect(typeof working).toBe("string");
  expect(calls).toHaveLength(1);
  const blocked = await sends("send-it", { ok: true }, shown, { t, answering: prompt, submitComposerMessage })
    .composerSend("1", "1");
  expect(typeof blocked).toBe("string");
  expect(calls).toHaveLength(1);
  expect(await sends("send-it", { ok: true }, shown, { t, agentStatus: "working", inputAtRest: () => false, submitComposerMessage })
    .composerSend("my new message", "fix the tests")).toBe(true);
  expect(calls).toEqual([["fix the tests", "immediate", "fix the tests"], ["my new message", "hold", undefined]]);
});

// Alt+Enter: held in the queued list for its row's Send now, whatever automatic sending says and also at rest;
// the socket refuses it on a PC that cannot hold one, never queuing it to go on its own
it.each([
  ["working, automatic sending on", { agentStatus: "working", inputAtRest: (): boolean => false, settings: { autoSendQueued: true } }, "queue"],
  ["working, automatic sending off", { agentStatus: "working", inputAtRest: (): boolean => false, settings: { autoSendQueued: false } }, "hold"],
  ["idle", { agentStatus: "idle", settings: { autoSendQueued: true } }, "immediate"],
  ["working with Claude's box at rest", { agentStatus: "working", inputAtRest: (): boolean => true, settings: { autoSendQueued: true } }, "immediate"],
] as const)("a hold while %s goes as held, never queued or sent at once", async (_name, extra, plain) => {
  const calls: unknown[][] = [];
  const submitComposerMessage = ((...args: unknown[]) => { calls.push(args); return Promise.resolve({ ok: true } as const); }) as ComposerSendsDeps["submitComposerMessage"];
  const deps: Partial<ComposerSendsDeps> = { ...extra, submitComposerMessage };
  expect(await sends("hold-pane", { ok: true }, [], deps).composerSend("for later", undefined, false, false, false, true)).toBe(true);
  expect(await sends("hold-pane", { ok: true }, [], deps).composerSend("for later")).toBe(true);
  expect(calls.map((call) => [call[1], call[2], call[7]])).toEqual([["hold", undefined, true], [plain, undefined, false]]);
});

it("a hold is never an answer to an open menu, nor stopped by a screen a peek left open, since nothing is typed", async () => {
  const calls: unknown[][] = [], answers: unknown[] = [];
  const prompt: InteractivePrompt = {
    id: "menu", agent: "claude", kind: "question", title: "Question", question: "?", body: null,
    options: [{ label: "Yes", description: null }], multi_select: false, custom_option_index: null,
  };
  const submitComposerMessage = ((...args: unknown[]) => { calls.push(args); return Promise.resolve({ ok: true } as const); }) as ComposerSendsDeps["submitComposerMessage"];
  const open = { pane: "hold-open", agent: "claude", command: "/usage", named: true, history: undefined };
  expect(await sends("hold-open", { ok: true }, [], { answering: prompt, answerPanePrompt: async (answer) => { answers.push(answer); }, submitComposerMessage, t: (text) => text })
    .composerSend("1", undefined, false, false, false, true)).toBe(true);
  expect(await sends("hold-open", { ok: true }, [], { stillOpenRef: { current: open }, stillOpenNote: () => "still open", submitComposerMessage })
    .composerSend("after the peek", undefined, false, false, false, true)).toBe(true);
  expect(answers).toEqual([]);
  expect(calls.map((call) => [call[0], call[1], call[7]])).toEqual([["1", "hold", true], ["after the peek", "hold", true]]);
});

it("a hold a PC too old to hold refuses keeps the draft with the reason", async () => {
  const result = await sends("hold-old", { ok: false, code: "pending_hold_unsupported", message: "Update this PC to hold messages. Nothing was sent." }, [], { agentStatus: "working", settings: { autoSendQueued: true } })
    .composerSend("for later", undefined, false, false, false, true);
  expect(result).toBe("Update this PC to hold messages. Your draft stayed here.");
});

it.each([[true, ["steer"]], [false, []]] as const)("a queued send with now=%p steers its own row", async (now, expected) => {
  const saved = savedStorage();
  const pane = `send-now-${now}`, owner = paneStorageId("local", pane), actions: string[] = [];
  const pending = { id: `row-${now}`, request_id: 1, text: "stop and run the tests", state: "held" as const, created_at: "2026-11-05T00:00:00Z" };
  const socket = {
    connected: true,
    on: () => () => {},
    pendingAction: (paneId: string, id: string, action: string) => {
      if (paneId === pane && id === pending.id) actions.push(action);
      return Promise.resolve({ ok: true });
    },
  } as unknown as HerdrSocket;
  const { promise: steered, resolve: settled } = Promise.withResolvers<void>();
  try {
    const result = await sends(pane, { ok: true }, [], {
      agentStatus: "working", inputAtRest: () => false, socketRef: { current: socket },
      submitComposerMessage: () => { pendingMessages.accept(owner, pending, "scope"); return Promise.resolve({ ok: true, pending }); },
      submitRetention: { retain: () => () => { settled(); } } as unknown as ComposerSendsDeps["submitRetention"],
    }).composerSend(pending.text, undefined, false, false, now);
    expect(result).toBe(true);
    if (now) await steered;
    expect(actions).toEqual([...expected]);
  } finally {
    pendingMessages.removeCopy(owner, pending.id);
    saved.restore();
  }
});

// Alt+Enter's row stays held as its receipt left it: nothing steers it, with automatic sending on; only its Send now does
it("a hold leaves its held row waiting for Send now, then Send now sends it", async () => {
  const saved = savedStorage();
  const pane = "hold-row", owner = paneStorageId("local", pane), actions: string[] = [], deliveries: unknown[] = [];
  const pending = { id: "held-row", request_id: 1, text: "after this turn", state: "held" as const, created_at: "2026-11-09T00:00:00Z" };
  const socket = {
    connected: true,
    on: () => () => {},
    pendingAction: (_paneId: string, id: string, action: string) => { actions.push(`${action}:${id}`); return Promise.resolve({ ok: true }); },
  } as unknown as HerdrSocket;
  try {
    const actionsHook = sends(pane, { ok: true }, [], {
      agentStatus: "working", inputAtRest: () => false, settings: { autoSendQueued: true }, socketRef: { current: socket },
      submitComposerMessage: (_text, delivery) => { deliveries.push(delivery); pendingMessages.accept(owner, pending, "scope"); return Promise.resolve({ ok: true, pending }); },
    });
    expect(await actionsHook.composerSend(pending.text, undefined, false, false, false, true)).toBe(true);
    expect(deliveries).toEqual(["hold"]);
    expect(actions).toEqual([]);
    expect(pendingMessages.read(owner)).toMatchObject([{ id: pending.id, state: "held", serverOwned: true }]);
    await actionsHook.actOnPending(pending.id, "steer");
    expect(actions).toEqual(["steer:held-row"]);
  } finally {
    pendingMessages.removeCopy(owner, pending.id);
    saved.restore();
  }
});

it("sends a held copy of an agent-only message again as agent-only", async () => {
  const saved = savedStorage();
  const pane = "held-agent-only", owner = paneStorageId("local", pane), calls: unknown[][] = [];
  const message = { id: "held-only", request_id: 1, text: "> q\nc", state: "held" as const, created_at: "2026-10-28T00:00:00Z", agent_only: true as const };
  const submitComposerMessage = ((...args: unknown[]) => { calls.push(args); return Promise.resolve({ ok: true } as const); }) as ComposerSendsDeps["submitComposerMessage"];
  try {
    new PendingMessageStore(() => saved.storage).accept(owner, message, "earlier");
    // the bridge's held receipt proves it untyped for this page: only then is a saved held copy sent again
    pendingMessages.publish(owner, [], [{ id: message.id, outcome: "held", resumed: true, until: Date.now() + 60_000 }], "receipt");
    await sends(pane, { ok: true }, [], { pendingScopeRef: { current: "now" }, submitComposerMessage }).actOnPending(message.id, "steer");
    expect(calls.map((call) => call[6])).toEqual([true]);
  } finally {
    pendingMessages.removeCopy(owner, message.id);
    saved.restore();
  }
});

it("puts an edited agent-only message back in the box agent-only", async () => {
  const saved = savedStorage();
  const pane = "edit-agent-only", owner = paneStorageId("local", pane), key = `ovis:composer-draft:${owner}`;
  const listeners = new Set<(frame: unknown) => void>();
  const socket = {
    connected: true,
    on: (listener: (frame: unknown) => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    pendingAction: () => {
      for (const listener of listeners) listener({ type: "pending-messages", pane_id: pane, messages: [], removed: [{ id: "srv-only", outcome: "discarded" }] });
      return Promise.resolve({ ok: true });
    },
  } as unknown as HerdrSocket;
  pendingMessages.accept(owner, { id: "srv-only", request_id: 1, text: "> q\nc", state: "held", created_at: "2026-10-28T00:00:00Z", agent_only: true }, "scope");
  try {
    await sends(pane, { ok: true }, [], { socketRef: { current: socket }, pendingScopeRef: { current: "scope" } }).actOnPending("srv-only", "edit");
    expect(composerDrafts.read(key).text).toBe("> q\nc");
    expect(composerDrafts.isAgentOnly(key)).toBe(true);
  } finally {
    composerDrafts.set(key, "");
    pendingMessages.removeCopy(owner, "srv-only");
    saved.restore();
  }
});

it.each([
  ["before this connection's features are known", false, false, "hold"],
  ["on a herdr-core server, which shows a card's wait as blocked", true, true, "hold"],
  ["on herdr, where blocked is the agent's own reading", true, false, "immediate"],
] as const)("sends a normal Send to a Codex shown blocked %s as %s, automatic sending off", async (_when, listed, modes, expected) => {
  const deliveries: SubmitDelivery[] = [];
  const actions = sends("blocked-pane", { ok: true }, [], {
    agent: "codex", agentStatus: "blocked",
    socketRef: { current: { connected: true, featuresListed: (): boolean => listed, typesArrows: (): boolean => modes } as unknown as HerdrSocket },
    submitComposerMessage: (_text, delivery) => { deliveries.push(delivery); return Promise.resolve({ ok: true }); },
  });
  await actions.composerSend("next step");
  expect(deliveries).toEqual([expected]);
});
