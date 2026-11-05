import { afterEach, expect, it } from "bun:test";
import { loadRelayIdentity } from "./identity.ts";
import { RelayLink } from "./link.ts";
import { bounded, deferred, relayFixture, TestClock } from "./test-helpers.ts";
import { serverChallenge, SERVER_PROOF_CLOSE, SERVER_PROOF_REQUIRED } from "../../shared/relay-server-proof.ts";
import { importPublicKey } from "../../shared/relay-e2ee.ts";

const fixtures: ReturnType<typeof relayFixture>[] = [];
afterEach(() => { for (const fixture of fixtures.splice(0)) fixture.close(); });

for (const refusal of [
  { reason: "server proof timed out", code: SERVER_PROOF_CLOSE, permanent: false },
  { reason: "invalid or expired server proof", code: SERVER_PROOF_CLOSE, permanent: false },
  { reason: SERVER_PROOF_REQUIRED, code: SERVER_PROOF_CLOSE, permanent: false },
  { reason: "too many server proofs pending", code: 1013, permanent: false },
  { reason: "server key does not match server_id", code: SERVER_PROOF_CLOSE, permanent: true },
  { reason: "invalid server key", code: SERVER_PROOF_CLOSE, permanent: true },
  { reason: "protocol order", code: 4000, permanent: false },
]) {
  it(`${refusal.permanent ? "stops and reports" : "retries"} after ${refusal.reason} on the control socket`, async () => {
    const fixture = relayFixture();
    fixtures.push(fixture);
    const clock = new TestClock();
    const failed = deferred<string>();
    const states: string[] = [];
    let attempts = 0;
    const server = Bun.serve({
      hostname: "127.0.0.1", port: 0,
      fetch(request, server) { return server.upgrade(request) ? undefined : new Response(null, { status: 400 }); },
      websocket: {
        open(socket) {
          if (refusal.code === 4000) socket.send('{"type":"sync","connection_ids":[]}');
          else socket.close(refusal.code, refusal.reason);
        },
        message() {},
      },
    });
    const link = new RelayLink({
      relay: `ws://127.0.0.1:${server.port}`, identity: loadRelayIdentity(fixture.stateDir),
      services: fixture.app.context.services, port: fixture.app.port, clock, random: () => 0.5,
      connect: (url) => { attempts++; return new WebSocket(url); },
      onState: (phase, error) => {
        states.push(phase);
        if (phase === "error" && error) failed.resolve(error);
      },
    });
    try {
      link.start();
      const error = await bounded(failed.promise);
      if (refusal.permanent) {
        expect(error).toContain(String(SERVER_PROOF_CLOSE));
        clock.advance(60_000);
        expect(attempts).toBe(1);
        expect(clock.tasks.size).toBe(0);
      } else {
        clock.advance(999);
        expect(attempts).toBe(1);
        clock.advance(1);
        expect(attempts).toBe(2);
        expect(states.at(-1)).toBe("connecting");
      }
    } finally {
      await link.stop();
      await server.stop(true);
    }
  });
}

it("reconnects linearly from one to thirty seconds with twenty percent jitter and cancels on stop", async () => {
  const fixture = relayFixture();
  fixtures.push(fixture);
  const clock = new TestClock();
  const attempts: number[] = [];
  let random = 0;
  const link = new RelayLink({
    relay: "wss://relay.example", identity: loadRelayIdentity(fixture.stateDir),
    services: fixture.app.context.services, port: fixture.app.port, clock, random: () => random,
    connect: () => { attempts.push(clock.now()); throw new Error("Network unavailable"); },
    onState: () => {},
  });
  link.start();
  expect(attempts).toEqual([0]);
  for (let attempt = 1; attempt <= 35; attempt++) {
    const delay = Math.min(attempt, 30) * 1000 * (random === 0 ? 0.8 : 1.2);
    clock.advance(delay - 1);
    expect(attempts).toHaveLength(attempt);
    random = random === 0 ? 1 : 0;
    clock.advance(1);
    expect(attempts).toHaveLength(attempt + 1);
  }
  await link.stop();
  clock.advance(60_000);
  expect(attempts).toHaveLength(36);
  expect(clock.tasks.size).toBe(0);
});

it("drops and reconnects a control socket that sends an oversized message after the proof", async () => {
  const fixture = relayFixture();
  fixtures.push(fixture);
  const clock = new TestClock();
  const identity = loadRelayIdentity(fixture.stateDir);
  const lost = deferred<string>();
  let attempts = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    fetch(request, server) { return server.upgrade(request) ? undefined : new Response(null, { status: 400 }); },
    websocket: {
      open(socket) {
        socket.send(serverChallenge(importPublicKey(identity.public_key), { server_id: identity.server_id, role: "control", connection_id: null }).frame);
      },
      // valid JSON the link would otherwise read as a pong
      message(socket) { socket.send(JSON.stringify({ type: "pong", padding: "x".repeat(8192) })); },
    },
  });
  const link = new RelayLink({
    relay: `ws://127.0.0.1:${server.port}`, identity, services: fixture.app.context.services, port: fixture.app.port,
    clock, random: () => 0.5, connect: (url) => { attempts++; return new WebSocket(url); },
    onState: (phase, error) => { if (phase === "error" && error) lost.resolve(error); },
  });
  try {
    link.start();
    expect(await bounded(lost.promise)).toContain("reconnecting");
    clock.advance(1000);
    expect(attempts).toBe(2);
  } finally {
    await link.stop();
    await server.stop(true);
  }
});
