/**
 * Two stamps are stored as this device would have kept them, so their ages are known: the waiting
 * agent's two hours and a resting agent's 3 days (ages a slow run cannot carry over a unit's edge),
 * each with the counter herdr gives its agent and the server's count of its finishes (read from the
 * demo's own session on a first load), which is what lets a later load trust it.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser, type Page, type Route } from "playwright-core";
import panes from "../site/demo/fixtures/panes.json";
import { buildDemoApp } from "./demo-build.ts";
import { chromePath } from "./chrome-path.ts";
import { serveDemo } from "./demo-server.ts";

const EVIDENCE = process.env.UI_EVIDENCE_DIR;
const SERVER = "&demo_finish_epoch=kept";
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 86_400_000;

async function openWithClock(page: Page, url: string): Promise<void> {
  // Install the clock in the committed document. If boot reads the clock at epoch zero,
  // the app clamps the persisted timestamps to zero before the clock reaches the present.
  // the hold is on the demo build's transport script (scripts/demo-build.ts); if that file is renamed, it must fail here
  const { promise, resolve } = Promise.withResolvers<void>();
  let held = false;
  const hold = async (route: Route): Promise<void> => { held = true; await promise; await route.continue(); };
  await page.route("**/demo-transport.js", hold);
  try {
    await page.goto(url, { waitUntil: "commit" });
    await page.clock.install();
    // install() lets the clock run in real time and pauseAt() is a later round trip, so the target must stay ahead of
    // the clock through a stall between them (pauseAt rejects a target in the past); 10 s is far below the minute the
    // "<1m" checks allow
    await page.clock.pauseAt(await page.evaluate(() => Date.now() + 10_000));
  } finally {
    resolve();
  }
  await page.waitForLoadState("load");
  await page.unroute("**/demo-transport.js", hold);
  assert.ok(held, "the demo's transport script was held until the clock was installed");
}

async function run(browser: Browser, origin: string, width: number, theme: "light" | "dark"): Promise<void> {
  const phone = width === 390;
  const tag = `${width} ${theme}`;
  const device = { viewport: { width, height: phone ? 844 : 900 }, ...(phone ? { deviceScaleFactor: 3, isMobile: true, hasTouch: true } : {}), locale: "en-US", colorScheme: theme } as const;
  const context = await browser.newContext(device);
  await context.addInitScript(({ settings }) => {
    if (localStorage.getItem("ovis:settings") !== null) return;
    localStorage.setItem("ovis:settings", settings);
    localStorage.setItem("ovis:agent-groups", "true");
    localStorage.setItem("ovis:agents-collapsed", "0");
    localStorage.setItem("ovis:sidebar-filter-shown", "true");
  }, { settings: JSON.stringify({ language: "en", theme }) });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));

  const row = (pane: string) => page.locator(`.agents-sidebar .agent-item[data-pane="${pane}"]`);
  const state = (pane: string, status: string) => row(pane).locator(`.sidebar-status[data-status="${status}"]`);
  const since = (pane: string): Promise<string[]> => row(pane).locator(".agent-since").allTextContents();
  const heading = (group: string) => page.locator(`.agents-sidebar .agent-group-label[data-group="${group}"] button`);
  const expanded = (group: string): Promise<string | null> => heading(group).getAttribute("aria-expanded");
  const list = async (shown: string = panes.web): Promise<void> => {
    const toggle = page.locator("#drawer-toggle");
    if (phone && await toggle.getAttribute("aria-expanded") === "false") await toggle.click();
    await row(shown).waitFor();
  };
  const open = async (query = ""): Promise<void> => {
    await page.goto(`${origin}?pane=${encodeURIComponent(panes.web)}${SERVER}${query}`);
    await page.locator(".conn-live").waitFor({ state: "attached" });
    await list();
  };

  // A first load only to read the demo's one PC, its herdr and its server (site/demo/transport.ts): the stamps are stored
  // as the app stores them (lib/agentStateSince.ts), each with the counter herdr gives its agent now and the server's
  // count of its finishes. The same two numbers on the next load prove that the state did not change meanwhile; the
  // third stamp has no counter of herdr's, so nothing proves it.
  await open();
  const counters = await page.evaluate(async ({ waiting, resting, uncounted, waited, rested }) => {
    const { snapshot } = await (await fetch("/api/session")).json() as { snapshot: { herdr_lifetime?: string | null; finish_epoch?: string; panes: Array<{ pane_id: string; terminal_id: string; finish_id?: number }>; agents: Array<{ pane_id: string; state_change_seq?: number }> } };
    const counter = (pane: string): number | undefined => snapshot.agents.find((agent) => agent.pane_id === pane)?.state_change_seq;
    const finishes = (pane: string): number | undefined => snapshot.panes.find((entry) => entry.pane_id === pane)?.finish_id;
    const terminal = (pane: string): string | undefined => snapshot.panes.find((entry) => entry.pane_id === pane)?.terminal_id;
    const now = Date.now();
    localStorage.setItem("ovis:agent-state-since", JSON.stringify({ version: 1, pcs: { local: { lifetime: snapshot.herdr_lifetime, epoch: snapshot.finish_epoch, rows: {
      [waiting]: { state: "blocked", at: now - waited, terminal: terminal(waiting), seq: counter(waiting), finish: finishes(waiting) },
      [resting]: { state: "idle", at: now - rested, terminal: terminal(resting), seq: counter(resting), finish: finishes(resting) },
      [uncounted]: { state: "idle", at: now - rested, terminal: terminal(uncounted), finish: finishes(uncounted) },
    } } } }));
    return { epoch: snapshot.finish_epoch, numbers: [counter(waiting), counter(resting), finishes(waiting), finishes(resting)], terminals: [terminal(waiting), terminal(resting), terminal(uncounted)] };
  }, { waiting: panes.web, resting: panes.omp, uncounted: panes.cli, waited: 2 * HOUR + 5 * MINUTE, rested: 3 * DAY });
  assert.ok(counters.numbers.every((number) => Number.isSafeInteger(number)), `${tag}: the demo's agents carry herdr's counter and the server's count of their finishes: ${JSON.stringify(counters)}`);
  assert.ok(counters.terminals.every((name) => typeof name === "string" && name !== "") && new Set(counters.terminals).size === counters.terminals.length, `${tag}: each of the demo's panes names a terminal of its own: ${JSON.stringify(counters)}`);
  assert.equal(counters.epoch, "kept", `${tag}: every load of this check is under the one server it names`);

  await open();
  assert.equal(await expanded("idle"), "false", `${tag}: Idle starts folded`);
  assert.equal(await expanded("blocked"), "true", `${tag}: Needs you starts open`);
  await row(panes.omp).waitFor({ state: "hidden" });
  assert.deepEqual(await since(panes.web), ["2h"], `${tag}: a waiting agent says how long it has waited`);
  const count = await heading("idle").locator(".agent-group-count").textContent();
  const target = await heading("idle").boundingBox();
  assert.ok(target !== null && target.height >= (phone ? 44 : 24), `${tag}: the heading is a ${phone ? "finger's" : "pointer's"} target, ${target?.height}px`);
  if (EVIDENCE) await page.screenshot({ path: join(EVIDENCE, `agent-state-groups-${width}-${theme}.png`) });

  await heading("idle").click();
  assert.equal(await expanded("idle"), "true", `${tag}: its heading opens it`);
  await row(panes.omp).waitFor({ state: "visible" });
  assert.equal(await heading("idle").locator(".agent-group-count").textContent(), count, `${tag}: the heading says the same count open and folded`);
  assert.deepEqual(await since(panes.omp), ["3d"], `${tag}: a resting agent says how long it has rested`);
  assert.deepEqual(await since(panes.cli), [], `${tag}: a stamp with no counter proves nothing, so its row says no time`);
  assert.deepEqual(await since(panes.flaky), [], `${tag}: a state this device did not see begin says no time`);

  await state(panes.api, "done").waitFor({ state: "attached" });
  assert.deepEqual(await since(panes.api), ["<1m"], `${tag}: a state that begins in sight is stamped`);
  await row(panes.api).locator(".agent-select").click();
  await list();
  await state(panes.api, "idle").waitFor({ state: "attached" });
  assert.deepEqual(await since(panes.api), ["<1m"], `${tag}: reading a finished agent keeps its time`);
  if (EVIDENCE) await page.screenshot({ path: join(EVIDENCE, `agent-state-groups-open-${width}-${theme}.png`) });

  await heading("idle").click();
  assert.equal(await expanded("idle"), "false", `${tag}: its heading folds it`);
  await row(panes.omp).waitFor({ state: "hidden" });
  assert.equal(await row(panes.api).isVisible(), true, `${tag}: the selected agent stays in sight under its folded group`);
  assert.equal(await row(panes.web).isVisible(), true, `${tag}: no other group folds with it`);

  await heading("idle").focus();
  await page.keyboard.press("Enter");
  assert.equal(await expanded("idle"), "true", `${tag}: Enter opens it`);
  await page.keyboard.press("Space");
  assert.equal(await expanded("idle"), "false", `${tag}: Space folds it`);
  assert.equal(await heading("idle").evaluate((node) => node === document.activeElement), true, `${tag}: the focus stays on the heading`);

  await page.keyboard.press("Enter");
  await heading("blocked").click();
  await row(panes.web).waitFor({ state: "hidden" });
  await page.reload();
  await page.locator(".conn-live").waitFor({ state: "attached" });
  await list(panes.api);
  assert.equal(await expanded("idle"), "true", `${tag}: an opened group is kept across a reload`);
  assert.equal(await expanded("blocked"), "false", `${tag}: a fold is kept across a reload`);
  await heading("blocked").click();
  await row(panes.web).waitFor({ state: "visible" });
  assert.deepEqual(await since(panes.web), ["2h"], `${tag}: a stamp is kept across a reload`);

  await heading("idle").click();
  await row(panes.omp).waitFor({ state: "hidden" });
  await page.locator(".sidebar-filter-input").fill("config");
  await row(panes.omp).waitFor({ state: "visible" });
  assert.equal(await expanded("idle"), "true", `${tag}: the filter opens a folded group`);
  assert.equal(await heading("idle").isDisabled(), true, `${tag}: a heading does not fold under the filter`);
  await page.locator(".sidebar-filter-input").fill("");
  await row(panes.omp).waitFor({ state: "hidden" });
  assert.equal(await expanded("idle"), "false", `${tag}: the fold is back once the filter is cleared`);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, `${tag}: no sideways scroll`);

  await heading("idle").click();
  await row(panes.omp).waitFor({ state: "visible" });
  const oneLine = await page.evaluate(() => localStorage.getItem("ovis:settings") ?? "{}");
  await page.evaluate((stored) => localStorage.setItem("ovis:settings", JSON.stringify({ ...(JSON.parse(stored) as object), sidebarRows: "two" })), oneLine);
  await page.reload();
  await page.locator(".conn-live").waitFor({ state: "attached" });
  await list(panes.omp);
  const drawn = (pane: string) => row(pane).evaluate((item) => {
    const box = item.getBoundingClientRect();
    const middle = (selector: string): number | null => {
      const part = item.querySelector(selector)?.getBoundingClientRect();
      return part === undefined ? null : part.top + part.height / 2 - box.top;
    };
    return { height: box.height, title: middle(".agent-title"), place: middle(".agent-context"), time: middle(".agent-since") };
  });
  const timed = await drawn(panes.omp), untimed = await drawn(panes.cli);
  assert.ok(timed.time !== null && untimed.time === null && timed.title !== null && untimed.title !== null && timed.place !== null && untimed.place !== null, `${tag}: two lines draw a title and a place, and a time where a stamp tells of it: ${JSON.stringify([timed, untimed])}`);
  assert.ok(Math.abs(timed.height - untimed.height) < 0.5 && Math.abs(timed.title - untimed.title) < 0.5 && Math.abs(timed.place - untimed.place) < 0.5, `${tag}: on two lines a row with a time is drawn as a row without one: ${JSON.stringify([timed, untimed])}`);
  assert.ok(Math.abs(timed.time - timed.place) < 1, `${tag}: on two lines the time stands on the place's line: ${JSON.stringify(timed)}`);
  await heading("idle").click();
  await row(panes.omp).waitFor({ state: "hidden" });
  await page.evaluate((stored) => localStorage.setItem("ovis:settings", stored), oneLine);

  // a device that only watches (`?demo_devices=watch`) sends nothing, and a fold is its own
  await open("&demo_devices=watch");
  await heading("idle").click();
  assert.equal(await expanded("idle"), "true", `${tag}: a watching device opens a group`);
  await row(panes.omp).waitFor({ state: "visible" });
  await heading("idle").click();
  await row(panes.omp).waitFor({ state: "hidden" });

  const other = await browser.newContext(device);
  await other.addInitScript(({ settings }) => {
    localStorage.setItem("ovis:settings", settings);
    localStorage.setItem("ovis:agent-groups", "true");
    localStorage.setItem("ovis:agents-collapsed", "0");
    localStorage.setItem("ovis:agent-state-folds", JSON.stringify(["done", "idle"]));
  }, { settings: JSON.stringify({ language: "en", theme }) });
  const held = await other.newPage();
  held.on("pageerror", (error) => errors.push(error.message));
  await openWithClock(held, `${origin}?pane=${encodeURIComponent(panes.web)}${SERVER}`);
  await held.clock.runFor(1500);
  await held.locator(".conn-live").waitFor({ state: "attached" });
  if (phone) {
    await held.locator("#drawer-toggle").click();
    await held.clock.runFor(500);
  }
  const working = held.locator(`.agents-sidebar .agent-item[data-pane="${panes.api}"]`);
  await working.waitFor();
  await working.locator(".agent-select").focus();
  await held.clock.runFor(4000);
  await working.waitFor({ state: "hidden" });
  assert.equal(await held.evaluate(() => document.activeElement?.closest("li")?.getAttribute("data-group") ?? null), "done", `${tag}: a focused row that moves under a folded group hands its focus to the heading`);
  await other.close();

  await page.evaluate(() => localStorage.setItem("ovis:agent-state-folds", JSON.stringify(["idle"])));
  // Playwright installs its clock across the context; the old page must stop writing stamps first.
  await page.close();
  const away = await context.newPage();
  away.on("pageerror", (error) => errors.push(error.message));
  await openWithClock(away, `${origin}?pane=${encodeURIComponent(panes.web)}${SERVER}`);
  await away.clock.runFor(6000);
  await away.locator(".conn-live").waitFor({ state: "attached" });
  if (phone) {
    await away.locator("#drawer-toggle").click();
    await away.clock.runFor(500);
  }
  const moved = away.locator(`.agents-sidebar .agent-item[data-pane="${panes.api}"]`);
  const becomes = async (status: "working" | "blocked" | "done" | "idle", pane: string = panes.api): Promise<void> => {
    await away.evaluate(([id, next]) => (window as unknown as { __herdrDemoOrder: { status(pane: string, status: string): void } }).__herdrDemoOrder.status(id!, next!), [pane, status]);
    await away.clock.runFor(200);
    await away.waitForFunction(([id, group]) => {
      const item = document.querySelector(`.agents-sidebar .agent-item[data-pane="${id}"]`);
      for (let above = item?.previousElementSibling ?? null; above; above = above.previousElementSibling) if (above.classList.contains("agent-group-label")) return above.getAttribute("data-group") === group;
      return false;
    }, [pane, status]);
  };
  // another agent already rests under Done, so the row lands below a heading that stays: React takes the row's own
  // element out and puts it back there, where a row alone under a new heading would be left in place with its focus
  await becomes("done", panes.cli);
  const focusNow = (): Promise<string> => away.evaluate(() => {
    const active = document.activeElement;
    return active === null || active === document.body ? "the page" : `${active.tagName.toLowerCase()}.${active.className.split(" ").join(".")} in ${active.closest("li")?.getAttribute("data-group") ?? active.closest("li")?.getAttribute("data-pane") ?? "no row"}`;
  });
  const elsewhere = away.locator(".sidebar-footer button").first();
  assert.equal(await elsewhere.evaluate((node, pane) => document.querySelector(`.agents-sidebar .agent-item[data-pane="${pane}"]`)?.closest("section")?.contains(node) ?? true, panes.api), false, `${tag}: the control the reader moves to is outside the Agents list`);
  for (const control of ["agent-select", "row-menu-toggle"] as const) {
    await becomes("working");
    await moved.locator(".agent-select").focus();
    if (control === "row-menu-toggle") await away.keyboard.press("Tab");
    assert.equal(await moved.evaluate((item, name) => item.querySelector(`.${name}`) === document.activeElement, control), true, `${tag}: the row's ${control} holds the keyboard's focus: ${await focusNow()}`);
    await becomes("done");
    assert.equal(await moved.isVisible(), true, `${tag}: a finished agent stays in sight under the open Done group`);
    await elsewhere.focus();
    await becomes("idle");
    await moved.waitFor({ state: "hidden" });
    assert.equal(await elsewhere.evaluate((node) => node === document.activeElement), true, `${tag}: a row that goes under a folded group takes no focus from where the reader put it after its ${control} lost it: the focus is on ${await focusNow()}`);
  }

  const timeOf = (pane: string): Promise<string[]> => away.locator(`.agents-sidebar .agent-item[data-pane="${pane}"] .agent-since`).allTextContents();
  await becomes("working");
  assert.deepEqual(await timeOf(panes.api), ["<1m"], `${tag}: a change the page sees as it happens is dated`);
  assert.deepEqual(await timeOf(panes.web), ["2h"], `${tag}: the waiting agent's time before the sleep`);
  await away.clock.setSystemTime(await away.evaluate((slept) => Date.now() + slept, HOUR));
  await becomes("blocked");
  assert.deepEqual(await timeOf(panes.api), [], `${tag}: a wait that began while the device slept says no time`);
  // past the roster's slowest read, so the page has one from after the sleep
  await away.clock.runFor(35_000);
  assert.deepEqual(await timeOf(panes.api), [], `${tag}: nor does it once the page has read its roster again`);
  assert.deepEqual(await timeOf(panes.web), ["3h"], `${tag}: a time herdr's counter proves stands through the sleep`);
  await becomes("working");
  assert.deepEqual(await timeOf(panes.api), ["<1m"], `${tag}: from then on a change is dated as it is seen`);
  await away.close();

  assert.deepEqual(errors, [], `${tag}: no page errors`);
  await context.close();
  console.log(`PASS agent state groups ${tag}`);
}

async function main(): Promise<void> {
  const app = mkdtempSync(join(tmpdir(), "ovis-agent-state-groups-demo-"));
  try {
    await buildDemoApp(app);
    const index = join(app, "index.html");
    writeFileSync(index, readFileSync(index, "utf8").replace(/<script type="module"/, () => `<script src="./demo-transport.js"></script>\n    <script type="module"`));
    const server = serveDemo(app, { prefix: "/" });
    try {
      if (EVIDENCE) mkdirSync(EVIDENCE, { recursive: true });
      const browser = await chromium.launch({ executablePath: chromePath(), headless: true, args: ["--no-sandbox"] });
      try {
        for (const [width, theme] of [[390, "light"], [390, "dark"], [1280, "light"], [1280, "dark"]] as const) await run(browser, `http://127.0.0.1:${server.port}/`, width, theme);
      } finally { await browser.close(); }
    } finally { await server.stop(true); }
  } finally {
    rmSync(app, { recursive: true, force: true });
  }
}

await main();
