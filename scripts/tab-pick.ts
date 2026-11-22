import type { Locator, Page } from "playwright-core";

export async function pickTab(page: Page, tabId: string): Promise<void> {
  const title = page.locator(".app-header .header-tabs-sheet");
  if (!(await title.isVisible())) {
    await clickTab(page, tabId);
    return;
  }
  await title.click();
  const sheet = page.locator(".row-sheet");
  await sheet.locator(`.row-sheet-item[data-item="tab:${tabId}"]`).click();
  await sheet.waitFor({ state: "detached" });
}

export async function clickTab(page: Page, tabId: string, untrusted = false): Promise<void> {
  const press = (target: Locator): Promise<void> => untrusted ? target.evaluate((button: HTMLElement) => button.click()) : target.click();
  const inRow = `.tab-strip [role="tab"][data-tab-id="${tabId}"]`;
  // the tab comes before More in the strip: More first means the row has no room for it
  const first = page.locator(`${inRow}, .tab-strip-more`).first();
  if (!(await first.evaluate((node) => node.classList.contains("tab-strip-more")))) {
    await press(first);
    return;
  }
  await press(first);
  await press(page.locator(`${inRow}, [role="menu"] [data-item="tab:${tabId}"]`).first());
}
