/**
 * A PC's details on the hosted relay app's dashboard, a sheet opened from them, then Escape twice: the first closes
 * the sheet, the second the details, and the details stay closed; Back then opens them again and Forward closes them.
 * On a phone the sheet holds a history entry and, closed by Escape, steps off it a moment later
 * (src/lib/sheetHistory.ts); the browser lands that step later still, on the entry it named when it was asked for.
 * The walk holds that step in the page: the sheet module's history.back() is kept until the second Escape has closed
 * the details (their panel gone), then the page goes onto the entry that call named, as the browser would have. The
 * step used to land on the details' address under the list's, and the dashboard followed it, opening the details
 * again; now the dashboard holds the list's address until the step lands and writes it then. A second walk opens Add a
 * PC and closes it between the two Escapes (#4221): on a phone its entry sits over the closed sheet's while the step is
 * held, and the step still lands on the details' entry; the dashboard used to take that landing for a traversal of
 * someone else's and drop the list's address. At 1440 on a PC no sheet holds an entry, and the same walks must end the
 * same. Each walk at each width, in an order fixed by events: no retries, no waits for time.
 *
 * The shell is the build in dist-shell/ (`bun run build:shell`; the browser lane builds it first), served as Cloudflare
 * Pages serves it on https://app.ovis.sh (routed here); the account service is the in-memory fake with a fixture
 * directory (scripts/relay-dashboard-fixtures.ts). No relay, PC or herdr takes part.
 *
 *   bun run build:shell && UI_EVIDENCE_DIR=<dir> bun scripts/sheet-history-late-step-regression.ts
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright-core";
import { FakeAccountService } from "../shared/account-service-fake.ts";
import { chromePath } from "./chrome-path.ts";
import { servePagesSite } from "./pages-static.ts";
import { directoryOf, fleetOf } from "./relay-dashboard-fixtures.ts";
import { closeMarked, whileOpen } from "./relay-qa-teardown.ts";
import { sheetsSettled } from "./sheets-settled.ts";

const APP = "https://app.ovis.sh";
const STEP_MS = 5_000;
const THROTTLE = 6;
const evidence = process.env["UI_EVIDENCE_DIR"] || null;
const shellDir = join(import.meta.dir, "..", "dist-shell");
if (!existsSync(join(shellDir, "index.html"))) throw new Error("dist-shell/ is missing: run `bun run build:shell` first");
if (evidence) mkdirSync(evidence, { recursive: true });

interface Qa { readonly order: string[]; gone: boolean; reopened: boolean; asked: (() => void) | null; release: (() => void) | null }
declare global { interface Window { lateStepQa: Qa } }

/**
 * From before the page's own scripts: what the page heard, in order (Escapes, the sheets' steps back, popstates,
 * hashchanges), whether a PC's details came back after they went, and the step back asked for while `asked` is
 * set, held until `release`.
 */
const recorder = (): void => {
  const qa: Qa = { order: [], gone: false, reopened: false, asked: null, release: null };
  window.lateStepQa = qa;
  const navigation = (window as unknown as { navigation: { currentEntry: { index: number }; entries(): Array<{ key: string }>; traverseTo(key: string): unknown } }).navigation;
  const back = history.back.bind(history);
  history.back = () => {
    qa.order.push("back");
    // held only while the walk waits on it (the closed sheet's step): any other goes as it would
    if (qa.asked === null) { back(); return; }
    // the entry this step back names now, gone onto once released: a browser that runs the traversal later does so
    const named = navigation.entries()[navigation.currentEntry.index - 1];
    qa.release = () => { qa.release = null; if (named) navigation.traverseTo(named.key); };
    const asked = qa.asked;
    qa.asked = null;
    asked();
  };
  window.addEventListener("keydown", (event) => { if (event.key === "Escape") qa.order.push("escape"); }, true);
  window.addEventListener("popstate", () => qa.order.push("popstate"));
  window.addEventListener("hashchange", () => qa.order.push("hashchange"));
  new MutationObserver(() => {
    const shown = document.querySelector("[data-pc-details]") !== null;
    if (!shown) qa.gone = true; else if (qa.gone) qa.reopened = true;
  }).observe(document, { childList: true, subtree: true });
};

async function open(browser: Browser, origin: string, width: 390 | 1440) {
  const phone = width === 390;
  const context = await browser.newContext({ viewport: { width, height: phone ? 844 : 900 }, deviceScaleFactor: phone ? 2 : 1, isMobile: phone, hasTouch: phone, locale: "en-US", serviceWorkers: "block" });
  const errors: string[] = [];
  const fake = new FakeAccountService();
  const fleet = fleetOf("F4");
  await context.route(/.*/, async (route) => { errors.push(`unexpected request ${route.request().url()}`); await route.abort(); });
  await context.route(/^https:\/\/app\.ovis\.sh\//, whileOpen(context, async (route) => {
    const url = new URL(route.request().url());
    await route.fulfill({ response: await route.fetch({ url: `${origin}${url.pathname}${url.search}` }) });
  }));
  await context.route(/^https:\/\/account\.ovis\.sh\//, whileOpen(context, async (route) => {
    const request = route.request();
    const cors = { "access-control-allow-origin": APP, "access-control-allow-headers": "authorization, content-type", "access-control-allow-methods": "GET, POST, PUT, DELETE" };
    if (request.method() === "OPTIONS") { await route.fulfill({ status: 204, headers: cors }); return; }
    if (request.method() === "GET" && new URL(request.url()).pathname === "/v1/pcs" && request.headers()["authorization"] !== undefined) {
      await route.fulfill({ status: 200, headers: cors, contentType: "application/json", body: JSON.stringify({ pcs: directoryOf(fleet, Date.now()) }) });
      return;
    }
    const body = request.postDataBuffer();
    const answer = await fake.fetch(new Request(request.url(), { method: request.method(), headers: request.headers(), ...(body === null ? {} : { body: new Uint8Array(body) }) }));
    const location = answer.headers.get("location");
    // the sign-in's way back is a new navigation, which the app.ovis.sh route serves
    if (answer.status === 302 && location !== null && location.startsWith(`${APP}/`)) {
      await route.fulfill({ status: 200, contentType: "text/html", body: `<!doctype html><meta http-equiv="refresh" content="0;url=${location.replaceAll("&", "&amp;").replaceAll('"', "&quot;")}">` });
      return;
    }
    await route.fulfill({ status: answer.status, headers: { ...Object.fromEntries(answer.headers), ...cors }, body: Buffer.from(await answer.arrayBuffer()) });
  }));
  await context.routeWebSocket(/.*/, (ws) => ws.close());
  await context.addInitScript(() => localStorage.setItem("ovis:settings", JSON.stringify({ language: "en", theme: "dark" })));
  await context.addInitScript(recorder);
  const page = await context.newPage();
  page.setDefaultTimeout(20_000);
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
  // preconditions: signed in, the PCs listed
  await page.goto(`${APP}/`);
  await page.locator(".account-provider").first().click();
  // a sign-in lands on Add a PC, never the dashboard: that opens only by its own address
  await page.locator('main.relay-add-screen[data-account-state="signed-in"] .relay-add, [data-add-pc-mode]').first().waitFor({ timeout: 45_000 });
  await page.goto(`${APP}/#overview`);
  await page.locator('.relay-dash[data-dashboard-mode="account"]').waitFor({ timeout: 45_000 });
  await page.evaluate(() => { location.hash = "#pcs"; });
  await page.locator('.relay-dash[data-dashboard-view="pcs"] .relay-pc-name-btn').first().waitFor();
  return { context, page, errors };
}

const shot = async (page: Page, name: string): Promise<void> => {
  if (evidence) await page.screenshot({ path: join(evidence, `late-step-${name}.png`) });
};
const bounded = <T>(work: Promise<T>, what: string): Promise<T> =>
  Promise.race([work, new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`no ${what} within ${STEP_MS} ms`)), STEP_MS))]);
const expect = (holds: boolean, what: string): void => { if (!holds) throw new Error(what); };
/** two frames: whatever the last event set has been drawn */
const drawn = (page: Page): Promise<void> => page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));

/**
 * The walk at one width: details, the sheet from them, Escape, (with `addPc`: Add a PC opened, then Escape), Escape
 * (the first sheet's step held on a phone), then Back and Forward.
 */
async function walk(page: Page, width: 390 | 1440, addPc: boolean): Promise<string> {
  const tag = `${addPc ? "add-pc-" : ""}${width}`;
  await page.locator(".relay-pc-name-btn").first().click();
  await page.locator("[data-pc-details]").waitFor();
  const detailsHash = await page.evaluate(() => location.hash);
  await page.locator(".relay-pc-details-actions .btn").first().click();
  await page.locator("[data-add-pc-phase]").waitFor();
  await sheetsSettled(page);
  await shot(page, `${tag}-sheet`);
  // what the page heard is counted from here, with the details up under the sheet; and the sheet's step back is
  // subscribed to before the Escape is sent, as the page handles the two in this order
  await page.evaluate(() => { const qa = window.lateStepQa; qa.order.length = 0; qa.gone = false; qa.reopened = false; });
  const asked = width === 390 ? page.evaluate(() => new Promise<void>((resolve) => { window.lateStepQa.asked = resolve; })) : null;
  await page.keyboard.press("Escape");
  if (asked) await bounded(asked, "step back of the closed sheet");
  else await page.locator("[data-add-pc-phase]").waitFor({ state: "detached" });
  expect(await page.locator("[data-pc-details]").count() === 1, "the first Escape closed more than the sheet");
  if (addPc) {
    // Add a PC opens over the details while the first sheet's step is held: on a phone its entry is made over the
    // closed sheet's, which that step leaves; its Escape closes it alone
    const before = await page.evaluate(() => history.length);
    await page.locator('[data-action="add-pc"]').filter({ visible: true }).first().click();
    await page.locator(".add-pc-sheet").waitFor();
    if (width === 390) await page.waitForFunction((length) => history.length > length, before);
    await page.keyboard.press("Escape");
    await page.locator(".add-pc-sheet").waitFor({ state: "detached" });
    expect(await page.locator("[data-pc-details]").count() === 1, "the Escape on Add a PC closed more than Add a PC");
  }
  await page.keyboard.press("Escape");
  // the second Escape handled: the details gone before the step lands
  await page.waitForFunction(() => document.querySelector("[data-pc-details]") === null);
  if (width === 390) {
    // the step lands now, on the details' entry: its popstate
    await bounded(page.evaluate(() => new Promise<void>((resolve) => {
      window.addEventListener("popstate", () => resolve(), { once: true });
      window.lateStepQa.release?.();
    })), "landing of the held step");
  }
  await page.waitForFunction(() => location.hash === "#pcs");
  await drawn(page);
  const seen = await page.evaluate(() => ({ order: window.lateStepQa.order.join(" "), reopened: window.lateStepQa.reopened, details: document.querySelector("[data-pc-details]") !== null, hash: location.hash }));
  if (evidence) writeFileSync(join(evidence, `late-step-${tag}.json`), `${JSON.stringify({ width, detailsHash, ...seen })}\n`);
  await shot(page, `${tag}-closed`);
  expect(!seen.reopened && !seen.details, `the details opened again after the second Escape (${JSON.stringify(seen)})`);
  expect(seen.hash === "#pcs", `the address is ${seen.hash}, not the list's #pcs`);
  const escapes = addPc ? "escape escape" : "escape";
  expect(seen.order === (width === 390 ? `escape back ${escapes} popstate` : `escape ${escapes}`), `the order was "${seen.order}"`);
  // Back: the details again, at their address; Forward: the list again
  await page.goBack();
  await page.waitForFunction((hash) => document.querySelector("[data-pc-details]") !== null && location.hash === hash, detailsHash);
  await shot(page, `${tag}-back`);
  await page.goForward();
  await page.waitForFunction(() => document.querySelector("[data-pc-details]") === null && location.hash === "#pcs");
  await drawn(page);
  await shot(page, `${tag}-forward`);
  return `${seen.order}; closed at #pcs, Back to ${detailsHash}, Forward to #pcs`;
}

const site = servePagesSite(shellDir, 0, "127.0.0.1");
const browser = await chromium.launch({ executablePath: chromePath(), headless: true, args: ["--no-sandbox"] });
const failed: string[] = [];
try {
  for (const [width, addPc] of [[390, false], [1440, false], [390, true], [1440, true]] as const) {
    const name = `late-step${addPc ? "-add-pc" : ""}-${width === 390 ? `390-cpu${THROTTLE}x` : "1440"}`;
    const started = Date.now();
    let opened: Awaited<ReturnType<typeof open>> | null = null;
    try {
      opened = await open(browser, `http://127.0.0.1:${site.port}`, width);
      const { context, page, errors } = opened;
      if (width === 390) await (await context.newCDPSession(page)).send("Emulation.setCPUThrottlingRate", { rate: THROTTLE });
      const measured = await walk(page, width, addPc);
      if (errors.length > 0) throw new Error(`the page heard ${JSON.stringify(errors.slice(0, 3))}`);
      console.log(`PASS ${name}: ${measured} (${Date.now() - started} ms)`);
    } catch (error) {
      failed.push(name);
      console.log(`FAIL ${name}: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`);
    } finally {
      if (opened) await closeMarked(opened.context);
    }
  }
} finally {
  await closeMarked(browser);
  await site.stop(true);
}
if (failed.length > 0) throw new Error(`sheet history late step: ${failed.length} failed: ${failed.join(", ")}`);
