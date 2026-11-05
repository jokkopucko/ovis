/**
 * Load smoke for the relay: `bun relay/load-smoke.ts --pcs 200 --clients 4 [--frames 50] [--url ws://host:port]`.
 * Without --url it starts the Bun relay in this process. Each PC opens its control socket, then
 * its clients one after another with a data socket each; then every client and every data socket
 * send --frames random binary frames at once. It prints frames sent and received each way, and
 * exits 1 unless every frame arrived, byte for byte and in order.
 */
import { startBunRelay } from "./bun.ts";
import { equalBytes, establish, newServer, openPair, within, type Peer } from "./relay-test-client.ts";

const args = process.argv.slice(2);
const option = (name: string, fallback: string) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 && args[index + 1] !== undefined ? args[index + 1]! : fallback;
};
const count = (name: string, fallback: number) => {
  const value = Number(option(name, String(fallback)));
  if (!Number.isInteger(value) || value < 1) throw new Error(`--${name} must be a positive integer`);
  return value;
};
const pcs = count("pcs", 200);
const clientsPerPc = count("clients", 4);
const frames = count("frames", 50);
const deadlineMs = count("timeout-ms", 120_000);

const connections = pcs * (1 + 2 * clientsPerPc);
const local = args.includes("--url") ? null : startBunRelay({ port: 0, limits: {
  perAddressPerMinute: connections, globalPerMinute: connections, maxSockets: connections, maxRooms: pcs, maxSocketsPerAddress: connections,
} });
const base = local ? `ws://127.0.0.1:${local.port}` : option("url", "");

const frame = () => crypto.getRandomValues(new Uint8Array(1 + Math.floor(Math.random() * 16 * 1024)));

const totals = { up: { sent: 0, received: 0, mismatched: 0 }, down: { sent: 0, received: 0, mismatched: 0 } };

/** sends `frames` frames from one end and checks each at the other, in order */
async function stream(from: Peer, to: Peer, tally: { sent: number; received: number; mismatched: number }) {
  const sent = Array.from({ length: frames }, frame);
  for (const bytes of sent) { from.socket.send(bytes); tally.sent++; }
  for (const bytes of sent) {
    const got = await to.next("a relayed frame", deadlineMs);
    tally.received++;
    if (!equalBytes(got, bytes)) tally.mismatched++;
  }
}

const started = performance.now();
let failure: unknown = null;
const sockets: Peer[] = [];
try {
  const pairs = await within(Promise.all(Array.from({ length: pcs }, async () => {
    const server = newServer();
    const first = await openPair(base, server);
    await establish(first);
    const out = [first];
    for (let index = 1; index < clientsPerPc; index++) {
      const pair = await openPair(base, server, first.control);
      await establish(pair);
      out.push(pair);
    }
    return out;
  })), "every PC and client to connect", deadlineMs).then((all) => all.flat());
  for (const pair of pairs) sockets.push(pair.client, pair.data);
  sockets.push(...new Set(pairs.map((pair) => pair.control)));
  console.log(`connected: ${pcs} PCs, ${pairs.length} clients, ${pairs.length} data sockets in ${Math.round(performance.now() - started)} ms`);
  await within(Promise.all(pairs.flatMap((pair) => [stream(pair.client, pair.data, totals.up), stream(pair.data, pair.client, totals.down)])), "every frame", deadlineMs);
} catch (error) {
  failure = error;
}
for (const socket of sockets) socket.socket.close();
await local?.stop();

const dropped = totals.up.sent - totals.up.received + totals.down.sent - totals.down.received;
const mismatched = totals.up.mismatched + totals.down.mismatched;
console.log(`client -> PC: sent ${totals.up.sent}, received ${totals.up.received}, mismatched ${totals.up.mismatched}`);
console.log(`PC -> client: sent ${totals.down.sent}, received ${totals.down.received}, mismatched ${totals.down.mismatched}`);
console.log(`dropped ${dropped}, mismatched ${mismatched}, ${Math.round(performance.now() - started)} ms`);
if (failure) console.log(`error: ${failure instanceof Error ? failure.message : String(failure)}`);
const pass = !failure && dropped === 0 && mismatched === 0 && totals.up.sent === pcs * clientsPerPc * frames;
console.log(pass ? "PASS" : "FAIL");
process.exit(pass ? 0 : 1);
