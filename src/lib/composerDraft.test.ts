import { expect, it, setSystemTime, spyOn } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ComposerDraftStore, composerDrafts, SEND_LEASE_MS, storageEventDraft } from "./composerDraft.ts";
import { PendingMessageStore, pendingMessages } from "./pendingMessages.ts";
import { paneLifetimes } from "./paneLifetime.ts";
import { useComposerSends, type ComposerSendsDeps } from "./useComposerSends.ts";
import type { ServerMessage } from "../../shared/protocol.ts";
import type { HerdrSocket, SubmitResult } from "./ws.ts";
import { PendingInputs } from "../../server/pending-input.ts";
function fixture() {
  const data = new Map<string, string>();
  const storage = { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value); }, removeItem: (key: string) => { data.delete(key); } };
  return { data, store: new ComposerDraftStore(() => storage) };
}
it("does not edit another tab's saved held copy without authoritative withdrawal", async () => {
  const data = new Map<string, string>();
  const storage = paneLifetimes.paneStorage;
  const spies = [
    spyOn(storage, "getItem").mockImplementation((key) => data.get(key) ?? null),
    spyOn(storage, "setItem").mockImplementation((key, value) => { data.set(key, value); }),
    spyOn(storage, "removeItem").mockImplementation((key) => { data.delete(key); }),
  ];
  const owner = "edit-unowned", key = `ovis:composer-draft:${owner}`;
  const original = new PendingMessageStore(() => storage);
  // held by the bridge for a reason of its own (it names it), not at its sender's request
  const message = { id: "another-tabs-held-id", request_id: 1, text: "withdraw me", state: "held" as const, created_at: "2026-10-27T00:00:00Z", error: { code: "pending_lease_lost", message: "The pane connection changed; send this message explicitly after reviewing it" } };
  try {
    original.accept(owner, message, "original");
    // the bridge's held receipt proves it untyped for this page: only then is a saved held copy sent again
    pendingMessages.publish(owner, [], [{ id: message.id, outcome: "held", resumed: true, until: Date.now() + 60_000 }], "receipt");
    expect(pendingMessages.read(owner)[0]).toMatchObject({ state: "held", serverOwned: false });
    composerDrafts.set(key, "existing draft");
    let actions!: ReturnType<typeof useComposerSends>;
    function Composer() {
      const deps: Partial<ComposerSendsDeps> = {
        paneId: "p", paneRef: { current: "p" }, queueOwner: owner,
        socketRef: { current: null }, pendingScopeRef: { current: "other" },
        stillOpenRef: { current: null }, settings: { autoSendQueued: false }, answering: null, pendingAnswer: null,
      };
      actions = useComposerSends(deps as ComposerSendsDeps);
      return null;
    }
    renderToStaticMarkup(createElement(Composer));
    await actions.actOnPending(message.id, "edit");
    expect(composerDrafts.read(key).text).toBe("existing draft");
    expect(pendingMessages.read(owner)).toHaveLength(1);
    original.refresh(owner);
    expect(original.read(owner)).toMatchObject([{ id: message.id, serverOwned: true }]);
  } finally {
    pendingMessages.removeCopy(owner, message.id);
    composerDrafts.set(key, "");
    for (const spy of spies) spy.mockRestore();
  }
});
it.each(["sent", "discarded", "dismissed"] as const)("restores an edited row only on its exact withdrawal receipt: %s", async (outcome) => {
  const data = new Map<string, string>(), storage = paneLifetimes.paneStorage;
  const spies = [
    spyOn(storage, "getItem").mockImplementation((key) => data.get(key) ?? null),
    spyOn(storage, "setItem").mockImplementation((key, value) => { data.set(key, value); }),
    spyOn(storage, "removeItem").mockImplementation((key) => { data.delete(key); }),
  ];
  const owner = `edit-receipt-${outcome}`, key = `ovis:composer-draft:${owner}`;
  const message = { id: `held-${outcome}`, request_id: 1, text: "withdraw me", state: "held" as const, created_at: "2026-10-27T00:00:00Z" };
  const listeners = new Set<(frame: ServerMessage) => void>();
  const other = new PendingMessageStore(() => storage);
  try {
    pendingMessages.accept(owner, message, "scope");
    expect(other.read(owner)).toHaveLength(1);
    composerDrafts.set(key, "existing draft");
    const socket: Pick<HerdrSocket, "on" | "pendingAction"> = {
      on: (listener: (frame: ServerMessage) => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
      pendingAction: async (pane: string, id: string, action: string) => {
        expect([pane, id, action]).toEqual(["p", message.id, "discard"]);
        for (const listener of listeners) listener({ type: "pending-messages", pane_id: "p", messages: [], removed: [{ id: "another-id", outcome: "discarded" }] });
        expect(composerDrafts.read(key).text).toBe("existing draft");
        const frame: ServerMessage = { type: "pending-messages", pane_id: "p", messages: [], removed: [{ id, outcome }] };
        pendingMessages.publish(owner, frame.messages, frame.removed!, "scope");
        for (const listener of listeners) { listener(frame); listener(frame); }
        return { ok: true as const };
      },
    } as Pick<HerdrSocket, "on" | "pendingAction">;
    let actions!: ReturnType<typeof useComposerSends>;
    function Composer() {
      const deps: Partial<ComposerSendsDeps> = {
        paneId: "p", paneRef: { current: "p" }, queueOwner: owner,
        socketRef: { current: socket as HerdrSocket }, pendingScopeRef: { current: "scope" },
        stillOpenRef: { current: null }, settings: { autoSendQueued: false }, answering: null, pendingAnswer: null,
        knownOutcomes: () => [], inputRowNow: () => "ready",
      };
      actions = useComposerSends(deps as ComposerSendsDeps);
      return null;
    }
    renderToStaticMarkup(createElement(Composer));
    await actions.actOnPending(message.id, "edit");
    expect(composerDrafts.read(key).text).toBe(outcome === "discarded" ? "existing draft\n\nwithdraw me" : "existing draft");
    expect(pendingMessages.read(owner)).toEqual([]);
    // The server receipt removes the shared saved ID. The other tab's storage
    // event follows this same refresh path, leaving no stale Send now row.
    other.refresh(owner);
    expect(other.read(owner)).toEqual([]);
    expect(new PendingMessageStore(() => storage).read(owner)).toEqual([]);
    expect(listeners.size).toBe(0);
  } finally {
    pendingMessages.publish(owner, [], [{ id: message.id, outcome: "discarded" }], "scope");
    composerDrafts.set(key, "");
    for (const spy of spies) spy.mockRestore();
  }
});
it("drops a busy saved copy when its delayed resend learns that another tab withdrew it", async () => {
  const data = new Map<string, string>(), storage = paneLifetimes.paneStorage;
  const spies = [
    spyOn(storage, "getItem").mockImplementation((key) => data.get(key) ?? null),
    spyOn(storage, "setItem").mockImplementation((key, value) => { data.set(key, value); }),
    spyOn(storage, "removeItem").mockImplementation((key) => { data.delete(key); }),
  ];
  const owner = "edit-delayed-resend", original = new PendingMessageStore(() => storage);
  // held by the bridge for a reason of its own (it names it), not at its sender's request
  const message = { id: "withdrawn-during-resend", request_id: 1, text: "withdraw me", state: "held" as const, created_at: "2026-10-27T00:00:00Z", error: { code: "pending_lease_lost", message: "The pane connection changed; send this message explicitly after reviewing it" } };
  const started = Promise.withResolvers<void>(), reply = Promise.withResolvers<SubmitResult>();
  let sending: Promise<void> | undefined;
  try {
    original.accept(owner, message, "original");
    // the bridge's held receipt proves it untyped for this page: only then is a saved held copy sent again
    pendingMessages.publish(owner, [], [{ id: message.id, outcome: "held", resumed: true, until: Date.now() + 60_000 }], "receipt");
    expect(pendingMessages.read(owner)[0]?.serverOwned).toBe(false);
    let actions!: ReturnType<typeof useComposerSends>;
    function Composer() {
      const deps: Partial<ComposerSendsDeps> = {
        paneId: "p", paneRef: { current: "p" }, queueOwner: owner,
        socketRef: { current: { connected: true } as HerdrSocket }, pendingScopeRef: { current: "other" },
        heldRef: { current: false }, secretRef: { current: null }, observeRef: { current: false },
        draftHeldForRef: { current: null }, stillOpenRef: { current: null }, answering: null, pendingAnswer: null,
        settings: { autoSendQueued: false }, knownOutcomes: () => [], inputRowNow: () => "ready",
        submitComposerMessage: () => { started.resolve(); return reply.promise; },
      };
      actions = useComposerSends(deps as ComposerSendsDeps);
      return null;
    }
    renderToStaticMarkup(createElement(Composer));
    sending = actions.actOnPending(message.id, "steer");
    await started.promise;
    original.publish(owner, [], [{ id: message.id, outcome: "discarded" }], "original");
    pendingMessages.refresh(owner);
    // The in-flight copy survives storage reconciliation until its exact answer.
    expect(pendingMessages.isBusy(owner, message.id)).toBe(true);
    reply.resolve({ ok: false, code: "pending_discarded", message: "This pending message was withdrawn" });
    await sending;
    expect(pendingMessages.read(owner)).toEqual([]);
    expect(new PendingMessageStore(() => storage).read(owner)).toEqual([]);
  } finally {
    reply.resolve({ ok: false, code: "pending_discarded", message: "This pending message was withdrawn" });
    await sending;
    pendingMessages.removeCopy(owner, message.id);
    for (const spy of spies) spy.mockRestore();
  }
});
it("does not restore an already-editing row after another tab's ambiguous resend", async () => {
  const data = new Map<string, string>(), storage = paneLifetimes.paneStorage;
  const spies = [
    spyOn(storage, "getItem").mockImplementation((key) => data.get(key) ?? null),
    spyOn(storage, "setItem").mockImplementation((key, value) => { data.set(key, value); }),
    spyOn(storage, "removeItem").mockImplementation((key) => { data.delete(key); }),
  ];
  const owner = "edit-ambiguous-resend", key = `ovis:composer-draft:${owner}`;
  const listeners = new Set<(frame: ServerMessage) => void>(), removals: string[] = [];
  const other = new PendingMessageStore(() => storage);
  const server = new PendingInputs<string, null>((_owner, pane, messages, removed) => {
    pendingMessages.publish(owner, messages, removed ?? [], "scope");
    for (const receipt of removed ?? []) removals.push(receipt.outcome);
    for (const listener of listeners) listener({ type: "pending-messages", pane_id: pane, messages, removed });
  });
  const item = server.enqueue("original", "p", 1, "ambiguous Enter", null, { agent: "claude", terminalId: "p", session: null }, true);
  let deliveries = 0;
  try {
    // its sender asked the bridge to hold it (enqueue's `held`): another tab's saved copy is held too, as before
    expect(other.read(owner)[0]).toMatchObject({ state: "held", serverOwned: false, heldByRequest: true });
    composerDrafts.set(key, "existing draft");
    const socket: Pick<HerdrSocket, "on" | "pendingAction"> = {
      on: (listener: (frame: ServerMessage) => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
      pendingAction: async (_pane, _id, _action, _generation, withdrawalOnly) => {
        expect(withdrawalOnly).toBe(true);
        // Edit has installed its listener, but its frame is delayed. The other
        // tab's persisted resend marker cannot cancel an already-started Edit.
        expect(other.unconfirm(owner, item.message.id)).toBe(true);
        const reply = await server.resend("p", item.message.id, "fingerprint", async () => {
          deliveries++; return { ok: false, code: "submit_changed", message: "Enter may have reached the terminal" };
        });
        other.fail(owner, item.message.id, { code: reply.code!, message: reply.message! }, true, 0);
        return server.discard(item, withdrawalOnly) ? { ok: true } : { ok: false, code: "pending_uncertain", message: "Check the terminal" };
      },
    };
    let actions!: ReturnType<typeof useComposerSends>;
    function Composer() {
      const deps: Partial<ComposerSendsDeps> = {
        paneId: "p", paneRef: { current: "p" }, queueOwner: owner,
        socketRef: { current: socket as HerdrSocket }, pendingScopeRef: { current: "scope" },
        stillOpenRef: { current: null }, settings: { autoSendQueued: false }, answering: null, pendingAnswer: null,
        knownOutcomes: () => [], inputRowNow: () => "ready",
      };
      actions = useComposerSends(deps as ComposerSendsDeps);
      return null;
    }
    renderToStaticMarkup(createElement(Composer));
    await actions.actOnPending(item.message.id, "edit");
    expect(deliveries).toBe(1);
    expect(composerDrafts.read(key).text).toBe("existing draft");
    expect(removals).not.toContain("discarded");
    expect(server.list("original", "p")).toMatchObject([{ id: item.message.id, state: "uncertain" }]);
    expect(pendingMessages.read(owner)).toMatchObject([{ id: item.message.id, state: "uncertain" }]);
    expect(listeners.size).toBe(0);
  } finally {
    pendingMessages.publish(owner, [], [{ id: item.message.id, outcome: "discarded" }], "scope");
    composerDrafts.set(key, "");
    for (const spy of spies) spy.mockRestore();
  }
});
it("restores withdrawn text into the latest draft without losing mentions, typing or an in-flight send", () => {
  const { store, data } = fixture();
  store.set("a", "@/tmp/image.png draft");
  store.begin("a", "@/tmp/image.png draft");
  data.set("a", "@/tmp/image.png draft plus concurrent typing");
  store.restorePending("a", "withdrawn");
  expect(store.read("a").text).toBe("@/tmp/image.png draft plus concurrent typing\n\nwithdrawn");
  store.settle("a", "@/tmp/image.png draft");
  store.end("a");
  expect(store.read("a").text).toBe(" plus concurrent typing\n\nwithdrawn");
  store.restorePending("b", "another pane");
  expect(store.read("b").text).toBe("another pane");
  expect(store.read("a").text).toContain("withdrawn");
});
it("keeps the draft busy and intact until an acknowledged send settles, and releases a refused send for retry", () => {
  const { store } = fixture();
  store.set("a", "check delivery");
  expect(store.begin("a", "check delivery")).toBe(true);
  expect(store.read("a")).toEqual({ text: "check delivery", sending: true });
  expect(store.begin("a", "check delivery")).toBe(false);
  store.settle("a", "check delivery");
  store.end("a");
  expect(store.read("a")).toEqual({ text: "", sending: false });
  store.set("a", "retry this");
  store.begin("a", "retry this");
  store.end("a");
  expect(store.read("a")).toEqual({ text: "retry this", sending: false });
  expect(store.begin("a", "retry this")).toBe(true);
});
it("settles an unmounted pane's draft and pending send without changing another owner", () => {
  const { store, data } = fixture();
  store.set("local:a", "sent"); store.begin("local:a");
  store.set("remote:a", "other PC");
  expect(store.begin("local:a")).toBe(false);
  store.settle("local:a", "sent"); store.end("local:a");
  expect(store.read("local:a")).toEqual({ text: "", sending: false });
  expect(data.has("local:a")).toBe(false);
  expect(store.read("remote:a").text).toBe("other PC");
});
it("preserves appended text, internal edits and newer edits from another tab", () => {
  const { store, data } = fixture();
  store.set("a", "sent plus next");
  expect(store.settle("a", "sent")).toEqual({ text: " plus next", edited: false });
  store.set("a", "edited sent");
  expect(store.settle("a", "sent")).toEqual({ text: "edited sent", edited: true });
  data.set("a", "another tab's draft");
  expect(store.settle("a", "sent").text).toBe("another tab's draft");
});
it("notifies a remounted composer and keeps a failed send's draft", () => {
  const { store } = fixture();
  store.set("a", "sent"); store.begin("a");
  let updates = 0;
  const off = store.subscribe(() => { updates++; });
  store.end("a");
  expect(store.read("a").text).toBe("sent");
  store.settle("a", "sent");
  expect(updates).toBe(2);
  off();
});
it("retains unsaved edits when browser storage is unavailable", () => {
  const store = new ComposerDraftStore(() => { throw new Error("blocked"); });
  store.set("a", "sent then next");
  expect(store.settle("a", "sent").text).toBe(" then next");
});
it("keeps a draft cleared and retyped while its send was on its way", () => {
  const { store } = fixture();
  store.set("a", "a"); store.begin("a", "a");
  store.set("a", ""); store.set("a", "ab");
  expect(store.settle("a", "a")).toEqual({ text: "ab", edited: true });
  store.end("a");
  // a plain append during the next send still loses only the sent prefix
  store.set("a", "x"); store.begin("a", "x");
  store.set("a", "xy");
  expect(store.settle("a", "x")).toEqual({ text: "y", edited: false });
  store.end("a");
});
it("keeps a draft another tab cleared and retyped while this tab's send was on its way", () => {
  const { store, data } = fixture();
  store.set("a", "sent"); store.begin("a", "sent");
  data.delete("a"); store.refresh("a");
  data.set("a", "sent again"); store.refresh("a");
  expect(store.settle("a", "sent")).toEqual({ text: "sent again", edited: true });
  store.end("a");
});
it("refuses a second tab's send while the first is still on its way", () => {
  const { data, store: first } = fixture();
  const second = new ComposerDraftStore(() => ({
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { data.set(key, value); },
    removeItem: (key: string) => { data.delete(key); },
  }));
  first.set("a", "do the thing");
  first.begin("a", "do the thing");
  // the other tab reads the same draft and sees the send, so it cannot send it again
  second.read("a");
  second.refresh("a");
  expect(second.read("a")).toEqual({ text: "do the thing", sending: true });
  expect(second.begin("a")).toBe(false);
  // the first tab's end is what releases it, and the draft text is still there to send
  first.end("a");
  second.refresh("a");
  expect(second.read("a")).toEqual({ text: "do the thing", sending: false });
  expect(second.begin("a")).toBe(true);
});
it("honours another tab's send as a lease, not forever", () => {
  const { data, store } = fixture();
  data.set("ovis:composer-sending:a", JSON.stringify({ sent: "x", at: Date.now() - SEND_LEASE_MS - 1 }));
  store.read("a");
  store.refresh("a");
  expect(store.read("a").sending).toBe(false);
  expect(store.begin("a")).toBe(true);
});
it("ignores a hand-edited sending record instead of blocking the pane", () => {
  const { data, store } = fixture();
  data.set("ovis:composer-sending:a", "not json");
  store.read("a");
  store.refresh("a");
  expect(store.begin("a")).toBe(true);
});
it("still reconciles another tab's text when no send is in flight", () => {
  const { data, store } = fixture();
  store.set("a", "mine");
  store.refresh("a");
  data.set("a", "theirs");
  store.refresh("a");
  expect(store.read("a").text).toBe("theirs");
});

it("names the draft another tab's edit or send concerns, and nothing else", () => {
  const key = "ovis:composer-draft:local:w1:p1";
  expect(storageEventDraft(key)).toBe(key);
  expect(storageEventDraft(`ovis:composer-sending:${key}`)).toBe(key);
  expect(storageEventDraft("ovis:settings")).toBeNull();
  expect(storageEventDraft(null)).toBeNull();
});

it("lets a tab send again once another tab's abandoned lease runs out, and tells its composer", () => {
  const data = new Map<string, string>();
  const storage = { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value); }, removeItem: (key: string) => { data.delete(key); } };
  const wakeUps: Array<{ run: () => void; ms: number }> = [];
  const closed = new ComposerDraftStore(() => storage);
  const other = new ComposerDraftStore(() => storage, (run, ms) => { wakeUps.push({ run, ms }); return 0; });
  const key = "ovis:composer-draft:local:w1:p1";
  const start = Date.now();
  try {
    setSystemTime(start);
    expect(closed.begin(key, "hello")).toBe(true);
    // the other tab hears of the lease; the sending tab then closes without ending it
    other.refresh(key);
    expect(other.read(key).sending).toBe(true);
    expect(other.begin(key, "hello")).toBe(false);
    expect(wakeUps.length).toBe(1);
    expect(wakeUps[0]!.ms).toBeGreaterThan(SEND_LEASE_MS - 1000);
    let told = 0;
    other.subscribe(() => { told += 1; });
    setSystemTime(start + SEND_LEASE_MS + 1);
    wakeUps[0]!.run();
    expect(other.read(key).sending).toBe(false);
    expect(told).toBe(1);
    expect(other.begin(key, "hello")).toBe(true);
  } finally {
    setSystemTime();
  }
});
