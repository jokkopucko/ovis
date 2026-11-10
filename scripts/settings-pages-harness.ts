/**
 * What the Settings demo scripts share (scripts/settings-pages-demo-regression.ts,
 * settings-palette-search-demo-regression.ts and settings-rows-demo-regression.ts): the settings a
 * page starts from, and the steps that open and close Settings and the palette.
 */
import type { Page } from "playwright-core";
import { sheetRisen } from "./settings-page.ts";

const PAGES = ["Appearance", "Chat", "Terminal", "Alerts", "Agents", "Shortcuts", "Devices and PCs", "Experimental", "About"];
const SETTINGS = { language: "en", showUsage: true, voiceInput: true, showQuickReplies: true, fileOpen: "panel" };

const dialogOf = (page: Page) => page.getByRole("dialog", { name: "Settings", exact: true });
const openSettings = async (page: Page): Promise<void> => {
  await page.keyboard.press("ControlOrMeta+Shift+Comma");
  await page.locator(".settings-dialog").waitFor();
  await sheetRisen(page);
};
/** Closes Settings by its X and waits for its step back off the history to land. */
const closeSettings = async (page: Page): Promise<void> => {
  await sheetRisen(page);
  await page.getByRole("button", { name: "Close settings", exact: true }).click();
  await page.locator(".settings-dialog").waitFor({ state: "detached" });
  await page.waitForFunction(() => (history.state as Record<string, unknown> | null)?.["ovis:settings"] === undefined);
};
/** Waits for the history to hold what a step left; a wait that runs out says what it holds instead, and how it came to. */
const historyHolds = async (page: Page, step: string, holds: () => boolean): Promise<void> => {
  try { await page.waitForFunction(holds); }
  catch (error) {
    const seen = await page.evaluate(() => ({ state: history.state as unknown, address: location.search, dialogs: document.querySelectorAll(".settings-dialog").length, trace: (window as unknown as { historyTrace?: string[] }).historyTrace?.slice(-40) }));
    throw new Error(`${step}: the history never held it. ${JSON.stringify(seen, null, 1)}`, { cause: error });
  }
};
const openPalette = async (page: Page, query: string): Promise<void> => {
  await page.keyboard.press("ControlOrMeta+Shift+K");
  const input = page.locator(".command-palette input[type='search']");
  await input.waitFor();
  await input.fill(query);
  // the list drawn for this query: its rows or its empty line, never the last query's
  await page.waitForFunction((query) => document.querySelector<HTMLInputElement>(".command-palette input[type='search']")?.value === query, query);
  // a phone's palette is a sheet too: its rows are clicked once it has risen
  await sheetRisen(page, ".command-palette");
};

export { PAGES, SETTINGS, closeSettings, dialogOf, historyHolds, openPalette, openSettings };
