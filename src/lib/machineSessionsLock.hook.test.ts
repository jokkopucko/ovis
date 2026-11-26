import { afterEach, expect, it } from "bun:test";
import { createElement } from "react";
import { openPage, type Page } from "./page.fixture.ts";
import { useCloseSessionsWhenLocked } from "./useMachineRoster.ts";

function Probe({ registry, locked }: { registry: { closeAll(): void }; locked: boolean | null }) {
  useCloseSessionsWhenLocked(registry, locked);
  return null;
}

let page: Page | undefined;
afterEach(async () => {
  await page?.close();
  page = undefined;
});

it("closes the app's sockets when it signs out, and leaves them while it is signed in", async () => {
  let closed = 0;
  const registry = { closeAll: () => { closed++; } };
  page = openPage();
  await page.render(createElement(Probe, { registry, locked: null }));
  await page.render(createElement(Probe, { registry, locked: false }));
  expect(closed).toBe(0);
  await page.render(createElement(Probe, { registry, locked: true }));
  expect(closed).toBe(1);
  await page.render(createElement(Probe, { registry, locked: false }));
  expect(closed).toBe(1);
});
