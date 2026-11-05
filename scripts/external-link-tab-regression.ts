import assert from "node:assert/strict";
import { join } from "node:path";
import { chromium, type BrowserContext, type Page } from "playwright-core";
import { chromePath } from "./chrome-path.ts";

// The app's own link opener (src/lib/terminalFileLinks.ts) in a real Chromium: with "Reuse tab for
// external links" on, a second link replaces the first one's tab; off, every link gets a tab of its
// own with no opener. The page that clicks is served on 127.0.0.1 with Ovis's Referrer-Policy and
// the links on localhost, so the tab is another site's, as an agent's link is. Loopback only.
const built = await Bun.build({ entrypoints: [join(import.meta.dir, "../src/lib/terminalFileLinks.ts")], format: "esm", target: "browser" });
assert.ok(built.success, built.logs.join("\n"));
const opener = await built.outputs[0]!.text();
const LINKS = `<button id="one">one</button><button id="two">two</button><script type="module">
  import { openWebLink } from "/opener.js";
  const reuse = new URLSearchParams(location.search).get("reuse") === "1";
  const site = "http://localhost:" + location.port;
  document.getElementById("one").onclick = () => openWebLink(site + "/page-one", reuse);
  document.getElementById("two").onclick = () => openWebLink(site + "/page-two", reuse);
</script>`;
const PAGE = `<script>document.title = JSON.stringify({ opener: window.opener !== null, referrer: document.referrer });</script>`;
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
  const path = new URL(request.url).pathname;
  const html = { "content-type": "text/html", "referrer-policy": "no-referrer" };
  if (path === "/opener.js") return new Response(opener, { headers: { "content-type": "text/javascript" } });
  if (path === "/links") return new Response(LINKS, { headers: html });
  if (path.startsWith("/page-")) return new Response(PAGE, { headers: html });
  return new Response("not found", { status: 404 });
} });

/** Clicks `button` and resolves with the page that then shows `path`, the tab it opened or the one it steered. */
async function follow(context: BrowserContext, page: Page, button: string, path: string): Promise<Page> {
  const shows = (url: URL): boolean => url.pathname === path;
  const waits = [
    context.waitForEvent("page").then(async (tab) => { await tab.waitForURL(shows); return tab; }),
    ...context.pages().filter((tab) => tab !== page).map(async (tab) => { await tab.waitForURL(shows); return tab; }),
  ];
  // the waits that lose, or a click that fails, still settle quietly once the context closes
  for (const wait of waits) wait.catch(() => undefined);
  await page.click(button);
  const tab = await Promise.any(waits).catch(() => { throw new Error(`no tab showed ${path} after ${button}`); });
  await tab.waitForFunction(() => document.title.startsWith("{"));
  return tab;
}
const seen = async (tab: Page): Promise<{ opener: boolean; referrer: string }> => JSON.parse(await tab.title()) as { opener: boolean; referrer: string };

const browser = await chromium.launch({ executablePath: chromePath(), headless: true, args: ["--no-sandbox"] });
try {
  for (const reuse of [true, false]) {
    const context = await browser.newContext();
    context.setDefaultTimeout(15_000);
    try {
      const page = await context.newPage();
      page.setDefaultTimeout(15_000);
      await page.goto(`http://127.0.0.1:${server.port}/links?reuse=${reuse ? 1 : 0}`);
      const first = await follow(context, page, "#one", "/page-one");
      const one = await seen(first);
      const second = await follow(context, page, "#two", "/page-two");
      const two = await seen(second);
      const tabs = context.pages().map((tab) => new URL(tab.url()).pathname);
      console.log(`REUSE=${reuse} tabs=${JSON.stringify(tabs)} first=${JSON.stringify(one)} second=${JSON.stringify(two)}`);
      if (reuse) {
        assert.equal(second, first, "the second link replaces the first one's tab");
        assert.deepEqual(tabs, ["/links", "/page-two"]);
        assert.equal(one.opener && two.opener, true, "a tab Ovis steers keeps it as opener: the setting says so");
      } else {
        assert.notEqual(second, first, "each link opens a tab of its own");
        assert.deepEqual(tabs, ["/links", "/page-one", "/page-two"]);
        assert.equal(one.opener || two.opener, false, "a new tab has no opener");
      }
      assert.equal(one.referrer + two.referrer, "", "no tab learns the address of the page that opened it");
    } finally {
      await context.close();
    }
  }
  console.log("EXTERNAL LINK TAB OK");
} finally {
  await browser.close();
  await server.stop(true);
}
