import { describe, expect, it } from "bun:test";
import { clearDeadline, earliest, ESC_WAIT_MS, ESC_WAIT_SLOW_MS, NO_DEADLINES, PASTE_LIMIT_BYTES, REPLY_WAIT_MS, SEQUENCE_DROP_MS, setDeadline } from "./deadlines.ts";

describe("the waits and limits of host input", () => {
  it("are 30 ms after a lone ESC (150 ms with mouse or kitty keys), 500 ms to drop a sequence or end the probe, and 1 MiB for a paste", () => {
    expect({ ESC_WAIT_MS, ESC_WAIT_SLOW_MS, SEQUENCE_DROP_MS, REPLY_WAIT_MS, PASTE_LIMIT_BYTES })
      .toEqual({ ESC_WAIT_MS: 30, ESC_WAIT_SLOW_MS: 150, SEQUENCE_DROP_MS: 500, REPLY_WAIT_MS: 500, PASTE_LIMIT_BYTES: 1_048_576 });
  });
});

describe("deadlines", () => {
  it("answers nothing when empty", () => {
    expect(earliest(NO_DEADLINES)).toBeUndefined();
  });

  it("answers the only deadline", () => {
    expect(earliest(setDeadline(NO_DEADLINES, "esc", 1_050))).toEqual({ name: "esc", at: 1_050 });
  });

  it("answers the earliest of several, whatever order they were set in", () => {
    let deadlines = setDeadline(NO_DEADLINES, "reconnect", 3_000);
    deadlines = setDeadline(deadlines, "esc", 1_050);
    deadlines = setDeadline(deadlines, "notice", 2_000);
    expect(earliest(deadlines)).toEqual({ name: "esc", at: 1_050 });
  });

  it("replaces a name's time when it is set again, and leaves the earlier value as it was", () => {
    const first = setDeadline(setDeadline(NO_DEADLINES, "esc", 1_050), "notice", 2_000);
    const moved = setDeadline(first, "esc", 5_000);
    expect(earliest(moved)).toEqual({ name: "notice", at: 2_000 });
    expect(moved.size).toBe(2);
    expect(earliest(first)).toEqual({ name: "esc", at: 1_050 });
  });

  it("removes a cleared name, and clearing one that is not set changes nothing", () => {
    const both = setDeadline(setDeadline(NO_DEADLINES, "esc", 1_050), "notice", 2_000);
    expect(earliest(clearDeadline(both, "esc"))).toEqual({ name: "notice", at: 2_000 });
    expect(earliest(clearDeadline(clearDeadline(both, "esc"), "notice"))).toBeUndefined();
    expect(clearDeadline(both, "missing")).toBe(both);
  });

  it("breaks a tie by name, the one that sorts first winning, in either setting order", () => {
    const one = setDeadline(setDeadline(NO_DEADLINES, "notice", 2_000), "esc", 2_000);
    const other = setDeadline(setDeadline(NO_DEADLINES, "esc", 2_000), "notice", 2_000);
    expect(earliest(one)).toEqual({ name: "esc", at: 2_000 });
    expect(earliest(other)).toEqual({ name: "esc", at: 2_000 });
  });
});
