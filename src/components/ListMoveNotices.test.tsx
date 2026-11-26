import { afterEach, beforeEach, expect, it } from "bun:test";
import { act, createElement } from "react";
import { openPage, type Page } from "../lib/page.fixture.ts";

import { listView } from "../../shared/account-list.ts";
import { moved } from "../lib/account/listMigrate.test-helpers.ts";
import { SettingsProvider } from "../lib/settings.ts";

import { ListMoveNotices } from "./ListMoveNotice.tsx";

const button = (scope: Element, label: string) => {
  const found = [...scope.querySelectorAll("button")].find((node) => node.textContent === label);
  if (!found) throw new Error(`Missing button: ${label}`);
  return found;
};
let page: Page;
let savedHTMLElement: PropertyDescriptor | undefined;

/** Lets the work a press started run until `done`, for ten seconds at most. */
async function waitFor(done: () => boolean): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!done()) {
    if (Date.now() > deadline) throw new Error("what the press started did not end");
    await act(async () => { await new Promise<void>((resolve) => setImmediate(resolve)); });
  }
}

beforeEach(() => {
  page = openPage("https://app.example/");
  savedHTMLElement = Object.getOwnPropertyDescriptor(globalThis, "HTMLElement");
  Object.defineProperty(globalThis, "HTMLElement", { configurable: true, value: page.window.HTMLElement });
  Object.defineProperty(page.window.navigator, "languages", { configurable: true, value: ["en"] });
});

afterEach(async () => {
  await page.close();
  if (savedHTMLElement) Object.defineProperty(globalThis, "HTMLElement", savedHTMLElement);
  else Reflect.deleteProperty(globalThis, "HTMLElement");
});

it("Not me on a device the move carried in asks the devices list's Remove with everything ticked, and signs its removal", async () => {
  const { phone, laptop, world } = await moved();
  await page.render(createElement(SettingsProvider, { children: createElement(ListMoveNotices, { list: phone.device.list }) }));
  const root = document.body;
  await waitFor(() => root.querySelectorAll('[data-testid="list-move-notice"]').length > 0);
  const row = [...root.querySelectorAll("li")].filter((node) => node.textContent?.startsWith("Laptop"));
  expect(row).toHaveLength(1);
  await act(async () => { button(row[0]!, "Not me").click(); });
  const dialog = [...root.querySelectorAll('[role="alertdialog"]')].find((node) => node.textContent?.includes("Remove Laptop from your account?"));
  if (!dialog) throw new Error("Missing the Remove Laptop confirmation");
  expect([...dialog.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].every((box) => box.checked)).toBe(true);
  await act(async () => { button(dialog, "Remove").click(); });
  await waitFor(() => ![...root.querySelectorAll('[role="alertdialog"]')].some((node) => node.textContent?.includes("Remove Laptop")));
  expect(listView(world.held().state).devices.find((device) => device.key === laptop.signIn)?.ended).not.toBeNull();
});
