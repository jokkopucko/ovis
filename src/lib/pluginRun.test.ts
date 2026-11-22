import { describe, expect, it } from "bun:test";

import type { PluginActionResult } from "../../shared/protocol.ts";
import { Ownership, PLUGIN_POLL_MS, runPluginActionToEnd, type PluginRunApi } from "./pluginRun.ts";

const answer = (fields: Partial<PluginActionResult>): PluginActionResult => ({ log_id: "plugin-log-1", status: "succeeded", exit_code: 0, output: null, opened_pane_id: null, ...fields });
const request = { plugin_id: "example.layout", action_id: "apply", pane_id: "w1:p1" };
const instant = (waits: number[]) => async (ms: number) => { waits.push(ms); };

function api(first: PluginActionResult, later: PluginActionResult[] = []): PluginRunApi & { asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    runPluginAction: async () => first,
    fetchPluginActionStatus: async (pluginId, logId) => {
      asked.push(`${pluginId} ${logId}`);
      const next = later.shift();
      if (!next) throw new Error("asked more often than the run had answers");
      return next;
    },
  };
}

describe("runPluginActionToEnd", () => {
  it("answers at once for a command that ended within the server's wait", async () => {
    const calls = api(answer({ opened_pane_id: "w1:p4" }));
    const waits: number[] = [];
    expect(await runPluginActionToEnd(calls, request, () => true, instant(waits))).toEqual(answer({ opened_pane_id: "w1:p4" }));
    expect(calls.asked).toEqual([]);
    expect(waits).toEqual([]);
  });

  it("reports a command that failed after the server stopped waiting, instead of taking `running` for success", async () => {
    const running = answer({ log_id: "plugin-log-9", status: "running", exit_code: null });
    const failed = answer({ log_id: "plugin-log-9", status: "failed", exit_code: 3, output: "boom" });
    const calls = api(running, [running, failed]);
    const waits: number[] = [];
    expect(await runPluginActionToEnd(calls, request, () => true, instant(waits))).toEqual(failed);
    expect(calls.asked).toEqual(["example.layout plugin-log-9", "example.layout plugin-log-9"]);
    expect(waits).toEqual([PLUGIN_POLL_MS, PLUGIN_POLL_MS]);
  });

  it("hands on the failure of asking, so a run herdr's log no longer holds does not read as done", async () => {
    const calls = api(answer({ status: "running", exit_code: null }));
    await expect(runPluginActionToEnd(calls, request, () => true, instant([]))).rejects.toThrow("asked more often");
  });
});

describe("Ownership", () => {
  it("holds a claim until it is ended, and gives a claim made afterwards a life of its own", () => {
    const owner = new Ownership();
    const first = owner.claim();
    expect(first()).toBe(true);
    owner.end();
    expect(first()).toBe(false);
    const second = owner.claim();
    expect(second()).toBe(true);
    expect(first()).toBe(false);
  });

  it("gives another PC's answer to no one: the palette that asked was unmounted before it arrived", async () => {
    const owner = new Ownership();
    const alive = owner.claim();
    let answerFromA: (result: PluginActionResult) => void = () => undefined;
    const pcA: PluginRunApi = {
      runPluginAction: () => new Promise((resolve) => { answerFromA = resolve; }),
      fetchPluginActionStatus: async () => { throw new Error("a run with no owner is not asked about"); },
    };
    const run = runPluginActionToEnd(pcA, request, alive, instant([]));
    owner.end();
    answerFromA(answer({ opened_pane_id: "w1:p4" }));
    expect(await run).toBeNull();
  });

  it("stops asking about a run whose owner left while it was still running", async () => {
    const owner = new Ownership();
    const calls = api(answer({ status: "running", exit_code: null }));
    const run = runPluginActionToEnd(calls, request, owner.claim(), async () => { owner.end(); });
    expect(await run).toBeNull();
    expect(calls.asked).toEqual([]);
  });
});
