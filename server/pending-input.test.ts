import { describe, expect, it } from "bun:test";
import { MAX_PENDING_PER_OWNER, MAX_PENDING_PER_PANE, PendingInputs, PendingInputError, samePendingIdentity, type PendingIdentity } from "./pending-input.ts";
import { PendingMessageStore } from "../src/lib/pendingMessages.ts";

describe("pending target identity", () => {
  const identity: PendingIdentity = { agent: "claude", terminalId: "t1", session: null, processPid: 12, processBirth: 100_000, omoSession: null };

  it("refuses known process, birth, native session and OmO session replacements (regression #540)", () => {
    expect(samePendingIdentity(identity, { ...identity, processPid: 13 })).toBe(false);
    expect(samePendingIdentity(identity, { ...identity, processBirth: 110_000 })).toBe(false);
    expect(samePendingIdentity({ ...identity, session: "old" }, { ...identity, session: "new" })).toBe(false);
    expect(samePendingIdentity({ ...identity, omoSession: "old" }, { ...identity, omoSession: "new" })).toBe(false);
  });

  it("refuses a hookless Claude's session switched by /clear or /resume in the same process (regression #540)", () => {
    expect(samePendingIdentity({ ...identity, claudeSession: "before-clear" }, { ...identity, claudeSession: "after-clear" })).toBe(false);
    expect(samePendingIdentity({ ...identity, claudeSession: "same" }, { ...identity, claudeSession: "same" })).toBe(true); // control
    expect(samePendingIdentity({ ...identity, claudeSession: null }, { ...identity, claudeSession: "learned" })).toBe(true); // control: learned later
    expect(samePendingIdentity({ ...identity, claudeSession: "known" }, { ...identity, claudeSession: null })).toBe(true); // control: record unreadable now (a send refuses it in pendingContext, #2125)
  });

  it("permits identity parts that were unknown on either read (control #540)", () => {
    const unknown: PendingIdentity = { agent: "claude", terminalId: "t1", session: null };
    const known = { ...identity, session: "native", omoSession: "omo" };
    expect(samePendingIdentity(unknown, known)).toBe(true);
    expect(samePendingIdentity(known, unknown)).toBe(true);
    expect(samePendingIdentity(identity, { ...identity })).toBe(true);
    expect(samePendingIdentity(identity, { ...identity, terminalId: "t2" })).toBe(false);
    expect(samePendingIdentity(identity, { ...identity, agent: null })).toBe(false);
  });

  it("tolerates only the existing macOS birth precision (control #540)", () => {
    expect(samePendingIdentity(identity, { ...identity, processBirth: 101_000 }, "darwin")).toBe(true);
    expect(samePendingIdentity(identity, { ...identity, processBirth: 101_001 }, "darwin")).toBe(false);
    expect(samePendingIdentity(identity, { ...identity, processBirth: 101_000 }, "linux")).toBe(false);
  });
});

function fixture() {
  let now = 1_000;
  let id = 0;
  const receipts: Array<{ owner: string; pane: string; messages: unknown[]; removed?: unknown[] }> = [];
  const queue = new PendingInputs<string, string>((owner, pane, messages, removed) => receipts.push({ owner, pane, messages, removed }), () => now, 100, () => `pending-${++id}`);
  const enqueue = (request: number, owner = "a", pane = "p1", text = `message ${request}`) => queue.enqueue(owner, pane, request, text, "lease", { agent: "claude", terminalId: "t1", session: null });
  return { queue, receipts, enqueue, advance: (ms: number) => { now += ms; queue.expire(); } };
}

describe("bridge pending input", () => {
  it.each(["submit_changed", "submit_partial", "submit_failed", "disconnected", "timeout", "unknown_failure"])(
    "retains ambiguous held-copy disposition across generations and dismissal: %s", async (code) => {
      const f = fixture(), item = f.enqueue(1);
      f.queue.hold("a");
      let deliveries = 0;
      await f.queue.resend("p1", item.message.id, "fingerprint", async () => { deliveries++; return { ok: false, code, message: "Check the terminal" }; });
      expect(item.message).toMatchObject({ state: "uncertain", error: { code } });
      expect(f.queue.claim(item, false)).toBe(false);
      f.advance(60_001);
      const send = async () => { deliveries++; return { ok: true }; };
      expect(await f.queue.resend("p1", item.message.id, "fingerprint", send, 1)).toMatchObject({ ok: false, code: "pending_uncertain" });
      expect(f.queue.discard(item, true)).toBe(false);
      expect(f.queue.list("a", "p1")).toMatchObject([{ id: item.message.id, state: "uncertain" }]);
      expect(f.queue.discard(item)).toBe(true);
      expect(f.queue.outcome("a", "p1", item.message.id)).toBe("dismissed");
      expect(f.receipts.at(-1)?.removed).toEqual([{ id: item.message.id, outcome: "dismissed" }]);
      expect(await f.queue.resend("p1", item.message.id, "fingerprint", send, 2)).toMatchObject({ ok: false, code: "pending_uncertain" });
      expect(deliveries).toBe(1);
    });
  it("keeps an ambiguous disposition when its disconnected owner's row expires", async () => {
    const f = fixture(), item = f.enqueue(1);
    await f.queue.resend("p1", item.message.id, "fingerprint", async () => ({ ok: false, code: "submit_changed" }));
    f.queue.close("a"); f.advance(60_001);
    expect(f.queue.list("a", "p1")).toEqual([]);
    expect(f.queue.outcome("a", "p1", item.message.id)).toBe("dismissed");
    expect(await f.queue.resend("p1", item.message.id, "fingerprint", async () => ({ ok: true }), 1))
      .toMatchObject({ ok: false, code: "pending_uncertain" });
  });
  it("keeps an ambiguous saved-only resend uncertain across generations without an original row", async () => {
    const f = fixture();
    await f.queue.resend("p1", "saved", "fingerprint", async () => ({ ok: false, code: "submit_changed" }));
    let deliveries = 0;
    expect(await f.queue.resend("p1", "saved", "fingerprint", async () => { deliveries++; return { ok: true }; }, 1))
      .toMatchObject({ ok: false, code: "pending_uncertain" });
    expect(deliveries).toBe(0);
  });
  it("leaves a definitively refused held copy withdrawable", async () => {
    const f = fixture(), item = f.enqueue(1);
    f.queue.hold("a");
    await f.queue.resend("p1", item.message.id, "fingerprint", async () => ({ ok: false, code: "agent_blocked" }));
    expect(item.message.state).toBe("held");
    expect(f.queue.discard(item)).toBe(true);
    expect(f.queue.outcome("a", "p1", item.message.id)).toBe("discarded");
  });
  it("refuses withdrawal after another connection delivered the same held ID", async () => {
    const f = fixture(), item = f.enqueue(1);
    f.queue.hold("a");
    let deliveries = 0;
    await f.queue.resend("p1", item.message.id, "fingerprint", async () => { deliveries++; return { ok: true }; });
    expect(f.queue.discard(item)).toBe(false);
    expect(f.queue.outcome("a", "p1", item.message.id)).toBe("sent");
    expect(f.receipts.at(-1)?.removed).toEqual([{ id: item.message.id, outcome: "sent" }]);
    expect(f.queue.claim(item, false)).toBe(false);
    expect(deliveries).toBe(1);
  });
  it("refuses a delayed held-copy resend after authoritative withdrawal", async () => {
    const f = fixture(), item = f.enqueue(1);
    f.queue.hold("a");
    expect(f.queue.discard(item)).toBe(true);
    let deliveries = 0;
    const reply = await f.queue.resend("p1", item.message.id, "fingerprint", async () => { deliveries++; return { ok: true }; });
    expect(reply).toMatchObject({ ok: false, code: "pending_discarded" });
    expect(deliveries).toBe(0);
    expect(f.queue.outcome("a", "p1", item.message.id)).toBe("discarded");
    expect(f.queue.claim(item, false)).toBe(false);
  });
  it("keeps withdrawal across retry generations and owner expiry", async () => {
    const f = fixture(), item = f.enqueue(1);
    await f.queue.resend("p1", item.message.id, "fingerprint", async () => ({ ok: false, code: "agent_blocked" }));
    expect(f.queue.discard(item)).toBe(true);
    f.queue.close("a"); f.advance(60_001);
    let deliveries = 0;
    for (const generation of [0, 1]) {
      expect((await f.queue.resend("p1", item.message.id, "fingerprint", async () => { deliveries++; return { ok: true }; }, generation)).ok).toBe(false);
    }
    expect(deliveries).toBe(0);
  });
  it("lets a final delivery supersede an earlier retry refusal", async () => {
    const f = fixture(), item = f.enqueue(1);
    await f.queue.resend("p1", item.message.id, "fingerprint", async () => ({ ok: false, code: "agent_blocked" }));
    expect(f.queue.claim(item, false)).toBe(true);
    f.queue.settle(item);
    let deliveries = 0;
    for (const generation of [0, 1]) {
      expect(await f.queue.resend("p1", item.message.id, "fingerprint", async () => { deliveries++; return { ok: true }; }, generation)).toEqual({ ok: true });
    }
    expect(deliveries).toBe(0);
  });
  it("bounds dispositions without evicting withdrawals inside the resend retention window", async () => {
    const f = fixture(), first = f.enqueue(1), reserved = f.enqueue(2);
    expect(f.queue.discard(first)).toBe(true);
    for (let request = 3; request <= 1024; request++) expect(f.queue.discard(f.enqueue(request))).toBe(true);
    expect(() => f.enqueue(1025)).toThrow(PendingInputError);
    // Already accepted input still has room for its final outcome.
    expect(f.queue.discard(reserved)).toBe(true);
    const submit = async () => ({ ok: true });
    expect((await f.queue.resend("p1", first.message.id, "fingerprint", submit)).ok).toBe(false);
    f.advance(60_001);
    expect(f.enqueue(1025)).toBeDefined();
    // The bounded-window policy deliberately preserves stale-copy recovery after
    // disposition eviction, just as after a bridge restart.
    expect((await f.queue.resend("p1", first.message.id, "fingerprint", submit)).ok).toBe(true);
  });
  it("does not withdraw while a held-copy delivery is in flight", async () => {
    const f = fixture(), item = f.enqueue(1);
    const started = Promise.withResolvers<void>(), completion = Promise.withResolvers<{ ok: boolean }>();
    const sending = f.queue.resend("p1", item.message.id, "fingerprint", () => { started.resolve(); return completion.promise; });
    try {
      await started.promise;
      expect(f.queue.discard(item)).toBe(false);
    } finally { completion.resolve({ ok: true }); }
    expect(await sending).toEqual({ ok: true });
    expect(f.queue.discard(item)).toBe(false);
    expect(f.queue.outcome("a", "p1", item.message.id)).toBe("sent");
  });
  it("regression: shares one resend outcome across stale cross-tab reads", async () => {
    const f = fixture();
    let finish!: (value: { ok: boolean }) => void;
    const completion = new Promise<{ ok: boolean }>((resolve) => { finish = resolve; });
    const submitted: string[] = [];
    const submit = () => { submitted.push("copy-id"); return completion; };
    let saved = JSON.stringify({ messages: [{ id: "copy-id", request_id: 1, text: "text", state: "held", created_at: "2026-10-14T00:00:00Z" }] });
    const snapshot = saved;
    const port = { getItem: () => snapshot, setItem: (_key: string, raw: string) => { saved = raw; }, removeItem: () => {} };
    const a = new PendingMessageStore(() => port), b = new PendingMessageStore(() => port);
    // A read, B read, A write, B write: localStorage cannot make this claim atomic.
    const firstCopy = a.read("p")[0]!, secondCopy = b.read("p")[0]!;
    a.begin("p", firstCopy.id); b.begin("p", secondCopy.id);
    expect(a.unconfirm("p", firstCopy.id)).toBe(true);
    expect(b.unconfirm("p", secondCopy.id)).toBe(true);
    const first = f.queue.resend("p", firstCopy.id, firstCopy.text, submit);
    const second = f.queue.resend("p", secondCopy.id, secondCopy.text, submit);
    await Promise.resolve();
    finish({ ok: true });
    expect(await Promise.all([first, second])).toEqual([{ ok: true }, { ok: true }]);
    expect(submitted).toEqual(["copy-id"]);
  });
  it("control: retains refused outcomes and rejects a different message for the same resend id", async () => {
    const f = fixture();
    expect(await f.queue.resend("p", "id", "one", async () => ({ ok: false, code: "agent_blocked" }))).toEqual({ ok: false, code: "agent_blocked" });
    expect(await f.queue.resend("p", "id", "one", async () => ({ ok: true }))).toEqual({ ok: false, code: "agent_blocked" });
    expect(() => f.queue.resend("p", "id", "two", async () => ({ ok: true }))).toThrow("another message");
    expect(await f.queue.resend("p", "id", "one", async () => ({ ok: true }), 1)).toEqual({ ok: true });
  });
  it("control: retains an in-flight resend past the lifetime and expires only settled receipts", async () => {
    const f = fixture();
    let finish!: (value: { ok: boolean }) => void;
    const first = f.queue.resend("p", "id", "text", () => new Promise((resolve) => { finish = resolve; }));
    await Promise.resolve();
    f.advance(60_001);
    expect(f.queue.resend("p", "id", "text", async () => ({ ok: false }))).toBe(first);
    finish({ ok: true });
    await first;
    f.advance(60_001);
    expect(await f.queue.resend("p", "id", "text", async () => ({ ok: false }))).toEqual({ ok: false });
  });
  it("control: settles the original pending row and retains its sent disposition after resend receipt expiry", async () => {
    const f = fixture(), item = f.enqueue(1);
    const first = f.queue.resend("p1", item.message.id, "fingerprint", async () => ({ ok: true }));
    await first;
    f.advance(60_001);
    expect(f.queue.list("a", "p1")).toEqual([]);
    expect(f.queue.outcome("a", "p1", item.message.id)).toBe("sent");
    expect(await f.queue.resend("p1", item.message.id, "fingerprint", async () => ({ ok: false }))).toEqual({ ok: true });
  });
  it("deduplicates the same connection's request and rejects id reuse for another message", () => {
    const f = fixture();
    const first = f.enqueue(1);
    expect(f.enqueue(1)).toBe(first);
    expect(() => f.enqueue(1, "a", "p1", "different")).toThrow("another message");
    expect(f.queue.list("a", "p1")).toHaveLength(1);
    expect(f.queue.list("a", "p1")[0]?.request_id).toBe(1);
  });

  it("keeps identities and receipts private to the owner and pane", () => {
    const f = fixture();
    const item = f.enqueue(1);
    expect(f.queue.get("b", "p1", item.message.id)).toBeUndefined();
    expect(f.queue.get("a", "p2", item.message.id)).toBeUndefined();
    expect(f.queue.list("b", "p1")).toEqual([]);
    expect(f.receipts[0]?.owner).toBe("a");
  });

  it("bounds the retained queue without dropping a submitted message", () => {
    const f = fixture();
    for (let i = 0; i < MAX_PENDING_PER_OWNER; i++) f.enqueue(i);
    expect(() => f.enqueue(MAX_PENDING_PER_OWNER)).toThrow("full");
    expect(f.queue.list("a", "p1")).toHaveLength(MAX_PENDING_PER_OWNER);
  });

  it("lets automatic delivery and clicking claim the same id only once", () => {
    const f = fixture(); const item = f.enqueue(1);
    f.queue.status("p1", "idle");
    expect(f.queue.claim(item, true)).toBe(true);
    expect(f.queue.claim(item, false)).toBe(false);
    f.queue.committing(item); f.queue.settle(item);
    expect(f.queue.claim(item, false)).toBe(false);
    expect(f.queue.outcome("a", "p1", item.message.id)).toBe("sent");
    expect(f.queue.outcome("b", "p1", item.message.id)).toBeUndefined();
  });

  it("never offers a held message to automatic delivery, only to an explicit send", () => {
    const f = fixture();
    const held = f.queue.enqueue("a", "p1", 1, "later", "lease", { agent: "claude", terminalId: "t1", session: null }, true);
    const queued = f.enqueue(2);
    expect(held.message.state).toBe("held");
    f.queue.status("p1", "idle");
    expect(f.queue.next("p1")).toBe(queued);
    expect(f.queue.claim(held, true)).toBe(false);
    expect(f.queue.claim(held, false)).toBe(true);
  });

  it("does not flush a second message from a lagging ready snapshot", () => {
    const f = fixture(); const first = f.enqueue(1); const second = f.enqueue(2);
    f.queue.status("p1", "done");
    expect(f.queue.claim(first, true)).toBe(true); f.queue.committing(first); f.queue.settle(first);
    f.queue.status("p1", "done"); f.queue.status("p1", "idle");
    expect(f.queue.next("p1")).toBeNull();
    f.queue.status("p1", "working"); f.queue.status("p1", "done");
    expect(f.queue.next("p1")).toBe(second);
  });

  it("waits for the current work to finish after an explicit steer", () => {
    const f = fixture(); const first = f.enqueue(1); const second = f.enqueue(2);
    f.queue.status("p1", "working");
    expect(f.queue.claim(first, false)).toBe(true); f.queue.committing(first, true); f.queue.settle(first);
    expect(f.queue.next("p1")).toBeNull();
    f.queue.status("p1", "done"); expect(f.queue.next("p1")).toBe(second);
  });

  for (const settleBeforeIdle of [true, false]) it(`keeps the interruption's ready state from draining the queue (${settleBeforeIdle ? "settled" : "in flight"})`, () => {
    const f = fixture(); const first = f.enqueue(1); const second = f.enqueue(2);
    f.queue.status("p1", "working"); f.queue.claim(first, false);
    f.queue.committing(first, true, true);
    if (settleBeforeIdle) f.queue.settle(first);
    f.queue.status("p1", "idle");
    if (!settleBeforeIdle) f.queue.settle(first);
    expect(f.queue.next("p1")).toBeNull();
    f.queue.status("p1", "done"); expect(f.queue.next("p1")).toBeNull();
    f.queue.status("p1", "working"); expect(f.queue.next("p1")).toBeNull();
    f.queue.status("p1", "done"); expect(f.queue.next("p1")).toBe(second);
  });

  it("holds remaining input when an interruption never exposes its ready transition", () => {
    const f = fixture(); const first = f.enqueue(1); const second = f.enqueue(2);
    f.queue.status("p1", "working"); f.queue.claim(first, false);
    f.queue.committing(first, true, true); f.queue.settle(first);
    f.queue.status("p1", "working"); f.queue.status("p1", "working"); f.advance(101);
    expect(second.message.state).toBe("held");
    f.queue.status("p1", "done"); expect(f.queue.next("p1")).toBeNull();
  });

  it("holds remaining input when the interrupted turn stops but its replacement never starts", () => {
    const f = fixture(); const first = f.enqueue(1); const second = f.enqueue(2);
    f.queue.status("p1", "working"); f.queue.claim(first, false);
    f.queue.committing(first, true, true); f.queue.settle(first);
    f.queue.status("p1", "idle"); f.advance(101);
    expect(second.message.state).toBe("held");
    expect(second.message.error?.code).toBe("pending_turn_unconfirmed");
  });

  it("retains a restarted turn's completion observed before the send settles", () => {
    const f = fixture(); const first = f.enqueue(1); const second = f.enqueue(2);
    f.queue.status("p1", "working"); f.queue.claim(first, false); f.queue.committing(first, true, true);
    f.queue.status("p1", "idle"); f.queue.status("p1", "working"); f.queue.status("p1", "done");
    expect(f.queue.next("p1")).toBeNull(); f.queue.settle(first);
    expect(f.queue.next("p1")).toBe(second);
  });

  it("holds the remaining queue when no new turn was confirmed before its deadline", () => {
    const f = fixture(); const first = f.enqueue(1); const second = f.enqueue(2);
    f.queue.status("p1", "idle"); f.queue.claim(first, true); f.queue.committing(first); f.queue.settle(first);
    f.advance(101);
    expect(second.message.state).toBe("held");
    f.queue.status("p1", "working"); f.queue.status("p1", "idle");
    expect(f.queue.next("p1")).toBeNull();
    expect(f.queue.claim(second, false)).toBe(true);
  });

  it("does not apply the start deadline to a confirmed long-running turn", () => {
    const f = fixture(); const first = f.enqueue(1); const second = f.enqueue(2);
    f.queue.status("p1", "idle"); f.queue.claim(first, true); f.queue.committing(first); f.queue.settle(first);
    f.queue.status("p1", "working"); f.advance(1_000);
    expect(second.message.state).toBe("queued"); expect(f.queue.next("p1")).toBeNull();
    f.queue.status("p1", "done"); expect(f.queue.next("p1")).toBe(second);
  });

  it("holds before dispatch on lease loss, without rearming on subsequent status events", () => {
    const f = fixture(); const item = f.enqueue(1);
    f.queue.hold("a", "p1");
    expect(item.message.state).toBe("held");
    f.queue.status("p1", "working"); f.queue.status("p1", "idle");
    expect(f.queue.next("p1")).toBeNull();
  });

  it("marks loss during input uncertain and never retries an ambiguous commit", () => {
    const f = fixture(); const first = f.enqueue(1); const second = f.enqueue(2);
    f.queue.status("p1", "working"); f.queue.claim(first, false); f.queue.close("a");
    expect(first.message.state).toBe("uncertain"); expect(second.message.state).toBe("held");
    f.queue.settle(first, { code: "submit_changed", message: "check terminal" }, true);
    f.queue.status("p1", "done");
    expect(f.queue.next("p1")).toBeNull(); expect(f.queue.claim(first, false)).toBe(false);
  });

  it("discards without sending and replays only the explicit removal outcome", () => {
    const f = fixture(); const item = f.enqueue(1);
    expect(f.queue.discard(item)).toBe(true); expect(f.queue.discard(item)).toBe(false);
    expect(f.queue.outcome("a", "p1", item.message.id)).toBe("discarded");
    expect(f.receipts.at(-1)?.removed).toEqual([{ id: item.message.id, outcome: "discarded" }]);
  });

  it("never drains blocked or unknown states", () => {
    const f = fixture(); f.enqueue(1);
    f.queue.status("p1", "blocked"); expect(f.queue.next("p1")).toBeNull();
    f.queue.status("p1", "unknown"); expect(f.queue.next("p1")).toBeNull();
  });

  it("keeps an earlier send's unconfirmed turn when a later explicit send is refused before its key", () => {
    const f = fixture(); const first = f.enqueue(1); const second = f.enqueue(2); const third = f.enqueue(3);
    f.queue.status("p1", "idle");
    expect(f.queue.claim(first, true)).toBe(true); f.queue.committing(first); f.queue.settle(first);
    expect(f.queue.claim(second, false)).toBe(true);
    f.queue.settle(second, { code: "pending_lease_lost", message: "lost" });
    expect(second.message.state).toBe("held");
    expect(f.queue.next("p1")).toBeNull();
    f.queue.status("p1", "working"); f.queue.status("p1", "done");
    expect(f.queue.next("p1")).toBe(third);
  });

  it("counts the earlier turn's cycle seen while a later explicit send was being checked", () => {
    const f = fixture(); const first = f.enqueue(1); const second = f.enqueue(2); const third = f.enqueue(3);
    f.queue.status("p1", "idle");
    expect(f.queue.claim(first, true)).toBe(true); f.queue.committing(first); f.queue.settle(first);
    expect(f.queue.claim(second, false)).toBe(true);
    f.queue.status("p1", "working"); f.queue.status("p1", "done");
    expect(f.queue.next("p1")).toBeNull();
    f.queue.settle(second, { code: "agent_blocked", message: "menu" });
    expect(f.queue.next("p1")).toBe(third);
  });

  it("still holds the rest when the earlier turn never starts, whatever a refused explicit send did", () => {
    const f = fixture(); const first = f.enqueue(1); const second = f.enqueue(2); const third = f.enqueue(3);
    f.queue.status("p1", "idle");
    expect(f.queue.claim(first, true)).toBe(true); f.queue.committing(first); f.queue.settle(first);
    expect(f.queue.claim(second, false)).toBe(true);
    f.queue.settle(second, { code: "pending_lease_lost", message: "lost" });
    f.advance(100);
    expect(third.message.state).toBe("held");
    expect(third.message.error?.code).toBe("pending_turn_unconfirmed");
  });

  it("keeps a completion the collector reported while a snapshot that still said working was being read", () => {
    const f = fixture();
    f.queue.status("p1", "working");
    const mark = f.queue.mark("p1");
    f.queue.status("p1", "done");
    f.queue.observe("p1", "working", mark);
    const item = f.enqueue(1);
    expect(f.queue.next("p1")).toBe(item);
  });

  it("takes a snapshot's status when no event came since, also as the first word on a pane", () => {
    const f = fixture(); const item = f.enqueue(1);
    f.queue.observe("p1", "idle", f.queue.mark("p1"));
    expect(f.queue.next("p1")).toBe(item);
    f.queue.observe("p1", "working", f.queue.mark("p1"));
    expect(f.queue.next("p1")).toBeNull();
  });

  it("knows a pane where a message still waits its turn", () => {
    const f = fixture(); f.enqueue(1);
    expect(f.queue.waiting("p1")).toBe(true);
    expect(f.queue.waiting("p2")).toBe(false);
    f.queue.hold("a");
    expect(f.queue.waiting("p1")).toBe(false);
  });

  it("forgets an ended pane's status and its turn gate", () => {
    const f = fixture(); const first = f.enqueue(1);
    f.queue.status("p1", "idle");
    expect(f.queue.claim(first, true)).toBe(true); f.queue.committing(first); f.queue.settle(first);
    f.queue.status("p1", "working");
    f.queue.forget("p1");
    const second = f.enqueue(2);
    expect(f.queue.next("p1")).toBeNull();
    f.queue.status("p1", "idle");
    expect(f.queue.next("p1")).toBe(second);
  });

  it("ignores another turn's pre-key cycle and waits for the committed message's own cycle", () => {
    const f = fixture(); const first = f.enqueue(1); const second = f.enqueue(2);
    f.queue.status("p1", "idle"); f.queue.claim(first, true);
    f.queue.status("p1", "working"); f.queue.status("p1", "done");
    f.queue.committing(first); f.queue.settle(first);
    expect(f.queue.next("p1")).toBeNull();
    f.queue.status("p1", "working"); f.queue.status("p1", "done");
    expect(f.queue.next("p1")).toBe(second);
  });
});

describe("an owner counted per pane", () => {
  it("holds one message in each pane, so one pane's never fill the list for the others", () => {
    const store = new PendingInputs<string, null>(() => {}, Date.now, undefined, undefined, (owner) => owner === "bridge");
    const identity: PendingIdentity = { agent: "claude", terminalId: "t", session: null };
    for (let pane = 0; pane < MAX_PENDING_PER_OWNER + 8; pane++) store.enqueue("bridge", `p${pane}`, -1 - pane, "first", null, identity);
    expect(MAX_PENDING_PER_PANE).toBe(1);
    expect(() => store.enqueue("bridge", "p0", -999, "second", null, identity)).toThrow(PendingInputError);
    // a connection's own messages still count across panes (control)
    for (let id = 1; id <= MAX_PENDING_PER_OWNER; id++) store.enqueue("connection", `q${id}`, id, "mine", null, identity);
    expect(() => store.enqueue("connection", "q-more", 999, "mine", null, identity)).toThrow(PendingInputError);
  });
  it("holds one waiting message for an explicit send, with its reason", () => {
    const store = new PendingInputs<string, null>(() => {}, Date.now, undefined, undefined, () => true);
    const item = store.enqueue("bridge", "p", -1, "first", null, { agent: "claude", terminalId: "t", session: null });
    store.status("p", "idle");
    expect(store.next("p")).toBe(item); // control: a ready pane offers it
    store.holdItem(item, { code: "first_message_unattended", message: "gone" });
    expect(store.list("bridge", "p")).toEqual([expect.objectContaining({ state: "held", error: { code: "first_message_unattended", message: "gone" } })]);
    expect(store.next("p")).toBeNull();
  });
});

// #511: a saved copy's resend of a message accepted for an agent alone keeps that rule, whatever the copy says
describe("agent-only pending messages", () => {
  it("says which held message was accepted for an agent alone, on its own pane only", () => {
    let id = 0;
    const store = new PendingInputs<string, string>(() => {}, () => 0, 100, () => `pending-${++id}`);
    const identity = { agent: "claude", terminalId: "t1", session: null };
    const only = store.enqueue("a", "p", 1, "> quote\ncomment", "lease", identity, true, true);
    const plain = store.enqueue("a", "p", 2, "plain", "lease", identity, true);
    expect(only.message.agent_only).toBe(true);
    expect(store.agentOnly("p", only.message.id)).toBe(true);
    expect(store.agentOnly("other", only.message.id)).toBe(false);
    expect(store.agentOnly("p", plain.message.id)).toBe(false);
    expect(plain.message.agent_only).toBeUndefined();
  });
});
