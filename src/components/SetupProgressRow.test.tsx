import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { act, createElement } from "react";
import { openPage, type Page } from "../lib/page.fixture.ts";
import { SETUP_ROW_KEY } from "../lib/firstHints.ts";
import { SettingsProvider } from "../lib/settings.ts";
import { SetupProgressRow, type SetupActions } from "./SetupProgressRow.tsx";

let page: Page;
let guideOpened = 0;
let called: string[] = [];

const menu = () => {
  const found = document.querySelectorAll('[role="menu"]');
  if (found.length !== 1 || !found[0]) throw new Error("Expected one setup checklist");
  return found[0];
};
const item = (id: string) => {
  const button = menu().querySelector<HTMLButtonElement>(`button[data-item="${id}"]`);
  if (!button) throw new Error(`Missing setup item ${id}`);
  return button;
};

beforeEach(() => {
  page = openPage("http://127.0.0.1:7317/");
  page.window.localStorage.setItem(SETUP_ROW_KEY, "on");
  Object.defineProperties(page.window, {
    innerWidth: { configurable: true, value: 1280 },
    innerHeight: { configurable: true, value: 800 },
    requestAnimationFrame: { configurable: true, value: () => 1 },
    cancelAnimationFrame: { configurable: true, value: () => {} },
  });
  guideOpened = 0;
  called = [];
  window.addEventListener("ovis:open-setup-guide", () => { guideOpened += 1; });
});

afterEach(async () => {
  await page.close();
});

const actions: SetupActions = { workspace: () => { called.push("workspace"); }, phone: () => { called.push("phone"); }, alerts: () => { called.push("alerts"); } };

async function openChecklist(facts: { workspace: boolean; phone: boolean; alerts: boolean }): Promise<void> {
  await page.render(createElement(SettingsProvider, { children: createElement(SetupProgressRow, { facts, actions }) }));
  const row = page.one<HTMLButtonElement>("button.setup-row-open");
  Object.defineProperty(row, "getBoundingClientRect", { configurable: true, value: () => new window.DOMRect(0, 700, 240, 32) });
  expect(row.textContent).toContain("Setup: 2 left");
  await act(async () => { row.click(); });
}

describe("the setup row", () => {
  it("opens a checklist of the four parts, never the whole guide, done ones ticked", async () => {
    await openChecklist({ workspace: true, phone: false, alerts: false });
    expect(guideOpened).toBe(0);
    expect([...menu().querySelectorAll("button")].map((button) => [button.getAttribute("data-item"), button.getAttribute("aria-checked") === "true"])).toEqual([
      ["workspace", true], ["theme", true], ["phone", false], ["alerts", false],
    ]);
  });

  it("runs each remaining item's own action, and the done one does nothing", async () => {
    for (const id of ["phone", "alerts"] as const) {
      await openChecklist({ workspace: true, phone: false, alerts: false });
      await act(async () => { item(id).click(); });
      await page.render(null);
    }
    expect(called).toEqual(["phone", "alerts"]);
    await openChecklist({ workspace: true, phone: false, alerts: false });
    expect(item("workspace").getAttribute("aria-disabled")).toBe("true");
    await act(async () => { item("workspace").click(); });
    expect(called).toEqual(["phone", "alerts"]);
    // the checklist stays: a done row is no way out of it
    expect(page.window.document.querySelectorAll('[role="menu"]')).toHaveLength(1);
    expect(guideOpened).toBe(0);
  });

  it("opens a workspace from its item when none is open yet", async () => {
    await openChecklist({ workspace: false, phone: true, alerts: false });
    await act(async () => { item("workspace").click(); });
    expect(called).toEqual(["workspace"]);
    expect(guideOpened).toBe(0);
  });
});
