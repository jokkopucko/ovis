import { afterEach, beforeEach, expect, test } from "bun:test";
import { act, createElement } from "react";

import { ChatDetails, chatRowMemory, ChatRowMemoryContext } from "./chatRowState.tsx";
import { openPage, type Page } from "./page.fixture.ts";

let page: Page;
beforeEach(() => {
  page = openPage();
});
afterEach(async () => {
  await page.close();
});

const row = (defaultOpen: boolean) => createElement(ChatDetails, { memoryKey: "failed:0", defaultOpen }, createElement("summary", null, "Request failed"));
const details = () => page.one<HTMLDetailsElement>("details");
/** the toggle event a <details> fires, as the browser fires it: after its open attribute changed */
const toggled = (open: boolean) => act(async () => {
  const node = page.window.document.querySelector("details");
  if (!node) throw new Error("Expected details");
  if (node.open === open) node.dispatchEvent(new page.window.Event("toggle"));
  else page.one("summary").click();
});

test("follows its default until the reader opens or closes it: a failure the turn went on from folds again", async () => {
  await page.render(row(true));
  expect(details().open).toBe(true);
  await toggled(true);
  await page.render(row(false));
  expect(details().open).toBe(false);
});

test("keeps what the reader chose, whatever the default says after", async () => {
  const memory = chatRowMemory(new Map(), "turn");
  const rememberedRow = (defaultOpen: boolean) => createElement(ChatRowMemoryContext.Provider, { value: memory }, row(defaultOpen));
  await page.render(rememberedRow(false));
  await toggled(true);
  expect(details().open).toBe(true);
  // A new details element cannot inherit the browser's native open state.
  await page.render(null);
  await page.render(rememberedRow(false));
  expect(details().open).toBe(true);
  await toggled(false);
  await page.render(rememberedRow(true));
  expect(details().open).toBe(false);
});
