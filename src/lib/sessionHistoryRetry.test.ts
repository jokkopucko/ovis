import { expect, it, jest } from "bun:test";
import type { SessionHistoryResponse } from "../../shared/protocol.ts";
import { ApiError } from "./api.ts";
import { readSessionHistory } from "./sessionHistoryRetry.ts";

const listing: SessionHistoryResponse = { workspace_id: "w1", agent: "pi", cwd: "/work", sessions: [] };
const busy = (retryAfterMs: number | null = 1_000) => new ApiError("/api/sessions/history", 503, "busy", "session_history_busy", retryAfterMs);

it("recovers a busy Pi listing after honoring Retry-After", async () => {
  const gate = Promise.withResolvers<void>();
  const waiting = Promise.withResolvers<number>();
  let calls = 0;
  const result = readSessionHistory(async () => {
    if (++calls === 1) throw busy(4_000);
    return listing;
  }, "pi", { signal: new AbortController().signal, wait: (ms) => { waiting.resolve(ms); return gate.promise; } });
  expect(await waiting.promise).toBe(4_000);
  expect(calls).toBe(1);
  gate.resolve();
  expect(await result).toBe(listing);
  expect(calls).toBe(2);
});

it("bounds persistent busy retries and caps server delays", async () => {
  const pauses: number[] = [];
  let calls = 0;
  const result = readSessionHistory(async () => { calls++; throw busy(120_000); }, "pi", {
    signal: new AbortController().signal,
    wait: async (ms) => { pauses.push(ms); },
  });
  await expect(result).rejects.toMatchObject({ status: 503, code: "session_history_busy" });
  expect(calls).toBe(6);
  expect(pauses).toEqual([60_000, 60_000, 60_000, 60_000, 60_000]);
});

it("uses the file-busy backoff when Retry-After is absent", async () => {
  const pauses: number[] = [];
  await expect(readSessionHistory(async () => { throw busy(null); }, "pi", {
    signal: new AbortController().signal, wait: async (ms) => { pauses.push(ms); },
  })).rejects.toMatchObject({ code: "session_history_busy" });
  expect(pauses).toEqual([1_000, 2_000, 5_000, 15_000, 30_000]);
});

it("does not retry other agents or other errors", async () => {
  for (const [agent, reason] of [["codex", busy()], ["pi", new ApiError("/", 500, "failed", "internal")], ["pi", new ApiError("/", 503, "busy", "file_busy")]] as const) {
    let calls = 0;
    await expect(readSessionHistory(async () => { calls++; throw reason; }, agent, {
      signal: new AbortController().signal, wait: async () => { throw new Error("unexpected retry"); },
    })).rejects.toBe(reason);
    expect(calls).toBe(1);
  }
});

it("does not start another read after cancellation during a retry pause", async () => {
  const controller = new AbortController();
  const waiting = Promise.withResolvers<void>();
  const gate = Promise.withResolvers<void>();
  let calls = 0;
  const result = readSessionHistory(async () => { calls++; throw busy(); }, "pi", {
    signal: controller.signal, wait: () => { waiting.resolve(); return gate.promise; },
  });
  const rejected = result.catch((reason: unknown) => reason);
  await waiting.promise;
  controller.abort();
  gate.resolve();
  expect(await rejected).toMatchObject({ name: "AbortError" });
  expect(calls).toBe(1);
});

it("clears the real retry timer when the list closes", async () => {
  jest.useFakeTimers();
  const controller = new AbortController();
  const reading = Promise.withResolvers<SessionHistoryResponse>();
  try {
    const result = readSessionHistory(() => reading.promise, "pi", { signal: controller.signal });
    const rejected = result.catch((reason: unknown) => reason);
    reading.reject(busy());
    // Await the read's exact rejection handler, which schedules its pause before this continuation.
    await reading.promise.catch(() => undefined);
    expect(jest.getTimerCount()).toBe(1);
    controller.abort();
    expect(await rejected).toMatchObject({ name: "AbortError" });
    expect(jest.getTimerCount()).toBe(0);
  } finally {
    controller.abort();
    jest.useRealTimers();
  }
});
