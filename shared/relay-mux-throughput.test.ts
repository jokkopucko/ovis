import { expect, it } from "bun:test";
import { BenchmarkClock, benchmarkMux, BULK_BYTES } from "../scripts/relay-mux-benchmark.ts";

for (const mode of ["binary", "base64"] as const) it(`delivers 64 MiB above 5 MB/s at 50 ms RTT without delaying terminal p95 by 1.5x (${mode})`, async () => {
  const idleClock = new BenchmarkClock();
  const idle = await idleClock.run(benchmarkMux(idleClock, 50, false, 100, mode));
  const clock = new BenchmarkClock();
  const loaded = await clock.run(benchmarkMux(clock, 50, true, 100, mode));
  console.log(JSON.stringify({ idleP95Ms: idle.echoP95Ms, ...loaded }));
  expect(loaded.bytes).toBe(BULK_BYTES);
  expect(loaded.echoSamples).toBeGreaterThan(100);
  expect(loaded.mbPerSecond).toBeGreaterThanOrEqual(5);
  expect(loaded.echoP95Ms).toBeLessThanOrEqual(idle.echoP95Ms * 1.5);
  expect(loaded.peakAccounted).toBeLessThan(32 * 1024 * 1024);
}, 30_000);
