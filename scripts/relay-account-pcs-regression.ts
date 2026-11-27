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
import { savedServerId } from "../server/relay/identity.ts";
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
service.offerLinkPage(["github"]);
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
service.opensAll = true;
service.registerDevice(ACCOUNT, memberKey, "Owner phone");
const bRelay = relayService(bState);
// This fixture uses the legacy account-vouched flow and its existing phone approver,
// not a Step 2 admission or a new account-service grant.
const b = createServer({ port: 0, hostname: "127.0.0.1", stateDir: bState, token: "", tailscaleOwner: null, sidecar: false, registerBridge: false,
  relay: bRelay.relayService, accountService, accountOpensAll: true, platform: "linux", usage: new UsageService(undefined, []) });
cleanup.push(() => b.stop());
const bBase = `http://127.0.0.1:${b.port}`;
await startRelay(bBase, bRelay.synced);
const offered = await fetch(`${bBase}/api/relay/offer`, { method: "POST", headers: { origin: bBase, "x-herdr-update": "1" } });
const { code: _code, ...offer } = decodeOffer((await offered.json() as { url: string }).url)!;
await service.fetch(new Request(`${ACCOUNT_SERVICE}/v1/pcs/${offer.server_id}`, { method: "PUT", headers: { authorization: `Bearer ${token}` },
  body: JSON.stringify({ label: "Desk", public_key: bytesToHex(importPublicKey(offer.server_public_key)), relay: offer.relay }) }));
assert.equal((await b.context.services.accountMailbox.readSnapshot())?.committed, true);
await b.context.services.accountMailbox.pull();
assert.ok(service.pcs(ACCOUNT).find((pc) => pc.server_id === offer.server_id)?.last_seen_at, "Desk checked in after being listed");
// Away checked in before going offline; its relay route no longer answers.
const awayKey = randomBytes(32);
const awayId = deriveServerId(awayKey);
await service.fetch(new Request(`${ACCOUNT_SERVICE}/v1/pcs/${awayId}`, { method: "PUT", headers: { authorization: `Bearer ${token}` },
  body: JSON.stringify({ label: "Away", public_key: bytesToHex(awayKey), relay: offer.relay }) }));
const awayEntry = service.pcs(ACCOUNT).find((pc) => pc.server_id === awayId);
assert.ok(awayEntry, "Away is listed in the account");
awayEntry.last_seen_at = new Date(Date.now() - 30 * 60_000).toISOString();

const aState = stateDir();
// one host in A's ssh config: the relay tab lists it with Add, which opens Add PC for it
mkdirSync(join(aState, "ssh"), { recursive: true });
writeFileSync(join(aState, "ssh", "config"), "Host p23pcb\n  HostName 192.0.2.10\n  User fixture\n", { mode: 0o600 });
const aRelay = relayService(aState);
const a = createServer({ port: 0, hostname: "127.0.0.1", stateDir: aState, token: "", tailscaleOwner: null, sidecar: false, registerBridge: false,
  relay: aRelay.relayService, relayPcSocket: aRelay.local, accountService, accountOpensAll: false, usage: new UsageService(undefined, []),
  tailnetPcs: { readStatus: async () => null }, sshCandidates: { sshDir: join(aState, "ssh"), home: aState, readStatus: async () => null } });
cleanup.push(() => a.stop());
const origin = `http://127.0.0.1:${a.port}`;
await startRelay(origin, aRelay.synced);

async function approver() {
  const holder = { app: b, closes: [] as (() => void)[], stateDir: bState, close() {} };
  cleanup.push(() => { for (const close of holder.closes) close(); });
  const link = await relayConnection(holder as never, { serverId: offer.server_id });
  await link.auth({ keys: memberKeys, publicKey: memberKey, id: member.id });
  return async (id: string, serverId: string): Promise<number> => {
    const request = link.open("/api/relay/pairing", { method: "POST", headers: [["content-type", "application/json"], ["x-herdr-machine", "1"]], body: "stream" });
    void request.stream.sendBody(new Response(JSON.stringify({ id, decision: "approve", proven_server_id: serverId, pc_label: "Source PC" })).body!).catch(() => {});
    return (await request.response).status;
  };
}

function remotePrompt(): Promise<RemotePairingRequest> {
  const found = deferred<RemotePairingRequest>();
  const stop = b.context.services.relay.approvals.subscribeRemote((list) => { if (list[0]) found.resolve(list[0]); });
  return bounded(found.promise, 30_000).finally(stop);
}

async function accountWindow(browser: Browser, pageErrors: string[], relation: "mine" | "elsewhere" | "other" | "signed-out" = "mine"): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: "en-US" });
  cleanup.push(() => context.close());
  await context.addInitScript(() => localStorage.setItem("ovis:settings", JSON.stringify({ language: "en" })));
  await context.route("**/api/access", (route) => route.fulfill({ json: { port: 0, tailscale: { state: "missing", dns_name: null, serving_url: null, serve_command: null, serve_url: null } } }));
  // a signed-out window signs in on the link page, whose code this script approves at the fake service
  if (relation !== "mine") await context.route("**/api/health?scope=bridge", async (route) => {
    const response = await route.fetch();
    const { own_window: _own, ...body } = await response.json() as Record<string, unknown>;
    await route.fulfill({ response, json: body });
  });
  // signed in to this PC's own account, but not this PC's own window: a device that reaches it over Tailscale
  if (relation === "elsewhere") await context.route("**/api/health*", async (route) => {
    const response = await route.fetch();
    const { own_window: _own, ...body } = await response.json() as { auth?: Record<string, unknown> } & Record<string, unknown>;
    await route.fulfill({ response, json: { ...body, ...(body.auth ? { auth: { ...body.auth, via: "tailscale" } } : {}) } });
  });
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
  // the signed-in line for this PC's own account, the prompt for any other sign-in
  await tab.getByText("This PC is in your account.", { exact: true }).or(tab.getByText(expected, { exact: true })).first().waitFor();
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
  await away.getByText("Can't reach the PC: it may be off", { exact: true }).waitFor({ timeout: 30_000 });
  const deskRow = accountRow(adding.page, "Desk");
  const request = await remotePrompt(); // the sidebar starts the ready PC once, without an Add button
  assert.equal(await deskRow.getByRole("button").count(), 0);
  assert.equal(await away.locator(`.machine-dot[title="Can't reach the PC: it may be off"]`).count(), 1);
  assert.equal(await adding.page.locator(".settings-dialog, .connect-phone-dialog").count(), 0, "the sidebar starts without opening settings");
  await shot(adding.page, "sidebar");
  const approve = await approver();
  const source = savedServerId(aState);
  assert.ok(source && request.proven_server_id === source, "B asks only about the proven source PC");
  assert.deepEqual(request.choices, []);
  assert.equal(await approve(request.id, source), 200, "B's member approves that PC");
  await opened(adding.page, "Desk");
  await deskRow.waitFor({ state: "detached" });
  const listed = await (await fetch(`${origin}/api/machines`, { headers: { origin } })).json() as { machines: { kind: string; name: string }[] };
  assert.equal(listed.machines.filter((machine) => machine.kind === "relay" && machine.name === "Desk").length, 1, "A added Desk once");
  await shot(adding.page, "after-add");

  const connecting = await accountWindow(browser, pageErrors);
  assert.equal(await connecting.page.locator('.machine-title[aria-current="true"][title="Desk"]').count(), 0, "a new window starts on another PC");
  // nothing that admits a device by itself is made as the tab opens: no relay offer, no relay code, no pairing code
  const made: string[] = [];
  connecting.page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (request.method() === "POST" && ["/api/relay/offer", "/api/relay/code", "/api/devices/pair/start"].includes(path)) made.push(path);
  });
  const mine = await openRelayTab(connecting.page);
  // signed in to this PC's own account in this PC's own window, the top is laid out as the Tailscale tab's: the account QR
  // code (as on main), its six digits only on a press beside it, then the signed-in line; the account's PCs are in the sidebar
  assert.equal(await mine.getByRole("button", { name: "Add from account", exact: true }).count(), 0, "no prompt");
  assert.equal(await mine.getByText("Your account's PCs", { exact: true }).count(), 0, "the relay tab lists no account PCs");
  const phonePart = mine.getByTestId("connect-phone-scan");
  const accountQr = phonePart.getByRole("img", { name: "QR code that opens this PC in the Ovis app", exact: true });
  await accountQr.waitFor();
  assert.equal(await mine.getByRole("img", { name: "QR code that pairs a phone through the relay", exact: true }).count(), 0, "no relay pairing QR code");
  assert.equal(await mine.getByTestId("pair-with-code").count(), 0, "no second Pair with a code");
  assert.equal(await phonePart.locator(".compact-pair-code").count(), 0, "no code before the press");
  assert.deepEqual(made, [], "nothing was made as the tab opened");
  await phonePart.getByRole("button", { name: "Get a pairing code", exact: true }).click();
  await phonePart.locator(".compact-pair-code").filter({ hasText: /^\d{3} \d{3}$/ }).waitFor();
  assert.deepEqual(made, ["/api/devices/pair/start"], "the press makes the six digits, and nothing else");
  assert.equal(await mine.getByRole("button", { name: "Refresh", exact: true }).count(), 1, "one Refresh");
  assert.equal(await mine.getByRole("button", { name: "Copy", exact: true }).count(), 1, "one Copy");
  const qrBottom = await accountQr.evaluate((qr) => qr.getBoundingClientRect().bottom);
  assert.ok(qrBottom <= await mine.getByText("This PC is in your account.", { exact: true }).evaluate((line) => line.getBoundingClientRect().top), "the signed-in line comes under the phone part");
  // this PC's own window, signed in to its account: under the QR code, the PCs it can reach to add over SSH, and a field
  const reachable = mine.locator(".connect-reachable");
  await reachable.getByRole("textbox", { name: "A PC not in the list", exact: true }).waitFor();
  assert.ok(qrBottom <= await reachable.evaluate((list) => list.getBoundingClientRect().top), "the PCs to add come under the phone's QR code");
  await shot(connecting.page, "relay-tab");
  // Add on a row opens Add PC for that host with Add it to my account offered and ticked. This PC's own page carries the
  // PC's account service meta alone (server/static.ts), never the hosted shell's, and the dialog reads that one
  assert.deepEqual(await connecting.page.evaluate(() => ["ovis-pc-account-service", "ovis-account-service"].map((name) => document.querySelector(`meta[name="${name}"]`) !== null)),
    [true, false], "this PC's own page has the PC's account service meta alone");
  await reachable.getByRole("button", { name: "Add p23pcb", exact: true }).click();
  const addPc = connecting.page.locator("dialog.machine-dialog[open]");
  await addPc.waitFor();
  assert.equal(await addPc.getByRole("textbox", { name: "SSH alias or user@address", exact: true }).inputValue(), "p23pcb", "Add PC opens for that host");
  const toAccount = addPc.getByRole("checkbox", { name: "Add it to my account", exact: true });
  await toAccount.waitFor();
  assert.equal(await toAccount.isChecked(), true, "Add it to my account, ticked");
  await shot(connecting.page, "add-pc-from-row");

  // the same account in a window that is not this PC's own: the tab as before (the account QR code alone), no PCs to add
  const elsewhere = await accountWindow(browser, pageErrors, "elsewhere");
  const theirs = await openRelayTab(elsewhere.page);
  await theirs.getByText("This PC is in your account.", { exact: true }).waitFor();
  await theirs.getByRole("img", { name: "QR code that opens this PC in the Ovis app", exact: true }).waitFor();
  assert.equal(await theirs.getByRole("img", { name: "QR code that pairs a phone through the relay", exact: true }).count(), 0, "another window gets no relay pairing QR code");
  assert.equal(await theirs.locator(".connect-reachable").count(), 0, "nor the PCs to add over SSH");
  await elsewhere.context.close();

  for (const relation of ["other", "signed-out"] as const) {
    const { page } = await accountWindow(browser, pageErrors, relation);
    // a window signed out of this PC's account gets the sign-in alone, not the Add from account prompt
    const tab = await openRelayTab(page, "Sign in to Ovis");
    assert.equal(await tab.locator(".connect-reachable").count(), 0, `${relation}: no PCs to add over SSH`);
    if (relation === "signed-out") {
      // the sign-in alone: no line above it, no Add from account prompt beside it
      assert.equal(await tab.getByTestId("connect-signin").locator("p.settings-description, p.settings-hint").count(), 0);
      assert.equal(await tab.getByRole("button", { name: "Add from account", exact: true }).count(), 0);
      const signIn = tab.getByTestId("connect-signin");
      const first = signIn.getByRole("button").first();
      await first.waitFor();
      assert.equal(await first.isEnabled(), true);
      // signing in on this PC, already in that account, leaves nothing to add: Add a connection closes, and Settings stays
      // on Devices and PCs with the account and its PCs
      const settings = page.locator(".settings-dialog");
      const awayInSettings = settings.locator(".my-pcs .devices-row .settings-label").filter({ hasText: /^Away/ });
      assert.equal(await awayInSettings.count(), 0, "signed out, Settings lists no PC of the account");
      const linkPage = page.context().waitForEvent("page");
      await signIn.getByRole("button", { name: "Sign in to Ovis", exact: true }).click();
      await linkPage;
      const userCode = await tab.getByTestId("relay-signin-waiting").locator("output").textContent();
      assert.ok(userCode, "the sign-in shows its code");
      service.approveOnLinkPage(userCode, ACCOUNT, "github");
      await page.locator(".connect-phone-dialog").waitFor({ state: "detached" });
      await settings.locator('[data-section="account"]').getByRole("button", { name: "Sign out of GitHub", exact: true }).waitFor();
      await awayInSettings.waitFor();
      assert.equal(await settings.locator('[data-section="devices"]').getByRole("button", { name: "Add a connection", exact: true }).isVisible(), true, "Settings is still on Devices and PCs");
      await shot(page, "signed-in-settings");
    } else {
      // signed in to another account than this PC's (owner #25): the sign-in buttons alone, so the right one can be picked;
      // no Add from account, no line about the account, no paragraph to act on
      await tab.getByTestId("connect-signin").getByRole("button", { name: "Sign in to Ovis", exact: true }).waitFor();
      assert.equal(await tab.getByRole("button", { name: "Add from account", exact: true }).count(), 0);
      assert.equal(await tab.getByText(/Sign in to this PC's account\.|If that account is not yours|This PC is in an account\./).count(), 0);
      await shot(page, "other-account");
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
  console.log("PASS the account's PCs: the sidebar lists those not in this app yet with nothing opened, marks offline PCs and automatically asks a member to pair a ready PC; it opens in the sidebar with no SSH setup dialog; a sign-in on this PC, already in the account, closes Add a connection and leaves Settings open with the account and its PCs; Add a connection → Ovis relay, in this PC's own window signed in to its account, opens on the account QR code with its six digits only on a press, then the signed-in line and the PCs to add over SSH, with no list of the account's PCs; the same account in another window keeps the QR code that opens this PC, with no PCs to add");
} catch (error) {
  code = 1;
  console.error("FAIL relay account PCs:", error);
} finally {
  for (const close of cleanup.reverse()) {
    try { await close(); } catch {}
  }
}
process.exit(code);
