import { afterEach, beforeEach, expect, jest, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { act, createElement } from "react";
import { openPage, type Page } from "../lib/page.fixture.ts";

import { Visualization } from "./Visualization.tsx";
import { OpenFileContext } from "../lib/filePaths.ts";
import { SettingsProvider } from "../lib/settings.ts";
import { nativeTransport, setTransport, type Transport } from "../lib/transport.ts";

let page: Page;
/** every request the card makes of the PC, by either way a component can ask: there must be none */
let asked: string[] = [];

beforeEach(() => {
  page = openPage("https://ovis.test/");
  jest.useFakeTimers();
  Object.defineProperties(page.window, {
    setTimeout: { configurable: true, value: setTimeout },
    clearTimeout: { configurable: true, value: clearTimeout },
  });
  asked = [];
  const transport: Transport = {
    ...nativeTransport,
    fetch: async (input) => { asked.push(String(input)); return Response.json({ error: { code: "unexpected", message: "the card asks the PC for nothing" } }, { status: 500 }); },
    resourceUrl: (path) => { asked.push(path); return path; },
  };
  setTransport(transport);
});

afterEach(async () => {
  jest.useRealTimers();
  try { await page.close(); } finally { setTransport(nativeTransport); }
});

const PATH = "/w/out/before after.html";
const buttons = () => [...page.container.querySelectorAll("button")];
const text = (): string => page.container.textContent ?? "";
const children = (node: Element) => [...node.childNodes].map((child) => child.nodeType === 3 ? child.textContent : child);
const drainTimers = () => act(async () => { jest.runOnlyPendingTimers(); });

test("a reference's card asks the PC for nothing and draws no frame; Open preview opens the file viewer on exactly that path, through its own pane's opener", async () => {
  const here: string[] = [], elsewhere: string[] = [];
  await page.render(createElement(SettingsProvider, { children:
      createElement(OpenFileContext.Provider, { value: (path) => { elsewhere.push(path); }, children:
        createElement(OpenFileContext.Provider, { value: (path) => { here.push(path); }, children:
          createElement(Visualization, { path: PATH, title: "Transmission comparison" }) }) }) }));
  await drainTimers();
  expect(text()).toContain("before after.html");
  expect(text()).toContain("Transmission comparison");
  expect(buttons().map(children)).toEqual([["Open preview"]]);
  const described = buttons()[0]!.getAttribute("aria-describedby");
  expect([...page.container.querySelectorAll("[id]")].filter((node) => node.id === described).map(children)).toEqual([["before after.html"]]);
  const row = page.one('[class="markdown-visualization-text"]');
  const elements = new Set<Node>([...row.children].filter((child) => child.hasAttribute("hidden")));
  expect([...row.childNodes].map((child) => child.nodeType === 3 ? child.textContent : `${child.nodeName.toLowerCase()}${elements.has(child) ? "[hidden]" : ""}`)).toEqual(["span", "br[hidden]", "span"]);
  expect(asked).toEqual([]);
  expect(page.container.querySelectorAll("iframe")).toHaveLength(0);

  await act(async () => { buttons()[0]!.click(); });
  await drainTimers();
  expect(here).toEqual([PATH]);
  expect(elsewhere).toEqual([]);
  expect(asked).toEqual([]);
  expect(page.container.querySelectorAll("iframe")).toHaveLength(0);
});

test("where nothing can open a file, the card names it and offers no button", async () => {
  await page.render(createElement(SettingsProvider, { children: createElement(Visualization, { path: PATH }) }));
  await drainTimers();
  expect(text()).toContain("before after.html");
  expect(buttons()).toHaveLength(0);
  expect(asked).toEqual([]);
});

test("the card shows the file's own name, never the reference's title in its place, with what hides or reorders text taken out", async () => {
  // a title that pretends to be another file, and a name with a right-to-left override in it
  const path = "/w/report\u202Efdp.html", title = "\u202Einvoice.pdf";
  await page.render(createElement(SettingsProvider, { children: createElement(OpenFileContext.Provider, { value: () => {}, children: createElement(Visualization, { path, title }) }) }));
  const name = page.one('[class="markdown-visualization-name"]');
  const second = page.one('[class="markdown-visualization-title"]');
  expect(children(name)).toEqual(["reportfdp.html"]);
  expect(children(second)).toEqual(["invoice.pdf"]);
});

test("only a chat answer's Markdown asks for references to be drawn", () => {
  const src = join(import.meta.dir, "..");
  const asking = (readdirSync(src, { recursive: true }) as string[]).filter((file) => /\.tsx?$/.test(file) && !/\.test\.tsx?$/.test(file))
    .flatMap((file) => readFileSync(join(src, file), "utf8").split("\n").filter((line) => /<Markdown\b[^>]*\bvisualizations\b/.test(line)).map((line) => [file, line.trim()] as const));
  expect(asking.map(([file]) => file)).toEqual([join("components", "ChatTurn.tsx")]);
  expect(asking[0]![1]).toStartWith("? <Markdown key={`answer:");
});
