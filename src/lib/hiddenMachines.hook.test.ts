import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createElement } from "react";
import { openPage, type Page } from "./page.fixture.ts";
import { HIDDEN_MACHINES_KEY, useShownMachines } from "./hiddenMachines.ts";

interface Pc { id: string }
interface ProbeProps { machines: Pc[]; selected: { current: string }; picks: { current: number }; restored: boolean; calls: Array<[string, string | null]> }

function Probe({ machines, selected, picks, restored, calls }: ProbeProps) {
  const selectTargetRef = { current: (machineId: string, paneId: string | null) => { calls.push([machineId, paneId]); selected.current = machineId; } };
  useShownMachines({ machines, selectedMachineRef: selected, selectTargetRef, picks, restored });
  return null;
}

describe("a tab opened on its last selection, on a PC hidden here", () => {
  let page: Page;
  const roster: Pc[] = [{ id: "local" }, { id: "work" }];

  beforeEach(() => {
    page = openPage();
    page.window.localStorage.setItem(HIDDEN_MACHINES_KEY, JSON.stringify(["work"]));
  });

  afterEach(async () => { await page.close(); });

  async function open(props: Omit<ProbeProps, "machines">): Promise<void> {
    await page.render(createElement(Probe, { ...props, machines: [] }));
  }
  async function rosterArrives(props: Omit<ProbeProps, "machines">): Promise<void> {
    await page.render(createElement(Probe, { ...props, machines: roster }));
  }

  it("moves the selection to a PC shown once the roster names its PC", async () => {
    const props = { selected: { current: "work" }, picks: { current: 0 }, restored: true, calls: [] as Array<[string, string | null]> };
    await open(props);
    expect(props.calls).toEqual([]);
    await rosterArrives(props);
    expect(props.calls).toEqual([["local", null]]);
  });

  it("keeps a pane an alert opened on that PC before the roster came", async () => {
    const props = { selected: { current: "work" }, picks: { current: 0 }, restored: true, calls: [] as Array<[string, string | null]> };
    await open(props);
    props.picks.current = 1;
    await rosterArrives(props);
    expect(props.calls).toEqual([]);
  });

  it("leaves a selection a link made alone", async () => {
    const props = { selected: { current: "work" }, picks: { current: 0 }, restored: false, calls: [] as Array<[string, string | null]> };
    await open(props);
    await rosterArrives(props);
    expect(props.calls).toEqual([]);
  });
});
