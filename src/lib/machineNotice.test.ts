import { describe, expect, it } from "bun:test";

import type { Machine } from "../../shared/machines.ts";
import { keepDismissed, noticeKey, waitingMachines } from "./machineNotice.ts";

const pc = (id: string, patch: Partial<Machine> = {}): Machine => ({
  id, name: id, kind: "ssh", enabled: true, state: "error", error: null, action_required: "update_bridge", snapshot: null, ...patch,
});

describe("dismissed PC notices", () => {
  it("leaves out a dismissed PC, and shows it again when it waits for something else", () => {
    expect(waitingMachines([pc("saved", { action_required: "connect" })], [])).toEqual([]);
    const a = pc("a"), b = pc("b");
    expect(waitingMachines([a, b], [])).toEqual([a, b]);
    expect(waitingMachines([a, b], [noticeKey(a)])).toEqual([b]);
    const setup = pc("a", { action_required: "setup" });
    expect(waitingMachines([setup], [noticeKey(a)])).toEqual([setup]);
    expect(waitingMachines([pc("c", { action_required: null })], [])).toEqual([]);
  });

  it("keeps a dismissal through a failed update and drops it once the PC connects", () => {
    const dismissed = [noticeKey(pc("a")), noticeKey(pc("b"))];
    expect(keepDismissed(dismissed, [pc("a", { state: "reconnecting", action_required: null }), pc("b")])).toEqual(dismissed);
    expect(keepDismissed(dismissed, [pc("a", { state: "connected", action_required: null }), pc("b")])).toEqual([noticeKey(pc("b"))]);
    expect(keepDismissed(dismissed, [])).toEqual(dismissed);
  });
});
