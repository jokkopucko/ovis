import { afterEach, beforeEach, describe, expect, it, jest } from "bun:test";
import { keepEventStream, STREAM_REOPEN_MAX_MS, STREAM_REOPEN_MS, type EventStreamHandlers } from "./eventStream.ts";

class FakeSource {
  readyState = 0;
  closedByApp = false;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  constructor(readonly url: string) {}
  open(): void { this.readyState = 1; this.onopen?.(); }
  /** lost; the browser reconnects it */
  lose(): void { this.readyState = 0; this.onerror?.(); }
  /** a non-200 answer (a proxy's 502): the browser never reconnects it */
  refuse(): void { this.readyState = 2; this.onerror?.(); }
  say(data: string): void { this.onmessage?.(new MessageEvent("message", { data })); }
  close(): void { this.readyState = 2; this.closedByApp = true; }
}

describe("the app's event stream", () => {
  let sources: FakeSource[];
  let seen: string[];
  const handlers: EventStreamHandlers = {
    opened: () => seen.push("opened"),
    lost: () => seen.push("lost"),
    closed: () => seen.push("closed"),
    message: (event) => seen.push(`message ${event.data}`),
  };
  const open = (url: string) => { const source = new FakeSource(url); sources.push(source); return source as unknown as EventSource; };
  const last = () => sources.at(-1)!;

  beforeEach(() => {
    sources = [];
    seen = [];
    jest.useFakeTimers();
  });
  afterEach(() => { jest.useRealTimers(); });

  it("lets the browser reconnect a lost stream by itself, without a second one", () => {
    const stop = keepEventStream("/api/machines/events", handlers, open);
    last().open();
    last().say("a");
    last().lose();
    jest.advanceTimersByTime(STREAM_REOPEN_MAX_MS * 2);
    expect(sources.length).toBe(1);
    last().open();
    expect(seen).toEqual(["opened", "message a", "lost", "opened"]);
    stop();
    expect(last().closedByApp).toBe(true);
  });

  it("opens a new stream after the browser gave up on one (a proxy's 502 while the server restarts), and tells it apart from a loss", () => {
    const stop = keepEventStream("/api/machines/events", handlers, open);
    last().open();
    // the restart: the browser's reconnect gets a 502 and the stream stays closed
    last().lose();
    last().refuse();
    expect(seen).toEqual(["opened", "lost", "closed"]);
    jest.advanceTimersByTime(STREAM_REOPEN_MS - 1);
    expect(sources.length).toBe(1);
    jest.advanceTimersByTime(1);
    expect(sources.map((source) => source.url)).toEqual(["/api/machines/events", "/api/machines/events"]);
    last().open();
    last().say("b");
    expect(seen).toEqual(["opened", "lost", "closed", "opened", "message b"]);
    stop();
    expect(last().closedByApp).toBe(true);
  });

  it("doubles the wait while new streams keep failing, up to a minute, and starts over once one opens", () => {
    const stop = keepEventStream("/api/machines/events", handlers, open);
    const waits: number[] = [];
    for (let index = 0; index < 8; index++) {
      const before = sources.length;
      last().refuse();
      let waited = 0;
      while (sources.length === before && waited <= STREAM_REOPEN_MAX_MS) { jest.advanceTimersByTime(1_000); waited += 1_000; }
      waits.push(waited);
    }
    expect(waits).toEqual([2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000, 60_000]);
    last().open();
    last().refuse();
    jest.advanceTimersByTime(STREAM_REOPEN_MS);
    expect(sources.length).toBe(10);
    stop();
  });

  it("opens nothing more once stopped, and hears nothing from a stream it replaced", () => {
    const stop = keepEventStream("/api/machines/events", handlers, open);
    const first = last();
    first.refuse();
    jest.advanceTimersByTime(STREAM_REOPEN_MS);
    first.say("late");
    first.onerror?.();
    expect(seen).toEqual(["closed"]);
    last().refuse();
    stop();
    jest.advanceTimersByTime(STREAM_REOPEN_MAX_MS * 2);
    expect(sources.length).toBe(2);
  });
});
