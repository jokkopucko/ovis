import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "playwright-core";
import panes from "../site/demo/fixtures/panes.json";
import { withDemoBrowser } from "./demo-browser.ts";

// The demo roster with what herdr plugins report on its panes (#1209): the Quota plugin's usage and
// a summary on checkout-api's Claude, a task's progress on web-dashboard's Codex, a plugin's line for
// the OMP agent (display_agent), and markup that must stay text. Only this disposable demo fixture is
// rewritten; no live session is read. A roster the page reads carries the same as one pushed to it:
// the page reads it again every 30 seconds, and a read without them would take them off the rows
// until the next push.
const evidence = process.env["UI_EVIDENCE_DIR"];
const LONG = "reviewing the authentication middleware and the session refresh path before the release branch is cut";
const patch = `(() => {
  const EventSourceDemo = window.EventSource;
  const reports = {
    "w1C:p1": { tokens: { quota: "5h 95% · Wk 67%", summary: ${JSON.stringify(LONG)} } },
    "w1D:p1": { tokens: { progress: "40% 12m", note: "<b>not markup</b>" } },
    [${JSON.stringify(panes.omp)}]: { display_agent: "needs a login · 8m ago" },
  };
  const roster = (machines) => machines.map((machine) => {
    const copy = structuredClone(machine);
    for (const list of [copy.snapshot?.panes ?? [], copy.snapshot?.agents ?? []]) for (const entry of list) Object.assign(entry, structuredClone(reports[entry.pane_id] ?? {}));
    return copy;
  });
  const sources = new Set();
  let last = [];
  const fetchDemo = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const answer = await fetchDemo(input, init);
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, location.href);
    const method = init?.method ?? (input instanceof Request ? input.method : "GET");
    if (url.pathname !== "/api/machines" || method.toUpperCase() !== "GET" || !answer.ok) return answer;
    const body = await answer.clone().json();
    if (!Array.isArray(body.machines)) return answer;
    last = body.machines;
    return new Response(JSON.stringify({ ...body, machines: roster(body.machines) }), { status: answer.status, headers: answer.headers });
  };
  window.__tokens = {
    // a roster with a pane's tokens changed, as the server sends after herdr's pane.updated
    report(paneId, tokens) { reports[paneId] = { ...reports[paneId], tokens }; for (const source of sources) source.tell({ type: "machines", machines: roster(last) }); },
    // a roster with what a waiting agent says it waits for (OSC 7501's message)
    says(paneId, agent_message) { reports[paneId] = { ...reports[paneId], agent_message }; for (const source of sources) source.tell({ type: "machines", machines: roster(last) }); },
    // herdr's agent rows, as the server tells them
    rows(agents) { for (const source of sources) source.tell({ type: "herdr-sidebar", agents }); },
  };
  window.EventSource = class extends EventTarget {
    constructor(url, options) {
      super(); this.inner = new EventSourceDemo(url, options); this.readyState = 1; sources.add(this);
      this.inner.onmessage = (event) => {
        const message = JSON.parse(event.data);
        if (message.type === "machines") { last = message.machines; message.machines = roster(message.machines); }
        this.tell(message);
      };
      this.inner.onerror = (event) => this.onerror?.(event);
      this.inner.onopen = (event) => this.onopen?.(event);
    }
    tell(message) { this.onmessage?.(new MessageEvent("message", { data: JSON.stringify(message) })); }
    close() { this.inner.close(); this.readyState = 2; sources.delete(this); }
  };
})();`;

const row = (page: Page, pane: string) => page.locator(`.agent-list .agent-item[data-pane="${pane}"]`);
const tokensOf = (page: Page, pane: string) => row(page, pane).locator(".agent-tokens");
const box = async (page: Page, pane: string, selector: string) => (await row(page, pane).locator(selector).boundingBox())!;
async function sheetReach(page: Page, scroller: string): Promise<{ title: boolean; pin: boolean; cancel: boolean; scrolls: boolean }> {
  await page.evaluate(() => Promise.all(document.getAnimations().filter((animation) => animation.effect?.getComputedTiming().endTime !== Infinity).map((animation) => animation.finished)));
  return page.evaluate((selector) => {
    const hittable = (target: string): boolean => {
      const element = document.querySelector(target);
      if (!element) return false;
      const box = element.getBoundingClientRect();
      const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
      return box.top >= 0 && box.bottom <= innerHeight && !!hit && element.contains(hit);
    };
    const long = document.querySelector(selector)!;
    return { title: hittable(".row-sheet .row-menu-target-name"), pin: hittable(".row-sheet .row-sheet-item"), cancel: hittable(".row-sheet .row-sheet-cancel"), scrolls: long.scrollHeight > long.clientHeight };
  }, scroller);
}

await withDemoBrowser({ tempPrefix: "herdr-sidebar-tokens-", prefix: "/", afterTransport: '<script src="./sidebar-tokens.js"></script>' }, async ({ app, newContext, baseUrl }) => {
  writeFileSync(join(app, "sidebar-tokens.js"), patch);
  for (const phone of [false, true]) for (const rows of ["one", "two"] as const) {
    const theme = rows === "one" ? "dark" : "light";
    const context = await newContext(phone
      ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, colorScheme: theme }
      : { viewport: { width: 1280, height: 900 }, colorScheme: theme });
    try {
      await context.addInitScript(([value, sidebarRows]) => localStorage.setItem("ovis:settings", JSON.stringify({ language: "en", theme: value, sidebarRows })), [theme, rows] as const);
      const page = await context.newPage();
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(`${baseUrl}?pane=${encodeURIComponent(panes.shell)}`);
      if (phone) {
        await page.getByRole("button", { name: "Open workspace list", exact: true }).click();
        const toggle = page.locator(".agent-section-toggle");
        if (await toggle.getAttribute("aria-expanded") === "false") await toggle.click();
      }
      const label = `${phone ? "phone" : "desktop"} ${rows === "one" ? "One line" : "Two lines"}`;

      await tokensOf(page, panes.api).waitFor();
      assert.equal(await tokensOf(page, panes.api).textContent(), `5h 95% · Wk 67% · ${LONG}`, "every token of the pane, by name");
      assert.equal(await tokensOf(page, panes.web).textContent(), "<b>not markup</b> · 40% 12m", "a value is text, never markup");
      assert.equal(await row(page, panes.web).locator(".agent-tokens b").count(), 0);
      assert.equal(await row(page, panes.shell).locator(".agent-tokens").count(), 0, "a pane without tokens draws no line");
      assert.match(await row(page, panes.omp).locator(".agent-context").textContent() ?? "", /^needs a login · 8m ago · /, "a plugin's line for the agent leads the place");

      const title = await box(page, panes.api, ".agent-title"), place = await box(page, panes.api, ".agent-context"), tokens = await box(page, panes.api, ".agent-tokens");
      const placeDrawn = !(phone && rows === "one");
      if (!placeDrawn) assert.ok(place.width <= 1 && place.height <= 1, `a phone's One line row draws no place (${place.width}x${place.height})`);
      else if (rows === "one") assert.ok(Math.abs(title.y + title.height - (place.y + place.height)) < 3, "One line keeps the place beside the title");
      else assert.ok(place.y >= title.y + title.height - 1, "Two lines keeps the place under the title");
      const above = placeDrawn ? place : title;
      assert.ok(tokens.y >= above.y + above.height - 1, `the tokens have their own line, under the ${placeDrawn ? "place" : "title"}`);
      assert.ok(await tokensOf(page, panes.api).evaluate((element) => element.scrollWidth > element.clientWidth), "a long value is cut");
      assert.match(await row(page, panes.api).locator(".agent-select").getAttribute("title") ?? "", new RegExp(LONG), "the tooltip says it whole");
      const sizes = await row(page, panes.api).evaluate((item) => ({
        title: parseFloat(getComputedStyle(item.querySelector(".agent-title")!).fontSize),
        tokens: parseFloat(getComputedStyle(item.querySelector(".agent-tokens")!).fontSize),
        place: getComputedStyle(item.querySelector(".agent-context")!).color,
        color: getComputedStyle(item.querySelector(".agent-tokens")!).color,
      }));
      assert.ok(sizes.tokens < sizes.title, "smaller than the title");
      assert.equal(sizes.color, sizes.place, "dim as the place");
      if (evidence) {
        mkdirSync(evidence, { recursive: true });
        await page.locator(".agents-sidebar").screenshot({ path: join(evidence, `tokens-${phone ? "phone" : "desktop"}-${rows}-line.png`) });
      }

      if (phone) {
        await row(page, panes.api).locator(".row-menu-toggle").click();
        const detail = page.locator(".row-sheet .row-sheet-detail");
        assert.equal(await detail.textContent(), `5h 95% · Wk 67% · ${LONG}`, "the sheet says every token whole");
        assert.ok(await detail.evaluate((element) => element.scrollWidth <= element.clientWidth + 1), "the sheet wraps instead of cutting");
        if (evidence && rows === "one") await page.locator(".row-sheet").screenshot({ path: join(evidence, "tokens-phone-sheet.png") });
        await page.evaluate((pane) => (window as unknown as { __tokens: { report(paneId: string, tokens: object): void } }).__tokens.report(pane, { quota: "5h 40% \u00b7 Wk 70%" }), panes.api);
        await page.waitForFunction(() => document.querySelector(".row-sheet .row-sheet-detail")?.textContent === "5h 40% \u00b7 Wk 70%");
        await page.locator(".row-sheet-cancel").click();
        await page.locator(".row-sheet").waitFor({ state: "detached" });

        const many = Object.fromEntries(Array.from({ length: 32 }, (_, i) => [`t${String(i).padStart(2, "0")}`, `value ${i} ${"lorem ipsum dolor sit amet ".repeat(11).trim()}`]));
        await page.evaluate(([pane, tokens]) => (window as unknown as { __tokens: { report(paneId: string, tokens: object): void } }).__tokens.report(pane, tokens), [panes.api, many] as const);
        await page.waitForFunction((pane) => document.querySelector(`.agent-list .agent-item[data-pane="${pane}"] .agent-tokens`)?.textContent?.startsWith("value 0 "), panes.api);
        await row(page, panes.api).locator(".row-menu-toggle").click();
        await detail.waitFor();
        assert.deepEqual(await sheetReach(page, ".row-sheet .row-sheet-detail"), { title: true, pin: true, cancel: true, scrolls: true }, "long tokens scroll in the sheet and leave its title and actions in reach");
        if (evidence && rows === "one") await page.screenshot({ path: join(evidence, "tokens-phone-sheet-many.png") });
        await page.locator(".row-sheet-cancel").click();
        await page.locator(".row-sheet").waitFor({ state: "detached" });
        await page.evaluate(([pane, summary]) => (window as unknown as { __tokens: { report(paneId: string, tokens: object): void } }).__tokens.report(pane, { quota: "5h 95% \u00b7 Wk 67%", summary }), [panes.api, LONG] as const);

        const reason = "the migration renames a column the billing export still reads, so say whether to keep the old name too. ".repeat(30).trim();
        await page.evaluate(([pane, message]) => (window as unknown as { __tokens: { says(paneId: string, message: string): void } }).__tokens.says(pane, message), [panes.web, reason] as const);
        await row(page, panes.web).locator(".row-menu-toggle").click();
        const waitsFor = page.locator(".row-sheet .row-sheet-alert");
        await waitsFor.waitFor();
        assert.equal(await waitsFor.textContent(), reason, "the sheet says what the agent waits for, whole");
        const reasonReach = await sheetReach(page, ".row-sheet .row-sheet-alert");
        if (evidence && rows === "one") await page.screenshot({ path: join(evidence, "tokens-phone-sheet-long-reason.png") });
        assert.deepEqual(reasonReach, { title: true, pin: true, cancel: true, scrolls: true }, "a long waiting reason scrolls in the sheet and leaves its title and actions in reach");
        await page.locator(".row-sheet-cancel").click();
        await page.locator(".row-sheet").waitFor({ state: "detached" });
        await page.evaluate((pane) => (window as unknown as { __tokens: { says(paneId: string, message: string): void } }).__tokens.says(pane, ""), panes.web);
      }

      await page.evaluate(() => (window as unknown as { __tokens: { rows(agents: unknown): void } }).__tokens.rows({
        rows: [{ name: "progress" }, { name: "quota", rules: [{ starts_with: "0%", hide: true }] }],
        by_agent: {},
      }));
      await page.waitForFunction((pane) => document.querySelector(`.agent-list .agent-item[data-pane="${pane}"] .agent-tokens`)?.textContent === "5h 95% · Wk 67%", panes.api);
      assert.equal(await tokensOf(page, panes.web).textContent(), "40% 12m", "progress, and not the token the rows leave out");
      await page.evaluate((pane) => (window as unknown as { __tokens: { report(paneId: string, tokens: object): void } }).__tokens.report(pane, { quota: "5h 40% · Wk 70%" }), panes.api);
      await page.waitForFunction((pane) => document.querySelector(`.agent-list .agent-item[data-pane="${pane}"] .agent-tokens`)?.textContent === "5h 40% · Wk 70%", panes.api);
      await page.evaluate((pane) => (window as unknown as { __tokens: { report(paneId: string, tokens: object): void } }).__tokens.report(pane, { quota: "0% left" }), panes.api);
      await page.waitForFunction((pane) => document.querySelector(`.agent-list .agent-item[data-pane="${pane}"] .agent-tokens`) === null, panes.api);
      if (evidence && !phone && rows === "one") await page.locator(".agents-sidebar").screenshot({ path: join(evidence, "tokens-desktop-herdr-rows.png") });
      assert.deepEqual(errors, []);
      console.log(`PASS ${label}: plugin tokens draw a dim line of their own, cut with the whole text in the tooltip${phone ? " and the sheet" : ""}, follow herdr's rows and change live`);
    } finally { await context.close(); }
  }
});
