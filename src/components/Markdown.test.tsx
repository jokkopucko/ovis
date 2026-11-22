import { afterEach, beforeEach, expect, jest, test } from "bun:test";
import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";

import { parseMarkdown } from "../../shared/markdown.ts";
import { SettingsProvider } from "../lib/settings.ts";
import { PREVIEW_CHUNK_ELEMENTS } from "../lib/textPreview.ts";
import { ProgressiveMarkdown } from "./Markdown.tsx";

const globals = ["IS_REACT_ACT_ENVIRONMENT", "window", "document", "getComputedStyle", "navigator"];
const saved = new Map(globals.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
let renderer: ReactTestRenderer | undefined;

beforeEach(() => {
  const listen = { addEventListener() {}, removeEventListener() {} };
  const style = { setProperty() {}, removeProperty() {}, getPropertyValue: () => "", backgroundColor: "" };
  Object.assign(globalThis, {
    IS_REACT_ACT_ENVIRONMENT: true,
    window: { ...listen, localStorage: { getItem: () => null, setItem() {} } },
    document: { documentElement: { lang: "", dataset: {}, style }, querySelector: () => null },
    getComputedStyle: () => style,
    navigator: { languages: ["en"] },
  });
  jest.useFakeTimers();
});

afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
  jest.useRealTimers();
  for (const [name, descriptor] of saved) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
});

test("a long Markdown preview is partial until its last chunk commits with all headings", async () => {
  const headingCount = PREVIEW_CHUNK_ELEMENTS + 1;
  const blocks = parseMarkdown(Array.from({ length: headingCount }, (_, index) => `# Section ${index + 1}`).join("\n\n"));
  await act(async () => {
    renderer = create(createElement(SettingsProvider, { children: createElement(ProgressiveMarkdown, { blocks }) }));
  });
  const preview = renderer?.root.findByType("div");
  expect(preview?.props["data-drawn"]).toBe("partial");

  for (let step = 0; step < 10 && preview?.props["data-drawn"] === "partial"; step++) {
    await act(async () => { jest.runOnlyPendingTimers(); });
  }
  expect(preview?.props["data-drawn"]).toBe("complete");
  expect(preview?.findAllByProps({ className: "markdown-h1" })).toHaveLength(headingCount);
});
