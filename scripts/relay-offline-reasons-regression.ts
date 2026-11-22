/**
 * Machine offline and Could not reach this machine, where they belong (measurement nc0, step S2: every PC off, the phone's
 * list still read "pc-a · Open · Ready"). Two real PCs the account heard from a minute ago, so the account alone calls
 * both Ready:
 *
 * - pc-a is stopped while the page is open. This device's own check of it then finds nobody at the relay: its row, its
 *   details and the Needs you card say Machine offline, when the account last heard from it and why, and the row offers
 *   Details, not Open. Open anyway ends on a screen with the same heading and Try again.
 * - the relay goes out of this device's reach (every socket to it closes before the relay assigns it). m1-box's row, its
 *   details and the Needs you card then say Could not reach this machine and why, and the row offers Check again; Open
 *   ends on a screen with the same heading. Once the relay is back, the row's Check again finds m1-box Ready.
 *
 * Every state is read by its markup (data-pc-state, data-pc-action, data-relay-state) and its heading in the page's
 * language. Each check is one PC's own (Check now in its details, or the row's Check again), so no sweep's timing
 * decides a row. Walked side by side at 390 px (a phone profile) light and dark, 1280 px light and dark, and in Korean
 * at 390 px light; pc-a is stopped once every page has seen it answer.
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
import { chromePath } from "./chrome-path.ts";
import { loadPagesSite, pagesResponse, type PagesSite } from "./pages-static.ts";
import { relayBrowserSocket } from "./relay-browser-bridge.ts";
import { closeMarked, whileOpen } from "./relay-qa-teardown.ts";

const APP = "https://app.ovis.sh";
const RELAY = "wss://relay.test";
const LOAD_MS = 45_000;
/** every page's clock stands still here (timers still run), and the account last heard from both PCs five minutes before */
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
  await context.addInitScript(({ language, theme }) => {
    if (localStorage.getItem("ovis:settings") === null) localStorage.setItem("ovis:settings", JSON.stringify({ language, theme }));
  }, { language: run.language, theme: run.theme });
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

  /**
   * A fresh load of the PCs view, which reads the saved pairings again. Always a navigation of its own (a query, which boot.ts
   * moves into the fragment), never a script in the page: a sign-in's return may still be loading it, and goto wins over that.
   */
  const toPcs = async (): Promise<void> => {
    await page.goto(`${APP}/?pcs`);
    assert.equal(new URL(page.url()).hash, "#pcs", "the PCs view's address");
    await page.locator('.relay-dash[data-dashboard-view="pcs"]').waitFor({ timeout: LOAD_MS });
    for (const entry of entries) await page.locator(`[data-pc-id="${entry.server_id}"]:visible`).first().waitFor({ timeout: LOAD_MS });
  };
  /** Waits until the PC's row carries `state` with no check of it running, then reads it as drawn. */
  const rowIn = (entry: Entry, state: string) => page.waitForFunction(({ id, state }) => {
    const row = [...document.querySelectorAll<HTMLElement>(`[data-pc-id="${id}"]`)].find((element) => element.offsetParent !== null);
    if (!row || row.getAttribute("data-pc-state") !== state || row.querySelector('.status-dot[data-state="checking"]')) return null;
    const word = row.querySelector<HTMLElement>(".relay-pc-state-word");
    return { state, word: word?.textContent ?? null, title: word?.title ?? null, line: row.querySelector(".relay-pc-probe-line")?.textContent ?? null,
      action: row.querySelector("[data-pc-action]")?.getAttribute("data-pc-action") ?? null,
      whole: word === null || (word.scrollWidth <= word.clientWidth + 1 && word.scrollHeight <= word.clientHeight + 1) };
  }, { id: entry.server_id, state }).then((handle) => handle.jsonValue()).then((row) => { if (row === null) throw new Error(`no row of ${entry.name} in ${state}`); return row; });
  const details = (entry: Entry) => page.locator(`[data-pc-details="${entry.server_id}"]`);
  const openDetails = async (entry: Entry): Promise<void> => {
    await page.locator(`[data-pc-id="${entry.server_id}"]:visible .relay-pc-name-btn`).first().click();
    await details(entry).waitFor();
  };
  const closeDetails = async (entry: Entry): Promise<void> => {
    await page.keyboard.press("Escape");
    await details(entry).waitFor({ state: "detached" });
  };
  /** Checks this PC from its details and waits for a check of it that began after the press to finish. */
  const checkOnce = async (entry: Entry): Promise<void> => {
    const settled = () => page.waitForFunction((id) => document.querySelector(`[data-pc-details="${id}"] .relay-pc-details-location .status-dot[data-state="checking"]`) === null, entry.server_id);
    // a check of it already running (the list's minute) would take the press without a socket of its own
    await settled();
    const opened = nextSocket(entry.server_id);
    await details(entry).locator('[data-action="check-pc"]').click();
    await bounded(opened, 20_000);
    await settled();
  };
  /**
   * This PC's own check, from its details (no sweep's timing), until their glyph says `state` (relayPcState.tsx pcDotState;
   * below 1100 px the details stand in place of the list): what their State row then says. Only a check made here counts,
   * so a glyph already showing `state` before it proves nothing.
   */
  const checkFromDetails = async (entry: Entry, state: "paired" | "offline" | "unreachable") => {
    await openDetails(entry);
    const glyph = { paired: "ready", offline: "offline", unreachable: "failed" }[state];
    const dot = details(entry).locator(`.relay-pc-details-location .status-dot[data-state="${glyph}"]`);
    await checkOnce(entry);
    // a relay this device cannot reach is believed on the second such check in a row (pcSweep.ts)
    if (state === "unreachable" && await dot.count() === 0) await checkOnce(entry);
    // the list's own sweep may begin another check of it right after this one: its glyph is read once that one is done too
    const found = await page.waitForFunction((id) => {
      const state = document.querySelector(`[data-pc-details="${id}"] .relay-pc-details-location .status-dot`)?.getAttribute("data-state");
      return state === "checking" ? null : state ?? "none";
    }, entry.server_id).then((handle) => handle.jsonValue());
    assert.equal(found, glyph, `${entry.name}'s check found it ${state}`);
    const value = details(entry).locator(".relay-pc-details-row").first();
    return { state: await value.locator(".relay-pc-details-value").innerText(), why: await value.locator(".relay-pc-details-sub").allInnerTexts() };
  };
  const attentionOf = async (entry: Entry) => {
    await page.goto(`${APP}/#overview`);
    const item = page.locator("li.relay-overview-attention-row").filter({ has: page.locator(".relay-overview-attention-name", { hasText: entry.name }) });
    await item.waitFor({ timeout: LOAD_MS });
    // a reason every row on show shares is said once, above them (RelayOverview's caption)
    const caption = page.locator(".relay-overview-attention-caption");
    const why = await caption.count() > 0 ? await caption.innerText() : await item.locator(".relay-overview-attention-why").innerText();
    return { state: await item.getAttribute("data-pc-state"), why, action: await item.locator("[data-attention-action]").getAttribute("data-attention-action") };
  };
  /** Open from the PC's details, as a person does: the shell's screen once the connection ended. */
  const openFromDetails = async (entry: Entry, failure: string, timeout: number) => {
    await toPcs();
    await openDetails(entry);
    await details(entry).locator(`a.btn[href$="/s/${entry.server_id}/"]`).click();
    const screen = page.locator(`main[data-relay-state="${failure}"]`);
    await screen.waitFor({ timeout });
    return { title: await screen.locator("h1").innerText(), retry: await screen.getByRole("button", { name: t("Try again"), exact: true }).count() };
  };
  const scroll = () => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

  // ---- precondition: signed in, both PCs listed, pc-a answers this device ----
  doing = "precondition: sign in";
  await page.goto(`${APP}/`);
  await page.locator(".account-provider").first().click({ timeout: LOAD_MS });
  // a sign-in lands on Add a PC, never the dashboard: that opens only by its own address
  await page.locator('main.relay-add-screen[data-account-state="signed-in"] .relay-add, [data-add-pc-mode]').first().waitFor({ timeout: LOAD_MS });
  await page.goto(`${APP}/#overview`);
  await page.locator('.relay-dash[data-dashboard-mode="account"]').waitFor({ timeout: LOAD_MS });
  await seed(page);
  await step("precondition: both rows", toPcs);
  await step("precondition: pc-a answers its check", () => checkFromDetails(a, "paired"));
  await closeDetails(a);
  const before = await rowIn(a, "paired");
  assert.equal(before.action, "open", `${tag}: precondition, pc-a answers and opens`);
  arriveHere();

  // ---- pc-a stopped while the page is open ----
  await stopped;
  const cause = t("It is off, has no network, or Ovis is not running on it.");
  const offlineWhy = `${t("Last seen {when}.", { when: t("{n} min ago", { n: "5" }) })} ${cause}`;
  const offlineDetails = await step("stopped pc-a: its check", () => waitOnA(() => checkFromDetails(a, "offline")));
  await shot("offline-details");
  await closeDetails(a);
  const offlineRow = await rowIn(a, "offline");
  await shot("offline-row");
  const offlineScroll = await scroll();
  const offlineCard = await step("stopped pc-a: Needs you", () => attentionOf(a));
  await shot("offline-overview");
  const offlineOpen = await step("stopped pc-a: Open", () => waitOnA(() => openFromDetails(a, "pc-offline", OPEN_OFFLINE_MS)));
  await shot("offline-open", true);

  // ---- the relay out of this device's reach ----
  relayReachable = false;
  const unreachableWhy = t("This device could not reach the relay. Check this device's network.");
  await step("relay out of reach: rows", toPcs);
  const unreachableDetails = await step("relay out of reach: m1-box's check", () => checkFromDetails(box, "unreachable"));
  await shot("unreachable-details");
  await closeDetails(box);
  await checkFromDetails(a, "unreachable");
  await closeDetails(a);
  const unreachableRow = await rowIn(box, "unreachable");
  await shot("unreachable-row");
  const unreachableScroll = await scroll();
  const unreachableCard = await step("relay out of reach: Needs you", () => attentionOf(box));
  await shot("unreachable-overview");
  const unreachableOpen = await step("relay out of reach: Open", () => openFromDetails(box, "relay-unreachable", LOAD_MS));
  await shot("unreachable-open", true);

  // ---- back in reach: the row's Check again finds m1-box ----
  await toPcs();
  await checkFromDetails(box, "unreachable");
  await closeDetails(box);
  await rowIn(box, "unreachable");
  relayReachable = true;
  doing = "relay back: Check again";
  const checkedAgain = nextSocket(box.server_id);
  await page.locator(`[data-pc-id="${box.server_id}"]:visible [data-pc-action="check"]`).first().click();
  await bounded(checkedAgain, 20_000);
  const back = await rowIn(box, "paired");
  doing = "asserting";
  await shot("back-row");

  const stateWhy = (row: { title: string | null; line: string | null; word: string | null }): string | null => phone ? row.line : row.title?.slice(`${row.word} · `.length) ?? null;
  assert.deepEqual({ ...offlineRow, why: stateWhy(offlineRow) }, { ...offlineRow, word: t("Machine offline"), action: "details", whole: true, why: offlineWhy },
    `${tag}: stopped pc-a's row says Machine offline with when and why, and offers Details, not Open`);
  assert.deepEqual(offlineDetails, { state: t("Machine offline"), why: [offlineWhy] }, `${tag}: its details say the same`);
  assert.deepEqual(offlineCard, { state: "offline", why: `${t("Machine offline")} · ${offlineWhy}`, action: "details" }, `${tag}: the Needs you card says the same, with Details`);
  assert.deepEqual(offlineOpen, { title: t("Machine offline"), retry: 1 }, `${tag}: Open anyway ends on Machine offline with Try again`);
  assert.deepEqual({ ...unreachableRow, why: stateWhy(unreachableRow) }, { ...unreachableRow, word: t("Could not reach this machine"), action: "check", whole: true, why: unreachableWhy },
    `${tag}: with the relay out of reach, m1-box's row says Could not reach this machine and why, and offers Check again`);
  assert.deepEqual(unreachableDetails, { state: t("Could not reach this machine"), why: [unreachableWhy] }, `${tag}: its details say the same`);
  assert.deepEqual(unreachableCard, { state: "unreachable", why: `${t("Could not reach this machine")} · ${unreachableWhy}`, action: "check" }, `${tag}: the Needs you card says the same, with Check again`);
  assert.deepEqual(unreachableOpen, { title: t("Could not reach this machine"), retry: 1 }, `${tag}: Open ends on Could not reach this machine with Try again`);
  assert.equal(back.action, "open", `${tag}: once the relay is back, Check again finds m1-box Ready and it opens`);
  assert.ok(offlineScroll <= 0 && unreachableScroll <= 0, `${tag}: the list does not scroll sideways (${offlineScroll}, ${unreachableScroll} px)`);
  assert.deepEqual(errors, [], `${tag}: no page error`);
  await closeMarked(context);
  return `PASS ${tag}: stopped pc-a reads Machine offline with when and why in its row, details and the Needs you card, offers Details, and Open ends on Machine offline; with the relay out of reach m1-box reads Could not reach this machine there, offers Check again, Open ends on the same heading, and Check again finds it Ready once the relay is back`;
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
