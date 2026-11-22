import { afterEach, beforeEach, expect, jest, test } from "bun:test";
import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";

import type { ConversationTurn } from "../../shared/protocol.ts";
import { SettingsProvider } from "../lib/settings.ts";
import { Turn } from "./ChatView.tsx";

const now = Date.parse("2026-10-05T00:10:00.000Z");
const waitTurn = (dueAt: string): ConversationTurn => ({
  role: "user", ts: "2026-10-05T00:00:00.000Z",
  parts: [{ kind: "goal_wait", due_at: dueAt, waiting_on: { tasks: 0, monitors: 1, terminals: 0, dags: 0, cells: 0 } }],
});
const element = (turn: ConversationTurn) => createElement(SettingsProvider, {
  children: createElement(Turn, { paneId: "p1", turn, rowKey: "r1", live: false, waiting: false, showThinking: false }),
});
const shown = (renderer: ReactTestRenderer): boolean => renderer.root.findAll((node) => node.props.className === "chat-goal-wait").length > 0;

const globals = ["IS_REACT_ACT_ENVIRONMENT", "window", "document", "getComputedStyle", "navigator"];
const saved = new Map<string, PropertyDescriptor | undefined>();
let renderer: ReactTestRenderer | null = null;
beforeEach(() => {
  for (const name of globals) saved.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
  const style = { setProperty: () => {}, removeProperty: () => {}, getPropertyValue: () => "", backgroundColor: "" };
  const listen = { addEventListener: () => {}, removeEventListener: () => {} };
  const values: Record<string, unknown> = {
    IS_REACT_ACT_ENVIRONMENT: true,
    window: { ...listen, localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {}, key: () => null, length: 0 } },
    document: { ...listen, documentElement: { lang: "", dataset: {}, style }, querySelector: () => null },
    getComputedStyle: () => style,
    navigator: { languages: ["en"] },
  };
  for (const name of globals) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value: values[name] });
  jest.useFakeTimers();
  jest.setSystemTime(new Date(now));
});
afterEach(() => {
  act(() => { renderer?.unmount(); });
  renderer = null;
  jest.useRealTimers();
  for (const [name, descriptor] of saved) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
  saved.clear();
});
const mount = (turn: ConversationTurn): ReactTestRenderer => {
  act(() => { renderer = create(element(turn)); });
  return renderer!;
};

test("a goal's wait leaves a minute past when it continues, on its own timer", () => {
  const row = mount(waitTurn("2026-10-05T00:12:00.000Z"));
  expect(shown(row)).toBe(true);
  act(() => { jest.advanceTimersByTime(3 * 60_000 - 1); });
  expect(shown(row)).toBe(true);
  act(() => { jest.advanceTimersByTime(1); });
  expect(shown(row)).toBe(false);
});

test("a goal's wait that takes the place of a later one, already long past due, is not shown", () => {
  const row = mount(waitTurn("2026-10-05T01:00:00.000Z"));
  expect(shown(row)).toBe(true);
  jest.setSystemTime(new Date(now + 30 * 60_000));
  act(() => { row.update(element(waitTurn("2026-10-05T00:20:00.000Z"))); });
  expect(shown(row)).toBe(false);
});
