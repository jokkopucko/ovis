/**
 * Playwright rejects a route's fetch or fulfill whose page, context or browser closes under it, and
 * context.on("close") fires only once the close is done, too late for a fulfill that fails during it.
 */
import type { Browser, BrowserContext, Page, Route } from "playwright-core";

const closing = new WeakSet<Browser | BrowserContext | Page>();

export async function closeMarked(target: Browser | BrowserContext | Page): Promise<void> {
  closing.add(target);
  await target.close();
}

export function whileOpen(context: BrowserContext, handler: (route: Route) => Promise<void>): (route: Route) => Promise<void> {
  return async (route) => {
    try {
      await handler(route);
    } catch (error) {
      const page = route.request().frame().page();
      const browser = context.browser();
      if (!(page.isClosed() || closing.has(page) || closing.has(context) || (browser !== null && closing.has(browser)))) throw error;
    }
  };
}
