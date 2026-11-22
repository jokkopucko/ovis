import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { startBunRelay, type BunRelay } from "../../../relay/bun.ts";
import { ATTEMPT_BYTES } from "../../../relay/pair-room.ts";
import { PairCodeHost, normalizePairCode, splitPairCode } from "../../../shared/relay-pair-code.ts";
import type { RelayOffer } from "../../../shared/relay-offer.ts";
import { exportPublicKey, generateKeyPair } from "../../../shared/relay-e2ee.ts";
import { deriveServerId } from "../../../shared/relay-server-proof.ts";
import { offerFromCode, TypedCodeError } from "./pairCode.ts";

let relay: BunRelay;
let relayUrl: string;
beforeAll(() => {
  relay = startBunRelay({ port: 0, pairGuestGapMs: 0 });
  relayUrl = `ws://127.0.0.1:${relay.port}`;
});
afterAll(() => relay.stop());

const connect = (url: string) => new WebSocket(url.replace(/^wss:\/\/[^/]+/, relayUrl));
const hexOf = (bytes: Uint8Array) => Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

async function host(code: string, reply: string | null | ((exchange: PairCodeHost) => Uint8Array)) {
  const socket = new WebSocket(`${relayUrl}/v1/pair?nameplate=${splitPairCode(code).nameplate}&role=host&v=1`);
  socket.binaryType = "arraybuffer";
  let exchange: PairCodeHost | null = null;
  let attempt = "";
  let answered = (): void => {};
  const heard = new Promise<void>((resolve) => { answered = resolve; });
  const prefixed = (bytes: Uint8Array) => { const out = new Uint8Array(ATTEMPT_BYTES + bytes.length); out.set(Uint8Array.from(attempt.match(/../g)!, (pair) => Number.parseInt(pair, 16))); out.set(bytes, ATTEMPT_BYTES); return out; };
  await new Promise<void>((resolve) => {
    socket.onmessage = (event) => {
      if (typeof event.data === "string") {
        const message = JSON.parse(event.data) as { type: string; attempt?: string };
        if (message.type === "waiting") resolve();
        if (message.type === "guest") {
          attempt = message.attempt!;
          exchange = new PairCodeHost(normalizePairCode(code)!);
          socket.send(prefixed(typeof reply === "function" ? reply(exchange) : exchange.hello()));
        }
        return;
      }
      const frame = new Uint8Array(event.data as ArrayBuffer);
      answered();
      if (hexOf(frame.subarray(0, ATTEMPT_BYTES)) !== attempt || typeof reply === "function") return;
      const answer = exchange!.answer(frame.subarray(ATTEMPT_BYTES), reply);
      if (answer === null) socket.send(JSON.stringify({ type: "drop", attempt }));
      else socket.send(prefixed(answer));
    };
  });
  return { close: () => socket.close(), heard };
}

const failure = (promise: Promise<unknown>) => promise.then(() => "no failure", (error: unknown) => error instanceof TypedCodeError ? error.failure : String(error));

function pcOffer(): RelayOffer {
  const key = generateKeyPair().publicKey;
  return { v: 1, server_id: deriveServerId(key), server_public_key: exportPublicKey(key), relay: "wss://relay.example" };
}

describe("pairing with a typed code on the device", () => {
  const offer: RelayOffer = { ...pcOffer(), code: "123456", name: "Desk" };

  it("gets the PC's offer for the right code, typed any way a person writes it", async () => {
    const pc = await host("AB3DE-FGHJK", JSON.stringify(offer));
    expect(await offerFromCode(" ab3de fghjk ", { connect })).toEqual(offer);
    pc.close();
  });

  it("says no PC shows a code nobody holds", async () => {
    expect(await failure(offerFromCode("ZZZZZ-ZZZZZ", { connect }))).toBe("no-pc");
  });

  it("says the code did not work when the PC turns the guess away, and tries once", async () => {
    const pc = await host("AB4DE-FGHJK", JSON.stringify(offer));
    expect(await failure(offerFromCode("AB4DE-FGHJM", { connect }))).toBe("wrong");
    pc.close();
  });

  it("says the relay could not be reached, not that the code was wrong, when the PC goes after the device answered", async () => {
    const pc = await host("AB8DE-FGHJK", (exchange) => exchange.hello());
    const typed = failure(offerFromCode("AB8DE-FGHJK", { connect }));
    await pc.heard;
    pc.close();
    expect(await typed).toBe("unreachable");
  });

  it("says the code ran out when the PC's six-digit code is gone", async () => {
    const pc = await host("AB5DE-FGHJK", null);
    expect(await failure(offerFromCode("AB5DE-FGHJK", { connect }))).toBe("expired");
    pc.close();
  });

  it("refuses an offer whose key is not the one its PC id names, or that carries no pairing code", async () => {
    const forged = await host("AB6DE-FGHJK", JSON.stringify({ ...offer, server_id: "12".repeat(16) }));
    expect(await failure(offerFromCode("AB6DE-FGHJK", { connect }))).toBe("forged");
    forged.close();
    const codeless = await host("AB7DE-FGHJK", JSON.stringify(pcOffer()));
    expect(await failure(offerFromCode("AB7DE-FGHJK", { connect }))).toBe("forged");
    codeless.close();
  });

  it("never sends a code that is not one", async () => {
    let opened = 0;
    expect(await failure(offerFromCode("AB3DE", { connect: (url) => { opened++; return connect(url); } }))).toBe("not-a-code");
    expect(opened).toBe(0);
  });
});
