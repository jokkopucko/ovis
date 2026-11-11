import { expect, it, spyOn } from "bun:test";
import { resolve } from "node:path";
import type { SessionSnapshot } from "../../shared/protocol.ts";
import { OUTPUT_HARD_BYTES } from "../output-window.ts";
import { MachineRelay } from "../machine-relay.ts";
import type { MachineManager } from "../machines.ts";
import { type Client, connectionData } from "./connections.ts";
import { createSocket } from "./socket.ts";

function socket(stopped: boolean) {
  const ended: string[] = [];
  const handler = createSocket({
    clients: new Set(), present: new Set(), stopped: () => stopped, admit: () => true, setRole() {}, watchable: () => true, terminalHistory: () => false, watchPane() {}, unwatchPane() {},
    end: (_client, reason) => { ended.push(reason); }, holdPending() {}, attachments: new Map(),
    clientSnapshot: async () => ({}) as SessionSnapshot, herdrLifetime: () => undefined, browserSnapshot: (snapshot) => snapshot, countVisit() {}, drainOutput() {}, frames: {} as never,
  });
  const client: Client = { data: connectionData({ deviceId: undefined, readOnly: false }), readyState: WebSocket.OPEN, getBufferedAmount: () => 0, send: () => 1, close: () => {} };
  return { handler, client, ended };
}

it("tells a new connection its features before its snapshot, which waits on herdr, and even when that read fails", async () => {
  for (const outcome of ["read", "failed"] as const) {
    let settle: (snapshot: SessionSnapshot) => void = () => {};
    let fail: (error: Error) => void = () => {};
    const held = new Promise<SessionSnapshot>((resolve, reject) => { settle = resolve; fail = reject; });
    const handler = createSocket({
      clients: new Set(), present: new Set(), stopped: () => false, admit: () => true, setRole() {}, watchable: () => true, terminalHistory: () => false, watchPane() {}, unwatchPane() {},
      end() {}, holdPending() {}, attachments: new Map(),
      clientSnapshot: () => held, herdrLifetime: () => outcome === "read" ? "herdr-a" : undefined, browserSnapshot: (snapshot) => snapshot, countVisit() {}, drainOutput() {}, frames: {} as never,
    });
    const frames: { type: string; features?: string[]; code?: string; connection?: string; herdr_lifetime?: string }[] = [];
    const client: Client = { data: connectionData({ deviceId: undefined, readOnly: false }), readyState: WebSocket.OPEN, getBufferedAmount: () => 0, send: (raw: string) => { frames.push(JSON.parse(raw)); return raw.length; }, close: () => {} };
    const opened = handler.open!(client);
    expect(frames.map((frame) => frame.type)).toEqual(["features"]);
    expect(frames[0]!.features).toEqual(expect.arrayContaining(["submit", "pending-input", "terminal-insert", "watch"]));
    // herdr's TUI owns scrollback: the browser keeps none
    expect(frames[0]!.features).not.toContain("terminal-history");
    expect(frames[0]!.connection).toBe(client.data.connectionId);
    // the herdr it reads now, read without a herdr call; none when it proves none
    expect(frames[0]!.herdr_lifetime).toBe(outcome === "read" ? "herdr-a" : undefined);
    if (outcome === "read") settle({ workspaces: [], panes: [], agents: [], layouts: [] } as unknown as SessionSnapshot);
    else fail(new Error("herdr session.snapshot timed out after 10000ms"));
    await opened;
    expect(frames.map((frame) => frame.type)).toEqual(outcome === "read" ? ["features", "snapshot"] : ["features", "error"]);
    if (outcome === "read") expect(frames[1]!.features).toEqual(frames[0]!.features);
  }
});

it("names the folder OVIS_PASTE_DIR sends uploads to in the features frame, and none for each pane's .ovis (#2771)", async () => {
  const previous = process.env["OVIS_PASTE_DIR"];
  try {
    // a watch-only connection, which may list no folder, is not told it
    for (const [override, readOnly, told] of [[" /tmp/shots.png backup ", false, resolve("/tmp/shots.png backup")], [" /tmp/shots.png backup ", true, undefined], [undefined, false, undefined]] as const) {
      if (override === undefined) delete process.env["OVIS_PASTE_DIR"]; else process.env["OVIS_PASTE_DIR"] = override;
      const handler = createSocket({
        clients: new Set(), present: new Set(), stopped: () => false, admit: () => true, setRole() {}, watchable: () => true, terminalHistory: () => false, watchPane() {}, unwatchPane() {},
        end() {}, holdPending() {}, attachments: new Map(),
        clientSnapshot: async () => ({ workspaces: [], panes: [], agents: [], layouts: [] }) as unknown as SessionSnapshot, herdrLifetime: () => undefined, browserSnapshot: (snapshot) => snapshot, countVisit() {}, drainOutput() {}, frames: {} as never,
      });
      const frames: { type: string; paste_dir?: string }[] = [];
      const client: Client = { data: connectionData({ deviceId: undefined, readOnly }), readyState: WebSocket.OPEN, getBufferedAmount: () => 0, send: (raw: string) => { frames.push(JSON.parse(raw)); return raw.length; }, close: () => {} };
      await handler.open!(client);
      expect(frames[0]).toMatchObject({ type: "features" });
      expect(frames[0]!.paste_dir).toBe(told);
    }
  } finally {
    if (previous === undefined) delete process.env["OVIS_PASTE_DIR"]; else process.env["OVIS_PASTE_DIR"] = previous;
  }
});

it("offers no watch where none can be drawn (herdr-core), and ends a watch sent anyway without starting one", async () => {
  const watched: string[] = [];
  const handler = createSocket({
    clients: new Set(), present: new Set(), stopped: () => false, admit: () => true, setRole() {}, watchable: () => false, terminalHistory: () => true,
    watchPane: (_client, paneId) => { watched.push(paneId); }, unwatchPane() {},
    end() {}, holdPending() {}, attachments: new Map(),
    clientSnapshot: async () => ({ workspaces: [], panes: [], agents: [], layouts: [] }) as unknown as SessionSnapshot, herdrLifetime: () => undefined, browserSnapshot: (snapshot) => snapshot, countVisit() {}, drainOutput() {}, frames: {} as never,
  });
  const frames: { type: string; features?: string[]; pane_id?: string; code?: string }[] = [];
  const client: Client = { data: connectionData({ deviceId: undefined, readOnly: false }), readyState: WebSocket.OPEN, getBufferedAmount: () => 0, send: (raw: string) => { frames.push(JSON.parse(raw)); return raw.length; }, close: () => {} };
  await handler.open!(client);
  expect(frames.map((frame) => frame.type)).toEqual(["features", "snapshot"]);
  for (const frame of frames) {
    expect(frame.features).not.toContain("watch");
    // herdr-core keeps no viewport to scroll: its attaches replay history for the browser to keep
    expect(frame.features).toContain("terminal-history");
    // everything else stays offered
    expect(frame.features).toEqual(expect.arrayContaining(["submit", "pending-input", "conversation-watch", "terminal-insert"]));
  }
  frames.length = 0;
  await handler.message!(client, JSON.stringify({ type: "watch", pane_id: "t1", cols: 80, rows: 24 }));
  expect(frames).toEqual([{ type: "watch-end", pane_id: "t1" }]);
  expect(watched).toEqual([]);
  // a grid out of range is still refused as such
  frames.length = 0;
  await handler.message!(client, JSON.stringify({ type: "watch", pane_id: "t1", cols: 0, rows: 24 }));
  expect(frames.map((frame) => frame.code)).toEqual(["invalid_geometry"]);
});

it("refuses a watch whose pane id is no nonempty string before anything is started for it", async () => {
  const watched: unknown[] = [];
  const unwatched: unknown[] = [];
  const handler = createSocket({
    clients: new Set(), present: new Set(), stopped: () => false, admit: () => true, setRole() {}, watchable: () => true, terminalHistory: () => false,
    watchPane: (_client, paneId) => { watched.push(paneId); }, unwatchPane: (_client, paneId) => { unwatched.push(paneId); },
    end() {}, holdPending() {}, attachments: new Map(),
    clientSnapshot: async () => ({ workspaces: [], panes: [], agents: [], layouts: [] }) as unknown as SessionSnapshot, herdrLifetime: () => undefined, browserSnapshot: (snapshot) => snapshot, countVisit() {}, drainOutput() {}, frames: {} as never,
  });
  const frames: { type: string; code?: string }[] = [];
  const client: Client = { data: connectionData({ deviceId: undefined, readOnly: true }), readyState: WebSocket.OPEN, getBufferedAmount: () => 0, send: (raw: string) => { frames.push(JSON.parse(raw)); return raw.length; }, close() {} };
  await handler.open!(client);
  frames.length = 0;
  // an array is another Map key every time: each such frame would start one more observe process, which no unwatch could name
  // and an id shaped as an option would be read as one by herdr's own command line, which is handed the id as it came
  // and one no pane has: megabytes of it would be logged and sent back for each frame
  for (const paneId of [["w1:p1"], 7, null, undefined, "", "   ", { id: "w1:p1" }, "--help", "-V", "--socket=/tmp/x", " --help", "p".repeat(257), "w1:p1\u0000", "w1\np1"]) {
    await handler.message!(client, JSON.stringify({ type: "watch", pane_id: paneId, cols: 80, rows: 24 }));
    await handler.message!(client, JSON.stringify({ type: "unwatch", pane_id: paneId }));
  }
  expect([watched, unwatched]).toEqual([[], []]);
  expect(frames.map((frame) => frame.code)).toEqual(Array.from({ length: 28 }, () => "invalid_watch"));
  // a watching device's own pane is still watched, and so is the longest id taken
  for (const paneId of ["w1:p1", "p".repeat(256)]) await handler.message!(client, JSON.stringify({ type: "watch", pane_id: paneId, cols: 80, rows: 24 }));
  expect(watched).toEqual(["w1:p1", "p".repeat(256)]);
});

it("delivers a session snapshot larger than the transport budget to a socket with nothing queued (#2566)", async () => {
  // a large session: its snapshot alone serializes past the 1 MiB the transport may hold queued
  const snapshot = { workspaces: [], panes: Array.from({ length: 600 }, (_, i) => ({ pane_id: `p${i}`, cwd: `/w/${"x".repeat(2000)}` })), agents: [], layouts: [] } as unknown as SessionSnapshot;
  expect(Buffer.byteLength(JSON.stringify(snapshot))).toBeGreaterThan(OUTPUT_HARD_BYTES);
  const handler = createSocket({
    clients: new Set(), present: new Set(), stopped: () => false, admit: () => true, setRole() {}, watchable: () => true, terminalHistory: () => false, watchPane() {}, unwatchPane() {},
    end() {}, holdPending() {}, attachments: new Map(),
    clientSnapshot: async () => snapshot, herdrLifetime: () => undefined, browserSnapshot: (read) => read, countVisit() {}, drainOutput() {}, frames: {} as never,
  });
  // a real Bun socket with the production limits, so Bun's own backpressure cap is in play as well
  const server = Bun.serve({
    port: 0, hostname: "127.0.0.1",
    fetch: (request, bun) => bun.upgrade(request, { data: connectionData({ deviceId: undefined, readOnly: false }) }) ? undefined : new Response(null, { status: 400 }),
    websocket: handler,
  });
  const ws = new WebSocket(`ws://127.0.0.1:${server.port}`);
  try {
    const types: string[] = [];
    const outcome = Promise.withResolvers<string>();
    ws.onmessage = (event) => {
      const frame = JSON.parse(String(event.data)) as { type: string; snapshot?: SessionSnapshot };
      types.push(frame.type);
      if (frame.type === "snapshot") outcome.resolve(`snapshot with ${frame.snapshot!.panes.length} panes`);
    };
    ws.onclose = (event) => outcome.resolve(`closed ${event.code} ${event.reason}`);
    const timer = setTimeout(() => outcome.resolve("timed out"), 5_000);
    try {
      expect(await outcome.promise).toBe("snapshot with 600 panes");
    } finally {
      clearTimeout(timer);
    }
    expect(types).toEqual(["features", "snapshot"]);
  } finally {
    ws.close();
    await server.stop(true);
  }
});

for (const arrives of ["before the browser's socket opens", "after the browser's socket opened"] as const) {
  it(`relays a remote PC's session snapshot larger than the transport budget that arrives ${arrives} (#2573)`, async () => {
    const snapshot = { workspaces: [], panes: Array.from({ length: 600 }, (_, i) => ({ pane_id: `p${i}`, cwd: `/w/${"x".repeat(2000)}` })), agents: [], layouts: [] } as unknown as SessionSnapshot;
    const frames = [JSON.stringify({ type: "features", features: [] }), JSON.stringify({ type: "snapshot", snapshot }), JSON.stringify({ type: "pty-data", pane_id: "p0", data: "after" })];
    expect(Buffer.byteLength(frames[1]!)).toBeGreaterThan(OUTPUT_HARD_BYTES);
    const early = arrives === "before the browser's socket opens";
    // the remote PC's server: it sends its frames on its socket's open, or when the browser first speaks
    const pc = Bun.serve({
      port: 0, hostname: "127.0.0.1",
      fetch: (request, bun) => bun.upgrade(request) ? undefined : new Response(null, { status: 400 }),
      websocket: {
        open(socket) { if (early) for (const frame of frames) socket.send(frame); },
        message(socket) { if (!early) for (const frame of frames) socket.send(frame); },
      },
    });
    const manager = { endpoint: () => ({ url: `http://127.0.0.1:${pc.port}`, token: "test" }), trackTerminal: () => () => {} } as unknown as MachineManager;
    const handler = createSocket({
      clients: new Set(), present: new Set(), stopped: () => false, admit: () => true, setRole() {}, watchable: () => true, terminalHistory: () => false, watchPane() {}, unwatchPane() {},
      end() {}, holdPending() {}, attachments: new Map(),
      clientSnapshot: async () => snapshot, herdrLifetime: () => undefined, browserSnapshot: (read) => read, countVisit() {}, drainOutput() {}, frames: {} as never,
    });
    const relays: MachineRelay[] = [];
    // this PC's server, relaying /ws?machine_id= as dispatch.ts does
    const server = Bun.serve({
      port: 0, hostname: "127.0.0.1",
      async fetch(request, bun) {
        const relay = new MachineRelay(manager, "pc", false, (read) => read);
        relays.push(relay);
        if (early) {
          // heard after the relay's own handler: every frame is held for the browser before its socket opens
          const held = Promise.withResolvers<void>();
          let count = 0;
          const upstream = (relay as unknown as { upstream: WebSocket }).upstream;
          upstream.addEventListener("message", () => { if (++count === frames.length) held.resolve(); });
          upstream.addEventListener("close", () => held.resolve());
          await relay.ready;
          await held.promise;
        } else await relay.ready;
        return bun.upgrade(request, { data: connectionData({ relay, deviceId: undefined, readOnly: false }) }) ? undefined : new Response(null, { status: 400 });
      },
      websocket: handler,
    });
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}`);
    try {
      const told: string[] = [];
      const outcome = Promise.withResolvers<string>();
      ws.onopen = () => { if (!early) ws.send(JSON.stringify({ type: "presence", active: true })); };
      ws.onmessage = (event) => { told.push(String(event.data)); if (told.length === frames.length) outcome.resolve("all frames"); };
      ws.onclose = (event) => outcome.resolve(`closed ${event.code} ${event.reason}`);
      const timer = setTimeout(() => outcome.resolve("timed out"), 5_000);
      try {
        expect(await outcome.promise).toBe("all frames");
      } finally {
        clearTimeout(timer);
      }
      expect(told).toEqual(frames);
    } finally {
      ws.close();
      for (const relay of relays) relay.close();
      await server.stop(true);
      await pc.stop(true);
    }
  });
}

it("records an abnormal close while running and stays quiet once the server is stopping", () => {
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  try {
    const running = socket(false);
    running.handler.close!(running.client, 4001, "");
    expect(warn).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(warn.mock.calls[0]![0]))).toMatchObject({ event: "websocket.failed", close_code: 4001 });
    const stopping = socket(true);
    stopping.handler.close!(stopping.client, 1006, "");
    expect(warn).toHaveBeenCalledTimes(1);
    expect(stopping.ended).toEqual(["closed"]);
  } finally {
    warn.mockRestore();
  }
});
