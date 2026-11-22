import { afterEach, beforeEach, expect, it } from "bun:test";
import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { DEFAULT_SETTINGS, type Settings } from "./settings.ts";
import { useFilePanels } from "./useFilePanels.ts";

const descriptors = new Map<string, PropertyDescriptor | undefined>();
let renderer: ReactTestRenderer | undefined;
let panels: ReturnType<typeof useFilePanels>;

beforeEach(() => {
  for (const key of ["window", "document", "HTMLElement", "IS_REACT_ACT_ENVIRONMENT"]) descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
  const events = new EventTarget();
  let state: unknown = null;
  Object.defineProperty(globalThis, "window", { configurable: true, value: {
    location: new URL("http://localhost:7317/"),
    history: { get state() { return state; }, replaceState: (next: unknown) => { state = next; }, pushState: (next: unknown) => { state = next; } },
    addEventListener: events.addEventListener.bind(events),
    removeEventListener: events.removeEventListener.bind(events),
  } });
  Object.defineProperty(globalThis, "HTMLElement", { configurable: true, value: class {} });
  Object.defineProperty(globalThis, "document", { configurable: true, value: { activeElement: null } });
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

async function mount(settings: Partial<Settings>, filePanelAvailable: boolean): Promise<void> {
  function Probe() {
    panels = useFilePanels({ settings: { ...DEFAULT_SETTINGS, ...settings }, filePanelAvailable, selectedPaneId: "p1", selectedMachineId: "local" });
    return null;
  }
  await act(async () => { renderer = create(createElement(Probe)); });
  await act(async () => { panels.setFilesOpen(true); });
}

it("keeps Files open beside the pane under a file that docks in its place", async () => {
  await mount({ fileOpen: "panel", filesPanel: true }, true);
  expect(panels.filesDocked).toBe(true);

  await act(async () => { panels.viewFile("src/app.ts"); });

  expect(panels.fileDocked).toBe(true);
  expect(panels.filesOpen).toBe(true);
});

it("closes the Files dialog under a docked file when Files is not set beside the pane", async () => {
  await mount({ fileOpen: "panel" }, true);
  expect(panels.filesDocked).toBe(false);

  await act(async () => { panels.viewFile("src/app.ts"); });

  expect(panels.fileDocked).toBe(true);
  expect(panels.filesOpen).toBe(false);
});

it("closes Files beside the pane when the window narrows under a web page that covers it", async () => {
  let wide = true;
  const settings = { ...DEFAULT_SETTINGS, filesPanel: true, webLinks: "panel" as const };
  function Probe() {
    panels = useFilePanels({ settings, filePanelAvailable: wide, selectedPaneId: "p1", selectedMachineId: "local" });
    return null;
  }
  await act(async () => { renderer = create(createElement(Probe)); });
  await act(async () => { panels.setFilesOpen(true); });
  await act(async () => { expect(panels.openWebPage("http://localhost:3000/report", false, "local")).toBe(true); });
  expect(panels.filesCovered).toBe(true);

  wide = false;
  await act(async () => { renderer!.update(createElement(Probe)); });

  expect(panels.webPage).not.toBeNull();
  expect(panels.filesOpen).toBe(false);
});

it("closes Files beside the pane when the window narrows under a popup file", async () => {
  let wide = true;
  const settings = { ...DEFAULT_SETTINGS, filesPanel: true };
  function Probe() {
    panels = useFilePanels({ settings, filePanelAvailable: wide, selectedPaneId: "p1", selectedMachineId: "local" });
    return null;
  }
  await act(async () => { renderer = create(createElement(Probe)); });
  await act(async () => { panels.setFilesOpen(true); });
  await act(async () => { panels.viewFile("src/app.ts"); });
  expect(panels.fileDocked).toBe(false);

  wide = false;
  await act(async () => { renderer!.update(createElement(Probe)); });

  expect(panels.viewing).not.toBeNull();
  expect(panels.filesOpen).toBe(false);
});

it("keeps Files a dialog on a narrow window even when set beside the pane", async () => {
  await mount({ filesPanel: true }, false);
  expect(panels.filesDocked).toBe(false);
});
