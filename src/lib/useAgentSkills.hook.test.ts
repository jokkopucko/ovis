import { afterEach, beforeAll, beforeEach, describe, expect, it, jest, spyOn } from "bun:test";
import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import type { SlashCommand } from "../../shared/protocol.ts";
import { fetchAgentCommands } from "./api.ts";
import { type AgentSkills, SKILLS_MS, useAgentSkills } from "./useAgentSkills.ts";

const skill: SlashCommand = { name: "deploy", description: "Ship it", source: "skill" };

describe("useAgentSkills while the PC is busy scanning", () => {
  let renderer: ReactTestRenderer | null = null;
  let busy: { left: number; retryAfter: string | null } = { left: 0, retryAfter: null };
  let seen: AgentSkills = null;
  let fetchSpy: ReturnType<typeof spyOn<typeof globalThis, "fetch">>;
  function Probe({ open, folder }: { open: boolean; folder: string }) {
    [seen] = useAgentSkills(open, "claude", folder, (agent, cwd) => fetchAgentCommands(agent, cwd), (text) => text);
    return null;
  }
  const settle = async (done: () => boolean) => { for (let turn = 0; turn < 50 && !done(); turn++) await act(async () => { await Promise.resolve(); }); };
  const calls = () => fetchSpy.mock.calls.length;
  const advance = async (ms: number) => { await act(async () => { jest.advanceTimersByTime(ms); }); };

  beforeAll(() => { Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true }); });
  beforeEach(() => {
    jest.useFakeTimers();
    busy = { left: 0, retryAfter: null };
    seen = null;
    fetchSpy = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async () => {
      if (busy.left > 0) {
        busy.left -= 1;
        return Response.json({ error: { code: "file_busy", message: "the skill folders did not answer in time" } }, { status: 503, headers: busy.retryAfter === null ? {} : { "retry-after": busy.retryAfter } });
      }
      return Response.json({ commands: [skill] });
    }, { preconnect: globalThis.fetch.preconnect }));
  });
  afterEach(async () => {
    await act(async () => { renderer?.unmount(); });
    renderer = null;
    fetchSpy.mockRestore();
    jest.useRealTimers();
  });

  const open = async (folder = "/work") => {
    await act(async () => { renderer = create(createElement(Probe, { open: true, folder })); });
    await advance(SKILLS_MS);
    await settle(() => calls() >= 1);
  };

  it("asks again after a busy answer instead of showing an error, and lists the skills once the PC answers", async () => {
    busy = { left: 1, retryAfter: "1" };
    await open();
    await settle(() => false);
    expect(calls()).toBe(1);
    expect(seen).toBeNull();
    await advance(1_000);
    await settle(() => seen !== null);
    expect(calls()).toBe(2);
    expect(seen).toEqual({ rows: [skill], note: null });
  });

  it("waits as long as the PC's Retry-After says when that is longer than its own pause", async () => {
    busy = { left: 1, retryAfter: "4" };
    await open();
    await settle(() => false);
    await advance(3_999);
    await settle(() => false);
    expect(calls()).toBe(1);
    await advance(1);
    await settle(() => seen !== null);
    expect(calls()).toBe(2);
    expect(seen?.rows).toEqual([skill]);
  });

  it("gives up after a bounded number of tries and says why", async () => {
    busy = { left: 100, retryAfter: "1" };
    await open();
    for (let step = 0; step < 20; step++) {
      await settle(() => false);
      await advance(30_000);
    }
    await settle(() => seen !== null);
    const tries = calls();
    expect(tries).toBeGreaterThan(1);
    expect(tries).toBeLessThanOrEqual(6);
    expect(seen?.rows).toEqual([]);
    expect(seen?.note).toBeTruthy();
    await advance(120_000);
    await settle(() => false);
    expect(calls()).toBe(tries);
  });

  it("stops asking once the dialog closes", async () => {
    busy = { left: 100, retryAfter: "1" };
    await open();
    await settle(() => false);
    await act(async () => { renderer?.update(createElement(Probe, { open: false, folder: "/work" })); });
    await advance(60_000);
    await settle(() => false);
    expect(calls()).toBe(1);
  });
});
