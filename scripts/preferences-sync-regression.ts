/**
 * Real browser preferences sync against an isolated server. Storage events and request gates
 * observe completion; the browser clock advances send windows without fixed sleeps.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type BrowserContext, type Page, type Response } from "playwright-core";
import { chromePath } from "./chrome-path.ts";
// machine events stay on SSE here: these checks hold or watch /api/machines/events (the socket transport has its own checks)
process.env["OVIS_MACHINE_EVENTS_WS"] = "0";

await import("./test-herdr.ts");
const { createServer } = await import("../server/index.ts");
const { UsageService } = await import("../server/usage.ts");
const { workspaceClose, workspaceCreate } = await import("../server/herdr/client.ts");
const root = mkdtempSync(join(tmpdir(), "herdr-preferences-sync-"));
const serve = (port: number) => createServer({ port, hostname: "127.0.0.1", token: "", stateDir: join(root, "state"), usage: new UsageService(undefined, []) });
let server = serve(0);
const origin = `http://127.0.0.1:${server.port}`;

interface Opened { context: BrowserContext; page: Page; puts: { settings: Record<string, unknown>; pins?: string[] }[] }
const mainKey = "ovis:settings";
const qaDir = process.env["PREFERENCES_QA_DIR"];
if (qaDir) mkdirSync(qaDir, { recursive: true });

async function browserAt(browser: Awaited<ReturnType<typeof chromium.launch>>, own: Record<string, unknown> = {}, pins: string[] = [], before?: (context: BrowserContext) => Promise<void>): Promise<Opened> {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: "en-US" });
  await context.addInitScript(([own, pins]) => {
    if (!localStorage.getItem("ovis:settings")) localStorage.setItem("ovis:settings", JSON.stringify({ language: "en", theme: "dark", terminalFontSize: 13, ...own }));
    if (!localStorage.getItem("ovis:sidebar-agent-pins")) localStorage.setItem("ovis:sidebar-agent-pins", JSON.stringify(pins));
    const setItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      setItem.call(this, key, value);
      window.dispatchEvent(new Event("preferences-test-storage"));
    };
    // the app's own event stream reporting its loss, as the browser does when the server goes away
    const NativeEventSource = window.EventSource;
    window.EventSource = class extends NativeEventSource {
      constructor(url: string | URL, init?: EventSourceInit) {
        super(url, init);
        if (!String(url).endsWith("/api/machines/events")) return;
        this.addEventListener("error", () => {
          window.dispatchEvent(new Event("preferences-test-stream-lost"));
          // a non-200 answer to its reconnect: the browser never reconnects this one
          if (this.readyState === 2) window.dispatchEvent(new Event("preferences-test-stream-closed"));
        });
      }
    };
  }, [own, pins] as const);
  await before?.(context);
  const puts: Opened["puts"] = [];
  const page = await context.newPage();
  await page.clock.install();
  page.on("request", (request) => { if (request.method() === "PUT" && request.url().endsWith("/api/preferences")) puts.push(request.postDataJSON()); });
  await page.goto(origin);
  await page.locator(".conn-live").waitFor({ state: "attached" });
  return { context, page, puts };
}

/** Subscribe to exactly the storage state the action must produce, with an initial-state check. */
function storageHolds(page: Page, key: string, expected: Record<string, unknown> | string[]): Promise<void> {
  return page.evaluate(({ key, expected }) => {
    // Keep the observed promise rooted while Chromium's virtual clock is paused.
    const waits: Set<Promise<void>> = Reflect.get(window, "__preferencesTestWaits") ?? new Set();
    Reflect.set(window, "__preferencesTestWaits", waits);
    const waiting = new Promise<void>((resolve, reject) => {
      const matches = () => {
        const value = JSON.parse(localStorage.getItem(key) ?? "null");
        return Array.isArray(expected) ? JSON.stringify(value) === JSON.stringify(expected)
          : value !== null && Object.entries(expected).every(([name, wanted]) => JSON.stringify(value[name]) === JSON.stringify(wanted));
      };
      const timer = setTimeout(() => { window.removeEventListener("preferences-test-storage", changed); reject(new Error(`storage never held ${JSON.stringify(expected)}`)); }, 10_000);
      function changed() {
        if (!matches()) return;
        clearTimeout(timer);
        window.removeEventListener("preferences-test-storage", changed);
        resolve();
      }
      window.addEventListener("preferences-test-storage", changed);
      changed();
    });
    waits.add(waiting);
    return waiting.finally(() => { waits.delete(waiting); });
  }, { key, expected });
}
const settingsHold = (page: Page, expected: Record<string, unknown>) => storageHolds(page, mainKey, expected);
const held = async () => await (await fetch(`${origin}/api/preferences`)).json() as { revision: number; settings: Record<string, unknown>; pins?: string[] };
const write = async (settings: Record<string, unknown>, pins?: string[]) => {
  const response = await fetch(`${origin}/api/preferences`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ settings, ...(pins ? { pins } : {}) }) });
  assert.equal(response.status, 200);
};
async function windows(opened: readonly Opened[], count = 3): Promise<void> {
  for (let index = 0; index < count; index++) for (const { page } of opened) await page.clock.runFor(600);
}
const isPut = (response: Response) => response.url().endsWith("/api/preferences") && response.request().method() === "PUT";
/** The next PUT's answer: the virtual clock steps a second at a time until one is sent (a send window, or a RETRY_MS wait). */
async function nextPut(opened: Opened): Promise<Response> {
  const answered = opened.page.waitForResponse(isPut);
  let got = false;
  void answered.then(() => { got = true; }, () => {});
  for (let second = 0; second < 12 && !got; second++) await opened.page.clock.runFor(1_000);
  return await answered;
}
/** how long each real reopen took, from the restart until every page's EventSource had its answer */
const reopenMs: number[] = [];
/**
 * The event stream reopens for real: the server restarts on its port, and each page's EventSource
 * reconnects. The reconnect is the browser's own (its retry wait is real time, not the page clock),
 * which a loaded PC can stretch past Playwright's 30 s default, so the deadline is named here.
 */
async function restartServer(pages: readonly Page[]): Promise<void> {
  const reopened = pages.map((page) => page.waitForResponse((response) => response.url().endsWith("/api/machines/events"), { timeout: 120_000 }));
  const port = server.port;
  const started = Date.now();
  server.stop();
  server = serve(port);
  await Promise.all(reopened);
  reopenMs.push(Date.now() - started);
}
async function chooseMode(opened: Opened, mode: "Light" | "Dark"): Promise<void> {
  const answered = opened.page.waitForResponse((response) => response.url().endsWith("/api/preferences") && response.request().method() === "PUT");
  await opened.page.getByRole("group", { name: "Theme", exact: true }).getByRole("button", { name: mode, exact: true }).click();
  await opened.page.clock.runFor(600);
  assert.equal((await answered).status(), 200);
}

try {
  const browser = await chromium.launch({ executablePath: chromePath(), headless: true, args: ["--no-sandbox"] });
  try {
    // F3: these bytes are pinned to pre-change records, before the server holds any settings.
    for (const [index, [record, dark, light]] of ([
      [{ theme: "system", palette: "amber", paletteLight: "catppuccin", paletteDark: "charcoal" }, "charcoal", "catppuccin"],
      [{ theme: "dark", palette: "catppuccin", paletteDark: "charcoal" }, "catppuccin", "catppuccin"],
    ] as const).entries()) {
      const fixture = await browserAt(browser, record);
      await fixture.page.goto(`${origin}/?settings=appearance`);
      await fixture.page.locator(".settings-dialog").waitFor();
      await fixture.page.emulateMedia({ colorScheme: "dark" });
      await fixture.page.locator(`html[data-theme="dark"][data-palette="${dark}"]`).waitFor({ state: "attached" });
      if (qaDir) await fixture.page.screenshot({ path: join(qaDir, `f3-${index}-dark-desktop.png`) });
      if (record.theme === "system") {
        await fixture.page.emulateMedia({ colorScheme: "light" });
        await fixture.page.locator(`html[data-theme="light"][data-palette="${light}"]`).waitFor({ state: "attached" });
        if (qaDir) await fixture.page.screenshot({ path: join(qaDir, `f3-${index}-light-desktop.png`) });
      }
      await fixture.page.setViewportSize({ width: 390, height: 844 });
      await fixture.page.clock.runFor(600);
      if (qaDir) await fixture.page.screenshot({ path: join(qaDir, `f3-${index}-phone.png`) });
      console.log(`PASS F3 ${JSON.stringify(record)} -> dark ${dark} / light ${light}`);
      await fixture.context.close();
    }
    const anySide = await browserAt(browser, { theme: "light", lightTheme: "tokyo-night" });
    await anySide.page.goto(`${origin}/?settings=appearance`);
    await anySide.page.locator('html[data-theme="dark"][data-palette="tokyo-night"]').waitFor({ state: "attached" });
    assert.equal(await anySide.page.evaluate(() => document.documentElement.style.colorScheme), "dark");
    await anySide.page.locator(".settings-dialog").waitFor();
    if (qaDir) await anySide.page.screenshot({ path: join(qaDir, "any-side-desktop.png") });
    await anySide.page.setViewportSize({ width: 390, height: 844 });
    await anySide.page.clock.runFor(600);
    if (qaDir) await anySide.page.screenshot({ path: join(qaDir, "any-side-phone.png") });
    await anySide.context.close();
    console.log("PASS k Light mode with lightTheme=tokyo-night draws dark on desktop and phone");
    assert.equal((await held()).revision, 0);
    const a = await browserAt(browser, {}, ["local:w1:pa"]);
    const b = await browserAt(browser);
    console.log("QA empty server clients opened");
    await windows([a, b]);
    assert.deepEqual([...a.puts, ...b.puts], []);
    // a server that keeps the mute list always says it, empty while nothing is muted
    assert.deepEqual(await held(), { revision: 0, settings: {}, muted_panes: [] });

    await a.page.goto(`${origin}/?settings=appearance`);
    const bLight = settingsHold(b.page, { theme: "light" });
    await chooseMode(a, "Light");
    await bLight;
    console.log("QA mode change reached second client");
    assert.deepEqual(a.puts.map((body) => Object.keys(body.settings)), [["theme"]]);
    assert.deepEqual(a.puts[0]?.pins, ["local:w1:pa"]);
    await storageHolds(b.page, "ovis:sidebar-agent-pins", ["local:w1:pa"]);

    await a.page.goto(`${origin}/?settings=terminal`);
    await a.page.getByRole("button", { name: "Increase terminal font size", exact: true }).click();
    await settingsHold(a.page, { terminalFontSize: 14 });
    await windows([a, b]);
    assert.equal(a.puts.length, 1);
    await settingsHold(b.page, { terminalFontSize: 13 });
    const aPins = storageHolds(a.page, "ovis:sidebar-agent-pins", ["local:w9:p1"]);
    await write({}, ["local:w9:p1"]);
    await aPins;
    console.log("QA device settings and pins verified");

    // Hold the actual PUT, subscribe before sending, and let the other write land first.
    const onWay = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    await a.page.route("**/api/preferences", async (route) => {
      if (route.request().method() === "PUT") { onWay.resolve(); await release.promise; }
      await route.continue();
    });
    await a.page.goto(`${origin}/?settings=appearance`);
    const changed = chooseMode(a, "Dark");
    await onWay.promise;
    const aPalette = settingsHold(a.page, { lightTheme: "catppuccin", theme: "dark" });
    const bDark = settingsHold(b.page, { theme: "dark", lightTheme: "catppuccin" });
    await write({ palette: "catppuccin" });
    release.resolve();
    await changed;
    await Promise.all([aPalette, bDark]);
    console.log("QA concurrent changes settled");
    await windows([a, b]);
    assert.equal(a.puts.length, 2);
    assert.equal((await held()).settings.lightTheme, "catppuccin");
    await a.page.unrouteAll({ behavior: "wait" });

    const c = await browserAt(browser, { showThinking: false });
    await settingsHold(c.page, { theme: "dark", lightTheme: "catppuccin", terminalFontSize: 13, showThinking: false });
    const d = await browserAt(browser, {}, [], async (context) => {
      await context.route("**/api/preferences", async (route) => {
        if (route.request().method() === "GET") await route.abort();
        else await route.continue();
      });
    });
    await settingsHold(d.page, { lightTheme: "catppuccin" });

    // (i): a new-format change crosses two real browser clients through the event stream.
    const newChoice = settingsHold(b.page, { darkTheme: "tokyo-night", palette: "tokyo-night" });
    await write({ darkTheme: "tokyo-night" });
    await newChoice;
    const revision = (await held()).revision;
    await windows([a, b, c, d]);
    assert.equal((await held()).revision, revision, "receiving new sides never writes a corrected document");
    assert.deepEqual([...c.puts, ...d.puts], []);
    for (const opened of [a, b, c, d]) await opened.context.close();
    console.log("PASS shared settings and pins, device settings, gated concurrent writes, new theme sides, event-stream recovery and no correcting PUTs");

    // A save that keeps failing pauses after three, keeps what is edited meanwhile, and goes out
    // on Retry or when the event stream reopens; another client converges on the latest values.
    const pinnedWorkspace = (await workspaceCreate({ cwd: root, label: "ovis-test-preferences-pin" })).workspace.workspace_id;
    try {
      const refusal = { error: { code: "preferences_unwritable", message: "EACCES: permission denied, open '/state/preferences.json.tmp'" } };
      let failing = false;
      let hold: PromiseWithResolvers<void> | null = null;
      let onWay = Promise.withResolvers<void>();
      let sending = 0;
      let mostAtOnce = 0;
      const e = await browserAt(browser, {}, [], async (context) => {
        await context.route("**/api/preferences", async (route) => {
          if (route.request().method() !== "PUT") { await route.continue(); return; }
          if (hold !== null) { onWay.resolve(); await hold.promise; }
          if (failing) { await route.fulfill({ status: 500, json: refusal }); return; }
          await route.continue();
        });
      });
      e.page.on("request", (request) => { if (request.method() === "PUT" && request.url().endsWith("/api/preferences")) mostAtOnce = Math.max(mostAtOnce, ++sending); });
      for (const settled of ["requestfinished", "requestfailed"] as const) e.page.on(settled, (request) => { if (request.method() === "PUT" && request.url().endsWith("/api/preferences")) sending--; });
      const f = await browserAt(browser);
      await e.page.goto(`${origin}/?settings=appearance`);
      const alert = e.page.locator(".settings-save-error");
      const retry = alert.getByRole("button", { name: "Retry", exact: true });
      const mode = (name: "Light" | "Dark" | "System") => e.page.getByRole("group", { name: "Theme", exact: true }).getByRole("button", { name, exact: true }).click();
      await e.page.locator(".settings-dialog").waitFor();
      await e.page.clock.pauseAt(await e.page.evaluate(() => Date.now() + 1_000));
      const start = (await held()).revision;
      const statuses = async (count: number) => { const seen: number[] = []; for (let index = 0; index < count; index++) seen.push((await nextPut(e)).status()); return seen; };
      const quiet = async () => { for (let index = 0; index < 6; index++) await e.page.clock.runFor(5_600); };

      // persistent-save-refusal: three settled failures, then nothing for a minute (the paused wait)
      failing = true;
      await mode("Light");
      const firstRound = await statuses(3);
      assert.deepEqual(firstRound, [500, 500, 500]);
      await e.page.locator(".settings-save-error[data-paused]").waitFor();
      assert.match(await alert.innerText(), /Not saved on the server yet; reloading or closing this page can undo the change\./);
      assert.equal(await alert.count(), 1);
      await quiet();
      assert.equal(e.puts.length, 3, "a paused save sends nothing more within the minute");
      // an ordinary document from the event stream does not unpause it
      await Promise.all([settingsHold(e.page, { showThinking: false }), write({ showThinking: false })]);
      for (let index = 0; index < 2; index++) await e.page.clock.runFor(5_600);
      assert.equal(e.puts.length, 3, "an ordinary preferences event resumes nothing");

      // edits while paused: the theme and a pin change here, and still nothing is sent
      await mode("System");
      await e.page.keyboard.press("Escape");
      await e.page.locator(".settings-dialog").waitFor({ state: "detached" });
      await e.page.locator(`.workspace-group[data-workspace="${pinnedWorkspace}"] .workspace-select`).click({ button: "right" });
      await e.page.getByRole("menu").getByRole("menuitem", { name: "Pin workspace", exact: true }).click();
      const pins: string[] = await e.page.evaluate(() => JSON.parse(localStorage.getItem("ovis:sidebar-agent-pins") ?? "[]"));
      assert.ok(pins.includes(`local:workspace:${pinnedWorkspace}`));
      await e.page.locator(".sidebar-footer").getByRole("button", { name: "Settings", exact: true }).click();
      await e.page.getByRole("tab", { name: "Appearance" }).click();
      await e.page.clock.runFor(5_600);
      assert.equal(e.puts.length, 3, "edits while paused do not restart the failed loop");
      // the paused wait ends: the change goes once more on its own, edits made meanwhile with it, and
      // pauses again for twice as long when the server still refuses it (about 53 s of the minute have run)
      await e.page.clock.runFor(3_000);
      assert.equal(e.puts.length, 3);
      assert.equal((await nextPut(e)).status(), 500);
      assert.equal(e.puts[3]?.settings["theme"], "system");
      assert.deepEqual(e.puts[3]?.pins, pins);
      await e.page.locator(".settings-save-error[data-paused]").waitFor();
      // past the first wait (60 s), short of the doubled one (120 s)
      for (let index = 0; index < 11; index++) await e.page.clock.runFor(5_600);
      assert.equal(e.puts.length, 4, "a refused send after the wait waits twice as long");

      // retry-confirms-latest: Retry sends the latest intent; an edit made while it is on its way goes next
      failing = false;
      hold = Promise.withResolvers<void>();
      await retry.click();
      assert.equal(await retry.isDisabled(), true, "Retry is disabled while its save is on the way");
      await retry.dispatchEvent("click");
      await e.page.clock.runFor(600);
      await onWay.promise;
      const retried = e.puts[4];
      assert.equal(retried?.settings["theme"], "system");
      assert.deepEqual(retried?.pins, pins);
      await mode("Light");
      await e.page.clock.runFor(1_800);
      assert.equal(e.puts.length, 5, "a second Retry and a new edit start no parallel send");
      const firstAnswer = e.page.waitForResponse(isPut);
      hold.resolve();
      hold = null;
      assert.equal((await firstAnswer).status(), 200);
      assert.equal(await alert.count(), 1, "the status stays while the newer edit is unconfirmed");
      assert.equal((await nextPut(e)).status(), 200);
      assert.equal(e.puts[5]?.settings["theme"], "light", "the edit made during the Retry goes next");
      await alert.waitFor({ state: "detached" });
      await Promise.all([settingsHold(f.page, { theme: "light", showThinking: false }), storageHolds(f.page, "ovis:sidebar-agent-pins", pins)]);
      const confirmed = await held();
      assert.equal(confirmed.settings["theme"], "light");
      assert.deepEqual(confirmed.pins, pins);
      assert.equal(mostAtOnce, 1, "never two PUTs at once");
      const happy = { scenario: "retry-confirms-latest", failedBeforePause: firstRound, putsAfterPausedWait: 1, retriedBody: retried, followUpBody: e.puts[5], server: confirmed, secondClient: { theme: "light", pins }, mostPutsAtOnce: mostAtOnce, alertAfter: "cleared" };
      if (qaDir) writeFileSync(join(qaDir, "retry-confirms-latest.json"), JSON.stringify(happy, null, 2));
      console.log(`PASS retry-confirms-latest ${JSON.stringify(happy)}`);

      // persistent-save-refusal: a real reopen of the event stream, whose opening document carries an
      // unchanged revision, gives a paused save one new round; when the server can write again, it lands
      failing = true;
      await mode("Dark");
      const secondRound = await statuses(3);
      await e.page.locator(".settings-save-error[data-paused]").waitFor();
      await quiet();
      assert.equal(e.puts.length, 9);
      const revisionBefore = (await held()).revision;
      await restartServer([e.page, f.page]);
      assert.equal((await held()).revision, revisionBefore, "the reopened stream's document has the same revision");
      const reopenedRound = await statuses(3);
      await e.page.locator(".settings-save-error[data-paused]").waitFor();
      await quiet();
      assert.equal(e.puts.length, 12, "a reopen allows one new round of three");
      failing = false;
      await restartServer([e.page, f.page]);
      assert.equal((await nextPut(e)).status(), 200);
      await alert.waitFor({ state: "detached" });
      await settingsHold(f.page, { theme: "dark" });
      assert.equal((await held()).settings["theme"], "dark");
      assert.equal(mostAtOnce, 1);
      const failure = { scenario: "persistent-save-refusal", firstRound, putsAfterPause: 0, putsAfterPausedWait: 1, ordinaryEventResumed: false, secondRound, reopenedRound, unchangedRevisionOnReopen: revisionBefore, afterRecovery: { theme: "dark", puts: e.puts.length }, mostPutsAtOnce: mostAtOnce, revisionsWritten: (await held()).revision - start, reopenMs };
      if (qaDir) writeFileSync(join(qaDir, "persistent-save-refusal.json"), JSON.stringify(failure, null, 2));
      console.log(`PASS persistent-save-refusal ${JSON.stringify(failure)}`);

      // undone-while-refused: a change put back while its save is on the way, then refused, leaves
      // nothing unconfirmed: no alert, no Retry waiting on a send that never starts, no more PUTs
      const putsBefore = e.puts.length;
      onWay = Promise.withResolvers<void>();
      hold = Promise.withResolvers<void>();
      failing = true;
      await mode("Light");
      await e.page.clock.runFor(600);
      await onWay.promise;
      await mode("Dark");
      const refused = e.page.waitForResponse(isPut);
      hold.resolve();
      hold = null;
      assert.equal((await refused).status(), 500);
      await quiet();
      assert.equal(await alert.count(), 0, "a refused save of a change already undone leaves no alert");
      assert.equal(e.puts.length, putsBefore + 1, "nothing is sent for a change already undone");
      assert.equal((await held()).settings["theme"], "dark");
      failing = false;
      console.log(`PASS undone-while-refused ${JSON.stringify({ puts: e.puts.length - putsBefore, alert: 0, server: (await held()).settings["theme"] })}`);

      // disconnected-while-refused: after one settled refusal the server goes away; the browser's own
      // EventSource error cancels the wait, nothing is sent while the stream is down, and its real
      // reopening sends the latest change once, in one chain
      const putsAtStart = e.puts.length;
      failing = true;
      await mode("Light");
      assert.equal((await nextPut(e)).status(), 500);
      await alert.waitFor();
      /** the server goes away, until the page's own EventSource reports the loss; its port, to serve again */
      const loseStream = async (): Promise<number> => {
        await e.page.evaluate(() => {
          Reflect.set(window, "__preferencesStreamLost", new Promise<void>((resolve) => window.addEventListener("preferences-test-stream-lost", () => resolve(), { once: true })));
        });
        const port = server.port;
        server.stop();
        const deadline = Promise.withResolvers<never>();
        const lostTimer = setTimeout(() => deadline.reject(new Error("the event stream never reported its loss")), 120_000);
        try { await Promise.race([e.page.evaluate(() => Reflect.get(window, "__preferencesStreamLost") as Promise<void>), deadline.promise]); } finally { clearTimeout(lostTimer); }
        return port;
      };
      const port = await loseStream();
      const atDisconnect = e.puts.length;
      await quiet();
      assert.equal(e.puts.length, atDisconnect, "a lost event stream cancels the wait for the next save");
      assert.equal(atDisconnect, putsAtStart + 1);
      failing = false;
      const reopened = [e.page, f.page].map((page) => page.waitForResponse((response) => response.url().endsWith("/api/machines/events"), { timeout: 120_000 }));
      server = serve(port);
      await Promise.all(reopened);
      assert.equal((await nextPut(e)).status(), 200);
      await alert.waitFor({ state: "detached" });
      await settingsHold(f.page, { theme: "light" });
      await quiet();
      assert.equal(e.puts.length, atDisconnect + 1, "the reopened stream sends the change once");
      assert.equal((await held()).settings["theme"], "light");
      assert.equal(mostAtOnce, 1);
      const lost = { scenario: "disconnected-while-refused", putsBeforeDisconnect: atDisconnect - putsAtStart, putsWhileDisconnected: 0, putsAfterReopen: e.puts.length - atDisconnect, server: (await held()).settings["theme"], secondClient: "light", mostPutsAtOnce: mostAtOnce };
      if (qaDir) writeFileSync(join(qaDir, "disconnected-while-refused.json"), JSON.stringify(lost, null, 2));
      console.log(`PASS disconnected-while-refused ${JSON.stringify(lost)}`);

      // retry-during-automatic-send: Retry pressed while the automatic retry is on its way is used up
      // when that save confirms everything; an edit made once the stream is lost then waits for its reopening
      const putsFirst = e.puts.length;
      failing = true;
      await mode("Dark");
      assert.equal((await nextPut(e)).status(), 500);
      await alert.waitFor();
      failing = false;
      onWay = Promise.withResolvers<void>();
      hold = Promise.withResolvers<void>();
      await e.page.clock.runFor(5_600);
      await onWay.promise;
      assert.equal(e.puts.length, putsFirst + 2);
      await retry.click();
      const confirmedAnswer = e.page.waitForResponse(isPut);
      hold.resolve();
      hold = null;
      assert.equal((await confirmedAnswer).status(), 200);
      await alert.waitFor({ state: "detached" });
      const portAgain = await loseStream();
      const atLoss = e.puts.length;
      await mode("Light");
      await quiet();
      assert.equal(e.puts.length, atLoss, "a Retry already answered authorizes no later send while the stream is lost");
      const reopenedAgain = [e.page, f.page].map((page) => page.waitForResponse((response) => response.url().endsWith("/api/machines/events"), { timeout: 120_000 }));
      server = serve(portAgain);
      await Promise.all(reopenedAgain);
      assert.equal((await nextPut(e)).status(), 200);
      await settingsHold(f.page, { theme: "light" });
      await quiet();
      assert.equal(e.puts.length, atLoss + 1, "the reopened stream sends the edit once");
      assert.equal(mostAtOnce, 1);
      const used = { scenario: "retry-during-automatic-send", putsBeforeRetryAnswer: atLoss - putsFirst, putsWhileDisconnected: 0, putsAfterReopen: e.puts.length - atLoss, server: (await held()).settings["theme"], secondClient: "light", mostPutsAtOnce: mostAtOnce };
      if (qaDir) writeFileSync(join(qaDir, "retry-during-automatic-send.json"), JSON.stringify(used, null, 2));
      console.log(`PASS retry-during-automatic-send ${JSON.stringify(used)}`);

      // closed-stream: the server restarts behind a proxy, whose 502 answers the browser's reconnect, so
      // the browser closes the stream for good; a change made then still goes out, and the app opens a
      // new stream that brings other browsers' changes again
      let streamRefused = true;
      /** while set, the page's next stream request waits for it, and says it is asked */
      let streamHold: PromiseWithResolvers<void> | null = null;
      const streamAsked = Promise.withResolvers<void>();
      await e.context.route("**/api/machines/events", async (route) => {
        if (streamRefused) { await route.fulfill({ status: 502, body: "Bad Gateway" }); return; }
        if (streamHold !== null) { streamAsked.resolve(); await streamHold.promise; }
        await route.continue();
      });
      const isStream = (response: Response) => response.url().endsWith("/api/machines/events");
      const portClosed = await loseStream();
      await e.page.evaluate(() => {
        Reflect.set(window, "__preferencesStreamClosed", new Promise<void>((resolve) => window.addEventListener("preferences-test-stream-closed", () => resolve(), { once: true })));
      });
      const fBack = f.page.waitForResponse(isStream, { timeout: 120_000 });
      server = serve(portClosed);
      const closedDeadline = Promise.withResolvers<never>();
      const closedTimer = setTimeout(() => closedDeadline.reject(new Error("the browser never closed the refused stream")), 120_000);
      try { await Promise.race([e.page.evaluate(() => Reflect.get(window, "__preferencesStreamClosed") as Promise<void>), closedDeadline.promise]); } finally { clearTimeout(closedTimer); }
      await fBack;
      const atClose = e.puts.length;
      await mode("Dark");
      assert.equal((await nextPut(e)).status(), 200, "a stream the browser gave up on holds no change back");
      await settingsHold(f.page, { theme: "dark" });
      streamRefused = false;
      const reopenedStream = e.page.waitForResponse((response) => isStream(response) && response.status() === 200);
      let streamBack = false;
      void reopenedStream.then(() => { streamBack = true; }, () => {});
      for (let second = 0; second < 70 && !streamBack; second++) await e.page.clock.runFor(1_000);
      await reopenedStream;
      await Promise.all([settingsHold(e.page, { showThinking: true }), write({ showThinking: true })]);
      assert.equal(e.puts.length, atClose + 1);
      assert.equal(mostAtOnce, 1);
      const closedStream = { scenario: "closed-stream", putsAfterClose: e.puts.length - atClose, server: (await held()).settings["theme"], secondClient: "dark", newStreamReceives: true, mostPutsAtOnce: mostAtOnce };
      if (qaDir) writeFileSync(join(qaDir, "closed-stream.json"), JSON.stringify(closedStream, null, 2));
      console.log(`PASS closed-stream ${JSON.stringify(closedStream)}`);

      // reopened-gives-way: a refused change waits while the stream is lost; another browser saves the
      // same setting meanwhile, and the reopened stream's opening document comes before the resend, so
      // this page takes the newer value and sends nothing over it
      failing = true;
      await mode("Light");
      assert.equal((await nextPut(e)).status(), 500);
      await alert.waitFor();
      const atRefusal = e.puts.length;
      streamHold = Promise.withResolvers<void>();
      const fAgain = f.page.waitForResponse(isStream, { timeout: 120_000 });
      server = serve(await loseStream());
      await Promise.all([streamAsked.promise, fAgain]);
      failing = false;
      await write({ theme: "system" });
      await settingsHold(f.page, { theme: "system" });
      await quiet();
      assert.equal(e.puts.length, atRefusal, "nothing is sent while the stream is lost");
      // the page's clock stays still until the opening document is read, so the send wait has not begun
      const tookNewer = settingsHold(e.page, { theme: "system" });
      void tookNewer.catch(() => {});
      streamHold.resolve();
      streamHold = null;
      const newerDeadline = Promise.withResolvers<never>();
      const newerTimer = setTimeout(() => newerDeadline.reject(new Error("the reopened stream's newer value never replaced the refused change")), 60_000);
      try { await Promise.race([tookNewer, newerDeadline.promise]); } finally { clearTimeout(newerTimer); }
      await alert.waitFor({ state: "detached" });
      await quiet();
      assert.equal(e.puts.length, atRefusal, "the reopened stream resends nothing over the newer value");
      assert.equal((await held()).settings["theme"], "system");
      const gaveWay = { scenario: "reopened-gives-way", putsAfterReopen: e.puts.length - atRefusal, server: (await held()).settings["theme"], page: "system" };
      if (qaDir) writeFileSync(join(qaDir, "reopened-gives-way.json"), JSON.stringify(gaveWay, null, 2));
      console.log(`PASS reopened-gives-way ${JSON.stringify(gaveWay)}`);
      for (const opened of [e, f]) await opened.context.close();
    } finally {
      await workspaceClose(pinnedWorkspace).catch((error) => { if (error?.code !== "workspace_not_found") throw error; });
    }
  } finally { await browser.close(); }
} finally {
  server.stop();
  rmSync(root, { recursive: true, force: true });
}
