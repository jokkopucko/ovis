import { afterEach, beforeEach, expect, jest, test } from "bun:test";
import { act, createElement } from "react";
import { openPage, type Page } from "../lib/page.fixture.ts";

import { Artifacts } from "./Artifacts.tsx";
import { SettingsProvider } from "../lib/settings.ts";
import type { ClaudeArtifact } from "../../shared/protocol.ts";

let page: Page;

beforeEach(() => {
  page = openPage();
  page.window.localStorage.setItem("ovis:composer-artifacts", "true");
  jest.useFakeTimers();
});

const pane = () => createElement(SettingsProvider, { children: createElement(Artifacts, { paneId: "fixture", status: "done" }) });

afterEach(async () => {
  jest.useRealTimers();
  await page.close();
  jest.restoreAllMocks();
});

test("shows no chip and asks for no pages while Settings leaves the Artifacts chip off", async () => {
  page.window.localStorage.removeItem("ovis:composer-artifacts");
  const pages: ClaudeArtifact[] = [{ url: "https://claude.ai/artifact/fixture", title: "Fixture", at: null }];
  const fetch = jest.spyOn(globalThis, "fetch").mockImplementation(Object.assign(async () => Response.json({ artifacts: pages }), globalThis.fetch));
  await page.render(pane());
  expect(page.container.childNodes).toHaveLength(0);
  expect(fetch).not.toHaveBeenCalled();
  expect(jest.getTimerCount()).toBe(0);
});

test("shows the chip for a session's pages once Settings turns the Artifacts chip on", async () => {
  const pages: ClaudeArtifact[] = [{ url: "https://claude.ai/artifact/fixture", title: "Fixture", at: null }];
  jest.spyOn(globalThis, "fetch").mockImplementation(Object.assign(async () => Response.json({ artifacts: pages }), globalThis.fetch));
  await page.render(pane());
  expect(page.container.querySelectorAll("button")).toHaveLength(1);
});

test("discovers published pages after an empty initial lookup without a status change", async () => {
  let pages: ClaudeArtifact[] = [];
  jest.spyOn(globalThis, "fetch").mockImplementation(Object.assign(async () => Response.json({ artifacts: pages }), globalThis.fetch));
  await page.render(pane());
  expect(page.container.childNodes).toHaveLength(0);
  for (let attempt = 0; attempt < 4; attempt++) {
    await act(async () => { jest.runOnlyPendingTimers(); });
    expect(page.container.childNodes).toHaveLength(0);
  }

  pages = [{ url: "https://claude.ai/artifact/fixture", title: "Fixture", at: null }];
  await act(async () => { jest.runOnlyPendingTimers(); });
  expect(page.container.querySelectorAll("button")).toHaveLength(1);
  expect(jest.getTimerCount()).toBe(0);
});

test("cancels an empty lookup's scheduled refresh when unmounted", async () => {
  const fetch = jest.spyOn(globalThis, "fetch").mockImplementation(Object.assign(async () => Response.json({ artifacts: [] }), globalThis.fetch));
  const timeout = jest.spyOn(globalThis, "setTimeout");
  await page.render(pane());
  // Count the application's refresh, not ReactDOM's own scheduled work.
  expect(timeout.mock.calls.filter(([, delay]) => delay === 3000)).toHaveLength(1);
  timeout.mockRestore();
  await page.render(null);
  const calls = fetch.mock.calls.length;
  await act(async () => { jest.runOnlyPendingTimers(); });
  expect(fetch.mock.calls).toHaveLength(calls);
  expect(jest.getTimerCount()).toBe(0);
});
