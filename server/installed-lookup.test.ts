import { describe, expect, it } from "bun:test";

import { InstalledLookup, RETRY_MS, type PathLookup } from "./installed-lookup.ts";

function fake() {
  const folder = new Set<string>();
  let next = new Set<string>();
  let path = new Set<string>();
  let refreshes = 0;
  const asked: boolean[] = [];
  let held: ReturnType<typeof Promise.withResolvers<void>> | null = null;
  const lookup: PathLookup = {
    onPath: async (binary) => path.has(binary) ? `/home/u/.local/bin/${binary}` : null,
    inInstallFolder: (binary) => folder.has(binary) ? { path: `/home/u/.local/bin/${binary}`, mark: "1" } : null,
    refresh: async (interactive) => { refreshes += 1; asked.push(interactive); if (held !== null) await held.promise; path = new Set(next); },
  };
  return {
    lookup,
    installed: (binary: string, onProfile: boolean) => { folder.add(binary); if (onProfile) next.add(binary); },
    profiled: (binary: string) => { next.add(binary); },
    hold: () => { held = Promise.withResolvers<void>(); return held; },
    refreshes: () => refreshes,
    asked: () => asked,
  };
}

describe("InstalledLookup", () => {
  it("offers an agent an install just added to the login PATH, after reading that PATH again once", async () => {
    const f = fake();
    const installed = new InstalledLookup(f.lookup);
    expect(await installed.has("opencode")).toBe(false);
    f.installed("opencode", true);
    expect(await installed.has("opencode")).toBe(true);
    expect(f.refreshes()).toBe(1);
  });

  it("does not offer one found only in an installer folder no PATH has, and reads that PATH again only once per window for it", async () => {
    const f = fake();
    const installed = new InstalledLookup(f.lookup, () => 0);
    f.installed("claude", false);
    expect(await installed.has("claude")).toBe(false);
    expect(await installed.has("claude")).toBe(false);
    expect(await installed.has("claude")).toBe(false);
    expect(f.refreshes()).toBe(1);
  });

  it("lets a read that comes while the refresh runs wait for it, instead of answering the old miss", async () => {
    const f = fake();
    const installed = new InstalledLookup(f.lookup);
    f.installed("opencode", true);
    const gate = f.hold();
    const first = installed.has("opencode");
    const second = installed.has("opencode");
    gate.resolve();
    expect(await Promise.all([first, second])).toEqual([true, true]);
    expect(f.refreshes()).toBe(1);
  });

  it("asks the interactive shell again for a new install only, never on a retry", async () => {
    let now = 0;
    const f = fake();
    const installed = new InstalledLookup(f.lookup, () => now);
    f.installed("claude", false);
    expect(await installed.has("claude")).toBe(false);
    now += RETRY_MS;
    expect(await installed.has("claude")).toBe(false);
    expect(f.asked()).toEqual([true, false]);
  });

  it("reads the PATH again, at most every RETRY_MS, while the install is still missing from it (the installer edits the profile after its binary)", async () => {
    const f = fake();
    let clock = 0;
    const installed = new InstalledLookup(f.lookup, () => clock);
    f.installed("opencode", false);
    expect(await installed.has("opencode")).toBe(false);
    f.profiled("opencode");
    clock += RETRY_MS - 1;
    expect(await installed.has("opencode")).toBe(false);
    expect(f.refreshes()).toBe(1);
    clock += 1;
    expect(await installed.has("opencode")).toBe(true);
    expect(f.refreshes()).toBe(2);
  });
});
