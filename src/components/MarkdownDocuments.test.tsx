import { afterEach, beforeEach, expect, jest, spyOn, test } from "bun:test";
import { act, createElement } from "react";
import { openPage, type Page } from "../lib/page.fixture.ts";

import { MarkdownDocuments } from "./MarkdownDocuments.tsx";
import type { PaneDocuments } from "../../shared/files.ts";
import { SettingsProvider, useSettings, type Settings } from "../lib/settings.ts";

let page: Page;

const LISTING: PaneDocuments = {
  root: "/repo",
  documents: [
    { path: "docs/plans/rollout.md", size: 10, modified: "2026-11-05T10:00:00.000Z" },
    { path: "HANDOFF.md", size: 5, modified: "2026-11-04T10:00:00.000Z" },
  ],
  truncated: false,
};

beforeEach(() => { page = openPage(); });

afterEach(async () => {
  await page.close();
  jest.restoreAllMocks();
});

function serve(answer: () => Response): string[] {
  const asked: string[] = [];
  spyOn(globalThis, "fetch").mockImplementation(Object.assign(async (input: RequestInfo | URL) => {
    asked.push(String(input));
    return answer();
  }, globalThis.fetch));
  return asked;
}

async function mount(onOpenFile: (path: string) => void = () => {}): Promise<void> {
  await page.render(createElement(SettingsProvider, { children: createElement(MarkdownDocuments, { paneId: "w1:p1", onOpenFile }) }));
}

const rows = () => [...page.container.querySelectorAll<HTMLButtonElement>("button.md-docs-item")];
const notes = () => [...page.container.querySelectorAll(".dir-browser-note")].map((node) => node.textContent);

test("lists the pane's Markdown files in the server's order and opens one by its absolute path", async () => {
  const asked = serve(() => Response.json(LISTING));
  const opened: string[] = [];
  await mount((path) => opened.push(path));
  expect(asked).toHaveLength(1);
  expect(asked[0]).toContain("/pane/docs?pane_id=w1%3Ap1");
  expect(rows().map((row) => row.title)).toEqual(["docs/plans/rollout.md", "HANDOFF.md"]);
  await act(async () => { rows()[0]!.click(); });
  expect(opened).toEqual(["/repo/docs/plans/rollout.md"]);
});

test("narrows the list to the paths that hold the filter's words, in any case", async () => {
  serve(() => Response.json(LISTING));
  await mount();
  const filter = page.one<HTMLInputElement>('input[type="search"]');
  await page.type(filter, "PLANS");
  expect(rows().map((row) => row.title)).toEqual(["docs/plans/rollout.md"]);
  const bar = page.one('[class="dir-browser-bar"]');
  expect(bar.textContent).toContain("Filter documents:/repo");
  await page.type(filter, "nothing-like-it");
  expect(rows()).toHaveLength(0);
  expect(notes()).toEqual(["No matching documents" + "Clear or change the filter."]);
});

test("retains the last folder path and skeleton placeholders while refreshing", async () => {
  let resolveNext: ((res: Response) => void) | undefined;
  let call = 0;
  serve(() => {
    call += 1;
    if (call === 1) return Response.json(LISTING);
    return new Promise<Response>((resolve) => { resolveNext = resolve; }) as unknown as Response;
  });
  await mount();
  expect(rows()).toHaveLength(2);
  const refresh = page.one('[aria-label="Refresh documents"]');
  await act(async () => { refresh.click(); });
  const pathBar = page.one('[class="dir-browser-path"]');
  expect(pathBar.textContent).toBe("/repo");
  expect(page.one('[role="status"]').textContent).toBe("Loading documents…");
  expect(page.container.querySelectorAll('[class="md-docs-skeleton"]')).toHaveLength(1);
  await act(async () => { resolveNext?.(Response.json(LISTING)); });
  expect(rows()).toHaveLength(2);
});

test.each([
  ["no document", 0, "", 1],
  ["one document", 1, "", 1],
  ["two documents", 2, "", 2],
  ["two documents filtered to one", 2, "plans", 1],
])("a refresh after %s keeps the rows shown", async (_, listed, filter, shownRows) => {
  const listing = { ...LISTING, documents: LISTING.documents.slice(0, listed) };
  let reading = true;
  serve(() => reading ? Response.json(listing) : new Promise<Response>(() => {}) as unknown as Response);
  await mount();
  await page.type(page.one<HTMLInputElement>('input[type="search"]'), filter);
  reading = false;
  await act(async () => { page.one('[aria-label="Refresh documents"]').click(); });
  expect(1 + page.container.querySelectorAll('[class="md-docs-skeleton"]').length).toBe(shownRows);
});

test("says a PC on an older version cannot list documents, apart from any other failure", async () => {
  serve(() => Response.json({ error: { code: "not_found", message: "unknown endpoint /api/pane/docs" } }, { status: 404 }));
  await mount();
  expect(notes()).toEqual(["This PC's bridge cannot list documents yet."]);
  await page.render(null);
  serve(() => Response.json({ error: { code: "pane_not_found", message: "no such pane" } }, { status: 404 }));
  await mount();
  expect(notes()).toEqual(["Documents could not be loaded."]);
});

test("a language change redraws the listing in place: no second read, the rows and root stay", async () => {
  const asked = serve(() => Response.json(LISTING));
  let update: (patch: Partial<Settings>) => void = () => undefined;
  const Grab = () => { update = useSettings().update; return null; };
  await page.render(createElement(SettingsProvider, { children: [createElement(Grab, { key: "grab" }), createElement(MarkdownDocuments, { key: "docs", paneId: "w1:p1", onOpenFile: () => {} })] }));
  expect(rows()).toHaveLength(2);
  await act(async () => { update({ language: "ja" }); });
  expect(asked).toHaveLength(1);
  expect(rows()).toHaveLength(2);
  expect(page.one('[class="dir-browser-bar"]').textContent).toContain("/repo");
});
