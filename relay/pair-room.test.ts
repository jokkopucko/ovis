import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { startBunRelay, type BunRelay } from "./bun.ts";
import { IDLE_MS, KEEPALIVE_PING, KEEPALIVE_PONG } from "./core.ts";
import { PAIR_CLOSE, PAIR_GUESTS_PER_ROOM, PAIR_MAX_FRAME, ATTEMPT_BYTES } from "./pair-room.ts";
import { Peer, newServer, type TestServer } from "./relay-test-client.ts";
import { PAIR_ATTEMPT_BYTES, PAIR_CLOSE as SHARED_PAIR_CLOSE } from "../shared/relay-pair-code.ts";
import { PAIR_APPROVAL_MS } from "../shared/relay-pair-sas.ts";
import { SERVER_KEY_MISMATCH, SERVER_PROOF_CLOSE, answerServerChallenge, type ProofRoute } from "../shared/relay-server-proof.ts";

let relay: BunRelay;
let base: string;
beforeAll(() => {
  relay = startBunRelay({ port: 0, limits: { perAddressPerMinute: 10_000, globalPerMinute: 10_000 }, pairGuestGapMs: 0 });
  base = `ws://127.0.0.1:${relay.port}`;
});
afterAll(() => relay.stop());

let counter = 0;
const nameplate = () => { counter++; return `${"0123456789ABCDEFGHJKMNPQRSTVWXYZ"[counter >> 5]}${"0123456789ABCDEFGHJKMNPQRSTVWXYZ"[counter & 31]}Q`; };
const open = (plate: string, role: "host" | "guest") => Peer.open(`${base}/v1/pair?nameplate=${plate}&role=${role}&v=1`);
const hex = (bytes: Uint8Array) => Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
const fromHex = (text: string) => Uint8Array.from(text.match(/../g)!, (pair) => Number.parseInt(pair, 16));

async function hostAndGuest() {
  const plate = nameplate();
  const host = await open(plate, "host");
  expect(await host.json("waiting")).toEqual({ type: "waiting" });
  const guest = await open(plate, "guest");
  const hello = await host.json("guest");
  expect(hello).toEqual({ type: "guest", attempt: expect.stringMatching(/^[0-9a-f]{32}$/) });
  return { plate, host, guest, attempt: hello.attempt as string };
}

describe("pairing rendezvous", () => {
  test("speaks the attempt ids and close codes the PC and the app read from shared/", () => {
    expect(ATTEMPT_BYTES).toBe(PAIR_ATTEMPT_BYTES);
    expect(PAIR_CLOSE).toEqual(SHARED_PAIR_CLOSE);
  });

  test("refuses a bad nameplate or role before upgrading", async () => {
    const http = base.replace("ws://", "http://");
    for (const query of ["nameplate=ab1&role=host&v=1", "nameplate=AB&role=host&v=1", "nameplate=ABU&role=host&v=1", "nameplate=AB1&role=both&v=1", "nameplate=AB1&v=1"]) {
      expect([query, (await fetch(`${http}/v1/pair?${query}`, { headers: { upgrade: "websocket" } })).status]).toEqual([query, 400]);
    }
  });

  test("a guest with no host is told there is no such code", async () => {
    const guest = await open(nameplate(), "guest");
    expect(await guest.closeCode()).toBe(PAIR_CLOSE.NO_HOST);
  });

  test("a second host for a nameplate is refused, and the first keeps it", async () => {
    const plate = nameplate();
    const host = await open(plate, "host");
    await host.json("waiting");
    const second = await open(plate, "host");
    expect(await second.closeCode()).toBe(PAIR_CLOSE.TAKEN);
    const guest = await open(plate, "guest");
    expect((await host.json("guest")).type).toBe("guest");
    guest.socket.close();
    host.socket.close();
  });

  test("frames pass between host and guest scoped to the attempt; the guest's arrive prefixed with it", async () => {
    const { host, guest, attempt } = await hostAndGuest();
    guest.socket.send(new Uint8Array([1, 2, 3]));
    const up = await host.next("guest frame") as Uint8Array;
    expect(hex(up.slice(0, ATTEMPT_BYTES))).toBe(attempt);
    expect([...up.slice(ATTEMPT_BYTES)]).toEqual([1, 2, 3]);
    host.socket.send(new Uint8Array([...fromHex(attempt), 9, 8]));
    expect([...(await guest.next("host frame") as Uint8Array)]).toEqual([9, 8]);
    guest.socket.close();
    host.socket.close();
  });

  test("a host frame for a stale attempt and a guest's text never reach the other side", async () => {
    const { host, guest, attempt } = await hostAndGuest();
    host.socket.send(new Uint8Array([...new Uint8Array(ATTEMPT_BYTES), 7]));
    guest.socket.send('{"type":"guest","attempt":"00"}');
    guest.socket.send(KEEPALIVE_PING);
    expect(await guest.next("pong")).toBe(KEEPALIVE_PONG);
    host.socket.send(new Uint8Array([...fromHex(attempt), 5]));
    expect([...(await guest.next("the current frame") as Uint8Array)]).toEqual([5]);
    expect(host.pending).toBe(0);
    guest.socket.close();
    host.socket.close();
  });

  test("a host's text that is JSON but no object is ignored, and the relay keeps running", async () => {
    const { host, guest, attempt } = await hostAndGuest();
    for (const text of ["null", "1", "[]", '"drop"']) host.socket.send(text);
    host.socket.send(new Uint8Array([...fromHex(attempt), 4]));
    expect([...(await guest.next("the frame after them") as Uint8Array)]).toEqual([4]);
    expect((await fetch(`${base.replace("ws://", "http://")}/health`)).status).toBe(200);
    guest.socket.close();
    host.socket.close();
  });

  test("a frame over the limit closes its sender", async () => {
    const { host, guest } = await hostAndGuest();
    guest.socket.send(new Uint8Array(PAIR_MAX_FRAME + 1));
    expect(await guest.closeCode()).toBe(1009);
    host.socket.close();
  });

  test("one guest at a time; drop ends only the named attempt, and gone names who left", async () => {
    const { plate, host, guest, attempt } = await hostAndGuest();
    const busy = await open(plate, "guest");
    expect(await busy.closeCode()).toBe(PAIR_CLOSE.BUSY);
    host.socket.send(JSON.stringify({ type: "drop", attempt: "f".repeat(32) }));
    host.socket.send(JSON.stringify({ type: "drop", attempt }));
    expect(await guest.closeCode()).toBe(PAIR_CLOSE.DROPPED);
    expect(await host.json("gone")).toEqual({ type: "gone", attempt });
    const next = await open(plate, "guest");
    const again = await host.json("next guest");
    expect(again.attempt).not.toBe(attempt);
    next.socket.close();
    expect(await host.json("gone")).toEqual({ type: "gone", attempt: again.attempt });
    host.socket.close();
  });

  test(`a room takes at most ${PAIR_GUESTS_PER_ROOM} guests in its life`, async () => {
    const plate = nameplate();
    const host = await open(plate, "host");
    await host.json("waiting");
    for (let index = 0; index < PAIR_GUESTS_PER_ROOM; index++) {
      const guest = await open(plate, "guest");
      await host.json("guest");
      guest.socket.close();
      await host.json("gone");
    }
    const late = await open(plate, "guest");
    expect(await late.closeCode()).toBe(PAIR_CLOSE.BUSY);
    host.socket.close();
  });

  test("the host leaving closes its guest, and the nameplate is free again", async () => {
    const { plate, host, guest } = await hostAndGuest();
    host.socket.close();
    expect(await guest.closeCode()).toBe(PAIR_CLOSE.HOST_GONE);
    const next = await open(plate, "host");
    expect(await next.json("waiting")).toEqual({ type: "waiting" });
    next.socket.close();
  });
});

describe("a pairing host's PC key", () => {
  const hostOf = (plate: string, pc: TestServer, key = pc.publicKey) => Peer.open(`${base}/v1/pair?nameplate=${plate}&role=host&v=1&server_id=${pc.serverId}&public_key=${key}`);
  const answer = async (host: Peer, pc: TestServer, route: Partial<ProofRoute>) =>
    host.socket.send(answerServerChallenge(await host.next("server_challenge"), pc.secretKey, { server_id: pc.serverId, role: "pair-host", connection_id: null, ...route })!);

  test("a host that offers its PC key holds the nameplate only once it proves the key for that nameplate", async () => {
    const plate = nameplate();
    const pc = newServer();
    const host = await hostOf(plate, pc);
    // while it proves, no device finds the code and no other host takes it
    expect(await (await open(plate, "guest")).closeCode()).toBe(PAIR_CLOSE.NO_HOST);
    expect(await (await open(plate, "host")).closeCode()).toBe(PAIR_CLOSE.TAKEN);
    await answer(host, pc, { connection_id: plate });
    expect(await host.json("waiting")).toEqual({ type: "waiting" });
    const guest = await open(plate, "guest");
    expect((await host.json("guest")).type).toBe("guest");
    guest.socket.close();
    host.socket.close();
  });

  test("a proof for another nameplate or another role, or a key that is not its server_id's, is refused 4401", async () => {
    const pc = newServer();
    for (const route of [{ connection_id: "ZZZ" }, { role: "control" as const, connection_id: null }]) {
      const plate = nameplate();
      const host = await hostOf(plate, pc);
      await answer(host, pc, route);
      expect(await host.closeCode()).toBe(SERVER_PROOF_CLOSE);
    }
    const borrowed = await hostOf(nameplate(), pc, newServer().publicKey);
    expect(await borrowed.closed).toEqual({ code: SERVER_PROOF_CLOSE, reason: SERVER_KEY_MISMATCH });
  });
});

describe("pairing rooms beside PC rooms", () => {
  test("pairing rooms have a cap of their own: they never take the places PCs connect to", async () => {
    const small = startBunRelay({ port: 0, limits: { maxRooms: 1, maxPairRooms: 1 }, pairGuestGapMs: 0 });
    const http = `http://127.0.0.1:${small.port}`;
    const upgrade = { headers: { upgrade: "websocket", connection: "Upgrade", "sec-websocket-version": "13", "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==" } };
    try {
      const host = await Peer.open(`ws://127.0.0.1:${small.port}/v1/pair?nameplate=AAA&role=host&v=1`);
      await host.json("waiting");
      expect((await fetch(`${http}/v1/pair?nameplate=BBB&role=host&v=1`, upgrade)).status).toBe(503);
      const pc = await Peer.open(`ws://127.0.0.1:${small.port}/v1/ws?server_id=${"ab".repeat(16)}&role=client&v=1`);
      expect(await pc.json("assigned")).toMatchObject({ type: "assigned" });
      pc.socket.close();
      host.socket.close();
    } finally { await small.stop(); }
  });
});

test("a digit comparison ends before the relay closes the socket as idle", () => {
  expect(PAIR_APPROVAL_MS).toBeLessThan(IDLE_MS);
});
