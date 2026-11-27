import { afterEach, beforeEach, expect, test } from "bun:test";
import { act, createElement } from "react";
import { openPage, type Page } from "../lib/page.fixture.ts";

import { TextFileEditor } from "./TextFileEditor.tsx";
import type { EditableText } from "../../shared/files.ts";
import { SettingsProvider } from "../lib/settings.ts";
import { nativeTransport, setTransport } from "../lib/transport.ts";

let page: Page;

beforeEach(() => {
  page = openPage();
});

afterEach(async () => {
  await page.close();
  setTransport(nativeTransport);
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

async function render(done: (saved: boolean) => void): Promise<HTMLElement> {
  await page.render(createElement(SettingsProvider, { children: createElement(TextFileEditor, { path: "notes.md", paneId: "w1:p1", name: "notes.md", onDone: done, onChanged() {} }) }));
  await settle();
  return page.container;
}

async function settle(): Promise<void> {
  const shown = () => page.container.innerHTML;
  for (let previous = "", round = 0; previous !== shown() && round < 50; round++) {
    previous = shown();
    await act(async () => { await Promise.resolve(); });
  }
}

const button = (root: HTMLElement, label: string) => [...root.querySelectorAll("button")].find((node) => [...node.childNodes].some((child) => child.nodeType === 3 && child.textContent === label))!;
const text = (root: HTMLElement) => root.textContent ?? "";
const asksBeforeUnload = () => {
  const event = new page.window.Event("beforeunload", { cancelable: true });
  page.window.dispatchEvent(event);
  return event.defaultPrevented;
};
async function type(value: string): Promise<void> {
  await page.type(page.one<HTMLTextAreaElement>("textarea"), value);
}
async function press(root: HTMLElement, label: string): Promise<void> {
  await act(async () => button(root, label).click());
  await settle();
}

test("saves only after the second Save, over the revision it opened", async () => {
  const seen = pc([Response.json(opened("# Notes\n", "r1"))], () => Response.json({ path: "/work/notes.md", revision: "r2", size: 14, modified: "2026-11-05T00:00:01.000Z" }));
  const done: boolean[] = [];
  const root = await render((saved) => done.push(saved));
  expect(page.one<HTMLTextAreaElement>("textarea").value).toBe("# Notes\n");
  expect(button(root, "Save").disabled).toBe(true);
  await type("# Notes\nDone.\n");
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
  await type("kept draft\n");
  await page.render(null);
  root = await render((saved) => done.push(saved));
  expect(seen.reads).toBe(1);
  expect(page.one<HTMLTextAreaElement>("textarea").value).toBe("kept draft\n");
  expect(text(root)).toContain("Unsaved changes");
  await press(root, "Cancel");
  await page.render(null);
  root = await render(() => {});
  expect(seen.reads).toBe(2);
  expect(page.one<HTMLTextAreaElement>("textarea").value).toBe("a\n");
});

test("a save answering after its editor was closed leaves a draft typed since alone, and the page asks before a reload while one is kept", async () => {
  let answer: (response: Response) => void = () => {};
  const seen = { reads: 0 };
  setTransport({ ...nativeTransport, fetch: async (_input, init) => {
    if (init?.method === "PUT") return new Promise<Response>((resolve) => { answer = resolve; });
    seen.reads += 1;
    return Response.json(opened("a\n", "r1"));
  } });
  let root = await render(() => {});
  await type("first\n");
  await press(root, "Save");
  await act(async () => button(root, "Save").click());
  await page.render(null);
  expect(asksBeforeUnload()).toBe(true);
  root = await render(() => {});
  await type("second\n");
  await page.render(null);
  await act(async () => { answer(Response.json({ path: "/work/notes.md", revision: "r2", size: 6, modified: "2026-11-05T00:00:01.000Z" })); });
  await settle();
  root = await render(() => {});
  expect(page.one<HTMLTextAreaElement>("textarea").value).toBe("second\n");
  await press(root, "Cancel");
  expect(asksBeforeUnload()).toBe(false);
});

test("a save answering late leaves the draft of an editor opened again meanwhile", async () => {
  let answer: (response: Response) => void = () => {};
  setTransport({ ...nativeTransport, fetch: async (_input, init) => {
    if (init?.method === "PUT") return new Promise<Response>((resolve) => { answer = resolve; });
    return Response.json(opened("a\n", "r1"));
  } });
  let root = await render(() => {});
  await type("only copy\n");
  await press(root, "Save");
  await act(async () => button(root, "Save").click());
  await page.render(null);
  root = await render(() => {});
  expect(page.one<HTMLTextAreaElement>("textarea").value).toBe("only copy\n");
  await act(async () => { answer(Response.json({ path: "/work/notes.md", revision: "r2", size: 10, modified: "2026-11-05T00:00:01.000Z" })); });
  await settle();
  expect(asksBeforeUnload()).toBe(true);
  await page.render(null);
  root = await render(() => {});
  expect(page.one<HTMLTextAreaElement>("textarea").value).toBe("only copy\n");
  await press(root, "Cancel");
});

test("Cancel leaves without saving", async () => {
  const seen = pc([Response.json(opened("a\n", "r1"))], () => Response.json({}));
  const done: boolean[] = [];
  const root = await render((saved) => done.push(saved));
  await type("b\n");
  await press(root, "Cancel");
  expect(seen.sent).toEqual([]);
  expect(done).toEqual([false]);
});

test("a file changed meanwhile keeps the typed text to copy, and Reload file shows the file as it is now", async () => {
  const seen = pc([Response.json(opened("v1\n", "r1")), Response.json(opened("agent's v2\n", "r2"))],
    () => Response.json({ error: { code: "stale_revision", message: "changed", revision: "r2" } }, { status: 409 }));
  const done: boolean[] = [];
  const root = await render((saved) => done.push(saved));
  await type("mine\n");
  await press(root, "Save");
  await press(root, "Save");
  expect(text(root)).toContain("your changes were not saved");
  expect(page.one<HTMLTextAreaElement>("textarea").value).toBe("mine\n");
  expect(done).toEqual([]);
  await press(root, "Reload file");
  expect(seen.reads).toBe(2);
  expect(page.one<HTMLTextAreaElement>("textarea").value).toBe("agent's v2\n");
});

test("a file the PC will not open for editing says why, with no text box", async () => {
  pc([Response.json({ error: { code: "mixed_line_endings", message: "mixed" } }, { status: 415 })], () => Response.json({}));
  const root = await render(() => {});
  expect(text(root)).toContain("This file mixes line endings. Edit it in the terminal.");
  expect([...root.querySelectorAll("textarea")]).toEqual([]);
});
