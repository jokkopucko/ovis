import { afterEach, beforeEach, expect, it } from "bun:test";
import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { useCloseSessionsWhenLocked } from "./useMachineRoster.ts";

function Probe({ registry, locked }: { registry: { closeAll(): void }; locked: boolean | null }) {
  useCloseSessionsWhenLocked(registry, locked);
  return null;
}

let renderer: ReactTestRenderer | undefined;
let previous: PropertyDescriptor | undefined;
beforeEach(() => {
  previous = Object.getOwnPropertyDescriptor(globalThis, "IS_REACT_ACT_ENVIRONMENT");
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
});
afterEach(async () => {
  await act(async () => { renderer?.unmount(); });
  renderer = undefined;
  if (previous) Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", previous);
  else Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
});

it("closes the app's sockets when it signs out, and leaves them while it is signed in", async () => {
  let closed = 0;
  const registry = { closeAll: () => { closed++; } };
  await act(async () => { renderer = create(createElement(Probe, { registry, locked: null })); });
  await act(async () => { renderer!.update(createElement(Probe, { registry, locked: false })); });
  expect(closed).toBe(0);
  await act(async () => { renderer!.update(createElement(Probe, { registry, locked: true })); });
  expect(closed).toBe(1);
  await act(async () => { renderer!.update(createElement(Probe, { registry, locked: false })); });
  expect(closed).toBe(1);
});
