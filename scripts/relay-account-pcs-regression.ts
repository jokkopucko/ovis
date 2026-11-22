/**
 * service is shared/account-service-fake.ts, a route of the browser context for A's page and B's own fetch, and A's
 * account status is pinned, so neither account.ovis.sh nor the PC running this changes the outcome.
 */
import "./test-herdr.ts";
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
import { deriveServerId } from "../shared/relay-server-proof.ts";
import { chromePath } from "./chrome-path.ts";
import { openSettingsPage } from "./settings-page.ts";

const ACCOUNT = "acct_relay_tab";
const ACCOUNT_SERVICE = "https://account.fixture.test";
const evidence = process.env["UI_EVIDENCE_DIR"];
const cleanup: (() => unknown)[] = [];
// The PC's real HTML and CSP must name the same service the browser route below intercepts.
const previousService = process.env["OVIS_ACCOUNT_SERVICE_URL"];
process.env["OVIS_ACCOUNT_SERVICE_URL"] = ACCOUNT_SERVICE;
cleanup.push(() => {
  if (previousService === undefined) delete process.env["OVIS_ACCOUNT_SERVICE_URL"];
  else process.env["OVIS_ACCOUNT_SERVICE_URL"] = previousService;
});

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

const bState = stateDir();
const memberKeys = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
const memberKey = Buffer.from(await crypto.subtle.exportKey("spki", memberKeys.publicKey)).toString("base64url");
const member = { id: randomBytes(8).toString("hex"), label: "Owner's phone", role: "drive", token_hash: randomBytes(32).toString("hex"),
  relay_public_key: memberKey, account: ACCOUNT, created_at: new Date().toISOString(), last_seen_at: null };
writeFileSync(join(bState, "devices.json"), JSON.stringify({ gate_closed_at: member.created_at, devices: [member] }), { mode: 0o600 });
const bRelay = relayService(bState);
// This fixture uses the legacy account-vouched flow and its existing phone approver,
// not a Step 2 admission or a new account-service grant.
const b = createServer({ port: 0, hostname: "127.0.0.1", stateDir: bState, token: "", tailscaleOwner: null, sidecar: false, registerBridge: false,
  relay: bRelay.relayService, accountService, accountOpensAll: false, usage: new UsageService(undefined, []) });
cleanup.push(() => b.stop());
const bBase = `http://127.0.0.1:${b.port}`;
await startRelay(bBase, bRelay.synced);
const offered = await fetch(`${bBase}/api/relay/offer`, { method: "POST", headers: { origin: bBase, "x-herdr-update": "1" } });
const { code: _code, ...offer } = decodeOffer((await offered.json() as { url: string }).url)!;
await service.fetch(new Request(`${ACCOUNT_SERVICE}/v1/pcs/${offer.server_id}`, { method: "PUT", headers: { authorization: `Bearer ${token}` },
  body: JSON.stringify({ label: "Desk", public_key: bytesToHex(importPublicKey(offer.server_public_key)), relay: offer.relay }) }));
// a PC of the account that is never on: its relay route answers nobody
const awayKey = randomBytes(32);
await service.fetch(new Request(`${ACCOUNT_SERVICE}/v1/pcs/${deriveServerId(awayKey)}`, { method: "PUT", headers: { authorization: `Bearer ${token}` },
  body: JSON.stringify({ label: "Away", public_key: bytesToHex(awayKey), relay: offer.relay }) }));

const aState = stateDir();
const aRelay = relayService(aState);
const a = createServer({ port: 0, hostname: "127.0.0.1", stateDir: aState, token: "", tailscaleOwner: null, sidecar: false, registerBridge: false,
  relay: aRelay.relayService, relayPcSocket: aRelay.local, accountService, accountOpensAll: false, usage: new UsageService(undefined, []),
  tailnetPcs: { readStatus: async () => null }, sshCandidates: { sshDir: join(aState, "no-ssh"), readStatus: async () => null } });
cleanup.push(() => a.stop());
const origin = `http://127.0.0.1:${a.port}`;
await startRelay(origin, aRelay.synced);

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

function remotePrompt(): Promise<RemotePairingRequest> {
  const found = deferred<RemotePairingRequest>();
  const stop = b.context.services.relay.approvals.subscribeRemote((list) => { if (list[0]) found.resolve(list[0]); });
  return bounded(found.promise, 30_000).finally(stop);
}

async function accountWindow(browser: Browser, pageErrors: string[], relation: "mine" | "other" | "signed-out" = "mine"): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: "en-US" });
  cleanup.push(() => context.close());
  await context.addInitScript(() => localStorage.setItem("ovis:settings", JSON.stringify({ language: "en" })));
  await context.route("**/api/access", (route) => route.fulfill({ json: { port: 0, tailscale: { state: "missing", dns_name: null, serving_url: null, serve_command: null, serve_url: null } } }));
  await context.route("**/api/account/status*", (route) => route.fulfill({ json: { account: relation === "other" ? "acct_other_pc" : ACCOUNT, pc_add_from_account: true,
    members: 1, unlinked: [], removals: [], adds: [], blocked: [], enrolling: false, mailbox: { last_pull_at: null, error: null } } }));
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
  if (relation !== "signed-out") await page.evaluate(({ url, account, accessToken }) => new Promise<void>((resolve, reject) => {
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

async function openRelayTab(page: Page, expected = "This PC is in an account. Add PCs from your account.") {
  await page.keyboard.press("ControlOrMeta+Shift+Comma");
  await openSettingsPage(page, "Devices and PCs");
  await page.locator('.settings-dialog [data-section="devices"]').getByRole("button", { name: "Add a connection", exact: true }).click();
  const sheet = page.getByRole("dialog", { name: "Add a connection", exact: true });
  await sheet.locator('.connect-tabs [data-tab="relay"]').click();
  const tab = sheet.locator('[data-tab-panel="relay"]');
  // the account's PCs at once for this PC's own account, the prompt for any other sign-in
  await tab.locator(".relay-account-pcs").or(tab.getByText(expected, { exact: true })).first().waitFor();
  assert.ok(!(await tab.innerText()).includes("acct_"), "no raw account ID");
  assert.equal(await tab.getByText(/This PC shows a QR code only|This browser is not signed in, so it cannot tell|To add a device, sign in to this PC's account/).count(), 0);
  return tab;
}

/** a PC of the account the sidebar lists under its own because it is not in this app yet */
const accountRow = (page: Page, name: string) => page.locator(`.account-pc-group[aria-label="PC ${name}"]`);

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

  const adding = await accountWindow(browser, pageErrors);
  // signed in, with nothing opened: the sidebar lists the account's PCs that are not in this app yet
  const away = accountRow(adding.page, "Away");
  await away.getByText("Switched off", { exact: true }).waitFor({ timeout: 30_000 });
  const checkAway = away.getByRole("button", { name: "Check again", exact: true });
  const deskRow = accountRow(adding.page, "Desk");
  const add = deskRow.getByRole("button", { name: "Add Desk", exact: true });
  await add.waitFor();
  assert.equal(await adding.page.locator(".settings-dialog, .connect-phone-dialog").count(), 0, "no settings or Add a connection was opened for the list");
  await shot(adding.page, "sidebar");
  await checkAway.click();
  // held while that PC is asked again, then offered again since it still does not answer
  await away.getByRole("button", { name: "Checking…", exact: true }).waitFor();
  await checkAway.waitFor({ timeout: 30_000 });
  assert.equal(await away.getByText("Switched off", { exact: true }).count(), 1, "it still reads Switched off");
  const approve = await approver();
  const prompted = remotePrompt();
  await add.click();
  const digits = (await deskRow.locator(".relay-account-digits").innerText()).replace(/\s/g, "");
  assert.match(digits, /^\d{6}$/, "the sidebar shows the six digits to approve");
  const request = await prompted;
  assert.ok(request.choices.includes(digits), "B's member is offered the digits the sidebar shows");
  assert.equal(await approve(request.id, digits), 200, "B's member approves");
  await opened(adding.page, "Desk");
  await deskRow.waitFor({ state: "detached" });
  const listed = await (await fetch(`${origin}/api/machines`, { headers: { origin } })).json() as { machines: { kind: string; name: string }[] };
  assert.equal(listed.machines.filter((machine) => machine.kind === "relay" && machine.name === "Desk").length, 1, "A added Desk once");
  await shot(adding.page, "after-add");

  const connecting = await accountWindow(browser, pageErrors);
  assert.equal(await connecting.page.locator('.machine-title[aria-current="true"][title="Desk"]').count(), 0, "a new window starts on another PC");
  const mine = await openRelayTab(connecting.page);
  // signed in to this PC's own account, the tab lists the account's PCs at once
  assert.equal(await mine.getByRole("button", { name: "Add from account", exact: true }).count(), 0, "no prompt stands before the account's PCs");
  const added = mine.locator(".relay-account-pc").filter({ has: connecting.page.locator(".connect-found-name", { hasText: /^Desk$/ }) });
  await added.locator(".connect-found-detail", { hasText: /^In this app$/ }).waitFor();
  await added.getByRole("button", { name: "Open", exact: true }).click();
  await opened(connecting.page, "Desk");
  await shot(connecting.page, "after-connect");

  for (const relation of ["other", "signed-out"] as const) {
    const { page } = await accountWindow(browser, pageErrors, relation);
    const tab = await openRelayTab(page);
    await tab.getByText("Sign in to this PC's account.", { exact: true }).waitFor();
    await tab.getByRole("button", { name: "Add from account", exact: true }).click();
    if (relation === "signed-out") {
      const signIn = tab.getByTestId("connect-signin");
      const first = signIn.getByRole("button").first();
      await first.waitFor();
      assert.equal(await first.isEnabled(), true);
      assert.equal(await first.evaluate(el => document.activeElement === el), true);
    } else {
      await page.locator(".connect-phone-dialog").waitFor({ state: "detached" });
      await page.locator('.settings-dialog [data-section="account"] button:focus').waitFor();
    }
  }

  for (const strict of [false, true]) {
    const { page } = await accountWindow(browser, pageErrors, "signed-out");
    await page.route("**/api/account/status*", route => route.fulfill(strict
      ? { status: 403, json: { error: { code: "strict", message: "Unavailable" } } }
      : { json: { account: null, pc_add_from_account: "unavailable" } }));
    const tab = await openRelayTab(page, "Can't add a PC right now. Try again in a moment.");
    assert.equal(await tab.getByRole("button", { name: /Add from account|Show the QR code/ }).count(), 0);
    if (!strict) await shot(page, "unavailable");
  }
  assert.deepEqual(pageErrors, [], "no page error");
  console.log("PASS the account's PCs: the sidebar lists those not in this app yet with nothing opened, Switched off with Check again for one that does not answer, and its Add pairs once a member approves; Add a connection → Ovis relay's Open opens one already added; both select it in the sidebar with no SSH setup dialog");
} catch (error) {
  code = 1;
  console.error("FAIL relay account PCs:", error);
} finally {
  for (const close of cleanup.reverse()) {
    try { await close(); } catch {}
  }
}
process.exit(code);
