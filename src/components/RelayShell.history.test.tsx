import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { act, createElement } from "react";
import { openPage, type Page } from "../lib/page.fixture.ts";
import { SettingsProvider } from "../lib/settings.ts";
import * as sheetHistory from "../lib/sheetHistory.ts";
import type { RelayShellProps } from "./RelayShell.tsx";

// A tablet turned between portrait and landscape: a coarse pointer, so a sheet's Back is the phone's own and every open
// sheet takes an entry in the history (sheetHistory BACK_QUERY), on both sides of the 1024 px line. sheetHistory hears
// Back only where a window stood when it loaded: this file loads its own copy after its window and hands that to the page.
const WIDE = "(min-width: 1024px)";
const HREF = "https://app.ovis.sh/";
const none = () => {};
const ids = { mini: "c".repeat(32) };
const front: RelayShellProps = {
  state: { kind: "empty", account: { kind: "signed-in", provider: "google", error: null, pcs: [] } },
  scoped: false, iosTab: false, onPair: none, onRetry: none, onCancel: none, onBack: none, onForget: none, onUpdate: none, onMatch: none, onCodeStart: none, onCodeSubmit: none, onCodeMatch: none, onSignIn: none,
};

const browserGlobals = ["HTMLElement", "Element", "Node", "IntersectionObserver", "Event", "CustomEvent", "localStorage", "sessionStorage", "matchMedia"] as const;
const savedBrowserGlobals = new Map(browserGlobals.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
const loaded = { ...sheetHistory };
const entries: (object | null)[] = [null];
let index = 0;
let wideNow = false;
const watchers = new Map<(event: { matches: boolean }) => void, string>();
const matching = (query: string): boolean => query === WIDE ? wideNow : query.includes("(pointer: coarse)");
const matchMedia = (query: string) => ({
  get matches() { return matching(query); },
  addEventListener: (_type: string, listener: (event: { matches: boolean }) => void) => { watchers.set(listener, query); },
  removeEventListener: (_type: string, listener: (event: { matches: boolean }) => void) => { watchers.delete(listener); },
});
const turn = async (): Promise<void> => {
  await act(async () => { for (let i = 0; i < 4; i++) await new Promise((resolve) => setTimeout(resolve, 0)); });
};
/** a step down the history, told by popstate on a later turn, as a browser does */
const traverseBack = (): void => {
  if (index === 0) throw new Error("no entry to go back to");
  index -= 1;
  queueMicrotask(() => page.window.dispatchEvent(new page.window.PopStateEvent("popstate", { state: entries[index] })));
};
/** the tablet's own Back */
const browserBack = async (): Promise<void> => { traverseBack(); await turn(); };
const rotate = async (wide: boolean): Promise<void> => {
  wideNow = wide;
  await act(async () => { for (const [listener, query] of [...watchers]) listener({ matches: matching(query) }); });
  await turn();
};

let RelayShell: typeof import("./RelayShell.tsx").RelayShell;
let page: Page;

beforeEach(async () => {
  page = openPage(HREF);
  entries.splice(0, entries.length, null);
  index = 0;
  wideNow = false;
  watchers.clear();
  const history = {
    get state() { return entries[index]; },
    pushState(state: object | null) { entries.splice(index + 1); entries.push(state); index += 1; },
    replaceState(state: object | null) { entries[index] = state; },
    // a browser's Back on its first entry does nothing
    back() { if (index > 0) traverseBack(); },
    forward() {},
    go() {},
  };
  Object.defineProperties(page.window, {
    history: { configurable: true, value: history },
    matchMedia: { configurable: true, value: matchMedia },
    innerWidth: { configurable: true, value: 800 },
    requestAnimationFrame: { configurable: true, value: () => 1 },
    cancelAnimationFrame: { configurable: true, value: () => {} },
  });
  Object.defineProperties(page.window.navigator, {
    userAgent: { configurable: true, value: "Mozilla/5.0 (Linux; Android 15)" },
    maxTouchPoints: { configurable: true, value: 5 },
  });
  for (const key of browserGlobals) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value: page.window[key] });
  const historyPath = "../lib/sheetHistory.ts?relay-shell-history", shellPath = "./RelayShell.tsx?relay-shell-history";
  const fresh = await import(historyPath) as typeof sheetHistory;
  mock.module("../lib/sheetHistory.ts", () => fresh);
  ({ RelayShell } = await import(shellPath) as typeof import("./RelayShell.tsx"));
});

afterEach(async () => {
  // Let a sheet leave its history entry while the page is still here.
  await page.render(null);
  await turn();
  mock.module("../lib/sheetHistory.ts", () => loaded);
  await page.close();
  for (const [key, descriptor] of savedBrowserGlobals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

describe("the hosted front page on a tablet turned across 1024 px", () => {
  const action = (name: string) => {
    const found = [...page.container.querySelectorAll<HTMLButtonElement>(`button[data-action="${name}"]`)].filter((node) => !node.closest("[hidden]"));
    if (found.length !== 1 || !found[0]) throw new Error(`Expected one visible ${name} button`);
    return found[0];
  };
  const views = () => [...page.container.querySelectorAll("div[data-view]")].filter((node) => !node.closest("[hidden]")).map((node) => node.getAttribute("data-view"));
  const dialogs = () => [...page.window.document.querySelectorAll('[role="dialog"]')].map((node) => node.getAttribute("data-pair-dialog"));

  /** the sheet that owns the entry the history stands on, if any */
  const top = (): unknown => (entries[index] as Record<string, unknown> | null)?.["ovis:sheet"] ?? null;

  it("closes the pairing dialog with the tablet's Back after a turn to portrait, then Add a PC with the next, back to the list", async () => {
    const cancelled: string[] = [];
    const draw = (next: RelayShellProps) => page.render(createElement(SettingsProvider, { children: createElement(RelayShell, next) }));
    const atFront: RelayShellProps = { ...front, onCancel: () => { cancelled.push("cancel"); } };
    await draw(atFront);
    expect(views()).toEqual(["my-pcs"]);
    await act(async () => { action("add-pc").click(); });
    await turn();
    expect(views()).toEqual(["add-pc"]);
    expect([index, entries.length]).toEqual([1, 2]);
    const addEntry = top();
    expect(addEntry).not.toBeNull();
    // landscape: Add a PC stands beside the list, no step of its own; its code finds a PC, compared in the dialog
    await rotate(true);
    expect(views()).toEqual(["my-pcs", "add-pc"]);
    expect(index).toBe(0);
    await act(async () => { action("add-code").click(); });
    const form = page.one<HTMLFormElement>("form[data-code-form]");
    await page.type(page.one<HTMLInputElement>('form[data-code-form] input[name="code"]'), "ABCDE-12345");
    await act(async () => { form.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true })); });
    await draw({ ...atFront, state: { kind: "code-compare", offer: { v: 1, server_id: ids.mini, server_public_key: "k", relay: "wss://relay-ap.ovis.sh", code: "ABCDE-12345", name: "Mac mini" } } });
    await turn();
    expect(dialogs()).toEqual(["compare"]);
    expect(index).toBe(1);
    const dialogEntry = top();
    expect(dialogEntry).not.toBe(addEntry);
    // portrait again under the dialog: it stays the top of the history, Add a PC's entry waiting under it
    await rotate(false);
    expect([index, entries.length, top()]).toEqual([1, 2, dialogEntry]);
    // Back closes the dialog first, and the code with it, while the front page the shell reads again is on its way
    await browserBack();
    expect(dialogs()).toEqual([]);
    expect(cancelled).toEqual(["cancel"]);
    await draw(atFront);
    expect(views()).toEqual(["add-pc"]);
    // Add a PC took its entry once the dialog closed: the next Back comes back to the list
    expect(index).toBe(1);
    expect([null, dialogEntry]).not.toContain(top());
    await browserBack();
    expect(views()).toEqual(["my-pcs"]);
    expect(index).toBe(0);
    expect(dialogs()).toEqual([]);
  });
});
