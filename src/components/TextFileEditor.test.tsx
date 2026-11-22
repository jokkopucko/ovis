import { afterEach, beforeEach, expect, test } from "bun:test";
import { createElement } from "react";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";

import { TextFileEditor } from "./TextFileEditor.tsx";
import type { EditableText } from "../../shared/files.ts";
import { SettingsProvider } from "../lib/settings.ts";
import { nativeTransport, setTransport } from "../lib/transport.ts";

const globals = ["IS_REACT_ACT_ENVIRONMENT", "window", "document", "getComputedStyle", "navigator"];
const saved = new Map(globals.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
let renderer: ReactTestRenderer | undefined;

beforeEach(() => {
  const listen = { addEventListener() {}, removeEventListener() {} };
  const style = { setProperty() {}, removeProperty() {}, getPropertyValue: () => "", backgroundColor: "" };
  Object.assign(globalThis, {
    IS_REACT_ACT_ENVIRONMENT: true,
    window: { ...listen, location: { pathname: "/" }, requestAnimationFrame: () => 0, cancelAnimationFrame() {}, localStorage: { getItem: () => null, setItem() {} }, matchMedia: () => ({ ...listen, matches: false }) },
    document: { ...listen, activeElement: null, documentElement: { lang: "", dataset: {}, style }, querySelector: () => null },
    getComputedStyle: () => style,
    navigator: { languages: ["en"] },
  });
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

const opened = (text: string, revision: string): EditableText => ({ path: "/work/notes.md", text, revision, line_endings: "lf", size: text.length, modified: "2026-11-05T00:00:00.000Z" });

function pc(reads: Response[], put: () => Response): { sent: unknown[]; reads: number } {
  const seen = { sent: [] as unknown[], reads: 0 };
  setTransport({
    ...nativeTransport,
    fetch: async (input, init) => {
      expect(String(input)).toContain("/api/fs/text");
      if (init?.method === "PUT") { seen.sent.push(JSON.parse(String(init.body))); return put(); }
      seen.reads += 1;
      return reads.shift()!;
    },
  });
  return seen;
}

async function render(done: (saved: boolean) => void): Promise<ReactTestInstance> {
  await act(async () => {
    renderer = create(createElement(SettingsProvider, { children: createElement(TextFileEditor, { path: "notes.md", paneId: "w1:p1", name: "notes.md", onDone: done, onChanged() {} }) }));
  });
  await settle();
  return renderer!.root;
}

async function settle(): Promise<void> {
  const shown = () => JSON.stringify(renderer?.toJSON());
  for (let previous = "", round = 0; previous !== shown() && round < 50; round++) {
    previous = shown();
    await act(async () => { await Promise.resolve(); });
  }
}

const button = (root: ReactTestInstance, label: string) => root.find((node) => node.type === "button" && node.children.includes(label));
const text = (root: ReactTestInstance) => JSON.stringify(root.findAll((node) => typeof node.type === "string").map((node) => node.children.filter((child) => typeof child === "string")));
async function type(root: ReactTestInstance, value: string): Promise<void> {
  await act(async () => root.findByType("textarea").props.onChange({ target: { value } }));
}
async function press(root: ReactTestInstance, label: string): Promise<void> {
  await act(async () => button(root, label).props.onClick());
  await settle();
}

test("saves only after the second Save, over the revision it opened", async () => {
  const seen = pc([Response.json(opened("# Notes\n", "r1"))], () => Response.json({ path: "/work/notes.md", revision: "r2", size: 14, modified: "2026-11-05T00:00:01.000Z" }));
  const done: boolean[] = [];
  const root = await render((saved) => done.push(saved));
  expect(root.findByType("textarea").props.value).toBe("# Notes\n");
  expect(button(root, "Save").props.disabled).toBe(true);
  await type(root, "# Notes\nDone.\n");
  await press(root, "Save");
  expect(text(root)).toContain("Save changes to notes.md?");
  expect(seen.sent).toEqual([]);
  await press(root, "Save");
  expect(seen.sent).toEqual([{ pane_id: "w1:p1", path: "/work/notes.md", revision: "r1", text: "# Notes\nDone.\n" }]);
  expect(done).toEqual([true]);
});

test("a draft outlives the editor it was typed in until it is saved or cancelled", async () => {
  const seen = pc([Response.json(opened("a\n", "r1")), Response.json(opened("a\n", "r1"))], () => Response.json({}));
  const done: boolean[] = [];
  let root = await render((saved) => done.push(saved));
  await type(root, "kept draft\n");
  await act(async () => renderer?.unmount());
  root = await render((saved) => done.push(saved));
  expect(seen.reads).toBe(1);
  expect(root.findByType("textarea").props.value).toBe("kept draft\n");
  expect(text(root)).toContain("Unsaved changes");
  await press(root, "Cancel");
  await act(async () => renderer?.unmount());
  root = await render(() => {});
  expect(seen.reads).toBe(2);
  expect(root.findByType("textarea").props.value).toBe("a\n");
});

test("a save answering after its editor was closed leaves a draft typed since alone, and the page asks before a reload while one is kept", async () => {
  const listeners = new Set<string>();
  Object.assign(globalThis.window, { addEventListener: (type: string) => listeners.add(type), removeEventListener: (type: string) => listeners.delete(type) });
  let answer: (response: Response) => void = () => {};
  const seen = pc([Response.json(opened("a\n", "r1"))], () => { throw new Error("unused"); });
  setTransport({ ...nativeTransport, fetch: async (_input, init) => {
    if (init?.method === "PUT") return new Promise<Response>((resolve) => { answer = resolve; });
    seen.reads += 1;
    return Response.json(opened("a\n", "r1"));
  } });
  let root = await render(() => {});
  await type(root, "first\n");
  await press(root, "Save");
  await act(async () => button(root, "Save").props.onClick());
  await act(async () => renderer?.unmount());
  expect(listeners.has("beforeunload")).toBe(true);
  root = await render(() => {});
  await type(root, "second\n");
  await act(async () => renderer?.unmount());
  await act(async () => { answer(Response.json({ path: "/work/notes.md", revision: "r2", size: 6, modified: "2026-11-05T00:00:01.000Z" })); });
  await settle();
  root = await render(() => {});
  expect(root.findByType("textarea").props.value).toBe("second\n");
  await press(root, "Cancel");
  expect(listeners.has("beforeunload")).toBe(false);
});

test("a save answering late leaves the draft of an editor opened again meanwhile", async () => {
  const listeners = new Set<string>();
  Object.assign(globalThis.window, { addEventListener: (type: string) => listeners.add(type), removeEventListener: (type: string) => listeners.delete(type) });
  let answer: (response: Response) => void = () => {};
  setTransport({ ...nativeTransport, fetch: async (_input, init) => {
    if (init?.method === "PUT") return new Promise<Response>((resolve) => { answer = resolve; });
    return Response.json(opened("a\n", "r1"));
  } });
  let root = await render(() => {});
  await type(root, "only copy\n");
  await press(root, "Save");
  await act(async () => button(root, "Save").props.onClick());
  await act(async () => renderer?.unmount());
  root = await render(() => {});
  expect(root.findByType("textarea").props.value).toBe("only copy\n");
  await act(async () => { answer(Response.json({ path: "/work/notes.md", revision: "r2", size: 10, modified: "2026-11-05T00:00:01.000Z" })); });
  await settle();
  expect(listeners.has("beforeunload")).toBe(true);
  await act(async () => renderer?.unmount());
  root = await render(() => {});
  expect(root.findByType("textarea").props.value).toBe("only copy\n");
  await press(root, "Cancel");
});

test("Cancel leaves without saving", async () => {
  const seen = pc([Response.json(opened("a\n", "r1"))], () => Response.json({}));
  const done: boolean[] = [];
  const root = await render((saved) => done.push(saved));
  await type(root, "b\n");
  await press(root, "Cancel");
  expect(seen.sent).toEqual([]);
  expect(done).toEqual([false]);
});

test("a file changed meanwhile keeps the typed text to copy, and Reload file shows the file as it is now", async () => {
  const seen = pc([Response.json(opened("v1\n", "r1")), Response.json(opened("agent's v2\n", "r2"))],
    () => Response.json({ error: { code: "stale_revision", message: "changed", revision: "r2" } }, { status: 409 }));
  const done: boolean[] = [];
  const root = await render((saved) => done.push(saved));
  await type(root, "mine\n");
  await press(root, "Save");
  await press(root, "Save");
  expect(text(root)).toContain("your changes were not saved");
  expect(root.findByType("textarea").props.value).toBe("mine\n");
  expect(done).toEqual([]);
  await press(root, "Reload file");
  expect(seen.reads).toBe(2);
  expect(root.findByType("textarea").props.value).toBe("agent's v2\n");
});

test("a file the PC will not open for editing says why, with no text box", async () => {
  pc([Response.json({ error: { code: "mixed_line_endings", message: "mixed" } }, { status: 415 })], () => Response.json({}));
  const root = await render(() => {});
  expect(text(root)).toContain("This file mixes line endings. Edit it in the terminal.");
  expect(root.findAllByType("textarea")).toEqual([]);
});
