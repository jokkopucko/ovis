import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { act, createElement } from "react";
import { openPage, type Page } from "./page.fixture.ts";
import { useSignedInUsage } from "./useSetupGuide.ts";

describe("plan usage turned on by the setup guide", () => {
  let timers: Map<number, () => void>;
  let reads: number;
  let turnedOn: number;
  let page: Page;

  beforeEach(() => {
    page = openPage();
    timers = new Map();
    reads = 0;
    turnedOn = 0;
    let next = 1;
    Object.defineProperty(page.window, "setTimeout", { configurable: true, value: (run: () => void) => { const id = next++; timers.set(id, run); return id; } });
    Object.defineProperty(page.window, "clearTimeout", { configurable: true, value: (id: number) => { timers.delete(id); } });
  });

  afterEach(async () => { await page.close(); });

  const mount = async (answers: (() => Promise<readonly string[]>)[], enabled = true): Promise<void> => {
    const read = (): Promise<readonly string[]> => { reads += 1; return answers.shift()!(); };
    function Probe({ on }: { on: boolean }) {
      useSignedInUsage([], read, false, () => { turnedOn += 1; }, on);
      return null;
    }
    await page.render(createElement(Probe, { on: enabled }));
    probe = (on: boolean) => page.render(createElement(Probe, { on }));
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
    await page.render(null);
    await runTimers();
    expect([reads, turnedOn]).toEqual([1, 0]);
  });

  it("after the guide closes, an answer still on its way changes nothing", async () => {
    const late = Promise.withResolvers<readonly string[]>();
    await mount([() => late.promise]);
    await page.render(null);
    await act(async () => { late.resolve(["claude", "codex"]); await late.promise; });
    expect(turnedOn).toBe(0);
  });
});
