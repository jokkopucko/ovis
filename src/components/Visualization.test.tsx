import { afterEach, beforeEach, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";

import { Visualization } from "./Visualization.tsx";
import { OpenFileContext } from "../lib/filePaths.ts";
import { SettingsProvider } from "../lib/settings.ts";
import { nativeTransport, setTransport, type Transport } from "../lib/transport.ts";

const globals = ["IS_REACT_ACT_ENVIRONMENT", "window", "document", "getComputedStyle", "navigator"];
const saved = new Map(globals.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
let renderer: ReactTestRenderer | undefined;
/** every request the card makes of the PC, by either way a component can ask: there must be none */
let asked: string[] = [];

beforeEach(() => {
  const listen = { addEventListener() {}, removeEventListener() {} };
  const style = { setProperty() {}, removeProperty() {}, getPropertyValue: () => "", backgroundColor: "" };
  Object.assign(globalThis, {
    IS_REACT_ACT_ENVIRONMENT: true,
    window: { ...listen, location: { pathname: "/", href: "https://ovis.test/" }, requestAnimationFrame: () => 0, cancelAnimationFrame() {}, localStorage: { getItem: () => null, setItem() {} }, matchMedia: () => ({ ...listen, matches: false }) },
    document: { ...listen, activeElement: null, documentElement: { lang: "", dataset: {}, style }, querySelector: () => null },
    getComputedStyle: () => style,
    navigator: { languages: ["en"] },
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
  await act(async () => renderer?.unmount());
  renderer = undefined;
  setTransport(nativeTransport);
  for (const [name, descriptor] of saved) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
});

const PATH = "/w/out/before after.html";
const buttons = (): ReactTestInstance[] => renderer?.root.findAllByType("button") ?? [];
const text = (): string => JSON.stringify(renderer?.toJSON());
/** a few turns, for anything the card might have started by itself */
const settle = async (): Promise<void> => { for (let round = 0; round < 20; round++) await act(async () => { await new Promise<void>((resolve) => setTimeout(resolve, 0)); }); };

test("a reference's card asks the PC for nothing and draws no frame; Open preview opens the file viewer on exactly that path, through its own pane's opener", async () => {
  // Given a reference in an answer of a pane on one PC, inside an app that also shows another PC
  const here: string[] = [], elsewhere: string[] = [];
  await act(async () => {
    renderer = create(createElement(SettingsProvider, { children:
      createElement(OpenFileContext.Provider, { value: (path) => { elsewhere.push(path); }, children:
        createElement(OpenFileContext.Provider, { value: (path) => { here.push(path); }, children:
          createElement(Visualization, { path: PATH, title: "Transmission comparison" }) }) }) }));
  });
  await settle();
  // Then the card names the file, with the reference's title under it, and has the one button
  expect(text()).toContain("before after.html");
  expect(text()).toContain("Transmission comparison");
  expect(buttons().map((button) => button.children)).toEqual([["Open preview"]]);
  // the button says which file it opens: its description is the card's name, and only that
  const described = String(buttons()[0]!.props["aria-describedby"]);
  expect(renderer!.root.findAll((node) => node.props["id"] === described && typeof node.type === "string").map((node) => node.children)).toEqual([["before after.html"]]);
  // between the name and the title sits a break the page does not draw: a copy keeps the two apart
  const row = renderer!.root.findByProps({ className: "markdown-visualization-text" });
  expect(row.children.map((child) => typeof child === "string" ? child : `${String(child.type)}${child.props["hidden"] ? "[hidden]" : ""}`)).toEqual(["span", "br[hidden]", "span"]);
  // and nothing was looked up, read or framed
  expect(asked).toEqual([]);
  expect(renderer?.root.findAllByType("iframe")).toHaveLength(0);

  // When the person presses it
  await act(async () => { (buttons()[0]!.props["onClick"] as () => void)(); });
  await settle();
  // Then the pane's own opener gets exactly that path (it knows the pane and its PC), once, and the card still asked for nothing
  expect(here).toEqual([PATH]);
  expect(elsewhere).toEqual([]);
  expect(asked).toEqual([]);
  expect(renderer?.root.findAllByType("iframe")).toHaveLength(0);
});

test("where nothing can open a file, the card names it and offers no button", async () => {
  await act(async () => { renderer = create(createElement(SettingsProvider, { children: createElement(Visualization, { path: PATH }) })); });
  await settle();
  expect(text()).toContain("before after.html");
  expect(buttons()).toHaveLength(0);
  expect(asked).toEqual([]);
});

test("the card shows the file's own name, never the reference's title in its place, with what hides or reorders text taken out", async () => {
  // a title that pretends to be another file, and a name with a right-to-left override in it
  const path = "/w/report\u202Efdp.html", title = "\u202Einvoice.pdf";
  await act(async () => { renderer = create(createElement(SettingsProvider, { children: createElement(OpenFileContext.Provider, { value: () => {}, children: createElement(Visualization, { path, title }) }) })); });
  const name = renderer!.root.findByProps({ className: "markdown-visualization-name" });
  const second = renderer!.root.findByProps({ className: "markdown-visualization-title" });
  expect(name.children).toEqual(["reportfdp.html"]);
  expect(second.children).toEqual(["invoice.pdf"]);
});

test("only a chat answer's Markdown asks for references to be drawn", () => {
  // every other Markdown (prompt cards, task results, release notes, the file viewer's Preview) keeps a reference as text
  const src = join(import.meta.dir, "..");
  const asking = (readdirSync(src, { recursive: true }) as string[]).filter((file) => /\.tsx?$/.test(file) && !/\.test\.tsx?$/.test(file))
    .flatMap((file) => readFileSync(join(src, file), "utf8").split("\n").filter((line) => /<Markdown\b[^>]*\bvisualizations\b/.test(line)).map((line) => [file, line.trim()] as const));
  expect(asking.map(([file]) => file)).toEqual([join("components", "ChatView.tsx")]);
  expect(asking[0]![1]).toStartWith("? <Markdown key={`answer:");
});
