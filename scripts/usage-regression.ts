/** The plan meters beside Settings, on a staged report: no real sign-in is read or sent. */
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Browser, BrowserContext, BrowserContextOptions, Page } from "playwright-core";
import { AGENT_CATALOG, catalogRow } from "../shared/agent-catalog.ts";
import type { UsageReport } from "../shared/protocol.ts";
import { openSettingsPage } from "./settings-page.ts";

async function openUsageDrawer(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Open workspace list", exact: true }).click();
  // The popover is positioned inside the drawer and inherits its slide.
  await page.waitForFunction(() => {
    const drawer = document.querySelector("#workspace-drawer.is-open");
    return drawer !== null && drawer.getBoundingClientRect().left === 0 && drawer.getAnimations().length === 0;
  });
}

const at = (hours: number): string => new Date(Date.now() + hours * 3600_000).toISOString();
const report = (): UsageReport => ({
  providers: [
    { id: "claude", key: "claude:u1", account: "me@example.com", plan: "max", problem: null, checked_at: at(0), windows: [
      { kind: "session", scope: null, used_percent: 42, resets_at: at(2.2), starts_at: at(2.2 - 5) },
      { kind: "week", scope: null, used_percent: 63.4, resets_at: at(82), starts_at: at(82 - 168) },
      { kind: "week", scope: "Sonnet", used_percent: 5, resets_at: null, starts_at: null },
    ], credits: { kind: "spend", currency: "USD", used: 12.19, limit: 15.39, used_percent: 79.2 } },
    { id: "codex", key: "codex:work", account: "me@work.example", plan: "pro", problem: null, checked_at: at(0), windows: [
      { kind: "session", scope: null, used_percent: 12, resets_at: at(0.8), starts_at: at(0.8 - 5) },
      { kind: "week", scope: null, used_percent: 91, resets_at: at(99), starts_at: at(99 - 168) },
    ], credits: { kind: "balance", balance: 1231.84, unlimited: false }, resets: { available: 1, expires_at: at(30.5) } },
    { id: "codex", key: "codex:home", account: "me@example.com", plan: "plus", problem: null, checked_at: "2026-09-29T12:00:00Z", windows: [
      { kind: "week", scope: null, used_percent: 30, resets_at: at(120), starts_at: null },
    ] },
    { id: "cursor", key: "cursor:c1", account: null, plan: "pro", problem: null, checked_at: "2026-09-29T12:00:00Z", windows: [{ kind: "month", scope: null, used_percent: 20, resets_at: at(300), starts_at: null }] },
    { id: "copilot", key: "copilot:me", account: "me", plan: "free", problem: null, checked_at: "2026-09-29T12:00:00Z", windows: [{ kind: "month", scope: "Chat", used_percent: 0, resets_at: at(34), starts_at: null }] },
    { id: "grok", key: "grok:g1", account: null, plan: null, problem: "rate_limited", checked_at: "2026-09-29T11:40:00Z", windows: [{ kind: "week", scope: null, used_percent: 0, resets_at: null, starts_at: null }] },
    { id: "antigravity", key: "antigravity@keychain", account: null, plan: null, problem: "expired", checked_at: null, windows: [] },
  ],
});

async function usageContext(browser: Browser, options: BrowserContextOptions): Promise<BrowserContext> {
  const context = await browser.newContext(options);
  await context.route((url) => url.pathname === "/api/agent-catalog", (route) => route.fulfill({ json: { platform: "linux", agents: [] } }));
  return context;
}

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
    const settingsButton = page.locator(".sidebar-footer-settings");
    const limits = page.locator('.segmented[aria-label="Plan limits"]');

    // off until chosen: nothing is shown and no sign-in is sent anywhere
    await settingsButton.waitFor();
    assert.equal(await strip.count(), 0);
    assert.deepEqual(asked, [], "no usage request before the user turns it on");
    await settingsButton.click();
    await openSettingsPage(page, "Agents");
    assert.equal(await limits.getByRole("button", { name: "Off", exact: true }).getAttribute("aria-pressed"), "true");
    await limits.getByRole("button", { name: "Remaining", exact: true }).click();
    await page.keyboard.press("Escape");
    await strip.waitFor();

    const chipCount = await page.locator(".usage-chip").count();
    const more = await page.locator(".usage-more").count() === 0 ? 0 : Number((await page.locator(".usage-more").textContent())!.slice(1));
    assert.equal(chipCount + more, 7, "every account is a chip or counted in +N");
    assert.ok(chipCount >= 4, `the row beside the Settings gear holds at least four chips (${chipCount})`);
    assert.equal(await strip.getAttribute("aria-label"),
      "Subscription usage: Claude · me@example.com 58% left, Codex · me@work.example 88% left (Weekly 9% left), Codex · me@example.com 70% left, Cursor 80% left, GitHub Copilot · me 100% left, Grok 100% left, Antigravity —");
    assert.deepEqual((await page.locator(".usage-chip-value").allTextContents()).slice(0, 4), ["58%", "88%", "70%", "80%"]);
    assert.equal(await page.locator(".usage-chip.is-high").count(), 0, "no session is near its end");
    assert.equal(await strip.evaluate((el) => el.scrollWidth <= el.clientWidth), true, "the chips fit beside Settings");
    const [settings, meters] = await Promise.all([page.locator(".sidebar-footer-settings").boundingBox(), strip.boundingBox()]);
    assert.ok(settings && meters && settings.x + settings.width <= meters.x, "Settings and the meters do not overlap");

    await strip.click();
    const popover = page.getByRole("dialog", { name: "Subscription usage", exact: true });
    await popover.waitFor();
    assert.equal(await popover.locator(".usage-provider").count(), 7);
    assert.equal(await popover.getByRole("meter").count(), 10);
    assert.equal(await popover.locator(".usage-account").first().textContent(), "me@example.com");
    assert.equal(await popover.locator(".usage-row.is-high").count(), 1);
    const rowText = (section: number) => popover.locator(".usage-provider").nth(section).locator(".usage-row").evaluateAll((rows) => rows.map((row) => [...row.children].map((cell) => cell.textContent).join("|")));
    assert.deepEqual((await rowText(0)).slice(3), ["Usage credits|$12.19 / $15.39|"]);
    assert.deepEqual((await rowText(1)).slice(2), ["Credits|1,232 credits", "Limit resets|Expires in 1d 6h|1 left"]);
    assert.equal(await popover.getByRole("meter", { name: "Usage credits", exact: true }).getAttribute("aria-valuenow"), "20.8", "the credits meter counts what is left, as the limits do");
    assert.equal(await popover.locator(".usage-row-label").evaluateAll((labels) => labels.every((label) => label.scrollWidth <= label.clientWidth)), true, "no row label is cut short");
    assert.equal(await popover.locator(".usage-note.is-problem").count(), 1, "only the expired sign-in reads as an error");
    if (process.env.UI_EVIDENCE_DIR) {
      mkdirSync(process.env.UI_EVIDENCE_DIR, { recursive: true });
      await page.locator(".sidebar-shell").screenshot({ path: join(process.env.UI_EVIDENCE_DIR, "usage-popover.png") });
    }
    const refreshed = page.waitForRequest((request) => {
      const url = new URL(request.url());
      return url.pathname === "/api/usage" && url.searchParams.get("refresh") === "1";
    });
    await popover.getByRole("button", { name: "Refresh", exact: true }).click();
    await refreshed;
    await page.keyboard.press("Escape");
    await popover.waitFor({ state: "hidden" });
    assert.equal(await strip.evaluate((el) => el === document.activeElement), true, "Escape hands focus back to the strip");

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

    await settingsButton.click();
    await openSettingsPage(page, "Agents");
    // The strip disappears before the shared preference's debounced save. Reload only once
    // the server has taken OFF, or its older ON value will turn usage back on during hydration.
    const usageOffSaved = page.waitForResponse((response) => response.request().method() === "PUT"
      && new URL(response.url()).pathname === "/api/preferences" && response.ok()
      && response.request().postDataJSON()?.settings?.showUsage === false, { timeout: 10_000 });
    await limits.getByRole("button", { name: "Off", exact: true }).click();
    await strip.waitFor({ state: "detached" });
    assert.equal(await page.locator("[data-section='other-accounts'] .settings-condition").count(), 1, "Other accounts says plan limits show them");
    assert.equal(await page.locator(".usage-provider").count(), 0, "disabled meters leave no provider placeholders");
    await usageOffSaved;
    await context.setExtraHTTPHeaders({ [RELOADED]: "1" });
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
    await page.locator("html[data-usage-preferences-hydrated]").waitFor();
    assert.deepEqual(afterReload, [], "a hidden strip asks for nothing");
    await context.setExtraHTTPHeaders({});
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }

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
    await openUsageDrawer(page);
    await page.locator(".usage-strip").click();
    const popover = page.getByRole("dialog", { name: "Subscription usage", exact: true });
    await popover.waitFor();
    const box = await popover.boundingBox();
    assert.ok(box && box.x >= 0 && box.y >= 0 && box.x + box.width <= 390, "the popover stays inside the phone's screen");
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    assert.equal(await popover.locator(".usage-row-label").evaluateAll((labels) => labels.every((label) => label.scrollWidth <= label.clientWidth)), true, "no row label is cut short on a phone");
    if (process.env.UI_EVIDENCE_DIR) await page.locator(".sidebar-shell").screenshot({ path: join(process.env.UI_EVIDENCE_DIR, "usage-popover-phone.png") });

    await page.keyboard.press("Escape");
    await page.locator(".sidebar-footer-settings").click();
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
  await checkFailures(browser, origin);
  await checkRecordedAccounts(browser, origin);
}

const recordedReport = (): UsageReport => ({
  providers: [
    { id: "claude", key: "claude:recorded", account: "omp@example.com", plan: null, problem: null, checked_at: at(0), recorded: { by: "omp", stale: false, signed_in: false }, windows: [
      { kind: "session", scope: null, used_percent: 31, resets_at: at(3), starts_at: at(3 - 5) },
      { kind: "week", scope: null, used_percent: 52, resets_at: at(76), starts_at: at(76 - 168) },
    ] },
    { id: "claude", key: "claude:stale", account: "idle@example.com", plan: null, problem: null, checked_at: at(-3), recorded: { by: "omp", stale: true, signed_in: false }, windows: [
      { kind: "session", scope: null, used_percent: 87, resets_at: at(1.4), starts_at: at(1.4 - 5) },
    ] },
    { id: "codex", key: "codex:work", account: "me@work.example", plan: "pro", problem: null, checked_at: at(0), windows: [
      { kind: "session", scope: null, used_percent: 12, resets_at: at(0.8), starts_at: at(0.8 - 5) },
    ] },
  ],
});

const standInReport = (): UsageReport => ({
  providers: [
    { id: "claude", key: "claude:team", account: "me@team.example", plan: "max", problem: "expired", checked_at: at(0), recorded: { by: "omp", stale: false, signed_in: true }, windows: [
      { kind: "session", scope: null, used_percent: 31, resets_at: at(3), starts_at: at(3 - 5) },
      { kind: "week", scope: null, used_percent: 91, resets_at: at(76), starts_at: at(76 - 168) },
    ] },
    { id: "claude", key: "claude:home", account: "me@example.com", plan: "pro", problem: null, checked_at: at(-3), recorded: { by: "omp", stale: true, signed_in: true }, windows: [
      { kind: "session", scope: null, used_percent: 87, resets_at: at(1.4), starts_at: at(1.4 - 5) },
    ] },
    { id: "claude", key: "claude:mac", account: "mac@example.com", plan: null, problem: "locked", checked_at: at(0), recorded: { by: "omp", stale: false, signed_in: true }, windows: [
      { kind: "session", scope: null, used_percent: 20, resets_at: at(4), starts_at: at(4 - 5) },
    ] },
    { id: "claude", key: "claude:slow", account: "slow@example.com", plan: null, problem: "rate_limited", checked_at: at(0), recorded: { by: "omp", stale: false, signed_in: true }, windows: [
      { kind: "session", scope: null, used_percent: 50, resets_at: at(2), starts_at: at(2 - 5) },
    ] },
  ],
});

const lineCounts = (target: ReturnType<Page["locator"]>): Promise<number[]> => target.evaluateAll((elements) => elements.map((element) => {
  const range = document.createRange();
  range.selectNodeContents(element);
  return new Set([...range.getClientRects()].map((rect) => Math.round(rect.top))).size;
}));

/**
 * An account another tool recorded is never drawn as a reading of the server's own: its chip's bar is dotted and the
 * popover, the strip's name and Settings say who recorded it and when. A stale one says it may have changed and loses
 * its alarm colour. Known from the record alone, it is no sign-in of Claude Code, whose row still offers Sign in;
 * standing in for the numbers of a sign-in this PC holds, it leaves that sign-in its plan, its problem and Sign in again.
 */
async function checkRecordedAccounts(browser: Browser, origin: string): Promise<void> {
  const reset = await fetch(`${origin}/api/preferences`, { method: "PUT", headers: { "content-type": "application/json", origin }, body: JSON.stringify({ settings: { showUsage: true, usageOrder: [], usageHidden: [], usageCount: "left", usageGlance: "session" } }) });
  assert.equal(reset.status, 200);
  const installed = { installed: true, binary: "/usr/bin/claude", on_path: true, version: "2.1.311", version_error: null, meets_min_version: true };
  const claudeCode = catalogRow(AGENT_CATALOG.find((entry) => entry.id === "claude")!, "linux", installed);
  const staged = async (context: BrowserContext, report: () => UsageReport = recordedReport): Promise<void> => {
    await context.route((url) => url.pathname === "/api/agent-catalog", (route) => route.fulfill({ json: { platform: "linux", agents: [claudeCode] } }));
    await context.route("**/api/usage/statusline", (route) => route.fulfill({ json: { installed: false, supported: true } }));
    await context.route("**/api/usage*", (route) => route.fulfill({ json: report() }));
    await context.addInitScript(() => localStorage.setItem("ovis:settings", JSON.stringify({ showUsage: true })));
  };
  const notes = (popover: ReturnType<Page["locator"]>) => popover.locator(".usage-provider").evaluateAll((sections) =>
    sections.map((section) => [...section.querySelectorAll(".usage-recorded > span")].map((line) => line.textContent)));
  const chips = (page: Page) => page.locator(".usage-chip").evaluateAll((all) =>
    all.map((chip) => [chip.querySelector(".usage-chip-value")?.textContent, ...["has-problem", "is-recorded", "is-stale"].filter((name) => chip.classList.contains(name))]));
  const inks = (page: Page) => page.evaluate(() => {
    const probe = document.body.appendChild(document.createElement("span"));
    const ink = (token: string): string => { probe.style.color = `var(${token})`; return getComputedStyle(probe).color; };
    const found = { alarm: ink("--status-blocked"), dim: ink("--text-dim") };
    probe.remove();
    return found;
  });
  const accountRows = (row: ReturnType<Page["locator"]>) => row.locator(".usage-accounts-row").evaluateAll((rows) => rows.map((account) =>
    [...account.querySelectorAll(".usage-account-meta > span")].map((cell) => `${cell.textContent}${cell.classList.contains("has-problem") ? " (problem)" : ""}${cell.classList.contains("is-recorded") ? " (record)" : ""}`)));

  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: "en-US" });
  try {
    await staged(context);
    const page = await context.newPage();
    await page.goto(origin);
    const strip = page.locator(".usage-strip");
    await strip.waitFor();
    assert.deepEqual(await chips(page), [["69%", "is-recorded"], ["13%", "is-recorded", "is-stale"], ["88%"]]);
    const { alarm, dim } = await inks(page);
    assert.notEqual(alarm, dim);
    const staleChip = page.locator(".usage-chip.is-stale.is-high");
    assert.equal(await staleChip.count(), 1);
    assert.equal(await staleChip.locator(".usage-chip-value").evaluate((value) => getComputedStyle(value).color), dim, "a stale record's percent is drawn in the dim ink, not the colour of a limit near its end");
    assert.equal((await staleChip.locator(".usage-chip-bar").evaluate((bar) => getComputedStyle(bar).backgroundImage)).includes(alarm), false, "a stale record's bar is not red either");
    assert.equal(await strip.getAttribute("aria-label"),
      "Subscription usage: Claude · omp@example.com 69% left (Recorded by Oh My Pi, just now), Claude · idle@example.com 13% left (Recorded by Oh My Pi, 3 h ago · It may have changed since.), Codex · me@work.example 88% left");

    await strip.click();
    const popover = page.getByRole("dialog", { name: "Subscription usage", exact: true });
    await popover.waitFor();
    assert.deepEqual(await notes(popover), [["Recorded by Oh My Pi, just now"], ["Recorded by Oh My Pi, 3 h ago", "It may have changed since."], []]);
    assert.deepEqual(await popover.locator(".usage-provider").evaluateAll((sections) => sections.map((section) => section.classList.contains("is-stale"))), [false, true, false]);
    const stale = popover.locator(".usage-provider.is-stale");
    assert.deepEqual(await stale.locator(".usage-row.is-high").first().evaluate((row) => [getComputedStyle(row.querySelector(".usage-row-value")!).color, getComputedStyle(row.querySelector(".usage-bar > span")!).backgroundColor]), [dim, dim],
      "a stale record's 13% left and its bar are drawn in the dim ink, not red");
    assert.equal(await popover.locator(".usage-note.is-problem").count(), 0, "a record is no problem of a sign-in");
    assert.equal(await popover.getByRole("button", { name: /Sign in again/ }).count(), 0);
    if (process.env.UI_EVIDENCE_DIR) await page.locator(".sidebar-shell").screenshot({ path: join(process.env.UI_EVIDENCE_DIR, "usage-recorded-popover.png") });

    await page.keyboard.press("Escape");
    await page.locator(".sidebar-footer-settings").click();
    await openSettingsPage(page, "Agents");
    const row = page.locator('.agents-item[data-agent="claude"]');
    await row.getByRole("button", { name: "Sign in to Claude Code", exact: true }).waitFor();
    assert.equal(await row.locator(".agents-state").textContent(), "Not signed in");
    await row.locator(".agents-toggle").click();
    await row.locator(".usage-accounts-row").nth(1).waitFor();
    assert.deepEqual(await accountRows(row), [["Recorded by Oh My Pi · Session 69% left", "just now (record)"], ["Recorded by Oh My Pi · Session 13% left", "Old record · 3 h ago (record)"]]);
    assert.equal(await row.getByRole("button", { name: /Sign in again/ }).count(), 0);
    if (process.env.UI_EVIDENCE_DIR) await page.getByRole("tabpanel", { name: "Agents", exact: true }).screenshot({ path: join(process.env.UI_EVIDENCE_DIR, "usage-recorded-settings.png") });
    // removing one forgets a list entry: what stays is the tool's record, not a sign-in of this PC's
    await row.getByRole("button", { name: "Remove Claude · omp@example.com", exact: true }).click();
    const confirmation = page.getByRole("alertdialog");
    assert.match(await confirmation.locator(".confirm-body").textContent() ?? "", /Oh My Pi keeps its record of it/);
    await confirmation.getByRole("button", { name: "Cancel", exact: true }).click();
    await confirmation.waitFor({ state: "detached" });
  } finally {
    await context.close();
  }

  const signedIn = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: "en-US" });
  try {
    await staged(signedIn, standInReport);
    const page = await signedIn.newPage();
    await page.goto(origin);
    const strip = page.locator(".usage-strip");
    await strip.waitFor();
    const drawn = await chips(page);
    assert.ok(drawn.length >= 2);
    assert.deepEqual(drawn, [["69%", "is-recorded"], ["13%", "is-recorded", "is-stale"], ["80%", "is-recorded"], ["50%", "is-recorded"]].slice(0, drawn.length));
    await strip.click();
    const popover = page.getByRole("dialog", { name: "Subscription usage", exact: true });
    await popover.waitFor();
    const fresh = ["Recorded by Oh My Pi, just now"];
    assert.deepEqual(await notes(popover), [fresh, ["Recorded by Oh My Pi, 3 h ago", "It may have changed since."], fresh, fresh]);
    assert.deepEqual(await popover.locator(".usage-plan").allTextContents(), ["max", "pro"]);
    assert.deepEqual(await popover.locator(".usage-provider").evaluateAll((sections) => sections.map((section) => [...section.querySelectorAll(".usage-note:not(.usage-recorded)")].map((note) => note.textContent))),
      [["Sign-in expired."], [], ["The server cannot open the keychain holding this sign-in."], []]);
    assert.equal(await popover.getByRole("button", { name: /^Sign in again/ }).count(), 1);
    assert.equal(await popover.getByRole("button", { name: "Sign in again to Claude · me@team.example", exact: true }).count(), 1);
    const { alarm } = await inks(page);
    assert.equal(await popover.locator(".usage-provider:not(.is-stale) .usage-row.is-high .usage-bar > span").evaluate((bar) => getComputedStyle(bar).backgroundColor), alarm);
    if (process.env.UI_EVIDENCE_DIR) await page.locator(".sidebar-shell").screenshot({ path: join(process.env.UI_EVIDENCE_DIR, "usage-recorded-signed-in-popover.png") });

    await page.keyboard.press("Escape");
    await page.locator(".sidebar-footer-settings").click();
    await openSettingsPage(page, "Agents");
    const row = page.locator('.agents-item[data-agent="claude"]');
    await row.getByRole("button", { name: "Sign in again to Claude · me@team.example", exact: true }).waitFor();
    assert.equal(await row.locator(".agents-state").textContent(), "4 accounts · 3 need attention");
    assert.equal(await row.getByRole("button", { name: "Sign in to Claude Code", exact: true }).count(), 0);
    await row.locator(".agents-toggle").click();
    await row.locator(".usage-accounts-row").nth(3).waitFor();
    assert.deepEqual(await accountRows(row), [
      ["Recorded by Oh My Pi · just now · max · Session 69% left", "Expired (problem)"],
      ["Recorded by Oh My Pi · Old record · 3 h ago · pro · Session 13% left", "Signed in"],
      ["Recorded by Oh My Pi · just now · Session 80% left", "Failed (problem)"],
      ["Recorded by Oh My Pi · just now · Session 50% left", "Failed (problem)"],
    ]);
    if (process.env.UI_EVIDENCE_DIR) await page.getByRole("tabpanel", { name: "Agents", exact: true }).screenshot({ path: join(process.env.UI_EVIDENCE_DIR, "usage-recorded-signed-in-settings.png") });
  } finally {
    await signedIn.close();
  }

  const kept = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: "en-US" });
  try {
    await staged(kept, () => ({ server_time: at(-1), providers: [{ id: "claude", key: "claude:kept", account: "kept@example.com", plan: null, problem: null, checked_at: at(-1 - 4 / 60), recorded: { by: "gjc", stale: false, signed_in: false }, windows: [
      { kind: "session", scope: null, used_percent: 40, resets_at: at(2), starts_at: at(2 - 5) },
    ] }] }));
    const page = await kept.newPage();
    await page.clock.install();
    await page.goto(origin);
    const strip = page.locator(".usage-strip");
    await strip.waitFor();
    assert.deepEqual(await chips(page), [["60%", "is-recorded"]]);
    await kept.route("**/api/usage*", () => {});
    await page.clock.setSystemTime(Date.now() - 15 * 60_000);
    await page.clock.fastForward(12 * 60_000);
    await page.locator(".usage-chip.is-stale").waitFor();
    assert.deepEqual(await chips(page), [["60%", "is-recorded", "is-stale"]]);
    await strip.click();
    const popover = page.getByRole("dialog", { name: "Subscription usage", exact: true });
    await popover.waitFor();
    const [lines] = await notes(popover);
    assert.match(lines?.[0] ?? "", /^Recorded by Gajae Code, /);
    assert.equal(lines?.[1], "It may have changed since.");
  } finally {
    await kept.close();
  }

  const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, locale: "en-US" });
  try {
    await staged(phone);
    const page = await phone.newPage();
    await page.goto(origin);
    await openUsageDrawer(page);
    await page.locator(".usage-strip").click();
    const popover = page.getByRole("dialog", { name: "Subscription usage", exact: true });
    await popover.waitFor();
    const box = await popover.boundingBox();
    assert.ok(box && box.x >= 0 && box.x + box.width <= 390, "the popover stays inside the phone's screen");
    assert.deepEqual(await lineCounts(popover.locator(".usage-recorded > span")), [1, 1, 1]);
    if (process.env.UI_EVIDENCE_DIR) await page.locator(".sidebar-shell").screenshot({ path: join(process.env.UI_EVIDENCE_DIR, "usage-recorded-popover-phone.png") });
    await page.keyboard.press("Escape");
    await page.locator(".sidebar-footer-settings").click();
    await openSettingsPage(page, "Agents");
    const row = page.locator('.agents-item[data-agent="claude"]');
    await row.locator(".agents-toggle").click();
    const accounts = row.locator(".usage-accounts-row");
    await accounts.nth(1).waitFor();
    assert.equal(await accounts.evaluateAll((rows) => rows.every((account) => account.scrollWidth <= account.clientWidth)), true, "each account row fits the phone");
    assert.deepEqual(await lineCounts(accounts.locator(".usage-account-fact:last-child")), [1, 1]);
    if (process.env.UI_EVIDENCE_DIR) await page.getByRole("tabpanel", { name: "Agents", exact: true }).screenshot({ path: join(process.env.UI_EVIDENCE_DIR, "usage-recorded-settings-phone.png") });
  } finally {
    await phone.close();
  }
  console.log("PASS accounts another tool recorded: dotted chip, recorder and age in the popover, strip and Settings, a stale one dimmed and no alarm, no sign-in of Claude Code from a record alone, a sign-in kept with its plan, problem and Sign in again while a record stands in, phone fit");
}

/** Only on or off is sent, and nothing reaches the test server's own home. */
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
    await offer.waitFor({ state: "detached" });
    await page.locator(".usage-row").first().waitFor();
    assert.deepEqual(posted, [{ enabled: true }]);

    await page.keyboard.press("Escape");
    await page.locator(".sidebar-footer-settings").click();
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

/** Each failed read says what it ran into; Claude's on this PC offers its status line for a failure and a 429 too. */
async function checkFailures(browser: Browser, origin: string): Promise<void> {
  for (const phone of [false, true]) {
    const context = await usageContext(browser, { viewport: phone ? { width: 390, height: 844 } : { width: 1280, height: 800 }, locale: "en-US", ...(phone ? { hasTouch: true, isMobile: true } : {}) });
    try {
      await context.route("**/api/usage/statusline", (route) => route.fulfill({ json: { installed: false, supported: true } }));
      await context.route("**/api/usage*", (route) => route.fulfill({ json: { providers: [
        { id: "claude", key: "claude:u1", account: "me@example.com", plan: "max", problem: "failed", failure: "upstream", checked_at: null, windows: [], statusline_offer: true },
        { id: "claude", key: "claude:cliproxy:hub-1.json", account: "hub@example.com", plan: null, problem: "failed", failure: "hub", checked_at: null, windows: [] },
        { id: "codex", key: "codex:c1", account: "me@example.com", plan: "pro", problem: "failed", failure: "timeout", checked_at: null, windows: [] },
        { id: "cursor", key: "cursor:c1", account: null, plan: "pro", problem: "failed", failure: "bad_response", checked_at: null, windows: [] },
        { id: "grok", key: "grok:g1", account: null, plan: null, problem: "failed", failure: "network", checked_at: null, windows: [] },
        { id: "copilot", key: "copilot:me", account: "me", plan: "free", problem: "failed", checked_at: null, windows: [] },
      ] } satisfies UsageReport }));
      await context.addInitScript(() => localStorage.setItem("ovis:settings", JSON.stringify({ showUsage: true })));
      const page = await context.newPage();
      await page.goto(origin);
      if (phone) await openUsageDrawer(page);
      await page.locator(".usage-strip").click();
      const popover = page.getByRole("dialog", { name: "Subscription usage", exact: true });
      await popover.waitFor();
      // in whatever order the shared account order puts them
      assert.deepEqual((await popover.locator(".usage-note.is-problem").allTextContents()).sort(), [
        "Claude is busy or down. Try again later.",
        "Codex took too long to answer.",
        "Cursor sent an answer Ovis cannot read.",
        "GitHub Copilot could not be reached.",
        "Hub could not read this account.",
        "This PC could not connect to Grok.",
      ]);
      assert.equal(await popover.getByRole("button", { name: "Read from Claude's status line instead", exact: true }).count(), 1, "offered for the failed Claude on this PC only");
      assert.equal(await popover.locator(".usage-note").evaluateAll((notes) => notes.every((note) => note.scrollWidth <= note.clientWidth)), true, "every note fits");
      if (process.env.UI_EVIDENCE_DIR) await page.locator(".sidebar-shell").screenshot({ path: join(process.env.UI_EVIDENCE_DIR, `usage-failures${phone ? "-phone" : ""}.png`) });
    } finally {
      await context.close();
    }
  }
  console.log("PASS a failed read names what it ran into, a Hub account's the Hub, and a failed Claude on this PC offers its status line, desktop and phone");
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
  const reset = await fetch(`${origin}/api/preferences`, { method: "PUT", headers: { "content-type": "application/json", origin }, body: JSON.stringify({ settings: { usageOrder: [] } }) });
  assert.equal(reset.status, 200, "the shared account order is cleared");
  for (const phone of [false, true]) {
    const context = await usageContext(browser, { viewport: phone ? { width: 390, height: 844 } : { width: 1280, height: 800 }, locale: "en-US", ...(phone ? { hasTouch: true, isMobile: true } : {}) });
    try {
      const posted: unknown[] = [];
      const answers = [
        { status: 409, json: { error: { code: "cli_unavailable", message: "Install the official CLI on this PC before signing in" } } },
        { status: 200, json: { login_id: "00000000-0000-4000-8000-000000000009", device_auth: false } },
      ];
      const tab = { status: 200, json: { pane_id: "w9:p9", workspace_id: "w9", manual: false, device_auth: false } };
      const cancelled: unknown[] = [];
      const events: string[] = [];
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
      await context.route("**/api/usage/login?provider=*", (route) => route.fulfill({ json: { accounts: ["me@team.example"] } }));
      await context.route("**/api/usage/login/prompt*", (route) => route.fulfill({ json: { provider: "claude", url: null, user_code: null, wants_code: false, ended: false } }));
      await context.route((url) => url.pathname === "/api/usage/login" && !url.searchParams.has("provider"), (route) => {
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
      const openDrawer = async () => { if (phone) await openUsageDrawer(page); };
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
      const following = page.getByRole("dialog", { name: "Sign in to Claude Code", exact: true });
      await again.click();
      await popover.waitFor({ state: "detached" });
      await following.getByRole("alert").filter({ hasText: "Install the official CLI on this PC before signing in" }).waitFor();
      await following.getByRole("button", { name: "Done", exact: true }).click();
      await following.waitFor({ state: "detached" });
      if (!(await page.locator(".usage-strip").isVisible())) await openDrawer();
      await page.locator(".usage-strip").click();
      await popover.getByRole("button", { name: /^Sign in again/ }).click();
      await following.getByText("Waiting for Claude to show its sign-in page…", { exact: true }).waitFor();
      await following.getByRole("button", { name: "Open terminal", exact: true }).click();
      await following.waitFor({ state: "detached" });

      await openDrawer();
      await page.locator(".sidebar-footer-settings").click();
      await openSettingsPage(page, "Agents");
      const rows = page.locator(".usage-accounts-row");
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
    await page.locator(".sidebar-footer-settings").click();
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
