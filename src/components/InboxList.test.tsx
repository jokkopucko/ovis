import { afterEach, beforeEach, describe, expect, it, jest, mock, setSystemTime, spyOn } from "bun:test";
import { act, type ReactElement, type ReactNode } from "react";
import { openPage, type Page } from "../lib/page.fixture.ts";

import type { Machine } from "../../shared/machines.ts";
import type { AgentStatus, HerdrPane, InteractivePrompt, PaneSummaries, PaneSummary } from "../../shared/protocol.ts";
import machinesFixture from "../../site/demo/fixtures/machines.json";
import { inboxKey, inboxOrder, type InboxFilter } from "../lib/agentInbox.ts";
import * as api from "../lib/api.ts";
import type { HeaderConnection } from "../lib/headerConnection.ts";
import { PanePressContext } from "../lib/paneSubmitContext.ts";
import { SettingsProvider } from "../lib/settings.ts";
import { usageCounters } from "../lib/usageCounters.ts";
import type { SidebarActivity } from "../lib/sidebarActivity.tsx";

let answerPrompt: (prompt: InteractivePrompt | null) => void = () => {};
let promptReads = 0;
let presses: string[] = [];
await mock.module("../lib/api.ts", () => ({
  ...api,
  fetchPanePromptState: () => {
    promptReads++;
    return new Promise<{ prompt: InteractivePrompt | null }>((resolve) => { answerPrompt = (prompt) => resolve({ prompt }); });
  },
}));
const { InboxList } = await import("./InboxList.tsx");
const { newQuestionReads } = await import("../lib/useInboxQuestions.ts");
type InboxListHandle = import("../lib/useInbox.ts").InboxListHandle;
const { SummaryReads } = await import("../lib/useInboxSummaries.ts");
const { useAgentStateStamping } = await import("../lib/useAgentStateSince.ts");

function Stamping({ machines, activity }: { machines: Machine[]; activity: SidebarActivity }) {
  useAgentStateStamping(machines, activity);
  return null;
}

type SummaryCall = { machineId: string; paneIds: readonly string[]; resolve(answer: PaneSummaries | null): void };
let summaryCalls: SummaryCall[] = [];
const ago = (minutes: number): string => new Date(Date.now() - minutes * 60_000).toISOString();
const said = (text: string, at: string | null, more: Partial<PaneSummary> = {}): PaneSummary => ({ role: "assistant", text, at, asked_at: null, ...more });

const fixture: Machine[] = JSON.parse(JSON.stringify(machinesFixture.machines));
const activity: SidebarActivity = {
  seqs: () => new Map(),
  status: (_machineId, pane) => pane.agent_status as AgentStatus | undefined,
};

const statusOf = (moved: Record<string, AgentStatus>): SidebarActivity => ({
  seqs: () => new Map(),
  status: (_machineId, pane) => moved[pane.pane_id] ?? pane.agent_status as AgentStatus | undefined,
});

function roster(edit: (pane: HerdrPane) => HerdrPane = (pane) => pane, state: Machine["state"] = "connected"): Machine[] {
  return structuredClone(fixture).map((machine) => ({
    ...machine, state,
    snapshot: machine.snapshot === null ? null : { ...machine.snapshot, panes: machine.snapshot.panes.map(edit) },
  }));
}

const text = (node: Element): string => node.textContent ?? "";
const byClass = (root: Element, name: string) => [...root.querySelectorAll<HTMLElement>(`.${name}`)];

describe("InboxList", () => {
  const descriptors = new Map<string, PropertyDescriptor | undefined>();
  const prototypeDescriptors = new Map<string, PropertyDescriptor | undefined>();
  let page: Page;
  let questionReads: ReturnType<typeof newQuestionReads>;
  let summaryReads: InstanceType<typeof SummaryReads>;
  let phone: boolean;
  let frames: FrameRequestCallback[];
  const runFrames = (): Promise<void> => act(async () => { for (const run of frames.splice(0)) run(0); });

  beforeEach(() => {
    promptReads = 0;
    phone = true;
    frames = [];
    const never = () => () => {};
    questionReads = newQuestionReads(never);
    summaryCalls = [];
    summaryReads = new SummaryReads((machineId, paneIds) => new Promise((resolve) => { summaryCalls.push({ machineId, paneIds, resolve }); }), never);
    presses = [];
    page = openPage();
    Object.defineProperty(page.window, "matchMedia", { configurable: true, value: () => ({ matches: phone, addEventListener() {}, removeEventListener() {} }) });
    Object.defineProperty(page.window, "requestAnimationFrame", { configurable: true, value: (run: FrameRequestCallback) => frames.push(run) });
    Object.defineProperty(page.window, "cancelAnimationFrame", { configurable: true, value: () => {} });
    for (const [key, value] of Object.entries({ localStorage: page.window.localStorage, HTMLElement: page.window.HTMLElement, Node: page.window.Node })) {
      descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
      Object.defineProperty(globalThis, key, { configurable: true, value });
    }
    const prototype = page.window.HTMLElement.prototype;
    for (const key of ["focus", "scrollTop", "getClientRects"]) prototypeDescriptors.set(key, Object.getOwnPropertyDescriptor(prototype, key));
    const focus = prototype.focus;
    Object.defineProperty(prototype, "focus", { configurable: true, value(this: HTMLElement, options?: FocusOptions) {
      const classes = [...this.classList];
      const name = this.tagName === "SECTION" ? "section" : this.tagName === "INPUT" ? "input" : classes[0] === "icon-button" ? classes.find((part) => part.startsWith("inbox-") && part !== "inbox-round") ?? classes[0] : classes[0];
      if (name) {
        const label = this.getAttribute("aria-label");
        focused.push({ node: name, options, ...(name === "inbox-row" && label !== null ? { label } : {}) });
      }
      Reflect.apply(focus, this, [options]);
    } });
    const positions = new WeakMap<HTMLElement, number>();
    Object.defineProperty(prototype, "scrollTop", { configurable: true, get(this: HTMLElement) { return positions.get(this) ?? 0; }, set(this: HTMLElement, value: number) { positions.set(this, Math.min(value, scrollMax)); } });
    const rects = prototype.getClientRects;
    Object.defineProperty(prototype, "getClientRects", { configurable: true, value(this: HTMLElement) {
      return this.classList.contains("inbox-search-toggle") ? drawn.options.searchToggleHidden ? [] : [{}] : Reflect.apply(rects, this, []);
    } });
  });

  afterEach(async () => {
    jest.useRealTimers();
    await page.close();
    const prototype = page.window.HTMLElement.prototype;
    for (const [key, descriptor] of prototypeDescriptors) {
      if (descriptor) Object.defineProperty(prototype, key, descriptor);
      else Reflect.deleteProperty(prototype, key);
    }
    prototypeDescriptors.clear();
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    descriptors.clear();
  });

  interface DrawOptions {
    wide?: boolean; current?: string | null; filter?: InboxFilter; query?: string; watching?: boolean; activity?: SidebarActivity; scrollTop?: number;
    connection?: HeaderConnection;
    failure?: { error: string; retry(): Promise<void> | void } | null;
    opening?: number; focusTaken?: number;
    returnTo?: string | null;
    /** how far the scroller can scroll at first: a scrollTop past it is clamped, as a browser does */
    scrollMax?: number;
    searchToggleHidden?: boolean;
    more?: Parameters<typeof InboxList>[0]["more"]; note?: ReactNode;
    handle?: { current: InboxListHandle | null };
    onFilter?: (filter: InboxFilter) => void; onQuery?: (query: string) => void;
    onOpen?: (machineId: string, paneId: string) => void; onNew?: (machineId: string) => void;
  }
  let focused: { node: string; options?: FocusOptions; label?: string }[] = [];
  let scroll = { current: 0 };
  let taken = { current: 0 };
  let scrollMax = Number.POSITIVE_INFINITY;
  let drawn: { machines: Machine[]; options: DrawOptions } = { machines: [], options: {} };
  const view = (machines: Machine[], options: DrawOptions): ReactElement => <SettingsProvider><PanePressContext.Provider value={(machineId, paneId) => presses.push(`${machineId}/${paneId}`)}>
    <Stamping machines={machines} activity={options.activity ?? activity} />
    <InboxList ref={options.handle} machines={machines} activity={options.activity ?? activity} watching={options.watching ?? false} wide={options.wide ?? false} current={options.current ?? null}
      filter={options.filter ?? "all"} onFilter={options.onFilter ?? (() => {})} query={options.query ?? ""} onQuery={options.onQuery ?? (() => {})} scroll={scroll} focus={{ opening: options.opening ?? 1, taken, row: options.returnTo ?? null }}
      onOpen={options.onOpen ?? (() => {})} onNew={options.onNew ?? (() => {})} questionReads={questionReads} summaryReads={summaryReads} more={options.more} note={options.note} connection={options.connection ?? null} failure={options.failure ?? null} />
  </PanePressContext.Provider></SettingsProvider>;
  const draw = async (machines: Machine[], options: DrawOptions = {}) => {
    focused = [];
    scroll = { current: options.scrollTop ?? 0 };
    taken = { current: options.focusTaken ?? 0 };
    scrollMax = options.scrollMax ?? Number.POSITIVE_INFINITY;
    drawn = { machines, options };
    await page.render(view(machines, options));
    return page.container;
  };
  const redraw = async (change: { machines?: Machine[] } & DrawOptions) => {
    const { machines = drawn.machines, ...options } = change;
    drawn = { machines, options: { ...drawn.options, ...options } };
    await page.render(view(drawn.machines, drawn.options));
  };
  const order = (root: HTMLElement) => byClass(root, "inbox-item").map((node) => node.getAttribute("data-pane"));
  const twoPcs = (second: Machine["state"] = "connected"): Machine[] => {
    const [local] = roster();
    return [local!, { ...structuredClone(local!), id: "laptop", name: "Laptop", state: second }];
  };
  const item = (root: HTMLElement, paneId: string, machineId = "local") => byClass(root, "inbox-item").find((node) => node.getAttribute("data-pane") === paneId && node.getAttribute("data-machine") === machineId)!;
  const words = (root: HTMLElement, paneId: string, machineId = "local") => byClass(item(root, paneId, machineId), "inbox-words").map(text);
  const mark = (root: HTMLElement, paneId: string) => {
    const [slot] = byClass(item(root, paneId), "inbox-state");
    const [badge] = byClass(slot!, "sidebar-status");
    const label = badge!.getAttribute("aria-label");
    if (label === null) throw new Error("The state badge has no name");
    expect(badge!.getAttribute("title")).toBe(label);
    expect(byClass(badge!, "visually-hidden").map(text)).toEqual([label]);
    return { state: badge!.getAttribute("data-status"), label, drawn: String(slot!.getAttribute("class")).split(" ").includes("is-drawn") };
  };
  const question = (asked: string, body: string | null = null) => ({
    id: "p", agent: "codex", kind: "approval", title: "Approve", question: asked, body,
    options: [], multi_select: false, custom_option_index: null,
  }) as InteractivePrompt;
  const menus = () => [...page.container.ownerDocument.querySelectorAll<HTMLElement>(".row-sheet, .row-menu")];
  const menuItems = (menu: HTMLElement) => [...menu.querySelectorAll<HTMLButtonElement>("button[data-item]")];
  const menuLabel = (item: Element) => item.querySelector(".row-sheet-label, .menu-item-main")?.textContent;
  const pointerDown = (element: HTMLElement) => element.dispatchEvent(new page.window.PointerEvent("pointerdown", { bubbles: true, button: 0 }) as unknown as Event);
  const scroller = () => page.one(".inbox-scroll");
  const fire = (element: HTMLElement, type: string, bubbles = false) => element.dispatchEvent(new page.window.Event(type, { bubbles }) as unknown as Event);
  const escape = (element: HTMLElement, isComposing = false, keyCode = 27) => act(async () => {
    element.dispatchEvent(new page.window.KeyboardEvent("keydown", { key: "Escape", code: "Escape", isComposing, keyCode, bubbles: true, cancelable: true }) as unknown as Event);
  });

  it("draws one row per agent, in the inbox's order", async () => {
    const machines = roster();
    const root = await draw(machines);
    const keys = byClass(root, "inbox-item").map((node) => `${node.getAttribute("data-machine")}:${node.getAttribute("data-pane")}`);
    expect(keys).toEqual(inboxOrder(machines, activity).map(inboxKey));
    expect(keys.length).toBeGreaterThan(1);
  });

  it("has no heading and names the list for a screen reader", async () => {
    const root = await draw(roster());
    expect([...root.querySelectorAll("h1, h2, h3, h4, h5, h6")]).toEqual([]);
    expect(page.one("section").getAttribute("aria-label")).toBe("Agent inbox");
  });

  it("draws a row as two lines, a name and one line of words, with no chip, no place line and no button inside it", async () => {
    const root = await draw(roster());
    for (const node of byClass(root, "inbox-item")) {
      expect([byClass(node, "inbox-name").length, byClass(node, "inbox-words").length]).toEqual([1, 1]);
      expect([byClass(node, "inbox-chip").length, byClass(node, "inbox-place").length, byClass(node, "inbox-dot").length]).toEqual([0, 0, 0]);
      expect(node.querySelectorAll("button").length).toBe(1);
    }
  });

  it("ends a row with its state's mark, named in the words the chip and the filters use, and draws none for an agent at rest", async () => {
    const machines = roster((pane) => pane.pane_id === "w1F:p1" ? { ...pane, background_wait: true } as HerdrPane : pane);
    const waiting: SidebarActivity = { seqs: () => new Map(), status: (_machineId, pane) => pane.pane_id === "w1E:p1" ? "done" : pane.pane_id === "w1F:p1" ? "waiting" : pane.agent_status as AgentStatus | undefined };
    const root = await draw(machines, { activity: waiting });
    expect(mark(root, "w1D:p1")).toEqual({ state: "blocked", label: "Needs you", drawn: true });
    expect(mark(root, "w1C:p1")).toEqual({ state: "working", label: "Working", drawn: true });
    expect(mark(root, "w1F:p1")).toEqual({ state: "waiting", label: "Working, waiting on background work", drawn: true });
    expect(String(byClass(item(root, "w1F:p1"), "inbox-row")[0]!.getAttribute("aria-label")).split(", ").at(-1)).toBe("Working");
    expect(mark(root, "w1E:p1")).toEqual({ state: "done", label: "Done", drawn: true });
    await redraw({ activity });
    expect(mark(root, "w1E:p1")).toEqual({ state: "idle", label: "Ready", drawn: false });
  });

  it("draws a mark for every state when the device asks for herdr's indicators", async () => {
    page.window.localStorage.setItem("ovis:settings", JSON.stringify({ statusIndicators: "dots" }));
    const root = await draw(roster());
    expect(mark(root, "w1E:p1").drawn).toBe(true);
  });

  it("says a state's word where the agent has no words of its own, and where a resting agent runs", async () => {
    const root = await draw(roster(), { activity: statusOf({ "w1E:p1": "done" }) });
    expect(words(root, "w1D:p1")).toEqual(["Needs you"]);
    expect(words(root, "w1C:p1")).toEqual(["Working"]);
    expect(words(root, "w1E:p1")).toEqual(["Done"]);
    expect(words(root, "w1F:p1")).toEqual(["docs-site"]);
  });

  it("says Ready for a resting agent whose name already says where it runs", async () => {
    const root = await draw(roster((pane) => pane.pane_id === "w1F:p1" ? { ...pane, label: "docs-site" } as HerdrPane : pane));
    expect(byClass(item(root, "w1F:p1"), "inbox-name").map(text)).toEqual(["docs-site"]);
    expect(words(root, "w1F:p1")).toEqual(["Ready"]);
  });

  it("says what a working agent is on from its plan", async () => {
    const plan = { current: "Write the export guard test", done: 1, total: 3 };
    const root = await draw(roster((pane) => pane.pane_id === "w1C:p1" ? { ...pane, plan } as HerdrPane : pane));
    expect(words(root, "w1C:p1")).toEqual(["Write the export guard test"]);
  });

  it("shows the question a waiting agent asks, on the one line", async () => {
    const root = await draw(roster());
    expect(promptReads).toBe(1);
    await act(async () => { answerPrompt(question("Run the export tests?", "bun test ./src/export.test.ts")); });
    expect(words(root, "w1D:p1")).toEqual(["Run the export tests?\nbun test ./src/export.test.ts"]);
    expect(byClass(item(root, "w1D:p1"), "inbox-words")[0]!.getAttribute("dir")).toBe("auto");
  });

  it("draws the rows that ask for a look one step stronger: needs you and done, never working or resting", async () => {
    const root = await draw(roster(), { activity: statusOf({ "w1E:p1": "done" }) });
    const asking = (paneId: string) => String(item(root, paneId).getAttribute("class")).split(" ").includes("is-asking");
    expect([asking("w1D:p1"), asking("w1E:p1"), asking("w1C:p1"), asking("w1F:p1")]).toEqual([true, true, false, false]);
  });

  it("groups the rows under one short header line per PC, in the PCs' order, when more than one PC is shown, and draws no header for one", async () => {
    const one = await draw(roster());
    expect(byClass(one, "machine-header")).toEqual([]);
    expect(words(one, "w1C:p1")).toEqual(["Working"]);
    await page.render(null);
    const root = await draw(twoPcs());
    const groups = byClass(root, "machine-group");
    expect(groups.map((group) => [group.getAttribute("aria-label"), byClass(group, "machine-header").length, byClass(group, "machine-name").map(text)])).toEqual([
      ["PC workstation", 1, ["workstation"]], ["PC Laptop", 1, ["Laptop"]],
    ]);
    for (const [index, id] of [[0, "local"], [1, "laptop"]] as const) {
      const ids = byClass(groups[index]!, "inbox-item").map((node) => node.getAttribute("data-machine"));
      expect(ids.length).toBeGreaterThan(0);
      expect(new Set(ids)).toEqual(new Set([id]));
    }
    expect(words(root, "w1C:p1", "local")).toEqual(["Working"]);
    expect(words(root, "w1C:p1", "laptop")).toEqual(["Working"]);
  });

  it("folds a PC's group from its header as the sidebar folds that PC, the same fold kept for both, and opens it again", async () => {
    const root = await draw(twoPcs());
    const laptop = () => byClass(root, "machine-group").find((group) => group.getAttribute("aria-label") === "PC Laptop")!;
    const title = () => byClass(laptop(), "machine-title")[0]!;
    expect([title().tagName.toLowerCase(), title().getAttribute("aria-expanded"), title().getAttribute("aria-label")]).toEqual(["button", "true", "Collapse Laptop"]);
    await act(async () => { title().click(); });
    expect([title().getAttribute("aria-expanded"), title().getAttribute("aria-label"), String(laptop().getAttribute("class")).split(" ").includes("is-folded")]).toEqual(["false", "Expand Laptop", true]);
    expect(byClass(laptop(), "inbox-item")).toEqual([]);
    expect(byClass(root, "inbox-item").every((node) => node.getAttribute("data-machine") === "local")).toBe(true);
    expect(page.window.localStorage.getItem("ovis:pc-collapsed:laptop")).toBe("1");
    await page.render(null);
    const again = await draw(twoPcs());
    expect(byClass(again, "inbox-item").some((node) => node.getAttribute("data-machine") === "laptop")).toBe(false);
    const reopen = byClass(byClass(again, "machine-group").find((group) => group.getAttribute("aria-label") === "PC Laptop")!, "machine-toggle")[0]!;
    await act(async () => { reopen.click(); });
    expect(byClass(again, "inbox-item").some((node) => node.getAttribute("data-machine") === "laptop")).toBe(true);
    expect(page.window.localStorage.getItem("ovis:pc-collapsed:laptop")).toBe("0");
  });

  it("draws only the groups a filter or a query leaves a row in", async () => {
    const root = await draw(twoPcs(), { query: "Laptop" });
    expect(byClass(root, "machine-group").map((group) => group.getAttribute("aria-label"))).toEqual(["PC Laptop"]);
  });

  it("draws a PC that is away as disabled rows that say Offline, with no mark, and open nothing", async () => {
    const opened: string[] = [];
    const root = await draw(roster(undefined, "disconnected"), { onOpen: (machineId, paneId) => opened.push(`${machineId}/${paneId}`) });
    const items = byClass(root, "inbox-item");
    expect(items.length).toBeGreaterThan(0);
    for (const node of items) {
      const row = byClass(node, "inbox-row")[0]!;
      expect(row.matches(":disabled")).toBe(true);
      expect(String(node.getAttribute("class")).split(" ")).toContain("is-offline");
      expect(byClass(node, "inbox-words").map(text)).toEqual(["Offline"]);
      expect(String(byClass(node, "inbox-state")[0]!.getAttribute("class")).split(" ")).not.toContain("is-drawn");
      await act(async () => { pointerDown(row); });
    }
    expect(presses).toEqual([]);
    expect(opened).toEqual([]);
    expect(byClass(root, "inbox-add").length).toBe(0);
  });

  it("says Offline on the rows of a PC that is away when several PCs are shown, its header faded with its dot", async () => {
    const root = await draw(twoPcs("disconnected"));
    expect(words(root, "w1D:p1", "laptop")).toEqual(["Offline"]);
    const laptop = byClass(root, "machine-group").find((group) => group.getAttribute("aria-label") === "PC Laptop")!;
    expect(String(laptop.getAttribute("class")).split(" ")).toContain("is-offline");
    expect(byClass(laptop, "machine-dot").map((node) => [node.getAttribute("class"), node.getAttribute("title")])).toEqual([["machine-dot is-disconnected", "Disconnected"]]);
  });

  it("names a row for a screen reader: the agent's kind, its name, its state, then its words", async () => {
    const plan = { current: "Write the export guard test", done: 1, total: 3 };
    const root = await draw(roster((pane) => pane.pane_id === "w1C:p1" ? { ...pane, plan } as HerdrPane : pane));
    const label = (paneId: string) => byClass(item(root, paneId), "inbox-row")[0]!.getAttribute("aria-label");
    expect(label("w1C:p1")).toBe("Claude Code, Idempotent payments, Working, Write the export guard test");
    expect(label("w1D:p1")).toBe("Codex, Guard the export button, Needs you");
  });

  it("opens a row's agent on its PC when pressed", async () => {
    const opened: string[] = [];
    const root = await draw(roster(), { onOpen: (machineId, paneId) => opened.push(`${machineId}/${paneId}`) });
    const row = byClass(item(root, "w1C:p1"), "inbox-row")[0]!;
    await act(async () => { pointerDown(row); row.click(); });
    expect(presses).toEqual(["local/w1C:p1"]);
    expect(opened).toEqual(["local/w1C:p1"]);
  });

  it("offers the four state filters as one choice behind its round button, and tells the chosen one", async () => {
    const asked: InboxFilter[] = [];
    const root = await draw(roster(), { onFilter: (filter) => asked.push(filter) });
    const button = () => byClass(root, "inbox-filter-toggle")[0]!;
    expect(button().getAttribute("aria-label")).toBe("Filter by state");
    expect(String(button().getAttribute("class")).split(" ")).not.toContain("is-on");
    expect(menus().length).toBe(0);

    await act(async () => { button().click(); });
    const [menu] = menus();
    expect(menu!.querySelectorAll('[role="menuitemradio"]')).toHaveLength(4);
    expect(menu!.getAttribute("aria-label")).toBe("Filter by state");
    expect(menuItems(menu!).map((entry) => `${entry.getAttribute("data-item")}:${menuLabel(entry)}:${entry.getAttribute("aria-checked")}`)).toEqual(["all:All:true", "blocked:Needs you:false", "working:Working:false", "done:Done:false"]);
    await act(async () => { menuItems(menu!)[2]!.click(); });
    expect(asked).toEqual(["working"]);

    await redraw({ filter: "working" });
    expect(button().getAttribute("aria-label")).toBe("Filter by state: Working");
    expect(String(button().getAttribute("class")).split(" ")).toContain("is-on");
    expect(byClass(root, "inbox-item").map((node) => node.getAttribute("data-state"))).toEqual(["working"]);
  });

  it("says its menus are sheets at a phone's width and popovers beyond it", async () => {
    const root = await draw(twoPcs());
    expect([byClass(root, "inbox-filter-toggle")[0]!.getAttribute("aria-haspopup"), byClass(root, "inbox-add")[0]!.getAttribute("aria-haspopup")]).toEqual(["dialog", "dialog"]);
    await page.render(null);
    phone = false;
    const wide = await draw(twoPcs(), { wide: true });
    expect([byClass(wide, "inbox-filter-toggle")[0]!.getAttribute("aria-haspopup"), byClass(wide, "inbox-add")[0]!.getAttribute("aria-haspopup")]).toEqual(["menu", "menu"]);
  });

  it("narrows the list to the rows a query matches, by name and by the words a row shows", async () => {
    const root = await draw(roster(), { query: "Guard the export button" });
    expect(order(root)).toEqual(["w1D:p1"]);
    await redraw({ query: "" });
    await act(async () => { answerPrompt(question("Allow rm of node_modules?")); });
    await redraw({ query: "node_modules" });
    expect(order(root)).toEqual(["w1D:p1"]);
  });

  it("offers Clear search only for a query, and clears it", async () => {
    const queries: string[] = [];
    const root = await draw(roster(), { onQuery: (query) => queries.push(query) });
    expect(byClass(root, "inbox-search-clear").length).toBe(0);
    await redraw({ query: "export" });
    await act(async () => { byClass(root, "inbox-search-clear")[0]!.click(); });
    expect(queries).toEqual([""]);
  });

  it("says why it draws no row, and what to do next where there is something to do", async () => {
    const empty = (): Machine[] => roster().map((machine) => ({ ...machine, snapshot: machine.snapshot && { ...machine.snapshot, panes: [] } }));
    const loading = await draw([]);
    expect(byClass(loading, "inbox-empty").map(text)).toEqual(["Loading…"]);
    await page.render(null);

    const none = await draw(empty());
    expect(byClass(none, "inbox-add").length).toBe(1);
    const lines = (root: HTMLElement) => [...byClass(root, "inbox-empty")[0]!.querySelectorAll("span")].map(text);
    expect(lines(none)).toEqual(["Nothing is running yet", "Use + to start a workspace"]);
    expect(byClass(none, "inbox-empty").map(text)).toEqual(["Nothing is running yet Use + to start a workspace"]);
    await page.render(null);

    // no plus is offered to a watching device, nor with no PC connected: the line names none
    const watching = await draw(empty(), { watching: true });
    expect(byClass(watching, "inbox-add").length).toBe(0);
    expect(byClass(watching, "inbox-empty").map(text)).toEqual(["Nothing is running yet"]);
    await page.render(null);
    const away = await draw(empty().map((machine) => ({ ...machine, state: "disconnected" as const })));
    expect(byClass(away, "inbox-add").length).toBe(0);
    expect(byClass(away, "inbox-empty").map(text)).toEqual(["Nothing is running yet"]);
    await page.render(null);

    const unmatched = await draw(roster(), { query: "nothing is called this" });
    expect(byClass(unmatched, "inbox-empty").map(text)).toEqual(["No results"]);
    expect(byClass(unmatched, "inbox-rows").length).toBe(0);
  });

  it("says a failed load with its cause and a Retry that loads again, where a load in flight says it is loading", async () => {
    const retries: string[] = [];
    const failure = { error: "Failed to fetch", retry: () => { retries.push("retry"); } };
    const alerts = (root: HTMLElement) => [...root.querySelectorAll('[role="alert"]')];
    const buttons = (node: HTMLElement) => [...node.querySelectorAll("button")];

    const loading = await draw([]);
    expect([alerts(loading).length, byClass(loading, "inbox-empty").map((node) => node.getAttribute("role"))]).toEqual([0, ["status"]]);
    await page.render(null);

    for (const wide of [false, true]) {
      phone = !wide;
      const failed = await draw([], { wide, failure });
      const [alert, ...others] = alerts(failed);
      expect([others.length, byClass(failed, "inbox-empty").length, byClass(failed, "inbox-rows").length]).toEqual([0, 0, 0]);
      expect([byClass(alert!, "inbox-failed-line").map(text), byClass(alert!, "inbox-failed-cause").map(text)]).toEqual([["Couldn't load the list."], ["Failed to fetch"]]);
      const [retry, ...more] = buttons(byClass(failed, "inbox-failed")[0]!);
      expect([more.length, retry!.getAttribute("type"), retry!.getAttribute("class")]).toEqual([0, "button", "btn inbox-retry"]);
      await act(async () => { retry!.click(); });
      expect(retries).toEqual(wide ? ["retry", "retry"] : ["retry"]);
      await page.render(null);
    }

    const silent = await draw([], { failure: { ...failure, error: "" } });
    expect([byClass(silent, "inbox-failed-line").length, byClass(silent, "inbox-failed-cause").length]).toEqual([1, 0]);
    await page.render(null);

    const empty = roster().map((machine) => ({ ...machine, snapshot: machine.snapshot && { ...machine.snapshot, panes: [] } }));
    const none = await draw(empty, { failure });
    expect([alerts(none).length, byClass(none, "inbox-empty").length]).toEqual([1, 0]);
    await page.render(null);

    const kept = await draw(roster(), { failure });
    expect([alerts(kept).length, byClass(kept, "inbox-item").length > 0]).toEqual([0, true]);
  });

  it("holds Retry in its box while its read is on its way: it says so and takes no press, and the loading words stand in for the failure", async () => {
    let release = (): void => undefined;
    const presses: string[] = [];
    const failure = { error: "Failed to fetch", retry: () => { presses.push("retry"); return new Promise<void>((resolve) => { release = resolve; }); } };
    const said = (button: HTMLElement) => [...button.querySelectorAll("span:not([aria-hidden])")].filter((node) => node.firstChild?.nodeType === 3).map(text);
    const live = (root: HTMLElement) => byClass(root, "inbox-failed-words").map((node) => [node.getAttribute("role"), byClass(node, "inbox-failed-line").map(text)[0], byClass(node, "inbox-failed-cause").map((cause) => cause.getAttribute("aria-hidden") ?? null)]);
    for (const wide of [false, true]) {
      phone = !wide;
      const failed = await draw([], { wide, failure });
      const retry = () => byClass(failed, "inbox-retry")[0]!;
      expect([live(failed), retry().getAttribute("aria-disabled"), retry().getAttribute("aria-busy"), said(retry())]).toEqual([[["alert", "Couldn't load the list.", [null]]], null, null, ["Retry"]]);

      await act(async () => { retry().click(); });
      await act(async () => { retry().click(); });

      expect(presses.length).toBe(wide ? 2 : 1);
      expect([live(failed), retry().getAttribute("aria-disabled"), retry().getAttribute("aria-busy"), said(retry())]).toEqual([[["status", "Loading…", ["true"]]], "true", "true", ["Retrying…"]]);

      await act(async () => { release(); });
      expect([live(failed), retry().getAttribute("aria-disabled"), retry().getAttribute("aria-busy"), said(retry())]).toEqual([[["alert", "Couldn't load the list.", [null]]], null, null, ["Retry"]]);
      await page.render(null);
    }
  });

  it("gives the focus to the list when its failure gives way to rows, on both layouts, unless the focus is somewhere else", async () => {
    const failure = { error: "Failed to fetch", retry: () => {} };
    for (const wide of [false, true]) {
      phone = !wide;
      await draw([], { wide, failure });
      expect(byClass(page.container, "inbox-retry")).toHaveLength(1);
      await act(async () => page.one("section").blur());
      focused.length = 0;

      await redraw({ machines: roster() });

      expect([byClass(page.container, "inbox-retry").length, byClass(page.container, "inbox-item").length > 0]).toEqual([0, true]);
      expect(focused).toEqual([{ node: "section", options: { preventScroll: true } }]);
      await page.render(null);

      const elsewhere = page.window.document.createElement("input");
      page.window.document.body.append(elsewhere);
      await draw([], { wide, failure });
      await act(async () => elsewhere.focus());
      focused.length = 0;

      await redraw({ machines: roster() });
      expect(focused).toEqual([]);
      elsewhere.remove();
      await page.render(null);
    }
  });

  it("says what the connection has to say in one status line, and draws nothing while it has nothing to say", async () => {
    const line = (root: HTMLElement) => [...root.querySelectorAll('p[role="status"]')].filter((node) => /inbox-connection|visually-hidden/.test(node.className))
      .filter((node) => byClass(root, "inbox-empty").every((empty) => empty !== node));
    const root = await draw(roster());
    await runFrames();
    expect(line(root).map((node) => [node.getAttribute("class"), text(node)])).toEqual([["visually-hidden", ""]]);

    await redraw({ connection: "reconnecting" });

    expect(line(root).map((node) => [node.getAttribute("class"), text(node)])).toEqual([["inbox-connection", "Reconnecting…"]]);
    const top = byClass(root, "inbox-top")[0]!;
    expect(top.querySelectorAll('[class="inbox-connection"]').length).toBe(1);

    await redraw({ connection: "connected" });
    expect(line(root).map((node) => text(node))).toEqual(["Connected"]);
    await redraw({ connection: null });
    expect(line(root).map((node) => [node.getAttribute("class"), text(node)])).toEqual([["visually-hidden", ""]]);
  });

  it("says nothing of the connection as the column beside a thread: the mode's rail says it there, whatever the list is handed", async () => {
    phone = false;
    const root = await draw(roster(), { wide: true, connection: "reconnecting" });
    await runFrames();
    const lines = () => byClass(root, "inbox-top")[0]!.querySelectorAll('[role="status"]').length + byClass(root, "inbox-connection").length;
    expect(lines()).toBe(0);
    await act(async () => { byClass(root, "inbox-search-toggle")[0]!.click(); });
    expect(byClass(root, "inbox-search-input").length).toBe(1);
    expect(lines()).toBe(0);
  });

  it("offers New workspace on the one connected PC, and none to a watching device", async () => {
    const asked: string[] = [];
    const root = await draw(roster(), { onNew: (machineId) => asked.push(machineId) });
    await act(async () => { byClass(root, "inbox-add")[0]!.click(); });
    expect(asked).toEqual(["local"]);
    expect(menus().length).toBe(0);
    await page.render(null);
    expect(byClass(await draw(roster(), { watching: true }), "inbox-add").length).toBe(0);
  });

  it("asks which PC first when two are connected, starts on the one picked, and closes the sheet when the choice goes", async () => {
    const asked: string[] = [];
    const root = await draw(twoPcs(), { onNew: (machineId) => asked.push(machineId) });
    await act(async () => { byClass(root, "inbox-add")[0]!.click(); });
    const [menu] = menus();
    expect(menuItems(menu!).map((entry) => `${entry.getAttribute("data-item")}:${menuLabel(entry)}`)).toEqual(["local:workstation", "laptop:Laptop"]);
    expect(asked).toEqual([]);
    await act(async () => { menuItems(menu!)[1]!.click(); });
    expect(asked).toEqual(["laptop"]);

    await redraw({ machines: twoPcs("disconnected") });
    expect(menus().length).toBe(0);
    await redraw({ machines: twoPcs() });
    expect(menus().length).toBe(0);
  });

  it("counts a search once as it begins, New workspace only when one starts, and a row under its own PC", async () => {
    const told: string[] = [];
    const counting = spyOn(usageCounters, "count").mockImplementation((name) => { told.push(name); });
    const paneUses = spyOn(usageCounters, "paneUse").mockImplementation((name, machineId) => { told.push(`${name}@${machineId}`); });
    try {
      const root = await draw(twoPcs(), { wide: true });
      await act(async () => { byClass(root, "inbox-search-toggle")[0]!.click(); });
      const type = (value: string) => page.type(page.one<HTMLInputElement>(".inbox-search-input"), value);
      await type("a");
      await redraw({ query: "a" });
      await type("ab");
      expect(told).toEqual(["inbox_search"]);
      await redraw({ query: "" });
      told.length = 0;
      await act(async () => { byClass(root, "inbox-add")[0]!.click(); });
      expect(told).toEqual([]);
      await act(async () => { menuItems(menus()[0]!)[1]!.click(); });
      expect(told).toEqual(["new_workspace_by_button"]);
      told.length = 0;
      const items = byClass(root, "inbox-item").filter((node) => !String(node.getAttribute("class")).includes("is-offline"));
      for (const item of items) await act(async () => { byClass(item, "inbox-row")[0]!.click(); });
      expect(told).toEqual(items.map((item) => `inbox_open@${item.getAttribute("data-machine")}`));
      expect(new Set(told).size).toBeGreaterThan(1);
    } finally { counting.mockRestore(); paneUses.mockRestore(); }
  });

  it("keeps the drawn order while the focus is in the list or just after a press, and draws the new order once the focus leaves", async () => {
    const root = await draw(roster());
    const before = order(root);
    const moved = statusOf({ "w1E:p1": "blocked" });
    expect(inboxOrder(roster(), moved).map((row) => row.entry.pane.pane_id)).not.toEqual(before);
    const list = () => byClass(root, "inbox-groups")[0]!;
    const focusOn = (ring: boolean) => {
      const row = byClass(list(), "inbox-row")[0]!;
      const matches = row.matches.bind(row);
      Object.defineProperty(row, "matches", { configurable: true, value: (selector: string) => selector === ":focus-visible" ? ring : matches(selector) });
      fire(row, "focusin", true);
    };
    await act(async () => { focusOn(true); });
    await redraw({ activity: moved });
    expect(order(root)).toEqual(before);
    await act(async () => { fire(list(), "focusout", true); });
    expect(order(root)).toEqual(inboxOrder(roster(), moved).map((row) => row.entry.pane.pane_id));

    await redraw({ activity });
    await act(async () => { focusOn(false); });
    await redraw({ activity: moved });
    expect(order(root)).toEqual(inboxOrder(roster(), moved).map((row) => row.entry.pane.pane_id));
    await act(async () => { fire(list(), "focusout", true); });

    await redraw({ activity });
    await act(async () => { pointerDown(list()); });
    await redraw({ activity: moved });
    expect(order(root)).toEqual(before);
  });

  it("opens at the kept scroll place with the focus on the list's section, and keeps each new place", async () => {
    await draw(roster(), { scrollTop: 240 });
    expect(scroller().scrollTop).toBe(240);
    expect(focused).toEqual([{ node: "section", options: { preventScroll: true } }]);
    await act(async () => { scroller().scrollTop = 610; fire(scroller(), "scroll"); });
    expect(scroll.current).toBe(610);
  });

  it("goes to its top and takes the focus on its own section when the shell asks, and the kept place is the top from then on", async () => {
    const handle: { current: InboxListHandle | null } = { current: null };
    await draw(roster(), { wide: true, scrollTop: 240, scrollMax: 200, focusTaken: 1, handle });
    expect([scroller().scrollTop, focused]).toEqual([200, []]);

    await act(async () => { handle.current!.toTop(); });

    expect([scroller().scrollTop, scroll.current]).toEqual([0, 0]);
    expect(focused).toEqual([{ node: "section", options: { preventScroll: true } }]);

    scrollMax = Number.POSITIVE_INFINITY;
    await answerSummaries({ "w1E:p1": said("All six export tests pass.", ago(6.5)) });
    expect(scroller().scrollTop).toBe(0);
  });

  it("gives the focus to the row whose thread a Back just left, and to its own section when that row is not drawn", async () => {
    const root = await draw(roster(), { opening: 2, focusTaken: 1, returnTo: "local:w1C:p1" });

    const spoken = item(root, "w1C:p1").querySelector("button")?.getAttribute("aria-label");
    if (spoken == null) throw new Error("The return row has no name");
    expect(focused).toEqual([{ node: "inbox-row", options: { preventScroll: true }, label: spoken }]);
    await page.render(null);

    await draw(roster(), { opening: 2, focusTaken: 1, returnTo: "local:w1C:p1", filter: "blocked" });

    expect(focused).toEqual([{ node: "section", options: { preventScroll: true } }]);
  });

  it("takes the focus once for each time it opens, and none when it is only drawn again for another width", async () => {
    await draw(roster());
    expect(focused.map((call) => call.node)).toEqual(["section"]);
    expect(taken.current).toBe(1);

    await page.render(null);
    await draw(roster(), { wide: true, current: "local:w1C:p1", focusTaken: 1 });

    expect(focused).toEqual([]);

    await redraw({ current: null, opening: 2 });

    expect(focused.map((call) => call.node)).toEqual(["section"]);
    await redraw({ query: "export" });
    expect(focused.map((call) => call.node)).toEqual(["section"]);
  });

  it("reaches the kept scroll place once the waiting row's question is back, unless the reader scrolled meanwhile", async () => {
    await draw(roster(), { scrollTop: 167, scrollMax: 127 });
    expect(scroller().scrollTop).toBe(127);
    scrollMax = 400;
    await act(async () => { answerPrompt(question("Run the export tests?")); });
    expect(scroller().scrollTop).toBe(167);
    expect(scroll.current).toBe(167);
    await page.render(null);

    await draw(roster(), { scrollTop: 167, scrollMax: 127 });
    const scrollNode = scroller();
    await act(async () => {
      fire(page.one("section"), "touchstart", true);
      scrollNode.scrollTop = 40;
      fire(scrollNode, "scroll");
    });
    scrollMax = 400;
    await redraw({ activity: { ...activity, seqs: () => new Map([["w1D:p1", 5]]) } });
    expect(scrollNode.scrollTop).toBe(40);
    expect(scroll.current).toBe(40);
  });


  const answerSummaries = async (summaries: Record<string, PaneSummary>) => {
    const call = summaryCalls.at(-1)!;
    await act(async () => { call.resolve({ server_time: new Date().toISOString(), summaries: Object.fromEntries(call.paneIds.map((id) => [id, summaries[id] ?? null])) }); });
  };
  const times = (root: HTMLElement, paneId: string) => [...item(root, paneId).querySelectorAll("time")];
  const age = (root: HTMLElement, paneId: string) => times(root, paneId).map(text);
  const label = (root: HTMLElement, paneId: string) => byClass(item(root, paneId), "inbox-row")[0]!.getAttribute("aria-label");

  it("shows a done agent's last words in place of Done, and how long it has been done at the end of its name", async () => {
    const at = ago(6.5);
    const root = await draw(roster(), { activity: statusOf({ "w1E:p1": "done" }) });
    expect(words(root, "w1E:p1")).toEqual(["Done"]);
    await answerSummaries({ "w1E:p1": said("All six export tests pass.", at) });
    expect(words(root, "w1E:p1")).toEqual(["All six export tests pass."]);
    expect(age(root, "w1E:p1")).toEqual(["6m"]);
    const [time] = times(root, "w1E:p1");
    expect(time!.getAttribute("class")).toBe("inbox-time");
    expect(time!.parentElement!.getAttribute("class")).toBe("inbox-line");
    expect(Math.abs(Date.parse(time!.getAttribute("datetime") ?? "") - Date.parse(at))).toBeLessThan(1000);
    expect(label(root, "w1E:p1")).toBe("Gajae Code, Why did the backup fail?, Done, All six export tests pass., 6m");
  });

  it("shows a resting agent's last words in place of where it runs, the user's own message marked as theirs", async () => {
    const root = await draw(roster());
    expect(words(root, "w1F:p1")).toEqual(["docs-site"]);
    await answerSummaries({ "w1F:p1": said("Run the export tests again", ago(2.5), { role: "user" }) });
    expect(words(root, "w1F:p1")).toEqual(["You: Run the export tests again"]);
  });

  const NOW = 1_800_000_000_000;
  const atClock = async (minutesAgo: number, run: () => Promise<void>): Promise<void> => { jest.setSystemTime(new Date(NOW - minutesAgo * 60_000)); await run(); };
  const tick = (): Promise<void> => atClock(0.5, () => act(async () => { jest.advanceTimersByTime(30_000); }));
  const withClock = async (run: () => Promise<void>): Promise<void> => {
    jest.useFakeTimers();
    try { await run(); } finally {
      await page.render(null);
      jest.useRealTimers();
      setSystemTime();
    }
  };

  it("keeps a waiting agent's question as its words and says how long it has waited since this device saw the wait begin", () => withClock(async () => {
    let root!: HTMLElement;
    await atClock(40, async () => { root = await draw(roster(), { activity: statusOf({ "w1D:p1": "working" }) }); });
    await atClock(3.5, () => redraw({ activity }));
    await atClock(1, async () => {
      await act(async () => { answerPrompt(question("Run the export tests?")); });
      await answerSummaries({ "w1D:p1": said("I will run the export tests next.", ago(39.5)) });
    });
    await tick();
    expect(words(root, "w1D:p1")).toEqual(["Run the export tests?"]);
    expect(age(root, "w1D:p1")).toEqual(["3m"]);
  }));

  it("times a waiting row from the wait this device saw begin, else from the agent's last message, and draws none with neither", () => withClock(async () => {
    const both = statusOf({ "w1E:p1": "blocked" });
    let root!: HTMLElement;
    await atClock(3.5, async () => { root = await draw(roster(), { activity: both }); });
    await atClock(0, () => answerSummaries({ "w1D:p1": said("I will run the export tests next.", ago(40.5)) }));

    expect([age(root, "w1D:p1"), times(root, "w1E:p1")]).toEqual([["40m"], []]);

    await atClock(10, () => redraw({ activity: statusOf({ "w1D:p1": "working", "w1E:p1": "blocked" }) }));
    await atClock(2.5, () => redraw({ activity: both }));
    await tick();
    expect(age(root, "w1D:p1")).toEqual(["2m"]);
  }));

  it("marks a done row whose last words are a failed request with the failed mark and says Turn failed, never Done", async () => {
    const root = await draw(roster(), { activity: statusOf({ "w1E:p1": "done", "w1F:p1": "done" }) });
    await answerSummaries({ "w1E:p1": said("Error: rate limited", ago(1.5), { failed: true }), "w1F:p1": said("All good.", ago(1.5)) });
    const failed = byClass(item(root, "w1E:p1"), "sidebar-status")[0]!;
    expect([failed.getAttribute("data-status"), failed.getAttribute("aria-label"), failed.getAttribute("class")]).toEqual(["failed", "Turn failed", "badge badge-blocked sidebar-status"]);
    expect(label(root, "w1E:p1")).toBe("Gajae Code, Why did the backup fail?, Turn failed, Error: rate limited, 1m");
    expect(mark(root, "w1F:p1")).toEqual({ state: "done", label: "Done", drawn: true });
    expect(String(item(root, "w1E:p1").getAttribute("class")).split(" ")).toContain("is-asking");
  });

  it("draws nothing, and throws nothing, for a summary whose text is not text", async () => {
    const root = await draw(roster(), { activity: statusOf({ "w1E:p1": "done" }) });
    await answerSummaries({ "w1E:p1": { text: 5 } as unknown as PaneSummary });
    expect(words(root, "w1E:p1")).toEqual(["Done"]);
    expect(times(root, "w1E:p1")).toEqual([]);
  });

  it("keeps a working agent's plan step as its words and times it from the user's last ask", async () => {
    const plan = { current: "Write the export guard test", done: 1, total: 3 };
    const root = await draw(roster((pane) => pane.pane_id === "w1C:p1" ? { ...pane, plan } as HerdrPane : pane));
    await answerSummaries({ "w1C:p1": said("Reading the export module.", ago(30.5), { asked_at: ago(2.5) }) });
    expect(words(root, "w1C:p1")).toEqual(["Write the export guard test"]);
    expect(age(root, "w1C:p1")).toEqual(["2m"]);
  });

  it("draws the last words without Markdown's marks", async () => {
    const root = await draw(roster(), { activity: statusOf({ "w1E:p1": "done" }) });
    await answerSummaries({ "w1E:p1": said("Pinned the `clock` in **retry.test.ts**, see [the run](https://example.com/run)", ago(1.5)) });
    expect(words(root, "w1E:p1")).toEqual(["Pinned the clock in retry.test.ts, see the run"]);
  });

  it("reads the rows' last words once for the page: not again when the list mounts again, nor for a filter or a search", async () => {
    const machines = roster();
    await draw(machines);
    expect(summaryCalls).toHaveLength(1);
    await answerSummaries({ "w1E:p1": said("Ready when you are.", ago(4.5)) });
    await page.render(null);
    const root = await draw(machines);
    expect(summaryCalls).toHaveLength(1);
    expect(words(root, "w1E:p1")).toEqual(["Ready when you are."]);
    expect(age(root, "w1E:p1")).toEqual(["4m"]);
    await redraw({ filter: "working" });
    await redraw({ filter: "all", query: "export" });
    await redraw({ query: "" });
    expect(summaryCalls).toHaveLength(1);
  });

  it("draws a timed row a filter brings back from the clock as it is now, and a time in the future as under a minute", async () => {
    const root = await draw(roster(), { activity: statusOf({ "w1E:p1": "done", "w1F:p1": "done" }) });
    await answerSummaries({ "w1E:p1": said("Done.", ago(6.5)), "w1F:p1": said("Done too.", ago(-10)) });
    expect(age(root, "w1E:p1")).toEqual(["6m"]);
    expect(age(root, "w1F:p1")).toEqual(["<1m"]);
    await redraw({ filter: "working" });
    const later = Date.now() + 60 * 60_000;
    const clock = spyOn(Date, "now").mockReturnValue(later);
    try {
      await redraw({ filter: "all" });
      expect(age(root, "w1E:p1")).toEqual(["1h"]);
    } finally { clock.mockRestore(); }
  });

  it("titles the time with the full local time in the interface language", async () => {
    page.window.localStorage.setItem("ovis:settings", JSON.stringify({ language: "ko" }));
    const root = await draw(roster(), { activity: statusOf({ "w1E:p1": "done" }) });
    await answerSummaries({ "w1E:p1": said("Done.", ago(6.5)) });
    const [time] = times(root, "w1E:p1");
    const at = new Date(time!.getAttribute("datetime") ?? "");
    expect(time!.getAttribute("title")).toBe(at.toLocaleString("ko"));
    expect(time!.getAttribute("title")).not.toBe(at.toLocaleString("en"));
  });

  it("keeps a done row when the query is part of the last words it shows", async () => {
    const root = await draw(roster(), { activity: statusOf({ "w1E:p1": "done" }) });
    await redraw({ query: "jq quirk" });
    expect(order(root)).toEqual([]);
    await answerSummaries({ "w1E:p1": said("Fixed the `jq` quirk in the zsh prompt.", ago(3.5)) });
    expect(order(root)).toEqual(["w1E:p1"]);
  });

  it("reaches the kept scroll place once the rows' last words are back", async () => {
    await draw(roster(), { scrollTop: 167, scrollMax: 127 });
    expect(scroller().scrollTop).toBe(127);
    scrollMax = 400;
    await answerSummaries({ "w1E:p1": said("Ready when you are.", ago(4.5)) });
    expect(scroller().scrollTop).toBe(167);
  });

  it("on a phone draws More and New workspace at its top with the shell's note between them, and the filter and the search at its foot", async () => {
    const pressed: unknown[] = [];
    const root = await draw(roster(), { more: { label: "More", expanded: false, popup: "dialog", onPress: (node) => pressed.push(node) }, note: <span className="test-note">Link copied</span> });
    const top = byClass(root, "inbox-top")[0]!;
    const classes = (node: HTMLElement) => [...node.children].map((inner) => String(inner.getAttribute("class")).split(" ").find((name) => name.startsWith("inbox-") && name !== "inbox-round") ?? String(inner.getAttribute("class")));
    expect(classes(top)).toEqual(["inbox-more", "test-note", "visually-hidden", "inbox-add"]);
    expect(classes(byClass(root, "inbox-foot")[0]!)).toEqual(["inbox-filter-toggle", "inbox-search"]);
    const more = byClass(root, "inbox-more")[0]!;
    expect([more.getAttribute("aria-label"), more.getAttribute("aria-haspopup"), more.getAttribute("aria-expanded")]).toEqual(["More", "dialog", "false"]);
    await act(async () => { more.click(); });
    expect(pressed).toEqual([more]);
    const field = page.one('input[type="search"]');
    expect([field.getAttribute("placeholder"), field.getAttribute("aria-label")]).toEqual(["Search", "Search"]);
  });

  describe("as the column beside a thread", () => {
    beforeEach(() => { phone = false; });

    it("marks the open thread's row as current, and no row while none is open", async () => {
      const root = await draw(roster(), { wide: true, current: "local:w1D:p1" });
      const current = byClass(root, "inbox-row").filter((row) => row.getAttribute("aria-current") === "true");
      expect(current.map((row) => row.parentElement!.getAttribute("data-pane"))).toEqual(["w1D:p1"]);
      expect(byClass(root, "is-current").map((node) => node.getAttribute("data-pane"))).toEqual(["w1D:p1"]);
      await redraw({ current: null });
      expect(byClass(root, "inbox-row").filter((row) => row.hasAttribute("aria-current"))).toEqual([]);
      expect(byClass(root, "is-current")).toEqual([]);
    });

    it("never marks a row as current where the list is the screen", async () => {
      const root = await draw(roster(), { wide: false, current: "local:w1D:p1" });
      expect(byClass(root, "is-current")).toEqual([]);
    });

    it("draws Search, the state filter and New workspace in its top row and no foot, the state's mark at each row's end", async () => {
      const root = await draw(roster(), { wide: true });
      const buttons = (zone: string) => [...byClass(root, zone)[0]!.querySelectorAll("button")].map((node) => String(node.getAttribute("class")).split(" ").find((name) => name.startsWith("inbox-") && name !== "inbox-round"));
      expect(buttons("inbox-top")).toEqual(["inbox-search-toggle", "inbox-filter-toggle", "inbox-add"]);
      const filter = byClass(root, "inbox-filter-toggle")[0]!;
      expect([filter.getAttribute("aria-label"), filter.getAttribute("aria-haspopup"), filter.getAttribute("aria-expanded")]).toEqual(["Filter by state", "menu", "false"]);
      expect(byClass(root, "inbox-foot").length).toBe(0);
      const row = byClass(item(root, "w1D:p1"), "inbox-row")[0]!;
      expect(byClass(row, "inbox-sub").length).toBe(0);
      expect(String(row.lastElementChild?.getAttribute("class")).split(" ")).toContain("inbox-state");
      expect(row.getAttribute("title")).toBe("Guard the export button\nNeeds you");
    });

    it("draws no time on a row, and says it in the row's name and its tooltip", async () => {
      const root = await draw(roster(), { wide: true, activity: statusOf({ "w1E:p1": "done" }) });
      await answerSummaries({ "w1E:p1": said("All six export tests pass.", ago(6.5)) });
      expect(times(root, "w1E:p1")).toEqual([]);
      const row = byClass(item(root, "w1E:p1"), "inbox-row")[0]!;
      expect(row.getAttribute("aria-label")).toBe("Gajae Code, Why did the backup fail?, Done, All six export tests pass., 6m");
      const lines = String(row.getAttribute("title")).split("\n");
      expect(lines.slice(0, 2)).toEqual(["Why did the backup fail?", "All six export tests pass."]);
      expect(lines[2]).toStartWith("6m · ");
    });

    it("draws no More and no way out of its own: the mode's rail beside it holds them, whatever the shell hands the list", async () => {
      const root = await draw(roster(), { wide: true, more: { label: "More", expanded: false, popup: "menu", onPress() {} } });

      const drawn = [...root.querySelectorAll("button")].map((node) => String(node.getAttribute("aria-label") ?? text(node)));
      expect(drawn.filter((name) => /Back to Ovis|More/.test(name))).toEqual([]);
      expect([byClass(root, "inbox-more").length, byClass(root, "inbox-exit").length, root.querySelectorAll("img").length]).toEqual([0, 0, 0]);
    });

    it("draws its search field, Search, the filter and New workspace; in a column too narrow for the field Search opens it, focused, and Escape puts it away once it is empty", async () => {
      const queries: string[] = [];
      const root = await draw(roster(), { wide: true, onQuery: (query) => queries.push(query) });
      const toggle = () => byClass(root, "inbox-search-toggle")[0]!;
      const opened = () => String(byClass(root, "inbox-top")[0]!.getAttribute("class")).split(" ").includes("is-search-open");
      const head = () => [...byClass(root, "inbox-top")[0]!.querySelectorAll("button, input")].map((node) => String(node.getAttribute("class")).split(" ").find((name) => name.startsWith("inbox-") && name !== "inbox-round"));
      expect(head()).toEqual(["inbox-search-input", "inbox-search-toggle", "inbox-filter-toggle", "inbox-add"]);
      expect([toggle().getAttribute("aria-expanded"), opened()]).toEqual(["false", false]);
      expect([toggle().getAttribute("aria-label"), toggle().getAttribute("title")]).toEqual(["Search agents", "Search agents"]);

      await act(async () => { toggle().click(); });
      expect([toggle().getAttribute("aria-expanded"), opened()]).toEqual(["true", true]);
      expect(focused.map((call) => call.node)).toContain("input");
      const scoped = page.one('input[type="search"]');
      expect([scoped.getAttribute("placeholder"), scoped.getAttribute("aria-label")]).toEqual(["Search agents", "Search agents"]);

      await redraw({ query: "export" });
      const field = () => page.one('input[type="search"]');
      // an Escape that ends an IME's composition is the composition's: the words and the field stay
      await escape(field(), true);
      expect(queries).toEqual([]);
      // Safari reports a composition's Escape by its keyCode alone
      await escape(field(), false, 229);
      expect(queries).toEqual([]);
      await escape(field());
      expect(queries).toEqual([""]);
      await redraw({ query: "" });
      expect(opened()).toBe(true);
      await escape(field(), true);
      expect(opened()).toBe(true);
      await escape(field());
      expect([toggle().getAttribute("aria-expanded"), opened()]).toEqual(["false", false]);
      expect(focused.at(-1)?.node).toBe("inbox-search-toggle");
    });

    it("keeps a folded field open when Escape takes words typed before the column narrowed, and folds it on the next Escape", async () => {
      const queries: string[] = [];
      const root = await draw(roster(), { wide: true, query: "export", onQuery: (query) => queries.push(query) });
      const opened = () => String(byClass(root, "inbox-top")[0]!.getAttribute("class")).split(" ").includes("is-search-open");
      const field = () => page.one('input[type="search"]');
      expect(opened()).toBe(true);
      await escape(field());
      expect(queries).toEqual([""]);
      await redraw({ query: "" });
      expect(opened()).toBe(true);
      expect(focused.map((call) => call.node)).not.toContain("inbox-search-toggle");
      await escape(field());
      expect(opened()).toBe(false);
      expect(focused.at(-1)?.node).toBe("inbox-search-toggle");
    });

    it("keeps its always-shown search field and the focus in it on an Escape where the column has the room for it", async () => {
      const queries: string[] = [];
      const root = await draw(roster(), { wide: true, searchToggleHidden: true, onQuery: (query) => queries.push(query) });
      const field = () => page.one('input[type="search"]');
      await escape(field());
      expect(queries).toEqual([]);
      expect(focused.map((call) => call.node)).not.toContain("inbox-search-toggle");
      expect(byClass(root, "inbox-search").length).toBe(1);
    });

    it("keeps its search field open while a query narrows the list, whatever its button is asked", async () => {
      const root = await draw(roster(), { wide: true, query: "export" });
      const opened = () => String(byClass(root, "inbox-top")[0]!.getAttribute("class")).split(" ").includes("is-search-open");
      expect(opened()).toBe(true);
      await act(async () => { byClass(root, "inbox-search-toggle")[0]!.click(); });
      expect(opened()).toBe(true);
    });
  });
});
