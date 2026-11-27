import { afterEach, beforeEach, describe, expect, it, jest } from "bun:test";
import { act, createElement } from "react";
import { openPage, type Page } from "./page.fixture.ts";
import { RECONNECT_GRACE_MS, useReconnectGrace } from "./reconnectGrace.ts";

interface Facts { connected: boolean; connectedBefore: boolean; urgent: boolean; lostAt?: number | null }

let shown: boolean[] = [];
let page: Page;

function Probe(facts: Facts) {
  shown.push(useReconnectGrace(facts.connected, facts.connectedBefore, facts.urgent, facts.lostAt ?? null));
  return null;
}

async function render(facts: Facts): Promise<boolean> {
  await page.render(createElement(Probe, facts));
  return shown.at(-1)!;
}

async function wait(ms: number): Promise<void> {
  await act(async () => { jest.advanceTimersByTime(ms); });
}

const live: Facts = { connected: true, connectedBefore: true, urgent: false };
const dropped: Facts = { ...live, connected: false };

beforeEach(() => {
  page = openPage();
  jest.useFakeTimers();
  shown = [];
});

afterEach(async () => {
  jest.useRealTimers();
  await page.close();
});

describe("useReconnectGrace", () => {
  it("says nothing of a drop the connection comes back from within the grace", async () => {
    expect(await render(live)).toBe(true);
    expect(await render(dropped)).toBe(true);
    await wait(RECONNECT_GRACE_MS - 1);
    expect(shown.at(-1)).toBe(true);
    expect(await render(live)).toBe(true);
    expect(shown).not.toContain(false);
  });

  it("says the connection is lost once the grace runs out", async () => {
    await render(live);
    await render(dropped);
    await wait(RECONNECT_GRACE_MS);
    expect(shown.at(-1)).toBe(false);
    expect(await render(live)).toBe(true);
  });

  it("says it at once when input waits for the connection", async () => {
    await render(live);
    expect(await render(dropped)).toBe(true);
    expect(await render({ ...dropped, urgent: true })).toBe(false);
  });

  it("gives each drop a grace of its own", async () => {
    await render(live);
    await render(dropped);
    await wait(RECONNECT_GRACE_MS);
    await render(live);
    expect(await render(dropped)).toBe(true);
    await wait(RECONNECT_GRACE_MS);
    expect(shown.at(-1)).toBe(false);
  });

  it("gives a drop the socket reports anew a grace of its own, even before a connected render came between", async () => {
    await render(live);
    await render({ ...dropped, lostAt: Date.now() });
    await wait(RECONNECT_GRACE_MS);
    expect(shown.at(-1)).toBe(false);
    expect(await render({ ...dropped, lostAt: Date.now() })).toBe(true);
    await wait(RECONNECT_GRACE_MS);
    expect(shown.at(-1)).toBe(false);
  });

  it("counts from when the socket lost the connection: a terminal mounted during a longer drop says it at once", async () => {
    expect(await render({ ...dropped, lostAt: Date.now() - RECONNECT_GRACE_MS - 1 })).toBe(false);
    expect(shown).not.toContain(true);
  });

  it("gives a terminal mounted during a drop only what is left of its grace", async () => {
    expect(await render({ ...dropped, lostAt: Date.now() - RECONNECT_GRACE_MS + 1000 })).toBe(true);
    await wait(1000);
    expect(shown.at(-1)).toBe(false);
  });

  it("leaves a first connection as it was: not connected yet is said at once", async () => {
    expect(await render({ connected: false, connectedBefore: false, urgent: false })).toBe(false);
  });
});
