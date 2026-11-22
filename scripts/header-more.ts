import type { Locator, Page } from "playwright-core";

const ITEMS = '.row-menu [role="menuitem"], .row-menu [role="menuitemcheckbox"], .row-sheet .row-sheet-item';

export async function moreItem(page: Page, label: string): Promise<Locator> {
  const item = page.locator(ITEMS).filter({ hasText: new RegExp(`^${label}`) });
  if (!(await item.isVisible())) await page.locator(".header-more-button").click();
  await item.waitFor();
  return item;
}

export async function openMoreGroup(page: Page, group: "find" | "pane"): Promise<void> {
  const item = page.locator(`.row-sheet .row-sheet-item[data-item="${group}-group"]`);
  if ((await item.count()) === 0) return;
  await item.click();
  await item.waitFor({ state: "detached" });
  await page.locator(".row-sheet .row-sheet-item").first().waitFor();
}

export async function runMoreItem(page: Page, label: string): Promise<void> {
  const item = await moreItem(page, label);
  await item.click();
  await item.waitFor({ state: "hidden" });
}

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

export async function alertsOffMarked(page: Page): Promise<boolean> {
  const dot = (await page.locator(".header-more .header-more-dot").count()) === 1;
  const named = (await page.locator(".header-more-button").getAttribute("aria-label")) === "More · alerts are off";
  if (dot !== named) throw new Error(`the More button's dot (${dot}) and its name (${named}) disagree`);
  return dot;
}
