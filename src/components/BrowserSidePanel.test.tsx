import { afterEach, beforeEach, expect, jest, test } from "bun:test";
import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";

import { BrowserSidePanel, type BrowserSidePanelPane } from "./BrowserSidePanel.tsx";
import { useDesktopBrowser } from "../lib/desktopBrowser.ts";
import { SettingsProvider } from "../lib/settings.ts";

const globals = ["IS_REACT_ACT_ENVIRONMENT", "window", "document", "getComputedStyle", "navigator"];
const saved = new Map(globals.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
let renderer: ReactTestRenderer | undefined;

interface Stub {
  current: () => Promise<unknown>;
  onChange: (listener: (view: unknown) => void) => () => void;
  close: ReturnType<typeof jest.fn>;
  reveal: ReturnType<typeof jest.fn>;
  thumbnail: () => Promise<unknown>;
  tell: (view: unknown) => void;
}

let pictures = 0;

function stub(current: () => Promise<unknown>): Stub {
  const listeners = new Set<(view: unknown) => void>();
  return {
    current,
    onChange: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    close: jest.fn(),
    reveal: jest.fn(),
    thumbnail: async () => { pictures += 1; return "data:image/jpeg;base64,AAAA"; },
    tell: (view) => { for (const listener of listeners) listener(view); },
  };
}

function install(bridge: Stub | undefined): void {
  const listen = { addEventListener() {}, removeEventListener() {} };
  const style = { setProperty() {}, removeProperty() {}, getPropertyValue: () => "", backgroundColor: "" };
  Object.assign(globalThis, {
    IS_REACT_ACT_ENVIRONMENT: true,
    window: { ...listen, localStorage: { getItem: () => null, setItem() {} }, matchMedia: () => ({ ...listen, matches: false }), ...(bridge ? { ovisBrowser: bridge } : {}) },
    document: { ...listen, documentElement: { lang: "", dataset: {}, style }, querySelector: () => null },
    getComputedStyle: () => style,
    navigator: { languages: ["en"] },
  });
}

const opened: number[] = [];

function Harness({ pane }: { pane: BrowserSidePanelPane | null }) {
  const browser = useDesktopBrowser();
  return browser === null ? null : createElement(BrowserSidePanel, { browser, pane, agentOf: (paneId: string) => paneId === "w1:p1" ? "claude" : null, onOpen: (tab: number) => opened.push(tab) });
}

const render = async (pane: BrowserSidePanelPane | null = null) => {
  await act(async () => { renderer = create(createElement(SettingsProvider, { children: createElement(Harness, { pane }) })); });
};

const view = {
  tabs: [
    { id: 1, profile: "mine", address: "https://mine.example/", title: "Mine", loading: false, held: false },
    { id: 2, profile: "agent", address: "https://agent.example/", title: "Agent tab", loading: false, held: false, owner: "w1:p1" },
  ],
  results: [{ id: "r1", kind: "download", name: "report.pdf", at: 1_700_000_000_000, bytes: 10, done: true, tab: 2, profile: "agent" }],
};

beforeEach(() => { jest.useFakeTimers(); });

afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
  jest.useRealTimers();
  jest.restoreAllMocks();
  for (const [name, descriptor] of saved) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
});

test("shows nothing without the desktop app's bridge, or while main answers that the browser is off", async () => {
  install(undefined);
  await render();
  expect(renderer?.toJSON()).toBeNull();
  await act(async () => renderer?.unmount());
  install(stub(async () => null));
  await render();
  expect(renderer?.toJSON()).toBeNull();
});

test("follows main's changes, and keeps an off main sent over an older answer still on its way", async () => {
  let answer: (value: unknown) => void = () => {};
  const bridge = stub(() => new Promise((resolve) => { answer = resolve; }));
  install(bridge);
  await render();
  await act(async () => { bridge.tell(null); });
  await act(async () => { answer(view); });
  expect(renderer?.toJSON()).toBeNull();
  await act(async () => { bridge.tell(view); });
  expect(renderer?.root.findAllByProps({ className: "browser-side-card" })).toHaveLength(1);
});

test("lists agent tabs only, opens one large from its card, closes one with x and shows a kept file in its folder", async () => {
  opened.length = 0;
  const bridge = stub(async () => view);
  install(bridge);
  await render();
  const cards = renderer!.root.findAllByProps({ className: "browser-side-card" });
  expect(cards.map((card) => card.props["aria-label"])).toEqual(["Agent tab"]);
  expect(cards[0]!.findByProps({ className: "browser-side-card-who" }).children.join("")).toContain("Claude Code");
  await act(async () => { cards[0]!.findByProps({ className: "browser-side-card-open" }).props.onClick(); });
  expect(opened).toEqual([2]);
  await act(async () => { cards[0]!.findByProps({ "aria-label": "Close tab" }).props.onClick(); });
  expect(bridge.close).toHaveBeenCalledWith(2);
  await act(async () => { renderer!.root.findByProps({ className: "browser-side-result" }).props.onClick(); });
  expect(bridge.reveal).toHaveBeenCalledWith("r1");
});

test("takes a card's picture again every few seconds while it is shown, and stops once it is gone", async () => {
  pictures = 0;
  install(stub(async () => view));
  await render();
  const first = pictures;
  await act(async () => { jest.advanceTimersByTime(8_000); });
  expect(pictures).toBe(first + 2);
  await act(async () => renderer?.unmount());
  renderer = undefined;
  await act(async () => { jest.advanceTimersByTime(8_000); });
  expect(pictures).toBe(first + 2);
});

test("drops a card's picture once three in a row do not come", async () => {
  const bridge = stub(async () => view);
  let answer: string | null = "data:image/jpeg;base64,AAAA";
  bridge.thumbnail = async () => answer;
  install(bridge);
  await render();
  const card = () => renderer!.root.findByProps({ className: "browser-side-card-shot" });
  expect(card().findAllByType("img")).toHaveLength(1);
  answer = null;
  await act(async () => { jest.advanceTimersByTime(8_000); });
  expect(card().findAllByType("img")).toHaveLength(1);
  await act(async () => { jest.advanceTimersByTime(4_000); });
  expect(card().findAllByType("img")).toHaveLength(0);
});

test("takes no card picture while the app is hidden", async () => {
  pictures = 0;
  install(stub(async () => view));
  (globalThis.document as unknown as { visibilityState: string }).visibilityState = "hidden";
  await render();
  await act(async () => { jest.advanceTimersByTime(8_000); });
  expect(pictures).toBe(0);
});

test("asks a Claude pane for its pages once per status, never again while the answer is empty", async () => {
  const fetch = jest.spyOn(globalThis, "fetch").mockImplementation(Object.assign(async () => Response.json({ artifacts: [] }), globalThis.fetch));
  install(stub(async () => view));
  await render({ id: "w1:p1", agent: "claude", status: "working" });
  // the cards' picture timer runs on; the pages are still asked for once, however long the panel stays
  await act(async () => { jest.advanceTimersByTime(600_000); });
  expect(fetch).toHaveBeenCalledTimes(1);
});

test("asks no pages for a pane that does not run Claude Code", async () => {
  const fetch = jest.spyOn(globalThis, "fetch").mockImplementation(Object.assign(async () => Response.json({ artifacts: [] }), globalThis.fetch));
  install(stub(async () => view));
  await render({ id: "w1:p2", agent: "codex", status: "working" });
  expect(fetch).not.toHaveBeenCalled();
});
