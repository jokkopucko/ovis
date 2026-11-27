import { describe, expect, test } from "bun:test";
import { countBucket, emptyUsage, sameUsage, TELEMETRY_COUNT_MAX, TELEMETRY_COUNTERS, TELEMETRY_HARNESSES, telemetryAgentVersion, telemetryCountsChange } from "./telemetry.ts";

describe("agent versions and answers", () => {
  test("an agent's version is sent as major.minor only", () => {
    expect(["2.1.330", "0.171.0", "2.10", "02.01.3-beta", "1.4.2026", "v2.1", "2", "", null].map(telemetryAgentVersion))
      .toEqual(["2.1", "0.171", "2.10", "2.1", "1.4", null, null, null, null]);
  });

  test("usage without agents and answers is the same as usage with none", () => {
    const { agents: _agents, answers: _answers, ...older } = emptyUsage();
    expect(sameUsage(older, emptyUsage())).toBe(true);
    expect(sameUsage(emptyUsage(), { ...emptyUsage(), answers: { terminal: 1 } })).toBe(false);
    expect(sameUsage({ ...emptyUsage(), agents: { claude: { ovis: 1, other: 0, versions: [] } } }, { ...emptyUsage(), agents: { claude: { ovis: 0, other: 1, versions: [] } } })).toBe(false);
  });
});

describe("button counts", () => {
  test("a day's count leaves the PC as its range: 1-2, 3-9, 10-29, 30 or more, and none for 0", () => {
    expect([0, 1, 2, 3, 9, 10, 29, 30, TELEMETRY_COUNT_MAX, -1, Number.NaN].map(countBucket)).toEqual([0, 1, 1, 2, 2, 3, 3, 4, 4, 0, 0]);
  });

  test("the names are sorted, unique, and each harness has a switch to each lens", () => {
    expect([...TELEMETRY_COUNTERS]).toEqual([...new Set(TELEMETRY_COUNTERS)].sort());
    for (const harness of TELEMETRY_HARNESSES) {
      expect(TELEMETRY_COUNTERS).toContain(`view_chat_${harness}`);
      expect(TELEMETRY_COUNTERS).toContain(`view_terminal_${harness}`);
    }
    // no name says more than a word list can: no free text ever becomes a name
    for (const name of TELEMETRY_COUNTERS) expect(name).toMatch(/^[a-z_]+$/);
  });

  test("a browser's change keeps known names and shown controls, sorted, and drops a newer page's", () => {
    expect(telemetryCountsChange({ width: "narrow", add: { chat_send: 2, composer_rewind: 1 }, shown: ["view_switch_header", "composer", "future_panel", "composer"] }))
      .toEqual({ width: "narrow", add: { chat_send: 2 }, shown: ["composer", "view_switch_header"] });
    expect(telemetryCountsChange({ width: "wide", add: {}, shown: [] })).toEqual({ width: "wide", add: {}, shown: [] });
  });

  test("a change with a count that is not a whole count in range is refused whole, known name or not", () => {
    for (const add of [{ chat_send: 0 }, { chat_send: 1.5 }, { chat_send: TELEMETRY_COUNT_MAX + 1 }, { chat_send: "3" }, { composer_rewind: -1 }, { composer_rewind: "fix the bug" }]) {
      expect(telemetryCountsChange({ width: "wide", add, shown: [] })).toBeNull();
    }
    for (const bad of [
      { width: "tablet", add: {}, shown: [] },
      { width: "wide", add: [], shown: [] },
      { width: "wide", add: {}, shown: "composer" },
      { width: "wide", add: {}, shown: [1] },
      { width: "wide", add: {}, shown: [], pane: "w1:p1" },
      { width: "wide", add: {} },
      null,
    ]) expect(telemetryCountsChange(bad)).toBeNull();
  });

  test("a change may name its counting generation, a whole number, and nothing else new", () => {
    expect(telemetryCountsChange({ width: "wide", add: { chat_send: 1 }, shown: [], generation: 4 })?.generation).toBe(4);
    for (const generation of [-1, 1.5, "4", null]) expect(telemetryCountsChange({ width: "wide", add: {}, shown: [], generation })).toBeNull();
    expect(telemetryCountsChange({ width: "wide", add: {}, shown: [], tab: 2 })).toBeNull();
  });
});
