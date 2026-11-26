import { afterEach, beforeEach, expect, jest, test } from "bun:test";
import { act, createElement, useRef } from "react";

import { openPage, type Page } from "./page.fixture.ts";
import { usePageFocusGuard } from "./usePageFocusGuard.ts";

let page: Page;
let savedHTMLElement: PropertyDescriptor | undefined;
let grabs = 0;
let shield = false;

function Guard() {
  const ref = useRef<HTMLIFrameElement>(null);
  shield = usePageFocusGuard(ref, true, () => { grabs += 1; }).shield;
  return [
    createElement("input", { key: "field" }),
    createElement("button", { key: "other" }, "Other control"),
    createElement("iframe", { key: "frame", ref }),
  ];
}

beforeEach(async () => {
  page = openPage();
  savedHTMLElement = Object.getOwnPropertyDescriptor(globalThis, "HTMLElement");
  Object.defineProperty(globalThis, "HTMLElement", { configurable: true, value: page.window.HTMLElement });
  Object.defineProperty(page.window.document, "hasFocus", { configurable: true, value: () => true });
  grabs = 0;
  jest.useFakeTimers();
  await page.render(createElement(Guard));
  await focusField();
});

afterEach(async () => {
  await page.render(null);
  jest.runOnlyPendingTimers();
  jest.useRealTimers();
  await page.close();
  if (savedHTMLElement) Object.defineProperty(globalThis, "HTMLElement", savedHTMLElement);
  else Reflect.deleteProperty(globalThis, "HTMLElement");
});

const field = () => page.one<HTMLInputElement>("input");
const focusField = () => act(async () => { field().focus(); });
/** The frame has the focus and the window lost it: what a browser reports when the focus goes into a page. */
const intoPage = () => act(async () => {
  page.one<HTMLIFrameElement>("iframe").focus();
  page.window.dispatchEvent(new page.window.Event("blur"));
});
const tab = (handled = false) => act(async () => {
  const event = new page.window.KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
  if (handled) event.preventDefault();
  page.window.dispatchEvent(event);
});

test("a page that takes the focus by itself loses its scripts, and the focus goes back", async () => {
  expect(shield).toBe(true);
  await intoPage();
  expect(grabs).toBe(1);
  expect(document.activeElement).toBe(field());
});

test("a Tab from the control before the page puts the focus in it", async () => {
  await tab();
  await intoPage();
  expect(grabs).toBe(0);
  expect(shield).toBe(false);
});

test("a Tab the terminal kept for itself does not let the page take the focus", async () => {
  await act(async () => {
    const input = page.window.document.querySelector("input");
    if (!input) throw new Error("Expected input");
    input.addEventListener("keydown", (event) => event.stopPropagation(), { once: true });
    input.dispatchEvent(new page.window.KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }));
  });
  await intoPage();
  expect(grabs).toBe(1);
});

test("a Tab the app handled does not let the page take the focus", async () => {
  await tab(true);
  await intoPage();
  expect(grabs).toBe(1);
});

test("a Tab that moved the focus inside the app does not let the page take it next", async () => {
  await tab();
  await act(async () => { page.one<HTMLButtonElement>("button").focus(); });
  await intoPage();
  expect(grabs).toBe(1);
});

test("one Tab lets the focus in once", async () => {
  await tab();
  await intoPage();
  await focusField();
  await intoPage();
  expect(grabs).toBe(1);
});
