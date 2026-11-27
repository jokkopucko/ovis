/**
 * Machine offline and Could not reach this machine, where they belong (measurement nc0, step S2: every PC off, the phone's
 * list still read "pc-a · Open · Ready"). Two real PCs the account heard from five minutes ago, so the account alone calls
 * both Ready, both paired on this device:
 *
 * - pc-a is stopped while the page is open. This device's own check of it then finds nobody at the relay: its row on Add
 *   a PC (the front page) is noted Off, and opening it ends on a screen headed Machine offline, with Try again.
 * - the relay goes out of this device's reach (every socket to it closes before the relay assigns it). Opening m1-box
 *   ends on a screen headed Could not reach this machine, with Try again; once the relay is back, Try again reaches m1-box.
 *
 * Every state is read by its markup (data-relay-state) and its words in the page's language. The front page's own check
 * of its PCs runs as it loads, so each load is awaited by the check's socket, not by time. Walked side by side at 390 px
 * (a phone profile) light and dark, 1280 px light and dark, and in Korean at 390 px light; pc-a is stopped once every
 * page has seen it listed.
 *
 * The shell is dist-shell/ (`bun run build:shell`), or the folder given as the first argument, served as Cloudflare Pages
 * serves it on https://app.ovis.sh (routed here); the account service is the in-memory fake with the directory answered
 * from this file; the relay is relay/bun.ts and the PCs are real createServers. A server finds herdr by its environment,
 * so this refuses to start outside `bun run check run`, which gives it a herdr of its own:
 *
 *   bun run build:shell && UI_EVIDENCE_DIR=<dir> bun run check run bun scripts/relay-offline-reasons-regression.ts [shell dir]
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright-core";
import { startBunRelay } from "../relay/bun.ts";
import { MAX_PENDING } from "../relay/core.ts";
import { liveSessionsRefused } from "../server/herdr/test-session.ts";
import { createServer } from "../server/index.ts";
import { RelayService } from "../server/relay/service.ts";
import { bounded } from "../server/relay/test-helpers.ts";
import { FakeAccountService } from "../shared/account-service-fake.ts";
import { importPublicKey } from "../shared/relay-e2ee.ts";
import { decodeOffer, type RelayOffer } from "../shared/relay-offer.ts";
import { translate, type Language } from "../src/lib/i18n.ts";
import { CHECK_GAP_MS } from "../src/lib/relay/pcSweep.ts";
import { chromePath } from "./chrome-path.ts";
import { loadPagesSite, pagesResponse, type PagesSite } from "./pages-static.ts";
import { relayBrowserSocket } from "./relay-browser-bridge.ts";
import { closeMarked, whileOpen } from "./relay-qa-teardown.ts";

const APP = "https://app.ovis.sh";
const RELAY = "wss://relay.test";
const LOAD_MS = 45_000;
/** every page's clock stands still here (timers still run; each front page load moves it a minute), and the account last heard from both PCs five minutes before */
const PAGE_NOW = Date.now();
const SEEN_AT = new Date(PAGE_NOW - 5 * 60_000).toISOString();
/** the shell gives a PC the relay has nobody for 15 s (PC_ANSWER_MS) before it calls it offline */
const OPEN_OFFLINE_MS = 40_000;
const evidence = process.env["UI_EVIDENCE_DIR"] || null;
const cleanup: (() => unknown)[] = [];
const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString("hex");

if (!liveSessionsRefused() || !process.env["HERDR_SOCKET"]) {
  console.error("relay-offline-reasons-regression: not started, as no isolated herdr is named here and its PCs would reach the one you work in. Run it as: bun run check run bun scripts/relay-offline-reasons-regression.ts [shell dir]");
  process.exit(2);
}

// ---- the relay, and two real PCs behind it ----
const relay = startBunRelay({ port: 0, limits: { perAddressPerMinute: 10_000, globalPerMinute: 10_000 } });
cleanup.push(() => relay.stop());
const relayUrl = (url: string): string => { const target = new URL(url); return `ws://127.0.0.1:${relay.port}${target.pathname}${target.search}`; };
async function startPc(): Promise<{ readonly offer: RelayOffer; readonly stop: () => Promise<void> }> {
  const stateDir = mkdtempSync(join(tmpdir(), "ovis-offline-reasons-pc-"));
  cleanup.push(() => rmSync(stateDir, { recursive: true, force: true }));
  const synced = Promise.withResolvers<void>();
  const service = new RelayService({ stateDir, relay: RELAY, connect: (url) => {
    const socket = new WebSocket(relayUrl(url));
    socket.addEventListener("message", (event) => { if (typeof event.data === "string" && event.data.includes('"sync"')) synced.resolve(); });
    return socket;
  } });
  cleanup.push(() => service.shutdown());
  const pc = createServer({ port: 0, hostname: "127.0.0.1", stateDir, token: "", tailscaleOwner: null, sidecar: false, registerBridge: false, relay: service });
  cleanup.push(() => pc.stop());
  const base = `http://127.0.0.1:${pc.port}`;
  const relayApi = (path: string) => fetch(`${base}/api/relay${path}`, { method: "POST", headers: { origin: base, "x-herdr-update": "1" } });
  assert.equal((await relayApi("/start")).status, 200, "the PC's relay starts");
  await bounded(synced.promise, 15_000);
  const offer = decodeOffer(((await (await relayApi("/offer")).json()) as { url: string }).url);
  if (!offer) throw new Error("the PC gave no offer");
  return { offer, stop: async () => { assert.equal((await relayApi("/stop")).status, 200, "the PC leaves the relay"); } };
}
const pcA = await startPc();
const m1 = await startPc();

interface Entry { readonly name: string; readonly server_id: string; readonly server_public_key: string; readonly public_key: string }
const entryOf = (name: string, offer: RelayOffer): Entry => ({ name, server_id: offer.server_id, server_public_key: offer.server_public_key, public_key: hex(importPublicKey(offer.server_public_key)) });
const a = entryOf("pc-a", pcA.offer);
const box = entryOf("m1-box", m1.offer);
const entries = [a, box];
// heard from five minutes ago by the page's fixed clock: the account alone calls both Ready, as it did for fifteen minutes in nc0's S2
const directory = () => entries.map((entry) => ({ server_id: entry.server_id, label: entry.name, public_key: entry.public_key, relay: RELAY,
  added_at: new Date(PAGE_NOW - 3_600_000).toISOString(), last_seen_at: SEEN_AT }));

/**
 * Pairings each PC confirmed a member of the signed-in account, as lib/relay/accountController.ts writes them. The key
 * is stored before the page leaves for the provider, so only the session (stored once the return page traded its code)
 * says the sign-in's navigations are over.
 */
async function seed(page: Page): Promise<void> {
  await page.waitForFunction(() => new Promise<boolean>((resolve) => {
    const request = indexedDB.open("ovis-account", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("account");
    request.onsuccess = () => {
      const store = request.result.transaction("account", "readonly").objectStore("account");
      const key = store.get("key");
      const session = store.get("session");
      session.onsuccess = () => { request.result.close(); resolve(key.result !== undefined && session.result !== undefined); };
    };
  }), null, { timeout: LOAD_MS });
  await page.evaluate(async ({ entries, relay }) => {
    const open = (name: string, version: number, upgrade: (db: IDBDatabase) => void) => new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(name, version);
      request.onupgradeneeded = () => upgrade(request.result);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const accountDb = await open("ovis-account", 1, (db) => db.createObjectStore("account"));
    const read = <T,>(name: string) => new Promise<T>((resolve) => {
      const request = accountDb.transaction("account", "readonly").objectStore("account").get(name);
      request.onsuccess = () => resolve(request.result);
    });
    const key = await read<{ private_key: CryptoKey; public_spki: string }>("key");
    const { account } = await read<{ account: string }>("session");
    accountDb.close();
    const db = await open("ovis-relay", 2, (d) => {
      for (const name of ["devices", "pending-push"]) if (!d.objectStoreNames.contains(name)) d.createObjectStore(name, { keyPath: "server_id" });
    });
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("devices", "readwrite");
      for (const entry of entries) tx.objectStore("devices").put({ server_id: entry.server_id, server_public_key: entry.server_public_key, relay, name: entry.name, label: "Chrome on Linux",
        device_id: entry.server_id.slice(0, 16), private_key: key.private_key, public_spki: key.public_spki, account });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  }, { entries, relay: RELAY });
}

interface Run { readonly width: 390 | 1280; readonly theme: "light" | "dark"; readonly language: Language }
const tagOf = (run: Run): string => `${run.width}-${run.theme}-${run.language}`;

/** Every page has seen pc-a answer (or given up): pc-a is stopped once, for all of them. */
const runs: Run[] = [
  { width: 390, theme: "light", language: "en" }, { width: 390, theme: "dark", language: "en" },
  { width: 1280, theme: "light", language: "en" }, { width: 1280, theme: "dark", language: "en" },
  { width: 390, theme: "light", language: "ko" },
];
let arrived = 0;
const allArrived = Promise.withResolvers<void>();
const arrive = (): void => { arrived += 1; if (arrived === runs.length) allArrived.resolve(); };
const stopped = allArrived.promise.then(() => pcA.stop());
/**
 * A connection to stopped pc-a waits at the relay for it, and the relay turns the oldest away past MAX_PENDING waiting
 * (relay/core.ts): the walks side by side wait in turn, so each check and Open meets the PC's absence, not that crowd.
 */
let waitingForA = 0;
const turns: (() => void)[] = [];
async function waitOnA<T>(act: () => Promise<T>): Promise<T> {
  if (waitingForA >= MAX_PENDING) await new Promise<void>((resolve) => { turns.push(resolve); });
  else waitingForA += 1;
  try { return await act(); } finally {
    const next = turns.shift();
    if (next) next(); else waitingForA -= 1;
  }
}

async function walk(browser: Browser, site: PagesSite, run: Run): Promise<string> {
  let hasArrived = false;
  const once = (): void => { if (!hasArrived) { hasArrived = true; arrive(); } };
  try { return await walkOne(browser, site, run, once); } finally { once(); }
}

async function walkOne(browser: Browser, site: PagesSite, run: Run, arriveHere: () => void): Promise<string> {
  const t = (key: string, vars?: Record<string, string>) => translate(run.language, key, vars);
  const phone = run.width < 600;
  const tag = tagOf(run);
  const context = await browser.newContext({ viewport: { width: run.width, height: phone ? 844 : 900 }, deviceScaleFactor: phone ? 3 : 1, isMobile: phone, hasTouch: phone,
    colorScheme: run.theme, locale: run.language === "ko" ? "ko-KR" : "en-US", serviceWorkers: "block" });
  cleanup.push(() => closeMarked(context));
  const fake = new FakeAccountService();
  await context.route(/^https:\/\/app\.ovis\.sh\//, whileOpen(context, async (route) => {
    const url = new URL(route.request().url());
    // answered in this process: route.fetch's pooled sockets to a local server can hang up mid-load and leave the page waiting
    let answer = await pagesResponse(site, new Request(url));
    // a redirect within the shell (`/s/<id>` to `/s/<id>/`) is followed here too, as route.fetch followed it: fulfilled as
    // a 3xx, the browser would follow it past this route to the real host
    for (let location = answer.headers.get("location"); answer.status >= 300 && answer.status < 400 && location?.startsWith("/"); location = answer.headers.get("location")) {
      answer = await pagesResponse(site, new Request(new URL(location, url)));
    }
    await route.fulfill({ status: answer.status, headers: Object.fromEntries(answer.headers), body: Buffer.from(await answer.arrayBuffer()) });
  }));
  await context.route(/^https:\/\/account\.ovis\.sh\//, async (route) => {
    const request = route.request();
    const cors = { "access-control-allow-origin": APP, "access-control-allow-headers": "authorization, content-type", "access-control-allow-methods": "GET, POST, PUT, DELETE" };
    if (request.method() === "OPTIONS") { await route.fulfill({ status: 204, headers: cors }); return; }
    if (request.method() === "GET" && new URL(request.url()).pathname === "/v1/pcs" && request.headers()["authorization"] !== undefined) {
      await route.fulfill({ status: 200, headers: cors, contentType: "application/json", body: JSON.stringify({ pcs: directory() }) });
      return;
    }
    const body = request.postDataBuffer();
    const answer = await fake.fetch(new Request(request.url(), { method: request.method(), headers: request.headers(), ...(body === null ? {} : { body: new Uint8Array(body) }) }));
    const location = answer.headers.get("location");
    if (answer.status === 302 && location !== null && location.startsWith(`${APP}/`)) {
      await route.fulfill({ status: 200, contentType: "text/html", body: `<!doctype html><meta http-equiv="refresh" content="0;url=${location.replaceAll("&", "&amp;").replaceAll('"', "&quot;")}">` });
      return;
    }
    await route.fulfill({ status: answer.status, headers: { ...Object.fromEntries(answer.headers), ...cors }, body: Buffer.from(await answer.arrayBuffer()) });
  });
  // the relay out of this device's reach: each new socket to it closes before the relay assigns it
  let relayReachable = true;
  /** a socket to the relay for this PC opened from now on: a check of it that began after this call */
  const sockets: { readonly id: string; readonly opened: () => void }[] = [];
  const nextSocket = (id: string): Promise<void> => new Promise((opened) => { sockets.push({ id, opened }); });
  await context.routeWebSocket(/^wss:\/\/relay\.test\//, (ws) => {
    const id = new URL(ws.url()).searchParams.get("server_id");
    for (const [index, waiting] of [...sockets.entries()].reverse()) if (waiting.id === id) { sockets.splice(index, 1); waiting.opened(); }
    if (relayReachable) { relayBrowserSocket(ws, () => relayUrl(ws.url())); return; }
    ws.close({ code: 1011, reason: "out of reach" });
  });
  await context.addInitScript(({ app, language, theme }) => {
    // about:blank, which each load of the front page passes through (toFront), has no storage to read
    if (location.origin === app && localStorage.getItem("ovis:settings") === null) localStorage.setItem("ovis:settings", JSON.stringify({ language, theme }));
  }, { app: APP, language: run.language, theme: run.theme });
  const page = await context.newPage();
  await page.clock.setFixedTime(PAGE_NOW);
  page.setDefaultTimeout(20_000);
  /** what the walk is doing, named in its failure with a picture of the page */
  let doing = "loading";
  const step = <T,>(name: string, act: () => Promise<T>): Promise<T> => { doing = name; return act(); };
  try { return await walkSteps(); } catch (error) {
    if (evidence) await page.screenshot({ path: join(evidence, `fail-${tag}.png`), fullPage: true }).catch(() => {});
    throw new Error(`${doing}: ${error instanceof Error ? error.message.split("\n").slice(0, 8).join(" | ") : String(error)}`);
  }
  async function walkSteps(): Promise<string> {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const shot = async (name: string, fullPage = false): Promise<void> => { if (evidence) await page.screenshot({ path: join(evidence, `${name}-${tag}.png`), fullPage }); };

  const link = (entry: Entry) => page.locator('main.relay-add-screen[data-account-state="signed-in"] a.relay-add-saved-pc').filter({ hasText: entry.name });
  /**
   * A fresh load of the front page, which reads the saved pairings again and checks each PC as it loads: once `entry`'s
   * check opened its socket. Always a navigation of its own, never a script in the page: a sign-in's return may still be
   * loading it, and goto wins over that. The tab's launch is past, so the front page stays My PCs. The front page
   * checks its PCs at most once a minute (pcSweep.ts CHECK_GAP_MS), so each load is a minute after the one before on
   * the page's standing clock. That minute is stamped in localStorage by whichever page of the tab checks first, so the
   * page before is unloaded before the clock moves: a late redraw of it, once it reads the seeded pairings, would otherwise
   * check at the new minute, take it from this load, and go away before its socket opened.
   */
  let pageNow = PAGE_NOW;
  const toFront = async (entry: Entry): Promise<void> => {
    pageNow += CHECK_GAP_MS;
    await page.goto("about:blank");
    await page.clock.setFixedTime(pageNow);
    const checked = nextSocket(entry.server_id);
    await page.goto(`${APP}/`);
    for (const each of entries) await link(each).waitFor({ timeout: LOAD_MS });
    await bounded(checked, 20_000);
  };
  /** Open from its row on the front page, as a person does: the shell's screen once the connection ended. */
  const openFromFront = async (entry: Entry, failure: string, timeout: number) => {
    await link(entry).click();
    const screen = page.locator(`main[data-relay-state="${failure}"]`);
    await screen.waitFor({ timeout });
    return { title: await screen.locator("h1").innerText(), retry: await screen.getByRole("button", { name: t("Try again"), exact: true }).count() };
  };
  const scroll = () => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

  // ---- precondition: signed in, both PCs saved and listed ----
  doing = "precondition: sign in";
  await page.goto(`${APP}/`);
  await page.locator(".account-provider").first().click({ timeout: LOAD_MS });
  // a sign-in lands on My PCs, or on the join an account PC its launch picked asks by itself (#16)
  await page.locator('main.relay-add-screen[data-account-state="signed-in"] [data-view="my-pcs"], [data-add-pc-mode], [data-approval-wait]').first().waitFor({ timeout: LOAD_MS });
  // the person goes to the front page (as Cancel or Back would): it stays My PCs, launching nothing (#16)
  await page.evaluate(() => sessionStorage.setItem("ovis-front-chosen", "1"));
  await page.goto(`${APP}/`);
  await page.locator('main.relay-add-screen[data-account-state="signed-in"] [data-view="my-pcs"]').waitFor({ timeout: LOAD_MS });
  await seed(page);
  await step("precondition: both rows", () => toFront(a));
  arriveHere();

  // ---- pc-a stopped while the page is open ----
  await stopped;
  const off = t("Off|pc state");
  await step("stopped pc-a: its row", () => waitOnA(async () => {
    await toFront(a);
    await link(a).locator(".relay-add-saved-note", { hasText: off }).waitFor({ timeout: LOAD_MS });
  }));
  const offlineNote = await link(a).locator(".relay-add-saved-note").innerText();
  await shot("offline-front");
  const offlineScroll = await scroll();
  const offlineOpen = await step("stopped pc-a: Open", () => waitOnA(() => openFromFront(a, "pc-offline", OPEN_OFFLINE_MS)));
  await shot("offline-open", true);

  // ---- the relay out of this device's reach ----
  relayReachable = false;
  await step("relay out of reach: rows", () => toFront(box));
  const unreachableScroll = await scroll();
  const unreachableOpen = await step("relay out of reach: Open", () => openFromFront(box, "relay-unreachable", LOAD_MS));
  await shot("unreachable-open", true);

  // ---- back in reach: Try again reaches m1-box ----
  // the pairings here are seeded, never admitted by the PC, so what follows is the PC's own answer, not the relay's
  relayReachable = true;
  const reached = await step("relay back: Try again", async () => {
    await page.getByRole("button", { name: t("Try again"), exact: true }).click();
    return page.waitForFunction(() => {
      if (document.querySelector(".app")) return "app";
      const state = document.querySelector("main[data-relay-state]")?.getAttribute("data-relay-state");
      return state && state !== "relay-unreachable" && state !== "connecting" ? state : null;
    }, null, { timeout: LOAD_MS }).then((handle) => handle.jsonValue());
  });
  doing = "asserting";
  await shot("back-reached");

  assert.equal(offlineNote, off, `${tag}: stopped pc-a's row on My PCs is noted Off`);
  assert.deepEqual(offlineOpen, { title: t("Machine offline"), retry: 1 }, `${tag}: Open anyway ends on Machine offline with Try again`);
  assert.deepEqual(unreachableOpen, { title: t("Could not reach this machine"), retry: 1 }, `${tag}: with the relay out of reach, Open ends on Could not reach this machine with Try again`);
  assert.ok(reached !== "pc-offline", `${tag}: once the relay is back, Try again reaches m1-box (${reached})`);
  assert.ok(offlineScroll <= 0 && unreachableScroll <= 0, `${tag}: the front page does not scroll sideways (${offlineScroll}, ${unreachableScroll} px)`);
  assert.deepEqual(errors, [], `${tag}: no page error`);
  await closeMarked(context);
  return `PASS ${tag}: stopped pc-a is noted Off on My PCs and Open ends on Machine offline with Try again; with the relay out of reach Open on m1-box ends on Could not reach this machine, and Try again reaches it once the relay is back (${reached})`;
  }
}

let code = 0;
const started = Date.now();
const shellDir = process.argv[2] ?? join(import.meta.dir, "..", "dist-shell");
try {
  if (!existsSync(join(shellDir, "index.html"))) throw new Error(`${shellDir} holds no shell build: run \`bun run build:shell\` first`);
  if (evidence) mkdirSync(evidence, { recursive: true });
  const site = loadPagesSite(shellDir);
  const browser = await chromium.launch({ executablePath: chromePath(), headless: true, args: ["--no-sandbox"] });
  cleanup.push(() => closeMarked(browser));
  const results = await Promise.allSettled(runs.map((run) => walk(browser, site, run)));
  for (const [index, result] of results.entries()) {
    if (result.status === "fulfilled") console.log(result.value);
    else {
      code = 1;
      const run = runs[index];
      console.log(`FAIL ${run ? tagOf(run) : index}: ${result.reason instanceof Error ? result.reason.message.split("\n")[0] : String(result.reason)}`);
    }
  }
} catch (error) {
  code = 1;
  console.error("FAIL relay offline reasons:", error);
} finally {
  for (const close of cleanup.reverse()) {
    try { await close(); } catch { /* the run's own result stands */ }
  }
}
console.log(`relay-offline-reasons-regression: ${Math.round((Date.now() - started) / 1000)} s`);
process.exit(code);
