import { afterEach, beforeEach, expect, jest, spyOn, test } from "bun:test";
import { createElement } from "react";
import { openPage, type Page } from "../lib/page.fixture.ts";

import { RepoDiffViewer } from "./RepoDiffViewer.tsx";
import type { RepoDiffTarget } from "../lib/repoDiff.ts";
import { SettingsProvider } from "../lib/settings.ts";

let page: Page;
const browserGlobals = ["HTMLElement"] as const;
const savedBrowserGlobals = new Map(browserGlobals.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));

const onPc = (machineId: string): RepoDiffTarget => ({ machineId, paneId: "w1:p1", directory: "/repo", scope: "workspace", base: null, head: null, comparison: null, path: "src/app.ts", oldPath: null });
const draftKey = (target: RepoDiffTarget): string => `ovis:diff-note-target:${[target.machineId, target.paneId, target.directory, target.scope, "", "", target.path].join("\n")}`;

beforeEach(() => {
  page = openPage();
  for (const key of browserGlobals) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value: page.window[key] });
  spyOn(globalThis, "fetch").mockImplementation(Object.assign(() => new Promise<Response>(() => {}), globalThis.fetch));
});

afterEach(async () => {
  await page.close();
  for (const [key, descriptor] of savedBrowserGlobals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
  jest.restoreAllMocks();
});

const viewer = (target: RepoDiffTarget) => createElement(SettingsProvider, {
  children: createElement(RepoDiffViewer, { target, onClose: () => {}, onOpenFile: () => {}, note: { machine: target.machineId, blocked: null } }),
});
const noteTexts = (): string[] => [...page.container.querySelectorAll("textarea")].map((field) => field.value);

test("a same-path diff on another PC does not take the previous PC's note draft", async () => {
  const pcA = onPc("pc-a");
  const pcB = onPc("pc-b");
  const line = { side: "additions", line: 3, kind: "addition", oldLine: null, newLine: 3, text: "const a = 1;" };
  page.window.sessionStorage.setItem(draftKey(pcA), JSON.stringify({ writing: { line, quote: "> src/app.ts:3" }, text: "PC A's half-written note", open: true }));

  await page.render(viewer(pcA));
  expect(noteTexts()).toEqual(["PC A's half-written note"]);

  await page.render(viewer(pcB));
  expect(noteTexts()).toEqual([]);
  expect(page.window.sessionStorage.getItem(draftKey(pcB))).toBeNull();
  expect(page.window.sessionStorage.getItem(draftKey(pcA))).toContain("PC A's half-written note");
});
