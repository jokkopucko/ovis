import { describe, expect, test, spyOn } from "bun:test";
import type { TelemetryCountsChange, TelemetryStatus } from "../../shared/telemetry.ts";
import { NOTICE_VERSION } from "../../shared/telemetry-notice.ts";
import { actionsCan, actionUse, createUsageCounters, usageCounters } from "./usageCounters.ts";

const status = (overrides: Partial<TelemetryStatus> = {}) => ({ enabled: true, blocked_by_env: false, notice_seen: true, counts_generation: 0, ...overrides }) as TelemetryStatus;

function setup(answer: TelemetryStatus | null = status(), on = true) {
  const sent: { counts: TelemetryCountsChange; keepalive: boolean }[] = [];
  const days: (string | undefined)[] = [];
  const timers: { fn: () => void; ms: number; cleared: boolean }[] = [];
  const clock = { now: Date.parse("2026-11-15T10:00:00Z"), narrow: false };
  let asked = 0;
  let reply: TelemetryStatus | null = answer;
  const counters = createUsageCounters({
    on,
    send: async ({ day, ...counts }, keepalive) => { days.push(day); sent.push({ counts, keepalive }); return reply; },
    status: async () => { asked += 1; return reply; },
    narrow: () => clock.narrow,
    now: () => clock.now,
    setTimer: (fn, ms) => { const timer = { fn, ms, cleared: false }; timers.push(timer); return () => { timer.cleared = true; }; },
  });
  const fire = () => {
    const timer = timers.filter((candidate) => !candidate.cleared).at(-1);
    if (!timer) throw new Error("no flush was armed");
    timer.cleared = true;
    timer.fn();
  };
  const armed = () => timers.filter((timer) => !timer.cleared).length;
  return { counters, sent, days, clock, fire, armed, asked: () => asked, answer: (next: TelemetryStatus | null) => { reply = next; } };
}

const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

describe("usage counters", () => {
  test("a build whose notice does not say so counts nothing and asks nothing", async () => {
    const { counters, sent, armed, asked } = setup(status(), false);
    counters.heard(status());
    counters.count("chat_send");
    counters.shown("composer");
    counters.viewSwitch("terminal", "claude", "header", "local");
    counters.flush(true);
    await settle();
    expect([sent, armed(), asked()]).toEqual([[], 0, 0]);
  });

  test("nothing is kept before the server's word is heard, and the first use asks for it once", async () => {
    const { counters, sent, armed, asked } = setup();
    counters.count("chat_send");
    counters.count("chat_send");
    expect(asked()).toBe(1);
    expect(armed()).toBe(0);
    await settle();
    counters.flush(false);
    await settle();
    expect(sent).toEqual([]);
  });

  test("a heard yes counts per width, and one batch per width goes after FLUSH_MS", async () => {
    const { counters, sent, clock, fire } = setup();
    counters.heard(status());
    counters.count("chat_send");
    counters.count("chat_send");
    clock.narrow = true;
    counters.count("composer_voice");
    fire();
    await settle();
    expect(sent).toEqual([
      { counts: { width: "narrow", add: { composer_voice: 1 }, shown: [], generation: 0 }, keepalive: false },
      { counts: { width: "wide", add: { chat_send: 2 }, shown: [], generation: 0 }, keepalive: false },
    ]);
    counters.flush(true);
    await settle();
    expect(sent).toHaveLength(2);
  });

  test("a page going away tells what it has with keepalive", async () => {
    const { counters, sent } = setup();
    counters.heard(status());
    counters.count("composer_attach");
    counters.flush(true);
    await settle();
    expect(sent).toEqual([{ counts: { width: "wide", add: { composer_attach: 1 }, shown: [], generation: 0 }, keepalive: true }]);
  });

  test("no counting while the server is off, blocked or its notice is unseen, and a no in an answer drops the batch", async () => {
    // an older PC says nothing of a counting generation: its notice_seen is for a notice that said nothing of counts
    // (the hosted app reaching it), so nothing is counted there and nothing is posted to it
    for (const no of [status({ enabled: false }), status({ blocked_by_env: true }), status({ notice_seen: false }), status({ counts_generation: undefined }), null]) {
      const { counters, sent, fire, armed } = setup(no);
      counters.heard(no);
      counters.count("chat_send");
      counters.shown("composer");
      counters.flush(false);
      await settle();
      expect(sent).toEqual([]);
      expect(armed()).toBe(0);
      expect(fire).toThrow();
    }
    const { counters, sent, answer } = setup();
    counters.heard(status());
    counters.count("chat_send");
    answer(status({ enabled: false }));
    counters.flush(false);
    await settle();
    counters.count("chat_send");
    counters.flush(false);
    await settle();
    expect(sent).toHaveLength(1);
  });

  test("a batch waiting when the counts are turned off is dropped, even if they are turned on again before it goes", async () => {
    const { counters, sent } = setup();
    counters.heard(status());
    counters.count("chat_send");
    counters.shown("composer");
    counters.heard(status({ enabled: false }));
    counters.heard(status());
    counters.flush(false);
    await settle();
    expect(sent).toEqual([]);
  });

  test("a control still drawn is told as shown again after an off and on: the off cleared the PC's day", async () => {
    const { counters, sent } = setup();
    counters.heard(status());
    counters.draw("composer");
    counters.flush(false);
    await settle();
    counters.heard(status({ counts_generation: 1 }));
    counters.flush(false);
    await settle();
    expect(sent.map((batch) => [batch.counts.generation, batch.counts.shown])).toEqual([[0, ["composer"]], [1, ["composer"]]]);
  });

  test("a control is told as shown once a day per width", async () => {
    const { counters, sent, clock } = setup();
    counters.heard(status());
    counters.shown("composer");
    counters.shown("composer");
    clock.narrow = true;
    counters.shown("composer");
    counters.flush(false);
    await settle();
    counters.shown("composer");
    clock.narrow = false;
    clock.now += 86_400_000;
    counters.shown("composer");
    counters.flush(false);
    await settle();
    expect(sent.map(({ counts }) => [counts.width, counts.shown])).toEqual([
      ["narrow", ["composer"]], ["wide", ["composer"]], ["wide", ["composer"]],
    ]);
  });

  test("a switch is counted under the pane's kind and where it was asked, never for another PC or by the app itself", async () => {
    const { counters, sent } = setup();
    counters.heard(status());
    counters.viewSwitch("terminal", "claude", "header", "local");
    counters.viewSwitch("chat", undefined, "shortcut", "local");
    counters.viewSwitch("terminal", "cursor", "palette", "local");
    counters.viewSwitch("terminal", "claude", null, "local");
    counters.viewSwitch("terminal", "claude", "header", "studio-mac");
    counters.paneUse("chat_send", "studio-mac");
    counters.paneUse("chat_send", "local");
    counters.flush(false);
    await settle();
    expect(sent).toEqual([{ counts: { width: "wide", shown: [], generation: 0, add: {
      view_terminal_claude: 1, view_terminal_by_header: 1,
      view_chat_shell: 1, view_chat_by_shortcut: 1,
      view_terminal_other: 1, view_terminal_by_palette: 1,
      chat_send: 1,
    } }, keepalive: false }]);
  });

  test("a control still drawn is told again for a new day and a new width, at the next use or return", async () => {
    const { counters, sent, clock } = setup();
    counters.heard(status());
    const undo = counters.draw("composer");
    counters.flush(false);
    await settle();
    clock.now += 86_400_000;
    counters.count("chat_send");
    counters.flush(false);
    await settle();
    clock.narrow = true;
    counters.reshow();
    counters.flush(false);
    await settle();
    undo();
    clock.now += 86_400_000;
    counters.count("chat_send");
    counters.flush(false);
    await settle();
    expect(sent.map(({ counts }) => [counts.width, counts.shown, Object.keys(counts.add)])).toEqual([
      ["wide", ["composer"], []],
      ["wide", ["composer"], ["chat_send"]],
      ["narrow", ["composer"], []],
      ["narrow", [], ["chat_send"]],
    ]);
  });

  test("a batch that is not taken gives its shown controls back, to be told again", async () => {
    const sent: TelemetryCountsChange[] = [];
    let fail = true;
    const counters = createUsageCounters({
      on: true, narrow: () => false, now: () => Date.parse("2026-11-15T10:00:00Z"), setTimer: () => () => {},
      status: async () => status(),
      send: async (counts) => { sent.push(counts); if (fail) throw new Error("offline"); return status(); },
    });
    counters.heard(status());
    counters.shown("composer");
    counters.flush(false);
    await settle();
    fail = false;
    counters.heard(status());
    counters.shown("composer");
    counters.flush(false);
    await settle();
    expect(sent.map((counts) => counts.shown)).toEqual([["composer"], ["composer"]]);
  });

  test("a refusal (a device that can only watch) stops the page counting, without asking again", async () => {
    let asked = 0;
    const sent: TelemetryCountsChange[] = [];
    const counters = createUsageCounters({
      on: true, narrow: () => false, now: () => Date.parse("2026-11-15T10:00:00Z"), setTimer: () => () => {},
      status: async () => { asked += 1; return status(); },
      send: async (counts) => { sent.push(counts); throw Object.assign(new Error("read_only"), { status: 403 }); },
    });
    counters.heard(status());
    counters.count("chat_send");
    counters.flush(false);
    await settle();
    counters.count("chat_send");
    counters.flush(false);
    await settle();
    expect([sent.length, asked]).toEqual([1, 0]);
    counters.heard(status());
    counters.count("chat_send");
    counters.flush(false);
    await settle();
    expect(sent.length).toBe(1);
  });

  test("a control drawn before the server's word is told once the word is yes, with nothing else to send", async () => {
    const { counters, sent, fire, armed } = setup();
    counters.draw("composer");
    expect(armed()).toBe(0);
    counters.heard(status());
    fire();
    await settle();
    expect(sent.map(({ counts }) => counts.shown)).toEqual([["composer"]]);
  });

  test("the shipped build counts and tells nothing before the notice that says so (version 6)", async () => {
    const calls: string[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request) => { calls.push(String(input)); return Response.json(status()); }) as typeof fetch;
    try {
      usageCounters.heard(status());
      usageCounters.draw("composer")();
      usageCounters.count("chat_send");
      usageCounters.viewSwitch("terminal", "claude", "header", "local");
      usageCounters.flush(true);
      await settle();
    } finally { globalThis.fetch = original; }
    // 6 is the notice whose wording says buttons are counted: below it, not one request
    expect(calls.length > 0).toBe(NOTICE_VERSION >= 6);
  });

  test("an action counts under its source, never when it would do nothing here, never on another PC's pane", () => {
    const here = (can = {}, machineId = "local") => ({ machineId, can });
    expect(actionUse("split", "shortcut", here())).toBe("split_by_shortcut");
    expect(actionUse("settings", "palette", here())).toBe("settings_by_palette");
    expect([actionUse("split", "shortcut", here({ split: false })), actionUse("close_pane", "palette", here({ close_pane: false })), actionUse("new_tab", "shortcut", here({ new_tab: false }))]).toEqual([null, null, null]);
    expect([actionUse("split", "button", here({}, "pc-2")), actionUse("close_pane", "menu", here({}, "pc-2")), actionUse("new_tab", "shortcut", here({}, "pc-2")), actionUse("files", "menu", here({}, "pc-2"))]).toEqual([null, null, null, null]);
    expect(actionUse("sidebar", "shortcut", here({}, "pc-2"))).toBe("sidebar_by_shortcut");
  });

  test("after a refusal nothing kept goes, not even what was counted while the refused batch was on its way", async () => {
    const sent: TelemetryCountsChange[] = [];
    let answer: (() => void) | null = null;
    const counters = createUsageCounters({
      on: true, narrow: () => false, now: () => Date.parse("2026-11-15T10:00:00Z"), setTimer: () => () => {},
      status: async () => status(),
      send: (counts) => { sent.push(counts); return new Promise((_resolve, reject) => { answer = () => reject(Object.assign(new Error("read_only"), { status: 403 })); }); },
    });
    counters.heard(status());
    counters.count("chat_send");
    counters.flush(false);
    counters.count("composer_voice");
    answer!();
    await settle();
    counters.heard(status());
    counters.flush(false);
    await settle();
    expect(sent.map((counts) => Object.keys(counts.add))).toEqual([["chat_send"]]);
  });

  test("what App can do now decides what is counted: no new tab in the inbox or without a workspace, no sidebar in the mode", () => {
    const now = { split: true, closePane: true, files: true, inboxShown: false, inMode: false, tabTarget: true };
    expect(actionsCan(now)).toEqual({ split: true, close_pane: true, files: true, new_tab: true, sidebar: true });
    expect(actionsCan({ ...now, inboxShown: true })).toMatchObject({ new_tab: false, sidebar: true });
    expect(actionsCan({ ...now, inMode: true })).toMatchObject({ new_tab: false, sidebar: false });
    expect(actionsCan({ ...now, tabTarget: false, split: false, closePane: false, files: false })).toEqual({ split: false, close_pane: false, files: false, new_tab: false, sidebar: true });
    expect(actionUse("sidebar", "shortcut", { machineId: "local", can: actionsCan({ ...now, inMode: true }) })).toBeNull();
    expect(actionUse("files", "menu", { machineId: "local", can: actionsCan(now) })).toBe("files_by_menu");
  });

  test("a batch names the counting generation it heard, and a new one (an off in another tab) drops what was kept", async () => {
    const { counters, sent } = setup();
    counters.heard({ ...status(), counts_generation: 2 });
    counters.count("chat_send");
    counters.flush(false);
    await settle();
    counters.count("composer_attach");
    counters.heard({ ...status(), counts_generation: 3 });
    counters.count("composer_voice");
    counters.flush(false);
    await settle();
    expect(sent.map(({ counts }) => [counts.generation, Object.keys(counts.add)])).toEqual([[2, ["chat_send"]], [3, ["composer_voice"]]]);
  });

  test("a batch names the UTC day it was counted on, and a use after midnight sends the day before first", async () => {
    const { counters, sent, days, clock } = setup();
    clock.now = Date.parse("2026-11-15T23:59:30Z");
    counters.heard(status());
    counters.count("chat_send");
    clock.now = Date.parse("2026-11-16T00:00:10Z");
    counters.count("composer_voice");
    counters.flush(false);
    await settle();
    expect(sent.map(({ counts }) => Object.keys(counts.add))).toEqual([["chat_send"], ["composer_voice"]]);
    expect(days).toEqual(["2026-11-15", "2026-11-16"]);
  });

  test("a late answer from before an off neither turns counting on again nor brings back its generation", async () => {
    const { counters, sent } = setup();
    counters.heard({ ...status(), counts_generation: 4 });
    counters.heard({ ...status(), enabled: false, counts_generation: 5 });
    counters.heard({ ...status(), counts_generation: 4 });
    counters.count("chat_send");
    counters.flush(false);
    await settle();
    expect(sent).toEqual([]);
  });

  test("a control whose count fails as it is drawn is still let go of: it is not told as shown once it is gone", async () => {
    const sent: TelemetryCountsChange[] = [];
    let failing = true;
    let now = Date.parse("2026-11-15T10:00:00Z");
    const counters = createUsageCounters({
      on: true, now: () => now, setTimer: () => () => {}, status: async () => status(),
      narrow: () => { if (failing) throw new Error("matchMedia gone"); return false; },
      send: async (counts) => { sent.push(counts); return status(); },
    });
    counters.heard(status());
    const logged = spyOn(console, "error").mockImplementation(() => {});
    let undo: () => void = () => {};
    try { undo = counters.draw("composer"); } finally { logged.mockRestore(); }
    failing = false;
    undo();
    now += 86_400_000;
    counters.count("chat_send");
    counters.flush(false);
    await settle();
    expect(sent.map((counts) => counts.shown)).toEqual([[]]);
  });
});
