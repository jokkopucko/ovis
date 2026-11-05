import { describe, expect, test } from "bun:test";

import type { ConversationTurn } from "../../shared/protocol.ts";
import { MINIMAP_TICK_MIN_PX, minimapCurrent, minimapFits, minimapSlots, minimapSlotTarget, minimapSlotTurn, minimapStep, minimapTop, minimapTurns, minimapTurnSlot } from "./chatMinimap.ts";

const user = (text: string): ConversationTurn => ({ role: "user", ts: null, parts: [{ kind: "text", text }] });
const agent: ConversationTurn = { role: "assistant", ts: null, parts: [{ kind: "text", text: "ok" }] };

describe("chatMinimap", () => {
  test("one tick per message the user sent", () => {
    const notice: ConversationTurn = { role: "user", ts: null, parts: [{ kind: "notice", text: "result" }] };
    const compact: ConversationTurn = { role: "user", ts: null, parts: [{ kind: "compact", text: "summary" }] };
    expect(minimapTurns([user("a\n\n b"), agent, notice, compact, user("c"), agent])).toEqual([
      { row: 0, preview: "a b" },
      { row: 4, preview: "c" },
    ]);
    expect(minimapTurns([user("x".repeat(200))])[0]!.preview).toHaveLength(120);
  });

  test("a short rail gives one tick to each run of turns", () => {
    expect(minimapSlots(10, 72)).toBe(10);
    expect(minimapSlots(2000, 600)).toBe(151);
    expect(minimapSlots(10, 0)).toBe(10);
    expect(minimapSlots(10, 4)).toBe(2);
    expect(minimapSlots(3, 4)).toBe(2);
    // no rail places ticks closer than the minimum, however short it is
    for (let rail = 1; rail <= 40; rail++) {
      for (const count of [4, 5, 10, 200]) {
        const slots = minimapSlots(count, rail);
        if (slots > 1) expect(rail * (minimapTop(1, slots) - minimapTop(0, slots)) / 100).toBeGreaterThanOrEqual(MINIMAP_TICK_MIN_PX - 1e-9);
      }
    }
    for (const [count, slots] of [[10, 3], [2000, 151], [151, 150], [7, 7]] as const) {
      expect(minimapSlotTurn(0, slots, count)).toBe(0);
      for (let turn = 0; turn < count; turn++) {
        const slot = minimapTurnSlot(turn, slots, count);
        const next = slot + 1 < slots ? minimapSlotTurn(slot + 1, slots, count) : count;
        expect(minimapSlotTurn(slot, slots, count) <= turn && turn < next).toBe(true);
      }
    }
    expect(minimapTurnSlot(1999, 151, 2000)).toBe(150);
    // the bottom tick (and End) reaches the newest turn on a capped rail, as on a full one
    for (const [count, slots] of [[2000, 151], [200, 50], [80, 20], [7, 7]] as const) {
      expect(minimapSlotTarget(slots - 1, slots, count)).toBe(count - 1);
      expect(minimapSlotTarget(0, slots, count)).toBe(0);
    }
  });

  test("ticks spread from top to bottom", () => {
    expect(minimapTop(0, 5)).toBe(0);
    expect(minimapTop(2, 5)).toBe(50);
    expect(minimapTop(4, 5)).toBe(100);
    expect(minimapTop(0, 1)).toBe(0);
  });

  test("the turn in view, else the one that began above", () => {
    const rows = [0, 4, 8, 12];
    expect(minimapCurrent(rows, 3, 6)).toBe(1);
    expect(minimapCurrent(rows, 5, 7)).toBe(1);
    expect(minimapCurrent(rows, 13, 15)).toBe(3);
    expect(minimapCurrent([5, 9], 0, 3)).toBeNull();
  });

  test("the rail needs a margin beside the column", () => {
    expect(minimapFits(1200, 760)).toBe(true);
    expect(minimapFits(800, 760)).toBe(false);
    expect(minimapFits(700, 760)).toBe(false);
  });

  test("list keys move the focus within the rail", () => {
    expect(minimapStep(0, 5, "ArrowUp")).toBe(0);
    expect(minimapStep(0, 5, "ArrowDown")).toBe(1);
    expect(minimapStep(4, 5, "ArrowDown")).toBe(4);
    expect(minimapStep(2, 5, "Home")).toBe(0);
    expect(minimapStep(2, 5, "End")).toBe(4);
    expect(minimapStep(2, 5, "a")).toBeNull();
  });
});
