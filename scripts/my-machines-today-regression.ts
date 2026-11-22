/**
 * "My machines" on today's product, in the hosted shell (dist-shell/, from `bun run build:shell`): one machine running
 * the ordinary server on the isolated herdr test session, the repository's Bun relay (relay/bun.ts) between it and
 * the page, and the repository's fake account service (shared/account-service-fake.ts) answering the shell's
 * sign-in. The page's hosts (app.ovis.sh, account.ovis.sh, wss://relay.test) are Playwright routes to these local
 * services: no request leaves this PC, and any other host is refused.
 *
 *   bun run build:shell && UI_EVIDENCE_DIR=<dir> bun scripts/my-machines-today-regression.ts
 *
 * At 390 px (a phone profile) and 1440 px (a PC profile): a device paired with the machine and signed in finds it in
 * My machines with its state and route, and Open lands in its terminals; the machine stopped, once this device's check
 * finds no answer, reads "Could not reach this machine", why, and Try again; the relay out of the device's reach reads "Could not reach this machine" and why, and Try again works
 * once it is back; a second device not let in yet reads "Needs approval" and its Join opens today's way in; no
 * rendered string says a forbidden word (English, Korean, Japanese and Chinese at 1440, Korean at 390). Every item
 * is recorded as passed, failed with its error, or not run because a precondition (paired, signed in, the list
 * drawn) failed, in which case the run stops at once. With UI_EVIDENCE_DIR set, results.json and screenshots go
 * there. The run exits 1 when any item failed or did not run.
 */
import "./test-herdr.ts";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bytesToHex } from "@noble/hashes/utils.js";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import { startBunRelay } from "../relay/bun.ts";
import { createServer } from "../server/index.ts";
import { RelayService } from "../server/relay/service.ts";
import { FakeAccountService } from "../shared/account-service-fake.ts";
import { importPublicKey } from "../shared/relay-e2ee.ts";
import { decodeOffer, encodeOffer, type RelayOffer } from "../shared/relay-offer.ts";
import { chromePath } from "./chrome-path.ts";
import { servePagesSite } from "./pages-static.ts";

// These scenarios pin Step 1's direct pairing and Join-by-approval flow, not Step 2's fingerprint confirmation.
process.env["OVIS_ACCOUNT_OPENS_ALL"] = "0";

const started = Date.now();
const APP = "https://app.ovis.sh";
const RELAY = "wss://relay.test";
const NAME = "m1-box";
const FORBIDDEN = /controller|fleet|컨트롤러|플릿|함대/i;
const repo = join(import.meta.dir, "..");
const baseline = process.env["MY_MACHINES_BASELINE_SHELL"];
const shellDir = baseline ?? join(repo, "dist-shell");
if (!existsSync(join(shellDir, "index.html"))) throw new Error("dist-shell/ is missing: run `bun run build:shell` first");
const evidence = process.env["UI_EVIDENCE_DIR"] || null;
if (evidence) mkdirSync(evidence, { recursive: true });
const root = mkdtempSync(join(tmpdir(), "ovis-my-machines-today-"));
const cleanup: (() => unknown)[] = [() => rmSync(root, { recursive: true, force: true })];
type Result = { item: string; width: number; ok: boolean; notRun?: string; screenshot?: string; detail?: unknown; error?: string };
const results: Result[] = [];

let shown: Page | undefined;
const fileOf = (name: string, width: number): string => `${name.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}-${width}.png`;
async function shoot(file: string): Promise<string | undefined> {
  if (!evidence || !shown || shown.isClosed()) return undefined;
  await shown.screenshot({ path: join(evidence, file), animations: "disabled" }).catch(() => undefined);
  return file;
}

const site = servePagesSite(shellDir, 0, "127.0.0.1");
cleanup.push(() => site.stop(true));
const relay = startBunRelay({ port: 0, limits: { perAddressPerMinute: 10_000, globalPerMinute: 10_000 } });
cleanup.push(() => relay.stop());
const relayAddress = (url: string): string => { const target = new URL(url); return `ws://127.0.0.1:${relay.port}${target.pathname}${target.search}`; };
/** While true, this device's sockets to the relay fail at once: the relay is out of its reach. */
let relayBlocked = false;
/** Resolved at the next socket turned away while the relay is out of reach. */
const turnedAway: (() => void)[] = [];
const nextTurnedAway = (): Promise<void> => new Promise((resolve) => { turnedAway.push(resolve); });
/** What the pages said and which relay sockets they opened: printed when a precondition fails. */
const pageLog: string[] = [];

const stateDir = mkdtempSync(join(root, "machine-"));
let synced = Promise.withResolvers<void>();
const service = new RelayService({ stateDir, relay: RELAY, connect: (url) => {
  const socket = new WebSocket(relayAddress(url));
  socket.addEventListener("message", (event) => { if (typeof event.data === "string" && event.data.includes('"sync"')) synced.resolve(); });
  return socket;
} });
const machine = createServer({ port: 0, hostname: "127.0.0.1", stateDir, token: "", tailscaleOwner: null, relay: service });
cleanup.push(() => machine.stop());
const machineBase = `http://127.0.0.1:${machine.port}`;
const relayCall = (path: string) => fetch(`${machineBase}/api/relay${path}`, { method: "POST", headers: { origin: machineBase, "x-herdr-update": "1" } });
async function bounded<T>(promise: Promise<T>, what: string, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${what}: not within ${ms} ms`)), ms); })]); }
  finally { clearTimeout(timer); }
}
async function machineOn(): Promise<void> {
  synced = Promise.withResolvers<void>();
  assert.equal((await relayCall("/start")).status, 200, "the machine's relay starts");
  await bounded(synced.promise, "the machine synced with the relay", 15_000);
}
async function machineOff(): Promise<void> { assert.equal((await relayCall("/stop")).status, 200, "the machine's relay stops"); }
/** A new pairing offer, code included: a code admits one pairing, within ten minutes. */
async function freshOffer(): Promise<RelayOffer> {
  const response = await relayCall("/offer");
  assert.equal(response.status, 200, "the machine gives an offer");
  const offer = decodeOffer((await response.json() as { url: string }).url);
  assert.ok(offer?.code, "the offer carries a pairing code");
  return { ...offer, name: NAME };
}
await machineOn();
const identity = await freshOffer();
const addedAt = new Date().toISOString();
/** The account's directory as the account service lists it: the machine, its key and relay. */
const directory = () => ({ pcs: [{ server_id: identity.server_id, label: NAME, added_at: addedAt, last_seen_at: new Date().toISOString(),
  public_key: bytesToHex(importPublicKey(identity.server_public_key)), relay: RELAY }] });

async function device(browser: Browser, width: number, language: "en" | "ko" = "en"): Promise<{ context: BrowserContext; page: Page; errors: string[] }> {
  const phone = width === 390;
  const context = await browser.newContext({ viewport: { width, height: phone ? 844 : 900 }, isMobile: phone, hasTouch: phone, deviceScaleFactor: phone ? 3 : 1,
    colorScheme: "light", serviceWorkers: "block", locale: "en-US" });
  cleanup.push(() => context.close());
  const fake = new FakeAccountService();
  const errors: string[] = [];
  await context.route(/.*/, async (route) => { errors.push(`Unexpected host: ${new URL(route.request().url()).host}`); await route.abort(); });
  await context.routeWebSocket(/.*/, (ws) => { errors.push(`Unexpected WebSocket: ${new URL(ws.url()).host}`); ws.close(); });
  await context.route(/^https:\/\/app\.ovis\.sh\//, async (route) => {
    const url = new URL(route.request().url());
    await route.fulfill({ response: await route.fetch({ url: `http://127.0.0.1:${site.port}${url.pathname}${url.search}` }) });
  });
  await context.route(/^https:\/\/account\.ovis\.sh\//, async (route) => {
    const request = route.request();
    const cors = { "access-control-allow-origin": APP, "access-control-allow-headers": "authorization, content-type", "access-control-allow-methods": "GET, POST, PUT, DELETE" };
    if (request.method() === "OPTIONS") { await route.fulfill({ status: 204, headers: cors }); return; }
    if (new URL(request.url()).pathname === "/v1/pcs" && request.method() === "GET" && request.headers()["authorization"]) {
      await route.fulfill({ status: 200, headers: cors, contentType: "application/json", body: JSON.stringify(directory()) });
      return;
    }
    const body = request.postDataBuffer();
    const answer = await fake.fetch(new Request(request.url(), { method: request.method(), headers: request.headers(), ...(body === null ? {} : { body: new Uint8Array(body) }) }));
    const location = answer.headers.get("location");
    if (answer.status === 302 && location?.startsWith(APP)) {
      await route.fulfill({ status: 200, contentType: "text/html", body: `<!doctype html><meta http-equiv="refresh" content="0;url=${location.replaceAll("&", "&amp;").replaceAll('"', "&quot;")}">` });
      return;
    }
    await route.fulfill({ status: answer.status, headers: { ...Object.fromEntries(answer.headers), ...cors }, body: Buffer.from(await answer.arrayBuffer()) });
  });
  await context.routeWebSocket(/^wss:\/\/relay\.test\//, (ws) => {
    pageLog.push(`${width} WS ${relayBlocked ? "refused" : "open"} ${ws.url()}`);
    if (relayBlocked) {
      ws.close({ code: 1011, reason: "relay out of reach" });
      for (const resolve of turnedAway.splice(0)) resolve();
      return;
    }
    const socket = new WebSocket(relayAddress(ws.url()));
    socket.binaryType = "arraybuffer";
    const pending: (string | Uint8Array<ArrayBuffer>)[] = [];
    ws.onMessage((message) => {
      const frame = typeof message === "string" ? message : new Uint8Array(message);
      if (socket.readyState === WebSocket.OPEN) socket.send(frame);
      else if (socket.readyState === WebSocket.CONNECTING) pending.push(frame);
    });
    socket.addEventListener("open", () => { for (const frame of pending.splice(0)) socket.send(frame); });
    socket.addEventListener("message", ({ data }) => {
      if (typeof data === "string") ws.send(data);
      else if (data instanceof ArrayBuffer) ws.send(Buffer.from(data));
    });
    let browserClosed = false;
    ws.onClose(() => { browserClosed = true; socket.close(); });
    socket.addEventListener("close", ({ code, reason }) => {
      if (!browserClosed) ws.close({ code: [1005, 1006, 1015].includes(code) ? 1011 : code, reason });
    });
  });
  await context.addInitScript((language) => {
    if (window.location.origin !== "https://app.ovis.sh") return;
    if (localStorage.getItem("ovis:settings") === null) localStorage.setItem("ovis:settings", JSON.stringify({ language }));
  }, language);
  await context.clock.install();
  const page = await context.newPage();
  page.setDefaultTimeout(15_000);
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => pageLog.push(`${width} console.${message.type()} ${message.text()}`));
  page.on("framenavigated", (frame) => { if (frame === page.mainFrame()) pageLog.push(`${width} at ${frame.url()}`); });
  return { context, page, errors };
}

const row = (page: Page) => page.locator(`[data-row-id="${identity.server_id}"]`);
const inState = (page: Page, state: string) => row(page).and(page.locator(`[data-row-state="${state}"]`));
/** A real load of the front page at `hash`, as a reload or a link does: on the front page a hash change alone loads nothing. */
async function load(page: Page, hash: string): Promise<void> {
  if (new URL(page.url()).pathname !== "/") { await page.goto(`${APP}/${hash}`); return; }
  await page.evaluate((hash) => { window.location.hash = hash; }, hash);
  await page.reload();
}
/** Move past the sweep gap without running the old page's timers before navigating away. */
async function visitLater(page: Page): Promise<void> {
  await page.clock.setSystemTime(await page.evaluate(() => Date.now() + 61_000));
  await load(page, "#my-machines");
}
const relayOpens = (width: number): number => pageLog.filter((line) => line.startsWith(`${width} WS open`)).length;
/**
 * Signs in on the front page: a device with a saved pairing then opens that machine (a launch); one without goes to the
 * join card of the account's machine it is not in yet, or to Add a PC (never the dashboard).
 */
async function signIn(page: Page): Promise<void> {
  await page.goto(APP);
  await page.locator(".account-provider").first().click();
  // the dashboard only in baseline mode, which runs this against a shell from before the change, which landed there
  await page.locator(`.app, [data-add-pc-mode], main.relay-add-screen[data-account-state="signed-in"]${baseline === undefined ? "" : ', [data-dashboard-mode="account"]'}`).first().waitFor();
}
/** Every string a person can read on the page now: its text and its labels. */
const rendered = (page: Page): Promise<string> => page.evaluate(() => [document.body.innerText,
  ...[...document.querySelectorAll("[aria-label],[title],[placeholder],[alt]")].flatMap((element) => ["aria-label", "title", "placeholder", "alt"].map((name) => element.getAttribute(name) ?? ""))].join("\n"));
async function forbiddenWords(page: Page, language: string): Promise<string[]> {
  await page.evaluate((language) => localStorage.setItem("ovis:settings", JSON.stringify({ language, theme: "system" })), language);
  await load(page, "#my-machines");
  await row(page).waitFor();
  const texts = [await rendered(page)];
  await row(page).locator(".acct-name-btn").click();
  await page.locator(`[data-machine-details="${identity.server_id}"]`).waitFor();
  texts.push(await rendered(page));
  await page.evaluate(() => { window.location.hash = "#my-machines"; });
  await page.locator('[data-action="add-machine"]:visible').first().click();
  await page.locator('[data-add-step="terminal"]').waitFor();
  texts.push(await rendered(page));
  await page.keyboard.press("Escape");
  return texts.join("\n").split("\n").filter((line) => FORBIDDEN.test(line));
}

interface Step { readonly name: string; readonly precondition?: true; readonly run: () => Promise<unknown> }

function steps(browser: Browser, width: 390 | 1440): Step[] {
  let first: Awaited<ReturnType<typeof device>>;
  let second: Awaited<ReturnType<typeof device>>;
  const page = (): Page => first.page;
  const languages = width === 1440 ? ["en", "ko", "ja", "zh"] : ["ko"];
  return [
    { name: "paired with the machine by its offer and its code", precondition: true, run: async () => {
      first = await device(browser, width);
      shown = first.page;
      await page().goto(encodeOffer(await freshOffer(), APP));
      await page().locator('[data-relay-state="confirm"] .btn-primary').click();
      await page().locator(".app").waitFor();
    } },
    { name: "signed in: the sign-in's return opens the paired machine, with no link to My machines", precondition: true, run: async () => {
      await signIn(page());
      await page().locator(".app").waitFor();
      assert.equal(new URL(page().url()).pathname, `/s/${identity.server_id}/`, "the sign-in's return opened the paired machine");
      assert.equal(await page().locator('a[href*="my-machines"]').count(), 0, "the machine's page links to My machines");
    } },
    { name: "My machines lists the machine as ready, with its route", precondition: true, run: async () => {
      await visitLater(page());
      await inState(page(), "ready").waitFor();
      const text = await row(page()).innerText();
      assert.match(text, new RegExp(NAME));
      assert.match(text, /Ready/);
      assert.match(text, /Relay · \d+ ms/);
      return { text };
    } },
    { name: "a reload inside the gap shows Not checked without a probe, then checks when due", run: async () => {
      const opened = relayOpens(width);
      await load(page(), "#my-machines");
      await inState(page(), "unchecked").waitFor();
      assert.match(await row(page()).innerText(), /Not checked/);
      assert.equal(relayOpens(width), opened, "the reload opened a relay connection inside the sweep gap");
      // Public main keeps probe results only in the mounted shell, but the sweep gap survives reload.
      await page().clock.fastForward(61_000);
      await inState(page(), "ready").waitFor();
      assert.equal(relayOpens(width), opened + 1, "one new sweep ran when due");
    } },
    { name: "dark theme", run: async () => {
      await page().emulateMedia({ colorScheme: "dark" });
      await row(page()).waitFor();
    } },
    { name: "details: how it came in, and no deed today's product lacks", run: async () => {
      await page().emulateMedia({ colorScheme: "light" });
      await row(page()).locator(".acct-name-btn").click();
      const details = page().locator(`[data-machine-details="${identity.server_id}"]`);
      await details.waitFor();
      assert.equal(new URL(page().url()).hash, `#my-machines?machine=${identity.server_id}`);
      await page().reload();
      await details.waitFor();
      const text = await details.innerText();
      assert.match(text, /Listed in your account/);
      assert.equal(await details.locator('[data-action="remove-machine"]').count(), 0, "Remove from this account is offered");
      assert.equal(await page().locator('a[href*="my-machines/devices"], a[href*="my-machines/invites"]').count(), 0, "Devices or Invites is offered");
      return { text };
    } },
    { name: "Add a machine shows today's way: ovis add on the machine", run: async () => {
      await page().evaluate(() => { window.location.hash = "#my-machines"; });
      await page().locator('[data-action="add-machine"]:visible').first().click();
      const sheet = page().locator('[data-add-step="terminal"]');
      await sheet.waitFor();
      assert.equal(await sheet.locator("[data-add-command]").innerText(), "ovis add");
    } },
    { name: "Open lands in the machine's terminals", run: async () => {
      await page().keyboard.press("Escape");
      await row(page()).locator('[data-row-action="open"]').click();
      await page().locator(".app").waitFor();
      assert.ok(page().url().includes(`/s/${identity.server_id}/`), `landed on ${page().url()}`);
    } },
    { name: "the machine stopped: Could not reach this machine, why, and Try again", run: async () => {
      await machineOff();
      try {
        await visitLater(page());
        await inState(page(), "unreachable").waitFor();
        const text = await row(page()).innerText();
        assert.match(text, /Could not reach this machine/);
        assert.match(text, /It did not answer in time\. It may be busy or restarting\./);
        assert.equal(await row(page()).locator('[data-row-action="retry"]').count(), 1, "the row offers Try again");
        await shoot(fileOf("the machine stopped", width));
        return { text };
      } finally { await machineOn(); }
    } },
    { name: "the relay out of reach: Could not reach this machine, and why", run: async () => {
      relayBlocked = true;
      // a check that reached no relay says nothing yet: the row keeps what it said, and the next minute's check, which
      // takes that machine first, is believed (pcSweep.ts)
      const first = nextTurnedAway();
      await visitLater(page());
      await bounded(first, "the visit's check turned away", 15_000);
      const second = nextTurnedAway();
      await page().clock.fastForward(61_000);
      await bounded(second, "the next minute's check turned away", 15_000);
      await inState(page(), "unreachable").waitFor();
      const text = await row(page()).innerText();
      assert.match(text, /Could not reach this machine/);
      assert.match(text, /This device could not reach the relay\. Check this device's network\./);
      return { text };
    } },
    { name: "Try again works once the relay is back", run: async () => {
      relayBlocked = false;
      await row(page()).locator('[data-row-action="retry"]').click();
      await inState(page(), "ready").waitFor();
    } },
    ...languages.map((language): Step => ({ name: `no forbidden word, ${language}`, run: async () => {
      assert.deepEqual(await forbiddenWords(page(), language), []);
      await row(page()).waitFor();
    } })),
    { name: "a second device not let in yet: Needs approval, and Join opens today's way in", run: async () => {
      await page().evaluate(() => localStorage.setItem("ovis:settings", JSON.stringify({ language: "en" })));
      second = await device(browser, width);
      shown = second.page;
      await signIn(second.page);
      // a device the account has not let in yet opens no machine by itself: it lands on its join card or Add a PC
      assert.equal(await second.page.locator(".app").count(), 0, "the second device opened the machine without a press");
      await load(second.page, "#my-machines");
      await inState(second.page, "needs-approval").waitFor();
      const text = await row(second.page).innerText();
      assert.match(text, /Needs approval/);
      await shoot(fileOf("second device row", width));
      await row(second.page).locator('[data-row-action="join"]').click();
      await second.page.locator("[data-add-pc-mode]").waitFor();
      const mode = await second.page.locator("[data-add-pc-mode]").getAttribute("data-add-pc-mode");
      assert.equal(mode, "join", `Join opened the ${mode} sheet, not the way in for a machine already seen`);
      return { text, mode };
    } },
    { name: "no page error and no request to another host", run: async () => {
      assert.deepEqual([...first.errors, ...second.errors], []);
    } },
  ];
}

const browser = await chromium.launch({ executablePath: chromePath(), headless: true, args: ["--no-sandbox"] });
cleanup.push(() => browser.close());
try {
  if (baseline !== undefined) {
    assert.ok(evidence, "UI_EVIDENCE_DIR is required for baseline captures");
    for (const width of [390, 1280]) for (const language of ["en", "ko"] as const) {
      const { context, page, errors } = await device(browser, width, language);
      await signIn(page);
      await load(page, "#my-machines");
      await page.locator('[data-dashboard-mode="account"]').waitFor();
      await page.locator(`[data-dashboard-view="overview"] [data-pc-id="${identity.server_id}"]:visible`).first().waitFor();
      await page.evaluate(() => document.fonts.ready.then(() => undefined));
      assert.equal(new URL(page.url()).hash, "#my-machines");
      assert.deepEqual(errors, []);
      await page.screenshot({ path: join(evidence, `before-main-${language}-${width}-light.png`), animations: "disabled", scale: "css" });
      console.log(`PASS main baseline at /#my-machines (${language}, ${width} px)`);
      await context.close();
    }
  }
  const plan = (baseline === undefined ? [390, 1440] as const : []).map((width) => ({ width, steps: steps(browser, width) }));
  let stopped: string | null = null;
  for (const { width, steps: list } of plan) {
    for (const step of list) {
      if (stopped !== null) { results.push({ item: step.name, width, ok: false, notRun: stopped }); continue; }
      try {
        const detail = await step.run();
        const screenshot = await shoot(fileOf(step.name, width));
        results.push({ item: step.name, width, ok: true, ...(screenshot ? { screenshot } : {}), ...(detail === undefined ? {} : { detail }) });
        console.log(`PASS ${step.name} @${width}`);
      } catch (error) {
        const message = error instanceof Error ? error.message.split("\n").slice(0, 8).join("\n") : String(error);
        const screenshot = await shoot(`fail-${fileOf(step.name, width)}`);
        results.push({ item: step.name, width, ok: false, ...(screenshot ? { screenshot } : {}), error: message });
        console.log(`FAIL ${step.name} @${width}: ${message}`);
        if (step.precondition) {
          stopped = `${step.name} @${width} failed`;
          console.log(`page log:\n${pageLog.join("\n")}`);
        }
      }
    }
  }
} finally {
  shown = undefined;
  if (evidence && baseline === undefined) writeFileSync(join(evidence, "results.json"), JSON.stringify(results, null, 2));
  for (const step of cleanup.reverse()) await Promise.resolve().then(step).catch((error: unknown) => console.error("cleanup", error));
}
if (baseline !== undefined) process.exit(0);
const failed = results.filter((result) => !result.ok);
console.log(`${results.length - failed.length} passed, ${failed.filter((result) => result.notRun === undefined).length} failed, ${failed.filter((result) => result.notRun !== undefined).length} not run, ${((Date.now() - started) / 1000).toFixed(1)} s`);
process.exit(failed.length > 0 ? 1 : 0);
