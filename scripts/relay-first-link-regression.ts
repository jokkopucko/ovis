/**
 * A device's first link to a PC, in a real browser at a phone's width (390) and a PC's (1440). The account service
 * is the in-memory fake (shared/account-service-fake.ts), routed in for https://account.ovis.sh; nothing leaves this
 * machine.
 *
 * - The hosted shell (dist-shell/, served as Cloudflare Pages serves it, routed in for https://app.ovis.sh), signed in,
 *   opens QR codes' links for PCs its account does not list. A plain code (no mark): Add and pair posts nothing and
 *   goes on to the relay, as before. A code with the mark `admission: 1`: Add and pair lists a PC the account does not
 *   list yet, then has the admission taken, asked to be quiet, before the first relay connection opens (for a PC its
 *   owner listed, Pair does the same with no listing); when the account service refuses it (429), it stops before any
 *   relay connection and says why. No PC stands behind the relay here, so a pairing that goes on ends there.
 * - A PC's own page (createServer, its relay on a local Bun relay), signed in, in no account, with the account named
 *   for it as `ovis add` names it but the PC not listed in the account: Phone QR code draws the code and, beside
 *   it, lists the PC in the account (PUT /v1/pcs/:id) from the code's own offer, when the account does not list it
 *   yet; it opens or closes no pairing window of the PC (POST /api/relay/link, /api/relay/link/close).
 *
 *   bun run build:shell && bun run check run --build bun scripts/relay-first-link-regression.ts
 *
 * The browser lane (scripts/ci-browser.sh) builds dist/ and dist-shell/ first; this uses those builds and builds
 * nothing.
 * UI_EVIDENCE_DIR=<dir> keeps a screenshot of each screen; without it the checks still run.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import { startBunRelay } from "../relay/bun.ts";
import { createServer } from "../server/index.ts";
import { RelayService } from "../server/relay/service.ts";
import { bounded, deferred } from "../server/relay/test-helpers.ts";
import { UsageService } from "../server/usage.ts";
import { FakeAccountService } from "../shared/account-service-fake.ts";
import { exportPublicKey, generateKeyPair } from "../shared/relay-e2ee.ts";
import { decodeOffer, encodeOffer } from "../shared/relay-offer.ts";
import { deriveServerId } from "../shared/relay-server-proof.ts";
import { chromePath } from "./chrome-path.ts";
import { servePagesSite } from "./pages-static.ts";
import { openSettingsPage } from "./settings-page.ts";

const APP = "https://app.ovis.sh";
const ACCOUNT_SERVICE = "https://account.ovis.sh";
const ACCOUNT = "acct_first_link";
const WIDTHS = [{ width: 390, height: 844 }, { width: 1440, height: 900 }] as const;
const evidence = process.env["UI_EVIDENCE_DIR"] || null;
const cleanup: (() => unknown)[] = [];
// whether each admission the account service was sent asked to be quiet
const quiet: boolean[] = [];
// every admission the account service holds, the quiet ones too: those go in a list of their own (shared/account-service-fake.ts)
const admissionsHeld = () => fake.admissions().length + fake.quietAdmissions().length;
const fake = new FakeAccountService();
const token = fake.issueToken(ACCOUNT);

async function shot(page: Page, name: string): Promise<void> {
  if (!evidence) return;
  mkdirSync(evidence, { recursive: true });
  await page.screenshot({ path: join(evidence, `relay-first-link-${name}.png`) });
}

/** A browser context of `width` whose account service is the fake; `log` gets `METHOD /path` of each call it answered. */
async function contextAt(browser: Browser, size: (typeof WIDTHS)[number], log: string[], allowOrigin: string, refuse: { admissions: boolean } = { admissions: false }): Promise<BrowserContext> {
  const mobile = size.width < 600;
  const context = await browser.newContext({ viewport: size, deviceScaleFactor: mobile ? 3 : 1, isMobile: mobile, hasTouch: mobile, serviceWorkers: "block", locale: "en-US" });
  cleanup.push(() => context.close());
  await context.addInitScript(() => { if (localStorage.getItem("ovis:settings") === null) localStorage.setItem("ovis:settings", JSON.stringify({ language: "en" })); });
  await context.route(/^https:\/\/account\.ovis\.sh\//, async (route) => {
    const request = route.request();
    const cors = { "access-control-allow-origin": allowOrigin, "access-control-allow-headers": "authorization, content-type", "access-control-allow-methods": "GET, POST, PUT, DELETE" };
    if (request.method() === "OPTIONS") return route.fulfill({ status: 204, headers: cors });
    if (refuse.admissions && request.method() === "POST" && new URL(request.url()).pathname === "/v1/admissions") {
      log.push("POST /v1/admissions 429");
      return route.fulfill({ status: 429, headers: cors, json: { error: { code: "too_many_admissions", message: "Too many requests; try again later" } } });
    }
    const body = request.postDataBuffer();
    if (request.method() === "POST" && new URL(request.url()).pathname === "/v1/admissions" && body !== null) quiet.push((JSON.parse(body.toString()) as { quiet?: unknown }).quiet === true);
    const answer = await fake.fetch(new Request(request.url(), { method: request.method(), headers: request.headers(), ...(body === null ? {} : { body: new Uint8Array(body) }) }));
    log.push(`${request.method()} ${new URL(request.url()).pathname}`);
    return route.fulfill({ status: answer.status, headers: { ...Object.fromEntries(answer.headers), ...cors }, body: Buffer.from(await answer.arrayBuffer()) });
  });
  return context;
}

/** Stores the fake's sign-in for ACCOUNT in the page's account store, as a finished sign-in keeps it. */
async function signIn(page: Page): Promise<void> {
  await page.evaluate(({ service, account, accessToken }) => new Promise<void>((resolve, reject) => {
    const request = indexedDB.open("ovis-account", 1);
    request.onupgradeneeded = () => { request.result.createObjectStore("account"); };
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const tx = request.result.transaction("account", "readwrite");
      tx.objectStore("account").put({ service, account, provider: "github", access_token: accessToken, refresh_token: "fixture-refresh", expires_at: Date.now() + 3_600_000 }, "session");
      tx.oncomplete = () => { request.result.close(); resolve(); };
      tx.onabort = () => reject(tx.error);
    };
  }), { service: ACCOUNT_SERVICE, account: ACCOUNT, accessToken: token });
}

/** The hosted shell: QR codes' links, plain and marked, for PCs the account does not list yet. */
async function shellAt(browser: Browser, site: string, size: (typeof WIDTHS)[number]): Promise<void> {
  const log: string[] = [];
  const refuse = { admissions: false };
  const context = await contextAt(browser, size, log, APP, refuse);
  await context.route(/^https:\/\/app\.ovis\.sh\//, async (route) => {
    const url = new URL(route.request().url());
    await route.fulfill({ response: await route.fetch({ url: `${site}${url.pathname}${url.search}` }) });
  });
  // each relay connection the shell opens, with how many admissions the account service held as it opened
  const sockets: number[] = [];
  await context.routeWebSocket(/^wss:\/\/relay\.test\//, (ws) => { sockets.push(admissionsHeld()); ws.close(); });
  const page = await context.newPage();
  page.setDefaultTimeout(20_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${APP}/`, { waitUntil: "domcontentloaded" });
  await signIn(page);
  /** Opens a new PC's QR code link, `marked` or not, presses Add and pair, and waits past the connecting screen; answers the PC's id. */
  const add = async (marked: boolean, name: string, owned = false): Promise<string> => {
    const identity = generateKeyPair();
    const serverId = deriveServerId(identity.publicKey);
    const offer = { v: 1 as const, server_id: serverId, server_public_key: exportPublicKey(identity.publicKey), relay: "wss://relay.test", name: "Desk", code: "482913", ...(marked ? { admission: 1 as const } : {}) };
    // the PC's owner added it to the account already (its own page, or `ovis add`), under its relay key
    if (owned) {
      const publicKey = Array.from(identity.publicKey, (byte) => byte.toString(16).padStart(2, "0")).join("");
      const put = await fake.fetch(new Request(`${ACCOUNT_SERVICE}/v1/pcs/${serverId}`, { method: "PUT", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ label: "Desk", public_key: publicKey, relay: "wss://relay.test" }) }));
      assert.ok(put.ok, `${size.width}: the owner lists the PC`);
    }
    log.length = 0;
    sockets.length = 0;
    quiet.length = 0;
    await page.goto(encodeOffer(offer, APP), { waitUntil: "domcontentloaded" });
    await page.getByRole("heading", { name: owned ? "Pair with Desk?" : "Add Desk to your account?", exact: true }).waitFor();
    await shot(page, `${size.width}-${name}-confirm`);
    await page.getByRole("button", { name: owned ? "Pair" : "Add and pair", exact: true }).click();
    await page.waitForFunction(() => document.querySelector("main[data-relay-state]") !== null && document.querySelector('main[data-relay-state="connecting"], main[data-relay-state="confirm"]') === null);
    return serverId;
  };

  // a plain code: no admission is posted, and the pairing goes on to the relay, as before
  const before = admissionsHeld();
  await add(false, "plain");
  assert.ok(!log.some((line) => line.startsWith("POST /v1/admissions")), `${size.width}: a plain code posts no admission (${log.join(", ")})`);
  assert.ok(sockets.length > 0, `${size.width}: a plain code's pairing goes on to the relay`);
  assert.equal(admissionsHeld(), before, `${size.width}: the account holds no new admission`);

  // a marked code of a PC the account does not list: the press of Add and pair lists it, then the admission is taken,
  // and only then the relay
  const unlisted = await add(true, "marked-unlisted");
  const unlistedCalls = log.filter((line) => line !== "GET /v1/pcs");
  assert.deepEqual(unlistedCalls.slice(0, 2), [`PUT /v1/pcs/${unlisted}`, "POST /v1/admissions"], `${size.width}: Add and pair lists the PC, then posts the admission (${unlistedCalls.join(", ")})`);
  assert.ok(fake.pcs(ACCOUNT).some((pc) => pc.server_id === unlisted), `${size.width}: the account lists the PC`);
  assert.ok(sockets.length > 0, `${size.width}: that pairing went on to the relay`);

  // a marked code of a PC its owner listed: the admission taken, and only then the relay
  const before2 = admissionsHeld();
  await add(true, "marked", true);
  const calls = log.filter((line) => line !== "GET /v1/pcs");
  assert.deepEqual(calls.slice(0, 1), ["POST /v1/admissions"], `${size.width}: a marked code posts the admission first, and lists nothing (${calls.join(", ")})`);
  assert.ok(sockets.length > 0, `${size.width}: the marked code's pairing went on to the relay`);
  assert.equal(sockets[0], before2 + 1, `${size.width}: the admission was taken before the first relay connection opened`);
  assert.deepEqual(quiet, [true], `${size.width}: the marked code's admission asked to be quiet`);

  // a marked code whose admission the account service refuses: it stops before the relay, and says why
  refuse.admissions = true;
  await add(true, "refused", true);
  await page.locator('main[data-relay-state="account-busy"]').waitFor();
  assert.deepEqual(sockets, [], `${size.width}: a refused admission opens no relay connection, so the code was not used`);
  await shot(page, `${size.width}-refused`);
  assert.deepEqual(errors, [], `${size.width}: no page error`);
}

/** A PC's own page, signed in, in no account, its account named: the QR code, the PC listed beside it, and no pairing window touched. */
async function pcPageAt(browser: Browser, origin: string, size: (typeof WIDTHS)[number]): Promise<void> {
  const log: string[] = [];
  const context = await contextAt(browser, size, log, "*");
  // the PC's page names the account service (server/static.ts's meta) once Settings reads it
  await context.addInitScript((url) => document.addEventListener("DOMContentLoaded", () => {
    const meta = document.createElement("meta");
    meta.name = "ovis-pc-account-service";
    meta.content = url;
    document.head.append(meta);
  }), ACCOUNT_SERVICE);
  await context.route("**/api/access", (route) => route.fulfill({ json: { port: 0, tailscale: { state: "missing", dns_name: null, serving_url: null, serve_command: null, serve_url: null } } }));
  const page = await context.newPage();
  page.setDefaultTimeout(20_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (request) => { const path = new URL(request.url()).pathname; if (path === "/api/relay/offer" || path.startsWith("/api/relay/link")) log.push(`${request.method()} ${path}`); });
  await page.goto(origin, { waitUntil: "domcontentloaded" });
  await signIn(page);
  await page.reload({ waitUntil: "domcontentloaded" });
  try {
    await page.locator(".conn-live").waitFor({ state: "attached" });
  } catch (error) {
    await shot(page, `${size.width}-relay-tab-failed`);
    throw error;
  }
  await page.keyboard.press("ControlOrMeta+Shift+Comma");
  await openSettingsPage(page, "Devices and PCs");
  await page.locator('.settings-dialog [data-section="devices"]').getByRole("button", { name: "Add a connection", exact: true }).click();
  const sheet = page.getByRole("dialog", { name: "Add a connection", exact: true });
  await sheet.locator('.connect-tabs [data-tab="relay"]').click();
  const part = sheet.locator('[data-tab-panel="relay"] [data-testid="connect-account-qr"]');
  // the PC the QR code names, from the offer it answers
  const offered = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/relay/offer" && response.ok());
  const listedBefore = new Set(fake.pcs(ACCOUNT).map((pc) => pc.server_id));
  // the listing, which runs beside the code: a PUT of the PC's entry
  const putAnswered = page.waitForResponse((response) => response.request().method() === "PUT" && /^\/v1\/pcs\/[0-9a-f]{32}$/.test(new URL(response.url()).pathname));
  await part.getByRole("button", { name: "Phone QR code", exact: true }).click();
  await part.getByRole("img", { name: "QR code that pairs a phone through the relay" }).waitFor();
  const serverId = decodeOffer((await (await offered).json() as { url: string }).url)?.server_id;
  assert.ok(serverId !== undefined, `${size.width}: the QR code names a PC`);
  // the offer first (it names the PC's relay key), the listing beside the code (only when the account did not list the
  // PC yet: a PC listed already is not written again, which the unit tests of listOfferedPc hold), and no pairing window
  if (listedBefore.has(serverId)) putAnswered.catch(() => undefined);
  else {
    await putAnswered;
    assert.ok(log.indexOf(`PUT /v1/pcs/${serverId}`) > log.indexOf("POST /api/relay/offer"), `${size.width}: the PC was listed from the QR code's offer (${log.join(", ")})`);
  }
  assert.ok(!log.some((line) => line.includes("/api/relay/link")), `${size.width}: no pairing window of the PC was opened or closed (${log.join(", ")})`);
  assert.ok(fake.pcs(ACCOUNT).some((pc) => pc.server_id === serverId), `${size.width}: the account lists the PC`);
  await shot(page, `${size.width}-relay-tab`);
  assert.deepEqual(errors, [], `${size.width}: no page error`);
}

const shellDir = join(import.meta.dir, "..", "dist-shell");
let code = 0;
try {
  if (!existsSync(join(shellDir, "index.html"))) throw new Error("no dist-shell/: run bun run build:shell first");
  const site = servePagesSite(shellDir, 0, "127.0.0.1");
  cleanup.push(() => site.stop(true));

  // PC A: its relay on, through a local Bun relay, in no account
  const relay = startBunRelay({ port: 0, limiters: { perAddress: { async limit() { return { success: true }; } }, global: { async limit() { return { success: true }; } } } });
  cleanup.push(() => relay.stop());
  const dir = mkdtempSync(join(tmpdir(), "ovis-relay-first-link-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const synced = deferred<void>();
  const relayService = new RelayService({ stateDir: dir, relay: `wss://127.0.0.1:${relay.port}`, connect: (url) => {
    const target = new URL(url);
    const socket = new WebSocket(`ws://127.0.0.1:${relay.port}${target.pathname}${target.search}`);
    socket.addEventListener("message", (event) => { if (typeof event.data === "string" && JSON.parse(event.data).type === "sync") synced.resolve(); });
    return socket;
  } });
  cleanup.push(() => relayService.shutdown());
  const pc = createServer({ port: 0, hostname: "127.0.0.1", stateDir: dir, token: "", tailscaleOwner: null, sidecar: false, registerBridge: false,
    relay: relayService, accountService: { url: ACCOUNT_SERVICE, fetch: fake.fetch }, usage: new UsageService(undefined, []),
    tailnetPcs: { readStatus: async () => null }, sshCandidates: { sshDir: join(dir, "no-ssh"), readStatus: async () => null } });
  cleanup.push(() => pc.stop());
  const origin = `http://127.0.0.1:${pc.port}`;
  const started = await fetch(`${origin}/api/relay/start`, { method: "POST", headers: { origin, "x-herdr-update": "1" } });
  assert.equal(started.status, 200, "the relay starts");
  await bounded(synced.promise, 15_000);
  // the relay tab offers its QR code only on a PC that an account was named for; naming it does not list the PC
  const named = await fetch(`${origin}/api/account/relay-account`, { method: "POST", headers: { "content-type": "application/json", "x-herdr-machine": "1", origin }, body: JSON.stringify({ account: ACCOUNT }) });
  assert.equal(named.status, 204, "the account is named for the PC");
  assert.ok(!fake.pcs(ACCOUNT).length, "the account lists no PC yet");

  const browser = await chromium.launch({ headless: true, executablePath: chromePath(), args: ["--no-sandbox"] });
  cleanup.push(() => browser.close());
  for (const size of WIDTHS) {
    await shellAt(browser, `http://127.0.0.1:${site.port}`, size);
    await pcPageAt(browser, origin, size);
  }
  console.log("PASS relay first link: at 390 and 1440 a plain code pairs as before with no admission; a marked code's press lists a PC the account does not list, and the admission is taken before the relay, or it stops with why; a PC's relay tab draws its QR code and lists the PC beside it for the account named for it, touching no pairing window");
} catch (error) {
  code = 1;
  console.error("FAIL relay first link:", error);
} finally {
  for (const close of cleanup.reverse()) {
    try { await close(); } catch { /* the run's own result stands */ }
  }
}
process.exit(code);
