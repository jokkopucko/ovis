import { afterEach, beforeEach, describe, expect, it, jest, mock } from "bun:test";
import { act, createElement } from "react";
import { openPage, type Page } from "../lib/page.fixture.ts";
import * as i18n from "../lib/i18n.ts";

await mock.module("../lib/i18n.ts", () => ({ ...i18n, useT: () => (key: string) => key }));
const { AlertsChecking, ALERTS_CHECK_GIVE_UP_MS, useLongerThan } = await import("./AlertsChecking.tsx");

describe("the guide's alerts while the PC's record is not in", () => {
  let page: Page;
  beforeEach(() => {
    page = openPage();
    jest.useFakeTimers();
    Object.assign(page.window, { setTimeout, clearTimeout });
  });
  afterEach(async () => {
    jest.useRealTimers();
    await page.close();
  });

  it("says Checking…, then past the bound that it could not check, with Try again", async () => {
    let retries = 0;
    function Probe() {
      const late = useLongerThan(true, ALERTS_CHECK_GIVE_UP_MS);
      return createElement(AlertsChecking, { uncheckable: late, onRetry: () => { retries += 1; } });
    }
    await page.render(createElement(Probe));
    const text = (): string => [...page.container.querySelectorAll("p")].map((node) => node.textContent).join(" ");
    expect(text()).toBe("Checking…");
    expect(page.container.querySelectorAll("button")).toHaveLength(0);
    await act(async () => { jest.advanceTimersByTime(ALERTS_CHECK_GIVE_UP_MS - 1); });
    expect(text()).toBe("Checking…");
    await act(async () => { jest.advanceTimersByTime(1); });
    expect(text()).toBe("Couldn't check alerts.");
    const button = page.one("button");
    await act(async () => { button.click(); });
    expect(retries).toBe(1);
  });

  it("starts the bound again once an answer came in between", async () => {
    const seen: boolean[] = [];
    function Probe({ on }: { on: boolean }) { seen.push(useLongerThan(on, ALERTS_CHECK_GIVE_UP_MS)); return null; }
    await page.render(createElement(Probe, { on: true }));
    await act(async () => { jest.advanceTimersByTime(ALERTS_CHECK_GIVE_UP_MS - 1); });
    await page.render(createElement(Probe, { on: false }));
    await page.render(createElement(Probe, { on: true }));
    await act(async () => { jest.advanceTimersByTime(ALERTS_CHECK_GIVE_UP_MS - 1); });
    expect(seen.at(-1)).toBe(false);
    await act(async () => { jest.advanceTimersByTime(1); });
    expect(seen.at(-1)).toBe(true);
  });
});
