/**
 * The header's More menu, for the browser scripts: Alerts is among its items, and Browse files
 * at 768px and below (wider, Files is the header's own button). It is a popover on a desktop and
 * a bottom sheet at 640px and below (RowMenu), so an item is found in either.
 */
import type { Locator, Page } from "playwright-core";

const ITEMS = '.row-menu [role="menuitem"], .row-menu [role="menuitemcheckbox"], .row-sheet .row-sheet-item';

/** Opens the menu when it is not open and returns the item that starts with `label`. */
export async function moreItem(page: Page, label: string): Promise<Locator> {
  const item = page.locator(ITEMS).filter({ hasText: new RegExp(`^${label}`) });
  if (!(await item.isVisible())) await page.locator(".header-more-button").click();
  await item.waitFor();
  return item;
}

/**
 * A phone's More (its sheet) folds the find items and the open pane's and tab's actions into one item each, Find… and
 * Pane and tab…, each opening a sheet of its own (G-143). With More open, this opens `group`'s sheet and waits for it;
 * where More lists those items itself (a popover, or a group of one) it does nothing.
 */
export async function openMoreGroup(page: Page, group: "find" | "pane"): Promise<void> {
  const item = page.locator(`.row-sheet .row-sheet-item[data-item="${group}-group"]`);
  if ((await item.count()) === 0) return;
  await item.click();
  await item.waitFor({ state: "detached" });
  await page.locator(".row-sheet .row-sheet-item").first().waitFor();
}

/** Runs an item; the menu closes with it. */
export async function runMoreItem(page: Page, label: string): Promise<void> {
  const item = await moreItem(page, label);
  await item.click();
  await item.waitFor({ state: "hidden" });
}

/**
 * What the Alerts item says of this device, in its words ("On in the app", "Off on this
 * device"), read from the open menu, which is closed again. The item is a switch: a checkbox
 * item in the popover, a pressed button in the sheet, and its state has to agree with its words.
 */
export async function alertsState(page: Page): Promise<string> {
  const item = await moreItem(page, "Alerts");
  const state = (await item.locator(".menu-item-hint, .row-sheet-hint").textContent()) ?? "";
  const role = await item.getAttribute("role");
  const checked = await item.getAttribute(role === "menuitemcheckbox" ? "aria-checked" : "aria-pressed");
  await page.keyboard.press("Escape");
  await item.waitFor({ state: "hidden" });
  if (checked !== String(!state.startsWith("Off"))) throw new Error(`the Alerts item says "${state}" but its ${role === "menuitemcheckbox" ? "aria-checked" : "aria-pressed"} is ${checked}`);
  return state;
}

/** Whether the menu's button carries the dot, and says so in its name: alerts are off on this device. */
export async function alertsOffMarked(page: Page): Promise<boolean> {
  const dot = (await page.locator(".header-more .header-more-dot").count()) === 1;
  const named = (await page.locator(".header-more-button").getAttribute("aria-label")) === "More · alerts are off";
  if (dot !== named) throw new Error(`the More button's dot (${dot}) and its name (${named}) disagree`);
  return dot;
}
