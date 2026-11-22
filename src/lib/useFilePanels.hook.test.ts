import { afterEach, beforeEach, expect, it, mock } from "bun:test";
import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { DEFAULT_SETTINGS } from "./settings.ts";
import { useFilePanels } from "./useFilePanels.ts";

const descriptors = new Map<string, PropertyDescriptor | undefined>();
let renderer: ReactTestRenderer | undefined;
let panels: ReturnType<typeof useFilePanels>;

beforeEach(() => {
  for (const key of ["window", "document", "HTMLElement", "IS_REACT_ACT_ENVIRONMENT"]) {
    descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
  }
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
});

afterEach(async () => {
  await act(async () => { renderer?.unmount(); });
  renderer = undefined;
  for (const [key, descriptor] of descriptors) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
  descriptors.clear();
});

it("closes a diff's file docked over a file that holds the page count onto that file, not past it (#3095)", async () => {
  const events = new EventTarget();
  const entries: Array<{ key: string; state: unknown }> = [
    { key: "pane", state: null },
    { key: "page", state: { "ovis:web-panel": { url: "http://localhost:3000/a" } } },
    { key: "a", state: { "ovis:file-preview": { path: "/r/a.md", machineId: "local", paneId: "p1", presentation: "panel" }, "ovis:web-panel-below": 1 } },
  ];
  let index = 2;
  Object.defineProperty(globalThis, "document", { configurable: true, value: { activeElement: null } });
  Object.defineProperty(globalThis, "HTMLElement", { configurable: true, value: class {} });
  const traverseTo = mock((_key: string) => ({ committed: Promise.resolve(undefined) }));
  Object.defineProperty(globalThis, "window", { configurable: true, value: {
    location: new URL("http://localhost:7317/"),
    history: {
      get state() { return entries[index]!.state; },
      replaceState: (next: unknown) => { entries[index] = { ...entries[index]!, state: next }; },
      pushState: (next: unknown) => { entries.splice(index + 1); entries.push({ key: `e${entries.length}`, state: next }); index += 1; },
    },
    navigation: { get currentEntry() { return { index }; }, entries: () => entries, traverseTo },
    addEventListener: events.addEventListener.bind(events),
    removeEventListener: events.removeEventListener.bind(events),
  } });
  function Probe() {
    panels = useFilePanels({
      settings: { ...DEFAULT_SETTINGS, fileOpen: "panel" },
      filePanelAvailable: true, selectedPaneId: "p1", selectedMachineId: "local",
    });
    return null;
  }
  await act(async () => { renderer = create(createElement(Probe)); });
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
  const events = new EventTarget();
  const traverseTo = mock((_key: string) => ({ committed: Promise.resolve(undefined) }));
  Object.defineProperty(globalThis, "window", { configurable: true, value: {
    location: new URL("http://localhost:7317/"),
    history: { get state() { return entries[2]!.state; }, replaceState: () => {}, pushState: () => {}, back: () => { traverseTo(entries[1]!.key); } },
    navigation: { currentEntry: { index: 2 }, entries: () => entries, traverseTo },
    addEventListener: events.addEventListener.bind(events),
    removeEventListener: events.removeEventListener.bind(events),
  } });
  function Probe() {
    panels = useFilePanels({ settings: DEFAULT_SETTINGS, filePanelAvailable: false, selectedPaneId: "p1", selectedMachineId: "local" });
    return null;
  }
  await act(async () => { renderer = create(createElement(Probe)); });

  await act(async () => { panels.closeDiff(); });

  expect(traverseTo).toHaveBeenCalledWith("pane");
});

it("keeps Files and the diff open without replacing history when the traversal rejects", async () => {
  const events = new EventTarget();
  let state: unknown = { "ovis:web-panel": { url: "http://localhost:3000/report" } };
  const replaceState = mock((next: unknown) => { state = next; });
  const pushState = mock((next: unknown) => { state = next; });
  const traversal = Promise.withResolvers<unknown>();
  const traverseTo = mock(() => ({ committed: traversal.promise }));
  Object.defineProperty(globalThis, "window", { configurable: true, value: {
    location: new URL("http://localhost:7317/"),
    history: { get state() { return state; }, replaceState, pushState },
    navigation: {
      currentEntry: { index: 2 },
      entries: () => [{ key: "pane" }, { key: "report" }, { key: "diff" }],
      traverseTo,
    },
    addEventListener: events.addEventListener.bind(events),
    removeEventListener: events.removeEventListener.bind(events),
  } });
  function Probe() {
    panels = useFilePanels({
      settings: { ...DEFAULT_SETTINGS, fileOpen: "panel" },
      filePanelAvailable: true, selectedPaneId: "p1", selectedMachineId: "local",
    });
    return null;
  }
  await act(async () => { renderer = create(createElement(Probe)); });
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
