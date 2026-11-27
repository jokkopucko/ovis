import { afterEach, beforeEach, expect, jest, test } from "bun:test";
import { act, createElement } from "react";

import { OmpBtw } from "./OmpBtw.tsx";
import { openPage, type Page } from "../lib/page.fixture.ts";
import { SettingsProvider } from "../lib/settings.ts";
import type { OmpBtwTopic } from "../../shared/protocol.ts";

let page: Page;

beforeEach(() => {
  page = openPage();
  page.window.localStorage.setItem("ovis:composer-btw", "true");
  jest.useFakeTimers();
});

afterEach(async () => {
  jest.useRealTimers();
  await page.close();
  jest.restoreAllMocks();
});

const pane = () => createElement(SettingsProvider, { children: createElement(OmpBtw, { paneId: "fixture" }) });
const answered = (topics: OmpBtwTopic[]) => jest.spyOn(globalThis, "fetch").mockImplementation(Object.assign(async () => Response.json({ topics }), globalThis.fetch));
const TOPIC: OmpBtwTopic = {
  id: "t1", title: null, question: "Which port does the dev server use?", answer: "It listens on **5173**.", status: "complete", error: null, at: "2026-10-22T04:08:06.836Z",
  follow_ups: [{ question: "And the API?", answer: "The API is on 7421.", status: "complete", error: null, at: "2026-10-22T04:08:15.925Z" }],
};
const text = (): string => page.container.textContent ?? "";
const buttons = () => [...page.container.querySelectorAll("button")];

test("shows no chip and asks for nothing while Settings leaves the Side conversations chip off", async () => {
  page.window.localStorage.removeItem("ovis:composer-btw");
  const fetch = answered([TOPIC]);
  await page.render(pane());
  expect(page.container.childNodes).toHaveLength(0);
  expect(fetch).not.toHaveBeenCalled();
  expect(jest.getTimerCount()).toBe(0);
});

test("lists the saved topics once opened, and a topic opens on its question, its answer and its follow-ups", async () => {
  answered([TOPIC]);
  await page.render(pane());
  const chip = buttons();
  expect(chip).toHaveLength(1);
  await act(async () => chip[0]!.click());
  expect(text()).toContain("Which port does the dev server use?");
  expect(text()).not.toContain("5173");

  const topic = page.container.querySelectorAll<HTMLButtonElement>('button.bg-task-open[aria-expanded="false"]');
  await act(async () => topic[0]!.click());
  expect(text()).toContain("5173");
  expect(text()).toContain("And the API?");
  expect(text()).toContain("The API is on 7421.");
});

test("says the list is as it last read when a later read fails", async () => {
  let fail = false;
  jest.spyOn(globalThis, "fetch").mockImplementation(Object.assign(async () => fail ? Response.json({ error: { code: "internal_error", message: "x" } }, { status: 500 }) : Response.json({ topics: [TOPIC] }), globalThis.fetch));
  await page.render(pane());
  await act(async () => buttons()[0]!.click());
  expect(text()).not.toContain("Couldn't refresh");
  fail = true;
  await act(async () => { jest.runOnlyPendingTimers(); });
  expect(text()).toContain("Couldn't refresh: this is the list as it last read");
  expect(text()).toContain("Which port does the dev server use?");
});

test("says some side conversations are left out when the PC capped its answer", async () => {
  jest.spyOn(globalThis, "fetch").mockImplementation(Object.assign(async () => Response.json({ topics: [TOPIC], more: true }), globalThis.fetch));
  await page.render(pane());
  await act(async () => buttons()[0]!.click());
  expect(text()).toContain("Some side conversations are left out");
});

test("keeps the chip and its note when the PC left every topic out", async () => {
  jest.spyOn(globalThis, "fetch").mockImplementation(Object.assign(async () => Response.json({ topics: [], more: true }), globalThis.fetch));
  await page.render(pane());
  const chip = buttons();
  expect(chip).toHaveLength(1);
  await act(async () => chip[0]!.click());
  expect(text()).toContain("Some side conversations are left out");
});

test("gives up a read that never answers at its deadline and asks again", async () => {
  const fetch = jest.spyOn(globalThis, "fetch").mockImplementation(Object.assign(
    (_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")))),
    globalThis.fetch,
  ));
  await page.render(pane());
  expect(fetch).toHaveBeenCalledTimes(1);
  await act(async () => { jest.runOnlyPendingTimers(); });
  await act(async () => { jest.runOnlyPendingTimers(); });
  expect(fetch).toHaveBeenCalledTimes(2);
});

test("finds topics asked while the page was hidden at once when it shows again, without a second read while one is on its way", async () => {
  let topics: OmpBtwTopic[] = [];
  const fetch = jest.spyOn(globalThis, "fetch").mockImplementation(Object.assign(async () => Response.json({ topics }), globalThis.fetch));
  await page.render(pane());
  await act(async () => { await Promise.resolve(); });
  expect(fetch).toHaveBeenCalledTimes(1);
  Object.defineProperty(page.window.document, "visibilityState", { configurable: true, value: "hidden" });
  await act(async () => { jest.runOnlyPendingTimers(); });
  expect(fetch).toHaveBeenCalledTimes(1);
  topics = [TOPIC];
  Object.defineProperty(page.window.document, "visibilityState", { configurable: true, value: "visible" });
  await act(async () => { page.window.document.dispatchEvent(new page.window.Event("visibilitychange")); });
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(buttons()).toHaveLength(1);
  expect(jest.getTimerCount()).toBe(1);

  let answer: (response: Response) => void = () => {};
  fetch.mockImplementation(Object.assign(() => new Promise<Response>((resolve) => { answer = resolve; }), globalThis.fetch));
  await act(async () => { jest.runOnlyPendingTimers(); });
  expect(fetch).toHaveBeenCalledTimes(3);
  await act(async () => { page.window.document.dispatchEvent(new page.window.Event("visibilitychange")); });
  expect(fetch).toHaveBeenCalledTimes(3);
  await act(async () => { answer(Response.json({ topics })); });
  expect(jest.getTimerCount()).toBe(1);
});

test("finds topics asked after an empty first look, and stops asking once unmounted", async () => {
  let topics: OmpBtwTopic[] = [];
  const fetch = jest.spyOn(globalThis, "fetch").mockImplementation(Object.assign(async () => Response.json({ topics }), globalThis.fetch));
  await page.render(pane());
  expect(page.container.childNodes).toHaveLength(0);
  topics = [TOPIC];
  await act(async () => { jest.runOnlyPendingTimers(); });
  expect(buttons()).toHaveLength(1);

  await page.render(null);
  const calls = fetch.mock.calls.length;
  await act(async () => { jest.runOnlyPendingTimers(); });
  expect(fetch.mock.calls).toHaveLength(calls);
  expect(jest.getTimerCount()).toBe(0);
});
