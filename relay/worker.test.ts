import { afterAll, afterEach, beforeAll, describe, expect, setSystemTime, test } from "bun:test";
import { answerServerChallenge, SERVER_PROOF_CLOSE, SERVER_PROOF_MS } from "../shared/relay-server-proof.ts";
import { RELAY_NEW_SESSIONS_REFUSED, RELAY_PASS_HEADER, RELAY_PASS_LIFETIME_S, RELAY_PASS_SKEW_S, signRelayPass } from "../shared/relay-pass.ts";
import { CLOSE, HANDSHAKE_MS, IDLE_MS, KEEPALIVE_PING, KEEPALIVE_PONG, MAX_CLIENTS, MAX_MESSAGE_BYTES, MAX_PENDING, MAX_PROVING, OFFLINE_WAIT_MS, USAGE_REPORT_MS, WARM_QUIET_MS, parseSocketRequest, type Frame } from "./core.ts";
import { answerChallenge, newServer, type TestServer } from "./relay-test-client.ts";
import { PAIR_GUEST_MS } from "./pair-room.ts";
import { RelayRoom, handle, usageKey, type Env, type HibernatableSocket, type RelayState } from "./worker.ts";

/** the server end of a Cloudflare WebSocketPair: records what the room sends and how it closes */
class FakeSocket implements HibernatableSocket {
  sent: Frame[] = [];
  closedWith: { code: number; reason: string } | null = null;
  /** times the room called close() */
  closes = 0;
  /** the far end vanished without a TCP close: a close sent to it is never answered, so the runtime keeps listing the socket */
  peerGone = false;
  private attachment: unknown = null;
  send(frame: Frame) {
    if (this.closedWith) throw new Error("socket closed");
    this.sent.push(frame);
  }
  close(code = 1005, reason = "") {
    this.closes++;
    if (this.closedWith) throw new Error("already closed");
    this.closedWith = { code, reason };
  }
  serializeAttachment(value: unknown) { this.attachment = structuredClone(value); }
  deserializeAttachment() { return structuredClone(this.attachment); }
  json(index: number) { return JSON.parse(this.sent[index] as string) as Record<string, unknown>; }
}

const runtime = globalThis as unknown as Record<string, unknown>;
const saved = { WebSocketPair: runtime["WebSocketPair"], WebSocketRequestResponsePair: runtime["WebSocketRequestResponsePair"] };
/** every WebSocketPair made, the Worker's own included */
const pairs: { 0: FakeSocket; 1: FakeSocket }[] = [];
beforeAll(() => {
  runtime["WebSocketPair"] = class { 0 = new FakeSocket(); 1 = new FakeSocket(); constructor() { pairs.push(this); } };
  runtime["WebSocketRequestResponsePair"] = class { constructor(readonly request: string, readonly response: string) {} };
});
afterAll(() => Object.assign(runtime, saved));
afterEach(() => setSystemTime());

/** DurableObjectState over the fake sockets; it outlives a RelayRoom as the real one outlives an eviction */
function fakeState() {
  const sockets: FakeSocket[] = [];
  const keepalive = new Map<HibernatableSocket, Date>();
  const stored = new Map<string, unknown>();
  const reads: string[] = [];
  const state: RelayState & { autoResponse: unknown; alarm: number | null; ready: Promise<unknown> } = {
    autoResponse: null,
    alarm: null,
    ready: Promise.resolve(),
    blockConcurrencyWhile: <T>(callback: () => Promise<T>) => (state.ready = callback()) as Promise<T>,
    acceptWebSocket: (socket: HibernatableSocket) => { sockets.push(socket as FakeSocket); },
    // the runtime stops listing a socket once its close is through, which a vanished peer never answers
    getWebSockets: () => sockets.filter((socket) => !socket.closedWith || socket.peerGone),
    setWebSocketAutoResponse: (pair?: unknown) => { state.autoResponse = pair; },
    getWebSocketAutoResponseTimestamp: (socket: HibernatableSocket) => keepalive.get(socket) ?? null,
    storage: {
      getAlarm: async () => state.alarm,
      setAlarm: async (time: number) => { state.alarm = time; },
      get: async <T>(key: string) => { reads.push(key); return stored.get(key) as T | undefined; },
      put: async <T>(key: string, value: T) => { stored.set(key, value); },
    },
  };
  return { state, sockets, keepalive, stored, reads };
}

const PC = newServer();
const SERVER = PC.serverId;
const url = (query: string) => `https://relay.test/v1/ws?server_id=${SERVER}&v=1&${query}`;
const proof = (server: TestServer = PC) => `proof=1&public_key=${server.publicKey}`;
const upgrade = { headers: { upgrade: "websocket" } };

/** opens a socket on the room; returns the server end the room holds */
async function connect(room: RelayRoom, fake: ReturnType<typeof fakeState>, query: string): Promise<FakeSocket> {
  const response = await room.fetch(new Request(url(query), upgrade));
  expect(response.status).toBe(101);
  return fake.sockets.at(-1)!;
}

/**
 * Opens a PC socket (control, or data for `connectionId`) offering `offered`'s public key, and
 * answers the relay's challenge with `answerWith`'s secret key. The challenge is taken off `sent`.
 */
async function connectServer(room: RelayRoom, fake: ReturnType<typeof fakeState>, connectionId: string | null = null, offered: TestServer = PC, answerWith: TestServer = offered): Promise<FakeSocket> {
  const socket = await connect(room, fake, `role=server${connectionId === null ? "" : `&connection_id=${connectionId}`}&${proof(offered)}`);
  const challenge = socket.sent[0];
  const answer = challenge === undefined ? null : answerChallenge(challenge, offered, connectionId, answerWith.secretKey);
  if (answer) {
    socket.sent.shift();
    room.webSocketMessage(socket, answer);
  }
  return socket;
}

/** a client and the PC's data socket for it */
async function connectPair(room: RelayRoom, fake: ReturnType<typeof fakeState>) {
  const client = await connect(room, fake, "role=client");
  const { connection_id } = client.json(0) as { connection_id: string };
  return { client, connection_id, data: await connectServer(room, fake, connection_id) };
}

/** The generation a control socket's sync named, which a warm socket opened under it carries. */
const generationOf = (control: FakeSocket) => (control.json(0) as { warm: string }).warm;

/** Opens a warm PC socket of `generation` and answers its challenge for `role` (a warm socket's own unless another is given). */
async function connectWarm(room: RelayRoom, fake: ReturnType<typeof fakeState>, generation: string, role: "warm" | "control" | "data" = "warm"): Promise<FakeSocket> {
  const socket = await connect(room, fake, `role=server&warm=${generation}&${proof()}`);
  const answer = answerServerChallenge(socket.sent.shift(), PC.secretKey, { server_id: SERVER, role, connection_id: role === "control" ? null : generation });
  if (answer) room.webSocketMessage(socket, answer);
  return socket;
}

/** what the runtime does when a socket closes: the room hears it */
function closeFromFar(room: RelayRoom, socket: FakeSocket) {
  socket.closedWith ??= { code: 1000, reason: "" };
  room.webSocketClose(socket);
}

describe("relay warm sockets", () => {
  test("a client arriving takes the PC's proven warm socket at once, and the control socket hears nothing of it", async () => {
    const fake = fakeState();
    let room = new RelayRoom(fake.state);
    const control = await connectServer(room, fake);
    const warm = await connectWarm(room, fake, generationOf(control));
    expect(warm.sent).toEqual([]);
    expect(warm.closedWith).toBeNull();
    // an eviction between the proof and the client: the warm socket is found again from what it saved
    room = new RelayRoom(fake.state);
    const client = await connect(room, fake, "role=client");
    const { connection_id } = client.json(0) as { connection_id: string };
    expect(warm.json(0)).toEqual({ type: "bound", connection_id });
    expect(control.sent).toHaveLength(1);
    room.webSocketMessage(client, "hello");
    room = new RelayRoom(fake.state);
    room.webSocketMessage(warm, "ready");
    expect(warm.sent.slice(1)).toEqual(["hello"]);
    expect(client.sent.slice(1)).toEqual(["ready"]);
    // with no warm socket left, the next client is announced as before
    const next = await connect(room, fake, "role=client");
    expect(control.json(control.sent.length - 1)).toEqual({ type: "connected", connection_id: (next.json(0) as { connection_id: string }).connection_id });
    closeFromFar(room, client);
    expect(warm.closedWith?.code).toBe(CLOSE.GOING_AWAY);
    expect(control.json(control.sent.length - 1)).toEqual({ type: "disconnected", connection_id });
  });

  test("a warm socket the PC stopped keeping alive is not handed to a client, which is announced instead", async () => {
    const start = new Date("2026-11-05T12:00:00Z");
    setSystemTime(start);
    const fake = fakeState();
    let room = new RelayRoom(fake.state);
    const control = await connectServer(room, fake);
    const generation = generationOf(control);
    const kept = await connectWarm(room, fake, generation);
    // kept alive by its pings, the last one answered by the runtime itself, after an eviction
    setSystemTime(new Date(start.getTime() + 20_000));
    room.webSocketMessage(kept, KEEPALIVE_PING);
    room = new RelayRoom(fake.state);
    setSystemTime(new Date(start.getTime() + 40_000));
    fake.keepalive.set(kept, new Date(start.getTime() + 39_000));
    const first = await connect(room, fake, "role=client");
    expect(kept.json(kept.sent.length - 1)).toEqual({ type: "bound", connection_id: (first.json(0) as { connection_id: string }).connection_id });
    // the next warm socket goes quiet past WARM_QUIET_MS: the PC may have given it up
    const quiet = await connectWarm(room, fake, generation);
    setSystemTime(new Date(start.getTime() + 40_000 + WARM_QUIET_MS));
    const second = await connect(room, fake, "role=client");
    expect(quiet.closedWith?.code).toBe(CLOSE.GOING_AWAY);
    expect(quiet.sent).toEqual([]);
    expect(control.json(control.sent.length - 1)).toEqual({ type: "connected", connection_id: (second.json(0) as { connection_id: string }).connection_id });
  });

  test("a warm socket needs a warm proof of its generation, and one at a time waits", async () => {
    const fake = fakeState();
    const room = new RelayRoom(fake.state);
    for (const query of [`warm=1`, `warm=${"ab".repeat(16)}&connection_id=${"ab".repeat(16)}`]) {
      expect(parseSocketRequest(new URL(url(`role=server&${query}`)))).toHaveProperty("error");
    }
    const control = await connectServer(room, fake);
    const generation = generationOf(control);
    for (const role of ["control", "data"] as const) {
      const forged = await connectWarm(room, fake, generation, role);
      expect(forged.closedWith?.code).toBe(SERVER_PROOF_CLOSE);
    }
    const stranger = await connectWarm(room, fake, "cd".repeat(16));
    expect(stranger.closedWith?.code).toBe(CLOSE.GOING_AWAY);
    const first = await connectWarm(room, fake, generation);
    const second = await connectWarm(room, fake, generation);
    expect(first.closedWith?.code).toBe(CLOSE.POLICY);
    expect(second.closedWith).toBeNull();
  });

  test("a warm socket goes with the control socket it was opened under, proven or still proving", async () => {
    const fake = fakeState();
    const room = new RelayRoom(fake.state);
    const control = await connectServer(room, fake);
    const old = generationOf(control);
    const proven = await connectWarm(room, fake, old);
    // still proving when the PC's network moves: its answer arrives after the newer control socket
    const proving = await connect(room, fake, `role=server&warm=${old}&${proof()}`);
    const late = answerServerChallenge(proving.sent.shift(), PC.secretKey, { server_id: SERVER, role: "warm", connection_id: old });
    const replacement = await connectServer(room, fake);
    expect(control.closedWith?.code).toBe(CLOSE.POLICY);
    expect(proven.closedWith?.code).toBe(CLOSE.GOING_AWAY);
    expect(proving.closedWith?.code).toBe(CLOSE.GOING_AWAY);
    room.webSocketMessage(proving, late!);
    // a warm socket of the old generation opened after the replacement is refused, and the client is announced
    const stale = await connectWarm(room, fake, old);
    expect(stale.closedWith?.code).toBe(CLOSE.GOING_AWAY);
    const client = await connect(room, fake, "role=client");
    const { connection_id } = client.json(0) as { connection_id: string };
    expect(replacement.json(replacement.sent.length - 1)).toEqual({ type: "connected", connection_id });
    const current = await connectWarm(room, fake, generationOf(replacement));
    closeFromFar(room, replacement);
    expect(current.closedWith?.code).toBe(CLOSE.GOING_AWAY);
    // with no control socket no warm socket is taken
    const lonely = await connectWarm(room, fake, generationOf(replacement));
    expect(lonely.closedWith?.code).toBe(CLOSE.GOING_AWAY);
  });
});

describe("relay Durable Object", () => {
  test("one failed alarm write does not stop later ones", async () => {
    const fake = fakeState();
    const room = new RelayRoom(fake.state);
    const setAlarm = fake.state.storage.setAlarm;
    fake.state.storage.setAlarm = async () => { throw new Error("storage unavailable"); };
    await expect(room.fetch(new Request(url("role=client"), upgrade))).rejects.toThrow("storage unavailable");
    fake.state.storage.setAlarm = setAlarm;
    await connectServer(room, fake);
    expect(fake.state.alarm).not.toBeNull();
  });

  test("lets the runtime answer the keepalive, so an idle PC does not wake it", () => {
    const fake = fakeState();
    new RelayRoom(fake.state);
    expect(fake.state.autoResponse).toEqual({ request: KEEPALIVE_PING, response: KEEPALIVE_PONG });
  });

  test("pairs control, client and data and passes frames unchanged, across an eviction", async () => {
    const fake = fakeState();
    let room = new RelayRoom(fake.state);
    const control = await connectServer(room, fake);
    expect(control.json(0)).toEqual({ type: "sync", connection_ids: [], warm: expect.stringMatching(/^[0-9a-f]{32}$/) });
    const client = await connect(room, fake, "role=client");
    const { connection_id } = client.json(0) as { connection_id: string };
    expect(connection_id).toMatch(/^[0-9a-f]{32}$/);
    expect(control.json(1)).toEqual({ type: "connected", connection_id });
    const data = await connectServer(room, fake, connection_id);

    // evicted: a new instance knows the sockets only from their attachments
    room = new RelayRoom(fake.state);
    const binary = crypto.getRandomValues(new Uint8Array(4096)).buffer;
    room.webSocketMessage(client, binary);
    expect(data.sent).toEqual([binary]);
    expect(data.sent[0]).toBe(binary);
    room.webSocketMessage(data, "text back");
    expect(client.sent.at(-1)).toBe("text back");
    // the control socket never hears a client's frames
    expect(control.sent).toHaveLength(2);
  });

  test("closes a client 1012 whose held frames an evicted instance took with it", async () => {
    const fake = fakeState();
    const before = new RelayRoom(fake.state);
    await connectServer(before, fake);
    const client = await connect(before, fake, "role=client");
    const { connection_id } = client.json(0) as { connection_id: string };
    before.webSocketMessage(client, "held");
    const after = new RelayRoom(fake.state);
    const data = await connectServer(after, fake, connection_id);
    expect(client.closedWith?.code).toBe(CLOSE.RESTART);
    expect(data.closedWith?.code).toBe(CLOSE.GOING_AWAY);
  });

  test("a second control socket replaces the first with 1008; the 9th client is refused 1013; unknown versions 1008", async () => {
    const fake = fakeState();
    const room = new RelayRoom(fake.state);
    const first = await connectServer(room, fake);
    const second = await connectServer(room, fake);
    expect(first.closedWith?.code).toBe(CLOSE.POLICY);
    expect(second.closedWith).toBeNull();
    for (let index = 0; index < MAX_CLIENTS; index++) {
      const client = await connect(room, fake, "role=client");
      const data = await connectServer(room, fake, (client.json(0) as { connection_id: string }).connection_id);
      // the PC answers the handshake: only then does the client hold one of the MAX_CLIENTS slots
      room.webSocketMessage(data, "handshake answer");
    }
    const ninth = await connect(room, fake, "role=client");
    expect(ninth.closedWith?.code).toBe(CLOSE.TRY_AGAIN);
    const response = await room.fetch(new Request(`https://relay.test/v1/ws?server_id=${SERVER}&role=client&v=9`, upgrade));
    expect(response.status).toBe(101);
    expect(fake.sockets.at(-1)!.closedWith?.code).toBe(CLOSE.POLICY);
  });

  test("propagates closes: client gone closes data 1001, data gone closes client 1012", async () => {
    const fake = fakeState();
    const room = new RelayRoom(fake.state);
    const control = await connectServer(room, fake);
    const pair = async () => {
      const client = await connect(room, fake, "role=client");
      const { connection_id } = client.json(0) as { connection_id: string };
      return { client, connection_id, data: await connectServer(room, fake, connection_id) };
    };
    const one = await pair();
    closeFromFar(room, one.client);
    expect(one.data.closedWith?.code).toBe(CLOSE.GOING_AWAY);
    expect(JSON.parse(control.sent.at(-1) as string)).toEqual({ type: "disconnected", connection_id: one.connection_id });
    // the runtime's own close event for the data socket changes nothing more
    room.webSocketClose(one.data);
    const two = await pair();
    closeFromFar(room, two.data);
    expect(two.client.closedWith?.code).toBe(CLOSE.RESTART);
  });

  test("answers a close the peer sent, so its socket does not hang in CLOSING until it times out", async () => {
    const fake = fakeState();
    const room = new RelayRoom(fake.state);
    const control = await connectServer(room, fake);
    const one = await connectPair(room, fake);
    // the phone closed its socket: the runtime reports the close and leaves the answer to the room
    room.webSocketClose(one.client, 4000, "qa drop", true);
    expect(one.client.closedWith).toEqual({ code: 4000, reason: "qa drop" });
    expect(one.data.closedWith?.code).toBe(CLOSE.GOING_AWAY);
    expect(control.json(control.sent.length - 1)).toEqual({ type: "disconnected", connection_id: one.connection_id });
    // a close without a status code (1005) cannot be echoed: it is answered 1000
    const two = await connectPair(room, fake);
    room.webSocketClose(two.data, 1005, "", true);
    expect(two.data.closedWith).toEqual({ code: 1000, reason: "" });
    expect(two.client.closedWith?.code).toBe(CLOSE.RESTART);
  });

  for (const target of ["client", "data"] as const) {
    test(`a failed send to ${target} ends the pair without a runtime close event`, async () => {
      const fake = fakeState();
      const room = new RelayRoom(fake.state);
      const control = await connectServer(room, fake);
      const pair = await connectPair(room, fake);
      const other = await connectPair(room, fake);
      pair[target].send = () => { throw new Error("transport unavailable"); };
      room.webSocketMessage(pair[target === "client" ? "data" : "client"], "ciphertext");
      await Promise.resolve();
      expect(pair[target].closedWith?.code).toBe(CLOSE.RESTART);
      expect(pair[target === "client" ? "data" : "client"].closedWith?.code)
        .toBe(target === "client" ? CLOSE.GOING_AWAY : CLOSE.RESTART);
      expect(control.json(control.sent.length - 1)).toEqual({ type: "disconnected", connection_id: pair.connection_id });
      const notifications = control.sent.length;
      room.webSocketClose(pair.client);
      room.webSocketError(pair.data);
      expect(control.sent).toHaveLength(notifications);
      room.webSocketMessage(other.client, "still connected");
      expect(other.data.sent.at(-1)).toBe("still connected");
      expect(control.closedWith).toBeNull();
    });
  }

  test("an alarm closes sockets idle for 120 s; a PC kept alive by the runtime's keepalive stays", async () => {
    const start = new Date("2026-10-29T12:00:00Z");
    setSystemTime(start);
    const fake = fakeState();
    const room = new RelayRoom(fake.state);
    const control = await connectServer(room, fake);
    // the PC's challenge was due first
    expect(fake.state.alarm).toBe(start.getTime() + SERVER_PROOF_MS);
    const { client, data } = await connectPair(room, fake);
    room.webSocketMessage(data, "handshake answer");

    setSystemTime(new Date(start.getTime() + IDLE_MS - 1000));
    fake.keepalive.set(control, new Date());
    await room.alarm();
    expect(client.closedWith).toBeNull();

    setSystemTime(new Date(start.getTime() + IDLE_MS));
    await room.alarm();
    expect(client.closedWith?.code).toBe(CLOSE.GOING_AWAY);
    expect(data.closedWith?.code).toBe(CLOSE.GOING_AWAY);
    expect(control.closedWith).toBeNull();
    expect(fake.state.alarm).toBe(start.getTime() + 2 * IDLE_MS - 1000);
  });

  test("a socket closed to a peer that vanished stays ended across an eviction: no second close, disconnected or usage report", async () => {
    const points: unknown[] = [];
    const usage = { USAGE: { writeDataPoint: (point: unknown) => { points.push(point); } } };
    const start = 1_000_000;
    setSystemTime(new Date(start));
    const fake = fakeState();
    let room = new RelayRoom(fake.state, usage);
    const control = await connectServer(room, fake);
    const pair = await connectPair(room, fake);
    room.webSocketMessage(pair.data, "handshake answer");
    // the phone's network went away: it sends nothing more and never answers a close
    pair.client.peerGone = true;
    const disconnected = () => control.sent.filter((frame) => frame === JSON.stringify({ type: "disconnected", connection_id: pair.connection_id })).length;

    setSystemTime(new Date(start + IDLE_MS));
    fake.keepalive.set(control, new Date());
    await room.alarm();
    expect(pair.client.closedWith?.code).toBe(CLOSE.GOING_AWAY);
    expect(disconnected()).toBe(1);
    const reported = points.length;

    // hibernated, then woken by the next alarm while the runtime still lists the unanswered socket
    room = new RelayRoom(fake.state, usage);
    setSystemTime(new Date(start + 2 * IDLE_MS));
    fake.keepalive.set(control, new Date());
    await room.alarm();
    expect(pair.client.closes).toBe(1);
    expect(disconnected()).toBe(1);
    expect(points).toHaveLength(reported);
    expect(control.closedWith).toBeNull();
    expect(fake.state.alarm).toBe(start + 3 * IDLE_MS);
    // a frame it sent before the close arrives late: it is not passed on, and nothing ends twice
    const passed = pair.data.sent.length;
    room.webSocketMessage(pair.client, "late");
    room.webSocketMessage(pair.client, "x".repeat(MAX_MESSAGE_BYTES + 1));
    expect(pair.data.sent).toHaveLength(passed);
    expect(pair.client.closes).toBe(1);
    expect(disconnected()).toBe(1);
    expect(points).toHaveLength(reported);
    // the runtime finally gives up on it
    room.webSocketClose(pair.client, 1006, "", false);
    expect(disconnected()).toBe(1);
    expect(points).toHaveLength(reported);
  });

  test("after an eviction, closes an idle pair no sooner than 120 s after its last frame and by 150 s after the saved time", async () => {
    const at = (ms: number) => setSystemTime(new Date(ms));
    at(1_000_000);
    const fake = fakeState();
    let room = new RelayRoom(fake.state);
    await connectServer(room, fake);
    const client = await connect(room, fake, "role=client");
    const { connection_id } = client.json(0) as { connection_id: string };
    const data = await connectServer(room, fake, connection_id);
    // traffic both ways 29 s in: under the 30 s write interval, so the saved last-seen stays at 1000000
    at(1_029_000);
    room.webSocketMessage(client, new Uint8Array([1, 2, 3]).buffer);
    room.webSocketMessage(data, new Uint8Array([4, 5, 6]).buffer);
    expect(data.sent).toHaveLength(1);

    room = new RelayRoom(fake.state);
    at(1_120_000);
    await room.alarm();
    expect([client.closedWith, data.closedWith]).toEqual([null, null]);
    expect(fake.state.alarm).toBe(1_150_000);
    // 1 ms short of 120 s since the last frame
    at(1_148_999);
    await room.alarm();
    expect([client.closedWith, data.closedWith]).toEqual([null, null]);
    at(1_150_000);
    await room.alarm();
    expect(client.closedWith?.code).toBe(CLOSE.GOING_AWAY);
    expect(data.closedWith?.code).toBe(CLOSE.GOING_AWAY);
  });
});

describe("relay admission", () => {
  test("takeover: a socket that claims role=server without the PC's key cannot replace its control socket or take its waiting phones", async () => {
    const fake = fakeState();
    const room = new RelayRoom(fake.state);
    const control = await connectServer(room, fake);
    const client = await connect(room, fake, "role=client");
    const { connection_id } = client.json(0) as { connection_id: string };
    room.webSocketMessage(client, "held ciphertext");
    const other = newServer();
    const attempts = [
      // no proof at all, as before this check
      await connect(room, fake, "role=server"),
      await connect(room, fake, `role=server&connection_id=${connection_id}`),
      // someone else's key, which does not derive this server_id
      await connectServer(room, fake, null, other),
      // the right public key, answered without its secret key
      await connectServer(room, fake, null, PC, other),
      await connectServer(room, fake, connection_id, PC, other),
    ];
    for (const attempt of attempts) {
      expect(attempt.closedWith?.code).toBe(SERVER_PROOF_CLOSE);
      // it never heard who is waiting, nor any held frame
      expect(attempt.sent.filter((frame) => typeof frame !== "string" || !frame.includes("server_challenge"))).toEqual([]);
    }
    expect(control.closedWith).toBeNull();
    expect(client.closedWith).toBeNull();
    // the real PC still owns the room: its data socket attaches and gets the held frame
    const data = await connectServer(room, fake, connection_id);
    expect(data.closedWith).toBeNull();
    expect(data.sent).toEqual(["held ciphertext"]);
  });

  test("takeover: a replayed proof is refused, and a proof for a control socket does not open a data socket", async () => {
    const fake = fakeState();
    const room = new RelayRoom(fake.state);
    const first = await connect(room, fake, `role=server&${proof()}`);
    const answer = answerChallenge(first.sent.shift()!, PC, null)!;
    room.webSocketMessage(first, answer);
    expect(first.json(0)).toEqual({ type: "sync", connection_ids: [], warm: expect.stringMatching(/^[0-9a-f]{32}$/) });
    const replay = await connect(room, fake, `role=server&${proof()}`);
    room.webSocketMessage(replay, answer);
    expect(replay.closedWith?.code).toBe(SERVER_PROOF_CLOSE);
    const client = await connect(room, fake, "role=client");
    const { connection_id } = client.json(0) as { connection_id: string };
    const data = await connect(room, fake, `role=server&connection_id=${connection_id}&${proof()}`);
    room.webSocketMessage(data, answerChallenge(data.sent[0]!, PC, null)!);
    expect(data.closedWith?.code).toBe(SERVER_PROOF_CLOSE);
    expect(first.closedWith).toBeNull();
  });

  test("a newer control socket replaces the older only once it proves the same key", async () => {
    const fake = fakeState();
    const room = new RelayRoom(fake.state);
    const first = await connectServer(room, fake);
    const second = await connect(room, fake, `role=server&${proof()}`);
    // until it answers, the first keeps the room
    expect(first.closedWith).toBeNull();
    room.webSocketMessage(second, answerChallenge(second.sent[0]!, PC, null)!);
    expect(first.closedWith?.code).toBe(CLOSE.POLICY);
    expect(second.closedWith).toBeNull();
    expect(second.json(1)).toEqual({ type: "sync", connection_ids: [], warm: expect.stringMatching(/^[0-9a-f]{32}$/) });
  });

  test("a PC socket that does not answer its challenge in 10 s is closed, keepalives or not", async () => {
    setSystemTime(new Date(1_000_000));
    const fake = fakeState();
    const room = new RelayRoom(fake.state);
    const silent = await connect(room, fake, `role=server&${proof()}`);
    expect(fake.state.alarm).toBe(1_000_000 + SERVER_PROOF_MS);
    fake.keepalive.set(silent, new Date(1_000_000 + SERVER_PROOF_MS));
    setSystemTime(new Date(1_000_000 + SERVER_PROOF_MS));
    await room.alarm();
    expect(silent.closedWith?.code).toBe(SERVER_PROOF_CLOSE);
  });

  test(`slots: clients the PC has not answered count as waiting (${MAX_PENDING} at most, the oldest giving way) and close 1013 after ${HANDSHAKE_MS / 1000} s, so a real phone gets in`, async () => {
    setSystemTime(new Date(1_000_000));
    const fake = fakeState();
    const room = new RelayRoom(fake.state);
    await connectServer(room, fake);
    // sockets whose data socket attached but which never get past the handshake
    const unanswered = [];
    for (let index = 0; index < MAX_PENDING; index++) unanswered.push(await connectPair(room, fake));
    // one more: the oldest waiting client gives way to it
    const oldest = unanswered.shift()!;
    unanswered.push(await connectPair(room, fake));
    expect(oldest.client.closedWith?.code).toBe(CLOSE.TRY_AGAIN);
    expect(oldest.data.closedWith?.code).toBe(CLOSE.GOING_AWAY);
    expect(unanswered.map((pair) => pair.client.closedWith)).toEqual(unanswered.map(() => null));

    setSystemTime(new Date(1_000_000 + HANDSHAKE_MS - 2000));
    await room.alarm();
    expect(unanswered.map((pair) => pair.client.closedWith)).toEqual(unanswered.map(() => null));
    // the alarm is set for their deadline
    expect(fake.state.alarm).toBe(1_000_000 + HANDSHAKE_MS);
    setSystemTime(new Date(1_000_000 + HANDSHAKE_MS));
    for (const pair of unanswered) fake.keepalive.set(pair.client, new Date());
    await room.alarm();
    for (const pair of unanswered) {
      expect(pair.client.closedWith?.code).toBe(CLOSE.TRY_AGAIN);
      expect(pair.data.closedWith?.code).toBe(CLOSE.GOING_AWAY);
    }

    // a real phone: the PC answers, and the client keeps its slot past the deadline
    const phone = await connectPair(room, fake);
    room.webSocketMessage(phone.data, "handshake answer");
    expect(phone.client.sent.at(-1)).toBe("handshake answer");
    setSystemTime(new Date(1_000_000 + 3 * HANDSHAKE_MS));
    await room.alarm();
    expect(phone.client.closedWith).toBeNull();
  });

  test(`slots: while the PC is gone a waiting client waits up to ${OFFLINE_WAIT_MS / 1000} s, and a PC back in time gives it the full ${HANDSHAKE_MS / 1000} s again`, async () => {
    setSystemTime(new Date(1_000_000));
    const fake = fakeState();
    let room = new RelayRoom(fake.state);
    const control = await connectServer(room, fake);
    const waiting = await connect(room, fake, "role=client");
    closeFromFar(room, control);
    // evicted while the PC is away: the offline deadline is kept with the socket
    room = new RelayRoom(fake.state);
    setSystemTime(new Date(1_000_000 + OFFLINE_WAIT_MS - 1));
    await room.alarm();
    expect(waiting.closedWith).toBeNull();
    await connectServer(room, fake);
    const back = 1_000_000 + OFFLINE_WAIT_MS - 1;
    setSystemTime(new Date(back + HANDSHAKE_MS - 1));
    await room.alarm();
    expect(waiting.closedWith).toBeNull();
    setSystemTime(new Date(back + HANDSHAKE_MS));
    await room.alarm();
    expect(waiting.closedWith?.code).toBe(CLOSE.TRY_AGAIN);
  });

  test(`slots: a client waiting for a PC that is not connected is closed 1013 after ${OFFLINE_WAIT_MS / 1000} s, keepalives or not`, async () => {
    setSystemTime(new Date(1_000_000));
    const fake = fakeState();
    let room = new RelayRoom(fake.state);
    const waiting = await connect(room, fake, "role=client");
    expect(fake.state.alarm).toBe(1_000_000 + OFFLINE_WAIT_MS);
    setSystemTime(new Date(1_000_000 + OFFLINE_WAIT_MS - 1));
    room.webSocketMessage(waiting, KEEPALIVE_PING);
    fake.keepalive.set(waiting, new Date());
    // an eviction keeps the deadline with the socket
    room = new RelayRoom(fake.state);
    await room.alarm();
    expect(waiting.closedWith).toBeNull();
    setSystemTime(new Date(1_000_000 + OFFLINE_WAIT_MS));
    await room.alarm();
    expect(waiting.closedWith).toEqual({ code: CLOSE.TRY_AGAIN, reason: "the server is not connected" });
  });

  test(`at most ${MAX_PROVING} PC sockets wait on their challenge; the oldest gives way, and the PC still proves after a burst`, async () => {
    const fake = fakeState();
    const room = new RelayRoom(fake.state);
    const live = await connectServer(room, fake);
    const silent = [];
    for (let index = 0; index < MAX_PROVING; index++) silent.push(await connect(room, fake, `role=server&${proof()}`));
    expect(silent.map((socket) => socket.closedWith)).toEqual(silent.map(() => null));
    const pc = await connect(room, fake, `role=server&${proof()}`);
    expect(silent[0]!.closedWith?.code).toBe(CLOSE.TRY_AGAIN);
    expect(live.closedWith).toBeNull();
    room.webSocketMessage(pc, answerChallenge(pc.sent[0]!, PC, null)!);
    expect(pc.closedWith).toBeNull();
    expect(live.closedWith?.code).toBe(CLOSE.POLICY);
  });

  test("slots: a client waiting while no PC is connected gets its handshake deadline once the PC connects", async () => {
    setSystemTime(new Date(1_000_000));
    const fake = fakeState();
    const room = new RelayRoom(fake.state);
    const waiting = await connect(room, fake, "role=client");
    setSystemTime(new Date(1_000_000 + OFFLINE_WAIT_MS - 1));
    await room.alarm();
    expect(waiting.closedWith).toBeNull();
    await connectServer(room, fake);
    // the PC's arrival replaces the offline deadline with its own, which runs past it
    setSystemTime(new Date(1_000_000 + OFFLINE_WAIT_MS));
    await room.alarm();
    expect(waiting.closedWith).toBeNull();
    setSystemTime(new Date(1_000_000 + OFFLINE_WAIT_MS - 1 + HANDSHAKE_MS));
    await room.alarm();
    expect(waiting.closedWith).toEqual({ code: CLOSE.TRY_AGAIN, reason: "the server did not answer in time" });
  });

  test("a client whose held frames an evicted instance took is closed 1012 on its next frame, and the loss is counted", async () => {
    const fake = fakeState();
    const before = new RelayRoom(fake.state);
    await connectServer(before, fake);
    const client = await connect(before, fake, "role=client");
    const { connection_id } = client.json(0) as { connection_id: string };
    before.webSocketMessage(client, "first");
    const after = new RelayRoom(fake.state);
    after.webSocketMessage(client, "second");
    expect(client.closedWith?.code).toBe(CLOSE.RESTART);
    expect(after.heldFramesLost).toBe(1);
    // the PC's data socket finds no client to hand a partial stream to
    const data = await connectServer(after, fake, connection_id);
    expect(data.closedWith?.code).toBe(CLOSE.GOING_AWAY);
    expect(data.sent).toEqual([]);
  });
});

describe("relay Worker", () => {
  function env() {
    const asked: string[] = [];
    const limiter = (name: string) => {
      const value = { allow: true, limit: async ({ key }: { key: string }) => { asked.push(`${name}:${key}`); return { success: value.allow }; } };
      return value;
    };
    const rooms: string[] = [];
    const value = {
      RELAY: { idFromName: (name: string) => name, get: (id: unknown) => ({ fetch: async () => { rooms.push(id as string); return new Response(null, { status: 101 }); } }) },
      RELAY_LIMITER: limiter("address"),
      RELAY_GLOBAL_LIMITER: limiter("global"),
    } satisfies Env;
    return { env: value, asked, rooms };
  }
  const socketRequest = (query = "role=client") => new Request(url(query), { headers: { upgrade: "websocket", "cf-connecting-ip": "203.0.113.9" } });

  test("answers /health without a Durable Object", async () => {
    const { env: e, rooms, asked } = env();
    const response = await handle(new Request("https://relay.test/health"), e);
    expect([response.status, await response.text()]).toEqual([200, "ok"]);
    expect(rooms).toEqual([]);
    expect(asked).toEqual([]);
  });

  test("routes an admitted socket to its server_id's Durable Object", async () => {
    const { env: e, rooms, asked } = env();
    expect((await handle(socketRequest(), e)).status).toBe(101);
    expect(rooms).toEqual([SERVER]);
    expect(asked).toEqual(["address:203.0.113.9", "global:all"]);
  });

  test("refuses an address over its limit with 429 before any Durable Object, and asks the backstop only after", async () => {
    const { env: e, rooms, asked } = env();
    e.RELAY_LIMITER.allow = false;
    const response = await handle(socketRequest(), e);
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("60");
    expect(asked).toEqual(["address:203.0.113.9"]);
    e.RELAY_LIMITER.allow = true;
    e.RELAY_GLOBAL_LIMITER.allow = false;
    expect((await handle(socketRequest(), e)).status).toBe(429);
    expect(rooms).toEqual([]);
  });

  test("refuses malformed requests with 400 before asking any limiter", async () => {
    const { env: e, rooms, asked } = env();
    const bad = new Request(`https://relay.test/v1/ws?server_id=nothex&role=client&v=1`, { headers: { upgrade: "websocket" } });
    expect((await handle(bad, e)).status).toBe(400);
    expect(asked).toEqual([]);
    expect(rooms).toEqual([]);
  });
});

describe("relay Worker pairing rendezvous", () => {
  const pairUrl = (role: string, plate = "AB1") => `https://relay.test/v1/pair?nameplate=${plate}&role=${role}&v=1`;
  const openPair = async (room: RelayRoom, fake: ReturnType<typeof fakeState>, role: string) => {
    expect((await room.fetch(new Request(pairUrl(role), upgrade))).status).toBe(101);
    return fake.sockets.at(-1)!;
  };

  test("routes a pairing socket to the nameplate's own Durable Object, apart from every server_id", async () => {
    const rooms: string[] = [];
    const allow = { limit: async () => ({ success: true }) };
    const e = { RELAY: { idFromName: (name: string) => name, get: (id: unknown) => ({ fetch: async () => { rooms.push(id as string); return new Response(null, { status: 101 }); } }) }, RELAY_LIMITER: allow, RELAY_GLOBAL_LIMITER: allow } satisfies Env;
    expect((await handle(new Request(pairUrl("host"), { headers: { upgrade: "websocket" } }), e)).status).toBe(101);
    expect(rooms).toEqual(["pair:AB1"]);
  });

  test("host and guest meet, frames pass scoped to the attempt, and it survives an eviction", async () => {
    const fake = fakeState();
    let room = new RelayRoom(fake.state);
    const host = await openPair(room, fake, "host");
    expect(host.json(0)).toEqual({ type: "waiting" });
    const guest = await openPair(room, fake, "guest");
    const { attempt } = host.json(1) as { attempt: string };
    room = new RelayRoom(fake.state);
    room.webSocketMessage(guest, new Uint8Array([7]).buffer);
    const up = host.sent[2] as Uint8Array;
    expect(Array.from(up.slice(16))).toEqual([7]);
    expect(Array.from(up.slice(0, 16), (byte) => byte.toString(16).padStart(2, "0")).join("")).toBe(attempt);
    room.webSocketMessage(host, up.buffer.slice(0) as ArrayBuffer);
    expect(Array.from(guest.sent[0] as Uint8Array)).toEqual([7]);
    closeFromFar(room, host);
    expect(guest.closedWith?.code).toBe(1001);
  });

  test("a guest past its deadline passes nothing on, before any sweep", async () => {
    const fake = fakeState();
    setSystemTime(new Date(1_000_000));
    const room = new RelayRoom(fake.state);
    const host = await openPair(room, fake, "host");
    const guest = await openPair(room, fake, "guest");
    const before = host.sent.length;
    setSystemTime(new Date(1_000_000 + PAIR_GUEST_MS));
    room.webSocketMessage(guest, new Uint8Array([1]).buffer);
    expect(host.sent.length).toBe(before + 1);
    expect(host.json(before)).toMatchObject({ type: "gone" });
    expect(guest.closedWith?.code).toBe(1001);
  });

  test("a host that does not answer its key's challenge in time is closed 4401, and the nameplate is free again", async () => {
    const fake = fakeState();
    setSystemTime(new Date(1_000_000));
    const room = new RelayRoom(fake.state);
    expect((await room.fetch(new Request(`${pairUrl("host")}&server_id=${SERVER}&public_key=${PC.publicKey}`, upgrade))).status).toBe(101);
    const host = fake.sockets.at(-1)!;
    expect(host.json(0)).toMatchObject({ type: "server_challenge" });
    setSystemTime(new Date(1_000_000 + SERVER_PROOF_MS));
    await room.alarm();
    expect(host.closedWith?.code).toBe(SERVER_PROOF_CLOSE);
    expect((await openPair(room, fake, "host")).json(0)).toEqual({ type: "waiting" });
  });

  test("a host the runtime keeps answering keepalives for is not closed as idle", async () => {
    const fake = fakeState();
    setSystemTime(new Date(1_000_000));
    const room = new RelayRoom(fake.state);
    const host = await openPair(room, fake, "host");
    setSystemTime(new Date(1_000_000 + IDLE_MS + 1000));
    fake.keepalive.set(host, new Date(1_000_000 + IDLE_MS));
    await room.alarm();
    expect(host.closedWith).toBeNull();
  });
});

describe("relay usage counters", () => {
  /** an Analytics Engine dataset that records what it is given */
  const dataset = () => {
    const points: { indexes: string[]; blobs: string[]; doubles: number[] }[] = [];
    return { points, USAGE: { writeDataPoint: (point: (typeof points)[number]) => { points.push(point); } } };
  };

  test("reports a device session's bytes and time when it closes, across an eviction, under a key that is not the server_id", async () => {
    const usage = dataset();
    const fake = fakeState();
    setSystemTime(new Date(1_000_000));
    let room = new RelayRoom(fake.state, usage);
    const control = await connectServer(room, fake);
    const client = await connect(room, fake, "role=client");
    const { connection_id } = client.json(0) as { connection_id: string };
    room.webSocketMessage(client, "hello"); // held until the PC's data socket attaches, still traffic
    const data = await connectServer(room, fake, connection_id);
    room.webSocketMessage(data, "x".repeat(100)); // the PC answers: the session starts
    room = new RelayRoom(fake.state, usage); // evicted: the counts live with the socket
    room.webSocketMessage(client, new Uint8Array(40).buffer);
    room.webSocketMessage(client, KEEPALIVE_PING); // keepalives are not traffic
    room.webSocketMessage(data, "é"); // 2 bytes in UTF-8
    setSystemTime(new Date(1_000_000 + 90_000));
    closeFromFar(room, client);
    expect(usage.points).toEqual([{ indexes: [usageKey(SERVER)], blobs: ["device"], doubles: [45, 102, 90, 1] }]);
    expect(usageKey(SERVER)).not.toBe(SERVER);
    expect(JSON.stringify(usage.points)).not.toContain(connection_id);
    closeFromFar(room, control);
    expect(usage.points.at(-1)).toEqual({ indexes: [usageKey(SERVER)], blobs: ["pc"], doubles: [0, 0, 90, 1] });
  });

  test("a long connection reports every USAGE_REPORT_MS from the idle alarm, and only the rest when it closes", async () => {
    const usage = dataset();
    const fake = fakeState();
    const start = 1_000_000;
    setSystemTime(new Date(start));
    const room = new RelayRoom(fake.state, usage);
    const control = await connectServer(room, fake);
    const later = start + USAGE_REPORT_MS;
    setSystemTime(new Date(later));
    fake.keepalive.set(control, new Date(later)); // the runtime kept answering its keepalive
    await room.alarm();
    expect(control.closedWith).toBeNull();
    expect(usage.points).toEqual([{ indexes: [usageKey(SERVER)], blobs: ["pc"], doubles: [0, 0, USAGE_REPORT_MS / 1000, 0] }]);
    setSystemTime(new Date(later + 60_000));
    closeFromFar(room, control);
    expect(usage.points.at(-1)!.doubles).toEqual([0, 0, 60, 1]);
  });

  test("a client the PC never answered is no session", async () => {
    const usage = dataset();
    const fake = fakeState();
    const room = new RelayRoom(fake.state, usage);
    const client = await connect(room, fake, "role=client");
    room.webSocketMessage(client, "held");
    closeFromFar(room, client);
    expect(usage.points).toEqual([]);
  });
});


describe("relay pass", () => {
  const KID = "0badc0de";
  const T0 = Date.parse("2026-12-01T00:00:00Z");
  let signer: CryptoKey;
  let keys: string;
  beforeAll(async () => {
    const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]) as CryptoKeyPair;
    signer = pair.privateKey;
    const raw = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
    keys = `${KID}:${Array.from(raw, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
  });
  const passFor = (sid = SERVER, at = T0) => signRelayPass(signer, KID, sid, Math.floor(at / 1000));

  /** A Worker whose Durable Object for SERVER is one RelayRoom over fake sockets, behind `handle`. */
  async function world(mode: "grace" | "enforce", enforceAt?: string, fake = fakeState(), extra: Record<string, string> = {}) {
    setSystemTime(new Date(T0));
    const settings = { RELAY_PASS_MODE: mode, RELAY_PASS_KEYS: keys, ...(enforceAt ? { RELAY_PASS_ENFORCE_AT: enforceAt } : {}), ...extra };
    const box = { room: new RelayRoom(fake.state, settings) };
    await fake.state.ready;
    const allow = { limit: async () => ({ success: true }) };
    const e: Env = { ...settings, RELAY: { idFromName: (name: string) => name, get: () => ({ fetch: (request: Request) => box.room.fetch(request) }) }, RELAY_LIMITER: allow, RELAY_GLOBAL_LIMITER: allow };
    /** the socket the request ends on: the Durable Object's, or the one the Worker closed itself */
    const openAt = async (address: string, pass?: string, extra: Record<string, string> = {}) => {
      const before = fake.sockets.length;
      const response = await handle(new Request(address, { headers: { upgrade: "websocket", ...(pass ? { [RELAY_PASS_HEADER]: pass } : {}), ...extra } }), e);
      expect(response.status).toBe(101);
      return fake.sockets.length > before ? fake.sockets.at(-1)! : pairs.at(-1)![1];
    };
    const open = (query: string, pass?: string, extra: Record<string, string> = {}) => openAt(url(query), pass, extra);
    const openPair = (query: string, pass?: string) => openAt(`https://relay.test/v1/pair?nameplate=AB1&v=1&${query}`, pass);
    const prove = (socket: FakeSocket, connectionId: string | null = null) => {
      const answer = answerChallenge(socket.sent.shift(), PC, connectionId);
      if (answer) box.room.webSocketMessage(socket, answer);
      return socket;
    };
    const control = async (pass?: string) => prove(await open(`role=server&${proof()}`, pass));
    return { fake, box, open, openPair, prove, control, evict: async () => { box.room = new RelayRoom(fake.state, settings); await fake.state.ready; } };
  }

  test("while enforced, a pairing host needs a pass for the PC key it offers: 4402 in the Worker without one; with one it holds the nameplate once it proves the key, past an eviction", async () => {
    const w = await world("enforce");
    const keyed = `role=host&server_id=${SERVER}&public_key=${PC.publicKey}`;
    expect((await w.openPair("role=host", await passFor())).closedWith).toEqual({ code: 4402, reason: "relay pass required" });
    expect((await w.openPair(keyed)).closedWith).toEqual({ code: 4402, reason: "relay pass required" });
    expect(w.fake.sockets).toEqual([]);
    const host = await w.openPair(keyed, await passFor());
    const challenge = host.sent.shift();
    await w.evict();
    w.box.room.webSocketMessage(host, answerServerChallenge(challenge, PC.secretKey, { server_id: SERVER, role: "pair-host", connection_id: "AB1" })!);
    expect(host.json(0)).toEqual({ type: "waiting" });
    expect((await w.openPair("role=guest")).closedWith).toBeNull();
    expect(host.json(1)).toMatchObject({ type: "guest" });
  });

  test("while enforced, a PC socket without a pass closes 4402 in the Worker, before any Durable Object", async () => {
    const w = await world("enforce");
    for (const [pass, reason] of [[undefined, "relay pass required"], ["ovp1.nope.nope", "relay pass invalid"], [await passFor("f".repeat(32)), "relay pass invalid"],
      [await passFor(SERVER, T0 - (RELAY_PASS_LIFETIME_S + RELAY_PASS_SKEW_S) * 1000), "relay pass expired"]] as const) {
      const socket = await w.open(`role=server&${proof()}`, pass);
      expect(socket.closedWith).toEqual({ code: 4402, reason });
    }
    expect(w.fake.sockets).toEqual([]);
    // a client needs no pass
    expect((await w.open("role=client")).closedWith).toBeNull();
  });

  /** A Worker over fake limiters that record what they are asked; the address has spent its own budget unless `address` says otherwise. */
  function limitedWorld(allow: { address?: boolean; checks?: boolean } = {}) {
    setSystemTime(new Date(T0));
    const asked: string[] = [];
    const rooms: string[] = [];
    const limiter = (name: string, success: boolean) => ({ limit: async ({ key }: { key: string }) => { asked.push(`${name}:${key}`); return { success }; } });
    const e: Env = {
      RELAY_PASS_MODE: "enforce", RELAY_PASS_KEYS: keys,
      RELAY: { idFromName: (name: string) => name, get: (id: unknown) => ({ fetch: async () => { rooms.push(id as string); return new Response(null, { status: 101 }); } }) },
      RELAY_LIMITER: limiter("address", allow.address ?? false), RELAY_GLOBAL_LIMITER: limiter("global", true),
      RELAY_PC_LIMITER: limiter("pc", true), RELAY_PASS_CHECK_LIMITER: limiter("checks", allow.checks ?? true),
    };
    const request = (pass?: string) => new Request(url(`role=server&${proof()}`), { headers: { upgrade: "websocket", "cf-connecting-ip": "203.0.113.9", ...(pass ? { [RELAY_PASS_HEADER]: pass } : {}) } });
    return { e, asked, rooms, request };
  }

  test("once its address's budget is spent, a PC whose pass holds gets in on a budget of its own, so PCs behind one address get in", async () => {
    const w = limitedWorld();
    expect((await handle(w.request(await passFor()), w.e)).status).toBe(101);
    expect(w.asked).toEqual(["address:203.0.113.9", "checks:203.0.113.9", "global:all", `pc:${SERVER}`]);
    expect(w.rooms).toEqual([SERVER]);
  });

  test("past its address's budget, a pass for another PC, none, or one forged costs no signature check or only one counted one, and gets no way in", async () => {
    const w = limitedWorld();
    expect((await handle(w.request(await passFor("f".repeat(32))), w.e)).status).toBe(429);
    expect((await handle(w.request(), w.e)).status).toBe(429);
    expect(w.asked).toEqual(["address:203.0.113.9", "address:203.0.113.9"]);
    w.asked.length = 0;
    const good = await passFor();
    const forged = `${good.slice(0, -8)}${good.endsWith("AAAAAAAA") ? "BBBBBBBB" : "AAAAAAAA"}`;
    expect((await handle(w.request(forged), w.e)).status).toBe(429);
    expect(w.asked).toEqual(["address:203.0.113.9", "checks:203.0.113.9", "global:all"]);
    w.asked.length = 0;
    const spent = limitedWorld({ checks: false });
    expect((await handle(spent.request(good), spent.e)).status).toBe(429);
    expect(spent.asked).toEqual(["address:203.0.113.9", "checks:203.0.113.9"]);
    expect(w.rooms).toEqual([]);
  });

  test("within its address's budget a PC with its pass counts there like any socket, and its own budget is left alone", async () => {
    const w = limitedWorld({ address: true });
    expect((await handle(w.request(await passFor()), w.e)).status).toBe(101);
    expect(w.asked).toEqual(["address:203.0.113.9", "global:all"]);
  });

  test("a pairing host's nameplate does not outlive enforcement: no device joins it, and the alarm at the date closes it 4402", async () => {
    const enforceAt = T0 + 1000;
    const w = await world("grace", new Date(enforceAt).toISOString());
    const host = await w.openPair("role=host");
    expect(host.json(0)).toEqual({ type: "waiting" });
    expect(w.fake.state.alarm).toBe(enforceAt);
    setSystemTime(new Date(enforceAt));
    const guest = await w.openPair("role=guest");
    expect(host.closedWith).toEqual({ code: 4402, reason: "relay pass required" });
    expect(guest.closedWith?.code).toBe(4404);
    const late = await world("grace", new Date(enforceAt).toISOString());
    const held = await late.openPair("role=host");
    setSystemTime(new Date(enforceAt));
    await late.box.room.alarm();
    expect(held.closedWith).toEqual({ code: 4402, reason: "relay pass required" });
  });

  test("while enforced, a pairing host whose pass runs out loses its nameplate, and one that proves after enforcement began without a pass gets none", async () => {
    const keyed = `role=host&server_id=${SERVER}&public_key=${PC.publicKey}`;
    const answer = (frame: Frame | undefined) => answerServerChallenge(frame, PC.secretKey, { server_id: SERVER, role: "pair-host", connection_id: "AB1" })!;
    const w = await world("enforce");
    const host = await w.openPair(keyed, await passFor(SERVER, T0 - RELAY_PASS_LIFETIME_S * 1000 + 60_000));
    w.box.room.webSocketMessage(host, answer(host.sent.shift()));
    expect(host.json(0)).toEqual({ type: "waiting" });
    const lapse = T0 + 60_000 + RELAY_PASS_SKEW_S * 1000;
    setSystemTime(new Date(lapse));
    w.fake.keepalive.set(host, new Date(lapse));
    await w.box.room.alarm();
    expect(host.closedWith).toEqual({ code: 4402, reason: "relay pass expired" });
    const g = await world("grace", new Date(T0 + 1000).toISOString());
    const proving = await g.openPair(keyed);
    setSystemTime(new Date(T0 + 1000));
    g.box.room.webSocketMessage(proving, answer(proving.sent.shift()));
    expect(proving.closedWith).toEqual({ code: 4402, reason: "relay pass required" });
  });

  test("a pairing host does not outlive its PC's revocation or its pass key's removal", async () => {
    const keyed = `role=host&server_id=${SERVER}&public_key=${PC.publicKey}`;
    for (const extra of [{ RELAY_PASS_REVOKED: SERVER }, { RELAY_PASS_KEYS: `deadbeef:${keys.split(":")[1]}` }] as Record<string, string>[]) {
      const fake = fakeState();
      const first = await world("enforce", undefined, fake);
      const host = await first.openPair(keyed, await passFor());
      first.box.room.webSocketMessage(host, answerServerChallenge(host.sent.shift(), PC.secretKey, { server_id: SERVER, role: "pair-host", connection_id: "AB1" })!);
      expect(host.json(0)).toEqual({ type: "waiting" });
      // a deploy with the new settings: the next arrival finds the host's pass no longer holds
      const w = await world("enforce", undefined, fake, extra);
      const guest = await w.openPair("role=guest");
      expect(host.closedWith).toEqual({ code: 4402, reason: "relay pass invalid" });
      expect(guest.closedWith?.code).toBe(4404);
    }
  });

  test("a pairing host's guest goes with it once its PC is revoked: at its next frame, or at the next alarm", async () => {
    const keyed = `role=host&server_id=${SERVER}&public_key=${PC.publicKey}`;
    for (const by of ["frame", "alarm"] as const) {
      const fake = fakeState();
      const first = await world("enforce", undefined, fake);
      const host = await first.openPair(keyed, await passFor());
      first.box.room.webSocketMessage(host, answerServerChallenge(host.sent.shift(), PC.secretKey, { server_id: SERVER, role: "pair-host", connection_id: "AB1" })!);
      const guest = await first.openPair("role=guest");
      expect(host.json(1)).toMatchObject({ type: "guest" });
      const w = await world("enforce", undefined, fake, { RELAY_PASS_REVOKED: SERVER });
      const sent = host.sent.length;
      if (by === "frame") w.box.room.webSocketMessage(guest, new Uint8Array([1, 2, 3]).buffer);
      else await w.box.room.alarm();
      expect(host.closedWith).toEqual({ code: 4402, reason: "relay pass invalid" });
      expect(guest.closedWith?.code).toBe(1001);
      expect(host.sent).toHaveLength(sent);
    }
  });

  test("a pairing host admitted before its key id was kept stays until its pass runs out", async () => {
    const keyed = `role=host&server_id=${SERVER}&public_key=${PC.publicKey}`;
    const fake = fakeState();
    const first = await world("enforce", undefined, fake);
    const host = await first.openPair(keyed, await passFor());
    first.box.room.webSocketMessage(host, answerServerChallenge(host.sent.shift(), PC.secretKey, { server_id: SERVER, role: "pair-host", connection_id: "AB1" })!);
    // the attachment as the previous relay version saved it: the pass's expiry only
    const { pass_kid: _kid, server_id: _id, ...legacy } = host.deserializeAttachment() as Record<string, unknown>;
    host.serializeAttachment(legacy);
    await first.evict();
    expect((await first.openPair("role=guest")).closedWith).toBeNull();
    expect(host.closedWith).toBeNull();
    expect(host.json(1)).toMatchObject({ type: "guest" });
  });

  test("a pairing host admitted before its key id was kept goes once the settings revoke a PC: at its next arrival, frame or alarm", async () => {
    const keyed = `role=host&server_id=${SERVER}&public_key=${PC.publicKey}`;
    for (const by of ["arrival", "frame", "alarm"] as const) {
      const fake = fakeState();
      const first = await world("enforce", undefined, fake);
      const host = await first.openPair(keyed, await passFor());
      first.box.room.webSocketMessage(host, answerServerChallenge(host.sent.shift(), PC.secretKey, { server_id: SERVER, role: "pair-host", connection_id: "AB1" })!);
      expect(host.json(0)).toEqual({ type: "waiting" });
      // the attachment as the previous relay version saved it: the pass's expiry only
      const { pass_kid: _kid, server_id: _id, ...legacy } = host.deserializeAttachment() as Record<string, unknown>;
      host.serializeAttachment(legacy);
      await first.evict();
      // a deploy that revokes the PC: nothing on the attachment names it, so any revocation may
      const w = await world("enforce", undefined, fake, { RELAY_PASS_REVOKED: SERVER });
      if (by === "arrival") expect([by, (await w.openPair("role=guest")).closedWith?.code]).toEqual([by, 4404]);
      else if (by === "frame") w.box.room.webSocketMessage(host, new Uint8Array([1, 2, 3]).buffer);
      else await w.box.room.alarm();
      expect([by, host.closedWith]).toEqual([by, { code: 4402, reason: "relay pass invalid" }]);
    }
  });

  test("a pairing host whose pass holds crosses into enforcement, then wakes the room only at its own times", async () => {
    const enforceAt = T0 + 1000;
    const w = await world("grace", new Date(enforceAt).toISOString());
    const host = await w.openPair(`role=host&server_id=${SERVER}&public_key=${PC.publicKey}`, await passFor());
    expect(w.fake.state.alarm).toBe(enforceAt);
    w.box.room.webSocketMessage(host, answerServerChallenge(host.sent.shift(), PC.secretKey, { server_id: SERVER, role: "pair-host", connection_id: "AB1" })!);
    setSystemTime(new Date(enforceAt));
    w.fake.keepalive.set(host, new Date(enforceAt));
    await w.box.room.alarm();
    expect(host.closedWith).toBeNull();
    expect(w.fake.state.alarm).toBe(enforceAt + IDLE_MS);
  });

  test("in grace a pairing host whose pass ran out does not wake the room every second", async () => {
    const w = await world("grace", new Date(T0 + 24 * 3_600_000).toISOString());
    const host = await w.openPair(`role=host&server_id=${SERVER}&public_key=${PC.publicKey}`, await passFor(SERVER, T0 - RELAY_PASS_LIFETIME_S * 1000 + 60_000));
    w.box.room.webSocketMessage(host, answerServerChallenge(host.sent.shift(), PC.secretKey, { server_id: SERVER, role: "pair-host", connection_id: "AB1" })!);
    const lapse = T0 + 60_000 + RELAY_PASS_SKEW_S * 1000;
    setSystemTime(new Date(lapse));
    w.fake.keepalive.set(host, new Date(lapse));
    await w.box.room.alarm();
    expect(host.closedWith).toBeNull();
    expect(w.fake.state.alarm).toBe(lapse + IDLE_MS);
  });

  test("a check result the request itself carries is never trusted", async () => {
    const w = await world("enforce");
    const forged = JSON.stringify({ state: "ok", exp: T0 + 3_600_000 });
    expect((await w.open(`role=server&${proof()}`, undefined, { "x-ovis-relay-pass-checked": forged })).closedWith).toEqual({ code: 4402, reason: "relay pass required" });
  });

  test("a PC with its pass is let in, told so, and its proof authorizes the room past an eviction", async () => {
    const w = await world("enforce");
    const control = await w.control(await passFor());
    expect(control.json(0)).toMatchObject({ type: "sync", relay_pass: { state: "ok", enforce_at: null } });
    await w.evict();
    const client = await w.open("role=client");
    expect(client.json(0)).not.toHaveProperty("relay_pass");
    expect((w.fake.stored.get("pass_until") as { until: number }).until).toBe(T0 + RELAY_PASS_LIFETIME_S * 1000);
  });

  const passSaying = (newSessions: boolean, at = T0) => signRelayPass(signer, KID, SERVER, Math.floor(at / 1000), undefined, { newSessions });

  type World = Awaited<ReturnType<typeof world>>;
  /** a client of the room, and the connection_id the relay gave it */
  const clientOf = async (w: World) => {
    const socket = await w.open("role=client");
    return { socket, id: (socket.json(0) as { connection_id: string }).connection_id };
  };
  /** the PC's data socket for `id`, proven, opened with `pass` */
  const dataFor = async (w: World, id: string, pass: string) => w.prove(await w.open(`role=server&connection_id=${id}&${proof()}`, pass), id);
  /** the PC identified the device on `id` as one new to it, and says so on its control socket */
  const newSession = async (w: World, control: FakeSocket, id: string) => { await w.box.room.webSocketMessage(control, JSON.stringify({ type: "new_session", connection_id: id })); };
  const renew = async (w: World, control: FakeSocket, pass: string) => { await w.box.room.webSocketMessage(control, JSON.stringify({ type: "relay_pass", pass })); };
  const refused = { code: CLOSE.NEW_SESSIONS, reason: RELAY_NEW_SESSIONS_REFUSED };

  test("while enforced, a PC whose pass allows no new sessions keeps the clients it has, and a later renewal that allows them lifts the refusal, past an eviction", async () => {
    const w = await world("enforce");
    const control = await w.control(await passSaying(true));
    const kept = await clientOf(w);
    // the renewal issued next (it runs out later) says no new sessions
    const refusedAt = T0 + 3_600_000;
    setSystemTime(new Date(refusedAt));
    await renew(w, control, await passSaying(false, refusedAt));
    expect(w.fake.stored.get("pass_until")).toEqual({ until: refusedAt + RELAY_PASS_LIFETIME_S * 1000, kid: KID, noNew: true });
    await w.evict();
    const fresh = await clientOf(w);
    await newSession(w, control, fresh.id);
    expect(fresh.socket.closedWith).toEqual(refused);
    expect(kept.socket.closedWith).toBeNull();
    expect(control.closedWith).toBeNull();
    const allowedAt = refusedAt + 3_600_000;
    setSystemTime(new Date(allowedAt));
    await renew(w, control, await passSaying(true, allowedAt));
    expect(w.fake.stored.get("pass_until")).toEqual({ until: allowedAt + RELAY_PASS_LIFETIME_S * 1000, kid: KID });
    const later = await clientOf(w);
    await newSession(w, control, later.id);
    expect(later.socket.closedWith).toBeNull();
  });

  test("a renewal with the same expiry that allows no new sessions applies, and one that allows them lifts nothing", async () => {
    const w = await world("enforce");
    const control = await w.control(await passSaying(true));
    // issued the same second as the pass the room holds, so it runs out at the same time
    setSystemTime(new Date(T0 + 60_000));
    await renew(w, control, await passSaying(false));
    expect(w.fake.stored.get("pass_until")).toEqual({ until: T0 + RELAY_PASS_LIFETIME_S * 1000, kid: KID, noNew: true });
    setSystemTime(new Date(T0 + 120_000));
    await renew(w, control, await passSaying(true));
    expect(w.fake.stored.get("pass_until")).toEqual({ until: T0 + RELAY_PASS_LIFETIME_S * 1000, kid: KID, noNew: true });
    const fresh = await clientOf(w);
    await newSession(w, control, fresh.id);
    expect(fresh.socket.closedWith).toEqual(refused);
  });

  test("a pass with the same expiry proven later on a PC socket opened earlier never lifts a stricter one", async () => {
    const w = await world("enforce");
    const control = await w.control(await passSaying(true));
    const waiting = await clientOf(w);
    // the PC's data socket opens with the pass the PC held then, and is still proving when a renewal of the same second says no new sessions
    const data = await w.open(`role=server&connection_id=${waiting.id}&${proof()}`, await passSaying(true));
    await renew(w, control, await passSaying(false));
    w.prove(data, waiting.id);
    expect(data.closedWith).toBeNull();
    expect(w.fake.stored.get("pass_until")).toEqual({ until: T0 + RELAY_PASS_LIFETIME_S * 1000, kid: KID, noNew: true });
    await newSession(w, control, waiting.id);
    expect(waiting.socket.closedWith).toEqual(refused);
  });

  test("while enforced, only a client the PC identified as a new device is refused: its own devices, reconnecting ones included, get in", async () => {
    const w = await world("enforce");
    const control = await w.control(await passSaying(false));
    // the owner's device: the PC answers it and names nothing
    const own = await clientOf(w);
    expect(own.socket.closedWith).toBeNull();
    const data = await dataFor(w, own.id, await passSaying(false));
    w.box.room.webSocketMessage(data, "welcome");
    expect(own.socket.sent.at(-1)).toBe("welcome");
    // its socket drops and it comes back: a device the PC counts already, not a new session
    closeFromFar(w.box.room, own.socket);
    const again = await clientOf(w);
    const dataAgain = await dataFor(w, again.id, await passSaying(false));
    // what a data socket sends is the client's, never a word to the relay
    const lookalike = JSON.stringify({ type: "new_session", connection_id: again.id });
    w.box.room.webSocketMessage(dataAgain, lookalike);
    expect(again.socket.sent.at(-1)).toBe(lookalike);
    expect(again.socket.closedWith).toBeNull();
    // a device new to the PC: refused once the PC identified it
    const stranger = await clientOf(w);
    await newSession(w, control, stranger.id);
    expect(stranger.socket.closedWith).toEqual(refused);
    expect(again.socket.closedWith).toBeNull();
    expect(control.closedWith).toBeNull();
  });

  test("a client that waited while the PC was away is refused too once the PC, back with a pass that allows no new sessions, identifies it as a new device", async () => {
    const w = await world("enforce");
    const queued = await clientOf(w);
    expect(queued.socket.closedWith).toBeNull();
    const control = await w.control(await passSaying(false));
    expect(control.json(0)).toMatchObject({ type: "sync", connection_ids: [queued.id] });
    const data = await dataFor(w, queued.id, await passSaying(false));
    w.box.room.webSocketMessage(data, "handshake");
    await newSession(w, control, queued.id);
    expect(queued.socket.closedWith).toEqual(refused);
    expect(data.closedWith?.code).toBe(CLOSE.GOING_AWAY);
  });

  test("a client the PC has not identified hears nothing of a pass that allows no new sessions", async () => {
    const w = await world("enforce");
    await w.control(await passSaying(false));
    const stranger = await clientOf(w);
    expect(stranger.socket.closedWith).toBeNull();
    expect(stranger.socket.json(0)).toEqual({ type: "assigned", connection_id: stranger.id });
    // never answered, it closes as any client the PC does not answer
    setSystemTime(new Date(T0 + HANDSHAKE_MS));
    await w.box.room.alarm();
    expect(stranger.socket.closedWith).toEqual({ code: CLOSE.TRY_AGAIN, reason: "the server did not answer in time" });
  });

  test("a PC socket's proof says for the room that its pass allows no new sessions; in grace a new device still gets in", async () => {
    const enforced = await world("enforce");
    const control = await enforced.control(await passSaying(false));
    const refusedClient = await clientOf(enforced);
    await newSession(enforced, control, refusedClient.id);
    expect(refusedClient.socket.closedWith).toEqual(refused);
    const grace = await world("grace");
    const graceControl = await grace.control(await passSaying(false));
    const admitted = await clientOf(grace);
    await newSession(grace, graceControl, admitted.id);
    expect(admitted.socket.closedWith).toBeNull();
    expect(grace.fake.stored.get("pass_until")).toMatchObject({ noNew: true });
  });

  test("a pass whose proof fails authorizes nothing", async () => {
    const w = await world("grace");
    const socket = await w.open(`role=server&${proof()}`, await passFor());
    socket.sent.shift();
    w.box.room.webSocketMessage(socket, JSON.stringify({ type: "server_proof", answer: "0".repeat(64) }));
    expect(socket.closedWith?.code).toBe(SERVER_PROOF_CLOSE);
    expect(w.fake.stored.has("pass_until")).toBe(false);
  });

  test("in grace a PC without a pass is let in and told when it will need one; its clients hear it too", async () => {
    const w = await world("grace", "2027-01-01T00:00:00.000Z");
    const control = await w.control();
    expect(control.closedWith).toBeNull();
    expect(control.json(0)).toEqual({ type: "sync", connection_ids: [], warm: expect.any(String), relay_pass: { state: "missing", enforce_at: "2027-01-01T00:00:00.000Z", mode: "grace" } });
    const client = await w.open("role=client");
    expect(client.json(0)).toEqual({ type: "assigned", connection_id: expect.any(String), relay_pass: { state: "missing", enforce_at: "2027-01-01T00:00:00.000Z", mode: "grace" } });
    // the alarm comes at the date, and from then the sockets let in without a pass go, the client with its PC
    expect(w.fake.state.alarm).not.toBeNull();
    const { connection_id } = client.json(0) as { connection_id: string };
    const data = w.prove(await w.open(`role=server&connection_id=${connection_id}&${proof()}`), connection_id);
    setSystemTime(new Date("2027-01-01T00:00:01Z"));
    await w.box.room.alarm();
    expect(control.closedWith).toEqual({ code: 4402, reason: "relay pass required" });
    expect(data.closedWith).toEqual({ code: 4402, reason: "relay pass required" });
    expect(client.closedWith?.code).toBe(CLOSE.RESTART);
  });

  test("a renewal on the control socket keeps the room past its first pass; without one its PC sockets close 4402", async () => {
    const w = await world("enforce");
    const control = await w.control(await passFor());
    const firstEnd = T0 + (RELAY_PASS_LIFETIME_S + RELAY_PASS_SKEW_S) * 1000;
    const renewedAt = T0 + 12 * 3_600_000;
    setSystemTime(new Date(renewedAt));
    // a renewal for another PC, and one that would move the expiry back, change nothing
    await w.box.room.webSocketMessage(control, JSON.stringify({ type: "relay_pass", pass: await passFor("f".repeat(32), renewedAt) }));
    setSystemTime(new Date(renewedAt + 60_000));
    await w.box.room.webSocketMessage(control, JSON.stringify({ type: "relay_pass", pass: await passFor(SERVER, T0 - 3_600_000) }));
    setSystemTime(new Date(renewedAt + 120_000));
    expect((w.fake.stored.get("pass_until") as { until: number }).until).toBe(T0 + RELAY_PASS_LIFETIME_S * 1000);
    // fields in any order
    await w.box.room.webSocketMessage(control, JSON.stringify({ pass: await passFor(SERVER, renewedAt), type: "relay_pass" }));
    expect((w.fake.stored.get("pass_until") as { until: number }).until).toBe(renewedAt + RELAY_PASS_LIFETIME_S * 1000);
    expect(control.sent).toHaveLength(1);
    setSystemTime(new Date(firstEnd + 1000));
    w.fake.keepalive.set(control, new Date(firstEnd + 1000));
    await w.box.room.alarm();
    expect(control.closedWith).toBeNull();
    const lapse = renewedAt + (RELAY_PASS_LIFETIME_S + RELAY_PASS_SKEW_S) * 1000;
    setSystemTime(new Date(lapse));
    w.fake.keepalive.set(control, new Date(lapse));
    await w.box.room.alarm();
    expect(control.closedWith).toEqual({ code: 4402, reason: "relay pass expired" });
  });

  test("a saved authorization does not outlive the PC's revocation or its key's removal", async () => {
    const fake = fakeState();
    const first = await world("enforce", undefined, fake);
    await first.control(await passFor());
    for (const extra of [{ RELAY_PASS_REVOKED: SERVER }, { RELAY_PASS_KEYS: `deadbeef:${keys.split(":")[1]}` }] as Record<string, string>[]) {
      // a deploy with the new settings: the room comes back with what it saved, the PC reconnects in grace without a pass
      const w = await world("grace", "2026-12-01T00:00:01.000Z", fake, extra);
      const control = await w.control();
      expect(control.json(0)).toMatchObject({ relay_pass: { state: "missing" } });
      setSystemTime(new Date("2026-12-01T00:00:02Z"));
      await w.box.room.alarm();
      expect(control.closedWith?.code).toBe(4402);
    }
  });

  test("grace wakes the room when enforcement begins", async () => {
    const w = await world("grace", "2026-12-01T00:00:01.000Z");
    await w.control();
    expect(w.fake.state.alarm).toBe(Date.parse("2026-12-01T00:00:01.000Z"));
  });

  test("a pass that runs out while its socket proves does not let it in", async () => {
    const w = await world("enforce");
    const pass = await passFor(SERVER, T0 - (RELAY_PASS_LIFETIME_S + RELAY_PASS_SKEW_S) * 1000 + 1000);
    const socket = await w.open(`role=server&${proof()}`, pass);
    expect(socket.closedWith).toBeNull();
    setSystemTime(new Date(T0 + 1500));
    w.prove(socket);
    expect(socket.closedWith).toEqual({ code: 4402, reason: "relay pass expired" });
  });

  test("a control socket has at most one renewal checked a minute", async () => {
    const w = await world("enforce");
    const control = await w.control(await passFor());
    const later = T0 + 3_600_000;
    setSystemTime(new Date(later));
    const forged = await passFor("f".repeat(32), later);
    await w.box.room.webSocketMessage(control, JSON.stringify({ type: "relay_pass", pass: forged }));
    // within the minute even a good renewal waits
    await w.box.room.webSocketMessage(control, JSON.stringify({ type: "relay_pass", pass: await passFor(SERVER, later) }));
    expect((w.fake.stored.get("pass_until") as { until: number }).until).toBe(T0 + RELAY_PASS_LIFETIME_S * 1000);
    setSystemTime(new Date(later + 60_000));
    await w.box.room.webSocketMessage(control, JSON.stringify({ type: "relay_pass", pass: await passFor(SERVER, later) }));
    expect((w.fake.stored.get("pass_until") as { until: number }).until).toBe(later + RELAY_PASS_LIFETIME_S * 1000);
  });

  test("storage is read only for a PC's room while passes are on: never with passes off, never for a pairing room", async () => {
    const off = fakeState();
    const offRoom = new RelayRoom(off.state, {});
    await off.state.ready;
    await connectServer(offRoom, off);
    expect(off.reads).toEqual([]);
    const w = await world("grace");
    expect((await w.box.room.fetch(new Request("https://relay.test/v1/pair?nameplate=ABC&role=host&v=1", upgrade))).status).toBe(101);
    expect(w.fake.reads).toEqual([]);
    await w.control();
    expect(w.fake.reads).toEqual(["pass_until"]);
  });

  test("an unknown mode is off, and settings that do not parse never stop the Worker routing", async () => {
    const allow = { limit: async () => ({ success: true }) };
    const rooms: string[] = [];
    for (const settings of [{ RELAY_PASS_MODE: "strict" }, { RELAY_PASS_MODE: "enforce" }, { RELAY_PASS_MODE: "grace", RELAY_PASS_KEYS: keys, RELAY_PASS_ENFORCE_AT: "04 Dec 2027 00:12:00 GMT" }]) {
      const e: Env = { ...settings, RELAY: { idFromName: (name: string) => name, get: (id: unknown) => ({ fetch: async () => { rooms.push(id as string); return new Response(null, { status: 101 }); } }) }, RELAY_LIMITER: allow, RELAY_GLOBAL_LIMITER: allow };
      expect((await handle(new Request(url(`role=server&${proof()}`), upgrade), e)).status).toBe(101);
    }
    expect(rooms).toEqual([SERVER, SERVER, SERVER]);
  });

  test("past its expiry nothing more passes between a PC and its client, even before the sweep", async () => {
    const w = await world("enforce");
    const control = await w.control(await passFor());
    const client = await w.open("role=client");
    const { connection_id } = client.json(0) as { connection_id: string };
    const data = w.prove(await w.open(`role=server&connection_id=${connection_id}&${proof()}`, await passFor()), connection_id);
    await w.box.room.webSocketMessage(data, "before");
    expect(client.sent.at(-1)).toBe("before");
    setSystemTime(new Date(T0 + (RELAY_PASS_LIFETIME_S + RELAY_PASS_SKEW_S) * 1000));
    await w.box.room.webSocketMessage(data, "after");
    expect(client.sent).not.toContain("after");
    expect(data.closedWith).toEqual({ code: 4402, reason: "relay pass expired" });
    expect(control.closedWith).toEqual({ code: 4402, reason: "relay pass expired" });
  });

  test("a warm socket whose room's pass ran out hears why: 4402, not its control socket's going", async () => {
    const w = await world("enforce");
    const control = await w.control(await passFor());
    const warm = await w.open(`role=server&warm=${generationOf(control)}&${proof()}`, await passFor());
    const answer = answerServerChallenge(warm.sent.shift(), PC.secretKey, { server_id: SERVER, role: "warm", connection_id: generationOf(control) });
    await w.box.room.webSocketMessage(warm, answer!);
    const lapse = T0 + (RELAY_PASS_LIFETIME_S + RELAY_PASS_SKEW_S) * 1000;
    setSystemTime(new Date(lapse));
    w.fake.keepalive.set(control, new Date(lapse));
    w.fake.keepalive.set(warm, new Date(lapse));
    await w.box.room.alarm();
    expect(warm.closedWith).toEqual({ code: 4402, reason: "relay pass expired" });
  });
});

