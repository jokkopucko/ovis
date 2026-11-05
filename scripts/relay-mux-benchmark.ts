import assert from "node:assert/strict";
import { setImmediate } from "node:timers";
import { MuxEngine } from "../shared/relay-mux-engine.ts";
import type { HttpStream, MuxClock } from "../shared/relay-mux-engine.ts";
import { WS_CONTINUATION_CAPACITY } from "../shared/relay-mux.ts";

export const BULK_BYTES = 64 * 1024 * 1024;

/** Discrete events, not elapsed wall time. An event-loop turn drains producer/reader microtasks. */
export class BenchmarkClock implements MuxClock {
  private time = 0;
  private sequence = 0;
  private readonly events = new Map<number, { at: number; callback: () => void }>();
  now(): number { return this.time; }
  setTimeout(callback: () => void, milliseconds: number): () => void {
    const id = ++this.sequence;
    this.events.set(id, { at: this.time + milliseconds, callback });
    return () => { this.events.delete(id); };
  }
  async run<T>(work: Promise<T>): Promise<T> {
    let settled = false;
    const result = work.finally(() => { settled = true; });
    // Attach rejection handling before driving events; the original rejection still propagates.
    void result.catch(() => undefined);
    for (let budget = 200_000; !settled; budget--) {
      assert.ok(budget > 0, "benchmark event budget exhausted");
      await new Promise<void>((resolve) => setImmediate(resolve));
      if (settled) break;
      const next = [...this.events].sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
      assert.ok(next, "mux deadlocked without an event");
      this.time = next[1].at;
      this.events.delete(next[0]);
      next[1].callback();
    }
    return result;
  }
}

export interface BenchmarkResult {
  readonly rttMs: number;
  readonly linkMbps: number;
  readonly wireMode: "binary" | "base64";
  readonly bytes: number;
  readonly elapsedMs: number;
  readonly mbPerSecond: number;
  readonly echoSamples: number;
  readonly echoP95Ms: number;
  readonly peakBulkFlight: number;
  readonly peakAccounted: number;
}

/**
 * Two real engines with a full-duplex, FIFO, bandwidth-limited carrier. send() resolves on
 * submission, NOT delivery: it cannot accidentally turn the receipt test into stop-and-wait.
 * Protected binary records cost plaintext + 24 bytes. Crypto CPU and WebSocket framing are
 * excluded; this is a mux/window benchmark, not a hosted relay speed claim.
 */
export async function benchmarkMux(
  clock: MuxClock, rttMs: number, bulk: boolean, linkMbps = 100, wireMode: "binary" | "base64" = "binary",
): Promise<BenchmarkResult> {
  const links = { client: 0, server: 0 };
  const queues: Record<"client" | "server", { at: number; bytes: Uint8Array }[]> = { client: [], server: [] };
  const wireCost = (bytes: Uint8Array) => wireMode === "binary" ? bytes.length + 24 : Math.ceil((bytes.length + 24) / 3) * 4;
  const deliveries = new Set<() => void>();
  const echoes: number[] = [];
  const errors: string[] = [];
  let closing = false;
  let peakBulkFlight = 0;
  let peakAccounted = 0;
  let client: MuxEngine;
  let server: MuxEngine;
  let respond: ((stream: HttpStream) => void) | undefined;
  const deliver = (role: "client" | "server") => {
    const next = queues[role][0];
    if (!next) return;
    const cancel = clock.setTimeout(() => {
      deliveries.delete(cancel);
      queues[role].shift();
      (role === "client" ? server : client).receive(next.bytes);
      // Real timers can fire late; drain due records in FIFO order, never reorder rounded timers.
      while (queues[role][0] && queues[role][0].at <= clock.now()) {
        const due = queues[role].shift();
        if (due) (role === "client" ? server : client).receive(due.bytes);
      }
      deliver(role);
    }, Math.max(0, next.at - clock.now()));
    deliveries.add(cancel);
  };
  const make = (role: "client" | "server") => new MuxEngine({
    role, clock, routingOverhead: 0, maxWireMessageBytes: 65536,
    outboundWireByteLength: wireCost,
    requestTimeoutMs: () => 0,
    onHttp: (stream) => { respond?.(stream); },
    close: () => undefined,
    onClose: (error) => { if (!closing) errors.push(`${role}: ${error.code}: ${error.message}`); },
    send: async (bytes) => {
      const finish = Math.max(clock.now(), links[role]) + wireCost(bytes) / (linkMbps * 125);
      links[role] = finish;
      queues[role].push({ at: finish + rttMs / 2, bytes });
      if (queues[role].length === 1) deliver(role);
      for (const engine of [client, server]) {
        peakBulkFlight = Math.max(peakBulkFlight, engine.stats.bulkFlightBytes);
        peakAccounted = Math.max(peakAccounted, engine.stats.accountedBytes);
      }
    },
    onWs: (stream) => {
      stream.onMessage = (message) => { stream.send(message); };
      stream.accept();
    },
  });
  client = make("client");
  server = make("server");
  client.authenticate("0123456789abcdef");
  server.authenticate("0123456789abcdef");
  let cancelProbe: (() => void) | undefined;
  let cancelDeadline: (() => void) | undefined;
  try {
    const terminal = client.openWs({ target: "/ws", headers: [], protocols: [] });
    await new Promise<void>((resolve) => { terminal.onAccept = () => resolve(); });
    const started = clock.now();
    let finished = false;
    let sent = 0;
    const pending = new Map<string, number>();
    let finishEcho = (): void => undefined;
    const echoDone = new Promise<void>((resolve) => { finishEcho = resolve; });
    terminal.onMessage = (message) => {
      assert.equal(typeof message, "string");
      const key = String(message);
      const sentAt = pending.get(key);
      assert.ok(sentAt !== undefined, "unexpected or duplicate echo");
      pending.delete(key);
      echoes.push(clock.now() - sentAt);
      if ((finished || !bulk && sent === 128) && !pending.size) finishEcho();
    };
    const probe = () => {
      const key = `terminal-${sent++}`;
      pending.set(key, clock.now());
      terminal.send(key);
      // Fixed offered load avoids coordinated omission; 37 ms is not phase-locked to RTT.
      if (!finished && (bulk || sent < 128)) cancelProbe = clock.setTimeout(probe, 37);
    };
    probe();
    let bytes = 0;
    let elapsedMs = 0;
    // Match the production server adapter's bounded, maximum-DATA-sized writes.
    const bodyDone = bulk ? new Promise<void>((resolve, reject) => {
      respond = (stream) => {
        void (async () => {
          stream.headers(200, [["content-length", String(BULK_BYTES)]]);
          for (let offset = 0; offset < BULK_BYTES; offset += WS_CONTINUATION_CAPACITY) {
            await stream.write(new Uint8Array(Math.min(WS_CONTINUATION_CAPACITY, BULK_BYTES - offset)).fill(37));
          }
          stream.end();
        })().catch(reject);
      };
      const file = client.openHttp({ method: "GET", target: "/file", headers: [], body: "none" });
      void (async () => {
        const reader = file.body.getReader();
        for (;;) {
          const next = await reader.read();
          if (next.done) break;
          assert.ok(next.value.every((byte) => byte === 37), "corrupt bulk payload");
          bytes += next.value.length;
        }
        assert.equal(bytes, BULK_BYTES);
        elapsedMs = clock.now() - started;
        finished = true;
        cancelProbe?.();
        if (!pending.size) finishEcho();
        resolve();
      })().catch(reject);
    }) : Promise.resolve();
    const deadline = new Promise<never>((_, reject) => {
      cancelDeadline = clock.setTimeout(() => reject(new Error(`benchmark timed out: ${errors.join("; ")}`)), 600_000);
    });
    await Promise.race([Promise.all([bodyDone, echoDone]), deadline]);
    assert.deepEqual(errors, []);
    const sorted = echoes.sort((a, b) => a - b);
    const echoP95Ms = sorted[Math.ceil(sorted.length * 0.95) - 1];
    assert.ok(echoP95Ms !== undefined);
    return { rttMs, linkMbps, wireMode, bytes, elapsedMs, mbPerSecond: elapsedMs ? bytes / elapsedMs / 1000 : 0,
      echoSamples: echoes.length, echoP95Ms, peakBulkFlight, peakAccounted };
  } finally {
    closing = true;
    cancelDeadline?.();
    cancelProbe?.();
    for (const cancel of deliveries) cancel();
    client.carrierLost();
    server.carrierLost();
  }
}

if (import.meta.main) {
  const real = process.argv.includes("--real");
  const wireMode = process.argv.includes("--base64") ? "base64" : "binary";
  for (const rtt of [0, 20, 50, 100]) {
    const run = (bulk: boolean) => {
      if (!real) {
        const clock = new BenchmarkClock();
        return clock.run(benchmarkMux(clock, rtt, bulk, 100, wireMode));
      }
      return benchmarkMux({
        now: () => performance.now(),
        setTimeout: (callback, ms) => {
          const timer = setTimeout(callback, ms);
          return () => clearTimeout(timer);
        },
      }, rtt, bulk, 100, wireMode);
    };
    const idle = await run(false);
    const loaded = await run(true);
    console.log(JSON.stringify({ mode: real ? "real" : "deterministic", ...loaded,
      idleP95Ms: idle.echoP95Ms, latencyRatio: loaded.echoP95Ms / idle.echoP95Ms }));
  }
}
