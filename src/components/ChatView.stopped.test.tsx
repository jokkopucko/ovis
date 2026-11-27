import { afterEach, beforeEach, expect, jest, test } from "bun:test";
import { createElement } from "react";
import { openPage, type Page } from "../lib/page.fixture.ts";

import type { ConversationTurn } from "../../shared/protocol.ts";
import { SettingsProvider } from "../lib/settings.ts";
import { Turn } from "./ChatTurn.tsx";

const now = Date.parse("2026-11-22T05:10:00.000Z");
const turnOf = (part: ConversationTurn["parts"][number]): ConversationTurn => ({ role: "user", ts: "2026-11-22T05:00:09.000Z", parts: [part] });
const element = (turn: ConversationTurn) => createElement(SettingsProvider, {
  children: createElement(Turn, { paneId: "p1", turn, rowKey: "r1", live: false, waiting: false, showThinking: false }),
});
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

test("a stop is a quiet line that says so, not a bubble in the person's name or a notice to open", async () => {
  await page.render(element(turnOf({ kind: "notice", text: "Stopped", source: "stopped" })));
  const lines = [...page.container.querySelectorAll('[class="chat-goal-wait chat-stopped"]')];
  expect(lines).toHaveLength(1);
  expect(lines[0]?.textContent).toStartWith("Stopped · ");
  expect([...page.container.querySelectorAll('[class*="chat-turn-user"], [class*="chat-notice"]')]).toHaveLength(0);
});

test("Claude Code's other notices still open as before", async () => {
  await page.render(element(turnOf({ kind: "notice", text: "Usage limit reached", source: "informational" })));
  expect([...page.container.querySelectorAll('[class="chat-goal-wait chat-stopped"]')]).toHaveLength(0);
  expect(page.container.querySelectorAll('[class="chat-compact chat-notice"]').length).toBeGreaterThan(0);
});
