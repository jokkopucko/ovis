import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { buildDemoApp, buildDevelopmentDemoApp } from "./demo-build.ts";
import { DEMO_FILE_PREVIEW_SCRIPT } from "./demo-file-preview.ts";
import { openSettingsFolds, openSettingsPage, themeSide } from "./settings-page.ts";
import { SETTINGS, closeSettings, dialogOf, historyHolds, openPalette, openSettings } from "./settings-pages-harness.ts";
import { DEFAULT_SETTINGS, TERMINAL_FONT_MAX, TERMINAL_FONT_MIN } from "../src/lib/settings.ts";
import { checkChromeTmpdir } from "./chrome-path.ts";

// All files and HTTP traffic stay in these disposable, loopback-only apps; no herdr session is opened.
const app = mkdtempSync(join(tmpdir(), "herdr-settings-demo-"));
const devApp = mkdtempSync(join(tmpdir(), "herdr-settings-dev-"));

const HOLD_VOICE = `(() => {
  const fetch = window.fetch, held = [];
  let holding = true, asked = 0, made = 0;
  window.voiceAsked = () => asked;
  window.releaseVoice = () => { holding = false; for (const go of held.splice(0)) go(); };
  window.fetch = (input, init) => {
    const path = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, location.href).pathname;
    if (!holding || path !== "/api/voice") return fetch(input, init);
    asked += 1;
    return new Promise((resolve) => held.push(() => resolve(fetch(input, init))));
  };
  const Native = window.ResizeObserver, live = new Set();
  window.groupObservers = () => ({ made, live: live.size });
  window.ResizeObserver = class extends Native {
    observe(node, options) { if (node.dataset && node.dataset.section === "openai-key") { made += 1; live.add(this); } return super.observe(node, options); }
    disconnect() { live.delete(this); return super.disconnect(); }
  };
})();
`;
interface HeldVoice { voiceAsked: () => number; releaseVoice: () => void; groupObservers: () => { made: number; live: number } }

/**
 * The OpenAI key's group, whose form waits for the server's answer, on React's development build:
 * StrictMode runs the landing's effect, its cleanup and the effect again, and the group is still
 * followed into view when the held answer comes.
 */
async function heldGroupLanding(browser: import("playwright-core").Browser, url: string): Promise<void> {
  const context = await browser.newContext({ viewport: { width: 390, height: 480 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true, locale: "en" });
  try {
    await context.addInitScript((settings) => localStorage.setItem("ovis:settings", settings), JSON.stringify(SETTINGS));
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const body = page.locator(".settings-body:not([hidden])");
    const observers = () => page.evaluate(() => (window as unknown as HeldVoice).groupObservers());
    const land = async (): Promise<void> => {
      await page.goto(url);
      await page.locator(".conn-live").waitFor({ state: "attached" });
      const asked = await page.evaluate(() => (window as unknown as HeldVoice).voiceAsked());
      await openPalette(page, "OpenAI API key");
      await page.locator(".palette-section[data-section='settings-pages'] [role='option']").first().click();
      await page.waitForFunction((asked) => (document.activeElement as HTMLElement | null)?.dataset.section === "openai-key" && (window as unknown as HeldVoice).voiceAsked() > asked, asked);
      assert.equal(await page.locator(".voice-key").count(), 0, "the key's form waits for the held answer");
    };
    await land();
    const replayed = await observers();
    assert.equal(replayed.live, 1, `one observer still follows the group after StrictMode's cleanup of the landing (${JSON.stringify(replayed)})`);
    assert.ok(replayed.made >= 2, `the follow was set up again after the replay's cleanup (${replayed.made} observers made)`);
    await page.evaluate(() => (window as unknown as HeldVoice).releaseVoice());
    await page.locator(".voice-key input").waitFor();
    await page.waitForFunction(() => {
      const body = document.querySelector(".settings-body:not([hidden])")?.getBoundingClientRect();
      const control = document.querySelector("[data-section='openai-key'] input")?.getBoundingClientRect();
      return body !== undefined && control !== undefined && control.top >= body.top - 1 && control.bottom <= body.bottom + 1;
    });

    await land();
    assert.ok(await body.evaluate((node) => node.scrollTop) > 0, "the landing scrolled to the group");
    await page.keyboard.press("Home");
    await page.waitForFunction(() => document.querySelector(".settings-body:not([hidden])")?.scrollTop === 0);
    await page.evaluate(() => (window as unknown as HeldVoice).releaseVoice());
    await page.locator(".voice-key input").waitFor();
    await page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
    assert.equal(await body.evaluate((node) => node.scrollTop), 0, "a reader who scrolled away is not pulled back");
    assert.equal((await observers()).live, 0, "the reader's scroll ended the follow");
    assert.deepEqual(errors, []);
    console.log("PASS under development StrictMode the OpenAI key's group is followed into view when its held form arrives, and a reader's scroll ends it");
  } finally {
    await context.close();
  }
}

async function focusAndLandings(browser: import("playwright-core").Browser, url: string): Promise<void> {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "en" });
  try {
    await context.addInitScript((settings) => localStorage.setItem("ovis:settings", settings), JSON.stringify(SETTINGS));
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(url);
    await page.locator(".conn-live").waitFor({ state: "attached" });
    await openSettings(page);
    const dialog = dialogOf(page);
    const focusedOn = (selector: string) => page.evaluate((selector) => document.activeElement?.matches(selector) ?? false, selector);

    await openSettingsPage(page, "Terminal");
    await dialog.getByRole("tab", { name: "Terminal", exact: true }).click();
    await dialog.getByRole("button", { name: "Edit key bar", exact: true }).click();
    await page.getByRole("dialog", { name: "Key bar", exact: true }).waitFor();
    await page.locator(".settings-dialog").getByRole("button", { name: "Back to settings", exact: true }).click();
    await dialog.getByRole("tabpanel", { name: "Terminal", exact: true }).waitFor();
    assert.equal(await page.evaluate(() => document.activeElement?.textContent), "Edit key bar", "after a press on the open page's tab, Back from the key bar editor returns to Edit key bar");

    const search = dialog.getByRole("searchbox", { name: "Search settings", exact: true });
    const results = dialog.getByRole("region", { name: "Search results", exact: true });
    await search.fill("webhook");
    await results.locator("[data-section='alert-webhook']").waitFor();
    await results.getByRole("button", { name: "Open Alerts", exact: true }).click();
    await dialog.getByRole("tabpanel", { name: "Alerts", exact: true }).waitFor();
    await page.waitForFunction(() => (document.activeElement as HTMLElement | null)?.dataset.section === "alert-webhook", undefined, { timeout: 10_000 });

    await search.fill("openai api key");
    const key = results.locator('input[aria-label="OpenAI API key"]');
    const save = results.getByRole("button", { name: "Save key", exact: true });
    await key.fill("sk-fixture");
    assert.equal(await save.isEnabled(), true, "a typed key can be saved");
    await search.fill("zzqxv nothing");
    await dialog.getByRole("status").filter({ hasText: "No settings match." }).waitFor();
    await search.fill("openai api key");
    await key.waitFor();
    assert.equal(await key.inputValue(), "", "the key's field comes back empty");
    assert.equal(await save.isDisabled(), true, "Save waits for a key typed again");

    await search.fill("");
    await openSettingsPage(page, "Agents");
    await page.evaluate(() => {
      const passing = window.fetch, held: (() => void)[] = [];
      (window as unknown as { releaseCatalog: () => void }).releaseCatalog = () => { window.fetch = passing; for (const go of held.splice(0)) go(); };
      window.fetch = (input, init) => new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, location.href).pathname === "/api/agent-catalog"
        ? new Promise<Response>((resolve) => held.push(() => resolve(passing(input, init))))
        : passing(input, init);
    });
    await dialog.getByRole("button", { name: "Check again", exact: true }).focus();
    await page.keyboard.press("Enter");
    await dialog.getByRole("button", { name: "Checking…", exact: true }).waitFor();
    assert.equal(await focusedOn(".agents-check-again"), true, "a pressed Check again keeps the focus while it reads");
    await page.evaluate(() => (window as unknown as { releaseCatalog: () => void }).releaseCatalog());
    await dialog.getByRole("button", { name: "Check again", exact: true }).waitFor();
    assert.equal(await focusedOn(".agents-check-again"), true, "and once the read lands");
    assert.deepEqual(errors, []);
    console.log("PASS at 1440 a no-op tab press, a group the server fills in, a key field drawn again and Check again keep the focus and Save where they belong");
  } finally {
    await context.close();
  }
}

async function dialogSearch(browser: import("playwright-core").Browser, url: string): Promise<void> {
  for (const width of [1440, 390] as const) {
    const context = await browser.newContext(width === 390 ? { viewport: { width, height: 844 }, isMobile: true, hasTouch: true, locale: "en" } : { viewport: { width, height: 900 }, locale: "en" });
    try {
      await context.addInitScript((settings) => localStorage.setItem("ovis:settings", settings), JSON.stringify(SETTINGS));
      const page = await context.newPage();
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(url);
      await page.locator(".conn-live").waitFor({ state: "attached" });
      await openSettings(page);
      const dialog = dialogOf(page);
      const search = dialog.getByRole("searchbox", { name: "Search settings", exact: true });
      const results = dialog.getByRole("region", { name: "Search results", exact: true });
      const shown = () => results.evaluate((region) => [...region.querySelectorAll<HTMLElement>(".settings-search-page")].filter((section) => section.checkVisibility())
        .map((section) => [section.getAttribute("aria-label"), [...section.querySelectorAll<HTMLElement>("[data-setting]")].filter((row) => row.checkVisibility()).map((row) => row.querySelector(".settings-label")?.textContent ?? "")] as const));

      for (const words of ["test notification", "push alerts arrive"]) {
        await search.fill(words);
        const alerts = await shown();
        assert.deepEqual(alerts.map(([name]) => name), ["Alerts"], `${width}px: "${words}" finds a setting on Alerts`);
        assert.ok(alerts[0]?.[1].includes("Test notification"), `${width}px: "${words}" finds Test notification`);
      }

      await search.fill("Font SIZE");
      const found = await shown();
      assert.deepEqual(found.map(([name]) => name), ["Appearance"], `${width}px: "font size" finds settings on Appearance only`);
      for (const [name, label] of [["Appearance", "Interface font size"], ["Appearance", "Chat font"], ["Appearance", "Terminal font"]] as const) {
        assert.ok(found.find(([page]) => page === name)?.[1].includes(label), `${width}px: ${label} is found under ${name}`);
      }
      assert.equal(await dialog.getByRole("tablist").isVisible(), width !== 390, `${width}px: a phone's results take the list's place`);

      await results.getByRole("button", { name: "Increase terminal font size", exact: true }).click();
      await page.waitForFunction(() => JSON.parse(localStorage.getItem("ovis:settings") ?? "{}").terminalFontSize === 14);
      const typedSize = results.getByRole("group", { name: "Terminal font size", exact: true }).getByRole("textbox", { name: "Terminal font size", exact: true });
      assert.equal(await typedSize.inputValue(), "14");
      assert.equal(await results.getByRole("group", { name: "Terminal font size", exact: true }).locator('[aria-live="polite"]').textContent(), "14px", `${width}px: a stepped size is announced`);
      // a finger's field is read at --fs-input or larger, so iOS does not zoom into it
      if (width === 390) assert.ok(await typedSize.evaluate((input) => {
        const probe = document.createElement("span");
        probe.style.fontSize = "var(--fs-input)";
        document.body.append(probe);
        const least = Number.parseFloat(getComputedStyle(probe).fontSize);
        probe.remove();
        return Number.parseFloat(getComputedStyle(input).fontSize) >= least;
      }), `${width}px: the typed size is read at --fs-input or larger`);
      await typedSize.fill("30");
      await typedSize.press("Enter");
      assert.equal(await typedSize.inputValue(), "14", `${width}px: a size out of range is refused`);
      const rangeLine = results.locator(`[id="${await typedSize.getAttribute("aria-describedby")}"]`);
      assert.equal(await rangeLine.textContent(), "Enter 10–22px", `${width}px: the field is described by its range`);
      assert.equal(await rangeLine.isVisible(), true, `${width}px: a refused size shows the range`);
      await typedSize.focus();
      await typedSize.selectText();
      await page.keyboard.insertText("200");
      assert.equal(await typedSize.inputValue(), "200", `${width}px: a pasted number is kept whole`);
      assert.equal(await rangeLine.evaluate((node) => node.classList.contains("visually-hidden")), true, `${width}px: the next edit hides the range line`);
      await typedSize.press("Enter");
      assert.equal(await typedSize.inputValue(), "14", `${width}px: a pasted size out of range is refused`);
      assert.equal(await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => done(JSON.parse(localStorage.getItem("ovis:settings") ?? "{}").terminalFontSize)))), 14, `${width}px: a refused paste saves nothing`);
      await typedSize.fill("16");
      await typedSize.press("Enter");
      await page.waitForFunction(() => JSON.parse(localStorage.getItem("ovis:settings") ?? "{}").terminalFontSize === 16);
      await typedSize.fill("１８");
      assert.equal(await typedSize.inputValue(), "１８", `${width}px: the typed full-width digits stay as typed until they are taken`);
      await typedSize.press("Enter");
      await page.waitForFunction(() => JSON.parse(localStorage.getItem("ovis:settings") ?? "{}").terminalFontSize === 18);
      assert.equal(await typedSize.inputValue(), "18", `${width}px: a full-width size is shown in plain digits`);
      await typedSize.fill("14");
      await typedSize.press("Enter");
      await page.waitForFunction(() => JSON.parse(localStorage.getItem("ovis:settings") ?? "{}").terminalFontSize === 14);

      await search.fill("quick replies");
      assert.deepEqual(await shown(), [["Chat", ["Show above the message box"]]], `${width}px: the Quick replies group's setting is found by the group's name`);
      await search.fill("openai api key");
      await results.locator('input[aria-label="OpenAI API key"]').waitFor();

      await search.click();
      await search.fill("sound");
      const playSounds = results.getByRole("switch", { name: "Play sounds", exact: true });
      await playSounds.focus();
      assert.equal(await page.locator(".settings-help").count(), 0, `${width}px: a focus the keyboard did not move shows no sentence`);
      await page.keyboard.press("Escape");
      assert.equal(await search.inputValue(), "", `${width}px: Escape on a result empties the search`);
      assert.equal(await search.evaluate((field) => field === document.activeElement), true, `${width}px: the field takes the focus back`);
      await search.fill("sound");
      await playSounds.focus();
      await page.keyboard.press("Shift+Tab");
      await page.keyboard.press("Tab");
      assert.equal(await playSounds.evaluate((control) => control === document.activeElement), true, `${width}px: Tab is back on the result`);
      await page.locator(".settings-help").waitFor();
      await page.keyboard.press("Escape");
      await page.locator(".settings-help").waitFor({ state: "detached" });
      assert.equal(await search.inputValue(), "sound", `${width}px: Escape on a result closes its sentence first and keeps the search`);
      assert.equal(await playSounds.evaluate((control) => control === document.activeElement), true, `${width}px: and leaves the focus on the result`);
      await page.keyboard.press("Escape");
      assert.equal(await search.inputValue(), "", `${width}px: the next Escape empties the search`);
      assert.equal(await search.evaluate((field) => field === document.activeElement), true, `${width}px: and gives the field the focus`);

      await search.fill("menus dialogs");
      await results.getByRole("combobox", { name: "Interface font", exact: true }).selectOption("custom");
      await results.getByRole("textbox", { name: "Custom interface font", exact: true }).waitFor();
      await results.getByRole("combobox", { name: "Interface font", exact: true }).selectOption("default");
      assert.equal(await page.locator(".settings-dialog").count(), 1, `${width}px: and keeps Settings open`);

      if (width === 390) {
        await search.fill("key bar");
        await results.getByRole("button", { name: "Edit key bar", exact: true }).click();
        await page.getByRole("dialog", { name: "Key bar", exact: true }).waitFor();
        await historyHolds(page, "the key bar opened from a search", () => (history.state as { "ovis:settings"?: { page: string | null; keyBar: boolean } } | null)?.["ovis:settings"]?.keyBar === true);
        await page.goBack();
        await dialog.getByRole("tabpanel", { name: "Terminal", exact: true }).waitFor();
        await page.goBack();
        await dialog.getByRole("tablist").waitFor();
        assert.equal(await page.locator(".settings-dialog").count(), 1, "390px: Back from the key bar opened by a search leaves Settings open");
      }

      await search.fill("zzqxv nothing");
      await dialog.getByRole("status").filter({ hasText: "No settings match." }).waitFor();
      assert.deepEqual(await shown(), [], `${width}px: no page is drawn when nothing matches`);

      await search.press("Escape");
      assert.equal(await search.inputValue(), "");
      assert.equal(await results.count(), 0);
      assert.equal(await dialog.getByRole("tablist").isVisible(), true, `${width}px: the list of pages is back`);
      assert.equal(await page.locator(".settings-dialog").count(), 1, `${width}px: Escape on a search does not close Settings`);

      await search.fill("sound");
      await results.getByRole("button", { name: "Open Alerts", exact: true }).click();
      await dialog.getByRole("tabpanel", { name: "Alerts", exact: true }).waitFor();
      assert.equal(await search.count() === 0 || await search.inputValue() === "", true, `${width}px: opening a page ends the search`);
      if (width === 1440) {
        await search.press("Escape");
        await page.locator(".settings-dialog").waitFor({ state: "detached" });
      }
      assert.deepEqual(errors, []);
    } finally {
      await context.close();
    }
  }
  console.log("PASS Settings' search at 1440 and 390px: settings of every page found and changed in place, groups by name, pages opened, nothing matching said, Escape empties first");
}

async function foldedGroups(browser: import("playwright-core").Browser, url: string): Promise<void> {
  for (const width of [1440, 390] as const) {
    const context = await browser.newContext(width === 390 ? { viewport: { width, height: 844 }, isMobile: true, hasTouch: true, locale: "en" } : { viewport: { width, height: 900 }, locale: "en" });
    try {
      await context.addInitScript((settings) => localStorage.setItem("ovis:settings", settings), JSON.stringify({ ...SETTINGS, sidebarPeek: true }));
      const page = await context.newPage();
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(url);
      await page.locator(".conn-live").waitFor({ state: "attached" });
      await openSettings(page);
      const dialog = dialogOf(page);
      await dialog.getByRole("tab", { name: "Appearance", exact: true }).click();
      const panel = dialog.getByRole("tabpanel", { name: "Appearance", exact: true });
      const more = panel.locator("details.settings-fold[data-fold='more']");
      assert.equal(await more.evaluate((fold) => (fold as HTMLDetailsElement).open), false, `${width}px: More settings starts folded`);
      assert.equal(await panel.getByRole("switch", { name: "Show the sidebar on hover", exact: true }).isVisible(), false, `${width}px: its rows are out of the first view`);
      assert.equal(await more.locator(".settings-fold-changed").textContent(), "1 changed", `${width}px: the line counts what this device changed inside`);
      await more.locator("> summary").click();
      await panel.getByRole("switch", { name: "Show the sidebar on hover", exact: true }).waitFor();

      await closeSettings(page);
      await openSettings(page);
      await dialog.getByRole("searchbox", { name: "Search settings", exact: true }).fill("sidebar on hover");
      await dialog.getByRole("region", { name: "Search results", exact: true }).getByRole("switch", { name: "Show the sidebar on hover", exact: true }).waitFor();
      await dialog.getByRole("searchbox", { name: "Search settings", exact: true }).fill("sandbox");
      await dialog.getByRole("region", { name: "Search results", exact: true }).getByLabel("Sandbox and approvals", { exact: true }).waitFor();
      await dialog.getByRole("searchbox", { name: "Search settings", exact: true }).fill("effort");
      const found = dialog.getByRole("region", { name: "Search results", exact: true });
      await found.locator("[data-section='agent-codex']").waitFor();
      assert.deepEqual(await found.locator("[data-section='agent-claude'] > h3, [data-section='agent-codex'] > h3").allTextContents(), ["Claude Code", "Codex"], `${width}px: a found agent's rows sit under its name`);
      await closeSettings(page);

      await page.goto(`${url}?settings=chat&section=chat-more`);
      await page.getByRole("switch", { name: "Collapse work", exact: true }).waitFor();
      assert.equal(await page.locator(".settings-body:not([hidden]) [data-section='conversation']").evaluate((group) => document.activeElement === group), true, `${width}px: chat-more lands on Conversation`);
      await closeSettings(page);

      await page.goto(`${url}?settings=chat&section=composer-more`);
      const queued = page.getByRole("switch", { name: "Send queued messages automatically", exact: true });
      await queued.waitFor();
      assert.equal(await page.locator(".settings-body:not([hidden]) [data-section='composer-more']").evaluate((group) => group.closest("details")?.open === true && document.activeElement === group), true, `${width}px: the link opened the fold and focused its group`);
      assert.deepEqual(errors, []);
    } finally {
      await context.close();
    }
  }
  console.log("PASS folded groups at 1440 and 390px: closed on opening with a count of what changed, opened by a click, a link to a group inside and a search");
}

async function runtimeInUse(browser: import("playwright-core").Browser, url: string): Promise<void> {
  for (const width of [390, 1280]) {
    const context = await browser.newContext({ viewport: { width, height: width === 390 ? 844 : 800 }, isMobile: width === 390, hasTouch: width === 390, locale: "en" });
    try {
      await context.addInitScript((settings) => localStorage.setItem("ovis:settings", settings), JSON.stringify(SETTINGS));
      const page = await context.newPage();
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(`${url}?settings=about`);
      const panel = dialogOf(page).getByRole("tabpanel", { name: "About", exact: true });
      const row = panel.locator(".settings-row").filter({ hasText: "In use" });
      await row.getByText("herdr 0.9.0", { exact: true }).waitFor();
      assert.equal(await row.getByRole("group", { name: "In use" }).count(), 0, `${width}px: one runtime installed, no switch`);
      await page.goto(`${url}?demo_runtime=both&settings=about`);
      const choice = row.getByRole("group", { name: "In use" });
      await choice.getByRole("button", { name: "herdr-core 0.1.17", exact: true }).waitFor();
      assert.equal(await choice.getByRole("button", { name: "herdr 0.9.0", exact: true }).getAttribute("aria-pressed"), "true", `${width}px: the runtime served is the one pressed`);
      await choice.getByRole("button", { name: "herdr-core 0.1.17", exact: true }).click();
      const confirm = page.getByRole("alertdialog", { name: "Show the Herdr app's terminals?" });
      await confirm.waitFor();
      await confirm.getByRole("button", { name: "Cancel", exact: true }).click();
      await confirm.waitFor({ state: "detached" });
      assert.equal(await choice.getByRole("button", { name: "herdr 0.9.0", exact: true }).getAttribute("aria-pressed"), "true", `${width}px: cancelled, nothing switched`);
      assert.deepEqual(errors, []);
    } finally {
      await context.close();
    }
  }
  console.log("PASS About names the runtime in use, and offers the switch only with two installed, asking first");
}

async function installedNotes(browser: import("playwright-core").Browser, url: string): Promise<void> {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: "en" });
  try {
    await context.addInitScript((settings) => localStorage.setItem("ovis:settings", settings), JSON.stringify(SETTINGS));
    await context.addInitScript((revision) => {
      const answers: Record<string, unknown> = {
        "/api/updates": { managed: true, auto_update: false, phase: "idle", current_revision: revision, latest_revision: null, current_version: null, latest_version: null, available: false, checked_at: "2099-01-01T00:00:00Z", blocked_reason: null, error: null },
        "/api/updates/installed": { revision, version: "99.0.0", previous_version: "98.0.0", installed_at: "2099-01-01T00:00:00Z", omitted: 0, releases: [{ version: "99.0.0", date: "2099-01-01", notes: "- A fixture release note." }] },
      };
      let inner = window.fetch;
      const outer: typeof window.fetch = (input, init) => {
        const path = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, location.href).pathname;
        const answer = Object.keys(answers).find((key) => path.endsWith(key));
        return answer !== undefined ? Promise.resolve(new Response(JSON.stringify(answers[answer]), { headers: { "content-type": "application/json" } })) : inner(input, init);
      };
      Object.defineProperty(window, "fetch", { configurable: true, get: () => outer, set: (next: typeof window.fetch) => {
        inner = next;
        Object.defineProperty(window, "fetch", { configurable: true, writable: true, value: outer });
      } });
    }, execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim());
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`${url}?settings=about`);
    const panel = dialogOf(page).getByRole("tabpanel", { name: "About", exact: true });
    await panel.getByRole("region", { name: "What the last update brought", exact: true }).getByText("A fixture release note.").waitFor();
    assert.equal(await panel.getByRole("heading", { name: "Updates", exact: true }).count(), 1, "the Updates section keeps its name");
    await panel.getByText(/^Running v/).waitFor();
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
  console.log("PASS About's compact Updates line keeps what the last update brought, its name and the running version");
}

async function alertChipsReset(browser: import("playwright-core").Browser, url: string): Promise<void> {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: "en" });
  try {
    await context.addInitScript((settings) => {
      localStorage.setItem("ovis:settings", settings);
      localStorage.setItem("ovis:alert-filters", JSON.stringify({ permission: false, error: true, pcsOff: [] }));
    }, JSON.stringify({ ...SETTINGS, alertDone: "always" }));
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`${url}?settings=alerts`);
    const chips = dialogOf(page).getByRole("group", { name: "Alert me when", exact: true });
    const pressed = async () => Object.fromEntries(await Promise.all(["Needs input", "Needs permission", "Long turn finished", "Any turn finished", "Stopped on an error"]
      .map(async (name) => [name, await chips.getByRole("button", { name, exact: true }).getAttribute("aria-pressed")])));
    await chips.waitFor();
    assert.deepEqual(await pressed(), { "Needs input": "true", "Needs permission": "false", "Long turn finished": "true", "Any turn finished": "true", "Stopped on an error": "true" }, "every turn lights the long turns too");
    await dialogOf(page).getByRole("button", { name: "Restore defaults: Alert me when", exact: true }).click();
    await dialogOf(page).getByRole("button", { name: "Restore defaults: Alert me when", exact: true }).waitFor({ state: "detached" });
    assert.deepEqual(await pressed(), { "Needs input": "true", "Needs permission": "true", "Long turn finished": "true", "Any turn finished": "false", "Stopped on an error": "false" }, "↺ puts back all five");
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
  console.log("PASS Alerts' chips: every turn lights the long turns, and ↺ restores all five");
}

/**
 * The sign-in is a fixture in this page's IndexedDB and the account service a route of this
 * context: nothing reaches GitHub or account.ovis.sh.
 */
async function accountPcList(browser: import("playwright-core").Browser, url: string): Promise<void> {
  const service = "https://account.ovis.sh";
  for (const [width, theme] of [[390, "light"], [390, "dark"], [1280, "light"], [1280, "dark"]] as const) {
    const context = await browser.newContext({ viewport: { width, height: width === 390 ? 844 : 800 }, isMobile: width === 390, hasTouch: width === 390, locale: "en" });
    const removed: string[] = [];
    try {
      await context.addInitScript((settings) => localStorage.setItem("ovis:settings", settings), JSON.stringify({ ...SETTINGS, theme }));
      // the PC's server names the account service its page signs in with (server/static.ts)
      await context.route((address) => address.href.startsWith(url) && (address.pathname.endsWith("/") || address.pathname.endsWith("/index.html")), async (route) => {
        const response = await route.fetch();
        await route.fulfill({ response, body: (await response.text()).replace("</head>", `<meta name="ovis-pc-account-service" content="${service}" />\n</head>`) });
      });
      await context.route(`${service}/**`, (route) => {
        const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "authorization, content-type", "access-control-allow-methods": "GET, POST, PUT, DELETE" };
        if (route.request().method() === "OPTIONS") return route.fulfill({ status: 204, headers: cors });
        const path = new URL(route.request().url()).pathname;
        if (route.request().method() === "DELETE" && path.startsWith("/v1/pcs/")) {
          removed.push(path.slice("/v1/pcs/".length));
          return route.fulfill({ status: 204, headers: cors });
        }
        if (path !== "/v1/pcs") return route.fulfill({ status: 404, headers: cors, json: { error: { code: "not_found" } } });
        return route.fulfill({ headers: cors, json: { pcs: [
          { server_id: "a".repeat(32), label: "home-server", added_at: "2026-11-01T00:00:00Z", last_seen_at: new Date().toISOString() },
          { server_id: "b".repeat(32), label: "office-mac", added_at: "2026-10-01T00:00:00Z", last_seen_at: new Date(Date.now() - 9 * 24 * 3_600_000).toISOString() },
        ].filter((pc) => !removed.includes(pc.server_id)) } });
      });
      const page = await context.newPage();
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(url);
      await page.locator(".conn-live").waitFor({ state: "attached" });
      await page.evaluate((service) => new Promise<void>((resolve, reject) => {
        const request = indexedDB.open("ovis-account", 1);
        request.onupgradeneeded = () => { request.result.createObjectStore("account"); };
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const tx = request.result.transaction("account", "readwrite");
          tx.objectStore("account").put({ service, account: "fixture", provider: "github", access_token: "fixture-access", refresh_token: "fixture-refresh", expires_at: Date.now() + 3_600_000 }, "session");
          tx.oncomplete = () => { request.result.close(); resolve(); };
          tx.onabort = () => reject(tx.error);
        };
      }), service);
      await openSettings(page);
      await openSettingsPage(page, "Devices and PCs");
      const list = page.locator("[data-section='devices'] .my-pcs");
      const accountRows = list.locator(".devices-row").filter({ hasText: /home-server|office-mac/ });
      await accountRows.nth(1).waitFor();
      assert.deepEqual(await accountRows.locator(".devices-kind").allTextContents(), ["PC", "PC"], `each account PC is marked PC (${width}px, ${theme})`);
      const style = await list.evaluate((node) => {
        const row = node.querySelector(".devices-row:not([data-testid='this-pc'])")!;
        return { listStyle: getComputedStyle(node).listStyleType, display: getComputedStyle(row).display, border: getComputedStyle(row).borderBottomStyle };
      });
      assert.deepEqual(style, { listStyle: "none", display: "flex", border: "solid" }, `the account's PCs are styled rows in My devices (${width}px, ${theme})`);
      assert.equal(await page.locator("[data-section='account'] .relay-shell-pcs").count(), 0, "the Account group does not list the PCs a second time");
      // no row claims to open its PC: this page cannot tell whether the browser is paired with it at app.ovis.sh.
      assert.equal(await list.getByRole("link", { name: "Open in browser" }).count(), 0, `no account PC row has an Open of its own (${width}px, ${theme})`);
      assert.equal(await list.getByRole("link").count(), 0, `no sentence or link to the hosted app under the account's PCs (${width}px, ${theme})`);
      // the rows only list: an offline PC is removed in Manage account, behind a confirm (below)
      assert.equal(await accountRows.getByRole("button").count(), 0, `no account PC row has a button of its own (${width}px, ${theme})`);
      const fit = await list.locator(".devices-row").filter({ hasText: /home-server|office-mac/ }).evaluateAll((rows) => rows.map((row) => {
        const box = row.getBoundingClientRect();
        const inside = [...row.querySelectorAll(".devices-name, .devices-actions > *, .settings-description, .btn")].every((part) => {
          const one = part.getBoundingClientRect();
          return one.width > 0 && one.left >= box.left - 0.5 && one.right <= box.right + 0.5;
        });
        return { inside, overflow: row.scrollWidth - row.clientWidth, inView: box.right <= document.documentElement.clientWidth + 0.5 };
      }));
      assert.deepEqual(fit, Array.from({ length: 2 }, () => ({ inside: true, overflow: 0, inView: true })), `the account's PC rows fit the list (${width}px, ${theme})`);
      const accountTop = (await page.locator("[data-section='account']").boundingBox())!.y;
      assert.ok(accountTop < (await page.locator("[data-section='devices']").boundingBox())!.y, `the Account group sits above the device list (${width}px, ${theme})`);
      if (process.env.UI_EVIDENCE_DIR) {
        await list.scrollIntoViewIfNeeded();
        await page.screenshot({ path: join(process.env.UI_EVIDENCE_DIR, `account-pcs-${width}-${theme}.png`), animations: "disabled" });
      }
      // Manage account offers Remove only on the PC the account has not heard from: one in use would list itself again
      await page.locator("[data-section='account'] [data-action='manage-account']").click();
      const sheetPcs = page.locator("[data-testid='manage-account'] [data-testid='account-pcs']");
      await sheetPcs.locator("li").filter({ hasText: "home-server" }).waitFor();
      assert.deepEqual(await sheetPcs.locator("[data-action='remove-pc']").evaluateAll((buttons) => buttons.map((button) => button.closest("li")?.getAttribute("data-pc-id"))), ["b".repeat(32)], `Manage account offers Remove only on the PC not heard from (${width}px, ${theme})`);
      const removeOffice = sheetPcs.locator("li").filter({ hasText: "office-mac" }).getByRole("button", { name: "Remove", exact: true });
      await removeOffice.click();
      const confirm = page.getByRole("alertdialog", { name: "Remove office-mac from your account?" });
      await confirm.getByText("Once office-mac is online again it leaves your account too", { exact: false }).waitFor();
      const asked = await confirm.innerText();
      assert.ok(asked.includes("add it on office-mac"), `the removal's confirm says where the PC is added again (${width}px, ${theme})`);
      assert.ok(!asked.includes("revokes nothing"), `the removal's confirm no longer says it revokes nothing on the PC (${width}px, ${theme})`);
      if (process.env.UI_EVIDENCE_DIR) await page.screenshot({ path: join(process.env.UI_EVIDENCE_DIR, `account-pc-remove-${width}-${theme}.png`), animations: "disabled" });
      await confirm.getByRole("button", { name: "Cancel", exact: true }).click();
      await confirm.waitFor({ state: "detached" });
      assert.deepEqual(removed, [], `a cancelled removal removes nothing (${width}px, ${theme})`);
      await removeOffice.click();
      await confirm.getByRole("button", { name: "Remove", exact: true }).click();
      await confirm.waitFor({ state: "detached" });
      await sheetPcs.locator("li").filter({ hasText: "office-mac" }).waitFor({ state: "detached" });
      await sheetPcs.locator("li").filter({ hasText: "home-server" }).waitFor();
      await list.locator(".devices-row").filter({ hasText: "office-mac" }).waitFor({ state: "detached" });
      assert.deepEqual(removed, ["b".repeat(32)], `the removal is the directory's, once (${width}px, ${theme})`);
      assert.equal(await sheetPcs.locator("[data-action='remove-pc']").count(), 0, `the PC in use has no Remove (${width}px, ${theme})`);
      assert.deepEqual(errors, []);
    } finally {
      await context.close();
    }
  }
  console.log("PASS the account's PCs are styled rows of My devices at 390 and 1280px, light and dark: no button on a row; Manage account removes only a PC not heard from, behind a confirm");
}

/**
 * Continue with Google on a PC's own page: the button shows under GitHub's only while the account
 * service lists Google for a PC's page (`GET /v1/providers`), and once signed in the Account group
 * lists the account's ways to sign in, with Remove on every one but the one this page signed in
 * with. The account service is a route of this context: nothing reaches Google, GitHub or account.ovis.sh.
 */
async function accountGoogle(browser: import("playwright-core").Browser, url: string): Promise<void> {
  const service = "https://account.ovis.sh";
  for (const width of [390, 1280] as const) {
    for (const offered of [["github", "google"], ["github"]] as const) {
      for (const signedIn of [false, true]) {
        if (signedIn && offered.length === 1) continue;
        const context = await browser.newContext({ viewport: { width, height: width === 390 ? 844 : 800 }, isMobile: width === 390, hasTouch: width === 390, locale: "en" });
        try {
          await context.addInitScript((settings) => localStorage.setItem("ovis:settings", settings), JSON.stringify({ ...SETTINGS, theme: "light" }));
          await context.route((address) => address.href.startsWith(url) && (address.pathname.endsWith("/") || address.pathname.endsWith("/index.html")), async (route) => {
            const response = await route.fetch();
            await route.fulfill({ response, body: (await response.text()).replace("</head>", `<meta name="ovis-pc-account-service" content="${service}" />\n</head>`) });
          });
          await context.route(`${service}/**`, (route) => {
            const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "authorization, content-type", "access-control-allow-methods": "GET, POST, PUT, DELETE" };
            if (route.request().method() === "OPTIONS") return route.fulfill({ status: 204, headers: cors });
            switch (new URL(route.request().url()).pathname) {
              case "/v1/providers": return route.fulfill({ headers: cors, json: { providers: offered, device: offered } });
              case "/v1/pcs": return route.fulfill({ headers: cors, json: { pcs: [] } });
              case "/v1/identities": return route.fulfill({ headers: cors, json: { identities: [
                { provider: "github", added_at: "2026-11-01T00:00:00Z" },
                { provider: "google", added_at: "2026-11-06T00:00:00Z" },
              ] } });
              default: return route.fulfill({ status: 404, headers: cors, json: { error: { code: "not_found" } } });
            }
          });
          const page = await context.newPage();
          const errors: string[] = [];
          page.on("pageerror", (error) => errors.push(error.message));
          await page.goto(url);
          await page.locator(".conn-live").waitFor({ state: "attached" });
          if (signedIn) {
            await page.evaluate((service) => new Promise<void>((resolve, reject) => {
              const request = indexedDB.open("ovis-account", 1);
              request.onupgradeneeded = () => { request.result.createObjectStore("account"); };
              request.onerror = () => reject(request.error);
              request.onsuccess = () => {
                const tx = request.result.transaction("account", "readwrite");
                tx.objectStore("account").put({ service, account: "fixture", provider: "google", access_token: "fixture-access", refresh_token: "fixture-refresh", expires_at: Date.now() + 3_600_000 }, "session");
                tx.oncomplete = () => { request.result.close(); resolve(); };
                tx.onabort = () => reject(tx.error);
              };
            }), service);
          }
          await openSettings(page);
          await openSettingsPage(page, "Devices and PCs");
          let account = page.locator("[data-section='account']");
          const shot = async (name: string) => {
            if (!process.env.UI_EVIDENCE_DIR) return;
            await account.scrollIntoViewIfNeeded();
            await page.screenshot({ path: join(process.env.UI_EVIDENCE_DIR, `${name}-${width}.png`), animations: "disabled" });
          };
          if (!signedIn) {
            // signed out, the page draws no account card: Add a connection's relay tab is where this page signs in
            const add = page.locator("[data-section='devices']").getByRole("button", { name: "Add a connection", exact: true });
            await add.waitFor();
            assert.equal(await account.count(), 0, `signed out, Devices and PCs has no account card (${width}px)`);
            await add.click();
            const sheet = page.getByRole("dialog", { name: "Add a connection", exact: true });
            await sheet.locator('.connect-tabs [data-tab="relay"]').click();
            account = sheet.getByTestId("connect-signin");
            const buttons = account.locator(".account-provider");
            if (offered.length === 2) {
              await buttons.nth(1).waitFor();
              assert.deepEqual(await buttons.allTextContents(), ["Continue with GitHub", "Continue with Google"], `Google sits under GitHub (${width}px)`);
              assert.equal(await account.locator("[data-provider='google'] svg path").count(), 4, "Google's G keeps its four colours");
              await shot("account-google-signin");
            } else {
              await account.locator(".account-provider").first().waitFor();
              assert.deepEqual(await buttons.allTextContents(), ["Continue with GitHub"], `no Google button while the service offers none (${width}px)`);
            }
          } else {
            assert.equal(await account.evaluate((group) => group.closest("details") === null), true, "the Account group is not folded away");
            // the account is one line: who is signed in, Manage account and Sign out; the rest waits in Manage account's sheet
            const head = account.locator(".account-head");
            await head.getByText("Signed in with Google", { exact: true }).waitFor();
            assert.deepEqual(await head.getByRole("button").allInnerTexts(), ["Manage account", "Sign out"], `the account's line holds Manage account and Sign out (${width}px)`);
            assert.equal(await account.locator(".account-method").count(), 0, `the ways to sign in are not on the page (${width}px)`);
            assert.equal(await account.getByText("Delete account", { exact: true }).count(), 0, `Delete account is not on the page (${width}px)`);
            assert.ok(!(await account.innerText()).includes("acct_"), `the line names no account id (${width}px)`);
            await shot("account-google-line");
            await head.getByRole("button", { name: "Manage account", exact: true }).click();
            const sheet = page.getByTestId("manage-account");
            const methods = sheet.locator(".account-method");
            await methods.nth(1).waitFor();
            assert.deepEqual(await methods.evaluateAll((rows) => rows.map((row) => [row.getAttribute("data-provider"), row.querySelector("button") !== null])), [["github", true], ["google", false]],
              "every way to sign in can be removed but the one this page signed in with");
            const deleteAt = sheet.locator(".account-delete");
            assert.equal(await deleteAt.locator("summary").textContent(), "Delete account", `Delete account sits at the foot of Manage account (${width}px)`);
            assert.ok(await deleteAt.evaluate((node) => [...node.closest("[data-testid='manage-account']")!.querySelectorAll(".account-methods")].every((part) => part.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING)),
              `Delete account comes after the ways to sign in (${width}px)`);
            if (process.env.UI_EVIDENCE_DIR) await page.screenshot({ path: join(process.env.UI_EVIDENCE_DIR, `account-google-methods-${width}.png`), animations: "disabled" });
            await page.keyboard.press("Escape");
            await sheet.waitFor({ state: "detached" });
            if (width === 1280) {
              // a search finds settings rows only: the account's own rows answer it
              const search = dialogOf(page).getByRole("searchbox", { name: "Search settings", exact: true });
              const found = (label: string) => page.getByRole("region", { name: "Search results", exact: true }).locator("[data-section='account'] .settings-row .settings-label", { hasText: label });
              await search.fill("Delete account");
              await found("Delete account").waitFor();
              await search.fill("Sign out");
              await found("Signed in with Google").waitFor();
            }
          }
          assert.deepEqual(errors, []);
        } finally {
          await context.close();
        }
      }
    }
  }
  console.log("PASS Continue with Google shows under GitHub only while the service offers it, and the account lists its ways to sign in, at 390 and 1280px");
}

async function rowResets(browser: import("playwright-core").Browser, url: string): Promise<void> {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "en" });
  try {
    await context.addInitScript((settings) => { if (localStorage.getItem("ovis:settings") === null) localStorage.setItem("ovis:settings", settings); }, JSON.stringify(SETTINGS));
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const saved = () => page.evaluate(() => JSON.parse(localStorage.getItem("ovis:settings")!) as Record<string, unknown>);
    const reset = (row: string) => page.getByRole("button", { name: `Restore defaults: ${row}`, exact: true });
    await page.goto(`${url}?settings=appearance`);
    await page.locator(".conn-live").waitFor({ state: "attached" });
    await page.locator(".theme-cards:has([data-theme-card])").waitFor();
    const mode = page.getByRole("group", { name: "Theme", exact: true });
    await mode.getByRole("button", { name: "Light", exact: true }).click();
    await page.getByRole("radiogroup", { name: "Light theme", exact: true }).waitFor();
    await mode.getByRole("button", { name: "Dark", exact: true }).click();
    await page.getByRole("radiogroup", { name: "Dark theme", exact: true }).waitFor();

    assert.equal(await reset("Terminal font").count(), 0, "no ↺ while the terminal font and size are the defaults");
    await page.getByRole("button", { name: "Increase terminal font size", exact: true }).click();
    await reset("Terminal font").waitFor();
    assert.equal((await saved())["terminalFontSize"], DEFAULT_SETTINGS.terminalFontSize + 1);
    await reset("Terminal font").focus();
    await page.keyboard.press("Enter");
    await reset("Terminal font").waitFor({ state: "detached" });
    assert.equal(await page.evaluate(() => document.activeElement?.closest(".settings-row")?.querySelector(".settings-label")?.textContent), "Terminal font", "the row keeps the focus once its ↺ goes");
    const fonts = await saved();
    assert.deepEqual([fonts["terminalFontSize"], fonts["terminalFontFamily"] ?? DEFAULT_SETTINGS.terminalFontFamily], [DEFAULT_SETTINGS.terminalFontSize, DEFAULT_SETTINGS.terminalFontFamily], "↺ puts back the size and the font of its row");

    const uiFont = page.getByLabel("Interface font", { exact: true });
    await uiFont.selectOption("custom");
    const custom = page.getByRole("textbox", { name: "Custom interface font", exact: true });
    await custom.fill('"Noto Sans JP"');
    await custom.press("Enter");
    await reset("Interface font").click();
    await custom.waitFor({ state: "detached" });
    assert.equal(await uiFont.inputValue(), "default", "the select shows Default once the font is put back");
    await page.goto(`${url}?settings=appearance`);
    await page.locator(".theme-cards:has([data-theme-card])").waitFor();
    assert.equal(await page.getByLabel("Interface font", { exact: true }).inputValue(), "default", "the font put back stays put back after a reload");

    const dark = themeSide(page, "dark");
    await dark.selectOption("dracula");
    await page.waitForFunction(() => document.documentElement.dataset.palette === "dracula");
    await reset("Dark theme").click();
    await page.waitForFunction((id) => document.documentElement.dataset.palette === id, DEFAULT_SETTINGS.darkTheme);
    assert.deepEqual([(await saved())["darkTheme"], (await saved())["palette"]], [DEFAULT_SETTINGS.darkTheme, DEFAULT_SETTINGS.darkTheme], "↺ puts back the dark theme and the palette it draws");
    assert.equal(await reset("Dark theme").count(), 0, "↺ goes once the theme is back");

    const cards = page.getByRole("radiogroup", { name: "Dark theme", exact: true });
    const listed = await dark.listed();
    await cards.locator('[role="radio"][aria-checked="true"]').focus();
    await page.keyboard.press("ArrowRight");
    const next = listed[listed.indexOf(DEFAULT_SETTINGS.darkTheme) + 1]!;
    await page.waitForFunction((id) => document.documentElement.dataset.palette === id, next);
    assert.equal(await cards.locator('[role="radio"][aria-checked="true"]').getAttribute("data-theme-card"), next, "ArrowRight picks the next card");
    assert.equal(await page.evaluate(() => (document.activeElement as HTMLElement | null)?.dataset["themeCard"]), next, "the picked card takes the focus");
    await page.keyboard.press("Home");
    await page.waitForFunction((id) => document.documentElement.dataset.palette === id, listed[0]!);

    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
  console.log("PASS Appearance: ↺ shows only off the default and puts back its row's keys; theme cards pick by arrow and follow the Theme mode");
}

async function rowSentences(browser: import("playwright-core").Browser, url: string): Promise<void> {
  type Page = import("playwright-core").Page;
  interface Box { left: number; top: number; right: number; bottom: number }
  const over = (a: Box, b: Box): boolean => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
  const drawn = (page: Page) => page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
  const rowOf = (page: Page, name: string) => page.locator(".settings-body:not([hidden]) .settings-row").filter({ has: page.getByText(name, { exact: true }) }).first();
  const describes = (control: import("playwright-core").Locator) => control.evaluate((node) => document.getElementById(node.getAttribute("aria-describedby") ?? "")?.textContent ?? null);
  const appearance = async (page: Page, query = ""): Promise<void> => {
    await page.goto(`${url}?settings=appearance${query}`);
    await page.locator(".conn-live").waitFor({ state: "attached" });
    await page.locator(".theme-cards:has([data-theme-card])").waitFor();
  };

  const desktop = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "en" });
  try {
    await desktop.addInitScript((settings) => { if (localStorage.getItem("ovis:settings") === null) localStorage.setItem("ovis:settings", settings); }, JSON.stringify(SETTINGS));
    const page = await desktop.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await appearance(page);
    const sentence = page.locator(".settings-help");
    const density = rowOf(page, "Density");
    const control = page.getByRole("group", { name: "Density", exact: true });
    const text = await describes(control);
    assert.ok(text !== null && text.trim() !== "", "Density's control is described by its row's sentence");
    assert.equal(await sentence.count(), 0, "no sentence over the page until something asks for one");

    await density.locator(".settings-label").hover();
    await sentence.waitFor();
    assert.equal(await sentence.textContent(), text, "the sentence over the page is the one that describes the control");
    const boxes = await density.evaluate((row) => {
      const box = (node: Element) => { const rect = node.getBoundingClientRect(); return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom }; };
      const below = row.closest(".settings-section")?.nextElementSibling?.querySelector(".settings-row") ?? row.nextElementSibling;
      return { sentence: box(document.querySelector(".settings-help")!), row: box(row), control: box(row.querySelector(".settings-segmented")!), below: below ? box(below) : null };
    });
    assert.ok(boxes.sentence.top < boxes.row.top, "the sentence is above its row");
    assert.equal(over(boxes.sentence, boxes.control), false, "off the row's own control");
    assert.ok(boxes.below !== null && !over(boxes.sentence, boxes.below), "and off the row below");
    await page.mouse.move(boxes.sentence.left + 10, (boxes.sentence.top + boxes.sentence.bottom) / 2, { steps: 4 });
    await drawn(page);
    assert.equal(await sentence.count(), 1, "the pointer on the sentence keeps it");
    await page.keyboard.press("Escape");
    await sentence.waitFor({ state: "detached" });
    assert.equal(await page.locator(".settings-dialog").count(), 1, "Escape closed the sentence, not Settings");
    await page.mouse.move(2, 2);

    const withSentence = await page.evaluate(() => [...document.querySelectorAll<HTMLElement>(".settings-body:not([hidden]) .settings-row")]
      .filter((row) => row.checkVisibility() && row.querySelector(":scope > .settings-row-text > .visually-hidden[id]") !== null)
      .map((row) => row.querySelector(".settings-label")?.textContent ?? ""));
    let covered: { row: string; x: number; y: number; beside: number } | null = null;
    for (const name of ["Density", ...withSentence.filter((other) => other !== "Density")]) {
      await rowOf(page, name).locator(".settings-label").first().hover();
      await sentence.waitFor();
      covered = await page.evaluate((name) => {
        const tip = document.querySelector(".settings-help")!.getBoundingClientRect();
        const rows = [...document.querySelectorAll<HTMLElement>(".settings-body:not([hidden]) .settings-row")];
        for (const row of rows.filter((other) => other.querySelector(".settings-label")?.textContent !== name)) {
          for (const control of [...row.children].filter((child) => !child.classList.contains("settings-row-text"))) {
            const box = control.getBoundingClientRect();
            const [left, right, top, bottom] = [Math.max(box.left, tip.left), Math.min(box.right, tip.right), Math.max(box.top, tip.top), Math.min(box.bottom, tip.bottom)];
            const beside = box.top - tip.top > 6 ? (tip.top + box.top) / 2 : tip.bottom - box.bottom > 6 ? (box.bottom + tip.bottom) / 2 : null;
            if (box.height > 0 && right - left > 4 && bottom - top > 4 && beside !== null) return { row: row.querySelector(".settings-label")?.textContent ?? "", x: (left + right) / 2, y: (top + bottom) / 2, beside };
          }
        }
        return null;
      }, name);
      if (covered !== null) break;
      await page.mouse.move(2, 2);
      await sentence.waitFor({ state: "detached" });
    }
    assert.ok(covered !== null, "some row's sentence lies on the control of another row at this width");
    const lying = await sentence.textContent();
    await page.mouse.move(covered.x, covered.beside, { steps: 4 });
    await drawn(page);
    assert.equal(await sentence.textContent(), lying, "above or below the control it lies on, the sentence keeps the pointer");
    assert.equal(await page.evaluate(({ x, beside }) => document.elementFromPoint(x, beside)?.closest(".settings-help") != null, covered), true, "and is what a press there lands on, so its words can be selected");
    await page.mouse.move(covered.x, covered.y, { steps: 4 });
    await page.waitForFunction((was) => document.querySelector(".settings-help")?.textContent !== was, lying);
    assert.equal(await page.evaluate(({ x, y }) => {
      const under = document.elementFromPoint(x, y);
      return under?.closest(".settings-help") ? "the sentence" : (under?.closest(".settings-row")?.querySelector(".settings-label")?.textContent ?? null);
    }, covered), covered.row, "a press on the part that lay on another row's control reaches that control");
    await page.mouse.move(2, 2);
    await sentence.waitFor({ state: "detached" });
    const lyingRow = (await page.evaluate((was) => [...document.querySelectorAll<HTMLElement>(".settings-body:not([hidden]) .settings-row")]
      .find((row) => row.querySelector(":scope > .settings-row-text > .visually-hidden[id]")?.textContent === was)?.querySelector(".settings-label")?.textContent ?? null, lying))!;
    await rowOf(page, lyingRow).locator("button, input, select").first().focus();
    await page.keyboard.press("Shift+Tab");
    await page.keyboard.press("Tab");
    await page.waitForFunction((was) => document.querySelector(".settings-help")?.textContent === was, lying);
    assert.equal(await page.evaluate(({ x, y }) => {
      const under = document.elementFromPoint(x, y);
      return under?.closest(".settings-help") ? "the sentence" : (under?.closest(".settings-row")?.querySelector(".settings-label")?.textContent ?? null);
    }, covered), covered.row, "under the keyboard's sentence too, a press on the covered part lands on the control");
    await page.keyboard.press("Escape");
    await sentence.waitFor({ state: "detached" });
    const lyingName = rowOf(page, lyingRow).locator(".settings-label").first();
    await lyingName.hover();
    await page.waitForFunction((was) => document.querySelector(".settings-help")?.textContent === was, lying);
    const natural = await sentence.evaluate((tip: HTMLElement) => tip.offsetHeight);
    await page.mouse.move(2, 2);
    await sentence.waitFor({ state: "detached" });
    const cut = await page.addStyleTag({ content: `.settings-help { max-height: ${natural - 14}px !important; }` });
    await lyingName.hover();
    await page.waitForFunction((was) => document.querySelector(".settings-help")?.textContent === was, lying);
    await page.locator(".settings-help-copy").waitFor();
    const tall = await sentence.evaluate((tip: HTMLElement, { x, beside }) => {
      const box = tip.getBoundingClientRect();
      const on = ([[box.left + 10, (box.top + box.bottom) / 2], [x, beside]] as const).find(([px, py]) => document.elementFromPoint(px, py)?.closest(".settings-help") === tip);
      return { on: on ?? null, scrolls: tip.scrollHeight > tip.clientHeight };
    }, covered);
    assert.ok(tall.scrolls, "a sentence with less room than its words need scrolls");
    assert.ok(tall.on !== null, "and has a part that lies on no control, where the pointer is its own");
    await page.mouse.move(tall.on[0], tall.on[1], { steps: 4 });
    await page.mouse.wheel(0, 40);
    await page.waitForFunction(() => {
      const tip = document.querySelector(".settings-help");
      const copy = document.querySelector(".settings-help-copy");
      return tip !== null && copy !== null && tip.scrollTop > 0 && copy.scrollTop === tip.scrollTop;
    });
    assert.equal(await sentence.textContent(), lying, "the wheel over it scrolls it and keeps it, and the copy under it follows");
    await cut.evaluate((node) => node.remove());
    await page.mouse.move(2, 2);
    await sentence.waitFor({ state: "detached" });

    // a search hides a row while its sentence shows: the row is removed under a still pointer, which sends no
    // leave, and the sentence does not come back with the row once the pointer is elsewhere
    const search = page.getByRole("searchbox", { name: "Search settings", exact: true });
    await search.fill("densit");
    await control.waitFor();
    await page.locator(".settings-row").filter({ has: page.getByText("Density", { exact: true }) }).first().locator(".settings-label").hover();
    await sentence.waitFor();
    await search.focus();
    await page.keyboard.press("End");
    await page.keyboard.type("zzzz");
    await page.getByRole("status").filter({ hasText: "No settings match." }).waitFor();
    await page.mouse.move(2, 2);
    for (let erased = 0; erased < 4; erased += 1) await page.keyboard.press("Backspace");
    await control.waitFor();
    await page.keyboard.press("Backspace");
    await control.waitFor();
    await drawn(page);
    assert.equal(await sentence.count(), 0, "a row the search hid comes back without its sentence");
    await appearance(page);

    await control.getByRole("button", { name: "Comfortable", exact: true }).focus();
    await page.keyboard.press("Shift+Tab");
    await page.keyboard.press("Tab");
    await sentence.waitFor();
    assert.equal(await sentence.textContent(), text, "the keyboard on the control shows the same sentence");
    await page.keyboard.press("Tab");
    await page.keyboard.press("Tab");
    const focusedRow = () => page.evaluate(() => document.activeElement?.closest(".settings-row")?.querySelector(".settings-label")?.textContent ?? null);
    const next = await page.evaluate(() => {
      const row = document.activeElement?.closest(".settings-row");
      return { name: row?.querySelector(".settings-label")?.textContent ?? null, text: row?.querySelector(":scope > .settings-row-text > .visually-hidden[id]")?.textContent ?? null };
    });
    assert.ok(next.name !== null && next.name !== "Density", "Tab left Density for the row after it");
    assert.ok(next.text !== null && next.text !== text, "the row after Density has a sentence of its own");
    await page.waitForFunction((want) => document.querySelector(".settings-help")?.textContent === want, next.text);
    await page.keyboard.press("Escape");
    await sentence.waitFor({ state: "detached" });
    assert.equal(await page.locator(".settings-dialog").count(), 1, "Escape closed the sentence, not Settings");
    assert.equal(await focusedRow(), next.name, "and left the focus where it was");
    await page.keyboard.press("Escape");
    await page.locator(".settings-dialog").waitFor({ state: "detached" });

    await appearance(page);
    await control.getByRole("button", { name: "Comfortable", exact: true }).focus();
    await page.keyboard.press("Shift+Tab");
    await page.keyboard.press("Tab");
    await sentence.waitFor();
    await page.keyboard.press("Space");
    await sentence.waitFor({ state: "detached" });
    assert.equal(await focusedRow(), "Density", "the focus stays on the choice that was pressed");
    await page.keyboard.press("Escape");
    await page.locator(".settings-dialog").waitFor({ state: "detached" });

    await appearance(page);
    const size = page.getByRole("textbox", { name: "Terminal font size", exact: true });
    await size.focus();
    await page.keyboard.press("Shift+Tab");
    await page.keyboard.press("Tab");
    await sentence.waitFor();
    await size.fill(String(DEFAULT_SETTINGS.terminalFontSize + 2));
    await sentence.waitFor({ state: "detached" });
    await page.keyboard.press("Escape");
    assert.equal(await size.inputValue(), String(DEFAULT_SETTINGS.terminalFontSize), "Escape still takes a typed size back");
    assert.equal(await page.locator(".settings-dialog").count(), 1);
    await appearance(page);
    await size.click();
    assert.equal(await size.evaluate((field) => field === document.activeElement), true);
    assert.equal(await sentence.count(), 0, "a click into a field shows no sentence");

    // a pen that cannot hover has only its tap: on the name it opens the sentence in the row, as a finger's does.
    // The events such a pen sends, dispatched: the browser's own pen input gives a page no click here
    await appearance(page);
    await density.locator(".settings-label").evaluate((name) => {
      const pen = { bubbles: true, cancelable: true, pointerType: "pen", pointerId: 7, isPrimary: true };
      for (const type of ["pointerover", "pointerdown", "pointerup", "click", "pointerout"]) name.dispatchEvent(new PointerEvent(type, pen));
    });
    await density.locator(":scope > .settings-row-sentence").waitFor();
    assert.equal(await sentence.count(), 0, "a pen's tap draws nothing over the page");

    await appearance(page);
    await page.evaluate(() => { for (const fold of document.querySelectorAll<HTMLDetailsElement>(".settings-body:not([hidden]) details")) fold.open = true; });
    const far = page.getByRole("group", { name: "Status indicators", exact: true }).getByRole("button", { name: "Classic", exact: true });
    const farText = await describes(page.getByRole("group", { name: "Status indicators", exact: true }));
    assert.ok(farText !== null && farText.trim() !== "");
    const outOfView = () => far.evaluate((control) => { const page = control.closest(".modal-body")!.getBoundingClientRect(); const row = control.closest(".settings-row")!.getBoundingClientRect(); return row.bottom <= page.top || row.top >= page.bottom; });
    const drawnSentence = () => page.evaluate(() => { const tip = document.querySelector<HTMLElement>(".settings-help"); return tip === null ? null : tip.style.visibility === "hidden" ? "waiting" : tip.textContent; });
    await page.getByRole("group", { name: "Agent logos", exact: true }).getByRole("button", { name: "Mono", exact: true }).evaluate((control: HTMLElement) => control.focus({ preventScroll: true }));
    await page.keyboard.press("Tab");
    assert.equal(await far.evaluate((control) => control === document.activeElement), true, "Tab reached Status indicators");
    assert.equal(await outOfView(), true, "the focused setting is below what the page shows");
    assert.equal(await drawnSentence(), "waiting", "no sentence is drawn for a setting the page is not scrolled to");
    await far.evaluate((control) => control.scrollIntoView({ block: "nearest" }));
    await page.waitForFunction((want) => { const tip = document.querySelector<HTMLElement>(".settings-help"); return tip !== null && tip.style.visibility !== "hidden" && tip.textContent === want; }, farText);
    await far.evaluate((control) => { control.closest(".modal-body")!.scrollTop = 0; });
    await page.waitForFunction(() => (document.querySelector<HTMLElement>(".settings-help")?.style.visibility ?? "") === "hidden");
    await page.keyboard.press("Escape");
    await page.locator(".settings-dialog").waitFor({ state: "detached" });

    await page.goto(`${url}?settings=terminal`);
    await page.locator(".settings-dialog").waitFor();
    const sentenceOf = (name: string) => rowOf(page, name).locator(":scope > .settings-row-text > .visually-hidden[id]").textContent();
    const keyBarText = await sentenceOf("Key bar");
    assert.ok(keyBarText !== null && keyBarText.trim() !== "");
    assert.equal(await describes(page.getByRole("button", { name: "Edit key bar", exact: true })), keyBarText, "Edit key bar is described by its row's sentence");
    await appearance(page);
    assert.equal(await describes(page.getByRole("textbox", { name: "Terminal font", exact: true })), await sentenceOf("Terminal font"), "the font field is described by its row's sentence");

    // a stepper's button at its end keeps the keyboard's focus: it says it goes no further (aria-disabled) and reads as
    // a disabled one, where a disabled button would drop the focus out of Settings to the page; a press there does nothing
    const typedSize = page.getByRole("textbox", { name: "Terminal font size", exact: true });
    const larger = page.getByRole("button", { name: "Increase terminal font size", exact: true });
    const smaller = page.getByRole("button", { name: "Decrease terminal font size", exact: true });
    for (const [button, other, end] of [[larger, smaller, TERMINAL_FONT_MAX], [smaller, larger, TERMINAL_FONT_MIN]] as const) {
      const name = await button.getAttribute("aria-label");
      await button.focus();
      for (let press = Math.abs(end - Number(await typedSize.inputValue())); press > 0; press -= 1) await page.keyboard.press("Enter");
      await page.waitForFunction((want) => document.querySelector<HTMLInputElement>('input[aria-label="Terminal font size"]')?.value === want, String(end));
      const holder = () => page.evaluate(() => document.activeElement?.getAttribute("aria-label") ?? document.activeElement?.tagName ?? null);
      assert.equal(await holder(), name, `${name} keeps the focus at ${end}px`);
      assert.equal(await button.getAttribute("aria-disabled"), "true", `${name} says it goes no further at ${end}px`);
      assert.equal(await other.getAttribute("aria-disabled"), null, "the other way is still open");
      const disabledOpacity = await button.evaluate((node) => {
        const twin = node.cloneNode(true) as HTMLButtonElement;
        twin.removeAttribute("aria-disabled");
        twin.disabled = true;
        node.after(twin);
        const opacity = getComputedStyle(twin).opacity;
        twin.remove();
        return opacity;
      });
      assert.notEqual(disabledOpacity, "1", "a disabled icon button is faded");
      assert.equal(await button.evaluate((node) => getComputedStyle(node).opacity), disabledOpacity, "it reads as a disabled icon button does");
      await page.keyboard.press("Enter");
      // (Playwright waits for an aria-disabled button to be enabled: the click is forced, as a person's is)
      await button.click({ force: true });
      assert.equal(await typedSize.inputValue(), String(end), `a press of ${name} at its end changes nothing`);
      assert.equal(await holder(), name, "and keeps the focus");
      await button.hover();
      assert.equal(await button.evaluate((node) => getComputedStyle(node).backgroundColor), "rgba(0, 0, 0, 0)", "and gets no hover plate");
      const look = () => button.evaluate(async (node) => {
        await Promise.all(node.getAnimations().map((animation) => animation.finished));
        const style = getComputedStyle(node);
        return [style.backgroundColor, style.borderColor, style.color].join(" / ");
      });
      const resting = await look();
      await page.mouse.down();
      const held = await look();
      await page.mouse.up();
      assert.equal(held, resting, `holding ${name} down at its end shows no press`);
    }

    await appearance(page, "&demo_devices=watch");
    await rowOf(page, "Density").locator(".settings-label").hover();
    await sentence.waitFor();
    assert.equal(await sentence.textContent(), text, "a watching device reads the same sentence");
    assert.deepEqual(errors, []);
  } finally {
    await desktop.close();
  }

  const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true, locale: "en" });
  try {
    await phone.addInitScript((settings) => { if (localStorage.getItem("ovis:settings") === null) localStorage.setItem("ovis:settings", settings); }, JSON.stringify(SETTINGS));
    const page = await phone.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await appearance(page);
    const density = rowOf(page, "Density");
    const text = await describes(page.getByRole("group", { name: "Density", exact: true }));
    const opened = density.locator(".settings-row-sentence");
    await density.locator(".settings-label").tap();
    await opened.waitFor();
    assert.equal(await opened.textContent(), text, "a tap on the row's name opens its sentence in the row");
    assert.equal(await page.locator(".settings-help").count(), 0, "nothing is drawn over a phone's page");
    const placed = await density.evaluate((row) => {
      const line = row.querySelector(".settings-row-sentence")!.getBoundingClientRect();
      const control = row.querySelector(".settings-segmented")!.getBoundingClientRect();
      const box = row.getBoundingClientRect();
      return { underControl: line.top >= control.bottom, inRow: line.left >= box.left && line.right <= box.right + 0.5 };
    });
    assert.deepEqual(placed, { underControl: true, inRow: true }, "under the name and the control, inside the row");
    await density.getByRole("button", { name: "Compact", exact: true }).tap();
    await page.waitForFunction(() => document.documentElement.dataset["density"] === "compact");
    assert.equal(await opened.count(), 1, "a tap on the control is the control's: the sentence stays as it was");
    await density.locator(".settings-label").tap();
    await opened.waitFor({ state: "detached" });
    const font = rowOf(page, "Terminal font");
    await font.locator(".settings-label").tap();
    await font.locator(":scope > .settings-row-sentence").waitFor();
    assert.deepEqual(await font.evaluate((row) => {
      const line = row.querySelector(":scope > .settings-row-sentence")!.getBoundingClientRect();
      const card = row.closest(".settings-card")!.getBoundingClientRect();
      const body = row.closest(".settings-body")!;
      return { inCard: line.left >= card.left && line.right <= card.right + 0.5, sideways: body.scrollWidth > body.clientWidth + 1 };
    }), { inCard: true, sideways: false }, "a stacked row's sentence stays in its card");
    await font.locator(".settings-label").tap();
    await font.locator(":scope > .settings-row-sentence").waitFor({ state: "detached" });
    await page.getByRole("textbox", { name: "Terminal font size", exact: true }).tap();
    await page.waitForFunction(() => document.activeElement?.getAttribute("aria-label") === "Terminal font size");
    assert.equal(await page.locator(".settings-help").count(), 0, "a tap into a field draws no sentence over the page");
    await appearance(page);
    await density.locator(".settings-label").tap();
    await opened.waitFor();
    await page.keyboard.press("Escape");
    await opened.waitFor({ state: "detached" });
    assert.equal(await page.locator(".settings-dialog").count(), 1, "Escape closed the sentence a tap opened, not Settings");
    await page.keyboard.press("Escape");
    await page.locator(".settings-dialog").waitFor({ state: "detached" });
    assert.deepEqual(errors, []);
  } finally {
    await phone.close();
  }
  console.log("PASS a row's sentence: over the page on a resting mouse and on keyboard focus, off its control and the row below, closed alone by Escape and by a press on its control, gone when the pointer comes onto another row's control under it or a search hides its row, scrolled by the wheel where it has less room than its words need, none for a click or a tap into a field, waiting for a row out of view, describing a row's button and field, opened in the row by a finger's or a pen's tap, inside the card and closed by Escape, and the same on a watching device");
}

async function mergedRows(browser: import("playwright-core").Browser, url: string): Promise<void> {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "en" });
  try {
    await context.addInitScript((settings) => { if (localStorage.getItem("ovis:settings") === null) localStorage.setItem("ovis:settings", settings); }, JSON.stringify({ ...SETTINGS, voiceInput: "on", voiceEngine: "auto" }));
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const pick = async (pageName: string, group: string, option: string) => {
      await page.goto(`${url}?settings=${pageName}`);
      await page.locator(".conn-live").waitFor({ state: "attached" });
      await openSettingsFolds(page);
      await page.getByRole("group", { name: group, exact: true }).getByRole("button", { name: option, exact: true }).click();
    };
    const pressed = async (pageName: string, group: string) => {
      await page.goto(`${url}?settings=${pageName}`);
      await page.locator(".conn-live").waitFor({ state: "attached" });
      await openSettingsFolds(page);
      return page.getByRole("group", { name: group, exact: true }).locator("button[aria-pressed='true']").textContent();
    };
    await pick("appearance", "Agents order", "By state");
    await page.getByRole("group", { name: "Within a state", exact: true }).waitFor();
    assert.equal(await pressed("appearance", "Agents order"), "By state");
    await pick("appearance", "Agents order", "Activity");
    assert.equal(await page.getByRole("group", { name: "Within a state", exact: true }).count(), 0, "Within a state goes with By state");
    assert.equal(await pressed("appearance", "Agents order"), "Activity");
    await pick("chat", "Show thinking", "Expanded");
    assert.equal(await pressed("chat", "Show thinking"), "Expanded");
    await pick("chat", "Show thinking", "Hidden");
    assert.equal(await pressed("chat", "Show thinking"), "Hidden");
    await pick("chat", "Tidy dictated text", "Terminal");
    assert.equal(await pressed("chat", "Tidy dictated text"), "Terminal");
    assert.deepEqual(await page.evaluate(() => { const saved = JSON.parse(localStorage.getItem("ovis:settings")!); return [saved.voicePolishChat, saved.voicePolishTerminal]; }), [false, true]);
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
  console.log("PASS the merged rows (Agents order, Show thinking, Tidy dictated text) keep both settings each stands for, through a reload");
}

try {
  await buildDemoApp(app);
  await buildDevelopmentDemoApp(devApp);
  writeFileSync(join(devApp, "hold-voice.js"), HOLD_VOICE);
  for (const [dir, extra] of [[app, ""], [devApp, `<script src="./hold-voice.js"></script>`]] as const) {
    const index = join(dir, "index.html");
    writeFileSync(index, readFileSync(index, "utf8").replace(/<script type="module"/, () => `<script src="./demo-transport.js"></script>${extra}${DEMO_FILE_PREVIEW_SCRIPT}\n    <script type="module"`));
  }
  const roots = { "/herdr-web-ui/demo/app/": app, "/herdr-web-ui/demo/dev/": devApp };
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const path = new URL(request.url).pathname;
    const [prefix, root] = Object.entries(roots).find(([prefix]) => path.startsWith(prefix)) ?? [];
    if (prefix === undefined || root === undefined) return new Response("not found", { status: 404 });
    let file: string;
    try { file = decodeURIComponent(path.slice(prefix.length)); }
    catch { return new Response("bad path", { status: 400 }); }
    if (!file || file.endsWith("/")) file += "index.html";
    if (file.split("/").includes("..") || file.includes("\\")) return new Response("bad path", { status: 400 });
    const body = Bun.file(join(root, file));
    return await body.exists() ? new Response(body) : new Response("not found", { status: 404 });
  } });
  const url = `http://127.0.0.1:${server.port}/herdr-web-ui/demo/app/`;
  const devUrl = `http://127.0.0.1:${server.port}/herdr-web-ui/demo/dev/`;
  try {
    checkChromeTmpdir();
    const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? chromium.executablePath(), headless: true, args: ["--no-sandbox"] });
    try {
      await dialogSearch(browser, url);
      await foldedGroups(browser, url);
      await mergedRows(browser, url);
      await rowSentences(browser, url);
      await rowResets(browser, url);
      await accountPcList(browser, url);
      await accountGoogle(browser, url);
      await runtimeInUse(browser, url);
      await alertChipsReset(browser, url);
      await installedNotes(browser, url);
      await focusAndLandings(browser, url);
      await heldGroupLanding(browser, devUrl);
    } finally {
      await browser.close();
      console.log("CLEANUP browser closed");
    }
  } finally {
    server.stop(true);
    console.log("CLEANUP loopback demo server stopped");
  }
} finally {
  rmSync(app, { recursive: true, force: true });
  rmSync(devApp, { recursive: true, force: true });
  console.log("CLEANUP disposable demo apps removed");
}
