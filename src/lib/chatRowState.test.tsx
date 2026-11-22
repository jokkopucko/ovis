import { afterEach, beforeEach, expect, test } from "bun:test";
import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";

import { ChatDetails } from "./chatRowState.tsx";

let renderer: ReactTestRenderer | undefined;
let saved: PropertyDescriptor | undefined;
beforeEach(() => {
  saved = Object.getOwnPropertyDescriptor(globalThis, "IS_REACT_ACT_ENVIRONMENT");
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, writable: true, value: true });
});
afterEach(() => {
  act(() => renderer?.unmount());
  renderer = undefined;
  if (saved) Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", saved);
  else Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
});

const row = (defaultOpen: boolean) => createElement(ChatDetails, { memoryKey: "failed:0", defaultOpen }, createElement("summary", null, "Request failed"));
const details = () => renderer!.root.findByType("details");
/** the toggle event a <details> fires, as the browser fires it: after its open attribute changed */
const toggled = (open: boolean) => act(() => details().props.onToggle({ currentTarget: { open } }));

test("follows its default until the reader opens or closes it: a failure the turn went on from folds again", () => {
  act(() => { renderer = create(row(true)); });
  expect(details().props.open).toBe(true);
  toggled(true);
  act(() => renderer!.update(row(false)));
  expect(details().props.open).toBe(false);
});

test("keeps what the reader chose, whatever the default says after", () => {
  act(() => { renderer = create(row(false)); });
  toggled(true);
  expect(details().props.open).toBe(true);
  act(() => renderer!.update(row(false)));
  expect(details().props.open).toBe(true);
  toggled(false);
  act(() => renderer!.update(row(true)));
  expect(details().props.open).toBe(false);
});
