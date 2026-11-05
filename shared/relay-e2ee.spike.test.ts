import { afterEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { x25519 } from "@noble/curves/ed25519.js";
import { PASEO_FILES } from "../scripts/vendor-paseo.ts";
import { MAX_FRAME_BYTES } from "./relay-mux.ts";
import {
  exportPublicKey, generateKeyPair, openClientSecureChannel, openDaemonSecureChannel,
  MAX_HANDSHAKE_INBOUND_BYTES, MAX_HANDSHAKE_INBOUND_BYTES_TOTAL, MAX_HANDSHAKE_INBOUND_MESSAGES,
  HANDSHAKE_MESSAGE_OVERHEAD_BYTES, MAX_CARRIER_BINARY_BYTES, MAX_PRE_OPEN_SEND_BYTES,
  PROTECTED_HANDSHAKE_FAILED_CLOSE_CODE, PROTECTED_RECORD_FAILED_CLOSE_CODE,
  SecureChannelRejectedError, PROTECTED_MODE_REQUIRED_CLOSE_CODE,
  type KeyPair, type SecureChannel, type Transport, type TransportMessage,
} from "./relay-e2ee.ts";
import { createClientChannel, createDaemonChannel } from "./vendor/paseo-e2ee/encrypted-channel.ts";
import {
  createNoiseInitiator, createNoiseResponder, NOISE_NK_PROTOCOL_NAME,
} from "./vendor/paseo-e2ee/noise/index.ts";
import fixture from "./vendor/paseo-e2ee/noise/fixtures/nk-25519-chachapoly-sha256.json";

const vendor = join(import.meta.dir, "vendor/paseo-e2ee");
const fromHex = (text: string) => new Uint8Array(Buffer.from(text, "hex"));
const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");
const keyPair = (text: string) => {
  const secretKey = fromHex(text);
  return { secretKey, publicKey: x25519.getPublicKey(secretKey) };
};

it("matches every vendored file against the README SHA-256 manifest", () => {
  // Given the shipped manifest, even when the probe points at a scratch tree.
  const root = process.env["PASEO_VENDOR_CHECK_DIR"] ?? vendor;
  const manifest = readFileSync(join(vendor, "README.md"), "utf8");
  const rows = [...manifest.matchAll(/^\| `([^`]+)` \| `([a-f0-9]{64})` \|$/gm)];
  const actualFiles = [...new Bun.Glob("**/*").scanSync({ cwd: root, onlyFiles: true })]
    .filter((file) => file !== "README.md" && !file.startsWith("dist/")).sort();
  expect(rows.map((row) => row[1]).sort()).toEqual([...PASEO_FILES].sort());
  expect(actualFiles).toEqual([...PASEO_FILES].sort());
  // When bytes are hashed, then every source, fixture, license and config agrees.
  for (const row of rows) {
    const [, file, expected] = row;
    if (!file || !expected) throw new Error("Invalid vendor manifest row");
    const digest = createHash("sha256").update(readFileSync(join(root, file))).digest("hex");
    expect(digest, `SHA-256 mismatch: ${file}`).toBe(expected);
  }
  console.log(`SHA-256 verified: ${rows.length} files`);
});

describe("Noise NK reference vectors", () => {
  // The override permits a scratch-fixture negative probe without touching shipped bytes.
  const vectors: typeof fixture = process.env["PASEO_VECTOR_FIXTURE"]
    ? JSON.parse(readFileSync(process.env["PASEO_VECTOR_FIXTURE"], "utf8"))
    : fixture;
  it("contains both independent reference vectors", () => {
    expect(vectors.vectors).toHaveLength(2);
    console.log(`Noise NK vector count: ${vectors.vectors.length}`);
  });
  for (const vector of vectors.vectors) {
    it(`matches the real ciphertexts from ${vector.source}`, () => {
      // Given fixed keys and prologues from the upstream third-party fixture.
      expect(vector.name).toBe(NOISE_NK_PROTOCOL_NAME);
      const localStatic = keyPair(vector.resp_static);
      expect(hex(localStatic.publicKey)).toBe(vector.init_remote_static);
      const initiator = createNoiseInitiator({
        remoteStatic: fromHex(vector.init_remote_static),
        prologue: fromHex(vector.init_prologue), ephemeral: keyPair(vector.init_ephemeral),
      });
      const responder = createNoiseResponder({
        localStatic, prologue: fromHex(vector.resp_prologue),
        ephemeral: keyPair(vector.resp_ephemeral),
      });
      const [m1, m2, ...messages] = vector.messages;
      if (!m1 || !m2) throw new Error("Vector needs two handshake messages");
      // When the full handshake and both transport directions run, then bytes match.
      const first = initiator.writeMessage(fromHex(m1.payload));
      expect(hex(first)).toBe(m1.ciphertext);
      expect(hex(responder.readMessage(first))).toBe(m1.payload);
      const second = responder.writeMessage(fromHex(m2.payload));
      expect(hex(second)).toBe(m2.ciphertext);
      expect(hex(initiator.readMessage(second))).toBe(m2.payload);
      expect(initiator.isComplete()).toBe(true);
      expect(responder.isComplete()).toBe(true);
      if (vector.handshake_hash !== undefined) {
        expect(hex(initiator.handshakeHash())).toBe(vector.handshake_hash);
        expect(hex(responder.handshakeHash())).toBe(vector.handshake_hash);
      }
      const client = initiator.split();
      const daemon = responder.split();
      messages.forEach((message, index) => {
        const sender = index % 2 === 0 ? client.send : daemon.send;
        const receiver = index % 2 === 0 ? daemon.receive : client.receive;
        const ciphertext = sender.encryptWithAd(new Uint8Array(0), fromHex(message.payload));
        expect(hex(ciphertext)).toBe(message.ciphertext);
        expect(hex(receiver.decryptWithAd(new Uint8Array(0), ciphertext))).toBe(message.payload);
      });
    });
  }
});

// A message-oriented link: callbacks are installed before sends, and held records
// let the relay corrupt exact wire bytes without replacing any cryptography.
class MemoryTransport implements Transport {
  onmessage: Transport["onmessage"] = null;
  onclose: Transport["onclose"] = null;
  onerror: Transport["onerror"] = null;
  peer: MemoryTransport | null = null;
  readonly sent: TransportMessage[] = [];
  readonly closes: number[] = [];
  held = false;
  closed = false;

  async send(data: string | ArrayBuffer): Promise<void> {
    if (this.closed || !this.peer) throw new Error("Transport is not connected");
    const message = { data, isBinary: typeof data !== "string" };
    this.sent.push(message);
    if (!this.held) await this.peer.deliver(message);
  }

  async deliver(message: TransportMessage): Promise<void> {
    if (!this.closed) await this.onmessage?.(message);
  }

  close(code = 1000, reason = "test teardown"): void {
    if (this.closed) return;
    this.closed = true;
    this.closes.push(code);
    this.onclose?.(code, reason);
    this.peer?.close(code, reason);
  }
}

const links: MemoryTransport[] = [];
afterEach(() => {
  for (const link of links.splice(0)) link.close();
});
function pair() {
  const client = new MemoryTransport();
  const daemon = new MemoryTransport();
  client.peer = daemon;
  daemon.peer = client;
  links.push(client, daemon);
  return { client, daemon };
}

async function connected(daemonKeyPair: KeyPair = generateKeyPair()) {
  const link = pair();
  const received = { client: [] as (string | ArrayBuffer)[], daemon: [] as (string | ArrayBuffer)[] };
  const daemonOpening = openDaemonSecureChannel(link.daemon, {
    daemonKeyPair,
    events: { onmessage: (data) => received.daemon.push(data) },
  });
  let client: SecureChannel | undefined;
  try {
    client = await openClientSecureChannel(link.client, {
      daemonPublicKeyB64: exportPublicKey(daemonKeyPair.publicKey),
      events: { onmessage: (data) => received.client.push(data) },
    });
    const daemon = await daemonOpening;
    expect(client.isOpen()).toBe(true);
    expect(daemon.isOpen()).toBe(true);
    return { link, client, daemon, received };
  } catch (error) {
    client?.close();
    link.client.close();
    throw error;
  }
}

it("negotiates protected mode and round-trips text and binary in both directions", async () => {
  // Given two endpoints pinned to protected mode.
  const { client, daemon, received } = await connected();
  expect(client.securityMode()).toBe("protected");
  expect(daemon.securityMode()).toBe("protected");
  console.log(`Negotiated mode: client=${client.securityMode()} daemon=${daemon.securityMode()}`);
  // When each frame kind crosses the actual secure channels in both directions.
  for (const payload of ["protected text", new Uint8Array([0, 255, 1, 128]).buffer]) {
    await client.send(payload);
    await daemon.send(payload);
  }
  // Then the application receives exact values and frame kinds.
  expect(received.client).toEqual(["protected text", new Uint8Array([0, 255, 1, 128]).buffer]);
  expect(received.daemon).toEqual(received.client);
});

it("refuses a legacy-only daemon when the client omits minimumMode", async () => {
  // Given a real legacy daemon, not a fabricated ready response.
  const link = pair();
  const keys = generateKeyPair();
  const received: (string | ArrayBuffer)[] = [];
  const daemonOpening = createDaemonChannel(link.daemon, keys).then(
    (channel) => ({ channel, error: undefined }),
    (error: unknown) => ({ channel: undefined, error }),
  );
  // When a pinned client receives its legacy ready.
  const client = await openClientSecureChannel(link.client, {
    daemonPublicKeyB64: exportPublicKey(keys.publicKey),
    events: { onmessage: (data) => received.push(data) },
  });
  const daemonResult = await daemonOpening;
  expect(daemonResult.error).toBeInstanceOf(Error);
  // Then no application data is sent and the client closes before opening.
  expect(client.isOpen()).toBe(false);
  expect(link.client.closes).toEqual([PROTECTED_HANDSHAKE_FAILED_CLOSE_CODE]);
  expect(received).toEqual([]);
  expect(link.client.sent).toHaveLength(1);
});

it("refuses a legacy-only client when the daemon omits minimumMode", async () => {
  const link = pair();
  const keys = generateKeyPair();
  const opening = openDaemonSecureChannel(link.daemon, { daemonKeyPair: keys })
    .catch((error: unknown) => error);
  const client = await createClientChannel(link.client, exportPublicKey(keys.publicKey));
  const result = await opening;
  expect(result).toBeInstanceOf(SecureChannelRejectedError);
  if (!(result instanceof SecureChannelRejectedError)) throw new Error("Expected rejection");
  expect(result.closeCode).toBe(PROTECTED_MODE_REQUIRED_CLOSE_CODE);
  expect(client.isOpen()).toBe(false);
});

for (const submit of ["onopen", "microtask"] as const) {
  it(`preserves pre-open send order when a new send arrives in ${submit}`, async () => {
    // Given a real protected handshake with its ready envelope held by the relay.
    const link = pair();
    link.daemon.held = true;
    const keys = generateKeyPair();
    const received: (string | ArrayBuffer)[] = [];
    const daemonOpening = openDaemonSecureChannel(link.daemon, {
      daemonKeyPair: keys, events: { onmessage: (data) => received.push(data) },
    });
    let latest: Promise<void> | undefined;
    const client = await openClientSecureChannel(link.client, {
      daemonPublicKeyB64: exportPublicKey(keys.publicKey),
      events: { onopen: () => {
        if (submit === "onopen") latest = client.send("B");
      } },
    });
    await daemonOpening;
    const first = client.send("A");
    const second = client.send("C");
    // When ready opens the channel, a later submission must not overtake either send.
    const ready = link.daemon.sent[0];
    if (!ready) throw new Error("No ready captured");
    await link.client.deliver(ready);
    if (submit === "microtask") latest = client.send("B");
    await Promise.all([first, second, latest]);
    // Then submission order, not handshake completion order, determines delivery.
    expect(received).toEqual(["A", "C", "B"]);
  });
}

it("bounds pre-open sends and rejects them when the handshake closes", async () => {
  const link = pair();
  link.client.held = true;
  const client = await openClientSecureChannel(link.client, {
    daemonPublicKeyB64: exportPublicKey(generateKeyPair().publicKey),
  });
  const pending = Array.from({ length: 200 }, () => client.send("queued")
    .catch((error: unknown) => error));
  await expect(client.send("overflow")).rejects.toBeInstanceOf(RangeError);
  client.close();
  for (const result of await Promise.all(pending)) expect(result).toBeInstanceOf(Error);
});

it("bounds the bytes of pre-open sends", async () => {
  const link = pair();
  link.client.held = true;
  const client = await openClientSecureChannel(link.client, {
    daemonPublicKeyB64: exportPublicKey(generateKeyPair().publicKey),
  });
  // A refused send is rejected at once; a queued one stays pending until the handshake ends.
  const tooLarge = client.send(new Uint8Array(MAX_PRE_OPEN_SEND_BYTES + 1).buffer);
  expect(Bun.peek.status(tooLarge)).toBe("rejected");
  await expect(tooLarge).rejects.toBeInstanceOf(RangeError);
  const queued = client.send(new Uint8Array(MAX_PRE_OPEN_SEND_BYTES).buffer);
  expect(Bun.peek.status(queued)).toBe("pending");
  const overflow = client.send("x");
  expect(Bun.peek.status(overflow)).toBe("rejected");
  await expect(overflow).rejects.toBeInstanceOf(RangeError);
  client.close();
  await expect(queued).rejects.toBeInstanceOf(Error);
});

// A daemon that accepted the hello but whose ready is still in flight queues what arrives.
async function stalledHandshake() {
  const link = pair();
  link.daemon.send = () => new Promise<void>(() => {});
  const keys = generateKeyPair();
  const opening = openDaemonSecureChannel(link.daemon, { daemonKeyPair: keys }).catch((error: unknown) => error);
  await openClientSecureChannel(link.client, { daemonPublicKeyB64: exportPublicKey(keys.publicKey) });
  const hello = link.client.sent[0];
  if (typeof hello?.data !== "string") throw new Error("No hello sent");
  return { link, opening, helloBytes: hello.data.length + HANDSHAKE_MESSAGE_OVERHEAD_BYTES };
}
/** Queues messages charging exactly `bytes`, each message's overhead included. */
function fill(transport: MemoryTransport, bytes: number): void {
  // The longest text whose base64 reading stays within the binary carrier limit.
  const chunk = 4 * Math.floor(MAX_CARRIER_BINARY_BYTES / 3);
  const overhead = HANDSHAKE_MESSAGE_OVERHEAD_BYTES;
  for (let left = bytes; left > 0;) {
    // Never leave less than one message's overhead behind, so the last message lands exactly.
    const length = left - overhead <= chunk ? left - overhead : Math.min(chunk, left - 2 * overhead);
    void transport.deliver({ data: "x".repeat(length), isBinary: false });
    left -= length + overhead;
  }
}

it("closes a handshake that queues too many messages", async () => {
  const { link, opening } = await stalledHandshake();
  // The hello is the first queued message.
  for (let i = 1; i < MAX_HANDSHAKE_INBOUND_MESSAGES; i++) void link.daemon.deliver({ data: "x", isBinary: false });
  expect(link.daemon.closes).toEqual([]);
  void link.daemon.deliver({ data: "x", isBinary: false });
  expect(link.daemon.closes).toEqual([PROTECTED_HANDSHAKE_FAILED_CLOSE_CODE]);
  expect(await opening).toBeInstanceOf(Error);
});

it("closes a handshake that queues too many bytes", async () => {
  const { link, opening, helloBytes } = await stalledHandshake();
  fill(link.daemon, MAX_HANDSHAKE_INBOUND_BYTES - helloBytes);
  expect(link.daemon.closes).toEqual([]);
  // Even an empty message costs its overhead.
  void link.daemon.deliver({ data: "", isBinary: false });
  expect(link.daemon.closes).toEqual([PROTECTED_HANDSHAKE_FAILED_CLOSE_CODE]);
  expect(await opening).toBeInstanceOf(Error);
});

it("charges non-ASCII handshake text in UTF-8 bytes against the connection budget", async () => {
  const { link, opening, helloBytes } = await stalledHandshake();
  fill(link.daemon, MAX_HANDSHAKE_INBOUND_BYTES - helloBytes - HANDSHAKE_MESSAGE_OVERHEAD_BYTES - 2);
  expect(link.daemon.closes).toEqual([]);
  // Two code units, but three UTF-8 bytes: one byte past the remaining budget.
  void link.daemon.deliver({ data: "\u00e9x", isBinary: false });
  expect(link.daemon.closes).toEqual([PROTECTED_HANDSHAKE_FAILED_CLOSE_CODE]);
  expect(await opening).toBeInstanceOf(Error);
});

it("charges non-ASCII handshake text in UTF-8 bytes against the total budget", async () => {
  const full = MAX_HANDSHAKE_INBOUND_BYTES_TOTAL / MAX_HANDSHAKE_INBOUND_BYTES;
  const held: Awaited<ReturnType<typeof stalledHandshake>>[] = [];
  for (let i = 0; i < full; i++) {
    const handshake = await stalledHandshake();
    fill(handshake.link.daemon, MAX_HANDSHAKE_INBOUND_BYTES - handshake.helloBytes - 1024);
    held.push(handshake);
  }
  const { link, opening, helloBytes } = await stalledHandshake();
  fill(link.daemon, full * 1024 - helloBytes - HANDSHAKE_MESSAGE_OVERHEAD_BYTES - 2);
  expect(held.flatMap(({ link }) => link.daemon.closes)).toEqual([]);
  expect(link.daemon.closes).toEqual([]);
  // This connection has ample room; only the shared byte budget is exhausted.
  void link.daemon.deliver({ data: "\u00e9x", isBinary: false });
  expect(link.daemon.closes).toEqual([PROTECTED_HANDSHAKE_FAILED_CLOSE_CODE]);
  expect(await opening).toBeInstanceOf(Error);
});

it("never opens a handshake whose ready is still being sent when the carrier closes", async () => {
  const link = pair();
  const ready = Promise.withResolvers<void>();
  link.daemon.send = () => ready.promise;
  const keys = generateKeyPair();
  let opened = false;
  const opening = openDaemonSecureChannel(link.daemon, { daemonKeyPair: keys, events: { onopen: () => { opened = true; } } })
    .catch((error: unknown) => error);
  await openClientSecureChannel(link.client, { daemonPublicKeyB64: exportPublicKey(keys.publicKey) });
  link.daemon.close();
  ready.resolve();
  expect(await opening).toBeInstanceOf(Error);
  // Let the handshake's microtasks after the resolved send run to completion; no time passes.
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(opened).toBe(false);
});

for (const delay of [1, 2, 3, 4]) it(`never opens, delivers or resolves after the carrier closes ${delay} microtasks after the ready is sent`, async () => {
  const link = pair();
  const keys = generateKeyPair();
  // The send settles first; the close lands while the handshake is still resuming.
  const later = (left: number) => queueMicrotask(() => left > 1 ? later(left - 1) : link.daemon.close());
  // Typed as the Transport's send, which may return void: a synchronous send settles at once.
  (link.daemon as Transport).send = () => { later(delay); };
  // Opening before the close is fine; opening after it is not.
  let openedAfterClose = false;
  const received: (string | ArrayBuffer)[] = [];
  const opening = openDaemonSecureChannel(link.daemon, {
    daemonKeyPair: keys,
    events: { onopen: () => { openedAfterClose = link.daemon.closed; }, onmessage: (data) => received.push(data) },
  }).catch((error: unknown) => error);
  await openClientSecureChannel(link.client, { daemonPublicKeyB64: exportPublicKey(keys.publicKey) });
  expect(await opening).toBeInstanceOf(Error);
  // Let the handshake's microtasks run to completion; no time passes.
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(link.daemon.closed).toBe(true);
  expect(openedAfterClose).toBe(false);
  expect(received).toEqual([]);
});

it("bounds the bytes queued by all handshakes together and releases them on close", async () => {
  // Given handshakes that together hold the whole budget, each within its own.
  const full = MAX_HANDSHAKE_INBOUND_BYTES_TOTAL / MAX_HANDSHAKE_INBOUND_BYTES;
  const held: Awaited<ReturnType<typeof stalledHandshake>>[] = [];
  for (let i = 0; i < full; i++) {
    const handshake = await stalledHandshake();
    fill(handshake.link.daemon, MAX_HANDSHAKE_INBOUND_BYTES - handshake.helloBytes);
    held.push(handshake);
  }
  expect(held.flatMap(({ link }) => link.daemon.closes)).toEqual([]);
  // When one more hello arrives, then that connection closes.
  const refused = await stalledHandshake();
  expect(refused.link.daemon.closes).toEqual([PROTECTED_HANDSHAKE_FAILED_CLOSE_CODE]);
  // When a queued handshake ends, then its bytes are free again.
  held[0]?.link.daemon.close();
  const admitted = await stalledHandshake();
  expect(admitted.link.daemon.closes).toEqual([]);
});

for (const direction of ["client", "daemon"] as const) {
  // "text bytes": a text frame whose data arrives as an ArrayBuffer, as a Node carrier delivers it.
  for (const kind of ["binary", "text", "text bytes"] as const) {
    it(`refuses a ${kind} carrier message to the ${direction} past the frame limit without decoding it`, async () => {
      // Given valid records for a frame at the mux limit and one just past it.
      const session = await connected();
      const sender = direction === "client" ? session.daemon : session.client;
      const outgoing = direction === "client" ? session.link.daemon : session.link.client;
      const incoming = session.link[direction];
      outgoing.held = true;
      await sender.send(new Uint8Array(MAX_FRAME_BYTES).fill(1).buffer);
      // One byte more still rounds to the same base64 length.
      await sender.send(new Uint8Array(MAX_FRAME_BYTES + 1).fill(2).buffer);
      const [atLimit, past] = outgoing.sent.slice(-2).map((message) => {
        if (kind === "binary") return record(bytes(message));
        const text = Buffer.from(bytes(message)).toString("base64");
        return { data: kind === "text" ? text : new TextEncoder().encode(text).buffer, isBinary: false };
      });
      if (!atLimit || !past) throw new Error("No records captured");
      await incoming.deliver(atLimit);
      expect(session.received[direction]).toHaveLength(1);
      // When the larger one arrives, then it is never decoded: a decoded valid record would be delivered.
      await incoming.deliver(past);
      expect(session.received[direction]).toHaveLength(1);
      expect(session[direction].isOpen()).toBe(false);
      expect(incoming.closes).toEqual([direction === "client" ? PROTECTED_RECORD_FAILED_CLOSE_CODE : 1011]);
    });
  }
}

for (const failure of ["malformed record", "explicit close"] as const) {
  it(`rejects queued sends on ${failure} while an earlier transport send is unresolved`, async () => {
    // Given a real protected channel with A blocked inside its transport.
    const { link, client, received } = await connected();
    const entered = Promise.withResolvers<void>();
    const held = Promise.withResolvers<void>();
    const exited = Promise.withResolvers<void>();
    const submitted: (string | ArrayBuffer)[] = [];
    let transportSettled = false;
    link.client.send = async (data) => {
      submitted.push(data);
      entered.resolve();
      await held.promise;
      transportSettled = true;
      exited.resolve();
    };
    const first = client.send("A").catch((error: unknown) => error);
    await entered.promise;
    const queued = [client.send("B"), client.send("C")].map((send) =>
      send.catch((error: unknown) => error));
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      // When closure occurs, settlement cannot depend on releasing A.
      if (failure === "malformed record") {
        await link.client.deliver({ data: new Uint8Array([1]).buffer, isBinary: true });
        expect(link.client.closes).toEqual([PROTECTED_RECORD_FAILED_CLOSE_CODE]);
      } else client.close();
      expect(client.isOpen()).toBe(false);
      const later = client.send("after close").catch((error: unknown) => error);
      const deadline = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("Send rejection did not follow channel closure")), 1000);
      });
      const results = await Promise.race([Promise.all([...queued, later, first]), deadline]);
      // Then every caller rejects while A's transport promise is still unresolved.
      for (const result of results) {
        expect(result).toBeInstanceOf(Error);
        if (!(result instanceof Error)) throw new Error("Expected send rejection");
        expect(result.message).toMatch(/channel.*closed/i);
      }
      expect(transportSettled).toBe(false);
      expect(submitted).toHaveLength(1);
      expect(received.daemon).toEqual([]);
    } finally {
      clearTimeout(timer);
      held.resolve();
      await exited.promise;
      await Promise.all([first, ...queued]);
    }
    await expect(client.send("still closed")).rejects.toThrow(/channel.*closed/i);
    expect(submitted).toHaveLength(1);
  });
}

function bytes(message: TransportMessage): Uint8Array {
  return typeof message.data === "string"
    ? new Uint8Array(Buffer.from(message.data, "base64"))
    : new Uint8Array(message.data);
}
function record(data: Uint8Array): TransportMessage {
  return { data: new Uint8Array(data).buffer, isBinary: true };
}
function concatenate(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) { out.set(part, at); at += part.length; }
  return out;
}

for (const direction of ["client", "daemon"] as const) {
  for (const attack of ["replayed", "reordered", "truncated", "duplicated", "injected"] as const) {
    it(`closes ${direction} on ${attack} records without delivering plaintext`, async () => {
      // Given fresh protected keys and a relay holding a binary record.
      const keys = generateKeyPair();
      const session = await connected(keys);
      const sender = direction === "client" ? session.daemon : session.client;
      const outgoing = direction === "client" ? session.link.daemon : session.link.client;
      const incoming = session.link[direction];
      outgoing.held = true;
      // Small enough that a duplicated record stays within the carrier limit.
      await sender.send(new Uint8Array(8_000).fill(7).buffer);
      const captured = outgoing.sent.at(-1);
      if (!captured) throw new Error("No record captured");
      const original = bytes(captured);
      let hostile: Uint8Array;
      switch (attack) {
        case "replayed": {
          // A ciphertext from another authenticated session must fail on fresh keys.
          const old = await connected(keys);
          const oldOutgoing = direction === "client" ? old.link.daemon : old.link.client;
          const oldSender = direction === "client" ? old.daemon : old.client;
          oldOutgoing.held = true;
          await oldSender.send(new Uint8Array([42]).buffer);
          const previous = oldOutgoing.sent.at(-1);
          if (!previous) throw new Error("No replay record captured");
          hostile = bytes(previous);
          old.client.close();
          break;
        }
        case "reordered": {
          // Forward the second record before the held first one.
          await sender.send(new Uint8Array([8]).buffer);
          const second = outgoing.sent.at(-1);
          if (!second) throw new Error("No second record captured");
          hostile = bytes(second);
          break;
        }
        case "truncated": hostile = original.slice(0, -1); break;
        case "duplicated": hostile = concatenate(original, original); break;
        case "injected": {
          hostile = original.slice();
          // Flip ciphertext, keeping the length framing valid.
          const byte = hostile[5];
          if (byte === undefined) throw new Error("Record too short");
          hostile[5] = byte ^ 1;
          break;
        }
      }
      // When the hostile relay forwards corruption, then close is immediate and
      // neither partial nor complete plaintext from that record is delivered.
      await incoming.deliver(record(hostile));
      expect(session[direction].isOpen()).toBe(false);
      expect(incoming.closes).toEqual([direction === "client" ? PROTECTED_RECORD_FAILED_CLOSE_CODE : 1011]);
      expect(session.received[direction]).toEqual([]);
      await incoming.deliver(captured);
      expect(session.received[direction]).toEqual([]);
    });
  }
  it(`closes ${direction} on a duplicate after a valid record without redelivering it`, async () => {
    // Given a valid record already delivered once on this session.
    const session = await connected();
    const sender = direction === "client" ? session.daemon : session.client;
    const outgoing = direction === "client" ? session.link.daemon : session.link.client;
    const incoming = session.link[direction];
    const payload = new Uint8Array([1, 2, 3]).buffer;
    await sender.send(payload);
    expect(session.received[direction]).toEqual([payload]);
    const captured = outgoing.sent.at(-1);
    if (!captured) throw new Error("No record captured");
    // When the relay repeats it, then the counter rejects it without redelivery.
    await incoming.deliver(captured);
    expect(session[direction].isOpen()).toBe(false);
    expect(incoming.closes).toEqual([direction === "client" ? PROTECTED_RECORD_FAILED_CLOSE_CODE : 1011]);
    expect(session.received[direction]).toEqual([payload]);
  });
}
