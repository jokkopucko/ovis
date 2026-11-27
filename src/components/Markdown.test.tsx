import { afterEach, beforeEach, expect, jest, test } from "bun:test";
import { act, createElement } from "react";

import { openPage, type Page } from "../lib/page.fixture.ts";

import { parseMarkdown } from "../../shared/markdown.ts";
import { SettingsProvider } from "../lib/settings.ts";
import { PREVIEW_CHUNK_ELEMENTS } from "../lib/textPreview.ts";
import { ProgressiveMarkdown } from "./Markdown.tsx";

let page: Page;

beforeEach(() => {
  page = openPage();
  Object.defineProperty(page.window.navigator, "languages", { configurable: true, value: ["en"] });
  jest.useFakeTimers();
});

afterEach(async () => {
  jest.useRealTimers();
  await page.close();
});

test("a long Markdown preview is partial until its last chunk commits with all headings", async () => {
  const headingCount = PREVIEW_CHUNK_ELEMENTS + 1;
  const blocks = parseMarkdown(Array.from({ length: headingCount }, (_, index) => `# Section ${index + 1}`).join("\n\n"));
  await page.render(createElement(SettingsProvider, { children: createElement(ProgressiveMarkdown, { blocks }) }));
  const preview = page.one("div");
  expect(preview.getAttribute("data-drawn")).toBe("partial");

  for (let step = 0; step < 10 && preview.getAttribute("data-drawn") === "partial"; step++) {
    await act(async () => { jest.runOnlyPendingTimers(); });
  }
  expect(preview.getAttribute("data-drawn")).toBe("complete");
  expect(preview.querySelectorAll('[class="markdown-h1"]')).toHaveLength(headingCount);
});
