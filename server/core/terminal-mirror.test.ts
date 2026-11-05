import { afterEach, beforeEach, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mirrorFrame } from "../mirror.ts";
import { connectionData, type Client } from "./connections.ts";
import { createTerminalRegistry } from "./terminals.ts";

// A mirrored pane through the real registry and MirrorSession, against a stand-in herdr socket
// whose every pane.read is held until the test answers it.
type Frame = Record<string, unknown> & { type: string };

let root: string;
let previousSocket: string | undefined;
let listener: ReturnType<typeof Bun.listen<{ buffer: string }>>;
/** pane.read requests in arrival order, each answered with the screen the test gives it */
let reads: AsyncIterator<(text: string) => void>;
const nextRead = async () => (await reads.next()).value as (text: string) => void;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "herdr-terminal-mirror-"));
  previousSocket = process.env.HERDR_SOCKET;
  process.env.HERDR_SOCKET = join(root, "herdr.sock");
  const queued: ((text: string) => void)[] = [];
  let waiting: ((answer: (text: string) => void) => void) | null = null;
  reads = {
    next: () => new Promise((resolve) => {
      const done = (value: (text: string) => void) => resolve({ value, done: false });
      const ready = queued.shift();
      if (ready) done(ready);
      else waiting = done;
    }),
  };
  listener = Bun.listen<{ buffer: string }>({
    unix: process.env.HERDR_SOCKET,
    socket: {
      open(socket) { socket.data = { buffer: "" }; },
      data(socket, data) {
        socket.data.buffer += data.toString();
        if (!socket.data.buffer.includes("\n")) return;
        const request = JSON.parse(socket.data.buffer);
        const answer = (result: unknown) => socket.end(JSON.stringify({ id: request.id, result }) + "\n");
        if (request.method === "session.snapshot") {
          answer({ snapshot: {
            panes: [{ pane_id: "p", terminal_id: "t" }],
            layouts: [{ panes: [{ pane_id: "p", rect: { width: 80, height: 24 } }] }],
          } });
        } else if (request.method === "pane.read") {
          const reply = (text: string) => answer({ read: { text } });
          if (waiting) { const take = waiting; waiting = null; take(reply); }
          else queued.push(reply);
        } else throw new Error(`unexpected RPC ${request.method}`);
      },
    },
  });
});

afterEach(() => {
  listener.stop(true);
  if (previousSocket === undefined) delete process.env.HERDR_SOCKET;
  else process.env.HERDR_SOCKET = previousSocket;
  rmSync(root, { recursive: true, force: true });
});

/** A client whose pty-data frames are recorded, each awaitable by its index. */
function recorder() {
  const frames: Frame[] = [];
  const waiters: { count: number; done: () => void }[] = [];
  const client = {
    data: connectionData({ deviceId: undefined, readOnly: false }),
    readyState: WebSocket.OPEN,
    getBufferedAmount: () => 0,
    send(raw: string) {
      const frame = JSON.parse(raw) as Frame;
      if (frame.type === "pty-data") frames.push(frame);
      for (const waiter of waiters.filter((entry) => frames.length >= entry.count)) waiter.done();
      return raw.length;
    },
    close() {},
  };
  /** resolves once `count` pty-data frames arrived; rejects at a bounded deadline */
  const until = (count: number): Promise<Frame[]> => {
    if (frames.length >= count) return Promise.resolve(frames);
    const arrived = Promise.withResolvers<Frame[]>();
    const timer = setTimeout(() => arrived.reject(new Error(`pty-data frame ${count} did not arrive`)), 5000);
    waiters.push({ count, done: () => { clearTimeout(timer); arrived.resolve(frames); } });
    return arrived.promise;
  };
  return { client, frames, until };
}

function registryFor(clients: Client[]) {
  return createTerminalRegistry({
    options: {}, clients: new Set(clients), stopped: () => false,
    terminalAttach: async () => false,
    holdFor: 0, heldRetry: 0, retryFor: 0, relookupFor: 0,
    holdPending() {}, holdPendingPane() {}, attached() {}, inputReady() {}, end() {},
  });
}

const attach = { type: "attach", pane_id: "p", cols: 80, rows: 24, flow_control: "ack" } as const;

it("marks a mirror's first screen as replay for a client that attached before it was read", async () => {
  const first = recorder(), joiner = recorder();
  const registry = registryFor([first.client, joiner.client]);
  try {
    await registry.terminalFrames.attach(first.client, attach);
    const answerFirst = await nextRead();
    // the attach completed with nothing read yet: the screen reaches this client later
    expect(first.frames).toEqual([]);
    answerFirst("retained screen");
    const [initial] = await first.until(1);
    expect(initial!.data).toBe(mirrorFrame("retained screen", 24));
    expect(initial!.replay).toBe(true);
    expect((initial!.flow as { offset: number }).offset).toBe(Buffer.byteLength(String(initial!.data)));

    // a joiner after the read gets the same screen, marked the same way
    await registry.terminalFrames.attach(joiner.client, attach);
    const [joined] = await joiner.until(1);
    expect(joined!.data).toBe(initial!.data);
    expect(joined!.replay).toBe(true);

    // the next screen is live for both: no replay flag, offsets continue from the replay
    (await nextRead())("live screen");
    const [, live] = await first.until(2);
    const [, liveJoined] = await joiner.until(2);
    for (const [frame, before] of [[live!, initial!], [liveJoined!, joined!]] as const) {
      expect(frame.replay).toBeUndefined();
      expect((frame.flow as { offset: number }).offset)
        .toBe(Buffer.byteLength(String(before.data)) + Buffer.byteLength(String(frame.data)));
    }
  } finally {
    registry.closeAttachment("p");
    registry.conversations.stop();
  }
});

it("does not carry a pending first-screen mark into a later attach of a client that left", async () => {
  const leaver = recorder(), stayer = recorder();
  const registry = registryFor([leaver.client, stayer.client]);
  try {
    await registry.terminalFrames.attach(leaver.client, attach);
    await registry.terminalFrames.attach(stayer.client, attach);
    const answerFirst = await nextRead();
    registry.terminalFrames.detach(leaver.client, { type: "detach", pane_id: "p" });
    answerFirst("retained screen");
    const [initial] = await stayer.until(1);
    expect(initial!.replay).toBe(true);
    expect(leaver.frames).toEqual([]);

    // back again: its replay is the attach's own, and the live screen after it is unmarked
    await registry.terminalFrames.attach(leaver.client, attach);
    (await nextRead())("live screen");
    const [replayed, live] = await leaver.until(2);
    expect(replayed!.replay).toBe(true);
    expect(live!.replay).toBeUndefined();
  } finally {
    registry.closeAttachment("p");
    registry.conversations.stop();
  }
});
