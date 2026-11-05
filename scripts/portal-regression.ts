import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";

import "./test-herdr.ts"; // check run gives the server its own herdr session, not the user's
import { DEVICE_COOKIE } from "../server/auth.ts";
import { createServer, type ServerInstance } from "../server/index.ts";
import { PortalService } from "../server/portal.ts";
import { UsageService } from "../server/usage.ts";
import type { PortalStatus, RemoteAccess } from "../shared/protocol.ts";
import { openSettingsPage } from "./settings-page.ts";

const dist = join(import.meta.dir, "..", "dist", "index.html");
assert.ok(existsSync(dist), "dist/index.html is missing: run `bun run build` first");

const root = mkdtempSync(join(tmpdir(), "herdr-portal-browser-"));
const portalBin = join(root, "portal");
const portalAddress = "https://herdr-portal-test-0123.relay.example";
const token = "portal-browser-test-token";
const watchToken = randomBytes(32).toString("hex");
const relayRequests: string[] = [];
/** every `portal expose` the stand-in ran writes its pid here: a relaunch adds one, a third never comes */
const exposeLog = join(root, "expose.log");
const exposed = (): number[] => existsSync(exposeLog) ? readFileSync(exposeLog, "utf8").trim().split("\n").map(Number) : [];
/** the relay question a relaunch asks waits here, so every device can be seen recovering */
let relayHold: { asked: () => void; released: Promise<void> } | null = null;
/** lets a held relay question go; the cleanup calls it too, so a failed run never leaves it waiting */
let releaseRelay: (() => void) | undefined;
/** the event, or a failure naming it once `ms` pass without it */
const within = <T>(event: Promise<T>, ms: number, what: string): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`no ${what} within ${ms} ms`)), ms); });
  return Promise.race([event, deadline]).finally(() => clearTimeout(timer));
};
const relayFetch: typeof fetch = async (input) => {
  const url = input instanceof Request ? input.url : String(input);
  relayRequests.push(url);
  const hold = relayHold;
  relayHold = null;
  if (hold !== null) {
    hold.asked();
    await hold.released;
  }
  if (url === "https://unavailable.relay.example/sdk/domain") return new Response(null, { status: 503 });
  if (url !== "https://relay.example/sdk/domain") throw new Error(`Unexpected Portal fixture request: ${url}`);
  return Response.json({ data: { release_version: "v2.6.1" } });
};
const remoteAccess = {
  port: 443,
  tailscale: { state: "missing", dns_name: null, serving_url: null, serve_command: null, serve_url: null },
} satisfies RemoteAccess;
const portalFetchPage = async (context: BrowserContext): Promise<void> => {
  await context.route("**/api/access", (route) => route.fulfill({ json: remoteAccess }));
};
const openPhoneSettings = async (page: Page): Promise<void> => {
  await page.keyboard.press("ControlOrMeta+Shift+Comma");
  await page.locator(".settings-dialog").waitFor({ timeout: 10_000 });
  await openSettingsPage(page, "Phone & devices");
};
const settingsOf = (page: Page) => page.locator(".settings-dialog");
const reopenPhoneSettings = async (page: Page): Promise<void> => {
  await settingsOf(page).getByRole("button", { name: "Close settings", exact: true }).click();
  await settingsOf(page).waitFor({ state: "detached", timeout: 10_000 });
  await openPhoneSettings(page);
};

const servers: ServerInstance[] = [];
const portals: PortalService[] = [];
const contexts: BrowserContext[] = [];
let browser: Browser | undefined;

try {
  writeFileSync(portalBin, [
    "#!/bin/sh",
    'case "$1" in',
    "  version) printf '%s\\n' 'v2.6.1' ;;",
    "  expose)",
    // the status asks which sign-ins this Portal offers: that is a question, not a service
    "    [ \"$2\" = --help ] && exit 0",
    "    trap 'exit 0' TERM",
    // the stand-in's way to end on its own, as a crashed Portal would
    "    trap 'exit 3' USR1",
    // Portal writes its identity file before it serves; a relaunch requires it unchanged
    "    id=''; previous=''; for arg in \"$@\"; do [ \"$previous\" = --identity-path ] && id=\"$arg\"; previous=\"$arg\"; done",
    "    [ -f \"$id\" ] || echo '{\"fixture\":true}' > \"$id\"",
    `    echo $$ >> '${exposeLog}'`,
    `    printf '%s\\n' 'INF service ready at ${portalAddress}:443'`,
    "    while :; do sleep 0.05; done ;;",
    "  *) exit 2 ;;",
    "esac",
    "",
  ].join("\n"), { mode: 0o700 });
  chmodSync(portalBin, 0o755);

  const stateDir = join(root, "token-server");
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, "devices.json"), JSON.stringify({
    gate_closed_at: new Date().toISOString(),
    devices: [{
      id: "0123456789abcdef",
      label: "Portal watch fixture",
      role: "watch",
      token_hash: createHash("sha256").update(watchToken).digest("hex"),
      created_at: new Date().toISOString(),
      last_seen_at: null,
    }],
  }), { mode: 0o600 });
  const portal = new PortalService({ stateDir, bin: portalBin, fetch: relayFetch, readyTimeoutMs: 5_000, stopGraceMs: 1_000 });
  portals.push(portal);
  const server = createServer({
    port: 0,
    hostname: "127.0.0.1",
    stateDir,
    token,
    tailscaleOwner: null,
    tailscaleServeOnly: false,
    portal,
    usage: new UsageService(undefined, []),
    registerBridge: false,
  });
  servers.push(server);
  const origin = `http://127.0.0.1:${server.port}`;

  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? chromium.executablePath(), headless: true, args: ["--no-sandbox"] });
  const ownerContext = await browser.newContext({ viewport: { width: 1100, height: 800 }, locale: "en-US" });
  contexts.push(ownerContext);
  await ownerContext.addInitScript(() => localStorage.setItem("ovis:settings", JSON.stringify({ language: "en" })));
  await portalFetchPage(ownerContext);
  const ownerPage = await ownerContext.newPage();
  ownerPage.setDefaultTimeout(10_000);
  const pageErrors: string[] = [];
  ownerPage.on("pageerror", (error) => pageErrors.push(error.message));
  await ownerPage.goto(origin, { waitUntil: "domcontentloaded" });
  await ownerPage.getByTestId("token-gate").waitFor({ timeout: 10_000 });
  assert.equal(await ownerPage.evaluate(async () => (await fetch("/api/portal")).status), 401, "Portal status is gated until token login");
  await ownerPage.getByText("Have an access token instead?", { exact: true }).click();
  await ownerPage.getByLabel("Access token", { exact: true }).fill(token);
  await ownerPage.getByRole("button", { name: "Unlock", exact: true }).click();
  await ownerPage.locator(".conn-live").waitFor({ state: "attached", timeout: 15_000 });
  const ownerAuth = await ownerPage.evaluate(async () => (await (await fetch("/api/health?scope=bridge")).json()).auth);
  assert.deepEqual(ownerAuth, { required: false, authenticated: true, via: "token", role: "drive" }, "the UI token login receives the owner role");

  await openPhoneSettings(ownerPage);
  const ownerSettings = settingsOf(ownerPage);
  const ownerRelay = ownerSettings.locator("#portal-relay");
  const start = ownerSettings.getByRole("button", { name: "Start", exact: true });
  await ownerRelay.waitFor({ timeout: 10_000 });
  assert.equal(await start.isDisabled(), true, "Start is disabled until a relay is entered");
  await ownerRelay.fill("relay.example");
  assert.equal(await start.isEnabled(), true, "a supported, usable Portal offers Start");
  await start.click();
  const address = ownerSettings.getByRole("link", { name: portalAddress, exact: true });
  await address.waitFor({ timeout: 15_000 });
  assert.equal(await address.getAttribute("href"), portalAddress, "the ready address is shown as the public link");
  assert.deepEqual(relayRequests, ["https://relay.example/sdk/domain"], "only the synthetic relay was checked");

  const watchContext = await browser.newContext({ viewport: { width: 1100, height: 800 }, locale: "en-US" });
  contexts.push(watchContext);
  await watchContext.addInitScript(() => localStorage.setItem("ovis:settings", JSON.stringify({ language: "en" })));
  await watchContext.addCookies([{ name: DEVICE_COOKIE, value: watchToken, url: origin, httpOnly: true, sameSite: "Strict" }]);
  await portalFetchPage(watchContext);
  const watchPage = await watchContext.newPage();
  watchPage.setDefaultTimeout(10_000);
  watchPage.on("pageerror", (error) => pageErrors.push(error.message));
  await watchPage.goto(origin, { waitUntil: "domcontentloaded" });
  await watchPage.locator(".conn-live").waitFor({ state: "attached", timeout: 15_000 });
  const watchAuth = await watchPage.evaluate(async () => (await (await fetch("/api/health?scope=bridge")).json()).auth);
  assert.deepEqual(watchAuth, { required: false, authenticated: true, via: "device", role: "watch" }, "the fixture cookie is authenticated as watch-only");
  await openPhoneSettings(watchPage);
  const watchSettings = settingsOf(watchPage);
  const watchStop = watchSettings.getByRole("button", { name: "Stop", exact: true });
  await watchStop.waitFor({ timeout: 10_000 });
  assert.equal(await watchStop.isDisabled(), true, "a watch-only device cannot stop a running Portal");

  // the serving Portal ends on its own: the server starts it again once, on the same relay and identity
  const savedPid = (): number => (JSON.parse(readFileSync(join(stateDir, "portal", "state.json"), "utf8")) as { pid: number }).pid;
  const crashed = savedPid();
  const relayAsked = new Promise<void>((asked) => {
    relayHold = { asked, released: new Promise<void>((release) => { releaseRelay = release; }) };
  });
  process.kill(crashed, "SIGUSR1");
  await within(relayAsked, 15_000, "relay question from the relaunch");
  // the panel follows a running Portal every 15 s: reopening asks at once
  await reopenPhoneSettings(ownerPage);
  await reopenPhoneSettings(watchPage);
  const ownerRecovering = settingsOf(ownerPage).getByRole("status").filter({ hasText: "Recovering…" });
  await ownerRecovering.waitFor({ timeout: 10_000 });
  assert.equal(await address.count(), 0, "a recovering Portal shows no address");
  assert.equal(await settingsOf(ownerPage).getByRole("button", { name: "Stop", exact: true }).isEnabled(), true, "the owner can stop a recovering Portal");
  assert.equal(await settingsOf(ownerPage).getByRole("button", { name: "Start", exact: true }).count(), 0, "a recovering Portal offers no Start");
  await settingsOf(watchPage).getByRole("status").filter({ hasText: "Recovering…" }).waitFor({ timeout: 10_000 });
  assert.equal(await settingsOf(watchPage).getByRole("button", { name: "Stop", exact: true }).isDisabled(), true, "a watch-only device cannot stop a recovering Portal");
  releaseRelay?.();
  const recoveredAddress = settingsOf(ownerPage).getByRole("link", { name: portalAddress, exact: true });
  await recoveredAddress.waitFor({ timeout: 15_000 });
  await ownerRecovering.waitFor({ state: "detached", timeout: 10_000 });
  const replacement = savedPid();
  assert.notEqual(replacement, crashed, "the replacement's pid is saved");
  assert.throws(() => process.kill(crashed, 0), "the crashed Portal is gone");
  assert.deepEqual(relayRequests, ["https://relay.example/sdk/domain", "https://relay.example/sdk/domain"], "the relaunch asked the same relay");
  assert.deepEqual(exposed(), [crashed, replacement], "one relaunch: two Portal processes for the operation");
  console.log("PASS Portal recovery: a serving Portal that ended on its own showed Recovering… on every device, then its address again");

  // the replacement ends on its own too: no third Portal, an error every device can read
  process.kill(replacement, "SIGUSR1");
  const phaseDeadline = Date.now() + 15_000;
  while ((await ownerPage.evaluate(async () => (await (await fetch("/api/portal")).json() as PortalStatus).phase)) !== "error") {
    if (Date.now() > phaseDeadline) throw new Error("the second exit did not turn into an error within 15 s");
    await Bun.sleep(50);
  }
  assert.throws(() => process.kill(replacement, 0), "the replacement is gone");
  assert.deepEqual(exposed(), [crashed, replacement], "a second exit starts no third Portal");
  assert.deepEqual(relayRequests, ["https://relay.example/sdk/domain", "https://relay.example/sdk/domain"], "a second exit asks no relay");
  await reopenPhoneSettings(watchPage);
  const watchError = settingsOf(watchPage).getByRole("alert").filter({ hasText: "Portal stopped on its own again after one restart (exit 3)." });
  await watchError.waitFor({ timeout: 10_000 });
  await settingsOf(watchPage).getByText("Portal's output", { exact: true }).click();
  assert.match(await settingsOf(watchPage).locator("pre.update-output").innerText(), /service ready at https:\/\/herdr-portal-test-0123\.relay\.example:443/, "the watch device reads Portal's own output");
  assert.equal(await settingsOf(watchPage).getByRole("button", { name: "Stop", exact: true }).isDisabled(), true, "a watch-only device cannot stop a failed Portal");
  assert.equal(await settingsOf(watchPage).getByRole("link", { name: portalAddress, exact: true }).count(), 0, "the watch device shows no address after the second exit");
  await reopenPhoneSettings(ownerPage);
  await settingsOf(ownerPage).getByRole("alert").filter({ hasText: "Portal stopped on its own again after one restart (exit 3)." }).waitFor({ timeout: 10_000 });
  assert.equal(await address.count(), 0, "the owner sees no address after the second exit");
  console.log("PASS Portal second exit: no third Portal; owner and watch devices read the error and its output, watch Stop disabled");

  await settingsOf(ownerPage).getByRole("button", { name: "Stop", exact: true }).click();
  await start.waitFor({ timeout: 10_000 });
  await reopenPhoneSettings(watchPage);
  const idleWatchSettings = settingsOf(watchPage);
  const watchRelay = idleWatchSettings.locator("#portal-relay");
  const watchStart = idleWatchSettings.getByRole("button", { name: "Start", exact: true });
  await watchRelay.waitFor({ timeout: 10_000 });
  assert.equal(await watchRelay.isDisabled(), true, "a watch-only device cannot edit the relay");
  assert.equal(await watchStart.isDisabled(), true, "a watch-only device cannot start Portal");

  const failingRelay = "unavailable.relay.example";
  await ownerRelay.fill(failingRelay);
  await start.click();
  const failure = ownerSettings.getByRole("alert").filter({ hasText: failingRelay });
  await failure.waitFor({ timeout: 10_000 });
  const stopAfterError = ownerSettings.getByRole("button", { name: "Stop", exact: true });
  await stopAfterError.waitFor({ timeout: 10_000 });
  assert.match(await failure.innerText(), /did not answer as a Portal relay \(HTTP 503\)/);
  await stopAfterError.click();
  await start.waitFor({ timeout: 10_000 });
  await failure.waitFor({ state: "detached", timeout: 10_000 });
  assert.equal(await start.isEnabled(), true, "Start is available again after stopping the failed Portal");
  const finalPhase = await ownerPage.evaluate(async () => (await (await fetch("/api/portal")).json()).phase);
  assert.equal(finalPhase, "idle", "Stop clears the failed Portal state");
  assert.equal(await ownerRelay.inputValue(), failingRelay, "the failed relay remains editable after stopping");
  assert.deepEqual(relayRequests, [
    "https://relay.example/sdk/domain",
    "https://relay.example/sdk/domain",
    "https://unavailable.relay.example/sdk/domain",
  ], "all relay checks use the injected fixture fetch");
  assert.deepEqual(pageErrors, [], "the Portal settings pages have no browser errors");
  console.log("PASS Portal browser flow: token login, ready/start/address/stop, error recovery, and watch-only controls");

  // Fixture answers: a recovering Portal on both devices, then the server unreachable mid-recovery,
  // then an older server with no Portal route. The browser never starts Portal on its own.
  const recoveringFixture = {
    supported: true, version: "v2.6.1", min_version: "v2.6.1", usable: true, phase: "recovering",
    relay: "https://relay.example", url: null, blocked: null, error: null, output: `INF service ready at ${portalAddress}:443`,
    auth: { method: "none", allow: [], issuer: null, client_id: null }, auth_methods: [], oidc_secret: false,
  } satisfies PortalStatus;
  let answer: "recovering" | "offline" | "older" = "recovering";
  const portalPosts: string[] = [];
  for (const context of [ownerContext, watchContext]) {
    await context.route("**/api/portal**", async (route) => {
      if (route.request().method() !== "GET") {
        portalPosts.push(new URL(route.request().url()).pathname);
        return route.fulfill({ status: 409, json: { error: { code: "portal_busy", message: "fixture" } } });
      }
      if (answer === "offline") return route.abort("internetdisconnected");
      if (answer === "older") return route.fulfill({ status: 404, json: { error: { code: "not_found", message: "Not found" } } });
      return route.fulfill({ json: recoveringFixture, headers: { "cache-control": "no-store" } });
    });
  }
  await reopenPhoneSettings(ownerPage);
  await reopenPhoneSettings(watchPage);
  for (const [page, who] of [[ownerPage, "owner"], [watchPage, "watch"]] as const) {
    const settings = settingsOf(page);
    await settings.getByRole("status").filter({ hasText: "Recovering…" }).waitFor({ timeout: 10_000 });
    assert.equal(await settings.getByRole("button", { name: "Stop", exact: true }).isEnabled(), who === "owner", `${who}: Stop follows the device's role while recovering`);
    assert.equal(await settings.getByRole("link", { name: portalAddress, exact: true }).count(), 0, `${who}: no address while recovering`);
  }
  // the server goes away mid-recovery: the last answer stays, and it has no address to present as live
  const offlinePoll = ownerPage.waitForEvent("requestfailed", { predicate: (request) => new URL(request.url()).pathname === "/api/portal", timeout: 10_000 });
  answer = "offline";
  await offlinePoll;
  const offlineSettings = settingsOf(ownerPage);
  await offlineSettings.getByRole("status").filter({ hasText: "Recovering…" }).waitFor({ timeout: 10_000 });
  assert.equal(await offlineSettings.getByRole("link", { name: portalAddress, exact: true }).count(), 0, "no cached address is shown while the server is unreachable");
  // an older server answers without the route: a freshly opened panel hides the section, and the rest of the page works
  answer = "older";
  for (const page of [ownerPage, watchPage]) {
    const asked = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/portal" && response.status() === 404, { timeout: 10_000 });
    await reopenPhoneSettings(page);
    await asked;
    const settings = settingsOf(page);
    await settings.getByRole("heading", { name: "Devices", exact: true }).waitFor({ timeout: 10_000 });
    assert.equal(await settings.getByRole("heading", { name: "Portal", exact: true }).count(), 0, "an older server's page has no Portal section");
    assert.equal(await settings.locator("#portal-relay").count(), 0, "an older server's page offers no relay");
  }
  assert.deepEqual(portalPosts, [], "the browser sent no Portal start or stop of its own");
  for (const context of [ownerContext, watchContext]) await context.unroute("**/api/portal**");
  assert.deepEqual(pageErrors, [], "the fixture Portal pages have no browser errors");
  console.log("PASS Portal recovering fixtures: owner Stop, watch-only disabled, offline mid-recovery without a stale address, older server hidden");

  // The invite's read-only bearer link still needs keyboard focus, using the global theme ring.
  const inviteFixture = {
    ...recoveringFixture, phase: "running", url: portalAddress,
    auth: { method: "credential", allow: [], issuer: null, client_id: null },
    auth_methods: ["credential"],
  } satisfies PortalStatus;
  await ownerContext.route("**/api/portal**", (route) => route.fulfill({
    json: route.request().method() === "POST"
      ? { redeem_url: `${portalAddress}/_portal/auth/login#credential=fixture-link` }
      : inviteFixture,
  }));
  await reopenPhoneSettings(ownerPage);
  await settingsOf(ownerPage).getByLabel("Link name", { exact: true }).fill("alice");
  await settingsOf(ownerPage).getByRole("button", { name: "Create link", exact: true }).click();
  const privateLink = settingsOf(ownerPage).getByRole("textbox", { name: "Private link for alice", exact: true });
  await privateLink.waitFor();
  for (const width of [390, 1440]) for (const theme of ["light", "dark"]) {
    await ownerPage.setViewportSize({ width, height: 900 });
    await ownerPage.evaluate((value) => { document.documentElement.dataset["theme"] = value; }, theme);
    await privateLink.focus();
    await ownerPage.keyboard.press("Shift+Tab");
    await ownerPage.keyboard.press("Tab");
    await privateLink.scrollIntoViewIfNeeded();
    const focus = await privateLink.evaluate((element) => {
      const style = getComputedStyle(element);
      return { active: document.activeElement === element, visible: element.matches(":focus-visible"), style: style.outlineStyle, width: Number.parseFloat(style.outlineWidth) };
    });
    assert.equal(focus.active && focus.visible, true, `${width}/${theme}: the private link is keyboard-focused`);
    assert.equal(focus.style, "solid", `${width}/${theme}: the private link retains its focus ring`);
    assert.ok(focus.width >= 2, `${width}/${theme}: the focus ring is visible`);
    const screenshots = process.env["PORTAL_SCREENSHOT_DIR"];
    if (screenshots) {
      mkdirSync(screenshots, { recursive: true });
      await ownerPage.screenshot({ path: join(screenshots, `portal-invite-${width}-${theme}.png`), animations: "disabled" });
    }
  }
  await ownerContext.unroute("**/api/portal**");
  console.log("PASS Portal private-link keyboard focus: visible theme ring at phone and desktop widths in light and dark");

  const blockedState = join(root, "no-token-server");
  mkdirSync(blockedState, { recursive: true });
  const blockedPortal = new PortalService({ stateDir: blockedState, bin: portalBin, fetch: relayFetch });
  portals.push(blockedPortal);
  const blockedServer = createServer({
    port: 0,
    hostname: "127.0.0.1",
    stateDir: blockedState,
    token: "",
    tailscaleOwner: null,
    tailscaleServeOnly: false,
    portal: blockedPortal,
    usage: new UsageService(undefined, []),
    registerBridge: false,
  });
  servers.push(blockedServer);
  const blockedContext = await browser.newContext({ viewport: { width: 1100, height: 800 }, locale: "en-US" });
  contexts.push(blockedContext);
  await blockedContext.addInitScript(() => localStorage.setItem("ovis:settings", JSON.stringify({ language: "en" })));
  await portalFetchPage(blockedContext);
  const blockedPage = await blockedContext.newPage();
  blockedPage.setDefaultTimeout(10_000);
  blockedPage.on("pageerror", (error) => pageErrors.push(error.message));
  await blockedPage.goto(`http://127.0.0.1:${blockedServer.port}`, { waitUntil: "domcontentloaded" });
  await blockedPage.locator(".conn-live").waitFor({ state: "attached", timeout: 15_000 });
  await openPhoneSettings(blockedPage);
  const blockedSettings = settingsOf(blockedPage);
  await blockedSettings.getByText("Set OVIS_TOKEN on this PC and restart the app to start Portal.", { exact: true }).waitFor({ timeout: 10_000 });
  assert.equal(await blockedSettings.getByRole("button", { name: "Start", exact: true }).count(), 0, "Portal Start is unavailable without a configured token");
  assert.deepEqual(pageErrors, [], "the token-required page has no browser errors");
  console.log("PASS Portal token-required UI: the relay cannot be started without a configured token");
} finally {
  releaseRelay?.();
  await Promise.all(contexts.map((context) => context.close().catch(() => undefined)));
  for (const server of servers) server.stop();
  await Promise.all(portals.map((portal) => portal.shutdown().catch(() => undefined)));
  await browser?.close().catch(() => undefined);
  rmSync(root, { recursive: true, force: true });
}
