import { expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer as createSocketServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionSnapshot, WorkspaceMoved } from "../shared/protocol.ts";
import { socketAddress } from "./herdr/client.ts";
import { createServer } from "./index.ts";
import { OrderSequence } from "./order-sequence.ts";
import { UsageService } from "./usage.ts";

test("a read takes the number of moves confirmed when it starts, and a move takes the next", () => {
  const order = new OrderSequence("boot-1");
  expect(order.read()).toEqual({ order_epoch: "boot-1", read_seq: 0 });
  expect(order.moved()).toEqual({ order_epoch: "boot-1", moved_seq: 1 });
  expect(order.read()).toEqual({ order_epoch: "boot-1", read_seq: 1 });
  expect(order.read()).toEqual({ order_epoch: "boot-1", read_seq: 1 });
  expect(order.moved()).toEqual({ order_epoch: "boot-1", moved_seq: 2 });
});

test("a pre-move read delivered after confirmation stays fenced", () => {
  const order = new OrderSequence("boot-1");
  const now = spyOn(Date, "now").mockReturnValue(5_000);
  const monotonic = spyOn(performance, "now").mockReturnValue(5_000);
  try {
    const before = order.read();
    const receipt = order.moved();
    now.mockReturnValue(1_000);
    monotonic.mockReturnValue(1_000);
    expect(before.read_seq < receipt.moved_seq).toBe(true);
    expect(order.read().read_seq >= receipt.moved_seq).toBe(true);
    expect(now).not.toHaveBeenCalled();
    expect(monotonic).not.toHaveBeenCalled();
  } finally { now.mockRestore(); monotonic.mockRestore(); }
});

test("a server lifetime is its own epoch: another starts again at 0", () => {
  const first = new OrderSequence("boot-1");
  first.moved(); first.moved();
  const next = new OrderSequence("boot-2");
  expect(next.read()).toEqual({ order_epoch: "boot-2", read_seq: 0 });
  expect(next.moved()).toEqual({ order_epoch: "boot-2", moved_seq: 1 });
});

test("a session read still waiting on herdr when a move is confirmed carries the number from before the move", async () => {
  const root = mkdtempSync(join(tmpdir(), "ovis-order-fence-"));
  const previousSocket = process.env.HERDR_SOCKET;
  const socketPath = join(root, "herdr.sock");
  const sockets = new Set<Socket>();
  const reads = new Map<string, { beforeMove: boolean }>();
  const held: (() => void)[] = [];
  let holding = false;
  let moveAsked = false;
  let heldWaiter: (() => void) | null = null;
  const daemon = createSocketServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString();
      if (!buffer.includes("\n")) return;
      const { id, method } = JSON.parse(buffer.split("\n")[0]!) as { id: string; method: string };
      buffer = "";
      if (method === "events.subscribe") return;
      const answer = (result: unknown) => { if (!socket.destroyed) socket.write(`${JSON.stringify({ id, result })}\n`); };
      if (method === "workspace.move") moveAsked = true;
      if (method !== "session.snapshot") { answer({}); return; }
      // a read sent to herdr before the move was sent started before the server confirmed the move
      const version = `read-${reads.size + 1}`;
      reads.set(version, { beforeMove: !moveAsked });
      const reply = () => answer({ snapshot: { panes: [], agents: [], workspaces: [], tabs: [], layouts: [], protocol: 1, version } });
      if (!holding) { reply(); return; }
      held.push(reply);
      heldWaiter?.();
    });
  });
  let app: ReturnType<typeof createServer> | undefined;
  try {
    await new Promise<void>((resolve, reject) => { daemon.once("error", reject); daemon.listen(socketAddress(socketPath), resolve); });
    process.env.HERDR_SOCKET = socketPath;
    app = createServer({
      port: 0, hostname: "127.0.0.1", token: "", stateDir: join(root, "state"), machines: false, registerBridge: false,
      herdrProfiles: async () => [], tailscaleOwner: null, terminalAttach: false, sidecar: false, usage: new UsageService(undefined, []),
    });
    const origin = `http://127.0.0.1:${app.port}`;
    const session = async () => ((await (await fetch(`${origin}/api/session`)).json()) as { snapshot: SessionSnapshot }).snapshot;
    expect(await session()).toMatchObject({ read_seq: 0 });
    let fenced = 0;
    let moves = 0;
    // a background read of the server's own may be the one held first: then the round says nothing, and another runs
    for (let round = 0; round < 5 && fenced === 0; round++) {
      holding = true;
      moveAsked = false;
      const reading = session();
      if (held.length === 0) await new Promise<void>((resolve) => { heldWaiter = resolve; });
      heldWaiter = null;
      const response = await fetch(`${origin}/api/workspace/move`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ workspace_id: "w1", insert_index: 0 }) });
      const receipt = (await response.json()) as WorkspaceMoved;
      expect(receipt.moved_seq).toBe(++moves);
      holding = false;
      for (const reply of held.splice(0)) reply();
      const read = await reading;
      if (!reads.get(read.version)?.beforeMove) continue;
      expect(read.order_epoch).toBe(receipt.order_epoch!);
      expect(read.read_seq!).toBeLessThan(receipt.moved_seq!);
      fenced++;
    }
    expect(fenced).toBe(1);
    // a read started after the move carries its number
    expect(await session()).toMatchObject({ read_seq: moves });
  } finally {
    app?.stop();
    for (const reply of held.splice(0)) reply();
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => daemon.close(() => resolve()));
    if (previousSocket === undefined) delete process.env.HERDR_SOCKET;
    else process.env.HERDR_SOCKET = previousSocket;
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);
