import { describe, expect, it } from "bun:test";

import { HERMES_CTRL_C_WINDOW_MS, grokCancellable, hermesCtrlCTooSoon, hermesInterruptible, stopKey } from "./hermesStop.ts";

const CLASSIC_BUSY = [
  "n who controlled it, who could afford it, how it was prepared, and what people believed it could do.",
  " ☤ gpt-6-luna │ 0/272K │ [░░░░░░░░░░] 0% │ 3m │ ⏱ 8s                                     ─ Write a very long, detail...",
  "────────────────────────────────────────────────────────────────────────",
  "☤ ❯ msg=interrupt · /queue · /bg · /steer · Ctrl+C cancel",
  "────────────────────────────────────────────────────────────────────────",
];
const CLASSIC_IDLE = [
  "⚡ Interrupted during API call.",
  " ☤ gpt-6-luna │ 0/272K │ [░░░░░░░░░░] 0% │ 3m │ ⏲ 27s │ ✓ 0s                                           ─ History of tea",
  "────────────────────────────────────────────────────────────────────────",
  "❯ What changed in this repo recently?",
  "────────────────────────────────────────────────────────────────────────",
];
const TUI_BUSY = [
  " ❯ Write a very long essay (4000 words) about the history of coffee. No tools.                                     ┃",
  "    Coffee is at once a plant, a drink, a commodity, a ritual, and an idea.                                         ┃",
  " ─ ( ͡° ͜ʖ ͡°) brainstorming… · 3s │ gpt 6 luna │ 15s │ voice off │ 1 session                ─  Write essay on coffee history",
  " ❯ Ctrl+C to interrupt…",
];
const TUI_IDLE = [
  "    [interrupted]                                                                                                   ┃",
  " ─ ready │ gpt 6 luna │ 17s │ ✓ 1s │ voice off │ 1 session                                    ─  Write essay on coffee history",
  " ❯",
];

describe("hermesInterruptible", () => {
  it("reads a running turn from the input row of the classic CLI and the TUI", () => {
    expect(hermesInterruptible(CLASSIC_BUSY)).toBe(true);
    expect(hermesInterruptible(TUI_BUSY)).toBe(true);
  });

  it("says no for an idle Hermes, where Ctrl+C would exit it", () => {
    expect(hermesInterruptible(CLASSIC_IDLE)).toBe(false);
    expect(hermesInterruptible(TUI_IDLE)).toBe(false);
    expect(hermesInterruptible([])).toBe(false);
  });

  it("never counts the hint quoted in the transcript above an idle input row", () => {
    expect(hermesInterruptible(["❯ Ctrl+C to interrupt…", "assistant: done", "❯ Try \"fix the lint errors\""])).toBe(false);
    expect(hermesInterruptible(["☤ ❯ msg=interrupt · /queue · Ctrl+C cancel", "────", "❯ "])).toBe(false);
  });

  it("reads the row's first `❯` as the prompt: a draft that quotes the hint is still a draft", () => {
    expect(hermesInterruptible(["☤ ❯ note ❯ Ctrl+C to interrupt…"])).toBe(false);
    expect(hermesInterruptible([" ❯ see ☤ ❯ msg=interrupt · /queue · Ctrl+C cancel"])).toBe(false);
  });

  it("says no when a draft typed into a busy Hermes hides its hint", () => {
    expect(hermesInterruptible([...CLASSIC_BUSY.slice(0, 3), "☤ ❯ half a thought", CLASSIC_BUSY[4]!])).toBe(false);
  });
});

describe("stopKey", () => {
  const rows = () => CLASSIC_BUSY;

  const T = 1_000_000;

  it("keeps Escape for every other agent, without reading the screen", () => {
    expect(stopKey("claude", () => { throw new Error("read"); }, false, null, T)).toBe("\u001b");
    expect(stopKey(null, () => [], true, T, T + 1)).toBe("\u001b");
    expect(stopKey("codex", () => [], false, T, T + 10)).toBe("\u001b");
  });

  it("sends Hermes one Ctrl+C per turn, and only while the turn shows", () => {
    expect(stopKey("hermes", rows, false, null, T)).toBe("\u0003");
    expect(stopKey("hermes", rows, true, null, T)).toBeNull();
    expect(stopKey("hermes", () => CLASSIC_IDLE, false, null, T)).toBeNull();
  });

  it("keeps the per-turn guard of a blocked turn past the 2 s window", () => {
    expect(stopKey("hermes", rows, true, T, T + 60_000)).toBeNull();
  });

  it("refuses a second Ctrl+C within 2 s even after the status flickered and reset the guard", () => {
    expect(stopKey("hermes", rows, false, T, T + 500)).toBeNull();
    expect(stopKey("hermes", () => TUI_BUSY, false, T, T + HERMES_CTRL_C_WINDOW_MS - 1)).toBeNull();
    expect(hermesCtrlCTooSoon(T, T + HERMES_CTRL_C_WINDOW_MS - 1)).toBe(true);
  });

  it("allows Ctrl+C again on a new working turn once 2 s have passed", () => {
    expect(stopKey("hermes", rows, false, T, T + HERMES_CTRL_C_WINDOW_MS)).toBe("\u0003");
    expect(stopKey("hermes", () => TUI_BUSY, false, T, T + 5000)).toBe("\u0003");
    expect(hermesCtrlCTooSoon(null, T)).toBe(false);
  });
});

const GROK_BUSY = ["  \u2502 \u276f                                    \u2502", "  Shift+Tab:mode  \u2502  Ctrl+c:cancel  \u2502  Ctrl+b:send to bg  \u2502  Ctrl+.:shortcuts", ""];
const GROK_IDLE = ["  \u2502 \u276f                                    \u2502", "  Shift+Tab:mode  \u2502  Ctrl+.:shortcuts", ""];

describe("stop keys of other agents", () => {
  const T = 1_000_000;

  it("sends Grok one Ctrl+C while its key row offers cancel, and nothing at rest", () => {
    expect(grokCancellable(GROK_BUSY)).toBe(true);
    expect(grokCancellable(GROK_IDLE)).toBe(false);
    expect(stopKey("grok", () => GROK_BUSY, false, null, T)).toBe("\u0003");
    expect(stopKey("grok", () => GROK_IDLE, false, null, T)).toBeNull();
    expect(stopKey("grok", () => GROK_BUSY, true, null, T)).toBeNull();
    expect(stopKey("grok", () => GROK_BUSY, false, T, T + 500)).toBeNull();
  });

  it("reads only Grok's last row: the hint quoted above it is no cancel", () => {
    expect(grokCancellable([...GROK_BUSY.slice(1, 2), ...GROK_IDLE])).toBe(false);
  });

  it("sends Escape twice to the agents whose single Escape does not stop them", () => {
    for (const agent of ["devin", "kilo", "maki"]) expect(stopKey(agent, () => { throw new Error("read"); }, false, null, T)).toBe("\u001b\u001b");
  });
});
