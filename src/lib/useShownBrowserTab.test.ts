import { afterEach, beforeEach, expect, test } from "bun:test";
import { act, createElement } from "react";
import { openPage, type Page } from "./page.fixture.ts";

import { useShownBrowserTab, type DesktopBrowserTab } from "./desktopBrowser.ts";

let page: Page;
let state: ReturnType<typeof useShownBrowserTab> | undefined;
beforeEach(() => { page = openPage(); });
afterEach(async () => { await page.close(); });

function Probe({ tabs }: { tabs: DesktopBrowserTab[] | null }) {
  state = useShownBrowserTab(tabs);
  return null;
}

const tab = (id: number): DesktopBrowserTab => ({ id, profile: "mine", address: `https://site${id}.example/`, title: `Site ${id}`, loading: false, canGoBack: false, canGoForward: false, held: false, owner: null });

const render = (tabs: DesktopBrowserTab[] | null) => page.render(createElement(Probe, { tabs }));

test("shows a typed tab once main lists it", async () => {
  await render([]);
  await act(async () => { state!.select("new"); state!.opened(5); });
  await render([tab(5)]);
  expect(state!.selected).toBe(5);
  expect(state!.shown?.id).toBe(5);
});

test("leaves a typed tab unshown when the person went back to the panel before main listed it", async () => {
  await render([]);
  await act(async () => { state!.select("new"); state!.opened(5); });
  await act(async () => { state!.select(null); });
  await render([tab(5)]);
  expect(state!.selected).toBeNull();
});

test("leaves a typed tab unshown when the person went back to the panel before main answered", async () => {
  await render([]);
  await act(async () => { state!.select("new"); });
  await act(async () => { state!.select(null); });
  await act(async () => { state!.opened(5); });
  await render([tab(5)]);
  expect(state!.selected).toBeNull();
});
