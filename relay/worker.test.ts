import { afterAll, afterEach, beforeAll, describe, expect, setSystemTime, test } from "bun:test";
import { SERVER_PROOF_CLOSE, SERVER_PROOF_MS } from "../shared/relay-server-proof.ts";
import { CLOSE, HANDSHAKE_MS, IDLE_MS, KEEPALIVE_PING, KEEPALIVE_PONG, MAX_CLIENTS, MAX_PENDING, MAX_PROVING, OFFLINE_WAIT_MS, USAGE_REPORT_MS, type Frame } from "./core.ts";
import { answerChallenge, newServer, type TestServer } from "./relay-test-client.ts";
import { RelayRoom, handle, usageKey, type Env, type HibernatableSocket, type RelayState } from "./worker.ts";

/** the server end of a Cloudflare WebSocketPair: records what the room sends and how it closes */
class FakeSocket implements HibernatableSocket {
  sent: Frame[] = [];
  closedWith: { code: number; reason: string } | null = null;
  private attachment: unknown = null;
  send(frame: Frame) {
    if (this.closedWith) throw new Error("socket closed");
    this.sent.push(frame);
  }
  close(code = 1005, reason = "") {
    if (this.closedWith) throw new Error("already closed");
    this.closedWith = { code, reason };
  }
  serializeAttachment(value: unknown) { this.attachment = structuredClone(value); }
  deserializeAttachment() { return structuredClone(this.attachment); }
  json(index: number) { return JSON.parse(this.sent[index] as string) as Record<string, unknown>; }
}

const runtime = globalThis as unknown as Record<string, unknown>;
const saved = { WebSocketPair: runtime["WebSocketPair"], WebSocketRequestResponsePair: runtime["WebSocketRequestResponsePair"] };
beforeAll(() => {
  runtime["WebSocketPair"] = class { 0 = new FakeSocket(); 1 = new FakeSocket(); };
  runtime["WebSocketRequestResponsePair"] = class { constructor(readonly request: string, readonly response: string) {} };
});
afterAll(() => Object.assign(runtime, saved));
afterEach(() => setSystemTime());

/** DurableObjectState over the fake sockets; it outlives a RelayRoom as the real one outlives an eviction */
function fakeState() {
  const sockets: FakeSocket[] = [];
  const keepalive = new Map<HibernatableSocket, Date>();
  const state: RelayState & { autoResponse: unknown; alarm: number | null } = {
    autoResponse: null,
    alarm: null,
    acceptWebSocket: (socket: HibernatableSocket) => { sockets.push(socket as FakeSocket); },
    // the runtime stops listing a socket once its close is through
    getWebSockets: () => sockets.filter((socket) => !socket.closedWith),
    setWebSocketAutoResponse: (pair?: unknown) => { state.autoResponse = pair; },
    getWebSocketAutoResponseTimestamp: (socket: HibernatableSocket) => keepalive.get(socket) ?? null,
    storage: {
      getAlarm: async () => state.alarm,
      setAlarm: async (time: number) => { state.alarm = time; },
    },
  };
  return { state, sockets, keepalive };
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

/** what the runtime does when a socket closes: the room hears it */
function closeFromFar(room: RelayRoom, socket: FakeSocket) {
  socket.closedWith ??= { code: 1000, reason: "" };
  room.webSocketClose(socket);
}

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
    expect(control.json(0)).toEqual({ type: "sync", connection_ids: [] });
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
    expect(first.json(0)).toEqual({ type: "sync", connection_ids: [] });
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
    expect(second.json(1)).toEqual({ type: "sync", connection_ids: [] });
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
