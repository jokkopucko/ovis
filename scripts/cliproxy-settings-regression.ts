/** Account setup and hub OAuth against an isolated backend and deterministic provider fixture. */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser } from "playwright-core";
import { startFakeCLIProxy } from "../server/cliproxy.fake.ts";
import { CLIProxyService } from "../server/cliproxy.ts";
import { createServer } from "../server/index.ts";
import { USAGE_PROVIDERS, UsageService, type UsageContext } from "../server/usage.ts";
import { buildDemoApp } from "./demo-build.ts";
import { chromePath } from "./chrome-path.ts";
import { openSettingsPage } from "./settings-page.ts";

const dir = mkdtempSync(join(tmpdir(), "herdr-usage-accounts-"));
const key = "qa-cliproxy-secret";
const fake = startFakeCLIProxy(key);
let api: ReturnType<typeof createServer> | undefined;
let web: ReturnType<typeof Bun.serve> | undefined;
let browser: Browser | undefined;
try {
  const app = join(dir, "app");
  await buildDemoApp(app);
  const stateDir = join(dir, "state");
  const home = join(dir, "home");
  const claude = join(home, ".claude-personal");
  mkdirSync(claude, { recursive: true });
  writeFileSync(join(claude, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "fixture-personal-token" } }));
  writeFileSync(join(claude, ".claude.json"), JSON.stringify({ oauthAccount: { accountUuid: "fixture-personal", emailAddress: "personal@example.test" } }));
  const ctx: UsageContext = {
    home, env: {}, platform: process.platform,
    fetch: async () => Response.json({ five_hour: { utilization: 18 } }),
    now: Date.now, keychain: async () => ({ status: "missing" }), run: async () => null, has: () => true,
  };
  const service = new CLIProxyService(stateDir);
  await service.save({ url: fake.server.url.origin, management_key: key });
  api = createServer({
    port: 0, hostname: "127.0.0.1", stateDir, machines: false, registerBridge: false,
    terminalAttach: false, sidecar: false, cliProxy: service,
    usage: new UsageService(ctx, USAGE_PROVIDERS.filter((provider) => provider.id === "claude"), (refresh) => service.report(refresh)),
  });
  const backend = `http://127.0.0.1:${api.port}`;
  const html = readFileSync(join(app, "index.html"), "utf8").replace('<script type="module"', `<script>window.demoNativeFetch=window.fetch.bind(window)</script>
<script src="./demo-transport.js"></script>
<script>
const fixtureFetch=window.fetch;
window.fetch=(input,init)=>{
const u=new URL(typeof input==='string'?input:input.url||input.href,location.href);
if(u.pathname==='/api/agent-catalog')return Promise.resolve(Response.json({platform:'linux',agents:[]}));
return (u.pathname==='/api/usage'||u.pathname==='/api/cliproxy'||u.pathname.startsWith('/api/cliproxy/'))?window.demoNativeFetch(input,init):fixtureFetch(input,init);
};
</script><script type="module"`);
  web = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/api/usage" || url.pathname === "/api/cliproxy" || url.pathname.startsWith("/api/cliproxy/")) {
      const headers = new Headers(request.headers);
      headers.set("host", new URL(backend).host);
      if (headers.has("origin")) headers.set("origin", backend);
      const response = await fetch(new Request(`${backend}${url.pathname}${url.search}`, { method: request.method, headers, body: request.body }));
      const decoded = new Headers(response.headers);
      decoded.delete("content-encoding"); decoded.delete("content-length");
      return new Response(await response.arrayBuffer(), { status: response.status, headers: decoded });
    }
    if (url.pathname === "/" || url.pathname === "/index.html") return new Response(html, { headers: { "content-type": "text/html" } });
    const path = decodeURIComponent(url.pathname).slice(1);
    if (path.split("/").includes("..") || path.includes("\\")) return new Response("bad path", { status: 400 });
    const file = Bun.file(join(app, path));
    return await file.exists() ? new Response(file) : new Response("not found", { status: 404 });
  } });
  const origin = web.url.origin;
  browser = await chromium.launch({ executablePath: chromePath(), headless: true, args: ["--no-sandbox"] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, locale: "en-US" });
  await page.addInitScript(() => localStorage.setItem("ovis:settings", JSON.stringify({ showUsage: true })));
  await page.goto(`${origin}/?settings=agents`);
  await openSettingsPage(page, "Agents");
  await page.locator(".usage-accounts-row").first().waitFor();
  const add = page.locator("[data-section='other-accounts'] .agents-head").getByRole("button", { name: "Add account", exact: true });
  const modal = page.locator(".usage-account-dialog");
  const before = await page.locator(".usage-accounts-row").count();

  // Given: Plan limits closes the page, the status-line switch after the meters' last option; Add heads Other accounts.
  const statusline = page.getByRole("switch", { name: "Read Claude's limits from its status line", exact: true });
  await statusline.waitFor();
  await page.getByRole("button", { name: "Session", exact: true }).focus();
  await page.keyboard.press("Tab");
  assert.equal(await statusline.evaluate((toggle) => toggle === document.activeElement), true);
  await add.focus();
  // When: Enter walks provider -> method.
  await page.keyboard.press("Enter");
  await modal.waitFor();
  await page.waitForFunction(() => document.activeElement?.getAttribute("aria-label") === "Claude");
  await page.keyboard.press("Enter");
  await modal.getByRole("button", { name: /^On this PC/ }).waitFor();
  // Then: Escape closes just the picker and returns to Add.
  await page.keyboard.press("Escape");
  await modal.waitFor({ state: "hidden" });
  assert.equal(await add.evaluate((button) => button === document.activeElement), true);

  await add.click();
  await modal.getByRole("button", { name: "OpenCode", exact: true }).waitFor();
  assert.deepEqual(await modal.locator(".account-provider-grid > button").evaluateAll((buttons) => buttons.map((button) => button.getAttribute("aria-label"))), [
    "Claude", "Codex", "Cursor", "GitHub Copilot", "Grok", "Antigravity", "OpenCode", "Hub",
  ]);
  await modal.getByRole("button", { name: "Cursor", exact: true }).click();
  assert.equal(await modal.getByRole("button", { name: /^Through the hub/ }).count(), 0);
  await modal.getByRole("button", { name: /^On this PC/ }).click();
  await modal.getByRole("button", { name: "Continue", exact: true }).waitFor();
  assert.equal(await modal.locator("#usage-account-name").count(), 0);
  assert.equal(await modal.getByRole("button", { name: "Start sign-in", exact: true }).count(), 0);
  await modal.getByRole("button", { name: "Continue", exact: true }).click();
  await page.evaluate(() => {
    const original = window.fetch;
    window.fetch = Object.assign((...args: Parameters<typeof window.fetch>) => {
      const [input, init] = args;
      if (new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, location.href).pathname === "/api/usage/login" && init?.method === "POST") {
        document.dispatchEvent(new CustomEvent("qa-login-request", { detail: JSON.parse(String(init.body)) }));
      }
      return original(...args);
    }, original);
  });
  const replacement = page.evaluate(() => new Promise<unknown>((resolve, reject) => {
    const deadline = setTimeout(() => reject(new Error("Login request missing")), 3000);
    document.addEventListener("qa-login-request", (event) => {
      clearTimeout(deadline);
      if (event instanceof CustomEvent) resolve(event.detail);
    }, { once: true });
  }));
  await modal.getByRole("button", { name: "Start sign-in", exact: true }).click();
  assert.deepEqual(await replacement, { provider: "cursor", replace: true });
  await modal.getByRole("button", { name: "Close", exact: true }).click();
  await add.click();
  await modal.getByRole("button", { name: "Grok", exact: true }).click();
  assert.equal(await modal.locator(".account-choice, button[type=submit]").count(), 0);
  assert.equal(await modal.evaluate((node) => node.contains(document.activeElement)), true);
  await page.keyboard.press("Escape");
  await modal.waitFor({ state: "hidden" });
  await page.locator(".settings-dialog").waitFor();
  assert.equal(await add.evaluate((button) => button === document.activeElement), true);

  await add.click();
  await modal.getByRole("button", { name: /^Claude/ }).click();
  const popupReady = page.waitForEvent("popup");
  await modal.getByRole("button", { name: /^Through the hub/ }).click();
  const popup = await popupReady;
  await popup.waitForURL(/\/authorize\?state=/);
  await modal.getByText("Waiting for sign-in…", { exact: true }).waitFor();
  const state = new URL(popup.url()).searchParams.get("state");
  assert.ok(state);
  await popup.getByRole("link", { name: "Complete sign-in", exact: true }).click();
  await modal.waitFor({ state: "hidden" });
  await page.locator(".usage-accounts-account").filter({ hasText: `${state}@example.test` }).waitFor();
  assert.equal(await page.locator(".usage-accounts-row").count(), before + 1);
  const hubAccounts = await page.locator(".usage-account-meta").filter({ hasText: "Hub" }).count();
  await popup.close();

  await add.click();
  await modal.getByRole("button", { name: /^Codex/ }).click();
  const secondReady = page.waitForEvent("popup");
  await modal.getByRole("button", { name: /^Through the hub/ }).click();
  const second = await secondReady;
  await second.waitForURL(/\/authorize\?state=/);
  const cancelled = page.waitForResponse((response) => response.url().includes("/api/cliproxy/login?state=") && response.request().method() === "DELETE");
  await modal.getByRole("button", { name: "Cancel", exact: true }).click();
  assert.equal((await cancelled).status(), 200);
  await modal.getByRole("button", { name: /^Through the hub/ }).waitFor();
  await second.close();
  await modal.getByRole("button", { name: "Close", exact: true }).click();
  await page.waitForFunction(() => document.activeElement === document.querySelector("[data-section='other-accounts'] .agents-head .btn"));

  // Given: a hub session is still waiting when its dialog is dismissed.
  await add.click();
  await modal.getByRole("button", { name: /^Claude/ }).click();
  const dismissedReady = page.waitForEvent("popup");
  await modal.getByRole("button", { name: /^Through the hub/ }).click();
  const dismissed = await dismissedReady;
  await dismissed.waitForURL(/\/authorize\?state=/);
  await modal.getByText("Waiting for sign-in…", { exact: true }).waitFor();
  const dismissedState = new URL(dismissed.url()).searchParams.get("state");
  assert.ok(dismissedState);
  assert.equal(fake.sessions.has(dismissedState), true);
  const dismissedCancel = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return url.pathname === "/api/cliproxy/login" && url.searchParams.get("state") === dismissedState
      && response.request().method() === "DELETE";
  }, { timeout: 5000 });
  // When: Escape unmounts the account dialog, rather than pressing Cancel.
  await modal.getByRole("button", { name: "Close", exact: true }).focus();
  await page.keyboard.press("Escape");
  await modal.waitFor({ state: "hidden" });
  // Then: cancellation reaches the backend and releases that exact fixture session.
  assert.equal((await dismissedCancel).status(), 200);
  assert.equal(fake.sessions.has(dismissedState), false);
  await dismissed.close();
  await page.locator(".settings-dialog").waitFor();
  console.log("PASS: Escape cancels the pending hub state and removes its session");
  const config: { url: string } = await (await page.request.get(`${origin}/api/cliproxy`)).json();
  const connection = page.locator('[data-section="usage-connection"]');
  await page.getByRole("switch", { name: "Show plan limits", exact: true }).click();
  assert.equal(await page.locator(".usage-provider").count(), 0);
  let usageRequests = 0;
  page.on("request", (request) => { if (new URL(request.url()).pathname === "/api/usage") usageRequests++; });
  await connection.waitFor();
  let deletes = 0;
  page.on("request", (request) => { if (request.url() === `${origin}/api/cliproxy` && request.method() === "DELETE") deletes++; });
  await connection.getByRole("button", { name: "Remove", exact: true }).click();
  const confirm = page.locator(".confirm-dialog");
  await confirm.waitFor();
  await confirm.getByRole("button", { name: "Cancel", exact: true }).evaluate((button) => new Promise<void>((resolve, reject) => {
    if (button === document.activeElement) { resolve(); return; }
    const deadline = setTimeout(() => reject(new Error("Confirmation did not focus Cancel")), 3000);
    button.addEventListener("focus", () => { clearTimeout(deadline); resolve(); }, { once: true });
  }));
  assert.equal(deletes, 0);
  await confirm.getByRole("button", { name: "Cancel", exact: true }).click();
  assert.equal(deletes, 0);
  await connection.getByRole("button", { name: "Remove", exact: true }).click();
  const removed = page.waitForResponse((response) => response.url() === `${origin}/api/cliproxy` && response.request().method() === "DELETE");
  await confirm.getByRole("button", { name: "Remove", exact: true }).click();
  assert.equal((await removed).status(), 200);
  await connection.waitFor({ state: "hidden" });
  await page.waitForFunction(() => document.activeElement === document.querySelector("[data-section='other-accounts'] .agents-head .btn"));
  assert.equal(deletes, 1);
  await add.click();
  await modal.getByRole("button", { name: "Claude", exact: true }).click();
  assert.equal(await modal.getByRole("button", { name: /^Through the hub/ }).isDisabled(), true);
  await modal.getByRole("button", { name: "Connect a hub first", exact: true }).click();
  await modal.locator("#usage-hub-url").fill(config.url);
  await modal.locator("#usage-hub-key").fill(key);
  const showKey = modal.getByRole("button", { name: "Show key", exact: true });
  assert.equal(await modal.locator("#usage-hub-key").getAttribute("type"), "password");
  await showKey.click();
  assert.equal(await showKey.getAttribute("aria-pressed"), "true");
  assert.equal(await modal.locator("#usage-hub-key").getAttribute("type"), "text");
  assert.equal(await modal.locator("#usage-hub-key").inputValue(), key);
  await showKey.click();
  assert.equal(await modal.locator("#usage-hub-key").getAttribute("type"), "password");
  await modal.getByRole("button", { name: "Connect", exact: true }).click();
  await modal.getByRole("button", { name: "Done", exact: true }).waitFor();
  assert.equal(await modal.locator("#usage-hub-key").count(), 0);
  assert.equal((await modal.innerHTML()).includes("qa-cliproxy-secret"), false);
  await modal.getByRole("button", { name: "Done", exact: true }).click();
  assert.equal(usageRequests, 0, "connecting with plan limits off never requests usage");
  await modal.getByRole("button", { name: /^Through the hub/ }).waitFor();
  await modal.getByRole("button", { name: "Close", exact: true }).click();
  await connection.waitFor();
  await connection.getByRole("button", { name: "Edit", exact: true }).click();
  assert.equal(await modal.locator("#usage-hub-url").inputValue(), config.url);
  assert.equal(await modal.locator("#usage-hub-key").inputValue(), "");
  await modal.getByRole("button", { name: "Connect", exact: true }).click();
  await modal.getByRole("button", { name: "Done", exact: true }).click();
  assert.equal(usageRequests, 0, "editing or removing a connection with plan limits off never requests usage");
  assert.equal(usageRequests, 0, "all connection actions with meters off avoid /api/usage");
  await page.getByRole("switch", { name: "Show plan limits", exact: true }).click();
  await page.locator(".usage-accounts-row").first().waitFor();
  await connection.getByRole("button", { name: "Edit", exact: true }).click();
  await modal.getByRole("button", { name: "Connect", exact: true }).click();
  await modal.getByRole("button", { name: "Done", exact: true }).waitFor();
  assert.match(await modal.getByRole("status").innerText(), new RegExp(`\\b${hubAccounts}\\b`));
  await modal.getByRole("button", { name: "Done", exact: true }).click();
  console.log("PASS: global Add keyboard/focus, OAuth completion/cancel, configured hub with meters off, confirmed removal, connect/edit with zero off-state usage requests, enabled account count");
} finally {
  await browser?.close();
  web?.stop(true);
  api?.stop();
  fake.server.stop(true);
  rmSync(dir, { recursive: true, force: true });
}
