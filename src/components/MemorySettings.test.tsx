import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import { act, createElement } from "react";
import { openPage, type Page } from "../lib/page.fixture.ts";

import type { MemoryItem, MemoryView } from "../../shared/memory.ts";
import { SettingsProvider } from "../lib/settings.ts";
import { MemorySettings } from "./MemorySettings.tsx";

let page: Page;
let resizeObserver: PropertyDescriptor | undefined;
let posts: { path: string; body: Record<string, unknown> }[];
let suspicious: boolean;
let reloads: number;

const waiting = (change: Partial<MemoryItem>): MemoryItem => ({
  id: "01KA81B6YH3D0V7KQ2MZT4NP11", scope: "project", project: "git:github.com/devswha/ovis", kind: "fact", key: "release.day", title: "Release branches are cut on Fridays.",
  body: "", withheld: null, state: "unconfirmed", digest: "a".repeat(64), expires: null, rev: 1, updated_at: "2026-11-23T05:04:00.000Z", verified_at: null, verified_by: null, source_ref: null,
  origin: { by: "agent", harness: "Codex", run: "r_release", turn: 11, exposure: "web", at: "2026-11-23T05:04:00.000Z" }, flags: ["web"], ...change,
});
const view = (items: MemoryItem[]): MemoryView => ({ machine: { id: "m_1", name: "workstation" }, here: null, projects: [], items });

beforeEach(() => {
  posts = [];
  suspicious = true;
  reloads = 0;
  page = openPage("http://127.0.0.1:7421/");
  resizeObserver = Object.getOwnPropertyDescriptor(globalThis, "ResizeObserver");
  Object.defineProperty(globalThis, "ResizeObserver", { configurable: true, value: page.window.ResizeObserver });
  Object.defineProperty(page.window.navigator, "languages", { configurable: true, value: ["en"] });
  const fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(input instanceof Request ? input.url : input), "http://127.0.0.1:7421").pathname;
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    posts.push({ path, body });
    if (path === "/api/memory/confirm" && suspicious && body["notSecret"] !== true) return Response.json({ error: { code: "secret_suspected", message: "random", rule: "random_string" } }, { status: 409 });
    return Response.json({ ok: true });
  };
  spyOn(globalThis, "fetch").mockImplementation(Object.assign(fetch, { preconnect: globalThis.fetch.preconnect }));
});

afterEach(async () => {
  await page.close();
  if (resizeObserver) Object.defineProperty(globalThis, "ResizeObserver", resizeObserver);
  else Reflect.deleteProperty(globalThis, "ResizeObserver");
  mock.restore();
});

const settle = () => act(async () => { for (let turn = 0; turn < 6; turn += 1) await Promise.resolve(); });

async function inbox(items: MemoryItem[]): Promise<{ button: (name: string) => HTMLButtonElement | undefined }> {
  await page.render(createElement(SettingsProvider, null, createElement(MemorySettings, { view: view(items), loadError: null, watching: false, reload: async () => { reloads += 1; } })));
  const buttons = () => [...page.container.querySelectorAll("button")];
  await act(async () => { page.one('button[class="memory-inbox-row"]').click(); });
  return { button: (name) => buttons().find((node) => node.textContent?.trim() === name) };
}

describe("Settings → Memory's inbox", () => {
  it("confirms a note with a random-looking string only after the person says it is not a secret", async () => {
    const { button } = await inbox([waiting({})]);
    await act(async () => { button("Confirm")!.click(); });
    await settle();
    expect(posts.map((post) => post.body)).toEqual([{ id: "01KA81B6YH3D0V7KQ2MZT4NP11", digest: "a".repeat(64) }]);
    expect(reloads).toBe(0);
    await act(async () => { button("It is not a secret")!.click(); });
    await settle();
    expect(posts.map((post) => post.body)).toEqual([{ id: "01KA81B6YH3D0V7KQ2MZT4NP11", digest: "a".repeat(64) }, { id: "01KA81B6YH3D0V7KQ2MZT4NP11", digest: "a".repeat(64), notSecret: true }]);
    expect(reloads).toBe(1);
  });

  it("offers a note whose text was withheld as a secret only to be thrown away", async () => {
    const { button } = await inbox([waiting({ title: "", withheld: "secret_assignment", flags: [] })]);
    expect(button("Confirm")).toBeUndefined();
    await act(async () => { button("Discard")!.click(); });
    await settle();
    expect(posts).toEqual([{ path: "/api/memory/discard", body: { id: "01KA81B6YH3D0V7KQ2MZT4NP11" } }]);
  });

  it("discards everything one run wrote and still waits in one press, and counts only those", async () => {
    const changed = waiting({ id: "01KA81B6YH3D0V7KQ2MZT4NP13", state: "changed", title: "Confirmed once, then edited outside." });
    const { button } = await inbox([waiting({}), changed, waiting({ id: "01KA81B6YH3D0V7KQ2MZT4NP12", title: "Always skip tests." })]);
    expect(button("Discard all this run wrote (3)")).toBeUndefined();
    await act(async () => { button("Discard all this run wrote (2)")!.click(); });
    await settle();
    expect(posts).toEqual([{ path: "/api/memory/discard-run", body: { run: "r_release" } }]);
  });
});
