import type { Page } from "playwright-core";

/** Drive a paused clock until an already armed, bounded observation settles. */
export async function advanceUntil<T>(pages: readonly Page[], observed: Promise<T>): Promise<T> {
  if (pages.length === 0) throw new Error("advanceUntil needs at least one page");
  let settled = false;
  void observed.then(() => { settled = true; }, () => { settled = true; });
  while (!settled) {
    for (const page of pages) {
      if (settled) break;
      await page.clock.runFor(600);
    }
  }
  return observed;
}
