import { describe, expect, it } from "bun:test";

import { desktopBrowserView } from "./desktopBrowser.ts";

describe("desktopBrowserView", () => {
  it("is null while main answers null (the setting is off)", () => {
    expect(desktopBrowserView(null)).toBeNull();
    expect(desktopBrowserView([])).toBeNull();
  });

  it("reads P3a's tabs before main sends owners or results", () => {
    expect(desktopBrowserView({ tabs: [{ id: 1, profile: "agent", address: "https://a.example/x", title: "A", loading: false, canGoBack: false, canGoForward: false, held: false }] })).toEqual({
      tabs: [{ id: 1, profile: "agent", address: "https://a.example/x", title: "A", loading: false, canGoBack: false, canGoForward: false, held: false, owner: null }],
      results: [],
    });
  });

  it("keeps the owner and results main sends, and drops rows it cannot read", () => {
    const view = desktopBrowserView({
      tabs: [
        { id: 2, profile: "agent", address: "https://b.example/", title: "B", loading: true, canGoBack: false, canGoForward: false, held: true, owner: "w1:p2" },
        { id: 3, profile: "other", address: "https://c.example/" },
        { id: "4", profile: "mine", address: "https://d.example/" },
        { id: 5, profile: "mine", address: "https://e.example/", owner: 7 },
      ],
      results: [
        { id: "r1", kind: "download", name: "report.pdf", at: 1_700_000_000_000, bytes: 2048, done: true, tab: 2, profile: "agent" },
        { id: "r2", kind: "screenshot", name: "shot.png", at: 1_700_000_000_001, profile: "agent" },
        { id: "r3", kind: "page", name: "x", at: 1, profile: "agent" },
        { id: "r4", kind: "download", name: "y", at: "now", profile: "agent" },
        { id: "r5", kind: "download", name: "z", at: Number.POSITIVE_INFINITY, profile: "agent" },
        { id: "r6", kind: "download", name: "w", at: 1e20, bytes: Number.NaN, profile: "agent" },
      ],
    });
    expect(view?.tabs.map((tab) => [tab.id, tab.held, tab.loading, tab.owner])).toEqual([[2, true, true, "w1:p2"], [5, false, false, null]]);
    expect(view?.results).toEqual([
      { id: "r1", kind: "download", name: "report.pdf", at: 1_700_000_000_000, bytes: 2048, done: true, tab: 2, profile: "agent" },
      { id: "r2", kind: "screenshot", name: "shot.png", at: 1_700_000_000_001, bytes: null, done: false, tab: null, profile: "agent" },
    ]);
  });
});
