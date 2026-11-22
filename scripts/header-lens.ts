import type { Page } from "playwright-core";

export type Lens = "chat" | "terminal";

export async function openLens(page: Page, lens: Lens, how: "click" | "tap" = "click"): Promise<void> {
  // The header draws one control or the other by the page's width (App.tsx, SHEET_QUERY) and redraws it a frame after
  // a resize: the one to use follows the width the page has now, not what is drawn at that moment (just after a
  // rotation back to a phone the wide switch is still there, and goes while it is clicked)
  if (await page.evaluate(() => matchMedia("(max-width: 640px)").matches)) {
    const toggle = page.locator(".app-header .lens-toggle");
    await toggle.waitFor();
    if ((await toggle.getAttribute("data-view")) !== lens) await toggle[how]();
    return;
  }
  await page.locator(".app-header .view-switch").getByRole("button", { name: lens === "chat" ? "Chat" : "Terminal", exact: true })[how]();
}
