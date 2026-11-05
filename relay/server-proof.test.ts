import { afterEach, expect, test } from "bun:test";
import nacl from "tweetnacl";
import { bytesToHex } from "@noble/hashes/utils.js";
import { answerServerChallenge, deriveServerId, SERVER_PROOF_CLOSE } from "../shared/relay-server-proof.ts";
import { startBunRelay } from "./bun.ts";
import { CLOSE, KEEPALIVE_PING, KEEPALIVE_PONG } from "./core.ts";
import { Peer, relayUrls, within } from "./relay-test-client.ts";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const stop of cleanup.splice(0)) await stop(); });

function fixture() {
  const relay = startBunRelay({ port: 0 });
  cleanup.push(() => relay.stop());
  const keys = nacl.box.keyPair();
  const id = deriveServerId(keys.publicKey);
  const urls = relayUrls(`ws://127.0.0.1:${relay.port}`, {
    serverId: id, publicKey: bytesToHex(keys.publicKey), secretKey: keys.secretKey,
  });
  const query = `&proof=1&public_key=${bytesToHex(keys.publicKey)}`;
  const answer = async (peer: Peer, secret = keys.secretKey, connectionId: string | null = null) => {
    const proof = answerServerChallenge(await peer.next("challenge"), secret, {
      server_id: id, role: connectionId === null ? "control" : "data", connection_id: connectionId,
    });
    if (!proof) throw new Error("Missing challenge");
    return proof;
  };
  return { keys, urls, query, answer };
}

test.each(["missing", "wrong key", "wrong answer", "replayed", "garbage", "binary"])(
  "Bun forged takeover (%s) cannot displace the live PC", async (attack) => {
    const f = fixture();
    const live = await Peer.open(f.urls.control);
    const replay = await f.answer(live);
    live.socket.send(replay);
    expect((await live.json())["type"]).toBe("sync");
    const other = nacl.box.keyPair();
    const query = attack === "missing" ? "" : attack === "wrong key"
      ? `&proof=1&public_key=${bytesToHex(other.publicKey)}` : f.query;
    const forged = await Peer.open(f.urls.control.replace(f.query, "") + query);
    if (attack !== "missing" && attack !== "wrong key") {
      const wrong = await f.answer(forged, other.secretKey);
      forged.socket.send(attack === "replayed" ? replay : attack === "wrong answer" ? wrong
        : attack === "binary" ? new Uint8Array([0, 255]) : "{garbage");
    }
    expect(await forged.closeCode()).toBe(SERVER_PROOF_CLOSE);
    live.socket.send(KEEPALIVE_PING);
    expect(await live.next()).toBe(KEEPALIVE_PONG);
  });

test("Bun forged data proof cannot close or steal an existing pair", async () => {
  const f = fixture();
  const live = await Peer.open(f.urls.control);
  live.socket.send(await f.answer(live));
  await live.json("sync");
  const client = await Peer.open(f.urls.client);
  const id = String((await client.json("assigned"))["connection_id"]);
  const data = await Peer.open(f.urls.data(id));
  data.socket.send(await f.answer(data, f.keys.secretKey, id));
  client.socket.send("before attack");
  expect(await data.next()).toBe("before attack");
  const forged = await Peer.open(f.urls.data(id));
  forged.socket.send(await f.answer(forged, nacl.box.keyPair().secretKey, id));
  expect(await forged.closeCode()).toBe(SERVER_PROOF_CLOSE);
  client.socket.send("after attack");
  expect(await data.next()).toBe("after attack");
  data.socket.send("back");
  expect(await client.next()).toBe("back");
});

test("Bun concurrent legitimate reconnects replace only after proof and leave one live control", async () => {
  const f = fixture();
  const live = await Peer.open(f.urls.control);
  live.socket.send(await f.answer(live));
  await live.json("sync");
  const [one, two] = await Promise.all([Peer.open(f.urls.control), Peer.open(f.urls.control)]);
  const answers = await Promise.all([f.answer(one), f.answer(two)]);
  live.socket.send(KEEPALIVE_PING);
  expect(await live.next()).toBe(KEEPALIVE_PONG);
  one.socket.send(answers[0]);
  two.socket.send(answers[1]);
  await Promise.all([one.json("sync"), two.json("sync")]);
  expect(await live.closeCode()).toBe(CLOSE.POLICY);
  const loser = await within(Promise.race([one.closed.then(() => one), two.closed.then(() => two)]), "one reconnect replaced");
  const winner = loser === one ? two : one;
  expect(await loser.closeCode()).toBe(CLOSE.POLICY);
  winner.socket.send(KEEPALIVE_PING);
  expect(await winner.next()).toBe(KEEPALIVE_PONG);
});
