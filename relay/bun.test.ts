import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { startBunRelay, type BunRelay } from "./bun.ts";
import { SERVER_PROOF_CLOSE } from "../shared/relay-server-proof.ts";
import { BUFFER_FRAMES, CLOSE, KEEPALIVE_PING, KEEPALIVE_PONG, MAX_CLIENTS, MAX_MESSAGE_BYTES, MAX_PENDING } from "./core.ts";
import { Peer, answerChallenge, equalBytes, establish, newServer, openPair, openServer, randomServerId, relayUrls } from "./relay-test-client.ts";

let relay: BunRelay;
let base: string;
let http: string;
beforeAll(() => {
  // This suite deliberately opens more than a minute's default budget in one run.
  relay = startBunRelay({ port: 0, limits: { perAddressPerMinute: 10_000, globalPerMinute: 10_000 } });
  base = `ws://127.0.0.1:${relay.port}`;
  http = `http://127.0.0.1:${relay.port}`;
});
afterAll(() => relay.stop());

const randomBytes = (size: number) => crypto.getRandomValues(new Uint8Array(size));
/** crypto.getRandomValues takes at most 64 KiB at a time */
const bigRandom = (size: number) => {
  const out = new Uint8Array(size);
  for (let offset = 0; offset < size; offset += 65536) out.set(randomBytes(Math.min(65536, size - offset)), offset);
  return out;
};

describe("relay over HTTP", () => {
  test("/health answers 200 ok", async () => {
    const response = await fetch(`${http}/health`);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("ok");
  });

  test("refuses malformed socket requests before upgrading", async () => {
    const id = randomServerId();
    const cases: [string, number][] = [
      ["/nope", 404],
      [`/v1/ws?server_id=${id.toUpperCase()}&role=server&v=1`, 400],
      [`/v1/ws?server_id=${id.slice(1)}&role=server&v=1`, 400],
      [`/v1/ws?server_id=${"g".repeat(32)}&role=server&v=1`, 400],
      [`/v1/ws?role=server&v=1`, 400],
      [`/v1/ws?server_id=${id}&role=admin&v=1`, 400],
      [`/v1/ws?server_id=${id}&v=1`, 400],
      [`/v1/ws?server_id=${id}&role=client&connection_id=${id}&v=1`, 400],
      [`/v1/ws?server_id=${id}&role=server&connection_id=xyz&v=1`, 400],
      // a valid request that is not a WebSocket upgrade
      [`/v1/ws?server_id=${id}&role=server&v=1`, 426],
    ];
    for (const [path, status] of cases) expect([path, (await fetch(`${http}${path}`)).status]).toEqual([path, status]);
  });

  test("a fake limiter refuses an address over its limit with 429, and the global backstop for all", async () => {
    const asked: string[] = [];
    const limiter = (name: string) => {
      const value = { allow: true, limit: async ({ key }: { key: string }) => { asked.push(`${name}:${key}`); return { success: value.allow }; } };
      return value;
    };
    const perAddress = limiter("address");
    const global = limiter("global");
    const limited = startBunRelay({ port: 0, limiters: { perAddress, global } });
    try {
      const server = newServer();
      const url = relayUrls(`ws://127.0.0.1:${limited.port}`, server).control;
      const ok = await openServer(url, server);
      expect(await ok.json("sync")).toEqual({ type: "sync", connection_ids: [] });
      ok.socket.close();
      expect(asked).toEqual(["address:127.0.0.1", "global:all"]);

      perAddress.allow = false;
      asked.length = 0;
      const upgrade = { headers: { upgrade: "websocket", connection: "Upgrade", "sec-websocket-version": "13", "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==" } };
      const refused = await fetch(url.replace("ws://", "http://"), upgrade);
      expect(refused.status).toBe(429);
      expect(refused.headers.get("retry-after")).toBe("60");
      // one address over its limit never uses up the cap every address shares
      expect(asked).toEqual(["address:127.0.0.1"]);

      perAddress.allow = true;
      global.allow = false;
      asked.length = 0;
      expect((await fetch(url.replace("ws://", "http://"), upgrade)).status).toBe(429);
      expect(asked).toEqual(["address:127.0.0.1", "global:all"]);
    } finally {
      await limited.stop();
    }
  });
});

describe("relay sockets", () => {
  test("an unknown or missing wire version closes 1008", async () => {
    const id = randomServerId();
    for (const query of [`server_id=${id}&role=server&v=2`, `server_id=${id}&role=client`, `server_id=${id}&role=client&v=01`]) {
      const peer = await Peer.open(`${base}/v1/ws?${query}`);
      expect(await peer.closeCode(query)).toBe(CLOSE.POLICY);
    }
  });

  test("pairs control, client and data, and passes text and binary unchanged both ways", async () => {
    const { client, data, connectionId } = await openPair(base, newServer());
    expect(connectionId).toMatch(/^[0-9a-f]{32}$/);
    const frames = [randomBytes(1), randomBytes(22 * 1024), "hello \u{1F600} text", bigRandom(MAX_MESSAGE_BYTES), JSON.stringify({ type: "connected", connection_id: "spoof" })];
    for (const frame of frames) {
      client.socket.send(frame);
      const there = await data.next("client -> data");
      expect(typeof there).toBe(typeof frame);
      expect(equalBytes(there, frame)).toBe(true);
      data.socket.send(frame);
      const back = await client.next("data -> client");
      expect(typeof back).toBe(typeof frame);
      expect(equalBytes(back, frame)).toBe(true);
    }
  });

  test("answers the keepalive itself and passes nothing on", async () => {
    const { control, client, data } = await openPair(base, newServer());
    control.socket.send(KEEPALIVE_PING);
    expect(await control.next("pong")).toBe(KEEPALIVE_PONG);
    client.socket.send(KEEPALIVE_PING);
    expect(await client.next("pong")).toBe(KEEPALIVE_PONG);
    // the next frame the data socket sees is the one after the ping
    client.socket.send("after");
    expect(await data.next()).toBe("after");
  });

  test("holds a client's frames until its data socket attaches, then hands them over in order", async () => {
    const id = newServer();
    const urls = relayUrls(base, id);
    const control = await openServer(urls.control, id);
    await control.json("sync");
    const client = await Peer.open(urls.client);
    const { connection_id } = await client.json("assigned") as { connection_id: string };
    await control.json("connected");
    const sent = Array.from({ length: BUFFER_FRAMES }, (_, index) => index % 2 ? randomBytes(1 + index) : `frame ${index}`);
    for (const frame of sent) client.socket.send(frame);
    // a ping round trip after them: the relay has taken every frame before the data socket asks
    client.socket.send(KEEPALIVE_PING);
    expect(await client.next("pong")).toBe(KEEPALIVE_PONG);
    const data = await openServer(urls.data(connection_id), id, connection_id);
    for (const frame of sent) expect(equalBytes(await data.next("held frame"), frame)).toBe(true);
    client.socket.send("live");
    expect(await data.next("live frame")).toBe("live");
  });

  test("closes a client 1013 that sends more than 200 frames or 1 MiB before the PC attaches", async () => {
    const id = newServer();
    const urls = relayUrls(base, id);
    const control = await openServer(urls.control, id);
    await control.json("sync");

    const many = await Peer.open(urls.client);
    await many.json("assigned");
    for (let index = 0; index <= BUFFER_FRAMES; index++) many.socket.send(`f${index}`);
    expect(await many.closeCode("too many frames")).toBe(CLOSE.TRY_AGAIN);

    const big = await Peer.open(urls.client);
    await big.json("assigned");
    // 17 frames of 60 KiB fit in 1 MiB, the 18th does not
    for (let index = 0; index < 18; index++) big.socket.send(randomBytes(60 * 1024));
    expect(await big.closeCode("too many bytes")).toBe(CLOSE.TRY_AGAIN);
  });

  test("a newer control socket replaces the older with 1008 and hears the clients still waiting", async () => {
    const id = newServer();
    const urls = relayUrls(base, id);
    const first = await openServer(urls.control, id);
    expect(await first.json("sync")).toEqual({ type: "sync", connection_ids: [] });
    const paired = await openPair(base, id, first);
    const waiting = await Peer.open(urls.client);
    const { connection_id } = await waiting.json("assigned") as { connection_id: string };
    await first.json("connected");
    const second = await openServer(urls.control, id);
    expect(await first.closeCode("replaced control")).toBe(CLOSE.POLICY);
    expect(await second.json("sync")).toEqual({ type: "sync", connection_ids: [connection_id] });
    // the pair already attached keeps working without its control socket
    paired.client.socket.send("still");
    expect(await paired.data.next()).toBe("still");
  });

  test("a client going away closes its data socket 1001 and tells the PC; the data socket going away closes its client 1012", async () => {
    const id = newServer();
    const one = await openPair(base, id);
    one.client.socket.close(1000);
    expect(await one.data.closeCode("data after client left")).toBe(CLOSE.GOING_AWAY);
    expect(await one.control.json("disconnected")).toEqual({ type: "disconnected", connection_id: one.connectionId });

    const two = await openPair(base, id, one.control);
    two.data.socket.close(1000);
    expect(await two.client.closeCode("client after data left")).toBe(CLOSE.RESTART);
  });

  test("refuses a data socket for no client (1001) and a second one for the same client (1008)", async () => {
    const id = newServer();
    const urls = relayUrls(base, id);
    const strayId = randomServerId();
    const stray = await openServer(urls.data(strayId), id, strayId);
    expect(await stray.closeCode("stray data")).toBe(CLOSE.GOING_AWAY);
    const { connectionId, client, data } = await openPair(base, id);
    const again = await openServer(urls.data(connectionId), id, connectionId);
    expect(await again.closeCode("second data")).toBe(CLOSE.POLICY);
    client.socket.send("first still owns it");
    expect(await data.next()).toBe("first still owns it");
  });

  test(`refuses the ${MAX_CLIENTS + 1}th client the PC answered, and closes the oldest of ${MAX_PENDING + 1} it has not, with 1013`, async () => {
    const id = newServer();
    const urls = relayUrls(base, id);
    const control = await openServer(urls.control, id);
    await control.json("sync");
    const waiting: Peer[] = [];
    for (let index = 0; index < MAX_PENDING; index++) {
      const client = await Peer.open(urls.client);
      await client.json("assigned");
      await control.json("connected");
      waiting.push(client);
    }
    const newest = await Peer.open(urls.client);
    await newest.json("assigned");
    expect(await waiting.shift()!.closeCode("the oldest waiting")).toBe(CLOSE.TRY_AGAIN);
    expect((await control.json("disconnected"))["type"]).toBe("disconnected");
    expect((await control.json("connected"))["type"]).toBe("connected");
    waiting.push(newest);
    for (const client of waiting) client.socket.close();
    for (let index = 0; index < MAX_PENDING; index++) await control.json("disconnected");

    for (let index = 0; index < MAX_CLIENTS; index++) await establish(await openPair(base, id, control));
    const ninth = await Peer.open(urls.client);
    expect(await ninth.closeCode("9th client")).toBe(CLOSE.TRY_AGAIN);
    // another server_id is not affected
    const other = await openPair(base, newServer());
    expect(other.connectionId).toMatch(/^[0-9a-f]{32}$/);
  });

  test("closes a socket 1009 that sends a frame over 64 KiB", async () => {
    const { client, data } = await openPair(base, newServer());
    client.socket.send(new Uint8Array(MAX_MESSAGE_BYTES + 1));
    expect(await client.closeCode("too big")).toBe(CLOSE.TOO_BIG);
    expect(await data.closeCode("its data socket")).toBe(CLOSE.GOING_AWAY);
  });
});

describe("relay admission over real sockets", () => {
  test("takeover: without the PC's secret key, a control socket is closed 4401 and the PC keeps its room", async () => {
    const pc = newServer();
    const urls = relayUrls(base, pc);
    const live = await openServer(urls.control, pc);
    await live.json("sync");
    const other = newServer();
    // no proof; another key; the right public key with a wrong answer; a replayed answer; not JSON
    const bare = await Peer.open(`${base}/v1/ws?server_id=${pc.serverId}&role=server&v=1`);
    expect(await bare.closeCode("no proof")).toBe(SERVER_PROOF_CLOSE);
    const wrongKey = await Peer.open(urls.control.replace(pc.publicKey, other.publicKey));
    expect(await wrongKey.closeCode("another key")).toBe(SERVER_PROOF_CLOSE);
    const wrongAnswer = await Peer.open(urls.control);
    wrongAnswer.socket.send(answerChallenge(await wrongAnswer.next("challenge"), pc, null, other.secretKey)!);
    expect(await wrongAnswer.closeCode("wrong answer")).toBe(SERVER_PROOF_CLOSE);
    const garbage = await Peer.open(urls.control);
    await garbage.next("challenge");
    garbage.socket.send(new Uint8Array([0, 255]));
    expect(await garbage.closeCode("binary answer")).toBe(SERVER_PROOF_CLOSE);
    // the live PC was never replaced and still hears its clients
    live.socket.send(KEEPALIVE_PING);
    expect(await live.next("pong")).toBe(KEEPALIVE_PONG);
    const pair = await openPair(base, pc, live);
    await establish(pair);
  });

  test("takeover: a forged data socket gets none of a waiting phone's frames, and the PC's own still attaches", async () => {
    const pc = newServer();
    const urls = relayUrls(base, pc);
    const control = await openServer(urls.control, pc);
    await control.json("sync");
    const client = await Peer.open(urls.client);
    const { connection_id } = await client.json("assigned") as { connection_id: string };
    await control.json("connected");
    client.socket.send("held ciphertext");
    const forged = await Peer.open(urls.data(connection_id));
    forged.socket.send(answerChallenge(await forged.next("challenge"), pc, connection_id, newServer().secretKey)!);
    expect(await forged.closeCode("forged data")).toBe(SERVER_PROOF_CLOSE);
    expect(forged.pending).toBe(0);
    const data = await openServer(urls.data(connection_id), pc, connection_id);
    expect(await data.next("held frame")).toBe("held ciphertext");
  });

  test(`slots: clients the PC attached but never answered count as waiting, so the ${MAX_PENDING + 1}th pushes the oldest out with 1013`, async () => {
    const pc = newServer();
    const control = await openServer(relayUrls(base, pc).control, pc);
    await control.json("sync");
    const pairs = [];
    for (let index = 0; index < MAX_PENDING; index++) pairs.push(await openPair(base, pc, control));
    const urls = relayUrls(base, pc);
    const phone = await Peer.open(urls.client);
    const { connection_id } = await phone.json("assigned") as { connection_id: string };
    expect(await pairs[0]!.client.closeCode("the oldest unanswered client")).toBe(CLOSE.TRY_AGAIN);
    expect(await pairs[0]!.data.closeCode("its data socket")).toBe(CLOSE.GOING_AWAY);
    expect(await control.json("disconnected")).toEqual({ type: "disconnected", connection_id: pairs[0]!.connectionId });
    expect(await control.json("connected")).toEqual({ type: "connected", connection_id });
    // the newcomer is served
    const data = await openServer(urls.data(connection_id), pc, connection_id);
    await establish({ client: phone, data });
  });
});
