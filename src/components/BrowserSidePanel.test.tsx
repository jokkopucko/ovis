import { afterEach, beforeEach, expect, jest, test } from "bun:test";
import { act, createElement } from "react";
import { openPage, type Page } from "../lib/page.fixture.ts";

import { BrowserSidePanel, type BrowserSidePanelPane } from "./BrowserSidePanel.tsx";
import { useDesktopBrowser } from "../lib/desktopBrowser.ts";
import { SettingsProvider } from "../lib/settings.ts";

let page: Page;

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
  Object.defineProperty(page.window, "ovisBrowser", { configurable: true, value: bridge });
}

const opened: number[] = [];

function Harness({ pane }: { pane: BrowserSidePanelPane | null }) {
  const browser = useDesktopBrowser();
  return browser === null ? null : createElement(BrowserSidePanel, { browser, pane, agentOf: (paneId: string) => paneId === "w1:p1" ? "claude" : null, onOpen: (tab: number) => opened.push(tab) });
}

const render = async (pane: BrowserSidePanelPane | null = null) => {
  await page.render(createElement(SettingsProvider, { children: createElement(Harness, { pane }) }));
};

const view = {
  tabs: [
    { id: 1, profile: "mine", address: "https://mine.example/", title: "Mine", loading: false, held: false },
    { id: 2, profile: "agent", address: "https://agent.example/", title: "Agent tab", loading: false, held: false, owner: "w1:p1" },
  ],
  results: [{ id: "r1", kind: "download", name: "report.pdf", at: 1_700_000_000_000, bytes: 10, done: true, tab: 2, profile: "agent" }],
};

beforeEach(() => {
  page = openPage();
  jest.useFakeTimers();
});

afterEach(async () => {
  jest.useRealTimers();
  await page.close();
  jest.restoreAllMocks();
});

test("shows nothing without the desktop app's bridge, or while main answers that the browser is off", async () => {
  install(undefined);
  await render();
  expect(page.container.childNodes).toHaveLength(0);
  await page.render(null);
  install(stub(async () => null));
  await render();
  expect(page.container.childNodes).toHaveLength(0);
});

test("follows main's changes, and keeps an off main sent over an older answer still on its way", async () => {
  let answer: (value: unknown) => void = () => {};
  const bridge = stub(() => new Promise((resolve) => { answer = resolve; }));
  install(bridge);
  await render();
  await act(async () => { bridge.tell(null); });
  await act(async () => { answer(view); });
  expect(page.container.childNodes).toHaveLength(0);
  await act(async () => { bridge.tell(view); });
  expect([...page.container.querySelectorAll('[class="browser-side-card"]')]).toHaveLength(1);
});

test("lists agent tabs only, opens one large from its card, closes one with x and shows a kept file in its folder", async () => {
  opened.length = 0;
  const bridge = stub(async () => view);
  install(bridge);
  await render();
  const cards = [...page.container.querySelectorAll('[class="browser-side-card"]')];
  expect(cards.map((card) => card.getAttribute("aria-label"))).toEqual(["Agent tab"]);
  expect(page.one('[class="browser-side-card"] [class="browser-side-card-who"]').textContent).toContain("Claude Code");
  await act(async () => { page.one('[class="browser-side-card"] [class="browser-side-card-open"]').click(); });
  expect(opened).toEqual([2]);
  await act(async () => { page.one('[class="browser-side-card"] [aria-label="Close tab"]').click(); });
  expect(bridge.close).toHaveBeenCalledWith(2);
  await act(async () => { page.one('[class="browser-side-result"]').click(); });
  expect(bridge.reveal).toHaveBeenCalledWith("r1");
});

test("takes a card's picture again every few seconds while it is shown, and stops once it is gone", async () => {
  pictures = 0;
  install(stub(async () => view));
  await render();
  const first = pictures;
  await act(async () => { jest.advanceTimersByTime(8_000); });
  expect(pictures).toBe(first + 2);
  await page.render(null);
  await act(async () => { jest.advanceTimersByTime(8_000); });
  expect(pictures).toBe(first + 2);
});

test("drops a card's picture once three in a row do not come", async () => {
  const bridge = stub(async () => view);
  let answer: string | null = "data:image/jpeg;base64,AAAA";
  bridge.thumbnail = async () => answer;
  install(bridge);
  await render();
  const card = () => page.one('[class="browser-side-card-shot"]');
  expect(card().querySelectorAll("img")).toHaveLength(1);
  answer = null;
  await act(async () => { jest.advanceTimersByTime(8_000); });
  expect(card().querySelectorAll("img")).toHaveLength(1);
  await act(async () => { jest.advanceTimersByTime(4_000); });
  expect(card().querySelectorAll("img")).toHaveLength(0);
});

test("takes no card picture while the app is hidden", async () => {
  pictures = 0;
  install(stub(async () => view));
  Object.defineProperty(page.window.document, "visibilityState", { configurable: true, value: "hidden" });
  await render();
  await act(async () => { jest.advanceTimersByTime(8_000); });
  expect(pictures).toBe(0);
});

test("takes a card's picture at once when the app shows again", async () => {
  pictures = 0;
  install(stub(async () => view));
  Object.defineProperty(page.window.document, "visibilityState", { configurable: true, value: "hidden" });
  await render();
  expect(pictures).toBe(0);
  Object.defineProperty(page.window.document, "visibilityState", { configurable: true, value: "visible" });
  await act(async () => { page.window.document.dispatchEvent(new page.window.Event("visibilitychange")); });
  expect(pictures).toBe(1);
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
