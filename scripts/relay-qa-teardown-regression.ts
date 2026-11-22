/**
 * context.close() first disposes the context's fetched responses and only then closes its pages; the proxy's fetched
 * response is held until that disposal is done, so its fulfill always lands in that window, as it did by chance in
 * relay-dashboard-browser-qa ("Fetch response has been disposed").
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chromium } from "playwright-core";
import type { APIResponse, BrowserContext, Route } from "playwright-core";
import { chromePath } from "./chrome-path.ts";
import { closeMarked, whileOpen } from "./relay-qa-teardown.ts";

const DEADLINE_MS = 20_000;

const shell = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("<p>shell</p>", { headers: { "content-type": "text/html" } }) });
const browser = await chromium.launch({ executablePath: chromePath(), headless: true, args: ["--no-sandbox"] });

async function within<T>(signal: Promise<T>, what: string): Promise<T> {
  const timeout = AbortSignal.timeout(DEADLINE_MS);
  const expired = new Promise<never>((_, reject) => {
    timeout.addEventListener("abort", () => reject(new Error(`no ${what} within ${DEADLINE_MS} ms`)), { once: true });
  });
  return Promise.race([signal, expired]);
}

async function proxied(origin: string, fetched: (response: APIResponse) => Promise<APIResponse>): Promise<{ context: BrowserContext; outcome: Promise<unknown>; navigation: Promise<unknown> }> {
  const context = await browser.newContext();
  const outcome = Promise.withResolvers<unknown>();
  const proxy = whileOpen(context, async (route: Route) => {
    const url = new URL(route.request().url());
    await route.fulfill({ response: await fetched(await route.fetch({ url: `${origin}${url.pathname}${url.search}` })) });
  });
  await context.route(/^https:\/\/app\.ovis\.sh\//, (route) => proxy(route).then(() => outcome.resolve(null), (error: unknown) => outcome.resolve(error)));
  const page = await context.newPage();
  const navigation = page.goto("https://app.ovis.sh/").then(() => null, (error: unknown) => error);
  return { context, outcome: outcome.promise, navigation };
}

async function beforeNavigationEnds<T>(signal: Promise<T>, navigation: Promise<unknown>, what: string): Promise<T> {
  const first = await within(Promise.race([signal.then((value) => ({ value })), navigation.then((error) => ({ ended: error }))]), what);
  if ("ended" in first) throw new Error(`the navigation ended before ${what}: ${first.ended === null ? "it loaded" : String(first.ended).split("\n")[0]}`);
  return first.value;
}

const failures: string[] = [];
const report = (holds: boolean, line: string): void => { console.log(`${holds ? "PASS" : "FAIL"} ${line}`); if (!holds) failures.push(line); };
try {
  const held = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const { context, outcome, navigation } = await proxied(`http://127.0.0.1:${shell.port}`, async (response) => { held.resolve(); await release.promise; return response; });
  const dispose = context.request.dispose.bind(context.request);
  context.request.dispose = async (options) => { await dispose(options); release.resolve(); };
  await beforeNavigationEnds(held.promise, navigation, "the proxy held its fetched response");
  const closing = closeMarked(context);
  const error = await within(outcome, "proxy outcome after the context closed");
  await within(closing, "context close");
  report(error === null, `close context mid-request: the proxy ${error === null ? "ended quietly" : `threw ${String(error).split("\n")[0]}`}`);

  const open = await proxied("http://127.0.0.1:1", async (response) => response);
  const failed = await beforeNavigationEnds(open.outcome, open.navigation, "the failed proxy's outcome");
  report(failed instanceof Error, `open page: a failed proxy ${failed instanceof Error ? `still throws (${failed.message.split("\n")[0]})` : "ended quietly"}`);
  await within(closeMarked(open.context), "context close");
} finally {
  const cleanupErrors: unknown[] = [];
  await within(browser.close(), "browser close").catch((error: unknown) => {
    cleanupErrors.push(error);
    const children = (pid: string): string[] => {
      try { return execFileSync("pgrep", ["-P", pid], { encoding: "utf8" }).trim().split(/\s+/).filter(Boolean); }
      catch { return []; }
    };
    const killTree = (pid: string): void => {
      for (const child of children(pid)) killTree(child);
      try { process.kill(Number(pid), "SIGKILL"); }
      catch (err: unknown) { if (!(err instanceof Error && "code" in err && err.code === "ESRCH")) throw err; }
    };
    for (const child of children(String(process.pid))) killTree(child);
  });
  await within(shell.stop(true), "shell stop").catch((error: unknown) => {
    cleanupErrors.push(error);
  });
  if (cleanupErrors.length > 0) {
    for (const error of cleanupErrors) console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
assert.deepEqual(failures, [], failures.join("\n"));
