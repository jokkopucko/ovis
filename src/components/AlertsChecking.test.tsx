import { afterEach, beforeEach, describe, expect, it, jest, mock } from "bun:test";
import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import * as i18n from "../lib/i18n.ts";

await mock.module("../lib/i18n.ts", () => ({ ...i18n, useT: () => (key: string) => key }));
const { AlertsChecking, ALERTS_CHECK_GIVE_UP_MS, useLongerThan } = await import("./AlertsChecking.tsx");

describe("the guide's alerts while the PC's record is not in", () => {
  const descriptors = new Map<string, PropertyDescriptor | undefined>();
  let renderer: ReactTestRenderer | undefined;
  beforeEach(() => {
    for (const key of ["window", "IS_REACT_ACT_ENVIRONMENT"]) descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
    Object.defineProperty(globalThis, "window", { configurable: true, value: globalThis });
    jest.useFakeTimers();
  });
  afterEach(() => {
    act(() => { renderer?.unmount(); });
    renderer = undefined;
    jest.useRealTimers();
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    descriptors.clear();
  });

  it("says Checking…, then past the bound that it could not check, with Try again", () => {
    let retries = 0;
    function Probe() {
      const late = useLongerThan(true, ALERTS_CHECK_GIVE_UP_MS);
      return createElement(AlertsChecking, { uncheckable: late, onRetry: () => { retries += 1; } });
    }
    act(() => { renderer = create(createElement(Probe)); });
    const text = (): string => renderer!.root.findAllByType("p").map((node) => node.children.filter((child) => typeof child === "string").join("")).join(" ");
    expect(text()).toBe("Checking…");
    expect(renderer!.root.findAllByType("button")).toHaveLength(0);
    act(() => { jest.advanceTimersByTime(ALERTS_CHECK_GIVE_UP_MS - 1); });
    expect(text()).toBe("Checking…");
    act(() => { jest.advanceTimersByTime(1); });
    expect(text()).toBe("Couldn't check alerts.");
    const button = renderer!.root.findByType("button");
    act(() => { button.props.onClick(); });
    expect(retries).toBe(1);
  });

  it("starts the bound again once an answer came in between", () => {
    const seen: boolean[] = [];
    function Probe({ on }: { on: boolean }) { seen.push(useLongerThan(on, ALERTS_CHECK_GIVE_UP_MS)); return null; }
    act(() => { renderer = create(createElement(Probe, { on: true })); });
    act(() => { jest.advanceTimersByTime(ALERTS_CHECK_GIVE_UP_MS - 1); });
    act(() => { renderer!.update(createElement(Probe, { on: false })); });
    act(() => { renderer!.update(createElement(Probe, { on: true })); });
    act(() => { jest.advanceTimersByTime(ALERTS_CHECK_GIVE_UP_MS - 1); });
    expect(seen.at(-1)).toBe(false);
    act(() => { jest.advanceTimersByTime(1); });
    expect(seen.at(-1)).toBe(true);
  });
});
