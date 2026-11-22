import { afterEach, expect, it, mock, spyOn } from "bun:test";
import * as client from "../herdr/client.ts";
import { type Client, connectionData } from "./connections.ts";
import { createInputLane } from "./input.ts";
import { KEY_SETTLE_MS, TYPED_SETTLE_MS } from "../index.ts";
import { CoreAttachSession } from "../herdr-core/attach-session.ts";

afterEach(() => mock.restore());

type Told = { type: string; id?: number; pane_id?: string; ok?: boolean; code?: string };

function connection(told: Told[]): Client {
  return { data: connectionData({ deviceId: undefined, readOnly: false }), readyState: WebSocket.OPEN, send: (raw: string) => { told.push(JSON.parse(raw)); return 1; }, getBufferedAmount: () => 0, close: () => {} } as unknown as Client;
}

function lane(ready = true, pty: unknown = "pty") {
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
  const { inputFrames, typedInto } = createInputLane({
    TYPED_SETTLE_MS, KEY_SETTLE_MS, clients, sight: () => sighting, poke: () => {},
    terminalAttach: async () => false, terminalAttachKnown: () => true, mayType: () => true, authorizeSocket: () => {},
  });
  const results = () => told.filter((frame) => frame.type === "input-result");
  return { typed, results, clients, phone, other, inputFrames, typedInto, keyStarted, answer };
}

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
