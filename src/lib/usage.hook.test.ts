import { afterEach, beforeEach, describe, expect, it, jest, setSystemTime, spyOn } from "bun:test";
import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import type { UsageReport } from "../../shared/protocol.ts";
import { useUsage } from "./usage.ts";

const START = Date.parse("2026-09-29T12:00:00Z");
const MINUTE = 60_000;
const PC = START + 40 * MINUTE;

describe("the report the usage hook hands on", () => {
  const descriptors = new Map<string, PropertyDescriptor | undefined>();
  let renderer: ReactTestRenderer | null;
  let hook: ReturnType<typeof useUsage> | null;
  let pc: () => Promise<Response>;
  let asks: number;
  let answered: Set<() => void>;
  let openedAt: number;

  beforeEach(() => {
    for (const key of ["window", "document", "IS_REACT_ACT_ENVIRONMENT"]) descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    const page = new EventTarget();
    const listening = { addEventListener: page.addEventListener.bind(page), removeEventListener: page.removeEventListener.bind(page) };
    Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
    Object.defineProperty(globalThis, "window", { configurable: true, value: listening });
    Object.defineProperty(globalThis, "document", { configurable: true, value: { visibilityState: "visible", ...listening } });
    renderer = null;
    hook = null;
    asks = 0;
    answered = new Set();
    const ask = async (): Promise<Response> => {
      asks++;
      try { return await pc(); }
      finally { for (const listener of [...answered]) listener(); }
    };
    spyOn(globalThis, "fetch").mockImplementation(Object.assign(ask, { preconnect: globalThis.fetch.preconnect }));
    jest.useFakeTimers();
    setSystemTime(new Date(START));
    openedAt = performance.now();
  });

  afterEach(async () => {
    await act(async () => { renderer?.unmount(); });
    jest.useRealTimers();
    setSystemTime();
    jest.restoreAllMocks();
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    descriptors.clear();
  });

  const pcNow = (): number => PC + Math.round(performance.now() - openedAt);
  const says = (readAt: number) => async (): Promise<Response> => Response.json({
    server_time: new Date(pcNow()).toISOString(),
    providers: [{ id: "claude", key: "claude:recorded", account: "me@example.com", plan: null, windows: [], problem: null, checked_at: new Date(readAt).toISOString(), recorded: { by: "omp", stale: false, signed_in: false } }],
  } satisfies UsageReport);
  const silent = (): Promise<Response> => new Promise(() => {});
  const stale = (): boolean | undefined => hook?.report?.providers[0]?.recorded?.stale;

  function heard(): Promise<void> {
    return new Promise((resolve) => {
      const done = () => { answered.delete(done); resolve(); };
      answered.add(done);
    });
  }
  async function open(): Promise<void> {
    function Probe() { hook = useUsage(true); return null; }
    const first = heard();
    await act(async () => { renderer = create(createElement(Probe)); });
    await act(async () => { await first; });
  }
  async function minute(wait: "heard" | "unheard"): Promise<void> {
    const next = wait === "heard" ? heard() : null;
    await act(async () => { jest.advanceTimersByTime(MINUTE); await next; });
  }

  it("ages the report in hand as it asks again, before any answer: a PC that never answers leaves no record current", async () => {
    pc = () => says(pcNow() - 13 * MINUTE)();
    await open();
    await minute("heard");
    await minute("heard");
    expect([asks, stale()]).toEqual([3, false]);
    pc = silent;
    await minute("unheard");
    await minute("unheard");
    expect([asks, stale()]).toEqual([5, false]);
    await minute("unheard");
    expect([asks, stale()]).toEqual([6, true]);
  });

  it("ages it as an ask fails, and counts again from the PC's next answer", async () => {
    pc = says(PC - 14 * MINUTE);
    await open();
    pc = async () => { throw new TypeError("Failed to fetch"); };
    await minute("heard");
    expect(stale()).toBe(false);
    await minute("heard");
    expect(stale()).toBe(true);
    pc = says(PC + 2 * MINUTE);
    await minute("heard");
    expect(stale()).toBe(false);
  });

  it("takes nothing off a record's age when the device's clock is set back while the PC is silent", async () => {
    pc = says(PC - 13 * MINUTE);
    await open();
    pc = silent;
    setSystemTime(new Date(Date.now() - 15 * MINUTE));
    await minute("unheard");
    await minute("unheard");
    await minute("unheard");
    expect([asks, stale()]).toEqual([4, true]);
  });

  it("lets no record grow younger while the PC is silent: a sleep that stopped the running clock, then the wall clock set back", async () => {
    pc = says(PC - 13 * MINUTE);
    await open();
    pc = silent;
    setSystemTime(new Date(Date.now() + 20 * MINUTE));
    await minute("unheard");
    expect([asks, stale()]).toEqual([2, true]);
    setSystemTime(new Date(Date.now() - 25 * MINUTE));
    await minute("unheard");
    expect([asks, stale()]).toEqual([3, true]);
  });

  it("counts a clock set back and then forward again as no time at all, while the PC is silent", async () => {
    pc = says(PC - 2 * MINUTE);
    await open();
    pc = silent;
    setSystemTime(new Date(Date.now() - 25 * MINUTE));
    await minute("unheard");
    setSystemTime(new Date(Date.now() + 25 * MINUTE));
    await minute("unheard");
    expect([asks, stale()]).toEqual([3, false]);
  });

  it("takes a record as the PC has just called it, though the device's clock was set back while the ask was in flight", async () => {
    pc = says(PC - 2 * MINUTE);
    await open();
    pc = async () => {
      setSystemTime(new Date(Date.now() - 60 * MINUTE));
      return says(PC - 2 * MINUTE)();
    };
    await minute("heard");
    expect([asks, stale()]).toEqual([2, false]);
  });

  it("hands on the same report while the PC says the same, though its time moves on", async () => {
    pc = says(PC - 2 * MINUTE);
    await open();
    const first = hook?.report;
    expect(first?.providers[0]?.account).toBe("me@example.com");
    await minute("heard");
    await minute("heard");
    expect(asks).toBe(3);
    expect(hook?.report).toBe(first);
  });
});
