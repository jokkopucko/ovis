import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { HIDDEN_MACHINES_KEY, useShownMachines } from "./hiddenMachines.ts";

interface Pc { id: string }
interface ProbeProps { machines: Pc[]; selected: { current: string }; picks: { current: number }; restored: boolean; calls: Array<[string, string | null]> }

function Probe({ machines, selected, picks, restored, calls }: ProbeProps) {
  const selectTargetRef = { current: (machineId: string, paneId: string | null) => { calls.push([machineId, paneId]); selected.current = machineId; } };
  useShownMachines({ machines, selectedMachineRef: selected, selectTargetRef, picks, restored });
  return null;
}

describe("a tab opened on its last selection, on a PC hidden here", () => {
  const descriptors = new Map<string, PropertyDescriptor | undefined>();
  let renderer: ReactTestRenderer | undefined;
  const roster: Pc[] = [{ id: "local" }, { id: "work" }];

  beforeEach(() => {
    for (const key of ["window", "IS_REACT_ACT_ENVIRONMENT"]) descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    const records = new Map([[HIDDEN_MACHINES_KEY, JSON.stringify(["work"])]]);
    Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
    Object.defineProperty(globalThis, "window", { configurable: true, value: {
      localStorage: { getItem: (key: string) => records.get(key) ?? null, setItem: (key: string, value: string) => void records.set(key, value) },
      addEventListener: () => undefined, removeEventListener: () => undefined,
    } });
  });

  afterEach(async () => {
    await act(async () => { renderer?.unmount(); });
    renderer = undefined;
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    descriptors.clear();
  });

  async function open(props: Omit<ProbeProps, "machines">): Promise<void> {
    await act(async () => { renderer = create(createElement(Probe, { ...props, machines: [] })); });
  }
  async function rosterArrives(props: Omit<ProbeProps, "machines">): Promise<void> {
    await act(async () => { renderer!.update(createElement(Probe, { ...props, machines: roster })); });
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
