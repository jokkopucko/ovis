import { describe, expect, it } from "bun:test";
import type { HerdrIdentity } from "../../shared/machines.ts";
import { appLayoutOf } from "./machineContext.tsx";

const tui = { version: "0.9.5" } as HerdrIdentity;
const none = { rename: false, split: false, move: false, arrange: false, worktrees: false };

describe("appLayoutOf", () => {
  it("offers every layout call once a PC's herdr says it is herdr's TUI server", () => {
    expect(appLayoutOf(tui)).toEqual({ rename: true, split: true, move: true, arrange: true, worktrees: true });
    expect(appLayoutOf(undefined)).toEqual(none);
  });

  it("offers a herdr-core PC only the calls its layout names", () => {
    expect(appLayoutOf({ ...tui, runtime: "herdr-core" })).toEqual(none);
    expect(appLayoutOf({ ...tui, runtime: "herdr-core", layout: { rename: false, split: false, move: false, arrange: false, worktrees: false } })).toEqual(none);
    const named = { ...tui, runtime: "herdr-core" as const, layout: { rename: true, split: false, move: true, arrange: false, worktrees: false } };
    expect(appLayoutOf(named)).toEqual({ rename: true, split: false, move: true, arrange: false, worktrees: false });
    const own = { ...tui, runtime: "herdr-core" as const, layout: { rename: true, split: true, move: true, arrange: true, worktrees: true } };
    expect(appLayoutOf(own)).toEqual({ rename: true, split: true, move: true, arrange: true, worktrees: true });
    expect(appLayoutOf({ ...own })).toBe(appLayoutOf(own));
  });
});
