import { afterEach, beforeEach, describe, expect, it, jest, spyOn } from "bun:test";
import { act, createElement } from "react";
import { openPage, type Page } from "./page.fixture.ts";
import type { SlashCommand } from "../../shared/protocol.ts";
import { invalidatePaneCommands } from "./paneCommandCache.ts";
import { usePaneCommands } from "./usePaneCommands.ts";

const config: SlashCommand = { name: "config", description: "Open config", source: "builtin", visibility: "terminal" };

describe("usePaneCommands after a failed read", () => {
  let page: Page;
  let down = false;
  let refused = false;
  let held: ((rows: SlashCommand[]) => void)[] | null = null;
  let stalled = false;
  let seen: readonly SlashCommand[] = [];
  let fetchSpy: ReturnType<typeof spyOn<typeof globalThis, "fetch">>;
  function Probe({ pane }: { pane: string }) { seen = usePaneCommands(pane, "claude"); return null; }
  const settle = async (done: () => boolean) => { for (let turn = 0; turn < 50 && !done(); turn++) await act(async () => { await Promise.resolve(); }); };

  beforeEach(() => {
    page = openPage();
    jest.useFakeTimers();
    down = false; refused = false; stalled = false; seen = []; held = null;
    fetchSpy = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async () => {
      if (down) throw new TypeError("network down");
      if (stalled) return new Promise<Response>(() => undefined);
      if (refused) return Response.json({ error: { code: "read_only", message: "this device can only watch" } }, { status: 403 });
      if (held !== null) { const queue = held; return Response.json({ commands: await new Promise<SlashCommand[]>((resolve) => { queue.push(resolve); }) }); }
      return Response.json({ commands: [config] });
    }, { preconnect: globalThis.fetch.preconnect }));
  });
  afterEach(async () => {
    jest.useRealTimers();
    await page.close();
    fetchSpy.mockRestore();
  });

  it("asks again instead of keeping an empty list for good", async () => {
    down = true;
    await page.render(createElement(Probe, { pane: "w-retry:p1" }));
    await settle(() => fetchSpy.mock.calls.length >= 1);
    expect(seen).toEqual([]);
    down = false;
    await act(async () => { jest.advanceTimersByTime(2_000); });
    await settle(() => seen.length > 0);
    expect(seen.map((command) => command.name)).toEqual(["config"]);
  });

  it("asks again after a read that never answers, instead of joining it for good (#2593)", async () => {
    stalled = true;
    await page.render(createElement(Probe, { pane: "w-stall:p1" }));
    await settle(() => fetchSpy.mock.calls.length >= 1);
    stalled = false;
    // the read's deadline (past the server's own 45 s) fails the quiet read, then the first retry asks again
    await act(async () => { jest.advanceTimersByTime(60_000); });
    await settle(() => false);
    await act(async () => { jest.advanceTimersByTime(2_000); });
    await settle(() => seen.length > 0);
    expect(seen.map((command) => command.name)).toEqual(["config"]);
    expect(fetchSpy.mock.calls.length).toBe(2);
  });

  it("does not ask again when the device may only watch (#2132)", async () => {
    refused = true;
    await page.render(createElement(Probe, { pane: "w-refused:p1" }));
    await settle(() => fetchSpy.mock.calls.length >= 1);
    await settle(() => false);
    await act(async () => { jest.advanceTimersByTime(60_000); });
    await settle(() => false);
    expect(fetchSpy.mock.calls.length).toBe(1);
    expect(seen).toEqual([]);
  });

  it("lets a retry join the refresh read already on its way, and keeps that read's list", async () => {
    const newList: SlashCommand[] = [{ ...config, name: "new-list" }];
    down = true;
    await page.render(createElement(Probe, { pane: "w-retry:p3" }));
    await settle(() => fetchSpy.mock.calls.length >= 1);
    down = false; held = [];
    const answers = held;
    await act(async () => { invalidatePaneCommands("w-retry:p3", "local"); });
    await settle(() => answers.length >= 1);
    await act(async () => { jest.advanceTimersByTime(2_000); });
    await settle(() => false);
    expect(answers).toHaveLength(1);
    answers[0]!(newList);
    await settle(() => seen[0]?.name === "new-list");
    held = null;
    await page.render(null);
    const calls = fetchSpy.mock.calls.length;
    await page.render(createElement(Probe, { pane: "w-retry:p3" }));
    await settle(() => seen.length > 0);
    expect(seen.map((command) => command.name)).toEqual(["new-list"]);
    expect(fetchSpy.mock.calls.length).toBe(calls);
  });

  it("draws the list another hook read on its first render, before its own read answers", async () => {
    await page.render([createElement(Probe, { key: "first", pane: "w-first:p1" })]);
    await settle(() => seen.length > 0);
    const firsts: string[][] = [];
    function Later() { const rows = usePaneCommands("w-first:p1", "claude"); if (firsts.length === 0) firsts.push(rows.map((command) => command.name)); return null; }
    await page.render([createElement(Probe, { key: "first", pane: "w-first:p1" }), createElement(Later, { key: "later" })]);
    expect(firsts).toEqual([["config"]]);
    await page.render([createElement(Probe, { key: "first", pane: "w-first:p1" })]);
  });

  it("keeps the list it had while a fresh read fails", async () => {
    await page.render(createElement(Probe, { pane: "w-retry:p2" }));
    await settle(() => seen.length > 0);
    expect(seen.map((command) => command.name)).toEqual(["config"]);
    down = true;
    const calls = fetchSpy.mock.calls.length;
    await act(async () => { invalidatePaneCommands("w-retry:p2", "local"); });
    await settle(() => fetchSpy.mock.calls.length > calls);
    await settle(() => false);
    expect(seen.map((command) => command.name)).toEqual(["config"]);
    const failed = fetchSpy.mock.calls.length;
    await act(async () => { jest.advanceTimersByTime(2_000); });
    await settle(() => fetchSpy.mock.calls.length > failed);
    expect(fetchSpy.mock.calls.length).toBeGreaterThan(failed);
  });
});
