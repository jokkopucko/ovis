/**
 * Settings → Phone & devices: the Ovis relay, controlled only in the Connect a phone dialog, against a local Bun relay
 * (relay/bun.ts). The page has no relay group and no relay switch: the Connect a phone row says the
 * relay's state, and the dialog's relay card carries its one switch (with the gate note while off),
 * which turns it on and off; online, the relay route shows the QR code of a fresh offer with its
 * countdown, New code starts another code, a code the dialog's pairing code route starts refreshes
 * the offer, and the offer's code and that route's code are one and the same both ways (the server
 * keeps one pending code and the offer reuses it). Reset relay identity in the relay route asks
 * first (Escape there closes only the confirmation) and gives the PC a new server id. A Portal
 * visitor gets no switch and no reset; a failed start says why with Try again; a serve-only install
 * shows Blocked with no switch and no reset; a device paired through the relay wears the via relay
 * pill. The dialog opens on the relay whenever it is offered, except with the relay off and
 * Tailscale already serving the PC: then it opens on Tailscale. GET /api/access is pinned per
 * context, so what Tailscale does on the PC running this never changes the outcome. All on pages the PC serves: that the hosted shell's Settings has no relay
 * group is checked where the app really runs under the shell, in relay-shell-browser-qa.ts (a
 * page of the PC's own build given the shell's meta boots the shell, not the app). Imported by
 * ui-regression.ts; `startRelayFixture` also serves the manual QA script.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Browser, BrowserContext, Page } from "playwright-core";
import { startBunRelay } from "../relay/bun.ts";
import { createServer } from "../server/index.ts";
import { RelayService } from "../server/relay/service.ts";
import { UsageService } from "../server/usage.ts";
import type { PairedDevice, PairingCode, RelayStatus, RemoteAccess } from "../shared/protocol.ts";
import { decodeOffer } from "../shared/relay-offer.ts";
import { openSettingsPage } from "./settings-page.ts";

export interface RelayFixture {
  readonly origin: string;
  readonly relayPort: number;
  readonly stateDir: string;
  stop(): Promise<void>;
}

/** An Ovis server whose relay link reaches a local Bun relay: the advertised wss origin is dialled as the relay's plain ws port. */
export function startRelayFixture(options: { serveOnly?: boolean } = {}): RelayFixture {
  const relay = startBunRelay({ port: 0 });
  const stateDir = mkdtempSync(join(tmpdir(), "ovis-relay-panel-"));
  const service = new RelayService({
    stateDir,
    relay: `wss://127.0.0.1:${relay.port}`,
    connect: (url) => {
      const target = new URL(url);
      return new WebSocket(`ws://127.0.0.1:${relay.port}${target.pathname}${target.search}`);
    },
  });
  const server = createServer({
    port: 0, hostname: "127.0.0.1", stateDir, token: "", tailscaleOwner: null, sidecar: false,
    tailscaleServeOnly: options.serveOnly ?? false, relay: service, usage: new UsageService(undefined, []), registerBridge: false,
  });
  return {
    origin: `http://127.0.0.1:${server.port}`,
    relayPort: relay.port,
    stateDir,
    async stop() {
      await service.shutdown();
      server.stop();
      await relay.stop();
      rmSync(stateDir, { recursive: true, force: true });
    },
  };
}

/** What GET /api/access answers in a context: Tailscale missing (the relay's case), or serving the PC on a tailnet. */
const NO_TAILSCALE: RemoteAccess = { port: 0, tailscale: { state: "missing", dns_name: null, serving_url: null, serve_command: null, serve_url: null } };
const TAILNET: RemoteAccess = { port: 0, tailscale: { state: "running", dns_name: "pc.tail0000.ts.net", serving_url: "https://pc.tail0000.ts.net", serve_command: null, serve_url: null } };

const englishContext = async (browser: Browser, access: RemoteAccess = NO_TAILSCALE): Promise<BrowserContext> => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: "en-US" });
  await context.addInitScript(() => localStorage.setItem("ovis:settings", JSON.stringify({ language: "en" })));
  await context.route("**/api/access", (route) => route.fulfill({ json: access }));
  return context;
};

/** The page open on Settings → Phone & devices. */
export async function openPhoneSettings(page: Page, origin: string): Promise<void> {
  await page.goto(origin, { waitUntil: "domcontentloaded" });
  await page.locator(".conn-live").waitFor({ state: "attached" });
  await page.keyboard.press("ControlOrMeta+Shift+Comma");
  await openSettingsPage(page, "Phone & devices");
}

export async function checkRelayPanel(browser: Browser): Promise<void> {
  const fixtures: RelayFixture[] = [];
  const contexts: BrowserContext[] = [];
  const pageErrors: string[] = [];
  try {
    const fixture = startRelayFixture();
    fixtures.push(fixture);
    const relayState = async (): Promise<RelayStatus> => (await fetch(`${fixture.origin}/api/relay`)).json() as Promise<RelayStatus>;
    const context = await englishContext(browser);
    contexts.push(context);
    const page = await context.newPage();
    page.setDefaultTimeout(15_000);
    page.on("pageerror", (error) => pageErrors.push(error.message));
    await openPhoneSettings(page, fixture.origin);
    const dialog = page.locator(".settings-dialog");
    // the relay has no group of its own: its state is in the Connect a phone row, its controls in the dialog
    const phone = dialog.locator('[data-section="phone"]');
    const state = phone.locator(".relay-status");
    const connect = phone.getByRole("button", { name: "Connect", exact: true });
    const sheet = page.getByRole("dialog", { name: "Connect a phone", exact: true });
    const relayRoute = sheet.locator('[data-route="relay"]');
    const codeRoute = sheet.locator('[data-route="code"]');
    const toggle = sheet.getByRole("switch", { name: "Ovis relay", exact: true });
    const qr = relayRoute.getByRole("img", { name: "QR code that pairs a phone through the relay", exact: true });
    const offerAnswer = () => page.waitForResponse((response) => response.url().endsWith("/api/relay/offer") && response.request().method() === "POST");
    const closeSheet = async () => { await page.keyboard.press("Escape"); await sheet.waitFor({ state: "detached" }); };
    await state.filter({ hasText: "Ovis relay: Off." }).waitFor();
    assert.equal(await dialog.locator('[data-section="relay"]').count(), 0, "no separate relay group");
    assert.equal(await dialog.getByRole("switch", { name: "Ovis relay", exact: true }).count(), 0, "the settings page has no relay switch of its own");
    assert.equal(await dialog.getByRole("img").count(), 0, "the settings page itself shows no QR code");
    assert.equal((await relayState()).phase, "off");
    // off with no Tailscale, the dialog opens on the relay, whose card carries the relay's one switch
    await connect.click();
    const relayChoice = sheet.getByRole("button", { name: "Ovis relay", exact: true });
    await relayChoice.waitFor();
    assert.equal(await relayChoice.getAttribute("aria-pressed"), "true", "with no Tailscale the dialog opens on the relay, even while it is off");
    assert.equal(await relayRoute.isVisible(), true, "the relay's details are the ones shown");
    assert.equal(await page.getByRole("switch", { name: "Ovis relay", exact: true }).count(), 1, "the relay's switch exists once, on its card in the dialog");
    assert.equal(await toggle.getAttribute("aria-checked"), "false", "the relay starts off");
    assert.equal(await relayRoute.getByRole("button", { name: "Turn on the relay", exact: true }).count(), 0, "one way to turn it on: the switch");
    assert.equal(await sheet.getByTestId("relay-owner-help").count(), 0, "the direct owner needs no relay restriction explanation");
    const closesGate = sheet.getByText("Turning on the relay closes the device gate: a new browser then needs a pairing code or the access token.", { exact: true });
    assert.equal(await closesGate.isVisible(), true, "with no token and nothing paired, the switch says turning the relay on closes the gate");
    assert.equal(await page.getByText("A paired device gets in on its own until you revoke it here.").count(), 1, "the paired-device line is said once, in Devices");
    assert.equal(await qr.count(), 0, "no offer while the relay is off");

    // on: the server connects to the local relay, the dialog's offer comes by itself, and the row says so
    const firstOffer = offerAnswer();
    await toggle.click();
    await relayRoute.locator(".relay-status").filter({ hasText: "Online. No phone connected." }).waitFor();
    assert.equal(await toggle.getAttribute("aria-checked"), "true", "the switch shows the relay on");
    assert.equal((await relayState()).phase, "online", "the server's relay link is online");
    await closesGate.waitFor({ state: "detached" });
    await state.filter({ hasText: "Ovis relay: Online. No phone connected." }).waitFor();
    await qr.waitFor();
    const offered = decodeOffer(((await (await firstOffer).json()) as { url: string }).url);
    assert.ok(offered !== null, "the QR code is a pairing offer");
    assert.equal(offered.relay, `wss://127.0.0.1:${fixture.relayPort}`, "the offer names the relay the server uses");
    assert.match(offered.code ?? "", /^\d{6}$/, "the offer carries a one-time pairing code");
    await relayRoute.getByText(/Expires in \d+:\d\d\./).waitFor();

    // New code: a new pairing code first (one POST pair/start), then an offer carrying that very code. Codes
    // are six random digits, so two of them are never asserted different: the offer is matched to the code
    // the server just answered, which is deterministic.
    const pairStart = () => page.waitForResponse((response) => response.url().endsWith("/api/devices/pair/start") && response.request().method() === "POST");
    const offerCode = async (answer: Promise<Response>) => {
      const offer = decodeOffer(((await (await answer).json()) as { url: string }).url);
      assert.ok(offer !== null && offer.code !== undefined, "the offer carries a pairing code");
      return offer.code;
    };
    const startedCode = async (answer: Promise<Response>) => {
      const response = await answer;
      assert.equal(response.status(), 200, "the pairing code was started");
      return ((await response.json()) as PairingCode).code;
    };
    const renewedCode = pairStart();
    const secondOffer = offerAnswer();
    await relayRoute.getByRole("button", { name: "New code", exact: true }).click();
    const renewed = await startedCode(renewedCode);
    assert.equal(await offerCode(secondOffer), renewed, "New code's offer carries the code it started");

    // the pairing code route already shows that one pending code; a code it starts itself makes the relay route
    // ask for its offer again, which carries the very code the pairing code route shows
    const shownCode = async () => (await codeRoute.locator(".devices-code").innerText()).replace(/\s+/g, "");
    await sheet.getByRole("button", { name: "Pairing code", exact: true }).click();
    await codeRoute.locator(".devices-code").waitFor();
    assert.equal(await shownCode(), renewed, "the pairing code route shows the code the relay route's New code started");
    const codeStart = pairStart();
    const resynced = offerAnswer();
    await codeRoute.getByRole("button", { name: "New code", exact: true }).click();
    const codeStarted = await startedCode(codeStart);
    assert.equal(await offerCode(resynced), codeStarted, "a code the pairing code route started refreshes the relay offer with that code");
    assert.equal(await shownCode(), codeStarted, "the relay QR carries the code the pairing code route shows");

    // New code on the relay route while the code route holds one: the code route follows it, so they stay equal
    await sheet.getByRole("button", { name: "Ovis relay", exact: true }).click();
    await qr.waitFor();
    const followedStart = pairStart();
    const followedOffer = offerAnswer();
    await relayRoute.getByRole("button", { name: "New code", exact: true }).click();
    const followed = await startedCode(followedStart);
    assert.equal(await offerCode(followedOffer), followed, "the relay QR carries the code New code started");
    await page.waitForFunction(([selector, code]) => document.querySelector(selector)?.textContent?.replace(/\s+/g, "") === code, ['[data-route="code"] .devices-code', followed] as const);
    assert.equal(await shownCode(), followed, "after New code the pairing code route shows the same code as the relay QR");
    await qr.waitFor();

    // the identity reset, a quiet last action of the relay's details, asks first: Escape and Cancel change nothing
    // (Escape leaves the dialog under it open), Reset gives the PC a new server id, and the next offer carries it
    const reset = relayRoute.getByRole("button", { name: "Reset relay identity", exact: true });
    const confirm = page.getByRole("alertdialog", { name: "Reset the relay identity?", exact: true });
    await reset.click();
    await confirm.getByText("Phones paired through the relay will need to scan a new code.", { exact: true }).waitFor();
    await page.keyboard.press("Escape");
    await confirm.waitFor({ state: "detached" });
    assert.equal(await sheet.isVisible(), true, "Escape on the confirmation closes it, not the dialog under it");
    await reset.click();
    await confirm.getByRole("button", { name: "Cancel", exact: true }).click();
    await confirm.waitFor({ state: "detached" });
    await reset.click();
    await confirm.getByRole("button", { name: "Reset", exact: true }).click();
    await confirm.waitFor({ state: "detached" });
    await closeSheet();
    await state.filter({ hasText: "Online. No phone connected." }).waitFor();
    const afterReset = offerAnswer();
    await connect.click();
    await sheet.getByRole("button", { name: "Ovis relay", exact: true }).click();
    const rotated = decodeOffer(((await (await afterReset).json()) as { url: string }).url);
    assert.ok(rotated !== null && rotated.server_id !== offered.server_id, "the reset gives the PC a new relay identity");
    assert.notEqual(rotated.server_public_key, offered.server_public_key);
    await qr.waitFor();
    await closeSheet();
    // a phone pairs with the code of a fresh page's first offer, the one the server made with no code started on
    // the page: the page watches that code too, so the dialog closes and the Devices group names the phone
    await openPhoneSettings(page, fixture.origin);
    await state.filter({ hasText: "Online. No phone connected." }).waitFor();
    const firstOfPage = offerAnswer();
    await connect.click();
    await sheet.getByRole("button", { name: "Ovis relay", exact: true }).click();
    const pageOffer = decodeOffer(((await (await firstOfPage).json()) as { url: string }).url);
    assert.ok(pageOffer !== null && pageOffer.code !== undefined, "the fresh page's offer carries a pairing code");
    await qr.waitFor();
    const relayPaired = await fetch(`${fixture.origin}/api/devices/pair`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-herdr-machine": "1", origin: fixture.origin },
      body: JSON.stringify({ code: pageOffer.code, label: "Relay phone" }),
    });
    assert.equal(relayPaired.status, 204, "the phone paired with the offer's code");
    await sheet.waitFor({ state: "detached" });
    await dialog.locator('[data-section="devices"]').getByText("Paired: Relay phone.", { exact: true }).waitFor();
    await state.filter({ hasText: "Online." }).waitFor();

    // Even a Portal visitor with a saved drive role cannot control the relay (owner_only).
    const visitorContext = await englishContext(browser);
    contexts.push(visitorContext);
    const visitor = await visitorContext.newPage();
    await visitor.route("**/api/health*", async (route) => {
      const response = await route.fetch();
      const body = await response.json() as { auth: Record<string, unknown> };
      await route.fulfill({ response, json: { ...body, auth: { ...body.auth, via: "portal", role: "drive" } } });
    });
    const visitorMutations: string[] = [];
    await visitor.route("**/api/relay/**", (route) => {
      if (route.request().method() !== "POST") return route.continue();
      visitorMutations.push(new URL(route.request().url()).pathname);
      return route.fulfill({ status: 403, json: { error: { code: "owner_only", message: "Use the access token or a paired device." } } });
    });
    await openPhoneSettings(visitor, fixture.origin);
    const visitorPhone = visitor.locator('.settings-dialog [data-section="phone"]');
    await visitorPhone.locator(".relay-status").filter({ hasText: "Online." }).waitFor();
    // the visitor's dialog: the relay route reads with the reason it cannot control the relay, offers nothing,
    // has no switch and no reset, and there is no pairing code route
    await visitorPhone.getByRole("button", { name: "Connect", exact: true }).click();
    const visitorSheet = visitor.getByRole("dialog", { name: "Connect a phone", exact: true });
    await visitorSheet.getByRole("button", { name: "Ovis relay", exact: true }).click();
    await visitorSheet.locator('[data-route="relay"] .relay-status').filter({ hasText: "Online." }).waitFor();
    const visitorHelp = visitorSheet.getByTestId("relay-owner-help");
    assert.equal(await visitorHelp.isVisible(), true, "the Portal restriction explains itself in the relay's details");
    assert.ok((await visitorHelp.innerText()).trim().length > 0, "the explanation is not empty");
    assert.equal(await visitor.getByRole("switch", { name: "Ovis relay", exact: true }).count(), 0, "a Portal visitor gets no relay switch");
    assert.equal(await visitorSheet.getByRole("button", { name: "Reset relay identity", exact: true }).count(), 0, "nor the reset");
    assert.equal(await visitorSheet.locator('[data-route="relay"]').getByRole("img").count(), 0, "a Portal visitor is shown no pairing offer");
    assert.equal(await visitorSheet.getByRole("button", { name: "Pairing code", exact: true }).count(), 0, "a Portal visitor is offered no pairing code");
    assert.deepEqual(visitorMutations, [], "a Portal visitor never requests an owner-only relay mutation");
    await visitorContext.close();

    // off: the offer goes with the connection, and the row says so
    await connect.click();
    await sheet.getByRole("button", { name: "Ovis relay", exact: true }).click();
    await toggle.click();
    await relayRoute.locator(".relay-status").filter({ hasText: "Off." }).waitFor();
    assert.equal(await toggle.getAttribute("aria-checked"), "false", "the switch shows the relay off");
    assert.equal((await relayState()).phase, "off", "the server's relay link is off");
    await qr.waitFor({ state: "detached" });
    assert.equal(await relayRoute.getByRole("button", { name: "New code", exact: true }).count(), 0, "no New code while the relay is off");
    await closeSheet();

    // on a tailnet with the relay off, the dialog opens on Tailscale, and the relay's choice carries its own switch:
    // it turns the relay on right there and shows the relay's QR code; on, the next opening is on the relay
    // its own server: the gate is still open there (the phone paired above closed this one's), so the note shows
    const tailnetFixture = startRelayFixture();
    fixtures.push(tailnetFixture);
    const tailnetRelay = async (): Promise<RelayStatus> => (await fetch(`${tailnetFixture.origin}/api/relay`)).json() as Promise<RelayStatus>;
    const tailnetContext = await englishContext(browser, TAILNET);
    contexts.push(tailnetContext);
    const tailnet = await tailnetContext.newPage();
    tailnet.setDefaultTimeout(15_000);
    tailnet.on("pageerror", (error) => pageErrors.push(error.message));
    await openPhoneSettings(tailnet, tailnetFixture.origin);
    const tailnetDialog = tailnet.locator(".settings-dialog");
    await tailnetDialog.locator('[data-section="phone"] .relay-status').filter({ hasText: "Off." }).waitFor();
    const tailnetSummary = tailnetDialog.locator(".connect-phone-summary");
    await tailnetSummary.filter({ hasText: "Ready at https://pc.tail0000.ts.net." }).waitFor();
    assert.match(await tailnetSummary.innerText(), /Ovis relay/, "the settings row names the relay beside the Tailscale address");
    const tailnetConnect = tailnetDialog.locator('[data-section="phone"]').getByRole("button", { name: "Connect", exact: true });
    const tailnetSheet = tailnet.getByRole("dialog", { name: "Connect a phone", exact: true });
    await tailnetConnect.click();
    const tailscaleChoice = tailnetSheet.getByRole("button", { name: "Tailscale", exact: true });
    await tailscaleChoice.waitFor();
    assert.equal(await tailscaleChoice.getAttribute("aria-pressed"), "true", "Tailscale already working and the relay off, the dialog opens on Tailscale");
    const inlineSwitch = tailnetSheet.getByRole("switch", { name: "Ovis relay", exact: true });
    assert.equal(await inlineSwitch.getAttribute("aria-checked"), "false", "the relay's choice carries its switch, off");
    assert.equal(await tailnetSheet.getByText("Turning on the relay closes the device gate: a new browser then needs a pairing code or the access token.", { exact: true }).isVisible(), true,
      "the switch keeps the gate note beside it");
    const tailnetRelayRoute = tailnetSheet.locator('[data-route="relay"]');
    assert.equal(await tailnetRelayRoute.getByRole("button", { name: "Turn on the relay", exact: true }).count(), 0, "one way to turn it on: the switch");
    assert.equal((await tailnetRelay()).phase, "off", "opening the dialog turns nothing on");
    await inlineSwitch.click();
    await tailnetRelayRoute.locator(".relay-status").filter({ hasText: "Online. No phone connected." }).waitFor();
    assert.equal((await tailnetRelay()).phase, "online", "the inline switch turned the server's relay on");
    assert.equal(await inlineSwitch.getAttribute("aria-checked"), "true");
    assert.equal(await tailnetSheet.getByRole("button", { name: "Ovis relay", exact: true }).getAttribute("aria-pressed"), "true", "turned on, the dialog shows the relay's details");
    await tailnetRelayRoute.getByRole("img", { name: "QR code that pairs a phone through the relay", exact: true }).waitFor();
    await tailnet.keyboard.press("Escape");
    await tailnetSheet.waitFor({ state: "detached" });
    await tailnetSummary.filter({ hasText: "Ready through the Ovis relay." }).waitFor();
    await tailnetConnect.click();
    const reopened = tailnetSheet.getByRole("button", { name: "Ovis relay", exact: true });
    await reopened.waitFor();
    assert.equal(await reopened.getAttribute("aria-pressed"), "true", "with the relay on, the dialog opens on it even on a tailnet");
    await inlineSwitch.click();
    await tailnetRelayRoute.locator(".relay-status").filter({ hasText: "Off." }).waitFor();
    assert.equal((await tailnetRelay()).phase, "off", "the inline switch turns the relay off too");
    await tailnet.keyboard.press("Escape");
    await tailnetSheet.waitFor({ state: "detached" });
    await tailnetContext.close();

    // a dialog opened before /api/access answers follows the default as the answer arrives: on the relay while
    // Tailscale is not known to work, then on Tailscale once it is (the relay off), with no pick made in between
    const lateContext = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: "en-US" });
    contexts.push(lateContext);
    await lateContext.addInitScript(() => localStorage.setItem("ovis:settings", JSON.stringify({ language: "en" })));
    let releaseAccess: () => void = () => {};
    const accessHeld = new Promise<void>((resolve) => { releaseAccess = resolve; });
    await lateContext.route("**/api/access", async (route) => { await accessHeld; await route.fulfill({ json: TAILNET }); });
    const late = await lateContext.newPage();
    late.setDefaultTimeout(15_000);
    late.on("pageerror", (error) => pageErrors.push(error.message));
    await openPhoneSettings(late, tailnetFixture.origin);
    const lateDialog = late.locator(".settings-dialog");
    await lateDialog.locator('[data-section="phone"] .relay-status').filter({ hasText: "Off." }).waitFor();
    await lateDialog.locator('[data-section="phone"]').getByRole("button", { name: "Connect", exact: true }).click();
    const lateSheet = late.getByRole("dialog", { name: "Connect a phone", exact: true });
    const lateRelay = lateSheet.getByRole("button", { name: "Ovis relay", exact: true });
    await lateRelay.waitFor();
    assert.equal(await lateRelay.getAttribute("aria-pressed"), "true", "Tailscale not yet known, the dialog opens on the relay");
    releaseAccess();
    await lateSheet.locator('button[aria-pressed="true"]', { hasText: "Tailscale" }).waitFor();
    assert.equal(await lateRelay.getAttribute("aria-pressed"), "false", "once Tailscale is found to work with the relay off, the dialog moves to Tailscale");
    await lateSheet.getByRole("switch", { name: "Ovis relay", exact: true }).waitFor();
    await late.keyboard.press("Escape");
    await lateSheet.waitFor({ state: "detached" });
    await lateContext.close();

    // a device paired through the relay wears the pill: the Devices group of the PC's page lists one (the
    // real pairing of a phone through the relay is relay-shell-browser-qa.ts's)
    const paired: PairedDevice = { id: "0123456789abcdef", label: "Pixel 9", role: "drive", created_at: new Date().toISOString(), last_seen_at: null, current: false, via_relay: true };
    await page.route("**/api/devices", (route) => route.request().method() === "GET" ? route.fulfill({ json: { devices: [paired] } }) : route.continue());
    await openPhoneSettings(page, fixture.origin);
    const row = page.locator(".devices-row").filter({ hasText: "Pixel 9" });
    await row.locator(".devices-via-relay", { hasText: "via relay" }).waitFor();

    // a start that fails before the link exists (the saved choice cannot be written): the switch stays off,
    // the reason shows, and Try again starts it once the cause is gone
    const unwritable = startRelayFixture();
    fixtures.push(unwritable);
    const savedChoice = join(unwritable.stateDir, "relay", "state.json");
    mkdirSync(savedChoice, { recursive: true });
    const failedContext = await englishContext(browser);
    contexts.push(failedContext);
    const failedPage = await failedContext.newPage();
    failedPage.setDefaultTimeout(15_000);
    failedPage.on("pageerror", (error) => pageErrors.push(error.message));
    await openPhoneSettings(failedPage, unwritable.origin);
    await failedPage.locator('.settings-dialog [data-section="phone"]').getByRole("button", { name: "Connect", exact: true }).click();
    const failedSheet = failedPage.getByRole("dialog", { name: "Connect a phone", exact: true });
    const failedRoute = failedSheet.locator('[data-route="relay"]');
    const failedToggle = failedSheet.getByRole("switch", { name: "Ovis relay", exact: true });
    await failedToggle.click();
    await failedRoute.getByRole("alert").filter({ hasText: "The relay did not start: Could not start the relay." }).waitFor();
    assert.equal(await failedToggle.getAttribute("aria-checked"), "false", "a start that failed leaves the switch off");
    await failedRoute.locator(".relay-status").filter({ hasText: "Off." }).waitFor();
    rmSync(savedChoice, { recursive: true });
    await failedRoute.getByRole("button", { name: "Try again", exact: true }).click();
    await failedRoute.locator(".relay-status").filter({ hasText: "Online." }).waitFor();
    assert.equal(await failedToggle.getAttribute("aria-checked"), "true", "Try again turned the relay on");
    assert.equal(await failedRoute.getByRole("button", { name: "Try again", exact: true }).count(), 0, "no retry once it runs");

    // serve-only: no switch anywhere, the reason in the row and in the relay's details, and no reset
    const serveOnly = startRelayFixture({ serveOnly: true });
    fixtures.push(serveOnly);
    const blockedContext = await englishContext(browser);
    contexts.push(blockedContext);
    const blockedPage = await blockedContext.newPage();
    blockedPage.setDefaultTimeout(15_000);
    blockedPage.on("pageerror", (error) => pageErrors.push(error.message));
    await openPhoneSettings(blockedPage, serveOnly.origin);
    const blockedPhone = blockedPage.locator('.settings-dialog [data-section="phone"]');
    await blockedPhone.locator(".relay-status").filter({ hasText: "Ovis relay: Blocked: OVIS_TAILSCALE_SERVE_ONLY" }).waitFor();
    await blockedPhone.getByRole("button", { name: "Connect", exact: true }).click();
    const blockedSheet = blockedPage.getByRole("dialog", { name: "Connect a phone", exact: true });
    await blockedSheet.getByRole("button", { name: "Ovis relay", exact: true }).click();
    const blockedRoute = blockedSheet.locator('[data-route="relay"]');
    await blockedRoute.locator(".relay-status").filter({ hasText: "Blocked: OVIS_TAILSCALE_SERVE_ONLY" }).waitFor();
    assert.equal(await blockedPage.getByRole("switch", { name: "Ovis relay", exact: true }).count(), 0, "a serve-only install shows no relay switch");
    assert.equal(await blockedRoute.getByRole("img").count(), 0, "no offer on a blocked install");
    assert.equal(await blockedRoute.getByRole("button", { name: "Reset relay identity", exact: true }).count(), 0, "a serve-only install is offered no reset, which it would refuse");
    assert.equal(await blockedSheet.locator(".connect-phone-gate").count(), 0, "a relay that cannot be turned on carries no note about turning it on");
    assert.deepEqual(pageErrors, [], "the relay panel raises no page error");
    console.log("PASS the relay panel turns the relay on and off, offers a QR code and resets the identity; a relay-paired device wears the pill and serve-only blocks the switch");
  } finally {
    for (const context of contexts) await context.close();
    for (const fixture of fixtures) await fixture.stop();
  }
}
