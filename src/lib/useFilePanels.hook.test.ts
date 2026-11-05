import { afterEach, beforeEach, expect, it, mock } from "bun:test";
import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { DEFAULT_SETTINGS } from "./settings.ts";
import { useFilePanels } from "./useFilePanels.ts";

const descriptors = new Map<string, PropertyDescriptor | undefined>();
let renderer: ReactTestRenderer | undefined;
let panels: ReturnType<typeof useFilePanels>;

beforeEach(() => {
  for (const key of ["window", "IS_REACT_ACT_ENVIRONMENT"]) {
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

it("keeps Files and the diff open without replacing history when the traversal rejects", async () => {
  // Given a docked report owning an entry, with Files and a diff opened over it.
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

  // When the Navigation API rejects the pending step instead of committing it.
  const opening = panels.openDiffFile({ path: "file.ts", paneId: "p1", machineId: "local" });
  const error = new DOMException("Traversal cancelled", "AbortError");
  const rejected = opening.then(() => null, (reason: unknown) => reason);
  expect(traverseTo).toHaveBeenCalledWith("pane");
  expect(panels.filesOpen).toBe(true);
  await act(async () => { traversal.reject(error); expect(await rejected).toBe(error); });

  // Then the caller receives the failure and no file takes over an unknown history entry.
  expect(panels.filesOpen).toBe(true);
  expect(panels.diffViewing).toEqual(diff);
  expect(panels.viewing).toBeNull();
  expect(panels.collapsing.current).toBe(false);
  expect(replaceState).not.toHaveBeenCalled();
  expect(pushState).not.toHaveBeenCalled();
});
