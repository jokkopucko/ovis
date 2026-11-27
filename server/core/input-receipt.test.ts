import { afterEach, expect, it, mock, spyOn } from "bun:test";
import * as client from "../herdr/client.ts";
import { type Client, connectionData } from "./connections.ts";
import { createInputLane } from "./input.ts";
import { KEY_SETTLE_MS, TYPED_SETTLE_MS } from "../index.ts";
import { CoreAttachSession } from "../herdr-core/attach-session.ts";
import { WindowsControl } from "../windows-control.ts";
import * as paneContext from "../pane-context.ts";
import type { AcpChildren } from "../acp/children.ts";
import { KeeperClient } from "../acp/client.ts";
import { keeperBuilt, keeperRoot, startKeeper, until } from "../acp/keeper.fake.ts";
import { dirname, join } from "node:path";
import { readFileSync, rmSync } from "node:fs";
import { Socket } from "node:net";

afterEach(() => mock.restore());

type Told = { type: string; id?: number; pane_id?: string; ok?: boolean; code?: string };

function connection(told: Told[]): Client {
  return { data: connectionData({ deviceId: undefined, readOnly: false }), readyState: WebSocket.OPEN, send: (raw: string) => { told.push(JSON.parse(raw)); return 1; }, getBufferedAmount: () => 0, close: () => {} } as unknown as Client;
}

function lane(ready = true, pty: unknown = "pty", acp?: Pick<AcpChildren, "forPane">) {
  const typed: string[] = [];
  const told: Told[] = [];
  const phone = connection(told);
  const other = connection([]);
  const facts = { attached: true, origin: true, sameAttachment: true, samePty: true, sameClaim: true, claimed: true, member: true, ready, held: false, currentHeld: false, mirror: false, cols: 80 };
  const sighting = { origin: "attach", pty, claim: "claim", facts: () => facts, write: (data: string) => { typed.push(`pty ${data}`); return true; } };
  let started!: () => void;
  const keyStarted = new Promise<void>((resolve) => { started = resolve; });
  let answer!: () => void;
  const herdrAnswers = new Promise<void>((resolve) => { answer = resolve; });
  let first = true;
  spyOn(client, "paneSendKeys").mockImplementation(async (_pane, keys) => {
    if (first) { first = false; started(); await herdrAnswers; }
    typed.push(`keys ${keys.join(",")}`);
  });
  spyOn(client, "paneSendText").mockImplementation(async (_pane, text) => { typed.push(`text ${text}`); });
  const clients = new Set([phone, other]);
  const { inputFrames, typedInto, serialize } = createInputLane({
    TYPED_SETTLE_MS, KEY_SETTLE_MS, clients, acp, sight: () => sighting, poke: () => {},
    terminalAttach: async () => false, terminalAttachKnown: () => true, mayType: () => true, authorizeSocket: () => {},
  });
  const results = () => told.filter((frame) => frame.type === "input-result");
  return { typed, results, clients, phone, other, inputFrames, typedInto, serialize, keyStarted, answer };
}

it("brackets a fitted Windows agent's multiline paste before sending the following Enter", async () => {
  const pane = "w:p1";
  const live = lane(true, Object.create(WindowsControl.prototype));
  const agent = Promise.withResolvers<string>();
  spyOn(paneContext, "paneAgentOf").mockReturnValue(agent.promise);
  live.inputFrames.input(live.phone, { type: "input", pane_id: pane, text: "first\rsecond", id: 1 });
  live.inputFrames.input(live.phone, { type: "input", pane_id: pane, text: "\r", id: 2 });
  agent.resolve("omp");
  await live.serialize(pane, () => {});
  expect(live.typed).toEqual(["pty \x1b[200~first\rsecond\x1b[201~", "pty \r"]);
  expect(live.results()).toMatchObject([{ id: 1, ok: true }, { id: 2, ok: true }]);
});

it("counts a fitted Windows keystroke queued behind another send, but not a mouse report", async () => {
  const pane = "w:p1";
  const live = lane(true, Object.create(WindowsControl.prototype));
  const blocked = Promise.withResolvers<void>();
  void live.serialize(pane, () => blocked.promise);
  live.inputFrames.input(live.phone, { type: "input", pane_id: pane, text: "a", id: 1 });
  live.inputFrames.input(live.phone, { type: "input", pane_id: pane, text: "\x1b[<0;10;5M" });
  const beforeTyping = live.typedInto(pane);
  blocked.resolve();
  await live.serialize(pane, () => {});
  expect(live.results()).toMatchObject([{ id: 1, ok: true }]);
  expect(live.typedInto(pane) - beforeTyping).toBe(1);
});

it.skipIf(!keeperBuilt)("Stop cancels the running ACP turn instead of typing into its terminal", async () => {
  const root = keeperRoot();
  const keeper = await startKeeper(root);
  const client = new KeeperClient(root);
  try {
    await client.ready();
    await until(client, "session", () => client.session !== null);
    await client.submit("hold");
    const child = { id: "child", terminal: "t1", harness: "codex", root, client };
    const live = lane(true, "pty", { forPane: pane => pane === "t1" ? child : undefined });
    live.inputFrames.input(live.phone, { type: "input", pane_id: "t1", text: "\x1b", stop: true });
    await until(client, "cancelled turn", () => client.turn?.stopReason === "cancelled", 2000);
    expect(client.holdGeneration).toBeNumber();
    await expect(client.submit("follow-up", "ask")).rejects.toThrow("held by a person");
    const rows = readFileSync(join(root, "archive.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
    expect(rows.filter(row => row.dir === "to-agent").map(row => JSON.parse(row.raw))).toContainEqual({
      jsonrpc: "2.0", method: "session/cancel", params: { sessionId: client.session },
    });
    expect(live.typed).toEqual([]);
  } finally { client.close(); await keeper.stop(); rmSync(dirname(root), { recursive: true, force: true }); }
});

it("sends Stop keys to the real TUI while its ACP child stays registered", async () => {
  const root = keeperRoot();
  const socket = new Socket();
  const keeper = new KeeperClient(root, { connect: () => socket });
  const child = { id: "child", terminal: "t1", harness: "codex", root, client: keeper };
  const live = lane(true, "pty", { forPane: pane => pane === "t1" ? child : undefined });
  try {
    socket.emit("data", [
      { seq: 1, dir: "keeper", raw: JSON.stringify({ method: "_keeper/session", params: { sessionId: "s1" } }) },
      { seq: 2, dir: "keeper", raw: JSON.stringify({ method: "_keeper/mode", params: { mode: "terminal", phase: "ready" } }) },
      { through: 2, client: 1 },
    ].map(row => JSON.stringify(row)).join("\n") + "\n");
    live.inputFrames.input(live.phone, { type: "input", pane_id: "t1", text: "\x03", stop: true, id: 1 });
    live.inputFrames.input(live.phone, { type: "input", pane_id: "t1", text: "\x1b", stop: true, id: 2 });
    live.answer();
    await live.inputFrames.keys(live.phone, { type: "keys", pane_id: "t1", keys: ["right"] });
    expect(live.typed).toEqual(["pty \x03", "text \x1b", "keys right"]);
    expect(live.results()).toMatchObject([{ id: 1, ok: true }, { id: 2, ok: true }]);
  } finally { keeper.close(); rmSync(dirname(root), { recursive: true, force: true }); }
});

it("counts what a person types into a pane, by any way, and not the terminal's own answers or the mouse", async () => {
  const live = lane();
  expect(live.typedInto("w:p1")).toBe(0);
  live.inputFrames.input(live.phone, { type: "input", pane_id: "w:p1", text: "a" });
  expect(live.typedInto("w:p1")).toBe(1);
  live.inputFrames.input(live.phone, { type: "input", pane_id: "w:p1", text: "\u001b[12;40R", automatic: true });
  live.inputFrames.input(live.phone, { type: "input", pane_id: "w:p1", text: "\u001b[<0;10;5M" });
  expect(live.typedInto("w:p1")).toBe(1);
  const key = live.inputFrames.keys(live.phone, { type: "keys", pane_id: "w:p1", keys: ["left"] });
  await live.keyStarted;
  live.inputFrames.input(live.phone, { type: "input", pane_id: "w:p1", text: "b" });
  const barrier = live.inputFrames.keys(live.other, { type: "keys", pane_id: "w:p1", keys: ["right"] });
  live.answer();
  await key;
  await barrier;
  expect(live.typed).toEqual(["pty a", "pty \u001b[12;40R", "pty \u001b[<0;10;5M", "keys left", "text b", "keys right"]);
  expect(live.typedInto("w:p1")).toBe(4);
  expect(live.typedInto("w:p2")).toBe(0);
  const typeInto = (pane: string) => live.inputFrames.input(live.phone, { type: "input", pane_id: pane, text: "a" });
  for (let pane = 0; pane < 255; pane++) typeInto(`other:p${pane}`);
  typeInto("w:p1");
  typeInto("other:p255");
  expect([live.typedInto("w:p1"), live.typedInto("other:p0")]).toEqual([5, 0]);
});

it("answers queued typing with an id only once herdr typed it, and a connection that ended before its turn gets nothing typed", async () => {
  for (const disconnect of [false, true]) {
    const { typed, results, clients, phone, other, inputFrames, keyStarted, answer } = lane();
    const key = inputFrames.keys(phone, { type: "keys", pane_id: "w:p1", keys: ["left"] });
    await keyStarted;
    inputFrames.input(phone, { type: "input", pane_id: "w:p1", text: "echo hi", id: 7 });
    expect(results()).toEqual([]);
    if (disconnect) clients.delete(phone);
    const barrier = inputFrames.keys(other, { type: "keys", pane_id: "w:p1", keys: ["right"] });
    answer();
    await key;
    await barrier;
    if (disconnect) {
      expect(typed).toEqual(["keys left", "keys right"]);
      expect(results()).toEqual([]);
    } else {
      expect(typed).toEqual(["keys left", "text echo hi", "keys right"]);
      expect(results()).toEqual([{ type: "input-result", id: 7, pane_id: "w:p1", ok: true }]);
    }
  }
});

it("types a lone cursor key queued behind a key into a herdr-core attach, which sends it in the program's mode then, and through herdr elsewhere", async () => {
  for (const [pty, arrow] of [[Object.create(CoreAttachSession.prototype), "pty \u001b[A"], ["pty", "text \u001b[A"]] as const) {
    const { typed, results, phone, other, inputFrames, typedInto, keyStarted, answer } = lane(true, pty);
    const key = inputFrames.keys(phone, { type: "keys", pane_id: "w:p1", keys: ["left"] });
    await keyStarted;
    inputFrames.input(phone, { type: "input", pane_id: "w:p1", text: "\u001b[A", id: 3 });
    const barrier = inputFrames.keys(other, { type: "keys", pane_id: "w:p1", keys: ["right"] });
    answer();
    await key;
    await barrier;
    expect(typed).toEqual(["keys left", arrow, "keys right"]);
    expect(results()).toEqual([{ type: "input-result", id: 3, pane_id: "w:p1", ok: true }]);
    expect(typedInto("w:p1")).toBe(3);
  }
});

it("sends a lone cursor key as hc's named key while the herdr-core attach is paused, in order with the typing after it", async () => {
  for (const [paused, sent] of [[true, ["pty a", "keys up", "text b"]], [false, ["pty a", "pty \u001bOA", "pty b"]]] as const) {
    const attach = Object.create(CoreAttachSession.prototype) as CoreAttachSession;
    if (paused) attach.pause();
    const { typed, results, phone, other, inputFrames, typedInto, answer } = lane(true, attach);
    inputFrames.input(phone, { type: "input", pane_id: "w:p1", text: "a" });
    inputFrames.input(phone, { type: "input", pane_id: "w:p1", text: "\u001bOA", id: 4 });
    inputFrames.input(phone, { type: "input", pane_id: "w:p1", text: "b" });
    const barrier = inputFrames.keys(other, { type: "keys", pane_id: "w:p1", keys: ["right"] });
    answer();
    await barrier;
    expect(typed).toEqual([...sent, "keys right"]);
    expect(results()).toEqual([{ type: "input-result", id: 4, pane_id: "w:p1", ok: true }]);
    expect(typedInto("w:p1")).toBe(4);
  }
});

it("answers typing written straight to the pty at once, a refusal with its code, and an input without an id not at all", () => {
  const live = lane();
  live.inputFrames.input(live.phone, { type: "input", pane_id: "w:p1", text: "a", id: 1 });
  live.inputFrames.input(live.phone, { type: "input", pane_id: "w:p1", text: "b" });
  expect(live.typed).toEqual(["pty a", "pty b"]);
  expect(live.results()).toEqual([{ type: "input-result", id: 1, pane_id: "w:p1", ok: true }]);
  const notReady = lane(false);
  notReady.inputFrames.input(notReady.phone, { type: "input", pane_id: "w:p1", text: "a", id: 2 });
  expect(notReady.typed).toEqual([]);
  expect(notReady.results()).toEqual([{ type: "input-result", id: 2, pane_id: "w:p1", ok: false, code: "input_not_ready" }]);
});
