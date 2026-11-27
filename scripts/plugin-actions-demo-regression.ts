import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import panes from "../site/demo/fixtures/panes.json";
import { withDemoBrowser } from "./demo-browser.ts";

// All files and HTTP traffic stay in this disposable, loopback-only app; no herdr session is opened.
const TRACEBACK = ["Traceback (most recent call last):", ...Array.from({ length: 40 }, (_, line) => `  File "/opt/example/layout.py", line ${line + 1}, in apply`), "RuntimeError: no layout saved for this workspace"].join("\n");

type Calls = { posts: string[]; asked: string[] };
const patch = `(() => {
  const demoFetch = window.fetch.bind(window);
  const calls = { posts: [], asked: [] };
  window.pluginCalls = calls;
  const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  const run = (log_id, status, exit_code, output) => ({ log_id, status, exit_code, output, opened_pane_id: null });
  window.fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, location.href);
    if (!url.pathname.endsWith("/plugin/action")) return demoFetch(input, init);
    if ((init?.method ?? "GET").toUpperCase() === "POST") {
      const action = JSON.parse(String(init.body)).action_id;
      calls.posts.push(action);
      return json(run("log-" + action, "running", null, null));
    }
    const log = url.searchParams.get("log_id");
    calls.asked.push(log);
    if (calls.asked.filter((entry) => entry === log).length < 2) return json(run(log, "running", null, null));
    return json(log === "log-apply" ? run(log, "failed", 1, ${JSON.stringify(TRACEBACK)}) : run(log, "succeeded", 0, null));
  };
})();`;

await withDemoBrowser({ tempPrefix: "herdr-plugin-actions-demo-", afterTransport: '\n    <script src="./plugin-run-patch.js"></script>' }, async ({ app, newContext, baseUrl }) => {
  writeFileSync(join(app, "plugin-run-patch.js"), patch);
  // 390x420: what `interactive-widget=resizes-content` leaves of a phone while its keyboard is up
  const context = await newContext({ viewport: { width: 390, height: 420 }, isMobile: true, hasTouch: true });
  try {
    await context.addInitScript(() => localStorage.setItem("ovis:settings", JSON.stringify({ language: "en" })));
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`${baseUrl}?pane=${encodeURIComponent(panes.api)}`);
    await page.locator(".conn-live").waitFor();
    const palette = page.getByRole("dialog", { name: "Command palette", exact: true });
    const calls = (): Promise<Calls> => page.evaluate(() => (window as unknown as { pluginCalls: Calls }).pluginCalls);
    const open = async (): Promise<void> => {
      await page.keyboard.press("ControlOrMeta+Shift+K");
      await palette.waitFor();
      await palette.getByText("Plugin actions", { exact: true }).waitFor();
    };

    await open();
    const apply = palette.getByRole("option", { name: /Apply layout/ });
    await apply.evaluate((row: HTMLElement) => row.click());
    await palette.locator('.palette-plugin-action[aria-busy="true"]').waitFor();
    await page.waitForFunction(() => (window as unknown as { pluginCalls: Calls }).pluginCalls.asked.length >= 1);
    assert.equal(await palette.isVisible(), true, "a run the server calls running keeps the palette open");
    assert.match(await palette.locator('.palette-plugin-action[aria-busy="true"]').textContent() ?? "", /Running…/);
    const alert = palette.getByRole("alert");
    await alert.waitFor({ timeout: 10_000 });
    assert.equal(await alert.textContent(), `Apply layout failed: ${TRACEBACK}`);
    assert.deepEqual(await calls(), { posts: ["apply"], asked: ["log-apply", "log-apply"] });
    assert.equal(await palette.locator('.palette-plugin-action[aria-busy="true"]').count(), 0, "the row is no longer running once the run failed");
    console.log("PASS a command that fails after the server stopped waiting is reported, and the palette stays open");

    const geometry = await page.evaluate(() => {
      const box = (selector: string) => document.querySelector<HTMLElement>(selector)!.getBoundingClientRect();
      const error = document.querySelector<HTMLElement>(".palette-error")!;
      const results = document.querySelector<HTMLElement>(".palette-results")!;
      results.scrollTop = results.scrollHeight;
      const row = [...document.querySelectorAll<HTMLElement>(".palette-plugin-action")].at(-1)!;
      const rect = row.getBoundingClientRect();
      const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
      return {
        viewport: innerHeight, palette: { top: box(".command-palette").top, bottom: box(".command-palette").bottom },
        error: { height: box(".palette-error").height, scrolls: error.scrollHeight > error.clientHeight + 1, overflow: getComputedStyle(error).overflowY },
        results: { height: box(".palette-results").height, bottom: box(".palette-results").bottom },
        row: { top: rect.top, bottom: rect.bottom, hit: hit === row || row.contains(hit) },
      };
    });
    assert.ok(geometry.error.height <= geometry.viewport * 0.25 + 1, `the traceback takes at most a quarter of the screen: ${JSON.stringify(geometry)}`);
    assert.ok(geometry.error.scrolls && geometry.error.overflow === "auto", `the rest of the traceback is reached by scrolling it: ${JSON.stringify(geometry)}`);
    assert.ok(geometry.palette.bottom <= geometry.viewport + 0.5 && geometry.results.bottom <= geometry.palette.bottom + 0.5, `the palette ends on the screen: ${JSON.stringify(geometry)}`);
    assert.ok(geometry.results.height >= 2 * 44, `the list keeps room under the traceback: ${JSON.stringify(geometry)}`);
    assert.ok(geometry.row.hit && geometry.row.bottom <= geometry.viewport + 0.5, `a plugin action is still on screen to tap: ${JSON.stringify(geometry)}`);
    if (process.env.UI_EVIDENCE_DIR) await page.screenshot({ path: join(process.env.UI_EVIDENCE_DIR, "plugin-action-traceback-phone-keyboard.png") });
    console.log(`PASS a ${TRACEBACK.split("\n").length}-line traceback at 390x420 scrolls in ${Math.round(geometry.error.height)}px and leaves the list ${Math.round(geometry.results.height)}px`);

    await palette.getByRole("option", { name: /Save layout/ }).evaluate((row: HTMLElement) => row.click());
    await palette.locator('.palette-plugin-action[aria-busy="true"]').waitFor();
    await palette.waitFor({ state: "hidden", timeout: 10_000 });
    assert.deepEqual((await calls()).asked.filter((log) => log === "log-save"), ["log-save", "log-save"]);
    console.log("PASS a command that ends well after the server stopped waiting closes the palette then, not before");

    await open();
    await palette.getByRole("option", { name: /Apply layout/ }).evaluate((row: HTMLElement) => row.click());
    await palette.locator('.palette-plugin-action[aria-busy="true"]').waitFor();
    const before = (await calls()).asked.filter((log) => log === "log-apply").length;
    await page.keyboard.press("Escape");
    await palette.waitFor({ state: "hidden" });
    await open();
    assert.equal(await palette.locator('.palette-plugin-action[aria-busy="true"]').count(), 0, `a run left behind is not shown as running in the next opening: ${JSON.stringify(await calls())} ${await palette.locator(".palette-results").textContent()}`);
    await page.evaluate(() => {
      const seen = window as unknown as { paletteErrors: number };
      seen.paletteErrors = document.querySelectorAll(".palette-error").length;
      new MutationObserver(() => { seen.paletteErrors += document.querySelectorAll(".palette-error").length; }).observe(document.body, { childList: true, subtree: true });
    });
    await palette.getByRole("option", { name: /Save layout/ }).evaluate((row: HTMLElement) => row.click());
    await palette.waitFor({ state: "hidden", timeout: 10_000 });
    assert.equal(await page.evaluate(() => (window as unknown as { paletteErrors: number }).paletteErrors), 0, "the abandoned run's failure is said in no later opening");
    const after = (await calls()).asked.filter((log) => log === "log-apply").length;
    assert.ok(after <= before + 1, `a closed palette stops asking about its run: ${before} asks before, ${after} after`);
    assert.deepEqual(errors, []);
    console.log("PASS a run whose palette was closed reports to no later opening");
  } finally { await context.close(); }
});
