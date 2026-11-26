import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { act, createElement } from "react";
import { openPage, type Page } from "./page.fixture.ts";
import type { SplitState } from "./split.ts";
import { useSplitLayout } from "./useSplitView.ts";

describe("useSplitLayout", () => {
  let page: Page;
  let written: (SplitState | null)[];
  let notes: unknown[];
  let layout: ReturnType<typeof useSplitLayout>;
  const splitShownRef = { current: false };
  const split: SplitState = {
    root: { dir: "row", ratio: 0.5, first: { slot: "a" }, second: { slot: "b" } },
    panes: { b: { machineId: "local", paneId: "w1:p2" } },
    active: "a",
  };

  beforeEach(() => {
    page = openPage();
    written = [];
    notes = [];
    splitShownRef.current = false;
  });

  afterEach(async () => { await page.close(); });

  const nothing = (): void => {};
  function Probe({ wideScreen, threadDrawn }: { wideScreen: boolean; threadDrawn: boolean }) {
    layout = useSplitLayout({
      machines: [], split, wideScreen, selectedPaneId: "w1:p1", selectedPane: null, selectedMachineId: "local", splitShownRef,
      health: null, machineRosterLoaded: false, endSplit: nothing, otherRecheck: { current: false }, otherRosterTick: 0,
      setSplit: (next) => { written.push(next); }, soloSlot: "a", setConnected: nothing, setConnectedBefore: nothing,
      setSelectedMachineId: nothing, setSelectedPaneId: nothing, setAutoSelected: nothing, setOutputStopped: nothing, setHeaderNote: (note) => { notes.push(typeof note === "function" ? note("pane-closed") : note); },
      splitRef: { current: split }, selectPane: nothing, paneAreaRef: { current: null }, gridDrop: null, gridDropRef: { current: null },
      clearDropPreview: nothing, tabDrag: null, showGridDrop: nothing, hideDropTarget: nothing, setPaneDragging: nothing,
      movingPanes: { current: new Set() }, draggedPaneRef: { current: null }, markSwap: nothing, markMove: nothing,
      swapPanes: nothing, movePanes: nothing, arrangeRefused: () => false, followPaneMove: nothing, threadDrawn,
    });
    return null;
  }
  const draw = async (props: { wideScreen: boolean; threadDrawn: boolean }): Promise<void> => {
    await page.render(createElement(Probe, props));
  };

  it("tells the alerts the split is on the screen only while both halves are drawn, not under a thread drawn alone", async () => {
    await draw({ wideScreen: true, threadDrawn: false });
    expect(layout.splitOn).toBe(true);
    expect(splitShownRef.current).toBe(true);
    await draw({ wideScreen: true, threadDrawn: true });
    expect(splitShownRef.current).toBe(false);
    await draw({ wideScreen: true, threadDrawn: false });
    expect(splitShownRef.current).toBe(true);
  });

  it("makes the slot that holds a picked pane the active one on a narrow window that keeps the split, as on a wide one", async () => {
    for (const wideScreen of [true, false]) {
      written = [];
      await draw({ wideScreen, threadDrawn: false });
      await act(async () => { layout.activateSlotOf({ machineId: "local", paneId: "w1:p2" }); });
      expect(written).toEqual([{ ...split, panes: { a: { machineId: "local", paneId: "w1:p1" } }, active: "b" }]);
    }
  });

  it("takes an earlier link's note away when another slot's pane is picked", async () => {
    await draw({ wideScreen: true, threadDrawn: false });
    await act(async () => { layout.activateSlot("b"); });
    expect(notes).toEqual([null]);
  });
});
