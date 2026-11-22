import { afterEach, beforeEach, expect, it } from "bun:test";
import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { DEFAULT_SETTINGS } from "./settings.ts";
import { FILE_PREVIEW_KEY, sheetStep } from "./historyKeys.ts";
import { useFilePanels } from "./useFilePanels.ts";

const descriptors = new Map<string, PropertyDescriptor | undefined>();
let renderer: ReactTestRenderer | undefined;
let panels: ReturnType<typeof useFilePanels>;
let entries: unknown[];
let index: number;
let events: EventTarget;

beforeEach(() => {
  for (const key of ["window", "document", "HTMLElement", "IS_REACT_ACT_ENVIRONMENT"]) {
    descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
  }
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
  Object.defineProperty(globalThis, "document", { configurable: true, value: { activeElement: null } });
  Object.defineProperty(globalThis, "HTMLElement", { configurable: true, value: class {} });
  entries = [{ "ovis:nav": true }];
  index = 0;
  events = new EventTarget();
  const go = (steps: number): void => {
    index += steps;
    events.dispatchEvent(Object.assign(new Event("popstate"), { state: entries[index] }));
  };
  Object.defineProperty(globalThis, "window", { configurable: true, value: {
    location: new URL("http://localhost:7317/"),
    history: {
      get state() { return entries[index]; },
      replaceState: (next: unknown) => { entries[index] = next; },
      pushState: (next: unknown) => { entries.splice(index + 1); entries.push(next); index += 1; },
      go,
    },
    addEventListener: events.addEventListener.bind(events),
    removeEventListener: events.removeEventListener.bind(events),
  } });
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

async function mount(reopenFileOnReturn: boolean, filePanelAvailable = true): Promise<void> {
  function Probe() {
    panels = useFilePanels({
      settings: { ...DEFAULT_SETTINGS, reopenFileOnReturn },
      filePanelAvailable, selectedPaneId: "p1", selectedMachineId: "local",
    });
    return null;
  }
  await act(async () => { renderer = create(createElement(Probe)); });
}

const fileOn = (pane: string, path = `/r/${pane}.md`) => ({ path, paneId: pane, machineId: "local" });
const fileOf = (state: unknown): unknown => (state as Record<string, unknown> | undefined)?.[FILE_PREVIEW_KEY];
async function moveTo(pane: string, kept: boolean): Promise<void> {
  await act(async () => {
    if (kept) window.history.pushState({ "ovis:nav": true }, "");
    else window.history.replaceState({ "ovis:nav": true }, "");
    panels.restoreFile("local", pane);
  });
}

it("off: a tab switch releases the file from its entry and the file never comes back", async () => {
  await mount(false);
  await act(async () => { panels.openFile(fileOn("p1")); });

  let kept = true;
  await act(async () => { kept = panels.leaveFile(); });
  await moveTo("p2", kept);
  await moveTo("p1", false);

  expect(kept).toBe(false);
  expect(panels.viewing).toBeNull();
  expect(entries.some((entry) => fileOf(entry) !== undefined)).toBe(false);
});

it("on: the file's entry keeps it for Back, and a switch back opens it over the move's entry", async () => {
  await mount(true);
  await act(async () => { panels.openFile(fileOn("p1")); });

  let kept = false;
  await act(async () => { kept = panels.leaveFile(); });
  await moveTo("p2", kept);

  expect(kept).toBe(true);
  expect(panels.viewing).toBeNull();
  expect(fileOf(entries[1])).toEqual(fileOn("p1"));

  await moveTo("p1", true);

  expect(panels.viewing).toEqual(fileOn("p1"));
  expect(fileOf(entries[index])).toEqual(fileOn("p1"));
  expect(fileOf(entries[index - 1])).toBeUndefined();

  await act(async () => { panels.closeFile(); });

  expect(panels.viewing).toBeNull();
  expect(fileOf(entries[index])).toBeUndefined();
  await moveTo("p1", true);
  expect(panels.viewing).toBeNull();
});

it("on: a file shown again by Back and closed there is not reopened by a later switch", async () => {
  await mount(true);
  await act(async () => { panels.openFile(fileOn("p1")); });
  await act(async () => { panels.leaveFile(); });
  await moveTo("p2", true);

  await act(async () => { window.history.go(-1); });
  expect(panels.viewing).toEqual(fileOn("p1"));
  await act(async () => { panels.closeFile(); });

  await moveTo("p1", true);
  expect(panels.viewing).toBeNull();
});

it("on: a closed tab's file gives its place up before the oldest live one is forgotten", async () => {
  await mount(true);
  for (let pane = 0; pane < 10; pane++) {
    await act(async () => { panels.openFile(fileOn(`p${pane}`)); });
    await act(async () => { panels.leaveFile(); });
    await moveTo("elsewhere", true);
  }

  await act(async () => { panels.openFile(fileOn("p10")); });
  await act(async () => { panels.leaveFile((_machine, pane) => pane !== "p5"); });
  await moveTo("elsewhere", true);

  await moveTo("p0", true);
  expect(panels.viewing).toEqual(fileOn("p0"));
});

it("on: the file of a tab that just closed, or one opened for another pane than the one shown, is released", async () => {
  await mount(true);
  await act(async () => { panels.openFile(fileOn("p1")); });

  let kept = true;
  await act(async () => { kept = panels.leaveFile((_machine, pane) => pane !== "p1"); });

  expect(kept).toBe(false);
  expect(fileOf(entries[index])).toBeUndefined();
  await moveTo("p1", true);
  expect(panels.viewing).toBeNull();

  await act(async () => { panels.openFile(fileOn("p2")); });
  await act(async () => { kept = panels.leaveFile(undefined, false); });

  expect(kept).toBe(false);
  expect(fileOf(entries[index])).toBeUndefined();
  await moveTo("p2", true);
  expect(panels.viewing).toBeNull();
});

it("on: a remembered tab that closes is forgotten, so a later pane with its id opens no file", async () => {
  await mount(true);
  await act(async () => { panels.openFile(fileOn("p1")); });
  await act(async () => { panels.leaveFile(); });
  await moveTo("p2", true);

  await act(async () => { panels.forgetLeftFiles((_machine, pane) => pane !== "p1"); });
  await moveTo("p1", true);

  expect(panels.viewing).toBeNull();
});

it("on: keeps the files of the ten panes left last", async () => {
  await mount(true);
  for (let pane = 0; pane <= 10; pane++) {
    await act(async () => { panels.openFile(fileOn(`p${pane}`)); });
    await act(async () => { panels.leaveFile(); });
    await moveTo("elsewhere", true);
  }

  await moveTo("p0", true);
  expect(panels.viewing).toBeNull();
  await moveTo("p10", true);
  expect(panels.viewing).toEqual(fileOn("p10"));
});

it("does not show again a file whose entry the file list goes onto to take for its own", async () => {
  await mount(false);
  await act(async () => { panels.openFile(fileOn("p1")); });
  await act(async () => { window.history.go(-1); });
  expect(panels.viewing).toBeNull();
  expect(fileOf(entries[1])).toEqual(fileOn("p1"));

  const answering = sheetStep.taking;
  sheetStep.taking = () => true;
  try { await act(async () => { window.history.go(1); }); } finally { sheetStep.taking = answering; }

  expect(panels.viewing).toBeNull();
  await act(async () => { window.history.go(-1); });
  await act(async () => { window.history.go(1); });
  expect(panels.viewing).toEqual(fileOn("p1"));
});

it("does not show again a diff whose entry the file list goes onto to take for its own", async () => {
  await mount(false);
  const diff = { machineId: "local", paneId: "p1", directory: "/r", path: "b.md", oldPath: null, scope: "workspace" as const, base: null, head: null, comparison: null };
  await act(async () => { panels.openDiff(diff); });
  expect(panels.diffViewing).toEqual(diff);
  await act(async () => { window.history.go(-1); });
  expect(panels.diffViewing).toBeNull();

  const answering = sheetStep.taking;
  sheetStep.taking = () => true;
  try { await act(async () => { window.history.go(1); }); } finally { sheetStep.taking = answering; }

  expect(panels.diffViewing).toBeNull();
});

it("keeps a file as it is while a Back that a sheet with no entry refused goes and comes back", async () => {
  await mount(false);
  await act(async () => { panels.openFile(fileOn("p1")); });
  const shown = panels.viewing;
  expect(shown).toEqual(fileOn("p1"));

  const answering = sheetStep.holds;
  sheetStep.holds = () => true;
  try {
    await act(async () => { window.history.go(-1); });
    expect(panels.viewing).toBe(shown);
    await act(async () => { window.history.go(1); });
  } finally { sheetStep.holds = answering; }
  expect(panels.viewing).toBe(shown);
  expect(panels.fileFromPop()).toBe(0);

  await act(async () => { window.history.go(-1); });
  expect(panels.viewing).toBeNull();
});

it("keeps a diff as it is while a Back that a sheet with no entry refused goes and comes back", async () => {
  await mount(false);
  const diff = { machineId: "local", paneId: "p1", directory: "/r", path: "b.md", oldPath: null, scope: "workspace" as const, base: null, head: null, comparison: null };
  await act(async () => { panels.openDiff(diff); });
  const shown = panels.diffViewing;
  expect(shown).toEqual(diff);

  const answering = sheetStep.holds;
  sheetStep.holds = () => true;
  try {
    await act(async () => { window.history.go(-1); });
    expect(panels.diffViewing).toBe(shown);
    await act(async () => { window.history.go(1); });
  } finally { sheetStep.holds = answering; }
  expect(panels.diffViewing).toBe(shown);

  await act(async () => { window.history.go(-1); });
  expect(panels.diffViewing).toBeNull();
});

it("keeps a web page as it is, and writes no entry for it, while a Back that a sheet with no entry refused goes and comes back", async () => {
  await mount(false, false);
  await act(async () => { expect(panels.openWebPage("http://localhost:3000/report", DEFAULT_SETTINGS.webLinks !== "panel", "local")).toBe(true); });
  const shown = panels.webPage;
  expect(shown).not.toBeNull();
  const held = [...entries];
  expect(held.length).toBe(2);

  const answering = sheetStep.holds;
  sheetStep.holds = () => true;
  try {
    await act(async () => { window.history.go(-1); });
    expect(panels.webPage).toBe(shown);
    await act(async () => { window.history.go(1); });
  } finally { sheetStep.holds = answering; }
  expect(panels.webPage).toBe(shown);
  expect(entries).toEqual(held);

  await act(async () => { window.history.go(-1); });
  expect(panels.webPage).toBeNull();
});

it("does not show again a web page whose entry a sheet goes onto to take for its own", async () => {
  await mount(false, false);
  await act(async () => { expect(panels.openWebPage("http://localhost:3000/report", DEFAULT_SETTINGS.webLinks !== "panel", "local")).toBe(true); });
  await act(async () => { window.history.go(-1); });
  expect(panels.webPage).toBeNull();

  const answering = sheetStep.taking;
  sheetStep.taking = () => true;
  try { await act(async () => { window.history.go(1); }); } finally { sheetStep.taking = answering; }

  expect(panels.webPage).toBeNull();
  await act(async () => { window.history.go(-1); });
  await act(async () => { window.history.go(1); });
  expect(panels.webPage).not.toBeNull();
});
