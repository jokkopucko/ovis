import { describe, expect, it } from "bun:test";
import type { Machine, MachineEvent } from "../shared/machines.ts";
import { subscribeMachineEvents } from "./machine-events.ts";
import type { MachineManager } from "./machines.ts";

const machine = (state: Machine["state"]): Machine => ({ id: "local", name: "PC", kind: "local", enabled: true, state, error: null, snapshot: null });

function document(first: Machine[] = [machine("connected")]): { emit: (event: MachineEvent) => void; told: MachineEvent[] } {
  let emit: (event: MachineEvent) => void = () => undefined;
  const manager: Pick<MachineManager, "subscribe"> = {
    subscribe: (listener) => { emit = listener; listener({ type: "machines", machines: first }); return () => undefined; },
  };
  const told: MachineEvent[] = [];
  subscribeMachineEvents({ manager }, (event) => told.push(JSON.parse(JSON.stringify(event)) as MachineEvent));
  return { emit: (event) => emit(event), told };
}

describe("machine event document", () => {
  it("does not tell a roster again when it is the same as the event told just before it", () => {
    const { emit, told } = document();
    emit({ type: "machines", machines: [machine("connected")] });
    emit({ type: "machines", machines: [machine("connected")] });
    expect(told.map((event) => event.type)).toEqual(["machines"]);
  });

  it("tells an unchanged roster again after another event, which may wait for the roster after it", () => {
    const { emit, told } = document();
    emit({ type: "machine-message", machine_id: "local", message: { type: "session-changed" } });
    emit({ type: "machines", machines: [machine("connected")] });
    expect(told.map((event) => event.type)).toEqual(["machines", "machine-message", "machines"]);
  });

  it("tells a roster whose machine the manager changed in place since the last one", () => {
    const held = machine("connected");
    const { emit, told } = document([held]);
    held.state = "reconnecting";
    emit({ type: "machines", machines: [held] });
    expect(told).toEqual([{ type: "machines", machines: [machine("connected")] }, { type: "machines", machines: [machine("reconnecting")] }]);
  });

  it("tells a roster that changed", () => {
    const { emit, told } = document();
    emit({ type: "machines", machines: [machine("reconnecting")] });
    expect(told.map((event) => event.type)).toEqual(["machines", "machines"]);
  });
});
