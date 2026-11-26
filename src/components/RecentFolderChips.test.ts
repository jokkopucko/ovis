import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { act, createElement } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";

import { SettingsProvider } from "../lib/settings.ts";
import { chipsThatFit, RecentFolderChips } from "./RecentFolderChips.tsx";

it("fits every chip it can, keeping room for the +N chip when some are left over", () => {
  expect(chipsThatFit([100, 100, 100], 40, 8, 316)).toBe(3);
  expect(chipsThatFit([100, 100, 100], 40, 8, 315)).toBe(2);
  expect(chipsThatFit([100, 100, 100], 40, 8, 255)).toBe(1);
  expect(chipsThatFit([300, 100], 40, 8, 200)).toBe(1);
  expect(chipsThatFit([], 40, 8, 200)).toBe(0);
});

it("keeps room for the +N chip while more folders wait to be shown, even when every chip shown would fit", () => {
  expect(chipsThatFit([100, 100, 100], 40, 8, 316, true)).toBe(2);
  expect(chipsThatFit([100, 100, 100], 40, 8, 364, true)).toBe(3);
  expect(chipsThatFit([300], 40, 8, 200, true)).toBe(1);
  expect(chipsThatFit([], 40, 8, 200, true)).toBe(0);
});

describe("the swipe row's keyboard focus", () => {
  const folders = Array.from({ length: 23 }, (_, index) => `/folder-${index + 1}`);
  const saved = new Map<string, PropertyDescriptor | undefined>();
  let renderer: ReactTestRenderer | undefined;
  let active: string;
  let visible: string;
  const row = () => renderer?.root.findByProps({ role: "group" });
  const buttons = () => row()?.findAllByType("button") ?? [];
  const nameOf = (button: ReturnType<typeof buttons>[number]) => button.props.title ?? "more";
  const focus = (name: string, keyboard: boolean): void => {
    active = name;
    row()?.props.onFocus?.({ target: {
      matches: (selector: string) => keyboard && selector === ":focus-visible",
      scrollIntoView: () => { visible = name; },
    } });
  };

  beforeEach(async () => {
    active = "body";
    visible = "/folder-1";
    const globals = {
      IS_REACT_ACT_ENVIRONMENT: true,
      window: {
        matchMedia: (query: string) => ({ matches: query.includes("max-width: 640px"), addEventListener() {}, removeEventListener() {} }),
        addEventListener() {}, removeEventListener() {},
      },
      document: { documentElement: { dataset: {}, style: { setProperty() {}, removeProperty() {} } }, querySelector: () => null },
      navigator: { languages: ["en-US"] },
      getComputedStyle: () => ({ getPropertyValue: () => "" }),
    };
    for (const [key, value] of Object.entries(globals)) {
      saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
      Object.defineProperty(globalThis, key, { configurable: true, value });
    }
    await act(async () => {
      renderer = create(createElement(SettingsProvider, null, createElement(RecentFolderChips, {
        folders, disabled: false, labelledBy: "recent", basename: (path) => path.slice(1), onPick() {},
      })), {
        createNodeMock: () => ({
          querySelectorAll: () => buttons().map((button) => ({ focus: () => focus(nameOf(button), false) })),
        }),
      });
    });
  });

  afterEach(async () => {
    await act(async () => renderer?.unmount());
    renderer = undefined;
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    saved.clear();
  });

  const expand = async (detail: number): Promise<void> => {
    const more = buttons().find((button) => nameOf(button) === "more");
    if (!more) throw new Error("No more folders button");
    await act(async () => more.props.onClick({ detail }));
    if (!buttons().some((button) => nameOf(button) === active)) active = "body";
  };

  it.each([["first", 0, "/folder-11"], ["last", 1, "/folder-21"]] as const)(
    "focuses and reveals the first added folder on keyboard activation of the %s page",
    async (_page, priorExpansions, firstAdded) => {
      if (priorExpansions > 0) await expand(1);
      focus("more", true);
      await expand(0);
      expect(active).toBe(firstAdded);
      expect(visible).toBe(firstAdded);
    },
  );

  it("reveals an offscreen folder when Tab focuses it without scrolling", () => {
    focus("/folder-10", true);
    expect(visible).toBe("/folder-10");
  });

  it("does not move focus or scroll to the new folders on a tap", async () => {
    focus("more", false);
    await expand(1);
    expect(buttons().map(nameOf)).toContain("/folder-11");
    expect(active).toBe("more");
    expect(visible).toBe("/folder-1");
  });
});
