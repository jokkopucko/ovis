/** The plan meters beside Settings, on a staged report: no real sign-in is read or sent. */
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Browser, BrowserContext, BrowserContextOptions } from "playwright-core";
import type { UsageReport } from "../shared/protocol.ts";
import { openSettingsPage } from "./settings-page.ts";

const at = (hours: number): string => new Date(Date.now() + hours * 3600_000).toISOString();
/** Built when it is asked for: its times hold however late in the run that is. */
const report = (): UsageReport => ({
  providers: [
    { id: "claude", key: "claude:u1", account: "me@example.com", plan: "max", problem: null, checked_at: at(0), windows: [
      // 2.8 hours into the session at 15%/h: lasts to the reset
      { kind: "session", scope: null, used_percent: 42, resets_at: at(2.2), starts_at: at(2.2 - 5) },
      // 86 hours into the week: runs out in about 2 days, 1.4 days before the reset
      { kind: "week", scope: null, used_percent: 63.4, resets_at: at(82), starts_at: at(82 - 168) },
      { kind: "week", scope: "Sonnet", used_percent: 5, resets_at: null, starts_at: null },
    ] },
    { id: "codex", key: "codex:work", account: "me@work.example", plan: "pro", problem: null, checked_at: at(0), windows: [
      { kind: "session", scope: null, used_percent: 12, resets_at: at(0.8), starts_at: at(0.8 - 5) },
      { kind: "week", scope: null, used_percent: 91, resets_at: at(99), starts_at: at(99 - 168) },
    ] },
    { id: "codex", key: "codex:home", account: "me@example.com", plan: "plus", problem: null, checked_at: "2026-09-29T12:00:00Z", windows: [
      { kind: "week", scope: null, used_percent: 30, resets_at: at(120), starts_at: null },
    ] },
    { id: "cursor", key: "cursor:c1", account: null, plan: "pro", problem: null, checked_at: "2026-09-29T12:00:00Z", windows: [{ kind: "month", scope: null, used_percent: 20, resets_at: at(300), starts_at: null }] },
    { id: "copilot", key: "copilot:me", account: "me", plan: "free", problem: null, checked_at: "2026-09-29T12:00:00Z", windows: [{ kind: "month", scope: "Chat", used_percent: 0, resets_at: at(34), starts_at: null }] },
    { id: "grok", key: "grok:g1", account: null, plan: null, problem: "rate_limited", checked_at: "2026-09-29T11:40:00Z", windows: [{ kind: "week", scope: null, used_percent: 0, resets_at: null, starts_at: null }] },
    { id: "antigravity", key: "antigravity@keychain", account: null, plan: null, problem: "expired", checked_at: null, windows: [] },
  ],
});

/**
 * A context whose PC lists no agents: Settings → Agents then shows every account under Other accounts,
 * as the staged report has them, whatever this machine has installed.
 */
async function usageContext(browser: Browser, options: BrowserContextOptions): Promise<BrowserContext> {
  const context = await browser.newContext(options);
  await context.route("**/api/agent-catalog", (route) => route.fulfill({ json: { platform: "linux", agents: [] } }));
  return context;
}

/** a header the check puts on every request of the page it reloads: what that page asked for, whenever it is counted */
const RELOADED = "x-usage-qa-reloaded";

async function staged(context: BrowserContext): Promise<{ asked: string[]; afterReload: string[] }> {
  const asked: string[] = [];
  const afterReload: string[] = [];
  // the status-line switch reads Claude's settings on the server's PC: answered here, never by the test server
  await context.route("**/api/usage/statusline", (route) => route.fulfill({ json: { installed: false, supported: true } }));
  await context.route("**/api/usage*", (route) => {
    asked.push(new URL(route.request().url()).search);
    if (route.request().headers()[RELOADED]) afterReload.push(route.request().url());
    return route.fulfill({ json: report() });
  });
  return { asked, afterReload };
}

export async function checkUsageMeters(browser: Browser, origin: string): Promise<void> {
  const context = await usageContext(browser, { viewport: { width: 1280, height: 800 }, locale: "en-US" });
  try {
    const { asked, afterReload } = await staged(context);
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(origin);
    const strip = page.locator(".usage-strip");
    const settingsButton = page.locator(".sidebar-footer-row .sidebar-footer-action");
    const toggle = page.getByRole("switch", { name: "Show plan limits", exact: true });

    // off until chosen: nothing is shown and no sign-in is sent anywhere
    await settingsButton.waitFor();
    assert.equal(await strip.count(), 0);
    assert.deepEqual(asked, [], "no usage request before the user turns it on");
    await settingsButton.click();
    await openSettingsPage(page, "Agents");
    assert.equal(await toggle.getAttribute("aria-checked"), "false");
    await toggle.click();
    await page.keyboard.press("Escape");
    await strip.waitFor();

    // what is left of each plan's five-hour session by default, in the server's order; a plan
    // without a session shows its limit closest to running out, and the tooltip names another
    // limit near its end that the chip does not show. As many chips as the row holds, the rest in "+N"
    const chipCount = await page.locator(".usage-chip").count();
    const more = await page.locator(".usage-more").count() === 0 ? 0 : Number((await page.locator(".usage-more").textContent())!.slice(1));
    assert.equal(chipCount + more, 7, "every account is a chip or counted in +N");
    assert.ok(chipCount >= 4, `the row beside the Settings gear holds at least four chips (${chipCount})`);
    assert.equal(await strip.getAttribute("aria-label"),
      "Subscription usage: Claude · me@example.com 58% left, Codex · me@work.example 88% left (Weekly 9% left), Codex · me@example.com 70% left, Cursor 80% left, GitHub Copilot · me 100% left, Grok 100% left, Antigravity —");
    assert.deepEqual((await page.locator(".usage-chip-value").allTextContents()).slice(0, 4), ["58%", "88%", "70%", "80%"]);
    assert.equal(await page.locator(".usage-chip.is-high").count(), 0, "no session is near its end");
    assert.equal(await strip.evaluate((el) => el.scrollWidth <= el.clientWidth), true, "the chips fit beside Settings");
    const [settings, meters] = await Promise.all([page.locator(".sidebar-footer-row .sidebar-footer-action").boundingBox(), strip.boundingBox()]);
    assert.ok(settings && meters && settings.x + settings.width <= meters.x, "Settings and the meters do not overlap");

    await strip.click();
    const popover = page.getByRole("dialog", { name: "Subscription usage", exact: true });
    await popover.waitFor();
    assert.equal(await popover.locator(".usage-provider").count(), 7);
    assert.equal(await popover.getByRole("meter").count(), 9);
    assert.equal(await popover.locator(".usage-account").first().textContent(), "me@example.com");
    assert.equal(await popover.locator(".usage-row.is-high").count(), 1);
    assert.equal(await popover.locator(".usage-note.is-problem").count(), 1, "only the expired sign-in reads as an error");
    if (process.env.UI_EVIDENCE_DIR) {
      mkdirSync(process.env.UI_EVIDENCE_DIR, { recursive: true });
      await page.locator(".sidebar-shell").screenshot({ path: join(process.env.UI_EVIDENCE_DIR, "usage-popover.png") });
    }
    const refreshed = page.waitForRequest((request) => request.url().endsWith("/api/usage?refresh=1"));
    await popover.getByRole("button", { name: "Refresh", exact: true }).click();
    await refreshed;
    await page.keyboard.press("Escape");
    await popover.waitFor({ state: "hidden" });
    assert.equal(await strip.evaluate((el) => el === document.activeElement), true, "Escape hands focus back to the strip");

    // Settings: the week instead, where one near its limit is red; then the share used, an account
    // hidden from the strip, another moved up
    const names = () => page.locator(".usage-popover .usage-provider").evaluateAll((sections) => sections.map((section) => section.getAttribute("aria-label")));
    await settingsButton.click();
    await openSettingsPage(page, "Agents");
    if (process.env.UI_EVIDENCE_DIR) {
      await page.getByRole("tabpanel", { name: "Agents", exact: true }).screenshot({ path: join(process.env.UI_EVIDENCE_DIR, "usage-settings.png") });
    }
    await page.locator('.segmented[aria-label="Limit shown"]').getByRole("button", { name: "Weekly", exact: true }).click();
    await page.keyboard.press("Escape");
    assert.match(await strip.getAttribute("aria-label") ?? "", /^Subscription usage: Claude · me@example\.com 37% left, Codex · me@work\.example 9% left, Codex · me@example\.com 70% left,/);
    assert.equal(await page.locator(".usage-chip").nth(1).evaluate((chip) => chip.classList.contains("is-high")), true);
    await settingsButton.click();
    await openSettingsPage(page, "Agents");
    // the moved order is shared: the page saves it to the server once the settings rest, and a check
    // run after this one on the same server must not have that save land in the middle of it
    const orderSaved = page.waitForResponse((response) => response.request().method() === "PUT" && new URL(response.url()).pathname === "/api/preferences"
      && (response.request().postDataJSON() as { settings?: Record<string, unknown> } | null)?.settings?.["usageOrder"] !== undefined, { timeout: 10_000 });
    await page.getByRole("button", { name: "Used", exact: true }).click();
    await page.getByRole("switch", { name: "Show Codex · me@work.example", exact: true }).click();
    await page.getByRole("button", { name: "Move Codex · me@example.com up", exact: true }).click();
    await page.keyboard.press("Escape");
    assert.equal(await strip.getAttribute("aria-label"),
      "Subscription usage: Claude · me@example.com 63%, Codex · me@example.com 30%, Cursor 20%, GitHub Copilot · me 0%, Grok 0%, Antigravity —");
    assert.deepEqual((await page.locator(".usage-chip-value").allTextContents()).slice(0, 3), ["63%", "30%", "20%"]);
    await strip.click();
    assert.deepEqual((await names()).slice(0, 3), ["Claude · me@example.com", "Codex · me@example.com", "Cursor"], "a hidden account is left out of the popover too");
    assert.equal(await popover.locator(".usage-provider").count(), 6);
    assert.equal(await popover.locator(".usage-row-value").first().textContent(), "42%");
    if (process.env.UI_EVIDENCE_DIR) await page.locator(".sidebar-shell").screenshot({ path: join(process.env.UI_EVIDENCE_DIR, "usage-popover-used.png") });
    await page.keyboard.press("Escape");
    const stored = await page.evaluate(() => JSON.parse(localStorage.getItem("ovis:settings") ?? "{}") as { usageHidden?: string[]; usageCount?: string; usageGlance?: string });
    assert.deepEqual([stored.usageHidden, stored.usageCount, stored.usageGlance], [["codex:work"], "used", "week"]);
    assert.equal((await orderSaved).status(), 200, "the moved order reached the server before this page closes");

    // turned off in Settings: gone, and no longer asked for
    await settingsButton.click();
    await openSettingsPage(page, "Agents");
    // The strip disappears before the shared preference's debounced save. Reload only once
    // the server has taken OFF, or its older ON value will turn usage back on during hydration.
    const usageOffSaved = page.waitForResponse((response) => response.request().method() === "PUT"
      && new URL(response.url()).pathname === "/api/preferences" && response.ok()
      && response.request().postDataJSON()?.settings?.showUsage === false, { timeout: 10_000 });
    await toggle.click();
    await strip.waitFor({ state: "detached" });
    assert.equal(await page.locator("[data-section='other-accounts'] .settings-note").count(), 1);
    assert.equal(await page.locator(".usage-provider").count(), 0, "disabled meters leave no provider placeholders");
    await usageOffSaved;
    // a request Settings made before the switch can still be on its way here, so the count is of
    // the reloaded page's own requests, not of what arrives after the reload
    await context.setExtraHTTPHeaders({ [RELOADED]: "1" });
    // In the new document, settings are written when the server's preferences are applied.
    // Waiting for that write observes hydration, not just the footer's earlier mount.
    await page.addInitScript(() => {
      const setItem = Storage.prototype.setItem;
      Storage.prototype.setItem = function (key, value) {
        setItem.call(this, key, value);
        if (this === localStorage && key === "ovis:settings" && JSON.parse(value).showUsage === false) {
          document.documentElement.setAttribute("data-usage-preferences-hydrated", "");
        }
      };
    });
    await page.reload();
    await page.locator(".sidebar-footer").waitFor();
    // a timeout here, not the assertion below, is how a lost OFF save would now fail
    await page.locator("html[data-usage-preferences-hydrated]").waitFor();
    assert.deepEqual(afterReload, [], "a hidden strip asks for nothing");
    await context.setExtraHTTPHeaders({});
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }

  // on a phone the popover opens inside the drawer and stays on screen
  // The desktop check saved OFF: seed the shared preference too, or hydration overrides
  // this phone's local ON value before its strip can be opened.
  const usageOn = await fetch(`${origin}/api/preferences`, { method: "PUT", headers: { "content-type": "application/json", origin }, body: JSON.stringify({ settings: { showUsage: true } }) });
  assert.equal(usageOn.status, 200, "the phone's shared usage preference is enabled");
  const phone = await usageContext(browser, { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, locale: "en-US" });
  try {
    await staged(phone);
    await phone.addInitScript(() => localStorage.setItem("ovis:settings", JSON.stringify({ showUsage: true })));
    const page = await phone.newPage();
    await page.goto(origin);
    await page.getByRole("button", { name: "Open workspace list", exact: true }).click();
    await page.locator(".usage-strip").click();
    const popover = page.getByRole("dialog", { name: "Subscription usage", exact: true });
    await popover.waitFor();
    const box = await popover.boundingBox();
    assert.ok(box && box.x >= 0 && box.y >= 0 && box.x + box.width <= 390, "the popover stays inside the phone's screen");
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    if (process.env.UI_EVIDENCE_DIR) await page.locator(".sidebar-shell").screenshot({ path: join(process.env.UI_EVIDENCE_DIR, "usage-popover-phone.png") });

    // Settings on the phone: every account row fits its card, controls included
    await page.keyboard.press("Escape");
    await page.locator(".sidebar-footer-row .sidebar-footer-action").click();
    await openSettingsPage(page, "Agents");
    const accounts = page.locator(".usage-accounts");
    await accounts.first().scrollIntoViewIfNeeded();
    assert.equal(await accounts.locator(".usage-accounts-row").count(), 7);
    assert.equal(await accounts.evaluateAll((cards) => cards.every((card) => [...card.querySelectorAll(".usage-accounts-row")].every((row) => row.scrollWidth <= row.clientWidth))), true, "each account row fits the phone");
    if (process.env.UI_EVIDENCE_DIR) {
      await page.getByRole("tabpanel", { name: "Agents", exact: true }).screenshot({ path: join(process.env.UI_EVIDENCE_DIR, "usage-settings-phone.png") });
    }
  } finally {
    await phone.close();
  }
  console.log("PASS plan meters beside the Settings gear: session left by default, accounts, order, hiding, week and used, row fit, popover, refresh, Escape, off switch and phone fit");
  await checkStatuslineSwitch(browser, origin);
}

/**
 * A Claude sign-in the usage API refuses although its token has not expired (a blocked network's
 * 403) offers the status line in the popover; Settings' switch shows and undoes it. Only on or off
 * is sent, and nothing reaches the test server's own home.
 */
async function checkStatuslineSwitch(browser: Browser, origin: string): Promise<void> {
  const context = await usageContext(browser, { viewport: { width: 1280, height: 800 }, locale: "en-US" });
  try {
    let installed = false;
    const posted: unknown[] = [];
    await context.route("**/api/usage/statusline", (route) => {
      if (route.request().method() === "POST") {
        const body = route.request().postDataJSON() as { enabled: boolean };
        posted.push(body);
        installed = body.enabled;
      }
      return route.fulfill({ json: { installed, supported: true } });
    });
    await context.route("**/api/usage*", (route) => route.fulfill({ json: { providers: [installed ? report().providers[0]!
      : { id: "claude", key: "claude:u1", account: "me@example.com", plan: "max", problem: "expired", checked_at: null, windows: [], statusline_offer: true }] } satisfies UsageReport }));
    await context.addInitScript(() => localStorage.setItem("ovis:settings", JSON.stringify({ showUsage: true })));
    const page = await context.newPage();
    await page.goto(origin);
    await page.locator(".usage-strip").click();
    const offer = page.getByRole("button", { name: "Read from Claude's status line instead", exact: true });
    await offer.click();
    // turned on, the limits are asked for again at once: the offer goes and the windows come
    await offer.waitFor({ state: "detached" });
    await page.locator(".usage-row").first().waitFor();
    assert.deepEqual(posted, [{ enabled: true }]);

    await page.keyboard.press("Escape");
    await page.locator(".sidebar-footer-row .sidebar-footer-action").click();
    await openSettingsPage(page, "Agents");
    const statusline = page.getByRole("switch", { name: "Read Claude's limits from its status line", exact: true });
    await page.waitForFunction(() => document.querySelector('[role="switch"][aria-label="Read Claude\'s limits from its status line"]')?.getAttribute("aria-checked") === "true");
    await statusline.click();
    await page.waitForFunction(() => document.querySelector('[role="switch"][aria-label="Read Claude\'s limits from its status line"]')?.getAttribute("aria-checked") === "false");
    assert.deepEqual(posted, [{ enabled: true }, { enabled: false }]);
  } finally {
    await context.close();
  }
  console.log("PASS a refused Claude sign-in offers the status line in place; Settings' switch shows and undoes it, sending only on or off");
}

/** An expired sign-in on this PC, one through the hub and Antigravity's, each expired: only the first can sign in again here. */
const expiredReport = (): UsageReport => ({
  providers: [
    { id: "claude", key: "claude:u1", account: "me@example.com", plan: "max", problem: null, checked_at: at(0), windows: [{ kind: "session", scope: null, used_percent: 42, resets_at: at(2), starts_at: null }] },
    { id: "claude", key: "claude:team", account: "me@team.example", plan: "team", problem: "expired", checked_at: null, windows: [] },
    { id: "codex", key: "codex:cliproxy:hub-1", account: "hub@example.com", plan: "plus", problem: "expired", checked_at: null, windows: [] },
    { id: "antigravity", key: "antigravity@keychain", account: null, plan: null, problem: "expired", checked_at: null, windows: [] },
  ],
});

/**
 * Sign in again: offered for the expired account on this PC, in the popover and in its Settings row,
 * never for the hub's or Antigravity's; it asks the server by the account's key and follows the login in
 * a dialog (UsageSignInDialog), whose Open terminal hands the tab over.
 */
export async function checkUsageSignInAgain(browser: Browser, origin: string): Promise<void> {
  // the account order is shared through the server: whatever an earlier check on it saved (checkUsageMeters
  // moves an account) would put its accounts first here, so this check starts from none
  const reset = await fetch(`${origin}/api/preferences`, { method: "PUT", headers: { "content-type": "application/json", origin }, body: JSON.stringify({ settings: { usageOrder: [] } }) });
  assert.equal(reset.status, 200, "the shared account order is cleared");
  for (const phone of [false, true]) {
    const context = await usageContext(browser, { viewport: phone ? { width: 390, height: 844 } : { width: 1280, height: 800 }, locale: "en-US", ...(phone ? { hasTouch: true, isMobile: true } : {}) });
    try {
      const posted: unknown[] = [];
      // a followed start (the dialog) is refused, then runs; Open terminal's start opens the tab
      const answers = [
        { status: 409, json: { error: { code: "cli_unavailable", message: "Install the official CLI on this PC before signing in" } } },
        { status: 200, json: { login_id: "00000000-0000-4000-8000-000000000009", device_auth: false } },
      ];
      const tab = { status: 200, json: { pane_id: "w9:p9", workspace_id: "w9", manual: false, device_auth: false } };
      const cancelled: unknown[] = [];
      // what reached the server, in order: Open terminal's tab starts only once the cancel has been answered
      const events: string[] = [];
      // Record the browser's awaited response, not merely arrival at the mock server.
      await context.addInitScript(() => {
        const events: string[] = [];
        Object.assign(window, { usageLoginEvents: events });
        const original = window.fetch;
        window.fetch = async (input, init) => {
          const url = String(input);
          if (url.endsWith("/api/usage/login") && init?.method === "POST"
            && typeof init.body === "string" && !JSON.parse(init.body).follow) events.push("tab");
          const response = await original(input, init);
          if (url.endsWith("/api/usage/login/cancel")) events.push("cancel");
          return response;
        };
      });
      await context.route("**/api/usage/login/cancel", async (route) => {
        cancelled.push(route.request().postDataJSON());
        events.push("cancel");
        return route.fulfill({ status: 204 });
      });
      await context.route("**/api/usage*", (route) => route.fulfill({ json: expiredReport() }));
      // the dialog reads the provider's sign-ins and the login's screen: a login still starting
      await context.route("**/api/usage/login?provider=*", (route) => route.fulfill({ json: { accounts: ["me@team.example"] } }));
      await context.route("**/api/usage/login/prompt*", (route) => route.fulfill({ json: { provider: "claude", url: null, user_code: null, wants_code: false, ended: false } }));
      await context.route("**/api/usage/login", (route) => {
        if (route.request().method() !== "POST") return route.continue();
        const body = route.request().postDataJSON() as { follow?: boolean };
        posted.push(body);
        events.push(body.follow ? "follow" : "tab");
        if (!body.follow) return route.fulfill(tab);
        return route.fulfill(answers[(posted.filter((sent) => (sent as { follow?: boolean }).follow).length - 1) % answers.length]!);
      });
      await context.addInitScript(() => localStorage.setItem("ovis:settings", JSON.stringify({ showUsage: true })));
      const page = await context.newPage();
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(origin);
      const openDrawer = async () => { if (phone) await page.getByRole("button", { name: "Open workspace list", exact: true }).click(); };
      await openDrawer();
      await page.locator(".usage-strip").click();
      const popover = page.getByRole("dialog", { name: "Subscription usage", exact: true });
      await popover.waitFor();
      const again = popover.getByRole("button", { name: /^Sign in again/ });
      assert.equal(await again.count(), 1, "only the expired account on this PC can sign in again");
      assert.equal(await again.getAttribute("aria-label"), "Sign in again to Claude · me@team.example");
      assert.deepEqual(await popover.locator(".usage-note.is-problem").allTextContents(), [
        "Sign-in expired.", "Sign-in expired. Open Codex to renew it.", "Sign-in expired. Open Antigravity to renew it.",
      ]);
      if (phone) {
        const box = await popover.boundingBox();
        assert.ok(box && box.x >= 0 && box.x + box.width <= 390, "the popover stays inside the phone's screen");
      }
      // the sign-in is followed in its own dialog, the popover giving way to it; a refusal is said there
      const following = page.getByRole("dialog", { name: "Sign in to Claude Code", exact: true });
      await again.click();
      await popover.waitFor({ state: "detached" });
      await following.getByRole("alert").filter({ hasText: "Install the official CLI on this PC before signing in" }).waitFor();
      await following.getByRole("button", { name: "Done", exact: true }).click();
      await following.waitFor({ state: "detached" });
      // started: its Open terminal hands the tab over (a phone's drawer is still out after Done)
      if (!(await page.locator(".usage-strip").isVisible())) await openDrawer();
      await page.locator(".usage-strip").click();
      await popover.getByRole("button", { name: /^Sign in again/ }).click();
      await following.getByText("Waiting for Claude to show its sign-in page…", { exact: true }).waitFor();
      await following.getByRole("button", { name: "Open terminal", exact: true }).click();
      await following.waitFor({ state: "detached" });

      await openDrawer();
      await page.locator(".sidebar-footer-row .sidebar-footer-action").click();
      await openSettingsPage(page, "Agents");
      const rows = page.locator(".usage-accounts-row");
      // the rows come with the usage report, loaded once the page is shown: count them once they are
      await rows.nth(3).waitFor();
      assert.equal(await rows.count(), 4);
      const rowAgain = page.locator(".settings-dialog").getByRole("button", { name: /^Sign in again/ });
      assert.equal(await rowAgain.count(), 1, "Settings offers it on the expired row of this PC only");
      assert.equal(await rows.nth(1).getByRole("button", { name: "Sign in again to Claude · me@team.example", exact: true }).count(), 1);
      assert.equal(await rows.evaluateAll((all) => all.every((row) => row.scrollWidth <= row.clientWidth)), true, "each account row fits, the button included");
      await rowAgain.click();
      await following.getByRole("alert").filter({ hasText: "Install the official CLI" }).waitFor();
      await following.getByRole("button", { name: "Done", exact: true }).click();
      await following.waitFor({ state: "detached" });
      await rowAgain.click();
      await following.getByRole("button", { name: "Open terminal", exact: true }).click();
      await page.locator(".settings-dialog").waitFor({ state: "detached" });
      const followed = { provider: "claude", account: "claude:team", follow: true };
      const inTab = { provider: "claude", account: "claude:team" };
      assert.deepEqual(posted, [followed, followed, inTab, followed, followed, inTab], "the server is asked by the account's key, never a path: followed, and in a tab once Open terminal is chosen");
      assert.deepEqual(cancelled, Array(2).fill({ login: "00000000-0000-4000-8000-000000000009" }), "Open terminal stops the followed sign-in before the tab starts");
      assert.deepEqual(events, ["follow", "follow", "cancel", "tab", "follow", "follow", "cancel", "tab"], "each tab starts after its followed sign-in was cancelled");
      assert.deepEqual(await page.evaluate(() => (window as Window & { usageLoginEvents: string[] }).usageLoginEvents),
        ["cancel", "tab", "cancel", "tab"], "the browser awaits each cancel response before issuing a tab start");
      assert.deepEqual(errors, []);
    } finally {
      await context.close();
    }
  }
  // a watching device signs in to nothing: no button in either place, and the popover says how instead
  const watching = await usageContext(browser, { viewport: { width: 1280, height: 800 }, locale: "en-US" });
  try {
    await watching.route("**/api/usage*", (route) => route.fulfill({ json: expiredReport() }));
    await watching.route("**/api/health*", async (route) => {
      const response = await route.fetch();
      const body = await response.json() as { auth: Record<string, unknown> };
      await route.fulfill({ response, json: { ...body, auth: { ...body.auth, role: "watch" } } });
    });
    await watching.addInitScript(() => localStorage.setItem("ovis:settings", JSON.stringify({ showUsage: true })));
    const page = await watching.newPage();
    await page.goto(origin);
    await page.locator(".usage-strip").click();
    const popover = page.getByRole("dialog", { name: "Subscription usage", exact: true });
    await popover.waitFor();
    assert.equal(await popover.getByRole("button", { name: /^Sign in again/ }).count(), 0, "no Sign in again in a watching device's popover");
    assert.equal(await popover.locator(".usage-note.is-problem").first().textContent(), "Sign-in expired. Open Claude to renew it.");
    await page.keyboard.press("Escape");
    await page.locator(".sidebar-footer-row .sidebar-footer-action").click();
    await openSettingsPage(page, "Agents");
    await page.locator(".usage-accounts-row").nth(3).waitFor();
    assert.equal(await page.locator(".usage-accounts-row").count(), 4);
    assert.equal(await page.locator(".settings-dialog").getByRole("button", { name: /^Sign in again/ }).count(), 0, "no Sign in again in a watching device's Settings");
  } finally {
    await watching.close();
  }
  console.log("PASS Sign in again: offered only for an expired account on this PC, in the popover and its Settings row, refusal shown, tab handed over, phone fit, none on a watching device");
}

if (import.meta.main) {
  await import("./test-herdr.ts");
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { chromium } = await import("playwright-core");
  const { chromePath } = await import("./chrome-path.ts");
  const { createServer } = await import("../server/index.ts");
  const { systemUsageContext, UsageService } = await import("../server/usage.ts");
  const root = mkdtempSync(join(tmpdir(), "herdr-usage-meters-"));
  let server: ReturnType<typeof createServer> | undefined;
  let browser: Browser | undefined;
  try {
    server = createServer({
      port: 0, hostname: "127.0.0.1", token: "", stateDir: root,
      usage: new UsageService({ ...systemUsageContext(), home: root, env: {} }, []),
    });
    browser = await chromium.launch({ executablePath: chromePath(), headless: true, args: ["--no-sandbox"] });
    await checkUsageMeters(browser, `http://127.0.0.1:${server.port}`);
    await checkUsageSignInAgain(browser, `http://127.0.0.1:${server.port}`);
  } finally {
    await browser?.close();
    server?.stop();
    rmSync(root, { recursive: true, force: true });
  }
}
