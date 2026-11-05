import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { useSignedInUsage } from "./useSetupGuide.ts";

// The real hook with the guide's Start screen life: the first usage read fails, a retry waits, the guide closes.
describe("plan usage turned on by the setup guide", () => {
  const saved = new Map<string, PropertyDescriptor | undefined>();
  let timers: Map<number, () => void>;
  let reads: number;
  let turnedOn: number;
  let renderer: ReactTestRenderer | undefined;

  beforeEach(() => {
    for (const key of ["window", "IS_REACT_ACT_ENVIRONMENT"]) saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    timers = new Map();
    reads = 0;
    turnedOn = 0;
    let next = 1;
    Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
    Object.defineProperty(globalThis, "window", { configurable: true, value: {
      setTimeout: (run: () => void) => { const id = next++; timers.set(id, run); return id; },
      clearTimeout: (id: number) => { timers.delete(id); },
    } });
  });

  afterEach(async () => {
    await act(async () => { renderer?.unmount(); });
    renderer = undefined;
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  });

  const mount = async (answers: (() => Promise<readonly string[]>)[]): Promise<void> => {
    const read = (): Promise<readonly string[]> => { reads += 1; return answers.shift()!(); };
    function Probe() {
      useSignedInUsage([], read, false, () => { turnedOn += 1; });
      return null;
    }
    await act(async () => { renderer = create(createElement(Probe)); });
  };
  const runTimers = async (): Promise<void> => {
    const due = [...timers.values()];
    timers.clear();
    await act(async () => { for (const run of due) run(); });
  };

  it("turns usage on once a retried read finds a signed-in account", async () => {
    await mount([() => Promise.reject(new Error("offline")), () => Promise.resolve(["claude"])]);
    expect(timers.size).toBe(1);
    await runTimers();
    expect([reads, turnedOn]).toEqual([2, 1]);
  });

  it("after the guide closes, a waiting retry neither reads again nor changes the setting", async () => {
    await mount([() => Promise.reject(new Error("offline")), () => Promise.resolve(["claude"])]);
    expect(timers.size).toBe(1);
    await act(async () => { renderer?.unmount(); });
    renderer = undefined;
    await runTimers();
    expect([reads, turnedOn]).toEqual([1, 0]);
  });

  it("after the guide closes, an answer still on its way changes nothing", async () => {
    const late = Promise.withResolvers<readonly string[]>();
    await mount([() => late.promise]);
    await act(async () => { renderer?.unmount(); });
    renderer = undefined;
    await act(async () => { late.resolve(["claude", "codex"]); await late.promise; });
    expect(turnedOn).toBe(0);
  });
});
