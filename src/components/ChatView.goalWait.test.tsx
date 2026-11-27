import { afterEach, beforeEach, expect, jest, test } from "bun:test";
import { act, createElement } from "react";
import { openPage, type Page } from "../lib/page.fixture.ts";

import type { ConversationTurn } from "../../shared/protocol.ts";
import { SettingsProvider } from "../lib/settings.ts";
import { Turn } from "./ChatTurn.tsx";

const now = Date.parse("2026-10-05T00:10:00.000Z");
const waitTurn = (dueAt: string): ConversationTurn => ({
  role: "user", ts: "2026-10-05T00:00:00.000Z",
  parts: [{ kind: "goal_wait", due_at: dueAt, waiting_on: { tasks: 0, monitors: 1, terminals: 0, dags: 0, cells: 0 } }],
});
const element = (turn: ConversationTurn) => createElement(SettingsProvider, {
  children: createElement(Turn, { paneId: "p1", turn, rowKey: "r1", live: false, waiting: false, showThinking: false }),
});
const shown = (): boolean => page.container.querySelector('[class="chat-goal-wait"]') !== null;

let page: Page;
beforeEach(() => {
  page = openPage();
  jest.useFakeTimers();
  jest.setSystemTime(new Date(now));
});
afterEach(async () => {
  jest.useRealTimers();
  await page.close();
});

test("a goal's wait leaves a minute past when it continues, on its own timer", async () => {
  await page.render(element(waitTurn("2026-10-05T00:12:00.000Z")));
  expect(shown()).toBe(true);
  await act(async () => { jest.advanceTimersByTime(3 * 60_000 - 1); });
  expect(shown()).toBe(true);
  await act(async () => { jest.advanceTimersByTime(1); });
  expect(shown()).toBe(false);
});

test("a goal's wait that takes the place of a later one, already long past due, is not shown", async () => {
  await page.render(element(waitTurn("2026-10-05T01:00:00.000Z")));
  expect(shown()).toBe(true);
  jest.setSystemTime(new Date(now + 30 * 60_000));
  await page.render(element(waitTurn("2026-10-05T00:20:00.000Z")));
  expect(shown()).toBe(false);
});
