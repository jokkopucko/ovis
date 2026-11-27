import { afterEach, beforeEach, expect, it } from "bun:test";
import { act, createElement, Profiler, type ReactNode } from "react";
import { openPage, type Page } from "../lib/page.fixture.ts";

import { OpenFileContext } from "../lib/filePaths.ts";
import { FileNameLookupContext, useFileNameLookup } from "../lib/fileNameLookup.ts";
import { MachineContext } from "../lib/machineContext.tsx";
import { SettingsProvider } from "../lib/settings.ts";
import { nativeTransport, setTransport } from "../lib/transport.ts";
import { Markdown } from "./Markdown.tsx";

let page: Page;
let requests: Array<{ url: URL; finish: (body: unknown, status?: number) => void }>;
let opened: string[];
const fetchDescriptor = Object.getOwnPropertyDescriptor(globalThis, "fetch");
let panes = 0;

function ChatNames({ paneId, children }: { paneId: string; children: ReactNode }) {
  return createElement(FileNameLookupContext.Provider, { value: useFileNameLookup(paneId, "/project", 1), children });
}

async function draw(text: string, { lookup = true, pane = `w1:p${++panes}` }: { lookup?: boolean; pane?: string } = {}) {
  const markdown = createElement(Markdown, { children: text });
  const tree = createElement(SettingsProvider, { children: createElement(MachineContext.Provider, { value: "local", children:
    createElement(OpenFileContext.Provider, { value: (path: string) => { opened.push(path); }, children:
      lookup ? createElement(ChatNames, { paneId: pane, children: markdown }) : markdown }),
  }) });
  await page.render(tree);
}
const links = () => [...page.container.querySelectorAll<HTMLButtonElement>('button[class^="markdown-file"]')].map((node) => node.title);
const plainCode = () => [...page.container.querySelectorAll("code")].filter((node) => node.parentElement?.tagName !== "BUTTON").map((node) => node.textContent);
async function answer(index: number, body: unknown, status = 200) {
  await act(async () => { requests[index]!.finish(body, status); });
}

beforeEach(() => {
  page = openPage();
  requests = [];
  opened = [];
  Object.defineProperty(globalThis, "fetch", { configurable: true, value: (target: string) => new Promise<Response>((resolve) => {
    requests.push({ url: new URL(target, "http://test.local"), finish: (body, status = 200) => resolve(Response.json(body, { status })) });
  }) });
});
afterEach(async () => {
  await page.close();
  setTransport(nativeTransport);
  if (fetchDescriptor) Object.defineProperty(globalThis, "fetch", fetchDescriptor);
  else Reflect.deleteProperty(globalThis, "fetch");
});

it("draws a bare name the pane's PC has nothing of as code, and keeps the link for one it has (#2748)", async () => {
  await draw("The unit is `user-1000.slice`, see `README.md` and `src/app.ts`.", { pane: "w1:p1" });
  expect(requests.map(({ url }) => [url.pathname, url.searchParams.get("path"), url.searchParams.get("pane_id")])).toEqual([
    ["/api/fs/stat", "user-1000.slice", "w1:p1"],
    ["/api/fs/stat", "README.md", "w1:p1"],
  ]);
  expect(links()).toEqual(["Open user-1000.slice", "Open README.md", "Open src/app.ts"]);

  await answer(0, { error: { code: "not_found", message: "no readable file at that path" } }, 404);
  expect(requests[2]!.url.pathname).toBe("/api/workspace/directories");
  expect(requests[2]!.url.searchParams.get("path")).toBe("user-1000.slice");
  expect(links()).toContain("Open user-1000.slice");
  await answer(2, { error: { code: "not_a_directory", message: "not a folder" } }, 400);
  await answer(1, { error: { code: "ambiguous_path", message: "several files have that name", candidates: ["/project/a/README.md", "/project/b/README.md"] } }, 409);

  expect(links()).toEqual(["Open README.md", "Open src/app.ts"]);
  expect(plainCode()).toEqual(["user-1000.slice"]);
  const readme = page.one('button[title="Open README.md"]');
  await act(async () => { readme.click(); });
  expect(opened).toEqual(["README.md"]);
});

it("draws a name known to be nothing as code at once, without asking again", async () => {
  await draw("`foo.service`", { pane: "w1:p2" });
  await answer(0, { error: { code: "not_found", message: "no" } }, 404);
  await answer(1, { error: { code: "not_a_directory", message: "no" } }, 400);
  expect(plainCode()).toEqual(["foo.service"]);
  await page.render(createElement("div"));
  const frames: string[][] = [];
  const row = createElement(Profiler, { id: "row", onRender: () => { frames.push(plainCode()); }, children: createElement(Markdown, { children: "`foo.service`" }) });
  const tree = createElement(SettingsProvider, { children: createElement(MachineContext.Provider, { value: "local", children:
    createElement(OpenFileContext.Provider, { value: () => {}, children: createElement(ChatNames, { paneId: "w1:p2", children: row }) }),
  }) });
  await page.render(tree);
  expect(frames.length).toBeGreaterThan(0);
  expect(frames.every((frame) => frame.length === 1 && frame[0] === "foo.service")).toBe(true);
  expect(requests).toHaveLength(2);
});

it("keeps every bare name a link where nothing looks names up, as in a file's own preview", async () => {
  await draw("`user-1000.slice` and `README.md`", { lookup: false });
  expect(requests).toEqual([]);
  expect(links()).toEqual(["Open user-1000.slice", "Open README.md"]);
});
