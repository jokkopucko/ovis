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

// A bridge without `submit` takes a message as raw input and sends no receipt (ws.ts `unconfirmed`):
// nothing says the pane got it, so its text must not go as if it had (#1591).
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
    // the box lets it go either way: the message did leave
    expect(result).toBe(true);
    if (kind === "unconfirmed") {
      expect(pendingMessages.read(owner)).toMatchObject([{ text: "deploy the fix", state: "uncertain", serverOwned: false, error: { code: "submit_unconfirmed" } }]);
      // a reload keeps it, not confirmed, never as a copy to send again
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
    // a copy kept since a connection that held it: this one sends it again by its id
    new PendingMessageStore(() => saved.storage).accept(owner, message, "earlier");
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
      // the row went: the chat shows the message as waiting until its turn is read; a replay of a
      // send another connection made typed nothing now, and its turn may be read already
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

// the bridge types a queued follow-up at once when the turn ended before it arrived: its receipt
// names no pending row, and the box lets the message go as for a send at once
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

// an ok with no row also answers a replayed id, or a row sent or discarded since: nothing was typed now
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
  // at rest: the draft's text goes at once, with the clear of that same draft before it
  expect(await sends("send-it", { ok: true }, shown, { t, agentStatus: "idle", submitComposerMessage }).composerSend("fix the tests", "fix the tests")).toBe(true);
  expect(calls).toEqual([["fix the tests", "immediate", "fix the tests"]]);
  // a turn started since: queued, the text could go again after the draft itself was sent in the terminal
  const working = await sends("send-it", { ok: true }, shown, { t, agentStatus: "working", inputAtRest: () => false, submitComposerMessage })
    .composerSend("fix the tests", "fix the tests");
  expect(typeof working).toBe("string");
  expect(calls).toHaveLength(1);
  // a menu opened since: the draft is never taken for one of its choices
  const blocked = await sends("send-it", { ok: true }, shown, { t, answering: prompt, submitComposerMessage })
    .composerSend("1", "1");
  expect(typeof blocked).toBe("string");
  expect(calls).toHaveLength(1);
  // Clear it and send of other text still queues behind a turn, as before
  expect(await sends("send-it", { ok: true }, shown, { t, agentStatus: "working", inputAtRest: () => false, submitComposerMessage })
    .composerSend("my new message", "fix the tests")).toBe(true);
  expect(calls).toEqual([["fix the tests", "immediate", "fix the tests"], ["my new message", "hold", undefined]]);
});

// #511: Send now of a saved copy of a message for an agent alone sends it again as one
it("sends a held copy of an agent-only message again as agent-only", async () => {
  const saved = savedStorage();
  const pane = "held-agent-only", owner = paneStorageId("local", pane), calls: unknown[][] = [];
  const message = { id: "held-only", request_id: 1, text: "> q\nc", state: "held" as const, created_at: "2026-10-28T00:00:00Z", agent_only: true as const };
  const submitComposerMessage = ((...args: unknown[]) => { calls.push(args); return Promise.resolve({ ok: true } as const); }) as ComposerSendsDeps["submitComposerMessage"];
  try {
    new PendingMessageStore(() => saved.storage).accept(owner, message, "earlier");
    await sends(pane, { ok: true }, [], { pendingScopeRef: { current: "now" }, submitComposerMessage }).actOnPending(message.id, "steer");
    expect(calls.map((call) => call[6])).toEqual([true]);
  } finally {
    pendingMessages.removeCopy(owner, message.id);
    saved.restore();
  }
});

// #511: Edit puts a held message for an agent alone back in the box as one
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
