import { afterEach, beforeEach, expect, it } from "bun:test";
import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import type { Machine } from "../../shared/machines.ts";
import type { HerdrPane } from "../../shared/protocol.ts";
import { composerDrafts } from "./composerDraft.ts";
import { paneLifetimes } from "./paneLifetime.ts";
import { useUnsentRecovery } from "./useUnsentRecovery.ts";

// The real hook, with the page's real lifetime fence: Put in message box keeps the record unless
// the text reached storage, so a reload can still recover it.
type Hook = ReturnType<typeof useUnsentRecovery>;
const window = Object.getOwnPropertyDescriptor(globalThis, "window");
const data = new Map<string, string>();
const storage = {
  get length() { return data.size; },
  key: (index: number) => [...data.keys()][index] ?? null,
  getItem: (key: string) => data.get(key) ?? null,
  setItem: (key: string, value: string) => { data.set(key, value); },
  removeItem: (key: string) => { data.delete(key); },
  clear: () => { data.clear(); },
};
beforeEach(() => { Object.defineProperty(globalThis, "window", { configurable: true, value: { localStorage: storage } }); });
afterEach(() => {
  if (window) Object.defineProperty(globalThis, "window", window);
  else Reflect.deleteProperty(globalThis, "window");
});

function mount(): { hook: () => Hook; unmount: () => void } {
  let hook: Hook | null = null;
  function Probe() {
    hook = useUnsentRecovery({ selectedMachineId: "local", selectedPaneId: null, setView: () => {}, pickView: () => {} });
    return null;
  }
  let renderer: ReactTestRenderer | null = null;
  act(() => { renderer = create(createElement(Probe)); });
  return {
    hook: () => { if (hook === null) throw new Error("not rendered"); return hook; },
    unmount: () => act(() => { renderer!.unmount(); }),
  };
}

it("keeps the record of text put in the box of a PC whose herdr is not proven, and lets one go that storage kept", () => {
  const pane = { pane_id: "w1:p1" } as HerdrPane;
  // an older bridge names no herdr: its panes' drafts live in this page alone
  paneLifetimes.observe([{ id: "older-bridge", snapshot: { panes: [] } } as unknown as Machine], (item) => item.pane_id);
  paneLifetimes.observe([{ id: "proven-pc", snapshot: { panes: [], herdr_lifetime: "recovery-herdr" } } as unknown as Machine], (item) => item.pane_id);
  const { hook, unmount } = mount();
  act(() => { hook().openUnsent({ machineId: "older-bridge", pane }); });
  expect(hook().recover("kept for later")).toBe(false);
  expect(composerDrafts.read("ovis:composer-draft:remote:older-bridge:w1%3Ap1").text).toBe("kept for later");
  expect([...data.keys()].filter((key) => key.includes("older-bridge"))).toEqual([]);
  act(() => { hook().openUnsent({ machineId: "proven-pc", pane }); });
  expect(hook().recover("into storage")).toBe(true);
  expect(data.get("ovis:composer-draft:remote:proven-pc:w1%3Ap1")).toBe("into storage");
  unmount();
});

// #511: recovered text with a `> ` quote line is what comments make, and goes only to an agent again
it("puts a recovered comment message back agent-only, and other text as it was", () => {
  const pane = { pane_id: "w1:p2" } as HerdrPane;
  const key = "ovis:composer-draft:remote:proven-pc:w1%3Ap2";
  const { hook, unmount } = mount();
  act(() => { hook().openUnsent({ machineId: "proven-pc", pane }); });
  expect(hook().recover("plain words")).toBe(true);
  expect(composerDrafts.isAgentOnly(key)).toBe(false);
  composerDrafts.set(key, "");
  for (const text of ["> backup.txt\nKeep this backup", "my note\n\n> backup.txt\nKeep this backup"]) {
    expect(hook().recover(text)).toBe(true);
    expect(composerDrafts.isAgentOnly(key)).toBe(true);
    composerDrafts.set(key, "");
  }
  unmount();
});

it("puts an agent-only draft a herdr restart kept back agent-only, its quote edited away or not", () => {
  const snapshot = (lifetime: string) => [{ id: "restart-pc", snapshot: { panes: [], herdr_lifetime: lifetime } } as unknown as Machine];
  paneLifetimes.observe(snapshot("first"), (item) => item.pane_id);
  const key = "ovis:composer-draft:remote:restart-pc:p";
  composerDrafts.restorePending(key, "> backup.txt\nrm backup.txt", true);
  composerDrafts.set(key, "rm backup.txt");
  paneLifetimes.observe(snapshot("second"), (item) => item.pane_id);
  const record = paneLifetimes.unsent().find((item) => item.machine_id === "restart-pc" && item.text === "rm backup.txt");
  expect(record?.agent_only).toBe(true);
  const { hook, unmount } = mount();
  act(() => { hook().openUnsent({ machineId: "restart-pc", pane: { pane_id: "p" } as HerdrPane }); });
  expect(hook().recover(record!.text, record!.agent_only === true)).toBe(true);
  expect(composerDrafts.isAgentOnly(key)).toBe(true);
  composerDrafts.set(key, "");
  paneLifetimes.discard(record!.id);
  unmount();
});
