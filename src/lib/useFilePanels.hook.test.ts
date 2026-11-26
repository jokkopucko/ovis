import { afterEach, beforeEach, expect, it, mock } from "bun:test";
import { act, createElement } from "react";
import { openPage, type Page } from "./page.fixture.ts";
import { DEFAULT_SETTINGS } from "./settings.ts";
import { useFilePanels } from "./useFilePanels.ts";

let page: Page;
let savedHTMLElement: PropertyDescriptor | undefined;
let panels: ReturnType<typeof useFilePanels>;

beforeEach(() => {
  page = openPage("http://localhost:7317/");
  savedHTMLElement = Object.getOwnPropertyDescriptor(globalThis, "HTMLElement");
  Object.defineProperty(globalThis, "HTMLElement", { configurable: true, value: page.window.HTMLElement });
});
afterEach(async () => {
  await page.close();
  if (savedHTMLElement) Object.defineProperty(globalThis, "HTMLElement", savedHTMLElement);
  else Reflect.deleteProperty(globalThis, "HTMLElement");
});

it("closes a diff's file docked over a file that holds the page count onto that file, not past it (#3095)", async () => {
  const entries: Array<{ key: string; state: unknown }> = [
    { key: "pane", state: null },
    { key: "page", state: { "ovis:web-panel": { url: "http://localhost:3000/a" } } },
    { key: "a", state: { "ovis:file-preview": { path: "/r/a.md", machineId: "local", paneId: "p1", presentation: "panel" }, "ovis:web-panel-below": 1 } },
  ];
  let index = 2;
  const traverseTo = mock((_key: string) => ({ committed: Promise.resolve(undefined) }));
  Object.defineProperties(page.window.history, Object.getOwnPropertyDescriptors({
      get state() { return entries[index]!.state; },
      replaceState: (next: unknown) => { entries[index] = { ...entries[index]!, state: next }; },
      pushState: (next: unknown) => { entries.splice(index + 1); entries.push({ key: `e${entries.length}`, state: next }); index += 1; },
    }));
  Object.defineProperty(page.window, "navigation", { configurable: true, value: { get currentEntry() { return { index }; }, entries: () => entries, traverseTo } });
  function Probe() {
    panels = useFilePanels({
      settings: { ...DEFAULT_SETTINGS, fileOpen: "panel" },
      filePanelAvailable: true, selectedPaneId: "p1", selectedMachineId: "local",
    });
    return null;
  }
  await page.render(createElement(Probe));
  const diff = {
    machineId: "local", paneId: "p1", directory: "/r", path: "b.md", oldPath: null,
    scope: "workspace" as const, base: null, head: null, comparison: null,
  };
  await act(async () => { panels.openDiff(diff); });

  await act(async () => { panels.releaseDiff(); panels.openFile({ path: "/r/b.md", paneId: "p1", machineId: "local" }, true); });
  await act(async () => { panels.closeFile(); });

  expect(traverseTo).toHaveBeenCalledWith("a");
});

it("closes a diff over a copy of its entry (a sheet's, after a reload) back past both (#3101)", async () => {
  const diff = {
    machineId: "local", paneId: "p1", directory: "/r", path: "b.md", oldPath: null,
    scope: "workspace" as const, base: null, head: null, comparison: null,
  };
  const entries: Array<{ key: string; state: unknown }> = [
    { key: "pane", state: null },
    { key: "diff", state: { "ovis:repo-diff": diff } },
    { key: "copy", state: { "ovis:repo-diff": diff, "ovis:web-panel-below": 1 } },
  ];
  const traverseTo = mock((_key: string) => ({ committed: Promise.resolve(undefined) }));
  Object.defineProperties(page.window.history, Object.getOwnPropertyDescriptors({ get state() { return entries[2]!.state; }, replaceState: () => {}, pushState: () => {}, back: () => { traverseTo(entries[1]!.key); } }));
  Object.defineProperty(page.window, "navigation", { configurable: true, value: { currentEntry: { index: 2 }, entries: () => entries, traverseTo } });
  function Probe() {
    panels = useFilePanels({ settings: DEFAULT_SETTINGS, filePanelAvailable: false, selectedPaneId: "p1", selectedMachineId: "local" });
    return null;
  }
  await page.render(createElement(Probe));

  await act(async () => { panels.closeDiff(); });

  expect(traverseTo).toHaveBeenCalledWith("pane");
});

it("keeps Files and the diff open without replacing history when the traversal rejects", async () => {
  let state: unknown = { "ovis:web-panel": { url: "http://localhost:3000/report" } };
  const replaceState = mock((next: unknown) => { state = next; });
  const pushState = mock((next: unknown) => { state = next; });
  const traversal = Promise.withResolvers<unknown>();
  const traverseTo = mock(() => ({ committed: traversal.promise }));
  Object.defineProperties(page.window.history, Object.getOwnPropertyDescriptors({ get state() { return state; }, replaceState, pushState }));
  Object.defineProperty(page.window, "navigation", { configurable: true, value: {
      currentEntry: { index: 2 },
      entries: () => [{ key: "pane" }, { key: "report" }, { key: "diff" }],
      traverseTo,
    } });
  function Probe() {
    panels = useFilePanels({
      settings: { ...DEFAULT_SETTINGS, fileOpen: "panel" },
      filePanelAvailable: true, selectedPaneId: "p1", selectedMachineId: "local",
    });
    return null;
  }
  await page.render(createElement(Probe));
  const diff = {
    machineId: "local", paneId: "p1", directory: "/repo", path: "file.ts", oldPath: null,
    scope: "workspace" as const, base: null, head: null, comparison: null,
  };
  await act(async () => { panels.setFilesOpen(true); panels.openDiff(diff); });
  replaceState.mockClear();
  pushState.mockClear();

  const opening = panels.openDiffFile({ path: "file.ts", paneId: "p1", machineId: "local" });
  const error = new DOMException("Traversal cancelled", "AbortError");
  const rejected = opening.then(() => null, (reason: unknown) => reason);
  expect(traverseTo).toHaveBeenCalledWith("pane");
  expect(panels.filesOpen).toBe(true);
  await act(async () => { traversal.reject(error); expect(await rejected).toBe(error); });

  expect(panels.filesOpen).toBe(true);
  expect(panels.diffViewing).toEqual(diff);
  expect(panels.viewing).toBeNull();
  expect(panels.collapsing.current).toBe(false);
  expect(replaceState).not.toHaveBeenCalled();
  expect(pushState).not.toHaveBeenCalled();
});
