import { afterEach, beforeEach, expect, it } from "bun:test";
import { act, createElement } from "react";
import { openPage, type Page } from "./page.fixture.ts";
import { DEFAULT_SETTINGS, type Settings } from "./settings.ts";
import { useFilePanels } from "./useFilePanels.ts";

let page: Page;
let panels: ReturnType<typeof useFilePanels>;

let htmlElement: PropertyDescriptor | undefined;
beforeEach(() => {
  page = openPage("http://localhost:7317/");
  htmlElement = Object.getOwnPropertyDescriptor(globalThis, "HTMLElement");
  Object.defineProperty(globalThis, "HTMLElement", { configurable: true, value: page.window.HTMLElement });
});
afterEach(async () => {
  await page.close();
  if (htmlElement) Object.defineProperty(globalThis, "HTMLElement", htmlElement);
  else Reflect.deleteProperty(globalThis, "HTMLElement");
});

async function mount(settings: Partial<Settings>, filePanelAvailable: boolean): Promise<void> {
  function Probe() {
    panels = useFilePanels({ settings: { ...DEFAULT_SETTINGS, ...settings }, filePanelAvailable, selectedPaneId: "p1", selectedMachineId: "local" });
    return null;
  }
  await page.render(createElement(Probe));
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
  await page.render(createElement(Probe));
  await act(async () => { panels.setFilesOpen(true); });
  await act(async () => { expect(panels.openWebPage("http://localhost:3000/report", false, "local")).toBe(true); });
  expect(panels.filesCovered).toBe(true);

  wide = false;
  await page.render(createElement(Probe));

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
  await page.render(createElement(Probe));
  await act(async () => { panels.setFilesOpen(true); });
  await act(async () => { panels.viewFile("src/app.ts"); });
  expect(panels.fileDocked).toBe(false);

  wide = false;
  await page.render(createElement(Probe));

  expect(panels.viewing).not.toBeNull();
  expect(panels.filesOpen).toBe(false);
});

it("keeps Files a dialog on a narrow window even when set beside the pane", async () => {
  await mount({ filesPanel: true }, false);
  expect(panels.filesDocked).toBe(false);
});
