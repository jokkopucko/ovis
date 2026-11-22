import { afterEach, expect, test } from "bun:test";
import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";

import { useShownBrowserTab, type DesktopBrowserTab } from "./desktopBrowser.ts";

let renderer: ReactTestRenderer | undefined;
let state: ReturnType<typeof useShownBrowserTab> | undefined;
const saved = Object.getOwnPropertyDescriptor(globalThis, "IS_REACT_ACT_ENVIRONMENT");

afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
  if (saved) Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", saved);
  else Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
});

function Probe({ tabs }: { tabs: DesktopBrowserTab[] | null }) {
  state = useShownBrowserTab(tabs);
  return null;
}

const tab = (id: number): DesktopBrowserTab => ({ id, profile: "mine", address: `https://site${id}.example/`, title: `Site ${id}`, loading: false, canGoBack: false, canGoForward: false, held: false, owner: null });

const render = async (tabs: DesktopBrowserTab[] | null) => {
  if (renderer) await act(async () => renderer!.update(createElement(Probe, { tabs })));
  else await act(async () => { renderer = create(createElement(Probe, { tabs })); });
};

test("shows a typed tab once main lists it", async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  await render([]);
  await act(async () => { state!.select("new"); state!.opened(5); });
  await render([tab(5)]);
  expect(state!.selected).toBe(5);
  expect(state!.shown?.id).toBe(5);
});

test("leaves a typed tab unshown when the person went back to the panel before main listed it", async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  await render([]);
  await act(async () => { state!.select("new"); state!.opened(5); });
  await act(async () => { state!.select(null); });
  await render([tab(5)]);
  expect(state!.selected).toBeNull();
});

test("leaves a typed tab unshown when the person went back to the panel before main answered", async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  await render([]);
  await act(async () => { state!.select("new"); });
  await act(async () => { state!.select(null); });
  await act(async () => { state!.opened(5); });
  await render([tab(5)]);
  expect(state!.selected).toBeNull();
});
