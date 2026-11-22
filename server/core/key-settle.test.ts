import { afterEach, expect, it, mock, spyOn } from "bun:test";
import * as client from "../herdr/client.ts";
import { type Client, connectionData } from "./connections.ts";
import { createInputLane } from "./input.ts";
import { KEY_SETTLE_MS, TYPED_SETTLE_MS } from "../index.ts";

afterEach(() => mock.restore());

/**
 * What the settle must outlast, measured on herdr 0.9.3 (#634): a letter crosses the sidecar and the
 * attach in about 2 ms, so a key waits several times that; herdr holds a lone ESC ~150 ms.
 */
const PTY_PIPELINE_MARGIN_MS = 20;
const HERDR_ESC_HOLD_MS = 150;

/**
 * One connection attached and ready on pane w:p1, its pty writes and herdr's RPCs written down with
 * the time they were made. A key goes through herdr around the pty, so the lane is what keeps it
 * from overtaking the typing before it: herdr offers no barrier for bytes in the attach pty (#634).
 */
function lane() {
  const events: Array<{ what: string; at: number }> = [];
  const socket: Client = { data: connectionData({ deviceId: undefined, readOnly: false }), readyState: WebSocket.OPEN, send: () => 1, getBufferedAmount: () => 0, close: () => {} };
  const facts = { attached: true, origin: true, sameAttachment: true, samePty: true, sameClaim: true, claimed: true, member: true, ready: true, held: false, currentHeld: false, mirror: false, cols: 80 };
  const sighting = { origin: "attach", pty: "pty", claim: "claim", facts: () => facts, write: (data: string) => { events.push({ what: `pty ${JSON.stringify(data)}`, at: Date.now() }); return true; } };
  spyOn(client, "paneSendKeys").mockImplementation(async (_pane, keys, _socketPath, guard) => {
    if (guard && !guard()) throw new client.HerdrError("cancelled", "not sent");
    events.push({ what: `keys ${keys.join(",")}`, at: Date.now() });
  });
  spyOn(client, "paneSendText").mockImplementation(async (_pane, text, _socketPath, guard) => {
    if (guard && !guard()) throw new client.HerdrError("cancelled", "not sent");
    events.push({ what: `text ${JSON.stringify(text)}`, at: Date.now() });
  });
  const { inputFrames } = createInputLane({
    TYPED_SETTLE_MS, KEY_SETTLE_MS, clients: new Set([socket]), sight: () => sighting, poke: () => {},
    terminalAttach: async () => false, terminalAttachKnown: () => true, mayType: () => true, authorizeSocket: () => {},
  });
  return {
    events,
    type: (text: string) => inputFrames.input(socket, { type: "input", pane_id: "w:p1", text }),
    keys: (keys: string[]) => inputFrames.keys(socket, { type: "keys", pane_id: "w:p1", keys }),
    reply: (text: string) => inputFrames.input(socket, { type: "input", pane_id: "w:p1", text, automatic: true }),
    gap: (from: string, to: string) => events.find((e) => e.what === to)!.at - events.find((e) => e.what === from)!.at,
  };
}

it("sends a key KEY_SETTLE_MS after the letter typed into the pty before it", async () => {
  const { events, type, keys, gap } = lane();
  type("a");
  await keys(["left"]);
  expect(events.map((e) => e.what)).toEqual(["pty \"a\"", "keys left"]);
  // timers count whole milliseconds: one may fire up to a millisecond before Date.now() says it is due
  expect(gap("pty \"a\"", "keys left")).toBeGreaterThanOrEqual(Math.max(KEY_SETTLE_MS, PTY_PIPELINE_MARGIN_MS) - 1);
});

it("sends a key TYPED_SETTLE_MS after typing that ended in an ESC, which herdr holds a moment", async () => {
  const { events, type, keys, gap } = lane();
  type("\x1b");
  await keys(["up"]);
  expect(events.map((e) => e.what)).toEqual(["pty \"\\u001b\"", "keys up"]);
  expect(gap("pty \"\\u001b\"", "keys up")).toBeGreaterThanOrEqual(Math.max(TYPED_SETTLE_MS, HERDR_ESC_HOLD_MS) - 1);
});

it("types a letter that comes while a key waits after the key, through herdr, not into the pty", async () => {
  const { events, type, keys } = lane();
  type("a");
  const sent = keys(["left"]);
  type("b");
  await sent;
  await keys(["right"]);
  expect(events.map((e) => e.what)).toEqual(["pty \"a\"", "keys left", "text \"b\"", "keys right"]);
});

it("writes the terminal's own reply that comes while a key waits into the attach it answers, never typed through herdr", async () => {
  const { events, keys, reply } = lane();
  const sent = keys(["left"]);
  // a herdr-core attach takes these out of what reaches the program; typed through herdr, the program reads them
  reply("\x1b[I");
  reply("\x1b]10;rgb:d8d8/d0d0/c3c3\x1b\\");
  await sent;
  expect(events.map((e) => e.what)).toEqual(["pty \"\\u001b[I\"", "pty \"\\u001b]10;rgb:d8d8/d0d0/c3c3\\u001b\\\\\"", "keys left"]);
});

it("keeps text a client tags automatic but that is no terminal reply in the pane's turn", async () => {
  const { events, keys, reply } = lane();
  const sent = keys(["left"]);
  reply("ls\r");
  reply("\x1b[200~ls\x1b[201~");
  await sent;
  await keys(["right"]);
  expect(events.map((e) => e.what)).toEqual(["keys left", "text \"ls\\r\"", "text \"\\u001b[200~ls\\u001b[201~\"", "keys right"]);
});
