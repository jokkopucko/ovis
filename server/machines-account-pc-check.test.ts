import { afterEach, expect, it, jest } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exportPublicKey, generateKeyPair, importPublicKey } from "../shared/relay-e2ee.ts";
import type { RelaySocket } from "../shared/relay-channel.ts";
import { PC_ANSWER_MS } from "../shared/relay-channel.ts";
import { deriveServerId } from "../shared/relay-server-proof.ts";
import type { CompletionTracker } from "./completion.ts";
import { MachineManager } from "./machines.ts";
import type { PushService } from "./push.ts";

const ends: (() => void)[] = [];
afterEach(() => { jest.useRealTimers(); for (const end of ends.splice(0).reverse()) end(); });

/** A relay that assigns the connection at once and never brings a PC: what a PC that does not answer looks like. */
class SilentRelay {
  binaryType: BinaryType = "arraybuffer";
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onopen: ((event: Event) => void) | null = null;
  closed: number | null = null;
  get readyState(): number { return this.closed === null ? 1 : 3; }
  send(): void {}
  close(code = 1000): void { if (this.closed === null) this.closed = code; }
}

it("waits as long for another PC of the account to answer as a device does, before it says nothing answered", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ovis-account-pc-check-"));
  let assigned = false;
  const manager = new MachineManager(dir, {} as PushService, {} as CompletionTracker, async () => { throw new Error("local offline"); }, { relaySocket: () => {
    const socket = new SilentRelay();
    queueMicrotask(() => { socket.onopen?.(new Event("open")); socket.onmessage?.(new MessageEvent("message", { data: JSON.stringify({ type: "assigned", connection_id: "ef".repeat(16) }) })); assigned = true; });
    return socket as unknown as RelaySocket;
  } });
  ends.push(() => { manager.stop(); rmSync(dir, { recursive: true, force: true }); });
  const key = generateKeyPair().publicKey;
  const pc = { server_id: deriveServerId(importPublicKey(exportPublicKey(key))), server_public_key: exportPublicKey(key), relay: "wss://relay.example", name: "Desk" };
  jest.useFakeTimers();
  let answer: unknown = null;
  void manager.checkAccountPcs([pc]).then((found) => { answer = found; });
  const deadline = Date.now() + 10_000;
  while (!assigned) { if (Date.now() > deadline) throw new Error("the relay was never asked"); await Promise.resolve(); jest.advanceTimersByTime(0); await new Promise((resolve) => setImmediate(resolve)); }
  for (let turn = 0; turn < 20; turn++) await Promise.resolve();
  // past the 10 s it waited before, and short of what a device waits: still waiting
  jest.advanceTimersByTime(PC_ANSWER_MS - 1_000);
  for (let turn = 0; turn < 20; turn++) await Promise.resolve();
  expect(answer).toBeNull();
  jest.advanceTimersByTime(2_000);
  for (let turn = 0; turn < 50 && answer === null; turn++) await new Promise((resolve) => setImmediate(resolve));
  expect(answer).toEqual([{ server_id: pc.server_id, state: "offline" }]);
});
