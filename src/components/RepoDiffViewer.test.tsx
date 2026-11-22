import { afterEach, beforeEach, expect, jest, spyOn, test } from "bun:test";
import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";

import { RepoDiffViewer } from "./RepoDiffViewer.tsx";
import type { RepoDiffTarget } from "../lib/repoDiff.ts";
import { SettingsProvider } from "../lib/settings.ts";

const globals = ["IS_REACT_ACT_ENVIRONMENT", "window", "document", "getComputedStyle", "navigator", "HTMLElement"];
const saved = new Map(globals.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
let renderer: ReactTestRenderer | undefined;
let session: Map<string, string>;

const onPc = (machineId: string): RepoDiffTarget => ({ machineId, paneId: "w1:p1", directory: "/repo", scope: "workspace", base: null, head: null, comparison: null, path: "src/app.ts", oldPath: null });
const draftKey = (target: RepoDiffTarget): string => `ovis:diff-note-target:${[target.machineId, target.paneId, target.directory, target.scope, "", "", target.path].join("\n")}`;

beforeEach(() => {
  const listen = { addEventListener() {}, removeEventListener() {} };
  const style = { setProperty() {}, removeProperty() {}, getPropertyValue: () => "", backgroundColor: "" };
  session = new Map();
  const sessionStorage = { getItem: (key: string) => session.get(key) ?? null, setItem: (key: string, value: string) => { session.set(key, value); }, removeItem: (key: string) => { session.delete(key); } };
  Object.assign(globalThis, {
    IS_REACT_ACT_ENVIRONMENT: true,
    HTMLElement: class HTMLElement {},
    window: { ...listen, setTimeout, clearTimeout, sessionStorage, localStorage: { getItem: () => null, setItem() {} }, matchMedia: () => ({ ...listen, matches: false }) },
    document: { ...listen, documentElement: { lang: "", dataset: {}, style }, querySelector: () => null, activeElement: null },
    getComputedStyle: () => style,
    navigator: { languages: ["en"] },
  });
  spyOn(globalThis, "fetch").mockImplementation(Object.assign(() => new Promise<Response>(() => {}), globalThis.fetch));
});

afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
  jest.restoreAllMocks();
  for (const [name, descriptor] of saved) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
});

const viewer = (target: RepoDiffTarget) => createElement(SettingsProvider, {
  children: createElement(RepoDiffViewer, { target, onClose: () => {}, onOpenFile: () => {}, note: { machine: target.machineId, blocked: null } }),
});
const noteTexts = (): unknown[] => renderer!.root.findAll((node) => node.type === "textarea").map((field) => field.props.value);

test("a same-path diff on another PC does not take the previous PC's note draft", async () => {
  const pcA = onPc("pc-a");
  const pcB = onPc("pc-b");
  const line = { side: "additions", line: 3, kind: "addition", oldLine: null, newLine: 3, text: "const a = 1;" };
  session.set(draftKey(pcA), JSON.stringify({ writing: { line, quote: "> src/app.ts:3" }, text: "PC A's half-written note", open: true }));

  await act(async () => { renderer = create(viewer(pcA)); });
  expect(noteTexts()).toEqual(["PC A's half-written note"]);

  await act(async () => { renderer!.update(viewer(pcB)); });
  expect(noteTexts()).toEqual([]);
  expect(session.has(draftKey(pcB))).toBe(false);
  expect(session.get(draftKey(pcA))).toContain("PC A's half-written note");
});
