import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { act, createElement } from "react";

import { openPage, type Page } from "../lib/page.fixture.ts";
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
  let page: Page;
  let keyboard: boolean;
  let visible: string;
  const row = () => page.one('[role="group"]');
  const buttons = () => [...row().querySelectorAll("button")];
  const nameOf = (button: Element) => button.getAttribute("title") ?? "more";
  /** the folder holding focus, or "body" when nothing in the row has it */
  const active = (): string => {
    const focused = buttons().find((button) => button === (page.window.document.activeElement as unknown));
    return focused ? nameOf(focused) : "body";
  };
  /** focuses a chip; `keyboard` says whether the browser would match it as :focus-visible */
  const focus = (name: string, viaKeyboard: boolean): void => {
    keyboard = viaKeyboard;
    act(() => { buttons().find((button) => nameOf(button) === name)!.focus(); });
  };

  beforeEach(async () => {
    page = openPage();
    keyboard = false;
    visible = "/folder-1";
    const { HTMLElement } = page.window;
    const matches = HTMLElement.prototype.matches;
    Object.defineProperty(page.window, "matchMedia", {
      configurable: true,
      value: (query: string) => ({ matches: query.includes("max-width: 640px"), addEventListener() {}, removeEventListener() {} }),
    });
    Object.defineProperty(HTMLElement.prototype, "matches", {
      configurable: true,
      value(this: Element, selector: string) { return selector === ":focus-visible" ? keyboard : matches.call(this, selector); },
    });
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value(this: Element) { visible = nameOf(this); },
    });
    await page.render(createElement(SettingsProvider, null, createElement(RecentFolderChips, {
      folders, disabled: false, labelledBy: "recent", basename: (path) => path.slice(1), onPick() {},
    })));
  });

  afterEach(async () => {
    await page.close();
  });

  /** presses "more": `detail` 0 is a keyboard activation, 1 a tap or click */
  const expand = async (detail: number): Promise<void> => {
    const more = buttons().find((button) => nameOf(button) === "more");
    if (!more) throw new Error("No more folders button");
    await act(async () => { more.dispatchEvent(new page.window.MouseEvent("click", { bubbles: true, detail }) as unknown as Event); });
  };

  it.each([["first", 0, "/folder-11"], ["last", 1, "/folder-21"]] as const)(
    "focuses and reveals the first added folder on keyboard activation of the %s page",
    async (_page, priorExpansions, firstAdded) => {
      if (priorExpansions > 0) await expand(1);
      focus("more", true);
      await expand(0);
      expect(active()).toBe(firstAdded);
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
    expect(active()).toBe("more");
    expect(visible).toBe("/folder-1");
  });
});
