import type { Page, Route } from "playwright-core";

const DRAIN_MS = 15_000;

/** The app's roster read and event stream by path: it asks with `?compact_agents=1`, which a glob ending in the path misses. */
export const rosterRead = (url: URL): boolean => url.pathname === "/api/machines";
export const rosterStream = (url: URL): boolean => url.pathname === "/api/machines/events";

/**
 * A page or context route whose handler awaits (`route.fetch()`, a gate) before it answers, with an
 * unroute that first lets the calls in flight finish. The app polls on its own, so a call can be
 * running whenever a check ends. `page.unroute` does not wait for it: taking a page's last route
 * away continues the request on the server side, the handler's own `fulfill` then finds the
 * route handled ("Route is already handled!"), and that rejection lands outside every assertion
 * and fails a script whose checks all passed. `unrouteAll({ behavior: "wait" })` has the same
 * race between two calls in flight (playwright-core 1.63), and "ignoreErrors" would hide a
 * handler's real failure: a call that fails here fails the unroute.
 */
export async function routeDrained(page: Pick<Page, "route" | "unroute">, url: string | ((url: URL) => boolean), handle: (route: Route) => Promise<void>): Promise<() => Promise<void>> {
  const named = typeof url === "string" ? url : url.name;
  const running = new Set<Promise<void>>();
  const handler = (route: Route): Promise<void> => {
    const call = handle(route).finally(() => { running.delete(call); });
    running.add(call);
    return call;
  };
  await page.route(url, handler);
  return async () => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`route ${named}: its handlers did not finish in ${DRAIN_MS} ms`)), DRAIN_MS);
    });
    try {
      // the route stays while its calls finish, so a poll arriving meanwhile is handled too
      while (running.size > 0) await Promise.race([Promise.all(running), deadline]);
      // nothing awaited between the empty set and the removal: no call can start in between
      await Promise.race([page.unroute(url, handler), deadline]);
    } finally {
      clearTimeout(timer);
    }
  };
}
