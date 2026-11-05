import { describe, expect, it, spyOn } from "bun:test";

import { ompScreenContext, ompStatusContext } from "./omp-status.ts";
import * as herdr from "./herdr/client.ts";

// a pane's bottom rows, as `pane.read?format=text` answers them
const bar = (size: string, percent: string): string => [
  "",
  " ⠋ 46s · ◒ deepseek-flash · 📁 ~/coding_agent · ◫ " + percent + "/" + size + " ⟲ · $105.66 (+30.57) ↑ + 👁 1.68   🖥️ WUI: Review repo chang…",
  "",
].join("\n");

describe("ompStatusContext", () => {
  it("reads the percent and the window omp's bar states", () => {
    expect(ompStatusContext(bar("1M", "48.1%"))).toEqual({ used: 481_000, window: 1_000_000 });
    expect(ompStatusContext(bar("200k", "0.4%"))).toEqual({ used: 800, window: 200_000 });
    expect(ompStatusContext(bar("1M", "100%"))).toEqual({ used: 1_000_000, window: 1_000_000 });
  });

  it("takes the last bar: a page of scrollback may quote an older one", () => {
    const screen = [bar("200k", "9%"), "output", bar("1M", "12.5%")].join("\n");
    expect(ompStatusContext(screen)).toEqual({ used: 125_000, window: 1_000_000 });
  });

  it("says nothing where omp drew no bar", () => {
    expect(ompStatusContext("")).toBeNull();
    expect(ompStatusContext("plain output\nwith no status bar")).toBeNull();
    // a dialog over the bar, and a bar whose percent is not a number this reader guesses
    expect(ompStatusContext("◫ --/1M")).toBeNull();
  });
});

describe("ompScreenContext", () => {
  const pane = "statusline-test-pane";

  it("requires a stable bottom viewport before and after reading, including cache hits", async () => {
    let offset = 0;
    let history = 100;
    let moveDuringRead = false;
    const scroll = spyOn(herdr, "paneScrollInfo").mockImplementation(async () => ({ offset_from_bottom: offset, max_offset_from_bottom: history, viewport_rows: 24 }));
    const read = spyOn(herdr, "paneRead").mockImplementation(async () => {
      if (moveDuringRead) offset = 1;
      return { text: bar("1M", "48.1%"), format: "text", source: "visible", pane_id: pane, tab_id: "tab", workspace_id: "ws", revision: 1, truncated: false };
    });
    try {
      expect(await ompScreenContext(pane, 1)).toEqual({ used: 481_000, window: 1_000_000 });
      expect(read).toHaveBeenCalledTimes(1);
      offset = 4;
      expect(await ompScreenContext(pane, 2)).toBeNull();
      expect(read).toHaveBeenCalledTimes(1);
      offset = 0;
      expect(await ompScreenContext(pane, 3)).toEqual({ used: 481_000, window: 1_000_000 });
      expect(read).toHaveBeenCalledTimes(1);
      history++;
      moveDuringRead = true;
      expect(await ompScreenContext(pane, 4)).toBeNull();
      expect(read).toHaveBeenCalledTimes(2);
      scroll.mockResolvedValue(null);
      expect(await ompScreenContext(pane, 5)).toBeNull();
      expect(read).toHaveBeenCalledTimes(2);
    } finally { scroll.mockRestore(); read.mockRestore(); }
  });

  it("rejects a changed history boundary even when both offsets are zero", async () => {
    const scroll = spyOn(herdr, "paneScrollInfo").mockResolvedValueOnce({ offset_from_bottom: 0, max_offset_from_bottom: 100, viewport_rows: 24 })
      .mockResolvedValueOnce({ offset_from_bottom: 0, max_offset_from_bottom: 101, viewport_rows: 24 });
    const read = spyOn(herdr, "paneRead").mockResolvedValue({ text: bar("1M", "48.1%"), format: "text", source: "visible", pane_id: pane, tab_id: "tab", workspace_id: "ws", revision: 1, truncated: false });
    try { expect(await ompScreenContext(pane)).toBeNull(); }
    finally { scroll.mockRestore(); read.mockRestore(); }
  });
});
