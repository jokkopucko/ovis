/**
 * Settings → Devices and PCs → Add a connection → Ovis relay, signed in with this PC in the account: the account's
 * other PC, added and then opened. Two real servers on a local Bun relay (relay/bun.ts): PC A, whose page this is, and
 * PC B in the account with one drive member, as server/relay-pc-account.contract.test.ts sets them up. The account
 * service is shared/account-service-fake.ts, a route of the browser context for A's page and B's own fetch, and A's
 * account status is pinned, so neither account.ovis.sh nor the PC running this changes the outcome.
 *
 * Add pairs A with B once B's member picks the digits the page shows, and the PC then opens as a pick in the sidebar
 * does: Settings closes, B is the selected PC and no SSH setup dialog opens (a relay PC has none). In a window that
 * selected this PC, B's row then reads Connect, which opens it the same way.
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bytesToHex } from "@noble/hashes/utils.js";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import { startBunRelay } from "../relay/bun.ts";
import { createServer } from "../server/index.ts";
import { RelayService } from "../server/relay/service.ts";
import { bounded, deferred, relayConnection } from "../server/relay/test-helpers.ts";
import { UsageService } from "../server/usage.ts";
import { FakeAccountService } from "../shared/account-service-fake.ts";
import type { RemotePairingRequest } from "../shared/machines.ts";
import { importPublicKey } from "../shared/relay-e2ee.ts";
import { decodeOffer } from "../shared/relay-offer.ts";
import { chromePath } from "./chrome-path.ts";
import { openSettingsPage } from "./settings-page.ts";

const ACCOUNT = "acct_relay_tab";
const ACCOUNT_SERVICE = "https://account.ovis.sh";
const evidence = process.env["UI_EVIDENCE_DIR"];
const cleanup: (() => unknown)[] = [];

const relay = startBunRelay({ port: 0, limiters: {
  perAddress: { async limit() { return { success: true }; } },
  global: { async limit() { return { success: true }; } },
} });
cleanup.push(() => relay.stop());
const service = new FakeAccountService();
const token = service.issueToken(ACCOUNT);
const accountService = { url: ACCOUNT_SERVICE, fetch: service.fetch };

function stateDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "ovis-relay-account-pcs-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A relay service dialling the local relay, and the moment its server link first synced. */
function relayService(dir: string) {
  const synced = deferred<void>();
  const local = (url: string): WebSocket => {
    const target = new URL(url);
    const socket = new WebSocket(`ws://127.0.0.1:${relay.port}${target.pathname}${target.search}`);
    if (target.searchParams.get("role") === "server" && !target.searchParams.has("connection_id")) {
      socket.addEventListener("message", (event) => {
        if (typeof event.data === "string" && JSON.parse(event.data).type === "sync") synced.resolve();
      });
    }
    return socket;
  };
  const relayService = new RelayService({ stateDir: dir, relay: `wss://127.0.0.1:${relay.port}`, connect: local });
  cleanup.push(() => relayService.shutdown());
  return { relayService, local, synced: synced.promise };
}

async function startRelay(base: string, synced: Promise<void>): Promise<void> {
  const started = await fetch(`${base}/api/relay/start`, { method: "POST", headers: { origin: base, "x-herdr-update": "1" } });
  assert.equal(started.status, 200, "the relay starts");
  await bounded(synced, 15_000);
}

// PC B: in the account, with one drive member who approves from another device
const bState = stateDir();
const memberKeys = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
const memberKey = Buffer.from(await crypto.subtle.exportKey("spki", memberKeys.publicKey)).toString("base64url");
const member = { id: randomBytes(8).toString("hex"), label: "Owner's phone", role: "drive", token_hash: randomBytes(32).toString("hex"),
  relay_public_key: memberKey, account: ACCOUNT, created_at: new Date().toISOString(), last_seen_at: null };
writeFileSync(join(bState, "devices.json"), JSON.stringify({ gate_closed_at: member.created_at, devices: [member] }), { mode: 0o600 });
const bRelay = relayService(bState);
const b = createServer({ port: 0, hostname: "127.0.0.1", stateDir: bState, token: "", tailscaleOwner: null, sidecar: false, registerBridge: false,
  relay: bRelay.relayService, accountService, usage: new UsageService(undefined, []) });
cleanup.push(() => b.stop());
const bBase = `http://127.0.0.1:${b.port}`;
await startRelay(bBase, bRelay.synced);
const offered = await fetch(`${bBase}/api/relay/offer`, { method: "POST", headers: { origin: bBase, "x-herdr-update": "1" } });
const { code: _code, ...offer } = decodeOffer((await offered.json() as { url: string }).url)!;
// B in the account's directory, named Desk, as every signed-in device of the account reads it
await service.fetch(new Request(`${ACCOUNT_SERVICE}/v1/pcs/${offer.server_id}`, { method: "PUT", headers: { authorization: `Bearer ${token}` },
  body: JSON.stringify({ label: "Desk", public_key: bytesToHex(importPublicKey(offer.server_public_key)), relay: offer.relay }) }));

// PC A: the page's own PC, its relay on, dialling B through the same relay
const aState = stateDir();
const aRelay = relayService(aState);
const a = createServer({ port: 0, hostname: "127.0.0.1", stateDir: aState, token: "", tailscaleOwner: null, sidecar: false, registerBridge: false,
  relay: aRelay.relayService, relayPcSocket: aRelay.local, accountService, usage: new UsageService(undefined, []),
  tailnetPcs: { readStatus: async () => null }, sshCandidates: { sshDir: join(aState, "no-ssh"), readStatus: async () => null } });
cleanup.push(() => a.stop());
const origin = `http://127.0.0.1:${a.port}`;
await startRelay(origin, aRelay.synced);

/** B's member, signed in to B through a relay session of its own, deciding the comparison B shows the account. */
async function approver() {
  const holder = { app: b, closes: [] as (() => void)[], stateDir: bState, close() {} };
  cleanup.push(() => { for (const close of holder.closes) close(); });
  const link = await relayConnection(holder as never, { serverId: offer.server_id });
  await link.auth({ keys: memberKeys, publicKey: memberKey, id: member.id });
  return async (id: string, digits: string): Promise<number> => {
    const request = link.open("/api/relay/pairing", { method: "POST", headers: [["content-type", "application/json"], ["x-herdr-machine", "1"]], body: "stream" });
    void request.stream.sendBody(new Response(JSON.stringify({ id, decision: "approve", digits })).body!).catch(() => {});
    return (await request.response).status;
  };
}

/** The next comparison B shows its account's members. */
function remotePrompt(): Promise<RemotePairingRequest> {
  const found = deferred<RemotePairingRequest>();
  const stop = b.context.services.relay.approvals.subscribeRemote((list) => { if (list[0]) found.resolve(list[0]); });
  return bounded(found.promise, 30_000).finally(stop);
}

/** A window of A's page, signed in to the account (the session its sign-in keeps), with this PC in that account. */
async function signedInWindow(browser: Browser, pageErrors: string[]): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: "en-US" });
  cleanup.push(() => context.close());
  await context.addInitScript(() => localStorage.setItem("ovis:settings", JSON.stringify({ language: "en" })));
  // the PC's page names the account service (server/static.ts's meta) once Settings reads it
  await context.addInitScript((url) => document.addEventListener("DOMContentLoaded", () => {
    const meta = document.createElement("meta");
    meta.name = "ovis-pc-account-service";
    meta.content = url;
    document.head.append(meta);
  }), ACCOUNT_SERVICE);
  await context.route("**/api/access", (route) => route.fulfill({ json: { port: 0, tailscale: { state: "missing", dns_name: null, serving_url: null, serve_command: null, serve_url: null } } }));
  await context.route("**/api/account/status*", (route) => route.fulfill({ json: { account: ACCOUNT, members: 1, unlinked: [], removals: [], adds: [], blocked: [], enrolling: false, mailbox: { last_pull_at: null, error: null } } }));
  await context.route(`${ACCOUNT_SERVICE}/**`, async (route) => {
    const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "authorization, content-type", "access-control-allow-methods": "GET, POST, PUT, DELETE" };
    if (route.request().method() === "OPTIONS") return route.fulfill({ status: 204, headers: cors });
    const body = route.request().postData();
    const response = await service.fetch(route.request().url(), { method: route.request().method(), headers: route.request().headers(), ...(body === null ? {} : { body }) });
    return route.fulfill({ status: response.status, headers: { ...Object.fromEntries(response.headers), ...cors }, body: await response.text() });
  });
  const page = await context.newPage();
  page.setDefaultTimeout(20_000);
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.goto(origin, { waitUntil: "domcontentloaded" });
  await page.evaluate(({ url, account, accessToken }) => new Promise<void>((resolve, reject) => {
    const request = indexedDB.open("ovis-account", 1);
    request.onupgradeneeded = () => { request.result.createObjectStore("account"); };
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const tx = request.result.transaction("account", "readwrite");
      tx.objectStore("account").put({ service: url, account, provider: "github", access_token: accessToken, refresh_token: "fixture-refresh", expires_at: Date.now() + 3_600_000 }, "session");
      tx.oncomplete = () => { request.result.close(); resolve(); };
      tx.onabort = () => reject(tx.error);
    };
  }), { url: ACCOUNT_SERVICE, account: ACCOUNT, accessToken: token });
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.locator(".conn-live").waitFor({ state: "attached" });
  return { context, page };
}

/** Settings → Devices and PCs → Add a connection → Ovis relay, with Desk's row in it. */
async function openRelayTab(page: Page) {
  await page.keyboard.press("ControlOrMeta+Shift+Comma");
  await openSettingsPage(page, "Devices and PCs");
  await page.locator('.settings-dialog [data-section="devices"]').getByRole("button", { name: "Add a connection", exact: true }).click();
  const sheet = page.getByRole("dialog", { name: "Add a connection", exact: true });
  await sheet.locator('.connect-tabs [data-tab="relay"]').click();
  const desk = sheet.locator('[data-tab-panel="relay"] .relay-account-pc').filter({ has: page.locator(".connect-found-name", { hasText: /^Desk$/ }) });
  await desk.waitFor();
  return desk;
}

/** The PC the sidebar shows selected, or the SSH setup dialog a relay PC must never get: whichever comes first. */
async function opened(page: Page, name: string): Promise<void> {
  const selected = page.locator(`.machine-title[aria-current="true"][title="${name}"]`);
  const setup = page.locator("dialog.machine-dialog[open]");
  await selected.or(setup).first().waitFor();
  assert.equal(await setup.count(), 0, `${name} opens with no SSH setup dialog`);
  await page.locator(".settings-dialog").waitFor({ state: "detached" });
  assert.equal(await selected.count(), 1, `the sidebar selects ${name}`);
}

async function shot(page: Page, name: string): Promise<void> {
  if (!evidence) return;
  mkdirSync(evidence, { recursive: true });
  await page.screenshot({ path: join(evidence, `relay-account-pcs-${name}.png`) });
}

const browser = await chromium.launch({ headless: true, executablePath: chromePath(), args: ["--no-sandbox"] });
cleanup.push(() => browser.close());
let code = 0;
try {
  const pageErrors: string[] = [];

  // Add: the digits show, B's member picks them, and Desk opens in the sidebar
  const adding = await signedInWindow(browser, pageErrors);
  const desk = await openRelayTab(adding.page);
  const add = desk.getByRole("button", { name: "Add Desk", exact: true });
  await add.waitFor();
  const approve = await approver();
  const prompted = remotePrompt();
  await add.click();
  const digits = (await desk.locator(".relay-account-digits").innerText()).replace(/\s/g, "");
  assert.match(digits, /^\d{6}$/, "the page shows the six digits to approve");
  const request = await prompted;
  assert.ok(request.choices.includes(digits), "B's member is offered the digits the page shows");
  assert.equal(await approve(request.id, digits), 200, "B's member approves");
  await opened(adding.page, "Desk");
  const listed = await (await fetch(`${origin}/api/machines`, { headers: { origin } })).json() as { machines: { kind: string; name: string }[] };
  assert.equal(listed.machines.filter((machine) => machine.kind === "relay" && machine.name === "Desk").length, 1, "A added Desk once");
  await shot(adding.page, "after-add");

  // Connect: another window, on this PC, finds Desk in this app already and opens it the same way
  const connecting = await signedInWindow(browser, pageErrors);
  assert.equal(await connecting.page.locator('.machine-title[aria-current="true"][title="Desk"]').count(), 0, "a new window starts on another PC");
  const added = await openRelayTab(connecting.page);
  await added.locator(".connect-found-detail", { hasText: /^In this app$/ }).waitFor();
  await added.getByRole("button", { name: "Connect", exact: true }).click();
  await opened(connecting.page, "Desk");
  await shot(connecting.page, "after-connect");

  assert.deepEqual(pageErrors, [], "no page error");
  console.log("PASS Add a connection → Ovis relay: Add pairs this PC with the account's other PC once its member approves, and Connect on a PC already added opens it; both select it in the sidebar with no SSH setup dialog");
} catch (error) {
  code = 1;
  console.error("FAIL relay account PCs:", error);
} finally {
  for (const close of cleanup.reverse()) {
    try { await close(); } catch { /* the run's own result stands */ }
  }
}
process.exit(code);
