import { afterEach, beforeEach, expect, it } from "bun:test";
import { act, createElement, useRef } from "react";
import type { Machine } from "../../shared/machines.ts";
import { openPage, type Page } from "./page.fixture.ts";
import { setPcNewness } from "./relay/newPcHere.ts";
import { useSelectTarget } from "./useSelection.ts";

let page: Page;
let picked: (string | null)[];

const machine = {
  id: "local", state: "connected",
  snapshot: { workspaces: [{ workspace_id: "1", label: "alpha", active_tab_id: "1:1" }], panes: [{ pane_id: "p1", workspace_id: "1", focused: true }], focused_pane_id: "p1", layouts: [] },
} as unknown as Machine;

beforeEach(() => {
  page = openPage();
  picked = [];
});

afterEach(async () => {
  await page.close();
  setPcNewness(null);
});

function Probe() {
  const none = () => {};
  useSelectTarget({
    selectedMachineId: "local", setConnected: none, setConnectedBefore: none, setSelectedMachineId: none,
    setSelectedPaneId: (next) => { picked.push(typeof next === "function" ? next(null) : next); }, setAutoSelected: none, setDrawerOpen: none,
    setOutputStopped: none, setNotificationViewTarget: none, setTerminalPeek: none, pendingLink: useRef(null), pendingFile: useRef(null),
    setLinkLanded: none, selectionHint: useRef(null), selectionSince: useRef(0), rosterSeq: useRef(0), snapshot: machine.snapshot,
    selectedMachine: machine, selectedPaneId: null, setHeaderNote: none, linkTick: 0, movingPanes: useRef(new Set<string>()),
  } as Parameters<typeof useSelectTarget>[0]);
  return null;
}

it("#16, C3 pin 1: nothing of the page's PC is selected by itself while it is new in the account, or not known yet", async () => {
  setPcNewness({ until: Date.now() + 3_600_000 });
  await page.render(createElement(Probe));
  expect(picked.filter((pane) => pane !== null)).toEqual([]);
  await act(async () => { setPcNewness("unknown"); });
  expect(picked.filter((pane) => pane !== null)).toEqual([]);
  // known not new (its window passed, or never new): the focused pane is selected as before
  await act(async () => { setPcNewness(null); });
  expect(picked.filter((pane) => pane !== null)).toEqual(["p1"]);
});
