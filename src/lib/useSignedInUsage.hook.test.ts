import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { useSignedInUsage } from "./useSetupGuide.ts";

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

  const mount = async (answers: (() => Promise<readonly string[]>)[], enabled = true): Promise<void> => {
    const read = (): Promise<readonly string[]> => { reads += 1; return answers.shift()!(); };
    function Probe({ on }: { on: boolean }) {
      useSignedInUsage([], read, false, () => { turnedOn += 1; }, on);
      return null;
    }
    await act(async () => { renderer = create(createElement(Probe, { on: enabled })); });
    probe = (on: boolean) => act(async () => { renderer?.update(createElement(Probe, { on })); });
  };
  let probe: (on: boolean) => Promise<void> = async () => {};
  const runTimers = async (): Promise<void> => {
    const due = [...timers.values()];
    timers.clear();
    await act(async () => { for (const run of due) run(); });
  };

  it("reads nothing and turns nothing on until it is enabled (the user's press), then reads", async () => {
    await mount([() => Promise.resolve(["claude"])], false);
    expect([reads, turnedOn, timers.size]).toEqual([0, 0, 0]);
    await probe(true);
    expect([reads, turnedOn]).toEqual([1, 1]);
  });

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
