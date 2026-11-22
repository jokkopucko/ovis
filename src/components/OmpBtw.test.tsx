import { afterEach, beforeEach, expect, jest, test } from "bun:test";
import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";

import { OmpBtw } from "./OmpBtw.tsx";
import { SettingsProvider } from "../lib/settings.ts";
import type { OmpBtwTopic } from "../../shared/protocol.ts";

const globals = ["IS_REACT_ACT_ENVIRONMENT", "window", "document", "getComputedStyle", "navigator"];
const saved = new Map(globals.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
let renderer: ReactTestRenderer | undefined;
let stored: string | null = "true";

beforeEach(() => {
  const listen = { addEventListener() {}, removeEventListener() {} };
  const style = { setProperty() {}, removeProperty() {}, getPropertyValue: () => "", backgroundColor: "" };
  Object.assign(globalThis, {
    IS_REACT_ACT_ENVIRONMENT: true,
    window: {
      ...listen,
      localStorage: { getItem: (key: string) => (key === "ovis:composer-btw" ? stored : null), setItem() {} },
      matchMedia: () => ({ ...listen, matches: false }),
    },
    document: { ...listen, documentElement: { lang: "", dataset: {}, style }, querySelector: () => null },
    getComputedStyle: () => style,
    navigator: { languages: ["en"] },
  });
  jest.useFakeTimers();
});

afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
  jest.useRealTimers();
  jest.restoreAllMocks();
  stored = "true";
  for (const [name, descriptor] of saved) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
});

const pane = () => createElement(SettingsProvider, { children: createElement(OmpBtw, { paneId: "fixture" }) });
const answered = (topics: OmpBtwTopic[]) => jest.spyOn(globalThis, "fetch").mockImplementation(Object.assign(async () => Response.json({ topics }), globalThis.fetch));
const TOPIC: OmpBtwTopic = {
  id: "t1", title: null, question: "Which port does the dev server use?", answer: "It listens on **5173**.", status: "complete", error: null, at: "2026-10-22T04:08:06.836Z",
  follow_ups: [{ question: "And the API?", answer: "The API is on 7421.", status: "complete", error: null, at: "2026-10-22T04:08:15.925Z" }],
};
const text = (): string => JSON.stringify(renderer?.toJSON());

test("shows no chip and asks for nothing while Settings leaves the Side conversations chip off", async () => {
  stored = null;
  const fetch = answered([TOPIC]);
  await act(async () => { renderer = create(pane()); });
  expect(renderer?.toJSON()).toBeNull();
  expect(fetch).not.toHaveBeenCalled();
  expect(jest.getTimerCount()).toBe(0);
});

test("lists the saved topics once opened, and a topic opens on its question, its answer and its follow-ups", async () => {
  answered([TOPIC]);
  await act(async () => { renderer = create(pane()); });
  const chip = renderer!.root.findAllByType("button");
  expect(chip).toHaveLength(1);
  await act(async () => chip[0]!.props.onClick());
  expect(text()).toContain("Which port does the dev server use?");
  expect(text()).not.toContain("5173");

  const topic = renderer!.root.findAll((node) => node.type === "button" && node.props["aria-expanded"] === false && node.props.className === "bg-task-open");
  await act(async () => topic[0]!.props.onClick());
  expect(text()).toContain("5173");
  expect(text()).toContain("And the API?");
  expect(text()).toContain("The API is on 7421.");
});

test("says the list is as it last read when a later read fails", async () => {
  let fail = false;
  jest.spyOn(globalThis, "fetch").mockImplementation(Object.assign(async () => fail ? Response.json({ error: { code: "internal_error", message: "x" } }, { status: 500 }) : Response.json({ topics: [TOPIC] }), globalThis.fetch));
  await act(async () => { renderer = create(pane()); });
  await act(async () => renderer!.root.findAllByType("button")[0]!.props.onClick());
  expect(text()).not.toContain("Couldn't refresh");
  fail = true;
  await act(async () => { jest.runOnlyPendingTimers(); });
  expect(text()).toContain("Couldn't refresh: this is the list as it last read");
  expect(text()).toContain("Which port does the dev server use?");
});

test("says some side conversations are left out when the PC capped its answer", async () => {
  jest.spyOn(globalThis, "fetch").mockImplementation(Object.assign(async () => Response.json({ topics: [TOPIC], more: true }), globalThis.fetch));
  await act(async () => { renderer = create(pane()); });
  await act(async () => renderer!.root.findAllByType("button")[0]!.props.onClick());
  expect(text()).toContain("Some side conversations are left out");
});

test("keeps the chip and its note when the PC left every topic out", async () => {
  jest.spyOn(globalThis, "fetch").mockImplementation(Object.assign(async () => Response.json({ topics: [], more: true }), globalThis.fetch));
  await act(async () => { renderer = create(pane()); });
  const chip = renderer!.root.findAllByType("button");
  expect(chip).toHaveLength(1);
  await act(async () => chip[0]!.props.onClick());
  expect(text()).toContain("Some side conversations are left out");
});

test("gives up a read that never answers at its deadline and asks again", async () => {
  const fetch = jest.spyOn(globalThis, "fetch").mockImplementation(Object.assign(
    (_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")))),
    globalThis.fetch,
  ));
  await act(async () => { renderer = create(pane()); });
  expect(fetch).toHaveBeenCalledTimes(1);
  await act(async () => { jest.runOnlyPendingTimers(); });
  await act(async () => { jest.runOnlyPendingTimers(); });
  expect(fetch).toHaveBeenCalledTimes(2);
});

test("finds topics asked after an empty first look, and stops asking once unmounted", async () => {
  let topics: OmpBtwTopic[] = [];
  const fetch = jest.spyOn(globalThis, "fetch").mockImplementation(Object.assign(async () => Response.json({ topics }), globalThis.fetch));
  await act(async () => { renderer = create(pane()); });
  expect(renderer?.toJSON()).toBeNull();
  topics = [TOPIC];
  await act(async () => { jest.runOnlyPendingTimers(); });
  expect(renderer?.root.findAllByType("button")).toHaveLength(1);

  await act(async () => renderer?.unmount());
  renderer = undefined;
  const calls = fetch.mock.calls.length;
  await act(async () => { jest.runOnlyPendingTimers(); });
  expect(fetch.mock.calls).toHaveLength(calls);
  expect(jest.getTimerCount()).toBe(0);
});
