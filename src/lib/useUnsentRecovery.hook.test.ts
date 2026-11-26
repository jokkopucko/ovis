import { afterEach, beforeEach, expect, it } from "bun:test";
import { act, createElement } from "react";
import type { Machine } from "../../shared/machines.ts";
import type { HerdrPane } from "../../shared/protocol.ts";
import { composerDrafts } from "./composerDraft.ts";
import { openPage, type Page } from "./page.fixture.ts";
import { paneLifetimes } from "./paneLifetime.ts";
import { useUnsentRecovery } from "./useUnsentRecovery.ts";

type Hook = ReturnType<typeof useUnsentRecovery>;
let page: Page;
beforeEach(() => { page = openPage(); });
afterEach(async () => {
  await page.close();
});

async function mount(): Promise<() => Hook> {
  let hook: Hook | null = null;
  function Probe() {
    hook = useUnsentRecovery({ selectedMachineId: "local", selectedPaneId: null, setView: () => {}, pickView: () => {} });
    return null;
  }
  await page.render(createElement(Probe));
  return () => { if (hook === null) throw new Error("not rendered"); return hook; };
}

it("keeps the record of text put in the box of a PC whose herdr is not proven, and lets one go that storage kept", async () => {
  const pane = { pane_id: "w1:p1" } as HerdrPane;
  // an older bridge names no herdr: its panes' drafts live in this page alone
  paneLifetimes.observe([{ id: "older-bridge", snapshot: { panes: [] } } as unknown as Machine], (item) => item.pane_id);
  paneLifetimes.observe([{ id: "proven-pc", snapshot: { panes: [], herdr_lifetime: "recovery-herdr" } } as unknown as Machine], (item) => item.pane_id);
  const hook = await mount();
  await act(async () => { hook().openUnsent({ machineId: "older-bridge", pane }); });
  expect(hook().recover("kept for later")).toBe(false);
  expect(composerDrafts.read("ovis:composer-draft:remote:older-bridge:w1%3Ap1").text).toBe("kept for later");
  const { localStorage } = page.window;
  expect(Array.from({ length: localStorage.length }, (_, index) => localStorage.key(index)).filter((key) => key?.includes("older-bridge"))).toEqual([]);
  await act(async () => { hook().openUnsent({ machineId: "proven-pc", pane }); });
  expect(hook().recover("into storage")).toBe(true);
  expect(localStorage.getItem("ovis:composer-draft:remote:proven-pc:w1%3Ap1")).toBe("into storage");
});

it("puts a recovered comment message back agent-only, and other text as it was", async () => {
  const pane = { pane_id: "w1:p2" } as HerdrPane;
  const key = "ovis:composer-draft:remote:proven-pc:w1%3Ap2";
  paneLifetimes.observe([{ id: "proven-pc", snapshot: { panes: [], herdr_lifetime: "recovery-herdr" } } as unknown as Machine], (item) => item.pane_id);
  const hook = await mount();
  await act(async () => { hook().openUnsent({ machineId: "proven-pc", pane }); });
  expect(hook().recover("plain words")).toBe(true);
  expect(composerDrafts.isAgentOnly(key)).toBe(false);
  composerDrafts.set(key, "");
  for (const text of ["> backup.txt\nKeep this backup", "my note\n\n> backup.txt\nKeep this backup"]) {
    expect(hook().recover(text)).toBe(true);
    expect(composerDrafts.isAgentOnly(key)).toBe(true);
    composerDrafts.set(key, "");
  }
});

it("puts an agent-only draft a herdr restart kept back agent-only, its quote edited away or not", async () => {
  const snapshot = (lifetime: string) => [{ id: "restart-pc", snapshot: { panes: [], herdr_lifetime: lifetime } } as unknown as Machine];
  paneLifetimes.observe(snapshot("first"), (item) => item.pane_id);
  const key = "ovis:composer-draft:remote:restart-pc:p";
  composerDrafts.restorePending(key, "> backup.txt\nrm backup.txt", true);
  composerDrafts.set(key, "rm backup.txt");
  paneLifetimes.observe(snapshot("second"), (item) => item.pane_id);
  const record = paneLifetimes.unsent().find((item) => item.machine_id === "restart-pc" && item.text === "rm backup.txt");
  expect(record?.agent_only).toBe(true);
  const hook = await mount();
  await act(async () => { hook().openUnsent({ machineId: "restart-pc", pane: { pane_id: "p" } as HerdrPane }); });
  expect(hook().recover(record!.text, record!.agent_only === true)).toBe(true);
  expect(composerDrafts.isAgentOnly(key)).toBe(true);
  composerDrafts.set(key, "");
  paneLifetimes.discard(record!.id);
});
