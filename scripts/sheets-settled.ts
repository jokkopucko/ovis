import type { Page } from "playwright-core";

/**
 * A sheet rises over --dur-sheet, so a check that measures one the moment it opens reads it short
 * of where it comes to rest. A closed sheet's drop is drawn in a closed shadow root, out of every
 * query's reach.
 */
export async function sheetsSettled(page: Page): Promise<void> {
  await page.waitForFunction(() => document.getAnimations().every((animation) => animation.playState !== "running"
    || !/^(?:sheet|scrim)-in$/.test((animation as CSSAnimation).animationName ?? "")), undefined, { timeout: 5_000 });
}

/**
 * Resolves once the history is off the entry of a dialog, sheet or menu that closed by its own
 * control (src/lib/sheetHistory.ts). On a phone, and on any screen worked by touch, each holds an
 * entry while it is up and steps off it a moment after it closes. A Back pressed, or a page load
 * asked for, before that step lands is spent on it: Back leaves the closed surface's entry and goes
 * no further, and the load is dropped.
 */
export async function sheetEntryLeft(page: Page): Promise<void> {
  await page.waitForFunction(() => (history.state as Record<string, unknown> | null)?.["ovis:sheet"] === undefined);
}
