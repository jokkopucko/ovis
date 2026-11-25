import { afterAll, afterEach, expect, it, mock, spyOn } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ServerMessage, SessionSnapshot } from "../../shared/protocol.ts";
import * as claudeStore from "../claude-store.ts";
import * as herdr from "../herdr/client.ts";
import * as pi from "../pi.ts";
import type { SightingFacts } from "../input-guard.ts";
import { connectionData, type Client } from "./connections.ts";
import { createPendingDelivery } from "./pending.ts";
import { PendingInputError } from "../pending-input.ts";
import { isDshProcess } from "../dsh.ts";
import { SHELL_AGENTS } from "../shell-agent.ts";
import type { TerminalSighting } from "./terminals.ts";

const roots: string[] = [];
const paths = new Map<string, string>();
const originalProcessInfo = herdr.paneProcessInfo;
const { paneSendText, paneSendKeys, paneRead } = herdr;
const originalTranscriptPath = pi.piTranscriptPath;
let lookup: { at: "identity" | "transcript"; entered: () => void; release: Promise<void> } | null = null;
type Processes = { shell_pid: number; foreground_processes: { pid: number; name: string; argv0?: string; argv?: string[] }[] };
const processes = new Map<string, Processes>();
const calls: string[] = [];
mock.module("../herdr/client.ts", () => ({
  ...herdr,
  paneProcessInfo: async (paneId: string) => {
    if (paneId === "p" && lookup?.at === "identity") {
      const held = lookup; lookup = null;
      held.entered(); await held.release;
    }
    return processes.get(paneId) ?? { foreground_processes: [], shell_pid: null };
  },
  paneSendText: async (...args: Parameters<typeof paneSendText>) => {
    if (!processes.has(args[0])) return paneSendText(...args);
    calls.push(`text ${args[0]}`);
  },
  paneSendKeys: async (...args: Parameters<typeof paneSendKeys>) => {
    if (!processes.has(args[0])) return paneSendKeys(...args);
    calls.push(`keys ${args[0]}`);
  },
  paneRead: async (...args: Parameters<typeof paneRead>) => {
    if (!processes.has(args[0].paneId)) return paneRead(...args);
    calls.push(`read ${args[0].paneId}`);
    throw new Error("no herdr answers here");
  },
}));
mock.module("../pi.ts", () => ({
  ...pi,
  piTranscriptPath: async (paneId: string) => {
    if (paneId === "p" && lookup?.at === "transcript") {
      const held = lookup; lookup = null;
      held.entered(); await held.release;
    }
    return { path: paths.get(paneId)! };
  },
}));
afterEach(() => { lookup = null; paths.clear(); processes.clear(); calls.length = 0; for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
afterAll(() => {
  mock.module("../herdr/client.ts", () => ({ ...herdr, paneProcessInfo: originalProcessInfo, paneSendText, paneSendKeys, paneRead }));
  mock.module("../pi.ts", () => ({ ...pi, piTranscriptPath: originalTranscriptPath }));
});

it.each(["delivery first", "withdrawal first", "ambiguous delivery first", "ambiguous plain discard"] as const)("serializes held-copy resend and Edit against one disposition: %s", async (order) => {
  const ambiguous = order.startsWith("ambiguous");
  const frames = new Map<Client, ServerMessage[]>(), clients = new Set<Client>();
  const client = (): Client => {
    const output: ServerMessage[] = [];
    const owner = { data: connectionData({ deviceId: "device", readOnly: false }), getBufferedAmount: () => 0,
      send: (value: string) => { output.push(JSON.parse(value)); return 1; } } as Client;
    clients.add(owner); frames.set(owner, output); return owner;
  };
  const first = client(), second = client(), typed: string[] = [];
  let queue = Promise.resolve<unknown>(undefined);
  const serialize = <T>(_pane: string, task: () => T | Promise<T>): Promise<T> => {
    const next = queue.catch(() => {}).then(task); queue = next; return next;
  };
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const delivery = createPendingDelivery({
    options: {}, clients, attachments: new Map(), serialize, lastTyped: new Map(),
    sight: () => { throw new Error("withdrawal takes no input lease"); },
    submitText: async (_pane, text) => {
      entered.resolve(); await release.promise; typed.push(text);
      if (ambiguous) throw new herdr.HerdrError("submit_changed", "Enter may have reached the terminal");
    },
    authorizeSocket: () => {},
    clientSnapshot: async () => ({ panes: [{ pane_id: "p", terminal_id: "p", agent: null, agent_status: "idle" }] }) as SessionSnapshot,
    omo: { sessionOf: () => null }, SUBMIT_DEADLINE_MS: 45_000, SUBMIT_DELAY_MS: 0, TYPED_SETTLE_MS: 0,
  });
  const item = delivery.pending.enqueue(first, "p", 1, "held text", null, { agent: "claude", terminalId: "p", session: null }, true);
  const resend = () => delivery.pendingFrames.submit(second, {
    type: "submit", id: 2, pane_id: "p", text: item.message.text, payload: item.message.text, delivery: "immediate", resend_id: item.message.id,
  });
  const edit = () => delivery.pendingFrames["pending-action"](first, {
    type: "pending-action", id: 3, pane_id: "p", pending_id: item.message.id, action: "discard",
    ...(order !== "ambiguous plain discard" ? { withdrawal_only: true as const } : {}),
  });
  if (order !== "withdrawal first") {
    const sending = resend();
    await entered.promise;
    const editing = edit();
    release.resolve();
    await Promise.all([sending, editing]);
  } else {
    await edit();
    release.resolve();
    await resend();
  }
  const removals = frames.get(first)!.flatMap((frame) => frame.type === "pending-messages" ? frame.removed ?? [] : []);
  if (ambiguous) {
    expect(removals.some((receipt) => receipt.outcome === "discarded" || receipt.outcome === "sent")).toBe(false);
    expect(frames.get(first)!.flatMap((frame) => frame.type === "pending-messages" ? frame.messages : []))
      .toContainEqual(expect.objectContaining({ id: item.message.id, state: "uncertain", error: expect.objectContaining({ code: "submit_changed" }) }));
  } else {
    expect(removals.length).toBeGreaterThan(0);
    expect(removals.every((receipt) => receipt.id === item.message.id && receipt.outcome === (order === "delivery first" ? "sent" : "discarded"))).toBe(true);
  }
  expect(typed).toEqual(order !== "withdrawal first" ? ["held text"] : []);
  expect(frames.get(second)!.find((frame) => frame.type === "submit-result" && frame.id === 2)).toMatchObject({ ok: order === "delivery first" });
  if (order === "ambiguous delivery first") {
    expect(removals).toEqual([]);
    expect(delivery.pending.list(first, "p")).toMatchObject([{ id: item.message.id, state: "uncertain" }]);
    expect(frames.get(first)!.find((frame) => frame.type === "pending-result" && frame.id === 3)).toMatchObject({ ok: false, code: "pending_uncertain" });
  } else {
    expect(delivery.pending.list(first, "p")).toEqual([]);
    if (ambiguous) expect(removals).toEqual([{ id: item.message.id, outcome: "dismissed" }]);
  }
});

it.each(["same browser", "no device", "wrong browser", "wrong device", "read-only", "revoked", "no resume id", "expired", "uncertain",
  "settled after reattach", "late wrong browser", "late wrong device", "late read-only", "late revoked"] as const)(
  "replays a follow-up's exact receipt only to the browser that sent it (#2421): %s", (name) => {
    const late = name === "settled after reattach" || name.startsWith("late ");
    const scenario = name.replace(/^late /, "");
    let now = Date.now();
    const clock = clocks(() => now);
    try {
      const token = crypto.randomUUID(), frames = new Map<Client, ServerMessage[]>(), clients = new Set<Client>(), revoked = new Set<Client>();
      const client = (deviceId: string | undefined, receiptResumeId: string | undefined, readOnly = false): Client => {
        const output: ServerMessage[] = [];
        const owner = { data: connectionData({ deviceId, readOnly }), getBufferedAmount: () => 0,
          send: (value: string) => { output.push(JSON.parse(value)); return 1; } } as Client;
        owner.data.attached.set("p", { keepSize: false, receiptResumeId });
        clients.add(owner); frames.set(owner, output); return owner;
      };
      const device = scenario === "no device" ? undefined : "device";
      const first = client(device, scenario === "no resume id" ? undefined : token);
      const delivery = createPendingDelivery({
        options: {}, clients, attachments: new Map(), serialize: async (_pane, task) => task(), lastTyped: new Map(),
        sight: () => { throw new Error("a receipt replay takes no input lease"); },
        submitText: async () => { throw new Error("a receipt replay never types"); },
        authorizeSocket: (owner) => { if (revoked.has(owner)) throw new Error("revoked"); },
        clientSnapshot: async () => ({ panes: [] }) as unknown as SessionSnapshot,
        omo: { sessionOf: () => null }, SUBMIT_DEADLINE_MS: 45_000, SUBMIT_DELAY_MS: 0, TYPED_SETTLE_MS: 0,
      });
      const item = delivery.pending.enqueue(first, "p", 1, "follow-up", null, { agent: "codex", terminalId: "p", session: null });
      expect(delivery.pending.claim(item, false)).toBe(true);
      if (scenario === "uncertain") delivery.pending.settle(item, { code: "submit_changed", message: "Enter was not confirmed" }, true);
      else if (!late) delivery.pending.settle(item);
      clients.delete(first); delivery.closeConnection(first);
      if (scenario === "uncertain") { now += 60_001; delivery.pending.expire(); }
      if (scenario === "expired") now += 10 * 60 * 1000 + 1;
      const resumed = client(scenario === "wrong device" ? "other" : device, scenario === "wrong browser" ? crypto.randomUUID() : token, scenario === "read-only");
      if (scenario === "revoked") revoked.add(resumed);
      delivery.attached(resumed, "p");
      if (late) delivery.pending.settle(item);
      const removed = frames.get(resumed)!.flatMap((frame) => frame.type === "pending-messages" ? frame.removed ?? [] : []);
      expect(removed).toEqual(["same browser", "no device", "settled after reattach"].includes(scenario) ? [{ id: item.message.id, outcome: "sent", resumed: true }] : []);
    } finally { clock.mockRestore(); }
  });

function clocks(wall: () => number, run: () => number = wall): { mockRestore: () => void } {
  const date = spyOn(Date, "now").mockImplementation(wall), elapsed = spyOn(performance, "now").mockImplementation(run);
  return { mockRestore: () => { date.mockRestore(); elapsed.mockRestore(); } };
}

function heldCopyBridge(submit: (text: string) => Promise<void> = async () => {}, sight: () => TerminalSighting = () => { throw new Error("a receipt replay takes no input lease"); }) {
  const token = crypto.randomUUID(), frames = new Map<Client, ServerMessage[]>(), clients = new Set<Client>();
  const tab = (...panes: string[]): Client => {
    const output: ServerMessage[] = [];
    const owner = { data: connectionData({ deviceId: "device", readOnly: false }), getBufferedAmount: () => 0,
      send: (value: string) => { output.push(JSON.parse(value)); return 1; } } as Client;
    for (const pane of panes.length ? panes : ["p"]) owner.data.attached.set(pane, { keepSize: false, receiptResumeId: token });
    clients.add(owner); frames.set(owner, output); return owner;
  };
  const turns = new Map<string, Promise<void>>();
  const typed: string[] = [];
  const delivery = createPendingDelivery({
    options: {}, clients, attachments: new Map(), serialize: (pane, task) => { const run = (turns.get(pane) ?? Promise.resolve()).then(task); turns.set(pane, run.then(() => {}, () => {})); return run; }, lastTyped: new Map(),
    sight,
    submitText: async (pane: string, text: string) => { await submit(text); typed.push(pane); },
    authorizeSocket: () => {},
    clientSnapshot: async () => ({ panes: ["p", "q"].map((pane) => ({ pane_id: pane, terminal_id: pane, agent: "codex", agent_status: "idle" })) }) as SessionSnapshot,
    omo: { sessionOf: () => null }, SUBMIT_DEADLINE_MS: 45_000, SUBMIT_DELAY_MS: 0, TYPED_SETTLE_MS: 0,
  });
  const identity = { agent: "codex", terminalId: "p", session: null };
  const told = (to: Client) => frames.get(to)!.filter((frame) => frame.type === "pending-messages");
  return {
    tab, typed, delivery, identity, clients,
    heldIds: (to: Client): string[] => told(to).flatMap((frame) => frame.type === "pending-messages" ? frame.held ?? [] : []),
    removed: (to: Client) => told(to).flatMap((frame) => frame.type === "pending-messages" ? frame.removed ?? [] : []),
    answer: (to: Client, id: number) => frames.get(to)!.find((frame) => frame.type === "submit-result" && frame.id === id),
    resend: (to: Client, id: number, pending: string, pane = "p", generation?: number) => delivery.pendingFrames.submit(to, { type: "submit", id, pane_id: pane, text: "follow-up", payload: "follow-up", delivery: "immediate", resend_id: pending,
      ...(generation !== undefined ? { resend_generation: generation } : {}) }),
    heldAsItsConnectionClosed: () => {
      const first = tab();
      const item = delivery.pending.enqueue(first, "p", 1, "follow-up", null, identity);
      clients.delete(first); delivery.closeConnection(first);
      return item.message.id;
    },
  };
}

it.each(["same draft", "bridge", "edited draft", "legacy frame", "different device", "different browser", "different pane", "no device", "no correlator", "expired"] as const)(
  "answers a lost submit reply without repeating the command: %s", async (scenario) => {
    const typed: string[] = [];
    let now = 0;
    const clock = spyOn(performance, "now").mockImplementation(() => now);
    try {
      const bridge = heldCopyBridge(async (text) => { typed.push(text); });
      const first = bridge.tab(), command = crypto.randomUUID();
      const submit = (to: Client, id: number, text: string, key: string, pane = "p") => bridge.delivery.pendingFrames.submit(to, {
        type: "submit", pane_id: pane, id, text, payload: text, ...(scenario === "legacy frame" ? {} : { command_key: key }),
      });
      first.send = () => 1; // drop the result after the server writes it
      if (scenario === "bridge" || scenario === "no device") delete first.data.deviceId;
      if (scenario === "bridge") first.data.bridge = true;
      if (scenario === "no correlator") first.data.attached.set("p", { keepSize: false });
      await submit(first, 1, "echo once", command);
      bridge.clients.delete(first);
      bridge.delivery.closeConnection(first);
      const next = bridge.tab("p", "q");
      if (scenario === "bridge" || scenario === "no device") delete next.data.deviceId;
      if (scenario === "bridge") next.data.bridge = true;
      if (scenario === "no correlator") next.data.attached.set("p", { keepSize: false });
      if (scenario === "different device") next.data.deviceId = "another-device";
      if (scenario === "different browser") next.data.attached.set("p", { keepSize: false, receiptResumeId: crypto.randomUUID() });
      if (scenario === "expired") now += 10 * 60_000 + 1;
      const text = scenario === "edited draft" ? "echo edited" : "echo once";
      await submit(next, 2, text, scenario === "edited draft" ? crypto.randomUUID() : command, scenario === "different pane" ? "q" : "p");
      expect(typed).toEqual(scenario === "same draft" || scenario === "bridge" ? ["echo once"] : ["echo once", text]);
      expect(bridge.answer(next, 2)).toMatchObject({ ok: true });
    } finally { clock.mockRestore(); }
  });

it("replays a held draft's acceptance, not its input or its lease, when the retry asks for immediate delivery", async () => {
  const screen = spyOn(herdr, "paneRead").mockResolvedValue({ format: "text", source: "detection", pane_id: "p", tab_id: "t", workspace_id: "w", revision: 1, text: "", truncated: false });
  try {
    const bridge = heldCopyBridge(undefined, () => ({ origin: null, pty: null, claim: null, facts: () => READY, write: () => { throw new Error("unexpected write"); } }));
    const first = bridge.tab();
    first.send = () => 1;
    const frame = { type: "submit" as const, command_key: crypto.randomUUID(), pane_id: "p", text: "for later", payload: "for later" };
    await bridge.delivery.pendingFrames.submit(first, { ...frame, id: 1, delivery: "hold" });
    const [accepted] = bridge.delivery.pending.list(first, "p");
    expect(accepted).toMatchObject({ text: "for later", state: "held" });
    bridge.clients.delete(first);
    bridge.delivery.closeConnection(first);
    const next = bridge.tab();
    await bridge.delivery.pendingFrames.submit(next, { ...frame, id: 2 });
    expect(bridge.typed).toEqual([]);
    expect(bridge.delivery.pending.list(next, "p")).toEqual([]);
    expect(bridge.answer(next, 2)).toMatchObject({ ok: true, replayed: true, pending: { id: accepted!.id, text: frame.text, state: "held" } });
  } finally { screen.mockRestore(); }
});

it("retries the same command after a transient identity lookup failed before the first write", async () => {
  const bridge = heldCopyBridge();
  const frame = { type: "submit" as const, command_key: crypto.randomUUID(), pane_id: "p", text: "continue", payload: "continue" };
  const first = bridge.tab();
  const lookup = spyOn(herdr, "paneProcessInfo").mockRejectedValueOnce(new Error("identity temporarily unavailable"));
  try {
    await bridge.delivery.pendingFrames.submit(first, { ...frame, id: 1 });
    expect(bridge.answer(first, 1)).toMatchObject({ ok: false, code: "submit_failed" });
    expect(bridge.typed).toEqual([]);
  } finally { lookup.mockRestore(); }
  bridge.clients.delete(first);
  bridge.delivery.closeConnection(first);
  const next = bridge.tab();
  await bridge.delivery.pendingFrames.submit(next, { ...frame, id: 2 });
  expect(bridge.typed).toEqual(["p"]);
  expect(bridge.answer(next, 2)).toMatchObject({ ok: true });
});

it("replays the uncertain result after a queued draft was pasted but lost its connection before Enter", async () => {
  const bridge = heldCopyBridge(undefined, () => ({ origin: null, pty: null, claim: null, facts: () => READY, write: () => {} }));
  const first = bridge.tab(), writes: string[] = [];
  const screen = spyOn(herdr, "paneRead").mockResolvedValue({ format: "text", source: "detection", pane_id: "p", tab_id: "t", workspace_id: "w", revision: 1, text: "› ", truncated: false });
  const paste = spyOn(herdr, "paneSendText").mockImplementation(async () => {
    writes.push("paste");
    bridge.clients.delete(first);
  });
  const enter = spyOn(herdr, "paneSendKeys").mockImplementation(async () => { writes.push("Enter"); });
  try {
    const frame = { type: "submit" as const, command_key: crypto.randomUUID(), pane_id: "p", text: "continue", payload: "continue", delivery: "queue" as const };
    await bridge.delivery.pendingFrames.submit(first, { ...frame, id: 1 });
    expect(bridge.answer(first, 1)).toMatchObject({ ok: false, code: "submit_changed" });
    bridge.delivery.closeConnection(first);
    const next = bridge.tab();
    await bridge.delivery.pendingFrames.submit(next, { ...frame, id: 2 });
    expect(writes).toEqual(["paste"]);
    expect(bridge.answer(next, 2)).toMatchObject({ ok: false, code: "submit_changed" });
  } finally { screen.mockRestore(); paste.mockRestore(); enter.mockRestore(); }
});

it.each(["before attach", "managed bridge"])("deduplicates two explicit sends %s", async (scenario) => {
  const bridge = heldCopyBridge(), first = bridge.tab(), next = bridge.tab();
  const browser = first.data.attached.get("p")!.receiptResumeId!;
  for (const owner of [first, next]) {
    if (scenario === "before attach") {
      owner.data.commandBrowser = browser;
      owner.data.attached.clear();
    } else {
      delete owner.data.deviceId;
      owner.data.managedReceipts = true;
    }
  }
  const frame = { type: "submit" as const, command_key: crypto.randomUUID(), pane_id: "p", text: "continue", payload: "continue" };
  await bridge.delivery.pendingFrames.submit(first, { ...frame, id: 1 });
  bridge.clients.delete(first);
  bridge.delivery.closeConnection(first);
  await bridge.delivery.pendingFrames.submit(next, { ...frame, id: 2 });
  expect(bridge.typed).toEqual(["p"]);
  expect(bridge.answer(next, 2)).toMatchObject({ ok: true, replayed: true });
});

it("does not execute an unscoped pre-attach command on an older gateway", async () => {
  const bridge = heldCopyBridge(), client = bridge.tab();
  client.data.attached.clear();
  const frame = { type: "submit" as const, command_key: crypto.randomUUID(), pane_id: "p", text: "continue", payload: "continue" };
  await bridge.delivery.pendingFrames.submit(client, { ...frame, id: 1 });
  expect(bridge.answer(client, 1)).toMatchObject({ ok: false, code: "input_not_ready" });
  expect(bridge.typed).toEqual([]);
  client.data.attached.set("p", { keepSize: false, receiptResumeId: crypto.randomUUID() });
  await bridge.delivery.pendingFrames.submit(client, { ...frame, id: 2 });
  expect(bridge.typed).toEqual(["p"]);
});

it("carries a pane's receipts to its new ID when herdr moves it: the sent one still stops a second tab, a held one still proves a reload", async () => {
  let now = Date.now();
  const clock = clocks(() => now);
  try {
    const bridge = heldCopyBridge();
    const id = bridge.heldAsItsConnectionClosed();
    const one = bridge.tab(), other = bridge.tab();
    bridge.delivery.attached(one, "p"); bridge.delivery.attached(other, "p");
    const unsentOwner = bridge.tab();
    const unsent = bridge.delivery.pending.enqueue(unsentOwner, "p", 7, "left for later", null, bridge.identity).message.id;
    bridge.clients.delete(unsentOwner); bridge.delivery.closeConnection(unsentOwner);
    now += 60_001; bridge.delivery.pending.expire();
    await bridge.resend(one, 2, id);
    expect(bridge.typed).toEqual(["p"]);
    bridge.delivery.movePendingPane("p", "q");
    now += 60_001; bridge.delivery.pending.expire();
    const moved = bridge.tab("q");
    bridge.delivery.attached(moved, "q");
    expect(bridge.removed(moved).filter((entry) => entry.id === id)).toEqual([{ id, outcome: "sent", resumed: true }]);
    await bridge.resend(moved, 3, id, "q");
    expect(bridge.typed).toEqual(["p"]);
    expect(bridge.answer(moved, 3)).toMatchObject({ ok: true });
    expect(bridge.heldIds(moved)).toEqual([unsent]);
  } finally { clock.mockRestore(); }
});

function gatedSend(end: () => void = () => {}) {
  let begin!: () => void, finish!: () => void;
  const started = new Promise<void>((resolve) => { begin = resolve; }), gate = new Promise<void>((resolve) => { finish = resolve; });
  let first = true;
  return { started, finish, submit: async () => { if (first) { first = false; begin(); await gate; } end(); } };
}

for (const outcome of ["sent", "uncertain", "not typed"] as const) {
  it(`claims a held copy before its Send now types it, and a pane herdr moves meanwhile takes the claim along (${outcome})`, async () => {
    let now = Date.now();
    const clock = clocks(() => now);
    try {
      let fail: string | null = outcome === "sent" ? null : outcome === "uncertain" ? "submit_changed" : "agent_not_ready";
      const send = gatedSend(() => { if (fail !== null) throw new herdr.HerdrError(fail, "refused"); });
      const bridge = heldCopyBridge(send.submit);
      const id = bridge.heldAsItsConnectionClosed();
      const one = bridge.tab(), other = bridge.tab();
      bridge.delivery.attached(one, "p"); bridge.delivery.attached(other, "p");
      now += 60_001; bridge.delivery.pending.expire();
      const going = bridge.resend(one, 2, id);
      await send.started;
      bridge.delivery.movePendingPane("p", "q");
      const moved = bridge.tab("q");
      bridge.delivery.attached(moved, "q");
      await bridge.resend(moved, 3, id, "q", 1);
      expect(bridge.answer(moved, 3)).toMatchObject({ ok: false, code: "pending_busy" });
      send.finish();
      await going;
      expect(bridge.typed).toEqual(outcome === "sent" ? ["p"] : []);
      now += 60_001; bridge.delivery.pending.expire();
      const late = bridge.tab("q");
      bridge.delivery.attached(late, "q");
      if (outcome === "sent") {
        expect(bridge.removed(moved).filter((entry) => entry.id === id)).toEqual([{ id, outcome: "sent", resumed: true }]);
        expect(bridge.removed(late).filter((entry) => entry.id === id)).toEqual([{ id, outcome: "sent", resumed: true }]);
        await bridge.resend(late, 4, id, "q", 1);
        expect(bridge.answer(late, 4)).toMatchObject({ ok: true });
        expect(bridge.typed).toEqual(["p"]);
      } else if (outcome === "uncertain") {
        expect([bridge.removed(late).filter((entry) => entry.id === id), bridge.heldIds(late)]).toEqual([[], []]);
        fail = null;
        await bridge.resend(late, 4, id, "q", 1);
        expect(bridge.answer(late, 4)).toMatchObject({ ok: false, code: "pending_uncertain" });
        expect(bridge.typed).toEqual([]);
      } else {
        expect(bridge.heldIds(late)).toEqual([id]);
        fail = null;
        await bridge.resend(late, 4, id, "q", 1);
        expect(bridge.answer(late, 4)).toMatchObject({ ok: true });
        expect(bridge.typed).toEqual(["q"]);
      }
    } finally { clock.mockRestore(); }
  });
}

it("keeps the note of a Send now that may have typed the copy when its owner's record ages out: a second tab is still refused past a thousand other receipts", async () => {
  let now = Date.now();
  const clock = clocks(() => now);
  try {
    let fail = true;
    const bridge = heldCopyBridge(async () => { if (fail) throw new herdr.HerdrError("submit_changed", "Enter was not confirmed"); });
    const id = bridge.heldAsItsConnectionClosed();
    const one = bridge.tab(), other = bridge.tab();
    bridge.delivery.attached(one, "p"); bridge.delivery.attached(other, "p");
    now += 2_000;
    await bridge.resend(one, 2, id);
    expect(bridge.answer(one, 2)).toMatchObject({ ok: false, code: "submit_changed" });
    fail = false;
    now += 60_001; bridge.delivery.pending.expire();
    const busy = bridge.tab();
    for (let n = 0; n < 1100; n++) {
      if (n > 0 && n % 400 === 0) { now += 60_001; bridge.delivery.pending.expire(); }
      expect(bridge.delivery.pending.discard(bridge.delivery.pending.enqueue(busy, "p", 10 + n, `other ${n}`, null, bridge.identity))).toBe(true);
    }
    now += 60_001; bridge.delivery.pending.expire();
    await bridge.resend(other, 3, id);
    expect(bridge.answer(other, 3)).toMatchObject({ ok: false, code: "pending_uncertain" });
    expect(bridge.typed).toEqual([]);
  } finally { clock.mockRestore(); }
});

it("gives no held receipt of a pane that ended to the pane that has its ID next", async () => {
  let now = Date.now();
  const clock = clocks(() => now);
  try {
    const bridge = heldCopyBridge();
    const ended = { code: "pane_not_found", message: "The pane ended; its pending messages were not sent" };
    const before = bridge.heldAsItsConnectionClosed();
    const live = bridge.tab();
    const after = bridge.delivery.pending.enqueue(live, "p", 5, "held by request", null, bridge.identity, true).message.id;
    now += 30_000;
    bridge.delivery.holdPendingPane("p", ended);
    bridge.delivery.pending.forget("p");
    bridge.clients.delete(live); bridge.delivery.closeConnection(live);
    now += 120_000; bridge.delivery.pending.expire();
    const reused = bridge.tab();
    bridge.delivery.attached(reused, "p");
    expect(bridge.heldIds(reused)).toEqual([]);
    expect(bridge.removed(reused).filter((entry) => entry.id === before || entry.id === after)).toEqual([]);
    const fresh = bridge.heldAsItsConnectionClosed();
    const again = bridge.tab();
    bridge.delivery.attached(again, "p");
    expect(bridge.heldIds(again)).toEqual([fresh]);
  } finally { clock.mockRestore(); }
});

it("remembers a Send now that may have typed the copy for its ten minutes: a second tab's still-proven copy is refused, also past a thousand other receipts", async () => {
  let now = Date.now();
  const clock = clocks(() => now);
  try {
    let fail = true;
    const bridge = heldCopyBridge(async () => { if (fail) throw new herdr.HerdrError("submit_changed", "Enter was not confirmed"); });
    const id = bridge.heldAsItsConnectionClosed();
    const one = bridge.tab(), other = bridge.tab();
    bridge.delivery.attached(one, "p"); bridge.delivery.attached(other, "p");
    now += 60_001; bridge.delivery.pending.expire();
    await bridge.resend(one, 2, id);
    expect(bridge.answer(one, 2)).toMatchObject({ ok: false, code: "submit_changed" });
    fail = false;
    now += 60_001; bridge.delivery.pending.expire();
    const busy = bridge.tab();
    for (let n = 0; n < 1100; n++) {
      if (n > 0 && n % 400 === 0) { now += 60_001; bridge.delivery.pending.expire(); }
      expect(bridge.delivery.pending.discard(bridge.delivery.pending.enqueue(busy, "p", 10 + n, `other ${n}`, null, bridge.identity))).toBe(true);
    }
    await bridge.resend(other, 3, id);
    expect(bridge.answer(other, 3)).toMatchObject({ ok: false, code: "pending_uncertain" });
    expect(bridge.typed).toEqual([]);
    const late = bridge.tab();
    bridge.delivery.attached(late, "p");
    expect([bridge.removed(late).filter((entry) => entry.id === id), bridge.heldIds(late)]).toEqual([[], []]);
  } finally { clock.mockRestore(); }
});

it("counts only held and discarded receipts against the limit: under a thousand live sent ones a new held receipt still proves a reload, and a discarded one is still told", async () => {
  let now = Date.now();
  const clock = clocks(() => now);
  try {
    const bridge = heldCopyBridge();
    const sender = bridge.tab();
    for (let n = 0; n < 1100; n++) {
      if (n > 0 && n % 400 === 0) { now += 60_001; bridge.delivery.pending.expire(); }
      const item = bridge.delivery.pending.enqueue(sender, "p", 10 + n, `sent ${n}`, null, bridge.identity);
      expect(bridge.delivery.pending.claim(item, false)).toBe(true);
      bridge.delivery.pending.settle(item);
    }
    const id = bridge.heldAsItsConnectionClosed();
    const discarder = bridge.tab();
    const dropped = bridge.delivery.pending.enqueue(discarder, "p", 2, "not after all", null, bridge.identity);
    expect(bridge.delivery.pending.discard(dropped)).toBe(true);
    bridge.clients.delete(discarder); bridge.delivery.closeConnection(discarder);
    now += 5_000;
    const reload = bridge.tab();
    bridge.delivery.attached(reload, "p");
    expect(bridge.heldIds(reload)).toEqual([id]);
    expect(bridge.removed(reload).filter((entry) => entry.id === dropped.message.id)).toEqual([{ id: dropped.message.id, outcome: "discarded", resumed: true }]);
  } finally { clock.mockRestore(); }
});

it("times a sent receipt by the time that passed, not by the PC's clock: a clock set forward does not end it before the other tab's proof", async () => {
  let wall = Date.now(), run = 1_000_000;
  const clock = clocks(() => wall, () => run);
  try {
    const bridge = heldCopyBridge();
    const id = bridge.heldAsItsConnectionClosed();
    const one = bridge.tab(), other = bridge.tab();
    bridge.delivery.attached(one, "p"); bridge.delivery.attached(other, "p");
    expect(bridge.heldIds(other)).toEqual([id]);
    wall += 60_001; run += 60_001; bridge.delivery.pending.expire();
    await bridge.resend(one, 2, id);
    expect(bridge.typed).toEqual(["p"]);
    wall += 10 * 60 * 1000 + 120_000; run += 120_000; bridge.delivery.pending.expire();
    const late = bridge.tab();
    bridge.delivery.attached(late, "p");
    await bridge.resend(other, 3, id);
    expect(bridge.typed).toEqual(["p"]);
    expect(bridge.removed(late).filter((entry) => entry.id === id)).toEqual([{ id, outcome: "sent", resumed: true }]);
  } finally { clock.mockRestore(); }
});

it("keeps a held copy's sent receipt through a thousand other receipts, so a second tab's still-proven copy is not typed again", async () => {
  let now = Date.now();
  const clock = clocks(() => now);
  try {
    const token = crypto.randomUUID(), frames = new Map<Client, ServerMessage[]>(), clients = new Set<Client>();
    const client = (): Client => {
      const output: ServerMessage[] = [];
      const owner = { data: connectionData({ deviceId: "device", readOnly: false }), getBufferedAmount: () => 0,
        send: (value: string) => { output.push(JSON.parse(value)); return 1; } } as Client;
      owner.data.attached.set("p", { keepSize: false, receiptResumeId: token });
      clients.add(owner); frames.set(owner, output); return owner;
    };
    let turns: Promise<void> = Promise.resolve();
    let typed = 0;
    const delivery = createPendingDelivery({
      options: {}, clients, attachments: new Map(), serialize: (_pane, task) => { const run = turns.then(task); turns = run.then(() => {}, () => {}); return run; }, lastTyped: new Map(),
      sight: () => { throw new Error("a receipt replay takes no input lease"); },
      submitText: async () => { typed++; },
      authorizeSocket: () => {},
      clientSnapshot: async () => ({ panes: [{ pane_id: "p", terminal_id: "p", agent: "codex", agent_status: "idle" }] }) as SessionSnapshot,
      omo: { sessionOf: () => null }, SUBMIT_DEADLINE_MS: 45_000, SUBMIT_DELAY_MS: 0, TYPED_SETTLE_MS: 0,
    });
    const identity = { agent: "codex", terminalId: "p", session: null };
    const heldIds = (to: Client): string[] => frames.get(to)!.flatMap((frame) => frame.type === "pending-messages" ? frame.held ?? [] : []);
    const resend = (to: Client, id: number, pending: string) => delivery.pendingFrames.submit(to, { type: "submit", id, pane_id: "p", text: "follow-up", payload: "follow-up", delivery: "immediate", resend_id: pending });
    const first = client();
    const item = delivery.pending.enqueue(first, "p", 1, "follow-up", null, identity);
    clients.delete(first); delivery.closeConnection(first);
    const one = client(), other = client();
    delivery.attached(one, "p"); delivery.attached(other, "p");
    expect([heldIds(one), heldIds(other)]).toEqual([[item.message.id], [item.message.id]]);
    now += 60_001; delivery.pending.expire();
    await resend(one, 2, item.message.id);
    expect(typed).toBe(1);
    const busy = client();
    for (let n = 0; n < 1100; n++) {
      if (n > 0 && n % 400 === 0) { now += 60_001; delivery.pending.expire(); }
      expect(delivery.pending.discard(delivery.pending.enqueue(busy, "p", 10 + n, `other ${n}`, null, identity))).toBe(true);
    }
    now += 60_001; delivery.pending.expire();
    expect(now - Date.parse(item.message.created_at)).toBeLessThan(10 * 60 * 1000);
    await resend(other, 3, item.message.id);
    expect(typed).toBe(1);
    expect(frames.get(other)!.filter((frame) => frame.type === "submit-result" && frame.id === 3)).toMatchObject([{ ok: true }]);
    const late = client();
    delivery.attached(late, "p");
    expect(frames.get(late)!.flatMap((frame) => frame.type === "pending-messages" ? frame.removed ?? [] : []).filter((entry) => entry.id === item.message.id))
      .toEqual([{ id: item.message.id, outcome: "sent", resumed: true }]);
  } finally { clock.mockRestore(); }
});

it.each(["read-only", "revoked"] as const)(
  "a connection that may not resume when it closes leaves no held receipt, and still the sent receipt of a send that ends after the close: %s", (why) => {
    const token = crypto.randomUUID(), frames = new Map<Client, ServerMessage[]>(), clients = new Set<Client>(), revoked = new Set<Client>();
    const client = (readOnly = false): Client => {
      const output: ServerMessage[] = [];
      const owner = { data: connectionData({ deviceId: "device", readOnly }), getBufferedAmount: () => 0,
        send: (value: string) => { output.push(JSON.parse(value)); return 1; } } as Client;
      owner.data.attached.set("p", { keepSize: false, receiptResumeId: token });
      clients.add(owner); frames.set(owner, output); return owner;
    };
    const first = client();
    const delivery = createPendingDelivery({
      options: {}, clients, attachments: new Map(), serialize: async (_pane, task) => task(), lastTyped: new Map(),
      sight: () => { throw new Error("a receipt replay takes no input lease"); },
      submitText: async () => { throw new Error("a receipt replay never types"); },
      authorizeSocket: (owner) => { if (revoked.has(owner) || owner.data.readOnly) throw new Error(why); },
      clientSnapshot: async () => ({ panes: [] }) as unknown as SessionSnapshot,
      omo: { sessionOf: () => null }, SUBMIT_DEADLINE_MS: 45_000, SUBMIT_DELAY_MS: 0, TYPED_SETTLE_MS: 0,
    });
    const identity = { agent: "codex", terminalId: "p", session: null };
    const going = delivery.pending.enqueue(first, "p", 1, "on its way", null, identity);
    const held = delivery.pending.enqueue(first, "p", 2, "held", null, identity, true);
    expect(delivery.pending.claim(going, false)).toBe(true);
    if (why === "revoked") revoked.add(first); else first.data.readOnly = true;
    clients.delete(first); delivery.closeConnection(first);
    delivery.pending.settle(going);
    const resumed = client();
    delivery.attached(resumed, "p");
    const told = frames.get(resumed)!.filter((frame) => frame.type === "pending-messages");
    expect(told.flatMap((frame) => frame.type === "pending-messages" ? frame.removed ?? [] : [])).toEqual([{ id: going.message.id, outcome: "sent", resumed: true }]);
    expect(told.some((frame) => "held" in frame && (frame.held as string[]).includes(held.message.id))).toBe(false);
  });

it.each(["held on close", "overlapping reload", "held after reattach", "wrong browser", "wrong device", "read-only", "revoked", "owner revoked", "expired", "resent after closed-owner expiry", "ambiguous resend after closed-owner expiry", "attach during resend after closed-owner expiry", "replayed resend after its record expired", "concurrent resends after closed-owner expiry", "resend to another pane", "resend refused at its limit", "live owner's sibling tab", "held before close"] as const)(
  "replays a held follow-up receipt only while it remains unsent and held: %s", async (scenario) => {
    let now = Date.now();
    const clock = clocks(() => now);
    try {
      const token = crypto.randomUUID(), frames = new Map<Client, ServerMessage[]>(), clients = new Set<Client>(), revoked = new Set<Client>();
      const client = (deviceId: string | undefined, receiptResumeId: string | undefined, readOnly = false): Client => {
        const output: ServerMessage[] = [];
        const owner = { data: connectionData({ deviceId, readOnly }), getBufferedAmount: () => 0,
          send: (value: string) => { output.push(JSON.parse(value)); return 1; } } as Client;
        owner.data.attached.set("p", { keepSize: false, receiptResumeId });
        clients.add(owner); frames.set(owner, output); return owner;
      };
      const first = client("device", token);
      let failResend = false;
      let turns: Promise<void> = Promise.resolve();
      const typing = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
      let typed = 0;
      const delivery = createPendingDelivery({
        options: {}, clients, attachments: new Map(), serialize: (_pane, task) => { const run = turns.then(task); turns = run.then(() => {}, () => {}); return run; }, lastTyped: new Map(),
        sight: () => { throw new Error("a receipt replay takes no input lease"); },
        submitText: async () => {
          if (scenario === "attach during resend after closed-owner expiry") { typing.resolve(); await release.promise; }
          if (failResend) throw new herdr.HerdrError("submit_changed", "Enter was not confirmed");
          typed++;
        },
        authorizeSocket: (owner) => { if (revoked.has(owner)) throw new Error("revoked"); },
        clientSnapshot: async () => ({ panes: [{ pane_id: "p", terminal_id: "p", agent: "codex", agent_status: "idle" }, { pane_id: "q", terminal_id: "q", agent: "codex", agent_status: "idle" }] }) as SessionSnapshot,
        omo: { sessionOf: () => null }, SUBMIT_DEADLINE_MS: 45_000, SUBMIT_DELAY_MS: 0, TYPED_SETTLE_MS: 0,
      });
      const heldIds = (to: Client): string[] => frames.get(to)!.flatMap((frame) => frame.type === "pending-messages" ? frame.held ?? [] : []);
      const item = delivery.pending.enqueue(first, "p", 1, "follow-up", null, { agent: "codex", terminalId: "p", session: null }, scenario === "live owner's sibling tab" || scenario === "held before close");
      if (scenario === "live owner's sibling tab") {
        const sibling = client("device", token);
        delivery.attached(sibling, "p");
        expect(item.message.state).toBe("held");
        expect(frames.get(sibling)!.some((frame) => frame.type === "pending-messages"
          && (frame.held?.includes(item.message.id) || frame.removed?.some((entry) => entry.id === item.message.id)))).toBe(false);
        return;
      }
      if (scenario === "held after reattach") expect(delivery.pending.claim(item, false)).toBe(true);
      if (scenario === "owner revoked") revoked.add(first);
      const overlap = scenario === "overlapping reload" ? client("device", token) : undefined;
      if (overlap) delivery.attached(overlap, "p");
      clients.delete(first); delivery.closeConnection(first);
      if (scenario === "expired") now += 10 * 60 * 1000 + 1;
      const resumed = overlap ?? client(scenario === "wrong device" ? "other" : "device", scenario === "wrong browser" ? crypto.randomUUID() : token, scenario === "read-only");
      if (scenario === "revoked") revoked.add(resumed);
      if (!overlap) delivery.attached(resumed, "p");
      if (scenario === "held after reattach") delivery.pending.settle(item, { code: "disconnected", message: "The pending message's connection closed" }, false);
      expect(frames.get(resumed)!.flatMap((frame) => frame.type === "pending-messages" ? frame.removed ?? [] : [])).toEqual([]);
      for (const id of heldIds(resumed)) expect(frames.get(resumed)!.some((frame) => frame.type === "pending-messages" && frame.held_ms?.[id] === 10 * 60 * 1000)).toBe(true);
      expect(heldIds(resumed)).toEqual(["held on close", "held before close", "overlapping reload", "held after reattach", "resent after closed-owner expiry", "ambiguous resend after closed-owner expiry", "attach during resend after closed-owner expiry", "replayed resend after its record expired",
        "concurrent resends after closed-owner expiry", "resend to another pane", "resend refused at its limit"].includes(scenario)
        ? [item.message.id] : []);
      if (scenario === "resend refused at its limit") {
        now += 60_001; delivery.pending.expire();
        const refuse = spyOn(delivery.pending, "resend").mockImplementation(() => { throw new PendingInputError("pending_limit", "Too many held-copy sends are still retained; try again later"); });
        try {
          await delivery.pendingFrames.submit(resumed, { type: "submit", id: 2, pane_id: "p", text: "follow-up", payload: "follow-up", delivery: "immediate", resend_id: item.message.id });
        } finally { refuse.mockRestore(); }
        expect(typed).toBe(0);
        const back = client("device", token);
        delivery.attached(back, "p");
        expect(heldIds(back)).toEqual([item.message.id]);
        return;
      }
      if (scenario === "concurrent resends after closed-owner expiry") {
        now += 60_001; delivery.pending.expire();
        const frame = (id: number, resend_generation: number) => ({ type: "submit" as const, id, pane_id: "p", text: "follow-up", payload: "follow-up", delivery: "immediate" as const, resend_id: item.message.id, resend_generation });
        await Promise.all([delivery.pendingFrames.submit(resumed, frame(2, 0)), delivery.pendingFrames.submit(resumed, frame(3, 1))]);
        expect(typed).toBe(1);
        const results = frames.get(resumed)!.filter((frame) => frame.type === "submit-result" && (frame.id === 2 || frame.id === 3));
        expect(results.filter((frame) => frame.type === "submit-result" && frame.typed_now === true)).toHaveLength(1);
        return;
      }
      if (scenario === "resend to another pane") {
        now += 60_001; delivery.pending.expire();
        resumed.data.attached.set("q", { keepSize: false, receiptResumeId: token });
        await delivery.pendingFrames.submit(resumed, { type: "submit", id: 2, pane_id: "q", text: "follow-up", payload: "follow-up", delivery: "immediate", resend_id: item.message.id });
        const back = client("device", token);
        delivery.attached(back, "p");
        expect(heldIds(back)).toEqual([item.message.id]);
        await delivery.pendingFrames.submit(back, { type: "submit", id: 3, pane_id: "p", text: "follow-up", payload: "follow-up", delivery: "immediate", resend_id: item.message.id });
        const typedBefore = typed;
        now += 60_001; delivery.pending.expire();
        await delivery.pendingFrames.submit(back, { type: "submit", id: 4, pane_id: "p", text: "follow-up", payload: "follow-up", delivery: "immediate", resend_id: item.message.id });
        expect(typed).toBe(typedBefore);
        return;
      }
      if (scenario === "resent after closed-owner expiry" || scenario === "ambiguous resend after closed-owner expiry" || scenario === "attach during resend after closed-owner expiry" || scenario === "replayed resend after its record expired") {
        now += 60_001; delivery.pending.expire();
        failResend = scenario === "ambiguous resend after closed-owner expiry";
        const sent = delivery.pendingFrames.submit(resumed, {
          type: "submit", id: 2, pane_id: "p", text: "follow-up", payload: "follow-up", delivery: "immediate", resend_id: item.message.id,
        });
        if (scenario === "attach during resend after closed-owner expiry") {
          await typing.promise;
          const during = client("device", token);
          delivery.attached(during, "p");
          expect(heldIds(during)).toEqual([]);
          release.resolve();
        }
        await sent;
        if (scenario === "replayed resend after its record expired") {
          expect(typed).toBe(1);
          now += 60_001; delivery.pending.expire();
          await delivery.pendingFrames.submit(resumed, {
            type: "submit", id: 2, pane_id: "p", text: "follow-up", payload: "follow-up", delivery: "immediate", resend_id: item.message.id,
          });
          expect(typed).toBe(1);
          await delivery.pendingFrames.submit(resumed, {
            type: "submit", id: 3, pane_id: "p", text: "edited", payload: "edited", delivery: "immediate", resend_id: item.message.id,
          });
          expect(typed).toBe(2);
        }
        const later = client("device", token);
        delivery.attached(later, "p");
        const laterRemoved = frames.get(later)!.flatMap((frame) => frame.type === "pending-messages" ? frame.removed ?? [] : []);
        expect(laterRemoved).toEqual(failResend ? [] : [{ id: item.message.id, outcome: "sent", resumed: true }]);
        expect(heldIds(later)).toEqual([]);
      }
    } finally { clock.mockRestore(); }
  });

it("keeps a held receipt's ten-minute expiry after a resend that typed nothing puts it back", async () => {
  let now = Date.now();
  const clock = clocks(() => now);
  try {
    const token = crypto.randomUUID(), frames = new Map<Client, ServerMessage[]>(), clients = new Set<Client>();
    const client = (): Client => {
      const output: ServerMessage[] = [];
      const owner = { data: connectionData({ deviceId: "device", readOnly: false }), getBufferedAmount: () => 0,
        send: (value: string) => { output.push(JSON.parse(value)); return 1; } } as Client;
      owner.data.attached.set("p", { keepSize: false, receiptResumeId: token });
      clients.add(owner); frames.set(owner, output); return owner;
    };
    const delivery = createPendingDelivery({
      options: {}, clients, attachments: new Map(), serialize: async (_pane, task) => task(), lastTyped: new Map(),
      sight: () => { throw new Error("a receipt replay takes no input lease"); },
      submitText: async () => { throw new herdr.HerdrError("agent_not_ready", "not ready"); },
      authorizeSocket: () => {},
      clientSnapshot: async () => ({ panes: [{ pane_id: "p", terminal_id: "p", agent: "codex", agent_status: "idle" }] }) as SessionSnapshot,
      omo: { sessionOf: () => null }, SUBMIT_DEADLINE_MS: 45_000, SUBMIT_DELAY_MS: 0, TYPED_SETTLE_MS: 0,
    });
    const heldIds = (to: Client): string[] => frames.get(to)!.flatMap((frame) => frame.type === "pending-messages" ? frame.held ?? [] : []);
    const identity = { agent: "codex", terminalId: "p", session: null } as const;
    const first = client(), older = delivery.pending.enqueue(first, "p", 1, "older", null, identity, false);
    clients.delete(first); delivery.closeConnection(first);
    now += 5 * 60 * 1000;
    const second = client(), newer = delivery.pending.enqueue(second, "p", 1, "newer", null, identity, false);
    clients.delete(second); delivery.closeConnection(second);
    now += 60_001; delivery.pending.expire();
    const resumed = client();
    delivery.attached(resumed, "p");
    await delivery.pendingFrames.submit(resumed, {
      type: "submit", id: 2, pane_id: "p", text: "older", payload: "older", delivery: "immediate", resend_id: older.message.id,
    });
    now += 5 * 60 * 1000;
    const later = client();
    delivery.attached(later, "p");
    expect(heldIds(later)).toEqual([newer.message.id]);
  } finally { clock.mockRestore(); }
});

it.each(["before close", "after close", "overlapping reload", "same live browser", "no device", "read-only", "detach", "wrong browser", "wrong device", "revoked", "expired", "pending cap", "completed cap", "confirmation budget"] as const)(
  "resumes only exact, authorized Pi presentation receipts: %s", async (when) => {
    const root = mkdtempSync(join(tmpdir(), "ovis-pi-resume-")); roots.push(root);
    const path = join(root, "session.jsonl"); paths.set("p", path);
    writeFileSync(path, JSON.stringify({ type: "session", version: 3, id: "session" }) + "\n"
      + JSON.stringify({ type: "message", id: "base", parentId: null, message: { role: "assistant", content: [] } }) + "\n");
    const token = crypto.randomUUID(), frames = new Map<Client, ServerMessage[]>(), clients = new Set<Client>();
    const client = (deviceId: string | undefined = when === "no device" ? undefined : "device", receiptResumeId: string = token, readOnly = false): Client => {
      const output: ServerMessage[] = [];
      const owner = { data: connectionData({ deviceId, readOnly }), getBufferedAmount: () => 0,
        send: (value: string) => { output.push(JSON.parse(value)); return 1; } } as Client;
      owner.data.attached.set("p", { keepSize: false, receiptResumeId });
      clients.add(owner); frames.set(owner, output); return owner;
    };
    const first = client(), typed: string[] = [], revoked = new Set<Client>();
    let queue = Promise.resolve<unknown>(undefined);
    const serialize = <T>(_pane: string, task: () => T | Promise<T>): Promise<T> => {
      const next = queue.catch(() => {}).then(task); queue = next; return next;
    };
    const delivery = createPendingDelivery({
      options: { piReceiptLimit: 1 }, clients, attachments: new Map(), serialize, lastTyped: new Map(),
      sight: () => { throw new Error("presentation never takes an input lease"); },
      submitText: async (_pane, text) => { typed.push(text); },
      authorizeSocket: (owner) => { if (revoked.has(owner)) throw new Error("revoked"); },
      clientSnapshot: async () => ({ panes: [{ pane_id: "p", terminal_id: "p", agent: "pi", agent_status: "idle" }] }) as SessionSnapshot,
      omo: { sessionOf: () => null }, SUBMIT_DEADLINE_MS: 45_000, SUBMIT_DELAY_MS: 0, TYPED_SETTLE_MS: 0,
    });
    await delivery.pendingFrames.submit(first, { type: "submit", id: 1, pane_id: "p", text: "same", payload: "same", delivery: "immediate" });
    await serialize("p", () => {});
    const sent = frames.get(first)!.flatMap((frame) => frame.type === "pending-messages" ? frame.messages : [])
      .find((message) => message.error?.code === "pi_transcript_pending")!;
    expect(sent).toBeDefined();
    if (when === "confirmation budget") {
      appendFileSync(path, "x".repeat(16 * 1024 * 1024 + 1));
      await delivery.reconcilePiDeliveries("p");
      expect(frames.get(first)!.flatMap((frame) => frame.type === "pending-messages" ? frame.messages : [])
        .some((message) => message.id === sent.id && message.error?.code === "transcript_unconfirmed")).toBe(true);
      appendFileSync(path, "\n" + JSON.stringify({ type: "message", id: "new-base", parentId: "base", message: { role: "assistant", content: [] } }) + "\n");
      await delivery.pendingFrames.submit(first, { type: "submit", id: 2, pane_id: "p", text: "released", payload: "released", delivery: "immediate" });
      expect(frames.get(first)!.find((frame) => frame.type === "submit-result" && frame.id === 2)).toMatchObject({ ok: true });
      await serialize("p", () => {});
      await delivery.reconcilePiDeliveries("p");
      await delivery.pendingFrames["pending-action"](first, { type: "pending-action", id: 3, pane_id: "p", pending_id: sent.id, action: "discard" });
      expect(frames.get(first)!.find((frame) => frame.type === "pending-result" && frame.id === 3)).toMatchObject({ ok: true });
      await delivery.pendingFrames.submit(first, { type: "submit", id: 4, pane_id: "p", text: "still full", payload: "still full", delivery: "immediate" });
      expect(frames.get(first)!.find((frame) => frame.type === "submit-result" && frame.id === 4)).toMatchObject({ ok: false, code: "pending_limit" });
      expect(typed).toEqual(["same", "released"]);
      return;
    }
    const append = () => appendFileSync(path, JSON.stringify({ type: "message", id: "ours", parentId: "base",
      message: { role: "user", content: [{ type: "text", text: "same" }] } }) + "\n");
    if (when === "pending cap") {
      let lastToken = "";
      for (let index = 0; index < 1025; index++) {
        lastToken = crypto.randomUUID();
        const owner = client("device", lastToken);
        await delivery.pendingFrames.submit(owner, { type: "submit", id: index + 10, pane_id: "p", text: "waiting", payload: "waiting", delivery: "immediate" });
        await serialize("p", () => {});
        clients.delete(owner); delivery.closeConnection(owner);
      }
      const dropped = client("device", lastToken);
      delivery.attached(dropped, "p");
      await serialize("p", () => {});
      expect(frames.get(dropped)!.filter((frame) => frame.type === "pending-messages")).toEqual([]);
      expect(typed).toHaveLength(1026);
      return;
    }
    if (when === "completed cap") {
      append(); await delivery.reconcilePiDeliveries("p");
      let parent = "ours", lastId = "";
      for (let index = 0; index < 1025; index++) {
        await delivery.pendingFrames.submit(first, { type: "submit", id: index + 10, pane_id: "p", text: `turn-${index}`, payload: `turn-${index}`, delivery: "immediate" });
        await serialize("p", () => {});
        lastId = `entry-${index}`;
        appendFileSync(path, JSON.stringify({ type: "message", id: lastId, parentId: parent, message: { role: "user", content: [{ type: "text", text: `turn-${index}` }] } }) + "\n");
        parent = lastId;
        await delivery.reconcilePiDeliveries("p");
      }
      clients.delete(first); delivery.closeConnection(first);
      const resumed = client(); delivery.attached(resumed, "p");
      await serialize("p", () => {});
      const removals = frames.get(resumed)!.flatMap((frame) => frame.type === "pending-messages" ? frame.removed ?? [] : []);
      expect(removals).toHaveLength(1024);
      expect(removals.some((item) => item.id === sent.id)).toBe(false);
      expect(typed).toHaveLength(1026);
      return;
    }
    if (when === "before close") { append(); await delivery.reconcilePiDeliveries("p"); }
    if (when === "revoked") revoked.add(first);
    const overlap = when === "overlapping reload" ? client() : undefined;
    if (overlap) delivery.attached(overlap, "p");
    if (when === "detach") first.data.attached.delete("p");
    else if (when !== "same live browser") { clients.delete(first); delivery.closeConnection(first); }
    if (when === "expired") {
      const original = Date.now;
      Date.now = () => original() + 11 * 60 * 1000;
      try { await delivery.reconcilePiDeliveries("p"); } finally { Date.now = original; }
    }
    if (when !== "before close" && when !== "after close") append();
    const next = when === "detach" ? first : overlap ?? client(when === "wrong device" ? "different" : when === "no device" ? undefined : "device", when === "wrong browser" ? crypto.randomUUID() : token, when === "read-only");
    if (when === "detach") first.data.attached.set("p", { keepSize: false, receiptResumeId: token });
    delivery.attached(next, "p");
    await serialize("p", () => {});
    if (when === "after close") {
      await delivery.pendingFrames.submit(next, { type: "submit", id: 2, pane_id: "p", text: "blocked", payload: "blocked", delivery: "immediate" });
      expect(frames.get(next)!.find((frame) => frame.type === "submit-result" && frame.id === 2)).toMatchObject({ ok: false, code: "pending_limit" });
      append();
    }
    await delivery.reconcilePiDeliveries("p");
    const consumed = frames.get(next)!.flatMap((frame) => frame.type === "pending-messages" ? frame.removed ?? [] : [])
      .filter((item) => item.id === sent.id && item.outcome === "consumed");
    expect(consumed.length > 0).toBe(["before close", "after close", "overlapping reload", "no device", "detach"].includes(when));
    if (when === "same live browser") expect(frames.get(next)!.flatMap((frame) => frame.type === "pending-messages" ? frame.messages : [])).toEqual([]);
    expect(typed).toEqual(["same"]);
    if (when === "after close") {
      await delivery.pendingFrames.submit(next, { type: "submit", id: 3, pane_id: "p", text: "released", payload: "released", delivery: "immediate" });
      expect(frames.get(next)!.find((frame) => frame.type === "submit-result" && frame.id === 3)).toMatchObject({ ok: true });
      expect(typed).toEqual(["same", "released"]);
    }
  });

it.each(["identity", "transcript"] as const)("does not release another pane's slot after invalidation during %s lookup", async (at) => {
  const root = mkdtempSync(join(tmpdir(), "ovis-pending-capacity-")); roots.push(root);
  for (const pane of ["p", "q"]) {
    const path = join(root, `${pane}.jsonl`);
    writeFileSync(path, JSON.stringify({ type: "session", version: 3, id: pane }) + "\n"
      + JSON.stringify({ type: "message", id: "a0", parentId: null, message: { role: "assistant", content: [] } }) + "\n");
    paths.set(pane, path);
  }
  const frames: ServerMessage[] = [], typed: string[] = [];
  const owner = {
    data: connectionData({ deviceId: undefined, readOnly: false }),
    getBufferedAmount: () => 0,
    send: (value: string) => { frames.push(JSON.parse(value)); return 1; },
  } as Client;
  for (const pane of ["p", "q"]) owner.data.attached.set(pane, { keepSize: false });
  const queues = new Map<string, Promise<unknown>>();
  const serialize = <T>(pane: string, task: () => T | Promise<T>): Promise<T> => {
    const run = (queues.get(pane) ?? Promise.resolve()).catch(() => {}).then(task);
    queues.set(pane, run);
    return run;
  };
  const delivery = createPendingDelivery({
    options: { piReceiptLimit: 1 }, clients: new Set([owner]), attachments: new Map(),
    sight: () => { throw new Error("immediate sends do not take a pending lease"); },
    serialize, lastTyped: new Map(),
    submitText: async (_pane, text) => { typed.push(text); },
    authorizeSocket: () => {},
    clientSnapshot: async () => ({ panes: ["p", "q"].map((pane_id) => ({
      pane_id, terminal_id: pane_id, agent: "pi", agent_status: "idle",
    })) }) as SessionSnapshot,
    omo: { sessionOf: () => null },
    SUBMIT_DEADLINE_MS: 45_000, SUBMIT_DELAY_MS: 0, TYPED_SETTLE_MS: 0,
  });
  const submit = async (id: number, pane: string, text: string) => {
    await delivery.pendingFrames.submit(owner, { type: "submit", id, pane_id: pane, text, payload: text, delivery: "immediate" });
    await serialize(pane, () => {});
    return frames.find((frame) => frame.type === "submit-result" && frame.id === id);
  };
  expect(await submit(1, "p", "old")).toMatchObject({ ok: true });
  const entered = Promise.withResolvers<void>();
  const resume = Promise.withResolvers<void>();
  lookup = { at, entered: entered.resolve, release: resume.promise };
  const running = delivery.reconcilePiDeliveries("p");
  try {
    await entered.promise;
    delivery.holdPendingPane("p", { code: "input_not_ready", message: "attachment restarting" });
    expect(await submit(2, "q", "new active")).toMatchObject({ ok: true });
    appendFileSync(paths.get("p")!, JSON.stringify({
      type: "message", id: "u1", parentId: "a0", message: { role: "user", content: [{ type: "text", text: "old" }] },
    }) + "\n");
  } finally { resume.resolve(); }
  await running;
  expect(await submit(3, "q", "must be rejected")).toMatchObject({ ok: false, code: "pending_limit" });
  expect(typed).toEqual(["old", "new active"]);
  expect(frames.some((frame) => frame.type === "pending-messages" && frame.pane_id === "p"
    && frame.removed?.some((item) => item.outcome === "consumed"))).toBe(false);
}, 10_000);

const SHELL = 4_194_001, AGENT = 4_194_002;
const shellIn = (name: string): Processes => ({ shell_pid: SHELL, foreground_processes: [{ pid: SHELL, name }] });
const agentIn: Processes = { shell_pid: SHELL, foreground_processes: [{ pid: AGENT, name: "codex" }] };
const READY: SightingFacts = { attached: true, origin: true, sameAttachment: true, samePty: true, sameClaim: true, claimed: true, member: true, ready: true, held: false, currentHeld: false, mirror: false, cols: 80 };
it.each([
  ["learned at an event, then left with the shell back in front under herdr's name for it", "event", "bash", "first_message_launch_ended"],
  ["bound at its queueing, then left before any event with the shell back in front under herdr's name for it", "queueing", "bash", "first_message_launch_ended"],
  ["bound at its queueing, then replaced by an agent of its kind exec'd at the shell's pid", "queueing", "codex", "pending_target_changed"],
] as const)("a first message whose launched agent was %s is held with that reason, keeps it, is refused by Send now, and is never typed", async (_case, bound, front, code) => {
  let named: string | null = null;
  let snapshots = 0, leaveAt = 0, left: Processes | null = null;
  const frames: ServerMessage[] = [];
  const owner = {
    data: connectionData({ deviceId: undefined, readOnly: false }),
    getBufferedAmount: () => 0,
    send: (value: string) => { frames.push(JSON.parse(value)); return 1; },
  } as Client;
  owner.data.attached.set("L", { keepSize: false });
  const queues = new Map<string, Promise<unknown>>();
  const serialize = <T>(pane: string, task: () => T | Promise<T>): Promise<T> => {
    const run = (queues.get(pane) ?? Promise.resolve()).catch(() => {}).then(task);
    queues.set(pane, run);
    return run;
  };
  const delivery = createPendingDelivery({
    options: {}, clients: new Set([owner]), attachments: new Map(),
    sight: (): TerminalSighting => ({ origin: null, pty: null, claim: null, facts: () => READY, write: (data: string) => { calls.push(`pty ${data}`); } }),
    serialize, lastTyped: new Map(),
    submitText: async (pane) => { calls.push(`submit ${pane}`); },
    authorizeSocket: () => {},
    clientSnapshot: async () => {
      if (++snapshots === leaveAt && left) processes.set("L", left);
      return { panes: [{ pane_id: "L", terminal_id: "L", agent: named, agent_status: "working" }] } as SessionSnapshot;
    },
    omo: { sessionOf: () => null },
    SUBMIT_DEADLINE_MS: 45_000, SUBMIT_DELAY_MS: 0, TYPED_SETTLE_MS: 0,
  });
  const event = async () => { delivery.drainPending("L"); await serialize("L", () => {}); };
  const reasons = () => frames.flatMap((frame) => frame.type === "pending-messages" && frame.pane_id === "L" ? frame.messages.map((item) => item.error?.code) : []);
  let message;
  if (bound === "event") {
    processes.set("L", shellIn("bash"));
    message = await delivery.queueFirstMessage("L", "FIRST", "codex");
    processes.set("L", agentIn); named = "codex";
    await event();
    processes.set("L", shellIn(front));
  } else {
    named = "codex";
    processes.set("L", agentIn);
    leaveAt = 2; left = shellIn(front);
    message = await delivery.queueFirstMessage("L", "FIRST", "codex", null, AGENT);
  }
  await event();
  expect(reasons().find((reason) => reason === "first_message_launch_ended" || reason === "pending_target_changed")).toBe(code);
  if (code === "first_message_launch_ended") { named = null; await event(); }
  expect(reasons().at(-1)).toBe(code);
  const steer = async (id: number, launchEnded: boolean) => {
    await delivery.pendingFrames["pending-action"](owner, { type: "pending-action", id, pane_id: "L", pending_id: message.id, action: "steer", ...(launchEnded ? { launch_ended: true as const } : {}) });
    return frames.find((frame) => frame.type === "pending-result" && frame.id === id);
  };
  expect(await steer(1, true)).toMatchObject({ ok: false, code });
  expect(await steer(2, false)).toMatchObject({ ok: false, code: "pending_target_changed" });
  await serialize("L", () => {});
  expect(reasons().at(-1)).toBe(code);
  expect(calls).toEqual([]);
});

// a child the agent runs as it starts (Claude Code's git, gh): herdr lists it in front before it names the agent
const CHILD = 4_194_003, REPLACEMENT = 4_194_004;
it.each([
  ["a child it runs as it starts, binds the agent herdr names next", [{ pid: CHILD, name: "git" }, { pid: AGENT, name: "codex" }], AGENT, "codex", "first_message_unattended"],
  ["a child it runs as it starts, still waits once that child ends before herdr names the agent", [{ pid: CHILD, name: "git" }, { pid: AGENT, name: "codex" }], AGENT, null, "first_message_unattended"],
  ["its agent, stays bound to it: a replacement of its kind gets it held", [{ pid: AGENT, name: "codex" }], REPLACEMENT, "codex", "pending_target_changed"],
] as const)("a first message queued before herdr names its agent, with in front %s", async (_case, front, next, later, code) => {
  let named: string | null = null;
  const frames: ServerMessage[] = [];
  const owner = { data: connectionData({ deviceId: undefined, readOnly: false }), getBufferedAmount: () => 0,
    send: (value: string) => { frames.push(JSON.parse(value)); return 1; } } as Client;
  owner.data.attached.set("L", { keepSize: false });
  let queue = Promise.resolve<unknown>(undefined);
  const serialize = <T>(_pane: string, task: () => T | Promise<T>): Promise<T> => { const run = queue.catch(() => {}).then(task); queue = run; return run; };
  const delivery = createPendingDelivery({
    options: {}, clients: new Set([owner]), attachments: new Map(), serialize, lastTyped: new Map(),
    sight: (): TerminalSighting => ({ origin: null, pty: null, claim: null, facts: () => READY, write: () => {} }),
    submitText: async (pane) => { calls.push(`submit ${pane}`); },
    authorizeSocket: () => {},
    clientSnapshot: async () => ({ panes: [{ pane_id: "L", terminal_id: "L", agent: named, agent_status: "working" }] }) as SessionSnapshot,
    omo: { sessionOf: () => null }, SUBMIT_DEADLINE_MS: 45_000, SUBMIT_DELAY_MS: 0, TYPED_SETTLE_MS: 0,
  });
  processes.set("L", { shell_pid: SHELL, foreground_processes: [...front] });
  await delivery.queueFirstMessage("L", "FIRST", "codex");
  processes.set("L", { shell_pid: SHELL, foreground_processes: [{ pid: next, name: "codex" }] }); named = later;
  delivery.drainPending("L");
  await serialize("L", () => {});
  expect(frames.flatMap((frame) => frame.type === "pending-messages" && frame.pane_id === "L" ? frame.messages.map((item) => item.error?.code) : []).at(-1)).toBe(code);
});

const MAC_CLAUDE = (pid: number) => ({ pid, name: "2.1.3", argv0: "Claude", argv: ["Claude"] });
const DSH_HOST = { pid: AGENT, name: "node", argv: ["/usr/bin/node", "/home/u/.dsh/profiles/dsh-tui/node_modules/@deepseek-harness-tui/dsh-tui/lib/types/dsh-adapter/host-entry.js"] };
it.each([
  ["codex behind a child, unnamed, stays in front", "codex", null, [{ pid: CHILD, name: "git" }, { pid: AGENT, name: "codex" }], { pid: AGENT, name: "codex" }, "sent"],
  ["codex behind a child, unnamed, then replaced", "codex", null, [{ pid: CHILD, name: "git" }, { pid: AGENT, name: "codex" }], { pid: REPLACEMENT, name: "codex" }, "pending_target_changed"],
  ["macOS native Claude behind a child, named, then replaced", "claude", "claude", [{ pid: CHILD, name: "security" }, MAC_CLAUDE(AGENT)], MAC_CLAUDE(REPLACEMENT), "pending_target_changed"],
  ["dsh-tui's host, unnamed, then replaced", "dsh-tui", null, [DSH_HOST], { pid: REPLACEMENT, name: "dsh-tui" }, "pending_target_changed"],
  ["codex named, listed without argv beside a child, stays in front", "codex", "codex", [{ pid: AGENT, name: "node" }, { pid: CHILD, name: "git" }], { pid: AGENT, name: "node" }, "sent"],
  ["codex named, listed without argv beside a child, then replaced", "codex", "codex", [{ pid: AGENT, name: "node" }, { pid: CHILD, name: "git" }], { pid: REPLACEMENT, name: "codex" }, "pending_target_changed"],
] as const)("a first message queued with in front %s: %s", async (_case, kind, namedAtQueue, front, next, outcome) => {
  const registered = Object.hasOwn(SHELL_AGENTS, "dsh-tui");
  if (!registered) SHELL_AGENTS["dsh-tui"] = isDshProcess;
  try {
    let named: string | null = namedAtQueue;
    const frames: ServerMessage[] = [];
    const owner = { data: connectionData({ deviceId: undefined, readOnly: false }), getBufferedAmount: () => 0,
      send: (value: string) => { frames.push(JSON.parse(value)); return 1; } } as Client;
    owner.data.attached.set("L", { keepSize: false });
    let queue = Promise.resolve<unknown>(undefined);
    const serialize = <T>(_pane: string, task: () => T | Promise<T>): Promise<T> => { const run = queue.catch(() => {}).then(task); queue = run; return run; };
    const delivery = createPendingDelivery({
      options: {}, clients: new Set([owner]), attachments: new Map(), serialize, lastTyped: new Map(),
      sight: (): TerminalSighting => ({ origin: null, pty: null, claim: null, facts: () => READY, write: () => {} }),
      submitText: async (pane) => { calls.push(`submit ${pane}`); }, authorizeSocket: () => {},
      clientSnapshot: async () => ({ panes: [{ pane_id: "L", terminal_id: "L", agent: named, agent_status: "idle" }] }) as SessionSnapshot,
      omo: { sessionOf: () => null }, SUBMIT_DEADLINE_MS: 45_000, SUBMIT_DELAY_MS: 0, TYPED_SETTLE_MS: 0,
    });
    processes.set("L", { shell_pid: SHELL, foreground_processes: [...front] });
    const message = await delivery.queueFirstMessage("L", "FIRST", kind, owner.data.connectionId);
    delivery.pending.status("L", "idle");
    expect(delivery.pending.next("L")).toMatchObject({ message: { id: message.id }, identity: { processPid: AGENT } });
    processes.set("L", { shell_pid: SHELL, foreground_processes: [next] }); named = kind;
    delivery.drainPending("L");
    await serialize("L", () => {});
    const codes = frames.flatMap((frame) => frame.type === "pending-messages" && frame.pane_id === "L" ? frame.messages.filter((item) => item.id === message.id).map((item) => item.error?.code) : []);
    if (outcome === "sent") {
      expect(calls).toEqual(["read L"]);
      expect(codes).not.toContain("pending_target_changed");
    } else {
      expect(calls).toEqual([]);
      expect(codes.at(-1)).toBe(outcome);
    }
  } finally { if (!registered) delete SHELL_AGENTS["dsh-tui"]; }
});

it("keeps the owner's held row sendable when its own Send now fails before anything is typed", async () => {
  const output: ServerMessage[] = [];
  const owner = { data: connectionData({ deviceId: "device", readOnly: false }), getBufferedAmount: () => 0,
    send: (value: string) => { output.push(JSON.parse(value)); return 1; } } as Client;
  owner.data.attached.set("p", { keepSize: false });
  let queue = Promise.resolve<unknown>(undefined);
  const serialize = <T>(_pane: string, task: () => T | Promise<T>): Promise<T> => { const next = queue.catch(() => {}).then(task); queue = next; return next; };
  const typed: string[] = [];
  const delivery = createPendingDelivery({
    options: {}, clients: new Set([owner]), attachments: new Map(), serialize, lastTyped: new Map(),
    sight: (): TerminalSighting => ({ origin: null, pty: null, claim: null, facts: () => READY, write: () => {} }),
    submitText: async (_pane, text) => { typed.push(text); },
    authorizeSocket: () => {},
    clientSnapshot: async (): Promise<SessionSnapshot> => { throw new Error("herdr unreachable before any write"); },
    omo: { sessionOf: () => null }, SUBMIT_DEADLINE_MS: 45_000, SUBMIT_DELAY_MS: 0, TYPED_SETTLE_MS: 0,
  });
  const item = delivery.pending.enqueue(owner, "p", 1, "held text", null, { agent: null, terminalId: "p", session: null }, true);
  await delivery.pendingFrames["pending-action"](owner, { type: "pending-action", id: 10, pane_id: "p", pending_id: item.message.id, action: "steer" });
  expect(output.find((frame) => frame.type === "pending-result" && frame.id === 10)).toMatchObject({ ok: false, code: "submit_failed" });
  expect(typed).toEqual([]);
  expect(delivery.pending.list(owner, "p")[0]?.state).toBe("held");
  expect(() => delivery.pending.enqueue(owner, "p", 2, "another", null, { agent: null, terminalId: "p", session: null })).not.toThrow();
});

it.skipIf(Boolean(process.env["CLAUDE_CONFIG_DIR"]))("holds a message queued for a claude attach job's session once that job's state cannot be read before Send now (#2125)", async () => {
  const JOB = "dc5643bd", SESSION_A = "0b8e6f0e-8d3f-4c1a-9a53-6c2b7a1d9e42";
  const home = mkdtempSync(join(tmpdir(), "ovis-pending-attach-")); roots.push(home);
  const state = join(home, ".claude", "jobs", JOB, "state.json");
  mkdirSync(join(home, ".claude", "jobs", JOB), { recursive: true });
  writeFileSync(state, JSON.stringify({ sessionId: `${JOB}-6228-4376-a66c-ad9820b26f37`, resumeSessionId: SESSION_A }));
  const real = claudeStore.claudeForegroundSession;
  let missed = 0;
  const session = spyOn(claudeStore, "claudeForegroundSession").mockImplementation(async (found) => {
    if (missed === 0) return real(found, home);
    missed--;
    return null;
  });
  const output: ServerMessage[] = [];
  const owner = { data: connectionData({ deviceId: "device", readOnly: false }), getBufferedAmount: () => 0,
    send: (value: string) => { output.push(JSON.parse(value)); return 1; } } as Client;
  owner.data.attached.set("p", { keepSize: false });
  let queue = Promise.resolve<unknown>(undefined);
  const serialize = <T>(_pane: string, task: () => T | Promise<T>): Promise<T> => { const next = queue.catch(() => {}).then(task); queue = next; return next; };
  const delivery = createPendingDelivery({
    options: {}, clients: new Set([owner]), attachments: new Map(), serialize, lastTyped: new Map(),
    sight: (): TerminalSighting => ({ origin: null, pty: null, claim: null, facts: () => READY, write: (data: string) => { calls.push(`pty ${data}`); } }),
    submitText: async (pane) => { calls.push(`submit ${pane}`); },
    authorizeSocket: () => {},
    clientSnapshot: async () => ({ panes: [{ pane_id: "p", terminal_id: "p", agent: "claude", agent_status: "idle" }] }) as SessionSnapshot,
    omo: { sessionOf: () => null }, SUBMIT_DEADLINE_MS: 45_000, SUBMIT_DELAY_MS: 0, TYPED_SETTLE_MS: 0,
  });
  processes.set("p", { shell_pid: SHELL, foreground_processes: [{ pid: process.pid, name: "claude", argv: ["claude", "attach", JOB] }] });
  try {
    const item = delivery.pending.enqueue(owner, "p", 1, "for session A", null, { agent: "claude", terminalId: "p", session: null, claudeSession: SESSION_A }, true);
    const steer = async (id: number) => {
      await delivery.pendingFrames["pending-action"](owner, { type: "pending-action", id, pane_id: "p", pending_id: item.message.id, action: "steer", resend_generation: id });
      return output.find((frame) => frame.type === "pending-result" && frame.id === id);
    };
    expect(await steer(10)).not.toMatchObject({ code: "pending_target_changed" });
    expect(calls).toEqual(["read p"]);
    missed = 1;
    expect(await steer(11)).not.toMatchObject({ code: "pending_target_changed" });
    expect(missed).toBe(0);
    expect(calls).toEqual(["read p", "read p"]);
    writeFileSync(state, '{"sessionId":');
    expect(await steer(12)).toMatchObject({ ok: false, code: "pending_target_changed" });
    expect(calls).toEqual(["read p", "read p"]);
    expect(delivery.pending.list(owner, "p")).toMatchObject([{ id: item.message.id, state: "held" }]);
  } finally { session.mockRestore(); }
});
