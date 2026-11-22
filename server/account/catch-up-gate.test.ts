import { describe, expect, test } from "bun:test";
import type { AdmissionOrigin } from "../../shared/account-snapshot.ts";
import { CatchUpGate, type GatedRow } from "./catch-up-gate.ts";

const at = "2026-11-20T05:00:00.000Z";
const origin = (from: AdmissionOrigin["from"], how: AdmissionOrigin["how"]): AdmissionOrigin => ({ from, how, by: null, admit_no: from === "legacy" ? 0 : 1, at });
const rows: Record<string, GatedRow> = {
  code: { id: "a".repeat(16), origin: origin("pc", "code") },
  digits: { id: "b".repeat(16), origin: origin("pc", "digits") },
  qr: { id: "c".repeat(16), origin: origin("pc", "qr") },
  confirmed: { id: "d".repeat(16), origin: origin("pc", "confirmed") },
  linked: { id: "e".repeat(16), origin: origin("remote", "link") },
  member: { id: "f".repeat(16), origin: origin("remote", "member") },
  recover: { id: "1".repeat(16), origin: origin("recover", "qr") },
  legacy: { id: "2".repeat(16), origin: origin("legacy", "legacy") },
  bare: { id: "3".repeat(16), origin: undefined },
};
const waiting = (gate: CatchUpGate) => Object.entries(rows).filter(([, row]) => gate.waits(row)).map(([name]) => name);

describe("S2-27 devices.json rows wait for the first whole read (T41, T42, T65, T70)", () => {
  test("T41: every non-screen-paired row waits after restart or first binding, including legacy with no metadata", () => {
    let binding: string | null = "bind-1";
    const gate = new CatchUpGate(() => binding);
    expect(waiting(gate)).toEqual(["confirmed", "linked", "member", "recover", "legacy", "bare"]);
    gate.wholeRead();
    expect(waiting(gate)).toEqual([]);
    // a new binding (T59) waits for a whole read of its own
    binding = "bind-2";
    expect(waiting(gate)).toEqual(["confirmed", "linked", "member", "recover", "legacy", "bare"]);
    binding = null;
    expect(waiting(gate)).toEqual([]);
  });

  test("T65: with the service off no read comes, so the wait stays; only screen-paired rows and released rows get in", () => {
    const released = new Set([rows.legacy!.id]);
    const gate = new CatchUpGate(() => "bind-1", (id) => released.has(id));
    expect(waiting(gate)).toEqual(["confirmed", "linked", "member", "recover", "bare"]);
  });

  test("T70: a row this PC's user released (ovis recover) stops waiting while the release stands", () => {
    const released = new Set<string>();
    const gate = new CatchUpGate(() => "bind-1", (id) => released.has(id));
    expect(gate.waits(rows.member!)).toBe(true);
    released.add(rows.member!.id);
    expect(gate.waits(rows.member!)).toBe(false);
    released.clear();
    expect(gate.waits(rows.member!)).toBe(true);
  });

  test("T42: a whole read ends the wait only for the rows its guard passes", () => {
    const gate = new CatchUpGate(() => "bind-1");
    gate.wholeRead([rows.linked!.id]);
    expect(waiting(gate)).toEqual(["linked"]);
  });

  test("T42: an intervening read preserves the post-lift wait for a screen-paired row", () => {
    const gate = new CatchUpGate(() => "bind-1");
    const affected = rows.digits;
    if (!affected) throw new Error("Missing digits row");
    gate.noteFreeze("block", [affected.id]);
    gate.wholeRead([affected.id]);
    gate.waitAfterLift("block", []);
    expect(gate.waits(affected)).toBe(true);
    gate.wholeRead();
    expect(gate.waits(affected)).toBe(false);
  });
});
