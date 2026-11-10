import { afterAll, afterEach, beforeAll, beforeEach, expect, it, mock } from "bun:test";
import { createElement, useLayoutEffect } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import type { Machine } from "../../shared/machines.ts";
import type { HerdrPane, HerdrWorkspace } from "../../shared/protocol.ts";
import type { AppLink, CreateDraft } from "./deepLink.ts";
import { FILE_PREVIEW_KEY } from "./historyKeys.ts";
import type { SelectionMark } from "./selectionMark.ts";
import * as settingsHistory from "./settingsHistory.ts";
import * as sheetHistory from "./sheetHistory.ts";
import { popUnread, useAddressBar } from "./useAddressBar.ts";

// The two history modules answer the handler from what their own popstate listeners last saw, on the
// window they loaded with. That is not this file's window (another test file may have loaded them,
// and left its last answer): here no pop is Settings closing or a sheet's step.
const loaded = { settings: { ...settingsHistory }, sheet: { ...sheetHistory } };
beforeAll(() => {
  mock.module("./settingsHistory.ts", () => ({ ...loaded.settings, settingsSteppedOff: () => false }));
  mock.module("./sheetHistory.ts", () => ({ ...loaded.sheet, sheetSteppedOff: () => false }));
});
afterAll(() => {
  mock.module("./settingsHistory.ts", () => loaded.settings);
  mock.module("./sheetHistory.ts", () => loaded.sheet);
});

type Params = Parameters<typeof useAddressBar>[0];
type Snapshot = NonNullable<Machine["snapshot"]>;
type Preview = NonNullable<Params["viewing"]>;

const P1 = "?ws=w1-api&pane=p1&view=chat";
const P2 = "?ws=w2-docs&pane=p2&view=chat";
const roster = (): Snapshot => ({
  workspaces: [{ workspace_id: "w1", label: "api" }, { workspace_id: "w2", label: "docs" }],
  panes: [{ pane_id: "p1", workspace_id: "w1", focused: true }, { pane_id: "p2", workspace_id: "w2", focused: false }],
  layouts: [],
}) as unknown as Snapshot;

/** what the app shows: the hook's inputs that the tests move */
let place: { paneId: string; newSessionOpen: boolean; newFields: Omit<CreateDraft, "kind"> | null; sidebarCollapsed: boolean; snapshot: Snapshot; viewing: Preview | null };
/** the panes the handler asked the app to select */
let asked: Array<string | null>;
/** every history write: the method, the entry it was made on and the address it left there */
let writes: string[];
let entries: Array<{ state: unknown; url: URL }>;
let index: number;
let listeners: Array<(event: Event) => void>;
/** an update still waiting when Back lands: React draws it between two popstate listeners */
let waiting: (() => void) | null;
let renderer: ReactTestRenderer | undefined;
const descriptors = new Map<string, PropertyDescriptor | undefined>();
const refs = {
  selection: { current: { machineId: "local", paneId: null, generation: 0 } as SelectionMark },
  machines: { current: [] as Machine[] },
  selectTarget: { current: (_machineId: string, _paneId: string | null): void => {} },
  pendingFile: { current: null as string | null },
  pendingLink: { current: null as AppLink | null },
  pendingCreate: { current: null as CreateDraft | null },
  linkSince: { current: 0 },
  rosterSeq: { current: 0 },
};

function Probe() {
  const { paneId, newSessionOpen, newFields, sidebarCollapsed, snapshot, viewing } = place;
  const machine = { id: "local", name: "workstation", kind: "local", enabled: true, state: "connected", error: null, snapshot } as Machine;
  const pane = snapshot.panes.find((candidate) => candidate.pane_id === paneId) as HerdrPane;
  refs.machines.current = [machine];
  // the app marks its selection at commit (lib/useSelection.ts)
  useLayoutEffect(() => { refs.selection.current = { machineId: "local", paneId, generation: 0 }; }, [paneId]);
  useAddressBar({
    newSessionOpen, newFields, sidebarCollapsed, snapshot, selectedPaneId: paneId, selectedPane: pane,
    selectedWorkspace: snapshot.workspaces.find((workspace) => workspace.workspace_id === pane.workspace_id) as HerdrWorkspace,
    selectedMachineId: "local", selectedMachine: machine, machines: refs.machines.current, machinesRef: refs.machines,
    // Reopen files on return: a file left behind is hidden and its entry keeps it (lib/useFilePanels.ts)
    viewing, leaveFile: () => { place.viewing = null; draw(); return true; },
    restoreFile: () => {}, fileFromPop: () => 0, forgetLeftFiles: () => {}, openFile: () => {},
    locked: false, linkLanded: true, view: "chat", wideScreen: true, autoSelected: false, newTab: null,
    settingsOpen: false, settingsPage: null, settingsLinkPage: null, settingsLinkSection: null,
    pendingFile: refs.pendingFile, pendingLink: refs.pendingLink, pendingCreate: refs.pendingCreate, linkSince: refs.linkSince, rosterSeq: refs.rosterSeq,
    selectTargetRef: refs.selectTarget, selectionRef: refs.selection,
    setLinkLanded: () => {}, setHeaderNote: () => {},
    setNewSessionOpen: (open: boolean) => { place.newSessionOpen = open; draw(); },
  } as unknown as Params);
  return null;
}

const draw = (): void => { renderer?.update(createElement(Probe)); };
/** Draws at once, effects included, as React does in the microtask after a popstate listener that set state. */
const drawNow = (): void => { (renderer as unknown as { unstable_flushSync(run: () => void): void }).unstable_flushSync(draw); };

beforeEach(() => {
  for (const key of ["window", "IS_REACT_ACT_ENVIRONMENT"]) descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
  place = { paneId: "p2", newSessionOpen: false, newFields: null, sidebarCollapsed: false, snapshot: roster(), viewing: null };
  asked = [];
  writes = [];
  listeners = [];
  waiting = null;
  refs.selectTarget.current = (_machineId, paneId) => { asked.push(paneId); if (paneId !== null) { place.paneId = paneId; draw(); } };
  refs.pendingCreate.current = null;
  const write = (method: "pushState" | "replaceState") => (state: unknown, _unused: string, url?: string): void => {
    const entry = { state, url: url === undefined ? entries[index]!.url : new URL(url, entries[index]!.url) };
    if (method === "pushState") { entries.splice(index + 1); entries.push(entry); index += 1; } else entries[index] = entry;
    writes.push(`${method} ${index} ${entry.url.search}`);
  };
  const page = {
    event: undefined as Event | undefined,
    get location() { return entries[index]!.url; },
    history: {
      get state() { return entries[index]!.state; },
      pushState: write("pushState"), replaceState: write("replaceState"),
      // a traversal lands at once, and the browser names the event (`window.event`) to each listener in turn
      go: (steps: number): void => {
        index += steps;
        let stopped = false;
        const event = Object.assign(new Event("popstate"), { state: entries[index]!.state, stopImmediatePropagation: () => { stopped = true; } });
        for (const listener of [...listeners]) {
          if (stopped) break;
          page.event = event;
          try { listener(event); } finally { page.event = undefined; }
        }
      },
    },
    addEventListener: (_type: "popstate", listener: (event: Event) => void) => { listeners.push(listener); },
    removeEventListener: (_type: "popstate", listener: (event: Event) => void) => { listeners = listeners.filter((other) => other !== listener); },
  };
  Object.defineProperty(globalThis, "window", { configurable: true, value: page });
  // a listener from before the app mounts, as lib/settingsHistory.ts's is: what it sets is drawn, with
  // whatever else was waiting, before the address bar's listener runs
  window.addEventListener("popstate", () => {
    if (waiting === null) return;
    waiting();
    waiting = null;
    drawNow();
  });
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

async function mount(addresses: string[]): Promise<void> {
  entries = addresses.map((search) => ({ state: null, url: new URL(`http://localhost:7317/${search}`) }));
  index = entries.length - 1;
  await act(async () => { renderer = create(createElement(Probe)); });
  writes = [];
}
const addresses = (): string[] => entries.map((entry) => entry.url.search);
const back = (): Promise<void> => act(async () => { window.history.go(-1); });

it("says a popstate is unread only while it is being dispatched and the handler has not read it", () => {
  const pop = new Event("popstate");
  expect(popUnread(undefined, null)).toBe(false);
  expect(popUnread(undefined, pop)).toBe(false);
  expect(popUnread(pop, null)).toBe(true);
  expect(popUnread(pop, new Event("popstate"))).toBe(true);
  expect(popUnread(pop, pop)).toBe(false);
  expect(popUnread(new Event("click"), null)).toBe(false);
});

it("Back with nothing waiting selects the entry's pane and writes nothing", async () => {
  await mount([P1, P2]);

  await back();

  expect(asked).toEqual(["p1"]);
  expect(writes).toEqual([]);
  expect(addresses()).toEqual([P1, P2]);
});

it("Back selects the entry's pane while a roster is waiting to be drawn", async () => {
  // Given p2 shown on its entry, and a roster that has arrived and is not drawn yet.
  await mount([P1, P2]);
  waiting = () => { place.snapshot = roster(); };

  // When Back lands on p1's entry and React draws the roster before the address bar's listener runs.
  await back();

  // Then the entry still says p1 when it is read, and its pane is selected.
  expect(asked).toEqual(["p1"]);
  expect(place.paneId).toBe("p1");
  expect(writes).toEqual([]);
  expect(addresses()).toEqual([P1, P2]);
});

it("Back off the New workspace dialog's entry closes it while its fields are on their way to the address", async () => {
  // Given the dialog open on its entry, and its fields reported (after the dialog's 400 ms) but not drawn yet.
  const held = `${P1}&new=workspace&name=Held`;
  place = { ...place, paneId: "p1", newSessionOpen: true, newFields: { cwd: null, name: "Held", agent: null } };
  await mount([P1, held]);
  waiting = () => { place.newFields = { cwd: "/home/demo/api", name: "Held", agent: "codex" }; };

  // When Back lands on the entry without the dialog.
  await back();

  // Then the dialog closes, and neither entry was written over.
  expect(place.newSessionOpen).toBe(false);
  expect(addresses()).toEqual([P1, held]);
});

it("writes the place held back over the entry landed on, once, when that entry leads nowhere else", async () => {
  // Given two entries of the same pane, and a sidebar that collapsed but is not drawn yet.
  place = { ...place, paneId: "p1" };
  await mount([P1, P1]);
  waiting = () => { place.sidebarCollapsed = true; };

  // When Back lands on the first.
  await back();

  // Then the entry says what is shown, by one replace, and the entry left keeps its address.
  expect(asked).toEqual([]);
  expect(writes).toEqual([`replaceState 0 ${P1}&sidebar=hidden`]);
  expect(addresses()).toEqual([`${P1}&sidebar=hidden`, P1]);
});

it("replaces the entry landed on, and pushes nothing over it, when a waiting move to that entry's own pane is drawn first", async () => {
  // Given p2 shown on its entry, and a move to p1 with the sidebar collapsed that is not drawn yet.
  await mount([P1, P2]);
  waiting = () => { place.paneId = "p1"; place.sidebarCollapsed = true; };

  // When Back lands on p1's entry and React draws the move before the address bar's listener runs.
  await back();

  // Then the handler has no pane to select, the entry says what is shown by one replace, and Forward's entry is kept.
  expect(asked).toEqual([]);
  expect(writes).toEqual([`replaceState 0 ${P1}&sidebar=hidden`]);
  expect(addresses()).toEqual([`${P1}&sidebar=hidden`, P2]);
});

it("takes no file off a later entry after a move that kept a file was drawn while Back was landing", async () => {
  // Given a file shown over p1 on its own entry, and a move to p2 that is not drawn yet.
  const file: Preview = { path: "README.md", paneId: "p1", machineId: "local" };
  place = { ...place, paneId: "p1", viewing: file };
  await mount([P2, `${P1}&file=README.md`]);
  entries[1]!.state = { [FILE_PREVIEW_KEY]: file };
  waiting = () => { place.paneId = "p2"; };

  // When Back lands on p2's entry: the move is drawn first and leaves the file behind, kept on its entry.
  await back();

  // Then p2's entry already says what is shown, so nothing is written.
  expect(place.viewing).toBeNull();
  expect(writes).toEqual([]);

  // When a file then opens over p2 as an entry of its own, and its path goes to the address.
  const opened = { [FILE_PREVIEW_KEY]: { path: "notes.md", paneId: "p2", machineId: "local" } };
  await act(async () => { window.history.pushState(opened, ""); place.viewing = opened[FILE_PREVIEW_KEY]; draw(); });

  // Then that entry still holds its file: the file kept earlier was not this write's to take off.
  expect(addresses()).toEqual([P2, `${P2}&file=notes.md`]);
  expect(entries[index]!.state).toEqual(opened);
});

it("writes at once what a listener after the handler changes: the entry is read by then", async () => {
  // Given a listener added after the hook's (App.tsx has one) whose change is drawn before the dispatch ends.
  place = { ...place, paneId: "p1" };
  await mount([P1, P1]);
  let during: string[] = [];
  window.addEventListener("popstate", () => { place.sidebarCollapsed = true; drawNow(); during = [...writes]; });

  // When Back lands.
  await back();

  // Then the place shown was written while the popstate was still being dispatched.
  expect(during).toEqual([`replaceState 0 ${P1}&sidebar=hidden`]);
  expect(writes).toEqual(during);
});

it("holds nothing once the dispatch is over, though the handler never heard the pop", async () => {
  // Given a listener that draws what was waiting and then keeps the event from every later listener.
  await mount([P1, P2]);
  waiting = () => { place.snapshot = roster(); };
  window.addEventListener("popstate", (event) => { event.stopImmediatePropagation(); });
  // the listeners run in the order they were added: that one goes before the hook's
  listeners.splice(1, 0, listeners.pop()!);

  // When Back lands.
  await back();

  // Then nothing was written over the entry while it was unread, and the handler asked for nothing.
  expect(asked).toEqual([]);
  expect(writes).toEqual([]);

  // When the app draws again after the dispatch.
  await act(async () => { place.sidebarCollapsed = true; draw(); });

  // Then the address says what is shown.
  expect(writes).toEqual([`replaceState 0 ${P2}&sidebar=hidden`]);
});
