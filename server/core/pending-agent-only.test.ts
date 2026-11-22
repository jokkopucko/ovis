import { afterEach, expect, it, mock, spyOn } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as herdr from "../herdr/client.ts";
import * as processStart from "../process-start.ts";
import * as gjcRuntime from "../gjc-runtime.ts";
import * as omoModule from "../omo.ts";
import { connectionData } from "./connections.ts";
import { createPendingDelivery } from "./pending.ts";
import { GROK_QUEUED_MESSAGE, GROK_SEND_UNCONFIRMED_MESSAGE, grokQueuedBehindMessage } from "../../shared/submit-outcome.ts";
import { grokScreen } from "./grok-screen.fake.ts";

afterEach(() => mock.restore());

const COLLAPSED = "• WAITING\n• Queued follow-up inputs\n  ? 2 questions · 8s\n    alt+↑ to answer\n› Ask Codex to do anything\n  gpt-6.1 default · /workspace\n";
type Frame = { type: string; [key: string]: unknown };

function delivery(foreground: { pid: number; name: string; argv0?: string; argv?: string[] }, status: string, afterPaste?: string, agent = "codex") {
  const writes: string[] = [], frames: Frame[] = [], submitted: string[] = [];
  let screen = "› Ask Codex to do anything\n";
  const front = { now: foreground, next: [] as typeof foreground[] };
  const count = { reads: 0, atPaste: -1, atEnter: -1 };
  spyOn(herdr, "paneProcessInfo").mockImplementation(async () => {
    count.reads++;
    const shown = front.next.shift() ?? front.now;
    return { pane_id: "p", shell_pid: 41000, foreground_processes: [{ argv: [shown.name], ...shown }] } as Awaited<ReturnType<typeof herdr.paneProcessInfo>>;
  });
  spyOn(processStart, "processStartedAtAsync").mockResolvedValue(1000);
  spyOn(herdr, "paneRead").mockImplementation(async () => {
    const text = screen;
    hooks.read?.();
    return { text } as Awaited<ReturnType<typeof herdr.paneRead>>;
  });
  const hooks: { paste?: () => void; keys?: () => void; read?: () => void; submitText?: () => void } = {};
  spyOn(herdr, "paneSendText").mockImplementation(async (_pane, text) => { if (count.atPaste < 0) count.atPaste = count.reads; writes.push(text); hooks.paste?.(); if (afterPaste !== undefined) screen = afterPaste; });
  spyOn(herdr, "paneSendKeys").mockImplementation(async (_pane, keys) => { if (count.atEnter < 0) count.atEnter = count.reads; writes.push(keys.join(",")); hooks.keys?.(); });
  const owner = { data: connectionData({ deviceId: undefined, readOnly: false }), getBufferedAmount: () => 0, send: (value: string) => { frames.push(JSON.parse(value) as Frame); return 1; } };
  owner.data.attached.set("p", { keepSize: false });
  const pane = { pane_id: "p", terminal_id: "p", workspace_id: "w", tab_id: "t", agent, agent_status: status, focused: false, revision: 0 };
  const facts = { attached: true, origin: true, sameAttachment: true, samePty: true, sameClaim: true, claimed: true, member: true, ready: true, held: false, currentHeld: false, mirror: false, cols: 80 };
  let tail: Promise<unknown> = Promise.resolve();
  const serialize = <T,>(_pane: string, run: () => T | Promise<T>): Promise<T> => { const next = tail.catch(() => {}).then(run); tail = next; return next; };
  const pending = createPendingDelivery({
    options: { submitDelayMs: 0 }, clients: new Set([owner]), attachments: new Map(), sight: (() => ({ facts: () => facts, write: () => {} })), serialize,
    lastTyped: new Map(), submitText: async (_pane: string, text: string) => { submitted.push(text); hooks.submitText?.(); }, authorizeSocket: () => {},
    clientSnapshot: async () => ({ panes: [pane] }), omo: { sessionOf: () => null }, SUBMIT_DEADLINE_MS: 1000, SUBMIT_DELAY_MS: 0, TYPED_SETTLE_MS: 0,
  } as unknown as Parameters<typeof createPendingDelivery>[0]);
  const submit = (id: number, delivery: "immediate" | "queue" | "hold", text = "> backup.txt\nkeep it", extra: Record<string, unknown> = {}) => pending.pendingFrames.submit(owner as never,
    { type: "submit", id, pane_id: "p", text, payload: delivery === "immediate" ? "> backup.txt\rkeep it" : "unused", delivery, agent_only: true, ...extra } as never);
  const sendNow = (id: number, pendingId: string) => pending.pendingFrames["pending-action"](owner as never, { type: "pending-action", id, pane_id: "p", pending_id: pendingId, action: "steer" } as never);
  const result = (type: string, id: number) => frames.find((frame) => frame.type === type && frame.id === id);
  const setStatus = (next: string) => { pane.agent_status = next; pending.pending.status("p", next as never); pending.drainPending("p"); };
  return { writes, submitted, submit, sendNow, result, front, count, setStatus, hooks, pane, frames, screen: (text: string) => { screen = text; }, settled: () => tail };
}

// #511: herdr can keep naming an agent that has exited; the pane's own shell in front is no agent for a message
// whose `> quote` lines a shell would run as redirects
it.each(["immediate", "queue", "hold"] as const)("refuses an agent-only %s send while herdr names Codex but the shell is in front", async (kind) => {
  const d = delivery({ pid: 41000, name: "bash" }, "idle");
  await d.submit(1, kind);
  expect(d.result("submit-result", 1)).toMatchObject({ ok: false, code: "agent_not_ready" });
  expect(d.writes).toEqual([]);
  expect(d.submitted).toEqual([]);
});

it("holds back the Enter of an agent-only Send now when Codex's question queue collapses during its paste", async () => {
  const d = delivery({ pid: 41001, name: "codex" }, "idle", COLLAPSED);
  await d.submit(1, "hold");
  const held = d.result("submit-result", 1) as unknown as { pending: { id: string } };
  await d.sendNow(2, held.pending.id);
  expect(d.writes).toEqual(["\u001b[200~> backup.txt\nkeep it\u001b[201~"]);
  expect(d.result("pending-result", 2)).toMatchObject({ ok: false });
});

it("sends an agent-only Send now to Codex in front, paste and Enter (control)", async () => {
  const d = delivery({ pid: 41001, name: "codex" }, "idle");
  await d.submit(1, "hold");
  const held = d.result("submit-result", 1) as unknown as { pending: { id: string } };
  await d.sendNow(2, held.pending.id);
  expect(d.writes).toEqual(["\u001b[200~> backup.txt\nkeep it\u001b[201~", "Enter"]);
  expect(d.result("pending-result", 2)).toMatchObject({ ok: true });
});

function grokStandIn(d: ReturnType<typeof delivery>, options: { queued?: string[]; output?: string[]; minimal?: boolean; onQueued?: (state: StandInGrok) => void } = {}) {
  const state: StandInGrok = { output: options.output ?? ["word1 word2 word3"], card: false, prompt: "", queue: [...options.queued ?? []], sent: [] };
  const working = () => options.minimal === true || d.pane.agent_status === "working";
  let queuedOnce = false;
  const draw = () => d.screen(grokScreen({ ...state, status: working() ? "working" : d.pane.agent_status, minimal: options.minimal === true }));
  d.hooks.paste = () => { state.prompt = "> backup.txt\nkeep it"; draw(); };
  d.hooks.keys = () => {
    if (state.card) { state.card = false; state.sent.push("<card answered>"); }
    else if (state.prompt !== "") {
      if (working()) state.queue.push(state.prompt);
      else state.sent.push(state.prompt);
      state.prompt = "";
      if (!queuedOnce) { queuedOnce = true; options.onQueued?.(state); }
    } else {
      const top = state.queue.shift();
      if (top !== undefined) state.sent.push(top);
    }
    draw();
  };
  draw();
  return state;
}
type StandInGrok = { output: string[]; card: boolean; prompt: string; queue: string[]; sent: string[] };

const held = (d: ReturnType<typeof delivery>) => (d.result("submit-result", 1) as unknown as { pending: { id: string } }).pending.id;

it("sends a working Grok's Send now with the Enter that queues it and the Enter that sends that queue", async () => {
  const d = delivery({ pid: 41001, name: "grok" }, "working", undefined, "grok");
  const grok = grokStandIn(d);
  await d.submit(1, "hold");
  await d.sendNow(2, held(d));
  expect(d.writes).toEqual(["\u001b[200~> backup.txt\nkeep it\u001b[201~", "Enter", "Enter"]);
  expect(d.result("pending-result", 2)).toMatchObject({ ok: true });
  expect(grok.sent).toEqual(["> backup.txt\nkeep it"]);
});

it("presses nothing into Grok's approval card at Send now, the card in place of its prompt", async () => {
  const d = delivery({ pid: 41001, name: "grok" }, "working", undefined, "grok");
  const grok = grokStandIn(d, { onQueued: (state) => { state.card = true; } });
  await d.submit(1, "hold");
  await d.sendNow(2, held(d));
  expect(d.writes).toEqual(["\u001b[200~> backup.txt\nkeep it\u001b[201~", "Enter"]);
  expect(grok.sent).toEqual([]);
  expect(d.result("pending-result", 2)).toMatchObject({ ok: false, code: "submit_changed" });
});

it("presses nothing at Send now and leaves it unconfirmed when no queued row is drawn while herdr reports Grok working", async () => {
  const d = delivery({ pid: 41001, name: "grok" }, "working", undefined, "grok");
  const grok = grokStandIn(d, { output: ["#1 > backup.txt (+1 line)"], onQueued: (state) => { state.sent.push(state.queue.pop()!); } });
  await d.submit(1, "hold");
  await d.sendNow(2, held(d));
  expect(d.writes).toEqual(["\u001b[200~> backup.txt\nkeep it\u001b[201~", "Enter"]);
  expect(grok.sent).toEqual(["> backup.txt\nkeep it"]);
  expect(d.result("pending-result", 2)).toMatchObject({ ok: false, code: "submit_changed" });
});

it("presses nothing at Send now to a minimal-mode Grok, read as done while it works, and says the message is queued", async () => {
  const d = delivery({ pid: 41001, name: "grok" }, "done", undefined, "grok");
  const grok = grokStandIn(d, { minimal: true });
  await d.submit(1, "hold");
  await d.sendNow(2, held(d));
  expect(d.writes).toEqual(["\u001b[200~> backup.txt\nkeep it\u001b[201~", "Enter"]);
  expect(grok.queue).toEqual(["> backup.txt\nkeep it"]);
  expect(d.result("pending-result", 2)).toMatchObject({ ok: false, code: "submit_changed", message: GROK_QUEUED_MESSAGE });
});

it("presses nothing at Send now while Grok's prompt holds text typed in the terminal", async () => {
  const d = delivery({ pid: 41001, name: "grok" }, "working", undefined, "grok");
  const grok = grokStandIn(d, { onQueued: (state) => { state.prompt = "half-typed note to grok"; } });
  await d.submit(1, "hold");
  await d.sendNow(2, held(d));
  expect(d.writes).toEqual(["\u001b[200~> backup.txt\nkeep it\u001b[201~", "Enter"]);
  expect(grok.sent).toEqual([]);
  expect(grok.prompt).toBe("half-typed note to grok");
  expect(d.result("pending-result", 2)).toMatchObject({ ok: false, code: "submit_changed" });
});

it("presses nothing at Send now into Grok's approval card drawn right after the read the Enter was decided on", async () => {
  const d = delivery({ pid: 41001, name: "grok" }, "working", undefined, "grok");
  const card = readFileSync(join(import.meta.dir, "../../src/lib/fixtures-input-rows/grok-1.0.77/permission-119.txt"), "utf8");
  let reads = 0;
  const grok = grokStandIn(d, { onQueued: () => { d.hooks.read = () => { if (++reads < 2) return; d.hooks.read = undefined; d.screen(card); }; } });
  await d.submit(1, "hold");
  await d.sendNow(2, held(d));
  expect(d.writes).toEqual(["\u001b[200~> backup.txt\nkeep it\u001b[201~", "Enter"]);
  expect(grok.queue).toEqual(["> backup.txt\nkeep it"]);
  expect(d.result("pending-result", 2)).toMatchObject({ ok: false, code: "submit_changed", message: GROK_SEND_UNCONFIRMED_MESSAGE });
});

it("sends Send now with one more Enter when another client started Grok's turn after the read before its Enter", async () => {
  const d = delivery({ pid: 41001, name: "grok" }, "idle", undefined, "grok");
  const grok = grokStandIn(d);
  const keys = d.hooks.keys!;
  d.hooks.keys = () => { d.pane.agent_status = "working"; d.hooks.keys = keys; keys(); };
  await d.submit(1, "hold");
  await d.sendNow(2, held(d));
  expect(d.writes).toEqual(["\u001b[200~> backup.txt\nkeep it\u001b[201~", "Enter", "Enter"]);
  expect(grok.sent).toEqual(["> backup.txt\nkeep it"]);
  expect(d.result("pending-result", 2)).toMatchObject({ ok: true });
});

it("reports a working Grok's Send now as unconfirmed when the read after its queue Enter fails", async () => {
  const d = delivery({ pid: 41001, name: "grok" }, "working", undefined, "grok");
  d.hooks.keys = () => { d.pane.agent_status = "blocked"; };
  await d.submit(1, "hold");
  const held = d.result("submit-result", 1) as unknown as { pending: { id: string } };
  await d.sendNow(2, held.pending.id);
  expect(d.writes).toEqual(["\u001b[200~> backup.txt\nkeep it\u001b[201~", "Enter"]);
  expect(d.result("pending-result", 2)).toMatchObject({ ok: false, code: "submit_changed" });
  expect(JSON.stringify(d.result("pending-result", 2))).not.toContain("input line");
});

it("leaves a working Grok's Send now queued behind the rows the user queued before it, and says so", async () => {
  const d = delivery({ pid: 41001, name: "grok" }, "working", undefined, "grok");
  const grok = grokStandIn(d, { queued: ["row A", "row B"] });
  await d.submit(1, "hold");
  await d.sendNow(2, held(d));
  expect(d.writes).toEqual(["\u001b[200~> backup.txt\nkeep it\u001b[201~", "Enter"]);
  expect(grok.sent).toEqual([]);
  expect(grok.queue).toEqual(["row A", "row B", "> backup.txt\nkeep it"]);
  expect(d.result("pending-result", 2)).toMatchObject({ ok: false, code: "submit_changed", message: grokQueuedBehindMessage(2) });
});

it("types nothing for a second Send now of a row a working Grok kept in its queue", async () => {
  const d = delivery({ pid: 41001, name: "grok" }, "working", undefined, "grok");
  const grok = grokStandIn(d, { queued: ["row A"] });
  await d.submit(1, "hold");
  await d.sendNow(2, held(d));
  await d.sendNow(3, held(d));
  expect(d.writes).toEqual(["\u001b[200~> backup.txt\nkeep it\u001b[201~", "Enter"]);
  expect(grok.queue).toEqual(["row A", "> backup.txt\nkeep it"]);
  expect(d.result("pending-result", 3)).toMatchObject({ ok: false, code: "pending_uncertain" });
});

it("types nothing for a second Send now of a saved copy a working Grok kept in its queue", async () => {
  const d = delivery({ pid: 41001, name: "grok" }, "working", undefined, "grok");
  d.hooks.submitText = () => { throw new herdr.HerdrError("submit_changed", grokQueuedBehindMessage(1)); };
  await d.submit(1, "immediate", undefined, { resend_id: "copy-1", resend_generation: 0 });
  await d.submit(2, "immediate", undefined, { resend_id: "copy-1", resend_generation: 0 });
  expect(d.submitted).toHaveLength(1);
  expect(d.result("submit-result", 1)).toMatchObject({ ok: false, code: "submit_changed", message: grokQueuedBehindMessage(1) });
  expect(d.result("submit-result", 2)).toMatchObject({ ok: false, code: "pending_uncertain" });
});

it("sends an idle Grok's Send now with one Enter", async () => {
  const d = delivery({ pid: 41001, name: "grok" }, "idle", undefined, "grok");
  const grok = grokStandIn(d);
  await d.submit(1, "hold");
  await d.sendNow(2, held(d));
  expect(d.writes).toEqual(["\u001b[200~> backup.txt\nkeep it\u001b[201~", "Enter"]);
  expect(grok.sent).toEqual(["> backup.txt\nkeep it"]);
  expect(d.result("pending-result", 2)).toMatchObject({ ok: true });
});

it.each(["immediate", "queue", "hold"] as const)("refuses an agent-only %s send while herdr names Codex but a shell started since is in front", async (kind) => {
  const d = delivery({ pid: 41001, name: "bash" }, "idle");
  await d.submit(1, kind);
  expect(d.result("submit-result", 1)).toMatchObject({ ok: false, code: "agent_not_ready" });
  expect(d.writes).toEqual([]);
  expect(d.submitted).toEqual([]);
});

it("refuses Send now of an agent-only message once the Codex it was held for exec'd a shell at the same PID", async () => {
  const d = delivery({ pid: 41000, name: "codex" }, "idle");
  await d.submit(1, "hold");
  const held = d.result("submit-result", 1) as unknown as { pending: { id: string } };
  d.front.now = { pid: 41000, name: "bash" };
  await d.sendNow(2, held.pending.id);
  expect(d.result("pending-result", 2)).toMatchObject({ ok: false });
  expect(d.writes).toEqual([]);
});

it("judges the process by the last read: a shell that replaced Codex between two reads is no agent", async () => {
  const d = delivery({ pid: 41000, name: "bash" }, "idle");
  d.front.next = [{ pid: 41000, name: "codex" }];
  await d.submit(1, "hold");
  expect(d.result("submit-result", 1)).toMatchObject({ ok: false, code: "agent_not_ready" });
  expect(d.writes).toEqual([]);
});

// Windows names no foreground program, so which one takes the pane's input cannot be told: comments are refused there
it("refuses an agent-only message on Windows, even with Codex running under the pane's shell", async () => {
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
  spyOn(gjcRuntime, "recentProcessTable").mockResolvedValue([
    { pid: 41000, parent: 1, path: "C:\\Windows\\pwsh.exe", commandLine: "pwsh.exe" },
    { pid: 41002, parent: 41000, path: "C:\\tools\\codex.exe", commandLine: "codex.exe" },
  ]);
  try {
    const d = delivery({ pid: 41000, name: "pwsh.exe" }, "idle");
    for (const [id, kind] of [[1, "hold"], [2, "immediate"]] as const) {
      await d.submit(id, kind);
      expect(d.result("submit-result", id)).toMatchObject({ ok: false, code: "agent_not_ready" });
    }
    expect(d.writes).toEqual([]);
    expect(d.submitted).toEqual([]);
    // Codex as the pane's own process is no proof either: Windows says nothing of what takes the input
    mock.restore();
    const own = delivery({ pid: 41000, name: "codex.exe" }, "idle");
    await own.submit(3, "hold");
    expect(own.result("submit-result", 3)).toMatchObject({ ok: false, code: "agent_not_ready" });
  } finally {
    Object.defineProperty(process, "platform", platform);
  }
});

it("sends to Claude's native build, which titles its process by its version", async () => {
  const d = delivery({ pid: 41000, name: "2.1.302", argv0: "Claude", argv: ["Claude"] }, "idle", undefined, "claude");
  await d.submit(1, "hold");
  expect(d.result("submit-result", 1)).toMatchObject({ ok: true });
});

it("sends to Pi run from its npm entry", async () => {
  const d = delivery({ pid: 41001, name: "node", argv: ["node", "/usr/lib/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js"] }, "idle", undefined, "pi");
  await d.submit(1, "hold");
  expect(d.result("submit-result", 1)).toMatchObject({ ok: true });
});

it("takes no OmO holder record for an agent once a shell runs at its PID", async () => {
  spyOn(omoModule, "heldOmoProcess").mockResolvedValue({ pid: 41000, started: 1000 } as Awaited<ReturnType<typeof omoModule.heldOmoProcess>>);
  const d = delivery({ pid: 41000, name: "bash" }, "idle", undefined, "omo");
  await d.submit(1, "hold");
  expect(d.result("submit-result", 1)).toMatchObject({ ok: false, code: "agent_not_ready" });
});

it("types nothing when the last read before the paste finds a shell exec'd at Codex's PID", async () => {
  const control = delivery({ pid: 41001, name: "codex" }, "idle");
  await control.submit(1, "hold");
  const before = control.count.reads;
  await control.sendNow(2, (control.result("submit-result", 1) as unknown as { pending: { id: string } }).pending.id);
  const toPaste = control.count.atPaste - before;
  mock.restore();
  const d = delivery({ pid: 41001, name: "codex" }, "idle");
  await d.submit(1, "hold");
  const held = d.result("submit-result", 1) as unknown as { pending: { id: string } };
  d.front.next = [...Array.from({ length: toPaste - 1 }, () => ({ pid: 41001, name: "codex" })), { pid: 41001, name: "bash" }];
  await d.sendNow(2, held.pending.id);
  expect(d.writes).toEqual([]);
  expect(d.result("pending-result", 2)).toMatchObject({ ok: false });
});

async function replacedBeforeEnter(after: { pid: number; name: string }, from: number) {
  const control = delivery({ pid: 41001, name: "codex" }, "idle");
  await control.submit(1, "hold");
  const start = control.count.reads;
  await control.sendNow(2, (control.result("submit-result", 1) as unknown as { pending: { id: string } }).pending.id);
  const reads = control.count.atEnter - start;
  mock.restore();
  const d = delivery({ pid: 41001, name: "codex" }, "idle");
  await d.submit(1, "hold");
  const held = d.result("submit-result", 1) as unknown as { pending: { id: string } };
  d.front.next = Array.from({ length: reads - from }, () => ({ pid: 41001, name: "codex" }));
  d.front.now = after;
  await d.sendNow(2, held.pending.id);
  return { writes: d.writes, answer: d.result("pending-result", 2) };
}

it("holds back the Enter when the last read before it finds a shell exec'd at Codex's PID", async () => {
  const { writes, answer } = await replacedBeforeEnter({ pid: 41001, name: "bash" }, 1);
  expect(writes).toEqual(["\u001b[200~> backup.txt\nkeep it\u001b[201~"]);
  expect(answer).toMatchObject({ ok: false, code: "pasted_not_sent" });
});

it("holds back the Enter when Codex's PID runs another program after the paste", async () => {
  const { writes, answer } = await replacedBeforeEnter({ pid: 41001, name: "python3" }, 3);
  expect(writes).toEqual(["\u001b[200~> backup.txt\nkeep it\u001b[201~"]);
  expect(answer).toMatchObject({ ok: false, code: "pasted_not_sent" });
});

it.each(["ash", "python3", "some-tool"])("holds back the Enter when the last read before it finds %s at Codex's PID", async (program) => {
  const { writes, answer } = await replacedBeforeEnter({ pid: 41001, name: program }, 1);
  expect(writes).toEqual(["\u001b[200~> backup.txt\nkeep it\u001b[201~"]);
  expect(answer).toMatchObject({ ok: false, code: "pasted_not_sent" });
});

it("types nothing at Send now when Codex's PID already runs another program", async () => {
  const d = delivery({ pid: 41001, name: "codex" }, "idle");
  await d.submit(1, "hold");
  const held = d.result("submit-result", 1) as unknown as { pending: { id: string } };
  d.front.now = { pid: 41001, name: "python3" };
  await d.sendNow(2, held.pending.id);
  expect(d.writes).toEqual([]);
  expect(d.result("pending-result", 2)).toMatchObject({ ok: false, code: "agent_not_ready" });
});

it("never pastes a queued agent-only message again once an approval refused its Enter after the paste", async () => {
  const d = delivery({ pid: 41001, name: "codex" }, "working");
  await d.submit(1, "queue");
  d.hooks.paste = () => { d.pane.agent_status = "blocked"; };
  d.setStatus("idle");
  for (let turn = 0; turn < 8; turn++) { await d.settled(); await new Promise(setImmediate); }
  expect(d.writes).toEqual(["\u001b[200~> backup.txt\nkeep it\u001b[201~"]);
  d.hooks.paste = undefined;
  d.setStatus("working");
  d.setStatus("idle");
  for (let turn = 0; turn < 8; turn++) { await d.settled(); await new Promise(setImmediate); }
  expect(d.writes).toEqual(["\u001b[200~> backup.txt\nkeep it\u001b[201~"]);
});

const queueOf = (frames: Frame[]) => (frames.filter((frame) => frame.type === "pending-messages").at(-1)?.messages ?? []) as { text: string; state: string; error?: { code: string } }[];

it("sends no later queued message while an earlier one's paste was left in the input line", async () => {
  const d = delivery({ pid: 41001, name: "codex" }, "working");
  await d.submit(1, "queue");
  await d.submit(2, "queue", "> second\nnext");
  d.hooks.paste = () => { d.pane.agent_status = "blocked"; };
  d.setStatus("idle");
  for (let turn = 0; turn < 8; turn++) { await d.settled(); await new Promise(setImmediate); }
  d.hooks.paste = undefined;
  d.setStatus("working");
  d.setStatus("idle");
  for (let turn = 0; turn < 8; turn++) { await d.settled(); await new Promise(setImmediate); }
  expect(d.writes).toEqual(["\u001b[200~> backup.txt\nkeep it\u001b[201~"]);
  expect(queueOf(d.frames).map((message) => [message.state, message.error?.code ?? null])).toEqual([["uncertain", "pasted_not_sent"], ["held", "pending_held"]]);
});

it("reports a paste left behind when the agent starts working before its Enter", async () => {
  const d = delivery({ pid: 41001, name: "codex" }, "working");
  await d.submit(1, "queue");
  d.hooks.paste = () => { d.pane.agent_status = "working"; };
  d.setStatus("idle");
  for (let turn = 0; turn < 8; turn++) { await d.settled(); await new Promise(setImmediate); }
  expect(d.writes).toEqual(["\u001b[200~> backup.txt\nkeep it\u001b[201~"]);
  expect(queueOf(d.frames).map((message) => [message.state, message.error?.code ?? null])).toEqual([["uncertain", "pasted_not_sent"]]);
});
