import { expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DeviceGoneError, DeviceStore } from "../devices.ts";
import { PAIR_CLOSE } from "../../relay/pair-room.ts";
import { RelayPairCodes } from "./pair-code.ts";
import { loadRelayIdentity } from "./identity.ts";

/** A host socket the test drives: what the PC sends is kept, and the relay's frames and close are the test's to deliver. */
class FakeSocket extends EventTarget {
  binaryType = "arraybuffer";
  sent: unknown[] = [];
  closed = false;
  constructor(readonly url: string) { super(); }
  send(data: unknown) { this.sent.push(data); this.dispatchEvent(new Event("sent")); }
  close() { this.closed = true; }
  relay(text: string) { this.dispatchEvent(new MessageEvent("message", { data: text })); }
  end(code: number) { this.dispatchEvent(Object.assign(new Event("close"), { code })); }
}

function codes(keepaliveMs?: number) {
  const dir = mkdtempSync(join(tmpdir(), "ovis-pair-code-"));
  const sockets: FakeSocket[] = [];
  const devices = new DeviceStore(dir);
  const identity = loadRelayIdentity(dir);
  const pairCodes = new RelayPairCodes({
    relay: "wss://relay.test", devices, keepaliveMs, identity: () => identity,
    offer: (code) => ({ v: 1, server_id: "0".repeat(32), server_public_key: "k", relay: "wss://relay.test", code }),
    connect: (url) => { const socket = new FakeSocket(url); sockets.push(socket); return socket as unknown as WebSocket; },
  });
  return { pairCodes, sockets, devices, done: () => { pairCodes.cancel(); rmSync(dir, { recursive: true, force: true }); } };
}

it("a mint that a newer one replaced, still waiting on the relay, leaves nothing open once the code is hidden", async () => {
  const { pairCodes, sockets, done } = codes();
  try {
    const first = pairCodes.mint().catch((error: unknown) => error);
    const second = pairCodes.mint();
    sockets[1]!.relay(JSON.stringify({ type: "waiting" }));
    await second;
    // the first mint's relay answers late: another PC holds its nameplate
    sockets[0]!.end(PAIR_CLOSE.TAKEN);
    expect(await first).toBeInstanceOf(Error);
    pairCodes.cancel();
    expect(sockets.filter((socket) => !socket.closed).map((socket) => socket.url)).toEqual([]);
  } finally { done(); }
});

it("gives no code to a device that was revoked while its code waited on the relay", async () => {
  const { pairCodes, sockets, devices, done } = codes();
  try {
    const pairHere = (label: string) => {
      const paired = devices.pair(devices.startPairing().code, label, "drive")!;
      devices.match(paired.token);
      return paired.device.id;
    };
    // revoked before the relay answered: the six digits behind the code would be held by a device no revoke can name
    const laptop = pairHere("Laptop");
    const minted = pairCodes.mint(laptop).catch((error: unknown) => error);
    devices.revoke(laptop);
    sockets[0]!.relay(JSON.stringify({ type: "waiting" }));
    expect(await minted).toBeInstanceOf(DeviceGoneError);
    expect(devices.activePairing()).toBeNull();
    expect(pairCodes.showing).toBeNull();
    expect(sockets.filter((socket) => !socket.closed).map((socket) => socket.url)).toEqual([]);
    // the same with Revoke all while the relay was asked
    const tablet = pairHere("Tablet");
    const second = pairCodes.mint(tablet).catch((error: unknown) => error);
    devices.revokeAll();
    sockets[1]!.relay(JSON.stringify({ type: "waiting" }));
    expect(await second).toBeInstanceOf(DeviceGoneError);
    expect(devices.activePairing()).toBeNull();
    expect(pairCodes.showing).toBeNull();
    // this PC's own code, asked for by no device, is started as before
    const own = pairCodes.mint();
    sockets[2]!.relay(JSON.stringify({ type: "waiting" }));
    await own;
    expect(devices.activePairing()).not.toBeNull();
  } finally { done(); }
});

it("keeps its nameplate on the relay with keepalives while no device comes", async () => {
  const { pairCodes, sockets, done } = codes(10);
  try {
    const minted = pairCodes.mint();
    const host = sockets[0]!;
    host.relay(JSON.stringify({ type: "waiting" }));
    await minted;
    const pinged = new Promise<void>((resolve) => host.addEventListener("sent", () => { if (host.sent.includes('{"type":"ping"}')) resolve(); }));
    await Promise.race([pinged, new Promise((_resolve, reject) => setTimeout(() => reject(new Error("no keepalive")), 2000))]);
  } finally { done(); }
});

it("text from the relay that is not an object leaves the code showing", async () => {
  const { pairCodes, sockets, done } = codes();
  try {
    const minted = pairCodes.mint();
    const host = sockets[0]!;
    host.relay(JSON.stringify({ type: "waiting" }));
    await minted;
    for (const text of ["null", "1", "[]"]) host.relay(text);
    expect(pairCodes.showing).not.toBeNull();
    expect(host.closed).toBe(false);
  } finally { done(); }
});

it("a code the relay did not take leaves the six-digit code, and so the QR code, as it was", async () => {
  const { pairCodes, sockets, devices, done } = codes();
  try {
    const before = devices.startPairing();
    const minted = pairCodes.mint().catch((error: unknown) => error);
    sockets[0]!.end(1006);
    expect(await minted).toBeInstanceOf(Error);
    expect(devices.activePairing()).toEqual(before);
  } finally { done(); }
});

it("a new six-digit code takes the typed code off the relay", async () => {
  const { pairCodes, sockets, devices, done } = codes();
  try {
    const minted = pairCodes.mint();
    sockets[0]!.relay(JSON.stringify({ type: "waiting" }));
    await minted;
    expect(pairCodes.showing).not.toBeNull();
    devices.startPairing();
    expect(pairCodes.showing).toBeNull();
    expect(sockets[0]!.closed).toBe(true);
  } finally { done(); }
});
