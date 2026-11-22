import assert from "node:assert/strict";
import { it } from "bun:test";

it("the demo refuses draft clearing, drains accepted pending IDs once, and never resumes a lost owner lease", async () => {
  const saved = new Map(["setTimeout", "clearTimeout", "window", "location", "PushManager"].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const opened: any[] = [];
  try {
    const timers = new Map<number, { run: () => void; ms: number }>();
    let timerId = 1;
    globalThis.setTimeout = ((run: () => void, ms = 0) => { const id = timerId++; timers.set(id, { run, ms }); return id; }) as any;
    globalThis.clearTimeout = ((id: number) => { timers.delete(id); }) as any;
    const storage = new Map<string, string>();
    (globalThis as any).location = new URL("http://demo.test/demo/app/");
    (globalThis as any).window = {
      fetch, WebSocket, EventSource: class {},
      localStorage: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) },
    };
    await import("../site/demo/transport.ts");
    const demo = (globalThis as any).window;
    const runTimer = (ms: number) => {
      const [id, timer] = [...timers].find(([, timer]) => timer.ms === ms) ?? [];
      assert.ok(timer, "an expected completion timer was scheduled");
      timers.delete(id!);
      timer!.run();
    };
    const json = async (url: string) => (await demo.fetch(url)).json();
    const initial = (await json("/api/session")).snapshot;
    const codex = initial.panes.find((pane: any) => pane.agent === "codex").pane_id;
    const claude = initial.panes.find((pane: any) => pane.agent === "claude").pane_id;
    assert.deepEqual(initial.panes.find((pane: any) => pane.pane_id === claude).plan, { done: 1, total: 3, current: "Adding the replay metric" });
    const demoPlan = await json(`/api/pane/plan?pane_id=${claude}`);
    assert.deepEqual(demoPlan.plan.steps.map((step: any) => [step.label, step.status]), [
      ["Trace replayed requests", "completed"], ["Count idempotent replays", "in_progress"], ["Cover the metric with tests", "pending"],
    ]);
    assert.ok(Date.parse(demoPlan.server_time) > 0);
    assert.deepEqual((await json(`/api/pane/plan?pane_id=${codex}`)).plan, null);
    const transcript = () => json("/api/pane/conversation?pane_id=" + codex);
    const connect = () => {
      const socket = new demo.WebSocket("ws://demo.test/ws");
      const frames: any[] = [];
      opened.push(socket);
      socket.addEventListener("message", (event: MessageEvent) => frames.push(JSON.parse(String(event.data))));
      runTimer(20);
      assert.ok(frames.find((frame) => frame.type === "snapshot").features.includes("pending-input"));
      socket.send(JSON.stringify({ type: "attach", pane_id: codex }));
      let requestId = 1;
      const send = (pane: string, text: string, delivery?: unknown, typed?: unknown, reuseId?: number, clearDraft?: unknown) => {
        const id = reuseId ?? requestId++;
        socket.send(JSON.stringify({ type: "submit", id, pane_id: pane, text, payload: text, ...(delivery !== undefined ? { delivery } : {}), ...(typed !== undefined ? { typed } : {}), ...(clearDraft !== undefined ? { clear_draft: clearDraft } : {}) }));
        return frames.findLast((frame) => frame.type === "submit-result" && frame.id === id);
      };
      const action = (pendingId: string, action: string) => {
        const id = requestId++;
        socket.send(JSON.stringify({ type: "pending-action", id, pane_id: codex, pending_id: pendingId, action }));
        return frames.findLast((frame) => frame.type === "pending-result" && frame.id === id);
      };
      const pending = () => frames.findLast((frame) => frame.type === "pending-messages" && frame.pane_id === codex);
      return { socket, frames, send, action, pending };
    };
    const owner = connect();
    const retryPeer = connect();
    const resend = (peer: ReturnType<typeof connect>, id: number, generation: number, clearDraft?: string) => {
      peer.socket.send(JSON.stringify({ type: "submit", id, pane_id: codex, text: "retry demo copy", payload: "retry demo copy",
        resend_id: "demo-retry-copy", resend_generation: generation, ...(clearDraft ? { clear_draft: clearDraft } : {}) }));
      return peer.frames.findLast((frame) => frame.type === "submit-result" && frame.id === id);
    };
    assert.equal(resend(owner, 541, 0, "named draft").code, "unsupported");
    assert.equal(resend(retryPeer, 542, 0, "named draft").code, "unsupported");
    const claudeBefore = await json("/api/pane/conversation?pane_id=" + claude);
    for (const clear of ["", 1, null, true]) {
      assert.equal(owner.send(claude, "must stay here", undefined, undefined, undefined, clear).code, "invalid_delivery");
    }
    assert.equal(owner.send(claude, "must stay here", undefined, true, undefined, "named draft").code, "invalid_delivery");
    assert.equal(owner.send(claude, "must stay here", "queue", false, undefined, "named draft").code, "invalid_delivery");
    const refused = owner.send(claude, "must stay here", undefined, false, undefined, "named draft");
    assert.equal(refused.ok, false);
    assert.equal(refused.code, "unsupported");
    assert.equal(owner.send(claude, "must stay here", undefined, false, refused.id, "another draft").code, "invalid_submit_id");
    assert.deepEqual(await json("/api/pane/conversation?pane_id=" + claude), claudeBefore);
    const before = await transcript();
    assert.equal(owner.send(codex, "not an approval answer", "queue").code, "agent_blocked");
    assert.equal(owner.send(codex, "bad delivery", "Tab").code, "invalid_delivery");
    for (const typed of [true, 0, "", null]) assert.equal(owner.send(codex, "bad typed queue", "queue", typed).code, "invalid_delivery");
    for (const text of ["\t \r\n", "bad\u001b[201~", "bad\u0003", "bad\u0000"]) assert.equal(owner.send(codex, text, "queue").code, "invalid_submit_text");
    owner.socket.send(JSON.stringify({ type: "role", mode: "observe" }));
    assert.equal(owner.send(codex, "read only").code, "read_only");
    owner.socket.send(JSON.stringify({ type: "role", mode: "interact" }));
    assert.equal((await transcript()).turns.length, before.turns.length);

    owner.socket.send(JSON.stringify({ type: "attach", pane_id: claude }));
    const claudePending = owner.send(claude, "also run the tests", "queue").pending;
    assert.equal(claudePending.state, "queued");
    runTimer(4500);
    assert.equal((await json("/api/pane/conversation?pane_id=" + claude)).turns.at(-1).parts[0].text, "also run the tests");
    runTimer(2400);

    const prompt = (await json("/api/pane/prompt?pane_id=" + codex)).prompt;
    assert.equal((await demo.fetch("/api/pane/prompt/answer", { method: "POST", body: JSON.stringify({ pane_id: codex, prompt_id: prompt.id, option_index: 0 }) })).status, 200);
    runTimer(2600);
    assert.equal(resend(retryPeer, 543, 0).code, "unsupported");
    assert.equal(resend(owner, 544, 1).ok, true);
    assert.equal(resend(retryPeer, 545, 1).ok, true);
    assert.equal((await transcript()).turns.filter((turn: any) => turn.parts.some((part: any) => part.text === "retry demo copy")).length, 1);
    runTimer(2400);
    const start = (await transcript()).turns.length;
    assert.equal(owner.send(codex, "start current").ok, true);
    const steer = owner.send(codex, "steer current", "queue").pending;
    const fifo = owner.send(codex, "first next\r\n", "queue", false).pending;
    const discarded = owner.send(codex, "must not run", "queue").pending;
    assert.ok(steer.id && steer.request_id && steer.created_at);
    assert.equal(owner.pending().messages.length, 3);
    assert.equal(owner.send(codex, "first next\r\n", "queue", false, fifo.request_id).pending.id, fifo.id, "a duplicate accepted request has the same receipt");
    assert.equal(owner.pending().messages.length, 3, "duplicate request creates no extra pending message");
    assert.equal(owner.send(codex, "changed request body", "queue", false, fifo.request_id).code, "invalid_submit_id");
    assert.equal(owner.pending().messages.length, 3);
    assert.equal(owner.action(steer.id, "steer").ok, true);
    assert.equal(owner.action(discarded.id, "discard").ok, true);
    assert.deepEqual(owner.pending().messages.map((message: any) => message.id), [fifo.id]);
    assert.deepEqual((await transcript()).turns.slice(start).map((turn: any) => turn.parts[0].text), ["start current", "steer current"], "steering sends now while queued/discarded messages never became turns");

    const other = connect();
    assert.deepEqual(other.pending().messages, [], "pending messages are published only to their originating connection");
    assert.equal(other.action(fifo.id, "steer").code, "pending_not_found", "a different owner cannot promote a pending ID");
    const nextOwner = other.send(codex, "second next", "queue").pending;
    runTimer(2400);
    assert.equal((await transcript()).turns.at(-1).parts[0].text, "first next", "completion drains exactly the oldest message");
    assert.deepEqual(owner.pending().removed, [{ id: fifo.id, outcome: "sent" }]);
    assert.equal(owner.action(fifo.id, "steer").ok, true, "a late click gets the sent receipt instead of sending the item again");
    const replayed = owner.send(codex, "first next\r\n", "queue", false, fifo.request_id);
    assert.equal(replayed.ok, true);
    assert.equal(replayed.pending, undefined, "a duplicate submit after delivery cannot resurrect a queued row");
    const lost = owner.send(codex, "lost connection must not run", "queue").pending;
    owner.socket.close();
    runTimer(2400);
    assert.equal((await transcript()).turns.at(-1).parts[0].text, "second next", "only one next turn starts per completion");
    assert.deepEqual(other.pending().removed, [{ id: nextOwner.id, outcome: "sent" }]);
    runTimer(2400);
    const recovered = connect();
    assert.deepEqual(recovered.pending().messages, [], "a reconnect never re-arms the previous connection's pending queue");
    assert.equal(recovered.action(lost.id, "steer").code, "pending_not_found");
    assert.deepEqual((await transcript()).turns.slice(start).filter((turn: any) => turn.role === "user").map((turn: any) => turn.parts[0].text), ["start current", "steer current", "first next", "second next"]);

    assert.equal(other.send(codex, "observe current").ok, true);
    const held = other.send(codex, "held while observing", "queue").pending;
    other.socket.send(JSON.stringify({ type: "role", mode: "observe" }));
    assert.equal(other.pending().messages[0].state, "held");
    other.socket.send(JSON.stringify({ type: "role", mode: "interact" }));
    runTimer(2400);
    assert.notEqual((await transcript()).turns.at(-1).parts[0].text, "held while observing");
    assert.equal(other.action(held.id, "steer").ok, true, "only explicit owner action can send a held message");
    const detached = other.send(codex, "detached must not run", "queue").pending;
    other.socket.send(JSON.stringify({ type: "detach", pane_id: codex }));
    runTimer(2400);
    other.socket.send(JSON.stringify({ type: "attach", pane_id: codex }));
    assert.equal(other.pending().messages[0].state, "held");
    assert.equal(other.action(detached.id, "discard").ok, true);

    assert.equal(other.send(codex, "claim race current").ok, true);
    const race = other.send(codex, "closed claim must not run", "queue").pending;
    other.socket.addEventListener("message", (event: MessageEvent) => {
      const frame = JSON.parse(String(event.data));
      if (frame.type === "pending-messages" && frame.messages.some((message: any) => message.id === race.id && message.state === "sending")) other.socket.close();
    });
    runTimer(2400);
    const users = (await transcript()).turns.filter((turn: any) => turn.role === "user").map((turn: any) => turn.parts[0].text);
    for (const text of ["must not run", "lost connection must not run", "detached must not run", "closed claim must not run"]) assert.ok(!users.includes(text));
    const combinationPeer = connect();
    const combined = (id: number, sendAnyway: boolean) => {
      combinationPeer.socket.send(JSON.stringify({ type: "submit", id, pane_id: claude, text: "combined demo copy", payload: "combined demo copy",
        resend_id: "combined-demo-copy", ...(sendAnyway ? { send_anyway: true } : {}) }));
      return combinationPeer.frames.findLast((frame) => frame.type === "submit-result" && frame.id === id);
    };
    const combinationBefore = await json("/api/pane/conversation?pane_id=" + claude);
    assert.equal(combined(546, true).code, "invalid_delivery");
    assert.deepEqual(await json("/api/pane/conversation?pane_id=" + claude), combinationBefore);
    assert.equal(combined(547, false).ok, true, "rejection must not reserve the resend id");
    assert.equal(combined(548, true).code, "invalid_delivery", "a successful receipt must not bypass combination validation");
    combinationPeer.socket.send(JSON.stringify({ type: "submit", id: 550, pane_id: claude, text: "combined demo copy", payload: "combined demo copy",
      resend_id: "combined-demo-copy", clear_draft: "named draft" }));
    assert.equal(combinationPeer.frames.findLast((frame) => frame.type === "submit-result" && frame.id === 550).code, "unsupported",
      "a successful receipt must not bypass clear_draft validation");
    assert.equal(combined(549, false).ok, true);
    assert.equal((await json("/api/pane/conversation?pane_id=" + claude)).turns.filter((turn: any) => turn.parts.some((part: any) => part.text === "combined demo copy")).length, 1);
    // regression: as at the bridge, framing is checked before a held-copy receipt is replayed or reserved
    const framed = (id: number, payload: string, resendId: string) => {
      combinationPeer.socket.send(JSON.stringify({ type: "submit", id, pane_id: claude, text: "hello framing", payload, resend_id: resendId }));
      return combinationPeer.frames.findLast((frame) => frame.type === "submit-result" && frame.id === id);
    };
    const framedTurns = async () => (await json("/api/pane/conversation?pane_id=" + claude)).turns.filter((turn: any) => turn.parts.some((part: any) => part.text === "hello framing")).length;
    assert.equal(framed(551, "hello framing\r", "framing-repair").code, "invalid_submit_text");
    assert.equal(await framedTurns(), 0);
    assert.equal(framed(552, "hello framing", "framing-repair").ok, true, "a framing refusal must not reserve the resend id");
    assert.equal(framed(553, "hello framing", "framing-accepted").ok, true);
    assert.equal(framed(554, "hello framing\r", "framing-accepted").code, "invalid_submit_text", "a cached receipt must not bypass framing validation");
    assert.equal(await framedTurns(), 2);
    const equivalent = (id: number, text: string) => {
      combinationPeer.socket.send(JSON.stringify({ type: "submit", id, pane_id: claude, text, payload: "hello\rworld", resend_id: "canonical-id" }));
      return combinationPeer.frames.findLast((frame) => frame.type === "submit-result" && frame.id === id);
    };
    assert.equal(equivalent(555, "hello\r\nworld\n").ok, true);
    assert.equal(equivalent(556, "hello\nworld").ok, true, "a canonically equal resend must replay its receipt");
    assert.equal((await json("/api/pane/conversation?pane_id=" + claude)).turns.filter((turn: any) => turn.parts.some((part: any) => part.text === "hello\nworld")).length, 1);
  } finally {
    for (const socket of opened) socket.close();
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
